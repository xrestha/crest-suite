-- S760: Crest Customization — build-your-own dishes (Acai Bowl, Pizza, Salad).
--
--   recipes.is_build_your_own         a MARK, not a category: category drives KOT/BOT routing, the
--                                     product-code prefix and the Food/Beverage splits, and a bowl
--                                     stays Food. The mark changes how the dish is ordered (the till
--                                     always opens its choice window, the guest menu walks it step by
--                                     step) and how it is costed (a range, not the fixed-ingredient
--                                     figure).
--   pos_options.portion_factor        on a SIZE option only: Small 0.75, Medium 1, Large 1.5.
--                                     NULL = 1×.
--   pos_option_groups.size_scaling    on a non-size group: 'none' | 'stock' | 'stock_and_price'.
--                                     What the chosen size does to this group's picks.
--
-- The rule, identical in save_pos_order_items, pos_price_selection and src/shared/optionPricing.js:
--   factor  = product of the chosen size options' portion_factor (NULL = 1), rounded to 6 places
--   charged = the first-N free rule first (a free pick is 0); otherwise
--             round(price_delta × factor, 2) in a 'stock_and_price' group, price_delta elsewhere
--   stock   = qty_per_portion × factor in a 'stock' or 'stock_and_price' group
--   A size group is always 'none', so a size option's own stock lines are never scaled.
--
-- The scaled quantities are FROZEN into pos_order_item_options.ingredient_deltas at save time, so
-- every IMS reader through orderLineIngredients.js needs no change, and an existing line keeps what
-- it was saved with when a factor is edited later. No factor column on the snapshot: the frozen
-- price and stock lines already carry it, and a new column would need apply_pos_item_comps (which
-- copies the snapshot's columns by name for a split comp) rebuilt too.
--
-- submit_guest_order is untouched: it takes its price from pos_price_selection.
--
-- create_build_your_own_template(dish, prefix) builds Size / Base / Sauces / Toppings for one dish in
-- one SECURITY INVOKER transaction (Option Groups → Build-your-own template).
--
-- save_pos_order_items is re-created from its S758 body (20260919130000) with ONLY the fresh-options
-- query changed. No later migration redefines it. BEFORE APPLYING, diff that body against
-- pg_get_functiondef on the live database (supabase-sql.md: rebuild from the live definition).

-- ── 1. Columns ─────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.recipes
  ADD COLUMN IF NOT EXISTS is_build_your_own boolean NOT NULL DEFAULT false;

ALTER TABLE public.pos_options
  ADD COLUMN IF NOT EXISTS portion_factor numeric(6,3);
ALTER TABLE public.pos_options DROP CONSTRAINT IF EXISTS pos_options_portion_factor_range;
ALTER TABLE public.pos_options ADD CONSTRAINT pos_options_portion_factor_range
  CHECK (portion_factor IS NULL OR (portion_factor > 0 AND portion_factor <= 10));

ALTER TABLE public.pos_option_groups
  ADD COLUMN IF NOT EXISTS size_scaling text NOT NULL DEFAULT 'none';
ALTER TABLE public.pos_option_groups DROP CONSTRAINT IF EXISTS pos_option_groups_size_scaling_check;
ALTER TABLE public.pos_option_groups ADD CONSTRAINT pos_option_groups_size_scaling_check
  CHECK (size_scaling IN ('none', 'stock', 'stock_and_price'));
ALTER TABLE public.pos_option_groups DROP CONSTRAINT IF EXISTS pos_option_groups_size_not_scaled;
ALTER TABLE public.pos_option_groups ADD CONSTRAINT pos_option_groups_size_not_scaled
  CHECK (kind <> 'size' OR size_scaling = 'none');

COMMENT ON COLUMN public.recipes.is_build_your_own IS
  'S760: a build-your-own dish (Crest Customization). Not a category: the dish keeps its real one.';
COMMENT ON COLUMN public.pos_options.portion_factor IS
  'S760: on a size option, how big a plate this size is (1 = regular). NULL = 1.';
COMMENT ON COLUMN public.pos_option_groups.size_scaling IS
  'S760: none | stock | stock_and_price. What the chosen size does to this group''s picks.';

-- ── 2. The guard: a factor belongs to a size ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_pos_option_edit()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public'
AS $fn$
DECLARE
  v_client    uuid;
  v_ok        boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN v_client := OLD.client_id; ELSE v_client := NEW.client_id; END IF;

  IF current_user IN ('anon', 'authenticated') THEN
    IF NOT COALESCE(public.caller_can_set_menu_price(), false) THEN
      RAISE EXCEPTION 'Only the Owner, a POS manager or an IMS manager can change customization options'
        USING ERRCODE = '42501', HINT = 'option_edit_rank';
    END IF;
    IF NOT COALESCE(public.is_admin(), false) AND NOT public.customization_live(v_client) THEN
      RAISE EXCEPTION 'Crest Customization is not switched on for this client'
        USING ERRCODE = '42501', HINT = 'customization_off';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF TG_TABLE_NAME = 'pos_option_ingredients' THEN
    IF NEW.item_id IS NOT NULL THEN
      SELECT (i.client_id = v_client AND NOT COALESCE(i.is_sub_recipe, false)) INTO v_ok
        FROM public.items i WHERE i.id = NEW.item_id;
      IF NOT COALESCE(v_ok, false) THEN
        RAISE EXCEPTION 'That stock item is not one of this client''s items (a sub-recipe is added as a sub-recipe, not as its stock item)'
          USING ERRCODE = '23514', HINT = 'option_ingredient_foreign';
      END IF;
    ELSE
      SELECT (r.client_id = v_client) INTO v_ok FROM public.recipes r WHERE r.id = NEW.sub_recipe_id;
      IF NOT COALESCE(v_ok, false) THEN
        RAISE EXCEPTION 'That sub-recipe is not one of this client''s recipes'
          USING ERRCODE = '23514', HINT = 'option_ingredient_foreign';
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'pos_recipe_option_groups' THEN
    SELECT (r.client_id = v_client) INTO v_ok FROM public.recipes r WHERE r.id = NEW.recipe_id;
    IF NOT COALESCE(v_ok, false) THEN
      RAISE EXCEPTION 'That dish is not one of this client''s recipes'
        USING ERRCODE = '23514', HINT = 'option_attach_foreign';
    END IF;
    IF NEW.default_option_id IS NOT NULL THEN
      SELECT (o.group_id = NEW.group_id) INTO v_ok FROM public.pos_options o WHERE o.id = NEW.default_option_id;
      IF NOT COALESCE(v_ok, false) THEN
        RAISE EXCEPTION 'The default option must belong to the group being attached'
          USING ERRCODE = '23514', HINT = 'option_default_foreign';
      END IF;
    END IF;

  -- S760: a portion factor only means something on a size.
  ELSIF TG_TABLE_NAME = 'pos_options' THEN
    IF NEW.portion_factor IS NOT NULL THEN
      SELECT (g.kind = 'size') INTO v_ok FROM public.pos_option_groups g WHERE g.id = NEW.group_id;
      IF NOT COALESCE(v_ok, false) THEN
        RAISE EXCEPTION 'A portion size can only be set on a Size option'
          USING ERRCODE = '23514', HINT = 'option_factor_not_size';
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'pos_option_groups' THEN
    IF TG_OP = 'UPDATE' AND OLD.kind = 'size' AND NEW.kind <> 'size'
       AND EXISTS (SELECT 1 FROM public.pos_options o WHERE o.group_id = NEW.id AND o.portion_factor IS NOT NULL) THEN
      RAISE EXCEPTION 'This group''s sizes carry portion sizes, so it cannot stop being a Size group until they are cleared'
        USING ERRCODE = '23514', HINT = 'group_kind_has_factors';
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_pos_option_edit() FROM PUBLIC;

-- ── 3. The factor, in one place for both SQL pricers ───────────────────────────────────────────
-- SECURITY INVOKER: inside save_pos_order_items it reads pos_options under the caller's RLS, the
-- same view the rest of that body has.
CREATE OR REPLACE FUNCTION public.pos_selection_portion_factor(p_option_ids uuid[])
  RETURNS numeric
  LANGUAGE sql
  STABLE
  SET search_path TO 'public'
AS $fn$
  SELECT COALESCE(round(exp(sum(ln(COALESCE(o.portion_factor, 1)::numeric))), 6), 1)
    FROM (SELECT DISTINCT x FROM unnest(COALESCE(p_option_ids, ARRAY[]::uuid[])) x WHERE x IS NOT NULL) d
    JOIN pos_options o ON o.id = d.x
    JOIN pos_option_groups g ON g.id = o.group_id AND g.kind = 'size'
$fn$;
REVOKE ALL ON FUNCTION public.pos_selection_portion_factor(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_selection_portion_factor(uuid[]) TO authenticated, service_role;

-- ── 4. save_pos_order_items v6 (S758 body; only the fresh-options query is scaled) ─────────────
CREATE OR REPLACE FUNCTION public.save_pos_order_items(p_order_id uuid, p_rows jsonb, p_removal_reason text DEFAULT NULL::text, p_expected_version integer DEFAULT NULL::integer)
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
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'p_order_id is required';
  END IF;

  IF p_rows IS NOT NULL AND jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a json array';
  END IF;

  -- client_id is derived from the order, never taken as a parameter. RLS hides another client's
  -- order, which reads as not found.
  SELECT client_id, status, items_version
    INTO v_client_id, v_status, v_version
    FROM pos_orders WHERE id = p_order_id
    FOR UPDATE;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'order not found or not visible: %', p_order_id;
  END IF;

  IF v_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'order_not_open: this bill is already closed, so its items cannot be changed — reload the floor'
      USING ERRCODE = 'P0001', HINT = 'order_not_open';
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

  -- Normalise every row once: its chosen option ids (distinct, sorted as text — the same order
  -- JavaScript's default sort gives lowercase uuids), its selection key, its line key, and an id
  -- minted now so the options snapshot can be linked to the line it belongs to.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id',            gen_random_uuid(),
           'n',             x.n,
           'src',           x.v,
           'recipe_id',     x.recipe_id,
           'has_options',   cardinality(x.opt_ids) > 0,
           'option_ids',    to_jsonb(x.opt_ids),
           'selection_key', array_to_string(x.opt_ids, '+'),
           'line_key',      x.recipe_id || CASE WHEN cardinality(x.opt_ids) > 0 THEN '#' || array_to_string(x.opt_ids, '+') ELSE '' END
         ) ORDER BY x.n), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT r.n, r.v, NULLIF(r.v->>'recipe_id', '') AS recipe_id,
             COALESCE((
               SELECT array_agg(o ORDER BY o COLLATE "C")
                 FROM (SELECT DISTINCT lower(e)::uuid::text AS o
                         FROM jsonb_array_elements_text(
                                CASE WHEN jsonb_typeof(r.v->'options') = 'array' THEN r.v->'options' ELSE '[]'::jsonb END) e) d
             ), ARRAY[]::text[]) AS opt_ids
        FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY AS r(v, n)
    ) x;

  v_any_opts := EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE (r->>'has_options')::boolean);

  -- Line keys already on this order: an existing line keeps its price and snapshot, a new one is
  -- checked against today's menu.
  SELECT COALESCE(array_agg(recipe_id::text || CASE WHEN selection_key <> '' THEN '#' || selection_key ELSE '' END), ARRAY[]::text[])
    INTO v_existing
    FROM pos_order_items WHERE order_id = p_order_id AND recipe_id IS NOT NULL;

  -- A NEW line (a recipe not already on this order) must be on the till menu.
  SELECT string_agg(DISTINCT COALESCE(rec.name, r->'src'->>'name', r->>'recipe_id'), ', ') INTO v_bad
    FROM jsonb_array_elements(v_rows) AS r
    LEFT JOIN recipes rec
           ON rec.id = (r->>'recipe_id')::uuid
          AND rec.client_id = v_client_id
   WHERE NOT EXISTS (SELECT 1 FROM pos_order_items i
                      WHERE i.order_id = p_order_id AND i.recipe_id = (r->>'recipe_id')::uuid)
     AND NOT COALESCE(rec.id IS NOT NULL
                      AND rec.is_active IS NOT FALSE
                      AND rec.pos_enabled IS NOT FALSE
                      AND rec.category IS DISTINCT FROM 'Sub-Recipe', false);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'line_not_on_menu: % is not on the menu any more — remove it from the order and save again', v_bad
      USING ERRCODE = 'P0001', HINT = 'line_not_on_menu';
  END IF;

  -- ── Options on NEW lines ───────────────────────────────────────────────────────────────────
  IF v_any_opts THEN
    IF NOT public.customization_live(v_client_id) AND EXISTS (
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

    -- Every group the dish offers gets a number of picks its rule allows. A group with no offered
    -- options is skipped: a guest cannot be made to choose from nothing.
    SELECT string_agg(DISTINCT format('%s: %s', COALESCE(rec.name, 'a dish'), g.name), '; ') INTO v_bad
      FROM jsonb_array_elements(v_rows) r
      JOIN pos_recipe_option_groups a ON a.recipe_id = (r->>'recipe_id')::uuid AND a.client_id = v_client_id
      JOIN pos_option_groups g ON g.id = a.group_id AND g.is_active
      LEFT JOIN recipes rec ON rec.id = a.recipe_id
      CROSS JOIN LATERAL (
        SELECT count(*) AS picked
          FROM jsonb_array_elements_text(r->'option_ids') e
          JOIN pos_options o ON o.id = e::uuid AND o.group_id = g.id
      ) c
     WHERE (r->>'has_options')::boolean
       AND NOT (r->>'line_key') = ANY (v_existing)
       AND EXISTS (SELECT 1 FROM pos_options o2 WHERE o2.group_id = g.id AND o2.is_active)
       AND (c.picked < COALESCE(a.min_override, g.min_select)
            OR c.picked > COALESCE(a.max_override, g.max_select, c.picked));
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'option_count: the choices do not fit what the dish allows (%) — change the choices and save again', v_bad
        USING ERRCODE = 'P0001', HINT = 'option_count';
    END IF;
  END IF;

  SELECT COALESCE(is_vat_registered, true) INTO v_vat_reg FROM settings WHERE client_id = v_client_id;
  v_vat_reg := COALESCE(v_vat_reg, true);

  -- ── Record any already-fired quantity about to disappear ───────────────────────────────────
  -- Grouped by LINE key since S758, so pulling one of two customized Momo lines names that one.
  WITH before_sent AS (
    SELECT COALESCE(recipe_id::text || CASE WHEN selection_key <> '' THEN '#' || selection_key ELSE '' END, name) AS k,
           MIN(recipe_id::text)            AS rid,
           MIN(name)                       AS nm,
           NULLIF(MIN(selection_key), '')  AS sel,
           MIN(option_summary)             AS summ,
           SUM(GREATEST(COALESCE(sent_qty, 0),
                        CASE WHEN COALESCE(sent_to_kot, false) THEN qty ELSE 0 END)) AS sent_qty
      FROM pos_order_items
     WHERE order_id = p_order_id
       AND COALESCE(comped, false) = false
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

  -- Prices and snapshots already on the order, keyed by LINE, captured before the replacement
  -- deletes them. A non-comped line wins over a comped split of the same line.
  SELECT COALESCE(jsonb_object_agg(s.lk, jsonb_build_object(
           'unit_price', s.unit_price, 'vat_rate', s.vat_rate, 'name', s.name, 'category', s.category,
           'base_unit_price', s.base_unit_price, 'options_delta', s.options_delta, 'option_summary', s.option_summary,
           'options', s.options)), '{}'::jsonb)
    INTO v_prev
    FROM (
      SELECT DISTINCT ON (i.recipe_id, i.selection_key)
             i.recipe_id::text || CASE WHEN i.selection_key <> '' THEN '#' || i.selection_key ELSE '' END AS lk,
             i.unit_price, i.vat_rate, i.name, i.category, i.base_unit_price, i.options_delta, i.option_summary,
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
  -- (by the group's own order) are free. Keyed by the minted line id.
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
                   (row_number() OVER (PARTITION BY r->>'id', o.group_id ORDER BY o.sort, o.name, o.id) <= g.included_count) AS included,
                   CASE WHEN row_number() OVER (PARTITION BY r->>'id', o.group_id ORDER BY o.sort, o.name, o.id) <= g.included_count
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

  -- This transaction's writes to pos_order_items / pos_order_item_options are the RPC's own.
  PERFORM set_config('crest.pos_items_rpc', 'on', true);

  DELETE FROM pos_order_items WHERE order_id = p_order_id;

  IF jsonb_array_length(v_rows) > 0 THEN
    INSERT INTO pos_order_items (
      id, order_id, client_id, recipe_id, name, category, qty, unit_price, vat_rate,
      sent_to_kot, sent_qty, notes, selection_key, base_unit_price, options_delta, option_summary
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
               COALESCE(rec.selling_price, 0) + COALESCE((v_opt -> (r->>'id') ->> 'delta')::numeric, 0),
               0),
      COALESCE((v_prev -> (r->>'line_key') ->> 'vat_rate')::numeric,
               CASE WHEN v_vat_reg THEN COALESCE(rec.vat_rate, 0.13) ELSE 0 END),
      COALESCE((r->'src'->>'sent_to_kot')::boolean, false),
      GREATEST(COALESCE((r->'src'->>'sent_qty')::integer, 0), 0),
      NULLIF(r->'src'->>'notes', ''),
      r->>'selection_key',
      CASE WHEN r->>'selection_key' <> '' THEN
        COALESCE((v_prev -> (r->>'line_key') ->> 'base_unit_price')::numeric, rec.selling_price) END,
      CASE WHEN r->>'selection_key' <> '' THEN
        COALESCE((v_prev -> (r->>'line_key') ->> 'options_delta')::numeric, (v_opt -> (r->>'id') ->> 'delta')::numeric, 0) END,
      CASE WHEN r->>'selection_key' <> '' THEN
        COALESCE(v_prev -> (r->>'line_key') ->> 'option_summary', v_opt -> (r->>'id') ->> 'summary') END
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

  UPDATE pos_orders SET items_version = items_version + 1
   WHERE id = p_order_id
   RETURNING items_version INTO v_version;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', i.id, 'recipe_id', i.recipe_id, 'name', i.name, 'category', i.category,
           'qty', i.qty, 'unit_price', i.unit_price, 'vat_rate', i.vat_rate,
           'sent_to_kot', i.sent_to_kot, 'sent_qty', i.sent_qty, 'notes', i.notes,
           'selection_key', i.selection_key, 'base_unit_price', i.base_unit_price,
           'options_delta', i.options_delta, 'option_summary', i.option_summary,
           'options', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                         'option_id', x.option_id, 'group_id', x.group_id, 'group_name', x.group_name,
                         'group_kind', x.group_kind, 'option_name', x.option_name, 'kitchen_name', x.kitchen_name,
                         'is_removal', x.is_removal, 'price_delta', x.price_delta, 'included', x.included,
                         'ingredient_deltas', x.ingredient_deltas) ORDER BY x.sort, x.id)
                         FROM pos_order_item_options x WHERE x.order_item_id = i.id), '[]'::jsonb))
           ORDER BY i.created_at, i.id), '[]'::jsonb)
    INTO v_items
    FROM pos_order_items i WHERE i.order_id = p_order_id;

  RETURN jsonb_build_object('inserted', v_inserted, 'items_version', v_version, 'items', v_items);
