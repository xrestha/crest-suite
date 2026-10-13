-- S824 — a festival allowance or incentive run can be paid WITH that month's salary.
--
-- Until now a finalized Festival Allowance or Incentive run was a payment of its own: its tax taken at
-- source and stored on the row, its own bank file, and nothing on the monthly payslip. The Owner asked
-- (2026-10-13) for the finalized money to be added to the payroll of its "Paid in" month, with a switch on
-- each run: "with <month>'s salary" (the default for new runs) or "separately" (today's way, for a festival
-- that falls before payday). Incentive runs work the same way.
--
-- The design: the payslip's gross, allowances and tds stay SALARY ONLY. The bonus money rides in six new
-- payslip columns that only net pay and the screens read. Every reader that already adds the bonus tables on
-- top of payslip figures — fetchYtdMap / ytdFromPayslips, payslipYtdForFy, monthDeposit, HR Reports' TDS
-- report and certificate, labourSource / loadOtherLabourPay, get_group_pnl, the Owner Report — keeps
-- counting it exactly once, from the bonus tables, and needs no change.
--
--   1. paid_through_payroll on hr_festival_allowances and hr_incentives, DEFAULT false: every existing row,
--      a stale cached page and an old backup all read as "separately", so nothing already paid by the bonus
--      bank file can join a payslip and be paid twice. The new pages write true explicitly. A with-salary
--      row's tax may not exceed its amount (it would eat the salary).
--   2. hr_payslips.festival_amount / festival_tds / festival_ids and incentive_amount / incentive_tds /
--      incentive_ids, the TADA pattern (tada_amount, tada_claim_ids). Net pay becomes
--        gross + ot - absence - ssf - other - advance - tds + tada
--          + festival_amount - festival_tds + incentive_amount - incentive_tds
--      in hr_payslips_guard_net and finalize_payroll_run (payrollData.js payslipNetGap is the JS copy).
--   3. hr_bonus_payroll_block(client, employee, year, month): why a row cannot ride that month's payslip —
--      'payroll_finalized', 'leaving' (a Final Settlement, draft or finalized, ends their employment in or
--      before that month: payroll leaves a settled leaver out, and a draft is about to), 'not_employed'.
--   4. hr_bonus_rows_guard (both tables): under hr_pay_lock, a with-salary row cannot be finalized or
--      reopened while that month's payroll is finalized, and cannot be finalized for someone 'leaving' or
--      'not_employed'. paid_through_payroll joins the columns Reopen may not change.
--   5. finalize_payroll_run: each payslip's bonus amounts, taxes and ids must be exactly that employee's
--      finalized with-salary rows for the month (payroll_bonus_stale), and nobody may have such a row
--      without a payslip in the run (payroll_bonus_no_payslip).
--   6. finalize_final_settlement (patched in place from the live body): refused while a finalized
--      with-salary row is waiting on a payslip in the last working month or later — payroll stops paying
--      the leaver there, so nothing would pay it (settlement_bonus_on_payroll). The listing is
--      hr_bonus_waiting_on_payroll(), called only from that DEFINER body.
--   7. get_my_hr_payslips (Crest Staff): the four amounts and the run names, for the payslip view.
--
-- Built on these bodies (md5(prosrc) of the last migration that defines each; section 0 refuses to run if
-- the live body is different, so an out-of-band change is never silently reverted):
--   hr_bonus_rows_guard()            b1c22cc0830c3c4be31a9edcb0c660e3  (20261002140000)
--   hr_payslips_guard_net()          fb736f2084be3aeec587acc8bc2c0b19  (20261002140000)
--   finalize_payroll_run(...)        b375f1069eaf3e9800a923fd0ce61e0b  (20261002140000)
--   finalize_final_settlement(uuid)  e9dc462de64e00351c6e0a349784e2f4  (20261004120000)
--   get_my_hr_payslips()             d044853cf7af5751b3aa2faf917fcc1c  (20261005120000)
-- Every change inside a rebuilt body is marked "S824". Signatures, SECURITY, search_path and grants are
-- unchanged except get_my_hr_payslips, whose return columns grow (DROP + CREATE + the same grants).
--
-- Ship order: this migration FIRST, then the app. The old app on the new database works as today: its
-- payslips carry no bonus columns (they default to 0, and the identity still holds), its bonus rows are
-- "separately". If a new bonus page finalizes a with-salary run while an old Payroll page is still cached,
-- that page's Finalize is refused with payroll_bonus_stale / payroll_bonus_no_payslip instead of paying
-- the wrong money. The new app on the OLD database fails on the missing columns (PGRST204).
--
-- Reverse: put the five bodies above back from their migrations (section 0's hashes), DROP the two new
-- functions, DROP and re-create get_my_hr_payslips from 20261005120000, then drop the payslip CHECK and the
-- six payslip columns and the two bonus CHECKs and paid_through_payroll columns. Only reverse with no
-- with-salary bonus finalized: its money would then be on a payslip the old identity refuses.
--
-- The probe at the end runs as an HR client's Owner, in the last Ashadh of the BS calendar table (a month
-- no real payroll reaches), on rows it makes itself, in a block that rolls itself back.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the live bodies are the ones this file was built on ───────────────────────────────────
-- The second hash of each is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.hr_bonus_rows_guard()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'b1c22cc0830c3c4be31a9edcb0c660e3' AND v_md5 IS DISTINCT FROM '7ead7e7b0157829461705cdae6ec59c7' THEN
    RAISE EXCEPTION 'S824: hr_bonus_rows_guard changed since this was drafted (live md5 %) — merge the S824 blocks onto the live body', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.hr_payslips_guard_net()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'fb736f2084be3aeec587acc8bc2c0b19' AND v_md5 IS DISTINCT FROM '0361b364fe301bc781275172545eee65' THEN
    RAISE EXCEPTION 'S824: hr_payslips_guard_net changed since this was drafted (live md5 %) — merge the S824 change onto the live body', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.finalize_payroll_run(uuid,uuid[],jsonb)'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'b375f1069eaf3e9800a923fd0ce61e0b' AND v_md5 IS DISTINCT FROM '3855aca3e6f6238510d587efcf31a834' THEN
    RAISE EXCEPTION 'S824: finalize_payroll_run changed since this was drafted (live md5 %) — merge the S824 blocks onto the live body', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.finalize_final_settlement(uuid)'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'e9dc462de64e00351c6e0a349784e2f4' AND v_md5 IS DISTINCT FROM 'ddbe4bff57fdb4d03207fe38b1cbe4cc' THEN
    RAISE EXCEPTION 'S824: finalize_final_settlement changed since this was drafted (live md5 %) — re-point section 6''s patch at the live body', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_my_hr_payslips()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'd044853cf7af5751b3aa2faf917fcc1c' AND v_md5 IS DISTINCT FROM '174fa275f0060ebef1fb2dc82428f7f1' THEN
    RAISE EXCEPTION 'S824: get_my_hr_payslips changed since this was drafted (live md5 %) — merge the S824 columns onto the live body', v_md5;
  END IF;
  IF to_regprocedure('public.hr_pay_lock(uuid)') IS NULL OR to_regprocedure('public.hr_festival_settled_by(uuid,integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'S824: hr_pay_lock or hr_festival_settled_by is missing; the guards call them';
  END IF;
END;
$$;


-- ── 1. The switch on each bonus row ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.hr_festival_allowances ADD COLUMN IF NOT EXISTS paid_through_payroll boolean NOT NULL DEFAULT false;
ALTER TABLE public.hr_incentives          ADD COLUMN IF NOT EXISTS paid_through_payroll boolean NOT NULL DEFAULT false;

-- A with-salary row's tax rides the payslip as a deduction; above the amount it would eat the salary.
ALTER TABLE public.hr_festival_allowances DROP CONSTRAINT IF EXISTS hr_festival_allowances_payroll_tds_check;
ALTER TABLE public.hr_festival_allowances ADD CONSTRAINT hr_festival_allowances_payroll_tds_check
  CHECK (NOT paid_through_payroll OR COALESCE(tds, 0) <= COALESCE(amount, 0));
ALTER TABLE public.hr_incentives DROP CONSTRAINT IF EXISTS hr_incentives_payroll_tds_check;
ALTER TABLE public.hr_incentives ADD CONSTRAINT hr_incentives_payroll_tds_check
  CHECK (NOT paid_through_payroll OR COALESCE(tds, 0) <= COALESCE(amount, 0));


-- ── 2. The bonus on the payslip ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.hr_payslips
  ADD COLUMN IF NOT EXISTS festival_amount  numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS festival_tds     numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS festival_ids     uuid[]        NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS incentive_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS incentive_tds    numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS incentive_ids    uuid[]        NOT NULL DEFAULT '{}'::uuid[];

-- numeric accepts 'NaN', and NaN > 0 is true, so a plain >= 0 would let it through.
ALTER TABLE public.hr_payslips DROP CONSTRAINT IF EXISTS hr_payslips_bonus_check;
ALTER TABLE public.hr_payslips ADD CONSTRAINT hr_payslips_bonus_check CHECK (
      festival_amount  >= 0 AND festival_amount  <> 'NaN' AND festival_tds  >= 0 AND festival_tds  <> 'NaN'
  AND festival_tds  <= festival_amount
  AND incentive_amount >= 0 AND incentive_amount <> 'NaN' AND incentive_tds >= 0 AND incentive_tds <> 'NaN'
  AND incentive_tds <= incentive_amount);


-- ── 3. hr_bonus_payroll_block: why a row cannot ride that month's payslip ────────────────────────────────
-- NULL when it can. VOLATILE (the default) and DEFINER: the guard calls it after taking hr_pay_lock, and it
-- must see a run or settlement another transaction committed while this one waited, whatever the caller's
-- own RLS view of runs and settlements.
CREATE OR REPLACE FUNCTION public.hr_bonus_payroll_block(p_client_id uuid, p_employee_id uuid, p_bs_year integer, p_bs_month integer)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lo date;
  v_hi date;
  v_join date;
  v_end date;
BEGIN
  IF NOT COALESCE(public.is_admin() OR p_client_id = public.my_client_id(), false) THEN
    RAISE EXCEPTION 'bonus_payroll_check_denied: this employee belongs to another business' USING ERRCODE = '42501';
  END IF;
  SELECT b.ad_start, b.ad_start + b.days - 1 INTO v_lo, v_hi
    FROM bs_months b WHERE b.bs_year = p_bs_year AND b.bs_month = p_bs_month;
  -- A check that could not run has not passed.
  IF v_lo IS NULL THEN
    RAISE EXCEPTION 'bonus_payroll_check_calendar: BS % month % is outside the BS calendar table', p_bs_year, p_bs_month;
  END IF;

  IF EXISTS (
    SELECT 1 FROM hr_payroll_runs r JOIN monthly_periods mp ON mp.id = r.period_id
     WHERE mp.client_id = p_client_id AND mp.bs_year = p_bs_year AND mp.bs_month = p_bs_month
       AND r.status = 'finalized') THEN
    RETURN 'payroll_finalized';
  END IF;

  SELECT e.join_date, e.end_date INTO v_join, v_end
    FROM hr_employees e WHERE e.id = p_employee_id AND e.client_id = p_client_id;
  IF NOT FOUND THEN
    RETURN 'not_employed';
  END IF;

  -- A Final Settlement in the current employment (a join date after the last day is a rehire) whose last
  -- working day falls in this month or before: payroll leaves a finalized one out from that month on
  -- (hr_run_settled_employee_names), and a draft is about to be.
  IF EXISTS (
    SELECT 1 FROM hr_final_settlements s
     WHERE s.employee_id = p_employee_id AND s.client_id = p_client_id
       AND s.status IN ('draft', 'finalized')
       AND (v_join IS NULL OR s.last_working_date >= v_join)
       AND s.last_working_date <= v_hi) THEN
    RETURN 'leaving';
  END IF;

  -- payrollCompute.js employedInPeriod, the test payroll uses.
  IF (v_join IS NOT NULL AND v_join > v_hi) OR (v_end IS NOT NULL AND v_end < v_lo) THEN
    RETURN 'not_employed';
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.hr_bonus_payroll_block(uuid, uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hr_bonus_payroll_block(uuid, uuid, integer, integer) TO authenticated, service_role;


-- ── 4. hr_bonus_rows_guard ───────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_bonus_rows_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_settled text;
  -- S824
  v_into boolean;
  v_outof boolean;
  v_block text;
  v_who text;
  v_what text;
  v_months constant text[] := ARRAY['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin',
                                    'Kartik','Mangsir','Poush','Magh','Falgun','Chaitra'];
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF TG_TABLE_NAME = 'hr_festival_allowances' THEN
      NEW.festival_name := btrim(COALESCE(NEW.festival_name, ''));
      IF NEW.festival_name = '' THEN RAISE EXCEPTION 'bonus_name_blank: name the festival'; END IF;
    ELSE
      NEW.run_label := btrim(COALESCE(NEW.run_label, ''));
      IF NEW.run_label = '' THEN RAISE EXCEPTION 'bonus_name_blank: name the run'; END IF;
    END IF;
  END IF;

  -- S798 GAP-PAY-STATE-3: the festival money is paid once, by the run or by the settlement. Checked
  -- when a row with an amount BECOMES finalized, for every client caller (the operator included on
  -- UPDATE; an operator INSERT is a restore of history and passes), under the lock settlement Finalize
  -- takes, so the two cannot pass each other.
  IF TG_TABLE_NAME = 'hr_festival_allowances' AND TG_OP IN ('INSERT', 'UPDATE')
     AND current_user IN ('anon', 'authenticated')
     AND NEW.status = 'finalized' AND COALESCE(NEW.amount, 0) > 0
     AND (CASE WHEN TG_OP = 'UPDATE' THEN OLD.status IS DISTINCT FROM 'finalized'
               ELSE NOT COALESCE(public.is_admin(), false) END) THEN
    PERFORM public.hr_pay_lock(NEW.client_id);
    v_settled := public.hr_festival_settled_by(NEW.employee_id, NEW.bs_year, NEW.bs_month);
    IF v_settled IS NOT NULL THEN
      RAISE EXCEPTION 'festival_paid_by_settlement: % was settled in a Final Settlement that already paid a festival share for this fiscal year — leave them out of this run, or reopen that settlement first', v_settled;
    END IF;
  END IF;

  -- S824: a row paid WITH that month's salary rides the payslip of its pay month. Finalizing it puts money
  -- on that payslip, and reopening it takes the money off, so neither may happen once that payroll is
  -- finalized; and it is finalized only for someone that payroll will carry. Same callers and the same
  -- lock as the block above (payroll Finalize and settlement Finalize take it too). A row paid separately
  -- is not touched.
  IF TG_OP IN ('INSERT', 'UPDATE') AND current_user IN ('anon', 'authenticated') THEN
    v_into := COALESCE(NEW.status = 'finalized' AND NEW.paid_through_payroll AND COALESCE(NEW.amount, 0) > 0
              AND (CASE WHEN TG_OP = 'UPDATE' THEN OLD.status IS DISTINCT FROM 'finalized'
                        ELSE NOT COALESCE(public.is_admin(), false) END), false);
    v_outof := COALESCE(CASE WHEN TG_OP = 'UPDATE'
                             THEN OLD.status = 'finalized' AND NEW.status IS DISTINCT FROM 'finalized'
                                  AND OLD.paid_through_payroll AND COALESCE(OLD.amount, 0) > 0
                             ELSE false END, false);
    IF v_into OR v_outof THEN
      PERFORM public.hr_pay_lock(NEW.client_id);
      v_block := public.hr_bonus_payroll_block(NEW.client_id, NEW.employee_id, NEW.bs_year, NEW.bs_month);
      IF v_block IS NOT NULL THEN
        v_who := COALESCE((SELECT NULLIF(btrim(e.full_name), '') FROM hr_employees e WHERE e.id = NEW.employee_id), 'This employee');
        v_what := CASE WHEN TG_TABLE_NAME = 'hr_festival_allowances' THEN 'festival allowance' ELSE 'incentive' END;
        IF v_block = 'payroll_finalized' AND v_outof THEN
          RAISE EXCEPTION 'bonus_payroll_finalized: %''s % was paid with the % % salary, and that payroll is finalized — reopen that payroll first',
            v_who, v_what, v_months[NEW.bs_month], NEW.bs_year;
        ELSIF v_block = 'payroll_finalized' THEN
          RAISE EXCEPTION 'bonus_payroll_finalized: payroll for % % is already finalized, so %''s % cannot be paid with it — reopen that payroll, pick another Paid in month, or pay this run separately',
            v_months[NEW.bs_month], NEW.bs_year, v_who, v_what;
        ELSIF v_into AND v_block = 'leaving' THEN
          RAISE EXCEPTION 'bonus_payroll_leaving: % has a Final Settlement with a last working day in or before % %, so that payroll will not carry their % — pay them separately',
            v_who, v_months[NEW.bs_month], NEW.bs_year, v_what;
        ELSIF v_into AND v_block = 'not_employed' THEN
          RAISE EXCEPTION 'bonus_payroll_not_employed: % is not employed in % %, so that payroll has no payslip to carry their % — pay them separately, or leave them out',
            v_who, v_months[NEW.bs_month], NEW.bs_year, v_what;
        END IF;
      END IF;
    END IF;
  END IF;

  -- S798 3a (GAP-OPERATOR-1, H3): the operator passes only on INSERT, which is all an Export/Import
  -- restore into an empty company does. Every later change takes the managers' path.
  IF current_user NOT IN ('anon', 'authenticated')
     OR (TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false)) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- S798 3a (BONUS-LEDGERS-5, H2): below the Owner, nobody finalizes or reopens a row that pays
  -- themselves. Amounts stay writable (Generate, Recompute and the tax rewrite all write them, and the
  -- database cannot tell a typed amount from a calculated one), so the fence is the status change:
  -- the Owner finalizes any run that pays the HR manager.
  IF NOT public.hr_self_decision_exempt()
     AND ((TG_OP = 'INSERT' AND NEW.status = 'finalized' AND public.hr_is_own_employee(NEW.employee_id))
       OR (TG_OP = 'UPDATE' AND (NEW.status = 'finalized') IS DISTINCT FROM (OLD.status = 'finalized')
           AND (public.hr_is_own_employee(OLD.employee_id) OR public.hr_is_own_employee(NEW.employee_id)))) THEN
    RAISE EXCEPTION 'hr_own_run: this run pays you (%) — the Owner finalizes and reopens a run that pays you',
      COALESCE((SELECT NULLIF(btrim(e.full_name), '') FROM hr_employees e WHERE e.id = NEW.employee_id), 'your own row');
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'finalized' AND EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id) THEN
      RAISE EXCEPTION 'bonus_finalized: a finalized row cannot be deleted — reopen the run first';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'finalized' THEN
    IF NEW.status = 'draft'
       AND NEW.amount IS NOT DISTINCT FROM OLD.amount
       AND NEW.tds IS NOT DISTINCT FROM OLD.tds
       AND NEW.employee_id = OLD.employee_id
       AND NEW.bs_year = OLD.bs_year
       AND NEW.bs_month = OLD.bs_month
       -- S824: how it is paid is part of what was finalized.
       AND NEW.paid_through_payroll IS NOT DISTINCT FROM OLD.paid_through_payroll THEN
      RETURN NEW;          -- Reopen
    END IF;
    RAISE EXCEPTION 'bonus_finalized: this run is finalized — reopen it first';
  END IF;
  RETURN NEW;
