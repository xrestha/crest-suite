-- S877: an HQ push leaves a branch's own allergen check alone.
--
-- push_master_data copied HQ's items.nutrition onto every branch copy of an item whole, on the way in
-- (INSERT) and on every later push (UPDATE). The allergens and the allergens_checked flag travel
-- inside that record, so a branch whose staff had checked an ingredient against its own label (a
-- different supplier, a different brand) had that answer overwritten by HQ's on the next push, and
-- the branch's guest menu then showed HQ's allergens for food the branch buys itself.
--
-- Owner decision (2026-11-04): once a branch item has allergens_checked = true, the push leaves its
-- allergens alone; HQ's answer fills only the items the branch never checked.
--
--   public.push_master_data(uuid[], text[], boolean)   REPLACED (CREATE OR REPLACE, same signature,
--     same return shape, same grants re-issued). Built from the live body (md5 of prosrc below, the
--     same as 20261019100500_group_push_access_s849.sql), with ONE change, in the items UPDATE: when
--     the branch row's nutrition says allergens_checked = true, the write is HQ's nutrition without
--     'allergens', 'allergens_checked' and 'not_food', plus the branch's own not_food if it had one.
--     A write without the allergens_checked key is what items_nutrition_normalise (20261103120000)
--     already treats as "keep the item's own allergens, checked state and piece weight", so the
--     branch keeps its answer and HQ's figures (energy, protein and the rest) still arrive. not_food
--     is kept as well because "Not food" is itself an allergen answer (Check allergens confirms it).
--     Otherwise the write is s.nutrition, exactly as before. New items (INSERT) take HQ's record as
--     before.
--
-- Reversal: CREATE OR REPLACE push_master_data from 20261019100500_group_push_access_s849.sql
-- (lines 972-2166, "CREATE FUNCTION" read as "CREATE OR REPLACE FUNCTION"); the grants are unchanged.
-- No data is rewritten here: a branch item HQ already overwrote stays as it is.
--
-- No app change goes with this file, and an older bundle is unaffected: the push panel reads the
-- same columns.

BEGIN;

-- ── 0. Pre-flight ─────────────────────────────────────────────────────────────────────────────
-- The body below was built from the live definition read on 2026-11-04. If it moved since, stop and
-- rebuild from pg_get_functiondef rather than revert someone else's change. A re-run finds this
-- file's own body.
DO $pre$
DECLARE
  v_md5 text;
  v_n   integer;
