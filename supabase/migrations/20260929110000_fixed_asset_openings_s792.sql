-- S792 stage 4 — D40: opening pool WDV and "depreciation already taken" (docs/ims-review-s792/
-- STAGE4-DESIGN.md, owner answers Q4 = lock, Q5 = Pool E takes no typed opening).
--
-- Until now there was nowhere to store an opening figure. Every tax pool opened at 0 when the year
-- before had no posted run (COSTS-5 only warned), and an asset bought before the business started
-- using Crest depreciated from its full cost again from its acquisition date (COSTS GAP 1).
--
-- 1. assets_register gains the per-asset pair, typed from last year's books:
--      opening_accumulated_depreciation — depreciation already taken before Crest (>= 0, and with
--        salvage never more than cost);
--      opening_as_of — the date that figure runs to (required when the amount is > 0; on or after
--        acquisition_date). Runs charge from the day after it (depreciationCompute.js).
--    Same table, so it is already audited, rank-guarded (supervisor, ims_assets_register_guard),
--    exported and restored. Existing rows take 0 / NULL and behave exactly as before.
-- 2. assets_tax_pool_openings: one row per pool (A–D) per client — the Closing WDV of the year
--    before the first year Crest computes, from the filed return, plus the repair excess carried
--    into that year (Section 16(3)). The Tax Depreciation tab uses it for `fiscal_year` only when
--    no real run exists for the year before; a real run always wins. Pool E takes none: it is
--    scheduled per asset, so a pool figure would double-count (Q5).
--    Locked once used (Q4): no insert, edit or delete while a POSTED run exists for its fiscal
--    year or a later one. The fix after that is a correction run, as for any posted year.
--
-- fiscal_year is the short label getBsFiscalYear() returns ("82/83"), the format
-- assets_tax_pool_runs.fiscal_year already holds, so the two compare on their leading year.
--
-- Reverse:
--   DROP TABLE IF EXISTS public.assets_tax_pool_openings;          -- policies/triggers go with it
--   DROP FUNCTION IF EXISTS public.assets_tax_pool_openings_lock();
--   DROP FUNCTION IF EXISTS public.tax_pool_fy_start(text);
--   ALTER TABLE public.assets_register
--     DROP CONSTRAINT IF EXISTS assets_register_opening_accum_check,
--     DROP CONSTRAINT IF EXISTS assets_register_opening_as_of_check,
--     DROP COLUMN IF EXISTS opening_as_of,
--     DROP COLUMN IF EXISTS opening_accumulated_depreciation;


-- ══ 1. Per asset: depreciation already taken before Crest ═══════════════════════════════════════
ALTER TABLE public.assets_register
  ADD COLUMN IF NOT EXISTS opening_accumulated_depreciation numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opening_as_of date;

