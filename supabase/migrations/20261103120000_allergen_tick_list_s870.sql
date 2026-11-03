-- S870: allergens become a fixed list, an ingredient says whether anyone checked its allergens,
-- and the guest menu of a client with Nutrition says when a dish's allergen information is incomplete.
--
-- Until now an allergen was free text: the library wrote "dairy", Open Food Facts "milk", staff
-- typed "Dairy". The guest menu filter compares strings exactly, so a guest hiding "milk" still saw
-- a dish its ingredient called "dairy". And an ingredient nobody had looked at reached guests as
-- allergen-free. This file:
--
--   1. allergen_keys(text): free text to the 14 keys (UK/EU list) plus the words that match none.
--      The same mapping lives in src/shared/constants/allergens.js; allergens.test.js reads the
--      VALUES list below and fails when the two drift.
--   2. Triggers that normalise every write of items.nutrition and pos_options.allergens. Normalising
--      here, not in the app, because an old cached bundle (the service worker is cache-first), a
--      branch push (push_master_data) and a restore all keep writing free text after the release.
--      items.nutrition.allergens stays a comma STRING of keys, then unmatched words: a bundle from
--      before S870 calls .trim() on it, and an array would break its saves.
--   3. items.nutrition.allergens_checked. An ingredient is checked once someone saves its form (the
--      app writes true). A word that matches no key forces false. A write without the key (an old
--      bundle, an old bulk fill) keeps the allergens the item already had beside the new ones, and
--      its checked state: over-declaring is the safe side.
--   4. A backfill: every ingredient already filled in counts as checked (owner decision S870),
--      except a live USDA FoodData Central lookup with no allergens, which never carried any.
--   5. _nutrition_rollup returns allergens_complete: true only when the dish reaches at least one
--      ingredient, every ingredient is checked, and no sub-recipe is missing or loops. It mirrors
--      calcRecipeNutrition's allergenCheck in src/utils/nutrition.js.
--   6. get_guest_menu returns allergens_complete, set only where the client has Nutrition
--      (NULL otherwise, so a Starter guest menu is unchanged), and get_guest_menu_options gives a
--      combo's dishes their allergens and the same flag.
--
-- Run order: this file before the frontend. A frontend running against a database without it
-- reads allergens_complete as undefined, which it treats as "not judged".
--
-- Reversal: restore get_guest_menu from 20261015160000_recipes_is_egg_s846.sql's result (DROP +
-- CREATE + grants, i.e. remove the allergens_complete column and line), get_guest_menu_options by
-- removing the "|| public._guest_dish_allergens(rc.id, v_client_id)" call, _nutrition_rollup and
-- _nutrition_item_contribution from 20260707100000_guest_menu.sql (with SET search_path = public),
-- then DROP the two triggers, their functions, _guest_dish_allergens, _allergen_raw_text and
-- allergen_keys. The normalised allergen text and the allergens_checked key can stay: the old code
-- splits the same string and ignores the key.


