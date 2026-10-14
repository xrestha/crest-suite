-- S838: HQ's menu push carries Crest Customization — choice groups, choices, their stock lines, the
-- groups on each dish, and the build-your-own mark.
--
-- Until now push_master_data copied categories, items, recipes and recipe ingredients only, so a
-- branch received HQ's build-your-own bowl as a plain dish with no sizes, toppings or add-ons.
-- A fourth tick box on the Group Console ("Choices") sends p_entities 'options', which needs
-- 'recipes' beside it: the groups hang off dishes, and the stock lines off items and sub-recipes.
--
-- Owner decisions (2026-10-14, asked in plain words):
--   * built now, while only the test group (Bloom Cafe Group) exists;
--   * a choice's price follows the "Selling prices" tick, as a dish's does; a new choice arrives at
--     HQ's price, and a branch whose VAT status differs keeps its own (a new priced choice arrives
--     switched off at no charge, as a new dish arrives off the till unpriced);
--   * whether a group or a choice is switched on is the BRANCH's own after the first push (out of
--     granola today), as a dish's On POS is (S809 2h, Q25 a);
--   * a choice or group HQ has deleted is switched off at the branch, never deleted, so its past
--     bills and the Customization Report keep their names.
--
-- How it follows the existing push (multi-outlet.md):
--   * matched on master_id, never by name, except the one-time adopt of an unlinked branch row of
--     the same name (a group by name in the branch; a choice by name inside its matched group);
--   * a name another branch row already holds is a 'conflict', reported and skipped, so one clash
--     never aborts the push; so is a group whose kind HQ changed while the branch's OWN choices in
--     it no longer fit (a "No ..." choice cannot sit in a Size, only a Size carries a portion size);
--   * a choice's stock lines are HQ's list, replaced wholesale and remapped to the branch's items
--     and sub-recipes; a line with no counterpart is reported ('partial'), never silently dropped;
--   * on a pushed dish, HQ's groups replace the HQ-linked ones; a group the branch made itself and
--     put on the dish stays;
--   * a branch without Customization switched on still gets the copy, and the preview says so;
--   * the preview warns when a choice would take a dish below zero (the till refuses that plate,
--     S816).
--
-- Also: _rec_todo is dropped before it is created, as _plan was in S835 (a second applying call in
-- one transaction failed with 42P07 — the probe below makes three).
--
-- Rebuilt from the LIVE body (md5 checked first). Reversal: re-run section 8 of
-- 20261014110000 over 20261009240000's body, or restore pg_get_functiondef from before this file;
-- then DROP the two master_id columns and their indexes. No row the push writes depends on them.

-- ── 1. The body this file rebuilds is the one it read ─────────────────────────────────────────
DO $$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p
       WHERE p.oid = 'public.push_master_data(uuid[], text[], boolean)'::regprocedure)
     IS DISTINCT FROM '7d934093b1453b707436476cb4f92263' THEN
    RAISE EXCEPTION 'S838: push_master_data changed since this file was written; rebuild it from the live body';
  END IF;
END;
$$;


-- ── 2. A branch's copy of HQ's group or choice ────────────────────────────────────────────────
-- No foreign key, as on categories, items and recipes: the column names ANOTHER client's row, and
-- a deleted HQ choice must leave it standing so the next push can tell the copy was HQ's.
ALTER TABLE public.pos_option_groups ADD COLUMN IF NOT EXISTS master_id uuid;
ALTER TABLE public.pos_options       ADD COLUMN IF NOT EXISTS master_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS pos_option_groups_client_master_key
  ON public.pos_option_groups (client_id, master_id) WHERE master_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pos_options_client_master_key
  ON public.pos_options (client_id, master_id) WHERE master_id IS NOT NULL;


