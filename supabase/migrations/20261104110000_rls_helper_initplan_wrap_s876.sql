-- S876 PERF-12: row security asks "who is this?" once per request, not once per row.
--
-- Seven helpers are LANGUAGE sql STABLE SECURITY DEFINER with no arguments: is_admin(), my_client_id(),
-- is_hr_self_service(), is_hr_role_staff(), is_pos_pin_staff(), is_ims_staff(), ims_can_manage_counts().
-- Postgres will not inline a SECURITY DEFINER function (inline_function() bails on prosecdef), and inside
-- an RLS policy a bare call is evaluated for every candidate row, even when the expression mentions no
-- column: the restrictive staff-isolation family `(NOT is_x())` plans as a per-row Filter, not a One-Time
-- Filter (checked live: pos_orders' Index Scan filter carries all three NOT is_x() calls). Written as
-- `( SELECT fn() AS fn)` the call becomes an InitPlan, evaluated once per query. This is the follow-up
-- 20260812130000_rls_perf_initplan_select_wrap.sql scoped out pending a live EXPLAIN.
--
-- Measured on BLOOM CAFE, 2026-11-04, as its Owner login (read-only, rolled back; a throwaway temp copy
-- of the rows carried each version of the policies, so no live policy was touched):
--   pos_orders, 2,656 rows        ~210 ms today  ->  2-3 ms wrapped
--   sales_entries, every row      ~566 ms today  ->  ~4 ms wrapped
--
-- The rewrite is purely syntactic: every expression is the one deployed today with each bare call to the
-- seven helpers replaced by `( SELECT fn() AS fn)`, so no policy admits a different row set. A scalar
-- subquery with no FROM yields exactly one row, NULL stays NULL, and every COALESCE stays where it is.
-- Generated from the LIVE pg_policies text (not from replaying migrations: the staff-isolation families
-- were created by EXECUTE format() inside DO blocks). ALTER POLICY restates only the clause that changes,
-- leaving command, roles, permissive/restrictive and any omitted clause untouched.
--
-- 307 policies on 99 tables (250 restrictive, 57 permissive), of 486 in public.
-- Not touched: ims_count_scope_allows(item_id) on closing_stock's write policies (it takes a row column, so
-- a scalar subquery cannot hoist it; writes only, low volume), and storage.objects' policies.
--
-- Safety inside this file:
--   * A fingerprint of every target policy's live text. If any changed after this file was generated,
--     it RAISEs and nothing applies: regenerate the file.
--   * lock_timeout 5s. ALTER POLICY takes an exclusive lock on each table until COMMIT, so a table held
--     by a long read makes the file fail and roll back instead of queueing every till behind it. Apply
--     when no outlet is trading.
--   * After the ALTERs: every policy unwraps back to its old text with command, roles and
--     permissive/restrictive unchanged; the policy count is unchanged; every target changed; no bare call
--     to the seven helpers is left in any public policy. Any failure RAISEs and rolls everything back.
--
-- Reverse: ALTER POLICY each target back to its old text (check (a)'s unwrapping regex produces it).
--
-- Verify afterwards (expect zero rows):
--   SELECT tablename, policyname FROM pg_policies
--   WHERE schemaname = 'public'
--     AND (coalesce(qual, '') ~ '(?<!SELECT )(?<![.\w])(is_admin|my_client_id|is_hr_self_service|is_hr_role_staff|is_pos_pin_staff|is_ims_staff|ims_can_manage_counts)\(\)'
--       OR coalesce(with_check, '') ~ '(?<!SELECT )(?<![.\w])(is_admin|my_client_id|is_hr_self_service|is_hr_role_staff|is_pos_pin_staff|is_ims_staff|ims_can_manage_counts)\(\)');

BEGIN;

-- The text below was generated under this search_path; ALTER POLICY parses it under the same one.
SET LOCAL search_path TO "$user", public, extensions;
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE _perf12_before ON COMMIT DROP AS
  SELECT tablename, policyname, permissive, cmd, roles, qual, with_check
  FROM pg_policies
  WHERE schemaname = 'public';

CREATE TEMP TABLE _perf12_targets (tablename name, policyname name) ON COMMIT DROP;
INSERT INTO _perf12_targets (tablename, policyname) VALUES
    ('app_secrets', 'app_secrets_admin'),
    ('assets_categories', 'no_hr_role_staff'),
    ('assets_categories', 'no_pos_pin_staff'),
    ('assets_categories', 'no_self_service_accounts'),
    ('assets_depreciation_runs', 'no_hr_role_staff'),
    ('assets_depreciation_runs', 'no_pos_pin_staff'),
    ('assets_depreciation_runs', 'no_self_service_accounts'),
    ('assets_depreciation_schedule', 'no_hr_role_staff'),
    ('assets_depreciation_schedule', 'no_pos_pin_staff'),
    ('assets_depreciation_schedule', 'no_self_service_accounts'),
    ('assets_register', 'no_hr_role_staff'),
    ('assets_register', 'no_pos_pin_staff'),
    ('assets_register', 'no_self_service_accounts'),
    ('assets_repair_expenses', 'no_hr_role_staff'),
    ('assets_repair_expenses', 'no_pos_pin_staff'),
    ('assets_repair_expenses', 'no_self_service_accounts'),
    ('assets_tax_pool_lines', 'no_hr_role_staff'),
    ('assets_tax_pool_lines', 'no_pos_pin_staff'),
    ('assets_tax_pool_lines', 'no_self_service_accounts'),
    ('assets_tax_pool_opening_corrections', 'no_hr_role_staff'),
    ('assets_tax_pool_opening_corrections', 'no_pos_pin_staff'),
    ('assets_tax_pool_opening_corrections', 'no_self_service_accounts'),
    ('assets_tax_pool_openings', 'no_hr_role_staff'),
    ('assets_tax_pool_openings', 'no_pos_pin_staff'),
    ('assets_tax_pool_openings', 'no_self_service_accounts'),
    ('assets_tax_pool_runs', 'no_hr_role_staff'),
    ('assets_tax_pool_runs', 'no_pos_pin_staff'),
    ('assets_tax_pool_runs', 'no_self_service_accounts'),
    ('budgets', 'no_hr_role_staff'),
    ('budgets', 'no_pos_pin_staff'),
    ('budgets', 'no_self_service_accounts'),
    ('categories', 'categories_all'),
    ('categories', 'no_hr_role_staff'),
    ('categories', 'no_pos_pin_staff'),
    ('categories', 'no_self_service_accounts'),
    ('client_secrets', 'client_secrets_admin'),
    ('clients', 'clients_delete'),
    ('clients', 'clients_insert'),
    ('clients', 'clients_update'),
    ('closing_stock', 'closing_stock_all'),
    ('closing_stock', 'no_hr_role_staff'),
    ('closing_stock', 'no_pos_pin_staff'),
    ('closing_stock', 'no_self_service_accounts'),
    ('demand_forecast_daily', 'no_hr_role_staff_delete'),
    ('demand_forecast_daily', 'no_hr_role_staff_insert'),
    ('demand_forecast_daily', 'no_hr_role_staff_update'),
    ('demand_forecast_daily', 'no_pos_pin_staff'),
    ('demand_forecast_daily', 'no_self_service_accounts'),
    ('demand_forecast_run_log', 'no_hr_role_staff'),
    ('demand_forecast_run_log', 'no_pos_pin_staff'),
    ('demand_forecast_run_log', 'no_self_service_accounts'),
    ('feature_flags', 'feature_flags_delete'),
    ('feature_flags', 'feature_flags_insert'),
    ('feature_flags', 'feature_flags_select'),
    ('feature_flags', 'feature_flags_update'),
    ('hr_advance_repayments', 'client_own'),
    ('hr_advance_repayments', 'no_ims_staff'),
    ('hr_advance_repayments', 'no_pos_pin_staff'),
    ('hr_advances', 'client_own'),
    ('hr_advances', 'no_ims_staff'),
    ('hr_advances', 'no_pos_pin_staff'),
    ('hr_attendance', 'client_own'),
    ('hr_attendance', 'no_ims_staff'),
    ('hr_attendance', 'no_pos_pin_staff'),
    ('hr_employees', 'hr_employees_delete'),
    ('hr_employees', 'hr_employees_insert'),
    ('hr_employees', 'hr_employees_select'),
    ('hr_employees', 'no_ims_staff'),
    ('hr_employees', 'no_pos_pin_staff'),
    ('hr_festival_allowances', 'client_own'),
    ('hr_festival_allowances', 'no_ims_staff'),
    ('hr_festival_allowances', 'no_pos_pin_staff'),
    ('hr_final_settlements', 'hr_final_settlements_all'),
    ('hr_final_settlements', 'no_ims_staff'),
    ('hr_final_settlements', 'no_pos_pin_staff'),
    ('hr_holiday_calendar', 'client_own'),
    ('hr_holiday_calendar', 'no_ims_staff'),
    ('hr_holiday_calendar', 'no_pos_pin_staff'),
    ('hr_incentive_configs', 'client_own'),
    ('hr_incentive_configs', 'no_ims_staff'),
    ('hr_incentive_configs', 'no_pos_pin_staff'),
    ('hr_incentives', 'client_own'),
    ('hr_incentives', 'no_ims_staff'),
    ('hr_incentives', 'no_pos_pin_staff'),
    ('hr_leave_requests', 'client_own'),
    ('hr_leave_requests', 'no_ims_staff'),
    ('hr_leave_requests', 'no_pos_pin_staff'),
    ('hr_leave_types', 'client_own'),
    ('hr_leave_types', 'no_ims_staff'),
    ('hr_leave_types', 'no_pos_pin_staff'),
    ('hr_overtime_entries', 'client_own'),
    ('hr_overtime_entries', 'no_ims_staff'),
    ('hr_overtime_entries', 'no_pos_pin_staff'),
    ('hr_payroll_runs', 'client_own'),
    ('hr_payroll_runs', 'no_ims_staff'),
    ('hr_payroll_runs', 'no_pos_pin_staff'),
    ('hr_payslips', 'client_own'),
    ('hr_payslips', 'no_ims_staff'),
    ('hr_payslips', 'no_pos_pin_staff'),
    ('hr_roster', 'client_access'),
    ('hr_roster', 'no_ims_staff'),
    ('hr_roster', 'no_pos_pin_staff'),
    ('hr_roster_publish_state', 'client_own'),
    ('hr_roster_publish_state', 'no_ims_staff'),
    ('hr_roster_publish_state', 'no_pos_pin_staff'),
    ('hr_salary_components', 'client_own'),
    ('hr_salary_components', 'no_ims_staff'),
    ('hr_salary_components', 'no_pos_pin_staff'),
    ('hr_salary_payments', 'no_ims_staff'),
    ('hr_salary_payments', 'no_pos_pin_staff'),
    ('hr_shift_swap_requests', 'client_own'),
    ('hr_shift_swap_requests', 'no_ims_staff'),
    ('hr_shift_swap_requests', 'no_pos_pin_staff'),
    ('hr_shift_types', 'client_own'),
    ('hr_shift_types', 'no_ims_staff'),
    ('hr_shift_types', 'no_pos_pin_staff'),
    ('hr_tada_claim_items', 'no_ims_staff'),
    ('hr_tada_claim_items', 'no_pos_pin_staff'),
    ('hr_tada_claims', 'client_own'),
    ('hr_tada_claims', 'no_ims_staff'),
    ('hr_tada_claims', 'no_pos_pin_staff'),
    ('ims_count_assignments', 'ims_count_assignments_delete'),
    ('ims_count_assignments', 'ims_count_assignments_insert'),
    ('ims_count_assignments', 'ims_count_assignments_select'),
    ('ims_count_assignments', 'ims_count_assignments_update'),
    ('ims_count_assignments', 'no_hr_role_staff'),
    ('ims_count_assignments', 'no_pos_pin_staff'),
    ('ims_count_assignments', 'no_self_service_accounts'),
    ('ims_gate_passes', 'no_hr_role_staff'),
    ('ims_gate_passes', 'no_pos_pin_staff'),
    ('ims_gate_passes', 'no_self_service_accounts'),
    ('ims_stock_transfer_lines', 'no_hr_role_staff'),
    ('ims_stock_transfer_lines', 'no_pos_pin_staff'),
    ('ims_stock_transfer_lines', 'no_self_service_accounts'),
    ('ims_stock_transfers', 'no_hr_role_staff'),
    ('ims_stock_transfers', 'no_pos_pin_staff'),
    ('ims_stock_transfers', 'no_self_service_accounts'),
    ('items', 'items_all'),
    ('items', 'no_hr_role_staff'),
    ('items', 'no_pos_pin_staff'),
    ('items', 'no_self_service_accounts'),
    ('legal_acceptances', 'no_hr_role_staff'),
    ('legal_acceptances', 'no_ims_staff'),
    ('legal_acceptances', 'no_pos_pin_staff'),
    ('legal_acceptances', 'no_self_service_accounts'),
    ('monthly_owner_reports', 'monthly_owner_reports_all'),
    ('monthly_owner_reports', 'no_hr_role_staff'),
    ('monthly_owner_reports', 'no_ims_staff'),
    ('monthly_owner_reports', 'no_pos_pin_staff'),
    ('monthly_owner_reports', 'no_self_service_accounts'),
    ('monthly_periods', 'monthly_periods_all'),
    ('monthly_periods', 'no_hr_role_staff_delete'),
    ('monthly_periods', 'no_hr_role_staff_insert'),
    ('monthly_periods', 'no_hr_role_staff_update'),
    ('monthly_periods', 'no_self_service_accounts'),
    ('opening_stock', 'no_hr_role_staff'),
    ('opening_stock', 'no_pos_pin_staff'),
    ('opening_stock', 'no_self_service_accounts'),
    ('opening_stock', 'opening_stock_all'),
    ('overheads', 'no_hr_role_staff'),
    ('overheads', 'no_pos_pin_staff'),
    ('overheads', 'no_self_service_accounts'),
    ('overheads', 'overheads_all'),
    ('par_levels', 'no_hr_role_staff'),
    ('par_levels', 'no_pos_pin_staff'),
    ('par_levels', 'no_self_service_accounts'),
    ('par_levels', 'par_levels_all'),
    ('payable_payments', 'no_hr_role_staff'),
    ('payable_payments', 'no_pos_pin_staff'),
    ('payable_payments', 'no_self_service_accounts'),
    ('pos_booking_deposits', 'no_hr_role_staff'),
    ('pos_booking_deposits', 'no_ims_staff'),
    ('pos_booking_deposits', 'no_self_service_accounts'),
    ('pos_cash_movements', 'no_hr_role_staff'),
    ('pos_cash_movements', 'no_ims_staff'),
    ('pos_cash_movements', 'no_self_service_accounts'),
    ('pos_combo_groups', 'no_hr_role_staff'),
    ('pos_combo_groups', 'no_self_service_accounts'),
    ('pos_combo_items', 'no_hr_role_staff'),
    ('pos_combo_items', 'no_self_service_accounts'),
    ('pos_combos', 'no_hr_role_staff'),
    ('pos_combos', 'no_self_service_accounts'),
    ('pos_credit_notes', 'no_hr_role_staff'),
    ('pos_credit_notes', 'no_ims_staff'),
    ('pos_credit_notes', 'no_self_service_accounts'),
    ('pos_credit_receipt_lines', 'no_hr_role_staff'),
    ('pos_credit_receipt_lines', 'no_ims_staff'),
    ('pos_credit_receipt_lines', 'no_self_service_accounts'),
    ('pos_credit_receipts', 'no_hr_role_staff'),
    ('pos_credit_receipts', 'no_ims_staff'),
    ('pos_credit_receipts', 'no_self_service_accounts'),
    ('pos_customers', 'no_hr_role_staff'),
    ('pos_customers', 'no_ims_staff'),
    ('pos_customers', 'no_self_service_accounts'),
    ('pos_guest_order_requests', 'no_hr_role_staff'),
    ('pos_guest_order_requests', 'no_ims_staff'),
    ('pos_guest_order_requests', 'no_self_service_accounts'),
    ('pos_kot_log', 'no_hr_role_staff'),
    ('pos_kot_log', 'no_ims_staff'),
    ('pos_kot_log', 'no_self_service_accounts'),
    ('pos_kot_removals', 'no_hr_role_staff'),
    ('pos_kot_removals', 'no_ims_staff'),
    ('pos_kot_removals', 'no_self_service_accounts'),
    ('pos_loyalty_ledger', 'no_hr_role_staff'),
    ('pos_loyalty_ledger', 'no_ims_staff'),
    ('pos_loyalty_ledger', 'no_self_service_accounts'),
    ('pos_loyalty_schemes', 'no_hr_role_staff'),
    ('pos_loyalty_schemes', 'no_ims_staff'),
    ('pos_loyalty_schemes', 'no_self_service_accounts'),
    ('pos_option_groups', 'no_hr_role_staff'),
    ('pos_option_groups', 'no_self_service_accounts'),
    ('pos_option_ingredients', 'no_hr_role_staff'),
    ('pos_option_ingredients', 'no_self_service_accounts'),
    ('pos_options', 'no_hr_role_staff'),
    ('pos_options', 'no_self_service_accounts'),
    ('pos_order_item_options', 'no_hr_role_staff'),
    ('pos_order_item_options', 'no_ims_staff'),
    ('pos_order_item_options', 'no_self_service_accounts'),
    ('pos_order_items', 'no_hr_role_staff'),
    ('pos_order_items', 'no_ims_staff'),
    ('pos_order_items', 'no_self_service_accounts'),
    ('pos_order_payments', 'no_hr_role_staff'),
    ('pos_order_payments', 'no_ims_staff'),
    ('pos_order_payments', 'no_self_service_accounts'),
    ('pos_orders', 'no_hr_role_staff'),
    ('pos_orders', 'no_ims_staff'),
    ('pos_orders', 'no_self_service_accounts'),
    ('pos_parking_slips', 'no_hr_role_staff'),
    ('pos_parking_slips', 'no_ims_staff'),
    ('pos_parking_slips', 'no_self_service_accounts'),
    ('pos_payment_confirmations', 'no_hr_role_staff'),
    ('pos_payment_confirmations', 'no_ims_staff'),
    ('pos_payment_confirmations', 'no_self_service_accounts'),
    ('pos_recipe_option_groups', 'no_hr_role_staff'),
    ('pos_recipe_option_groups', 'no_self_service_accounts'),
    ('pos_reservation_tables', 'no_hr_role_staff'),
    ('pos_reservation_tables', 'no_ims_staff'),
    ('pos_reservation_tables', 'no_self_service_accounts'),
    ('pos_reservations', 'no_hr_role_staff'),
    ('pos_reservations', 'no_ims_staff'),
    ('pos_reservations', 'no_self_service_accounts'),
    ('pos_shifts', 'no_hr_role_staff'),
    ('pos_shifts', 'no_ims_staff'),
    ('pos_shifts', 'no_self_service_accounts'),
    ('pos_table_joins', 'no_hr_role_staff'),
    ('pos_table_joins', 'no_ims_staff'),
    ('pos_table_joins', 'no_self_service_accounts'),
    ('pos_table_moves', 'no_hr_role_staff'),
    ('pos_table_moves', 'no_ims_staff'),
    ('pos_table_moves', 'no_self_service_accounts'),
    ('pos_tables', 'no_hr_role_staff'),
    ('pos_tables', 'no_ims_staff'),
    ('pos_tables', 'no_self_service_accounts'),
    ('profiles', 'profiles_delete'),
    ('profiles', 'profiles_insert'),
    ('profiles', 'profiles_select'),
    ('profiles', 'profiles_update'),
    ('purchase_entries', 'no_hr_role_staff'),
    ('purchase_entries', 'no_pos_pin_staff'),
    ('purchase_entries', 'no_self_service_accounts'),
    ('purchase_entries', 'purchase_entries_all'),
    ('purchase_order_items', 'no_hr_role_staff'),
    ('purchase_order_items', 'no_pos_pin_staff'),
    ('purchase_order_items', 'no_self_service_accounts'),
    ('purchase_orders', 'no_hr_role_staff'),
    ('purchase_orders', 'no_pos_pin_staff'),
    ('purchase_orders', 'no_self_service_accounts'),
    ('recipe_ingredients', 'no_hr_role_staff'),
    ('recipe_ingredients', 'no_self_service_accounts'),
    ('recipe_ingredients', 'recipe_ingredients_all'),
    ('recipe_suggestions', 'no_hr_role_staff'),
    ('recipe_suggestions', 'no_self_service_accounts'),
    ('recipes', 'no_hr_role_staff'),
    ('recipes', 'no_self_service_accounts'),
    ('recipes', 'recipes_all'),
    ('requisition_lines', 'no_hr_role_staff'),
    ('requisition_lines', 'no_pos_pin_staff'),
    ('requisition_lines', 'no_self_service_accounts'),
    ('requisitions', 'no_hr_role_staff'),
    ('requisitions', 'no_pos_pin_staff'),
    ('requisitions', 'no_self_service_accounts'),
    ('sales_entries', 'no_hr_role_staff'),
    ('sales_entries', 'no_self_service_accounts'),
    ('sales_entries', 'sales_entries_all'),
    ('settings', 'no_self_service_delete'),
    ('settings', 'no_self_service_insert'),
    ('settings', 'no_self_service_update'),
    ('settings', 'settings_insert'),
    ('settings', 'settings_select'),
    ('settings', 'settings_update'),
    ('staff_meals', 'no_hr_role_staff'),
    ('staff_meals', 'no_pos_pin_staff'),
    ('staff_meals', 'no_self_service_accounts'),
    ('staff_pin_vault', 'staff_pin_vault_admin'),
    ('stock_movements', 'no_hr_role_staff'),
    ('stock_movements', 'no_self_service_accounts'),
    ('vendor_returns', 'no_hr_role_staff'),
    ('vendor_returns', 'no_pos_pin_staff'),
    ('vendor_returns', 'no_self_service_accounts'),
    ('vendors', 'no_hr_role_staff'),
    ('vendors', 'no_pos_pin_staff'),
    ('vendors', 'no_self_service_accounts'),
    ('vendors', 'vendors_all'),
    ('wastages', 'no_hr_role_staff'),
    ('wastages', 'no_pos_pin_staff'),
    ('wastages', 'no_self_service_accounts'),
    ('wastages', 'wastages_all');

DO $$
DECLARE
  n  int;
  fp text;
BEGIN
  SELECT count(*),
         md5(string_agg(b.tablename || '.' || b.policyname || '|' || coalesce(b.qual, '') || '|' || coalesce(b.with_check, ''),
                        E'\n' ORDER BY b.tablename COLLATE "C", b.policyname COLLATE "C"))
    INTO n, fp
  FROM _perf12_before b
  JOIN _perf12_targets t USING (tablename, policyname);

  IF n <> 307 OR fp IS DISTINCT FROM '1e62dec7960c7b4d1c09dea414b3b21d' THEN
    RAISE EXCEPTION 'PERF-12: found % of 307 target policies (fingerprint %). A policy changed after this file was generated: regenerate it.', n, fp;
  END IF;
END $$;

ALTER POLICY "app_secrets_admin" ON public."app_secrets"
  USING (( SELECT is_admin() AS is_admin))
  WITH CHECK (( SELECT is_admin() AS is_admin));

ALTER POLICY "no_hr_role_staff" ON public."assets_categories"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."assets_categories"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."assets_categories"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."assets_depreciation_runs"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."assets_depreciation_runs"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."assets_depreciation_runs"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."assets_depreciation_schedule"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."assets_depreciation_schedule"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."assets_depreciation_schedule"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."assets_register"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."assets_register"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."assets_register"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."assets_repair_expenses"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."assets_repair_expenses"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."assets_repair_expenses"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."assets_tax_pool_lines"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."assets_tax_pool_lines"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."assets_tax_pool_lines"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."assets_tax_pool_opening_corrections"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."assets_tax_pool_opening_corrections"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."assets_tax_pool_opening_corrections"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."assets_tax_pool_openings"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."assets_tax_pool_openings"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."assets_tax_pool_openings"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."assets_tax_pool_runs"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."assets_tax_pool_runs"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."assets_tax_pool_runs"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."budgets"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."budgets"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."budgets"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "categories_all" ON public."categories"
  USING (((client_id = ( SELECT my_client_id() AS my_client_id)) OR ( SELECT is_admin() AS is_admin)))
  WITH CHECK (((client_id = ( SELECT my_client_id() AS my_client_id)) OR ( SELECT is_admin() AS is_admin)));

ALTER POLICY "no_hr_role_staff" ON public."categories"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."categories"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."categories"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "client_secrets_admin" ON public."client_secrets"
  USING (( SELECT is_admin() AS is_admin))
  WITH CHECK (( SELECT is_admin() AS is_admin));

ALTER POLICY "clients_delete" ON public."clients"
  USING (( SELECT is_admin() AS is_admin));

ALTER POLICY "clients_insert" ON public."clients"
  WITH CHECK (( SELECT is_admin() AS is_admin));

ALTER POLICY "clients_update" ON public."clients"
  USING (( SELECT is_admin() AS is_admin));

ALTER POLICY "closing_stock_all" ON public."closing_stock"
  USING ((( SELECT is_admin() AS is_admin) OR (EXISTS ( SELECT 1
   FROM monthly_periods p
  WHERE ((p.id = closing_stock.period_id) AND (p.client_id = ( SELECT my_client_id() AS my_client_id)))))))
  WITH CHECK ((( SELECT is_admin() AS is_admin) OR (EXISTS ( SELECT 1
   FROM monthly_periods p
  WHERE ((p.id = closing_stock.period_id) AND (p.client_id = ( SELECT my_client_id() AS my_client_id)))))));

ALTER POLICY "no_hr_role_staff" ON public."closing_stock"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."closing_stock"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."closing_stock"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff_delete" ON public."demand_forecast_daily"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_hr_role_staff_insert" ON public."demand_forecast_daily"
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_hr_role_staff_update" ON public."demand_forecast_daily"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."demand_forecast_daily"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."demand_forecast_daily"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."demand_forecast_run_log"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."demand_forecast_run_log"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."demand_forecast_run_log"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "feature_flags_delete" ON public."feature_flags"
  USING (( SELECT is_admin() AS is_admin));

ALTER POLICY "feature_flags_insert" ON public."feature_flags"
  WITH CHECK (( SELECT is_admin() AS is_admin));

ALTER POLICY "feature_flags_select" ON public."feature_flags"
  USING ((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))));

