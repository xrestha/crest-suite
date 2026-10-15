-- S846: a dish can be marked Egg — egg, but no meat or fish.
--
-- Until now a dish's diet was recipes.is_veg alone (true / false / NULL = not stated), so egg curry
-- could only be "non-veg", while an add-on choice already had 'egg' (pos_options.diet, S758). The
-- guest menu's food mark is now shape-encoded (dot veg, triangle non-veg, E egg) and the owner asked
-- for Egg on whole dishes too.
--
-- The shape of the data is chosen so an old bundle stays SAFE, not just working:
--   * is_veg keeps its meaning and every reader of it keeps working unchanged. An Egg dish is
--     is_veg = false, so the "Vegetarian dishes only" filter, the Sales Report axis and any tablet
--     still on an older bundle all read it as non-veg — the side a vegetarian guest should err on.
--   * is_egg only counts where is_veg IS FALSE. One read rule, written once in the app
--     (dietOfDish in DietMark.jsx): veg if is_veg; egg if NOT is_veg AND is_egg; non-veg if NOT
--     is_veg; otherwise not stated. A stale is_egg left on a dish an old bundle re-marked Veg is
--     therefore harmless, which is why there is no CHECK and no normalising trigger here: a CHECK
--     would make that old bundle's save fail.
--
-- The till never names this column in its menu query (pos-billing.md, the S760 rule), so a till
-- running against a database without it still loads its menu. The two guest functions below do
-- name it, which is why this file must be applied before the frontend that reads it deploys —
-- although that frontend treats a missing is_egg as false, so the order only decides when the E
-- mark first appears, never whether the menu loads.
--
-- Reversal: DROP COLUMN recipes.is_egg after restoring get_guest_menu from
-- 20261009140000_pos_guest_and_booking_outlet_state_s809.sql (DROP + CREATE + the grants below)
-- and get_guest_menu_options from 20261014160000_pos_combos_s839.sql (CREATE OR REPLACE).

-- ── 1. The column ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.recipes ADD COLUMN IF NOT EXISTS is_egg boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.recipes.is_egg IS
  'S846: an egg dish (egg, but no meat or fish). Counts only where is_veg IS FALSE: veg if is_veg; egg if NOT is_veg AND is_egg; non-veg if NOT is_veg; not stated if is_veg IS NULL. One read rule, dietOfDish() in src/modules/pos/guestmenu/DietMark.jsx.';


-- ── 2. get_guest_menu returns is_egg ──────────────────────────────────────────────────────────
-- A new RETURNS TABLE column cannot go through CREATE OR REPLACE (42P13), so this is DROP + CREATE.
-- Built from the LIVE body (supabase-sql.md: rebuild from pg_get_functiondef, so an out-of-band
-- change is not silently reverted), with each edit asserted to land exactly once. The drop, the
-- create, the grants and the comment are one DO block, so a failure anywhere leaves the old
-- function in place rather than a guest menu with no function at all.
DO $mig$
DECLARE
  v_def      text := pg_get_functiondef('public.get_guest_menu(uuid)'::regprocedure);
  v_comment  text := obj_description('public.get_guest_menu(uuid)'::regprocedure, 'pg_proc');
  v_new      text;
  v_anon     boolean := has_function_privilege('anon', 'public.get_guest_menu(uuid)', 'EXECUTE');
  v_auth     boolean := has_function_privilege('authenticated', 'public.get_guest_menu(uuid)', 'EXECUTE');
  v_service  boolean := has_function_privilege('service_role', 'public.get_guest_menu(uuid)', 'EXECUTE');
  -- Each pair: what the live body says, and what it becomes. Every one must occur exactly once.
  v_from     text[] := ARRAY[
    'is_veg boolean, nutrition_enabled boolean',
    'rc.image_url, rc.is_veg',
    'is_veg := r.is_veg;'
  ];
  v_to       text[] := ARRAY[
    'is_veg boolean, is_egg boolean, nutrition_enabled boolean',
    'rc.image_url, rc.is_veg, rc.is_egg',
    'is_veg := r.is_veg;' || chr(10) || '    is_egg := COALESCE(r.is_egg, false);'
  ];
  i          int;
  v_hits     int;
BEGIN
  IF position('is_egg' IN v_def) > 0 THEN
    RAISE NOTICE 'get_guest_menu already returns is_egg; left as it is';
    RETURN;
  END IF;
  -- The guest menu is anonymous by design. If the live grants are not what S767 set, stop rather
  -- than re-grant something different.
  IF NOT (v_anon AND v_auth AND v_service) THEN
    RAISE EXCEPTION 'get_guest_menu grants are not the expected anon+authenticated+service_role (anon %, authenticated %, service_role %)',
      v_anon, v_auth, v_service;
  END IF;

  v_new := v_def;
  FOR i IN 1 .. array_length(v_from, 1) LOOP
    v_hits := (length(v_new) - length(replace(v_new, v_from[i], ''))) / length(v_from[i]);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'get_guest_menu live body: expected exactly one "%", found %', v_from[i], v_hits;
    END IF;
    v_new := replace(v_new, v_from[i], v_to[i]);
  END LOOP;

  DROP FUNCTION public.get_guest_menu(uuid);
  EXECUTE v_new;
  REVOKE ALL ON FUNCTION public.get_guest_menu(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.get_guest_menu(uuid) TO anon, authenticated, service_role;
  IF v_comment IS NOT NULL THEN
    EXECUTE format('COMMENT ON FUNCTION public.get_guest_menu(uuid) IS %L', v_comment);
  END IF;
END
$mig$;


-- ── 3. get_guest_menu_options: a combo's dishes carry is_egg too ──────────────────────────────
-- RETURNS jsonb, so CREATE OR REPLACE keeps its grants. Same live-body patch, asserted once.
DO $mig$
DECLARE
  v_def   text := pg_get_functiondef('public.get_guest_menu_options(uuid)'::regprocedure);
  v_from  text := '''is_veg'', rc.is_veg,';
  v_to    text := '''is_veg'', rc.is_veg, ''is_egg'', rc.is_egg,';
  v_hits  int;
BEGIN
  IF position('is_egg' IN v_def) > 0 THEN
    RAISE NOTICE 'get_guest_menu_options already returns is_egg; left as it is';
    RETURN;
  END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'get_guest_menu_options live body: expected exactly one "%", found %', v_from, v_hits;
  END IF;
  EXECUTE replace(v_def, v_from, v_to);
END
$mig$;


-- ── 4. Proof, inside the migration ────────────────────────────────────────────────────────────
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'recipes' AND column_name = 'is_egg'
                    AND data_type = 'boolean' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'recipes.is_egg is missing or not boolean NOT NULL';
  END IF;
  -- Assert on catalog values, not a formatted string (supabase-sql.md, S630).
  IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proargnames) AS a(n)
                  WHERE p.oid = 'public.get_guest_menu(uuid)'::regprocedure AND a.n = 'is_egg') THEN
    RAISE EXCEPTION 'get_guest_menu does not return is_egg';
  END IF;
  IF NOT has_function_privilege('anon', 'public.get_guest_menu(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_guest_menu(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_guest_menu(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_guest_menu lost an EXECUTE grant';
  END IF;
  IF position('''is_egg'', rc.is_egg' IN pg_get_functiondef('public.get_guest_menu_options(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'get_guest_menu_options does not return is_egg';
  END IF;
END
$mig$;

NOTIFY pgrst, 'reload schema';
