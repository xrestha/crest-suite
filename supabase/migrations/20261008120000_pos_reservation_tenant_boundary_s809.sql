-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 1, slice 1a: a booking, its tables and its bill belong to one outlet.
--
--   RESERVATIONS-1 (P0). A login at any other Crest outlet, including a self-signup trial nobody
--   has approved, could link a booking of its own to this outlet's table. The link row's policy
--   checks only the row's own client_id, and both foreign keys checked only that the ids exist.
--   guard_pos_reservation_table_hold is SECURITY DEFINER and matched bookings by table with no
--   client test, so its refusal named this outlet's guest, party size, time and booking id. A link
--   that landed blocked this outlet from holding its own table, by a hold it could neither see nor
--   remove. Table ids are printed in the guest QR, so they are no secret.
--
--   Closed three ways:
--     (1) the guard compares bookings of the link's own outlet only, and its DETAIL no longer
--         carries the other booking's id (describeHoldRefusal never read it);
--     (2) a link must name a booking AND a table of its own outlet: UNIQUE (id, client_id) on
--         pos_reservations and pos_tables, and the two foreign keys become composite, keeping their
--         names and ON DELETE CASCADE;
--     (3) a booking's order_id must be a bill of the same outlet. A trigger, because pos_orders has
--         no (id, client_id) key for a composite foreign key to point at.
--
--   RESERVATIONS-12 (P3). created_by was whatever the browser sent. It is now stamped from
--   auth.uid() on insert and kept on update, for every client session. The operator keeps what it
--   sends, because restoreClientData re-inserts a client's history with its original authors.
--
-- Built on the LIVE body of guard_pos_reservation_table_hold (md5(prosrc) read 2026-10-08,
-- identical to 20260917100000). Live before this migration: 8 bookings, 1 table link, 0 links and
-- 0 order ids crossing outlets, so every new constraint validates.
--
-- The probe at the end runs as a real Owner login inside a block that rolls itself back. If any
-- check fails, the whole migration fails and nothing here lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 1. A link names a booking and a table of its own outlet ────────────────────────────────
--
-- The three app embeds (pos_reservations → pos_reservation_tables, in PosOrders, ReservationModal
-- and reservationStatus) still resolve: there is still exactly one foreign key between the two
-- tables, now joining on (reservation_id, client_id). ON UPDATE stays NO ACTION, so a booking or a
-- table cannot change outlet while a link points at it.
ALTER TABLE public.pos_reservation_tables
  DROP CONSTRAINT IF EXISTS pos_reservation_tables_reservation_id_fkey,
  DROP CONSTRAINT IF EXISTS pos_reservation_tables_table_id_fkey;

ALTER TABLE public.pos_reservations DROP CONSTRAINT IF EXISTS pos_reservations_id_client_id_key;
ALTER TABLE public.pos_reservations ADD CONSTRAINT pos_reservations_id_client_id_key UNIQUE (id, client_id);
ALTER TABLE public.pos_tables DROP CONSTRAINT IF EXISTS pos_tables_id_client_id_key;
ALTER TABLE public.pos_tables ADD CONSTRAINT pos_tables_id_client_id_key UNIQUE (id, client_id);

ALTER TABLE public.pos_reservation_tables
  ADD CONSTRAINT pos_reservation_tables_reservation_id_fkey
    FOREIGN KEY (reservation_id, client_id) REFERENCES public.pos_reservations (id, client_id) ON DELETE CASCADE,
  ADD CONSTRAINT pos_reservation_tables_table_id_fkey
    FOREIGN KEY (table_id, client_id) REFERENCES public.pos_tables (id, client_id) ON DELETE CASCADE;


-- ── 2. The hold guard reads its own outlet only ────────────────────────────────────────────
--
-- After section 1 every link already shares its booking's and its table's client, so the client
-- conditions below are true of every row that can exist. They stay anyway: this function is
-- SECURITY DEFINER, owned by a BYPASSRLS role, and its refusal prints a guest's name. Its read
-- must not depend on a constraint defined somewhere else.
CREATE OR REPLACE FUNCTION public.guard_pos_reservation_table_hold()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_ids   uuid[];
  v_table uuid;
  v_hit   record;