ALTER POLICY "feature_flags_update" ON public."feature_flags"
  USING (( SELECT is_admin() AS is_admin))
  WITH CHECK (( SELECT is_admin() AS is_admin));

ALTER POLICY "client_own" ON public."hr_advance_repayments"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_advance_repayments"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_advance_repayments"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "client_own" ON public."hr_advances"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_advances"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_advances"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "client_own" ON public."hr_attendance"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_attendance"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_attendance"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "hr_employees_delete" ON public."hr_employees"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "hr_employees_insert" ON public."hr_employees"
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "hr_employees_select" ON public."hr_employees"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_employees"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_employees"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "client_own" ON public."hr_festival_allowances"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_festival_allowances"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_festival_allowances"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "hr_final_settlements_all" ON public."hr_final_settlements"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_final_settlements"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_final_settlements"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "client_own" ON public."hr_holiday_calendar"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_holiday_calendar"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_holiday_calendar"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "client_own" ON public."hr_incentive_configs"
  USING ((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))))
  WITH CHECK ((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))));

ALTER POLICY "no_ims_staff" ON public."hr_incentive_configs"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_incentive_configs"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "client_own" ON public."hr_incentives"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_incentives"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_incentives"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "client_own" ON public."hr_leave_requests"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_leave_requests"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_leave_requests"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "client_own" ON public."hr_leave_types"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_leave_types"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_leave_types"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "client_own" ON public."hr_overtime_entries"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_overtime_entries"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_overtime_entries"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "client_own" ON public."hr_payroll_runs"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_payroll_runs"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_payroll_runs"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "client_own" ON public."hr_payslips"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_payslips"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_payslips"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "client_access" ON public."hr_roster"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_roster"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_roster"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "client_own" ON public."hr_roster_publish_state"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_roster_publish_state"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_roster_publish_state"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "client_own" ON public."hr_salary_components"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_salary_components"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_salary_components"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_ims_staff" ON public."hr_salary_payments"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_salary_payments"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "client_own" ON public."hr_shift_swap_requests"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_shift_swap_requests"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_shift_swap_requests"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "client_own" ON public."hr_shift_types"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_shift_types"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_shift_types"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_ims_staff" ON public."hr_tada_claim_items"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_tada_claim_items"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "client_own" ON public."hr_tada_claims"
  USING (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))))
  WITH CHECK (((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))) AND (NOT ( SELECT is_hr_self_service() AS is_hr_self_service))));