-- Spelled against quantity * unit_cost (what total_cost is generated from) rather than the
-- generated column. The cost bound applies only when an amount is typed: a few legacy rows may
-- carry salvage above cost (annualStraightLineAmount's comment), and a 0 opening must not start
-- refusing their unrelated edits. numeric accepts 'NaN', and NaN >= 0 is true (S751).
ALTER TABLE public.assets_register DROP CONSTRAINT IF EXISTS assets_register_opening_accum_check;
ALTER TABLE public.assets_register ADD CONSTRAINT assets_register_opening_accum_check
  CHECK (opening_accumulated_depreciation >= 0
         AND opening_accumulated_depreciation <> 'NaN'
         AND (opening_accumulated_depreciation = 0
              OR opening_accumulated_depreciation + COALESCE(salvage_value, 0) <= quantity * unit_cost));

ALTER TABLE public.assets_register DROP CONSTRAINT IF EXISTS assets_register_opening_as_of_check;
ALTER TABLE public.assets_register ADD CONSTRAINT assets_register_opening_as_of_check
  CHECK ((opening_accumulated_depreciation = 0 OR opening_as_of IS NOT NULL)
         AND (opening_as_of IS NULL OR opening_as_of >= acquisition_date));

COMMENT ON COLUMN public.assets_register.opening_accumulated_depreciation IS
  'D40: book depreciation already taken before Crest, from last year''s books. Book value = cost - this - posted charges; not counted by the Overheads memo.';
COMMENT ON COLUMN public.assets_register.opening_as_of IS
  'D40: the date opening_accumulated_depreciation runs to. Runs charge from the day after it.';


-- ══ 2. Per tax pool: the opening WDV from last year's return ════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.assets_tax_pool_openings (
    id                    uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    client_id             uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    -- A–D only: Pool E (intangibles) is amortised per asset and takes no pool figure (Q5).
    pool                  text NOT NULL CHECK (pool IN ('A','B','C','D')),
    -- The FIRST year Crest computes for this pool, as getBsFiscalYear() writes it ("82/83").
    fiscal_year           text NOT NULL CHECK (fiscal_year ~ '^\d{1,2}/\d{1,2}$'),
    opening_wdv           numeric NOT NULL CHECK (opening_wdv >= 0 AND opening_wdv <> 'NaN'),
    -- Repair excess capitalised at the end of the year before (Section 16(3)); it joins this
    -- year's base exactly as a prior run's repair_expense_capitalized does.
    repair_carry_forward  numeric NOT NULL DEFAULT 0 CHECK (repair_carry_forward >= 0 AND repair_carry_forward <> 'NaN'),
    created_by            uuid DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at            timestamp with time zone NOT NULL DEFAULT now(),
    -- Stamped by the lock trigger below on every UPDATE (supabase-sql.md: nothing else writes it).
    updated_at            timestamp with time zone NOT NULL DEFAULT now(),
    -- Typed once per pool: the value is last year's closing WDV, not a per-year series.
    CONSTRAINT assets_tax_pool_openings_client_pool_key UNIQUE (client_id, pool)
);

ALTER TABLE public.assets_tax_pool_openings ENABLE ROW LEVEL SECURITY;

-- The same-client policy the other pool tables carry since 20260909180000 (my_client_id(), the
-- (select auth.uid()) initplan wrap).
DROP POLICY IF EXISTS assets_tax_pool_openings_client ON public.assets_tax_pool_openings;
CREATE POLICY assets_tax_pool_openings_client ON public.assets_tax_pool_openings FOR ALL TO authenticated
  USING ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) )
  WITH CHECK ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) );

-- The same 3-of-4 RESTRICTIVE staff-isolation set as assets_tax_pool_runs/lines (20260803140000):
-- IMS logins are fenced by rank below, not excluded by kind.
DROP POLICY IF EXISTS no_self_service_accounts ON public.assets_tax_pool_openings;
CREATE POLICY no_self_service_accounts ON public.assets_tax_pool_openings AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service());
DROP POLICY IF EXISTS no_pos_pin_staff ON public.assets_tax_pool_openings;
CREATE POLICY no_pos_pin_staff ON public.assets_tax_pool_openings AS RESTRICTIVE FOR ALL
  USING (NOT public.is_pos_pin_staff()) WITH CHECK (NOT public.is_pos_pin_staff());
DROP POLICY IF EXISTS no_hr_role_staff ON public.assets_tax_pool_openings;
CREATE POLICY no_hr_role_staff ON public.assets_tax_pool_openings AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff());

-- Manager rank, the same as posting the pools (20260918100000 §7).
DROP TRIGGER IF EXISTS ims_rank_guard ON public.assets_tax_pool_openings;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.assets_tax_pool_openings
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('manager', 'setting a tax pool opening value');

