-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S816, POS stage 4, slice 4h: Crest Customization's pick rules. A "No ..." choice never uses up a
-- free pick or a place under a group's maximum, a dish its choices would price below zero is
-- refused, and changing a group's kind clears each dish's own pick rule for it.
--
--   CUSTOMIZATION-5 (P3, owner decision Q20 a; build decision D15). "Extras, up to 3, first 2 free"
--   holding No onion (listed first), Extra cheese +50 and Add egg +40 charged the egg: No onion took
--   the first free pick and a place under the maximum. Both pricers now number the free picks over
--   the real picks only and count the maximum over them, so a removal is never free (it costs 0
--   anyway, CHECK pos_options_removal_is_free) and never fills the group. D15 (owner, 2026-10-12): a
--   removal still counts toward the MINIMUM, so "No sauce" answers a must-pick-1 Sauce group.
--     * save_pos_order_items: the count rule and the free-pick numbering.
--     * pos_price_selection (the guest path's pricer): the same two.
--     * src/shared/optionPricing.js is the browser twin and changes in the same release; the probe
--       below and optionPricing.test.js share the S816 fixture.
--
--   CUSTOMIZATION-6 (P3). A size is stored as a difference from its dish's price, so a "Half" made
--   NPR 100 cheaper sold a NPR 80 Kids Momo at minus NPR 20: a negative line on the Tax Invoice that
--   took money off the bill outside the discount cap, while the editor showed NPR 0.
--     * save_pos_order_items refuses a NEW line priced below zero (hint option_price_below_zero,
--       naming the dish). A line already on the order keeps its price, as every rule here leaves it.
--     * pos_price_selection returns that problem too, so submit_guest_order reads the dish as
--       "choices no longer available" and the guest's page takes it off.
--     * D17 (owner): Option Groups' editors and both attach dialogs refuse such a price before it is
--       saved, and D16 (owner): Menu Pricing (both branches) shows what each size becomes and refuses
--       a dish price that would put a choice below zero. App side, same release.
--     * Live today: 0 dish/option pairs below zero.
--
--   CUSTOMIZATION-7 (P3). Changing a group's kind kept any per-dish pick rule
--   (pos_recipe_option_groups.min_override / max_override), so a group turned into a Size could be
--   skipped or picked twice on a dish, although the dialog promises the rule resets for every dish.
--     * New AFTER UPDATE OF kind trigger pos_option_groups_kind_resets_rules clears every dish's own
--       rule for the group in the same statement. SECURITY INVOKER: it runs as the editor, whose
--       rank guard_pos_option_edit already passed for the group, and through the editor's RLS.
--     * guard_pos_option_edit clears a per-dish rule on a Size attachment rather than refusing it, so
--       an older backup still restores. A Size is pick-exactly-one on every dish.
--     * And, because a removal no longer counts toward a maximum, a Size (exactly one) may not hold a
--       "No ..." option (hint option_removal_in_size), nor become a Size while it holds one (hint
--       group_kind_has_removals). Live today: 0 removals, 0 per-dish rules.
--
-- No table, column, policy or grant changes. CREATE OR REPLACE keeps each function's grants
-- (save_pos_order_items authenticated; pos_price_selection service_role, reached only inside
-- submit_guest_order; the two trigger functions none). Tills need no reload: an older till still
-- saves, its free-pick display can differ from the server's only where a group holds a removal and
-- free picks (0 live), and it words option_price_below_zero through the generic sentence.
--
-- The probe at the end runs as BLOOM CAFE's POS manager (a stand-in) and the migration's own role,
-- inside a block that rolls itself back. If any check fails, nothing lands.
--
-- Reversal: re-create the three bodies this replaces (the first md5 of each pair below), as last
-- written by 20261009240000 (save_pos_order_items) and 20260920100000 (the other two), then
--   DROP TRIGGER pos_option_groups_kind_resets_rules ON public.pos_option_groups;
--   DROP FUNCTION public.pos_option_group_kind_resets_rules();
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces are the ones it was built on ─────────────────
-- The second hash of each pair is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.save_pos_order_items(uuid,jsonb,text,integer)'::regprocedure;
  IF v_md5 NOT IN ('c4f6e364e0cb5717eb4d1147025428b6', '1d391512d03cd0abe6f690efbae90806') THEN
    RAISE EXCEPTION 'S816 4h pre-flight: save_pos_order_items changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_price_selection(uuid,uuid,uuid[])'::regprocedure;
  IF v_md5 NOT IN ('ad072ede1cc0c1472086205a30e478ff', '36fc3c77bbd675450216d19b63703c10') THEN
    RAISE EXCEPTION 'S816 4h pre-flight: pos_price_selection changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_option_edit()'::regprocedure;
  IF v_md5 NOT IN ('4e91a1b5ce251fd76248c4e3aa9b9f01', '3a634fff9d586f435bb15e86eb5e5d88') THEN
    RAISE EXCEPTION 'S816 4h pre-flight: guard_pos_option_edit changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
END;
$$;


-- ── 1. save_pos_order_items: Q20 a (count and free picks) and the below-zero floor ─────────
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
  v_cust      boolean;   -- S809 2h: Crest Customization is live at this outlet
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

  -- S809 2h (GAP-OUTLETS-2): a NEW line needs a menu price above zero. A dish with none was billed
  -- at NPR 0 (the price below is COALESCE(selling_price, 0)): a dish an HQ push added to a branch
  -- with no price and the next push switched back On POS, or a recipe saved On POS before anyone
  -- priced it. The guest order already treats such a dish as unavailable (submit_guest_order:
  -- selling_price > 0) and the guest menu leaves it out; the till's menu read leaves it out too
  -- since S809 2h. Same code as a dish not on the menu, which every till build already handles: it
  -- re-reads its menu, shows this sentence after "Not saved —", and an offline replay lists the line
  -- with the other off-menu lines. Keyed on the LINE, as the price itself is: a line already on the
  -- order keeps the price it was saved with, so clearing a price mid-meal does not lock the order.
  SELECT string_agg(DISTINCT COALESCE(rec.name, r->'src'->>'name', r->>'recipe_id'), ', ') INTO v_bad
    FROM jsonb_array_elements(v_rows) AS r
    JOIN recipes rec
      ON rec.id = (r->>'recipe_id')::uuid
     AND rec.client_id = v_client_id
   WHERE NOT (r->>'line_key') = ANY (v_existing)
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
  -- running order.
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
          JOIN pos_options o ON o.id = e::uuid AND o.group_id = g.id
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
  -- line already on the order keeps its price, as every other rule here leaves it.
  SELECT string_agg(DISTINCT rec.name, ', ') INTO v_bad
    FROM jsonb_array_elements(v_rows) r
    JOIN recipes rec ON rec.id = (r->>'recipe_id')::uuid AND rec.client_id = v_client_id
   WHERE NOT (r->>'line_key') = ANY (v_existing)
     AND COALESCE(rec.selling_price, 0) + COALESCE((v_opt -> (r->>'id') ->> 'delta')::numeric, 0) < 0;
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
      -- S809 1d (ORDER-FLOW-2): never below what the kitchen already has of this line (above).
      GREATEST(COALESCE((r->'src'->>'sent_qty')::integer, 0), COALESCE((r->>'kitchen')::integer, 0), 0),
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
$function$

;


-- ── 2. pos_price_selection: the same, for the guest path ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_price_selection(p_client_id uuid, p_recipe_id uuid, p_option_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
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
      -- S809 4h (Q20 a, D15): a "No ..." removal answers the minimum, never the maximum.
      SELECT count(*) AS picked, count(*) FILTER (WHERE NOT o.is_removal) AS real_picked
        FROM unnest(v_ids) e JOIN pos_options o ON o.id = e::uuid AND o.group_id = g.id
    ) c
   WHERE a.recipe_id = p_recipe_id AND a.client_id = p_client_id
     AND EXISTS (SELECT 1 FROM pos_options o2 WHERE o2.group_id = g.id AND o2.is_active)
     AND (c.picked < COALESCE(a.min_override, g.min_select)
          OR c.real_picked > COALESCE(a.max_override, g.max_select, c.real_picked));
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('problem', 'option_count', 'groups', v_bad);
  END IF;

  IF cardinality(v_ids) = 0 THEN
    RETURN jsonb_build_object('problem', NULL, 'selection_key', '', 'option_ids', '[]'::jsonb,
                              'delta', 0, 'summary', NULL, 'options', '[]'::jsonb, 'portion_factor', 1);
  END IF;

  v_factor := public.pos_selection_portion_factor(v_ids::uuid[]);

  -- Same ordering, "first N free" and size scaling as save_pos_order_items v6 (S809 4h: a "No ..."
  -- removal is never a free pick).
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
             (NOT o.is_removal
              AND row_number() OVER (PARTITION BY o.group_id, o.is_removal ORDER BY o.sort, o.name, o.id) <= g.included_count) AS included,
             CASE WHEN NOT o.is_removal
                   AND row_number() OVER (PARTITION BY o.group_id, o.is_removal ORDER BY o.sort, o.name, o.id) <= g.included_count
                  THEN 0
                  ELSE round(o.price_delta * CASE WHEN g.size_scaling = 'stock_and_price' THEN v_factor ELSE 1 END, 2) END AS charged
        FROM unnest(v_ids) e
        JOIN pos_options o ON o.id = e::uuid
        JOIN pos_option_groups g ON g.id = o.group_id
        LEFT JOIN pos_recipe_option_groups a ON a.recipe_id = p_recipe_id AND a.group_id = g.id
    ) c;

  -- S809 4h (CUSTOMIZATION-6): a dish its choices price below zero is not on offer, as
  -- save_pos_order_items now refuses it. submit_guest_order reads any problem as choices no longer
  -- available, so the guest's page takes the dish off.
  IF COALESCE((SELECT rc.selling_price FROM recipes rc WHERE rc.id = p_recipe_id AND rc.client_id = p_client_id), 0)
     + COALESCE((v_out->>'delta')::numeric, 0) < 0 THEN
    RETURN jsonb_build_object('problem', 'option_price_below_zero');
  END IF;
  RETURN v_out;
