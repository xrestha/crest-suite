-- submit_guest_order() had no rate-limit/abuse control at all — only a 30-item/50-qty cap per
-- call. Since /pos/menu/:tableId is a fully public, unauthenticated route, a bot scripting
-- repeated calls against it (guessing/reusing a real table_id, visible on the guest menu itself)
-- could flood a table's guest-order queue in PosOrders.jsx with junk pending requests faster than
-- staff could ever clear them — a real, low-effort operational DoS on a live restaurant.
--
-- Fix: at most one PENDING request per table, enforced with a race-free partial unique index
-- (not just an application-level count check, which two near-simultaneous calls could both pass).
-- This directly caps the failure mode that matters — the staff-facing queue can never hold more
-- than one pending item per table, regardless of how many times the RPC is called — without
-- building a whole new IP/session rate-limiting subsystem for what's otherwise a single-purpose
-- endpoint. A guest (or a bot) can still spam submit calls, but every one past the first for a
-- given table is rejected before it ever reaches the queue, and staff accepting/dismissing a
-- request is what reopens the slot — so submission rate is naturally bounded by human staff pace.

CREATE UNIQUE INDEX IF NOT EXISTS pos_guest_order_requests_one_pending_per_table
  ON public.pos_guest_order_requests (table_id) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION public.submit_guest_order(
    p_table_id uuid, p_items jsonb, p_notes text DEFAULT NULL, p_covers integer DEFAULT 1
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_client_id uuid;
  v_pos_enabled boolean;
  v_pos_plan text;
  v_guest_ordering_flag boolean;
  v_request_id uuid;
  v_snapshot jsonb := '[]'::jsonb;
  r RECORD;
  item RECORD;
  v_qty numeric;
  v_note text;
BEGIN
  SELECT t.client_id INTO v_client_id FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN RAISE EXCEPTION 'Table not found'; END IF;

  SELECT c.pos_enabled, c.pos_plan INTO v_pos_enabled, v_pos_plan FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RAISE EXCEPTION 'POS not enabled for this restaurant'; END IF;

  SELECT COALESCE(f.guest_ordering, false) INTO v_guest_ordering_flag FROM feature_flags f WHERE f.client_id = v_client_id;
  IF NOT (v_guest_ordering_flag OR v_pos_plan = 'pro') THEN
    RAISE EXCEPTION 'Guest ordering is not enabled for this restaurant';
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Order is empty'; END IF;
  IF jsonb_array_length(p_items) > 30 THEN RAISE EXCEPTION 'Too many items in one order'; END IF;

  FOR item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(recipe_id uuid, qty numeric, note text)
  LOOP
    IF item.recipe_id IS NULL THEN CONTINUE; END IF;
    v_qty := LEAST(GREATEST(COALESCE(item.qty, 0), 0), 50);
    IF v_qty <= 0 THEN CONTINUE; END IF;
    v_note := NULLIF(left(COALESCE(item.note, ''), 200), '');

    SELECT rc.id, rc.name, rc.category, rc.selling_price, rc.vat_rate INTO r
    FROM recipes rc
    WHERE rc.id = item.recipe_id AND rc.client_id = v_client_id AND rc.is_active = true
      AND rc.pos_enabled = true AND rc.category IS DISTINCT FROM 'Sub-Recipe';
    IF r.id IS NULL THEN CONTINUE; END IF;

    v_snapshot := v_snapshot || jsonb_build_object(
      'recipe_id', r.id, 'name', r.name, 'category', r.category,
      'unit_price', r.selling_price, 'vat_rate', r.vat_rate,
      'qty', v_qty, 'note', v_note
    );
  END LOOP;

  IF jsonb_array_length(v_snapshot) = 0 THEN RAISE EXCEPTION 'No valid items in order'; END IF;

  BEGIN
    INSERT INTO pos_guest_order_requests (client_id, table_id, items, guest_notes, covers)
    VALUES (
      v_client_id, p_table_id, v_snapshot, NULLIF(left(COALESCE(p_notes, ''), 500), ''),
      LEAST(GREATEST(COALESCE(p_covers, 1), 1), 50)
    )
    RETURNING id INTO v_request_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This table already has an order request waiting for staff — please wait for it to be reviewed before sending another.';
  END;

  RETURN v_request_id;
END;
$$;

NOTIFY pgrst, 'reload schema';
