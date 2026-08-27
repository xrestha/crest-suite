-- get_group_summary(): check WHO is asking, not just whether they are in a group.
--
-- WHY (S617). Sibling of 20260827120000, found in the same pass and the more serious of the two.
-- The function's only caller check was:
--
--     v_group := public.my_group_id();
--     IF v_group IS NULL THEN RAISE EXCEPTION 'you are not part of an outlet group'; END IF;
--
-- That is a membership test, not an authorisation test. Every account of a grouped client shares
-- its client_id -- POS PIN staff, IMS staff, HR staff and HR self-service employees all do (the
-- standing note in CLAUDE.md: "Staff accounts are same-client at the RLS level") -- and
-- my_group_id() resolves from the HOME client, so it is non-NULL for all of them. A waiter could
-- call this RPC and receive every outlet in the group's revenue, net purchases, PAYROLL and
-- covers.
--
-- SECURITY DEFINER is why the RESTRICTIVE staff-isolation families (S316/S419/S430) do not save
-- us here: they fence each account type out of hr_payslips, sales_entries and the rest at the
-- TABLE level, and this function reads those tables as its owner. Bypassing RLS is the entire
-- point of the function; supplying the check RLS would have made is therefore its own job.
--
-- The frontend half shipped alongside this: /group-dashboard had no role guard at either the
-- route or the component (App.js mounted it bare), and while the sidebar offered it only to
-- isAdmin || isOwner, the COMMAND PALETTE offered it on outlets.length > 1 alone -- so the page
-- was not merely reachable by URL, it was advertised. That is the S601 rule ("a page reachable by
-- URL needs the guard its nav item implies") on a third page, after /pnl and /owner-dashboard.
--
-- THE BODY BELOW IS THE 20260812170000 ORIGINAL, VERBATIM. The only edit is the authorisation
-- block inserted at the top. Nothing about how revenue, net purchases, payroll or covers are
-- derived is touched -- in particular revenue stays qty_sold x recipes.selling_price and net
-- purchases stays sum(qty x rate) - discount_amount, so the Group Console cannot start
-- disagreeing with itself across this deploy.
--
-- Body-only change: same signature, same RETURNS TABLE shape, so CREATE OR REPLACE is valid and
-- the ACL from 20260812170000 survives. Changing the return columns would have required a DROP
-- and re-granting (42P13 / S464).

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
      SELECT sum(se.qty_sold * COALESCE(r.selling_price, 0))
        FROM sales_entries se JOIN recipes r ON r.id = se.recipe_id
       WHERE se.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(pe.qty * pe.rate) - COALESCE(sum(pe.discount_amount), 0)
        FROM purchase_entries pe
       WHERE pe.period_id = per.period_id
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

-- Verification ---------------------------------------------------------------------------------
--   SELECT pg_get_functiondef('public.get_group_summary(integer,integer,date,date)'::regprocedure)
--          LIKE '%is_client_owner%';                                                    -- true
--   SELECT has_function_privilege('anon','public.get_group_summary(integer,integer,date,date)','EXECUTE');
--                                                                                       -- false
--
-- Live test needs a GROUPED client, which none exist yet. When one does: sign in as a POS staff
-- account of a group outlet and POST the RPC with that session's token -- expect 4xx "only an
-- owner". Control that must still pass: the same call as the Owner returns the outlet rows.
