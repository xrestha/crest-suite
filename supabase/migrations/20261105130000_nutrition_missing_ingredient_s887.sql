-- S887: the guest menu shows no nutrition figures for a dish until every ingredient it reaches has them.
--
-- An ingredient with no nutrition figures adds 0 to the roll-up. Staff see that as a gap in the
-- data count ("Data: 3/5 ingredients", values are estimates), but the guest QR menu printed the
-- dish's calories, protein, carbs and fat as if they were whole, so a guest read figures too low.
--
-- Owner decision (2026-11-05, asked in plain words): hide the figures. Until every ingredient a
-- dish reaches (through sub-recipes too) has figures, the guest menu shows no nutrition line for
-- it. Staff still see the partial figures, as today. "No figures" is exactly what the staff count
-- calls missing (src/utils/nutrition.js: itemNutrition's `has`, needsPieceWeight, the coverage
-- count): a food item with no figures, or one counted in pieces whose figures are per GM or ML with
-- no weight of one piece, whatever the line's quantity (the count reads a saved 0 the same way; the
-- recipe form saves only quantities above 0). A not-food item (packaging) is never missing: the
-- count leaves it out. A sub-recipe line is missing when its own walk is, or when it reaches no
-- ingredient with figures (the count's sub-recipe line, calcSubRecipeNutritionPerUnit). The JS count
-- now applies the same sub-recipe rule, so staff and guests agree: "5/5" shows figures to guests,
-- "4/5" shows none.
--
--   _nutrition_item_contribution: adds figures_missing, true when the item has no usable figures
--     and is not marked not_food. Same signature, same figures, same grants (CREATE OR REPLACE).
--   _nutrition_rollup: carries figures_missing up through sub-recipes, as S886 carries
--     sugar_blank. The figures and every other key are unchanged.
--   get_guest_menu: one line, patched from its LIVE body (asserted first, as S886 asserts):
--     has_nutrition is false when the roll-up says figures_missing. The figures are still sent, as
--     for any row with has_nutrition false. The guest page has shown no nutrition line for
--     has_nutrition false since it first shipped (2026-07-07), so no guest-page change is needed
--     and a cached page follows at once.
--   The roll-up's `covered` keeps its meaning (some ingredient has figures): a parent's walk reads
--     it, and the JS walk's `covered` means the same. The rule is the guest menu's, so it is
--     written in the guest menu.
--
-- Run order: after 20261105110000 (S886; asserted below), then the frontend (the staff count of a
-- sub-recipe line, and the sentence saying guests see no figures). Either order is safe: nothing
-- the frontend calls changes shape.
--
-- Reversal: restore _nutrition_item_contribution and _nutrition_rollup from
-- 20261105110000_nutrition_blank_sugar_sodium_s886.sql (CREATE OR REPLACE, same signatures), and
-- put get_guest_menu's has_nutrition line back to
-- `has_nutrition := v_nutrition_enabled AND COALESCE((roll->>'covered')::boolean, false);`.
-- Nothing is stored, so nothing needs undoing in the data.

-- ── 0. What this file builds on is what is live ───────────────────────────────────────────────
-- The two helpers below are replaced whole, so they must be S886's bodies (md5 of prosrc, read
-- live 2026-11-05), or already this file's (a re-run). get_guest_menu is patched on one line,
-- which must appear exactly once (or already be patched).
DO $mig$
DECLARE
  v_contrib text := (SELECT prosrc FROM pg_proc WHERE oid = 'public._nutrition_item_contribution(uuid,numeric)'::regprocedure);
  v_rollup  text := (SELECT prosrc FROM pg_proc WHERE oid = 'public._nutrition_rollup(uuid,uuid[])'::regprocedure);
  v_def     text := pg_get_functiondef('public.get_guest_menu(uuid)'::regprocedure);
  v_old     text := $$has_nutrition := v_nutrition_enabled AND COALESCE((roll->>'covered')::boolean, false);$$;
  v_new     text := $$AND NOT COALESCE((roll->>'figures_missing')::boolean, true);$$;
  v_old_n   int;
  v_new_n   int;