BEGIN
  IF TG_TABLE_NAME = 'pos_reservation_tables' THEN
    -- The operator's restore re-inserts a client's history as it was. A backup taken before this
    -- trigger can carry two stale 'booked' rows that overlap, and restoreClientData drops a whole
    -- table on its first failing chunk — every booking's tables, not only the pair.
    IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) THEN
      RETURN NULL;
    END IF;
    SELECT array_agg(DISTINCT n.reservation_id) INTO v_ids FROM new_rows n;
  ELSE
    -- pos_reservations: only a write that moves a LIVE booking's window, or brings one back to life.
    SELECT array_agg(n.id) INTO v_ids
      FROM new_rows n
      JOIN old_rows o ON o.id = n.id
     WHERE public.pos_reservation_is_live(n.status)
       AND (n.reserved_for     IS DISTINCT FROM o.reserved_for
         OR n.duration_minutes IS DISTINCT FROM o.duration_minutes
         OR NOT public.pos_reservation_is_live(o.status));
  END IF;

  IF v_ids IS NULL THEN
    RETURN NULL;
  END IF;

  FOR v_table IN
    SELECT DISTINCT rt.table_id
      FROM pos_reservation_tables rt
      JOIN pos_reservations r ON r.id = rt.reservation_id AND r.client_id = rt.client_id
     WHERE rt.reservation_id = ANY (v_ids)
       AND public.pos_reservation_is_live(r.status)
     ORDER BY rt.table_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('pos_table_hold:' || v_table::text, 0));
  END LOOP;

  -- S809: every join is held to the booking's own outlet (RESERVATIONS-1).
  SELECT mt.table_id, t.name AS table_name,
         o.customer_name, o.party_size, o.reserved_for, o.duration_minutes
    INTO v_hit
    FROM pos_reservations me
    JOIN pos_reservation_tables mt ON mt.reservation_id = me.id AND mt.client_id = me.client_id
    JOIN pos_reservation_tables ot ON ot.table_id = mt.table_id AND ot.reservation_id <> me.id
                                  AND ot.client_id = me.client_id
    JOIN pos_reservations o        ON o.id = ot.reservation_id AND o.client_id = me.client_id
    LEFT JOIN pos_tables t         ON t.id = mt.table_id AND t.client_id = me.client_id
   WHERE me.id = ANY (v_ids)
     AND public.pos_reservation_is_live(me.status)
     AND public.pos_reservation_is_live(o.status)
     AND me.reserved_for < o.reserved_for  + make_interval(mins => o.duration_minutes)
     AND o.reserved_for  < me.reserved_for + make_interval(mins => me.duration_minutes)
   ORDER BY o.reserved_for, o.id
   LIMIT 1;

  IF FOUND THEN
    -- The DETAIL is structured so the page can word it with its own clock and calendar
    -- (reservationConflicts.describeHoldRefusal); the message is the fallback, in Nepal time.
    -- S809: no booking id. Nothing reads it, and an id is the key to get_reservation_request_status.
    RAISE EXCEPTION 'table_hold_overlap: % is already held for % ×% at % on % (Nepal time) — pick another table or change the time',
      COALESCE(v_hit.table_name, 'This table'), v_hit.customer_name, v_hit.party_size,
      to_char(v_hit.reserved_for AT TIME ZONE 'Asia/Kathmandu', 'FMHH12:MI AM'),
      to_char(v_hit.reserved_for AT TIME ZONE 'Asia/Kathmandu', 'YYYY-MM-DD')
      USING ERRCODE = '23P01', HINT = 'table_hold_overlap',
            DETAIL = jsonb_build_object(
              'table_id', v_hit.table_id, 'table_name', v_hit.table_name,
              'customer_name', v_hit.customer_name,
              'party_size', v_hit.party_size, 'reserved_for', v_hit.reserved_for,
              'duration_minutes', v_hit.duration_minutes)::text;
  END IF;

  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.guard_pos_reservation_table_hold() FROM PUBLIC;


-- ── 3. A booking points only at a bill of its own outlet ───────────────────────────────────
--
-- order_id is written when a booking is seated at the till (PosOrders) and set NULL by the foreign key
-- when the bill is deleted. SECURITY DEFINER so the lookup sees the bill whatever the caller's RLS
-- view of pos_orders is (the S749 lesson: a guard whose read is narrower than its target refuses or
-- passes by accident). It answers only "same outlet or not", and it is a trigger function, so
-- PostgREST cannot serve it as an RPC. No exemption: the operator's restore writes consistent rows.
CREATE OR REPLACE FUNCTION public.pos_reservations_guard_order_client()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NEW.order_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM pos_orders o WHERE o.id = NEW.order_id AND o.client_id = NEW.client_id) THEN
    RAISE EXCEPTION 'reservation_order_other_client: a booking can only be seated on a bill of its own outlet'
      USING ERRCODE = '23503', HINT = 'reservation_order_other_client';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.pos_reservations_guard_order_client() FROM PUBLIC;

DROP TRIGGER IF EXISTS pos_reservations_guard_order_client ON public.pos_reservations;
CREATE TRIGGER pos_reservations_guard_order_client
  BEFORE INSERT OR UPDATE OF order_id, client_id ON public.pos_reservations
  FOR EACH ROW EXECUTE FUNCTION public.pos_reservations_guard_order_client();


