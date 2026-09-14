-- S748 — HR Employees, Pay Setup and Holiday Calendar re-analysed. Five database changes, each
-- decided with Aashish on 2026-09-14.
--
-- ── (1) An employee with pay history cannot be deleted ───────────────────────────────────────
--
-- Ten tables hang off hr_employees with ON DELETE CASCADE, and five of them are the record that
-- money moved: hr_payslips, hr_final_settlements, hr_advances, hr_advance_repayments and
-- hr_festival_allowances. There was no BEFORE DELETE guard, and hr_employees' policies test the
-- client and the absence of a Self-Service marker only — so the Owner and EVERY HR account of any
-- rank (staff included, which cannot open the Employees page at all) could
-- `DELETE /rest/v1/hr_employees?id=eq.<uuid>` and take a finalized payslip, a TDS figure and an
-- SSF contribution with it. Those are what the TDS certificate and the SSF challan are built from.
--
-- Decided: refuse, for every login. Deactivate is the lossless state change (status), exactly as
-- archived_at is for vendors (S708), so there is deliberately no force-delete path. An employee
-- added by mistake, with no finalized pay and no advance, can still be deleted.
--
-- The same guard refuses while an HR Self-Service login is still attached. profiles.hr_employee_id
-- is ON DELETE SET NULL, so deleting the employee left the login standing with no employee: the
-- page could no longer list or remove it, get_hr_self_service_staff still offered it on the
-- picker, and hr-selfservice-login's access_blocked check read NULL — so that PIN kept signing in.
-- (The login function now also refuses an unlinked login; see supabase/functions.)
--
-- Shape: the items/vendors guard (20260909130000 / 20260909140000). SECURITY INVOKER trigger keyed
-- on current_user, so the service role (Danger Zone) passes; a SECURITY DEFINER lookup with its own
-- COALESCE-wrapped caller check, so the guard cannot pass vacuously for a caller whose RLS view of
-- the child tables is narrower than its view of hr_employees. One difference from items: when the
-- clients row itself is already gone the delete is a client deletion cascading, and it is let
-- through — refusing it would make Delete Client fail on the first employee with a payslip.