END;
$function$;


-- ── 5. pos_price_selection, scaled ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_price_selection(p_client_id uuid, p_recipe_id uuid, p_option_ids uuid[])
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO 'public'
AS $fn$
DECLARE
  v_ids    text[];
  v_bad    text;
  v_out    jsonb;
  v_factor numeric;
BEGIN
  SELECT COALESCE(array_agg(t ORDER BY t COLLATE "C"), ARRAY[]::text[])
    INTO v_ids FROM (SELECT DISTINCT x::text AS t FROM unnest(COALESCE(p_option_ids, ARRAY[]::uuid[])) x WHERE x IS NOT NULL) d;

  -- Every pick is this outlet's, offered, and in an offered group this dish carries.
  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) e
     WHERE NOT EXISTS (
       SELECT 1 FROM pos_options o
         JOIN pos_option_groups g ON g.id = o.group_id AND g.is_active
         JOIN pos_recipe_option_groups a ON a.group_id = g.id AND a.recipe_id = p_recipe_id
        WHERE o.id = e::uuid AND o.client_id = p_client_id AND o.is_active)) THEN
    RETURN jsonb_build_object('problem', 'option_not_on_menu');
  END IF;

  -- Every offered group on the dish gets a count its rule allows (a group with nothing offered is skipped).
  SELECT string_agg(g.name, ', ' ORDER BY g.name) INTO v_bad
    FROM pos_recipe_option_groups a
    JOIN pos_option_groups g ON g.id = a.group_id AND g.is_active
    CROSS JOIN LATERAL (
      SELECT count(*) AS picked FROM unnest(v_ids) e JOIN pos_options o ON o.id = e::uuid AND o.group_id = g.id
    ) c
   WHERE a.recipe_id = p_recipe_id AND a.client_id = p_client_id
     AND EXISTS (SELECT 1 FROM pos_options o2 WHERE o2.group_id = g.id AND o2.is_active)
     AND (c.picked < COALESCE(a.min_override, g.min_select)
          OR c.picked > COALESCE(a.max_override, g.max_select, c.picked));
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('problem', 'option_count', 'groups', v_bad);
  END IF;

  IF cardinality(v_ids) = 0 THEN
    RETURN jsonb_build_object('problem', NULL, 'selection_key', '', 'option_ids', '[]'::jsonb,
                              'delta', 0, 'summary', NULL, 'options', '[]'::jsonb, 'portion_factor', 1);
  END IF;

  v_factor := public.pos_selection_portion_factor(v_ids::uuid[]);

  -- Same ordering, "first N free" and size scaling as save_pos_order_items v6.
  SELECT jsonb_build_object(
           'problem', NULL,
           'selection_key', array_to_string(v_ids, '+'),
           'option_ids', to_jsonb(v_ids),
           'portion_factor', v_factor,
           'delta', COALESCE(SUM(c.charged), 0),
           'summary', string_agg(c.option_name || CASE WHEN c.included AND c.list_delta <> 0 THEN ' (incl.)' ELSE '' END,
                                 ' · ' ORDER BY c.group_sort, c.gsort, c.osort, c.option_name),
           'options', jsonb_agg(jsonb_build_object(
               'option_id', c.option_id, 'group_id', c.group_id, 'group_name', c.group_name, 'group_kind', c.kind,
               'option_name', c.option_name, 'kitchen_name', c.kitchen_name, 'is_removal', c.is_removal,
               'price_delta', c.charged, 'list_price_delta', c.list_delta, 'included', c.included,
               'sort', c.group_sort * 1000 + c.osort) ORDER BY c.group_sort, c.gsort, c.osort, c.option_name))
    INTO v_out
    FROM (
      SELECT o.id AS option_id, o.group_id, g.name AS group_name, g.kind, o.name AS option_name, o.kitchen_name,
             o.is_removal,
             round(o.price_delta * CASE WHEN g.size_scaling = 'stock_and_price' THEN v_factor ELSE 1 END, 2) AS list_delta,
             COALESCE(a.sort, 0) AS group_sort, g.sort AS gsort, o.sort AS osort,
             (row_number() OVER (PARTITION BY o.group_id ORDER BY o.sort, o.name, o.id) <= g.included_count) AS included,
             CASE WHEN row_number() OVER (PARTITION BY o.group_id ORDER BY o.sort, o.name, o.id) <= g.included_count
                  THEN 0
                  ELSE round(o.price_delta * CASE WHEN g.size_scaling = 'stock_and_price' THEN v_factor ELSE 1 END, 2) END AS charged
        FROM unnest(v_ids) e
        JOIN pos_options o ON o.id = e::uuid
        JOIN pos_option_groups g ON g.id = o.group_id
        LEFT JOIN pos_recipe_option_groups a ON a.recipe_id = p_recipe_id AND a.group_id = g.id
    ) c;
  RETURN v_out;
