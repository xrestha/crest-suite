-- S792 — IMS re-analysis, stage 3 (the hygiene sweep): four database fixes.
--
-- 1. push_master_data copies a dish's price and VAT rate between outlets whose VAT status differs
--    (S792.4 leftover, found while building D31). The till bills `selling_price` plus VAT on a
--    VAT-registered outlet and `selling_price` exactly on a PAN-bill outlet (menuPriceVat.js), so the
--    same stored number is a different guest price on each side. Worse, the push has always copied
--    `vat_rate`, and a PAN-bill HQ stores 0 there (D31): the first push to a VAT-registered branch
--    would have put 0%-VAT dishes on its till. Found live on BLOOM CAFE (dummy accounts; PKR was
--    VAT-registered by mistake and switched to PAN on 2026-09-28, so nothing was ever pushed wrong).
--    Now, for a branch whose VAT status differs from HQ's: an EXISTING dish keeps the branch's own
--    price and VAT rate; a NEW dish arrives off the till (pos_enabled false) with no price and the
--    branch's VAT rate, so it can never bill a wrong amount or NPR 0; the push result says why on
--    every such dish. Sub-recipes are exempt (never sold). Same-status pushes are unchanged.
--    The dry run of this file also found that NO real push had ever completed: the apply loops'
--    bare column names collide with the RETURNS TABLE columns (42702). `#variable_conflict
--    use_column` fixes it; the preview path was unaffected, which is why it went unnoticed.
-- 2. RECIPES-7: nothing in the database refused a sub-recipe cycle. The page checks its in-memory
--    recipe book, so two tabs could save Sauce A inside Sauce B and B inside A; costing then read the
--    back-edge as 0 and the stock walk recursed to depth 12 multiplying quantities. A BEFORE trigger
--    on recipe_ingredients now walks sub_recipe_id and refuses the line (hint recipe_cycle).
-- 3. DATABASE-9: closing_stock.counted_by / counted_by_name are whatever the browser sends, so a
--    staff counter could save a count as unclaimed (NULL, which the recount guard lets anyone
--    overwrite) or under an invented name. The browser value is kept on purpose — offline counts
--    replay under whoever is signed in on the tablet, so it may rightly name another counter — but
--    for a login below IMS supervisor (count PINs included) it must now name an IMS login of this
--    outlet, or it becomes the signed-in login; NULL becomes the signed-in login; and the name is
--    always read from that login's profile. Supervisor, manager, Owner and admin are unchanged
--    (they replay other people's held counts, D38).
-- 4. DATABASE-11: a row could reference another client's item (only pos_option_ingredients
--    checked). It needs a foreign item UUID, and its effect is that the victim's item delete is
--    refused — but it is a tenancy breach all the same. One trigger function, told how each table
--    reaches its client, refuses an item (or, on recipe_ingredients, a sub-recipe) of another client
--    (hint item_other_client).
--
-- The three new trigger functions are SECURITY DEFINER: each must read rows the caller's RLS may
-- hide (another profile's name, another client's item, a whole recipe tree), and a guard whose read
-- is narrower than the write passes vacuously (supabase-sql.md, S707/S749). None is callable (a
-- trigger function needs no EXECUTE), and each REVOKEs PUBLIC anyway.
--
-- push_master_data was read live on 2026-09-28; the body below is that body plus the VAT change and
-- nothing else. Block 0 refuses to run if the live body has changed since.
--
-- Reverse: restore push_master_data from 20260928140000_ims_integrity_s792.sql, and DROP the
-- triggers recipe_ingredients_guard_cycle, closing_stock_stamp_counter and every
-- ims_item_same_client trigger created in block 4, then DROP the three functions.


-- ══ 0. The live body this was written against ════════════════════════════════════════════════════

DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'push_master_data';
  IF v_md5 IS DISTINCT FROM '20f90360cc245355ee627eb2ffd67e1c' THEN
    RAISE EXCEPTION 'S792: push_master_data changed since this migration was written (live md5 %) — rebuild it from the live body', v_md5;
  END IF;
END;
$$;


-- ══ 1. push_master_data: price and VAT follow the branch's own VAT status ═════════════════════════

