-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Guest QR Self-Ordering comes free with the Crest POS module. The SQL was the odd one out.
--
-- S631 removed the `pos_plan = 'pro'` auto-unlock and left `feature_flags.guest_ordering` as the
-- sole gate, on the strength of three sources agreeing: the SQL itself, posGuideData.js, and the
-- original 20260707210000 migration calling it a Pro-tier feature. A fourth source disagreed --
-- AuthContext's POS_MODULE_KEYS grants it on `posEnabled` alone, and FeatureAccessModal renders
-- it LOCKED with a "Plan" chip once POS is on, i.e. "included with the module, not toggleable".
--
-- The product owner settled it: the module-included reading is correct. POS is a flat module and
-- guest ordering is part of it. So the three "agreeing" sources were agreeing about an accident
-- of implementation, and the odd one out was the one that had it right.
--
-- ── Why the flag check is deleted rather than widened ───────────────────────────────────────
-- The obvious edit is `flag OR pos_enabled`, mirroring hasFeature(). But both functions already
-- gate on pos_enabled and return/raise before the flag is ever consulted:
--
--     IF NOT COALESCE(v_pos_enabled, false) THEN RAISE EXCEPTION 'POS not enabled ...'; END IF;
--     IF NOT COALESCE(v_pos_enabled, false) THEN RETURN; END IF;
--
-- so at the point of the flag check, pos_enabled is already true and `flag OR pos_enabled` is
-- unconditionally true. Writing it that way would leave a condition that reads like a decision
-- and can only have one answer -- the shape that makes the next reader think a control exists.
--
-- ── What this does to the flag ──────────────────────────────────────────────────────────────
-- `feature_flags.guest_ordering` now gates nothing in SQL. It is still written by
-- FeatureAccessModal, which offers it as a live toggle only while POS is OFF ("POS is off --
-- check to override"); that override grants nothing usable, because a client with POS off has no
-- guest menu for it to apply to -- get_guest_menu returns at the pos_enabled gate. Left in place
-- rather than removed: the column is harmless, the modal's locked/unlocked rendering is already
-- honest about the module-included rule, and ripping a control out of an admin screen is a
-- separate decision from the gating one settled here.
--
-- ── Live impact: none ───────────────────────────────────────────────────────────────────────
-- Exactly one client has pos_enabled = true, and it holds guest_ordering = true already (S631's
-- sweep). Every other client is blocked at the pos_enabled gate before and after. The change is
-- entirely about the NEXT client POS is switched on for, who would otherwise have seen guest
-- ordering shown as included-and-locked on the admin screen while guests were refused.
-- ════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.submit_guest_order(
    p_table_id uuid, p_items jsonb, p_notes text DEFAULT NULL, p_covers integer DEFAULT 1
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_client_id uuid;
  v_pos_enabled boolean;
  v_request_id uuid;
  v_snapshot jsonb := '[]'::jsonb;
  r RECORD;
  item RECORD;
  v_qty numeric;
  v_note text;
BEGIN
  SELECT t.client_id INTO v_client_id FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN RAISE EXCEPTION 'Table not found'; END IF;

  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RAISE EXCEPTION 'POS not enabled for this restaurant'; END IF;

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
  v_outlet_name text;
  v_pos_enabled boolean;
  v_nutrition_enabled boolean;
  v_guest_ordering_enabled boolean;
  v_vat_registered boolean;
  r RECORD;
  roll jsonb;
BEGIN
  SELECT t.client_id, t.name INTO v_client_id, v_table_name FROM pos_tables t WHERE t.id = p_table_id;
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

  v_guest_ordering_enabled := true;

  FOR r IN
    SELECT rc.id, rc.name, rc.category, rc.selling_price, rc.vat_rate, rc.description, rc.image_url, rc.is_veg
    FROM recipes rc
    WHERE rc.client_id = v_client_id AND rc.is_active = true AND rc.pos_enabled = true
      AND rc.category IS DISTINCT FROM 'Sub-Recipe'
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

-- ── Assertions ──────────────────────────────────────────────────────────────────────────────
DO $guard$
BEGIN
  -- 1. The flag genuinely no longer gates either function. Read back what is installed rather
  --    than trusting the file above.
  IF pg_get_functiondef('public.submit_guest_order(uuid, jsonb, text, integer)'::regprocedure) LIKE '%guest_ordering%' THEN
    RAISE EXCEPTION 'submit_guest_order still consults feature_flags.guest_ordering';
  END IF;
  IF pg_get_functiondef('public.get_guest_menu(uuid)'::regprocedure) LIKE '%guest_ordering_flag%' THEN
    RAISE EXCEPTION 'get_guest_menu still consults feature_flags.guest_ordering';
  END IF;

  -- 2. pos_enabled is now the ONLY gate, so it had better still be there. Removing the flag
  --    check while also losing this would open guest ordering to every client in the system,
  --    including those who have never bought POS -- the one way this migration could do harm.
  IF pg_get_functiondef('public.submit_guest_order(uuid, jsonb, text, integer)'::regprocedure) NOT LIKE '%pos_enabled%' THEN
    RAISE EXCEPTION 'submit_guest_order no longer checks pos_enabled -- guest ordering would be open to everyone';
  END IF;
  IF pg_get_functiondef('public.get_guest_menu(uuid)'::regprocedure) NOT LIKE '%pos_enabled%' THEN
    RAISE EXCEPTION 'get_guest_menu no longer checks pos_enabled -- every client would expose a guest menu';
  END IF;

  -- 3. The guest surface is anonymous by design; CREATE OR REPLACE preserves grants and DROP
  --    would not. Assert rather than assume.
  IF NOT has_function_privilege('anon', 'public.get_guest_menu(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon lost EXECUTE on get_guest_menu';
  END IF;
  IF NOT has_function_privilege('anon', 'public.submit_guest_order(uuid, jsonb, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon lost EXECUTE on submit_guest_order';
  END IF;
END
$guard$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ── After running ───────────────────────────────────────────────────────────────────────────
-- Guest ordering is now exactly "does this client have Crest POS". The admin screen, hasFeature()
-- and the two SQL functions finally say the same thing.
--
-- Smoke-test: the guest QR menu on a POS-enabled outlet should still take an order (proves the
-- pos_enabled path is intact), and a client with pos_enabled = false should still return no guest
-- menu at all (proves assertion 2 is not vacuous in practice).
