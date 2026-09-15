-- S758 stage 6: Crest Customization on the QR guest menu.
--
--   pos_price_selection(client, recipe, option ids)   one internal pricer for a dish + its picks:
--                                                     validates the picks against the live menu and
--                                                     the dish's group rules, charges the group's
--                                                     "first N free", and returns the snapshot. NOT
--                                                     callable by any client role — only from inside
--                                                     a SECURITY DEFINER body.
--   get_guest_menu_options(table)                     anon-callable: the groups, options and dish
--                                                     attachments for that table's public menu, '{}'
--                                                     unless the outlet has POS AND Customization.
--                                                     A separate function, not new columns on
--                                                     get_guest_menu: changing that RETURNS TABLE
--                                                     needs a DROP and breaks its S746 assertions.
--   submit_guest_order                                body only, same signature: each item may carry
--                                                     `options: uuid[]`. A dish with options is
--                                                     priced and snapshotted here; a pick that is
--                                                     gone, or a dish that must have a choice and
--                                                     came without one, refuses the whole order with
--                                                     HINT unavailable_options naming the dish.
--
-- The snapshot a guest request stores is display and review only. When staff accept it the till
-- sends the option ids through save_pos_order_items, which prices the line again from the menu —
-- a guest can never set what the bill says.
--
-- Rebuilt from the LIVE submit_guest_order body (pg_get_functiondef, 2026-09-15), per S756.

-- ── 1. The pricer ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_price_selection(p_client_id uuid, p_recipe_id uuid, p_option_ids uuid[])
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO 'public'
AS $fn$
DECLARE
  v_ids  text[];
  v_bad  text;
  v_out  jsonb;
BEGIN
  SELECT COALESCE(array_agg(t ORDER BY t COLLATE "C"), ARRAY[]::text[])
    INTO v_ids FROM (SELECT DISTINCT x::text AS t FROM unnest(COALESCE(p_option_ids, ARRAY[]::uuid[])) x WHERE x IS NOT NULL) d;

  -- Every pick is this outlet's, offered, and in an offered group this dish carries.
  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) e
     WHERE NOT EXISTS (
       SELECT 1 FROM pos_options o
         JOIN pos_option_groups g ON g.id = o.group_id AND g.is_active
         JOIN pos_recipe_option_groups a ON a.group_id = g.id AND a.recipe_id = p_recipe_id
        WHERE o.id = e::uuid AND o.client_id = p_client_id AND o.is_active)) THEN
    RETURN jsonb_build_object('problem', 'option_not_on_menu');
  END IF;

  -- Every offered group on the dish gets a count its rule allows (a group with nothing offered is skipped).
  SELECT string_agg(g.name, ', ' ORDER BY g.name) INTO v_bad
    FROM pos_recipe_option_groups a
    JOIN pos_option_groups g ON g.id = a.group_id AND g.is_active
    CROSS JOIN LATERAL (
      SELECT count(*) AS picked FROM unnest(v_ids) e JOIN pos_options o ON o.id = e::uuid AND o.group_id = g.id
    ) c
   WHERE a.recipe_id = p_recipe_id AND a.client_id = p_client_id
     AND EXISTS (SELECT 1 FROM pos_options o2 WHERE o2.group_id = g.id AND o2.is_active)
     AND (c.picked < COALESCE(a.min_override, g.min_select)
          OR c.picked > COALESCE(a.max_override, g.max_select, c.picked));
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('problem', 'option_count', 'groups', v_bad);
  END IF;

  IF cardinality(v_ids) = 0 THEN
    RETURN jsonb_build_object('problem', NULL, 'selection_key', '', 'option_ids', '[]'::jsonb,
                              'delta', 0, 'summary', NULL, 'options', '[]'::jsonb);
  END IF;

  -- Same ordering and "first N free" rule as save_pos_order_items v5 (20260919130000).
  SELECT jsonb_build_object(
           'problem', NULL,
           'selection_key', array_to_string(v_ids, '+'),
           'option_ids', to_jsonb(v_ids),
           'delta', COALESCE(SUM(c.charged), 0),
           'summary', string_agg(c.option_name || CASE WHEN c.included AND c.list_delta <> 0 THEN ' (incl.)' ELSE '' END,
                                 ' · ' ORDER BY c.group_sort, c.gsort, c.osort, c.option_name),
           'options', jsonb_agg(jsonb_build_object(
               'option_id', c.option_id, 'group_id', c.group_id, 'group_name', c.group_name, 'group_kind', c.kind,
               'option_name', c.option_name, 'kitchen_name', c.kitchen_name, 'is_removal', c.is_removal,
               'price_delta', c.charged, 'list_price_delta', c.list_delta, 'included', c.included,
               'sort', c.group_sort * 1000 + c.osort) ORDER BY c.group_sort, c.gsort, c.osort, c.option_name))
    INTO v_out
    FROM (
      SELECT o.id AS option_id, o.group_id, g.name AS group_name, g.kind, o.name AS option_name, o.kitchen_name,
             o.is_removal, o.price_delta AS list_delta, COALESCE(a.sort, 0) AS group_sort, g.sort AS gsort, o.sort AS osort,
             (row_number() OVER (PARTITION BY o.group_id ORDER BY o.sort, o.name, o.id) <= g.included_count) AS included,
             CASE WHEN row_number() OVER (PARTITION BY o.group_id ORDER BY o.sort, o.name, o.id) <= g.included_count
                  THEN 0 ELSE o.price_delta END AS charged
        FROM unnest(v_ids) e
        JOIN pos_options o ON o.id = e::uuid
        JOIN pos_option_groups g ON g.id = o.group_id
        LEFT JOIN pos_recipe_option_groups a ON a.recipe_id = p_recipe_id AND a.group_id = g.id
    ) c;
  RETURN v_out;