-- The leading BS year of a short fiscal-year label ("82/83" -> 82), or NULL for anything else.
CREATE OR REPLACE FUNCTION public.tax_pool_fy_start(p_label text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT (substring(p_label FROM '^(\d{1,2})/'))::integer
$$;
REVOKE ALL ON FUNCTION public.tax_pool_fy_start(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tax_pool_fy_start(text) TO authenticated, service_role;

-- Q4: LOCK once used. An opening for fiscal year Y is used by the first run posted for Y or any
-- later year (that run, or the chain it started, carries it forward), so while such a run exists
-- the row is refused an insert, an edit or a delete — for its old year and, on an UPDATE, its new
-- one. The same carve-outs as every S756 guard: the service role, SECURITY DEFINER bodies and FK
-- cascades (current_user), and the operator (restore). SECURITY INVOKER for that reason; the run
-- lookup is under the caller's own RLS, which is the same client the opening row just passed.
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
    RAISE EXCEPTION 'tax_pool_opening_locked: Pool % opening for FY % is locked — FY % is posted and carries it forward. Correct it with a correction run.',
      v_row.pool, v_row.fiscal_year, v_used
      USING ERRCODE = '42501', HINT = 'tax_pool_opening_locked';
  END IF;

  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.assets_tax_pool_openings_lock() FROM PUBLIC;

DROP TRIGGER IF EXISTS assets_tax_pool_openings_lock ON public.assets_tax_pool_openings;
CREATE TRIGGER assets_tax_pool_openings_lock BEFORE INSERT OR UPDATE OR DELETE ON public.assets_tax_pool_openings
  FOR EACH ROW EXECUTE FUNCTION public.assets_tax_pool_openings_lock();

CREATE OR REPLACE TRIGGER audit_assets_tax_pool_openings
  AFTER INSERT OR DELETE OR UPDATE ON public.assets_tax_pool_openings
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();

-- Raw-SQL tables get no SELECT/INSERT/UPDATE/DELETE by default, and the schema's default
-- privileges hand TRUNCATE / REFERENCES / TRIGGER / MAINTAIN to anon and authenticated (S782);
-- TRUNCATE bypasses RLS and both triggers above.
REVOKE ALL ON public.assets_tax_pool_openings FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assets_tax_pool_openings TO authenticated;
GRANT ALL ON public.assets_tax_pool_openings TO service_role;
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.assets_tax_pool_openings FROM authenticated, anon, PUBLIC;


-- ══ 3. Self-check ════════════════════════════════════════════════════════════════════════════════
-- On catalog values Postgres computes (supabase-sql.md, S630).
DO $$
DECLARE
  v_missing text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'assets_register'
         AND column_name IN ('opening_accumulated_depreciation', 'opening_as_of')) <> 2 THEN
    RAISE EXCEPTION 'D40: assets_register opening columns missing';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.assets_tax_pool_openings'::regclass) THEN
    RAISE EXCEPTION 'D40: RLS is off on assets_tax_pool_openings';
  END IF;

  SELECT string_agg(p, ', ') INTO v_missing
    FROM unnest(ARRAY['assets_tax_pool_openings_client', 'no_self_service_accounts', 'no_pos_pin_staff', 'no_hr_role_staff']) p
   WHERE NOT EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname = 'public' AND tablename = 'assets_tax_pool_openings' AND policyname = p);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'D40: policies missing on assets_tax_pool_openings: %', v_missing;
  END IF;

  SELECT string_agg(t, ', ') INTO v_missing
    FROM unnest(ARRAY['ims_rank_guard', 'assets_tax_pool_openings_lock', 'audit_assets_tax_pool_openings']) t
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger
                      WHERE tgrelid = 'public.assets_tax_pool_openings'::regclass AND tgname = t AND NOT tgisinternal);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'D40: triggers missing on assets_tax_pool_openings: %', v_missing;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'assets_tax_pool_openings_lock' AND p.prosecdef) THEN
    RAISE EXCEPTION 'D40: the lock trigger is SECURITY DEFINER — current_user would be the owner and it would never fire';
  END IF;

  IF has_table_privilege('authenticated', 'public.assets_tax_pool_openings', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.assets_tax_pool_openings', 'REFERENCES')
     OR has_table_privilege('authenticated', 'public.assets_tax_pool_openings', 'TRIGGER')
     OR has_table_privilege('anon', 'public.assets_tax_pool_openings', 'SELECT')
     OR has_table_privilege('anon', 'public.assets_tax_pool_openings', 'TRUNCATE') THEN
    RAISE EXCEPTION 'D40: assets_tax_pool_openings grants are wrong';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.assets_tax_pool_openings', 'INSERT') THEN
    RAISE EXCEPTION 'D40: authenticated cannot write assets_tax_pool_openings';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
