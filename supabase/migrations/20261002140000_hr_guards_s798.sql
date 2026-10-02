-- S798 stage 3a — own-row and operator guards. Findings GAP-OPERATOR-1, PEOPLE-ACCESS-2, BONUS-LEDGERS-5,
-- LEAVE-OT-HOLIDAYS-5 and BONUS-LEDGERS-2 in docs/hr-review-s798/, fixes in HR_TODO.md S798.4 (owner
-- decisions H2 (a), H3 (A) and H13 (a), taken 2026-09-30). Every existing function below is rebuilt from
-- its LIVE body (pg_get_functiondef, read 2026-10-02), and each change is marked "S798 3a".
--
-- 1. GAP-OPERATOR-1 (H3: Crest follows your staff's rule, except when restoring a backup into an empty
--    company). The HR money guards let the operator (is_admin()) through on every event, so an operator
--    screen opened before Finalize could still rewrite a finalized run, bonus or loan afterwards. A
--    restore only INSERTs (restoreClientData.js refuses a client that already has data), so the operator
--    now passes only on INSERT in hr_payslips_guard_finalized, hr_payslips_guard_net, hr_bonus_rows_guard,
--    hr_advance_repayments_guard, hr_advance_repayments_guard_ledger, hr_payroll_runs_guard_delete,
--    hr_payroll_runs_guard_settled, hr_tada_claims_guard, hr_tada_claim_items_guard,
--    hr_final_settlements_guard, hr_salary_payments_guard and the overlap test in
--    hr_leave_requests_validate. hr_advances_guard has no INSERT event, so its operator pass goes
--    entirely. The `current_user NOT IN ('anon','authenticated')` arm (SECURITY DEFINER bodies, the
--    service role, Danger Zone) stays on every event. During a restore the repayment sync trigger
--    UPDATEs hr_advances (settled -> active on a partial repayment, back to settled on the last); both
--    pass hr_advances_guard's ordinary checks.
-- 2. PEOPLE-ACCESS-2 (H2: only the Owner sets a person's own pay). Below the Owner,
--    hr_employees_guard_own_pay refuses a change to your own basic, pay basis, bank, SSF, insurance
--    premiums or email (email is one of the two links hr_is_own_employee follows, so changing it would
--    unlink the record), and hr_salary_components_guard_own refuses any write to your own allowances and
--    deductions. Hint hr_own_pay.
-- 3. BONUS-LEDGERS-5 and the monthly payroll (H2: only the Owner finalizes a run that pays them). Below
--    the Owner, hr_bonus_rows_guard refuses moving your own festival or incentive row into or out of
--    finalized, and finalize_payroll_run / reopen_payroll_run refuse a run holding your own payslip.
--    Amounts stay writable. Hint hr_own_run.
-- 4. LEAVE-OT-HOLIDAYS-5 (H2: own attendance marks are listed before you finalize).
--    hr_own_attendance_changes(period) lists every attendance mark made, changed or removed by a login
--    linked to that employee (profile link or the same email, the two tests hr_is_own_employee makes),
--    read from audit_logs, so the Attendance Sheet's writes are untouched. A removed mark counts:
--    payroll pays a blank day. The operator's writes are left out. Owner, operator or HR manager only.
-- 5. BONUS-LEDGERS-2 (H13: "Undo approval"). hr_tada_claims_guard lets an HR manager or the Owner move an
--    approved claim (not yet paid) or a rejected one back to pending, clearing its decision stamp.
--
-- No HR-ranked login is linked to its own employee record today (checked live 2026-10-02), so 2-4
-- change nobody's work yet.
--
-- Reverse: restore each function's previous body (every change is marked S798 3a, and undoing a marked
-- change restores the live body it was built from), then DROP the triggers hr_employees_guard_own_pay
-- and hr_salary_components_guard_own, their two functions, and hr_own_attendance_changes(uuid).

-- ══ 1. The operator passes only on INSERT (GAP-OPERATOR-1), with 3 (BONUS-LEDGERS-5) and 5 (BONUS-LEDGERS-2) ══

-- ── 1a. hr_payslips_guard_finalized ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_payslips_guard_finalized()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- S798 3a (GAP-OPERATOR-1, H3): the operator passes only on INSERT, which is all an Export/Import
  -- restore into an empty company does. Regenerate, a typed tax or a delete on a
  -- finalized run is refused for the operator as for an HR manager: reopen the run first.
  IF current_user NOT IN ('anon', 'authenticated')
     OR (TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false)) THEN
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
$function$;

