-- S798 stage 3c — labour figures on the group screens (LABOUR-FIGURES-1, -3). Findings in
-- docs/hr-review-s798/LABOUR-FIGURES.md, owner decisions H18 (A) and H19 (A) in HR_TODO.md.
--
-- H19 (A): a finalized run's labour is pay EARNED + overtime + employer SSF — gross less the absence
-- deduction, which carries unpaid days and the days before a joiner started or after a leaver left.
-- That is the payroll sheet's Cost to business (payrollCashCost) and, since this stage, every page's
-- payrollLabourTotal. Two waiters joining on 16 Bhadra counted NPR 20,000 each here and NPR 10,323 on
-- the payroll sheet the Owner signs.
--
-- H18 (A): festival allowance, incentives and a leaver's final settlement count as labour in the month
-- they are paid, named on screen. A 12-staff cafe's Ashwin read NPR 2,90,000 of labour (24%, green)
-- when the month cost NPR 4,97,600 with the Dashain allowance (41%, red).
--
-- get_group_pnl: rebuilt from its LIVE body (20260929120000). labour_payroll takes off the absence
-- deduction and stays NULL when no finalized run exists; three new columns carry the month's other
-- labour, which the page adds to payroll (groupOutletLabour, labourSource.js) and never to a typed
-- Labor tab. New return columns, so DROP then CREATE, and the grants are restated.
--
-- get_group_summary: same shape, its payroll column on the new definition. No page reads it as labour
-- since S798 2e (it is 0 for "no run"); it moves so the SQL has one definition.
--
-- Live data on 2026-10-03: no finalized festival or incentive row exists anywhere (Ashwin 2083 drafts
-- only); one finalized settlement is in Bhadra 2083, at a client outside any group. The only grouped
-- outlets (BLOOM CAFE, BLOOM CAFE - PKR) have no payslip with an absence deduction, so no group figure
-- moves today.
--
-- Nothing here writes data. Reverse: re-run get_group_pnl and get_group_summary from
-- 20260929120000_pan_vat_is_cost_s792.sql (DROP get_group_pnl first: its return columns shrink).

DROP FUNCTION IF EXISTS public.get_group_pnl(integer, integer);

CREATE OR REPLACE FUNCTION public.get_group_pnl(p_bs_year integer, p_bs_month integer)
 RETURNS TABLE(client_id uuid, client_name text, is_included boolean, has_period boolean, period_status text, revenue numeric, opening_val numeric, purchases_val numeric, returns_val numeric, wastage_val numeric, staff_meals_val numeric, closing_val numeric, has_closing boolean, labour_payroll numeric, labour_bucket numeric, overheads_val numeric, tax_fees_val numeric, labour_festival numeric, labour_incentive numeric, labour_settlement numeric)
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
    -- purchases_val: gross line value LESS this line's proportional share of its bill's discount,
    -- then on the COST basis (D32): × 1.13 on a VAT line of a vat_is_cost (PAN-bill) bill.
    CASE WHEN o.included THEN COALESCE((
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
    ), 0) END,
    -- returns_val: list value, on the basis of the line it went back against (D32). An unlinked
    -- return (no line) stays ex-VAT, as periodCost.js's returnCostValue does.
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(vr.qty * vr.rate
                 * CASE WHEN COALESCE(lp.vat_inclusive, false) AND COALESCE(lp.vat_is_cost, false) THEN 1.13 ELSE 1 END)  -- D32
        FROM vendor_returns vr
        JOIN items i ON i.id = vr.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
        LEFT JOIN purchase_entries lp ON lp.id = vr.purchase_entry_id  -- D32
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
      -- S798 3c (H19): pay EARNED — gross less the absence deduction — as payrollLabourTotal.
      SELECT sum(ps.gross - COALESCE(ps.absence_deduction, 0) + COALESCE(ps.ot_amount, 0) + COALESCE(ps.ssf_employer, 0))
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
    ), 0) END,
    -- S798 3c (H18): labour paid outside the monthly run, in the month it is paid — labourSource.js's
    -- otherLabourTotals(), which groupOutletLabour adds to labour_payroll. Finalized rows only, and
    -- only for an outlet with a period that month, as every other figure in this row needs one.
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(fa.amount) FROM hr_festival_allowances fa
       WHERE per.period_id IS NOT NULL AND fa.client_id = o.id AND fa.status = 'finalized'
         AND fa.bs_year = p_bs_year AND fa.bs_month = p_bs_month
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(hi.amount) FROM hr_incentives hi
       WHERE per.period_id IS NOT NULL AND hi.client_id = o.id AND hi.status = 'finalized'
         AND hi.bs_year = p_bs_year AND hi.bs_month = p_bs_month
    ), 0) END,
    -- A Final Settlement by the month it was settled: the part-month salary (already gross − unpaid
    -- days + overtime), employer SSF, leave encashment, festival share, notice pay and gratuity, less
    -- the notice deduction the business keeps. Travel claims are reimbursement, not labour.
    -- settlementLabourCost() is the JS copy; a settlement with no settle month (pre-S752) is in no month.
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(COALESCE(fs.partial_salary, 0) + COALESCE(fs.month_ssf_employer, 0) + COALESCE(fs.leave_encashment, 0)
                 + COALESCE(fs.festival_pro, 0) + COALESCE(fs.notice_pay, 0) + COALESCE(fs.gratuity, 0)
                 - COALESCE(fs.notice_deduction, 0))
        FROM hr_final_settlements fs
       WHERE per.period_id IS NOT NULL AND fs.client_id = o.id AND fs.status = 'finalized'
         AND fs.settle_bs_year = p_bs_year AND fs.settle_bs_month = p_bs_month
    ), 0) END
  FROM outlets o JOIN per ON per.cid = o.id
  ORDER BY o.name;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_group_summary(p_bs_year integer, p_bs_month integer, p_ad_start date DEFAULT NULL::date, p_ad_end date DEFAULT NULL::date)
 RETURNS TABLE(client_id uuid, client_name text, is_included boolean, has_period boolean, revenue numeric, net_purchases numeric, payroll numeric, covers bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      -- S798 3c (H19): pay EARNED — gross less the absence deduction — as payrollLabourTotal.
      SELECT sum(ps.gross - COALESCE(ps.absence_deduction, 0) + COALESCE(ps.ot_amount, 0) + COALESCE(ps.ssf_employer, 0))
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
$function$;

REVOKE EXECUTE ON FUNCTION public.get_group_pnl(integer, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_group_pnl(integer, integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_group_summary(integer, integer, date, date) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_group_summary(integer, integer, date, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