BEGIN
  IF md5(v_contrib) <> '7ce30145b1ba75f03181f94510cd2ed5' AND position('S887' IN v_contrib) = 0 THEN
    RAISE EXCEPTION 'S887: _nutrition_item_contribution is not the S886 body; apply 20261105110000 first, or re-read the live body before applying';
  END IF;
  IF md5(v_rollup) <> '5637140f82d7266c40edf6ff6e580d04' AND position('S887' IN v_rollup) = 0 THEN
    RAISE EXCEPTION 'S887: _nutrition_rollup is not the S886 body; apply 20261105110000 first, or re-read the live body before applying';
  END IF;
  v_old_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  v_new_n := (length(v_def) - length(replace(v_def, v_new, ''))) / length(v_new);
  IF NOT ((v_old_n = 1 AND v_new_n = 0) OR (v_old_n = 0 AND v_new_n = 1)) THEN
    RAISE EXCEPTION 'S887: get_guest_menu no longer sets has_nutrition on the expected line (% old, % new); re-read it before applying', v_old_n, v_new_n;
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
  is_not_food boolean;
  allergens_raw text;
  allergens jsonb;
BEGIN
  SELECT nutrition, uom INTO n, item_uom FROM items WHERE id = p_item_id;

  checked := CASE WHEN jsonb_typeof(n->'allergens_checked') = 'boolean' THEN (n->>'allergens_checked')::boolean ELSE false END;
  -- S887: packaging and cleaning supplies (isNotFood) are never missing figures.
  is_not_food := CASE WHEN jsonb_typeof(n->'not_food') = 'boolean' THEN (n->>'not_food')::boolean ELSE false END;

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
      'sugar_blank', false, 'sodium_blank', false,
      -- S887: no usable figures (none, or a piece item with no weight), whatever the quantity,
      -- as the staff count reads it.
      'figures_missing', NOT has_data AND NOT is_not_food);
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
    'sodium_blank', NULLIF(btrim(n->>'sodium_mg'), '') IS NULL,
    'figures_missing', false
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
  figures_missing boolean := false;
  found_recipe boolean;
  yield_qty numeric;
  sub_result jsonb;
  sub_yield numeric;
  q numeric;
BEGIN
  -- S887: a cycle or a missing recipe vouches for nothing, so its figures count as missing.
  IF p_recipe_id = ANY(p_seen) THEN
    RETURN jsonb_build_object('energy_kcal',0,'protein_g',0,'carbs_g',0,'fat_g',0,'sugar_g',0,
      'sodium_mg',0,'allergens','[]'::jsonb,'covered',false,'yield_qty',1,
      'all_checked',false,'item_count',0,'broken',true,'allergens_complete',false,
      'figures_missing',true);
  END IF;

  -- Aliased and column-qualified deliberately — `yield_qty` here is both a column on recipes
  -- and this function's own local variable; an unqualified reference is ambiguous and Postgres
  -- errors on it at call time (not at CREATE FUNCTION time).
  SELECT COALESCE(rc.yield_qty, 1) INTO yield_qty FROM recipes rc WHERE rc.id = p_recipe_id;
  found_recipe := FOUND;
  IF NOT found_recipe THEN
    RETURN jsonb_build_object('energy_kcal',0,'protein_g',0,'carbs_g',0,'fat_g',0,'sugar_g',0,
      'sodium_mg',0,'allergens','[]'::jsonb,'covered',false,'yield_qty',1,
      'all_checked',false,'item_count',0,'broken',true,'allergens_complete',false,
      'figures_missing',true);
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
      -- S887: a food ingredient with no usable figures. The key is always there; unknown hides.
      figures_missing := figures_missing OR COALESCE((contrib->>'figures_missing')::boolean, true);
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
      -- S887: a sub-recipe missing figures somewhere, or reaching no ingredient with figures, is
      -- one missing ingredient of this dish (the staff count's sub-recipe line).
      figures_missing := figures_missing OR NOT COALESCE((sub_result->>'covered')::boolean, false)
                         OR COALESCE((sub_result->>'figures_missing')::boolean, true);
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
    'sodium_mg', CASE WHEN sodium_blank THEN 'null'::jsonb ELSE total->'sodium_mg' END,
    'figures_missing', figures_missing);
END;
$$;

