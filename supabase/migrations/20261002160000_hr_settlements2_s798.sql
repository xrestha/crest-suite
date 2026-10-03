-- S798 stage 3b — Final Settlement against payroll, pending requests and paid records. Findings
-- SETTLEMENT-1, -2, -6, GAP-PAY-STATE-2, -4, BONUS-LEDGERS-3 and PEOPLE-ACCESS-4 in docs/hr-review-s798/,
-- fixes in HR_TODO.md S798.4 (owner decisions H4 (a), H5 (a), H11 (a), H15 (a), H20 (a) and H21 (a), taken
-- 2026-09-30). finalize_final_settlement, hr_final_settlements_guard and the three list functions are
-- rebuilt from their LIVE bodies (pg_get_functiondef, read 2026-10-03), and each change is marked "S798 3b".
--
-- 1. SETTLEMENT-1 (H4: keep the first payment and show what is still to pay). Reopen keeps paid_at,
--    paid_method and paid_amount, so a re-finalized settlement whose net moved shows the difference on
--    the page. record_settlement_difference(settlement, method) records the top-up (or the money handed
--    back) as an entry in the new hr_final_settlements.paid_adjustments list and brings paid_amount to
--    net_payout; the amount is never a parameter. hr_final_settlements_guard refuses deleting a draft
--    that was paid before it was reopened (settlement_paid_record): it is the record of that payment.
-- 2. SETTLEMENT-2 (H15: refuse until every earlier month is finalized). settlement_open_prior_months
--    (employee, last day) lists each earlier month of the settlement's fiscal year, plus always the month
--    just before the final month, inside the current employment, whose payroll is a draft (a reopened
--    run counts), was finalized without this person, or has not been run although the outlet already
--    runs payroll in Crest. finalize_final_settlement refuses while any is listed
--    (settlement_prior_month_open); the page names them first.
-- 3. SETTLEMENT-6 (H20: only the Owner settles someone with an HR Manager login). Below the Owner,
--    finalize_final_settlement refuses when a login linked to the leaver holds hr_role 'manager'
--    (settlement_manager_login). settlement_linked_logins also returns hr_manager, for the confirm.
-- 4. GAP-PAY-STATE-2 and BONUS-LEDGERS-3 (H11: refuse until each is decided). finalize_final_settlement
--    refuses while leave starting on or before the last working day, or overtime in the final month, is
--    still pending (settlement_pending_requests), or any travel claim is pending
--    (settlement_pending_tada).
-- 5. GAP-PAY-STATE-4 (H5: warn at Reopen and flag it until paid). settlement_skipped_payroll_months
--    (employee, last day) lists finalized payroll months from the final month on that hold no payslip for
--    this person. The page names them at Reopen, on the reopened draft and in Employees; the guard refuses
--    deleting a reopened draft while any is listed (settlement_payroll_skipped).
-- 6. PEOPLE-ACCESS-4 (H21: a rehire gets the old logins back). hr_unblock_rehired_logins(employee) clears
--    the ban and the stamp on every login an earlier employment's finalized settlement blocked. Owner or
--    HR manager, never on your own record; an HR Manager login is unblocked only by the Owner (H20). The
--    staff lists for IMS and HR return settlement_blocked, as POS Staff's already does.
--
-- Live 2026-10-03: two finalized settlements (one paid, its paid_amount equal to its net), none reopened,
-- and no pending leave, overtime or travel claim in any client, so nothing stored needs repair.
--
-- Reverse: restore finalize_final_settlement and hr_final_settlements_guard from their previous bodies
-- (every change is marked S798 3b), DROP + CREATE settlement_linked_logins, get_ims_staff_list and
-- get_hr_role_staff_list without their new last column (and re-grant), DROP the four new functions, then
-- DROP COLUMN hr_final_settlements.paid_adjustments.

ALTER TABLE public.hr_final_settlements
  ADD COLUMN IF NOT EXISTS paid_adjustments jsonb NOT NULL DEFAULT '[]'::jsonb;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_final_settlements_paid_adjustments_array') THEN
    ALTER TABLE public.hr_final_settlements
      ADD CONSTRAINT hr_final_settlements_paid_adjustments_array CHECK (jsonb_typeof(paid_adjustments) = 'array');
  END IF;
END $$;
COMMENT ON COLUMN public.hr_final_settlements.paid_adjustments IS
  'S798 3b: payments recorded after the first one (paid_at/paid_method/paid_amount), each {amount, method, at, by, net_payout}; written only by record_settlement_difference. amount is signed: negative is money handed back.';