END
$fn$;
REVOKE ALL ON FUNCTION public.pos_price_selection(uuid, uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_price_selection(uuid, uuid, uuid[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_price_selection(uuid, uuid, uuid[]) TO service_role;

-- ── 6. The guest read: factors, scaling and which dishes are build-your-own ────────────────────
-- Still RETURNS jsonb, so CREATE OR REPLACE is enough; get_guest_menu's RETURNS TABLE is not touched.
CREATE OR REPLACE FUNCTION public.get_guest_menu_options(p_table_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $fn$
DECLARE
  v_client_id uuid;
BEGIN
  SELECT t.client_id INTO v_client_id FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN RETURN '{}'::jsonb; END IF;
  -- pos_enabled stays the first gate on every public menu function (S632); customization_live
  -- includes it, and is spelled out here so a reader sees the same gate get_guest_menu has.
  IF NOT COALESCE((SELECT c.pos_enabled FROM clients c WHERE c.id = v_client_id), false) THEN RETURN '{}'::jsonb; END IF;
  IF NOT public.customization_live(v_client_id) THEN RETURN '{}'::jsonb; END IF;

  -- Only what a guest sees: active groups and options, attachments for dishes on the public menu.
  -- No stock lines, no kitchen names, no hidden rows.
  RETURN jsonb_build_object(
    'groups', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'kind', g.kind, 'min_select', g.min_select,
                                          'max_select', g.max_select, 'included_count', g.included_count,
                                          'size_scaling', g.size_scaling,
                                          'sort', g.sort, 'is_active', true) ORDER BY g.sort, g.name, g.id)
        FROM pos_option_groups g WHERE g.client_id = v_client_id AND g.is_active), '[]'::jsonb),
    'options', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', o.id, 'group_id', o.group_id, 'name', o.name, 'price_delta', o.price_delta,
                                          'portion_factor', o.portion_factor,
                                          'is_removal', o.is_removal, 'is_default', o.is_default, 'diet', o.diet,
                                          'allergens', o.allergens, 'sort', o.sort, 'is_active', true) ORDER BY o.sort, o.name, o.id)
        FROM pos_options o JOIN pos_option_groups g ON g.id = o.group_id AND g.is_active
       WHERE o.client_id = v_client_id AND o.is_active), '[]'::jsonb),
    'attachments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('recipe_id', a.recipe_id, 'group_id', a.group_id, 'min_override', a.min_override,
                                          'max_override', a.max_override, 'default_option_id', a.default_option_id,
                                          'sort', a.sort) ORDER BY a.sort, a.id)
        FROM pos_recipe_option_groups a
        JOIN recipes rc ON rc.id = a.recipe_id
       WHERE a.client_id = v_client_id AND rc.is_active AND rc.pos_enabled
         AND rc.category IS DISTINCT FROM 'Sub-Recipe' AND rc.selling_price > 0), '[]'::jsonb),
    -- S760: the dishes the guest sheet walks step by step.
    'build_your_own', COALESCE((
      SELECT jsonb_agg(rc.id ORDER BY rc.id)
        FROM recipes rc
       WHERE rc.client_id = v_client_id AND rc.is_build_your_own AND rc.is_active AND rc.pos_enabled
         AND rc.category IS DISTINCT FROM 'Sub-Recipe' AND rc.selling_price > 0), '[]'::jsonb)
  );
