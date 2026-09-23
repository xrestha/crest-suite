-- S786 — who may set the outlet's weather city, now that POS and HR can set it too.
--
-- S784 left settings.weather_city / weather_lat / weather_lon / rain_sales_pct out of
-- settings_guard_staff_roles, on the reasoning that they "only move a dashed line" and that
-- fc_warning_pct was unguarded. The second half had stopped being true in S756 (fc_warning_pct is in
-- c_ims), and S786 puts a city picker on POS Setup and on both dashboards, so the rule is now the
-- owner's decision rather than the browser's:
--
--   weather_city / weather_lat / weather_lon  the Owner, admin, or a MANAGER of any module (a POS,
--                                             HR or IMS manager; an IMS count PIN is never one)
--   rain_sales_pct                            the Owner or admin: it moves the Owner's own sales
--                                             forecast, and Settings → Weather is an Owner-only tab
--
-- Without this any same-client login except HR Self-Service — a waiter's POS PIN included — could
-- PATCH either over REST. All four columns default NULL, so c_insert_base needs no entry: an INSERT
-- that sets a city is compared against NULL and counts as a change, which is right.
--
-- The body below is the LIVE definition read with pg_get_functiondef on 2026-09-23 (md5 of prosrc
-- 76acb00ff42a6a89b3deb6234de5dac9) plus two lists, their place in the changed-column union, and two
-- checks — nothing else moved. The first block refuses to run if the live body has changed since, so
-- an edit made elsewhere is never silently reverted (supabase-sql.md: rebuild from the live body).
--
-- Reverse: re-run the body with c_weather_city / c_weather_rain and their two checks removed.

DO $$
DECLARE
  v_md5 text;
  v_src text;