ALTER POLICY "no_ims_staff" ON public."hr_tada_claims"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."hr_tada_claims"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "ims_count_assignments_delete" ON public."ims_count_assignments"
  USING (COALESCE((( SELECT is_admin() AS is_admin) OR ((client_id = ( SELECT my_client_id() AS my_client_id)) AND ( SELECT ims_can_manage_counts() AS ims_can_manage_counts))), false));

ALTER POLICY "ims_count_assignments_insert" ON public."ims_count_assignments"
  WITH CHECK (COALESCE((( SELECT is_admin() AS is_admin) OR ((client_id = ( SELECT my_client_id() AS my_client_id)) AND ( SELECT ims_can_manage_counts() AS ims_can_manage_counts))), false));

ALTER POLICY "ims_count_assignments_select" ON public."ims_count_assignments"
  USING (COALESCE((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))), false));

ALTER POLICY "ims_count_assignments_update" ON public."ims_count_assignments"
  USING (COALESCE((( SELECT is_admin() AS is_admin) OR ((client_id = ( SELECT my_client_id() AS my_client_id)) AND ( SELECT ims_can_manage_counts() AS ims_can_manage_counts))), false))
  WITH CHECK (COALESCE((( SELECT is_admin() AS is_admin) OR ((client_id = ( SELECT my_client_id() AS my_client_id)) AND ( SELECT ims_can_manage_counts() AS ims_can_manage_counts))), false));