-- ── 4. Who took a booking is the login that saved it (RESERVATIONS-12) ─────────────────────
--
-- SECURITY INVOKER on purpose: current_user is then the caller's role, so the service role and
-- every SECURITY DEFINER body pass untouched, as in guard_profiles_privileged_columns(). That
-- includes submit_reservation_request (a guest's request has no staff author and stays NULL) and
-- the foreign key's own SET NULL when a profile is deleted, which runs as the table owner.
-- The operator is exempt for the restore. Its own bookings from the till send its own id anyway.
CREATE OR REPLACE FUNCTION public.pos_reservations_stamp_created_by()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := auth.uid();
  ELSE
    NEW.created_by := OLD.created_by;
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.pos_reservations_stamp_created_by() FROM PUBLIC;

DROP TRIGGER IF EXISTS pos_reservations_stamp_created_by ON public.pos_reservations;
CREATE TRIGGER pos_reservations_stamp_created_by
  BEFORE INSERT OR UPDATE OF created_by ON public.pos_reservations
  FOR EACH ROW EXECUTE FUNCTION public.pos_reservations_stamp_created_by();


-- ── 5. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_client_att smallint;
  v_n          int;
  v_owner      uuid;
  v_a          uuid;
  v_b          uuid;
  v_other_prof uuid;
  v_order      uuid;
  v_order_cl   uuid;
  v_ta         uuid;
  v_tb         uuid;
  v_ra1        uuid;
  v_ra2        uuid;
  v_rb         uuid;
  v_ro         uuid;
  v_by         uuid;
  v_hint       text;
  v_detail     text;
  v_t          timestamptz := date_trunc('hour', now()) + interval '30 days';
BEGIN
  -- Catalog: both links are composite over client_id and still cascade. Asserted on catalog
  -- columns (conkey, confdeltype), never on formatted text.
  SELECT attnum INTO v_client_att FROM pg_attribute
   WHERE attrelid = 'public.pos_reservation_tables'::regclass AND attname = 'client_id';
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.pos_reservation_tables'::regclass AND contype = 'f'
     AND confrelid IN ('public.pos_reservations'::regclass, 'public.pos_tables'::regclass)
     AND array_length(conkey, 1) = 2 AND conkey @> ARRAY[v_client_att] AND confdeltype = 'c';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S809 1a: expected 2 composite, cascading links on pos_reservation_tables, found %', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.pos_reservation_tables'::regclass AND contype = 'f'
     AND confrelid IN ('public.pos_reservations'::regclass, 'public.pos_tables'::regclass);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S809 1a: % foreign keys from pos_reservation_tables to bookings/tables (a second one would make the app''s embeds ambiguous)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.pos_reservations'::regclass AND NOT tgisinternal AND tgenabled = 'O'
     AND tgname IN ('pos_reservations_guard_order_client', 'pos_reservations_stamp_created_by');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S809 1a: expected the order and created_by triggers on pos_reservations, found %', v_n;
  END IF;

  -- The caller: a POS outlet's Owner login, at the outlet it is working in.
  SELECT p.id, COALESCE(p.active_client_id, p.client_id) INTO v_owner, v_a
    FROM public.profiles p
    JOIN public.clients c ON c.id = COALESCE(p.active_client_id, p.client_id)
   WHERE p.role = 'client' AND c.pos_enabled
     AND p.pos_email IS NULL AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY p.id
   LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'S809 1a probe: no POS Owner login to test with';
  END IF;
  SELECT id INTO v_b FROM public.clients WHERE id <> v_a ORDER BY id LIMIT 1;
  SELECT id INTO v_other_prof FROM public.profiles WHERE id <> v_owner ORDER BY id LIMIT 1;
  SELECT id, client_id INTO v_order, v_order_cl FROM public.pos_orders ORDER BY id LIMIT 1;
  IF v_b IS NULL OR v_other_prof IS NULL OR v_order IS NULL THEN
    RAISE EXCEPTION 'S809 1a probe: needs a second client, a second profile and one bill (got %, %, %)', v_b, v_other_prof, v_order;
  END IF;

  BEGIN
    -- Setup, as the migration's own role: a table at each outlet, and the other outlet's booking
    -- holding its table at v_t.
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_a, 'S809 probe A') RETURNING id INTO v_ta;
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_b, 'S809 probe B') RETURNING id INTO v_tb;
    INSERT INTO public.pos_reservations (client_id, customer_name, phone, party_size, reserved_for, status, source)
      VALUES (v_b, 'Probe B guest', '9800000002', 6, v_t, 'booked', 'phone') RETURNING id INTO v_rb;
    INSERT INTO public.pos_reservation_tables (client_id, reservation_id, table_id) VALUES (v_b, v_rb, v_tb);

    -- Now as the Owner, through RLS and the INVOKER triggers.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF NOT COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'S809 1a probe: % is not an Owner login', v_owner;
    END IF;

    -- (a) created_by is the signed-in login, whatever the browser sends, and an update keeps it.
    INSERT INTO public.pos_reservations (client_id, customer_name, phone, party_size, reserved_for, status, source, created_by)
      VALUES (v_a, 'Probe A1', '9800000011', 2, v_t, 'booked', 'phone', v_other_prof)
      RETURNING id, created_by INTO v_ra1, v_by;
    IF v_by IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'S809 1a probe: created_by kept the sent % instead of the login %', v_by, v_owner;
    END IF;
    UPDATE public.pos_reservations SET created_by = v_other_prof WHERE id = v_ra1 RETURNING created_by INTO v_by;
    IF v_by IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'S809 1a probe: an update rewrote created_by to %', v_by;
    END IF;

    -- (b) this outlet's booking onto the other outlet's table, which that outlet holds at v_t:
    -- the old leak and the old block, now refused by the foreign key.
    BEGIN
      INSERT INTO public.pos_reservation_tables (client_id, reservation_id, table_id) VALUES (v_a, v_ra1, v_tb);
      RAISE EXCEPTION 'S809 1a probe: a link to another outlet''s table was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;

    -- (c) the other outlet's booking onto this outlet's table.
    BEGIN
      INSERT INTO public.pos_reservation_tables (client_id, reservation_id, table_id) VALUES (v_a, v_rb, v_ta);
      RAISE EXCEPTION 'S809 1a probe: a link from another outlet''s booking was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;

    -- (d) an overlap at the Owner's own outlet is still refused, names its own guest, and carries
    -- no booking id.
    INSERT INTO public.pos_reservations (client_id, customer_name, phone, party_size, reserved_for, status, source)
      VALUES (v_a, 'Probe A2', '9800000012', 4, v_t, 'booked', 'phone') RETURNING id INTO v_ra2;
    INSERT INTO public.pos_reservation_tables (client_id, reservation_id, table_id) VALUES (v_a, v_ra2, v_ta);
    BEGIN
      INSERT INTO public.pos_reservation_tables (client_id, reservation_id, table_id) VALUES (v_a, v_ra1, v_ta);
      RAISE EXCEPTION 'S809 1a probe: an overlapping hold at one outlet was accepted';
    EXCEPTION WHEN exclusion_violation THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_detail = PG_EXCEPTION_DETAIL;
      IF v_hint IS DISTINCT FROM 'table_hold_overlap'
         OR (v_detail::jsonb ? 'reservation_id')
         OR (v_detail::jsonb ->> 'customer_name') IS DISTINCT FROM 'Probe A2' THEN
        RAISE EXCEPTION 'S809 1a probe: the overlap refusal was hint %, detail %', v_hint, v_detail;
      END IF;
    END;

    -- Back to the migration's role for the bill and the cascades.
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);

    -- (e) a booking may point at a bill of its own outlet, and not at another outlet's.
    INSERT INTO public.pos_reservations (client_id, customer_name, phone, party_size, reserved_for, status, source, order_id)
      VALUES (v_order_cl, 'Probe O', '9800000013', 2, v_t + interval '1 day', 'booked', 'phone', v_order)
      RETURNING id INTO v_ro;
    BEGIN
      UPDATE public.pos_reservations SET order_id = v_order
       WHERE id = CASE WHEN v_order_cl = v_a THEN v_rb ELSE v_ra1 END;
      RAISE EXCEPTION 'S809 1a probe: a booking was pointed at another outlet''s bill';
    EXCEPTION WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'reservation_order_other_client' THEN
        RAISE EXCEPTION 'S809 1a probe: the bill refusal came with hint %', v_hint;
      END IF;
    END;

    -- (f) links still go with their booking and with their table.
    DELETE FROM public.pos_reservations WHERE id = v_ra2;
    SELECT count(*) INTO v_n FROM public.pos_reservation_tables WHERE reservation_id = v_ra2;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 1a probe: deleting a booking left % link(s)', v_n;
    END IF;
    DELETE FROM public.pos_tables WHERE id = v_tb;
    SELECT count(*) INTO v_n FROM public.pos_reservation_tables WHERE table_id = v_tb;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 1a probe: deleting a table left % link(s)', v_n;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_1a_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_1a_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT conname, confdeltype, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.pos_reservation_tables'::regclass AND contype = 'f';
--   SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.pos_reservations'::regclass AND NOT tgisinternal;
--   SELECT md5(prosrc) FROM pg_proc WHERE proname = 'guard_pos_reservation_table_hold';
