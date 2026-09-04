-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Table reservations for Crest POS (S677).
--
-- Until now the only trace of a booking in the product was pos_tables.status = 'reserved' — a
-- label a manager set by hand, with no guest, date, time, party size or expiry behind it. This
-- adds the reservation as a record of its own: a promise about a future table, kept in its own
-- table and DERIVED onto the floor plan, never written back into pos_tables.status (that column
-- already drifts against open orders; a second writer would make it worse).
--
-- Three things a reader should know before touching this:
--
--   1. Seating is the handoff. When a host seats a party from the floor, PosOrders.jsx opens the
--      order with covers = party_size and writes order_id + status 'seated' here; closing the bill
--      marks it 'completed'. The link lives on the RESERVATION, not as a new column on the
--      hot-path pos_orders table (feedback: never reference a not-yet-migrated column in the menu
--      load / order save path).
--   2. The public booking page (/pos/book/:clientId) writes through submit_reservation_request()
--      below and nothing else — anon holds no grant on the table at all. A request lands as
--      status 'requested' and waits for a staff Accept; nothing self-confirms.
--   3. updated_at is maintained by a trigger — the FIRST in this schema (see supabase-sql.md,
--      "updated_at is not maintained by the database"). The edit modal writes many columns while
--      the status transitions stamp their own *_at, so a bare column here would be exactly the
--      pos_customers lie that rule documents.
-- ════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. The reservation ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pos_reservations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  customer_name    text NOT NULL CHECK (btrim(customer_name) <> ''),
  phone            text NOT NULL CHECK (btrim(phone) <> ''),
  -- Byte-for-byte the pos_customers expression (baseline :1068-1072), so a no-show count keyed on
  -- this column matches the customer book whichever way the number was typed.
  phone_canonical  text GENERATED ALWAYS AS (regexp_replace(
    CASE
      WHEN (regexp_replace(phone, '\D'::text, ''::text, 'g'::text) ~ '^977.{8,}'::text) THEN SUBSTRING(regexp_replace(phone, '\D'::text, ''::text, 'g'::text) FROM 4)
      ELSE regexp_replace(phone, '\D'::text, ''::text, 'g'::text)
    END, '^0+'::text, ''::text)) STORED,
  party_size       integer NOT NULL CHECK (party_size BETWEEN 1 AND 99),
  reserved_for     timestamptz NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 90 CHECK (duration_minutes BETWEEN 15 AND 720),
  -- 'requested' is the public page's state; staff-entered bookings start at 'booked'.
  status           text NOT NULL DEFAULT 'booked'
                   CHECK (status IN ('requested','booked','confirmed','arrived','seated','completed','no_show','cancelled')),
  source           text NOT NULL DEFAULT 'phone'
                   CHECK (source IN ('phone','walk_in','whatsapp','facebook','instagram','website','other')),
  occasion         text,
  notes            text,
  cancel_reason    text,
  -- Set on seat. SET NULL rather than CASCADE: Danger Zone and the admin "Clear Occupied" delete
  -- orders, and the booking should survive that as a record of the visit having happened.
  order_id         uuid REFERENCES public.pos_orders(id) ON DELETE SET NULL,
  confirmed_at     timestamptz,
  arrived_at       timestamptz,
  seated_at        timestamptz,
  completed_at     timestamptz,
  no_show_at       timestamptz,
  cancelled_at     timestamptz,
  created_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- "Seated" MEANS "has a bill". A row that says seated with no order is the one shape the
  -- Covers Report's booked-vs-walk-in split cannot read, so the database refuses it.
  CONSTRAINT pos_reservations_seated_has_order  CHECK (status <> 'seated'    OR order_id IS NOT NULL),
  -- The UI promises a reason on every cancel; this is what keeps a direct PATCH honest too.
  CONSTRAINT pos_reservations_cancel_has_reason CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);

