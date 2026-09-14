-- S746: the guest QR menu re-analysed from Admin -> Guest Menu. Two server-side defects.
--
-- ── 1. An INACTIVE table's QR still took orders ───────────────────────────────────────────────
-- get_guest_menu and submit_guest_order resolved table -> client -> pos_enabled and never read
-- pos_tables.status. But the POS floor renders an inactive table greyed out and ignores clicks on
-- it (PosOrders.jsx), so a guest scanning the sticker on a table taken out of service could send an
-- order that lit up a tile no waiter could open. The admin preview hid inactive tables too, so the
-- operator could not see it happening.
--
-- Decision (Aashish, 2026-09-14): menu, no ordering. get_guest_menu still serves the menu for an
-- inactive table (a QR is often used as a general menu card) but returns
-- guest_ordering_enabled = false, which the page already reads to hide every Add control; and
-- submit_guest_order refuses the table outright, because a flag the browser reads is advisory.
--
-- ── 2. A dish with no selling price was served, and orderable, at NPR 0 ───────────────────────
-- Both functions admitted any active, POS-enabled recipe whatever its price, so a dish switched on
-- before anyone priced it rendered "NPR 0" to the public and went into a guest order snapshot with
-- a NULL unit_price. Decision (same date): leave it off the guest menu, and refuse it in a guest
-- order, until it has a price above zero. The admin preview counts what was left off.
--
-- Bodies reproduced from 20260829170000 -- CREATE OR REPLACE cannot patch a line -- and the ONLY
-- changes are the table-status read and the `selling_price > 0` predicate. Same signatures and
-- return shapes, so CREATE OR REPLACE keeps anon's EXECUTE grant; asserted below rather than assumed.
-- `pos_enabled` stays the gate on both (S632): asserted below as well.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_guest_menu(p_table_id uuid) RETURNS TABLE(
    outlet_name text, table_name text,
    recipe_id uuid, name text, category text, selling_price numeric, vat_rate numeric,
    description text, image_url text, is_veg boolean,
    nutrition_enabled boolean, has_nutrition boolean,
    energy_kcal numeric, protein_g numeric, carbs_g numeric, fat_g numeric, sugar_g numeric, sodium_mg numeric,
    allergens jsonb, guest_ordering_enabled boolean,
    is_vat_registered boolean
) LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_client_id uuid;
  v_table_name text;
  v_table_status text;
  v_outlet_name text;
  v_pos_enabled boolean;
  v_nutrition_enabled boolean;
  v_guest_ordering_enabled boolean;
  v_vat_registered boolean;
  r RECORD;
  roll jsonb;