BEGIN
  SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.push_master_data(uuid[],text[],boolean)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('23d9260aaeb024f79d979a2e90c0c7e8', 'fe0b0df867cc06a27c05469a6159d08e') THEN
    RAISE EXCEPTION 'S877 pre-flight: push_master_data is not the body this file was built on (live md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'push_master_data';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S877 pre-flight: push_master_data has % signatures (want 1)', v_n;
  END IF;
  IF to_regprocedure('public.items_nutrition_normalise()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.items'::regclass
                     AND tgname = 'items_nutrition_normalise' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'S877 pre-flight: the items_nutrition_normalise trigger is missing; apply the S870 files first';
  END IF;
END;
$pre$;


-- ── 1. push_master_data: a checked branch item keeps its allergens ────────────────────────────
-- The live body, unchanged but for the items UPDATE (marked "S877").
CREATE OR REPLACE FUNCTION public.push_master_data(p_target_client_ids uuid[], p_entities text[], p_dry_run boolean DEFAULT true)
 RETURNS TABLE(row_no bigint, row_kind text, target_client_id uuid, target_client_name text, entity text, action text, record_name text, detail text, row_n integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- The apply loops read _plan by bare column names (entity, action, target_client_id) that are also
-- this function's RETURNS TABLE columns, so every non-dry-run push raised 42702 "column reference
-- is ambiguous" — since 20260827150000; only the preview ever ran. Every such name means the
-- column: the OUT columns are only ever filled by RETURN QUERY (S792 stage 3 dry run).
#variable_conflict use_column
-- S849 (Suite review S848): GROUP-1 the HQ must still be in the group; GROUP-2 (owner SU2 a) a dish
-- whose HQ ingredient has no match at the branch is kept whole and listed as skipped, planned in the
-- preview, and no list is ever shortened; GROUP-6 the result is a total row, one count row per
-- branch × entity × action, then the rows (every row on a preview, the ones needing a look after a
-- push) with row_no to page by; GROUP-7 duplicate dish names, a dish code held elsewhere, and
-- categories differing only in capitals are planned as conflicts; GROUP-12 (owner SU8 a) the Veg /
-- Egg / Non-veg mark follows HQ, each change named, and a new dish takes HQ's description.
DECLARE
  v_group  uuid;
  v_hq     uuid;
  v_target uuid;
  v_tname  text;
  v_do_cat boolean := 'categories' = ANY (p_entities);
  v_do_itm boolean := 'items'      = ANY (p_entities);
  v_do_rec boolean := 'recipes'    = ANY (p_entities);
  v_do_prc boolean := 'prices'     = ANY (p_entities);
  -- S838: Crest Customization's choices, with the dishes they belong to.
  v_do_opt boolean := 'options'    = ANY (p_entities);
  r        record;
  v_dst    uuid;
  v_item   uuid;
  v_cat    uuid;
  v_lines  integer;
  v_skipped integer;
  v_cleared integer;
  v_grp    uuid;
  v_opt    uuid;
  -- S840: combos
  v_cmb    uuid;
  v_bg     uuid;
  v_sg     record;
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

  -- S849 GROUP-1: hq_client_id is only ever tested for NULL above, so an HQ outlet that left the
  -- group (sold, moved, or Create & Assign'd into a new group) stayed the source of every push into
  -- the outlets left behind: another business's items, purchase rates, recipes and prices. The
  -- clients.group_id trigger now clears such an HQ; this refuses one that is still recorded.
  IF NOT COALESCE((SELECT c.group_id = v_group FROM clients c WHERE c.id = v_hq), false) THEN
    RAISE EXCEPTION 'group_hq_outside: this group''s HQ outlet is no longer in the group, so there is nothing to push from. Ask Crest support to set a new HQ outlet.'
      USING ERRCODE = '42501', HINT = 'group_hq_outside';
  END IF;

  -- S838: a choice group means nothing without the dishes it sits on, and a stock line nothing
  -- without the sub-recipe it names.
  IF v_do_opt AND NOT v_do_rec THEN
    RAISE EXCEPTION 'Choices are pushed with their dishes: tick Recipes as well.';
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

  -- vat_differs (S792 stage 3) is set on recipe rows and, since S838, choice rows: whether this
  -- price must stay the branch's own. The other entities leave it NULL.
  -- S835: dropped first. ON COMMIT DROP keeps it until the transaction ends, so a second call in
  -- one transaction failed with 42P07.
  DROP TABLE IF EXISTS pg_temp._plan;
  CREATE TEMP TABLE _plan (
    target_client_id uuid, target_client_name text,
    entity text, action text, record_name text, detail text,
    src_id uuid, dst_id uuid, vat_differs boolean,
    -- S849 GROUP-2: the HQ ingredient (or choice stock) lines with no counterpart at this branch.
    missing text
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
      -- S849 GROUP-7: categories_client_name_unique is case-sensitive while the adopt match is not, so
      -- two branch categories differing only in capitals both matched, and the second write raised
      -- 23505 and rolled back the whole push. `a` now counts the matches and adopts only a single one;
      -- `x` is any OTHER branch category already holding HQ's exact name, which the write would collide
      -- with. Either is a conflict, reported and skipped like an item's.
      INSERT INTO _plan
      SELECT v_target, v_tname, 'categories',
             CASE WHEN x.name IS NOT NULL OR (d.id IS NULL AND a.n > 1) THEN 'conflict'
                  WHEN d.id IS NOT NULL THEN 'update'
                  WHEN a.n = 1 THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             CASE WHEN d.id IS NULL AND a.n > 1
                    THEN 'skipped - this branch has ' || a.n || ' categories called "' || a.names ||
                         '" (they differ only in capitals), so Crest cannot tell which one is HQ''s. Rename or merge them, then push again.'
                  WHEN x.name IS NOT NULL
                    THEN 'skipped - this branch already has a different category called "' || x.name ||
                         '". Rename one of them, then push again.'
                  WHEN d.id IS NULL AND a.n = 1 THEN 'matched an existing category of the same name' END,
             s.id,
             CASE WHEN x.name IS NOT NULL OR (d.id IS NULL AND a.n > 1) THEN NULL
                  ELSE COALESCE(d.id, CASE WHEN a.n = 1 THEN a.id END) END
        FROM categories s
        LEFT JOIN categories d ON d.client_id = v_target AND d.master_id = s.id
        LEFT JOIN LATERAL (
          SELECT count(*)::integer AS n,
                 (array_agg(c.id ORDER BY c.id))[1] AS id,
                 string_agg(c.name, '", "' ORDER BY c.name) AS names
            FROM categories c
           WHERE d.id IS NULL AND c.client_id = v_target AND c.master_id IS NULL
             AND lower(c.name) = lower(s.name)
        ) a ON true
        LEFT JOIN LATERAL (
          SELECT c.name
            FROM categories c
           WHERE c.client_id = v_target AND c.name = s.name
             AND c.id IS DISTINCT FROM COALESCE(d.id, CASE WHEN a.n = 1 THEN a.id END)
           LIMIT 1
        ) x ON true
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
             CASE WHEN t.conflict IS NOT NULL THEN 'conflict'
                  WHEN d.id IS NOT NULL THEN 'update'
                  WHEN t.tid IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             CASE WHEN t.conflict IS NOT NULL THEN t.conflict ELSE
             concat_ws('; ',
               -- S835: the match is said on its own, and the price clause after it follows a matched
               -- dish too: the apply writes HQ's price over the branch's own when prices are pushed,
               -- and the preview used to stop at the match.
               CASE WHEN d.id IS NULL AND c.id IS NOT NULL THEN 'matched an existing recipe with the same code'
                    WHEN d.id IS NULL AND t.nid IS NOT NULL THEN 'matched an existing recipe of the same name' END,
               CASE WHEN v_vat_differs AND s.category IS DISTINCT FROM 'Sub-Recipe' THEN NULL
                    -- S809 2h: what a NEW dish arrives as (the INSERT below copies HQ's price
                    -- whether or not prices were asked for), and a price push never blanks a
                    -- branch's price with one HQ does not have.
                    WHEN t.tid IS NULL AND s.category IS DISTINCT FROM 'Sub-Recipe'
                         AND NOT COALESCE(s.selling_price > 0, false)
                      THEN 'added OFF the till with no price: HQ has not priced it yet. Set its price at this branch, then switch it On POS'
                    WHEN t.tid IS NULL AND s.category IS DISTINCT FROM 'Sub-Recipe'
                      THEN 'added at HQ''s price, ' ||
                           CASE WHEN s.pos_enabled IS NOT DISTINCT FROM false THEN 'off the till' ELSE 'on the till' END ||
                           ' as it is at HQ'
                    WHEN v_do_prc AND s.category IS DISTINCT FROM 'Sub-Recipe'
                         AND NOT COALESCE(s.selling_price > 0, false)
                      THEN 'selling price left as the branch has it: HQ has no price for it'
                    WHEN v_do_prc AND d.id IS NULL AND COALESCE(s.selling_price > 0, false)
                      THEN 'its selling price is replaced with HQ''s'
                    WHEN v_do_prc THEN 'selling price included'
                    ELSE 'selling price left as the branch has it' END,
               CASE WHEN NOT v_vat_differs OR s.category IS NOT DISTINCT FROM 'Sub-Recipe' THEN NULL
                    WHEN t.tid IS NULL
                      THEN 'added OFF the till with no price: ' || v_vat_why ||
                           ', so HQ''s price would charge guests a different amount here. Set its price at this branch, then switch it On POS'
                    ELSE 'price and VAT rate left as this branch has them: ' || v_vat_why ||
                         ', so HQ''s price would charge guests a different amount here' END) END,
             s.id, CASE WHEN t.conflict IS NOT NULL THEN NULL ELSE t.tid END,
             v_vat_differs AND s.category IS DISTINCT FROM 'Sub-Recipe'
        FROM recipes s
        LEFT JOIN recipes d ON d.client_id = v_target AND d.master_id = s.id
        -- The code match only matters when the dish is not linked yet; a linked dish whose code
        -- another branch dish holds is caught by `x` below.
        LEFT JOIN recipes c ON d.id IS NULL AND c.client_id = v_target AND c.master_id IS NULL
                           AND s.recipe_code IS NOT NULL AND c.recipe_code = s.recipe_code
        -- S849 GROUP-7: recipe names are not unique, so the name match is counted, never joined: a
        -- branch holding two "Chicken Momo"s used to yield two adopt rows, the second write broke
        -- recipes_client_master_key and the whole push rolled back with a constraint name.
        LEFT JOIN LATERAL (
          SELECT count(*)::integer AS n, (array_agg(b.id ORDER BY b.id))[1] AS id,
                 string_agg(COALESCE(b.category, 'no category'), ', ' ORDER BY b.id) AS cats
            FROM recipes b
           WHERE d.id IS NULL AND c.id IS NULL AND b.client_id = v_target AND b.master_id IS NULL
             AND lower(b.name) = lower(s.name)
        ) n ON true
        -- HQ's own dishes of that name: two of them cannot both be the branch's one.
        LEFT JOIN LATERAL (
          SELECT count(*)::integer AS n FROM recipes h
           WHERE h.client_id = v_hq AND lower(h.name) = lower(s.name)
        ) hn ON true
        CROSS JOIN LATERAL (
          SELECT CASE WHEN d.id IS NULL AND c.id IS NULL AND n.n = 1 AND hn.n = 1 THEN n.id END AS nid
        ) nm
        -- recipes_client_recipe_code_key: any OTHER branch dish already holding HQ's code would make
        -- the write fail (HQ swapping two dishes' codes is enough).
        LEFT JOIN LATERAL (
          SELECT b.name
            FROM recipes b
           WHERE s.recipe_code IS NOT NULL AND b.client_id = v_target AND b.recipe_code = s.recipe_code
             AND b.id IS DISTINCT FROM COALESCE(d.id, c.id, nm.nid)
           LIMIT 1
        ) x ON true
        CROSS JOIN LATERAL (
          SELECT COALESCE(d.id, c.id, nm.nid) AS tid,
                 nm.nid,
                 CASE WHEN x.name IS NOT NULL
                        THEN 'skipped - this branch''s dish "' || x.name || '" already uses HQ''s recipe code ' ||
                             s.recipe_code || '. Change one of the two codes, then push again.'
                      WHEN d.id IS NULL AND c.id IS NULL AND n.n > 1
                        THEN 'skipped - this branch has ' || n.n || ' dishes called "' || s.name ||
                             '" (' || COALESCE(n.cats, 'no category') || '), so Crest cannot tell which one is HQ''s. Rename all but one, or give HQ''s dish a recipe code one of them carries, then push again.'
                      WHEN d.id IS NULL AND c.id IS NULL AND n.n = 1 AND hn.n > 1
                        THEN 'skipped - HQ has ' || hn.n || ' dishes called "' || s.name ||
                             '" and this branch has one, so Crest cannot tell which it is. Give HQ''s dishes different names or recipe codes, then push again.'
                 END AS conflict
        ) t
       WHERE s.client_id = v_hq;

      -- S849 GROUP-7: one branch dish matched by two HQ dishes (one by code, another by name) would be
      -- written twice and linked to both. Neither is adopted.
      UPDATE _plan p
         SET action = 'conflict', dst_id = NULL,
             detail = 'skipped - this branch''s dish "' || COALESCE((SELECT b.name FROM recipes b WHERE b.id = p.dst_id), '') ||
                      '" matches more than one HQ dish (by name or recipe code). Give them different names or codes, then push again.'
       WHERE p.target_client_id = v_target AND p.entity = 'recipes' AND p.action = 'adopt'
         AND EXISTS (SELECT 1 FROM _plan q
                      WHERE q.target_client_id = v_target AND q.entity = 'recipes'
                        AND q.dst_id = p.dst_id AND q.src_id <> p.src_id);

      -- S849 GROUP-2 (owner SU2 a). Which of HQ's ingredient lines would have no counterpart here: an
      -- item that is neither linked already nor created, adopted or updated by this push (a conflict
      -- is not linked), or a sub-recipe in the same position. The apply pass maps lines by master_id
      -- after the items and recipes passes, so this is exactly what it would find.
      UPDATE _plan p
         SET missing = (
               SELECT string_agg(DISTINCT COALESCE(hi.name, hr.name, 'an unnamed line'), ', ')
                 FROM recipe_ingredients ri
                 LEFT JOIN items hi ON hi.id = ri.item_id
                 LEFT JOIN recipes hr ON hr.id = ri.sub_recipe_id
                WHERE ri.recipe_id = p.src_id
                  AND ((ri.item_id IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM items b WHERE b.client_id = v_target AND b.master_id = ri.item_id)
                        AND NOT EXISTS (SELECT 1 FROM _plan q
                                         WHERE q.target_client_id = v_target AND q.entity = 'items'
                                           AND q.src_id = ri.item_id AND q.action IN ('create', 'adopt', 'update')))
                    OR (ri.sub_recipe_id IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM recipes b WHERE b.client_id = v_target AND b.master_id = ri.sub_recipe_id)
                        AND NOT EXISTS (SELECT 1 FROM _plan q
                                         WHERE q.target_client_id = v_target AND q.entity = 'recipes'
                                           AND q.src_id = ri.sub_recipe_id AND q.action IN ('create', 'adopt', 'update')))))
       WHERE p.target_client_id = v_target AND p.entity = 'recipes' AND p.action IN ('create', 'adopt', 'update');

      -- A dish the branch already has keeps everything it has: its lines, its yield, its price and its
      -- marks. Writing HQ's list without the missing line would cost the dish too low and stop the till
      -- taking that stock, and the branch's own line could not be brought back. An adopt is only linked,
      -- so the next push matches it (and a sub-recipe stays usable by the dishes that name it).
      UPDATE _plan p
         SET action = 'skipped',
             detail = 'kept exactly as this branch has it: HQ''s recipe uses ' || p.missing ||
                      ', which this branch does not have yet, and HQ''s list without it would cost the dish too low and stop the till taking that stock. ' ||
                      'Tick Items & categories too, or add ' ||
                      CASE WHEN position(', ' IN p.missing) > 0 THEN 'them' ELSE 'it' END || ' at this branch, then push again' ||
                      CASE WHEN p.action = 'adopt' THEN '. It is linked to HQ''s dish, so the next push matches it' ELSE '' END
       WHERE p.target_client_id = v_target AND p.entity = 'recipes' AND p.action IN ('adopt', 'update')
         AND p.missing IS NOT NULL;

      -- A dish new to the branch has nothing to lose: it is added with the lines that match, and the
      -- preview says which are left out before anything is written.
      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, src_id)
      SELECT v_target, v_tname, 'ingredients', 'partial', p.record_name,
             'a new dish here, added with only the lines this branch can match: ' || p.missing ||
             ' is not at this branch yet, so it is left out of the dish''s cost and of what the till takes from stock. Add it here (or tick Items & categories), then push again',
             p.src_id
        FROM _plan p
       WHERE p.target_client_id = v_target AND p.entity = 'recipes' AND p.action = 'create'
         AND p.missing IS NOT NULL;

      -- S849 GROUP-12 (owner SU8 a): the Veg / Egg / Non-veg mark follows HQ, because the ingredient
      -- list does. Each change is named before it is written (one read rule: DietMark.jsx dietOfDish).
      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, src_id, dst_id)
      SELECT v_target, v_tname, 'food marks', 'change', p.record_name,
             'marked ' || fm.b || ' here until now; HQ marks it ' || fm.h ||
             ', and this push gives the branch HQ''s recipe, so the guest menu and the till show ' || fm.h || ' here',
             p.src_id, p.dst_id
        FROM _plan p
        JOIN recipes s ON s.id = p.src_id
        JOIN recipes e ON e.id = p.dst_id
        CROSS JOIN LATERAL (SELECT CASE WHEN s.is_veg THEN 'Veg' WHEN s.is_veg = false AND COALESCE(s.is_egg, false) THEN 'Egg' WHEN s.is_veg = false THEN 'Non-veg' ELSE 'not stated' END AS h,
                                   CASE WHEN e.is_veg THEN 'Veg' WHEN e.is_veg = false AND COALESCE(e.is_egg, false) THEN 'Egg' WHEN e.is_veg = false THEN 'Non-veg' ELSE 'not stated' END AS b) fm
       WHERE p.target_client_id = v_target AND p.entity = 'recipes' AND p.action IN ('adopt', 'update')
         AND s.category IS DISTINCT FROM 'Sub-Recipe'
         AND fm.h IS DISTINCT FROM fm.b;
    END IF;

    IF v_do_opt THEN
      -- S838: the copy still lands where Customization is off, ready for the day it is switched on;
      -- until then the till, the guest menu and the costing screens ignore it.
      IF NOT COALESCE(public.customization_live(v_target), false)
         AND EXISTS (SELECT 1 FROM pos_option_groups s WHERE s.client_id = v_hq) THEN
        INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail)
        VALUES (v_target, v_tname, 'choice groups', 'note', 'Crest Customization',
                'switched off at this branch: the choices are copied, and stay unused until it is switched on here');
      END IF;

      -- Groups. The name is unique per client, so `x` is any OTHER branch group holding it (the
      -- items pass's conflict, with the adopt join kept off a linked row: a renamed HQ group whose
      -- new name an unlinked branch group holds is a conflict, not a second match). `k` is a kind
      -- change the branch's OWN choices in the group would refuse (guard_pos_option_edit: a Size
      -- holds no "No ..." choice, and only a Size carries a portion size); the copies of HQ's
      -- choices are made to fit in the apply pass.
      INSERT INTO _plan
      SELECT v_target, v_tname, 'choice groups',
             CASE WHEN x.id IS NOT NULL OR k.opt_name IS NOT NULL THEN 'conflict'
                  WHEN d.id IS NOT NULL THEN 'update'
                  WHEN a.id IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             CASE WHEN x.id IS NOT NULL
                    THEN 'skipped - this branch already has a different choice group called "' || x.name ||
                         '". Rename one of them, then push again.'
                  WHEN k.opt_name IS NOT NULL
                    THEN 'skipped - HQ changed what kind of group this is, and this branch''s own choice "' || k.opt_name ||
                         '" in it does not fit the new kind. Change or delete that choice here, then push again.'
                  WHEN a.id IS NOT NULL THEN 'matched an existing choice group of the same name'
                  WHEN d.id IS NULL AND NOT s.is_active THEN 'added switched off, as it is at HQ' END,
             s.id, COALESCE(d.id, a.id)
        FROM pos_option_groups s
        LEFT JOIN pos_option_groups d ON d.client_id = v_target AND d.master_id = s.id
        LEFT JOIN pos_option_groups a ON d.id IS NULL AND a.client_id = v_target AND a.master_id IS NULL
                                     AND lower(btrim(a.name)) = lower(btrim(s.name))
        LEFT JOIN LATERAL (
          SELECT c.id, c.name
            FROM pos_option_groups c
           WHERE c.client_id = v_target
             AND lower(btrim(c.name)) = lower(btrim(s.name))
             AND c.id IS DISTINCT FROM COALESCE(d.id, a.id)
           LIMIT 1
        ) x ON true
        LEFT JOIN LATERAL (
          SELECT o.name AS opt_name
            FROM pos_option_groups b
            JOIN pos_options o ON o.group_id = b.id
           WHERE b.id = COALESCE(d.id, a.id)
             AND b.kind IS DISTINCT FROM s.kind
             AND ((s.kind = 'size' AND o.is_removal) OR (b.kind = 'size' AND o.portion_factor IS NOT NULL))
             AND NOT EXISTS (SELECT 1 FROM pos_options so
                              WHERE so.group_id = s.id
                                AND (so.id = o.master_id
                                     OR (o.master_id IS NULL AND lower(btrim(so.name)) = lower(btrim(o.name)))))
           LIMIT 1
        ) k ON true
       WHERE s.client_id = v_hq;

      -- A group HQ has deleted: switched off here, never deleted (owner 2026-10-14).
      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, dst_id)
      SELECT v_target, v_tname, 'choice groups', 'hide', d.name,
             'HQ no longer has this group, so it is switched off here; past bills keep its name', d.id
        FROM pos_option_groups d
       WHERE d.client_id = v_target AND d.master_id IS NOT NULL AND d.is_active
         AND NOT EXISTS (SELECT 1 FROM pos_option_groups s WHERE s.id = d.master_id AND s.client_id = v_hq);

      -- Choices. Adopted by name only inside the branch group their HQ group matched, which is
      -- where pos_options_group_name_key would refuse a second one. `e` is the branch row either
      -- way, for the price clause. A new choice arrives at HQ's price even without "Selling
      -- prices", as a new dish does; one with a price on a branch whose VAT status differs arrives
      -- switched off at no charge.
      INSERT INTO _plan
      SELECT v_target, v_tname, 'choices',
             CASE WHEN g.action = 'conflict' OR x.id IS NOT NULL THEN 'conflict'
                  WHEN d.id IS NOT NULL THEN 'update'
                  WHEN a.id IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             sg.name || ' › ' || s.name,
             CASE WHEN g.action = 'conflict'
                    THEN 'skipped - its group was not pushed (see the group''s row)'
                  WHEN x.id IS NOT NULL
                    THEN 'skipped - this branch''s group already has a different choice called "' || x.name ||
                         '". Rename one of them, then push again.'
                  ELSE concat_ws('; ',
                    CASE WHEN a.id IS NOT NULL THEN 'matched an existing choice of the same name' END,
                    CASE WHEN e.id IS NULL AND v_vat_differs AND s.price_delta <> 0
                           THEN 'added switched OFF at no charge: ' || v_vat_why ||
                                ', so HQ''s price would charge guests a different amount here. Set its price at this branch, then switch it on'
                         WHEN e.id IS NULL AND NOT s.is_active THEN 'added switched off, as it is at HQ'
                         WHEN e.id IS NULL OR s.is_removal OR e.price_delta = s.price_delta THEN NULL
                         WHEN v_vat_differs
                           THEN 'price left as this branch has it: ' || v_vat_why ||
                                ', so HQ''s price would charge guests a different amount here'
                         WHEN v_do_prc THEN 'its price is replaced with HQ''s'
                         ELSE 'price left as the branch has it' END) END,
             s.id, COALESCE(d.id, a.id), v_vat_differs
        FROM pos_options s
        JOIN pos_option_groups sg ON sg.id = s.group_id
        JOIN _plan g ON g.target_client_id = v_target AND g.entity = 'choice groups' AND g.src_id = s.group_id
        LEFT JOIN pos_options d ON d.client_id = v_target AND d.master_id = s.id
        LEFT JOIN pos_options a ON d.id IS NULL AND g.dst_id IS NOT NULL AND a.group_id = g.dst_id
                               AND a.master_id IS NULL AND lower(btrim(a.name)) = lower(btrim(s.name))
        LEFT JOIN pos_options e ON e.id = COALESCE(d.id, a.id)
        LEFT JOIN LATERAL (
          SELECT c.id, c.name
            FROM pos_options c
           WHERE g.dst_id IS NOT NULL AND c.group_id = g.dst_id
             AND lower(btrim(c.name)) = lower(btrim(s.name))
             AND c.id IS DISTINCT FROM COALESCE(d.id, a.id)
           LIMIT 1
        ) x ON true
       WHERE s.client_id = v_hq;

      -- S849 GROUP-2: a choice's stock lines follow the ingredients rule. A choice the branch already
      -- has keeps its own stock lines when one of HQ's has no counterpart here; a new one is added with
      -- the lines that match. Said before anything is written.
      UPDATE _plan p
         SET missing = (
               SELECT string_agg(DISTINCT COALESCE(hi.name, hr.name, 'an unnamed line'), ', ')
                 FROM pos_option_ingredients oi
                 LEFT JOIN items hi ON hi.id = oi.item_id
                 LEFT JOIN recipes hr ON hr.id = oi.sub_recipe_id
                WHERE oi.option_id = p.src_id
                  AND ((oi.item_id IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM items b WHERE b.client_id = v_target AND b.master_id = oi.item_id)
                        AND NOT EXISTS (SELECT 1 FROM _plan q
                                         WHERE q.target_client_id = v_target AND q.entity = 'items'
                                           AND q.src_id = oi.item_id AND q.action IN ('create', 'adopt', 'update')))
                    OR (oi.sub_recipe_id IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM recipes b WHERE b.client_id = v_target AND b.master_id = oi.sub_recipe_id)
                        AND NOT EXISTS (SELECT 1 FROM _plan q
                                         WHERE q.target_client_id = v_target AND q.entity = 'recipes'
                                           AND q.src_id = oi.sub_recipe_id AND q.action IN ('create', 'adopt', 'update')))))
       WHERE p.target_client_id = v_target AND p.entity = 'choices' AND p.action IN ('create', 'adopt', 'update');

      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, src_id)
      SELECT v_target, v_tname, 'choice stock lines',
             CASE WHEN p.action = 'create' THEN 'partial' ELSE 'skipped' END, p.record_name,
             CASE WHEN p.action = 'create'
                  THEN 'a new choice here, added with only the stock lines this branch can match: ' || p.missing ||
                       ' is not at this branch yet, so the till does not take it from stock. Add it here, then push again'
                  ELSE 'stock lines kept as this branch has them: HQ''s use ' || p.missing ||
                       ', which this branch does not have yet. Add it here (or tick Items & categories), then push again' END,
             p.src_id
        FROM _plan p
       WHERE p.target_client_id = v_target AND p.entity = 'choices' AND p.action IN ('create', 'adopt', 'update')
         AND p.missing IS NOT NULL;

      -- A choice HQ has deleted: switched off here, never deleted (owner 2026-10-14).
      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, dst_id)
      SELECT v_target, v_tname, 'choices', 'hide', bg.name || ' › ' || d.name,
             'HQ no longer has this choice, so it is switched off here; past bills keep its name', d.id
        FROM pos_options d
        JOIN pos_option_groups bg ON bg.id = d.group_id
       WHERE d.client_id = v_target AND d.master_id IS NOT NULL AND d.is_active
         AND NOT EXISTS (SELECT 1 FROM pos_options s WHERE s.id = d.master_id AND s.client_id = v_hq);

      -- Each pushed dish's groups, as HQ has them.
      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, src_id, dst_id)
      SELECT v_target, v_tname, 'dish choices', 'replaced', rp.record_name,
             concat_ws('; ',
               CASE WHEN hq.names IS NOT NULL THEN 'choice groups: ' || hq.names END,
               CASE WHEN br.names IS NOT NULL THEN 'taken off this dish, as at HQ: ' || br.names END,
               CASE WHEN rs.is_build_your_own THEN 'build-your-own' END),
             rp.src_id, rp.dst_id
        FROM _plan rp
        JOIN recipes rs ON rs.id = rp.src_id
        LEFT JOIN LATERAL (
          SELECT string_agg(sg.name, ', ' ORDER BY l.sort, sg.name) AS names
            FROM pos_recipe_option_groups l
            JOIN pos_option_groups sg ON sg.id = l.group_id
           WHERE l.recipe_id = rp.src_id
        ) hq ON true
        -- The branch's groups on this dish that are HQ's (linked already, or taken over by name in
        -- this push) and that HQ's dish does not carry: the apply takes them off.
        LEFT JOIN LATERAL (
          SELECT string_agg(bg.name, ', ' ORDER BY bg.name) AS names
            FROM pos_recipe_option_groups l
            JOIN pos_option_groups bg ON bg.id = l.group_id
            LEFT JOIN _plan ad ON ad.target_client_id = v_target AND ad.entity = 'choice groups'
                              AND ad.action = 'adopt' AND ad.dst_id = bg.id
           WHERE rp.dst_id IS NOT NULL AND l.recipe_id = rp.dst_id
             AND COALESCE(bg.master_id, ad.src_id) IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM pos_recipe_option_groups h
                              WHERE h.recipe_id = rp.src_id AND h.group_id = COALESCE(bg.master_id, ad.src_id))
        ) br ON true
       WHERE rp.target_client_id = v_target AND rp.entity = 'recipes'
         AND rp.action IN ('create', 'adopt', 'update')  -- S849: a skipped or conflicting dish is left as it is
         AND (hq.names IS NOT NULL OR br.names IS NOT NULL OR rs.is_build_your_own);

      -- The till refuses a plate priced below zero (S816), so say so before the push, from the
      -- prices each side will hold after it. A group with free picks is left out: which choices
      -- are free depends on the plate. One row per dish, its most negative choice.
      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail)
      SELECT DISTINCT ON (rp.src_id)
             v_target, v_tname, 'dish choices', 'warning', rp.record_name,
             '"' || so.name || '" (' || to_char(nd.delta, 'FM999999990.00') || ') would take this dish below zero here (NPR ' ||
             to_char(np.price, 'FM999999990.00') || '): the till refuses that plate until the dish''s price or the choice''s price is changed at this branch'
        FROM _plan rp
        JOIN recipes rs ON rs.id = rp.src_id
        LEFT JOIN recipes rd ON rd.id = rp.dst_id
        JOIN pos_recipe_option_groups l ON l.recipe_id = rp.src_id
        JOIN pos_option_groups sg ON sg.id = l.group_id AND sg.included_count = 0
        JOIN pos_options so ON so.group_id = sg.id
        LEFT JOIN _plan op ON op.target_client_id = v_target AND op.entity = 'choices' AND op.src_id = so.id
        LEFT JOIN pos_options od ON od.id = op.dst_id
        CROSS JOIN LATERAL (
          SELECT CASE WHEN rd.id IS NULL THEN CASE WHEN COALESCE(rp.vat_differs, false) THEN NULL ELSE rs.selling_price END
                      WHEN v_do_prc AND NOT COALESCE(rp.vat_differs, false) AND COALESCE(rs.selling_price > 0, false)
                        THEN rs.selling_price
                      ELSE rd.selling_price END AS price
        ) np
        CROSS JOIN LATERAL (
          SELECT CASE WHEN od.id IS NULL THEN CASE WHEN v_vat_differs AND so.price_delta <> 0 THEN 0 ELSE so.price_delta END
                      WHEN v_do_prc AND NOT v_vat_differs THEN so.price_delta
                      ELSE od.price_delta END AS delta,
                 CASE WHEN od.id IS NULL THEN so.is_active AND NOT (v_vat_differs AND so.price_delta <> 0)
                      ELSE od.is_active END AS on_menu
        ) nd
       WHERE rp.target_client_id = v_target AND rp.entity = 'recipes'
         AND rp.action IN ('create', 'adopt', 'update')  -- S849
         AND op.action IS DISTINCT FROM 'conflict'
         AND nd.on_menu
         AND np.price IS NOT NULL AND nd.delta < 0 AND np.price + nd.delta < 0
       ORDER BY rp.src_id, nd.delta;

      -- S840 (docs/pos-combos.md): combos ride with the choices. Adopted by name once; a name another
      -- branch combo holds is a conflict. Choices needs Recipes, so every HQ dish reaches the branch in
      -- this push and a missing dish is rare; a NEW combo missing one arrives switched off (owner
      -- decision 2026-10-15) and the preview names the dish. A combo's price is what the guest pays,
      -- so a branch of another VAT status takes it as it is.
      INSERT INTO _plan
      SELECT v_target, v_tname, 'combos',
             CASE WHEN x.id IS NOT NULL THEN 'conflict'
                  WHEN d.id IS NOT NULL THEN 'update'
                  WHEN a.id IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             CASE WHEN x.id IS NOT NULL
                    THEN 'skipped - this branch already has a different combo called "' || x.name ||
                         '". Rename one of them, then push again.'
                  ELSE concat_ws('; ',
                    CASE WHEN a.id IS NOT NULL THEN 'matched an existing combo of the same name' END,
                    'picks: ' || COALESCE(pk.names, 'none'),
                    CASE WHEN m.missing IS NOT NULL AND e.id IS NULL
                           THEN 'added switched OFF: ' || m.missing || ' is not at this branch yet. Add it here, then push again'
                         WHEN m.missing IS NOT NULL
                           THEN m.missing || ' is not at this branch yet, so it is left out of its pick. Add it here, then push again'
                         WHEN e.id IS NULL AND NOT s.is_active THEN 'added switched off, as it is at HQ' END,
                    CASE WHEN e.id IS NOT NULL AND e.guest_price <> s.guest_price
                           THEN CASE WHEN v_do_prc THEN 'its price is replaced with HQ''s' ELSE 'price left as the branch has it' END END) END,
             s.id, COALESCE(d.id, a.id)
        FROM pos_combos s
        LEFT JOIN pos_combos d ON d.client_id = v_target AND d.master_id = s.id
        LEFT JOIN pos_combos a ON d.id IS NULL AND a.client_id = v_target AND a.master_id IS NULL
                              AND lower(btrim(a.name)) = lower(btrim(s.name))
        LEFT JOIN pos_combos e ON e.id = COALESCE(d.id, a.id)
        LEFT JOIN LATERAL (
          SELECT c.id, c.name
            FROM pos_combos c
           WHERE c.client_id = v_target AND lower(btrim(c.name)) = lower(btrim(s.name))
             AND c.id IS DISTINCT FROM COALESCE(d.id, a.id)
           LIMIT 1
        ) x ON true
        LEFT JOIN LATERAL (
          SELECT string_agg(g.name, ', ' ORDER BY g.sort, g.id) AS names
            FROM pos_combo_groups g WHERE g.combo_id = s.id
        ) pk ON true
        LEFT JOIN LATERAL (
          SELECT string_agg(DISTINCT r.name, ', ') AS missing
            FROM pos_combo_groups g
            JOIN pos_combo_items it ON it.group_id = g.id
            JOIN recipes r ON r.id = it.recipe_id
           WHERE g.combo_id = s.id
             AND NOT EXISTS (SELECT 1 FROM recipes br WHERE br.client_id = v_target AND br.master_id = it.recipe_id)
             AND NOT EXISTS (SELECT 1 FROM _plan rq
                              WHERE rq.target_client_id = v_target AND rq.entity = 'recipes' AND rq.src_id = it.recipe_id
                                -- S849: a conflicting dish is not linked, so it is not at the branch; a skipped one is.
                                AND rq.action IN ('create', 'adopt', 'update', 'skipped'))
        ) m ON true
       WHERE s.client_id = v_hq;

      -- A combo HQ has deleted: switched off here, never deleted (as a choice is).
      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, dst_id)
      SELECT v_target, v_tname, 'combos', 'hide', d.name,
             'HQ no longer has this combo, so it is switched off here; past bills keep its name', d.id
        FROM pos_combos d
       WHERE d.client_id = v_target AND d.master_id IS NOT NULL AND d.is_active
         AND NOT EXISTS (SELECT 1 FROM pos_combos s WHERE s.id = d.master_id AND s.client_id = v_hq);
    END IF;
  END LOOP;

  IF p_dry_run THEN
    -- S849 GROUP-6: a set-returning call is cut at 1,000 rows (max_rows), so the page reads a preview
    -- in pages by row_no. A preview writes nothing, so reading it again is safe; a push is never
    -- called twice, which is why its reply lists only what needs a look.
    RETURN QUERY
      WITH listed AS (
             -- A preview lists every row; after a push, the rows that need a look (a routine create,
             -- update or replaced list is in the counts).
             SELECT p.* FROM _plan p
              WHERE p_dry_run OR p.action NOT IN ('create', 'update', 'replaced')
           ),
           counted AS (
             SELECT p.target_client_id AS tid, p.target_client_name AS tname, p.entity AS ent, p.action AS act,
                    count(*)::integer AS cnt
               FROM _plan p
              GROUP BY p.target_client_id, p.target_client_name, p.entity, p.action
           ),
           out_rows AS (
             -- The total comes first, so a reply cut short still says how many rows there were.
             SELECT 0 AS grp, 'total'::text AS k, NULL::uuid AS tid, NULL::text AS tname, NULL::text AS ent,
                    NULL::text AS act, NULL::text AS rec, NULL::text AS det,
                    (SELECT count(*) FROM listed)::integer AS cnt
             UNION ALL
             SELECT 1, 'summary', c.tid, c.tname, c.ent, c.act, NULL, NULL, c.cnt FROM counted c
             UNION ALL
             SELECT 2, 'row', l.target_client_id, l.target_client_name, l.entity, l.action, l.record_name, l.detail, NULL
               FROM listed l
           )
      SELECT (row_number() OVER (ORDER BY o.grp, o.tname, o.ent, o.act, o.rec, o.det, o.tid) - 1)::bigint,
             o.k, o.tid, o.tname, o.ent, o.act, o.rec, o.det, o.cnt
        FROM out_rows o
       ORDER BY 1;
    RETURN;
  END IF;

  ----------------------------------------------------------------------------------------------
  -- APPLY, strictly in dependency order: categories, then items (which reference a category),
  -- then recipes, then each recipe's ingredient list (which references both items and recipes),
  -- then the choices (S838: groups, choices, their stock lines, then each dish's groups).
  ----------------------------------------------------------------------------------------------
  -- S849 GROUP-7: a planned category conflict is reported, never written.
  FOR r IN SELECT * FROM _plan WHERE entity = 'categories' AND action <> 'conflict' ORDER BY target_client_id LOOP
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
      -- S877: so is an allergen check the branch already made. Once its item has allergens_checked
      -- true, HQ's figures still arrive but HQ's allergens, checked flag and Not food answer do not:
      -- the write carries no allergens_checked key, so items_nutrition_normalise keeps the branch's
      -- own allergens and checked state, and the branch's not_food is put back. An item the branch
      -- never checked takes HQ's whole record, as before.
      UPDATE items d
         SET master_id = s.id, category_id = v_cat, name = s.name, uom = s.uom,
             purchase_qty = s.purchase_qty,
             purchase_unit = s.purchase_unit, base_unit = s.base_unit,
             conversion_factor = s.conversion_factor, item_code = s.item_code,
             yield_pct = s.yield_pct,
             nutrition = CASE
               WHEN COALESCE(jsonb_typeof(d.nutrition) = 'object'
                             AND d.nutrition->'allergens_checked' = 'true'::jsonb, false)
                 THEN ((CASE WHEN jsonb_typeof(s.nutrition) = 'object' THEN s.nutrition ELSE '{}'::jsonb END)
                         - 'allergens' - 'allergens_checked' - 'not_food')
                      || (CASE WHEN d.nutrition ? 'not_food'
                               THEN jsonb_build_object('not_food', d.nutrition->'not_food')
                               ELSE '{}'::jsonb END)
               ELSE s.nutrition END
        FROM items s WHERE s.id = r.src_id AND d.id = r.dst_id;
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM _plan WHERE entity = 'recipes' ORDER BY target_client_id LOOP
    -- S849 GROUP-7: a conflict is reported, never written. GROUP-2 (SU2 a): a skipped dish keeps
    -- everything it has; one that was being adopted is linked and nothing else, so the next push
    -- matches it and the dishes naming it as a sub-recipe find it.
    IF r.action = 'conflict' THEN
      CONTINUE;
    END IF;
    IF r.action = 'skipped' THEN
      UPDATE recipes SET master_id = r.src_id WHERE id = r.dst_id AND master_id IS NULL;
      CONTINUE;
    END IF;

    IF r.dst_id IS NULL THEN
      -- A branch whose VAT status differs (S792 stage 3): no price, the BRANCH's VAT rate (PAN
      -- stores 0, D31; VAT-registered takes the column default 0.13), and off the till until the
      -- owner prices it there — the till bills a NULL price as NPR 0.
      -- S838: the build-your-own mark travels only with the choices it is built from; without
      -- them a marked dish would open an empty choice window on the till.
      -- S849 GROUP-12: the food mark and the description travel with a new dish. The photo does not:
      -- it is a file in HQ's own folder, so the branch adds its own.
      INSERT INTO recipes (client_id, master_id, name, category, selling_price, vat_rate,
                           is_active, yield_qty, yield_uom, target_fc_pct, recipe_code,
                           pos_enabled, hsc_code, is_build_your_own, is_veg, is_egg, description)
      SELECT r.target_client_id, s.id, s.name, s.category,
             CASE WHEN COALESCE(r.vat_differs, false) THEN NULL ELSE s.selling_price END,
             CASE WHEN COALESCE(r.vat_differs, false) THEN CASE WHEN v_hq_vat THEN 0 ELSE 0.13 END
                  ELSE s.vat_rate END,
             s.is_active, s.yield_qty, s.yield_uom, s.target_fc_pct, s.recipe_code,
             -- S809 2h (GAP-OUTLETS-2): one HQ has not priced arrives off the till too, for
             -- the same reason. Otherwise HQ's switch is the new dish's starting point.
             CASE WHEN COALESCE(r.vat_differs, false) THEN false
                  WHEN s.category IS DISTINCT FROM 'Sub-Recipe' AND NOT COALESCE(s.selling_price > 0, false) THEN false
                  ELSE s.pos_enabled END,
             s.hsc_code,
             v_do_opt AND s.is_build_your_own,
             s.is_veg, COALESCE(s.is_egg, false), s.description
        FROM recipes s WHERE s.id = r.src_id
      RETURNING id INTO v_dst;
      UPDATE _plan SET dst_id = v_dst WHERE src_id = r.src_id AND target_client_id = r.target_client_id AND entity = 'recipes';
    ELSE
      -- selling_price only when 'prices' was asked for: a branch may legitimately price above or
      -- below HQ, so it is opt-in rather than swept along with the recipe definition. Neither it
      -- nor vat_rate is written on a branch whose VAT status differs (S792 stage 3).
      -- S809 2h (GAP-OUTLETS-2; owner decision Q25 a, 2026-10-09): is_active and pos_enabled are
      -- the BRANCH's own and are not written. Every push used to copy HQ's, so a dish a branch had
      -- taken off its till (no tandoor there) came back on it, and a dish that arrived off the till
      -- with no price came back on at NPR 0. An item's is_active has been the branch's own since
      -- S792. And a price push never writes a price HQ does not have (NULL or not above 0) over the
      -- branch's own.
      UPDATE recipes d
         SET master_id = s.id, name = s.name, category = s.category,
             vat_rate = CASE WHEN COALESCE(r.vat_differs, false) THEN d.vat_rate ELSE s.vat_rate END,
             yield_qty = s.yield_qty, yield_uom = s.yield_uom,
             target_fc_pct = s.target_fc_pct, recipe_code = s.recipe_code,
             hsc_code = s.hsc_code,
             -- S849 GROUP-12 (SU8 a): the mark describes the ingredient list, which is HQ's after this.
             is_veg = s.is_veg, is_egg = COALESCE(s.is_egg, false),
             selling_price = CASE WHEN v_do_prc AND NOT COALESCE(r.vat_differs, false)
                                       AND COALESCE(s.selling_price > 0, false)
                                  THEN s.selling_price ELSE d.selling_price END,
             is_build_your_own = CASE WHEN v_do_opt THEN s.is_build_your_own ELSE d.is_build_your_own END
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
    -- planner picks a different scan. S838: dropped first, as _plan is.
    DROP TABLE IF EXISTS pg_temp._rec_todo;
    CREATE TEMP TABLE _rec_todo ON COMMIT DROP AS
      SELECT * FROM _plan WHERE entity = 'recipes' AND action IN ('create', 'adopt', 'update') AND dst_id IS NOT NULL;
    FOR r IN SELECT * FROM _rec_todo ORDER BY target_client_id LOOP
      SELECT count(*) INTO v_skipped
        FROM recipe_ingredients ri
        LEFT JOIN items di ON di.client_id = r.target_client_id AND di.master_id = ri.item_id
        LEFT JOIN recipes dr ON dr.client_id = r.target_client_id AND dr.master_id = ri.sub_recipe_id
       WHERE ri.recipe_id = r.src_id
         AND ((ri.item_id IS NOT NULL AND di.id IS NULL) OR (ri.sub_recipe_id IS NOT NULL AND dr.id IS NULL));

      -- S849 GROUP-2 (SU2 a): a branch's list is never shortened. The plan already skipped every dish
      -- with a line that cannot be matched; this is the backstop should the two ever disagree.
      IF v_skipped > 0 AND r.action <> 'create' THEN
        INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, src_id)
        VALUES (r.target_client_id, r.target_client_name, 'ingredients', 'skipped', r.record_name,
                'kept as this branch has it: ' || v_skipped || ' of HQ''s line(s) have no match here, so nothing was removed',
                r.src_id);
        CONTINUE;
      END IF;

      DELETE FROM recipe_ingredients WHERE recipe_id = r.dst_id;

      INSERT INTO recipe_ingredients (recipe_id, item_id, sub_recipe_id, qty_per_portion)
      SELECT r.dst_id, di.id, dr.id, ri.qty_per_portion
        FROM recipe_ingredients ri
        LEFT JOIN items di ON di.client_id = r.target_client_id AND di.master_id = ri.item_id
        LEFT JOIN recipes dr ON dr.client_id = r.target_client_id AND dr.master_id = ri.sub_recipe_id
       WHERE ri.recipe_id = r.src_id
         AND ((ri.item_id IS NOT NULL AND di.id IS NOT NULL) OR (ri.sub_recipe_id IS NOT NULL AND dr.id IS NOT NULL));

      GET DIAGNOSTICS v_lines = ROW_COUNT;
      IF v_skipped > 0 THEN
        -- A new dish: the preview's own partial row gains the count, so it is not listed twice.
        UPDATE _plan SET detail = v_lines || ' line(s) written; ' || detail
         WHERE target_client_id = r.target_client_id AND entity = 'ingredients' AND action = 'partial'
           AND src_id = r.src_id;
        IF NOT FOUND THEN
          INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, src_id)
          VALUES (r.target_client_id, r.target_client_name, 'ingredients', 'partial', r.record_name,
                  v_lines || ' line(s) written, ' || v_skipped || ' left out - ingredient not present at this branch',
                  r.src_id);
        END IF;
      ELSE
        INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail)
        VALUES (r.target_client_id, r.target_client_name, 'ingredients', 'replaced', r.record_name,
                v_lines || ' line(s) written');
      END IF;
    END LOOP;
  END IF;

  -- S838: the choices. This function is SECURITY DEFINER, so guard_pos_option_edit lets these
  -- writes past its rank and Customization-on tests (current_user is the owner) and still checks
  -- that every item, sub-recipe, dish and default named is the branch's own.
  IF v_do_opt THEN
    FOR r IN SELECT * FROM _plan WHERE entity = 'choice groups' AND action IN ('create', 'adopt', 'update')
              ORDER BY target_client_id LOOP
      IF r.dst_id IS NULL THEN
        -- A new group starts switched on or off as it is at HQ; after that the switch is the
        -- branch's own.
        INSERT INTO pos_option_groups (client_id, master_id, name, kitchen_name, kind, min_select, max_select,
                                       included_count, sort, is_active, size_scaling)
        SELECT r.target_client_id, s.id, s.name, s.kitchen_name, s.kind, s.min_select, s.max_select,
               s.included_count, s.sort, s.is_active, s.size_scaling
          FROM pos_option_groups s WHERE s.id = r.src_id
        RETURNING id INTO v_grp;
        UPDATE _plan SET dst_id = v_grp
         WHERE entity = 'choice groups' AND src_id = r.src_id AND target_client_id = r.target_client_id;
      ELSE
        -- A group changing kind: the copies of HQ's choices in it are made to fit first (a Size
        -- holds no "No ..." choice, and only a Size carries a portion size), and take HQ's own
        -- values in the choices pass below. The branch's own choices were checked in the plan.
        IF (SELECT kind FROM pos_option_groups WHERE id = r.dst_id)
           IS DISTINCT FROM (SELECT kind FROM pos_option_groups WHERE id = r.src_id) THEN
          UPDATE pos_options o
             SET is_removal = false, portion_factor = NULL
           WHERE o.group_id = r.dst_id
             AND (o.is_removal OR o.portion_factor IS NOT NULL)
             AND EXISTS (SELECT 1 FROM _plan p
                          WHERE p.entity = 'choices' AND p.target_client_id = r.target_client_id
                            AND p.dst_id = o.id AND p.action IN ('adopt', 'update'));
        END IF;
        UPDATE pos_option_groups d
           SET master_id = s.id, name = s.name, kitchen_name = s.kitchen_name, kind = s.kind,
               min_select = s.min_select, max_select = s.max_select, included_count = s.included_count,
               sort = s.sort, size_scaling = s.size_scaling
          FROM pos_option_groups s WHERE s.id = r.src_id AND d.id = r.dst_id;
      END IF;
    END LOOP;

    UPDATE pos_option_groups d SET is_active = false
      FROM _plan p
     WHERE p.entity = 'choice groups' AND p.action = 'hide' AND d.id = p.dst_id;

    FOR r IN SELECT * FROM _plan WHERE entity = 'choices' AND action IN ('create', 'adopt', 'update')
              ORDER BY target_client_id LOOP
      -- The branch's copy of the choice's HQ group, written just above.
      SELECT d.id INTO v_grp
        FROM pos_options s
        JOIN pos_option_groups d ON d.client_id = r.target_client_id AND d.master_id = s.group_id
       WHERE s.id = r.src_id;
      CONTINUE WHEN v_grp IS NULL;

      IF r.dst_id IS NULL THEN
        INSERT INTO pos_options (client_id, master_id, group_id, name, kitchen_name, price_delta, is_removal,
                                 is_default, diet, allergens, sort, is_active, portion_factor)
        SELECT r.target_client_id, s.id, v_grp, s.name, s.kitchen_name,
               CASE WHEN COALESCE(r.vat_differs, false) THEN 0 ELSE s.price_delta END,
               s.is_removal, s.is_default, s.diet, s.allergens, s.sort,
               CASE WHEN COALESCE(r.vat_differs, false) AND s.price_delta <> 0 THEN false ELSE s.is_active END,
               s.portion_factor
          FROM pos_options s WHERE s.id = r.src_id
        RETURNING id INTO v_opt;
        UPDATE _plan SET dst_id = v_opt
         WHERE entity = 'choices' AND src_id = r.src_id AND target_client_id = r.target_client_id;
      ELSE
        -- is_active is the branch's own (owner 2026-10-14). A "No ..." choice is always free
        -- (pos_options_removal_is_free), whatever the branch had charged for it before.
        UPDATE pos_options d
           SET master_id = s.id, group_id = v_grp, name = s.name, kitchen_name = s.kitchen_name,
               price_delta = CASE WHEN s.is_removal THEN 0
                                  WHEN v_do_prc AND NOT COALESCE(r.vat_differs, false) THEN s.price_delta
                                  ELSE d.price_delta END,
               is_removal = s.is_removal, is_default = s.is_default, diet = s.diet, allergens = s.allergens,
               sort = s.sort, portion_factor = s.portion_factor
          FROM pos_options s WHERE s.id = r.src_id AND d.id = r.dst_id;
      END IF;
    END LOOP;

    UPDATE pos_options d SET is_active = false
      FROM _plan p
     WHERE p.entity = 'choices' AND p.action = 'hide' AND d.id = p.dst_id;

    -- A choice's stock lines: HQ's list, replaced wholesale and remapped, the ingredients rule.
    -- Already scaled lines are not a concern here: the size factor applies at order time.
    DROP TABLE IF EXISTS pg_temp._opt_todo;
    CREATE TEMP TABLE _opt_todo ON COMMIT DROP AS
      SELECT * FROM _plan WHERE entity = 'choices' AND action IN ('create', 'adopt', 'update') AND dst_id IS NOT NULL;
    FOR r IN SELECT * FROM _opt_todo ORDER BY target_client_id LOOP
      SELECT count(*) INTO v_skipped
        FROM pos_option_ingredients oi
        LEFT JOIN items di ON di.client_id = r.target_client_id AND di.master_id = oi.item_id
        LEFT JOIN recipes dr ON dr.client_id = r.target_client_id AND dr.master_id = oi.sub_recipe_id
       WHERE oi.option_id = r.src_id
         AND ((oi.item_id IS NOT NULL AND di.id IS NULL) OR (oi.sub_recipe_id IS NOT NULL AND dr.id IS NULL));

      -- S849 GROUP-2: the ingredients rule. The plan already named this choice; nothing is removed.
      IF v_skipped > 0 AND r.action <> 'create' THEN
        IF NOT EXISTS (SELECT 1 FROM _plan p
                        WHERE p.target_client_id = r.target_client_id AND p.entity = 'choice stock lines'
                          AND p.action = 'skipped' AND p.src_id = r.src_id) THEN
          INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, src_id)
          VALUES (r.target_client_id, r.target_client_name, 'choice stock lines', 'skipped', r.record_name,
                  'kept as this branch has them: ' || v_skipped || ' of HQ''s stock line(s) have no match here, so nothing was removed',
                  r.src_id);
        END IF;
        CONTINUE;
      END IF;

      DELETE FROM pos_option_ingredients WHERE option_id = r.dst_id;
      GET DIAGNOSTICS v_cleared = ROW_COUNT;

      INSERT INTO pos_option_ingredients (client_id, option_id, item_id, sub_recipe_id, qty_per_portion)
      SELECT r.target_client_id, r.dst_id, di.id, dr.id, oi.qty_per_portion
        FROM pos_option_ingredients oi
        LEFT JOIN items di ON di.client_id = r.target_client_id AND di.master_id = oi.item_id
        LEFT JOIN recipes dr ON dr.client_id = r.target_client_id AND dr.master_id = oi.sub_recipe_id
       WHERE oi.option_id = r.src_id
         AND ((oi.item_id IS NOT NULL AND di.id IS NOT NULL) OR (oi.sub_recipe_id IS NOT NULL AND dr.id IS NOT NULL));
      GET DIAGNOSTICS v_lines = ROW_COUNT;

      -- A choice with no stock lines on either side says nothing, or Spice: Mild would fill the
      -- preview.
      IF v_skipped > 0 THEN
        UPDATE _plan SET detail = v_lines || ' line(s) written; ' || detail
         WHERE target_client_id = r.target_client_id AND entity = 'choice stock lines' AND action = 'partial'
           AND src_id = r.src_id;
        IF NOT FOUND THEN
          INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, src_id)
          VALUES (r.target_client_id, r.target_client_name, 'choice stock lines', 'partial', r.record_name,
                  v_lines || ' line(s) written, ' || v_skipped || ' left out - stock item not present at this branch',
                  r.src_id);
        END IF;
      ELSIF v_lines + v_cleared > 0 THEN
        INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail)
        VALUES (r.target_client_id, r.target_client_name, 'choice stock lines', 'replaced', r.record_name,
                v_lines || ' line(s) written');
      END IF;
    END LOOP;

    -- Each pushed dish's groups: HQ's, in HQ's order and with its per-dish rules and default. A
    -- group from HQ that HQ has taken off the dish comes off it here; one the branch made itself
    -- and put on the dish stays. Upserted on (recipe_id, group_id), so a link keeps its row.
    DELETE FROM pos_recipe_option_groups b
     USING _plan rp, pos_option_groups bg
     WHERE rp.entity = 'recipes' AND rp.dst_id IS NOT NULL
       AND rp.action IN ('create', 'adopt', 'update')  -- S849: a skipped dish keeps its own groups
       AND b.recipe_id = rp.dst_id
       AND bg.id = b.group_id AND bg.master_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pos_recipe_option_groups h
                        WHERE h.recipe_id = rp.src_id AND h.group_id = bg.master_id);

    INSERT INTO pos_recipe_option_groups (client_id, recipe_id, group_id, min_override, max_override,
                                          default_option_id, sort)
    SELECT rp.target_client_id, rp.dst_id, dg.id, l.min_override, l.max_override, dopt.id, l.sort
      FROM _plan rp
      JOIN pos_recipe_option_groups l ON l.recipe_id = rp.src_id
      JOIN pos_option_groups dg ON dg.client_id = rp.target_client_id AND dg.master_id = l.group_id
      LEFT JOIN pos_options dopt ON dopt.client_id = rp.target_client_id AND dopt.master_id = l.default_option_id
                                AND dopt.group_id = dg.id
     WHERE rp.entity = 'recipes' AND rp.dst_id IS NOT NULL
       AND rp.action IN ('create', 'adopt', 'update')  -- S849
    ON CONFLICT (recipe_id, group_id) DO UPDATE
       SET min_override = EXCLUDED.min_override, max_override = EXCLUDED.max_override,
           default_option_id = EXCLUDED.default_option_id, sort = EXCLUDED.sort;

    -- S840: combos. A new one starts switched on or off as at HQ, and off when one of its dishes is
    -- not at the branch; after that both switches are the branch's own. Its price and each dish's
    -- extra charge follow "Selling prices" once they exist here. Its picks are HQ's list (a branch
    -- pick of the same name is linked once; any other goes), and each pick's dishes HQ's, by the
    -- branch's copy of each. guard_pos_combo_edit still checks every dish is the branch's own.
    FOR r IN SELECT * FROM _plan WHERE entity = 'combos' AND action IN ('create', 'adopt', 'update')
              ORDER BY target_client_id LOOP
      IF r.dst_id IS NULL THEN
        INSERT INTO pos_combos (client_id, master_id, name, guest_price, description, is_active, on_guest_menu, sort)
        SELECT r.target_client_id, s.id, s.name, s.guest_price, s.description,
               s.is_active AND NOT EXISTS (
                 SELECT 1 FROM pos_combo_groups g JOIN pos_combo_items it ON it.group_id = g.id
                  WHERE g.combo_id = s.id
                    AND NOT EXISTS (SELECT 1 FROM recipes br
                                     WHERE br.client_id = r.target_client_id AND br.master_id = it.recipe_id)),
               s.on_guest_menu, s.sort
          FROM pos_combos s WHERE s.id = r.src_id
        RETURNING id INTO v_cmb;
      ELSE
        UPDATE pos_combos d
           SET master_id = s.id, name = s.name, description = s.description, sort = s.sort,
               guest_price = CASE WHEN v_do_prc THEN s.guest_price ELSE d.guest_price END
          FROM pos_combos s WHERE s.id = r.src_id AND d.id = r.dst_id;
        v_cmb := r.dst_id;
      END IF;

      UPDATE pos_combo_groups bg SET master_id = sg.id
        FROM pos_combo_groups sg
       WHERE bg.combo_id = v_cmb AND bg.master_id IS NULL
         AND sg.combo_id = r.src_id AND lower(btrim(sg.name)) = lower(btrim(bg.name))
         AND NOT EXISTS (SELECT 1 FROM pos_combo_groups b2
                          WHERE b2.client_id = r.target_client_id AND b2.master_id = sg.id);
      DELETE FROM pos_combo_groups bg
       WHERE bg.combo_id = v_cmb
         AND NOT EXISTS (SELECT 1 FROM pos_combo_groups sg WHERE sg.combo_id = r.src_id AND sg.id = bg.master_id);
      -- Names parked first, so two picks can swap names in one push.
      UPDATE pos_combo_groups SET name = id::text WHERE combo_id = v_cmb;
      FOR v_sg IN SELECT * FROM pos_combo_groups WHERE combo_id = r.src_id ORDER BY sort, id LOOP
        v_bg := NULL;
        UPDATE pos_combo_groups SET name = v_sg.name, sort = v_sg.sort
         WHERE combo_id = v_cmb AND master_id = v_sg.id
        RETURNING id INTO v_bg;
        IF v_bg IS NULL THEN
          INSERT INTO pos_combo_groups (client_id, combo_id, master_id, name, sort)
          VALUES (r.target_client_id, v_cmb, v_sg.id, v_sg.name, v_sg.sort)
          RETURNING id INTO v_bg;
        END IF;
        DELETE FROM pos_combo_items bi
         WHERE bi.group_id = v_bg
           AND NOT EXISTS (SELECT 1 FROM pos_combo_items si
                             JOIN recipes br ON br.master_id = si.recipe_id AND br.client_id = r.target_client_id
                            WHERE si.group_id = v_sg.id AND br.id = bi.recipe_id);
        UPDATE pos_combo_items SET is_default = false WHERE group_id = v_bg AND is_default;
        INSERT INTO pos_combo_items (client_id, group_id, recipe_id, extra_price, is_default, sort)
        SELECT r.target_client_id, v_bg, br.id, si.extra_price, si.is_default, si.sort
          FROM pos_combo_items si
          JOIN recipes br ON br.client_id = r.target_client_id AND br.master_id = si.recipe_id
         WHERE si.group_id = v_sg.id
        ON CONFLICT (group_id, recipe_id) DO UPDATE
           SET extra_price = CASE WHEN v_do_prc THEN EXCLUDED.extra_price ELSE pos_combo_items.extra_price END,
               is_default = EXCLUDED.is_default, sort = EXCLUDED.sort;
      END LOOP;
    END LOOP;

    UPDATE pos_combos d SET is_active = false
      FROM _plan p
     WHERE p.entity = 'combos' AND p.action = 'hide' AND d.id = p.dst_id;
  END IF;

  RETURN QUERY
      WITH listed AS (
             -- A preview lists every row; after a push, the rows that need a look (a routine create,
             -- update or replaced list is in the counts).
             SELECT p.* FROM _plan p
              WHERE p_dry_run OR p.action NOT IN ('create', 'update', 'replaced')
           ),
           counted AS (
             SELECT p.target_client_id AS tid, p.target_client_name AS tname, p.entity AS ent, p.action AS act,
                    count(*)::integer AS cnt
               FROM _plan p
              GROUP BY p.target_client_id, p.target_client_name, p.entity, p.action
           ),
           out_rows AS (
             -- The total comes first, so a reply cut short still says how many rows there were.
             SELECT 0 AS grp, 'total'::text AS k, NULL::uuid AS tid, NULL::text AS tname, NULL::text AS ent,
                    NULL::text AS act, NULL::text AS rec, NULL::text AS det,
                    (SELECT count(*) FROM listed)::integer AS cnt
             UNION ALL
             SELECT 1, 'summary', c.tid, c.tname, c.ent, c.act, NULL, NULL, c.cnt FROM counted c
             UNION ALL
             SELECT 2, 'row', l.target_client_id, l.target_client_name, l.entity, l.action, l.record_name, l.detail, NULL
               FROM listed l
           )
      SELECT (row_number() OVER (ORDER BY o.grp, o.tname, o.ent, o.act, o.rec, o.det, o.tid) - 1)::bigint,
             o.k, o.tid, o.tname, o.ent, o.act, o.rec, o.det, o.cnt
        FROM out_rows o
       ORDER BY 1;
