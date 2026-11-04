-- S876 PERF-7: the Inventory Dashboard's Food Cost % trend in one request.
--
-- The trend read eleven closed months of purchases, returns, sales, items, opening and closing
-- stock, wastage, staff meals and transfers: ten reads whose later pages made a third level (six
-- pages on CASA), and ~180 KB of rows to add up in the browser. get_ims_cost_trend() returns one
-- row per closed month with the RAW sums only. The browser keeps the formula: cogsOfGroupPnlRow
-- (computeUsed) for COGS, ÷ revenue for Food Cost %, isMaterialGap for the uncounted-items verdict,
-- fcTrendMath for the chart. The open month stays on its own reads (Spend % so far needs its
-- finished days, mtdClock), narrowed to that one period.
--
-- Every expression below is get_group_pnl's (live body, 2026-11-04), copied, never re-derived:
-- revenue (comps out NULL-safe, unit_price else the recipe's price, less discount), opening,
-- purchases net of each line's bill-discount share on the D32 cost basis plus transfers in,
-- returns on their line's basis plus transfers out, wastage, staff meals, closing, and the
-- uncounted-items gap. get_group_pnl is the SQL copy of periodCost.js that Consolidated P&L's group
-- view already trusts (getGroupPnlSql.test.js pins both), so a third copy is avoided only in spirit:
-- getGroupPnlSql.test.js now pins this body's expressions to that one's, word for word.
--
-- SECURITY INVOKER: every row is read under the caller's own RLS and the restrictive staff
-- families, exactly as the browser's ten reads were (since 20261104110000 those policies cost one
-- lookup per query, not per row). A login fenced off a table reads it as empty, as before.
-- The caller check is the outlet the caller is signed in to (or the operator), COALESCE'd.
--
-- Reverse: DROP FUNCTION public.get_ims_cost_trend(uuid, integer); the page's old reads are in git.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_ims_cost_trend(p_client_id uuid, p_limit integer DEFAULT 11)
RETURNS TABLE(period_id uuid, bs_year integer, bs_month integer, revenue numeric, opening_val numeric,
              purchases_val numeric, returns_val numeric, wastage_val numeric, staff_meals_val numeric,
              closing_val numeric, transfer_in_val numeric, transfer_out_val numeric,
              stock_items integer, uncounted_count integer, uncounted_val numeric)
