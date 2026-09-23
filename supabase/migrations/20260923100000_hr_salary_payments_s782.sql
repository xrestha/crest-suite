-- S782 — Salary payments: record that staff were actually paid.
--
-- Finalize locks a month's payslips; it says nothing about whether the money left the business.
-- Final Settlement and TADA claims both record their payment; monthly payroll recorded none.
--
-- Decisions taken with Aashish (2026-09-23):
--   * Mark everyone paid in one step, or one person at a time.
--   * Methods: bank transfer, cash, eSewa / Khalti (wallet), cheque.
--   * A mistaken mark is undone with a written reason, and the record is kept (void, never delete).
--   * Reopen stays ALLOWED after payment, with a warning. That is why a payment is its own row keyed
--     by run + employee and not a column on hr_payslips: Regenerate deletes and re-inserts payslips,
--     which would silently erase a paid mark. A payment survives Reopen and Regenerate; if the month's
--     figures then change, the page shows the difference still to pay, or the overpayment.
--
-- Sections:
--   (1) hr_salary_payments: the table, RLS (the hr_payslips set), grants, audit
--   (2) The ledger is written only by the two functions below (hr_salary_payments_guard)
--   (3) record_salary_payments — marks one or more staff paid for what is still owed on their payslip
--   (4) void_salary_payment — undoes one payment, reason required
--   (5) get_my_salary_payments — the Crest Staff app's "Paid on …" line
--   (6) Assertions

-- ── (1) The table ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.hr_salary_payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  -- NO ACTION on purpose (the confdeltype rule): a run or an employee with a payment recorded against
  -- it cannot be deleted out from under that record. A whole-client deletion still goes through,
  -- because the cascade from clients removes these rows in the same statement.
  run_id       uuid NOT NULL REFERENCES public.hr_payroll_runs(id),
  employee_id  uuid NOT NULL REFERENCES public.hr_employees(id),
  -- numeric accepts 'NaN' and NaN > 0 is true, so the NaN test is spelled out (S751).
  amount       numeric(12,2) NOT NULL CHECK (amount > 0 AND amount <> 'NaN'),
  paid_on      date NOT NULL,
  method       text NOT NULL CHECK (method IN ('bank', 'cash', 'wallet', 'cheque')),
  reference    text CHECK (reference IS NULL OR char_length(reference) <= 100),
  paid_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  voided_at    timestamptz,
  voided_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  void_reason  text CHECK (void_reason IS NULL OR char_length(void_reason) <= 500),
  CONSTRAINT hr_salary_payments_void_complete
    CHECK ((voided_at IS NULL AND void_reason IS NULL) OR (voided_at IS NOT NULL AND btrim(COALESCE(void_reason, '')) <> ''))
);

-- run_id is what the Payroll page filters by; employee_id backs the NO ACTION FK check on an
-- employee delete; client_id backs the Danger Zone deletes and RLS.
CREATE INDEX IF NOT EXISTS idx_hr_salary_payments_run      ON public.hr_salary_payments (run_id);
CREATE INDEX IF NOT EXISTS idx_hr_salary_payments_employee ON public.hr_salary_payments (employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_salary_payments_client   ON public.hr_salary_payments (client_id);

ALTER TABLE public.hr_salary_payments ENABLE ROW LEVEL SECURITY;

-- The same set hr_payslips carries, live-read 2026-09-23: one permissive same-client policy with the
-- self-service fence inline (the hr_* convention), the POS / IMS staff-account fences, the HR
-- staff-rank read fence (a table holding pay joins it, S750), and manager rank for writes (S751).
DROP POLICY IF EXISTS client_own ON public.hr_salary_payments;
CREATE POLICY client_own ON public.hr_salary_payments
  TO authenticated
  USING (((select public.is_admin()) OR client_id = (select public.my_client_id())) AND NOT (select public.is_hr_self_service()))
  WITH CHECK (((select public.is_admin()) OR client_id = (select public.my_client_id())) AND NOT (select public.is_hr_self_service()));

DROP POLICY IF EXISTS no_pos_pin_staff ON public.hr_salary_payments;
CREATE POLICY no_pos_pin_staff ON public.hr_salary_payments AS RESTRICTIVE FOR ALL
  USING (NOT public.is_pos_pin_staff()) WITH CHECK (NOT public.is_pos_pin_staff());
DROP POLICY IF EXISTS no_ims_staff ON public.hr_salary_payments;
CREATE POLICY no_ims_staff ON public.hr_salary_payments AS RESTRICTIVE FOR ALL
  USING (NOT public.is_ims_staff()) WITH CHECK (NOT public.is_ims_staff());
DROP POLICY IF EXISTS no_hr_staff_rank ON public.hr_salary_payments;
CREATE POLICY no_hr_staff_rank ON public.hr_salary_payments AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT (select public.is_hr_staff_rank())) WITH CHECK (NOT (select public.is_hr_staff_rank()));