-- A party can span tables (a birthday across three four-tops is ordinary here), so the
-- assignment is a join table rather than a single table_id. Surrogate id because the export walks
-- every table ordered by `id`. A deleted table takes its join rows with it and leaves the
-- reservation UNASSIGNED — it survives and shows in the floor's unassigned list.
CREATE TABLE IF NOT EXISTS public.pos_reservation_tables (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES public.pos_reservations(id) ON DELETE CASCADE,
  table_id       uuid NOT NULL REFERENCES public.pos_tables(id) ON DELETE CASCADE,
  UNIQUE (reservation_id, table_id)
);

-- ── 2. Indexes — each one is a query the app actually runs ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pos_reservations_client_reserved_for
  ON public.pos_reservations (client_id, reserved_for);
-- The floor's 60 s poll: today's live bookings only.
CREATE INDEX IF NOT EXISTS idx_pos_reservations_live
  ON public.pos_reservations (client_id, reserved_for)
  WHERE status IN ('requested','booked','confirmed','arrived','seated');
-- closeOrder's completion write filters on order_id.
CREATE INDEX IF NOT EXISTS idx_pos_reservations_order_id
  ON public.pos_reservations (order_id) WHERE order_id IS NOT NULL;
-- The booking modal's "prior no-shows for this phone" and the Customers column.
CREATE INDEX IF NOT EXISTS idx_pos_reservations_phone
  ON public.pos_reservations (client_id, phone_canonical);
-- One pending public request per phone per outlet, enforced race-free the way
-- pos_guest_order_requests_one_pending_per_table is (20260713015814).
CREATE UNIQUE INDEX IF NOT EXISTS pos_reservations_one_request_per_phone
  ON public.pos_reservations (client_id, phone_canonical) WHERE status = 'requested';

CREATE INDEX IF NOT EXISTS idx_pos_reservation_tables_reservation_id ON public.pos_reservation_tables (reservation_id);
CREATE INDEX IF NOT EXISTS idx_pos_reservation_tables_table_id       ON public.pos_reservation_tables (table_id);
CREATE INDEX IF NOT EXISTS idx_pos_reservation_tables_client_id      ON public.pos_reservation_tables (client_id);

-- ── 3. updated_at, actually maintained ──────────────────────────────────────────────────────
-- A trigger function needs no grant (EXECUTE is checked at CREATE TRIGGER time, never at fire
-- time — guard_pos_order_close has run on every bill close holding none), so REVOKE and stop.
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public'
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.touch_updated_at() FROM PUBLIC;

DROP TRIGGER IF EXISTS pos_reservations_touch ON public.pos_reservations;
CREATE TRIGGER pos_reservations_touch
  BEFORE UPDATE ON public.pos_reservations
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 4. Settings ─────────────────────────────────────────────────────────────────────────────
-- One jsonb: duration_by_band, arrival_grace_minutes, seat_window_minutes, whatsapp_template,
-- public_booking_enabled, max_party_online, min_lead_minutes. Edited on Table Management →
-- Reservations. settings has been same-client writable since S290.
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS pos_reservation_settings jsonb;

-- ── 5. RLS ──────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.pos_reservations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_reservation_tables ENABLE ROW LEVEL SECURITY;

-- One permissive FOR ALL per table (supabase-sql.md: one permissive policy per command), the
-- same-client-or-admin shape as pos_loyalty_schemes, (select auth.uid()) wrapped.
DROP POLICY IF EXISTS pos_reservations_client ON public.pos_reservations;
CREATE POLICY pos_reservations_client ON public.pos_reservations
  TO authenticated
  USING (
    client_id = (SELECT profiles.client_id FROM public.profiles WHERE profiles.id = (SELECT auth.uid()))
    OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin'
  )
  WITH CHECK (
    client_id = (SELECT profiles.client_id FROM public.profiles WHERE profiles.id = (SELECT auth.uid()))
    OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin'
  );

