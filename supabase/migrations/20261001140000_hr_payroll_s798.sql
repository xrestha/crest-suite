-- S798 stage 2b — Payroll: a run stays in its month, and a payslip's net pay is its own parts.
-- Findings in docs/hr-review-s798/PAYROLL.md, fixes in HR_TODO.md S798.3; owner decision H29 (2026-10-01).
-- Every function below is rebuilt from its LIVE body (read 2026-10-01), not from an older migration.
--
-- 1. PAYROLL-3. hr_payroll_runs_guard_settled fired only BEFORE UPDATE OF status, so an HR manager could
--    PATCH a finalized run's period_id over REST: the payslips, the payments and the month lock all moved
--    with it, the original month opened, and a second run paid it again. An INSERT with status
--    'finalized' made an empty finalized run that locked the month. The trigger is now BEFORE INSERT OR
--    UPDATE with no column list. For a client caller (the seam it already had: anon/authenticated and not
--    the operator), a run starts as a draft with no finalized_at, and its period_id and finalized_at never
--    change directly. No app path changes period_id (Generate inserts a draft; Finalize and Reopen are
--    SECURITY DEFINER and pass the seam, as does an operator restore). The settled-leaver check is kept.
-- 2. PAYROLL-4 (H29). Nothing checked that a draft payslip's net pay equals its parts, so a net_pay
--    PATCHed over REST was finalized, marked paid and put on the bank sheet with nothing flagged. Every
--    writer keeps net = gross + ot_amount − absence_deduction − ssf_employee − other_deductions −
--    advance_deduction − tds + tada_amount (payrollCompute.js computePayslip, payrollData.js
--    buildPayrollRows, PayrollRun.jsx writeTds), to within the half-paisa the engine rounds net to. New
--    hr_payslips_guard_net refuses a payslip off by more than 0.01 (payslip_net_mismatch), operator
--    exempt for a restore; finalize_payroll_run refuses a run holding one and names who. The same
--    identity is payrollData.js payslipNetGap; the three copies change together.
--    H29: count live payslips that fail it first; if any, list them and change nothing. Counted
--    2026-10-01: 13 payslips, none off. The first block below re-counts and refuses to apply if one
--    has appeared since, before anything else in this file runs.

-- ── (0) H29: no live payslip may fail the identity before the trigger goes in ────────────────────
DO $$
DECLARE
  v_list text;
BEGIN
  SELECT string_agg(format('%s, %s %s: net %s, parts %s',
           COALESCE(e.full_name, p.employee_id::text), mp.bs_month, mp.bs_year, p.net_pay,
           COALESCE(p.gross, 0) + COALESCE(p.ot_amount, 0) - COALESCE(p.absence_deduction, 0)
             - COALESCE(p.ssf_employee, 0) - COALESCE(p.other_deductions, 0)
             - COALESCE(p.advance_deduction, 0) - COALESCE(p.tds, 0) + COALESCE(p.tada_amount, 0)), '; ')
    INTO v_list
    FROM hr_payslips p
    JOIN hr_payroll_runs r ON r.id = p.run_id
    LEFT JOIN monthly_periods mp ON mp.id = r.period_id
    LEFT JOIN hr_employees e ON e.id = p.employee_id
   WHERE abs(COALESCE(p.net_pay, 0) - (COALESCE(p.gross, 0) + COALESCE(p.ot_amount, 0) - COALESCE(p.absence_deduction, 0)
           - COALESCE(p.ssf_employee, 0) - COALESCE(p.other_deductions, 0)
           - COALESCE(p.advance_deduction, 0) - COALESCE(p.tds, 0) + COALESCE(p.tada_amount, 0))) > 0.01;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'S798 2b (H29): payslips whose net pay is not their parts — nothing was applied; take these to the owner: %', v_list;
  END IF;
END;
$$;

