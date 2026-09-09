-- S707 (1 of 2) — `items` gets the per-client name uniqueness it never had.
--
-- S706 added a duplicate-name check to the Item Master save dialog. It is a CLIENT-SIDE check
-- against an array held in React state, which makes it a courtesy, not a constraint:
--
--   * Two tabs (or two devices) both pass it and both insert.
--   * The array is seeded from the 10-minute session cache before the fresh read lands, so even
--     one tab can validate against a stale book.
--   * `loadItems` filters `.eq('is_sub_recipe', false)`, so the array does not contain sub-recipe
--     mirror rows AT ALL — and Stock Count deliberately does not filter them either, so a real
--     item and a mirror sharing a name are two rows in the same count, which is the exact
--     split-the-ingredient harm the check exists to prevent, reached by the one route it cannot
--     see.
--   * Three of the four write paths into `items` never run the check: the sub-recipe mirror in
--     Recipes.js, `push_master_data`, and the Export/Import restore.
--
-- A duplicate item name is not cosmetic. Purchases, stock counts and recipe lines attach to
-- whichever row the operator happened to pick, so one ingredient's spend and stock split silently
-- across two master rows that every report treats as two ingredients — and nothing on any screen
-- says so.
--
-- ── The three choices this index makes, all of them deliberate ──────────────────────────────
--
-- 1. CASE-INSENSITIVE, via `lower(name)`. Items.js and Recipes.js both store `.toUpperCase()`,
--    but `push_master_data` copies HQ's name verbatim and legacy rows predate either rule. The
--    push's own adoption match is already `lower(a.name) = lower(s.name)`, so a case-sensitive
--    index would be uniqueness the push does not agree with.
--
-- 2. IT COVERS SUB-RECIPE MIRRORS. They are stock-counted alongside real items, so "one name, one
--    row" has to mean the whole table or it does not mean anything where it matters. The cost is
--    real and is accepted: the mirror's name is re-derived from the recipe on every recipe save,
--    so a mirror the dedupe below renamed will fail its next save until someone resolves the
--    clash. Recipes.js now says exactly that, in those words, instead of surfacing a raw 23505.
--
-- 3. IT COVERS HIDDEN ITEMS. `is_active = false` is what every delete refusal in Item Master
--    offers as the alternative, so hidden rows accumulate by design — and they still carry the
--    history the name refers to. Freeing the name for reuse would let a new row inherit an old
--    row's identity in every report that joins on name rather than id.
--
-- `item_code` is deliberately left WITHOUT a unique index. It has the same client-side-max root
-- cause, but nothing keys off it — a collision is a display annoyance, not a split ingredient —
-- and pushing HQ's codes into a branch that already minted its own would turn every such push
-- into an abort. Items.js instead mints from a fresh, unfiltered read of every code (S707).
--
-- `recipes` is also left alone. The CLAUDE.md note pairs items and recipes, but a recipe name is
-- not a stock identity: nothing counts, purchases or values a recipe, and the POS menu and Menu
-- Pricing both key off ids. Its `recipe_code` already carries a per-client unique index (S404).

-- ── (a) Dedupe first — rename, never drop ───────────────────────────────────────────────────
--
-- Same shape as 20260713065232 (po_number / recipe_code), with two differences that matter here.
--
-- ORDER: `is_sub_recipe` first, so a REAL item always keeps the plain name and a mirror is the row
-- that gets suffixed. The alternative — oldest wins regardless — hands the name to a mirror
-- roughly half the time, and a mirror holding the name is the case that then fails its recipe's
-- next save. This way the failure lands on the row whose name is re-derived, which is the row a
-- user can fix by renaming the recipe.
--
-- LOOPED: appending '-DUP2' can itself collide with a real row already called that. One pass and
-- then `CREATE UNIQUE INDEX` would fail the migration on data nobody could see beforehand, so it
-- repeats until clean and asserts the result before the index is attempted.
DO $$
DECLARE
  v_pass    integer := 0;
  v_renamed integer;
  v_left    integer;
BEGIN
  LOOP
    v_pass := v_pass + 1;
    WITH ranked AS (
      SELECT id,
             row_number() OVER (PARTITION BY client_id, lower(name)
                                ORDER BY COALESCE(is_sub_recipe, false), created_at, id) AS rn
        FROM public.items
    )
    UPDATE public.items i
       SET name = i.name || '-DUP' || r.rn
      FROM ranked r
     WHERE i.id = r.id AND r.rn > 1;
    GET DIAGNOSTICS v_renamed = ROW_COUNT;

    RAISE NOTICE 'items dedupe pass %: % row(s) renamed', v_pass, v_renamed;
    EXIT WHEN v_renamed = 0;

    IF v_pass >= 5 THEN
      RAISE EXCEPTION 'items dedupe did not converge after % passes — resolve the remaining duplicate names by hand before re-running', v_pass;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_left FROM (
    SELECT 1 FROM public.items GROUP BY client_id, lower(name) HAVING count(*) > 1
  ) d;
  IF v_left > 0 THEN
    RAISE EXCEPTION 'items still holds % duplicate (client_id, lower(name)) group(s) — not creating the index', v_left;
  END IF;