-- ── 3. The guest menu: no figures while any ingredient has none ───────────────────────────────
-- Patched from the live body, so nothing changed outside the migrations is reverted. CREATE OR
-- REPLACE keeps the owner, the grants (anon calls it by design), SECURITY DEFINER and search_path;
-- all four are compared before and after.
DO $mig$
DECLARE
  v_fn     regprocedure := 'public.get_guest_menu(uuid)'::regprocedure;
  v_def    text := pg_get_functiondef('public.get_guest_menu(uuid)'::regprocedure);
  v_old    text := $$has_nutrition := v_nutrition_enabled AND COALESCE((roll->>'covered')::boolean, false);$$;
  v_marker text := $$AND NOT COALESCE((roll->>'figures_missing')::boolean, true);$$;
  v_repl   text := $r$-- S887 (owner decision): no nutrition figures for guests until every ingredient the dish
    -- reaches has them (the roll-up's figures_missing). Staff still see the partial figures.
    has_nutrition := v_nutrition_enabled AND COALESCE((roll->>'covered')::boolean, false)
                     AND NOT COALESCE((roll->>'figures_missing')::boolean, true);$r$;
  v_before record;
  v_after  record;
BEGIN
  SELECT p.proowner, p.proacl::text AS acl, p.prosecdef, p.proconfig::text AS config, p.provolatile
    INTO v_before FROM pg_proc p WHERE p.oid = v_fn;

  IF position(v_marker IN v_def) = 0 THEN
    EXECUTE replace(v_def, v_old, v_repl);
  END IF;

  SELECT p.proowner, p.proacl::text AS acl, p.prosecdef, p.proconfig::text AS config, p.provolatile, p.prosrc
    INTO v_after FROM pg_proc p WHERE p.oid = v_fn;
  IF position(v_marker IN v_after.prosrc) = 0 OR position(v_old IN v_after.prosrc) > 0 THEN
    RAISE EXCEPTION 'S887: get_guest_menu was not patched as expected';
  END IF;
  IF v_after.proowner <> v_before.proowner OR v_after.acl IS DISTINCT FROM v_before.acl
     OR v_after.prosecdef IS DISTINCT FROM v_before.prosecdef OR NOT v_after.prosecdef
     OR v_after.config IS DISTINCT FROM v_before.config OR v_after.provolatile <> v_before.provolatile THEN
    RAISE EXCEPTION 'S887: patching get_guest_menu changed its owner, grants, SECURITY DEFINER, search_path or volatility';
  END IF;
END
$mig$;

-- ── 4. Proof, on throwaway rows, rolled back ────────────────────────────────────────────────────
-- Throwaway items and recipes on a POS outlet whose guest menu answers (a table, POS on, the
-- account open), with the nutrition switch on. A dish of 100 g maida, a cup (not food) and 1 of a
-- sub-recipe holding 50 g chicken keeps its figures on the guest menu. Salt with no figures, on the
-- dish or inside the sub-recipe, hides them while the staff figures stay as they were. An egg
-- counted in pieces hides them until it has the weight of one piece. A sub-recipe holding only
-- packaging hides them, as the staff count calls it missing. Every write is undone by the closing
-- RAISE.
DO $mig$
DECLARE
  v_client  uuid;
  v_table   uuid;
  v_maida   uuid;
  v_chicken uuid;
  v_salt    uuid;
  v_cup     uuid;
  v_egg     uuid;
  v_sub     uuid;
  v_pack    uuid;
  v_dish    uuid;
  v_r       jsonb;
  v_c       jsonb;
  v_has     boolean;
  v_kcal    numeric;
  v_msg     text;
BEGIN
  SELECT t.client_id, t.id INTO v_client, v_table
    FROM public.pos_tables t JOIN public.clients c ON c.id = t.client_id
   WHERE COALESCE(c.pos_enabled, false) AND COALESCE(public.client_access_open(c.id), false)
   ORDER BY t.client_id, t.id LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S887 proof: no outlet with POS on, the account open and a table';
  END IF;

  BEGIN
    -- The guest figures follow the nutrition switch.
    INSERT INTO public.feature_flags (client_id, nutrition_facts) VALUES (v_client, true)
      ON CONFLICT (client_id) DO UPDATE SET nutrition_facts = true;

    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, nutrition)
    VALUES (v_client, 'S887 proof maida', 'GM', 1, 0,
      '{"basis_qty":100,"basis_unit":"GM","energy_kcal":100,"protein_g":10,"carbs_g":20,"fat_g":1,"sugar_g":2,"sodium_mg":50,"allergens_checked":true}')
    RETURNING id INTO v_maida;
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, nutrition)
    VALUES (v_client, 'S887 proof chicken', 'GM', 1, 0,
      '{"basis_qty":100,"basis_unit":"GM","energy_kcal":120,"protein_g":20,"carbs_g":0,"fat_g":4,"sugar_g":0,"sodium_mg":70,"allergens_checked":true}')
    RETURNING id INTO v_chicken;
    -- What the form saves for a blank form: checked, no figures.
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, nutrition)
    VALUES (v_client, 'S887 proof salt', 'GM', 1, 0, '{"allergens_checked":true}')
    RETURNING id INTO v_salt;
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, nutrition)
    VALUES (v_client, 'S887 proof cup', 'PCS', 1, 0, '{"not_food":true,"allergens_checked":true}')
    RETURNING id INTO v_cup;
    -- Figures per 100 g on an item counted in pieces, with no weight of one piece yet.
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, nutrition)
    VALUES (v_client, 'S887 proof egg', 'PCS', 1, 0,
      '{"basis_qty":100,"basis_unit":"GM","energy_kcal":155,"protein_g":13,"carbs_g":1,"fat_g":11,"sugar_g":1,"sodium_mg":124,"allergens_checked":true}')
    RETURNING id INTO v_egg;

    INSERT INTO public.recipes (client_id, name, category, yield_qty, pos_enabled)
    VALUES (v_client, 'S887 proof filling', 'Sub-Recipe', 1, false) RETURNING id INTO v_sub;
    INSERT INTO public.recipes (client_id, name, category, yield_qty, pos_enabled)
    VALUES (v_client, 'S887 proof pack', 'Sub-Recipe', 1, false) RETURNING id INTO v_pack;
    INSERT INTO public.recipes (client_id, name, category, selling_price, pos_enabled, is_active)
    VALUES (v_client, 'S887 proof momo', 'Food', 250, true, true) RETURNING id INTO v_dish;
    INSERT INTO public.recipe_ingredients (recipe_id, item_id, qty_per_portion) VALUES (v_sub, v_chicken, 50);
    INSERT INTO public.recipe_ingredients (recipe_id, item_id, qty_per_portion) VALUES (v_pack, v_cup, 1);
    INSERT INTO public.recipe_ingredients (recipe_id, item_id, qty_per_portion) VALUES (v_dish, v_maida, 100);
    INSERT INTO public.recipe_ingredients (recipe_id, item_id, qty_per_portion) VALUES (v_dish, v_cup, 1);
    INSERT INTO public.recipe_ingredients (recipe_id, sub_recipe_id, qty_per_portion) VALUES (v_dish, v_sub, 1);

    -- One ingredient: missing means no usable figures and not packaging, whatever the quantity.
    v_c := public._nutrition_item_contribution(v_salt, 5);
    IF (v_c->>'figures_missing')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'proof failed: salt with no figures reads %', v_c;
    END IF;
    v_c := public._nutrition_item_contribution(v_salt, 0);
    IF (v_c->>'figures_missing')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'proof failed: salt on a 0 line reads %', v_c;
    END IF;
    v_c := public._nutrition_item_contribution(v_maida, 0);
    IF (v_c->>'figures_missing')::boolean IS NOT FALSE THEN
      RAISE EXCEPTION 'proof failed: maida on a 0 line reads %', v_c;
    END IF;
    v_c := public._nutrition_item_contribution(v_cup, 1);
    IF (v_c->>'figures_missing')::boolean IS NOT FALSE THEN
      RAISE EXCEPTION 'proof failed: a not-food cup reads %', v_c;
    END IF;
    v_c := public._nutrition_item_contribution(v_egg, 1);
    IF (v_c->>'figures_missing')::boolean IS NOT TRUE OR (v_c->>'has')::boolean IS NOT FALSE THEN
      RAISE EXCEPTION 'proof failed: an egg with no piece weight reads %', v_c;
    END IF;

    -- The complete dish keeps its figures, for staff and guests; the cup does not hide them.
    v_r := public._nutrition_rollup(v_dish);
    IF (v_r->>'figures_missing')::boolean IS NOT FALSE OR (v_r->>'covered')::boolean IS NOT TRUE
       OR round((v_r->>'energy_kcal')::numeric, 3) IS DISTINCT FROM 160 OR round((v_r->>'protein_g')::numeric, 3) IS DISTINCT FROM 20 THEN
      RAISE EXCEPTION 'proof failed: the complete dish reads %', v_r;
    END IF;
    SELECT g.has_nutrition, g.energy_kcal INTO v_has, v_kcal FROM public.get_guest_menu(v_table) g WHERE g.recipe_id = v_dish;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'proof failed: the proof dish is not on the guest menu';
    END IF;
    IF v_has IS NOT TRUE OR round(v_kcal, 3) IS DISTINCT FROM 160 THEN
      RAISE EXCEPTION 'proof failed: the complete dish on the guest menu reads has_nutrition %, % kcal', v_has, v_kcal;
    END IF;

    -- Salt with no figures on the dish: hidden for guests, the staff figures unchanged.
    INSERT INTO public.recipe_ingredients (recipe_id, item_id, qty_per_portion) VALUES (v_dish, v_salt, 5);
    v_r := public._nutrition_rollup(v_dish);
    IF (v_r->>'figures_missing')::boolean IS NOT TRUE OR (v_r->>'covered')::boolean IS NOT TRUE
       OR round((v_r->>'energy_kcal')::numeric, 3) IS DISTINCT FROM 160 THEN
      RAISE EXCEPTION 'proof failed: the dish with salt reads %', v_r;
    END IF;
    SELECT g.has_nutrition INTO v_has FROM public.get_guest_menu(v_table) g WHERE g.recipe_id = v_dish;
    IF v_has IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'proof failed: the dish with salt on the guest menu reads has_nutrition %', v_has;
    END IF;
    DELETE FROM public.recipe_ingredients WHERE recipe_id = v_dish AND item_id = v_salt;

    -- The same salt inside the sub-recipe: the sub-recipe and the dish are both missing it.
    INSERT INTO public.recipe_ingredients (recipe_id, item_id, qty_per_portion) VALUES (v_sub, v_salt, 5);
    v_r := public._nutrition_rollup(v_sub);
    IF (v_r->>'figures_missing')::boolean IS NOT TRUE OR (v_r->>'covered')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'proof failed: the sub-recipe with salt reads %', v_r;
    END IF;
    v_r := public._nutrition_rollup(v_dish);
    IF (v_r->>'figures_missing')::boolean IS NOT TRUE OR round((v_r->>'energy_kcal')::numeric, 3) IS DISTINCT FROM 160 THEN
      RAISE EXCEPTION 'proof failed: the dish with salt in its sub-recipe reads %', v_r;
    END IF;
    SELECT g.has_nutrition INTO v_has FROM public.get_guest_menu(v_table) g WHERE g.recipe_id = v_dish;
    IF v_has IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'proof failed: the dish with salt in its sub-recipe on the guest menu reads has_nutrition %', v_has;
    END IF;
    DELETE FROM public.recipe_ingredients WHERE recipe_id = v_sub AND item_id = v_salt;

    -- An egg counted in pieces with no weight of one piece hides them; the weight brings them back.
    INSERT INTO public.recipe_ingredients (recipe_id, item_id, qty_per_portion) VALUES (v_dish, v_egg, 1);
    v_r := public._nutrition_rollup(v_dish);
    IF (v_r->>'figures_missing')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'proof failed: the dish with a weightless egg reads %', v_r;
    END IF;
    SELECT g.has_nutrition INTO v_has FROM public.get_guest_menu(v_table) g WHERE g.recipe_id = v_dish;
    IF v_has IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'proof failed: the dish with a weightless egg on the guest menu reads has_nutrition %', v_has;
    END IF;
    UPDATE public.items SET nutrition = nutrition || '{"grams_per_unit":50}' WHERE id = v_egg;
    v_r := public._nutrition_rollup(v_dish);
    IF (v_r->>'figures_missing')::boolean IS NOT FALSE OR round((v_r->>'energy_kcal')::numeric, 3) IS DISTINCT FROM 237.5 THEN
      RAISE EXCEPTION 'proof failed: the dish with a 50 g egg reads %', v_r;
    END IF;
    SELECT g.has_nutrition, g.energy_kcal INTO v_has, v_kcal FROM public.get_guest_menu(v_table) g WHERE g.recipe_id = v_dish;
    IF v_has IS NOT TRUE OR round(v_kcal, 3) IS DISTINCT FROM 237.5 THEN
      RAISE EXCEPTION 'proof failed: the dish with a 50 g egg on the guest menu reads has_nutrition %, % kcal', v_has, v_kcal;
    END IF;

    -- A sub-recipe holding only packaging reaches no ingredient with figures: the staff count calls
    -- that line missing, so the guest menu does too.
    INSERT INTO public.recipe_ingredients (recipe_id, sub_recipe_id, qty_per_portion) VALUES (v_dish, v_pack, 1);
    v_r := public._nutrition_rollup(v_pack);
    IF (v_r->>'figures_missing')::boolean IS NOT FALSE OR (v_r->>'covered')::boolean IS NOT FALSE THEN
      RAISE EXCEPTION 'proof failed: the packaging sub-recipe on its own reads %', v_r;
    END IF;
    v_r := public._nutrition_rollup(v_dish);
    IF (v_r->>'figures_missing')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'proof failed: the dish with a packaging sub-recipe reads %', v_r;
    END IF;

    -- A missing recipe vouches for nothing.
    v_r := public._nutrition_rollup('00000000-0000-0000-0000-000000000000'::uuid);
    IF (v_r->>'figures_missing')::boolean IS NOT TRUE OR (v_r->>'covered')::boolean IS NOT FALSE
       OR (v_r->>'allergens_complete')::boolean IS NOT FALSE THEN
      RAISE EXCEPTION 'proof failed: a missing recipe reads %', v_r;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'S887 proof rollback';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> 'S887 proof rollback' THEN
      RAISE EXCEPTION '%', v_msg;
    END IF;
  END;
END
$mig$;
