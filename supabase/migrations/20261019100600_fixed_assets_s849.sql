-- STATUS: complete (draft for review; not applied). Suggested file name:
--   supabase/migrations/20261016120000_fixed_assets_s849.sql
--
-- S849 — Fixed Assets fixes from the S848 Suite review (cluster ASSETS).
--
-- Findings covered: ASSETS-2 / ASSETS-10 (§2 line columns), ASSETS-4 (§1), ASSETS-9 + SU7 (b) (§6),
-- ASSETS-12 + S848.2 "the schedule's asset link is NO ACTION" + the asset columns of DATABASE-3 (§3),
-- ASSETS-13 (§7), DATABASE-4 (§2), DATABASE-9 asset numbering (§4), GAPS-12 (§5).
-- ASSETS-1, -3, -5, -6, -8, -10 (print), -11, -14..-18 need no migration (browser code).
--
-- Objects, and how to roll each back:
--   §1 FUNCTION enforce_asset_run_posted_immutable()  NEW   rollback: DROP TRIGGER trg_enforce_asset_run_posted_immutable
--        ON assets_depreciation_runs / ON assets_tax_pool_runs; DROP FUNCTION enforce_asset_run_posted_immutable();
--      TRIGGER trg_enforce_asset_run_posted_immutable on assets_depreciation_runs, assets_tax_pool_runs  NEW
--   §2 CONSTRAINT assets_tax_pool_runs_fiscal_year_check  NEW  rollback: ALTER TABLE assets_tax_pool_runs DROP CONSTRAINT ...
--      COLUMNS assets_tax_pool_lines.repair_carried_in, balancing_income, terminal_deduction  NEW
--        rollback: ALTER TABLE assets_tax_pool_lines DROP COLUMN ... (the browser stops sending them first)
--      CONSTRAINT assets_tax_pool_lines_figures_check  NEW  rollback: DROP CONSTRAINT
--      FUNCTION post_tax_pool_run(uuid, text, jsonb, text)  REPLACED (same signature and return)
--        rollback: re-run its body from 20260803150000_post_tax_pool_run.sql
--   §3 FUNCTION assets_same_client()  NEW  rollback: DROP TRIGGER assets_same_client ON the four tables; DROP FUNCTION
--      TRIGGER assets_same_client on assets_register, assets_repair_expenses, assets_depreciation_schedule,
--        assets_tax_pool_lines  NEW
--      FUNCTION post_asset_depreciation_run(uuid, date, date, jsonb, text)  REPLACED (same signature)
--        rollback: re-run §13 of 20260928140000_ims_integrity_s792.sql
--   §4 FUNCTION assign_asset_code()  REPLACED  rollback: re-run it from 20260803110000_fixed_asset_register.sql,
--        then REVOKE ALL ... FROM PUBLIC, anon, authenticated (20260907130000 §1)
--      FUNCTION ims_assets_register_guard()  REPLACED  rollback: re-run §7 of 20260918100000_ims_integrity_s756.sql
--   §5 TRIGGER audit_assets_depreciation_schedule  NEW  rollback: DROP TRIGGER ... ON assets_depreciation_schedule
--   §6 TABLE assets_tax_pool_opening_corrections (+ index, 6 policies, audit trigger, grants)  NEW
--        rollback: DROP TABLE assets_tax_pool_opening_corrections (policies and triggers go with it)
--      FUNCTION correct_tax_pool_openings(uuid, text, jsonb, text)  NEW  rollback: DROP FUNCTION
--      FUNCTION assets_tax_pool_openings_lock()  REPLACED (refusal wording only)
--        rollback: re-run it from 20260929110000_fixed_asset_openings_s792.sql
--   §7 POLICY assets_read_ims_supervisor (RESTRICTIVE, SELECT) on the nine asset tables  NEW
--        rollback: DROP POLICY assets_read_ims_supervisor ON each
--   §8 COMMENTs on assets_tax_pool_runs.fiscal_year and assets_tax_pool_lines.repair_expense_deductible
--      (rollback: none needed)
--   DATA: §2b backfills assets_tax_pool_lines.repair_carried_in on the lines already posted (5 live rows,
--      all 0 today). Rollback: none (the column is dropped with the rollback above).
--
-- Not touched here, for the lead's ordering: the audit triggers DATABASE-5 (ACCESS) adds to
-- assets_repair_expenses and assets_categories. §3 adds a same-client trigger and §7 a read policy on
-- both tables; neither conflicts with an audit trigger, so the two migrations can apply in either order.
-- DATABASE-3: §3 covers its asset-table columns (register.category_id, repair_expenses.asset_id,
-- schedule.asset_id/run_id, tax_pool_lines.run_id). After the S849 merge, ACCESS's migration (§6
-- suite_same_client) covers only demand_forecast_daily.recipe_id, and the OR migration's
-- owner_report_1_same_client covers monthly_owner_reports.period_id.

BEGIN;


