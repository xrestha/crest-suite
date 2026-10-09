-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 3, slice 3i: a leaver's till login is blocked, not deleted, so their name stays on
-- what they recorded; and each Danger Zone clear takes only its own module's Inventory rows.
--
--   ACCESS-5 (P2), owner decision Q17 (a), 2026-10-09. Deleting a cashier's POS login deleted the
--   auth user, and every foreign key from the till's tables to profiles is ON DELETE SET NULL: the
--   bills they closed, the shifts they opened and closed, their Cash In / Out, the kitchen tickets
--   they sent, the dishes they pulled, the credit notes they issued, the bookings they took, their
--   parking slips and points entries all lost the name at once, while the confirm said "Bills they
--   closed keep their name". HR leavers were already blocked at Final Settlement (S753); a POS-only
--   restaurant has no settlement, and profiles.settlement_blocked_by is a foreign key to
--   hr_final_settlements that it cannot fill. So POS Staff gets its own block:
--     (1) profiles.pos_blocked_at / pos_blocked_by: when POS Staff blocked the login, and who did.
--         guard_profiles_privileged_columns is an allow-list (full_name, last_seen_at), so no client
--         session can write either column; only admin-user-ops (service role, through (6)) does.
--     (2) pos_caller_has_rank refuses a blocked login at every rank, beside the settled leaver it
--         already refused, so the access token a blocked login still holds (sessions are ended, but
--         an issued token lives out its hour) is refused by every POS rank rule at once. Its
--         contract is unchanged: admin, the Owner, or a POS login at that rank.
--     (3) pos_device_caller_may_manage (Till Devices) and get_pos_device_staff (the till's staff
--         picker) leave a blocked login out, as they leave out a settled leaver.
--     (4) get_pos_staff_list returns pos_blocked_at, so POS Staff can show "Login blocked" and offer
--         Unblock. A changed result type: dropped and created again, with the live grants.
--     (5) pos_login_reference_columns() / pos_login_recorded_rows(uuid): what a login has recorded.
--         The columns are read from the catalog, not listed by hand: every single-column foreign key
--         from a public table to profiles or auth.users that does not go with the login (anything
--         but ON DELETE CASCADE), plus the two columns that hold a login's id with no key,
--         pos_orders.opened_by (Covers Report's server) and pos_order_items.comped_by. A new column
--         that names a login is counted the day its key exists. admin-user-ops refuses a Delete of a
--         login with any such row and offers Block instead (Q17 a: Delete only for a login that
--         recorded nothing). Service role only.
--     (6) pos_set_login_blocked(uuid, boolean, uuid): the block in one transaction, the shape Final
--         Settlement uses (finalize_final_settlement, S753/S798): stamp the login, ban the auth user
--         (banned_until 2999) and end its sessions; Unblock clears the stamp and the ban. Refused for
--         a login a Final Settlement blocked (that block is undone in HR, by Reopen or a rehire,
--         and is never cleared from here), and an Unblock is refused while HR shows the login's
--         employee as no longer working there. Rank and target are checked in admin-user-ops before
--         the call (requireStaffTarget, requireManageableTarget, and the S809 1f power rule).
--         Service role only.
--   A login is never blocked by both: Finalize leaves an already-banned login alone (it does not
--   stamp it), and (6) refuses a login a settlement stamped. So Reopen never unbans a POS block, and
--   POS Unblock never lifts a settlement's.
--
--   DATABASE-2 (P2). Clear POS Transactions deleted every stock_movements row of the client, manual
--   Sales Entry depletion included, and Clear IMS Transactions deleted the till's; since slice 2e a
--   "not served" credit note's 'pos_credit_restock' rows survived both, because the two clears
--   filtered sales_entries by ['pos','pos_comp','pos_credit'] and 'manual'. The fix is in
--   admin-user-ops (each clear names its own sources). This migration adds the half the database
--   owes: stock_movements.source had no CHECK, so "every source is in exactly one clear" could not
--   be stated. (7) adds stock_movements_source_check with the four sources the app writes, the
--   same shape as sales_entries_source_check:
--     sales_entries.source    manual (and NULL, the legacy default) → IMS;
--                             pos, pos_comp, pos_credit, pos_credit_restock → POS
--     stock_movements.source  manual → IMS; pos_sale, pos_comp, pos_credit_restock → POS
--   clearModuleSources.test.js pins admin-user-ops' four lists to both CHECKs.
--
--   DATABASE-3 (P2) and DATABASE-6 (P3) are restoreClientData.js only: no guard needed a change.
--   Read live for the restore's path (the operator inserting rows dated before the transaction):
--   pos_parking_slips_guard lets the operator's insert through as it was (slip number, issuer and
--   times kept); pos_cash_movements_guard lets a restored entry through on a closed shift;
--   pos_credit_note_settle links the bill and writes NO refund for a restored note, so the refund
--   row the backup carries is restored once, by the cash table, after the notes.
--
-- Built on the LIVE bodies (pg_get_functiondef, md5(prosrc), read 2026-10-09 after slice 2h and the
-- S810 demo seed). Section 0 refuses to run over any other body. Every change inside them is marked
-- "S809 3i".
--   pos_caller_has_rank(text)                  7d34792c8f392e49bc47274d1e8045ce  (S809 1j's)
--   pos_device_caller_may_manage(uuid)         e3c805fe433f38e6977b6119a6eacd80
--   get_pos_device_staff(uuid,uuid,text)       fb469485a51c01fd06d5f7baad7fc308
--   get_pos_staff_list(uuid)                   5fee04796d62a7fd8c42233ec1cb7ed1
-- The first three keep their signatures, SECURITY mode and grants (CREATE OR REPLACE keeps proacl):
-- {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}, {postgres=X/postgres} and
-- {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}.
-- get_pos_staff_list gains a column, so it is dropped and created again with its live grants,
-- {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}.
-- Not changed: guard_profiles_privileged_columns (5332d0907e8f51366189399118584592; an allow-list, so
-- the new columns are already the service role's alone), get_pos_staff (the retired shared-key
-- picker; every client's shared key is off and slice 3h drops it), finalize_final_settlement,
-- reopen_final_settlement and hr_unblock_rehired_logins (they act only on settlement-stamped logins).
-- Not touched (other slices drafted at the same time): award_/redeem_loyalty_points, pos_customers
-- (3k); pos-staff-login (3h).
--
-- Live before this migration (2026-10-09, BLOOM CAFE and BLOOM CAFE - PKR carrying the S810 demo
-- history):
--   * 6 POS PIN logins in the whole database, all at the two BLOOM outlets, none settlement-blocked
--     and none banned. Each has recorded hundreds of rows (e.g. a BLOOM CAFE supervisor: 1,814 bills
--     closed, 810 orders opened, 1,377 kitchen tickets sent, 72 shifts, 4 cash entries), so today
--     every one of them could only be blocked, never deleted.
--   * 17 foreign keys from pos_* tables to profiles, all SET NULL; 43 single-column non-cascading
--     keys from public tables to profiles or auth.users in all, 44 with pos_blocked_by (section 8
--     asserts the POS ones).
--   * stock_movements: 6,514 manual (CASA ACAI CAFE), 71,545 pos_sale and 180 pos_comp (the two BLOOM
--     outlets); 0 rows outside the four sources, so the CHECK rejects 0 rows. sales_entries: 0 rows
--     with a NULL source.
--   * BLOOM CAFE holds 6 cash entries, one of them a credit-note refund, 2 credit notes, 0 parking
--     slips, 0 guest-order requests, 0 payment confirmations: a restore of its backup today would
--     drop all 6 cash entries (DATABASE-3's cash half), which the app half of this slice fixes.
--
-- Ship order: this migration, then admin-user-ops (it calls (5) and (6) and reads the new columns;
-- deployed first, every admin-user-ops call fails on its caller read), then the app. A till on
-- crest-v422 is refused nothing new in normal service: only a blocked login loses its rank, and
-- no screen writes a stock-movement source outside the four.
--
-- The probe at the end runs as BLOOM CAFE's POS PIN supervisor and manager, its Owner, an anonymous
-- till and the service role inside a block that rolls itself back. If any check fails, the whole
-- migration fails and nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces are the ones it was built on ─────────────────
-- CREATE OR REPLACE would silently revert another change to any of them. The second hash of each
-- pair is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_caller_has_rank(text)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '7d34792c8f392e49bc47274d1e8045ce' AND v_md5 IS DISTINCT FROM '100bd1bd1e2a1a1c3a6f4cb105a8e887' THEN
    RAISE EXCEPTION 'S809 3i: pos_caller_has_rank changed since this slice was drafted (live md5 %) — merge section 2 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_device_caller_may_manage(uuid)'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'e3c805fe433f38e6977b6119a6eacd80' AND v_md5 IS DISTINCT FROM '10e1c9a74168ad7b407eefb15d820e4d' THEN
    RAISE EXCEPTION 'S809 3i: pos_device_caller_may_manage changed since this slice was drafted (live md5 %) — merge section 3 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_pos_device_staff(uuid,uuid,text)'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'fb469485a51c01fd06d5f7baad7fc308' AND v_md5 IS DISTINCT FROM '8bec27d197fcc3cf7f02de4fbc64c263' THEN
    RAISE EXCEPTION 'S809 3i: get_pos_device_staff changed since this slice was drafted (live md5 %) — merge section 3 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_pos_staff_list(uuid)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '5fee04796d62a7fd8c42233ec1cb7ed1' AND v_md5 IS DISTINCT FROM 'c2e0640be747aaad62943a1050e918ae' THEN
    RAISE EXCEPTION 'S809 3i: get_pos_staff_list changed since this slice was drafted (live md5 %) — merge section 4 onto the live body and update the md5 in section 0', v_md5;
  END IF;
END;
$$;


-- ── 1. The block marker ───────────────────────────────────────────────────────────────────────
-- Not a staff marker: a blocked login keeps pos_email and its rank, so it is still POS staff to every
-- restrictive policy, is_client_owner() and isOwner. Only the rank test and the two till lists read
-- it. pos_blocked_by is SET NULL like every other "who" column.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS pos_blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS pos_blocked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.profiles.pos_blocked_at IS
  'S809 3i (ACCESS-5, Q17 a): when POS Staff blocked this till login (banned, sessions ended, kept so its name stays on what it recorded). NULL = not blocked. Written only by pos_set_login_blocked (service role).';
COMMENT ON COLUMN public.profiles.pos_blocked_by IS
  'S809 3i: the login that blocked this one from POS Staff. NULL after a restore, or once that login is deleted.';


-- ── 2. pos_caller_has_rank ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_caller_has_rank(p_min text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(public.is_admin(), false)
      OR COALESCE(public.is_client_owner(), false)
      OR COALESCE((
           SELECT p.settlement_blocked_by IS NULL
              -- S809 3i (ACCESS-5): a login POS Staff blocked holds no rank either, so the token it
              -- still carries for up to an hour is refused by every POS rule at once.
              AND p.pos_blocked_at IS NULL
              AND CASE p_min
                    WHEN 'staff'      THEN p.pos_role IN ('staff', 'supervisor', 'manager')
                    WHEN 'supervisor' THEN p.pos_role IN ('supervisor', 'manager')
                    WHEN 'manager'    THEN p.pos_role = 'manager'
                  END
             FROM profiles p
            WHERE p.id = (select auth.uid())), false)
$function$;


-- ── 3. Till Devices and the till's staff picker leave a blocked login out ─────────────────────
CREATE OR REPLACE FUNCTION public.pos_device_caller_may_manage(p_client_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(public.is_admin(), false)
      OR COALESCE((
           SELECT COALESCE(p.active_client_id, p.client_id) = p_client_id
              AND p.settlement_blocked_by IS NULL
              AND p.pos_blocked_at IS NULL   -- S809 3i
              AND (COALESCE(public.is_client_owner(), false) OR COALESCE(p.pos_role = 'manager', false))
             FROM profiles p
            WHERE p.id = (select auth.uid())), false)
$function$;

CREATE OR REPLACE FUNCTION public.get_pos_device_staff(p_client_id uuid, p_device_id uuid, p_device_secret text)
 RETURNS TABLE(id uuid, full_name text, pos_role text, pos_job_title text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.pos_device_key_valid(p_client_id, p_device_id, p_device_secret) THEN
    RAISE EXCEPTION 'pos_device_not_active' USING ERRCODE = '28000',
      HINT = 'This till needs to be activated again by a manager.';
  END IF;

  RETURN QUERY
    SELECT p.id::uuid, p.full_name::text, p.pos_role::text, p.pos_job_title::text
      FROM profiles p
     WHERE p.client_id = p_client_id
       AND p.pos_role IS NOT NULL
       AND p.pos_email IS NOT NULL
       AND p.settlement_blocked_by IS NULL
       AND p.pos_blocked_at IS NULL   -- S809 3i: a blocked login is off the picker
     ORDER BY p.full_name;
END;
$function$;


-- ── 4. get_pos_staff_list: POS Staff sees which logins it blocked ─────────────────────────────
DROP FUNCTION IF EXISTS public.get_pos_staff_list(uuid);
CREATE FUNCTION public.get_pos_staff_list(p_client_id uuid)
 RETURNS TABLE(id uuid, full_name text, pos_role text, pos_job_title text, pos_team text, last_seen_at timestamp with time zone, hr_employee_id uuid, employee_code text, pos_discount_limit numeric, pos_allow_void boolean, settlement_blocked boolean, pos_blocked_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
  caller_role text;
BEGIN
  SELECT COALESCE(p.active_client_id, p.client_id), p.role INTO caller_client_id, caller_role
  FROM profiles p WHERE p.id = auth.uid();

  IF COALESCE(caller_role = 'admin' OR caller_client_id = p_client_id, false) THEN
    RETURN QUERY
      SELECT p.id, p.full_name, p.pos_role, p.pos_job_title, p.pos_team, p.last_seen_at,
             p.hr_employee_id, e.employee_code::text, p.pos_discount_limit, p.pos_allow_void,
             (p.settlement_blocked_by IS NOT NULL),
             p.pos_blocked_at   -- S809 3i: when POS Staff blocked this login; NULL = not blocked
      FROM profiles p
      LEFT JOIN hr_employees e ON e.id = p.hr_employee_id
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.pos_email IS NOT NULL
      ORDER BY p.full_name;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_pos_staff_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_staff_list(uuid) TO authenticated, service_role;


-- ── 5. What a login has recorded ──────────────────────────────────────────────────────────────
-- Every column that would lose this login's name if the login were deleted. Read from the catalog so
-- the next table with a "who" key is counted without anyone remembering to add it here: a single-
-- column foreign key from a public table to profiles or auth.users whose delete action is anything
-- but CASCADE (CASCADE rows are the login's own state: its PIN vault row, outlet ticks, push
-- subscriptions, checklist, count sections, employee links). The two VALUES rows hold a login's id
-- with no key at all. INVOKER and no client grant: only the DEFINER function below calls it.
CREATE OR REPLACE FUNCTION public.pos_login_reference_columns()
 RETURNS TABLE(table_name text, column_name text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT cl.relname::text, a.attname::text
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f'
     AND c.confrelid IN ('public.profiles'::regclass, 'auth.users'::regclass)
     AND cardinality(c.conkey) = 1
     AND c.confdeltype <> 'c'
     AND cl.relnamespace = 'public'::regnamespace
     AND cl.relkind IN ('r', 'p')
  UNION
  VALUES ('pos_orders', 'opened_by'),        -- the till's "who opened this table" (Covers Report)
         ('pos_order_items', 'comped_by')    -- who made a dish complimentary (apply_pos_item_comps)
  ORDER BY 1, 2
$function$;
REVOKE ALL ON FUNCTION public.pos_login_reference_columns() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_login_reference_columns() TO service_role;

-- The count per column, only where it is not 0. Unfiltered by outlet: a login with access to a
-- sibling outlet records there too, and a delete would take its name off those rows as well. The
-- "who" columns are deliberately unindexed (supabase-sql.md, S543), so each count is a table scan;
-- this runs once per Delete press, never on a page load.
CREATE OR REPLACE FUNCTION public.pos_login_recorded_rows(p_profile_id uuid)
 RETURNS TABLE(table_name text, column_name text, n bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  r record;
BEGIN
  IF p_profile_id IS NULL THEN
    RETURN;
  END IF;
  FOR r IN SELECT c.table_name AS t, c.column_name AS col FROM public.pos_login_reference_columns() c LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I = $1', r.t, r.col) INTO n USING p_profile_id;
    IF n > 0 THEN
      table_name := r.t;
      column_name := r.col;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$function$;
REVOKE ALL ON FUNCTION public.pos_login_recorded_rows(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_login_recorded_rows(uuid) TO service_role;


-- ── 6. Block and Unblock, in one transaction ──────────────────────────────────────────────────
-- Called by admin-user-ops' block_pos_staff / unblock_pos_staff after it has checked the caller's
-- rank and the target (the S809 1f rule included), with p_actor the verified caller. The ban is the
-- one Final Settlement writes (banned_until 2999-12-31), and ending the sessions takes their refresh
-- tokens with them: a PIN sign-in then gets "user_banned" from GoTrue (pos-staff-login counts it as
-- a refused attempt, signInVerdict), and a till already signed in can no longer refresh, while
-- section 2 refuses its remaining access token every rank. Returns what happened: 'blocked',
-- 'already_blocked', 'unblocked' or 'not_blocked'.
CREATE OR REPLACE FUNCTION public.pos_set_login_blocked(p_profile_id uuid, p_blocked boolean, p_actor uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p profiles;
BEGIN
  IF p_blocked IS NULL THEN
    RAISE EXCEPTION 'pos_set_login_blocked: say whether to block or unblock' USING ERRCODE = '22004';
  END IF;

  SELECT * INTO p FROM profiles x WHERE x.id = p_profile_id FOR UPDATE;
  IF NOT FOUND OR p.pos_email IS NULL THEN
    RAISE EXCEPTION 'pos_login_not_found: this is not a till (POS PIN) login'
      USING ERRCODE = 'P0002', HINT = 'pos_login_not_found';
  END IF;
  -- A Final Settlement's block is HR's: Reopen or a rehire undoes it (and unbans exactly the logins it
  -- stamped). A POS block on top would be lifted by that Reopen without anyone asking POS Staff.
  IF p.settlement_blocked_by IS NOT NULL THEN
    RAISE EXCEPTION 'pos_login_settlement_blocked: this login was blocked by a Final Settlement, which keeps it blocked until the settlement is reopened or the person is rehired in HR'
      USING ERRCODE = '42501', HINT = 'pos_login_settlement_blocked';
  END IF;

  IF p_blocked THEN
    IF p.pos_blocked_at IS NOT NULL THEN
      RETURN 'already_blocked';
    END IF;
    UPDATE profiles SET pos_blocked_at = now(), pos_blocked_by = p_actor WHERE id = p.id;
    UPDATE auth.users SET banned_until = TIMESTAMPTZ '2999-12-31 00:00:00+00' WHERE id = p.id;
    DELETE FROM auth.sessions WHERE user_id = p.id;
    RETURN 'blocked';
  END IF;

  IF p.pos_blocked_at IS NULL THEN
    RETURN 'not_blocked';
  END IF;
  -- Unblock is for a block made by mistake. Someone HR shows as gone (resigned, terminated, retired)
  -- comes back through a rehire in HR → Employees first.
  IF EXISTS (SELECT 1 FROM hr_employees e
              WHERE e.id = p.hr_employee_id AND e.status NOT IN ('active', 'probation')) THEN
    RAISE EXCEPTION 'pos_unblock_leaver: HR shows this login''s employee as no longer working here, so the login stays blocked'
      USING ERRCODE = '42501', HINT = 'pos_unblock_leaver';
  END IF;
  UPDATE profiles SET pos_blocked_at = NULL, pos_blocked_by = NULL WHERE id = p.id;
  UPDATE auth.users SET banned_until = NULL WHERE id = p.id;
  RETURN 'unblocked';
END;
$function$;
REVOKE ALL ON FUNCTION public.pos_set_login_blocked(uuid, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_set_login_blocked(uuid, boolean, uuid) TO service_role;


-- ── 7. Every stock movement's source is one of the four (DATABASE-2) ──────────────────────────
-- So Clear POS and Clear IMS can each name their own, and between them name every row. Counted
-- first: the ADD would fail on such a row anyway, but this says what to look at.
DO $$
DECLARE
  v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad FROM public.stock_movements
   WHERE source NOT IN ('manual', 'pos_sale', 'pos_comp', 'pos_credit_restock');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'S809 3i: % stock movement(s) carry a source other than manual, pos_sale, pos_comp or pos_credit_restock — look at them before adding stock_movements_source_check', v_bad;
  END IF;
END;
$$;
ALTER TABLE public.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_source_check;
ALTER TABLE public.stock_movements
  ADD CONSTRAINT stock_movements_source_check
  CHECK (source = ANY (ARRAY['manual'::text, 'pos_sale'::text, 'pos_comp'::text, 'pos_credit_restock'::text]));


-- ── 8. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_c        uuid;    -- BLOOM CAFE
  v_sup      uuid;    -- a POS PIN login of BLOOM CAFE, made a plain POS supervisor
  v_mgr      uuid;    -- another, made a plain POS manager
  v_owner    uuid;
  v_r        uuid := gen_random_uuid();   -- a login id nothing has recorded (pos_orders.opened_by has no key)
  v_dev      uuid;
  v_secret   text;
  v_emp      uuid;
  v_fs       uuid;
  v_out      text;
  v_n        int;
  v_ts       timestamptz;
  v_by       uuid;
  v_hint     text;
  v_state    text;
  v_src      text;
BEGIN
  -- ── Catalog. Asserted on catalog columns, never on formatted text ─────────────────────────
  SELECT count(*) INTO v_n
    FROM pg_attribute
   WHERE attrelid = 'public.profiles'::regclass AND NOT attisdropped
     AND ((attname = 'pos_blocked_at' AND atttypid = 'timestamptz'::regtype)
       OR (attname = 'pos_blocked_by' AND atttypid = 'uuid'::regtype));
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S809 3i: profiles.pos_blocked_at / pos_blocked_by are missing or of the wrong type';
  END IF;
  SELECT count(*) INTO v_n FROM pg_constraint c
   WHERE c.conrelid = 'public.profiles'::regclass AND c.contype = 'f'
     AND c.confrelid = 'public.profiles'::regclass AND c.confdeltype = 'n'
     AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.profiles'::regclass AND attname = 'pos_blocked_by')];
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 3i: profiles.pos_blocked_by is not a SET NULL key to profiles';
  END IF;
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.stock_movements'::regclass AND conname = 'stock_movements_source_check'
     AND contype = 'c' AND convalidated;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 3i: stock_movements_source_check is missing or not validated';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE (oid IN ('public.pos_caller_has_rank(text)'::regprocedure, 'public.pos_device_caller_may_manage(uuid)'::regprocedure,
                  'public.get_pos_device_staff(uuid,uuid,text)'::regprocedure, 'public.get_pos_staff_list(uuid)'::regprocedure,
                  'public.pos_login_recorded_rows(uuid)'::regprocedure, 'public.pos_set_login_blocked(uuid,boolean,uuid)'::regprocedure)
          AND prosecdef)
      OR (oid = 'public.pos_login_reference_columns()'::regprocedure AND NOT prosecdef);
  IF v_n <> 7 THEN
    RAISE EXCEPTION 'S809 3i: a function changed its SECURITY mode (% of 7 as expected)', v_n;
  END IF;
  IF has_function_privilege('anon', 'public.pos_set_login_blocked(uuid,boolean,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_set_login_blocked(uuid,boolean,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.pos_set_login_blocked(uuid,boolean,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pos_login_recorded_rows(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_login_recorded_rows(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.pos_login_recorded_rows(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_login_reference_columns()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_pos_staff_list(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_pos_staff_list(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_pos_staff_list(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.get_pos_device_staff(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pos_caller_has_rank(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_device_caller_may_manage(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S809 3i: EXECUTE grants on the block functions or the replaced ones are not as expected';
  END IF;

  -- What counts as "recorded": every POS "who" column, and none of the login's own cascading state.
  SELECT count(*) INTO v_n FROM public.pos_login_reference_columns() r
   WHERE (r.table_name, r.column_name) IN (
     ('pos_orders', 'closed_by'), ('pos_orders', 'opened_by'), ('pos_orders', 'credit_settled_by'),
     ('pos_order_items', 'comped_by'), ('pos_order_payments', 'recorded_by'),
     ('pos_shifts', 'opened_by'), ('pos_shifts', 'closed_by'), ('pos_cash_movements', 'created_by'),
     ('pos_credit_notes', 'issued_by'), ('pos_kot_log', 'sent_by'), ('pos_kot_log', 'status_updated_by'),
     ('pos_kot_removals', 'removed_by'), ('pos_parking_slips', 'issued_by'), ('pos_parking_slips', 'exited_by'),
     ('pos_reservations', 'created_by'), ('pos_loyalty_ledger', 'created_by'),
     ('pos_guest_order_requests', 'decided_by'), ('pos_devices', 'created_by'), ('pos_devices', 'revoked_by'),
     ('profiles', 'pos_blocked_by'));
  IF v_n <> 20 THEN
    RAISE EXCEPTION 'S809 3i: pos_login_reference_columns finds % of the 20 columns a till login''s name is kept in', v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.pos_login_reference_columns() r
              WHERE (r.table_name, r.column_name) IN (('staff_pin_vault', 'user_id'), ('profile_outlet_access', 'profile_id'),
                                                      ('push_subscriptions', 'profile_id'), ('profiles', 'id'))) THEN
    RAISE EXCEPTION 'S809 3i: pos_login_reference_columns counts a login''s own state (PIN vault, outlet access, push) as something it recorded';
  END IF;

  -- ── The logins: BLOOM CAFE's POS PIN logins (its supervisor and manager where there are such),
  -- its Owner ───────────────────────────────────────────────────────────────────────────────
  SELECT id INTO v_c FROM public.clients WHERE name = 'BLOOM CAFE';
  SELECT p.id INTO v_sup
    FROM public.profiles p
   WHERE p.role = 'client' AND p.client_id = v_c AND p.pos_email IS NOT NULL
   ORDER BY (p.pos_role = 'supervisor') DESC NULLS LAST, p.id
   LIMIT 1;
  SELECT p.id INTO v_mgr
    FROM public.profiles p
   WHERE p.role = 'client' AND p.client_id = v_c AND p.pos_email IS NOT NULL AND p.id IS DISTINCT FROM v_sup
   ORDER BY (p.pos_role = 'manager') DESC NULLS LAST, p.id
   LIMIT 1;
  SELECT p.id INTO v_owner
    FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c
     AND p.pos_email IS NULL AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY p.id
   LIMIT 1;
  IF v_c IS NULL OR v_sup IS NULL OR v_mgr IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'S809 3i probe: needs BLOOM CAFE, two of its POS PIN logins and its Owner (got %, %, %, %)',
      v_c, v_sup, v_mgr, v_owner;
  END IF;

  BEGIN
    -- Slice 1b's build gate (if a floor is set when this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role ────────────────────────────────────────────────
    -- Both stand-ins lose every other staff marker and any block (a restrictive policy or a leftover
    -- marker would otherwise turn an "allowed" into a vacuous refusal). Each gets a live session.
    UPDATE public.profiles
       SET pos_role = 'supervisor', pos_blocked_at = NULL, pos_blocked_by = NULL, settlement_blocked_by = NULL,
           ims_role = NULL, hr_role = NULL, hr_self_service = false, active_client_id = NULL
     WHERE id = v_sup;
    UPDATE public.profiles
       SET pos_role = 'manager', pos_blocked_at = NULL, pos_blocked_by = NULL, settlement_blocked_by = NULL,
           ims_role = NULL, hr_role = NULL, hr_self_service = false, active_client_id = NULL
     WHERE id = v_mgr;
    UPDATE auth.users SET banned_until = NULL WHERE id IN (v_sup, v_mgr);
    INSERT INTO auth.sessions (id, user_id, created_at, updated_at)
    VALUES (gen_random_uuid(), v_sup, now(), now()), (gen_random_uuid(), v_mgr, now(), now());

    -- ── (a) Recorded rows. Nothing for a login id nobody used; one row once the till names it ─────
    IF EXISTS (SELECT 1 FROM public.pos_login_recorded_rows(v_r)) THEN
      RAISE EXCEPTION 'S809 3i probe: a login id nothing names has recorded rows';
    END IF;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, opened_by)
    VALUES (v_c, 'open', 'S809 3i probe', 990301, v_r);
    SELECT count(*) INTO v_n FROM public.pos_login_recorded_rows(v_r) r
     WHERE r.table_name = 'pos_orders' AND r.column_name = 'opened_by' AND r.n = 1;
    IF v_n <> 1 OR (SELECT count(*) FROM public.pos_login_recorded_rows(v_r)) <> 1 THEN
      RAISE EXCEPTION 'S809 3i probe: an order opened by a login is not counted as the one thing it recorded';
    END IF;

    -- ── (b) As the POS supervisor: it holds its rank, and cannot write the marker itself ──────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)
       OR NOT public.pos_caller_has_rank('supervisor') OR public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S809 3i probe: the stand-in % is not a plain POS supervisor', v_sup;
    END IF;
    BEGIN
      UPDATE public.profiles SET pos_blocked_at = now() WHERE id = v_sup;
      RAISE EXCEPTION 'S809 3i probe: a till login stamped its own block marker';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.pos_set_login_blocked(v_mgr, true, v_sup);
      RAISE EXCEPTION 'S809 3i probe: a signed-in login called pos_set_login_blocked';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM * FROM public.pos_login_recorded_rows(v_mgr);
      RAISE EXCEPTION 'S809 3i probe: a signed-in login called pos_login_recorded_rows';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    -- ── (c) As the Owner: a tablet is activated, and the till's picker lists both stand-ins ───────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SELECT d.device_id, d.device_secret INTO v_dev, v_secret FROM public.register_pos_device(v_c, 'S809 3i probe') d;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    SELECT count(*) INTO v_n FROM public.get_pos_device_staff(v_c, v_dev, v_secret) s WHERE s.id IN (v_sup, v_mgr);
    RESET ROLE;
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'S809 3i probe: before any block the till lists % of the two stand-ins', v_n;
    END IF;

    -- ── (d) The service role blocks the supervisor, as admin-user-ops does for the manager ───────
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    SET LOCAL ROLE service_role;
    v_out := public.pos_set_login_blocked(v_sup, true, v_mgr);
    IF v_out IS DISTINCT FROM 'blocked' THEN
      RAISE EXCEPTION 'S809 3i probe: blocking the supervisor answered %', v_out;
    END IF;
    v_out := public.pos_set_login_blocked(v_sup, true, v_mgr);
    IF v_out IS DISTINCT FROM 'already_blocked' THEN
      RAISE EXCEPTION 'S809 3i probe: blocking twice answered %', v_out;
    END IF;
    RESET ROLE;
    SELECT pos_blocked_at, pos_blocked_by INTO v_ts, v_by FROM public.profiles WHERE id = v_sup;
    IF v_ts IS NULL OR v_by IS DISTINCT FROM v_mgr THEN
      RAISE EXCEPTION 'S809 3i probe: the block left marker % by %', v_ts, v_by;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_sup AND banned_until >= TIMESTAMPTZ '2999-01-01 00:00:00+00')
       OR EXISTS (SELECT 1 FROM auth.sessions WHERE user_id = v_sup)
       OR NOT EXISTS (SELECT 1 FROM auth.sessions WHERE user_id = v_mgr)
       OR EXISTS (SELECT 1 FROM auth.users WHERE id = v_mgr AND banned_until IS NOT NULL) THEN
      RAISE EXCEPTION 'S809 3i probe: the block did not ban exactly the supervisor and end exactly their sessions';
    END IF;

    -- ── (e) The blocked supervisor's still-valid token: no rank, and the marker is not theirs to clear ─
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF COALESCE(public.pos_caller_has_rank('staff'), true) THEN
      RAISE EXCEPTION 'S809 3i probe: a blocked login still holds a POS rank';
    END IF;
    BEGIN
      UPDATE public.profiles SET pos_blocked_at = NULL WHERE id = v_sup;
      RAISE EXCEPTION 'S809 3i probe: a blocked login unblocked itself';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    -- … and the manager, untouched, still holds theirs.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
    IF NOT public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S809 3i probe: blocking the supervisor took the manager''s rank';
    END IF;

    -- ── (f) The till's picker leaves the blocked login out; POS Staff shows when it was blocked ──
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    SELECT count(*) INTO v_n FROM public.get_pos_device_staff(v_c, v_dev, v_secret) s WHERE s.id IN (v_sup, v_mgr);
    IF v_n <> 1 OR EXISTS (SELECT 1 FROM public.get_pos_device_staff(v_c, v_dev, v_secret) s WHERE s.id = v_sup) THEN
      RAISE EXCEPTION 'S809 3i probe: the till''s staff picker still lists the blocked login';
    END IF;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.get_pos_staff_list(v_c) s
     WHERE (s.id = v_sup AND s.pos_blocked_at IS NOT NULL AND NOT s.settlement_blocked)
        OR (s.id = v_mgr AND s.pos_blocked_at IS NULL);
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'S809 3i probe: POS Staff''s list does not say which login is blocked';
    END IF;

    -- ── (g) A blocked manager cannot manage tablets; Unblock gives the rank back ────────────────
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    SET LOCAL ROLE service_role;
    PERFORM public.pos_set_login_blocked(v_mgr, true, v_owner);
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.register_pos_device(v_c, 'S809 3i probe 2');
      RAISE EXCEPTION 'S809 3i probe: a blocked POS manager activated a tablet';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    SET LOCAL ROLE service_role;
    v_out := public.pos_set_login_blocked(v_mgr, false, v_owner);
    IF v_out IS DISTINCT FROM 'unblocked' THEN
      RAISE EXCEPTION 'S809 3i probe: unblocking the manager answered %', v_out;
    END IF;
    v_out := public.pos_set_login_blocked(v_mgr, false, v_owner);
    IF v_out IS DISTINCT FROM 'not_blocked' THEN
      RAISE EXCEPTION 'S809 3i probe: unblocking twice answered %', v_out;
    END IF;
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM auth.users WHERE id = v_mgr AND banned_until IS NOT NULL)
       OR EXISTS (SELECT 1 FROM public.profiles WHERE id = v_mgr AND (pos_blocked_at IS NOT NULL OR pos_blocked_by IS NOT NULL)) THEN
      RAISE EXCEPTION 'S809 3i probe: Unblock left the ban or the marker';
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF NOT public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S809 3i probe: an unblocked manager did not get the rank back';
    END IF;
    RESET ROLE;

    -- ── (h) HR says the supervisor has left: Unblock is refused, and the block stands ───────────
    INSERT INTO public.hr_employees (client_id, full_name, join_date, status)
    VALUES (v_c, 'S809 3i probe leaver', current_date - 400, 'resigned')
    RETURNING id INTO v_emp;
    UPDATE public.profiles SET hr_employee_id = v_emp WHERE id = v_sup;
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    SET LOCAL ROLE service_role;
    BEGIN
      PERFORM public.pos_set_login_blocked(v_sup, false, v_owner);
      RAISE EXCEPTION 'S809 3i probe: a leaver''s login was unblocked';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_unblock_leaver' THEN
        RAISE EXCEPTION 'S809 3i probe: the leaver''s Unblock was refused with hint %', v_hint;
      END IF;
    END;
    RESET ROLE;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_sup AND pos_blocked_at IS NOT NULL) THEN
      RAISE EXCEPTION 'S809 3i probe: a refused Unblock cleared the marker';
    END IF;

    -- ── (i) A login a Final Settlement blocked is HR's: neither Block nor Unblock touches it ─────
    UPDATE public.profiles SET pos_blocked_at = NULL, pos_blocked_by = NULL WHERE id = v_sup;
    INSERT INTO public.hr_final_settlements (client_id, employee_id, last_working_date)
    VALUES (v_c, v_emp, current_date - 10)
    RETURNING id INTO v_fs;
    UPDATE public.profiles SET settlement_blocked_by = v_fs WHERE id = v_sup;
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    SET LOCAL ROLE service_role;
    FOR v_state IN SELECT unnest(ARRAY['block', 'unblock']) LOOP
      BEGIN
        PERFORM public.pos_set_login_blocked(v_sup, v_state = 'block', v_owner);
        RAISE EXCEPTION 'S809 3i probe: % went through on a settlement-blocked login', v_state;
      EXCEPTION WHEN insufficient_privilege THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        IF v_hint IS DISTINCT FROM 'pos_login_settlement_blocked' THEN
          RAISE EXCEPTION 'S809 3i probe: % on a settlement-blocked login was refused with hint %', v_state, v_hint;
        END IF;
      END;
    END LOOP;
    -- Not a till login at all (the Owner): refused, nothing written.
    BEGIN
      PERFORM public.pos_set_login_blocked(v_owner, true, v_mgr);
      RAISE EXCEPTION 'S809 3i probe: the Owner''s login was blocked as a till login';
    EXCEPTION WHEN no_data_found THEN NULL;
    END;
    RESET ROLE;

    -- ── (j) DATABASE-2: a stock movement's source is one of the four. The four pass the CHECK and
    -- then meet the item key (made-up ids); anything else is refused by the CHECK itself ─────────
    FOR v_src IN SELECT unnest(ARRAY['manual', 'pos_sale', 'pos_comp', 'pos_credit_restock', 'pos', 'adjustment']) LOOP
      BEGIN
        INSERT INTO public.stock_movements (client_id, item_id, period_id, bs_day, qty, source)
        VALUES (v_c, gen_random_uuid(), gen_random_uuid(), 1, 1, v_src);
        RAISE EXCEPTION 'S809 3i probe: a stock movement with made-up ids (source %) was stored', v_src;
      EXCEPTION
        WHEN check_violation THEN
          IF v_src IN ('manual', 'pos_sale', 'pos_comp', 'pos_credit_restock') THEN
            RAISE EXCEPTION 'S809 3i probe: the CHECK refused the source %', v_src;
          END IF;
        WHEN foreign_key_violation THEN
          IF v_src NOT IN ('manual', 'pos_sale', 'pos_comp', 'pos_credit_restock') THEN
            RAISE EXCEPTION 'S809 3i probe: the CHECK let the source % through', v_src;
          END IF;
      END;
    END LOOP;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_3i_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_3i_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT proname, md5(prosrc), prosecdef, proacl FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace
--      AND proname IN ('pos_caller_has_rank', 'pos_device_caller_may_manage', 'get_pos_device_staff', 'get_pos_staff_list',
--                      'pos_login_reference_columns', 'pos_login_recorded_rows', 'pos_set_login_blocked');
--     expect pos_caller_has_rank 100bd1bd1e2a1a1c3a6f4cb105a8e887, pos_device_caller_may_manage 10e1c9a74168ad7b407eefb15d820e4d,
--     get_pos_device_staff 8bec27d197fcc3cf7f02de4fbc64c263, get_pos_staff_list c2e0640be747aaad62943a1050e918ae,
--     pos_login_reference_columns 14b0d47437ec832499f6a45b8e4e7585, pos_login_recorded_rows 1e1e63d695aa31ae2efe9293a1662698,
--     pos_set_login_blocked 0793f45a42b2838f951126602cc1d490; prosecdef t for all but pos_login_reference_columns;
--     proacl as in the header for the four replaced, and {postgres=X/postgres,service_role=X/postgres} for the
--     three new.
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name LIKE 'pos_blocked%';   -- 2 rows
--   SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'public.stock_movements'::regclass AND contype = 'c';
--   SELECT count(*) FROM public.pos_login_reference_columns();   -- 46 (44 keys + the two VALUES rows)
--   SELECT count(*) FROM public.profiles WHERE pos_blocked_at IS NOT NULL;   -- 0