END
$fn$;
REVOKE ALL ON FUNCTION public.pos_price_selection(uuid, uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_price_selection(uuid, uuid, uuid[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_price_selection(uuid, uuid, uuid[]) TO service_role;

-- ── 2. The guest read ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_guest_menu_options(p_table_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $fn$
DECLARE
  v_client_id uuid;
BEGIN
  SELECT t.client_id INTO v_client_id FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN RETURN '{}'::jsonb; END IF;
  -- pos_enabled stays the first gate on every public menu function (S632); customization_live
  -- includes it, and is spelled out here so a reader sees the same gate get_guest_menu has.
  IF NOT COALESCE((SELECT c.pos_enabled FROM clients c WHERE c.id = v_client_id), false) THEN RETURN '{}'::jsonb; END IF;
  IF NOT public.customization_live(v_client_id) THEN RETURN '{}'::jsonb; END IF;

  -- Only what a guest sees: active groups and options, attachments for dishes on the public menu.
  -- No stock lines, no kitchen names, no hidden rows.
  RETURN jsonb_build_object(
    'groups', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'kind', g.kind, 'min_select', g.min_select,
                                          'max_select', g.max_select, 'included_count', g.included_count,
                                          'sort', g.sort, 'is_active', true) ORDER BY g.sort, g.name, g.id)
        FROM pos_option_groups g WHERE g.client_id = v_client_id AND g.is_active), '[]'::jsonb),
    'options', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', o.id, 'group_id', o.group_id, 'name', o.name, 'price_delta', o.price_delta,
                                          'is_removal', o.is_removal, 'is_default', o.is_default, 'diet', o.diet,
                                          'allergens', o.allergens, 'sort', o.sort, 'is_active', true) ORDER BY o.sort, o.name, o.id)
        FROM pos_options o JOIN pos_option_groups g ON g.id = o.group_id AND g.is_active
       WHERE o.client_id = v_client_id AND o.is_active), '[]'::jsonb),
    'attachments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('recipe_id', a.recipe_id, 'group_id', a.group_id, 'min_override', a.min_override,
                                          'max_override', a.max_override, 'default_option_id', a.default_option_id,
                                          'sort', a.sort) ORDER BY a.sort, a.id)
        FROM pos_recipe_option_groups a
        JOIN recipes rc ON rc.id = a.recipe_id
       WHERE a.client_id = v_client_id AND rc.is_active AND rc.pos_enabled
         AND rc.category IS DISTINCT FROM 'Sub-Recipe' AND rc.selling_price > 0), '[]'::jsonb)
  );
