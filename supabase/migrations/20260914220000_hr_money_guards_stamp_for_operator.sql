-- S751 follow-up — the operator skipped the stamps, not just the refusals.
--
-- 20260914210000's hr_advances_guard and hr_tada_claims_guard returned at once for the Crest operator
-- (is_admin()), so an Export/Import restore could write historical rows. But the same early return
-- skipped the SERVER-SIDE STAMPS the pages had just stopped sending: an operator's write-off stored no
-- amount, date or author (the Written Off card left it out), and an operator's approve or Mark Paid
-- stored no approver or payment time ("Paid via Cash on —"). Found by the S751 review.
--
-- Stamps now run for everyone. For the operator they only FILL a value the write did not carry, so a
-- restore that brings its own historical approved_by / paid_at / written_off_* keeps them. The
-- refusals stay non-operator only, exactly as before.

CREATE OR REPLACE FUNCTION public.hr_advances_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_repaid numeric;
  v_operator constant boolean := current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF v_operator THEN RETURN OLD; END IF;
    -- The repayments cascade, and payroll runs and settlements depend on them: deleting a loan with
    -- two finalized payroll recoveries erased the ledger rows those payslips point at.
    IF EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id)
       AND EXISTS (SELECT 1 FROM hr_advance_repayments WHERE advance_id = OLD.id) THEN
      RAISE EXCEPTION 'advance_has_repayments: an advance with repayments cannot be deleted — write it off instead';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  v_repaid := public.hr_advance_repaid(NEW.id);
  IF NOT v_operator THEN
    IF NEW.amount + 0.01 < v_repaid THEN
      RAISE EXCEPTION 'advance_amount_below_repaid: NPR % has already been repaid', v_repaid;
    END IF;
    IF NEW.status = 'settled' AND OLD.status IS DISTINCT FROM 'settled' AND NEW.amount - v_repaid > 0.01 THEN
      RAISE EXCEPTION 'advance_not_repaid: NPR % is still owed — record the repayment or write it off', round(NEW.amount - v_repaid, 2);
    END IF;
  END IF;

  IF NEW.status = 'written_off' AND OLD.status IS DISTINCT FROM 'written_off' THEN
    IF NOT v_operator THEN
      IF btrim(COALESCE(NEW.write_off_reason, '')) = '' THEN
        RAISE EXCEPTION 'write_off_reason_required: say why this balance is being written off';
      END IF;
      IF NEW.amount - v_repaid <= 0.01 THEN
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
$$;
REVOKE ALL ON FUNCTION public.hr_advances_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.hr_tada_claims_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_operator constant boolean := current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false);
BEGIN
  -- The Staff app's SECURITY DEFINER submit runs as the owner and stamps its own row.
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN COALESCE(NEW, OLD); END IF;

  IF TG_OP = 'DELETE' THEN
    IF NOT v_operator AND OLD.status <> 'pending' AND EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id) THEN
      RAISE EXCEPTION 'tada_claim_locked: only a pending claim can be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_operator THEN
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

  -- UPDATE
  IF v_operator THEN
    IF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected') THEN
      NEW.approved_by := COALESCE(NEW.approved_by, (select auth.uid()));
      NEW.approved_at := COALESCE(NEW.approved_at, now());
    ELSIF OLD.status <> 'paid' AND NEW.status = 'paid' THEN
      NEW.paid_at := COALESCE(NEW.paid_at, now());
    END IF;
    RETURN NEW;
  END IF;

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

NOTIFY pgrst, 'reload schema';
