-- S839: Combos (Crest Customization release 2). The contract is docs/pos-combos.md; read it first.
--
-- A combo is sold at one price ("Momo Combo, NPR 350") and made of picks ("Pick a momo", "Pick a
-- drink"), each exactly one dish from a short list, with an optional extra charge per dish. Each
-- picked dish is an ORDINARY order line of its own recipe, carrying a share of the combo's price and
-- a combo tag, so it prints on its own station, takes its own stock, counts as that dish sold and
-- carries its own VAT rate. Owner decisions (2026-10-14): both kinds (a set meal is a combo whose
-- picks each list one dish); part of the paid Customization add-on; the bill prints one combo line;
-- guests order combos from the QR menu; a dish inside a combo may take its own choices; a guest
-- dropping a dish swaps it or removes the whole combo; a bill discount never touches a combo.
--
-- What this file changes:
--   1. pos_combos / pos_combo_groups / pos_combo_items: same-client RLS with the option tables'
--      restrictive pair, written through save_pos_combo / delete_pos_combo, fenced by
--      guard_pos_combo_edit (Owner, POS or IMS manager, operator; Customization live).
--   2. pos_combo_shares(): each pick's share of the combo price (its cheapest dish's guest price as
--      the weight, the last pick takes the rounding). JS twin: src/modules/customization/comboPricing.js.
--   3. pos_order_items gains the combo tag; a combo dish's selection_key ends '@<combo_line_id>/<group>'
--      so the line key keeps it apart everywhere a line is matched by key. guard_pos_item_price fences
--      the new columns.
--   4. save_pos_order_items: prices and validates combo dishes (combo_incomplete,
--      combo_dish_not_offered, combo_unavailable), returns the tag.
--   5. The discount: pos_bill_sales_rows and guard_pos_order_close leave combo dishes out
--      (discount_on_combo). apply_pos_item_comps and pos_move_lines keep a combo whole
--      (combo_comp_whole, combo_move_whole) and copy the tag.
--   6. get_guest_menu_options lists combos; submit_guest_order takes them.
--
-- Every rebuilt body is checked against the live body it was written from (md5) and either replaced
-- whole (the shorter ones) or patched at named anchors (guard_pos_order_close, apply_pos_item_comps).
-- The probe at the end runs the whole path as a POS manager at BLOOM CAFE and is rolled back.
-- After the app release is deployed, a second file raises the till floor (pos_min_till_build): an
-- older till would read a combo dish's '@' key as an option id.
--
-- Reversal: drop the three setup tables and two RPCs, the pos_order_items combo columns and their
-- CHECK, pos_combo_shares, and restore the eight bodies from pg_get_functiondef before this file.


