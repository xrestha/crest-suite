-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S818, POS stage 4, slice 4j: an online booking request nobody answered no longer blocks the
-- guest's phone number for good.
--
--   RESERVATIONS-9 (P3). A public request lands as 'requested' and waits for a staff Accept, and
--   pos_reservations_one_request_per_phone (client_id, phone_canonical) WHERE status = 'requested'
--   has no time bound. So a request the outlet never answered kept that number blocked after its
--   time had passed: every later request from it was refused 'pending' ("You already have a booking
--   request waiting…"), with no way for the guest to withdraw the old one, until staff happened to
--   decline a request for a day long gone.
--     * submit_reservation_request, just before its INSERT, answers this phone's own requests whose
--       time has passed: status 'cancelled', cancelled_at now(), cancel_reason 'Not answered in time'
--       (the reason the staff page can also pick, and the guest's page shows; reservationStatus.js'
--       EXPIRED_REQUEST_REASON, held to this file by reservationStatus.test.js). Nothing else in the
--       function changes: every refusal, limit and its order are as S809 1h left them.
--     * Only this phone's, and only once the time asked for has gone: a request still to come keeps
--       blocking a second one, as before. Other numbers' stale requests stay for staff to decline
--       (the Reservations page now marks them "time passed").
--   The app half (same release): the guest's status card says "Not answered in time" for a request
--   still unanswered once its time has passed, instead of "will confirm shortly".
--
-- Built on the body 20261009140000 (S809 1h) wrote, md5(prosrc) 4302cf649528620768ae3849ac6d51a6. Section 0 refuses to
-- run over any other body. Signature, defaults, RETURNS jsonb, SECURITY DEFINER and search_path are
-- unchanged, so CREATE OR REPLACE keeps its grants (PUBLIC, anon, authenticated, service_role, as
-- S809 asserted); the probe asserts them again. The UPDATE runs as the function's owner, so no
-- client-session guard applies; pos_reservations_touch stamps updated_at, so the expiry shows on the
-- Activity view; the table-hold guard does not fire (a cancel is neither a window move nor a revival).
--
-- No till calls this function, and no page sends anything new: the till build floor is unchanged.
--
-- To undo: re-run section 1's CREATE OR REPLACE from 20261009140000 (md5 4302cf649528620768ae3849ac6d51a6).
--
-- The probe at the end calls the function as the anon role, as the public booking page does, inside
-- a block that rolls itself back. If any check fails, nothing lands. The final SELECT prints the live
-- counts this slice's app changes act on (the planning reads were not run).
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the body this file replaces is the one it was built on ──────────────────────
-- The second hash is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.submit_reservation_request(uuid,text,text,integer,timestamp with time zone,text,text)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('4302cf649528620768ae3849ac6d51a6', 'f2f3bc2c5a0a113aadbfc5776d5fe95d') THEN
    RAISE EXCEPTION 'S818 4j pre-flight: submit_reservation_request changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'pos_reservations_one_request_per_phone') THEN
    RAISE EXCEPTION 'S818 4j pre-flight: pos_reservations_one_request_per_phone is gone; this fix is built on it';
  END IF;
END;
$$;


-- ── 1. submit_reservation_request: answer this phone's passed requests before taking a new one ──
CREATE OR REPLACE FUNCTION public.submit_reservation_request(p_client_id uuid, p_name text, p_phone text, p_party_size integer, p_reserved_for timestamp with time zone, p_occasion text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pos_enabled boolean;
  v_settings jsonb;
  v_open text;
  v_close text;
  v_max_party integer;
  v_lead integer;
  v_digits text;
  v_phone_c text;
  v_hm text;
  v_local timestamp;
  v_dow integer;
  v_date_iso text;
  v_ip text;
  v_ip_count integer;
  v_client_count integer;
  v_band text;
  v_duration integer;
  v_seats integer;
  v_peak integer;
  v_id uuid;
BEGIN
  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = p_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'closed', 'message', 'Online booking is not available here.');
  END IF;
  -- S809 (RESERVATIONS-3): a locked outlet refuses with POS switched off's own answer, word for
  -- word, before the attempts row (so it costs the guest no quota, as POS switched off does not).
  IF NOT COALESCE(public.client_access_open(p_client_id), false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'closed', 'message', 'Online booking is not available here.');
  END IF;

  SELECT s.pos_reservation_settings, s.pos_open_time, s.pos_close_time
    INTO v_settings, v_open, v_close
  FROM settings s WHERE s.client_id = p_client_id LIMIT 1;
  IF NOT COALESCE((v_settings->>'public_booking_enabled')::boolean, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'closed', 'message', 'Online booking is not available here.');
  END IF;
  v_max_party := COALESCE((v_settings->>'max_party_online')::integer, 20);
  v_lead      := COALESCE((v_settings->>'min_lead_minutes')::integer, 60);

  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'name', 'message', 'Please tell us your name.');
  END IF;
  v_digits  := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_phone_c := regexp_replace(CASE WHEN v_digits ~ '^977.{8,}' THEN substring(v_digits FROM 4) ELSE v_digits END, '^0+', '');
  IF length(v_phone_c) <> 10 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'phone', 'message', 'Please enter a 10-digit mobile number.');
  END IF;
  IF p_party_size IS NULL OR p_party_size < 1 OR p_party_size > v_max_party THEN
    RETURN jsonb_build_object('ok', false, 'code', 'party', 'message',
      format('Online bookings are for 1 to %s guests. For a larger party, please call.', v_max_party));
  END IF;
  IF p_reserved_for IS NULL OR p_reserved_for < now() + make_interval(mins => v_lead) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'too_soon', 'message',
      format('Please book at least %s minutes ahead, or call for a table right now.', v_lead));
  END IF;
  IF p_reserved_for > now() + interval '14 days' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'too_far', 'message', 'Online booking is open up to 14 days ahead.');
  END IF;

  v_local    := p_reserved_for AT TIME ZONE 'Asia/Kathmandu';
  v_hm       := to_char(v_local, 'HH24:MI');
  v_dow      := EXTRACT(dow FROM v_local)::integer;
  v_date_iso := to_char(v_local, 'YYYY-MM-DD');

  IF COALESCE(v_open, '') <> '' AND COALESCE(v_close, '') <> '' THEN
    IF v_open <= v_close THEN
      IF v_hm < v_open OR v_hm > v_close THEN
        RETURN jsonb_build_object('ok', false, 'code', 'hours', 'message', format('Bookings are taken between %s and %s.', v_open, v_close));
      END IF;
    ELSE
      IF v_hm > v_close AND v_hm < v_open THEN
        RETURN jsonb_build_object('ok', false, 'code', 'hours', 'message', format('Bookings are taken between %s and %s.', v_open, v_close));
      END IF;
    END IF;
  END IF;

  -- Closed that day (weekly off, or a listed date), or walk-ins only that weekday.
  IF COALESCE(v_settings->'closed_weekdays' @> to_jsonb(v_dow), false)
     OR COALESCE(v_settings->'closed_dates' @> to_jsonb(v_date_iso), false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'closed_day', 'message', 'Closed that day.');
  END IF;
  IF COALESCE(v_settings->'walk_in_weekdays' @> to_jsonb(v_dow), false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'walk_in', 'message', 'Walk-ins only that day.');
  END IF;

  -- Expected duration from the outlet's own per-band setting, needed for the fullness check too.
  v_band := CASE WHEN p_party_size <= 2 THEN '1-2' WHEN p_party_size <= 4 THEN '3-4' WHEN p_party_size <= 6 THEN '5-6' ELSE '7+' END;
  v_duration := COALESCE((v_settings->'duration_by_band'->>v_band)::integer, 90);
  v_duration := LEAST(GREATEST(v_duration, 15), 720);

  -- Full: in any hour this party would be sitting, booked covers plus this party exceed the
  -- room. A room with no capacity set is never "full" — the host decides at Accept.
  SELECT COALESCE(sum(t.capacity), 0)::integer INTO v_seats
  FROM pos_tables t WHERE t.client_id = p_client_id AND COALESCE(t.status, '') <> 'inactive';
  IF v_seats > 0 THEN
    SELECT COALESCE(max(l.covers), 0) INTO v_peak
    FROM public.reservation_hour_load(p_client_id, p_reserved_for, p_reserved_for + make_interval(mins => v_duration)) l
    WHERE (l.day, l.hour) IN (
      SELECT gs::date, EXTRACT(hour FROM gs)::integer
      FROM generate_series(date_trunc('hour', v_local), v_local + make_interval(mins => v_duration) - interval '1 second', interval '1 hour') gs
    );
    IF v_peak + p_party_size > v_seats THEN
      RETURN jsonb_build_object('ok', false, 'code', 'full', 'message', 'That time is fully booked.');
    END IF;
  END IF;

  -- Rate limit, recorded BEFORE the insert (see 20260904200000 for why this returns rather
  -- than raises).
  BEGIN
    v_ip := split_part(COALESCE(current_setting('request.headers', true)::json->>'x-forwarded-for', ''), ',', 1);
  EXCEPTION WHEN OTHERS THEN
    v_ip := '';
  END;
  v_ip := NULLIF(btrim(v_ip), '');
  INSERT INTO pos_reservation_request_attempts (client_id, ip, phone_canonical)
    VALUES (p_client_id, COALESCE(v_ip, 'unknown'), v_phone_c);
  -- Per connection: every attempt counts, refused ones included, so the cheapest attack (keep
  -- getting refused) still burns this connection's quota.
  SELECT count(*) INTO v_ip_count FROM pos_reservation_request_attempts
    WHERE client_id = p_client_id AND ip = COALESCE(v_ip, 'unknown') AND created_at > now() - interval '1 hour';
  IF v_ip_count > 5 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'rate', 'message', 'Too many booking requests from this connection. Please call instead.');
  END IF;
  -- S809 (RESERVATIONS-4, owner decision Q3 a): the whole outlet's limit counts REQUESTS THAT
  -- BECAME BOOKINGS in the last hour, never attempts. It counted every attempt row, refused ones
  -- included, so one connection refused after its 5th kept adding rows until every guest was
  -- refused. 40 an hour, as before: the 41st is refused. 'busy', not 'rate', so the page no longer
  -- tells a guest their own connection sent too many.
  SELECT count(*) INTO v_client_count FROM pos_reservations
    WHERE client_id = p_client_id AND source = 'website' AND created_at > now() - interval '1 hour';
  IF v_client_count >= 40 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'busy', 'message', 'Online booking is busy right now. Please call instead.');
  END IF;

  -- S818 4j (RESERVATIONS-9): this phone's own requests whose time has passed unanswered are
  -- answered now, as declined 'Not answered in time' (the reason staff can also pick, which the
  -- guest's page shows). The one-request-per-phone index has no time bound, so an outlet that never
  -- answered blocked that number for good. Only this phone's, and only once the time asked for has
  -- gone: a request still to come keeps blocking a second one.
  UPDATE pos_reservations
     SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'Not answered in time'
   WHERE client_id = p_client_id AND phone_canonical = v_phone_c
     AND status = 'requested' AND reserved_for < now();

  BEGIN
    INSERT INTO pos_reservations (client_id, customer_name, phone, party_size, reserved_for, duration_minutes, status, source, occasion, notes)
    VALUES (
      p_client_id, left(btrim(p_name), 80), v_phone_c, p_party_size, p_reserved_for, v_duration,
      'requested', 'website',
      NULLIF(left(btrim(COALESCE(p_occasion, '')), 80), ''),
      NULLIF(left(btrim(COALESCE(p_notes, '')), 300), '')
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pending', 'message', 'You already have a booking request waiting to be confirmed.');
  END;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$function$;


-- ── 2. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_client    uuid;
  v_table     uuid;
  v_stale     uuid;
  v_other     uuid;
  v_future    uuid;
  v_new       uuid;
  v_res       jsonb;
  v_n         bigint;
  v_ok        boolean;
  v_row       record;
  v_when      timestamptz := date_trunc('hour', now()) + interval '3 days';
  v_sig       text := 'public.submit_reservation_request(uuid,text,text,integer,timestamp with time zone,text,text)';
BEGIN
  -- ── Catalog: same body as written, still DEFINER, grants as S809 left them ──
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_sig::regprocedure) IS DISTINCT FROM 'f2f3bc2c5a0a113aadbfc5776d5fe95d' THEN
    RAISE EXCEPTION 'S818 4j: submit_reservation_request is not the body this file wrote';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_sig::regprocedure) THEN
    RAISE EXCEPTION 'S818 4j: submit_reservation_request is no longer SECURITY DEFINER';
  END IF;
  IF NOT (has_function_privilege('anon', v_sig, 'EXECUTE') AND has_function_privilege('authenticated', v_sig, 'EXECUTE')
          AND has_function_privilege('service_role', v_sig, 'EXECUTE')) THEN
    RAISE EXCEPTION 'S818 4j: the public booking page''s roles lost EXECUTE on submit_reservation_request';
  END IF;

  SELECT c.id INTO v_client FROM public.clients c
   WHERE c.pos_enabled AND EXISTS (SELECT 1 FROM public.settings s WHERE s.client_id = c.id)
   ORDER BY c.id LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S818 4j probe: no POS outlet with a settings row';
  END IF;

  BEGIN
    -- Setup, as the migration's own role: a table of 500 seats (nothing is "full"), online booking on
    -- with no closed days and no hours, and the outlet open by every rule.
    INSERT INTO public.pos_tables (client_id, name, capacity, status)
      VALUES (v_client, 'S818 4j probe', 500, 'available') RETURNING id INTO v_table;
    UPDATE public.settings
       SET pos_reservation_settings = COALESCE(pos_reservation_settings, '{}'::jsonb) || jsonb_build_object(
             'public_booking_enabled', true, 'closed_weekdays', '[]'::jsonb, 'walk_in_weekdays', '[]'::jsonb,
             'closed_dates', '[]'::jsonb, 'min_lead_minutes', 60, 'max_party_online', 20),
           pos_open_time = NULL, pos_close_time = NULL
     WHERE client_id = v_client;
    UPDATE public.clients
       SET is_active = true, is_trial = false, trial_approved_at = NULL, trial_expires_at = NULL,
           ims_ends_at = NULL, hr_ends_at = NULL, pos_ends_at = NULL, customization_ends_at = NULL,
           suite_ends_at = NULL, subscription_ends_at = NULL
     WHERE id = v_client;

    -- Three requests the outlet never answered: one from the guest about to ask again (its time
    -- passed two hours ago), one from another number (also passed), and one still to come.
    INSERT INTO public.pos_reservations (client_id, customer_name, phone, party_size, reserved_for, status, source)
      VALUES (v_client, 'S818 probe stale', '9100000301', 2, now() - interval '2 hours', 'requested', 'website')
      RETURNING id INTO v_stale;
    INSERT INTO public.pos_reservations (client_id, customer_name, phone, party_size, reserved_for, status, source)
      VALUES (v_client, 'S818 probe other', '9100000302', 2, now() - interval '2 hours', 'requested', 'website')
      RETURNING id INTO v_other;
    INSERT INTO public.pos_reservations (client_id, customer_name, phone, party_size, reserved_for, status, source)
      VALUES (v_client, 'S818 probe future', '9100000303', 2, v_when + interval '1 day', 'requested', 'website')
      RETURNING id INTO v_future;

    -- (a) The guest whose request went unanswered asks again: taken, and the old one is answered.
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    PERFORM set_config('request.headers', '{"x-forwarded-for":"203.0.113.181"}', true);
    SET LOCAL ROLE anon;
    v_res := public.submit_reservation_request(v_client, 'S818 probe stale', '+977 9100000301', 2, v_when, NULL, NULL);
    RESET ROLE;
    IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'S818 4j probe: a number whose only request had passed was refused: %', v_res;
    END IF;
    v_new := (v_res->>'id')::uuid;
    SELECT status, cancelled_at, cancel_reason INTO v_row FROM public.pos_reservations WHERE id = v_stale;
    IF v_row.status IS DISTINCT FROM 'cancelled' OR v_row.cancelled_at IS NULL
       OR v_row.cancel_reason IS DISTINCT FROM 'Not answered in time' THEN
      RAISE EXCEPTION 'S818 4j probe: the passed request was left as % / % / %', v_row.status, v_row.cancelled_at, v_row.cancel_reason;
    END IF;
    IF (SELECT status FROM public.pos_reservations WHERE id = v_new) IS DISTINCT FROM 'requested' THEN
      RAISE EXCEPTION 'S818 4j probe: the new request did not land as requested';
    END IF;
    -- The guest's own card reads the answer through the status function, as the page does.
    SET LOCAL ROLE anon;
    SELECT COALESCE(status = 'cancelled' AND cancel_reason = 'Not answered in time', false) INTO v_ok
      FROM public.get_reservation_request_status(v_stale);
    RESET ROLE;
    IF NOT COALESCE(v_ok, false) THEN
      RAISE EXCEPTION 'S818 4j probe: the guest''s status card does not read the expiry';
    END IF;

    -- (b) Only that phone's: another number's passed request still waits for staff.
    IF (SELECT status FROM public.pos_reservations WHERE id = v_other) IS DISTINCT FROM 'requested' THEN
      RAISE EXCEPTION 'S818 4j probe: another number''s request was answered by this guest''s';
    END IF;

    -- (c) The control: a request still to come keeps blocking a second one from its number.
    PERFORM set_config('request.headers', '{"x-forwarded-for":"203.0.113.182"}', true);
    SET LOCAL ROLE anon;
    v_res := public.submit_reservation_request(v_client, 'S818 probe future', '9100000303', 2, v_when, NULL, NULL);
    RESET ROLE;
    IF v_res->>'code' IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'S818 4j probe: a number with a request still to come was answered %', v_res;
    END IF;
    IF (SELECT status FROM public.pos_reservations WHERE id = v_future) IS DISTINCT FROM 'requested' THEN
      RAISE EXCEPTION 'S818 4j probe: a request still to come was answered';
    END IF;
    SELECT count(*) INTO v_n FROM public.pos_reservations
     WHERE client_id = v_client AND phone_canonical = '9100000303' AND status = 'requested';
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S818 4j probe: % requests now wait from the blocked number', v_n;
    END IF;
    PERFORM set_config('request.jwt.claims', '', true);

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's818_4j_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's818_4j_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;


