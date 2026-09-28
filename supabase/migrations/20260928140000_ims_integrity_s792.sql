-- S792 — IMS re-analysis, stage 1: the tables S756's rank inventory stopped short of.
--
-- S756 (20260918100000) fenced fifteen IMS tables at the rank their pages apply. The S792 review
-- (docs/ims-review-s792/, IMS_TODO.md "S792") found the rest of the module on plain same-client
-- FOR ALL policies, so an IMS staff login, a 4-digit store-room count PIN, and on some tables a POS
-- PIN waiter could, over the REST API:
--   * switch off the section scope, blind count and recount protection that fence a counter at the
--     database (DATABASE-1, settings);
--   * rewrite Item Master: an item's unit (re-reading every count and bill ×1000), its rate
--     (re-valuing closed months), its category (moving an item into the counter's own section) or
--     its hidden flag; rename a supplier, change its PAN, archive it (MASTER-1, DATABASE-4);
--   * rewrite any month's fixed costs and budgets, closed months included (COSTS-1, DATABASE-3);
--   * insert or delete the open month's sales, the revenue every food-cost figure divides by
--     (DATABASE-2);
--   * mark purchase-order lines received without a bill (DATABASE-4);
--   * enter opening stock, wastage and staff meals from a count PIN whose page shows only the
--     closing count (the known S761 caveat, taken into S792 by the approved plan).
-- It also fixes five smaller things on tables already touched here: a lost counting tablet stayed
-- signed in after "Sign out all counting tablets" (MASTER-3); the HQ push rewrote a branch item's
-- unit and hidden flag (MASTER-2); a PO receipt rounded per-gram prices to 2 decimals (PURCHASES-1);
-- the dashboard's frozen Target could be overwritten by any login (PLANNING-7); gate-pass issuer and
-- exit names were whatever the browser sent (COSTS-15); and a depreciation run double-posted by two
-- tabs (COSTS-16). Supplier payments and overheads join the audit trail (DATABASE-7), a second
-- settings row per client is refused (DATABASE-6), and stray table grants are revoked (DATABASE-8).
--
-- Decisions (Aashish, 2026-09-28, IMS_TODO.md S792.1): D41 — moving Item Master's price from a
-- purchase bill needs an IMS supervisor or above. D5/D25 (S756) are enforced here in the database
-- for the first time: a referenced item's unit cannot change; archiving, restoring or deleting a
-- supplier is the Owner's.
--
-- Every rule below was found by listing the writers first (the S756 method; inventory in the S792
-- session): each guard's rank is the rank of the page that writes the table, or of the POS screen
-- where the till writes it. Carve-outs every guard shares, in this order:
--   * current_user NOT IN ('anon','authenticated') — the service role (Danger Zone, admin-user-ops),
--     SECURITY DEFINER bodies (push_master_data, force_delete_item) and FK cascades.
--     Hence every guard is SECURITY INVOKER.
--   * COALESCE(is_admin(), false) — the operator, including restore.
--   * The Owner, through ims_caller_has_rank / pos_caller_has_rank (is_client_owner(), COALESCE'd).
-- Every authorisation expression is COALESCE'd: NULL IN (...) is NULL, and IF NOT NULL never fires.
--
-- Functions rebuilt here were read live on 2026-09-28 and each body below is its latest migration's
-- body plus the S792 change and nothing else. Block 0 refuses to run if any live body has changed
-- since, so an edit made elsewhere is never silently reverted (supabase-sql.md). The whole file runs
-- as one transaction (a multi-statement query), so a failure part-way leaves nothing behind.
--
-- Reverse: restore each rebuilt function from the migration named beside it, DROP the triggers
-- created here (ims_rank_guard / ims_rank_guard_delete on the tables listed in block 11,
-- ims_closed_period_guard on overheads, audit_payable_payments, audit_overheads), DROP the functions
-- created here, DROP INDEX settings_client_id_key (and re-create idx_settings_client_id), and
-- ALTER purchase_order_items.unit_price back to numeric(12,2).


-- ══ 0. The live bodies this was written against ══════════════════════════════════════════════════

DO $$
DECLARE
  v_expected constant jsonb := '{
    "settings_guard_staff_roles":  "f7fd4f6a79771ab620e6f2a5c91c38ea",
    "ims_monthly_periods_guard":   "085ee0ad3b4665857a031ca4dcc1c440",
    "ims_gate_pass_void_guard":    "b3367ebb70c8c985cfb3ea54c7f74212",
    "rotate_ims_device_secret":    "614733c0847935a42f1bab902e5f188a",
    "receive_purchase_order":      "4f01978230097da5dce52c9b1ad8b4c1",
    "push_master_data":            "9296e9e3f72f23cd9108ceb058603de3",
    "post_asset_depreciation_run": "11ee5c92fe06c24f3c75837dbae11602"
  }'::jsonb;
  k text;
  v_md5 text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(v_expected) LOOP
    SELECT md5(p.prosrc) INTO v_md5
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = k;
    IF v_md5 IS DISTINCT FROM v_expected ->> k THEN
      RAISE EXCEPTION 'S792: % changed since this migration was written (live md5 %) — rebuild it from the live body', k, v_md5;
    END IF;
  END LOOP;
END;
$$;


-- ══ 1. settings: the switches that fence a counter (DATABASE-1) ══════════════════════════════════
--
-- ims_count_scope_enforced, ims_count_blind and require_count_attribution are the settings the
-- S737 section scope, blind count and recount protection read (ims_count_scope_on(),
-- ims_recount_guard_on()). They were in none of the guard's lists, so the counter the scope binds
-- could PATCH it off and then write any section. Their one writer is Stock Count → Settings, shown
-- to admin and the IMS manager (the ims_can_manage_counts() audience); the Owner passes above.
-- All three default false, so they join c_insert_base: a first settings row created by any screen
-- seeds them at their default and must not read as a change.
--
-- Body: 20260923130000 (S786), live md5 f7fd4f6a79771ab620e6f2a5c91c38ea, plus c_ims_count.
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

-- One settings row per client (DATABASE-6). settings_insert allowed any login to add a second row,
-- and every .maybeSingle() settings read then errors: SettingsContext falls back to defaults (the
-- VAT flag and every threshold) and no settings screen can save. Checked live before writing: no
-- client holds two rows. A plain unique index (NULLs stay distinct), so it can also serve as an
-- ON CONFLICT target; it replaces the non-unique index on the same column.
CREATE UNIQUE INDEX IF NOT EXISTS settings_client_id_key ON public.settings (client_id);
DROP INDEX IF EXISTS public.idx_settings_client_id;


-- ══ 2. Helpers ═══════════════════════════════════════════════════════════════════════════════════

-- The recipe_suggestions writer is Menu Pricing, whose audience is admin, the Owner, a POS manager
-- or an IMS manager — two ranks on two axes, which ims_rank_guard cannot express.
CREATE OR REPLACE FUNCTION public.ims_or_pos_rank_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_need text := TG_ARGV[0];
  v_what text := TG_ARGV[1];
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF NOT (public.ims_caller_has_rank(v_need) OR COALESCE(public.pos_caller_has_rank(v_need), false)) THEN
    RAISE EXCEPTION '%: % needs an IMS or POS % or the account owner', TG_TABLE_NAME, v_what, v_need
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.ims_or_pos_rank_guard() FROM PUBLIC;

-- Whether an item has any recorded history, for the HQ push. The same twelve tables as
-- item_reference_counts (20260919120000), in the same order, but with no caller scoping: the push
-- asks about a BRANCH item, which is not the caller's my_client_id(), so item_reference_counts'
-- own scope would answer "no history" for every one of them. Owner-only EXECUTE (no grant back):
-- it is called only from inside push_master_data, a SECURITY DEFINER body running as the owner.
CREATE OR REPLACE FUNCTION public.item_has_references(p_item_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (SELECT 1 FROM vendor_returns         WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM recipe_ingredients     WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM pos_option_ingredients WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM requisition_lines      WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM staff_meals            WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM wastages               WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM opening_stock          WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM closing_stock          WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM par_levels             WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM purchase_order_items   WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM stock_movements        WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM purchase_entries       WHERE item_id = p_item_id)
$$;
REVOKE ALL ON FUNCTION public.item_has_references(uuid) FROM PUBLIC;


-- ══ 3. Item Master, suppliers and item categories (MASTER-1, DATABASE-4, D5, D25, D41) ════════════
--
-- items — writers: Item Master (add, edit, hide, delete: supervisor), Recipe Costing's sub-recipe
-- mirror item and nutrition (supervisor; hiding a deleted recipe's mirror is manager), Settings →
-- Renumber (manager), Supplier Price Tracker (manager), and the purchase-bill price prompt, which
-- was open to an IMS staff login and is supervisor from S792 by D41 (the page hides it below that).
-- push_master_data and force_delete_item are DEFINER; restore and Clear Conversions are admin.
-- So every write is supervisor+, which also refuses the count PIN (ims_caller_has_rank).
--
-- D5 in the database: once an item has any recorded history, its unit is fixed. Every stored
-- quantity of that item is read in its unit, so ML → LTR re-reads a year of counts and bills ×1000
-- and the per-ML rate becomes a per-LTR rate. Item Master already refuses in the browser; this is
-- the version the browser cannot skip. The Owner is bound too — D5 is "hide it and create a new
-- item", for everyone. Sub-recipe mirror items are exempt: their unit follows the recipe's yield
-- unit, which Recipe Costing edits, and refusing it there would block saving the recipe.
CREATE OR REPLACE FUNCTION public.ims_items_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF NOT public.ims_caller_has_rank('supervisor') THEN
    RAISE EXCEPTION 'items: % needs an IMS supervisor, a manager or the account owner',
      CASE TG_OP WHEN 'INSERT' THEN 'adding an item' WHEN 'DELETE' THEN 'deleting an item' ELSE 'changing an item' END
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.uom IS DISTINCT FROM OLD.uom AND NOT COALESCE(OLD.is_sub_recipe, false)
     AND EXISTS (SELECT 1 FROM public.item_reference_counts(ARRAY[OLD.id])) THEN
    RAISE EXCEPTION 'items: % already has purchases, counts or recipe lines recorded in %, so its unit cannot change', OLD.name, OLD.uom
      USING ERRCODE = '42501', HINT = 'item_unit_locked';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.ims_items_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS ims_rank_guard ON public.items;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.items
  FOR EACH ROW EXECUTE FUNCTION public.ims_items_guard();

-- vendors — writers: Vendors (add, edit, hide: supervisor; archive, restore, delete: Owner or
-- admin, D25), Outstanding Payables' payment terms and Settings → Renumber (manager). Archiving
-- sets archived_at (and is_active), restoring clears it; a supplier inserted already archived is
-- the same act. vendors_guard_referenced_delete (S708) still refuses deleting one with history.
CREATE OR REPLACE FUNCTION public.ims_vendors_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE'
     OR (TG_OP = 'UPDATE' AND NEW.archived_at IS DISTINCT FROM OLD.archived_at)
     OR (TG_OP = 'INSERT' AND NEW.archived_at IS NOT NULL) THEN
    IF NOT COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'vendors: archiving, restoring or deleting a supplier needs the account owner'
        USING ERRCODE = '42501', HINT = 'ims_rank';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF NOT public.ims_caller_has_rank('supervisor') THEN
    RAISE EXCEPTION 'vendors: % needs an IMS supervisor, a manager or the account owner',
      CASE TG_OP WHEN 'INSERT' THEN 'adding a supplier' ELSE 'changing a supplier' END
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.ims_vendors_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS ims_rank_guard ON public.vendors;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.vendors
  FOR EACH ROW EXECUTE FUNCTION public.ims_vendors_guard();

-- categories (item categories) — writers: Item Master's Load Default Categories and Recipe
-- Costing's "Sub-Recipes" row (supervisor), push_master_data (DEFINER), restore (admin). Nothing in
-- the app deletes one, and a delete cascades the category's budgets for every month and its count
-- assignments, so DELETE is manager.
DROP TRIGGER IF EXISTS ims_rank_guard ON public.categories;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE ON public.categories
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('supervisor', 'changing item categories');
DROP TRIGGER IF EXISTS ims_rank_guard_delete ON public.categories;
CREATE TRIGGER ims_rank_guard_delete BEFORE DELETE ON public.categories
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('manager', 'deleting an item category');


-- ══ 4. Overheads and budgets (COSTS-1, DATABASE-3) ═══════════════════════════════════════════════
--
-- overheads — one writer, Overheads (manager: delete the month's rows, insert the new set), which
-- also locks a closed month for everyone but the Owner and admin. That lock was the page's alone;
-- D1's list simply missed the table, so it joins ims_closed_period_guard here.
-- budgets — one writer, Budget vs Actual (supervisor, an upsert on blur).
DROP TRIGGER IF EXISTS ims_rank_guard ON public.overheads;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.overheads
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('manager', 'recording overheads');
DROP TRIGGER IF EXISTS ims_closed_period_guard ON public.overheads;
CREATE TRIGGER ims_closed_period_guard BEFORE INSERT OR UPDATE OR DELETE ON public.overheads
  FOR EACH ROW EXECUTE FUNCTION public.ims_closed_period_guard();

DROP TRIGGER IF EXISTS ims_rank_guard ON public.budgets;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.budgets
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('supervisor', 'setting a budget');


-- ══ 5. Opening stock, wastage and staff meals: not a count PIN (DATABASE-4, the S761 caveat) ══════
--
-- Writers: Stock Count's Opening, Wastage, Daily Wastage and Staff Meals tabs (an IMS staff login),
-- and the month-end carry-forward (Owner or IMS supervisor+, closePeriod.js). A count PIN's page
-- shows the Closing tab alone since S761, but only on screen: its JWT could still write these three
-- over REST, and the offline replay on a shared tablet could land another login's queued opening or
-- wastage edits under it. closing_stock stays as it is — the count PIN's one table, fenced by the
-- S737 scope and recount rules.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['opening_stock', 'wastages', 'staff_meals'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS ims_rank_guard ON public.%I', t);
    EXECUTE format('CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard(%L, %L)',
                   t, 'staff', 'entering stock figures');
  END LOOP;
END;
$$;


-- ══ 6. sales_entries, by source (DATABASE-2) ═════════════════════════════════════════════════════
--
-- The twin of ims_stock_movements_guard (S756 §5), which fenced the ledger and left the revenue.
-- Writers by source:
--   'manual'           Sales Entry through save_sales_day (INVOKER), an IMS staff login.
--   'pos', 'pos_comp'  the till's bill close (Pay / Complimentary, POS supervisor+ — the same rank
--                      guard_pos_order_close requires) and the POS backfill on Periods (Owner or
--                      IMS supervisor+).
--   'pos_credit'       a credit note (POS manager) and the credit-note backfill (Owner or IMS
--                      supervisor+).
--   NULL               legacy rows only; nothing writes it today. Treated as manual, which is what
--                      save_sales_day's delete already does.
-- Nothing in the app UPDATEs a row, and nothing but Danger Zone (service role) deletes a POS row.
-- So an UPDATE is manual-to-manual only, and a POS-sourced row is removed only by the Owner.
CREATE OR REPLACE FUNCTION public.ims_sales_entries_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_old text;
  v_new text;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false)
     OR COALESCE(public.is_client_owner(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP <> 'INSERT' THEN v_old := COALESCE(OLD.source, 'manual'); END IF;
  IF TG_OP <> 'DELETE' THEN v_new := COALESCE(NEW.source, 'manual'); END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_new = 'manual' AND public.ims_caller_has_rank('staff') THEN
      RETURN NEW;
    ELSIF v_new IN ('pos', 'pos_comp')
          AND (COALESCE(public.pos_caller_has_rank('supervisor'), false) OR public.ims_caller_has_rank('supervisor')) THEN
      RETURN NEW;
    ELSIF v_new = 'pos_credit'
          AND (COALESCE(public.pos_caller_has_rank('manager'), false) OR public.ims_caller_has_rank('supervisor')) THEN
      RETURN NEW;
    END IF;
  ELSIF v_old = 'manual' AND COALESCE(v_new, 'manual') = 'manual' AND public.ims_caller_has_rank('staff') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION 'sales_entries: this sale (%) cannot be % from this login', COALESCE(v_new, v_old),
    CASE TG_OP WHEN 'INSERT' THEN 'recorded' WHEN 'DELETE' THEN 'removed' ELSE 'changed' END
    USING ERRCODE = '42501', HINT = 'ims_rank';
END;
$$;
REVOKE ALL ON FUNCTION public.ims_sales_entries_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS ims_rank_guard ON public.sales_entries;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.sales_entries
  FOR EACH ROW EXECUTE FUNCTION public.ims_sales_entries_guard();


-- ══ 7. Purchase orders (DATABASE-4, PURCHASES-1) ═════════════════════════════════════════════════
--
-- Writers: Purchase Orders (supervisor) — create a draft with its lines at qty_received 0, edit a
-- draft (replace its lines), mark it sent or cancelled; delete is admin (purchase_orders_guard_delete,
-- S709). receive_purchase_order (INVOKER) is the only writer of qty_received and of the
-- partial/received status, and S709 built its whole double-receive protection on that being true —
-- it was not: a client could PATCH qty_received back to 0 and receive the delivery again. The
-- receipt now marks its own transaction (a transaction-local setting a REST request cannot set) and
-- those columns refuse any write that does not carry that mark.
CREATE OR REPLACE FUNCTION public.ims_purchase_order_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_receipt text := current_setting('crest.po_receipt', true);
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF NOT public.ims_caller_has_rank('supervisor') THEN
    RAISE EXCEPTION '%: purchase orders need an IMS supervisor, a manager or the account owner', TG_TABLE_NAME
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;

  IF TG_TABLE_NAME = 'purchase_order_items' THEN
    IF (TG_OP = 'INSERT' AND COALESCE(NEW.qty_received, 0) <> 0)
       OR (TG_OP = 'UPDATE' AND NEW.qty_received IS DISTINCT FROM OLD.qty_received
           AND v_receipt IS DISTINCT FROM NEW.po_id::text) THEN
      RAISE EXCEPTION 'purchase_order_items: a received quantity is recorded only by receiving the delivery'
        USING ERRCODE = '42501', HINT = 'po_receipt_only';
    END IF;
  ELSIF TG_OP <> 'DELETE'
        AND NEW.status IN ('partial', 'received')
        AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status)
        AND v_receipt IS DISTINCT FROM NEW.id::text THEN
    RAISE EXCEPTION 'purchase_orders: an order is marked received only by receiving the delivery'
      USING ERRCODE = '42501', HINT = 'po_receipt_only';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.ims_purchase_order_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS ims_rank_guard ON public.purchase_orders;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.ims_purchase_order_guard();
DROP TRIGGER IF EXISTS ims_rank_guard ON public.purchase_order_items;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public.ims_purchase_order_guard();

-- PURCHASES-1. POs are in base units by design (S709) and items are stored in their smallest unit
-- (S597), so most per-unit prices are sub-rupee with 3–4 decimals: sugar at NPR 0.115/GM saved as
-- 0.12 and received at +4.3%; anything under 0.005 saved as 0.00 and received as a free line.
-- Checked live: no view depends on this column.
ALTER TABLE public.purchase_order_items ALTER COLUMN unit_price TYPE numeric;

-- Body: 20260918100000 (S756), live md5 4f01978230097da5dce52c9b1ad8b4c1, plus the receipt mark and
-- the rate kept to 6 decimals instead of 2.
CREATE OR REPLACE FUNCTION public.receive_purchase_order(p_po_id uuid, p_bs_day integer, p_payment_method text, p_vat_inclusive boolean, p_group_id uuid, p_lines jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_po        purchase_orders%ROWTYPE;
  v_period    monthly_periods%ROWTYPE;
  v_line      jsonb;
  v_item      purchase_order_items%ROWTYPE;
  v_qty       numeric;
  v_remaining numeric;
  v_updated   integer;
  v_all       boolean;
  v_any       boolean;
  v_status    text;
BEGIN
  IF p_po_id IS NULL THEN
    RAISE EXCEPTION 'p_po_id is required';
  END IF;
  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'p_group_id is required';
  END IF;
  IF p_bs_day IS NULL OR p_bs_day < 1 OR p_bs_day > 32 THEN
    RAISE EXCEPTION 'p_bs_day must be 1-32';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'p_lines must be a non-empty json array';
  END IF;

  -- FOR UPDATE: this is the row every concurrent receipt against this PO must queue behind, so
  -- the remaining-quantity checks below are evaluated one receipt at a time rather than by two
  -- browsers reading the same "remaining" and each deciding it fits.
  SELECT * INTO v_po FROM purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'po_not_found: purchase order % is not available', p_po_id
      USING ERRCODE = 'P0001',
            HINT = 'Reload the Purchase Orders list.';
  END IF;

  IF v_po.status IN ('cancelled', 'received') THEN
    RAISE EXCEPTION 'po_not_receivable: purchase order % is %', v_po.po_number, v_po.status
      USING ERRCODE = 'P0001',
            HINT = 'A cancelled or fully received order cannot take another delivery. Raise a new PO.';
  END IF;

  -- Fail CLOSED if the period cannot be read: an unreadable period is not an open one.
  SELECT * INTO v_period FROM monthly_periods WHERE id = v_po.period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'po_not_found: the period behind purchase order % is not available', v_po.po_number
      USING ERRCODE = 'P0001',
            HINT = 'Reload the Purchase Orders list.';
  END IF;

  -- The closed-period lock. Admin and the Owner edit a closed month in place (S756, D1); the
  -- purchase_entries trigger enforces the same pair, this only refuses before any row is touched.
  IF v_period.status = 'closed' AND NOT public.caller_can_edit_closed_period() THEN
    RAISE EXCEPTION 'po_period_closed: period % is closed', v_po.period_id
      USING ERRCODE = 'P0001',
            HINT = 'Ask the account owner to enter it, or receive the delivery into the open period.';
  END IF;

  -- S792: this transaction is receiving THIS order, and only it may write qty_received and the
  -- received status (ims_purchase_order_guard). Transaction-local, cleared again before returning.
  PERFORM set_config('crest.po_receipt', p_po_id::text, true);

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_qty := round(COALESCE((v_line ->> 'qty')::numeric, 0), 3);
    IF v_qty <= 0 THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_item
      FROM purchase_order_items
     WHERE id = (v_line ->> 'po_item_id')::uuid
       AND po_id = p_po_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'po_receipt_stale: line % is not on purchase order %', v_line ->> 'po_item_id', v_po.po_number
        USING ERRCODE = 'P0001',
              HINT = 'The order changed since this screen was opened. Nothing was received; reopen it from the list.';
    END IF;

    v_remaining := round(v_item.qty_ordered - COALESCE(v_item.qty_received, 0), 3);
    IF v_qty > v_remaining THEN
      RAISE EXCEPTION 'po_over_receive: % over the % still on order for line %', v_qty - v_remaining, v_remaining, v_item.id
        USING ERRCODE = 'P0001',
              HINT = 'Someone may have received against this order already. Reopen it to see what is left.';
    END IF;

    -- S792: 6 decimals, not 2. A per-gram rate of 0.115 was booked as 0.12, and 0.004 as a free line.
    INSERT INTO purchase_entries
      (period_id, item_id, vendor_id, bs_day, qty, rate, invoice_ref,
       payment_method, vat_inclusive, purchase_group_id, po_id)
    VALUES
      (v_po.period_id, v_item.item_id, v_po.vendor_id, p_bs_day, v_qty,
       COALESCE(round((v_line ->> 'rate')::numeric, 6), 0),
       v_po.po_number,
       COALESCE(NULLIF(p_payment_method, ''), 'Credit'),
       COALESCE(p_vat_inclusive, false),
       p_group_id,
       p_po_id);

    UPDATE purchase_order_items
       SET qty_received = COALESCE(qty_received, 0) + v_qty
     WHERE id = v_item.id AND po_id = p_po_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RAISE EXCEPTION 'po_receipt_stale: could not record the received quantity for line %', v_item.id
        USING ERRCODE = 'P0001',
              HINT = 'Nothing was received. Reopen the order from the list and try again.';
    END IF;
  END LOOP;

  SELECT bool_and(COALESCE(qty_received, 0) >= qty_ordered),
         bool_or(COALESCE(qty_received, 0) > 0)
    INTO v_all, v_any
    FROM purchase_order_items WHERE po_id = p_po_id;

  v_status := CASE WHEN v_all THEN 'received'
                   WHEN v_any THEN 'partial'
                   ELSE v_po.status END;

  IF v_status IS DISTINCT FROM v_po.status THEN
    UPDATE purchase_orders SET status = v_status WHERE id = p_po_id;
  END IF;

  PERFORM set_config('crest.po_receipt', '', true);
  RETURN v_status;
END;
$function$;


-- ══ 8. Demand forecast and upsell prompts (DATABASE-4) ═══════════════════════════════════════════
--
-- demand_forecast_daily / demand_forecast_run_log — one writer, Demand Forecast's Recompute
-- (supervisor); Roster reads it, and recipe deletes cascade (owner). recipe_suggestions — Menu
-- Pricing (admin, Owner, POS or IMS manager); recipe deletes cascade.
DROP TRIGGER IF EXISTS ims_rank_guard ON public.demand_forecast_daily;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.demand_forecast_daily
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('supervisor', 'recomputing the demand forecast');
DROP TRIGGER IF EXISTS ims_rank_guard ON public.demand_forecast_run_log;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.demand_forecast_run_log
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('supervisor', 'recomputing the demand forecast');

DROP TRIGGER IF EXISTS ims_rank_guard ON public.recipe_suggestions;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recipe_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.ims_or_pos_rank_guard('manager', 'changing the upsell suggestions');


-- ══ 9. Months: the dashboard's frozen Target (PLANNING-7) ════════════════════════════════════════
--
-- S756 left the two projection snapshots writable by any viewer on purpose — a staff viewer's
-- capture must land — and relied on the browser's "replace only an older model" filter. That filter
-- is the browser's: over REST any login could replace the current Target mid-month with anything,
-- and a stale bundle whose model is OLDER than the stored one matched "model <> mine" and wrote its
-- older snapshot back over the newer one. Now a snapshot may be written only as a well-formed
-- snapshot (a numeric model and a byWeekday array) of a strictly newer model than the one stored,
-- or into an empty column. Admin passes above, as before.
--
-- Body: 20260918100000 (S756), live md5 085ee0ad3b4665857a031ca4dcc1c440, plus the snapshot block.
CREATE OR REPLACE FUNCTION public.ims_monthly_periods_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  c_free constant text[] := ARRAY['sales_projection_snapshot', 'purch_projection_snapshot'];
  v_changed text[];
  v_owner boolean;
  v_col text;
  v_o jsonb;
  v_n jsonb;
BEGIN
  IF TG_OP = 'DELETE' OR current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  v_owner := COALESCE(public.is_client_owner(), false);

  IF TG_OP = 'INSERT' THEN
    IF NOT public.ims_caller_has_rank('supervisor') THEN
      RAISE EXCEPTION 'monthly_periods: starting a month needs the account owner or an IMS supervisor or manager'
        USING ERRCODE = '42501', HINT = 'period_rank';
    END IF;
    IF NEW.status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'monthly_periods: a month starts open and is closed with End Period'
        USING ERRCODE = '42501', HINT = 'period_rank';
    END IF;
    RETURN NEW;
  END IF;

  -- S792: the frozen Target moves forward only.
  FOREACH v_col IN ARRAY c_free LOOP
    v_o := to_jsonb(OLD) -> v_col;
    v_n := to_jsonb(NEW) -> v_col;
    IF v_n IS DISTINCT FROM v_o THEN
      IF jsonb_typeof(v_n -> 'model') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_n -> 'byWeekday') IS DISTINCT FROM 'array'
         OR (jsonb_typeof(v_o -> 'model') = 'number' AND (v_n ->> 'model')::numeric <= (v_o ->> 'model')::numeric) THEN
        RAISE EXCEPTION 'monthly_periods: this month''s target is already set, and only a newer forecast can replace it'
          USING ERRCODE = '42501', HINT = 'snapshot_frozen';
      END IF;
    END IF;
  END LOOP;

  SELECT COALESCE(array_agg(k), '{}') INTO v_changed
    FROM jsonb_object_keys(to_jsonb(NEW)) k
   WHERE NOT (k = ANY (c_free))
     AND (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k);
  IF cardinality(v_changed) = 0 THEN
    RETURN NEW;
  END IF;

  -- Closing the month: the Periods page's own audience.
  IF v_changed = ARRAY['status'] AND OLD.status = 'open' AND NEW.status = 'closed' THEN
    IF public.ims_caller_has_rank('supervisor') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'monthly_periods: closing the month needs the account owner or an IMS supervisor or manager'
      USING ERRCODE = '42501', HINT = 'period_rank';
  END IF;

  -- Reopening, relabelling (which moves every row of the month into another reporting month) and
  -- anything else: the Owner.
  IF v_owner THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'monthly_periods: reopening or renaming a month needs the account owner (%)', array_to_string(v_changed, ', ')
    USING ERRCODE = '42501', HINT = 'period_rank';
END;
$$;


-- ══ 10. Counting tablets: sign-out means signed out (MASTER-3) ═══════════════════════════════════
--
-- Rotating ims_device_secret stopped the NEXT sign-in only. A tablet already signed in held an
-- ordinary Supabase session that nothing re-checked, so the lost-tablet case the button exists for
-- stayed signed in. Now the count logins' sessions (and, by cascade, their refresh tokens) are
-- deleted too; an access token already issued lives out its remaining minutes (at most an hour).
-- A separate function so admin-user-ops' revokeClientTablets (service role) can call it: EXECUTE
-- is the service role's only, and rotate_ims_device_secret reaches it as the owner.
CREATE OR REPLACE FUNCTION public.ims_revoke_count_sessions(p_client_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM auth.sessions
   WHERE user_id IN (SELECT p.id FROM profiles p WHERE p.client_id = p_client_id AND p.ims_email IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.ims_revoke_count_sessions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ims_revoke_count_sessions(uuid) TO service_role;

-- Body: 20260918100000 (S756), live md5 614733c0847935a42f1bab902e5f188a, plus the session revoke.
CREATE OR REPLACE FUNCTION public.rotate_ims_device_secret(p_client_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := (select auth.uid());
  v_signed_out integer;
BEGIN
  IF NOT COALESCE(
       public.is_admin() OR (p_client_id = public.my_client_id() AND public.ims_can_manage_counts()),
     false) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO client_secrets (client_id, ims_device_secret, ims_enrol_token, ims_enrol_token_expires_at)
  VALUES (p_client_id, gen_random_uuid(), NULL, NULL)
  ON CONFLICT (client_id) DO UPDATE
    SET ims_device_secret = gen_random_uuid(),
        ims_enrol_token = NULL,
        ims_enrol_token_expires_at = NULL,
        updated_at = now();

  -- S792: the tablets already signed in, not only the next sign-in.
  v_signed_out := public.ims_revoke_count_sessions(p_client_id);

  INSERT INTO audit_logs (client_id, client_name, user_id, user_name, table_name, action, record_id, old_data, new_data)
  SELECT p_client_id, c.name, v_uid, (SELECT pr.full_name FROM profiles pr WHERE pr.id = v_uid),
         'client_secrets', 'UPDATE', p_client_id, NULL,
         jsonb_build_object('ims_count_tablets_signed_out_at', now(), 'ims_count_sessions_ended', v_signed_out)
    FROM clients c WHERE c.id = p_client_id;
END;
$$;


-- ══ 11. The HQ push does not re-unit a branch's history (MASTER-2) ═══════════════════════════════
--
-- push_master_data matched a branch item to HQ's (by master link or by name) and wrote HQ's unit
-- over it, keeping the branch's rate on purpose. A branch "MILK" counted in ML for a year became
-- LTR: every stored quantity re-read ×1000 and the per-ML rate read as per-LTR, with a preview that
-- said only "matched an existing item of the same name". That is D5's unit change, made from the
-- one path D5 never reached. Now a branch item with recorded history whose unit differs from HQ's
-- is planned as a 'conflict' — shown in the preview, never written — and an existing branch row's
-- hidden flag is left alone (hiding at HQ took the item's stock out of the branch's valuation).
--
-- Body: 20260909120000 (S707), live md5 9296e9e3f72f23cd9108ceb058603de3, plus the unit-conflict
-- lateral and CASE arms, and is_active dropped from the existing-row UPDATE.
CREATE OR REPLACE FUNCTION public.push_master_data(
  p_target_client_ids uuid[],
  p_entities          text[],
  p_dry_run           boolean DEFAULT true
)
RETURNS TABLE (
  target_client_id   uuid,
  target_client_name text,
  entity             text,
  action             text,
  record_name        text,
  detail             text
)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'public'
  AS $fn$
DECLARE
  v_group  uuid;
  v_hq     uuid;
  v_target uuid;
  v_tname  text;
  v_do_cat boolean := 'categories' = ANY (p_entities);
  v_do_itm boolean := 'items'      = ANY (p_entities);
  v_do_rec boolean := 'recipes'    = ANY (p_entities);
  v_do_prc boolean := 'prices'     = ANY (p_entities);
  r        record;
  v_dst    uuid;
  v_item   uuid;
  v_cat    uuid;
  v_lines  integer;
  v_skipped integer;
  -- The sub-recipe mirror's name, and the branch item already holding it (S707).
  v_mname    text;
  v_conflict text;
BEGIN
  -- Same owner-altitude test as get_group_summary: this writes across tenant boundaries, which is
  -- the most privileged thing any non-admin action in this product does. COALESCE because both
  -- helpers return NULL rather than false for a caller with no profiles row (S579).
  IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
    RAISE EXCEPTION 'Not permitted: only an owner can push master data.';
  END IF;

  v_group := public.my_group_id();
  IF v_group IS NULL THEN
    RAISE EXCEPTION 'Not permitted: you are not part of an outlet group.';
  END IF;

  SELECT hq_client_id INTO v_hq FROM client_groups WHERE id = v_group;
  IF v_hq IS NULL THEN
    RAISE EXCEPTION 'This group has no HQ outlet set, so there is nothing to push from.';
  END IF;

  -- Every target must be in my group and must not be the HQ itself. Checked as a set so one bad
  -- id fails the whole call rather than being silently dropped (same rule as set_outlet_access).
  IF EXISTS (
    SELECT 1 FROM unnest(COALESCE(p_target_client_ids, ARRAY[]::uuid[])) AS t(id)
     WHERE t.id = v_hq
        OR t.id NOT IN (SELECT c.id FROM clients c WHERE c.group_id = v_group)
  ) THEN
    RAISE EXCEPTION 'Not permitted: one or more targets are not branches of your group.';
  END IF;

  CREATE TEMP TABLE _plan (
    target_client_id uuid, target_client_name text,
    entity text, action text, record_name text, detail text,
    src_id uuid, dst_id uuid
  ) ON COMMIT DROP;

  ----------------------------------------------------------------------------------------------
  -- PLAN. Pure SELECTs -- nothing below writes. The preview an operator approves IS this plan,
  -- so what they read and what applies cannot diverge into two implementations.
  ----------------------------------------------------------------------------------------------
  FOREACH v_target IN ARRAY COALESCE(p_target_client_ids, ARRAY[]::uuid[]) LOOP
    SELECT name INTO v_tname FROM clients WHERE id = v_target;

    IF v_do_cat THEN
      INSERT INTO _plan
      SELECT v_target, v_tname, 'categories',
             CASE WHEN d.id IS NOT NULL THEN 'update'
                  WHEN a.id IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             CASE WHEN a.id IS NOT NULL AND d.id IS NULL
                  THEN 'matched an existing category of the same name' END,
             s.id, COALESCE(d.id, a.id)
        FROM categories s
        LEFT JOIN categories d ON d.client_id = v_target AND d.master_id = s.id
        LEFT JOIN categories a ON a.client_id = v_target AND a.master_id IS NULL AND lower(a.name) = lower(s.name)
       WHERE s.client_id = v_hq;
    END IF;

    IF v_do_itm THEN
      -- is_sub_recipe rows are excluded: they are mirrors owned by the recipe machinery, created
      -- at the branch by the recipes pass below. Pushing them as ordinary items would race that.
      -- `x` is any OTHER branch row already holding this name -- neither the master-linked row we
      -- would update nor the unlinked row we would adopt. Its existence means writing s.name into
      -- this branch violates items_client_name_key, so the row is planned as 'conflict' and the
      -- apply pass below skips it. LATERAL rather than a fourth LEFT JOIN because the predicate
      -- has to reference d.id and a.id, which a plain join cannot.
      -- `u` (S792) is the branch row we would update or adopt when its unit differs from HQ's and
      -- it has recorded history: writing HQ's unit would re-read that history (D5), so it too is a
      -- 'conflict'.
      INSERT INTO _plan
      SELECT v_target, v_tname, 'items',
             CASE WHEN x.id IS NOT NULL THEN 'conflict'
                  WHEN u.uom IS NOT NULL THEN 'conflict'
                  WHEN d.id IS NOT NULL THEN 'update'
                  WHEN a.id IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             CASE WHEN x.id IS NOT NULL
                    THEN 'skipped - this branch already has a different ' ||
                         CASE WHEN COALESCE(x.is_sub_recipe, false) THEN 'sub-recipe' ELSE 'item' END ||
                         ' called "' || x.name || '". Rename one of them, then push again.'
                  WHEN u.uom IS NOT NULL
                    THEN 'skipped - this branch records it in ' || u.uom || ' and HQ uses ' || COALESCE(s.uom, 'no unit') ||
                         '. Changing the unit would re-read every count and bill already recorded at this branch. ' ||
                         'Keep the branch item as it is, or create a separate item for the new unit.'
                  WHEN a.id IS NOT NULL AND d.id IS NULL THEN 'matched an existing item of the same name'
                  WHEN d.id IS NOT NULL THEN 'definition only - this branch keeps its own rate' END,
             s.id, COALESCE(d.id, a.id)
        FROM items s
        LEFT JOIN items d ON d.client_id = v_target AND d.master_id = s.id
        LEFT JOIN items a ON a.client_id = v_target AND a.master_id IS NULL
                         AND COALESCE(a.is_sub_recipe, false) = false AND lower(a.name) = lower(s.name)
        LEFT JOIN LATERAL (
          SELECT c.id, c.name, c.is_sub_recipe
            FROM items c
           WHERE c.client_id = v_target
             AND lower(c.name) = lower(s.name)
             AND (d.id IS NULL OR c.id <> d.id)
             AND (a.id IS NULL OR c.id <> a.id)
           LIMIT 1
        ) x ON true
        LEFT JOIN LATERAL (
          SELECT b.uom
            FROM items b
           WHERE b.id = COALESCE(d.id, a.id)
             AND b.uom IS DISTINCT FROM s.uom
             AND public.item_has_references(b.id)
        ) u ON true
       WHERE s.client_id = v_hq AND COALESCE(s.is_sub_recipe, false) = false;
    END IF;

    IF v_do_rec THEN
      -- recipe_code is uniquely indexed per client, so it is tried before name: adopting by name
      -- while a DIFFERENT branch recipe already holds the incoming code would fail the insert.
      INSERT INTO _plan
      SELECT v_target, v_tname, 'recipes',
             CASE WHEN d.id IS NOT NULL THEN 'update'
                  WHEN COALESCE(c.id, n.id) IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             CASE WHEN d.id IS NULL AND c.id IS NOT NULL THEN 'matched an existing recipe with the same code'
                  WHEN d.id IS NULL AND n.id IS NOT NULL THEN 'matched an existing recipe of the same name'
                  WHEN v_do_prc THEN 'selling price included'
                  ELSE 'selling price left as the branch has it' END,
             s.id, COALESCE(d.id, c.id, n.id)
        FROM recipes s
        LEFT JOIN recipes d ON d.client_id = v_target AND d.master_id = s.id
        LEFT JOIN recipes c ON c.client_id = v_target AND c.master_id IS NULL
                           AND s.recipe_code IS NOT NULL AND c.recipe_code = s.recipe_code
        LEFT JOIN recipes n ON n.client_id = v_target AND n.master_id IS NULL
                           AND lower(n.name) = lower(s.name)
       WHERE s.client_id = v_hq;
    END IF;
  END LOOP;

  IF p_dry_run THEN
    RETURN QUERY SELECT p.target_client_id, p.target_client_name, p.entity, p.action, p.record_name, p.detail
                   FROM _plan p ORDER BY p.target_client_name, p.entity, p.action, p.record_name;
    RETURN;
  END IF;

  ----------------------------------------------------------------------------------------------
  -- APPLY, strictly in dependency order: categories, then items (which reference a category),
  -- then recipes, then each recipe's ingredient list (which references both items and recipes).
  ----------------------------------------------------------------------------------------------
  FOR r IN SELECT * FROM _plan WHERE entity = 'categories' ORDER BY target_client_id LOOP
    IF r.dst_id IS NULL THEN
      INSERT INTO categories (client_id, name, sort_order, master_id)
      SELECT r.target_client_id, s.name, s.sort_order, s.id FROM categories s WHERE s.id = r.src_id;
    ELSE
      UPDATE categories d
         SET name = s.name, sort_order = s.sort_order, master_id = s.id
        FROM categories s WHERE s.id = r.src_id AND d.id = r.dst_id;
    END IF;
  END LOOP;

  -- `action <> 'conflict'`: a planned conflict is REPORTED, never written. It stays in _plan so
  -- the operator reads it in the returned rows exactly as the dry run showed it.
  FOR r IN SELECT * FROM _plan WHERE entity = 'items' AND action <> 'conflict' ORDER BY target_client_id LOOP
    -- The branch's own copy of the source item's category, if that category was ever pushed.
    SELECT d.id INTO v_cat
      FROM categories s JOIN categories d ON d.client_id = r.target_client_id AND d.master_id = s.id
     WHERE s.id = (SELECT category_id FROM items WHERE id = r.src_id);

    IF r.dst_id IS NULL THEN
      -- per_uom_rate is GENERATED and must never appear in an INSERT. purchase_qty carries a
      -- CHECK (= 1) since S597, so it is copied rather than derived.
      INSERT INTO items (client_id, master_id, category_id, name, uom, purchase_qty, rate,
                         is_active, purchase_unit, base_unit, conversion_factor, item_code,
                         yield_pct, is_sub_recipe, nutrition)
      SELECT r.target_client_id, s.id, v_cat, s.name, s.uom, s.purchase_qty, s.rate,
             s.is_active, s.purchase_unit, s.base_unit, s.conversion_factor, s.item_code,
             s.yield_pct, false, s.nutrition
        FROM items s WHERE s.id = r.src_id;
    ELSE
      -- rate is deliberately absent: see the header. This is the branch's own supplier price.
      -- is_active too (S792): whether the branch still stocks an item is the branch's own fact.
      UPDATE items d
         SET master_id = s.id, category_id = v_cat, name = s.name, uom = s.uom,
             purchase_qty = s.purchase_qty,
             purchase_unit = s.purchase_unit, base_unit = s.base_unit,
             conversion_factor = s.conversion_factor, item_code = s.item_code,
             yield_pct = s.yield_pct, nutrition = s.nutrition
        FROM items s WHERE s.id = r.src_id AND d.id = r.dst_id;
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM _plan WHERE entity = 'recipes' ORDER BY target_client_id LOOP
    IF r.dst_id IS NULL THEN
      INSERT INTO recipes (client_id, master_id, name, category, selling_price, vat_rate,
                           is_active, yield_qty, yield_uom, target_fc_pct, recipe_code,
                           pos_enabled, hsc_code)
      SELECT r.target_client_id, s.id, s.name, s.category, s.selling_price, s.vat_rate,
             s.is_active, s.yield_qty, s.yield_uom, s.target_fc_pct, s.recipe_code,
             s.pos_enabled, s.hsc_code
        FROM recipes s WHERE s.id = r.src_id
      RETURNING id INTO v_dst;
      UPDATE _plan SET dst_id = v_dst WHERE src_id = r.src_id AND target_client_id = r.target_client_id AND entity = 'recipes';
    ELSE
      -- selling_price only when 'prices' was asked for: a branch may legitimately price above or
      -- below HQ, so it is opt-in rather than swept along with the recipe definition.
      UPDATE recipes d
         SET master_id = s.id, name = s.name, category = s.category, vat_rate = s.vat_rate,
             is_active = s.is_active, yield_qty = s.yield_qty, yield_uom = s.yield_uom,
             target_fc_pct = s.target_fc_pct, recipe_code = s.recipe_code,
             pos_enabled = s.pos_enabled, hsc_code = s.hsc_code,
             selling_price = CASE WHEN v_do_prc THEN s.selling_price ELSE d.selling_price END
        FROM recipes s WHERE s.id = r.src_id AND d.id = r.dst_id;
      v_dst := r.dst_id;
    END IF;

    -- Sub-recipe mirror item, reproducing Recipes.js's own payload. Created if absent, linked
    -- either way; its rate is a cost computed at HQ prices, so it is seeded and then left alone.
    IF (SELECT category FROM recipes WHERE id = r.src_id) = 'Sub-Recipe' THEN
      IF (SELECT linked_item_id FROM recipes WHERE id = v_dst) IS NULL THEN
        -- The mirror is an `items` row like any other, so items_client_name_key applies to it and
        -- this INSERT is the third way the push could raise 23505. Checked rather than caught: a
        -- reported conflict leaves the rest of the push intact, and the ingredient lines that
        -- needed this mirror are then skipped and counted by the 'partial' machinery below, which
        -- is already the honest answer for an ingredient with no counterpart at the branch.
        SELECT upper(s.name) INTO v_mname FROM recipes s WHERE s.id = r.src_id;
        SELECT c.name INTO v_conflict
          FROM items c
         WHERE c.client_id = r.target_client_id AND lower(c.name) = lower(v_mname)
         LIMIT 1;

        IF v_conflict IS NOT NULL THEN
          INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail)
          VALUES (r.target_client_id, r.target_client_name, 'sub-recipe item', 'conflict', v_mname,
                  'skipped - this branch already has an item called "' || v_conflict ||
                  '", so the stock-counted mirror for this sub-recipe was not created and any '
                  || 'recipe line using it is skipped too. Rename one of them, then push again.');
        ELSE
          SELECT id INTO v_cat FROM categories
           WHERE client_id = r.target_client_id AND lower(name) = 'sub-recipes' LIMIT 1;
          IF v_cat IS NULL THEN
            INSERT INTO categories (client_id, name, sort_order)
            VALUES (r.target_client_id, 'Sub-Recipes', 999) RETURNING id INTO v_cat;
          END IF;
          INSERT INTO items (client_id, category_id, name, uom, purchase_qty, rate, is_active,
                             is_sub_recipe, item_code)
          SELECT r.target_client_id, v_cat, v_mname, COALESCE(s.yield_uom, 'portion'), 1,
                 COALESCE((SELECT i.rate FROM items i WHERE i.id = s.linked_item_id), 0),
                 true, true, s.recipe_code
            FROM recipes s WHERE s.id = r.src_id
          RETURNING id INTO v_item;
          -- v_item, NOT v_dst: v_dst still holds the RECIPE id this mirror belongs to, and reusing
          -- one variable for both would link the recipe to itself.
          UPDATE recipes SET linked_item_id = v_item WHERE id = v_dst;
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- Ingredients last, and replaced wholesale per recipe -- "HQ wins" applied to a list means the
  -- list, not a merge of two lists. An ingredient whose item or sub-recipe has no counterpart at
  -- the branch is REPORTED, never silently dropped: a recipe costed from an incomplete ingredient
  -- list is the silent-wrong-number shape this codebase keeps finding.
  IF v_do_rec THEN
    -- Materialised into its own table first: the loop body INSERTs 'ingredients' rows into _plan,
    -- and mutating the relation a FOR cursor is reading is the kind of thing that works until the
    -- planner picks a different scan.
    CREATE TEMP TABLE _rec_todo ON COMMIT DROP AS
      SELECT * FROM _plan WHERE entity = 'recipes' AND dst_id IS NOT NULL;
    FOR r IN SELECT * FROM _rec_todo ORDER BY target_client_id LOOP
      SELECT count(*) INTO v_skipped
        FROM recipe_ingredients ri
        LEFT JOIN items di ON di.client_id = r.target_client_id AND di.master_id = ri.item_id
        LEFT JOIN recipes dr ON dr.client_id = r.target_client_id AND dr.master_id = ri.sub_recipe_id
       WHERE ri.recipe_id = r.src_id
         AND ((ri.item_id IS NOT NULL AND di.id IS NULL) OR (ri.sub_recipe_id IS NOT NULL AND dr.id IS NULL));

      DELETE FROM recipe_ingredients WHERE recipe_id = r.dst_id;

      INSERT INTO recipe_ingredients (recipe_id, item_id, sub_recipe_id, qty_per_portion)
      SELECT r.dst_id, di.id, dr.id, ri.qty_per_portion
        FROM recipe_ingredients ri
        LEFT JOIN items di ON di.client_id = r.target_client_id AND di.master_id = ri.item_id
        LEFT JOIN recipes dr ON dr.client_id = r.target_client_id AND dr.master_id = ri.sub_recipe_id
       WHERE ri.recipe_id = r.src_id
         AND ((ri.item_id IS NOT NULL AND di.id IS NOT NULL) OR (ri.sub_recipe_id IS NOT NULL AND dr.id IS NOT NULL));

      GET DIAGNOSTICS v_lines = ROW_COUNT;
      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail)
      VALUES (r.target_client_id, r.target_client_name, 'ingredients',
              CASE WHEN v_skipped > 0 THEN 'partial' ELSE 'replaced' END, r.record_name,
              v_lines || ' line(s) written'
                || CASE WHEN v_skipped > 0
                        THEN ', ' || v_skipped || ' skipped - ingredient not present at this branch'
                        ELSE '' END);
    END LOOP;
  END IF;

  RETURN QUERY SELECT p.target_client_id, p.target_client_name, p.entity, p.action, p.record_name, p.detail
                 FROM _plan p ORDER BY p.target_client_name, p.entity, p.action, p.record_name;
END;
$fn$;


-- ══ 12. Gate passes: who issued it, who let it out (COSTS-15) ═══════════════════════════════════
--
-- issued_by and exited_by were whatever the browser sent, so any IMS login could put a colleague's
-- name on a pass, printed and listed. The void half of this guard already stamped voided_by from
-- auth.uid(); the same rule now covers the other two, and neither can be edited afterwards. An
-- auto-close (the 6 AM sweep, auto_closed = true) has no person at the gate and records none.
--
-- Body: 20260918110000 (S756), live md5 b3367ebb70c8c985cfb3ea54c7f74212, plus the INSERT branch
-- and the issuer/exit stamps.
CREATE OR REPLACE FUNCTION public.ims_gate_pass_void_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;
  -- Attribution the subject can choose is not attribution.
  IF TG_OP = 'INSERT' THEN
    NEW.issued_by := (select auth.uid());
    NEW.exited_by := NULL;
    RETURN NEW;
  END IF;
  IF OLD.status = 'voided' THEN
    RAISE EXCEPTION 'ims_gate_passes: a voided gate pass cannot be changed'
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;
  IF NEW.status = 'voided' AND NOT public.ims_caller_has_rank('supervisor') THEN
    RAISE EXCEPTION 'ims_gate_passes: voiding a gate pass needs an IMS supervisor, a manager or the account owner'
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;
  IF NEW.status = 'voided' THEN
    NEW.voided_by := (select auth.uid());
  END IF;
  NEW.issued_by := OLD.issued_by;
  IF OLD.status = 'open' AND NEW.status = 'closed' THEN
    NEW.exited_by := CASE WHEN COALESCE(NEW.auto_closed, false) THEN NULL ELSE (select auth.uid()) END;
  ELSE
    NEW.exited_by := OLD.exited_by;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ims_gate_pass_void_guard ON public.ims_gate_passes;
CREATE TRIGGER ims_gate_pass_void_guard BEFORE INSERT OR UPDATE ON public.ims_gate_passes
  FOR EACH ROW EXECUTE FUNCTION public.ims_gate_pass_void_guard();


-- ══ 13. A depreciation run posted twice by two tabs (COSTS-16) ══════════════════════════════════
--
-- The page checks for an overlapping run before posting and makes a second charge a decision, but
-- that check is a read in the browser: two tabs pressing Post within the same second both see "no
-- earlier run" and both charge the period, and the schedule is immutable. Posting is now serialised
-- per client, and the same run (same period and the same note — a regular run, an adjustment of
-- one run, or one asset's disposal charge) posted again within two minutes is refused. A deliberate
-- "Post anyway" follows a confirmation dialog and is not affected.
--
-- Body: 20260803130000, live md5 11ee5c92fe06c24f3c75837dbae11602, plus the lock and the refusal.
CREATE OR REPLACE FUNCTION public.post_asset_depreciation_run(
  p_client_id uuid, p_period_start date, p_period_end date, p_lines jsonb, p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_run_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('post_asset_depreciation_run:' || p_client_id::text, 0));
  IF EXISTS (SELECT 1 FROM assets_depreciation_runs r
              WHERE r.client_id = p_client_id AND r.status = 'posted'
                AND r.period_start = p_period_start AND r.period_end = p_period_end
                AND r.notes IS NOT DISTINCT FROM p_notes
                AND r.posted_at > now() - interval '2 minutes') THEN
    RAISE EXCEPTION 'dep_run_duplicate: this run was posted moments ago, from this page or another'
      USING ERRCODE = 'P0001', HINT = 'dep_run_duplicate';
  END IF;

  INSERT INTO assets_depreciation_runs (client_id, period_start, period_end, status, posted_at, posted_by, created_by, notes)
  VALUES (p_client_id, p_period_start, p_period_end, 'posted', now(), auth.uid(), auth.uid(), p_notes)
  RETURNING id INTO v_run_id;

  INSERT INTO assets_depreciation_schedule (
    client_id, run_id, asset_id, period_start, period_end,
    opening_nbv, annual_depreciation, depreciation_amount, override_amount, override_reason,
    closing_nbv, is_posted
  )
  SELECT
    p_client_id, v_run_id, (l->>'asset_id')::uuid, p_period_start, p_period_end,
    (l->>'opening_nbv')::numeric, (l->>'annual_depreciation')::numeric,
    (l->>'depreciation_amount')::numeric, NULLIF(l->>'override_amount','')::numeric, l->>'override_reason',
    (l->>'closing_nbv')::numeric, true
  FROM jsonb_array_elements(p_lines) AS l;

  RETURN v_run_id;
END $$;


-- ══ 14. Audit trail and grants (DATABASE-7, DATABASE-8) ══════════════════════════════════════════
--
-- Supplier payments are money that left the bank, and a manager could delete one (or half of a
-- credit pair) with no Audit Log trace, while salary payments are audited. Overheads join them: the
-- fixed costs every net-profit figure subtracts. Both tables carry client_id, which log_audit()
-- reads directly. staff_meals has no client_id column, so it cannot join without a log_audit()
-- change — left for a later pass (IMS_TODO S792).
CREATE OR REPLACE TRIGGER audit_payable_payments
  AFTER INSERT OR DELETE OR UPDATE ON public.payable_payments
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();
CREATE OR REPLACE TRIGGER audit_overheads
  AFTER INSERT OR DELETE OR UPDATE ON public.overheads
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();

-- The schema's default privileges hand TRUNCATE / REFERENCES / TRIGGER / MAINTAIN to anon and
-- authenticated on every raw-SQL table (S782); TRUNCATE bypasses RLS. These nine kept them.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assets_register', 'assets_categories', 'assets_repair_expenses', 'assets_depreciation_runs',
                           'assets_depreciation_schedule', 'assets_tax_pool_runs', 'assets_tax_pool_lines',
                           'ims_count_assignments', 'monthly_owner_reports'] LOOP
    EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.%I FROM authenticated, anon, PUBLIC', t);
  END LOOP;
END;
$$;


-- ══ 15. Self-check ═══════════════════════════════════════════════════════════════════════════════
-- On catalog values Postgres computes (supabase-sql.md, S630). Behaviour is exercised in the
-- rolled-back dry run under real JWT claims before apply, and read back after.
DO $$
DECLARE
  v_missing text;
  v_src text;
BEGIN
  SELECT string_agg(t, ', ') INTO v_missing
    FROM unnest(ARRAY['items', 'vendors', 'categories', 'overheads', 'budgets', 'opening_stock', 'wastages', 'staff_meals',
                      'sales_entries', 'purchase_orders', 'purchase_order_items', 'demand_forecast_daily',
                      'demand_forecast_run_log', 'recipe_suggestions']) t
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
                      JOIN pg_namespace n ON n.oid = c.relnamespace
                      WHERE n.nspname = 'public' AND c.relname = t AND tg.tgname = 'ims_rank_guard' AND NOT tg.tgisinternal);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'S792: rank guard missing on %', v_missing;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.overheads'::regclass
                   AND tgname = 'ims_closed_period_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'S792: closed-period guard missing on overheads';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.categories'::regclass
                   AND tgname = 'ims_rank_guard_delete' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'S792: category delete guard missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('audit_payable_payments', 'audit_overheads') AND NOT tgisinternal) <> 2 THEN
    RAISE EXCEPTION 'S792: an audit trigger is missing';
  END IF;

  -- settings: the unique index leads on client_id; the count switches are in the guard's union.
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
                  WHERE i.indrelid = 'public.settings'::regclass AND i.indisunique AND i.indnatts = 1 AND a.attname = 'client_id') THEN
    RAISE EXCEPTION 'S792: settings has no unique index on client_id';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.settings_guard_staff_roles()'::regprocedure;
  IF v_src NOT LIKE '%c_print || c_ims || c_ims_count%' OR v_src NOT LIKE '%HINT = ''ims_count_settings_rank''%'
     OR v_src NOT LIKE '%HINT = ''weather_rain_rank''%' OR v_src NOT LIKE '%HINT = ''guest_menu_brand_rank''%' THEN
    RAISE EXCEPTION 'S792: settings_guard_staff_roles lost a check in the rebuild';
  END IF;

  -- purchase_order_items.unit_price has no scale limit now.
  IF (SELECT a.atttypmod FROM pg_attribute a WHERE a.attrelid = 'public.purchase_order_items'::regclass AND a.attname = 'unit_price') <> -1 THEN
    RAISE EXCEPTION 'S792: purchase_order_items.unit_price still carries a precision';
  END IF;

  -- EXECUTE: the two internal helpers are not callable by a client session.
  IF has_function_privilege('authenticated', 'public.item_has_references(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.item_has_references(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ims_revoke_count_sessions(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.ims_revoke_count_sessions(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S792: an internal helper is executable by a client role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.ims_revoke_count_sessions(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S792: the service role cannot end counting-tablet sessions';
  END IF;

  -- Grants revoked.
  IF has_table_privilege('authenticated', 'public.assets_register', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.monthly_owner_reports', 'TRUNCATE') THEN
    RAISE EXCEPTION 'S792: a stray TRUNCATE grant survived';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
