-- S710 (1 of 2) — 25 policies that never learned about multi-outlet.
--
-- S548 shipped multi-outlet on one idea: `profiles.active_client_id` was added and ONLY
-- `my_client_id()` changed, to `coalesce(active_client_id, client_id)`. Every policy keeps its
-- exact shape and resolves to the SELECTED outlet, and the frontend gets it free because
-- `AuthContext` binds `clientId` to `active_client_id || client_id`.
--
-- That works for every policy that calls `my_client_id()`. Twenty-five live policies do not. They
-- inline the function's OLD body instead:
--
--     client_id = (SELECT profiles.client_id FROM public.profiles WHERE profiles.id = auth.uid())
--
-- which is `my_client_id()` frozen at its pre-S548 definition. Sixteen come from the baseline (and
-- were carried forward verbatim by the initplan-wrap pass in 20260812130000, which was rewriting
-- the `auth.uid()` calls inside them and had no reason to look at the rest of the expression). The
-- other nine were written AFTER multi-outlet shipped — pos_cash_movements, pos_kot_removals, the
-- loyalty pair and the reservations pair — each copied from the table next to it, which is how a
-- shape outlives the reason for it.
--
-- WHAT IT DOES. For a client with no `active_client_id` the two expressions are byte-identical, so
-- nothing about the book today changes. The moment an Owner switches outlets they diverge:
-- `scopedDb` filters every query on outlet B while these policies still resolve outlet A. Reads
-- come back `{ data: [], error: null }` — an empty Requisitions list, an empty POS floor, a
-- purchase-order book with nothing in it, none of them distinguishable from a genuinely empty
-- outlet. Writes fail the WITH CHECK and raise 42501 on a row the user can see themselves typing.
--
-- This is the same shape as the three defects that sat in multi-outlet from S548 until S617: a
-- feature with no users accumulates faults every review passes over, because nothing exercises
-- them. No client has a `group_id` yet, so none of this is reachable today. It becomes reachable
-- on the day the first group is created, which is the wrong day to find out.
--
-- The substitution below is textual and semantics-preserving: each policy's expression is its
-- current one with that subquery replaced by `(select public.my_client_id())`. Nothing else moves
-- — not the admin clause, not the permissive/restrictive split, not the command set. Policies
-- that carry only USING keep only USING (ALTER POLICY leaves an unmentioned WITH CHECK alone).
--
-- HOW TO CHECK IT AFTERWARDS — this must come back zero:
--
--   SELECT schemaname, tablename, policyname
--     FROM pg_policies
--    WHERE schemaname = 'public'
--      AND (qual LIKE '%profiles.client_id%' OR with_check LIKE '%profiles.client_id%');
--
-- And the rule that follows from it: a new client-scoped policy calls `my_client_id()`. Never
-- spell its body out, however convenient the table next door makes it look.

BEGIN;

ALTER POLICY client_own ON public.budgets
  USING ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = (select public.my_client_id()))) )
  WITH CHECK ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = (select public.my_client_id()))) );

ALTER POLICY client_own ON public.demand_forecast_daily
  USING ( ((client_id = (select public.my_client_id())) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text)) )
  WITH CHECK ( ((client_id = (select public.my_client_id())) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text)) );

ALTER POLICY client_own ON public.demand_forecast_run_log
  USING ( ((client_id = (select public.my_client_id())) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text)) )
  WITH CHECK ( ((client_id = (select public.my_client_id())) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text)) );

ALTER POLICY client_own ON public.payable_payments
  USING ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = (select public.my_client_id()))) )
  WITH CHECK ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = (select public.my_client_id()))) );

ALTER POLICY pos_cash_movements_client ON public.pos_cash_movements
  USING ( client_id = (select public.my_client_id()) OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin' )
  WITH CHECK ( client_id = (select public.my_client_id()) OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin' );

ALTER POLICY client_own ON public.pos_credit_notes
  USING ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = (select public.my_client_id()))) )
  WITH CHECK ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = (select public.my_client_id()))) );

ALTER POLICY pos_customers_client ON public.pos_customers
  USING ( ((client_id = (select public.my_client_id())) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text)) );

ALTER POLICY client_own ON public.pos_kot_log
  USING ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = (select public.my_client_id()))) )
  WITH CHECK ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = (select public.my_client_id()))) );

