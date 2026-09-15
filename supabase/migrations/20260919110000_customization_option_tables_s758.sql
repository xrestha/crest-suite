-- S758 stage 3: Crest Customization — the menu side. Four tables:
--
--   pos_option_groups         "Size", "Extras", "Spice" — shared across dishes, min/max picks
--   pos_options               "Half", "Extra cheese +50", "No onion" — the options inside a group
--   pos_option_ingredients    what an option adds to (or takes off) a plate, when IMS is on
--   pos_recipe_option_groups  which groups a dish offers — attaching a group is what makes a
--                             dish customizable; a dish with none behaves exactly as before
--
-- Nothing here touches an order yet (stage 4). Rules, each enforced in the database:
--
--   * Same client all the way down. Child rows carry client_id and a COMPOSITE foreign key to
--     their parent's (id, client_id), so an option cannot sit in another client's group. The
--     references to recipes and items are checked in the guard trigger (those tables carry no
--     (id, client_id) key, and adding one to recipes/items is not worth it for this).
--   * Who may edit: admin, the Owner, a POS manager or an IMS manager — caller_can_set_menu_price(),
--     the same set that may change a menu price, reused verbatim. Anyone else of the client may
--     READ (the till reads these tables under a POS PIN login), never write.
--   * Editing needs the module live (customization_live) — except admin, who may prepare a
--     client's groups before switching the module on.
--   * RLS mirrors `recipes` exactly, read from pg_policies on 2026-09-15: the standard same-client
--     policy plus RESTRICTIVE no_self_service_accounts and no_hr_role_staff. NOT no_pos_pin_staff
--     (the till reads these), NOT no_ims_staff (IMS managers edit them).
--   * A size group is pick-exactly-one. "First N included" (included_count) cannot exceed what a
--     group lets you pick.
--
-- References to items / recipes (sub_recipe_id) are plain FKs, i.e. they REFUSE a delete of an
-- item or sub-recipe an option still uses. That is the safe direction; wording that refusal on
-- Item Master / Recipe Costing is a follow-up recorded in POS_TODO.md.

-- ── pos_option_groups ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pos_option_groups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (btrim(name) <> ''),
  kitchen_name   text,
  kind           text NOT NULL DEFAULT 'addon' CHECK (kind IN ('size', 'addon', 'choice')),
  min_select     integer NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select     integer CHECK (max_select IS NULL OR max_select >= 1),
  included_count integer NOT NULL DEFAULT 0 CHECK (included_count >= 0),
  sort           integer NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_option_groups_id_client_key UNIQUE (id, client_id),
  CONSTRAINT pos_option_groups_min_le_max CHECK (max_select IS NULL OR min_select <= max_select),
  CONSTRAINT pos_option_groups_size_exactly_one CHECK (kind <> 'size' OR (min_select = 1 AND max_select = 1)),
  CONSTRAINT pos_option_groups_included_le_max CHECK (max_select IS NULL OR included_count <= max_select)
);
CREATE UNIQUE INDEX IF NOT EXISTS pos_option_groups_client_name_key
  ON public.pos_option_groups (client_id, lower(btrim(name)));

