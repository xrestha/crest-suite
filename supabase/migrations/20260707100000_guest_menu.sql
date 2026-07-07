-- Guest-facing QR digital menu (view-only, per-table). A guest scans a table's QR, which links
-- to a fully public route (no login) showing that client's live POS menu — see get_guest_menu
-- below and src/modules/pos/guestmenu/GuestMenu.jsx.

-- New recipe fields the guest menu needs that don't exist yet — everything else it shows
-- (name, category, selling_price, vat_rate) already exists.
ALTER TABLE public.recipes
  ADD COLUMN description text,
  ADD COLUMN image_url text,
  ADD COLUMN is_veg boolean;

-- ── Nutrition rollup, ported to SQL ──────────────────────────────────────────────────────────
-- Nutrition is computed from recipe_ingredients × items.nutrition (qty/cost/ingredient
-- structure — a client's confidential recipe formulation). The existing rollup
-- (src/utils/nutrition.js, calcRecipeNutrition/calcSubRecipeNutritionPerUnit/itemNutrition) runs
-- client-side against a staff-authenticated read of that raw ingredient data. get_guest_menu
-- below is called by a fully anonymous, unauthenticated visitor — shipping the raw ingredient
-- list to the browser just to crunch the same numbers there would let anyone open devtools and
-- read a client's recipe formulation off the network response. So this rollup runs entirely in
-- SQL instead, inside a SECURITY DEFINER function, and only the final per-recipe totals ever
-- leave the database. This is a deliberate duplication of nutrition.js's math — mirrors it
-- field-for-field (see comments below) and needs to be kept in sync if that file's logic changes.

-- Mirrors convertQty() — mass (KG/GM) and volume (LTR/ML) convert between each other; anything
-- else (counts, mismatched dimensions) passes through unchanged.
CREATE FUNCTION public._nutrition_convert_qty(p_qty numeric, p_from_unit text, p_to_unit text) RETURNS numeric
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  mass CONSTANT text[] := ARRAY['KG','GM'];
  vol  CONSTANT text[] := ARRAY['LTR','ML'];
  from_u text := upper(coalesce(p_from_unit, ''));
  to_u   text := upper(coalesce(p_to_unit, ''));
  from_f numeric; to_f numeric;
BEGIN
  IF from_u = ANY(mass) AND to_u = ANY(mass) THEN
    from_f := CASE from_u WHEN 'KG' THEN 1000 ELSE 1 END;
    to_f   := CASE to_u   WHEN 'KG' THEN 1000 ELSE 1 END;
    RETURN p_qty * from_f / to_f;
  ELSIF from_u = ANY(vol) AND to_u = ANY(vol) THEN
    from_f := CASE from_u WHEN 'LTR' THEN 1000 ELSE 1 END;
    to_f   := CASE to_u   WHEN 'LTR' THEN 1000 ELSE 1 END;
    RETURN p_qty * from_f / to_f;
  ELSE
    RETURN p_qty;
  END IF;
END;
$$;

-- Mirrors itemNutrition() — nutrition contribution of `p_qty` units (in the item's own uom) of
-- one ingredient item. Returns jsonb: { has, energy_kcal, protein_g, carbs_g, fat_g, sugar_g,
-- sodium_mg, allergens: [...] }.
CREATE FUNCTION public._nutrition_item_contribution(p_item_id uuid, p_qty numeric) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  n jsonb;
  item_uom text;
  basis_qty numeric;
  basis_unit text;
  qty_in_basis numeric;
  factor numeric;
  has_data boolean;
  allergens_raw text;
  allergens jsonb;
BEGIN
  SELECT nutrition, uom INTO n, item_uom FROM items WHERE id = p_item_id;

  allergens_raw := n->>'allergens';
  IF allergens_raw IS NULL OR btrim(allergens_raw) = '' THEN
    allergens := '[]'::jsonb;
  ELSE
    SELECT COALESCE(jsonb_agg(btrim(x)), '[]'::jsonb) INTO allergens
    FROM unnest(regexp_split_to_array(allergens_raw, '[,;/]')) x WHERE btrim(x) <> '';
  END IF;

  has_data := n IS NOT NULL AND (
    COALESCE((n->>'energy_kcal')::numeric, 0) > 0 OR COALESCE((n->>'protein_g')::numeric, 0) > 0 OR
    COALESCE((n->>'carbs_g')::numeric, 0) > 0 OR COALESCE((n->>'fat_g')::numeric, 0) > 0 OR
    COALESCE((n->>'sugar_g')::numeric, 0) > 0 OR COALESCE((n->>'sodium_mg')::numeric, 0) > 0
  );

  IF NOT has_data OR p_qty IS NULL OR p_qty <= 0 THEN
    RETURN jsonb_build_object('has', has_data, 'energy_kcal', 0, 'protein_g', 0, 'carbs_g', 0,
      'fat_g', 0, 'sugar_g', 0, 'sodium_mg', 0, 'allergens', allergens);
  END IF;

  basis_qty := NULLIF((n->>'basis_qty')::numeric, 0);
  IF basis_qty IS NULL THEN basis_qty := 100; END IF;
  basis_unit := COALESCE(n->>'basis_unit', item_uom);
  qty_in_basis := public._nutrition_convert_qty(p_qty, item_uom, basis_unit);
  factor := qty_in_basis / basis_qty;

  RETURN jsonb_build_object(
    'has', true,
    'energy_kcal', COALESCE((n->>'energy_kcal')::numeric, 0) * factor,
    'protein_g',   COALESCE((n->>'protein_g')::numeric, 0) * factor,
    'carbs_g',     COALESCE((n->>'carbs_g')::numeric, 0) * factor,
    'fat_g',       COALESCE((n->>'fat_g')::numeric, 0) * factor,
    'sugar_g',     COALESCE((n->>'sugar_g')::numeric, 0) * factor,
    'sodium_mg',   COALESCE((n->>'sodium_mg')::numeric, 0) * factor,
    'allergens', allergens
  );
END;
$$;

-- Mirrors calcSubRecipeNutritionPerUnit/calcRecipeNutrition combined: recurses through
-- recipe_ingredients (direct items + nested sub-recipes), summing nutrition per ONE PORTION of
-- p_recipe_id. Returns the UNDIVIDED sum plus recipe_id's own yield_qty — the caller divides by
-- yield_qty only when treating this recipe as a sub-recipe ingredient of another (matching
-- calcSubRecipeNutritionPerUnit's "÷ yield_qty" step); a top-level call (get_guest_menu below)
-- uses the sum as-is, matching calcRecipeNutrition never dividing by the top recipe's own yield.
-- p_seen guards against a cyclical sub-recipe reference (A uses B uses A) the same way the JS
-- version's `seen` Set does — returns zero instead of recursing forever.
CREATE FUNCTION public._nutrition_rollup(p_recipe_id uuid, p_seen uuid[] DEFAULT ARRAY[]::uuid[]) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  ri RECORD;
  contrib jsonb;
  total jsonb := jsonb_build_object('energy_kcal',0,'protein_g',0,'carbs_g',0,'fat_g',0,'sugar_g',0,'sodium_mg',0);
  allergens jsonb := '[]'::jsonb;
  covered boolean := false;
  yield_qty numeric;
  sub_result jsonb;
  sub_yield numeric;
  q numeric;
BEGIN
  IF p_recipe_id = ANY(p_seen) THEN
    RETURN jsonb_build_object('energy_kcal',0,'protein_g',0,'carbs_g',0,'fat_g',0,'sugar_g',0,
      'sodium_mg',0,'allergens','[]'::jsonb,'covered',false,'yield_qty',1);
  END IF;

  -- Aliased and column-qualified deliberately — `yield_qty` here is both a column on recipes
  -- and this function's own local variable; an unqualified reference is ambiguous and Postgres
  -- errors on it at call time (not at CREATE FUNCTION time), which a couple of manual reads
  -- of this migration missed the first few passes.
  SELECT COALESCE(rc.yield_qty, 1) INTO yield_qty FROM recipes rc WHERE rc.id = p_recipe_id;

  FOR ri IN SELECT item_id, sub_recipe_id, qty_per_portion FROM recipe_ingredients WHERE recipe_id = p_recipe_id
  LOOP
    IF ri.item_id IS NOT NULL THEN
      contrib := public._nutrition_item_contribution(ri.item_id, ri.qty_per_portion);
      IF (contrib->>'has')::boolean THEN covered := true; END IF;
      total := jsonb_build_object(
        'energy_kcal', (total->>'energy_kcal')::numeric + (contrib->>'energy_kcal')::numeric,
        'protein_g',   (total->>'protein_g')::numeric   + (contrib->>'protein_g')::numeric,
        'carbs_g',     (total->>'carbs_g')::numeric     + (contrib->>'carbs_g')::numeric,
        'fat_g',       (total->>'fat_g')::numeric       + (contrib->>'fat_g')::numeric,
        'sugar_g',     (total->>'sugar_g')::numeric     + (contrib->>'sugar_g')::numeric,
        'sodium_mg',   (total->>'sodium_mg')::numeric   + (contrib->>'sodium_mg')::numeric
      );
      SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb) INTO allergens FROM (
        SELECT jsonb_array_elements_text(allergens) AS v
        UNION
        SELECT jsonb_array_elements_text(contrib->'allergens')
      ) s;
    ELSIF ri.sub_recipe_id IS NOT NULL THEN
      sub_result := public._nutrition_rollup(ri.sub_recipe_id, p_seen || p_recipe_id);
      sub_yield := NULLIF((sub_result->>'yield_qty')::numeric, 0);
      IF sub_yield IS NULL THEN sub_yield := 1; END IF;
      IF (sub_result->>'covered')::boolean THEN covered := true; END IF;
      q := COALESCE(ri.qty_per_portion, 0);
      total := jsonb_build_object(
        'energy_kcal', (total->>'energy_kcal')::numeric + (sub_result->>'energy_kcal')::numeric / sub_yield * q,
        'protein_g',   (total->>'protein_g')::numeric   + (sub_result->>'protein_g')::numeric   / sub_yield * q,
        'carbs_g',     (total->>'carbs_g')::numeric     + (sub_result->>'carbs_g')::numeric     / sub_yield * q,
        'fat_g',       (total->>'fat_g')::numeric       + (sub_result->>'fat_g')::numeric       / sub_yield * q,
        'sugar_g',     (total->>'sugar_g')::numeric     + (sub_result->>'sugar_g')::numeric     / sub_yield * q,
        'sodium_mg',   (total->>'sodium_mg')::numeric   + (sub_result->>'sodium_mg')::numeric   / sub_yield * q
      );
      SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb) INTO allergens FROM (
        SELECT jsonb_array_elements_text(allergens) AS v
        UNION
        SELECT jsonb_array_elements_text(sub_result->'allergens')
      ) s;
    END IF;
  END LOOP;

  RETURN total || jsonb_build_object('allergens', allergens, 'covered', covered, 'yield_qty', yield_qty);
END;
$$;

-- ── Public entry point ───────────────────────────────────────────────────────────────────────
-- Called by a fully anonymous visitor (no Supabase session at all) — same "no internal auth
-- check, only ever returns safe/whitelisted columns" pattern as get_pos_staff (used by the
-- existing public /pos/login page). Never returns anything from pos_orders/pos_order_items/
-- sales data, and never returns raw recipe_ingredients/items rows — only the final aggregated
-- nutrition numbers computed above.
CREATE FUNCTION public.get_guest_menu(p_table_id uuid) RETURNS TABLE(
    outlet_name text, table_name text,
    recipe_id uuid, name text, category text, selling_price numeric, vat_rate numeric,
    description text, image_url text, is_veg boolean,
    nutrition_enabled boolean, has_nutrition boolean,
    energy_kcal numeric, protein_g numeric, carbs_g numeric, fat_g numeric, sugar_g numeric, sodium_mg numeric,
    allergens jsonb
) LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_client_id uuid;
  v_table_name text;
  v_outlet_name text;
  v_pos_enabled boolean;
  v_nutrition_enabled boolean;
  r RECORD;
  roll jsonb;
BEGIN
  SELECT t.client_id, t.name INTO v_client_id, v_table_name FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN RETURN; END IF;

  SELECT c.name, c.pos_enabled INTO v_outlet_name, v_pos_enabled FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RETURN; END IF;

  SELECT COALESCE(f.nutrition_facts, false) INTO v_nutrition_enabled FROM feature_flags f WHERE f.client_id = v_client_id;

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
    RETURN NEXT;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
