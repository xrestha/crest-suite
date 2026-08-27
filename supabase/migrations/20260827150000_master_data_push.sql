-- HQ -> branch master-data push (S617).
--
-- Standardising a chain's item master, recipes and menu prices from one HQ outlet, on demand,
-- with a preview. CLAUDE.md has carried the design constraint since S548 and this is it honoured:
--
--     "when it is [built], note items/recipes have no UNIQUE(client_id, name), so it must match
--      on an added master_id, never by name."
--
-- master_id is that link. An HQ record has master_id IS NULL (it IS the master); a branch copy
-- carries master_id = <the HQ record's id>. Thereafter renaming either side changes nothing about
-- which record is which, which is the whole point -- name matching would silently merge two
-- different items the first time someone fixed a spelling.
--
-- THE ONE EXCEPTION, and it is deliberate: the FIRST push into a branch that already has its own
-- data has no master_id to match on, so name matching is the only way to avoid duplicating an
-- entire item master. That is an ADOPTION, it happens once per record, and the preview names it
-- as such ('adopt') so an operator sees every guess before anything is written. After adoption the
-- link is master_id forever.
--
-- WHAT IS PUSHED, AND WHAT IS POINTEDLY NOT
--
--   Pushed: the DEFINITION of a thing -- names, units, conversions, yield, category, codes,
--   nutrition, active flag, and (per the product decision) recipe selling prices.
--
--   Never pushed on update: items.rate. That is the price the BRANCH pays its own supplier, and
--   it is the input to every costing figure that branch produces. Overwriting it with HQ's rate
--   would not standardise anything, it would corrupt the branch's food cost with another city's
--   prices. It is seeded from HQ on CREATE only, because items.rate is NOT NULL and a new item
--   needs a starting value the branch then corrects.
--
--   Never pushed at all: recipes.me_class (a classification derived from that branch's own sales),
--   recipes.cost_price (derived), recipes.linked_item_id (points at a branch-local mirror row).
--
-- SUB-RECIPES. A sub-recipe is a recipe with category = 'Sub-Recipe', and Recipes.js mirrors it
-- into items (is_sub_recipe = true) so it can be stock-counted. A pushed sub-recipe therefore
-- needs its mirror created at the branch too, or recipe_ingredients.sub_recipe_id references
-- resolve while the branch cannot count the thing. This function creates the mirror and links it,
-- reproducing Recipes.js's payload -- with the same rate caveat: the mirror's rate is a COMPUTED
-- cost-per-unit at HQ prices, so it is seeded on create and left alone afterwards; the branch
-- recomputes it the next time that recipe is saved there.

ALTER TABLE public.categories ADD COLUMN IF NOT EXISTS master_id uuid;
ALTER TABLE public.items      ADD COLUMN IF NOT EXISTS master_id uuid;
ALTER TABLE public.recipes    ADD COLUMN IF NOT EXISTS master_id uuid;

-- A branch holds at most one copy of any given master record. Partial, because master_id is NULL
-- for every HQ record and for every record of every ungrouped client -- i.e. almost all of them.
CREATE UNIQUE INDEX IF NOT EXISTS categories_client_master_key ON public.categories (client_id, master_id) WHERE master_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS items_client_master_key      ON public.items      (client_id, master_id) WHERE master_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS recipes_client_master_key    ON public.recipes    (client_id, master_id) WHERE master_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.push_master_data(uuid[], text[], boolean);
CREATE FUNCTION public.push_master_data(
  p_target_client_ids uuid[],
  p_entities          text[],
  p_dry_run           boolean DEFAULT true
)
RETURNS TABLE (
  target_client_id   uuid,
  target_client_name text,
  entity             text,
  action             text,
  record_name        text,
  detail             text
)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'public'
  AS $fn$
DECLARE
  v_group  uuid;
  v_hq     uuid;
  v_target uuid;
  v_tname  text;
  v_do_cat boolean := 'categories' = ANY (p_entities);
  v_do_itm boolean := 'items'      = ANY (p_entities);
  v_do_rec boolean := 'recipes'    = ANY (p_entities);
  v_do_prc boolean := 'prices'     = ANY (p_entities);
  r        record;
  v_dst    uuid;
  v_item   uuid;
  v_cat    uuid;
  v_lines  integer;
  v_skipped integer;
BEGIN
  -- Same owner-altitude test as get_group_summary: this writes across tenant boundaries, which is
  -- the most privileged thing any non-admin action in this product does. COALESCE because both
  -- helpers return NULL rather than false for a caller with no profiles row (S579).
  IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
    RAISE EXCEPTION 'Not permitted: only an owner can push master data.';
  END IF;

  v_group := public.my_group_id();
  IF v_group IS NULL THEN
    RAISE EXCEPTION 'Not permitted: you are not part of an outlet group.';
  END IF;

  SELECT hq_client_id INTO v_hq FROM client_groups WHERE id = v_group;
  IF v_hq IS NULL THEN
    RAISE EXCEPTION 'This group has no HQ outlet set, so there is nothing to push from.';
  END IF;

  -- Every target must be in my group and must not be the HQ itself. Checked as a set so one bad
  -- id fails the whole call rather than being silently dropped (same rule as set_outlet_access).
  IF EXISTS (
    SELECT 1 FROM unnest(COALESCE(p_target_client_ids, ARRAY[]::uuid[])) AS t(id)
     WHERE t.id = v_hq
        OR t.id NOT IN (SELECT c.id FROM clients c WHERE c.group_id = v_group)
  ) THEN
    RAISE EXCEPTION 'Not permitted: one or more targets are not branches of your group.';
  END IF;

  CREATE TEMP TABLE _plan (
    target_client_id uuid, target_client_name text,
    entity text, action text, record_name text, detail text,
    src_id uuid, dst_id uuid
  ) ON COMMIT DROP;

  ----------------------------------------------------------------------------------------------
  -- PLAN. Pure SELECTs -- nothing below writes. The preview an operator approves IS this plan,
  -- so what they read and what applies cannot diverge into two implementations.
  ----------------------------------------------------------------------------------------------
  FOREACH v_target IN ARRAY COALESCE(p_target_client_ids, ARRAY[]::uuid[]) LOOP
    SELECT name INTO v_tname FROM clients WHERE id = v_target;

    IF v_do_cat THEN
      INSERT INTO _plan
      SELECT v_target, v_tname, 'categories',
             CASE WHEN d.id IS NOT NULL THEN 'update'
                  WHEN a.id IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             CASE WHEN a.id IS NOT NULL AND d.id IS NULL
                  THEN 'matched an existing category of the same name' END,
             s.id, COALESCE(d.id, a.id)
        FROM categories s
        LEFT JOIN categories d ON d.client_id = v_target AND d.master_id = s.id
        LEFT JOIN categories a ON a.client_id = v_target AND a.master_id IS NULL AND lower(a.name) = lower(s.name)
       WHERE s.client_id = v_hq;
    END IF;

    IF v_do_itm THEN
      -- is_sub_recipe rows are excluded: they are mirrors owned by the recipe machinery, created
      -- at the branch by the recipes pass below. Pushing them as ordinary items would race that.
      INSERT INTO _plan
      SELECT v_target, v_tname, 'items',
             CASE WHEN d.id IS NOT NULL THEN 'update'
                  WHEN a.id IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             CASE WHEN a.id IS NOT NULL AND d.id IS NULL THEN 'matched an existing item of the same name'
                  WHEN d.id IS NOT NULL THEN 'definition only - this branch keeps its own rate' END,
             s.id, COALESCE(d.id, a.id)
        FROM items s
        LEFT JOIN items d ON d.client_id = v_target AND d.master_id = s.id
        LEFT JOIN items a ON a.client_id = v_target AND a.master_id IS NULL
                         AND COALESCE(a.is_sub_recipe, false) = false AND lower(a.name) = lower(s.name)
       WHERE s.client_id = v_hq AND COALESCE(s.is_sub_recipe, false) = false;
    END IF;

    IF v_do_rec THEN
      -- recipe_code is uniquely indexed per client, so it is tried before name: adopting by name
      -- while a DIFFERENT branch recipe already holds the incoming code would fail the insert.
      INSERT INTO _plan
      SELECT v_target, v_tname, 'recipes',
             CASE WHEN d.id IS NOT NULL THEN 'update'
                  WHEN COALESCE(c.id, n.id) IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             CASE WHEN d.id IS NULL AND c.id IS NOT NULL THEN 'matched an existing recipe with the same code'
                  WHEN d.id IS NULL AND n.id IS NOT NULL THEN 'matched an existing recipe of the same name'
                  WHEN v_do_prc THEN 'selling price included'
                  ELSE 'selling price left as the branch has it' END,
             s.id, COALESCE(d.id, c.id, n.id)
        FROM recipes s
        LEFT JOIN recipes d ON d.client_id = v_target AND d.master_id = s.id
        LEFT JOIN recipes c ON c.client_id = v_target AND c.master_id IS NULL
                           AND s.recipe_code IS NOT NULL AND c.recipe_code = s.recipe_code
        LEFT JOIN recipes n ON n.client_id = v_target AND n.master_id IS NULL
                           AND lower(n.name) = lower(s.name)
       WHERE s.client_id = v_hq;
    END IF;
  END LOOP;

  IF p_dry_run THEN
    RETURN QUERY SELECT p.target_client_id, p.target_client_name, p.entity, p.action, p.record_name, p.detail
                   FROM _plan p ORDER BY p.target_client_name, p.entity, p.action, p.record_name;
    RETURN;
  END IF;

  ----------------------------------------------------------------------------------------------
  -- APPLY, strictly in dependency order: categories, then items (which reference a category),
  -- then recipes, then each recipe's ingredient list (which references both items and recipes).
  ----------------------------------------------------------------------------------------------
  FOR r IN SELECT * FROM _plan WHERE entity = 'categories' ORDER BY target_client_id LOOP
    IF r.dst_id IS NULL THEN
      INSERT INTO categories (client_id, name, sort_order, master_id)
      SELECT r.target_client_id, s.name, s.sort_order, s.id FROM categories s WHERE s.id = r.src_id;
    ELSE
      UPDATE categories d
         SET name = s.name, sort_order = s.sort_order, master_id = s.id
        FROM categories s WHERE s.id = r.src_id AND d.id = r.dst_id;
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM _plan WHERE entity = 'items' ORDER BY target_client_id LOOP
    -- The branch's own copy of the source item's category, if that category was ever pushed.
    SELECT d.id INTO v_cat
      FROM categories s JOIN categories d ON d.client_id = r.target_client_id AND d.master_id = s.id
     WHERE s.id = (SELECT category_id FROM items WHERE id = r.src_id);

    IF r.dst_id IS NULL THEN
      -- per_uom_rate is GENERATED and must never appear in an INSERT. purchase_qty carries a
      -- CHECK (= 1) since S597, so it is copied rather than derived.
      INSERT INTO items (client_id, master_id, category_id, name, uom, purchase_qty, rate,
                         is_active, purchase_unit, base_unit, conversion_factor, item_code,
                         yield_pct, is_sub_recipe, nutrition)
      SELECT r.target_client_id, s.id, v_cat, s.name, s.uom, s.purchase_qty, s.rate,
             s.is_active, s.purchase_unit, s.base_unit, s.conversion_factor, s.item_code,
             s.yield_pct, false, s.nutrition
        FROM items s WHERE s.id = r.src_id;
    ELSE
      -- rate is deliberately absent: see the header. This is the branch's own supplier price.
      UPDATE items d
         SET master_id = s.id, category_id = v_cat, name = s.name, uom = s.uom,
             purchase_qty = s.purchase_qty, is_active = s.is_active,
             purchase_unit = s.purchase_unit, base_unit = s.base_unit,
             conversion_factor = s.conversion_factor, item_code = s.item_code,
             yield_pct = s.yield_pct, nutrition = s.nutrition
        FROM items s WHERE s.id = r.src_id AND d.id = r.dst_id;
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM _plan WHERE entity = 'recipes' ORDER BY target_client_id LOOP
    IF r.dst_id IS NULL THEN
      INSERT INTO recipes (client_id, master_id, name, category, selling_price, vat_rate,
                           is_active, yield_qty, yield_uom, target_fc_pct, recipe_code,
                           pos_enabled, hsc_code)
      SELECT r.target_client_id, s.id, s.name, s.category, s.selling_price, s.vat_rate,
             s.is_active, s.yield_qty, s.yield_uom, s.target_fc_pct, s.recipe_code,
             s.pos_enabled, s.hsc_code
        FROM recipes s WHERE s.id = r.src_id
      RETURNING id INTO v_dst;
      UPDATE _plan SET dst_id = v_dst WHERE src_id = r.src_id AND target_client_id = r.target_client_id AND entity = 'recipes';
    ELSE
      -- selling_price only when 'prices' was asked for: a branch may legitimately price above or
      -- below HQ, so it is opt-in rather than swept along with the recipe definition.
      UPDATE recipes d
         SET master_id = s.id, name = s.name, category = s.category, vat_rate = s.vat_rate,
             is_active = s.is_active, yield_qty = s.yield_qty, yield_uom = s.yield_uom,
             target_fc_pct = s.target_fc_pct, recipe_code = s.recipe_code,
             pos_enabled = s.pos_enabled, hsc_code = s.hsc_code,
             selling_price = CASE WHEN v_do_prc THEN s.selling_price ELSE d.selling_price END
        FROM recipes s WHERE s.id = r.src_id AND d.id = r.dst_id;
      v_dst := r.dst_id;
    END IF;

    -- Sub-recipe mirror item, reproducing Recipes.js's own payload. Created if absent, linked
    -- either way; its rate is a cost computed at HQ prices, so it is seeded and then left alone.
    IF (SELECT category FROM recipes WHERE id = r.src_id) = 'Sub-Recipe' THEN
      IF (SELECT linked_item_id FROM recipes WHERE id = v_dst) IS NULL THEN
        SELECT id INTO v_cat FROM categories
         WHERE client_id = r.target_client_id AND lower(name) = 'sub-recipes' LIMIT 1;
        IF v_cat IS NULL THEN
          INSERT INTO categories (client_id, name, sort_order)
          VALUES (r.target_client_id, 'Sub-Recipes', 999) RETURNING id INTO v_cat;
        END IF;
        INSERT INTO items (client_id, category_id, name, uom, purchase_qty, rate, is_active,
                           is_sub_recipe, item_code)
        SELECT r.target_client_id, v_cat, upper(s.name), COALESCE(s.yield_uom, 'portion'), 1,
               COALESCE((SELECT i.rate FROM items i WHERE i.id = s.linked_item_id), 0),
               true, true, s.recipe_code
          FROM recipes s WHERE s.id = r.src_id
        RETURNING id INTO v_item;
        -- v_item, NOT v_dst: v_dst still holds the RECIPE id this mirror belongs to, and reusing
        -- one variable for both would link the recipe to itself.
        UPDATE recipes SET linked_item_id = v_item WHERE id = v_dst;
      END IF;
    END IF;
  END LOOP;

  -- Ingredients last, and replaced wholesale per recipe -- "HQ wins" applied to a list means the
  -- list, not a merge of two lists. An ingredient whose item or sub-recipe has no counterpart at
  -- the branch is REPORTED, never silently dropped: a recipe costed from an incomplete ingredient
  -- list is the silent-wrong-number shape this codebase keeps finding.
  IF v_do_rec THEN
    -- Materialised into its own table first: the loop body INSERTs 'ingredients' rows into _plan,
    -- and mutating the relation a FOR cursor is reading is the kind of thing that works until the
    -- planner picks a different scan.
    CREATE TEMP TABLE _rec_todo ON COMMIT DROP AS
      SELECT * FROM _plan WHERE entity = 'recipes' AND dst_id IS NOT NULL;
    FOR r IN SELECT * FROM _rec_todo ORDER BY target_client_id LOOP
      SELECT count(*) INTO v_skipped
        FROM recipe_ingredients ri
        LEFT JOIN items di ON di.client_id = r.target_client_id AND di.master_id = ri.item_id
        LEFT JOIN recipes dr ON dr.client_id = r.target_client_id AND dr.master_id = ri.sub_recipe_id
       WHERE ri.recipe_id = r.src_id
         AND ((ri.item_id IS NOT NULL AND di.id IS NULL) OR (ri.sub_recipe_id IS NOT NULL AND dr.id IS NULL));

      DELETE FROM recipe_ingredients WHERE recipe_id = r.dst_id;

      INSERT INTO recipe_ingredients (recipe_id, item_id, sub_recipe_id, qty_per_portion)
      SELECT r.dst_id, di.id, dr.id, ri.qty_per_portion
        FROM recipe_ingredients ri
        LEFT JOIN items di ON di.client_id = r.target_client_id AND di.master_id = ri.item_id
        LEFT JOIN recipes dr ON dr.client_id = r.target_client_id AND dr.master_id = ri.sub_recipe_id
       WHERE ri.recipe_id = r.src_id
         AND ((ri.item_id IS NOT NULL AND di.id IS NOT NULL) OR (ri.sub_recipe_id IS NOT NULL AND dr.id IS NOT NULL));

      GET DIAGNOSTICS v_lines = ROW_COUNT;
      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail)
      VALUES (r.target_client_id, r.target_client_name, 'ingredients',
              CASE WHEN v_skipped > 0 THEN 'partial' ELSE 'replaced' END, r.record_name,
              v_lines || ' line(s) written'
                || CASE WHEN v_skipped > 0
                        THEN ', ' || v_skipped || ' skipped - ingredient not present at this branch'
                        ELSE '' END);
    END LOOP;
  END IF;

  RETURN QUERY SELECT p.target_client_id, p.target_client_name, p.entity, p.action, p.record_name, p.detail
                 FROM _plan p ORDER BY p.target_client_name, p.entity, p.action, p.record_name;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.push_master_data(uuid[], text[], boolean) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.push_master_data(uuid[], text[], boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- Verification ---------------------------------------------------------------------------------
--   SELECT has_function_privilege('anon','public.push_master_data(uuid[],text[],boolean)','EXECUTE');  -- false
--   SELECT indexname FROM pg_indexes WHERE indexname LIKE '%_client_master_key';   -- 3 rows
--
-- Always dry-run first; the plan it returns is exactly what the write pass applies. Verify on a
-- throwaway branch client before any real one, and check three things afterwards:
--   1. no duplicated item master  -> SELECT name, count(*) FROM items WHERE client_id = <branch>
--                                     AND NOT is_sub_recipe GROUP BY name HAVING count(*) > 1;
--   2. the branch kept its rates  -> compare items.rate at branch vs HQ for an adopted item
--   3. no orphaned ingredients    -> the 'partial' rows in the result name every skipped line
