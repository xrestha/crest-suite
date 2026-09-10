-- S724 — Combo Builder's "Bills Together" was not a count of bills, and it counted bills that
-- never happened.
--
-- Three faults in one nine-line query, all of them in the direction that makes a pairing look
-- stronger than it is. The page prices a discounted combo off this number.
--
-- 1. COUNT(*) over a self-join counts ROW PAIRS, not bills. That is usually the same thing here,
--    because PosOrders' addItem() merges a repeat order of the same dish into the existing line
--    (`findIndex(i => i.recipe_id === recipe.id)`) — so one bill normally holds one row per
--    recipe. Except `apply_pos_item_comp` (20260819140000), which deliberately SPLITS a partially
--    comped line: it decrements the original row's qty and INSERTS a second row, same order_id,
--    same recipe_id, for the comped portion. A bill where either item was part-comped therefore
--    counted 2×, and 4× if both were. Comping is not rare — it is the busiest tables it happens
--    on, which are exactly the ones this report is built from. COUNT(DISTINCT a.order_id) is what
--    the column header, the tooltip and the module guide have all claimed since it shipped.
--
-- 2. There was no filter on the order at all, so `pos_orders` rows with status='open' — bills
--    still being built on a table right now — and close_type='void' — bills explicitly cancelled,
--    which is the strongest available statement that the thing did not happen — both fed the
--    ranking. `close_type = 'paid'` is the house definition of a bill that occurred: SalesReport
--    and CoversReport both scope exactly this way, and a co-occurrence report that disagrees with
--    the revenue reports about which bills exist is a third opinion nobody asked for. It also
--    drops writeoffs (whole-bill complimentary), which are a management decision rather than a
--    guest's choice of what to order alongside what.
--
-- 3. The window was measured on `created_at`. A bill belongs to the day it was BILLED, which is
--    `closed_at` — the column every other POS report windows on. An order opened on the 29th and
--    settled on the 1st sat in the wrong month.
--
-- Also NEW: `anchor_bills`, the number of bills in the window containing the anchor item at all.
-- Without it the page's Frequency bar could only be drawn relative to the top pairing, so the top
-- row was always a full bar and the column answered "how does this compare to the best pair"
-- rather than the question a person actually has, which is "how often does this happen". With it,
-- 34 of 120 reads as 28% of that dish's bills.
--
-- There are TWO callers, not one. Combo Builder is the page named after this function; the other
-- is `PosOrders.jsx`'s suggestion engine, which re-ranks the "goes well with" panel on the till
-- from the same counts. So the inflation above was not confined to a report an owner reads
-- occasionally — it was steering what a waiter got prompted to upsell, mid-service, off a ranking
-- that counted cancelled bills and double-counted comped ones. That caller reads
-- `paired_recipe_id` and `co_count` by NAME out of the PostgREST JSON, so the added third column
-- is inert there and it needs no change; check that again before altering either of the two it
-- does read.
--
-- Adding a column to RETURNS TABLE is NOT CREATE OR REPLACE-compatible — Postgres keys the replace
-- on the argument signature but refuses to change the return type in place ("cannot change return
-- type of existing function"). DROP first. The grants do not survive the drop, so they are
-- re-issued below, in the same shape 20260720150000 settled: REVOKE from PUBLIC (revoking from
-- `anon` alone is a no-op while PUBLIC still holds it), then GRANT to the two roles that need it.

DROP FUNCTION IF EXISTS public.get_cooccurrence(uuid, uuid, integer);

CREATE FUNCTION public.get_cooccurrence(
    p_client_id uuid, p_recipe_id uuid, p_days integer DEFAULT 90
) RETURNS TABLE(paired_recipe_id uuid, co_count bigint, anchor_bills bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_since timestamptz := NOW() - (GREATEST(COALESCE(p_days, 90), 1) || ' days')::INTERVAL;
  v_anchor_bills bigint;
BEGIN
  -- COALESCE(..., false): is_admin() can return NULL, and `NULL OR false` is NULL, which an
  -- `IF NOT` never fires on — the fail-open shape 20260829120000 wrapped this guard for.
  IF NOT COALESCE(
    public.is_admin() OR p_client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()),
    false
  ) THEN
    RAISE EXCEPTION 'not authorized for this client';
  END IF;

  SELECT COUNT(DISTINCT a.order_id) INTO v_anchor_bills
  FROM pos_order_items a
  JOIN pos_orders o ON o.id = a.order_id
  WHERE a.client_id = p_client_id
    AND a.recipe_id = p_recipe_id
    AND o.close_type = 'paid'
    AND o.closed_at >= v_since;

  RETURN QUERY
    SELECT b.recipe_id AS paired_recipe_id,
           COUNT(DISTINCT a.order_id) AS co_count,
           v_anchor_bills AS anchor_bills
    FROM pos_order_items a
    JOIN pos_order_items b ON a.order_id = b.order_id AND a.recipe_id != b.recipe_id
    JOIN pos_orders o ON o.id = a.order_id
    WHERE a.client_id = p_client_id
      AND a.recipe_id = p_recipe_id
      AND o.close_type = 'paid'
      AND o.closed_at >= v_since
    GROUP BY b.recipe_id
    ORDER BY co_count DESC
    LIMIT 10;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_cooccurrence(uuid, uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_cooccurrence(uuid, uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_cooccurrence(uuid, uuid, integer) TO authenticated, service_role;

-- Assert the drop-and-recreate left exactly one function behind, not two overloads — the fault
-- 20260829120000 found on submit_guest_order, where a signature change quietly forked the
-- function and every later fix landed on only one of them.
DO $$
DECLARE v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_cooccurrence';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 get_cooccurrence, found %', v_count;
  END IF;
END $$;

-- And that anon really lost it: a REVOKE from a role is a no-op while PUBLIC still holds the
-- grant, which is the whole reason 20260720150000 exists.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.get_cooccurrence(uuid, uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon still holds EXECUTE on get_cooccurrence';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_cooccurrence(uuid, uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost EXECUTE on get_cooccurrence';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
