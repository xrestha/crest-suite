-- S862: the database half of the S861 Crest Customization re-analysis
-- (POS_TODO.md "S861 Customization re-analysis", evidence in docs/customization-review-s861/).
--
-- Owner decisions: CU1 (a) Customization closes 7 days after its own end date; CU2 (a) a combo on
-- a bill keeps the price it was ordered at.
--
--   §1 public.customization_live(uuid)        REPLACED (ADD-1, ADD-3). True while POS and the flag
--        are on and customization_ends_at is unset or at most 7 days past: the SQL twin of
--        customizationState(client).live in src/utils/subscription.js (clientCustomizationLive.test.js
--        holds them together). SECURITY INVOKER now, so a login reads only clients rows its own
--        clients_select admits: another outlet's id reads no row and answers false. Its callers are
--        the INVOKER guards and save_pos_order_items (the caller's own outlet), and the DEFINER
--        guest functions and push_master_data (postgres, BYPASSRLS). Grants unchanged.
--        Rollback: CREATE OR REPLACE from 20260919100000:62-77.
--   §2 public.pos_combo_shares(uuid)          REPLACED (COMBOS-2, COMBOS-3). A pick weighs its
--        cheapest dish's guest price to the paisa; each share is round(price × w ÷ total, 2),
--        multiplied before it divides; the HEAVIEST pick (weight, then sort, then id) takes the
--        remainder, so a pick that weighs 0 is exactly 0. comboShares (comboPricing.js) changes with
--        it. Lines already on bills keep their prices. Rollback: CREATE OR REPLACE from
--        20261014160000 (the live body read 2026-10-23, md5 below).
--   §3 public.pos_price_selection(uuid,uuid,uuid[])  REPLACED (COMBOS-5). The below-zero problem
--        comes back with the priced choices, which submit_guest_order's combo branch keeps.
--        Rollback: CREATE OR REPLACE from 20261012110000 / the live body (md5 below).
--   §4 pos_order_items.combo_share            ADDED column (numeric, NULL) (COMBOS-1, CU2 (a)): the
--        pick's share as the guest pays it, stamped by save_pos_order_items on every new combo
--        dish. A Swap or a Change inside a combo already on the order is priced from it.
--        public.save_pos_order_items(uuid,jsonb,text,integer,uuid), public.pos_order_items_json(uuid),
--        public.guard_pos_item_price(), public.pos_move_lines(uuid,uuid,jsonb),
--        public.apply_pos_item_comps(…)       REPLACED: stamp it, read it, guard it, carry it.
--        Rollback: CREATE OR REPLACE each from its live body (md5s below; 20261015100000,
--        20261014160000, 20261009160000), then DROP COLUMN once no app build reads it.
--   §5 public.pos_post_credit_note_into(uuid,uuid)  REPLACED (REPORTS-STOCK-4): the "not served"
--        put-back is signed, so an item a choice added comes back off.
--        public.ims_stock_movements_guard()   REPLACED, comment only.
--        Rollback: CREATE OR REPLACE from 20261013200000 / the live bodies (md5s below).
--
-- Order: apply BEFORE the S862 app deploy (the till's order select names combo_share). No Edge
-- Function deploy and no till-floor raise: a till still on the old build prices a swap or a rare
-- half-paisa split its old way and is stopped once at Pay ("Prices were updated"), then reloads.
-- No export/restore change: combo_share rides along with select('*'), and the operator's restore
-- passes guard_pos_item_price's admin INSERT branch.

-- ── 0. The bodies this file rebuilds are the ones it read (2026-10-23) ─────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.customization_live(uuid)',                                            'a74417780921e0831002a36d6ece0340'),
      ('public.pos_combo_shares(uuid)',                                              '6bfa6c4cad444b61c70c469305952ee4'),
      ('public.pos_price_selection(uuid,uuid,uuid[])',                               '17c546857d62abca6cd6708bb4aa9fc6'),
      ('public.save_pos_order_items(uuid,jsonb,text,integer,uuid)',                  '7b9f24d438be491ceee0fa9efc4f3ab7'),
      ('public.pos_order_items_json(uuid)',                                          'db8e276767e220ff704457f26f3bfcc0'),
      ('public.guard_pos_item_price()',                                              '8aca44cb722c09ea49ec39ebf351db9a'),
      ('public.pos_move_lines(uuid,uuid,jsonb)',                                     '299ab85419bca0b2454fcc2be09629af'),
      ('public.apply_pos_item_comps(uuid,uuid,text,text,uuid,uuid[],jsonb,jsonb)',  'bb0c712706054f02164eb785d4ea14b5'),
      ('public.pos_post_credit_note_into(uuid,uuid)',                                '98b79990011ca18e20e5cef39ab75e99'),
      ('public.ims_stock_movements_guard()',                                         '320154561a3392f514c3e3ee9fa46744')
    ) AS t(sig, md5)
  LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = r.sig::regprocedure) IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'S862: % changed since this file was written; rebuild it from the live body', r.sig;
    END IF;
  END LOOP;
END;
$$;