LANGUAGE plpgsql
STABLE SECURITY INVOKER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT COALESCE(p_client_id = (SELECT public.my_client_id()) OR (SELECT public.is_admin()), false) THEN
    RAISE EXCEPTION 'get_ims_cost_trend: only the outlet you are signed in to'
      USING ERRCODE = '42501', HINT = 'trend_wrong_outlet';
  END IF;

  RETURN QUERY
  WITH per AS (
    -- The last N closed months, newest first (the page's old .limit(11) read).
    SELECT mp.id AS period_id, mp.bs_year, mp.bs_month
      FROM monthly_periods mp
     WHERE mp.client_id = p_client_id AND mp.status = 'closed'
     ORDER BY mp.bs_year DESC, mp.bs_month DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 11), 0), 36)
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
  ),
  -- Each item's purchases in the period, qty and cost (net of its bill-discount share, D32 basis).
  pline AS (
    SELECT pe.period_id, pe.item_id,
           sum(pe.qty) AS qty,
           sum((pe.qty * pe.rate
                - COALESCE(b.discount, 0) * (pe.qty * pe.rate) / NULLIF(b.gross, 0))
               * CASE WHEN COALESCE(pe.vat_inclusive, false) AND pe.vat_is_cost THEN 1.13 ELSE 1 END) AS cost
      FROM purchase_entries pe
      JOIN per ON per.period_id = pe.period_id
      LEFT JOIN bill b
        ON b.period_id = pe.period_id
       AND b.bill_key  = COALESCE(
             pe.purchase_group_id::text,
             COALESCE(pe.vendor_id::text, '') || '|' ||
             COALESCE(pe.invoice_ref, '')     || '|' ||
             COALESCE(pe.bs_day::text, '')
           )
     GROUP BY pe.period_id, pe.item_id
  ),
  -- Stock transfer lines per item in the period (sent = out; received and returned = in), valued at
  -- their own frozen rate. A line exists only once it counts, so no status filter.
  tline AS (
    SELECT tl.period_id, tl.item_id,
           COALESCE(sum(tl.qty)   FILTER (WHERE tl.direction = 'in'),  0) AS in_qty,
           COALESCE(sum(tl.value) FILTER (WHERE tl.direction = 'in'),  0) AS in_cost,
           COALESCE(sum(tl.value) FILTER (WHERE tl.direction = 'out'), 0) AS out_cost
      FROM ims_stock_transfer_lines tl
      JOIN per ON per.period_id = tl.period_id
     GROUP BY tl.period_id, tl.item_id
  ),
  tsum AS (
    SELECT t.period_id, sum(t.in_cost) AS t_in, sum(t.out_cost) AS t_out
      FROM tline t
      JOIN items i ON i.id = t.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
     GROUP BY t.period_id
  ),
  -- Presence = an active raw item with an opening quantity or bought / received quantity above 0;
  -- counted = a closing row whose physical_qty is not null (a 0 is a count); value = opening ×
  -- today's rate + what it cost to bring in. findUncountedItems' rule.
  stock_rows AS (
    SELECT x.period_id, x.item_id,
           sum(x.open_qty) AS open_qty, sum(x.in_qty) AS in_qty, sum(x.in_cost) AS in_cost
      FROM (
        SELECT os.period_id, os.item_id, os.qty AS open_qty, 0::numeric AS in_qty, 0::numeric AS in_cost
          FROM opening_stock os
          JOIN per ON per.period_id = os.period_id
        UNION ALL
        SELECT pl.period_id, pl.item_id, 0, pl.qty, pl.cost FROM pline pl
        UNION ALL
        SELECT t.period_id, t.item_id, 0, t.in_qty, t.in_cost FROM tline t WHERE t.in_qty > 0
      ) x
     GROUP BY x.period_id, x.item_id
  ),
  gap AS (
    SELECT g.period_id,
           count(*)                                         AS gap_items,
           count(*) FILTER (WHERE NOT g.counted)            AS gap_uncounted,
           COALESCE(sum(g.cost) FILTER (WHERE NOT g.counted), 0) AS gap_value
      FROM (
        SELECT sr.period_id,
               COALESCE(sr.open_qty, 0) * COALESCE(i.per_uom_rate, 0) + COALESCE(sr.in_cost, 0) AS cost,
               EXISTS (SELECT 1 FROM closing_stock cs
                        WHERE cs.period_id = sr.period_id AND cs.item_id = sr.item_id
                          AND cs.physical_qty IS NOT NULL) AS counted
          FROM stock_rows sr
          JOIN items i ON i.id = sr.item_id AND NOT i.is_sub_recipe AND i.is_active IS DISTINCT FROM false
         WHERE COALESCE(sr.open_qty, 0) > 0 OR COALESCE(sr.in_qty, 0) > 0
      ) g
     GROUP BY g.period_id
  )
  SELECT
    per.period_id,
    per.bs_year::integer,
    per.bs_month::integer,
    COALESCE((
      SELECT sum(se.qty_sold * COALESCE(se.unit_price, r.selling_price, 0) - COALESCE(se.discount, 0))
        FROM sales_entries se JOIN recipes r ON r.id = se.recipe_id
       WHERE se.period_id = per.period_id AND se.source IS DISTINCT FROM 'pos_comp'  -- NULL-safe: a legacy row predates the column
    ), 0)::numeric,
    COALESCE((
      SELECT sum(os.qty * COALESCE(i.per_uom_rate, 0))
        FROM opening_stock os
        JOIN items i ON i.id = os.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
       WHERE os.period_id = per.period_id
    ), 0)::numeric,
    -- purchases_val: gross line value LESS this line's proportional share of its bill's discount,
    -- then on the COST basis (D32): × 1.13 on a VAT line of a vat_is_cost (PAN-bill) bill.
    -- Plus stock transferred IN at its own rate (transfer_in_val repeats that part).
    (COALESCE((
      SELECT sum(
               (pe.qty * pe.rate
                - COALESCE(b.discount, 0) * (pe.qty * pe.rate) / NULLIF(b.gross, 0))
               * CASE WHEN COALESCE(pe.vat_inclusive, false) AND pe.vat_is_cost THEN 1.13 ELSE 1 END  -- D32
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
    ), 0) + COALESCE(ts.t_in, 0))::numeric,
    -- returns_val: list value, on the basis of the line it went back against (D32). An unlinked
    -- return (no line) stays ex-VAT, as periodCost.js's returnCostValue does.
    -- Plus stock transferred OUT at its own rate (transfer_out_val repeats that part).
    (COALESCE((
      SELECT sum(vr.qty * vr.rate
                 * CASE WHEN COALESCE(lp.vat_inclusive, false) AND COALESCE(lp.vat_is_cost, false) THEN 1.13 ELSE 1 END)  -- D32
        FROM vendor_returns vr
        JOIN items i ON i.id = vr.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
        LEFT JOIN purchase_entries lp ON lp.id = vr.purchase_entry_id  -- D32
       WHERE vr.period_id = per.period_id
    ), 0) + COALESCE(ts.t_out, 0))::numeric,
    COALESCE((
      SELECT sum(w.qty * COALESCE(i.per_uom_rate, 0))
        FROM wastages w
        JOIN items i ON i.id = w.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
       WHERE w.period_id = per.period_id
    ), 0)::numeric,
    COALESCE((
      SELECT sum(sm.qty * COALESCE(i.per_uom_rate, 0))
        FROM staff_meals sm
        JOIN items i ON i.id = sm.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
       WHERE sm.period_id = per.period_id
    ), 0)::numeric,
    COALESCE((
      SELECT sum(cs.physical_qty * COALESCE(i.per_uom_rate, 0))
        FROM closing_stock cs
        JOIN items i ON i.id = cs.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
       WHERE cs.period_id = per.period_id
    ), 0)::numeric,
    COALESCE(ts.t_in, 0)::numeric,
    COALESCE(ts.t_out, 0)::numeric,
    -- The uncounted-items gap; the page applies isMaterialGap() with its own COGS.
    COALESCE(g.gap_items, 0)::integer,
    COALESCE(g.gap_uncounted, 0)::integer,
    COALESCE(g.gap_value, 0)::numeric
  FROM per
  LEFT JOIN tsum ts ON ts.period_id = per.period_id
  LEFT JOIN gap  g  ON g.period_id  = per.period_id
  ORDER BY per.bs_year DESC, per.bs_month DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_ims_cost_trend(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ims_cost_trend(uuid, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
