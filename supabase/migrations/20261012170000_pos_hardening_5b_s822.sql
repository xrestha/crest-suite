-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S822, POS stage 5, slice 5b, step 3 of 3: the booking limit counts the connection Cloudflare saw,
-- deleting an open order is no longer refused as a closed bill, and the phone-number refusal names
-- Move.
--
--   What the header probe showed (20261012160000, called live over /rest/v1/rpc/ as anon, then
--   dropped by 20261012160100; the shape only, never a real address):
--     * cf-connecting-ip is set by Cloudflare to the address it saw. A request that sends its own
--       cf-connecting-ip is refused at Cloudflare's edge (403, "error code: 1000") and never reaches
--       the database, so the caller cannot choose it.
--     * x-forwarded-for keeps whatever the caller sent, and Cloudflare appends the address it saw at
--       the END: an honest call carries one address (the same as cf-connecting-ip); a caller's
--       "198.51.100.7, 203.0.113.9" arrives as "198.51.100.7, 203.0.113.9,<the real address>".
--     * x-real-ip is dropped; Forwarded and True-Client-IP arrive exactly as the caller sent them.
--     * x-crest-build arrives as sent, and the gateway's preflight allows it. So slice 5c may raise
--       pos_min_till_build() once its release is deployed (the S809 1b gate does see the header).
--
--   A2 (rate limit). submit_reservation_request counted a connection by the FIRST hop of
--   x-forwarded-for, which is the caller's own text, so a script could be a new connection on every
--   request and never meet the 5-an-hour limit. It now counts cf-connecting-ip, falling back to the
--   LAST hop of x-forwarded-for if that header is ever missing, then 'unknown' as before. An IPv6
--   address counts as its /64, the block one line is handed and can pick new addresses from. An
--   honest guest's key is the same address it was before (one hop), so the hour already counted
--   carries over. Nothing else in the function changes.
--
--   A2 (delete message). Deleting an OPEN order that still had lines was refused as "this bill is
--   closed and printed" (measured S755). guard_pos_order_items_closed and
--   guard_pos_order_payments_closed are AFTER STATEMENT triggers; inside the pos_orders cascade they
--   fire as the caller after the order row is gone, and their LEFT JOIN read the missing parent as
--   not open. Their DELETE branch now passes a parent that no longer exists at all, asked of a new
--   SECURITY DEFINER lookup, pos_orders_still_exist(uuid[]) (the S749 rule: the caller's RLS view
--   cannot tell a parent that is gone from one it may not see, so an existing parent the caller
--   cannot see is still refused). A closed bill is unchanged: its own delete is refused first, by
--   guard_pos_order_delete, before any cascade runs. INSERT and UPDATE branches are untouched.
--   What an open order's delete now meets: unsent lines go with it; a sent line's kitchen ticket
--   refuses it (pos_kot_ticket_locked, "void the order instead"); a points line refuses it with
--   pos_payment_line_locked ("press Undo on the points"), where it said the bill was closed.
--   No app path changes: Clear Occupied deletes the lines first and then the empty order. The same
--   pass also lets the whole-client backstop cascade (S819 DATABASE-7) through these two guards.
--
--   4g (phone lock). pos_customers_guard_loyalty's sentence said "the points stay with the old
--   number"; since S815 the Owner or a POS manager moves them with Move to a new number. Only the
--   sentence changes. The app's wording (errorText.js) and Help change in the same session.
--
-- Built on the live bodies, md5(prosrc), read 2026-10-12: submit_reservation_request
-- f2f3bc2c5a0a113aadbfc5776d5fe95d (S818 4j, 20261012130000), guard_pos_order_items_closed
-- 124d50c9d0b2c3951c33870fe32b8ec3, guard_pos_order_payments_closed 412a96a5c93a942a5e9aa08f17ddaba8,
-- pos_customers_guard_loyalty 2ba9378b781a040433709a354f098c33. Section 0 refuses any other body.
-- Signatures, return types, SECURITY and search_path are unchanged, so CREATE OR REPLACE keeps every
-- grant and every trigger stays attached.
--
-- No till sends anything new and no RPC changes shape: the till build floor is unchanged. No Edge
-- Function deploy. Found, not changed here: admin-user-ops reads the first hop of x-forwarded-for for
-- the trial-signup limit and the legal-acceptance address; that path is the Edge Function gateway,
-- which this probe did not test (filed for 5e, which redeploys admin-user-ops).
--
-- To undo: re-run each function's CREATE OR REPLACE from the file that last wrote it (the md5s
-- above): submit_reservation_request from 20261012130000, guard_pos_order_items_closed from
-- 20260916100000, guard_pos_order_payments_closed and pos_customers_guard_loyalty from
-- 20261009150000; then DROP FUNCTION public.pos_orders_still_exist(uuid[]).
--
-- The probe at the end acts as a POS outlet's Owner and as a guest on its booking page inside a
-- block that rolls itself back. If any check fails, nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces, and the header probe gone ────────────────────
-- Each second hash is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.submit_reservation_request(uuid, text, text, integer, timestamptz, text, text)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('f2f3bc2c5a0a113aadbfc5776d5fe95d', '524048ce8abd848beedb4fb51600eb76') THEN
    RAISE EXCEPTION 'S822 5b pre-flight: submit_reservation_request changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_order_items_closed()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('124d50c9d0b2c3951c33870fe32b8ec3', 'e4c351f7d862168af0924436a434c889') THEN
    RAISE EXCEPTION 'S822 5b pre-flight: guard_pos_order_items_closed changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_order_payments_closed()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('412a96a5c93a942a5e9aa08f17ddaba8', '7b17f869591802ab11fca0770b1d7848') THEN
    RAISE EXCEPTION 'S822 5b pre-flight: guard_pos_order_payments_closed changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_customers_guard_loyalty()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('2ba9378b781a040433709a354f098c33', '8de45d984d5fd1e4d9f65bb1d62d2718') THEN
    RAISE EXCEPTION 'S822 5b pre-flight: pos_customers_guard_loyalty changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  IF to_regprocedure('public.crest_header_probe_s822()') IS NOT NULL THEN
    RAISE EXCEPTION 'S822 5b pre-flight: the header probe is still there; apply 20261012160100 first';
  END IF;
