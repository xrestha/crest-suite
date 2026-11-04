-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S875: a leaver's IMS or HR login is blocked, not deleted, so their name stays on what they
-- recorded; and a blocked or settled HR login holds no HR rank for the hour its token lives.
--
--   D36 (POS_DECISIONS.md, S834) / POS_TODO S809.4: deleting an IMS or HR staff login
--   (delete_ims_staff / delete_hr_staff in admin-user-ops) deleted the auth user, and every key from
--   a business table to profiles is ON DELETE SET NULL. The counts, requisitions, gate passes, fixed
--   assets and Owner Reports an IMS login made, and the leave decisions, salary payments, travel
--   claims and roster weeks an HR login made, all lost the name at once, while IMS Staff's confirm
--   said "nothing they entered is touched". Seven more columns hold a login's id with no key at all,
--   so a delete left them pointing at nobody. Owner decision (2026-11-04, asked in plain words):
--   "Block, keep the name", the till's shape (S809 3i, Q17 a): Delete only for a login that
--   recorded nothing.
--
--   CROSS-REPO (S809.4 5e, owner 2026-10-13): hr_is_manager_rank() and the 66 HR rank policies
--   tested the raw hr_role, so a settled HR manager kept manager reach on payroll, attendance and the
--   rest for the hour their token lives. Owner decision (2026-11-04): fix it in the same release,
--   since a block that leaves the rank standing for an hour is half a block. HR is shared with
--   hss-suite: filed in both docs/CROSS-REPO.md files.
--
--     (1) profiles.staff_blocked_at / staff_blocked_by: when IMS Staff or HR Staff blocked the login,
--         and who did. One mark for both pages, because a ban is the whole login's: an IMS manager
--         could already delete a login that also held an HR rank (none does today). Not a staff
--         marker: the login keeps its rank columns, so is_client_owner(), isOwner, isCallerOwner and
--         every restrictive kind policy see it as staff exactly as before. guard_profiles_
--         privileged_columns is an allow-list, so only the service role (through (7)) writes it.
--     (2) hr_caller_has_rank(level): the one HR rank test, the shape of pos_caller_has_rank and
--         ims_caller_has_rank. Admin, the Owner, or an HR login at that rank that neither a Final
--         Settlement nor IMS Staff / HR Staff has blocked. hr_is_manager_rank() becomes a call to it.
--     (3) ims_caller_has_rank refuses a blocked login; ims_can_manage_counts() becomes a call to it
--         (it tested the raw rank and refused no settled login); the counting tablet's staff list
--         leaves a blocked login out.
--     (4) The three bodies that tested a raw HR or IMS rank inline: settings_guard_staff_roles (its
--         HR manager test), hr_backfill_approved_leave and hr_labour_actuals. Patched from their live
--         bodies, one expression each.
--     (5) get_ims_staff_list / get_hr_role_staff_list return staff_blocked_at, so the two pages show
--         "Login blocked" and offer Unblock, and their gate is the effective rank (a blocked or settled
--         manager no longer reads every staff email). A changed result type: dropped and created
--         again, with the live grants.
--     (6) login_reference_columns() / login_recorded_rows(uuid): what a login has recorded, for all
--         three Delete actions. pos_login_reference_columns() read every non-cascading key to a login
--         from the catalog already; this is the same read under a module-free name, plus the
--         key-less columns of every module. The pos_ pair stays, as calls to these, for the deployed
--         admin-user-ops until it is redeployed.
--     (7) staff_set_login_blocked(uuid, boolean, uuid): the block in one transaction, as
--         pos_set_login_blocked: stamp, ban (banned_until 2999), end every session; Unblock clears
--         the stamp and the ban. For IMS and HR logins (email and counting PIN), never a till PIN
--         login (POS Staff blocks those). Refused for a login a Final Settlement blocked, and an
--         Unblock is refused while HR shows any employee record of the login as gone.
--     (8) The 66 HR rank policies (22 tables x insert/update/delete, S748-S751 and S798) call (2).
--   A login is never blocked twice over: Finalize leaves an already-banned login alone (it does not
--   stamp it), and (7) refuses a login a settlement stamped. So Reopen never unbans a staff block,
--   and Unblock never lifts a settlement's.
--
-- Built on the LIVE bodies (pg_get_functiondef and md5(prosrc), read 2026-11-04). Section 0 refuses
-- to run over any other body; a body that already carries this migration's change passes, so a
-- re-run is safe.
--   ims_caller_has_rank(text)                 b1b5a0e6f6c73e7a819923d8ca43c2f9
--   ims_can_manage_counts()                   e068c44951d87177769328e02c85f49f  (saved with CRLF)
--   get_ims_count_staff(uuid,uuid)            c47f2d0337b9285b950792c1e1622602
--   get_ims_staff_list(uuid)                  934390702f737ac7932c3fbbefe99dda
--   get_hr_role_staff_list(uuid)              5890db0c198721abed489e54c60bbe7f
--   hr_is_manager_rank()                      14848021b334c6bf699b4dba604a313b
--   settings_guard_staff_roles()              abf734e95ffbb8192c90db5070602bb2
--   hr_backfill_approved_leave(uuid)          9187290148b0e769c5a77a1bac021d41
--   hr_labour_actuals(uuid,date,date)         18b31339ff4195238ce7f86274b901f8
--   pos_login_reference_columns()             14b0d47437ec832499f6a45b8e4e7585
--   pos_login_recorded_rows(uuid)             1e1e63d695aa31ae2efe9293a1662698
-- Grants read live: the rank helpers and both lists {postgres, authenticated, service_role};
-- get_ims_count_staff adds anon (the counting tablet reads it before a session); the pos_ pair
-- {postgres, service_role}; settings_guard_staff_roles {postgres} (a trigger function).
-- Not changed: finalize_final_settlement, reopen_final_settlement and hr_unblock_rehired_logins (they
-- act only on settlement-stamped logins); pos_set_login_blocked and pos_caller_has_rank (a till PIN
-- login is never an IMS or HR login); is_hr_staff_rank() (a read fence on pay, not a grant of rank).
--
-- Live before this migration (2026-11-04): 2 IMS email logins and 1 HR login (all CASA ACAI CAFE),
-- 5 counting PIN logins (CASA 3, BLOOM CAFE 1, Test 1); none settlement-blocked; none holds both an
-- IMS and an HR rank. 64 single-column keys from public tables to profiles or auth.users (29 on till
-- tables); 66 HR rank policies, each one of two exact shapes.
--
-- Ship order: this migration, then admin-user-ops (it calls (6) and (7) and reads the new column)
-- and ims-staff-login, then the app. The app before the function: Block is answered "Forbidden" and
-- nothing else changes. The function before this migration: every Delete refuses (the record read
-- fails, 503), nothing is lost.
--
-- Section 9 runs as CASA ACAI CAFE's HR manager and IMS manager inside a block that rolls itself
-- back. If any check fails, the whole migration fails and nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces are the ones it was built on ─────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.ims_caller_has_rank(text)',              'b1b5a0e6f6c73e7a819923d8ca43c2f9', 'staff_blocked_at'),
      ('public.ims_can_manage_counts()',                'e068c44951d87177769328e02c85f49f', 'ims_caller_has_rank'),
      ('public.get_ims_count_staff(uuid,uuid)',         'c47f2d0337b9285b950792c1e1622602', 'staff_blocked_at'),
      ('public.get_ims_staff_list(uuid)',               '934390702f737ac7932c3fbbefe99dda', 'staff_blocked_at'),
      ('public.get_hr_role_staff_list(uuid)',           '5890db0c198721abed489e54c60bbe7f', 'staff_blocked_at'),
      ('public.hr_is_manager_rank()',                   '14848021b334c6bf699b4dba604a313b', 'hr_caller_has_rank'),
      ('public.settings_guard_staff_roles()',           'abf734e95ffbb8192c90db5070602bb2', 'hr_caller_has_rank'),
      ('public.hr_backfill_approved_leave(uuid)',       '9187290148b0e769c5a77a1bac021d41', 'hr_caller_has_rank'),
      ('public.hr_labour_actuals(uuid,date,date)',      '18b31339ff4195238ce7f86274b901f8', 'hr_caller_has_rank'),
      ('public.pos_login_reference_columns()',          '14b0d47437ec832499f6a45b8e4e7585', 'login_reference_columns()'),
      ('public.pos_login_recorded_rows(uuid)',          '1e1e63d695aa31ae2efe9293a1662698', 'login_recorded_rows(')
    ) v(sig, md5, done_marker)
  LOOP
    PERFORM 1 FROM pg_proc p
     WHERE p.oid = r.sig::regprocedure
       AND (md5(p.prosrc) = r.md5 OR position(r.done_marker IN p.prosrc) > 0);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'S875: % changed since this migration was drafted (live md5 %) — merge its section onto the live body and update section 0',
        r.sig, (SELECT md5(prosrc) FROM pg_proc WHERE oid = r.sig::regprocedure);
    END IF;
  END LOOP;
