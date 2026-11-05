-- S886: a blank sugar or sodium figure is unknown, never 0, and the guest menu leaves it off.
--
-- 350 of the 575 Nepal foods in the nutrition library (S884) have no sugar or sodium figure, and a
-- hand-typed Nutrition form can leave either box empty (the app stores no key for a blank box).
-- _nutrition_item_contribution read a missing key as 0, so a dish built on such an ingredient
-- showed sugar and sodium too low on the guest QR menu, with nothing saying a figure was missing.
--
-- Owner decision (2026-11-05, asked in plain words): hide them for guests. When any ingredient a
-- dish reaches (through sub-recipes too) carries figures but left sugar or sodium blank, the guest
-- menu leaves that figure off the dish. Staff still see the known part as "at least", with the
-- ingredients named (src/utils/nutrition.js: itemNutrition's `blank`, blankFigures). A typed 0 is
-- a figure. An ingredient with no figures at all, or a piece item with no weight, is unchanged: it
-- counts as missing data (has = false), as before.
--
--   _nutrition_item_contribution: adds sugar_blank and sodium_blank, true only when the item
--     contributes (has data and a quantity above 0) and the key is missing, JSON null or empty.
--     Same signature, same figures, same grants (CREATE OR REPLACE).
--   _nutrition_rollup: carries the two flags up through sub-recipes, keeps summing the known part
--     (sugar_known, sodium_known, used by a parent's sum), and returns sugar_g / sodium_mg as JSON
--     null when its flag is set. get_guest_menu reads (roll->>'sugar_g')::numeric, so it returns
--     NULL with no change to its own body; this file asserts that on the live body before replacing
--     anything. _guest_dish_allergens reads only the allergen keys.
--
-- Run order: this file, then the frontend (GuestMenu.jsx leaves a NULL figure off the line). A
-- guest page from before the release prints a NULL figure as 0.0 g until it reloads, which is what
-- it printed before this file.
--
-- Reversal: restore _nutrition_item_contribution from 20261103140000_nutrition_piece_weight_s870.sql
-- and _nutrition_rollup from 20261103120000_allergen_tick_list_s870.sql (both CREATE OR REPLACE,
-- same signatures). Nothing is stored, so nothing needs undoing in the data.

-- ── 0. The guest menu reads the two figures straight from the rollup ──────────────────────────
DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.get_guest_menu(uuid)'::regprocedure);
BEGIN
  IF position($$(roll->>'sugar_g')::numeric$$ IN v_def) = 0
     OR position($$(roll->>'sodium_mg')::numeric$$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'S886: get_guest_menu no longer reads sugar_g / sodium_mg from the rollup as expected; re-read it before applying';
  END IF;
END
$mig$;

-- ── 1. The contribution of one ingredient ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._nutrition_item_contribution(p_item_id uuid, p_qty numeric) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path = public
    AS $$
DECLARE
  n jsonb;
  item_uom text;
  basis_qty numeric;
  basis_unit text;
  piece_dim text;
  per_piece numeric;
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

  -- pieceToBasisDim(): a count unit against figures per mass or volume.
  basis_unit := COALESCE(NULLIF(n->>'basis_unit', ''), item_uom);
  IF upper(COALESCE(item_uom, '')) NOT IN ('GM', 'KG', 'ML', 'LTR') THEN
    piece_dim := CASE WHEN upper(COALESCE(basis_unit, '')) IN ('GM', 'KG') THEN 'mass'
                      WHEN upper(COALESCE(basis_unit, '')) IN ('ML', 'LTR') THEN 'vol' END;
  END IF;
  IF piece_dim IS NOT NULL THEN
    per_piece := CASE WHEN jsonb_typeof(n->'grams_per_unit') = 'number' THEN NULLIF((n->>'grams_per_unit')::numeric, 0) END;
    IF per_piece IS NULL OR per_piece < 0 THEN
      has_data := false;
    END IF;
  END IF;

  IF NOT has_data OR p_qty IS NULL OR p_qty <= 0 THEN
    RETURN jsonb_build_object('has', has_data, 'energy_kcal', 0, 'protein_g', 0, 'carbs_g', 0,
      'fat_g', 0, 'sugar_g', 0, 'sodium_mg', 0, 'allergens', allergens, 'checked', checked,
      'sugar_blank', false, 'sodium_blank', false);
  END IF;

  basis_qty := NULLIF((n->>'basis_qty')::numeric, 0);
  IF basis_qty IS NULL THEN basis_qty := 100; END IF;
  IF piece_dim IS NOT NULL THEN
    qty_in_basis := public._nutrition_convert_qty(p_qty * per_piece, CASE piece_dim WHEN 'mass' THEN 'GM' ELSE 'ML' END, basis_unit);
  ELSE
    qty_in_basis := public._nutrition_convert_qty(p_qty, item_uom, basis_unit);
  END IF;
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
    'checked', checked,
    -- S886: a missing, null or empty box is unknown (itemNutrition's `blank`); a typed 0 is a figure.
    'sugar_blank',  NULLIF(btrim(n->>'sugar_g'), '') IS NULL,
    'sodium_blank', NULLIF(btrim(n->>'sodium_mg'), '') IS NULL
  );
END;
$$;

-- ── 2. The dish roll-up ────────────────────────────────────────────────────────────────────────
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
  sugar_blank boolean := false;
  sodium_blank boolean := false;
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
      sugar_blank := sugar_blank OR COALESCE((contrib->>'sugar_blank')::boolean, false);
      sodium_blank := sodium_blank OR COALESCE((contrib->>'sodium_blank')::boolean, false);
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
      sugar_blank := sugar_blank OR COALESCE((sub_result->>'sugar_blank')::boolean, false);
      sodium_blank := sodium_blank OR COALESCE((sub_result->>'sodium_blank')::boolean, false);
      q := COALESCE(ri.qty_per_portion, 0);
      -- A sub-recipe's sugar_g / sodium_mg can be null now; its known part is sugar_known /
      -- sodium_known (the early returns above carry only the plain keys, at 0).
      total := jsonb_build_object(
        'energy_kcal', (total->>'energy_kcal')::numeric + (sub_result->>'energy_kcal')::numeric / sub_yield * q,
        'protein_g',   (total->>'protein_g')::numeric   + (sub_result->>'protein_g')::numeric   / sub_yield * q,
        'carbs_g',     (total->>'carbs_g')::numeric     + (sub_result->>'carbs_g')::numeric     / sub_yield * q,
        'fat_g',       (total->>'fat_g')::numeric       + (sub_result->>'fat_g')::numeric       / sub_yield * q,
        'sugar_g',     (total->>'sugar_g')::numeric
                       + COALESCE(sub_result->>'sugar_known', sub_result->>'sugar_g', '0')::numeric / sub_yield * q,
        'sodium_mg',   (total->>'sodium_mg')::numeric
                       + COALESCE(sub_result->>'sodium_known', sub_result->>'sodium_mg', '0')::numeric / sub_yield * q
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
    'allergens_complete', all_checked AND item_count > 0 AND NOT broken,
    'sugar_blank', sugar_blank, 'sodium_blank', sodium_blank,
    'sugar_known', total->'sugar_g', 'sodium_known', total->'sodium_mg',
    'sugar_g',   CASE WHEN sugar_blank  THEN 'null'::jsonb ELSE total->'sugar_g'   END,
    'sodium_mg', CASE WHEN sodium_blank THEN 'null'::jsonb ELSE total->'sodium_mg' END);
END;
$$;

-- ── 3. Proof, on throwaway rows, rolled back ────────────────────────────────────────────────────
-- A dish of 100 g maida (every figure) and 1 of a sub-recipe holding 50 g kukhura (no sugar or
-- sodium): sugar and sodium come back null with the known part kept, the other four figures add
-- up, and a typed 0 on the kukhura brings both back. Two real items of one client are borrowed and
-- every write is undone by the closing RAISE.
DO $mig$
DECLARE
  v_client uuid;
  v_maida  uuid;
  v_kuk    uuid;
  v_sub    uuid;
  v_dish   uuid;
  v_r      jsonb;
  v_c      jsonb;
  v_msg    text;
BEGIN
  SELECT i.client_id INTO v_client FROM public.items i
   WHERE NOT COALESCE(i.is_sub_recipe, false) AND upper(i.uom) = 'GM'
   GROUP BY i.client_id HAVING count(*) >= 2 ORDER BY i.client_id LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S886 proof: no client has two items counted in GM';
  END IF;
  SELECT id INTO v_maida FROM public.items
   WHERE client_id = v_client AND NOT COALESCE(is_sub_recipe, false) AND upper(uom) = 'GM' ORDER BY id LIMIT 1;
  SELECT id INTO v_kuk FROM public.items
   WHERE client_id = v_client AND NOT COALESCE(is_sub_recipe, false) AND upper(uom) = 'GM' AND id <> v_maida ORDER BY id LIMIT 1;

  BEGIN
    UPDATE public.items SET nutrition = '{"basis_qty":100,"basis_unit":"GM","energy_kcal":100,"protein_g":10,"carbs_g":20,"fat_g":1,"sugar_g":2,"sodium_mg":50,"allergens_checked":true}' WHERE id = v_maida;
    UPDATE public.items SET nutrition = '{"basis_qty":100,"basis_unit":"GM","energy_kcal":120,"protein_g":20,"carbs_g":0,"fat_g":4,"allergens_checked":true}' WHERE id = v_kuk;

    INSERT INTO public.recipes (client_id, name, category, yield_qty, pos_enabled)
    VALUES (v_client, 'S886 proof filling', 'Sub-Recipe', 1, false) RETURNING id INTO v_sub;
    INSERT INTO public.recipes (client_id, name, category, pos_enabled)
    VALUES (v_client, 'S886 proof momo', 'Food', false) RETURNING id INTO v_dish;
    INSERT INTO public.recipe_ingredients (recipe_id, item_id, qty_per_portion) VALUES (v_sub, v_kuk, 50);
    INSERT INTO public.recipe_ingredients (recipe_id, item_id, qty_per_portion) VALUES (v_dish, v_maida, 100);
    INSERT INTO public.recipe_ingredients (recipe_id, sub_recipe_id, qty_per_portion) VALUES (v_dish, v_sub, 1);

    -- One ingredient: flags only when it contributes.
    v_c := public._nutrition_item_contribution(v_kuk, 50);
    IF NOT (v_c->>'sugar_blank')::boolean OR NOT (v_c->>'sodium_blank')::boolean OR (v_c->>'sugar_g')::numeric <> 0 THEN
      RAISE EXCEPTION 'proof failed: a blank kukhura reads %', v_c;
    END IF;
    v_c := public._nutrition_item_contribution(v_kuk, 0);
    IF (v_c->>'sugar_blank')::boolean THEN
      RAISE EXCEPTION 'proof failed: a zero quantity flags a blank: %', v_c;
    END IF;
    v_c := public._nutrition_item_contribution(v_maida, 100);
    IF (v_c->>'sugar_blank')::boolean OR (v_c->>'sodium_blank')::boolean THEN
      RAISE EXCEPTION 'proof failed: maida with every figure reads blank: %', v_c;
    END IF;

    -- The dish: unknown sugar and sodium, known part kept, the rest summed.
    v_r := public._nutrition_rollup(v_dish);
    IF v_r->>'sugar_g' IS NOT NULL OR v_r->>'sodium_mg' IS NOT NULL
       OR (v_r->>'sugar_known')::numeric <> 2 OR (v_r->>'sodium_known')::numeric <> 50
       OR round((v_r->>'energy_kcal')::numeric, 3) <> 160 OR round((v_r->>'protein_g')::numeric, 3) <> 20
       OR NOT (v_r->>'sugar_blank')::boolean OR NOT (v_r->>'covered')::boolean
       OR NOT (v_r->>'allergens_complete')::boolean THEN
      RAISE EXCEPTION 'proof failed: the dish with a blank sub-recipe ingredient reads %', v_r;
    END IF;
    -- The sub-recipe on its own, too.
    v_r := public._nutrition_rollup(v_sub);
    IF v_r->>'sugar_g' IS NOT NULL OR round((v_r->>'energy_kcal')::numeric, 3) <> 60 THEN
      RAISE EXCEPTION 'proof failed: the sub-recipe reads %', v_r;
    END IF;

    -- Only sodium blank: sugar comes back with the full sum.
    UPDATE public.items SET nutrition = nutrition || '{"sugar_g":1}' WHERE id = v_kuk;
    v_r := public._nutrition_rollup(v_dish);
    IF round((v_r->>'sugar_g')::numeric, 3) <> 2.5 OR v_r->>'sodium_mg' IS NOT NULL THEN
      RAISE EXCEPTION 'proof failed: sugar filled, sodium blank reads %', v_r;
    END IF;

    -- A typed 0 is a figure.
    UPDATE public.items SET nutrition = nutrition || '{"sodium_mg":0}' WHERE id = v_kuk;
    v_r := public._nutrition_rollup(v_dish);
    IF round((v_r->>'sodium_mg')::numeric, 3) <> 50 OR (v_r->>'sodium_blank')::boolean THEN
      RAISE EXCEPTION 'proof failed: a typed 0 sodium reads %', v_r;
    END IF;

    -- A missing recipe and a cycle are unchanged.
    v_r := public._nutrition_rollup('00000000-0000-0000-0000-000000000000'::uuid);
    IF (v_r->>'allergens_complete')::boolean OR (v_r->>'sugar_g')::numeric <> 0 THEN
      RAISE EXCEPTION 'proof failed: a missing recipe reads %', v_r;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'S886 proof rollback';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> 'S886 proof rollback' THEN
      RAISE EXCEPTION '%', v_msg;
    END IF;
  END;
END
$mig$;
