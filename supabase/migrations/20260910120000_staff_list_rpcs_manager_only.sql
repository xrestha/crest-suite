-- ════════════════════════════════════════════════════════════════════════════════════════════
-- HIGH: get_ims_staff_list / get_hr_role_staff_list handed every IMS (HR) staff member's real
-- sign-in email to ANY authenticated account of the client.
--
-- Both gate on `caller_role = 'admin' OR caller_client_id = p_client_id` and nothing else -- no
-- rank check -- which is the exact shape 20260810130000 (S531) closed on their siblings
-- get_ims_eligible_users / get_hr_role_eligible_users. That migration fixed the pair that
-- disclosed the OWNER's email and left the pair that discloses every STAFF email one file over.
-- A POS PIN waiter, an HR Self-Service employee or an IMS staff-rank account can call
-- get_ims_staff_list(<their own client_id>) -- client_id is on their own profiles row -- and
-- read the id, full name, real /login email, rank and last-seen of every IMS login: the whole
-- list a manager sees, with the one column that lets a password attack on /login begin.
--
-- ImsStaff.jsx redirects an under-ranked visitor, but its useEffect fires this RPC before the
-- redirect renders, and a direct call needs no page at all. A page guard is a guard on the page.
--
-- Fix: the caller must be an admin, the client Owner, or a MANAGER of that module for that
-- client -- exactly the set admin-user-ops lets ACT on the result (isImsPrivileged /
-- isHrPrivileged). No staff or supervisor rank has a page that reads either list, so this
-- removes the disclosure without removing a capability anyone had. Return shapes are unchanged,
-- so CREATE OR REPLACE is valid (no DROP needed -- see 20260728100000 for the other case).
-- ════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_ims_staff_list(p_client_id uuid) RETURNS TABLE(
    id uuid, full_name text, email text, ims_role text, ims_job_title text,
    last_seen_at timestamp with time zone, hr_employee_id uuid, employee_code text
) LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  caller_client_id uuid;
  caller_ims_role  text;
BEGIN
  SELECT p.client_id, p.ims_role INTO caller_client_id, caller_ims_role
  FROM profiles p WHERE p.id = auth.uid();

  -- COALESCE(..., false): is_admin() and is_client_owner() are NULL for a session with no
  -- profiles row, and NULL OR false is NULL. An IF that returns rows on TRUE is fail-closed on
  -- NULL anyway, but the wrapped form is the one this project has agreed to write (S630).
  IF COALESCE(
       public.is_admin()
       OR (caller_client_id = p_client_id
           AND (public.is_client_owner() OR caller_ims_role = 'manager')),
       false)
  THEN
    RETURN QUERY
      SELECT p.id, p.full_name, u.email::text, p.ims_role, p.ims_job_title, p.last_seen_at, p.hr_employee_id, e.employee_code
      FROM profiles p
      JOIN auth.users u ON u.id = p.id
      LEFT JOIN hr_employees e ON e.id = p.hr_employee_id
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.ims_role IS NOT NULL
      ORDER BY p.full_name;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_hr_role_staff_list(p_client_id uuid) RETURNS TABLE(
    id uuid, full_name text, email text, hr_role text, hr_job_title text,
    last_seen_at timestamp with time zone, hr_employee_id uuid, employee_code text
) LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  caller_client_id uuid;
  caller_hr_role   text;
BEGIN
  SELECT p.client_id, p.hr_role INTO caller_client_id, caller_hr_role
  FROM profiles p WHERE p.id = auth.uid();

  IF COALESCE(
       public.is_admin()
       OR (caller_client_id = p_client_id
           AND (public.is_client_owner() OR caller_hr_role = 'manager')),
       false)
  THEN
    RETURN QUERY
      SELECT p.id, p.full_name, u.email::text, p.hr_role, p.hr_job_title, p.last_seen_at, p.hr_employee_id, e.employee_code
      FROM profiles p
      JOIN auth.users u ON u.id = p.id
      LEFT JOIN hr_employees e ON e.id = p.hr_employee_id
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.hr_role IS NOT NULL
      ORDER BY p.full_name;
  END IF;
END;
$$;

-- Re-assert the grants: CREATE OR REPLACE re-runs the default PUBLIC-execute grant, and a
-- REVOKE ... FROM anon alone is a silent no-op while PUBLIC still holds it (20260720150000).
REVOKE EXECUTE ON FUNCTION public.get_ims_staff_list(uuid)     FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_ims_staff_list(uuid)     TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_hr_role_staff_list(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_hr_role_staff_list(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- ── Verification (do NOT trust "Success. No rows returned") ───────────────────────────────────
--   SELECT has_function_privilege('anon', 'public.get_ims_staff_list(uuid)', 'EXECUTE');
--   SELECT has_function_privilege('anon', 'public.get_hr_role_staff_list(uuid)', 'EXECUTE');
--   -- both expect: false
--
-- Then, signed in as an IMS *staff* or *supervisor* account, or as a POS PIN account:
--   await supabase.rpc('get_ims_staff_list', { p_client_id: '<their client>' })
--   -- expect: data = []   (before this migration: every IMS login with its real email)
-- and as the Owner or an IMS manager of that client the same call still returns the list.