END
$function$

;


-- ── 3. guard_pos_option_edit: a Size takes no per-dish rule and no "No ..." option ────────────
CREATE OR REPLACE FUNCTION public.guard_pos_option_edit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
    -- S809 4h (CUSTOMIZATION-7): a Size is pick-exactly-one on every dish, so a dish's own rule
    -- never applies to one. Cleared rather than refused, so a restore of an older backup still loads.
    IF (NEW.min_override IS NOT NULL OR NEW.max_override IS NOT NULL)
       AND EXISTS (SELECT 1 FROM public.pos_option_groups g WHERE g.id = NEW.group_id AND g.kind = 'size') THEN
      NEW.min_override := NULL;
      NEW.max_override := NULL;
    END IF;

  -- S760: a portion factor only means something on a size.
  ELSIF TG_TABLE_NAME = 'pos_options' THEN
    -- S809 4h (Q20 a): a "No ..." removal takes no place under a group's maximum, so inside a Size
    -- (exactly one) it would let a plate carry a size and a removal as two picks of one.
    IF NEW.is_removal AND EXISTS (SELECT 1 FROM public.pos_option_groups g WHERE g.id = NEW.group_id AND g.kind = 'size') THEN
      RAISE EXCEPTION 'A size cannot be a "No ..." option. Put the "No ..." choice in an Add-ons or Choice group'
        USING ERRCODE = '23514', HINT = 'option_removal_in_size';
    END IF;
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
    IF TG_OP = 'UPDATE' AND NEW.kind = 'size' AND OLD.kind <> 'size'
       AND EXISTS (SELECT 1 FROM public.pos_options o WHERE o.group_id = NEW.id AND o.is_removal) THEN
      RAISE EXCEPTION 'This group holds a "No ..." option, so it cannot become a Size group until that option is deleted or moved'
        USING ERRCODE = '23514', HINT = 'group_kind_has_removals';
    END IF;
  END IF;

  RETURN NEW;