END;
$function$;


-- ── 5. hr_payslips_guard_net ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_payslips_guard_net()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_parts numeric;
BEGIN
  -- The operator's INSERT is exempt, so an Export/Import restore writes what the backup holds; an
  -- operator's later edit is checked like anyone's (S798 3a, H3).
  IF current_user NOT IN ('anon', 'authenticated')
     OR (TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false)) THEN
    RETURN NEW;
  END IF;
  -- Same identity as payrollData.js payslipNetGap and finalize_payroll_run below. S824: plus a festival
  -- allowance or incentive paid with this salary, less its own tax.
  v_parts := COALESCE(NEW.gross, 0) + COALESCE(NEW.ot_amount, 0) - COALESCE(NEW.absence_deduction, 0)
           - COALESCE(NEW.ssf_employee, 0) - COALESCE(NEW.other_deductions, 0)
           - COALESCE(NEW.advance_deduction, 0) - COALESCE(NEW.tds, 0) + COALESCE(NEW.tada_amount, 0)
           + COALESCE(NEW.festival_amount, 0) - COALESCE(NEW.festival_tds, 0)
           + COALESCE(NEW.incentive_amount, 0) - COALESCE(NEW.incentive_tds, 0);
  IF abs(COALESCE(NEW.net_pay, 0) - v_parts) > 0.01 THEN
    RAISE EXCEPTION 'payslip_net_mismatch: this payslip''s net pay (%) is not its pay less its deductions (%) — regenerate the run', NEW.net_pay, round(v_parts, 2);
  END IF;
  RETURN NEW;
