-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S829, POS stage 5, slice 5e (part 1 of 2): a settled manager loses the settings screen at once,
-- and asking for your own outlet by its id is the same reset as asking for home.
--
--   settings_guard_staff_roles (S809.4, 1j). A leaver's login is marked settlement_blocked_by at
--   Final Settlement, and the token it already holds lives up to an hour. 1j made the POS lines
--   refuse it (pos_caller_has_rank); the HR, IMS, travel-claim and weather-city lines still tested
--   the raw rank, so a settled HR or IMS manager could change those settings for that hour. Now:
--     * the HR role list and travel-claim settings: hr_role = 'manager' and not settlement-blocked,
--       written inline, because no HR effective-rank helper exists (hr_is_manager_rank() is raw and
--       is shared with hss-suite; the same hour on the other HR pages is its own job, owner
--       2026-10-13);
--     * the IMS role list, thresholds, code prefixes and count fences: ims_caller_has_rank('manager'),
--       which also refuses a count PIN (ims_email). The thresholds and fences refused one already;
--       the IMS role list did not, and now does;
--     * the weather city: pos_caller_has_rank('manager') or ims_caller_has_rank('manager') or the HR
--       test above. A POS-blocked manager (pos_blocked_at) is refused here too, as by every POS rule.
--   Live 2026-10-13: no login is settlement-blocked, so nobody loses anything today.
--
--   set_active_outlet (S809.4, 1g). Outlet Access stores no row for a login's home outlet, so an
--   allowlisted non-Owner who picked home by its id in the top-bar switcher was refused "you do not
--   have access to that outlet". Asking for your home outlet by id is now the reset for every login,
--   storing NULL as the reset by NULL does: every reader treats NULL and home alike (my_client_id()
--   is coalesce(active_client_id, client_id)). It moves ahead of the till PIN branch, which already
--   did exactly this for a PIN login. Live 2026-10-13: profile_outlet_access has no rows.
--
-- Built on the live bodies, md5(prosrc), read 2026-10-13: settings_guard_staff_roles
-- 07adf2e7ab384cdca54fdc54b89853e5 and set_active_outlet 9371e7d44ab87052fe8bb980b9931b28. Section 0
-- refuses any other body. Signatures, return types, SECURITY (INVOKER / DEFINER) and search_path are
-- unchanged, so CREATE OR REPLACE keeps the trigger attached and the grants as they are. No RPC
-- changes shape, so no schema reload. No app change and no till build floor change.
--
-- Part 2 (20261013150100) drops the shared tablet key's three client_secrets columns, after the
-- admin-user-ops deploy that stops writing them.
--
-- To undo: re-run both bodies as they were (pg_get_functiondef of the md5s above, saved with S829's
-- notes). Nothing is stored by either change.
--
-- The probe at the end acts as one staff login of a POS outlet (BLOOM CAFE if it qualifies), given
-- each rank in turn inside a block that rolls itself back. For that second it holds the outlet's
-- settings row and that login's profile row. If any check fails, nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces ─────────────────────────────────────────────
-- Each second hash is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.settings_guard_staff_roles()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('07adf2e7ab384cdca54fdc54b89853e5', 'abf734e95ffbb8192c90db5070602bb2') THEN
    RAISE EXCEPTION 'S829 5e pre-flight: settings_guard_staff_roles changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.set_active_outlet(uuid)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('9371e7d44ab87052fe8bb980b9931b28', '304222c3d89b63397040297ff395a28d') THEN
    RAISE EXCEPTION 'S829 5e pre-flight: set_active_outlet changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
END;
$$;