ALTER POLICY "no_hr_role_staff" ON public."ims_count_assignments"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."ims_count_assignments"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."ims_count_assignments"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."ims_gate_passes"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."ims_gate_passes"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."ims_gate_passes"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."ims_stock_transfer_lines"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."ims_stock_transfer_lines"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."ims_stock_transfer_lines"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."ims_stock_transfers"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."ims_stock_transfers"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."ims_stock_transfers"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "items_all" ON public."items"
  USING (((client_id = ( SELECT my_client_id() AS my_client_id)) OR ( SELECT is_admin() AS is_admin)))
  WITH CHECK (((client_id = ( SELECT my_client_id() AS my_client_id)) OR ( SELECT is_admin() AS is_admin)));

ALTER POLICY "no_hr_role_staff" ON public."items"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."items"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."items"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."legal_acceptances"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."legal_acceptances"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."legal_acceptances"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."legal_acceptances"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "monthly_owner_reports_all" ON public."monthly_owner_reports"
  USING (((client_id = ( SELECT my_client_id() AS my_client_id)) OR ( SELECT is_admin() AS is_admin)))
  WITH CHECK (((client_id = ( SELECT my_client_id() AS my_client_id)) OR ( SELECT is_admin() AS is_admin)));

ALTER POLICY "no_hr_role_staff" ON public."monthly_owner_reports"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."monthly_owner_reports"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."monthly_owner_reports"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."monthly_owner_reports"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "monthly_periods_all" ON public."monthly_periods"
  USING (((client_id = ( SELECT my_client_id() AS my_client_id)) OR ( SELECT is_admin() AS is_admin)))
  WITH CHECK (((client_id = ( SELECT my_client_id() AS my_client_id)) OR ( SELECT is_admin() AS is_admin)));

