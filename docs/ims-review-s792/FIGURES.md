# FIGURES — the food-cost figures an owner reads (revenue, COGS, FC%, wastage, variance) and whether the pages agree
Files reviewed (27): MonthlySummary.js, periodCost.js, AnnualSummary.js, PeriodComparison.js, BudgetVsActual.js,
BestSellers.js (revenue path), Variance.js, TheoreticalVariance.js, ShrinkageReport.js (load/observation path),
WastageReport.js (valuation), imsFormulas.js, uncountedItems.js, operatingBands.js, ClientDashboard.jsx (loadStats,
loadFcTrend, FC/wastage tiles), OwnerDashboard.jsx (loadImsFigures), ConsolidatedPnl.jsx (reads), computeMonthlyReport.js,
computeInventoryVariance.js, computeInventoryShrinkageTrend.js, computeInventoryTurnover.js, computeInventoryDepthSection.js,
computeInventoryDeadStock.js / computeMenuEngineeringSection.js (reads only), get_group_pnl + get_group_summary
(migration 20260918170000), Items.js (HIDE_INSTEAD), supplierAttribution.allocateBillDiscounts, salesDepletion.js,
Help.js (FC glossary/FAQ). Skipped: MonthlyOwnerReport.jsx rendering beyond the inventory rows; Stock Count's Summary
(STOCK area).

### FIGURES-1 [P1] Hiding an item (D5's own advice) silently rewrites every past month's Net Purchases and COGS
- Where: src/modules/ims/reports/periodCost.js:77-89 (valuePeriodItems sums purchases/returns only for ids in `items`),
  MonthlySummary.js:77, ConsolidatedPnl.jsx:202, AnnualSummary.js:103/171/174, PeriodComparison.js:157/207-208,
  get_group_pnl (20260918170000: `JOIN items i ... AND i.is_active`); copy at src/modules/ims/items/Items.js:32-34
- What happens: every COGS-basis page reads `items` with `.eq('is_active', true)` and values PURCHASES and RETURNS only
  for ids in that list. An item bought and used for a year and then hidden (which D5 tells the owner to do on a unit
  change — "hide it and create a new item" — and which every delete refusal offers) vanishes from every past month: its
  purchases leave Net Purchases, COGS and FC% on Monthly Summary, Consolidated P&L, the group P&L, Annual Summary and
  Period Comparison, closed months included. Example: Rice (bag) NPR 60,000/month for 12 months, stock zero, hidden as
  advised → each past month's COGS drops 60,000 and FC% falls ~6 pts on revenue 10 lakh. The frozen Owner Report
  (purchaseTotal over ALL purchases, computeMonthlyReport.js:58/105) and the Dashboard FC trend (ClientDashboard.jsx:1097,
  no item filter) keep it, so after the hide the same closed month reads differently on the P&L and the Owner Report.
- Evidence: `purchaseVal += maps.purchases[i.id]?.gross` inside `(items || []).forEach` (periodCost.js:80-85); Annual
  `purchRows = at(purchBy, pid).filter(r => isTracked(r.item_id))`. HIDE_INSTEAD says only "left out of stock valuation
  and the monthly summary, so hide it once its stock is down to zero" — zero stock does not protect past months' purchases.
- Status: missed by S756 (S720 made "drop such an item from every column" deliberate for within-row consistency; the D5
  interaction was never considered).
- Fix: Owner question 1. Recommended: value a period over every item with a row in that period, active or not; keep
  `is_active` for pickers and "on the shelf now" pages only (and the SQL copy in get_group_pnl, and Stock Count Summary).
- Confidence: Confirmed (code path); not measured live.

