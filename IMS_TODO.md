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
| D5 | Item unit/price edits with history | **Refuse a unit change** once the item has purchases or counts ("hide it and create a new item"). **Warn on a price change**, naming how many past records it re-values. ✅ S756 |
| D6 | Uncounted items on summaries | Stock Count Summary, Monthly Summary, Annual Summary, Period Comparison: **amber warning naming the uncounted items, marked in table and export; FC% shown without a colour verdict** while the gap is material. Totals unchanged. ✅ S756 |
| D7 | Open-month reports | Monthly Summary / Budget vs Actual keep opening on the current month, **marked provisional, no red/green verdict** until closed. Fall back to latest period when none is open. ✅ S756 |
| D8 | Price on a corrected past sales day | **Every row keeps its stored `unit_price`**; only new rows take today's menu price. ✅ S756 |
| D9 | Lump-sum supplier payment | **One amount per supplier, applied oldest bill first, split shown before saving.** Per-bill entry stays. ✅ S756 |
| D10 | Late returns | A return may pick a bill from an earlier month and **sits in the month it happened** (VAT timing to be confirmed by an accountant — say so in Help). ✅ S756 |
| D11 | Supplier credit | **"Settle using supplier credit"** on a payment against another bill of the same supplier. ✅ S756 |
| D12 | Same PAN on two suppliers (1L report) | **Aggregate by PAN**, listing all names; warn on blank PANs. ✅ S756 |
| D13 | Invoice VAT capture | **Two optional fields** on a purchase bill (invoice VAT, invoice total); flag mismatch > NPR 1. Migration. ✅ S756 |
| D14 | Requisitions | **Record requested_by / issued_by / issued_at**; add **Rejected** status with reason. No two-person rule, no back-orders. ✅ S756 |
| D15 | Dish VAT toggle | **Keep the guest price** on both Recipe Costing and Menu Pricing; show resulting ex-VAT. ✅ S756 |
| D16 | Dish photos | **Upload button** storing photos in Crest (Supabase Storage). ✅ S756 |
| D17 | Non-recipe items on Variance | Grey **"no recipe linked"** state, excluded from flagged count and loss total. ✅ S756 |
| D18 | Reorder quantities | **Both units, rounded up to whole packs** — print, WhatsApp and Excel. ✅ S756 |
| D19 | Stock Ageing / FIFO basis | **Anchor to the physical count** where one exists (oldest removed first), **state the basis**, **rolling 12-month** window. ✅ S756 |
| D20 | Dead stock | **Dead after 2–3 consecutive months** with no movement (shorter = Slow); **suggested next step** per item. ✅ S756 |
| D21 | Demand forecast | **Exclude past holidays** from weekday averages; ingredient list shows **forecast use / in store / to buy**. ✅ S756 |
| D22 | Dashboard labour | Dashboard Fixed Costs % / Est. Net Margin **use finalized payroll**, like Overheads, naming the source. ✅ S756 |
| D23 | Depreciation in profit | **Memo line** on Overheads P&L — shown, not subtracted. ✅ S756 |
| D24 | Asset fixes | **Charge depreciation to the disposal date**; **Adjustment run** to reverse a wrong run + warn before posting an overlapping period. Personal-use apportionment **not** chosen (legal question). ✅ S756 |
| D25 | Supplier tidy-up | **Owner can archive, restore and delete** suppliers (DB trigger still refuses deleting one with history). ✅ S756 |
| D26 | Bill edit with a return against it | **Refused** until the return is removed (same shape as `purchase_bill_has_payments`). Migration. ✅ S756 |
| D27 | Gate passes | Day boundary **6 AM Nepal time**; **void with reason** keeping the number. ✅ S756 |
| D28 | Accountant extras | **Bill-wise sheet** in VAT export; **Sales import warns** when the file's date range ≠ selected day. ✅ S756 |

Open question for an accountant, not engineering: IMS-only clients have no sales-side VAT view (net VAT payable) anywhere in Crest.

---

## 2. Clear-cut fixes (one right answer)

**Stage 2 (wrong numbers and lost changes) shipped in S756** — migration `20260918110000` (bill edit refused with returns, non-negative discount CHECK, gate-pass void) plus ~60 frontend files, with owner decisions D5, D8, D12, D15, D17, D18, D21, D23, D24, D25, D26, D27 and D28 built alongside the fixes in the same files.

