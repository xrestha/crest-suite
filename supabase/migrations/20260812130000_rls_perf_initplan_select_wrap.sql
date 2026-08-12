-- Supabase performance advisor: `auth_rls_initplan` (0003) — 41 policies flagged.
--
-- A bare `auth.uid()` in a policy expression is re-evaluated once per candidate row. Wrapping it
-- as `(select auth.uid())` turns it into an InitPlan the planner evaluates once per query. The
-- rewrite below is purely syntactic: every expression is byte-identical to the one currently
-- deployed apart from that substitution, so no policy's admitted row set changes.
--
-- 36 statements, not 41. The other five flagged policies are removed outright by
-- 20260812120000_rls_perf_consolidate_permissive_policies.sql, which must be applied FIRST:
--   sales_entries.sales_entries_select, purchase_orders.client_purchase_orders,
--   purchase_order_items.client_po_items, and vendor_returns' "admin all" / "client insert".
--
-- ALTER POLICY is used rather than DROP + CREATE deliberately: it changes only the expression and
-- leaves the policy's command and role list untouched, so there is no window in which a table
-- sits with a policy missing, and no chance of a transcription slip in a FOR/TO clause. Where a
-- policy has USING only (a FOR ALL policy with no explicit WITH CHECK, or a SELECT/DELETE
-- policy), only USING is restated — an omitted clause is left as-is by ALTER POLICY.
--
-- ── Known follow-up, deliberately NOT done here ─────────────────────────────────────────────
-- The linter only pattern-matches `auth.<fn>()` and `current_setting()`, so it says nothing about
-- `public.is_admin()` / `public.my_client_id()` / `public.is_hr_self_service()` — which appear in
-- roughly 120 policies across the project and are the larger cost. All three are
-- `LANGUAGE sql STABLE SECURITY DEFINER`, and Postgres refuses to inline a SECURITY DEFINER SQL
-- function (inline_function() bails on prosecdef), so each one is a real function call per row
-- rather than a folded-in subquery the planner can hoist. Wrapping them as
-- `(select public.is_admin())` would hoist them the same way this migration hoists auth.uid().
-- That is a much wider change than the advisor asked for and wants its own pass with a live
-- EXPLAIN to confirm the win, so it is scoped out. The two policies this migration set recreates
-- from scratch (hr_employees_update, vendor_returns_all) already use the wrapped form.
--
-- Verify afterwards (expect zero rows):
--   SELECT tablename, policyname FROM pg_policies
--   WHERE schemaname = 'public'
--     AND (qual ~ 'auth\.uid\(\)' OR with_check ~ 'auth\.uid\(\)')
--     AND NOT (coalesce(qual,'') || coalesce(with_check,'')) ~* '\( SELECT auth\.uid\(\)';

BEGIN;

ALTER POLICY assets_categories_client ON public.assets_categories
  USING (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  )
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  );

ALTER POLICY assets_depreciation_runs_client ON public.assets_depreciation_runs
  USING (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  )
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  );

ALTER POLICY assets_depreciation_schedule_client ON public.assets_depreciation_schedule
  USING (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  )
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  );

ALTER POLICY assets_register_client ON public.assets_register
  USING (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  )
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  );

ALTER POLICY assets_repair_expenses_client ON public.assets_repair_expenses
  USING (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  )
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  );

ALTER POLICY assets_tax_pool_lines_client ON public.assets_tax_pool_lines
  USING (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  )
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  );

ALTER POLICY assets_tax_pool_runs_client ON public.assets_tax_pool_runs
  USING (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  )
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  );

ALTER POLICY admin_read ON public.audit_logs
  USING (
    (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text)
  );

ALTER POLICY client_own ON public.budgets
  USING (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))
  )
  WITH CHECK (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))
  );

ALTER POLICY client_own ON public.demand_forecast_daily
  USING (
    ((client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text))
  )
  WITH CHECK (
    ((client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text))
  );

ALTER POLICY client_own ON public.demand_forecast_run_log
  USING (
    ((client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text))
  )
  WITH CHECK (
    ((client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text))
  );

ALTER POLICY ims_gate_passes_client ON public.ims_gate_passes
  USING (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  )
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  );