-- ── 2 + 3 + 4. finalize_final_settlement ────────────────────────────────────────────────────────────
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
  v_from_day integer;
  v_att record;
  v_basis text;
  v_unpaid numeric;
  v_earned numeric;
  v_fy integer;
  v_fest record;
  v_name text;
  v_mgr text;
  v_open text;
  v_pending_leave integer;
  v_pending_ot integer;
  v_pending_tada integer;
  v_pending_tada_amount numeric;
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
  v_name := COALESCE(NULLIF(btrim(s.employee_name), ''), 'This employee');

  -- S798 H26 (SETTLEMENT-5): a last working day before the CURRENT join date is an earlier employment.
  -- Finalizing it would mark the working rehire as left, off payroll and locked out.
  IF e.join_date IS NOT NULL AND e.join_date > s.last_working_date THEN
    RAISE EXCEPTION 'settlement_rehired: % was taken back on % — this settlement belongs to an earlier employment and cannot be finalized; pay any correction by hand and note it',
      v_name, e.join_date;
  END IF;

  IF EXISTS (
    SELECT 1 FROM hr_final_settlements x
     WHERE x.employee_id = s.employee_id AND x.status = 'finalized' AND x.id <> s.id
       AND (e.join_date IS NULL OR x.last_working_date >= e.join_date)) THEN
    RAISE EXCEPTION 'settlement_overlap: this employee already has a finalized settlement for this spell of service — reopen that one instead';
  END IF;

  -- S798 3b SETTLEMENT-6 (H20): only the Owner finalizes the settlement of someone holding an HR Manager
  -- login. Finalize bans that login, and HR Staff leaves a manager's login to the Owner.
  IF NOT public.hr_self_decision_exempt() THEN
    SELECT string_agg(COALESCE(p.full_name, 'a login'), ', ' ORDER BY p.full_name) INTO v_mgr
      FROM profiles p
     WHERE p.hr_employee_id = e.id AND p.client_id = s.client_id AND p.hr_role = 'manager';
    IF v_mgr IS NOT NULL THEN
      RAISE EXCEPTION 'settlement_manager_login: % holds an HR Manager login (%) — only the Owner finalizes the settlement of someone with an HR Manager login',
        v_name, v_mgr;
    END IF;
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
      v_name, v_months[v_paid.bs_month], v_paid.bs_year,
      to_char(v_paid.amount, 'FM99,99,99,990.00'), v_paid.paid_on;
  END IF;

  -- S798 3b SETTLEMENT-2 (H15): every earlier month this settlement's tax year and gratuity offset read
  -- must be final. A month still a draft is later finalized with its own SSF, paying that month's
  -- gratuity a second time, and its own tax projection, neither of which this settlement saw. A month
  -- finalized without them (or not run yet) pays them nothing.
  SELECT string_agg(v_months[x.bs_month] || ' ' || x.bs_year || CASE x.state
           WHEN 'draft' THEN ' (still a draft)' WHEN 'not_run' THEN ' (not run yet)'
           ELSE ' (finalized without them)' END, ', ' ORDER BY x.bs_year, x.bs_month)
    INTO v_open
    FROM public.settlement_open_prior_months(s.employee_id, s.last_working_date) x;
  IF v_open IS NOT NULL THEN
    RAISE EXCEPTION 'settlement_prior_month_open: payroll for an earlier month is not final for %: % — finalize that payroll first (reopen and Regenerate a month that left them out), then recalculate and finalize this settlement',
      v_name, v_open;
  END IF;

  -- S798 3b GAP-PAY-STATE-2 (H11): leave or overtime still awaiting a decision. Pending leave is paid as
  -- worked and encashed again, pending overtime is paid by nobody, and the month locks once this is
  -- finalized, so neither could be approved afterwards.
  SELECT count(*) INTO v_pending_leave
    FROM hr_leave_requests r
   WHERE r.employee_id = s.employee_id AND r.client_id = s.client_id AND r.status = 'pending'
     AND r.start_date <= s.last_working_date
     AND (e.join_date IS NULL OR r.end_date >= e.join_date);
  SELECT count(*) INTO v_pending_ot
    FROM hr_overtime_entries o
   WHERE o.employee_id = s.employee_id AND o.client_id = s.client_id AND o.status = 'pending'
     AND o.bs_year = v_month.bs_year AND o.bs_month = v_month.bs_month
     AND (o.bs_day IS NULL OR o.bs_day <= v_month.last_day);
  IF v_pending_leave > 0 OR v_pending_ot > 0 THEN
    RAISE EXCEPTION 'settlement_pending_requests: % has % leave request(s) and % overtime entr(ies) up to the last working day still waiting for a decision — approve or reject each in Leave and Overtime, then recalculate and finalize',
      v_name, v_pending_leave, v_pending_ot;
  END IF;

  -- S798 3b BONUS-LEDGERS-3 (H11): a travel claim still pending. The settlement pays approved claims
  -- only, and no payroll will ever include a leaver, so a claim approved afterwards is paid by nobody.
  SELECT count(*), COALESCE(sum(c.total_amount), 0) INTO v_pending_tada, v_pending_tada_amount
    FROM hr_tada_claims c
   WHERE c.employee_id = s.employee_id AND c.client_id = s.client_id AND c.status = 'pending';
  IF v_pending_tada > 0 THEN
    RAISE EXCEPTION 'settlement_pending_tada: % has % travel claim(s) (NPR %) still waiting for a decision — approve or reject each in TADA Claims, then recalculate and finalize',
      v_name, v_pending_tada, to_char(v_pending_tada_amount, 'FM99,99,99,990.00');
  END IF;

  -- The first day of the final month this employment covers: a monthly joiner in this month is paid
  -- from the join day (the engine docks the days before it as not employed); everyone else from day 1.
  v_basis := COALESCE(s.pay_basis, 'monthly');
  v_from_day := CASE WHEN v_basis = 'monthly' AND e.join_date IS NOT NULL
                          AND e.join_date >= v_month.ad_start AND e.join_date <= s.last_working_date
                     THEN (e.join_date - v_month.ad_start) + 1 ELSE 1 END;

  -- S791: the overtime this draft pays must be the overtime on file. Payroll leaves a settled leaver
  -- out, so overtime approved after the draft was calculated would otherwise be paid by nothing.
  -- Hours are compared exactly; rupees within Rs. 2 (the engine rounds its two OT parts separately in
  -- floating point, and a weekday entry re-typed as holiday moves the pay by far more than that).
  SELECT * INTO v_ot FROM public.hr_ot_on_file(
    s.client_id, s.employee_id, v_month.bs_year, v_month.bs_month, v_from_day, v_month.last_day);
  v_rate := CASE v_basis
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

  -- S798 SETTLEMENT-3: the attendance this draft pays must be the attendance on file. The month's sheet
  -- locks once this settlement is finalized, so an absence marked after the screen loaded was paid and
  -- could not be seen to differ. The engine's own arithmetic (payrollCompute.js computePayslip):
  --   monthly: unpaid days = absent + unpaid leave + half of each half day / half unpaid leave
  --            + days outside the employment (before the join day, after the last working day)
  --   daily:   wage = basic x (present + half of a half day + paid leave + a paid half + half of an
  --            unpaid half + holiday), rounded to the rupee
  --   hourly:  wage = basic x (hours worked - overtime hours + 8 per paid leave or holiday + 4 per
  --            paid half), rounded to the rupee
  SELECT * INTO v_att FROM public.hr_attendance_on_file(
    s.client_id, s.employee_id, v_month.bs_year, v_month.bs_month, v_from_day, v_month.last_day);
  IF v_basis = 'monthly' THEN
    v_unpaid := v_att.absent + v_att.unpaid_leave + 0.5 * v_att.half_day + 0.5 * v_att.half_unpaid_leave
              + LEAST(v_month.days, (v_from_day - 1) + (v_month.days - v_month.last_day));
    IF abs(COALESCE(s.month_unpaid_days, 0) - v_unpaid) > 0.001 THEN
      RAISE EXCEPTION 'settlement_stale_attendance: attendance for the last month changed since this draft was calculated — it docks % unpaid days, and the attendance sheet now comes to % up to the last working day',
        round(COALESCE(s.month_unpaid_days, 0), 2), round(v_unpaid, 2);
    END IF;
  ELSE
    v_earned := round(COALESCE(s.basic_salary, 0) * CASE v_basis
      WHEN 'daily' THEN v_att.present + 0.5 * v_att.half_day + v_att.paid_leave + v_att.half_paid_leave
                      + 0.5 * v_att.half_unpaid_leave + v_att.holiday
      ELSE GREATEST(0, v_att.sum_hours - v_att.sum_ot)
           + 8 * (v_att.paid_leave + v_att.holiday) + 4 * v_att.half_paid_leave
    END);
    IF abs(COALESCE(s.month_gross, 0) - v_earned) > 1 THEN
      RAISE EXCEPTION 'settlement_stale_attendance: attendance for the last month changed since this draft was calculated — it pays NPR % for the days worked, and the attendance sheet now comes to NPR % up to the last working day',
        to_char(COALESCE(s.month_gross, 0), 'FM99,99,99,990.00'), to_char(v_earned, 'FM99,99,99,990.00');
    END IF;
  END IF;

  -- S798 GAP-PAY-STATE-3: a festival share is not paid on top of a festival allowance already paid
  -- this fiscal year (the page's festivalAlreadyPaid: a finalized row with an amount, in the FY of
  -- the settlement month). Under the same hr_pay_lock the festival guard takes.
  IF COALESCE(s.festival_pro, 0) > 0 THEN
    v_fy := CASE WHEN s.settle_bs_month >= 4 THEN s.settle_bs_year ELSE s.settle_bs_year - 1 END;
    SELECT f.festival_name, f.bs_year, f.bs_month, f.amount INTO v_fest
      FROM hr_festival_allowances f
     WHERE f.employee_id = s.employee_id AND f.client_id = s.client_id
       AND f.status = 'finalized' AND COALESCE(f.amount, 0) > 0
       AND f.bs_year * 12 + f.bs_month BETWEEN v_fy * 12 + 4 AND (v_fy + 1) * 12 + 3
     ORDER BY f.bs_year, f.bs_month
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'settlement_festival_paid: % was paid the % allowance (NPR %, % %) this fiscal year, and this draft also pays a festival share of NPR % — tick "Festival allowance paid this FY" and save again',
        v_name, v_fest.festival_name, to_char(v_fest.amount, 'FM99,99,99,990.00'), v_months[v_fest.bs_month], v_fest.bs_year,
        to_char(s.festival_pro, 'FM99,99,99,990.00');
    END IF;
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

