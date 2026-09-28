# PLANNING — reorder, dead stock, stock report, FIFO/ageing, demand forecast, and the dashboard's daily forecast + weather

Files reviewed (22): dailyForecast.js, weatherEffect.js, weatherSettings.js, useWeatherDays.js,
useWeatherStrip.js, WeatherCityPicker.jsx, ClientDashboard.jsx (forecast/trend/reorder/rain sections
222-249, 395-850, 1270-1355), weather-forecast/index.ts, migrations 20260923110000 / 20260923130000 /
20260918100000 (ims_monthly_periods_guard), ReorderReport.js, reorderPacks.js, stockReportCalc.js,
salesDepletion.js, StockReport.js, DeadStock.js, deadStockCalc.js, computeInventoryDeadStock.js (verdict
wiring only), stockAgeingCalc.js, StockAgeing.js, FifoReport.js, DemandForecast.js, demandForecastData.js,
OwnerDashboard.jsx (reorder tile). Skipped: WeatherStrip.jsx/WeatherHeaderSlot.jsx rendering, the
dailyForecast/weather test files, demandForecastMath.js beyond the holiday and buy-list functions.

### PLANNING-1 [P2] Demand Forecast trains on at most 1,000 bills — the OLDEST third of its 12 weeks — and stores/reads more rows than it can
- Where: src/utils/demandForecastData.js:31-37 (pos_orders), 163-166 (delete), src/modules/ims/stockcount/DemandForecast.js:194-197 (stored read)
- What happens:
  (a) The 84-day `pos_orders` read is a bare `scopedFrom(...)` with no `fetchAllRows`, no `.order()`.
      Any till doing more than ~12 bills a day (1000/84) is truncated; with no ORDER BY Postgres
      returns scan order, i.e. roughly the oldest bills. The forecast then averages ~25 days from
      two to three months ago, `history.length < 42` sends it to the manual fallback (which adds
      nothing for a POS-only client, `source = 'pos'` rows are excluded), and plates, covers,
      revenue, "Ingredients to buy" and Roster's Labor Forecast (reads `demand_forecast_daily`) are
      all built from stale, partial history with no error. `pos_order_items` right below it IS
      chunked and paged, so only the parent read was missed.
  (b) One row per day plus one per dish seen in the samples: 30-day horizon × 40 dishes = 1,230
      rows. The page's read `scopedFrom('demand_forecast_daily').eq('horizon_days', horizon)` is
      unpaged and has no unique tiebreak, so the later days lose their dishes (or vanish) and the
      30-day buy list under-reads.
  (c) Clearing the previous run is `.not('id', 'in', '(<every new id>)')` — ~1,230 uuids (~45 KB)
      in the URL on a 30-day run, ~290 (~10 KB) on a 7-day run with 40 dishes. Past the proxy
      limit this is the 414 frontend-performance.md describes; the new rows are already inserted,
      the delete throws, the old run stays, and every Recompute adds another full set. `loadStored`
      then overwrites per key in whatever order rows arrive, so which run shows is arbitrary.
- Evidence: `scopedFrom('pos_orders', clientId, 'id, covers, closed_at, credit_note_id').eq('status','billed').eq('close_type','paid').gte(...).lt(...)` — no paging;
  `.not('id', 'in', \`(${newIds.join(',')})\`)`.
- Status: missed by S694 and S756 (S756 fixed three other defects on this page)
- Fix: page `pos_orders` with `fetchAllRows(... .order('id'))`; page the stored read with
  `.order('id')`; replace the id-exclusion delete with a run id column (insert with `run_id`, delete
  `.neq('run_id', newRunId)`) or `runChunkedByIds` over the OLD ids read first.
- Confidence: (a)(b) Confirmed. (c) Confirmed shape; the exact 414 threshold is the gateway's —
  confirm with one 30-day Recompute on a 40-dish client and a `count(*)` of `demand_forecast_daily`.

