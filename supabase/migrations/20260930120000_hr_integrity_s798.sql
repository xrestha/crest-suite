-- S798 stage 1b — HR integrity: the database refusals the HR re-analysis found missing.
-- Findings in docs/hr-review-s798/, fixes in HR_TODO.md S798.2; owner decisions 2026-09-30 (H8 = (a)).
--
-- 1. PEOPLE-ACCESS-1 (P0). hr_employees had no rank fence on writes, so an HR SUPERVISOR could PATCH
--    basic salary, bank account, SSF, status and dates, or insert and delete employees, over REST —
--    and payroll and the bank sheet read those columns live. RESTRICTIVE write policies at MANAGER
--    rank, the S751 money-table shape. Reads stay open to supervisors (S750: Overtime and the Roster
--    price hours from basic). Writers inventoried 2026-09-30: EmployeeForm, EmployeeList and PayForm
--    are manager-only pages; finalize_final_settlement / reopen_final_settlement are SECURITY DEFINER
--    (relforcerowsecurity is false); restore runs as admin; Danger Zone uses the service role.
-- 2. BONUS-LEDGERS-1. hr_advances_guard_own fired on INSERT/UPDATE only and tested the NEW employee
--    only, so an HR manager could delete their own advance, move it onto a colleague, or shrink its
--    instalment or push its issue date out. Now also on DELETE, tests OLD and NEW, and freezes
--    installment_amount, issued_date and type as well. New hr_advance_repayments_guard_own refuses a
--    repayment written on your own advance (a fake cash repayment settled the loan). Payroll and
--    settlement Finalize/Reopen are SECURITY DEFINER and pass the current_user seam.
-- 3. LEAVE-OT-HOLIDAYS-2. hr_overtime_guard_own refused only a status change, so an approved own
--    entry could be edited to 12 h at 2x and stay approved (S749: an edit keeps its approval). Below
--    the Owner, an approved entry that is yours before or after the edit keeps its employee, hours,
--    type and day; and approve/reject tests OLD and NEW (moving a colleague's pending entry onto
--    yourself and approving it in one PATCH passed the NEW-only test the other way round).
-- 4. SISTER-1 (H8 a) + the leave half of LEAVE-OT-HOLIDAYS-2. hr_leave_requests_guard_decision:
--    a decided request keeps employee, type, dates and day type for every client caller (hss #43);
--    below the Owner nobody cancels or reopens their own APPROVED leave (withdrawing your own pending
--    request stays allowed — it moves no pay or balance); approve/reject tests OLD and NEW; and an
--    approval, or a change to an approved request, is refused when a month it touches has finalized
--    payroll — what the Leave page already refused. hr_leave_range_finalized() is the SECURITY DEFINER
--    lookup for that, because a supervisor's RLS view of hr_payroll_runs is empty (S749: the parent
--    test lives in the DEFINER lookup, never in the INVOKER body). New BEFORE DELETE trigger: only a
--    pending request may be deleted (the attendance marks of a deleted approval stayed and its
--    balance came back). No app path deletes one; the service role's client wipe and the cascades
--    from an employee or client delete run as the table owner and pass the current_user seam.
-- 5. GAP-PAY-STATE-1. hr_tada_claims_guard let an HR manager move a payroll-paid claim back to
--    Approved over REST (their own too), and the next payroll paid it again. The branch was for the
--    S751 browser Reopen; since S753 both Reopens are SECURITY DEFINER and return before it. Removed,
--    so paid -> approved falls through to tada_transition_invalid for every client caller.
-- 6. SELF-SERVICE-2. employee_pay_history (SECURITY DEFINER) checked only the client, so a Crest Staff
--    or HR staff-rank login could count coworkers' advances and see who was settled out. The client
--    branch now carries exactly hr_employees' own read/delete reach, so the INVOKER delete guard that
--    calls it cannot pass vacuously for anyone who can actually delete an employee.
-- 7. LEAVE-OT-HOLIDAYS-1. backfillApprovedLeave ran with the closer's login, and RLS hides every HR row
--    from an IMS login, so an IMS supervisor's month close marked no approved leave and said nothing:
--    approved unpaid leave was then paid. hr_backfill_approved_leave(p_period_id) does it in the
--    database with backfillApprovedLeave.js's rules, which now calls it (one implementation): blanks
--    only, one row per employee-day, public holidays as 'holiday', leavers settled in the current
--    employment left out and counted, and hr_pay_month_guard per row (the INVOKER attendance guard
--    returns early inside a DEFINER body, so the function repeats it), under hr_pay_lock.
--
-- Every replaced function was rebuilt from its LIVE body read on 2026-09-30; step 0 refuses to run if
-- any of them has changed since (md5 of prosrc). Reversal: re-create the five earlier bodies — last
-- defined in 20260914150000 (employee_pay_history), 20260914230000 (hr_advances_guard_own,
-- hr_overtime_guard_own, hr_leave_requests_guard_decision) and 20260914220000 (hr_tada_claims_guard) —
-- drop the three hr_employees_write_rank_* policies, the two new triggers and the three new
-- functions, and re-create hr_advances_guard_own as BEFORE INSERT OR UPDATE. Not re-runnable as is:
-- once applied, step 0's fingerprints no longer match, which is the point.