ALTER POLICY "no_hr_role_staff_delete" ON public."monthly_periods"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_hr_role_staff_insert" ON public."monthly_periods"
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_hr_role_staff_update" ON public."monthly_periods"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_self_service_accounts" ON public."monthly_periods"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."opening_stock"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."opening_stock"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."opening_stock"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "opening_stock_all" ON public."opening_stock"
  USING ((( SELECT is_admin() AS is_admin) OR (EXISTS ( SELECT 1
   FROM monthly_periods p
  WHERE ((p.id = opening_stock.period_id) AND (p.client_id = ( SELECT my_client_id() AS my_client_id)))))))
  WITH CHECK ((( SELECT is_admin() AS is_admin) OR (EXISTS ( SELECT 1
   FROM monthly_periods p
  WHERE ((p.id = opening_stock.period_id) AND (p.client_id = ( SELECT my_client_id() AS my_client_id)))))));

ALTER POLICY "no_hr_role_staff" ON public."overheads"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."overheads"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."overheads"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "overheads_all" ON public."overheads"
  USING (((client_id = ( SELECT my_client_id() AS my_client_id)) OR ( SELECT is_admin() AS is_admin)))
  WITH CHECK (((client_id = ( SELECT my_client_id() AS my_client_id)) OR ( SELECT is_admin() AS is_admin)));