-- ── 1b. hr_payslips_guard_net ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_payslips_guard_net()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_parts numeric;
BEGIN
  -- The operator's INSERT is exempt, so an Export/Import restore writes what the backup holds; an
  -- operator's later edit is checked like anyone's (S798 3a, H3).
  IF current_user NOT IN ('anon', 'authenticated')
     OR (TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false)) THEN
    RETURN NEW;
  END IF;
  -- Same identity as payrollData.js payslipNetGap and finalize_payroll_run below.
  v_parts := COALESCE(NEW.gross, 0) + COALESCE(NEW.ot_amount, 0) - COALESCE(NEW.absence_deduction, 0)
           - COALESCE(NEW.ssf_employee, 0) - COALESCE(NEW.other_deductions, 0)
           - COALESCE(NEW.advance_deduction, 0) - COALESCE(NEW.tds, 0) + COALESCE(NEW.tada_amount, 0);
  IF abs(COALESCE(NEW.net_pay, 0) - v_parts) > 0.01 THEN
    RAISE EXCEPTION 'payslip_net_mismatch: this payslip''s net pay (%) is not its pay less its deductions (%) — regenerate the run', NEW.net_pay, round(v_parts, 2);
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 1c + 3. hr_bonus_rows_guard ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_bonus_rows_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_settled text;
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

  -- S798 GAP-PAY-STATE-3: the festival money is paid once, by the run or by the settlement. Checked
  -- when a row with an amount BECOMES finalized, for every client caller (the operator included on
  -- UPDATE; an operator INSERT is a restore of history and passes), under the lock settlement Finalize
  -- takes, so the two cannot pass each other.
  IF TG_TABLE_NAME = 'hr_festival_allowances' AND TG_OP IN ('INSERT', 'UPDATE')
     AND current_user IN ('anon', 'authenticated')
     AND NEW.status = 'finalized' AND COALESCE(NEW.amount, 0) > 0
     AND (CASE WHEN TG_OP = 'UPDATE' THEN OLD.status IS DISTINCT FROM 'finalized'
               ELSE NOT COALESCE(public.is_admin(), false) END) THEN
    PERFORM public.hr_pay_lock(NEW.client_id);
    v_settled := public.hr_festival_settled_by(NEW.employee_id, NEW.bs_year, NEW.bs_month);
    IF v_settled IS NOT NULL THEN
      RAISE EXCEPTION 'festival_paid_by_settlement: % was settled in a Final Settlement that already paid a festival share for this fiscal year — leave them out of this run, or reopen that settlement first', v_settled;
    END IF;
  END IF;

  -- S798 3a (GAP-OPERATOR-1, H3): the operator passes only on INSERT, which is all an Export/Import
  -- restore into an empty company does. Every later change takes the managers' path.
  IF current_user NOT IN ('anon', 'authenticated')
     OR (TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false)) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- S798 3a (BONUS-LEDGERS-5, H2): below the Owner, nobody finalizes or reopens a row that pays
  -- themselves. Amounts stay writable (Generate, Recompute and the tax rewrite all write them, and the
  -- database cannot tell a typed amount from a calculated one), so the fence is the status change:
  -- the Owner finalizes any run that pays the HR manager.
  IF NOT public.hr_self_decision_exempt()
     AND ((TG_OP = 'INSERT' AND NEW.status = 'finalized' AND public.hr_is_own_employee(NEW.employee_id))
       OR (TG_OP = 'UPDATE' AND (NEW.status = 'finalized') IS DISTINCT FROM (OLD.status = 'finalized')
           AND (public.hr_is_own_employee(OLD.employee_id) OR public.hr_is_own_employee(NEW.employee_id)))) THEN
    RAISE EXCEPTION 'hr_own_run: this run pays you (%) — the Owner finalizes and reopens a run that pays you',
      COALESCE((SELECT NULLIF(btrim(e.full_name), '') FROM hr_employees e WHERE e.id = NEW.employee_id), 'your own row');
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
$function$;

-- ── 1d. hr_advances_guard ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_advances_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_repaid numeric;
  -- S798 3a (GAP-OPERATOR-1, H3): only a SECURITY DEFINER body or the service role passes now. This
  -- trigger has no INSERT event and a restore only inserts, so a restore loses nothing; an operator's
  -- write-off takes the reason-and-stamp path the page already fills in, and an operator's delete of
  -- an advance with repayments is refused as anyone's is.
  v_system constant boolean := current_user NOT IN ('anon', 'authenticated');
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF v_system THEN RETURN OLD; END IF;
    -- The repayments cascade, and payroll runs and settlements depend on them: deleting a loan with
    -- two finalized payroll recoveries erased the ledger rows those payslips point at.
    IF EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id)
       AND EXISTS (SELECT 1 FROM hr_advance_repayments WHERE advance_id = OLD.id) THEN
      RAISE EXCEPTION 'advance_has_repayments: an advance with repayments cannot be deleted — write it off instead';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE. The three owed / nothing-owed tests are exact since S791 (they allowed a paisa either way).
  v_repaid := public.hr_advance_repaid(NEW.id);
  IF NOT v_system THEN
    IF NEW.amount < v_repaid THEN
      RAISE EXCEPTION 'advance_amount_below_repaid: NPR % has already been repaid', v_repaid;
    END IF;
    IF NEW.status = 'settled' AND OLD.status IS DISTINCT FROM 'settled' AND NEW.amount - v_repaid > 0 THEN
      RAISE EXCEPTION 'advance_not_repaid: NPR % is still owed — record the repayment or write it off', round(NEW.amount - v_repaid, 2);
    END IF;
  END IF;

  IF NEW.status = 'written_off' AND OLD.status IS DISTINCT FROM 'written_off' THEN
    IF NOT v_system THEN
      IF btrim(COALESCE(NEW.write_off_reason, '')) = '' THEN
        RAISE EXCEPTION 'write_off_reason_required: say why this balance is being written off';
      END IF;
      IF NEW.amount - v_repaid <= 0 THEN
        RAISE EXCEPTION 'write_off_nothing_owed: nothing is owed on this advance';
      END IF;
      NEW.written_off_at := now();
      NEW.written_off_by := (select auth.uid());
      NEW.write_off_amount := round(NEW.amount - v_repaid, 2);
    ELSE
      NEW.written_off_at := COALESCE(NEW.written_off_at, now());
      NEW.written_off_by := COALESCE(NEW.written_off_by, (select auth.uid()));
      NEW.write_off_amount := COALESCE(NEW.write_off_amount, round(GREATEST(NEW.amount - v_repaid, 0), 2));
    END IF;
  ELSIF NEW.status <> 'written_off' AND OLD.status = 'written_off' THEN
    NEW.written_off_at := NULL; NEW.written_off_by := NULL;
    NEW.write_off_reason := NULL; NEW.write_off_amount := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 1e. hr_advance_repayments_guard ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_advance_repayments_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_adv hr_advances;
  v_repaid numeric;