END;
$function$;
REVOKE ALL ON FUNCTION public.push_master_data(uuid[], text[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.push_master_data(uuid[], text[], boolean) TO authenticated, service_role;


-- ── 2. The probe, rolled back ─────────────────────────────────────────────────────────────────
-- In the first outlet group with its HQ inside it and a branch, as HQ's Owner. HQ gets four probe
-- items, each with figures (321 kcal) and milk, checked. The branch already has copies of three:
-- one it checked as gluten ("kept"), one it holds as gluten but never checked ("taken"), and one it
-- checked as Not food ("not food"); the fourth ("new") exists only at HQ. After a real push of
-- items: "kept" keeps gluten and its check and takes HQ's 321 kcal; "taken" takes milk, checked;
-- "not food" stays Not food; "new" arrives with HQ's milk, checked. Everything is undone by the
-- sentinel exception.
DO $probe$
DECLARE
  v_group uuid; v_hq uuid; v_br uuid; v_owner uuid; v_txt text;
  v_a uuid; v_b uuid; v_c uuid; v_d uuid;
  v_ba uuid; v_bb uuid; v_bd uuid;
  v_n jsonb;
  v_hq_n  constant jsonb := '{"basis_qty":100,"basis_unit":"GM","energy_kcal":321,"allergens":"milk","allergens_checked":true}';
BEGIN
  SELECT g.id, g.hq_client_id, c.id INTO v_group, v_hq, v_br
    FROM public.client_groups g
    JOIN public.clients h ON h.id = g.hq_client_id AND h.group_id = g.id
    JOIN public.clients c ON c.group_id = g.id AND c.id <> g.hq_client_id
   ORDER BY g.name, c.name
   LIMIT 1;
  IF v_br IS NULL THEN
    RAISE EXCEPTION 'S877 probe: no outlet group with its HQ inside it and a branch';
  END IF;

  BEGIN
    -- ── Setup, as the migration's own role (every guard lets it through) ───────────────────────
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct, nutrition)
      VALUES (v_hq, 'S877 probe kept', 'kg', 1, 0, 100, v_hq_n) RETURNING id INTO v_a;
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct, nutrition)
      VALUES (v_hq, 'S877 probe taken', 'kg', 1, 0, 100, v_hq_n) RETURNING id INTO v_b;
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct, nutrition)
      VALUES (v_hq, 'S877 probe new', 'kg', 1, 0, 100, v_hq_n) RETURNING id INTO v_c;
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct, nutrition)
      VALUES (v_hq, 'S877 probe not food', 'kg', 1, 0, 100, v_hq_n) RETURNING id INTO v_d;
    INSERT INTO public.items (client_id, master_id, name, uom, purchase_qty, rate, yield_pct, nutrition)
      VALUES (v_br, v_a, 'S877 probe kept', 'kg', 1, 0, 100,
              '{"basis_qty":100,"basis_unit":"GM","energy_kcal":5,"allergens":"gluten","allergens_checked":true}')
      RETURNING id INTO v_ba;
    INSERT INTO public.items (client_id, master_id, name, uom, purchase_qty, rate, yield_pct, nutrition)
      VALUES (v_br, v_b, 'S877 probe taken', 'kg', 1, 0, 100,
              '{"basis_qty":100,"basis_unit":"GM","energy_kcal":5,"allergens":"gluten","allergens_checked":false}')
      RETURNING id INTO v_bb;
    INSERT INTO public.items (client_id, master_id, name, uom, purchase_qty, rate, yield_pct, nutrition)
      VALUES (v_br, v_d, 'S877 probe not food', 'kg', 1, 0, 100, '{"not_food":true,"allergens_checked":true}')
      RETURNING id INTO v_bd;

    -- HQ's Owner, whose outlet group is this one.
    FOR v_txt IN SELECT p.id::text FROM public.profiles p WHERE p.client_id = v_hq AND p.role = 'client' ORDER BY p.id LOOP
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_txt)::text, true);
      IF COALESCE(public.is_client_owner(), false) AND public.my_group_id() IS NOT DISTINCT FROM v_group THEN
        v_owner := v_txt::uuid;
        EXIT;
      END IF;
    END LOOP;
    IF v_owner IS NULL THEN
      RAISE EXCEPTION 'S877 probe: no Owner login at HQ in its own group';
    END IF;

    PERFORM * FROM public.push_master_data(ARRAY[v_br], ARRAY['items'], false);
    PERFORM set_config('request.jwt.claims', '', true);

    -- A branch that checked keeps its allergens and its check, and takes HQ's figures.
    SELECT nutrition INTO v_n FROM public.items WHERE id = v_ba;
    IF v_n->>'allergens' IS DISTINCT FROM 'gluten' OR v_n->'allergens_checked' IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'S877 probe: a checked branch item lost its own allergens to the push: %', v_n;
    END IF;
    IF (v_n->>'energy_kcal')::numeric IS DISTINCT FROM 321 THEN
      RAISE EXCEPTION 'S877 probe: a checked branch item did not take HQ''s figures: %', v_n;
    END IF;
    -- A branch that never checked takes HQ's answer.
    SELECT nutrition INTO v_n FROM public.items WHERE id = v_bb;
    IF v_n->>'allergens' IS DISTINCT FROM 'milk' OR v_n->'allergens_checked' IS DISTINCT FROM 'true'::jsonb
       OR (v_n->>'energy_kcal')::numeric IS DISTINCT FROM 321 THEN
      RAISE EXCEPTION 'S877 probe: an unchecked branch item did not take HQ''s allergens: %', v_n;
    END IF;
    -- A branch that checked an item as Not food keeps that answer.
    SELECT nutrition INTO v_n FROM public.items WHERE id = v_bd;
    IF v_n->'not_food' IS DISTINCT FROM 'true'::jsonb OR v_n->'allergens_checked' IS DISTINCT FROM 'true'::jsonb
       OR v_n ? 'allergens' THEN
      RAISE EXCEPTION 'S877 probe: a branch item checked as Not food took HQ''s allergens: %', v_n;
    END IF;
    -- A new item takes HQ's record, as before.
    SELECT nutrition INTO v_n FROM public.items WHERE client_id = v_br AND master_id = v_c;
    IF v_n IS NULL OR v_n->>'allergens' IS DISTINCT FROM 'milk' OR v_n->'allergens_checked' IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'S877 probe: a new branch item did not arrive with HQ''s allergens: %', v_n;
    END IF;

    RAISE EXCEPTION 'S877 probe ok';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'S877 probe ok' THEN RAISE; END IF;
  END;

  PERFORM set_config('request.jwt.claims', '', true);
  IF EXISTS (SELECT 1 FROM public.items WHERE name LIKE 'S877 probe%') THEN
    RAISE EXCEPTION 'S877 probe: its fixtures were not rolled back';
  END IF;
  RAISE NOTICE 'S877 probe: passed and rolled back';
END;
$probe$;


-- ── 3. Read back ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
    FROM pg_proc p WHERE p.oid = 'public.push_master_data(uuid[],text[],boolean)'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'fe0b0df867cc06a27c05469a6159d08e' THEN
    RAISE EXCEPTION 'S877: push_master_data is not this file''s body (md5 %)', v_md5;
  END IF;
  IF has_function_privilege('anon', 'public.push_master_data(uuid[], text[], boolean)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.push_master_data(uuid[], text[], boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.push_master_data(uuid[], text[], boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S877: push_master_data grants are not authenticated and service_role only';
  END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