CREATE OR REPLACE FUNCTION public.push_master_data(p_target_client_ids uuid[], p_entities text[], p_dry_run boolean DEFAULT true)
 RETURNS TABLE(target_client_id uuid, target_client_name text, entity text, action text, record_name text, detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- The apply loops read _plan by bare column names (entity, action, target_client_id) that are also
-- this function's RETURNS TABLE columns, so every non-dry-run push raised 42702 "column reference
-- is ambiguous" — since 20260827150000; only the preview ever ran. Every such name means the
-- column: the OUT columns are only ever filled by RETURN QUERY (S792 stage 3 dry run).
#variable_conflict use_column
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
  -- The sub-recipe mirror's name, and the branch item already holding it (S707).
  v_mname    text;
  v_conflict text;
  -- Whether HQ and this branch bill VAT (S792 stage 3). The till reads a missing or NULL flag as
  -- VAT-registered (menuPriceVat.js vatModeOf), so this does too.
  v_hq_vat      boolean;
  v_t_vat       boolean;
  v_vat_differs boolean;
  v_vat_why     text;
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

  v_hq_vat := COALESCE((SELECT s.is_vat_registered FROM settings s WHERE s.client_id = v_hq), true);
  v_vat_why := CASE WHEN v_hq_vat
                    THEN 'HQ adds VAT to its menu prices and this branch issues PAN bills without VAT'
                    ELSE 'HQ issues PAN bills without VAT and this branch adds VAT to its menu prices' END;

  -- vat_differs (S792 stage 3) is set on recipe rows only: whether this dish's price and VAT rate
  -- must stay the branch's own. The other entities leave it NULL.
  CREATE TEMP TABLE _plan (
    target_client_id uuid, target_client_name text,
    entity text, action text, record_name text, detail text,
    src_id uuid, dst_id uuid, vat_differs boolean
  ) ON COMMIT DROP;

  ----------------------------------------------------------------------------------------------
  -- PLAN. Pure SELECTs -- nothing below writes. The preview an operator approves IS this plan,
  -- so what they read and what applies cannot diverge into two implementations.
  ----------------------------------------------------------------------------------------------
  FOREACH v_target IN ARRAY COALESCE(p_target_client_ids, ARRAY[]::uuid[]) LOOP
    SELECT name INTO v_tname FROM clients WHERE id = v_target;
    v_t_vat := COALESCE((SELECT s.is_vat_registered FROM settings s WHERE s.client_id = v_target), true);
    v_vat_differs := v_t_vat IS DISTINCT FROM v_hq_vat;

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
      -- `x` is any OTHER branch row already holding this name -- neither the master-linked row we
      -- would update nor the unlinked row we would adopt. Its existence means writing s.name into
      -- this branch violates items_client_name_key, so the row is planned as 'conflict' and the
      -- apply pass below skips it. LATERAL rather than a fourth LEFT JOIN because the predicate
      -- has to reference d.id and a.id, which a plain join cannot.
      -- `u` (S792) is the branch row we would update or adopt when its unit differs from HQ's and
      -- it has recorded history: writing HQ's unit would re-read that history (D5), so it too is a
      -- 'conflict'.
      INSERT INTO _plan
      SELECT v_target, v_tname, 'items',
             CASE WHEN x.id IS NOT NULL THEN 'conflict'
                  WHEN u.uom IS NOT NULL THEN 'conflict'
                  WHEN d.id IS NOT NULL THEN 'update'
                  WHEN a.id IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             CASE WHEN x.id IS NOT NULL
                    THEN 'skipped - this branch already has a different ' ||
                         CASE WHEN COALESCE(x.is_sub_recipe, false) THEN 'sub-recipe' ELSE 'item' END ||
                         ' called "' || x.name || '". Rename one of them, then push again.'
                  WHEN u.uom IS NOT NULL
                    THEN 'skipped - this branch records it in ' || u.uom || ' and HQ uses ' || COALESCE(s.uom, 'no unit') ||
                         '. Changing the unit would re-read every count and bill already recorded at this branch. ' ||
                         'Keep the branch item as it is, or create a separate item for the new unit.'
                  WHEN a.id IS NOT NULL AND d.id IS NULL THEN 'matched an existing item of the same name'
                  WHEN d.id IS NOT NULL THEN 'definition only - this branch keeps its own rate' END,
             s.id, COALESCE(d.id, a.id)
        FROM items s
        LEFT JOIN items d ON d.client_id = v_target AND d.master_id = s.id
        LEFT JOIN items a ON a.client_id = v_target AND a.master_id IS NULL
                         AND COALESCE(a.is_sub_recipe, false) = false AND lower(a.name) = lower(s.name)
        LEFT JOIN LATERAL (
          SELECT c.id, c.name, c.is_sub_recipe
            FROM items c
           WHERE c.client_id = v_target
             AND lower(c.name) = lower(s.name)
             AND (d.id IS NULL OR c.id <> d.id)
             AND (a.id IS NULL OR c.id <> a.id)
           LIMIT 1
        ) x ON true
        LEFT JOIN LATERAL (
          SELECT b.uom
            FROM items b
           WHERE b.id = COALESCE(d.id, a.id)
             AND b.uom IS DISTINCT FROM s.uom
             AND public.item_has_references(b.id)
        ) u ON true
       WHERE s.client_id = v_hq AND COALESCE(s.is_sub_recipe, false) = false;
    END IF;

    IF v_do_rec THEN
      -- recipe_code is uniquely indexed per client, so it is tried before name: adopting by name
      -- while a DIFFERENT branch recipe already holds the incoming code would fail the insert.
      -- A branch whose VAT status differs from HQ's (S792 stage 3) keeps its own price and VAT
      -- rate on every dish it already has, and gets new dishes off the till with no price: HQ's
      -- stored price is a different guest price there. A sub-recipe is never sold, so it is exempt.
      INSERT INTO _plan
      SELECT v_target, v_tname, 'recipes',
             CASE WHEN d.id IS NOT NULL THEN 'update'
                  WHEN COALESCE(c.id, n.id) IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             concat_ws('; ',
               CASE WHEN d.id IS NULL AND c.id IS NOT NULL THEN 'matched an existing recipe with the same code'
                    WHEN d.id IS NULL AND n.id IS NOT NULL THEN 'matched an existing recipe of the same name'
                    WHEN v_vat_differs AND s.category IS DISTINCT FROM 'Sub-Recipe' THEN NULL
                    WHEN v_do_prc THEN 'selling price included'
                    ELSE 'selling price left as the branch has it' END,
               CASE WHEN NOT v_vat_differs OR s.category IS NOT DISTINCT FROM 'Sub-Recipe' THEN NULL
                    WHEN COALESCE(d.id, c.id, n.id) IS NULL
                      THEN 'added OFF the till with no price: ' || v_vat_why ||
                           ', so HQ''s price would charge guests a different amount here. Set its price at this branch, then switch it On POS'
                    ELSE 'price and VAT rate left as this branch has them: ' || v_vat_why ||
                         ', so HQ''s price would charge guests a different amount here' END),
             s.id, COALESCE(d.id, c.id, n.id),
             v_vat_differs AND s.category IS DISTINCT FROM 'Sub-Recipe'
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

  -- `action <> 'conflict'`: a planned conflict is REPORTED, never written. It stays in _plan so
  -- the operator reads it in the returned rows exactly as the dry run showed it.
  FOR r IN SELECT * FROM _plan WHERE entity = 'items' AND action <> 'conflict' ORDER BY target_client_id LOOP
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
      -- is_active too (S792): whether the branch still stocks an item is the branch's own fact.
      UPDATE items d
         SET master_id = s.id, category_id = v_cat, name = s.name, uom = s.uom,
             purchase_qty = s.purchase_qty,
             purchase_unit = s.purchase_unit, base_unit = s.base_unit,
             conversion_factor = s.conversion_factor, item_code = s.item_code,
             yield_pct = s.yield_pct, nutrition = s.nutrition
        FROM items s WHERE s.id = r.src_id AND d.id = r.dst_id;
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM _plan WHERE entity = 'recipes' ORDER BY target_client_id LOOP
    IF r.dst_id IS NULL THEN
      -- A branch whose VAT status differs (S792 stage 3): no price, the BRANCH's VAT rate (PAN
      -- stores 0, D31; VAT-registered takes the column default 0.13), and off the till until the
      -- owner prices it there — the till bills a NULL price as NPR 0.
      INSERT INTO recipes (client_id, master_id, name, category, selling_price, vat_rate,
                           is_active, yield_qty, yield_uom, target_fc_pct, recipe_code,
                           pos_enabled, hsc_code)
      SELECT r.target_client_id, s.id, s.name, s.category,
             CASE WHEN COALESCE(r.vat_differs, false) THEN NULL ELSE s.selling_price END,
             CASE WHEN COALESCE(r.vat_differs, false) THEN CASE WHEN v_hq_vat THEN 0 ELSE 0.13 END
                  ELSE s.vat_rate END,
             s.is_active, s.yield_qty, s.yield_uom, s.target_fc_pct, s.recipe_code,
             CASE WHEN COALESCE(r.vat_differs, false) THEN false ELSE s.pos_enabled END,
             s.hsc_code
        FROM recipes s WHERE s.id = r.src_id
      RETURNING id INTO v_dst;
      UPDATE _plan SET dst_id = v_dst WHERE src_id = r.src_id AND target_client_id = r.target_client_id AND entity = 'recipes';
    ELSE
      -- selling_price only when 'prices' was asked for: a branch may legitimately price above or
      -- below HQ, so it is opt-in rather than swept along with the recipe definition. Neither it
      -- nor vat_rate is written on a branch whose VAT status differs (S792 stage 3).
      UPDATE recipes d
         SET master_id = s.id, name = s.name, category = s.category,
             vat_rate = CASE WHEN COALESCE(r.vat_differs, false) THEN d.vat_rate ELSE s.vat_rate END,
             is_active = s.is_active, yield_qty = s.yield_qty, yield_uom = s.yield_uom,
             target_fc_pct = s.target_fc_pct, recipe_code = s.recipe_code,
             pos_enabled = s.pos_enabled, hsc_code = s.hsc_code,
             selling_price = CASE WHEN v_do_prc AND NOT COALESCE(r.vat_differs, false)
                                  THEN s.selling_price ELSE d.selling_price END
        FROM recipes s WHERE s.id = r.src_id AND d.id = r.dst_id;
      v_dst := r.dst_id;
    END IF;

    -- Sub-recipe mirror item, reproducing Recipes.js's own payload. Created if absent, linked
    -- either way; its rate is a cost computed at HQ prices, so it is seeded and then left alone.
    IF (SELECT category FROM recipes WHERE id = r.src_id) = 'Sub-Recipe' THEN
      IF (SELECT linked_item_id FROM recipes WHERE id = v_dst) IS NULL THEN
        -- The mirror is an `items` row like any other, so items_client_name_key applies to it and
        -- this INSERT is the third way the push could raise 23505. Checked rather than caught: a
        -- reported conflict leaves the rest of the push intact, and the ingredient lines that
        -- needed this mirror are then skipped and counted by the 'partial' machinery below, which
        -- is already the honest answer for an ingredient with no counterpart at the branch.
        SELECT upper(s.name) INTO v_mname FROM recipes s WHERE s.id = r.src_id;
        SELECT c.name INTO v_conflict
          FROM items c
         WHERE c.client_id = r.target_client_id AND lower(c.name) = lower(v_mname)
         LIMIT 1;

        IF v_conflict IS NOT NULL THEN
          INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail)
          VALUES (r.target_client_id, r.target_client_name, 'sub-recipe item', 'conflict', v_mname,
                  'skipped - this branch already has an item called "' || v_conflict ||
                  '", so the stock-counted mirror for this sub-recipe was not created and any '
                  || 'recipe line using it is skipped too. Rename one of them, then push again.');
        ELSE
          SELECT id INTO v_cat FROM categories
           WHERE client_id = r.target_client_id AND lower(name) = 'sub-recipes' LIMIT 1;
          IF v_cat IS NULL THEN
            INSERT INTO categories (client_id, name, sort_order)
            VALUES (r.target_client_id, 'Sub-Recipes', 999) RETURNING id INTO v_cat;
          END IF;
          INSERT INTO items (client_id, category_id, name, uom, purchase_qty, rate, is_active,
                             is_sub_recipe, item_code)
          SELECT r.target_client_id, v_cat, v_mname, COALESCE(s.yield_uom, 'portion'), 1,
                 COALESCE((SELECT i.rate FROM items i WHERE i.id = s.linked_item_id), 0),
                 true, true, s.recipe_code
            FROM recipes s WHERE s.id = r.src_id
          RETURNING id INTO v_item;
          -- v_item, NOT v_dst: v_dst still holds the RECIPE id this mirror belongs to, and reusing
          -- one variable for both would link the recipe to itself.
          UPDATE recipes SET linked_item_id = v_item WHERE id = v_dst;
        END IF;
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
$function$;


