-- S798 stage 2e — labour figures: an HR login's Labor Forecast reads the day's real sales and covers.
-- Finding ROSTER-9 in docs/hr-review-s798/ROSTER.md, fix in HR_TODO.md S798.3 (owner decision H30: HR
-- supervisors and managers see each past day's total sales and covers, totals only). Closes the known
-- gap filed at IMS_TODO.md:317 by S756 stage 1.
--
-- Roster's Labor Forecast judges a past day against what it earned, and learns the outlet's labour
-- standard (sales per labour hour) from the last 120 days. Both read sales_entries, recipes and
-- pos_orders, which carry the RESTRICTIVE `no_hr_role_staff` policy: an HR supervisor or manager reads
-- them as [] with no error. So for those logins every past day showed Revenue NPR 0 and "✓ Was covered",
-- and the standard said "not enough history", while the Owner saw real figures on the same screen.
--
-- hr_labour_actuals returns, per BS day of an AD range, only the day's totals: revenue, covers, whether
-- the month has a period, and whether its sales were entered as one bs_day = 0 lump. Never a sales row,
-- a price or a bill. The page calls it for every login (Owner and operator included), so the figures
-- have one definition; the arithmetic is the page's computeDayRevenue (laborForecast.js) exactly:
--   revenue = Σ qty_sold × COALESCE(unit_price, the recipe's selling_price, 0) − discount, comps
--             (source 'pos_comp') left out — a NULL source is NOT a comp (dashboards.md, S734);
--   covers  = paid, uncredited, billed POS orders by the Nepal calendar day they closed, a bill with no
--             covers counting as 1 (`o.covers || 1`);
--   bulk    = the month has any bs_day = 0 sales row, of any source.
-- Who may call it: the operator; or, for the caller's own selected outlet, its Owner or an HR
-- supervisor or manager — the logins the Roster page admits (hasHrAccess('supervisor')). Crest Staff
-- and POS PIN logins are refused. A range over 400 days is refused.
--
-- Nothing here writes data. Reverse: DROP FUNCTION public.hr_labour_actuals(uuid, date, date).

CREATE OR REPLACE FUNCTION public.hr_labour_actuals(p_client_id uuid, p_from date, p_to date)
 RETURNS TABLE(bs_year integer, bs_month integer, bs_day integer, ad_date date, has_period boolean,
               bulk_month boolean, revenue numeric, covers integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
BEGIN
  IF NOT COALESCE(
       public.is_admin()
       OR (p_client_id = public.my_client_id()
           AND NOT public.is_hr_self_service()
           AND NOT public.is_pos_pin_staff()
           AND (public.is_client_owner()
                OR EXISTS (SELECT 1 FROM profiles pr
                            WHERE pr.id = (select auth.uid())
                              AND pr.hr_role IN ('supervisor', 'manager')))),
       false) THEN
    RAISE EXCEPTION 'hr_labour_actuals_forbidden: this login cannot read this outlet''s daily sales'
      USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN
    RAISE EXCEPTION 'hr_labour_actuals_range: give a range of at most 400 days';
  END IF;

  RETURN QUERY
  WITH days AS (
    -- A day outside the BS calendar table has no BS date to key on, so it is left out.
    SELECT b.bs_year AS y, b.bs_month AS m, (g.d - b.ad_start + 1)::integer AS dd, g.d AS ad
      FROM (SELECT gs::date AS d FROM generate_series(p_from, p_to, interval '1 day') AS gs) AS g
      JOIN bs_months b ON g.d >= b.ad_start AND g.d < b.ad_start + b.days
  ),
  per AS (
    SELECT mp.id AS period_id, mp.bs_year AS y, mp.bs_month AS m
      FROM monthly_periods mp
     WHERE mp.client_id = p_client_id
       AND (mp.bs_year, mp.bs_month) IN (SELECT DISTINCT days.y, days.m FROM days)
  ),
  sales AS (
    SELECT per.y, per.m, se.bs_day AS dd,
           sum(COALESCE(se.qty_sold, 0) * COALESCE(se.unit_price, r.selling_price, 0)
               - COALESCE(se.discount, 0)) AS revenue
      FROM per
      JOIN sales_entries se ON se.period_id = per.period_id
      LEFT JOIN recipes r ON r.id = se.recipe_id AND r.client_id = p_client_id
     WHERE se.bs_day > 0
       AND se.source IS DISTINCT FROM 'pos_comp'
     GROUP BY per.y, per.m, se.bs_day
  ),
  bulk AS (
    SELECT DISTINCT per.y, per.m
      FROM per
     WHERE EXISTS (SELECT 1 FROM sales_entries se WHERE se.period_id = per.period_id AND se.bs_day = 0)
  ),
  cov AS (
    SELECT (o.closed_at AT TIME ZONE 'Asia/Kathmandu')::date AS ad,
           sum(COALESCE(NULLIF(o.covers, 0), 1))::integer AS covers
      FROM pos_orders o
     WHERE o.client_id = p_client_id
       AND o.status = 'billed' AND o.close_type = 'paid' AND o.credit_note_id IS NULL
       AND o.closed_at >= (p_from::timestamp AT TIME ZONE 'Asia/Kathmandu')
       AND o.closed_at <  ((p_to + 1)::timestamp AT TIME ZONE 'Asia/Kathmandu')
     GROUP BY 1
  )
  SELECT days.y, days.m, days.dd, days.ad,
         EXISTS (SELECT 1 FROM per WHERE per.y = days.y AND per.m = days.m),
         EXISTS (SELECT 1 FROM bulk WHERE bulk.y = days.y AND bulk.m = days.m),
         CASE WHEN EXISTS (SELECT 1 FROM per WHERE per.y = days.y AND per.m = days.m)
              THEN COALESCE(sales.revenue, 0) END,
         COALESCE(cov.covers, 0)
    FROM days
    LEFT JOIN sales ON sales.y = days.y AND sales.m = days.m AND sales.dd = days.dd
    LEFT JOIN cov ON cov.ad = days.ad
   ORDER BY days.ad;
END;
$function$;
REVOKE ALL ON FUNCTION public.hr_labour_actuals(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hr_labour_actuals(uuid, date, date) TO authenticated, service_role;

-- Self-check: the grants are what this file says, and the body is the one written above.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.hr_labour_actuals(uuid,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S798 2e: anon can execute hr_labour_actuals';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.hr_labour_actuals(uuid,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S798 2e: authenticated cannot execute hr_labour_actuals';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hr_labour_actuals(uuid,date,date)'::regprocedure) THEN
    RAISE EXCEPTION 'S798 2e: hr_labour_actuals is not SECURITY DEFINER';
  END IF;
END $$;
