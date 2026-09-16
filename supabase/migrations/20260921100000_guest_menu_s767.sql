-- S767 — the guest QR menu critique (2026-09-16), decisions taken with Aashish.
--
-- Four changes, all behind the public guest menu (src/modules/pos/guestmenu/GuestMenu.jsx):
--
--   1. settings.guest_menu_name / settings.guest_menu_logo_url — the restaurant's own name and logo
--      at the top of its QR menu. Until now the page printed clients.name, the ACCOUNT record, which
--      for a real client reads "BHATTI CHOILA" in capitals beside till inventory names. Decision: the
--      OWNER sets both (POS Setup → Guest Menu); admin can still set them for a client. They are
--      public-facing brand, so they join the settings guard as Owner-only — a waiter's PIN must not
--      be able to rename the restaurant on every table's QR code.
--
--   2. pos_guest_order_requests.order_id — the bill a guest's order went onto, written by the till
--      when staff accept it (PosOrders.jsx performSave). The tracker needs it to answer about THIS
--      guest's order rather than the table's.
--
--   3. get_guest_order_progress(p_request_id) — the tracker's one read. The page used to combine the
--      request's own status with get_guest_table_status, which reports the least-advanced kitchen
--      ticket on the table's CURRENT open bill. Two live consequences, both reproduced in the
--      critique: a second-round order nobody had accepted yet showed "Ready to serve" because the
--      first round's ticket was ready, and once the bill closed the table had no open order, so the
--      tracker fell back to "Confirmed by staff, heading to the kitchen" — and chimed — after the
--      guest had paid. This function reads only tickets on the bill that took the request, sent after
--      the request was made, carrying at least one of its dishes; and says when that bill is closed.
--      get_guest_table_status is left as it is: the page still uses it for a guest who never ordered
--      from this phone, where "the table's order" is the honest subject.
--
--   4. get_guest_menu — three new columns (menu_name, logo_url, category_order) and allergens for
--      EVERY client. Decision: allergen warnings are a safety line, not a paid extra, so they are no
--      longer gated on the Nutrition feature; calorie and nutrient figures still are.
--      category_order is settings.recipe_categories as stored (NULL when never saved): the page orders
--      menu sections by it and applies the app's default list itself, so the default lives in one
--      place (DEFAULT_RECIPE_CATS in SettingsContext.js) rather than being copied into SQL.
--      Adding output columns is not CREATE OR REPLACE-compatible (42P13), hence DROP + CREATE.
--
-- Every function body below was re-created from its LIVE definition (pg_get_functiondef, read
-- 2026-09-16), not from the migration that last touched it — settings_guard_staff_roles had gained
-- the c_ims list in a later migration than the one first found.

-- ── (1) The restaurant's name and logo on its guest menu ────────────────────────────────────────
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS guest_menu_name text;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS guest_menu_logo_url text;