-- ── 3. The push ───────────────────────────────────────────────────────────────────────────────
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
               -- S835: the match is said on its own, and the price clause after it follows a matched
               -- dish too: the apply writes HQ's price over the branch's own when prices are pushed,
               -- and the preview used to stop at the match.
               CASE WHEN d.id IS NULL AND c.id IS NOT NULL THEN 'matched an existing recipe with the same code'
                    WHEN d.id IS NULL AND n.id IS NOT NULL THEN 'matched an existing recipe of the same name' END,
               CASE WHEN v_vat_differs AND s.category IS DISTINCT FROM 'Sub-Recipe' THEN NULL
                    -- S809 2h: what a NEW dish arrives as (the INSERT below copies HQ's price
                    -- whether or not prices were asked for), and a price push never blanks a
                    -- branch's price with one HQ does not have.
                    WHEN COALESCE(d.id, c.id, n.id) IS NULL AND s.category IS DISTINCT FROM 'Sub-Recipe'
                         AND NOT COALESCE(s.selling_price > 0, false)
                      THEN 'added OFF the till with no price: HQ has not priced it yet. Set its price at this branch, then switch it On POS'
                    WHEN COALESCE(d.id, c.id, n.id) IS NULL AND s.category IS DISTINCT FROM 'Sub-Recipe'
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
         AND op.action IS DISTINCT FROM 'conflict'
         AND nd.on_menu
         AND np.price IS NOT NULL AND nd.delta < 0 AND np.price + nd.delta < 0
       ORDER BY rp.src_id, nd.delta;
    END IF;
  END LOOP;

  IF p_dry_run THEN
    RETURN QUERY SELECT p.target_client_id, p.target_client_name, p.entity, p.action, p.record_name, p.detail
                   FROM _plan p ORDER BY p.target_client_name, p.entity, p.action, p.record_name;
    RETURN;
  END IF;

  ----------------------------------------------------------------------------------------------
  -- APPLY, strictly in dependency order: categories, then items (which reference a category),
  -- then recipes, then each recipe's ingredient list (which references both items and recipes),
  -- then the choices (S838: groups, choices, their stock lines, then each dish's groups).
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
      -- S838: the build-your-own mark travels only with the choices it is built from; without
      -- them a marked dish would open an empty choice window on the till.
      INSERT INTO recipes (client_id, master_id, name, category, selling_price, vat_rate,
                           is_active, yield_qty, yield_uom, target_fc_pct, recipe_code,
                           pos_enabled, hsc_code, is_build_your_own)
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
             v_do_opt AND s.is_build_your_own
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
      IF v_lines + v_skipped + v_cleared > 0 THEN
        INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail)
        VALUES (r.target_client_id, r.target_client_name, 'choice stock lines',
                CASE WHEN v_skipped > 0 THEN 'partial' ELSE 'replaced' END, r.record_name,
                v_lines || ' line(s) written'
                  || CASE WHEN v_skipped > 0
                          THEN ', ' || v_skipped || ' skipped - stock item not present at this branch'
                          ELSE '' END);
      END IF;
    END LOOP;

    -- Each pushed dish's groups: HQ's, in HQ's order and with its per-dish rules and default. A
    -- group from HQ that HQ has taken off the dish comes off it here; one the branch made itself
    -- and put on the dish stays. Upserted on (recipe_id, group_id), so a link keeps its row.
    DELETE FROM pos_recipe_option_groups b
     USING _plan rp, pos_option_groups bg
     WHERE rp.entity = 'recipes' AND rp.dst_id IS NOT NULL
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
    ON CONFLICT (recipe_id, group_id) DO UPDATE
       SET min_override = EXCLUDED.min_override, max_override = EXCLUDED.max_override,
           default_option_id = EXCLUDED.default_option_id, sort = EXCLUDED.sort;
  END IF;

  RETURN QUERY SELECT p.target_client_id, p.target_client_name, p.entity, p.action, p.record_name, p.detail
                 FROM _plan p ORDER BY p.target_client_name, p.entity, p.action, p.record_name;
END;
$function$;


-- ── 4. The probe, rolled back ─────────────────────────────────────────────────────────────────
-- In the first outlet group with Customization on at HQ and a branch of the same VAT status (the
-- Bloom Cafe Group), as HQ's Owner. HQ gets a build-your-own bowl priced 300 with a Size (a
-- Small at -400, so the preview must warn) and Toppings (Granola +60 with a stock line on an HQ
-- item the branch has a copy of, and a "No honey"). Pushed, re-pushed after HQ edits and the
-- branch switching Granola off, then pushed with prices. Everything is undone by the sentinel.
DO $probe$
DECLARE
  v_hq uuid; v_br uuid; v_owner uuid; v_cat text;
  v_item uuid; v_bitem uuid;
  v_dish uuid; v_gs uuid; v_gt uuid; v_small uuid; v_reg uuid; v_gran uuid; v_honey uuid;
  v_bdish uuid; v_bgs uuid; v_bgt uuid; v_breg uuid; v_bgran uuid; v_bhoney uuid; v_bown uuid;
  v_n integer; v_m integer; v_b boolean; v_num numeric; v_txt text;
