-- Two HR gaps confirmed with the user before building:
--   1. Weekly off day was hardcoded to Saturday everywhere (Attendance auto-default, Leave
--      working-day counts, Roster shading) — now a per-client setting.
--   2. Leave requests were always whole days — hr_leave_requests.days already supports 0.5
--      (numeric(5,1)), but nothing let an employee request a half-day, and nothing downstream
--      understood a half-day leave distinctly from the existing generic 'half_day' attendance
--      status (which always deducts 0.5 day's pay regardless of cause). Per the user's explicit
--      choice, a half-day of a PAID leave type must cost nothing (matching a full day of that
--      type), so this adds two new attendance statuses rather than reusing 'half_day'.

-- ── Weekly off day, per client ───────────────────────────────────────────────────────────────
-- 0=Sun..6=Sat. Default 6 (Saturday) keeps every existing client's behavior identical to today.
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS weekly_off_weekday smallint DEFAULT 6 NOT NULL;

-- ── Half-day leave ───────────────────────────────────────────────────────────────────────────
-- Only meaningful for a single-day request (start_date = end_date) — enforced in the UI, not
-- here. First vs second half is purely a record-keeping distinction; payroll only cares about
-- full vs half (see hr_attendance status extension below), so both halves share attendance math.
ALTER TABLE public.hr_leave_requests ADD COLUMN IF NOT EXISTS day_type text DEFAULT 'full' NOT NULL;
ALTER TABLE public.hr_leave_requests ADD CONSTRAINT hr_leave_requests_day_type_check
  CHECK (day_type = ANY (ARRAY['full'::text, 'first_half'::text, 'second_half'::text]));

-- hr_attendance.status gains two statuses so a half-day leave can correctly respect the leave
-- type's paid/unpaid flag — the existing generic 'half_day' status always deducts 0.5 day's pay
-- in payrollCompute.js regardless of cause, which would incorrectly charge an employee for a
-- half-day taken against a paid leave type (e.g. Sick Leave).
ALTER TABLE public.hr_attendance DROP CONSTRAINT hr_attendance_status_check;
ALTER TABLE public.hr_attendance ADD CONSTRAINT hr_attendance_status_check
  CHECK (status = ANY (ARRAY[
    'present'::text, 'absent'::text, 'half_day'::text, 'paid_leave'::text, 'unpaid_leave'::text,
    'weekly_off'::text, 'holiday'::text, 'half_paid_leave'::text, 'half_unpaid_leave'::text
  ]));

-- ── submit_my_leave_request: add p_day_type, default 'full' (no behavior change for existing
-- callers) ───────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_my_leave_request(
    p_leave_type_id uuid, p_start_date date, p_end_date date, p_days numeric, p_reason text,
    p_day_type text DEFAULT 'full'
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_client_id uuid;
  v_employee_id uuid;
  v_id uuid;
BEGIN
  SELECT client_id, hr_employee_id INTO v_client_id, v_employee_id
  FROM profiles WHERE id = auth.uid() AND hr_self_service = true;
  IF v_employee_id IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;

  INSERT INTO hr_leave_requests (client_id, employee_id, leave_type_id, start_date, end_date, days, reason, status, day_type)
  VALUES (v_client_id, v_employee_id, p_leave_type_id, p_start_date, p_end_date, p_days, left(coalesce(p_reason, ''), 500), 'pending', p_day_type)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

NOTIFY pgrst, 'reload schema';