-- ══ 1. ASSETS-4: a posted run header is as fixed as its lines ═══════════════════════════════════
--
-- Only the lines were immutable. An IMS manager could PATCH a posted header to 'draft' or to another
-- fiscal year: the next tax preview then stopped opening from it, the typed openings unlocked, and on
-- the book side the run vanished from the overlap warning, the two-minute duplicate refusal and the
-- Adjustment picker while its lines kept charging. Same carve-out as enforce_asset_schedule_immutable
-- (auth.uid() IS NULL: the service role's Danger Zone / Archive / Delete asset, and cascades from them).
CREATE OR REPLACE FUNCTION public.enforce_asset_run_posted_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND OLD.status = 'posted' THEN
    RAISE EXCEPTION 'asset_run_posted: a posted % cannot be changed or deleted. Post a new one instead.',
      CASE TG_TABLE_NAME WHEN 'assets_tax_pool_runs' THEN 'tax pool schedule' ELSE 'depreciation run' END
      USING ERRCODE = '42501', HINT = 'asset_run_posted';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_asset_run_posted_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_enforce_asset_run_posted_immutable ON public.assets_depreciation_runs;
CREATE TRIGGER trg_enforce_asset_run_posted_immutable
  BEFORE UPDATE OR DELETE ON public.assets_depreciation_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_asset_run_posted_immutable();
DROP TRIGGER IF EXISTS trg_enforce_asset_run_posted_immutable ON public.assets_tax_pool_runs;
CREATE TRIGGER trg_enforce_asset_run_posted_immutable
  BEFORE UPDATE OR DELETE ON public.assets_tax_pool_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_asset_run_posted_immutable();


-- ══ 2. DATABASE-4, ASSETS-2, ASSETS-10: the tax schedule's shape and its post ════════════════════
--
-- DATABASE-4: a run's fiscal year was free text. The openings lock reads it through
-- tax_pool_fy_start(), which is NULL for "2082/83" (the spelling the old column comment suggested),
-- so such a run never locked anything. The app always writes "83/84"; the one live run is "83/84".
-- Pre-flight (S849 open-items pass, like the M3 one below): the column comment once suggested
-- "2082/83", so an older run may carry that spelling. Name every run the CHECK would refuse (id,
-- client, value) instead of a bare 23514. fiscal_year is NOT NULL (20260803140000:19), so NULL cannot
-- slip past. Repair, if any is named: as the migration role (auth.uid() IS NULL passes §1's lock and
-- the rank guard), UPDATE assets_tax_pool_runs SET fiscal_year = '<yy>/<yy>' (e.g. '2082/83' →
-- '82/83') on exactly the named ids, after checking no other run of that client already holds it.
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(format('%s (client %s, %L)', r.id, r.client_id, r.fiscal_year), ', ' ORDER BY r.client_id, r.id)
    INTO v_bad
    FROM public.assets_tax_pool_runs r
   WHERE r.fiscal_year IS NULL OR r.fiscal_year !~ '^\d{1,2}/\d{1,2}$';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'S849 ASSETS §2: these tax pool schedules spell the fiscal year another way than "83/84"; correct them first: %', v_bad;
  END IF;
END;
$$;
ALTER TABLE public.assets_tax_pool_runs DROP CONSTRAINT IF EXISTS assets_tax_pool_runs_fiscal_year_check;
ALTER TABLE public.assets_tax_pool_runs ADD CONSTRAINT assets_tax_pool_runs_fiscal_year_check
  CHECK (fiscal_year ~ '^\d{1,2}/\d{1,2}$');

-- ASSETS-10: the repair excess carried in from last year joins the base but sat in no column, so a
-- printed row did not add up. ASSETS-2: Schedule 2 §4(1) puts disposal proceeds above the pool's base
-- into business income and floors the base at 0 (§2(3) proviso); §4(2) dissolves a pool whose assets
-- are all gone and allows what is left as a deduction that year. Until now the closing value went
-- negative instead, and the excess quietly cut every later year's depreciation.
ALTER TABLE public.assets_tax_pool_lines
  ADD COLUMN IF NOT EXISTS repair_carried_in  numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS balancing_income   numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS terminal_deduction numeric NOT NULL DEFAULT 0;

-- ── 2b. DATA: repair_carried_in for the lines already posted ─────────────────────────────────────
-- Recovers the carried-in excess from the figures each posted line already holds: base less the
-- part of it that is opening, prorated additions and disposals (a negative or clamped base leaves 0).
-- Live 2026-10-15: 5 lines (CASA ACAI CAFE FY 83/84), every base 0, so every value is 0. Runs as the
-- migration role, so the lines' immutability trigger (auth.uid() IS NULL) and rank guard
-- (current_user) let it through; nothing else on the line changes.
UPDATE public.assets_tax_pool_lines
   SET repair_carried_in = GREATEST(0, round(depreciation_base - (opening_wdv - disposal_proceeds + additions_full
                                                + additions_two_third * 2 / 3 + additions_one_third / 3), 2))
 WHERE pool IN ('A', 'B', 'C', 'D')
   AND depreciation_base > 0;

-- Lead, S849 merge (review M3): name any posted line that would block the CHECK, instead of a bare 23514.
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(id::text || ' (pool ' || pool || ')', ', ') INTO v_bad
    FROM public.assets_tax_pool_lines
   WHERE NOT (closing_wdv >= 0 AND closing_wdv <> 'NaN'
              AND depreciation_amount >= 0 AND depreciation_amount <> 'NaN'
              AND COALESCE(repair_carried_in, 0) >= 0 AND COALESCE(balancing_income, 0) >= 0
              AND COALESCE(terminal_deduction, 0) >= 0);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'S849 ASSETS §2: these tax pool lines carry a negative or NaN figure; resolve them first: %', v_bad;
  END IF;
END;
$$;
ALTER TABLE public.assets_tax_pool_lines DROP CONSTRAINT IF EXISTS assets_tax_pool_lines_figures_check;
ALTER TABLE public.assets_tax_pool_lines ADD CONSTRAINT assets_tax_pool_lines_figures_check
  CHECK (closing_wdv >= 0 AND closing_wdv <> 'NaN'
         AND depreciation_amount >= 0 AND depreciation_amount <> 'NaN'
         AND repair_carried_in >= 0 AND repair_carried_in <> 'NaN'
         AND balancing_income >= 0 AND balancing_income <> 'NaN'
         AND terminal_deduction >= 0 AND terminal_deduction <> 'NaN');

-- DATABASE-4: the COSTS-16 serialisation and two-minute duplicate refusal the book run has had since
-- S792 §13, a refusal of any other fiscal-year spelling, and the three new line figures (an older
-- cached page that does not send them posts 0, which is what they were).
-- Body: 20260803150000 (only definition), plus the checks, the lock and the three columns.
CREATE OR REPLACE FUNCTION public.post_tax_pool_run(
  p_client_id uuid, p_fiscal_year text, p_lines jsonb, p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_run_id uuid;
BEGIN
  IF p_fiscal_year IS NULL OR p_fiscal_year !~ '^\d{1,2}/\d{1,2}$' THEN
    RAISE EXCEPTION 'tax_pool_fy_format: the fiscal year must be written like 83/84, not %', COALESCE(p_fiscal_year, 'blank')
      USING ERRCODE = '22023', HINT = 'tax_pool_fy_format';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'tax_pool_no_lines: a tax pool schedule needs its pool lines'
      USING ERRCODE = '22023', HINT = 'tax_pool_no_lines';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('post_tax_pool_run:' || p_client_id::text, 0));
  IF EXISTS (SELECT 1 FROM assets_tax_pool_runs r
              WHERE r.client_id = p_client_id AND r.status = 'posted'
                AND r.fiscal_year = p_fiscal_year
                AND r.notes IS NOT DISTINCT FROM p_notes
                AND r.posted_at > now() - interval '2 minutes') THEN
    RAISE EXCEPTION 'tax_run_duplicate: this schedule was posted moments ago, from this page or another'
      USING ERRCODE = 'P0001', HINT = 'tax_run_duplicate';
  END IF;

  INSERT INTO assets_tax_pool_runs (client_id, fiscal_year, status, posted_at, posted_by, created_by, notes)
  VALUES (p_client_id, p_fiscal_year, 'posted', now(), auth.uid(), auth.uid(), p_notes)
  RETURNING id INTO v_run_id;

  INSERT INTO assets_tax_pool_lines (
    client_id, run_id, pool,
    opening_wdv, repair_carried_in, additions_full, additions_two_third, additions_one_third, disposal_proceeds,
    repair_expense_total, repair_expense_deductible, repair_expense_capitalized,
    depreciation_base, depreciation_amount, balancing_income, terminal_deduction, closing_wdv, is_posted
  )
  SELECT
    p_client_id, v_run_id, l->>'pool',
    (l->>'opening_wdv')::numeric, COALESCE((l->>'repair_carried_in')::numeric, 0),
    (l->>'additions_full')::numeric, (l->>'additions_two_third')::numeric,
    (l->>'additions_one_third')::numeric, (l->>'disposal_proceeds')::numeric,
    (l->>'repair_expense_total')::numeric, (l->>'repair_expense_deductible')::numeric,
    (l->>'repair_expense_capitalized')::numeric,
    (l->>'depreciation_base')::numeric, (l->>'depreciation_amount')::numeric,
    COALESCE((l->>'balancing_income')::numeric, 0), COALESCE((l->>'terminal_deduction')::numeric, 0),
    (l->>'closing_wdv')::numeric, true
  FROM jsonb_array_elements(p_lines) AS l;

  RETURN v_run_id;
END $$;

REVOKE EXECUTE ON FUNCTION public.post_tax_pool_run(uuid, text, jsonb, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.post_tax_pool_run(uuid, text, jsonb, text) TO authenticated, service_role;


-- ══ 3. ASSETS-12, S848.2, DATABASE-3 (asset columns): every link stays inside one business ════════
--
-- RLS checks only a row's own client_id. A manager with Outlet Access to two outlets can read both
-- outlets' ids, so a schedule line, a repair, an asset or a tax pool line could name the OTHER
-- outlet's asset, category or run. assets_depreciation_schedule.asset_id and
-- assets_register.category_id are NO ACTION, so such a row then stops the other outlet's operator
-- Delete asset, Archive, Danger Zone and Clear IMS partway (deleteAsset clears schedule rows for its
-- own client_id only); the CASCADE / SET NULL ones silently lose the row or the link. The S792
-- ims_item_same_client shape: SECURITY DEFINER, so the lookup sees the foreign row; a NULL link or a
-- parent that does not exist is left to the FK.
CREATE OR REPLACE FUNCTION public.assets_same_client()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_other boolean := false;
  v_what  text;
BEGIN
  CASE TG_ARGV[0]
    WHEN 'register' THEN
      IF NEW.category_id IS NOT NULL THEN
        v_what := 'asset category';
        v_other := COALESCE((SELECT c.client_id <> NEW.client_id FROM assets_categories c WHERE c.id = NEW.category_id), false);
      END IF;
    WHEN 'repair' THEN
      IF NEW.asset_id IS NOT NULL THEN
        v_what := 'asset';
        v_other := COALESCE((SELECT a.client_id <> NEW.client_id FROM assets_register a WHERE a.id = NEW.asset_id), false);
      END IF;
    WHEN 'schedule' THEN
      v_what := 'asset';
      v_other := COALESCE((SELECT a.client_id <> NEW.client_id FROM assets_register a WHERE a.id = NEW.asset_id), false);
      IF NOT v_other THEN
        v_what := 'depreciation run';
        v_other := COALESCE((SELECT r.client_id <> NEW.client_id FROM assets_depreciation_runs r WHERE r.id = NEW.run_id), false);
      END IF;
    WHEN 'pool_line' THEN
      v_what := 'tax pool schedule';
      v_other := COALESCE((SELECT r.client_id <> NEW.client_id FROM assets_tax_pool_runs r WHERE r.id = NEW.run_id), false);
    ELSE
      RAISE EXCEPTION 'assets_same_client: unknown kind %', TG_ARGV[0];
  END CASE;

  IF v_other THEN
    RAISE EXCEPTION 'asset_other_client: that % belongs to another business', v_what
      USING ERRCODE = '23503', HINT = 'asset_other_client';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.assets_same_client() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS assets_same_client ON public.assets_register;
CREATE TRIGGER assets_same_client BEFORE INSERT OR UPDATE OF category_id, client_id ON public.assets_register
  FOR EACH ROW EXECUTE FUNCTION public.assets_same_client('register');
DROP TRIGGER IF EXISTS assets_same_client ON public.assets_repair_expenses;
CREATE TRIGGER assets_same_client BEFORE INSERT OR UPDATE OF asset_id, client_id ON public.assets_repair_expenses
  FOR EACH ROW EXECUTE FUNCTION public.assets_same_client('repair');
DROP TRIGGER IF EXISTS assets_same_client ON public.assets_depreciation_schedule;
CREATE TRIGGER assets_same_client BEFORE INSERT OR UPDATE OF asset_id, run_id, client_id ON public.assets_depreciation_schedule
  FOR EACH ROW EXECUTE FUNCTION public.assets_same_client('schedule');
DROP TRIGGER IF EXISTS assets_same_client ON public.assets_tax_pool_lines;
CREATE TRIGGER assets_same_client BEFORE INSERT OR UPDATE OF run_id, client_id ON public.assets_tax_pool_lines
  FOR EACH ROW EXECUTE FUNCTION public.assets_same_client('pool_line');

-- ASSETS-12: a page open since the morning still holds an asset another tab has disposed of, and
-- posted a run charging it past its disposal date, moving the book value the disposal froze. Every
-- line's asset must be this business's and still active. A disposal's own charge is posted before the
-- status change (AssetCard), so it passes; a reversal only ever names active assets (previewReversal).
-- INVOKER, so the lookup runs under the caller's RLS: an asset the caller cannot see is refused too.
-- Body: 20260928140000 §13 (live md5 66dcbd13…), plus the asset check.
CREATE OR REPLACE FUNCTION public.post_asset_depreciation_run(
  p_client_id uuid, p_period_start date, p_period_end date, p_lines jsonb, p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_run_id uuid;
  v_bad    text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('post_asset_depreciation_run:' || p_client_id::text, 0));
  IF EXISTS (SELECT 1 FROM assets_depreciation_runs r
              WHERE r.client_id = p_client_id AND r.status = 'posted'
                AND r.period_start = p_period_start AND r.period_end = p_period_end
                AND r.notes IS NOT DISTINCT FROM p_notes
                AND r.posted_at > now() - interval '2 minutes') THEN
    RAISE EXCEPTION 'dep_run_duplicate: this run was posted moments ago, from this page or another'
      USING ERRCODE = 'P0001', HINT = 'dep_run_duplicate';
  END IF;

  SELECT string_agg(COALESCE(a.asset_code, l->>'asset_id'), ', ') INTO v_bad
    FROM jsonb_array_elements(p_lines) AS l
    LEFT JOIN assets_register a ON a.id = (l->>'asset_id')::uuid
   WHERE a.id IS NULL OR a.client_id IS DISTINCT FROM p_client_id OR a.status IS DISTINCT FROM 'active';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'dep_run_asset_not_active: % is no longer an active asset of this business', v_bad
      USING ERRCODE = 'P0001', HINT = 'dep_run_asset_not_active';
  END IF;

  INSERT INTO assets_depreciation_runs (client_id, period_start, period_end, status, posted_at, posted_by, created_by, notes)
  VALUES (p_client_id, p_period_start, p_period_end, 'posted', now(), auth.uid(), auth.uid(), p_notes)
  RETURNING id INTO v_run_id;

  INSERT INTO assets_depreciation_schedule (
    client_id, run_id, asset_id, period_start, period_end,
    opening_nbv, annual_depreciation, depreciation_amount, override_amount, override_reason,
    closing_nbv, is_posted
  )
  SELECT
    p_client_id, v_run_id, (l->>'asset_id')::uuid, p_period_start, p_period_end,
    (l->>'opening_nbv')::numeric, (l->>'annual_depreciation')::numeric,
    (l->>'depreciation_amount')::numeric, NULLIF(l->>'override_amount','')::numeric, l->>'override_reason',
    (l->>'closing_nbv')::numeric, true
  FROM jsonb_array_elements(p_lines) AS l;

  RETURN v_run_id;
END $$;


-- ══ 4. DATABASE-9 (asset numbering) ══════════════════════════════════════════════════════════════
--
-- The trigger numbered MAX of '^AST-(\d+)$' + 1 into lpad(…, 4): lpad TRUNCATES, so one code edited
-- to AST-9999 over REST made the next AST-1000 and every one after it collide on the unique key, and
-- AST-99999999999 overflowed the integer cast. Live (S848.2): all 17 codes are FA-001…FA-010 (BLOOM's
-- two outlets), so the next asset added in the app would start a parallel AST-0001 series beside them.
-- Now: continue the series of the business's newest coded asset (FA-010 → FA-011, keeping its width),
-- else AST-0001; never truncate; bigint. Body: 20260803110000 (only definition), reworked.
CREATE OR REPLACE FUNCTION public.assign_asset_code() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_prefix text;
  v_width  integer;
  v_next   bigint;
BEGIN
  IF NEW.asset_code IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('asset_code:' || NEW.client_id::text));
    SELECT s.m[1], length(s.m[2]) INTO v_prefix, v_width
      FROM (SELECT regexp_match(r.asset_code, '^([A-Za-z]{1,10})-(\d{1,18})$') AS m, r.created_at, r.id
              FROM assets_register r
             WHERE r.client_id = NEW.client_id AND r.asset_code IS NOT NULL) s
     WHERE s.m IS NOT NULL
     ORDER BY s.created_at DESC NULLS LAST, s.id DESC
     LIMIT 1;
    v_prefix := COALESCE(v_prefix, 'AST');
    v_width  := COALESCE(v_width, 4);
    -- v_prefix is letters only (the regex above), so it is safe inside the pattern.
    SELECT COALESCE(MAX((regexp_match(asset_code, '^' || v_prefix || '-(\d{1,18})$'))[1]::bigint), 0) + 1
      INTO v_next
      FROM assets_register WHERE client_id = NEW.client_id;
    NEW.asset_code := v_prefix || '-' || lpad(v_next::text, GREATEST(v_width, length(v_next::text)), '0');
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.assign_asset_code() FROM PUBLIC, anon, authenticated;

-- The code is the trigger's to give (no screen sets it), so a client session may neither choose one
-- on insert nor change one afterwards; the operator (restore) and the service role still may.
-- ASSETS-12 (Where): a supervisor's INSERT could carry status 'disposed' and any gain, since the
-- disposal columns were raised to manager on UPDATE only. Now an insert carrying any of them needs a
-- manager too. Body: 20260918100000 §7 (only definition), plus those two rules.
CREATE OR REPLACE FUNCTION public.ims_assets_register_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  c_disposal constant text[] := ARRAY['status', 'disposal_date', 'disposal_proceeds', 'disposal_gain_loss', 'disposal_reason'];
  v_need text := 'supervisor';
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- Nested IFs, never one AND over NEW: NEW is NULL on a DELETE.
  IF TG_OP = 'INSERT' THEN
    IF NEW.asset_code IS NOT NULL THEN
      RAISE EXCEPTION 'asset_code_locked: Crest numbers each asset itself, so a code cannot be chosen'
        USING ERRCODE = '42501', HINT = 'asset_code_locked';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.asset_code IS DISTINCT FROM OLD.asset_code THEN
      RAISE EXCEPTION 'asset_code_locked: an asset''s code cannot be changed'
        USING ERRCODE = '42501', HINT = 'asset_code_locked';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_need := 'manager';
  ELSIF TG_OP = 'UPDATE' AND EXISTS (
          SELECT 1 FROM unnest(c_disposal) k
           WHERE (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k)) THEN
    v_need := 'manager';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'active' OR NEW.disposal_date IS NOT NULL OR NEW.disposal_proceeds IS NOT NULL
       OR NEW.disposal_gain_loss IS NOT NULL OR NEW.disposal_reason IS NOT NULL THEN
      v_need := 'manager';
    END IF;
  END IF;
  IF NOT public.ims_caller_has_rank(v_need) THEN
    RAISE EXCEPTION 'assets_register: % needs an IMS % or the account owner',
      CASE v_need WHEN 'manager' THEN 'disposing of or deleting an asset' ELSE 'changing the asset register' END, v_need
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.ims_assets_register_guard() FROM PUBLIC;


-- ══ 5. GAPS-12: a deleted depreciation line leaves a record ══════════════════════════════════════
--
-- The operator's Delete asset (admin-user-ops, service role) removes the asset's posted schedule lines
-- with no trace of what they charged, and every closed month's Overheads depreciation memo that
-- counted them drops. log_audit() snapshots the whole row, and the service-role client carries
-- x-crest-actor, so each removed line is now in the Audit Log under the operator's name. UPDATE is
-- included for completeness (a posted line refuses one anyway). INSERT is not: a posted line is
-- itself the record, and its run header's insert is already audited.
CREATE OR REPLACE TRIGGER audit_assets_depreciation_schedule
  AFTER DELETE OR UPDATE ON public.assets_depreciation_schedule
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();


-- ══ 6. ASSETS-9, owner decision SU7 (b): the client corrects a wrong typed opening value ═════════
--
-- A typed opening locks once a schedule that uses it is posted (D40 Q4), and nothing could correct it
-- afterwards except the operator: a second schedule for the year re-read the same locked value.
-- SU7 (b): the business corrects it itself. The rules:
--   * Who: the Owner, an IMS manager (never a count PIN), or the operator — the people who post the
--     schedules, since every correction is followed by posting them again.
--   * How: only through correct_tax_pool_openings(), with a reason. It records old → new, the reason,
--     who and when, and the posted years at that moment, in assets_tax_pool_opening_corrections, which
--     no browser session can edit or delete.
--   * What it does NOT do: change or delete a posted schedule. Those stay on record as posted. The
--     Tax tab lists every posted year whose opening no longer matches what it would open from today
--     (worked out from the figures, in taxPoolCompute.js), oldest first, to post again; each new
--     schedule is the one the next year opens from.
--   * Refused: a pool or year that is not locked (edit it on the card), a year whose year-before has a
--     posted schedule (it opens from that, not from a typed value), a pool whose opening is saved for
--     another year, a blank or short reason, an unchanged value.

CREATE TABLE IF NOT EXISTS public.assets_tax_pool_opening_corrections (
    id                        uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    client_id                 uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    pool                      text NOT NULL CHECK (pool IN ('A','B','C','D')),
    fiscal_year               text NOT NULL CHECK (fiscal_year ~ '^\d{1,2}/\d{1,2}$'),
    -- NULL: no value had been typed for this pool before the correction.
    old_opening_wdv           numeric,
    old_repair_carry_forward  numeric,
    new_opening_wdv           numeric NOT NULL CHECK (new_opening_wdv >= 0 AND new_opening_wdv <> 'NaN'),
    new_repair_carry_forward  numeric NOT NULL DEFAULT 0
                                CHECK (new_repair_carry_forward >= 0 AND new_repair_carry_forward <> 'NaN'),
    reason                    text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500),
    -- The posted years (its own and every later one) at the moment of the correction, oldest first.
    posted_years              text[] NOT NULL DEFAULT '{}'::text[],
    corrected_by              uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    corrected_at              timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assets_tax_pool_opening_corrections_client_idx
  ON public.assets_tax_pool_opening_corrections (client_id, corrected_at DESC);

ALTER TABLE public.assets_tax_pool_opening_corrections ENABLE ROW LEVEL SECURITY;

-- Read: the business and the operator. Insert: the operator only (Restore); a business writes only
-- through correct_tax_pool_openings(). No UPDATE or DELETE grant to any browser role: the record is
-- fixed once written (Danger Zone / Archive delete it with the service role).
DROP POLICY IF EXISTS assets_tax_pool_opening_corrections_read ON public.assets_tax_pool_opening_corrections;
CREATE POLICY assets_tax_pool_opening_corrections_read ON public.assets_tax_pool_opening_corrections
  FOR SELECT TO authenticated
  USING (COALESCE((select public.is_admin()), false) OR client_id = (select public.my_client_id()));
DROP POLICY IF EXISTS assets_tax_pool_opening_corrections_restore ON public.assets_tax_pool_opening_corrections;
CREATE POLICY assets_tax_pool_opening_corrections_restore ON public.assets_tax_pool_opening_corrections
  FOR INSERT TO authenticated
  WITH CHECK (COALESCE((select public.is_admin()), false));

-- The same 3-of-4 RESTRICTIVE staff-isolation set as every other asset table (20260803110000).
DROP POLICY IF EXISTS no_self_service_accounts ON public.assets_tax_pool_opening_corrections;
CREATE POLICY no_self_service_accounts ON public.assets_tax_pool_opening_corrections AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service());
DROP POLICY IF EXISTS no_pos_pin_staff ON public.assets_tax_pool_opening_corrections;
CREATE POLICY no_pos_pin_staff ON public.assets_tax_pool_opening_corrections AS RESTRICTIVE FOR ALL
  USING (NOT public.is_pos_pin_staff()) WITH CHECK (NOT public.is_pos_pin_staff());
