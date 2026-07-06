# Crest POS — Consolidated To-Do List

Living checklist compiled from: the competitor "IMS" ERP report-menu audit, the IRD POS compliance research (VAT Rules 2053 / Electronic Billing Procedure 2074), and a Nepal-POS-market feature scan (NRestro, Restronp, RestroX, Petpooja). Updated as features ship — completed items are struck through, not deleted, so this stays a full history of what was considered.

**Status key:** 🔴 Missing · 🟡 Partial · 🔵 Deferred (decided to postpone) · ⚪ Open question (not engineering)

Last updated: 2026-07-06 (S285)

---

## A. Core feature gaps (Nepal-market research, 2026-07-04)

- [ ] 🔴 Guest-facing QR digital menu (self-browse/self-order via table QR — Crest's only QR use today is payment)
- [ ] 🔴 Multi-branch/multi-outlet management (Crest is single-location per client)
- [ ] 🔴 Delivery aggregator integration (Foodmandu/Pathao-style — confirmed real gap via a competitor's "Direct Party" customer category)
- [ ] 🟡 Loyalty/rewards program (Customers page tracks contact + credit ledger, no points/rewards mechanic)
- [ ] 🔴 Kitchen Display System — on-screen KDS, not just printed KOT/BOT tickets

## B. Reports — compliance-adjacent

- [x] ~~Purchase-side One Lakh Above / Annexure 13 (vendor-wise)~~ — shipped S235, 2026-07-04. `src/pages/PurchaseOneLakhAboveReport.js`, `/purchase-one-lakh-report`. Reuses `buildVendorSummary` (now exported from `VatReport.js`) across a full BS fiscal year's `periodIds`, same missing-PAN/Annexure-13 badge convention as the POS-side report. Gated on the existing `vat_report` feature flag — no new flag/migration.
- [ ] 🟡 `sales_entries`/`purchase_entries` hard-delete on edit (accepted risk — only matters near the NRs 5 crore certification tier; `pos_orders` itself never hard-deletes once billed, verified)
- [ ] ⚪ Tier-1 software-certification legal question (needs an accountant's answer, not code)

## C. Reports — analytics / competitor parity (confirmed non-mandatory, pure business intelligence)

- [x] ~~Category Wise Sales Report~~ — shipped S235, consolidated into `/pos/sales-report` (Category Wise tab). New `computeCategoryAmounts()` helper in `posBillingMath.js` (per-category discount allocation, reconciles to order totals). "Return" = whole-bill Credit Notes (no partial/line-level return exists).
- [x] ~~Customer Wise Sales Report~~ — shipped S235, consolidated into `/pos/sales-report` (Customer Wise tab).
- [x] ~~Hourly Sales Report~~ — shipped S235, consolidated into `/pos/sales-report` (Hourly tab). Buckets `pos_orders.closed_at` by local hour-of-day, Recharts bar chart + table.
- [x] ~~Daily Sales Report~~ — shipped S235 (added mid-consolidation, not originally on this list). `/pos/sales-report` (Daily tab). Groups by BS calendar day; excludes Credit-Noted bills entirely (the revenue correction posts on the day the note is issued, not retroactively).
- [x] ~~Item Wise Sales Report~~ — shipped S236, 2026-07-04. 6th tab in `/pos/sales-report`. New `computeItemAmounts()` helper in `posBillingMath.js`, same Sales/Return-on-credit-note pattern as Category Wise.
- [x] ~~KOT Register Report~~ — shipped S236, 2026-07-04. `/pos/kot-log` (Register tab). Required a new `pos_kot_log` table — no historical send log existed before this (`sent_to_kot` was a live boolean, overwritten in place, no timestamp/sender).
- [x] ~~KOT vs Prebill vs Sales reconciliation~~ — shipped S236, 2026-07-04. `/pos/kot-log` (Reconciliation tab). Flags items whose total sent-to-kitchen qty exceeds their current order qty, and any KOT/BOT send on an order that ends up Voided. Only shows flagged rows.
- [x] ~~Bill Register / Voucher Wise Sales Report~~ — shipped S237, 2026-07-04 (added after comparing against a competitor's "Sales Book Report" screenshot, not originally on this list). 7th tab in `/pos/sales-report`. One row per bill — Voucher#, Invoice#, Customer, Payment Mode, Order Mode, amounts, Remarks, Entered By. No migration needed — every column already existed on `pos_orders`.
- [ ] 🔴 Stock Ageing Report (FIFO/Expiry shows dates, not aging buckets)
- [ ] ⚪ "Supplier Wise" / "Product Type Wise" sales reports (unclear fit vs Crest's data model — needs clarification before scoping)
- [ ] 🟡 Item Wise tab: add Product Code + UoM columns (found via competitor screenshot comparison, 2026-07-04 — `recipes.recipe_code`/`yield_uom` already exist, just not pulled into the report query; no migration needed)
- [x] ~~Printed letterhead baked into Excel exports~~ — shipped S238, 2026-07-04. All 7 `/pos/sales-report` tabs now export Company Name/VAT No./Address + `@As On Dated : ... To : ...` date-range line (or `@Fiscal Year :` for 1L+ Report) above the data, matching the statutory-report look of competitor exports.
- [x] ~~KOT Log: Bill Trail tab~~ — shipped S239, 2026-07-04 (not originally on this list — requested after seeing Reconciliation only surfaces exceptions). 3rd tab in `/pos/kot-log`: every paid/voided bill, expandable to its full KOT/BOT send history, with an amber "No KOT" badge for bills that never sent anything to the kitchen. No migration needed.
- [x] ~~Payment Summary Report~~ — shipped S245, 2026-07-05 (not originally on this list). One of 8 tabs in `/pos/sales-report`: payment-method breakdown (Cash/Card/eSewa/Khalti/FonePay/Credit) over a BS date range.

## D. Known roadmap items

- [x] ~~Item-level Complimentary/comp~~ — shipped S274, 2026-07-06. Pay tab gets an Items list (Supervisor+), +/− qty steppers down to partial quantity (S284, e.g. 1 of 3), excluded from the bill and printed on its own mini Complimentary Slip sharing the whole-order Comp's NC-series (`get_next_pos_comp_slip_no` RPC). Recent Bills can reprint that slip separately (S275); Sales Exceptions/Sales Report both cross-reference bill↔comp (S279/S280); everything-comped bills are blocked from issuing a ₨0 Tax Invoice (S285, use Complimentary tab instead).
- [ ] 🟡 QR payment auto-confirmation — receiver scaffold + admin UI shipped S271/S272, 2026-07-06 (`pos_payment_webhook` Edge Function, `settings.pos_webhook_secret` config in Manage Clients → QR tab). Still needs real FonePay/eSewa merchant onboarding + their actual signature scheme before anything goes live — low priority, blocked on merchant credentials, not engineering.
- [ ] 🔵 Payment QR rail coverage (eSewa rejecting NepalPay/NCHL QR — deferred, test Plan A later)
- [x] ~~Offline mode (IndexedDB queue for POS itself, not just Stock Count)~~ — shipped S245, 2026-07-05. Order Taking (add items, edit covers, send KOT/BOT) now uses the same offline-queue pattern as IMS Stock Count. Billing/Charge deliberately stays online-only (sequential invoice numbering can't be assigned offline).
- [ ] 🔴 Barcode support (structural, no current need identified)

## Not on this list (deliberately out of scope)

Full double-entry accounting / Chart of Accounts / Debtors-Creditors, multi-warehouse, batch/lot tracking, Production Entry transactions — confirmed general-ERP scope creep, not aligned with Crest's F&B cost-intelligence positioning.

---

## Shipped (for reference — moved here once complete)

- [x] ~~Item-level Complimentary/comp~~ — shipped S274, 2026-07-06, extended S284/S285 same day. `PosOrders.jsx` Pay tab gets a collapsed-by-default Items list (Supervisor+, folded per user feedback so a comp control isn't a standing suggestion on every bill) with +/− qty steppers per line — supports partial quantity (1 of 3), splitting that line's DB row into a paid remainder + a new comped row at Charge time. Comped items are excluded from the Tax Invoice/Bill and instead print on a mini Complimentary Slip sharing the whole-order Complimentary Slip's NC-series (new `get_next_pos_comp_slip_no` RPC, race-safe shared advisory lock with `assign_pos_invoice_no`'s writeoff branch). `writeSalesEntries()` splits `stock_movements` proportionally by qty between `pos_sale`/`pos_comp`. A bill where every item ends up comped (₨0 payable) is blocked from issuing an empty Tax Invoice — points to the Complimentary tab instead. Fallout fixed same day: `SalesReport.jsx`/`demandForecastData.js`/Credit Notes were all summing `pos_order_items` without excluding `comped=true`, overstating revenue; `PosExceptionReport.jsx` couldn't see item-level comps at all until a second query was added, grouped by (order_id, comp_no). New "Comped Bills" tab on `/pos/sales-report` cross-references bills↔comps both directions (badge on Bill Register + "on Bill TI..." on the Exceptions comp row).
- [x] ~~QR payment auto-confirmation — receiver scaffold~~ — shipped S271, 2026-07-06. `pos_payment_confirmations` staging table + `settings.pos_webhook_secret`, Edge Function `pos-payment-webhook` (placeholder HMAC verify pending real merchant docs, idempotent on txn_ref, matches an order via a `CR<order_no>` reference embedded in the QR by `emvQr.js`). Deliberately doesn't close the order itself (would mean re-implementing BS-fiscal-year/invoice-numbering in Deno) — `PosOrders.jsx` polls for a match while the Charge modal shows a QR and finishes the close through the existing tested `closeOrder('paid')`. Admin UI to set the secret shipped same day (S272, Manage Clients → client → QR tab → "Payment Webhook (advanced)").
- [x] ~~Click-to-drill-down bill preview~~ — shipped S279, 2026-07-06. `src/utils/viewPosBill.js` reuses the real `buildBillHtml`/`buildCompSlipHtml` print builders to open a read-only, full-fidelity bill/slip preview in a new tab (never calls `window.print()`) — wired into every row of `/pos/exceptions` and the Bill Register tab of `/pos/sales-report`.
- [x] ~~Offline mode (Order Taking)~~ — shipped S245, 2026-07-05. Extends the IMS Stock Count offline-queue pattern (`src/utils/offlineQueue.js`) to `PosOrders.jsx`: add items, edit covers, send KOT/BOT all work through a wifi drop mid-service. Billing/Charge stays online-only — sequential invoice numbering can't be assigned while offline.
- [x] ~~Payment Summary Report~~ — shipped S245, 2026-07-05. One of 8 tabs in `SalesReport.jsx`, `/pos/sales-report`. Payment-method breakdown (Cash/Card/eSewa/Khalti/FonePay/Credit) over a BS date range.
- [x] ~~KOT Log: Bill Trail tab~~ — shipped S239, 2026-07-04. `/pos/kot-log` 3rd tab. One row per paid/voided bill, expandable (accordion pattern from `PosShifts.jsx`) into its full KOT/BOT trail. Amber "No KOT" badge for zero-send bills, red "Discrepancy" badge shares logic with Reconciliation via extracted `sumSentQtyByOrderItem`/`flagOrderDiscrepancies` helpers.
- [x] ~~Printed letterhead baked into Excel exports~~ — shipped S238, 2026-07-04. New `withLetterhead()` helper in `SalesReport.jsx` (uses `XLSX.utils.aoa_to_sheet` + `sheet_add_json` with `origin: -1` to prepend rows ahead of the existing per-tab data). Fetches `clients.name` + `settings.vat_number`/`property_address` once per client, independent of the date-range fetch.
- [x] ~~Bill Register / Voucher Wise Sales Report~~ — shipped S237, 2026-07-04. 7th tab in `SalesReport.jsx`, `/pos/sales-report`. One row per bill (Voucher#, Invoice#, Customer, Payment Mode, Order Mode, amounts, Remarks, Entered By), with a "Credit Noted" badge for bills later corrected instead of excluding them (unlike Daily). No migration needed — reused existing `pos_orders` columns.
- [x] ~~Item Wise Sales Report + KOT Log (Register + Reconciliation)~~ — shipped S236, 2026-07-04. New `pos_kot_log` table (append-only send-event log with delta-aware item/qty snapshots) backing `/pos/kot-log`; Item Wise added as `SalesReport.jsx`'s 6th tab.
- [x] ~~Sales Report — Daily / Hourly / Category Wise / Customer Wise / 1L+ (Annexure 13), one tabbed page~~ — shipped S235, 2026-07-04. `src/modules/pos/reports/SalesReport.jsx`, `/pos/sales-report`. Originally built as 4 separate pages same session, then consolidated into one shared-fetch tabbed page after Aashish pointed out it should mirror the competitor's single "Sales Report" menu structure. Daily/Hourly/Category/Customer share one BS date-range fetch (`useMemo`'d per-tab aggregation); 1L+ Report keeps its own Fiscal Year selector since Annexure 13 is a whole-year compliance check, not an arbitrary range.
- [x] ~~Purchase-side One Lakh Above / Annexure 13~~ — shipped S235, 2026-07-04. `src/pages/PurchaseOneLakhAboveReport.js`, `/purchase-one-lakh-report`. Reuses `buildVendorSummary` (now exported from `VatReport.js`).
- [x] ~~Credit Note workflow (VAT Rules 2053, Rule 20)~~ — shipped S234, 2026-07-03
- [x] ~~IMS stock deduction trigger~~ — shipped, verified 2026-07-03
- [x] ~~Discount controls (₨/% toggle, mandatory reason)~~ — shipped S219
- [x] ~~Credit payment method~~ — shipped S220
- [x] ~~Customers table + Credit collection~~ — shipped S221
- [x] ~~Sales Exception Report~~ — shipped S222
- [x] ~~Shift management (X/Z report)~~ — shipped S224