-- ── 1. The vocabulary ──────────────────────────────────────────────────────────────────────────
-- A jsonb allergens value (a string, or an array of strings) as one comma-separated text.
CREATE OR REPLACE FUNCTION public._allergen_raw_text(p_value jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path = public
    AS $$
  SELECT CASE jsonb_typeof(p_value)
    WHEN 'string' THEN p_value #>> '{}'
    WHEN 'array'  THEN (SELECT string_agg(e, ',') FROM jsonb_array_elements_text(p_value) AS e)
  END
$$;

-- Free text to { keys: [in list order], other: [unmatched words, first-seen order] }.
-- A word is cleaned as cleanWord() in allergens.js: lowercase and trimmed, an Open Food Facts
-- "en:" prefix dropped, dashes and underscores as spaces, single spaces.
CREATE OR REPLACE FUNCTION public.allergen_keys(p_raw text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path = public
    AS $$
  WITH words AS (
    SELECT w, min(ord) AS ord
      FROM (SELECT btrim(regexp_replace(regexp_replace(regexp_replace(btrim(lower(x)), '^[a-z]{2}:', ''), '[-_]', ' ', 'g'), '\s+', ' ', 'g')) AS w, ord
              FROM regexp_split_to_table(COALESCE(p_raw, ''), '[,;/]') WITH ORDINALITY AS t(x, ord)) s
     WHERE w <> ''
     GROUP BY w
  ),
  syn(word, key) AS (VALUES
    -- ALLERGEN SYNONYMS BEGIN
      ('gluten', 'gluten'),
      ('wheat', 'gluten'),
      ('maida', 'gluten'),
      ('atta', 'gluten'),
      ('barley', 'gluten'),
      ('rye', 'gluten'),
      ('oat', 'gluten'),
      ('oats', 'gluten'),
      ('spelt', 'gluten'),
      ('cereals containing gluten', 'gluten'),
      ('milk', 'milk'),
      ('dairy', 'milk'),
      ('lactose', 'milk'),
      ('ghee', 'milk'),
      ('paneer', 'milk'),
      ('butter', 'milk'),
      ('cheese', 'milk'),
      ('cream', 'milk'),
      ('curd', 'milk'),
      ('yogurt', 'milk'),
      ('yoghurt', 'milk'),
      ('whey', 'milk'),
      ('casein', 'milk'),
      ('khuwa', 'milk'),
      ('eggs', 'eggs'),
      ('egg', 'eggs'),
      ('peanuts', 'peanuts'),
      ('peanut', 'peanuts'),
      ('groundnut', 'peanuts'),
      ('groundnuts', 'peanuts'),
      ('tree nuts', 'tree nuts'),
      ('tree nut', 'tree nuts'),
      ('nut', 'tree nuts'),
      ('nuts', 'tree nuts'),
      ('almond', 'tree nuts'),
      ('almonds', 'tree nuts'),
      ('cashew', 'tree nuts'),
      ('cashews', 'tree nuts'),
      ('walnut', 'tree nuts'),
      ('walnuts', 'tree nuts'),
      ('pistachio', 'tree nuts'),
      ('pistachios', 'tree nuts'),
      ('hazelnut', 'tree nuts'),
      ('hazelnuts', 'tree nuts'),
      ('pecan', 'tree nuts'),
      ('pecans', 'tree nuts'),
      ('macadamia', 'tree nuts'),
      ('soy', 'soy'),
      ('soya', 'soy'),
      ('soybean', 'soy'),
      ('soybeans', 'soy'),
      ('soy bean', 'soy'),
      ('soy beans', 'soy'),
      ('soya bean', 'soy'),
      ('soya beans', 'soy'),
      ('sesame', 'sesame'),
      ('sesame seed', 'sesame'),
      ('sesame seeds', 'sesame'),
      ('til', 'sesame'),
      ('fish', 'fish'),
      ('crustaceans', 'crustaceans'),
      ('crustacean', 'crustaceans'),
      ('shellfish', 'crustaceans'),
      ('prawn', 'crustaceans'),
      ('prawns', 'crustaceans'),
      ('shrimp', 'crustaceans'),
      ('shrimps', 'crustaceans'),
      ('crab', 'crustaceans'),
      ('lobster', 'crustaceans'),
      ('molluscs', 'molluscs'),
      ('mollusc', 'molluscs'),
      ('mollusk', 'molluscs'),
      ('mollusks', 'molluscs'),
      ('shellfish', 'molluscs'),
      ('squid', 'molluscs'),
      ('mussel', 'molluscs'),
      ('mussels', 'molluscs'),
      ('clam', 'molluscs'),
      ('clams', 'molluscs'),
      ('oyster', 'molluscs'),
      ('oysters', 'molluscs'),
      ('octopus', 'molluscs'),
      ('mustard', 'mustard'),
      ('mustard seed', 'mustard'),
      ('mustard seeds', 'mustard'),
      ('mustard oil', 'mustard'),
      ('celery', 'celery'),
      ('celeriac', 'celery'),
      ('sulphites', 'sulphites'),
      ('sulphite', 'sulphites'),
      ('sulfite', 'sulphites'),
      ('sulfites', 'sulphites'),
      ('sulphur dioxide', 'sulphites'),
      ('sulfur dioxide', 'sulphites'),
      ('sulphur dioxide and sulphites', 'sulphites'),
      ('lupin', 'lupin'),
      ('lupine', 'lupin'),
      ('lupins', 'lupin')
    -- ALLERGEN SYNONYMS END
  ),
  list(key, pos) AS (VALUES
    ('gluten', 1), ('milk', 2), ('eggs', 3), ('peanuts', 4), ('tree nuts', 5), ('soy', 6), ('sesame', 7),
    ('fish', 8), ('crustaceans', 9), ('molluscs', 10), ('mustard', 11), ('celery', 12), ('sulphites', 13), ('lupin', 14)
  )
  SELECT jsonb_build_object(
    'keys',  COALESCE((SELECT jsonb_agg(l.key ORDER BY l.pos) FROM list l
                        WHERE EXISTS (SELECT 1 FROM words w JOIN syn s ON s.word = w.w WHERE s.key = l.key)), '[]'::jsonb),
    'other', COALESCE((SELECT jsonb_agg(w.w ORDER BY w.ord) FROM words w
                        WHERE NOT EXISTS (SELECT 1 FROM syn s WHERE s.word = w.w)), '[]'::jsonb))
$$;

-- Both run inside the triggers below as the writing user, so authenticated and service_role need
-- EXECUTE; anon never writes an item or a choice.
REVOKE ALL ON FUNCTION public._allergen_raw_text(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.allergen_keys(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._allergen_raw_text(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.allergen_keys(text) TO authenticated, service_role;


-- ── 2 and 3. Normalise every write ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.items_nutrition_normalise() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public
    AS $$
DECLARE
  v_new     jsonb := NEW.nutrition;
  v_raw     text;
  v_checked boolean;
  v_parsed  jsonb;
BEGIN
  IF v_new IS NULL OR jsonb_typeof(v_new) <> 'object' THEN
    RETURN NEW;
  END IF;

  v_raw := public._allergen_raw_text(v_new->'allergens');
  IF v_new ? 'allergens_checked' THEN
    v_checked := CASE WHEN jsonb_typeof(v_new->'allergens_checked') = 'boolean'
                      THEN (v_new->>'allergens_checked')::boolean ELSE false END;
  ELSIF TG_OP = 'UPDATE' AND OLD.nutrition IS NOT NULL AND jsonb_typeof(OLD.nutrition) = 'object' THEN
    -- Written without the key: a bundle or a bulk fill from before S870. Nobody reviewed the
    -- allergens in it, so the item keeps what it already declared and whether it was checked.
    v_raw := concat_ws(',', NULLIF(v_raw, ''), NULLIF(public._allergen_raw_text(OLD.nutrition->'allergens'), ''));
    v_checked := CASE WHEN jsonb_typeof(OLD.nutrition->'allergens_checked') = 'boolean'
                      THEN (OLD.nutrition->>'allergens_checked')::boolean ELSE false END;
  ELSE
    v_checked := false;
  END IF;

  v_parsed := public.allergen_keys(v_raw);
  IF jsonb_array_length(v_parsed->'other') > 0 THEN
    v_checked := false;
  END IF;

  v_new := v_new - 'allergens' - 'allergens_checked';
  IF jsonb_array_length(v_parsed->'keys') + jsonb_array_length(v_parsed->'other') > 0 THEN
    v_new := v_new || jsonb_build_object('allergens',
      (SELECT string_agg(x, ', ' ORDER BY n) FROM jsonb_array_elements_text((v_parsed->'keys') || (v_parsed->'other')) WITH ORDINALITY AS t(x, n)));
  END IF;
  NEW.nutrition := v_new || jsonb_build_object('allergens_checked', v_checked);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.items_nutrition_normalise() FROM PUBLIC;

-- BEFORE triggers fire in name order: ims_rank_guard (the rank check) runs first.
DROP TRIGGER IF EXISTS items_nutrition_normalise ON public.items;
CREATE TRIGGER items_nutrition_normalise BEFORE INSERT OR UPDATE OF nutrition ON public.items
  FOR EACH ROW EXECUTE FUNCTION public.items_nutrition_normalise();

CREATE OR REPLACE FUNCTION public.pos_options_normalise_allergens() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public
    AS $$
DECLARE
  v_parsed jsonb;
BEGIN
  IF NEW.allergens IS NULL THEN
    RETURN NEW;
  END IF;
  v_parsed := public.allergen_keys(public._allergen_raw_text(NEW.allergens));
  NEW.allergens := (v_parsed->'keys') || (v_parsed->'other');
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.pos_options_normalise_allergens() FROM PUBLIC;

-- Named to sort after pos_options_guard, so the edit-rank check runs first.
DROP TRIGGER IF EXISTS pos_options_normalise_allergens ON public.pos_options;
CREATE TRIGGER pos_options_normalise_allergens BEFORE INSERT OR UPDATE OF allergens ON public.pos_options
  FOR EACH ROW EXECUTE FUNCTION public.pos_options_normalise_allergens();


-- ── 4. Backfill ────────────────────────────────────────────────────────────────────────────────
-- The trigger above rewrites the allergen text as it goes, and a word matching no key (one "kiwi"
-- at the time of writing) leaves its item not checked. One audit_logs row per item: the record of
-- the conversion.
UPDATE public.items
   SET nutrition = nutrition || jsonb_build_object('allergens_checked',
         NOT (COALESCE(nutrition->>'source', '') = 'USDA FDC' AND COALESCE(btrim(nutrition->>'allergens'), '') = ''))
 WHERE nutrition IS NOT NULL AND jsonb_typeof(nutrition) = 'object' AND NOT (nutrition ? 'allergens_checked');

UPDATE public.pos_options
   SET allergens = allergens
 WHERE allergens IS NOT NULL AND allergens <> '[]'::jsonb;


-- ── 5. The roll-up says whether the allergens are complete ─────────────────────────────────────
-- Mirrors itemNutrition(): also returns `checked`. Same signature and grants (CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION public._nutrition_item_contribution(p_item_id uuid, p_qty numeric) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path = public
    AS $$
DECLARE
  n jsonb;
  item_uom text;
  basis_qty numeric;
  basis_unit text;
  qty_in_basis numeric;
  factor numeric;
  has_data boolean;
  checked boolean;
  allergens_raw text;
  allergens jsonb;
BEGIN
  SELECT nutrition, uom INTO n, item_uom FROM items WHERE id = p_item_id;

  checked := CASE WHEN jsonb_typeof(n->'allergens_checked') = 'boolean' THEN (n->>'allergens_checked')::boolean ELSE false END;

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
      'fat_g', 0, 'sugar_g', 0, 'sodium_mg', 0, 'allergens', allergens, 'checked', checked);
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
    'allergens', allergens,
    'checked', checked
  );
END;
$$;

-- Mirrors calcRecipeNutrition's allergenCheck on top of the existing sums: all_checked (every
-- ingredient reached is checked), item_count (ingredient lines reached, nested ones included),
-- broken (a sub-recipe loops back or does not exist), and allergens_complete, which is
-- all_checked AND item_count > 0 AND NOT broken. Same signature and grants (CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION public._nutrition_rollup(p_recipe_id uuid, p_seen uuid[] DEFAULT ARRAY[]::uuid[]) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path = public
    AS $$
DECLARE
  ri RECORD;
  contrib jsonb;
  total jsonb := jsonb_build_object('energy_kcal',0,'protein_g',0,'carbs_g',0,'fat_g',0,'sugar_g',0,'sodium_mg',0);
  allergens jsonb := '[]'::jsonb;
  covered boolean := false;
  all_checked boolean := true;
  item_count int := 0;
  broken boolean := false;
  found_recipe boolean;
  yield_qty numeric;
  sub_result jsonb;
  sub_yield numeric;
  q numeric;
BEGIN
  IF p_recipe_id = ANY(p_seen) THEN
    RETURN jsonb_build_object('energy_kcal',0,'protein_g',0,'carbs_g',0,'fat_g',0,'sugar_g',0,
      'sodium_mg',0,'allergens','[]'::jsonb,'covered',false,'yield_qty',1,
      'all_checked',false,'item_count',0,'broken',true,'allergens_complete',false);
  END IF;

  -- Aliased and column-qualified deliberately — `yield_qty` here is both a column on recipes
  -- and this function's own local variable; an unqualified reference is ambiguous and Postgres
  -- errors on it at call time (not at CREATE FUNCTION time).
  SELECT COALESCE(rc.yield_qty, 1) INTO yield_qty FROM recipes rc WHERE rc.id = p_recipe_id;
  found_recipe := FOUND;
  IF NOT found_recipe THEN
    RETURN jsonb_build_object('energy_kcal',0,'protein_g',0,'carbs_g',0,'fat_g',0,'sugar_g',0,
      'sodium_mg',0,'allergens','[]'::jsonb,'covered',false,'yield_qty',1,
      'all_checked',false,'item_count',0,'broken',true,'allergens_complete',false);
  END IF;

  FOR ri IN SELECT item_id, sub_recipe_id, qty_per_portion FROM recipe_ingredients WHERE recipe_id = p_recipe_id
  LOOP
    IF ri.item_id IS NOT NULL THEN
      contrib := public._nutrition_item_contribution(ri.item_id, ri.qty_per_portion);
      IF (contrib->>'has')::boolean THEN covered := true; END IF;
      item_count := item_count + 1;
      all_checked := all_checked AND COALESCE((contrib->>'checked')::boolean, false);
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
      item_count := item_count + COALESCE((sub_result->>'item_count')::int, 0);
      all_checked := all_checked AND COALESCE((sub_result->>'all_checked')::boolean, false);
      broken := broken OR COALESCE((sub_result->>'broken')::boolean, false);
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

  RETURN total || jsonb_build_object('allergens', allergens, 'covered', covered, 'yield_qty', yield_qty,
    'all_checked', all_checked, 'item_count', item_count, 'broken', broken,
    'allergens_complete', all_checked AND item_count > 0 AND NOT broken);
END;
$$;


-- ── 6. The guest menu says when a dish's allergen information is incomplete ─────────────────────
-- A combo dish's allergens and completeness, for get_guest_menu_options. Called only from inside
-- that SECURITY DEFINER function, which runs it as the function owner, so no role is granted it.
CREATE OR REPLACE FUNCTION public._guest_dish_allergens(p_recipe_id uuid, p_client_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path = public
    AS $$
  SELECT jsonb_build_object(
    'allergens', COALESCE(r.roll->'allergens', '[]'::jsonb),
    'allergens_complete', CASE WHEN COALESCE((SELECT f.nutrition_facts FROM feature_flags f WHERE f.client_id = p_client_id), false)
                               THEN COALESCE((r.roll->>'allergens_complete')::boolean, false) END)
  FROM (SELECT public._nutrition_rollup(p_recipe_id) AS roll) r
$$;
REVOKE ALL ON FUNCTION public._guest_dish_allergens(uuid, uuid) FROM PUBLIC;

-- get_guest_menu: a new RETURNS TABLE column, so DROP + CREATE from the LIVE body (S846's
-- pattern), each edit asserted to land exactly once, in one DO block so a failure leaves the old
-- function in place.
DO $mig$
DECLARE
  v_def      text := pg_get_functiondef('public.get_guest_menu(uuid)'::regprocedure);
  v_comment  text := obj_description('public.get_guest_menu(uuid)'::regprocedure, 'pg_proc');
  v_new      text;
  v_anon     boolean := has_function_privilege('anon', 'public.get_guest_menu(uuid)', 'EXECUTE');
  v_auth     boolean := has_function_privilege('authenticated', 'public.get_guest_menu(uuid)', 'EXECUTE');
  v_service  boolean := has_function_privilege('service_role', 'public.get_guest_menu(uuid)', 'EXECUTE');
  v_from     text[] := ARRAY[
    'allergens jsonb, guest_ordering_enabled boolean',
    'allergens := COALESCE(roll->''allergens'', ''[]''::jsonb);'
  ];
  v_to       text[] := ARRAY[
    'allergens jsonb, allergens_complete boolean, guest_ordering_enabled boolean',
    'allergens := COALESCE(roll->''allergens'', ''[]''::jsonb);' || chr(10)
      || '    -- S870: only where Nutrition is on; NULL elsewhere, so that guest menu is unchanged.' || chr(10)
      || '    allergens_complete := CASE WHEN v_nutrition_enabled THEN COALESCE((roll->>''allergens_complete'')::boolean, false) END;'
  ];
  i          int;
  v_hits     int;
BEGIN
  IF position('allergens_complete' IN v_def) > 0 THEN
    RAISE NOTICE 'get_guest_menu already returns allergens_complete; left as it is';
    RETURN;
  END IF;
  IF NOT (v_anon AND v_auth AND v_service) THEN
    RAISE EXCEPTION 'get_guest_menu grants are not the expected anon+authenticated+service_role (anon %, authenticated %, service_role %)',
      v_anon, v_auth, v_service;
  END IF;

  v_new := v_def;
  FOR i IN 1 .. array_length(v_from, 1) LOOP
    v_hits := (length(v_new) - length(replace(v_new, v_from[i], ''))) / length(v_from[i]);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'get_guest_menu live body: expected exactly one "%", found %', v_from[i], v_hits;
    END IF;
    v_new := replace(v_new, v_from[i], v_to[i]);
  END LOOP;

  DROP FUNCTION public.get_guest_menu(uuid);
  EXECUTE v_new;
  REVOKE ALL ON FUNCTION public.get_guest_menu(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.get_guest_menu(uuid) TO anon, authenticated, service_role;
  IF v_comment IS NOT NULL THEN
    EXECUTE format('COMMENT ON FUNCTION public.get_guest_menu(uuid) IS %L', v_comment);
  END IF;
END
$mig$;

-- get_guest_menu_options: RETURNS jsonb, so CREATE OR REPLACE keeps its grants. A combo's dishes
-- carry their allergens and allergens_complete, merged onto each dish object.
DO $mig$
DECLARE
  v_def   text := pg_get_functiondef('public.get_guest_menu_options(uuid)'::regprocedure);
  v_from  text := '''extra_price'', it.extra_price, ''is_default'', it.is_default, ''sort'', it.sort)';
  v_to    text := '''extra_price'', it.extra_price, ''is_default'', it.is_default, ''sort'', it.sort)'
                  || ' || public._guest_dish_allergens(rc.id, v_client_id)';
  v_hits  int;
BEGIN
  IF position('_guest_dish_allergens' IN v_def) > 0 THEN
    RAISE NOTICE 'get_guest_menu_options already returns combo dish allergens; left as it is';
    RETURN;
  END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'get_guest_menu_options live body: expected exactly one "%", found %', v_from, v_hits;
  END IF;
  EXECUTE replace(v_def, v_from, v_to);
END
$mig$;


-- ── 7. Proof, inside the migration ─────────────────────────────────────────────────────────────
DO $mig$
DECLARE
  v_item   uuid;
  v_recipe uuid;
  v_table  uuid;
  v_rows   bigint;
  v_judged bigint;
  v_msg    text;
  v_n      jsonb;
BEGIN
  -- The vocabulary, on the cases allergens.test.js also pins.
  IF public.allergen_keys('Dairy; wheat, kodo') <> '{"keys":["gluten","milk"],"other":["kodo"]}'::jsonb THEN
    RAISE EXCEPTION 'allergen_keys free text: %', public.allergen_keys('Dairy; wheat, kodo');
  END IF;
  IF public.allergen_keys('en:milk, en:sulphur-dioxide-and-sulphites, shellfish')
     <> '{"keys":["milk","crustaceans","molluscs","sulphites"],"other":[]}'::jsonb THEN
    RAISE EXCEPTION 'allergen_keys tags: %', public.allergen_keys('en:milk, en:sulphur-dioxide-and-sulphites, shellfish');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.items'::regclass AND tgname = 'items_nutrition_normalise' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'items_nutrition_normalise trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.pos_options'::regclass AND tgname = 'pos_options_normalise_allergens' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'pos_options_normalise_allergens trigger is missing';
  END IF;

  -- Nothing left unconverted: every stored record carries the key.
  IF EXISTS (SELECT 1 FROM public.items WHERE nutrition IS NOT NULL AND jsonb_typeof(nutrition) = 'object' AND NOT (nutrition ? 'allergens_checked')) THEN
    RAISE EXCEPTION 'an items.nutrition record has no allergens_checked after the backfill';
  END IF;

  -- The trigger and the roll-up on real rows, in a sub-block whose writes are rolled back.
  SELECT ri.recipe_id, ri.item_id INTO v_recipe, v_item
    FROM public.recipe_ingredients ri
   WHERE ri.item_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.recipe_ingredients s WHERE s.recipe_id = ri.recipe_id AND s.sub_recipe_id IS NOT NULL)
   LIMIT 1;
  IF v_item IS NOT NULL THEN
    BEGIN
      -- A save from the app: free text normalised, an unmatched word forces not checked.
      UPDATE public.items SET nutrition = '{"allergens":"Dairy; wheat, kodo","allergens_checked":true}' WHERE id = v_item;
      SELECT nutrition INTO v_n FROM public.items WHERE id = v_item;
      IF v_n->>'allergens' <> 'gluten, milk, kodo' OR (v_n->>'allergens_checked')::boolean THEN
        RAISE EXCEPTION 'proof failed: app save stored %', v_n;
      END IF;
      -- A write from an old bundle (no key): the old allergens stay beside the new, still not checked.
      UPDATE public.items SET nutrition = '{"allergens":"egg"}' WHERE id = v_item;
      SELECT nutrition INTO v_n FROM public.items WHERE id = v_item;
      IF v_n->>'allergens' <> 'gluten, milk, eggs, kodo' OR (v_n->>'allergens_checked')::boolean THEN
        RAISE EXCEPTION 'proof failed: old-bundle save stored %', v_n;
      END IF;
      -- Every ingredient of the dish checked: complete. One unchecked: incomplete.
      UPDATE public.items SET nutrition = '{"allergens_checked":true}'
       WHERE id IN (SELECT item_id FROM public.recipe_ingredients WHERE recipe_id = v_recipe AND item_id IS NOT NULL);
      IF NOT (public._nutrition_rollup(v_recipe)->>'allergens_complete')::boolean THEN
        RAISE EXCEPTION 'proof failed: a dish with every ingredient checked reads incomplete: %', public._nutrition_rollup(v_recipe);
      END IF;
      UPDATE public.items SET nutrition = '{"allergens_checked":false}' WHERE id = v_item;
      IF (public._nutrition_rollup(v_recipe)->>'allergens_complete')::boolean THEN
        RAISE EXCEPTION 'proof failed: a dish with an unchecked ingredient reads complete';
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'S870 proof rollback';
    EXCEPTION WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg <> 'S870 proof rollback' THEN
        RAISE EXCEPTION '%', v_msg;
      END IF;
    END;
  ELSE
    RAISE NOTICE 'no dish with item-only ingredients to prove the roll-up on; trigger and roll-up proof skipped';
  END IF;

  -- The rebuilt bodies run (a plpgsql body is only checked when called; supabase-sql.md S735), on
  -- a real table, a client with Nutrition first so allergens_complete is actually computed.
  SELECT t.id INTO v_table
    FROM public.pos_tables t
    JOIN public.clients c ON c.id = t.client_id
    LEFT JOIN public.feature_flags f ON f.client_id = t.client_id
   WHERE COALESCE(c.pos_enabled, false)
   ORDER BY COALESCE(f.nutrition_facts, false) DESC
   LIMIT 1;
  IF v_table IS NOT NULL THEN
    SELECT count(*), count(*) FILTER (WHERE m.allergens_complete IS NOT NULL) INTO v_rows, v_judged
      FROM public.get_guest_menu(v_table) m;
    RAISE NOTICE 'get_guest_menu on table %: % dishes, % with allergens_complete set', v_table, v_rows, v_judged;
    PERFORM public.get_guest_menu_options(v_table);
  ELSE
    RAISE NOTICE 'no POS table to call get_guest_menu on; call proof skipped';
  END IF;

  -- A missing recipe, and so a missing sub-recipe, is incomplete.
  IF (public._nutrition_rollup('00000000-0000-0000-0000-000000000000'::uuid)->>'allergens_complete')::boolean THEN
    RAISE EXCEPTION 'proof failed: a missing recipe reads complete';
  END IF;

  -- Catalog values, not a formatted string (supabase-sql.md, S630).
  IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proargnames) AS a(n)
                  WHERE p.oid = 'public.get_guest_menu(uuid)'::regprocedure AND a.n = 'allergens_complete') THEN
    RAISE EXCEPTION 'get_guest_menu does not return allergens_complete';
  END IF;
  IF NOT has_function_privilege('anon', 'public.get_guest_menu(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_guest_menu(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_guest_menu(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_guest_menu lost a grant';
  END IF;
  IF position('_guest_dish_allergens' IN pg_get_functiondef('public.get_guest_menu_options(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'get_guest_menu_options does not call _guest_dish_allergens';
  END IF;
  IF NOT has_function_privilege('anon', 'public.get_guest_menu_options(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_guest_menu_options lost its anon grant';
  END IF;
  IF has_function_privilege('anon', 'public._guest_dish_allergens(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.allergen_keys(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.allergen_keys(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'allergen helper grants are not as intended';
  END IF;
END
$mig$;

NOTIFY pgrst, 'reload schema';
