-- S758 stage 4: Crest Customization reaches the order line.
--
-- A line is now (recipe, selection): "Momo, extra cheese" and "Momo, no onion" are two lines of one
-- recipe. Everything here keeps a line WITHOUT options byte-identical to before — selection_key ''
-- makes its line key the recipe id, which is what every grouping in this function used to key on.
--
-- What changes:
--
--   pos_order_items          + selection_key ('' or the chosen option ids, sorted, '+'-joined —
--                              posOrdersConstants.selectionKeyOf is its twin), base_unit_price,
--                              options_delta, option_summary. unit_price stays THE price, so bill
--                              maths, the close guard's discount cap, credit notes, the Z-report and
--                              sales_entries.unit_price need no change at all.
--   pos_order_item_options   the resolved selection per line, frozen when the line is first saved:
--                              names, the price each option was charged at, and its stock lines. No
--                              FK to the menu tables — deleting an option must not touch a bill.
--   pos_kot_removals         + selection_key, option_summary, so a pulled "Momo, no onion" names
--                              which Momo.
--   sales_entries            + ingredient_deltas (written from stage 7; nullable, NULL = none).
--   save_pos_order_items     v5, same signature. Rows may carry `options: uuid[]`. Validated against
--                              the live menu for a NEW line, re-priced on the server (dish price +
--                              options, the group's "first N free" applied), and an EXISTING line keeps
--                              the price and snapshot it was saved with, as dishes always have.
--   apply_pos_item_comps     comps a LINE, not a recipe: p_partial rows and a new p_full_lines carry
--                              selection_key, and a split comped portion copies its options snapshot.
--                              The 7-arg signature is dropped (S630 rule); a stale bundle's named
--                              call resolves to the 8-arg body through p_full_lines' default.
--   Clear Occupied's removal record groups by line too.
--
-- Stock lines are stored AS WRITTEN ([{item_id|sub_recipe_id, qty}] per plate), not exploded here.
-- A sale's base recipe is exploded in the browser by explodeRecipeIngredients at close time; doing
-- the option's sub-recipes there too (stage 7) keeps ONE sub-recipe walk rather than adding a SQL one
-- (recipes-and-subrecipes.md: "there must never be a third").
--
-- Option picks are validated only on rows that SEND an `options` key. A row without one is a plain
-- line exactly as today, so a till on an older bundle, the guest menu (stage 6) and every existing
-- caller keep working; the till picker (stage 5) enforces "must choose" before it sends.

-- ── 1. Columns ─────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.pos_order_items
  ADD COLUMN IF NOT EXISTS selection_key   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS base_unit_price numeric,
  ADD COLUMN IF NOT EXISTS options_delta   numeric,
  ADD COLUMN IF NOT EXISTS option_summary  text;

ALTER TABLE public.pos_kot_removals
  ADD COLUMN IF NOT EXISTS selection_key  text,
  ADD COLUMN IF NOT EXISTS option_summary text;

ALTER TABLE public.sales_entries
  ADD COLUMN IF NOT EXISTS ingredient_deltas jsonb;

COMMENT ON COLUMN public.pos_order_items.selection_key IS
  'S758: '''' for a plain line, else the chosen pos_options ids sorted and joined with +. (recipe_id, selection_key) is the line identity.';
COMMENT ON COLUMN public.sales_entries.ingredient_deltas IS
  'S758: per-portion option stock lines for this row, [{item_id|sub_recipe_id, qty}] signed; NULL = no options.';

-- ── 2. The per-line options snapshot ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pos_order_item_options (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  order_id          uuid NOT NULL REFERENCES public.pos_orders(id) ON DELETE CASCADE,
  order_item_id     uuid NOT NULL REFERENCES public.pos_order_items(id) ON DELETE CASCADE,
  recipe_id         uuid,
  group_id          uuid,
  option_id         uuid,
  group_name        text,
  group_kind        text,
  option_name       text NOT NULL,
  kitchen_name      text,
  is_removal        boolean NOT NULL DEFAULT false,
  price_delta       numeric(12,2) NOT NULL DEFAULT 0,   -- what this option added to the line (0 when included free)
  list_price_delta  numeric(12,2) NOT NULL DEFAULT 0,   -- the option's own price at the time
  included          boolean NOT NULL DEFAULT false,
  ingredient_deltas jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(ingredient_deltas) = 'array'),
  sort              integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_order_item_options_order_item_id_idx ON public.pos_order_item_options (order_item_id);
CREATE INDEX IF NOT EXISTS pos_order_item_options_order_id_idx ON public.pos_order_item_options (order_id);
CREATE INDEX IF NOT EXISTS pos_order_item_options_client_option_idx ON public.pos_order_item_options (client_id, option_id);

-- Only the RPC, a SECURITY DEFINER body (apply_pos_item_comps), the service role and the operator's
-- restore write this table. A cascade from pos_order_items runs as the owner and passes. Because
-- every writer already refuses a closed bill, the snapshot needs no closed-bill lock of its own.
CREATE OR REPLACE FUNCTION public.guard_pos_item_option_write()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public'
AS $fn$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF current_setting('crest.pos_items_rpc', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pos_order_item_options: the options on an order line are saved with the order — they cannot be written directly'
    USING ERRCODE = '42501', HINT = 'line_not_on_menu';
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_pos_item_option_write() FROM PUBLIC;

DROP TRIGGER IF EXISTS pos_order_item_options_guard ON public.pos_order_item_options;
CREATE TRIGGER pos_order_item_options_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_order_item_options
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_item_option_write();

-- RLS mirrors pos_order_items, read from pg_policies 2026-09-15: same-client (or admin) plus
-- RESTRICTIVE no_self_service_accounts, no_ims_staff, no_hr_role_staff. POS PIN staff read it.
ALTER TABLE public.pos_order_item_options ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pos_order_item_options_all ON public.pos_order_item_options;
CREATE POLICY pos_order_item_options_all ON public.pos_order_item_options FOR ALL TO authenticated
  USING ((select public.is_admin()) OR client_id = (select public.my_client_id()))
  WITH CHECK ((select public.is_admin()) OR client_id = (select public.my_client_id()));
DROP POLICY IF EXISTS no_self_service_accounts ON public.pos_order_item_options;
CREATE POLICY no_self_service_accounts ON public.pos_order_item_options AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service());
DROP POLICY IF EXISTS no_ims_staff ON public.pos_order_item_options;
CREATE POLICY no_ims_staff ON public.pos_order_item_options AS RESTRICTIVE FOR ALL
  USING (NOT public.is_ims_staff()) WITH CHECK (NOT public.is_ims_staff());
DROP POLICY IF EXISTS no_hr_role_staff ON public.pos_order_item_options;
CREATE POLICY no_hr_role_staff ON public.pos_order_item_options AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff());
REVOKE ALL ON public.pos_order_item_options FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pos_order_item_options TO authenticated;
GRANT ALL ON public.pos_order_item_options TO service_role;

-- ── 3. guard_pos_item_price: the new identity columns are fenced like the price ────────────────
CREATE OR REPLACE FUNCTION public.guard_pos_item_price()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.unit_price      IS NOT DISTINCT FROM OLD.unit_price
     AND NEW.vat_rate        IS NOT DISTINCT FROM OLD.vat_rate
     AND NEW.qty             IS NOT DISTINCT FROM OLD.qty
     AND NEW.recipe_id       IS NOT DISTINCT FROM OLD.recipe_id
     AND NEW.order_id        IS NOT DISTINCT FROM OLD.order_id
     AND NEW.client_id       IS NOT DISTINCT FROM OLD.client_id
     AND NEW.name            IS NOT DISTINCT FROM OLD.name
     AND NEW.category        IS NOT DISTINCT FROM OLD.category
     AND NEW.selection_key   IS NOT DISTINCT FROM OLD.selection_key
     AND NEW.base_unit_price IS NOT DISTINCT FROM OLD.base_unit_price
     AND NEW.options_delta   IS NOT DISTINCT FROM OLD.options_delta
     AND NEW.option_summary  IS NOT DISTINCT FROM OLD.option_summary THEN
    RETURN NEW;
  END IF;

  IF current_setting('crest.pos_items_rpc', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- The operator's restore inserts historical lines as they were billed.
  IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'pos_order_items: order lines are saved through the order screen, which prices them from the menu — they cannot be written directly'
    USING ERRCODE = '42501', HINT = 'line_not_on_menu';
END;
$function$;

-- ── 4. save_pos_order_items v5 ─────────────────────────────────────────────────────────────────
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
                   o.name AS option_name, o.kitchen_name, o.is_removal, o.price_delta AS list_delta,
                   COALESCE(a.sort, 0) AS group_sort, g.sort AS gsort, o.sort AS osort,
                   (row_number() OVER (PARTITION BY r->>'id', o.group_id ORDER BY o.sort, o.name, o.id) <= g.included_count) AS included,
                   CASE WHEN row_number() OVER (PARTITION BY r->>'id', o.group_id ORDER BY o.sort, o.name, o.id) <= g.included_count
                        THEN 0 ELSE o.price_delta END AS charged,
                   COALESCE((SELECT jsonb_agg(CASE WHEN oi.item_id IS NOT NULL
                                                  THEN jsonb_build_object('item_id', oi.item_id, 'qty', oi.qty_per_portion)
                                                  ELSE jsonb_build_object('sub_recipe_id', oi.sub_recipe_id, 'qty', oi.qty_per_portion) END
                                              ORDER BY oi.id)
                               FROM pos_option_ingredients oi WHERE oi.option_id = o.id), '[]'::jsonb) AS ingredients
              FROM jsonb_array_elements(v_rows) r
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

-- ── 5. apply_pos_item_comps: comps a line, and a split carries its options ─────────────────────
DROP FUNCTION IF EXISTS public.apply_pos_item_comps(uuid, uuid, text, text, uuid, uuid[], jsonb);

CREATE OR REPLACE FUNCTION public.apply_pos_item_comps(p_order_id uuid, p_client_id uuid, p_fy text, p_comp_reason text, p_comped_by uuid, p_full_recipe_ids uuid[], p_partial jsonb, p_full_lines jsonb DEFAULT NULL::jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_comp_no integer;
  v_now timestamptz := now();
  v_item jsonb;
  v_order_client uuid;
  v_order_status text;
  v_caller uuid := (SELECT auth.uid());
  v_pos_role text;
  v_comped_by uuid;
  v_src record;
  v_new_id uuid;
  v_sel text;
BEGIN
  SELECT client_id, status INTO v_order_client, v_order_status FROM pos_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order_client IS NULL OR v_order_client <> p_client_id THEN
    RAISE EXCEPTION 'order does not belong to this client';
  END IF;
  IF NOT COALESCE(
    (SELECT role FROM profiles WHERE id = v_caller) = 'admin'
    OR p_client_id = public.my_client_id()
  , false) THEN
    RAISE EXCEPTION 'not authorized for this client';
  END IF;

  SELECT pos_role INTO v_pos_role FROM profiles WHERE id = v_caller;
  IF NOT COALESCE(
    (SELECT role FROM profiles WHERE id = v_caller) = 'admin'
    OR public.is_client_owner()
    OR v_pos_role IN ('supervisor', 'manager')
  , false) THEN
    RAISE EXCEPTION
      'complimentary items require Supervisor access or above'
      USING ERRCODE = '42501';
  END IF;

  -- S754: a closed bill's lines are locked for everyone, and this function is the one line writer
  -- the row guards cannot see.
  IF v_order_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'this bill is already closed, so items on it can no longer be made complimentary'
      USING ERRCODE = '42501', HINT = 'bill_locked';
  END IF;

  v_comped_by := CASE
    WHEN COALESCE((SELECT role FROM profiles WHERE id = v_caller) = 'admin', false)
      THEN COALESCE(p_comped_by, v_caller)
    ELSE v_caller
  END;

  PERFORM pg_advisory_xact_lock(hashtext('pos_comp_slip_no:' || p_client_id::text || ':' || p_fy));

  SELECT COALESCE(MAX(n), 0) + 1 INTO v_comp_no FROM (
    SELECT invoice_no AS n FROM pos_orders WHERE client_id = p_client_id AND invoice_fy = p_fy AND close_type = 'writeoff'
    UNION ALL
    SELECT comp_no AS n FROM pos_order_items WHERE client_id = p_client_id AND comp_fy = p_fy
  ) combined;

  -- The pre-S758 argument: whole recipes, which on a till that knows no options means its plain
  -- lines. It no longer reaches a customized line — that is comped by line through p_full_lines.
  IF p_full_recipe_ids IS NOT NULL AND array_length(p_full_recipe_ids, 1) > 0 THEN
    UPDATE pos_order_items
    SET comped = true, comp_reason = p_comp_reason, comped_by = v_comped_by,
        comped_at = v_now, comp_fy = p_fy, comp_no = v_comp_no
    WHERE order_id = p_order_id AND recipe_id = ANY(p_full_recipe_ids) AND selection_key = '';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_full_lines, '[]'::jsonb))
  LOOP
    UPDATE pos_order_items
    SET comped = true, comp_reason = p_comp_reason, comped_by = v_comped_by,
        comped_at = v_now, comp_fy = p_fy, comp_no = v_comp_no
    WHERE order_id = p_order_id
      AND recipe_id = (v_item->>'recipe_id')::uuid
      AND selection_key = COALESCE(v_item->>'selection_key', '')
      AND COALESCE(comped, false) = false;
  END LOOP;

  -- The comped split takes its price from the stored line it is split off, never from the
  -- payload (S754: a line's price is the menu's). vat_rate likewise, and since S758 its options.
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_partial, '[]'::jsonb))
  LOOP
    v_sel := COALESCE(v_item->>'selection_key', '');

    SELECT id, recipe_id, name, category, unit_price, vat_rate, sent_to_kot, sent_qty,
           selection_key, base_unit_price, options_delta, option_summary
      INTO v_src
      FROM pos_order_items
     WHERE order_id = p_order_id AND recipe_id = (v_item->>'recipe_id')::uuid
       AND selection_key = v_sel
       AND COALESCE(comped, false) = false
     ORDER BY created_at
     LIMIT 1;
    CONTINUE WHEN v_src.id IS NULL;

    UPDATE pos_order_items
    SET qty = qty - (v_item->>'comp_qty')::integer
    WHERE id = v_src.id;

    INSERT INTO pos_order_items (
      order_id, client_id, recipe_id, name, category, qty, unit_price, vat_rate, sent_to_kot, sent_qty,
      comped, comp_reason, comped_by, comped_at, comp_fy, comp_no,
      selection_key, base_unit_price, options_delta, option_summary
    ) VALUES (
      p_order_id, p_client_id, v_src.recipe_id, v_src.name, v_src.category,
      (v_item->>'comp_qty')::integer, v_src.unit_price, v_src.vat_rate, v_src.sent_to_kot,
      LEAST(v_src.sent_qty, (v_item->>'comp_qty')::integer),
      true, p_comp_reason, v_comped_by, v_now, p_fy, v_comp_no,
      v_src.selection_key, v_src.base_unit_price, v_src.options_delta, v_src.option_summary
    ) RETURNING id INTO v_new_id;

    INSERT INTO pos_order_item_options (
      client_id, order_id, order_item_id, recipe_id, group_id, option_id, group_name, group_kind,
      option_name, kitchen_name, is_removal, price_delta, list_price_delta, included, ingredient_deltas, sort
    )
    SELECT client_id, order_id, v_new_id, recipe_id, group_id, option_id, group_name, group_kind,
           option_name, kitchen_name, is_removal, price_delta, list_price_delta, included, ingredient_deltas, sort
      FROM pos_order_item_options WHERE order_item_id = v_src.id;
  END LOOP;

  RETURN v_comp_no;
END;
$function$;
REVOKE ALL ON FUNCTION public.apply_pos_item_comps(uuid, uuid, text, text, uuid, uuid[], jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_pos_item_comps(uuid, uuid, text, text, uuid, uuid[], jsonb, jsonb) TO authenticated, service_role;

-- ── 6. Clear Occupied's removal record, by line ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_pos_kot_removals_on_line_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_setting('crest.pos_items_rpc', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF COALESCE((SELECT auth.jwt() ->> 'role'), '') <> 'authenticated' THEN
    RETURN NULL;
  END IF;

  INSERT INTO pos_kot_removals (client_id, order_id, order_no, table_name, recipe_id, item_name, qty_removed, reason, removed_by, selection_key, option_summary)
  SELECT o.client_id, o.id, o.order_no, o.table_name,
         MIN(rec.id::text)::uuid, MIN(l.name), SUM(l.sent)::integer, 'Table cleared',
         (SELECT p.id FROM profiles p WHERE p.id = (SELECT auth.uid())),
         NULLIF(MIN(l.selection_key), ''), MIN(l.option_summary)
    FROM (
      SELECT r.order_id, r.recipe_id, r.name, r.selection_key, r.option_summary,
             LEAST(r.qty, GREATEST(COALESCE(r.sent_qty, 0),
                                   CASE WHEN COALESCE(r.sent_to_kot, false) THEN r.qty ELSE 0 END)) AS sent
        FROM old_rows r
       WHERE NOT COALESCE(r.comped, false)
    ) l
    JOIN pos_orders o    ON o.id = l.order_id AND o.status = 'open'
    JOIN clients c       ON c.id = o.client_id
    LEFT JOIN recipes rec ON rec.id = l.recipe_id
   GROUP BY o.client_id, o.id, o.order_no, o.table_name,
            COALESCE(l.recipe_id::text || CASE WHEN l.selection_key <> '' THEN '#' || l.selection_key ELSE '' END, l.name)
  HAVING SUM(l.sent) > 0;

  RETURN NULL;
END;
$function$;

NOTIFY pgrst, 'reload schema';

-- ── 7. Verification, rolled back ──────────────────────────────────────────────────────────────
-- Runs the RPC as a real signed-in Owner (a claims-set JWT on a scratch client), so the body is
-- exercised past its checks rather than merely entered (supabase-sql.md, S737).
DO $do$
BEGIN
  BEGIN
    DECLARE
      v_c uuid; v_u uuid; v_r uuid; v_g uuid; v_size uuid; v_half uuid; v_full uuid;
      v_cheese uuid; v_egg uuid; v_item uuid; v_order uuid; v_res jsonb; v_n int; v_price numeric;
      v_hint text; v_ver int;
    BEGIN
      INSERT INTO public.clients (name, pos_enabled, customization_enabled) VALUES ('__s758d', true, true) RETURNING id INTO v_c;
      v_u := gen_random_uuid();
      INSERT INTO auth.users (id, email, aud, role) VALUES (v_u, 's758d-' || v_u || '@example.invalid', 'authenticated', 'authenticated');
      INSERT INTO public.profiles (id, client_id, role, full_name) VALUES (v_u, v_c, 'client', 'S758 owner')
        ON CONFLICT (id) DO UPDATE SET client_id = EXCLUDED.client_id, role = 'client';
      INSERT INTO public.settings (client_id, is_vat_registered) VALUES (v_c, true)
        ON CONFLICT DO NOTHING;
      INSERT INTO public.recipes (client_id, name, selling_price, vat_rate, pos_enabled, is_active, category)
        VALUES (v_c, '__Momo', 250, 0.13, true, true, 'Food') RETURNING id INTO v_r;
      INSERT INTO public.items (client_id, name, uom, rate, purchase_qty) VALUES (v_c, '__cheese', 'GM', 1, 1) RETURNING id INTO v_item;

      INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select, sort) VALUES (v_c, 'Size', 'size', 1, 1, 0) RETURNING id INTO v_size;
      INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort) VALUES (v_c, v_size, 'Half', -100, 0) RETURNING id INTO v_half;
      INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort) VALUES (v_c, v_size, 'Full', 0, 1) RETURNING id INTO v_full;
      INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select, included_count, sort) VALUES (v_c, 'Extras', 'addon', 0, 3, 1, 1) RETURNING id INTO v_g;
      INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort) VALUES (v_c, v_g, 'Add egg', 40, 0) RETURNING id INTO v_egg;
      INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort) VALUES (v_c, v_g, 'Extra cheese', 50, 1) RETURNING id INTO v_cheese;
      INSERT INTO public.pos_option_ingredients (client_id, option_id, item_id, qty_per_portion) VALUES (v_c, v_cheese, v_item, 30);
      INSERT INTO public.pos_recipe_option_groups (client_id, recipe_id, group_id, sort) VALUES (v_c, v_r, v_size, 0), (v_c, v_r, v_g, 1);
      INSERT INTO public.pos_orders (client_id, status) VALUES (v_c, 'open') RETURNING id INTO v_order;

      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_u::text, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';

      -- (a) a plain line is exactly as before: price = selling price, empty selection, no snapshot
      v_res := public.save_pos_order_items(v_order, jsonb_build_array(jsonb_build_object('recipe_id', v_r, 'qty', 2)), NULL, NULL);
      IF (v_res->'items'->0->>'unit_price')::numeric <> 250 OR v_res->'items'->0->>'selection_key' <> ''
         OR jsonb_array_length(v_res->'items'->0->'options') <> 0 THEN
        RAISE EXCEPTION 'S758d verify (a): plain line changed: %', v_res;
      END IF;

      -- (b) the same dish twice with different choices is two lines, priced on the server:
      --     Half(-100) + egg(free, first of Extras) + cheese(+50) = 200 ; Full(0) = 250
      v_ver := (v_res->>'items_version')::int;
      v_res := public.save_pos_order_items(v_order, jsonb_build_array(
        jsonb_build_object('recipe_id', v_r, 'qty', 2),
        jsonb_build_object('recipe_id', v_r, 'qty', 1, 'options', jsonb_build_array(v_cheese, v_half, v_egg)),
        jsonb_build_object('recipe_id', v_r, 'qty', 1, 'options', jsonb_build_array(v_full))
      ), NULL, v_ver);
      SELECT count(*) INTO v_n FROM public.pos_order_items WHERE order_id = v_order;
      IF v_n <> 3 THEN RAISE EXCEPTION 'S758d verify (b): expected 3 lines, got %', v_n; END IF;
      SELECT unit_price INTO v_price FROM public.pos_order_items WHERE order_id = v_order AND selection_key LIKE '%+%';
      IF v_price <> 200 THEN RAISE EXCEPTION 'S758d verify (b): customized price % not 200', v_price; END IF;
      SELECT count(*) INTO v_n FROM public.pos_order_item_options WHERE order_id = v_order;
      IF v_n <> 4 THEN RAISE EXCEPTION 'S758d verify (b): expected 4 snapshot rows, got %', v_n; END IF;
      IF NOT EXISTS (SELECT 1 FROM public.pos_order_item_options WHERE order_id = v_order AND option_id = v_cheese
                       AND ingredient_deltas @> jsonb_build_array(jsonb_build_object('item_id', v_item, 'qty', 30))) THEN
        RAISE EXCEPTION 'S758d verify (b): cheese stock line not snapshotted';
      END IF;

      -- (c) an existing customized line keeps its price when the menu price moves
      RESET ROLE;
      UPDATE public.pos_options SET price_delta = 90 WHERE id = v_cheese;
      EXECUTE 'SET LOCAL ROLE authenticated';
      v_ver := (v_res->>'items_version')::int;
      v_res := public.save_pos_order_items(v_order, jsonb_build_array(
        jsonb_build_object('recipe_id', v_r, 'qty', 2),
        jsonb_build_object('recipe_id', v_r, 'qty', 3, 'options', jsonb_build_array(v_egg, v_half, v_cheese)),
        jsonb_build_object('recipe_id', v_r, 'qty', 1, 'options', jsonb_build_array(v_full))
      ), NULL, v_ver);
      SELECT unit_price INTO v_price FROM public.pos_order_items WHERE order_id = v_order AND selection_key LIKE '%+%';
      IF v_price <> 200 THEN RAISE EXCEPTION 'S758d verify (c): existing line repriced to %', v_price; END IF;

      -- (d) a pick the dish's rule does not allow is refused (two sizes)
      BEGIN
        PERFORM public.save_pos_order_items(v_order, jsonb_build_array(
          jsonb_build_object('recipe_id', v_r, 'qty', 1, 'options', jsonb_build_array(v_half, v_full))), NULL, NULL);
        RAISE EXCEPTION 'S758d verify (d): two sizes were NOT refused';
      EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        IF v_hint IS DISTINCT FROM 'option_count' THEN RAISE; END IF;
      END;

      -- (e) a required group left empty on a row that sends options is refused
      BEGIN
        PERFORM public.save_pos_order_items(v_order, jsonb_build_array(
          jsonb_build_object('recipe_id', v_r, 'qty', 1, 'options', jsonb_build_array(v_egg))), NULL, NULL);
        RAISE EXCEPTION 'S758d verify (e): missing size was NOT refused';
      EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        IF v_hint IS DISTINCT FROM 'option_count' THEN RAISE; END IF;
      END;

      -- (f) an option from nowhere is refused
      BEGIN
        PERFORM public.save_pos_order_items(v_order, jsonb_build_array(
          jsonb_build_object('recipe_id', v_r, 'qty', 1, 'options', jsonb_build_array(gen_random_uuid(), v_full))), NULL, NULL);
        RAISE EXCEPTION 'S758d verify (f): unknown option was NOT refused';
      EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        IF v_hint IS DISTINCT FROM 'option_not_on_menu' THEN RAISE; END IF;
      END;

      -- (g) the browser cannot write the snapshot or the selection directly
      BEGIN
        UPDATE public.pos_order_items SET selection_key = 'x' WHERE order_id = v_order AND selection_key = '';
        RAISE EXCEPTION 'S758d verify (g): direct selection_key write was NOT refused';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
      BEGIN
        DELETE FROM public.pos_order_item_options WHERE order_id = v_order;
        RAISE EXCEPTION 'S758d verify (g): direct snapshot delete was NOT refused';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;

      -- (h) pulling a sent customized line records WHICH line
      v_res := public.save_pos_order_items(v_order, (
        SELECT jsonb_agg(CASE WHEN i.selection_key LIKE '%+%'
                              THEN jsonb_build_object('recipe_id', i.recipe_id, 'qty', i.qty, 'sent_to_kot', true, 'sent_qty', i.qty,
                                                      'options', to_jsonb(string_to_array(i.selection_key, '+')))
                              ELSE jsonb_build_object('recipe_id', i.recipe_id, 'qty', i.qty,
                                                      'options', CASE WHEN i.selection_key <> '' THEN to_jsonb(string_to_array(i.selection_key, '+')) ELSE '[]'::jsonb END) END)
          FROM public.pos_order_items i WHERE i.order_id = v_order), NULL, NULL);
      v_res := public.save_pos_order_items(v_order, (
        SELECT jsonb_agg(jsonb_build_object('recipe_id', i.recipe_id, 'qty', i.qty,
                         'options', CASE WHEN i.selection_key <> '' THEN to_jsonb(string_to_array(i.selection_key, '+')) ELSE '[]'::jsonb END))
          FROM public.pos_order_items i WHERE i.order_id = v_order AND i.selection_key NOT LIKE '%+%'), 'Wrong item fired', NULL);
      IF NOT EXISTS (SELECT 1 FROM public.pos_kot_removals WHERE order_id = v_order AND selection_key LIKE '%+%' AND qty_removed = 3) THEN
        RAISE EXCEPTION 'S758d verify (h): pulled customized line not recorded by line';
      END IF;

      -- (i) a partial comp of a customized line carries its options onto the comped split
      RESET ROLE;
      UPDATE public.pos_order_items SET qty = 2 WHERE order_id = v_order AND selection_key <> '' AND selection_key NOT LIKE '%+%';
      EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM public.apply_pos_item_comps(v_order, v_c, '82/83', 'test', NULL, NULL,
        jsonb_build_array(jsonb_build_object('recipe_id', v_r, 'comp_qty', 1, 'selection_key', v_full::text)), NULL);
      SELECT count(*) INTO v_n FROM public.pos_order_item_options o JOIN public.pos_order_items i ON i.id = o.order_item_id
       WHERE i.order_id = v_order AND i.comped AND o.option_id = v_full;
      IF v_n <> 1 THEN RAISE EXCEPTION 'S758d verify (i): comped split has % Full snapshot rows', v_n; END IF;

      RAISE EXCEPTION 's758d_rollback' USING ERRCODE = 'P0758';
    END;
  EXCEPTION WHEN SQLSTATE 'P0758' THEN
    NULL;
  END;
END
$do$;

DO $do$
BEGIN
  IF has_function_privilege('anon', 'public.apply_pos_item_comps(uuid, uuid, text, text, uuid, uuid[], jsonb, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S758d verify: anon can execute apply_pos_item_comps';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'apply_pos_item_comps' AND p.pronargs = 7) THEN
    RAISE EXCEPTION 'S758d verify: the 7-arg apply_pos_item_comps survived';
  END IF;
END
$do$;
