-- ════════════════════════════════════════════════════════════════════════════════════════════
-- HIGH: get_ims_eligible_users / get_hr_role_eligible_users handed the client Owner's real
-- login email to ANY authenticated account of that client.
--
-- Both functions gate on `caller_role = 'admin' OR caller_client_id = p_client_id` and nothing
-- else -- no rank check at all -- so a POS PIN waiter, an HR self-service employee, or an IMS
-- staff account could call them directly. And their row filter (role='client' with all four
-- staff markers NULL/false) is *precisely* the definition of an Owner account, while the
-- SELECT list joins auth.users for `email`. So the pair returned exactly what an attacker
-- needed: the Owner's profile id and the Owner's working sign-in email.
--
-- That was step 1 of a complete Owner-account-takeover chain; step 2 was
-- admin-user-ops' reset_ims_password/reset_hr_password, which verified only that the target
-- shared the caller's client_id (fixed in the same pass -- see requireStaffTarget() there).
--
-- Fix: restrict the caller to admin or the client Owner, matching who is now allowed to ACT on
-- the result (admin-user-ops' first-assignment gate in update_ims_role/update_hr_role). A module
-- manager has no remaining use for the list, so this removes the disclosure without removing a
-- capability anyone still has. The `email` column is deliberately kept -- the caller is now
-- either the Owner (who already knows their own logins) or an admin, and the picker uses it to
-- disambiguate two staff with the same name.
--
-- ImsStaff.jsx / HrStaff.jsx already degrade correctly on an empty result: the "Existing User"
-- tab is rendered behind `eligibleUsers.length > 0` (ImsStaff.jsx:537), so a manager simply
-- stops being offered the mode rather than seeing a broken empty picker. No frontend change.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── is_client_owner() ────────────────────────────────────────────────────────────────────────
-- The Owner test is a NEGATIVE one: role='client' with none of the staff markers set. It already
-- exists twice in this codebase -- `isOwner` in AuthContext.js and `isCallerOwner` in
-- admin-user-ops/index.ts -- and this is now the third copy, in SQL.
--
-- !! WHEN ADDING A NEW STAFF-ACCOUNT MARKER COLUMN TO profiles, IT MUST BE ADDED TO ALL THREE. !!
-- Miss one and Owner detection silently breaks for every other marker (the failure is silent
-- because a wrongly-detected Owner gets MORE access, not less -- nothing errors).
--
-- Named to match the existing is_admin() / is_ims_staff() / is_pos_pin_staff() /
-- is_hr_role_staff() / is_hr_self_service() family, and SECURITY DEFINER for the same reason
-- they are: it reads profiles, whose profiles_select RLS is self-or-admin only.
CREATE OR REPLACE FUNCTION public.is_client_owner() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT role = 'client'
     AND pos_role IS NULL
     AND ims_role IS NULL
     AND hr_role IS NULL
     AND COALESCE(hr_self_service, false) = false
  FROM profiles WHERE id = auth.uid()
$$;

REVOKE EXECUTE ON FUNCTION public.is_client_owner() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_client_owner() TO authenticated, service_role;

-- ── The two RPCs ─────────────────────────────────────────────────────────────────────────────
-- Return shape is unchanged (id, full_name, email), so plain CREATE OR REPLACE is valid here --
-- no DROP FUNCTION needed (that is only required when the RETURNS TABLE columns change; see
-- 20260728100000 for the case where it was).
CREATE OR REPLACE FUNCTION public.get_ims_eligible_users(p_client_id uuid) RETURNS TABLE(
    id uuid, full_name text, email text
) LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  caller_client_id uuid;
BEGIN
  SELECT p.client_id INTO caller_client_id FROM profiles p WHERE p.id = auth.uid();

  IF public.is_admin() OR (public.is_client_owner() AND caller_client_id = p_client_id) THEN
    RETURN QUERY
      SELECT p.id, p.full_name, u.email::text
      FROM profiles p
      JOIN auth.users u ON u.id = p.id
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.pos_role IS NULL
        AND p.hr_self_service = false
        AND p.ims_role IS NULL
        AND p.hr_role IS NULL
        AND p.id != auth.uid()
      ORDER BY p.full_name;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_hr_role_eligible_users(p_client_id uuid) RETURNS TABLE(
    id uuid, full_name text, email text
) LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  caller_client_id uuid;
BEGIN
  SELECT p.client_id INTO caller_client_id FROM profiles p WHERE p.id = auth.uid();

  IF public.is_admin() OR (public.is_client_owner() AND caller_client_id = p_client_id) THEN
    RETURN QUERY
      SELECT p.id, p.full_name, u.email::text
      FROM profiles p
      JOIN auth.users u ON u.id = p.id
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.pos_role IS NULL
        AND p.hr_self_service = false
        AND p.ims_role IS NULL
        AND p.hr_role IS NULL
        AND p.id != auth.uid()
      ORDER BY p.full_name;
  END IF;
END;
$$;

-- Re-assert the anon revoke on both. `REVOKE ... FROM anon` alone is a silent no-op while PUBLIC
-- still holds the grant (see 20260720150000 -- an entire hardening migration reported success and
-- took effect on zero of its 25 functions for a week because of exactly this), and CREATE OR
-- REPLACE above re-runs the default PUBLIC-execute grant anyway.
REVOKE EXECUTE ON FUNCTION public.get_ims_eligible_users(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_ims_eligible_users(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_hr_role_eligible_users(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_hr_role_eligible_users(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- ── Verification (do NOT trust "Success. No rows returned") ───────────────────────────────────
--   SELECT has_function_privilege('anon', 'public.get_ims_eligible_users(uuid)', 'EXECUTE');
--   SELECT has_function_privilege('anon', 'public.get_hr_role_eligible_users(uuid)', 'EXECUTE');
--   -- both expect: false
--
-- Then, signed in as a POS/IMS staff account (not the Owner):
--   await supabase.rpc('get_ims_eligible_users', { p_client_id: '<their client>' })
--   -- expect: data = []   (before this migration: the Owner's row, with their real email)