END;
$function$;


-- ── 6. finalize_payroll_run ──────────────────────────────────────────────────────────────────────────────
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
  v_own text;
  -- S824
  v_mp monthly_periods;
  v_bonus_off text;
  v_bonus_orphan text;
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

  -- S798 3a (H2): below the Owner, nobody finalizes a payroll that pays themselves. Checked as the
  -- caller (hr_is_own_employee reads the session), so an HR manager on the run asks the Owner.
  IF NOT public.hr_self_decision_exempt() THEN
    SELECT COALESCE(NULLIF(btrim(emp.full_name), ''), 'your own payslip') INTO v_own
      FROM hr_payslips p LEFT JOIN hr_employees emp ON emp.id = p.employee_id
     WHERE p.run_id = r.id AND public.hr_is_own_employee(p.employee_id)
     LIMIT 1;
    IF v_own IS NOT NULL THEN
      RAISE EXCEPTION 'hr_own_run: this payroll pays you (%) — the Owner finalizes and reopens a run that pays you', v_own;
    END IF;
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
  -- S824: the identity includes a festival allowance or incentive paid with this salary, less its tax.
  SELECT string_agg(COALESCE(emp.full_name, 'an employee'), ', ' ORDER BY emp.full_name) INTO v_net_off
    FROM hr_payslips p
    LEFT JOIN hr_employees emp ON emp.id = p.employee_id
   WHERE p.run_id = r.id
     AND abs(COALESCE(p.net_pay, 0) - (COALESCE(p.gross, 0) + COALESCE(p.ot_amount, 0) - COALESCE(p.absence_deduction, 0)
           - COALESCE(p.ssf_employee, 0) - COALESCE(p.other_deductions, 0)
           - COALESCE(p.advance_deduction, 0) - COALESCE(p.tds, 0) + COALESCE(p.tada_amount, 0)
           + COALESCE(p.festival_amount, 0) - COALESCE(p.festival_tds, 0)
           + COALESCE(p.incentive_amount, 0) - COALESCE(p.incentive_tds, 0))) > 0.01;
  IF v_net_off IS NOT NULL THEN
    RAISE EXCEPTION 'payslip_net_mismatch: the net pay on the payslip of % is not their pay less their deductions — regenerate the run and finalize again', v_net_off;
  END IF;

  -- S824: the festival allowances and incentives this payroll pays with salary are exactly the month's
  -- finalized with-salary rows (amount above 0), per employee: the same amounts, taxes and row ids. A run
  -- generated before a bonus was finalized or reopened differs (stale), and a with-salary row for someone
  -- with no payslip here would be paid by nobody (orphan). hr_bonus_rows_guard keeps the rows still from
  -- here on: under the lock taken above, and refused once this run is finalized.
  SELECT * INTO v_mp FROM monthly_periods WHERE id = r.period_id;
  SELECT string_agg(COALESCE(emp.full_name, 'an employee'), ', ' ORDER BY emp.full_name) FILTER (WHERE h.employee_id IS NOT NULL),
         string_agg(COALESCE(emp.full_name, 'an employee'), ', ' ORDER BY emp.full_name) FILTER (WHERE h.employee_id IS NULL)
    INTO v_bonus_off, v_bonus_orphan
    FROM (
      SELECT p.employee_id,
             round(COALESCE(p.festival_amount, 0), 2) AS fa, round(COALESCE(p.festival_tds, 0), 2) AS ft,
             ARRAY(SELECT x FROM unnest(COALESCE(p.festival_ids, '{}'::uuid[])) x ORDER BY x) AS fids,
             round(COALESCE(p.incentive_amount, 0), 2) AS ia, round(COALESCE(p.incentive_tds, 0), 2) AS it,
             ARRAY(SELECT x FROM unnest(COALESCE(p.incentive_ids, '{}'::uuid[])) x ORDER BY x) AS iids
        FROM hr_payslips p
       WHERE p.run_id = r.id
    ) h
    FULL JOIN (
      SELECT b.employee_id,
             round(COALESCE(sum(b.amount) FILTER (WHERE b.kind = 'f'), 0), 2) AS fa,
             round(COALESCE(sum(b.tds) FILTER (WHERE b.kind = 'f'), 0), 2) AS ft,
             COALESCE(array_agg(b.id ORDER BY b.id) FILTER (WHERE b.kind = 'f'), '{}'::uuid[]) AS fids,
             round(COALESCE(sum(b.amount) FILTER (WHERE b.kind = 'i'), 0), 2) AS ia,
             round(COALESCE(sum(b.tds) FILTER (WHERE b.kind = 'i'), 0), 2) AS it,
             COALESCE(array_agg(b.id ORDER BY b.id) FILTER (WHERE b.kind = 'i'), '{}'::uuid[]) AS iids
        FROM (
          SELECT 'f' AS kind, f.id, f.employee_id, f.amount, COALESCE(f.tds, 0) AS tds
            FROM hr_festival_allowances f
           WHERE f.client_id = r.client_id AND f.bs_year = v_mp.bs_year AND f.bs_month = v_mp.bs_month
             AND f.status = 'finalized' AND f.paid_through_payroll AND COALESCE(f.amount, 0) > 0
          UNION ALL
          SELECT 'i', i.id, i.employee_id, i.amount, COALESCE(i.tds, 0)
            FROM hr_incentives i
           WHERE i.client_id = r.client_id AND i.bs_year = v_mp.bs_year AND i.bs_month = v_mp.bs_month
             AND i.status = 'finalized' AND i.paid_through_payroll AND COALESCE(i.amount, 0) > 0
        ) b
       GROUP BY b.employee_id
    ) d ON d.employee_id = h.employee_id
    LEFT JOIN hr_employees emp ON emp.id = COALESCE(h.employee_id, d.employee_id)
   WHERE h.employee_id IS NULL
      OR h.fa <> COALESCE(d.fa, 0) OR h.ft <> COALESCE(d.ft, 0) OR h.fids <> COALESCE(d.fids, '{}'::uuid[])
      OR h.ia <> COALESCE(d.ia, 0) OR h.it <> COALESCE(d.it, 0) OR h.iids <> COALESCE(d.iids, '{}'::uuid[]);
  IF v_bonus_orphan IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_bonus_no_payslip: % has a festival allowance or incentive to be paid with this month''s salary but no payslip in this run — regenerate the run to include them, or reopen that bonus run and pay them separately', v_bonus_orphan;
  END IF;
  IF v_bonus_off IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_bonus_stale: the festival allowance or incentive on the payslip of % is not what is finalized for this month (finalized or reopened since this run was generated) — regenerate the run and finalize again', v_bonus_off;
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