-- ── 0. The bodies below replace what was live on 2026-09-30, and nothing newer ───────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM jsonb_each_text(jsonb_build_object(
    'employee_pay_history',             '2089c302f3bf74aa2d4a7ade337a278d',
    'hr_advances_guard_own',            '18dc2b823454ffba8560e2152ed1915b',
    'hr_leave_requests_guard_decision', '3825b2015bcb4181ebef3703176c343d',
    'hr_overtime_guard_own',            '26f068a29fff8b6eba864a8e21ea6c97',
    'hr_tada_claims_guard',             '07e16ecc857b8c219733cff07216c3ac'))
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = r.key AND md5(p.prosrc) = r.value) THEN
      RAISE EXCEPTION 'hr_integrity_s798: public.% is not the body read on 2026-09-30 — re-read it live and rebuild this migration', r.key;
    END IF;
  END LOOP;
END $$;

-- ── 1. hr_employees: writes need HR MANAGER rank (PEOPLE-ACCESS-1) ────────────────────────────────
DO $$
DECLARE
  rank_ok constant text :=
    'COALESCE((select public.is_admin()) OR (select public.is_client_owner()) '
    'OR (SELECT p.hr_role FROM public.profiles p WHERE p.id = (select auth.uid())) = ''manager'', false)';
BEGIN
  DROP POLICY IF EXISTS hr_employees_write_rank_insert ON public.hr_employees;
  DROP POLICY IF EXISTS hr_employees_write_rank_update ON public.hr_employees;
  DROP POLICY IF EXISTS hr_employees_write_rank_delete ON public.hr_employees;
  EXECUTE format('CREATE POLICY hr_employees_write_rank_insert ON public.hr_employees AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (%s)', rank_ok);
  EXECUTE format('CREATE POLICY hr_employees_write_rank_update ON public.hr_employees AS RESTRICTIVE FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', rank_ok, rank_ok);
  EXECUTE format('CREATE POLICY hr_employees_write_rank_delete ON public.hr_employees AS RESTRICTIVE FOR DELETE TO authenticated USING (%s)', rank_ok);
END $$;

-- ── 2. Advances and repayments: nobody below the Owner changes their own (BONUS-LEDGERS-1) ────────
CREATE OR REPLACE FUNCTION public.hr_advances_guard_own()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Payroll and settlement Finalize/Reopen are SECURITY DEFINER, and a restore is the service role.
  IF current_user NOT IN ('anon', 'authenticated') OR public.hr_self_decision_exempt() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF public.hr_is_own_employee(OLD.employee_id) THEN
      RAISE EXCEPTION 'hr_own_request: you cannot delete your own advance — someone else must';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF public.hr_is_own_employee(NEW.employee_id) THEN
      RAISE EXCEPTION 'hr_own_request: you cannot issue an advance to yourself — someone else must record it';
    END IF;
    RETURN NEW;
  END IF;
  -- Yours before OR after: moving your own advance onto a colleague cuts their salary for it.
  IF NOT (public.hr_is_own_employee(OLD.employee_id) OR public.hr_is_own_employee(NEW.employee_id)) THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'written_off' AND OLD.status IS DISTINCT FROM 'written_off' THEN
    RAISE EXCEPTION 'hr_own_request: you cannot write off your own advance — someone else must decide it';
  END IF;
  -- The instalment and the issue date decide what payroll cuts and from when (firstRecoveryMonth).
  IF NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.installment_amount IS DISTINCT FROM OLD.installment_amount
     OR NEW.issued_date IS DISTINCT FROM OLD.issued_date
     OR NEW.type IS DISTINCT FROM OLD.type THEN
    RAISE EXCEPTION 'hr_own_request: you cannot change your own advance — someone else must';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS hr_advances_guard_own ON public.hr_advances;
