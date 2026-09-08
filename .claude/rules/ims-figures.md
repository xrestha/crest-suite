---
paths:
  - "src/shared/imsFormulas.js"
  - "src/utils/demandForecastData.js"
  - "src/utils/demandForecastMath.js"
  - "src/modules/ims/stockcount/**"
  - "src/modules/ims/reports/**"
  - "src/modules/ims/sales/**"
  - "src/modules/ims/recipes/**"
  - "src/pages/Settings.js"
  - "src/modules/ownerReport/computeMenuEngineeringSection.js"
---

# The IMS figures that must come from one place

> Moved out of the root CLAUDE.md (2026-08-27 /doctor pass) so it loads only when working on
> these files. Root CLAUDE.md keeps the universal invariants.

### The IMS figures that must come from one place (S551)

`src/shared/imsFormulas.js` exists because two figures had drifted into several disagreeing copies, and both are figures the product is sold on.

- **COGS / "used".** Nine pages printed the formula nine ways, four of them contradicting the code directly beneath them, and two pages genuinely computed it differently: `AnnualSummary` left Staff Meals out while `MonthlySummary` included them — same month, same column label, two numbers. The decision (2026-08-13) is that **staff meals are in COGS** — the food came out of the same stock. Import `COGS_FORMULA` wherever the formula is *printed* and `computeUsed()` wherever it is *computed*, so the sentence can never drift from the arithmetic again. Any figure that values stock must still carry `.eq('is_active', true)` (S436) — that rule is unaffected.
- **Variance banding.** `varianceBand(pct, value, settings)` / `varianceFigure(...)` (added
  2026-08-31/S659, `imsVarianceBand.test.js`). **Three thresholds for one concept were live on two
  adjacent nav items.** `Variance.js` flagged rows at the client's `variance_flag_pct` but
  *coloured* them at `variance > 0` — no threshold at all — so a +0.4% row was painted red across
  three columns while the flag badge in its own last column read **"OK"**: two verdicts on one row,
  four columns apart. `TheoreticalVariance.js` hardcoded ±5 in a private `varianceColor()`, so the
  number the client sets in Settings reached one of the two pages that measure the same thing.
  Three properties are load-bearing and none of the three copies had all of them: it reads the
  **client's** tolerance; it carries a **materiality floor** (`VARIANCE_MATERIALITY_NPR`, 500) so a
  +40% swing worth NPR 20 reads `≈` in the quietest tier instead of being the loudest red on the
  page (S644's dead zone); and it returns a **shape mark** (`✓ ▲ ▼ ≈`) because Light collapses
  red/amber to ΔE 3.1 under deuteranopia — over-used and under-used, the two states the report
  exists to separate, were one colour for roughly 1 in 12 men. Per S634 the marks state DIRECTION
  literally and the colour carries the verdict. `measured: false` is how a caller says "no closing
  count yet"; every figure is then an artefact of the gap, not a finding.
- **Food cost % banding.** `fcBand(pct, settings)` reads the client's `fc_warning_pct`/`fc_critical_pct` and returns the `*-text` contrast variants. Five files each carried their own hardcoded `≤30 : ≤38 : else` copy, which disagreed with the very filter pills the user had just clicked. **`MenuEngineering.js`'s `FC_CUTOFF = 35` classification is deliberately NOT routed through this** — `computeMenuEngineeringSection.js` mirrors `classify()` verbatim for the frozen Monthly Owner Report, so changing it would silently desync a snapshot from the live page it must agree with. Its colours use `fcBand`; its maths does not.
- **The other three operating ratios band in `src/shared/operatingBands.js`, not here (S660).**
  `lcBand` (labour, 30/37), `pcBand` (prime, 60/65), `nmBand` (net margin, **inverted**, ≥20/≥10)
  and the `descendingBand` primitive. They are deliberately a separate module: labour is an HR
  figure and prime cost is food + labour, so neither belongs in a file named for IMS — and their
  middle step is `accent-ink`, not `fcBand`'s amber, because the four owner-altitude metrics read
  as one set (amber is spoken for by HR's status ladder; see `hr-payroll.md`). The Monthly Owner
  Report bands **food** cost through `descendingBand` with `fcThresholds()`'s numbers for exactly
  that reason. Reach for `bandFigure(pct, bander)` rather than `bander(pct).color`: it appends the
  ✓/△/▲ to the number, which is what stops a call site taking the colour and dropping the shape —
  the Owner Dashboard's hand-written copy of the labour band had done precisely that.

**A settings field with no reader is worse than no field — and "it is wired now" is a claim worth
re-checking.** `variance_flag_pct` shipped with a hint saying the Variance Report used it while the
report hardcoded 10. That was fixed, and this line then read "It is wired now" for months while the
field was still reaching **one** of its three consumers: `TheoreticalVariance` hardcoded ±5 and
`Variance`'s own row colours ignored the threshold entirely (S659, above). A setting is wired when
every surface that bands the same figure reads it, not when the first one does. When adding a
threshold to `Settings.js`, grep for **every** consumer before shipping it — and when declaring one
fixed, grep again.

**Stock Count's Summary tab holds two tables that must reconcile, and four separate things had broken that (S567, found auditing before a real month close).** The category rollup and the item-level table are built from *different loops* — the rollup over `categories`, the table over `items` — so any item the rollup's loop cannot claim silently drops out of the Totals a month gets closed on while still appearing below. That was true of every item with `category_id = NULL` or a stale category id; there is now an `Uncategorised` group, rendered only when non-empty. The same class of divergence produced three more: the item row printed wastage as the catch-all only while `getUsed()`, the rollup and the Excel export all use **catch-all + daily** (so the row visibly did not add up wherever Daily Wastage was used); `hasData` tested opening/closing/purchases only, blanking Used/COGS for an item carrying just waste — exactly the shape that goes negative — and skipping it in `saveAll`'s negative-usage guard; and `staff_meals` was read across both `type` values while `persistValueDirect` deletes and reinserts only `type='staff'`, so a single `'comp'` row would have displayed a figure the tab cannot edit and doubled it on the next save. **Before adding a figure to either table, add it to both and check they still tie out** — nothing on the page cross-checks them, and each of these read as a plausible number.

Two standing notes for this page specifically:

- **Every period-scoped read here is now `fetchAllRows`-paged**, not just `purchase_entries` (which is all the S529 sweep had wrapped). The 1000-row cap matters more here than anywhere else in IMS: a truncated read produces a believable COGS rather than an error, and this is the page a period is closed from. `wastages` is the one that realistically crosses it — daily entries are one row per item per day — while `opening_stock`/`closing_stock` are one row per item and would only bite a client past 1000 items.
- **Save All / Clear All write in BULK, through `persistValuesBulk()` — not one item at a time.**
  The old per-item loop cost one round trip per visible item (two on the wastage/staff-meal tabs,
  which are delete-then-insert), so a real 300-item count took minutes on the page a month is
  closed from. The bulk path must keep both halves of the `persistLocks` contract — await every
  affected key's pending promise before starting, register itself as each key's new tail — or the
  onBlur-autosave interleaving that lock exists to prevent comes back. Reasoning in
  `.claude/rules/frontend-performance.md`; the offline queue path is deliberately still per-item,
  since no network is involved.
- **Stock Count includes sub-recipes; `MonthlySummary.js` excludes them** (`.eq('is_sub_recipe', false)`). Both are deliberate — Stock Count physically counts prep — but it means the two pages' COGS for the same month differ by exactly the sub-recipe amount, with nothing on either page saying so. Left as-is; if this is ever reconciled, it is a product decision about which figure "COGS" names, not a bug fix.

### Stock Count and Stock Report: what a 0 means, what a requisition is, and what a failed read does (S695)

Three rules from a re-audit of `Stock.js` and `StockReport.js`, each decided with Aashish on
2026-09-08:

- **A Closing Stock of 0 is a COUNT, stored as a `closing_stock` row with `physical_qty = 0`.
  Blank is "not counted" and is no row.** `toQty()` / `isNoRow()` at the top of `Stock.js` are the
  one place that distinction is made — every save path (autosave, Save All, Clear All, the offline
  queue, Pull from last month) goes through them. Before this every save ran `parseFloat(v) || 0`
  and a 0 deleted the row, so "we counted it and there was none" and "nobody counted it" were the
  same fact in the database, and Stock Report valued a counted-empty item at its theoretical
  estimate. On every other field (opening, wastage, staff meal) 0 and blank still both mean "no
  row". Clear All therefore blanks, never zeroes. Consumers that test `physical_qty > 0` treat a 0
  row as uncounted, which is the old behaviour and not a regression; consumers that test
  `item.id in closeMap` (Stock Report, Reorder, Variance, the dashboards) now see it as counted,
  which is the point. The period-close carry-forward already filtered on `IS NOT NULL`.
- **A requisition is NOT a stock deduction.** Issued stock is consumed by the recipes the kitchen
  cooks, and sales × recipe already subtracts that. `StockReport.js` and `Requisitions.js`'s
  over-issue guard both deducted it on top, taking every cooked-and-requisitioned item off twice
  and blaming "a missing purchase entry". Requisitioned stays a cross-check column on Stock
  Count's Summary. The arithmetic now lives in `stockReportCalc.js` (`buildStockRows` /
  `buildUsageMap`, tested) and runs sales through `selectDepletingSales` like every other
  consumer of theoretical usage — Stock Report had been the one page still summing raw rows, so a
  POS-and-manual day consumed twice and a credit note put stock back.
- **A failed read on Stock Count renders NOTHING below the error card.** Every read there
  destructured `{ data }` and dropped `error`; an RLS refusal or auth stall showed every cell
  blank, and Save All — which writes on-screen state, where blank means delete — then removed the
  server's real rows for every visible item. That is the batch-save shape
  `frontend-performance.md` warns about, on the one page where it destroys data rather than
  misreporting it. The same audit found "✓ Saved" flashing after a refused bulk write (the catch
  records the failure and resolves), Pull from last month never checking its upsert and reading a
  failed read as "never counted", and an offline period switch with no cache keeping the previous
  month's figures under the new label. `persistValue`/`persistValuesBulk` now resolve a boolean
  and the success state is gated on it.

**`explodeRecipeTree()` throws on a failed read (S695).** It used to drop `error` and walk an
empty tree, so every consumer's usage came out as zero — on-hand climbed to opening + purchases,
Variance read as fully under-consumed — with nothing on any page saying a read had failed. Every
page-level caller now wraps it and routes to its own `setLoadError`; the dashboards flag their
section; the write paths (`PosOrders`, `depleteManualSales`, the POS backfill) already ran it
inside a try/catch. A new caller must do the same.

**Variance-style reports must default to a CLOSED period.** Closing stock is counted at month end, so on an open period `closeQty` is 0 for every item, "actual used" becomes everything on hand plus everything bought, and the page paints a red "potential loss" figure on a month that structurally cannot have one. `Variance.js`/`TheoreticalVariance.js` now default to the most recent closed period and, if an open one is selected anyway, say the count is missing and render the figures neutral and unflagged rather than hiding them. `ShrinkageReport.js` and `ReorderReport.js` already did their own version of this.

**And the period a report covers is a fact the page must STATE, not bury.** Across the IMS report
family the scope was written into `.page-subtitle` as prose — "Stock valuation & food cost report —
Bhadra 2082" — so the one thing a reader has to verify before trusting any figure was the last few
words of a 13px `--theme-text2` sentence, styled identically to the description in front of it.
Three pages named no period at all (`BestSellers` said "for the period", `DeadStock` and
`WastageReport` nothing) on reports whose entire claim is period-relative. `PeriodScope` (S659) is
the chip that replaced it, on **29 IMS pages**; `ReportPage` carries it in a `scope` slot. Pass
`provisionalWhenOpen` on any report whose figures are incomplete until the closing count lands —
that is the same set this section's previous paragraph is about. Two pages are deliberately
excluded and carry a comment saying so: `PeriodComparison` (its scope *is* every period) and
`OutstandingPayables` (unbounded — payables carry forward).

### Demand Forecast: revenue is ex-VAT, arithmetic is pure, and an average is not a portion (S694)

**"Revenue" means Σ qty × ex-VAT price everywhere, and a forecast of it must mean the same.**
`buildDailyHistory` in `src/utils/demandForecastMath.js` takes `grossAmt − discount` from
`computeOrderAmounts`, never `.net` (the rounded amount payable *including* VAT). It was the only
caller in the app that hard-coded `vatReg = true`, and the Roster's Labor Forecast divided that
VAT-inclusive figure by a sales-per-labour-hour learned from ex-VAT `sales_entries`, inflating
required hours ~13% on a VAT-registered outlet. Any new consumer of `forecast_revenue` can assume
ex-VAT; any new *producer* of a revenue-like figure must state its VAT basis in a comment.

**The arithmetic lives in `demandForecastMath.js`, which imports no Supabase client;
`demandForecastData.js` is the orchestration around it.** Put new forecast maths in the pure file
— it has a test file, the orchestration file cannot. Three properties the tests pin: the day of
the run is never a sample (a morning recompute would count a partial day as a whole one), a dish
absent from a sample is a zero that day (not a missing sample), and covers/revenue average over
POS-basis samples only (a manual day is "no signal", not zero).

**A per-day average is shown as whole plates on the page, never as a decimal.** `splitDishList`
→ `platesOf` (ceil) for anything ≥ `OCCASIONAL_THRESHOLD`, an "occasional" tail below it; the raw
average and the sample count go on hover. A reader took "0.8" as a portion size. The same applies
to any future per-dish figure: the kitchen makes plates.

**The manual-sales read uses `source.is.null,source.eq.manual`**, the predicate
`persistSalesDay.js` uses, because rows predating the column default read NULL. `.eq('source',
'manual')` silently drops them. And a day present in both POS and manual history is ONE sample —
pass the POS day-key set to `buildManualDailyHistory`.

### On-hand and "below par" have ONE calculation, on six surfaces (S696)

`buildStockRows()` in `src/modules/ims/stockcount/stockReportCalc.js` (tested) is the only place
that turns a period's opening, closing, purchases, returns, wastage, staff meals, sales and recipe
breakdown into an item's on-hand, its par comparison and its shortfall. **Stock Report, Reorder
Report, the Dashboard's Items to Reorder panel and Top Variance table, the Owner Dashboard's Items
Below Par tile, the Monthly Owner Report and Requisitions' over-issue guard all call it.** A
re-analysis of the Reorder Report on 2026-09-08 found five copies, no two alike:

| Surface | Wastage | Staff meals | Sales dedup | Flag |
|---|---|---|---|---|
| Reorder Report | yes | no | raw | at or below |
| Stock Report | yes | yes | shared rule | at or below |
| Client Dashboard panel | no | no | raw | below |
| Owner Dashboard tile | no | no | excluded comps, and NULL-source rows via `.neq` | below |
| Monthly Owner Report | no | no | raw | below |

So the Dashboard tile linked to a report that disagreed with it, and the frozen Owner Report
disagreed with both. Three decisions were put to Aashish in plain words and he took the
recommended option on each: **an item exactly AT par is fine** (par is "the minimum I want on
hand"; being at it is having it — the old `<=` painted the row red with a shortfall of "—" and
printed a line to buy 0.00), **staff meals come off the shelf** (the S551 COGS decision, applied
to on-hand), and **every surface reads the one function**. `summarizeReorder(rows)` is the
count-and-value pair the tiles want. The Monthly Owner Report's `CURRENT_SCHEMA_VERSION` went to
4 for it — no shape change, but a v3 row and a v4 row are not computed the same way.

Three things the same audit found on the Reorder Report itself, each with one right answer:

- **A second edit of a freshly-set par level never saved.** `savePar` threw away the row
  `scopedInsert` returns, stored the par without its id, and the next save on that item went to
  the update path with `.eq('id', undefined)` — which supabase-js sends as `id=eq.undefined`,
  Postgres refuses, and the bare `await` dropped. The screen showed the new value; a reload showed
  the first. The row id is kept now, every failure renders through `ActionError`, and the
  row keeps its previous value. **When a write returns the row, keep what the next write needs.**
- **Between closing one month and opening the next, the page said "Stock is healthy".** `init()`
  loaded nothing when no period was open. It falls back to the latest period now, as Stock
  Report always did, and claims the page through `periodReq.begin()`.
- **Book Stock's tooltip, Help entry, glossary and guide all said "POS only"** while manual Sales
  Entry has written `source = 'manual'` movements since 2026-07-30. A sentence that describes a
  column is a claim about the code, and this one had been false for six weeks.


**Do not write a sixth copy.** The tell is a page that needs "what is on the shelf" and reaches
for `opening_stock` directly — it should reach for `buildStockRows` and read `onHand`.


## A `.neq` on `sales_entries.source` drops the legacy rows, and on Sales Entry it deletes them (S699)

`sales_entries.source` is `text DEFAULT 'manual'` with **no NOT NULL**, so every row written before
the column had a default reads as NULL. In SQL `NULL <> 'pos_comp'` evaluates to NULL, not true, so
a server-side `.neq('source', 'pos_comp')` silently drops every one of those rows — no error, no
tell in the data, just a figure that is short.

**Select `source` and filter in JS.** `ClientDashboard.jsx` and `OwnerDashboard.jsx` both learned
this the hard way and both carry the reasoning at the call site; `persistSalesDay.js`'s `manualOnly`
is the SQL-side equivalent (`or('source.is.null,source.eq.manual')`) for a filter that genuinely has
to run on the server.

**On `Sales.js` it was destructive rather than merely wrong, and that distinction is the rule.** A
report that under-counts shows a low number. An ENTRY page that under-counts loses the row: the
invisible row is absent from the payload the save builds, `findSupersededRows` only inspects the
*opposite* entry mode, and `save_sales_day`'s delete covers `source IS NULL OR source = 'manual'` —
so the next Save Day removed a row nobody had ever been shown. All three of that page's reads
carried it, while `loadSales` (Bulk) had no source filter at all, so one legacy row was visible on
one tab of the page and gone from the other three. `salesReads.test.js` reads the source and fails
on either half of the defect — a `.neq` on the column, or a `select()` that omits it — because
neither has a runtime symptom.

**Still open, deliberately:** ~14 files carry the server-side form (`MenuEngineering`,
`MenuRepricing`, `RecipeMargin`, `Recipes`, `AnnualSummary`, `BestSellers`, `MonthlySummary`,
`Overheads`, `PeriodComparison`, `ConsolidatedPnl`, `OwnerDashboard`'s revenue read,
`useSalesPivotData`, and the two `ownerReport` compute files). Every one is display-only and cannot
delete a row, and each needs its own answer to what its figure is supposed to mean before it is
changed — `OwnerDashboard`'s stock read was fixed in S696 precisely because the answer there was
"comps consume ingredients", which is not the answer a revenue read gives.

**The general shape:** any `.neq`, `.not.eq` or `.not.in` on a NULLABLE column excludes the NULL
rows as well as the named ones. Check `NOT NULL` before filtering negatively in SQL, or filter
positively (`.in(...)`) and let the NULLs fall where you decide.