-- ══ 2. RECIPES-7: a sub-recipe cycle is refused ══════════════════════════════════════════════════
-- Nesting is recipe_ingredients.sub_recipe_id only (explodeRecipeTree, calcSubRecipeCostPerUnit and
-- the page's wouldCreateCycle all walk that column). Adding a line recipe R → sub-recipe S closes a
-- cycle exactly when R is already reachable from S. The walk is capped at 32 levels: real trees are
-- a few deep, and the stock walk itself gives up at 12. It runs for every caller, the service role
-- and push_master_data included — a cycle is wrong whoever writes it.

CREATE OR REPLACE FUNCTION public.recipe_ingredients_guard_cycle()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cycle boolean;
BEGIN
  IF NEW.sub_recipe_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.sub_recipe_id = NEW.recipe_id THEN
    v_cycle := true;
  ELSE
    WITH RECURSIVE walk(id, depth) AS (
      SELECT NEW.sub_recipe_id, 1
      UNION
      SELECT ri.sub_recipe_id, w.depth + 1
        FROM recipe_ingredients ri
        JOIN walk w ON ri.recipe_id = w.id
       WHERE ri.sub_recipe_id IS NOT NULL
         AND w.depth < 32
    )
    SELECT EXISTS (SELECT 1 FROM walk WHERE id = NEW.recipe_id) INTO v_cycle;
  END IF;

  IF v_cycle THEN
    -- Named so errorText.js can say which dish contains which (S619); the hint is the stable code.
    RAISE EXCEPTION 'recipe_cycle: % already contains %',
      COALESCE((SELECT name FROM recipes WHERE id = NEW.sub_recipe_id), 'that sub-recipe'),
      COALESCE((SELECT name FROM recipes WHERE id = NEW.recipe_id), 'this recipe')
      USING ERRCODE = '23514', HINT = 'recipe_cycle';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.recipe_ingredients_guard_cycle() FROM PUBLIC;

DROP TRIGGER IF EXISTS recipe_ingredients_guard_cycle ON public.recipe_ingredients;
CREATE TRIGGER recipe_ingredients_guard_cycle
  BEFORE INSERT OR UPDATE OF recipe_id, sub_recipe_id ON public.recipe_ingredients
  FOR EACH ROW EXECUTE FUNCTION public.recipe_ingredients_guard_cycle();


-- ══ 3. DATABASE-9: who counted is an IMS login of this outlet ═════════════════════════════════════
-- Below IMS supervisor (and every count PIN, which ims_caller_has_rank refuses at every rank):
--   * counted_by NULL → the signed-in login. A NULL row is "unclaimed", which the recount guard
--     lets any staff counter overwrite.
--   * counted_by naming anything but an IMS login of this outlet → the signed-in login.
--   * counted_by_name → that login's own name, never the browser's text.
-- Another IMS login of this outlet is accepted as sent: a tablet replays counts queued offline under
-- whoever is signed in when the connection returns (Stock.js flushQueueOnce), and those still carry
-- the person who counted them. auth.uid() IS NULL is the service role (restore, Danger Zone), which
-- passes: this is a DEFINER body, so the current_user seam other guards use would always read owner.

CREATE OR REPLACE FUNCTION public.closing_stock_stamp_counter()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := (select auth.uid());
  v_client uuid;
  v_name   text;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(public.ims_caller_has_rank('supervisor'), false) THEN RETURN NEW; END IF;

  SELECT mp.client_id INTO v_client FROM monthly_periods mp WHERE mp.id = NEW.period_id;

  IF NEW.counted_by IS NULL
     OR (NEW.counted_by <> v_uid AND NOT COALESCE(EXISTS (
           SELECT 1 FROM profiles p
            WHERE p.id = NEW.counted_by
              AND p.client_id = v_client
              AND (p.ims_role IS NOT NULL OR p.ims_email IS NOT NULL)), false)) THEN
    NEW.counted_by := v_uid;
  END IF;

  SELECT p.full_name INTO v_name FROM profiles p WHERE p.id = NEW.counted_by;
  NEW.counted_by_name := COALESCE(v_name, NEW.counted_by_name);
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.closing_stock_stamp_counter() FROM PUBLIC;

-- Named after closing_stock_recount_guard so it fires second (BEFORE triggers run by name): the
-- recount guard judges OLD.counted_by, which this never touches.
DROP TRIGGER IF EXISTS closing_stock_stamp_counter ON public.closing_stock;
CREATE TRIGGER closing_stock_stamp_counter
  BEFORE INSERT OR UPDATE OF physical_qty, counted_by, counted_by_name ON public.closing_stock
  FOR EACH ROW EXECUTE FUNCTION public.closing_stock_stamp_counter();


-- ══ 4. DATABASE-11: an item belongs to the row's own client ══════════════════════════════════════
-- TG_ARGV[0] says how the table reaches its client: 'period' (period_id → monthly_periods), 'po'
-- (po_id → purchase_orders), 'recipe' (recipe_id → recipes; sub_recipe_id is checked too),
-- 'requisition' (requisition_id → requisitions) or 'client' (its own client_id). A NULL item, or a
-- parent that cannot be found (the FK then refuses the row itself), is left to the constraints.
-- pos_option_ingredients already carries its own check and is not listed.

CREATE OR REPLACE FUNCTION public.ims_item_same_client()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid;
  v_other boolean := false;
BEGIN
  CASE TG_ARGV[0]
    WHEN 'period'      THEN SELECT client_id INTO v_owner FROM monthly_periods WHERE id = NEW.period_id;
    WHEN 'po'          THEN SELECT client_id INTO v_owner FROM purchase_orders WHERE id = NEW.po_id;
    WHEN 'recipe'      THEN SELECT client_id INTO v_owner FROM recipes         WHERE id = NEW.recipe_id;
    WHEN 'requisition' THEN SELECT client_id INTO v_owner FROM requisitions    WHERE id = NEW.requisition_id;
    WHEN 'client'      THEN v_owner := NEW.client_id;
    ELSE RAISE EXCEPTION 'ims_item_same_client: unknown parent kind %', TG_ARGV[0];
  END CASE;
  IF v_owner IS NULL THEN RETURN NEW; END IF;

  IF NEW.item_id IS NOT NULL THEN
    v_other := COALESCE((SELECT i.client_id <> v_owner FROM items i WHERE i.id = NEW.item_id), false);
  END IF;
  -- Nested, never one AND: plpgsql resolves every NEW field an expression names before evaluating
  -- it, so `kind = 'recipe' AND NEW.sub_recipe_id …` raises 42703 on the ten tables without that
  -- column (the dry run caught it).
  IF NOT v_other AND TG_ARGV[0] = 'recipe' THEN
    IF NEW.sub_recipe_id IS NOT NULL THEN
      v_other := COALESCE((SELECT s.client_id <> v_owner FROM recipes s WHERE s.id = NEW.sub_recipe_id), false);
    END IF;
  END IF;

  IF v_other THEN
    RAISE EXCEPTION 'item_other_client: that item belongs to another business'
      USING ERRCODE = '23503', HINT = 'item_other_client';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.ims_item_same_client() FROM PUBLIC;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('closing_stock',        'period',      'item_id, period_id'),
    ('opening_stock',        'period',      'item_id, period_id'),
    ('purchase_entries',     'period',      'item_id, period_id'),
    ('staff_meals',          'period',      'item_id, period_id'),
    ('wastages',             'period',      'item_id, period_id'),
    ('purchase_order_items', 'po',          'item_id, po_id'),
    ('recipe_ingredients',   'recipe',      'item_id, sub_recipe_id, recipe_id'),
    ('requisition_lines',    'requisition', 'item_id, requisition_id'),
    ('par_levels',           'client',      'item_id, client_id'),
    ('stock_movements',      'client',      'item_id, client_id'),
    ('vendor_returns',       'client',      'item_id, client_id')
  ) AS v(tbl, kind, cols) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS ims_item_same_client ON public.%I', t.tbl);
    EXECUTE format(
      'CREATE TRIGGER ims_item_same_client BEFORE INSERT OR UPDATE OF %s ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.ims_item_same_client(%L)', t.cols, t.tbl, t.kind);
  END LOOP;