END
$fn$;
REVOKE ALL ON FUNCTION public.get_guest_menu_options(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_guest_menu_options(uuid) TO anon, authenticated, service_role;

-- ── 3. submit_guest_order, body only ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_guest_order(p_table_id uuid, p_items jsonb, p_notes text DEFAULT NULL::text, p_covers integer DEFAULT 1)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id uuid;
  v_table_status text;
  v_pos_enabled boolean;
  v_cust boolean;
  v_request_id uuid;
  v_snapshot jsonb := '[]'::jsonb;
  v_unavailable text[] := '{}';
  v_bad_options text[] := '{}';
  r RECORD;
  item RECORD;
  v_qty numeric;
  v_note text;
  v_opt_ids uuid[];
  v_has_groups boolean;
  v_sel jsonb;
BEGIN
  SELECT t.client_id, t.status INTO v_client_id, v_table_status FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Table not found' USING HINT = 'table_not_found';
  END IF;

  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN
    RAISE EXCEPTION 'POS not enabled for this restaurant' USING HINT = 'not_accepting';
  END IF;

  -- S746: the floor cannot open an inactive table, so an order for one would strand on a tile
  -- nobody can click.
  IF v_table_status = 'inactive' THEN
    RAISE EXCEPTION 'This table is not taking orders' USING HINT = 'inactive';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order is empty' USING HINT = 'empty';
  END IF;
  IF jsonb_array_length(p_items) > 30 THEN
    RAISE EXCEPTION 'Too many items in one order' USING HINT = 'too_many_items';
  END IF;

  v_cust := public.customization_live(v_client_id);

  FOR item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(recipe_id uuid, qty numeric, note text, options jsonb)
  LOOP
    IF item.recipe_id IS NULL THEN CONTINUE; END IF;
    v_qty := LEAST(GREATEST(FLOOR(COALESCE(item.qty, 0)), 0), 50);
    IF v_qty <= 0 THEN CONTINUE; END IF;
    v_note := NULLIF(left(COALESCE(item.note, ''), 200), '');

    SELECT rc.id, rc.name, rc.category, rc.selling_price, rc.vat_rate, rc.is_active, rc.pos_enabled INTO r
    FROM recipes rc
    WHERE rc.id = item.recipe_id AND rc.client_id = v_client_id;

    IF r.id IS NULL
       OR NOT COALESCE(r.is_active = true AND r.pos_enabled = true
                       AND r.category IS DISTINCT FROM 'Sub-Recipe' AND r.selling_price > 0, false) THEN
      v_unavailable := v_unavailable || COALESCE(NULLIF(btrim(r.name), ''), 'An item');
      CONTINUE;
    END IF;

    -- S758: the picks, as uuids. Anything unreadable is a pick that does not exist.
    BEGIN
      SELECT COALESCE(array_agg(e::uuid), ARRAY[]::uuid[]) INTO v_opt_ids
        FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(item.options) = 'array' THEN item.options ELSE '[]'::jsonb END) e;
    EXCEPTION WHEN invalid_text_representation THEN
      v_bad_options := v_bad_options || r.name;
      CONTINUE;
    END;

    v_has_groups := v_cust AND EXISTS (
      SELECT 1 FROM pos_recipe_option_groups a JOIN pos_option_groups g ON g.id = a.group_id AND g.is_active
       WHERE a.recipe_id = r.id AND EXISTS (SELECT 1 FROM pos_options o WHERE o.group_id = g.id AND o.is_active));

    IF cardinality(v_opt_ids) > 0 AND NOT v_cust THEN
      v_bad_options := v_bad_options || r.name;
      CONTINUE;
    END IF;

    IF v_has_groups THEN
      -- A customizable dish is always checked, picks or not: one that must have a size cannot
      -- arrive without one from a page that was loaded before the dish had choices.
      v_sel := public.pos_price_selection(v_client_id, r.id, v_opt_ids);
      IF v_sel->>'problem' IS NOT NULL THEN
        v_bad_options := v_bad_options || r.name;
        CONTINUE;
      END IF;
    ELSE
      v_sel := NULL;
    END IF;

    IF v_sel IS NOT NULL AND v_sel->>'selection_key' <> '' THEN
      v_snapshot := v_snapshot || jsonb_build_object(
        'recipe_id', r.id, 'name', r.name, 'category', r.category,
        'unit_price', r.selling_price + (v_sel->>'delta')::numeric, 'vat_rate', r.vat_rate,
        'qty', v_qty, 'note', v_note,
        'base_unit_price', r.selling_price, 'options_delta', (v_sel->>'delta')::numeric,
        'selection_key', v_sel->>'selection_key', 'option_ids', v_sel->'option_ids',
        'option_summary', v_sel->>'summary', 'options', v_sel->'options'
      );
    ELSE
      v_snapshot := v_snapshot || jsonb_build_object(
        'recipe_id', r.id, 'name', r.name, 'category', r.category,
        'unit_price', r.selling_price, 'vat_rate', r.vat_rate,
        'qty', v_qty, 'note', v_note
      );
    END IF;
  END LOOP;

  IF cardinality(v_unavailable) > 0 THEN
    RAISE EXCEPTION 'Some items in this order are no longer available'
      USING HINT = 'unavailable_items',
            DETAIL = to_jsonb(ARRAY(SELECT DISTINCT u FROM unnest(v_unavailable) u ORDER BY 1))::text;
  END IF;

  IF cardinality(v_bad_options) > 0 THEN
    RAISE EXCEPTION 'The choices on some dishes are no longer available'
      USING HINT = 'unavailable_options',
            DETAIL = to_jsonb(ARRAY(SELECT DISTINCT u FROM unnest(v_bad_options) u ORDER BY 1))::text;
  END IF;

  IF jsonb_array_length(v_snapshot) = 0 THEN
    RAISE EXCEPTION 'No valid items in order' USING HINT = 'no_valid_items';
  END IF;

  BEGIN
    INSERT INTO pos_guest_order_requests (client_id, table_id, items, guest_notes, covers)
    VALUES (
      v_client_id, p_table_id, v_snapshot, NULLIF(left(COALESCE(p_notes, ''), 500), ''),
      LEAST(GREATEST(COALESCE(p_covers, 1), 1), 50)
    )
    RETURNING id INTO v_request_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This table already has an order request waiting for staff — please wait for it to be reviewed before sending another.'
      USING HINT = 'pending';
  END;

  RETURN v_request_id;
