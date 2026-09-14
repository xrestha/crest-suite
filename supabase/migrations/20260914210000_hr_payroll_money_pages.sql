-- S751 — Payroll, Calculation, Festival Allowance, Incentives, Advances & Loans and TADA Claims
-- re-analysed. Every rule below is one the pages already believed they had, made true for a caller
-- that skips the page. Decisions taken with Aashish on 2026-09-14 are named where they apply.
--
-- Live on 2026-09-14, before this ran: 0 TADA claims with an end date before the start, 0 negative
-- or NaN amounts on claims, claim lines, festival allowances or incentives, 0 blank or untrimmed
-- festival names / run labels, 0 advances repaid beyond their amount, 0 settled advances with a
-- balance, 0 active advances with nothing owed. So every constraint and guard below builds against
-- clean data and changes nothing already stored.

-- ── (1) Money tables: writes need HR MANAGER rank ───────────────────────────────────────────────
--
-- Each of these carried one same-client permissive policy, the account-type fences and (since S750)
-- a staff-rank fence — and nothing about rank for a SUPERVISOR. Every page that writes them is
-- manager-only, so a supervisor could rewrite a finalized payslip's net pay, raise their own
-- incentive, record a fake advance repayment, or flip a finalized run back to draft (which also
-- switches off the S749 attendance and overtime locks) straight through PostgREST. Same RESTRICTIVE
-- per-command shape as S749's supervisor fences, one rank up. Reads are untouched: supervisors keep
-- reading pay (Overtime and the Roster's labour cost price hours from it, per S750).
DO $$
DECLARE
  t text;
  rank_ok constant text :=
    'COALESCE((select public.is_admin()) OR (select public.is_client_owner()) '
    'OR (SELECT p.hr_role FROM public.profiles p WHERE p.id = (select auth.uid())) = ''manager'', false)';
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hr_payroll_runs', 'hr_payslips', 'hr_salary_components', 'hr_final_settlements',
    'hr_advances', 'hr_advance_repayments', 'hr_festival_allowances', 'hr_incentives',
    'hr_incentive_configs'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write_rank_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write_rank_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write_rank_delete', t);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (%s)',
      t || '_write_rank_insert', t, rank_ok);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)',
      t || '_write_rank_update', t, rank_ok, rank_ok);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated USING (%s)',
      t || '_write_rank_delete', t, rank_ok);
  END LOOP;
END $$;

-- ── (2) TADA claims: the staff-rank fence S750 missed, and supervisor rank to write ──────────────
--
-- hr_tada_claims and its lines were left off S750's list, so an HR "staff" login — whose only page
-- is the Holiday Calendar — could read every coworker's claims and approve, pay, edit or delete them.
-- The page opens at supervisor; claim-level rules (who approves, who pays, what may change) are the
-- trigger in (6).
DO $$
DECLARE
  t text;
  rank_ok constant text :=
    'COALESCE((select public.is_admin()) OR (select public.is_client_owner()) '
    'OR (SELECT p.hr_role FROM public.profiles p WHERE p.id = (select auth.uid())) IN (''supervisor'', ''manager''), false)';
BEGIN
  FOREACH t IN ARRAY ARRAY['hr_tada_claims', 'hr_tada_claim_items'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS no_hr_staff_rank ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY no_hr_staff_rank ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING (NOT (select public.is_hr_staff_rank())) WITH CHECK (NOT (select public.is_hr_staff_rank()))', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write_rank_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write_rank_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write_rank_delete', t);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (%s)',
      t || '_write_rank_insert', t, rank_ok);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)',
      t || '_write_rank_update', t, rank_ok, rank_ok);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated USING (%s)',
      t || '_write_rank_delete', t, rank_ok);
  END LOOP;
END $$;

-- hr_incentive_configs never had the Self-Service fence (its permissive policy predates it) or the
-- staff-rank fence, so an employee's Staff-app login could change a bonus type's amount before a
-- manager generated the run. (1) already fences writes to manager; these fence reads as well.
DROP POLICY IF EXISTS no_self_service_accounts ON public.hr_incentive_configs;
CREATE POLICY no_self_service_accounts ON public.hr_incentive_configs AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT (select public.is_hr_self_service())) WITH CHECK (NOT (select public.is_hr_self_service()));
DROP POLICY IF EXISTS no_hr_staff_rank ON public.hr_incentive_configs;
CREATE POLICY no_hr_staff_rank ON public.hr_incentive_configs AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT (select public.is_hr_staff_rank())) WITH CHECK (NOT (select public.is_hr_staff_rank()));

