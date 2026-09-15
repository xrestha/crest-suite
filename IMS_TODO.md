# Crest IMS — Re-analysis To-Do (S756)

Whole-module review of Crest IMS, 2026-09-15, in the shape of the S754 POS re-analysis. Nine
read-only reviewers covered: items/vendors/gate passes/IMS staff/count PIN; purchases/returns/POs/
payables; stock count/periods/movements; sales/requisitions; recipes/menu; variance/summaries/budget;
reorder/dead stock/forecast/FIFO/ageing; VAT/1-lakh/vendor reports; overheads/fixed assets/IMS-wide
access. High-severity claims were spot-checked against source before any decision was asked.

**When an item here ships, strike it in the same commit and move it to the CHANGELOG entry.**

**Status key:** 🔴 Not started · 🟡 Partial · ✅ Done · 🔵 Deferred

---

## 1. Owner decisions (taken with Aashish, 2026-09-15)

| # | Decision | Chosen |
|---|---|---|
| D1 | Closed-month lock | **Database refuses writes to a closed period** on `opening_stock`, `closing_stock`, `wastages`, `staff_meals`, `sales_entries`, `purchase_entries`, `vendor_returns`, `requisitions`/`requisition_lines` (admin carve-out; paying a closed month's bill stays allowed; POS backfill path preserved). ~~Owner may reopen~~ → **changed the same day to Owner edits closed months in place** (reopening cannot work: only one period may be open and the next month is already open). Offline replay into a closed month is refused and surfaced, not landed. ✅ S756 |
| D2 | Who ends/reopens the month | Owner, IMS supervisor/manager, Crest operator — enforced in DB on `monthly_periods` INSERT/UPDATE, and the Dashboard button hidden for everyone else. Reopen/relabel: Owner or operator. ✅ S756 |
| D3 | Recipe ranks | **Hide/unhide a dish: IMS supervisor+. Delete a dish: manager+.** Enforced in DB (`guard_recipe_rank`; rank check on `recipe_ingredients` writes). ✅ S756 |
| D4 | Counting tablets | One **"Sign out all counting tablets"** button (rotates `ims_device_secret`); also rotated by archive/clear/delete client. ✅ S756 |
| D5 | Item unit/price edits with history | **Refuse a unit change** once the item has purchases or counts ("hide it and create a new item"). **Warn on a price change**, naming how many past records it re-values. |
| D6 | Uncounted items on summaries | Stock Count Summary, Monthly Summary, Annual Summary, Period Comparison: **amber warning naming the uncounted items, marked in table and export; FC% shown without a colour verdict** while the gap is material. Totals unchanged. |
| D7 | Open-month reports | Monthly Summary / Budget vs Actual keep opening on the current month, **marked provisional, no red/green verdict** until closed. Fall back to latest period when none is open. |
| D8 | Price on a corrected past sales day | **Every row keeps its stored `unit_price`**; only new rows take today's menu price. |
| D9 | Lump-sum supplier payment | **One amount per supplier, applied oldest bill first, split shown before saving.** Per-bill entry stays. |
| D10 | Late returns | A return may pick a bill from an earlier month and **sits in the month it happened** (VAT timing to be confirmed by an accountant — say so in Help). |
| D11 | Supplier credit | **"Settle using supplier credit"** on a payment against another bill of the same supplier. |
| D12 | Same PAN on two suppliers (1L report) | **Aggregate by PAN**, listing all names; warn on blank PANs. |
| D13 | Invoice VAT capture | **Two optional fields** on a purchase bill (invoice VAT, invoice total); flag mismatch > NPR 1. Migration. |
| D14 | Requisitions | **Record requested_by / issued_by / issued_at**; add **Rejected** status with reason. No two-person rule, no back-orders. |
| D15 | Dish VAT toggle | **Keep the guest price** on both Recipe Costing and Menu Pricing; show resulting ex-VAT. |
| D16 | Dish photos | **Upload button** storing photos in Crest (Supabase Storage). |
| D17 | Non-recipe items on Variance | Grey **"no recipe linked"** state, excluded from flagged count and loss total. |
| D18 | Reorder quantities | **Both units, rounded up to whole packs** — print, WhatsApp and Excel. |
| D19 | Stock Ageing / FIFO basis | **Anchor to the physical count** where one exists (oldest removed first), **state the basis**, **rolling 12-month** window. |
| D20 | Dead stock | **Dead after 2–3 consecutive months** with no movement (shorter = Slow); **suggested next step** per item. |
| D21 | Demand forecast | **Exclude past holidays** from weekday averages; ingredient list shows **forecast use / in store / to buy**. |
| D22 | Dashboard labour | Dashboard Fixed Costs % / Est. Net Margin **use finalized payroll**, like Overheads, naming the source. |
| D23 | Depreciation in profit | **Memo line** on Overheads P&L — shown, not subtracted. |
| D24 | Asset fixes | **Charge depreciation to the disposal date**; **Adjustment run** to reverse a wrong run + warn before posting an overlapping period. Personal-use apportionment **not** chosen (legal question). |
| D25 | Supplier tidy-up | **Owner can archive, restore and delete** suppliers (DB trigger still refuses deleting one with history). |
| D26 | Bill edit with a return against it | **Refused** until the return is removed (same shape as `purchase_bill_has_payments`). Migration. |
| D27 | Gate passes | Day boundary **6 AM Nepal time**; **void with reason** keeping the number. |
| D28 | Accountant extras | **Bill-wise sheet** in VAT export; **Sales import warns** when the file's date range ≠ selected day. |

Open question for an accountant, not engineering: IMS-only clients have no sales-side VAT view (net VAT payable) anywhere in Crest.

---

## 2. Clear-cut fixes (one right answer)

**Stage 1 (security + closed months) shipped in S756** — migration `20260918100000`, `admin-user-ops`, `ims-staff-login`. Assets were fenced to match the page (register/categories/repairs supervisor; disposal and posting manager), not all-manager. Known gaps it left: a staff login can add lines to an issued requisition over REST; Sales, Stock Count, Overheads and Requisitions show no amber "editing a closed month" banner to the Owner; Roster's labour-actuals reads still hit tables fenced from HR logins (`recipes`, `sales_entries`, `pos_orders`).

### 2a. Database (migrations)
- ✅ S756 — `monthly_periods` INSERT/UPDATE rank fence (D2) — any PIN account can reopen/close/relabel over REST.
- ✅ S756 — Closed-period triggers (D1).
- ✅ S756 — IMS rank: `purchase_entries`/`vendor_returns`/`payable_payments` (staff can delete bills and payments over REST; Delete All is supervisor+, payables manager).
- ✅ S756 — `requisitions`/`requisition_lines`: issued slip changes supervisor+ only.
- ✅ S756 — `stock_movements` DELETE admin/Owner/IMS manager; `par_levels` DELETE supervisor+.
- ✅ S756 — `recipes`/`recipe_ingredients` (D3).
- ✅ S756 — `assets_register`/`assets_depreciation_runs`/`assets_repair_expenses` + post RPCs: IMS manager. `settings` IMS threshold columns: manager.
- ✅ S756 — `demand_forecast_daily` readable by HR roles (Roster labour overlay silently empty for every HR login).
- 🔴 `save_purchase_bill` refuses superseding lines with returns (D26).
- ✅ S756 — `get_ims_count_staff`: drop settlement-blocked employees; RAISE on bad device secret.
- ✅ S756 — `ims_device_secret` rotate RPC (D4).
- 🔴 `purchase_entries` CHECK `discount_amount >= 0`.

### 2b. Edge Functions
- ✅ S756 — `admin-user-ops update_ims_role`: refuse any rank but `staff` for a count-PIN (`ims_email`) target; `revokeClientTablets` also rotates `ims_device_secret`.

### 2c. Frontend — security/access
- ✅ S756 — `AuthContext.js:225` profile select lacks `ims_email` → `imsCountOnly` always false; count PIN reaches everything staff can.
- ✅ S756 — `ImsStaff.jsx:594/245/167` hide rank select for PIN rows; exclude from job-title sync.
- ✅ S756 — `ClientDashboard.jsx:2574-2596` End Period button role check (D2).
- 🔴 `Overheads.js:210+` IMS-role login can't read payroll → says "no payroll run" and green Net Profit; say labour unreadable, withhold verdict.

### 2d. Frontend — wrong numbers / data loss
- 🔴 `Stock.js:709-727` Save All writes/deletes every visible row (parallel tablets wipe each other; restamps counted_by; recount guard refuses) → send changed cells only.
- ✅ S756 — `Stock.js:549-586` offline replay into closed period (with D1).
- 🔴 `Stock.js:810,242` bare selects (pull-from-last-month, items).
- 🔴 `computeMonthlyReport.js:58,77-84` six bare selects inside the frozen snapshot.
- 🔴 `Stock.js:944-951,1163` Summary purchases at master rate, no discounts; wrong "exactly" note.
- 🔴 `closePeriod.js:78-88` counted-vs-active mismatch.
- 🔴 `Purchases.js:383-399,703` Item filter values half a bill (negative totals).
- 🔴 `vendorBalanceHelpers.js:83-87` legacy-bill discount multiplied.
- 🔴 `PurchaseBillForm.jsx:358` discount unvalidated; `:292` Save live after save → duplicate bill.
- 🔴 `ReturnsTab.jsx:67` return dated before its bill; `OutstandingPayables.js:396` silent overpay cap.
- 🔴 `persistSalesDay.js:43-49` unpaged supersede check → silent month delete.
- 🔴 `Sales.js` save against stale day/period baseline (3 windows) → capture `{periodId, bsDay}` at click.
- 🔴 `Sales.js:348-373` unit_price restamp (D8).
- 🔴 `persistSalesDay.js:186-191` cross-mode supersede leaves stock_movements (double depletion); `:170` huge `.in()` / unpaged.
- 🔴 `SalesImportButton.jsx:6-9,40` `1,250.00`→1; `Disc %` picked as amount.
- 🔴 `Sales.js:635` From-POS revenue at today's price; `:225` unpaged day read; `:676` admin closed-month banner.
- ✅ S756 — `Recipes.js:1896` list-view errors render nowhere (Delete/Hide refusals invisible).
- 🔴 `Recipes.js:1469…`, `RecipeCostCardPrint.jsx` no-ingredient recipe shows `0.0% ✓` → `recipeCostOf`/`menuFcPct`.
- 🔴 `Recipes.js:703` update re-activates hidden dish.
- 🔴 `Recipes.js:899,906,907` dropped write errors (mirror link).
- 🔴 `.neq('source','pos_comp')` drops NULL rows: `Recipes.js:227`, `MonthlySummary.js:74`, `AnnualSummary.js:109`, `PeriodComparison.js:166`.
- 🔴 `MenuPricing.js:350,403` null category crash (ask branch before editing — POS-only branch).
- 🔴 `RecipeImportButton.jsx:29` Selling Price column is ex-VAT, unlabelled.
- 🔴 `Variance.js:51-53` total band NPR ÷ mixed quantities; `:210-248` flag vs band disagree.
- 🔴 `ShrinkageReport.js:211,217` uncounted = zero; no tolerance/materiality.
- 🔴 `PeriodComparison.js:153-166` includes inactive + sub-recipe mirror items.
- 🔴 `BudgetVsActual.js:52,142` budgets typed with no open period silently discarded.
- 🔴 Superseded load clears `loading`: `Variance.js`, `TheoreticalVariance.js`, `MonthlySummary.js`, `BudgetVsActual.js`; `init()` never `begin()`s on those four + `StockReport.js:39`.
- 🔴 `TheoreticalVariance.js:532` footer includes unmeasured rows.
- 🔴 `AnnualSummary.js:72` request key collides calendar/FY.
- 🔴 `BudgetVsActual.js:275` negative actual renders `—`.
- 🔴 `DeadStock.js:170` float equality; `:76` defaults to open month.
- 🔴 `FifoReport.js:40`/`StockAgeing.js:43` as-of = end of last month while it is still open (expired shows green).
- 🔴 `FifoReport.js:178`/`StockAgeing.js:195` returns against out-of-window bills lost; `StockAgeing.js:398` 90+ card ✓.
- 🔴 `DemandForecast.js:122` past days listed as "next 7"; `:159` dropped error; `:177` horizon switch mid-recompute.
- 🔴 `purchaseTaxSplit.js:42-43` unlinked returns vanish from VAT/Non-VAT (input VAT overstated) → partition + named banner.
- 🔴 `VatReport.js:297` on-screen per-line VAT pre-discount vs workbook post-discount.
- 🔴 `PurchaseOneLakhAboveReport.js` no letterhead/scope; `:46` infinite Loading with no periods; `:67` error before isCurrent.
- 🔴 `AssetCard.jsx:32` disposal gain/loss from dropped read; `FixedAssets.js:43` both reads drop errors (Post from zeros).
- 🔴 `Overheads.js:93,110,520` Save during load deletes the wrong period's rows; no `useLatestRequest`.
- 🔴 `Overheads.js:195` purchases ignore bill discounts; `:406` hardcoded traffic light; `:137` carried-forward draft unlabelled; `:317` blank-category row totalled then dropped; `:196,207` unpaged.
- 🔴 `taxPoolCompute.js:242` AD parsed as UTC → wrong tier abroad; `DepreciationRunTab.js:70` override unbounded; `TaxPoolTab.js:63` repair outside FY.
- 🔴 `GatePasses.jsx:91` reprint never awaited; `:34-62` failed reads/writes dropped; `:48` viewer-clock sweep; `:81` no `exited_by`; `:35` unpaged; `GatePassPrint.jsx:12` locale date.
- ✅ S756 — `ImsCountLogin.jsx:122-130,208` every failure = "Incorrect PIN"; bad secret = "no PINs set up".
- 🔴 `Items.js:593,624`, `Vendors.js:181,230,294,306` zero-row writes report success.

### 2e. Frontend — report hygiene (S728/S616/S754 rules)
- 🔴 Export/print not gated on `loading || loadError`: ReorderReport (Export has no `disabled`), TheoreticalVariance, PeriodComparison, AnnualSummary, MonthlySummary, BudgetVsActual, VatReport, NonVatReport, 1L, SupplierContribution, StockAgeing Print.
- 🔴 Exports not gated on `biz.error`: VAT, Non-VAT, Vendor, SupplierContribution, 1L, DeadStock, FIFO, StockAgeing.
- 🔴 `ReorderReport.js:455` KPI strip visible during load; `:525` "Stock is healthy" with no pars.
- 🔴 Hand-built sheets without `sheetWithLetterhead`: Variance, TheoreticalVariance, AnnualSummary (money as text), DemandForecast, 1L.
- 🔴 `provisionalWhenOpen` missing on VatReport, NonVatReport, VendorReport; stale tooltips (# Bills, "Gross"); VAT export disabled on returns-only months.
- 🔴 `counted_by` shown nowhere; `Stock.js:885` retyped `computeUsed`; `Stock.js:1369` locale date.