BEGIN
  SELECT g.hq_client_id, c.id INTO v_hq, v_br
    FROM public.client_groups g
    JOIN public.clients c ON c.group_id = g.id AND c.id <> g.hq_client_id
   WHERE COALESCE(public.customization_live(g.hq_client_id), false)
     AND COALESCE(public.customization_live(c.id), false)
     AND COALESCE((SELECT s.is_vat_registered FROM public.settings s WHERE s.client_id = g.hq_client_id), true)
         = COALESCE((SELECT s.is_vat_registered FROM public.settings s WHERE s.client_id = c.id), true)
   ORDER BY g.name, c.name
   LIMIT 1;
  IF v_br IS NULL THEN
    RAISE EXCEPTION 'S838 probe: no outlet group with Crest Customization on at HQ and at a branch of the same VAT status';
  END IF;

  SELECT s.id, d.id INTO v_item, v_bitem
    FROM public.items s
    JOIN public.items d ON d.client_id = v_br AND d.master_id = s.id
   WHERE s.client_id = v_hq AND NOT COALESCE(s.is_sub_recipe, false)
   ORDER BY s.name
   LIMIT 1;
  IF v_bitem IS NULL THEN
    RAISE EXCEPTION 'S838 probe: no HQ item with a copy at the branch';
  END IF;

  SELECT r.category INTO v_cat
    FROM public.recipes r
   WHERE r.client_id = v_hq AND r.category IS NOT NULL AND r.category <> 'Sub-Recipe'
   ORDER BY r.name
   LIMIT 1;

  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO public.recipes (client_id, name, category, selling_price, is_active, pos_enabled, is_build_your_own, yield_qty)
    VALUES (v_hq, 'S838 probe bowl', COALESCE(v_cat, 'Food'), 300, true, true, true, 1)
    RETURNING id INTO v_dish;
    INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select, sort)
    VALUES (v_hq, 'S838 probe · Size', 'size', 1, 1, 900) RETURNING id INTO v_gs;
    INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select, sort, size_scaling)
    VALUES (v_hq, 'S838 probe · Toppings', 'addon', 0, NULL, 901, 'stock_and_price') RETURNING id INTO v_gt;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, portion_factor, sort)
    VALUES (v_hq, v_gs, 'Small', -400, 0.75, 0) RETURNING id INTO v_small;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, portion_factor, sort, is_default)
    VALUES (v_hq, v_gs, 'Regular', 0, 1, 1, true) RETURNING id INTO v_reg;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort)
    VALUES (v_hq, v_gt, 'Granola', 60, 0) RETURNING id INTO v_gran;
    INSERT INTO public.pos_options (client_id, group_id, name, is_removal, sort)
    VALUES (v_hq, v_gt, 'No honey', true, 1) RETURNING id INTO v_honey;
    INSERT INTO public.pos_option_ingredients (client_id, option_id, item_id, qty_per_portion)
    VALUES (v_hq, v_gran, v_item, 30);
    INSERT INTO public.pos_recipe_option_groups (client_id, recipe_id, group_id, default_option_id, sort)
    VALUES (v_hq, v_dish, v_gs, v_reg, 0);
    INSERT INTO public.pos_recipe_option_groups (client_id, recipe_id, group_id, max_override, sort)
    VALUES (v_hq, v_dish, v_gt, 3, 1);

    -- HQ's Owner.
    FOR v_txt IN SELECT p.id::text FROM public.profiles p WHERE p.client_id = v_hq AND p.role = 'client' ORDER BY p.id LOOP
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_txt)::text, true);
      IF COALESCE(public.is_client_owner(), false) THEN v_owner := v_txt::uuid; EXIT; END IF;
    END LOOP;
    IF v_owner IS NULL THEN
      RAISE EXCEPTION 'S838 probe: no Owner login at HQ';
    END IF;

    -- Choices without their dishes are refused.
    BEGIN
      PERFORM * FROM public.push_master_data(ARRAY[v_br], ARRAY['options'], true);
      RAISE EXCEPTION 'S838 probe: choices were pushed without their dishes';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'Choices are pushed with their dishes%' THEN RAISE; END IF;
    END;

    -- The preview: four new choices, the below-zero warning, nothing written.
    SELECT count(*) FILTER (WHERE p.entity = 'dish choices' AND p.action = 'warning' AND p.record_name = 'S838 probe bowl'
                              AND p.detail LIKE '"Small" (-400.00)%'),
           count(*) FILTER (WHERE p.entity = 'choices' AND p.action = 'create' AND p.record_name LIKE 'S838 probe%')
      INTO v_n, v_m
      FROM public.push_master_data(ARRAY[v_br], ARRAY['recipes', 'options'], true) p;
    IF v_n <> 1 OR v_m <> 4 THEN
      RAISE EXCEPTION 'S838 probe: the preview showed % below-zero warning(s) and % new choice(s)', v_n, v_m;
    END IF;
    IF EXISTS (SELECT 1 FROM public.pos_option_groups WHERE client_id = v_br AND name LIKE 'S838 probe%') THEN
      RAISE EXCEPTION 'S838 probe: the preview wrote to the branch';
    END IF;

    -- The push.
    SELECT count(*) FILTER (WHERE p.action = 'conflict'), count(*)
      INTO v_n, v_m
      FROM public.push_master_data(ARRAY[v_br], ARRAY['recipes', 'options'], false) p;
    RAISE NOTICE 'S838 probe: first push returned % row(s), % conflict(s)', v_m, v_n;

    SELECT id, is_build_your_own, selling_price INTO v_bdish, v_b, v_num
      FROM public.recipes WHERE client_id = v_br AND master_id = v_dish;
    IF v_bdish IS NULL OR NOT v_b OR v_num IS DISTINCT FROM 300 THEN
      RAISE EXCEPTION 'S838 probe: the bowl reached the branch as % (build-your-own %, price %)', v_bdish, v_b, v_num;
    END IF;
    SELECT id INTO v_bgs FROM public.pos_option_groups
     WHERE client_id = v_br AND master_id = v_gs AND kind = 'size' AND size_scaling = 'none';
    SELECT id INTO v_bgt FROM public.pos_option_groups
     WHERE client_id = v_br AND master_id = v_gt AND kind = 'addon' AND size_scaling = 'stock_and_price';
    IF v_bgs IS NULL OR v_bgt IS NULL THEN
      RAISE EXCEPTION 'S838 probe: the groups did not reach the branch as HQ has them';
    END IF;
    SELECT id INTO v_breg FROM public.pos_options
     WHERE client_id = v_br AND master_id = v_reg AND group_id = v_bgs AND portion_factor = 1 AND is_default;
    SELECT id INTO v_bgran FROM public.pos_options
     WHERE client_id = v_br AND master_id = v_gran AND group_id = v_bgt AND price_delta = 60 AND is_active;
    SELECT id INTO v_bhoney FROM public.pos_options
     WHERE client_id = v_br AND master_id = v_honey AND group_id = v_bgt AND is_removal AND is_active;
    IF v_breg IS NULL OR v_bgran IS NULL OR v_bhoney IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.pos_options
                       WHERE client_id = v_br AND master_id = v_small AND price_delta = -400 AND portion_factor = 0.75) THEN
      RAISE EXCEPTION 'S838 probe: the choices did not reach the branch as HQ has them';
    END IF;
    IF (SELECT count(*) FROM public.pos_option_ingredients WHERE option_id = v_bgran) <> 1
       OR NOT EXISTS (SELECT 1 FROM public.pos_option_ingredients
                       WHERE option_id = v_bgran AND client_id = v_br AND item_id = v_bitem AND qty_per_portion = 30) THEN
      RAISE EXCEPTION 'S838 probe: Granola''s stock line did not map to the branch''s own item';
    END IF;
    IF (SELECT count(*) FROM public.pos_recipe_option_groups WHERE recipe_id = v_bdish) <> 2
       OR NOT EXISTS (SELECT 1 FROM public.pos_recipe_option_groups
                       WHERE recipe_id = v_bdish AND group_id = v_bgs AND default_option_id = v_breg AND sort = 0)
       OR NOT EXISTS (SELECT 1 FROM public.pos_recipe_option_groups
                       WHERE recipe_id = v_bdish AND group_id = v_bgt AND max_override = 3 AND sort = 1) THEN
      RAISE EXCEPTION 'S838 probe: the bowl''s choice groups at the branch are not HQ''s';
    END IF;

    -- Pushing again changes nothing into something new: every group and choice is now linked
    -- (or still a reported conflict), so a second preview creates and adopts none.
    SELECT count(*) INTO v_n
      FROM public.push_master_data(ARRAY[v_br], ARRAY['recipes', 'options'], true) p
     WHERE p.entity IN ('choice groups', 'choices') AND p.action IN ('create', 'adopt');
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S838 probe: a second preview would create or adopt % group(s) or choice(s) again', v_n;
    END IF;

    -- HQ edits: Granola up to 80, "No honey" deleted, Toppings renamed. The branch switches its
    -- Granola off. Pushed WITHOUT prices.
    PERFORM set_config('request.jwt.claims', '', true);
    UPDATE public.pos_options SET price_delta = 80 WHERE id = v_gran;
    DELETE FROM public.pos_options WHERE id = v_honey;
    UPDATE public.pos_option_groups SET name = 'S838 probe · Extras' WHERE id = v_gt;
    UPDATE public.pos_options SET is_active = false WHERE id = v_bgran;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    PERFORM * FROM public.push_master_data(ARRAY[v_br], ARRAY['recipes', 'options'], false);

    IF NOT EXISTS (SELECT 1 FROM public.pos_options WHERE id = v_bgran AND price_delta = 60 AND NOT is_active) THEN
      RAISE EXCEPTION 'S838 probe: without prices, the branch''s Granola did not keep its price and its switch';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.pos_options WHERE id = v_bhoney AND NOT is_active) THEN
      RAISE EXCEPTION 'S838 probe: the choice HQ deleted was not switched off at the branch';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.pos_option_groups WHERE id = v_bgt AND name = 'S838 probe · Extras') THEN
      RAISE EXCEPTION 'S838 probe: HQ''s renamed group was not renamed at the branch';
    END IF;
    IF (SELECT count(*) FROM public.pos_options WHERE client_id = v_br AND master_id IN (v_small, v_reg, v_gran, v_honey)) <> 4
       OR (SELECT count(*) FROM public.pos_option_groups WHERE client_id = v_br AND master_id IN (v_gs, v_gt)) <> 2 THEN
      RAISE EXCEPTION 'S838 probe: a second push doubled the branch''s groups or choices';
    END IF;

    -- HQ takes Extras off the bowl; the branch puts a group of its own on it. Pushed WITH prices.
    PERFORM set_config('request.jwt.claims', '', true);
    DELETE FROM public.pos_recipe_option_groups WHERE recipe_id = v_dish AND group_id = v_gt;
    INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select, sort)
    VALUES (v_br, 'S838 probe · Branch sauce', 'choice', 0, 1, 902) RETURNING id INTO v_bown;
    INSERT INTO public.pos_recipe_option_groups (client_id, recipe_id, group_id, sort)
    VALUES (v_br, v_bdish, v_bown, 5);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    PERFORM * FROM public.push_master_data(ARRAY[v_br], ARRAY['recipes', 'prices', 'options'], false);

    IF NOT EXISTS (SELECT 1 FROM public.pos_options WHERE id = v_bgran AND price_delta = 80 AND NOT is_active) THEN
      RAISE EXCEPTION 'S838 probe: with prices, the branch''s Granola did not take HQ''s price, or came back on';
    END IF;
    IF EXISTS (SELECT 1 FROM public.pos_recipe_option_groups WHERE recipe_id = v_bdish AND group_id = v_bgt)
       OR NOT EXISTS (SELECT 1 FROM public.pos_recipe_option_groups WHERE recipe_id = v_bdish AND group_id = v_bown)
       OR NOT EXISTS (SELECT 1 FROM public.pos_recipe_option_groups WHERE recipe_id = v_bdish AND group_id = v_bgs) THEN
      RAISE EXCEPTION 'S838 probe: the bowl''s groups at the branch did not follow HQ while keeping the branch''s own';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.pos_option_groups WHERE id = v_bown AND master_id IS NULL AND is_active) THEN
      RAISE EXCEPTION 'S838 probe: the push touched a group the branch made itself';
    END IF;

    RAISE EXCEPTION 'S838 probe ok';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'S838 probe ok' THEN RAISE; END IF;
  END;

  PERFORM set_config('request.jwt.claims', '', true);
  IF EXISTS (SELECT 1 FROM public.recipes WHERE name = 'S838 probe bowl')
     OR EXISTS (SELECT 1 FROM public.pos_option_groups WHERE name LIKE 'S838 probe%') THEN
    RAISE EXCEPTION 'S838 probe: its fixtures were not rolled back';
  END IF;
  RAISE NOTICE 'S838 probe: passed and rolled back';
END;
$probe$;


-- ── 5. Read back ──────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.push_master_data(uuid[], text[], boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S838: push_master_data is callable without signing in';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[1]
                  WHERE i.indexrelid = 'public.pos_options_client_master_key'::regclass AND a.attname = 'master_id')
     OR NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[1]
                     WHERE i.indexrelid = 'public.pos_option_groups_client_master_key'::regclass AND a.attname = 'master_id') THEN
    RAISE EXCEPTION 'S838: a master_id index is not on (client_id, master_id)';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