-- ── (3) A finalized payroll run and its payslips are locked ────────────────────────────────────
--
-- Regenerate, the TDS edit and Finalize checked the run's status in the browser tab's memory only.
-- A second tab still showing Draft could hard-delete and rebuild every payslip of a run already paid,
-- or rewrite one TDS figure, with nothing refusing it. Reopen is the way back (manager rank, (1)).
ALTER TABLE public.hr_payslips ADD COLUMN IF NOT EXISTS tds_overridden boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.hr_payslips.tds_overridden IS
  'S751: true once a person typed this TDS. Payroll''s staleness check treats any other TDS difference as out of date, not as an override.';

CREATE OR REPLACE FUNCTION public.hr_payroll_run_is_finalized(p_run_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM hr_payroll_runs r
      JOIN clients c ON c.id = r.client_id
     WHERE r.id = p_run_id AND r.status = 'finalized'
       AND COALESCE(public.is_admin() OR r.client_id = public.my_client_id(), false)
  )
$$;
REVOKE ALL ON FUNCTION public.hr_payroll_run_is_finalized(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_payroll_run_is_finalized(uuid) TO authenticated, service_role;

-- INVOKER, keyed off current_user, like S749's guards: the service role (Danger Zone) passes. The
-- Crest operator passes too, so an Export/Import restore can insert a finalized run's payslips.
CREATE OR REPLACE FUNCTION public.hr_payslips_guard_finalized()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND public.hr_payroll_run_is_finalized(OLD.run_id) THEN
    RAISE EXCEPTION 'hr_run_finalized: this payroll run is finalized — reopen it first';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND public.hr_payroll_run_is_finalized(NEW.run_id) THEN
    RAISE EXCEPTION 'hr_run_finalized: this payroll run is finalized — reopen it first';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.hr_payslips_guard_finalized() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_payslips_guard_finalized ON public.hr_payslips;
CREATE TRIGGER hr_payslips_guard_finalized
  BEFORE INSERT OR UPDATE OR DELETE ON public.hr_payslips
  FOR EACH ROW EXECUTE FUNCTION public.hr_payslips_guard_finalized();

-- A finalized run cannot be deleted (its payslips cascade). A delete cascading from a client that is
-- already gone is let through.
CREATE OR REPLACE FUNCTION public.hr_payroll_runs_guard_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN RETURN OLD; END IF;
  IF OLD.status = 'finalized' AND EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id) THEN
    RAISE EXCEPTION 'hr_run_finalized: a finalized payroll run cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_payroll_runs_guard_delete() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_payroll_runs_guard_delete ON public.hr_payroll_runs;
CREATE TRIGGER hr_payroll_runs_guard_delete
  BEFORE DELETE ON public.hr_payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.hr_payroll_runs_guard_delete();

-- ── (4) Periods: only an Owner or the operator may delete one, and never one with paid payroll ──
--
-- monthly_periods fenced only Self-Service and HR-role accounts, so an IMS stock-count login or a
-- POS PIN waiter could DELETE a month over REST — and hr_payroll_runs, hr_payslips and hr_attendance
-- all cascade from it. No page deletes a period except the operator's Export/Import restore.
DROP POLICY IF EXISTS monthly_periods_delete_owner ON public.monthly_periods;
CREATE POLICY monthly_periods_delete_owner ON public.monthly_periods AS RESTRICTIVE FOR DELETE TO authenticated
  USING (COALESCE((select public.is_admin()) OR (select public.is_client_owner()), false));

CREATE OR REPLACE FUNCTION public.monthly_periods_guard_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id) THEN RETURN OLD; END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll_runs WHERE period_id = OLD.id AND status = 'finalized') THEN
    RAISE EXCEPTION 'period_has_finalized_payroll: this month has finalized payroll and cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.monthly_periods_guard_delete() FROM PUBLIC;