-- ── 1 + 5. hr_final_settlements_guard ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_final_settlements_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_skipped text;
  v_months constant text[] := ARRAY['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin',
                                    'Kartik','Mangsir','Poush','Magh','Falgun','Chaitra'];
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
    NEW.paid_adjustments := '[]'::jsonb;  -- S798 3b: written only by record_settlement_difference
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- A whole-client deletion cascades through: once the clients row is gone nothing here applies.
    IF EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id) THEN
      IF OLD.status = 'finalized' THEN
        RAISE EXCEPTION 'settlement_finalized: a finalized settlement cannot be deleted — reopen it first';
      END IF;
      -- S798 3b SETTLEMENT-1 (H4): a draft that was paid before it was reopened is the only record of
      -- that payment.
      IF OLD.paid_at IS NOT NULL THEN
        RAISE EXCEPTION 'settlement_paid_record: this settlement was paid (NPR %) before it was reopened, and it is the record of that payment — it cannot be deleted; correct it and finalize it again',
          to_char(COALESCE(OLD.paid_amount, OLD.net_payout, 0), 'FM99,99,99,990.00');
      END IF;
      -- S798 3b GAP-PAY-STATE-4 (H5): payroll left this person out of those months because this settlement
      -- was paying them. Deleting it leaves that pay to nobody.
      IF OLD.reopened_at IS NOT NULL THEN
        SELECT string_agg(v_months[x.bs_month] || ' ' || x.bs_year, ', ' ORDER BY x.bs_year, x.bs_month)
          INTO v_skipped
          FROM public.settlement_skipped_payroll_months(OLD.employee_id, OLD.last_working_date) x;
        IF v_skipped IS NOT NULL THEN
          RAISE EXCEPTION 'settlement_payroll_skipped: payroll for % was finalized without %, because this settlement was paying it — finalize this settlement again, or reopen that payroll and Regenerate so they are paid there, before deleting it',
            v_skipped, COALESCE(NULLIF(btrim(OLD.employee_name), ''), 'this employee');
        END IF;
      END IF;
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
    NEW.paid_adjustments := OLD.paid_adjustments;  -- S798 3b
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