-- ── 1. customization_live: the end date and the caller's own rights (ADD-1, ADD-3) ──────────────
-- S758 made it DEFINER "without a clients read of its own", but every login can read its own
-- clients row, and DEFINER let any login ask about any outlet. The date test is Suite's
-- (client_suite_live): whole days to the end, ceil, no date = open, 7 days of grace.
CREATE OR REPLACE FUNCTION public.customization_live(p_client_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $fn$
  SELECT COALESCE((
    SELECT CASE
             WHEN NOT COALESCE(c.customization_enabled AND c.pos_enabled, false) THEN false
             WHEN c.customization_ends_at IS NULL THEN true
             ELSE ceil(extract(epoch FROM (c.customization_ends_at - now())) / 86400.0) >= -7
           END
      FROM public.clients c
     WHERE c.id = p_client_id
  ), false);
$fn$;
COMMENT ON FUNCTION public.customization_live(uuid) IS
  'S862: is Crest Customization live at this outlet: POS and the flag on, and customization_ends_at unset or at most 7 days past. The SQL twin of customizationState(client).live (src/utils/subscription.js). SECURITY INVOKER: a login reads only the clients rows its policy admits, so another outlet answers false.';


-- ── 2. pos_combo_shares: whole paisa, multiply first, the heaviest pick rounds (COMBOS-2, -3) ──
CREATE OR REPLACE FUNCTION public.pos_combo_shares(p_combo_id uuid)
RETURNS TABLE(group_id uuid, group_name text, sort integer, share numeric)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH c AS (
    SELECT cb.id, cb.guest_price,
           COALESCE((SELECT s.is_vat_registered FROM settings s WHERE s.client_id = cb.client_id), true) AS vat_reg
      FROM pos_combos cb
     WHERE cb.id = p_combo_id
  ), g AS (
    -- A pick weighs its cheapest dish's guest price, to the paisa (S862): the till's twin works in
    -- whole paisa, so the two land a half-paisa tie the same way.
    SELECT gr.id, gr.name, gr.sort,
           COALESCE((SELECT min(CASE WHEN COALESCE(r.selling_price, 0) <= 0 THEN 0
                                     WHEN c.vat_reg THEN round(r.selling_price * (1 + COALESCE(r.vat_rate, 0.13)), 2)
                                     ELSE round(r.selling_price, 2) END)
                       FROM pos_combo_items it
                       JOIN recipes r ON r.id = it.recipe_id
                      WHERE it.group_id = gr.id), 0) AS w,
           count(*) OVER () AS cnt
      FROM pos_combo_groups gr
      JOIN c ON gr.combo_id = c.id
  ), h AS (
    -- S862 COMBOS-2: the heaviest pick takes the rounding, never a pick that weighs 0 (the last
    -- pick did, and could come out at minus one paisa).
    SELECT g.*, row_number() OVER (ORDER BY g.w DESC, g.sort, g.id) AS heavy
      FROM g
  ), t AS (
    SELECT COALESCE(sum(w), 0) AS tw FROM g
  ), s AS (
    -- S862 COMBOS-3: multiply before dividing. Dividing first rounded w / tw at 20 places, so an
    -- exact half-paisa share (73.125) came out 73.12 here and 73.13 on the till.
    SELECT h.id, h.name, h.sort, h.heavy,
           round(CASE WHEN t.tw > 0 THEN c.guest_price * h.w / t.tw ELSE c.guest_price / h.cnt END, 2) AS raw
      FROM h CROSS JOIN t CROSS JOIN c
  )
  SELECT s.id, s.name, s.sort,
         CASE WHEN s.heavy = 1
              THEN (SELECT c.guest_price FROM c) - COALESCE((SELECT sum(s2.raw) FROM s s2 WHERE s2.heavy <> 1), 0)
              ELSE s.raw END
    FROM s
   ORDER BY s.sort, s.id;
$function$;


-- ── 3. pos_price_selection: the priced choices with the below-zero problem (COMBOS-5) ─────────
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
        FROM unnest(v_ids) e JOIN pos_options o ON o.id = e::uuid AND o.group_id = g.id AND o.is_active   -- S840
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
  -- available, so the guest's page takes the dish off. S862 COMBOS-5: the priced choices come back
  -- WITH the problem. A combo dish is priced from its share, not its menu price, so
  -- submit_guest_order's combo branch skips this problem and runs its own share test; the bare
  -- problem used to drop the guest's choices from the order and the kitchen ticket. Its plain-dish
  -- branch refuses on any problem before it reads anything else.
  IF COALESCE((SELECT rc.selling_price FROM recipes rc WHERE rc.id = p_recipe_id AND rc.client_id = p_client_id), 0)
     + COALESCE((v_out->>'delta')::numeric, 0) < 0 THEN
    RETURN v_out || jsonb_build_object('problem', 'option_price_below_zero');
  END IF;
  RETURN v_out;
END
$function$;


-- ── 4. combo_share: a combo on a bill keeps the price it was ordered at (COMBOS-1, CU2 (a)) ───
ALTER TABLE public.pos_order_items ADD COLUMN IF NOT EXISTS combo_share numeric;
COMMENT ON COLUMN public.pos_order_items.combo_share IS
  'S862: a combo dish''s pick share, as the guest pays it, when the combo was rung (pos_combo_shares). save_pos_order_items prices a dish swapped or re-chosen inside a combo already on the order from it. NULL on a plain dish and on a combo dish rung before S862.';

CREATE OR REPLACE FUNCTION public.save_pos_order_items(p_order_id uuid, p_rows jsonb, p_removal_reason text DEFAULT NULL::text, p_expected_version integer DEFAULT NULL::integer, p_save_id uuid DEFAULT NULL::uuid)
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
    -- S862 COMBOS-1 (owner CU2 (a)): a new dish in a combo ALREADY on the order (a Swap, or a Change
    -- of its choices) takes the share its pick was rung at, stamped on the dish it replaces
    -- (combo_share), and the combo's name and price as sold, so the combo keeps the price it was
    -- ordered at plus the new dish's own extra. Only a combo rung before S862, with no stamp, takes
    -- today's split. The share is stamped on every new combo dish (the insert below).
    SELECT COALESCE(jsonb_object_agg(q.line_id, jsonb_build_object(
             'base', q.base, 'share', q.share, 'combo_name', q.combo_name, 'combo_price', q.combo_price,
             'group_name', q.group_name, 'sort', q.sort)), '{}'::jsonb)
      INTO v_combo
      FROM (
        SELECT r->>'id' AS line_id,
               COALESCE(st.share, sh.share) AS share,
               round((COALESCE(st.share, sh.share) + COALESCE(it.extra_price, 0))
                     / (1 + CASE WHEN v_vat_reg THEN COALESCE(rec.vat_rate, 0.13) ELSE 0 END), 2) AS base,
               COALESCE(sc.combo_name, cb.name) AS combo_name, COALESCE(sc.combo_price, cb.guest_price) AS combo_price,
               COALESCE(st.group_name, sh.group_name) AS group_name, COALESCE(st.sort, sh.sort) AS sort
          FROM jsonb_array_elements(v_rows) r
          JOIN recipes rec ON rec.id = (r->>'recipe_id')::uuid AND rec.client_id = v_client_id
          JOIN pos_combos cb ON cb.id = (r->>'combo_id')::uuid
          JOIN LATERAL public.pos_combo_shares(cb.id) sh ON sh.group_id = (r->>'combo_group_id')::uuid
          LEFT JOIN pos_combo_items it ON it.group_id = (r->>'combo_group_id')::uuid AND it.recipe_id = rec.id
          -- S862: the combo as sold, and its pick as rung, from the rows this save is about to replace.
          LEFT JOIN LATERAL (
            SELECT i.combo_name, i.combo_price
              FROM pos_order_items i
             WHERE i.order_id = p_order_id AND i.combo_line_id = (r->>'combo_line_id')::uuid
             ORDER BY COALESCE(i.comped, false), i.created_at, i.id
             LIMIT 1) sc ON true
          LEFT JOIN LATERAL (
            SELECT i.combo_share AS share, i.combo_group_name AS group_name, i.combo_sort AS sort
              FROM pos_order_items i
             WHERE i.order_id = p_order_id AND i.combo_line_id = (r->>'combo_line_id')::uuid
               AND i.combo_group_id = (r->>'combo_group_id')::uuid AND i.combo_share IS NOT NULL
             ORDER BY COALESCE(i.comped, false), i.created_at, i.id
             LIMIT 1) st ON true
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
           'combo_sort', s.combo_sort, 'combo_share', s.combo_share,   -- S862
           'options', s.options)), '{}'::jsonb)
    INTO v_prev
    FROM (
      SELECT DISTINCT ON (i.recipe_id, i.selection_key)
             i.recipe_id::text || CASE WHEN i.selection_key <> '' THEN '#' || i.selection_key ELSE '' END AS lk,
             i.unit_price, i.vat_rate, i.name, i.category, i.base_unit_price, i.options_delta, i.option_summary,
             i.combo_name, i.combo_price, i.combo_group_name, i.combo_sort, i.combo_share,
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
      combo_line_id, combo_id, combo_name, combo_price, combo_group_id, combo_group_name, combo_sort,
      combo_share
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
        COALESCE((v_prev -> (r->>'line_key') ->> 'combo_sort')::integer, (v_combo -> (r->>'id') ->> 'sort')::integer) END,
      -- S862 COMBOS-1: the pick's share as rung, kept with its line; a line from before S862 stays NULL.
      CASE WHEN r->>'combo_line_id' IS NOT NULL THEN
        COALESCE((v_prev -> (r->>'line_key') ->> 'combo_share')::numeric, (v_combo -> (r->>'id') ->> 'share')::numeric) END
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
           'combo_share', i.combo_share,   -- S862
           'options', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                         'option_id', x.option_id, 'group_id', x.group_id, 'group_name', x.group_name,
                         'group_kind', x.group_kind, 'option_name', x.option_name, 'kitchen_name', x.kitchen_name,
                         'is_removal', x.is_removal, 'price_delta', x.price_delta, 'included', x.included,
                         'ingredient_deltas', x.ingredient_deltas) ORDER BY x.sort, x.id)
                         FROM pos_order_item_options x WHERE x.order_item_id = i.id), '[]'::jsonb))
           ORDER BY i.created_at, i.id), '[]'::jsonb)
    FROM pos_order_items i WHERE i.order_id = p_order_id;
