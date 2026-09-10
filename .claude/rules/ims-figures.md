---
paths:
  - "src/shared/imsFormulas.js"
  - "src/utils/demandForecastData.js"
  - "src/utils/demandForecastMath.js"
  - "src/modules/ims/stockcount/**"
  - "src/modules/ims/reports/**"
  - "src/modules/ims/sales/**"
  # Added S713. Five files here PRINT a banded food-cost figure — MenuPricing, MenuRepricing,
  # MenuEngineering, RecipeMargin, Recipes — and this rule, which is the one that says how, did
  # not load for any of them. check-rules-globs only reports a glob matching NOTHING; every glob
  # above matched real files, so nothing ever said the set was missing the module the rule is
  # most about. MenuPricing then shipped the zero-numerator banding bug documented below.
  - "src/modules/ims/recipes/**"
  # Added S726, and the S713 note above describes it exactly: this file has a whole S719 section
  # titled "The variance family", names `TheoreticalVariance`/`ShrinkageReport`/`WastageReport` by
  # hand, and did not load for any of them. Four directories hold IMS pages and only three were
  # listed. check-rules-globs stayed green throughout — every glob above matches real files, and it
  # can only report a glob matching NOTHING, never a set that is missing a directory.
  - "src/modules/ims/variance/**"
  # The reason list itself (S726). Whoever opens this file is exactly the person about to add a
  # reason, and the two that must never be added are documented at the bottom of this rule.
  - "src/shared/constants/wastageReasons.js"
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
  the Owner Dashboard's hand-written copy of the labour band had done precisely that. `fcFigure()`
  is the same idea for food cost, and `MenuPricing.js` had taken it apart into three one-line
  wrappers (`fcColor`/`fcLabel`/`fcMark`) reassembled at each cell — the shape that makes dropping
  one of the three a one-character edit. It reassembled them correctly and still shipped the bug
  below, because what it got wrong was the argument, not the rendering.

- **A ratio with a zero numerator is not a ratio, and `fcBand` will band it Healthy (S713).**
  `(0 / price) * 100` is a real `0`, `0 <= warn`, and the cell prints **`0.0% ✓` in green** — the
  single most flattering rendering of "we do not know what this dish costs". Menu Pricing showed
  exactly that for any recipe with no costed ingredients and no `cost_price`, sorted them to the
  top of an ascending FC% sort, and exported them to Excel as `0.0%`; its own **+ Add Item** writes
  a recipe with no ingredients, so the page manufactured its own examples. `fcBand(null)` has
  always returned `—` with no mark, so the fix is entirely upstream: **carry the absence as `null`
  from where the figure is computed all the way to the cell.** The first `? :` that defaults a
  missing input to `0` destroys the distinction, and no amount of care at the call site gets it
  back. Worth checking the sorts too — Menu Pricing's New FC % sort already guarded `cost > 0`
  while the cells and the FC % sort did not, which is the tell that the author knew and the
  knowledge did not travel.

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
that is the same set this section's previous paragraph is about. Two pages carry no chip and a
comment saying why: `PeriodComparison` (its table spans a RANGE — 6, 12, 24 or all periods — which
no one-period chip can name) and `OutstandingPayables` (unbounded — payables carry forward). No chip
is not the same as no scope: `PeriodComparison` states its selected range through one `scopeLine`
that reaches the subtitle, the print header, both workbook sheets and the filename (S720).

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


## A document freezes the rate it was made at; a report recomputes (S710)

`items.per_uom_rate` is generated from `items.rate`, and `PurchaseBillPage.jsx` rewrites `items.rate`
on every bill carrying the item. That is exactly right for a report — Stock Report, Reorder, the
valuation columns all want today's cost. It is exactly wrong for a **document**: a store requisition
is printed, signed by whoever received the goods and filed, so a slip that read NPR 4,120 in Shrawan
must not reprint as NPR 4,380 in Bhadra because a supplier put its price up in between. Requisitions
was reading the rate live at render, in all five places it showed money — line value, slip total,
list column, Excel export, printed slip.

`requisition_lines.rate` now captures it at write time, the way `purchase_entries` always has, and
one `lineRate(l)` helper reads `l.rate ?? l.items?.per_uom_rate ?? 0` at every one of those five
sites. Three rules came out of it:

- **The column is NULLABLE and stays that way.** Rows written before the migration have no snapshot,
  and backfilling them from today's `items.rate` would be fabricating a history rather than
  recovering one. They fall back to the live rate, which is what they already did.
- **A correction does not re-snapshot.** Reopening an issued slip to fix a mis-keyed quantity leaves
  `rate` alone — re-pricing it would reintroduce the fault the column exists to prevent.
- **Ask whether the screen is a report or a record.** If a printed copy of it can outlive the figures
  behind it, the figures belong on the row. Requisitions, `purchase_entries` and the frozen
  `monthly_owner_reports` snapshot are all the same answer to the same question.

The over-issue guard on the same page is the opposite case and stays live: it asks "what is on the
shelf right now", so it goes through `buildStockRows()` like every other on-hand figure (S696), with
its inputs paged the way Stock Count pages them — `opening_stock`, `closing_stock`, `staff_meals` and
`vendor_returns` are one row per item per period, and a silent 1000-row truncation there would move
the answer with no error for `firstError()` to catch. `StockReport.js` was swept in the same change
for the same reason; the two must agree about "available" or the warning contradicts the report.

## The summary family: four pages answering one question, three of them differently (S720)

Monthly Summary, Annual Summary, Period Comparison and Budget vs Actual are the nav's
"Summary & comparison" group. They answer *what did this month cost* at four altitudes — one month,
one year, a trend, against a plan — which makes agreeing with each other their entire job. Three of
them disagreed, in two independent ways.

### The bill discount reached three pages out of six

`purchase_entries.discount_amount` is a BILL-level figure repeated on every line of the bill. S601
established that it belongs in COGS and fixed it in `ConsolidatedPnl.jsx`, `MonthlySummary.js` and
`get_group_pnl`. **Annual Summary, Period Comparison and Budget vs Actual were never touched**, so
all three summed a raw `qty × rate` and charged the undiscounted price into COGS and into a column
literally headed *Net Purchases*. The same month's cost was two different numbers on two pages a
client reads side by side, in the direction that flatters nothing: their COGS and FC% ran HIGH.

All six now route through `allocateBillDiscounts()`, and `summaryReads.test.js` pins both the
import and the five columns the helper needs — `discount_amount` plus `purchase_group_id` and the
`vendor_id`/`invoice_ref`/`bs_day` fallback key, which is the `a || b` identity rule from
`vendor-payables.md`: a bill written before grouping existed has no `purchase_group_id`, and a
select that omits the fallback trio silently gives every such line its own bill.

**Monthly Summary's own column was mislabelled the whole time.** `purchaseVal` was fed `lineNet` —
the post-discount figure under a header reading **Gross Purchases** — so `gross − net` read as
"returns" when part of it was the discount, and the Net Purchases cell printed a dash on every bill
that had a discount and no return. Gross, Discount and Returns are three columns now and Net
Purchases always prints, because **a column with a TOTAL under it whose cells cannot be added up to
that total is unreadable** — the `—`-when-equal shortcut is only free on a column nobody sums.

### The paging sweep had never reached the two widest windows in IMS

Every single-period page in the module already pages `opening_stock`, `closing_stock` and
`staff_meals` — Stock Count, Stock Report, Reorder, Dead Stock, FIFO, Stock Ageing, Requisitions,
and the three variance pages S719 swept. The **only** three unpaged sites left were the two pages
that read those tables across **12 and 24 periods at once**, plus Monthly Summary.

The multiplier is the whole finding. One row per item per period × 12 periods crosses PostgREST's
silent 1000-row cap at about **85 items**, not 1000. Past it a month simply arrives with no opening
and no closing stock, which is indistinguishable from an uncounted month: `computeUsed` collapses
COGS to net purchases, the FC% column reports it in confident type, and `firstError()` sees nothing
because truncation returns **no error**. Worse, none of the three reads carried `.order()`, so
*which* months lost their stock differed between loads — the same page showed two different years
on two visits, and neither looked broken.

