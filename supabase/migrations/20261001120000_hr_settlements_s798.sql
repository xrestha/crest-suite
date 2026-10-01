-- S798 stage 2a — Final Settlement: what it pays must match what is on file, once per spell.
-- Findings in docs/hr-review-s798/, fixes in HR_TODO.md S798.3; owner decisions 2026-10-01 (H26, H28).
-- Every function below is rebuilt from its LIVE body (read 2026-10-01), not from an older migration.
--
-- 1. GAP-OPERATOR-3 (H28). hr_final_settlements_guard returned early for the Crest operator BEFORE the
--    paid-mark stamp, so a settlement the operator marked paid stored paid_at and no paid_amount; a
--    Reopen then read "paid NPR 0" and a re-finalize printed the NEW net payout as what was paid. The
--    stamp now runs above the seam for every caller and only fills an empty amount (the 20260914220000
--    shape). Backfill: paid, never-reopened rows take net_payout (1 row live on 2026-10-01). A paid row
--    that was REOPENED is not guessed (its net_payout may have moved since the money went out); none
--    exists today, and the assertion block refuses to apply if one appears before this runs.
-- 2. SETTLEMENT-3. Finalize re-checked overtime, advances, claims and payroll but never attendance, so
--    an absence marked after the screen loaded was paid anyway, and the month's attendance then locked.
--    New hr_attendance_on_file() tallies the sheet the way the pay engine does (payrollCompute.js
--    tallyAttendance) and Finalize refuses settlement_stale_attendance when the draft's month differs:
--    monthly staff by unpaid days (absent + unpaid leave + half of each half day + days outside the
--    employment), daily staff by the day wage earned, hourly staff by the hours paid. The from-day is
--    the one the overtime check already used (join day for a monthly joiner in this month, else 1).
-- 3. SETTLEMENT-5 (H26). After a rehire, Reopen and Finalize of a settlement whose last working day is
--    before the employee's CURRENT join date are refused (settlement_rehired). The page always computes
--    from the current record, so re-finalizing an earlier spell zeroed its gratuity and marked the
--    working rehire as left, off payroll and locked out. Decided: a correction to an earlier spell is
--    paid by hand and noted. This narrows S791, which let an older settlement be finalized after a rehire.
-- 4. GAP-PAY-STATE-3. Nothing in the database stopped one leaver being paid both the festival allowance
--    and the settlement's festival share; each page checked the other only from what it loaded earlier.
--    Both directions now, under hr_pay_lock(client) so the two cannot pass each other:
--    finalize_final_settlement refuses settlement_festival_paid when festival_pro > 0 and a finalized
--    festival row with an amount sits in the settlement's fiscal year (the page's own festivalAlreadyPaid
--    rule); hr_bonus_rows_guard refuses festival_paid_by_settlement when a festival row with an amount
--    becomes finalized for someone whose finalized settlement in that fiscal year, in the current
--    employment, paid a share (the Festival page's own settledIds rule). The settlement lookup is the
--    DEFINER hr_festival_settled_by(), because the check must not depend on the caller's RLS view (S749).
--    The operator passes it only on INSERT (an Export/Import restore), the H3 shape Stage 3 extends.

-- ── (1) hr_final_settlements_guard: the paid-mark stamp above the operator seam ──────────────────
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

  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
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

-- The amount the operator's paid marks never stored. Never-reopened rows only: net_payout is still the
-- figure that was paid. Runs as the table owner, so the guard's seam lets it through.
UPDATE public.hr_final_settlements
   SET paid_amount = net_payout
 WHERE paid_at IS NOT NULL AND paid_amount IS NULL AND reopened_at IS NULL;

-- ── (2) hr_attendance_on_file: the final month's sheet, tallied the way the engine tallies it ──────
CREATE OR REPLACE FUNCTION public.hr_attendance_on_file(
  p_client_id uuid, p_employee_id uuid, p_bs_year integer, p_bs_month integer,
  p_from_day integer, p_through_day integer)
 RETURNS TABLE(present numeric, half_day numeric, absent numeric, paid_leave numeric,
               unpaid_leave numeric, half_paid_leave numeric, half_unpaid_leave numeric,
               holiday numeric, sum_hours numeric, sum_ot numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    count(*) FILTER (WHERE a.status = 'present')::numeric,
    count(*) FILTER (WHERE a.status = 'half_day')::numeric,
    count(*) FILTER (WHERE a.status = 'absent')::numeric,
    count(*) FILTER (WHERE a.status = 'paid_leave')::numeric,
    count(*) FILTER (WHERE a.status = 'unpaid_leave')::numeric,
    count(*) FILTER (WHERE a.status = 'half_paid_leave')::numeric,
    count(*) FILTER (WHERE a.status = 'half_unpaid_leave')::numeric,
    count(*) FILTER (WHERE a.status = 'holiday')::numeric,
    COALESCE(SUM(COALESCE(a.hours_worked, 0)), 0)::numeric,
    COALESCE(SUM(COALESCE(a.ot_hours, 0)), 0)::numeric
    FROM hr_attendance a
    JOIN monthly_periods mp ON mp.id = a.period_id
   WHERE mp.client_id = p_client_id AND mp.bs_year = p_bs_year AND mp.bs_month = p_bs_month
     AND a.employee_id = p_employee_id
     AND a.bs_day BETWEEN p_from_day AND p_through_day
$function$;

-- Called only from finalize_final_settlement's DEFINER body, like hr_ot_on_file.
REVOKE ALL ON FUNCTION public.hr_attendance_on_file(uuid, uuid, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;

-- ── (3) hr_festival_settled_by: has a settlement already paid this person's festival this year? ────
-- Returns who and when, or NULL. DEFINER and VOLATILE: the guard calls it after taking hr_pay_lock, and
-- it must see a settlement another transaction committed while this one waited for the lock.
CREATE OR REPLACE FUNCTION public.hr_festival_settled_by(p_employee_id uuid, p_bs_year integer, p_bs_month integer)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client uuid;
  v_join date;
  v_name text;
  v_fy integer;
  v_lo date;
  v_hi date;
  v_last date;
BEGIN
  SELECT e.client_id, e.join_date, e.full_name INTO v_client, v_join, v_name
    FROM hr_employees e WHERE e.id = p_employee_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT COALESCE(public.is_admin() OR v_client = public.my_client_id(), false) THEN
    RAISE EXCEPTION 'festival_settlement_check_denied: this employee belongs to another business' USING ERRCODE = '42501';
  END IF;
  -- The fiscal year of the pay month: Shrawan (4) to Ashadh (3).
  v_fy := CASE WHEN p_bs_month >= 4 THEN p_bs_year ELSE p_bs_year - 1 END;
  SELECT b.ad_start INTO v_lo FROM bs_months b WHERE b.bs_year = v_fy AND b.bs_month = 4;
  SELECT b.ad_start + b.days - 1 INTO v_hi FROM bs_months b WHERE b.bs_year = v_fy + 1 AND b.bs_month = 3;
  -- A check that could not run has not passed.
  IF v_lo IS NULL OR v_hi IS NULL THEN
    RAISE EXCEPTION 'festival_settlement_check_calendar: the fiscal year %/% is outside the BS calendar table', v_fy, v_fy + 1;
  END IF;
  SELECT s.last_working_date INTO v_last
    FROM hr_final_settlements s
   WHERE s.employee_id = p_employee_id AND s.client_id = v_client AND s.status = 'finalized'
     AND COALESCE(s.festival_pro, 0) > 0
     AND s.last_working_date BETWEEN v_lo AND v_hi
     -- The current employment only: an earlier spell's settlement does not pay a rehire's festival.
     AND (v_join IS NULL OR s.last_working_date >= v_join)
   ORDER BY s.last_working_date DESC
   LIMIT 1;
  IF v_last IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN COALESCE(NULLIF(btrim(v_name), ''), 'This employee') || ' (last working day ' || v_last::text || ')';
END;
$function$;

REVOKE ALL ON FUNCTION public.hr_festival_settled_by(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hr_festival_settled_by(uuid, integer, integer) TO authenticated, service_role;

-- ── (4) hr_bonus_rows_guard: a festival row cannot be finalized over a settlement's festival share ──
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
$function$;

-- ── (5) reopen_final_settlement: not after a rehire ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reopen_final_settlement(p_settlement_id uuid, p_reason text)
 RETURNS hr_final_settlements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s hr_final_settlements;
  v_written_off text;
  v_join date;
BEGIN
  SELECT * INTO s FROM hr_final_settlements WHERE id = p_settlement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_not_found: this settlement no longer exists';
  END IF;
  IF NOT COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR s.client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'settlement_rank: reopening a settlement needs the Owner or an HR manager' USING ERRCODE = '42501';
  END IF;
  IF NOT public.hr_self_decision_exempt() AND public.hr_is_own_employee(s.employee_id) THEN
    RAISE EXCEPTION 'hr_own_request: you cannot reopen your own settlement — someone else must';
  END IF;
  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'settlement_reopen_reason: say why this settlement is being reopened';
  END IF;

  PERFORM public.hr_pay_lock(s.client_id);
  SELECT * INTO s FROM hr_final_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF s.status <> 'finalized' THEN
    RAISE EXCEPTION 'settlement_not_finalized: this settlement is already a draft — reload the page';
  END IF;

  -- S798 H26 (SETTLEMENT-5): an earlier employment's settlement stays as it was paid once the person
  -- is taken back. Reopening it recomputes it on the NEW spell and re-bans a working login.
  SELECT e.join_date INTO v_join FROM hr_employees e WHERE e.id = s.employee_id;
  IF v_join IS NOT NULL AND v_join > s.last_working_date THEN
    RAISE EXCEPTION 'settlement_rehired: % was taken back on % — this settlement belongs to an earlier employment and cannot be reopened; pay any correction by hand and note it',
      COALESCE(NULLIF(btrim(s.employee_name), ''), 'This employee'), v_join;
  END IF;

  SELECT string_agg(DISTINCT COALESCE(x.purpose, 'Advance'), ', ') INTO v_written_off
    FROM hr_advance_repayments r JOIN hr_advances x ON x.id = r.advance_id
   WHERE r.final_settlement_id = s.id AND x.status = 'written_off';
  IF v_written_off IS NOT NULL THEN
    RAISE EXCEPTION 'settlement_reopen_written_off: an advance this settlement recovered has since been written off (%) — put it back to active in Advances & Loans first', v_written_off;
  END IF;

  DELETE FROM hr_advance_repayments WHERE final_settlement_id = s.id;

  UPDATE hr_tada_claims
     SET status = 'approved', paid_at = NULL, paid_method = NULL, final_settlement_id = NULL
   WHERE final_settlement_id = s.id AND status = 'paid';

  UPDATE auth.users SET banned_until = NULL
   WHERE id IN (SELECT id FROM profiles WHERE settlement_blocked_by = s.id);
  UPDATE profiles SET settlement_blocked_by = NULL WHERE settlement_blocked_by = s.id;

  UPDATE hr_final_settlements
     SET status = 'draft', finalized_at = NULL, advance_recovered = 0, blocked_logins = '{}',
         reopened_at = now(), reopened_by = (select auth.uid()), reopen_reason = btrim(p_reason)
   WHERE id = s.id
  RETURNING * INTO s;
  RETURN s;
END;
$function$;

-- ── (6) finalize_final_settlement: rehire, attendance and festival refusals ──────────────────────
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

-- ── (7) Assertions ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_fin text := (SELECT prosrc FROM pg_proc WHERE oid = 'public.finalize_final_settlement(uuid)'::regprocedure);
BEGIN
  -- Every refusal the live body had, plus the three new ones.
  IF v_fin NOT LIKE '%settlement_salary_paid%' OR v_fin NOT LIKE '%settlement_stale_ot%'
     OR v_fin NOT LIKE '%settlement_month_paid%' OR v_fin NOT LIKE '%settlement_overlap%'
     OR v_fin NOT LIKE '%settlement_stale_advances%' OR v_fin NOT LIKE '%settlement_stale_tada%'
     OR v_fin NOT LIKE '%hr_own_request%' OR v_fin NOT LIKE '%hr_pay_lock%'
     OR v_fin NOT LIKE '%settlement_rehired%' OR v_fin NOT LIKE '%settlement_stale_attendance%'
     OR v_fin NOT LIKE '%settlement_festival_paid%' THEN
    RAISE EXCEPTION 'S798 2a: finalize_final_settlement is missing a refusal';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.reopen_final_settlement(uuid, text)'::regprocedure) NOT LIKE '%settlement_rehired%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.reopen_final_settlement(uuid, text)'::regprocedure) NOT LIKE '%settlement_reopen_written_off%' THEN
    RAISE EXCEPTION 'S798 2a: reopen_final_settlement is missing a refusal';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.hr_bonus_rows_guard()'::regprocedure) NOT LIKE '%festival_paid_by_settlement%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.hr_bonus_rows_guard()'::regprocedure) NOT LIKE '%bonus_finalized%' THEN
    RAISE EXCEPTION 'S798 2a: hr_bonus_rows_guard is missing a refusal';
  END IF;
  -- The stamp must come BEFORE the operator seam.
  IF position('NEW.paid_amount := COALESCE(NEW.paid_amount, OLD.net_payout)' IN
       (SELECT prosrc FROM pg_proc WHERE oid = 'public.hr_final_settlements_guard()'::regprocedure))
     > position('current_user NOT IN' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.hr_final_settlements_guard()'::regprocedure)) THEN
    RAISE EXCEPTION 'S798 2a: the paid-amount stamp is still behind the operator seam';
  END IF;
  -- Guards stay INVOKER (current_user tells a client from a function body); the lookup is DEFINER.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hr_bonus_rows_guard()'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hr_final_settlements_guard()'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hr_festival_settled_by(uuid, integer, integer)'::regprocedure) THEN
    RAISE EXCEPTION 'S798 2a: a function has the wrong SECURITY mode';
  END IF;
  IF has_function_privilege('anon', 'public.hr_festival_settled_by(uuid, integer, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.hr_festival_settled_by(uuid, integer, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.hr_attendance_on_file(uuid, uuid, integer, integer, integer, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.hr_attendance_on_file(uuid, uuid, integer, integer, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S798 2a: a new function has the wrong EXECUTE grants';
  END IF;
  -- H28: a paid, REOPENED settlement with no amount is never guessed; stop and list it instead.
  IF EXISTS (SELECT 1 FROM hr_final_settlements WHERE paid_at IS NOT NULL AND paid_amount IS NULL) THEN
    RAISE EXCEPTION 'S798 2a: % paid settlement(s) still have no paid amount (reopened since the payment) — read the paid figure from audit_logs and fill it by hand: %',
      (SELECT count(*) FROM hr_final_settlements WHERE paid_at IS NOT NULL AND paid_amount IS NULL),
      (SELECT string_agg(id::text || ' ' || COALESCE(employee_name, ''), ', ') FROM hr_final_settlements WHERE paid_at IS NOT NULL AND paid_amount IS NULL);
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