$function$;

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
     AND NEW.option_summary  IS NOT DISTINCT FROM OLD.option_summary
     -- S839: the combo tag
     AND NEW.combo_line_id    IS NOT DISTINCT FROM OLD.combo_line_id
     AND NEW.combo_id         IS NOT DISTINCT FROM OLD.combo_id
     AND NEW.combo_name       IS NOT DISTINCT FROM OLD.combo_name
     AND NEW.combo_price      IS NOT DISTINCT FROM OLD.combo_price
     AND NEW.combo_group_id   IS NOT DISTINCT FROM OLD.combo_group_id
     AND NEW.combo_group_name IS NOT DISTINCT FROM OLD.combo_group_name
     AND NEW.combo_sort       IS NOT DISTINCT FROM OLD.combo_sort
     -- S862: the share the pick was rung at
     AND NEW.combo_share      IS NOT DISTINCT FROM OLD.combo_share THEN
    IF GREATEST(COALESCE(NEW.sent_qty, 0), CASE WHEN COALESCE(NEW.sent_to_kot, false) THEN NEW.qty ELSE 0 END)
         < GREATEST(COALESCE(OLD.sent_qty, 0), CASE WHEN COALESCE(OLD.sent_to_kot, false) THEN OLD.qty ELSE 0 END)
       AND current_setting('crest.pos_items_rpc', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'pos_item_sent_lowered: a dish already sent to the kitchen or bar cannot be marked as not sent — take it off on the order screen, which records who pulled it and why'
        USING ERRCODE = '42501', HINT = 'pos_item_sent_lowered';
    END IF;
    RETURN NEW;
  END IF;

  IF current_setting('crest.pos_items_rpc', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'pos_order_items: order lines are saved through the order screen, which prices them from the menu — they cannot be written directly'
    USING ERRCODE = '42501', HINT = 'line_not_on_menu';
END;
$function$;

CREATE OR REPLACE FUNCTION public.pos_move_lines(p_from uuid, p_to uuid, p_picks jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client uuid;
  v_out    jsonb := '[]'::jsonb;
  r        pos_order_items;
  v_pick   jsonb;
  v_item   uuid;
  v_q      integer;
  v_sent   integer;
  v_move   integer;
  v_new    uuid;
BEGIN
  SELECT client_id INTO v_client FROM pos_orders WHERE id = p_to;

  IF p_picks IS NULL THEN
    FOR r IN SELECT * FROM pos_order_items WHERE order_id = p_from ORDER BY created_at, id FOR UPDATE LOOP
      v_sent := GREATEST(r.sent_qty, CASE WHEN COALESCE(r.sent_to_kot, false) THEN r.qty ELSE 0 END);
      UPDATE pos_order_items SET order_id = p_to WHERE id = r.id;
      UPDATE pos_order_item_options SET order_id = p_to WHERE order_item_id = r.id;
      PERFORM public.pos_merge_line(r.id);
      v_out := v_out || jsonb_build_object('recipe_id', r.recipe_id, 'selection_key', r.selection_key, 'name', r.name,
                                           'qty', r.qty, 'sent_qty', v_sent, 'unit_price', r.unit_price);
    END LOOP;
    RETURN v_out;
  END IF;

  IF jsonb_typeof(p_picks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_picks) = 0 THEN
    RAISE EXCEPTION 'pos_move_nothing: pick at least one dish to move'
      USING ERRCODE = 'P0001', HINT = 'pos_move_nothing';
  END IF;
  IF (SELECT count(DISTINCT x->>'item_id') FROM jsonb_array_elements(p_picks) x) <> jsonb_array_length(p_picks) THEN
    RAISE EXCEPTION 'pos_move_nothing: each dish is picked once, with how many of it to move'
      USING ERRCODE = 'P0001', HINT = 'pos_move_nothing';
  END IF;

  FOR v_pick IN SELECT * FROM jsonb_array_elements(p_picks) LOOP
    v_item := CASE WHEN COALESCE(v_pick->>'item_id', '') ~ '^[0-9a-fA-F-]{36}$' THEN (v_pick->>'item_id')::uuid END;
    v_q    := CASE WHEN jsonb_typeof(v_pick->'qty') = 'number' AND (v_pick->>'qty') ~ '^[0-9]{1,6}$'
                   THEN (v_pick->>'qty')::integer END;
    SELECT * INTO r FROM pos_order_items WHERE id = v_item AND order_id = p_from FOR UPDATE;
    IF r.id IS NULL THEN
      RAISE EXCEPTION 'pos_move_line_missing: a dish you picked is no longer on this bill — it changed on another device; reload it and try again'
        USING ERRCODE = 'P0001', HINT = 'pos_move_line_missing';
    END IF;
    IF r.comped THEN
      RAISE EXCEPTION 'pos_move_line_comped: % is complimentary on this bill, so it stays here', r.name
        USING ERRCODE = 'P0001', HINT = 'pos_move_line_comped';
    END IF;
    IF v_q IS NULL OR v_q < 1 OR v_q > r.qty THEN
      RAISE EXCEPTION 'pos_move_qty_invalid: % can be moved 1 to % at a time', r.name, r.qty
        USING ERRCODE = 'P0001', HINT = 'pos_move_qty_invalid';
    END IF;
    v_sent := GREATEST(r.sent_qty, CASE WHEN COALESCE(r.sent_to_kot, false) THEN r.qty ELSE 0 END);
    v_move := LEAST(v_q, v_sent);
    IF v_q = r.qty THEN
      UPDATE pos_order_items SET order_id = p_to WHERE id = r.id;
      UPDATE pos_order_item_options SET order_id = p_to WHERE order_item_id = r.id;
      v_new := r.id;
    ELSE
      UPDATE pos_order_items SET qty = r.qty - v_q, sent_qty = v_sent - v_move WHERE id = r.id;
      INSERT INTO pos_order_items (order_id, client_id, recipe_id, name, qty, unit_price, vat_rate, notes, sent_to_kot,
                                   category, sent_qty, selection_key, base_unit_price, options_delta, option_summary,
                                   combo_line_id, combo_id, combo_name, combo_price, combo_group_id, combo_group_name, combo_sort,
                                   combo_share)   -- S862
      VALUES (p_to, v_client, r.recipe_id, r.name, v_q, r.unit_price, r.vat_rate, r.notes, v_move >= v_q,
              r.category, v_move, r.selection_key, r.base_unit_price, r.options_delta, r.option_summary,
              r.combo_line_id, r.combo_id, r.combo_name, r.combo_price, r.combo_group_id, r.combo_group_name, r.combo_sort,
              r.combo_share)
      RETURNING id INTO v_new;
      INSERT INTO pos_order_item_options (client_id, order_id, order_item_id, recipe_id, group_id, option_id, group_name,
                                          group_kind, option_name, kitchen_name, is_removal, price_delta,
                                          list_price_delta, included, ingredient_deltas, sort)
      SELECT x.client_id, p_to, v_new, x.recipe_id, x.group_id, x.option_id, x.group_name,
             x.group_kind, x.option_name, x.kitchen_name, x.is_removal, x.price_delta,
             x.list_price_delta, x.included, x.ingredient_deltas, x.sort
        FROM pos_order_item_options x
       WHERE x.order_item_id = r.id;
    END IF;
    PERFORM public.pos_merge_line(v_new);
    v_out := v_out || jsonb_build_object('recipe_id', r.recipe_id, 'selection_key', r.selection_key, 'name', r.name,
                                         'qty', v_q, 'sent_qty', v_move, 'unit_price', r.unit_price);
  END LOOP;

  -- S839 (docs/pos-combos.md): a combo moves whole. On both bills, each combo has every one of its
  -- picks, all at one quantity.
  IF EXISTS (
    SELECT 1
      FROM (SELECT i.order_id, i.combo_line_id, i.combo_group_id, sum(i.qty) AS q
              FROM pos_order_items i
             WHERE i.order_id IN (p_from, p_to) AND i.combo_line_id IS NOT NULL AND NOT COALESCE(i.comped, false)
             GROUP BY 1, 2, 3) x
     GROUP BY x.order_id, x.combo_line_id
    HAVING count(DISTINCT x.q) > 1
        OR count(*) <> (SELECT count(DISTINCT i2.combo_group_id) FROM pos_order_items i2
                         WHERE i2.combo_line_id = x.combo_line_id AND i2.order_id IN (p_from, p_to))
  ) THEN
    RAISE EXCEPTION 'combo_move_whole: a combo moves as a whole — every dish of it by the same number — so nothing was moved'
      USING ERRCODE = 'P0001', HINT = 'combo_move_whole';
  END IF;
  RETURN v_out;
END;
$function$;

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
  v_comped_by uuid;
  v_src record;
  v_new_id uuid;
  v_sel text;
  v_qty integer;
  v_sent integer;
  -- S809 2b
  v_fy text;
  v_missing uuid;
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

  -- S809 1j (ACCESS-9): the one POS rank test (admin, the Owner, or a POS supervisor or manager),
  -- which also refuses a login a Final Settlement has blocked, for the hour its last access token
  -- still lives. This was a copy of it without that test.
  IF NOT COALESCE(public.pos_caller_has_rank('supervisor'), false) THEN
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

  -- ── S809 2b (CHECKOUT-4): the NC number's year is Nepal's date, from the server ─────────────
  -- As on the bill itself (guard_pos_order_close), so the item comps and a Complimentary bill share
  -- one series per year whatever the tablet's clock says. p_fy is ignored: it stays in the
  -- signature so a till on an older build still binds to this function.
  v_fy := public.pos_invoice_fy(v_now);
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'pos_fiscal_year_unknown: today''s date is past the end of Crest''s Nepali calendar, so no NC number can be given and nothing was made complimentary — contact Crest support'
      USING ERRCODE = 'P0001', HINT = 'pos_fiscal_year_unknown';
  END IF;
  -- ── end S809 2b ──────────────────────────────────────────────────────────────────────────

  PERFORM pg_advisory_xact_lock(hashtext('pos_comp_slip_no:' || p_client_id::text || ':' || v_fy));

  SELECT COALESCE(MAX(n), 0) + 1 INTO v_comp_no FROM (
    SELECT invoice_no AS n FROM pos_orders WHERE client_id = p_client_id AND invoice_fy = v_fy AND close_type = 'writeoff'
    UNION ALL
    SELECT comp_no AS n FROM pos_order_items WHERE client_id = p_client_id AND comp_fy = v_fy
  ) combined;

  -- The pre-S758 argument: whole recipes, which on a till that knows no options means its plain
  -- lines. It no longer reaches a customized line — that is comped by line through p_full_lines.
  IF p_full_recipe_ids IS NOT NULL AND array_length(p_full_recipe_ids, 1) > 0 THEN
    UPDATE pos_order_items
    SET comped = true, comp_reason = p_comp_reason, comped_by = v_comped_by,
        comped_at = v_now, comp_fy = v_fy, comp_no = v_comp_no
    WHERE order_id = p_order_id AND recipe_id = ANY(p_full_recipe_ids) AND selection_key = ''
      -- S809 2b (CHECKOUT-10): a line already comped keeps its comp, as on p_full_lines below. It
      -- was re-comped here under the new NC number, so a comp left by a failed close moved slips.
      AND COALESCE(comped, false) = false;
    -- S809 2b (S809.4): each recipe asked for was comped by this call, or nothing is: the till has
    -- already taken it off the total on screen, so a recipe with nothing left to comp must stop the
    -- close rather than let it charge short under an NC number for a comp that did not happen. The
    -- NC number is this call's own (MAX + 1 under the lock above), so it marks exactly its rows.
    SELECT r.id INTO v_missing
      FROM unnest(p_full_recipe_ids) AS r(id)
     WHERE NOT EXISTS (SELECT 1 FROM pos_order_items i
                        WHERE i.order_id = p_order_id AND i.recipe_id = r.id AND i.selection_key = ''
                          AND i.comp_no = v_comp_no AND i.comp_fy = v_fy)
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'pos_comp_line_missing: a dish to be made complimentary is not on this bill (or is already complimentary), so nothing was made complimentary — the bill may have changed on another device'
        USING ERRCODE = 'P0001', HINT = 'pos_comp_line_missing',
              DETAIL = format('recipe %s', COALESCE(v_missing::text, 'none'));
    END IF;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_full_lines, '[]'::jsonb))
  LOOP
    UPDATE pos_order_items
    SET comped = true, comp_reason = p_comp_reason, comped_by = v_comped_by,
        comped_at = v_now, comp_fy = v_fy, comp_no = v_comp_no
    WHERE order_id = p_order_id
      AND recipe_id = (v_item->>'recipe_id')::uuid
      AND selection_key = COALESCE(v_item->>'selection_key', '')
      AND COALESCE(comped, false) = false;
    -- S809 2b (S809.4): as above, a line asked for that comps nothing stops the whole call.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pos_comp_line_missing: a dish to be made complimentary is not on this bill (or is already complimentary), so nothing was made complimentary — the bill may have changed on another device'
        USING ERRCODE = 'P0001', HINT = 'pos_comp_line_missing',
              DETAIL = format('recipe %s, choices %s', COALESCE(v_item->>'recipe_id', 'none'), COALESCE(NULLIF(v_item->>'selection_key', ''), 'none'));
    END IF;
  END LOOP;

  -- The comped split takes its price from the stored line it is split off, never from the
  -- payload (S754: a line's price is the menu's). vat_rate likewise, and since S758 its options.
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_partial, '[]'::jsonb))
  LOOP
    v_sel := COALESCE(v_item->>'selection_key', '');

    -- S809 1j (CHECKOUT-16): a whole number, as text or a JSON number. Checked before the cast, so
    -- "1.5", "-3" or a missing quantity is a worded refusal rather than a cast error.
    IF COALESCE(v_item->>'comp_qty', '') !~ '^[0-9]{1,9}$' THEN
      RAISE EXCEPTION 'pos_comp_qty_invalid: a complimentary quantity must be a whole number of 1 or more, not %',
        COALESCE(v_item->>'comp_qty', 'none')
        USING ERRCODE = '22023', HINT = 'pos_comp_qty_invalid';
    END IF;
    v_qty := (v_item->>'comp_qty')::integer;

    SELECT id, recipe_id, name, category, qty, unit_price, vat_rate, sent_to_kot, sent_qty,
           selection_key, base_unit_price, options_delta, option_summary,
           combo_line_id, combo_id, combo_name, combo_price, combo_group_id, combo_group_name, combo_sort,  -- S839
           combo_share  -- S862
      INTO v_src
      FROM pos_order_items
     WHERE order_id = p_order_id AND recipe_id = (v_item->>'recipe_id')::uuid
       AND selection_key = v_sel
       AND COALESCE(comped, false) = false
     ORDER BY created_at
     LIMIT 1;
    -- S809 2b (S809.4): this was CONTINUE, so a part comp whose line was gone was skipped while the
    -- NC number was still returned, and the till printed an empty Complimentary Slip under it and
    -- charged the bill short by the comp it had shown. Now nothing in the call is comped.
    IF v_src.id IS NULL THEN
      RAISE EXCEPTION 'pos_comp_line_missing: % is not on this bill to be made complimentary, so nothing was made complimentary — the bill may have changed on another device',
        COALESCE(NULLIF(v_item->>'name', ''), 'a dish')
        USING ERRCODE = 'P0001', HINT = 'pos_comp_line_missing',
              DETAIL = format('recipe %s, choices %s', COALESCE(v_item->>'recipe_id', 'none'), COALESCE(NULLIF(v_sel, ''), 'none'));
    END IF;

    -- S809 1j (CHECKOUT-16): part of a line is 1 up to one less than its quantity. The whole line
    -- goes through p_full_recipe_ids / p_full_lines, which is what the till sends for it; this
    -- branch used to take any number, leaving a charged line of 0 or −3 and a comp of −3.
    IF v_qty < 1 OR v_qty >= v_src.qty THEN
      RAISE EXCEPTION 'pos_comp_qty_invalid: % can be made complimentary from 1 up to % here (the bill has %), not % — a whole line is comped in full',
        v_src.name, v_src.qty - 1, v_src.qty, v_qty
        USING ERRCODE = '22023', HINT = 'pos_comp_qty_invalid';
    END IF;

    -- S809 1j: the kitchen's count of this line, as save_pos_order_items and the pulled-item
    -- triggers define it, is split between the two rows: the comp takes sent units first, and the
    -- charged row keeps the rest. It used to keep its whole sent_qty above its new quantity
    -- (3 sent, comp 1 → qty 2, sent_qty 3), so a later save of that line recorded a pull of 1
    -- that nobody made.
    v_sent := GREATEST(COALESCE(v_src.sent_qty, 0),
                       CASE WHEN COALESCE(v_src.sent_to_kot, false) THEN v_src.qty ELSE 0 END);

    UPDATE pos_order_items
    SET qty = qty - v_qty,
        sent_qty = v_sent - LEAST(v_sent, v_qty)
    WHERE id = v_src.id;

    INSERT INTO pos_order_items (
      order_id, client_id, recipe_id, name, category, qty, unit_price, vat_rate, sent_to_kot, sent_qty,
      comped, comp_reason, comped_by, comped_at, comp_fy, comp_no,
      selection_key, base_unit_price, options_delta, option_summary,
      combo_line_id, combo_id, combo_name, combo_price, combo_group_id, combo_group_name, combo_sort,
      combo_share
    ) VALUES (
      p_order_id, p_client_id, v_src.recipe_id, v_src.name, v_src.category,
      v_qty, v_src.unit_price, v_src.vat_rate, v_src.sent_to_kot,
      LEAST(v_sent, v_qty),
      true, p_comp_reason, v_comped_by, v_now, v_fy, v_comp_no,
      v_src.selection_key, v_src.base_unit_price, v_src.options_delta, v_src.option_summary,
      v_src.combo_line_id, v_src.combo_id, v_src.combo_name, v_src.combo_price, v_src.combo_group_id,
      v_src.combo_group_name, v_src.combo_sort, v_src.combo_share
    ) RETURNING id INTO v_new_id;

    INSERT INTO pos_order_item_options (
      client_id, order_id, order_item_id, recipe_id, group_id, option_id, group_name, group_kind,
      option_name, kitchen_name, is_removal, price_delta, list_price_delta, included, ingredient_deltas, sort
    )
    SELECT client_id, order_id, v_new_id, recipe_id, group_id, option_id, group_name, group_kind,
           option_name, kitchen_name, is_removal, price_delta, list_price_delta, included, ingredient_deltas, sort
      FROM pos_order_item_options WHERE order_item_id = v_src.id;
  END LOOP;

  -- S839 (docs/pos-combos.md): a combo is comped whole. On each combo of the bill, every pick has the
  -- same comped quantity and the same uncomped quantity, and every pick is on each side it appears.
  IF EXISTS (
    SELECT 1
      FROM (SELECT i.combo_line_id, COALESCE(i.comped, false) AS c, i.combo_group_id, sum(i.qty) AS q
              FROM pos_order_items i
             WHERE i.order_id = p_order_id AND i.combo_line_id IS NOT NULL
             GROUP BY 1, 2, 3) x
     GROUP BY x.combo_line_id, x.c
    HAVING count(DISTINCT x.q) > 1
        OR count(*) <> (SELECT count(DISTINCT i2.combo_group_id) FROM pos_order_items i2
                         WHERE i2.order_id = p_order_id AND i2.combo_line_id = x.combo_line_id)
  ) THEN
    RAISE EXCEPTION 'combo_comp_whole: a combo is made complimentary as a whole — every dish of it by the same number — so nothing was made complimentary'
      USING ERRCODE = 'P0001', HINT = 'combo_comp_whole';
  END IF;

  RETURN v_comp_no;
