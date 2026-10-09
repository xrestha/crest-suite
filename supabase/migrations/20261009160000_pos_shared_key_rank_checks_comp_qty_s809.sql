-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 1, slice 1j: the old shared till key is switched off everywhere, two dead RPCs go,
-- the POS rank checks stop letting a settled leaver through, and a part-comp takes only a sane
-- quantity.
--
--   ACCESS-8 (P3). Every client still had its pre-S754 shared till key switched on, and any Owner or
--   POS manager could fetch it with get_pos_device_secret, an RPC nothing has called since S754, to
--   set up a till that never shows in the Tablets list and cannot be revoked on its own. No tablet
--   has signed in with it since the stamp began (pos_legacy_key_last_used_at NULL at all three
--   clients, read 2026-10-09). Owner decision Q7 (a), 2026-10-08: switch it off for every client
--   now, all at once.
--     (1) Retired the way retire_pos_legacy_device_key does it: the key is ROTATED to a value no
--         tablet holds and stamped, with the same timestamp-only audit row (user "System"). Every
--         path that still compares against it (verify_pos_legacy_device, get_pos_staff, a stale
--         pos-staff-login) stops matching at once. Section 0 refuses to run if any client's shared
--         key has been used since S754, because Q7 was decided on the premise that none had.
--     (2) A client_secrets row created from now on is born switched off (column default), so the
--         stock-count enrolment path, which creates the row for a new client, no longer hands
--         Till Devices an amber "the shared key is still on" panel for a key nobody ever held.
--     (3) get_pos_device_secret is dropped. No caller in src/ or supabase/functions/.
--   The legacy branch of pos-staff-login, PosLogin's get_pos_staff path and the functions only they
--   call are NOT removed here (POS_TODO A2): they are deployed code, a stale bundle still calls
--   get_pos_staff, and after (1) and (2) none of them can match a key any tablet holds. That
--   clean-up is a follow-up slice with an Edge Function deploy.
--
--   ACCESS-9 (P3). Four POS rank checks were copies of pos_caller_has_rank without its one extra
--   test, settlement_blocked_by IS NULL, which exists for the hour a settled leaver's last access
--   token still lives. Each now calls the shared helper instead of carrying a fifth copy:
--     apply_pos_item_comps        pos_caller_has_rank('supervisor')
--     caller_can_set_menu_price   pos_caller_has_rank('manager') OR ims_caller_has_rank('manager')
--                                 (also refuses a stock-count PIN login at IMS manager rank, as
--                                 every other IMS rank test has since S756; 0 such logins live)
--     settings_guard_staff_roles  the POS role list and the till-setup columns
--     get_pos_device_secret       dropped (ACCESS-8)
--
--   CHECKOUT-16 (P3). apply_pos_item_comps took any comp_qty, so a REST call could leave a negative
--   charged line or a negative comp. A part-comp now takes a whole number from 1 to one less than
--   the line's quantity (hint pos_comp_qty_invalid); a whole line goes through the full-line paths
--   as the till already sends it. A CHECK (qty > 0) on pos_order_items backs it for every writer.
--   The same branch now splits the line's sent count between the two rows instead of leaving the
--   charged row's sent_qty above its new quantity (3 sent, comp 1: 2 + 1, not 3 + 1), so a later
--   save of that line no longer records a pull nobody made.
--
--   DATABASE-9 (P3). get_next_pos_comp_slip_no, retired by apply_pos_item_comps in S286, is dropped.
--   Its lock was released before the number was used, so a caller following the old rules sentence
--   would print one NC number on two tills.
--
-- Built on LIVE bodies read 2026-10-09 (md5(prosrc)); section 0 refuses to run if any changed since:
--     apply_pos_item_comps(uuid,uuid,text,text,uuid,uuid[],jsonb,jsonb)  689f1b9d207070c38946c986e60a34ba
--     caller_can_set_menu_price()                                        a8070db9d8516d99913bfa45502bcfb1
--     settings_guard_staff_roles()                                       8873097e40de22aac517c14d81221aff
--   and relying on, unchanged:
--     pos_caller_has_rank(text)                                          7d34792c8f392e49bc47274d1e8045ce
--     ims_caller_has_rank(text)                                          b1b5a0e6f6c73e7a819923d8ca43c2f9
--   Dropped (live md5 for the record): get_pos_device_secret(uuid) 0d87636d68d407a85702c1a1d9c97c47,
--   get_next_pos_comp_slip_no(uuid,text) 1655d7de4c215b39a41c44da87ba5e53.
-- No other stage-1 draft (1b live; 1c, 1d, 1h) replaces any of these.
--
-- Live before this migration: 3 client_secrets rows (BLOOM CAFE, BLOOM CAFE - PKR, CASA ACAI CAFE),
-- none retired, none ever used; 62 order lines, 0 with qty < 1 (the new CHECK validates), 0 with
-- sent_qty above qty; 0 settlement-blocked logins; 0 stock-count PIN logins at IMS manager rank.
--
-- The probe at the end runs as the outlet's Owner and as a PIN login (stand-in ranks, a stand-in
-- settlement block) inside a block that rolls itself back. If any check fails, the whole migration
-- fails and nothing here lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_md5   text;
  v_names text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.apply_pos_item_comps(uuid, uuid, text, text, uuid, uuid[], jsonb, jsonb)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '689f1b9d207070c38946c986e60a34ba' THEN
    RAISE EXCEPTION 'S809 1j: apply_pos_item_comps changed since this slice was drafted (live md5 %) — merge section 3 onto the live body and update the md5 here', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.caller_can_set_menu_price()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'a8070db9d8516d99913bfa45502bcfb1' THEN
    RAISE EXCEPTION 'S809 1j: caller_can_set_menu_price changed since this slice was drafted (live md5 %)', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.settings_guard_staff_roles()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '8873097e40de22aac517c14d81221aff' THEN
    RAISE EXCEPTION 'S809 1j: settings_guard_staff_roles changed since this slice was drafted (live md5 %) — merge section 5 onto the live body and update the md5 here', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_caller_has_rank(text)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '7d34792c8f392e49bc47274d1e8045ce' THEN
    RAISE EXCEPTION 'S809 1j: pos_caller_has_rank changed since this slice was drafted (live md5 %) — re-check that it still refuses a settlement-blocked login', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.ims_caller_has_rank(text)'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'b1b5a0e6f6c73e7a819923d8ca43c2f9' THEN
    RAISE EXCEPTION 'S809 1j: ims_caller_has_rank changed since this slice was drafted (live md5 %) — re-check that it still refuses a settlement-blocked login', v_md5;
  END IF;

  -- Q7 (a) was decided on "no till has used the shared key since 2026-09-14". If one has since,
  -- switching it off would leave that till showing no staff mid-service: stop and ask.
  SELECT string_agg(format('%s (last used %s)', c.name, cs.pos_legacy_key_last_used_at), ', ' ORDER BY c.name)
    INTO v_names
    FROM public.client_secrets cs
    JOIN public.clients c ON c.id = cs.client_id
   WHERE cs.pos_legacy_key_retired_at IS NULL
     AND cs.pos_legacy_key_last_used_at IS NOT NULL;
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'S809 1j: a till still signs in with the shared key at %. Owner decision Q7 assumed none did. Activate those tills again from Till Devices first, then re-run this migration', v_names;
  END IF;
