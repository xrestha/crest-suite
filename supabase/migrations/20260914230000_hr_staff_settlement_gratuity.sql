-- S752 — HR Staff, Final Settlement, Gratuity and HR Reports re-analysed.
--
-- Decisions taken with Aashish (2026-09-14):
--   * "No Access" on a staff page deletes the login; a staff login always carries a rank.
--   * A leaver's final month is paid INSIDE the settlement (the payroll engine's figures, stored on
--     the row), and the SSF / TDS filing sheets read settlements.
--   * The settlement pays the leaver's approved TADA claims.
--   * The Owner and HR managers may Reopen a settlement, with a reason; the employee stays marked as
--     left until it is finalized again.
--   * Nobody below the Owner may approve or write off their OWN leave, overtime or advance.
--   * A staff role list can be changed only by the Owner or that module's manager.
--
-- Sections:
--   (1) is_client_owner(): a POS PIN account is never the Owner
--   (2) monthly_periods: HR-role logins may READ months
--   (3) settings: the staff role lists are fenced
--   (4) self-approval: leave, overtime, advances
--   (5) hr_final_settlements: final-month columns, the lock, Finalize and Reopen functions
--   (6) payroll Finalize and settlement Finalize share one lock and refuse each other's month

-- ── (1) The Owner is the absence of every staff marker — pos_email included ──────────────────────
--
-- A POS PIN account whose pos_role was cleared ("No Access") matched every Owner test: this
-- function, AuthContext's isOwner and admin-user-ops' isCallerOwner all tested pos_role, never the
-- pos_email that makes an account a PIN login. All three now test pos_email too.
CREATE OR REPLACE FUNCTION public.is_client_owner()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT role = 'client'
     AND pos_role IS NULL
     AND pos_email IS NULL
     AND ims_role IS NULL
     AND hr_role IS NULL
     AND COALESCE(hr_self_service, false) = false
  FROM profiles WHERE id = auth.uid()
$$;

-- ── (2) HR-role logins read months ──────────────────────────────────────────────────────────────
--
-- no_hr_role_staff was FOR ALL on monthly_periods, so an HR manager's read of the month came back
-- empty with no error. Final Settlement's "payroll already paid this month" check, the tax-so-far
-- read and the SSF history each join months, so all three passed vacuously for exactly the login
-- that runs them. A month's year and number are not sensitive; writing one still is.
DROP POLICY IF EXISTS no_hr_role_staff ON public.monthly_periods;
DROP POLICY IF EXISTS no_hr_role_staff_insert ON public.monthly_periods;
DROP POLICY IF EXISTS no_hr_role_staff_update ON public.monthly_periods;
DROP POLICY IF EXISTS no_hr_role_staff_delete ON public.monthly_periods;
CREATE POLICY no_hr_role_staff_insert ON public.monthly_periods AS RESTRICTIVE FOR INSERT
  WITH CHECK (NOT public.is_hr_role_staff());
CREATE POLICY no_hr_role_staff_update ON public.monthly_periods AS RESTRICTIVE FOR UPDATE
  USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff());
CREATE POLICY no_hr_role_staff_delete ON public.monthly_periods AS RESTRICTIVE FOR DELETE
  USING (NOT public.is_hr_role_staff());

