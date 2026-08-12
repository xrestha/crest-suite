-- Supabase performance advisor: `unindexed_foreign_keys` (0001) — 79 findings, INFO level.
--
-- This indexes 36 of them, not all 79. The selection is evidence-based, not a sweep: each column
-- below is either a verified `.eq()`/`.in()` filter in src/, or the parent link of a child-detail
-- table PostgREST reads via an embedded select. Counts were taken by grepping src/ for
-- `.eq('<col>'`/`.in('<col>'` and for embedded-resource syntax.
--
-- Why not all 79. `20260727140000_index_unindexed_fk_filter_columns.sql` took the previous pass at
-- this lint (client_id / period_id / item_id / recipe_id, 46 indexes). Three indexes THAT
-- migration created — idx_pos_order_items_client_id, idx_hr_incentive_configs_client_id,
-- idx_hr_shift_swap_requests_client_id — now show up under the `unused_index` lint. An index is
-- not free: it is written on every INSERT/UPDATE to the table, and pos_order_items and
-- stock_movements take a write per line per bill. Indexing a column nothing filters on buys
-- nothing and costs that. pos_order_items is the sharpest example — the previous pass indexed
-- client_id there, but the dominant access pattern is `.eq('order_id', …)` (32 sites across src/,
-- plus 3 embedded selects), which is exactly the column that had no index.
--
-- Deliberately SKIPPED, and why:
--   * The ~20 audit-trail FKs — created_by, posted_by, issued_by, closed_by, sent_by,
--     submitted_by, approved_by, decided_by, recorded_by, opened_by, exited_by,
--     status_updated_by, published_by, admin_decided_by, generated_by — plus supervisor_id and
--     custodian_user_id. A grep for `.eq('<anything>_by'` across src/ returns **zero** hits: these
--     are display lookups resolved through get_client_profile_names(), never query filters. Their
--     only remaining value is FK enforcement when a profiles row is deleted (Danger Zone
--     delete_client, staff deletion) — a rare admin operation with nobody waiting on it, so the
--     per-write cost on pos_orders/pos_kot_log is not worth paying. Revisit if a client delete
--     ever times out.
--   * category_id (items, budgets), leave_type_id, shift_type_id, config_id, linked_item_id,
--     suggest_recipe_id, credit_note_id, advance_id — zero filter sites each. Small lookup
--     tables joined for display, or (hr_advance_repayments) read whole-table scoped by client_id
--     and grouped in JS.
--
-- APPLY NOTE: plain CREATE INDEX, not CONCURRENTLY, so this pastes into the Supabase SQL Editor
-- as one block — matching this project's normal apply workflow and the 20260727140000 precedent.
-- Each statement briefly locks its table against writes while it builds (reads unaffected).
-- Seconds per table at current data sizes, but still best run outside service hours: several of
-- these tables (pos_order_items, pos_kot_log, stock_movements) are on the live billing path.

BEGIN;

-- ── POS: children read per open/print/settle of one bill ────────────────────────────────────
-- order_id is the single highest-traffic unindexed FK in the schema: 32 filter sites + 3
-- embedded selects. Every bill open, KOT send, receipt reprint and credit note goes through it.
CREATE INDEX IF NOT EXISTS idx_pos_order_items_order_id    ON public.pos_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_pos_order_payments_order_id ON public.pos_order_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_pos_kot_log_order_id        ON public.pos_kot_log(order_id);
CREATE INDEX IF NOT EXISTS idx_pos_parking_slips_order_id  ON public.pos_parking_slips(order_id);
CREATE INDEX IF NOT EXISTS idx_pos_payment_confirmations_matched_order_id
  ON public.pos_payment_confirmations(matched_order_id);
CREATE INDEX IF NOT EXISTS idx_pos_orders_shift_id         ON public.pos_orders(shift_id);

-- ── Parent-detail children (read only ever via their parent) ────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_po_id      ON public.purchase_order_items(po_id);
CREATE INDEX IF NOT EXISTS idx_requisition_lines_requisition_id ON public.requisition_lines(requisition_id);
CREATE INDEX IF NOT EXISTS idx_hr_tada_claim_items_claim_id     ON public.hr_tada_claim_items(claim_id);