END;
$$;


-- ── 1. The shared till key is switched off at every client (ACCESS-8, Q7 a) ─────────────────
--
-- The same two writes and the same audit row as retire_pos_legacy_device_key, which cannot be
-- called here: it refuses a caller with no session (pos_device_caller_may_manage keys on
-- auth.uid()). The audit row names no user, which the Audit Log shows as "System", exactly as
-- admin-user-ops' revokeClientTablets does. Each client's old key is checked to open nothing.
DO $$
DECLARE
  r     record;
  v_at  timestamptz := now();
  v_new uuid;
  v_n   int := 0;
BEGIN
  FOR r IN
    SELECT cs.client_id, cs.pos_device_secret AS old_key, c.name
      FROM public.client_secrets cs
      JOIN public.clients c ON c.id = cs.client_id
     WHERE cs.pos_legacy_key_retired_at IS NULL
     ORDER BY cs.client_id
       FOR UPDATE OF cs
  LOOP
    UPDATE public.client_secrets
       SET pos_device_secret = gen_random_uuid(),
           pos_legacy_key_retired_at = v_at,
           updated_at = v_at
     WHERE client_id = r.client_id
    RETURNING pos_device_secret INTO v_new;

    INSERT INTO public.audit_logs (client_id, client_name, user_id, user_name, table_name, action, record_id, old_data, new_data)
    VALUES (r.client_id, r.name, NULL, NULL, 'client_secrets', 'UPDATE', r.client_id,
            jsonb_build_object('pos_legacy_key_retired_at', NULL),
            jsonb_build_object('pos_legacy_key_retired_at', v_at));

    -- The key a pre-S754 tablet holds opens nothing any more: not the sign-in gate, not the picker.
    IF v_new IS NOT DISTINCT FROM r.old_key THEN
      RAISE EXCEPTION 'S809 1j: the shared key of % was not rotated', r.name;
    END IF;
    IF public.verify_pos_legacy_device(r.client_id, r.old_key::text) THEN
      RAISE EXCEPTION 'S809 1j: the old shared key of % still passes the sign-in gate', r.name;
    END IF;
    IF EXISTS (SELECT 1 FROM public.get_pos_staff(r.client_id, r.old_key)) THEN
      RAISE EXCEPTION 'S809 1j: the old shared key of % still lists staff on the PIN screen', r.name;
    END IF;
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'S809 1j: the shared till key was switched off at % client(s)', v_n;
END;
$$;


