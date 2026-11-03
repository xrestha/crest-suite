-- S870, third file: an item counted in pieces needs the weight of one piece.
--
-- Library figures are per 100 GM or ML. An item stocked in pieces (PCS, PKT, BTL…) with figures per
-- grams fell through _nutrition_convert_qty's "different dimension" branch unchanged, so one piece
-- counted as one gram: two eggs added the calories of 2 g of egg (~3 kcal instead of ~155). Read
-- live before this file: 11 items in two clients, EGGS alone in 12 recipe lines.
--
-- Owner decision: the Nutrition form asks for the weight of one piece (items.nutrition.grams_per_unit,
-- grams, or ml when the figures are per ml), and until it is filled in the item counts as missing
-- nutrition data (has = false), never as a wrong number. The same rule as itemNutrition() and
-- needsPieceWeight() in src/utils/nutrition.js.
--
--   _nutrition_item_contribution: a piece converts through grams_per_unit; without it, has = false.
--     Also takes an empty basis_unit as the item's own unit, as the JS does. Same signature and
--     grants (CREATE OR REPLACE).
--   items_nutrition_normalise: a write from an app version before S870 (no allergens_checked key)
--     keeps the weight the item already had, as it already keeps the allergens.
--
-- Reversal: restore both functions from 20261103120000_allergen_tick_list_s870.sql. A stored
-- grams_per_unit is then ignored.

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
      'fat_g', 0, 'sugar_g', 0, 'sodium_mg', 0, 'allergens', allergens, 'checked', checked);
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
    'checked', checked
  );
END;
$$;

-- ── 2. An old app version's save keeps the weight ──────────────────────────────────────────────
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
    -- allergens in it, so the item keeps what it already declared and whether it was checked,
    -- and the weight of one piece, which that version had no box for.
    v_raw := concat_ws(',', NULLIF(v_raw, ''), NULLIF(public._allergen_raw_text(OLD.nutrition->'allergens'), ''));
    v_checked := CASE WHEN jsonb_typeof(OLD.nutrition->'allergens_checked') = 'boolean'
                      THEN (OLD.nutrition->>'allergens_checked')::boolean ELSE false END;
    IF NOT (v_new ? 'grams_per_unit') AND OLD.nutrition ? 'grams_per_unit' THEN
      v_new := v_new || jsonb_build_object('grams_per_unit', OLD.nutrition->'grams_per_unit');
    END IF;
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

-- ── 3. Proof, on a real piece item, rolled back ────────────────────────────────────────────────
DO $mig$
DECLARE
  v_item uuid;
  v_c    jsonb;
  v_n    jsonb;
  v_msg  text;
BEGIN
  SELECT id INTO v_item FROM public.items WHERE upper(uom) = 'PCS' AND NOT COALESCE(is_sub_recipe, false) ORDER BY id LIMIT 1;
  IF v_item IS NULL THEN
    RAISE NOTICE 'no item counted in PCS; piece proof skipped';
    RETURN;
  END IF;
  BEGIN
    -- Per 100 GM with no weight: missing data, not one gram a piece.
    UPDATE public.items SET nutrition = '{"basis_qty":100,"basis_unit":"GM","energy_kcal":155,"allergens_checked":true}' WHERE id = v_item;
    v_c := public._nutrition_item_contribution(v_item, 2);
    IF (v_c->>'has')::boolean OR (v_c->>'energy_kcal')::numeric <> 0 THEN
      RAISE EXCEPTION 'proof failed: a piece item with no weight contributed %', v_c;
    END IF;
    -- With 50 g a piece: two pieces are 100 g.
    UPDATE public.items SET nutrition = nutrition || '{"grams_per_unit":50}' WHERE id = v_item;
    v_c := public._nutrition_item_contribution(v_item, 2);
    IF NOT (v_c->>'has')::boolean OR round((v_c->>'energy_kcal')::numeric, 3) <> 155 THEN
      RAISE EXCEPTION 'proof failed: two 50 g pieces at 155 kcal per 100 g contributed %', v_c;
    END IF;
    -- A save from an old app version keeps the weight.
    UPDATE public.items SET nutrition = '{"basis_qty":100,"basis_unit":"GM","energy_kcal":155}' WHERE id = v_item;
    SELECT nutrition INTO v_n FROM public.items WHERE id = v_item;
    IF (v_n->>'grams_per_unit')::numeric IS DISTINCT FROM 50 THEN
      RAISE EXCEPTION 'proof failed: an old-version save dropped the weight: %', v_n;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'S870 piece proof rollback';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> 'S870 piece proof rollback' THEN
      RAISE EXCEPTION '%', v_msg;
    END IF;
  END;
END
$mig$;
