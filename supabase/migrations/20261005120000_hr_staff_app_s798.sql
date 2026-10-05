-- S798 stage 4e — Crest Staff: the employee's payslip prints what the Owner's copy prints, and a refused swap
-- says why. Findings SELF-SERVICE-7 and DOCS-7 (docs/hr-review-s798/SELF-SERVICE.md, DOCS.md); the slice is
-- listed in HR_TODO.md S798.5. All three functions are rebuilt from their LIVE bodies (read 2026-10-05), not
-- from an older migration; nothing else in them changes.
--
-- (1) get_my_hr_payslips also returns unpaid_days (S570) and retirement_contribution (S748). Both columns were
--     added to hr_payslips without extending this function, so the employee's copy printed "Absence / Unpaid
--     Leave" with no day count and "Other Deductions" with no CIT note, where the Owner's copy of the same
--     payslip prints both. PayslipBody prints them as soon as they arrive; the page needs no change. The
--     return type changes, so this is DROP and CREATE (CREATE OR REPLACE fails with 42P13), and the DROP takes
--     the grants with it: they are put back as they were (authenticated and service_role, not PUBLIC or anon).
--     hr_self_service_assert_active() still runs first.
-- (2) respond_shift_swap and request_shift_swap raise codes for the refusals the Staff app can reach. They were
--     plain text that no errorText rule matched, so the phone said "That didn't work. Try again", and trying
--     again failed the same way every time:
--       'request not found'                 -> swap_not_found       (an existing staff sentence)
--       'request is no longer pending'      -> swap_not_pending     (an existing staff sentence; a double tap,
--                                                                    or the same request answered on a second phone)
--       'coworker not found'                -> swap_coworker_unavailable (an existing staff sentence)
--       'you have no shift on that day'     -> swap_own_shift_gone       (new sentence)
--       'coworker has no shift on that day' -> swap_coworker_shift_gone  (new sentence)
--     The text after each code is unchanged. 'cannot swap with yourself' and the two 'not authorized' refusals
--     stay as they were: the app cannot reach the first (get_coworker_roster leaves the caller out), and plain
--     'not authorized' already has its sentence.
--
-- On apply nothing reads differently except these messages and the two added payslip columns. Reversal: DROP
-- and re-create get_my_hr_payslips from the S753 body without the two columns (re-grant as below), and put
-- the five plain RAISE texts back.

DROP FUNCTION IF EXISTS public.get_my_hr_payslips();