-- ── 7. Final Settlement: a with-salary bonus the settlement takes off payroll ────────────────────────────
-- The first with-salary row (finalized, amount above 0) paid in the month p_from or later, described for a
-- refusal; NULL when none. Called only from finalize_final_settlement's DEFINER body, like hr_ot_on_file.
CREATE OR REPLACE FUNCTION public.hr_bonus_waiting_on_payroll(p_client_id uuid, p_employee_id uuid, p_from_year integer, p_from_month integer)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT x.what || ' "' || x.name || '" (NPR ' || to_char(x.amount, 'FM99,99,99,990.00') || ', paid with the '
         || (ARRAY['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin',
                   'Kartik','Mangsir','Poush','Magh','Falgun','Chaitra'])[x.bs_month] || ' ' || x.bs_year || ' salary)'
    FROM (
      SELECT 'festival allowance'::text AS what, f.festival_name::text AS name, f.amount, f.bs_year, f.bs_month
        FROM hr_festival_allowances f
       WHERE f.client_id = p_client_id AND f.employee_id = p_employee_id
         AND f.status = 'finalized' AND f.paid_through_payroll AND COALESCE(f.amount, 0) > 0
         AND f.bs_year * 12 + f.bs_month >= p_from_year * 12 + p_from_month
      UNION ALL
      SELECT 'incentive'::text, i.run_label::text, i.amount, i.bs_year, i.bs_month
        FROM hr_incentives i
       WHERE i.client_id = p_client_id AND i.employee_id = p_employee_id
         AND i.status = 'finalized' AND i.paid_through_payroll AND COALESCE(i.amount, 0) > 0
         AND i.bs_year * 12 + i.bs_month >= p_from_year * 12 + p_from_month
    ) x
   ORDER BY x.bs_year, x.bs_month
   LIMIT 1
