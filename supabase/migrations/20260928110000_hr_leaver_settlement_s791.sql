-- S791 — A settled leaver's months stay paid once: salary payments, overtime and later months.
--
-- Found in hss-suite (batch 2, re-analysis #2 and #46) and confirmed here, with live evidence: one
-- leaver's month is already paid by both a recorded salary payment and a finalized settlement.
--
--   (a) A month-end leaver could be paid twice once salaries were ticked paid. Finalize Settlement
--       refuses while a finalized payroll pays the leaver for the last month (settlement_month_paid) —
--       but Reopen is allowed after payment (S782), and a reopened run is a draft, so the refusal
--       passed, the settlement paid the month, and the recorded salary payment for that same month
--       stood. It now also refuses while a live (not voided) salary payment stands for the leaver's
--       last month or a later one. Refused, never netted off: the payment is undone first (Payroll →
--       Undo payment), then the settlement pays the month.
--
--   (b) Overtime approved after the settlement was calculated was paid by nothing: payroll leaves a
--       settled leaver out, and the settlement stored the overtime it saw when the page loaded.
--       Finalize now refuses a draft whose last-month overtime is not the overtime on file, in hours
--       and in rupees (a weekday entry turned holiday keeps the hours and changes the pay).
--
--   (c) Nothing stopped overtime or attendance for a settled leaver's last month (or any later one)
--       while that month's payroll was still open. hr_pay_month_guard() now refuses them — the whole
--       attendance row and every overtime action, Crest's own "a paid month is read-only" rule (S749,
--       decided with Aashish 2026-09-28) — for the CURRENT employment only, so a rehire is paid. It
--       also carries the other half: in a month whose payroll is finalized, a leaver with no payslip in
--       that run whose settlement is still a DRAFT may still have their days corrected, because the
--       draft settlement, not the payroll, is what pays them.
--
--   (d) The payroll-side refusal (hr_run_settled_employee_names) keyed on settle_bs_year/month, which
--       settlements saved before S752 do not have — so those were invisible to it, the live case among
--       them — and it was not scoped to the employment, so a leaver who rejoined on the same record
--       was refused on every later payroll. It now keys on the month of last_working_date itself and
--       counts only a settlement in the current employment. The refusal's wording names all three ways
--       out (migration 20260928100000, which carries both raise sites).
--
-- Every function is rebuilt from its LIVE body (pg_get_functiondef, 2026-09-28). Reverse: re-run
-- hr_run_settled_employee_names from 20260914230000, hr_overtime_guard_finalized /
-- hr_attendance_guard_finalized from 20260914170000 and finalize_final_settlement from 20260915090000,
-- then DROP FUNCTION public.hr_pay_month_guard(uuid, uuid, integer, integer, integer) and
-- public.hr_ot_on_file(uuid, uuid, integer, integer, integer, integer).
--
-- Sections:
--   (1) hr_run_settled_employee_names — last_working_date's month, current employment, later months
--   (2) hr_ot_on_file                 — the overtime a settlement's last month pays, the engine's way
--   (3) hr_pay_month_guard            — the one refusal for attendance and overtime writes
--   (4) hr_overtime_guard_finalized / hr_attendance_guard_finalized call it
--   (5) finalize_final_settlement     — salary payment and overtime refusals; rehire-scoped month check
--   (6) Assertions

