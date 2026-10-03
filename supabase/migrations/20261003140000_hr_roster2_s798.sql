-- S798 stage 3d — a shift's new hours start on a day you pick, and a swap request can no longer get stuck.
-- Findings in docs/hr-review-s798/ROSTER.md, decisions H12 and H23 in HR_TODO.md S798.1, the slice in
-- S798.4. request_shift_swap, respond_shift_swap and get_coworker_roster are rebuilt from their LIVE
-- bodies (read 2026-10-03), not from an older migration.
--
-- 1. ROSTER-1 (H12 (a)). hr_roster stores only shift_type_id, and Generate from Roster reads the shift
--    type as it is when it runs. Shortening "Full Day" from 12 to 11 hours on 15 Kartik therefore paid
--    1-14 Kartik an hour short at month end, and filling in Normal hrs for the first time added
--    overtime to every earlier day not yet generated. Now, when an edit would change what Generate
--    writes and earlier days are still to be generated, Shift Types asks from which day the new values
--    start:
--    - shift_type_days_to_generate(type) counts those days: rostered on or before today in Nepal, no
--      attendance row yet, in a month whose payroll is not finalized.
--    - split_shift_type(...) keeps the type as it is for the days before the chosen day (renamed, for
--      example "Full Day (until 14 Kartik 2083)", and taken out of the picker), makes a new type with
--      the new values under the current name, and moves the roster days from the chosen day on, plus
--      any pending swap that names one of them (approve_shift_swap refuses a swap whose shift changed).
--      With nothing rostered before the chosen day it edits the type in place.
--    - hr_shift_types.replaced_by / replaced_from record the split, so Copy to Next Week puts a copied
--      day on or after replaced_from onto the new type. No foreign key on replaced_by: a restore
--      inserts the table's rows in batches, and a self-reference across two batches would fail.
--    Both functions are SECURITY INVOKER, so the RLS that already decides who edits shift types and
--    the roster (HR supervisor and up, the Owner, the operator) decides here too.
-- 2. ROSTER-3 (H23 (a)). A swap the coworker never answered could not be withdrawn or rejected, and it
--    blocked every other swap of both shifts until the day passed; Crest Staff even offered coworkers
--    who had left. Now:
--    - cancel_my_swap_request(request): the requester withdraws a request still waiting (status
--      'cancelled', which the Staff app already labels Withdrawn).
--    - request_shift_swap offers a swap only with a coworker who can answer it: active or on
--      probation, not blocked, with a Crest Staff login (swap_coworker_unavailable). A request whose
--      earlier day has passed no longer blocks another swap of the same shift (it can never be
--      accepted).
--    - respond_shift_swap refuses to ACCEPT once either day has passed (swap_day_past). Declining a
--      lapsed request is still allowed: it only closes it.
--    - get_coworker_roster lists only the coworkers request_shift_swap would accept.
--    The manager's Shift Swaps tab now also lists and rejects requests waiting on the coworker; that is
--    a page change (the rank-fenced UPDATE it already makes), with no SQL here.
--
-- Data: nothing is rewritten. Live on 2026-10-03 no swap request is pending, and the one shift type
-- with no hours (BLOOM CAFE's "Split") is on no roster day.
-- Reverse: drop the four new functions and the two columns, and re-create the three rebuilt functions
-- from 20261001180000 (get_coworker_roster) and the live bodies of 2026-10-03 (the other two).

-- ── (1) ROSTER-1: a shift's new hours from a chosen day ────────────────────────────────────────────
ALTER TABLE public.hr_shift_types
  ADD COLUMN IF NOT EXISTS replaced_by uuid,
  ADD COLUMN IF NOT EXISTS replaced_from date;

COMMENT ON COLUMN public.hr_shift_types.replaced_by IS
  'S798 3d (ROSTER-1): the shift type that carries this one''s name from replaced_from on (split_shift_type). This row keeps the earlier days at their old hours. No FK, so a restore can insert in any order.';
COMMENT ON COLUMN public.hr_shift_types.replaced_from IS
  'S798 3d: the first day (AD) on the replacing type. Copy to Next Week moves a copied day on or after it onto replaced_by.';

-- Rostered days of this shift type that Generate from Roster may still fill: on or before today in
-- Nepal, no attendance row yet, in a month whose payroll is not finalized (a month with no period yet
-- counts, since Generate can still reach it). first_day / last_day are AD dates for the page to show.
CREATE OR REPLACE FUNCTION public.shift_type_days_to_generate(p_shift_type_id uuid)
 RETURNS TABLE(days integer, first_day date, last_day date)
 LANGUAGE sql
 STABLE SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  WITH st AS (
    SELECT id, client_id FROM hr_shift_types WHERE id = p_shift_type_id
  ), rostered AS (
    SELECT r.employee_id, r.bs_year, r.bs_month, r.bs_day,
           public.bs_to_ad(r.bs_year, r.bs_month, r.bs_day) AS ad, st.client_id
      FROM hr_roster r
      JOIN st ON st.client_id = r.client_id AND r.shift_type_id = st.id
  )
  SELECT count(*)::integer, min(x.ad), max(x.ad)
    FROM rostered x
    LEFT JOIN monthly_periods mp
      ON mp.client_id = x.client_id AND mp.bs_year = x.bs_year AND mp.bs_month = x.bs_month
   WHERE x.ad <= (now() AT TIME ZONE 'Asia/Kathmandu')::date
     AND NOT EXISTS (SELECT 1 FROM hr_payroll_runs pr
                      WHERE pr.client_id = x.client_id AND pr.period_id = mp.id AND pr.status = 'finalized')
     AND NOT EXISTS (SELECT 1 FROM hr_attendance a
                      WHERE a.period_id = mp.id AND a.employee_id = x.employee_id AND a.bs_day = x.bs_day)
$function$;

REVOKE ALL ON FUNCTION public.shift_type_days_to_generate(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shift_type_days_to_generate(uuid) TO authenticated, service_role;

-- One transaction: the old type keeps the days before p_from (renamed p_old_name, out of the picker),
-- a new type takes the edit under p_name, and the roster days and pending swaps from p_from move to it.
-- Returns the id that now carries the edit (the same id when nothing was rostered before p_from).
-- Every write's row count is asserted: a write RLS filters out is 0 rows, not an error.
CREATE OR REPLACE FUNCTION public.split_shift_type(
  p_shift_type_id uuid, p_from_year integer, p_from_month integer, p_from_day integer,
  p_old_name text, p_name text, p_color text, p_start_time text, p_end_time text,
  p_hours numeric, p_regular_hours numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old hr_shift_types;
  v_from date := public.bs_to_ad(p_from_year, p_from_month, p_from_day);
  v_new uuid := gen_random_uuid();
  v_name text := NULLIF(btrim(COALESCE(p_name, '')), '');
  v_old_name text := NULLIF(btrim(COALESCE(p_old_name, '')), '');
  v_n integer;
  v_moved integer;
BEGIN
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'shift_split_bad_day: that day is not in the calendar';
  END IF;
  IF v_name IS NULL OR v_old_name IS NULL THEN
    RAISE EXCEPTION 'shift_split_name: both shift types need a name';
  END IF;

  SELECT * INTO v_old FROM hr_shift_types WHERE id = p_shift_type_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift_split_not_found: shift type not found';
  END IF;
  IF v_old.replaced_by IS NOT NULL THEN
    RAISE EXCEPTION 'shift_split_replaced: this shift type already hands over to another from %', v_old.replaced_from;
  END IF;

  -- Nothing rostered before the chosen day: an ordinary edit of the same type.
  IF NOT EXISTS (SELECT 1 FROM hr_roster r
                  WHERE r.client_id = v_old.client_id AND r.shift_type_id = v_old.id
                    AND (r.bs_year, r.bs_month, r.bs_day) < (p_from_year, p_from_month, p_from_day)) THEN
    UPDATE hr_shift_types
       SET name = v_name, color = COALESCE(p_color, v_old.color),
           start_time = NULLIF(p_start_time, ''), end_time = NULLIF(p_end_time, ''),
           hours = p_hours, regular_hours = p_regular_hours
     WHERE id = v_old.id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'shift_split_not_permitted: the shift type could not be changed'; END IF;
    RETURN v_old.id;
  END IF;

  -- Rename first: the name is unique per client (case-insensitive), and the new type takes it.
  UPDATE hr_shift_types SET name = v_old_name, active = false WHERE id = v_old.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'shift_split_not_permitted: the shift type could not be changed'; END IF;

  INSERT INTO hr_shift_types (id, client_id, name, color, start_time, end_time, hours, regular_hours, sort_order, active)
  VALUES (v_new, v_old.client_id, v_name, COALESCE(p_color, v_old.color), NULLIF(p_start_time, ''),
          NULLIF(p_end_time, ''), p_hours, p_regular_hours, v_old.sort_order, v_old.active);

  UPDATE hr_shift_types SET replaced_by = v_new, replaced_from = v_from WHERE id = v_old.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'shift_split_not_permitted: the shift type could not be changed'; END IF;

  -- The roster from the chosen day on. Counted against what RLS lets this caller see beforehand, so a
  -- row the caller may not move fails the whole split rather than staying on the old hours unseen.
  SELECT count(*) INTO v_n FROM hr_roster r
   WHERE r.client_id = v_old.client_id AND r.shift_type_id = v_old.id
     AND (r.bs_year, r.bs_month, r.bs_day) >= (p_from_year, p_from_month, p_from_day);
  UPDATE hr_roster SET shift_type_id = v_new
   WHERE client_id = v_old.client_id AND shift_type_id = v_old.id
     AND (bs_year, bs_month, bs_day) >= (p_from_year, p_from_month, p_from_day);
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  IF v_moved <> v_n THEN RAISE EXCEPTION 'shift_split_not_permitted: the roster could not be changed'; END IF;

  -- A pending swap names the shift each day carried when it was asked for, and approve_shift_swap
  -- refuses one whose day now carries another type (swap_shift_changed). Keep them in step.
  UPDATE hr_shift_swap_requests SET requester_shift_type_id = v_new
   WHERE client_id = v_old.client_id AND status IN ('pending_target', 'pending_admin')
     AND requester_shift_type_id = v_old.id
     AND (bs_year, bs_month, requester_bs_day) >= (p_from_year, p_from_month, p_from_day);
  UPDATE hr_shift_swap_requests SET target_shift_type_id = v_new
   WHERE client_id = v_old.client_id AND status IN ('pending_target', 'pending_admin')
     AND target_shift_type_id = v_old.id
     AND (bs_year, bs_month, target_bs_day) >= (p_from_year, p_from_month, p_from_day);

  RETURN v_new;
END;
$function$;

REVOKE ALL ON FUNCTION public.split_shift_type(uuid, integer, integer, integer, text, text, text, text, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.split_shift_type(uuid, integer, integer, integer, text, text, text, text, text, numeric, numeric) TO authenticated, service_role;

-- ── (2) ROSTER-3: withdraw, and only coworkers who can answer ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_my_swap_request(p_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_employee_id uuid;
  v_row hr_shift_swap_requests;
BEGIN
  PERFORM public.hr_self_service_assert_active();
  SELECT hr_employee_id INTO v_employee_id FROM profiles WHERE id = auth.uid() AND hr_self_service = true;
  IF v_employee_id IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;

  SELECT * INTO v_row FROM hr_shift_swap_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'swap_not_found: request not found'; END IF;
  IF v_row.requester_employee_id <> v_employee_id THEN RAISE EXCEPTION 'not authorized for this request'; END IF;
  IF v_row.status NOT IN ('pending_target', 'pending_admin') THEN
    RAISE EXCEPTION 'swap_not_pending: request is %', v_row.status;
  END IF;

  UPDATE hr_shift_swap_requests SET status = 'cancelled' WHERE id = p_request_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_my_swap_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_my_swap_request(uuid) TO authenticated, service_role;

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
    RAISE EXCEPTION 'coworker not found';
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
    RAISE EXCEPTION 'you have no shift on that day';
  END IF;

  SELECT shift_type_id INTO v_target_shift FROM hr_roster
    WHERE client_id = v_client_id AND employee_id = p_target_employee_id
      AND bs_year = p_bs_year AND bs_month = p_bs_month AND bs_day = p_target_bs_day;
  IF v_target_shift IS NULL OR public.hr_shift_kind(v_target_shift) <> 'work' THEN
    RAISE EXCEPTION 'coworker has no shift on that day';
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
  IF v_row IS NULL THEN RAISE EXCEPTION 'request not found'; END IF;
  IF v_row.target_employee_id <> v_employee_id THEN RAISE EXCEPTION 'not authorized for this request'; END IF;
  IF v_row.status <> 'pending_target' THEN RAISE EXCEPTION 'request is no longer pending'; END IF;

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

-- Same signature and return columns as 20261001180000, so the grants it holds stay as they are.
CREATE OR REPLACE FUNCTION public.get_coworker_roster(p_bs_year integer, p_bs_month integer)
 RETURNS TABLE(employee_id uuid, full_name text, bs_day integer, shift_type_id uuid, shift_type_name text, shift_kind text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_employee_id uuid;
  v_client_id uuid;
BEGIN
  PERFORM public.hr_self_service_assert_active();
  SELECT hr_employee_id, client_id INTO v_employee_id, v_client_id
  FROM profiles WHERE id = auth.uid() AND hr_self_service = true;
  IF v_employee_id IS NULL THEN RETURN; END IF;

  -- Only coworkers request_shift_swap accepts (S798 3d, H23 (a)): it feeds the swap picker alone.
  RETURN QUERY
    SELECT r.employee_id, e.full_name, r.bs_day, r.shift_type_id, st.name, public.hr_shift_kind(r.shift_type_id)
    FROM hr_roster r
    JOIN hr_roster_publish_state ps
      ON ps.client_id = v_client_id AND ps.bs_year = r.bs_year AND ps.bs_month = r.bs_month AND ps.bs_day = r.bs_day
    JOIN hr_employees e ON e.id = r.employee_id
    LEFT JOIN hr_shift_types st ON st.id = r.shift_type_id
    WHERE r.client_id = v_client_id AND r.bs_year = p_bs_year AND r.bs_month = p_bs_month
      AND r.employee_id <> v_employee_id
      AND e.status IN ('active', 'probation') AND NOT COALESCE(e.access_blocked, false)
      AND EXISTS (SELECT 1 FROM profiles p WHERE p.hr_employee_id = e.id AND p.hr_self_service = true)
    ORDER BY e.full_name, r.bs_day;
END;
$function$;

-- New RPCs: reload the API schema (sent right after the apply on 2026-10-03).
NOTIFY pgrst, 'reload schema';
