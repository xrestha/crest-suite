-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S854: a walk-in waitlist for Crest POS.
--
-- When every table is full, the host takes the party's name, phone and size, quotes a wait, and
-- calls them back when a table frees up. Until now that list lived on paper. Owner decisions
-- (S854, asked in plain words):
--   · the list lives ON THE FLOOR SCREEN (a "Waitlist (n)" button above the tables), not on a page
--     of its own;
--   · a party carries a name (required), a phone (optional), a party size and a quoted wait picked
--     from quick buttons (10 / 20 / 30 / 45 / 60 minutes); a row turns amber once the party has
--     waited longer than it was quoted;
--   · staff call the party back by WhatsApp or a phone call from the till (there is no SMS rail),
--     then Seat them (pick a table; the order opens with the party size as covers and the guest
--     name and phone filled in), or mark them Left, or Cancel the entry;
--   · any POS login of the outlet, staff rank and up, may use it: the list holds no money.
--
-- Why a table of its own and not pos_reservations: reserved_for is NOT NULL there, and the table-
-- hold guard, the conflict checks, the "Full" counts on the public booking page and the Covers
-- Report's booked-vs-walk-in split all assume a booked time window. A walk-in has none. Kept apart,
-- none of that machinery sees a waitlist party, and a party seated from the waitlist counts as a
-- WALK-IN on the Covers Report (its bill is not linked through pos_reservations.order_id).
--
-- What this file changes:
--   1. public.pos_waitlist, one row per party, with a partial index for the live list (waiting,
--      notified) and one on order_id for the bill's delete and the table join below.
--   2. RLS: one permissive FOR ALL policy on my_client_id() (never its body) and the restrictive
--      staff-isolation trio every pos_* business table carries (no HR Self-Service, no IMS staff, no
--      HR staff). POS PIN logins are deliberately NOT fenced out: the host stand is a waiter.
--   3. Grants: authenticated SELECT, INSERT, UPDATE (no DELETE: no screen deletes a party, a mistake
--      is a Cancel, and Danger Zone is the service role). Nothing for anon.
--   4. Triggers:
--      · pos_waitlist_guard (INVOKER, the current_user seam): a POS rank of staff or above
--        (pos_caller_has_rank, so a blocked or settled login is refused), a new party always starts
--        as waiting with no stamps, the status only moves forward (waiting -> notified -> seated /
--        left / cancelled), a seated / left / cancelled row is final, and notified_at / seated_at /
--        left_at / cancelled_at are stamped by the server on the move, never taken from the
--        browser. The operator restore (an admin INSERT dated before the transaction) keeps the row
--        as it was. A seated party whose bill is deleted under it (Clear Occupied, Danger Zone) goes
--        back to the list it came from, the same answer Clear Occupied gives a seated booking (D22),
--        because the CHECK below would otherwise refuse the bill delete.
--      · pos_waitlist_guard_order_client (DEFINER, mirrors pos_reservations_guard_order_client): a
--        party is seated only on a bill of its own outlet.
--      · pos_waitlist_stamp_created_by (INVOKER, mirrors pos_reservations_stamp_created_by): who
--        added the party is the login that saved it.
--      · pos_waitlist_touch: touch_updated_at(), the one updated_at trigger function.
--   5. join_pos_tables (S836) is patched from its LIVE body: when a table whose bill a waitlist
--      party was seated on is joined onto another bill, the party follows the bill, exactly as a
--      seated booking already does. Without it the absorbed bill's delete is refused by the CHECK
--      and every such join fails.
--
-- The till build floor is NOT raised for this. Nothing here changes what a till must send to
-- pos_orders or pos_order_items: the waitlist is its own table, the seat hand-off writes columns
-- pos_orders already has (covers, buyer name and phone), and an older till simply has no waitlist.
--
-- Not audited (log_audit): the list holds no money and turns over every service; the same choice
-- as pos_reservations. Not in pos_login_reference_columns by hand: created_by is a SET NULL key to
-- profiles, so that function's catalog read counts it on its own (POS Staff will Block, not Delete,
-- a login that added a party), and admin-user-ops' POS_RECORD_WORDS must word it
-- (posLoginRecords.test.js fails until it does).
--
-- Depends on it (app): src/modules/pos/waitlist/* (the panel, the hook, the API), the floor's
-- Waitlist button and Seat hand-off in PosOrders.jsx, src/shared/scopedDb.js CLIENT_SCOPED_TABLES,
-- restoreClientData.js RESTORE_ORDER (after pos_orders), admin-user-ops (delete sequences before
-- pos_orders, POS_RECORD_WORDS), then `supabase functions deploy admin-user-ops`. Apply this file
-- BEFORE the release that shows the button: until it is applied the panel says it cannot load.
--
-- To undo: re-run join_pos_tables from its live body with the one pos_waitlist line removed, then
-- DROP TABLE public.pos_waitlist (its triggers go with it) and DROP FUNCTION the three
-- pos_waitlist_* trigger functions. Safe at any time: nothing else reads the table.
-- ════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0. Pre-flight: every helper this file calls is already live ─────────────────────────────
DO $pre$
BEGIN
  IF to_regprocedure('public.my_client_id()') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.is_hr_self_service()') IS NULL
     OR to_regprocedure('public.is_ims_staff()') IS NULL
     OR to_regprocedure('public.is_hr_role_staff()') IS NULL
     OR to_regprocedure('public.pos_caller_has_rank(text)') IS NULL
     OR to_regprocedure('public.touch_updated_at()') IS NULL
     OR to_regprocedure('public.client_access_open(uuid)') IS NULL
     OR to_regprocedure('public.join_pos_tables(uuid,uuid,integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'S854 pre-flight: a helper this file calls is missing';
  END IF;
END;
$pre$;


-- ── 1. The waitlist ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pos_waitlist (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  -- Trimmed by the guard before this CHECK runs, so a name typed with spaces is kept, not refused.
  customer_name   text NOT NULL,
  phone           text,
  party_size      integer NOT NULL CHECK (party_size BETWEEN 1 AND 99),
  quoted_minutes  integer NOT NULL CHECK (quoted_minutes BETWEEN 1 AND 240),
  status          text NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting', 'notified', 'seated', 'left', 'cancelled')),
  notes           text,
  notified_at     timestamptz,
  seated_at       timestamptz,
  left_at         timestamptz,
  cancelled_at    timestamptz,
  -- Set on seat. SET NULL rather than CASCADE, as pos_reservations: Danger Zone and Clear Occupied
  -- delete bills, and the guard puts a seated party back on the list rather than losing the row.
  order_id        uuid REFERENCES public.pos_orders(id) ON DELETE SET NULL,
  created_by      uuid DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_waitlist_name_check
    CHECK (customer_name = btrim(customer_name) AND char_length(customer_name) BETWEEN 1 AND 80),
  CONSTRAINT pos_waitlist_phone_check
    CHECK (phone IS NULL OR char_length(phone) BETWEEN 1 AND 30),
  CONSTRAINT pos_waitlist_notes_check
    CHECK (notes IS NULL OR char_length(notes) <= 300),
  -- "Seated" MEANS "has a bill", the pos_reservations_seated_has_order idea: a seated row with no
  -- order is a party nobody can find on the floor.
  CONSTRAINT pos_waitlist_seated_has_order CHECK (status <> 'seated' OR order_id IS NOT NULL)
);

COMMENT ON TABLE public.pos_waitlist IS
  'S854: the walk-in waitlist on the POS floor. One row per party waiting for a table: name, optional phone, party size, the wait quoted. Status waiting -> notified -> seated / left / cancelled, stamped by the server; seated links the bill. Kept apart from pos_reservations, whose holds, conflicts, Full counts and Covers split assume a booked time.';

-- ── 2. Indexes, each one a query that runs ──────────────────────────────────────────────────
-- The floor's 30 s poll: this service day's live parties, oldest first.
CREATE INDEX IF NOT EXISTS idx_pos_waitlist_live
  ON public.pos_waitlist (client_id, created_at)
  WHERE status IN ('waiting', 'notified');
-- A bill's delete (the key's SET NULL) and join_pos_tables' re-point both look a party up by bill.
CREATE INDEX IF NOT EXISTS idx_pos_waitlist_order_id
  ON public.pos_waitlist (order_id)
  WHERE order_id IS NOT NULL;


-- ── 3. RLS ──────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.pos_waitlist ENABLE ROW LEVEL SECURITY;

-- One permissive FOR ALL, my_client_id() (never its body), both operands hoisted as InitPlans and
-- the whole condition wrapped, because NULL OR NULL falls open for a login with no profile row.
DROP POLICY IF EXISTS pos_waitlist_client ON public.pos_waitlist;
CREATE POLICY pos_waitlist_client ON public.pos_waitlist
  TO authenticated
  USING (COALESCE(client_id = (SELECT public.my_client_id()) OR (SELECT public.is_admin()), false))
  WITH CHECK (COALESCE(client_id = (SELECT public.my_client_id()) OR (SELECT public.is_admin()), false));

-- Staff-account isolation, the trio every pos_* business table carries (S316 / S419 / S430). POS
-- PIN logins are not fenced out: the host stand is a waiter or a cashier.
DROP POLICY IF EXISTS no_self_service_accounts ON public.pos_waitlist;
DROP POLICY IF EXISTS no_ims_staff             ON public.pos_waitlist;
DROP POLICY IF EXISTS no_hr_role_staff         ON public.pos_waitlist;
CREATE POLICY no_self_service_accounts ON public.pos_waitlist AS RESTRICTIVE FOR ALL
  USING (COALESCE(NOT (SELECT public.is_hr_self_service()), false))
  WITH CHECK (COALESCE(NOT (SELECT public.is_hr_self_service()), false));
CREATE POLICY no_ims_staff ON public.pos_waitlist AS RESTRICTIVE FOR ALL
  USING (COALESCE(NOT (SELECT public.is_ims_staff()), false))
  WITH CHECK (COALESCE(NOT (SELECT public.is_ims_staff()), false));
CREATE POLICY no_hr_role_staff ON public.pos_waitlist AS RESTRICTIVE FOR ALL
  USING (COALESCE(NOT (SELECT public.is_hr_role_staff()), false))
  WITH CHECK (COALESCE(NOT (SELECT public.is_hr_role_staff()), false));

-- Raw-SQL tables get no role grants. authenticated reads, adds and moves a party (the operator's
-- restore inserts through the browser too); no DELETE. Since S821 a new table starts without
-- TRUNCATE / REFERENCES / TRIGGER / MAINTAIN, and nothing here grants them back.
GRANT SELECT, INSERT, UPDATE ON public.pos_waitlist TO authenticated;
GRANT ALL ON public.pos_waitlist TO service_role;
REVOKE ALL ON public.pos_waitlist FROM anon;


-- ── 4. The guard: rank, a forward-only status, and the server's stamps ──────────────────────
--
-- SECURITY INVOKER on purpose: current_user is then the caller's role, so the service role, every
-- SECURITY DEFINER body (join_pos_tables' re-point) and a foreign key's own SET NULL (which runs as
-- the table owner) pass the browser rules untouched, as in guard_profiles_privileged_columns().
-- A trigger function needs no grant: EXECUTE is checked at CREATE TRIGGER time, never at fire time.
CREATE OR REPLACE FUNCTION public.pos_waitlist_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_browser boolean := current_user IN ('anon', 'authenticated');
BEGIN
  -- Tidy what was typed, for every caller, before the CHECKs read it.
  NEW.customer_name := btrim(COALESCE(NEW.customer_name, ''));
  NEW.phone := NULLIF(btrim(COALESCE(NEW.phone, '')), '');
  NEW.notes := NULLIF(btrim(COALESCE(NEW.notes, '')), '');

  -- A seated party whose bill was deleted under it (Clear Occupied, Danger Zone, a cascade): the key
  -- sets order_id NULL as the table owner, and the party goes back to the list it came from rather
  -- than the CHECK refusing the delete. Same answer as a seated booking under Clear Occupied (D22).
  IF TG_OP = 'UPDATE' AND NOT v_browser
     AND OLD.status = 'seated' AND OLD.order_id IS NOT NULL AND NEW.order_id IS NULL THEN
    NEW.status := CASE WHEN NEW.notified_at IS NOT NULL THEN 'notified' ELSE 'waiting' END;
    NEW.seated_at := NULL;
    RETURN NEW;
  END IF;

  -- The service role, DEFINER bodies and key actions: untouched.
  IF NOT v_browser THEN
    RETURN NEW;
  END IF;

  -- The operator restore: an admin INSERT of a row dated before this transaction keeps it as it
  -- was (no screen sends created_at). The CHECKs and the outlet guard still apply.
  IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false)
     AND COALESCE(NEW.created_at < now(), false) THEN
    RETURN NEW;
  END IF;

  IF NOT COALESCE(public.pos_caller_has_rank('staff'), false) THEN
    RAISE EXCEPTION 'pos_waitlist_rank: only a POS login of this outlet can change the waitlist'
      USING ERRCODE = '42501', HINT = 'pos_waitlist_rank';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A new party is a party waiting now, whatever the request said.
    NEW.status       := 'waiting';
    NEW.order_id     := NULL;
    NEW.notified_at  := NULL;
    NEW.seated_at    := NULL;
    NEW.left_at      := NULL;
    NEW.cancelled_at := NULL;
    NEW.created_at   := now();
    NEW.updated_at   := now();
    RETURN NEW;
  END IF;

  -- UPDATE from a browser.
  IF OLD.status IN ('seated', 'left', 'cancelled') THEN
    RAISE EXCEPTION 'pos_waitlist_closed: this party was already seated, marked as left or cancelled, so the entry is final'
      USING ERRCODE = 'P0001', HINT = 'pos_waitlist_closed';
  END IF;
  IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    RAISE EXCEPTION 'pos_waitlist_outlet: a waitlist party cannot move to another outlet'
      USING ERRCODE = 'P0001', HINT = 'pos_waitlist_outlet';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT COALESCE(
           (OLD.status = 'waiting'  AND NEW.status IN ('notified', 'seated', 'left', 'cancelled'))
        OR (OLD.status = 'notified' AND NEW.status IN ('seated', 'left', 'cancelled')), false) THEN
    RAISE EXCEPTION 'pos_waitlist_status: a waiting party can be told, seated, marked as left or cancelled, and a told party cannot go back to waiting'
      USING ERRCODE = 'P0001', HINT = 'pos_waitlist_status';
  END IF;
  IF NEW.status <> 'seated' AND NEW.order_id IS NOT NULL THEN
    RAISE EXCEPTION 'pos_waitlist_order: a waitlist party is linked to a bill only when it is seated'
      USING ERRCODE = 'P0001', HINT = 'pos_waitlist_order';
  END IF;

  -- The stamps are the server's: keep what was there, then stamp the move just made.
  NEW.created_at   := OLD.created_at;
  NEW.notified_at  := OLD.notified_at;
  NEW.seated_at    := OLD.seated_at;
  NEW.left_at      := OLD.left_at;
  NEW.cancelled_at := OLD.cancelled_at;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    CASE NEW.status
      WHEN 'notified'  THEN NEW.notified_at  := now();
      WHEN 'seated'    THEN NEW.seated_at    := now();
      WHEN 'left'      THEN NEW.left_at      := now();
      WHEN 'cancelled' THEN NEW.cancelled_at := now();
      ELSE NULL;
    END CASE;
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.pos_waitlist_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS pos_waitlist_guard ON public.pos_waitlist;
CREATE TRIGGER pos_waitlist_guard
  BEFORE INSERT OR UPDATE ON public.pos_waitlist
  FOR EACH ROW EXECUTE FUNCTION public.pos_waitlist_guard();


-- ── 5. A party is seated only on a bill of its own outlet ───────────────────────────────────
-- Mirrors pos_reservations_guard_order_client (S809, 20261008120000). SECURITY DEFINER so the
-- lookup sees the bill whatever the caller's RLS view of pos_orders is (the S749 lesson). It answers
-- only "same outlet or not", and as a trigger function PostgREST cannot serve it as an RPC.
CREATE OR REPLACE FUNCTION public.pos_waitlist_guard_order_client()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NEW.order_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM pos_orders o WHERE o.id = NEW.order_id AND o.client_id = NEW.client_id) THEN
    RAISE EXCEPTION 'waitlist_order_other_client: a waitlist party can only be seated on a bill of its own outlet'
      USING ERRCODE = '23503', HINT = 'waitlist_order_other_client';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.pos_waitlist_guard_order_client() FROM PUBLIC;

DROP TRIGGER IF EXISTS pos_waitlist_guard_order_client ON public.pos_waitlist;
CREATE TRIGGER pos_waitlist_guard_order_client
  BEFORE INSERT OR UPDATE OF order_id, client_id ON public.pos_waitlist
  FOR EACH ROW EXECUTE FUNCTION public.pos_waitlist_guard_order_client();


-- ── 6. Who added the party is the login that saved it ───────────────────────────────────────
-- Mirrors pos_reservations_stamp_created_by (S809). INVOKER, the current_user seam; the operator is
-- exempt for the restore.
CREATE OR REPLACE FUNCTION public.pos_waitlist_stamp_created_by()
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
REVOKE ALL ON FUNCTION public.pos_waitlist_stamp_created_by() FROM PUBLIC;

DROP TRIGGER IF EXISTS pos_waitlist_stamp_created_by ON public.pos_waitlist;
CREATE TRIGGER pos_waitlist_stamp_created_by
  BEFORE INSERT OR UPDATE OF created_by ON public.pos_waitlist
  FOR EACH ROW EXECUTE FUNCTION public.pos_waitlist_stamp_created_by();


-- ── 7. updated_at, actually maintained (the one shared function) ────────────────────────────
DROP TRIGGER IF EXISTS pos_waitlist_touch ON public.pos_waitlist;
CREATE TRIGGER pos_waitlist_touch
  BEFORE UPDATE ON public.pos_waitlist
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- ── 8. A joined table carries its seated waitlist party onto the bill it joins ──────────────
-- join_pos_tables (S836) deletes the joining table's own bill after moving its lines, and re-points
-- everything that names that bill first (tickets, guest orders, the seated booking). Patched from
-- the LIVE body (the S753 pattern): one line after the booking's re-point, refused unless that line
-- occurs exactly once, skipped on a re-run. CREATE OR REPLACE keeps the grants and SECURITY DEFINER.
DO $patch$
DECLARE
  v_oid regprocedure := 'public.join_pos_tables(uuid,uuid,integer,integer)'::regprocedure;
  v_pat text := '(UPDATE pos_reservations[ \t]+SET order_id = v_o\.id WHERE order_id = v_o2\.id;)';
  v_src text;
  v_def text;
  v_n   integer;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF position('pos_waitlist' IN v_src) > 0 THEN
    RAISE NOTICE 'S854: join_pos_tables already carries the waitlist party';
    RETURN;
  END IF;
  SELECT count(*) INTO v_n FROM regexp_matches(v_src, v_pat, 'g');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S854 patch: expected the booking re-point once in join_pos_tables, found it % time(s). Rebuild from the live body.', v_n;
  END IF;
  v_def := pg_get_functiondef(v_oid);
  SELECT count(*) INTO v_n FROM regexp_matches(v_def, v_pat, 'g');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S854 patch: the definition of join_pos_tables holds the booking re-point % time(s)', v_n;
  END IF;
  v_def := regexp_replace(v_def, v_pat,
    E'\\1\n    UPDATE pos_waitlist              SET order_id = v_o.id WHERE order_id = v_o2.id;');
  EXECUTE v_def;
  IF position('UPDATE pos_waitlist' IN (SELECT prosrc FROM pg_proc WHERE oid = v_oid)) = 0 THEN
    RAISE EXCEPTION 'S854 patch: join_pos_tables was rebuilt without the waitlist line';
  END IF;
END;
$patch$;


-- ── 9. Prove it: the catalog ────────────────────────────────────────────────────────────────
-- Asserted on catalog columns and Postgres-computed privileges, never on formatted text (S630).
DO $check$
DECLARE
  v_n integer;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.pos_waitlist'::regclass) THEN
    RAISE EXCEPTION 'S854: RLS is not enabled on pos_waitlist';
  END IF;

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'pos_waitlist' AND permissive = 'PERMISSIVE';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S854: expected one permissive policy on pos_waitlist, found %', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'pos_waitlist' AND permissive = 'RESTRICTIVE'
     AND policyname IN ('no_self_service_accounts', 'no_ims_staff', 'no_hr_role_staff');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'S854: expected the three staff-isolation policies on pos_waitlist, found %', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.pos_waitlist'::regclass AND NOT tgisinternal AND tgenabled = 'O'
     AND tgname IN ('pos_waitlist_guard', 'pos_waitlist_guard_order_client', 'pos_waitlist_stamp_created_by', 'pos_waitlist_touch');
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'S854: expected the four triggers on pos_waitlist, found %', v_n;
  END IF;

  -- The two INVOKER guards must stay INVOKER (the current_user seam), the outlet guard DEFINER.
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE (oid = 'public.pos_waitlist_guard()'::regprocedure AND NOT prosecdef)
      OR (oid = 'public.pos_waitlist_stamp_created_by()'::regprocedure AND NOT prosecdef)
      OR (oid = 'public.pos_waitlist_guard_order_client()'::regprocedure AND prosecdef)
      OR (oid = 'public.join_pos_tables(uuid,uuid,integer,integer)'::regprocedure AND prosecdef);
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'S854: a function changed its SECURITY mode (% of 4 as expected)', v_n;
  END IF;

  -- The keys: the bill link empties (SET NULL), the outlet link cascades.
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.pos_waitlist'::regclass AND contype = 'f'
     AND ((confrelid = 'public.pos_orders'::regclass AND confdeltype = 'n')
       OR (confrelid = 'public.clients'::regclass AND confdeltype = 'c')
       OR (confrelid = 'public.profiles'::regclass AND confdeltype = 'n'));
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'S854: expected the bill, outlet and author keys on pos_waitlist as written, found %', v_n;
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.pos_waitlist', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.pos_waitlist', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.pos_waitlist', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.pos_waitlist', 'DELETE')
     OR has_table_privilege('authenticated', 'public.pos_waitlist', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.pos_waitlist', 'REFERENCES')
     OR has_table_privilege('authenticated', 'public.pos_waitlist', 'TRIGGER')
     OR has_table_privilege('anon', 'public.pos_waitlist', 'SELECT')
     OR has_table_privilege('anon', 'public.pos_waitlist', 'INSERT')
     OR has_table_privilege('anon', 'public.pos_waitlist', 'UPDATE')
     OR has_table_privilege('anon', 'public.pos_waitlist', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.pos_waitlist', 'DELETE') THEN
    RAISE EXCEPTION 'S854: the table grants on pos_waitlist are not as written';
  END IF;

  IF position('UPDATE pos_waitlist' IN (SELECT prosrc FROM pg_proc
                                         WHERE oid = 'public.join_pos_tables(uuid,uuid,integer,integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'S854: join_pos_tables does not carry the waitlist party';
  END IF;
END;
$check$;


-- ── 10. Prove it: as a till login, inside a block that rolls itself back ────────────────────
-- A call the guard rejects is not a test (S737), so the stand-in is a plain Staff-rank till login
-- with no other staff marker (a restrictive policy would otherwise turn an "allowed" into 0 rows).
DO $probe$
DECLARE
  v_client uuid; v_other uuid; v_staff uuid;
  v_ta uuid; v_tb uuid; v_o1 uuid; v_o2 uuid; v_oelse uuid;
  v_w uuid; v_w2 uuid; v_row public.pos_waitlist; v_r jsonb; v_hint text;
BEGIN
  SELECT c.id INTO v_client
    FROM public.clients c
   WHERE c.pos_enabled AND COALESCE(public.client_access_open(c.id), false)
     AND EXISTS (SELECT 1 FROM public.settings s WHERE s.client_id = c.id)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND p.active_client_id IS NULL
                    AND p.pos_role IS NOT NULL AND p.pos_email IS NOT NULL
                    AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL)
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S854 probe: no POS outlet with settings and an unblocked POS till login';
  END IF;
  SELECT p.id INTO v_staff FROM public.profiles p
   WHERE p.client_id = v_client AND p.active_client_id IS NULL AND p.pos_role IS NOT NULL AND p.pos_email IS NOT NULL
     AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL
   ORDER BY (p.pos_role = 'staff') DESC, p.id LIMIT 1;
  SELECT c.id INTO v_other FROM public.clients c WHERE c.id <> v_client ORDER BY c.id LIMIT 1;

  BEGIN
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role ──────────────────────────────────────────────────
    UPDATE public.profiles SET pos_role = 'staff', ims_role = NULL, hr_role = NULL, hr_self_service = false WHERE id = v_staff;
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_client, 'S854 probe A') RETURNING id INTO v_ta;
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_client, 'S854 probe B') RETURNING id INTO v_tb;
    INSERT INTO public.pos_orders (client_id, table_id, table_name, covers) VALUES (v_client, v_ta, 'S854 probe A', 2) RETURNING id INTO v_o1;
    INSERT INTO public.pos_orders (client_id, table_id, table_name, covers) VALUES (v_client, v_tb, 'S854 probe B', 4) RETURNING id INTO v_o2;
    UPDATE public.pos_tables SET status = 'occupied' WHERE id IN (v_ta, v_tb);
    IF v_other IS NOT NULL THEN
      INSERT INTO public.pos_orders (client_id) VALUES (v_other) RETURNING id INTO v_oelse;
    END IF;

    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff)::text, true);

    -- ── (1) An insert that claims more than a new party: the server makes it one ──────────
    SET LOCAL ROLE authenticated;
    INSERT INTO public.pos_waitlist (client_id, customer_name, phone, party_size, quoted_minutes, status,
                                     notified_at, seated_at, created_at, created_by)
    VALUES (v_client, '  S854 probe guest  ', '   ', 4, 20, 'seated',
            now() - interval '1 hour', now() - interval '1 hour', now() - interval '2 hours', NULL)
    RETURNING id INTO v_w;
    RESET ROLE;
    SELECT * INTO v_row FROM public.pos_waitlist WHERE id = v_w;
    IF v_row.status <> 'waiting' OR v_row.notified_at IS NOT NULL OR v_row.seated_at IS NOT NULL
       OR v_row.customer_name <> 'S854 probe guest' OR v_row.phone IS NOT NULL
       OR v_row.created_at <> now() OR v_row.created_by IS DISTINCT FROM v_staff THEN
      RAISE EXCEPTION 'S854 probe: a new party was stored as % (told %, seated %, name "%", phone %, added %, by %)',
        v_row.status, v_row.notified_at, v_row.seated_at, v_row.customer_name, v_row.phone, v_row.created_at, v_row.created_by;
    END IF;

    -- ── (2) Told: the server stamps the time, not the browser ─────────────────────────────
    SET LOCAL ROLE authenticated;
    UPDATE public.pos_waitlist SET status = 'notified', notified_at = now() - interval '3 hours' WHERE id = v_w;
    RESET ROLE;
    IF (SELECT notified_at FROM public.pos_waitlist WHERE id = v_w) IS DISTINCT FROM now()
       OR (SELECT status FROM public.pos_waitlist WHERE id = v_w) <> 'notified' THEN
      RAISE EXCEPTION 'S854 probe: telling the party left it % at %',
        (SELECT status FROM public.pos_waitlist WHERE id = v_w), (SELECT notified_at FROM public.pos_waitlist WHERE id = v_w);
    END IF;

    -- ── (3) Seated with no bill, and seated on another outlet's bill: both refused ────────
    SET LOCAL ROLE authenticated;
    BEGIN
      UPDATE public.pos_waitlist SET status = 'seated' WHERE id = v_w;
      RAISE EXCEPTION 'S854 probe: a party was seated with no bill';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    IF v_oelse IS NOT NULL THEN
      v_hint := NULL;
      BEGIN
        UPDATE public.pos_waitlist SET status = 'seated', order_id = v_oelse WHERE id = v_w;
      EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      END;
      IF v_hint IS DISTINCT FROM 'waitlist_order_other_client' THEN
        RAISE EXCEPTION 'S854 probe: seating on another outlet''s bill answered %', COALESCE(v_hint, 'seated');
      END IF;
    END IF;

    -- ── (4) Seated on B's bill: stamped by the server, the told time kept ─────────────────
    UPDATE public.pos_waitlist SET status = 'seated', order_id = v_o2, seated_at = now() - interval '5 hours' WHERE id = v_w;
    RESET ROLE;
    SELECT * INTO v_row FROM public.pos_waitlist WHERE id = v_w;
    IF v_row.status <> 'seated' OR v_row.order_id IS DISTINCT FROM v_o2
       OR v_row.seated_at IS DISTINCT FROM now() OR v_row.notified_at IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S854 probe: seating left the party % on % (seated %, told %)',
        v_row.status, v_row.order_id, v_row.seated_at, v_row.notified_at;
    END IF;

    -- ── (5) A seated row is final for a browser ───────────────────────────────────────────
    SET LOCAL ROLE authenticated;
    v_hint := NULL;
    BEGIN
      UPDATE public.pos_waitlist SET status = 'left' WHERE id = v_w;
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_waitlist_closed' THEN
      RAISE EXCEPTION 'S854 probe: marking a seated party as left answered %', COALESCE(v_hint, 'left');
    END IF;

    -- ── (6) Join B onto A's bill: the party follows the bill B's own bill folded into ─────
    v_r := public.join_pos_tables(v_o1, v_tb, NULL, NULL);
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM public.pos_orders WHERE id = v_o2)
       OR (SELECT order_id FROM public.pos_waitlist WHERE id = v_w) IS DISTINCT FROM v_o1
       OR (SELECT status FROM public.pos_waitlist WHERE id = v_w) <> 'seated' THEN
      RAISE EXCEPTION 'S854 probe: after the join the party is % on %',
        (SELECT status FROM public.pos_waitlist WHERE id = v_w), (SELECT order_id FROM public.pos_waitlist WHERE id = v_w);
    END IF;

    -- ── (7) The bill deleted under the party (Clear Occupied): back on the list, told ─────
    -- With no JWT, so no guard keyed on the caller's claims answers for the till login.
    PERFORM set_config('request.jwt.claims', '', true);
    DELETE FROM public.pos_orders WHERE id = v_o1;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff)::text, true);
    SELECT * INTO v_row FROM public.pos_waitlist WHERE id = v_w;
    IF v_row.status <> 'notified' OR v_row.order_id IS NOT NULL OR v_row.seated_at IS NOT NULL THEN
      RAISE EXCEPTION 'S854 probe: a party whose bill was deleted was left % on % (seated %)',
        v_row.status, v_row.order_id, v_row.seated_at;
    END IF;

    -- ── (8) Left and Cancel are stamped and final; a told party cannot go back to waiting ─
    SET LOCAL ROLE authenticated;
    v_hint := NULL;
    BEGIN
      UPDATE public.pos_waitlist SET status = 'waiting' WHERE id = v_w;
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_waitlist_status' THEN
      RAISE EXCEPTION 'S854 probe: a told party going back to waiting answered %', COALESCE(v_hint, 'waiting');
    END IF;
    UPDATE public.pos_waitlist SET status = 'left' WHERE id = v_w;
    INSERT INTO public.pos_waitlist (client_id, customer_name, party_size, quoted_minutes)
    VALUES (v_client, 'S854 probe second', 2, 10) RETURNING id INTO v_w2;
    UPDATE public.pos_waitlist SET status = 'cancelled' WHERE id = v_w2;
    RESET ROLE;
    IF (SELECT left_at FROM public.pos_waitlist WHERE id = v_w) IS DISTINCT FROM now()
       OR (SELECT cancelled_at FROM public.pos_waitlist WHERE id = v_w2) IS DISTINCT FROM now()
       OR (SELECT status FROM public.pos_waitlist WHERE id = v_w2) <> 'cancelled' THEN
      RAISE EXCEPTION 'S854 probe: Left or Cancel was not stamped';
    END IF;

    -- ── (9) No browser deletes a party ────────────────────────────────────────────────────
    SET LOCAL ROLE authenticated;
    BEGIN
      DELETE FROM public.pos_waitlist WHERE id = v_w2;
      RAISE EXCEPTION 'S854 probe: a till login deleted a waitlist party';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- ── (10) A login of the outlet with no POS rank (an IMS manager, the S836 stand-in) is
    -- refused by the guard, which runs before the INSERT's RLS check ─────────────────────
    UPDATE public.profiles SET pos_role = NULL, pos_email = NULL, ims_role = 'manager' WHERE id = v_staff;
    SET LOCAL ROLE authenticated;
    v_hint := NULL;
    BEGIN
      INSERT INTO public.pos_waitlist (client_id, customer_name, party_size, quoted_minutes)
      VALUES (v_client, 'S854 probe no rank', 2, 10);
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    RESET ROLE;
    IF v_hint IS DISTINCT FROM 'pos_waitlist_rank' THEN
      RAISE EXCEPTION 'S854 probe: a login with no POS rank adding a party answered %', COALESCE(v_hint, 'added');
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.headers', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's854_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's854_probe_rollback' THEN RAISE; END IF;
  END;
END;
$probe$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── 11. What this file changed, live (the last statement, so `db query` prints it) ──────────
SELECT
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pos_waitlist') AS policies_4,
  (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.pos_waitlist'::regclass AND NOT tgisinternal) AS triggers_4,
  position('UPDATE pos_waitlist' IN (SELECT prosrc FROM pg_proc
                                      WHERE oid = 'public.join_pos_tables(uuid,uuid,integer,integer)'::regprocedure)) > 0 AS join_carries_party,
  has_table_privilege('authenticated', 'public.pos_waitlist', 'DELETE') AS browser_delete_false;
