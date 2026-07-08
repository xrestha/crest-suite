-- "Debug IMS" pass (S316) found the module-level twin of S314's HR gap, and it's bigger.
--
-- All three login types admin-user-ops creates — the client owner, POS PIN staff
-- (create_pos_staff), and HR self-service staff (create_hr_self_service_login) — get the same
-- profile shape: role='client' + the tenant's client_id. Every standard RLS policy in the
-- project is "admin OR same client_id", so at the DB level the three are indistinguishable:
--
--   * An HR self-service account (a cook, password = 4–6 digit PIN) passed same-client RLS on
--     every IMS and POS table: the full item master with costs, every purchase and its rates,
--     supplier list, recipes with ingredient costings, all sales — readable AND writable over
--     the REST API with just the anon key + their JWT. S306/S314 fenced these accounts off the
--     HR tables only.
--   * A POS PIN staff account (a waiter) passed RLS on *everything* — including every hr_ table:
--     the whole staff's payslips, salaries, advances, attendance — plus the same full IMS write
--     access. No exclusion had ever applied to these accounts.
--
-- Fix: RESTRICTIVE policies. They AND with the existing permissive ones, so nothing needs to be
-- dropped/recreated per table (S314 did that for 8 tables; at 70+ policy rewrites the risk of a
-- transcription slip outweighs the stylistic consistency). SECURITY DEFINER RPCs (get_my_roster,
-- get_guest_menu, submit_my_leave_request, ...) run as the function owner and bypass RLS, so
-- every legitimate staff flow keeps working; the service role bypasses RLS entirely.
--
-- What deliberately stays OPEN, and why:
--   * settings (self-service: SELECT only) — SelfServiceHome reads weekly_off_weekday directly.
--   * settings (POS staff: read + write) — PosTableManagement's Discounts/Quick Notes/Ticket
--     Routing/Delivery Partners tabs are manager-gated UI that a PIN manager runs (S290 fixed
--     exactly this write path; don't re-break it).
--   * clients, feature_flags, profiles, push_subscriptions — AuthContext's profile query joins
--     clients; SettingsContext loads feature_flags for every session; profiles is already
--     self-or-admin; push_subscriptions is already own-row.
--   * For POS staff: recipes, recipe_ingredients, recipe_suggestions (Menu Pricing is in the POS
--     nav at minPosRole 'manager' and edits all three), sales_entries + monthly_periods +
--     stock_movements (billing posts sales and deducts stock), and all pos_* tables.
--   * audit_logs — written by AFTER triggers on actions these accounts can still legitimately
--     perform (e.g. a PIN manager editing a recipe price must not fail its audit insert).

CREATE FUNCTION public.is_pos_pin_staff() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE(pos_email IS NOT NULL, false) FROM profiles WHERE id = auth.uid()
$$;

DO $$
DECLARE
  t text;
BEGIN
  -- ── HR self-service accounts: blocked from every IMS + POS business table ────────────────
  -- (their app reads settings + RPCs only — verified against SelfServiceHome/SelfServiceLogin)
  FOREACH t IN ARRAY ARRAY[
    'budgets', 'categories', 'closing_stock', 'demand_forecast_daily', 'demand_forecast_run_log',
    'items', 'monthly_periods', 'opening_stock', 'overheads', 'par_levels', 'payable_payments',
    'pos_credit_notes', 'pos_customers', 'pos_guest_order_requests', 'pos_kot_log',
    'pos_order_items', 'pos_order_payments', 'pos_orders', 'pos_payment_confirmations',
    'pos_shifts', 'pos_tables', 'purchase_entries', 'purchase_order_items', 'purchase_orders',
    'recipe_ingredients', 'recipe_suggestions', 'recipes', 'requisition_lines', 'requisitions',
    'sales_entries', 'staff_meals', 'stock_movements', 'vendor_returns', 'vendors', 'wastages'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY no_self_service_accounts ON public.%I AS RESTRICTIVE FOR ALL '
      || 'USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service())',
      t);
  END LOOP;

  -- ── POS PIN staff accounts: blocked from every hr_ table and the pure-IMS tables the POS
  -- module never touches (list derived from an actual scan of src/modules/pos + Menu Pricing) ──
  FOREACH t IN ARRAY ARRAY[
    -- all 20 HR tables (a waiter's PIN account could read everyone's payslips before this)
    'hr_advance_repayments', 'hr_advances', 'hr_attendance', 'hr_employees',
    'hr_festival_allowances', 'hr_holiday_calendar', 'hr_incentive_configs', 'hr_incentives',
    'hr_leave_requests', 'hr_leave_types', 'hr_overtime_entries', 'hr_payroll_runs',
    'hr_payslips', 'hr_roster', 'hr_roster_publish_state', 'hr_salary_components',
    'hr_shift_swap_requests', 'hr_shift_types', 'hr_tada_claim_items', 'hr_tada_claims',
    -- pure-IMS tables with no POS code path
    'budgets', 'categories', 'closing_stock', 'demand_forecast_daily', 'demand_forecast_run_log',
    'items', 'opening_stock', 'overheads', 'par_levels', 'payable_payments', 'purchase_entries',
    'purchase_order_items', 'purchase_orders', 'requisition_lines', 'requisitions',
    'staff_meals', 'vendor_returns', 'vendors', 'wastages'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY no_pos_pin_staff ON public.%I AS RESTRICTIVE FOR ALL '
      || 'USING (NOT public.is_pos_pin_staff()) WITH CHECK (NOT public.is_pos_pin_staff())',
      t);
  END LOOP;
END $$;

-- settings: self-service keeps SELECT (SelfServiceHome reads weekly_off_weekday), loses writes.
-- Three command-scoped restrictive policies because FOR ALL would take SELECT down with them.
CREATE POLICY no_self_service_insert ON public.settings AS RESTRICTIVE FOR INSERT
  WITH CHECK (NOT public.is_hr_self_service());
CREATE POLICY no_self_service_update ON public.settings AS RESTRICTIVE FOR UPDATE
  USING (NOT public.is_hr_self_service());
CREATE POLICY no_self_service_delete ON public.settings AS RESTRICTIVE FOR DELETE
  USING (NOT public.is_hr_self_service());

NOTIFY pgrst, 'reload schema';
