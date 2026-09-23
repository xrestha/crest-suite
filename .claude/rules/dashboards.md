---
paths:
  - "src/pages/dashboard/**"
  - "src/modules/dashboard/**"
  - "src/modules/hr/dashboard/**"
  - "src/pages/Dashboard.js"
---

# Dashboards: Client, HR, Owner, Group, Admin overview, and the P&L beside them

Rule statements only (S772). Each section's original story, word for word, is in `docs/rules-archive/dashboards.md` at the anchor on its History line. Read it before reversing a rule.

## Separate dashboards, deliberately not merged

- `/dashboard` (`ClientDashboard.jsx`, no plan gate) is the quick glance. `/hr/dashboard` (`HrDashboard.jsx`, `ModuleGate` only, and the page redirects below supervisor) is the working HR console: an Approvals row (Leave/OT/TADA/Swap pending, S330), queue tables you act on, SSF breakdown, advances. `/owner-dashboard` (`OwnerDashboard.jsx`, `SuiteGate` inside the page, Crest Suite Pro) is the cross-module view: margin %, labour cost % (HR wages over IMS revenue, computed nowhere else). It is IMS+HR only; POS is Phase 2. Don't merge them without reading the history.
- At 2+ modules (`showModuleHeaders`) the `.dash-3col-*` columns (`Layout.css`) stay equal, all `1fr`. Balance density by card count, never by column weight (S438 weighted them, S439 reversed it): IMS's top row is 5 money cards (Net Purchases, Revenue, Food Cost%, Net Margin%, Wastage Value) beside HR's 4 and POS's 4, and the 6 reference cards (Active Period, Items, Vendors, Recipes, Menu Health, Fixed Costs%) plus every chart and table go full width below the grid.
- The split layout and the 1-module single-column layout compose the same extracted JSX (`imsChartsAndTables` and the card variables). Never fork a second copy of a card.
- A count shown on both ClientDashboard and HrDashboard reads one hook, `useHrApprovalCounts` (`src/modules/hr/dashboard/useHrApprovalCounts.js`), never two queries.
- Sales Breakdown renders the manual and POS Category × Day pivots side by side (`PivotTable`, `src/components/PivotTable.jsx`; data from `useSalesPivotData.js` in `src/modules/dashboard/`; `SalesPivot`'s `title` prop is "Manual Sales by Category" / "POS Sales by Category"). The two never tie out. `loadFromSalesEntries` excludes `source` `'pos'` and `'pos_comp'` rows, because `PosOrders.jsx` stamps POS bills into `sales_entries` and showing both pivots would count that revenue twice.
- Sales Mix buckets combined manual + POS revenue by the real `recipes.category`, one slice per category present, excluding `'Sub-Recipe'`. That is valid only because `Recipes.js` makes category a `<select>` (`recipeCategories`, client-customisable, default `['Food','Beverage','Dessert','Snack','Other']`), not free text. Food and Beverage keep fixed green/purple; other categories take a fallback hex rotation. Every dashboard chart is `ChartCard`-wrapped (S488); hook file names predate the S487 rename and stay.
- Kitchen/bar `pos_team` (station) accounts get no POS sales breakdown (`showPos && !posIsStationTeam`). A station login with IMS and sales access still sees the Manual pivot, on purpose (S774): it can already open Sales, so the pivot shows it nothing new.

Why: each page is a different altitude behind a different gate, and weighted columns read wrong in live use.

History: docs/rules-archive/dashboards.md#s439-three-dashboards

## A `.neq` on `sales_entries.source` is a silent undercount

- Select `source` and filter comps in JS, never a server-side `.neq('source', 'pos_comp')`. ClientDashboard's trend read and `loadStats`, and OwnerDashboard's reorder and revenue reads, all do this. Full rule, including why the same defect DELETED rows on `Sales.js`: `.claude/rules/ims-figures.md` (S699).
- A known defect on a denominator is not the same size as one on a figure. A short revenue base makes Food Cost %, Labor Cost % and Prime Cost % read HIGH and True Net Margin % read LOW, four verdicts wrong in the direction that alarms. When one is left open, say what divides by it (OwnerDashboard's revenue read stood open three sessions until S734).

Why: `NULL <> 'pos_comp'` is NULL, so legacy rows dropped out of revenue only, leaving a short denominator under a full numerator.

History: docs/rules-archive/dashboards.md#s734-nullable-source-undercount

## Daily Purchases vs Sales: actual, live projection, frozen Target

- Each metric has three series: the actual line, a live forecast (`salesProjection`/`purchProjection`) and a frozen Target. All the arithmetic is in `src/modules/dashboard/dailyForecast.js` (S780), pinned by its test. Never make the forecast remember, or the Target follow the data.
- The Target comes from the 28 days before Day 1 of the open month (`loadForecastHistory`, the previous two periods). Both metrics are an average per weekday, each over its own week (S783). Sales: over the days with an entry. Purchases: over every window day, a day with no bill counting as zero. Never shape purchases after sales: CASA sells most on Saturday and buys most on Sunday. It has under 14 days of history → built from the month's own first 7 days (`source: 'month'`). The forecast = that weekday base × a pace factor weighted `n/(n+3)` toward this month. Never reintroduce a slope or a ceiling: S780's least-squares fit ran to zero by day 14, and its 1.25× cap became the purchase forecast.
- The snapshot is `monthly_periods.sales_projection_snapshot` / `purch_projection_snapshot` (jsonb `{model, source, byWeekday[7], sampleDays, capturedDay, projectedMonthEnd}`). `SNAPSHOT_MODEL` is per kind (`{ sales: 2, purch: 3 }`), so a shape change to one never replaces the other's frozen Target. It is a best-effort capture guarded by `.or(staleSnapshotFilter(kind, col))`: `->>model` is null OR not the current model. Both arms are needed, because a `neq` alone drops NULL rows. `isCurrentSnapshot(kind, snap)` hides an old one still in `dashboardCache`.
- A failed history read captures NO Target: it would lock one week of the month in for the whole month. The footer says so (`forecastHistoryFailed`).
- **Rain adjusts the SALES forecast only (S784, `weatherEffect.js`), never purchases and never the Target.** The Owner's `settings.rain_sales_pct` scales a rainy day (≥ 5 mm, a `complete` day, 05:45–23:45) within 7 days of today and of the forecast's fetch date (`forecastAd`), through `projectMonth`'s `dayFactor`, which must also scale the elapsed days or a wet week is counted twice. The weather is its own hook (`useWeatherDays`), applied at render from `salesForecastInputs`; never await it in `loadStats`. The measured effect is shown, never applied. Wherever weather shows, the MET Norway / CC BY 4.0 credit shows.
- **The header's weather strip (S785, `WeatherStrip.jsx`) is for every client with the flag and a city, any module**, so `useWeatherDays` is not gated on IMS; only the rain adjustment is, through `salesForecastInputs`. Its words come from `weatherLook()`, whose "Rain" starts at `RAIN_MM`, and its "×N%" tags are exactly `rainForecastDays`, so the strip, the line and the footer cannot disagree about which days dip; the tags show only to a viewer who sees that chart. The strip is ready only when one of its own four days has a row (`stripHasForecast`); otherwise it says "Weather unavailable right now", never four blank days. Today's rain and high/low stay the pre-opening forecast; only its sky and thunder follow later fetches. `/settings` is an IMS route, so a POS-only or HR-only Owner's city is set by an admin.
- A migration file in the repo does not prove it is live. `20260814130000` was not applied until S753 (2026-09-14); a month of `PGRST204` failed saves was found only in a browser console. Check the live database.
- The Target is a third, distinct hue (`DAILY_TREND_COLORS.salesTarget` / `purchTarget`, blue/orange), never a dash variant of an existing series' hue.
- X-axis ticks show the BS weekday initial under each day number (S/M/T/W/T/F/S, Sunday first, duplicate letters intended) through a custom Recharts `tick` using `bsToAd(...).getDay()`.
- The tooltip arrow on the actual rows is shape = fact, colour = verdict, with opposite polarity: above target is green for Sales and red for Purchases. The full rule is `.claude/rules/design-system.md`, "A signal colour is a verdict" (S634); don't restate or re-derive it.
- The food-cost band on every dashboard tile comes from the client's own `fc_warning_pct` / `fc_critical_pct` (35/45 are only defaults) via `fcBand()`, with a ✓/△/▲ marker so the verdict is not colour-only.
- A figure containing the prorated labour estimate (Prime Cost %, True Net Margin %) discloses that inline under the number, never only in a hover.

Why: the dotted line is a target precisely because it does not follow the data, and a print or screenshot loses the hover.

History: docs/rules-archive/dashboards.md#s556-frozen-target-line, docs/rules-archive/dashboards.md#s634-three-series and docs/rules-archive/dashboards.md#s780-weekday-target

## `ChartCard`'s expand modal

- The modal panel carries `maxHeight: 'calc(100vh - 48px)'` and `overflowY: 'auto'`, fixed once for all ~9 `ChartCard` charts.
- The modal chart height is the `modalHeight` prop (default `440`, the old hardcoded `renderChart(440)`). A chart with dense chrome passes its own (Daily Purchases vs Sales passes 340). Adjust a shared component per caller through an optional prop; never lower the default for everyone.

Why: a centred `align-items: center` backdrop with a child taller than the viewport overflows at the top and bottom at once.

History: docs/rules-archive/dashboards.md#s556-chartcard-modal-height

## Spend by Category and Top Items share one card

- Top Items by Spend is a second tab on Spend by Category (S556), so Daily Purchases vs Sales takes the freed column. The row is `.dash-spend-purchases-row` (`Layout.css`: `1fr 2fr`, `1fr` at 768px), replacing `repeat(auto-fit, minmax(280px,1fr))`.
- A responsive grid split goes in a CSS class, never an inline style, which a media query cannot override (the same reason as `.dash-3col-*`).
- Tab or view state (`spendView`, default `'category'`) is UI state, never seeded from or written to `dashboardCache`; it resets on remount like `ChartCard`'s `expanded`.

Why: three cards splitting the row evenly starved the chart that needed the width.

History: docs/rules-archive/dashboards.md#s556-spend-by-category-tabs

## Dashboard accessibility

- `ChartCard` titles are real `<h3>`s, and a single-module page gets `.sr-only` `<h2>`s from `moduleHeader()`.
- Every in-card tab row goes through the shared `ChartTabs` (roving tabIndex, arrow keys, `aria-controls` pointing at a real `role="tabpanel"` wrapper). A component rendered twice at once, like the compact card and its expanded modal, suffixes its ids (`idBase` + `big`/`small`) so DOM ids never duplicate.
- The load-error banner carries `role="alert"` and the subscription-expiry banner `role="status"`.
- A KPI grid uses the named `.stat-grid--compact` variant in `Layout.css`, never an inline reimplementation (there were six).

Why: the `/impeccable critique dashboard` run (28/40, S556) found three accessibility gaps, fixed in S569.

History: docs/rules-archive/dashboards.md#s569-critique-and-accessibility

## Sales Mix is a tab on Revenue vs Cost Breakdown

- Sales Mix is the second tab of Revenue vs Cost Breakdown (S557), and `FoodBeverageSplit.jsx` is deleted. `costCardEffectiveView` picks `'cost'`/`'mix'` the way `spendView` does, and `ChartCard`'s `title` switches with it.
- `smallHeight` is 172 only when both tabs exist (`costTabAvailable && mixTabAvailable`), otherwise 140: a card with one view keeps its original height.
- Don't gate a card on module count when a single-module client has the data (the pie once rendered only at 2+ modules).
- `useFoodBeverageSplit.js` (the hook, still in `src/modules/dashboard/`) returns `{ buckets, loading, error }` from its own effect and its own `loadIdRef`, independent of `loadStats`' cycle. ClientDashboard derives `salesMixBuckets` / `salesMixCategories` from it and owns the category fallback colours.
- Sales Mix carries no tier gate, only data-source gates (`salesMixIncludeManual` / `salesMixIncludePos`).
- When deleting a file that other comments cite as a convention, repoint them: `PeriodComparison.js` cites "the Dashboard's Sales Mix", and `OwnerDashboard.jsx`'s colour comment cites ClientDashboard's `COST_BREAKDOWN_COLORS`.

Why: the pie competed for row width the pivots needed, and was hidden from single-module clients who had the data.

History: docs/rules-archive/dashboards.md#s557-sales-mix-tab

## Headline tiles get weight, never hidden siblings; period close from the dashboard

- On a 2–3 module page every HR and POS card renders. The headline tile (Pending Approvals / Revenue / Open Tickets) gets weight only through size (`kpiValueStyle(22, 800)`) and `gridColumn: 'span 2'`.
- Never put a KPI people check regularly behind a disclosure (S558's "Show 3 more" on HR and POS was reverted). Only a tier the page already treats as reference data may collapse: IMS's six reference cards, from the S439 split.
- Period close from the dashboard confirms first, always releases its busy flag, and shows failure. Today `askPeriodClose()` runs the preflights and opens a `ConfirmModal`; `closeAndAdvancePeriod()` calls `performPeriodClose` (`src/pages/periods/closePeriod.js`; see `.claude/rules/owner-report.md`) in a try/finally so `advancingPeriod` always resets, and shows `closeFailureText(...)` in a `role="alert"` that the next attempt clears. A `23505` on the next-period insert is benign (a retried click) and is handled inside `performPeriodClose`.

Why: a KPI dashboard is a 5-second read, and hiding numbers people check regularly is the most-cited progressive-disclosure failure.

History: docs/rules-archive/dashboards.md#s558-period-close-and-disclosure

## Start each dashboard load as soon as its inputs exist

- `loadFcTrend(period, myId)` fires, unawaited, as soon as `period` is known, and folds the open period's id into its own `.in('period_id', ...)` batch instead of waiting for a figure from `loadStats`. A small duplicate read is the price of concurrency.
- `loadStats` fires `independentPromise` (item/vendor/recipe counts and recipe/item/`par_levels` reference data, 8 of the old 15-query `Promise.all`) alongside the period lookup, and `dependentPromise` (the 7 period-scoped reads) once `period` is known. `explodeRecipeIngredients` (up to 5 sub-recipe rounds) starts as soon as `recipes` resolves.
- Never queue a chart's load behind a load it does not need.
- HR, POS and Sales Mix stay separate pipelines, each with its own `loadIdRef` guard against a client switch. Don't fold them into `loadStats`.

Why: FC Trend's ~11-period query started last and popped in after its neighbours' 450ms `chartMotion()` draw-in, which read as jerky; ~4 serial stages became ~2 concurrent ones.

History: docs/rules-archive/dashboards.md#s558-load-decoupling

## The `overheads` buckets: labour is payroll XOR the `labor` bucket

- `Overheads.js` splits fixed costs into `bucket` = `overhead` / `labor` / `tax_fees`, and each consumer picks a different subset, so "the overhead total" means something different on each page.
- Labour is a finalized payroll run XOR the typed `labor` bucket, never both (S756, owner decision D22). `resolveLabour()` in `src/modules/dashboard/labourSource.js` decides it for `ClientDashboard.jsx` and for `Overheads.js` (S756 stage 4), and names the source on the Fixed Costs % and Est. Net Margin % tiles.
- A login that cannot read `hr_payroll_runs` (an IMS staff login on an HR client; restrictive `no_ims_staff` returns `[]`) says labour is unreadable and withholds the verdict. Never fall back silently.
- `OwnerDashboard.jsx` and `computeMonthlyReport.js` read `.eq('bucket','overhead')` only, because both subtract labour separately. OwnerDashboard prefers a finalized run (`finalizedPayrollCost`) over its prorated estimate and names the source on each labour tile. A failed run, payslip or estimate read shows dashes, never a fallback, and a full month's payroll finalized while the month is still running withholds the Labour / Prime / Net Margin verdict.
- Labour from a finalized run is gross + overtime + employer SSF everywhere: `payrollLabourTotal` (`labourSource.js`) on every page, and `get_group_summary` / `get_group_pnl` since migration `20260918170000`. `hr_payslips.gross` is basic + allowances only, so summing it alone drops overtime. Absence deductions are not subtracted; `payrollCashCost` (`src/modules/hr/payroll/payrollData.js`) is the cash-paid figure, a different question.
- `Recipes.js`'s per-recipe True Cost uses `bucket='overhead'` only; labour and tax & fees are never distributed per portion.
- `Overheads.js` sums all three buckets, but a finalized payroll run supersedes its `labor` bucket (S716), the same XOR `ConsolidatedPnl` applies. A page that sums buckets must also see payroll.
- A chart that splits a cost total carries the bucket split (`overheadBuckets` on `stats`; the read selects `bucket` with `amount`), so the pie draws Food Cost → Labor → Overheads → Tax & Fees → Net Margin from one source while `overheadTotal` stays intact for the KPI cards. Never add a second labour figure on top of an all-bucket total.
- Before adding any labour or payroll figure to an IMS page, check whether the overhead figure beside it already contains one.

Why: the two labour sources never announce each other. S526 counted labour twice (the pie totalled NPR 454k against a 401k cost base beside a −57.2% net margin), and before S716 Overheads counted it zero times under "✓ Profitable this period".

History: docs/rules-archive/dashboards.md#s756-overheads-bucket-trap

## `/pnl` is a statement and computes nothing of its own

- `/pnl` (`ConsolidatedPnl.jsx`, `SuiteGate` with `requireModules={['ims']}` inside the page) runs Revenue → COGS → Gross Profit → operating costs → Net Profit for one BS month, each line from the module that owns it.
- Its revenue and COGS come from `periodCost.js`, the functions MonthlySummary calls, so it never becomes a third definition (S774). Its reads must match MonthlySummary's, paging included. The group view's `get_group_pnl` is the SQL copy, kept in step by hand. Detail: `.claude/rules/ims-figures.md`.
- `LINES` is one declaration feeding the single-outlet table, the group matrix and the Excel export. Never write a second label or tip list.
- A grouped owner gets one column per Suite Pro outlet plus a consolidated total via `get_group_pnl()`.
- Labour is payroll XOR the Overheads `labor` bucket per outlet, before consolidating (one branch can run payroll while a sibling types labour). When both exist, the ignored one is named on screen with its amount.
- It defaults to the most recent CLOSED period, because COGS subtracts a closing count. An open period shows a provisional banner, and a period closed without a count gets its own separate warning.
- Colour comes from `lineColor(line, amount)`, which tests `strong && amount > 0` before `line.cost`. Never pass `{ ...l, strong: true }` to add weight; set `fontWeight` (S594 painted every positive consolidated cost success-green, `(NPR 1,240,000)`).

Why: two hand-written copies of a definition drift, and green on a parenthesised cost reads as a credit to an accountant.

History: docs/rules-archive/dashboards.md#s594-consolidated-pnl

## `/owner-report` is a frozen snapshot

- `/owner-report` (`MonthlyOwnerReport.jsx`, `SuiteGate` with `requireModules={['ims']}`) is not a dashboard: it is captured once when a period closes and never recomputed, even if the data is corrected in place later. Its rules are in `.claude/rules/owner-report.md`.

Why: every other page here re-queries the open period on each load; this one keeps what a closed period looked like.

History: docs/rules-archive/dashboards.md#owner-report-snapshot

## Owner-level pages carry a role guard

- `/owner-dashboard`, `/owner-report`, `/pnl` and `/group-dashboard` each run `if (!isAdmin && !isOwner) return <Navigate to="/dashboard" replace />` after their hooks (S601, S617). `SuiteGate` checks `suite_plan` and `ProtectedRoute` a session; neither checks a role. The rule lives in root `CLAUDE.md` and `.claude/rules/access-control.md` ("A page reachable by URL needs the guard its nav item implies").
- The command palette applies every gate a nav entry has. `Layout.js` builds `paletteItems` through the same `isItemVisible` check (`ownerOnly`, `needsGroup`) as the sidebar; before S617 the palette offered `/group-dashboard` on `outlets.length > 1` alone.
- A group RPC's membership test (`my_group_id() IS NULL`) is not authorisation, because every staff account shares its client's `client_id`. `get_group_summary()` checks `COALESCE(is_admin(), false) OR COALESCE(is_client_owner(), false)` first.

Why: restrictive RLS returns an empty read, not an error, so a staff login got a confident wrong page (a P&L at 100% margin). Both S617 holes went unexploited only because no client has ever had a `group_id`.

History: docs/rules-archive/dashboards.md#s617-owner-pages-role-guard

## The Group Console's admin sections

- Below the branch table, Outlet Access and Push master data are Owner/admin only through the page guard.
- Outlet Access (`OutletAccessPanel.jsx`) grants reach, never rank. It reads `get_group_outlet_access()`, the group-wide sibling of `get_client_profile_names()`, because `profiles_select` RLS is self-or-admin. The home outlet renders as a fixed marker, never a checkbox, so nobody can be locked out of their own branch.
- Push master data (`MasterPushPanel.jsx`) always previews before it writes, and the dry run returns exactly the rows the write applies. Its three refusals are in `.claude/rules/multi-outlet.md`: branch purchase rates are never overwritten, selling price is a separate opt-in, and an unmappable ingredient is reported rather than dropped.
- Both panels take their outlet list from the RPC's `rows`, never AuthContext's `outlets`, so the matrix includes outlets excluded from the figures for want of Suite Pro.

Why: access and staffing are not what the group is billed for.

History: docs/rules-archive/dashboards.md#s617-group-console-admin-sections

## MRR is never computed on a dashboard

- Never re-derive a client's monthly value here. `clientMRR` / `clientMrrBreakdown` live in `src/shared/clientMrr.js` (pure over `(client, planPrices)`), shared by `AdminDashboardOverview.jsx` and Admin → Clients (S643), and `clientMrr.test.js` pins every rule. Reasoning: `.claude/rules/access-control.md`, the billed-axis section.

Why: Admin → Clients activates modules and toggles Suite, so it changes MRR and must show the same figure.

History: docs/rules-archive/dashboards.md#s643-mrr-arithmetic

## KPI bands have one definition each

- `fcBand(pct, settings)` (`shared/imsFormulas.js`) bands Food Cost %; `lcBand` / `pcBand` / `nmBand` (`shared/operatingBands.js`) band Labour (30/37), Prime (60/65) and True Net Margin (≥20/≥10) (S660). Never an inline ternary: any page banding these imports them.
- Render `bandFigure(pct, bander).text`, never `bander(pct).color`. The helper appends ✓/△/▲ so a call site cannot keep the colour and drop the shape.
- `canOverheads` gates the FIGURE, not just its colour: without Overheads, True Net Margin stays unbanded and unmarked.
- A shared band needs a shared numerator (S692). `Roster.jsx`'s Labor Forecast reads `lcBand`, and `loadedHourlyRateOf` (`laborForecast.js`) mirrors `computeMonthlyReport.js`'s per-hour estimate, with past days divided by `sales_entries` revenue. Detail: `.claude/rules/hr-payroll.md`. Every estimate charges employer SSF only with `ssf_enrolled` and `ssf_no`: `isSsfContributor()` in `computeMonthlyReport.js` and `OwnerDashboard.jsx`, the same test inline in `laborForecast.js`.
- Sales per Labour Hour has two homes that must mean the same thing (S693): the Owner Report's `ims.revenueTotal / actualHoursWorked` for one closed period (`computeLaborAnalyticsSection.js`), and Roster's Labor Forecast over a trailing 120 days. State their real differences rather than smoothing them: the roster figure uses roster hours where Attendance has not arrived (scaled by a measured bias) and excludes outlier days. If either definition moves, move both.

Why: three of the four were inline copies of the Owner Report's thresholds, and without ✓/△/▲ beside a Food Cost tile that had them.

History: docs/rules-archive/dashboards.md#s693-kpi-ratio-bands

## Say out loud which branch the page took

- A page that branches on a module flag or an error owes the reader the sentence for the branch it took (S683).
- Never render a line from a switched-off module as `NPR 0`. `ConsolidatedPnl.jsx` shows a banner (*Labour is from Overheads only — Crest HR is not enabled*) and names the state on the row; `MonthlyOwnerReport.jsx` lists what `modules_included` left out under its header.
- Every block that depends on a read waits for that read to succeed. `GroupDashboard.jsx`'s KPI strip, table and both admin panels all wait on `get_group_summary` (it once rendered *"Nothing here is a real figure"* above *"No outlets in this group"*, because `rows` is `[]` on failure).

Why: a missing section reads as "nothing to report", and an empty-list message under an error contradicts it.

History: docs/rules-archive/dashboards.md#s683-branch-said-out-loud

## A module section gates on the viewer's rank

- `ClientDashboard`'s `showIms` / `showHr` / `showPos` each need `clientModules.x` (the client bought it) AND `hasXAccess('staff')` (this login may see it). HR employee and payroll tiles also need `hasHrAccess('supervisor')`, because `no_hr_staff_rank` empties those reads for staff rank.
- When a fence is added to a table a tile reads, gate the tile at the same rank in the same change.

Why: the staff-isolation policies return an empty read, not an error, so an HR-only login saw POS Revenue NPR 0, 0 bills, 0 tables as a quiet day (S750).

History: docs/rules-archive/dashboards.md#s750-module-rank-gate

## The getting-started card

- `src/pages/dashboard/GettingStartedCard.jsx` is the only place a new owner is told what to do first (S697). `ClientDashboard` decides WHETHER it renders (IMS empty, meaning no items and no purchases, or the client is on a trial; it also needs `showIms` and an active period). The card decides WHICH lists (Stock & costing always; Staff & payroll and Billing only while their first step is undone off-trial, and until every step is done on a trial) and removes itself when none remain. Keep both halves.
- The card reads its four HR/POS head counts itself, only when rendered. Never fold them into ClientDashboard's main load.
- A failed count withholds that list; `firstError()` does not apply, because this is guidance, not a figure. A list is withheld when any of its counts failed, not only its first step's (S774).

Why: the parent's rule stops a paying client seeing the card every month at `purchaseTotal 0`; the card's rule lets a trial keep its checklist after the first item exists.

History: docs/rules-archive/dashboards.md#s697-getting-started-card

## Vertical rhythm and the KPI card

- `.dash-section` (28px) and `.dash-row` (16px) in `Layout.css` are the rhythm across all five dashboards (S700). A section heading holds 8px above its own content; the 28-to-8 ratio (3.5x), not the absolute gap, makes a group read as a group.
- Both are declared AFTER `.stat-grid` and `.stat-grid--compact`: a grid that is a section takes `stat-grid dash-section`, and a compact pill row that needs a gap below takes `stat-grid stat-grid--compact dash-row`. Move either declaration and both stop working, silently.
- Both zero on `:last-child`, so apply them unconditionally: which block renders last depends on which modules the client bought.
- Both step to 16/8 under 768px, where `.main-content` padding drops 32 → 16.
- A block inside `.dash-3col-*` gets no margin of its own; the grid gap alone spaces the columns (the old `marginTop: 6` / `marginBottom: 14` became a column offset, and 36px on the phone).
- The KPI card is `.stat-card` in a `.stat-grid` (`gap: 0`; its `-1px` margins collapse adjacent borders into one drawn line, and its shadow is dropped), or `.stat-card stat-card--compact` in a strip with a real gap (padding `8px 16px`, no border pull, shadow kept). `.card--compact` (16px) is the matching tier for a whole card, `ChartCard` included. Never type the card's box properties inline (three dashboards had `10px 14px` / `14px 16px` / `12px 14px` against the class's `20px`, and 13 cells drew double rules), and never put a `.card` in a gap-0 grid (GroupDashboard did).
- A loading skeleton uses the same grid as its content (AdminDashboardOverview's was `190px` / 14 / `start` against the strip's `158` / 8 / `stretch`, so the page jumped when data landed).
- Verify a cascade claim by measuring: render the real `Layout.css` and read `getComputedStyle` at 1440 and 390 (the declared compact gutter rendered as 7px, not 8px).

Why: a spacing sweep found 14 distinct vertical intervals against a documented 4/8/16/24 scale, and four section intervals (14/16/20/28) with nothing choosing between them.

History: docs/rules-archive/dashboards.md#s700-vertical-rhythm-and-kpi-card

## KPI tiles: the three shapes S734 found

The sweep covered `/dashboard`, `/hr/dashboard`, `/owner-dashboard`, `/group-dashboard` and the admin overview. Check every new tile for all three.

- **Paging.** For every read behind a tile, ask rows-per-what, and check its neighbours in the same batch. Found unpaged: `pos_orders` in `loadPosStats` (one row per bill, so 40 bills a day pass 1,000 inside a period, while `SalesReport` and `CoversReport` already paged it); `staff_meals` on both dashboards beside a paged `wastages`; and `payable_payments` for Overdue Payables, hung off a paged id list with a bare `.in()`. Chunk such an `.in()`: it is a 414 at a few hundred uuids.
- **Master-data reads are maps.** `items`, `recipes`, `par_levels`, `opening_stock`, `closing_stock`, `vendor_returns`, and `pos_orders` in `useSalesPivotData` are paged too. A row past the cut shortens nothing on screen; it corrupts arithmetic. A missing `recipes` row prices its sales at 0 (Revenue low, every ratio HIGH); `items`, wastage and spend at rate 0 (reads like a good month); `par_levels`, "no par set"; `opening_stock` / `closing_stock`, a zero count (a false over-consumption in Variance). Ask what a missing row does to the arithmetic, not to the list.
- A read left unpaged carries a comment giving its rows-per-what. `overheads` (tens of rows per period) is the only one on these pages.
- **A zero nobody computed.** On a queue tile zero is the outcome the reader wants, so a failed read needs a third rendering distinct from both the good and the loading state: an em-dash plus "count unavailable — open the page". A shared hook RETURNS the failure (`useHrApprovalCounts` returns `error`), because only the consumer knows how its tile says so. (Four discarded `head: true` errors once read "0 · all clear"; the Admin Dashboard showed "0 active · 0 inactive · 0 total properties" over "NPR 0" MRR.)
- **The same metric banded differently.** Use `bandFigure(pct, bander).text`, never `bander(pct).color`. When wrapping a band, e.g. in a settle guard, wrap the whole figure (`verdictFigure` in `ClientDashboard.jsx` returns `{ color, title, text }`), not the hue. A hardcoded 35/45 overrides the client's `fc_warning_pct` / `fc_critical_pct`, not merely duplicates them (`GroupDashboard`'s old `pctColor(v, good, warn)` on (35, 45) food and (25, 35) labour showed 26% labour amber there and green on the Owner Dashboard).
- **A settle guard goes on every lumpy ratio.** `periodTooEarly` (before day 10) greys Food Cost %, Est. Net Margin % AND Fixed Costs % (a month's rent is one row entered on any day), and withholds the ✓/△/▲ mark with the colour.

Why: these were not unrelated bugs but three shapes, each on more than one dashboard, and a tile is the last place a truncation or a false zero is noticed.

History: docs/rules-archive/dashboards.md#s734-kpi-tile-re-analysis

## Two tiles called "Revenue"

- On an IMS+POS client, Inventory's Revenue is `sales_entries` at the ex-VAT, post-discount `unit_price` (it already contains every POS bill, since `PosOrders` stamps a row per closure), and POS's Revenue is `pos_orders.paid_amount`, VAT included; they sit about 13% apart. Neither changes to match: every ratio divides by the ex-VAT base, and a till total must tie to the cash drawer.
- Each names its basis in the subtext (`Sales entries, excl. VAT` / `billed, incl. VAT`), and each tip points at the other.
- Two tiles on one page that share a label must differ in their subtext, not only in their source code.

Why: a reader comparing two numbers assumes the label is the definition.

History: docs/rules-archive/dashboards.md#s734-two-revenue-tiles

## Load guard and settle guard on the Owner Dashboard

- Every dashboard with several loaders has a load-cancellation guard. `OwnerDashboard` passes `myId` (`loadIdRef`) to each loader and re-checks after every await before any setter, including the awaits after the main batch (`payable_payments`, the recipe walk). A single check at the top of the function misses those.
- A page that labels tiles "(MTD)" carries the settle guard (`periodTooEarly`), applied per metric by asking whether the numerator accrues on the same clock as the denominator. Food Cost %, Prime Cost % and True Net Margin % are withheld early; Labor Cost % keeps its band from day one, because it is prorated by elapsed days against revenue over the same days. Greying it "for consistency" would be its own lie.

Why: an admin switching "view as" mid-load let the previous tenant's revenue, payroll and payables repaint under the new client's name, and a day-3 outlet that had just bought the month's rice wore a red ▲ on Food Cost %.

History: docs/rules-archive/dashboards.md#s734-owner-dashboard-gaps
