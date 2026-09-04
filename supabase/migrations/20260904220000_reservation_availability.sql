-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Public booking page: closed days, walk-in-only days, and full slots (S677, second pass).
--
-- The first pass accepted any request for any slot on any day and left every "no" to the host at
-- Accept time. A guest who asked for a Dashain-closed day or a Saturday the room cannot hold only
-- learned it later. Three rules now live in settings.pos_reservation_settings and are enforced in
-- both places a guest can reach: the page greys the day or slot out BEFORE they pick it, and
-- submit_reservation_request refuses it if a stale page sends it anyway.
--
--   closed_weekdays   int[]  0=Sun..6=Sat — the weekly off day(s)
--   closed_dates      text[] 'YYYY-MM-DD' — Dashain, Tihar, a private function
--   walk_in_weekdays  int[]  days the outlet takes no ONLINE bookings (walk-ins only)
--   page_notice       text   one line under the page title ("Large groups please call")
--
-- Fullness is booked covers per hour (the staff capacity strip's arithmetic, done in SQL here)
-- against the room's seats. Deliberately NOT derived from the HR holiday calendar — restaurants
-- are usually open on a public holiday, so closures are the outlet's own list.
-- ════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Booked covers per hour, in Nepal's clock ─────────────────────────────────────────────
-- A booking occupies every hour its window touches (19:30 + 90 min → 19 and 20). Internal: called
-- only from the two SECURITY DEFINER functions below, which run as the owner, so this can stay
-- INVOKER and holds no grant of its own.
CREATE OR REPLACE FUNCTION public.reservation_hour_load(p_client_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE(day date, hour integer, covers integer)
  LANGUAGE sql STABLE
  SET search_path TO 'public'
  AS $$
  WITH live AS (
    SELECT (r.reserved_for AT TIME ZONE 'Asia/Kathmandu') AS s,
           (r.reserved_for AT TIME ZONE 'Asia/Kathmandu') + make_interval(mins => r.duration_minutes) AS e,
           r.party_size
    FROM pos_reservations r
    WHERE r.client_id = p_client_id
      AND r.status IN ('requested','booked','confirmed','arrived','seated')
      -- A booking that STARTED before the window can still be sitting inside it.
      AND r.reserved_for >= p_from - interval '12 hours'
      AND r.reserved_for < p_to
  ),
  hours AS (
    SELECT gs AS h, l.party_size
    FROM live l,
         LATERAL generate_series(date_trunc('hour', l.s), l.e - interval '1 second', interval '1 hour') AS gs
  )
  SELECT h::date AS day, EXTRACT(hour FROM h)::integer AS hour, sum(party_size)::integer AS covers
  FROM hours
  GROUP BY 1, 2
$$;
REVOKE ALL ON FUNCTION public.reservation_hour_load(uuid, timestamptz, timestamptz) FROM PUBLIC;

-- ── 2. get_booking_page grows: seats, durations, the three rules, the notice ────────────────
-- Return columns change, so DROP first (42P13 — CREATE OR REPLACE cannot change a return type).
DROP FUNCTION IF EXISTS public.get_booking_page(uuid);
CREATE FUNCTION public.get_booking_page(p_client_id uuid) RETURNS TABLE(
  outlet_name text, open_time text, close_time text,
  max_party_online integer, min_lead_minutes integer, max_days_ahead integer,
  total_seats integer, duration_by_band jsonb,
  closed_weekdays integer[], walk_in_weekdays integer[], closed_dates text[], page_notice text
) LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
DECLARE
  v_pos_enabled boolean;
  v_name text;
  v_settings jsonb;
  v_open text;
  v_close text;
  v_seats integer;
BEGIN
  SELECT c.pos_enabled, c.name INTO v_pos_enabled, v_name FROM clients c WHERE c.id = p_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RETURN; END IF;

  SELECT s.pos_reservation_settings, s.pos_open_time, s.pos_close_time
    INTO v_settings, v_open, v_close
  FROM settings s WHERE s.client_id = p_client_id LIMIT 1;
  IF NOT COALESCE((v_settings->>'public_booking_enabled')::boolean, false) THEN RETURN; END IF;

  SELECT COALESCE(sum(t.capacity), 0)::integer INTO v_seats
  FROM pos_tables t WHERE t.client_id = p_client_id AND COALESCE(t.status, '') <> 'inactive';

  RETURN QUERY SELECT
    v_name, v_open, v_close,
    COALESCE((v_settings->>'max_party_online')::integer, 20),
    COALESCE((v_settings->>'min_lead_minutes')::integer, 60),
    14,
    v_seats,
    COALESCE(v_settings->'duration_by_band', '{}'::jsonb),
    CASE WHEN jsonb_typeof(v_settings->'closed_weekdays') = 'array'
         THEN COALESCE((SELECT array_agg(x::integer) FROM jsonb_array_elements_text(v_settings->'closed_weekdays') x), '{}'::integer[])
         ELSE '{}'::integer[] END,
    CASE WHEN jsonb_typeof(v_settings->'walk_in_weekdays') = 'array'
         THEN COALESCE((SELECT array_agg(x::integer) FROM jsonb_array_elements_text(v_settings->'walk_in_weekdays') x), '{}'::integer[])
         ELSE '{}'::integer[] END,
    CASE WHEN jsonb_typeof(v_settings->'closed_dates') = 'array'
         THEN COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(v_settings->'closed_dates') x), '{}'::text[])
         ELSE '{}'::text[] END,
    NULLIF(btrim(COALESCE(v_settings->>'page_notice', '')), '');
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_booking_page(uuid) TO anon, authenticated, service_role;