DROP TRIGGER IF EXISTS monthly_periods_guard_delete ON public.monthly_periods;
CREATE TRIGGER monthly_periods_guard_delete
  BEFORE DELETE ON public.monthly_periods
  FOR EACH ROW EXECUTE FUNCTION public.monthly_periods_guard_delete();

-- ── (5) Festival Allowance and Incentives ─────────────────────────────────────────────────────
--
-- The month a bonus is PAID. Both pages assumed Ashwin of the selected BS year, so a bonus paid
-- Baisakh–Ashadh was taxed on the next fiscal year's slabs. Existing rows were all computed as
-- Ashwin, so that is their back-fill.
ALTER TABLE public.hr_festival_allowances ADD COLUMN IF NOT EXISTS bs_month integer NOT NULL DEFAULT 6;
ALTER TABLE public.hr_incentives          ADD COLUMN IF NOT EXISTS bs_month integer NOT NULL DEFAULT 6;
ALTER TABLE public.hr_festival_allowances DROP CONSTRAINT IF EXISTS hr_festival_allowances_bs_month_check;
ALTER TABLE public.hr_festival_allowances ADD CONSTRAINT hr_festival_allowances_bs_month_check CHECK (bs_month BETWEEN 1 AND 12);
ALTER TABLE public.hr_incentives DROP CONSTRAINT IF EXISTS hr_incentives_bs_month_check;
ALTER TABLE public.hr_incentives ADD CONSTRAINT hr_incentives_bs_month_check CHECK (bs_month BETWEEN 1 AND 12);

-- Every other TDS column is numeric; this one refused a decimal override.
ALTER TABLE public.hr_festival_allowances ALTER COLUMN tds TYPE numeric USING tds::numeric;

-- numeric accepts 'NaN', and NaN > 0 is true, so a plain >= 0 would let it through.
ALTER TABLE public.hr_festival_allowances DROP CONSTRAINT IF EXISTS hr_festival_allowances_amounts_check;
ALTER TABLE public.hr_festival_allowances ADD CONSTRAINT hr_festival_allowances_amounts_check
  CHECK (amount >= 0 AND amount <> 'NaN' AND COALESCE(tds, 0) >= 0 AND COALESCE(tds, 0) <> 'NaN');
ALTER TABLE public.hr_incentives DROP CONSTRAINT IF EXISTS hr_incentives_amounts_check;
ALTER TABLE public.hr_incentives ADD CONSTRAINT hr_incentives_amounts_check
  CHECK (amount >= 0 AND amount <> 'NaN' AND COALESCE(tds, 0) >= 0 AND COALESCE(tds, 0) <> 'NaN');

-- Decided with Aashish: a bonus type may be reduced for months worked.
ALTER TABLE public.hr_incentive_configs ADD COLUMN IF NOT EXISTS prorate_by_service boolean NOT NULL DEFAULT false;

-- One trigger for both tables. The run's name is its key, so it is trimmed and may not be blank
-- ("Dashain " and "Dashain" were two full allowances). A finalized row is locked: the only change
-- allowed is Reopen (status back to draft, nothing else). A Generate from a stale tab used to upsert
-- every finalized row back to draft with recomputed amounts, and an inline edit rewrote one.
CREATE OR REPLACE FUNCTION public.hr_bonus_rows_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF TG_TABLE_NAME = 'hr_festival_allowances' THEN
      NEW.festival_name := btrim(COALESCE(NEW.festival_name, ''));
      IF NEW.festival_name = '' THEN RAISE EXCEPTION 'bonus_name_blank: name the festival'; END IF;
    ELSE
      NEW.run_label := btrim(COALESCE(NEW.run_label, ''));
      IF NEW.run_label = '' THEN RAISE EXCEPTION 'bonus_name_blank: name the run'; END IF;
    END IF;
  END IF;

  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'finalized' AND EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id) THEN
      RAISE EXCEPTION 'bonus_finalized: a finalized row cannot be deleted — reopen the run first';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'finalized' THEN
    IF NEW.status = 'draft'
       AND NEW.amount IS NOT DISTINCT FROM OLD.amount
       AND NEW.tds IS NOT DISTINCT FROM OLD.tds
       AND NEW.employee_id = OLD.employee_id
       AND NEW.bs_year = OLD.bs_year
       AND NEW.bs_month = OLD.bs_month THEN
      RETURN NEW;          -- Reopen
    END IF;
    RAISE EXCEPTION 'bonus_finalized: this run is finalized — reopen it first';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_bonus_rows_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_festival_allowances_guard ON public.hr_festival_allowances;
