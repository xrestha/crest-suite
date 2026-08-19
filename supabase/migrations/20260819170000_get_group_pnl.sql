-- Consolidated P&L phase 2: get_group_pnl() — per-outlet P&L raw aggregates for one BS month,
-- consumed by /pnl when the caller's client belongs to a group (one column per outlet plus a
-- consolidated total).
--
-- Follows get_group_summary's contract deliberately, clause for clause:
--   • SECURITY DEFINER with its own my_group_id() caller check — group-spanning reads cannot go
--     through scoped queries, and that is intended (CLAUDE.md, multi-outlet section).
--   • Filters to suite_plan = 'pro' SERVER-side and returns excluded outlets by name, so the page
--     can state its coverage. A client-side filter would ship an unpaid outlet's figures to the
--     browser and then hide them.
--   • Returns RAW component aggregates, never derived lines: the page applies computeUsed() to
--     turn opening/purchases/returns/wastage/staff-meals/closing into COGS, so this does not
--     become a second definition of the formula imsFormulas.js owns (the same reasoning that
--     keeps get_group_summary returning raw revenue/purchases for the console to derive from).
--   • Aligns outlets on (bs_year, bs_month), never period_id — outlets keep independent periods.
--
-- Figure conventions mirror the pages each figure must tie to:
--   revenue        — MonthlySummary's rule: qty_sold × COALESCE(unit_price, recipes.selling_price)
--                    minus per-row discount, source <> 'pos_comp'. The <> deliberately reproduces
--                    PostgREST .neq semantics (NULL-source legacy rows excluded) so this figure is
--                    byte-compatible with MonthlySummary and phase 1's single-outlet statement —
--                    matching the shipped convention matters more here than relitigating it.
--   *_val columns  — valued at items.per_uom_rate over ACTIVE, non-sub-recipe items only (S436;
--                    MonthlySummary's convention — prep is counted at its raw ingredients).
--   labour_payroll — finalized payroll gross + employer SSF (get_group_summary's definition),
--                    NULL (not 0) when no finalized run exists, so the page can fall back to the
--                    overheads 'labor' bucket without conflating "ran payroll at 0" with "no run".
--   labour_bucket / overheads_val / tax_fees_val — the Overheads page's three buckets, with a
--                    NULL bucket read as 'overhead' (Overheads.js's own `r.bucket || 'overhead'`).

CREATE OR REPLACE FUNCTION public.get_group_pnl(
  p_bs_year  integer,
  p_bs_month integer
)
RETURNS TABLE (
  client_id       uuid,
  client_name     text,
  is_included     boolean,
  has_period      boolean,
  period_status   text,
  revenue         numeric,
  opening_val     numeric,
  purchases_val   numeric,
  returns_val     numeric,
  wastage_val     numeric,
  staff_meals_val numeric,
  closing_val     numeric,
  has_closing     boolean,
  labour_payroll  numeric,
  labour_bucket   numeric,
  overheads_val   numeric,
  tax_fees_val    numeric
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
DECLARE
  v_group uuid;
BEGIN
  v_group := public.my_group_id();
  IF v_group IS NULL THEN
    RAISE EXCEPTION 'Not permitted: you are not part of an outlet group.';
  END IF;

  RETURN QUERY
  WITH outlets AS (
    SELECT c.id, c.name, (c.suite_plan = 'pro') AS included
      FROM clients c
     WHERE c.group_id = v_group
  ),
  per AS (
    SELECT o.id AS cid, mp.id AS period_id, mp.status
      FROM outlets o
      LEFT JOIN monthly_periods mp
        ON mp.client_id = o.id AND mp.bs_year = p_bs_year AND mp.bs_month = p_bs_month
  )
  SELECT
    o.id,
    o.name,
    o.included,
    (per.period_id IS NOT NULL),
    per.status,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(se.qty_sold * COALESCE(se.unit_price, r.selling_price, 0) - COALESCE(se.discount, 0))
        FROM sales_entries se JOIN recipes r ON r.id = se.recipe_id
       WHERE se.period_id = per.period_id AND se.source <> 'pos_comp'
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(os.qty * COALESCE(i.per_uom_rate, 0))
        FROM opening_stock os
        JOIN items i ON i.id = os.item_id AND i.is_active AND NOT i.is_sub_recipe
       WHERE os.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(pe.qty * pe.rate)
        FROM purchase_entries pe
        JOIN items i ON i.id = pe.item_id AND i.is_active AND NOT i.is_sub_recipe
       WHERE pe.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(vr.qty * vr.rate)
        FROM vendor_returns vr
        JOIN items i ON i.id = vr.item_id AND i.is_active AND NOT i.is_sub_recipe
       WHERE vr.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(w.qty * COALESCE(i.per_uom_rate, 0))
        FROM wastages w
        JOIN items i ON i.id = w.item_id AND i.is_active AND NOT i.is_sub_recipe
       WHERE w.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(sm.qty * COALESCE(i.per_uom_rate, 0))
        FROM staff_meals sm
        JOIN items i ON i.id = sm.item_id AND i.is_active AND NOT i.is_sub_recipe
       WHERE sm.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(cs.physical_qty * COALESCE(i.per_uom_rate, 0))
        FROM closing_stock cs
        JOIN items i ON i.id = cs.item_id AND i.is_active AND NOT i.is_sub_recipe
       WHERE cs.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN EXISTS (
      SELECT 1 FROM closing_stock cs WHERE cs.period_id = per.period_id
    ) ELSE false END,
    -- NULL when no finalized run, never 0 — the page's payroll-else-bucket rule depends on it.
    CASE WHEN o.included THEN (
      SELECT sum(ps.gross + COALESCE(ps.ssf_employer, 0))
        FROM hr_payslips ps JOIN hr_payroll_runs pr ON pr.id = ps.run_id
       WHERE pr.client_id = o.id AND pr.period_id = per.period_id AND pr.status = 'finalized'
    ) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(oh.amount) FROM overheads oh
       WHERE oh.period_id = per.period_id AND COALESCE(oh.bucket, 'overhead') = 'labor'
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(oh.amount) FROM overheads oh
       WHERE oh.period_id = per.period_id AND COALESCE(oh.bucket, 'overhead') = 'overhead'
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(oh.amount) FROM overheads oh
       WHERE oh.period_id = per.period_id AND COALESCE(oh.bucket, 'overhead') = 'tax_fees'
    ), 0) END
  FROM outlets o JOIN per ON per.cid = o.id
  ORDER BY o.name;
END;
$$;

-- ── Grants ───────────────────────────────────────────────────────────────────────────────────
-- A newly created function signature carries a fresh implicit GRANT EXECUTE TO PUBLIC (the
-- per-signature trap from S532) — revoke from PUBLIC explicitly, then grant. service_role is not
-- a superuser in this project and needs its own grant.
REVOKE EXECUTE ON FUNCTION public.get_group_pnl(integer, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_group_pnl(integer, integer) TO authenticated, service_role;

-- ── Verification (do not trust "Success. No rows returned.") ─────────────────────────────────
--   SELECT has_function_privilege('anon','public.get_group_pnl(integer,integer)','EXECUTE');  -- false
--   SELECT has_function_privilege('authenticated','public.get_group_pnl(integer,integer)','EXECUTE'); -- true
-- An ungrouped caller must be refused, not given an empty set:
--   (as an ungrouped client login) SELECT * FROM get_group_pnl(2083, 4);  -- raises 'Not permitted'