END;
$function$;

NOTIFY pgrst, 'reload schema';

-- ── 4. Verification, rolled back ──────────────────────────────────────────────────────────────
DO $do$
BEGIN
  BEGIN
    DECLARE
      v_c uuid; v_t uuid; v_r uuid; v_plain uuid; v_size uuid; v_half uuid; v_full uuid; v_g uuid; v_egg uuid; v_cheese uuid;
      v_req uuid; v_items jsonb; v_hint text; v_menu jsonb; v_sel jsonb;
    BEGIN
      INSERT INTO public.clients (name, pos_enabled, customization_enabled) VALUES ('__s758e', true, true) RETURNING id INTO v_c;
      INSERT INTO public.pos_tables (client_id, name) VALUES (v_c, 'T1') RETURNING id INTO v_t;
      INSERT INTO public.recipes (client_id, name, selling_price, vat_rate, pos_enabled, is_active, category)
        VALUES (v_c, '__Momo', 250, 0.13, true, true, 'Food') RETURNING id INTO v_r;
      INSERT INTO public.recipes (client_id, name, selling_price, vat_rate, pos_enabled, is_active, category)
        VALUES (v_c, '__Tea', 50, 0.13, true, true, 'Beverage') RETURNING id INTO v_plain;
      INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select, sort) VALUES (v_c, 'Size', 'size', 1, 1, 0) RETURNING id INTO v_size;
      INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort) VALUES (v_c, v_size, 'Half', -100, 0) RETURNING id INTO v_half;
      INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort) VALUES (v_c, v_size, 'Full', 0, 1) RETURNING id INTO v_full;
      INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select, included_count, sort) VALUES (v_c, 'Extras', 'addon', 0, 3, 1, 1) RETURNING id INTO v_g;
      INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort) VALUES (v_c, v_g, 'Add egg', 40, 0) RETURNING id INTO v_egg;
      INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort) VALUES (v_c, v_g, 'Extra cheese', 50, 1) RETURNING id INTO v_cheese;
      INSERT INTO public.pos_recipe_option_groups (client_id, recipe_id, group_id, sort) VALUES (v_c, v_r, v_size, 0), (v_c, v_r, v_g, 1);

      PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
      EXECUTE 'SET LOCAL ROLE anon';

      -- (a) the guest read returns the dish's groups and options
      v_menu := public.get_guest_menu_options(v_t);
      IF jsonb_array_length(v_menu->'options') <> 4 OR jsonb_array_length(v_menu->'attachments') <> 2 THEN
        RAISE EXCEPTION 'S758e verify (a): guest options read wrong: %', v_menu;
      END IF;

      -- (b) a customized order is priced and snapshotted: Half -100 + egg free + cheese +50 = 200
      v_req := public.submit_guest_order(v_t, jsonb_build_array(
        jsonb_build_object('recipe_id', v_r, 'qty', 2, 'options', jsonb_build_array(v_cheese, v_half, v_egg)),
        jsonb_build_object('recipe_id', v_plain, 'qty', 1)), NULL, 2);
      RESET ROLE;
      SELECT items INTO v_items FROM public.pos_guest_order_requests WHERE id = v_req;
      IF (v_items->0->>'unit_price')::numeric <> 200 OR v_items->0->>'option_summary' IS NULL
         OR jsonb_array_length(v_items->0->'options') <> 3 OR (v_items->1->>'unit_price')::numeric <> 50
         OR v_items->1 ? 'selection_key' THEN
        RAISE EXCEPTION 'S758e verify (b): snapshot wrong: %', v_items;
      END IF;
      DELETE FROM public.pos_guest_order_requests WHERE id = v_req;
      EXECUTE 'SET LOCAL ROLE anon';

      -- (c) a dish that must have a size, sent without one, is refused
      BEGIN
        PERFORM public.submit_guest_order(v_t, jsonb_build_array(jsonb_build_object('recipe_id', v_r, 'qty', 1)), NULL, 1);
        RAISE EXCEPTION 'S758e verify (c): missing size NOT refused';
      EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        IF v_hint IS DISTINCT FROM 'unavailable_options' THEN RAISE; END IF;
      END;

      -- (d) an unknown pick is refused
      BEGIN
        PERFORM public.submit_guest_order(v_t, jsonb_build_array(jsonb_build_object('recipe_id', v_r, 'qty', 1,
          'options', jsonb_build_array(v_full, gen_random_uuid()))), NULL, 1);
        RAISE EXCEPTION 'S758e verify (d): unknown pick NOT refused';
      EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        IF v_hint IS DISTINCT FROM 'unavailable_options' THEN RAISE; END IF;
      END;

      -- (e) anon cannot call the pricer directly
      BEGIN
        v_sel := public.pos_price_selection(v_c, v_r, ARRAY[v_full]);
        RAISE EXCEPTION 'S758e verify (e): anon called pos_price_selection';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;

      -- (f) with the module off the guest read is empty and a plain order still goes through
      RESET ROLE;
      UPDATE public.clients SET customization_enabled = false WHERE id = v_c;
      EXECUTE 'SET LOCAL ROLE anon';
      IF public.get_guest_menu_options(v_t) <> '{}'::jsonb THEN
        RAISE EXCEPTION 'S758e verify (f): options returned with the module off';
      END IF;
      v_req := public.submit_guest_order(v_t, jsonb_build_array(jsonb_build_object('recipe_id', v_r, 'qty', 1)), NULL, 1);
      IF v_req IS NULL THEN RAISE EXCEPTION 'S758e verify (f): plain order refused with the module off'; END IF;

      RAISE EXCEPTION 's758e_rollback' USING ERRCODE = 'P0758';
    END;
  EXCEPTION WHEN SQLSTATE 'P0758' THEN
    NULL;
  END;
END
$do$;

DO $do$
BEGIN
  IF NOT has_function_privilege('anon', 'public.get_guest_menu_options(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S758e verify: anon cannot read the guest options';
  END IF;
  IF has_function_privilege('anon', 'public.pos_price_selection(uuid, uuid, uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_price_selection(uuid, uuid, uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'S758e verify: a client role can execute pos_price_selection';
  END IF;
END
$do$;