### PLANNING-2 [P2] Dashboard live sales/purchase forecast counts today's half-finished POS day as a whole day
- Where: src/pages/dashboard/ClientDashboard.jsx:715-719, 775, 785-790; src/modules/dashboard/dailyForecast.js:141-166
- What happens: POS stamps `sales_entries.bs_day = today.day` at every bill close
  (PosOrders.jsx:2943). From the first bill of the day `lastActualSalesDay` = today and
  `elapsedDay` = today, so `projectMonth` (a) judges the month's pace with today's partial sales as
  a full sample and (b) projects from `lastActualSalesDay + 1` = tomorrow, so today's remaining
  trade is never forecast. On a 30,000/day outlet at 10 a.m. with 2,000 sold: day 1 pace factor 0.77
  (every remaining day −23%), day 3 −16%, day 10 −7%, plus ~28,000 missing for today. Purchases:
  `elapsedDay` = today (driven by POS sales), so today is a ZERO-purchase day until the restock bill
  is typed (CASA's ~12,800 Sunday restock) and today's purchase expectation vanishes. The measured
  rainy-day effect also takes today's partial sales as a sample (salesDayLog). Demand Forecast
  already has the rule "the day of the run is never a sample" (ims-figures.md, S694).
- Status: NEW (S780/S783/S784)
- Fix: while `period` is today's month, drop `bsToday.day` from `expectDays` and the day log, and
  project from `bsToday.day` (show today's actual beside today's forecast).
- Confidence: Confirmed

### PLANNING-3 [P2] A new client's frozen Target can be captured from a partial day and stays wrong all month
- Where: ClientDashboard.jsx:756-766; dailyForecast.js:119-129 (`baseFromMonth`)
- What happens: with under 14 history days the Target is built from the month itself at 7 entry
  days (sales) / `elapsedDay >= 7` (purchases) and captured on the first dashboard load that sees
  it — for a POS client, day 7 as soon as its first bill closes. Seven samples give each weekday
  ONE sample, so today's weekday sales Target = the morning's takings (2,000 instead of 30,000) and
  its purchase Target = 0 if the bill is not yet typed. Frozen by design, so that weekday's dotted
  line and every above/below-target arrow on it is wrong until the month ends.
- Status: NEW (S780/S783)
- Fix: same exclusion as PLANNING-2 — only completed days feed `baseFromMonth`.
- Confidence: Confirmed (new POS clients, and any client whose history window has < 14 entry days)

### PLANNING-4 [P2] Dead Stock ignores staff meals and wastage as movement — staff rice reads "Dead, write it off"
- Where: src/modules/ims/stockcount/deadStockCalc.js:42-53, 60-70, 87; DeadStock.js:117,174;
  src/modules/ownerReport/computeInventoryDeadStock.js:97-109 (frozen Owner Report, same calc)
- What happens: `used` = `computeUsed()` = opening + purchases − returns − wastage − staff meals −
  closing, the residual AFTER staff meals and wastage, and a month is "still" when that is 0.
  Rice/dal used only for staff meals: opening 20 kg, bought 30, staff meals 30, counted 20 → used 0
  → still; three such months → Dead, Value at Risk 20 kg, and after four "Write it off as wastage —
  nothing has been used for 4 months" while staff eat 30 kg a month. Slow has the same hole
  (staff meals 120 of 150 available, residual 2 → 1.3% → Slow, "Buy less next time"). D20 says Dead
  = "no movement"; staff meals are consumption (S551), and DeadStock.js:117 says so in a comment.
- Status: missed by S756 (D20's "movement" not met)
- Fix: judge still/slow on outflow = available − closing; keep `used` for the column. OQ-1.
- Confidence: Confirmed

### PLANNING-5 [P2] Stock Report's Export and Print are not gated on the load, and the sheet has no letterhead or scope
- Where: src/modules/ims/stockcount/StockReport.js:162-189, 212-213
- What happens: both buttons are live while `loading` and after `loadError`. During a period change
  the previous period's rows export under the new period's filename/print title (S728); after a
  failed read an empty sheet is saved as a report. The sheet is a bare `json_to_sheet` — no name,
  period, open/provisional marker or filter scope (`sheetWithLetterhead`, `useBizInfo` gating).
- Status: missed by S756 (2e fixed this on Reorder/Ageing/Dead Stock/FIFO; Stock Report not listed)
- Fix: `disabled={loading || !!loadError || !rows.length || !!biz.error}` on both; letterhead + scopeLine.
- Confidence: Confirmed

### PLANNING-6 [P2] Owner Dashboard "Items Below Par" shows a count its reads could not compute
- Where: src/pages/dashboard/OwnerDashboard.jsx:236-302, 758-768
- What happens: a failed reorder read or recipe/option walk only raises a page-top banner; the tile
  still renders `reorderStats?.count ?? 0` with "Full Report →". Without usage on-hand climbs to
  opening + purchases, so it is an under-count or 0 — the zero the owner wants (S734 "a zero nobody
  computed"). Its tip says "at or below par", contradicting S696 (below only).
- Status: missed by S756/S734
- Fix: keep `reorderStats` null on any failure and render "— count unavailable, open the page"; fix the tip.
- Confidence: Confirmed

### PLANNING-7 [P3] The "frozen" Target is writable by any same-client login, for any month, with any content
- Where: supabase/migrations/20260918100000_ims_integrity_s756.sql:314-341; ClientDashboard.jsx:749-754
- What happens: `ims_monthly_periods_guard` exempts both snapshot columns for every caller (so a
  staff viewer's capture lands); "replace only an older model" is only the browser's
  `.or(staleSnapshotFilter)`. Any IMS staff or POS PIN login can PATCH the current Target mid-month
  over REST. `isCurrentSnapshot` checks model and length, not that entries are numbers.
- Status: NEW (left open deliberately in S756; display-only impact)
- Fix: BEFORE UPDATE: a snapshot column may change only when OLD's `->>model` is NULL or older.
- Confidence: Confirmed (policy reading)

### PLANNING-8 [P3] Stock Report paints the previous month's count, NPR total and negative-stock banner during a reload
- Where: StockReport.js:249-253, 269
- What happens: neither is gated on `!loading` (S616/S721 "gating the stat-grid is not gating the page").
- Status: missed by S756 · Fix: gate on `!loading` · Confidence: Confirmed

### PLANNING-9 [P3] Small ones
- ReorderReport.js:734,770 — printed Par Sheet / Reorder List date is `new Date().toLocaleDateString('en-GB')` (AD, viewer clock); page-layout.md wants `nepalDateAd`/BS on a printed slip.
- StockReport.js:92 and StockAgeing.js:162 seed the recipe walk with an unpaged `scopedFrom('recipes','id')` (bites past 1,000 recipes incl. sub-recipes: dishes past the cut consume nothing).
- ClientDashboard uses `getBsToday()` (viewer clock) for `isCurrentMonth`/`capturedDay` while the weather code uses `nepalCivilDate`; an operator abroad near midnight sees the month boundary a day off.

## GAPs
1. Par is typed in the base unit (grams/ml) with no pack helper — an owner who thinks in sacks types "2", sets par to 2 g, and the item never flags. The shortfall shows packs; the par box does not.
2. Reorder "Est. Value" is shortfall × rate, but the list tells staff to buy whole packs rounded up; the money actually spent is higher than the total printed (see OQ-2).
3. The Reorder list groups by category, not by supplier, and cannot become a Purchase Order — an owner who orders by phone per supplier re-sorts it by hand.
4. Two "what to buy" lists that never meet: Reorder Report (par − on hand) and Demand Forecast's Ingredients to buy (forecast use − in store). Nothing says which to follow.
5. The dashboard's frozen Target cannot be reset by the owner after a bad capture (PLANNING-3) or a festival week; it only changes with a new model version.

## Owner questions
- OQ-1 (PLANNING-4): Should food thrown away count as "moving" on Dead Stock? (a) staff meals and wastage both count — Dead means it truly sat; (b) staff meals count, wastage does not — an item that only ever gets thrown away is still flagged, with "buy less"; (c) neither (today). Recommend (b).
- OQ-2 (GAP 2): When whole packs cost more than the exact shortfall, which total should the list show? (a) the cost of the whole packs you will buy; (b) the exact shortfall (today); (c) both. Recommend (a), shortfall on hover.
- OQ-3 (PLANNING-2/3): How should the dashboard treat today? (a) leave today out of the pace and forecast it in full, showing sales so far beside it; (b) count today only after closing time; (c) as today. Recommend (a).

## Checked and fine
- weather-forecast Edge Function: caller must be admin or `active_client_id || client_id` = body client_id (a missing profile fails closed); coordinates only from `settings`, Nepal bounds checked twice (CHECK + function); 05:45–23:45 NPT = 00:00–18:00 UTC window correct; an incomplete row never overwrites a complete one; MET failures back off and never 500.
- `weather_locations`/`weather_daily`: RLS on, no policies, all client grants revoked, service_role only, asserted in the migration.
- City writes: `weather_city_rank` (Owner/admin/any-module manager, never a count PIN, COALESCE-wrapped), `rain_sales_pct` Owner only; browser `canEditWeatherCity` mirrors it. A hostile `weather_city` string only renders through React and cannot move coordinates (CHECK). The rain adjustment is gated on `weather_forecast` (S786 review holds).
- `adDateOf`/`adDateBack` use `formatAd`; `dayNumber` UTC-day arithmetic is timezone-safe; `historyWindowDays` uses `daysInBsMonth`, handles the Baisakh year wrap, reads paged with `.order('id')`; a failed history read captures no Target; `staleSnapshotFilter` keeps the `is.null` arm; a month with no bills gets no purchase forecast or month-built purchase Target.
- D18 reorder packs: rounds up with an EPS, only when conversion_factor > 1 and a purchase unit is named; print, WhatsApp and Excel all carry it; Excel keeps numeric columns.
- ReorderReport: export/print/WhatsApp gated on `figuresReady`, letterhead + scope, KPI strip / no-par tip / count gated on `!loading`, "Stock is healthy" only when every item has a par, savePar keeps ids and reports failures, page guard supervisor = `par_levels` DB rank; `par_levels` unique on (client_id, item_id).
- buildStockRows: staff meals and wastage deducted, comps consume, `pos_credit` never restocks, at-par not flagged, customization deltas passed on every caller (Reorder, Stock Report, both dashboards, Owner Report, Requisitions, Demand Forecast).
- StockAgeing / FIFO (D19): rolling 12 months, closed-month counts anchor quantities, basis stated on screen/print/Excel, `selectDepletingSalesAcrossPeriods`, `begin()` in init, isCurrent in the walk's catch, print/export gated, unknown-age floor, off-window returns consumed in their month.
- DeadStock (D20): 3 consecutive counted still months; uncounted / inconsistent / absent counted and named; KPIs and chips gated on `!loading && !loadError && assessable > 0`; export gated on biz.error.
- Demand Forecast (D21): past holidays skipped as samples (`forecastByWeekday`), buy list shows use / in store / to buy with an unknown shelf kept as unknown, past days dropped from "next N days", horizon guard.