BEGIN
  -- S798 3a (H3): the operator passes only on INSERT (a restore). An operator's hand-recorded
  -- repayment is an INSERT too, so Advances & Loans re-reads what is owed before writing it.
  IF current_user NOT IN ('anon', 'authenticated')
     OR (TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false)) THEN RETURN NEW; END IF;
  SELECT * INTO v_adv FROM hr_advances WHERE id = NEW.advance_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'advance_not_found'; END IF;
  IF v_adv.employee_id <> NEW.employee_id OR v_adv.client_id <> NEW.client_id THEN
    RAISE EXCEPTION 'repayment_advance_mismatch: this repayment does not belong to that advance';
  END IF;
  IF TG_OP = 'INSERT' AND v_adv.status <> 'active' THEN
    RAISE EXCEPTION 'advance_not_active: this advance is % — nothing is being recovered on it', v_adv.status;
  END IF;
  v_repaid := public.hr_advance_repaid(NEW.advance_id, CASE WHEN TG_OP = 'UPDATE' THEN NEW.id END);
  -- Exact (S791); it allowed a repayment one paisa over what was owed.
  IF v_repaid + NEW.amount > v_adv.amount THEN
    RAISE EXCEPTION 'repayment_exceeds_outstanding: only NPR % is still owed', round(GREATEST(v_adv.amount - v_repaid, 0), 2);
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 1f. hr_advance_repayments_guard_ledger ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_advance_repayments_guard_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- S798 3a (GAP-OPERATOR-1, H3): the operator passes only on INSERT, which is all an Export/Import
  -- restore into an empty company does. Every later change takes the managers' path.
  IF current_user NOT IN ('anon', 'authenticated')
     OR (TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false)) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND (OLD.payroll_run_id IS NOT NULL OR OLD.final_settlement_id IS NOT NULL) THEN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id) THEN
      RETURN OLD;   -- a whole-client deletion cascading through
    END IF;
    RAISE EXCEPTION 'repayment_ledger_locked: this repayment was recorded by payroll or a Final Settlement — reopen that instead';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND (NEW.payroll_run_id IS NOT NULL OR NEW.final_settlement_id IS NOT NULL) THEN
    RAISE EXCEPTION 'repayment_ledger_locked: payroll and Final Settlement record their own repayments — use Finalize';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- ── 1g. hr_payroll_runs_guard_delete ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_payroll_runs_guard_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- S798 3a (H3): a DELETE trigger, so the operator no longer passes; a finalized run is reopened first.
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN OLD; END IF;
  IF OLD.status = 'finalized' AND EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id) THEN
    RAISE EXCEPTION 'hr_run_finalized: a finalized payroll run cannot be deleted';
  END IF;
  RETURN OLD;
END;
$function$;

-- ── 1h. hr_payroll_runs_guard_settled ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_payroll_runs_guard_settled()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_names text;
BEGIN
  -- S798 3a (H3): the operator is exempt only when inserting a run (a restore).
  IF current_user IN ('anon', 'authenticated') AND NOT (TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false)) THEN
    IF TG_OP = 'INSERT' THEN
      -- S798 PAYROLL-3: an empty finalized run locked the month's attendance and refused every payslip.
      IF NEW.status IS DISTINCT FROM 'draft' OR NEW.finalized_at IS NOT NULL THEN
        RAISE EXCEPTION 'payroll_status_direct: a payroll run starts as a draft and is finalized with Finalize, never created finalized';
      END IF;
    ELSE
      IF (NEW.status = 'finalized') IS DISTINCT FROM (OLD.status = 'finalized')
         OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
        RAISE EXCEPTION 'payroll_status_direct: a payroll run is finalized with Finalize and reopened with Reopen, never by changing its status directly';
      END IF;
      -- S798 PAYROLL-3: moving a run took its payslips, payments and month lock with it and opened the
      -- original month for a second payroll.
      IF NEW.period_id IS DISTINCT FROM OLD.period_id THEN
        RAISE EXCEPTION 'payroll_period_fixed: a payroll run stays in the month it was generated for — delete the draft and generate the other month instead';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'finalized' AND OLD.status IS DISTINCT FROM 'finalized' THEN
    PERFORM public.hr_pay_lock(NEW.client_id);
    IF current_user IN ('anon', 'authenticated') THEN   -- the operator too since S798 3a (H3)
      v_names := public.hr_run_settled_employee_names(NEW.id);
      IF v_names IS NOT NULL THEN
        RAISE EXCEPTION 'run_has_settled_employee: % left in a finalized Final Settlement that paid their last month itself, so a payslip in this month or a later one pays them twice — if they have rejoined, record their new join date; if the settlement was a mistake, reopen it; otherwise regenerate the run without them', v_names;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 1i + 5. hr_tada_claims_guard ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_tada_claims_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  -- S798 3a (GAP-OPERATOR-1, H3): the operator passes only when ADDING a claim, which is all an
  -- Export/Import restore does. Deleting, deciding or paying one takes the managers' path.
  v_restore constant boolean := TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false);