CREATE TRIGGER hr_advances_guard_own BEFORE INSERT OR UPDATE OR DELETE ON public.hr_advances
  FOR EACH ROW EXECUTE FUNCTION public.hr_advances_guard_own();

-- hr_advance_repayments_guard already refuses a repayment whose employee is not its advance's, so the
-- repayment's own employee_id is the advance's owner.
CREATE OR REPLACE FUNCTION public.hr_advance_repayments_guard_own()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.hr_self_decision_exempt() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF public.hr_is_own_employee(OLD.employee_id) THEN
      RAISE EXCEPTION 'hr_own_request: you cannot change or delete a repayment on your own advance — someone else must';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF public.hr_is_own_employee(NEW.employee_id) THEN
      RAISE EXCEPTION 'hr_own_request: you cannot record a repayment on your own advance — someone else must';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

REVOKE ALL ON FUNCTION public.hr_advance_repayments_guard_own() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_advance_repayments_guard_own ON public.hr_advance_repayments;
CREATE TRIGGER hr_advance_repayments_guard_own BEFORE INSERT OR UPDATE OR DELETE ON public.hr_advance_repayments
  FOR EACH ROW EXECUTE FUNCTION public.hr_advance_repayments_guard_own();

-- ── 3. Overtime: an approved own entry keeps what was approved (LEAVE-OT-HOLIDAYS-2) ──────────────
CREATE OR REPLACE FUNCTION public.hr_overtime_guard_own()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.hr_self_decision_exempt() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN ('approved', 'rejected') AND public.hr_is_own_employee(NEW.employee_id) THEN
      RAISE EXCEPTION 'hr_own_request: you cannot approve or reject your own overtime — someone else must decide it';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (public.hr_is_own_employee(OLD.employee_id) OR public.hr_is_own_employee(NEW.employee_id)) THEN
    RETURN NEW;
  END IF;
  IF NEW.status IN ('approved', 'rejected') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'hr_own_request: you cannot approve or reject your own overtime — someone else must decide it';
  END IF;
  -- S749: an edit keeps its approval. So on your own approved entry the edit itself is the decision.
  IF OLD.status = 'approved' AND (
       NEW.employee_id IS DISTINCT FROM OLD.employee_id
    OR NEW.ot_hours    IS DISTINCT FROM OLD.ot_hours
    OR NEW.ot_type     IS DISTINCT FROM OLD.ot_type
    OR NEW.bs_year     IS DISTINCT FROM OLD.bs_year
    OR NEW.bs_month    IS DISTINCT FROM OLD.bs_month
    OR NEW.bs_day      IS DISTINCT FROM OLD.bs_day) THEN
    RAISE EXCEPTION 'hr_own_request: you cannot change your own approved overtime — someone else must';
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 4. Leave: decided requests, own cancels, finalized months, deletes (SISTER-1, H8) ─────────────
-- Whether payroll is finalized for any BS month the AD range touches — the Leave page's
-- finalizedMonthsFor, in the database. Another client's range reads false: RLS refuses that write.
CREATE OR REPLACE FUNCTION public.hr_leave_range_finalized(p_client_id uuid, p_start date, p_end date)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (public.is_admin() OR p_client_id = public.my_client_id())
    AND EXISTS (
      SELECT 1
        FROM bs_months b
        JOIN monthly_periods mp ON mp.client_id = p_client_id AND mp.bs_year = b.bs_year AND mp.bs_month = b.bs_month
        JOIN hr_payroll_runs r ON r.period_id = mp.id AND r.status = 'finalized'
       WHERE b.ad_start <= p_end AND b.ad_start + b.days > p_start),
    false)
$function$;

