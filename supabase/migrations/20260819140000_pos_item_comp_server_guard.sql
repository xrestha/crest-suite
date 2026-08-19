-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S579 — item-level comp, the last member of the enforce-it-server-side family.
--
-- S577 closed the discount cap and the void permission (guard_pos_order_close). This is the same
-- shape one table down, and it is arguably the worst of the three because a comp is the one action
-- whose entire purpose is to make revenue disappear on purpose.
--
-- THREE separate holes, all in the same act:
--
--   1. NOTHING GUARDED THE COLUMNS. `pos_order_items` carries a plain same-client policy, so a
--      Staff-rank till JWT could PATCH `comped = true` onto any of its client's order lines
--      directly. That removes the line from the bill (PosOrders' payableOrderItems filters on it,
--      as do SalesReport, demandForecastData and both Credit Note files) with NO NC slip number,
--      NO reason, NO attribution and NO printed Complimentary Slip. Food served, revenue gone,
--      nothing anywhere recording that a comp happened.
--
--   2. THE RPC ITSELF CHECKED CLIENT, NOT RANK. apply_pos_item_comps' guard is
--      `is_admin() OR p_client_id = my client`, while the UI gates the whole comp panel on
--      `hasPosAccess('supervisor')`. So a Staff-rank account that never sees the control could
--      call the function directly and comp anything. Privilege invariant #3 again: a check the
--      browser performs and the server does not is not a check.
--
--   3. `p_comped_by` WAS CALLER-SUPPLIED. The parameter is written straight into
--      `pos_order_items.comped_by` — the column the Sales Exception Report ranks staff by. Any
--      caller could pass a colleague's uuid and comp items under their name. Attribution that the
--      subject of the attribution can choose is not attribution; the record was forgeable by
--      design. This is the same lesson save_pos_order_items already applies to client_id ("derived
--      from the order, never taken as a parameter").
--
-- The parameter is KEPT in the signature and ignored, rather than dropped. Dropping it changes the
-- signature, which (a) orphans the EXECUTE grant per the per-signature rule in
-- .claude/rules/supabase-sql.md and (b) breaks any device still running a cache-first bundle that
-- sends it. Ignoring it is invisible to a correct caller and inert for a malicious one.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. The columns become writable only through the RPC ──────────────────────────────────────
-- Deliberately SECURITY INVOKER, for the same reason as guard_profiles_privileged_columns() and
-- guard_pos_order_close(): current_user is the seam. apply_pos_item_comps is SECURITY DEFINER, so
-- inside it current_user is the function owner and this guard waves it straight through — exactly
-- the mechanism that makes set_active_outlet() the only write path for profiles.active_client_id.
-- Under SECURITY DEFINER here, current_user would be the owner on every call and the guard would
-- never fire at all.
CREATE OR REPLACE FUNCTION public.guard_pos_item_comp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- THE CHEAP TEST COMES FIRST, AND THAT ORDERING IS LOAD-BEARING. This trigger fires per row on
  -- every INSERT and UPDATE of the busiest table in POS — save_pos_order_items replaces an order's
  -- whole line set on every save, so a 20-line bill is 20 invocations. is_admin() is
  -- `LANGUAGE sql STABLE SECURITY DEFINER`, which Postgres refuses to inline (inline_function()
  -- bails on prosecdef), so calling it up front would add a real function call per row for the
  -- overwhelmingly common case of an ordinary, non-comp line. Comparing six columns first means
  -- that case costs a handful of boolean tests and returns; only an actual attempt to write a comp
  -- pays for the identity lookup.
  IF TG_OP = 'INSERT' THEN
    -- save_pos_order_items never touches these columns, so this only fires on a row that arrives
    -- already comped — i.e. a hand-rolled insert forging a complimentary line.
    IF COALESCE(NEW.comped, false) = false
       AND NEW.comp_no IS NULL
       AND NEW.comp_fy IS NULL
       AND NEW.comped_by IS NULL
       AND NEW.comped_at IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    -- UPDATE. Everything else on this table stays free: the KOT send stamps sent_to_kot, notes get
    -- edited mid-service, a partial comp shrinks qty. Only the six comp columns are fenced.
    IF NEW.comped        IS NOT DISTINCT FROM OLD.comped
       AND NEW.comp_no     IS NOT DISTINCT FROM OLD.comp_no
       AND NEW.comp_fy     IS NOT DISTINCT FROM OLD.comp_fy
       AND NEW.comp_reason IS NOT DISTINCT FROM OLD.comp_reason
       AND NEW.comped_by   IS NOT DISTINCT FROM OLD.comped_by
       AND NEW.comped_at   IS NOT DISTINCT FROM OLD.comped_at THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Past this point the write really is touching a comp. is_admin() returns NULL for a caller with
  -- no profile row; `IF NULL THEN` is not true, so an unknown caller falls into the refusal rather
  -- than past it.
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'pos_order_items: complimentary items are applied from the Charge screen (Supervisor or above), which records the reason, the staff member and the NC slip number — they cannot be written directly'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS guard_pos_item_comp ON public.pos_order_items;
CREATE TRIGGER guard_pos_item_comp
  BEFORE INSERT OR UPDATE ON public.pos_order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_pos_item_comp();

REVOKE ALL ON FUNCTION public.guard_pos_item_comp() FROM PUBLIC;

-- ── 2. The RPC checks rank, and stops trusting the caller's word on who did it ───────────────
-- Same signature, so the existing EXECUTE grant carries over untouched and a stale bundle keeps
-- working. Only the body changes.
CREATE OR REPLACE FUNCTION public.apply_pos_item_comps(
    p_order_id uuid,
    p_client_id uuid,
    p_fy text,
    p_comp_reason text,
    p_comped_by uuid,
    p_full_recipe_ids uuid[],
    p_partial jsonb
) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_comp_no integer;
  v_now timestamptz := now();
  v_item jsonb;
  v_order_client uuid;
  v_caller uuid := (SELECT auth.uid());
  v_pos_role text;
  v_comped_by uuid;
BEGIN
  SELECT client_id INTO v_order_client FROM pos_orders WHERE id = p_order_id;
  IF v_order_client IS NULL OR v_order_client <> p_client_id THEN
    RAISE EXCEPTION 'order does not belong to this client';
  END IF;
  -- COALESCE(..., false) is not decoration. A caller with no profiles row makes both operands NULL,
  -- `NULL OR NULL` is NULL, and `IF NOT NULL THEN` does not fire — so the original form of this
  -- check FELL OPEN for exactly the caller it was least sure about. Same trap the codebase already
  -- documents for is_admin() returning NULL.
  IF NOT COALESCE(
    (SELECT role FROM profiles WHERE id = v_caller) = 'admin'
    OR p_client_id = (SELECT client_id FROM profiles WHERE id = v_caller)
  , false) THEN
    RAISE EXCEPTION 'not authorized for this client';
  END IF;

  -- Rank, mirroring hasPosAccess('supervisor') — the gate the Charge screen's comp panel already
  -- applies in React and the server did not. Admin and the Owner resolve to manager on every axis
  -- (the Owner being the ABSENCE of staff markers, hence is_client_owner()), which is what the
  -- frontend assumes too.
  -- Wrapped for the same reason, and here it matters more: pos_role is NULL for every account with
  -- no POS access at all, and `NULL IN ('supervisor','manager')` is NULL, not false. Without the
  -- COALESCE this rank check would wave through precisely the accounts that have no POS rank.
  SELECT pos_role INTO v_pos_role FROM profiles WHERE id = v_caller;
  IF NOT COALESCE(
    (SELECT role FROM profiles WHERE id = v_caller) = 'admin'
    OR public.is_client_owner()
    OR v_pos_role IN ('supervisor', 'manager')
  , false) THEN
    RAISE EXCEPTION
      'complimentary items require Supervisor access or above'
      USING ERRCODE = '42501';
  END IF;

  -- WHO comped is derived, never accepted. p_comped_by is retained in the signature so an older
  -- bundle still binds to this function, and is deliberately ignored: it feeds comped_by, which is
  -- what the Sales Exception Report ranks staff by, so a caller able to choose it could comp items
  -- under a colleague's name. Admin keeps the parameter, because an admin acting on a client's
  -- behalf is legitimately recording someone else as the comping staff member.
  v_comped_by := CASE
    WHEN COALESCE((SELECT role FROM profiles WHERE id = v_caller) = 'admin', false)
      THEN COALESCE(p_comped_by, v_caller)
    ELSE v_caller
  END;

  PERFORM pg_advisory_xact_lock(hashtext('pos_comp_slip_no:' || p_client_id::text || ':' || p_fy));

  SELECT COALESCE(MAX(n), 0) + 1 INTO v_comp_no FROM (
    SELECT invoice_no AS n FROM pos_orders WHERE client_id = p_client_id AND invoice_fy = p_fy AND close_type = 'writeoff'
    UNION ALL
    SELECT comp_no AS n FROM pos_order_items WHERE client_id = p_client_id AND comp_fy = p_fy
  ) combined;

  -- A fully-comped line (compQty === the line's whole qty) just gets marked comped in place.
  IF p_full_recipe_ids IS NOT NULL AND array_length(p_full_recipe_ids, 1) > 0 THEN
    UPDATE pos_order_items
    SET comped = true, comp_reason = p_comp_reason, comped_by = v_comped_by,
        comped_at = v_now, comp_fy = p_fy, comp_no = v_comp_no
    WHERE order_id = p_order_id AND recipe_id = ANY(p_full_recipe_ids);
  END IF;

  -- A partially-comped line (e.g. 1 of 3) needs splitting: shrink the existing row to the paid
  -- remainder, and insert a new row for the comped portion.
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_partial, '[]'::jsonb))
  LOOP
    UPDATE pos_order_items
    SET qty = qty - (v_item->>'comp_qty')::integer
    WHERE order_id = p_order_id AND recipe_id = (v_item->>'recipe_id')::uuid;

    INSERT INTO pos_order_items (
      order_id, client_id, recipe_id, name, category, qty, unit_price, vat_rate, sent_to_kot,
      comped, comp_reason, comped_by, comped_at, comp_fy, comp_no
    ) VALUES (
      p_order_id, p_client_id, (v_item->>'recipe_id')::uuid, v_item->>'name', v_item->>'category',
      (v_item->>'comp_qty')::integer, (v_item->>'unit_price')::numeric, (v_item->>'vat_rate')::numeric,
      COALESCE((v_item->>'sent_to_kot')::boolean, false),
      true, p_comp_reason, v_comped_by, v_now, p_fy, v_comp_no
    );
  END LOOP;

  RETURN v_comp_no;
END;
$$;

NOTIFY pgrst, 'reload schema';