DROP POLICY IF EXISTS pos_reservation_tables_client ON public.pos_reservation_tables;
CREATE POLICY pos_reservation_tables_client ON public.pos_reservation_tables
  TO authenticated
  USING (
    client_id = (SELECT profiles.client_id FROM public.profiles WHERE profiles.id = (SELECT auth.uid()))
    OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin'
  )
  WITH CHECK (
    client_id = (SELECT profiles.client_id FROM public.profiles WHERE profiles.id = (SELECT auth.uid()))
    OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin'
  );

-- Staff-account isolation, the same trio every pos_* business table carries. POS PIN staff are
-- deliberately NOT fenced out: the host stand is a waiter or cashier, and the book holds no money.
DROP POLICY IF EXISTS no_self_service_accounts ON public.pos_reservations;
DROP POLICY IF EXISTS no_ims_staff             ON public.pos_reservations;
DROP POLICY IF EXISTS no_hr_role_staff         ON public.pos_reservations;
CREATE POLICY no_self_service_accounts ON public.pos_reservations AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service());
CREATE POLICY no_ims_staff ON public.pos_reservations AS RESTRICTIVE FOR ALL
  USING (NOT public.is_ims_staff()) WITH CHECK (NOT public.is_ims_staff());
CREATE POLICY no_hr_role_staff ON public.pos_reservations AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff());

DROP POLICY IF EXISTS no_self_service_accounts ON public.pos_reservation_tables;
DROP POLICY IF EXISTS no_ims_staff             ON public.pos_reservation_tables;
DROP POLICY IF EXISTS no_hr_role_staff         ON public.pos_reservation_tables;
CREATE POLICY no_self_service_accounts ON public.pos_reservation_tables AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service());
CREATE POLICY no_ims_staff ON public.pos_reservation_tables AS RESTRICTIVE FOR ALL
  USING (NOT public.is_ims_staff()) WITH CHECK (NOT public.is_ims_staff());
CREATE POLICY no_hr_role_staff ON public.pos_reservation_tables AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff());

-- Raw-SQL tables get NO role grants in this project by default — a missing GRANT reads as an RLS
-- failure. authenticated needs the full set: the restore path (restoreClientData.js) inserts
-- through the browser as `authenticated`, and staff edit/cancel from the page.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pos_reservations       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pos_reservation_tables TO authenticated;
GRANT ALL ON public.pos_reservations       TO service_role;
GRANT ALL ON public.pos_reservation_tables TO service_role;
-- Belt and braces — 20260720160000 stripped anon's base grants, but say it here so the intent
-- is on this table's own record: the public page reaches this data through the RPCs only.
REVOKE ALL ON public.pos_reservations       FROM anon;
REVOKE ALL ON public.pos_reservation_tables FROM anon;

