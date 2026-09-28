# DATABASE — RLS, grants, triggers, RPCs, FKs and tenancy on every IMS table (live catalog + migrations)

Files reviewed: live catalog for 43 IMS-touching tables (pg_policies 276 rows, pg_trigger 56,
pg_proc 216 functions with EXECUTE/search_path, role_table_grants, pg_constraint FKs, settings
columns/indexes, storage policies); live bodies of 31 IMS functions compared to their latest
migration (all identical); migrations 20260918100000/110000/140000, 20260919110000,
20260923130000, 20260924120000, 20260910120000; src/shared/scopedDb.js, restoreClientData.js
RESTORE_ORDER, admin-user-ops deleteClientDataFor, Layout.js nav ranks, Overheads/Vendors/Items/
Requisitions/Stock/PurchaseBillPage/BudgetVsActual/closePeriod write paths. Not run: any DML test.

## Findings

DATABASE-1 [P0] A counting login can switch off the database fences that bind it
- settings.ims_count_scope_enforced / require_count_attribution / ims_count_blind are in none of
  settings_guard_staff_roles' lists (live = 20260923130000:78-79). settings_update =
  is_admin() OR client_id = my_client_id(); only restrictive is no_self_service_update.
- Count PIN / IMS staff / POS PIN / HR login PATCHes them false → ims_count_scope_allows() passes
  (NOT ims_count_scope_on()) and closing_stock_guard_recount returns early (NOT ims_recount_guard_on()).
- Second path: items has no rank guard, so a scoped counter can UPDATE items.category_id into an
  assigned category, then write that item's count.
- Status: missed by S737 and S756. Fix: c_ims_count list gated on ims_can_manage_counts(); fence
  items.category_id. Confirmed.

DATABASE-2 [P1] sales_entries has no rank guard: a POS waiter or count PIN can rewrite open-month sales
- Policies: no_hr_role_staff, no_self_service_accounts, sales_entries_all only; trigger only
  ims_closed_period_guard. Twin stock_movements got ims_stock_movements_guard (pos_* INSERT = POS/IMS
  supervisor) in S756; sales_entries did not. Legit POS writers are bill close (POS supervisor+) and
  credit notes (manager). Missed by S756. Confirmed.

DATABASE-3 [P1] overheads: no closed-month lock and no rank guard
- pg_trigger: zero triggers on overheads. Page manager-only (Layout.js:67, Overheads.js:651) with
  isLocked (646). Readers: Overheads P&L, ClientDashboard:481, ConsolidatedPnl:219,
  computeMonthlyReport:75, Recipes.js:230. Missed by S756 (D1 table list). Confirmed.

DATABASE-4 [P2] Rank fences stop at S756's inventory (KNOWN+ for the count PIN)
- items (supervisor page; uom/is_active/category; D5 unit lock browser-only), vendors (D25 lifecycle
  Owner-only in UI Vendors.js:79, DB any IMS login; PAN drives the 1L report), categories (no UI delete;
  REST delete cascades budgets + ims_count_assignments), budgets, purchase_orders/purchase_order_items
  (status and qty_received writable directly — receive_purchase_order's double-receive protection is
  advisory), demand_forecast_daily, recipe_suggestions (also open to POS PIN).
- Count PIN specifically also reaches items.rate, sales_entries, overheads (known item named only
  opening_stock/wastages/staff_meals).

DATABASE-5 [P1, Plausible] Danger Zone aborts partway for any mature client (414 on unchunked .in())
- admin-user-ops/index.ts:159-162: purchase_entries ids read unpaged (≤1000) then
  payable_payments DELETE .in('purchase_entry_id', peIds) — up to ~37 KB URL. Project measured the
  414 at ~254 uuids (S706). Also recipe_ingredients .in(recipeIds) (147), requisition_lines
  .in(reqIds) (155). Throws after recipe_ingredients/suggestions/PO lines/requisition lines are gone;
  Archive leaves an active client with ingredient-less recipes; retry fails the same way.
- All four children CASCADE from their parents, so the explicit deletes are unnecessary.
- Confirm: dry run on a scratch copy of a client with >300 purchase lines.

DATABASE-6 [P2] No UNIQUE(client_id) on settings — any login can split the row
- Only settings_pkey + non-unique idx_settings_client_id. settings_insert permits client_id =
  my_client_id(); guard passes an all-default insert. Second row → every .maybeSingle() settings read
  errors (SettingsContext:131 falls back to DEFAULT_SETTINGS, saveSettings throws at 204). Confirmed.

DATABASE-7 [P2] payable_payments (supplier payments) has no audit trigger
- log_audit tables list (live) lacks payable_payments, while hr_salary_payments has one. A manager
  deleting a payment leaves no trace. Also unaudited: staff_meals (COGS), overheads, requisitions,
  budgets, par_levels.

DATABASE-8 [P3] Stray REFERENCES/TRIGGER/TRUNCATE for anon + authenticated on assets_* (7),
  ims_count_assignments, monthly_owner_reports (not reachable over PostgREST).

DATABASE-9 [P3] closing_stock.counted_by/_name client-supplied (Stock.js:583-584) — deliberate for
  offline enqueue; a staff counter can attribute to someone else or NULL (unclaimed for the recount
  guard). audit_logs.user_id keeps the truth.

DATABASE-10 [P3] closePeriod.js:93-94 hand-written .eq('client_id') on items (rule; fails safe).

DATABASE-11 [P3] Cross-tenant item_id on recipe_ingredients/purchase_entries/etc. is not checked
  (only pos_option_ingredients checks). Needs a foreign UUID; effect: victim's item delete refused.

## GAPs
- Month ended by an IMS supervisor → frozen Monthly Report cannot be written (no_ims_staff on
  monthly_owner_reports) and is generated at the Owner's first view, not at close.
- Supplier payments / deletions leave no Audit Log trace (DATABASE-7).
- The Settings tab promises "enforced by the database" for section scope and recount protection
  while the counter can switch them off (DATABASE-1).

## Owner questions
- Who may change an item's master price from a purchase bill (staff today)? Options: keep staff;
  supervisor+; staff proposes, supervisor approves. Recommend supervisor+.
- When a supervisor ends the month, when should the frozen report be made? At close by the server
  (recommend) / at Owner's first view (today) / Owner-only close.

## Checked and fine
(see handback)