### FIGURES-2 [P1] The frozen Owner Report's Inventory Variance and Shrinkage Trend are pre-S719/S756 copies — every fix the live pages got is missing
- Where: src/modules/ownerReport/computeInventoryShrinkageTrend.js:41-50, 117-126; computeInventoryVariance.js:16-26, 44-72
- What happens (frozen permanently at close, never recomputed):
  1. Shrinkage Trend reads opening_stock, closing_stock, vendor_returns and staff_meals for SIX periods with bare
     `.in('period_id', windowIds)` — no fetchAllRows, no `.order()`. S719's own arithmetic: 6 periods × 200 items = 1,200
     rows; a 254-item client (the reference client) passes 1,000 on opening and closing alike. Truncated closing rows
     read as a count of 0 → whole shelf "used" → false shrinkage; which rows are lost is arbitrary per generation.
  2. Both treat a missing closing row as a counted 0 (`closeByPeriod[pid]?.[i.id] || 0`, `closeMap` sum) — the defect
     S719 (Variance) and S756 (`ShrinkageReport.js:211,217`) fixed on the live pages. Uncounted items are flagged and
     summed into "Total Variance Value" / "Total Shrinkage Loss Value".
  3. Shrinkage counts a period when `variance > 0.001` — the exact test S756 replaced on ShrinkageReport with the
     client's tolerance + NPR 500 materiality. Variance flags at a hardcoded ±10% with no materiality (and the page label
     says "±10%" regardless of the client's variance_flag_pct).
  4. Neither runs selectDepletingSales: POS + manual rows for the same dish/day both count, and a credit note
     (`pos_credit`, negative qty) SUBTRACTS theoretical usage — the S588/S696/S717 rule every live consumer follows.
  5. computeInventoryVariance's actual usage omits staff meals entirely (actual = open + net purchases − close −
     wastage), so every item fed to staff reads over-used — S551's decision, and Variance.js subtracts them.
  6. `totalActualUsed`/`totalTheoreticalUsed` sum quantities across items (kg + L + pcs).
- Result: the monthly Owner Report — the page an owner files — can show "N consistent shrinkage items, Total Shrinkage
  Loss NPR X" in red and a flagged-variance count that the live Variance and Shrinkage pages, for the same closed months,
  do not show. owner-report.md and both file headers claim these mirror the live pages "exactly".