-- ── pos_options ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pos_options (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL,
  group_id     uuid NOT NULL,
  name         text NOT NULL CHECK (btrim(name) <> ''),
  kitchen_name text,
  -- ex-VAT, the recipes.selling_price convention; inherits the dish's VAT rate. May be negative
  -- (a Half plate is cheaper than the dish's own price).
  price_delta  numeric(12,2) NOT NULL DEFAULT 0,
  is_removal   boolean NOT NULL DEFAULT false,
  is_default   boolean NOT NULL DEFAULT false,
  -- NULL = not stated. 'veg' | 'egg' | 'non_veg' — what the option adds to the plate.
  diet         text CHECK (diet IS NULL OR diet IN ('veg', 'egg', 'non_veg')),
  -- the same free-text tag list recipes' nutrition rollup carries: ["dairy","gluten"]
  allergens    jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allergens) = 'array'),
  sort         integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_options_id_client_key UNIQUE (id, client_id),
  CONSTRAINT pos_options_group_fkey FOREIGN KEY (group_id, client_id)
    REFERENCES public.pos_option_groups (id, client_id) ON DELETE CASCADE,
  CONSTRAINT pos_options_removal_is_free CHECK (NOT is_removal OR price_delta = 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS pos_options_group_name_key
  ON public.pos_options (group_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS pos_options_group_id_idx ON public.pos_options (group_id);
CREATE INDEX IF NOT EXISTS pos_options_client_id_idx ON public.pos_options (client_id);

-- ── pos_option_ingredients ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pos_option_ingredients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL,
  option_id       uuid NOT NULL,
  item_id         uuid REFERENCES public.items(id),
  sub_recipe_id   uuid REFERENCES public.recipes(id),
  -- per ONE plate, in the item's base unit (or sub-recipe yield unit); negative takes it off
  qty_per_portion numeric NOT NULL CHECK (qty_per_portion <> 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_option_ingredients_option_fkey FOREIGN KEY (option_id, client_id)
    REFERENCES public.pos_options (id, client_id) ON DELETE CASCADE,
  CONSTRAINT pos_option_ingredients_one_source CHECK ((item_id IS NULL) <> (sub_recipe_id IS NULL))
);
CREATE INDEX IF NOT EXISTS pos_option_ingredients_option_id_idx ON public.pos_option_ingredients (option_id);
CREATE INDEX IF NOT EXISTS pos_option_ingredients_client_id_idx ON public.pos_option_ingredients (client_id);
CREATE INDEX IF NOT EXISTS pos_option_ingredients_item_id_idx ON public.pos_option_ingredients (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pos_option_ingredients_sub_recipe_id_idx ON public.pos_option_ingredients (sub_recipe_id) WHERE sub_recipe_id IS NOT NULL;

-- ── pos_recipe_option_groups ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pos_recipe_option_groups (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL,
  recipe_id         uuid NOT NULL REFERENCES public.recipes(id) ON DELETE CASCADE,
  group_id          uuid NOT NULL,
  -- per-dish min/max picks; NULL = use the group's own
  min_override      integer CHECK (min_override IS NULL OR min_override >= 0),
  max_override      integer CHECK (max_override IS NULL OR max_override >= 1),
  default_option_id uuid REFERENCES public.pos_options(id) ON DELETE SET NULL,
  sort              integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_recipe_option_groups_group_fkey FOREIGN KEY (group_id, client_id)
    REFERENCES public.pos_option_groups (id, client_id) ON DELETE CASCADE,
  CONSTRAINT pos_recipe_option_groups_recipe_group_key UNIQUE (recipe_id, group_id),
  CONSTRAINT pos_recipe_option_groups_min_le_max CHECK (
    min_override IS NULL OR max_override IS NULL OR min_override <= max_override)
);
CREATE INDEX IF NOT EXISTS pos_recipe_option_groups_group_id_idx ON public.pos_recipe_option_groups (group_id);
CREATE INDEX IF NOT EXISTS pos_recipe_option_groups_client_id_idx ON public.pos_recipe_option_groups (client_id);

-- ── The guard: rank, module, and same-client references ───────────────────────────────────────
-- SECURITY INVOKER on the current_user seam (guard_profiles_privileged_columns' shape): a DEFINER
-- body, the service role and an FK cascade (which runs as the table owner — deleting a recipe
-- cascades into pos_recipe_option_groups) all pass the RANK check. The same-client REFERENCE
-- checks are a data invariant and run for every role on INSERT/UPDATE.
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
  END IF;

  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_pos_option_edit() FROM PUBLIC;

DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_option_groups', 'pos_options', 'pos_option_ingredients', 'pos_recipe_option_groups']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_guard', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.guard_pos_option_edit()', t || '_guard', t);

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated
         USING ((select public.is_admin()) OR client_id = (select public.my_client_id()))
         WITH CHECK ((select public.is_admin()) OR client_id = (select public.my_client_id()))',
      t || '_all', t);
    EXECUTE format('DROP POLICY IF EXISTS no_self_service_accounts ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY no_self_service_accounts ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
         USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service())', t);
    EXECUTE format('DROP POLICY IF EXISTS no_hr_role_staff ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY no_hr_role_staff ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
         USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff())', t);

    EXECUTE format('REVOKE ALL ON public.%I FROM anon, PUBLIC', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END
$do$;

NOTIFY pgrst, 'reload schema';

-- ── Verification, rolled back ─────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  BEGIN
    DECLARE
      v_c1 uuid; v_c2 uuid; v_r1 uuid; v_r2 uuid; v_i1 uuid; v_i2 uuid;
      v_g uuid; v_g2 uuid; v_o uuid; v_o2 uuid; v_hint text; v_n int;
    BEGIN
      INSERT INTO public.clients (name, pos_enabled, customization_enabled) VALUES ('__s758b_1', true, true) RETURNING id INTO v_c1;
      INSERT INTO public.clients (name, pos_enabled, customization_enabled) VALUES ('__s758b_2', true, true) RETURNING id INTO v_c2;
      INSERT INTO public.recipes (client_id, name) VALUES (v_c1, '__momo') RETURNING id INTO v_r1;
      INSERT INTO public.recipes (client_id, name) VALUES (v_c2, '__momo2') RETURNING id INTO v_r2;
      INSERT INTO public.items (client_id, name, uom, rate, purchase_qty) VALUES (v_c1, '__cheese', 'GM', 1, 1) RETURNING id INTO v_i1;
      INSERT INTO public.items (client_id, name, uom, rate, purchase_qty) VALUES (v_c2, '__cheese2', 'GM', 1, 1) RETURNING id INTO v_i2;

      INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select) VALUES (v_c1, 'Extras', 'addon', 0, 3) RETURNING id INTO v_g;
      INSERT INTO public.pos_options (client_id, group_id, name, price_delta) VALUES (v_c1, v_g, 'Extra cheese', 50) RETURNING id INTO v_o;
      INSERT INTO public.pos_option_ingredients (client_id, option_id, item_id, qty_per_portion) VALUES (v_c1, v_o, v_i1, 30);
      INSERT INTO public.pos_recipe_option_groups (client_id, recipe_id, group_id, default_option_id) VALUES (v_c1, v_r1, v_g, v_o);

      -- (a) a size group must be pick-exactly-one
      BEGIN
        INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select) VALUES (v_c1, 'Size', 'size', 0, 2);
        RAISE EXCEPTION 'S758b verify: size group with 0..2 was NOT refused';
      EXCEPTION WHEN check_violation THEN NULL;
      END;
      -- (b) an option cannot sit in another client's group (composite FK)
      BEGIN
        INSERT INTO public.pos_options (client_id, group_id, name) VALUES (v_c2, v_g, 'Leak');
        RAISE EXCEPTION 'S758b verify: cross-client option was NOT refused';
      EXCEPTION WHEN foreign_key_violation THEN NULL;
      END;
      -- (c) an option ingredient cannot point at another client's item
      BEGIN
        INSERT INTO public.pos_option_ingredients (client_id, option_id, item_id, qty_per_portion) VALUES (v_c1, v_o, v_i2, 10);
        RAISE EXCEPTION 'S758b verify: cross-client ingredient was NOT refused';
      EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        IF v_hint IS DISTINCT FROM 'option_ingredient_foreign' THEN RAISE EXCEPTION 'S758b verify: wrong hint %', v_hint; END IF;
      END;
      -- (d) a group cannot be attached to another client's dish
      BEGIN
        INSERT INTO public.pos_recipe_option_groups (client_id, recipe_id, group_id) VALUES (v_c1, v_r2, v_g);
        RAISE EXCEPTION 'S758b verify: cross-client attach was NOT refused';
      EXCEPTION WHEN check_violation THEN NULL;
      END;
      -- (e) the default option must be in the attached group
      INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select) VALUES (v_c1, 'Size', 'size', 1, 1) RETURNING id INTO v_g2;
      INSERT INTO public.pos_options (client_id, group_id, name, price_delta) VALUES (v_c1, v_g2, 'Half', -100) RETURNING id INTO v_o2;
      BEGIN
        INSERT INTO public.pos_recipe_option_groups (client_id, recipe_id, group_id, default_option_id) VALUES (v_c1, v_r1, v_g2, v_o);
        RAISE EXCEPTION 'S758b verify: default option from another group was NOT refused';
      EXCEPTION WHEN check_violation THEN NULL;
      END;
      -- (f) a removal option carries no price
      BEGIN
        INSERT INTO public.pos_options (client_id, group_id, name, price_delta, is_removal) VALUES (v_c1, v_g, 'No onion', 10, true);
        RAISE EXCEPTION 'S758b verify: priced removal was NOT refused';
      EXCEPTION WHEN check_violation THEN NULL;
      END;
      -- (g) deleting the dish detaches the group; deleting a group takes its options and ingredients
      DELETE FROM public.pos_recipe_option_groups WHERE recipe_id = v_r1;
      DELETE FROM public.pos_option_groups WHERE id = v_g;
      SELECT count(*) INTO v_n FROM public.pos_option_ingredients WHERE option_id = v_o;
      IF v_n <> 0 THEN RAISE EXCEPTION 'S758b verify: option ingredients survived their group'; END IF;
      -- (h) grants: anon holds nothing on any of the four
      IF has_table_privilege('anon', 'public.pos_options', 'SELECT')
         OR has_table_privilege('anon', 'public.pos_option_groups', 'SELECT')
         OR has_table_privilege('anon', 'public.pos_option_ingredients', 'SELECT')
         OR has_table_privilege('anon', 'public.pos_recipe_option_groups', 'SELECT') THEN
        RAISE EXCEPTION 'S758b verify: anon can read an option table';
      END IF;
      -- (i) the rank guard refuses a signed-in caller who is not a manager (profile-less JWT)
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid()::text, 'role', 'authenticated')::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        INSERT INTO public.pos_option_groups (client_id, name) VALUES (v_c1, 'Sneaky');
        RAISE EXCEPTION 'S758b verify: non-manager insert was NOT refused';
      EXCEPTION
        WHEN insufficient_privilege THEN
          GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
          -- a missing role membership also lands here; only a wrong HINT from the trigger fails the check
          IF v_hint IS NOT NULL AND v_hint <> 'option_edit_rank' THEN
            RAISE EXCEPTION 'S758b verify: rank refusal had hint %', v_hint;
          END IF;
      END;

      RAISE EXCEPTION 's758b_rollback' USING ERRCODE = 'P0758';
    END;
  EXCEPTION WHEN SQLSTATE 'P0758' THEN
    NULL;
  END;
END
$do$;
