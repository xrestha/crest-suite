-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 2, slice 2h: a dish that must have a choice cannot reach the till without one, a dish
-- with no price cannot be billed at NPR 0, and an HQ push leaves each branch's own "On POS" alone.
--
--   CUSTOMIZATION-3 (P2). save_pos_order_items counted a dish's picks against its groups' rules only
--   for a line that SENT options, so a dish that must have a size or a base, sent with none, was
--   stored at the dish's plain price with nothing for the kitchen: from a till whose menu was read
--   before the dish had choices (a table already open, an offline till's saved copy) or a hand-made
--   call. submit_guest_order already checks a customizable dish "picks or not", so the two server
--   copies of the rule disagreed. Now every NEW line of a dish is counted while Customization is live
--   (a line with no options counts 0 in each group), exactly as pos_price_selection counts it: a
--   group with nothing offered is skipped, and with the module off a dish orders plain, as on the
--   guest path. A line already on the order keeps its exemption, so a dish that gains a required
--   group mid-meal does not lock a running order. Refused as option_count, which every till build
--   already handles (it re-reads the menu and says "change the choices"); errorText's staff words
--   now name the missing-choice case.
--
--   The unpriced new line (GAP-OUTLETS-2's defence in depth). The till priced a new line
--   COALESCE(selling_price, 0) + choices, and nothing checked the price, so a dish On POS with no
--   price (a recipe switched On POS before anyone priced it, or a dish an HQ push added to a branch
--   unpriced and the next push switched back on) was billed at NPR 0 on a Tax Invoice. The guest
--   order already refuses such a dish (selling_price > 0) and the guest menu leaves it out. Now
--   save_pos_order_items refuses a NEW line whose dish has no price above zero, naming the dish,
--   under line_not_on_menu: every till build shows that sentence on the order screen after "Not
--   saved —", re-reads its menu, and an offline replay lists the line with the other off-menu lines.
--   The till's menu read (this slice) leaves such a dish out, as the guest menu does. A line already
--   on the order keeps the price it was saved with. NPR 0 counts as no price, as on the guest path: a
--   dish given away goes through Complimentary (rank, reason, NC slip, food cost as a comp).
--
--   S809.4 item from the 2b review (P2). save_pos_order_items left comped rows out of before_sent
--   (the pulled-item record) and stored_sent (the kitchen floor, S809 1d). A comp sits on an OPEN
--   order only after a cancelled close, and the till folds it back into its line (2b,
--   foldCompedSplits), so the folded dish's comped units read as never sent: a save could mark them
--   unsent (a second kitchen ticket) and taking the dish off recorded no pull. Both now count them.
--   apply_pos_item_comps shares the sent count between the two rows (S809 1j), so the sum is the
--   line's count, never more.
--
--   GAP-OUTLETS-2 (P2; owner decision Q25 a, 2026-10-09: "after an HQ push, the branch's own On POS
--   and Active stand"). push_master_data's UPDATE wrote HQ's is_active and pos_enabled onto every
--   branch dish it updated or adopted, so a dish a branch had taken off its till came back, and a dish
--   that arrived off the till unpriced (a VAT-differing branch, S792 stage 3) came back On POS at
--   NPR 0. The UPDATE no longer writes either. A NEW dish has no branch setting yet, so it starts from
--   HQ's switches, except that it arrives off the till, unpriced, when HQ has no price above zero for
--   it (as it already did when the branch's VAT status differs): it is then the branch's to price and
--   switch on, and later pushes leave that choice alone. A price push never writes a price HQ does not
--   have over the branch's own. The preview names what a new dish arrives as and when a price push
--   keeps the branch's price. Out of scope and not made worse: the push still carries no option groups
--   and no build-your-own mark (POS_TODO §A).
--
--   CUSTOMIZATION-1 is the browser's half (Option Groups' VAT basis, OptionGroups.jsx / OptionModal.jsx).
--
-- Built on the LIVE bodies (pg_get_functiondef, md5(prosrc), read 2026-10-09). Section 0 refuses to
-- run over any other body. Every change inside them is marked "S809 2h". Signatures, SECURITY mode
-- and grants are unchanged (CREATE OR REPLACE keeps the grants).
--   save_pos_order_items(uuid, jsonb, text, integer)   6237a343f566d8fa04b822ca653f742a  (slice 1d's)
--   push_master_data(uuid[], text[], boolean)          270f61c7e6a01e5b43c95d1c951db6fd  (S792 stage 3's)
-- 2g (drafted alongside) replaces award_loyalty_points, redeem_loyalty_points and
-- guard_pos_order_close; nothing here touches them.
--
-- Live before this migration (2026-10-09, every client):
--   * Dishes on a till menu (active, On POS, not a sub-recipe) with no price or a price of 0 or less:
--     0. Only CASA ACAI CAFE has dishes on a till menu (86, all priced; its POS is off); BLOOM CAFE and
--     BLOOM CAFE - PKR have no recipes since the owner's clear. Of all 157 recipes, 0 non-sub-recipe
--     dishes are unpriced. So the new refusal rejects nothing anyone sells today.
--   * pos_orders: 0 rows (0 open, 0 comped lines). Nothing stored meets the new rules.
--   * Customization: 0 clients switched on, 0 option groups, 0 dish attachments. CUSTOMIZATION-3's
--     refusal rejects nothing today.
--   * Outlet groups: 1, BLOOM CAFE (HQ) + BLOOM CAFE - PKR (branch), both PAN-bill. No push has run
--     (0 recipes and 0 items carry a master_id), so no branch switch has been overwritten yet.
-- No constraint is added and no stored row is written.
--
-- The probe at the end runs as BLOOM CAFE's POS PIN supervisor (the till's saves) and its Owner (the
-- HQ push to BLOOM CAFE - PKR), brings every row it needs (dishes, option groups, orders, a cancelled
-- close's comp, HQ and branch dishes) and rolls itself back. If any check fails, the whole migration
-- fails and nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces are the ones it was built on ─────────────────
--
-- CREATE OR REPLACE would silently revert another change to either of them. The second hash of each
-- pair is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.save_pos_order_items(uuid,jsonb,text,integer)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '6237a343f566d8fa04b822ca653f742a' AND v_md5 IS DISTINCT FROM 'c4f6e364e0cb5717eb4d1147025428b6' THEN
    RAISE EXCEPTION 'S809 2h: save_pos_order_items changed since this slice was drafted (live md5 %) — merge section 1 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.push_master_data(uuid[],text[],boolean)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '270f61c7e6a01e5b43c95d1c951db6fd' AND v_md5 IS DISTINCT FROM '18817185fce6a1eaf215afc52876ee53' THEN
    RAISE EXCEPTION 'S809 2h: push_master_data changed since this slice was drafted (live md5 %) — merge section 2 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  -- No public function may have a second overload (the S630 rule); this file keeps both signatures.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'save_pos_order_items') <> 1
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'push_master_data') <> 1 THEN
    RAISE EXCEPTION 'S809 2h: save_pos_order_items or push_master_data has more than one signature';
  END IF;
END;
$$;


-- ── 1. save_pos_order_items (signature, SECURITY INVOKER and grants unchanged) ───────────────
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
        SELECT count(*) AS picked
          FROM jsonb_array_elements_text(r->'option_ids') e
          JOIN pos_options o ON o.id = e::uuid AND o.group_id = g.id
      ) c
     WHERE NOT (r->>'line_key') = ANY (v_existing)   -- S809 2h: options sent or not
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
$function$;


-- ── 2. push_master_data (signature, SECURITY DEFINER and grants unchanged) ──────────────────
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
                    -- S809 2h: what a NEW dish arrives as (the INSERT below copies HQ's price
                    -- whether or not prices were asked for), and a price push never blanks a
                    -- branch's price with one HQ does not have.
                    WHEN d.id IS NULL AND s.category IS DISTINCT FROM 'Sub-Recipe'
                         AND NOT COALESCE(s.selling_price > 0, false)
                      THEN 'added OFF the till with no price: HQ has not priced it yet. Set its price at this branch, then switch it On POS'
                    WHEN d.id IS NULL AND s.category IS DISTINCT FROM 'Sub-Recipe'
                      THEN 'added at HQ''s price, ' ||
                           CASE WHEN s.pos_enabled IS NOT DISTINCT FROM false THEN 'off the till' ELSE 'on the till' END ||
                           ' as it is at HQ'
                    WHEN v_do_prc AND s.category IS DISTINCT FROM 'Sub-Recipe'
                         AND NOT COALESCE(s.selling_price > 0, false)
                      THEN 'selling price left as the branch has it: HQ has no price for it'
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
             -- S809 2h (GAP-OUTLETS-2): one HQ has not priced arrives off the till too, for
             -- the same reason. Otherwise HQ's switch is the new dish's starting point.
             CASE WHEN COALESCE(r.vat_differs, false) THEN false
                  WHEN s.category IS DISTINCT FROM 'Sub-Recipe' AND NOT COALESCE(s.selling_price > 0, false) THEN false
                  ELSE s.pos_enabled END,
             s.hsc_code
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


-- ── 3. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_c        uuid;    -- BLOOM CAFE, the HQ of its group
  v_c2       uuid;    -- BLOOM CAFE - PKR, its branch
  v_pin      uuid;    -- BLOOM CAFE's POS PIN login (its supervisor where there is one)
  v_owner    uuid;    -- BLOOM CAFE's Owner
  v_group    uuid;
  v_bowl     uuid;    -- NPR 400: must have a size (Small +0 / Large +100); Cheese +50 is optional
  v_late     uuid;    -- NPR 300: given a required size only after it was already on an order
  v_soup     uuid;    -- NPR 200: a required base whose only option is hidden (nothing to choose)
  v_tea      uuid;    -- NPR 50: no choices
  v_free     uuid;    -- On POS with no price
  v_zero     uuid;    -- On POS at NPR 0
  v_g_size   uuid;
  v_g_extra  uuid;
  v_g_soup   uuid;
  v_g_late   uuid;
  v_large    uuid;
  v_cheese   uuid;
  v_o1       uuid;    -- new lines
  v_o2       uuid;    -- already holds the late dish and the unpriced dish, from before
  v_o3       uuid;    -- a cancelled close's comp: what the kitchen has
  v_o4       uuid;    -- new lines elsewhere; Customization switched off
  v_o5       uuid;    -- a cancelled close's comp: the pulled-item record
  v_h_keep   uuid;    -- HQ dishes and the branch's own, for the push
  v_b_keep   uuid;
  v_h_adopt  uuid;
  v_b_adopt  uuid;
  v_h_new    uuid;
  v_h_bare   uuid;    -- HQ has no price for it; On POS at HQ; the branch does not have it
  v_h_nop    uuid;    -- HQ has no price for it; the branch's linked copy has one
  v_b_nop    uuid;
  v_branch_n int;     -- the branch's recipes before any push
  v_res      jsonb;
  v_n        int;
  v_q        int;
  v_by       uuid;
  v_hint     text;
  v_msg      text;
  v_reason   text;
  v_name     text;
  v_id       uuid;
  v_master   uuid;
  v_price    numeric;
  v_vat      numeric;
  v_on       boolean;
  v_act      boolean;
BEGIN
  -- ── Catalog. Asserted on catalog columns, never on formatted text ─────────────────────────
  -- save_pos_order_items stays SECURITY INVOKER (every RESTRICTIVE staff-isolation family on the
  -- line tables keeps applying) and push_master_data SECURITY DEFINER (it writes across outlets);
  -- each keeps its one signature and its authenticated-only EXECUTE.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'save_pos_order_items') <> 1
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'push_master_data') <> 1 THEN
    RAISE EXCEPTION 'S809 2h: save_pos_order_items or push_master_data has more than one signature';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.save_pos_order_items(uuid,jsonb,text,integer)'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.push_master_data(uuid[],text[],boolean)'::regprocedure) THEN
    RAISE EXCEPTION 'S809 2h: save_pos_order_items became SECURITY DEFINER, or push_master_data stopped being one';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.save_pos_order_items(uuid,jsonb,text,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.save_pos_order_items(uuid,jsonb,text,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.push_master_data(uuid[],text[],boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.push_master_data(uuid[],text[],boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S809 2h: save_pos_order_items or push_master_data is not authenticated-only';
  END IF;

  -- ── The logins: BLOOM CAFE's POS PIN login and its Owner; BLOOM CAFE - PKR as the branch ───
  SELECT id INTO v_c  FROM public.clients WHERE name = 'BLOOM CAFE';
  SELECT id INTO v_c2 FROM public.clients WHERE name = 'BLOOM CAFE - PKR';
  SELECT p.id INTO v_pin
    FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c AND p.pos_email IS NOT NULL
   ORDER BY (p.pos_role = 'supervisor') DESC NULLS LAST, p.id
   LIMIT 1;
  -- The push reads the Owner's HOME outlet's group (my_group_id), so the Owner works from BLOOM CAFE.
  SELECT p.id INTO v_owner
    FROM public.profiles p
   WHERE p.role = 'client' AND p.client_id = v_c AND COALESCE(p.active_client_id, p.client_id) = v_c
     AND p.pos_email IS NULL AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY p.id
   LIMIT 1;
  IF v_c IS NULL OR v_c2 IS NULL OR v_pin IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'S809 2h probe: needs BLOOM CAFE, BLOOM CAFE - PKR, a POS PIN login and the Owner of BLOOM CAFE (got %, %, %, %)',
      v_c, v_c2, v_pin, v_owner;
  END IF;

  BEGIN
    -- Slice 1b's build gate (if a floor is set when this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role ────────────────────────────────────────────────
    -- The stand-in loses every other staff marker, or a restrictive policy would turn an "allowed"
    -- into a vacuous 0 rows (the S792 lesson). Customization is switched on at BLOOM CAFE (its POS is
    -- on) for the length of the probe.
    UPDATE public.profiles
       SET pos_role = 'supervisor', settlement_blocked_by = NULL, ims_role = NULL, hr_role = NULL, hr_self_service = false
     WHERE id = v_pin;
    UPDATE public.clients SET customization_enabled = true WHERE id = v_c;
    IF NOT public.customization_live(v_c) THEN
      RAISE EXCEPTION 'S809 2h probe: Customization could not be switched on at BLOOM CAFE (is its POS on?)';
    END IF;

    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, pos_enabled, is_active)
      VALUES (v_c, 'S809 2h probe bowl', 'Food', 400, 0, true, true) RETURNING id INTO v_bowl;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, pos_enabled, is_active)
      VALUES (v_c, 'S809 2h probe late', 'Food', 300, 0, true, true) RETURNING id INTO v_late;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, pos_enabled, is_active)
      VALUES (v_c, 'S809 2h probe soup', 'Food', 200, 0, true, true) RETURNING id INTO v_soup;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, pos_enabled, is_active)
      VALUES (v_c, 'S809 2h probe tea', 'Drinks', 50, 0, true, true) RETURNING id INTO v_tea;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, pos_enabled, is_active)
      VALUES (v_c, 'S809 2h probe free', 'Food', NULL, 0, true, true) RETURNING id INTO v_free;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, pos_enabled, is_active)
      VALUES (v_c, 'S809 2h probe zero', 'Food', 0, 0, true, true) RETURNING id INTO v_zero;

    INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select, sort)
      VALUES (v_c, 'S809 2h probe size', 'size', 1, 1, 0) RETURNING id INTO v_g_size;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort)
      VALUES (v_c, v_g_size, 'S809 2h probe small', 0, 0);
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort)
      VALUES (v_c, v_g_size, 'S809 2h probe large', 100, 1) RETURNING id INTO v_large;
    INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select, sort)
      VALUES (v_c, 'S809 2h probe extras', 'addon', 0, 2, 1) RETURNING id INTO v_g_extra;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort)
      VALUES (v_c, v_g_extra, 'S809 2h probe cheese', 50, 0) RETURNING id INTO v_cheese;
    INSERT INTO public.pos_recipe_option_groups (client_id, recipe_id, group_id, sort)
      VALUES (v_c, v_bowl, v_g_size, 0), (v_c, v_bowl, v_g_extra, 1);
    -- The soup must have a base, and its only base is hidden: there is nothing to choose.
    INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select, sort)
      VALUES (v_c, 'S809 2h probe soup base', 'choice', 1, 1, 2) RETURNING id INTO v_g_soup;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort, is_active)
      VALUES (v_c, v_g_soup, 'S809 2h probe hidden base', 0, 0, false);
    INSERT INTO public.pos_recipe_option_groups (client_id, recipe_id, group_id, sort)
      VALUES (v_c, v_soup, v_g_soup, 0);
    INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select, sort)
      VALUES (v_c, 'S809 2h probe late size', 'size', 1, 1, 3) RETURNING id INTO v_g_late;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, sort)
      VALUES (v_c, v_g_late, 'S809 2h probe regular', 0, 0);

    -- Takeaway orders. order_no is given, so the probe takes no lock on the outlet's real series.
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2h probe', 990501) RETURNING id INTO v_o1;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2h probe', 990502) RETURNING id INTO v_o2;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2h probe', 990503) RETURNING id INTO v_o3;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2h probe', 990504) RETURNING id INTO v_o4;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2h probe', 990505) RETURNING id INTO v_o5;
    -- o2 took the late dish before it had a required size, and the free dish when it cost NPR 120.
    INSERT INTO public.pos_order_items (order_id, client_id, recipe_id, name, qty, unit_price, vat_rate)
      VALUES (v_o2, v_c, v_late, 'S809 2h probe late', 1, 300, 0),
             (v_o2, v_c, v_free, 'S809 2h probe free', 1, 120, 0);
    INSERT INTO public.pos_recipe_option_groups (client_id, recipe_id, group_id, sort)
      VALUES (v_c, v_late, v_g_late, 0);
    -- o3 and o5: 3 teas, all sent; a close that then failed comped 1 of them (apply_pos_item_comps
    -- shares the sent count: 2 on the charged row, 1 on the comp).
    INSERT INTO public.pos_order_items (order_id, client_id, recipe_id, name, qty, unit_price, vat_rate, sent_to_kot, sent_qty)
      VALUES (v_o3, v_c, v_tea, 'S809 2h probe tea', 2, 50, 0, true, 2),
             (v_o5, v_c, v_tea, 'S809 2h probe tea', 2, 50, 0, true, 2);
    INSERT INTO public.pos_order_items (order_id, client_id, recipe_id, name, qty, unit_price, vat_rate, sent_to_kot, sent_qty,
                                        comped, comp_reason, comp_no, comp_fy)
      VALUES (v_o3, v_c, v_tea, 'S809 2h probe tea', 1, 50, 0, true, 1, true, 'probe', 990, 'S809-2h'),
             (v_o5, v_c, v_tea, 'S809 2h probe tea', 1, 50, 0, true, 1, true, 'probe', 990, 'S809-2h');

    -- ── (a) The till: BLOOM CAFE's POS supervisor ───────────────────────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)
       OR NOT public.pos_caller_has_rank('supervisor') THEN
      RAISE EXCEPTION 'S809 2h probe: the stand-in % is not a POS supervisor', v_pin;
    END IF;

    -- CUSTOMIZATION-3: the bowl sent with no choices, or with an extra and no size, is refused
    -- (option_count, naming its size group), and nothing is written.
    FOR v_res IN SELECT x FROM jsonb_array_elements(jsonb_build_array(
        jsonb_build_object('recipe_id', v_bowl, 'name', 'S809 2h probe bowl', 'qty', 1),
        jsonb_build_object('recipe_id', v_bowl, 'name', 'S809 2h probe bowl', 'qty', 1, 'options', jsonb_build_array(v_cheese)))) AS t(x)
    LOOP
      BEGIN
        PERFORM public.save_pos_order_items(v_o1, jsonb_build_array(v_res), NULL, NULL);
        RAISE EXCEPTION 'S809 2h probe: a bowl with no size was saved: %', v_res;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
        IF v_hint IS DISTINCT FROM 'option_count' OR position('S809 2h probe size' IN v_msg) = 0 THEN
          RAISE EXCEPTION 'S809 2h probe: a bowl with no size — expected option_count naming its size group, got: % / %', v_hint, v_msg;
        END IF;
      END;
    END LOOP;

    -- With its size the bowl lands, priced from the menu (400 + Large 100 + Cheese 50) with both
    -- choices on the ticket. The tea (no groups) lands plain, and so does the soup: its required
    -- base offers nothing (the only option is hidden), and a guest cannot be made to choose from
    -- nothing.
    v_res := public.save_pos_order_items(v_o1, jsonb_build_array(
      jsonb_build_object('recipe_id', v_bowl, 'name', 'S809 2h probe bowl', 'qty', 1, 'options', jsonb_build_array(v_cheese, v_large)),
      jsonb_build_object('recipe_id', v_tea,  'name', 'S809 2h probe tea',  'qty', 2),
      jsonb_build_object('recipe_id', v_soup, 'name', 'S809 2h probe soup', 'qty', 1)), NULL, NULL);
    IF (v_res ->> 'inserted')::int IS DISTINCT FROM 3
       OR (SELECT (i ->> 'unit_price')::numeric FROM jsonb_array_elements(v_res -> 'items') i WHERE i ->> 'recipe_id' = v_bowl::text) IS DISTINCT FROM 550
       OR (SELECT jsonb_array_length(i -> 'options') FROM jsonb_array_elements(v_res -> 'items') i WHERE i ->> 'recipe_id' = v_bowl::text) IS DISTINCT FROM 2
       OR (SELECT (i ->> 'unit_price')::numeric FROM jsonb_array_elements(v_res -> 'items') i WHERE i ->> 'recipe_id' = v_soup::text) IS DISTINCT FROM 200 THEN
      RAISE EXCEPTION 'S809 2h probe: the sized bowl, the tea and the soup did not land as 3 lines with the bowl at 550 and 2 choices: %', v_res;
    END IF;

    -- A line already on the order keeps its exemptions: o2's late dish, from before its size was
    -- required, and its free dish, at the NPR 120 it was saved with. One more of each and a tea land,
    -- and both keep their stored price.
    v_res := public.save_pos_order_items(v_o2, jsonb_build_array(
      jsonb_build_object('recipe_id', v_late, 'name', 'S809 2h probe late', 'qty', 2),
      jsonb_build_object('recipe_id', v_free, 'name', 'S809 2h probe free', 'qty', 2),
      jsonb_build_object('recipe_id', v_tea,  'name', 'S809 2h probe tea',  'qty', 1)), NULL, NULL);
    IF (v_res ->> 'inserted')::int IS DISTINCT FROM 3
       OR (SELECT (i ->> 'unit_price')::numeric FROM jsonb_array_elements(v_res -> 'items') i WHERE i ->> 'recipe_id' = v_late::text) IS DISTINCT FROM 300
       OR (SELECT (i ->> 'unit_price')::numeric FROM jsonb_array_elements(v_res -> 'items') i WHERE i ->> 'recipe_id' = v_free::text) IS DISTINCT FROM 120 THEN
      RAISE EXCEPTION 'S809 2h probe: a line already on the order was refused or re-priced: %', v_res;
    END IF;
    -- ...but a NEW line of the late dish, on another order, must now have its size.
    BEGIN
      PERFORM public.save_pos_order_items(v_o4, jsonb_build_array(
        jsonb_build_object('recipe_id', v_late, 'name', 'S809 2h probe late', 'qty', 1)), NULL, NULL);
      RAISE EXCEPTION 'S809 2h probe: a new line of the late dish was saved with no size';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'option_count' OR position('S809 2h probe late size' IN v_msg) = 0 THEN
        RAISE EXCEPTION 'S809 2h probe: a new plain late dish — expected option_count, got: % / %', v_hint, v_msg;
      END IF;
    END;

    -- GAP-OUTLETS-2's defence: a NEW line of a dish with no price, or a price of 0, is refused under
    -- line_not_on_menu, naming the dish, and nothing is written (o1 keeps its three lines).
    FOR v_id IN SELECT unnest(ARRAY[v_free, v_zero]) LOOP
      BEGIN
        PERFORM public.save_pos_order_items(v_o1, jsonb_build_array(
          jsonb_build_object('recipe_id', v_tea, 'name', 'S809 2h probe tea', 'qty', 2),
          jsonb_build_object('recipe_id', v_id,  'name', 'S809 2h probe',     'qty', 1)), NULL, NULL);
        RAISE EXCEPTION 'S809 2h probe: a dish with no price was saved as a new line (%)', v_id;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
        SELECT name INTO v_name FROM public.recipes WHERE id = v_id;
        IF v_hint IS DISTINCT FROM 'line_not_on_menu' OR position('has no menu price yet' IN v_msg) = 0
           OR position(v_name IN v_msg) = 0 THEN
          RAISE EXCEPTION 'S809 2h probe: an unpriced new line — expected line_not_on_menu naming %, got: % / %', v_name, v_hint, v_msg;
        END IF;
      END;
    END LOOP;
    IF (SELECT count(*) FROM public.pos_order_items WHERE order_id = v_o1) <> 3 THEN
      RAISE EXCEPTION 'S809 2h probe: a refused save changed the order''s lines';
    END IF;

    -- ── (b) S809.4: what the kitchen has includes a comp a cancelled close left ─────────────
    -- o3's three teas, folded back into one line by the till, sent by a till that lost the sent
    -- marks: the kitchen still has all 3, so all 3 stay sent (a fresh ticket would cook them again).
    v_res := public.save_pos_order_items(v_o3, jsonb_build_array(
      jsonb_build_object('recipe_id', v_tea, 'name', 'S809 2h probe tea', 'qty', 3, 'sent_to_kot', false, 'sent_qty', 0)), NULL, NULL);
    IF jsonb_array_length(v_res -> 'items') IS DISTINCT FROM 1
       OR (v_res -> 'items' -> 0 ->> 'qty')::int IS DISTINCT FROM 3
       OR (v_res -> 'items' -> 0 ->> 'sent_qty')::int IS DISTINCT FROM 3 THEN
      RAISE EXCEPTION 'S809 2h probe: the folded teas did not keep all 3 as sent: %', v_res;
    END IF;
    -- o5's comped tea is taken off with a reason: that is a pull of 1, under the supervisor.
    PERFORM public.save_pos_order_items(v_o5, jsonb_build_array(
      jsonb_build_object('recipe_id', v_tea, 'name', 'S809 2h probe tea', 'qty', 2, 'sent_to_kot', true, 'sent_qty', 2)),
      'S809 2h probe reason', NULL);

    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    IF EXISTS (SELECT 1 FROM public.pos_kot_removals WHERE order_id = v_o3) THEN
      RAISE EXCEPTION 'S809 2h probe: keeping all three teas recorded a pull';
    END IF;
    SELECT count(*), min(qty_removed), min(removed_by::text)::uuid, min(reason)
      INTO v_n, v_q, v_by, v_reason
      FROM public.pos_kot_removals WHERE order_id = v_o5;
    IF v_n <> 1 OR v_q IS DISTINCT FROM 1 OR v_by IS DISTINCT FROM v_pin OR v_reason IS DISTINCT FROM 'S809 2h probe reason' THEN
      RAISE EXCEPTION 'S809 2h probe: taking off the comped tea recorded % pull(s), qty %, by %, reason %', v_n, v_q, v_by, v_reason;
    END IF;

    -- ── (c) Customization switched off: a dish orders plain, whatever groups are still attached,
    -- as on the guest path ────────────────────────────────────────────────────────────────────
    UPDATE public.clients SET customization_enabled = false WHERE id = v_c;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_res := public.save_pos_order_items(v_o4, jsonb_build_array(
      jsonb_build_object('recipe_id', v_bowl, 'name', 'S809 2h probe bowl', 'qty', 1)), NULL, NULL);
    IF (v_res ->> 'inserted')::int IS DISTINCT FROM 1
       OR (v_res -> 'items' -> 0 ->> 'unit_price')::numeric IS DISTINCT FROM 400
       OR jsonb_array_length(v_res -> 'items' -> 0 -> 'options') IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'S809 2h probe: with Customization off the plain bowl did not land at NPR 400: %', v_res;
    END IF;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);

    -- ── (d) GAP-OUTLETS-2: an HQ push leaves each branch's own On POS and Active ────────────
    -- BLOOM CAFE is the HQ of its group and PKR a branch (made so here if the group has changed since
    -- 2026-10-09). HQ's dishes, and the branch's own: a linked copy it took off its till and hid, a
    -- same-named dish not yet linked and off its till, and a linked copy it priced that HQ has not.
    SELECT group_id INTO v_group FROM public.clients WHERE id = v_c;
    IF v_group IS NULL THEN
      INSERT INTO public.client_groups (name, hq_client_id) VALUES ('S809 2h probe group', v_c) RETURNING id INTO v_group;
      UPDATE public.clients SET group_id = v_group WHERE id = v_c;
    END IF;
    UPDATE public.client_groups SET hq_client_id = v_c WHERE id = v_group AND hq_client_id IS DISTINCT FROM v_c;
    UPDATE public.clients SET group_id = v_group WHERE id = v_c2 AND group_id IS DISTINCT FROM v_group;

    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, pos_enabled, is_active)
      VALUES (v_c, 'S809 2h probe momo', 'Food', 250, 0, true, true) RETURNING id INTO v_h_keep;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, pos_enabled, is_active)
      VALUES (v_c, 'S809 2h probe thali', 'Food', 400, 0, true, true) RETURNING id INTO v_h_adopt;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, pos_enabled, is_active)
      VALUES (v_c, 'S809 2h probe lassi', 'Drinks', 150, 0, true, true) RETURNING id INTO v_h_new;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, pos_enabled, is_active)
      VALUES (v_c, 'S809 2h probe special', 'Food', NULL, 0, true, true) RETURNING id INTO v_h_bare;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, pos_enabled, is_active)
      VALUES (v_c, 'S809 2h probe soup of the day', 'Food', NULL, 0, true, true) RETURNING id INTO v_h_nop;
    INSERT INTO public.recipes (client_id, master_id, name, category, selling_price, vat_rate, pos_enabled, is_active)
      VALUES (v_c2, v_h_keep, 'S809 2h probe momo (old name)', 'Food', 300, 0, false, false) RETURNING id INTO v_b_keep;
    INSERT INTO public.recipes (client_id, master_id, name, category, selling_price, vat_rate, pos_enabled, is_active)
      VALUES (v_c2, NULL, 'S809 2h probe thali', 'Food', 450, 0, false, true) RETURNING id INTO v_b_adopt;
    INSERT INTO public.recipes (client_id, master_id, name, category, selling_price, vat_rate, pos_enabled, is_active)
      VALUES (v_c2, v_h_nop, 'S809 2h probe soup of the day', 'Food', 180, 0, true, true) RETURNING id INTO v_b_nop;
    SELECT count(*) INTO v_branch_n FROM public.recipes WHERE client_id = v_c2;

    -- Each push below runs as the Owner in a block of its own that rolls itself back, so each one
    -- starts from the setup above (and push_master_data's ON COMMIT DROP plan table goes with it).

    -- (d1) The preview says what each dish does, and writes nothing.
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      IF NOT COALESCE(public.is_client_owner(), false) THEN
        RAISE EXCEPTION 'S809 2h probe: % is not an Owner login', v_owner;
      END IF;
      SELECT jsonb_object_agg(p.record_name, jsonb_build_object('action', p.action, 'detail', p.detail)) INTO v_res
        FROM public.push_master_data(ARRAY[v_c2], ARRAY['recipes', 'prices'], true) p
       WHERE p.entity = 'recipes' AND p.record_name LIKE 'S809 2h probe %';
      RESET ROLE;
      PERFORM set_config('request.jwt.claims', '', true);
      IF NOT COALESCE(
              v_res -> 'S809 2h probe special' ->> 'action' = 'create'
          AND v_res -> 'S809 2h probe special' ->> 'detail' LIKE 'added OFF the till with no price: HQ has not priced it yet%'
          AND v_res -> 'S809 2h probe lassi' ->> 'action' = 'create'
          AND v_res -> 'S809 2h probe lassi' ->> 'detail' = 'added at HQ''s price, on the till as it is at HQ'
          AND v_res -> 'S809 2h probe soup of the day' ->> 'action' = 'update'
          AND v_res -> 'S809 2h probe soup of the day' ->> 'detail' = 'selling price left as the branch has it: HQ has no price for it'
          AND v_res -> 'S809 2h probe momo' ->> 'action' = 'update'
          AND v_res -> 'S809 2h probe momo' ->> 'detail' = 'selling price included'
          AND v_res -> 'S809 2h probe thali' ->> 'action' = 'adopt', false) THEN
        RAISE EXCEPTION 'S809 2h probe: the push preview reads %', v_res;
      END IF;
      IF (SELECT count(*) FROM public.recipes WHERE client_id = v_c2) <> v_branch_n THEN
        RAISE EXCEPTION 'S809 2h probe: the preview wrote to the branch';
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_2h_push_rollback';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 's809_2h_push_rollback' THEN RAISE; END IF;
    END;

    -- (d2) A recipes push (no prices): the update runs, and each branch dish keeps its own switches.
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      PERFORM * FROM public.push_master_data(ARRAY[v_c2], ARRAY['recipes'], false);
      RESET ROLE;
      PERFORM set_config('request.jwt.claims', '', true);
      -- The linked copy took HQ's name (the update ran) and kept its own On POS (off), Active (off)
      -- and price.
      SELECT name, pos_enabled, is_active, selling_price INTO v_name, v_on, v_act, v_price
        FROM public.recipes WHERE id = v_b_keep;
      IF v_name IS DISTINCT FROM 'S809 2h probe momo' OR v_on IS DISTINCT FROM false
         OR v_act IS DISTINCT FROM false OR v_price IS DISTINCT FROM 300 THEN
        RAISE EXCEPTION 'S809 2h probe: the branch''s momo after a push: name %, On POS %, active %, price %', v_name, v_on, v_act, v_price;
      END IF;
      -- The same-named dish was adopted, and kept its own On POS (off) and price.
      SELECT master_id, pos_enabled, is_active, selling_price INTO v_master, v_on, v_act, v_price
        FROM public.recipes WHERE id = v_b_adopt;
      IF v_master IS DISTINCT FROM v_h_adopt OR v_on IS DISTINCT FROM false OR v_act IS DISTINCT FROM true
         OR v_price IS DISTINCT FROM 450 THEN
        RAISE EXCEPTION 'S809 2h probe: the adopted thali: master %, On POS %, active %, price %', v_master, v_on, v_act, v_price;
      END IF;
      -- A new dish starts as it is at HQ: HQ's price, On POS, active.
      SELECT selling_price, pos_enabled, is_active INTO v_price, v_on, v_act
        FROM public.recipes WHERE client_id = v_c2 AND master_id = v_h_new;
      IF NOT FOUND OR v_price IS DISTINCT FROM 150 OR v_on IS DISTINCT FROM true OR v_act IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'S809 2h probe: the new lassi: price %, On POS %, active %', v_price, v_on, v_act;
      END IF;
      -- A new dish HQ has not priced (or priced at 0) arrives off the till, unpriced.
      SELECT selling_price, pos_enabled INTO v_price, v_on
        FROM public.recipes WHERE client_id = v_c2 AND master_id = v_h_bare;
      IF NOT FOUND OR v_price IS NOT NULL OR v_on IS DISTINCT FROM false
         OR EXISTS (SELECT 1 FROM public.recipes WHERE client_id = v_c2 AND master_id IN (v_free, v_zero) AND pos_enabled IS NOT FALSE)
         OR (SELECT count(*) FROM public.recipes WHERE client_id = v_c2 AND master_id IN (v_free, v_zero)) <> 2 THEN
        RAISE EXCEPTION 'S809 2h probe: a new dish HQ has not priced arrived priced % / On POS %, or the free or NPR 0 dish arrived on the till', v_price, v_on;
      END IF;
      -- The soup of the day keeps the branch's price, and stays On POS.
      SELECT selling_price, pos_enabled INTO v_price, v_on FROM public.recipes WHERE id = v_b_nop;
      IF v_price IS DISTINCT FROM 180 OR v_on IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'S809 2h probe: the branch''s soup of the day after a push: price %, On POS %', v_price, v_on;
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_2h_push_rollback';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 's809_2h_push_rollback' THEN RAISE; END IF;
    END;

    -- (d3) With prices: HQ's price lands where HQ has one, the branch keeps its own where HQ has
    -- none, and On POS and Active stay the branch's either way.
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      PERFORM * FROM public.push_master_data(ARRAY[v_c2], ARRAY['recipes', 'prices'], false);
      RESET ROLE;
      PERFORM set_config('request.jwt.claims', '', true);
      SELECT selling_price, pos_enabled, is_active INTO v_price, v_on, v_act FROM public.recipes WHERE id = v_b_keep;
      IF v_price IS DISTINCT FROM 250 OR v_on IS DISTINCT FROM false OR v_act IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'S809 2h probe: a price push left the momo at price %, On POS %, active %', v_price, v_on, v_act;
      END IF;
      SELECT selling_price, pos_enabled INTO v_price, v_on FROM public.recipes WHERE id = v_b_adopt;
      IF v_price IS DISTINCT FROM 400 OR v_on IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'S809 2h probe: a price push left the thali at price %, On POS %', v_price, v_on;
      END IF;
      SELECT selling_price, pos_enabled INTO v_price, v_on FROM public.recipes WHERE id = v_b_nop;
      IF v_price IS DISTINCT FROM 180 OR v_on IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'S809 2h probe: a price push blanked the soup of the day (price %, On POS %)', v_price, v_on;
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_2h_push_rollback';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 's809_2h_push_rollback' THEN RAISE; END IF;
    END;

    -- (d4) A branch that charges VAT where HQ does not (S792 stage 3, unchanged): a new dish arrives
    -- off the till with no price and the branch's VAT rate; an existing one keeps its price, its
    -- VAT rate and its own switches.
    BEGIN
      UPDATE public.settings SET is_vat_registered = true WHERE client_id = v_c2;
      IF NOT FOUND THEN
        INSERT INTO public.settings (client_id, is_vat_registered) VALUES (v_c2, true);
      END IF;
      IF COALESCE((SELECT is_vat_registered FROM public.settings WHERE client_id = v_c), true) THEN
        UPDATE public.settings SET is_vat_registered = false WHERE client_id = v_c;
        IF NOT FOUND THEN
          INSERT INTO public.settings (client_id, is_vat_registered) VALUES (v_c, false);
        END IF;
      END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      PERFORM * FROM public.push_master_data(ARRAY[v_c2], ARRAY['recipes', 'prices'], false);
      RESET ROLE;
      PERFORM set_config('request.jwt.claims', '', true);
      SELECT selling_price, vat_rate, pos_enabled INTO v_price, v_vat, v_on
        FROM public.recipes WHERE client_id = v_c2 AND master_id = v_h_new;
      IF NOT FOUND OR v_price IS NOT NULL OR v_vat IS DISTINCT FROM 0.13 OR v_on IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'S809 2h probe: at a VAT branch the new lassi arrived at price %, VAT %, On POS %', v_price, v_vat, v_on;
      END IF;
      SELECT selling_price, vat_rate, pos_enabled, is_active INTO v_price, v_vat, v_on, v_act
        FROM public.recipes WHERE id = v_b_keep;
      IF v_price IS DISTINCT FROM 300 OR v_vat IS DISTINCT FROM 0 OR v_on IS DISTINCT FROM false OR v_act IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'S809 2h probe: at a VAT branch the momo became price %, VAT %, On POS %, active %', v_price, v_vat, v_on, v_act;
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_2h_push_rollback';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 's809_2h_push_rollback' THEN RAISE; END IF;
    END;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_2h_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_2h_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT proname, md5(prosrc), prosecdef, proacl FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace AND proname IN ('save_pos_order_items', 'push_master_data');
--     expect save_pos_order_items c4f6e364e0cb5717eb4d1147025428b6, prosecdef false,
--            {postgres=X/postgres,authenticated=X/postgres};
--            push_master_data 18817185fce6a1eaf215afc52876ee53, prosecdef true,
--            {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}.
--   SELECT has_function_privilege('anon', 'public.save_pos_order_items(uuid,jsonb,text,integer)', 'EXECUTE'),
--          has_function_privilege('anon', 'public.push_master_data(uuid[],text[],boolean)', 'EXECUTE');   -- false, false
--   SELECT count(*) FROM public.recipes WHERE name LIKE 'S809 2h probe%';                                -- 0 (the probe rolled back)
--   SELECT count(*) FROM public.pos_orders WHERE table_name = 'S809 2h probe';                           -- 0
--   SELECT count(*) FROM public.clients WHERE customization_enabled;                                     -- unchanged (0 on 2026-10-09)
--   SELECT count(*) FROM public.recipes r WHERE r.is_active IS NOT FALSE AND r.pos_enabled IS NOT FALSE
--      AND r.category IS DISTINCT FROM 'Sub-Recipe' AND NOT COALESCE(r.selling_price > 0, false);       -- 0 (dishes the till now leaves off)
