-- S791 — A two-day shift swap trades a Day Off the other way instead of refusing.
--
-- Found in hss-suite (batch 4, re-analysis #40), which ported this repo's S749 approve_shift_swap
-- with one deliberate difference; decided for Crest with Aashish, 2026-09-28. A swap across two days
-- was refused whenever either person had ANY roster row on the other's day — and Help tells managers
-- to mark rest days with the zero-hour OFF DAY shift, so the common case ("I work Tuesday, you work
-- Thursday, and each of us is off on the other's day") always failed. Staff whose swaps mostly fail
-- stop asking.
--
-- The rule now (hr_shift_kind):
--   'off'    no shift type, or a zero-hour type with no start time whose name says off or holiday
--            (never leave) — OFF DAY in every client today. It changes hands the other way: the
--            person moving onto a day they had off takes the shift, and their day off goes to the
--            one moving away. No row key moves, so the unique (employee, day) key is never touched.
--   'leave'  a type whose name says leave. Leave is not traded and not overwritten: a swap onto a
--            day someone is on leave is refused, like a working shift.
--   'work'   everything else, including a type with unknown hours ("Split").
-- A request is refused up front (swap_day_taken) when either person works, or is on leave, on the
-- day they would move onto, so staff hear it when they ask rather than days later at approval. And
-- the shift being traded must be a working one on both sides: an OFF DAY or a leave row is not a
-- shift to give away (the Staff app's pickers already hide them; this is the database agreeing).
--
-- Every function is rebuilt from its LIVE body (pg_get_functiondef, 2026-09-28): approve_shift_swap
-- stays SECURITY INVOKER and RETURNS void with its swap_* errors, so errorText.js keeps working.
-- Reverse: re-run approve_shift_swap from 20260914170000 and request_shift_swap from 20260914180000,
-- then DROP FUNCTION public.hr_shift_kind(uuid).

-- ── (1) What a roster row is, for a swap ────────────────────────────────────────────────────────
-- INVOKER: approve_shift_swap runs as the approving manager and reads shift types under their own
-- RLS; request_shift_swap is DEFINER and reads as the owner. A missing type (the row points at
-- nothing) is 'work' — refused as a clash rather than silently overwritten.
CREATE OR REPLACE FUNCTION public.hr_shift_kind(p_shift_type_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_shift_type_id IS NULL THEN 'off'
    ELSE COALESCE((
      SELECT CASE
        WHEN lower(t.name) ~ 'leave' THEN 'leave'
        WHEN COALESCE(t.hours, 0) = 0 AND NULLIF(btrim(COALESCE(t.start_time, '')), '') IS NULL
             AND lower(t.name) ~ '(off|holiday)' THEN 'off'
        ELSE 'work'
      END
      FROM hr_shift_types t WHERE t.id = p_shift_type_id), 'work')
  END
$function$;
REVOKE ALL ON FUNCTION public.hr_shift_kind(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hr_shift_kind(uuid) TO authenticated, service_role;

-- ── (2) Approval ────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_shift_swap(p_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_req hr_shift_swap_requests;
  v_a   hr_roster;   -- the requester's day
  v_b   hr_roster;   -- the target's day
  v_ta  hr_roster;   -- the target's row on the requester's day, if any
  v_rb  hr_roster;   -- the requester's row on the target's day, if any
  v_has_ta boolean;
  v_has_rb boolean;
  v_n   int;
BEGIN
  SELECT * INTO v_req FROM hr_shift_swap_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'swap_not_found: request not found'; END IF;
  IF v_req.status <> 'pending_admin' THEN
    RAISE EXCEPTION 'swap_not_pending: request is %', v_req.status;
  END IF;

  SELECT * INTO v_a FROM hr_roster
   WHERE client_id = v_req.client_id AND employee_id = v_req.requester_employee_id
     AND bs_year = v_req.bs_year AND bs_month = v_req.bs_month AND bs_day = v_req.requester_bs_day
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'swap_shift_missing: the requester is no longer rostered that day'; END IF;
  SELECT * INTO v_b FROM hr_roster
   WHERE client_id = v_req.client_id AND employee_id = v_req.target_employee_id
     AND bs_year = v_req.bs_year AND bs_month = v_req.bs_month AND bs_day = v_req.target_bs_day
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'swap_shift_missing: the coworker is no longer rostered that day'; END IF;

  IF v_a.shift_type_id IS DISTINCT FROM v_req.requester_shift_type_id
     OR v_b.shift_type_id IS DISTINCT FROM v_req.target_shift_type_id THEN
    RAISE EXCEPTION 'swap_shift_changed: the roster changed after the swap was requested';
  END IF;

  IF v_req.requester_bs_day = v_req.target_bs_day THEN
    -- Same day: each keeps their row and they trade shifts. No key moves, so the unique constraint
    -- is never touched — the old browser version parked a row on a sentinel day to get past it.
    UPDATE hr_roster SET shift_type_id = v_b.shift_type_id WHERE id = v_a.id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'swap_not_permitted: the roster could not be changed'; END IF;
    UPDATE hr_roster SET shift_type_id = v_a.shift_type_id WHERE id = v_b.id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'swap_not_permitted: the roster could not be changed'; END IF;
  ELSE
    -- Different days: each day's shift changes hands. The row either person already has on the day
    -- they move onto decides how (S791): none → the shift row moves to them; a Day Off → the two rows
    -- on that day trade shift types, so the day off goes to the one moving away; a working shift or
    -- leave → refused, rather than giving someone two shifts or overwriting their leave.
    SELECT * INTO v_ta FROM hr_roster
     WHERE client_id = v_req.client_id AND employee_id = v_req.target_employee_id
       AND bs_year = v_req.bs_year AND bs_month = v_req.bs_month AND bs_day = v_req.requester_bs_day
     FOR UPDATE;
    v_has_ta := FOUND;
    SELECT * INTO v_rb FROM hr_roster
     WHERE client_id = v_req.client_id AND employee_id = v_req.requester_employee_id
       AND bs_year = v_req.bs_year AND bs_month = v_req.bs_month AND bs_day = v_req.target_bs_day
     FOR UPDATE;
    v_has_rb := FOUND;
    IF (v_has_ta AND public.hr_shift_kind(v_ta.shift_type_id) <> 'off')
       OR (v_has_rb AND public.hr_shift_kind(v_rb.shift_type_id) <> 'off') THEN
      RAISE EXCEPTION 'swap_day_taken: one of them already works, or is on leave, on the other day';
    END IF;

    -- The requester's day: the target takes the requester's shift.
    IF v_has_ta THEN
      UPDATE hr_roster SET shift_type_id = v_ta.shift_type_id WHERE id = v_a.id;   -- requester: day off
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN RAISE EXCEPTION 'swap_not_permitted: the roster could not be changed'; END IF;
      UPDATE hr_roster SET shift_type_id = v_a.shift_type_id WHERE id = v_ta.id;   -- target: the shift
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN RAISE EXCEPTION 'swap_not_permitted: the roster could not be changed'; END IF;
    ELSE
      UPDATE hr_roster SET employee_id = v_req.target_employee_id WHERE id = v_a.id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN RAISE EXCEPTION 'swap_not_permitted: the roster could not be changed'; END IF;
    END IF;

    -- The target's day: the requester takes the target's shift.
    IF v_has_rb THEN
      UPDATE hr_roster SET shift_type_id = v_rb.shift_type_id WHERE id = v_b.id;   -- target: day off
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN RAISE EXCEPTION 'swap_not_permitted: the roster could not be changed'; END IF;
      UPDATE hr_roster SET shift_type_id = v_b.shift_type_id WHERE id = v_rb.id;   -- requester: the shift
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN RAISE EXCEPTION 'swap_not_permitted: the roster could not be changed'; END IF;
    ELSE
      UPDATE hr_roster SET employee_id = v_req.requester_employee_id WHERE id = v_b.id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN RAISE EXCEPTION 'swap_not_permitted: the roster could not be changed'; END IF;
    END IF;
  END IF;

  UPDATE hr_shift_swap_requests
     SET status = 'approved', admin_decided_by = (select auth.uid()), admin_decided_at = now()
   WHERE id = p_request_id AND status = 'pending_admin';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'swap_not_permitted: the request could not be updated'; END IF;
END;
$function$;

-- ── (3) The request ─────────────────────────────────────────────────────────────────────────────
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
  IF EXISTS (
    SELECT 1 FROM hr_shift_swap_requests s
     WHERE s.client_id = v_client_id AND s.bs_year = p_bs_year AND s.bs_month = p_bs_month
       AND s.status IN ('pending_target', 'pending_admin')
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

-- ── (4) Assertions ──────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- approve stays INVOKER (it runs under the approving manager's roster policies); request stays DEFINER.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.approve_shift_swap(uuid)'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.request_shift_swap(uuid, integer, integer, integer, integer, text)'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hr_shift_kind(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'S791: a swap function has the wrong SECURITY mode';
  END IF;
  IF has_function_privilege('anon', 'public.hr_shift_kind(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.hr_shift_kind(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S791: hr_shift_kind has the wrong EXECUTE grants';
  END IF;
  -- The live classifier, on the live types: every OFF DAY is 'off', every LEAVE / PAID LEAVE is
  -- 'leave', and a NULL shift is 'off'.
  IF public.hr_shift_kind(NULL) <> 'off' THEN RAISE EXCEPTION 'S791: a missing shift must be a day off'; END IF;
  IF EXISTS (SELECT 1 FROM hr_shift_types WHERE upper(btrim(name)) = 'OFF DAY' AND COALESCE(hours, 0) = 0
               AND NULLIF(btrim(COALESCE(start_time, '')), '') IS NULL AND public.hr_shift_kind(id) <> 'off')
     OR EXISTS (SELECT 1 FROM hr_shift_types WHERE lower(name) ~ 'leave' AND public.hr_shift_kind(id) <> 'leave') THEN
    RAISE EXCEPTION 'S791: hr_shift_kind misreads a live OFF DAY or leave type';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