CREATE OR REPLACE FUNCTION public.employee_pay_history(p_ids uuid[])
RETURNS TABLE (ref_employee_id uuid, ref_kind text, ref_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH scoped AS (
    SELECT e.id
      FROM hr_employees e
     WHERE e.id = ANY (p_ids)
       AND COALESCE(
             (select auth.uid()) IS NULL
             OR is_admin()
             OR e.client_id = my_client_id(),
             false)
  ), refs AS (
              SELECT 'finalized_payslips'::text AS k, p.employee_id AS emp
                FROM hr_payslips p
                JOIN hr_payroll_runs r ON r.id = p.run_id AND r.status = 'finalized'
                JOIN scoped s ON s.id = p.employee_id
    UNION ALL SELECT 'final_settlements', f.employee_id
                FROM hr_final_settlements f JOIN scoped s ON s.id = f.employee_id
               WHERE f.status = 'finalized'
    UNION ALL SELECT 'festival_allowances', f.employee_id
                FROM hr_festival_allowances f JOIN scoped s ON s.id = f.employee_id
               WHERE f.status = 'finalized'
    UNION ALL SELECT 'advances', a.employee_id
                FROM hr_advances a JOIN scoped s ON s.id = a.employee_id
    UNION ALL SELECT 'self_service_login', p.hr_employee_id
                FROM profiles p JOIN scoped s ON s.id = p.hr_employee_id
               WHERE COALESCE(p.hr_self_service, false)
  )
  SELECT r.emp, r.k, count(*)::bigint
    FROM refs r
   GROUP BY r.emp, r.k;
$fn$;

REVOKE EXECUTE ON FUNCTION public.employee_pay_history(uuid[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.employee_pay_history(uuid[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.hr_employees_guard_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_kinds text;
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND EXISTS (SELECT 1 FROM clients c WHERE c.id = OLD.client_id) THEN
    SELECT string_agg(DISTINCT h.ref_kind, ', ' ORDER BY h.ref_kind)
      INTO v_kinds
      FROM employee_pay_history(ARRAY[OLD.id]) h;

    IF v_kinds IS NOT NULL THEN
      RAISE EXCEPTION 'employee_has_pay_history: employee % has %', OLD.id, v_kinds
        USING ERRCODE = 'P0001',
              HINT = 'Deactivate the employee instead — the record and its pay history are kept.';
    END IF;
  END IF;
  RETURN OLD;
END;
$fn$;

REVOKE ALL ON FUNCTION public.hr_employees_guard_delete() FROM PUBLIC;

DROP TRIGGER IF EXISTS hr_employees_guard_delete ON public.hr_employees;
CREATE TRIGGER hr_employees_guard_delete
  BEFORE DELETE ON public.hr_employees
  FOR EACH ROW EXECUTE FUNCTION public.hr_employees_guard_delete();

-- ── (2) One Self-Service login per employee ──────────────────────────────────────────────────
--
-- create_hr_self_service_login never checked for an existing login and nothing unique stood behind
-- it, so a second Enable minted a second account for the same person (the Enable modal even said
-- repeating the action gives a new PIN). The Edge Function now refuses first; this is the backstop.
-- Live on 2026-09-14: zero employees with two logins, so the index builds.

CREATE UNIQUE INDEX IF NOT EXISTS profiles_hr_employee_self_service_unique
  ON public.profiles (hr_employee_id)
  WHERE hr_self_service AND hr_employee_id IS NOT NULL;

-- ── (3) Holiday Calendar: supervisor rank to write, no duplicates, audited ───────────────────
--
-- A holiday row's type decides the 2× overtime rate Overtime.jsx suggests, and its multiplier
-- scales the Demand Forecast — pay and purchasing decisions. The page and the policies let any HR
-- account write it, staff rank included, while recording overtime itself needs supervisor.
-- Decided: supervisor and up. RESTRICTIVE per write command, so reading stays open to every HR
-- rank (staff see the calendar) and every existing permissive policy keeps its exact shape.
-- is_client_owner() and is_admin() are NULL for a profile-less session, hence the COALESCE.

DROP POLICY IF EXISTS hr_holiday_calendar_write_rank_insert ON public.hr_holiday_calendar;
DROP POLICY IF EXISTS hr_holiday_calendar_write_rank_update ON public.hr_holiday_calendar;
DROP POLICY IF EXISTS hr_holiday_calendar_write_rank_delete ON public.hr_holiday_calendar;

CREATE POLICY hr_holiday_calendar_write_rank_insert ON public.hr_holiday_calendar
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (COALESCE(
    (select public.is_admin())
    OR (select public.is_client_owner())
    OR (SELECT p.hr_role FROM profiles p WHERE p.id = (select auth.uid())) IN ('supervisor', 'manager'),
    false));

CREATE POLICY hr_holiday_calendar_write_rank_update ON public.hr_holiday_calendar
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (COALESCE(
    (select public.is_admin())
    OR (select public.is_client_owner())
    OR (SELECT p.hr_role FROM profiles p WHERE p.id = (select auth.uid())) IN ('supervisor', 'manager'),
    false))
  WITH CHECK (COALESCE(
    (select public.is_admin())
    OR (select public.is_client_owner())
    OR (SELECT p.hr_role FROM profiles p WHERE p.id = (select auth.uid())) IN ('supervisor', 'manager'),
    false));

CREATE POLICY hr_holiday_calendar_write_rank_delete ON public.hr_holiday_calendar
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (COALESCE(
    (select public.is_admin())
    OR (select public.is_client_owner())
    OR (SELECT p.hr_role FROM profiles p WHERE p.id = (select auth.uid())) IN ('supervisor', 'manager'),
    false));

-- Seed dedupes by name against the list on screen, so a failed load (or a second tab) inserted the
-- whole year again and nothing refused it. Live on 2026-09-14: zero duplicate groups.
CREATE UNIQUE INDEX IF NOT EXISTS hr_holiday_calendar_client_date_name_key
  ON public.hr_holiday_calendar (client_id, bs_year, bs_month, bs_day, name);

-- The only HR table deciding a pay rate that carried no audit trigger.
DROP TRIGGER IF EXISTS audit_hr_holiday_calendar ON public.hr_holiday_calendar;
CREATE TRIGGER audit_hr_holiday_calendar
  AFTER INSERT OR UPDATE OR DELETE ON public.hr_holiday_calendar
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();

-- ── (4) CIT / provident fund reduces taxable income ──────────────────────────────────────────
--
-- The Pay Setup chip said a CIT deduction "reduces their taxable income", and payroll never took
-- it off: tds.js deducted SSF alone from the retirement bucket. Nepal's Income Tax Act treats
-- SSF, EPF and CIT as ONE deduction, capped at the lower of NPR 5,00,000 or a third of assessable
-- income (memory: nepal-payroll-law). Decided: payroll deducts it.
--
-- A deduction component says so explicitly (retirement_fund), rather than payroll guessing from a
-- name the owner typed. The payslip stores the month's contribution so fiscal-year-to-date relief
-- sums real figures, the same way ytd SSF sums ssf_employee. Live on 2026-09-14 there are no
-- deduction components at all, so the backfill below touches nothing today; it exists for any
-- client that adds the chip before this deploys.

ALTER TABLE public.hr_salary_components
  ADD COLUMN IF NOT EXISTS retirement_fund boolean NOT NULL DEFAULT false;

UPDATE public.hr_salary_components
   SET retirement_fund = true
 WHERE type = 'deduction'
   AND retirement_fund = false
   AND (name ILIKE '%CIT%' OR name ILIKE '%provident%');

ALTER TABLE public.hr_payslips
  ADD COLUMN IF NOT EXISTS retirement_contribution numeric NOT NULL DEFAULT 0;

-- ── (5) A blank employee code is NULL, not '' ────────────────────────────────────────────────
-- The form stored '' and its tip promised a code would be generated; nothing ever generated one.
UPDATE public.hr_employees SET employee_code = NULL WHERE employee_code = '';

NOTIFY pgrst, 'reload schema';

-- Verification ----------------------------------------------------------------------------------
-- Run separately after applying (one read per call). The behavioural check (S748) was a DO block
-- that created a probe client, five logins (Owner, HR staff, HR supervisor, admin, a Self-Service
-- login), three employees and a finalized payslip, exercised every rule above as those logins, and
-- ended in RAISE EXCEPTION so nothing was left behind — see CHANGELOG S748 for what it returned.
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.hr_employees'::regclass AND NOT tgisinternal;
--   SELECT has_function_privilege('anon', 'public.employee_pay_history(uuid[])', 'EXECUTE');   -- false
--   SELECT policyname, permissive, cmd FROM pg_policies WHERE tablename = 'hr_holiday_calendar';