ALTER POLICY pos_kot_removals_client ON public.pos_kot_removals
  USING ( client_id = (select public.my_client_id()) OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin' )
  WITH CHECK ( client_id = (select public.my_client_id()) OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin' );

ALTER POLICY pos_loyalty_ledger_select ON public.pos_loyalty_ledger
  USING ( client_id = (select public.my_client_id()) OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin' );

ALTER POLICY pos_loyalty_schemes_client ON public.pos_loyalty_schemes
  USING ( client_id = (select public.my_client_id()) OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin' )
  WITH CHECK ( client_id = (select public.my_client_id()) OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin' );

ALTER POLICY pos_order_items_client ON public.pos_order_items
  USING ( ((client_id = (select public.my_client_id())) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text)) );

ALTER POLICY client_own ON public.pos_order_payments
  USING ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = (select public.my_client_id()))) )
  WITH CHECK ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = (select public.my_client_id()))) );

ALTER POLICY pos_orders_client ON public.pos_orders
  USING ( ((client_id = (select public.my_client_id())) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text)) );

ALTER POLICY pos_reservation_tables_client ON public.pos_reservation_tables
  USING ( client_id = (select public.my_client_id()) OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin' )
  WITH CHECK ( client_id = (select public.my_client_id()) OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin' );

ALTER POLICY pos_reservations_client ON public.pos_reservations
  USING ( client_id = (select public.my_client_id()) OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin' )
  WITH CHECK ( client_id = (select public.my_client_id()) OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin' );

ALTER POLICY pos_shifts_client ON public.pos_shifts
  USING ( ((client_id = (select public.my_client_id())) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text)) );

ALTER POLICY client_own ON public.pos_tables
  USING ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = (select public.my_client_id()))) )
  WITH CHECK ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = (select public.my_client_id()))) );

ALTER POLICY client_access_purchase_order_items ON public.purchase_order_items
  USING ( ((po_id IN ( SELECT purchase_orders.id FROM public.purchase_orders WHERE (purchase_orders.client_id IN (select public.my_client_id())))) OR (EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = (select auth.uid())) AND (profiles.role = 'admin'::text))))) )
  WITH CHECK ( ((po_id IN ( SELECT purchase_orders.id FROM public.purchase_orders WHERE (purchase_orders.client_id IN (select public.my_client_id())))) OR (EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = (select auth.uid())) AND (profiles.role = 'admin'::text))))) );

ALTER POLICY client_access_purchase_orders ON public.purchase_orders
  USING ( ((client_id IN (select public.my_client_id())) OR (EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = (select auth.uid())) AND (profiles.role = 'admin'::text))))) )
  WITH CHECK ( ((client_id IN (select public.my_client_id())) OR (EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = (select auth.uid())) AND (profiles.role = 'admin'::text))))) );

ALTER POLICY client_own ON public.recipe_suggestions
  USING ( ((client_id = (select public.my_client_id())) OR (( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text)) );

ALTER POLICY client_own ON public.requisition_lines
  USING ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (requisition_id IN ( SELECT requisitions.id FROM public.requisitions WHERE (requisitions.client_id = (select public.my_client_id()))))) )
  WITH CHECK ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (requisition_id IN ( SELECT requisitions.id FROM public.requisitions WHERE (requisitions.client_id = (select public.my_client_id()))))) );

ALTER POLICY client_own ON public.requisitions
  USING ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = (select public.my_client_id()))) )
  WITH CHECK ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = (select public.my_client_id()))) );

ALTER POLICY client_own ON public.staff_meals
  USING ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (period_id IN ( SELECT monthly_periods.id FROM public.monthly_periods WHERE (monthly_periods.client_id = (select public.my_client_id()))))) )
  WITH CHECK ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (period_id IN ( SELECT monthly_periods.id FROM public.monthly_periods WHERE (monthly_periods.client_id = (select public.my_client_id()))))) );

ALTER POLICY stock_movements_all ON public.stock_movements
  USING ( ((( SELECT profiles.role FROM public.profiles WHERE (profiles.id = (select auth.uid()))) = 'admin'::text) OR (client_id = (select public.my_client_id()))) );

COMMIT;
