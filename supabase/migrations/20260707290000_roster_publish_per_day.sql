-- Live-testing S307's Roster publish feature surfaced a real usability problem: publishing was
-- keyed by whole BS month, so a manager had to finish scheduling the ENTIRE month before any of
-- it could reach staff. This switches hr_roster_publish_state from month-grain to day-grain (one
-- row per published day), so a manager can publish incrementally — a week at a time — as the
-- schedule fills in. Roster.jsx keeps its existing whole-month Publish button (Monthly view) and
-- gains a new one scoped to just the 7 visible days (Weekly view).
--
-- The existing hr_roster_publish_state rows are month-grain test data from this week's own
-- testing — no real customer relies on them yet, and there's no clean way to "expand" a
-- month-level row into per-day rows without porting the whole BS-calendar day-count table into
-- SQL, so they're cleared rather than migrated. Re-publish after this runs.
DELETE FROM public.hr_roster_publish_state;
ALTER TABLE public.hr_roster_publish_state DROP CONSTRAINT hr_roster_publish_state_unique;
ALTER TABLE public.hr_roster_publish_state ADD COLUMN bs_day integer NOT NULL;
ALTER TABLE public.hr_roster_publish_state ADD CONSTRAINT hr_roster_publish_state_unique
  UNIQUE (client_id, bs_year, bs_month, bs_day);

-- ── get_my_roster: gate per-day instead of per-month ────────────────────────────────────────
-- A self-service employee now sees exactly the days that have been published, even if the rest
-- of the month is still draft.
CREATE OR REPLACE FUNCTION public.get_my_roster(p_bs_year integer, p_bs_month integer) RETURNS TABLE(
    bs_day integer, shift_type_name text, shift_start text, shift_end text, note text
) LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_employee_id uuid;
  v_client_id uuid;
BEGIN
  SELECT hr_employee_id, client_id INTO v_employee_id, v_client_id
  FROM profiles WHERE id = auth.uid() AND hr_self_service = true;
  IF v_employee_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
    SELECT r.bs_day, st.name, st.start_time, st.end_time, r.note
    FROM hr_roster r
    JOIN hr_roster_publish_state ps
      ON ps.client_id = v_client_id AND ps.bs_year = r.bs_year AND ps.bs_month = r.bs_month AND ps.bs_day = r.bs_day
    LEFT JOIN hr_shift_types st ON st.id = r.shift_type_id
    WHERE r.employee_id = v_employee_id AND r.bs_year = p_bs_year AND r.bs_month = p_bs_month
    ORDER BY r.bs_day;
END;
$$;

-- ── get_my_roster_publish_status: unchanged meaning — "has anything this month been published"
-- (still the right check for the "your manager hasn't published the schedule yet" message, which
-- should only show when the month is fully untouched, not just partially published).
CREATE OR REPLACE FUNCTION public.get_my_roster_publish_status(p_bs_year integer, p_bs_month integer) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_client_id uuid;
BEGIN
  SELECT client_id INTO v_client_id FROM profiles WHERE id = auth.uid() AND hr_self_service = true;
  IF v_client_id IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1 FROM hr_roster_publish_state
    WHERE client_id = v_client_id AND bs_year = p_bs_year AND bs_month = p_bs_month
  );
END;
$$;

-- ── get_coworker_roster: same per-day gate — a swap can only be requested against a coworker's
-- day that's actually been published.
CREATE OR REPLACE FUNCTION public.get_coworker_roster(p_bs_year integer, p_bs_month integer) RETURNS TABLE(
    employee_id uuid, full_name text, bs_day integer, shift_type_id uuid, shift_type_name text
) LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_employee_id uuid;
  v_client_id uuid;
BEGIN
  SELECT hr_employee_id, client_id INTO v_employee_id, v_client_id
  FROM profiles WHERE id = auth.uid() AND hr_self_service = true;
  IF v_employee_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
    SELECT r.employee_id, e.full_name, r.bs_day, r.shift_type_id, st.name
    FROM hr_roster r
    JOIN hr_roster_publish_state ps
      ON ps.client_id = v_client_id AND ps.bs_year = r.bs_year AND ps.bs_month = r.bs_month AND ps.bs_day = r.bs_day
    JOIN hr_employees e ON e.id = r.employee_id
    LEFT JOIN hr_shift_types st ON st.id = r.shift_type_id
    WHERE r.client_id = v_client_id AND r.bs_year = p_bs_year AND r.bs_month = p_bs_month
      AND r.employee_id <> v_employee_id
    ORDER BY e.full_name, r.bs_day;
END;
$$;

NOTIFY pgrst, 'reload schema';
