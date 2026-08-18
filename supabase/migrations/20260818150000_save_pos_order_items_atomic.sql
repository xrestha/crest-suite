-- S573 — saving a POS order's lines was a DELETE followed by a separate INSERT, from the browser:
--
--   await scopedDelete('pos_order_items').eq('order_id', oid)
--   const { error: iErr } = await scopedInsert('pos_order_items', rows)
--   if (iErr) return null          -- ← the DELETE has already committed
--
-- Two HTTP requests, no transaction. If the insert fails or the connection stalls between them,
-- the live order is left with ZERO lines on the server: the floor tile shows NPR 0, the kitchen
-- ticket history no longer matches any bill, and only the browser's in-memory `orderItems` can
-- recover it — one refresh and the order is gone.
--
-- This is byte-for-byte the shape that cost Sales Entry real data (S456), fixed there with
-- save_sales_day. The trigger for that fix was a live smoke test measuring a single round trip at
-- 12.4s on a connection serving its neighbours in under a second, so the window is not theoretical
-- — and here it sits on the live billing screen, mid-service.
--
-- Deliberately NOT `SECURITY DEFINER`. pos_order_items carries RESTRICTIVE policies
-- (no_self_service_accounts from S316, no_ims_staff from S419, no_hr_role_staff from S430) on top
-- of its permissive same-client policy. Running as INVOKER keeps every one of them enforced with
-- no re-implementation, and means this function can never become the hole that lets an HR or IMS
-- staff account write POS order lines. Nothing here needs to bypass RLS, so it must not.
--
-- Behaviour is intentionally identical to the JS it replaces: the order's lines are replaced
-- wholesale from `p_rows`, preserving sent_to_kot and category as the client sends them.

CREATE OR REPLACE FUNCTION public.save_pos_order_items(
  p_order_id uuid,
  p_rows jsonb
) RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_client_id uuid;
  v_inserted  integer := 0;
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'p_order_id is required';
  END IF;

  IF p_rows IS NOT NULL AND jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a json array';
  END IF;

  -- client_id is derived from the order, never taken as a parameter — a caller must not be able
  -- to stamp someone else's client onto these rows. If RLS hides the order from this caller the
  -- SELECT finds nothing and we refuse, which is also the correct answer for a bad id.
  SELECT client_id INTO v_client_id FROM pos_orders WHERE id = p_order_id;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'order not found or not visible: %', p_order_id;
  END IF;

  -- Both statements run inside this function's single transaction: either the replacement lands
  -- whole or the original lines are still there. That is the entire point of the change.
  DELETE FROM pos_order_items WHERE order_id = p_order_id;

  IF p_rows IS NULL OR jsonb_array_length(p_rows) = 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO pos_order_items (
    order_id, client_id, recipe_id, name, category, qty, unit_price, vat_rate, sent_to_kot, notes
  )
  SELECT
    p_order_id,
    v_client_id,
    NULLIF(r->>'recipe_id', '')::uuid,
    r->>'name',
    COALESCE(NULLIF(r->>'category', ''), 'Other'),
    COALESCE((r->>'qty')::integer, 1),
    COALESCE((r->>'unit_price')::numeric, 0),
    COALESCE((r->>'vat_rate')::numeric, 0),
    COALESCE((r->>'sent_to_kot')::boolean, false),
    NULLIF(r->>'notes', '')
  FROM jsonb_array_elements(p_rows) AS r;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

-- Raw-SQL objects get no grants by default in this project.
REVOKE ALL ON FUNCTION public.save_pos_order_items(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_pos_order_items(uuid, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
