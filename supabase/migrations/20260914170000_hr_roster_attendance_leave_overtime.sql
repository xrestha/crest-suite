-- S749 — Staff Roster, Attendance, Leave and Overtime re-analysed.
--
-- Eight changes, each backing a rule the pages already believed they had. Live on 2026-09-14,
-- before this ran: 0 duplicate overtime days, 0 duplicate shift-type names, 0 overlapping open
-- leave requests, 0 leave rows whose `days` disagreed with their dates, 0 finalized payroll runs —
-- so every index and trigger below builds against clean data and changes nothing already stored.

-- ── (1) Writes need HR supervisor rank, on every table these four pages write ──────────────────
--
-- Every one of these tables carried one permissive same-client policy plus the IMS / POS-PIN /
-- Self-Service fences. None of them fenced an HR account by RANK, while all four pages open at
-- supervisor. So an `hr_role = 'staff'` login — which the router sends back to the dashboard — could
-- approve its own leave, approve overtime (pay), rewrite attendance (pay) and repaint the roster
-- straight through PostgREST. The Holiday Calendar had the same hole and was closed in
-- 20260914150000 with exactly this shape; this extends it to the rest of the module's day-to-day
-- tables. RESTRICTIVE, per write command, so reading stays open to every HR rank and every
-- existing permissive policy keeps its shape. Self-Service writes go through SECURITY DEFINER
-- RPCs, whose owner bypasses RLS, so the employee app is unaffected. COALESCE because
-- is_admin() / is_client_owner() are NULL for a profile-less session (supabase-sql.md, S630).
--
-- Written as a loop over format() because it is 24 identical policies. A text scan of this file
-- will not see them by name; verify against pg_policies (query at the bottom).

DO $$
DECLARE
  t text;
  rank_ok constant text :=
    'COALESCE((select public.is_admin()) OR (select public.is_client_owner()) '
    'OR (SELECT p.hr_role FROM public.profiles p WHERE p.id = (select auth.uid())) IN (''supervisor'', ''manager''), false)';
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hr_attendance', 'hr_leave_requests', 'hr_leave_types', 'hr_overtime_entries',
    'hr_roster', 'hr_shift_types', 'hr_shift_swap_requests', 'hr_roster_publish_state'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write_rank_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write_rank_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write_rank_delete', t);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (%s)',
      t || '_write_rank_insert', t, rank_ok);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)',
      t || '_write_rank_update', t, rank_ok, rank_ok);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated USING (%s)',
      t || '_write_rank_delete', t, rank_ok);
  END LOOP;
END $$;

-- ── (2) A month whose payroll is FINALIZED is locked (decided with Aashish, 2026-09-14) ───────
--
-- Clear Month refused on a finalized run (S743) and nothing else did: Save Day, Clear Day, a
-- single cell, Generate from Roster, approving or cancelling leave and every overtime action all
-- still rewrote a month whose payslips were already issued — leaving Payroll Calculation's Stale
-- badge as the only trace. The pages now lock; this is what makes the lock true for a caller that
-- skips the page. Reopening the payroll run unlocks the month.
--
-- The lookup is SECURITY DEFINER so it cannot pass vacuously for a caller whose RLS view of
-- hr_payroll_runs is narrower than its view of attendance, and it checks its caller.
--
-- It also joins the period and the client, and that join is what lets a CASCADE through: deleting
-- a client or a period removes the parent first, so inside the cascade the join finds nothing and
-- the month reads as unlocked. That existence test cannot live in the trigger itself — the first
-- draft of this migration put it there and it passed vacuously on the live verification, because
-- an HR-role account's RLS view of monthly_periods is empty (the S430 fence), so every "does the
-- period still exist?" came back false and a supervisor deleted a paid month's attendance row.

CREATE OR REPLACE FUNCTION public.hr_payroll_finalized_for_period(p_period_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM hr_payroll_runs r
      JOIN monthly_periods p ON p.id = r.period_id
      JOIN clients c ON c.id = p.client_id
     WHERE r.period_id = p_period_id
       AND r.status = 'finalized'
       AND COALESCE(public.is_admin() OR r.client_id = public.my_client_id(), false)
  )
$$;