**Stage 3 (owner decisions) shipped in S756** — migrations `20260918120000` (supplier credit pairs), `20260918130000` (invoice VAT/total columns), `20260918140000` (requisition attribution + Rejected, and the staff-adds-lines-to-an-issued-slip gap closed), `20260918150000` (dish-photos bucket), `20260918160000` (Logos SELECT policy — logo replace/remove had been failing since 20260914140100). All eleven remaining decisions are built.

**Stage 4 (follow-ups and judgment calls) shipped in S756** — frontend, plus migration `20260918170000` (group payroll figures include overtime, applied live after a rolled-back dry run). Owner answers: payroll labour includes overtime on every page; Owner Dashboard uses finalized payroll when it exists; parking closes at 6 AM too; the Annual Summary year-total verdict stays withheld when the year's gap is material; Stock Ageing stays cautious about count surpluses; the Stock Count export gets the letterhead; the One Lakh report keeps deducting unlinked returns and says so; disposals recorded before S756 are left as recorded.

- ✅ S756 stage 4 — A return against an EARLIER month's bill is valued at that bill's discount on PaymentReport, VendorReport, SupplierContribution and computeVendorPurchasingSection (`applyPriorBillFactors` / `mergeFactors` in `supplierAttribution.js`). VendorReport's drilldown lists earlier-bill and unlinked return rows.
- ✅ S756 stage 4 — Monthly Owner Report dead stock uses `deadStockCalc.js` (3 counted still months); `CURRENT_SCHEMA_VERSION` 7, which also covers the vendor section's discounted returns, returns' own payment method and paged read.
- ✅ S756 stage 4 — Overheads.js adopts `labourSource.js` and pages its payslips read.
- ✅ S756 stage 4 — OwnerDashboard Labor/Prime/True Net Margin use the finalized payroll run when one exists (gross + OT + employer SSF, the Owner Report's figure), name the source, show dashes on a failed read, and withhold the verdict when a full month's payroll sits against part of a month's revenue.
- ✅ S756 stage 4 — KitchenDisplay.jsx imports `serviceDayStartIso` from nepalTime.js.
- ✅ S756 stage 4 — POS parking auto-close cuts off at the actual 6 AM, like gate passes (owner decision).
- ✅ S756 stage 4 — Stock Count export carries the letterhead (owner decision). Annual Summary year-total verdict: kept as built (owner decision).
- ✅ S756 stage 4 — Stock Ageing count surpluses: kept cautious (owner decision, no change).
- ⚪ Budget vs Actual's provisional line talks about spend rather than food cost — wording only.
- ⚪ Dish photos uploaded to a NEW recipe that is then cancelled leave an unused file in storage.
- ⚪ **S761 left the counter trim as a DISPLAY control, and the owner knows.** Only `closing_stock`
  carries counter-scoped RESTRICTIVE policies (`ims_count_scope_*`, migration `20260910120000`);
  `opening_stock`, `wastages` and `staff_meals` have none, so a count PIN's JWT can still write
  them over REST even though the tabs are gone. Blind count and section scoping already carry the
  same caveat and say so on the Settings tab. Making it a real boundary is a migration and a
  separate owner decision — not started.
- ⚪ **S761 was not click-verified as a count account.** The PIN is hashed, so the trimmed page was
  checked by build, lint, the full suite and by hand-checking the header/body/footer column counts
  across all four `hideValues` × `blindCount` combinations — not by signing in on a phone. Worth a
  real look on a storeroom handset before the next month-end count.
- ✅ S756 stage 4 — Payroll labour cost includes OVERTIME everywhere (owner decision): gross + overtime + employer SSF on Overheads, ClientDashboard, ConsolidatedPnl, Group Dashboard and the group P&L (migration `20260918170000`, applied live), matching the Owner Report and Owner Dashboard. `payrollCashCost` (absence subtracted) stays the cash-paid figure.
- ⚪ `purchaseTaxSplit.js` keeps a private `mergeFactors`; `billPayables` could take prior bill lines directly (tidy-up).
- ⚪ Owner Report vendor section: cash/credit split is pre-discount, and its aging total is compared against payments that include VAT.

- ✅ S756 stage 3 — D22 — ClientDashboard Fixed Costs % / Est. Net Margin use finalized payroll, and say "labour unreadable on this login" for an IMS staff login (Overheads does both now).
- ✅ S756 stage 3 — VendorReport: `provisionalWhenOpen` on PeriodScope; SupplierContribution + VendorReport export gating on loading/biz.error.
- ✅ S756 stage 3 — PaymentReport `billPayables`: unlinked returns valued with no VAT added back and no banner (VAT/Non-VAT now name them).
- ✅ S756 stage 3 — ReorderReport export has no letterhead (`sheetWithLetterhead`).
- ✅ S756 stage 3 — PurchaseBillPage `applyRateUpdates` rewrites `items.rate` with no D5 price warning and no zero-row check; its `load()` shows raw `error.message`.
- ✅ S756 stage 3 — Purchases/Returns "Delete All" has no zero-row check; OutstandingPayables bulk `paid_at` `.in()` is not chunked.
- ✅ S756 stage 3 — TheoreticalVariance's Over/Under-consumed filter buttons test raw `variance > 0.01`, not the tolerance band.
- ✅ S756 stage 3 — `findSupersededRows` / `persistSalesDay` rethrow `new Error(error.message)`, losing the error code.
- ✅ S756 stage 3 — Move `serviceDayStartIso` (POS parking) into `src/shared/nepalTime.js`; GatePasses imports it from the POS modal. Decide whether POS parking's auto-close should use the actual 6 AM like gate passes (it cuts off at the service day's midnight).
- ✅ S756 stage 4 — Disposals recorded before S756 keep a gain/loss measured at the last posted run — left as recorded (owner decision).
- ✅ S756 stage 4 — 1L report: an UNLINKED return is still deducted from its supplier's total — kept, and the page says so (owner decision).
- ⚪ Demand Forecast Recompute now skips past holidays, which changes what Roster's Labor Forecast reads.

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
- ✅ S756 — `save_purchase_bill` refuses superseding lines with returns (D26).
- ✅ S756 — `get_ims_count_staff`: drop settlement-blocked employees; RAISE on bad device secret.
- ✅ S756 — `ims_device_secret` rotate RPC (D4).
- ✅ S756 — `purchase_entries` CHECK `discount_amount >= 0`.