ALTER POLICY "no_hr_role_staff" ON public."par_levels"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."par_levels"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."par_levels"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "par_levels_all" ON public."par_levels"
  USING (((client_id = ( SELECT my_client_id() AS my_client_id)) OR ( SELECT is_admin() AS is_admin)))
  WITH CHECK (((client_id = ( SELECT my_client_id() AS my_client_id)) OR ( SELECT is_admin() AS is_admin)));

ALTER POLICY "no_hr_role_staff" ON public."payable_payments"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."payable_payments"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."payable_payments"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_booking_deposits"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_booking_deposits"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_booking_deposits"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_cash_movements"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_cash_movements"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_cash_movements"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_combo_groups"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_combo_groups"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_combo_items"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_combo_items"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_combos"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_combos"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_credit_notes"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_credit_notes"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_credit_notes"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_credit_receipt_lines"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_credit_receipt_lines"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_credit_receipt_lines"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_credit_receipts"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_credit_receipts"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_credit_receipts"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_customers"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_customers"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_customers"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_guest_order_requests"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_guest_order_requests"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_guest_order_requests"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_kot_log"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_kot_log"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_kot_log"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_kot_removals"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_kot_removals"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_kot_removals"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_loyalty_ledger"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_loyalty_ledger"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_loyalty_ledger"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_loyalty_schemes"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_loyalty_schemes"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_loyalty_schemes"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_option_groups"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_option_groups"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_option_ingredients"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_option_ingredients"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_options"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_options"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_order_item_options"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_order_item_options"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_order_item_options"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_order_items"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_order_items"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_order_items"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_order_payments"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_order_payments"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_order_payments"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_orders"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_orders"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_orders"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_parking_slips"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_parking_slips"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_parking_slips"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_payment_confirmations"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_payment_confirmations"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_payment_confirmations"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_recipe_option_groups"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_recipe_option_groups"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_reservation_tables"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_reservation_tables"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_reservation_tables"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_reservations"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_reservations"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_reservations"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_shifts"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_shifts"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_shifts"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_table_joins"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_table_joins"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_table_joins"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_table_moves"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_table_moves"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_table_moves"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."pos_tables"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_ims_staff" ON public."pos_tables"
  USING ((NOT ( SELECT is_ims_staff() AS is_ims_staff)))
  WITH CHECK ((NOT ( SELECT is_ims_staff() AS is_ims_staff)));

