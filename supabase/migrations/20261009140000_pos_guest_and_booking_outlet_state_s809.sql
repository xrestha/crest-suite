-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 1, slice 1h: a locked outlet's public pages take nothing, and one connection can no
-- longer switch off online booking.
--
--   GUEST-4 (P2) and RESERVATIONS-3 (P2). getAccessState() locks every login of an outlet that is
--   deactivated (Archive deactivates too), a trial signup nobody has approved, a trial that has
--   ended, or a subscription past its grace week. That lock lived only in the browser
--   (ProtectedRoute), and the public pages never pass through it: the guest menu and the booking
--   page gated on clients.pos_enabled alone. So a locked outlet's QR codes kept taking orders and its
--   booking link kept taking requests that no till could open, and each guest was left on "Waiting
--   for staff to accept it" or "will confirm shortly".
--
--   Owner decision Q2 (a): a locked outlet shows the same pages as POS switched off. So:
--     (1) public.client_access_open(client) is the SQL twin of getAccessState(client).locked ===
--         false, rule for rule (src/utils/subscription.js; clientAccessOpen.test.js holds the two
--         together). Not callable by any client role: it answers nothing a guest may ask directly.
--     (2) every public function that gates on pos_enabled gets the helper BESIDE that gate, never
--         instead of it (CLAUDE.md), and answers exactly what POS switched off answers: the same
--         empty result, the same raise (message and HINT), the same refusal JSON. The probe below
--         compares each locked answer with the POS-off answer, so the refusal says nothing about
--         the outlet's account that POS switched off does not.
--         That is the 3 booking functions and FIVE guest functions, not the three the slice table
--         names: get_guest_order_progress and get_guest_table_status gate on pos_enabled too, and
--         leaving them open would make a locked outlet answer differently from POS switched off.
--         get_reservation_request_status and get_guest_order_request_status have no pos_enabled
--         gate and are left as they are, so a guest's own status card behaves as with POS off.
--
--   RESERVATIONS-4 (P2). submit_reservation_request recorded an attempt row first and then refused
--   the whole outlet once 40 ATTEMPTS were on record for the hour, refused or not. One connection
--   sending a request every 90 seconds was refused itself after its 5th, but every refusal still
--   added a row, so it kept the page shut for every guest. Owner decision Q3 (a): the outlet-wide
--   limit stays and counts only requests that became bookings (pos_reservations rows from the
--   website in the last hour), with its own code 'busy' so the page no longer blames the guest's
--   connection. The per-connection limit is unchanged and still counts refused attempts.
--
-- Built on the LIVE bodies, read 2026-10-09 (md5 of prosrc):
--   get_guest_menu(uuid)                                   8d2fe07134669a55b054e2029fc8800f
--   get_guest_menu_options(uuid)                           d0683fb12c9cb63423d3420dae83c8a5
--   submit_guest_order(uuid,jsonb,text,integer)            22f4b0f3cb4a278348db913079dee270
--   get_guest_order_progress(uuid)                         d3feb69a57d25a65b5d92b3d52483eb2
--   get_guest_table_status(uuid)                           3de51bd9382b70cf494afa23660ed31d
--   get_booking_page(uuid)                                 3e784ed842d84a7f6f322c5058785683
--   get_booking_availability(uuid)                         b2030ca747f9459a7fd319a600d79f53
--   submit_reservation_request(uuid,text,text,integer,timestamptz,text,text)
--                                                          884697797c85e9d9701996ab74ab85b2
-- Two of those were stored with CRLF line ends (get_booking_availability,
-- submit_reservation_request); they are written back with LF. Every signature, default and
-- RETURNS shape is unchanged, so CREATE OR REPLACE keeps each function's grants exactly as live
-- (anon and authenticated EXECUTE on all eight; PUBLIC also on submit_guest_order,
-- get_guest_table_status, get_booking_availability and submit_reservation_request). The probe
-- asserts them.
--
-- Live before this migration: 3 clients, all open by getAccessState's rules (0 deactivated, 0
-- pending, 0 ended trials, 0 past grace), so no outlet's public pages change today. 0 pending
-- guest orders. 7 booking attempts on record, 0 in the last hour; 6 website bookings, 0 in the last
-- hour. No constraint is added, so no row is rejected.
--
-- No till calls any of these functions: nothing a till on crest-v412 sends is refused.
--
-- The probe at the end calls every function as the anon role inside a block that rolls itself
-- back. If any check fails, the whole migration fails and nothing here lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 1. One definition of "this outlet may trade" ───────────────────────────────────────────
--
-- getAccessState(client), rule for rule, in its order:
--   is_active = false                                   → locked ('deactivated'; Archive sets it too)
--   is_trial and trial_approved_at IS NULL              → locked ('pending'), before any date
--   is_trial and trial_expires_at has passed            → locked ('trial'), no grace
--   no end date on any module                           → OPEN (fails open, like the app)
--   the farthest of the six end dates, in whole days    → open while ceil(days left) >= -7
--                                                          (7 = GRACE_DAYS)
-- A NULL is_active or is_trial reads as the app reads it: not false, not a trial. A client id
-- that does not exist is not open.
--
-- SECURITY INVOKER, and no client role may call it: every caller is a SECURITY DEFINER function
-- owned by postgres, and a guest asking it directly would learn whether an outlet is locked, which
-- POS switched off does not tell them.
CREATE OR REPLACE FUNCTION public.client_access_open(p_client_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $fn$
  SELECT COALESCE((
    SELECT CASE
             WHEN c.is_active IS FALSE THEN false
             WHEN COALESCE(c.is_trial, false) AND c.trial_approved_at IS NULL THEN false
             WHEN COALESCE(c.is_trial, false) AND c.trial_expires_at < now() THEN false
             WHEN e.last_end IS NULL THEN true
             ELSE ceil(extract(epoch FROM (e.last_end - now())) / 86400.0) >= -7
           END
      FROM public.clients c
      CROSS JOIN LATERAL (
        SELECT GREATEST(c.ims_ends_at, c.hr_ends_at, c.pos_ends_at,
                        c.customization_ends_at, c.suite_ends_at, c.subscription_ends_at) AS last_end
      ) e
     WHERE c.id = p_client_id
  ), false);
$fn$;
COMMENT ON FUNCTION public.client_access_open(uuid) IS
  'S809: the SQL twin of getAccessState(client).locked === false (src/utils/subscription.js). Called beside the pos_enabled gate by every public guest-menu and booking function. No client role may execute it.';
REVOKE ALL ON FUNCTION public.client_access_open(uuid) FROM PUBLIC, anon, authenticated;


-- ── 2. The guest menu: a locked outlet serves what POS switched off serves ─────────────────

CREATE OR REPLACE FUNCTION public.get_guest_menu(p_table_id uuid)
 RETURNS TABLE(outlet_name text, table_name text, recipe_id uuid, name text, category text, selling_price numeric, vat_rate numeric, description text, image_url text, is_veg boolean, nutrition_enabled boolean, has_nutrition boolean, energy_kcal numeric, protein_g numeric, carbs_g numeric, fat_g numeric, sugar_g numeric, sodium_mg numeric, allergens jsonb, guest_ordering_enabled boolean, is_vat_registered boolean, menu_name text, logo_url text, category_order text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id uuid;
  v_table_name text;
  v_table_status text;
  v_outlet_name text;
  v_pos_enabled boolean;
  v_nutrition_enabled boolean;
  v_guest_ordering_enabled boolean;
  v_vat_registered boolean;
  v_menu_name text;
  v_logo_url text;
  v_category_order text[];
  r RECORD;
  roll jsonb;
BEGIN
  SELECT t.client_id, t.name, t.status INTO v_client_id, v_table_name, v_table_status FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN RETURN; END IF;

  SELECT c.name, c.pos_enabled INTO v_outlet_name, v_pos_enabled FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RETURN; END IF;
  -- S809 (GUEST-4): an outlet locked out of Crest serves what POS switched off serves: nothing, so
  -- the page shows "This menu isn't available". No till there could see an order. Beside the
  -- pos_enabled gate, never instead of it.
  IF NOT COALESCE(public.client_access_open(v_client_id), false) THEN RETURN; END IF;

  SELECT COALESCE(f.nutrition_facts, false) INTO v_nutrition_enabled
  FROM feature_flags f WHERE f.client_id = v_client_id;
  v_nutrition_enabled := COALESCE(v_nutrition_enabled, false);

  -- Fails OPEN to true: no settings row means the client has never been configured either way,
  -- and true is what the column defaults to and what every JS caller assumes.
  SELECT COALESCE(s.is_vat_registered, true), NULLIF(btrim(s.guest_menu_name), ''), NULLIF(btrim(s.guest_menu_logo_url), ''), s.recipe_categories
    INTO v_vat_registered, v_menu_name, v_logo_url, v_category_order
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
    -- S767: always rolled up, because allergens now reach every client's guests. The nutrient
    -- figures below are still returned only where the Nutrition feature is on.
    roll := public._nutrition_rollup(r.id);

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
    energy_kcal := CASE WHEN v_nutrition_enabled THEN (roll->>'energy_kcal')::numeric END;
    protein_g := CASE WHEN v_nutrition_enabled THEN (roll->>'protein_g')::numeric END;
    carbs_g := CASE WHEN v_nutrition_enabled THEN (roll->>'carbs_g')::numeric END;
    fat_g := CASE WHEN v_nutrition_enabled THEN (roll->>'fat_g')::numeric END;
    sugar_g := CASE WHEN v_nutrition_enabled THEN (roll->>'sugar_g')::numeric END;
    sodium_mg := CASE WHEN v_nutrition_enabled THEN (roll->>'sodium_mg')::numeric END;
    allergens := COALESCE(roll->'allergens', '[]'::jsonb);
    guest_ordering_enabled := v_guest_ordering_enabled;
    is_vat_registered := v_vat_registered;
    menu_name := v_menu_name;
    logo_url := v_logo_url;
    category_order := v_category_order;
    RETURN NEXT;
  END LOOP;
END;
$function$;


CREATE OR REPLACE FUNCTION public.get_guest_menu_options(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id uuid;
BEGIN
  SELECT t.client_id INTO v_client_id FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN RETURN '{}'::jsonb; END IF;
  -- pos_enabled stays the first gate on every public menu function (S632); customization_live
  -- includes it, and is spelled out here so a reader sees the same gate get_guest_menu has.
  IF NOT COALESCE((SELECT c.pos_enabled FROM clients c WHERE c.id = v_client_id), false) THEN RETURN '{}'::jsonb; END IF;
  -- S809 (GUEST-4): a locked outlet answers as POS switched off does.
  IF NOT COALESCE(public.client_access_open(v_client_id), false) THEN RETURN '{}'::jsonb; END IF;
  IF NOT public.customization_live(v_client_id) THEN RETURN '{}'::jsonb; END IF;

  -- Only what a guest sees: active groups and options, attachments for dishes on the public menu.
  -- No stock lines, no kitchen names, no hidden rows.
  RETURN jsonb_build_object(
    'groups', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'kind', g.kind, 'min_select', g.min_select,
                                          'max_select', g.max_select, 'included_count', g.included_count,
                                          'size_scaling', g.size_scaling,
                                          'sort', g.sort, 'is_active', true) ORDER BY g.sort, g.name, g.id)
        FROM pos_option_groups g WHERE g.client_id = v_client_id AND g.is_active), '[]'::jsonb),
    'options', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', o.id, 'group_id', o.group_id, 'name', o.name, 'price_delta', o.price_delta,
                                          'portion_factor', o.portion_factor,
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
         AND rc.category IS DISTINCT FROM 'Sub-Recipe' AND rc.selling_price > 0), '[]'::jsonb),
    -- S760: the dishes the guest sheet walks step by step.
    'build_your_own', COALESCE((
      SELECT jsonb_agg(rc.id ORDER BY rc.id)
        FROM recipes rc
       WHERE rc.client_id = v_client_id AND rc.is_build_your_own AND rc.is_active AND rc.pos_enabled
         AND rc.category IS DISTINCT FROM 'Sub-Recipe' AND rc.selling_price > 0), '[]'::jsonb)
  );