-- ── 1. The settings screen: a settled manager holds no rank ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.settings_guard_staff_roles()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  c_insert_base constant jsonb := '{"hr_custom_roles": [], "ims_custom_roles": [], "pos_custom_roles": [], "is_vat_registered": true, "pos_loyalty_point_value": 1,
                                    "fc_warning_pct": 35, "fc_critical_pct": 45, "expiry_warning_days": 7, "variance_flag_pct": 10,
                                    "block_negative_stock": false, "warn_below_cost_pricing": true,
                                    "item_code_prefix": "ITM", "vendor_code_prefix": "VND", "sub_recipe_code_prefix": "SRC",
                                    "ims_count_scope_enforced": false, "ims_count_blind": false, "require_count_attribution": false}'::jsonb;
  c_tada        constant text[] := ARRAY['tada_vehicle_rates', 'tada_purpose_options', 'tada_start_points'];
  c_pos_setup   constant text[] := ARRAY['pos_bot_categories', 'pos_note_presets', 'pos_discount_reasons', 'pos_delivery_partners',
                                         'pos_reservation_settings', 'pos_open_time', 'pos_close_time', 'pos_loyalty_point_value'];
  c_print       constant text[] := ARRAY['is_vat_registered', 'invoice_prefix', 'vat_number', 'property_address', 'property_phone', 'payment_qr_data'];
  c_ims         constant text[] := ARRAY['fc_warning_pct', 'fc_critical_pct', 'expiry_warning_days', 'variance_flag_pct',
                                         'block_negative_stock', 'warn_below_cost_pricing',
                                         'item_code_prefix', 'vendor_code_prefix', 'sub_recipe_code_prefix'];
  -- S792: the switches the database's count fences read. IMS manager (never a count PIN) or Owner.
  c_ims_count   constant text[] := ARRAY['ims_count_scope_enforced', 'ims_count_blind', 'require_count_attribution'];
  -- S767: what every guest sees at the top of the QR menu. Owner only (admin exempt above).
  c_guest_brand constant text[] := ARRAY['guest_menu_name', 'guest_menu_logo_url'];
  -- S786: the outlet's weather city (Owner or any module's manager) and the rainy-day sales figure
  -- (Owner only). All default NULL, so neither needs a c_insert_base entry.
  c_weather_city constant text[] := ARRAY['weather_city', 'weather_lat', 'weather_lon'];
  c_weather_rain constant text[] := ARRAY['rain_sales_pct'];
  v_new jsonb;
  v_old jsonb;
  v_changed text[];
  v_me profiles;
  v_hr_manager boolean;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;

  v_new := to_jsonb(NEW);
  v_old := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE c_insert_base END;
  -- to_jsonb renders a NULL column as JSON null; `->` on a missing key is SQL NULL. Normalise both.
  SELECT COALESCE(array_agg(k), '{}') INTO v_changed
    FROM unnest(ARRAY['hr_custom_roles', 'ims_custom_roles', 'pos_custom_roles'] || c_tada || c_pos_setup || c_print || c_ims || c_ims_count
                || c_guest_brand || c_weather_city || c_weather_rain) k
   WHERE COALESCE(v_new -> k, 'null'::jsonb) IS DISTINCT FROM COALESCE(v_old -> k, 'null'::jsonb);
  IF cardinality(v_changed) = 0 THEN
    RETURN NEW;
  END IF;

  IF COALESCE(public.is_client_owner(), false) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_me FROM profiles WHERE id = (select auth.uid());
  -- S829 5e (S809.4 1j): a settled HR manager holds no rank for the hour their token lives. Inline,
  -- because hr_is_manager_rank() tests the raw rank and is shared with hss-suite.
  v_hr_manager := COALESCE(v_me.hr_role = 'manager' AND v_me.settlement_blocked_by IS NULL, false);

  IF 'hr_custom_roles' = ANY (v_changed) AND NOT v_hr_manager THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or an HR manager can change the HR role list' USING ERRCODE = '42501';
  END IF;
  -- S829 5e: the shared IMS rank test, which refuses a settled login and a count PIN.
  IF 'ims_custom_roles' = ANY (v_changed) AND NOT COALESCE(public.ims_caller_has_rank('manager'), false) THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or an IMS manager can change the IMS role list' USING ERRCODE = '42501';
  END IF;
  -- S809 1j (ACCESS-9): the shared POS rank test, which refuses a settlement-blocked login.
  IF 'pos_custom_roles' = ANY (v_changed) AND NOT COALESCE(public.pos_caller_has_rank('manager'), false) THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or a POS manager can change the POS role list' USING ERRCODE = '42501';
  END IF;
  IF v_changed && c_tada AND NOT v_hr_manager THEN
    RAISE EXCEPTION 'tada_settings_rank: only the Owner or an HR manager can change the travel claim settings' USING ERRCODE = '42501';
  END IF;
  -- S809 1j (ACCESS-9): likewise.
  IF v_changed && c_pos_setup AND NOT COALESCE(public.pos_caller_has_rank('manager'), false) THEN
    RAISE EXCEPTION 'pos_setup_rank: only the Owner or a POS manager can change the till setup (%)',
      array_to_string(ARRAY(SELECT unnest(v_changed) INTERSECT SELECT unnest(c_pos_setup) ORDER BY 1), ', ')
      USING ERRCODE = '42501', HINT = 'pos_setup_rank';
  END IF;
  -- S829 5e: likewise for the two IMS lists below (a count PIN was refused here already).
  IF v_changed && c_ims AND NOT COALESCE(public.ims_caller_has_rank('manager'), false) THEN
    RAISE EXCEPTION 'ims_settings_rank: only the Owner or an IMS manager can change the inventory thresholds and code prefixes (%)',
      array_to_string(ARRAY(SELECT unnest(v_changed) INTERSECT SELECT unnest(c_ims) ORDER BY 1), ', ')
      USING ERRCODE = '42501', HINT = 'ims_settings_rank';
  END IF;
  IF v_changed && c_ims_count AND NOT COALESCE(public.ims_caller_has_rank('manager'), false) THEN
    RAISE EXCEPTION 'ims_count_settings_rank: only the Owner or an IMS manager can change how stock counts are fenced (%)',
      array_to_string(ARRAY(SELECT unnest(v_changed) INTERSECT SELECT unnest(c_ims_count) ORDER BY 1), ', ')
      USING ERRCODE = '42501', HINT = 'ims_count_settings_rank';
  END IF;
  IF v_changed && c_print THEN
    RAISE EXCEPTION 'invoice_settings_rank: only the Owner can change the invoice and VAT details printed on bills (%)',
      array_to_string(ARRAY(SELECT unnest(v_changed) INTERSECT SELECT unnest(c_print) ORDER BY 1), ', ')
      USING ERRCODE = '42501', HINT = 'invoice_settings_rank';
  END IF;
  IF v_changed && c_guest_brand THEN
    RAISE EXCEPTION 'guest_menu_brand_rank: only the Owner can change the restaurant name and logo on the guest menu'
      USING ERRCODE = '42501', HINT = 'guest_menu_brand_rank';
  END IF;
  -- S786. Any module's manager, never a count PIN (ims_email), with every operand inside one
  -- COALESCE: a login with no rank on any axis is NULL OR NULL OR NULL, which must refuse.
  -- S829 5e: each axis through its effective-rank test, so a settled (or POS-blocked) manager is refused.
  IF v_changed && c_weather_city AND NOT COALESCE(
       public.pos_caller_has_rank('manager') OR public.ims_caller_has_rank('manager') OR v_hr_manager, false) THEN
    RAISE EXCEPTION 'weather_city_rank: only the Owner or a manager can change the outlet''s weather city'
      USING ERRCODE = '42501', HINT = 'weather_city_rank';
  END IF;
  IF v_changed && c_weather_rain THEN
    RAISE EXCEPTION 'weather_rain_rank: only the Owner can change how rain moves the sales forecast'
      USING ERRCODE = '42501', HINT = 'weather_rain_rank';
  END IF;
  RETURN NEW;