$function$;

REVOKE ALL ON FUNCTION public.hr_bonus_waiting_on_payroll(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;

-- finalize_final_settlement is ~600 lines; it is patched in place from the LIVE body (S753's method),
-- adding one variable and one refusal right after the S798 GAP-PAY-STATE-3 festival check. Earlier months
-- need nothing: settlement_month_paid refuses a finalized payslip in the last month or later, and
-- settlement_open_prior_months makes every earlier month of the fiscal year final first.
DO $$
DECLARE
  v_def text;
  v_anchor constant text := E'        to_char(s.festival_pro, ''FM99,99,99,990.00'');\n    END IF;\n  END IF;\n';
  v_decl constant text := E'  v_fest record;\n';
  v_n int;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def FROM pg_proc WHERE oid = 'public.finalize_final_settlement(uuid)'::regprocedure;
  IF v_def LIKE '%hr_bonus_waiting_on_payroll%' THEN
    RETURN;   -- a re-run: already patched (section 0 checked the hash)
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S824: the festival check''s end appears % times in finalize_final_settlement (want 1)', v_n;
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_decl, ''))) / length(v_decl);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S824: "v_fest record;" appears % times in finalize_final_settlement (want 1)', v_n;
  END IF;
  v_def := replace(v_def, v_decl, v_decl || E'  v_bonus text;   -- S824\n');
  v_def := replace(v_def, v_anchor, v_anchor || E'\n'
    || E'  -- S824: a festival allowance or incentive finalized to be paid WITH the salary of the last month or a\n'
    || E'  -- later one. Payroll leaves a settled leaver out from their last working month on, so nothing would pay\n'
    || E'  -- it: the run is reopened, and finalized again pays them separately (hr_bonus_payroll_block ''leaving'').\n'
    || E'  v_bonus := public.hr_bonus_waiting_on_payroll(s.client_id, s.employee_id, s.settle_bs_year, s.settle_bs_month);\n'
    || E'  IF v_bonus IS NOT NULL THEN\n'
    || E'    RAISE EXCEPTION ''settlement_bonus_on_payroll: %''''s % is set to be paid with a salary this settlement stops — reopen that run on its page and finalize it again (anyone leaving is then paid separately), then finalize this settlement'',\n'
    || E'      v_name, v_bonus;\n'
    || E'  END IF;\n');
  EXECUTE v_def;
END;
$$;


-- ── 8. Crest Staff: the bonus on the payslip ─────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_my_hr_payslips();

CREATE OR REPLACE FUNCTION public.get_my_hr_payslips()
 RETURNS TABLE(id uuid, bs_year integer, bs_month integer, run_status text, pay_basis text, basic numeric, allowances numeric, gross numeric, ot_hours numeric, ot_amount numeric, worked_days numeric, hours_worked numeric, present_days numeric, absent_days numeric, absence_deduction numeric, ssf_employee numeric, ssf_employer numeric, other_deductions numeric, advance_deduction numeric, tds numeric, tada_amount numeric, net_pay numeric, full_name text, employee_code text, department text, ssf_no text, ssf_enrolled boolean, unpaid_days numeric, retirement_contribution numeric, festival_amount numeric, festival_tds numeric, festival_label text, incentive_amount numeric, incentive_tds numeric, incentive_label text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_employee_id uuid;
BEGIN
  PERFORM public.hr_self_service_assert_active();
  SELECT pr.hr_employee_id INTO v_employee_id
    FROM profiles pr WHERE pr.id = auth.uid() AND pr.hr_self_service = true;
  IF v_employee_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
    SELECT p.id, mp.bs_year, mp.bs_month, r.status,
           p.pay_basis, p.basic, p.allowances, p.gross,
           p.ot_hours, p.ot_amount,
           p.worked_days, p.hours_worked, p.present_days, p.absent_days,
           p.absence_deduction, p.ssf_employee, p.ssf_employer,
           p.other_deductions, p.advance_deduction, p.tds,
           p.tada_amount, p.net_pay,
           e.full_name, e.employee_code, e.department, e.ssf_no, e.ssf_enrolled,
           p.unpaid_days, p.retirement_contribution,
           -- S824: a festival allowance or incentive paid with this salary, and the runs' names. The rows
           -- cannot change while the payslip carrying them is finalized (hr_bonus_rows_guard).
           p.festival_amount, p.festival_tds,
           (SELECT string_agg(f.festival_name::text, ', ' ORDER BY f.festival_name)
              FROM hr_festival_allowances f WHERE f.id = ANY (p.festival_ids)),
           p.incentive_amount, p.incentive_tds,
           (SELECT string_agg(i.run_label::text, ', ' ORDER BY i.run_label)
              FROM hr_incentives i WHERE i.id = ANY (p.incentive_ids))
    FROM hr_payslips p
    JOIN hr_payroll_runs r ON r.id = p.run_id
    JOIN monthly_periods mp ON mp.id = r.period_id
    JOIN hr_employees e ON e.id = p.employee_id
    WHERE p.employee_id = v_employee_id AND r.status = 'finalized'
    ORDER BY mp.bs_year DESC, mp.bs_month DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_my_hr_payslips() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_hr_payslips() TO authenticated, service_role;


-- ── 9. Assertions, then a probe that rolls itself back ───────────────────────────────────────────────────
DO $$
DECLARE
  v_n int;
  v_txt text;
  v_c uuid;
  v_owner uuid;
  v_e1 uuid;
  v_e2 uuid;
  v_y int;
  v_m constant int := 3;   -- Ashadh: its whole fiscal year sits inside the calendar table
  v_lo date;
  v_p uuid;
  v_run uuid;
  v_ps uuid;
  v_f1 uuid;
  v_f2 uuid;
  v_fs uuid;
  v_i1 uuid;
  v_set uuid;
  v_row record;
BEGIN
  -- Catalog: the columns, the bodies, the grants.
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'hr_payslips' AND is_nullable = 'NO'
     AND column_name IN ('festival_amount', 'festival_tds', 'festival_ids', 'incentive_amount', 'incentive_tds', 'incentive_ids');
  IF v_n <> 6 THEN RAISE EXCEPTION 'S824: hr_payslips has % of the 6 bonus columns', v_n; END IF;
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name IN ('hr_festival_allowances', 'hr_incentives')
     AND column_name = 'paid_through_payroll' AND is_nullable = 'NO' AND column_default = 'false';
  IF v_n <> 2 THEN RAISE EXCEPTION 'S824: paid_through_payroll is on % of the 2 bonus tables (NOT NULL DEFAULT false)', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid = 'public.hr_bonus_payroll_block(uuid,uuid,integer,integer)'::regprocedure
     AND prosecdef AND proconfig = '{search_path=public}'
     AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND has_function_privilege('authenticated', oid, 'EXECUTE');
  IF v_n <> 1 THEN RAISE EXCEPTION 'S824: hr_bonus_payroll_block is not DEFINER, search_path public, authenticated-only'; END IF;
  IF has_function_privilege('authenticated', 'public.hr_bonus_waiting_on_payroll(uuid,uuid,integer,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.hr_bonus_waiting_on_payroll(uuid,uuid,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S824: a browser login can call hr_bonus_waiting_on_payroll';
  END IF;
  IF has_function_privilege('anon', 'public.get_my_hr_payslips()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_my_hr_payslips()', 'EXECUTE') THEN
    RAISE EXCEPTION 'S824: get_my_hr_payslips grants are not authenticated-only';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid = 'public.finalize_final_settlement(uuid)'::regprocedure AND prosecdef
     AND prosrc LIKE '%hr_bonus_waiting_on_payroll(s.client_id, s.employee_id, s.settle_bs_year, s.settle_bs_month)%'
     AND prosrc LIKE '%v_bonus text;%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'S824: finalize_final_settlement was not patched'; END IF;

  -- The callers: an HR client's Owner (no staff marker of any kind) at the outlet it works in, with two
  -- employees on payroll who have never been settled. The test month is the last Ashadh in the calendar.
  SELECT max(bs_year) INTO v_y FROM bs_months WHERE bs_month = v_m;
  SELECT ad_start INTO v_lo FROM bs_months WHERE bs_year = v_y AND bs_month = v_m;
  SELECT p.id, c.id INTO v_owner, v_c
    FROM profiles p
    JOIN clients c ON c.id = COALESCE(p.active_client_id, p.client_id)
   WHERE p.role = 'client' AND c.hr_enabled
     AND p.pos_email IS NULL AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND NOT COALESCE(p.hr_self_service, false)
     AND (SELECT count(*) FROM hr_employees e
           WHERE e.client_id = c.id AND e.end_date IS NULL AND e.status IN ('active', 'probation')
             AND NOT EXISTS (SELECT 1 FROM hr_final_settlements s WHERE s.employee_id = e.id)) >= 2
   ORDER BY p.id
   LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'S824 probe: no HR Owner login with two unsettled employees to test with';
  END IF;
  SELECT e.id INTO v_e1 FROM hr_employees e
   WHERE e.client_id = v_c AND e.end_date IS NULL AND e.status IN ('active', 'probation')
     AND NOT EXISTS (SELECT 1 FROM hr_final_settlements s WHERE s.employee_id = e.id)
   ORDER BY e.id LIMIT 1;
  SELECT e.id INTO v_e2 FROM hr_employees e
   WHERE e.client_id = v_c AND e.end_date IS NULL AND e.status IN ('active', 'probation') AND e.id <> v_e1
     AND NOT EXISTS (SELECT 1 FROM hr_final_settlements s WHERE s.employee_id = e.id)
   ORDER BY e.id LIMIT 1;

  BEGIN
    -- ── Setup, as the migration's own role (every guard passes it) ──
    SELECT id INTO v_p FROM monthly_periods WHERE client_id = v_c AND bs_year = v_y AND bs_month = v_m;
    IF v_p IS NULL THEN
      INSERT INTO monthly_periods (client_id, bs_year, bs_month, status) VALUES (v_c, v_y, v_m, 'closed') RETURNING id INTO v_p;
    END IF;
    IF EXISTS (SELECT 1 FROM hr_payroll_runs WHERE period_id = v_p) THEN
      RAISE EXCEPTION 'S824 probe: BS % Ashadh already has a payroll run for the test client', v_y;
    END IF;
    INSERT INTO hr_payroll_runs (client_id, period_id) VALUES (v_c, v_p) RETURNING id INTO v_run;
    INSERT INTO hr_festival_allowances (client_id, employee_id, bs_year, bs_month, festival_name, amount, tds, paid_through_payroll)
      VALUES (v_c, v_e1, v_y, v_m, 'S824 probe A', 1000, 100, true) RETURNING id INTO v_f1;
    INSERT INTO hr_festival_allowances (client_id, employee_id, bs_year, bs_month, festival_name, amount, tds, paid_through_payroll)
      VALUES (v_c, v_e1, v_y, v_m, 'S824 probe separately', 300, 0, false) RETURNING id INTO v_fs;
    INSERT INTO hr_festival_allowances (client_id, employee_id, bs_year, bs_month, festival_name, amount, tds, paid_through_payroll)
      VALUES (v_c, v_e2, v_y, v_m, 'S824 probe A', 800, 0, true) RETURNING id INTO v_f2;
    INSERT INTO hr_incentives (client_id, employee_id, bs_year, bs_month, run_label, amount, tds, paid_through_payroll)
      VALUES (v_c, v_e1, v_y, v_m, 'S824 probe bonus', 500, 50, true) RETURNING id INTO v_i1;
    -- E1's payslip carries F1 and I1: 10000 + (1000 - 100) + (500 - 50) = 11350.
    INSERT INTO hr_payslips (run_id, client_id, employee_id, basic, gross, net_pay,
                             festival_amount, festival_tds, festival_ids, incentive_amount, incentive_tds, incentive_ids)
      VALUES (v_run, v_c, v_e1, 10000, 10000, 11350, 1000, 100, ARRAY[v_f1], 500, 50, ARRAY[v_i1])
      RETURNING id INTO v_ps;

    -- ── As the Owner, through RLS and the triggers ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF NOT COALESCE(public.is_client_owner(), false) OR NOT COALESCE(public.hr_is_manager_rank(), false) THEN
      RAISE EXCEPTION 'S824 probe: % is not an Owner with manager rank here', v_owner;
    END IF;

    -- (a) A with-salary row's tax above its amount is refused.
    BEGIN
      UPDATE hr_festival_allowances SET tds = 5000 WHERE id = v_f1;
      RAISE EXCEPTION 'S824 probe: a with-salary tax above the amount was stored';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- (b) Finalize F1, the separate run and I1: payroll for the month is a draft, both are employed.
    UPDATE hr_festival_allowances SET status = 'finalized' WHERE id IN (v_f1, v_fs);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 2 THEN RAISE EXCEPTION 'S824 probe: the Owner finalized % of 2 festival rows', v_n; END IF;
    UPDATE hr_incentives SET status = 'finalized' WHERE id = v_i1;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'S824 probe: the Owner finalized % of 1 incentive row', v_n; END IF;

    -- (c) The settlement listing sees E1's waiting money, and nothing for E2 (F2 is a draft).
    RESET ROLE;
    v_txt := public.hr_bonus_waiting_on_payroll(v_c, v_e1, v_y, v_m);
    IF v_txt IS NULL OR v_txt NOT LIKE '%S824 probe%' THEN
      RAISE EXCEPTION 'S824 probe: the settlement listing for E1 read %', v_txt;
    END IF;
    IF public.hr_bonus_waiting_on_payroll(v_c, v_e2, v_y, v_m) IS NOT NULL THEN
      RAISE EXCEPTION 'S824 probe: the settlement listing found a draft row for E2';
    END IF;
    SET LOCAL ROLE authenticated;

    -- (d) The net identity counts the bonus: an untouched payslip passes, a wrong net does not.
    UPDATE hr_payslips SET other_deductions = other_deductions WHERE id = v_ps;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'S824 probe: the Owner rewrote % of 1 payslip', v_n; END IF;
    BEGIN
      UPDATE hr_payslips SET net_pay = 10000 WHERE id = v_ps;
      RAISE EXCEPTION 'S824 probe: a net pay without the bonus was stored';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'payslip_net_mismatch:%' THEN RAISE; END IF;
    END;

    -- (e) Not employed in the month: E2 with an End Date before it.
    RESET ROLE;
    UPDATE hr_employees SET end_date = v_lo - 1 WHERE id = v_e2;
    SET LOCAL ROLE authenticated;
    BEGIN
      UPDATE hr_festival_allowances SET status = 'finalized' WHERE id = v_f2;
      RAISE EXCEPTION 'S824 probe: a with-salary row was finalized for someone not employed that month';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'bonus_payroll_not_employed:%' THEN RAISE; END IF;
    END;
    RESET ROLE;
    UPDATE hr_employees SET end_date = NULL WHERE id = v_e2;

    -- (f) Leaving: a DRAFT settlement with the last working day in the month.
    INSERT INTO hr_final_settlements (client_id, employee_id, last_working_date) VALUES (v_c, v_e2, v_lo) RETURNING id INTO v_set;
    SET LOCAL ROLE authenticated;
    BEGIN
      UPDATE hr_festival_allowances SET status = 'finalized' WHERE id = v_f2;
      RAISE EXCEPTION 'S824 probe: a with-salary row was finalized for someone leaving that month';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'bonus_payroll_leaving:%' THEN RAISE; END IF;
    END;
    RESET ROLE;
    DELETE FROM hr_final_settlements WHERE id = v_set;
    SET LOCAL ROLE authenticated;

    -- (g) F2 finalized with no payslip for E2: payroll Finalize names them. Then F2 reopens (payroll is a draft).
    UPDATE hr_festival_allowances SET status = 'finalized' WHERE id = v_f2;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'S824 probe: F2 did not finalize'; END IF;
    BEGIN
      PERFORM public.finalize_payroll_run(v_run, ARRAY[v_ps], '[]'::jsonb);
      RAISE EXCEPTION 'S824 probe: payroll finalized with a with-salary row and no payslip';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'payroll_bonus_no_payslip:%' THEN RAISE; END IF;
    END;
    UPDATE hr_festival_allowances SET status = 'draft' WHERE id = v_f2;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'S824 probe: F2 did not reopen while payroll was a draft'; END IF;

    -- (h) A payslip generated before F1 was finalized (no festival on it): payroll Finalize says stale.
    UPDATE hr_payslips SET festival_amount = 0, festival_tds = 0, festival_ids = '{}', net_pay = 10450 WHERE id = v_ps;
    BEGIN
      PERFORM public.finalize_payroll_run(v_run, ARRAY[v_ps], '[]'::jsonb);
      RAISE EXCEPTION 'S824 probe: payroll finalized without a finalized with-salary festival';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'payroll_bonus_stale:%' THEN RAISE; END IF;
    END;
    UPDATE hr_payslips SET festival_amount = 1000, festival_tds = 100, festival_ids = ARRAY[v_f1], net_pay = 11350 WHERE id = v_ps;

    -- (i) The matching payslip finalizes. The separate run (300) is nowhere on it.
    PERFORM public.finalize_payroll_run(v_run, ARRAY[v_ps], '[]'::jsonb);
    IF (SELECT status FROM hr_payroll_runs WHERE id = v_run) IS DISTINCT FROM 'finalized' THEN
      RAISE EXCEPTION 'S824 probe: the matching payroll did not finalize';
    END IF;

    -- (j) Now the paid rows are fixed: F1 and I1 cannot reopen, F2 cannot finalize into it; the separate run can reopen.
    BEGIN
      UPDATE hr_festival_allowances SET status = 'draft' WHERE id = v_f1;
      RAISE EXCEPTION 'S824 probe: a festival row on a finalized payroll reopened';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'bonus_payroll_finalized:%' THEN RAISE; END IF;
    END;
    BEGIN
      UPDATE hr_incentives SET status = 'draft' WHERE id = v_i1;
      RAISE EXCEPTION 'S824 probe: an incentive row on a finalized payroll reopened';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'bonus_payroll_finalized:%' THEN RAISE; END IF;
    END;
    BEGIN
      UPDATE hr_festival_allowances SET status = 'finalized' WHERE id = v_f2;
      RAISE EXCEPTION 'S824 probe: a with-salary row finalized into a finalized payroll';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'bonus_payroll_finalized:%' THEN RAISE; END IF;
    END;
    BEGIN
      UPDATE hr_festival_allowances SET status = 'draft', paid_through_payroll = false WHERE id = v_f1;
      RAISE EXCEPTION 'S824 probe: a Reopen switched a paid row to separately';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'bonus_payroll_finalized:%' AND SQLERRM NOT LIKE 'bonus_finalized:%' THEN RAISE; END IF;
    END;
    UPDATE hr_festival_allowances SET status = 'draft' WHERE id = v_fs;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'S824 probe: the separately-paid row did not reopen'; END IF;

    -- (k) Crest Staff's payslip query, as a scratch function with the same SELECT and RETURNS TABLE (the real
    --     one needs a Self-Service login), so the tuple types are really compared.
    RESET ROLE;
    CREATE FUNCTION pg_temp.s824_staff_payslip(p_payslip uuid)
     RETURNS TABLE(id uuid, bs_year integer, bs_month integer, run_status text, pay_basis text, basic numeric, allowances numeric, gross numeric, ot_hours numeric, ot_amount numeric, worked_days numeric, hours_worked numeric, present_days numeric, absent_days numeric, absence_deduction numeric, ssf_employee numeric, ssf_employer numeric, other_deductions numeric, advance_deduction numeric, tds numeric, tada_amount numeric, net_pay numeric, full_name text, employee_code text, department text, ssf_no text, ssf_enrolled boolean, unpaid_days numeric, retirement_contribution numeric, festival_amount numeric, festival_tds numeric, festival_label text, incentive_amount numeric, incentive_tds numeric, incentive_label text)
     LANGUAGE plpgsql
    AS $f$
    BEGIN
      RETURN QUERY
        SELECT p.id, mp.bs_year, mp.bs_month, r.status,
               p.pay_basis, p.basic, p.allowances, p.gross,
               p.ot_hours, p.ot_amount,
               p.worked_days, p.hours_worked, p.present_days, p.absent_days,
               p.absence_deduction, p.ssf_employee, p.ssf_employer,
               p.other_deductions, p.advance_deduction, p.tds,
               p.tada_amount, p.net_pay,
               e.full_name, e.employee_code, e.department, e.ssf_no, e.ssf_enrolled,
               p.unpaid_days, p.retirement_contribution,
               p.festival_amount, p.festival_tds,
               (SELECT string_agg(f.festival_name::text, ', ' ORDER BY f.festival_name)
                  FROM public.hr_festival_allowances f WHERE f.id = ANY (p.festival_ids)),
               p.incentive_amount, p.incentive_tds,
               (SELECT string_agg(i.run_label::text, ', ' ORDER BY i.run_label)
                  FROM public.hr_incentives i WHERE i.id = ANY (p.incentive_ids))
        FROM public.hr_payslips p
        JOIN public.hr_payroll_runs r ON r.id = p.run_id
        JOIN public.monthly_periods mp ON mp.id = r.period_id
        JOIN public.hr_employees e ON e.id = p.employee_id
        WHERE p.id = p_payslip;
    END;
    $f$;
    SELECT * INTO v_row FROM pg_temp.s824_staff_payslip(v_ps);
    IF v_row.festival_amount IS DISTINCT FROM 1000 OR v_row.festival_tds IS DISTINCT FROM 100
       OR v_row.festival_label IS DISTINCT FROM 'S824 probe A'
       OR v_row.incentive_amount IS DISTINCT FROM 500 OR v_row.incentive_label IS DISTINCT FROM 'S824 probe bonus'
       OR v_row.net_pay IS DISTINCT FROM 11350 THEN
      RAISE EXCEPTION 'S824 probe: the Staff payslip read festival % / % "%", incentive % "%", net %',
        v_row.festival_amount, v_row.festival_tds, v_row.festival_label, v_row.incentive_amount, v_row.incentive_label, v_row.net_pay;
    END IF;
    DROP FUNCTION pg_temp.s824_staff_payslip(uuid);

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's824_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's824_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT p.oid::regprocedure, md5(prosrc), prosecdef, proconfig, proacl FROM pg_proc p
--    WHERE oid IN ('public.hr_bonus_rows_guard()'::regprocedure, 'public.hr_payslips_guard_net()'::regprocedure,
--                  'public.finalize_payroll_run(uuid,uuid[],jsonb)'::regprocedure,
--                  'public.finalize_final_settlement(uuid)'::regprocedure, 'public.get_my_hr_payslips()'::regprocedure,
--                  'public.hr_bonus_payroll_block(uuid,uuid,integer,integer)'::regprocedure,
--                  'public.hr_bonus_waiting_on_payroll(uuid,uuid,integer,integer)'::regprocedure);
--     expect the second hashes of section 0
--   SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
--    WHERE table_schema = 'public' AND (column_name = 'paid_through_payroll'
--       OR (table_name = 'hr_payslips' AND (column_name LIKE 'festival_%' OR column_name LIKE 'incentive_%')));
--   SELECT conrelid::regclass, conname FROM pg_constraint
--    WHERE conname IN ('hr_payslips_bonus_check', 'hr_festival_allowances_payroll_tds_check', 'hr_incentives_payroll_tds_check');
--   SELECT count(*) FROM hr_festival_allowances WHERE paid_through_payroll;   -- 0 (until the new page is used)
--   SELECT count(*) FROM hr_incentives WHERE paid_through_payroll;            -- 0
