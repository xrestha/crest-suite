-- 46 columns used in RLS filters (client_id) and hot-path WHERE/join clauses
-- (period_id, item_id, recipe_id) had no supporting index, forcing a sequential
-- scan on every request. Found via a pg_index anti-join against known filter
-- column names, run manually against the live project on 2026-07-27.
--
-- APPLY NOTE: plain CREATE INDEX (not CONCURRENTLY) so this can be pasted as one
-- block into the Supabase SQL Editor and run with a single click, matching this
-- project's normal migration-apply workflow. Trade-off: each statement briefly
-- locks its table against writes while it builds (reads are unaffected) — on
-- this project's current data size that should be seconds per table, not
-- minutes, but still best run during a quiet moment rather than mid-service.

CREATE INDEX IF NOT EXISTS idx_audit_logs_client_id ON public.audit_logs(client_id);
CREATE INDEX IF NOT EXISTS idx_budgets_client_id ON public.budgets(client_id);
CREATE INDEX IF NOT EXISTS idx_demand_forecast_daily_client_id ON public.demand_forecast_daily(client_id);
CREATE INDEX IF NOT EXISTS idx_demand_forecast_daily_recipe_id ON public.demand_forecast_daily(recipe_id);
CREATE INDEX IF NOT EXISTS idx_demand_forecast_run_log_client_id ON public.demand_forecast_run_log(client_id);
CREATE INDEX IF NOT EXISTS idx_hr_advance_repayments_client_id ON public.hr_advance_repayments(client_id);
CREATE INDEX IF NOT EXISTS idx_hr_advances_client_id ON public.hr_advances(client_id);
CREATE INDEX IF NOT EXISTS idx_hr_attendance_client_id ON public.hr_attendance(client_id);
CREATE INDEX IF NOT EXISTS idx_hr_employees_client_id ON public.hr_employees(client_id);
CREATE INDEX IF NOT EXISTS idx_hr_incentive_configs_client_id ON public.hr_incentive_configs(client_id);
CREATE INDEX IF NOT EXISTS idx_hr_leave_requests_client_id ON public.hr_leave_requests(client_id);
CREATE INDEX IF NOT EXISTS idx_hr_payslips_client_id ON public.hr_payslips(client_id);
CREATE INDEX IF NOT EXISTS idx_hr_salary_components_client_id ON public.hr_salary_components(client_id);
CREATE INDEX IF NOT EXISTS idx_hr_shift_swap_requests_client_id ON public.hr_shift_swap_requests(client_id);
CREATE INDEX IF NOT EXISTS idx_hr_shift_types_client_id ON public.hr_shift_types(client_id);
CREATE INDEX IF NOT EXISTS idx_hr_tada_claims_client_id ON public.hr_tada_claims(client_id);
CREATE INDEX IF NOT EXISTS idx_items_client_id ON public.items(client_id);
CREATE INDEX IF NOT EXISTS idx_overheads_client_id ON public.overheads(client_id);
CREATE INDEX IF NOT EXISTS idx_overheads_period_id ON public.overheads(period_id);
CREATE INDEX IF NOT EXISTS idx_payable_payments_client_id ON public.payable_payments(client_id);
CREATE INDEX IF NOT EXISTS idx_pos_credit_notes_client_id ON public.pos_credit_notes(client_id);
CREATE INDEX IF NOT EXISTS idx_pos_kot_log_client_id ON public.pos_kot_log(client_id);
CREATE INDEX IF NOT EXISTS idx_pos_order_items_client_id ON public.pos_order_items(client_id);
CREATE INDEX IF NOT EXISTS idx_pos_order_items_recipe_id ON public.pos_order_items(recipe_id);
CREATE INDEX IF NOT EXISTS idx_pos_order_payments_client_id ON public.pos_order_payments(client_id);
CREATE INDEX IF NOT EXISTS idx_pos_orders_client_id ON public.pos_orders(client_id);
CREATE INDEX IF NOT EXISTS idx_pos_tables_client_id ON public.pos_tables(client_id);
CREATE INDEX IF NOT EXISTS idx_profiles_client_id ON public.profiles(client_id);
CREATE INDEX IF NOT EXISTS idx_purchase_entries_item_id ON public.purchase_entries(item_id);
CREATE INDEX IF NOT EXISTS idx_purchase_entries_period_id ON public.purchase_entries(period_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_item_id ON public.purchase_order_items(item_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_period_id ON public.purchase_orders(period_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_client_id ON public.push_subscriptions(client_id);
CREATE INDEX IF NOT EXISTS idx_recipe_suggestions_client_id ON public.recipe_suggestions(client_id);
CREATE INDEX IF NOT EXISTS idx_requisition_lines_item_id ON public.requisition_lines(item_id);
CREATE INDEX IF NOT EXISTS idx_requisitions_client_id ON public.requisitions(client_id);
CREATE INDEX IF NOT EXISTS idx_requisitions_period_id ON public.requisitions(period_id);
CREATE INDEX IF NOT EXISTS idx_sales_entries_period_id ON public.sales_entries(period_id);
CREATE INDEX IF NOT EXISTS idx_sales_entries_recipe_id ON public.sales_entries(recipe_id);
CREATE INDEX IF NOT EXISTS idx_settings_client_id ON public.settings(client_id);
CREATE INDEX IF NOT EXISTS idx_staff_meals_item_id ON public.staff_meals(item_id);
CREATE INDEX IF NOT EXISTS idx_staff_meals_period_id ON public.staff_meals(period_id);
CREATE INDEX IF NOT EXISTS idx_vendor_returns_client_id ON public.vendor_returns(client_id);
CREATE INDEX IF NOT EXISTS idx_vendor_returns_item_id ON public.vendor_returns(item_id);
CREATE INDEX IF NOT EXISTS idx_vendor_returns_period_id ON public.vendor_returns(period_id);
CREATE INDEX IF NOT EXISTS idx_vendors_client_id ON public.vendors(client_id);
CREATE INDEX IF NOT EXISTS idx_wastages_item_id ON public.wastages(item_id);
CREATE INDEX IF NOT EXISTS idx_wastages_period_id ON public.wastages(period_id);
