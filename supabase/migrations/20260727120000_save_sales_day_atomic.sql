-- Sales Entry's save was three sequential round trips from the browser:
--   1. DELETE this day's rows
--   2. INSERT the replacements
--   3. DELETE the superseded cross-mode rows (Daily supersedes Bulk, and vice versa)
--
-- Each is a separate HTTP request, so a stall between (1) and (2) leaves the day's rows deleted
-- with nothing written back — real data loss, not just a failed save. This was not theoretical:
-- a live smoke test on 2026-07-27 saw one of these round trips take 12.4s on the same connection
-- that served the others in under a second, and the client-side guard added in S453/S454 gives up
-- at 20s by design (before that it hung forever, which was worse).
--
-- Collapsing all three into one function makes them a single statement-level transaction: either
-- the whole replacement lands or none of it does, and there is exactly one stall point instead of
-- three.
--
-- Deliberately NOT `SECURITY DEFINER`. sales_entries carries RESTRICTIVE policies
-- (`no_self_service_accounts` from S316, `no_hr_role_staff` from S430) on top of the permissive
-- `sales_entries_all` / `sales_insert` / `sales_delete` policies that scope rows to the caller's
-- client via monthly_periods.client_id. Running as INVOKER means every one of those still applies
-- exactly as it does today, with no re-implementation and no chance of the function becoming a
-- hole that lets an HR self-service or HR-role account write sales. There is nothing here that
-- needs to bypass RLS, so it must not.
--
-- Serves BOTH save paths, since they are the same shape: Daily passes p_bs_day = the day
-- (1..32) and supersedes the Bulk (bs_day = 0) rows for those recipes; Bulk passes p_bs_day = 0
-- and supersedes the dated rows. Behaviour is intentionally identical to the JS it replaces,
-- including deleting the day's existing rows regardless of `source`.

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

  -- (1) Replace this day's rows wholesale. RLS decides whether the caller may touch them at all.
  DELETE FROM sales_entries
   WHERE period_id = p_period_id
     AND bs_day = p_bs_day;

  IF p_rows IS NULL OR jsonb_array_length(p_rows) = 0 THEN
    RETURN 0;
  END IF;

  -- (2) Write the replacements. unit_price/vat_rate are a price-at-entry snapshot (S375) and stay
  -- nullable; discount is NOT NULL DEFAULT 0, so an absent key must coalesce rather than fail.
  INSERT INTO sales_entries (period_id, recipe_id, bs_day, qty_sold, unit_price, vat_rate, discount)
  SELECT p_period_id,
         (r ->> 'recipe_id')::uuid,
         p_bs_day,
         COALESCE(NULLIF(r ->> 'qty_sold', '')::numeric, 0),
         NULLIF(r ->> 'unit_price', '')::numeric,
         NULLIF(r ->> 'vat_rate', '')::numeric,
         COALESCE(NULLIF(r ->> 'discount', '')::numeric, 0)
    FROM jsonb_array_elements(p_rows) AS r;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT array_agg((r ->> 'recipe_id')::uuid)
    INTO v_recipe_ids
    FROM jsonb_array_elements(p_rows) AS r;

  -- (3) Cross-mode exclusivity. Bulk (bs_day = 0) and Daily (bs_day > 0) rows for the same
  -- recipe+period are NOT mutually exclusive at the DB level -- the old
  -- UNIQUE(period_id, recipe_id, bs_day) was dropped in S286 -- and every downstream report sums
  -- all rows for a period with no bs_day distinction, so leaving both silently double-counts.
  IF p_bs_day = 0 THEN
    DELETE FROM sales_entries
     WHERE period_id = p_period_id
       AND bs_day > 0
       AND recipe_id = ANY (v_recipe_ids);
  ELSE
    DELETE FROM sales_entries
     WHERE period_id = p_period_id
       AND bs_day = 0
       AND recipe_id = ANY (v_recipe_ids);
  END IF;

  RETURN v_inserted;
END;
$$;

-- Grants: this project's raw-SQL objects get no role grants by default, and a REVOKE from a role
-- is a silent no-op while PUBLIC still holds the privilege (S293 -> S-2026-07-20). Revoke from
-- PUBLIC first, then grant explicitly. service_role needs its own grant -- it is not a superuser
-- in this project, only rolbypassrls.
REVOKE EXECUTE ON FUNCTION public.save_sales_day(uuid, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_sales_day(uuid, integer, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