ALTER POLICY "no_self_service_accounts" ON public."pos_tables"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "profiles_delete" ON public."profiles"
  USING (( SELECT is_admin() AS is_admin));

ALTER POLICY "profiles_insert" ON public."profiles"
  WITH CHECK (( SELECT is_admin() AS is_admin));

ALTER POLICY "profiles_select" ON public."profiles"
  USING (((id = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin)));

ALTER POLICY "profiles_update" ON public."profiles"
  USING (((id = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin)))
  WITH CHECK (((id = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin)));

ALTER POLICY "no_hr_role_staff" ON public."purchase_entries"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."purchase_entries"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."purchase_entries"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "purchase_entries_all" ON public."purchase_entries"
  USING ((( SELECT is_admin() AS is_admin) OR (EXISTS ( SELECT 1
   FROM monthly_periods p
  WHERE ((p.id = purchase_entries.period_id) AND (p.client_id = ( SELECT my_client_id() AS my_client_id)))))))
  WITH CHECK ((( SELECT is_admin() AS is_admin) OR (EXISTS ( SELECT 1
   FROM monthly_periods p
  WHERE ((p.id = purchase_entries.period_id) AND (p.client_id = ( SELECT my_client_id() AS my_client_id)))))));

ALTER POLICY "no_hr_role_staff" ON public."purchase_order_items"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."purchase_order_items"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."purchase_order_items"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."purchase_orders"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."purchase_orders"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."purchase_orders"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."recipe_ingredients"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_self_service_accounts" ON public."recipe_ingredients"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "recipe_ingredients_all" ON public."recipe_ingredients"
  USING ((( SELECT is_admin() AS is_admin) OR (EXISTS ( SELECT 1
   FROM recipes r
  WHERE ((r.id = recipe_ingredients.recipe_id) AND (r.client_id = ( SELECT my_client_id() AS my_client_id)))))))
  WITH CHECK ((( SELECT is_admin() AS is_admin) OR (EXISTS ( SELECT 1
   FROM recipes r
  WHERE ((r.id = recipe_ingredients.recipe_id) AND (r.client_id = ( SELECT my_client_id() AS my_client_id)))))));

ALTER POLICY "no_hr_role_staff" ON public."recipe_suggestions"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_self_service_accounts" ON public."recipe_suggestions"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."recipes"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_self_service_accounts" ON public."recipes"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "recipes_all" ON public."recipes"
  USING (((client_id = ( SELECT my_client_id() AS my_client_id)) OR ( SELECT is_admin() AS is_admin)))
  WITH CHECK (((client_id = ( SELECT my_client_id() AS my_client_id)) OR ( SELECT is_admin() AS is_admin)));

ALTER POLICY "no_hr_role_staff" ON public."requisition_lines"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."requisition_lines"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."requisition_lines"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."requisitions"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."requisitions"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."requisitions"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."sales_entries"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_self_service_accounts" ON public."sales_entries"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "sales_entries_all" ON public."sales_entries"
  USING ((( SELECT is_admin() AS is_admin) OR (EXISTS ( SELECT 1
   FROM monthly_periods p
  WHERE ((p.id = sales_entries.period_id) AND (p.client_id = ( SELECT my_client_id() AS my_client_id)))))))
  WITH CHECK ((( SELECT is_admin() AS is_admin) OR (EXISTS ( SELECT 1
   FROM monthly_periods p
  WHERE ((p.id = sales_entries.period_id) AND (p.client_id = ( SELECT my_client_id() AS my_client_id)))))));

ALTER POLICY "no_self_service_delete" ON public."settings"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_self_service_insert" ON public."settings"
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_self_service_update" ON public."settings"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "settings_insert" ON public."settings"
  WITH CHECK ((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))));

ALTER POLICY "settings_select" ON public."settings"
  USING (((client_id IS NULL) OR (client_id = ( SELECT my_client_id() AS my_client_id)) OR ( SELECT is_admin() AS is_admin)));

ALTER POLICY "settings_update" ON public."settings"
  USING ((( SELECT is_admin() AS is_admin) OR (client_id = ( SELECT my_client_id() AS my_client_id))));