END;
$$;


-- ══ 5. D35: the till's first bill of a period, for the IMS logins that cannot read the till ═══════
-- Sales Entry keeps a POS client's pre-till days open to hand entry (D35), and the till's first
-- day is the earlier of what IMS holds and the till's own first bill — so a bill not yet posted to
-- IMS (an unsynced till, a hand-off awaiting the Periods backfill) does not leave its day looking
-- pre-till. pos_orders carries the restrictive no_ims_staff policy, so an IMS supervisor or staff
-- login — the people who use Sales Entry — reads it as empty with no error. This returns the one
-- timestamp and nothing else: the earliest paid or Complimentary bill carrying a dish, in the
-- window given. Same filters as the direct read it replaces (Sales.js readFirstTillBill).

CREATE OR REPLACE FUNCTION public.ims_first_till_bill_at(p_client_id uuid, p_from timestamptz, p_to timestamptz)
 RETURNS timestamptz
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- ims_caller_has_rank covers admin and the Owner, and refuses a count PIN (which never opens
  -- Sales Entry). COALESCE'd as a whole: my_client_id() is NULL for a caller with no profile.
  IF NOT COALESCE(public.is_admin()
                  OR (p_client_id = public.my_client_id() AND public.ims_caller_has_rank('staff')), false) THEN
    RAISE EXCEPTION 'Not permitted: this login cannot read that client''s till bills.' USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT min(o.closed_at)
      FROM pos_orders o
     WHERE o.client_id = p_client_id
       AND o.status = 'billed'
       AND o.close_type IN ('paid', 'writeoff')
       AND o.closed_at >= p_from
       AND o.closed_at <= p_to
       AND EXISTS (SELECT 1 FROM pos_order_items i WHERE i.order_id = o.id AND i.recipe_id IS NOT NULL)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ims_first_till_bill_at(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ims_first_till_bill_at(uuid, timestamptz, timestamptz) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';


-- ══ 6. Assertions ═════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(x.tbl, ', ') INTO v_missing
    FROM unnest(ARRAY['closing_stock','opening_stock','purchase_entries','staff_meals','wastages',
                      'purchase_order_items','recipe_ingredients','requisition_lines','par_levels',
                      'stock_movements','vendor_returns']) AS x(tbl)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger tg
                      WHERE tg.tgrelid = ('public.' || x.tbl)::regclass
                        AND tg.tgname = 'ims_item_same_client' AND NOT tg.tgisinternal);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'S792: ims_item_same_client trigger missing on %', v_missing;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.recipe_ingredients'::regclass
                  AND tgname = 'recipe_ingredients_guard_cycle') THEN
    RAISE EXCEPTION 'S792: recipe cycle guard missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.closing_stock'::regclass
                  AND tgname = 'closing_stock_stamp_counter') THEN
    RAISE EXCEPTION 'S792: closing_stock counter stamp missing';
  END IF;

  -- A trigger function holds no EXECUTE for a client role.
  IF has_function_privilege('authenticated', 'public.ims_item_same_client()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.recipe_ingredients_guard_cycle()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.closing_stock_stamp_counter()', 'EXECUTE') THEN
    RAISE EXCEPTION 'S792: a stage-3 trigger function is executable by a client role';
  END IF;

  -- push_master_data kept its grants (CREATE OR REPLACE does) and its signature.
  IF NOT has_function_privilege('authenticated', 'public.push_master_data(uuid[], text[], boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S792: push_master_data lost its EXECUTE grant';
  END IF;
  IF has_function_privilege('anon', 'public.push_master_data(uuid[], text[], boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S792: push_master_data is executable by anon';
  END IF;

  IF has_function_privilege('anon', 'public.ims_first_till_bill_at(uuid, timestamptz, timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.ims_first_till_bill_at(uuid, timestamptz, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S792: ims_first_till_bill_at grants are wrong';
  END IF;
END;
$$;