-- ── 3. What this slice acts on, live (the last statement, so `db query` prints it) ────────────
SELECT
  (SELECT count(*) FROM public.pos_reservations WHERE status = 'requested') AS requests_waiting,
  (SELECT count(*) FROM public.pos_reservations WHERE status = 'requested' AND reserved_for < now()) AS requests_time_passed,
  (SELECT count(*) FROM public.pos_reservations WHERE status = 'no_show' AND no_show_at < reserved_for) AS no_shows_marked_before_time,
  (SELECT count(DISTINCT r.id) FROM public.pos_reservations r
     JOIN public.pos_reservation_tables rt ON rt.reservation_id = r.id
     JOIN public.pos_tables t ON t.id = rt.table_id
    WHERE t.status = 'inactive' AND r.status IN ('requested', 'booked', 'confirmed', 'arrived', 'seated')) AS live_bookings_on_inactive_tables,
  (SELECT count(*) FROM public.pos_reservations r JOIN public.pos_orders o ON o.id = r.order_id
    WHERE r.status = 'seated' AND o.status = 'open') AS seated_on_open_orders,
  (SELECT md5(prosrc) FROM pg_proc
    WHERE oid = 'public.submit_reservation_request(uuid,text,text,integer,timestamp with time zone,text,text)'::regprocedure) AS body_md5;

-- Read back after applying (one statement per call):
--   SELECT md5(prosrc), prosecdef, proacl FROM pg_proc
--    WHERE oid = 'public.submit_reservation_request(uuid,text,text,integer,timestamp with time zone,text,text)'::regprocedure;
--     expect f2f3bc2c5a0a113aadbfc5776d5fe95d, true, and the same proacl as before (PUBLIC, anon, authenticated, service_role).