BEGIN
  -- The Staff app's SECURITY DEFINER submit runs as the owner and stamps its own row. So do
  -- reopen_payroll_run and reopen_final_settlement, the only writers of paid -> approved (S798).
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN COALESCE(NEW, OLD); END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'pending' AND EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id) THEN
      RAISE EXCEPTION 'tada_claim_locked: only a pending claim can be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_restore THEN
      NEW.submitted_by := COALESCE(NEW.submitted_by, (select auth.uid()));   -- a restore keeps history
      RETURN NEW;
    END IF;
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'tada_claim_must_start_pending: a new claim starts as pending';
    END IF;
    NEW.submitted_by := (select auth.uid());
    NEW.approved_by := NULL; NEW.approved_at := NULL; NEW.paid_at := NULL; NEW.paid_method := NULL;
    RETURN NEW;
  END IF;

  -- UPDATE. The operator included since S798 3a: an operator's decision is stamped like anyone's.
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

  -- S798 3a (BONUS-LEDGERS-2, H13): Undo approval. An approved claim that payroll has not paid yet, or
  -- a rejected one, goes back to pending at HR manager rank (the Owner and the operator included) and
  -- loses its decision stamp. A draft payroll or settlement already holding it then refuses to
  -- finalize (payroll_tada_changed, settlement_stale_tada) until it is regenerated.
  IF OLD.status IN ('approved', 'rejected') AND NEW.status = 'pending' THEN
    IF NOT public.hr_is_manager_rank() THEN
      RAISE EXCEPTION 'tada_undo_rank: only an HR manager or the Owner can put a decided claim back to pending';
    END IF;
    NEW.approved_by := NULL; NEW.approved_at := NULL; NEW.paid_at := NULL; NEW.paid_method := NULL;
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

  RAISE EXCEPTION 'tada_transition_invalid: a % claim cannot become %', OLD.status, NEW.status;
END;
$function$;

-- ── 1j. hr_tada_claim_items_guard ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_tada_claim_items_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
BEGIN
  -- S798 3a (GAP-OPERATOR-1, H3): the operator passes only on INSERT, which is all an Export/Import
  -- restore into an empty company does. Every later change takes the managers' path.
  IF current_user NOT IN ('anon', 'authenticated')
     OR (TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false)) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT status INTO v_status FROM hr_tada_claims WHERE id = COALESCE(NEW.claim_id, OLD.claim_id);
  IF NOT FOUND THEN RETURN COALESCE(NEW, OLD); END IF;   -- the claim is being deleted (cascade)
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'tada_claim_locked: a decided claim''s lines cannot change';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- ── 1k. hr_final_settlements_guard ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_final_settlements_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- S798 GAP-OPERATOR-3: the amount a paid mark records is stamped for EVERY caller, the operator
  -- included, and only fills an empty one. It sat below the seam, so an operator's mark stored none.
  IF TG_OP = 'UPDATE' AND OLD.status = 'finalized' AND OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL THEN
    NEW.paid_amount := COALESCE(NEW.paid_amount, OLD.net_payout);
  END IF;

  -- S798 3a (GAP-OPERATOR-1, H3): the operator passes only on INSERT, which is all an Export/Import
  -- restore into an empty company does. Every later change takes the managers' path.
  IF current_user NOT IN ('anon', 'authenticated')
     OR (TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false)) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'settlement_must_start_draft: a settlement is saved as a draft and finalized with the Finalize button';
    END IF;
    NEW.finalized_at := NULL; NEW.paid_at := NULL; NEW.paid_method := NULL; NEW.paid_amount := NULL;
    NEW.advance_recovered := 0; NEW.reopened_at := NULL; NEW.reopened_by := NULL; NEW.reopen_reason := NULL;
    NEW.prior_status := NULL; NEW.prior_end_date := NULL; NEW.prior_access_blocked := NULL;
    NEW.blocked_logins := '{}';
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'finalized' AND EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id) THEN
      RAISE EXCEPTION 'settlement_finalized: a finalized settlement cannot be deleted — reopen it first';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.status = 'draft' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'settlement_finalize_path: a settlement is finalized with the Finalize button, not by editing it';
    END IF;
    NEW.finalized_at := OLD.finalized_at; NEW.advance_recovered := OLD.advance_recovered;
    NEW.paid_at := OLD.paid_at; NEW.paid_method := OLD.paid_method; NEW.paid_amount := OLD.paid_amount;
    NEW.reopened_at := OLD.reopened_at; NEW.reopened_by := OLD.reopened_by; NEW.reopen_reason := OLD.reopen_reason;
    NEW.prior_status := OLD.prior_status; NEW.prior_end_date := OLD.prior_end_date;
    NEW.prior_access_blocked := OLD.prior_access_blocked;
    NEW.blocked_logins := OLD.blocked_logins;
    RETURN NEW;
  END IF;

  IF OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL AND btrim(COALESCE(NEW.paid_method, '')) <> ''
     AND (to_jsonb(NEW) - ARRAY['paid_at', 'paid_method', 'paid_amount'])
       = (to_jsonb(OLD) - ARRAY['paid_at', 'paid_method', 'paid_amount']) THEN
    NEW.paid_amount := OLD.net_payout;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'settlement_finalized: this settlement is finalized — reopen it first';