DO $$
DECLARE
  v_rank text := 'COALESCE((select public.is_admin()) OR (select public.is_client_owner()) OR '
              || '((select p.hr_role FROM public.profiles p WHERE p.id = (select auth.uid())) = ''manager''), false)';
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS hr_salary_payments_write_rank_insert ON public.hr_salary_payments';
  EXECUTE 'DROP POLICY IF EXISTS hr_salary_payments_write_rank_update ON public.hr_salary_payments';
  EXECUTE 'DROP POLICY IF EXISTS hr_salary_payments_write_rank_delete ON public.hr_salary_payments';
  EXECUTE format('CREATE POLICY hr_salary_payments_write_rank_insert ON public.hr_salary_payments AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (%s)', v_rank);
  EXECUTE format('CREATE POLICY hr_salary_payments_write_rank_update ON public.hr_salary_payments AS RESTRICTIVE FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', v_rank, v_rank);
  EXECUTE format('CREATE POLICY hr_salary_payments_write_rank_delete ON public.hr_salary_payments AS RESTRICTIVE FOR DELETE TO authenticated USING (%s)', v_rank);
END;
$$;

-- Raw-SQL tables get no role grants in this project by default.
REVOKE ALL ON public.hr_salary_payments FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_salary_payments TO authenticated;
GRANT ALL ON public.hr_salary_payments TO service_role;

-- Money paid to a person: it belongs in the audit trail with the payslips it pays.
CREATE OR REPLACE TRIGGER audit_hr_salary_payments
  AFTER INSERT OR DELETE OR UPDATE ON public.hr_salary_payments
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();

-- ── (2) Written only by the functions ───────────────────────────────────────────────────────────
--
-- The S753 ledger pattern: a SECURITY DEFINER function writes, a SECURITY INVOKER trigger refuses a
-- client session every direct write. Without it a manager's JWT could INSERT a payment of any amount
-- or DELETE one over REST, and "undone with a reason" would be a page rule, not a fact.
-- `current_user NOT IN ('anon','authenticated')` lets the DEFINER bodies, the service role (Danger
-- Zone) and referential actions through; the operator passes for an Export/Import restore.
CREATE OR REPLACE FUNCTION public.hr_salary_payments_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'salary_payment_ledger_locked: salary payments are recorded with Mark paid and undone with Undo payment';
END;
$$;
REVOKE ALL ON FUNCTION public.hr_salary_payments_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_salary_payments_guard ON public.hr_salary_payments;
CREATE TRIGGER hr_salary_payments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.hr_salary_payments
  FOR EACH ROW EXECUTE FUNCTION public.hr_salary_payments_guard();

