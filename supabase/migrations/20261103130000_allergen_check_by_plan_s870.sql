-- S870, second file: the guest menu's allergen completeness follows the PLAN, like the app.
--
-- 20261103120000 set get_guest_menu.allergens_complete only where feature_flags.nutrition_facts is
-- true, the gate the guest menu has used for nutrition since S288. The app does not decide that way:
-- planHasFeature() (src/context/AuthContext.js) counts nutrition_facts as on for a Growth or Pro plan
-- OR an explicit flag, and false in feature_flags revokes nothing. Read live after the first file,
-- every client was Growth or Pro with the flag off or missing, so the "ask staff" warning reached
-- nobody, while each of them could tick allergens in Recipe Costing and Item Master.
--
-- Owner decision (S870): the warning follows the plan. The nutrient FIGURES on the guest menu keep
-- the flag-only gate (v_nutrition_enabled, unchanged), so no guest menu starts showing calories.
--
--   _guest_allergen_check_on(client): flag true, or clients.plan growth/pro. The nutrition_facts line
--   of planHasFeature: GROWTH_KEYS holds nutrition_facts, so Growth and Pro unlock it.
--   get_guest_menu: allergens_complete is set where that is true (CREATE OR REPLACE from the live
--   body: the return columns do not change, so the grants stay).
--   _guest_dish_allergens: the same rule for a combo's dishes.
--
-- Reversal: put `CASE WHEN v_nutrition_enabled THEN` back in get_guest_menu's allergens_complete
-- line, restore _guest_dish_allergens from 20261103120000, DROP FUNCTION _guest_allergen_check_on.

-- ── 1. The rule, once ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._guest_allergen_check_on(p_client_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path = public
    AS $$
  SELECT COALESCE((SELECT f.nutrition_facts FROM feature_flags f WHERE f.client_id = p_client_id), false)
      OR COALESCE((SELECT c.plan IN ('growth', 'pro') FROM clients c WHERE c.id = p_client_id), false)
$$;
-- Called only from inside the SECURITY DEFINER guest functions, which run it as the owner.
REVOKE ALL ON FUNCTION public._guest_allergen_check_on(uuid) FROM PUBLIC;

-- ── 2. A combo's dishes ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._guest_dish_allergens(p_recipe_id uuid, p_client_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path = public
    AS $$
  SELECT jsonb_build_object(
    'allergens', COALESCE(r.roll->'allergens', '[]'::jsonb),
    'allergens_complete', CASE WHEN public._guest_allergen_check_on(p_client_id)
                               THEN COALESCE((r.roll->>'allergens_complete')::boolean, false) END)
  FROM (SELECT public._nutrition_rollup(p_recipe_id) AS roll) r
$$;

-- ── 3. The menu's dishes, from the live body ───────────────────────────────────────────────────
DO $mig$
DECLARE
  v_def   text := pg_get_functiondef('public.get_guest_menu(uuid)'::regprocedure);
  v_from  text[] := ARRAY[
    '-- S870: only where Nutrition is on; NULL elsewhere, so that guest menu is unchanged.',
    'allergens_complete := CASE WHEN v_nutrition_enabled THEN'
  ];
  v_to    text[] := ARRAY[
    '-- S870: by plan (Growth or Pro) or the nutrition switch, like planHasFeature; NULL elsewhere.',
    'allergens_complete := CASE WHEN public._guest_allergen_check_on(v_client_id) THEN'
  ];
  i       int;
  v_hits  int;
BEGIN
  IF position('_guest_allergen_check_on' IN v_def) > 0 THEN
    RAISE NOTICE 'get_guest_menu already judges allergens by plan; left as it is';
    RETURN;
  END IF;
  FOR i IN 1 .. array_length(v_from, 1) LOOP
    v_hits := (length(v_def) - length(replace(v_def, v_from[i], ''))) / length(v_from[i]);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'get_guest_menu live body: expected exactly one "%", found %', v_from[i], v_hits;
    END IF;
    v_def := replace(v_def, v_from[i], v_to[i]);
  END LOOP;
  EXECUTE v_def;
END
$mig$;

-- ── 4. Proof ───────────────────────────────────────────────────────────────────────────────────
DO $mig$
DECLARE
  v_cand   record;
  v_table  uuid;
  v_client uuid;
  v_rows   bigint;
  v_judged bigint;
  v_kcal   bigint;
  v_flag   boolean;
BEGIN
  IF COALESCE(public._guest_allergen_check_on('00000000-0000-0000-0000-000000000000'::uuid), true) THEN
    RAISE EXCEPTION 'proof failed: an unknown client reads as allergen-checked';
  END IF;
  IF position('_guest_allergen_check_on' IN pg_get_functiondef('public.get_guest_menu(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'get_guest_menu does not call _guest_allergen_check_on';
  END IF;
  IF NOT has_function_privilege('anon', 'public.get_guest_menu(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._guest_allergen_check_on(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'grants are not as intended';
  END IF;

  -- A Growth or Pro client whose guest menu actually serves dishes: every dish judged, and the
  -- nutrient figures still follow the flag alone. Chosen by calling the menu, because a locked
  -- account (client_access_open) serves an empty one by design; a first draft picked such a client
  -- by its recipes and failed its own proof on the empty menu.
  FOR v_cand IN
    SELECT t.id, t.client_id
      FROM public.pos_tables t JOIN public.clients c ON c.id = t.client_id
     WHERE COALESCE(c.pos_enabled, false) AND c.plan IN ('growth', 'pro')
     ORDER BY t.client_id, t.id
  LOOP
    IF EXISTS (SELECT 1 FROM public.get_guest_menu(v_cand.id)) THEN
      v_table := v_cand.id;
      v_client := v_cand.client_id;
      EXIT;
    END IF;
  END LOOP;
  IF v_table IS NOT NULL THEN
    SELECT COALESCE(f.nutrition_facts, false) INTO v_flag FROM public.clients c LEFT JOIN public.feature_flags f ON f.client_id = c.id WHERE c.id = v_client;
    SELECT count(*), count(*) FILTER (WHERE m.allergens_complete IS NOT NULL), count(*) FILTER (WHERE m.energy_kcal IS NOT NULL)
      INTO v_rows, v_judged, v_kcal
      FROM public.get_guest_menu(v_table) m;
    IF v_rows = 0 OR v_judged <> v_rows THEN
      RAISE EXCEPTION 'proof failed: a Growth/Pro menu has % dishes, % judged for allergens', v_rows, v_judged;
    END IF;
    IF NOT COALESCE(v_flag, false) AND v_kcal > 0 THEN
      RAISE EXCEPTION 'proof failed: % dishes show nutrient figures without the nutrition flag', v_kcal;
    END IF;
    PERFORM public.get_guest_menu_options(v_table);
    RAISE NOTICE 'get_guest_menu on table %: % dishes, all judged for allergens, % with figures', v_table, v_rows, v_kcal;
  ELSE
    RAISE NOTICE 'no Growth/Pro POS client with an open guest menu; menu proof skipped';
  END IF;
END
$mig$;