CREATE TRIGGER hr_festival_allowances_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.hr_festival_allowances
  FOR EACH ROW EXECUTE FUNCTION public.hr_bonus_rows_guard();
DROP TRIGGER IF EXISTS hr_incentives_guard ON public.hr_incentives;
CREATE TRIGGER hr_incentives_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.hr_incentives
  FOR EACH ROW EXECUTE FUNCTION public.hr_bonus_rows_guard();

-- ── (6) Advances & Loans ─────────────────────────────────────────────────────────────────────
--
-- Decided with Aashish: "Settle" only when nothing is owed; forgiving money is a named Write-off with
-- a reason, its own status, and a way back. Before this, Settle on an advance with NPR 8,000 still
-- owed silently stopped payroll recovering it and Final Settlement from netting it off.
ALTER TABLE public.hr_advances ADD COLUMN IF NOT EXISTS written_off_at timestamptz;
ALTER TABLE public.hr_advances ADD COLUMN IF NOT EXISTS written_off_by uuid;
ALTER TABLE public.hr_advances ADD COLUMN IF NOT EXISTS write_off_reason text;
ALTER TABLE public.hr_advances ADD COLUMN IF NOT EXISTS write_off_amount numeric;
ALTER TABLE public.hr_advances DROP CONSTRAINT IF EXISTS hr_advances_status_check;
ALTER TABLE public.hr_advances ADD CONSTRAINT hr_advances_status_check
  CHECK (status = ANY (ARRAY['active'::text, 'settled'::text, 'written_off'::text]));
ALTER TABLE public.hr_advances DROP CONSTRAINT IF EXISTS hr_advances_installment_check;
ALTER TABLE public.hr_advances ADD CONSTRAINT hr_advances_installment_check
  CHECK (installment_amount IS NULL OR (installment_amount > 0 AND installment_amount <> 'NaN'));
ALTER TABLE public.hr_advance_repayments DROP CONSTRAINT IF EXISTS hr_advance_repayments_amount_nan_check;
ALTER TABLE public.hr_advance_repayments ADD CONSTRAINT hr_advance_repayments_amount_nan_check CHECK (amount <> 'NaN');