S719 wrote the rule (*"multiply rows-per-item-per-period by the window length before deciding a
read is safe"*) against a six-period window. These two are twelve and twenty-four. **The pages with
the largest windows were the last ones swept**, which is the same ordering failure S708 and S706
found: a sweep reaches the page it was named after.

### Smaller, and each one live

- **Monthly Summary dropped a category whose only movement was a RETURN.** The activity filter tests
  opening, purchase, closing, wastage and staff meals — the fix that added the last two missed the
  sixth column. Returning goods bought in an earlier period is ordinary (the bill is in Shrawan, the
  spoiled case goes back in Bhadra), such a category has a return and nothing else, and the whole
  row was dropped: `totalReturn` read **"None this period"** beside a real return, and `totalCOGS`
  was overstated by the entire credit.
- **Monthly Summary's food-cost box was banded three ways at once.** S682 routed the *figure*
  through `fcFigure(settings)` and left the box around it and the sentence under it on a hardcoded
  35/45, plus a third scale in the tooltip's "Target: 28–35%". A client on a 30% warning level saw
  a red ▲ figure sitting inside a green box captioned **"✓ Within benchmark (28–35%)"**. One
  `fcBand()` call now drives the tint, the number and the sentence. **When you route a figure
  through a band, check what is touching it** — a tint, a caption and a tooltip are all claims
  about the same threshold.
- **Period Comparison's FC% tooltip still said "Green ≤30%, Amber 31–38%, Red >38%"** while the cell
  colour, the chart's reference lines, its dots and its legend all read `fcT`. The comment beside
  those reference lines celebrates having fixed exactly this drift; the tooltip explaining the
  colour was the copy it left behind.
- **Period Comparison had no overlapping-load guard**, on a page whose only reloading control is a
  closed native `<select>`. Arrowing 6 → 12 → 24 → All starts four concurrent loads; a stale
  *smaller* result landing last leaves `shown` at 24 periods with figures for 6, and eighteen rows
  of `—` that read as "nothing happened in those months". `useLatestRequest` keyed on `limit`.
- **Period Comparison stated a scope it did not have.** The subtitle said "across all BS periods"
  whatever the control said, and the print header and workbook named no range at all — a printed
  six-month sheet was indistinguishable from a two-year one, and the file was always
  `PeriodComparison.xlsx`. One `scopeLine` now reaches the subtitle, the print header, both sheets
  (through `sheetWithLetterhead`, whose `scopeLine` is required for this exact reason) and the
  filename.
- **Annual Summary valued an item deactivated mid-year inconsistently within one row.** `rateMap`
  is built from active items, so its opening/closing/wastage/staff-meals came out at 0 — while
  `grossPurch`/`retVal` read the purchase row's OWN rate and kept counting its spend in full. COGS
  was overstated by exactly the closing value the same row had just discarded. Monthly Summary
  drops such an item from every column; this page now does too. **An `is_active` filter applied to
  a rate lookup and not to the rows it values is not a filter, it is a zero.**
- **Period Comparison's `fmt` dashed a real zero** (`if (!n) return '—'`), so a period with no
  wastage read identically to a period whose figures had not been computed. `nprOrDash` dashes only
  null and undefined — the distinction the rest of the product already draws.
- **Annual Summary's trend column painted a flat month green.** `trend > 0 ? '↑' red : '↓' green`
  renders a green ↓ 0.0pp for a month that did not move. Period Comparison's `trendIcon` has always
  had a 0.3pp dead zone; this column now does too (S634's rule: a verdict needs a dead zone or it
  cries wolf).

### Budget vs Actual: a promise the save could not keep, and spend nothing claimed

- **A failed budget save reached only `console.error`**, under a banner reading *"Budgets are saved
  automatically"*. The spinner cleared, the number stayed on screen, and the client had every
  reason to believe it landed — until they came back next month and found it gone. It now names the
  category through `ActionError`, says the figure is still on screen, and says not to reload before
  retrying, which is true because nothing on the failure path reloads (S716's rule: write the
  sentence and the recovery path in the same edit).
- **Blur fires whether or not anything was typed**, so tabbing across untouched rows upserted
  `amount: 0` for every category it passed through. Only an edited field saves now.
- **Spend on an item with no category fell out of the Actual column AND the Totals row**, silently.
  `items.category_id` is nullable — Monthly Summary already handles this with a synthetic
  Uncategorized row — so the page reported Under Budget on spend it had not counted, and its total
  could not be reconciled against Monthly Summary's Net Purchases. There is an
  **Uncategorised / unbudgetable** row now, counted in Totals and excluded from the variance (there
  is no budget for it to be over or under), which is the S594 rule that a KPI and a total meaning
  different things must both say so.


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

**Still open, deliberately.** Derive the list rather than trusting a count written here — it has
gone stale the moment code changed twice now. The grep is
`grep -rn "\.neq(\s*['\"]source['\"]" src/`, skipping comment lines and `salesReads.test.js`:

```text
Recipes  AnnualSummary  MonthlySummary  PeriodComparison  ConsolidatedPnl
computeMonthlyReport  computeMenuEngineeringSection
```

Re-derived S734, which took **`OwnerDashboard`'s revenue read and `useSalesPivotData`** off it.
Both are worth reading as arguments for shortening this list rather than curating it:

- `OwnerDashboard`'s was the **denominator of an entire KPI row** — Food Cost %, Labor Cost % and
  Prime Cost % all read HIGH against the short base and True Net Margin % read LOW, four banded
  verdicts wrong in the direction that alarms, on the page sold as the one an owner acts on. It
  sat here as a one-line "still open" for three sessions. **When leaving one open, say what
  divides by it** — a defect on a denominator is not the same size as a defect on a figure.
- `useSalesPivotData` carried **two chained `.neq`s** (`pos_comp` and `pos`) feeding the pivot
  titled *Manual Sales by Category* and the Sales Mix pie built from the same loader. So the read
  whose entire job was to isolate hand-entered rows was the one dropping every legacy hand-entered
  row. **A `.neq` whose purpose is to SELECT a subset, rather than to exclude a rare one, fails
  loudest** — check those first.

Each needs its own answer to what its figure is supposed to mean before it is changed —
`OwnerDashboard`'s stock read was fixed in S696 precisely because the answer there was
"comps consume ingredients", which is not the answer a revenue read gives.

**`computeMenuEngineeringSection` is on that list and its LIVE twin is not, which is a defect
waiting rather than a decision.** S715 took `MenuEngineering.js` off for a stated reason — its qty
map sets the period's median, so a dropped row re-quadrants dishes — and every word of that
reasoning applies at least as hard to the frozen owner-report copy, where a wrong quadrant is
**immutable**. The two are supposed to be kept in lockstep; `menuEngineering.js` exists precisely
to keep them there, and this is the one axis it does not cover, because the read lives in each
file rather than in the shared module. Found during the S724 markdown sweep, recorded rather than
fixed because it was outside that session's scope. **`useSalesPivotData` is the other one worth
looking at first**: it chains `.neq('source','pos_comp').neq('source','pos')`, so it drops the
NULL rows twice over.

**`MenuEngineering` came off that list in S715, and why is the useful part.** "Display-only" was
doing too much work: its qty map sets the period's **median**, which is the popularity cutoff, so
dropping the legacy rows did not shorten one column — it could move any dish on the menu into a
different quadrant, and the page then wrote that quadrant back to `recipes.me_class` for the POS
suggestion engine to act on. **Before filing a read as harmless, ask what else its figure decides**:
a number that feeds a threshold, a ranking or a write is not display-only.
`salesReads.test.js` now covers this page alongside `Sales.js`.

**`Overheads` came off it in S716, on a third reading of "display-only".** Its revenue read feeds
no threshold and no write — but it is the **denominator of every percentage on the page**, while the
numerator (food cost, from purchases) comes from a different table and stayed whole. A one-sided
short therefore does not shrink a figure, it **moves a ratio**: Food Cost % and every "% of revenue"
read high, break-even read high, and Net Profit read low — and Net Profit's SIGN is what picks
between a green "✓ Profitable this period" and a red "✗ Operating at a loss this period". So the
question to ask a read is not only what its number feeds, but **what else is divided by it**. A
denominator shared with a numerator the defect cannot touch is never display-only.
`salesReads.test.js` covers this page too.

**The general shape:** any `.neq`, `.not.eq` or `.not.in` on a NULLABLE column excludes the NULL
rows as well as the named ones. Check `NOT NULL` before filtering negatively in SQL, or filter
positively (`.in(...)`) and let the NULLs fall where you decide.

**`purchase_entries.payment_method` is the third (S723)**, on Vendor Balance Confirmation's cash-bill
read — the column every screen renders through `|| 'Cash'`, so a bill written before it existed was
in NEITHER the Credit read nor the not-Credit one and dropped out of a statutory letter's Purchases
total. Detail in `vendor-payables.md`, which already carried the display-fallback half of that rule
(S650's `methodOf`) and was not loaded by the file that broke it.

## `recipes.category` is the second column with that shape, on ten reads (S714)

`category text` — nullable, **no default** — and `.neq('category', 'Sub-Recipe')` is how nine pages
plus a count excluded prep items from a menu list. So an uncategorised dish silently vanished from
Sales Entry, from the POS till's menu (**unorderable**, with no error and nothing to say a row had
been filtered), from HSC code assignment, from Best Sellers, Recipe Margin, Menu Engineering, Combo
Builder, the Dashboard's recipe count, the guest-menu readiness counts, and — permanently — from the
frozen Monthly Owner Report's menu matrix. `recipes.is_active` is the same shape and
`.neq('is_active', false)` appeared on two of those; `.not('is_active', 'is', false)` is the
NULL-safe form (`IS NOT FALSE`), while a category needs
`.or('category.is.null,category.neq.Sub-Recipe')`.

**The SQL side had it right the whole time**, which is the useful part: every guest-menu function
filters `rc.category IS DISTINCT FROM 'Sub-Recipe'`, so the server has always kept those rows and
only the browser dropped them — `AdminGuestMenu.jsx`'s counts claimed to be "exactly the rows
get_guest_menu serves" while measuring a different population. When a filter exists on both sides,
**check the SQL before deciding what the browser meant to do**; `IS DISTINCT FROM` in a migration is
a statement of intent that a `.neq` beside it silently contradicts.

MenuPricing and MenuRepricing already carried the fix and the comment explaining it (S683). It did
not travel, for the same reason nothing else in this file does: a fix reaches the copies someone
opens.

## Menu Engineering: the quadrant is a verdict, so an unknown input must not produce one (S715)

`src/shared/menuEngineering.js` is the only definition of `FC_CUTOFF`, `median()` and
`classify()`. `MenuEngineering.js` and the frozen `computeMenuEngineeringSection.js` both
import it. **`menuFcPct()` and `unratedReason()` moved to `imsFormulas.js` in S724** — three
more reports needed them, and importing a rule from a module named for one report reads as
borrowing that report's helper rather than following a rule; they now sit beside the `fcBand()`
that would otherwise band the zero and the `recipeCostOf()` where the `null` starts.
`menuEngineering.js` re-exports both, so its own callers are unchanged. Before this they each held their own copy, with a
comment on both saying they were mirrored "verbatim" and must never diverge — the shape this repo
keeps re-learning, and the worst possible file to learn it in, because the owner report's section is
**immutable**: a quadrant frozen wrong stays wrong, and nothing in the artifact says which of the two
definitions produced it.

Three properties are load-bearing, each fixing a live defect:

- **`menuFcPct` returns `null`, never 0.** `fcPct` was `sellingPrice > 0 ? cost / price * 100 : 0`,
  and `0 / 400` is also a real `0` — so "not priced" and "not costed" both arrived at `classify()`
  as **0% food cost**, cleared the ≤35% cutoff, and came back **Star** or **Plowhorse** with
  *"Keep on menu. Feature prominently."* beside a green `0.0% ✓`. This is S713's rule one level up:
  there a zero numerator only mis-COLOURED a cell, here it manufactures a verdict — and
  `Recipes.js`'s own **+ New Recipe** creates exactly that state, so the page produced its own
  Stars. `classify()` returns `null` and the caller renders a fifth, neutral **Not rated** bucket
  carrying the reason, which IS the next step ("No selling price set" / "No costed ingredients").
- **`highPop` requires `qtySold > 0`.** The median spans every active recipe including the unsold
  ones, so on a menu where under half the dishes sold in the period the median is **0**, `0 >= 0`
  holds for everything, Plowhorse and Dog become mathematically unreachable, and a dish that sold
  nothing renders as a Star. The in-app guide had promised the opposite "by definition" for a year.
- **The median still spans every recipe, rated or not, sold or not.** Narrowing it would
  re-classify large parts of a menu at once and pull new snapshots away from historical ones for a
  reason nobody asked for. Only zero-sale dishes changed.

`CURRENT_SCHEMA_VERSION` went 4 → 5 for it: no shape change beyond `quadrantCounts.Unrated` and a
nullable `items[].quadrant`, but a v4 matrix and a v5 matrix are not computed the same way, and the
version is the only trace of that a reader will ever have. Every consumer of `quadrantCounts.Unrated`
guards on it, because a pre-v5 snapshot has no such key and an absent count must not render as 0.

### A builder that is never awaited sends nothing, and that is a silent dead feature (S715)

`scopedUpdate('recipes', {…}).eq('id', r.id)` — no `await`, no `.then()` — in a `forEach` over every
recipe. postgrest-js issues the request **inside `then()`** (`PostgrestBuilder.then`), so an
un-awaited builder is an object that is constructed and dropped. `recipes.me_class` had therefore
been NULL for every client since the line was written (commit `e8e3d18`, S210), and POS's Pro-tier
Menu-Engineering suggestion ranking — a feature that is sold, listed in `pricingPlans.js`, and
described in the guide — has never had data to rank on. Nothing failed, nothing logged, and the S470
migration that backfilled `'plowhouse'` → `'plowhorse'` on that column ran against zero rows.

**Grep for a `scopedUpdate`/`scopedDelete`/`supabase.from(...).update(...)` whose statement does not
begin with `await` or end in `.then(`.** A bare builder as an expression statement is always dead
code, and it reads exactly like a fire-and-forget write.

The rewrite is worth copying: one request **per distinct value** (grouped by class, `runChunkedByIds`
because the id list rides in the URL) rather than one per row — a 300-dish menu was 300 concurrent
PATCHes on every period change — and unrated dishes are written back as `NULL` so a dish that loses
its price stops carrying a stale verdict into the till.

**And it writes only from the CURRENT period** (the open one, else the latest). The write-back is a
live side effect on another module; browsing last Shrawan out of curiosity must not re-label tonight's
till suggestions. `computeMenuEngineeringSection.js` had refused to port the write for exactly this
reason while the live page it mirrors did it on every period change.

### `computeRecipeCosts` throws, and four IMS pages never caught it (S715)

S711 gave it `throwFirstError` and recorded that "the callers that already catch it need no change".
Four did not catch it at all — `MenuEngineering`, `RecipeMargin`, `MenuRepricing` and `BestSellers`
— so a failed `items` read rejected the loader's promise **before `setLoading(false)`** and left the
page on its loading state indefinitely: no error card, nothing to retry, no way to tell it from a
slow network. Each now wraps the call and routes to its own `setLoadError`, re-checking
`periodReq.isCurrent` in the catch.

**When you make a shared helper throw, the claim "existing callers already catch it" is a grep, not
an assumption** — and the symptom of getting it wrong is a hang, which no error branch will ever
report.

## The stock reports re-analysed: an as-of date, a window, and what "not counted" means (S717)

Six stock reports (`StockReport`, `ReorderReport`, `StockMovements`, `DeadStock`, `FifoReport`,
`StockAgeing`) went through the same re-analysis the module's other pages have had. Four rules came
out of it, each of which had already shipped.

### `FifoReport` was `StockAgeing`'s unswept sibling, three times over

Same problem (allocate consumption across batches), same data, one page fixed in S594 and the other
not touched since. **When one page in a module is repaired, ask which other page answers the same
question** — the S709 lesson, in the shape it keeps recurring.

- **It aged every batch against `new Date()`, whatever period was selected** — S594's exact bug,
  still live. Opening a month closed three months ago reported the whole month's stock as "expired
  90d ago", turned Value at Risk red over nearly all of it, and highlighted every row. It stated an
  as-of date nowhere: not the subtitle, not a print header (it had no print output at all), not the
  workbook. `asOfForPeriod()` is the twin of `StockAgeing`'s `asOfForFy` — today for the current BS
  month, the last day of the period otherwise — and one `scopeLine` now carries it to screen, print
  and Excel alike.
- **It read ONE period's purchases and netted that period's WHOLE consumption off them.** Two
  errors compounding. A batch bought last month and expiring next week was invisible; opened on day
  3 of an open month it showed three days of purchases under a confident "Items Tracked" — and the
  long-dated stock an expiry report exists for (tinned, frozen, bottled) is precisely what a
  one-month window cannot see. Meanwhile the month's consumption included what came off stock
  carried in from before, so the new batches were over-eaten and exposure was understated. The
  window is now the fiscal year to the selected period, with the opening count modelled as one
  **undated carried-forward batch consumed first** — never displayed, since its whole job is
  absorbing the usage that was genuinely its own.
- **It summed `sales_entries` raw** — the last page doing so, after S695 (Stock Report) and S696
  (Reorder Report) each claimed that title. A day sold in both POS and manual entry consumed its
  ingredients twice, so batches still on the shelf were eaten and simply vanished from an expiry
  report; a credit note (`pos_credit`, negative `qty_sold`) subtracted from consumption and put
  stock back. Both directions live, both producing ordinary-looking rows. `salesReads.test.js` now
  covers all four depletion consumers, and asserts they reach the rule (directly or through
  `buildStockRows`) rather than merely selecting the column.

**`allocateFifo` is now imported rather than reimplemented.** Extra fields on a batch ride through
its two spreads untouched, which is what lets FifoReport hang the `purchase_entries` row off each
batch as `entry`; a test pins that. And it reads **every** purchase in the window, not only the
dated ones — an undated batch is still stock and still absorbs its share, so reading only the dated
ones made them swallow the undated ones' usage.

**`daysUntilExpiry`/`parseDateLocal` live in `stockAgeingCalc.js` beside `ageInDays`.**
`new Date('2026-09-09')` is UTC midnight — 05:45 local in Nepal — so the old
`Math.ceil(expiry - new Date())` returned `-0` for a batch expiring earlier the same day, which is
not `< 0`, so it rendered as in-date. Both sides floor to local midnight now. Same family as the
`.toISOString()` trap, in the other direction: **never compare a bare date string against a local
clock.**

### `DeadStock` treated "not counted" as "counted zero", so an uncounted month reported nothing wrong

This is the most important finding of the six, because of what it said instead. Consumption here is
the periodic residual — `computeUsed()`, i.e. `… − closing` — so the closing count is not one input
among several, it is the only thing separating "we used it all" from "none of it moved". Summing
`closing_stock` with a filter returned **0** for an item with no row, which is the ordinary state of
every item in an open month. So an uncounted item computed as **fully consumed**, failed the Dead
test and the Slow test, and dropped out of the report — and an uncounted period rendered zero rows
under *"No dead or slow-moving stock this period."* The single most reassuring sentence the page can
say, said when it knew nothing at all.

It also conflated the two states S695 spent a session separating: `physical_qty = 0` is a COUNT, no
row is not. Presence is `item.id in closeMap`, as in `buildStockRows`.

Three states now, each with its own sentence: assessed, **not counted** (excluded, counted in an
amber notice, and an empty report says *"This report needs a stock count"* with a link to Stock
Count), and **inconsistent** — counted higher than the stock available to it, which used to clamp
`used` to 0 via `Math.max` and therefore read as **Dead**, the loudest verdict on the page,
manufactured by a missing purchase bill. The KPI strip is gated on `assessable > 0` for the same
reason it is gated on `!loading`: with nothing counted, "0 Dead / 0 Slow" is a finding the page has
not made. **Generally: when a report cannot judge a row, count it and name it — never let it fall
into the same absence as a row that is fine.**

### A shared calculation is only as good as the reads feeding it, and they were not swept together

S696 gave Stock Report and Reorder Report ONE `buildStockRows`. S710 then paged Stock Report's
inputs and left Reorder Report's bare — so the shared function was handed two different pictures of
the same period, and the two pages could disagree about what is on the shelf, silently, past 1000
items. **Unifying the arithmetic does not unify the inputs.** Now paged everywhere they appear:
`opening_stock`, `closing_stock`, `staff_meals`, `vendor_returns`, and two producers S710 missed —
**`items`** (Stock Report, Reorder Report, Dead Stock, Stock Ageing: it is the read that yields the
ids everything else is joined against, and in Stock Ageing `itemById` is what admits a batch at all)
and **`par_levels`** (one row per item per client, and a truncated read turns "below par" into "no
par set" on the page that prints the purchase list). Same shape as S706/S708: the consumer was paged
and the producer was not.

### Smaller, from the same pass

- **`DeadStock`'s `loading` started `false`**, so the first paint — before any read was issued —
  rendered the KPI strip and the "no dead stock" empty state. It also had no `NoPeriodState`.
- **`DeadStock` inlined `computeUsed`'s arithmetic** and its module guide's copy of the formula had
  drifted (no staff meals). It imports the shared one now.
- **`DeadStock`'s per-item `sumField` was a `.filter()` per item per table** — six arrays walked once
  per item. One pass per table instead.
- **`FifoReport`'s recipe-walk `catch` had no `isCurrent` guard**, so a superseded load's failure
  replaced the report the reader was looking at with a red banner.

## `selectDepletingSales` is SINGLE-PERIOD, and two reports were feeding it a year (S718)

The POS-supersedes-manual rule is keyed on **`bs_day`, which is a day NUMBER inside a month** — day
5 exists in every one of them. So the function is only meaningful within one period, and that was a
property of its callers rather than anything the signature said.

`StockAgeing` has always read a whole fiscal year through it; `FifoReport` joined it in S717, when
that session widened FIFO's window from one period to the fiscal year to date and kept the
single-period call. On a client running POS **and** manual entry — the exact population the rule
exists for — a POS sale of a dish on 5 Shrawan suppressed the MANUAL sale of that dish on 5 Bhadra,
four months later; and because a Bulk row carries `bs_day 0` and is superseded by a POS sale
*anywhere in the period*, one POS sale in month one silenced every Bulk row for that dish for the
rest of the year.

**The rule only ever DROPS manual rows, so the error is one-directional**: consumption comes out
short, stock that was actually eaten reads as still on the shelf, and both reports move in the
alarming direction — the 90+ capital figure reads high, expiry exposure reads high. Nothing errors
and no array looks short.

`selectDepletingSalesAcrossPeriods(rows)` partitions by `period_id` and applies the rule inside each
group; both pages now select `period_id` and call it. `ShrinkageReport` had been correct all along
because it needed per-period totals anyway, so the grouping fell out of what it was already doing —
**the correct caller was correct by accident, which is why nothing pointed at the other two.**
`salesDepletion.test.js` pins the collision in both directions and asserts the year-wide form
under-counts (36 against a true 46 on its fixture).

**Generally: when a helper's correctness depends on the SHAPE of what it is handed — one period, one
day, one bill — say so in its own doc comment, because the next caller will widen the window and
the function will keep returning a plausible answer.**

## Stock Ageing: a headline that could only say "all clear", and a KPI that added litres to kilos

Four more from the same re-analysis.

**"Capital in 90+ Day Stock" was structurally NPR 0 with a green ✓ for the first three months of
every fiscal year.** Stock carried into the window is modelled as one batch dated at the window
start — correct, and the page has always disclosed that its true age is a floor — but the *banding*
then treats that floor as a measurement. Two months into a year the window is 60 days long, so
stock that has genuinely sat for three years is 60 days old to this report, cannot reach the 90+
band, and the headline reports no stale capital at all. Same family as S713's zero-numerator food
cost and S715's Stars: **an unknown rendered as a flattering known.** `buildAgeing` now returns
`totals.unknownAgeValue` — carried-forward value that landed in a band younger than the oldest one —
and while it is above zero the card renders `≥ NPR X` with `△`, never the ✓, the note names the
window length and the amount, and the tooltip explains why.

**"Carried Into This FY" summed quantities across items and printed them as "units".** Kilograms of
flour plus litres of oil plus pieces of napkin. The table's own TOTAL row prints `—` in the On Hand
column for exactly that reason, two hundred pixels below — so the page contained both the mistake
and its own refutation. It shows `carriedForwardValue` now. **A quantity does not sum across items;
only value does.**

**The carried-forward batch is valued at the CURRENT master rate**, because it has no purchase line
behind it — while `stockAgeingCalc.js`'s header and the Stock On Hand tooltip both said the report
values every batch "at what you actually paid, not the current master rate". The exception is
unavoidable (nothing in the window records what that stock cost) and `items.rate` is rewritten by
every purchase bill, so the oldest stock on the report — the stock it exists to surface — is the one
line valued on a moving basis. Now stated in the tooltip, the c/f card, the row badge, the workbook
notes and the guide. **An exception that lives in the code and not in the copy is a claim the report
is making falsely.**

**The TOTAL row ignored the filter above it.** It rendered the whole report's figures under a
filtered table, labelled "(all items, by value)" — honest, and useless: a reader who has filtered to
Dairy wants Dairy's total, and a footer that cannot be reconciled with the rows directly above it
discredits those rows as much as itself (the S594 Supplier Contribution lesson). It follows
`filtered` now and says which. The KPI cards stay whole-report by their own documented decision.

Two smaller ones: `init()` did not call `fyReq.begin()`, so changing FY during the first load left
the dropdown snapping back over another year's table — the hook's own contract, and the third page
to miss it after S698 and S709. And the empty state claimed *"every batch bought this year has been
used, wasted or returned"* for a year in which nothing was bought at all; it now distinguishes
"used up" from "nothing to age".

## The variance family: measurability is PER ITEM, and the paging sweep had never reached them (S719)

The four pages in the nav's "Stock & variance" group that S717 deferred — `Variance`,
`TheoreticalVariance`, `ShrinkageReport`, `WastageReport`.

### `hasClosing` is a period-level answer to a per-item question

`measured: false` was introduced in S659 as the way a caller says "no closing count yet", and both
variance pages threaded it from `hasClosing = (closing || []).length > 0` — **does the month have
ANY closing rows.** So on a month where 900 of 1000 items were counted, the other 100 got
`closeQty = 0`, actual usage came out as *everything on hand plus everything bought*, and each of
them wore a full red **Over** flag with a fabricated NPR value behind it — on the page a client
uses to decide whether staff are stealing. Those fabricated values were also summed into
`totalVarianceValue`, so the headline "potential loss" included the shelves nobody had counted.

Both pages now carry `hasCount = item.id in closeMap` per row (a count of 0 is a real count — the
S695 rule, so never `> 0`), pass `measured: hasClosingRows && hasCount` to `varianceBand`, compute
every headline figure over measured rows only, mark the rest **not counted** in the table and the
export, and name them in a banner. **A period-level caveat does not cover a per-item gap**, and the
partial case is the common one: the fully-uncounted month already had a banner, and the
mostly-counted month — which is what an ordinary month close actually looks like — had nothing.

`hasClosingRows` is a LOCAL, not the state value: `setHasClosing` is async, so a row builder reading
the state variable gets the *previous* period's answer.

### The 1000-row sweep had reached `wastages` and `purchase_entries` and stopped there

Every other per-item-per-period read on all four pages was bare: `items`, `opening_stock`,
`closing_stock`, `staff_meals`, `vendor_returns`. The direction is what makes it serious — **a
truncated `closing_stock` read is indistinguishable from an uncounted item**, so it produces exactly
the false Over variance described above, with no error for `firstError()` to catch.

`ShrinkageReport` was the worst case and the least obvious: its window is *several* periods, so
every one of those reads is multiplied by the period count. Six periods × 200 items is 1200 opening
rows — over the cap on a client far smaller than the one that would trip a single-period page.
**Multiply rows-per-item-per-period by the window length before deciding a read is safe.**

### `WastageReport` was the one page that did not page `wastages`

The table is one row per item per **day** once Daily Wastage is used — the rules file names it as
the realistic 1000-crosser, and Stock Count, Stock Report, Dead Stock, Reorder, FIFO and Stock
Ageing all page it. The report whose entire job is totalling the client's wastage was the only
reader that did not, so past the cap its headline came back short in confident type. **A table's
own report is not automatically the most careful reader of it** — it is often the oldest.

Same page: `loading` started `false` (first paint rendered the KPI strip and "No wastage entries for
this period" before any read was issued), there was no `NoPeriodState`, money went through a local
`toLocaleString` rather than `nepalMoney.js`, the Excel export carried no letterhead or scope line,
and the footer's "% of Total" was **asserted as `100%`** rather than computed — true today because
the two sums are identical, and exactly the shape that survives the change which breaks it (the
S594 Supplier Contribution finding).

### And the stale-failure guard, twice more

`Variance` and `ShrinkageReport` both `catch` their recipe walk without re-checking
`isCurrent`, so a superseded load's error replaced the report the reader was actually looking at.
That is now the third and fourth instance after `FifoReport` (S717) — **when a loader has an
`isCurrent` check after its awaits, its `catch` needs one too.**

## Stock Movements re-analysed: a total that added a nested prep item twice (S721)

### The Sub-Recipes tab's Value total double-counted nesting

`computeRecipeCosts` is built on `explodeRecipeIngredients`, so a sub-recipe's cost per batch is
**fully exploded** — a parent's batch cost already contains every child beneath it. The page's own
Cost / Batch tooltip says exactly that ("nested sub-recipes included"). Meanwhile
`explodeRecipeTree` threads ONE `subs` array down the recursion, so `node.subRecipes` is a FLAT list
of every sub-recipe at every depth, each at its own scale — also documented, one function up.

Put those two together and `subRows.reduce((s, r) => s + r.value, 0)` pays for a nested prep item
twice: once inside its parent's row and once on its own. On the repo's own nested fixture — House
Sauce made from Herb Base — that is `0.25 × 80` plus `0.05 × 400` = **NPR 40 against a true
raw-ingredient value of NPR 20**, exactly 2×, in the KPI card, the table footer and the Excel sheet,
while the card's tooltip called the figure "a slice of the raw-item value on the Raw Items tab".

**Neither half was wrong on its own, and both were correctly documented** — the defect lived only in
the addition. `explodeRecipeTree` now reports `topBatches` (the part the DISH reaches directly, at
depth 0), `subRecipeUsage` carries it through as `topValue`, and every TOTAL uses that; the per-row
`value` is unchanged, because "what it cost to make this much of it" is a real and useful figure.
The rows therefore do not sum to their own footer, which the footer's tooltip now states.

**A per-occurrence depth is required, not an "is this ever nested?" flag** — a sub-recipe can be
used directly by one dish AND nested inside another, and only its direct share may be charged.
`subRecipeUsage.test.js` pins both cases, and asserts the total now ties to `derivedItemValue`.

### And four more on the same page

- **The no-BOM banner named recipes whose ingredients are fully configured.** `recipe_ingredients`
  was read with a bare `.in()` over every recipe that sold — one row per ingredient per recipe, so
  ~130 dishes at the project's own ~8-ingredient average is past the 1000-row cap. Truncation lands
  on the wrong side of the comparison: a recipe whose rows fell past the cut is absent from
  `withIngredients`, so the amber banner lists it as having no BOM and sends the owner to Recipes to
  add ingredients that are already there. `firstError` cannot see it, because truncation is not an
  error.
- **`init()` never claimed the page**, and here the consequence is not a flicker. Once
  `handlePeriodChange` has run even once the ref is permanently non-null, so `isCurrent` stops
  failing open — an admin switching client in the top bar re-runs `init()` on a still-mounted
  component with the PREVIOUS client's period id in the ref, and every setter in `loadReport` is
  skipped: the new tenant sees the old period chip over an empty ledger. Fourth instance after
  S698/S709/S718. It also had no fallback to the latest period when none is open, and its KPI strip
  was gated on `!loadError` but never `!loading` (S616's positional rule again).
- **`usage` was never cleared on a period change, and `loading` does not cover it** — the
  sub-recipe derivation is deliberately fire-and-forget, so `loading` goes false without it. The
  reconciliation note therefore compared the OLD period's `derivedItemValue` against the NEW
  period's ledger total and reported a gap in NPR that never existed, under the new month's label.
  It is cleared before the load now, with its own `usageLoading` flag gating the note and the subs
  KPI strip. **A second async source needs a second flag**; one `loading` covering the awaited half
  is not coverage.
- **The Day range filter dropped every Bulk row.** A Bulk manual Sales Entry writes `bs_day 0` and
  the From dropdown starts at 1, so `0 >= 1` removed those rows from the table, all four KPI cards
  and the export, unrecoverably — and on a period whose manual sales were all Bulk it emptied the
  page. The reasoning was already written twelve lines below, as the sub-recipe tab's stated reason
  for refusing the day filter outright. An undated row belongs to no single day, so it belongs to
  all of them.

### `nepalMoney.js` is for MONEY, and a quantity is not money (S721)

S717 and S719 routed quantity columns through `nprInt()`, which is `Math.round` — so a 0.4 kg count
printed as **"0"** in five Dead Stock columns while its own Value at Risk stayed non-zero, and
0.75 kg of wastage printed as "1" on the report whose entire job is saying how much was thrown away.
Both now format with `NPR_LOCALE` and `maximumFractionDigits: 3`, keeping the Nepali grouping.
**Applying a rule past its subject is its own defect**, and this one was introduced by two sessions
that were otherwise tightening the same family.

## The menu-analysis reports re-analysed: a cost of zero is not a cost (S724)

Best & Worst Sellers, Recipe Margin, Menu Repricing and Combo Builder — the four pages that answer
what to promote, what to reprice and what to bundle. S713 fixed the zero-cost band on Menu Pricing
and S714/S715 on Menu Engineering; this pass found it still standing on three of these four, plus
the Dashboard's Menu Health tile, wearing a different mask on each.

### `recipeCostOf()` exists because two lines of arithmetic were retyped at six sites

`src/shared/imsFormulas.js`. Computed cost, else the manually entered `cost_price`, else **null**.
Every site had written it by hand and each got a different amount of it right:

| Site | Before |
| --- | --- |
| Menu Pricing | fallback present, absence collapsed to `0` |
| Menu Repricing | fallback added S713, `|| 0` left underneath it |
| Recipe Margin | no fallback, `parseFloat(costMap[r.id] || 0)` |
| Best Sellers | no fallback, `costMap[r.id] || 0` |
| Menu Engineering (live + frozen) | no fallback |
| Dashboard Menu Health | no fallback, `recipeCostMap[r.id] || 0` |

Two consequences, and they are different bugs from the same zero:

**A dish costed by hand read as costed on the page that created it and free to make on the pages
that rank it.** Menu Pricing's *+ Add Item* writes a recipe with no ingredients and a `cost_price`;
three reports never selected that column.

**A dish with no cost at all became the best thing on the menu.** `0 / 400` is a real `0` and
`(revenue − 0) / revenue` is a real `100`, so the absence arrived at each page as the most
flattering number it can print — `0.0% ✓` green Healthy on Recipe Margin, **100% gross margin** at
the top of Best Sellers' By Margin sort and its chart, and the whole selling price as Contribution
per Portion, which is enough to win Recipe Margin's **Top Contributor** card. `Recipes.js`'s own
*+ New Recipe* manufactures exactly this state on every click.

**S713's rule generalises past the band: a rate computed from a zero numerator is not a rate, and
neither is a margin computed from a zero subtrahend.** Carry the absence as `null` from
`recipeCostOf` to the cell; the first `|| 0` in between destroys it and no care downstream gets it
back. `recipeCostOf.test.js` pins the function and reads all six sources for the two shapes that
were live.

Decided with Aashish (2026-09-10): the row **stays**, the figure is an em-dash carrying the reason,
the row leaves the ranking and the totals, and each page carries a **count** of what it could not
judge — a dash in one cell is not something a reader can total.

### Menu Repricing's silence was the dangerous one

`underpriced = currentFcPct > targetPct`, and an uncosted dish's `0` is never above target. So it
was not merely mis-coloured: it was **absent** — from the list, from Monthly Opportunity, and from
the Underpriced Dishes count — and with *Only underpriced* on by default, a menu nobody had costed
rendered **"No underpriced dishes — every priced dish is at or below its target food cost. 🎉"**.
That is the S612 shape on a page that already guards its load failures against it: the celebratory
empty state is a claim about every priced dish, so it may only be made when every priced dish was
testable. It now names how many could not be, and a fourth KPI card appears only when there is one.

Untick the filter and the same dish printed **NPR 0, in green**, under a column captioned *the
number to print on the menu*.

### A suggested price and the opportunity of taking it must be the same number

`priceGap` was `cost / target − price`; the Suggested Menu Price beside it is that figure grossed up
for VAT and **rounded up to NPR 5**. So repricing to what the page told you to charge captured a
different amount from the Monthly Opportunity it promised. The gap now de-VATs the rounded price —
the one actually being suggested. The Dashboard's Menu Health tile carries the same arithmetic, so
the tile and the report agree to the rupee.

### The Menu Health tile read *healthier* the more uncosted dishes a client had

It renders "N of M" — underpriced of costed-and-priced — and an uncosted dish landed in the
**denominator** while being mathematically unable to reach the numerator. It also filtered
`is_active === false` in JS while the report it mirrors used `.eq('is_active', true)`, and
`recipes.is_active` is nullable (`DEFAULT true`, no `NOT NULL`) — so the tile and the page it links
to were measured over different populations. **One NULL-safe form, not two dialects of it**: both
test in JS now. Same trap as `category`, one column over.

### Best Sellers: two averages, one count, and a Top 10 that was also the Bottom 10

- The chart footer averaged `filteredRows` and printed the count of `rows`, so under a category
  filter the number was the category's and the count was the whole menu's.
- That footer's average is **unweighted** and the Summary strip's "Overall Margin" is
  **revenue-weighted**. Both are legitimate and they disagree by design; neither said which it was.
  They say so now, and the strip's three cost-derived figures cover only the costed dishes, with a
  line underneath saying how many that is.
- `bot10` was `[...sorted].reverse().slice(0, 10)` — the bottom of the whole list — so with 12
  dishes sold, eight appeared in **both** panels, each simultaneously a Top 10 Performer and a
  Bottom 10 Performer. The bottom list starts after the top one now, shows the dish's real rank
  rather than 1..10, and says so when everything sold is already in the Top 10. The module guide
  had recorded the overlap as a gotcha since the page was written; the page never had.
- The Revenue tooltip said `qty sold × selling price`, which is neither what the code does nor what
  migration `20260713065928` exists to make it do.

### Recipe Margin was still pricing a closed period at today's menu price

It never selected `unit_price`. That is the exact defect
`20260713065928_sales_entries_price_at_sale.sql` was written to fix — its comment lists the reports
it covered and Recipe Margin was not among them — so a closed period's contribution silently
restated itself whenever anyone edited a price. It also made **every POS bill discount invisible**,
because `writeSalesEntries` folds a bill-level discount into `unit_price` and never writes
`sales_entries.discount`.

Revenue is now built the way `Sales.js`'s `recipeRevenue()` builds it, and Total Contribution is
`revenue − cogs` rather than `margin × qty`. Those two are no longer the same number, which is the
point: **a price change or a bill discount during the period is exactly the difference between
them**, and the tooltip says so. Contribution per Portion keeps meaning today's list-price margin.

Its footer row also totalled the whole period directly under a category-filtered table. Every total
follows the filter now; the KPI strip stays page-level and says so.

### Combo Builder counted bills that never happened, and bills twice

`get_cooccurrence` (migration `20260910120000`) had three faults, all inflating a pairing:

- **`COUNT(*)` over a self-join counts ROW PAIRS.** Usually one bill has one row per recipe, because
  `addItem` merges by `recipe_id` — except `apply_pos_item_comp`, which deliberately splits a
  partially comped line into a second row with the same `order_id` and `recipe_id`. That bill
  counted 2×, or 4× if both items were split. `COUNT(DISTINCT a.order_id)` is what the column
  header, the tooltip and the module guide had all claimed since it shipped.
- **No filter on the order.** `status = 'open'` bills still being built on a table, and
  `close_type = 'void'` bills explicitly cancelled, both fed the ranking. `close_type = 'paid'` is
  the house definition — `SalesReport` and `CoversReport` both scope that way, and a co-occurrence
  report disagreeing with the revenue reports about which bills exist is a third opinion.
- **The window was on `created_at`.** A bill belongs to the day it was billed.

It also returns `anchor_bills` now, so Frequency means *the share of this dish's own bills* rather
than *relative to the top pairing*, which made the top row a full bar by construction.

**`get_cooccurrence` has TWO callers and the second is a till screen.** `PosOrders.jsx`'s
suggestion engine re-ranks the *goes well with* panel from these counts, so all three faults were
steering a live upsell prompt, not only a report. It reads `paired_recipe_id`/`co_count` by name,
so the added column is inert there — check that again before altering either of those two.

### And the page around it dropped every error it could

Three reads and a write, none checked. `Promise.all(...).then(([{ data }, { data }]) => …)` with no
`error` destructured and no `.catch()`, so a failed recipes read rendered **"No POS-enabled items
yet — toggle items on in Menu Pricing first"**; the RPC — which `RAISE`s on an authorisation
failure — rendered **"needs more bills with this item on them"**. Both are confident instructions to
go and fix something that is not broken.

`saveDiscountPct` was the only `settings` writer in `src/` with **neither** an error check nor an
insert-if-missing branch: `.update(…).eq('client_id', …)` on a client with no settings row matches
nothing and reports success. It follows `PosTableManagement`'s read-then-branch shape now, including
its rule that a failed existing-row read must not fall through into INSERT (S613).

### A Growth feature that cannot work without a module the client did not buy

Combo Builder is sold in the Growth **IMS** list and reads only `pos_orders`/`pos_order_items`. An
IMS-only client could pick an anchor and be told forever that it *needs more bills* — a sentence
describing a fixable shortage when the real answer is that they have no till. Decided with Aashish
(2026-09-10): keep the IMS gate, because removing it takes the feature off a plan people already
bought; the page states what it needs instead of blaming the data.

Same decision added a banded **Combo FC%** column. The page suggested a discount off two menu prices
with no idea what either dish costs — a 25% bundle of two dishes already at 38% food cost prices the
pair past 50% while the row says "Savings" in green. It is also the one page in this module that
suggested a price and did not round it, and quoted it ex-VAT, so it was not what a guest would pay
either; it now rounds up to NPR 5 VAT-inclusive like Menu Repricing's.

### Smaller, from the same pass

- **A blank category tab.** `['All', ...new Set(rows.map(r => r.category))]` with no
  `.filter(Boolean)` on Recipe Margin and Menu Repricing — reachable only since S714 made
  NULL-category recipes visible, which is the tell that a fix can create the next finding.
- **A negative Monthly Opportunity was hidden by the table and summed by the KPI.** A Credit Note
  posts `qty_sold: -qty` into TODAY's open period, so a period's net qty can go negative; the cell
  read `> 0 ? … : '—'` while the card above it added the negative. Clamped at source.
- **`.neq('source', 'pos_comp')` on all three reports.** They were among the ~12
  `salesReads.test.js` left on the server-side form pending "its own answer to what its figure is
  supposed to mean". The answer for all three is that the figure is a **rank**, or the multiplier on
  one — Best Sellers orders the menu and the guide's advice for the bottom of that order is
  *candidates for menu removal* — so a dropped legacy row does not shorten a column, it moves a
  dish. All three joined the suite.
- **`price` on Best Sellers was computed and rendered nowhere**, and Menu Repricing kept three
  separate `fcBand` wrappers of the shape S713 took apart on Menu Pricing. Both gone.
- **Both Excel exports wrote `0.0%` and `NPR 0` for an unknown figure.** Those sheets leave the
  building and get priced against; blank is the only honest cell. Menu Repricing's gains a Status
  column so *not costed* survives the export at all.
- **`<a href="/menu-pricing">`** in Combo Builder, reloading the whole SPA. `<Link>`.
- **No `useLatestRequest` on Combo Builder's pair load** — anchor and window are both one-click
  controls, so overlapping loads were easy and the last response won regardless of the anchor
  selected.

---

## The wastage reason vocabulary is a shared constant, and two reasons must never join it (S726)

`src/shared/constants/wastageReasons.js` is the ONE definition of the Daily Wastage reason list —
19 reasons in six `<optgroup>` headings, plus `DEFAULT_WASTAGE_REASON`. It is a standalone module
rather than an export from `Stock.js` so `imsGuideData.js` can import it without dragging a
route-level lazy page into the settings bundle (S440).

**Nothing validates this column, anywhere.** `wastages.reason` is `text` — nullable, no CHECK, no
enum — and `restoreClientData.js` does not normalise it either. `WastageReport` builds `byReason`
from whatever strings come back, so the constant is not an enforcement point; it is the only thing
standing between the By-Reason breakdown and a pile of near-duplicate spellings. Consequences:

- **Adding an option is free** — no migration, and every row written under the old list still
  displays and still groups.
- **Renaming or removing one is not.** Every row already written under the old string keeps it, and
  the report then shows both spellings side by side forever, with nothing to flag it.

**Two reasons must never be added, because both would deduct the same stock twice.** Staff meal /
Complimentary has its own table, its own tab and its own term in `computeUsed()`; a supplier return
is already netted inside Net Purchases. A generic "stock adjustment" is excluded for a different
reason: it turns wastage into a fudge factor for forcing a physical count to tie, which is the
exact signal Variance and Shrinkage exist to catch. The rationale lives in the constant's header so
it is read before anyone adds one back.

**`'Monthly (untagged)'` is reserved.** `WastageReport.js` keys undated catch-all rows
(`bs_day IS NULL`) under that synthetic label *before* it reads `r.reason`, so offering it as a real
option would merge two different facts into one row of a breakdown that still adds up.
`wastageReasons.test.js` asserts that, plus no duplicate spelling and `'Other'` still present — two
call sites in `Stock.js` fall back to it. All three fail silently in production otherwise.

**A guide that re-types a list is a guide that drifts.** `imsGuideData.js` spelled out all seven
reasons in prose; it now interpolates the count and the group names off the constant, and `Help.js`
describes the shape of the list rather than naming members. Nothing in the build can notice a guide
sentence that disagrees with the product, so the sentence should not be able to.

**Logging a loss moves it out of Shrinkage.** Adding `Theft / pilferage` means any theft a client
records is *explained* and therefore leaves the unexplained gap `ShrinkageReport` measures. That
report's own copy now says "unlogged theft" and names the consequence — the same rule as any other
figure here: the sentence has to move when the arithmetic does.

## The `settings` row is written by nine pages, so a save sends a PATCH, never the row (S730)

`settings` is one row per client, and it is the junk drawer: `Settings.js` owns the thresholds and
code prefixes, `PosTableManagement` owns discount reasons / note presets / ticket routing /
reservation settings / delivery partners, `CoversReport` the opening hours, `TadaSettingsModal` the
TADA rates, `ImsStaff`/`HrStaff`/`PosStaff` the three custom-role schemes, `ComboBuilder` the combo
discount, and the admin drawer the branding. Every one of them reads the row, edits its part, and
writes. **A page that writes the whole row writes every other page's columns as they stood when it
loaded** — and nothing fails: the write succeeds, the toast says saved, and a manager's change on the
till from ten minutes ago is gone. `Settings.js`'s page-level Save did exactly this until S730 (S701
had found the mirror image on the same page, a platform price landing on the client row, and fixed
that one tab).

Three rules:

- **Send only the columns the screen edits, as a diff against the row it loaded** — `PAGE_FIELDS`
  and `pagePatch()` in `Settings.js` are the reference; `saveSettings()` in the context accepts a
  partial and always has. `{ ...settings, one_column: x }` is the same defect wearing a fresher
  snapshot.
- **A re-read after a save must not reseed a form wholesale.** `loadSettings()` runs after every
  save, and a form keyed on `settings` that copies the row over itself wipes whatever was typed on
  another tab. Keep the values that differ from the *previous* seed; replace everything only when
  the row belongs to a different client (`settings.client_id` changes).
- **A threshold with a `|| default` reader cannot store 0.** `fcThresholds`, `varianceFlagPct` and
  FIFO's `expiry_warning_days || 7` all read 0 as "use the default", so a box showing 0 and a report
  banding at 35 are the same stored value. Refuse 0 at the form, store a cleared box as NULL (never
  `''` — Postgres refuses it for `numeric` and `integer`), show the default as the placeholder, and
  check the pair (critical > warning) — `validateThresholds()` is exported for exactly that.

Two smaller ones from the same pass, both about `recipe_code`: **`recipes.recipe_code` is unique
per client**, so any bulk renumber must clear the codes that are about to move before writing the
new ones (a one-pass loop hands row A the code row B still holds and the index refuses it); and **a
sub-recipe's mirror row in `items` carries the same code in `item_code`**, written once at insert
by `Recipes.js` and updated by nothing but Settings' renumber — so a renumber of items must skip
`is_sub_recipe = true`, and a renumber of sub-recipes must write both columns.

## Assigned stock counting: who counts what, and who counted it (S737)

Stock Count can be handed to staff. Four switches, all off by default, gated behind the Growth key
`stock_count_assignment`, configured in **Stock Count → Settings**
(`src/modules/ims/stockcount/StockCountSettings.jsx`, manager-only, its own file because `Stock.js`
is ~1,750 lines and none of this is counting).

- **The section scope is a POLICY, not the screen.** `ims_count_assignments` is staff × category —
  categories are the only grouping `items` has — and three RESTRICTIVE policies on `closing_stock`
  **INSERT/UPDATE/DELETE** call `ims_count_scope_allows(item_id)`. Deliberately **not SELECT**:
  those are the client's own rows, and a per-row subquery on every read is paid on a 1,000-item
  sheet at every page load. `Stock.js` filters the same set for display, so the screen and the lock
  agree — but the lock is what holds, per invariant #3.
- **It fails CLOSED, and that has to be said on screen.** A staff-rank account with scoping on and
  no assignments can save nothing. That is the honest reading of "only their sections"; without the
  banner it is a blank item list under a working Save button. The settings tab also warns by name
  when someone is in that state, because the manager creates it by switching the master toggle on
  before filling the grid.
- **An item with no `category_id` is assignable to nobody**, so a scoped counter never sees it. The
  settings tab counts them and says so rather than letting them vanish.
- **Recount protection is a BEFORE UPDATE OR DELETE trigger** (`closing_stock_guard_recount`),
  SECURITY INVOKER on the `current_user IN ('anon','authenticated')` seam. Only a `staff` rank is
  blocked; supervisor and above correcting a figure is the sanctioned way through, so there is no
  force-path RPC (`vendors`' S708 variation).
- **Blind count is a DISPLAY rule and the UI says so.** It takes Purchased/Returned/Value off the
  Closing tab for a staff-rank counter. The figures still reach the browser; calling it a lock in
  the copy would be the claim `fcBand`-on-a-zero teaches against.
- **`counted_by` is written at last.** It had existed since the baseline and nothing had ever
  written it. It is `uuid` now with a `counted_by_name` snapshot beside it — the FK is
  `ON DELETE SET NULL`, so deleting the account would otherwise erase the attribution and not just
  the link. **The offline queue stamps both at ENQUEUE time**: on a shared tablet the person who
  counted is routinely not the session that syncs.

**The tab set is an INCLUSION map, and that is load-bearing (S737c).** `FIELD_TAB` /
`fieldKeyOf(tab)` at the top of `Stock.js` decide both which tabs render the entry grid and which
stored field each one writes. It was an exclusion list plus four ternaries ending in `: 'wastage'`
until the Settings tab was added, at which point the grid rendered underneath the settings panel
with a Save All button wired to the WASTAGE column — a screen with no quantities on it, one click
from blanking the month's wastage for every visible item. `saveRow`, `performSaveAll` and
`clearAll` now return early on a null field rather than falling back to one. **Adding a tab to
this page means adding it to that map, or it renders no grid** — which is the safe direction.

**PIN login for counters** (`/ims/count`, `ImsCountLogin.jsx`, `ims-staff-login`) is the POS
architecture reused — synthetic `profiles.ims_email` that never reaches the browser, the derived
password from `_shared/pinPassword.ts`, the lockout enforced on the request that signs in. Two
things differ and both are deliberate:

- **Enrolment is inverted.** POS activates a device by pressing a button ON it while signed in;
  a store-room tablet has no such session. The manager displays a QR and the tablet scans it. **The
  QR carries a short-lived token, never `ims_device_secret`** — it is shown in a room with people
  in it, and the secret is what gates the anonymous roster read. Valid 15 minutes, any number of
  devices, revocable.
- **A PIN account is count-only**, fixed at `ims_role = 'staff'`, and the guard is in
  **`ProtectedRoute`** rather than `ModuleGate` — `/dashboard` carries no `ModuleGate` and is
  exactly where a fresh sign-in lands. `shared/imsCountAccess.js` is the one predicate, read by the
  guard, the sidebar and the command palette (the `posTeamAccess.js` shape).

**A new PIN kind is four lists, not one**, and three of them fail silently: `staff_pin_vault`'s
`kind` CHECK, `rederive_pin_passwords`' salt lookup (a wrong salt mints a password no login can
reproduce — it now REFUSES an unknown kind rather than defaulting), `restore_staff_accounts`'
branch plus the `ims_email` column in `exportClientData.js` (they move together, or a restorable
account is reported as unrecoverable), and `log_audit()`'s profiles noise-skip array.

**`ims_count_assignments` is deliberately absent from `RESTORE_ORDER`**, for `legal_acceptances`'
reason: every row keys on `profile_id` and a restore re-creates staff accounts with new ids, so the
rows would either fail their FK or point at whoever inherited the id.