-- ── 2. A shared key created from now on is born switched off (ACCESS-8) ─────────────────────
--
-- issue_ims_enrol_token / rotate_ims_device_secret create the client_secrets row of a client that
-- has none, and ClientDrawer's webhook-secret upsert can too. Each new row still gets a random
-- pos_device_secret (NOT NULL), which nothing can hand out any more; this makes it read as off.
ALTER TABLE public.client_secrets ALTER COLUMN pos_legacy_key_retired_at SET DEFAULT now();


-- ── 3. apply_pos_item_comps: the shared rank test, a sane part-comp, a kept sent count ──────
--
-- The LIVE body (md5 689f1b9d207070c38946c986e60a34ba) with four blocks marked "S809 1j": the
-- rank test, the comp_qty format check, the comp_qty bound, and the sent-count split (the source
-- row's SELECT now also reads its qty). Nothing else differs (the unused v_pos_role is gone, v_qty
-- and v_sent are new). Same signature and return type, so CREATE OR REPLACE keeps the grants
-- (authenticated, service_role; no PUBLIC, no anon).
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

  PERFORM pg_advisory_xact_lock(hashtext('pos_comp_slip_no:' || p_client_id::text || ':' || p_fy));

  SELECT COALESCE(MAX(n), 0) + 1 INTO v_comp_no FROM (
    SELECT invoice_no AS n FROM pos_orders WHERE client_id = p_client_id AND invoice_fy = p_fy AND close_type = 'writeoff'
    UNION ALL
    SELECT comp_no AS n FROM pos_order_items WHERE client_id = p_client_id AND comp_fy = p_fy
  ) combined;

  -- The pre-S758 argument: whole recipes, which on a till that knows no options means its plain
  -- lines. It no longer reaches a customized line — that is comped by line through p_full_lines.
  IF p_full_recipe_ids IS NOT NULL AND array_length(p_full_recipe_ids, 1) > 0 THEN
    UPDATE pos_order_items
    SET comped = true, comp_reason = p_comp_reason, comped_by = v_comped_by,
        comped_at = v_now, comp_fy = p_fy, comp_no = v_comp_no
    WHERE order_id = p_order_id AND recipe_id = ANY(p_full_recipe_ids) AND selection_key = '';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_full_lines, '[]'::jsonb))
  LOOP
    UPDATE pos_order_items
    SET comped = true, comp_reason = p_comp_reason, comped_by = v_comped_by,
        comped_at = v_now, comp_fy = p_fy, comp_no = v_comp_no
    WHERE order_id = p_order_id
      AND recipe_id = (v_item->>'recipe_id')::uuid
      AND selection_key = COALESCE(v_item->>'selection_key', '')
      AND COALESCE(comped, false) = false;
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
           selection_key, base_unit_price, options_delta, option_summary
      INTO v_src
      FROM pos_order_items
     WHERE order_id = p_order_id AND recipe_id = (v_item->>'recipe_id')::uuid
       AND selection_key = v_sel
       AND COALESCE(comped, false) = false
     ORDER BY created_at
     LIMIT 1;
    CONTINUE WHEN v_src.id IS NULL;

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
      selection_key, base_unit_price, options_delta, option_summary
    ) VALUES (
      p_order_id, p_client_id, v_src.recipe_id, v_src.name, v_src.category,
      v_qty, v_src.unit_price, v_src.vat_rate, v_src.sent_to_kot,
      LEAST(v_sent, v_qty),
      true, p_comp_reason, v_comped_by, v_now, p_fy, v_comp_no,
      v_src.selection_key, v_src.base_unit_price, v_src.options_delta, v_src.option_summary
    ) RETURNING id INTO v_new_id;

    INSERT INTO pos_order_item_options (
      client_id, order_id, order_item_id, recipe_id, group_id, option_id, group_name, group_kind,
      option_name, kitchen_name, is_removal, price_delta, list_price_delta, included, ingredient_deltas, sort
    )
    SELECT client_id, order_id, v_new_id, recipe_id, group_id, option_id, group_name, group_kind,
           option_name, kitchen_name, is_removal, price_delta, list_price_delta, included, ingredient_deltas, sort
      FROM pos_order_item_options WHERE order_item_id = v_src.id;
  END LOOP;

  RETURN v_comp_no;
END;
$function$;


