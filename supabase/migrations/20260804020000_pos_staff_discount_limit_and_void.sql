-- Per-staff POS Discount Limit (%) and Bill Void permission.
-- Both null/false by default so existing behavior is unchanged until a manager/admin
-- explicitly sets a cap or grants void on a specific staff member's profile.
ALTER TABLE public.profiles ADD COLUMN pos_discount_limit numeric
  CHECK (pos_discount_limit IS NULL OR (pos_discount_limit >= 0 AND pos_discount_limit <= 100));

ALTER TABLE public.profiles ADD COLUMN pos_allow_void boolean DEFAULT false;

-- get_pos_staff_list (PosStaff.jsx's staff-list source, per profiles_select RLS being
-- self-or-admin-only) needs both new columns in its return row — adding OUT columns changes the
-- function's return type, which CREATE OR REPLACE can't do (42P13), so DROP + CREATE like every
-- prior extension of this function (20260709130000, 20260721000000). DROP FUNCTION also drops its
-- ACL entries, so the anon-execute revoke from 20260720150000_fix_ineffective_anon_execute_revokes
-- must be reapplied below.
DROP FUNCTION IF EXISTS public.get_pos_staff_list(uuid);
CREATE FUNCTION public.get_pos_staff_list(p_client_id uuid) RETURNS TABLE(
    id uuid, full_name text, pos_role text, pos_job_title text, pos_team text,
    last_seen_at timestamp with time zone, hr_employee_id uuid, employee_code text,
    pos_discount_limit numeric, pos_allow_void boolean
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
      SELECT p.id, p.full_name, p.pos_role, p.pos_job_title, p.pos_team, p.last_seen_at,
             p.hr_employee_id, e.employee_code, p.pos_discount_limit, p.pos_allow_void
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