END
$function$;


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

  -- S809 (GUEST-4): a locked outlet refuses with POS switched off's own message and code, so the
  -- guest's page reads it the same way (guestOrderRefusal 'not_accepting', then the menu re-reads
  -- as empty) and the refusal says nothing about the outlet's account. Before the inactive-table
  -- test, because POS switched off is refused before it too.
  IF NOT COALESCE(public.client_access_open(v_client_id), false) THEN
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


CREATE OR REPLACE FUNCTION public.get_guest_order_progress(p_request_id uuid)
 RETURNS TABLE(status text, kot_status text, remaining_minutes integer, order_closed boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_req public.pos_guest_order_requests%ROWTYPE;
  v_pos_enabled boolean;
  v_order_id uuid;
  v_order_status text;
  v_recipe_ids text[];
  v_worst int;
  v_max_ready timestamptz;
  v_rank int;
  v_ready timestamptz;
  r RECORD;
BEGIN
  SELECT * INTO v_req FROM public.pos_guest_order_requests q WHERE q.id = p_request_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- pos_enabled stays the first gate on every guest read (S632).
  SELECT c.pos_enabled INTO v_pos_enabled FROM public.clients c WHERE c.id = v_req.client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RETURN; END IF;
  -- S809 (GUEST-4): and a locked outlet reads as POS switched off (no row: the page keeps what it had).
  IF NOT COALESCE(public.client_access_open(v_req.client_id), false) THEN RETURN; END IF;

  status := v_req.status;
  kot_status := NULL;
  remaining_minutes := NULL;
  order_closed := false;

  IF v_req.status IS DISTINCT FROM 'accepted' THEN
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_req.order_id IS NOT NULL THEN
    SELECT o.id, o.status INTO v_order_id, v_order_status FROM public.pos_orders o WHERE o.id = v_req.order_id;
  END IF;
  -- An accept written before S767, or by a till still on an older bundle, has no order_id. The
  -- bill that took it is the earliest one on this table that was still open when the guest sent
  -- the order — created_at is the SERVER's clock, unlike decided_at, which the tablet writes.
  IF v_order_id IS NULL THEN
    SELECT o.id, o.status INTO v_order_id, v_order_status
      FROM public.pos_orders o
     WHERE o.table_id = v_req.table_id
       AND (o.closed_at IS NULL OR o.closed_at >= v_req.created_at)
     ORDER BY o.opened_at ASC
     LIMIT 1;
  END IF;

  IF v_order_id IS NULL THEN
    RETURN NEXT;
    RETURN;
  END IF;

  order_closed := v_order_status IS DISTINCT FROM 'open';

  SELECT COALESCE(array_agg(DISTINCT e->>'recipe_id'), '{}')
    INTO v_recipe_ids
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_req.items) = 'array' THEN v_req.items ELSE '[]'::jsonb END) e
   WHERE e->>'recipe_id' IS NOT NULL;

  v_worst := NULL;
  v_max_ready := NULL;
  FOR r IN
    SELECT k.status AS kstatus, k.started_at, k.estimated_prep_minutes
      FROM public.pos_kot_log k
     WHERE k.order_id = v_order_id
       AND k.sent_at >= v_req.created_at
       AND k.status IS DISTINCT FROM 'cancelled'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(k.items) = 'array' THEN k.items ELSE '[]'::jsonb END) i
          WHERE i->>'recipe_id' = ANY (v_recipe_ids)
       )
  LOOP
    v_rank := CASE r.kstatus WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'ready' THEN 2 WHEN 'served' THEN 2 ELSE 0 END;
    IF v_worst IS NULL OR v_rank < v_worst THEN v_worst := v_rank; END IF;
    IF r.kstatus = 'in_progress' AND r.started_at IS NOT NULL AND r.estimated_prep_minutes IS NOT NULL THEN
      v_ready := r.started_at + (r.estimated_prep_minutes * interval '1 minute');
      IF v_max_ready IS NULL OR v_ready > v_max_ready THEN v_max_ready := v_ready; END IF;
    END IF;
  END LOOP;

  kot_status := CASE v_worst WHEN 0 THEN 'new' WHEN 1 THEN 'in_progress' WHEN 2 THEN 'ready' ELSE NULL END;
  remaining_minutes := CASE
    WHEN kot_status = 'in_progress' AND v_max_ready IS NOT NULL
      THEN CEIL(EXTRACT(EPOCH FROM (v_max_ready - now())) / 60)::integer
    ELSE NULL
  END;
  RETURN NEXT;
