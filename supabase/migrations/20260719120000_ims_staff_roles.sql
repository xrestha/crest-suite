-- IMS staff/supervisor/manager role system — mirrors the existing pos_role system exactly, but
-- for real email+password logins instead of PIN accounts (no synthetic *.internal email column
-- needed; ims_role IS NOT NULL is itself the "is this an IMS staff account" marker).
--
-- Same RESTRICTIVE-policy pattern as 20260708130000_staff_account_business_table_isolation.sql
-- (S316): AND with the existing permissive same-client policies, nothing dropped/recreated.
-- IMS staff keep access to every core IMS table (items, purchase_entries, recipes, sales_entries,
-- stock_movements, monthly_periods, etc.) plus recipes/sales/stock_movements the same way POS PIN
-- staff do — they are blocked only from the 20 hr_ tables and the pos_*-prefixed business tables,
-- none of which any IMS page ever reads or writes.

ALTER TABLE public.profiles ADD COLUMN ims_role text;
ALTER TABLE public.profiles ADD COLUMN ims_job_title text;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_ims_role_check
  CHECK (ims_role = ANY (ARRAY['staff'::text, 'supervisor'::text, 'manager'::text]));

CREATE UNIQUE INDEX IF NOT EXISTS profiles_hr_employee_ims_unique
  ON public.profiles (hr_employee_id) WHERE (ims_role IS NOT NULL);

CREATE FUNCTION public.is_ims_staff() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE(ims_role IS NOT NULL, false) FROM profiles WHERE id = auth.uid()
$$;

DO $$
DECLARE
  t text;
BEGIN
  -- IMS staff accounts: blocked from every hr_ table (same 20-table list as no_pos_pin_staff)
  -- and every pos_*-prefixed business table (same list as no_self_service_accounts' POS subset,
  -- plus pos_parking_slips which was added after S316 shipped).
  FOREACH t IN ARRAY ARRAY[
    'hr_advance_repayments', 'hr_advances', 'hr_attendance', 'hr_employees',
    'hr_festival_allowances', 'hr_holiday_calendar', 'hr_incentive_configs', 'hr_incentives',
    'hr_leave_requests', 'hr_leave_types', 'hr_overtime_entries', 'hr_payroll_runs',
    'hr_payslips', 'hr_roster', 'hr_roster_publish_state', 'hr_salary_components',
    'hr_shift_swap_requests', 'hr_shift_types', 'hr_tada_claim_items', 'hr_tada_claims',
    'pos_credit_notes', 'pos_customers', 'pos_guest_order_requests', 'pos_kot_log',
    'pos_order_items', 'pos_order_payments', 'pos_orders', 'pos_parking_slips',
    'pos_payment_confirmations', 'pos_shifts', 'pos_tables'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY no_ims_staff ON public.%I AS RESTRICTIVE FOR ALL '
      || 'USING (NOT public.is_ims_staff()) WITH CHECK (NOT public.is_ims_staff())',
      t);
  END LOOP;
END $$;

-- Defense-in-depth mirror of profiles_pos_role_manager_update — everything in the app actually
-- writes ims_role via the admin-user-ops Edge Function (service role, bypasses RLS), but this
-- covers any future direct-from-frontend write the same way the POS policy already does.
CREATE POLICY profiles_ims_role_manager_update ON public.profiles
  FOR UPDATE TO authenticated
  USING (
    client_id = (SELECT client_id FROM profiles WHERE id = auth.uid())
    AND (SELECT ims_role FROM profiles WHERE id = auth.uid()) = 'manager'
  )
  WITH CHECK (client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));

-- get_ims_staff_list: structural mirror of get_pos_staff_list (same profiles_select-bypass
-- reasoning), plus an `email` column (joined from auth.users, same technique client_user_emails
-- already uses) — IMS staff log in with a real email a manager needs to see/share, unlike PIN
-- accounts where the login "identity" is just the name shown on the PIN pad.
CREATE FUNCTION public.get_ims_staff_list(p_client_id uuid) RETURNS TABLE(
    id uuid, full_name text, email text, ims_role text, ims_job_title text,
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
      SELECT p.id, p.full_name, u.email, p.ims_role, p.ims_job_title, p.last_seen_at, p.hr_employee_id, e.employee_code
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

REVOKE EXECUTE ON FUNCTION public.get_ims_staff_list(uuid) FROM anon;

NOTIFY pgrst, 'reload schema';
