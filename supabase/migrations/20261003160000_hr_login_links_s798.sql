-- S798 stage 3f-1 — a login is tied to its owner's employee record at every outlet it works at.
-- Findings SISTER-2 and GAP-OUTLETS-1 (docs/hr-review-s798/SISTER.md, GAP-OUTLETS.md), decision H6 (a)
-- in HR_TODO.md S798.1, the slice in S798.4. set_outlet_access and hr_own_attendance_changes are rebuilt
-- from their LIVE bodies (read 2026-10-03), not from an older migration.
--
-- Every "nobody below the Owner decides their own record" guard asks hr_is_own_employee(), which knew a
-- person two ways: the login's profiles.hr_employee_id, or an employee record carrying the login's email.
-- Both missed ordinary setups:
-- 1. SISTER-2. An HR supervisor or manager login given its rank through HR Staff → Existing User, or made
--    as HR-only Staff, is linked to nobody, and most employee records carry no email. Crest did not know
--    the login was Anita's: she could approve her own leave and her own NPR 6,000 travel claim, and Final
--    Settlement did not block her login when she left. Live 2026-10-03: none of the 8 HR or IMS email
--    logins is linked or tied by email, CASA's HR Manager included.
-- 2. GAP-OUTLETS-1. hr_employee_id is ONE record. Sita's login lives at Thamel and is linked there; when
--    the Owner ticks Lakeside for her in Outlet Access and Lakeside also pays her, every own-record test
--    at Lakeside asks about her Lakeside record and answers "not hers". Latent: BLOOM's group has no
--    Outlet Access grant today.
--
-- What this adds:
-- (1) profile_employee_links: a login's employee record at an outlet it reaches through Outlet Access.
--     The home outlet's link stays profiles.hr_employee_id, which Crest Staff, Final Settlement and about
--     twenty functions read. One link per login per outlet, one link per employee record. A link goes
--     with its login, its outlet, its employee record, and the login's access to that outlet
--     (set_outlet_access, revoke_outlet_access). No client writes; audited.
-- (2) hr_is_own_employee gains a third test: a link row for this login and this record. Its 14 callers
--     (leave, overtime, TADA, advances and repayments, own pay, bonuses, payroll and settlement
--     finalize/reopen, the rehire unblock, settlement top-ups) follow. hr_own_attendance_changes reads
--     the link itself, so it gets the same third test.
-- (3) link_hr_login / unlink_hr_login: the Owner or the operator ties an HR login to a record, at the
--     login's home outlet (profiles.hr_employee_id) or at an outlet it can open (a link row). Owner only
--     (H6): a link decides whose requests the login may never decide, so an HR manager moving it could
--     lift the rule off their own record. In SQL rather than the admin-user-ops action HR_TODO named:
--     one transaction, provable in a rolled-back dry run, and guard_profiles_privileged_columns lets a
--     DEFINER body write hr_employee_id, as hr_unblock_rehired_logins already does.
-- (4) get_hr_role_staff_list also returns the linked record's name and the record here that carries the
--     login's email, so HR Staff can say which logins the rule does not reach (DROP + CREATE: new columns).
-- (5) get_outlet_reaching_logins(outlet): the logins from other outlets of the group that can open this
--     one, and what each is linked to here, for HR Staff.
-- (6) revoke_outlet_access(login, outlet): the Owner removes one outlet from one login, from HR Staff,
--     outside the Suite Pro gate the Outlet Access panel sits behind. set_active_outlet never checked
--     suite_plan, so a lapsed Suite left grants working that no screen could remove (GAP-OUTLETS-3).
--
-- Not exported or restored, like profile_outlet_access itself. Archive deletes an outlet's employee
-- records and with them their links; the Restore re-links home logins only (relink_staff_accounts).
-- Reversal: drop the five new functions and the table, and put back the previous bodies of
-- hr_is_own_employee, hr_own_attendance_changes, set_outlet_access and get_hr_role_staff_list.