END
$fn$;
REVOKE ALL ON FUNCTION public.get_guest_menu_options(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_guest_menu_options(uuid) TO anon, authenticated, service_role;

-- ── 6b. The build-your-own template, in one transaction ────────────────────────────────────────
-- Four groups (Size, Base, Sauces, Toppings), three sizes, the attachments and the mark. It used to
-- be a sequence of browser writes, and a failure on the ninth would have left a half-built template
-- nobody could name. SECURITY INVOKER: every guard (option edit rank, customization_live, recipe
-- rank, RLS) applies exactly as it would to the same writes made one at a time.
CREATE OR REPLACE FUNCTION public.create_build_your_own_template(p_recipe_id uuid, p_prefix text DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path TO 'public'
AS $fn$
DECLARE
  v_client uuid;
  v_dish   text;
  v_prefix text;
  v_names  text[];
  v_clash  text;
  v_start  integer;
  v_dsort  integer;
  v_size   uuid;
  v_base   uuid;
  v_sauce  uuid;
  v_top    uuid;
  v_n      integer;
BEGIN
  SELECT r.client_id, r.name INTO v_client, v_dish FROM recipes r WHERE r.id = p_recipe_id;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'byo_dish_not_found: that dish could not be found — reload the page'
      USING ERRCODE = 'P0001', HINT = 'byo_dish_not_found';
  END IF;

  v_prefix := left(COALESCE(NULLIF(btrim(p_prefix), ''), btrim(v_dish)), 60);
  v_names := ARRAY[v_prefix || ' · Size', v_prefix || ' · Base', v_prefix || ' · Sauces', v_prefix || ' · Toppings'];

  SELECT string_agg(g.name, ', ' ORDER BY g.name) INTO v_clash
    FROM pos_option_groups g
   WHERE g.client_id = v_client
     AND lower(btrim(g.name)) IN (SELECT lower(btrim(x)) FROM unnest(v_names) x);
  IF v_clash IS NOT NULL THEN
    RAISE EXCEPTION 'byo_template_name_taken: groups with these names already exist: %', v_clash
      USING ERRCODE = 'P0001', HINT = 'byo_template_name_taken', DETAIL = v_clash;
  END IF;

  SELECT COALESCE(max(g.sort), -1) + 1 INTO v_start FROM pos_option_groups g WHERE g.client_id = v_client;
  SELECT COALESCE(max(a.sort), -1) + 1 INTO v_dsort FROM pos_recipe_option_groups a WHERE a.recipe_id = p_recipe_id;

  INSERT INTO pos_option_groups (client_id, name, kind, min_select, max_select, included_count, size_scaling, sort)
    VALUES (v_client, v_names[1], 'size', 1, 1, 0, 'none', v_start) RETURNING id INTO v_size;
  INSERT INTO pos_option_groups (client_id, name, kind, min_select, max_select, included_count, size_scaling, sort)
    VALUES (v_client, v_names[2], 'choice', 1, 1, 0, 'stock', v_start + 1) RETURNING id INTO v_base;
  INSERT INTO pos_option_groups (client_id, name, kind, min_select, max_select, included_count, size_scaling, sort)
    VALUES (v_client, v_names[3], 'addon', 0, 2, 0, 'stock', v_start + 2) RETURNING id INTO v_sauce;
  INSERT INTO pos_option_groups (client_id, name, kind, min_select, max_select, included_count, size_scaling, sort)
    VALUES (v_client, v_names[4], 'addon', 0, NULL, 0, 'stock_and_price', v_start + 3) RETURNING id INTO v_top;

  -- Prices are left at 0: the owner sets them. Medium is pre-selected so a Medium build is one tap
  -- shorter; the window still opens, because the dish is marked below.
  INSERT INTO pos_options (client_id, group_id, name, price_delta, portion_factor, is_default, sort) VALUES
    (v_client, v_size, 'Small',  0, 0.75, false, 0),
    (v_client, v_size, 'Medium', 0, NULL, true,  1),
    (v_client, v_size, 'Large',  0, 1.5,  false, 2);

  INSERT INTO pos_recipe_option_groups (client_id, recipe_id, group_id, sort) VALUES
    (v_client, p_recipe_id, v_size,  v_dsort),
    (v_client, p_recipe_id, v_base,  v_dsort + 1),
    (v_client, p_recipe_id, v_sauce, v_dsort + 2),
    (v_client, p_recipe_id, v_top,   v_dsort + 3);

  UPDATE recipes SET is_build_your_own = true WHERE id = p_recipe_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'byo_dish_not_found: that dish could not be marked build-your-own — nothing was created'
      USING ERRCODE = 'P0001', HINT = 'byo_dish_not_found';
  END IF;

  RETURN jsonb_build_object('size', v_size, 'base', v_base, 'sauces', v_sauce, 'toppings', v_top,
                            'names', to_jsonb(v_names));
END
$fn$;
REVOKE ALL ON FUNCTION public.create_build_your_own_template(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_build_your_own_template(uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- ── 7. Verification, rolled back ──────────────────────────────────────────────────────────────
-- save_pos_order_items runs as a real signed-in Owner (a claims-set JWT on a scratch client), so its
-- body is exercised past its checks rather than merely entered (supabase-sql.md, S737).
DO $do$
BEGIN
  BEGIN
    DECLARE
      v_c uuid; v_u uuid; v_r uuid; v_t uuid; v_size uuid; v_small uuid; v_med uuid; v_large uuid;
      v_top uuid; v_egg uuid; v_cheese uuid; v_sauce uuid; v_honey uuid; v_item uuid; v_item2 uuid;
      v_order uuid; v_res jsonb; v_price numeric; v_hint text; v_sel jsonb; v_menu jsonb; v_q numeric;
      v_pizza uuid; v_tpl jsonb;
    BEGIN
      INSERT INTO public.clients (name, pos_enabled, customization_enabled) VALUES ('__s760', true, true) RETURNING id INTO v_c;
      v_u := gen_random_uuid();
      INSERT INTO auth.users (id, email, aud, role) VALUES (v_u, 's760-' || v_u || '@example.invalid', 'authenticated', 'authenticated');
      INSERT INTO public.profiles (id, client_id, role, full_name) VALUES (v_u, v_c, 'client', 'S760 owner')
        ON CONFLICT (id) DO UPDATE SET client_id = EXCLUDED.client_id, role = 'client';
      INSERT INTO public.settings (client_id, is_vat_registered) VALUES (v_c, true) ON CONFLICT DO NOTHING;
      INSERT INTO public.recipes (client_id, name, selling_price, vat_rate, pos_enabled, is_active, category, is_build_your_own)
        VALUES (v_c, '__Acai Bowl', 250, 0.13, true, true, 'Food', true) RETURNING id INTO v_r;
      INSERT INTO public.pos_tables (client_id, name) VALUES (v_c, 'T1') RETURNING id INTO v_t;
      INSERT INTO public.items (client_id, name, uom, rate, purchase_qty) VALUES (v_c, '__cheese760', 'GM', 1, 1) RETURNING id INTO v_item;
      INSERT INTO public.items (client_id, name, uom, rate, purchase_qty) VALUES (v_c, '__honey760', 'ML', 1, 1) RETURNING id INTO v_item2;

      INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select, sort) VALUES (v_c, 'Size', 'size', 1, 1, 0) RETURNING id INTO v_size;
      INSERT INTO public.pos_options (client_id, group_id, name, price_delta, portion_factor, sort) VALUES (v_c, v_size, 'Small', -50, 0.75, 0) RETURNING id INTO v_small;
      INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort) VALUES (v_c, v_size, 'Medium', 0, 1) RETURNING id INTO v_med;
      INSERT INTO public.pos_options (client_id, group_id, name, price_delta, portion_factor, sort) VALUES (v_c, v_size, 'Large', 150, 1.5, 2) RETURNING id INTO v_large;
      INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select, included_count, size_scaling, sort)
        VALUES (v_c, 'Toppings', 'addon', 0, NULL, 1, 'stock_and_price', 1) RETURNING id INTO v_top;
      INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort) VALUES (v_c, v_top, 'Add egg', 40, 0) RETURNING id INTO v_egg;
      INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort) VALUES (v_c, v_top, 'Extra cheese', 50, 1) RETURNING id INTO v_cheese;
      INSERT INTO public.pos_option_ingredients (client_id, option_id, item_id, qty_per_portion) VALUES (v_c, v_cheese, v_item, 30);
      INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select, size_scaling, sort)
        VALUES (v_c, 'Sauces', 'addon', 0, 2, 'stock', 2) RETURNING id INTO v_sauce;
      INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort) VALUES (v_c, v_sauce, 'Honey', 20, 0) RETURNING id INTO v_honey;
      INSERT INTO public.pos_option_ingredients (client_id, option_id, item_id, qty_per_portion) VALUES (v_c, v_honey, v_item2, 10);
      INSERT INTO public.pos_recipe_option_groups (client_id, recipe_id, group_id, sort)
        VALUES (v_c, v_r, v_size, 0), (v_c, v_r, v_top, 1), (v_c, v_r, v_sauce, 2);
      INSERT INTO public.pos_orders (client_id, status) VALUES (v_c, 'open') RETURNING id INTO v_order;

      -- (a) the factor helper: Large is 1.5, no size is 1
      IF public.pos_selection_portion_factor(ARRAY[v_large, v_egg]) <> 1.5
         OR public.pos_selection_portion_factor(ARRAY[v_egg]) <> 1
         OR public.pos_selection_portion_factor(ARRAY[]::uuid[]) <> 1 THEN
        RAISE EXCEPTION 'S760 verify (a): portion factor wrong';
      END IF;

      -- (b) the guest pricer: Large +150, egg free (first topping), cheese 50 x 1.5 = 75, honey 20 (stock only) = 245
      v_sel := public.pos_price_selection(v_c, v_r, ARRAY[v_cheese, v_large, v_egg, v_honey]);
      IF v_sel->>'problem' IS NOT NULL OR (v_sel->>'delta')::numeric <> 245 OR (v_sel->>'portion_factor')::numeric <> 1.5 THEN
        RAISE EXCEPTION 'S760 verify (b): guest pricer wrong: %', v_sel;
      END IF;

      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_u::text, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';

      -- (c) the till prices the same selection the same way (250 + 245 = 495) and freezes scaled stock
      v_res := public.save_pos_order_items(v_order, jsonb_build_array(
        jsonb_build_object('recipe_id', v_r, 'qty', 1, 'options', jsonb_build_array(v_honey, v_egg, v_large, v_cheese))), NULL, NULL);
      v_price := (v_res->'items'->0->>'unit_price')::numeric;
      IF v_price <> 495 THEN RAISE EXCEPTION 'S760 verify (c): till price % not 495', v_price; END IF;
      SELECT (ingredient_deltas->0->>'qty')::numeric INTO v_q FROM public.pos_order_item_options WHERE order_id = v_order AND option_id = v_cheese;
      IF v_q IS DISTINCT FROM 45 THEN RAISE EXCEPTION 'S760 verify (c): cheese stock % not 45', v_q; END IF;
      SELECT (ingredient_deltas->0->>'qty')::numeric INTO v_q FROM public.pos_order_item_options WHERE order_id = v_order AND option_id = v_honey;
      IF v_q IS DISTINCT FROM 15 THEN RAISE EXCEPTION 'S760 verify (c): honey stock % not 15', v_q; END IF;
      SELECT price_delta INTO v_price FROM public.pos_order_item_options WHERE order_id = v_order AND option_id = v_honey;
      IF v_price IS DISTINCT FROM 20 THEN RAISE EXCEPTION 'S760 verify (c): stock-only group repriced to %', v_price; END IF;
      SELECT price_delta INTO v_price FROM public.pos_order_item_options WHERE order_id = v_order AND option_id = v_egg;
      IF v_price IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'S760 verify (c): free pick charged %', v_price; END IF;
      RESET ROLE;

      -- (d) Small scales down: egg free, cheese 50 x 0.75 = 37.50, so delta = -50 + 37.50 = -12.50
      v_sel := public.pos_price_selection(v_c, v_r, ARRAY[v_small, v_egg, v_cheese]);
      IF (v_sel->>'delta')::numeric <> -12.50 THEN RAISE EXCEPTION 'S760 verify (d): Small delta wrong: %', v_sel; END IF;

      -- (e) a factor on a non-size option is refused
      BEGIN
        UPDATE public.pos_options SET portion_factor = 2 WHERE id = v_cheese;
        RAISE EXCEPTION 'S760 verify (e): factor on a topping NOT refused';
      EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        IF v_hint IS DISTINCT FROM 'option_factor_not_size' THEN RAISE; END IF;
      END;

      -- (f) a size group carrying factors cannot stop being a size group
      BEGIN
        UPDATE public.pos_option_groups SET kind = 'choice' WHERE id = v_size;
        RAISE EXCEPTION 'S760 verify (f): kind change NOT refused';
      EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        IF v_hint IS DISTINCT FROM 'group_kind_has_factors' THEN RAISE; END IF;
      END;

      -- (g) a size group cannot scale itself
      BEGIN
        UPDATE public.pos_option_groups SET size_scaling = 'stock' WHERE id = v_size;
        RAISE EXCEPTION 'S760 verify (g): scaled size group NOT refused';
      EXCEPTION WHEN check_violation THEN NULL;
      END;

      -- (h) the guest read carries the factor, the scaling and the build-your-own dish
      EXECUTE 'SET LOCAL ROLE anon';
      v_menu := public.get_guest_menu_options(v_t);
      RESET ROLE;
      IF NOT (v_menu->'build_your_own') @> to_jsonb(ARRAY[v_r])
         OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_menu->'options') o WHERE o->>'id' = v_large::text AND (o->>'portion_factor')::numeric = 1.5)
         OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_menu->'groups') g WHERE g->>'id' = v_top::text AND g->>'size_scaling' = 'stock_and_price') THEN
        RAISE EXCEPTION 'S760 verify (h): guest read missing S760 fields: %', v_menu;
      END IF;

      -- (i) the template, as the signed-in Owner: four groups, three sizes, attached in order, dish marked
      INSERT INTO public.recipes (client_id, name, selling_price, vat_rate, pos_enabled, is_active, category)
        VALUES (v_c, '__Pizza', 400, 0.13, true, true, 'Food') RETURNING id INTO v_pizza;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_u::text, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      v_tpl := public.create_build_your_own_template(v_pizza, NULL);
      RESET ROLE;
      IF (SELECT count(*) FROM public.pos_recipe_option_groups WHERE recipe_id = v_pizza) <> 4
         OR (SELECT count(*) FROM public.pos_options WHERE group_id = (v_tpl->>'size')::uuid) <> 3
         OR NOT (SELECT is_build_your_own FROM public.recipes WHERE id = v_pizza)
         OR (SELECT size_scaling FROM public.pos_option_groups WHERE id = (v_tpl->>'toppings')::uuid) <> 'stock_and_price'
         OR (SELECT portion_factor FROM public.pos_options WHERE group_id = (v_tpl->>'size')::uuid AND name = 'Large') <> 1.5 THEN
        RAISE EXCEPTION 'S760 verify (i): template wrong: %', v_tpl;
      END IF;

      -- (j) running it again is refused by name, and creates nothing
      EXECUTE 'SET LOCAL ROLE authenticated';
      BEGIN
        PERFORM public.create_build_your_own_template(v_pizza, NULL);
        RAISE EXCEPTION 'S760 verify (j): duplicate template NOT refused';
      EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        IF v_hint IS DISTINCT FROM 'byo_template_name_taken' THEN RAISE; END IF;
      END;
      RESET ROLE;
      IF (SELECT count(*) FROM public.pos_recipe_option_groups WHERE recipe_id = v_pizza) <> 4 THEN
        RAISE EXCEPTION 'S760 verify (j): a refused template left rows behind';
      END IF;

      RAISE EXCEPTION 's760_rollback' USING ERRCODE = 'P0760';
    END;
  EXCEPTION WHEN SQLSTATE 'P0760' THEN
    NULL;
  END;
END
$do$;

DO $do$
BEGIN
  IF has_function_privilege('anon', 'public.pos_selection_portion_factor(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'S760 verify: anon can execute pos_selection_portion_factor';
  END IF;
  IF has_function_privilege('anon', 'public.pos_price_selection(uuid, uuid, uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_price_selection(uuid, uuid, uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'S760 verify: a client role can execute pos_price_selection';
  END IF;
  IF has_function_privilege('anon', 'public.create_build_your_own_template(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S760 verify: anon can execute create_build_your_own_template';
  END IF;
  IF NOT has_function_privilege('anon', 'public.get_guest_menu_options(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S760 verify: anon cannot read the guest options';
  END IF;
END
$do$;