END;
$function$;


-- ── 5. pos_post_credit_note_into: the put-back is signed (REPORTS-STOCK-4) ─────────────────────
CREATE OR REPLACE FUNCTION public.pos_post_credit_note_into(p_note_id uuid, p_period_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_note   record;
  v_period record;
  v_closed timestamptz;
  v_ims    boolean;
  v_since  timestamptz;
  v_day    date;
  v_bs_day integer;
BEGIN
  -- Locked first, as sales_entries_stamp_pos_source locks it: a second post of this note waits here
  -- for the first to commit, then sees its mark.
  SELECT n.id, n.client_id, n.order_id, n.restock, n.created_at, n.ims_posted_at INTO v_note
    FROM pos_credit_notes n
   WHERE n.id = p_note_id
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  SELECT p.id, p.client_id, p.bs_year, p.bs_month INTO v_period
    FROM monthly_periods p
   WHERE p.id = p_period_id;
  IF v_period.id IS NULL OR v_period.client_id IS DISTINCT FROM v_note.client_id THEN
    RETURN 'other_outlet';
  END IF;

  IF v_note.ims_posted_at IS NOT NULL THEN
    RETURN 'already';
  END IF;
  -- The backfill's pre-stamp (S747): a reversal already there is never posted again.
  IF EXISTS (SELECT 1 FROM sales_entries s
              WHERE s.pos_credit_note_id = p_note_id AND s.source IN ('pos_credit', 'pos_credit_restock')) THEN
    UPDATE pos_credit_notes SET ims_posted_at = now() WHERE id = p_note_id AND ims_posted_at IS NULL;
    RETURN 'already';
  END IF;

  -- ims_sales_entries_guard's pos_outlet_no_ims: NULL counts as on, as the app's `?? true` reads it.
  SELECT c.ims_enabled, c.ims_since INTO v_ims, v_since FROM clients c WHERE c.id = v_note.client_id;
  IF v_ims IS FALSE THEN
    RETURN 'no_ims';
  END IF;
  -- Q31 (a), S831: a bill closed before the outlet's Inventory began never went in, so its note has
  -- nothing to take back (billCountsForIms).
  SELECT o.closed_at INTO v_closed FROM pos_orders o WHERE o.id = v_note.order_id;
  IF v_closed < v_since THEN
    RETURN 'before_inventory';
  END IF;

  -- nepalDayInPeriod: the day the note was issued in Nepal, which must fall in this month.
  v_day := (v_note.created_at AT TIME ZONE 'Asia/Kathmandu')::date;
  SELECT (v_day - m.ad_start + 1) INTO v_bs_day
    FROM bs_months m
   WHERE m.bs_year = v_period.bs_year AND m.bs_month = v_period.bs_month
     AND v_day >= m.ad_start AND v_day < m.ad_start + m.days;
  IF v_bs_day IS NULL THEN
    RETURN 'other_month';
  END IF;

  -- creditNoteReversalRows: only what the bill's close POSTED as a sale ('pos'): a comped line (and a
  -- Complimentary bill, which a note cannot credit) went in as 'pos_comp' at no revenue.
  IF NOT EXISTS (SELECT 1 FROM public.pos_bill_sales_rows(ARRAY[v_note.order_id]) r WHERE r.source = 'pos') THEN
    UPDATE pos_credit_notes SET ims_posted_at = now() WHERE id = p_note_id AND ims_posted_at IS NULL;
    RETURN 'nothing_to_post';
  END IF;

  -- S809 2e: a "not served" note waits for its bill's own sale (the link, never the bill's mark).
  IF v_note.restock
     AND NOT EXISTS (SELECT 1 FROM sales_entries s WHERE s.pos_order_id = v_note.order_id AND s.source = 'pos') THEN
    RETURN 'bill_waiting';
  END IF;

  -- The reversal in ONE statement: sales_entries_stamp_pos_source marks the note with it and refuses
  -- a second statement for it. It names its note and no bill (sales_entry_link_mismatch).
  INSERT INTO sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate,
                             pos_credit_note_id, ingredient_deltas)
  SELECT v_period.id, r.recipe_id, v_bs_day, -r.qty_sold,
         CASE WHEN v_note.restock THEN 'pos_credit_restock' ELSE 'pos_credit' END,
         r.unit_price, r.vat_rate, p_note_id, r.ingredient_deltas
    FROM public.pos_bill_sales_rows(ARRAY[v_note.order_id]) r
   WHERE r.source = 'pos'
   ORDER BY r.line_id;

  -- creditNoteRestockMovements: the bill's own 'pos_sale' stock lines, negated item by item, on the
  -- note's day. Nothing for an item the bill took no stock of (a dish with no ingredients). S862
  -- REPORTS-STOCK-4: signed, like the bill's post. An item a choice ADDED to the bill (Oat Milk's
  -- milk on an Americano that holds less) comes back off, as theoretical usage reverses it; only
  -- the put-back of what the bill took off used to be written.
  IF v_note.restock THEN
    INSERT INTO stock_movements (client_id, item_id, period_id, bs_day, qty, source, ref_id)
    SELECT v_note.client_id, m.item_id, v_period.id, v_bs_day, -sum(m.qty), 'pos_credit_restock', v_note.order_id
      FROM stock_movements m
     WHERE m.ref_id = v_note.order_id AND m.source = 'pos_sale' AND m.item_id IS NOT NULL
     GROUP BY m.item_id
    HAVING abs(sum(m.qty)) > 1e-9
     ORDER BY m.item_id;
  END IF;

  RETURN 'posted';