END;
$$;


-- ── 1. The lookup: does any of these bills still exist? ─────────────────────────────────────────
-- SECURITY DEFINER so the answer does not depend on the caller's RLS view (S749). It says only
-- whether a row with one of these ids exists: nothing about its outlet, status or contents. Its one
-- caller is the two guards below, inside a trigger; called any other way (an RPC) it answers true
-- for every id, so it tells a browser nothing. The guards run as the browser's role (INVOKER), so
-- authenticated keeps EXECUTE; anon never reaches a DELETE branch, and is refused if it ever does.
CREATE OR REPLACE FUNCTION public.pos_orders_still_exist(p_ids uuid[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN pg_trigger_depth() = 0 THEN true
              ELSE EXISTS (SELECT 1 FROM pos_orders WHERE id = ANY (p_ids)) END
$function$;

COMMENT ON FUNCTION public.pos_orders_still_exist(uuid[]) IS
  'S822 5b: inside a trigger, whether any of these pos_orders ids still exists (true outside a trigger). Read by the bill-line guards to tell a deleted parent from a closed one.';

REVOKE ALL ON FUNCTION public.pos_orders_still_exist(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_orders_still_exist(uuid[]) TO authenticated, service_role;


-- ── 2. The two bill guards: a deleted parent is not a closed one ────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_pos_order_items_closed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_hit boolean;
  v_ids uuid[];
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NULL;
  END IF;

  -- LEFT JOIN: a parent this session cannot see reads as "not open" and is refused, never passed.
  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (SELECT 1 FROM new_rows r LEFT JOIN pos_orders o ON o.id = r.order_id
                    WHERE o.status IS DISTINCT FROM 'open') INTO v_hit;
    -- The operator's restore inserts the lines of closed bills.
    IF v_hit AND COALESCE(public.is_admin(), false) THEN
      v_hit := false;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT EXISTS (SELECT 1 FROM old_rows r LEFT JOIN pos_orders o ON o.id = r.order_id
                    WHERE o.status IS DISTINCT FROM 'open')
        OR EXISTS (SELECT 1 FROM new_rows r LEFT JOIN pos_orders o ON o.id = r.order_id
                    WHERE o.status IS DISTINCT FROM 'open') INTO v_hit;
  ELSE
    -- S822 5b (A2): deleting an OPEN order cascades here, and this statement trigger fires after the
    -- order row is gone, so its parent read as "not open" and the order was refused as a closed
    -- bill. A parent that no longer exists at all is passed; asked of the SECURITY DEFINER lookup,
    -- because this session's RLS view cannot tell a gone parent from one it may not see (S749).
    -- A closed bill's own delete is refused before any cascade, by guard_pos_order_delete.
    SELECT array_agg(DISTINCT r.order_id) INTO v_ids
      FROM old_rows r LEFT JOIN pos_orders o ON o.id = r.order_id
     WHERE o.status IS DISTINCT FROM 'open';
    v_hit := v_ids IS NOT NULL AND COALESCE(public.pos_orders_still_exist(v_ids), true);
  END IF;

  IF v_hit THEN
    RAISE EXCEPTION 'pos_order_items: this bill is closed and printed, so its lines can no longer be changed — issue a Credit Note to correct it'
      USING ERRCODE = '42501', HINT = 'bill_locked';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_pos_order_payments_closed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_hit boolean;
  v_ids uuid[];
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1
        FROM (SELECT DISTINCT order_id FROM new_rows) r
        LEFT JOIN pos_orders o ON o.id = r.order_id
       WHERE NOT COALESCE(
               o.status = 'billed'
           AND o.payment_method = 'Split'
           AND o.closed_by = (SELECT auth.uid())
           AND o.closed_at >= now() - interval '10 minutes'
           AND NOT EXISTS (SELECT 1 FROM new_rows n WHERE n.order_id = r.order_id AND n.payment_method = 'Loyalty')
           AND (SELECT COALESCE(SUM(p.amount), 0) FROM pos_order_payments p WHERE p.order_id = r.order_id)
                 <= COALESCE(o.paid_amount, 0) + 0.5
         , false)
    ) INTO v_hit;
    IF v_hit AND COALESCE(public.is_admin(), false) THEN
      v_hit := false;   -- the operator's restore
    END IF;
    IF v_hit THEN
      RAISE EXCEPTION 'pos_order_payments: payment lines are recorded by the Payment screen as the bill closes, by whoever closed it — they cannot be added afterwards or by hand'
        USING ERRCODE = '42501', HINT = 'bill_locked';
    END IF;
    RETURN NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT EXISTS (SELECT 1 FROM old_rows r LEFT JOIN pos_orders o ON o.id = r.order_id
                    WHERE o.status IS DISTINCT FROM 'open')
        OR EXISTS (SELECT 1 FROM new_rows r LEFT JOIN pos_orders o ON o.id = r.order_id
                    WHERE o.status IS DISTINCT FROM 'open') INTO v_hit;
  ELSE
    -- S822 5b (A2): deleting an OPEN order cascades here, and this statement trigger fires after the
    -- order row is gone, so its parent read as "not open" and the order was refused as a closed
    -- bill. A parent that no longer exists at all is passed; asked of the SECURITY DEFINER lookup,
    -- because this session's RLS view cannot tell a gone parent from one it may not see (S749).
    -- A closed bill's own delete is refused before any cascade, by guard_pos_order_delete.
    SELECT array_agg(DISTINCT r.order_id) INTO v_ids
      FROM old_rows r LEFT JOIN pos_orders o ON o.id = r.order_id
     WHERE o.status IS DISTINCT FROM 'open';
    v_hit := v_ids IS NOT NULL AND COALESCE(public.pos_orders_still_exist(v_ids), true);
  END IF;

  IF v_hit THEN
    RAISE EXCEPTION 'pos_order_payments: this bill is closed, so how it was paid can no longer be changed'
      USING ERRCODE = '42501', HINT = 'bill_locked';
  END IF;

  -- S809 1i (DATABASE-4): an open bill's line is the till's too. Only redeem_loyalty_points
  -- writes or removes one, and it passed the seam above.
  IF EXISTS (SELECT 1 FROM old_rows) THEN
    RAISE EXCEPTION 'pos_payment_line_locked: a bill''s payment lines are written by the till itself — the points line when points are redeemed, the rest as the bill closes — so they cannot be changed or removed by hand; to take points off an open bill, press Undo on the points in the payment window'
      USING ERRCODE = '42501', HINT = 'pos_payment_line_locked';
  END IF;
  RETURN NULL;
END;
$function$;


-- ── 3. The phone-number refusal names Move ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_customers_guard_loyalty()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- S809 1i (DATABASE-5): a delete never takes a customer's points history with it.
  IF TG_OP = 'DELETE' THEN
    IF current_user NOT IN ('anon', 'authenticated') THEN
      RETURN OLD;
    END IF;
    IF EXISTS (SELECT 1 FROM pos_loyalty_ledger l WHERE l.customer_id = OLD.id) THEN
      RAISE EXCEPTION 'pos_customer_has_points_history: this customer has a loyalty points history (every point earned and spent, and which bills spent them), so the customer cannot be deleted — take them off their scheme in Customers → Loyalty instead'
        USING ERRCODE = '42501', HINT = 'pos_customer_has_points_history';
    END IF;
    IF OLD.loyalty_scheme_id IS NOT NULL
       AND NOT COALESCE(public.pos_caller_has_rank('manager'), false) THEN
      RAISE EXCEPTION 'pos_customer_delete_rank: this customer is enrolled in a loyalty scheme, and only the Owner or a POS manager can take a customer out of one'
        USING ERRCODE = '42501', HINT = 'pos_customer_delete_rank';
    END IF;
    RETURN OLD;
  END IF;

  -- Cheap test first: this fires on every bill closed with a name and phone. The till's upsert
  -- re-sends the phone and outlet it matched on, so its row leaves all four of these unchanged.
  IF (TG_OP = 'INSERT' AND NEW.loyalty_scheme_id IS NULL)
     OR (TG_OP = 'UPDATE'
         AND NEW.loyalty_scheme_id IS NOT DISTINCT FROM OLD.loyalty_scheme_id
         AND NEW.phone             IS NOT DISTINCT FROM OLD.phone
         AND NEW.client_id         IS NOT DISTINCT FROM OLD.client_id
         AND NEW.id                IS NOT DISTINCT FROM OLD.id) THEN
    RETURN NEW;
  END IF;
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- S809 1i (CUSTOMERS-PARKING-7): the balance belongs to the phone, because the loyalty RPCs find
  -- the customer by the phone on the bill. No screen changes a phone, an outlet or an id.
  IF TG_OP = 'UPDATE'
     AND (NEW.phone     IS DISTINCT FROM OLD.phone
       OR NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.id        IS DISTINCT FROM OLD.id) THEN
    RAISE EXCEPTION 'pos_customer_phone_locked: a customer''s phone number and outlet are what their loyalty points and bill history belong to, so they cannot be changed — a new number starts a new customer the first time a bill is closed with it, and the Owner or a POS manager takes a regular''s points to their new number with Move to a new number (the ⋯ on their row in Customers → Loyalty)'
      USING ERRCODE = '42501', HINT = 'pos_customer_phone_locked';
  END IF;

  -- Reached only by an enrolment change: an INSERT with a scheme, or an UPDATE of the scheme.
  -- The operator's restore inserts enrolled customers; it passes here as before.
  IF COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;
  IF NOT COALESCE(public.pos_caller_has_rank('manager'), false) THEN
    RAISE EXCEPTION 'loyalty_enrol_rank: only the Owner or a POS manager can enrol a customer in a loyalty scheme'
      USING ERRCODE = '42501', HINT = 'loyalty_enrol_rank';
  END IF;
  RETURN NEW;
END;
$function$;


-- ── 4. The booking limit counts the connection Cloudflare saw ───────────────────────────────────
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
  v_hdr json;
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
  -- S822 5b (A2): the connection is the address Cloudflare saw, never one the caller wrote. Probed
  -- live (20261012160000): cf-connecting-ip is Cloudflare's own, and a request that sends one is
  -- refused at the edge (403, error 1000) before it reaches the database; x-forwarded-for keeps
  -- whatever the caller sent and Cloudflare appends the address it saw LAST. The first hop, read
  -- here until now, was the caller's to choose, so a script could be a new connection every time.
  -- The last hop is the fallback if cf-connecting-ip is ever missing.
  BEGIN
    v_hdr := NULLIF(current_setting('request.headers', true), '')::json;
  EXCEPTION WHEN OTHERS THEN
    v_hdr := NULL;
  END;
  v_ip := NULLIF(btrim(COALESCE(v_hdr->>'cf-connecting-ip', '')), '');
  IF v_ip IS NULL THEN
    v_ip := NULLIF(btrim(regexp_replace(COALESCE(v_hdr->>'x-forwarded-for', ''), '^.*,', '')), '');
  END IF;
  -- An IPv6 line is handed a whole /64 and can take a new address from it at will: count the /64.
  IF v_ip LIKE '%:%' THEN
    BEGIN
      v_ip := network(set_masklen(v_ip::inet, 64))::text;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
  v_ip := left(v_ip, 64);
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

NOTIFY pgrst, 'reload schema';


-- ── 5. Prove it ───────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_client uuid;
  v_owner  uuid;
  v_billed uuid;
  v_recipe uuid;
  v_open1  uuid;
  v_open2  uuid;
  v_cust   uuid;
  v_table  uuid;
  v_when   timestamptz := date_trunc('hour', now()) + interval '3 days';
  v_res    jsonb;
  v_n      bigint;
  v_hint   text;
  v_msg    text;
  v_ip     text;
  i        integer;
BEGIN
  -- Catalog: the lookup is DEFINER, authenticated-only among browser roles; the replaced bodies keep
  -- their SECURITY; all six guard triggers are attached and enabled.
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.pos_orders_still_exist(uuid[])'::regprocedure)
     OR has_function_privilege('anon', 'public.pos_orders_still_exist(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pos_orders_still_exist(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.pos_orders_still_exist(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'S822 5b: pos_orders_still_exist is not DEFINER with authenticated/service_role EXECUTE only';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE prosecdef AND oid IN (
        'public.submit_reservation_request(uuid, text, text, integer, timestamptz, text, text)'::regprocedure,
        'public.guard_pos_order_items_closed()'::regprocedure,
        'public.guard_pos_order_payments_closed()'::regprocedure,
        'public.pos_customers_guard_loyalty()'::regprocedure)) <> 1 THEN
    RAISE EXCEPTION 'S822 5b: a replaced function changed its SECURITY';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE NOT tgisinternal AND tgenabled = 'O'
     AND ((tgrelid = 'public.pos_order_items'::regclass
           AND tgname IN ('guard_pos_order_items_closed_del', 'guard_pos_order_items_closed_ins', 'guard_pos_order_items_closed_upd'))
       OR (tgrelid = 'public.pos_order_payments'::regclass
           AND tgname IN ('guard_pos_order_payments_closed_del', 'guard_pos_order_payments_closed_ins', 'guard_pos_order_payments_closed_upd')));
  IF v_n <> 6 THEN
    RAISE EXCEPTION 'S822 5b: % of the 6 bill-guard triggers are attached and enabled', v_n;
  END IF;

  -- ── Who acts: BLOOM CAFE (or the first POS outlet with an Owner, settings and a closed bill) ──
  SELECT c.id, p.id INTO v_client, v_owner
    FROM public.clients c JOIN public.profiles p ON p.client_id = c.id
   WHERE c.pos_enabled AND COALESCE(p.active_client_id, p.client_id) = c.id
     AND p.role = 'client' AND p.pos_role IS NULL AND p.pos_email IS NULL
     AND p.ims_role IS NULL AND p.hr_role IS NULL AND NOT COALESCE(p.hr_self_service, false)
     AND EXISTS (SELECT 1 FROM public.settings s WHERE s.client_id = c.id)
     AND EXISTS (SELECT 1 FROM public.pos_orders o JOIN public.pos_order_items l ON l.order_id = o.id
                  WHERE o.client_id = c.id AND o.status = 'billed')
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name, p.id LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S822 5b probe: no POS outlet with an Owner, a settings row and a closed bill';
  END IF;
  -- A closed bill with lines, one with payment lines too if the outlet has one.
  SELECT o.id INTO v_billed FROM public.pos_orders o
   WHERE o.client_id = v_client AND o.status = 'billed'
     AND EXISTS (SELECT 1 FROM public.pos_order_items l WHERE l.order_id = o.id)
   ORDER BY EXISTS (SELECT 1 FROM public.pos_order_payments p WHERE p.order_id = o.id) DESC, o.closed_at DESC NULLS LAST
   LIMIT 1;

  BEGIN
    -- Setup, as the migration's own role (every guard lets it through). The outlet open by every
    -- rule, online booking on with no closed days or hours, a 500-seat table so nothing is "full"
    -- (S818's setup); a test dish; an open order with one unsent line; an open order with one unsent
    -- line and a points line; a customer.
    UPDATE public.clients
       SET is_active = true, is_trial = false, trial_approved_at = NULL, trial_expires_at = NULL,
           ims_ends_at = NULL, hr_ends_at = NULL, pos_ends_at = NULL, customization_ends_at = NULL,
           suite_ends_at = NULL, subscription_ends_at = NULL
     WHERE id = v_client;
    UPDATE public.settings
       SET pos_reservation_settings = COALESCE(pos_reservation_settings, '{}'::jsonb) || jsonb_build_object(
             'public_booking_enabled', true, 'closed_weekdays', '[]'::jsonb, 'walk_in_weekdays', '[]'::jsonb,
             'closed_dates', '[]'::jsonb, 'min_lead_minutes', 60, 'max_party_online', 20),
           pos_open_time = NULL, pos_close_time = NULL
     WHERE client_id = v_client;
    INSERT INTO public.pos_tables (client_id, name, capacity, status)
      VALUES (v_client, 'S822 5b probe', 500, 'available') RETURNING id INTO v_table;
    INSERT INTO public.recipes (client_id, name) VALUES (v_client, 'S822 5b probe dish') RETURNING id INTO v_recipe;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_open1;
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price)
      VALUES (v_open1, v_client, 'S822 5b probe dish', v_recipe, 1, 100);
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_open2;
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price)
      VALUES (v_open2, v_client, 'S822 5b probe dish', v_recipe, 1, 100);
    INSERT INTO public.pos_order_payments (order_id, client_id, payment_method, amount)
      VALUES (v_open2, v_client, 'Loyalty', 10);
    INSERT INTO public.pos_customers (client_id, name, phone)
      VALUES (v_client, 'S822 5b probe', '9100000822') RETURNING id INTO v_cust;

    -- From here on, the Owner's own session.
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    SET LOCAL ROLE authenticated;

    -- (a) A2: an open order with an unsent line is deleted, and its line goes with it.
    v_msg := NULL;
    BEGIN
      DELETE FROM public.pos_orders WHERE id = v_open1;
      GET DIAGNOSTICS v_n = ROW_COUNT;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      v_n := -1;
    END;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S822 5b probe: the Owner could not delete an open order with an unsent line (% row(s)): %', v_n, COALESCE(v_msg, 'no error');
    END IF;

    -- (b) A2: an open order with a points line is refused for the points line, not as a closed bill.
    v_hint := NULL; v_msg := NULL;
    BEGIN
      DELETE FROM public.pos_orders WHERE id = v_open2;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_payment_line_locked' THEN
      RAISE EXCEPTION 'S822 5b probe: deleting an open order with a points line answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;

    -- (c) The closed bill stays locked: its lines, its payment lines (if it has any) and the bill.
    IF v_billed IS NULL THEN
      RAISE EXCEPTION 'S822 5b probe: no closed bill with lines at the chosen outlet';
    END IF;
    v_hint := NULL; v_msg := NULL;
    BEGIN
      DELETE FROM public.pos_order_items WHERE order_id = v_billed;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'bill_locked' THEN
      RAISE EXCEPTION 'S822 5b probe: deleting a closed bill''s lines answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;
    IF EXISTS (SELECT 1 FROM public.pos_order_payments WHERE order_id = v_billed) THEN
      v_hint := NULL; v_msg := NULL;
      BEGIN
        DELETE FROM public.pos_order_payments WHERE order_id = v_billed;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      END;
      IF v_hint IS DISTINCT FROM 'bill_locked' THEN
        RAISE EXCEPTION 'S822 5b probe: deleting a closed bill''s payment lines answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
      END IF;
    END IF;
    v_hint := NULL; v_msg := NULL;
    BEGIN
      DELETE FROM public.pos_orders WHERE id = v_billed;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'bill_locked' THEN
      RAISE EXCEPTION 'S822 5b probe: deleting a closed bill answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;

    -- (d) 4g: a phone change is refused, and the sentence names Move.
    v_hint := NULL; v_msg := NULL;
    BEGIN
      UPDATE public.pos_customers SET phone = '9100000823' WHERE id = v_cust;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_customer_phone_locked' OR v_msg NOT LIKE '%Move to a new number%' THEN
      RAISE EXCEPTION 'S822 5b probe: a phone change answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;

    -- (e) Called as an RPC, the lookup answers true for a bill that does not exist.
    IF NOT public.pos_orders_still_exist(ARRAY[gen_random_uuid()]) THEN
      RAISE EXCEPTION 'S822 5b probe: the lookup answered a browser outside a trigger';
    END IF;

    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    IF EXISTS (SELECT 1 FROM public.pos_order_items WHERE order_id = v_open1) THEN
      RAISE EXCEPTION 'S822 5b probe: the deleted open order left its line behind';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.pos_orders WHERE id = v_open2)
       OR NOT EXISTS (SELECT 1 FROM public.pos_orders WHERE id = v_billed)
       OR NOT EXISTS (SELECT 1 FROM public.pos_order_items WHERE order_id = v_billed) THEN
      RAISE EXCEPTION 'S822 5b probe: a refused delete removed something';
    END IF;

    -- (f) A2: a guest on the booking page. Six requests from one Cloudflare address, each claiming a
    -- different first hop: five are taken and the sixth meets the limit (the old key let all six in).
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    FOR i IN 1..6 LOOP
      PERFORM set_config('request.headers', json_build_object(
          'cf-connecting-ip', '203.0.113.222',
          'x-forwarded-for', '198.51.100.' || i || ',203.0.113.222')::text, true);
      SET LOCAL ROLE anon;
      v_res := public.submit_reservation_request(v_client, 'S822 5b probe ' || i, '91000082' || lpad(i::text, 2, '0'), 2, v_when, NULL, NULL);
      RESET ROLE;
      IF i <= 5 AND NOT COALESCE((v_res->>'ok')::boolean, false) THEN
        RAISE EXCEPTION 'S822 5b probe: request % from a fresh address was refused: %', i, v_res;
      END IF;
      IF i = 6 AND v_res->>'code' IS DISTINCT FROM 'rate' THEN
        RAISE EXCEPTION 'S822 5b probe: a sixth request behind a made-up first hop was answered %', v_res;
      END IF;
    END LOOP;
    SELECT count(*) INTO v_n FROM public.pos_reservation_request_attempts
     WHERE client_id = v_client AND ip = '203.0.113.222';
    IF v_n <> 6 THEN
      RAISE EXCEPTION 'S822 5b probe: % attempts were counted against the Cloudflare address, not 6', v_n;
    END IF;

    -- (g) No cf-connecting-ip: the last hop of x-forwarded-for, the one Cloudflare appends.
    PERFORM set_config('request.headers', '{"x-forwarded-for":"198.51.100.9, 203.0.113.223"}', true);
    SET LOCAL ROLE anon;
    v_res := public.submit_reservation_request(v_client, 'S822 5b probe 7', '9100008207', 2, v_when, NULL, NULL);
    RESET ROLE;
    SELECT ip INTO v_ip FROM public.pos_reservation_request_attempts
     WHERE client_id = v_client AND phone_canonical = '9100008207';
    IF v_ip IS DISTINCT FROM '203.0.113.223' THEN
      RAISE EXCEPTION 'S822 5b probe: with no cf-connecting-ip the key was % (%)', v_ip, v_res;
    END IF;

    -- (h) IPv6 counts as its /64.
    PERFORM set_config('request.headers', '{"cf-connecting-ip":"2001:db8:822:1:aaaa::1","x-forwarded-for":"2001:db8:822:1:aaaa::1"}', true);
    SET LOCAL ROLE anon;
    v_res := public.submit_reservation_request(v_client, 'S822 5b probe 8', '9100008208', 2, v_when, NULL, NULL);
    RESET ROLE;
    SELECT ip INTO v_ip FROM public.pos_reservation_request_attempts
     WHERE client_id = v_client AND phone_canonical = '9100008208';
    IF v_ip IS DISTINCT FROM '2001:db8:822:1::/64' THEN
      RAISE EXCEPTION 'S822 5b probe: an IPv6 address was keyed as % (%)', v_ip, v_res;
    END IF;

    -- (i) No headers at all: 'unknown', as before.
    PERFORM set_config('request.headers', '', true);
    SET LOCAL ROLE anon;
    v_res := public.submit_reservation_request(v_client, 'S822 5b probe 9', '9100008209', 2, v_when, NULL, NULL);
    RESET ROLE;
    SELECT ip INTO v_ip FROM public.pos_reservation_request_attempts
     WHERE client_id = v_client AND phone_canonical = '9100008209';
    IF v_ip IS DISTINCT FROM 'unknown' THEN
      RAISE EXCEPTION 'S822 5b probe: with no headers the key was % (%)', v_ip, v_res;
    END IF;
    PERFORM set_config('request.jwt.claims', '', true);

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's822_5b_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's822_5b_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;


