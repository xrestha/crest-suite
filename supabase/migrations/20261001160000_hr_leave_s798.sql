-- S798 stage 2c — Leave: a restore keeps the whole leave history, and a leave type in use cannot be deleted.
-- Findings in docs/hr-review-s798/DATABASE.md, fixes in HR_TODO.md S798.3.
-- hr_leave_requests_validate is rebuilt from its LIVE body (read 2026-10-01), not from an older migration.
--
-- 1. DATABASE-2. The all-holidays refusal had no operator seam, unlike every other HR guard. A request
--    on file whose days all became public holidays later (a holiday added after approval, or a full-day
--    request the S749 recount stored at 0 days) is recounted when a restore inserts it after
--    hr_holiday_calendar, raises leave_all_holidays, and the restore abandons the rest of the table from
--    that 500-row chunk: for a small client, every leave request, so every balance reads the full quota
--    and a leaver is encashed leave already taken. Now an operator INSERT skips only that refusal and
--    stores 0 days; the recount and the date-shape checks still run. Keyed on is_admin(), never on
--    current_user: submit_my_leave_request is SECURITY DEFINER and inserts days = 0, so a current_user
--    seam that keeps stored days would store 0 days on every Crest Staff request. The one side effect is
--    that the operator entering an all-holiday leave from Leave Management gets a 0-day row instead of
--    a refusal, which charges nothing. Counted 2026-10-01: no live pending or approved request falls
--    wholly on holidays, so nothing on file needs repair.
-- 2. DATABASE-3. hr_leave_requests.leave_type_id and hr_final_settlements.leave_type_id are both
--    ON DELETE SET NULL, and nothing guarded the delete. An HR supervisor could delete "Annual Leave"
--    over REST: its requests counted against no balance, a re-added type read the full quota (leave
--    encashed twice at settlement), and an approved paid leave back-filled into a month created later as
--    unpaid. New hr_leave_types_guard_delete, the hr_shift_types_guard_delete shape (S749): refuse while
--    referenced, "untick Active instead". Service-role callers (Danger Zone) and a whole-client delete pass.
--    Counted 2026-10-01: no request or settlement has already lost its type.

-- ── (1) DATABASE-2: an operator insert keeps a request whose days are all public holidays ─────────
CREATE OR REPLACE FUNCTION public.hr_leave_requests_validate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_clash    hr_leave_requests;
  v_calendar int;
  v_holidays int;
BEGIN
  IF NEW.start_date IS NULL OR NEW.end_date IS NULL OR NEW.end_date < NEW.start_date THEN
    RAISE EXCEPTION 'leave_dates_invalid: the end date is before the start date';
  END IF;
  IF COALESCE(NEW.day_type, 'full') <> 'full' AND NEW.end_date <> NEW.start_date THEN
    RAISE EXCEPTION 'leave_half_day_range: a half-day request covers one day';
  END IF;
  v_calendar := NEW.end_date - NEW.start_date + 1;
  IF v_calendar > 366 THEN
    RAISE EXCEPTION 'leave_range_too_long: a leave request covers at most a year';
  END IF;

  -- Public holidays inside the range are not charged (decided 2026-09-14). Only a request that is
  -- still open or approved is recounted and refused; a decided one keeps the figure it was decided on.
  IF NEW.status IN ('pending', 'approved') THEN
    v_holidays := public.hr_public_holiday_count(NEW.client_id, NEW.start_date, NEW.end_date);
    IF v_holidays >= v_calendar THEN
      -- S798 (DATABASE-2): a restore re-inserts requests that were valid when filed; refusing one
      -- abandons the rest of the table. The operator's insert keeps it at 0 days, which charges nothing.
      IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) THEN
        NEW.days := 0;
      ELSE
        RAISE EXCEPTION 'leave_all_holidays: every day in this request is a public holiday';
      END IF;
    ELSE
      NEW.days := CASE WHEN COALESCE(NEW.day_type, 'full') <> 'full' THEN 0.5
                       ELSE v_calendar - v_holidays END;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.days := CASE WHEN COALESCE(NEW.day_type, 'full') <> 'full' THEN 0.5 ELSE v_calendar END;
  END IF;

  IF NEW.status IN ('pending', 'approved')
     AND NOT COALESCE(public.is_admin(), false) THEN
    PERFORM pg_advisory_xact_lock(hashtext('hr_leave_requests:' || NEW.employee_id::text));
    SELECT * INTO v_clash FROM hr_leave_requests o
     WHERE o.employee_id = NEW.employee_id
       AND o.id <> NEW.id
       AND o.status IN ('pending', 'approved')
       AND o.start_date <= NEW.end_date AND NEW.start_date <= o.end_date
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'leave_overlap: overlaps a % request from % to %', v_clash.status, v_clash.start_date, v_clash.end_date;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── (2) DATABASE-3: a leave type in use cannot be deleted ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_leave_types_guard_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id) THEN RETURN OLD; END IF;
  IF EXISTS (SELECT 1 FROM hr_leave_requests WHERE leave_type_id = OLD.id)
     OR EXISTS (SELECT 1 FROM hr_final_settlements WHERE leave_type_id = OLD.id) THEN
    RAISE EXCEPTION 'leave_type_in_use: leave requests or settlements use this leave type';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_leave_types_guard_delete() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS hr_leave_types_guard_delete ON public.hr_leave_types;
CREATE TRIGGER hr_leave_types_guard_delete
  BEFORE DELETE ON public.hr_leave_types
  FOR EACH ROW EXECUTE FUNCTION public.hr_leave_types_guard_delete();