-- ── 2. settlement_open_prior_months (SETTLEMENT-2, H15) ───────────────────────────────────────────
-- The earlier months a settlement's year-to-date tax and gratuity offset read, whose payroll is not
-- final. Both readers count finalized runs only (fetchYtdMap, fetchSsfContributions), so a month still a
-- draft is later finalized with its own SSF (paying that month's gratuity twice) and its own tax
-- projection, neither of which the settlement saw. Called by the page before Finalize and by
-- finalize_final_settlement.
CREATE OR REPLACE FUNCTION public.settlement_open_prior_months(p_employee_id uuid, p_last_working_date date)
 RETURNS TABLE(bs_year integer, bs_month integer, state text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  e hr_employees;
  v_y integer;
  v_m integer;
  v_idx integer;
  v_from integer;
  v_join integer;
  v_first integer;
BEGIN
  SELECT * INTO e FROM hr_employees x WHERE x.id = p_employee_id;
  IF NOT FOUND OR p_last_working_date IS NULL THEN RETURN; END IF;
  IF NOT COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR e.client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'settlement_rank: checking a settlement needs the Owner or an HR manager' USING ERRCODE = '42501';
  END IF;
  -- An earlier employment's settlement is never finalized (H26), so there is nothing to check.
  IF e.join_date IS NOT NULL AND e.join_date > p_last_working_date THEN RETURN; END IF;

  SELECT b.bs_year, b.bs_month INTO v_y, v_m FROM bs_months b
   WHERE p_last_working_date >= b.ad_start AND p_last_working_date < b.ad_start + b.days;
  IF NOT FOUND THEN RETURN; END IF;
  v_idx := v_y * 12 + v_m;
  -- From the fiscal year's Shrawan (month 4), or from the month just before the final month when that is
  -- earlier (settling in Shrawan reaches back to Ashadh, whose SSF the gratuity offset reads), never
  -- before the join month.
  v_from := LEAST((CASE WHEN v_m >= 4 THEN v_y ELSE v_y - 1 END) * 12 + 4, v_idx - 1);
  IF e.join_date IS NOT NULL THEN
    SELECT b.bs_year * 12 + b.bs_month INTO v_join FROM bs_months b
     WHERE e.join_date >= b.ad_start AND e.join_date < b.ad_start + b.days;
    v_from := GREATEST(v_from, COALESCE(v_join, v_from));
  END IF;
  -- The first month this outlet ran payroll in Crest. Before it, a month with no run is not a gap.
  SELECT min(mp.bs_year * 12 + mp.bs_month) INTO v_first
    FROM hr_payroll_runs r JOIN monthly_periods mp ON mp.id = r.period_id
   WHERE r.client_id = e.client_id;

  RETURN QUERY
  SELECT b.bs_year::integer, b.bs_month::integer,
         (CASE WHEN r.id IS NULL THEN 'not_run' WHEN r.status <> 'finalized' THEN 'draft' ELSE 'missing' END)::text
    FROM bs_months b
    LEFT JOIN monthly_periods mp ON mp.client_id = e.client_id AND mp.bs_year = b.bs_year AND mp.bs_month = b.bs_month
    LEFT JOIN hr_payroll_runs r ON r.period_id = mp.id AND r.client_id = e.client_id
   WHERE b.bs_year * 12 + b.bs_month >= v_from AND b.bs_year * 12 + b.bs_month < v_idx
     AND ((r.id IS NULL AND v_first IS NOT NULL AND b.bs_year * 12 + b.bs_month > v_first)
       OR (r.id IS NOT NULL AND r.status <> 'finalized')
       OR (r.id IS NOT NULL AND r.status = 'finalized'
           AND NOT EXISTS (SELECT 1 FROM hr_payslips p WHERE p.run_id = r.id AND p.employee_id = e.id)))
   ORDER BY b.bs_year, b.bs_month;
END;
$function$;
REVOKE ALL ON FUNCTION public.settlement_open_prior_months(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settlement_open_prior_months(uuid, date) TO authenticated, service_role;

-- ── 5. settlement_skipped_payroll_months (GAP-PAY-STATE-4, H5) ────────────────────────────────────
-- Finalized payroll months, from the settlement's final month on, that hold no payslip for this person.
-- Payroll leaves a settled leaver out of that month and every later one (fetchPayrollEmployees), so once
-- the settlement is reopened and the leaving cancelled, these months are paid by nobody until that
-- payroll is reopened and regenerated. The page names them; the guard refuses deleting a reopened draft
-- while any is listed.
CREATE OR REPLACE FUNCTION public.settlement_skipped_payroll_months(p_employee_id uuid, p_last_working_date date)
 RETURNS TABLE(bs_year integer, bs_month integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  e hr_employees;
  v_idx integer;
BEGIN
  SELECT * INTO e FROM hr_employees x WHERE x.id = p_employee_id;
  IF NOT FOUND OR p_last_working_date IS NULL THEN RETURN; END IF;
  IF NOT COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR e.client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'settlement_rank: checking a settlement needs the Owner or an HR manager' USING ERRCODE = '42501';
  END IF;
  -- After a rehire the months between the old last day and the new join date were not worked.
  IF e.join_date IS NOT NULL AND e.join_date > p_last_working_date THEN RETURN; END IF;

  SELECT b.bs_year * 12 + b.bs_month INTO v_idx FROM bs_months b
   WHERE p_last_working_date >= b.ad_start AND p_last_working_date < b.ad_start + b.days;
  IF v_idx IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT mp.bs_year::integer, mp.bs_month::integer
    FROM hr_payroll_runs r JOIN monthly_periods mp ON mp.id = r.period_id
   WHERE r.client_id = e.client_id AND r.status = 'finalized'
     AND mp.bs_year * 12 + mp.bs_month >= v_idx
     AND NOT EXISTS (SELECT 1 FROM hr_payslips p WHERE p.run_id = r.id AND p.employee_id = e.id)
   ORDER BY mp.bs_year, mp.bs_month;
END;
$function$;
REVOKE ALL ON FUNCTION public.settlement_skipped_payroll_months(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settlement_skipped_payroll_months(uuid, date) TO authenticated, service_role;

-- ── 1. record_settlement_difference (SETTLEMENT-1, H4) ─────────────────────────────────────────────
-- A settlement paid, reopened and finalized again at a different net keeps its first payment
-- (paid_amount) and shows the difference. This records the money that settles it: a top-up when more is
-- owed, money handed back when it was overpaid. The amount is net_payout minus what is recorded, never a
-- parameter, and each entry is kept in paid_adjustments.
CREATE OR REPLACE FUNCTION public.record_settlement_difference(p_settlement_id uuid, p_method text)
 RETURNS hr_final_settlements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s hr_final_settlements;
  v_diff numeric;
BEGIN
  SELECT * INTO s FROM hr_final_settlements WHERE id = p_settlement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_not_found: this settlement no longer exists';
  END IF;
  IF NOT COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR s.client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'settlement_rank: recording a settlement payment needs the Owner or an HR manager' USING ERRCODE = '42501';
  END IF;
  IF NOT public.hr_self_decision_exempt() AND public.hr_is_own_employee(s.employee_id) THEN
    RAISE EXCEPTION 'hr_own_request: you cannot record a payment on your own settlement — someone else must';
  END IF;
  IF btrim(COALESCE(p_method, '')) = '' THEN
    RAISE EXCEPTION 'settlement_no_difference: say how the money was paid (Cash or Bank)';
  END IF;

  SELECT * INTO s FROM hr_final_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF s.status <> 'finalized' THEN
    RAISE EXCEPTION 'settlement_no_difference: this settlement is a draft — finalize it first, then record what is still to pay';
  END IF;
  IF s.paid_at IS NULL THEN
    RAISE EXCEPTION 'settlement_no_difference: this settlement is not recorded as paid yet — use Mark paid';
  END IF;
  v_diff := round(COALESCE(s.net_payout, 0) - COALESCE(s.paid_amount, 0), 2);
  IF abs(v_diff) < 0.005 THEN
    RAISE EXCEPTION 'settlement_no_difference: nothing is still to pay or overpaid on this settlement — reload the page';
  END IF;

  UPDATE hr_final_settlements
     SET paid_amount = s.net_payout,
         paid_adjustments = COALESCE(paid_adjustments, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
           'amount', v_diff, 'method', btrim(p_method), 'at', now(), 'by', (select auth.uid()),
           'net_payout', s.net_payout))
   WHERE id = s.id
  RETURNING * INTO s;
  RETURN s;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_settlement_difference(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_settlement_difference(uuid, text) TO authenticated, service_role;

-- ── 6. hr_unblock_rehired_logins (PEOPLE-ACCESS-4, H21) ────────────────────────────────────────────
-- A settled leaver taken back (a join date after the settled last day) gets back the logins that earlier
-- settlement blocked: the same person, so their name stays on every bill and shift they recorded. Only
-- the logins an earlier employment's finalized settlement stamped are touched. Below the Owner an HR
-- Manager login stays blocked (H20: the Owner changes a manager's login) and is returned with
-- unblocked = false, so the page can say who must do it.
CREATE OR REPLACE FUNCTION public.hr_unblock_rehired_logins(p_employee_id uuid)
 RETURNS TABLE(full_name text, modules text, unblocked boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  e hr_employees;
  l record;
  v_exempt boolean := public.hr_self_decision_exempt();
BEGIN
  SELECT * INTO e FROM hr_employees x WHERE x.id = p_employee_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR e.client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'settlement_rank: unblocking a rehired employee''s logins needs the Owner or an HR manager' USING ERRCODE = '42501';
  END IF;
  IF NOT v_exempt AND public.hr_is_own_employee(e.id) THEN
    RAISE EXCEPTION 'hr_own_request: you cannot unblock your own logins — the Owner must';
  END IF;
  IF e.status NOT IN ('active', 'probation') OR e.join_date IS NULL THEN RETURN; END IF;

  FOR l IN
    SELECT p.id, COALESCE(p.full_name, 'a login') AS name, COALESCE(p.hr_role = 'manager', false) AS is_manager,
           concat_ws(', ',
             CASE WHEN p.hr_role IS NOT NULL THEN 'HR' END,
             CASE WHEN p.ims_role IS NOT NULL THEN 'IMS' END,
             CASE WHEN p.pos_email IS NOT NULL THEN 'POS' END) AS mods
      FROM profiles p
     WHERE p.client_id = e.client_id
       AND p.settlement_blocked_by IN (
         SELECT s.id FROM hr_final_settlements s
          WHERE s.employee_id = e.id AND s.client_id = e.client_id AND s.status = 'finalized'
            AND s.last_working_date < e.join_date)
     ORDER BY 2
  LOOP
    full_name := l.name;
    modules := l.mods;
    IF l.is_manager AND NOT v_exempt THEN
      unblocked := false;
    ELSE
      UPDATE auth.users SET banned_until = NULL WHERE id = l.id;
      UPDATE profiles SET settlement_blocked_by = NULL WHERE id = l.id;
      unblocked := true;
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$function$;
REVOKE ALL ON FUNCTION public.hr_unblock_rehired_logins(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_unblock_rehired_logins(uuid) TO authenticated, service_role;

-- ── 3. settlement_linked_logins: + hr_manager ────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.settlement_linked_logins(uuid);
CREATE OR REPLACE FUNCTION public.settlement_linked_logins(p_employee_id uuid)
 RETURNS TABLE(full_name text, modules text, hr_manager boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(p.full_name, 'a login')::text,
         concat_ws(', ',
           CASE WHEN p.hr_role IS NOT NULL THEN 'HR' END,
           CASE WHEN p.ims_role IS NOT NULL THEN 'IMS' END,
           CASE WHEN p.pos_email IS NOT NULL THEN 'POS' END)::text,
         -- S798 3b (H20): only the Owner finalizes the settlement of someone with an HR Manager login.
         COALESCE(p.hr_role = 'manager', false)::boolean
    FROM profiles p
    JOIN hr_employees e ON e.id = p.hr_employee_id
   WHERE p.hr_employee_id = p_employee_id
     AND p.client_id = e.client_id
     AND (p.pos_email IS NOT NULL OR p.ims_role IS NOT NULL OR p.hr_role IS NOT NULL)
     AND COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR e.client_id = public.my_client_id()), false)
   ORDER BY 1
$function$;
REVOKE ALL ON FUNCTION public.settlement_linked_logins(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settlement_linked_logins(uuid) TO authenticated, service_role;

-- ── 6a. get_ims_staff_list: + settlement_blocked ─────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_ims_staff_list(uuid);
CREATE OR REPLACE FUNCTION public.get_ims_staff_list(p_client_id uuid)
 RETURNS TABLE(id uuid, full_name text, email text, ims_role text, ims_job_title text, last_seen_at timestamp with time zone, hr_employee_id uuid, employee_code text, has_pin boolean, settlement_blocked boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
  caller_ims_role  text;
BEGIN
  SELECT COALESCE(p.active_client_id, p.client_id), p.ims_role INTO caller_client_id, caller_ims_role
  FROM profiles p WHERE p.id = auth.uid();

  -- Admin, the client Owner, or an IMS MANAGER of that client — the S729 rule (20260910120000):
  -- this list returns every IMS login's real sign-in email. 20260910150000 (S737) re-created the
  -- function to fix its result types and lost the rank check in the copy, so from 2026-09-10 until
  -- this migration any account of the client (a POS PIN waiter, a Self-Service employee) could read
  -- them again. COALESCE: is_admin() / is_client_owner() are NULL for a profile-less session.
  IF COALESCE(
       public.is_admin()
       OR (caller_client_id = p_client_id
           AND (public.is_client_owner() OR caller_ims_role = 'manager')),
       false)
  THEN
    RETURN QUERY
      SELECT p.id::uuid,
             p.full_name::text,
             -- NULL for a PIN account: nobody types the synthetic address, and it is half a
             -- credential, so it has no reason to leave the server.
             (CASE WHEN p.ims_email IS NULL THEN u.email ELSE NULL END)::text,
             p.ims_role::text,
             p.ims_job_title::text,
             p.last_seen_at::timestamptz,
             p.hr_employee_id::uuid,
             e.employee_code::text,
             (p.ims_email IS NOT NULL)::boolean,
             -- S798 3b (PEOPLE-ACCESS-4): blocked by a Final Settlement, shown as POS Staff shows it.
             (p.settlement_blocked_by IS NOT NULL)::boolean
      FROM profiles p
      JOIN auth.users u ON u.id = p.id
      LEFT JOIN hr_employees e ON e.id = p.hr_employee_id
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.ims_role IS NOT NULL
      ORDER BY p.full_name;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_ims_staff_list(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_ims_staff_list(uuid) TO authenticated, service_role;

-- ── 6b. get_hr_role_staff_list: + settlement_blocked ─────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_hr_role_staff_list(uuid);
CREATE OR REPLACE FUNCTION public.get_hr_role_staff_list(p_client_id uuid)
 RETURNS TABLE(id uuid, full_name text, email text, hr_role text, hr_job_title text, last_seen_at timestamp with time zone, hr_employee_id uuid, employee_code text, settlement_blocked boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
  caller_hr_role   text;
BEGIN
  SELECT COALESCE(p.active_client_id, p.client_id), p.hr_role INTO caller_client_id, caller_hr_role
  FROM profiles p WHERE p.id = auth.uid();

  IF COALESCE(
       public.is_admin()
       OR (caller_client_id = p_client_id
           AND (public.is_client_owner() OR caller_hr_role = 'manager')),
       false)
  THEN
    RETURN QUERY
      SELECT p.id, p.full_name, u.email::text, p.hr_role, p.hr_job_title, p.last_seen_at, p.hr_employee_id, e.employee_code,
             (p.settlement_blocked_by IS NOT NULL)::boolean  -- S798 3b (PEOPLE-ACCESS-4)
      FROM profiles p
      JOIN auth.users u ON u.id = p.id
      LEFT JOIN hr_employees e ON e.id = p.hr_employee_id
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.hr_role IS NOT NULL
      ORDER BY p.full_name;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_hr_role_staff_list(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_hr_role_staff_list(uuid) TO authenticated, service_role;

-- ══ Checks: the migration refuses to finish if any of the above did not land ══
DO $$
DECLARE
  v_fn text;
  v_src text;
  v_emp uuid;
  v_raised boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'hr_final_settlements'
                    AND column_name = 'paid_adjustments' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'S798 3b: hr_final_settlements.paid_adjustments is missing or nullable';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY['public.settlement_open_prior_months(uuid,date)',
      'public.settlement_skipped_payroll_months(uuid,date)', 'public.record_settlement_difference(uuid,text)',
      'public.hr_unblock_rehired_logins(uuid)', 'public.settlement_linked_logins(uuid)',
      'public.get_ims_staff_list(uuid)', 'public.get_hr_role_staff_list(uuid)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'S798 3b: anon can execute %', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'S798 3b: authenticated cannot execute %', v_fn;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      RAISE EXCEPTION 'S798 3b: % is not SECURITY DEFINER', v_fn;
    END IF;
  END LOOP;

  IF NOT (SELECT 'hr_manager' = ANY (proargnames) FROM pg_proc WHERE oid = 'public.settlement_linked_logins(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'S798 3b: settlement_linked_logins does not return hr_manager';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.get_ims_staff_list(uuid)', 'public.get_hr_role_staff_list(uuid)'] LOOP
    IF NOT (SELECT 'settlement_blocked' = ANY (proargnames) FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      RAISE EXCEPTION 'S798 3b: % does not return settlement_blocked', v_fn;
    END IF;
  END LOOP;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.finalize_final_settlement(uuid)'::regprocedure;
  FOREACH v_fn IN ARRAY ARRAY['settlement_manager_login', 'settlement_prior_month_open',
      'settlement_pending_requests', 'settlement_pending_tada'] LOOP
    IF position(v_fn IN v_src) = 0 THEN
      RAISE EXCEPTION 'S798 3b: finalize_final_settlement has no % refusal', v_fn;
    END IF;
  END LOOP;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.hr_final_settlements_guard()'::regprocedure;
  FOREACH v_fn IN ARRAY ARRAY['settlement_paid_record', 'settlement_payroll_skipped',
      'NEW.paid_adjustments := OLD.paid_adjustments', 'NEW.paid_adjustments := ''[]''::jsonb'] LOOP
    IF position(v_fn IN v_src) = 0 THEN
      RAISE EXCEPTION 'S798 3b: hr_final_settlements_guard lacks %', v_fn;
    END IF;
  END LOOP;

  -- Behavioural: a signed-in session with no profile row (is_admin() is NULL for it) must be refused by
  -- every new caller check, not fall through it (the S630 trap).
  SELECT id INTO v_emp FROM hr_employees ORDER BY id LIMIT 1;
  IF v_emp IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000003b0","role":"authenticated"}', true);
    IF public.is_admin() IS NOT NULL THEN
      RAISE EXCEPTION 'S798 3b: the profile-less test claim unexpectedly has a profile';
    END IF;
    FOREACH v_fn IN ARRAY ARRAY['open', 'skipped', 'unblock'] LOOP
      v_raised := false;
      BEGIN
        IF v_fn = 'open' THEN PERFORM * FROM public.settlement_open_prior_months(v_emp, current_date);
        ELSIF v_fn = 'skipped' THEN PERFORM * FROM public.settlement_skipped_payroll_months(v_emp, current_date);
        ELSE PERFORM * FROM public.hr_unblock_rehired_logins(v_emp);
        END IF;
      EXCEPTION WHEN insufficient_privilege THEN v_raised := true;
      END;
      IF NOT v_raised THEN
        RAISE EXCEPTION 'S798 3b: % let a profile-less session through its caller check', v_fn;
      END IF;
    END LOOP;
    PERFORM set_config('request.jwt.claims', '', true);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