-- ── 6. What this slice acts on, live (the last statement, so `db query` prints it) ────────────
SELECT
  (SELECT count(*) FROM public.pos_orders WHERE status = 'open') AS open_bills,
  (SELECT count(*) FROM public.pos_reservation_request_attempts WHERE created_at > now() - interval '30 days') AS booking_attempts_30d,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.submit_reservation_request(uuid, text, text, integer, timestamptz, text, text)'::regprocedure) AS booking_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_order_items_closed()'::regprocedure) AS items_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_order_payments_closed()'::regprocedure) AS payments_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_customers_guard_loyalty()'::regprocedure) AS customers_md5,
  has_function_privilege('anon', 'public.pos_orders_still_exist(uuid[])', 'EXECUTE') AS lookup_anon,
  has_function_privilege('authenticated', 'public.pos_orders_still_exist(uuid[])', 'EXECUTE') AS lookup_authenticated;

-- Read back after applying (one statement per call):
--   SELECT p.proname, md5(prosrc), prosecdef, proacl FROM pg_proc p
--    WHERE p.oid IN ('public.submit_reservation_request(uuid, text, text, integer, timestamptz, text, text)'::regprocedure,
--                    'public.guard_pos_order_items_closed()'::regprocedure, 'public.guard_pos_order_payments_closed()'::regprocedure,
--                    'public.pos_customers_guard_loyalty()'::regprocedure, 'public.pos_orders_still_exist(uuid[])'::regprocedure);
--     expect the second hash of each in section 0, prosecdef t / f / f / f / t, the first four's proacl as before.
