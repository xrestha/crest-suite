-- get_group_pnl(): value purchases NET of bill-level discounts.
--
-- WHY (S601, found by audit after the Food Cost % work):
-- `purchase_entries.discount_amount` is a BILL-level figure repeated on EVERY line of the bill —
-- the shape VendorReport.js, OutstandingPayables.js, VatReport.js, NonVatReport.js and
-- supplierAttribution.js all already dedupe by bill before using. The P&L was the one place that
-- ignored it entirely: `sum(pe.qty * pe.rate)` charges the undiscounted price into COGS, so a
-- NPR 10,000 bill discount made COGS NPR 10,000 too high and Net Profit NPR 10,000 too LOW — on
-- the one page sold as the formal statement, while the Purchases register for the same bill
-- showed the discounted total the client actually owed.
--
-- Fixed in the same change across all three places that value purchases, because they are
-- required to agree with each other:
--   • src/pages/dashboard/ConsolidatedPnl.jsx  (single-outlet path)
--   • src/modules/ims/reports/MonthlySummary.js (the page ConsolidatedPnl ties to)
--   • this function                             (the grouped path)
-- The two JS sites use allocateBillDiscounts() from supplierAttribution.js; this is that helper's
-- arithmetic expressed in SQL, clause for clause.
--
-- ALLOCATION IS PROPORTIONAL, NOT A FLAT SUBTRACTION. Every *_val column here is summed only over
-- ACTIVE, non-sub-recipe items (S436 / MonthlySummary's convention). A bill can contain a line for
-- an item that is outside that filter, so subtracting the whole bill's discount from a total that
-- never included the whole bill's gross would over-credit it. Each bill's discount is therefore
-- spread across that bill's own lines in proportion to line value, and only the shares landing on
-- included items are subtracted. The `bill` CTE's `gross` is deliberately computed over ALL lines
-- of the bill (no items join) — that is the denominator the proportion is taken against, and
-- narrowing it would silently inflate every share.
--
-- `max(discount_amount)`, not `sum`: the value is repeated per line, so summing it multiplies the
-- discount by the bill's line count. Same rule, same reason, as VendorReport.js's dedupe.
--
-- Bill identity mirrors billKeyOf()/allocateBillDiscounts(): purchase_group_id when present, else
-- a vendor|invoice|day composite for rows written before that column existed. One deliberate
-- difference from the JS: a NULL vendor_id renders as '' here and as the string "null" in JS. That
-- can only diverge for a legacy row carrying neither a purchase_group_id nor a vendor_id, and
-- purchase_group_id has DEFAULT gen_random_uuid(), so in practice the composite path is unused.
--
-- Signature is unchanged, so CREATE OR REPLACE preserves the existing grants; they are re-asserted
-- below anyway, matching this project's convention.

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
       WHERE se.period_id = per.period_id AND se.source <> 'pos_comp'
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(os.qty * COALESCE(i.per_uom_rate, 0))
        FROM opening_stock os
        JOIN items i ON i.id = os.item_id AND i.is_active AND NOT i.is_sub_recipe
       WHERE os.period_id = per.period_id
    ), 0) END,
    -- purchases_val: gross line value LESS this line's proportional share of its bill's discount.
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(
               pe.qty * pe.rate
               - COALESCE(b.discount, 0) * (pe.qty * pe.rate) / NULLIF(b.gross, 0)
             )
        FROM purchase_entries pe
        JOIN items i ON i.id = pe.item_id AND i.is_active AND NOT i.is_sub_recipe
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
REVOKE EXECUTE ON FUNCTION public.get_group_pnl(integer, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_group_pnl(integer, integer) TO authenticated, service_role;

-- ── Verification (do not trust "Success. No rows returned.") ─────────────────────────────────
--   SELECT has_function_privilege('anon','public.get_group_pnl(integer,integer)','EXECUTE');          -- false
--   SELECT has_function_privilege('authenticated','public.get_group_pnl(integer,integer)','EXECUTE'); -- true
--
-- The discount arithmetic, against a real period with at least one discounted bill. The second
-- figure must be lower than the first by exactly the discounts on bills whose lines are all
-- active non-sub-recipe items:
--   SELECT sum(pe.qty * pe.rate) AS gross_before
--     FROM purchase_entries pe
--     JOIN items i ON i.id = pe.item_id AND i.is_active AND NOT i.is_sub_recipe
--    WHERE pe.period_id = '<period uuid>';
--   SELECT purchases_val FROM get_group_pnl(<bs_year>, <bs_month>) WHERE client_id = '<outlet uuid>';
--
-- And the shape that motivated max() over sum() — a multi-line bill must be discounted ONCE:
--   SELECT purchase_group_id, count(*) AS lines,
--          max(discount_amount) AS bill_discount, sum(discount_amount) AS naive_wrong_total
--     FROM purchase_entries WHERE period_id = '<period uuid>' AND discount_amount > 0
--    GROUP BY 1 HAVING count(*) > 1;