CREATE OR REPLACE FUNCTION public.hr_payroll_finalized_for_month(p_client_id uuid, p_bs_year int, p_bs_month int)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM hr_payroll_runs r
      JOIN monthly_periods p ON p.id = r.period_id
      JOIN clients c ON c.id = p.client_id
     WHERE p.client_id = p_client_id AND p.bs_year = p_bs_year AND p.bs_month = p_bs_month
       AND r.status = 'finalized'
       AND COALESCE(public.is_admin() OR p_client_id = public.my_client_id(), false)
  )
$$;

REVOKE ALL ON FUNCTION public.hr_payroll_finalized_for_period(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hr_payroll_finalized_for_month(uuid, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_payroll_finalized_for_period(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.hr_payroll_finalized_for_month(uuid, int, int) TO authenticated, service_role;

-- SECURITY INVOKER on purpose: current_user is what lets the service role (Danger Zone) through,
-- and under DEFINER it would be the owner every time (the guard_profiles_privileged_columns seam).
-- A delete cascading from a client or a period is let through by the lookup's own join (above).
-- An employee's delete is not: hr_employees_guard_delete already refuses an employee with
-- finalized payslips, which is every employee with attendance in a finalized month.
CREATE OR REPLACE FUNCTION public.hr_attendance_guard_finalized()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF public.hr_payroll_finalized_for_period(OLD.period_id) THEN
      RAISE EXCEPTION 'hr_month_finalized: payroll for this month is finalized';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF public.hr_payroll_finalized_for_period(NEW.period_id) THEN
      RAISE EXCEPTION 'hr_month_finalized: payroll for this month is finalized';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_overtime_guard_finalized()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF public.hr_payroll_finalized_for_month(OLD.client_id, OLD.bs_year, OLD.bs_month) THEN
      RAISE EXCEPTION 'hr_month_finalized: payroll for this month is finalized';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF public.hr_payroll_finalized_for_month(NEW.client_id, NEW.bs_year, NEW.bs_month) THEN
      RAISE EXCEPTION 'hr_month_finalized: payroll for this month is finalized';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION public.hr_attendance_guard_finalized() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hr_overtime_guard_finalized() FROM PUBLIC;

DROP TRIGGER IF EXISTS hr_attendance_guard_finalized ON public.hr_attendance;
CREATE TRIGGER hr_attendance_guard_finalized
  BEFORE INSERT OR UPDATE OR DELETE ON public.hr_attendance
  FOR EACH ROW EXECUTE FUNCTION public.hr_attendance_guard_finalized();

DROP TRIGGER IF EXISTS hr_overtime_guard_finalized ON public.hr_overtime_entries;
CREATE TRIGGER hr_overtime_guard_finalized
  BEFORE INSERT OR UPDATE OR DELETE ON public.hr_overtime_entries
  FOR EACH ROW EXECUTE FUNCTION public.hr_overtime_guard_finalized();

-- ── (3) One overtime entry per person per day (decided with Aashish, 2026-09-14) ──────────────
--
-- payrollCompute sums every approved entry, so a second entry for the same day — a manager's and
-- the one already logged, or the same form saved twice — paid those hours twice. Two stretches on
-- one day are one entry with the hours added up.
CREATE UNIQUE INDEX IF NOT EXISTS hr_overtime_entries_employee_day_key
  ON public.hr_overtime_entries (employee_id, bs_year, bs_month, bs_day);

-- ── (4) Overtime, shift types and swap decisions are audited ─────────────────────────────────
-- An approved overtime entry is pay and carried no trail at all. Shift types decide what Generate
-- from Roster writes (and a delete used to blank the roster), and a swap approval moves who works
-- a day. hr_roster itself is left out: one row per person per rostered day, repainted in bulk.
DROP TRIGGER IF EXISTS audit_hr_overtime_entries ON public.hr_overtime_entries;
CREATE TRIGGER audit_hr_overtime_entries
  AFTER INSERT OR UPDATE OR DELETE ON public.hr_overtime_entries
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();

DROP TRIGGER IF EXISTS audit_hr_shift_types ON public.hr_shift_types;
CREATE TRIGGER audit_hr_shift_types
  AFTER INSERT OR UPDATE OR DELETE ON public.hr_shift_types
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();

DROP TRIGGER IF EXISTS audit_hr_shift_swap_requests ON public.hr_shift_swap_requests;
CREATE TRIGGER audit_hr_shift_swap_requests
  AFTER INSERT OR UPDATE OR DELETE ON public.hr_shift_swap_requests
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();

-- ── (5) One shift-type name per client, and a type in use cannot be deleted ─────────────────
--
-- Roster.jsx deduplicated shift types BY NAME on every page load and deleted the extras — and
-- hr_roster.shift_type_id is ON DELETE SET NULL, so a manager who added a second "Morning" for the
-- kitchen lost every roster day painted with it the next time anyone opened the board. The page no
-- longer deletes anything on load; this index is what stops the duplicate the dedupe was guarding.
CREATE UNIQUE INDEX IF NOT EXISTS hr_shift_types_client_name_key
  ON public.hr_shift_types (client_id, lower(name));

-- Deleting a type in use blanks those roster days (SET NULL), and Generate from Roster then reads a
-- blank row as a zero-hour marker and writes Off — so a daily-wage employee's rostered working days
-- stopped paying. Decided with Aashish: refuse while in use; untick Active instead.
CREATE OR REPLACE FUNCTION public.hr_shift_types_guard_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id) THEN RETURN OLD; END IF;
  IF EXISTS (SELECT 1 FROM hr_roster WHERE shift_type_id = OLD.id) THEN
    RAISE EXCEPTION 'shift_type_in_use: this shift type is on the roster';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_shift_types_guard_delete() FROM PUBLIC;

DROP TRIGGER IF EXISTS hr_shift_types_guard_delete ON public.hr_shift_types;
CREATE TRIGGER hr_shift_types_guard_delete
  BEFORE DELETE ON public.hr_shift_types
  FOR EACH ROW EXECUTE FUNCTION public.hr_shift_types_guard_delete();

-- ── (6) A leave request's day count comes from its dates, and requests may not overlap ────────
--
-- submit_my_leave_request stored whatever `p_days` the phone sent, so an employee could file ten
-- days of leave counting as half a day against their balance (or as a negative number, adding to
-- it) while approval still marked all ten days paid. `days` is now derived from the dates for every
-- writer: every calendar day in the range, 0.5 for a half day — the rule both forms already show.
--
-- Two open or approved requests over the same days both counted against the balance, and
-- cancelling one deleted attendance days the other still covered, so an approved unpaid leave
-- stopped deducting. Decided with Aashish: refuse the overlap. The Crest operator is exempt so an
-- Export/Import restore of historical rows cannot be refused part-way (restoreClientData breaks a
-- table on its first failing chunk).
CREATE OR REPLACE FUNCTION public.hr_leave_requests_validate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_clash hr_leave_requests;
BEGIN
  IF NEW.start_date IS NULL OR NEW.end_date IS NULL OR NEW.end_date < NEW.start_date THEN
    RAISE EXCEPTION 'leave_dates_invalid: the end date is before the start date';
  END IF;
  IF COALESCE(NEW.day_type, 'full') <> 'full' AND NEW.end_date <> NEW.start_date THEN
    RAISE EXCEPTION 'leave_half_day_range: a half-day request covers one day';
  END IF;
  IF NEW.end_date - NEW.start_date + 1 > 366 THEN
    RAISE EXCEPTION 'leave_range_too_long: a leave request covers at most a year';
  END IF;

  NEW.days := CASE WHEN COALESCE(NEW.day_type, 'full') <> 'full' THEN 0.5
                   ELSE (NEW.end_date - NEW.start_date + 1) END;

  IF NEW.status IN ('pending', 'approved')
     AND NOT COALESCE(public.is_admin(), false) THEN
    -- Serialise per employee so two requests submitted at once cannot both pass.
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
$$;
REVOKE ALL ON FUNCTION public.hr_leave_requests_validate() FROM PUBLIC;

DROP TRIGGER IF EXISTS hr_leave_requests_validate ON public.hr_leave_requests;
CREATE TRIGGER hr_leave_requests_validate
  BEFORE INSERT OR UPDATE OF start_date, end_date, day_type, status, employee_id ON public.hr_leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.hr_leave_requests_validate();

-- The employee's own submit: the leave type must be one of THEIR company's active types. It took
-- any uuid, including an inactive type the manager had retired. `p_days` stays in the signature
-- (a cached bundle still sends it — dropping it would fork the function, supabase-sql.md) and is
-- ignored; the trigger above derives the figure.
CREATE OR REPLACE FUNCTION public.submit_my_leave_request(p_leave_type_id uuid, p_start_date date, p_end_date date, p_days numeric, p_reason text, p_day_type text DEFAULT 'full'::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id uuid;
  v_employee_id uuid;
  v_id uuid;
BEGIN
  SELECT client_id, hr_employee_id INTO v_client_id, v_employee_id
  FROM profiles WHERE id = auth.uid() AND hr_self_service = true;
  IF v_employee_id IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM hr_leave_types
     WHERE id = p_leave_type_id AND client_id = v_client_id AND active IS DISTINCT FROM false
  ) THEN
    RAISE EXCEPTION 'leave_type_invalid: that leave type is not available';
  END IF;

  INSERT INTO hr_leave_requests (client_id, employee_id, leave_type_id, start_date, end_date, days, reason, status, day_type)
  VALUES (v_client_id, v_employee_id, p_leave_type_id, p_start_date, p_end_date, 0,
          left(coalesce(p_reason, ''), 500), 'pending', COALESCE(p_day_type, 'full'))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- ── (7) Approving a shift swap is one transaction ────────────────────────────────────────────
--
-- SwapRequestsPanel ran up to five separate writes from the browser with a hand-rolled rollback,
-- never re-checked that the request was still waiting (a swap the requester had withdrawn could be
-- approved), never checked the two days still carried the shifts the employees agreed to trade,
-- and dropped the error on the final status write — so a same-day swap whose status write failed
-- stayed in the queue, and approving it again swapped the two people straight back.
--
-- SECURITY INVOKER: every RLS policy on hr_roster and hr_shift_swap_requests, the rank policies in
-- (1) included, keeps applying. A write RLS filters out updates zero rows without an error, so each
-- row count is asserted.
CREATE OR REPLACE FUNCTION public.approve_shift_swap(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_req hr_shift_swap_requests;
  v_a   hr_roster;   -- the requester's day
  v_b   hr_roster;   -- the target's day
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
    -- Different days: each day keeps its shift and changes hands. Refused, rather than half-done,
    -- when either person already works the day they would be moving onto.
    IF EXISTS (SELECT 1 FROM hr_roster WHERE client_id = v_req.client_id AND employee_id = v_req.target_employee_id
                 AND bs_year = v_req.bs_year AND bs_month = v_req.bs_month AND bs_day = v_req.requester_bs_day)
       OR EXISTS (SELECT 1 FROM hr_roster WHERE client_id = v_req.client_id AND employee_id = v_req.requester_employee_id
                 AND bs_year = v_req.bs_year AND bs_month = v_req.bs_month AND bs_day = v_req.target_bs_day) THEN
      RAISE EXCEPTION 'swap_day_taken: one of them is already rostered on the other day';
    END IF;
    UPDATE hr_roster SET employee_id = v_req.target_employee_id WHERE id = v_a.id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'swap_not_permitted: the roster could not be changed'; END IF;
    UPDATE hr_roster SET employee_id = v_req.requester_employee_id WHERE id = v_b.id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'swap_not_permitted: the roster could not be changed'; END IF;
  END IF;

  UPDATE hr_shift_swap_requests
     SET status = 'approved', admin_decided_by = (select auth.uid()), admin_decided_at = now()
   WHERE id = p_request_id AND status = 'pending_admin';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'swap_not_permitted: the request could not be updated'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_shift_swap(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_shift_swap(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- Verification ----------------------------------------------------------------------------------
-- Run separately after applying (one read per call):
--   SELECT tablename, policyname FROM pg_policies WHERE policyname LIKE '%_write_rank_%' AND tablename LIKE 'hr_%' ORDER BY 1, 2;  -- 27 incl. holidays
--   SELECT tgrelid::regclass, tgname FROM pg_trigger WHERE tgname IN ('hr_attendance_guard_finalized','hr_overtime_guard_finalized','hr_shift_types_guard_delete','hr_leave_requests_validate','audit_hr_overtime_entries','audit_hr_shift_types','audit_hr_shift_swap_requests');
--   SELECT has_function_privilege('anon', 'public.approve_shift_swap(uuid)', 'EXECUTE');  -- false
-- The behavioural check is a DO block (a probe client, logins at each rank, a finalized run, a swap)
-- ending in RAISE EXCEPTION so nothing is left behind — see CHANGELOG S749 for what it returned.