-- ── 4. caller_can_set_menu_price: the two shared rank tests (ACCESS-9) ──────────────────────
--
-- Read by guard_recipe_menu_price, guard_recipe_rank and guard_pos_option_edit. Same set as before
-- (admin, the Owner, a POS manager or an IMS manager) minus a settlement-blocked login, and minus a
-- stock-count PIN login at IMS manager rank, which ims_caller_has_rank has refused since S756 and
-- settings_guard_staff_roles' IMS lines refuse too. Grants kept (authenticated, service_role).
CREATE OR REPLACE FUNCTION public.caller_can_set_menu_price()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(public.pos_caller_has_rank('manager'), false)
      OR COALESCE(public.ims_caller_has_rank('manager'), false)
$function$;


-- ── 5. settings_guard_staff_roles: the POS lines call the shared test (ACCESS-9) ────────────
--
-- The LIVE body (md5 8873097e40de22aac517c14d81221aff) with the two POS-manager lines (the POS role
-- list and the till-setup columns) marked "S809 1j". The HR, IMS and weather-city lines still test
-- raw ranks; they are outside this slice (see the slice report). SECURITY INVOKER as before: the
-- current_user seam at the top is what lets the service role and DEFINER bodies through, and
-- authenticated holds EXECUTE on pos_caller_has_rank.
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

  IF 'hr_custom_roles' = ANY (v_changed) AND NOT COALESCE(v_me.hr_role = 'manager', false) THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or an HR manager can change the HR role list' USING ERRCODE = '42501';
  END IF;
  IF 'ims_custom_roles' = ANY (v_changed) AND NOT COALESCE(v_me.ims_role = 'manager', false) THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or an IMS manager can change the IMS role list' USING ERRCODE = '42501';
  END IF;
  -- S809 1j (ACCESS-9): the shared POS rank test, which refuses a settlement-blocked login.
  IF 'pos_custom_roles' = ANY (v_changed) AND NOT COALESCE(public.pos_caller_has_rank('manager'), false) THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or a POS manager can change the POS role list' USING ERRCODE = '42501';
  END IF;
  IF v_changed && c_tada AND NOT COALESCE(v_me.hr_role = 'manager', false) THEN
    RAISE EXCEPTION 'tada_settings_rank: only the Owner or an HR manager can change the travel claim settings' USING ERRCODE = '42501';
  END IF;
  -- S809 1j (ACCESS-9): likewise.
  IF v_changed && c_pos_setup AND NOT COALESCE(public.pos_caller_has_rank('manager'), false) THEN
    RAISE EXCEPTION 'pos_setup_rank: only the Owner or a POS manager can change the till setup (%)',
      array_to_string(ARRAY(SELECT unnest(v_changed) INTERSECT SELECT unnest(c_pos_setup) ORDER BY 1), ', ')
      USING ERRCODE = '42501', HINT = 'pos_setup_rank';
  END IF;
  IF v_changed && c_ims AND NOT COALESCE(v_me.ims_role = 'manager' AND v_me.ims_email IS NULL, false) THEN
    RAISE EXCEPTION 'ims_settings_rank: only the Owner or an IMS manager can change the inventory thresholds and code prefixes (%)',
      array_to_string(ARRAY(SELECT unnest(v_changed) INTERSECT SELECT unnest(c_ims) ORDER BY 1), ', ')
      USING ERRCODE = '42501', HINT = 'ims_settings_rank';
  END IF;
  IF v_changed && c_ims_count AND NOT COALESCE(v_me.ims_role = 'manager' AND v_me.ims_email IS NULL, false) THEN
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


-- ── 6. A line's quantity is at least 1, whoever writes it (CHECKOUT-16) ─────────────────────
--
-- save_pos_order_items already refuses a quantity below 1 and guard_pos_item_price refuses a
-- client session's direct qty write; this catches a SECURITY DEFINER writer or the service role.
-- 0 live rows break it. A restore of a backup holding a qty < 1 line would now fail that table,
-- and no such line has ever existed live.
ALTER TABLE public.pos_order_items DROP CONSTRAINT IF EXISTS pos_order_items_qty_check;
ALTER TABLE public.pos_order_items ADD CONSTRAINT pos_order_items_qty_check CHECK (qty > 0);


-- ── 7. Two dead RPCs go (ACCESS-8, DATABASE-9) ─────────────────────────────────────────────
--
-- Neither has a caller in src/ or supabase/functions/ (only comments name them), and no live
-- function body calls either. The till stopped calling get_pos_device_secret in S754 and
-- get_next_pos_comp_slip_no in S286.
DROP FUNCTION IF EXISTS public.get_pos_device_secret(uuid);
DROP FUNCTION IF EXISTS public.get_next_pos_comp_slip_no(uuid, text);


