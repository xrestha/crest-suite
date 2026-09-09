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

**Still open, deliberately:** ~11 files carry the server-side form (
`MenuRepricing`, `RecipeMargin`, `Recipes`, `AnnualSummary`, `BestSellers`, `MonthlySummary`,
`PeriodComparison`, `ConsolidatedPnl`, `OwnerDashboard`'s revenue read,
`useSalesPivotData`, and the two `ownerReport` compute files). Every one is display-only and cannot
delete a row, and each needs its own answer to what its figure is supposed to mean before it is
changed — `OwnerDashboard`'s stock read was fixed in S696 precisely because the answer there was
"comps consume ingredients", which is not the answer a revenue read gives.

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

`src/shared/menuEngineering.js` is now the only definition of `FC_CUTOFF`, `median()`, `classify()`,
`menuFcPct()` and `unratedReason()`. `MenuEngineering.js` and the frozen
`computeMenuEngineeringSection.js` both import it. Before this they each held their own copy, with a
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