### 2b. Edge Functions
- ✅ S756 — `admin-user-ops update_ims_role`: refuse any rank but `staff` for a count-PIN (`ims_email`) target; `revokeClientTablets` also rotates `ims_device_secret`.

### 2c. Frontend — security/access
- ✅ S756 — `AuthContext.js:225` profile select lacks `ims_email` → `imsCountOnly` always false; count PIN reaches everything staff can.
- ✅ S761 — the other half of that one, found from a photo of a counter's phone, not from the audit: `imsCountOnly` fences the ROUTE and nothing inside it, so a count PIN opened `/stock` to all seven tabs — Opening Stock (an entry grid over the month's starting basis) as the DEFAULT, Summary with COGS/purchase value/Excel export of the cost base, and Print Sheet + Summary making `ims_count_blind` readable in two taps. Now one tab (Closing Stock), no NPR per line for any Staff-rank counter, and blind count covering all three screens. **Display control only** — see below.
- ✅ S756 — `ImsStaff.jsx:594/245/167` hide rank select for PIN rows; exclude from job-title sync.
- ✅ S756 — `ClientDashboard.jsx:2574-2596` End Period button role check (D2).
- ✅ S756 — `Overheads.js:210+` IMS-role login can't read payroll → says "no payroll run" and green Net Profit; say labour unreadable, withhold verdict.

### 2d. Frontend — wrong numbers / data loss
- ✅ S779 — `PurchaseBillForm.jsx` held a whole vendor bill in React state until Save, so a Chrome
  auto-update restart, a tablet discarding the backgrounded tab, the memory saver or a
  deploy-triggered chunk reload took 10–20 typed lines with it, silently. Reported live. Drafted to
  `localStorage` per bill per login (`purchaseBillDraft.js`), restored behind an amber notice,
  cleared on save and on cancel. Rule: `.claude/rules/offline-and-cache.md`.
- ⚪ **`Sales.js`' bulk grid is the same shape and is not drafted.** A human legitimately spends
  minutes in it before Save and nothing survives the page dying. Stock Count is covered by the
  offline queue and per-row saves; Sales Entry is covered by neither.