- Status: missed by S756 (S756 paged only computeMonthlyReport's IMS section; S758 touched these files for deltas only).
- Fix: rebuild both on the live pages' helpers (fetchAllRows/Chunked with order, per-item `in closeMap`, buildUsageMap
  per period, varianceBand with the client's settings, staff meals) and bump CURRENT_SCHEMA_VERSION.
- Confidence: Confirmed (code); truncation live-impact depends on item count (≥ ~167 counted items).

### FIGURES-3 [P2] "Food Cost %" is two different formulas under one label, and three places claim they agree
- Where: purchase basis — ClientDashboard.jsx:1256 (tile) and :1149-1167 (Monthly Trend, closed months too),
  OwnerDashboard.jsx:478 (+ 12-month trend from snapshots, :541), computeMonthlyReport.js:152 (frozen Owner Report),
  get_group_summary (net_purchases). COGS basis — MonthlySummary.js:163, periodCost/ConsolidatedPnl, AnnualSummary.js:187,
  PeriodComparison.js:248.
- What happens: for the same CLOSED, fully counted month, FC% = net purchases ÷ revenue on the Dashboard trend, Owner
  Dashboard, Group Console and the monthly Owner Report, and COGS ÷ revenue on Monthly Summary, P&L, Annual Summary and
  Period Comparison. They differ by (opening − closing − wastage − staff meals) ÷ revenue. A month that ended with more
  stock than it began (opening 1 L, purchases 5 L, closing 2.5 L, revenue 10 L, warning 35) prints 50% ▲ on the Owner
  Report and 35% ✓ on Monthly Summary. Two charts titled "Food Cost % … Trend" (Dashboard, Period Comparison) plot
  different numbers for the same closed months. Even the purchase-based twins differ: the Dashboard includes purchases
  of inactive items, Monthly Summary's "Purchase-Based FC%" does not.
- Evidence of the false claims: Dashboard FC Tip "…it settles once you finish the month-end stock count"
  (ClientDashboard.jsx:1700) — the formula never reads the count; comment ClientDashboard.jsx:1094-1096 "every closed
  month must equal what Consolidated P&L / Monthly Summary charge for it"; computeMonthlyReport.js:23-25 "the frozen
  report's … Food Cost % … agree with those pages"; Help FAQ (Help.js:966) says the dashboards' Food Cost % was "brought
  into line". Help glossary (Help.js:911) defines Food Cost % as purchases-based; Monthly Summary's guide
  (imsGuideData.js:614) defines it as COGS-based.
- Status: missed by S756.
- Fix: Owner question 2. At minimum correct the Tip, the FAQ and the two comments, and rename one of the two.
- Confidence: Confirmed.

### FIGURES-4 [P2] Variance and Theoretical vs Actual measure different item sets, so "flagged" and "loss" disagree
- Where: TheoreticalVariance.js:265-266 (`.filter(item => theoretical > 0.001)`); Variance.js:51-55, 289-295
- What happens: an item that is in a recipe but whose dishes did not sell this month, yet was used (stock vanished), is
  judged Over on Variance (signed MAX_SAFE_INTEGER surrogate) and its whole usage value goes into Total Variance Value;
  Theoretical vs Actual (and ShrinkageReport.js:242, and the Owner Report copies) drop it before building rows. Same
  month, adjacent nav items: e.g. Variance "Flagged 7 ▲, NPR 18,400 potential loss", Theoretical "Items Over Tolerance 5,
  NPR 11,200". Variance.js:32-37 says the two now agree.
- Status: missed by S756 (S756 aligned the per-row band, not the population).
- Fix: one population on both (recipe-linked items with activity), or state on each page which items it covers.
- Confidence: Confirmed (code).

### FIGURES-5 [P3] "Wastage" for one month is valued over four different item sets
- Where: MonthlySummary (active, non-sub-recipe: periodCost.js:86); ClientDashboard.jsx:417/609/879 (non-sub-recipe,
  active OR hidden); OwnerDashboard.jsx:187/221-222 (every item incl. sub-recipe mirrors); computeMonthlyReport.js:84/116
  (active incl. sub-recipes); WastageReport.js:61-77 (every item via join)
- What happens: wasted prep (a sub-recipe mirror item, which Stock Count lets you log) is in Owner Dashboard, Owner Report
  and Wastage Report but not in the main Dashboard tile or Monthly Summary; a hidden item's wastage is in the Dashboard,
  Owner Dashboard and Wastage Report but not Monthly Summary or the Owner Report. Two tiles named "Wastage Value" (Dashboard
  and Owner Dashboard) can differ for the same open month with nothing saying why.
- Fix: one item set for "wastage value" (with FIGURES-1's decision), or a Tip naming what each includes.
- Confidence: Confirmed (code).

### FIGURES-6 [P3] Annual Summary and Period Comparison allocate bill discounts across the whole multi-month batch
- Where: AnnualSummary.js:156 `byPeriod(allocateBillDiscounts(purchases))`; PeriodComparison.js:207
- What happens: the fallback bill key `vendor|invoice_ref|bs_day` has no period (supplierAttribution.js:36). Two bills
  with NULL purchase_group_id from different months, same supplier, blank invoice no., same day number, merge: discount
  = max(d1, d2) instead of d1 + d2, spread across both months. ClientDashboard allocates per period for exactly this
  (ClientDashboard.jsx:1130-1137); netPurchaseFigures says "Single-period input only".
- Fix: group by period_id, then allocate per group.
- Confidence: Plausible — needs NULL purchase_group_id rows (column defaults gen_random_uuid()); confirm with
  `select count(*) from purchase_entries where purchase_group_id is null`.

### FIGURES-7 [P3] Annual Summary, Period Comparison and Shrinkage load keys omit the client
- Where: AnnualSummary.js:82 `${fy|cal}:${year}`; PeriodComparison.js:133 `limit`; ShrinkageReport.js:104 `periodCount`
- What happens: pages stay mounted across an admin view-as switch or a group Owner's outlet switch (no key={clientId});
  the new outlet's load begins with the SAME key, so a slow in-flight load for the previous outlet still passes
  isCurrent and, landing last, renders under the new outlet (the S693/S721 rule). Period-keyed pages are safe.
- Fix: prefix each key with clientId. Confidence: Confirmed code path; timing-dependent.

### FIGURES-8 [P3, KNOWN+] Owner Report revenue still uses `.neq('source','pos_comp')`, now alone
- Where: computeMonthlyReport.js:70 (and computeMenuEngineeringSection.js:32), listed "still open" in ims-figures.md
- New since S756: Monthly Summary, Annual and Period Comparison left the `.neq`, so a Regenerate Snapshot of any month
  holding NULL-source legacy rows freezes a revenue LOWER than Monthly Summary's — the denominator of Food Cost %,
  Labour %, Prime % and Net Margin % on an immutable report whose header comment claims it agrees.
- Confidence: Confirmed code; impact limited to months with legacy NULL-source rows.

### FIGURES-9 [P3] Budget vs Actual's total claims to reconcile with Monthly Summary's Net Purchases and cannot
- Where: BudgetVsActual.js:72 (items lack `.eq('is_sub_recipe', false)`), :117-122 (`unclaimed` = hidden items), :194-198
- What happens: the Totals row adds hidden items' purchases (and would add sub-recipe mirrors), which Monthly Summary
  drops (FIGURES-1), under a comment saying this is what makes it reconcile. Confidence: Confirmed code.

### FIGURES-10 [P3] Monthly Summary has no Excel export, but Help says it does
- Where: MonthlySummary.js (Print only; no xlsx); Help.js:126 "Export to Excel for your accountant", Help.js:1393.
- Confidence: Confirmed.

### FIGURES-11 [P3] First paint before any read on Period Comparison / Annual Summary
- Where: PeriodComparison.js:104 `loading` starts false → "—" tiles and "No periods found." until the periods read
  lands; AnnualSummary.js:57 sets loading false before a year is chosen → a frame of "No periods found for —."
- Confidence: Confirmed code (S717 DeadStock shape); cosmetic.

## GAPs
1. Prep made at month end reads as raw-material theft. Variance/Theoretical/Shrinkage exclude sub-recipe mirror items,
   so onions and tomatoes turned into tomorrow's gravy on the 30th (and counted under the gravy) show as Over on the raw
   items. Nothing on the variance pages says so; an owner reads it as loss.
2. Monthly Summary says its COGS differs from Stock Count "by exactly the sub-recipe amount" but never prints that
   amount, so the owner cannot tie the two pages.
3. No Excel of Monthly Summary for the accountant (FIGURES-10) — the P&L has one, the month-end report does not.
4. The frozen Owner Report never says which items were uncounted at close (D6 covers four live pages only), yet its
   turnover, variance and shrinkage lines all lean on the count.
5. Two "Food Cost %" with no in-page explanation of which one the owner is looking at (FIGURES-3).

## Owner questions
1. When you hide an item you no longer use, should the months you already bought and used it in still count it?
   (a) Yes — past months keep every purchase and count; only entry screens stop offering it (recommended);
   (b) No, as today — hiding removes it from Monthly Summary and the P&L for every month;
   (c) Refuse to hide an item with purchases in the last 12 months.
2. "Food Cost %" on the Dashboard and your monthly Owner Report is "what I spent on stock ÷ sales"; on Monthly Summary and
   the P&L it is "what I actually used ÷ sales". Which should a finished (closed, counted) month show?
   (a) "Used ÷ sales" everywhere for closed months, and "spent ÷ sales" only for the running month, labelled
   "Spend % so far" (recommended); (b) keep both, rename the dashboard one "Purchase %"; (c) leave as is.
3. Should the Variance and Theoretical-vs-Actual pages count an ingredient whose dishes sold nothing this month but whose
   stock went down? (a) Yes on both — stock vanishing with nothing sold is exactly the loss to chase (recommended);
   (b) No on both — only judge items with sales; (c) keep them different but say so on each page.

## Checked and fine
- periodCost.js is the only revenue/COGS arithmetic for Monthly Summary and Consolidated P&L; both pages' reads match
  (active non-sub items, all per-item reads paged with .order('id'), sales select `source`, comps filtered in JS).
- get_group_pnl mirrors it: is_active AND NOT is_sub_recipe, per-period bill key, `IS DISTINCT FROM 'pos_comp'`,
  COALESCE(unit_price, selling_price); sales_entries.recipe_id FK is NO ACTION so its inner join drops nothing.
- Revenue definition identical on Monthly Summary, P&L, Annual, Comparison, Dashboard, Owner Dashboard, Best Sellers
  (unit_price else current price, minus row discount, comps out in JS, credit notes net).
- S756 `.neq('source','pos_comp')` removal holds on MonthlySummary:91, AnnualSummary:121, PeriodComparison:177.
- S756 superseded-load `loading` fix + init() begin() hold on MonthlySummary, Variance, TheoreticalVariance, BudgetVsActual.
- S756 AnnualSummary key carries the mode; fiscalMode is an effect dependency.
- S756 TheoreticalVariance footer covers measured rows only; Over/Under filter by band.
- S756 BudgetVsActual: falls back to latest period; unsaved budget refused loudly; D7 provisional line and no verdict.
- S756 PeriodComparison excludes inactive + sub-recipe mirror items from stock values (rateMap/isTracked).
- D6: banner, per-row mark, export note and withheld verdict on Monthly/Annual/Comparison; isMaterialGap per spec.
- D7: Monthly Summary opens on the open month with the Provisional line, no verdict, neutral box tint.
- D17 on Variance: no_recipe state, excluded from Flagged and Total Variance Value, filter option, export note; option-only
  items (S758 deltas) counted as linked.
- Variance total band denominator is theoretical VALUE (S756). ShrinkageReport (live) uses the band + per-item count.
- S758 deltas reach Variance, Theoretical, Shrinkage, Dashboard and both Owner Report copies.
- Fiscal year: getFiscalYear uses Shrawan = 4; FY months sort Shrawan→Ashadh; closing_stock.physical_qty is NOT NULL.
- operatingBands.js: null-safe bands, marks carried by bandFigure.
- Exports/print gated on loading/loadError/biz.error on Annual, Comparison, Variance, Theoretical; Monthly print gated.
- Owner Report dead-stock section (S756, schema 7) is paged/chunked with order.