-- ── 8. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n       int;
  v_owner   uuid;
  v_a       uuid;
  v_pin     uuid;
  v_settle  uuid;
  v_recipe  uuid;
  v_o1      uuid;
  v_o2      uuid;
  v_o3      uuid;
  v_no      int;
  v_qty     int;
  v_sent    int;
  v_by      uuid;
  v_ok      boolean;
  v_at      timestamptz;
  v_bad     jsonb;
  v_hint    text;
  v_msg     text;
  v_fy      text := 'S809-1j-probe';
BEGIN
  -- ── Catalog ──
  IF to_regprocedure('public.get_pos_device_secret(uuid)') IS NOT NULL
     OR to_regprocedure('public.get_next_pos_comp_slip_no(uuid, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'S809 1j: a dropped RPC is still there';
  END IF;
  SELECT count(*) INTO v_n FROM public.client_secrets WHERE pos_legacy_key_retired_at IS NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'S809 1j: % client(s) still have the shared till key on', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_attribute
   WHERE attrelid = 'public.client_secrets'::regclass AND attname = 'pos_legacy_key_retired_at' AND atthasdef;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 1j: client_secrets.pos_legacy_key_retired_at has no default';
  END IF;
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.pos_order_items'::regclass AND conname = 'pos_order_items_qty_check'
     AND contype = 'c' AND convalidated;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 1j: the qty CHECK on pos_order_items is missing or not validated';
  END IF;
  -- No fifth copy: each replaced body calls the shared test (a tripwire; the behaviour is below).
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid IN ('public.apply_pos_item_comps(uuid, uuid, text, text, uuid, uuid[], jsonb, jsonb)'::regprocedure,
                 'public.caller_can_set_menu_price()'::regprocedure,
                 'public.settings_guard_staff_roles()'::regprocedure)
     AND prosrc LIKE '%pos_caller_has_rank%';
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'S809 1j: % of the 3 replaced bodies call pos_caller_has_rank', v_n;
  END IF;
  -- Grants survived CREATE OR REPLACE.
  IF has_function_privilege('anon', 'public.apply_pos_item_comps(uuid, uuid, text, text, uuid, uuid[], jsonb, jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.apply_pos_item_comps(uuid, uuid, text, text, uuid, uuid[], jsonb, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.caller_can_set_menu_price()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.caller_can_set_menu_price()', 'EXECUTE') THEN
    RAISE EXCEPTION 'S809 1j: the grants on apply_pos_item_comps / caller_can_set_menu_price changed';
  END IF;

  -- ── The callers: a POS outlet's Owner, a PIN login of that outlet, a till dish, a settlement ──
  SELECT p.id, COALESCE(p.active_client_id, p.client_id) INTO v_owner, v_a
    FROM public.profiles p
    JOIN public.clients c ON c.id = COALESCE(p.active_client_id, p.client_id)
   WHERE p.role = 'client' AND c.pos_enabled
     AND p.pos_email IS NULL AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND NOT COALESCE(p.hr_self_service, false)
     AND EXISTS (SELECT 1 FROM public.profiles s
                  WHERE s.pos_email IS NOT NULL AND s.pos_role IS NOT NULL
                    AND COALESCE(s.active_client_id, s.client_id) = c.id)
     AND EXISTS (SELECT 1 FROM public.recipes r
                  WHERE r.client_id = c.id AND r.pos_enabled AND r.is_active IS NOT FALSE
                    AND r.category IS DISTINCT FROM 'Sub-Recipe')
   ORDER BY p.id
   LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'S809 1j probe: no POS Owner login with a PIN login and a till dish to test with';
  END IF;
  SELECT id INTO v_pin FROM public.profiles
   WHERE pos_email IS NOT NULL AND pos_role IS NOT NULL AND COALESCE(active_client_id, client_id) = v_a
   ORDER BY id LIMIT 1;
  SELECT id INTO v_recipe FROM public.recipes
   WHERE client_id = v_a AND pos_enabled AND is_active IS NOT FALSE AND category IS DISTINCT FROM 'Sub-Recipe'
   ORDER BY id LIMIT 1;
  -- Any settlement will do as the stand-in block: the foreign key only asks that it exists.
  SELECT id INTO v_settle FROM public.hr_final_settlements ORDER BY id LIMIT 1;
  IF v_pin IS NULL OR v_recipe IS NULL OR v_settle IS NULL THEN
    RAISE EXCEPTION 'S809 1j probe: needs a PIN login, a till dish and one final settlement (got %, %, %)', v_pin, v_recipe, v_settle;
  END IF;

  BEGIN
    -- Setup, as the migration's own role. The PIN login is made a plain POS supervisor with no
    -- other marker (no HR employee link, so the IMS stand-in below cannot collide on a unique index).
    UPDATE public.profiles
       SET pos_role = 'supervisor', ims_role = NULL, ims_email = NULL, hr_role = NULL,
           hr_self_service = false, hr_employee_id = NULL, settlement_blocked_by = NULL
     WHERE id = v_pin;
    INSERT INTO public.pos_orders (client_id, table_name) VALUES (v_a, 'S809 1j probe 1') RETURNING id INTO v_o1;
    INSERT INTO public.pos_orders (client_id, table_name) VALUES (v_a, 'S809 1j probe 2') RETURNING id INTO v_o2;
    INSERT INTO public.pos_orders (client_id, table_name) VALUES (v_a, 'S809 1j probe 3') RETURNING id INTO v_o3;
    -- o1: 3 fired; o2: 3 fired; o3: 3 on the bill, 1 of them fired (two added since the send).
    INSERT INTO public.pos_order_items (order_id, client_id, recipe_id, name, category, qty, unit_price, vat_rate, sent_to_kot, sent_qty)
    VALUES (v_o1, v_a, v_recipe, 'S809 1j probe', 'Other', 3, 100, 0.13, true, 3),
           (v_o2, v_a, v_recipe, 'S809 1j probe', 'Other', 3, 100, 0.13, true, 3),
           (v_o3, v_a, v_recipe, 'S809 1j probe', 'Other', 3, 100, 0.13, false, 1);

    -- ── As the Owner ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);
    SET LOCAL ROLE authenticated;
    IF NOT COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'S809 1j probe: % is not an Owner login', v_owner;
    END IF;
    IF NOT public.caller_can_set_menu_price() THEN
      RAISE EXCEPTION 'S809 1j probe: the Owner can no longer set a menu price';
    END IF;

    -- (a) CHECKOUT-16: a part-comp outside 1..qty-1, or not a whole number, is refused and worded.
    FOR v_bad IN SELECT t.v FROM jsonb_array_elements('[5, 3, 0, -3, 1.5, "two", null]'::jsonb) AS t(v)
    LOOP
      BEGIN
        PERFORM public.apply_pos_item_comps(v_o1, v_a, v_fy, 'S809 probe', NULL, ARRAY[]::uuid[],
          jsonb_build_array(jsonb_build_object('recipe_id', v_recipe, 'comp_qty', v_bad)));
        RAISE EXCEPTION 'S809 1j probe: a part-comp of % of 3 was accepted', v_bad;
      EXCEPTION WHEN invalid_parameter_value THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        IF v_hint IS DISTINCT FROM 'pos_comp_qty_invalid' THEN
          RAISE EXCEPTION 'S809 1j probe: the part-comp of % was refused with hint %', v_bad, v_hint;
        END IF;
      END;
    END LOOP;
    -- Missing altogether is refused the same way.
    BEGIN
      PERFORM public.apply_pos_item_comps(v_o1, v_a, v_fy, 'S809 probe', NULL, ARRAY[]::uuid[],
        jsonb_build_array(jsonb_build_object('recipe_id', v_recipe)));
      RAISE EXCEPTION 'S809 1j probe: a part-comp with no quantity was accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;

    -- (b) a legitimate part-comp: 1 of 3 fired. The sent count is split 2 + 1, never above qty.
    v_no := public.apply_pos_item_comps(v_o1, v_a, v_fy, 'S809 probe', v_pin, ARRAY[]::uuid[],
      jsonb_build_array(jsonb_build_object('recipe_id', v_recipe, 'comp_qty', 1)));
    IF v_no IS NULL THEN
      RAISE EXCEPTION 'S809 1j probe: the part-comp returned no NC number';
    END IF;
    -- (c) o3: 2 of 3 comped where only 1 was fired, the quantity sent as text. The comp takes the
    -- fired one; the line's total sent stays 1.
    PERFORM public.apply_pos_item_comps(v_o3, v_a, v_fy, 'S809 probe', NULL, ARRAY[]::uuid[],
      jsonb_build_array(jsonb_build_object('recipe_id', v_recipe, 'comp_qty', '2')));

    -- Reads as the migration's role, so no policy can make a count vacuous.
    RESET ROLE;
    SELECT i.qty, i.sent_qty INTO v_qty, v_sent FROM public.pos_order_items i WHERE i.order_id = v_o1 AND NOT i.comped;
    IF v_qty IS DISTINCT FROM 2 OR v_sent IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'S809 1j probe: after comping 1 of 3 fired the charged line is qty %, sent_qty %', v_qty, v_sent;
    END IF;
    -- p_comped_by named the PIN login; an Owner's comp is still credited to the Owner (S579).
    SELECT i.qty, i.sent_qty, i.comped_by, i.comp_no INTO v_qty, v_sent, v_by, v_n
      FROM public.pos_order_items i WHERE i.order_id = v_o1 AND i.comped;
    IF v_qty IS DISTINCT FROM 1 OR v_sent IS DISTINCT FROM 1 OR v_by IS DISTINCT FROM v_owner OR v_n IS DISTINCT FROM v_no THEN
      RAISE EXCEPTION 'S809 1j probe: the comped row of o1 is qty %, sent_qty %, by %, NC %', v_qty, v_sent, v_by, v_n;
    END IF;
    SELECT i.qty, i.sent_qty INTO v_qty, v_sent FROM public.pos_order_items i WHERE i.order_id = v_o3 AND NOT i.comped;
    IF v_qty IS DISTINCT FROM 1 OR v_sent IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'S809 1j probe: after comping 2 of 3 (1 fired) the charged line is qty %, sent_qty %', v_qty, v_sent;
    END IF;
    SELECT i.qty, i.sent_qty INTO v_qty, v_sent FROM public.pos_order_items i WHERE i.order_id = v_o3 AND i.comped;
    IF v_qty IS DISTINCT FROM 2 OR v_sent IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'S809 1j probe: the comped row of o3 is qty %, sent_qty %', v_qty, v_sent;
    END IF;

    -- (d) the till's next save of o1's charged line, at its new quantity, records no pull. Before
    -- this slice the charged row kept sent_qty 3 and this save recorded a pull of 1.
    SET LOCAL ROLE authenticated;
    PERFORM public.save_pos_order_items(v_o1,
      jsonb_build_array(jsonb_build_object('recipe_id', v_recipe, 'name', 'S809 1j probe', 'qty', 2,
                                           'sent_to_kot', true, 'sent_qty', 2)), NULL, NULL);
    PERFORM set_config('crest.pos_items_rpc', 'off', true);
    RESET ROLE;
    SELECT count(*) INTO v_n FROM public.pos_kot_removals WHERE order_id = v_o1;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 1j probe: saving the charged line after a part-comp recorded % pull(s)', v_n;
    END IF;
    SELECT i.qty, i.sent_qty INTO v_qty, v_sent FROM public.pos_order_items i WHERE i.order_id = v_o1;
    IF v_qty IS DISTINCT FROM 2 OR v_sent IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'S809 1j probe: after the save o1 is qty %, sent_qty %', v_qty, v_sent;
    END IF;
    SELECT count(*) INTO v_n FROM public.pos_order_items WHERE order_id = v_o2 AND qty = 3 AND NOT comped;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1j probe: o2 was touched before its own test';
    END IF;

    -- ── As the PIN login, a POS supervisor ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    -- (e) unblocked: comps 1 of the 2 left on o1; the comp is credited to this login.
    PERFORM public.apply_pos_item_comps(v_o1, v_a, v_fy, 'S809 probe', v_owner, ARRAY[]::uuid[],
      jsonb_build_array(jsonb_build_object('recipe_id', v_recipe, 'comp_qty', 1)));
    IF public.caller_can_set_menu_price() THEN
      RAISE EXCEPTION 'S809 1j probe: a POS supervisor may set a menu price';
    END IF;
    RESET ROLE;
    SELECT comped_by INTO v_by FROM public.pos_order_items WHERE order_id = v_o1 AND comped;
    IF v_by IS DISTINCT FROM v_pin THEN
      RAISE EXCEPTION 'S809 1j probe: the supervisor''s comp was credited to %', v_by;
    END IF;

    -- (f) ACCESS-9: the same login once a Final Settlement has blocked it, its token still live.
    UPDATE public.profiles SET settlement_blocked_by = v_settle WHERE id = v_pin;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.apply_pos_item_comps(v_o2, v_a, v_fy, 'S809 probe', NULL, ARRAY[]::uuid[],
        jsonb_build_array(jsonb_build_object('recipe_id', v_recipe, 'comp_qty', 1)));
      RAISE EXCEPTION 'S809 1j probe: a settlement-blocked supervisor comped a dish';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE 'complimentary items require Supervisor%' THEN
        RAISE EXCEPTION 'S809 1j probe: the blocked comp was refused with %', v_msg;
      END IF;
    END;
    RESET ROLE;

    -- ── The same login as a POS manager: menu price and till setup, unblocked then blocked ──
    UPDATE public.profiles SET pos_role = 'manager', settlement_blocked_by = NULL WHERE id = v_pin;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF NOT public.caller_can_set_menu_price() THEN
      RAISE EXCEPTION 'S809 1j probe: a POS manager may no longer set a menu price';
    END IF;
    UPDATE public.settings
       SET pos_open_time = CASE WHEN pos_open_time IS DISTINCT FROM '06:15' THEN '06:15' ELSE '06:45' END
     WHERE client_id = v_a;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1j probe: a POS manager''s till-setup save changed % row(s)', v_n;
    END IF;
    UPDATE public.settings SET pos_custom_roles = COALESCE(pos_custom_roles, '[]'::jsonb) || '["S809 1j probe"]'::jsonb
     WHERE client_id = v_a;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1j probe: a POS manager''s role-list save changed % row(s)', v_n;
    END IF;
    RESET ROLE;

    UPDATE public.profiles SET settlement_blocked_by = v_settle WHERE id = v_pin;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF public.caller_can_set_menu_price() THEN
      RAISE EXCEPTION 'S809 1j probe: a settlement-blocked POS manager may set a menu price';
    END IF;
    BEGIN
      UPDATE public.settings
         SET pos_open_time = CASE WHEN pos_open_time IS DISTINCT FROM '07:15' THEN '07:15' ELSE '07:45' END
       WHERE client_id = v_a;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      RAISE EXCEPTION 'S809 1j probe: a settlement-blocked POS manager''s till-setup save was not refused (% row(s))', v_n;
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_setup_rank' THEN
        RAISE EXCEPTION 'S809 1j probe: the blocked till-setup save was refused with hint %', v_hint;
      END IF;
    END;
    BEGIN
      UPDATE public.settings SET pos_custom_roles = COALESCE(pos_custom_roles, '[]'::jsonb) || '["S809 1j probe 2"]'::jsonb
       WHERE client_id = v_a;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      RAISE EXCEPTION 'S809 1j probe: a settlement-blocked POS manager''s role-list save was not refused (% row(s))', v_n;
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE 'staff_roles_rank:%' THEN
        RAISE EXCEPTION 'S809 1j probe: the blocked role-list save was refused with %', v_msg;
      END IF;
    END;
    RESET ROLE;

    -- ── An IMS manager keeps the menu price; blocked, or a stock-count PIN, does not ──
    UPDATE public.profiles SET pos_role = NULL, ims_role = 'manager', settlement_blocked_by = NULL WHERE id = v_pin;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_ok := public.caller_can_set_menu_price();
    RESET ROLE;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'S809 1j probe: an IMS manager may no longer set a menu price';
    END IF;
    UPDATE public.profiles SET settlement_blocked_by = v_settle WHERE id = v_pin;
    SET LOCAL ROLE authenticated;
    v_ok := public.caller_can_set_menu_price();
    RESET ROLE;
    IF v_ok THEN
      RAISE EXCEPTION 'S809 1j probe: a settlement-blocked IMS manager may set a menu price';
    END IF;
    UPDATE public.profiles
       SET settlement_blocked_by = NULL, ims_email = 's809-1j-probe-' || gen_random_uuid() || '@ims.invalid'
     WHERE id = v_pin;
    SET LOCAL ROLE authenticated;
    v_ok := public.caller_can_set_menu_price();
    RESET ROLE;
    IF v_ok THEN
      RAISE EXCEPTION 'S809 1j probe: a stock-count PIN login at IMS manager rank may set a menu price';
    END IF;

    -- ── ACCESS-8: a client_secrets row created from now on is born switched off ──
    PERFORM set_config('request.jwt.claims', '', true);
    DELETE FROM public.client_secrets WHERE client_id = v_a;
    INSERT INTO public.client_secrets (client_id) VALUES (v_a) RETURNING pos_legacy_key_retired_at INTO v_at;
    IF v_at IS NULL THEN
      RAISE EXCEPTION 'S809 1j probe: a new client_secrets row has the shared key on';
    END IF;
    IF public.verify_pos_legacy_device(v_a, (SELECT pos_device_secret::text FROM public.client_secrets WHERE client_id = v_a)) THEN
      RAISE EXCEPTION 'S809 1j probe: a new row''s shared key passes the sign-in gate';
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_1j_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_1j_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT c.name, cs.pos_legacy_key_retired_at, cs.pos_legacy_key_last_used_at FROM client_secrets cs JOIN clients c ON c.id = cs.client_id;
--   SELECT to_regprocedure('public.get_pos_device_secret(uuid)') IS NULL AND to_regprocedure('public.get_next_pos_comp_slip_no(uuid, text)') IS NULL;
--   SELECT p.proname, md5(p.prosrc) FROM pg_proc p WHERE p.proname IN ('apply_pos_item_comps', 'caller_can_set_menu_price', 'settings_guard_staff_roles');
--   SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'public.pos_order_items'::regclass AND conname = 'pos_order_items_qty_check';
--   SELECT table_name, action, new_data, created_at FROM audit_logs WHERE table_name = 'client_secrets' ORDER BY id DESC LIMIT 3;