-- ── (1) Who a payroll run may not pay ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_run_settled_employee_names(p_run_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- The settlement's month is read off last_working_date (bs_months), never settle_bs_*: a settlement
  -- saved before S752 has no settle_bs_* and was invisible here. Only the CURRENT employment counts:
  -- a join date after the settled last day is a rehire, and a rehire is paid (S791).
  SELECT string_agg(DISTINCT COALESCE(s.employee_name, 'an employee'), ', ')
    FROM hr_payroll_runs r
    JOIN monthly_periods mp ON mp.id = r.period_id
    JOIN hr_payslips p ON p.run_id = r.id
    JOIN hr_employees e ON e.id = p.employee_id
    JOIN hr_final_settlements s ON s.employee_id = p.employee_id AND s.status = 'finalized'
    JOIN bs_months b ON s.last_working_date >= b.ad_start AND s.last_working_date < b.ad_start + b.days
   WHERE r.id = p_run_id
     AND COALESCE(public.is_admin() OR r.client_id = public.my_client_id(), false)
     AND (e.join_date IS NULL OR s.last_working_date >= e.join_date)
     AND mp.bs_year * 12 + mp.bs_month >= b.bs_year * 12 + b.bs_month
$function$;

-- ── (2) The overtime on file for a settlement's last month ──────────────────────────────────────
-- What computePayslip pays for the month, up to and including p_through_day: every APPROVED overtime
-- entry (bs_day on or before the day, or none), plus attendance-sheet OT on the days no approved entry
-- covers (an approved entry SUPERSEDES the sheet's OT on its day, S570). For a monthly employee only
-- the days from p_from_day count — the days before the join are docked as not employed and their
-- attendance is left out (S791 item 1); daily and hourly staff pass 1. Not a caller-facing function:
-- finalize_final_settlement (SECURITY DEFINER) is its one caller, so it carries no grant.
CREATE OR REPLACE FUNCTION public.hr_ot_on_file(
  p_client_id uuid, p_employee_id uuid, p_bs_year integer, p_bs_month integer,
  p_from_day integer, p_through_day integer)
 RETURNS TABLE(attendance_hours numeric, weekday_hours numeric, holiday_hours numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH entries AS (
    SELECT o.bs_day, COALESCE(o.ot_hours, 0) AS hrs, o.ot_type
      FROM hr_overtime_entries o
     WHERE o.client_id = p_client_id AND o.employee_id = p_employee_id
       AND o.bs_year = p_bs_year AND o.bs_month = p_bs_month AND o.status = 'approved'
       AND (o.bs_day IS NULL OR o.bs_day <= p_through_day)
  )
  SELECT
    (SELECT COALESCE(SUM(COALESCE(a.ot_hours, 0)), 0)
       FROM hr_attendance a
       JOIN monthly_periods mp ON mp.id = a.period_id
      WHERE mp.client_id = p_client_id AND mp.bs_year = p_bs_year AND mp.bs_month = p_bs_month
        AND a.employee_id = p_employee_id
        AND a.bs_day BETWEEN p_from_day AND p_through_day
        AND NOT EXISTS (SELECT 1 FROM entries x WHERE x.bs_day = a.bs_day)),
    (SELECT COALESCE(SUM(hrs), 0) FROM entries WHERE ot_type IS DISTINCT FROM 'holiday'),
    (SELECT COALESCE(SUM(hrs), 0) FROM entries WHERE ot_type = 'holiday')
$function$;
REVOKE ALL ON FUNCTION public.hr_ot_on_file(uuid, uuid, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;

-- ── (3) The one refusal for attendance and overtime writes ──────────────────────────────────────
-- SECURITY DEFINER because the triggers that call it are INVOKER and an HR supervisor's RLS view of
-- payslips and settlements is narrower than what the rule needs to read (the S749 parent-lookup rule:
-- a check that reads a table the caller cannot see is not a check for that caller). It takes
-- hr_pay_lock, the lock settlement Finalize and payroll Finalize take, so an overtime approval and a
-- Finalize cannot both pass their checks on either side of each other.
--
--   hr_month_finalized  the month's payroll is finalized — unless this employee has no payslip in
--                       that run and a DRAFT settlement (current employment) pays this day: the draft,
--                       not the payroll, pays them, so their days can still be corrected.
--   hr_month_settled    a FINALIZED settlement in the current employment paid this employee's last
--                       month, and this is that month or a later one: nothing here would be paid.
CREATE OR REPLACE FUNCTION public.hr_pay_month_guard(
  p_client_id uuid, p_employee_id uuid, p_bs_year integer, p_bs_month integer, p_bs_day integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_s record;
  v_months constant text[] := ARRAY['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin',
                                    'Kartik','Mangsir','Poush','Magh','Falgun','Chaitra'];
BEGIN
  -- Another client's row is not this function's to judge; RLS refuses that write on its own.
  IF NOT COALESCE(public.is_admin() OR p_client_id = public.my_client_id(), false) THEN RETURN; END IF;
  IF p_client_id IS NULL OR p_bs_year IS NULL OR p_bs_month IS NULL THEN RETURN; END IF;
  -- A whole-client deletion (an admin's Delete in ClientDrawer) cascades into attendance and overtime;
  -- once the clients row is gone this is that cascade, and it must not be refused half-way. The same
  -- parent-exists passthrough hr_payroll_finalized_for_* carry (S748/S749), inside the DEFINER lookup.
  IF NOT EXISTS (SELECT 1 FROM clients WHERE id = p_client_id) THEN RETURN; END IF;

  PERFORM public.hr_pay_lock(p_client_id);

  IF EXISTS (
    SELECT 1 FROM hr_payroll_runs r JOIN monthly_periods mp ON mp.id = r.period_id
     WHERE mp.client_id = p_client_id AND mp.bs_year = p_bs_year AND mp.bs_month = p_bs_month
       AND r.status = 'finalized') THEN
    IF p_employee_id IS NULL
       OR EXISTS (
         SELECT 1 FROM hr_payslips ps
           JOIN hr_payroll_runs r ON r.id = ps.run_id
           JOIN monthly_periods mp ON mp.id = r.period_id
          WHERE ps.employee_id = p_employee_id AND r.status = 'finalized'
            AND mp.client_id = p_client_id AND mp.bs_year = p_bs_year AND mp.bs_month = p_bs_month)
       OR NOT EXISTS (
         SELECT 1 FROM hr_final_settlements s
           JOIN hr_employees e ON e.id = s.employee_id
           JOIN bs_months b ON s.last_working_date >= b.ad_start AND s.last_working_date < b.ad_start + b.days
          WHERE s.employee_id = p_employee_id AND s.client_id = p_client_id AND s.status = 'draft'
            AND (e.join_date IS NULL OR s.last_working_date >= e.join_date)
            AND b.bs_year = p_bs_year AND b.bs_month = p_bs_month
            AND (p_bs_day IS NULL OR p_bs_day <= (s.last_working_date - b.ad_start) + 1)) THEN
      RAISE EXCEPTION 'hr_month_finalized: payroll for this month is finalized';
    END IF;
  END IF;

  IF p_employee_id IS NOT NULL THEN
    SELECT COALESCE(NULLIF(btrim(s.employee_name), ''), NULLIF(btrim(e.full_name), ''), 'This employee') AS who,
           b.bs_year, b.bs_month
      INTO v_s
      FROM hr_final_settlements s
      JOIN hr_employees e ON e.id = s.employee_id
      JOIN bs_months b ON s.last_working_date >= b.ad_start AND s.last_working_date < b.ad_start + b.days
     WHERE s.employee_id = p_employee_id AND s.client_id = p_client_id AND s.status = 'finalized'
       AND (e.join_date IS NULL OR s.last_working_date >= e.join_date)
       AND b.bs_year * 12 + b.bs_month <= p_bs_year * 12 + p_bs_month
     ORDER BY s.last_working_date DESC
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'hr_month_settled: %''s Final Settlement is finalized and paid their last month (% %), so nothing recorded for that month or later would be paid — if they have rejoined, record their new join date; if the settlement was a mistake, reopen it first',
        v_s.who, v_months[v_s.bs_month], v_s.bs_year;
    END IF;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.hr_pay_month_guard(uuid, uuid, integer, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hr_pay_month_guard(uuid, uuid, integer, integer, integer) TO authenticated, service_role;

-- ── (4) The two row guards call it ──────────────────────────────────────────────────────────────
-- Unchanged in shape: INVOKER, a function body or the service role passes (current_user), and every
-- write that touches a month is checked on the row it leaves (OLD) and the row it makes (NEW). S749's
-- rule stays whole — pending overtime, a delete and an Undo are all refused in a locked month.
CREATE OR REPLACE FUNCTION public.hr_overtime_guard_finalized()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM public.hr_pay_month_guard(OLD.client_id, OLD.employee_id, OLD.bs_year, OLD.bs_month, OLD.bs_day);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM public.hr_pay_month_guard(NEW.client_id, NEW.employee_id, NEW.bs_year, NEW.bs_month, NEW.bs_day);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.hr_attendance_guard_finalized()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mp record;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN COALESCE(NEW, OLD); END IF;
  -- The period's month is read through the DEFINER guard's own client check; an HR login's RLS view
  -- of monthly_periods is readable since S752, and the period is looked up by id.
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT client_id, bs_year, bs_month INTO v_mp FROM monthly_periods WHERE id = OLD.period_id;
    IF FOUND THEN
      PERFORM public.hr_pay_month_guard(v_mp.client_id, OLD.employee_id, v_mp.bs_year, v_mp.bs_month, OLD.bs_day);
    ELSIF public.hr_payroll_finalized_for_period(OLD.period_id) THEN
      RAISE EXCEPTION 'hr_month_finalized: payroll for this month is finalized';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT client_id, bs_year, bs_month INTO v_mp FROM monthly_periods WHERE id = NEW.period_id;
    IF FOUND THEN
      PERFORM public.hr_pay_month_guard(v_mp.client_id, NEW.employee_id, v_mp.bs_year, v_mp.bs_month, NEW.bs_day);
    ELSIF public.hr_payroll_finalized_for_period(NEW.period_id) THEN
      RAISE EXCEPTION 'hr_month_finalized: payroll for this month is finalized';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- ── (5) Final Settlement's Finalize ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finalize_final_settlement(p_settlement_id uuid)
 RETURNS hr_final_settlements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s hr_final_settlements;
  e hr_employees;
  a record;
  l record;
  v_outstanding numeric;
  v_claims uuid[];
  v_claim_total numeric;
  v_stored_claims uuid[];
  v_recover numeric;
  v_take numeric;
  v_recovered numeric := 0;
  v_new_status text;
  v_blocked text[] := '{}';
  v_month record;
  v_paid record;
  v_ot record;
  v_rate numeric;
  v_ot_hours numeric;
  v_ot_amount numeric;
  v_months constant text[] := ARRAY['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin',
                                    'Kartik','Mangsir','Poush','Magh','Falgun','Chaitra'];
BEGIN
  SELECT * INTO s FROM hr_final_settlements WHERE id = p_settlement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_not_found: this settlement no longer exists';
  END IF;
  IF NOT COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR s.client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'settlement_rank: finalizing a settlement needs the Owner or an HR manager' USING ERRCODE = '42501';
  END IF;
  IF NOT public.hr_self_decision_exempt() AND public.hr_is_own_employee(s.employee_id) THEN
    RAISE EXCEPTION 'hr_own_request: you cannot finalize your own settlement — someone else must';
  END IF;

  PERFORM public.hr_pay_lock(s.client_id);
  SELECT * INTO s FROM hr_final_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF s.status <> 'draft' THEN
    RAISE EXCEPTION 'settlement_already_finalized: this settlement was finalized somewhere else — reload the page';
  END IF;
  IF s.calc_version < 2 OR s.settle_bs_year IS NULL OR s.settle_bs_month IS NULL THEN
    RAISE EXCEPTION 'settlement_stale: this draft was calculated by an older version — open it and save it again';
  END IF;
  SELECT b.bs_year, b.bs_month, b.ad_start, b.days, (s.last_working_date - b.ad_start) + 1 AS last_day
    INTO v_month
    FROM bs_months b
   WHERE b.bs_year = s.settle_bs_year AND b.bs_month = s.settle_bs_month
     AND s.last_working_date >= b.ad_start AND s.last_working_date < b.ad_start + b.days;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_stale: the saved month does not match the last working date — open it and save it again';
  END IF;

  SELECT * INTO e FROM hr_employees WHERE id = s.employee_id AND client_id = s.client_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_employee_missing: this employee record no longer exists';
  END IF;

  IF EXISTS (
    SELECT 1 FROM hr_final_settlements x
     WHERE x.employee_id = s.employee_id AND x.status = 'finalized' AND x.id <> s.id
       AND (e.join_date IS NULL OR x.last_working_date >= e.join_date)) THEN
    RAISE EXCEPTION 'settlement_overlap: this employee already has a finalized settlement for this spell of service — reopen that one instead';
  END IF;

  -- Payroll that already pays the last month or a later one — within this spell of service only
  -- (S791): after a rehire, the new employment's payslips are the new employment's, and this older
  -- settlement's months end before the rehire's join month.
  IF EXISTS (
    SELECT 1 FROM hr_payslips p
      JOIN hr_payroll_runs r ON r.id = p.run_id
      JOIN monthly_periods mp ON mp.id = r.period_id
      JOIN bs_months pb ON pb.bs_year = mp.bs_year AND pb.bs_month = mp.bs_month
     WHERE p.employee_id = s.employee_id AND r.status = 'finalized'
       AND mp.bs_year * 12 + mp.bs_month >= s.settle_bs_year * 12 + s.settle_bs_month
       AND (e.join_date IS NULL OR e.join_date <= s.last_working_date OR pb.ad_start + pb.days <= e.join_date)) THEN
    RAISE EXCEPTION 'settlement_month_paid: a finalized payroll run already pays this employee for the final month or later — reopen that run, or move the last working date';
  END IF;

  -- S791: a salary payment recorded for the last month or a later one. Reopen is allowed after payment
  -- (S782), so the payslip check above passes on a reopened run while the money stands; the settlement
  -- then paid the month a second time. Refused, never netted off: undo the payment first.
  SELECT mp.bs_year, mp.bs_month, sp.amount, sp.paid_on
    INTO v_paid
    FROM hr_salary_payments sp
    JOIN hr_payroll_runs r ON r.id = sp.run_id
    JOIN monthly_periods mp ON mp.id = r.period_id
    JOIN bs_months pb ON pb.bs_year = mp.bs_year AND pb.bs_month = mp.bs_month
   WHERE sp.employee_id = s.employee_id AND sp.client_id = s.client_id AND sp.voided_at IS NULL
     AND mp.bs_year * 12 + mp.bs_month >= s.settle_bs_year * 12 + s.settle_bs_month
     AND (e.join_date IS NULL OR e.join_date <= s.last_working_date OR pb.ad_start + pb.days <= e.join_date)
   ORDER BY mp.bs_year, mp.bs_month, sp.paid_on
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'settlement_salary_paid: %''s salary for % % is recorded as paid (NPR % on %) — this settlement pays that month itself, so it would be paid twice; undo that payment on the Payroll page (Undo payment) first, then finalize',
      COALESCE(NULLIF(btrim(s.employee_name), ''), 'This employee'), v_months[v_paid.bs_month], v_paid.bs_year,
      to_char(v_paid.amount, 'FM99,99,99,990.00'), v_paid.paid_on;
  END IF;

  -- S791: the overtime this draft pays must be the overtime on file. Payroll leaves a settled leaver
  -- out, so overtime approved after the draft was calculated would otherwise be paid by nothing.
  -- Hours are compared exactly; rupees within Rs. 2 (the engine rounds its two OT parts separately in
  -- floating point, and a weekday entry re-typed as holiday moves the pay by far more than that).
  SELECT * INTO v_ot FROM public.hr_ot_on_file(
    s.client_id, s.employee_id, v_month.bs_year, v_month.bs_month,
    CASE WHEN COALESCE(s.pay_basis, 'monthly') = 'monthly' AND e.join_date IS NOT NULL
              AND e.join_date >= v_month.ad_start AND e.join_date <= s.last_working_date
         THEN (e.join_date - v_month.ad_start) + 1 ELSE 1 END,
    v_month.last_day);
  v_rate := CASE COALESCE(s.pay_basis, 'monthly')
              WHEN 'hourly' THEN COALESCE(s.basic_salary, 0)
              WHEN 'daily'  THEN COALESCE(s.basic_salary, 0) / 8
              ELSE COALESCE(s.basic_salary, 0) / (v_month.days * 8)
            END;
  v_ot_hours := v_ot.attendance_hours + v_ot.weekday_hours + v_ot.holiday_hours;
  v_ot_amount := round(v_ot.attendance_hours * v_rate * 1.5)
               + round(v_ot.weekday_hours * v_rate * 1.5 + v_ot.holiday_hours * v_rate * 2);
  IF abs(COALESCE(s.month_ot_hours, 0) - v_ot_hours) > 0.005
     OR abs(COALESCE(s.month_ot_amount, 0) - v_ot_amount) > 2 THEN
    RAISE EXCEPTION 'settlement_stale_ot: overtime for the last month changed since this draft was calculated — it pays % hours (NPR %), and % hours (about NPR %) are approved or on the attendance sheet up to the last working day now',
      round(COALESCE(s.month_ot_hours, 0), 2), to_char(COALESCE(s.month_ot_amount, 0), 'FM99,99,99,990.00'),
      round(v_ot_hours, 2), to_char(v_ot_amount, 'FM99,99,99,990.00');
  END IF;

  SELECT COALESCE(SUM(GREATEST(x.amount - public.hr_advance_repaid(x.id), 0)), 0) INTO v_outstanding
    FROM hr_advances x
   WHERE x.employee_id = s.employee_id AND x.client_id = s.client_id AND x.status = 'active';
  -- Exact to the paisa (S791): advance_deduction is stored at paisa, and a one-paisa difference is
  -- a different balance to recover.
  IF round(v_outstanding, 2) <> round(COALESCE(s.advance_deduction, 0), 2) THEN
    RAISE EXCEPTION 'settlement_stale_advances: this employee''s outstanding advances changed since the settlement was calculated (now NPR %) — reload it', round(v_outstanding, 2);
  END IF;

  SELECT COALESCE(array_agg(c.id ORDER BY c.id), '{}'), COALESCE(SUM(c.total_amount), 0)
    INTO v_claims, v_claim_total
    FROM hr_tada_claims c
   WHERE c.employee_id = s.employee_id AND c.client_id = s.client_id AND c.status = 'approved';
  SELECT COALESCE(array_agg(x ORDER BY x), '{}') INTO v_stored_claims FROM unnest(s.tada_claim_ids) x;
  IF v_claims IS DISTINCT FROM v_stored_claims OR abs(v_claim_total - COALESCE(s.tada_amount, 0)) > 0.01 THEN
    RAISE EXCEPTION 'settlement_stale_tada: this employee''s approved travel claims changed since the settlement was calculated — reload it';
  END IF;

  v_recover := LEAST(v_outstanding, GREATEST(0, COALESCE(s.net_payout, 0) + COALESCE(s.advance_deduction, 0)));
  FOR a IN
    SELECT x.id, x.amount, public.hr_advance_repaid(x.id) AS repaid
      FROM hr_advances x
     WHERE x.employee_id = s.employee_id AND x.client_id = s.client_id AND x.status = 'active'
     ORDER BY x.issued_date NULLS LAST, x.id
  LOOP
    EXIT WHEN v_recover <= 0.005;
    v_take := round(LEAST(GREATEST(a.amount - a.repaid, 0), v_recover), 2);
    IF v_take > 0.005 THEN
      INSERT INTO hr_advance_repayments (client_id, advance_id, employee_id, repaid_date, amount, notes, final_settlement_id)
      VALUES (s.client_id, a.id, s.employee_id, s.last_working_date, v_take, 'Final settlement', s.id);
      v_recover := v_recover - v_take;
      v_recovered := v_recovered + v_take;
    END IF;
  END LOOP;

  UPDATE hr_tada_claims
     SET status = 'paid', paid_method = 'Final Settlement', paid_at = now(), final_settlement_id = s.id
   WHERE id = ANY (v_claims);

  v_new_status := CASE s.separation_reason WHEN 'termination' THEN 'terminated' WHEN 'retirement' THEN 'inactive' ELSE 'resigned' END;

  UPDATE hr_final_settlements
     SET prior_status = COALESCE(prior_status, e.status),
         prior_end_date = CASE WHEN prior_status IS NULL THEN e.end_date ELSE prior_end_date END,
         prior_access_blocked = COALESCE(prior_access_blocked, e.access_blocked)
   WHERE id = s.id;

  UPDATE hr_employees
     SET status = v_new_status, end_date = s.last_working_date, access_blocked = true
   WHERE id = e.id;

  -- The leaver's staff logins. A login already banned by something else is left alone, so Reopen
  -- never unbans what this settlement did not ban.
  FOR l IN
    SELECT p.id, COALESCE(p.full_name, 'a login') AS name
      FROM profiles p JOIN auth.users u ON u.id = p.id
     WHERE p.hr_employee_id = e.id AND p.client_id = s.client_id
       AND (p.pos_email IS NOT NULL OR p.ims_role IS NOT NULL OR p.hr_role IS NOT NULL)
       AND p.id IS DISTINCT FROM (select auth.uid())
       AND (u.banned_until IS NULL OR u.banned_until < now())
  LOOP
    UPDATE auth.users SET banned_until = TIMESTAMPTZ '2999-12-31 00:00:00+00' WHERE id = l.id;
    DELETE FROM auth.sessions WHERE user_id = l.id;
    UPDATE profiles SET settlement_blocked_by = s.id WHERE id = l.id;
    v_blocked := v_blocked || l.name;
  END LOOP;

  UPDATE hr_final_settlements
     SET status = 'finalized', finalized_at = now(), advance_recovered = v_recovered, blocked_logins = v_blocked
   WHERE id = s.id
  RETURNING * INTO s;
  RETURN s;
END;
$function$;

-- ── (6) Assertions ──────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.finalize_final_settlement(uuid)'::regprocedure) NOT LIKE '%settlement_salary_paid%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.finalize_final_settlement(uuid)'::regprocedure) NOT LIKE '%settlement_stale_ot%' THEN
    RAISE EXCEPTION 'S791: finalize_final_settlement is missing a refusal';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.hr_run_settled_employee_names(uuid)'::regprocedure) LIKE '%settle_bs_year%' THEN
    RAISE EXCEPTION 'S791: hr_run_settled_employee_names still keys on settle_bs_*, which pre-S752 settlements lack';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.hr_overtime_guard_finalized()'::regprocedure) NOT LIKE '%hr_pay_month_guard%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.hr_attendance_guard_finalized()'::regprocedure) NOT LIKE '%hr_pay_month_guard%' THEN
    RAISE EXCEPTION 'S791: a row guard does not call hr_pay_month_guard';
  END IF;
  -- The row guards must stay INVOKER (current_user tells a client from a function body); the lookup
  -- must be DEFINER (a supervisor's RLS view of payslips and settlements is narrower than the rule).
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hr_overtime_guard_finalized()'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hr_attendance_guard_finalized()'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hr_pay_month_guard(uuid, uuid, integer, integer, integer)'::regprocedure) THEN
    RAISE EXCEPTION 'S791: a guard has the wrong SECURITY mode';
  END IF;
  IF has_function_privilege('anon', 'public.hr_pay_month_guard(uuid, uuid, integer, integer, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.hr_pay_month_guard(uuid, uuid, integer, integer, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.hr_ot_on_file(uuid, uuid, integer, integer, integer, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.hr_ot_on_file(uuid, uuid, integer, integer, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S791: a new function has the wrong EXECUTE grants';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'hr_overtime_guard_finalized' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'hr_attendance_guard_finalized' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'S791: a row guard trigger is missing';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