END $$;

-- ── (b) The constraint ──────────────────────────────────────────────────────────────────────
-- A functional index, so it cannot be a table constraint and cannot be an ON CONFLICT target by
-- column name. Nothing upserts `items` today; if anything ever does, its conflict target is
-- `(client_id, lower(name))` spelled out, not `'client_id,name'`.
CREATE UNIQUE INDEX IF NOT EXISTS items_client_name_key
  ON public.items (client_id, lower(name));

COMMENT ON INDEX public.items_client_name_key IS
  'S707: one item name per client, case-insensitive, covering sub-recipe mirrors and hidden items. See 20260909120000.';

-- ── (c) push_master_data learns the word "conflict" ─────────────────────────────────────────
--
-- Without this, the index above turns a silent bug into a louder one. The push writes items into
-- a branch three ways, and every one of them could previously produce a second row with a name
-- the branch already used:
--
--   * 'create'  — an HQ item whose name a branch item already holds, where that branch item is
--                 linked to a DIFFERENT HQ item (so the adopt-by-name join does not match it).
--   * 'update'  — renaming an already-linked branch item onto a name a sibling holds.
--   * the sub-recipe mirror INSERT, which was not name-checked in any form.
--
-- All three now raise 23505 instead, and because the whole push is one function call, that means
-- ONE colliding item aborts the entire multi-outlet push with a constraint name for a message.
-- So the plan gains a fourth action, 'conflict': reported in the preview exactly like the other
-- three, and skipped by the apply pass. The operator sees which branch record is in the way,
-- before approving anything, and the rest of the push still lands.
--
-- This also closes a latent fault the index would otherwise have exposed: the adopt join
-- `lower(a.name) = lower(s.name)` produced TWO plan rows when a branch held two same-named items,
-- and both would have been given `master_id = s.id` — a violation of `items_client_master_key`.
-- After (a) that cannot happen, and after (b) it cannot recur.
--
-- DROP + CREATE rather than CREATE OR REPLACE so the grants below are re-stated explicitly; a
-- dropped function takes its grants with it, and the per-signature rule in
-- .claude/rules/supabase-sql.md is what makes that easy to miss.

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
  -- The sub-recipe mirror's name, and the branch item already holding it (S707).
  v_mname    text;
  v_conflict text;
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
      -- `x` is any OTHER branch row already holding this name -- neither the master-linked row we
      -- would update nor the unlinked row we would adopt. Its existence means writing s.name into
      -- this branch violates items_client_name_key, so the row is planned as 'conflict' and the
      -- apply pass below skips it. LATERAL rather than a fourth LEFT JOIN because the predicate
      -- has to reference d.id and a.id, which a plain join cannot.
      INSERT INTO _plan
      SELECT v_target, v_tname, 'items',
             CASE WHEN x.id IS NOT NULL THEN 'conflict'
                  WHEN d.id IS NOT NULL THEN 'update'
                  WHEN a.id IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             CASE WHEN x.id IS NOT NULL
                    THEN 'skipped - this branch already has a different ' ||
                         CASE WHEN COALESCE(x.is_sub_recipe, false) THEN 'sub-recipe' ELSE 'item' END ||
                         ' called "' || x.name || '". Rename one of them, then push again.'
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
$fn$;

REVOKE EXECUTE ON FUNCTION public.push_master_data(uuid[], text[], boolean) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.push_master_data(uuid[], text[], boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- Verification ---------------------------------------------------------------------------------
--   -- the index exists and is unique
--   SELECT indexdef FROM pg_indexes WHERE indexname = 'items_client_name_key';
--
--   -- zero duplicate names anywhere (must return no rows)
--   SELECT client_id, lower(name), count(*) FROM items
--    GROUP BY 1, 2 HAVING count(*) > 1;
--
--   -- what the dedupe renamed, if anything (review these with the client — a '-DUP2' name is a
--   -- real pre-existing split that someone now has to merge or retire)
--   SELECT client_id, id, name, is_sub_recipe FROM items WHERE name LIKE '%-DUP%' ORDER BY client_id, name;
--
--   -- the push still plans, and now reports conflicts instead of raising
--   SELECT * FROM push_master_data(ARRAY['<branch uuid>']::uuid[], ARRAY['items'], true)
--    WHERE action = 'conflict';