-- ── 6. The public booking page's abuse counter ──────────────────────────────────────────────
-- The trial_signup_attempts shape: no policies, no anon/authenticated grants, written only by a
-- SECURITY DEFINER function. Holds the caller's network address, so a browser must never read it.
-- Not client-scoped for scopedDb / Danger Zone purposes — rows are pruned by age, not by tenant:
--   DELETE FROM public.pos_reservation_request_attempts WHERE created_at < now() - interval '7 days';
CREATE TABLE IF NOT EXISTS public.pos_reservation_request_attempts (
  id              bigserial PRIMARY KEY,
  client_id       uuid NOT NULL,
  ip              text,
  phone_canonical text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pos_reservation_request_attempts_client
  ON public.pos_reservation_request_attempts (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_reservation_request_attempts_ip
  ON public.pos_reservation_request_attempts (client_id, ip, created_at DESC);
ALTER TABLE public.pos_reservation_request_attempts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON public.pos_reservation_request_attempts TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.pos_reservation_request_attempts_id_seq TO service_role;

-- ── 7. The three public RPCs ────────────────────────────────────────────────────────────────
-- Same anonymous-caller pattern as get_guest_menu / submit_guest_order: SECURITY DEFINER because
-- an anonymous caller has no RLS-passing identity at all, deliberately NOT revoked from PUBLIC
-- because anon is the intended caller, and every guard wrapped in COALESCE(..., false) because
-- a NULL from a missing row falls OPEN through IF NOT (S630).

-- What the page needs to render, and nothing else. Returns no row unless the outlet has POS and
-- has switched online booking on — an outlet with the toggle off is indistinguishable from one
-- that does not exist.
DROP FUNCTION IF EXISTS public.get_booking_page(uuid);
CREATE FUNCTION public.get_booking_page(p_client_id uuid) RETURNS TABLE(
  outlet_name text, open_time text, close_time text,
  max_party_online integer, min_lead_minutes integer, max_days_ahead integer
) LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
DECLARE
  v_pos_enabled boolean;
  v_name text;
  v_settings jsonb;
  v_open text;
  v_close text;
BEGIN
  SELECT c.pos_enabled, c.name INTO v_pos_enabled, v_name FROM clients c WHERE c.id = p_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RETURN; END IF;

  SELECT s.pos_reservation_settings, s.pos_open_time, s.pos_close_time
    INTO v_settings, v_open, v_close
  FROM settings s WHERE s.client_id = p_client_id LIMIT 1;
  IF NOT COALESCE((v_settings->>'public_booking_enabled')::boolean, false) THEN RETURN; END IF;

  RETURN QUERY SELECT
    v_name, v_open, v_close,
    COALESCE((v_settings->>'max_party_online')::integer, 20),
    COALESCE((v_settings->>'min_lead_minutes')::integer, 60),
    14;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_booking_page(uuid) TO anon, authenticated, service_role;

-- A guest submits a request. Returns jsonb rather than raising for the refusals that SHOULD cost
-- quota: an exception rolls back the attempt row along with everything else, so a refused
-- request would burn nothing and the cheapest attack would be to keep getting refused
-- (20260810170000's lesson, which an Edge Function could apply across two requests and a single
-- SQL transaction cannot). Shape: {"ok": true, "id": uuid} or {"ok": false, "code": text,
-- "message": text}. The message is written for the guest and is safe to render as-is.
DROP FUNCTION IF EXISTS public.submit_reservation_request(uuid, text, text, integer, timestamptz, text, text);
CREATE FUNCTION public.submit_reservation_request(
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
  v_ip text;
  v_ip_count integer;
  v_client_count integer;
  v_band text;
  v_duration integer;
  v_id uuid;
BEGIN
  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = p_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'closed', 'message', 'Online booking is not available for this restaurant.');
  END IF;

  SELECT s.pos_reservation_settings, s.pos_open_time, s.pos_close_time
    INTO v_settings, v_open, v_close
  FROM settings s WHERE s.client_id = p_client_id LIMIT 1;
  IF NOT COALESCE((v_settings->>'public_booking_enabled')::boolean, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'closed', 'message', 'Online booking is not available for this restaurant.');
  END IF;
  v_max_party := COALESCE((v_settings->>'max_party_online')::integer, 20);
  v_lead      := COALESCE((v_settings->>'min_lead_minutes')::integer, 60);

  -- Validation. Cheap refusals that carry no quota — they never reach the insert.
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
      format('Online bookings are for 1 to %s guests. For a larger party, please call the restaurant.', v_max_party));
  END IF;
  IF p_reserved_for IS NULL OR p_reserved_for < now() + make_interval(mins => v_lead) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'too_soon', 'message',
      format('Please book at least %s minutes ahead, or call the restaurant for a table right now.', v_lead));
  END IF;
  IF p_reserved_for > now() + interval '14 days' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'too_far', 'message', 'Online booking is open up to 14 days ahead.');
  END IF;
  -- Opening hours, read in Nepal's clock — the settings pair is typed as "HH:MM" and compares as text.
  v_hm := to_char(p_reserved_for AT TIME ZONE 'Asia/Kathmandu', 'HH24:MI');
  IF COALESCE(v_open, '') <> '' AND COALESCE(v_close, '') <> '' THEN
    IF v_open <= v_close THEN
      IF v_hm < v_open OR v_hm > v_close THEN
        RETURN jsonb_build_object('ok', false, 'code', 'hours', 'message', format('We take bookings between %s and %s.', v_open, v_close));
      END IF;
    ELSE
      -- Overnight hours (e.g. 17:00 → 02:00): closed only in the gap between close and open.
      IF v_hm > v_close AND v_hm < v_open THEN
        RETURN jsonb_build_object('ok', false, 'code', 'hours', 'message', format('We take bookings between %s and %s.', v_open, v_close));
      END IF;
    END IF;
  END IF;

  -- Rate limit, recorded BEFORE the insert. PostgREST exposes the request headers as a GUC;
  -- x-forwarded-for is the client's address as the edge saw it (first hop when there are several).
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
    RETURN jsonb_build_object('ok', false, 'code', 'rate', 'message', 'Too many booking requests from this connection. Please call the restaurant instead.');
  END IF;
  SELECT count(*) INTO v_client_count FROM pos_reservation_request_attempts
    WHERE client_id = p_client_id AND created_at > now() - interval '1 hour';
  IF v_client_count > 40 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'rate', 'message', 'Online booking is busy right now. Please call the restaurant instead.');
  END IF;

  -- Expected duration from the outlet's own per-band setting (measured turn times), so the
  -- capacity strip on the staff page sees the request the same way it sees a staff booking.
  v_band := CASE WHEN p_party_size <= 2 THEN '1-2' WHEN p_party_size <= 4 THEN '3-4' WHEN p_party_size <= 6 THEN '5-6' ELSE '7+' END;
  v_duration := COALESCE((v_settings->'duration_by_band'->>v_band)::integer, 90);
  v_duration := LEAST(GREATEST(v_duration, 15), 720);

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
    RETURN jsonb_build_object('ok', false, 'code', 'pending', 'message', 'You already have a booking request waiting for the restaurant to confirm.');
  END;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.submit_reservation_request(uuid, text, text, integer, timestamptz, text, text) TO anon, authenticated, service_role;