-- ── 0. The bodies this file rebuilds are the ones it read ──────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.save_pos_order_items(uuid,jsonb,text,integer)',                       '1d391512d03cd0abe6f690efbae90806'),
      ('public.guard_pos_order_close()',                                             'ad92a74549be6bf5a06d7d93172935b2'),
      ('public.pos_bill_sales_rows(uuid[])',                                         '2cc546f394e068c87c157980c08df56d'),
      ('public.apply_pos_item_comps(uuid,uuid,text,text,uuid,uuid[],jsonb,jsonb)',  '55553b4fe5365f40de48f9d6e7025d6d'),
      ('public.pos_move_lines(uuid,uuid,jsonb)',                                     'f749b023c3aec48d30e7dc48bf9bf180'),
      ('public.guard_pos_item_price()',                                              '283c9d6288fb0a31c549ca9c1fce7ae7'),
      ('public.get_guest_menu_options(uuid)',                                        'd01ac5fc3dfd9bc271e954654e2fa74f'),
      ('public.submit_guest_order(uuid,jsonb,text,integer,uuid)',                    '05b2d225a29979180405ce7660813a3b')
    ) AS t(sig, md5)
  LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = r.sig::regprocedure) IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'S839: % changed since this file was written; rebuild it from the live body', r.sig;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.s839_patch(p_def text, p_old text, p_new text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_n integer := (length(p_def) - length(replace(p_def, p_old, ''))) / NULLIF(length(p_old), 0);
BEGIN
  IF v_n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'S839: a patch anchor was found % times: %', COALESCE(v_n, 0), left(p_old, 120);
  END IF;
  RETURN replace(p_def, p_old, p_new);
END;
$$;


-- ── 1. The setup tables ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pos_combos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (btrim(name) <> ''),
  -- What the guest pays for the combo: VAT-inclusive on a VAT-registered outlet (menu prices in Nepal
  -- include VAT), the price itself on a PAN outlet. Every line price is ex-VAT and derived per dish.
  guest_price   numeric(12,2) NOT NULL CHECK (guest_price > 0),
  description   text,
  is_active     boolean NOT NULL DEFAULT true,
  on_guest_menu boolean NOT NULL DEFAULT true,
  sort          integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_combos_id_client_key UNIQUE (id, client_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS pos_combos_client_name_key ON public.pos_combos (client_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS public.pos_combo_groups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid NOT NULL,
  combo_id   uuid NOT NULL,
  name       text NOT NULL CHECK (btrim(name) <> ''),
  sort       integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_combo_groups_combo_fkey FOREIGN KEY (combo_id, client_id)
    REFERENCES public.pos_combos (id, client_id) ON DELETE CASCADE,
  CONSTRAINT pos_combo_groups_id_client_key UNIQUE (id, client_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS pos_combo_groups_combo_name_key ON public.pos_combo_groups (combo_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS pos_combo_groups_client_id_idx ON public.pos_combo_groups (client_id);

CREATE TABLE IF NOT EXISTS public.pos_combo_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL,
  group_id    uuid NOT NULL,
  -- CASCADE: deleting a dish takes it out of its picks (a dish with sales cannot be deleted anyway).
  recipe_id   uuid NOT NULL REFERENCES public.recipes(id) ON DELETE CASCADE,
  extra_price numeric(12,2) NOT NULL DEFAULT 0 CHECK (extra_price >= 0),
  is_default  boolean NOT NULL DEFAULT false,
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_combo_items_group_fkey FOREIGN KEY (group_id, client_id)
    REFERENCES public.pos_combo_groups (id, client_id) ON DELETE CASCADE,
  CONSTRAINT pos_combo_items_group_recipe_key UNIQUE (group_id, recipe_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS pos_combo_items_one_default ON public.pos_combo_items (group_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS pos_combo_items_recipe_id_idx ON public.pos_combo_items (recipe_id);
CREATE INDEX IF NOT EXISTS pos_combo_items_client_id_idx ON public.pos_combo_items (client_id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_combos', 'pos_combo_groups', 'pos_combo_items'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated
                      USING (((SELECT public.is_admin()) OR (client_id = (SELECT public.my_client_id()))))
                      WITH CHECK (((SELECT public.is_admin()) OR (client_id = (SELECT public.my_client_id()))))',
                   t || '_all', t);
    -- The option tables' restrictive pair: a till PIN login reads its menu, IMS logins edit like
    -- Option Groups, HR and Self-Service logins see nothing.
    EXECUTE format('DROP POLICY IF EXISTS no_self_service_accounts ON public.%I', t);
    EXECUTE format('CREATE POLICY no_self_service_accounts ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
                      USING (NOT public.is_hr_self_service())', t);
    EXECUTE format('DROP POLICY IF EXISTS no_hr_role_staff ON public.%I', t);
    EXECUTE format('CREATE POLICY no_hr_role_staff ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
                      USING (NOT public.is_hr_role_staff())', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, PUBLIC', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END;
$$;


-- ── 2. Who may change a combo: guard_pos_option_edit's rule ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_pos_combo_edit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_client uuid;
  v_ok     boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN v_client := OLD.client_id; ELSE v_client := NEW.client_id; END IF;

  IF current_user IN ('anon', 'authenticated') THEN
    IF NOT COALESCE(public.caller_can_set_menu_price(), false) THEN
      RAISE EXCEPTION 'Only the Owner, a POS manager or an IMS manager can change combos'
        USING ERRCODE = '42501', HINT = 'option_edit_rank';
    END IF;
    IF NOT COALESCE(public.is_admin(), false) AND NOT COALESCE(public.customization_live(v_client), false) THEN
      RAISE EXCEPTION 'Crest Customization is not switched on for this client'
        USING ERRCODE = '42501', HINT = 'customization_off';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF TG_TABLE_NAME = 'pos_combo_items' THEN
    SELECT (r.client_id = v_client AND r.category IS DISTINCT FROM 'Sub-Recipe') INTO v_ok
      FROM public.recipes r WHERE r.id = NEW.recipe_id;
    IF NOT COALESCE(v_ok, false) THEN
      RAISE EXCEPTION 'That dish is not one of this outlet''s dishes (a sub-recipe cannot be in a combo)'
        USING ERRCODE = '23514', HINT = 'combo_dish_unavailable';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.guard_pos_combo_edit() FROM PUBLIC;

DROP TRIGGER IF EXISTS pos_combos_guard ON public.pos_combos;
CREATE TRIGGER pos_combos_guard BEFORE INSERT OR UPDATE OR DELETE ON public.pos_combos
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_combo_edit();
DROP TRIGGER IF EXISTS pos_combo_groups_guard ON public.pos_combo_groups;
CREATE TRIGGER pos_combo_groups_guard BEFORE INSERT OR UPDATE OR DELETE ON public.pos_combo_groups
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_combo_edit();
DROP TRIGGER IF EXISTS pos_combo_items_guard ON public.pos_combo_items;
CREATE TRIGGER pos_combo_items_guard BEFORE INSERT OR UPDATE OR DELETE ON public.pos_combo_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_combo_edit();


-- ── 3. The price split ────────────────────────────────────────────────────────────────────────
-- Each pick's share of guest_price, in proportion to its CHEAPEST dish's standalone guest price
-- (selling_price × (1 + vat_rate) on a VAT outlet, vat_rate NULL = 0.13; the price on a PAN outlet;
-- an unpriced dish weighs 0). Equal shares when every pick weighs 0. Rounded to the paisa; the last
-- pick (sort, id) takes the remainder, so the shares add up to guest_price exactly. The share does not
-- depend on the dish picked, so a swap never moves the other dishes' prices. JS twin: comboShares().
CREATE OR REPLACE FUNCTION public.pos_combo_shares(p_combo_id uuid)
RETURNS TABLE (group_id uuid, group_name text, sort integer, share numeric)
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
    SELECT gr.id, gr.name, gr.sort,
           COALESCE((SELECT min(CASE WHEN COALESCE(r.selling_price, 0) <= 0 THEN 0
                                     WHEN c.vat_reg THEN r.selling_price * (1 + COALESCE(r.vat_rate, 0.13))
                                     ELSE r.selling_price END)
                       FROM pos_combo_items it
                       JOIN recipes r ON r.id = it.recipe_id
                      WHERE it.group_id = gr.id), 0) AS w,
           row_number() OVER (ORDER BY gr.sort, gr.id) AS n,
           count(*) OVER () AS cnt
      FROM pos_combo_groups gr
      JOIN c ON gr.combo_id = c.id
  ), t AS (
    SELECT COALESCE(sum(w), 0) AS tw FROM g
  ), s AS (
    SELECT g.id, g.name, g.sort, g.n, g.cnt,
           round(c.guest_price * CASE WHEN t.tw > 0 THEN g.w / t.tw ELSE 1.0 / g.cnt END, 2) AS raw
      FROM g CROSS JOIN t CROSS JOIN c
  )
  SELECT s.id, s.name, s.sort,
         CASE WHEN s.n = s.cnt
              THEN (SELECT c.guest_price FROM c) - COALESCE((SELECT sum(s2.raw) FROM s s2 WHERE s2.n < s.cnt), 0)
              ELSE s.raw END
    FROM s
   ORDER BY s.sort, s.id;
$function$;
REVOKE ALL ON FUNCTION public.pos_combo_shares(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_combo_shares(uuid) TO authenticated, service_role;


-- ── 4. Saving and deleting a combo: one transaction each ─────────────────────────────────────────
-- INVOKER, so RLS and guard_pos_combo_edit apply to every row it writes. p_combo (docs/pos-combos.md):
-- { id?, client_id, name, guest_price, description?, is_active?, on_guest_menu?, sort?,
--   groups: [{ id?, name, sort?, items: [{ recipe_id, extra_price?, is_default?, sort? }] }] }
CREATE OR REPLACE FUNCTION public.save_pos_combo(p_combo jsonb)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_id      uuid;
  v_client  uuid;
  v_name    text := btrim(COALESCE(p_combo->>'name', ''));
  v_price   numeric;
  v_groups  jsonb := CASE WHEN jsonb_typeof(p_combo->'groups') = 'array' THEN p_combo->'groups' ELSE '[]'::jsonb END;
  v_g       jsonb;
  v_gid     uuid;
  v_n       integer := 0;
  v_keep    uuid[] := '{}';
  v_bad     text;
BEGIN
  IF jsonb_typeof(p_combo) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'combo_needs_picks: nothing to save' USING ERRCODE = 'P0001', HINT = 'combo_needs_picks';
  END IF;

  -- The combo's own outlet when it exists; otherwise the one the screen names.
  IF COALESCE(p_combo->>'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT cb.id, cb.client_id INTO v_id, v_client FROM pos_combos cb WHERE cb.id = (p_combo->>'id')::uuid;
  END IF;
  IF v_id IS NULL THEN
    IF COALESCE(p_combo->>'client_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'combo_unavailable: the outlet this combo belongs to was not named' USING ERRCODE = 'P0001', HINT = 'combo_unavailable';
    END IF;
    v_client := (p_combo->>'client_id')::uuid;
  END IF;
  IF NOT COALESCE(public.is_admin() OR v_client = public.my_client_id(), false) THEN
    RAISE EXCEPTION 'Not permitted: this combo belongs to another outlet' USING ERRCODE = '42501', HINT = 'option_edit_rank';
  END IF;

  IF v_name = '' THEN
    RAISE EXCEPTION 'combo_name_taken: a combo needs a name' USING ERRCODE = 'P0001', HINT = 'combo_name_taken';
  END IF;
  IF EXISTS (SELECT 1 FROM pos_combos cb WHERE cb.client_id = v_client AND lower(cb.name) = lower(v_name)
                AND cb.id IS DISTINCT FROM v_id) THEN
    RAISE EXCEPTION 'combo_name_taken: another combo is already called %', v_name USING ERRCODE = 'P0001', HINT = 'combo_name_taken';
  END IF;
  v_price := CASE WHEN jsonb_typeof(p_combo->'guest_price') IN ('number', 'string')
                   AND (p_combo->>'guest_price') ~ '^[0-9]+(\.[0-9]{1,2})?$' THEN (p_combo->>'guest_price')::numeric END;
  IF v_price IS NULL OR v_price <= 0 OR v_price > 9999999999 THEN
    RAISE EXCEPTION 'combo_price_invalid: a combo''s price is an amount above zero, to the paisa' USING ERRCODE = 'P0001', HINT = 'combo_price_invalid';
  END IF;

  IF jsonb_array_length(v_groups) = 0 THEN
    RAISE EXCEPTION 'combo_needs_picks: a combo needs at least one pick' USING ERRCODE = 'P0001', HINT = 'combo_needs_picks';
  END IF;
  SELECT string_agg(DISTINCT COALESCE(NULLIF(btrim(g->>'name'), ''), '(no name)'), ', ') INTO v_bad
    FROM jsonb_array_elements(v_groups) g
   WHERE btrim(COALESCE(g->>'name', '')) = ''
      OR jsonb_typeof(g->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(g->'items') = 0;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'combo_pick_empty: every pick needs a name and at least one dish (%)', v_bad USING ERRCODE = 'P0001', HINT = 'combo_pick_empty';
  END IF;
  IF (SELECT count(DISTINCT lower(btrim(g->>'name'))) FROM jsonb_array_elements(v_groups) g) <> jsonb_array_length(v_groups) THEN
    RAISE EXCEPTION 'combo_pick_name_taken: two picks of this combo have the same name' USING ERRCODE = 'P0001', HINT = 'combo_pick_name_taken';
  END IF;
  SELECT string_agg(DISTINCT g->>'name', ', ') INTO v_bad
    FROM jsonb_array_elements(v_groups) g
   WHERE (SELECT count(*) FROM jsonb_array_elements(g->'items') it WHERE COALESCE((it->>'is_default')::boolean, false)) > 1
      OR (SELECT count(DISTINCT it->>'recipe_id') FROM jsonb_array_elements(g->'items') it) <> jsonb_array_length(g->'items');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'combo_default_twice: a pick has two defaults or the same dish twice (%)', v_bad USING ERRCODE = 'P0001', HINT = 'combo_default_twice';
  END IF;
  SELECT string_agg(DISTINCT COALESCE(r.name, it->>'recipe_id', 'a dish'), ', ') INTO v_bad
    FROM jsonb_array_elements(v_groups) g
   CROSS JOIN LATERAL jsonb_array_elements(g->'items') it
    LEFT JOIN recipes r ON COALESCE(it->>'recipe_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                       AND r.id = (it->>'recipe_id')::uuid
   WHERE NOT COALESCE(r.client_id = v_client AND r.is_active AND r.category IS DISTINCT FROM 'Sub-Recipe', false)
      OR NOT COALESCE((it->>'extra_price') IS NULL OR (it->>'extra_price') ~ '^[0-9]+(\.[0-9]{1,2})?$', false);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'combo_dish_unavailable: % cannot be in a combo here (not an active dish of this outlet, or its extra charge is not an amount)', v_bad
      USING ERRCODE = 'P0001', HINT = 'combo_dish_unavailable';
  END IF;

  -- The combo.
  IF v_id IS NULL THEN
    INSERT INTO pos_combos (client_id, name, guest_price, description, is_active, on_guest_menu, sort)
    VALUES (v_client, v_name, v_price, NULLIF(btrim(COALESCE(p_combo->>'description', '')), ''),
            COALESCE((p_combo->>'is_active')::boolean, true), COALESCE((p_combo->>'on_guest_menu')::boolean, true),
            COALESCE((p_combo->>'sort')::integer, 0))
    RETURNING id INTO v_id;
  ELSE
    UPDATE pos_combos
       SET name = v_name, guest_price = v_price,
           description = NULLIF(btrim(COALESCE(p_combo->>'description', '')), ''),
           is_active = COALESCE((p_combo->>'is_active')::boolean, is_active),
           on_guest_menu = COALESCE((p_combo->>'on_guest_menu')::boolean, on_guest_menu),
           sort = COALESCE((p_combo->>'sort')::integer, sort)
     WHERE id = v_id;
  END IF;

  -- Its picks: the ones kept keep their ids (order lines name them); the rest go. Names are parked
  -- first so two picks can swap names inside one save.
  SELECT COALESCE(array_agg((g->>'id')::uuid), '{}') INTO v_keep
    FROM jsonb_array_elements(v_groups) g
   WHERE COALESCE(g->>'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  DELETE FROM pos_combo_groups WHERE combo_id = v_id AND NOT (id = ANY (v_keep));
  UPDATE pos_combo_groups SET name = id::text WHERE combo_id = v_id;

  FOR v_g IN SELECT * FROM jsonb_array_elements(v_groups) LOOP
    v_n := v_n + 1;
    v_gid := NULL;
    IF COALESCE(v_g->>'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      UPDATE pos_combo_groups SET name = btrim(v_g->>'name'), sort = COALESCE((v_g->>'sort')::integer, v_n)
       WHERE id = (v_g->>'id')::uuid AND combo_id = v_id
      RETURNING id INTO v_gid;
    END IF;
    IF v_gid IS NULL THEN
      INSERT INTO pos_combo_groups (client_id, combo_id, name, sort)
      VALUES (v_client, v_id, btrim(v_g->>'name'), COALESCE((v_g->>'sort')::integer, v_n))
      RETURNING id INTO v_gid;
    END IF;

    -- Its dishes: replaced by recipe, the default cleared first (one default per pick).
    DELETE FROM pos_combo_items
     WHERE group_id = v_gid
       AND NOT (recipe_id::text = ANY (ARRAY(SELECT lower(it->>'recipe_id') FROM jsonb_array_elements(v_g->'items') it)));
    UPDATE pos_combo_items SET is_default = false WHERE group_id = v_gid AND is_default;
    INSERT INTO pos_combo_items (client_id, group_id, recipe_id, extra_price, is_default, sort)
    SELECT v_client, v_gid, (it->>'recipe_id')::uuid, COALESCE((it->>'extra_price')::numeric, 0),
           COALESCE((it->>'is_default')::boolean, false), COALESCE((it->>'sort')::integer, n::integer)
      FROM jsonb_array_elements(v_g->'items') WITH ORDINALITY AS x(it, n)
    ON CONFLICT (group_id, recipe_id) DO UPDATE
       SET extra_price = EXCLUDED.extra_price, is_default = EXCLUDED.is_default, sort = EXCLUDED.sort;
  END LOOP;

  RETURN v_id;
END
$function$;
REVOKE ALL ON FUNCTION public.save_pos_combo(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_pos_combo(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.delete_pos_combo(p_combo_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_client uuid;
BEGIN
  SELECT client_id INTO v_client FROM pos_combos WHERE id = p_combo_id;
  IF v_client IS NULL THEN
    RETURN;   -- already gone, or not this login's to see
  END IF;
  IF NOT COALESCE(public.is_admin() OR v_client = public.my_client_id(), false) THEN
    RAISE EXCEPTION 'Not permitted: this combo belongs to another outlet' USING ERRCODE = '42501', HINT = 'option_edit_rank';
  END IF;
  -- Past bills keep their combo dishes and names (snapshots, no foreign key).
  DELETE FROM pos_combos WHERE id = p_combo_id;
END
$function$;
REVOKE ALL ON FUNCTION public.delete_pos_combo(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_pos_combo(uuid) TO authenticated, service_role;


-- ── 5. A combo dish's line ───────────────────────────────────────────────────────────────────
ALTER TABLE public.pos_order_items
  ADD COLUMN IF NOT EXISTS combo_line_id    uuid,
  ADD COLUMN IF NOT EXISTS combo_id         uuid,
  ADD COLUMN IF NOT EXISTS combo_name       text,
  ADD COLUMN IF NOT EXISTS combo_price      numeric,
  ADD COLUMN IF NOT EXISTS combo_group_id   uuid,
  ADD COLUMN IF NOT EXISTS combo_group_name text,
  ADD COLUMN IF NOT EXISTS combo_sort       integer;

-- The tag and the key agree: a combo dish's selection_key ends '@<combo_line_id>/<combo_group_id>',
-- and only a combo dish's key carries an '@'.
ALTER TABLE public.pos_order_items DROP CONSTRAINT IF EXISTS pos_order_items_combo_key_check;
ALTER TABLE public.pos_order_items ADD CONSTRAINT pos_order_items_combo_key_check CHECK (
  COALESCE(CASE WHEN combo_line_id IS NULL
                THEN combo_group_id IS NULL AND position('@' IN COALESCE(selection_key, '')) = 0
                ELSE combo_group_id IS NOT NULL AND combo_id IS NOT NULL
                     AND COALESCE(selection_key, '') LIKE '%@' || combo_line_id::text || '/' || combo_group_id::text END,
           false));
CREATE INDEX IF NOT EXISTS pos_order_items_combo_line_idx ON public.pos_order_items (combo_line_id) WHERE combo_line_id IS NOT NULL;

-- guard_pos_item_price: the tag is a line's identity and price basis, so a direct write cannot move
-- it either (a cleared tag would put a combo dish back under the bill discount).
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
     AND NEW.combo_sort       IS NOT DISTINCT FROM OLD.combo_sort THEN
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


-- ── 6. save_pos_order_items: combo dishes ─────────────────────────────────────────────────────
-- The S816 body with the S839 changes marked. A combo dish is an ordinary row plus
-- `combo: { line_id, combo_id, group_id }`; the server builds its key, checks the combo, prices it
-- from today's split (a new line) or keeps its price (an existing one), and stamps the tag.
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
  v_any_combo boolean;   -- S839
  v_combo     jsonb;     -- S839: priced new combo dishes, by the minted line id
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

  UPDATE pos_orders SET items_version = items_version + 1
   WHERE id = p_order_id
   RETURNING items_version INTO v_version;

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
    INTO v_items
    FROM pos_order_items i WHERE i.order_id = p_order_id;

  RETURN jsonb_build_object('inserted', v_inserted, 'items_version', v_version, 'items', v_items);
END;
$function$;


-- ── 7. A bill discount never touches a combo ──────────────────────────────────────────────────
-- Inventory revenue: the discount spreads over the non-comped, non-combo lines only.
CREATE OR REPLACE FUNCTION public.pos_bill_sales_rows(p_order_ids uuid[])
 RETURNS TABLE(order_id uuid, line_id uuid, recipe_id uuid, source text, qty_sold numeric, unit_price numeric, vat_rate numeric, ingredient_deltas jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH b AS (
    SELECT o.id, (o.close_type = 'writeoff') AS whole_comp,
           CASE WHEN o.close_type = 'writeoff' THEN 0::float8
                WHEN x.base > 0 AND COALESCE(o.discount_amount, 0) > 0
                  THEN LEAST(1::float8, o.discount_amount::float8 / x.base)
                ELSE 0::float8 END AS disc
      FROM pos_orders o
     CROSS JOIN LATERAL (
       -- S839: a combo's dishes are outside the discount base.
       SELECT COALESCE(sum(i.qty::float8 * i.unit_price::float8) FILTER (WHERE NOT i.comped AND i.combo_line_id IS NULL), 0) AS base
         FROM pos_order_items i
        WHERE i.order_id = o.id
     ) x
     WHERE o.id = ANY (p_order_ids)
  )
  SELECT b.id, i.id, i.recipe_id,
         CASE WHEN b.whole_comp OR i.comped THEN 'pos_comp' ELSE 'pos' END,
         i.qty::numeric,
         CASE WHEN b.whole_comp OR i.comped OR b.disc = 0 OR i.combo_line_id IS NOT NULL THEN i.unit_price
              ELSE (i.unit_price::float8 * (1 - b.disc))::numeric END,
         COALESCE(i.vat_rate, 0),
         CASE WHEN i.selection_key <> '' THEN public.pos_line_choice_lines(i.id) END
    FROM b
    JOIN pos_order_items i ON i.order_id = b.id
   WHERE i.recipe_id IS NOT NULL;
$function$;

-- The close: the cap is measured on the discountable lines, and a discount above them is refused
-- from anyone but the operator.
DO $do$
DECLARE
  v_def text := pg_get_functiondef('public.guard_pos_order_close()'::regprocedure);
BEGIN
  v_def := pg_temp.s839_patch(v_def,
$o$     AND NEW.discount_amount IS NOT DISTINCT FROM OLD.discount_amount THEN
    RETURN NEW;
  END IF;

  IF public.is_admin() THEN
$o$,
$n$     AND NEW.discount_amount IS NOT DISTINCT FROM OLD.discount_amount THEN
    RETURN NEW;
  END IF;

  -- S839 (owner decision 2026-10-14): a bill discount never touches a combo. The discountable
  -- subtotal is the non-comped lines that are not a combo's dishes; a discount above it would come off
  -- the combo, so it is refused from everyone but the operator (whose restore re-inserts old bills).
  IF COALESCE(NEW.discount_amount, 0) > 0 AND NOT COALESCE(public.is_admin(), false) THEN
    SELECT COALESCE(SUM(qty * unit_price), 0)
      INTO v_subtotal
      FROM pos_order_items
     WHERE order_id = NEW.id
       AND COALESCE(comped, false) = false
       AND combo_line_id IS NULL;
    IF NEW.discount_amount > v_subtotal + 0.01 THEN
      RAISE EXCEPTION 'pos_orders: a discount of % is more than the % this bill''s discount can come off — a combo is already a deal, so a bill discount does not touch it',
        ROUND(NEW.discount_amount, 2), ROUND(v_subtotal, 2)
        USING ERRCODE = '42501', HINT = 'discount_on_combo';
    END IF;
  END IF;

  IF public.is_admin() THEN
$n$);
  v_def := pg_temp.s839_patch(v_def,
$o$       AND COALESCE(comped, false) = false;
$o$,
$n$       AND COALESCE(comped, false) = false
       AND combo_line_id IS NULL;   -- S839: the cap is a share of the discountable lines
$n$);
  EXECUTE v_def;
END;
$do$;


-- ── 8. A combo is comped whole, and the comped copy keeps its tag ──────────────────────────────
DO $do$
DECLARE
  v_def text := pg_get_functiondef('public.apply_pos_item_comps(uuid,uuid,text,text,uuid,uuid[],jsonb,jsonb)'::regprocedure);
BEGIN
  v_def := pg_temp.s839_patch(v_def,
$o$           selection_key, base_unit_price, options_delta, option_summary
      INTO v_src$o$,
$n$           selection_key, base_unit_price, options_delta, option_summary,
           combo_line_id, combo_id, combo_name, combo_price, combo_group_id, combo_group_name, combo_sort  -- S839
      INTO v_src$n$);
  v_def := pg_temp.s839_patch(v_def,
$o$      selection_key, base_unit_price, options_delta, option_summary
    ) VALUES ($o$,
$n$      selection_key, base_unit_price, options_delta, option_summary,
      combo_line_id, combo_id, combo_name, combo_price, combo_group_id, combo_group_name, combo_sort
    ) VALUES ($n$);
  v_def := pg_temp.s839_patch(v_def,
$o$      v_src.selection_key, v_src.base_unit_price, v_src.options_delta, v_src.option_summary
    ) RETURNING id INTO v_new_id;$o$,
$n$      v_src.selection_key, v_src.base_unit_price, v_src.options_delta, v_src.option_summary,
      v_src.combo_line_id, v_src.combo_id, v_src.combo_name, v_src.combo_price, v_src.combo_group_id,
      v_src.combo_group_name, v_src.combo_sort
    ) RETURNING id INTO v_new_id;$n$);
  v_def := pg_temp.s839_patch(v_def,
$o$  RETURN v_comp_no;
END;$o$,
$n$  -- S839 (docs/pos-combos.md): a combo is comped whole. On each combo of the bill, every pick has the
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
END;$n$);
  EXECUTE v_def;
END;
$do$;


-- ── 9. A combo moves whole, and the moved copy keeps its tag ──────────────────────────────────
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
                                   combo_line_id, combo_id, combo_name, combo_price, combo_group_id, combo_group_name, combo_sort)
      VALUES (p_to, v_client, r.recipe_id, r.name, v_q, r.unit_price, r.vat_rate, r.notes, v_move >= v_q,
              r.category, v_move, r.selection_key, r.base_unit_price, r.options_delta, r.option_summary,
              r.combo_line_id, r.combo_id, r.combo_name, r.combo_price, r.combo_group_id, r.combo_group_name, r.combo_sort)
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


-- ── 10. The guest QR menu lists combos ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_guest_menu_options(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id uuid;
BEGIN
  SELECT t.client_id INTO v_client_id FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN RETURN '{}'::jsonb; END IF;
  IF NOT COALESCE((SELECT c.pos_enabled FROM clients c WHERE c.id = v_client_id), false) THEN RETURN '{}'::jsonb; END IF;
  IF NOT COALESCE(public.client_access_open(v_client_id), false) THEN RETURN '{}'::jsonb; END IF;
  IF NOT public.customization_live(v_client_id) THEN RETURN '{}'::jsonb; END IF;

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
    -- S839: a dish sold only inside a guest combo still brings its own choices.
    'attachments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('recipe_id', a.recipe_id, 'group_id', a.group_id, 'min_override', a.min_override,
                                          'max_override', a.max_override, 'default_option_id', a.default_option_id,
                                          'sort', a.sort) ORDER BY a.sort, a.id)
        FROM pos_recipe_option_groups a
        JOIN recipes rc ON rc.id = a.recipe_id
       WHERE a.client_id = v_client_id AND rc.is_active AND rc.category IS DISTINCT FROM 'Sub-Recipe'
         AND ((rc.pos_enabled AND rc.selling_price > 0)
              OR EXISTS (SELECT 1 FROM pos_combo_items it
                           JOIN pos_combo_groups cg ON cg.id = it.group_id
                           JOIN pos_combos cb ON cb.id = cg.combo_id
                          WHERE it.recipe_id = rc.id AND cb.is_active AND cb.on_guest_menu))), '[]'::jsonb),
    'build_your_own', COALESCE((
      SELECT jsonb_agg(rc.id ORDER BY rc.id)
        FROM recipes rc
       WHERE rc.client_id = v_client_id AND rc.is_build_your_own AND rc.is_active AND rc.pos_enabled
         AND rc.category IS DISTINCT FROM 'Sub-Recipe' AND rc.selling_price > 0), '[]'::jsonb),
    -- S839 (docs/pos-combos.md): the combos a guest may order — active, on the guest menu, every pick
    -- with at least one active dish — each pick with its share of the price and its dishes.
    'combos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', cb.id, 'name', cb.name, 'description', cb.description, 'guest_price', cb.guest_price,
               'sort', cb.sort,
               'groups', (
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', g.id, 'name', g.name, 'sort', g.sort, 'share', sh.share,
                          'items', (
                            SELECT jsonb_agg(jsonb_build_object(
                                     'recipe_id', rc.id, 'name', rc.name, 'is_veg', rc.is_veg,
                                     'extra_price', it.extra_price, 'is_default', it.is_default, 'sort', it.sort)
                                     ORDER BY it.sort, rc.name, rc.id)
                              FROM pos_combo_items it
                              JOIN recipes rc ON rc.id = it.recipe_id
                             WHERE it.group_id = g.id AND rc.is_active AND rc.category IS DISTINCT FROM 'Sub-Recipe'))
                          ORDER BY g.sort, g.id)
                   FROM pos_combo_groups g
                   JOIN public.pos_combo_shares(cb.id) sh ON sh.group_id = g.id
                  WHERE g.combo_id = cb.id))
             ORDER BY cb.sort, cb.name, cb.id)
        FROM pos_combos cb
       WHERE cb.client_id = v_client_id AND cb.is_active AND cb.on_guest_menu
         AND EXISTS (SELECT 1 FROM pos_combo_groups g WHERE g.combo_id = cb.id)
         AND NOT EXISTS (
               SELECT 1 FROM pos_combo_groups g
                WHERE g.combo_id = cb.id
                  AND NOT EXISTS (SELECT 1 FROM pos_combo_items it JOIN recipes rc ON rc.id = it.recipe_id
                                   WHERE it.group_id = g.id AND rc.is_active AND rc.category IS DISTINCT FROM 'Sub-Recipe'))
    ), '[]'::jsonb)
  );
END
$function$;


-- ── 11. A guest orders a combo ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_guest_order(p_table_id uuid, p_items jsonb, p_notes text DEFAULT NULL::text, p_covers integer DEFAULT 1, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id uuid;
  v_table_status text;
  v_pos_enabled boolean;
  v_cust boolean;
  v_request_id uuid;
  v_snapshot jsonb := '[]'::jsonb;
  v_unavailable text[] := '{}';
  v_bad_options text[] := '{}';
  v_below_zero  text[] := '{}';  -- S835
  r RECORD;
  item RECORD;
  v_qty numeric;
  v_note text;
  v_opt_ids uuid[];
  v_has_groups boolean;
  v_sel jsonb;
  v_key_table uuid;
  -- S839
  v_vat_reg boolean;
  v_cb RECORD;
  v_comp RECORD;
  v_pick jsonb;
  v_line uuid;
  v_parts jsonb;
  v_ok boolean;
  v_share numeric;
  v_base numeric;
  v_delta numeric;
  v_first boolean;
BEGIN
  SELECT t.client_id, t.status INTO v_client_id, v_table_status FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Table not found' USING HINT = 'table_not_found';
  END IF;

  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN
    RAISE EXCEPTION 'POS not enabled for this restaurant' USING HINT = 'not_accepting';
  END IF;

  IF NOT COALESCE(public.client_access_open(v_client_id), false) THEN
    RAISE EXCEPTION 'POS not enabled for this restaurant' USING HINT = 'not_accepting';
  END IF;

  IF p_request_id IS NOT NULL THEN
    SELECT q.table_id INTO v_key_table FROM pos_guest_order_requests q WHERE q.id = p_request_id;
    IF FOUND THEN
      IF v_key_table IS DISTINCT FROM p_table_id THEN
        RAISE EXCEPTION 'This order key belongs to another table' USING HINT = 'request_key_conflict';
      END IF;
      RETURN p_request_id;
    END IF;
  END IF;

  IF v_table_status = 'inactive' THEN
    RAISE EXCEPTION 'This table is not taking orders' USING HINT = 'inactive';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order is empty' USING HINT = 'empty';
  END IF;
  IF jsonb_array_length(p_items) > 30 THEN
    RAISE EXCEPTION 'Too many items in one order' USING HINT = 'too_many_items';
  END IF;

  v_cust := public.customization_live(v_client_id);
  v_vat_reg := COALESCE((SELECT s.is_vat_registered FROM settings s WHERE s.client_id = v_client_id), true);

  FOR item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(recipe_id uuid, qty numeric, note text, options jsonb, combo_id uuid, picks jsonb)
  LOOP
    -- ── S839 (docs/pos-combos.md): a combo — every pick once, each a dish of its pick ───────────
    IF item.combo_id IS NOT NULL THEN
      v_qty := LEAST(GREATEST(FLOOR(COALESCE(item.qty, 0)), 0), 50);
      IF v_qty <= 0 THEN CONTINUE; END IF;
      v_note := NULLIF(left(COALESCE(item.note, ''), 200), '');
      SELECT cb.id, cb.name, cb.guest_price INTO v_cb
        FROM pos_combos cb
       WHERE cb.id = item.combo_id AND cb.client_id = v_client_id AND cb.is_active AND cb.on_guest_menu;
      IF v_cb.id IS NULL OR NOT v_cust THEN
        v_unavailable := v_unavailable || COALESCE((SELECT cb.name FROM pos_combos cb WHERE cb.id = item.combo_id AND cb.client_id = v_client_id), 'A combo');
        CONTINUE;
      END IF;
      IF jsonb_typeof(item.picks) IS DISTINCT FROM 'array'
         OR (SELECT count(DISTINCT lower(p->>'group_id')) FROM jsonb_array_elements(item.picks) p) <> jsonb_array_length(item.picks)
         OR (SELECT array_agg(lower(p->>'group_id') ORDER BY lower(p->>'group_id')) FROM jsonb_array_elements(item.picks) p)
            IS DISTINCT FROM (SELECT array_agg(g.id::text ORDER BY g.id::text) FROM pos_combo_groups g WHERE g.combo_id = v_cb.id) THEN
        v_unavailable := v_unavailable || v_cb.name;
        CONTINUE;
      END IF;

      v_line  := gen_random_uuid();
      v_parts := '[]'::jsonb;
      v_ok    := true;
      v_first := true;
      FOR v_pick IN SELECT p FROM jsonb_array_elements(item.picks) p
                     ORDER BY (SELECT g.sort FROM pos_combo_groups g WHERE g.id::text = lower(p->>'group_id')), lower(p->>'group_id')
      LOOP
        SELECT rc.id, rc.name, rc.category, rc.vat_rate, it.extra_price, g.id AS group_id, g.name AS group_name, g.sort AS group_sort
          INTO v_comp
          FROM pos_combo_items it
          JOIN pos_combo_groups g ON g.id = it.group_id
          JOIN recipes rc ON rc.id = it.recipe_id
         WHERE g.combo_id = v_cb.id
           AND g.id::text = lower(v_pick->>'group_id')
           AND it.recipe_id::text = lower(v_pick->>'recipe_id')
           AND rc.is_active AND rc.category IS DISTINCT FROM 'Sub-Recipe';
        IF v_comp.id IS NULL THEN
          v_ok := false;
          EXIT;
        END IF;

        BEGIN
          SELECT COALESCE(array_agg(e::uuid), ARRAY[]::uuid[]) INTO v_opt_ids
            FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(v_pick->'options') = 'array' THEN v_pick->'options' ELSE '[]'::jsonb END) e;
        EXCEPTION WHEN invalid_text_representation THEN
          v_bad_options := v_bad_options || v_comp.name;
          v_ok := false;
          EXIT;
        END;
        v_has_groups := EXISTS (
          SELECT 1 FROM pos_recipe_option_groups a JOIN pos_option_groups g ON g.id = a.group_id AND g.is_active
           WHERE a.recipe_id = v_comp.id AND EXISTS (SELECT 1 FROM pos_options o WHERE o.group_id = g.id AND o.is_active));
        IF cardinality(v_opt_ids) > 0 AND NOT v_has_groups THEN
          v_bad_options := v_bad_options || v_comp.name;
          v_ok := false;
          EXIT;
        END IF;
        v_sel := NULL;
        IF v_has_groups THEN
          v_sel := public.pos_price_selection(v_client_id, v_comp.id, v_opt_ids);
          -- A combo dish's own price is its share, so pos_price_selection's below-zero test on the
          -- dish's menu price does not apply here; the share test follows.
          IF v_sel->>'problem' IS NOT NULL AND v_sel->>'problem' <> 'option_price_below_zero' THEN
            v_bad_options := v_bad_options || v_comp.name;
            v_ok := false;
            EXIT;
          END IF;
        END IF;
        v_delta := COALESCE((v_sel->>'delta')::numeric, 0);
        SELECT sh.share INTO v_share FROM public.pos_combo_shares(v_cb.id) sh WHERE sh.group_id = v_comp.group_id;
        v_base := round((COALESCE(v_share, 0) + COALESCE(v_comp.extra_price, 0))
                        / (1 + CASE WHEN v_vat_reg THEN COALESCE(v_comp.vat_rate, 0.13) ELSE 0 END), 2);
        IF v_base + v_delta < 0 THEN
          v_below_zero := v_below_zero || v_comp.name;
          v_ok := false;
          EXIT;
        END IF;

        v_parts := v_parts || jsonb_build_object(
          'recipe_id', v_comp.id, 'name', v_comp.name, 'category', v_comp.category,
          'unit_price', v_base + v_delta, 'vat_rate', v_comp.vat_rate,
          'qty', v_qty,
          -- The guest's note goes on the first dish only, so the kitchen reads it once.
          'note', CASE WHEN v_first THEN v_note END,
          'base_unit_price', v_base, 'options_delta', v_delta,
          'selection_key', COALESCE(NULLIF(v_sel->>'selection_key', ''), '') || '@' || v_line::text || '/' || v_comp.group_id::text,
          'option_ids', COALESCE(v_sel->'option_ids', '[]'::jsonb),
          'option_summary', NULLIF(v_sel->>'summary', ''),
          'options', COALESCE(v_sel->'options', '[]'::jsonb),
          'combo', jsonb_build_object('line_id', v_line, 'combo_id', v_cb.id, 'name', v_cb.name,
                                      'group_id', v_comp.group_id, 'group_name', v_comp.group_name,
                                      'sort', v_comp.group_sort, 'price', v_cb.guest_price));
        v_first := false;
      END LOOP;

      IF NOT v_ok THEN
        IF NOT (v_cb.name = ANY (v_unavailable)) AND cardinality(v_bad_options) = 0 AND cardinality(v_below_zero) = 0 THEN
          v_unavailable := v_unavailable || v_cb.name;
        END IF;
        CONTINUE;
      END IF;
      v_snapshot := v_snapshot || v_parts;
      CONTINUE;
    END IF;

    IF item.recipe_id IS NULL THEN CONTINUE; END IF;
    v_qty := LEAST(GREATEST(FLOOR(COALESCE(item.qty, 0)), 0), 50);
    IF v_qty <= 0 THEN CONTINUE; END IF;
    v_note := NULLIF(left(COALESCE(item.note, ''), 200), '');

    SELECT rc.id, rc.name, rc.category, rc.selling_price, rc.vat_rate, rc.is_active, rc.pos_enabled INTO r
    FROM recipes rc
    WHERE rc.id = item.recipe_id AND rc.client_id = v_client_id;

    IF r.id IS NULL
       OR NOT COALESCE(r.is_active = true AND r.pos_enabled = true
                       AND r.category IS DISTINCT FROM 'Sub-Recipe' AND r.selling_price > 0, false) THEN
      v_unavailable := v_unavailable || COALESCE(NULLIF(btrim(r.name), ''), 'An item');
      CONTINUE;
    END IF;

    BEGIN
      SELECT COALESCE(array_agg(e::uuid), ARRAY[]::uuid[]) INTO v_opt_ids
        FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(item.options) = 'array' THEN item.options ELSE '[]'::jsonb END) e;
    EXCEPTION WHEN invalid_text_representation THEN
      v_bad_options := v_bad_options || r.name;
      CONTINUE;
    END;

    v_has_groups := v_cust AND EXISTS (
      SELECT 1 FROM pos_recipe_option_groups a JOIN pos_option_groups g ON g.id = a.group_id AND g.is_active
       WHERE a.recipe_id = r.id AND EXISTS (SELECT 1 FROM pos_options o WHERE o.group_id = g.id AND o.is_active));

    IF cardinality(v_opt_ids) > 0 AND NOT v_cust THEN
      v_bad_options := v_bad_options || r.name;
      CONTINUE;
    END IF;

    IF cardinality(v_opt_ids) > 0 AND NOT v_has_groups THEN
      v_bad_options := v_bad_options || r.name;
      CONTINUE;
    END IF;

    IF v_has_groups THEN
      v_sel := public.pos_price_selection(v_client_id, r.id, v_opt_ids);
      IF v_sel->>'problem' = 'option_price_below_zero' THEN
        v_below_zero := v_below_zero || r.name;
        CONTINUE;
      END IF;
      IF v_sel->>'problem' IS NOT NULL THEN
        v_bad_options := v_bad_options || r.name;
        CONTINUE;
      END IF;
    ELSE
      v_sel := NULL;
    END IF;

    IF v_sel IS NOT NULL AND v_sel->>'selection_key' <> '' THEN
      v_snapshot := v_snapshot || jsonb_build_object(
        'recipe_id', r.id, 'name', r.name, 'category', r.category,
        'unit_price', r.selling_price + (v_sel->>'delta')::numeric, 'vat_rate', r.vat_rate,
        'qty', v_qty, 'note', v_note,
        'base_unit_price', r.selling_price, 'options_delta', (v_sel->>'delta')::numeric,
        'selection_key', v_sel->>'selection_key', 'option_ids', v_sel->'option_ids',
        'option_summary', v_sel->>'summary', 'options', v_sel->'options'
      );
    ELSE
      v_snapshot := v_snapshot || jsonb_build_object(
        'recipe_id', r.id, 'name', r.name, 'category', r.category,
        'unit_price', r.selling_price, 'vat_rate', r.vat_rate,
        'qty', v_qty, 'note', v_note
      );
    END IF;
  END LOOP;

  IF cardinality(v_unavailable) > 0 THEN
    RAISE EXCEPTION 'Some items in this order are no longer available'
      USING HINT = 'unavailable_items',
            DETAIL = to_jsonb(ARRAY(SELECT DISTINCT u FROM unnest(v_unavailable) u ORDER BY 1))::text;
  END IF;

  IF cardinality(v_bad_options) > 0 THEN
    RAISE EXCEPTION 'The choices on some dishes are no longer available'
      USING HINT = 'unavailable_options',
            DETAIL = to_jsonb(ARRAY(SELECT DISTINCT u FROM unnest(v_bad_options) u ORDER BY 1))::text;
  END IF;

  IF cardinality(v_below_zero) > 0 THEN
    RAISE EXCEPTION 'Some dishes cannot be ordered with the choices picked'
      USING HINT = 'below_zero_options',
            DETAIL = to_jsonb(ARRAY(SELECT DISTINCT u FROM unnest(v_below_zero) u ORDER BY 1))::text;
  END IF;

  IF jsonb_array_length(v_snapshot) = 0 THEN
    RAISE EXCEPTION 'No valid items in order' USING HINT = 'no_valid_items';
  END IF;

  PERFORM public.pos_turn_away_stale_guest_orders(v_client_id, p_table_id);

  BEGIN
    INSERT INTO pos_guest_order_requests (id, client_id, table_id, items, guest_notes, covers)
    VALUES (
      COALESCE(p_request_id, gen_random_uuid()), v_client_id, p_table_id, v_snapshot,
      NULLIF(left(COALESCE(p_notes, ''), 500), ''),
      LEAST(GREATEST(COALESCE(p_covers, 1), 1), 50)
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id INTO v_request_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This table already has an order request waiting for staff — please wait for it to be reviewed before sending another.'
      USING HINT = 'pending';
  END;

  IF v_request_id IS NULL THEN
    SELECT q.table_id INTO v_key_table FROM pos_guest_order_requests q WHERE q.id = p_request_id;
    IF v_key_table IS DISTINCT FROM p_table_id THEN
      RAISE EXCEPTION 'This order key belongs to another table' USING HINT = 'request_key_conflict';
    END IF;
    v_request_id := p_request_id;
  END IF;

  RETURN v_request_id;
END;
$function$;


-- ── 12. The probe, rolled back ────────────────────────────────────────────────────────────────
-- At BLOOM CAFE (Customization live), as a stand-in POS manager: a combo saved and refused, its split,
-- an order with a combo priced, refused when incomplete, a swap, the discount rule on the close guard
-- and on Inventory revenue, a partial comp and a partial move refused, the guest menu and a guest
-- combo order. Everything is undone by the sentinel.
DO $probe$
DECLARE
  v_client uuid; v_staff uuid; v_hint text; v_r jsonb; v_n integer; v_num numeric; v_txt text;
  v_veg uuid; v_chk uuid; v_coke uuid; v_tea uuid;
  v_combo uuid; v_gm uuid; v_gd uuid;
  v_ta uuid; v_tb uuid; v_tg uuid; v_o uuid; v_o2 uuid; v_req uuid;
  v_line uuid := gen_random_uuid();
  v_veg_line uuid;
BEGIN
  SELECT c.id INTO v_client
    FROM public.clients c
   WHERE COALESCE(public.customization_live(c.id), false) AND COALESCE(public.client_access_open(c.id), false)
     AND EXISTS (SELECT 1 FROM public.settings s WHERE s.client_id = c.id)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND p.active_client_id IS NULL
                    AND p.pos_role IS NOT NULL AND p.pos_email IS NOT NULL
                    AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL)
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S839 probe: no outlet with Customization live and an unblocked POS till login';
  END IF;
  SELECT p.id INTO v_staff FROM public.profiles p
   WHERE p.client_id = v_client AND p.active_client_id IS NULL AND p.pos_role IS NOT NULL AND p.pos_email IS NOT NULL
     AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL
   ORDER BY p.id LIMIT 1;

  BEGIN
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);
    PERFORM set_config('request.jwt.claims', '', true);
    -- A POS manager with no discount limit and no other staff marker.
    UPDATE public.profiles SET pos_role = 'manager', ims_role = NULL, hr_role = NULL, hr_self_service = false,
                               pos_discount_limit = NULL
     WHERE id = v_staff;
    UPDATE public.settings SET is_vat_registered = true WHERE client_id = v_client;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, is_active, pos_enabled)
      VALUES (v_client, 'S839 probe veg momo', 'Food', 200, 0.13, true, true) RETURNING id INTO v_veg;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, is_active, pos_enabled)
      VALUES (v_client, 'S839 probe chicken momo', 'Food', 240, 0.13, true, true) RETURNING id INTO v_chk;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, is_active, pos_enabled)
      VALUES (v_client, 'S839 probe coke', 'Beverage', 100, 0.13, true, false) RETURNING id INTO v_coke;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, is_active, pos_enabled)
      VALUES (v_client, 'S839 probe tea', 'Beverage', 50, 0.13, true, true) RETURNING id INTO v_tea;
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_client, 'S839 probe A') RETURNING id INTO v_ta;
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_client, 'S839 probe B') RETURNING id INTO v_tb;
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_client, 'S839 probe guest') RETURNING id INTO v_tg;
    INSERT INTO public.pos_orders (client_id, table_id, table_name, covers) VALUES (v_client, v_ta, 'S839 probe A', 2) RETURNING id INTO v_o;
    INSERT INTO public.pos_orders (client_id, table_id, table_name, covers) VALUES (v_client, v_tb, 'S839 probe B', 1) RETURNING id INTO v_o2;

    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff)::text, true);
    SET LOCAL ROLE authenticated;

    -- ── The combo: saved, refused when malformed, its split ─────────────────────────────────────
    v_combo := public.save_pos_combo(jsonb_build_object(
      'client_id', v_client, 'name', 'S839 probe combo', 'guest_price', 350,
      'groups', jsonb_build_array(
        jsonb_build_object('name', 'Pick a momo', 'sort', 0, 'items', jsonb_build_array(
          jsonb_build_object('recipe_id', v_veg, 'extra_price', 0, 'is_default', true),
          jsonb_build_object('recipe_id', v_chk, 'extra_price', 50))),
        jsonb_build_object('name', 'Pick a drink', 'sort', 1, 'items', jsonb_build_array(
          jsonb_build_object('recipe_id', v_coke))))));
    SELECT id INTO v_gm FROM public.pos_combo_groups WHERE combo_id = v_combo AND name = 'Pick a momo';
    SELECT id INTO v_gd FROM public.pos_combo_groups WHERE combo_id = v_combo AND name = 'Pick a drink';
    IF v_gm IS NULL OR v_gd IS NULL
       OR (SELECT count(*) FROM public.pos_combo_items it JOIN public.pos_combo_groups g ON g.id = it.group_id WHERE g.combo_id = v_combo) <> 3 THEN
      RAISE EXCEPTION 'S839 probe: the combo did not save its picks';
    END IF;
    v_hint := NULL;
    BEGIN PERFORM public.save_pos_combo(jsonb_build_object('client_id', v_client, 'name', 'S839 PROBE COMBO ', 'guest_price', 300,
                    'groups', jsonb_build_array(jsonb_build_object('name', 'x', 'items', jsonb_build_array(jsonb_build_object('recipe_id', v_tea))))));
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT; END;
    IF v_hint IS DISTINCT FROM 'combo_name_taken' THEN RAISE EXCEPTION 'S839 probe: a second combo of the same name answered %', COALESCE(v_hint, 'nothing'); END IF;
    v_hint := NULL;
    BEGIN PERFORM public.save_pos_combo(jsonb_build_object('client_id', v_client, 'name', 'S839 probe empty', 'guest_price', 300,
                    'groups', jsonb_build_array(jsonb_build_object('name', 'x', 'items', '[]'::jsonb))));
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT; END;
    IF v_hint IS DISTINCT FROM 'combo_pick_empty' THEN RAISE EXCEPTION 'S839 probe: a pick with no dish answered %', COALESCE(v_hint, 'nothing'); END IF;
    IF (SELECT share FROM public.pos_combo_shares(v_combo) WHERE group_id = v_gm) IS DISTINCT FROM 233.33
       OR (SELECT share FROM public.pos_combo_shares(v_combo) WHERE group_id = v_gd) IS DISTINCT FROM 116.67 THEN
      RAISE EXCEPTION 'S839 probe: the split is not 233.33 / 116.67';
    END IF;

    -- ── An order with a combo and a tea ───────────────────────────────────────────────────────
    v_r := public.save_pos_order_items(v_o, jsonb_build_array(
      jsonb_build_object('recipe_id', v_veg, 'name', 'veg', 'qty', 1,
                         'combo', jsonb_build_object('line_id', v_line, 'combo_id', v_combo, 'group_id', v_gm)),
      jsonb_build_object('recipe_id', v_coke, 'name', 'coke', 'qty', 1,
                         'combo', jsonb_build_object('line_id', v_line, 'combo_id', v_combo, 'group_id', v_gd)),
      jsonb_build_object('recipe_id', v_tea, 'name', 'tea', 'qty', 2)), NULL, NULL);
    SELECT id INTO v_veg_line FROM public.pos_order_items WHERE order_id = v_o AND recipe_id = v_veg;
    IF NOT EXISTS (SELECT 1 FROM public.pos_order_items WHERE order_id = v_o AND recipe_id = v_veg
                     AND unit_price = 206.49 AND base_unit_price = 206.49 AND vat_rate = 0.13
                     AND combo_line_id = v_line AND combo_group_id = v_gm AND combo_name = 'S839 probe combo'
                     AND combo_price = 350 AND combo_group_name = 'Pick a momo' AND combo_sort = 0
                     AND selection_key = '@' || v_line::text || '/' || v_gm::text)
       OR NOT EXISTS (SELECT 1 FROM public.pos_order_items WHERE order_id = v_o AND recipe_id = v_coke
                        AND unit_price = 103.25 AND category = 'Beverage' AND combo_line_id = v_line)
       OR NOT EXISTS (SELECT 1 FROM public.pos_order_items WHERE order_id = v_o AND recipe_id = v_tea
                        AND unit_price = 50 AND combo_line_id IS NULL AND selection_key = '') THEN
      RAISE EXCEPTION 'S839 probe: the combo was not priced 206.49 + 103.25 with its tag, or the tea changed';
    END IF;

    -- Incomplete: the drink dropped, or the two at different quantities.
    v_hint := NULL;
    BEGIN PERFORM public.save_pos_order_items(v_o, jsonb_build_array(
      jsonb_build_object('recipe_id', v_veg, 'qty', 1, 'combo', jsonb_build_object('line_id', v_line, 'combo_id', v_combo, 'group_id', v_gm)),
      jsonb_build_object('recipe_id', v_tea, 'qty', 2)), NULL, NULL);
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT; END;
    IF v_hint IS DISTINCT FROM 'combo_incomplete' THEN RAISE EXCEPTION 'S839 probe: a combo with its drink dropped answered %', COALESCE(v_hint, 'nothing'); END IF;
    v_hint := NULL;
    BEGIN PERFORM public.save_pos_order_items(v_o, jsonb_build_array(
      jsonb_build_object('recipe_id', v_veg, 'qty', 2, 'combo', jsonb_build_object('line_id', v_line, 'combo_id', v_combo, 'group_id', v_gm)),
      jsonb_build_object('recipe_id', v_coke, 'qty', 1, 'combo', jsonb_build_object('line_id', v_line, 'combo_id', v_combo, 'group_id', v_gd))), NULL, NULL);
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT; END;
    IF v_hint IS DISTINCT FROM 'combo_incomplete' THEN RAISE EXCEPTION 'S839 probe: a combo at two quantities answered %', COALESCE(v_hint, 'nothing'); END IF;
    -- A dish that is not one of the pick's.
    v_hint := NULL;
    BEGIN PERFORM public.save_pos_order_items(v_o, jsonb_build_array(
      jsonb_build_object('recipe_id', v_veg, 'qty', 1, 'combo', jsonb_build_object('line_id', v_line, 'combo_id', v_combo, 'group_id', v_gm)),
      jsonb_build_object('recipe_id', v_tea, 'qty', 1, 'combo', jsonb_build_object('line_id', v_line, 'combo_id', v_combo, 'group_id', v_gd))), NULL, NULL);
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT; END;
    IF v_hint IS DISTINCT FROM 'combo_dish_not_offered' THEN RAISE EXCEPTION 'S839 probe: a tea as the combo''s drink answered %', COALESCE(v_hint, 'nothing'); END IF;

    -- A swap: chicken for veg, +50 extra; the drink keeps its price.
    PERFORM public.save_pos_order_items(v_o, jsonb_build_array(
      jsonb_build_object('recipe_id', v_chk, 'qty', 1, 'combo', jsonb_build_object('line_id', v_line, 'combo_id', v_combo, 'group_id', v_gm)),
      jsonb_build_object('recipe_id', v_coke, 'qty', 1, 'combo', jsonb_build_object('line_id', v_line, 'combo_id', v_combo, 'group_id', v_gd)),
      jsonb_build_object('recipe_id', v_tea, 'qty', 2)), NULL, NULL);
    IF NOT EXISTS (SELECT 1 FROM public.pos_order_items WHERE order_id = v_o AND recipe_id = v_chk AND unit_price = 250.73 AND combo_line_id = v_line)
       OR NOT EXISTS (SELECT 1 FROM public.pos_order_items WHERE order_id = v_o AND recipe_id = v_coke AND unit_price = 103.25)
       OR EXISTS (SELECT 1 FROM public.pos_order_items WHERE order_id = v_o AND recipe_id = v_veg) THEN
      RAISE EXCEPTION 'S839 probe: the swap did not price the chicken momo 250.73 and keep the drink';
    END IF;

    -- ── The discount: refused above the tea, and never on the combo in Inventory revenue ──────────
    v_hint := NULL;
    BEGIN UPDATE public.pos_orders SET discount_amount = 150 WHERE id = v_o;
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT; END;
    IF v_hint IS DISTINCT FROM 'discount_on_combo' THEN RAISE EXCEPTION 'S839 probe: a discount above the tea answered %', COALESCE(v_hint, 'nothing'); END IF;
    UPDATE public.pos_orders SET discount_amount = 10 WHERE id = v_o;
    IF (SELECT discount_amount FROM public.pos_orders WHERE id = v_o) IS DISTINCT FROM 10 THEN
      RAISE EXCEPTION 'S839 probe: a discount within the tea was not kept';
    END IF;
    -- pos_bill_sales_rows is the server's own (no client role may run it), so it is read as the
    -- migration's role.
    RESET ROLE;
    IF (SELECT round(s.unit_price, 4) FROM public.pos_bill_sales_rows(ARRAY[v_o]) s WHERE s.recipe_id = v_tea) IS DISTINCT FROM 45.0000
       OR (SELECT s.unit_price FROM public.pos_bill_sales_rows(ARRAY[v_o]) s WHERE s.recipe_id = v_chk) IS DISTINCT FROM 250.73 THEN
      RAISE EXCEPTION 'S839 probe: Inventory revenue did not take the discount off the tea alone';
    END IF;
    SET LOCAL ROLE authenticated;

    -- ── A combo is comped and moved whole ───────────────────────────────────────────────────────
    v_hint := NULL;
    BEGIN PERFORM public.apply_pos_item_comps(v_o, v_client, NULL, 'Other', NULL, NULL, NULL,
      jsonb_build_array(jsonb_build_object('recipe_id', v_chk, 'selection_key', '@' || v_line::text || '/' || v_gm::text)));
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT; END;
    IF v_hint IS DISTINCT FROM 'combo_comp_whole' THEN RAISE EXCEPTION 'S839 probe: comping half a combo answered %', COALESCE(v_hint, 'nothing'); END IF;
    BEGIN
      PERFORM public.apply_pos_item_comps(v_o, v_client, NULL, 'Other', NULL, NULL, NULL,
        jsonb_build_array(jsonb_build_object('recipe_id', v_chk, 'selection_key', '@' || v_line::text || '/' || v_gm::text),
                          jsonb_build_object('recipe_id', v_coke, 'selection_key', '@' || v_line::text || '/' || v_gd::text)));
      IF (SELECT count(*) FROM public.pos_order_items WHERE order_id = v_o AND comped AND combo_line_id = v_line) <> 2 THEN
        RAISE EXCEPTION 'S839 probe: comping the whole combo did not comp both dishes';
      END IF;
      RAISE EXCEPTION 'S839 comp ok';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'S839 comp ok' THEN RAISE; END IF;
    END;
    RESET ROLE;
    v_hint := NULL;
    SELECT id INTO v_veg_line FROM public.pos_order_items WHERE order_id = v_o AND recipe_id = v_chk;
    BEGIN PERFORM public.pos_move_lines(v_o, v_o2, jsonb_build_array(jsonb_build_object('item_id', v_veg_line, 'qty', 1)));
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT; END;
    IF v_hint IS DISTINCT FROM 'combo_move_whole' THEN RAISE EXCEPTION 'S839 probe: moving half a combo answered %', COALESCE(v_hint, 'nothing'); END IF;

    -- ── The guest menu and a guest's combo ──────────────────────────────────────────────────────
    v_r := public.get_guest_menu_options(v_tg);
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'combos') c
                    WHERE (c->>'id')::uuid = v_combo AND jsonb_array_length(c->'groups') = 2
                      AND (c->>'guest_price')::numeric = 350) THEN
      RAISE EXCEPTION 'S839 probe: the guest menu does not list the combo with its two picks';
    END IF;
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    v_req := public.submit_guest_order(v_tg, jsonb_build_array(jsonb_build_object(
               'combo_id', v_combo, 'qty', 1, 'note', 'no chilli',
               'picks', jsonb_build_array(
                 jsonb_build_object('group_id', v_gm, 'recipe_id', v_chk),
                 jsonb_build_object('group_id', v_gd, 'recipe_id', v_coke)))), NULL, 1, NULL);
    PERFORM set_config('request.jwt.claims', '', true);
    SELECT count(*), count(DISTINCT x->'combo'->>'line_id') INTO v_n, v_num
      FROM public.pos_guest_order_requests q, jsonb_array_elements(q.items) x
     WHERE q.id = v_req AND x->'combo'->>'combo_id' = v_combo::text;
    IF v_n <> 2 OR v_num <> 1
       OR NOT EXISTS (SELECT 1 FROM public.pos_guest_order_requests q, jsonb_array_elements(q.items) x
                       WHERE q.id = v_req AND (x->>'recipe_id')::uuid = v_chk AND (x->>'unit_price')::numeric = 250.73
                         AND x->>'note' = 'no chilli' AND x->>'selection_key' LIKE '@%/' || v_gm::text) THEN
      RAISE EXCEPTION 'S839 probe: the guest combo was not stored as two dishes of one combo at 250.73';
    END IF;

    -- ── Deleting the combo leaves the bill's dishes as sold ─────────────────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff)::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.delete_pos_combo(v_combo);
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM public.pos_combos WHERE id = v_combo)
       OR (SELECT count(*) FROM public.pos_order_items WHERE order_id = v_o AND combo_name = 'S839 probe combo') <> 2 THEN
      RAISE EXCEPTION 'S839 probe: deleting the combo did not keep the bill''s dishes as sold';
    END IF;

    RAISE EXCEPTION 'S839 probe ok';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'S839 probe ok' THEN RAISE; END IF;
  END;

  PERFORM set_config('request.jwt.claims', '', true);
  IF EXISTS (SELECT 1 FROM public.pos_combos WHERE name LIKE 'S839 probe%')
     OR EXISTS (SELECT 1 FROM public.recipes WHERE name LIKE 'S839 probe%') THEN
    RAISE EXCEPTION 'S839 probe: its fixtures were not rolled back';
  END IF;
  RAISE NOTICE 'S839 probe: passed and rolled back';
END;
$probe$;


-- ── 13. Read back ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_combos', 'pos_combo_groups', 'pos_combo_items'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'S839: RLS is off on %', t;
    END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT') OR has_table_privilege('anon', 'public.' || t, 'INSERT') THEN
      RAISE EXCEPTION 'S839: anon can reach %', t;
    END IF;
    IF NOT has_table_privilege('authenticated', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'S839: authenticated cannot read %', t;
    END IF;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = t) <> 3 THEN
      RAISE EXCEPTION 'S839: % does not carry its three policies', t;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.save_pos_combo(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.delete_pos_combo(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pos_combo_shares(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S839: a combo function is callable without signing in';
  END IF;
  IF NOT has_function_privilege('anon', 'public.submit_guest_order(uuid,jsonb,text,integer,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.get_guest_menu_options(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S839: the guest functions lost their public grant';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