DROP POLICY IF EXISTS no_hr_role_staff ON public.assets_tax_pool_opening_corrections;
CREATE POLICY no_hr_role_staff ON public.assets_tax_pool_opening_corrections AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff());

CREATE OR REPLACE TRIGGER audit_assets_tax_pool_opening_corrections
  AFTER INSERT OR DELETE OR UPDATE ON public.assets_tax_pool_opening_corrections
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();

REVOKE ALL ON public.assets_tax_pool_opening_corrections FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT ON public.assets_tax_pool_opening_corrections TO authenticated;
GRANT ALL ON public.assets_tax_pool_opening_corrections TO service_role;

-- SECURITY DEFINER: the sanctioned path through the openings lock (whose carve-out is current_user),
-- the same seam force_delete_item() and set_active_outlet() use. It bypasses RLS, so it checks the
-- caller itself: the outlet's own session (or the operator), not a fenced staff kind, and the IMS
-- manager rank (ims_caller_has_rank: the Owner and the operator pass, a count PIN never does).
-- Serialised with post_tax_pool_run on the same per-client lock, so a correction and a post cannot
-- interleave.
CREATE OR REPLACE FUNCTION public.correct_tax_pool_openings(
  p_client_id uuid, p_fiscal_year text, p_values jsonb, p_reason text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_fy     integer := public.tax_pool_fy_start(p_fiscal_year);
  v_posted text[];
  v_val    jsonb;
  v_pool   text;
  v_wdv    numeric;
  v_rep    numeric;
  v_old    public.assets_tax_pool_openings;
  v_had    boolean;
  v_n      integer := 0;
BEGIN
  -- Who.
  IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(p_client_id = public.my_client_id(), false)) THEN
    RAISE EXCEPTION 'tax_pool_correction_denied: you can only correct your own business''s opening values'
      USING ERRCODE = '42501', HINT = 'tax_pool_correction_denied';
  END IF;
  IF COALESCE(public.is_hr_self_service(), false) OR COALESCE(public.is_pos_pin_staff(), false)
     OR COALESCE(public.is_hr_role_staff(), false) THEN
    RAISE EXCEPTION 'tax_pool_correction_denied: this login cannot correct tax pool opening values'
      USING ERRCODE = '42501', HINT = 'tax_pool_correction_denied';
  END IF;
  IF NOT COALESCE(public.ims_caller_has_rank('manager'), false) THEN
    RAISE EXCEPTION 'tax_pool_opening_values: correcting a tax pool opening value needs an IMS manager or the account owner'
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;

  -- What.
  IF p_fiscal_year IS NULL OR p_fiscal_year !~ '^\d{1,2}/\d{1,2}$' OR v_fy IS NULL THEN
    RAISE EXCEPTION 'tax_pool_fy_format: the fiscal year must be written like 83/84'
      USING ERRCODE = '22023', HINT = 'tax_pool_fy_format';
  END IF;
  IF char_length(v_reason) < 10 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'tax_pool_correction_reason: give a reason of 10 to 500 characters'
      USING ERRCODE = '22023', HINT = 'tax_pool_correction_reason';
  END IF;
  IF p_values IS NULL OR jsonb_typeof(p_values) IS DISTINCT FROM 'array' OR jsonb_array_length(p_values) = 0 THEN
    RAISE EXCEPTION 'tax_pool_correction_values: no values were sent'
      USING ERRCODE = '22023', HINT = 'tax_pool_correction_values';
  END IF;
  IF (SELECT count(DISTINCT x->>'pool') FROM jsonb_array_elements(p_values) x) <> jsonb_array_length(p_values) THEN
    RAISE EXCEPTION 'tax_pool_correction_values: each pool may appear once'
      USING ERRCODE = '22023', HINT = 'tax_pool_correction_values';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('post_tax_pool_run:' || p_client_id::text, 0));

  -- The year before has a posted schedule: this year opens from it, so a typed value is never used.
  IF EXISTS (SELECT 1 FROM assets_tax_pool_runs r
              WHERE r.client_id = p_client_id AND r.status = 'posted'
                AND COALESCE(public.tax_pool_fy_start(r.fiscal_year) = v_fy - 1, false)) THEN
    RAISE EXCEPTION 'tax_pool_opening_unused: FY % opens from the schedule posted for the year before, not from typed values', p_fiscal_year
      USING ERRCODE = 'P0001', HINT = 'tax_pool_opening_unused';
  END IF;

  SELECT COALESCE(array_agg(y.fiscal_year ORDER BY y.s), '{}'::text[]) INTO v_posted
    FROM (SELECT DISTINCT r.fiscal_year, public.tax_pool_fy_start(r.fiscal_year) AS s
            FROM assets_tax_pool_runs r
           WHERE r.client_id = p_client_id AND r.status = 'posted'
             AND COALESCE(public.tax_pool_fy_start(r.fiscal_year) >= v_fy, false)) y;
  IF cardinality(v_posted) = 0 THEN
    RAISE EXCEPTION 'tax_pool_opening_not_locked: no posted schedule uses FY % yet, so change the values on the card instead', p_fiscal_year
      USING ERRCODE = 'P0001', HINT = 'tax_pool_opening_not_locked';
  END IF;

  FOR v_val IN SELECT e.value FROM jsonb_array_elements(p_values) AS e(value) LOOP
    v_pool := v_val->>'pool';
    IF v_pool IS NULL OR v_pool NOT IN ('A', 'B', 'C', 'D') THEN
      RAISE EXCEPTION 'tax_pool_correction_values: % is not Pool A, B, C or D', COALESCE(v_pool, 'a blank pool')
        USING ERRCODE = '22023', HINT = 'tax_pool_correction_values';
    END IF;
    v_wdv := (v_val->>'opening_wdv')::numeric;
    v_rep := COALESCE((v_val->>'repair_carry_forward')::numeric, 0);
    IF v_wdv IS NULL OR v_wdv < 0 OR v_wdv = 'NaN' OR v_rep < 0 OR v_rep = 'NaN' THEN
      RAISE EXCEPTION 'tax_pool_correction_values: Pool % needs amounts of 0 or more', v_pool
        USING ERRCODE = '22023', HINT = 'tax_pool_correction_values';
    END IF;
    v_wdv := round(v_wdv, 2);
    v_rep := round(v_rep, 2);

    SELECT * INTO v_old FROM assets_tax_pool_openings
     WHERE client_id = p_client_id AND pool = v_pool
     FOR UPDATE;
    v_had := FOUND;
    IF v_had AND public.tax_pool_fy_start(v_old.fiscal_year) IS DISTINCT FROM v_fy THEN
      RAISE EXCEPTION 'tax_pool_opening_year: Pool %''s opening value is saved for FY %, not FY %', v_pool, v_old.fiscal_year, p_fiscal_year
        USING ERRCODE = 'P0001', HINT = 'tax_pool_opening_year';
    END IF;
    IF v_had AND round(v_old.opening_wdv, 2) = v_wdv AND round(v_old.repair_carry_forward, 2) = v_rep THEN
      CONTINUE;
    END IF;
    IF NOT v_had AND v_wdv = 0 AND v_rep = 0 THEN
      CONTINUE;
    END IF;

    INSERT INTO assets_tax_pool_opening_corrections (
      client_id, pool, fiscal_year, old_opening_wdv, old_repair_carry_forward,
      new_opening_wdv, new_repair_carry_forward, reason, posted_years, corrected_by
    ) VALUES (
      p_client_id, v_pool, p_fiscal_year,
      CASE WHEN v_had THEN v_old.opening_wdv END, CASE WHEN v_had THEN v_old.repair_carry_forward END,
      v_wdv, v_rep, v_reason, v_posted, auth.uid()
    );

    -- Passes ims_rank_guard and the lock (current_user is the owner here); audited by
    -- audit_assets_tax_pool_openings under the caller's own id (auth.uid() reads the JWT).
    INSERT INTO assets_tax_pool_openings (client_id, pool, fiscal_year, opening_wdv, repair_carry_forward)
    VALUES (p_client_id, v_pool, p_fiscal_year, v_wdv, v_rep)
    ON CONFLICT (client_id, pool) DO UPDATE
      SET opening_wdv = EXCLUDED.opening_wdv, repair_carry_forward = EXCLUDED.repair_carry_forward;

    v_n := v_n + 1;
  END LOOP;

  IF v_n = 0 THEN
    RAISE EXCEPTION 'tax_pool_correction_unchanged: every value sent is the one already saved'
      USING ERRCODE = 'P0001', HINT = 'tax_pool_correction_unchanged';
  END IF;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.correct_tax_pool_openings(uuid, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_tax_pool_openings(uuid, text, jsonb, text) TO authenticated, service_role;

-- The lock's refusal named a "correction run" that never existed for a typed opening (ASSETS-9).
-- Body: 20260929110000 (only definition); only the message changes.
CREATE OR REPLACE FUNCTION public.assets_tax_pool_openings_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_row  public.assets_tax_pool_openings := COALESCE(NEW, OLD);
  v_used text;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT r.fiscal_year INTO v_used
    FROM public.assets_tax_pool_runs r
   WHERE r.client_id = v_row.client_id
     AND r.status = 'posted'
     AND (COALESCE(public.tax_pool_fy_start(r.fiscal_year) >= public.tax_pool_fy_start(OLD.fiscal_year), false)
          OR COALESCE(public.tax_pool_fy_start(r.fiscal_year) >= public.tax_pool_fy_start(NEW.fiscal_year), false))
   ORDER BY public.tax_pool_fy_start(r.fiscal_year)
   LIMIT 1;

  IF v_used IS NOT NULL THEN
    RAISE EXCEPTION 'tax_pool_opening_locked: Pool % opening for FY % is locked — FY % is posted and carries it forward. If it was typed wrong, use Correct these values on the Tax Depreciation tab (a reason is recorded), then post the years it lists again.',
      v_row.pool, v_row.fiscal_year, v_used
      USING ERRCODE = '42501', HINT = 'tax_pool_opening_locked';
  END IF;

  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.assets_tax_pool_openings_lock() FROM PUBLIC;


-- ══ 7. ASSETS-13: reading the asset tables needs an IMS supervisor, as the page does ══════════════
--
-- The page and the nav are supervisor+, but the policies let any IMS login of the outlet read every
-- asset table over REST, a store-room count PIN included. Writes were already rank-fenced (S756).
-- Readers checked: Fixed Assets (supervisor), Overheads' depreciation memo (manager), the operator's
-- export and Audit Log (admin), the Suite pages (Owner). ims_caller_has_rank passes the Owner and the
-- operator and refuses a count PIN at every rank. Wrapped in (select …) so it is evaluated once per
-- query, not per row.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'assets_categories', 'assets_register', 'assets_repair_expenses', 'assets_depreciation_runs',
    'assets_depreciation_schedule', 'assets_tax_pool_runs', 'assets_tax_pool_lines',
    'assets_tax_pool_openings', 'assets_tax_pool_opening_corrections'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS assets_read_ims_supervisor ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY assets_read_ims_supervisor ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated '
      || 'USING (COALESCE((select public.ims_caller_has_rank(''supervisor'')), false))', t);
  END LOOP;