END;
$$;


-- ── 1. The block marker ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS staff_blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS staff_blocked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.profiles.staff_blocked_at IS
  'S875: when IMS Staff or HR Staff blocked this login (banned, sessions ended, kept so its name stays on what it recorded). NULL = not blocked. Written only by staff_set_login_blocked (service role). Not a staff marker.';
COMMENT ON COLUMN public.profiles.staff_blocked_by IS
  'S875: the login that blocked this one from IMS Staff or HR Staff. NULL after a restore, or once that login is deleted.';


-- ── 2. One HR rank test ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_caller_has_rank(p_min text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(public.is_admin(), false)
      OR COALESCE(public.is_client_owner(), false)
      OR COALESCE((
           SELECT p.settlement_blocked_by IS NULL
              -- S875: a login IMS Staff or HR Staff blocked holds no rank either, so the token it
              -- still carries for up to an hour is refused by every HR rule at once.
              AND p.staff_blocked_at IS NULL
              AND CASE p_min
                    WHEN 'staff'      THEN p.hr_role IN ('staff', 'supervisor', 'manager')
                    WHEN 'supervisor' THEN p.hr_role IN ('supervisor', 'manager')
                    WHEN 'manager'    THEN p.hr_role = 'manager'
                  END
             FROM profiles p
            WHERE p.id = (select auth.uid())), false)
$function$;
REVOKE ALL ON FUNCTION public.hr_caller_has_rank(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hr_caller_has_rank(text) TO authenticated, service_role;
COMMENT ON FUNCTION public.hr_caller_has_rank(text) IS
  'S875: admin, the Owner, or an HR login at that rank (staff | supervisor | manager) that no Final Settlement and no IMS Staff / HR Staff block has blocked. The one HR rank test; the HR rank policies and hr_is_manager_rank() call it.';

-- Same contract as before (admin, Owner or HR manager), now through the one test.
CREATE OR REPLACE FUNCTION public.hr_is_manager_rank()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- S875: through hr_caller_has_rank, so a settled or blocked manager is refused.
  SELECT COALESCE(public.hr_caller_has_rank('manager'), false)
$function$;


-- ── 3. IMS: the rank test, the count fences' manager test and the counting tablet's list ───────
CREATE OR REPLACE FUNCTION public.ims_caller_has_rank(p_min text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(public.is_admin(), false)
      OR COALESCE(public.is_client_owner(), false)
      OR COALESCE((
           SELECT p.settlement_blocked_by IS NULL
              AND p.staff_blocked_at IS NULL   -- S875: a login IMS Staff or HR Staff blocked
              AND p.ims_email IS NULL
              AND CASE p_min
                    WHEN 'staff'      THEN p.ims_role IN ('staff', 'supervisor', 'manager')
                    WHEN 'supervisor' THEN p.ims_role IN ('supervisor', 'manager')
                    WHEN 'manager'    THEN p.ims_role = 'manager'
                  END
             FROM profiles p
            WHERE p.id = (select auth.uid())), false)
$function$;

-- Was admin, Owner or the raw ims_role = 'manager': a settled manager kept it. A counting PIN is
-- always rank staff (S756), so leaving ims_email out changes nothing for one.
CREATE OR REPLACE FUNCTION public.ims_can_manage_counts()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- S875: through ims_caller_has_rank, so a settled or blocked manager is refused.
  SELECT COALESCE(public.ims_caller_has_rank('manager'), false)
$function$;

CREATE OR REPLACE FUNCTION public.get_ims_count_staff(p_client_id uuid, p_device_secret uuid)
 RETURNS TABLE(id uuid, full_name text, ims_job_title text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM client_secrets cs
                  WHERE cs.client_id = p_client_id AND cs.ims_device_secret = p_device_secret) THEN
    RAISE EXCEPTION 'ims_device_not_active' USING ERRCODE = '28000',
      HINT = 'This counting tablet needs the setup code scanned again.';
  END IF;

  RETURN QUERY
    SELECT p.id::uuid, p.full_name::text, p.ims_job_title::text
      FROM profiles p
     WHERE p.client_id = p_client_id
       AND p.ims_role IS NOT NULL
       AND p.ims_email IS NOT NULL
       AND p.settlement_blocked_by IS NULL
       AND p.staff_blocked_at IS NULL   -- S875: a blocked counting PIN is off the tablet's list
     ORDER BY p.full_name;
END;
$function$;


-- ── 4. Three bodies that tested a raw rank inline, patched from the live body ─────────────────
-- One expression each, matched with flexible whitespace and required to match exactly once; the
-- result must name the shared test and no longer the raw column. CREATE OR REPLACE keeps the grants.
DO $$
DECLARE
  r record;
  v_def text;
  v_new text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.settings_guard_staff_roles()',
       $re$v_hr_manager := COALESCE\(v_me\.hr_role = 'manager' AND v_me\.settlement_blocked_by IS NULL, false\);$re$,
       $rp$v_hr_manager := COALESCE(public.hr_caller_has_rank('manager'), false);  -- S875: a blocked login too$rp$,
       $gone$v_me.hr_role = 'manager'$gone$),
      ('public.hr_backfill_approved_leave(uuid)',
       $re$OR EXISTS \(SELECT 1 FROM profiles p\s+WHERE p\.id = \(select auth\.uid\(\)\)\s+AND \(\(p\.ims_role IN \('supervisor', 'manager'\) AND p\.ims_email IS NULL\)\s+OR p\.hr_role IN \('supervisor', 'manager'\)\)\)\)\),$re$,
       $rp$OR COALESCE(public.ims_caller_has_rank('supervisor'), false)   -- S875: never a count PIN, a settled or a blocked login
                OR COALESCE(public.hr_caller_has_rank('supervisor'), false))),$rp$,
       $gone$p.hr_role IN$gone$),
      ('public.hr_labour_actuals(uuid,date,date)',
       $re$OR EXISTS \(SELECT 1 FROM profiles pr\s+WHERE pr\.id = \(select auth\.uid\(\)\)\s+AND pr\.hr_role IN \('supervisor', 'manager'\)\)\)\),$re$,
       $rp$OR COALESCE(public.hr_caller_has_rank('supervisor'), false))),   -- S875: never a settled or blocked login$rp$,
       $gone$pr.hr_role IN$gone$)
    ) v(sig, pattern, replacement, gone)
  LOOP
    v_def := pg_get_functiondef(r.sig::regprocedure);
    IF position('hr_caller_has_rank' IN v_def) > 0 THEN
      CONTINUE;  -- already patched (a re-run)
    END IF;
    IF (SELECT count(*) FROM regexp_matches(v_def, r.pattern, 'g')) <> 1 THEN
      RAISE EXCEPTION 'S875: the rank expression in % was not found exactly once — read the live body and update section 4', r.sig;
    END IF;
    v_new := regexp_replace(v_def, r.pattern, r.replacement);
    IF position(r.gone IN v_new) > 0 OR position('hr_caller_has_rank' IN v_new) = 0 THEN
      RAISE EXCEPTION 'S875: % still tests the raw rank after the patch', r.sig;
    END IF;
    EXECUTE v_new;
  END LOOP;