-- A name is a heading on a phone screen, not a paragraph; a logo is an absolute https URL (the
-- guest menu's CSP only loads https://*.supabase.co images, and the page uploads into dish-photos).
ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_guest_menu_name_len;
ALTER TABLE public.settings ADD CONSTRAINT settings_guest_menu_name_len
  CHECK (guest_menu_name IS NULL OR char_length(guest_menu_name) <= 60);
ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_guest_menu_logo_https;
ALTER TABLE public.settings ADD CONSTRAINT settings_guest_menu_logo_https
  CHECK (guest_menu_logo_url IS NULL OR guest_menu_logo_url ~ '^https://');

-- Live body + c_guest_brand. Both new columns default NULL, so c_insert_base needs no entry: on
-- INSERT a NULL column is "not set" already.
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
    FROM unnest(ARRAY['hr_custom_roles', 'ims_custom_roles', 'pos_custom_roles'] || c_tada || c_pos_setup || c_print || c_ims || c_guest_brand) k
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
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.settings_guard_staff_roles() FROM PUBLIC;
-- Trigger unchanged (20260914230000): BEFORE INSERT OR UPDATE ON settings.


-- ── (2) The bill a guest's order went onto ──────────────────────────────────────────────────────
-- SET NULL: a bill deleted outright (Clear Occupied on an open order) must not take the guest's
-- request record with it; the tracker then falls back to the table-based lookup below.
ALTER TABLE public.pos_guest_order_requests
  ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES public.pos_orders(id) ON DELETE SET NULL;
-- Filtered on by nothing in src/ today, but the FK's ON DELETE SET NULL scans this column on every
-- pos_orders delete, and pos_orders is deleted from on every Clear Occupied.
CREATE INDEX IF NOT EXISTS pos_guest_order_requests_order_id_idx
  ON public.pos_guest_order_requests (order_id) WHERE order_id IS NOT NULL;


-- ── (3) The tracker's read ──────────────────────────────────────────────────────────────────────
-- Anon-callable by design, like get_guest_order_request_status: the request id is an unguessable
-- uuid the guest's own phone was handed by submit_guest_order, and the answer carries no money,
-- no names and no dish list — a status, a count of minutes and a boolean.
--
-- status          pending | accepted | dismissed (the request's own)
-- kot_status      new | in_progress | ready — the least-advanced LIVE ticket carrying this request's
--                 dishes on the bill that took it, sent after the request was made. NULL while none
--                 is sent. 'served' reads as ready (as 20260916110000 decided for the table read);
--                 'cancelled' is excluded, where the table read counted it as 'new' forever.
-- remaining_minutes  the kitchen's own estimate, only while in progress and still positive.
-- order_closed    the bill that took this request is no longer open (paid, voided, written off).
CREATE OR REPLACE FUNCTION public.get_guest_order_progress(p_request_id uuid)
RETURNS TABLE(status text, kot_status text, remaining_minutes integer, order_closed boolean)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_req public.pos_guest_order_requests%ROWTYPE;
  v_pos_enabled boolean;
  v_order_id uuid;
  v_order_status text;
  v_recipe_ids text[];
  v_worst int;
  v_max_ready timestamptz;
  v_rank int;
  v_ready timestamptz;
  r RECORD;
BEGIN
  SELECT * INTO v_req FROM public.pos_guest_order_requests q WHERE q.id = p_request_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- pos_enabled stays the first gate on every guest read (S632).
  SELECT c.pos_enabled INTO v_pos_enabled FROM public.clients c WHERE c.id = v_req.client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RETURN; END IF;

  status := v_req.status;
  kot_status := NULL;
  remaining_minutes := NULL;
  order_closed := false;

  IF v_req.status IS DISTINCT FROM 'accepted' THEN
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_req.order_id IS NOT NULL THEN
    SELECT o.id, o.status INTO v_order_id, v_order_status FROM public.pos_orders o WHERE o.id = v_req.order_id;
  END IF;
  -- An accept written before S767, or by a till still on an older bundle, has no order_id. The
  -- bill that took it is the earliest one on this table that was still open when the guest sent
  -- the order — created_at is the SERVER's clock, unlike decided_at, which the tablet writes.
  IF v_order_id IS NULL THEN
    SELECT o.id, o.status INTO v_order_id, v_order_status
      FROM public.pos_orders o
     WHERE o.table_id = v_req.table_id
       AND (o.closed_at IS NULL OR o.closed_at >= v_req.created_at)
     ORDER BY o.opened_at ASC
     LIMIT 1;
  END IF;

  IF v_order_id IS NULL THEN
    RETURN NEXT;
    RETURN;
  END IF;

  order_closed := v_order_status IS DISTINCT FROM 'open';

  SELECT COALESCE(array_agg(DISTINCT e->>'recipe_id'), '{}')
    INTO v_recipe_ids
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_req.items) = 'array' THEN v_req.items ELSE '[]'::jsonb END) e
   WHERE e->>'recipe_id' IS NOT NULL;

  v_worst := NULL;
  v_max_ready := NULL;
  FOR r IN
    SELECT k.status AS kstatus, k.started_at, k.estimated_prep_minutes
      FROM public.pos_kot_log k
     WHERE k.order_id = v_order_id
       AND k.sent_at >= v_req.created_at
       AND k.status IS DISTINCT FROM 'cancelled'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(k.items) = 'array' THEN k.items ELSE '[]'::jsonb END) i
          WHERE i->>'recipe_id' = ANY (v_recipe_ids)
       )
  LOOP
    v_rank := CASE r.kstatus WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'ready' THEN 2 WHEN 'served' THEN 2 ELSE 0 END;
    IF v_worst IS NULL OR v_rank < v_worst THEN v_worst := v_rank; END IF;
    IF r.kstatus = 'in_progress' AND r.started_at IS NOT NULL AND r.estimated_prep_minutes IS NOT NULL THEN
      v_ready := r.started_at + (r.estimated_prep_minutes * interval '1 minute');
      IF v_max_ready IS NULL OR v_ready > v_max_ready THEN v_max_ready := v_ready; END IF;
    END IF;
  END LOOP;

  kot_status := CASE v_worst WHEN 0 THEN 'new' WHEN 1 THEN 'in_progress' WHEN 2 THEN 'ready' ELSE NULL END;
  remaining_minutes := CASE
    WHEN kot_status = 'in_progress' AND v_max_ready IS NOT NULL
      THEN CEIL(EXTRACT(EPOCH FROM (v_max_ready - now())) / 60)::integer
    ELSE NULL
  END;
  RETURN NEXT;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_guest_order_progress(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_guest_order_progress(uuid) TO anon, authenticated, service_role;


-- ── (4) get_guest_menu: the restaurant's name and logo, section order, allergens for everyone ───
DROP FUNCTION IF EXISTS public.get_guest_menu(uuid);

CREATE FUNCTION public.get_guest_menu(p_table_id uuid)
 RETURNS TABLE(outlet_name text, table_name text, recipe_id uuid, name text, category text, selling_price numeric, vat_rate numeric, description text, image_url text, is_veg boolean, nutrition_enabled boolean, has_nutrition boolean, energy_kcal numeric, protein_g numeric, carbs_g numeric, fat_g numeric, sugar_g numeric, sodium_mg numeric, allergens jsonb, guest_ordering_enabled boolean, is_vat_registered boolean,
               menu_name text, logo_url text, category_order text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id uuid;
  v_table_name text;
  v_table_status text;
  v_outlet_name text;
  v_pos_enabled boolean;
  v_nutrition_enabled boolean;
  v_guest_ordering_enabled boolean;
  v_vat_registered boolean;
  v_menu_name text;
  v_logo_url text;
  v_category_order text[];
  r RECORD;
  roll jsonb;
BEGIN
  SELECT t.client_id, t.name, t.status INTO v_client_id, v_table_name, v_table_status FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN RETURN; END IF;

  SELECT c.name, c.pos_enabled INTO v_outlet_name, v_pos_enabled FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RETURN; END IF;

  SELECT COALESCE(f.nutrition_facts, false) INTO v_nutrition_enabled
  FROM feature_flags f WHERE f.client_id = v_client_id;
  v_nutrition_enabled := COALESCE(v_nutrition_enabled, false);

  -- Fails OPEN to true: no settings row means the client has never been configured either way,
  -- and true is what the column defaults to and what every JS caller assumes.
  SELECT COALESCE(s.is_vat_registered, true), NULLIF(btrim(s.guest_menu_name), ''), NULLIF(btrim(s.guest_menu_logo_url), ''), s.recipe_categories
    INTO v_vat_registered, v_menu_name, v_logo_url, v_category_order
  FROM settings s WHERE s.client_id = v_client_id;
  v_vat_registered := COALESCE(v_vat_registered, true);

  -- S746: ordering comes with POS, except at a table taken out of service. IS DISTINCT FROM, not
  -- <>: status is nullable, and a NULL-status table has never been taken out of service.
  v_guest_ordering_enabled := v_table_status IS DISTINCT FROM 'inactive';

  FOR r IN
    SELECT rc.id, rc.name, rc.category, rc.selling_price, rc.vat_rate, rc.description, rc.image_url, rc.is_veg
    FROM recipes rc
    WHERE rc.client_id = v_client_id AND rc.is_active = true AND rc.pos_enabled = true
      AND rc.category IS DISTINCT FROM 'Sub-Recipe'
      -- S746: an unpriced dish is not on the public menu. `> 0` is NULL-safe here: NULL > 0 is
      -- NULL, which a WHERE treats as false.
      AND rc.selling_price > 0
    ORDER BY rc.category NULLS LAST, rc.name
  LOOP
    -- S767: always rolled up, because allergens now reach every client's guests. The nutrient
    -- figures below are still returned only where the Nutrition feature is on.
    roll := public._nutrition_rollup(r.id);

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
    energy_kcal := CASE WHEN v_nutrition_enabled THEN (roll->>'energy_kcal')::numeric END;
    protein_g := CASE WHEN v_nutrition_enabled THEN (roll->>'protein_g')::numeric END;
    carbs_g := CASE WHEN v_nutrition_enabled THEN (roll->>'carbs_g')::numeric END;
    fat_g := CASE WHEN v_nutrition_enabled THEN (roll->>'fat_g')::numeric END;
    sugar_g := CASE WHEN v_nutrition_enabled THEN (roll->>'sugar_g')::numeric END;
    sodium_mg := CASE WHEN v_nutrition_enabled THEN (roll->>'sodium_mg')::numeric END;
    allergens := COALESCE(roll->'allergens', '[]'::jsonb);
    guest_ordering_enabled := v_guest_ordering_enabled;
    is_vat_registered := v_vat_registered;
    menu_name := v_menu_name;
    logo_url := v_logo_url;
    category_order := v_category_order;
    RETURN NEXT;
  END LOOP;
END;
$function$;
-- The live grants before the DROP were PUBLIC + anon + authenticated + service_role. Anon-callable
-- by design (a diner has no session); stated explicitly rather than left to PUBLIC.
REVOKE ALL ON FUNCTION public.get_guest_menu(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_guest_menu(uuid) TO anon, authenticated, service_role;


-- ── Assertions ──────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n int;
  v_table uuid;
BEGIN
  -- Columns.
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'settings' AND column_name IN ('guest_menu_name', 'guest_menu_logo_url');
  IF v_n <> 2 THEN RAISE EXCEPTION 'S767: settings guest menu columns missing (%)', v_n; END IF;
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'pos_guest_order_requests' AND column_name = 'order_id';
  IF v_n <> 1 THEN RAISE EXCEPTION 'S767: pos_guest_order_requests.order_id missing'; END IF;

  -- The FK is SET NULL, not the default NO ACTION (which would refuse Clear Occupied).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
     WHERE con.conrelid = 'public.pos_guest_order_requests'::regclass AND con.contype = 'f'
       AND a.attname = 'order_id' AND con.confdeltype = 'n'
  ) THEN
    RAISE EXCEPTION 'S767: pos_guest_order_requests.order_id is not ON DELETE SET NULL';
  END IF;

  -- The index leads with order_id.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE i.indrelid = 'public.pos_guest_order_requests'::regclass AND a.attname = 'order_id'
  ) THEN
    RAISE EXCEPTION 'S767: no index leads with pos_guest_order_requests.order_id';
  END IF;

  -- The guard names the new list (it is a trigger: its behaviour is asserted by the live test).
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.settings_guard_staff_roles()'::regprocedure) NOT LIKE '%guest_menu_brand_rank%' THEN
    RAISE EXCEPTION 'S767: settings_guard_staff_roles does not guard the guest menu brand';
  END IF;

  -- Grants: anon can run both public reads; the new function is not left on PUBLIC.
  IF NOT has_function_privilege('anon', 'public.get_guest_menu(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S767: anon cannot execute get_guest_menu — every QR menu would be blank';
  END IF;
  IF NOT has_function_privilege('anon', 'public.get_guest_order_progress(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S767: anon cannot execute get_guest_order_progress';
  END IF;
  SELECT pronargs INTO v_n FROM pg_proc WHERE oid = 'public.get_guest_menu(uuid)'::regprocedure;
  IF v_n <> 1 THEN RAISE EXCEPTION 'S767: get_guest_menu has % arguments', v_n; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'get_guest_menu') <> 1 THEN
    RAISE EXCEPTION 'S767: more than one get_guest_menu signature';
  END IF;

  -- A plpgsql body is only validated when it runs (S735): call both. Neither writes anything.
  SELECT t.id INTO v_table FROM pos_tables t JOIN clients c ON c.id = t.client_id WHERE c.pos_enabled LIMIT 1;
  IF v_table IS NOT NULL THEN
    PERFORM * FROM public.get_guest_menu(v_table);
  END IF;
  PERFORM * FROM public.get_guest_order_progress('00000000-0000-4000-8000-000000000000'::uuid);
  PERFORM * FROM public.get_guest_order_progress((SELECT q.id FROM pos_guest_order_requests q ORDER BY q.created_at DESC LIMIT 1));
END $$;

NOTIFY pgrst, 'reload schema';