END;
$$;


-- ══ 7b. GAPS-13 (second half, routed from FORECAST): a new asset or repair names who added it ══════
-- Lead, S849 merge. The page never sends created_by, so both columns were always NULL. A default fills
-- them from the caller's JWT; an explicit value (the operator's Restore re-inserting a backed-up row)
-- still wins. Rollback: ALTER COLUMN created_by DROP DEFAULT on both.
ALTER TABLE public.assets_register        ALTER COLUMN created_by SET DEFAULT auth.uid();
ALTER TABLE public.assets_repair_expenses ALTER COLUMN created_by SET DEFAULT auth.uid();

-- ══ 8. Comments that a future migration would trust ═══════════════════════════════════════════════
COMMENT ON COLUMN public.assets_tax_pool_runs.fiscal_year IS
  'The BS fiscal year as getBsFiscalYear() writes it: "83/84" (CHECK since S849). The openings lock compares runs on tax_pool_fy_start(), which reads only this spelling.';
COMMENT ON COLUMN public.assets_tax_pool_lines.repair_expense_deductible IS
  'Section 16(2) as amended since the Financial Ordinance 2060: min(repairs, 7% of depreciation_base). The excess is repair_expense_capitalized and joins next year''s base (repair_carried_in there).';
COMMENT ON COLUMN public.assets_tax_pool_lines.repair_carried_in IS
  'S849 (ASSETS-10): last year''s capitalized repair excess (or the typed repair_carry_forward) that joined this year''s base. Opening + this + additions - disposals - depreciation - terminal_deduction + balancing_income = closing_wdv.';