END;
$function$;


-- ── 2. The outlet switch: your own outlet by id is the reset ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_active_outlet(p_client_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_home_group uuid;
  v_target_group uuid;
  v_allowed boolean;
  v_home uuid;
  v_pin boolean;
BEGIN
  -- Resetting to your OWN outlet stays open to everyone, and must come BEFORE the checks below:
  -- assigning any staff marker demotes an account out of Owner, so an Owner who had switched and
  -- was then given a role would otherwise be stranded at a sibling outlet with no way back.
  IF p_client_id IS NULL THEN
    UPDATE profiles SET active_client_id = NULL WHERE id = (select auth.uid());
    RETURN;
  END IF;

  SELECT p.client_id, p.pos_email IS NOT NULL INTO v_home, v_pin
    FROM profiles p
   WHERE p.id = (select auth.uid());

  -- S829 5e (S809.4 1g): asking for your home outlet BY ID is the same reset, for every login.
  -- Outlet Access stores no home row, so an allowlisted non-Owner picking home in the switcher was
  -- refused below. NULL is stored, as the reset above stores. A caller with no profile row has a
  -- NULL v_home, so the test is NULL and it falls through to the checks below, which refuse it.
  IF p_client_id = v_home THEN
    UPDATE profiles SET active_client_id = NULL WHERE id = (select auth.uid());
    RETURN;
  END IF;

  -- S809 ACCESS-4: a till PIN login works only at its home outlet, the only one whose tablets can
  -- sign it in. Asking for home is the reset above; any other outlet is refused, even with an
  -- Outlet Access row an older build may have written.
  IF COALESCE(v_pin, false) THEN
    RAISE EXCEPTION 'pos_pin_outlet_pinned: a till PIN login works only at its own outlet, so it cannot switch to another'
      USING ERRCODE = '42501', HINT = 'pos_pin_outlet_pinned';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM profile_outlet_access
     WHERE profile_id = (select auth.uid()) AND client_id = p_client_id
  ) INTO v_allowed;

  -- COALESCE on both identity tests: each reads a profiles row and returns NULL -- not false --
  -- when the caller has none, and IF NOT NULL THEN never fires, so the unwrapped form falls
  -- OPEN for exactly the accounts that could not be identified (S579).
  IF NOT (COALESCE(public.is_admin(), false)
          OR COALESCE(public.is_client_owner(), false)
          OR COALESCE(v_allowed, false)) THEN
    RAISE EXCEPTION 'Not permitted: you do not have access to that outlet.';
  END IF;

  SELECT c.group_id INTO v_home_group
    FROM profiles p JOIN clients c ON c.id = p.client_id
   WHERE p.id = (select auth.uid());

  SELECT group_id INTO v_target_group FROM clients WHERE id = p_client_id;

  -- Fails closed on every ambiguous case: no group, target ungrouped, or different group.
  IF v_home_group IS NULL OR v_target_group IS NULL OR v_home_group <> v_target_group THEN
    RAISE EXCEPTION 'Not permitted: that outlet is not in your group.';
  END IF;

  UPDATE profiles SET active_client_id = p_client_id WHERE id = (select auth.uid());
