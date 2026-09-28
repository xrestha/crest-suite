-- S792 stage 2 (owner decisions D29 and D30): the group figures.
--
-- 1. get_group_pnl() -- D29, FIGURES-1: hiding an item never changes history.
--    Every stock-valued join read `JOIN items i ON ... AND i.is_active AND NOT i.is_sub_recipe`, so
--    an item bought and used for a year and then hidden (what Item Master tells the owner to do on a
--    unit change, and what every refused delete offers) left every past month's opening, purchases,
--    returns, wastage, staff meals and closing on the group P&L -- closed months included -- while
--    the frozen Owner Report kept it. The browser side (periodCost.js, Monthly Summary, Consolidated
--    P&L, Annual Summary, Period Comparison) drops the same filter in the same change, so the grouped
--    statement and the single-outlet one still value the same items. The sub-recipe exclusion stays:
--    prep is counted at the raw-item level. A hidden item is valued at its own per_uom_rate in every
--    column of the row, so S720's within-row rule still holds (an item is in every column or none).
--
-- 2. get_group_summary() is deliberately NOT changed -- D30, FIGURES-3.
--    D30 makes a CLOSED month's Food Cost % used (COGS) / sales. The Group Console derives its
--    percentages from raw aggregates (multi-outlet.md: the page derives food cost %, so the RPC never
--    becomes another definition of the formula), and get_group_pnl() already returns every COGS
--    component plus period_status for the same (bs_year, bs_month) under the same Owner/admin check.
--    So the console reads both RPCs and derives COGS with computeUsed(), exactly as Consolidated P&L
--    does from the same rows (src/modules/ims/reports/foodCostBasis.js: withGroupCogs,
--    groupCostRatio). Adding a COGS column here would have been a second SQL valuation of the same
--    stock to keep in step by hand, and a return-shape change (DROP + re-grant) for no new fact.
--    Its live body (md5 9cad91077a646f26cc23a2f2b3cd5160 at 2026-09-28) is left exactly as it is.
--
-- The body below is the LIVE definition (pg_get_functiondef, read 2026-09-28, identical to
-- 20260918170000) with only the six `i.is_active` conditions removed, each marked `-- S792`.
-- Signature and return columns are unchanged, so CREATE OR REPLACE keeps the grants; the REVOKE /
-- GRANT pair is restated anyway, as 20260914140000 did, so the file states the intended ACL.

-- ══ 0. The live body is still the one this file was written from ═════════════════════════════════
-- md5(prosrc) read live 2026-09-28. If get_group_pnl changed out of band since, this refuses rather
-- than silently reverting that change (the S756 stage-4 rule: rebuild from the live definition).
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_group_pnl';
  IF v_md5 IS DISTINCT FROM '181d9c16cc2eb32641c4423fe94e04a6' THEN
    RAISE EXCEPTION 'S792: get_group_pnl changed since this migration was written (live md5 %) — rebuild it from the live body', v_md5;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_group_pnl(p_bs_year integer, p_bs_month integer)
 RETURNS TABLE(client_id uuid, client_name text, is_included boolean, has_period boolean, period_status text, revenue numeric, opening_val numeric, purchases_val numeric, returns_val numeric, wastage_val numeric, staff_meals_val numeric, closing_val numeric, has_closing boolean, labour_payroll numeric, labour_bucket numeric, overheads_val numeric, tax_fees_val numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group uuid;
BEGIN
  -- Owner or admin, exactly as get_group_summary() since S617 (20260827140000). This function
  -- checked group MEMBERSHIP alone and called it authorisation, so any staff login of a grouped
  -- client -- a POS PIN waiter included -- could POST it and read every Suite outlet's revenue,
  -- COGS, labour and overheads. COALESCE on both: each returns NULL, not false, for a caller with
  -- no profile, and NOT(NULL OR NULL) never fires the branch (the S579/S630 fail-open shape).
  IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
    RAISE EXCEPTION 'Not permitted: only an owner can see group figures.';
  END IF;

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
  ),
  -- One row per bill per period: its single discount, and its gross over ALL lines.
  bill AS (
    SELECT pe.period_id,
           COALESCE(
             pe.purchase_group_id::text,
             COALESCE(pe.vendor_id::text, '') || '|' ||
             COALESCE(pe.invoice_ref, '')     || '|' ||
             COALESCE(pe.bs_day::text, '')
           )                                    AS bill_key,
           max(COALESCE(pe.discount_amount, 0)) AS discount,
           sum(pe.qty * pe.rate)                AS gross
      FROM purchase_entries pe
      JOIN per ON per.period_id = pe.period_id
     GROUP BY 1, 2
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
       WHERE se.period_id = per.period_id AND se.source IS DISTINCT FROM 'pos_comp'  -- NULL-safe: a legacy row predates the column
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(os.qty * COALESCE(i.per_uom_rate, 0))
        FROM opening_stock os
        JOIN items i ON i.id = os.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
       WHERE os.period_id = per.period_id
    ), 0) END,
    -- purchases_val: gross line value LESS this line's proportional share of its bill's discount.
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(
               pe.qty * pe.rate
               - COALESCE(b.discount, 0) * (pe.qty * pe.rate) / NULLIF(b.gross, 0)
             )
        FROM purchase_entries pe
        JOIN items i ON i.id = pe.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
        LEFT JOIN bill b
          ON b.period_id = pe.period_id
         AND b.bill_key  = COALESCE(
               pe.purchase_group_id::text,
               COALESCE(pe.vendor_id::text, '') || '|' ||
               COALESCE(pe.invoice_ref, '')     || '|' ||
               COALESCE(pe.bs_day::text, '')
             )
       WHERE pe.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(vr.qty * vr.rate)
        FROM vendor_returns vr
        JOIN items i ON i.id = vr.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
       WHERE vr.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(w.qty * COALESCE(i.per_uom_rate, 0))
        FROM wastages w
        JOIN items i ON i.id = w.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
       WHERE w.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(sm.qty * COALESCE(i.per_uom_rate, 0))
        FROM staff_meals sm
        JOIN items i ON i.id = sm.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
       WHERE sm.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(cs.physical_qty * COALESCE(i.per_uom_rate, 0))
        FROM closing_stock cs
        JOIN items i ON i.id = cs.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
       WHERE cs.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN EXISTS (
      SELECT 1 FROM closing_stock cs WHERE cs.period_id = per.period_id
    ) ELSE false END,
    CASE WHEN o.included THEN (
      SELECT sum(ps.gross + COALESCE(ps.ot_amount, 0) + COALESCE(ps.ssf_employer, 0))
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
$function$;

REVOKE EXECUTE ON FUNCTION public.get_group_pnl(integer, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_group_pnl(integer, integer) TO authenticated, service_role;

-- ══ Self-check ═══════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.get_group_pnl(integer,integer)'::regprocedure) LIKE '%is_active%' THEN
    RAISE EXCEPTION 'S792: get_group_pnl still filters on is_active';
  END IF;
  IF has_function_privilege('anon', 'public.get_group_pnl(integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S792: anon can execute get_group_pnl';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_group_pnl(integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S792: authenticated lost EXECUTE on get_group_pnl';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