-- ── Purchases / vendors ─────────────────────────────────────────────────────────────────────
-- payable_payments.purchase_entry_id and vendor_returns.purchase_entry_id back the per-bill
-- allocation and return walks (OutstandingPayables' allocatePayment, walkBillReturns). The two
-- vendor_id columns back Vendor Report, Supplier Price Tracker and Vendor Balance Confirmation,
-- all of which read unbounded-by-period and so grow with system age.
CREATE INDEX IF NOT EXISTS idx_payable_payments_purchase_entry_id ON public.payable_payments(purchase_entry_id);
CREATE INDEX IF NOT EXISTS idx_vendor_returns_purchase_entry_id   ON public.vendor_returns(purchase_entry_id);
CREATE INDEX IF NOT EXISTS idx_purchase_entries_vendor_id         ON public.purchase_entries(vendor_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_vendor_id          ON public.purchase_orders(vendor_id);

-- ── Stock / recipe item lookups ─────────────────────────────────────────────────────────────
-- recipe_ingredients.sub_recipe_id is walked recursively by explode() in recipeCost.js, so it is
-- hit once per nesting level per recipe rather than once per query.
CREATE INDEX IF NOT EXISTS idx_opening_stock_item_id         ON public.opening_stock(item_id);
CREATE INDEX IF NOT EXISTS idx_closing_stock_item_id         ON public.closing_stock(item_id);
CREATE INDEX IF NOT EXISTS idx_par_levels_item_id            ON public.par_levels(item_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_item_id       ON public.stock_movements(item_id);
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_item_id    ON public.recipe_ingredients(item_id);
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_sub_recipe_id ON public.recipe_ingredients(sub_recipe_id);

-- ── HR: period-scoped ───────────────────────────────────────────────────────────────────────
-- hr_attendance is one row per employee per day, so it crosses 1000 rows at ~34 staff (the
-- threshold noted in CLAUDE.md's fetchAllRows section) and is re-read on every payroll run.
CREATE INDEX IF NOT EXISTS idx_hr_attendance_period_id   ON public.hr_attendance(period_id);
CREATE INDEX IF NOT EXISTS idx_hr_payroll_runs_period_id ON public.hr_payroll_runs(period_id);
CREATE INDEX IF NOT EXISTS idx_monthly_owner_reports_period_id ON public.monthly_owner_reports(period_id);

-- ── HR: employee-scoped ─────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_hr_payslips_employee_id            ON public.hr_payslips(employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_salary_components_employee_id   ON public.hr_salary_components(employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_roster_employee_id              ON public.hr_roster(employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_leave_requests_employee_id      ON public.hr_leave_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_advances_employee_id            ON public.hr_advances(employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_tada_claims_employee_id         ON public.hr_tada_claims(employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_festival_allowances_employee_id ON public.hr_festival_allowances(employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_incentives_employee_id          ON public.hr_incentives(employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_shift_swap_requests_requester_employee_id
  ON public.hr_shift_swap_requests(requester_employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_shift_swap_requests_target_employee_id
  ON public.hr_shift_swap_requests(target_employee_id);

-- PayrollRun.jsx deletes repayments by run before rewriting them: .eq('payroll_run_id', run.id).
CREATE INDEX IF NOT EXISTS idx_hr_advance_repayments_payroll_run_id
  ON public.hr_advance_repayments(payroll_run_id);

-- ── Fixed Asset Register ────────────────────────────────────────────────────────────────────
-- assets_categories.client_id is an RLS filter on every read of the table and was simply missed:
-- the 20260727140000 client_id sweep predates the assets tables (added 20260803110000).
-- The other two are verified filters (run_id: 7 sites, asset_id: 1). These three will read as
-- `unused_index` until the feature carries real data — that is expected, not a reason to skip.
CREATE INDEX IF NOT EXISTS idx_assets_categories_client_id ON public.assets_categories(client_id);
CREATE INDEX IF NOT EXISTS idx_assets_depreciation_schedule_run_id
  ON public.assets_depreciation_schedule(run_id);
CREATE INDEX IF NOT EXISTS idx_assets_repair_expenses_asset_id
  ON public.assets_repair_expenses(asset_id);

COMMIT;

-- ── On the 9 `unused_index` findings (0005): drop none of them, for now ─────────────────────
-- "Unused" means never chosen by the planner since the last stats reset, which is not the same
-- as useless. Each of the 9 falls into one of three groups:
--   * New feature, no data yet — ims_gate_passes_open_idx, pos_parking_slips_open_idx,
--     assets_register_client_status_idx, assets_tax_pool_lines_run_idx. Correct indexes waiting
--     on traffic.
--   * Table too small for the planner to prefer an index scan — idx_hr_incentive_configs_client_id,
--     idx_hr_shift_swap_requests_client_id, idx_trial_signup_attempts_ip. The last one guards the
--     per-IP signup rate limiter and matters precisely when the table stops being small; dropping
--     it would remove the protection at the moment it starts to count.
--   * idx_pos_order_items_client_id — the right table, the wrong column. Superseded in practice
--     by idx_pos_order_items_order_id above rather than dropped, since cross-order reporting
--     still filters by client_id.
-- The one genuinely questionable index is idx_pos_customers_phone_canonical: a grep of src/ and
-- supabase/functions/ finds no reader at all — phone_canonical is referenced only by a comment in
-- src/utils/phone.js. It backs a digital-receipt lookup that was never wired up. Leave it until
-- someone decides whether that feature is happening; it costs one index write per customer row.