END;
$function$;

-- ── 1l. hr_salary_payments_guard ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_salary_payments_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- S798 3a (GAP-OPERATOR-1, H3): the operator passes only on INSERT, which is all an Export/Import
  -- restore into an empty company does. Every later change takes the managers' path.
  IF current_user NOT IN ('anon', 'authenticated')
     OR (TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false)) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'salary_payment_ledger_locked: salary payments are recorded with Mark paid and undone with Undo payment';
END;
$function$;

-- ── 1m. hr_leave_requests_validate ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_leave_requests_validate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_clash    hr_leave_requests;
  v_calendar int;
  v_holidays int;
BEGIN
  IF NEW.start_date IS NULL OR NEW.end_date IS NULL OR NEW.end_date < NEW.start_date THEN
    RAISE EXCEPTION 'leave_dates_invalid: the end date is before the start date';
  END IF;
  IF COALESCE(NEW.day_type, 'full') <> 'full' AND NEW.end_date <> NEW.start_date THEN
    RAISE EXCEPTION 'leave_half_day_range: a half-day request covers one day';
  END IF;
  v_calendar := NEW.end_date - NEW.start_date + 1;
  IF v_calendar > 366 THEN
    RAISE EXCEPTION 'leave_range_too_long: a leave request covers at most a year';
  END IF;

  -- Public holidays inside the range are not charged (decided 2026-09-14). Only a request that is
  -- still open or approved is recounted and refused; a decided one keeps the figure it was decided on.
  IF NEW.status IN ('pending', 'approved') THEN
    v_holidays := public.hr_public_holiday_count(NEW.client_id, NEW.start_date, NEW.end_date);
    IF v_holidays >= v_calendar THEN
      -- S798 (DATABASE-2): a restore re-inserts requests that were valid when filed; refusing one
      -- abandons the rest of the table. The operator's insert keeps it at 0 days, which charges nothing.
      IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) THEN
        NEW.days := 0;
      ELSE
        RAISE EXCEPTION 'leave_all_holidays: every day in this request is a public holiday';
      END IF;
    ELSE
      NEW.days := CASE WHEN COALESCE(NEW.day_type, 'full') <> 'full' THEN 0.5
                       ELSE v_calendar - v_holidays END;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.days := CASE WHEN COALESCE(NEW.day_type, 'full') <> 'full' THEN 0.5 ELSE v_calendar END;
  END IF;

  -- S798 3a (H3): the operator skips the overlap test only when inserting (a restore re-inserts
  -- history); approving an overlapping request is refused for the operator as for anyone.
  IF NEW.status IN ('pending', 'approved')
     AND NOT (TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false)) THEN
    PERFORM pg_advisory_xact_lock(hashtext('hr_leave_requests:' || NEW.employee_id::text));
    SELECT * INTO v_clash FROM hr_leave_requests o
     WHERE o.employee_id = NEW.employee_id
       AND o.id <> NEW.id
       AND o.status IN ('pending', 'approved')
       AND o.start_date <= NEW.end_date AND NEW.start_date <= o.end_date
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'leave_overlap: overlaps a % request from % to %', v_clash.status, v_clash.start_date, v_clash.end_date;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 3b. finalize_payroll_run ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finalize_payroll_run(p_run_id uuid, p_payslip_ids uuid[], p_repayments jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r hr_payroll_runs;
  v_stored uuid[];
  v_given uuid[];
  v_names text;
  v_mismatch text;
  v_net_off text;
  v_claims uuid[];
  v_marked int := 0;
  e jsonb;
  a hr_advances;
  v_amount numeric;
  v_rows int := 0;
  v_own text;
BEGIN
  SELECT * INTO r FROM hr_payroll_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll_run_not_found: this payroll run no longer exists';
  END IF;
  IF NOT COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR r.client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'payroll_rank: finalizing payroll needs the Owner or an HR manager' USING ERRCODE = '42501';
  END IF;

  PERFORM public.hr_pay_lock(r.client_id);
  SELECT * INTO r FROM hr_payroll_runs WHERE id = p_run_id FOR UPDATE;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION 'payroll_already_finalized: this run was finalized somewhere else — reload the page';
  END IF;

  -- S798 3a (H2): below the Owner, nobody finalizes a payroll that pays themselves. Checked as the
  -- caller (hr_is_own_employee reads the session), so an HR manager on the run asks the Owner.
  IF NOT public.hr_self_decision_exempt() THEN
    SELECT COALESCE(NULLIF(btrim(emp.full_name), ''), 'your own payslip') INTO v_own
      FROM hr_payslips p LEFT JOIN hr_employees emp ON emp.id = p.employee_id
     WHERE p.run_id = r.id AND public.hr_is_own_employee(p.employee_id)
     LIMIT 1;
    IF v_own IS NOT NULL THEN
      RAISE EXCEPTION 'hr_own_run: this payroll pays you (%) — the Owner finalizes and reopens a run that pays you', v_own;
    END IF;
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_stored FROM hr_payslips WHERE run_id = r.id;
  SELECT COALESCE(array_agg(x ORDER BY x), '{}') INTO v_given FROM unnest(COALESCE(p_payslip_ids, '{}')) x;
  IF cardinality(v_stored) = 0 THEN
    RAISE EXCEPTION 'payroll_run_empty: this run has no payslips to finalize';
  END IF;
  IF v_stored IS DISTINCT FROM v_given THEN
    RAISE EXCEPTION 'payroll_run_stale: the payslips in this run changed while it was being checked (regenerated in another tab) — reload and finalize again';
  END IF;

  v_names := public.hr_run_settled_employee_names(r.id);
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'run_has_settled_employee: % left in a finalized Final Settlement that paid their last month itself, so a payslip in this month or a later one pays them twice — if they have rejoined, record their new join date; if the settlement was a mistake, reopen it; otherwise regenerate the run without them', v_names;
  END IF;

  -- S798 PAYROLL-4: every payslip's net pay must be its own parts (hr_payslips_guard_net's identity).
  SELECT string_agg(COALESCE(emp.full_name, 'an employee'), ', ' ORDER BY emp.full_name) INTO v_net_off
    FROM hr_payslips p
    LEFT JOIN hr_employees emp ON emp.id = p.employee_id
   WHERE p.run_id = r.id
     AND abs(COALESCE(p.net_pay, 0) - (COALESCE(p.gross, 0) + COALESCE(p.ot_amount, 0) - COALESCE(p.absence_deduction, 0)
           - COALESCE(p.ssf_employee, 0) - COALESCE(p.other_deductions, 0)
           - COALESCE(p.advance_deduction, 0) - COALESCE(p.tds, 0) + COALESCE(p.tada_amount, 0))) > 0.01;
  IF v_net_off IS NOT NULL THEN
    RAISE EXCEPTION 'payslip_net_mismatch: the net pay on the payslip of % is not their pay less their deductions — regenerate the run and finalize again', v_net_off;
  END IF;

  -- The repayments must add up to each payslip's advance deduction, to the paisa (S791: it allowed a
  -- paisa of difference), and name nobody else. hr_payslips.advance_deduction is unscaled numeric, so
  -- it is compared at two places; the repayment amounts are rounded the same way as they are written.
  SELECT string_agg(COALESCE(emp.full_name, 'an employee'), ', ') INTO v_mismatch
    FROM (
      SELECT COALESCE(p.employee_id, x.employee_id) AS employee_id
        FROM (SELECT employee_id, COALESCE(advance_deduction, 0) AS due FROM hr_payslips WHERE run_id = r.id) p
        FULL JOIN (
          SELECT (j->>'employee_id')::uuid AS employee_id, SUM(round((j->>'amount')::numeric, 2)) AS total
            FROM jsonb_array_elements(COALESCE(p_repayments, '[]'::jsonb)) j GROUP BY 1
        ) x ON x.employee_id = p.employee_id
       WHERE round(COALESCE(p.due, 0), 2) <> COALESCE(x.total, 0)
    ) m
    LEFT JOIN hr_employees emp ON emp.id = m.employee_id;
  IF v_mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_repayments_mismatch: the advance recovery for % does not match the payslip — reload and finalize again', v_mismatch;
  END IF;

  UPDATE hr_payroll_runs SET status = 'finalized', finalized_at = now() WHERE id = r.id;

  -- TADA claims first: a claim left Approved after its payroll is finalized is payable twice.
  SELECT COALESCE(array_agg(DISTINCT c), '{}') INTO v_claims
    FROM hr_payslips p, unnest(COALESCE(p.tada_claim_ids, '{}')) c WHERE p.run_id = r.id;
  IF cardinality(v_claims) > 0 THEN
    UPDATE hr_tada_claims SET status = 'paid', paid_at = now(), paid_method = 'Payroll'
     WHERE id = ANY (v_claims) AND client_id = r.client_id AND status = 'approved';
    GET DIAGNOSTICS v_marked = ROW_COUNT;
    IF v_marked < cardinality(v_claims) THEN
      RAISE EXCEPTION 'payroll_tada_changed: % of the % travel claims this payroll pays are no longer Approved (changed in TADA Claims) — regenerate and finalize again', cardinality(v_claims) - v_marked, cardinality(v_claims);
    END IF;
  END IF;

  -- Repayments. The row guard is bypassed inside this SECURITY DEFINER body, so its checks are made
  -- here: the advance belongs to that employee and client, is active, and is owed at least this much.
  DELETE FROM hr_advance_repayments WHERE payroll_run_id = r.id;
  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_repayments, '[]'::jsonb)) LOOP
    v_amount := round((e->>'amount')::numeric, 2);
    CONTINUE WHEN v_amount <= 0;
    SELECT * INTO a FROM hr_advances WHERE id = (e->>'advance_id')::uuid FOR UPDATE;
    IF NOT FOUND OR a.client_id <> r.client_id OR a.employee_id <> (e->>'employee_id')::uuid THEN
      RAISE EXCEPTION 'payroll_repayment_invalid: an advance recovery does not belong to that employee — reload and finalize again';
    END IF;
    IF a.status <> 'active' THEN
      RAISE EXCEPTION 'payroll_repayment_invalid: an advance being recovered is % now — reload and finalize again', a.status;
    END IF;
    -- Exact (S791); it allowed a recovery one paisa over what was owed.
    IF public.hr_advance_repaid(a.id) + v_amount > a.amount THEN
      RAISE EXCEPTION 'payroll_repayment_invalid: an advance recovery is more than is still owed — reload and finalize again';
    END IF;
    -- The Kathmandu date, never the server's UTC date (yesterday in Nepal until 05:45). The page
    -- always sends repaid_date; this is the fallback for a caller that does not (S791).
    INSERT INTO hr_advance_repayments (client_id, advance_id, employee_id, repaid_date, amount, notes, payroll_run_id)
    VALUES (r.client_id, a.id, a.employee_id,
            COALESCE((e->>'repaid_date')::date, (now() AT TIME ZONE 'Asia/Kathmandu')::date),
            v_amount, e->>'notes', r.id);
    v_rows := v_rows + 1;
  END LOOP;

  RETURN jsonb_build_object('payslips', cardinality(v_stored), 'tada_claims', v_marked, 'repayments', v_rows);