END
$function$

;


-- ── 4. CUSTOMIZATION-7: a kind change clears every dish's own pick rule for the group ──────────
-- The dialog has always promised "Changing its kind resets the pick rule ... for all of them the
-- moment you save"; until now only the group row changed. SECURITY INVOKER on purpose: the update
-- runs as the editor, through the editor's RLS, and guard_pos_option_edit checks each attachment as
-- it checked the group.
CREATE OR REPLACE FUNCTION public.pos_option_group_kind_resets_rules()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.pos_recipe_option_groups
     SET min_override = NULL, max_override = NULL
   WHERE group_id = NEW.id
     AND client_id = NEW.client_id
     AND (min_override IS NOT NULL OR max_override IS NOT NULL);
  RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION public.pos_option_group_kind_resets_rules() FROM PUBLIC;

DROP TRIGGER IF EXISTS pos_option_groups_kind_resets_rules ON public.pos_option_groups;
CREATE TRIGGER pos_option_groups_kind_resets_rules
  AFTER UPDATE OF kind ON public.pos_option_groups
  FOR EACH ROW WHEN (OLD.kind IS DISTINCT FROM NEW.kind)
  EXECUTE FUNCTION public.pos_option_group_kind_resets_rules();


-- ── 5. Probe: as BLOOM CAFE's POS manager, rolled back ──────────────────────────────────────────
-- The S816 fixture, shared with optionPricing.test.js ("the S816 probe fixture"): a dish at NPR 70.80
-- with a Size group (Regular 0, Large +8.85 at 1.5, Small -10 at 0.75, Half -88.50 at 0.5) and
-- Toppings (Add-ons, up to 2, first 1 free, scale stock and price: No onion, Egg 17.70, Cheese 8.85,
-- Bacon 46.90, in that order).
DO $$
DECLARE
  v_c      uuid;    -- BLOOM CAFE
  v_mgr    uuid;    -- a POS PIN login of BLOOM CAFE, made a plain POS manager
  v_dish   uuid;
  v_gs     uuid;    -- the Size group
  v_gt     uuid;    -- Toppings
  v_reg uuid; v_large uuid; v_small uuid; v_half uuid;
  v_no uuid; v_egg uuid; v_cheese uuid; v_bacon uuid;
  v_o      uuid;    -- the probe's open order
  v_sel    jsonb;
  v_n      integer;
  v_hint   text;
  v_msg    text;
  v_prices numeric[];
