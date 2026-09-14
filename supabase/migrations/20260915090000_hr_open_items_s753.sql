-- S753 — the S751/S752 open list, closed.
--
-- Decisions taken with Aashish (2026-09-14):
--   * A leaver's staff login (HR, IMS or POS) is BLOCKED when their Final Settlement is finalized,
--     never deleted, so their name stays on everything they recorded. Reopen unblocks it.
--   * The travel-claim (TADA) settings are Owner or HR manager only.
--   * Each payslip remembers the insurance premiums it was taxed with.
--   * Leave ÷26, the 12-month gratuity rule and the exit lump-sum tax stay as they are, pending the
--     accountant.
--
-- Sections:
--   (1) Payroll Finalize and Reopen become database functions (one transaction, under hr_pay_lock)
--   (2) Repayments written by payroll or a settlement can only be written by those functions
--   (3) Final Settlement blocks the leaver's staff logins; nobody finalizes their own settlement
--   (4) Blocking Self-Service access ends it: sessions revoked, every Staff-app RPC refuses
--   (5) settings: the TADA settings are Owner / HR manager only
--   (6) Insurance premiums stored on payslips and settlements; a typed bonus tax is stored as typed
--   (7) log_audit names the person behind an admin-user-ops write

-- ── (1) Payroll Finalize / Reopen ───────────────────────────────────────────────────────────────
--
-- Finalize was five browser writes: flip the run, mark its TADA claims paid, delete and re-insert
-- the advance repayments, settle advances. S751 had to recount payslips after the flip because a
-- Regenerate in another tab could rebuild them in the gap, and a recount compares numbers, not
-- rows. Now the page computes the repayment allocation (the JS engine owns that arithmetic) and this
-- function checks the stored payslips are exactly the set the page checked, then writes every ledger
-- in one transaction under the same lock settlement Finalize takes.
CREATE OR REPLACE FUNCTION public.finalize_payroll_run(p_run_id uuid, p_payslip_ids uuid[], p_repayments jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r hr_payroll_runs;
  v_stored uuid[];
  v_given uuid[];
  v_names text;
  v_mismatch text;
  v_claims uuid[];
  v_marked int := 0;
  e jsonb;
  a hr_advances;
  v_amount numeric;
  v_rows int := 0;
BEGIN
  SELECT * INTO r FROM hr_payroll_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll_run_not_found: this payroll run no longer exists';
  END IF;
  IF NOT COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR r.client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'payroll_rank: finalizing payroll needs the Owner or an HR manager' USING ERRCODE = '42501';
  END IF;

  PERFORM public.hr_pay_lock(r.client_id);
  SELECT * INTO r FROM hr_payroll_runs WHERE id = p_run_id FOR UPDATE;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION 'payroll_already_finalized: this run was finalized somewhere else — reload the page';
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_stored FROM hr_payslips WHERE run_id = r.id;
  SELECT COALESCE(array_agg(x ORDER BY x), '{}') INTO v_given FROM unnest(COALESCE(p_payslip_ids, '{}')) x;
  IF cardinality(v_stored) = 0 THEN
    RAISE EXCEPTION 'payroll_run_empty: this run has no payslips to finalize';
  END IF;
  IF v_stored IS DISTINCT FROM v_given THEN
    RAISE EXCEPTION 'payroll_run_stale: the payslips in this run changed while it was being checked (regenerated in another tab) — reload and finalize again';
  END IF;

  v_names := public.hr_run_settled_employee_names(r.id);
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'run_has_settled_employee: % already has a finalized Final Settlement that pays this month — regenerate the run without them', v_names;
  END IF;

  -- The repayments must add up to each payslip's advance deduction, and name nobody else.
  SELECT string_agg(COALESCE(emp.full_name, 'an employee'), ', ') INTO v_mismatch
    FROM (
      SELECT COALESCE(p.employee_id, x.employee_id) AS employee_id
        FROM (SELECT employee_id, COALESCE(advance_deduction, 0) AS due FROM hr_payslips WHERE run_id = r.id) p
        FULL JOIN (
          SELECT (j->>'employee_id')::uuid AS employee_id, SUM((j->>'amount')::numeric) AS total
            FROM jsonb_array_elements(COALESCE(p_repayments, '[]'::jsonb)) j GROUP BY 1
        ) x ON x.employee_id = p.employee_id
       WHERE abs(COALESCE(p.due, 0) - COALESCE(x.total, 0)) > 0.01
    ) m
    LEFT JOIN hr_employees emp ON emp.id = m.employee_id;
  IF v_mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_repayments_mismatch: the advance recovery for % does not match the payslip — reload and finalize again', v_mismatch;
  END IF;

  UPDATE hr_payroll_runs SET status = 'finalized', finalized_at = now() WHERE id = r.id;

  -- TADA claims first: a claim left Approved after its payroll is finalized is payable twice.
  SELECT COALESCE(array_agg(DISTINCT c), '{}') INTO v_claims
    FROM hr_payslips p, unnest(COALESCE(p.tada_claim_ids, '{}')) c WHERE p.run_id = r.id;
  IF cardinality(v_claims) > 0 THEN
    UPDATE hr_tada_claims SET status = 'paid', paid_at = now(), paid_method = 'Payroll'
     WHERE id = ANY (v_claims) AND client_id = r.client_id AND status = 'approved';
    GET DIAGNOSTICS v_marked = ROW_COUNT;
    IF v_marked < cardinality(v_claims) THEN
      RAISE EXCEPTION 'payroll_tada_changed: % of the % travel claims this payroll pays are no longer Approved (changed in TADA Claims) — regenerate and finalize again', cardinality(v_claims) - v_marked, cardinality(v_claims);
    END IF;
  END IF;

  -- Repayments. The row guard is bypassed inside this SECURITY DEFINER body, so its checks are made
  -- here: the advance belongs to that employee and client, is active, and is owed at least this much.
  DELETE FROM hr_advance_repayments WHERE payroll_run_id = r.id;
  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_repayments, '[]'::jsonb)) LOOP
    v_amount := round((e->>'amount')::numeric, 2);
    CONTINUE WHEN v_amount <= 0;
    SELECT * INTO a FROM hr_advances WHERE id = (e->>'advance_id')::uuid FOR UPDATE;
    IF NOT FOUND OR a.client_id <> r.client_id OR a.employee_id <> (e->>'employee_id')::uuid THEN
      RAISE EXCEPTION 'payroll_repayment_invalid: an advance recovery does not belong to that employee — reload and finalize again';
    END IF;
    IF a.status <> 'active' THEN
      RAISE EXCEPTION 'payroll_repayment_invalid: an advance being recovered is % now — reload and finalize again', a.status;
    END IF;
    IF public.hr_advance_repaid(a.id) + v_amount > a.amount + 0.01 THEN
      RAISE EXCEPTION 'payroll_repayment_invalid: an advance recovery is more than is still owed — reload and finalize again';
    END IF;
    INSERT INTO hr_advance_repayments (client_id, advance_id, employee_id, repaid_date, amount, notes, payroll_run_id)
    VALUES (r.client_id, a.id, a.employee_id, COALESCE((e->>'repaid_date')::date, CURRENT_DATE), v_amount, e->>'notes', r.id);
    v_rows := v_rows + 1;
  END LOOP;

  RETURN jsonb_build_object('payslips', cardinality(v_stored), 'tada_claims', v_marked, 'repayments', v_rows);
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_payroll_run(uuid, uuid[], jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_payroll_run(uuid, uuid[], jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reopen_payroll_run(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r hr_payroll_runs;
  v_written_off text;
  v_claims uuid[];
  v_reverted int := 0;
BEGIN
  SELECT * INTO r FROM hr_payroll_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll_run_not_found: this payroll run no longer exists';
  END IF;
  IF NOT COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR r.client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'payroll_rank: reopening payroll needs the Owner or an HR manager' USING ERRCODE = '42501';
  END IF;

  PERFORM public.hr_pay_lock(r.client_id);
  SELECT * INTO r FROM hr_payroll_runs WHERE id = p_run_id FOR UPDATE;
  IF r.status <> 'finalized' THEN
    RAISE EXCEPTION 'payroll_not_finalized: this run is already a draft — reload the page';
  END IF;

  -- A written-off advance keeps its write-off; its recovery rows are removed like any other, and the
  -- page names it so nobody assumes the loan reopened.
  SELECT string_agg(DISTINCT COALESCE(emp.full_name, 'an employee'), ', ') INTO v_written_off
    FROM hr_advance_repayments rp
    JOIN hr_advances x ON x.id = rp.advance_id
    LEFT JOIN hr_employees emp ON emp.id = x.employee_id
   WHERE rp.payroll_run_id = r.id AND x.status = 'written_off';

  DELETE FROM hr_advance_repayments WHERE payroll_run_id = r.id;   -- the status trigger reactivates

  SELECT COALESCE(array_agg(DISTINCT c), '{}') INTO v_claims
    FROM hr_payslips p, unnest(COALESCE(p.tada_claim_ids, '{}')) c WHERE p.run_id = r.id;
  IF cardinality(v_claims) > 0 THEN
    UPDATE hr_tada_claims SET status = 'approved', paid_at = NULL, paid_method = NULL
     WHERE id = ANY (v_claims) AND client_id = r.client_id AND status = 'paid' AND paid_method = 'Payroll';
    GET DIAGNOSTICS v_reverted = ROW_COUNT;
  END IF;

  UPDATE hr_payroll_runs SET status = 'draft', finalized_at = NULL WHERE id = r.id;

  RETURN jsonb_build_object('written_off', v_written_off, 'tada_claims', cardinality(v_claims), 'tada_reverted', v_reverted);
END;
$$;
REVOKE ALL ON FUNCTION public.reopen_payroll_run(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reopen_payroll_run(uuid) TO authenticated, service_role;

-- ── (2) The recovery ledger ─────────────────────────────────────────────────────────────────────
--
-- A repayment payroll or a settlement wrote could be deleted by a manager over REST (the page
-- locked it; the database did not), turning a recovered advance back into money owed. Only the four
-- SECURITY DEFINER functions above and in S752 write tagged rows now; the operator passes for a
-- restore.
CREATE OR REPLACE FUNCTION public.hr_advance_repayments_guard_ledger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND (OLD.payroll_run_id IS NOT NULL OR OLD.final_settlement_id IS NOT NULL) THEN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id) THEN
      RETURN OLD;   -- a whole-client deletion cascading through
    END IF;
    RAISE EXCEPTION 'repayment_ledger_locked: this repayment was recorded by payroll or a Final Settlement — reopen that instead';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND (NEW.payroll_run_id IS NOT NULL OR NEW.final_settlement_id IS NOT NULL) THEN
    RAISE EXCEPTION 'repayment_ledger_locked: payroll and Final Settlement record their own repayments — use Finalize';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.hr_advance_repayments_guard_ledger() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_advance_repayments_guard_ledger ON public.hr_advance_repayments;
CREATE TRIGGER hr_advance_repayments_guard_ledger
  BEFORE INSERT OR UPDATE OR DELETE ON public.hr_advance_repayments
  FOR EACH ROW EXECUTE FUNCTION public.hr_advance_repayments_guard_ledger();

-- ── (3) Final Settlement: the leaver's staff logins ─────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS settlement_blocked_by uuid REFERENCES public.hr_final_settlements(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.profiles.settlement_blocked_by IS
  'S753: the finalized Final Settlement that blocked this staff login (auth.users.banned_until). Reopen unblocks exactly these.';
CREATE INDEX IF NOT EXISTS idx_profiles_settlement_blocked_by ON public.profiles (settlement_blocked_by) WHERE settlement_blocked_by IS NOT NULL;

ALTER TABLE public.hr_final_settlements
  ADD COLUMN IF NOT EXISTS blocked_logins text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS life_insurance_premium numeric(12,2),
  ADD COLUMN IF NOT EXISTS health_insurance_premium numeric(12,2);

-- Who Finalize will block, for the confirm dialog. profiles is self-only under RLS.
CREATE OR REPLACE FUNCTION public.settlement_linked_logins(p_employee_id uuid)
RETURNS TABLE(full_name text, modules text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(p.full_name, 'a login')::text,
         concat_ws(', ',
           CASE WHEN p.hr_role IS NOT NULL THEN 'HR' END,
           CASE WHEN p.ims_role IS NOT NULL THEN 'IMS' END,
           CASE WHEN p.pos_email IS NOT NULL THEN 'POS' END)::text
    FROM profiles p
    JOIN hr_employees e ON e.id = p.hr_employee_id
   WHERE p.hr_employee_id = p_employee_id
     AND p.client_id = e.client_id
     AND (p.pos_email IS NOT NULL OR p.ims_role IS NOT NULL OR p.hr_role IS NOT NULL)
     AND COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR e.client_id = public.my_client_id()), false)
   ORDER BY 1
$$;
REVOKE ALL ON FUNCTION public.settlement_linked_logins(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settlement_linked_logins(uuid) TO authenticated, service_role;

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
$$;

-- Finalize: the S752 body, plus (a) nobody below the Owner finalizes their own settlement, and
-- (b) the leaver's staff logins are blocked — banned in auth, their sessions revoked — and named on
-- the row. Blocking, not deleting (decided): a deleted login erases the name from every bill, KOT
-- and shift it recorded.
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
$$;
REVOKE ALL ON FUNCTION public.finalize_final_settlement(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_final_settlement(uuid) TO authenticated, service_role;

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
$$;
REVOKE ALL ON FUNCTION public.reopen_final_settlement(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reopen_final_settlement(uuid, text) TO authenticated, service_role;

-- ── (4) Blocking Self-Service access ends it ─────────────────────────────────────────────────────
--
-- access_blocked refused the next PIN login and nothing else: a phone already signed in kept reading
-- payslips and filing leave. Revoking the sessions stops the refresh; the check below stops the
-- access token that is still valid for up to an hour.
CREATE OR REPLACE FUNCTION public.hr_self_service_assert_active()
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM profiles p
      LEFT JOIN hr_employees e ON e.id = p.hr_employee_id
     WHERE p.id = (select auth.uid())
       AND COALESCE(p.hr_self_service, false)
       AND (e.id IS NULL OR COALESCE(e.access_blocked, false))) THEN
    RAISE EXCEPTION 'self_service_blocked: your access to the Staff app has been turned off' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_self_service_assert_active() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_self_service_assert_active() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.hr_employees_revoke_self_service_sessions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF COALESCE(NEW.access_blocked, false) AND NOT COALESCE(OLD.access_blocked, false) THEN
    DELETE FROM auth.sessions
     WHERE user_id IN (SELECT id FROM profiles WHERE hr_employee_id = NEW.id AND COALESCE(hr_self_service, false));
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_employees_revoke_self_service_sessions() FROM PUBLIC;
DROP TRIGGER IF EXISTS hr_employees_revoke_self_service_sessions ON public.hr_employees;
CREATE TRIGGER hr_employees_revoke_self_service_sessions
  AFTER UPDATE OF access_blocked ON public.hr_employees
  FOR EACH ROW EXECUTE FUNCTION public.hr_employees_revoke_self_service_sessions();

-- Every Staff-app RPC calls the check first. Rewritten from the LIVE bodies (S750: re-creating a
-- function from a remembered copy re-creates stale checks), inserting one line after the top-level
-- BEGIN, and asserted afterwards.
DO $$
DECLARE
  f text;
  v_def text;
  v_new text;
  v_fns text[] := ARRAY[
    'public.get_coworker_roster(integer,integer)',
    'public.get_my_client_vendors()',
    'public.get_my_hr_payslips()',
    'public.get_my_leave_requests()',
    'public.get_my_leave_types()',
    'public.get_my_roster_publish_status(integer,integer)',
    'public.get_my_roster(integer,integer)',
    'public.get_my_swap_requests()',
    'public.get_my_tada_claim_items(uuid)',
    'public.get_my_tada_claims()',
    'public.request_shift_swap(uuid,integer,integer,integer,integer,text)',
    'public.respond_shift_swap(uuid,boolean)',
    'public.submit_my_leave_request(uuid,date,date,numeric,text,text)',
    'public.submit_my_tada_claim(text,text,date,date,text,jsonb,text)'
  ];
BEGIN
  FOREACH f IN ARRAY v_fns LOOP
    v_def := pg_get_functiondef(f::regprocedure);
    IF v_def LIKE '%hr_self_service_assert_active%' THEN CONTINUE; END IF;
    -- Some bodies were saved with CRLF line endings, so the break after BEGIN is \r?\n.
    IF v_def !~ E'\\nBEGIN[ \\t]*\\r?\\n' THEN
      RAISE EXCEPTION 'S753: % has no top-level BEGIN line to patch', f;
    END IF;
    v_new := regexp_replace(v_def, E'\\nBEGIN[ \\t]*(\\r?\\n)', E'\nBEGIN\\1  PERFORM public.hr_self_service_assert_active();\\1');
    EXECUTE v_new;
    IF (SELECT prosrc FROM pg_proc WHERE oid = f::regprocedure) NOT LIKE '%hr_self_service_assert_active%' THEN
      RAISE EXCEPTION 'S753: % was not patched', f;
    END IF;
  END LOOP;
END;
$$;

-- ── (5) TADA settings ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.settings_guard_staff_roles()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_is_update constant boolean := TG_OP = 'UPDATE';
  v_owner boolean;
  v_me profiles;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;
  IF NEW.hr_custom_roles  IS NOT DISTINCT FROM (CASE WHEN v_is_update THEN OLD.hr_custom_roles  END)
     AND NEW.ims_custom_roles IS NOT DISTINCT FROM (CASE WHEN v_is_update THEN OLD.ims_custom_roles END)
     AND NEW.pos_custom_roles IS NOT DISTINCT FROM (CASE WHEN v_is_update THEN OLD.pos_custom_roles END)
     AND NEW.tada_vehicle_rates   IS NOT DISTINCT FROM (CASE WHEN v_is_update THEN OLD.tada_vehicle_rates   END)
     AND NEW.tada_purpose_options IS NOT DISTINCT FROM (CASE WHEN v_is_update THEN OLD.tada_purpose_options END)
     AND NEW.tada_start_points    IS NOT DISTINCT FROM (CASE WHEN v_is_update THEN OLD.tada_start_points    END) THEN
    RETURN NEW;
  END IF;
  v_owner := COALESCE(public.is_client_owner(), false);
  SELECT * INTO v_me FROM profiles WHERE id = (select auth.uid());
  IF NEW.hr_custom_roles IS DISTINCT FROM (CASE WHEN v_is_update THEN OLD.hr_custom_roles END)
     AND NOT (v_owner OR COALESCE(v_me.hr_role = 'manager', false)) THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or an HR manager can change the HR role list' USING ERRCODE = '42501';
  END IF;
  IF NEW.ims_custom_roles IS DISTINCT FROM (CASE WHEN v_is_update THEN OLD.ims_custom_roles END)
     AND NOT (v_owner OR COALESCE(v_me.ims_role = 'manager', false)) THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or an IMS manager can change the IMS role list' USING ERRCODE = '42501';
  END IF;
  IF NEW.pos_custom_roles IS DISTINCT FROM (CASE WHEN v_is_update THEN OLD.pos_custom_roles END)
     AND NOT (v_owner OR COALESCE(v_me.pos_role = 'manager', false)) THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or a POS manager can change the POS role list' USING ERRCODE = '42501';
  END IF;
  IF (NEW.tada_vehicle_rates   IS DISTINCT FROM (CASE WHEN v_is_update THEN OLD.tada_vehicle_rates   END)
   OR NEW.tada_purpose_options IS DISTINCT FROM (CASE WHEN v_is_update THEN OLD.tada_purpose_options END)
   OR NEW.tada_start_points    IS DISTINCT FROM (CASE WHEN v_is_update THEN OLD.tada_start_points    END))
     AND NOT (v_owner OR COALESCE(v_me.hr_role = 'manager', false)) THEN
    RAISE EXCEPTION 'tada_settings_rank: only the Owner or an HR manager can change the travel claim settings' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- ── (6) Stored tax inputs ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.hr_payslips
  ADD COLUMN IF NOT EXISTS life_insurance_premium numeric(12,2),
  ADD COLUMN IF NOT EXISTS health_insurance_premium numeric(12,2);
COMMENT ON COLUMN public.hr_payslips.life_insurance_premium IS
  'S753: the annual life insurance premium this payslip''s TDS was computed with. NULL on payslips from before S753 (the certificate then falls back to the employee record).';

ALTER TABLE public.hr_festival_allowances ADD COLUMN IF NOT EXISTS tds_overridden boolean NOT NULL DEFAULT false;
ALTER TABLE public.hr_incentives          ADD COLUMN IF NOT EXISTS tds_overridden boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.hr_festival_allowances.tds_overridden IS
  'S753: the tax on this row was typed or kept by a person, so a changed calculation does not block Finalize.';

-- ── (7) Audit actor for admin-user-ops ──────────────────────────────────────────────────────────
--
-- auth.uid() is NULL under the service role, so every role grant and password reset made through the
-- Edge Function was recorded against nobody. The function now sends x-crest-actor with the verified
-- caller id; only a service-role request is trusted with it, since only the service key can set it
-- and be the service role.
CREATE OR REPLACE FUNCTION public.log_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $$
DECLARE
  _client_id uuid; _client_name text; _user_id uuid; _user_name text; _record_id uuid;
  _old jsonb; _new jsonb; _found_name text;
BEGIN
  _user_id := auth.uid();
  IF _user_id IS NULL AND COALESCE(auth.role(), '') = 'service_role' THEN
    BEGIN
      _user_id := NULLIF(current_setting('request.headers', true)::json->>'x-crest-actor', '')::uuid;
    EXCEPTION WHEN OTHERS THEN
      _user_id := NULL;
    END;
  END IF;
  SELECT full_name INTO _user_name FROM profiles WHERE id = _user_id;

  IF TG_OP = 'DELETE' THEN
    _record_id := OLD.id;
    IF TG_TABLE_NAME IN ('purchase_entries','opening_stock','closing_stock','wastages') THEN
      SELECT client_id INTO _client_id FROM monthly_periods WHERE id = OLD.period_id;
    ELSIF TG_TABLE_NAME = 'clients' THEN
      _client_id := OLD.id; _client_name := OLD.name;
    ELSE _client_id := OLD.client_id; END IF;
  ELSE
    _record_id := NEW.id;
    IF TG_TABLE_NAME IN ('purchase_entries','opening_stock','closing_stock','wastages') THEN
      SELECT client_id INTO _client_id FROM monthly_periods WHERE id = NEW.period_id;
    ELSIF TG_TABLE_NAME = 'clients' THEN
      _client_id := NEW.id; _client_name := NEW.name;
    ELSE _client_id := NEW.client_id; END IF;
  END IF;

  IF TG_TABLE_NAME = 'monthly_periods' AND TG_OP = 'UPDATE' THEN
    IF (OLD.status, OLD.bs_year, OLD.bs_month) IS NOT DISTINCT FROM (NEW.status, NEW.bs_year, NEW.bs_month)
    THEN RETURN NULL; END IF;
  END IF;

  IF TG_TABLE_NAME = 'profiles' AND TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - ARRAY['pos_pin_failed_attempts','pos_pin_locked_until','hr_pin_failed_attempts','hr_pin_locked_until','ims_pin_failed_attempts','ims_pin_locked_until','last_seen_at'])
       = (to_jsonb(NEW) - ARRAY['pos_pin_failed_attempts','pos_pin_locked_until','hr_pin_failed_attempts','hr_pin_locked_until','ims_pin_failed_attempts','ims_pin_locked_until','last_seen_at'])
    THEN RETURN NULL; END IF;
  END IF;

  IF TG_TABLE_NAME = 'pos_orders' AND TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - ARRAY['covers','print_count','comp_print_count','notes'])
       = (to_jsonb(NEW) - ARRAY['covers','print_count','comp_print_count','notes'])
    THEN RETURN NULL; END IF;
  END IF;

  IF _client_id IS NOT NULL THEN
    SELECT name INTO _found_name FROM clients WHERE id = _client_id;
    IF NOT FOUND THEN
      _client_id := NULL;
    ELSIF _client_name IS NULL THEN
      _client_name := _found_name;
    END IF;
  END IF;

  _old := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  _new := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;

  IF TG_TABLE_NAME = 'clients' THEN
    IF _old IS NOT NULL THEN _old := _old - 'pos_device_secret'; END IF;
    IF _new IS NOT NULL THEN _new := _new - 'pos_device_secret'; END IF;
  END IF;

  INSERT INTO audit_logs (client_id, client_name, user_id, user_name, table_name, action, record_id, old_data, new_data)
  VALUES (_client_id, _client_name, _user_id, _user_name, TG_TABLE_NAME, TG_OP, _record_id, _old, _new);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- ── Assertions ──────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.finalize_payroll_run(uuid, uuid[], jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reopen_payroll_run(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.settlement_linked_logins(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S753: a new function is anon-executable';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hr_advance_repayments_guard_ledger()'::regprocedure) THEN
    RAISE EXCEPTION 'S753: hr_advance_repayments_guard_ledger must be SECURITY INVOKER, or it passes every caller';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'hr_advance_repayments_guard_ledger' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'hr_employees_revoke_self_service_sessions' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'S753: a trigger is missing';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.finalize_final_settlement(uuid)'::regprocedure) NOT LIKE '%banned_until%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.reopen_final_settlement(uuid, text)'::regprocedure) NOT LIKE '%settlement_blocked_by%' THEN
    RAISE EXCEPTION 'S753: the settlement functions do not block/unblock logins';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
