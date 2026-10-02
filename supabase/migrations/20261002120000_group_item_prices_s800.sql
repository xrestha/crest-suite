-- S800 — the Group Console's "Same item, different price" panel.
--
-- get_group_item_prices(p_bs_year, p_bs_month): for every item bought that BS month by two or more
-- Crest Suite Pro outlets of the caller's group, what each outlet bought and what it paid. Read-only:
-- no table, column, policy or trigger changes.
--
-- Owner decisions (2026-10-02, asked in plain words):
--   * "The same item" is an item LINKED by the HQ master-data push — never two items that merely
--     share a name. An HQ record has master_id IS NULL (it IS the master) and a branch copy carries
--     master_id = <the HQ record's id> (20260827150000), so COALESCE(master_id, id) is the one key
--     both sides share. Matching by name is what push_master_data refuses to do after its one-time
--     adopt, because renaming either side would silently merge two different records.
--   * Prices are compared BEFORE VAT, after the bill's discount: what the supplier charged. A
--     VAT-registered outlet and a PAN-only one buying at the same price show the same price; the
--     PAN outlet's unclaimable 13% (vat_is_cost, D32) is a tax-status difference, not a buying one.
--     That is why this is not get_group_pnl's cost basis.
--   * The month is the one picked on the Group Console, aligned on (bs_year, bs_month) — outlets
--     keep independent periods, so never on period_id.
--
-- Shape follows get_group_pnl (20260929120000): the same Owner/admin check, COALESCE'd because
-- is_admin() and is_client_owner() return NULL rather than false for a caller with no profile (the
-- S630 fail-open); my_group_id() for the group; suite_plan = 'pro' filtered SERVER-SIDE, so an
-- unpaid outlet's purchases never reach the browser (the page already names excluded outlets from
-- get_group_summary). Returns RAW aggregates — quantity and value per outlet — and the page derives
-- the per-unit price and the comparison, so this is not a second definition of either.
--
-- The bill discount is shared over a bill's lines in proportion to line value, one discount per
-- bill, keyed exactly as get_group_pnl keys a bill (purchase_group_id, else vendor|invoice|day).
-- Sub-recipe mirror items are never bought and are left out; hidden items keep their history.
-- Rows are grouped by unit too, so an item one outlet counts in KG and another in GM comes back as
-- two rows the page can name as "units differ" instead of comparing 1 KG with 1 GM.
--
-- Reverse: DROP FUNCTION IF EXISTS public.get_group_item_prices(integer, integer);

CREATE OR REPLACE FUNCTION public.get_group_item_prices(p_bs_year integer, p_bs_month integer)
 RETURNS TABLE(item_key uuid, client_id uuid, client_name text, item_name text, uom text, qty numeric, net_value numeric, lines integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group uuid;
BEGIN
  IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
    RAISE EXCEPTION 'Not permitted: only an owner can see group figures.';
  END IF;

  v_group := public.my_group_id();
  IF v_group IS NULL THEN
    RAISE EXCEPTION 'Not permitted: you are not part of an outlet group.';
  END IF;

  RETURN QUERY
  WITH per AS (
    SELECT c.id AS cid, c.name AS cname, mp.id AS period_id
      FROM clients c
      JOIN monthly_periods mp
        ON mp.client_id = c.id AND mp.bs_year = p_bs_year AND mp.bs_month = p_bs_month
     WHERE c.group_id = v_group
       AND c.suite_plan = 'pro'
  ),
  -- One row per bill per period: its single discount, and its gross over ALL lines (get_group_pnl's).
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
  line AS (
    SELECT COALESCE(i.master_id, i.id) AS k,
           per.cid,
           per.cname,
           i.name AS iname,
           i.uom  AS iuom,
           pe.qty AS q,
           pe.qty * pe.rate
             - COALESCE(b.discount, 0) * (pe.qty * pe.rate) / NULLIF(b.gross, 0) AS v
      FROM per
      JOIN purchase_entries pe ON pe.period_id = per.period_id
      JOIN items i ON i.id = pe.item_id AND NOT i.is_sub_recipe
      LEFT JOIN bill b
        ON b.period_id = pe.period_id
       AND b.bill_key  = COALESCE(
             pe.purchase_group_id::text,
             COALESCE(pe.vendor_id::text, '') || '|' ||
             COALESCE(pe.invoice_ref, '')     || '|' ||
             COALESCE(pe.bs_day::text, '')
           )
     WHERE pe.qty > 0
  ),
  agg AS (
    SELECT l.k, l.cid, l.cname, l.iuom,
           min(l.iname)    AS iname,
           sum(l.q)        AS q,
           sum(l.v)        AS v,
           count(*)::integer AS n
      FROM line l
     GROUP BY l.k, l.cid, l.cname, l.iuom
  ),
  shared AS (
    SELECT a.k FROM agg a GROUP BY a.k HAVING count(DISTINCT a.cid) >= 2
  )
  SELECT a.k,
         a.cid,
         a.cname::text,
         a.iname::text,
         a.iuom::text,
         a.q::numeric,
         a.v::numeric,
         a.n
    FROM agg a
    JOIN shared s ON s.k = a.k
   ORDER BY a.k, a.cname, a.iuom;
END;
$function$;

-- EXECUTE is granted to PUBLIC by default, so the revoke ships with the function (supabase-sql.md).
REVOKE ALL ON FUNCTION public.get_group_item_prices(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_group_item_prices(integer, integer) TO authenticated, service_role;

-- Assertions on catalog values, never on formatted text (S630).
DO $assert$
DECLARE
  v_oid oid := 'public.get_group_item_prices(integer, integer)'::regprocedure;
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'S800: get_group_item_prices must be SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'S800: anon can still execute get_group_item_prices';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'S800: authenticated cannot execute get_group_item_prices';
  END IF;
END
$assert$;

NOTIFY pgrst, 'reload schema';