END;
$function$;


-- ── 3. Prove it ───────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_client  uuid;
  v_other   uuid;
  v_stand   uuid;
  v_settle  uuid;
  v_case    record;
  v_n       bigint;
  v_code    text;
  v_msg     text;
  v_active  uuid;
BEGIN
  -- Catalog: the guard still INVOKER and attached; the switch still DEFINER.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.settings_guard_staff_roles()'::regprocedure) THEN
    RAISE EXCEPTION 'S829 5e: settings_guard_staff_roles became SECURITY DEFINER';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.set_active_outlet(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'S829 5e: set_active_outlet stopped being SECURITY DEFINER';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE NOT tgisinternal AND tgenabled = 'O' AND tgrelid = 'public.settings'::regclass
     AND tgfoid = 'public.settings_guard_staff_roles()'::regprocedure;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S829 5e: settings_guard_staff_roles is attached and enabled % times, not once', v_n;
  END IF;

  -- ── Who acts: one staff login of a POS outlet with a settings row (BLOOM CAFE first), given each
  --    rank in turn; any other outlet; and a real settlement to mark the login with ───────────────
  SELECT c.id INTO v_client
    FROM public.clients c
   WHERE c.pos_enabled
     AND EXISTS (SELECT 1 FROM public.settings s WHERE s.client_id = c.id)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND p.role = 'client'
                    AND NOT COALESCE(p.hr_self_service, false)
                    AND (p.pos_role IS NOT NULL OR p.pos_email IS NOT NULL OR p.ims_role IS NOT NULL OR p.hr_role IS NOT NULL))
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name LIMIT 1;
  SELECT p.id INTO v_stand
    FROM public.profiles p
   WHERE p.client_id = v_client AND p.role = 'client' AND NOT COALESCE(p.hr_self_service, false)
     AND (p.pos_role IS NOT NULL OR p.pos_email IS NOT NULL OR p.ims_role IS NOT NULL OR p.hr_role IS NOT NULL)
   ORDER BY p.created_at, p.id LIMIT 1;
  SELECT id INTO v_other FROM public.clients WHERE id <> v_client ORDER BY id LIMIT 1;
  SELECT id INTO v_settle FROM public.hr_final_settlements ORDER BY id LIMIT 1;
  IF v_client IS NULL OR v_stand IS NULL OR v_other IS NULL OR v_settle IS NULL THEN
    RAISE EXCEPTION 'S829 5e probe: nothing to act with (outlet %, login %, other outlet %, settlement %)',
      v_client, v_stand, v_other, v_settle;
  END IF;

  BEGIN
    -- ── The settings screen. Each case: the login's one manager rank, whether it is settled or a
    --    count PIN, the setting it changes, and the refusal expected (NULL = it goes through) ────
    FOR v_case IN
      SELECT * FROM (VALUES
        ( 1, 'HR manager, HR role list',              'hr',  false, false, 'hr_custom_roles',    NULL),
        ( 2, 'settled HR manager, HR role list',      'hr',  true,  false, 'hr_custom_roles',    'staff_roles_rank'),
        ( 3, 'HR manager, travel claims',             'hr',  false, false, 'tada_vehicle_rates', NULL),
        ( 4, 'settled HR manager, travel claims',     'hr',  true,  false, 'tada_vehicle_rates', 'tada_settings_rank'),
        ( 5, 'HR manager, weather city',              'hr',  false, false, 'weather_city',       NULL),
        ( 6, 'settled HR manager, weather city',      'hr',  true,  false, 'weather_city',       'weather_city_rank'),
        ( 7, 'IMS manager, IMS role list',            'ims', false, false, 'ims_custom_roles',   NULL),
        ( 8, 'settled IMS manager, IMS role list',    'ims', true,  false, 'ims_custom_roles',   'staff_roles_rank'),
        ( 9, 'count PIN manager, IMS role list',      'ims', false, true,  'ims_custom_roles',   'staff_roles_rank'),
        (10, 'IMS manager, thresholds',               'ims', false, false, 'fc_warning_pct',     NULL),
        (11, 'settled IMS manager, thresholds',       'ims', true,  false, 'fc_warning_pct',     'ims_settings_rank'),
        (12, 'settled IMS manager, count fences',     'ims', true,  false, 'ims_count_blind',    'ims_count_settings_rank'),
        (13, 'IMS manager, weather city',             'ims', false, false, 'weather_city',       NULL),
        (14, 'settled IMS manager, weather city',     'ims', true,  false, 'weather_city',       'weather_city_rank'),
        (15, 'POS manager, weather city',             'pos', false, false, 'weather_city',       NULL),
        (16, 'settled POS manager, weather city',     'pos', true,  false, 'weather_city',       'weather_city_rank')
      ) AS t(n, what, axis, settled, count_pin, col, expect)
    LOOP
      UPDATE public.profiles
         SET role = 'client', pos_email = NULL, hr_self_service = false, active_client_id = NULL, pos_blocked_at = NULL,
             pos_role = CASE WHEN v_case.axis = 'pos' THEN 'manager' END,
             ims_role = CASE WHEN v_case.axis = 'ims' THEN 'manager' END,
             hr_role  = CASE WHEN v_case.axis = 'hr'  THEN 'manager' END,
             ims_email = CASE WHEN v_case.count_pin THEN 's829-5e-probe-' || v_stand || '@invalid.local' END,
             settlement_blocked_by = CASE WHEN v_case.settled THEN v_settle END
       WHERE id = v_stand;

      v_code := NULL;
      v_msg := NULL;
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_stand)::text, true);
      BEGIN
        EXECUTE format('UPDATE public.settings SET %s WHERE client_id = $1', CASE v_case.col
            WHEN 'hr_custom_roles'    THEN format('hr_custom_roles = jsonb_build_array(%L)', 'S829 probe ' || v_case.n)
            WHEN 'ims_custom_roles'   THEN format('ims_custom_roles = jsonb_build_array(%L)', 'S829 probe ' || v_case.n)
            WHEN 'tada_vehicle_rates' THEN format('tada_vehicle_rates = jsonb_build_array(%L)', 'S829 probe ' || v_case.n)
            WHEN 'fc_warning_pct'     THEN 'fc_warning_pct = COALESCE(fc_warning_pct, 35) + 1'
            WHEN 'ims_count_blind'    THEN 'ims_count_blind = NOT COALESCE(ims_count_blind, false)'
            WHEN 'weather_city'       THEN format('weather_city = %L', 'S829 probe ' || v_case.n)
          END) USING v_client;
        GET DIAGNOSTICS v_n = ROW_COUNT;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        v_code := split_part(v_msg, ':', 1);
        v_n := -1;
      END;
      RESET ROLE;
      PERFORM set_config('request.jwt.claims', '', true);

      IF v_case.expect IS NULL AND v_n <> 1 THEN
        RAISE EXCEPTION 'S829 5e probe: % should go through, and % (% rows)', v_case.what, COALESCE(v_msg, 'nothing was refused'), v_n;
      ELSIF v_case.expect IS NOT NULL AND v_code IS DISTINCT FROM v_case.expect THEN
        RAISE EXCEPTION 'S829 5e probe: % answered % (expected %)',
          v_case.what, COALESCE(v_msg, 'nothing, ' || v_n || ' row(s) changed'), v_case.expect;
      END IF;
    END LOOP;

    -- ── The outlet switch, as an unsettled HR manager with no Outlet Access row: home by id is the
    --    reset; any other outlet is still refused. Then as a till PIN login, which already worked ──
    UPDATE public.profiles
       SET role = 'client', pos_role = NULL, pos_email = NULL, ims_role = NULL, ims_email = NULL, hr_role = 'manager',
           hr_self_service = false, settlement_blocked_by = NULL, pos_blocked_at = NULL, active_client_id = v_client
     WHERE id = v_stand;
    DELETE FROM public.profile_outlet_access WHERE profile_id = v_stand;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_stand)::text, true);
    PERFORM public.set_active_outlet(v_client);
    v_msg := NULL;
    BEGIN
      PERFORM public.set_active_outlet(v_other);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    END;
    RESET ROLE;
    SELECT active_client_id INTO v_active FROM public.profiles WHERE id = v_stand;
    IF v_active IS NOT NULL THEN
      RAISE EXCEPTION 'S829 5e probe: a staff login asking for its home outlet by id stored %', v_active;
    END IF;
    IF v_msg IS NULL OR v_msg NOT LIKE 'Not permitted:%' THEN
      RAISE EXCEPTION 'S829 5e probe: a staff login asking for an outlet it has no access to answered %', COALESCE(v_msg, 'nothing');
    END IF;

    UPDATE public.profiles
       SET hr_role = NULL, pos_role = 'staff', pos_email = 's829-5e-probe-' || v_stand || '@invalid.local', active_client_id = v_client
     WHERE id = v_stand;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_stand)::text, true);
    PERFORM public.set_active_outlet(v_client);
    v_msg := NULL;
    BEGIN
      PERFORM public.set_active_outlet(v_other);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    END;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    SELECT active_client_id INTO v_active FROM public.profiles WHERE id = v_stand;
    IF v_active IS NOT NULL THEN
      RAISE EXCEPTION 'S829 5e probe: a till PIN login asking for its home outlet by id stored %', v_active;
    END IF;
    IF v_msg IS NULL OR v_msg NOT LIKE 'pos_pin_outlet_pinned:%' THEN
      RAISE EXCEPTION 'S829 5e probe: a till PIN login asking for another outlet answered %', COALESCE(v_msg, 'nothing');
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's829_5e_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's829_5e_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;


-- ── 4. What this slice acts on, live (the last statement, so `db query` prints it) ────────────
SELECT
  (SELECT count(*) FROM public.profiles
    WHERE settlement_blocked_by IS NOT NULL AND 'manager' IN (hr_role, ims_role, pos_role)) AS settled_managers,
  (SELECT count(*) FROM public.profile_outlet_access) AS outlet_access_rows,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.settings_guard_staff_roles()'::regprocedure) AS settings_guard_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.set_active_outlet(uuid)'::regprocedure) AS set_active_outlet_md5;

-- Read back after applying (one statement per call):
--   SELECT p.proname, md5(prosrc), prosecdef FROM pg_proc p
--    WHERE p.oid IN ('public.settings_guard_staff_roles()'::regprocedure, 'public.set_active_outlet(uuid)'::regprocedure);
--     expect the second hash of each in section 0, prosecdef f (guard) / t (switch).
--   SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = 'settings_guard_staff_roles' AND NOT tgisinternal;  -- O