END;
$function$;


CREATE OR REPLACE FUNCTION public.get_guest_table_status(p_table_id uuid)
 RETURNS TABLE(has_open_order boolean, kot_status text, remaining_minutes integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id uuid;
  v_pos_enabled boolean;
  v_order_id uuid;
  v_worst_rank int;
  v_max_ready_at timestamptz;
  r RECORD;
  rank int;
  ready_at_calc timestamptz;
BEGIN
  SELECT t.client_id INTO v_client_id FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN
    has_open_order := false; kot_status := NULL; remaining_minutes := NULL; RETURN NEXT; RETURN;
  END IF;

  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN
    has_open_order := false; kot_status := NULL; remaining_minutes := NULL; RETURN NEXT; RETURN;
  END IF;

  -- S809 (GUEST-4): a locked outlet answers as POS switched off does.
  IF NOT COALESCE(public.client_access_open(v_client_id), false) THEN
    has_open_order := false; kot_status := NULL; remaining_minutes := NULL; RETURN NEXT; RETURN;
  END IF;

  SELECT o.id INTO v_order_id FROM pos_orders o
  WHERE o.table_id = p_table_id AND o.status = 'open'
  ORDER BY o.opened_at DESC LIMIT 1;

  IF v_order_id IS NULL THEN
    has_open_order := false; kot_status := NULL; remaining_minutes := NULL; RETURN NEXT; RETURN;
  END IF;

  v_worst_rank := NULL;
  v_max_ready_at := NULL;
  FOR r IN SELECT status, started_at, estimated_prep_minutes FROM pos_kot_log WHERE order_id = v_order_id
  LOOP
    rank := CASE r.status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'ready' THEN 2 WHEN 'served' THEN 2 ELSE 0 END;
    IF v_worst_rank IS NULL OR rank < v_worst_rank THEN v_worst_rank := rank; END IF;
    IF r.status = 'in_progress' AND r.started_at IS NOT NULL AND r.estimated_prep_minutes IS NOT NULL THEN
      ready_at_calc := r.started_at + (r.estimated_prep_minutes * interval '1 minute');
      IF v_max_ready_at IS NULL OR ready_at_calc > v_max_ready_at THEN v_max_ready_at := ready_at_calc; END IF;
    END IF;
  END LOOP;

  has_open_order := true;
  kot_status := CASE v_worst_rank WHEN 0 THEN 'new' WHEN 1 THEN 'in_progress' WHEN 2 THEN 'ready' ELSE NULL END;
  remaining_minutes := CASE
    WHEN kot_status = 'in_progress' AND v_max_ready_at IS NOT NULL
      THEN CEIL(EXTRACT(EPOCH FROM (v_max_ready_at - now())) / 60)::integer
    ELSE NULL
  END;
  RETURN NEXT;
END;
$function$;


-- ── 3. The booking page: the same, plus a limit one connection cannot trip ─────────────────

CREATE OR REPLACE FUNCTION public.get_booking_page(p_client_id uuid)
 RETURNS TABLE(outlet_name text, open_time text, close_time text, max_party_online integer, min_lead_minutes integer, max_days_ahead integer, total_seats integer, duration_by_band jsonb, closed_weekdays integer[], walk_in_weekdays integer[], closed_dates text[], page_notice text, menu_name text, logo_url text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pos_enabled boolean;
  v_name text;
  v_settings jsonb;
  v_open text;
  v_close text;
  v_seats integer;
  v_menu_name text;
  v_logo_url text;
BEGIN
  SELECT c.pos_enabled, c.name INTO v_pos_enabled, v_name FROM clients c WHERE c.id = p_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RETURN; END IF;
  -- S809 (RESERVATIONS-3): a locked outlet (Archive included) shows what POS switched off shows:
  -- no row, so the page says "Online booking isn't available here right now", without the name.
  IF NOT COALESCE(public.client_access_open(p_client_id), false) THEN RETURN; END IF;

  SELECT s.pos_reservation_settings, s.pos_open_time, s.pos_close_time,
         NULLIF(btrim(s.guest_menu_name), ''), NULLIF(btrim(s.guest_menu_logo_url), '')
    INTO v_settings, v_open, v_close, v_menu_name, v_logo_url
  FROM settings s WHERE s.client_id = p_client_id LIMIT 1;
  IF NOT COALESCE((v_settings->>'public_booking_enabled')::boolean, false) THEN RETURN; END IF;

  SELECT COALESCE(sum(t.capacity), 0)::integer INTO v_seats
  FROM pos_tables t WHERE t.client_id = p_client_id AND COALESCE(t.status, '') <> 'inactive';

  RETURN QUERY SELECT
    v_name, v_open, v_close,
    COALESCE((v_settings->>'max_party_online')::integer, 20),
    COALESCE((v_settings->>'min_lead_minutes')::integer, 60),
    14,
    v_seats,
    COALESCE(v_settings->'duration_by_band', '{}'::jsonb),
    CASE WHEN jsonb_typeof(v_settings->'closed_weekdays') = 'array'
         THEN COALESCE((SELECT array_agg(x::integer) FROM jsonb_array_elements_text(v_settings->'closed_weekdays') x), '{}'::integer[])
         ELSE '{}'::integer[] END,
    CASE WHEN jsonb_typeof(v_settings->'walk_in_weekdays') = 'array'
         THEN COALESCE((SELECT array_agg(x::integer) FROM jsonb_array_elements_text(v_settings->'walk_in_weekdays') x), '{}'::integer[])
         ELSE '{}'::integer[] END,
    CASE WHEN jsonb_typeof(v_settings->'closed_dates') = 'array'
         THEN COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(v_settings->'closed_dates') x), '{}'::text[])
         ELSE '{}'::text[] END,
    NULLIF(btrim(COALESCE(v_settings->>'page_notice', '')), ''),
    v_menu_name,
    v_logo_url;