REVOKE ALL ON FUNCTION public.hr_leave_range_finalized(uuid, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hr_leave_range_finalized(uuid, date, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.hr_leave_range_finalized(uuid, date, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.hr_leave_requests_guard_decision()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'approved' AND NOT public.hr_self_decision_exempt() AND public.hr_is_own_employee(NEW.employee_id) THEN
      RAISE EXCEPTION 'hr_own_request: you cannot approve your own leave — someone else must decide it';
    END IF;
    IF NEW.status IN ('approved', 'rejected', 'cancelled') THEN
      NEW.decided_by := (select auth.uid());
    ELSE
      NEW.decided_by := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- A decided request keeps who, what and when, for every client caller (hss #43). The leave balance
  -- and the attendance marks were decided on these; different dates are a new request.
  IF OLD.status IN ('approved', 'rejected', 'cancelled') AND (
       NEW.employee_id   IS DISTINCT FROM OLD.employee_id
    OR NEW.leave_type_id IS DISTINCT FROM OLD.leave_type_id
    OR NEW.start_date    IS DISTINCT FROM OLD.start_date
    OR NEW.end_date      IS DISTINCT FROM OLD.end_date
    OR COALESCE(NEW.day_type, 'full') IS DISTINCT FROM COALESCE(OLD.day_type, 'full')) THEN
    RAISE EXCEPTION 'leave_request_locked: a decided leave request keeps its employee, type, dates and day type';
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    NEW.decided_by := OLD.decided_by;
    RETURN NEW;
  END IF;

  -- Nobody below the Owner decides their own record (S752), and taking back an approval is a
  -- decision too (H8): cancelled leave goes back on the balance and is encashed at exit. Yours
  -- before or after the change, so it cannot be moved onto you in the same PATCH.
  IF NOT public.hr_self_decision_exempt()
     AND (public.hr_is_own_employee(OLD.employee_id) OR public.hr_is_own_employee(NEW.employee_id)) THEN
    IF NEW.status IN ('approved', 'rejected') THEN
      RAISE EXCEPTION 'hr_own_request: you cannot approve or reject your own leave — someone else must decide it';
    END IF;
    IF OLD.status = 'approved' THEN
      RAISE EXCEPTION 'hr_own_request: you cannot cancel your own approved leave — someone else must';
    END IF;
  END IF;

  -- An approval writes attendance and a cancel removes it; in a finalized month those days are on
  -- issued payslips (S749). The page refused this; now the database does.
  IF OLD.status = 'approved' AND public.hr_leave_range_finalized(OLD.client_id, OLD.start_date, OLD.end_date) THEN
    RAISE EXCEPTION 'hr_month_finalized: payroll for a month this leave touches is finalized';
  END IF;
  IF NEW.status = 'approved' AND public.hr_leave_range_finalized(NEW.client_id, NEW.start_date, NEW.end_date) THEN
    RAISE EXCEPTION 'hr_month_finalized: payroll for a month this leave touches is finalized';
  END IF;

  IF NEW.status IN ('approved', 'rejected', 'cancelled') THEN
    NEW.decided_by := (select auth.uid());
  ELSE
    NEW.decided_by := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.hr_leave_requests_guard_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- The service role (Danger Zone's wipe) passes, and so do the cascades from an employee or client
  -- delete: a referential action runs as the table owner.
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN OLD; END IF;
  IF OLD.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'leave_request_locked: only a pending leave request can be deleted — cancel a decided one instead';
  END IF;
  RETURN OLD;
END;
$function$;

REVOKE ALL ON FUNCTION public.hr_leave_requests_guard_delete() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_leave_requests_guard_delete ON public.hr_leave_requests;
CREATE TRIGGER hr_leave_requests_guard_delete BEFORE DELETE ON public.hr_leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.hr_leave_requests_guard_delete();

-- ── 5. TADA: paid -> approved only inside the Reopen functions (GAP-PAY-STATE-1) ─────────────────
CREATE OR REPLACE FUNCTION public.hr_tada_claims_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_operator constant boolean := current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false);
BEGIN
  -- The Staff app's SECURITY DEFINER submit runs as the owner and stamps its own row. So do
  -- reopen_payroll_run and reopen_final_settlement, the only writers of paid -> approved (S798).
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

  RAISE EXCEPTION 'tada_transition_invalid: a % claim cannot become %', OLD.status, NEW.status;
END;
$function$;

-- ── 6. employee_pay_history: only for logins that can see employees at all (SELF-SERVICE-2) ──────
CREATE OR REPLACE FUNCTION public.employee_pay_history(p_ids uuid[])
 RETURNS TABLE(ref_employee_id uuid, ref_kind text, ref_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT e.id
      FROM hr_employees e
     WHERE e.id = ANY (p_ids)
       AND COALESCE(
             (select auth.uid()) IS NULL
             OR is_admin()
             -- hr_employees' own read and delete reach (S798): a Crest Staff, HR staff-rank, POS PIN
             -- or IMS login learned coworkers' advance counts and who was settled out from here.
             OR (e.client_id = my_client_id()
                 AND NOT is_hr_self_service()
                 AND NOT is_hr_staff_rank()
                 AND NOT is_pos_pin_staff()
                 AND NOT is_ims_staff()),
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
$function$;

-- ── 7. Approved leave reaches a new month's sheet whoever opens it (LEAVE-OT-HOLIDAYS-1) ──────────
-- backfillApprovedLeave.js's rules (S741, S749 holidays, S791 settled leavers), run in the database so
-- an IMS closer's RLS view of the HR tables no longer decides what is marked. Returns
-- {filled, skipped, settled, employees}: `skipped` is employee-days already carrying a mark, `settled`
-- employee-days of a leaver whose finalized Final Settlement paid this month.
CREATE OR REPLACE FUNCTION public.hr_backfill_approved_leave(p_period_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mp      monthly_periods;
  v_start   date;
  v_end     date;
  v_filled  int := 0;
  v_skipped int := 0;
  v_settled int := 0;
  v_emps    uuid[] := '{}';
  r         record;
BEGIN
  SELECT * INTO v_mp FROM monthly_periods WHERE id = p_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hr_backfill_no_period: that month does not exist';
  END IF;
  -- Whoever may open a month (the Owner, an IMS supervisor or manager — never a count PIN) or mark
  -- leave (an HR supervisor or manager), of this client; or the operator.
  IF NOT COALESCE(
       public.is_admin()
       OR (v_mp.client_id = public.my_client_id()
           AND NOT public.is_hr_self_service()
           AND NOT public.is_pos_pin_staff()
           AND (public.is_client_owner()
                OR EXISTS (SELECT 1 FROM profiles p
                            WHERE p.id = (select auth.uid())
                              AND ((p.ims_role IN ('supervisor', 'manager') AND p.ims_email IS NULL)
                                   OR p.hr_role IN ('supervisor', 'manager'))))),
       false) THEN
    RAISE EXCEPTION 'hr_backfill_forbidden: this login cannot mark leave on that month';
  END IF;

  SELECT b.ad_start, b.ad_start + b.days - 1 INTO v_start, v_end
    FROM bs_months b WHERE b.bs_year = v_mp.bs_year AND b.bs_month = v_mp.bs_month;
  IF v_start IS NULL THEN
    RAISE EXCEPTION 'hr_backfill_no_calendar: that month is outside the BS calendar';
  END IF;

  FOR r IN
    WITH req AS (
      SELECT q.id, q.employee_id, q.created_at,
             GREATEST(q.start_date, v_start) AS d_from,
             LEAST(q.end_date, v_end)        AS d_to,
             COALESCE(q.day_type, 'full') <> 'full' AS half,
             -- A missing or deleted type is unpaid, as leaveBalance and the JS back-fill read it.
             (t.id IS NOT NULL AND t.paid IS DISTINCT FROM false) AS paid
        FROM hr_leave_requests q
        LEFT JOIN hr_leave_types t ON t.id = q.leave_type_id
       WHERE q.client_id = v_mp.client_id
         AND q.status = 'approved'
         AND q.start_date <= v_end AND q.end_date >= v_start
    ), days AS (
      -- One row per employee-day: two approved requests on one day would otherwise write it twice.
      SELECT DISTINCT ON (q.employee_id, q.d_from + g.i)
             q.employee_id, (q.d_from + g.i) - v_start + 1 AS bs_day, q.half, q.paid
        FROM req q
        CROSS JOIN LATERAL generate_series(0, q.d_to - q.d_from) AS g(i)
       ORDER BY q.employee_id, q.d_from + g.i, q.created_at, q.id
    ), settled AS (
      -- Settled in the CURRENT employment: a join date after the settled last day is a rehire.
      SELECT DISTINCT s.employee_id
        FROM hr_final_settlements s
        JOIN hr_employees e ON e.id = s.employee_id
       WHERE s.client_id = v_mp.client_id AND s.status = 'finalized'
         AND s.last_working_date <= v_end
         AND (e.join_date IS NULL OR s.last_working_date >= e.join_date)
    )
    SELECT d.employee_id, d.bs_day,
           CASE
             WHEN EXISTS (SELECT 1 FROM hr_holiday_calendar h
                           WHERE h.client_id = v_mp.client_id AND h.holiday_type = 'public'
                             AND h.removed_at IS NULL
                             AND h.bs_year = v_mp.bs_year AND h.bs_month = v_mp.bs_month
                             AND h.bs_day = d.bs_day) THEN 'holiday'
             WHEN d.paid THEN CASE WHEN d.half THEN 'half_paid_leave' ELSE 'paid_leave' END
             ELSE CASE WHEN d.half THEN 'half_unpaid_leave' ELSE 'unpaid_leave' END
           END AS status,
           EXISTS (SELECT 1 FROM settled x WHERE x.employee_id = d.employee_id) AS is_settled
      FROM days d
     ORDER BY d.employee_id, d.bs_day
  LOOP
    IF r.is_settled THEN v_settled := v_settled + 1; CONTINUE; END IF;
    -- The INVOKER attendance guard returns early inside this DEFINER body, so its refusal (a
    -- finalized month; takes hr_pay_lock) is called here for every row it would have judged.
    PERFORM public.hr_pay_month_guard(v_mp.client_id, r.employee_id, v_mp.bs_year, v_mp.bs_month, r.bs_day);
    -- Blanks only: a day already marked (by hand, by approval, by Generate) is never overwritten.
    INSERT INTO hr_attendance (client_id, employee_id, period_id, bs_day, status)
    VALUES (v_mp.client_id, r.employee_id, p_period_id, r.bs_day, r.status)
    ON CONFLICT (employee_id, period_id, bs_day) DO NOTHING;
    IF FOUND THEN
      v_filled := v_filled + 1;
      IF NOT (r.employee_id = ANY (v_emps)) THEN v_emps := v_emps || r.employee_id; END IF;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('filled', v_filled, 'skipped', v_skipped, 'settled', v_settled,
                            'employees', COALESCE(array_length(v_emps, 1), 0));
END;
$function$;

REVOKE ALL ON FUNCTION public.hr_backfill_approved_leave(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hr_backfill_approved_leave(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.hr_backfill_approved_leave(uuid) TO authenticated;

-- ── 8. Assert what this migration promised ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'hr_employees' AND permissive = 'RESTRICTIVE'
         AND policyname IN ('hr_employees_write_rank_insert', 'hr_employees_write_rank_update', 'hr_employees_write_rank_delete')) <> 3 THEN
    RAISE EXCEPTION 'hr_integrity_s798: hr_employees write-rank policies missing';
  END IF;
  -- tgtype bit 8 = DELETE
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'hr_advances_guard_own' AND tgrelid = 'public.hr_advances'::regclass AND (tgtype & 8) <> 0)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'hr_advance_repayments_guard_own' AND tgrelid = 'public.hr_advance_repayments'::regclass AND (tgtype & 8) <> 0)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'hr_leave_requests_guard_delete' AND tgrelid = 'public.hr_leave_requests'::regclass AND (tgtype & 8) <> 0) THEN
    RAISE EXCEPTION 'hr_integrity_s798: a guard trigger is missing or does not fire on DELETE';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.hr_tada_claims_guard()'::regprocedure) LIKE '%OLD.paid_method = ''Payroll''%' THEN
    RAISE EXCEPTION 'hr_integrity_s798: the paid -> approved branch is still in hr_tada_claims_guard';
  END IF;
  IF has_function_privilege('anon', 'public.hr_backfill_approved_leave(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.hr_leave_range_finalized(uuid, date, date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.hr_backfill_approved_leave(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.hr_leave_range_finalized(uuid, date, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'hr_integrity_s798: function grants are not what this migration set';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