-- ── (1) hr_payroll_runs_guard_settled: a run starts as a draft and stays in its month ────────────
CREATE OR REPLACE FUNCTION public.hr_payroll_runs_guard_settled()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_names text;
BEGIN
  IF current_user IN ('anon', 'authenticated') AND NOT COALESCE(public.is_admin(), false) THEN
    IF TG_OP = 'INSERT' THEN
      -- S798 PAYROLL-3: an empty finalized run locked the month's attendance and refused every payslip.
      IF NEW.status IS DISTINCT FROM 'draft' OR NEW.finalized_at IS NOT NULL THEN
        RAISE EXCEPTION 'payroll_status_direct: a payroll run starts as a draft and is finalized with Finalize, never created finalized';
      END IF;
    ELSE
      IF (NEW.status = 'finalized') IS DISTINCT FROM (OLD.status = 'finalized')
         OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
        RAISE EXCEPTION 'payroll_status_direct: a payroll run is finalized with Finalize and reopened with Reopen, never by changing its status directly';
      END IF;
      -- S798 PAYROLL-3: moving a run took its payslips, payments and month lock with it and opened the
      -- original month for a second payroll.
      IF NEW.period_id IS DISTINCT FROM OLD.period_id THEN
        RAISE EXCEPTION 'payroll_period_fixed: a payroll run stays in the month it was generated for — delete the draft and generate the other month instead';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'finalized' AND OLD.status IS DISTINCT FROM 'finalized' THEN
    PERFORM public.hr_pay_lock(NEW.client_id);
    IF current_user IN ('anon', 'authenticated') AND NOT COALESCE(public.is_admin(), false) THEN
      v_names := public.hr_run_settled_employee_names(NEW.id);
      IF v_names IS NOT NULL THEN
        RAISE EXCEPTION 'run_has_settled_employee: % left in a finalized Final Settlement that paid their last month itself, so a payslip in this month or a later one pays them twice — if they have rejoined, record their new join date; if the settlement was a mistake, reopen it; otherwise regenerate the run without them', v_names;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS hr_payroll_runs_guard_settled ON public.hr_payroll_runs;
CREATE TRIGGER hr_payroll_runs_guard_settled
  BEFORE INSERT OR UPDATE ON public.hr_payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.hr_payroll_runs_guard_settled();

-- ── (2a) hr_payslips_guard_net: a payslip's net pay is its own parts ─────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_payslips_guard_net()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_parts numeric;
BEGIN
  -- The operator is exempt, so an Export/Import restore writes what the backup holds.
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;
  -- Same identity as payrollData.js payslipNetGap and finalize_payroll_run below.
  v_parts := COALESCE(NEW.gross, 0) + COALESCE(NEW.ot_amount, 0) - COALESCE(NEW.absence_deduction, 0)
           - COALESCE(NEW.ssf_employee, 0) - COALESCE(NEW.other_deductions, 0)
           - COALESCE(NEW.advance_deduction, 0) - COALESCE(NEW.tds, 0) + COALESCE(NEW.tada_amount, 0);
  IF abs(COALESCE(NEW.net_pay, 0) - v_parts) > 0.01 THEN
    RAISE EXCEPTION 'payslip_net_mismatch: this payslip''s net pay (%) is not its pay less its deductions (%) — regenerate the run', NEW.net_pay, round(v_parts, 2);
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.hr_payslips_guard_net() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS hr_payslips_guard_net ON public.hr_payslips;
CREATE TRIGGER hr_payslips_guard_net
  BEFORE INSERT OR UPDATE ON public.hr_payslips
  FOR EACH ROW EXECUTE FUNCTION public.hr_payslips_guard_net();