CREATE OR REPLACE FUNCTION public.get_my_hr_payslips()
 RETURNS TABLE(id uuid, bs_year integer, bs_month integer, run_status text, pay_basis text, basic numeric, allowances numeric, gross numeric, ot_hours numeric, ot_amount numeric, worked_days numeric, hours_worked numeric, present_days numeric, absent_days numeric, absence_deduction numeric, ssf_employee numeric, ssf_employer numeric, other_deductions numeric, advance_deduction numeric, tds numeric, tada_amount numeric, net_pay numeric, full_name text, employee_code text, department text, ssf_no text, ssf_enrolled boolean, unpaid_days numeric, retirement_contribution numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_employee_id uuid;
BEGIN
  PERFORM public.hr_self_service_assert_active();
  SELECT pr.hr_employee_id INTO v_employee_id
    FROM profiles pr WHERE pr.id = auth.uid() AND pr.hr_self_service = true;
  IF v_employee_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
    SELECT p.id, mp.bs_year, mp.bs_month, r.status,
           p.pay_basis, p.basic, p.allowances, p.gross,
           p.ot_hours, p.ot_amount,
           p.worked_days, p.hours_worked, p.present_days, p.absent_days,
           p.absence_deduction, p.ssf_employee, p.ssf_employer,
           p.other_deductions, p.advance_deduction, p.tds,
           p.tada_amount, p.net_pay,
           e.full_name, e.employee_code, e.department, e.ssf_no, e.ssf_enrolled,
           p.unpaid_days, p.retirement_contribution
    FROM hr_payslips p
    JOIN hr_payroll_runs r ON r.id = p.run_id
    JOIN monthly_periods mp ON mp.id = r.period_id
    JOIN hr_employees e ON e.id = p.employee_id
    WHERE p.employee_id = v_employee_id AND r.status = 'finalized'
    ORDER BY mp.bs_year DESC, mp.bs_month DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_my_hr_payslips() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_hr_payslips() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.respond_shift_swap(p_request_id uuid, p_accept boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_employee_id uuid;
  v_row hr_shift_swap_requests;
  v_today date := (now() AT TIME ZONE 'Asia/Kathmandu')::date;
BEGIN
  PERFORM public.hr_self_service_assert_active();
  SELECT hr_employee_id INTO v_employee_id FROM profiles WHERE id = auth.uid() AND hr_self_service = true;
  IF v_employee_id IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;

  SELECT * INTO v_row FROM hr_shift_swap_requests WHERE id = p_request_id FOR UPDATE;
  IF v_row IS NULL THEN RAISE EXCEPTION 'swap_not_found: request not found'; END IF;
  IF v_row.target_employee_id <> v_employee_id THEN RAISE EXCEPTION 'not authorized for this request'; END IF;
  IF v_row.status <> 'pending_target' THEN RAISE EXCEPTION 'swap_not_pending: request is no longer pending'; END IF;

  -- A swap of a day already gone cannot be accepted (S798 3d), as request_shift_swap refuses one.
  -- Declining it is allowed: that only closes it.
  IF p_accept AND (COALESCE(public.bs_to_ad(v_row.bs_year, v_row.bs_month, v_row.requester_bs_day) < v_today, true)
                OR COALESCE(public.bs_to_ad(v_row.bs_year, v_row.bs_month, v_row.target_bs_day) < v_today, true)) THEN
    RAISE EXCEPTION 'swap_day_past: one of those days has already gone';
  END IF;

  UPDATE hr_shift_swap_requests
  SET status = CASE WHEN p_accept THEN 'pending_admin' ELSE 'rejected_by_target' END,
      target_responded_at = now()
  WHERE id = p_request_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.request_shift_swap(p_target_employee_id uuid, p_bs_year integer, p_bs_month integer, p_my_bs_day integer, p_target_bs_day integer, p_note text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id uuid;
  v_employee_id uuid;
  v_my_shift uuid;
  v_target_shift uuid;
  v_today date := (now() AT TIME ZONE 'Asia/Kathmandu')::date;
  v_id uuid;
BEGIN
  PERFORM public.hr_self_service_assert_active();
  SELECT client_id, hr_employee_id INTO v_client_id, v_employee_id
  FROM profiles WHERE id = auth.uid() AND hr_self_service = true;
  IF v_employee_id IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF p_target_employee_id = v_employee_id THEN RAISE EXCEPTION 'cannot swap with yourself'; END IF;

  IF NOT EXISTS (SELECT 1 FROM hr_employees WHERE id = p_target_employee_id AND client_id = v_client_id) THEN
    RAISE EXCEPTION 'swap_coworker_unavailable: coworker not found';
  END IF;

  -- Only a coworker who can answer (S798 3d, H23 (a)): on the staff list, not blocked, and with a
  -- Crest Staff login. A request to anyone else waited for good and blocked both shifts.
  IF NOT EXISTS (
    SELECT 1 FROM hr_employees e
     WHERE e.id = p_target_employee_id AND e.client_id = v_client_id
       AND e.status IN ('active', 'probation') AND NOT COALESCE(e.access_blocked, false)
       AND EXISTS (SELECT 1 FROM profiles p WHERE p.hr_employee_id = e.id AND p.hr_self_service = true)
  ) THEN
    RAISE EXCEPTION 'swap_coworker_unavailable: that coworker cannot answer a swap in the Staff app';
  END IF;

  -- A day already gone cannot be swapped. NULL (outside the calendar table) is refused too.
  IF COALESCE(public.bs_to_ad(p_bs_year, p_bs_month, p_my_bs_day) < v_today, true)
     OR COALESCE(public.bs_to_ad(p_bs_year, p_bs_month, p_target_bs_day) < v_today, true) THEN
    RAISE EXCEPTION 'swap_day_past: one of those days has already gone';
  END IF;

  -- Only published days: an employee must not be able to discover or trade a draft roster.
  IF NOT EXISTS (SELECT 1 FROM hr_roster_publish_state WHERE client_id = v_client_id
                   AND bs_year = p_bs_year AND bs_month = p_bs_month AND bs_day = p_my_bs_day)
     OR NOT EXISTS (SELECT 1 FROM hr_roster_publish_state WHERE client_id = v_client_id
                   AND bs_year = p_bs_year AND bs_month = p_bs_month AND bs_day = p_target_bs_day) THEN
    RAISE EXCEPTION 'swap_day_unpublished: that day''s roster has not been published';
  END IF;

  -- The shifts being traded must be working shifts (S791): a Day Off or a leave row is not a shift
  -- to give away. Same wording as "no row at all", which is what the employee sees either way.
  SELECT shift_type_id INTO v_my_shift FROM hr_roster
    WHERE client_id = v_client_id AND employee_id = v_employee_id
      AND bs_year = p_bs_year AND bs_month = p_bs_month AND bs_day = p_my_bs_day;
  IF v_my_shift IS NULL OR public.hr_shift_kind(v_my_shift) <> 'work' THEN
    RAISE EXCEPTION 'swap_own_shift_gone: you have no shift on that day';
  END IF;

  SELECT shift_type_id INTO v_target_shift FROM hr_roster
    WHERE client_id = v_client_id AND employee_id = p_target_employee_id
      AND bs_year = p_bs_year AND bs_month = p_bs_month AND bs_day = p_target_bs_day;
  IF v_target_shift IS NULL OR public.hr_shift_kind(v_target_shift) <> 'work' THEN
    RAISE EXCEPTION 'swap_coworker_shift_gone: coworker has no shift on that day';
  END IF;

  -- Across two days, each person must be free on the day they would move onto: no row, or a Day Off
  -- (which changes hands the other way at approval). Refused here so the employee hears it when they
  -- ask, not days later when a manager approves (S791). A missing row counts as free.
  IF p_my_bs_day <> p_target_bs_day THEN
    IF EXISTS (SELECT 1 FROM hr_roster x
                WHERE x.client_id = v_client_id AND x.employee_id = p_target_employee_id
                  AND x.bs_year = p_bs_year AND x.bs_month = p_bs_month AND x.bs_day = p_my_bs_day
                  AND public.hr_shift_kind(x.shift_type_id) <> 'off')
       OR EXISTS (SELECT 1 FROM hr_roster x
                WHERE x.client_id = v_client_id AND x.employee_id = v_employee_id
                  AND x.bs_year = p_bs_year AND x.bs_month = p_bs_month AND x.bs_day = p_target_bs_day
                  AND public.hr_shift_kind(x.shift_type_id) <> 'off') THEN
      RAISE EXCEPTION 'swap_day_taken: one of you already works, or is on leave, on the other day';
    END IF;
  END IF;

  -- One open request per shift: a second one for a day already being traded could be approved
  -- after the first had moved the shift, and approve_shift_swap would then refuse it anyway.
  -- A request whose earlier day has passed no longer counts (S798 3d): respond_shift_swap will not
  -- let it be accepted, so it only ever blocked the shift until its other day passed too.
  IF EXISTS (
    SELECT 1 FROM hr_shift_swap_requests s
     WHERE s.client_id = v_client_id AND s.bs_year = p_bs_year AND s.bs_month = p_bs_month
       AND s.status IN ('pending_target', 'pending_admin')
       AND COALESCE(public.bs_to_ad(s.bs_year, s.bs_month, LEAST(s.requester_bs_day, s.target_bs_day)) >= v_today, true)
       AND ((s.requester_employee_id = v_employee_id AND s.requester_bs_day = p_my_bs_day)
         OR (s.target_employee_id = v_employee_id AND s.target_bs_day = p_my_bs_day)
         OR (s.requester_employee_id = p_target_employee_id AND s.requester_bs_day = p_target_bs_day)
         OR (s.target_employee_id = p_target_employee_id AND s.target_bs_day = p_target_bs_day))
  ) THEN
    RAISE EXCEPTION 'swap_already_requested: one of those shifts already has a swap waiting';
  END IF;

  INSERT INTO hr_shift_swap_requests (
    client_id, requester_employee_id, target_employee_id, bs_year, bs_month,
    requester_bs_day, target_bs_day, requester_shift_type_id, target_shift_type_id, note, status
  ) VALUES (
    v_client_id, v_employee_id, p_target_employee_id, p_bs_year, p_bs_month,
    p_my_bs_day, p_target_bs_day, v_my_shift, v_target_shift, left(coalesce(p_note, ''), 500), 'pending_target'
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

NOTIFY pgrst, 'reload schema';