ALTER POLICY client_own ON public.payable_payments
  USING (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))
  )
  WITH CHECK (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))
  );

ALTER POLICY client_own ON public.pos_credit_notes
  USING (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))
  )
  WITH CHECK (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))
  );

ALTER POLICY pos_customers_client ON public.pos_customers
  USING (
    ((client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text))
  );

ALTER POLICY pos_guest_order_requests_select ON public.pos_guest_order_requests
  USING (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  );

ALTER POLICY pos_guest_order_requests_update ON public.pos_guest_order_requests
  USING (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  );

ALTER POLICY client_own ON public.pos_kot_log
  USING (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))
  )
  WITH CHECK (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))
  );

ALTER POLICY pos_order_items_client ON public.pos_order_items
  USING (
    ((client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text))
  );

ALTER POLICY client_own ON public.pos_order_payments
  USING (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))
  )
  WITH CHECK (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))
  );

ALTER POLICY pos_orders_client ON public.pos_orders
  USING (
    ((client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text))
  );

ALTER POLICY pos_parking_slips_client ON public.pos_parking_slips
  USING (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  )
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  );

ALTER POLICY pos_payment_confirmations_select ON public.pos_payment_confirmations
  USING (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  );

ALTER POLICY pos_payment_confirmations_update ON public.pos_payment_confirmations
  USING (
    (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  );

ALTER POLICY pos_shifts_client ON public.pos_shifts
  USING (
    ((client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text))
  );

ALTER POLICY client_own ON public.pos_tables
  USING (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))
  )
  WITH CHECK (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))
  );

ALTER POLICY profiles_select ON public.profiles
  USING (
    ((id = (select auth.uid())) OR public.is_admin())
  );

ALTER POLICY profiles_update ON public.profiles
  USING (
    ((id = (select auth.uid())) OR public.is_admin())
  )
  WITH CHECK (
    ((id = (select auth.uid())) OR public.is_admin())
  );

ALTER POLICY client_access_purchase_order_items ON public.purchase_order_items
  USING (
    ((po_id IN ( SELECT purchase_orders.id FROM public.purchase_orders WHERE (purchase_orders.client_id IN ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))) OR (EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = (select auth.uid())) AND (profiles.role = 'admin'::text)))))
  )
  WITH CHECK (
    ((po_id IN ( SELECT purchase_orders.id FROM public.purchase_orders WHERE (purchase_orders.client_id IN ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))) OR (EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = (select auth.uid())) AND (profiles.role = 'admin'::text)))))
  );

ALTER POLICY client_access_purchase_orders ON public.purchase_orders
  USING (
    ((client_id IN ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))) OR (EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = (select auth.uid())) AND (profiles.role = 'admin'::text)))))
  )
  WITH CHECK (
    ((client_id IN ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))) OR (EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = (select auth.uid())) AND (profiles.role = 'admin'::text)))))
  );

ALTER POLICY own_subscription ON public.push_subscriptions
  USING (
    profile_id = (select auth.uid())
  )
  WITH CHECK (
    profile_id = (select auth.uid())
  );

ALTER POLICY client_own ON public.recipe_suggestions
  USING (
    ((client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text))
  );

ALTER POLICY client_own ON public.requisition_lines
  USING (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (requisition_id IN ( SELECT requisitions.id FROM public.requisitions WHERE (requisitions.client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))))
  )
  WITH CHECK (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (requisition_id IN ( SELECT requisitions.id FROM public.requisitions WHERE (requisitions.client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))))
  );

ALTER POLICY client_own ON public.requisitions
  USING (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))
  )
  WITH CHECK (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))
  );

ALTER POLICY client_own ON public.staff_meals
  USING (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (period_id IN ( SELECT monthly_periods.id FROM public.monthly_periods WHERE (monthly_periods.client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))))
  )
  WITH CHECK (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (period_id IN ( SELECT monthly_periods.id FROM public.monthly_periods WHERE (monthly_periods.client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))))
  );

ALTER POLICY stock_movements_all ON public.stock_movements
  USING (
    ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id FROM public.profiles WHERE (profiles.id = (select auth.uid())))))
  );

COMMIT;