-- ── (2b) finalize_payroll_run: refuse a run holding a payslip that does not add up ───────────────
-- The live body (read 2026-10-01) with one check added after the settled-leaver check. The trigger
-- above stops a client write; this also catches a row written before it existed or by the operator.
CREATE OR REPLACE FUNCTION public.finalize_payroll_run(p_run_id uuid, p_payslip_ids uuid[], p_repayments jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r hr_payroll_runs;
  v_stored uuid[];
  v_given uuid[];
  v_names text;
  v_mismatch text;
  v_net_off text;
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
    RAISE EXCEPTION 'run_has_settled_employee: % left in a finalized Final Settlement that paid their last month itself, so a payslip in this month or a later one pays them twice — if they have rejoined, record their new join date; if the settlement was a mistake, reopen it; otherwise regenerate the run without them', v_names;
  END IF;

  -- S798 PAYROLL-4: every payslip's net pay must be its own parts (hr_payslips_guard_net's identity).
  SELECT string_agg(COALESCE(emp.full_name, 'an employee'), ', ' ORDER BY emp.full_name) INTO v_net_off
    FROM hr_payslips p
    LEFT JOIN hr_employees emp ON emp.id = p.employee_id
   WHERE p.run_id = r.id
     AND abs(COALESCE(p.net_pay, 0) - (COALESCE(p.gross, 0) + COALESCE(p.ot_amount, 0) - COALESCE(p.absence_deduction, 0)
           - COALESCE(p.ssf_employee, 0) - COALESCE(p.other_deductions, 0)
           - COALESCE(p.advance_deduction, 0) - COALESCE(p.tds, 0) + COALESCE(p.tada_amount, 0))) > 0.01;
  IF v_net_off IS NOT NULL THEN
    RAISE EXCEPTION 'payslip_net_mismatch: the net pay on the payslip of % is not their pay less their deductions — regenerate the run and finalize again', v_net_off;
  END IF;

  -- The repayments must add up to each payslip's advance deduction, to the paisa (S791: it allowed a
  -- paisa of difference), and name nobody else. hr_payslips.advance_deduction is unscaled numeric, so
  -- it is compared at two places; the repayment amounts are rounded the same way as they are written.
  SELECT string_agg(COALESCE(emp.full_name, 'an employee'), ', ') INTO v_mismatch
    FROM (
      SELECT COALESCE(p.employee_id, x.employee_id) AS employee_id
        FROM (SELECT employee_id, COALESCE(advance_deduction, 0) AS due FROM hr_payslips WHERE run_id = r.id) p
        FULL JOIN (
          SELECT (j->>'employee_id')::uuid AS employee_id, SUM(round((j->>'amount')::numeric, 2)) AS total
            FROM jsonb_array_elements(COALESCE(p_repayments, '[]'::jsonb)) j GROUP BY 1
        ) x ON x.employee_id = p.employee_id
       WHERE round(COALESCE(p.due, 0), 2) <> COALESCE(x.total, 0)
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
    -- Exact (S791); it allowed a recovery one paisa over what was owed.
    IF public.hr_advance_repaid(a.id) + v_amount > a.amount THEN
      RAISE EXCEPTION 'payroll_repayment_invalid: an advance recovery is more than is still owed — reload and finalize again';
    END IF;
    -- The Kathmandu date, never the server's UTC date (yesterday in Nepal until 05:45). The page
    -- always sends repaid_date; this is the fallback for a caller that does not (S791).
    INSERT INTO hr_advance_repayments (client_id, advance_id, employee_id, repaid_date, amount, notes, payroll_run_id)
    VALUES (r.client_id, a.id, a.employee_id,
            COALESCE((e->>'repaid_date')::date, (now() AT TIME ZONE 'Asia/Kathmandu')::date),
            v_amount, e->>'notes', r.id);
    v_rows := v_rows + 1;
  END LOOP;

  RETURN jsonb_build_object('payslips', cardinality(v_stored), 'tada_claims', v_marked, 'repayments', v_rows);
END;
$function$;

-- ── Assertions: refuse to finish if the catalog is not what this file meant ──────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.hr_payroll_runs'::regclass AND tgname = 'hr_payroll_runs_guard_settled'
          AND pg_get_triggerdef(oid) LIKE '%BEFORE INSERT OR UPDATE ON public.hr_payroll_runs%')
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.hr_payslips'::regclass AND tgname = 'hr_payslips_guard_net'
          AND pg_get_triggerdef(oid) LIKE '%BEFORE INSERT OR UPDATE ON public.hr_payslips%') THEN
    RAISE EXCEPTION 'S798 2b: a trigger is missing or fires on the wrong events';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.hr_payroll_runs_guard_settled()'::regprocedure) NOT LIKE '%payroll_period_fixed%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.finalize_payroll_run(uuid, uuid[], jsonb)'::regprocedure) NOT LIKE '%payslip_net_mismatch%' THEN
    RAISE EXCEPTION 'S798 2b: a function body was not replaced';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hr_payroll_runs_guard_settled()'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hr_payslips_guard_net()'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.finalize_payroll_run(uuid, uuid[], jsonb)'::regprocedure) THEN
    RAISE EXCEPTION 'S798 2b: a function has the wrong SECURITY mode';
  END IF;
  IF has_function_privilege('anon', 'public.finalize_payroll_run(uuid, uuid[], jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.finalize_payroll_run(uuid, uuid[], jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S798 2b: finalize_payroll_run has the wrong EXECUTE grants';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
