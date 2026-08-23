-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- get_guest_menu: return the client's VAT-registration flag
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The guest menu prints `selling_price * (1 + vat_rate)` for every dish and calls the sum "Total".
-- The till does not: `computeOrderAmounts(order, items, vatReg)` in `src/utils/posBillingMath.js`
-- multiplies by vat_rate ONLY when `settings.is_vat_registered` is true, and prints "BILL" rather
-- than "TAX INVOICE" when it is false.
--
-- `get_guest_menu` never returned that flag, so the guest page had no way to make the same
-- decision and applied VAT unconditionally. For a client that is not VAT-registered — which is
-- most of the small end of this market, and the column defaults to true so nobody notices until
-- they change it — every price on the public menu read about 13% ABOVE what the restaurant then
-- billed. A menu that overstates its own prices is worse than one that understates them: the
-- guest either decides against a dish on a price the restaurant never charges, or arrives at the
-- till expecting a number that does not match the bill.
--
-- The return type changes, so this is DROP + CREATE rather than CREATE OR REPLACE — Postgres
-- refuses to change a function's OUT columns in place (42P13). Everything below the new
-- `is_vat_registered` line is byte-identical to 20260707220000_guest_ordering_pro_autounlock.sql.
--
-- NOTE: `settings` is the one client-scoped table with a NULLABLE client_id (there is a global
-- defaults row). The lookup is therefore an explicit `WHERE s.client_id = v_client_id`, and a
-- client with no settings row at all falls back to TRUE — the same default the column itself
-- carries and the same `?? true` every JS caller uses, so this can only ever restore today's
-- behaviour, never silently drop VAT off a registered client's menu.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

DROP FUNCTION IF EXISTS public.get_guest_menu(uuid);

CREATE FUNCTION public.get_guest_menu(p_table_id uuid) RETURNS TABLE(
    outlet_name text, table_name text,
    recipe_id uuid, name text, category text, selling_price numeric, vat_rate numeric,
    description text, image_url text, is_veg boolean,
    nutrition_enabled boolean, has_nutrition boolean,
    energy_kcal numeric, protein_g numeric, carbs_g numeric, fat_g numeric, sugar_g numeric, sodium_mg numeric,
    allergens jsonb, guest_ordering_enabled boolean,
    is_vat_registered boolean
) LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_client_id uuid;
  v_table_name text;
  v_outlet_name text;
  v_pos_enabled boolean;
  v_pos_plan text;
  v_nutrition_enabled boolean;
  v_guest_ordering_flag boolean;
  v_guest_ordering_enabled boolean;
  v_vat_registered boolean;
  r RECORD;
  roll jsonb;