- ✅ S780 — Dashboard's Daily Purchases vs Sales Target was a least-squares line through the
  month's first 5 days, frozen. CASA, Ashwin 2083: it ran to zero by day 14 (sales target 92,144
  against 73,846 sold by day 6), and the 1.25× ceiling became the purchase forecast (2,40,207).
  Rebuilt in `src/modules/dashboard/dailyForecast.js`. The Target is the last 4 weeks' weekday
  pattern from Day 1, and the forecast is that pattern × this month's pace. Old snapshots are
  replaced once. Rule: `.claude/rules/dashboards.md`.
- ✅ S783 — The purchase Target was still one flat daily average. It now follows the client's own
  buying week, a no-bill day counting as zero (CASA: Sunday restock ~12,800, Saturday ~2,350), and
  deliberately does not follow the sales curve. The purchase snapshot moved to model 3 and was
  replaced once; the sales Target was left frozen.
- ✅ S784 — The dashed SALES forecast can allow for rain (Growth+). The Owner sets the city and "a
  rainy day sells about N%" in Settings → Weather; MET Norway via the `weather-forecast` Edge
  Function; purchases and both Targets never move. Rule: `.claude/rules/dashboards.md`.
- ✅ S784 — `weather-forecast`'s signed-in path, unexercised at ship, confirmed live the same day:
  CASA ACAI CAFE set Kathmandu at 50%, and the first dashboard load wrote a `weather_locations` row
  with `last_error` NULL and ten `weather_daily` rows (today incomplete, the nine days ahead complete).
- ✅ S785 — the header strip's high/low, cloud and thunder, unobserved at push, confirmed live
  2026-09-24: every Kathmandu and Pokhara row carries them, `last_error` NULL on both, and CASA's
  strip matched the stored rows (S786 moved the strip to POS and HR too).
- ⚪ **The Target's weekday averages still count past public holidays.** Demand Forecast
  (`DemandForecast.js`, D21) leaves them out and applies Holiday Calendar multipliers. Here, a
  Dashain Saturday in the 4-week window lifts the Saturday target for the next month, and a big
  pre-festival restock lifts that weekday's purchase target the same way. A holiday in the open
  month is not marked either. Candidate: read the same Holiday Calendar and exclude
  those days in `historyWindowDays()`.