-- ── (1) The link table ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profile_employee_links (
  -- log_audit() records OLD.id / NEW.id: without an id column every audit write fails into its
  -- EXCEPTION handler and nothing is recorded.
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  client_id   uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.hr_employees(id) ON DELETE CASCADE,
  linked_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  linked_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_employee_links_profile_client_key UNIQUE (profile_id, client_id),
  CONSTRAINT profile_employee_links_employee_key UNIQUE (employee_id)
);
-- The clients cascade deletes by client_id; every other lookup leads with profile_id or employee_id,
-- which the two unique indexes cover.
CREATE INDEX IF NOT EXISTS profile_employee_links_client_idx ON public.profile_employee_links (client_id);

COMMENT ON TABLE public.profile_employee_links IS
  'S798 3f-1: a login''s employee record at an outlet it reaches through Outlet Access (the home link is profiles.hr_employee_id). Written only by link_hr_login / unlink_hr_login / set_outlet_access / revoke_outlet_access; read by hr_is_own_employee.';

ALTER TABLE public.profile_employee_links ENABLE ROW LEVEL SECURITY;

-- Read: your own links (pages hide Approve on your own row), the group's Owner and the operator. The
-- same shape as profile_outlet_access_select. No write policy: the DEFINER functions are the only path.
-- Not a business table, so the restrictive staff-isolation families do not apply: a staff login reads
-- only its own rows here.
DROP POLICY IF EXISTS profile_employee_links_select ON public.profile_employee_links;
CREATE POLICY profile_employee_links_select ON public.profile_employee_links
  FOR SELECT TO authenticated
  USING (
    profile_id = (select auth.uid())
    OR COALESCE((select public.is_admin()), false)
    OR (COALESCE((select public.is_client_owner()), false)
        AND client_id IN (SELECT c.id FROM public.clients c WHERE c.group_id = (select public.my_group_id())))
  );

-- Raw-SQL tables get no role grants here, and do get TRUNCATE/REFERENCES/TRIGGER from the schema's
-- default privileges (S782).
REVOKE ALL ON public.profile_employee_links FROM anon, authenticated, PUBLIC;
GRANT SELECT ON public.profile_employee_links TO authenticated;
GRANT ALL ON public.profile_employee_links TO service_role;

-- A link changes whose requests a login may decide: it belongs in the audit trail.
CREATE OR REPLACE TRIGGER audit_profile_employee_links
  AFTER INSERT OR DELETE OR UPDATE ON public.profile_employee_links
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();

-- ── (2) Your own record: a third test ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_is_own_employee(p_employee_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.hr_employee_id = p_employee_id)
    -- S798 3f-1 (H6): the login's record at an outlet it reaches through Outlet Access.
    OR EXISTS (SELECT 1 FROM profile_employee_links l WHERE l.profile_id = auth.uid() AND l.employee_id = p_employee_id)
    OR EXISTS (
      SELECT 1 FROM hr_employees e
       WHERE e.id = p_employee_id
         AND NULLIF(btrim(e.email), '') IS NOT NULL
         AND lower(btrim(e.email)) = lower(COALESCE(auth.jwt() ->> 'email', ''))
    ), false)
$function$;