-- ── (3) The staff role lists ────────────────────────────────────────────────────────────────────
--
-- settings is writable by every same-client login (only Self-Service is fenced), and HR Staff used
-- to re-rank every login on page load to match hr_custom_roles. So a POS waiter could PATCH "Staff"
-- to level manager and the Owner's next visit promoted everyone titled Staff. The page no longer
-- re-ranks on load; this makes the list itself Owner / module-manager only.
CREATE OR REPLACE FUNCTION public.settings_guard_staff_roles()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_old_hr  jsonb := CASE WHEN TG_OP = 'UPDATE' THEN OLD.hr_custom_roles  END;
  v_old_ims jsonb := CASE WHEN TG_OP = 'UPDATE' THEN OLD.ims_custom_roles END;
  v_old_pos jsonb := CASE WHEN TG_OP = 'UPDATE' THEN OLD.pos_custom_roles END;
  v_owner boolean;
  v_me profiles;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;
  IF NEW.hr_custom_roles IS NOT DISTINCT FROM v_old_hr
     AND NEW.ims_custom_roles IS NOT DISTINCT FROM v_old_ims
     AND NEW.pos_custom_roles IS NOT DISTINCT FROM v_old_pos THEN
    RETURN NEW;
  END IF;
  v_owner := COALESCE(public.is_client_owner(), false);
  SELECT * INTO v_me FROM profiles WHERE id = (select auth.uid());
  IF NEW.hr_custom_roles IS DISTINCT FROM v_old_hr AND NOT (v_owner OR COALESCE(v_me.hr_role = 'manager', false)) THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or an HR manager can change the HR role list' USING ERRCODE = '42501';
  END IF;
  IF NEW.ims_custom_roles IS DISTINCT FROM v_old_ims AND NOT (v_owner OR COALESCE(v_me.ims_role = 'manager', false)) THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or an IMS manager can change the IMS role list' USING ERRCODE = '42501';
  END IF;
  IF NEW.pos_custom_roles IS DISTINCT FROM v_old_pos AND NOT (v_owner OR COALESCE(v_me.pos_role = 'manager', false)) THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or a POS manager can change the POS role list' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.settings_guard_staff_roles() FROM PUBLIC;
DROP TRIGGER IF EXISTS settings_guard_staff_roles ON public.settings;
CREATE TRIGGER settings_guard_staff_roles
  BEFORE INSERT OR UPDATE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.settings_guard_staff_roles();

-- ── (4) Self-approval ───────────────────────────────────────────────────────────────────────────
--
-- TADA refused your own claim (S751); leave, overtime and advances did not. A supervisor linked to
-- their own employee record could log and approve their own overtime at 1.5×/2×, approve their own
-- leave, and a manager could issue themselves an advance and write it off. The Owner is exempt (an
-- Owner's decision about their own record has nobody above it) and so is the operator. The Staff
-- app's SECURITY DEFINER RPCs run as the owner and pass.
ALTER TABLE public.hr_leave_requests ADD COLUMN IF NOT EXISTS decided_by uuid;
COMMENT ON COLUMN public.hr_leave_requests.decided_by IS
  'S752: who approved, rejected or cancelled the request — stamped by hr_leave_requests_guard_decision, never sent by the browser.';

CREATE OR REPLACE FUNCTION public.hr_self_decision_exempt()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(public.is_admin() OR public.is_client_owner(), false)
$$;
REVOKE ALL ON FUNCTION public.hr_self_decision_exempt() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_self_decision_exempt() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.hr_leave_requests_guard_decision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'approved' AND NOT public.hr_self_decision_exempt() AND public.hr_is_own_employee(NEW.employee_id) THEN
      RAISE EXCEPTION 'hr_own_request: you cannot approve your own leave — someone else must decide it';
    END IF;
    IF NEW.status IN ('approved', 'rejected', 'cancelled') THEN
      NEW.decided_by := (select auth.uid());
    ELSE
      NEW.decided_by := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    NEW.decided_by := OLD.decided_by;
    RETURN NEW;
  END IF;
  IF NEW.status IN ('approved', 'rejected') AND NOT public.hr_self_decision_exempt()
     AND public.hr_is_own_employee(OLD.employee_id) THEN
    RAISE EXCEPTION 'hr_own_request: you cannot approve or reject your own leave — someone else must decide it';
  END IF;
  IF NEW.status IN ('approved', 'rejected', 'cancelled') THEN
    NEW.decided_by := (select auth.uid());
  ELSE
    NEW.decided_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_leave_requests_guard_decision() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_leave_requests_guard_decision ON public.hr_leave_requests;
CREATE TRIGGER hr_leave_requests_guard_decision
  BEFORE INSERT OR UPDATE ON public.hr_leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.hr_leave_requests_guard_decision();

CREATE OR REPLACE FUNCTION public.hr_overtime_guard_own()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN NEW; END IF;
  IF NEW.status IN ('approved', 'rejected')
     AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status)
     AND NOT public.hr_self_decision_exempt()
     AND public.hr_is_own_employee(NEW.employee_id) THEN
    RAISE EXCEPTION 'hr_own_request: you cannot approve or reject your own overtime — someone else must decide it';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_overtime_guard_own() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_overtime_guard_own ON public.hr_overtime_entries;