- ✅ S756 — `Stock.js:709-727` Save All writes/deletes every visible row (parallel tablets wipe each other; restamps counted_by; recount guard refuses) → send changed cells only.
- ✅ S756 — `Stock.js:549-586` offline replay into closed period (with D1).
- ✅ S756 — `Stock.js:810,242` bare selects (pull-from-last-month, items).
- ✅ S756 — `computeMonthlyReport.js:58,77-84` six bare selects inside the frozen snapshot.
- ✅ S756 — `Stock.js:944-951,1163` Summary purchases at master rate, no discounts; wrong "exactly" note.
- ✅ S756 — `closePeriod.js:78-88` counted-vs-active mismatch.
- ✅ S756 — `Purchases.js:383-399,703` Item filter values half a bill (negative totals).
- ✅ S756 — `vendorBalanceHelpers.js:83-87` legacy-bill discount multiplied.
- ✅ S756 — `PurchaseBillForm.jsx:358` discount unvalidated; `:292` Save live after save → duplicate bill.
- ✅ S756 — `ReturnsTab.jsx:67` return dated before its bill; `OutstandingPayables.js:396` silent overpay cap.
- ✅ S756 — `persistSalesDay.js:43-49` unpaged supersede check → silent month delete.
- ✅ S756 — `Sales.js` save against stale day/period baseline (3 windows) → capture `{periodId, bsDay}` at click.
- ✅ S756 — `Sales.js:348-373` unit_price restamp (D8).
- ✅ S756 — `persistSalesDay.js:186-191` cross-mode supersede leaves stock_movements (double depletion); `:170` huge `.in()` / unpaged.
- ✅ S756 — `SalesImportButton.jsx:6-9,40` `1,250.00`→1; `Disc %` picked as amount.
- ✅ S756 — `Sales.js:635` From-POS revenue at today's price; `:225` unpaged day read; `:676` admin closed-month banner.
- ✅ S756 — `Recipes.js:1896` list-view errors render nowhere (Delete/Hide refusals invisible).
- ✅ S756 — `Recipes.js:1469…`, `RecipeCostCardPrint.jsx` no-ingredient recipe shows `0.0% ✓` → `recipeCostOf`/`menuFcPct`.
- ✅ S756 — `Recipes.js:703` update re-activates hidden dish.
- ✅ S756 — `Recipes.js:899,906,907` dropped write errors (mirror link).
- ✅ S756 — `.neq('source','pos_comp')` drops NULL rows: `Recipes.js:227`, `MonthlySummary.js:74`, `AnnualSummary.js:109`, `PeriodComparison.js:166`.
- ✅ S756 — `MenuPricing.js:350,403` null category crash (ask branch before editing — POS-only branch).
- ✅ S756 — `RecipeImportButton.jsx:29` Selling Price column is ex-VAT, unlabelled.
- ✅ S756 — `Variance.js:51-53` total band NPR ÷ mixed quantities; `:210-248` flag vs band disagree.
- ✅ S756 — `ShrinkageReport.js:211,217` uncounted = zero; no tolerance/materiality.
- ✅ S756 — `PeriodComparison.js:153-166` includes inactive + sub-recipe mirror items.
- ✅ S756 — `BudgetVsActual.js:52,142` budgets typed with no open period silently discarded.
- ✅ S756 — Superseded load clears `loading`: `Variance.js`, `TheoreticalVariance.js`, `MonthlySummary.js`, `BudgetVsActual.js`; `init()` never `begin()`s on those four + `StockReport.js:39`.
- ✅ S756 — `TheoreticalVariance.js:532` footer includes unmeasured rows.
- ✅ S756 — `AnnualSummary.js:72` request key collides calendar/FY.
- ✅ S756 — `BudgetVsActual.js:275` negative actual renders `—`.
- ✅ S756 — `DeadStock.js:170` float equality; `:76` defaults to open month.
- ✅ S756 — `FifoReport.js:40`/`StockAgeing.js:43` as-of = end of last month while it is still open (expired shows green).
- ✅ S756 — `FifoReport.js:178`/`StockAgeing.js:195` returns against out-of-window bills lost; `StockAgeing.js:398` 90+ card ✓.
- ✅ S756 — `DemandForecast.js:122` past days listed as "next 7"; `:159` dropped error; `:177` horizon switch mid-recompute.
- ✅ S756 — `purchaseTaxSplit.js:42-43` unlinked returns vanish from VAT/Non-VAT (input VAT overstated) → partition + named banner.
- ✅ S756 — `VatReport.js:297` on-screen per-line VAT pre-discount vs workbook post-discount.
- ✅ S756 — `PurchaseOneLakhAboveReport.js` no letterhead/scope; `:46` infinite Loading with no periods; `:67` error before isCurrent.
- ✅ S756 — `AssetCard.jsx:32` disposal gain/loss from dropped read; `FixedAssets.js:43` both reads drop errors (Post from zeros).
- ✅ S756 — `Overheads.js:93,110,520` Save during load deletes the wrong period's rows; no `useLatestRequest`.
- ✅ S756 — `Overheads.js:195` purchases ignore bill discounts; `:406` hardcoded traffic light; `:137` carried-forward draft unlabelled; `:317` blank-category row totalled then dropped; `:196,207` unpaged.
- ✅ S756 — `taxPoolCompute.js:242` AD parsed as UTC → wrong tier abroad; `DepreciationRunTab.js:70` override unbounded; `TaxPoolTab.js:63` repair outside FY.
- ✅ S756 — `GatePasses.jsx:91` reprint never awaited; `:34-62` failed reads/writes dropped; `:48` viewer-clock sweep; `:81` no `exited_by`; `:35` unpaged; `GatePassPrint.jsx:12` locale date.
- ✅ S756 — `ImsCountLogin.jsx:122-130,208` every failure = "Incorrect PIN"; bad secret = "no PINs set up".
- ✅ S756 — `Items.js:593,624`, `Vendors.js:181,230,294,306` zero-row writes report success.