BEGIN
  SELECT t.client_id, t.name, t.status INTO v_client_id, v_table_name, v_table_status FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN RETURN; END IF;

  SELECT c.name, c.pos_enabled INTO v_outlet_name, v_pos_enabled FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RETURN; END IF;

  SELECT COALESCE(f.nutrition_facts, false) INTO v_nutrition_enabled
  FROM feature_flags f WHERE f.client_id = v_client_id;

  -- Fails OPEN to true: no settings row means the client has never been configured either way,
  -- and true is what the column defaults to and what every JS caller assumes.
  SELECT COALESCE(s.is_vat_registered, true) INTO v_vat_registered
  FROM settings s WHERE s.client_id = v_client_id;
  v_vat_registered := COALESCE(v_vat_registered, true);

  -- S746: ordering comes with POS, except at a table taken out of service. IS DISTINCT FROM, not
  -- <>: status is nullable, and a NULL-status table has never been taken out of service.
  v_guest_ordering_enabled := v_table_status IS DISTINCT FROM 'inactive';

  FOR r IN
    SELECT rc.id, rc.name, rc.category, rc.selling_price, rc.vat_rate, rc.description, rc.image_url, rc.is_veg
    FROM recipes rc
    WHERE rc.client_id = v_client_id AND rc.is_active = true AND rc.pos_enabled = true
      AND rc.category IS DISTINCT FROM 'Sub-Recipe'
      -- S746: an unpriced dish is not on the public menu. `> 0` is NULL-safe here: NULL > 0 is
      -- NULL, which a WHERE treats as false.
      AND rc.selling_price > 0
    ORDER BY rc.category NULLS LAST, rc.name
  LOOP
    IF v_nutrition_enabled THEN
      roll := public._nutrition_rollup(r.id);
    ELSE
      roll := NULL;
    END IF;

    outlet_name := v_outlet_name;
    table_name := v_table_name;
    recipe_id := r.id;
    name := r.name;
    category := r.category;
    selling_price := r.selling_price;
    vat_rate := r.vat_rate;
    description := r.description;
    image_url := r.image_url;
    is_veg := r.is_veg;
    nutrition_enabled := v_nutrition_enabled;
    has_nutrition := v_nutrition_enabled AND COALESCE((roll->>'covered')::boolean, false);
    energy_kcal := (roll->>'energy_kcal')::numeric;
    protein_g := (roll->>'protein_g')::numeric;
    carbs_g := (roll->>'carbs_g')::numeric;
    fat_g := (roll->>'fat_g')::numeric;
    sugar_g := (roll->>'sugar_g')::numeric;
    sodium_mg := (roll->>'sodium_mg')::numeric;
    allergens := COALESCE(roll->'allergens', '[]'::jsonb);
    guest_ordering_enabled := v_guest_ordering_enabled;
    is_vat_registered := v_vat_registered;
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_guest_order(
    p_table_id uuid, p_items jsonb, p_notes text DEFAULT NULL, p_covers integer DEFAULT 1
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_client_id uuid;
  v_table_status text;
  v_pos_enabled boolean;
  v_request_id uuid;
  v_snapshot jsonb := '[]'::jsonb;
  r RECORD;
  item RECORD;
  v_qty numeric;
  v_note text;
BEGIN
  SELECT t.client_id, t.status INTO v_client_id, v_table_status FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN RAISE EXCEPTION 'Table not found'; END IF;

  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RAISE EXCEPTION 'POS not enabled for this restaurant'; END IF;

  -- S746: the floor cannot open an inactive table, so an order for one would strand on a tile
  -- nobody can click.
  IF v_table_status = 'inactive' THEN RAISE EXCEPTION 'This table is not taking orders'; END IF;

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
      AND rc.pos_enabled = true AND rc.category IS DISTINCT FROM 'Sub-Recipe'
      AND rc.selling_price > 0;
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

-- ── Verification ────────────────────────────────────────────────────────────────────────────
-- Behavioural, on a probe client created and rolled back inside a subtransaction: a plpgsql body is
-- not validated at CREATE time, so only a real call proves either function still runs.
DO $guard$
DECLARE
  v_client uuid;
  v_table uuid;
  v_priced uuid;
  v_unpriced uuid;
  v_rows int;
  v_ordering boolean;
  v_req uuid;
BEGIN
  IF pg_get_functiondef('public.submit_guest_order(uuid, jsonb, text, integer)'::regprocedure) NOT LIKE '%pos_enabled%'
     OR pg_get_functiondef('public.get_guest_menu(uuid)'::regprocedure) NOT LIKE '%pos_enabled%' THEN
    RAISE EXCEPTION 'a guest function no longer checks pos_enabled';
  END IF;
  IF NOT has_function_privilege('anon', 'public.get_guest_menu(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon lost EXECUTE on get_guest_menu';
  END IF;
  IF NOT has_function_privilege('anon', 'public.submit_guest_order(uuid, jsonb, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon lost EXECUTE on submit_guest_order';
  END IF;

  BEGIN
    INSERT INTO public.clients (name, pos_enabled) VALUES ('s746 guest probe', true) RETURNING id INTO v_client;
    INSERT INTO public.pos_tables (client_id, name, status) VALUES (v_client, 'Probe T1', 'inactive') RETURNING id INTO v_table;
    INSERT INTO public.recipes (client_id, name, is_active, pos_enabled, selling_price) VALUES (v_client, 'Priced', true, true, 250) RETURNING id INTO v_priced;
    INSERT INTO public.recipes (client_id, name, is_active, pos_enabled, selling_price) VALUES (v_client, 'Unpriced', true, true, NULL) RETURNING id INTO v_unpriced;

    -- Inactive: the menu is served, the unpriced dish is not, and ordering is off.
    SELECT count(*), bool_and(guest_ordering_enabled) INTO v_rows, v_ordering FROM public.get_guest_menu(v_table);
    IF v_rows <> 1 THEN RAISE EXCEPTION 'expected 1 served dish on the probe menu, got %', v_rows; END IF;
    IF v_ordering THEN RAISE EXCEPTION 'an inactive table reported guest ordering enabled'; END IF;

    BEGIN
      PERFORM public.submit_guest_order(v_table, jsonb_build_array(jsonb_build_object('recipe_id', v_priced, 'qty', 1)));
      RAISE EXCEPTION 's746_inactive_accepted';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 's746_inactive_accepted' THEN RAISE EXCEPTION 'submit_guest_order accepted an order for an inactive table'; END IF;
    END;

    -- Back in service: ordering on, the priced dish orders, the unpriced one alone is refused.
    UPDATE public.pos_tables SET status = 'available' WHERE id = v_table;
    SELECT bool_and(guest_ordering_enabled) INTO v_ordering FROM public.get_guest_menu(v_table);
    IF NOT COALESCE(v_ordering, false) THEN RAISE EXCEPTION 'an available table reported guest ordering disabled'; END IF;

    BEGIN
      PERFORM public.submit_guest_order(v_table, jsonb_build_array(jsonb_build_object('recipe_id', v_unpriced, 'qty', 1)));
      RAISE EXCEPTION 's746_unpriced_accepted';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 's746_unpriced_accepted' THEN RAISE EXCEPTION 'submit_guest_order accepted an unpriced dish'; END IF;
    END;

    v_req := public.submit_guest_order(v_table, jsonb_build_array(jsonb_build_object('recipe_id', v_priced, 'qty', 2)));
    IF v_req IS NULL THEN RAISE EXCEPTION 'a valid guest order returned no request id'; END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's746_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's746_probe_rollback' THEN RAISE; END IF;
  END;
END
$guard$;

COMMIT;

NOTIFY pgrst, 'reload schema';