BEGIN
  SELECT md5(prosrc), prosrc INTO v_md5, v_src FROM pg_proc WHERE oid = 'public.settings_guard_staff_roles()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '76acb00ff42a6a89b3deb6234de5dac9' AND v_src NOT LIKE '%weather_city_rank%' THEN
    RAISE EXCEPTION 'S786: settings_guard_staff_roles changed since this migration was written (md5 %) — rebuild it from the live body', v_md5;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.settings_guard_staff_roles()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  c_insert_base constant jsonb := '{"hr_custom_roles": [], "ims_custom_roles": [], "pos_custom_roles": [], "is_vat_registered": true, "pos_loyalty_point_value": 1,
                                    "fc_warning_pct": 35, "fc_critical_pct": 45, "expiry_warning_days": 7, "variance_flag_pct": 10,
                                    "block_negative_stock": false, "warn_below_cost_pricing": true,
                                    "item_code_prefix": "ITM", "vendor_code_prefix": "VND", "sub_recipe_code_prefix": "SRC"}'::jsonb;
  c_tada        constant text[] := ARRAY['tada_vehicle_rates', 'tada_purpose_options', 'tada_start_points'];
  c_pos_setup   constant text[] := ARRAY['pos_bot_categories', 'pos_note_presets', 'pos_discount_reasons', 'pos_delivery_partners',
                                         'pos_reservation_settings', 'pos_open_time', 'pos_close_time', 'pos_loyalty_point_value'];
  c_print       constant text[] := ARRAY['is_vat_registered', 'invoice_prefix', 'vat_number', 'property_address', 'property_phone', 'payment_qr_data'];
  c_ims         constant text[] := ARRAY['fc_warning_pct', 'fc_critical_pct', 'expiry_warning_days', 'variance_flag_pct',
                                         'block_negative_stock', 'warn_below_cost_pricing',
                                         'item_code_prefix', 'vendor_code_prefix', 'sub_recipe_code_prefix'];
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
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;

  v_new := to_jsonb(NEW);
  v_old := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE c_insert_base END;
  -- to_jsonb renders a NULL column as JSON null; `->` on a missing key is SQL NULL. Normalise both.
  SELECT COALESCE(array_agg(k), '{}') INTO v_changed
    FROM unnest(ARRAY['hr_custom_roles', 'ims_custom_roles', 'pos_custom_roles'] || c_tada || c_pos_setup || c_print || c_ims || c_guest_brand
                || c_weather_city || c_weather_rain) k
   WHERE COALESCE(v_new -> k, 'null'::jsonb) IS DISTINCT FROM COALESCE(v_old -> k, 'null'::jsonb);
  IF cardinality(v_changed) = 0 THEN
    RETURN NEW;
  END IF;

  IF COALESCE(public.is_client_owner(), false) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_me FROM profiles WHERE id = (select auth.uid());

  IF 'hr_custom_roles' = ANY (v_changed) AND NOT COALESCE(v_me.hr_role = 'manager', false) THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or an HR manager can change the HR role list' USING ERRCODE = '42501';
  END IF;
  IF 'ims_custom_roles' = ANY (v_changed) AND NOT COALESCE(v_me.ims_role = 'manager', false) THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or an IMS manager can change the IMS role list' USING ERRCODE = '42501';
  END IF;
  IF 'pos_custom_roles' = ANY (v_changed) AND NOT COALESCE(v_me.pos_role = 'manager', false) THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or a POS manager can change the POS role list' USING ERRCODE = '42501';
  END IF;
  IF v_changed && c_tada AND NOT COALESCE(v_me.hr_role = 'manager', false) THEN
    RAISE EXCEPTION 'tada_settings_rank: only the Owner or an HR manager can change the travel claim settings' USING ERRCODE = '42501';
  END IF;
  IF v_changed && c_pos_setup AND NOT COALESCE(v_me.pos_role = 'manager', false) THEN
    RAISE EXCEPTION 'pos_setup_rank: only the Owner or a POS manager can change the till setup (%)',
      array_to_string(ARRAY(SELECT unnest(v_changed) INTERSECT SELECT unnest(c_pos_setup) ORDER BY 1), ', ')
      USING ERRCODE = '42501', HINT = 'pos_setup_rank';
  END IF;
  IF v_changed && c_ims AND NOT COALESCE(v_me.ims_role = 'manager' AND v_me.ims_email IS NULL, false) THEN
    RAISE EXCEPTION 'ims_settings_rank: only the Owner or an IMS manager can change the inventory thresholds and code prefixes (%)',
      array_to_string(ARRAY(SELECT unnest(v_changed) INTERSECT SELECT unnest(c_ims) ORDER BY 1), ', ')
      USING ERRCODE = '42501', HINT = 'ims_settings_rank';
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
  IF v_changed && c_weather_city AND NOT COALESCE(
       v_me.pos_role = 'manager' OR (v_me.ims_role = 'manager' AND v_me.ims_email IS NULL) OR v_me.hr_role = 'manager', false) THEN
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

-- Assertions: on catalog values (supabase-sql.md, S630). The body's behaviour is exercised after
-- apply in a rolled-back block under real JWT claims, because this guard reads auth.uid().
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.settings_guard_staff_roles()'::regprocedure;
  IF v_src NOT LIKE '%|| c_weather_city || c_weather_rain) k%' THEN
    RAISE EXCEPTION 'S786: the weather lists are not in the changed-column union, so no weather change would ever be checked';
  END IF;
  IF v_src NOT LIKE '%HINT = ''weather_city_rank''%' OR v_src NOT LIKE '%HINT = ''weather_rain_rank''%' THEN
    RAISE EXCEPTION 'S786: a weather rank check is missing from settings_guard_staff_roles';
  END IF;
  IF v_src NOT LIKE '%HINT = ''guest_menu_brand_rank''%' OR v_src NOT LIKE '%HINT = ''pos_setup_rank''%' THEN
    RAISE EXCEPTION 'S786: an existing check was lost in the rebuild';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.settings'::regclass
                   AND tgfoid = 'public.settings_guard_staff_roles()'::regprocedure AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'S786: settings_guard_staff_roles is no longer attached to settings';
  END IF;
END;
$$;