END;
$$;


-- ── 5. IMS Staff and HR Staff see which logins are blocked ────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_ims_staff_list(uuid);
CREATE FUNCTION public.get_ims_staff_list(p_client_id uuid)
 RETURNS TABLE(id uuid, full_name text, email text, ims_role text, ims_job_title text, last_seen_at timestamp with time zone, hr_employee_id uuid, employee_code text, has_pin boolean, settlement_blocked boolean, staff_blocked_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
BEGIN
  SELECT COALESCE(p.active_client_id, p.client_id) INTO caller_client_id
  FROM profiles p WHERE p.id = auth.uid();

  -- Admin, the client Owner, or an IMS MANAGER of that client — the S729 rule (20260910120000):
  -- this list returns every IMS login's real sign-in email. 20260910150000 (S737) re-created the
  -- function to fix its result types and lost the rank check in the copy; 20260914190000 put it
  -- back. S875: the manager test is ims_caller_has_rank (admin and the Owner included), so a settled
  -- or blocked manager no longer reads the list. COALESCE: NULL for a profile-less session.
  IF COALESCE(
       public.is_admin()
       OR (caller_client_id = p_client_id AND public.ims_caller_has_rank('manager')),
       false)
  THEN
    RETURN QUERY
      SELECT p.id::uuid,
             p.full_name::text,
             -- NULL for a PIN account: nobody types the synthetic address, and it is half a
             -- credential, so it has no reason to leave the server.
             (CASE WHEN p.ims_email IS NULL THEN u.email ELSE NULL END)::text,
             p.ims_role::text,
             p.ims_job_title::text,
             p.last_seen_at::timestamptz,
             p.hr_employee_id::uuid,
             e.employee_code::text,
             (p.ims_email IS NOT NULL)::boolean,
             -- S798 3b (PEOPLE-ACCESS-4): blocked by a Final Settlement, shown as POS Staff shows it.
             (p.settlement_blocked_by IS NOT NULL)::boolean,
             p.staff_blocked_at::timestamptz   -- S875: when IMS Staff or HR Staff blocked it; NULL = not
      FROM profiles p
      JOIN auth.users u ON u.id = p.id
      LEFT JOIN hr_employees e ON e.id = p.hr_employee_id
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.ims_role IS NOT NULL
      ORDER BY p.full_name;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_ims_staff_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ims_staff_list(uuid) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_hr_role_staff_list(uuid);
CREATE FUNCTION public.get_hr_role_staff_list(p_client_id uuid)
 RETURNS TABLE(id uuid, full_name text, email text, hr_role text, hr_job_title text, last_seen_at timestamp with time zone, hr_employee_id uuid, employee_code text, settlement_blocked boolean, employee_name text, email_employee_name text, staff_blocked_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
BEGIN
  SELECT COALESCE(p.active_client_id, p.client_id) INTO caller_client_id
  FROM profiles p WHERE p.id = auth.uid();

  -- S875: the manager test is hr_caller_has_rank (admin and the Owner included), so a settled or
  -- blocked manager no longer reads every HR login's email.
  IF COALESCE(
       public.is_admin()
       OR (caller_client_id = p_client_id AND public.hr_caller_has_rank('manager')),
       false)
  THEN
    RETURN QUERY
      SELECT p.id, p.full_name, u.email::text, p.hr_role, p.hr_job_title, p.last_seen_at, p.hr_employee_id, e.employee_code,
             (p.settlement_blocked_by IS NOT NULL)::boolean,  -- S798 3b (PEOPLE-ACCESS-4)
             e.full_name::text,                               -- S798 3f-1
             (SELECT em.full_name FROM hr_employees em
               WHERE em.client_id = p_client_id
                 AND NULLIF(btrim(em.email), '') IS NOT NULL
                 AND lower(btrim(em.email)) = lower(u.email::text)
               ORDER BY em.full_name LIMIT 1)::text,
             p.staff_blocked_at                               -- S875; NULL = not blocked
      FROM profiles p
      JOIN auth.users u ON u.id = p.id
      LEFT JOIN hr_employees e ON e.id = p.hr_employee_id
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.hr_role IS NOT NULL
      ORDER BY p.full_name;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_hr_role_staff_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_hr_role_staff_list(uuid) TO authenticated, service_role;


-- ── 6. What a login has recorded, for every module ────────────────────────────────────────────
-- Every column that would lose this login's name if the login were deleted. Read from the catalog
-- so the next table with a "who" key is counted without anyone remembering to add it here: a
-- single-column foreign key from a public table to profiles or auth.users whose delete action is
-- anything but CASCADE (CASCADE rows are the login's own state: its PIN vault row, outlet ticks,
-- push subscriptions, checklist, count sections, employee links). The VALUES rows hold a login's id
-- with no key at all; a delete leaves them naming nobody. Left out on purpose: audit_logs.user_id
-- (each row keeps user_name), pos_print_jobs.created_by (a print queue, never shown by name) and
-- hr_final_settlements.paid_adjustments[].by (inside jsonb). INVOKER and no client grant: only the
-- DEFINER function below calls it.
CREATE OR REPLACE FUNCTION public.login_reference_columns()
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
  VALUES ('pos_orders', 'opened_by'),                  -- the till's "who opened this table" (Covers Report)
         ('pos_order_items', 'comped_by'),             -- who made a dish complimentary (apply_pos_item_comps)
         ('ims_stock_transfers', 'sent_by'),           -- S875: the transfer's sender (with sent_by_name)
         ('ims_stock_transfers', 'ended_by'),          -- S875: who received, returned or cancelled it
         ('ims_stock_transfer_lines', 'created_by'),   -- S875: each leg's line writer
         ('demand_forecast_run_log', 'run_by'),        -- S875: who ran the forecast (with run_by_name)
         ('hr_leave_requests', 'decided_by'),          -- S875: who approved or rejected the leave
         ('hr_final_settlements', 'reopened_by'),      -- S875: who reopened a settlement
         ('hr_advances', 'written_off_by')             -- S875: who wrote an advance off
  ORDER BY 1, 2
$function$;
REVOKE ALL ON FUNCTION public.login_reference_columns() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.login_reference_columns() TO service_role;

-- The count per column, only where it is not 0. Unfiltered by outlet: a login with access to a
-- sibling outlet records there too, and a delete would take its name off those rows as well. The
-- "who" columns are deliberately unindexed (supabase-sql.md, S543), so each count is a table scan;
-- this runs once per Delete press, never on a page load.
CREATE OR REPLACE FUNCTION public.login_recorded_rows(p_profile_id uuid)
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
  FOR r IN SELECT c.table_name AS t, c.column_name AS col FROM public.login_reference_columns() c LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I = $1', r.t, r.col) INTO n USING p_profile_id;
    IF n > 0 THEN
      table_name := r.t;
      column_name := r.col;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$function$;
REVOKE ALL ON FUNCTION public.login_recorded_rows(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.login_recorded_rows(uuid) TO service_role;

-- The till's pair, kept for the admin-user-ops deployed before this release (delete_pos_staff calls
-- pos_login_recorded_rows). Same signatures, results and grants; one list now.
CREATE OR REPLACE FUNCTION public.pos_login_reference_columns()
 RETURNS TABLE(table_name text, column_name text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT * FROM public.login_reference_columns()   -- S875: one list for every module
$function$;

CREATE OR REPLACE FUNCTION public.pos_login_recorded_rows(p_profile_id uuid)
 RETURNS TABLE(table_name text, column_name text, n bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT * FROM public.login_recorded_rows(p_profile_id)   -- S875: one list for every module
$function$;


-- ── 7. Block and Unblock an IMS or HR login, in one transaction ───────────────────────────────
-- Called by admin-user-ops' block_ims_staff / unblock_ims_staff / block_hr_staff / unblock_hr_staff
-- after it has checked the caller's rank and the target (requireStaffTarget, requireManageableTarget),
-- with p_actor the verified caller. The ban is the one Final Settlement writes (banned_until
-- 2999-12-31), and ending the sessions takes their refresh tokens with them: a password or counting
-- PIN sign-in then gets "user_banned" from GoTrue, a signed-in page can no longer refresh, and
-- sections 2-4 refuse its remaining access token every rank. Returns what happened: 'blocked',
-- 'already_blocked', 'unblocked' or 'not_blocked'.
CREATE OR REPLACE FUNCTION public.staff_set_login_blocked(p_profile_id uuid, p_blocked boolean, p_actor uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p profiles;
BEGIN
  IF p_blocked IS NULL THEN
    RAISE EXCEPTION 'staff_set_login_blocked: say whether to block or unblock' USING ERRCODE = '22004';
  END IF;

  SELECT * INTO p FROM profiles x WHERE x.id = p_profile_id FOR UPDATE;
  -- An IMS or HR staff login of a client. A till PIN login (pos_email) is POS Staff's to block, and
  -- a login with no IMS or HR rank is not staff here (the Owner, a Self-Service employee).
  IF NOT FOUND OR p.role IS DISTINCT FROM 'client' OR p.pos_email IS NOT NULL
     OR (p.ims_role IS NULL AND p.hr_role IS NULL) THEN
    RAISE EXCEPTION 'staff_login_not_found: this is not an IMS or HR staff login'
      USING ERRCODE = 'P0002', HINT = 'staff_login_not_found';
  END IF;
  -- A Final Settlement's block is HR's: Reopen or a rehire undoes it (and unbans exactly the logins it
  -- stamped). A staff block on top would be lifted by that Reopen without anyone asking.
  IF p.settlement_blocked_by IS NOT NULL THEN
    RAISE EXCEPTION 'staff_login_settlement_blocked: this login was blocked by a Final Settlement, which keeps it blocked until the settlement is reopened or the person is rehired in HR'
      USING ERRCODE = '42501', HINT = 'staff_login_settlement_blocked';
  END IF;

  IF p_blocked THEN
    IF p.staff_blocked_at IS NOT NULL THEN
      RETURN 'already_blocked';
    END IF;
    UPDATE profiles SET staff_blocked_at = now(), staff_blocked_by = p_actor WHERE id = p.id;
    UPDATE auth.users SET banned_until = TIMESTAMPTZ '2999-12-31 00:00:00+00' WHERE id = p.id;
    DELETE FROM auth.sessions WHERE user_id = p.id;
    RETURN 'blocked';
  END IF;

  IF p.staff_blocked_at IS NULL THEN
    RETURN 'not_blocked';
  END IF;
  -- Unblock is for a block made by mistake. Someone HR shows as gone (resigned, terminated, retired)
  -- at any outlet, on the home record (hr_employee_id) or a linked one (profile_employee_links, S798
  -- 3f-1), comes back through a rehire in HR → Employees first. pos_set_login_blocked's S835 test.
  IF EXISTS (SELECT 1 FROM hr_employees e
              WHERE (e.id = p.hr_employee_id
                     OR e.id IN (SELECT l.employee_id FROM profile_employee_links l WHERE l.profile_id = p.id))
                AND e.status NOT IN ('active', 'probation')) THEN
    RAISE EXCEPTION 'staff_unblock_leaver: HR shows this login''s employee as no longer working here, so the login stays blocked'
      USING ERRCODE = '42501', HINT = 'staff_unblock_leaver';
  END IF;
  UPDATE profiles SET staff_blocked_at = NULL, staff_blocked_by = NULL WHERE id = p.id;
  UPDATE auth.users SET banned_until = NULL WHERE id = p.id;
  RETURN 'unblocked';
END;
$function$;
REVOKE ALL ON FUNCTION public.staff_set_login_blocked(uuid, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_set_login_blocked(uuid, boolean, uuid) TO service_role;


-- ── 8. The HR rank policies call the one test ─────────────────────────────────────────────────
-- Each was COALESCE((SELECT is_admin()) OR (SELECT is_client_owner()) OR (SELECT p.hr_role FROM
-- profiles p WHERE p.id = (SELECT auth.uid())) <rank test>, false): the raw rank, so a settled or
-- blocked login kept it. ALTER POLICY changes only the expression: command, roles and RESTRICTIVE
-- stay as they are. The list is the live catalog's, read 2026-11-04; section 9 asserts none is left.
-- Manager rank: the money tables (S751) and hr_employees (S798).
ALTER POLICY hr_advance_repayments_write_rank_delete ON public.hr_advance_repayments USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_advance_repayments_write_rank_insert ON public.hr_advance_repayments WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_advance_repayments_write_rank_update ON public.hr_advance_repayments USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_advances_write_rank_delete ON public.hr_advances USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_advances_write_rank_insert ON public.hr_advances WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_advances_write_rank_update ON public.hr_advances USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_employees_write_rank_delete ON public.hr_employees USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_employees_write_rank_insert ON public.hr_employees WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_employees_write_rank_update ON public.hr_employees USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_festival_allowances_write_rank_delete ON public.hr_festival_allowances USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_festival_allowances_write_rank_insert ON public.hr_festival_allowances WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_festival_allowances_write_rank_update ON public.hr_festival_allowances USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_final_settlements_write_rank_delete ON public.hr_final_settlements USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_final_settlements_write_rank_insert ON public.hr_final_settlements WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_final_settlements_write_rank_update ON public.hr_final_settlements USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_incentive_configs_write_rank_delete ON public.hr_incentive_configs USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_incentive_configs_write_rank_insert ON public.hr_incentive_configs WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_incentive_configs_write_rank_update ON public.hr_incentive_configs USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_incentives_write_rank_delete ON public.hr_incentives USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_incentives_write_rank_insert ON public.hr_incentives WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_incentives_write_rank_update ON public.hr_incentives USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_payroll_runs_write_rank_delete ON public.hr_payroll_runs USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_payroll_runs_write_rank_insert ON public.hr_payroll_runs WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_payroll_runs_write_rank_update ON public.hr_payroll_runs USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_payslips_write_rank_delete ON public.hr_payslips USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_payslips_write_rank_insert ON public.hr_payslips WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_payslips_write_rank_update ON public.hr_payslips USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_salary_components_write_rank_delete ON public.hr_salary_components USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_salary_components_write_rank_insert ON public.hr_salary_components WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_salary_components_write_rank_update ON public.hr_salary_components USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_salary_payments_write_rank_delete ON public.hr_salary_payments USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_salary_payments_write_rank_insert ON public.hr_salary_payments WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));
ALTER POLICY hr_salary_payments_write_rank_update ON public.hr_salary_payments USING (COALESCE((SELECT public.hr_caller_has_rank('manager')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('manager')), false));

-- Supervisor rank: the day-to-day tables (S748, S749) and travel claims (S751).
ALTER POLICY hr_attendance_write_rank_delete ON public.hr_attendance USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_attendance_write_rank_insert ON public.hr_attendance WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_attendance_write_rank_update ON public.hr_attendance USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_holiday_calendar_write_rank_delete ON public.hr_holiday_calendar USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_holiday_calendar_write_rank_insert ON public.hr_holiday_calendar WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_holiday_calendar_write_rank_update ON public.hr_holiday_calendar USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_leave_requests_write_rank_delete ON public.hr_leave_requests USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_leave_requests_write_rank_insert ON public.hr_leave_requests WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_leave_requests_write_rank_update ON public.hr_leave_requests USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_leave_types_write_rank_delete ON public.hr_leave_types USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_leave_types_write_rank_insert ON public.hr_leave_types WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_leave_types_write_rank_update ON public.hr_leave_types USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_overtime_entries_write_rank_delete ON public.hr_overtime_entries USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_overtime_entries_write_rank_insert ON public.hr_overtime_entries WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_overtime_entries_write_rank_update ON public.hr_overtime_entries USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_roster_write_rank_delete ON public.hr_roster USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_roster_write_rank_insert ON public.hr_roster WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_roster_write_rank_update ON public.hr_roster USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_roster_publish_state_write_rank_delete ON public.hr_roster_publish_state USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_roster_publish_state_write_rank_insert ON public.hr_roster_publish_state WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_roster_publish_state_write_rank_update ON public.hr_roster_publish_state USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_shift_swap_requests_write_rank_delete ON public.hr_shift_swap_requests USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_shift_swap_requests_write_rank_insert ON public.hr_shift_swap_requests WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_shift_swap_requests_write_rank_update ON public.hr_shift_swap_requests USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_shift_types_write_rank_delete ON public.hr_shift_types USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_shift_types_write_rank_insert ON public.hr_shift_types WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_shift_types_write_rank_update ON public.hr_shift_types USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_tada_claim_items_write_rank_delete ON public.hr_tada_claim_items USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_tada_claim_items_write_rank_insert ON public.hr_tada_claim_items WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_tada_claim_items_write_rank_update ON public.hr_tada_claim_items USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_tada_claims_write_rank_delete ON public.hr_tada_claims USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_tada_claims_write_rank_insert ON public.hr_tada_claims WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));
ALTER POLICY hr_tada_claims_write_rank_update ON public.hr_tada_claims USING (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false)) WITH CHECK (COALESCE((SELECT public.hr_caller_has_rank('supervisor')), false));


-- ── 9. Read back, and probe as real logins in a block that rolls itself back ───────────────────
DO $$
DECLARE
  v_n bigint;
BEGIN
  -- No HR rank policy tests the raw column any more, and all 66 call the one test.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public'
     AND (COALESCE(qual, '') ~ 'p\.hr_role' OR COALESCE(with_check, '') ~ 'p\.hr_role');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'S875: % policies still test the raw hr_role', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public'
     AND (COALESCE(qual, '') ~ 'hr_caller_has_rank' OR COALESCE(with_check, '') ~ 'hr_caller_has_rank');
  IF v_n <> 66 THEN
    RAISE EXCEPTION 'S875: % policies call hr_caller_has_rank, expected 66', v_n;
  END IF;

  -- The two lists return the mark.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.get_ims_staff_list(uuid)'::regprocedure
                  AND 'staff_blocked_at' = ANY (proargnames))
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.get_hr_role_staff_list(uuid)'::regprocedure
                  AND 'staff_blocked_at' = ANY (proargnames)) THEN
    RAISE EXCEPTION 'S875: a staff list does not return staff_blocked_at';
  END IF;

  -- Grants: the block and the record count are the service role's alone; the rank test is for
  -- signed-in sessions; the lists keep theirs.
  IF has_function_privilege('authenticated', 'public.staff_set_login_blocked(uuid,boolean,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.staff_set_login_blocked(uuid,boolean,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.staff_set_login_blocked(uuid,boolean,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.login_recorded_rows(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.login_reference_columns()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.login_recorded_rows(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.hr_caller_has_rank(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.hr_caller_has_rank(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_ims_staff_list(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_ims_staff_list(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_hr_role_staff_list(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_hr_role_staff_list(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.get_ims_count_staff(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S875: a grant is not as intended';
  END IF;

  -- The record list holds the key-less columns and the new mark's key.
  SELECT count(*) INTO v_n FROM public.login_reference_columns() c
   WHERE (c.table_name || '.' || c.column_name) IN (
     'pos_orders.opened_by', 'pos_order_items.comped_by', 'ims_stock_transfers.sent_by',
     'ims_stock_transfers.ended_by', 'ims_stock_transfer_lines.created_by', 'demand_forecast_run_log.run_by',
     'hr_leave_requests.decided_by', 'hr_final_settlements.reopened_by', 'hr_advances.written_off_by',
     'profiles.staff_blocked_by', 'closing_stock.counted_by', 'requisitions.requested_by');
  IF v_n <> 12 THEN
    RAISE EXCEPTION 'S875: login_reference_columns() is missing a column (% of 12)', v_n;
  END IF;
END;
$$;

-- CASA ACAI CAFE's HR manager and IMS manager (live 2026-11-04). Everything inside the inner block
-- is undone by its closing RAISE; the results survive in v_fail.
DO $$
DECLARE
  c_hr     constant uuid := '01ab36e5-6d62-47b8-9a05-587034eff7c4';
  c_ims    constant uuid := '48fc1f16-76e3-4b44-b66a-9469e0f690e9';
  c_client constant uuid := '3508bf4e-b17b-4b53-a8de-65e07928c4d9';
  v_fail text := '';
  v_out  text;
  v_n    bigint;
  v_till uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = c_hr AND client_id = c_client AND hr_role = 'manager'
                    AND settlement_blocked_by IS NULL)
     OR NOT EXISTS (SELECT 1 FROM profiles WHERE id = c_ims AND client_id = c_client AND ims_role = 'manager'
                    AND ims_email IS NULL AND settlement_blocked_by IS NULL)
     OR NOT EXISTS (SELECT 1 FROM hr_leave_types WHERE client_id = c_client) THEN
    RAISE EXCEPTION 'S875: the probe logins at CASA ACAI CAFE are not as they were on 2026-11-04 — pick two others and update section 9';
  END IF;
  SELECT id INTO v_till FROM profiles WHERE pos_email IS NOT NULL LIMIT 1;

  BEGIN
    -- ── HR: the manager holds rank, and the rank policy lets their write through ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', c_hr, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.hr_caller_has_rank('manager'), false) THEN v_fail := v_fail || ' hr:unblocked-not-manager'; END IF;
    IF NOT COALESCE(public.hr_is_manager_rank(), false) THEN v_fail := v_fail || ' hr:is_manager_rank-false'; END IF;
    SET LOCAL ROLE authenticated;
    UPDATE hr_leave_types SET name = name WHERE client_id = c_client;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    IF v_n = 0 THEN v_fail := v_fail || ' hr:policy-refused-unblocked-manager'; END IF;

    -- Block: stamped, banned, sessions gone, no rank, and the same write now changes nothing.
    v_out := public.staff_set_login_blocked(c_hr, true, NULL);
    IF v_out <> 'blocked' THEN v_fail := v_fail || ' hr:block-returned-' || v_out; END IF;
    IF public.staff_set_login_blocked(c_hr, true, NULL) <> 'already_blocked' THEN v_fail := v_fail || ' hr:second-block'; END IF;
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = c_hr AND staff_blocked_at IS NOT NULL) THEN v_fail := v_fail || ' hr:no-stamp'; END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = c_hr AND banned_until > now()) THEN v_fail := v_fail || ' hr:not-banned'; END IF;
    IF EXISTS (SELECT 1 FROM auth.sessions WHERE user_id = c_hr) THEN v_fail := v_fail || ' hr:session-left'; END IF;
    IF COALESCE(public.hr_caller_has_rank('staff'), false) THEN v_fail := v_fail || ' hr:blocked-has-rank'; END IF;
    IF COALESCE(public.hr_is_manager_rank(), false) THEN v_fail := v_fail || ' hr:blocked-is-manager'; END IF;
    SET LOCAL ROLE authenticated;
    UPDATE hr_leave_types SET name = name WHERE client_id = c_client;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    IF v_n <> 0 THEN v_fail := v_fail || ' hr:policy-let-blocked-write-through'; END IF;
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.get_hr_role_staff_list(c_client);
    RESET ROLE;
    IF v_n <> 0 THEN v_fail := v_fail || ' hr:blocked-manager-reads-list'; END IF;

    -- Unblock: stamp and ban cleared, rank back.
    v_out := public.staff_set_login_blocked(c_hr, false, NULL);
    IF v_out <> 'unblocked' THEN v_fail := v_fail || ' hr:unblock-returned-' || v_out; END IF;
    IF EXISTS (SELECT 1 FROM auth.users WHERE id = c_hr AND banned_until IS NOT NULL) THEN v_fail := v_fail || ' hr:still-banned'; END IF;
    IF NOT COALESCE(public.hr_caller_has_rank('manager'), false) THEN v_fail := v_fail || ' hr:unblocked-rank-not-back'; END IF;

    -- ── IMS: rank, the count fences' manager test, and the list ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', c_ims, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.ims_caller_has_rank('manager'), false) THEN v_fail := v_fail || ' ims:unblocked-not-manager'; END IF;
    IF NOT COALESCE(public.ims_can_manage_counts(), false) THEN v_fail := v_fail || ' ims:cannot-manage-counts'; END IF;
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.get_ims_staff_list(c_client);
    RESET ROLE;
    IF v_n = 0 THEN v_fail := v_fail || ' ims:manager-reads-no-list'; END IF;
    IF public.staff_set_login_blocked(c_ims, true, c_hr) <> 'blocked' THEN v_fail := v_fail || ' ims:block'; END IF;
    IF COALESCE(public.ims_caller_has_rank('staff'), false) THEN v_fail := v_fail || ' ims:blocked-has-rank'; END IF;
    IF COALESCE(public.ims_can_manage_counts(), false) THEN v_fail := v_fail || ' ims:blocked-manages-counts'; END IF;
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = c_ims AND staff_blocked_by = c_hr) THEN v_fail := v_fail || ' ims:blocked-by-not-kept'; END IF;
    IF public.staff_set_login_blocked(c_ims, false, NULL) <> 'unblocked' THEN v_fail := v_fail || ' ims:unblock'; END IF;

    -- The record count answers for a real login (the Owner's blocked-by key now counts too).
    PERFORM * FROM public.login_recorded_rows(c_hr);
    PERFORM * FROM public.pos_login_recorded_rows(c_ims);

    -- A till PIN login and a missing login are refused.
    IF v_till IS NOT NULL THEN
      BEGIN
        PERFORM public.staff_set_login_blocked(v_till, true, NULL);
        v_fail := v_fail || ' till-login-blocked';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE 'staff_login_not_found%' THEN v_fail := v_fail || ' till:' || SQLERRM; END IF;
      END;
    END IF;
    BEGIN
      PERFORM public.staff_set_login_blocked(gen_random_uuid(), true, NULL);
      v_fail := v_fail || ' unknown-login-blocked';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'staff_login_not_found%' THEN v_fail := v_fail || ' unknown:' || SQLERRM; END IF;
    END;

    RAISE EXCEPTION 'S875_probe_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'S875_probe_rollback' THEN
      RAISE;
    END IF;
  END;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'S875 probe failed:%', v_fail;
  END IF;
  RAISE NOTICE 'S875 probe passed: HR and IMS managers lose rank when blocked and get it back when unblocked; 66 HR policies follow.';
END;
$$;

NOTIFY pgrst, 'reload schema';