BEGIN
  SELECT id INTO v_c FROM public.clients WHERE name = 'BLOOM CAFE';
  SELECT p.id INTO v_mgr
    FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c AND p.pos_email IS NOT NULL
   ORDER BY (p.pos_role = 'manager') DESC NULLS LAST, p.id
   LIMIT 1;
  IF v_c IS NULL OR v_mgr IS NULL THEN
    RAISE EXCEPTION 'S816 4h probe: needs BLOOM CAFE and a POS PIN login of it (got %, %)', v_c, v_mgr;
  END IF;
  IF NOT public.customization_live(v_c) THEN
    RAISE EXCEPTION 'S816 4h probe: Crest Customization is not live at BLOOM CAFE';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pos_orders WHERE client_id = v_c AND order_no BETWEEN 991601 AND 991610) THEN
    RAISE EXCEPTION 'S816 4h probe: a probe order number is already in use at BLOOM CAFE';
  END IF;

  BEGIN
    -- Slice 1b's build gate (if a floor is set when this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role ────────────────────────────────────────────────
    -- The stand-in loses every other staff marker (a restrictive policy would otherwise turn an
    -- "allowed" into a vacuous 0 rows).
    UPDATE public.profiles
       SET pos_role = 'manager', pos_allow_void = true, pos_discount_limit = 10, pos_blocked_at = NULL,
           settlement_blocked_by = NULL, ims_role = NULL, hr_role = NULL, hr_self_service = false
     WHERE id = v_mgr;

    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, is_active, pos_enabled)
      VALUES (v_c, 'S816 4h probe bowl', 'Food', 70.80, 0, true, true) RETURNING id INTO v_dish;
    INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select, included_count, size_scaling, sort, is_active)
      VALUES (v_c, 'S816 probe Size', 'size', 1, 1, 0, 'none', 900, true) RETURNING id INTO v_gs;
    INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select, included_count, size_scaling, sort, is_active)
      VALUES (v_c, 'S816 probe Toppings', 'addon', 0, 2, 1, 'stock_and_price', 901, true) RETURNING id INTO v_gt;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, portion_factor, sort, is_active)
      VALUES (v_c, v_gs, 'Regular', 0, 1, 0, true) RETURNING id INTO v_reg;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, portion_factor, sort, is_active)
      VALUES (v_c, v_gs, 'Large', 8.85, 1.5, 1, true) RETURNING id INTO v_large;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, portion_factor, sort, is_active)
      VALUES (v_c, v_gs, 'Small', -10, 0.75, 2, true) RETURNING id INTO v_small;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, portion_factor, sort, is_active)
      VALUES (v_c, v_gs, 'Half', -88.50, 0.5, 3, true) RETURNING id INTO v_half;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, is_removal, sort, is_active)
      VALUES (v_c, v_gt, 'No onion', 0, true, 0, true) RETURNING id INTO v_no;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort, is_active)
      VALUES (v_c, v_gt, 'Egg', 17.70, 1, true) RETURNING id INTO v_egg;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort, is_active)
      VALUES (v_c, v_gt, 'Cheese', 8.85, 2, true) RETURNING id INTO v_cheese;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort, is_active)
      VALUES (v_c, v_gt, 'Bacon', 46.90, 3, true) RETURNING id INTO v_bacon;
    INSERT INTO public.pos_recipe_option_groups (client_id, recipe_id, group_id, sort)
      VALUES (v_c, v_dish, v_gs, 0), (v_c, v_dish, v_gt, 1);
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no)
      VALUES (v_c, 'open', 'S816 4h probe', 991601) RETURNING id INTO v_o;

    -- ── (a) The guest path's pricer, as submit_guest_order calls it ─────────────────────────
    -- Q20 a: No onion takes no free pick and no place under "up to 2"; the Egg is the free one.
    v_sel := public.pos_price_selection(v_c, v_dish, ARRAY[v_reg, v_no, v_egg, v_cheese]);
    IF v_sel->>'problem' IS NOT NULL OR (v_sel->>'delta')::numeric <> 8.85
       OR (SELECT bool_or((x->>'included')::boolean) FROM jsonb_array_elements(v_sel->'options') x WHERE x->>'option_id' = v_no::text) THEN
      RAISE EXCEPTION 'S816 4h probe: No onion + Egg + Cheese priced % (want 8.85, No onion not free)', v_sel;
    END IF;
    -- CUSTOMIZATION-4's half paisa, as the till now works it: 8.85 x 1.5 = 13.28, 46.90 x 0.75 = 35.18.
    v_sel := public.pos_price_selection(v_c, v_dish, ARRAY[v_large, v_egg, v_cheese]);
    IF v_sel->>'problem' IS NOT NULL OR (v_sel->>'delta')::numeric <> 22.13 THEN
      RAISE EXCEPTION 'S816 4h probe: Large + Egg + Cheese priced % (want 22.13)', v_sel;
    END IF;
    v_sel := public.pos_price_selection(v_c, v_dish, ARRAY[v_small, v_egg, v_bacon]);
    IF v_sel->>'problem' IS NOT NULL OR (v_sel->>'delta')::numeric <> 25.18 THEN
      RAISE EXCEPTION 'S816 4h probe: Small + Egg + Bacon priced % (want 25.18)', v_sel;
    END IF;
    -- Three real toppings still break "up to 2"; a Half takes the dish below zero.
    v_sel := public.pos_price_selection(v_c, v_dish, ARRAY[v_reg, v_egg, v_cheese, v_bacon]);
    IF v_sel->>'problem' IS DISTINCT FROM 'option_count' THEN
      RAISE EXCEPTION 'S816 4h probe: three real toppings in "up to 2" gave %', v_sel;
    END IF;
    v_sel := public.pos_price_selection(v_c, v_dish, ARRAY[v_half]);
    IF v_sel->>'problem' IS DISTINCT FROM 'option_price_below_zero' THEN
      RAISE EXCEPTION 'S816 4h probe: a Half at minus NPR 17.70 gave %', v_sel;
    END IF;

    -- ── As the POS manager, through RLS and the INVOKER triggers ─────────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)
       OR NOT public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S816 4h probe: the stand-in % is not a plain POS manager', v_mgr;
    END IF;

    -- (b) The till's save prices the same three plates as the guest path did.
    PERFORM public.save_pos_order_items(v_o, jsonb_build_array(
      jsonb_build_object('recipe_id', v_dish, 'name', 'S816 4h probe bowl', 'qty', 1, 'options', jsonb_build_array(v_reg, v_no, v_egg, v_cheese)),
      jsonb_build_object('recipe_id', v_dish, 'name', 'S816 4h probe bowl', 'qty', 1, 'options', jsonb_build_array(v_large, v_egg, v_cheese)),
      jsonb_build_object('recipe_id', v_dish, 'name', 'S816 4h probe bowl', 'qty', 1, 'options', jsonb_build_array(v_small, v_egg, v_bacon))));
    SELECT array_agg(unit_price ORDER BY unit_price) INTO v_prices FROM public.pos_order_items WHERE order_id = v_o;
    IF v_prices IS DISTINCT FROM ARRAY[79.65, 92.93, 95.98]::numeric[] THEN
      RAISE EXCEPTION 'S816 4h probe: the till saved the three plates at % (want 79.65, 92.93, 95.98)', v_prices;
    END IF;
    SELECT count(*) INTO v_n FROM public.pos_order_item_options
     WHERE order_id = v_o AND option_id = v_no AND NOT included AND price_delta = 0;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S816 4h probe: the No onion snapshot row is not a plain, unfree removal (% rows)', v_n;
    END IF;
    SELECT count(*) INTO v_n FROM public.pos_order_item_options
     WHERE order_id = v_o AND option_id = v_egg AND included;
    IF v_n <> 3 THEN
      RAISE EXCEPTION 'S816 4h probe: the Egg was free on % of 3 plates', v_n;
    END IF;

    -- (c) A Half bowl added beside them is refused by name, and nothing on the order changes.
    BEGIN
      PERFORM public.save_pos_order_items(v_o, jsonb_build_array(
        jsonb_build_object('recipe_id', v_dish, 'name', 'S816 4h probe bowl', 'qty', 1, 'options', jsonb_build_array(v_reg, v_no, v_egg, v_cheese)),
        jsonb_build_object('recipe_id', v_dish, 'name', 'S816 4h probe bowl', 'qty', 1, 'options', jsonb_build_array(v_large, v_egg, v_cheese)),
        jsonb_build_object('recipe_id', v_dish, 'name', 'S816 4h probe bowl', 'qty', 1, 'options', jsonb_build_array(v_small, v_egg, v_bacon)),
        jsonb_build_object('recipe_id', v_dish, 'name', 'S816 4h probe bowl', 'qty', 1, 'options', jsonb_build_array(v_half))));
      RAISE EXCEPTION 'S816 4h probe: a bowl priced below zero was saved';
    EXCEPTION WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'option_price_below_zero' OR v_msg NOT LIKE 'option_price_below_zero: S816 4h probe bowl would cost less than nothing%' THEN
        RAISE EXCEPTION 'S816 4h probe: a below-zero bowl was refused with % (%)', v_hint, v_msg;
      END IF;
    END;
    -- (d) Three real toppings are still refused by the till's count.
    BEGIN
      PERFORM public.save_pos_order_items(v_o, jsonb_build_array(
        jsonb_build_object('recipe_id', v_dish, 'name', 'S816 4h probe bowl', 'qty', 1, 'options', jsonb_build_array(v_reg, v_egg, v_cheese, v_bacon))));
      RAISE EXCEPTION 'S816 4h probe: three real toppings in "up to 2" were saved';
    EXCEPTION WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'option_count' THEN
        RAISE EXCEPTION 'S816 4h probe: three real toppings were refused with % (%)', v_hint, v_msg;
      END IF;
    END;
    SELECT count(*) INTO v_n FROM public.pos_order_items WHERE order_id = v_o;
    IF v_n <> 3 THEN
      RAISE EXCEPTION 'S816 4h probe: after two refused saves the order holds % lines (want 3)', v_n;
    END IF;

    -- (e) CUSTOMIZATION-7: a per-dish rule on a Size is cleared, not kept.
    UPDATE public.pos_recipe_option_groups SET min_override = 0 WHERE recipe_id = v_dish AND group_id = v_gs;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 OR (SELECT min_override FROM public.pos_recipe_option_groups WHERE recipe_id = v_dish AND group_id = v_gs) IS NOT NULL THEN
      RAISE EXCEPTION 'S816 4h probe: a per-dish rule on the Size was kept (% rows updated)', v_n;
    END IF;
    -- A kind change clears the dish's own rule for Toppings in the same statement.
    UPDATE public.pos_recipe_option_groups SET min_override = 1, max_override = 1 WHERE recipe_id = v_dish AND group_id = v_gt;
    UPDATE public.pos_option_groups SET kind = 'choice' WHERE id = v_gt;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 OR EXISTS (SELECT 1 FROM public.pos_recipe_option_groups
                            WHERE recipe_id = v_dish AND group_id = v_gt
                              AND (min_override IS NOT NULL OR max_override IS NOT NULL)) THEN
      RAISE EXCEPTION 'S816 4h probe: the kind change kept the dish''s own rule (% groups updated)', v_n;
    END IF;
    -- A Size holds no "No ..." option, and a group holding one does not become a Size.
    BEGIN
      INSERT INTO public.pos_options (client_id, group_id, name, price_delta, is_removal, sort, is_active)
        VALUES (v_c, v_gs, 'No size', 0, true, 9, true);
      RAISE EXCEPTION 'S816 4h probe: a removal was added to a Size';
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'option_removal_in_size' THEN
        RAISE EXCEPTION 'S816 4h probe: a removal in a Size was refused with %', v_hint;
      END IF;
    END;
    BEGIN
      UPDATE public.pos_option_groups
         SET kind = 'size', min_select = 1, max_select = 1, included_count = 0, size_scaling = 'none'
       WHERE id = v_gt;
      RAISE EXCEPTION 'S816 4h probe: a group holding No onion became a Size';
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'group_kind_has_removals' THEN
        RAISE EXCEPTION 'S816 4h probe: turning Toppings into a Size was refused with %', v_hint;
      END IF;
    END;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's816_4h_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's816_4h_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT p.oid::regprocedure, md5(p.prosrc), p.prosecdef, p.provolatile, p.proacl FROM pg_proc p
--    WHERE p.pronamespace = 'public'::regnamespace
--      AND p.proname IN ('save_pos_order_items', 'pos_price_selection', 'guard_pos_option_edit',
--                        'pos_option_group_kind_resets_rules');
--     expect save 1d391512d03cd0abe6f690efbae90806, selection 36fc3c77bbd675450216d19b63703c10,
--     guard 3a634fff9d586f435bb15e86eb5e5d88; prosecdef f on all four; proacl unchanged on the first
--     three ({postgres=X/postgres,authenticated=X/postgres}, {postgres=X/postgres,service_role=X/postgres},
--     {postgres=X/postgres}) and {postgres=X/postgres} on the new trigger function.
--   SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
--    WHERE tgrelid = 'public.pos_option_groups'::regclass AND NOT tgisinternal;   -- the guard and the reset
--   SELECT count(*) FROM public.pos_recipe_option_groups a JOIN public.pos_option_groups g ON g.id = a.group_id
--    WHERE g.kind = 'size' AND (a.min_override IS NOT NULL OR a.max_override IS NOT NULL);   -- 0