BEGIN
  SELECT t.client_id, t.name INTO v_client_id, v_table_name FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN RETURN; END IF;

  SELECT c.name, c.pos_enabled, c.pos_plan INTO v_outlet_name, v_pos_enabled, v_pos_plan FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RETURN; END IF;

  SELECT COALESCE(f.nutrition_facts, false), COALESCE(f.guest_ordering, false)
    INTO v_nutrition_enabled, v_guest_ordering_flag
  FROM feature_flags f WHERE f.client_id = v_client_id;

  -- Fails OPEN to true: no settings row means the client has never been configured either way,
  -- and true is what the column defaults to and what every JS caller assumes.
  SELECT COALESCE(s.is_vat_registered, true) INTO v_vat_registered
  FROM settings s WHERE s.client_id = v_client_id;
  v_vat_registered := COALESCE(v_vat_registered, true);

  v_guest_ordering_enabled := v_guest_ordering_flag OR (v_pos_plan = 'pro');

  FOR r IN
    SELECT rc.id, rc.name, rc.category, rc.selling_price, rc.vat_rate, rc.description, rc.image_url, rc.is_veg
    FROM recipes rc
    WHERE rc.client_id = v_client_id AND rc.is_active = true AND rc.pos_enabled = true
      AND rc.category IS DISTINCT FROM 'Sub-Recipe'
    ORDER BY rc.category NULLS LAST, rc.name
  LOOP
    IF v_nutrition_enabled THEN
      roll := public._nutrition_rollup(r.id);
    ELSE
      roll := NULL;
    END IF;

    outlet_name := v_outlet_name;
    table_name := v_table_name;
    recipe_id := r.id;
    name := r.name;
    category := r.category;
    selling_price := r.selling_price;
    vat_rate := r.vat_rate;
    description := r.description;
    image_url := r.image_url;
    is_veg := r.is_veg;
    nutrition_enabled := v_nutrition_enabled;
    has_nutrition := v_nutrition_enabled AND COALESCE((roll->>'covered')::boolean, false);
    energy_kcal := (roll->>'energy_kcal')::numeric;
    protein_g := (roll->>'protein_g')::numeric;
    carbs_g := (roll->>'carbs_g')::numeric;
    fat_g := (roll->>'fat_g')::numeric;
    sugar_g := (roll->>'sugar_g')::numeric;
    sodium_mg := (roll->>'sodium_mg')::numeric;
    allergens := COALESCE(roll->'allergens', '[]'::jsonb);
    guest_ordering_enabled := v_guest_ordering_enabled;
    is_vat_registered := v_vat_registered;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- A dropped function loses its grants. This one is deliberately reachable by `anon` — it IS the
-- public QR-menu surface, and 20260810190000 lists it under "deliberately NOT touched" for that
-- reason. Stated explicitly here rather than left to the default PUBLIC grant, so the next person
-- to re-create it does not have to work out whether the omission was intentional.
GRANT EXECUTE ON FUNCTION public.get_guest_menu(uuid) TO anon, authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ── Verify — run these AFTER the statements above, in the same SQL Editor session ────────────
-- "Success. No rows returned" from a DROP/CREATE/GRANT batch is not evidence of anything. These
-- three are. Query 2 is the one that matters most operationally: DROP FUNCTION discards grants,
-- and `anon` is the role a guest's phone calls as, so getting it wrong kills every QR menu in
-- production silently. Query 3 runs as the editor's role, not anon, so it checks the arithmetic
-- rather than the authorization — the two queries cover different halves.
--
--   -- 1. Does the function now RETURN the flag? Expect exactly ONE row, has_flag = true.
--   --    Two rows means an old overload survived and PostgREST may resolve to the wrong one.
--   SELECT p.proname,
--          pg_get_function_result(p.oid) LIKE '%is_vat_registered%' AS has_flag
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'get_guest_menu';
--
--   -- 2. Can anon still execute it? Both must be true.
--   SELECT has_function_privilege('anon',          'public.get_guest_menu(uuid)', 'EXECUTE') AS anon_ok,
--          has_function_privilege('authenticated', 'public.get_guest_menu(uuid)', 'EXECUTE') AS auth_ok;
--
--   -- 3. Does the value MATCH settings, per client? `agree` must be true on every row.
--   --    settings_says NULL with rpc_says true is CORRECT — that is the documented fail-open
--   --    (no settings row falls back to the column default), not a mismatch.
--   SELECT c.name                  AS outlet,
--          s.is_vat_registered     AS settings_says,
--          g.is_vat_registered     AS rpc_says,
--          s.is_vat_registered IS NOT DISTINCT FROM g.is_vat_registered AS agree
--   FROM   clients c
--   JOIN   LATERAL (SELECT t.id FROM pos_tables t
--                   WHERE t.client_id = c.id ORDER BY t.sort_order LIMIT 1) t ON true
--   LEFT   JOIN settings s ON s.client_id = c.id
--   CROSS  JOIN LATERAL (SELECT * FROM public.get_guest_menu(t.id) LIMIT 1) g
--   WHERE  c.pos_enabled
--   ORDER  BY c.name;