-- hr_own_attendance_changes, as live (S798 3a), plus the link test.
CREATE OR REPLACE FUNCTION public.hr_own_attendance_changes(p_period_id uuid)
 RETURNS TABLE(employee_id uuid, employee_name text, marked_by_name text, bs_day integer, action text, old_status text, new_status text, old_hours numeric, new_hours numeric, old_ot_hours numeric, new_ot_hours numeric, changed_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_client uuid;
BEGIN
  SELECT mp.client_id INTO v_client FROM monthly_periods mp WHERE mp.id = p_period_id;
  IF NOT COALESCE(v_client IS NOT NULL
                  AND public.hr_is_manager_rank()
                  AND (public.is_admin() OR v_client = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'payroll_rank: the list of own attendance changes needs the Owner or an HR manager' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT e.id,
         COALESCE(NULLIF(btrim(e.full_name), ''), 'An employee')::text,
         COALESCE(NULLIF(btrim(pr.full_name), ''), NULLIF(btrim(a.user_name), ''), 'A login')::text,
         (x.r ->> 'bs_day')::integer,
         a.action::text,
         (a.old_data ->> 'status')::text,
         (a.new_data ->> 'status')::text,
         (a.old_data ->> 'hours_worked')::numeric,
         (a.new_data ->> 'hours_worked')::numeric,
         (a.old_data ->> 'ot_hours')::numeric,
         (a.new_data ->> 'ot_hours')::numeric,
         a.created_at
    FROM audit_logs a
    CROSS JOIN LATERAL (SELECT COALESCE(a.new_data, a.old_data) AS r) x
    JOIN hr_employees e ON e.id = (x.r ->> 'employee_id')::uuid AND e.client_id = v_client
    JOIN profiles pr ON pr.id = a.user_id
    LEFT JOIN auth.users u ON u.id = a.user_id
   WHERE a.client_id = v_client
     AND a.table_name = 'hr_attendance'
     AND (x.r ->> 'period_id')::uuid = p_period_id
     AND NOT COALESCE(pr.role = 'admin', false)
     AND COALESCE(pr.hr_employee_id = e.id
                  -- S798 3f-1: or the login's link to this record at an outlet it reaches
                  OR EXISTS (SELECT 1 FROM profile_employee_links l WHERE l.profile_id = pr.id AND l.employee_id = e.id)
                  OR (NULLIF(btrim(e.email), '') IS NOT NULL
                      AND lower(btrim(e.email)) = lower(COALESCE(u.email, '')::text)), false)
     AND (a.action <> 'UPDATE'
          OR (a.old_data ->> 'status', a.old_data ->> 'hours_worked', a.old_data ->> 'ot_hours',
              a.old_data ->> 'start_time', a.old_data ->> 'end_time', a.old_data ->> 'break_minutes')
             IS DISTINCT FROM
             (a.new_data ->> 'status', a.new_data ->> 'hours_worked', a.new_data ->> 'ot_hours',
              a.new_data ->> 'start_time', a.new_data ->> 'end_time', a.new_data ->> 'break_minutes'))
   ORDER BY e.full_name, (x.r ->> 'bs_day')::integer, a.id;
END;
$function$;

-- ── (3) Link and unlink ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.link_hr_login(p_profile_id uuid, p_employee_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t profiles;
  e hr_employees;
  v_name text;
  v_other text;
  v_home_group uuid;
  v_emp_group uuid;
BEGIN
  -- Owner or operator only (H6): a link decides whose requests this login may never decide.
  IF NOT COALESCE(public.is_admin() OR public.is_client_owner(), false) THEN
    RAISE EXCEPTION 'login_link_rank: only the Owner links a login to an employee record' USING ERRCODE = '42501';
  END IF;

  -- The record first, locked, so two links racing for one record queue here.
  SELECT * INTO e FROM hr_employees x WHERE x.id = p_employee_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'login_link_missing: that employee record no longer exists — reload the page';
  END IF;
  -- The Owner links at the outlet they are working in; the operator at any.
  IF NOT COALESCE(public.is_admin() OR e.client_id = public.my_client_id(), false) THEN
    RAISE EXCEPTION 'login_link_outlet: that employee record belongs to another outlet — switch to it first' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO t FROM profiles x WHERE x.id = p_profile_id FOR UPDATE;
  IF NOT FOUND OR t.role IS DISTINCT FROM 'client' THEN
    RAISE EXCEPTION 'login_link_missing: that login no longer exists — reload the page';
  END IF;
  v_name := COALESCE(NULLIF(btrim(t.full_name), ''), 'That login');
  -- An HR login carries no POS, IMS or Self-Service marker (create_hr_staff and update_hr_role refuse
  -- the mix), and the Owner's own login carries no hr_role, so this one test keeps both out.
  IF t.hr_role IS NULL THEN
    RAISE EXCEPTION 'login_link_not_hr: % is not an HR staff login — only an HR login is linked here', v_name;
  END IF;

  IF t.client_id = e.client_id THEN
    IF t.hr_employee_id = e.id THEN RETURN 'home'; END IF;
    IF t.hr_employee_id IS NOT NULL THEN
      RAISE EXCEPTION 'login_link_taken: % is already linked to another employee record at this outlet — unlink it first', v_name;
    END IF;
  ELSE
    -- Another outlet: only one the login can open, inside its own group. An access row outliving a
    -- regrouping is not reach.
    SELECT hc.group_id INTO v_home_group FROM clients hc WHERE hc.id = t.client_id;
    SELECT ec.group_id INTO v_emp_group FROM clients ec WHERE ec.id = e.client_id;
    IF v_home_group IS NULL OR v_emp_group IS DISTINCT FROM v_home_group
       OR NOT EXISTS (SELECT 1 FROM profile_outlet_access a WHERE a.profile_id = t.id AND a.client_id = e.client_id) THEN
      RAISE EXCEPTION 'login_link_no_access: % cannot open this outlet — tick it for them in Outlet Access first', v_name;
    END IF;
    IF EXISTS (SELECT 1 FROM profile_employee_links l
                WHERE l.profile_id = t.id AND l.client_id = e.client_id AND l.employee_id = e.id) THEN
      RETURN 'outlet';
    END IF;
    IF EXISTS (SELECT 1 FROM profile_employee_links l WHERE l.profile_id = t.id AND l.client_id = e.client_id) THEN
      RAISE EXCEPTION 'login_link_taken: % is already linked to another employee record at this outlet — unlink it first', v_name;
    END IF;
  END IF;

  -- One HR login per employee record: create_hr_staff's rule, across both kinds of link.
  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), 'another login') INTO v_other
    FROM profiles p
   WHERE p.hr_employee_id = e.id AND p.hr_role IS NOT NULL AND p.id <> t.id
   LIMIT 1;
  IF v_other IS NULL THEN
    SELECT COALESCE(NULLIF(btrim(p.full_name), ''), 'another login') INTO v_other
      FROM profile_employee_links l JOIN profiles p ON p.id = l.profile_id
     WHERE l.employee_id = e.id AND l.profile_id <> t.id
     LIMIT 1;
  END IF;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'login_link_employee_taken: % already has an HR login linked (%) — unlink that one first',
      COALESCE(NULLIF(btrim(e.full_name), ''), 'This employee'), v_other;
  END IF;

  IF t.client_id = e.client_id THEN
    UPDATE profiles SET hr_employee_id = e.id WHERE id = t.id;
    RETURN 'home';
  END IF;
  INSERT INTO profile_employee_links (profile_id, client_id, employee_id, linked_by)
  VALUES (t.id, e.client_id, e.id, (select auth.uid()));
  RETURN 'outlet';
END;
$function$;

REVOKE ALL ON FUNCTION public.link_hr_login(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.link_hr_login(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.unlink_hr_login(p_profile_id uuid, p_client_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t profiles;
BEGIN
  -- Unlinking lifts the own-record rule off a record, so it is the Owner's too, at the outlet they are in.
  IF NOT COALESCE(public.is_admin() OR (public.is_client_owner() AND p_client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'login_link_rank: only the Owner unlinks a login from an employee record' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO t FROM profiles x WHERE x.id = p_profile_id FOR UPDATE;
  IF NOT FOUND OR t.role IS DISTINCT FROM 'client' OR t.hr_role IS NULL THEN
    RAISE EXCEPTION 'login_link_not_hr: only an HR staff login is unlinked here';
  END IF;

  IF t.client_id = p_client_id THEN
    IF t.hr_employee_id IS NULL THEN RETURN 'none'; END IF;
    UPDATE profiles SET hr_employee_id = NULL WHERE id = t.id;
    RETURN 'home';
  END IF;
  DELETE FROM profile_employee_links l WHERE l.profile_id = t.id AND l.client_id = p_client_id;
  IF FOUND THEN RETURN 'outlet'; END IF;
  RETURN 'none';
END;
$function$;

REVOKE ALL ON FUNCTION public.unlink_hr_login(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unlink_hr_login(uuid, uuid) TO authenticated, service_role;

-- ── (4) HR Staff's list: what each login is tied to ─────────────────────────────────────────────────
-- Body as live (S798 3b), plus employee_name (the linked record) and email_employee_name (a record at
-- this outlet carrying the login's email: the tie hr_is_own_employee's email test makes).
DROP FUNCTION IF EXISTS public.get_hr_role_staff_list(uuid);
CREATE FUNCTION public.get_hr_role_staff_list(p_client_id uuid)
 RETURNS TABLE(id uuid, full_name text, email text, hr_role text, hr_job_title text, last_seen_at timestamp with time zone, hr_employee_id uuid, employee_code text, settlement_blocked boolean, employee_name text, email_employee_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
  caller_hr_role   text;
BEGIN
  SELECT COALESCE(p.active_client_id, p.client_id), p.hr_role INTO caller_client_id, caller_hr_role
  FROM profiles p WHERE p.id = auth.uid();

  IF COALESCE(
       public.is_admin()
       OR (caller_client_id = p_client_id
           AND (public.is_client_owner() OR caller_hr_role = 'manager')),
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
               ORDER BY em.full_name LIMIT 1)::text
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

REVOKE ALL ON FUNCTION public.get_hr_role_staff_list(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_hr_role_staff_list(uuid) TO authenticated, service_role;

-- ── (5) Logins from other outlets that can open this one ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_outlet_reaching_logins(p_client_id uuid)
 RETURNS TABLE(profile_id uuid, full_name text, home_client_name text, hr_role text, ims_role text, pos_role text,
               linked_employee_id uuid, linked_employee_name text, linked_employee_code text, email_employee_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- HR Staff's readers: the operator, the Owner or an HR manager, at this outlet.
  IF NOT COALESCE(public.is_admin() OR (p_client_id = public.my_client_id() AND public.hr_is_manager_rank()), false) THEN
    RAISE EXCEPTION 'Not permitted: only the Owner or an HR manager of this outlet sees who can open it.' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT p.id,
         p.full_name::text,
         hc.name::text,
         p.hr_role::text,
         p.ims_role::text,
         p.pos_role::text,
         le.id,
         le.full_name::text,
         le.employee_code::text,
         (SELECT em.full_name FROM hr_employees em
           WHERE em.client_id = p_client_id
             AND NULLIF(btrim(em.email), '') IS NOT NULL
             AND lower(btrim(em.email)) = lower(u.email::text)
           ORDER BY em.full_name LIMIT 1)::text
    FROM profile_outlet_access a
    JOIN profiles p ON p.id = a.profile_id
    JOIN clients hc ON hc.id = p.client_id
    LEFT JOIN auth.users u ON u.id = p.id
    LEFT JOIN profile_employee_links l ON l.profile_id = p.id AND l.client_id = p_client_id
    LEFT JOIN hr_employees le ON le.id = l.employee_id
   WHERE a.client_id = p_client_id
     AND p.client_id <> p_client_id
     AND p.role = 'client'
   ORDER BY p.full_name;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_outlet_reaching_logins(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_outlet_reaching_logins(uuid) TO authenticated, service_role;

-- ── (6) Remove one outlet from one login ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revoke_outlet_access(p_profile_id uuid, p_client_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group uuid;
  v_target_group uuid;
BEGIN
  -- set_outlet_access's test: the operator, or an Owner whose group holds the outlet.
  IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
    RAISE EXCEPTION 'Not permitted: only the Owner removes a login''s access to an outlet.' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(public.is_admin(), false) THEN
    v_group := public.my_group_id();
    SELECT c.group_id INTO v_target_group FROM clients c WHERE c.id = p_client_id;
    IF v_group IS NULL OR v_target_group IS DISTINCT FROM v_group THEN
      RAISE EXCEPTION 'Not permitted: that outlet is not in your group.' USING ERRCODE = '42501';
    END IF;
  END IF;

  DELETE FROM profile_outlet_access a WHERE a.profile_id = p_profile_id AND a.client_id = p_client_id;
  DELETE FROM profile_employee_links l WHERE l.profile_id = p_profile_id AND l.client_id = p_client_id;
  -- A revoke evicts, as set_outlet_access does: a window sitting in the outlet stops resolving there.
  UPDATE profiles
     SET active_client_id = NULL
   WHERE id = p_profile_id
     AND active_client_id = p_client_id
     AND active_client_id <> client_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.revoke_outlet_access(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_outlet_access(uuid, uuid) TO authenticated, service_role;

-- ── set_outlet_access: an untick takes the link with it ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_outlet_access(p_profile_id uuid, p_client_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group  uuid;
  v_target_group uuid;
  v_ids    uuid[] := COALESCE(p_client_ids, ARRAY[]::uuid[]);
BEGIN
  IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
    RAISE EXCEPTION 'Not permitted.';
  END IF;

  v_group := public.my_group_id();
  IF v_group IS NULL THEN
    RAISE EXCEPTION 'Not permitted: you are not part of an outlet group.';
  END IF;

  -- The SUBJECT must be in my group...
  SELECT c.group_id INTO v_target_group
    FROM profiles p JOIN clients c ON c.id = p.client_id
   WHERE p.id = p_profile_id;
  IF v_target_group IS DISTINCT FROM v_group THEN
    RAISE EXCEPTION 'Not permitted: that account is not in your group.';
  END IF;

  -- ...and so must every outlet being granted. Checked as a set: one stray id fails the whole
  -- call rather than being silently dropped, so the UI can never report a grant that did not
  -- happen.
  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) AS want(id)
     WHERE want.id NOT IN (SELECT c2.id FROM clients c2 WHERE c2.group_id = v_group)
  ) THEN
    RAISE EXCEPTION 'Not permitted: one or more outlets are not in your group.';
  END IF;

  DELETE FROM profile_outlet_access WHERE profile_id = p_profile_id;

  INSERT INTO profile_outlet_access (profile_id, client_id, granted_by)
  SELECT p_profile_id, want.id, (select auth.uid()) FROM unnest(v_ids) AS want(id);

  -- S798 3f-1: a login's employee link at an outlet lives only while the login can open that outlet,
  -- so an untick takes the link with it. Home links (profiles.hr_employee_id) are not in that table.
  DELETE FROM profile_employee_links l
   WHERE l.profile_id = p_profile_id
     AND l.client_id <> ALL (v_ids);

  -- A revoke must EVICT, not merely deny the next switch. Without this, an account already
  -- sitting in an outlet whose access was just removed keeps my_client_id() resolving there
  -- until they happen to switch again -- the same staleness clear_stale_active_outlet() handles
  -- for regrouping.
  UPDATE profiles
     SET active_client_id = NULL
   WHERE id = p_profile_id
     AND active_client_id IS NOT NULL
     AND active_client_id <> client_id
     AND active_client_id <> ALL (v_ids);
END;
$function$;

-- ── Assertions ──────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  f text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.profile_employee_links'::regclass) THEN
    RAISE EXCEPTION '3f-1: RLS is off on profile_employee_links';
  END IF;
  IF has_table_privilege('anon', 'public.profile_employee_links', 'SELECT')
     OR has_table_privilege('authenticated', 'public.profile_employee_links', 'INSERT')
     OR has_table_privilege('authenticated', 'public.profile_employee_links', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.profile_employee_links', 'DELETE')
     OR has_table_privilege('authenticated', 'public.profile_employee_links', 'TRUNCATE')
     OR NOT has_table_privilege('authenticated', 'public.profile_employee_links', 'SELECT') THEN
    RAISE EXCEPTION '3f-1: profile_employee_links grants are not SELECT-only for authenticated';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.link_hr_login(uuid, uuid)', 'public.unlink_hr_login(uuid, uuid)',
                           'public.get_hr_role_staff_list(uuid)', 'public.get_outlet_reaching_logins(uuid)',
                           'public.revoke_outlet_access(uuid, uuid)', 'public.set_outlet_access(uuid, uuid[])',
                           'public.hr_is_own_employee(uuid)', 'public.hr_own_attendance_changes(uuid)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION '3f-1: % is not authenticated-only', f;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('hr_is_own_employee', 'hr_own_attendance_changes', 'set_outlet_access')
         AND p.prosrc LIKE '%profile_employee_links%') <> 3 THEN
    RAISE EXCEPTION '3f-1: a rebuilt function does not read profile_employee_links';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