COMMENT ON COLUMN public.assets_tax_pool_lines.balancing_income IS
  'S849 (ASSETS-2): Schedule 2 §4(1). Disposal proceeds above the pool''s base, to be included in business income this year; the base floors at 0.';
COMMENT ON COLUMN public.assets_tax_pool_lines.terminal_deduction IS
  'S849 (ASSETS-2): Schedule 2 §4(2). Every asset of the pool was disposed of this year: the class is dissolved and what was left is deducted this year; closing_wdv is 0.';
COMMENT ON TABLE public.assets_tax_pool_opening_corrections IS
  'S849 (SU7 b): every correction of a locked typed tax pool opening, old and new values, reason, who, when, and the posted years at the time. Written only by correct_tax_pool_openings() (and the operator''s restore); never edited.';


-- ══ 9. Self-check ═════════════════════════════════════════════════════════════════════════════════
-- On catalog values Postgres computes (supabase-sql.md, S630).
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(x.tbl || '.' || x.tg, ', ') INTO v_missing
    FROM (VALUES
      ('assets_depreciation_runs',            'trg_enforce_asset_run_posted_immutable'),
      ('assets_tax_pool_runs',                'trg_enforce_asset_run_posted_immutable'),
      ('assets_register',                     'assets_same_client'),
      ('assets_repair_expenses',              'assets_same_client'),
      ('assets_depreciation_schedule',        'assets_same_client'),
      ('assets_tax_pool_lines',               'assets_same_client'),
      ('assets_depreciation_schedule',        'audit_assets_depreciation_schedule'),
      ('assets_tax_pool_opening_corrections', 'audit_assets_tax_pool_opening_corrections')
    ) AS x(tbl, tg)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t
                      WHERE t.tgrelid = ('public.' || x.tbl)::regclass AND t.tgname = x.tg AND NOT t.tgisinternal);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'S849 ASSETS: triggers missing: %', v_missing;
  END IF;

  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(ARRAY['assets_tax_pool_runs_fiscal_year_check', 'assets_tax_pool_lines_figures_check']) c
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c AND contype = 'c' AND convalidated);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'S849 ASSETS: constraints missing or not validated: %', v_missing;
  END IF;

  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'assets_tax_pool_lines'
         AND column_name IN ('repair_carried_in', 'balancing_income', 'terminal_deduction')) <> 3 THEN
    RAISE EXCEPTION 'S849 ASSETS: tax pool line columns missing';
  END IF;

  -- The sanctioned path is DEFINER, every guard it must pass is INVOKER (or keyed on auth.uid()).
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.correct_tax_pool_openings(uuid, text, jsonb, text)'::regprocedure) THEN
    RAISE EXCEPTION 'S849 ASSETS: correct_tax_pool_openings must be SECURITY DEFINER to pass the openings lock';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef
              AND proname IN ('assets_tax_pool_openings_lock', 'ims_assets_register_guard', 'post_tax_pool_run',
                              'post_asset_depreciation_run', 'enforce_asset_run_posted_immutable')) THEN
    RAISE EXCEPTION 'S849 ASSETS: a guard or post RPC became SECURITY DEFINER — current_user would be the owner and the guards would never fire';
  END IF;
  IF has_function_privilege('anon', 'public.correct_tax_pool_openings(uuid, text, jsonb, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.correct_tax_pool_openings(uuid, text, jsonb, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S849 ASSETS: correct_tax_pool_openings grants are wrong';
  END IF;
  IF has_function_privilege('authenticated', 'public.assets_same_client()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.assign_asset_code()', 'EXECUTE') THEN
    RAISE EXCEPTION 'S849 ASSETS: a trigger function is callable by authenticated';
  END IF;

  -- The corrections record: readable and restorable, never editable, from a browser session.
  IF NOT has_table_privilege('authenticated', 'public.assets_tax_pool_opening_corrections', 'SELECT')
     OR has_table_privilege('authenticated', 'public.assets_tax_pool_opening_corrections', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.assets_tax_pool_opening_corrections', 'DELETE')
     OR has_table_privilege('authenticated', 'public.assets_tax_pool_opening_corrections', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.assets_tax_pool_opening_corrections', 'REFERENCES')
     OR has_table_privilege('authenticated', 'public.assets_tax_pool_opening_corrections', 'TRIGGER')
     OR has_table_privilege('anon', 'public.assets_tax_pool_opening_corrections', 'SELECT') THEN
    RAISE EXCEPTION 'S849 ASSETS: assets_tax_pool_opening_corrections grants are wrong';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.assets_tax_pool_opening_corrections'::regclass) THEN
    RAISE EXCEPTION 'S849 ASSETS: RLS is off on assets_tax_pool_opening_corrections';
  END IF;

  SELECT string_agg(p, ', ') INTO v_missing
    FROM unnest(ARRAY['assets_tax_pool_opening_corrections_read', 'assets_tax_pool_opening_corrections_restore',
                      'no_self_service_accounts', 'no_pos_pin_staff', 'no_hr_role_staff', 'assets_read_ims_supervisor']) p
   WHERE NOT EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname = 'public' AND tablename = 'assets_tax_pool_opening_corrections' AND policyname = p);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'S849 ASSETS: policies missing on assets_tax_pool_opening_corrections: %', v_missing;
  END IF;

  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND policyname = 'assets_read_ims_supervisor'
         AND permissive = 'RESTRICTIVE' AND cmd = 'SELECT') <> 9 THEN
    RAISE EXCEPTION 'S849 ASSETS: the supervisor read fence is not on all nine asset tables';
  END IF;

  IF EXISTS (SELECT 1 FROM public.assets_tax_pool_lines WHERE closing_wdv < 0) THEN
    RAISE EXCEPTION 'S849 ASSETS: a posted pool line closes below 0';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