-- The guest's own request, scoped solely by its unguessable id (the get_guest_order_request_status
-- shape). Only website-sourced rows, only the columns the status card renders.
DROP FUNCTION IF EXISTS public.get_reservation_request_status(uuid);
CREATE FUNCTION public.get_reservation_request_status(p_request_id uuid) RETURNS TABLE(
  status text, reserved_for timestamptz, party_size integer, outlet_name text, cancel_reason text
) LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
  SELECT r.status, r.reserved_for, r.party_size, c.name, r.cancel_reason
  FROM pos_reservations r JOIN clients c ON c.id = r.client_id
  WHERE r.id = p_request_id AND r.source = 'website';
$$;
GRANT EXECUTE ON FUNCTION public.get_reservation_request_status(uuid) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── Verification (run after applying; assert on catalog columns, never on formatted strings) ──
-- SELECT polname, polpermissive FROM pg_policy WHERE polrelid = 'public.pos_reservations'::regclass;
--   -- expect 4 rows: pos_reservations_client (permissive) + three restrictive
-- SELECT polname FROM pg_policy WHERE polrelid = 'public.pos_reservation_tables'::regclass;   -- 4 rows
-- SELECT has_table_privilege('anon', 'public.pos_reservations', 'SELECT');                     -- false
-- SELECT has_table_privilege('authenticated', 'public.pos_reservation_request_attempts', 'SELECT'); -- false
-- SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.pos_reservations'::regclass AND NOT tgisinternal; -- pos_reservations_touch
-- SELECT has_function_privilege('anon', 'public.submit_reservation_request(uuid,text,text,integer,timestamptz,text,text)', 'EXECUTE'); -- true, by design
-- SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
--   WHERE i.indrelid = 'public.pos_reservations'::regclass;  -- client_id ×4 (plus order_id, id)
