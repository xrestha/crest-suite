-- S840: the POS leftovers from S838/S839 (POS_TODO A and S809.4), in one file.
--
--   1. HQ's master-data push carries combos with the choices (push_master_data). Owner decisions
--      (2026-10-15): the same rules as choices — a combo's price follows "Selling prices" once it
--      exists at a branch, its switches are the branch's own, one HQ deleted is switched off there —
--      and a NEW combo whose dish is not at the branch arrives switched off, the preview naming the
--      dish. pos_combos / pos_combo_groups gain master_id.
--   2. No double kitchen ticket (ORDER-FLOW-4's residual). save_pos_order_items takes a client-minted
--      p_save_id and keeps the last 50 on pos_orders.recent_saves as {id, v}; a retry of a save that
--      landed answers the order as it stands (duplicate: true). The till judges its own unanswered
--      save by its id, not by the dishes looking like its own. The 4-arg form is dropped (a call
--      without the id resolves through the default). guard_pos_order_close and
--      guard_pos_order_insert keep recent_saves the RPC's own.
--   3. A hidden choice counts nowhere: save_pos_order_items' and pos_price_selection's per-group
--      counts join only active options (option_not_on_menu already refused them first).
--   4. get_client_profile_names(p_client_id, p_ids): Crest support's row only for the ids a screen
--      asks about, never every operator id to every client (S819 4k's leak, parked in S835). The
--      1-arg form is dropped.
--   5. log_audit() drops the dead pos_device_secret strip (the column left clients in S531).
--
-- Every rebuilt body is checked against the live body it was written from (md5), then replaced whole
-- (push_master_data, save_pos_order_items, get_client_profile_names) or patched at named anchors.
-- The probe at the end runs each part at BLOOM CAFE / Bloom Cafe Group and is rolled back.
--
-- Reversal: restore the six bodies from pg_get_functiondef before this file (the 4-arg save and the
-- 1-arg names function re-created), drop pos_orders.recent_saves, pos_order_items_json and the two
-- master_id columns with their indexes.


-- ── 0. The bodies this file rebuilds are the ones it read ──────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.save_pos_order_items(uuid,jsonb,text,integer)', '7340385786d93183cb0b4771cb684bb3'),
      ('public.push_master_data(uuid[],text[],boolean)',       '21fbb97e5a79c1a2cd1560bc9a50da77'),
      ('public.pos_price_selection(uuid,uuid,uuid[])',         '36fc3c77bbd675450216d19b63703c10'),
      ('public.get_client_profile_names(uuid)',                '1aba42084b1feab9d1cc617a0490a801'),
      ('public.log_audit()',                                   'ce02b83bbffc3912eb755b3c7a1b3686'),
      ('public.guard_pos_order_close()',                       'c99b5a758c59213c1f5aa1c60a4580d4'),
      ('public.guard_pos_order_insert()',                      '9a861b3c577ee0cab90cde9986b999bc')
    ) AS t(sig, md5)
  LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = r.sig::regprocedure) IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'S840: % changed since this file was written; rebuild it from the live body', r.sig;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.s840_patch(p_def text, p_old text, p_new text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_n integer := (length(p_def) - length(replace(p_def, p_old, ''))) / NULLIF(length(p_old), 0);
BEGIN
  IF v_n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'S840: a patch anchor was found % times: %', COALESCE(v_n, 0), left(p_old, 120);
  END IF;
  RETURN replace(p_def, p_old, p_new);
END;
$$;


-- ── 1. HQ's push carries combos ───────────────────────────────────────────────────────────────
-- No foreign key, as on the option tables: the column names another client's row, and a deleted HQ
-- combo must leave it standing so the next push can tell the copy was HQ's.
ALTER TABLE public.pos_combos       ADD COLUMN IF NOT EXISTS master_id uuid;
ALTER TABLE public.pos_combo_groups ADD COLUMN IF NOT EXISTS master_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS pos_combos_client_master_key
  ON public.pos_combos (client_id, master_id) WHERE master_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pos_combo_groups_client_master_key
  ON public.pos_combo_groups (client_id, master_id) WHERE master_id IS NOT NULL;

-- The S838 body with the S840 combo sections marked.
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
                              WHERE rq.target_client_id = v_target AND rq.entity = 'recipes' AND rq.src_id = it.recipe_id)
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

  RETURN QUERY SELECT p.target_client_id, p.target_client_name, p.entity, p.action, p.record_name, p.detail
                 FROM _plan p ORDER BY p.target_client_name, p.entity, p.action, p.record_name;
END;
$function$;


-- ── 2. No double kitchen ticket: a save carries its own id ────────────────────────────────────
ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS recent_saves jsonb NOT NULL DEFAULT '[]'::jsonb;

-- The order's lines as the save answers them, shared by its ordinary and its duplicate answer.
CREATE OR REPLACE FUNCTION public.pos_order_items_json(p_order_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', i.id, 'recipe_id', i.recipe_id, 'name', i.name, 'category', i.category,
           'qty', i.qty, 'unit_price', i.unit_price, 'vat_rate', i.vat_rate,
           'sent_to_kot', i.sent_to_kot, 'sent_qty', i.sent_qty, 'notes', i.notes,
           'selection_key', i.selection_key, 'base_unit_price', i.base_unit_price,
           'options_delta', i.options_delta, 'option_summary', i.option_summary,
           -- S839
           'combo_line_id', i.combo_line_id, 'combo_id', i.combo_id, 'combo_name', i.combo_name,
           'combo_price', i.combo_price, 'combo_group_id', i.combo_group_id,
           'combo_group_name', i.combo_group_name, 'combo_sort', i.combo_sort,
           'options', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                         'option_id', x.option_id, 'group_id', x.group_id, 'group_name', x.group_name,
                         'group_kind', x.group_kind, 'option_name', x.option_name, 'kitchen_name', x.kitchen_name,
                         'is_removal', x.is_removal, 'price_delta', x.price_delta, 'included', x.included,
                         'ingredient_deltas', x.ingredient_deltas) ORDER BY x.sort, x.id)
                         FROM pos_order_item_options x WHERE x.order_item_id = i.id), '[]'::jsonb))
           ORDER BY i.created_at, i.id), '[]'::jsonb)
    FROM pos_order_items i WHERE i.order_id = p_order_id;
