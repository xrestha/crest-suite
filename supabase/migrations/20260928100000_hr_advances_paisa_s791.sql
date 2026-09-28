-- S791 — Advances are recovered to the paisa, and Reopen cannot undo a write-off.
--
-- Two defects hss-suite found in its copy of this engine and filed in docs/CROSS-REPO.md (2026-09-26/27):
--
--   (a) One paisa of slack everywhere an advance was compared (hss MD decision D3). The status trigger
--       settled an advance with Rs. 0.01 or less outstanding, so a one-paisa remainder was marked
--       repaid and never recovered; and it reactivated only above 0.01, so a Reopen that removed a
--       one-paisa last cut left the advance settled for ever. The same 0.01 sat in the repayment and
--       advance guards and in finalize_payroll_run's re-checks. Every amount here is numeric(12,2),
--       so the comparisons are made exactly. The page moved to whole paisa in the same session
--       (payrollData.js buildAdvanceMap / recoverableAdvance / allocateAdvanceRepayments).
--
--   (b) Reopen could undo a write-off. reopen_payroll_run deleted the run's repayment rows and let a
--       written-off advance keep its write-off, so the unrecovered balance quietly grew by what the run
--       had taken — money forgiven that nobody decided to forgive. It now refuses, naming the advance,
--       until the advance is put back into recovery (Advances & Loans → Reactivate), the rule
--       reopen_final_settlement has had since S753. And a client could flip a finalized run back to
--       draft (or a draft to finalized) with a direct UPDATE, skipping every ledger step both
--       functions exist to perform; hr_payroll_runs_guard_settled now refuses that for any client
--       caller, so Finalize and Reopen are the only ways across.
--
--   (c) Hygiene, from the CURRENT_DATE sweep (hss-suite batch 3, re-analysis #29): CURRENT_DATE is the
--       UTC date, i.e. yesterday in Nepal from 00:00 to 05:45. finalize_payroll_run's repayment-date
--       fallback and payable_payments.paid_at's default now take the Kathmandu date. Neither was
--       reachable in practice (the pages always send the date), so no stored row is affected.
--
-- Every function is rebuilt from its LIVE body (pg_get_functiondef, 2026-09-28), changing only the
-- lines named. Reverse: re-run the bodies from 20260914210000 (the two advance guards and the status
-- trigger, as amended by 20260914220000 for hr_advances_guard), 20260915090000 (finalize / reopen
-- payroll) and 20260914230000 (hr_payroll_runs_guard_settled), and set the payable_payments default
-- back to CURRENT_DATE.
--
-- Sections:
--   (1) hr_advance_repayments_sync_status — settle at exact coverage, reactivate on any paisa owed
--   (2) hr_advance_repayments_guard       — a repayment may not exceed what is owed by any amount
--   (3) hr_advances_guard                 — the three owed / nothing-owed tests, exact
--   (4) finalize_payroll_run              — exact allocation re-check and cap; Kathmandu date fallback
--   (5) reopen_payroll_run                — refuses over a write-off; locks the advances it touches
--   (6) hr_payroll_runs_guard_settled     — no direct status change across 'finalized'
--   (4)+(6) also carry the new run_has_settled_employee wording (item 3 of the same pass, migration
--       20260928110000): it names all three ways out — a new join date for a rehire, reopening a
--       mistaken settlement, or Regenerate — where it named only Regenerate.
--   (7) payable_payments.paid_at default
--   (8) Assertions

-- ── (1) The status trigger ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_advance_repayments_sync_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid := COALESCE(NEW.advance_id, OLD.advance_id);
  v_amount numeric;
  v_status text;
  v_repaid numeric;
BEGIN
  SELECT amount, status INTO v_amount, v_status FROM hr_advances WHERE id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_repaid := public.hr_advance_repaid(v_id);
  -- Exact (S791): both sides are numeric(12,2). It allowed a paisa of slack, which marked an advance
  -- with one paisa outstanding as settled, and left one settled after its last paisa was removed.
  IF v_status = 'active' AND v_amount - v_repaid <= 0 THEN
    UPDATE hr_advances SET status = 'settled' WHERE id = v_id;
  ELSIF v_status = 'settled' AND v_amount - v_repaid > 0 THEN
    UPDATE hr_advances SET status = 'active' WHERE id = v_id;
  END IF;
  RETURN NULL;
END;
$function$;

-- ── (2) The repayment guard ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_advance_repayments_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_adv hr_advances;
  v_repaid numeric;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN RETURN NEW; END IF;
  SELECT * INTO v_adv FROM hr_advances WHERE id = NEW.advance_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'advance_not_found'; END IF;
  IF v_adv.employee_id <> NEW.employee_id OR v_adv.client_id <> NEW.client_id THEN
    RAISE EXCEPTION 'repayment_advance_mismatch: this repayment does not belong to that advance';
  END IF;
  IF TG_OP = 'INSERT' AND v_adv.status <> 'active' THEN
    RAISE EXCEPTION 'advance_not_active: this advance is % — nothing is being recovered on it', v_adv.status;
  END IF;
  v_repaid := public.hr_advance_repaid(NEW.advance_id, CASE WHEN TG_OP = 'UPDATE' THEN NEW.id END);
  -- Exact (S791); it allowed a repayment one paisa over what was owed.
  IF v_repaid + NEW.amount > v_adv.amount THEN
    RAISE EXCEPTION 'repayment_exceeds_outstanding: only NPR % is still owed', round(GREATEST(v_adv.amount - v_repaid, 0), 2);
  END IF;
  RETURN NEW;
END;
$function$;

-- ── (3) The advance guard ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_advances_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_repaid numeric;
  v_operator constant boolean := current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF v_operator THEN RETURN OLD; END IF;
    -- The repayments cascade, and payroll runs and settlements depend on them: deleting a loan with
    -- two finalized payroll recoveries erased the ledger rows those payslips point at.
    IF EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id)
       AND EXISTS (SELECT 1 FROM hr_advance_repayments WHERE advance_id = OLD.id) THEN
      RAISE EXCEPTION 'advance_has_repayments: an advance with repayments cannot be deleted — write it off instead';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE. The three owed / nothing-owed tests are exact since S791 (they allowed a paisa either way).
  v_repaid := public.hr_advance_repaid(NEW.id);
  IF NOT v_operator THEN
    IF NEW.amount < v_repaid THEN
      RAISE EXCEPTION 'advance_amount_below_repaid: NPR % has already been repaid', v_repaid;
    END IF;
    IF NEW.status = 'settled' AND OLD.status IS DISTINCT FROM 'settled' AND NEW.amount - v_repaid > 0 THEN
      RAISE EXCEPTION 'advance_not_repaid: NPR % is still owed — record the repayment or write it off', round(NEW.amount - v_repaid, 2);
    END IF;
  END IF;

  IF NEW.status = 'written_off' AND OLD.status IS DISTINCT FROM 'written_off' THEN
    IF NOT v_operator THEN
      IF btrim(COALESCE(NEW.write_off_reason, '')) = '' THEN
        RAISE EXCEPTION 'write_off_reason_required: say why this balance is being written off';
      END IF;
      IF NEW.amount - v_repaid <= 0 THEN
        RAISE EXCEPTION 'write_off_nothing_owed: nothing is owed on this advance';
      END IF;
      NEW.written_off_at := now();
      NEW.written_off_by := (select auth.uid());
      NEW.write_off_amount := round(NEW.amount - v_repaid, 2);
    ELSE
      NEW.written_off_at := COALESCE(NEW.written_off_at, now());
      NEW.written_off_by := COALESCE(NEW.written_off_by, (select auth.uid()));
      NEW.write_off_amount := COALESCE(NEW.write_off_amount, round(GREATEST(NEW.amount - v_repaid, 0), 2));
    END IF;
  ELSIF NEW.status <> 'written_off' AND OLD.status = 'written_off' THEN
    NEW.written_off_at := NULL; NEW.written_off_by := NULL;
    NEW.write_off_reason := NULL; NEW.write_off_amount := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── (4) Payroll Finalize ────────────────────────────────────────────────────────────────────────
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