END;
$function$;

-- ── 3c. reopen_payroll_run ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reopen_payroll_run(p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r hr_payroll_runs;
  v_wo record;
  v_claims uuid[];
  v_reverted int := 0;
  v_own text;
BEGIN
  SELECT * INTO r FROM hr_payroll_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll_run_not_found: this payroll run no longer exists';
  END IF;
  IF NOT COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR r.client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'payroll_rank: reopening payroll needs the Owner or an HR manager' USING ERRCODE = '42501';
  END IF;

  PERFORM public.hr_pay_lock(r.client_id);
  SELECT * INTO r FROM hr_payroll_runs WHERE id = p_run_id FOR UPDATE;
  IF r.status <> 'finalized' THEN
    RAISE EXCEPTION 'payroll_not_finalized: this run is already a draft — reload the page';
  END IF;

  -- S798 3a (H2): below the Owner, nobody reopens a payroll that pays themselves. Checked as the
  -- caller (hr_is_own_employee reads the session), so an HR manager on the run asks the Owner.
  IF NOT public.hr_self_decision_exempt() THEN
    SELECT COALESCE(NULLIF(btrim(emp.full_name), ''), 'your own payslip') INTO v_own
      FROM hr_payslips p LEFT JOIN hr_employees emp ON emp.id = p.employee_id
     WHERE p.run_id = r.id AND public.hr_is_own_employee(p.employee_id)
     LIMIT 1;
    IF v_own IS NOT NULL THEN
      RAISE EXCEPTION 'hr_own_run: this payroll pays you (%) — the Owner finalizes and reopens a run that pays you', v_own;
    END IF;
  END IF;

  -- S791: an advance this run recovered from that has since been WRITTEN OFF refuses the reopen.
  -- Deleting the run's repayment would grow the write-off by what the run took — money forgiven that
  -- nobody decided to forgive. A write-off from Advances & Loans does not take hr_pay_lock, so the
  -- advances are row-locked first and a write-off cannot land between this check and the delete.
  -- The same rule reopen_final_settlement has had since S753.
  PERFORM 1 FROM hr_advances x
   WHERE x.id IN (SELECT rp.advance_id FROM hr_advance_repayments rp WHERE rp.payroll_run_id = r.id)
   ORDER BY x.id FOR UPDATE;
  SELECT COALESCE(NULLIF(btrim(emp.full_name), ''), 'An employee') AS who, x.type, x.amount,
         (SELECT SUM(rp.amount) FROM hr_advance_repayments rp WHERE rp.advance_id = x.id AND rp.payroll_run_id = r.id) AS recovered_here
    INTO v_wo
    FROM hr_advances x
    LEFT JOIN hr_employees emp ON emp.id = x.employee_id
   WHERE x.status = 'written_off'
     AND x.id IN (SELECT rp.advance_id FROM hr_advance_repayments rp WHERE rp.payroll_run_id = r.id)
   ORDER BY emp.full_name, x.issued_date, x.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'payroll_reopen_written_off: %''s % of NPR % was written off after this payroll recovered NPR % from it — put it back into recovery in Advances & Loans (Reactivate) first, then reopen',
      v_wo.who, CASE WHEN v_wo.type = 'loan' THEN 'loan' ELSE 'advance' END,
      to_char(v_wo.amount, 'FM99,99,99,990.00'), to_char(v_wo.recovered_here, 'FM99,99,99,990.00');
  END IF;

  DELETE FROM hr_advance_repayments WHERE payroll_run_id = r.id;   -- the status trigger reactivates

  SELECT COALESCE(array_agg(DISTINCT c), '{}') INTO v_claims
    FROM hr_payslips p, unnest(COALESCE(p.tada_claim_ids, '{}')) c WHERE p.run_id = r.id;
  IF cardinality(v_claims) > 0 THEN
    UPDATE hr_tada_claims SET status = 'approved', paid_at = NULL, paid_method = NULL
     WHERE id = ANY (v_claims) AND client_id = r.client_id AND status = 'paid' AND paid_method = 'Payroll';
    GET DIAGNOSTICS v_reverted = ROW_COUNT;
  END IF;

  UPDATE hr_payroll_runs SET status = 'draft', finalized_at = NULL WHERE id = r.id;

  -- 'written_off' is gone from the result: a written-off advance now refuses the reopen above.
  RETURN jsonb_build_object('tada_claims', cardinality(v_claims), 'tada_reverted', v_reverted);
END;
$function$;

-- ══ 2. Your own pay (PEOPLE-ACCESS-2) ═════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.hr_employees_guard_own_pay()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.hr_self_decision_exempt() THEN
    RETURN NEW;
  END IF;
  -- Only a real change is refused, so EmployeeForm saving your own phone number (which re-sends an
  -- unchanged email) still works. Tested on OLD: the link as it stands before this write.
  IF (NEW.basic_salary, NEW.pay_basis, NEW.bank_name, NEW.bank_account_no, NEW.bank_branch,
      NEW.ssf_no, NEW.ssf_enrolled, NEW.life_insurance_premium, NEW.health_insurance_premium, NEW.email)
     IS DISTINCT FROM
     (OLD.basic_salary, OLD.pay_basis, OLD.bank_name, OLD.bank_account_no, OLD.bank_branch,
      OLD.ssf_no, OLD.ssf_enrolled, OLD.life_insurance_premium, OLD.health_insurance_premium, OLD.email)
     AND public.hr_is_own_employee(OLD.id) THEN
    RAISE EXCEPTION 'hr_own_pay: this is your own employee record — the Owner sets your own pay, bank, SSF and email details';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.hr_employees_guard_own_pay() FROM PUBLIC;

DROP TRIGGER IF EXISTS hr_employees_guard_own_pay ON public.hr_employees;
CREATE TRIGGER hr_employees_guard_own_pay BEFORE UPDATE ON public.hr_employees
  FOR EACH ROW EXECUTE FUNCTION public.hr_employees_guard_own_pay();

CREATE OR REPLACE FUNCTION public.hr_salary_components_guard_own()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.hr_self_decision_exempt() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- OLD or NEW: moving a component onto or off your own record is the same change.
  IF (TG_OP IN ('UPDATE', 'DELETE') AND public.hr_is_own_employee(OLD.employee_id))
     OR (TG_OP IN ('INSERT', 'UPDATE') AND public.hr_is_own_employee(NEW.employee_id)) THEN
    RAISE EXCEPTION 'hr_own_pay: these are your own allowances and deductions — the Owner sets your own pay';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;
REVOKE ALL ON FUNCTION public.hr_salary_components_guard_own() FROM PUBLIC;

DROP TRIGGER IF EXISTS hr_salary_components_guard_own ON public.hr_salary_components;
CREATE TRIGGER hr_salary_components_guard_own BEFORE INSERT OR UPDATE OR DELETE ON public.hr_salary_components
  FOR EACH ROW EXECUTE FUNCTION public.hr_salary_components_guard_own();

-- ══ 4. Own attendance changes, listed before Finalize (LEAVE-OT-HOLIDAYS-5) ═══════════════════════

-- Read-time, from audit_logs (log_audit() snapshots every hr_attendance write with its login). The link
-- is judged now, by the same two tests as hr_is_own_employee: the login's profile link, or the employee
-- record carrying the login's email. A login with no profile left is not listed. An UPDATE that changed
-- none of the paid columns (status, hours, overtime, times, break) is a re-save, not a change, and is left
-- out; INSERT and DELETE always count.
CREATE OR REPLACE FUNCTION public.hr_own_attendance_changes(p_period_id uuid)
 RETURNS TABLE(employee_id uuid, employee_name text, marked_by_name text, bs_day integer, action text,
               old_status text, new_status text, old_hours numeric, new_hours numeric,
               old_ot_hours numeric, new_ot_hours numeric, changed_at timestamp with time zone)
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
REVOKE ALL ON FUNCTION public.hr_own_attendance_changes(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hr_own_attendance_changes(uuid) TO authenticated, service_role;

-- Self-check: the triggers and grants are what this file says, and no guard kept the every-event
-- operator pass. A text check proves only what a body mentions; the rolled-back dry run is the
-- behavioural proof (a restore replayed as the operator, then each refusal and each own-row case).
DO $$
DECLARE
  v_fn text;
  v_src text;
BEGIN
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
         AND ((c.relname = 'hr_employees' AND t.tgname = 'hr_employees_guard_own_pay')
           OR (c.relname = 'hr_salary_components' AND t.tgname = 'hr_salary_components_guard_own'))) <> 2 THEN
    RAISE EXCEPTION 'S798 3a: an own-pay trigger is missing or disabled';
  END IF;
  IF has_function_privilege('anon', 'public.hr_own_attendance_changes(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S798 3a: anon can execute hr_own_attendance_changes';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.hr_own_attendance_changes(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S798 3a: authenticated cannot execute hr_own_attendance_changes';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hr_own_attendance_changes(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'S798 3a: hr_own_attendance_changes is not SECURITY DEFINER';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['hr_payslips_guard_finalized', 'hr_payslips_guard_net', 'hr_bonus_rows_guard',
      'hr_advances_guard', 'hr_advance_repayments_guard', 'hr_advance_repayments_guard_ledger',
      'hr_payroll_runs_guard_delete', 'hr_payroll_runs_guard_settled', 'hr_tada_claims_guard',
      'hr_tada_claim_items_guard', 'hr_final_settlements_guard', 'hr_salary_payments_guard',
      'hr_leave_requests_validate'] LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = ('public.' || v_fn || '()')::regprocedure;
    IF v_src ~ 'OR COALESCE\(public\.is_admin\(\), false\)( THEN|;)' OR v_src ~ 'NOT COALESCE\(public\.is_admin\(\), false\) THEN' THEN
      RAISE EXCEPTION 'S798 3a: % still lets the operator through on every event', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['finalize_payroll_run', 'reopen_payroll_run'] LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = ('public.' || v_fn || '(uuid' ||
      CASE WHEN v_fn = 'finalize_payroll_run' THEN ',uuid[],jsonb' ELSE '' END || ')')::regprocedure;
    IF v_src NOT LIKE '%hr_own_run%' THEN
      RAISE EXCEPTION 'S798 3a: % has no own-run refusal', v_fn;
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
