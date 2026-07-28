-- save_sales_day deleted by (period_id, bs_day) with no `source` filter, and did its cross-mode
-- cleanup the same way. That was faithful parity with the three-call JS it replaced in S456 --
-- and the bug had been in that JS since Sales Entry was written.
--
-- sales_entries is NOT the IMS module's private table. For a POS-enabled client it also carries:
--   * source='pos'        -- one row PER BILL, written at close (PosOrders.jsx writeSalesEntries)
--   * source='pos_comp'   -- comped lines, zero-revenue but real consumption
--   * source='pos_credit' -- NEGATIVE qty_sold reversal rows (IssueCreditNoteModal.jsx)
--
-- So one Save Day on a POS client's Sales Entry page deleted every POS bill row for that day.
-- The rows the page had loaded came back re-inserted (untagged, i.e. source defaulting to
-- 'manual', so POS revenue was silently re-attributed), but two classes never came back at all:
--   * pos_comp -- loadDailySales() filters comps out, so they are never in the payload
--   * pos_credit -- buildDailyRows() filters to qty > 0, so negative reversals are never in it
-- Credit-note reversals disappearing means revenue stays overstated permanently, with no trace.
-- Bulk Entry was worse: its cross-mode delete covers bs_day > 0 across the WHOLE period, so one
-- Bulk save wiped a month of POS rows for every recipe in the payload.
--
-- Product intent (confirmed with Aashish, 2026-07-27): manual Sales Entry is for IMS clients who
-- do NOT run POS. Where both modules are on, POS is the source of truth and supersedes manual
-- entry. Sales.js now enforces that in the UI (read-only when clientModules.pos), but this
-- function must not depend on the UI to be safe -- admin sessions, a stale cached bundle, or a
-- direct RPC call all reach it. A function that saves MANUAL sales has no business deleting rows
-- it did not write, so it now only ever touches manual rows.
--
-- `source IS NULL OR source = 'manual'` rather than plain `= 'manual'`: the column is
-- DEFAULT 'manual' but nullable, so any row written before the default existed reads as NULL and
-- must still be treated as manual, or it becomes undeletable through the UI.

CREATE OR REPLACE FUNCTION public.save_sales_day(
  p_period_id uuid,
  p_bs_day integer,
  p_rows jsonb
) RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_inserted integer := 0;
  v_recipe_ids uuid[];
BEGIN
  IF p_period_id IS NULL THEN
    RAISE EXCEPTION 'p_period_id is required';
  END IF;

  -- bs_day 0 = the Bulk (whole-period) row; 1..32 = a dated Daily row. BS months run 28-32 days.
  IF p_bs_day IS NULL OR p_bs_day < 0 OR p_bs_day > 32 THEN
    RAISE EXCEPTION 'invalid p_bs_day: %', p_bs_day;
  END IF;

  IF p_rows IS NOT NULL AND jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a json array';
  END IF;

  -- (1) Replace this day's MANUAL rows wholesale. POS-sourced rows are left untouched.
  DELETE FROM sales_entries
   WHERE period_id = p_period_id
     AND bs_day = p_bs_day
     AND (source IS NULL OR source = 'manual');

  IF p_rows IS NULL OR jsonb_array_length(p_rows) = 0 THEN
    RETURN 0;
  END IF;

  -- (2) Write the replacements. unit_price/vat_rate are a price-at-entry snapshot (S375) and stay
  -- nullable; discount is NOT NULL DEFAULT 0, so an absent key must coalesce rather than fail.
  -- source is now written EXPLICITLY rather than left to the column default -- these rows are
  -- manual by construction, and (1) above keys off that value, so it must not be implicit.
  INSERT INTO sales_entries (period_id, recipe_id, bs_day, qty_sold, unit_price, vat_rate, discount, source)
  SELECT p_period_id,
         (r ->> 'recipe_id')::uuid,
         p_bs_day,
         COALESCE(NULLIF(r ->> 'qty_sold', '')::numeric, 0),
         NULLIF(r ->> 'unit_price', '')::numeric,
         NULLIF(r ->> 'vat_rate', '')::numeric,
         COALESCE(NULLIF(r ->> 'discount', '')::numeric, 0),
         'manual'
    FROM jsonb_array_elements(p_rows) AS r;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT array_agg((r ->> 'recipe_id')::uuid)
    INTO v_recipe_ids
    FROM jsonb_array_elements(p_rows) AS r;

  -- (3) Cross-mode exclusivity, manual rows only. Bulk (bs_day = 0) and Daily (bs_day > 0) rows
  -- for the same recipe+period are NOT mutually exclusive at the DB level -- the old
  -- UNIQUE(period_id, recipe_id, bs_day) was dropped in S286 -- and every downstream report sums
  -- all rows for a period with no bs_day distinction, so leaving both manual modes populated
  -- double-counts. That reasoning applies only WITHIN manual entry: a POS row and a manual row
  -- for the same recipe/day are two different facts, and resolving that is the UI's job (POS
  -- supersedes manual), never a blind delete here.
  IF p_bs_day = 0 THEN
    DELETE FROM sales_entries
     WHERE period_id = p_period_id
       AND bs_day > 0
       AND recipe_id = ANY (v_recipe_ids)
       AND (source IS NULL OR source = 'manual');
  ELSE
    DELETE FROM sales_entries
     WHERE period_id = p_period_id
       AND bs_day = 0
       AND recipe_id = ANY (v_recipe_ids)
       AND (source IS NULL OR source = 'manual');
  END IF;

  RETURN v_inserted;
END;
$$;

-- Grants: this project's raw-SQL objects get no role grants by default, and a REVOKE from a role
-- is a silent no-op while PUBLIC still holds the privilege (S293 -> S-2026-07-20). CREATE OR
-- REPLACE preserves the existing ACL, but restating it keeps this file standalone-runnable.
REVOKE EXECUTE ON FUNCTION public.save_sales_day(uuid, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_sales_day(uuid, integer, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