-- ── (5) Payroll Reopen ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reopen_payroll_run(p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r hr_payroll_runs;
  v_wo record;
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

  -- S791: an advance this run recovered from that has since been WRITTEN OFF refuses the reopen.
  -- Deleting the run's repayment would grow the write-off by what the run took — money forgiven that
  -- nobody decided to forgive. A write-off from Advances & Loans does not take hr_pay_lock, so the
  -- advances are row-locked first and a write-off cannot land between this check and the delete.
  -- The same rule reopen_final_settlement has had since S753.
  PERFORM 1 FROM hr_advances x
   WHERE x.id IN (SELECT rp.advance_id FROM hr_advance_repayments rp WHERE rp.payroll_run_id = r.id)
   ORDER BY x.id FOR UPDATE;
  SELECT COALESCE(NULLIF(btrim(emp.full_name), ''), 'An employee') AS who, x.type, x.amount,
         (SELECT SUM(rp.amount) FROM hr_advance_repayments rp WHERE rp.advance_id = x.id AND rp.payroll_run_id = r.id) AS recovered_here
    INTO v_wo
    FROM hr_advances x
    LEFT JOIN hr_employees emp ON emp.id = x.employee_id
   WHERE x.status = 'written_off'
     AND x.id IN (SELECT rp.advance_id FROM hr_advance_repayments rp WHERE rp.payroll_run_id = r.id)
   ORDER BY emp.full_name, x.issued_date, x.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'payroll_reopen_written_off: %''s % of NPR % was written off after this payroll recovered NPR % from it — put it back into recovery in Advances & Loans (Reactivate) first, then reopen',
      v_wo.who, CASE WHEN v_wo.type = 'loan' THEN 'loan' ELSE 'advance' END,
      to_char(v_wo.amount, 'FM99,99,99,990.00'), to_char(v_wo.recovered_here, 'FM99,99,99,990.00');
  END IF;

  DELETE FROM hr_advance_repayments WHERE payroll_run_id = r.id;   -- the status trigger reactivates

  SELECT COALESCE(array_agg(DISTINCT c), '{}') INTO v_claims
    FROM hr_payslips p, unnest(COALESCE(p.tada_claim_ids, '{}')) c WHERE p.run_id = r.id;
  IF cardinality(v_claims) > 0 THEN
    UPDATE hr_tada_claims SET status = 'approved', paid_at = NULL, paid_method = NULL
     WHERE id = ANY (v_claims) AND client_id = r.client_id AND status = 'paid' AND paid_method = 'Payroll';
    GET DIAGNOSTICS v_reverted = ROW_COUNT;
  END IF;

  UPDATE hr_payroll_runs SET status = 'draft', finalized_at = NULL WHERE id = r.id;

  -- 'written_off' is gone from the result: a written-off advance now refuses the reopen above.
  RETURN jsonb_build_object('tada_claims', cardinality(v_claims), 'tada_reverted', v_reverted);
END;
$function$;

-- ── (6) No direct status change across 'finalized' ──────────────────────────────────────────────
-- finalize_payroll_run and reopen_payroll_run are SECURITY DEFINER, so current_user inside them is the
-- owner and they pass. A client caller (anon/authenticated) updating the status column directly would
-- skip every ledger step: a finalized→draft flip left the run's repayments in place for the next
-- Finalize to delete (removing a recovery from a written-off advance with no check at all), and a
-- draft→finalized flip marked no TADA claim paid and recorded no advance recovery. The pages never do
-- either (PayrollRun.jsx inserts a draft and calls the two functions). The operator passes, for a restore.
CREATE OR REPLACE FUNCTION public.hr_payroll_runs_guard_settled()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_names text;
BEGIN
  IF (NEW.status = 'finalized') IS DISTINCT FROM (OLD.status = 'finalized')
     AND current_user IN ('anon', 'authenticated') AND NOT COALESCE(public.is_admin(), false) THEN
    RAISE EXCEPTION 'payroll_status_direct: a payroll run is finalized with Finalize and reopened with Reopen, never by changing its status directly';
  END IF;
  IF NEW.status = 'finalized' AND OLD.status IS DISTINCT FROM 'finalized' THEN
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

-- ── (7) payable_payments.paid_at ────────────────────────────────────────────────────────────────
-- A dead default today (every writer sends paid_at, from the Nepal civil date), kept correct so a
-- future writer that omits it does not date a payment the day before in Nepal.
ALTER TABLE public.payable_payments ALTER COLUMN paid_at SET DEFAULT ((now() AT TIME ZONE 'Asia/Kathmandu')::date);

-- ── (8) Assertions ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_src text;
BEGIN
  -- No 0.01 slack left in the advance ledger.
  FOREACH v_src IN ARRAY ARRAY[
    (SELECT prosrc FROM pg_proc WHERE oid = 'public.hr_advance_repayments_sync_status()'::regprocedure),
    (SELECT prosrc FROM pg_proc WHERE oid = 'public.hr_advance_repayments_guard()'::regprocedure),
    (SELECT prosrc FROM pg_proc WHERE oid = 'public.hr_advances_guard()'::regprocedure),
    (SELECT prosrc FROM pg_proc WHERE oid = 'public.finalize_payroll_run(uuid, uuid[], jsonb)'::regprocedure)
  ] LOOP
    IF v_src LIKE '%0.01%' THEN
      RAISE EXCEPTION 'S791: an advance comparison still carries the 0.01 slack';
    END IF;
  END LOOP;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.finalize_payroll_run(uuid, uuid[], jsonb)'::regprocedure) ILIKE '%current_date%' THEN
    RAISE EXCEPTION 'S791: finalize_payroll_run still falls back to CURRENT_DATE';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.reopen_payroll_run(uuid)'::regprocedure) NOT LIKE '%payroll_reopen_written_off%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.hr_payroll_runs_guard_settled()'::regprocedure) NOT LIKE '%payroll_status_direct%' THEN
    RAISE EXCEPTION 'S791: a Reopen guard is missing';
  END IF;
  -- The row guards must stay INVOKER: current_user is what tells a client caller from a function body.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hr_payroll_runs_guard_settled()'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hr_advance_repayments_guard()'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hr_advances_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'S791: a row guard became SECURITY DEFINER and would pass every caller';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.reopen_payroll_run(uuid)'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.finalize_payroll_run(uuid, uuid[], jsonb)'::regprocedure) THEN
    RAISE EXCEPTION 'S791: finalize/reopen must stay SECURITY DEFINER, or the status guard refuses them';
  END IF;
  IF has_function_privilege('anon', 'public.finalize_payroll_run(uuid, uuid[], jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reopen_payroll_run(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S791: finalize/reopen payroll is anon-executable';
  END IF;
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'payable_payments' AND column_name = 'paid_at') NOT ILIKE '%Asia/Kathmandu%' THEN
    RAISE EXCEPTION 'S791: payable_payments.paid_at default is not the Kathmandu date';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