END;
$function$;

CREATE OR REPLACE FUNCTION public.ims_stock_movements_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source text;
BEGIN
  -- ── S809 2e: the Owner is no longer waved through here; the operator still is ───────────────
  -- (S830 5f-2: except for a till stock line, below.)
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- ── S830 5f-2: a till's stock lines are the server's to write ──────────────────────────────────
  -- The close and Post to Inventory write them as the owner (SECURITY DEFINER), which the line above
  -- lets through, so a 'pos_sale' or 'pos_comp' line from a login is refused, the Owner's and the
  -- operator's included, and so is turning another line into one. The operator keeps its restore (a
  -- line dated before this transaction) and its corrections.
  IF NOT (COALESCE(public.is_admin(), false) AND (TG_OP <> 'INSERT' OR COALESCE(NEW.created_at < now(), true))) THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.source IN ('pos_sale', 'pos_comp') THEN
        RAISE EXCEPTION 'pos_sale_server_only: a till''s stock lines reach Inventory only through the server''s own post (as the bill closes, or Post to Inventory), so this % line was not recorded', NEW.source
          USING ERRCODE = '42501', HINT = 'pos_sale_server_only';
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.source IN ('pos_sale', 'pos_comp') AND OLD.source NOT IN ('pos_sale', 'pos_comp') THEN
        RAISE EXCEPTION 'pos_sale_server_only: a till''s stock lines reach Inventory only through the server''s own post, so this line was not turned into one'
          USING ERRCODE = '42501', HINT = 'pos_sale_server_only';
      END IF;
    END IF;
  END IF;
  -- ── end S830 5f-2 ──────────────────────────────────────────────────────────────────────────────

  -- ── S832 5f-4 step 2: the stock a credit note puts back is the server's to write ───────────────
  -- A "not served" note's stock lines go in with its reversal, in the server's post (5f-4). A
  -- 'pos_credit_restock' line from a login is refused, the Owner's and the operator's included, and
  -- so is turning another line into one. The operator keeps its restore (a line dated before this
  -- transaction) and its corrections, as for a till stock line above.
  IF NOT (COALESCE(public.is_admin(), false) AND (TG_OP <> 'INSERT' OR COALESCE(NEW.created_at < now(), true))) THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.source = 'pos_credit_restock' THEN
        RAISE EXCEPTION 'pos_credit_server_only: the stock a credit note puts back reaches Inventory only through the server''s own post (as the note is issued, or Post to Inventory), so this line was not recorded'
          USING ERRCODE = '42501', HINT = 'pos_credit_server_only';
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.source = 'pos_credit_restock' AND OLD.source IS DISTINCT FROM 'pos_credit_restock' THEN
        RAISE EXCEPTION 'pos_credit_server_only: the stock a credit note puts back reaches Inventory only through the server''s own post, so this line was not turned into one'
          USING ERRCODE = '42501', HINT = 'pos_credit_server_only';
      END IF;
    END IF;
  END IF;
  -- ── end S832 5f-4 step 2 ───────────────────────────────────────────────────────────────────────

  IF COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- A Credit Note that said its bill's food was not served puts that food back (CREDIT-NOTES-1,
  -- Q10 a): the bill's own 'pos_sale' movements negated, signed (S862 REPORTS-STOCK-4: an item a
  -- choice added comes back off), ref_id the credited bill. Only the server posts them
  -- (pos_post_credit_note_into runs inside a DEFINER caller, which returned above). A row from a
  -- login, which pos_credit_server_only refuses anyway, must add stock and name a bill of this
  -- outlet whose note said so; the Owner meets this too, only the operator's restore is exempt. One
  -- per bill and item (stock_movements_one_restock_per_bill_item).
  IF TG_OP = 'INSERT' AND NEW.source = 'pos_credit_restock'
     AND (NOT COALESCE(NEW.qty > 0, false)
          OR NOT EXISTS (SELECT 1 FROM pos_credit_notes n
                          WHERE n.order_id = NEW.ref_id AND n.client_id = NEW.client_id AND n.restock)) THEN
    RAISE EXCEPTION 'pos_credit_restock_invalid: stock goes back into Inventory only through a Credit Note that said its bill''s food was not served, and only as stock added'
      USING ERRCODE = '42501', HINT = 'pos_credit_restock_invalid';
  END IF;

  IF COALESCE(public.is_client_owner(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- ── end S809 2e ──────────────────────────────────────────────────────────────────────────

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'stock_movements: a stock movement is a ledger record and is not edited — delete and re-post the day instead'
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;

  v_source := CASE WHEN TG_OP = 'INSERT' THEN NEW.source ELSE OLD.source END;
  IF v_source = 'manual' THEN
    IF public.ims_caller_has_rank('staff') THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
  ELSIF v_source IN ('pos_sale', 'pos_comp') AND TG_OP = 'INSERT' THEN
    IF COALESCE(public.pos_caller_has_rank('supervisor'), false) OR public.ims_caller_has_rank('supervisor') THEN
      RETURN NEW;
    END IF;
  -- S809 2e: posted with the note's revenue reversal, by the same people (ims_sales_entries_guard).
  ELSIF v_source = 'pos_credit_restock' AND TG_OP = 'INSERT' THEN
    IF COALESCE(public.pos_caller_has_rank('manager'), false) OR public.ims_caller_has_rank('supervisor') THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'stock_movements: this stock movement (%) cannot be % from this login', COALESCE(v_source, 'no source'),
    CASE TG_OP WHEN 'INSERT' THEN 'recorded' ELSE 'removed' END
    USING ERRCODE = '42501', HINT = 'ims_rank';
END;
$function$;


-- ── 6. Read back what this file changed ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'pos_order_items' AND column_name = 'combo_share') THEN
    RAISE EXCEPTION 'S862: pos_order_items.combo_share is missing';
  END IF;
  IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.customization_live(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'S862: customization_live is still SECURITY DEFINER';
  END IF;
  FOREACH v IN ARRAY ARRAY['public.save_pos_order_items(uuid,jsonb,text,integer,uuid)', 'public.pos_order_items_json(uuid)',
                           'public.guard_pos_item_price()', 'public.pos_move_lines(uuid,uuid,jsonb)',
                           'public.apply_pos_item_comps(uuid,uuid,text,text,uuid,uuid[],jsonb,jsonb)'] LOOP
    IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = v::regprocedure) NOT LIKE '%combo_share%' THEN
      RAISE EXCEPTION 'S862: % does not carry combo_share', v;
    END IF;
  END LOOP;
  IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.pos_post_credit_note_into(uuid,uuid)'::regprocedure)
       NOT LIKE '%HAVING abs(sum(m.qty)) > 1e-9%' THEN
    RAISE EXCEPTION 'S862: the credit-note put-back is not signed';
  END IF;
  IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.pos_price_selection(uuid,uuid,uuid[])'::regprocedure)
       NOT LIKE '%RETURN v_out || jsonb_build_object(''problem'', ''option_price_below_zero'')%' THEN
    RAISE EXCEPTION 'S862: pos_price_selection still drops the priced choices';
  END IF;
  IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.pos_combo_shares(uuid)'::regprocedure) NOT LIKE '%g.w DESC, g.sort, g.id%' THEN
    RAISE EXCEPTION 'S862: pos_combo_shares does not give the remainder to the heaviest pick';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