-- ── (3) Mark paid ───────────────────────────────────────────────────────────────────────────────
--
-- Records, for each named employee, what is still owed on their payslip in this run: net pay less
-- every payment not undone. The amount is never a parameter, so nothing can be marked paid for more
-- than the payslip. Refuses rather than skips when someone has nothing owed: that is a second tab
-- having marked them first, and a silent skip would hide it. Under hr_pay_lock, so it queues behind
-- a Reopen or Finalize in another tab instead of racing it.
CREATE OR REPLACE FUNCTION public.record_salary_payments(
  p_run_id uuid, p_employee_ids uuid[], p_paid_on date, p_method text, p_reference text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r hr_payroll_runs;
  v_ref text := NULLIF(btrim(COALESCE(p_reference, '')), '');
  v_emp uuid;
  v_net numeric;
  v_name text;
  v_paid numeric;
  v_due numeric;
  v_count int := 0;
  v_total numeric := 0;
BEGIN
  SELECT * INTO r FROM hr_payroll_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'salary_payment_run_missing: this payroll run no longer exists — reload the page';
  END IF;
  IF NOT COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR r.client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'salary_payment_rank: marking salaries paid needs the Owner or an HR manager' USING ERRCODE = '42501';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('bank', 'cash', 'wallet', 'cheque') THEN
    RAISE EXCEPTION 'salary_payment_method: choose how the salary was paid';
  END IF;
  -- One day of slack: the database clock is UTC and Nepal is 5:45 ahead, so "today" in Kathmandu is
  -- tomorrow in UTC for the first hours of every morning.
  IF p_paid_on IS NULL OR p_paid_on > CURRENT_DATE + 1 THEN
    RAISE EXCEPTION 'salary_payment_date: the payment date cannot be in the future';
  END IF;
  IF v_ref IS NOT NULL AND char_length(v_ref) > 100 THEN
    RAISE EXCEPTION 'salary_payment_reference: the reference is longer than 100 characters';
  END IF;
  IF COALESCE(cardinality(p_employee_ids), 0) = 0 THEN
    RAISE EXCEPTION 'salary_payment_nobody: nobody was chosen to mark paid';
  END IF;

  PERFORM public.hr_pay_lock(r.client_id);
  SELECT * INTO r FROM hr_payroll_runs WHERE id = p_run_id FOR UPDATE;
  IF r.status <> 'finalized' THEN
    RAISE EXCEPTION 'salary_payment_not_finalized: only a finalized payroll can be marked paid — finalize it first';
  END IF;

  FOR v_emp IN SELECT DISTINCT x FROM unnest(p_employee_ids) x WHERE x IS NOT NULL LOOP
    SELECT p.net_pay, e.full_name INTO v_net, v_name
      FROM hr_payslips p LEFT JOIN hr_employees e ON e.id = p.employee_id
     WHERE p.run_id = r.id AND p.employee_id = v_emp;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'salary_payment_no_payslip: someone being marked paid has no payslip in this payroll — reload the page';
    END IF;
    SELECT COALESCE(sum(amount), 0) INTO v_paid
      FROM hr_salary_payments WHERE run_id = r.id AND employee_id = v_emp AND voided_at IS NULL;
    v_due := round(COALESCE(v_net, 0), 2) - v_paid;
    IF v_due < 0.01 THEN
      RAISE EXCEPTION 'salary_payment_nothing_due: % is already marked paid for this month — reload the page', COALESCE(v_name, 'an employee');
    END IF;
    INSERT INTO hr_salary_payments (client_id, run_id, employee_id, amount, paid_on, method, reference, paid_by)
    VALUES (r.client_id, r.id, v_emp, v_due, p_paid_on, p_method, v_ref, auth.uid());
    v_count := v_count + 1;
    v_total := v_total + v_due;
  END LOOP;

  RETURN jsonb_build_object('payments', v_count, 'total', v_total);
END;
$$;
REVOKE ALL ON FUNCTION public.record_salary_payments(uuid, uuid[], date, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_salary_payments(uuid, uuid[], date, text, text) TO authenticated, service_role;

-- ── (4) Undo a payment ──────────────────────────────────────────────────────────────────────────
--
-- A void, never a delete: the row stays with who undid it, when and why. Allowed on a reopened
-- (draft) run too, because that is when a manager is most likely to be correcting the month.
CREATE OR REPLACE FUNCTION public.void_salary_payment(p_payment_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  s hr_salary_payments;
  v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  SELECT * INTO s FROM hr_salary_payments WHERE id = p_payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'salary_payment_not_found: this payment record no longer exists — reload the page';
  END IF;
  IF NOT COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR s.client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'salary_payment_rank: undoing a salary payment needs the Owner or an HR manager' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < 3 THEN
    RAISE EXCEPTION 'salary_payment_void_reason: say why this payment is being undone';
  END IF;
  IF char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'salary_payment_void_reason: the reason is longer than 500 characters';
  END IF;

  PERFORM public.hr_pay_lock(s.client_id);
  SELECT * INTO s FROM hr_salary_payments WHERE id = p_payment_id FOR UPDATE;
  IF s.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'salary_payment_already_voided: this payment was already undone — reload the page';
  END IF;

  UPDATE hr_salary_payments SET voided_at = now(), voided_by = auth.uid(), void_reason = v_reason WHERE id = s.id;
  RETURN jsonb_build_object('voided', s.id, 'amount', s.amount);
END;
$$;
REVOKE ALL ON FUNCTION public.void_salary_payment(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.void_salary_payment(uuid, text) TO authenticated, service_role;

-- ── (5) The Staff app's "Paid on …" ─────────────────────────────────────────────────────────────
--
-- A new function beside get_my_hr_payslips rather than new columns on it, so the RPC every staff
-- member's Pay tab depends on is not dropped and rebuilt for a display line. Same identity
-- resolution as that function (read live 2026-09-23), and it calls hr_self_service_assert_active()
-- first, as every Staff-app RPC must (S753). Finalized months only; undone payments left out.
CREATE OR REPLACE FUNCTION public.get_my_salary_payments()
RETURNS TABLE(payslip_id uuid, paid_amount numeric, last_paid_on date, last_method text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_employee_id uuid;
BEGIN
  PERFORM public.hr_self_service_assert_active();
  SELECT pr.hr_employee_id INTO v_employee_id
    FROM profiles pr WHERE pr.id = auth.uid() AND pr.hr_self_service = true;
  IF v_employee_id IS NULL THEN RETURN; END IF;

  -- Every column cast to its declared type: RETURN QUERY compares type OIDs exactly (S737).
  RETURN QUERY
    SELECT p.id::uuid,
           sum(sp.amount)::numeric,
           max(sp.paid_on)::date,
           ((array_agg(sp.method ORDER BY sp.paid_on DESC, sp.created_at DESC))[1])::text
      FROM hr_payslips p
      JOIN hr_payroll_runs r ON r.id = p.run_id AND r.status = 'finalized'
      JOIN hr_salary_payments sp ON sp.run_id = p.run_id AND sp.employee_id = p.employee_id AND sp.voided_at IS NULL
     WHERE p.employee_id = v_employee_id
     GROUP BY p.id;
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_salary_payments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_salary_payments() TO authenticated, service_role;

-- ── (6) Assertions ──────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.hr_salary_payments'::regclass) THEN
    RAISE EXCEPTION 'S782: RLS is not enabled on hr_salary_payments';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'hr_salary_payments'
        AND policyname IN ('client_own', 'no_pos_pin_staff', 'no_ims_staff', 'no_hr_staff_rank',
                           'hr_salary_payments_write_rank_insert', 'hr_salary_payments_write_rank_update',
                           'hr_salary_payments_write_rank_delete')) <> 7 THEN
    RAISE EXCEPTION 'S782: hr_salary_payments is missing one of its seven policies';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'hr_salary_payments_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'S782: hr_salary_payments_guard trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_hr_salary_payments' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'S782: audit_hr_salary_payments trigger is missing';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hr_salary_payments_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'S782: hr_salary_payments_guard must be SECURITY INVOKER, or it passes every caller';
  END IF;
  IF NOT (SELECT bool_and(prosecdef) FROM pg_proc WHERE oid IN (
            'public.record_salary_payments(uuid, uuid[], date, text, text)'::regprocedure,
            'public.void_salary_payment(uuid, text)'::regprocedure,
            'public.get_my_salary_payments()'::regprocedure)) THEN
    RAISE EXCEPTION 'S782: the three salary-payment functions must be SECURITY DEFINER to write through the guard';
  END IF;
  IF has_function_privilege('anon', 'public.record_salary_payments(uuid, uuid[], date, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.void_salary_payment(uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_my_salary_payments()', 'EXECUTE') THEN
    RAISE EXCEPTION 'S782: a salary-payment function is anon-executable';
  END IF;
  IF has_table_privilege('anon', 'public.hr_salary_payments', 'SELECT') THEN
    RAISE EXCEPTION 'S782: anon can read hr_salary_payments';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.hr_salary_payments', 'SELECT') THEN
    RAISE EXCEPTION 'S782: authenticated cannot read hr_salary_payments — the page would see nothing';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