$function$;
REVOKE ALL ON FUNCTION public.pos_order_items_json(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_order_items_json(uuid) TO authenticated, service_role;

-- The S839 body with the S840 changes marked: the save id, its duplicate answer, recent_saves, the
-- shared items read, and hidden picks counted nowhere. Appending a defaulted parameter would fork the
-- function (supabase-sql.md), so the 4-arg form is dropped first.
DROP FUNCTION public.save_pos_order_items(uuid, jsonb, text, integer);
CREATE FUNCTION public.save_pos_order_items(p_order_id uuid, p_rows jsonb, p_removal_reason text DEFAULT NULL::text, p_expected_version integer DEFAULT NULL::integer, p_save_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id uuid;
  v_status    text;
  v_version   integer;
  v_vat_reg   boolean;
  v_inserted  integer := 0;
  v_bad       text;
  v_items     jsonb;
  v_prev      jsonb;
  v_rows      jsonb;
  v_opt       jsonb;
  v_existing  text[];
  v_any_opts  boolean;
  v_cust      boolean;   -- S809 2h: Crest Customization is live at this outlet
  v_any_combo boolean;   -- S839
  v_combo     jsonb;     -- S839: priced new combo dishes, by the minted line id
  v_recent    jsonb;     -- S840: this order's recent save ids
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'p_order_id is required';
  END IF;

  IF p_rows IS NOT NULL AND jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a json array';
  END IF;

  -- client_id is derived from the order, never taken as a parameter. RLS hides another client's
  -- order, which reads as not found.
  SELECT client_id, status, items_version, recent_saves
    INTO v_client_id, v_status, v_version, v_recent
    FROM pos_orders WHERE id = p_order_id
    FOR UPDATE;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'order not found or not visible: %', p_order_id;
  END IF;

  IF v_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'order_not_open: this bill is already closed, so its items cannot be changed — reload the floor'
      USING ERRCODE = 'P0001', HINT = 'order_not_open';
  END IF;

  -- S840 (ORDER-FLOW-4's residual): a save this order already took — a retry whose first answer was
  -- lost — is not saved again; it answers the order as it stands, so the till that sent it knows it
  -- landed. Checked before the version, which the first landing moved.
  IF p_save_id IS NOT NULL AND COALESCE(v_recent, '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', p_save_id)) THEN
    RETURN jsonb_build_object('inserted', 0, 'items_version', v_version, 'duplicate', true,
                              'items', public.pos_order_items_json(p_order_id));
  END IF;

  IF p_expected_version IS NOT NULL AND p_expected_version IS DISTINCT FROM v_version THEN
    RAISE EXCEPTION 'stale_order: this order was changed on another device since it was opened here — reload it before saving'
      USING ERRCODE = 'P0001', HINT = 'stale_order',
            DETAIL = format('expected version %s, current version %s', p_expected_version, v_version);
  END IF;

  -- ── Validate the incoming lines ────────────────────────────────────────────────────────────
  SELECT string_agg(DISTINCT reason, '; ') INTO v_bad
    FROM (
      SELECT CASE
               WHEN NULLIF(r->>'recipe_id', '') IS NULL THEN 'a line with no menu item'
               WHEN COALESCE((r->>'qty')::integer, 1) < 1 THEN format('%s with a quantity below 1', COALESCE(r->>'name', 'a line'))
               WHEN r ? 'options' AND jsonb_typeof(r->'options') NOT IN ('array', 'null') THEN format('%s with unreadable options', COALESCE(r->>'name', 'a line'))
             END AS reason
        FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) AS r
    ) x
   WHERE reason IS NOT NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'line_not_on_menu: %', v_bad USING ERRCODE = 'P0001', HINT = 'line_not_on_menu';
  END IF;

  -- S839: a combo is named by three uuids, or the row is refused before anything is read.
  SELECT string_agg(DISTINCT COALESCE(r->>'name', 'a dish'), ', ') INTO v_bad
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) AS r
   WHERE r ? 'combo' AND jsonb_typeof(r->'combo') <> 'null'
     AND NOT COALESCE(jsonb_typeof(r->'combo') = 'object'
                      AND (r->'combo'->>'line_id')  ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      AND (r->'combo'->>'combo_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      AND (r->'combo'->>'group_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'combo_incomplete: % does not say which combo it belongs to — remove the combo and add it again', v_bad
      USING ERRCODE = 'P0001', HINT = 'combo_incomplete';
  END IF;

  -- Normalise every row once: its chosen option ids (distinct, sorted as text — the same order
  -- JavaScript's default sort gives lowercase uuids), its selection key, its line key, and an id
  -- minted now so the options snapshot can be linked to the line it belongs to.
  -- S839: a combo dish's key ends '@<combo_line_id>/<combo_group_id>' (lowercase), after its options.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id',             gen_random_uuid(),
           'n',              x.n,
           'src',            x.v,
           'recipe_id',      x.recipe_id,
           'has_options',    cardinality(x.opt_ids) > 0,
           'option_ids',     to_jsonb(x.opt_ids),
           'combo_line_id',  x.combo_line_id,
           'combo_id',       x.combo_id,
           'combo_group_id', x.combo_group_id,
           'selection_key',  x.sel,
           'line_key',       x.recipe_id || CASE WHEN x.sel <> '' THEN '#' || x.sel ELSE '' END
         ) ORDER BY x.n), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT y.*,
             array_to_string(y.opt_ids, '+')
               || CASE WHEN y.combo_line_id IS NOT NULL THEN '@' || y.combo_line_id || '/' || y.combo_group_id ELSE '' END AS sel
        FROM (
          SELECT r.n, r.v, NULLIF(r.v->>'recipe_id', '') AS recipe_id,
                 COALESCE((
                   SELECT array_agg(o ORDER BY o COLLATE "C")
                     FROM (SELECT DISTINCT lower(e)::uuid::text AS o
                             FROM jsonb_array_elements_text(
                                    CASE WHEN jsonb_typeof(r.v->'options') = 'array' THEN r.v->'options' ELSE '[]'::jsonb END) e) d
                 ), ARRAY[]::text[]) AS opt_ids,
                 CASE WHEN jsonb_typeof(r.v->'combo') = 'object' THEN lower(r.v->'combo'->>'line_id')  END AS combo_line_id,
                 CASE WHEN jsonb_typeof(r.v->'combo') = 'object' THEN lower(r.v->'combo'->>'combo_id') END AS combo_id,
                 CASE WHEN jsonb_typeof(r.v->'combo') = 'object' THEN lower(r.v->'combo'->>'group_id') END AS combo_group_id
            FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY AS r(v, n)
        ) y
    ) x;

  v_any_opts  := EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE (r->>'has_options')::boolean);
  v_any_combo := EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'combo_line_id' IS NOT NULL);

  -- Line keys already on this order: an existing line keeps its price and snapshot, a new one is
  -- checked against today's menu.
  SELECT COALESCE(array_agg(recipe_id::text || CASE WHEN selection_key <> '' THEN '#' || selection_key ELSE '' END), ARRAY[]::text[])
    INTO v_existing
    FROM pos_order_items WHERE order_id = p_order_id AND recipe_id IS NOT NULL;

  -- A NEW line (a recipe not already on this order) must be on the till menu. S839: a combo dish need
  -- not be On POS on its own (a side sold only in combos); the combo check below decides it.
  SELECT string_agg(DISTINCT COALESCE(rec.name, r->'src'->>'name', r->>'recipe_id'), ', ') INTO v_bad
    FROM jsonb_array_elements(v_rows) AS r
    LEFT JOIN recipes rec
           ON rec.id = (r->>'recipe_id')::uuid
          AND rec.client_id = v_client_id
   WHERE NOT EXISTS (SELECT 1 FROM pos_order_items i
                      WHERE i.order_id = p_order_id AND i.recipe_id = (r->>'recipe_id')::uuid)
     AND NOT COALESCE(rec.id IS NOT NULL
                      AND rec.is_active IS NOT FALSE
                      AND (rec.pos_enabled IS NOT FALSE OR r->>'combo_line_id' IS NOT NULL)
                      AND rec.category IS DISTINCT FROM 'Sub-Recipe', false);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'line_not_on_menu: % is not on the menu any more — remove it from the order and save again', v_bad
      USING ERRCODE = 'P0001', HINT = 'line_not_on_menu';
  END IF;

  -- S809 2h (GAP-OUTLETS-2): a NEW line needs a menu price above zero. A dish with none was billed
  -- at NPR 0 (the price below is COALESCE(selling_price, 0)): a dish an HQ push added to a branch
  -- with no price and the next push switched back On POS, or a recipe saved On POS before anyone
  -- priced it. The guest order already treats such a dish as unavailable (submit_guest_order:
  -- selling_price > 0) and the guest menu leaves it out; the till's menu read leaves it out too
  -- since S809 2h. Same code as a dish not on the menu, which every till build already handles: it
  -- re-reads its menu, shows this sentence after "Not saved —", and an offline replay lists the line
  -- with the other off-menu lines. Keyed on the LINE, as the price itself is: a line already on the
  -- order keeps the price it was saved with, so clearing a price mid-meal does not lock the order.
  -- S839: a combo dish is priced from its combo's split, not its own menu price.
  SELECT string_agg(DISTINCT COALESCE(rec.name, r->'src'->>'name', r->>'recipe_id'), ', ') INTO v_bad
    FROM jsonb_array_elements(v_rows) AS r
    JOIN recipes rec
      ON rec.id = (r->>'recipe_id')::uuid
     AND rec.client_id = v_client_id
   WHERE NOT (r->>'line_key') = ANY (v_existing)
     AND r->>'combo_line_id' IS NULL
     AND NOT COALESCE(rec.selling_price > 0, false);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'line_not_on_menu: % has no menu price yet, so it cannot be billed — remove it from the order and save again, and ask a manager to price it in Menu Pricing', v_bad
      USING ERRCODE = 'P0001', HINT = 'line_not_on_menu';
  END IF;

  -- ── Options on NEW lines ───────────────────────────────────────────────────────────────────
  v_cust := public.customization_live(v_client_id);
  IF v_any_opts THEN
    IF NOT v_cust AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_rows) r
          WHERE (r->>'has_options')::boolean AND NOT (r->>'line_key') = ANY (v_existing)) THEN
      RAISE EXCEPTION 'order_options_off: Crest Customization is not switched on for this outlet, so dishes cannot be ordered with options'
        USING ERRCODE = 'P0001', HINT = 'order_options_off';
    END IF;

    -- Every chosen option is this outlet's, offered, and in a group this dish offers.
    SELECT string_agg(DISTINCT COALESCE(rec.name, r->>'recipe_id'), ', ') INTO v_bad
      FROM jsonb_array_elements(v_rows) r
      CROSS JOIN LATERAL jsonb_array_elements_text(r->'option_ids') e
      LEFT JOIN recipes rec ON rec.id = (r->>'recipe_id')::uuid
     WHERE (r->>'has_options')::boolean
       AND NOT (r->>'line_key') = ANY (v_existing)
       AND NOT EXISTS (
             SELECT 1
               FROM pos_options o
               JOIN pos_option_groups g ON g.id = o.group_id
               JOIN pos_recipe_option_groups a ON a.group_id = g.id AND a.recipe_id = (r->>'recipe_id')::uuid
              WHERE o.id = e::uuid AND o.client_id = v_client_id AND o.is_active AND g.is_active);
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'option_not_on_menu: an option chosen for % is no longer offered on it — change the choices and save again', v_bad
        USING ERRCODE = 'P0001', HINT = 'option_not_on_menu';
    END IF;
  END IF;

  -- Every group the dish offers gets a number of picks its rule allows. A group with no offered
  -- options is skipped: a guest cannot be made to choose from nothing.
  -- S809 2h (CUSTOMIZATION-3): every NEW line of a dish is counted, not only a line that sends
  -- options. A line sent with none counts 0 in each group, so a dish that must have a size or a base
  -- can no longer be saved plain and billed at the dish's own price with nothing for the kitchen (a
  -- till whose menu was read before the dish had choices, an offline till's saved copy, a hand-made
  -- call). submit_guest_order already checks a customizable dish "picks or not", so the two server
  -- copies of the rule now agree, including that it applies only while Customization is live: with
  -- the module off a dish orders plain, whatever groups are still attached. A line already on the
  -- order keeps its exemption, so a dish that gains a required group mid-meal does not lock a
  -- running order. S839: a combo's dish meets its own dish's rules like any line.
  IF v_cust THEN
    SELECT string_agg(DISTINCT format('%s: %s', COALESCE(rec.name, 'a dish'), g.name), '; ') INTO v_bad
      FROM jsonb_array_elements(v_rows) r
      JOIN pos_recipe_option_groups a ON a.recipe_id = (r->>'recipe_id')::uuid AND a.client_id = v_client_id
      JOIN pos_option_groups g ON g.id = a.group_id AND g.is_active
      LEFT JOIN recipes rec ON rec.id = a.recipe_id
      CROSS JOIN LATERAL (
        -- S809 4h (Q20 a, D15): a "No ..." removal answers the minimum but takes no place under the
        -- maximum, so the maximum counts only the real picks.
        SELECT count(*) AS picked,
               count(*) FILTER (WHERE NOT o.is_removal) AS real_picked
          FROM jsonb_array_elements_text(r->'option_ids') e
          JOIN pos_options o ON o.id = e::uuid AND o.group_id = g.id AND o.is_active   -- S840: a hidden pick counts nowhere
      ) c
     WHERE NOT (r->>'line_key') = ANY (v_existing)   -- S809 2h: options sent or not
       AND EXISTS (SELECT 1 FROM pos_options o2 WHERE o2.group_id = g.id AND o2.is_active)
       AND (c.picked < COALESCE(a.min_override, g.min_select)
            OR c.real_picked > COALESCE(a.max_override, g.max_select, c.real_picked));
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'option_count: the choices do not fit what the dish allows (%) — change the choices and save again', v_bad
        USING ERRCODE = 'P0001', HINT = 'option_count';
    END IF;
  END IF;

  SELECT COALESCE(is_vat_registered, true) INTO v_vat_reg FROM settings WHERE client_id = v_client_id;
  v_vat_reg := COALESCE(v_vat_reg, true);

  -- ── S839: combos ───────────────────────────────────────────────────────────────────────────
  IF v_any_combo THEN
    -- A NEW combo dish needs Customization live; one already on the order keeps going.
    IF NOT v_cust AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) r
                               WHERE r->>'combo_line_id' IS NOT NULL AND NOT (r->>'line_key') = ANY (v_existing)) THEN
      RAISE EXCEPTION 'combo_unavailable: Crest Customization is not switched on for this outlet, so combos cannot be ordered — remove the combo and save again'
        USING ERRCODE = 'P0001', HINT = 'combo_unavailable';
    END IF;

    -- A combo not yet on the order must be this outlet's, offered, and still have its picks.
    SELECT string_agg(DISTINCT COALESCE(cb.name, 'a combo'), ', ') INTO v_bad
      FROM (SELECT DISTINCT r->>'combo_line_id' AS line_id, r->>'combo_id' AS combo_id
              FROM jsonb_array_elements(v_rows) r WHERE r->>'combo_line_id' IS NOT NULL) p
      LEFT JOIN pos_combos cb ON cb.id = p.combo_id::uuid
     WHERE NOT EXISTS (SELECT 1 FROM pos_order_items i WHERE i.order_id = p_order_id AND i.combo_line_id = p.line_id::uuid)
       AND NOT COALESCE(cb.client_id = v_client_id AND cb.is_active, false);
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'combo_unavailable: % is not offered any more — remove it from the order and save again', v_bad
        USING ERRCODE = 'P0001', HINT = 'combo_unavailable';
    END IF;

    -- Each combo: one combo, each pick once, one quantity, and the picks it was saved with (one
    -- already on the order) or the picks it has today (a new one). Dropping a dish with no
    -- replacement fails here: remove all its dishes to remove the combo.
    SELECT string_agg(DISTINCT COALESCE(cb.name, 'a combo'), ', ') INTO v_bad
      FROM (
        SELECT r->>'combo_line_id' AS line_id,
               min(r->>'combo_id') AS combo_id,
               count(DISTINCT r->>'combo_id') AS combos,
               count(*) AS n,
               count(DISTINCT r->>'combo_group_id') AS picks,
               count(DISTINCT COALESCE((r->'src'->>'qty')::integer, 1)) AS qtys,
               array_agg(DISTINCT r->>'combo_group_id' ORDER BY r->>'combo_group_id') AS groups
          FROM jsonb_array_elements(v_rows) r
         WHERE r->>'combo_line_id' IS NOT NULL
         GROUP BY r->>'combo_line_id'
      ) p
      LEFT JOIN pos_combos cb ON cb.id = p.combo_id::uuid
      LEFT JOIN LATERAL (
        SELECT array_agg(DISTINCT i.combo_group_id::text ORDER BY i.combo_group_id::text) AS groups,
               min(i.combo_id::text) AS combo_id
          FROM pos_order_items i
         WHERE i.order_id = p_order_id AND i.combo_line_id = p.line_id::uuid
      ) s ON true
      LEFT JOIN LATERAL (
        SELECT array_agg(g.id::text ORDER BY g.id::text) AS groups
          FROM pos_combo_groups g
         WHERE g.combo_id = p.combo_id::uuid AND g.client_id = v_client_id
      ) d ON true
     WHERE p.combos > 1 OR p.n <> p.picks OR p.qtys > 1
        OR (s.groups IS NOT NULL AND (s.groups IS DISTINCT FROM p.groups OR s.combo_id IS DISTINCT FROM p.combo_id))
        OR (s.groups IS NULL AND d.groups IS DISTINCT FROM p.groups);
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'combo_incomplete: % needs one dish for each of its picks, all at the same quantity — swap a dish within its pick, or remove the whole combo', v_bad
        USING ERRCODE = 'P0001', HINT = 'combo_incomplete';
    END IF;

    -- A NEW combo dish is one of its pick's dishes today.
    SELECT string_agg(DISTINCT COALESCE(rec.name, 'a dish'), ', ') INTO v_bad
      FROM jsonb_array_elements(v_rows) r
      LEFT JOIN recipes rec ON rec.id = (r->>'recipe_id')::uuid AND rec.client_id = v_client_id
     WHERE r->>'combo_line_id' IS NOT NULL
       AND NOT (r->>'line_key') = ANY (v_existing)
       AND NOT EXISTS (
             SELECT 1
               FROM pos_combo_items it
               JOIN pos_combo_groups g ON g.id = it.group_id
               JOIN pos_combos cb ON cb.id = g.combo_id
              WHERE it.group_id = (r->>'combo_group_id')::uuid
                AND g.combo_id = (r->>'combo_id')::uuid
                AND it.recipe_id = (r->>'recipe_id')::uuid
                AND cb.client_id = v_client_id AND cb.is_active
                AND COALESCE(rec.is_active, false) AND rec.category IS DISTINCT FROM 'Sub-Recipe');
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'combo_dish_not_offered: % is not one of that pick''s dishes any more — choose again and save', v_bad
        USING ERRCODE = 'P0001', HINT = 'combo_dish_not_offered';
    END IF;

    -- Each NEW combo dish's price before its own choices, ex-VAT: (its pick's share + its extra charge)
    -- ÷ (1 + its VAT rate), and the combo's names as they are today.
    SELECT COALESCE(jsonb_object_agg(q.line_id, jsonb_build_object(
             'base', q.base, 'combo_name', q.combo_name, 'combo_price', q.combo_price,
             'group_name', q.group_name, 'sort', q.sort)), '{}'::jsonb)
      INTO v_combo
      FROM (
        SELECT r->>'id' AS line_id,
               round((sh.share + COALESCE(it.extra_price, 0))
                     / (1 + CASE WHEN v_vat_reg THEN COALESCE(rec.vat_rate, 0.13) ELSE 0 END), 2) AS base,
               cb.name AS combo_name, cb.guest_price AS combo_price, sh.group_name, sh.sort
          FROM jsonb_array_elements(v_rows) r
          JOIN recipes rec ON rec.id = (r->>'recipe_id')::uuid AND rec.client_id = v_client_id
          JOIN pos_combos cb ON cb.id = (r->>'combo_id')::uuid
          JOIN LATERAL public.pos_combo_shares(cb.id) sh ON sh.group_id = (r->>'combo_group_id')::uuid
          LEFT JOIN pos_combo_items it ON it.group_id = (r->>'combo_group_id')::uuid AND it.recipe_id = rec.id
         WHERE r->>'combo_line_id' IS NOT NULL AND NOT (r->>'line_key') = ANY (v_existing)
      ) q;
  END IF;
  v_combo := COALESCE(v_combo, '{}'::jsonb);

  -- ── Record any already-fired quantity about to disappear ───────────────────────────────────
  -- Grouped by LINE key since S758, so pulling one of two customized Momo lines names that one.
  -- S809 1d (DATABASE-1): pos_kot_removals refuses a client session's insert unless this flag is
  -- on, so a pulled-item record can only come from this diff (or from the two delete triggers,
  -- which are SECURITY DEFINER). On for this one statement only.
  -- S809 2h (S809.4, from the 2b review): comped rows count too. A comp exists on an OPEN order
  -- only when a close failed after apply_pos_item_comps split the line (a cancelled close), and
  -- the till folds it back into its line (foldCompedSplits), so the line's sent units are the
  -- uncomped row's plus the comped row's. Leaving the comped row out made those units read as not
  -- sent: a save could set them back to unsent and the kitchen be sent them again, and removing
  -- the folded dish recorded no pull for them. Here and in stored_sent below.
  PERFORM set_config('crest.pos_kot_removals_rpc', 'on', true);
  WITH before_sent AS (
    SELECT COALESCE(recipe_id::text || CASE WHEN selection_key <> '' THEN '#' || selection_key ELSE '' END, name) AS k,
           MIN(recipe_id::text)            AS rid,
           MIN(name)                       AS nm,
           NULLIF(MIN(selection_key), '')  AS sel,
           MIN(option_summary)             AS summ,
           SUM(GREATEST(COALESCE(sent_qty, 0),
                        CASE WHEN COALESCE(sent_to_kot, false) THEN qty ELSE 0 END)) AS sent_qty
      FROM pos_order_items
     WHERE order_id = p_order_id                      -- S809 2h: comped rows included
     GROUP BY COALESCE(recipe_id::text || CASE WHEN selection_key <> '' THEN '#' || selection_key ELSE '' END, name)
  ), after_all AS (
    SELECT COALESCE(r->>'line_key', r->'src'->>'name')     AS k,
           SUM(COALESCE((r->'src'->>'qty')::integer, 1))  AS qty
      FROM jsonb_array_elements(v_rows) AS r
     GROUP BY COALESCE(r->>'line_key', r->'src'->>'name')
  )
  INSERT INTO pos_kot_removals (client_id, order_id, recipe_id, item_name, qty_removed, reason, removed_by, selection_key, option_summary)
  SELECT v_client_id, p_order_id, b.rid::uuid, b.nm,
         (b.sent_qty - COALESCE(a.qty, 0))::integer,
         NULLIF(BTRIM(COALESCE(p_removal_reason, '')), ''),
         (SELECT auth.uid()),
         b.sel, b.summ
    FROM before_sent b
    LEFT JOIN after_all a ON a.k = b.k
   WHERE b.sent_qty - COALESCE(a.qty, 0) > 0;
  PERFORM set_config('crest.pos_kot_removals_rpc', 'off', true);  -- S809 1d

  -- Prices and snapshots already on the order, keyed by LINE, captured before the replacement
  -- deletes them. A non-comped line wins over a comped split of the same line. S839: with the tag.
  SELECT COALESCE(jsonb_object_agg(s.lk, jsonb_build_object(
           'unit_price', s.unit_price, 'vat_rate', s.vat_rate, 'name', s.name, 'category', s.category,
           'base_unit_price', s.base_unit_price, 'options_delta', s.options_delta, 'option_summary', s.option_summary,
           'combo_name', s.combo_name, 'combo_price', s.combo_price, 'combo_group_name', s.combo_group_name,
           'combo_sort', s.combo_sort,
           'options', s.options)), '{}'::jsonb)
    INTO v_prev
    FROM (
      SELECT DISTINCT ON (i.recipe_id, i.selection_key)
             i.recipe_id::text || CASE WHEN i.selection_key <> '' THEN '#' || i.selection_key ELSE '' END AS lk,
             i.unit_price, i.vat_rate, i.name, i.category, i.base_unit_price, i.options_delta, i.option_summary,
             i.combo_name, i.combo_price, i.combo_group_name, i.combo_sort,
             COALESCE((SELECT jsonb_agg(jsonb_build_object(
                         'group_id', x.group_id, 'option_id', x.option_id, 'group_name', x.group_name,
                         'group_kind', x.group_kind, 'option_name', x.option_name, 'kitchen_name', x.kitchen_name,
                         'is_removal', x.is_removal, 'price_delta', x.price_delta, 'list_price_delta', x.list_price_delta,
                         'included', x.included, 'ingredient_deltas', x.ingredient_deltas, 'sort', x.sort) ORDER BY x.sort, x.id)
                         FROM pos_order_item_options x WHERE x.order_item_id = i.id), '[]'::jsonb) AS options
        FROM pos_order_items i
       WHERE i.order_id = p_order_id AND i.recipe_id IS NOT NULL
       ORDER BY i.recipe_id, i.selection_key, COALESCE(i.comped, false), i.created_at
    ) s;

  -- Fresh options for NEW customized lines, priced now: the group's first `included_count` picks
  -- (by the group's own order) are free. Keyed by the minted line id. S809 4h (Q20 a): a "No ..."
  -- removal is never one of them; the real picks are numbered on their own.
  IF v_any_opts THEN
    SELECT COALESCE(jsonb_object_agg(line_id, jsonb_build_object(
             'delta', delta, 'summary', summary, 'options', options)), '{}'::jsonb)
      INTO v_opt
      FROM (
        SELECT c.line_id,
               SUM(c.charged)                                                            AS delta,
               string_agg(c.option_name || CASE WHEN c.included AND c.list_delta <> 0 THEN ' (incl.)' ELSE '' END,
                          ' · ' ORDER BY c.group_sort, c.gsort, c.osort, c.option_name)   AS summary,
               jsonb_agg(jsonb_build_object(
                 'group_id', c.group_id, 'option_id', c.option_id, 'group_name', c.group_name, 'group_kind', c.kind,
                 'option_name', c.option_name, 'kitchen_name', c.kitchen_name, 'is_removal', c.is_removal,
                 'price_delta', c.charged, 'list_price_delta', c.list_delta, 'included', c.included,
                 'ingredient_deltas', c.ingredients,
                 'sort', (c.group_sort * 1000 + c.osort)) ORDER BY c.group_sort, c.gsort, c.osort, c.option_name) AS options
          FROM (
            SELECT (r->>'id') AS line_id, o.id AS option_id, o.group_id, g.name AS group_name, g.kind,
                   o.name AS option_name, o.kitchen_name, o.is_removal,
                   -- S760: a non-size option in a 'stock_and_price' group costs its price × the size's
                   -- portion factor; the first-N free rule still applies first, so a free pick stays 0.
                   round(o.price_delta * CASE WHEN g.size_scaling = 'stock_and_price' THEN f.factor ELSE 1 END, 2) AS list_delta,
                   COALESCE(a.sort, 0) AS group_sort, g.sort AS gsort, o.sort AS osort,
                   (NOT o.is_removal
                    AND row_number() OVER (PARTITION BY r->>'id', o.group_id, o.is_removal ORDER BY o.sort, o.name, o.id) <= g.included_count) AS included,
                   CASE WHEN NOT o.is_removal
                         AND row_number() OVER (PARTITION BY r->>'id', o.group_id, o.is_removal ORDER BY o.sort, o.name, o.id) <= g.included_count
                        THEN 0
                        ELSE round(o.price_delta * CASE WHEN g.size_scaling = 'stock_and_price' THEN f.factor ELSE 1 END, 2) END AS charged,
                   -- S760: stock lines are frozen SCALED, so every IMS reader stays unchanged. A size
                   -- group is always 'none' (CHECK), so a size's own lines are never scaled.
                   COALESCE((SELECT jsonb_agg(CASE WHEN oi.item_id IS NOT NULL
                                                  THEN jsonb_build_object('item_id', oi.item_id, 'qty',
                                                         round(oi.qty_per_portion * CASE WHEN g.size_scaling IN ('stock', 'stock_and_price') THEN f.factor ELSE 1 END, 4))
                                                  ELSE jsonb_build_object('sub_recipe_id', oi.sub_recipe_id, 'qty',
                                                         round(oi.qty_per_portion * CASE WHEN g.size_scaling IN ('stock', 'stock_and_price') THEN f.factor ELSE 1 END, 4)) END
                                              ORDER BY oi.id)
                               FROM pos_option_ingredients oi WHERE oi.option_id = o.id), '[]'::jsonb) AS ingredients
              FROM jsonb_array_elements(v_rows) r
              CROSS JOIN LATERAL public.pos_selection_portion_factor(
                ARRAY(SELECT e2::uuid FROM jsonb_array_elements_text(r->'option_ids') e2)) AS f(factor)
              CROSS JOIN LATERAL jsonb_array_elements_text(r->'option_ids') e
              JOIN pos_options o ON o.id = e::uuid AND o.client_id = v_client_id
              JOIN pos_option_groups g ON g.id = o.group_id
              LEFT JOIN pos_recipe_option_groups a ON a.recipe_id = (r->>'recipe_id')::uuid AND a.group_id = g.id
             WHERE (r->>'has_options')::boolean
               AND NOT (r->>'line_key') = ANY (v_existing)
          ) c
         GROUP BY c.line_id
      ) q;
  END IF;
  v_opt := COALESCE(v_opt, '{}'::jsonb);

  -- S809 4h (CUSTOMIZATION-6): a NEW line priced below zero is refused. A size is stored as a
  -- difference from its dish, so a "Half" made NPR 100 cheaper sold a NPR 80 dish at minus NPR 20,
  -- a negative line on the Tax Invoice that took money off the bill outside the discount cap. A
  -- line already on the order keeps its price, as every other rule here leaves it. S839: a combo
  -- dish's own price is its share of the combo.
  SELECT string_agg(DISTINCT rec.name, ', ') INTO v_bad
    FROM jsonb_array_elements(v_rows) r
    JOIN recipes rec ON rec.id = (r->>'recipe_id')::uuid AND rec.client_id = v_client_id
   WHERE NOT (r->>'line_key') = ANY (v_existing)
     AND CASE WHEN r->>'combo_line_id' IS NOT NULL THEN COALESCE((v_combo -> (r->>'id') ->> 'base')::numeric, 0)
              ELSE COALESCE(rec.selling_price, 0) END
         + COALESCE((v_opt -> (r->>'id') ->> 'delta')::numeric, 0) < 0;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'option_price_below_zero: % would cost less than nothing with the choices picked — change the choices, or ask a manager to fix the price in Option Groups', v_bad
      USING ERRCODE = 'P0001', HINT = 'option_price_below_zero';
  END IF;

  -- ── S809 1d (ORDER-FLOW-2): a save never lowers what the kitchen already has ──────────────
  -- Each incoming row gets 'kitchen': its share of what the kitchen already has of its line (the
  -- stored rows, with the same definition of sent as the record above), shared out over the rows
  -- of that line in order and never more than a row's own quantity. The replacement row keeps at
  -- least that as sent_qty, whatever the browser sent, so a sent count goes down only with the
  -- quantity, and the record above has already written that up. Until S809 a save sending
  -- sent_qty 0 zeroed the stored count, and the removal that followed found nothing to record.
  -- sent_to_kot is left as sent: false with sent_qty = qty is the order screen's own "changed
  -- since it was sent" state (an edited note), which must still show as unsent there.
  WITH stored_sent AS (
    SELECT COALESCE(recipe_id::text || CASE WHEN selection_key <> '' THEN '#' || selection_key ELSE '' END, name) AS k,
           SUM(GREATEST(COALESCE(sent_qty, 0),
                        CASE WHEN COALESCE(sent_to_kot, false) THEN qty ELSE 0 END)) AS sent
      FROM pos_order_items
     WHERE order_id = p_order_id                      -- S809 2h: comped rows included
     GROUP BY 1
  ), incoming AS (
    SELECT e.v, (e.v->>'n')::bigint AS n, COALESCE((e.v->'src'->>'qty')::integer, 1) AS q
      FROM jsonb_array_elements(v_rows) AS e(v)
  )
  SELECT COALESCE(jsonb_agg(w.v || jsonb_build_object('kitchen', w.kitchen) ORDER BY w.n), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT i.v, i.n,
             LEAST(i.q, GREATEST(COALESCE(s.sent, 0)
                                 - COALESCE(SUM(i.q) OVER (PARTITION BY i.v->>'line_key' ORDER BY i.n
                                                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0),
                                 0)) AS kitchen
        FROM incoming i
        LEFT JOIN stored_sent s ON s.k = i.v->>'line_key'
    ) w;

  -- This transaction's writes to pos_order_items / pos_order_item_options are the RPC's own.
  PERFORM set_config('crest.pos_items_rpc', 'on', true);

  DELETE FROM pos_order_items WHERE order_id = p_order_id;

  IF jsonb_array_length(v_rows) > 0 THEN
    INSERT INTO pos_order_items (
      id, order_id, client_id, recipe_id, name, category, qty, unit_price, vat_rate,
      sent_to_kot, sent_qty, notes, selection_key, base_unit_price, options_delta, option_summary,
      combo_line_id, combo_id, combo_name, combo_price, combo_group_id, combo_group_name, combo_sort
    )
    SELECT
      (r->>'id')::uuid,
      p_order_id,
      v_client_id,
      rec.id,
      COALESCE(v_prev -> (r->>'line_key') ->> 'name', rec.name),
      COALESCE(v_prev -> (r->>'line_key') ->> 'category', NULLIF(rec.category, ''), 'Other'),
      COALESCE((r->'src'->>'qty')::integer, 1),
      COALESCE((v_prev -> (r->>'line_key') ->> 'unit_price')::numeric,
               CASE WHEN r->>'combo_line_id' IS NOT NULL THEN (v_combo -> (r->>'id') ->> 'base')::numeric
                    ELSE COALESCE(rec.selling_price, 0) END
                 + COALESCE((v_opt -> (r->>'id') ->> 'delta')::numeric, 0),
               0),
      COALESCE((v_prev -> (r->>'line_key') ->> 'vat_rate')::numeric,
               CASE WHEN v_vat_reg THEN COALESCE(rec.vat_rate, 0.13) ELSE 0 END),
      COALESCE((r->'src'->>'sent_to_kot')::boolean, false),
      -- S809 1d (ORDER-FLOW-2): never below what the kitchen already has of this line (above).
      GREATEST(COALESCE((r->'src'->>'sent_qty')::integer, 0), COALESCE((r->>'kitchen')::integer, 0), 0),
      NULLIF(r->'src'->>'notes', ''),
      r->>'selection_key',
      CASE WHEN r->>'selection_key' <> '' THEN
        COALESCE((v_prev -> (r->>'line_key') ->> 'base_unit_price')::numeric,
                 CASE WHEN r->>'combo_line_id' IS NOT NULL THEN (v_combo -> (r->>'id') ->> 'base')::numeric
                      ELSE rec.selling_price END) END,
      CASE WHEN r->>'selection_key' <> '' THEN
        COALESCE((v_prev -> (r->>'line_key') ->> 'options_delta')::numeric, (v_opt -> (r->>'id') ->> 'delta')::numeric, 0) END,
      CASE WHEN r->>'selection_key' <> '' THEN
        COALESCE(v_prev -> (r->>'line_key') ->> 'option_summary', v_opt -> (r->>'id') ->> 'summary') END,
      -- S839: the combo tag, the server's own (names and price as sold).
      (r->>'combo_line_id')::uuid,
      (r->>'combo_id')::uuid,
      CASE WHEN r->>'combo_line_id' IS NOT NULL THEN
        COALESCE(v_prev -> (r->>'line_key') ->> 'combo_name', v_combo -> (r->>'id') ->> 'combo_name') END,
      CASE WHEN r->>'combo_line_id' IS NOT NULL THEN
        COALESCE((v_prev -> (r->>'line_key') ->> 'combo_price')::numeric, (v_combo -> (r->>'id') ->> 'combo_price')::numeric) END,
      (r->>'combo_group_id')::uuid,
      CASE WHEN r->>'combo_line_id' IS NOT NULL THEN
        COALESCE(v_prev -> (r->>'line_key') ->> 'combo_group_name', v_combo -> (r->>'id') ->> 'group_name') END,
      CASE WHEN r->>'combo_line_id' IS NOT NULL THEN
        COALESCE((v_prev -> (r->>'line_key') ->> 'combo_sort')::integer, (v_combo -> (r->>'id') ->> 'sort')::integer) END
    FROM jsonb_array_elements(v_rows) AS r
    JOIN recipes rec ON rec.id = (r->>'recipe_id')::uuid AND rec.client_id = v_client_id;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    INSERT INTO pos_order_item_options (
      client_id, order_id, order_item_id, recipe_id, group_id, option_id, group_name, group_kind,
      option_name, kitchen_name, is_removal, price_delta, list_price_delta, included, ingredient_deltas, sort
    )
    SELECT v_client_id, p_order_id, (r->>'id')::uuid, (r->>'recipe_id')::uuid,
           NULLIF(s->>'group_id', '')::uuid, NULLIF(s->>'option_id', '')::uuid, s->>'group_name', s->>'group_kind',
           s->>'option_name', s->>'kitchen_name', COALESCE((s->>'is_removal')::boolean, false),
           COALESCE((s->>'price_delta')::numeric, 0), COALESCE((s->>'list_price_delta')::numeric, 0),
           COALESCE((s->>'included')::boolean, false), COALESCE(s->'ingredient_deltas', '[]'::jsonb),
           COALESCE((s->>'sort')::integer, 0)
      FROM jsonb_array_elements(v_rows) AS r
      JOIN pos_order_items li ON li.id = (r->>'id')::uuid
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN (r->>'line_key') = ANY (v_existing) AND v_prev ? (r->>'line_key')
             THEN COALESCE(v_prev -> (r->>'line_key') -> 'options', '[]'::jsonb)
             ELSE COALESCE(v_opt -> (r->>'id') -> 'options', '[]'::jsonb) END) AS s
     WHERE r->>'selection_key' <> '';
  END IF;

  PERFORM set_config('crest.pos_items_rpc', 'off', true);

  -- Every row must have landed: a recipe the JOIN could not see (RLS, another client) would
  -- otherwise vanish from the order silently.
  IF v_inserted <> COALESCE(jsonb_array_length(p_rows), 0) THEN
    RAISE EXCEPTION 'line_not_on_menu: % of % lines could not be matched to this outlet''s menu',
      COALESCE(jsonb_array_length(p_rows), 0) - v_inserted, COALESCE(jsonb_array_length(p_rows), 0)
      USING ERRCODE = 'P0001', HINT = 'line_not_on_menu';
  END IF;

  -- S840: the save's id goes on the order with the version it made, newest first, the last 50 kept.
  -- A till decides its own unanswered save landed by finding its id here (sendAttempt.js), not by
  -- the dishes looking like its own. guard_pos_order_close keeps the column the RPC's own.
  PERFORM set_config('crest.pos_save_rpc', 'on', true);
  UPDATE pos_orders
     SET items_version = items_version + 1,
         recent_saves = CASE WHEN p_save_id IS NULL THEN recent_saves ELSE (
           SELECT COALESCE(jsonb_agg(x.e ORDER BY x.n), '[]'::jsonb)
             FROM jsonb_array_elements(jsonb_build_array(jsonb_build_object('id', p_save_id, 'v', items_version + 1))
                                       || COALESCE(recent_saves, '[]'::jsonb)) WITH ORDINALITY AS x(e, n)
            WHERE x.n <= 50) END
   WHERE id = p_order_id
   RETURNING items_version INTO v_version;
  PERFORM set_config('crest.pos_save_rpc', 'off', true);

  v_items := public.pos_order_items_json(p_order_id);

  RETURN jsonb_build_object('inserted', v_inserted, 'items_version', v_version, 'items', v_items);
END;
$function$;
REVOKE ALL ON FUNCTION public.save_pos_order_items(uuid, jsonb, text, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_pos_order_items(uuid, jsonb, text, integer, uuid) TO authenticated, service_role;

-- recent_saves is the RPC's own: a client's write to it is ignored (as a moved bill's table is), and
-- a new order starts with none.
DO $do$
DECLARE
  v_def text := pg_get_functiondef('public.guard_pos_order_close()'::regprocedure);
BEGIN
  v_def := pg_temp.s840_patch(v_def,
$o$    NEW.part_of_order_id := OLD.part_of_order_id;
  END IF;
  -- ── end S836 ──$o$,
$n$    NEW.part_of_order_id := OLD.part_of_order_id;
  END IF;
  -- ── end S836 ──
  -- S840: an order's recent save ids are written only by save_pos_order_items, which marks its own
  -- update. Anything a client session sends for them is ignored.
  IF current_setting('crest.pos_save_rpc', true) IS DISTINCT FROM 'on' THEN
    NEW.recent_saves := OLD.recent_saves;
  END IF;$n$);
  EXECUTE v_def;

  v_def := pg_get_functiondef('public.guard_pos_order_insert()'::regprocedure);
  v_def := pg_temp.s840_patch(v_def,
$o$    NEW.vat_registered := NULL;
    -- S836: a part bill$o$,
$n$    NEW.vat_registered := NULL;
    -- S840: a new order has taken no save yet.
    NEW.recent_saves := '[]'::jsonb;
    -- S836: a part bill$n$);
  EXECUTE v_def;
END;
$do$;


-- ── 3. A hidden choice counts nowhere: the guest menu's twin ─────────────────────────────────────
DO $do$
DECLARE
  v_def text := pg_get_functiondef('public.pos_price_selection(uuid,uuid,uuid[])'::regprocedure);
BEGIN
  v_def := pg_temp.s840_patch(v_def,
$o$        FROM unnest(v_ids) e JOIN pos_options o ON o.id = e::uuid AND o.group_id = g.id
$o$,
$n$        FROM unnest(v_ids) e JOIN pos_options o ON o.id = e::uuid AND o.group_id = g.id AND o.is_active   -- S840
$n$);
  EXECUTE v_def;
END;
$do$;


-- ── 4. Crest support only where a screen asks ─────────────────────────────────────────────────
DROP FUNCTION public.get_client_profile_names(uuid);
CREATE FUNCTION public.get_client_profile_names(p_client_id uuid, p_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(id uuid, full_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
  v_caller_role text;
BEGIN
  SELECT COALESCE(p.active_client_id, p.client_id), p.role INTO caller_client_id, v_caller_role FROM profiles p WHERE p.id = auth.uid();
  IF COALESCE(v_caller_role = 'admin' OR caller_client_id = p_client_id, false) THEN
    RETURN QUERY
      -- S819 4k (GAP-OPERATOR-3, D28 b): a Crest operator login is "Crest support" to everyone,
      -- itself included, and never its own name; the till prints the same words
      -- (posOrdersConstants.js CREST_SUPPORT_LABEL).
      SELECT p.id, (CASE WHEN p.role = 'admin' THEN 'Crest support' ELSE p.full_name END)::text
        FROM profiles p
       WHERE p.client_id = p_client_id OR p.id = auth.uid()
          -- S798 3f-2: a login whose home is another outlet of this one's group. It may have decided
          -- things here through Outlet Access, or been moved from here when its owner left this outlet.
          OR p.client_id IN (SELECT c2.id FROM clients c1 JOIN clients c2 ON c2.group_id = c1.group_id
                              WHERE c1.id = p_client_id)
          -- S840: Crest support, whose own profile belongs to no client, acts inside one: its row is
          -- returned to the operator, and to anyone else only for the ids the screen is naming (a
          -- record support touched here), never every operator id to every client.
          OR (p.role = 'admin' AND (COALESCE(v_caller_role = 'admin', false) OR p.id = ANY (COALESCE(p_ids, '{}'::uuid[]))));
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_client_profile_names(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_client_profile_names(uuid, uuid[]) TO authenticated, service_role;


-- ── 5. log_audit: the dead strip ───────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_def text := pg_get_functiondef('public.log_audit()'::regprocedure);
BEGIN
  v_def := pg_temp.s840_patch(v_def,
$o$  IF TG_TABLE_NAME = 'clients' THEN
    IF _old IS NOT NULL THEN _old := _old - 'pos_device_secret'; END IF;
    IF _new IS NOT NULL THEN _new := _new - 'pos_device_secret'; END IF;
  END IF;

$o$,
$n$  -- S840: the pos_device_secret strip on clients snapshots went: the column left clients in S531
  -- (client_secrets), so there was nothing left to strip.

$n$);
  EXECUTE v_def;
END;
$do$;


-- ── 6. The probe, rolled back ─────────────────────────────────────────────────────────────────
-- (a) save ids, the names function and log_audit at BLOOM CAFE as a stand-in POS manager; (b) the
-- push of a combo in the first outlet group with Customization on both sides, as HQ's Owner.
DO $probe$
DECLARE
  v_client uuid; v_staff uuid; v_admin uuid; v_hint text; v_r jsonb; v_n integer; v_v integer; v_txt text;
  v_tea uuid; v_table uuid; v_o uuid; v_o2 uuid;
  v_s1 uuid := gen_random_uuid(); v_s2 uuid := gen_random_uuid();
  v_hq uuid; v_br uuid; v_owner uuid; v_before bigint;
  v_veg uuid; v_coke uuid; v_combo uuid; v_gm uuid; v_gd uuid; v_bcombo uuid;
BEGIN
  SELECT c.id INTO v_client
    FROM public.clients c
   WHERE c.pos_enabled AND COALESCE(public.client_access_open(c.id), false)
     AND EXISTS (SELECT 1 FROM public.settings s WHERE s.client_id = c.id)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND p.active_client_id IS NULL
                    AND p.pos_role IS NOT NULL AND p.pos_email IS NOT NULL
                    AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL)
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S840 probe: no POS outlet with an unblocked POS till login';
  END IF;
  SELECT p.id INTO v_staff FROM public.profiles p
   WHERE p.client_id = v_client AND p.active_client_id IS NULL AND p.pos_role IS NOT NULL AND p.pos_email IS NOT NULL
     AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL
   ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_admin FROM public.profiles p WHERE p.role = 'admin' ORDER BY p.id LIMIT 1;

  BEGIN
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);
    PERFORM set_config('request.jwt.claims', '', true);
    UPDATE public.profiles SET pos_role = 'manager', ims_role = NULL, hr_role = NULL, hr_self_service = false,
                               pos_discount_limit = NULL
     WHERE id = v_staff;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, is_active, pos_enabled)
      VALUES (v_client, 'S840 probe tea', 'Beverage', 50, 0.13, true, true) RETURNING id INTO v_tea;
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_client, 'S840 probe A') RETURNING id INTO v_table;

    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff)::text, true);
    SET LOCAL ROLE authenticated;

    -- ── (a1) A new order takes no save ids from its insert ─────────────────────────────────────
    INSERT INTO public.pos_orders (client_id, table_id, table_name, covers, recent_saves)
      VALUES (v_client, v_table, 'S840 probe A', 2, jsonb_build_array(jsonb_build_object('id', v_s1, 'v', 99)))
      RETURNING id INTO v_o;
    IF (SELECT recent_saves FROM public.pos_orders WHERE id = v_o) IS DISTINCT FROM '[]'::jsonb THEN
      RAISE EXCEPTION 'S840 probe: an order was inserted with save ids';
    END IF;

    -- ── (a2) A save leaves its id with the version it made; a retry is a duplicate ──────────────
    v_r := public.save_pos_order_items(v_o, jsonb_build_array(jsonb_build_object('recipe_id', v_tea, 'qty', 1)), NULL, NULL, v_s1);
    SELECT items_version INTO v_v FROM public.pos_orders WHERE id = v_o;
    IF (SELECT recent_saves FROM public.pos_orders WHERE id = v_o)
       IS DISTINCT FROM jsonb_build_array(jsonb_build_object('id', v_s1, 'v', v_v)) THEN
      RAISE EXCEPTION 'S840 probe: the first save did not leave {id, v}';
    END IF;
    v_r := public.save_pos_order_items(v_o, jsonb_build_array(jsonb_build_object('recipe_id', v_tea, 'qty', 5)), NULL, 0, v_s1);
    IF NOT COALESCE((v_r->>'duplicate')::boolean, false) OR (v_r->>'items_version')::integer <> v_v
       OR (SELECT qty FROM public.pos_order_items WHERE order_id = v_o AND recipe_id = v_tea) <> 1 THEN
      RAISE EXCEPTION 'S840 probe: a retried save was saved again, or not answered as a duplicate: %', v_r;
    END IF;
    PERFORM public.save_pos_order_items(v_o, jsonb_build_array(jsonb_build_object('recipe_id', v_tea, 'qty', 2)), NULL, v_v, v_s2);
    IF jsonb_array_length((SELECT recent_saves FROM public.pos_orders WHERE id = v_o)) <> 2
       OR (SELECT recent_saves->0->>'id' FROM public.pos_orders WHERE id = v_o) <> v_s2::text THEN
      RAISE EXCEPTION 'S840 probe: the second save is not first in recent_saves';
    END IF;
    -- A save with no id (an older till) still works and adds nothing.
    PERFORM public.save_pos_order_items(v_o, jsonb_build_array(jsonb_build_object('recipe_id', v_tea, 'qty', 3)), NULL, NULL);
    IF jsonb_array_length((SELECT recent_saves FROM public.pos_orders WHERE id = v_o)) <> 2 THEN
      RAISE EXCEPTION 'S840 probe: a save without an id changed recent_saves';
    END IF;
    -- A client write to recent_saves is ignored.
    UPDATE public.pos_orders SET recent_saves = '[]'::jsonb WHERE id = v_o;
    IF jsonb_array_length((SELECT recent_saves FROM public.pos_orders WHERE id = v_o)) <> 2 THEN
      RAISE EXCEPTION 'S840 probe: a client cleared recent_saves';
    END IF;

    -- ── (a3) Crest support's row only for the ids asked ────────────────────────────────────────
    IF v_admin IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM public.get_client_profile_names(v_client) n WHERE n.id = v_admin) THEN
        RAISE EXCEPTION 'S840 probe: the operator''s id was handed out unasked';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.get_client_profile_names(v_client, ARRAY[v_admin]) n
                      WHERE n.id = v_admin AND n.full_name = 'Crest support') THEN
        RAISE EXCEPTION 'S840 probe: the operator was not named Crest support when asked';
      END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.get_client_profile_names(v_client) n WHERE n.id = v_staff) THEN
      RAISE EXCEPTION 'S840 probe: the outlet''s own login is missing from the names';
    END IF;
    RESET ROLE;

    -- ── (a4) log_audit still records a clients write ───────────────────────────────────────────
    PERFORM set_config('request.jwt.claims', '', true);
    SELECT COALESCE(max(id), 0) INTO v_before FROM public.audit_logs;
    UPDATE public.clients SET name = name WHERE id = v_client;
    IF NOT EXISTS (SELECT 1 FROM public.audit_logs a
                    WHERE a.id > v_before AND a.table_name = 'clients' AND a.record_id = v_client
                      AND a.new_data ? 'name') THEN
      RAISE EXCEPTION 'S840 probe: log_audit wrote no row for a clients update';
    END IF;

    -- ── (b) HQ's push carries a combo ──────────────────────────────────────────────────────────
    SELECT g.hq_client_id, c.id INTO v_hq, v_br
      FROM public.client_groups g
      JOIN public.clients c ON c.group_id = g.id AND c.id <> g.hq_client_id
     WHERE COALESCE(public.customization_live(g.hq_client_id), false)
       AND COALESCE(public.customization_live(c.id), false)
     ORDER BY g.name, c.name
     LIMIT 1;
    IF v_br IS NULL THEN
      RAISE EXCEPTION 'S840 probe: no outlet group with Customization on at HQ and a branch';
    END IF;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, is_active, pos_enabled)
      VALUES (v_hq, 'S840 probe veg momo', 'Food', 200, 0.13, true, true) RETURNING id INTO v_veg;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, is_active, pos_enabled)
      VALUES (v_hq, 'S840 probe coke', 'Beverage', 100, 0.13, true, true) RETURNING id INTO v_coke;
    INSERT INTO public.pos_combos (client_id, name, guest_price) VALUES (v_hq, 'S840 probe combo', 350) RETURNING id INTO v_combo;
    INSERT INTO public.pos_combo_groups (client_id, combo_id, name, sort) VALUES (v_hq, v_combo, 'Pick a momo', 0) RETURNING id INTO v_gm;
    INSERT INTO public.pos_combo_groups (client_id, combo_id, name, sort) VALUES (v_hq, v_combo, 'Pick a drink', 1) RETURNING id INTO v_gd;
    INSERT INTO public.pos_combo_items (client_id, group_id, recipe_id, is_default) VALUES (v_hq, v_gm, v_veg, true);
    INSERT INTO public.pos_combo_items (client_id, group_id, recipe_id, extra_price) VALUES (v_hq, v_gd, v_coke, 10);

    FOR v_txt IN SELECT p.id::text FROM public.profiles p WHERE p.client_id = v_hq AND p.role = 'client' ORDER BY p.id LOOP
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_txt)::text, true);
      IF COALESCE(public.is_client_owner(), false) THEN v_owner := v_txt::uuid; EXIT; END IF;
    END LOOP;
    IF v_owner IS NULL THEN
      RAISE EXCEPTION 'S840 probe: no Owner login at HQ';
    END IF;

    SELECT count(*) INTO v_n FROM public.push_master_data(ARRAY[v_br], ARRAY['recipes', 'options'], true) p
     WHERE p.entity = 'combos' AND p.action = 'create' AND p.record_name = 'S840 probe combo';
    IF v_n <> 1 OR EXISTS (SELECT 1 FROM public.pos_combos WHERE client_id = v_br AND name = 'S840 probe combo') THEN
      RAISE EXCEPTION 'S840 probe: the preview did not plan the combo, or wrote it';
    END IF;
    PERFORM * FROM public.push_master_data(ARRAY[v_br], ARRAY['recipes', 'options'], false);
    SELECT id INTO v_bcombo FROM public.pos_combos
     WHERE client_id = v_br AND master_id = v_combo AND guest_price = 350 AND is_active;
    IF v_bcombo IS NULL
       OR (SELECT count(*) FROM public.pos_combo_groups WHERE combo_id = v_bcombo AND master_id IN (v_gm, v_gd)) <> 2
       OR NOT EXISTS (SELECT 1 FROM public.pos_combo_items it
                        JOIN public.pos_combo_groups g ON g.id = it.group_id
                        JOIN public.recipes r ON r.id = it.recipe_id
                       WHERE g.combo_id = v_bcombo AND g.master_id = v_gd
                         AND r.client_id = v_br AND r.master_id = v_coke AND it.extra_price = 10)
       OR NOT EXISTS (SELECT 1 FROM public.pos_combo_items it
                        JOIN public.pos_combo_groups g ON g.id = it.group_id
                        JOIN public.recipes r ON r.id = it.recipe_id
                       WHERE g.combo_id = v_bcombo AND g.master_id = v_gm AND r.master_id = v_veg AND it.is_default) THEN
      RAISE EXCEPTION 'S840 probe: the combo did not reach the branch with its picks and dishes mapped';
    END IF;
    SELECT count(*) INTO v_n FROM public.push_master_data(ARRAY[v_br], ARRAY['recipes', 'options'], true) p
     WHERE p.entity = 'combos' AND p.action IN ('create', 'adopt') AND p.record_name LIKE 'S840 probe%';
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S840 probe: a second preview would create the combo again';
    END IF;

    -- The branch switches it off; HQ raises its price. Without prices: kept, still off.
    PERFORM set_config('request.jwt.claims', '', true);
    UPDATE public.pos_combos SET is_active = false WHERE id = v_bcombo;
    UPDATE public.pos_combos SET guest_price = 380 WHERE id = v_combo;
    UPDATE public.pos_combo_items SET extra_price = 20 WHERE group_id = v_gd;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    PERFORM * FROM public.push_master_data(ARRAY[v_br], ARRAY['recipes', 'options'], false);
    IF NOT EXISTS (SELECT 1 FROM public.pos_combos WHERE id = v_bcombo AND guest_price = 350 AND NOT is_active)
       OR NOT EXISTS (SELECT 1 FROM public.pos_combo_items it JOIN public.pos_combo_groups g ON g.id = it.group_id
                       WHERE g.combo_id = v_bcombo AND g.master_id = v_gd AND it.extra_price = 10) THEN
      RAISE EXCEPTION 'S840 probe: without prices the branch combo did not keep its price, extra and switch';
    END IF;
    PERFORM * FROM public.push_master_data(ARRAY[v_br], ARRAY['recipes', 'prices', 'options'], false);
    IF NOT EXISTS (SELECT 1 FROM public.pos_combos WHERE id = v_bcombo AND guest_price = 380 AND NOT is_active)
       OR NOT EXISTS (SELECT 1 FROM public.pos_combo_items it JOIN public.pos_combo_groups g ON g.id = it.group_id
                       WHERE g.combo_id = v_bcombo AND g.master_id = v_gd AND it.extra_price = 20) THEN
      RAISE EXCEPTION 'S840 probe: with prices the branch combo did not take HQ''s price and extra, or came back on';
    END IF;

    -- The branch switches it on; HQ deletes it: switched off at the branch, never deleted.
    PERFORM set_config('request.jwt.claims', '', true);
    UPDATE public.pos_combos SET is_active = true WHERE id = v_bcombo;
    DELETE FROM public.pos_combos WHERE id = v_combo;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    PERFORM * FROM public.push_master_data(ARRAY[v_br], ARRAY['recipes', 'options'], false);
    IF NOT EXISTS (SELECT 1 FROM public.pos_combos WHERE id = v_bcombo AND NOT is_active) THEN
      RAISE EXCEPTION 'S840 probe: the combo HQ deleted was not switched off at the branch';
    END IF;

    RAISE EXCEPTION 'S840 probe ok';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'S840 probe ok' THEN RAISE; END IF;
  END;

  PERFORM set_config('request.jwt.claims', '', true);
  IF EXISTS (SELECT 1 FROM public.recipes WHERE name LIKE 'S840 probe%')
     OR EXISTS (SELECT 1 FROM public.pos_combos WHERE name LIKE 'S840 probe%') THEN
    RAISE EXCEPTION 'S840 probe: its fixtures were not rolled back';
  END IF;
  RAISE NOTICE 'S840 probe: passed and rolled back';
END;
$probe$;


-- ── 7. Read back ──────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.save_pos_order_items(uuid, jsonb, text, integer)') IS NOT NULL
     OR to_regprocedure('public.get_client_profile_names(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'S840: an old signature is still there';
  END IF;
  IF has_function_privilege('anon', 'public.save_pos_order_items(uuid, jsonb, text, integer, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.save_pos_order_items(uuid, jsonb, text, integer, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_client_profile_names(uuid, uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_client_profile_names(uuid, uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pos_order_items_json(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S840: a function''s grants are not as written';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