### 2e. Frontend — report hygiene (S728/S616/S754 rules)
- ✅ S756 (VendorReport/SupplierContribution finished in stage 3) — Export/print not gated on `loading || loadError`: ReorderReport (Export has no `disabled`), TheoreticalVariance, PeriodComparison, AnnualSummary, MonthlySummary, BudgetVsActual, VatReport, NonVatReport, 1L, SupplierContribution, StockAgeing Print.
- ✅ S756 (VendorReport/SupplierContribution finished in stage 3) — Exports not gated on `biz.error`: VAT, Non-VAT, Vendor, SupplierContribution, 1L, DeadStock, FIFO, StockAgeing.
- ✅ S756 — `ReorderReport.js:455` KPI strip visible during load; `:525` "Stock is healthy" with no pars.
- ✅ S756 — Hand-built sheets without `sheetWithLetterhead`: Variance, TheoreticalVariance, AnnualSummary (money as text), DemandForecast, 1L.
- ✅ S756 (VendorReport/SupplierContribution finished in stage 3) — `provisionalWhenOpen` missing on VatReport, NonVatReport, VendorReport; stale tooltips (# Bills, "Gross"); VAT export disabled on returns-only months.
- ✅ S756 — `counted_by` shown nowhere; `Stock.js:885` retyped `computeUsed`; `Stock.js:1369` locale date.

---

## 3. From the S765 design critique (`/impeccable critique ims module`, 29/40)

Snapshot: `.impeccable/critique/2026-09-16T07-48-04Z__src-modules-ims.md`. Everything in the P0/P1/P2
tiers shipped in S765; what is listed here is only what did not.

- ✅ S765 — The touch stock-count screen was gated on `window.innerWidth < 768`, exactly
  iPad-portrait width, so NO tablet had ever reached it. Now `(pointer: coarse)`.
- ✅ S765 — The count card's "done" cue fired on keystroke, so typed and saved looked identical on a
  shared tablet. Four states now, each carrying a word as well as a colour.
- ✅ S765 — `Tabs`/`FilterChips` (`src/components/Tabs.jsx`): `aria-controls`, `role="tabpanel"` and
  roving `tabIndex` each appeared ZERO times across the module; 15 of 24 chip rows had no
  `aria-pressed`.
- ✅ S765 — Sales Entry's KPI strip rendered 95 lines above its own `loading` guard, so `NPR 0` in the
  accent stayed painted above "could not load" on the revenue denominator for every food-cost figure
  in the product. Overheads' bucket cards claimed "Not entered yet" during every load.
- ✅ S765 — Outstanding Payables' bill drilldown was a frozen `rgba(10,12,18,0.7)`, ~2.0:1 on
  Modernist Light, plus seven sibling literals.
- ✅ S765 — Eight live `window.confirm` and one `alert()`, including the stock-shortfall warning.
- ✅ S765 — `ClosedPeriodBanner`: five copies, four byte-identical and one already drifted.
- ✅ S765 — The `.impeccable/config.json` `26px` ignore carried no `files:` key, so it suppressed that
  size product-wide while its reason named one print template.

**Open after S765:**

- ⚪ **`26px` outside IMS is still off-ramp** — `PosLogin.jsx`, `GuestMenu.jsx`, `Pricing.js` (×3),
  `Settings.js`, `ClientDrawer.js`, `ArrivalAlert.css`. Left deliberately: these are brand-facing
  surfaces where a type size is a design decision, not a cleanup, and they were outside the scope of
  an IMS critique. Note the detector cannot see most of them anyway (next item).
- ⚪ **The design detector reads only a QUOTED font size.** Probed in S765: `fontSize: '26px'` is
  flagged, `fontSize: 26` is not — and this codebase is ~3,450 inline style blocks. Measured across
  1,233 numeric sizes in IMS, exactly one was off-ramp, so IMS is clean behind the blind spot; the
  rest of the product has not been measured this way.
- ⚪ **`tabular-nums` does not reach the 13 hand-rolled `<table>`s**, including the purchase-bill line
  table — the product's most-used money entry form renders in proportional figures. `Layout.css`
  scopes the rule to `table.data-table td` and `.stat-value`.
- ⚪ **Three report pages still have no empty branch at all** — `PaymentReport`, `Overheads`,
  `BudgetVsActual` — and seven more hand-roll one instead of `.empty-state`.
- ⚪ **Stock Count, Overheads and Requisitions still render no closed-period banner**, which
  `closed-periods.md` has flagged since S651. `ClosedPeriodBanner` now exists for them.
- 🔵 **The Starter tier's nav deletes locked rows rather than upselling** — raised by the critique as
  an inconsistency with the Crest Suite group, which stays visible with a PRO chip. Settled as
  deliberate (owner decision, 2026-09-16) and recorded in `.impeccable/critique/ignore.md` so a
  future critique does not re-raise it. The group-LABEL question is explicitly left open there: a
  "Costing" group whose only surviving member is a price list is a labelling problem that survives
  the decision.