END;
$function$;


CREATE OR REPLACE FUNCTION public.get_booking_availability(p_client_id uuid)
 RETURNS TABLE(day text, hour integer, covers integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pos_enabled boolean;
  v_settings jsonb;
BEGIN
  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = p_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RETURN; END IF;
  -- S809 (RESERVATIONS-3): a locked outlet answers as POS switched off does.
  IF NOT COALESCE(public.client_access_open(p_client_id), false) THEN RETURN; END IF;
  SELECT s.pos_reservation_settings INTO v_settings FROM settings s WHERE s.client_id = p_client_id LIMIT 1;
  IF NOT COALESCE((v_settings->>'public_booking_enabled')::boolean, false) THEN RETURN; END IF;

  RETURN QUERY
    SELECT to_char(l.day, 'YYYY-MM-DD'), l.hour, l.covers
    FROM public.reservation_hour_load(p_client_id, now(), now() + interval '15 days') l;
END;
$function$;


CREATE OR REPLACE FUNCTION public.submit_reservation_request(p_client_id uuid, p_name text, p_phone text, p_party_size integer, p_reserved_for timestamp with time zone, p_occasion text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pos_enabled boolean;
  v_settings jsonb;
  v_open text;
  v_close text;
  v_max_party integer;
  v_lead integer;
  v_digits text;
  v_phone_c text;
  v_hm text;
  v_local timestamp;
  v_dow integer;
  v_date_iso text;
  v_ip text;
  v_ip_count integer;
  v_client_count integer;
  v_band text;
  v_duration integer;
  v_seats integer;
  v_peak integer;
  v_id uuid;
BEGIN
  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = p_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'closed', 'message', 'Online booking is not available here.');
  END IF;
  -- S809 (RESERVATIONS-3): a locked outlet refuses with POS switched off's own answer, word for
  -- word, before the attempts row (so it costs the guest no quota, as POS switched off does not).
  IF NOT COALESCE(public.client_access_open(p_client_id), false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'closed', 'message', 'Online booking is not available here.');
  END IF;

  SELECT s.pos_reservation_settings, s.pos_open_time, s.pos_close_time
    INTO v_settings, v_open, v_close
  FROM settings s WHERE s.client_id = p_client_id LIMIT 1;
  IF NOT COALESCE((v_settings->>'public_booking_enabled')::boolean, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'closed', 'message', 'Online booking is not available here.');
  END IF;
  v_max_party := COALESCE((v_settings->>'max_party_online')::integer, 20);
  v_lead      := COALESCE((v_settings->>'min_lead_minutes')::integer, 60);

  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'name', 'message', 'Please tell us your name.');
  END IF;
  v_digits  := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_phone_c := regexp_replace(CASE WHEN v_digits ~ '^977.{8,}' THEN substring(v_digits FROM 4) ELSE v_digits END, '^0+', '');
  IF length(v_phone_c) <> 10 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'phone', 'message', 'Please enter a 10-digit mobile number.');
  END IF;
  IF p_party_size IS NULL OR p_party_size < 1 OR p_party_size > v_max_party THEN
    RETURN jsonb_build_object('ok', false, 'code', 'party', 'message',
      format('Online bookings are for 1 to %s guests. For a larger party, please call.', v_max_party));
  END IF;
  IF p_reserved_for IS NULL OR p_reserved_for < now() + make_interval(mins => v_lead) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'too_soon', 'message',
      format('Please book at least %s minutes ahead, or call for a table right now.', v_lead));
  END IF;
  IF p_reserved_for > now() + interval '14 days' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'too_far', 'message', 'Online booking is open up to 14 days ahead.');
  END IF;

  v_local    := p_reserved_for AT TIME ZONE 'Asia/Kathmandu';
  v_hm       := to_char(v_local, 'HH24:MI');
  v_dow      := EXTRACT(dow FROM v_local)::integer;
  v_date_iso := to_char(v_local, 'YYYY-MM-DD');

  IF COALESCE(v_open, '') <> '' AND COALESCE(v_close, '') <> '' THEN
    IF v_open <= v_close THEN
      IF v_hm < v_open OR v_hm > v_close THEN
        RETURN jsonb_build_object('ok', false, 'code', 'hours', 'message', format('Bookings are taken between %s and %s.', v_open, v_close));
      END IF;
    ELSE
      IF v_hm > v_close AND v_hm < v_open THEN
        RETURN jsonb_build_object('ok', false, 'code', 'hours', 'message', format('Bookings are taken between %s and %s.', v_open, v_close));
      END IF;
    END IF;
  END IF;

  -- Closed that day (weekly off, or a listed date), or walk-ins only that weekday.
  IF COALESCE(v_settings->'closed_weekdays' @> to_jsonb(v_dow), false)
     OR COALESCE(v_settings->'closed_dates' @> to_jsonb(v_date_iso), false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'closed_day', 'message', 'Closed that day.');
  END IF;
  IF COALESCE(v_settings->'walk_in_weekdays' @> to_jsonb(v_dow), false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'walk_in', 'message', 'Walk-ins only that day.');
  END IF;

  -- Expected duration from the outlet's own per-band setting, needed for the fullness check too.
  v_band := CASE WHEN p_party_size <= 2 THEN '1-2' WHEN p_party_size <= 4 THEN '3-4' WHEN p_party_size <= 6 THEN '5-6' ELSE '7+' END;
  v_duration := COALESCE((v_settings->'duration_by_band'->>v_band)::integer, 90);
  v_duration := LEAST(GREATEST(v_duration, 15), 720);

  -- Full: in any hour this party would be sitting, booked covers plus this party exceed the
  -- room. A room with no capacity set is never "full" — the host decides at Accept.
  SELECT COALESCE(sum(t.capacity), 0)::integer INTO v_seats
  FROM pos_tables t WHERE t.client_id = p_client_id AND COALESCE(t.status, '') <> 'inactive';
  IF v_seats > 0 THEN
    SELECT COALESCE(max(l.covers), 0) INTO v_peak
    FROM public.reservation_hour_load(p_client_id, p_reserved_for, p_reserved_for + make_interval(mins => v_duration)) l
    WHERE (l.day, l.hour) IN (
      SELECT gs::date, EXTRACT(hour FROM gs)::integer
      FROM generate_series(date_trunc('hour', v_local), v_local + make_interval(mins => v_duration) - interval '1 second', interval '1 hour') gs
    );
    IF v_peak + p_party_size > v_seats THEN
      RETURN jsonb_build_object('ok', false, 'code', 'full', 'message', 'That time is fully booked.');
    END IF;
  END IF;

  -- Rate limit, recorded BEFORE the insert (see 20260904200000 for why this returns rather
  -- than raises).
  BEGIN
    v_ip := split_part(COALESCE(current_setting('request.headers', true)::json->>'x-forwarded-for', ''), ',', 1);
  EXCEPTION WHEN OTHERS THEN
    v_ip := '';
  END;
  v_ip := NULLIF(btrim(v_ip), '');
  INSERT INTO pos_reservation_request_attempts (client_id, ip, phone_canonical)
    VALUES (p_client_id, COALESCE(v_ip, 'unknown'), v_phone_c);
  -- Per connection: every attempt counts, refused ones included, so the cheapest attack (keep
  -- getting refused) still burns this connection's quota.
  SELECT count(*) INTO v_ip_count FROM pos_reservation_request_attempts
    WHERE client_id = p_client_id AND ip = COALESCE(v_ip, 'unknown') AND created_at > now() - interval '1 hour';
  IF v_ip_count > 5 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'rate', 'message', 'Too many booking requests from this connection. Please call instead.');
  END IF;
  -- S809 (RESERVATIONS-4, owner decision Q3 a): the whole outlet's limit counts REQUESTS THAT
  -- BECAME BOOKINGS in the last hour, never attempts. It counted every attempt row, refused ones
  -- included, so one connection refused after its 5th kept adding rows until every guest was
  -- refused. 40 an hour, as before: the 41st is refused. 'busy', not 'rate', so the page no longer
  -- tells a guest their own connection sent too many.
  SELECT count(*) INTO v_client_count FROM pos_reservations
    WHERE client_id = p_client_id AND source = 'website' AND created_at > now() - interval '1 hour';
  IF v_client_count >= 40 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'busy', 'message', 'Online booking is busy right now. Please call instead.');
  END IF;

  BEGIN
    INSERT INTO pos_reservations (client_id, customer_name, phone, party_size, reserved_for, duration_minutes, status, source, occasion, notes)
    VALUES (
      p_client_id, left(btrim(p_name), 80), v_phone_c, p_party_size, p_reserved_for, v_duration,
      'requested', 'website',
      NULLIF(left(btrim(COALESCE(p_occasion, '')), 80), ''),
      NULLIF(left(btrim(COALESCE(p_notes, '')), 300), '')
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pending', 'message', 'You already have a booking request waiting to be confirmed.');
  END;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$function$;

-- The outlet-wide count above runs on every public request that passes validation. Without this
-- it walks every booking the outlet has ever taken (the only client_id index is on reserved_for).
-- Partial: only website rows are written to it.
CREATE INDEX IF NOT EXISTS idx_pos_reservations_website_created
  ON public.pos_reservations (client_id, created_at) WHERE source = 'website';


-- ── 4. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_fn        text;
  v_oid       oid;
  v_n         bigint;
  v_attnum    smallint;
  v_client    uuid;
  v_saved     public.clients%ROWTYPE;
  v_table     uuid;
  v_recipe    uuid;
  v_req       uuid;
  v_lock      text;
  v_i         int := 0;
  v_ref       jsonb;
  v_got       jsonb;
  v_res       jsonb;
  v_before    bigint;
  v_after     bigint;
  v_open      boolean;
  v_sqlstate  text;
  v_msg       text;
  v_hint      text;
  v_detail    text;
  v_when      timestamptz := date_trunc('hour', now()) + interval '3 days';
  -- Each public function and the EXECUTE it held live: PUBLIC, anon, authenticated, service_role.
  v_grants    jsonb := jsonb_build_object(
    'get_guest_menu(uuid)',                              '[false,true,true,true]',
    'get_guest_menu_options(uuid)',                      '[false,true,true,true]',
    'submit_guest_order(uuid,jsonb,text,integer)',       '[true,true,true,true]',
    'get_guest_order_progress(uuid)',                    '[false,true,true,true]',
    'get_guest_table_status(uuid)',                      '[true,true,true,true]',
    'get_booking_page(uuid)',                            '[false,true,true,true]',
    'get_booking_availability(uuid)',                    '[true,true,true,true]',
    'submit_reservation_request(uuid,text,text,integer,timestamp with time zone,text,text)', '[true,true,true,true]');
BEGIN
  -- ── Catalog ──
  -- The helper: INVOKER, STABLE, and callable by no client role (PUBLIC included).
  SELECT p.oid INTO v_oid FROM pg_proc p
   WHERE p.oid = 'public.client_access_open(uuid)'::regprocedure AND NOT p.prosecdef AND p.provolatile = 's';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'S809 1h: client_access_open is missing, SECURITY DEFINER or not STABLE';
  END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE') OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'S809 1h: a client role can execute client_access_open';
  END IF;

  -- The eight public functions: one signature each, still DEFINER, the helper beside the
  -- pos_enabled gate, and the same EXECUTE grants as live.
  FOR v_fn IN SELECT jsonb_object_keys(v_grants) LOOP
    v_oid := ('public.' || v_fn)::regprocedure;
    SELECT count(*) INTO v_n FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace AND proname = (SELECT proname FROM pg_proc WHERE oid = v_oid);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1h: % has % signatures', v_fn, v_n;
    END IF;
    IF NOT (SELECT prosecdef AND prosrc LIKE '%pos_enabled%' AND prosrc LIKE '%public.client_access_open(%'
              FROM pg_proc WHERE oid = v_oid) THEN
      RAISE EXCEPTION 'S809 1h: % lost SECURITY DEFINER, its pos_enabled gate or the access gate', v_fn;
    END IF;
    IF jsonb_build_array(has_function_privilege('public', v_oid, 'EXECUTE'),
                         has_function_privilege('anon', v_oid, 'EXECUTE'),
                         has_function_privilege('authenticated', v_oid, 'EXECUTE'),
                         has_function_privilege('service_role', v_oid, 'EXECUTE'))
       IS DISTINCT FROM (v_grants->>v_fn)::jsonb THEN
      RAISE EXCEPTION 'S809 1h: % EXECUTE for public/anon/authenticated/service_role changed to %', v_fn,
        jsonb_build_array(has_function_privilege('public', v_oid, 'EXECUTE'), has_function_privilege('anon', v_oid, 'EXECUTE'),
                          has_function_privilege('authenticated', v_oid, 'EXECUTE'), has_function_privilege('service_role', v_oid, 'EXECUTE'));
    END IF;
  END LOOP;

  -- The website-bookings index leads on client_id and is partial.
  SELECT attnum INTO v_attnum FROM pg_attribute
   WHERE attrelid = 'public.pos_reservations'::regclass AND attname = 'client_id';
  SELECT count(*) INTO v_n FROM pg_index i
   WHERE i.indexrelid = 'public.idx_pos_reservations_website_created'::regclass
     AND i.indkey[0] = v_attnum AND i.indpred IS NOT NULL;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 1h: idx_pos_reservations_website_created does not lead on client_id or is not partial';
  END IF;

  -- ── The outlet: POS on, a settings row, and a plain dish on its guest menu ──
  SELECT c.id INTO v_client FROM public.clients c
   WHERE c.pos_enabled
     AND EXISTS (SELECT 1 FROM public.settings s WHERE s.client_id = c.id)
     AND EXISTS (SELECT 1 FROM public.recipes rc
                  WHERE rc.client_id = c.id AND rc.is_active AND rc.pos_enabled
                    AND rc.category IS DISTINCT FROM 'Sub-Recipe' AND rc.selling_price > 0
                    AND NOT EXISTS (SELECT 1 FROM public.pos_recipe_option_groups a WHERE a.recipe_id = rc.id))
   ORDER BY c.id
   LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S809 1h probe: no POS outlet with a settings row and a dish with no choices on its guest menu';
  END IF;
  SELECT * INTO v_saved FROM public.clients WHERE id = v_client;
  SELECT rc.id INTO v_recipe FROM public.recipes rc
   WHERE rc.client_id = v_client AND rc.is_active AND rc.pos_enabled
     AND rc.category IS DISTINCT FROM 'Sub-Recipe' AND rc.selling_price > 0
     AND NOT EXISTS (SELECT 1 FROM public.pos_recipe_option_groups a WHERE a.recipe_id = rc.id)
   ORDER BY rc.id LIMIT 1;

  BEGIN
    -- Setup, as the migration's own role. A table of its own (500 seats, so nothing is "full"),
    -- online booking on with no closed days and no hours, one accepted booking so the availability
    -- read has a row to return, and the outlet open by every rule with no dates at all.
    INSERT INTO public.pos_tables (client_id, name, capacity, status)
      VALUES (v_client, 'S809 1h probe', 500, 'available') RETURNING id INTO v_table;
    UPDATE public.settings
       SET pos_reservation_settings = COALESCE(pos_reservation_settings, '{}'::jsonb) || jsonb_build_object(
             'public_booking_enabled', true, 'closed_weekdays', '[]'::jsonb, 'walk_in_weekdays', '[]'::jsonb,
             'closed_dates', '[]'::jsonb, 'min_lead_minutes', 60, 'max_party_online', 20),
           pos_open_time = NULL, pos_close_time = NULL
     WHERE client_id = v_client;
    INSERT INTO public.pos_reservations (client_id, customer_name, phone, party_size, reserved_for, status, source)
      VALUES (v_client, 'S809 1h load', '9500000001', 2, v_when + interval '1 day', 'booked', 'phone');
    UPDATE public.clients
       SET is_active = true, is_trial = false, trial_approved_at = NULL, trial_expires_at = NULL,
           ims_ends_at = NULL, hr_ends_at = NULL, pos_ends_at = NULL, customization_ends_at = NULL,
           suite_ends_at = NULL, subscription_ends_at = NULL
     WHERE id = v_client;

    -- A guest order placed while the outlet is open: its progress is what a locked outlet must
    -- stop answering, as POS switched off does.
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    v_req := public.submit_guest_order(v_table, jsonb_build_array(jsonb_build_object('recipe_id', v_recipe, 'qty', 1)), NULL, 2);
    SELECT count(*) INTO v_n FROM public.get_guest_order_progress(v_req) WHERE status = 'pending';
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    IF v_req IS NULL OR v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1h probe: an open outlet did not take a guest order (%), or its progress did not read pending', v_req;
    END IF;

    -- (a) Every surface, in each state. 'pos_off' comes first: it is the reference. The four lock
    -- reasons must answer it exactly; the open states must work.
    FOREACH v_lock IN ARRAY ARRAY['pos_off', 'deactivated', 'pending', 'trial', 'expired',
                                  'grace', 'farthest_wins', 'active_null']
    LOOP
      v_i := v_i + 1;
      UPDATE public.clients SET
          pos_enabled           = (v_lock <> 'pos_off'),
          customization_enabled = CASE WHEN v_lock = 'pos_off' THEN false ELSE v_saved.customization_enabled END,
          is_active             = CASE v_lock WHEN 'deactivated' THEN false WHEN 'active_null' THEN NULL ELSE true END,
          is_trial              = (v_lock IN ('pending', 'trial')),
          trial_approved_at     = CASE v_lock WHEN 'trial' THEN now() - interval '8 days' END,
          -- A pending signup carries a provisional expiry still in the future; it locks anyway.
          trial_expires_at      = CASE v_lock WHEN 'pending' THEN now() + interval '5 days'
                                              WHEN 'trial'   THEN now() - interval '1 hour' END,
          ims_ends_at           = CASE v_lock WHEN 'expired' THEN now() - interval '20 days'
                                              WHEN 'farthest_wins' THEN now() - interval '60 days' END,
          hr_ends_at            = NULL,
          -- The grace edge, from getAccessState: ceil(days left) = -7 is open, -8 is locked.
          pos_ends_at           = CASE v_lock WHEN 'expired' THEN now() - interval '8 days 1 minute'
                                              WHEN 'grace'   THEN now() - interval '7 days 23 hours' END,
          customization_ends_at = NULL,
          suite_ends_at         = CASE v_lock WHEN 'farthest_wins' THEN now() + interval '10 days' END,
          subscription_ends_at  = NULL
       WHERE id = v_client;

      v_open := v_lock IN ('pos_off', 'grace', 'farthest_wins', 'active_null');
      IF public.client_access_open(v_client) IS DISTINCT FROM v_open THEN
        RAISE EXCEPTION 'S809 1h probe: client_access_open is % for the % state', public.client_access_open(v_client), v_lock;
      END IF;

      SELECT count(*) INTO v_before FROM public.pos_reservation_request_attempts WHERE client_id = v_client;

      -- As a guest: the anon role, a connection of its own.
      PERFORM set_config('request.headers', json_build_object('x-forwarded-for', '203.0.113.' || v_i)::text, true);
      PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
      SET LOCAL ROLE anon;
      v_got := jsonb_build_object(
        'menu',     (SELECT count(*) FROM public.get_guest_menu(v_table)),
        'options',  public.get_guest_menu_options(v_table),
        'progress', (SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::jsonb) FROM public.get_guest_order_progress(v_req) p),
        'table',    (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]'::jsonb) FROM public.get_guest_table_status(v_table) s),
        'page',     (SELECT count(*) FROM public.get_booking_page(v_client)),
        'slots',    (SELECT count(*) FROM public.get_booking_availability(v_client)),
        'booking',  public.submit_reservation_request(v_client, 'S809 probe guest', '91000000' || lpad(v_i::text, 2, '0'),
                                                       2, v_when, NULL, NULL));
      BEGIN
        PERFORM public.submit_guest_order(v_table, jsonb_build_array(jsonb_build_object('recipe_id', v_recipe, 'qty', 1)), NULL, 2);
        v_got := v_got || jsonb_build_object('order', 'sent');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                                v_hint = PG_EXCEPTION_HINT, v_detail = PG_EXCEPTION_DETAIL;
        v_got := v_got || jsonb_build_object('order', jsonb_build_object(
                   'sqlstate', v_sqlstate, 'message', v_msg, 'hint', v_hint, 'detail', v_detail));
      END;
      RESET ROLE;
      PERFORM set_config('request.jwt.claims', '', true);

      SELECT count(*) INTO v_after FROM public.pos_reservation_request_attempts WHERE client_id = v_client;

      IF v_lock = 'pos_off' THEN
        -- The reference must really be the closed shape, or every comparison below is vacuous.
        IF (v_got->>'menu')::int <> 0 OR v_got->'options' <> '{}'::jsonb OR v_got->'progress' <> '[]'::jsonb
           OR (v_got->>'page')::int <> 0 OR (v_got->>'slots')::int <> 0
           OR v_got->'booking'->>'code' IS DISTINCT FROM 'closed'
           OR v_got->'order'->>'hint' IS DISTINCT FROM 'not_accepting'
           OR v_after <> v_before THEN
          RAISE EXCEPTION 'S809 1h probe: POS switched off answered % (attempts % → %)', v_got, v_before, v_after;
        END IF;
        v_ref := v_got;
      ELSIF NOT v_open THEN
        IF v_got IS DISTINCT FROM v_ref THEN
          RAISE EXCEPTION 'S809 1h probe: a % outlet answered % where POS switched off answers %', v_lock, v_got, v_ref;
        END IF;
        IF v_after <> v_before THEN
          RAISE EXCEPTION 'S809 1h probe: a % outlet''s booking refusal cost the guest an attempt', v_lock;
        END IF;
      ELSE
        -- Open: the menu, the page and its slots answer, a booking lands, and a second guest order
        -- on the same table is refused only because the first is still waiting.
        IF (v_got->>'menu')::int = 0 OR (v_got->>'page')::int <> 1 OR (v_got->>'slots')::int = 0
           OR v_got->'progress'->0->>'status' IS DISTINCT FROM 'pending'
           OR NOT COALESCE((v_got->'booking'->>'ok')::boolean, false)
           OR v_got->'order'->>'hint' IS DISTINCT FROM 'pending'
           OR v_after <> v_before + 1 THEN
          RAISE EXCEPTION 'S809 1h probe: an open (%) outlet answered %', v_lock, v_got;
        END IF;
      END IF;
    END LOOP;

    -- A client id that does not exist is not open.
    IF public.client_access_open(gen_random_uuid()) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'S809 1h probe: client_access_open is not false for a client that does not exist';
    END IF;

    -- (b) RESERVATIONS-4. Back to open.
    UPDATE public.clients
       SET pos_enabled = true, customization_enabled = v_saved.customization_enabled, is_active = true,
           is_trial = false, trial_approved_at = NULL, trial_expires_at = NULL,
           ims_ends_at = NULL, hr_ends_at = NULL, pos_ends_at = NULL, customization_ends_at = NULL,
           suite_ends_at = NULL, subscription_ends_at = NULL
     WHERE id = v_client;

    -- (b1) 45 refused attempts from other connections in the last hour (the old trigger was 40):
    -- a real guest is still taken.
    INSERT INTO public.pos_reservation_request_attempts (client_id, ip, phone_canonical, created_at)
      SELECT v_client, '198.51.100.' || g, '93000' || lpad(g::text, 5, '0'), now() - interval '10 minutes'
        FROM generate_series(1, 45) g;
    PERFORM set_config('request.headers', '{"x-forwarded-for":"203.0.113.100"}', true);
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    v_res := public.submit_reservation_request(v_client, 'S809 probe guest', '9100000100', 2, v_when, NULL, NULL);
    RESET ROLE;
    IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'S809 1h probe: 45 refused attempts from other connections still refused a guest: %', v_res;
    END IF;

    -- (b2) The per-connection limit still counts refused attempts: a 6th in the hour is refused.
    INSERT INTO public.pos_reservation_request_attempts (client_id, ip, phone_canonical, created_at)
      SELECT v_client, '203.0.113.101', '9300000000', now() - interval '5 minutes' FROM generate_series(1, 5);
    PERFORM set_config('request.headers', '{"x-forwarded-for":"203.0.113.101"}', true);
    SET LOCAL ROLE anon;
    v_res := public.submit_reservation_request(v_client, 'S809 probe guest', '9100000101', 2, v_when, NULL, NULL);
    RESET ROLE;
    IF v_res->>'code' IS DISTINCT FROM 'rate' THEN
      RAISE EXCEPTION 'S809 1h probe: a 6th attempt from one connection was not refused as rate: %', v_res;
    END IF;

    -- (b3) The outlet-wide limit counts bookings: the 40th website booking of the hour lands, the
    -- 41st is refused as busy, without blaming the connection, and lands nothing.
    SELECT count(*) INTO v_n FROM public.pos_reservations
     WHERE client_id = v_client AND source = 'website' AND created_at > now() - interval '1 hour';
    IF v_n > 39 THEN
      RAISE EXCEPTION 'S809 1h probe: % website bookings already in the hour', v_n;
    END IF;
    INSERT INTO public.pos_reservations (client_id, customer_name, phone, party_size, reserved_for, status, source)
      SELECT v_client, 'S809 flood ' || g, '92000' || lpad(g::text, 5, '0'), 2, v_when + interval '7 days', 'requested', 'website'
        FROM generate_series(1, 39 - v_n) g;
    PERFORM set_config('request.headers', '{"x-forwarded-for":"203.0.113.102"}', true);
    SET LOCAL ROLE anon;
    v_res := public.submit_reservation_request(v_client, 'S809 probe guest', '9100000102', 2, v_when, NULL, NULL);
    RESET ROLE;
    IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'S809 1h probe: the 40th website booking of the hour was refused: %', v_res;
    END IF;
    PERFORM set_config('request.headers', '{"x-forwarded-for":"203.0.113.103"}', true);
    SET LOCAL ROLE anon;
    v_res := public.submit_reservation_request(v_client, 'S809 probe guest', '9100000103', 2, v_when, NULL, NULL);
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    SELECT count(*) INTO v_n FROM public.pos_reservations
     WHERE client_id = v_client AND source = 'website' AND created_at > now() - interval '1 hour';
    IF v_res->>'code' IS DISTINCT FROM 'busy' OR v_res->>'message' ILIKE '%connection%' OR v_n <> 40 THEN
      RAISE EXCEPTION 'S809 1h probe: the 41st website booking answered % with % in the hour', v_res, v_n;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_1h_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_1h_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT p.proname, md5(p.prosrc), p.prosecdef, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
--     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
--      AND p.proname IN ('client_access_open', 'get_guest_menu', 'get_guest_menu_options', 'submit_guest_order',
--                        'get_guest_order_progress', 'get_guest_table_status', 'get_booking_page',
--                        'get_booking_availability', 'submit_reservation_request') ORDER BY 1;
--   SELECT c.name, public.client_access_open(c.id) FROM public.clients c ORDER BY 1;   -- all true today
--   SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_pos_reservations_website_created';
