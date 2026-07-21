-- POS "team" axis (S431) — orthogonal to pos_role. Front-of-house vs kitchen vs bar staff share
-- the exact same pos_role rank system (staff/supervisor/manager still gates voids/comps/reports
-- the same way it always has); this is purely a nav/UI carve-out, not a data-isolation boundary,
-- so no RESTRICTIVE policies are needed — a kitchen/bar account still has whatever table access
-- its pos_role already granted.
--
-- Motivated by two related findings while reviewing the POS sidebar for a Supervisor login:
--   1. Kitchen/bar staff have zero use for Orders/Parking Slips/Tables/Customers/Shifts — those
--      are front-of-house concerns. 'kitchen'/'bar' team accounts get a stripped sidebar (frontend
--      change in Layout.js, no schema needed for that part).
--   2. Kitchen Display's KOT/BOT toggle is a manually-remembered per-browser localStorage value
--      today (`pos_kds_station`) — nothing stops a kitchen account from being left on the BOT tab
--      (or vice versa) and missing their own pending tickets. A 'kitchen' team account now locks
--      to KOT, 'bar' locks to BOT, with the toggle hidden entirely (frontend change in
--      KitchenDisplay.jsx) — eliminates the failure mode rather than just defaulting it.

ALTER TABLE public.profiles ADD COLUMN pos_team text NOT NULL DEFAULT 'foh';
ALTER TABLE public.profiles ADD CONSTRAINT profiles_pos_team_check
  CHECK (pos_team = ANY (ARRAY['foh'::text, 'kitchen'::text, 'bar'::text]));

-- get_pos_staff_list needs pos_team in its return row — adding an OUT column changes the
-- function's return type, which CREATE OR REPLACE can't do (42P13), same reason
-- 20260709130000_pos_staff_hr_link.sql dropped it to add hr_employee_id/employee_code.
-- DROP FUNCTION also drops its ACL entries, so the anon-execute revoke from
-- 20260720150000_fix_ineffective_anon_execute_revokes.sql must be reapplied below — otherwise
-- this function would silently revert to PUBLIC-executable, undoing that fix for this one function
-- exactly the way the ineffective-revoke gotcha itself was found.
DROP FUNCTION IF EXISTS public.get_pos_staff_list(uuid);
CREATE FUNCTION public.get_pos_staff_list(p_client_id uuid) RETURNS TABLE(
    id uuid, full_name text, pos_role text, pos_job_title text, pos_team text,
    last_seen_at timestamp with time zone, hr_employee_id uuid, employee_code text
) LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  caller_client_id uuid;
  caller_role text;
BEGIN
  SELECT p.client_id, p.role INTO caller_client_id, caller_role
  FROM profiles p WHERE p.id = auth.uid();

  IF caller_role = 'admin' OR caller_client_id = p_client_id THEN
    RETURN QUERY
      SELECT p.id, p.full_name, p.pos_role, p.pos_job_title, p.pos_team, p.last_seen_at, p.hr_employee_id, e.employee_code
      FROM profiles p
      LEFT JOIN hr_employees e ON e.id = p.hr_employee_id
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.pos_email IS NOT NULL
      ORDER BY p.full_name;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_pos_staff_list(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pos_staff_list(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
