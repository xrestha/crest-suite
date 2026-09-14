-- S747: the two group functions -- one caller check, one definition of the figures.
--
-- 1. get_group_pnl() gains the owner/admin check get_group_summary() has carried since S617.
--    It checked only that the caller belongs to an outlet group, and it is SECURITY DEFINER and
--    granted to authenticated, so a staff account of a grouped client could read every paid
--    outlet's P&L by calling it directly. No client has a group_id yet, so nothing leaked.
--
-- 2. get_group_pnl()'s revenue excluded comps with `se.source <> 'pos_comp'`. sales_entries.source
--    is nullable (DEFAULT 'manual', no NOT NULL), and NULL <> 'pos_comp' is NULL, so every legacy
--    row whose source predates the column fell out of group revenue. IS DISTINCT FROM keeps them
--    (the S699/S734 rule, ims-figures.md). ConsolidatedPnl.jsx's single-outlet read is fixed in
--    the same change so the two paths still agree.
--
-- 3. get_group_summary() (the Group Console) had its own definitions of both headline figures,
--    disagreeing with every per-outlet page (decided with Aashish: make them match):
--      revenue       was  qty x the recipe's CURRENT price, discounts ignored, comps INCLUDED
--                    now  qty x COALESCE(unit_price, selling_price) - discount, comps excluded
--                         -- get_group_pnl's and OwnerDashboard.jsx's definition
--      net_purchases was  sum(qty x rate) - sum(discount_amount): the bill discount is repeated on
--                         every line, so a 5-line bill's discount came off five times; returns
--                         were never subtracted
--                    now  sum(qty x rate) - one discount per bill - vendor returns, over every
--                         item -- OwnerDashboard's Food Cost basis, which S747 also moves onto
--                         allocateBillDiscounts() so the dashboard, the console and the P&L agree.
--    Signature and return columns are unchanged, so CREATE OR REPLACE keeps the grants.

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

CREATE OR REPLACE FUNCTION public.get_group_summary(
  p_bs_year integer,
  p_bs_month integer,
  p_ad_start date DEFAULT NULL,
  p_ad_end   date DEFAULT NULL
)
RETURNS TABLE (
  client_id     uuid,
  client_name   text,
  is_included   boolean,
  has_period    boolean,
  revenue       numeric,
  net_purchases numeric,
  payroll       numeric,
  covers        bigint
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'public'
  AS $fn$
DECLARE
  v_group uuid;
BEGIN
  -- COALESCE on both: each reads a profiles row and returns NULL rather than false when the
  -- caller has none, and NULL OR NULL is NULL, which NOT() leaves NULL, which never fires the
  -- branch -- the fail-open shape S579 documents. Group figures are owner-altitude by
  -- definition: this is the one screen in the product that crosses tenants.
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
    SELECT o.id AS cid, mp.id AS period_id
      FROM outlets o
      LEFT JOIN monthly_periods mp
        ON mp.client_id = o.id AND mp.bs_year = p_bs_year AND mp.bs_month = p_bs_month
  )
  SELECT
    o.id,
    o.name,
    o.included,
    (per.period_id IS NOT NULL),
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(se.qty_sold * COALESCE(se.unit_price, r.selling_price, 0) - COALESCE(se.discount, 0))
        FROM sales_entries se JOIN recipes r ON r.id = se.recipe_id
       WHERE se.period_id = per.period_id AND se.source IS DISTINCT FROM 'pos_comp'
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(b.gross) - sum(b.discount)
        FROM (
          -- One row per bill: its gross over all lines and its ONE discount (max, not sum -- the
          -- value is repeated on every line). Bill identity mirrors billKeyOf().
          SELECT sum(pe.qty * pe.rate)                AS gross,
                 max(COALESCE(pe.discount_amount, 0)) AS discount
            FROM purchase_entries pe
           WHERE pe.period_id = per.period_id
           GROUP BY COALESCE(
                      pe.purchase_group_id::text,
                      COALESCE(pe.vendor_id::text, '') || '|' ||
                      COALESCE(pe.invoice_ref, '')     || '|' ||
                      COALESCE(pe.bs_day::text, ''))
        ) b
    ), 0) - COALESCE((
      SELECT sum(vr.qty * vr.rate) FROM vendor_returns vr WHERE vr.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(ps.gross + COALESCE(ps.ssf_employer, 0))
        FROM hr_payslips ps JOIN hr_payroll_runs pr ON pr.id = ps.run_id
       WHERE pr.client_id = o.id AND pr.period_id = per.period_id AND pr.status = 'finalized'
    ), 0) END,
    CASE WHEN o.included AND p_ad_start IS NOT NULL AND p_ad_end IS NOT NULL THEN COALESCE((
      SELECT sum(po.covers)::bigint FROM pos_orders po
       WHERE po.client_id = o.id
         AND po.close_type = 'paid'
         AND po.closed_at >= p_ad_start::timestamptz
         AND po.closed_at <  (p_ad_end + 1)::timestamptz
    ), 0) ELSE 0 END
  FROM outlets o JOIN per ON per.cid = o.id
  ORDER BY o.name;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.get_group_pnl(integer, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_group_pnl(integer, integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_group_summary(integer, integer, date, date) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_group_summary(integer, integer, date, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- Verification ---------------------------------------------------------------------------------
-- A caller with no profile must be refused by BOTH, before the group lookup:
--   DO $$ BEGIN PERFORM * FROM public.get_group_pnl(2083, 5);
--     RAISE EXCEPTION 'FAIL: get_group_pnl did not refuse';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%only an owner%' THEN RAISE; END IF; END $$;
-- The bodies were exercised once, at apply time, inside a block that rolls itself back: a
-- temporary group of two outlets, an owner JWT, and both functions called (S737's rule -- a
-- refusal proves the function can be entered, not that its body runs).
