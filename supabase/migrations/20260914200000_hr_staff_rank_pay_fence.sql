-- S750 — an HR "staff" rank login cannot read or write employee and pay records.
--
-- hr_employees carries basic salary, bank account, PAN and citizenship numbers; the tables below
-- carry every payslip, settlement, advance, festival allowance and incentive. Each had one
-- same-client permissive policy plus the account-TYPE fences (IMS staff, POS PIN staff, Self-Service)
-- and no RANK fence, so an hr_role = 'staff' login — which the router keeps off every page that shows
-- these — could read all of it over REST with its own JWT (S748 open item). The S748/S749 rank
-- policies fence WRITES on the supervisor tables; nothing fenced READS here.
--
-- Decided with Aashish, 2026-09-14: lock out the staff rank only. Supervisors keep reading basic
-- pay and allowances, because Overtime prices an hour from them and the Roster's labour cost needs
-- them. No page below supervisor reads any of these tables; the Client Dashboard's two HR figure
-- tiles and the getting-started card's employee step are hidden below supervisor in the same change,
-- because an RLS-filtered read comes back EMPTY rather than failed and would paint "0 employees".
--
-- RESTRICTIVE and FOR ALL, so it ANDs with whatever permissive policy each table already has and
-- covers reads and writes alike. is_hr_staff_rank() is COALESCE-wrapped to false: a profile-less
-- session is not a staff-rank login (and is refused by the permissive policy anyway). SECURITY
-- DEFINER SQL, like the other staff-marker helpers, and granted the same way.
--
-- Self-Service is unaffected: every employee-facing read is a SECURITY DEFINER RPC (get_my_*),
-- which RLS does not reach. The service role (Edge Functions, Danger Zone) bypasses RLS.

CREATE OR REPLACE FUNCTION public.is_hr_staff_rank()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT COALESCE((SELECT p.hr_role = 'staff' FROM profiles p WHERE p.id = (select auth.uid())), false)
$fn$;

REVOKE EXECUTE ON FUNCTION public.is_hr_staff_rank() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_hr_staff_rank() TO authenticated, service_role;

DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hr_employees', 'hr_salary_components', 'hr_payslips', 'hr_payroll_runs',
    'hr_final_settlements', 'hr_advances', 'hr_advance_repayments',
    'hr_festival_allowances', 'hr_incentives'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS no_hr_staff_rank ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY no_hr_staff_rank ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING (NOT (select public.is_hr_staff_rank())) WITH CHECK (NOT (select public.is_hr_staff_rank()))',
      t);
  END LOOP;
END
$do$;

NOTIFY pgrst, 'reload schema';

-- Verification (run separately): the S750 changelog entry records the rolled-back probe — an HR
-- staff login reading 0 rows from each table and refused an update, an HR supervisor reading them.
--   SELECT tablename FROM pg_policies WHERE policyname = 'no_hr_staff_rank' ORDER BY 1;   -- 9 rows
--   SELECT has_function_privilege('anon', 'public.is_hr_staff_rank()', 'EXECUTE');         -- false
