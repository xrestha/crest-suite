-- Guest QR menu: live Sent/Started/Ready kitchen-status badge for the guest's own table.
--
-- No guest order-placement flow exists yet (GuestMenu.jsx is still view-only) — but that turns
-- out not to be a real blocker for this badge. A table has at most one 'open' pos_orders row at
-- a time regardless of who entered it (staff via PosOrders.jsx today, or a guest-placed order
-- later), so "the guest's order" for badge purposes is simply whatever is currently open on the
-- table their QR code points to. Same anonymous-caller pattern as get_guest_menu: no internal
-- auth check, only ever returns whitelisted, non-sensitive fields (no prices, no item names, no
-- staff identity — just a status enum), callable by anon via Postgres's default PUBLIC-execute
-- grant.
CREATE FUNCTION public.get_guest_table_status(p_table_id uuid) RETURNS TABLE(
    has_open_order boolean, kot_status text
) LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_client_id uuid;
  v_pos_enabled boolean;
  v_order_id uuid;
  v_worst_rank int;
  r RECORD;
  rank int;
BEGIN
  SELECT t.client_id INTO v_client_id FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN
    has_open_order := false; kot_status := NULL; RETURN NEXT; RETURN;
  END IF;

  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN
    has_open_order := false; kot_status := NULL; RETURN NEXT; RETURN;
  END IF;

  -- Most recently opened, in case a stray second 'open' row ever exists for the same table.
  SELECT o.id INTO v_order_id FROM pos_orders o
  WHERE o.table_id = p_table_id AND o.status = 'open'
  ORDER BY o.opened_at DESC LIMIT 1;

  IF v_order_id IS NULL THEN
    has_open_order := false; kot_status := NULL; RETURN NEXT; RETURN;
  END IF;

  -- Worst (least-advanced) status across all tickets sent for this order — same "still needs
  -- attention" logic as the staff floor-view badge in PosOrders.jsx.
  v_worst_rank := NULL;
  FOR r IN SELECT status FROM pos_kot_log WHERE order_id = v_order_id
  LOOP
    rank := CASE r.status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'ready' THEN 2 ELSE 0 END;
    IF v_worst_rank IS NULL OR rank < v_worst_rank THEN v_worst_rank := rank; END IF;
  END LOOP;

  has_open_order := true;
  kot_status := CASE v_worst_rank WHEN 0 THEN 'new' WHEN 1 THEN 'in_progress' WHEN 2 THEN 'ready' ELSE NULL END;
  RETURN NEXT;
END;
$$;

NOTIFY pgrst, 'reload schema';