ALTER POLICY "no_hr_role_staff" ON public."staff_meals"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."staff_meals"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."staff_meals"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "staff_pin_vault_admin" ON public."staff_pin_vault"
  USING (( SELECT is_admin() AS is_admin))
  WITH CHECK (( SELECT is_admin() AS is_admin));

ALTER POLICY "no_hr_role_staff" ON public."stock_movements"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_self_service_accounts" ON public."stock_movements"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."vendor_returns"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."vendor_returns"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."vendor_returns"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "no_hr_role_staff" ON public."vendors"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."vendors"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."vendors"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "vendors_all" ON public."vendors"
  USING (((client_id = ( SELECT my_client_id() AS my_client_id)) OR ( SELECT is_admin() AS is_admin)))
  WITH CHECK (((client_id = ( SELECT my_client_id() AS my_client_id)) OR ( SELECT is_admin() AS is_admin)));

ALTER POLICY "no_hr_role_staff" ON public."wastages"
  USING ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)))
  WITH CHECK ((NOT ( SELECT is_hr_role_staff() AS is_hr_role_staff)));

ALTER POLICY "no_pos_pin_staff" ON public."wastages"
  USING ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)))
  WITH CHECK ((NOT ( SELECT is_pos_pin_staff() AS is_pos_pin_staff)));

ALTER POLICY "no_self_service_accounts" ON public."wastages"
  USING ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)))
  WITH CHECK ((NOT ( SELECT is_hr_self_service() AS is_hr_self_service)));

ALTER POLICY "wastages_all" ON public."wastages"
  USING ((( SELECT is_admin() AS is_admin) OR (EXISTS ( SELECT 1
   FROM monthly_periods p
  WHERE ((p.id = wastages.period_id) AND (p.client_id = ( SELECT my_client_id() AS my_client_id)))))))
  WITH CHECK ((( SELECT is_admin() AS is_admin) OR (EXISTS ( SELECT 1
   FROM monthly_periods p
  WHERE ((p.id = wastages.period_id) AND (p.client_id = ( SELECT my_client_id() AS my_client_id)))))));

DO $$
DECLARE
  n int;
BEGIN
  -- (a) Every policy unwraps back to its old text, and nothing else about it moved.
  SELECT count(*) INTO n
  FROM _perf12_before b
  LEFT JOIN pg_policies a
    ON a.schemaname = 'public' AND a.tablename = b.tablename AND a.policyname = b.policyname
  WHERE a.policyname IS NULL
     OR a.permissive IS DISTINCT FROM b.permissive
     OR a.cmd IS DISTINCT FROM b.cmd
     OR a.roles IS DISTINCT FROM b.roles
     OR (a.qual IS NULL) <> (b.qual IS NULL)
     OR (a.with_check IS NULL) <> (b.with_check IS NULL)
     OR regexp_replace(coalesce(a.qual, ''), '\( SELECT (is_admin|my_client_id|is_hr_self_service|is_hr_role_staff|is_pos_pin_staff|is_ims_staff|ims_can_manage_counts)\(\) AS \1\)', '\1()', 'g')
        IS DISTINCT FROM regexp_replace(coalesce(b.qual, ''), '\( SELECT (is_admin|my_client_id|is_hr_self_service|is_hr_role_staff|is_pos_pin_staff|is_ims_staff|ims_can_manage_counts)\(\) AS \1\)', '\1()', 'g')
     OR regexp_replace(coalesce(a.with_check, ''), '\( SELECT (is_admin|my_client_id|is_hr_self_service|is_hr_role_staff|is_pos_pin_staff|is_ims_staff|ims_can_manage_counts)\(\) AS \1\)', '\1()', 'g')
        IS DISTINCT FROM regexp_replace(coalesce(b.with_check, ''), '\( SELECT (is_admin|my_client_id|is_hr_self_service|is_hr_role_staff|is_pos_pin_staff|is_ims_staff|ims_can_manage_counts)\(\) AS \1\)', '\1()', 'g');
  IF n > 0 THEN
    RAISE EXCEPTION 'PERF-12 check (a): % policies differ from their old text by more than the wrapping', n;
  END IF;

  -- (b) No policy appeared or disappeared.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> (SELECT count(*) FROM _perf12_before) THEN
    RAISE EXCEPTION 'PERF-12 check (b): the public policy count changed';
  END IF;

  -- (c) Every target was actually rewritten.
  SELECT count(*) INTO n
  FROM _perf12_targets t
  JOIN _perf12_before b USING (tablename, policyname)
  JOIN pg_policies a
    ON a.schemaname = 'public' AND a.tablename = t.tablename AND a.policyname = t.policyname
  WHERE coalesce(a.qual, '') = coalesce(b.qual, '')
    AND coalesce(a.with_check, '') = coalesce(b.with_check, '');
  IF n > 0 THEN
    RAISE EXCEPTION 'PERF-12 check (c): % target policies were not rewritten', n;
  END IF;

  -- (d) No bare call to the seven helpers is left in any public policy.
  SELECT count(*) INTO n
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (coalesce(qual, '') ~ '(?<!SELECT )(?<![.\w])(is_admin|my_client_id|is_hr_self_service|is_hr_role_staff|is_pos_pin_staff|is_ims_staff|ims_can_manage_counts)\(\)'
      OR coalesce(with_check, '') ~ '(?<!SELECT )(?<![.\w])(is_admin|my_client_id|is_hr_self_service|is_hr_role_staff|is_pos_pin_staff|is_ims_staff|ims_can_manage_counts)\(\)');
  IF n > 0 THEN
    RAISE EXCEPTION 'PERF-12 check (d): % policies still call a helper bare', n;
  END IF;
END $$;

COMMIT;