-- ── 3. Availability for the next 14 days: numbers only, no names ────────────────────────────
-- Gated exactly as the page is; an outlet with online booking off returns nothing here too.
DROP FUNCTION IF EXISTS public.get_booking_availability(uuid);
CREATE FUNCTION public.get_booking_availability(p_client_id uuid) RETURNS TABLE(
  day text, hour integer, covers integer
) LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
DECLARE
  v_pos_enabled boolean;
  v_settings jsonb;
BEGIN
  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = p_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RETURN; END IF;
  SELECT s.pos_reservation_settings INTO v_settings FROM settings s WHERE s.client_id = p_client_id LIMIT 1;
  IF NOT COALESCE((v_settings->>'public_booking_enabled')::boolean, false) THEN RETURN; END IF;

  RETURN QUERY
    SELECT to_char(l.day, 'YYYY-MM-DD'), l.hour, l.covers
    FROM public.reservation_hour_load(p_client_id, now(), now() + interval '15 days') l;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_booking_availability(uuid) TO anon, authenticated, service_role;

-- ── 4. submit_reservation_request refuses closed days, walk-in days and full slots ──────────
-- Same signature as 20260904200000, so CREATE OR REPLACE replaces the body in place. The three
-- new refusals are validation (no quota), placed after the opening-hours check and before the
-- rate limit. Every guard is COALESCE'd: a missing setting means "no rule", never "fall open
-- into the privileged path", and a NULL from `@>` on a missing key would otherwise skip the IF.
CREATE OR REPLACE FUNCTION public.submit_reservation_request(
  p_client_id uuid, p_name text, p_phone text, p_party_size integer, p_reserved_for timestamptz,
  p_occasion text DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
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
  SELECT count(*) INTO v_ip_count FROM pos_reservation_request_attempts
    WHERE client_id = p_client_id AND ip = COALESCE(v_ip, 'unknown') AND created_at > now() - interval '1 hour';
  IF v_ip_count > 5 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'rate', 'message', 'Too many booking requests from this connection. Please call instead.');
  END IF;
  SELECT count(*) INTO v_client_count FROM pos_reservation_request_attempts
    WHERE client_id = p_client_id AND created_at > now() - interval '1 hour';
  IF v_client_count > 40 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'rate', 'message', 'Online booking is busy right now. Please call instead.');
  END IF;

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
$$;
GRANT EXECUTE ON FUNCTION public.submit_reservation_request(uuid, text, text, integer, timestamptz, text, text) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────────────────────
-- SELECT has_function_privilege('anon', 'public.get_booking_availability(uuid)', 'EXECUTE');          -- true
-- SELECT has_function_privilege('anon', 'public.reservation_hour_load(uuid,timestamptz,timestamptz)', 'EXECUTE'); -- false
-- SELECT * FROM public.get_booking_page('<client uuid>');   -- one row with 12 columns when the toggle is on
-- SELECT * FROM public.get_booking_availability('<client uuid>');  -- day/hour/covers rows for live bookings
-- SELECT public.submit_reservation_request('<client uuid>', 'T', '9841234567', 2, now() + interval '2 hours');
--   -- with that weekday in closed_weekdays: {"ok": false, "code": "closed_day", ...}
