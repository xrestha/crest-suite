-- S798 stage 2d — Crest Staff and rosters: a draft day reads "not published yet", never "not
-- scheduled", and whether a shift is a day off is one answer, the database's.
-- Findings in docs/hr-review-s798/ROSTER.md and SELF-SERVICE.md, fixes in HR_TODO.md S798.3.
-- get_my_roster and get_coworker_roster are rebuilt from their LIVE bodies (read 2026-10-01), not from
-- an older migration.
--
-- 1. ROSTER-4 / SELF-SERVICE-4. Publishing is per day (20260707290000), but Crest Staff could only ask
--    get_my_roster_publish_status, which answers whether ANY day of the month is published. Once the
--    manager published one week, every still-draft day of that month read "Not scheduled", and on such a
--    day Today said "You are not on the roster for today" over a draft that has the employee working.
--    New get_my_roster_published_days returns the published day numbers, so the app can say "Not
--    published yet" per day. The month-level function stays: a Staff app still running a cached bundle
--    calls it until the new service worker takes over.
-- 2. ATTENDANCE-7 / ROSTER-5. The Staff app decided "day off" by a substring of the shift's name, so a
--    "Coffee Bar", "Back Office" or "Holiday Duty" shift read as a day off and could not be offered for a
--    swap, while request_shift_swap decides with hr_shift_kind (S791: off only for a zero-hour type with
--    no start time named off/holiday; leave by name; everything else work). Both roster reads now return
--    shift_kind = hr_shift_kind(shift_type_id), so the app and the swap rules read one answer. A return
--    column changes, so both functions are dropped and re-created with the grants they hold today
--    (authenticated and service_role; nothing for PUBLIC or anon).
--
-- Nothing here writes data. Reverse: drop get_my_roster_published_days, and re-create get_my_roster and
-- get_coworker_roster without shift_kind (bodies as below, minus the last column) with the same grants.

-- ── (1) ROSTER-4: which days of a month are published ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_roster_published_days(p_bs_year integer, p_bs_month integer)
 RETURNS integer[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id uuid;
BEGIN
  PERFORM public.hr_self_service_assert_active();
  SELECT client_id INTO v_client_id FROM profiles WHERE id = auth.uid() AND hr_self_service = true;
  IF v_client_id IS NULL THEN RETURN ARRAY[]::integer[]; END IF;
  RETURN COALESCE((
    SELECT array_agg(ps.bs_day ORDER BY ps.bs_day)
    FROM hr_roster_publish_state ps
    WHERE ps.client_id = v_client_id AND ps.bs_year = p_bs_year AND ps.bs_month = p_bs_month
  ), ARRAY[]::integer[]);
END;
$function$;
REVOKE ALL ON FUNCTION public.get_my_roster_published_days(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_roster_published_days(integer, integer) TO authenticated, service_role;

-- ── (2) ATTENDANCE-7 / ROSTER-5: the employee's own roster carries the shift's kind ────────────────
DROP FUNCTION IF EXISTS public.get_my_roster(integer, integer);
CREATE FUNCTION public.get_my_roster(p_bs_year integer, p_bs_month integer)
 RETURNS TABLE(bs_day integer, shift_type_name text, shift_start text, shift_end text, note text, shift_kind text)
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

  RETURN QUERY
    SELECT r.bs_day, st.name, st.start_time, st.end_time, r.note, public.hr_shift_kind(r.shift_type_id)
    FROM hr_roster r
    JOIN hr_roster_publish_state ps
      ON ps.client_id = v_client_id AND ps.bs_year = r.bs_year AND ps.bs_month = r.bs_month AND ps.bs_day = r.bs_day
    LEFT JOIN hr_shift_types st ON st.id = r.shift_type_id
    WHERE r.employee_id = v_employee_id AND r.bs_year = p_bs_year AND r.bs_month = p_bs_month
    ORDER BY r.bs_day;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_my_roster(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_roster(integer, integer) TO authenticated, service_role;

-- ── (2) …and so does the coworker roster the swap picker reads ────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_coworker_roster(integer, integer);
CREATE FUNCTION public.get_coworker_roster(p_bs_year integer, p_bs_month integer)
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

  RETURN QUERY
    SELECT r.employee_id, e.full_name, r.bs_day, r.shift_type_id, st.name, public.hr_shift_kind(r.shift_type_id)
    FROM hr_roster r
    JOIN hr_roster_publish_state ps
      ON ps.client_id = v_client_id AND ps.bs_year = r.bs_year AND ps.bs_month = r.bs_month AND ps.bs_day = r.bs_day
    JOIN hr_employees e ON e.id = r.employee_id
    LEFT JOIN hr_shift_types st ON st.id = r.shift_type_id
    WHERE r.client_id = v_client_id AND r.bs_year = p_bs_year AND r.bs_month = p_bs_month
      AND r.employee_id <> v_employee_id
    ORDER BY e.full_name, r.bs_day;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_coworker_roster(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_coworker_roster(integer, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