CREATE OR REPLACE FUNCTION public.hr_advance_repaid(p_advance_id uuid, p_exclude_repayment uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT COALESCE(SUM(amount), 0) FROM hr_advance_repayments
   WHERE advance_id = p_advance_id AND (p_exclude_repayment IS NULL OR id <> p_exclude_repayment)
$$;
REVOKE ALL ON FUNCTION public.hr_advance_repaid(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_advance_repaid(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.hr_advances_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_repaid numeric;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- The repayments cascade, and payroll runs and settlements depend on them: deleting a loan with
    -- two finalized payroll recoveries erased the ledger rows those payslips point at.
    IF EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id)
       AND EXISTS (SELECT 1 FROM hr_advance_repayments WHERE advance_id = OLD.id) THEN
      RAISE EXCEPTION 'advance_has_repayments: an advance with repayments cannot be deleted — write it off instead';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_repaid := public.hr_advance_repaid(NEW.id);
    IF NEW.amount + 0.01 < v_repaid THEN
      RAISE EXCEPTION 'advance_amount_below_repaid: NPR % has already been repaid', v_repaid;
    END IF;
    IF NEW.status = 'settled' AND OLD.status IS DISTINCT FROM 'settled' AND NEW.amount - v_repaid > 0.01 THEN
      RAISE EXCEPTION 'advance_not_repaid: NPR % is still owed — record the repayment or write it off', round(NEW.amount - v_repaid, 2);
    END IF;
    IF NEW.status = 'written_off' AND OLD.status IS DISTINCT FROM 'written_off' THEN
      IF btrim(COALESCE(NEW.write_off_reason, '')) = '' THEN
        RAISE EXCEPTION 'write_off_reason_required: say why this balance is being written off';
      END IF;
      IF NEW.amount - v_repaid <= 0.01 THEN
        RAISE EXCEPTION 'write_off_nothing_owed: nothing is owed on this advance';
      END IF;
      NEW.written_off_at := now();
      NEW.written_off_by := (select auth.uid());
      NEW.write_off_amount := round(NEW.amount - v_repaid, 2);
    ELSIF NEW.status <> 'written_off' AND OLD.status = 'written_off' THEN
      NEW.written_off_at := NULL; NEW.written_off_by := NULL;
      NEW.write_off_reason := NULL; NEW.write_off_amount := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_advances_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_advances_guard ON public.hr_advances;
CREATE TRIGGER hr_advances_guard
  BEFORE UPDATE OR DELETE ON public.hr_advances
  FOR EACH ROW EXECUTE FUNCTION public.hr_advances_guard();

-- A repayment may not exceed what is owed, must belong to the advance's employee and client, and
-- may only be booked against an OPEN advance. A typed 50,000 instead of 5,000 used to close a loan
-- for good with no way back. Serialised per advance so two tabs cannot both fit under the cap.
CREATE OR REPLACE FUNCTION public.hr_advance_repayments_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_adv hr_advances;
  v_repaid numeric;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN RETURN NEW; END IF;
  SELECT * INTO v_adv FROM hr_advances WHERE id = NEW.advance_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'advance_not_found'; END IF;
  IF v_adv.employee_id <> NEW.employee_id OR v_adv.client_id <> NEW.client_id THEN
    RAISE EXCEPTION 'repayment_advance_mismatch: this repayment does not belong to that advance';
  END IF;
  IF TG_OP = 'INSERT' AND v_adv.status <> 'active' THEN
    RAISE EXCEPTION 'advance_not_active: this advance is % — nothing is being recovered on it', v_adv.status;
  END IF;
  v_repaid := public.hr_advance_repaid(NEW.advance_id, CASE WHEN TG_OP = 'UPDATE' THEN NEW.id END);
  IF v_repaid + NEW.amount > v_adv.amount + 0.01 THEN
    RAISE EXCEPTION 'repayment_exceeds_outstanding: only NPR % is still owed', round(GREATEST(v_adv.amount - v_repaid, 0), 2);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_advance_repayments_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_advance_repayments_guard ON public.hr_advance_repayments;
CREATE TRIGGER hr_advance_repayments_guard
  BEFORE INSERT OR UPDATE ON public.hr_advance_repayments
  FOR EACH ROW EXECUTE FUNCTION public.hr_advance_repayments_guard();

-- The advance's status follows its balance: repaid in full → settled; a repayment removed from a
-- settled advance → active again. A written-off advance is a decision and is left alone. Before
-- this, a cash repayment that cleared the balance left the advance Active with nothing owed, still
-- counted in Active Advances, while Help said it closed automatically.
CREATE OR REPLACE FUNCTION public.hr_advance_repayments_sync_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_id uuid := COALESCE(NEW.advance_id, OLD.advance_id);
  v_amount numeric;
  v_status text;
  v_repaid numeric;
BEGIN
  SELECT amount, status INTO v_amount, v_status FROM hr_advances WHERE id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_repaid := public.hr_advance_repaid(v_id);
  IF v_status = 'active' AND v_amount - v_repaid <= 0.01 THEN
    UPDATE hr_advances SET status = 'settled' WHERE id = v_id;
  ELSIF v_status = 'settled' AND v_amount - v_repaid > 0.01 THEN
    UPDATE hr_advances SET status = 'active' WHERE id = v_id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_advance_repayments_sync_status() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_advance_repayments_sync_status ON public.hr_advance_repayments;
CREATE TRIGGER hr_advance_repayments_sync_status
  AFTER INSERT OR UPDATE OR DELETE ON public.hr_advance_repayments
  FOR EACH ROW EXECUTE FUNCTION public.hr_advance_repayments_sync_status();

-- ── (7) TADA claims ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.hr_tada_claims DROP CONSTRAINT IF EXISTS hr_tada_claims_dates_check;
ALTER TABLE public.hr_tada_claims ADD CONSTRAINT hr_tada_claims_dates_check CHECK (end_date >= start_date);
ALTER TABLE public.hr_tada_claims DROP CONSTRAINT IF EXISTS hr_tada_claims_total_check;
ALTER TABLE public.hr_tada_claims ADD CONSTRAINT hr_tada_claims_total_check
  CHECK (total_amount >= 0 AND total_amount <> 'NaN' AND total_amount <> 'Infinity');
ALTER TABLE public.hr_tada_claim_items DROP CONSTRAINT IF EXISTS hr_tada_claim_items_amount_check;
ALTER TABLE public.hr_tada_claim_items ADD CONSTRAINT hr_tada_claim_items_amount_check
  CHECK (amount >= 0 AND amount <> 'NaN' AND amount <> 'Infinity');

-- Is the signed-in account this claim's own employee? A Self-Service login carries hr_employee_id;
-- a supervisor's own login usually does not, so the employee record's email is matched as well.
CREATE OR REPLACE FUNCTION public.hr_is_own_employee(p_employee_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.hr_employee_id = p_employee_id)
    OR EXISTS (
      SELECT 1 FROM hr_employees e
       WHERE e.id = p_employee_id
         AND NULLIF(btrim(e.email), '') IS NOT NULL
         AND lower(btrim(e.email)) = lower(COALESCE(auth.jwt() ->> 'email', ''))
    ), false)
$$;
REVOKE ALL ON FUNCTION public.hr_is_own_employee(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_is_own_employee(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.hr_is_manager_rank()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(public.is_admin() OR public.is_client_owner()
    OR (SELECT p.hr_role FROM profiles p WHERE p.id = auth.uid()) = 'manager', false)
$$;
REVOKE ALL ON FUNCTION public.hr_is_manager_rank() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_is_manager_rank() TO authenticated, service_role;

-- The claim ladder, enforced (decided with Aashish: a supervisor approves OTHER people's claims,
-- marking a claim Paid needs a manager). Approve, Reject and Mark Paid wrote by id alone from
-- whatever the screen loaded, so a stale screen could approve a claim payroll had already paid
-- (making it payable again) or re-mark it Paid in cash; approved_by was whatever the browser sent;
-- and an approved claim's amount could be changed before payroll picked it up.
CREATE OR REPLACE FUNCTION public.hr_tada_claims_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'pending' AND EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id) THEN
      RAISE EXCEPTION 'tada_claim_locked: only a pending claim can be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'tada_claim_must_start_pending: a new claim starts as pending';
    END IF;
    NEW.submitted_by := (select auth.uid());
    NEW.approved_by := NULL; NEW.approved_at := NULL; NEW.paid_at := NULL; NEW.paid_method := NULL;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.status <> 'pending' AND (
       NEW.employee_id IS DISTINCT FROM OLD.employee_id
    OR NEW.start_date  IS DISTINCT FROM OLD.start_date
    OR NEW.end_date    IS DISTINCT FROM OLD.end_date
    OR NEW.total_amount IS DISTINCT FROM OLD.total_amount) THEN
    RAISE EXCEPTION 'tada_claim_locked: a decided claim''s employee, dates and amount cannot change';
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected') THEN
    IF public.hr_is_own_employee(OLD.employee_id) THEN
      RAISE EXCEPTION 'tada_own_claim: you cannot approve or reject your own claim';
    END IF;
    NEW.approved_by := (select auth.uid());
    NEW.approved_at := now();
    RETURN NEW;
  END IF;

  IF OLD.status = 'approved' AND NEW.status = 'paid' THEN
    IF NOT public.hr_is_manager_rank() THEN
      RAISE EXCEPTION 'tada_pay_rank: marking a claim paid needs an HR manager';
    END IF;
    IF btrim(COALESCE(NEW.paid_method, '')) = '' THEN
      RAISE EXCEPTION 'tada_paid_method_required: say how the claim was paid';
    END IF;
    NEW.paid_at := COALESCE(NEW.paid_at, now());
    RETURN NEW;
  END IF;

  -- Payroll Reopen: only a claim payroll itself paid goes back to Approved.
  IF OLD.status = 'paid' AND NEW.status = 'approved' AND OLD.paid_method = 'Payroll' THEN
    IF NOT public.hr_is_manager_rank() THEN
      RAISE EXCEPTION 'tada_pay_rank: reopening a payroll payment needs an HR manager';
    END IF;
    NEW.paid_at := NULL; NEW.paid_method := NULL;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'tada_transition_invalid: a % claim cannot become %', OLD.status, NEW.status;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_tada_claims_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_tada_claims_guard ON public.hr_tada_claims;
CREATE TRIGGER hr_tada_claims_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.hr_tada_claims
  FOR EACH ROW EXECUTE FUNCTION public.hr_tada_claims_guard();

-- A claim's lines can only change while it is pending (the total is frozen once decided).
CREATE OR REPLACE FUNCTION public.hr_tada_claim_items_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_status text;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT status INTO v_status FROM hr_tada_claims WHERE id = COALESCE(NEW.claim_id, OLD.claim_id);
  IF NOT FOUND THEN RETURN COALESCE(NEW, OLD); END IF;   -- the claim is being deleted (cascade)
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'tada_claim_locked: a decided claim''s lines cannot change';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.hr_tada_claim_items_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_tada_claim_items_guard ON public.hr_tada_claim_items;
CREATE TRIGGER hr_tada_claim_items_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.hr_tada_claim_items
  FOR EACH ROW EXECUTE FUNCTION public.hr_tada_claim_items_guard();

-- The Staff app's submit. Adds: a trip that ends before it starts, an amount that is not a finite
-- number ('NaN' passed the old `<= 0` test and turned every total it was summed into NaN), and the
-- same claim sent twice (live data had five pairs 0–2 minutes apart, two of them paid twice).
CREATE OR REPLACE FUNCTION public.submit_my_tada_claim(p_trip_purpose text, p_destination text, p_start_date date, p_end_date date, p_notes text, p_items jsonb, p_start_point text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id uuid;
  v_employee_id uuid;
  v_claim_id uuid;
  v_total numeric := 0;
  v_item jsonb;
  v_amount numeric;
BEGIN
  SELECT client_id, hr_employee_id INTO v_client_id, v_employee_id
  FROM profiles WHERE id = auth.uid() AND hr_self_service = true;
  IF v_employee_id IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;

  IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date < p_start_date THEN
    RAISE EXCEPTION 'tada_dates_invalid: the trip ends before it starts';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    BEGIN
      v_amount := (v_item->>'amount')::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'tada_amount_invalid: an expense amount is not a number';
    END;
    IF v_amount IS NULL THEN CONTINUE; END IF;
    IF v_amount = 'NaN' OR v_amount = 'Infinity' OR v_amount = '-Infinity' OR v_amount > 10000000 THEN
      RAISE EXCEPTION 'tada_amount_invalid: an expense amount is not a real figure';
    END IF;
    v_total := v_total + GREATEST(v_amount, 0);
  END LOOP;
  IF v_total <= 0 THEN RAISE EXCEPTION 'add at least one expense line with an amount'; END IF;

  -- Serialise per employee so a double-tap cannot slip two identical claims past the check below.
  PERFORM pg_advisory_xact_lock(hashtext('hr_tada_claims:' || v_employee_id::text));
  IF EXISTS (
    SELECT 1 FROM hr_tada_claims
     WHERE employee_id = v_employee_id AND start_date = p_start_date AND end_date = p_end_date
       AND total_amount = v_total AND status IN ('pending', 'approved', 'paid')
  ) THEN
    RAISE EXCEPTION 'tada_duplicate: this claim has already been submitted';
  END IF;

  INSERT INTO hr_tada_claims (client_id, employee_id, trip_purpose, destination, start_point, start_date, end_date, total_amount, status, submitted_by, notes)
  VALUES (v_client_id, v_employee_id, NULLIF(left(coalesce(p_trip_purpose, ''), 200), ''), NULLIF(left(coalesce(p_destination, ''), 200), ''),
          NULLIF(left(coalesce(p_start_point, ''), 200), ''), p_start_date, p_end_date, v_total, 'pending', auth.uid(), NULLIF(left(coalesce(p_notes, ''), 500), ''))
  RETURNING id INTO v_claim_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    IF COALESCE((v_item->>'amount')::numeric, 0) > 0 THEN
      INSERT INTO hr_tada_claim_items (claim_id, category, description, amount)
      VALUES (v_claim_id, v_item->>'category', NULLIF(v_item->>'description', ''), (v_item->>'amount')::numeric);
    END IF;
  END LOOP;

  RETURN v_claim_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.submit_my_tada_claim(text, text, date, date, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_my_tada_claim(text, text, date, date, text, jsonb, text) TO authenticated, service_role;

-- The manager form's claim and its lines in ONE transaction (it was two writes, and a failed second
-- left a claim with a total and no lines). SECURITY INVOKER: RLS and the triggers above apply.
CREATE OR REPLACE FUNCTION public.create_tada_claim(p_employee_id uuid, p_trip_purpose text, p_destination text, p_start_point text, p_start_date date, p_end_date date, p_notes text, p_items jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id uuid;
  v_claim_id uuid;
  v_total numeric := 0;
  v_item jsonb;
  v_amount numeric;
BEGIN
  SELECT client_id INTO v_client_id FROM hr_employees WHERE id = p_employee_id;
  IF v_client_id IS NULL THEN RAISE EXCEPTION 'employee_not_found'; END IF;
  IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date < p_start_date THEN
    RAISE EXCEPTION 'tada_dates_invalid: the trip ends before it starts';
  END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    v_amount := NULLIF(v_item->>'amount', '')::numeric;
    IF v_amount IS NULL THEN CONTINUE; END IF;
    IF v_amount < 0 OR v_amount = 'NaN' OR v_amount = 'Infinity' THEN
      RAISE EXCEPTION 'tada_amount_invalid: an expense amount cannot be negative';
    END IF;
    v_total := v_total + v_amount;
  END LOOP;
  IF v_total <= 0 THEN RAISE EXCEPTION 'add at least one expense line with an amount'; END IF;

  INSERT INTO hr_tada_claims (client_id, employee_id, trip_purpose, destination, start_point, start_date, end_date, total_amount, status, notes)
  VALUES (v_client_id, p_employee_id, NULLIF(btrim(COALESCE(p_trip_purpose, '')), ''), NULLIF(btrim(COALESCE(p_destination, '')), ''),
          NULLIF(btrim(COALESCE(p_start_point, '')), ''), p_start_date, p_end_date, v_total, 'pending', NULLIF(btrim(COALESCE(p_notes, '')), ''))
  RETURNING id INTO v_claim_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    v_amount := NULLIF(v_item->>'amount', '')::numeric;
    IF COALESCE(v_amount, 0) > 0 THEN
      INSERT INTO hr_tada_claim_items (claim_id, category, description, amount)
      VALUES (v_claim_id, v_item->>'category', NULLIF(btrim(COALESCE(v_item->>'description', '')), ''), v_amount);
    END IF;
  END LOOP;
  RETURN v_claim_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_tada_claim(uuid, text, text, text, date, date, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_tada_claim(uuid, text, text, text, date, date, text, jsonb) TO authenticated, service_role;

-- ── (8) Audit trails on the money tables that had none ─────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hr_advances', 'hr_advance_repayments', 'hr_incentives', 'hr_incentive_configs', 'hr_tada_claims'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'audit_' || t, t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.log_audit()', 'audit_' || t, t);
  END LOOP;
END $$;

-- ── (9) Grant drift ─────────────────────────────────────────────────────────────────────────
-- hr_final_settlements was created after the 20260720160000 sweep and kept TRUNCATE/TRIGGER/
-- REFERENCES for anon and authenticated. REST cannot issue them; this is tidiness, not a hole.
REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.hr_final_settlements FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- Verification (run separately; the S751 changelog records the rolled-back probe):
--   SELECT tablename, count(*) FROM pg_policies WHERE policyname LIKE '%_write_rank_%'
--    AND tablename IN ('hr_payroll_runs','hr_payslips','hr_tada_claims') GROUP BY 1;          -- 3 each
--   SELECT tgname FROM pg_trigger WHERE tgname LIKE 'hr_%guard%' OR tgname LIKE 'monthly_periods_guard%';
--   SELECT has_function_privilege('anon', 'public.create_tada_claim(uuid,text,text,text,date,date,text,jsonb)', 'EXECUTE'); -- false