CREATE TRIGGER hr_overtime_guard_own
  BEFORE INSERT OR UPDATE ON public.hr_overtime_entries
  FOR EACH ROW EXECUTE FUNCTION public.hr_overtime_guard_own();

CREATE OR REPLACE FUNCTION public.hr_advances_guard_own()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN NEW; END IF;
  IF public.hr_self_decision_exempt() OR NOT public.hr_is_own_employee(NEW.employee_id) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'hr_own_request: you cannot issue an advance to yourself — someone else must record it';
  END IF;
  IF NEW.status = 'written_off' AND OLD.status IS DISTINCT FROM 'written_off' THEN
    RAISE EXCEPTION 'hr_own_request: you cannot write off your own advance — someone else must decide it';
  END IF;
  IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
    RAISE EXCEPTION 'hr_own_request: you cannot change your own advance — someone else must';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_advances_guard_own() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_advances_guard_own ON public.hr_advances;
CREATE TRIGGER hr_advances_guard_own
  BEFORE INSERT OR UPDATE ON public.hr_advances
  FOR EACH ROW EXECUTE FUNCTION public.hr_advances_guard_own();

-- ── (5) Final Settlement ────────────────────────────────────────────────────────────────────────

-- The final month, as the payroll engine computes it (decided: paid inside the settlement). The
-- page used to divide gross by the month's days and stop there: no overtime, no SSF, no CIT and no
-- tax on the month's salary, while still claiming the month's SSF and CIT as tax relief. These are
-- the figures the SSF challan, the TDS sheet and the TDS certificate now read.
ALTER TABLE public.hr_final_settlements
  ADD COLUMN IF NOT EXISTS calc_version                   integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS settle_bs_year                 integer,
  ADD COLUMN IF NOT EXISTS settle_bs_month                integer,
  ADD COLUMN IF NOT EXISTS pay_basis                      text,
  ADD COLUMN IF NOT EXISTS month_gross                    numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS month_allowances               numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS month_unpaid_days              numeric(6,2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS month_absence_deduction        numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS month_ot_hours                 numeric(8,2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS month_ot_amount                numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS month_ssf_employee             numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS month_ssf_employer             numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS month_other_deductions         numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS month_retirement_contribution  numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS month_tds                      numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tada_amount                    numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tada_claim_ids                 uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS leave_days_earned              numeric(6,2),
  ADD COLUMN IF NOT EXISTS festival_months                integer,
  ADD COLUMN IF NOT EXISTS gratuity_ssf_months            integer,
  ADD COLUMN IF NOT EXISTS notice_pay                     numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notice_divisor                 integer,
  ADD COLUMN IF NOT EXISTS advance_recovered              numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_amount                    numeric(12,2),
  ADD COLUMN IF NOT EXISTS reopened_at                    timestamptz,
  ADD COLUMN IF NOT EXISTS reopened_by                    uuid,
  ADD COLUMN IF NOT EXISTS reopen_reason                  text;

COMMENT ON COLUMN public.hr_final_settlements.calc_version IS
  'S752: 1 = computed before the final month ran through the payroll engine (partial_salary only); 2 = month_* figures are the engine''s.';
COMMENT ON COLUMN public.hr_final_settlements.notice_pay IS
  'S752: notice pay the EMPLOYER owes (terminated without notice). notice_deduction is what the employee owes (resigned without serving it).';

-- Which settlement paid a TADA claim, so Reopen puts back exactly those.
ALTER TABLE public.hr_tada_claims
  ADD COLUMN IF NOT EXISTS final_settlement_id uuid REFERENCES public.hr_final_settlements(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_hr_tada_claims_settlement ON public.hr_tada_claims (final_settlement_id);

-- One finalized settlement per employment spell. The page's own check read a list loaded when it
-- opened, and a failed load passed it.
CREATE UNIQUE INDEX IF NOT EXISTS hr_final_settlements_one_finalized_per_spell
  ON public.hr_final_settlements (employee_id, COALESCE(join_date, DATE '1900-01-01'))
  WHERE status = 'finalized';

-- The lock. Nothing refused an UPDATE or DELETE of a finalized settlement: a stale tab's "Update
-- draft", or picking another employee after Finalize, rewrote a paid document, and a delete left its
-- recovery rows behind as hand-entered repayments. Finalize and Reopen go through the two SECURITY
-- DEFINER functions below (current_user is then the owner, so this passes them); a client session
-- may edit a draft, delete a draft, and record a finalized settlement as paid — nothing else.
CREATE OR REPLACE FUNCTION public.hr_final_settlements_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
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
    -- A draft's ledger stamps belong to Finalize/Reopen; the browser's copy of them is ignored.
    NEW.finalized_at := OLD.finalized_at; NEW.advance_recovered := OLD.advance_recovered;
    NEW.paid_at := OLD.paid_at; NEW.paid_method := OLD.paid_method; NEW.paid_amount := OLD.paid_amount;
    NEW.reopened_at := OLD.reopened_at; NEW.reopened_by := OLD.reopened_by; NEW.reopen_reason := OLD.reopen_reason;
    NEW.prior_status := OLD.prior_status; NEW.prior_end_date := OLD.prior_end_date;
    NEW.prior_access_blocked := OLD.prior_access_blocked;
    RETURN NEW;
  END IF;

  -- Finalized: the only change is recording it paid, once.
  IF OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL AND btrim(COALESCE(NEW.paid_method, '')) <> ''
     AND (to_jsonb(NEW) - ARRAY['paid_at', 'paid_method', 'paid_amount'])
       = (to_jsonb(OLD) - ARRAY['paid_at', 'paid_method', 'paid_amount']) THEN
    NEW.paid_amount := OLD.net_payout;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'settlement_finalized: this settlement is finalized — reopen it first';
END;
$$;
REVOKE ALL ON FUNCTION public.hr_final_settlements_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_final_settlements_guard ON public.hr_final_settlements;
CREATE TRIGGER hr_final_settlements_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.hr_final_settlements
  FOR EACH ROW EXECUTE FUNCTION public.hr_final_settlements_guard();

-- The lock payroll Finalize and settlement Finalize share, per client. Two transactions that each
-- checked the other's table before either committed paid Shrawan 2083 twice on 22 Aug (22 seconds
-- apart); whichever takes this lock second now sees the other's commit.
CREATE OR REPLACE FUNCTION public.hr_pay_lock(p_client_id uuid)
RETURNS void
LANGUAGE sql
SET search_path TO 'public'
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('hr_pay:' || p_client_id::text, 0))
$$;
REVOKE ALL ON FUNCTION public.hr_pay_lock(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_pay_lock(uuid) TO authenticated, service_role;

-- Finalize, as ONE transaction. It used to be five browser writes with the checks run before the
-- confirm dialog: a retry after a partial failure recovered no advances (the page's list held
-- active advances only, and the first attempt had just settled them), a stale list was booked as
-- recovered, and payroll could finalize the same month between the check and the flip.
--
-- The page computes the figures and saves them on the draft; this re-reads everything that can have
-- moved since — outstanding advances, approved TADA claims, payroll for the month, another finalized
-- settlement — refuses if any differs, then writes every ledger.
CREATE OR REPLACE FUNCTION public.finalize_final_settlement(p_settlement_id uuid)
RETURNS public.hr_final_settlements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  s hr_final_settlements;
  e hr_employees;
  a record;
  v_outstanding numeric;
  v_claims uuid[];
  v_claim_total numeric;
  v_stored_claims uuid[];
  v_recover numeric;
  v_take numeric;
  v_recovered numeric := 0;
  v_new_status text;
BEGIN
  SELECT * INTO s FROM hr_final_settlements WHERE id = p_settlement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_not_found: this settlement no longer exists';
  END IF;
  IF NOT COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR s.client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'settlement_rank: finalizing a settlement needs the Owner or an HR manager' USING ERRCODE = '42501';
  END IF;

  PERFORM public.hr_pay_lock(s.client_id);
  SELECT * INTO s FROM hr_final_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF s.status <> 'draft' THEN
    RAISE EXCEPTION 'settlement_already_finalized: this settlement was finalized somewhere else — reload the page';
  END IF;
  IF s.calc_version < 2 OR s.settle_bs_year IS NULL OR s.settle_bs_month IS NULL THEN
    RAISE EXCEPTION 'settlement_stale: this draft was calculated by an older version — open it and save it again';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM bs_months b
     WHERE b.bs_year = s.settle_bs_year AND b.bs_month = s.settle_bs_month
       AND s.last_working_date >= b.ad_start AND s.last_working_date < b.ad_start + b.days) THEN
    RAISE EXCEPTION 'settlement_stale: the saved month does not match the last working date — open it and save it again';
  END IF;

  SELECT * INTO e FROM hr_employees WHERE id = s.employee_id AND client_id = s.client_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_employee_missing: this employee record no longer exists';
  END IF;

  IF EXISTS (
    SELECT 1 FROM hr_final_settlements x
     WHERE x.employee_id = s.employee_id AND x.status = 'finalized' AND x.id <> s.id
       AND (e.join_date IS NULL OR x.last_working_date >= e.join_date)) THEN
    RAISE EXCEPTION 'settlement_overlap: this employee already has a finalized settlement for this spell of service — reopen that one instead';
  END IF;

  IF EXISTS (
    SELECT 1 FROM hr_payslips p
      JOIN hr_payroll_runs r ON r.id = p.run_id
      JOIN monthly_periods mp ON mp.id = r.period_id
     WHERE p.employee_id = s.employee_id AND r.status = 'finalized'
       AND mp.bs_year * 12 + mp.bs_month >= s.settle_bs_year * 12 + s.settle_bs_month) THEN
    RAISE EXCEPTION 'settlement_month_paid: a finalized payroll run already pays this employee for the final month or later — reopen that run, or move the last working date';
  END IF;

  SELECT COALESCE(SUM(GREATEST(x.amount - public.hr_advance_repaid(x.id), 0)), 0) INTO v_outstanding
    FROM hr_advances x
   WHERE x.employee_id = s.employee_id AND x.client_id = s.client_id AND x.status = 'active';
  IF abs(v_outstanding - COALESCE(s.advance_deduction, 0)) > 0.01 THEN
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

  -- Recover advances oldest first, capped at what the payout covers. A shortfall stays owed.
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

  -- What the employee looked like before the FIRST finalize. A Reopen leaves the employee marked as
  -- left (decided), so a re-finalize must not overwrite the original with its own stamp.
  UPDATE hr_final_settlements
     SET prior_status = COALESCE(prior_status, e.status),
         prior_end_date = CASE WHEN prior_status IS NULL THEN e.end_date ELSE prior_end_date END,
         prior_access_blocked = COALESCE(prior_access_blocked, e.access_blocked)
   WHERE id = s.id;

  UPDATE hr_employees
     SET status = v_new_status, end_date = s.last_working_date, access_blocked = true
   WHERE id = e.id;

  UPDATE hr_final_settlements
     SET status = 'finalized', finalized_at = now(), advance_recovered = v_recovered
   WHERE id = s.id
  RETURNING * INTO s;
  RETURN s;
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_final_settlement(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_final_settlement(uuid) TO authenticated, service_role;

-- Reopen, as ONE transaction, for the Owner or an HR manager, with a reason (decided). It undoes
-- the advance recoveries and the TADA payments this settlement made. The employee stays marked as
-- left; to cancel the leaving altogether, change their status in Employees.
CREATE OR REPLACE FUNCTION public.reopen_final_settlement(p_settlement_id uuid, p_reason text)
RETURNS public.hr_final_settlements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  s hr_final_settlements;
  v_written_off text;
BEGIN
  SELECT * INTO s FROM hr_final_settlements WHERE id = p_settlement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_not_found: this settlement no longer exists';
  END IF;
  IF NOT COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR s.client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'settlement_rank: reopening a settlement needs the Owner or an HR manager' USING ERRCODE = '42501';
  END IF;
  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'settlement_reopen_reason: say why this settlement is being reopened';
  END IF;

  PERFORM public.hr_pay_lock(s.client_id);
  SELECT * INTO s FROM hr_final_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF s.status <> 'finalized' THEN
    RAISE EXCEPTION 'settlement_not_finalized: this settlement is already a draft — reload the page';
  END IF;

  -- Deleting the recovery from a written-off advance would silently forgive what the settlement
  -- recovered (the status sync leaves written_off alone, and the write-off amount is not restated).
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

  UPDATE hr_final_settlements
     SET status = 'draft', finalized_at = NULL, advance_recovered = 0,
         reopened_at = now(), reopened_by = (select auth.uid()), reopen_reason = btrim(p_reason)
   WHERE id = s.id
  RETURNING * INTO s;
  RETURN s;
END;
$$;
REVOKE ALL ON FUNCTION public.reopen_final_settlement(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reopen_final_settlement(uuid, text) TO authenticated, service_role;

-- A settlement-paid TADA claim goes back to Approved only through Reopen above (a DEFINER body, so
-- the claim guard passes it); a hand-written paid(Final Settlement) → approved is refused by the
-- guard's existing "invalid transition" branch, which only admits paid(Payroll).

-- ── (6) Payroll Finalize refuses a settled employee's month, under the same lock ──────────────────
CREATE OR REPLACE FUNCTION public.hr_run_settled_employee_names(p_run_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT string_agg(DISTINCT COALESCE(s.employee_name, 'an employee'), ', ')
    FROM hr_payroll_runs r
    JOIN monthly_periods mp ON mp.id = r.period_id
    JOIN hr_payslips p ON p.run_id = r.id
    JOIN hr_final_settlements s ON s.employee_id = p.employee_id AND s.status = 'finalized'
   WHERE r.id = p_run_id
     AND COALESCE(public.is_admin() OR r.client_id = public.my_client_id(), false)
     AND s.settle_bs_year IS NOT NULL
     AND mp.bs_year * 12 + mp.bs_month >= s.settle_bs_year * 12 + s.settle_bs_month
$$;
REVOKE ALL ON FUNCTION public.hr_run_settled_employee_names(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_run_settled_employee_names(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.hr_payroll_runs_guard_settled()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_names text;
BEGIN
  IF NEW.status = 'finalized' AND OLD.status IS DISTINCT FROM 'finalized' THEN
    PERFORM public.hr_pay_lock(NEW.client_id);
    IF current_user IN ('anon', 'authenticated') AND NOT COALESCE(public.is_admin(), false) THEN
      v_names := public.hr_run_settled_employee_names(NEW.id);
      IF v_names IS NOT NULL THEN
        RAISE EXCEPTION 'run_has_settled_employee: % already has a finalized Final Settlement that pays this month — regenerate the run without them', v_names;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_payroll_runs_guard_settled() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_payroll_runs_guard_settled ON public.hr_payroll_runs;
CREATE TRIGGER hr_payroll_runs_guard_settled
  BEFORE UPDATE OF status ON public.hr_payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.hr_payroll_runs_guard_settled();

-- ── Assertions ──────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'hr_final_settlements_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'S752: hr_final_settlements_guard is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'settings_guard_staff_roles' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'S752: settings_guard_staff_roles is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'monthly_periods'
              AND policyname = 'no_hr_role_staff') THEN
    RAISE EXCEPTION 'S752: the FOR ALL no_hr_role_staff policy on monthly_periods is still present';
  END IF;
  IF has_function_privilege('anon', 'public.finalize_final_settlement(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reopen_final_settlement(uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.hr_pay_lock(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S752: a new settlement function is anon-executable';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hr_final_settlements_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'S752: hr_final_settlements_guard must be SECURITY INVOKER, or it passes every caller';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.finalize_final_settlement(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'S752: finalize_final_settlement must be SECURITY DEFINER to pass the lock it writes through';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
