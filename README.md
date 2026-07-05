# Crest Inventory — Project README

**Client:** Aashish Shrestha | **Business:** Crest Hospitality | **Pilot:** Casa Acai Cafe, Kathmandu  
**Stack:** React (CRA) · Supabase (PostgreSQL + Auth) · Vercel · SheetJS · Recharts  
**Repo:** `C:\crest-inventory` | **E Drive Backup:** `E:\CREST INVENTORY MANAGEMENT\`

---

## Quick Start

```bash
npm start        # Dev server → http://localhost:3000
npm run build    # Production build
```

**Env vars required:**
```
REACT_APP_SUPABASE_URL
REACT_APP_SUPABASE_ANON_KEY
REACT_APP_SUPABASE_SERVICE_ROLE_KEY
```

---

## App Overview

Hospitality inventory & food cost management SaaS for Nepal's F&B industry.  
Works natively in Bikram Sambat (BS) calendar · NPR currency · FonePay payment tracking.

### Plans
| Plan | Monthly | Annual /mo | Includes |
|---|---|---|---|
| Starter | NPR 5,000 | NPR 3,750 | Dashboard, Items, Vendors, Periods, Purchases, Stock, Help + Sales Entry, Payment Summary, Monthly Summary, Annual Summary, Reorder Report, VAT Report, Non-VAT Report, Wastage Report, Settings, Stock Report, Menu Pricing |
| Growth | NPR 8,000 | NPR 6,000 | + Recipes, Variance, Budget vs Actual, Best Sellers, Purchase Orders, Requisitions, Dead Stock, Recipe Margin, Outstanding Payables, Staff Meals, Menu Repricing |
| Pro | NPR 12,000 | NPR 9,000 | + Menu Engineering, FIFO, Vendor Report, Supplier Price Tracker, Overheads, Period Comparison, Theoretical Variance, Shrinkage Report |

Starter: 1-month free trial. Annual = 25% off monthly.

---

## Routes

| Route | Plan | Feature Flag |
|---|---|---|
| `/dashboard` | All | — |
| `/periods` | All | — |
| `/items` | All | — |
| `/vendors` | All | — |
| `/purchases` | All | — |
| `/stock` | All | — |
| `/help` | All | — |
| `/pricing` | Public (no auth) | — |
| `/sales` | **Starter+** | `sales_entry` |
| `/payments` | **Starter+** | `payment_summary` |
| `/summary` | **Starter+** | `monthly_summary` |
| `/annual-summary` | **Starter+** | `annual_summary` |
| `/reorder` | **Starter+** | `reorder_report` |
| `/vat-report` | **Starter+** | `vat_report` |
| `/non-vat-report` | **Starter+** | `non_vat_report` |
| `/wastage-report` | **Starter+** | `wastage_report` |
| `/settings` | **Starter+** | `settings` |
| `/recipes` | Growth+ | `recipe_costing` |
| `/variance` | Growth+ | `variance_report` |
| `/payables` | Growth+ | `outstanding_payables` |
| `/budget` | Growth+ | `budget_vs_actual` |
| `/requisitions` | Growth+ | `requisitions` |
| `/dead-stock` | Growth+ | `dead_stock` |
| `/recipe-margin` | Growth+ | `recipe_margin` |
| `/best-sellers` | Growth+ | `best_sellers` |
| `/purchase-orders` | Growth+ | `purchase_orders` |
| `/period-comparison` | Pro | `period_comparison` |
| `/shrinkage` | Pro | `shrinkage_report` |
| `/menu-engineering` | Pro | `menu_engineering` |
| `/fifo` | Pro | `fifo_report` |
| `/vendors-report` | Pro | `vendor_report` |
| `/supplier-prices` | Pro | `price_tracker` |
| `/overheads` | Pro | `overheads` |
| `/theoretical-variance` | Pro | `theoretical_variance` |
| `/admin/clients` | Admin only | — |
| `/admin/audit` | Admin only | — |
| `/stock-report` | **Starter+** | `stock_report` |
| `/menu-pricing` | **Starter+** | `menu_pricing` |
| `/menu-repricing` | Growth+ | `menu_repricing` |
| `/pos` | posEnabled (manager+) | — |
| `/pos/login` | Public (no auth) | — |
| `/pos/tables` | posEnabled (supervisor+) | — |
| `/pos/staff` | posEnabled (manager+) | — |

---

## Pending Features

### Reports Backlog
- **Done (S62):** Wastage Report — `/wastage-report`, Starter+, period wastage by item/category with NPR value and % of total
- **Done (S62):** Dead Stock / Slow Movers — `/dead-stock`, Growth, Dead=Used=0 / Slow=Used<20% of available; Value at Risk
- **Done (S63):** Recipe Contribution Margin — `/recipe-margin`, Growth, (Selling Price − Food Cost) × Qty Sold; sort by contribution/margin/FC%
- **Done (S63):** Period-over-Period Comparison — `/period-comparison`, Pro, FC%/COGS/Revenue side-by-side; ↑↓ pp trend vs prev period
- **Done:** Annual Summary — `/annual-summary`, Starter+, rollup of all monthly_periods in a BS fiscal year
- **Done:** Outstanding Payables — `/payables`, Growth, aging buckets (Current/31–60/61–90/90+), grouped by vendor, Mark Paid button. DB migration run ✓ (`paid_at date` column added to `purchase_entries`)
- **Done:** Shrinkage Report — `/shrinkage`, Pro, last 3/6/12 closed periods selector, actual vs theoretical usage, Consistent/Occasional/Once/Clear status badges. No DB change needed.

### Features Backlog
- **Done (S61):** PWA — installable shell. `manifest.json` updated (name, colors, scope), `public/service-worker.js` added (cache-first for assets, network-first for navigation, never caches Supabase calls), registered in `src/index.js`. Icons: replace `public/logo192.png` + `public/logo512.png` with actual Crest logo at those sizes.
- **Done (S97):** PWA offline stock count — IndexedDB cache + sync queue; counts entered offline are queued and flushed automatically on reconnect
- **Done (S93):** Staff meal & complimentary tracking — `staff_meals` table, new tab in Stock Count, deducted from Used/COGS separately from wastage. Staff Meals column added to Stock Summary and Monthly Summary. Variance updated. Growth plan, `staff_meals` flag. DB migration run ✓
- **Done (S96):** Mobile-first stock count UX — responsive sidebar (hamburger + overlay), card list, category pill strip, progress bar, fixed Save All bar on mobile
- **Deferred (client):** Owner Dashboard — mobile-first single-page P&L view
- **Deferred (client):** Role-based users Owner/Manager

### Crest Suite — One Codebase, Three Modules
Architecture: single React app, single Supabase project, feature flags per client. Sell IMS / HR / POS individually or as a bundle.

| Module | Status | Routes |
|---|---|---|
| Crest IMS | ✅ Live | All existing routes |
| Crest HR | ✅ Live | `/hr/dashboard`, `/hr/employees`, `/hr/pay-setup`, `/hr/attendance`, `/hr/leave`, `/hr/holidays`, `/hr/overtime`, `/hr/payroll`, `/hr/reports`, `/hr/festival`, `/hr/advances`, `/hr/gratuity`, `/hr/settlement`, `/hr/roster` |
| Crest POS | 🔧 Building | `/pos` (setup/activation, manager+), `/pos/login` (public PIN picker), `/pos/tables` (supervisor+), `/pos/staff` (manager+); Orders, KOT, Billing, Shifts next |

**Suite pricing:**
| Suite Plan | Monthly | Annual /mo |
|---|---|---|
| Suite Starter | NPR 12,000 | NPR 9,000 |
| Suite Growth | NPR 22,000 | NPR 16,500 |
| Suite Pro | NPR 32,000 | NPR 24,000 |

**Module flags on `clients` table:** `ims_enabled` (DEFAULT true), `hr_enabled` (DEFAULT false), `pos_enabled` (DEFAULT false, column added S193), `ims_plan`, `hr_plan`, `pos_plan` (column added S193)  
**Admin UI:** AdminClients → **card module strip** — toggle IMS/HR/POS directly on each client card; Billing tab = live toggles + plan selector + subscription date per module (POS wired S193)  
**Route guard:** `src/components/ModuleGate.js` — wraps all IMS, HR, and POS routes in App.js; redirects to `/dashboard` when module is off (admin always bypasses)  
**POS role system (added S195):** `pos_role` column on `profiles` (`staff` / `supervisor` / `manager`). `hasPosAccess(minLevel)` in AuthContext. POS sidebar hidden entirely for users with no role. Tables → supervisor+; Staff → manager+. Crest admin always bypasses.

---

## Session Log

### S248 — 2026-07-05 — Roster: "Rec: N" header hint + Suggest-who-to-schedule popover

Follow-up to S247/S246 — Aashish asked for Labor Forecast to actually help *while* building the roster, not just report on it afterward on a separate tab. Two additive, screen-only (`no-print`) pieces on the Board itself:

**"Rec: N" header hint** — a day column whose header already computes a recommendation (via `laborForecastRows`, now also indexed into `forecastRowByKey` for O(1) lookup by day) shows a small "Rec: N" under the date, amber when the day is currently short-staffed. Reuses the exact same numbers as the Labor Forecast tab — no separate computation path to drift out of sync.

**Suggest popover (✨, only on short-staffed days)** — new `SuggestPopover` component (visual twin of the existing `ShiftPicker`, two internal steps instead of a second floating element): step 1 ranks candidates via `candidatesFor(col)` — everyone in `filteredEmps` (i.e. whatever the Board's Department filter currently shows — this is how "same department" is satisfied without inventing a department concept on shifts/days, which don't have one) not already scheduled that day, sorted by fewest hours scheduled this period (`empHrs`, already existed); step 2 is the normal shift-type list. Picking a shift calls the existing `assignShiftBulk([{ year, month, day, empId }], shiftId)` for that single cell — no new assignment code path, same one drag-select already uses.

No schema change, no new dependencies.

**Files:** `src/modules/hr/roster/Roster.jsx`, `src/pages/Help.js`

### S247 — 2026-07-05 — Roster: Labor Forecast moved to its own tab (was leaking into the printed schedule)

Live-testing S246 surfaced a real problem: the Forecast Revenue/Planned Labor Cost footer rows on the Roster Board were not marked `no-print`, so they showed up on the printed staff schedule — management-only cost/revenue data has no business being on the physical sheet handed to staff. The busiest-day banner was already `no-print` and never had this problem.

Rather than just hiding the two rows from print, restructured per Aashish's request: Roster now has a third tab, **Labor Forecast**, and the Board goes back to showing only shift assignments (on screen and in print). The banner and footer rows were removed from the Board entirely and replaced with one `laborForecastRows` array (one entry per visible day, combining `dayHrs`/`dayLaborCost` from the roster with `forecastByDay` from `demand_forecast_daily`), rendered as a proper report table on the new tab: Date · Scheduled Hours · Forecast Revenue · Planned Labor Cost · Cost % · Recommended Staff · Scheduled Staff · Covered/Short status badge. This also fixed a real limitation of the old design — the table works in **both Weekly and Monthly view** now (30 rows reads fine; the old footer-row approach was Weekly-only because 30 cramped columns didn't). The tab has its own copy of the Weekly/Monthly toggle + prev/next navigation (same `viewMode`/`weekStart`/`bsYear`/`bsMonth` state as the Board, so switching tabs doesn't lose your place) and the Covers/Staff target input.

**Files:** `src/modules/hr/roster/Roster.jsx`, `src/pages/Help.js`

### S246 — 2026-07-05 — Cross-module roadmap Features 2 + 7: Demand-Based Labor Scheduling + Combo Builder

Two of the 9 cross-module features from the S241 roadmap plan, picked as the "quick wins" (lowest build complexity, no new architecture pattern, both build directly on infrastructure already shipped this week).

**Feature 2 — Demand-Based Labor Scheduling (Roster).** V1 scope per the plan: forecast-vs-scheduled-cost only, no `hr_employee_id`/Attendance sync (confirmed neither exists anywhere in the codebase). `empHrs()`/`dayHrs()` extracted out of `Roster.jsx` into a new pure `src/modules/hr/roster/laborForecast.js` (`calcHours`, `rKey`, `computeEmpHours`, `computeDayHours` — identical logic, just relocated) plus two new functions: `computePlannedLaborCost` (scheduled hours × each employee's resolved hourly-equivalent rate) and `computeRecommendedHeadcount` (`Math.ceil(forecastCovers / coversPerStaffTarget)`). Rate resolution reuses `payrollCompute.js`'s existing `hourlyRateOf` (now exported) — the same function OT pricing already uses — not the whole payroll engine, which is a whole-period run-once computation, not a live per-shift number.

`Roster.jsx`'s employee fetch now also selects `pay_basis, basic_salary`. A new `loadForecast()` reads `demand_forecast_daily` (`recipe_id IS NULL` rows = day-level covers/revenue) for the visible date range, mirroring `loadRoster()`'s existing "week can span two BS months" grouping. In **Weekly view only** (Monthly's 30+ narrow columns had no room for this without cramming), the board gained two more footer rows — Forecast Revenue and Planned Labor Cost (with cost as % of that day's forecast revenue, amber above 35%) — plus a banner above the board calling out the week's busiest forecasted day, its recommended headcount, how many staff are actually scheduled that day, and an editable Covers/Staff target (`settings.covers_per_staff_target`, default 20, saved on blur). No feature-flag gating added — this is additive to the Roster page every HR client already has, not a new premium tier.

**Feature 7 — Combo Builder.** New `src/pages/ComboBuilder.js`, `/combo-builder`, Growth plan (`combo_builder` flag) — the first non-order-flow caller of the existing `get_cooccurrence(p_client_id, p_recipe_id, p_days)` RPC (previously only called from `PosOrders.jsx`'s live upsell suggestion chips). Pick an anchor menu item (`SearchableSelect`) and a window (30/90/180 days); the table ranks its most frequent real-bill pairings with a bills-together count/frequency bar, combined price, and a suggested combo price = combined price × (1 − Combo Discount %). Combo Discount % (`settings.combo_discount_pct`, default 10) is editable inline and saved per client. Insight-only, per plan — "Create as Menu Item →" links out to `/menu-pricing`; nothing is auto-created.

**DB migration — run ✓ 2026-07-05:**
```sql
ALTER TABLE settings ADD COLUMN IF NOT EXISTS covers_per_staff_target numeric DEFAULT 20;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS combo_discount_pct numeric DEFAULT 10;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS combo_builder boolean DEFAULT false;
```

**Files:** `src/modules/hr/roster/laborForecast.js` (new), `src/modules/hr/roster/Roster.jsx`, `src/modules/hr/payroll/payrollCompute.js`, `src/pages/ComboBuilder.js` (new), `src/context/AuthContext.js`, `src/context/SettingsContext.js`, `src/pages/AdminClients.js`, `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`

### S245 — 2026-07-05 — Sales Report Payment Summary tab + POS Order Taking offline mode

**Payment Summary tab.** Closed the last gap in the "POS reporting suite" backlog item — write-off totals (`/pos/exceptions`) and VAT-return export (Sales Report's existing tabs) were already covered; a payment-method breakdown for POS sales was not. Added an 8th tab to `/pos/sales-report` (`SalesReport.jsx`) grouping the same date-range order data by `payment_method` (Cash/Card/eSewa/Khalti/FonePay/Credit) with the standard Bills/Gross/Discount/Non-Taxable/Taxable/VAT/Net columns, % of Net Total, and the same letterhead Excel export as the other tabs. No new query — `payment_method` was already selected in the existing range fetch. Credit-noted bills excluded, same reconciliation rule as the Daily/Customer tabs.

**POS Order Taking — offline mode.** Restaurant wifi drops mid-service more than an office network, and previously any connectivity loss silently broke Order Taking (add items, send KOT/BOT). Extended the existing IndexedDB offline pattern from IMS Stock Count (`src/utils/offlineQueue.js`) to POS order-taking specifically — **not** to Billing/Charge, Shifts, Void/Comp, or Credit Notes, which stay hard-gated on connectivity since they involve server-assigned sequential invoice numbers (Nepal IRD compliance, not just UX).

Scope: opening a new table/order offline (client-generated `crypto.randomUUID()` order id, inserted as the real primary key on sync — Postgres accepts a client-supplied UUID over the column's `gen_random_uuid()` default), editing items/covers on an order already cached on this device, and queuing KOT/BOT sends (ticket printing itself needed no changes — already 100% local, no network). A table whose existing order was never loaded on this device is **blocked** offline ("reconnect to open this table") rather than risking a full item-list replace that could silently delete items this device never saw.

`offlineQueue.js`: bumped `DB_VERSION` 1→2, added `pos_menu_cache`, `pos_tables_cache`, `pos_settings_cache`, `pos_order_cache` (per-table last-known-good snapshot), and `pos_order_queue` (one upserted row per order touched offline — `enqueuePosOrder()` merges patches so repeated edits collapse instead of piling up, with `kot_sends` accumulating rather than overwriting).

`PosOrders.jsx`: `loadFloor()`/`loadMenu()`/the settings mount-effect/`openTable()` all branch on `navigator.onLine`, warming the relevant cache on every online read. `performSave()` queues the full desired order state instead of hitting Supabase when offline. `flushPosOrderQueue()` replays the queue on reconnect (same swallow-and-retry-later shape as Stock.js's `flushQueue`), with a `status` check before overwriting any order — if another device already billed/voided it while this one was offline, the queued edit is surfaced as a dismissible conflict banner instead of silently reapplied. UI additions: offline/syncing banners, a per-tile "not yet synced" dot, `#— (pending)` order-number label until sync backfills the real trigger-assigned number, and the Payment button now hard-disabled offline with an explanatory tooltip.

**Bug fix (same session):** the Payment button relied only on the `disabled` attribute + tooltip with no visual dimming (inline `background: var(--theme-green)` never changed), unlike the KOT/BOT buttons which already dim via `.ticket-btn:disabled { opacity: 0.5 }` in `Layout.css`. Added the same `opacity: 0.5` / `cursor: default` treatment inline so a disabled Payment button now actually looks disabled.

No DB migration required for any of the above — `pos_orders.id`'s UUID default, the `order_no` trigger's `IF NEW.order_no IS NULL` guard, and the existing `status` column already supported the design.

**Files:** `src/modules/pos/reports/SalesReport.jsx`, `src/pages/Help.js`, `src/utils/offlineQueue.js`, `src/modules/pos/orders/PosOrders.jsx`.

### S244 — 2026-07-04 — Demand Forecast: fixed duplicate rows on every Recompute click

Live-testing after S242 shipped surfaced a 3rd bug: some forecast days showed a literal "NPR 0" (not the expected "—" or "≈" estimate) even after the S242 basis-tagging fix was live. Root cause: `runForecast()` only ever **inserted** into `demand_forecast_daily`, with no delete of the previous run's rows first. Every "Recompute Forecast" click during testing (including runs from before the S242 fix) stacked another full set of day-rows on top of the old ones. `loadStored()`'s read-back has no natural upsert key for the covers-level row per day, so it just overwrites as it loops through whatever order Postgres returns — meaning an old pre-fix row (with the original false-zero bug baked in) could win over the freshly-computed correct one, non-deterministically per day.

Fixed by deleting this client's rows for the target horizon before writing the new batch: `await supabase.from('demand_forecast_daily').delete().eq('client_id', clientId).eq('horizon_days', horizonDays)` immediately before the insert in `runForecast()`. This only prevents future duplication — the rows already stacked up from prior test runs needed a one-time manual cleanup (`DELETE FROM demand_forecast_daily WHERE client_id = '...'`) before the next Recompute produced a clean result.

**Files:** `src/utils/demandForecastData.js`.

### S243 — 2026-07-04 — Print filename fix applied to every print button, all 3 modules (IMS + HR + POS)

The `document.title`-before-print fix built for Demand Forecast (S242) had the same root cause everywhere: 20 other print buttons across IMS, HR, and POS all called `window.print()` directly, so every one of them also defaulted to "Crest Inventory" in the browser's "Save as PDF" dialog. Extracted the fix into a shared `src/utils/printTitle.js` (`printWithTitle(title)`) — one canonical implementation instead of 21 copies — and pointed every print button at it (including refactoring `DemandForecast.js`'s own bespoke version to use the shared one).

Titles use whatever context is already in scope per page — no new data fetching added anywhere:
- **IMS reports** (VAT, Non-VAT, Wastage, Stock, Stock Count Sheet, Dead Stock, Recipe Margin, Monthly/Annual Summary, Menu Repricing, Period Comparison, Supplier Price Tracker): `"{Report Name} - {periodLabel or equivalent}"`.
- **Document prints** (Recipe Cost Card, Purchase Order, Requisition): recipe name / PO number / department+day, since these are single-document prints, not period reports.
- **HR** (Staff Roster, TDS Certificate, Final Settlement, Payslip, Employee Joining Form): employee name / business name / fiscal year as applicable — Roster's already includes `bizInfo.name` from its S240 letterhead work.

**Build hiccup:** first two build attempts failed with `'printWithTitle' is defined but never used` on 4 files (`HrReports.jsx`, `FinalSettlement.jsx`, `PurchaseOrders.js`, `Stock.js`) despite the source clearly importing and calling it correctly — a stale build cache (`node_modules/.cache`, likely `eslint-webpack-plugin`'s cache not invalidating correctly on Windows for those specific files). `rm -rf node_modules/.cache` + rebuild resolved it; no actual code issue.

**Files:** `src/utils/printTitle.js` (new), `src/pages/DemandForecast.js`, and 20 other files across `src/pages/` and `src/modules/hr/` — see this session's diff for the full list.

### S242 — 2026-07-04 — Demand Forecast (day-of-week moving average, 7/30-day covers/revenue/qty prediction)

First of the 9 cross-module features. `src/utils/demandForecastData.js` (pure, no React) builds a per-calendar-day history from `pos_orders`/`pos_order_items` (excluding credit-noted bills, same rule as `SalesReport.jsx`'s `dailyRows`), falling back to `sales_entries` (`source='manual'`, excluding the `bs_day=0` bulk-entry sentinel from `Sales.js`) when POS history is thin, then averages the last up to 8 same-weekday historical days per target date — simple and auditable over a trained model, since the Holiday Calendar's movable holidays (Dashain/Tihar) can't be assumed pre-populated and would cap any model's accuracy there regardless. `runForecast(clientId, horizonDays)` orchestrates the fetch + model + persists to `demand_forecast_daily`, logging every run (including failures — deliberately not error-swallowing like `stock_movements`) to `demand_forecast_run_log`.

New page `src/pages/DemandForecast.js` (`/demand-forecast`, Growth) — "Recompute Forecast" button (on-demand, matches the app's existing pull-only pattern, no cron), 7-day/30-day toggle, a day-by-day table of forecast covers/revenue with an expandable top-items breakdown, and a holiday badge (flagged, not auto-adjusted-for) when a forecast date matches `hr_holiday_calendar`.

**Bug caught in first live test:** a client whose history is mostly manual Sales Entry (not POS billing) showed "0 covers / NPR 0" for every day even though item-level forecasts had real values. Root cause: manual `sales_entries` rows structurally carry no covers/revenue signal (`covers:0, revenue:0` by design), and averaging those in with real POS days silently pulled the average down to a false zero instead of "no signal." Fixed by tagging each historical day with its `basis` (`'pos'`/`'manual'`) and only averaging covers/revenue over `pos`-basis samples — `null` (rendered as "—") when none exist for that weekday, instead of a misleading `0`. When revenue is `null` but an item-level qty forecast still exists, it's now estimated as `Σ qty × recipe.selling_price` and surfaced as "≈ NPR X" with a Tip explaining it's derived from item quantities, not observed revenue (new `demand_forecast_daily.revenue_estimated` column, added to the not-yet-run migration below).

**Layout fix (2nd live-test round):** the original per-day row required clicking each date individually (click-to-expand) just to see its top forecasted items — tedious across a 30-day view, same friction pattern flagged on the Roster board. Replaced with an always-visible compact item preview (top 3, inline, no click needed) directly beneath each day's numbers, with a "+N more"/"show less" toggle reserved only for seeing the full item list on a given day — the common case now needs zero clicks.

**Print added for both horizons:** "🖨 Print" button (`window.print()`) next to Recompute. On-screen app-navigation header/controls are `no-print`, replaced on the printed sheet by a `print-only` letterhead (`clients.name`/`settings.property_address`, matching `SalesReport.jsx`/`Roster.jsx`'s established letterhead pattern) plus the horizon label and a generated timestamp. The per-day item list has two variants sharing one row — an interactive `no-print` div (top-3 + "+N more") for screen, and a `print-only` div always listing every forecasted item regardless of on-screen expand state, since a printed sheet is a static snapshot, not an interactive session.

**Print filename fix:** the browser's "Save as PDF" dialog suggests `document.title` as the default filename, which this app never sets dynamically — every print (on any page, not just this one) defaulted to the static "Crest Inventory" from `public/index.html`. `handlePrint()` now sets `document.title` to `"{Business Name} - Demand Forecast - {horizon}"` immediately before printing, restoring it on the `afterprint` event rather than the line right after `window.print()` — in Chrome/Edge `print()` returns immediately since the dialog is non-blocking, so an immediate restore would revert the title before the dialog ever reads it. The same fix would apply to Roster's and Stock Count's print buttons if wanted later; not touched here since it wasn't asked.

**Also fixed `src/components/Tip.js`** (shared tooltip component, used app-wide) — it clamped horizontal position near screen edges but always rendered *above* its anchor with no vertical edge-detection, so a tooltip on a heading near the top of the page (e.g. this page's own title tooltip) rendered partly off-screen. Now flips below the anchor when `rect.top < 120`, the same edge-flip pattern `ShiftPicker`/`SearchableSelect` already use for their own dropdowns.

**DB migration — run ✓ (confirmed 2026-07-05 via re-run hitting expected "policy already exists"):**
```sql
CREATE TABLE IF NOT EXISTS demand_forecast_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  recipe_id uuid REFERENCES recipes(id) ON DELETE CASCADE, -- NULL = covers/revenue row for the day
  bs_year integer NOT NULL, bs_month integer NOT NULL, bs_day integer NOT NULL,
  forecast_covers numeric, forecast_qty numeric, forecast_revenue numeric,
  revenue_estimated boolean DEFAULT false, -- true when forecast_revenue is derived from qty × menu price (no direct pos-basis revenue signal for this weekday), not averaged from real order totals
  model_basis text CHECK (model_basis IN ('pos','manual')),
  horizon_days integer CHECK (horizon_days IN (7,30)),
  generated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS demand_forecast_run_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  run_at timestamptz DEFAULT now(), method text, rows_written integer, error text
);
ALTER TABLE demand_forecast_daily  ENABLE ROW LEVEL SECURITY;
ALTER TABLE demand_forecast_run_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "client_own" ON demand_forecast_daily FOR ALL TO authenticated
  USING (client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()) OR (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin')
  WITH CHECK (client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()) OR (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');
CREATE POLICY "client_own" ON demand_forecast_run_log FOR ALL TO authenticated
  USING (client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()) OR (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin')
  WITH CHECK (client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()) OR (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');
GRANT SELECT, INSERT, UPDATE, DELETE ON public.demand_forecast_daily   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.demand_forecast_run_log TO authenticated;

ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS demand_forecast boolean DEFAULT false;
```

**Files:** `src/utils/demandForecastData.js` (new), `src/pages/DemandForecast.js` (new), `src/components/Tip.js`, `src/context/AuthContext.js`, `src/context/SettingsContext.js`, `src/App.js`, `src/components/Layout.js`, `src/pages/AdminClients.js`, `src/pages/Help.js`

### S241 — 2026-07-04 — Phase 0 foundation for the 9-feature cross-module build (Forecasting, Labor Scheduling, QR Menu/Loyalty, KDS, Digital Receipts + 4 Tier-3 reports)

Kicked off the founder-approved cross-module roadmap (see the plan doc for full feature-by-feature design). Phase 0 is small, additive infra that several downstream features depend on — none of it touches the fragile `PosOrders.jsx` billing hot path.

**`src/utils/bsCalendar.js`** — added `bsAddDays(bsYear, bsMonth, bsDay, n)` and `bsDiffDays(y1,m1,d1,y2,m2,d2)`, both built on the existing `bsToAd`/`adToBs` (convert to AD, add/diff in AD space, convert back) rather than reimplementing BS month-length math. Needed by Demand Forecasting (D+30 horizons cross month boundaries) and the upcoming Cash-Flow Forecast (30-day bucketing).

**`src/utils/phone.js`** (new) — `normalizePhone(raw)` strips non-digits, a leading `977` country code, and leading zeros, returning `null` if under 7 digits. `buyer_phone` on `pos_orders` has zero format validation today (raw free text), so this gives Loyalty/RFM/Digital-Receipts a consistent matching key.

**DB migration — run ✓ 2026-07-05:**
```sql
-- pos_customers.phone_canonical — mirrors src/utils/phone.js's normalizePhone() stripping
-- logic (minus its <7-digit NULL guard, which only matters for validating new input, not
-- for a lookup/join key) so existing rows get a canonical key with zero app-code changes
-- to the PosOrders.jsx bill-close upsert.
ALTER TABLE pos_customers ADD COLUMN IF NOT EXISTS phone_canonical text
  GENERATED ALWAYS AS (
    regexp_replace(
      CASE
        WHEN regexp_replace(phone, '\D', '', 'g') ~ '^977.{8,}'
          THEN substring(regexp_replace(phone, '\D', '', 'g') from 4)
        ELSE regexp_replace(phone, '\D', '', 'g')
      END,
      '^0+', ''
    )
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_pos_customers_phone_canonical ON public.pos_customers (phone_canonical);
```

**`src/utils/edgeFunctions.js`** (new) — `invokeEdge(name, action, params)` generalizes the try/catch/error-unwrap logic that was previously duplicated ad hoc as a private `edgeOp()` helper in `Login.js`. `Login.js`'s own `edgeOp` is unchanged (not worth the churn of switching a working call site); new Edge Function work (Digital Receipts' `send-receipt`) uses the shared version instead of copy-pasting a third time.

**Files:** `src/utils/bsCalendar.js`, `src/utils/phone.js` (new), `src/utils/edgeFunctions.js` (new)

### S240 — 2026-07-04 — Roster: drag-to-select bulk shift assign + print fixes

Replaced the old single-cell shift picker (`activeCell` state, `assignShift`) with click-and-drag rectangle selection across the roster board — mousedown anchors a selection, mouseenter while dragging extends it, global mouseup opens the shift picker once for the whole rectangle (`assignShiftBulk`, upserting one row per selected cell). A plain click is just a 1×1 selection, so this single path now covers both single- and multi-cell assignment — e.g. dragging across a week assigns "Leave" to every day in one action instead of one click per day.

**Print bug fixed:** `Layout.css` has a global `.btn, button { display: none !important; }` print rule (meant to hide UI action buttons like Edit/Delete/+Add). Since each roster shift cell is a `<button className="roster-cell">` on screen (needed for the click/drag interaction), that same rule was wiping out every cell's content on print — shift name, time, and hours all vanished, leaving blank bordered boxes. Fixed by adding `display: flex !important` to the existing `.roster-cell` print rule — a class selector always beats a bare element selector regardless of stylesheet order, so this restores the button's layout deterministically.

**Print header cleanup:** the generic page title + "Plan weekly and monthly shift schedules for all staff" subtitle (app-navigation chrome, not useful on a printed schedule) is now `no-print`. Print header instead shows a Company Name/Address letterhead (new `bizInfo` state, `clients.name` + `settings.property_address`, fetched once per client — same convention as `SalesReport.jsx`'s `withLetterhead`) followed by the period label and the existing shift-type legend, left unchanged per Aashish's request.

**Files:** `src/modules/hr/roster/Roster.jsx`

### S239 — 2026-07-04 — KOT Log: Bill Trail tab (complete bill ↔ KOT/BOT audit view)

Reconciliation only surfaces exceptions (mismatches, voids) — Aashish wanted a complete view of every paid/voided bill and its full KOT/BOT history, not just the flagged ones, including bills that never sent anything to the kitchen at all. No schema change needed — `pos_kot_log.order_id` already links everything.

**Shared discrepancy logic extracted** — `sumSentQtyByOrderItem(logs)` and `flagOrderDiscrepancies(orderById, sentByOrderItem, currentByOrderItem)` pulled out of `loadReconciliation` into top-of-file helpers in `KotLog.jsx`, so Reconciliation and the new Bill Trail tab can never disagree about what counts as a discrepancy. Reconciliation's behavior is unchanged.

**Bill Trail — 3rd tab in `KotLog.jsx`** — one row per paid/voided bill (Order#, Table, Status, KOT Sends count, Discrepancy flag), click to expand (accordion pattern from `PosShifts.jsx`'s shift-history table) into the full chronological ticket trail: time, station, items×qty, sent by. A bill with zero KOT/BOT sends gets an amber "No KOT" badge (deliberately distinct from Reconciliation's red "Discrepancy" badge — zero sends is ambiguous, e.g. a legitimate self-serve bar tab, not definite evidence of tampering) — a bill can show both badges at once if applicable. Excel export stays plain (`json_to_sheet`, no letterhead) to match Register/Reconciliation's existing export style on this same page.

**Files:** `src/modules/pos/reports/KotLog.jsx`, `src/pages/Help.js`

### S238 — 2026-07-04 — Sales Report: printed letterhead on all Excel exports

Closed the "beautification gap" noted in the S237 competitor comparison: their exports are styled as print-ready statutory documents (Company Name/VAT No./Address letterhead + date-range line baked into the sheet), ours were plain data tables.

**New `withLetterhead(title, rangeLine, dataRows)` helper in `SalesReport.jsx`** — builds the header block with `XLSX.utils.aoa_to_sheet` (title row, `CompanyName :`, `VATNO :`/`PAN No :` depending on `vatReg`, `ADDRESS :`, blank, the date-range or fiscal-year line, blank), then appends the existing per-tab row data with `XLSX.utils.sheet_add_json(ws, dataRows, { origin: -1 })` — this appends directly after the letterhead rows and auto-generates the column-header row from the object keys, so none of the 7 tabs' existing column shapes needed to change. New `bizInfo` state (`clients.name`, `settings.vat_number`, `settings.property_address`) fetched once per `clientId`, independent of the date-range fetch that already re-runs per tab. Date-range tabs get `@As On Dated : {AD} (B.S. {DD/MM/YYYY}) To : {AD} (B.S. {DD/MM/YYYY}) @Division : {company}`; 1L+ Report (fiscal-year scoped, not date-range) gets `@Fiscal Year : {FY} @Division : {company}` instead.

**Files:** `src/modules/pos/reports/SalesReport.jsx`

### S237 — 2026-07-04 — Sales Report: Bill Register tab (voucher-wise ledger)

Compared Crest's POS reports against a competitor ERP's "Sales Report Item Wise" and "Sales Book Report" screenshots. Item Wise was already functionally equivalent (Product Code/UoM gaps noted for later, no migration needed since `recipes.recipe_code`/`yield_uom` already exist). The real gap: no bill-by-bill register existed — Daily aggregates by day, nothing lists every individual voucher. Checked `pos_orders` and found every needed column already existed (`payment_method`, `bill_remarks`, `closed_by`, `order_no`, `invoice_no`), so this shipped as a no-migration 7th tab.

**Bill Register — 7th tab in `SalesReport.jsx`** — one row per bill: Date (BS), Voucher# (`order_no`), Invoice# (`invoice_no`), Customer, Payment Mode, Order Mode (Dine-In: table / Takeaway, derived from `table_name`), Gross/Discount/Non-Taxable/Taxable/VAT/Net, Remarks (`bill_remarks`), Entered By (`closed_by` → `profiles.full_name`, fetched into a `staffNames` map alongside the shared range fetch, same pattern as `KotLog.jsx`). Bills later corrected by a Credit Note are still listed (unlike Daily, which excludes them entirely) and instead carry a "Credit Noted" badge next to the customer name, since a bill register's job is to show every voucher issued, not just net revenue.

**Files:** `src/modules/pos/reports/SalesReport.jsx`, `src/pages/Help.js`

### S236 — 2026-07-04 — Item Wise Sales Report tab + KOT Log (Register + Reconciliation)

Next three items off `POS_TODO.md`: a plain Item Wise sales ledger, a KOT Register, and a KOT vs Prebill vs Sales reconciliation (anti-fraud). Investigating the existing KOT/BOT send mechanism first: `pos_order_items.sent_to_kot` is a live boolean, overwritten in place on every save, no timestamp/sender/persisted quantity — the "+N" delta badge (`sent_qty`) lives only in React state, never in the DB. No historical KOT log existed, so building a real Register or Reconciliation required a new table.

**DB migration required:**
```sql
CREATE TABLE IF NOT EXISTS pos_kot_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  order_id uuid NOT NULL REFERENCES pos_orders(id) ON DELETE CASCADE,
  order_no integer,
  table_name text,
  station text NOT NULL CHECK (station IN ('KOT','BOT')),
  items jsonb NOT NULL,
  sent_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pos_kot_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "client_own" ON pos_kot_log
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pos_kot_log TO authenticated;
NOTIFY pgrst, 'reload schema';
```

**`pos_kot_log` writes (`PosOrders.jsx`)** — new `logKotSend(station, items, oid, oNo)` helper, called best-effort/non-blocking (same error-swallow pattern as `writeSalesEntries`) from both `saveOrder()`'s first-send auto-send and `sendTicket()`'s manual re-send. `items` jsonb captures exactly what was printed — `qty` is delta-aware (full quantity on first send, delta-only on a re-send, same logic `printTicket` itself already uses), so summing every log row's `items[].qty` per `(order_id, recipe_id)` gives the true cumulative quantity ever sent to the kitchen for that item.

**KOT Log page (`src/modules/pos/reports/KotLog.jsx`, new, `/pos/kot-log`)** — shared BS date-range filter, two tabs:
- **Register** — raw queryable log: Date/Time, Table, Order#, Station badge, Items×Qty, Sent By.
- **Reconciliation** — the anti-fraud check. For every closed (`billed`/`voided`) order in range: sums total sent-to-kitchen qty per item from `pos_kot_log`, compares against the item's *current* qty on the order. Flags a row if (a) sent qty exceeds current qty (cooked, then reduced/removed before billing) or (b) the order ended up **Voided** at all (kitchen made food, zero revenue ever recorded) — regardless of quantity match in that case. Only flagged rows shown ("a quiet report is a healthy one," same philosophy as Sales Exceptions).

**Item Wise Sales Report — 6th tab in `SalesReport.jsx`** — new `computeItemAmounts(order, items, vatReg)` in `posBillingMath.js`, structurally identical to `computeCategoryAmounts` but keyed by `recipe_id` instead of category. Same Sales/Return-on-credit-note pattern as Category Wise. Shared `loadRange()` item select extended to include `recipe_id, name`.

**Files:** `src/modules/pos/reports/SalesReport.jsx`, `src/modules/pos/reports/KotLog.jsx` (new), `src/utils/posBillingMath.js`, `src/modules/pos/orders/PosOrders.jsx`, `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`

### S235 — 2026-07-04 — POS Sales Report: Category/Customer/Hourly/Daily tabs + Purchase-side One Lakh Above (Annexure 13)

Continued the POS reporting backlog: built Category Wise, Customer Wise, and Hourly Sales Reports as three separate pages first, then — after Aashish pointed out this should mirror the competitor's single "Sales Report" menu structure — consolidated all three (plus a new Daily Sales view he asked for, plus the existing sales-side One Lakh Above Report) into **one tabbed page**, `src/modules/pos/reports/SalesReport.jsx` at `/pos/sales-report`, replacing the standalone files. Also shipped the purchase-side (vendor) One Lakh Above Report at `/purchase-one-lakh-report`, completing both halves of the Annexure 13 requirement.

**Consolidated Sales Report (`SalesReport.jsx`):** Daily/Hourly/Category Wise/Customer Wise share one BS date-range fetch (`useMemo`'d per-tab aggregation, so switching tabs doesn't re-query); 1L+ Report keeps its own Fiscal Year selector since Annexure 13 is a whole-year compliance check, not an arbitrary range. Daily groups by BS calendar day and **excludes Credit-Noted bills entirely** (the revenue correction posts on the day the Credit Note is issued, not retroactively into the original day). Both From/To date defaults changed to today's system date (not "1st of the month") — applied to `SalesReport.jsx`, `PosExceptionReport.jsx`, and `CreditNotes.jsx` for consistency across every POS date-range report.

**Purchase One Lakh Above Report (`src/pages/PurchaseOneLakhAboveReport.js`, new, `/purchase-one-lakh-report`)** — vendor-wise purchases across a full BS fiscal year, flagging vendors over NPR 1,00,000. Exported `buildVendorSummary` from `VatReport.js` (was previously private) and reused it across a fiscal year's worth of `periodIds` instead of duplicating the vendor-grouping logic. Gated on the existing `vat_report` feature flag — no new flag/migration.

**Files:** `src/modules/pos/reports/SalesReport.jsx`, `src/pages/PurchaseOneLakhAboveReport.js`, `src/pages/VatReport.js`, `src/modules/pos/reports/PosExceptionReport.jsx`, `src/modules/pos/creditnotes/CreditNotes.jsx`, `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`

### S234 — 2026-07-03 — POS IRD Compliance: Credit Note workflow (Rule 20) + One Lakh Above Report (Annexure 13)

Researched Nepal IRD's actual legal requirements for POS billing in-depth (VAT Rules 2053, Electronic Billing Procedure 2074, Computerized Invoicing Procedure 2072) to separate genuine compliance gaps from competitor-feature noise, then built the two items that turned out to be real legal requirements rather than nice-to-haves. Everything else (item/customer/category-wise sales reports, KOT-vs-Prebill reconciliation, full accounting-ledger parity) stays deferred — business-analytics convenience, not IRD-mandated.

**DB migration required:**
```sql
CREATE TABLE IF NOT EXISTS pos_credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  order_id uuid NOT NULL REFERENCES pos_orders(id),
  credit_note_no integer,
  invoice_fy text NOT NULL,
  original_invoice_no integer NOT NULL,
  original_invoice_label text NOT NULL,
  original_invoice_date_bs text NOT NULL,
  reason text NOT NULL,
  gross_amount numeric NOT NULL DEFAULT 0,
  discount_amount numeric NOT NULL DEFAULT 0,
  taxable_amount numeric NOT NULL DEFAULT 0,
  non_taxable_amount numeric NOT NULL DEFAULT 0,
  vat_amount numeric NOT NULL DEFAULT 0,
  net_amount numeric NOT NULL DEFAULT 0,
  buyer_name text, buyer_address text, buyer_pan text, buyer_phone text,
  issued_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  print_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pos_credit_notes_order_id_key ON pos_credit_notes(order_id);

ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS credit_note_id uuid REFERENCES pos_credit_notes(id);

CREATE OR REPLACE FUNCTION assign_pos_credit_note_no()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.credit_note_no IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('pos_credit_note_no:' || NEW.client_id::text || ':' || NEW.invoice_fy));
    SELECT COALESCE(MAX(credit_note_no), 0) + 1 INTO NEW.credit_note_no
    FROM pos_credit_notes WHERE client_id = NEW.client_id AND invoice_fy = NEW.invoice_fy;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_assign_pos_credit_note_no ON pos_credit_notes;
CREATE TRIGGER trg_assign_pos_credit_note_no BEFORE INSERT ON pos_credit_notes
  FOR EACH ROW EXECUTE FUNCTION assign_pos_credit_note_no();

ALTER TABLE pos_credit_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "client_own" ON pos_credit_notes
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pos_credit_notes TO authenticated;
NOTIFY pgrst, 'reload schema';
```

**Credit Note workflow (`src/modules/pos/creditnotes/`, new module)** — corrects an already-billed order per VAT Rules 2053, Rule 20, which requires a formal Credit Note (8 mandatory fields, one of which is the original invoice number+date) whenever the value of billed goods/services changes, plus a monthly record of every credit/debit note issued (Rule 20(2)). Only whole-order corrections in this v1 (matches "correcting an already-billed order"); item-level credit notes are a fast-follow, same as item-level Complimentary is already separately deferred.
- `IssueCreditNoteModal.jsx` — shared modal (self-contained: fetches its own settings/outlet/HSC data so it works identically from either entry point below). Manager+ gated. On confirm: inserts `pos_credit_notes` (trigger assigns `credit_note_no`, partitioned by `client_id + invoice_fy` — same advisory-lock pattern as `assign_pos_invoice_no()`), stamps `pos_orders.credit_note_id` (also DB-unique-indexed so a bill can only ever be credited once), best-effort posts negative `sales_entries` for the credited items into **today's currently-open period** (source `pos_credit`) so Monthly Summary/Recipe Margin/Best Sellers reflect the correction, then prints the Credit Note. **Deliberately does not touch `stock_movements`** — the food was already served; this corrects billing/tax, not stock (confirmed decision, since credit notes here are price/billing corrections, not returned-food events).
- `creditNoteHtml.js` — `buildCreditNoteHtml()`/`printCreditNote()`, same 80mm thermal layout family and ORIGINAL-COPY/SECOND-COPY/THIRD-COPY reprint convention as `buildBillHtml`/`buildCompSlipHtml`. Prints all 8 Rule 20(1) fields: serial no. (`CN{n}-{prefix}-{fy}`), issue date, supplier name/address/registration, recipient name/address/registration, original invoice number+date, itemized goods/services, credited amount, credited VAT.
- Two entry points into the same modal: a "Credit Note" quick action next to Reprint in `PosOrders.jsx`'s Recent Bills modal (same-day corrections, `PosOrders.jsx`), and a full `CreditNotes.jsx` page (`/pos/credit-notes`) with an "Issue New" tab (BS date-range + invoice-number search across *any* date, not just today) and a "Credit Note Book" tab — the Rule 20(2) monthly register, with reprint + Excel export + TOTAL footer, laid out to match the competitor Credit Note Book Report referenced during research.
- Only bills closed as Pay (`close_type='paid'`) are eligible — Complimentary is already a ₨0 internal document and Void never had revenue to correct.

**`src/utils/posBillingMath.js` (new)** — extracted `computeOrderAmounts(order, items, vatReg)` out of `buildBillHtml`'s inline Gross/Discount/Taxable/Non-Taxable/VAT/Net math so the Credit Note print layout and the new One Lakh Above Report compute identically to the original bill instead of re-deriving the formula a second/third time. `buildBillHtml` refactored to call it — behavior-preserving, verified bill output unchanged.

**One Lakh Above Report (`src/modules/pos/reports/OneLakhAboveReport.jsx`, new, `/pos/one-lakh-report`)** — Nepal VAT return Annexure 13 (अनुसूची १३): any party whose cumulative transactions exceed NPR 1,00,000 in a fiscal year must be disclosed by name+PAN. No schema change — reads existing `pos_orders`/`pos_order_items`. Fiscal-year selector (from distinct `invoice_fy` values already stored per order — simpler than `AnnualSummary.js`'s period-iteration approach, no date-derivation needed). Groups Pay-closed bills by `buyer_pan` (or `buyer_name`, or a `CASH SALES / WALK-IN` bucket) across the fiscal year, using the shared `computeOrderAmounts()`. Flags rows over the threshold: `⚠ Missing PAN` if no PAN on file (the actionable signal — ask for PAN on their next visit), plain `Annexure 13` badge if PAN is already present. Excel export, Manager+ gated.

**Explicitly out of scope this session** (deferred, not IRD-mandated): competitor-parity reports (Category/Customer/Item/Hourly/Supplier-wise sales, KOT-vs-Prebill-vs-Sales reconciliation), the `sales_entries`/`purchase_entries` hard-delete pattern in `Sales.js`/`Purchases.js` (only relevant near the NRs 5 crore certification threshold), purchase-side Annexure 13 (vendor one-lakh-above — `VatReport.js`/`NonVatReport.js` already have a per-vendor summary as partial scaffolding), and the open legal question of whether software certification is required below the Tier-2 threshold (not an engineering task — recommend confirming with an accountant).

**Files:** `src/modules/pos/creditnotes/IssueCreditNoteModal.jsx`, `src/modules/pos/creditnotes/CreditNotes.jsx`, `src/modules/pos/creditnotes/creditNoteHtml.js`, `src/modules/pos/reports/OneLakhAboveReport.jsx`, `src/utils/posBillingMath.js`, `src/modules/pos/orders/PosOrders.jsx`, `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`

### S233 — 2026-07-03 — Admin Dashboard POS module bug fixes (count, badge, MRR) + module pill color consistency

No DB migration. Two-file bug fix from the user noticing a POS-subscribed client (BHATTI CHOILA) wasn't showing up as such anywhere in Admin.

**`src/pages/Dashboard.js`**
- Root cause: the Admin Dashboard's `clients` query never selected `pos_enabled`/`pos_plan`/`pos_ends_at` at all — POS was structurally invisible to every calculation on the page, not just a display bug. Added all three columns.
- Top KPI card's `POS {posCount}` was a **hardcoded literal `POS 0`**, never actually computed — added a real `posCount = active.filter(c => c.pos_enabled).length`, same pattern as the existing `imsCount`/`hrCount`.
- Per-property **Modules** column pill list only ever rendered IMS/HR — added the missing POS pill.
- Found in the same spot while fixing the above: `clientMRR()` (drives Monthly Value, Total, and ARR) only summed IMS + HR — **POS subscription revenue was silently excluded from every platform revenue figure**. Now includes POS same as the other two modules. Added a "POS: {plan}" label next to the plan badge (mirrors the existing HR one) for when POS is on a different tier than the client's main plan.

**Module pill color consistency (`Dashboard.js` + `src/pages/AdminClients.js`)** — two rounds of user-caught color issues, both against the same root cause: color must encode *module identity* (which module is this — always the same color), not something else that varies. First pass, the POS pill I'd added was still using its old muted gray/`--theme-border` styling on the Dashboard's top badge (fixed the count but forgot the color), and the row pill used the gold `--theme-accent` which read as washed-out next to IMS's vivid blue and HR's vivid green. Second pass, caught the same root issue in a completely different component: `AdminClients.js`'s "Manage Clients" list colors its module pills by **plan tier** (Pro=gold, Growth=green, Starter=gray) rather than by module — so three same-tier modules (e.g. all Pro) rendered as three identical gold pills, indistinguishable by color, and it was also inconsistent with how Dashboard.js colors its own pills. Standardized both places on one fixed module-identity palette — IMS `#60a5fa` (blue), HR `#34d399` (green), POS `#a78bfa` (purple, chosen to avoid clashing with the gold "Pro" plan badge or amber's warning connotation elsewhere in the app) — plan tier still shown as text (e.g. "POS · Pro") in `AdminClients.js`, just no longer driving the color. Removed the now-dead `planColor` helper.

**Files:** `src/pages/Dashboard.js`, `src/pages/AdminClients.js`

### S232 — 2026-07-03 — Split Payment (multi-tender); Shift Open/Close printable slips; Charge modal sticky footer; assorted POS polish

DB migration required: `pos_order_payments` table + widened `pos_orders.payment_method` CHECK to add `'Split'` (run ✓ 2026-07-03).

**Split Payment (`src/modules/pos/orders/PosOrders.jsx`, `src/modules/pos/shifts/PosShifts.jsx`)** — the big feature this session. Researched restaurant POS bill-splitting conventions (Toast/Square/Lightspeed/Shopify/Commerce7) and deliberately built **split payment** (multiple tenders against one bill/one Tax Invoice number), not **split bill** (multiple orders/multiple invoice numbers) — the latter would force an unresolved Nepal IRD compliance question (is it fine to issue several sequential Tax Invoices for one table's meal?) that needs an accountant's answer, not an engineering one. Went through full plan-mode review before building.
- New `pos_order_payments` table (order_id, client_id, payment_method, amount, tendered_amount, recorded_by) — one row per tender. `pos_orders.payment_method` gets a `'Split'` sentinel when used; `paid_amount` keeps meaning "grand total" regardless, so every downstream reader that only cares about the total needed zero changes (confirmed via grep — Sales Exception Report, Reorder Report, Recent Bills all read `paid_amount`, never `payment_method`).
- Pay tab gets a persistent **Single Payment / Split Payment** toggle (styled with the same `pay-method-btn` hover as Cash/Card/etc, not a plain text link) — "Single Payment" disables once any tender exists, so a mid-split table can't silently lose collected tenders. In split mode: add tenders one at a time (method + amount), running **Remaining** balance, cash change computed against the *remaining* balance (not the original total, matching researched Toast/Square behavior), **↩ Undo** only on the most recent tender (correcting an earlier one means void + re-ring, same as any other billing mistake — deliberately not building general edit/reconciliation logic), optional 🖨 per-tender courtesy slip (small "Payment Received" receipt, not a Tax Invoice).
- Printed bill (`buildBillHtml`) lists each tender's method+amount instead of one payment line when split; the scan-to-pay QR in split mode targets whichever tender is currently being entered (defaulting to the remaining balance) — fixed a bug where the live-preview QR caption text stayed hardcoded to the full bill total even though the QR image itself (and the modal's own caption) correctly showed the in-progress tender amount.
- Credit is deliberately **excluded** from split tenders (stays a separate, whole-order-only Pay option) — Outstanding Credit/`pos_customers` assumes one Credit order = one full amount owed; making it tender-aware would've pulled `PosCustomers.jsx` into scope for a rare case. Fast-follow if it turns out to matter.
- `loadShiftReport()` in `PosShifts.jsx` (feeds the Shift Z-report's "Sales by Payment Method" + cash reconciliation) now sums from `pos_order_payments` for split orders instead of the single `payment_method`/`paid_amount` columns — verified live: a 3-way split (Cash/Card/FonePay) correctly attributed each portion to its own method, and Cash Reconciliation only picked up the actual cash *portion* into Cash Sales/Expected Cash, not the whole order total.
- Credit bills now also print a Customer Signature/Date line (same style as the Complimentary Slip) — a signed record since no payment is collected at close.

**Charge modal restructure (`PosOrders.jsx`)** — the growing Pay tab content (payment toggle, split tender list) meant Cancel could scroll out of view. Restructured the right panel into a scrollable content area + a **sticky footer** (primary action button + Cancel, always visible regardless of content height) — a structural fix, not just a bigger modal, since content height varies (more tenders = taller). Also widened the modal (980px→1060px, 90vh→92vh cap) for breathing room.

**Shift Open/Close printable slips (`PosShifts.jsx`)** — Open Shift and Close Shift now auto-print an 80mm slip (Courier/dashed-hr, matching `buildBillHtml`/`buildCompSlipHtml` conventions) modeled on a real "Cash Settlement" receipt the user supplied: outlet header, AD+BS combined date format, denomination breakdown, and for Close Shift also the collection breakdown by payment method, bill counts (Paid/Voided/Complimentary), and cash reconciliation/variance. Manual 🖨 Reprint Z-Report button added to Shift History. Denomination entry grid redesigned from a tall 9-row single-column table to a compact 3×3 card grid (~250px shorter) so Open/Close Shift fits without scrolling. Label field auto-suggests Morning/Afternoon/Evening/Night from system time (researched standard F&B daypart buckets), fully editable.

**Silent printing (device setup, not app code)** — researched why POS prints always show a dialog: browsers deliberately block JS-only silent printing. The fix is a Chrome/Edge `--kiosk-printing` launch flag on each till (default printer must be set in Windows first) — documented as a new "Silent Printing Setup" Help.js entry, since it's a one-time OS/browser setting Crest can't configure remotely.

**Other:** Order Taking gets a search box above the category tabs (filters by item name within the active category) — `src/modules/pos/orders/PosOrders.jsx`. Removed a stale "Coming soon: QR payments" notice from the POS device-activation screen (`src/modules/pos/Pos.js`) — scan-to-pay QR shipped in S225, this line was leftover copy. Fixed a latent Help.js bug: `FeatureCard` only read `feat.guide`, but every POS entry (POS Login, Table Management, Order Taking, etc.) is authored with `desc:` — every POS help-card body was rendering blank when expanded; now reads `feat.guide || feat.desc`, fixing all POS entries retroactively with one line.

**Files:** `src/modules/pos/orders/PosOrders.jsx`, `src/modules/pos/shifts/PosShifts.jsx`, `src/modules/pos/Pos.js`, `src/pages/Help.js`

### S231 — 2026-07-03 — Payment QR moved to Admin; POS non-VAT total bug fix; POS role gate rework; Menu Pricing Cost Price for POS-only clients

Migration required: `ALTER TABLE recipes ADD COLUMN IF NOT EXISTS cost_price numeric;` (run ✓ 2026-07-03).

**Payment QR moved from client Settings → Admin (`src/pages/AdminClients.js`, `src/pages/Settings.js`)**
- The "Payment QR (merchant payload)" field used to live in Settings → Property (an admin-only tab, edited while impersonating a client). Moved to a new **QR tab** in Manage Clients → a client's drawer — same validate/preview/save behavior (`validateEmvQr`, live QR preview via the `qrcode` lib), now scoped correctly to admin-side per-client setup instead of a client-facing settings page.
- No change to what POS reads — still `settings.payment_qr_data`, same table/column.

**POS non-VAT-registered total bug (`src/modules/pos/orders/PosOrders.jsx`)**
- Found via a real bill: a non-VAT-registered (PAN Bill) client's live cart total, Confirm Payment amount, and Tender/Change defaults were silently adding 13% VAT regardless of the client's `is_vat_registered` flag — only the *printed* bill correctly excluded VAT. A ₨354 PAN Bill was about to be charged/recorded as ₨400.
- Fix: a `vatReg` flag now threads through the cart total, per-line item price, menu tile prices, "pair with" suggestion price, and the floor-plan table badge — all gate VAT on `billingSettings.is_vat_registered`, matching what `buildBillHtml()` already did for the printed bill.
- Same investigation: the printed/preview bill was showing a "Scan to pay" QR even on Cash payments. QR generation is now gated to eSewa/Khalti/FonePay only (`QR_PAY_METHODS` constant), matching the on-screen payment panel.

**POS role gates reworked (`src/modules/pos/orders/PosOrders.jsx`)**
- **Credit**: Manager+ → **Supervisor+**
- **Complimentary**: Manager+ → **Supervisor+**
- **Void**: Supervisor+ → **owner/admin login only** — no PIN-based role (Staff/Supervisor/Manager), including Manager, can void a bill anymore. Uses `isAdmin || isOwner` directly instead of `hasPosAccess()`, deliberately bypassing the PIN rank system.

**Menu Pricing — Cost Price + Edit for POS-only clients (`src/pages/MenuPricing.js`, `src/utils/recipeCost.js`)**
- POS-only clients (no IMS) can never reach `Recipes.js` (ModuleGate-locked) to link an ingredient, so every item added via Menu Pricing was permanently food-cost-blind — Complimentary Slips always valued at ₨0.
- New `recipes.cost_price` column (nullable numeric) — a manual cost entered in the POS-only "Add Item" modal, used as the food-cost fallback wherever ingredient-derived cost is unavailable.
- `computeRecipeCosts()` (feeds Complimentary Slip, Sales Exception Report Comp column, Shift reports) now falls back to `cost_price` when a recipe has no ingredient breakdown; ingredient-derived cost still wins when present, so IMS clients are unaffected.
- Menu Pricing's POS-only table gained an **Edit** link (reuses the Add Item modal, pre-filled, switches insert→update) and a **Cost Price** column.

**Files:** `src/pages/AdminClients.js`, `src/pages/Settings.js`, `src/modules/pos/orders/PosOrders.jsx`, `src/pages/MenuPricing.js`, `src/utils/recipeCost.js`, `src/pages/Help.js`

### S230 — 2026-07-03 — Payment QR: accept NepalPay tag-00-less payloads + rail-coverage findings

No DB migration. One-file fix from live testing of the dynamic bill QR (S225 feature) with a real merchant payload (C.M.S. Hospitality, NCHL).

**`src/utils/emvQr.js` — `validateEmvQr` no longer rejects payloads missing tag 00**
- Real-world NepalPay/NCHL merchant QRs ship **without** the EMVCo-mandatory payload format indicator (tag 00) — the CRC is computed over the tag-00-less body and banking apps accept them. Settings rejected the pasted payload with "Missing payload format indicator (tag 00)" even though the CRC check (which runs first) proved the string was byte-for-byte what the bank issued.
- Fix: dropped the hard tag-00 rejection. All checks that catch real paste errors remain: TLV structure parse, missing checksum (tag 63), CRC mismatch, missing merchant name (tag 59).
- Verified with a Node test harness: tag-00-less payload validates + `buildDynamicQr` on it produces a correct dynamic QR (tag 01 → '12', amount tag 54 inserted in order, CRC recomputed); standard tag-00 payloads still validate.

**Live scan results (real bill, real apps):**
- **Bank app (NepalPay member): ✓** — dynamic QR scans, amount pre-filled and locked
- **eSewa: ✗** — "Sorry, this QR is not supported. Please scan Fonepay Business QR." Not a bug: Nepal has two QR rails (NepalPay/NCHL vs FonePay/F1Soft) and eSewa only accepts the FonePay rail — it would reject the bank's own printed standee QR identically.
- **Deferred decision** (user: "later"): Plan A — swap the stored payload to the merchant's FonePay Business QR (covers eSewa + most bank apps, no code); Plan B — second QR field in Settings, print per payment method. Test Plan A first.

- **Files:** `src/utils/emvQr.js`

### S229 — 2026-07-03 — Admin per-module data clearing + full-wipe coverage for HR/POS

**⚠ Redeploy edge function** — paste updated `supabase/functions/admin-user-ops/index.ts` into Supabase Dashboard → Edge Functions → admin-user-ops → editor. **Redeployed ✓ + verified live 2026-07-03** (Clear POS Transactions on Casa Acai: orders/shifts/customers/ledger wiped, tables + staff kept).

**SQL run (grants — discovered during live verification):** tables created via raw SQL in this project get **no table-level privileges for any API role**, so the edge function (service_role) hit `42501 permission denied` on `stock_movements`, then `pos_orders`. Fixed with a blanket grant, run ✓:
```sql
grant select, insert, update, delete on public.stock_movements to authenticated; -- also lets Reorder Report's admin "Clear Book Stock" delete
grant all on all tables in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;   -- future tables covered
notify pgrst, 'reload schema';
```
`authenticated` still needs an explicit per-table GRANT after every future `CREATE TABLE` (see S228's stock_movements grant); `service_role` is now covered permanently. Note: partial failed runs are safe — `clearModuleData` deletes child tables first and is idempotent, so re-clicking after a grant fix completes the job.

Admin → Clients → ⚠ Danger previously had one "Clear Client Data" action that was **IMS-only** — it never touched any of the 14 `hr_*` tables or 5 `pos_*` tables, and even for IMS it missed `staff_meals`, `payable_payments`, `stock_movements`, and `recipe_suggestions`. For a client running multiple modules there was no way to reset just one of them.

**New edge-function action `clearModuleData` (`{ clientId, module: 'ims'|'hr'|'pos' }`)** — clears one module's *transactions* while keeping its setup/master data:
- **IMS**: deletes purchases (+ `payable_payments` first), vendor returns, opening/closing stock, wastages, staff meals, sales entries, budgets, stock movements, POs + items, requisitions + lines, overheads. **Keeps** items, vendors, categories, recipes, par levels, and `monthly_periods` — periods are deliberately kept because **HR shares the same `monthly_periods` table** (`hr_attendance.period_id`, `hr_payroll_runs.period_id`); deleting them on an IMS clear would orphan HR data.
- **HR**: deletes payslips (by run ids first), payroll runs, attendance, leave requests, overtime, festival allowances, advance repayments, advances, roster. **Keeps** employees, salary components, leave types, holiday calendar, shift types.
- **POS**: deletes order items (by order ids first), the `stock_movements` ledger, POS-sourced `sales_entries` (`source = 'pos'` only — manual sales survive), orders, shifts, customers. **Keeps** tables/floor plan and staff accounts/PINs; any table left "occupied" by a deleted order is reset to available. Invoice numbering restarts (sequence derives from existing rows).

**`deleteClientData` (full wipe behind "Clear Client Data" / "Delete Client") extended** to cover everything it missed: `payable_payments` (before `purchase_entries` — FK), `staff_meals`, `stock_movements`, `recipe_suggestions` (both directions), all 5 `pos_*` tables, all 14 `hr_*` tables (payslips→runs and repayments→advances ordered for FKs, HR tables before `monthly_periods`). Previously **"Delete Client" could FK-fail or leave orphans for any client with HR/POS data**.

**AdminClients.js Danger tab** — new "Clear one module — transactions only, setup kept" row with three buttons (Clear IMS/HR/POS Transactions), each with a Tip and a confirm dialog listing exactly what's deleted vs kept; existing buttons regrouped under "Full client reset"; banner + confirm texts updated to describe all-module coverage.

- **Files:** `supabase/functions/admin-user-ops/index.ts`, `src/pages/AdminClients.js`

### S228 — 2026-07-03 — IMS stock deduction trigger: `stock_movements` ledger + Reorder Report Book Stock

**SQL run:**
```sql
create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  item_id uuid not null references items(id),
  period_id uuid not null references monthly_periods(id),
  bs_day int,
  qty numeric not null,               -- signed: negative = depletion
  source text not null,                -- 'pos_sale' | 'pos_comp'
  ref_id uuid references pos_orders(id) on delete set null,
  created_at timestamptz not null default now()
);
create index stock_movements_client_item_idx on stock_movements(client_id, item_id);
create index stock_movements_period_idx on stock_movements(period_id);
alter table stock_movements enable row level security;
create policy stock_movements_all on stock_movements for all using (
  (select role from profiles where id = auth.uid()) = 'admin'
  or client_id = (select client_id from profiles where id = auth.uid())
);

-- Required follow-up — table-level grants aren't automatic for tables created via raw SQL
-- (only via the Table Editor UI). Without this, every insert/select fails with 42501
-- "permission denied for table stock_movements", RLS notwithstanding — RLS only governs which
-- rows a role can touch, not whether it can touch the table at all.
grant select, insert on public.stock_movements to authenticated;
-- PostgREST also caches schema/privilege info; the GRANT above didn't take effect via the API
-- until this was run too:
notify pgrst, 'reload schema';
```

First piece of the POS → IMS stock integration (roadmap: "IMS stock deduction trigger, recipe →
stock_movements"). POS sales already wrote `sales_entries` for revenue/food-cost reporting but
never touched actual stock quantities — Stock/Reorder were fully month-end-physical-count
dependent. This adds a perpetual append-only depletion ledger, written on every POS Charge/Payment
and Complimentary close, plus a first visible payoff in Reorder Report.

**New shared helper — `src/utils/recipeCost.js`: `explodeRecipeIngredients(supabase, recipeIds)`**
- Batch API (avoids N+1): takes an array of recipe ids, returns `{ [recipeId]: {item_id, qty}[] }` — raw-ingredient quantities per one unit/portion, yield_pct-trimmed, sub-recipe yield_qty-scaled
- Recurses through `recipe_ingredients.sub_recipe_id` to **arbitrary depth** via an iterative frontier-fetch loop (capped at 5 rounds)
- Used by the new POS depletion writer, the Reorder Report fix below, **and** `computeRecipeCosts` (rewritten to build on top of this helper instead of its own one-level-deep sub-recipe fetch — fixes a confirmed bug where a sub-recipe nested inside another sub-recipe silently costed ₨0; affected Complimentary Slip valuation for any client with 2+ levels of sub-recipe nesting)

**POS close → ledger — `src/modules/pos/orders/PosOrders.jsx`**
- `writeSalesEntries()` (already ran on both `'paid'` and `'writeoff'` closes for `sales_entries`) now also explodes each order item's recipe, aggregates ingredient qty across the whole order, and bulk-inserts negative `stock_movements` rows (`source: 'pos_sale'` or `'pos_comp'`, `ref_id: orderId`)
- Best-effort — wrapped in try/catch, never blocks or fails the bill close (matches the existing `sales_entries` insert's own error-discarding posture). Fixed a real bug found during live testing: the initial version didn't destructure `{ error }` from the `stock_movements` insert — Supabase-js doesn't throw on a failed insert (RLS/permission/constraint errors resolve as `{ data: null, error }`, not a rejected promise), so the try/catch never saw the 42501 permission error below and failures were completely silent. Now explicitly checks `{ error: moveErr }` and `console.error`s it.
- No negative-stock blocking — ledger can drift, physical count remains the source of truth (existing product philosophy)
- No offline-queue support — POS order-close itself has no offline path yet (separate unbuilt roadmap item)
- **Verified live 2026-07-03**: real POS sale → `stock_movements` row written → Reorder Report Book Stock decremented correctly on the next sale (63 → 62). One deployment gotcha hit and documented above (missing `GRANT`/schema-cache reload) — several test sales made during that troubleshooting window wrote to `sales_entries` (unaffected, unconditional) but not `stock_movements` (blocked), so Book Stock and Current Stock started from different baselines for this item; expected one-time artifact of today's testing, not a bug — resolved itself going forward once the grant took effect.

**Reorder Report bug fix + Book Stock column — `src/pages/ReorderReport.js`**
- Fixed: the inline `usageMap` calc only counted direct-item recipe ingredients and silently skipped any ingredient that was itself a sub-recipe (`if (sold > 0 && ri.item_id)` dropped `sub_recipe_id` rows entirely, no `yield_pct` trim applied either) — under-reported usage, over-stated Current Stock, for any recipe built on a sub-recipe. Now uses `explodeRecipeIngredients` for correct recursive usage. Same bug exists in `Variance.js` — not touched this session, separate future fix.
- New **Book Stock** column: live running stock from `stock_movements` (`openQty + netPurch − wasteQty + Σmovements`), shown only when the item has ≥1 movement row this period (else "—", so non-POS/IMS-only clients never see a misleading "0 used"). Deliberately kept separate from "Current Stock" (still `sales_entries`-sourced, covers manual entries too) rather than replacing it — replacing would zero out usage tracking for clients without POS
- Excel export and Tip tooltips updated to match

**Help.js** — Reorder Report entry + new "Book Stock" glossary term explain the new column and what triggers it.

- **Files:** `src/utils/recipeCost.js`, `src/modules/pos/orders/PosOrders.jsx`, `src/pages/ReorderReport.js`, `src/pages/Help.js`

### S227 — 2026-07-03 — POS Order screen: button redesign, print-doc fixes, Tip positioning bug

No DB migration. UI/print polish pass on `/pos/orders`, driven by iterative screenshot feedback.

**Payment method buttons (Billing modal)**
- Cash/Card/eSewa/Khalti/FonePay/Credit no longer show a persistent accent fill for the selected method (previously Cash was always gold, Credit always had a red border, even when idle) — new `.pay-method-btn` class family in `Layout.css`: neutral at rest, accent/red color only on `:hover`/`:active`, selected method shown via bold text + subtle border instead

**KOT/BOT/Charge redesign**
- New `.ticket-btn` class (`Layout.css`) replaces ad-hoc `btn btn-ghost` overrides — same hover/active-only color philosophy as payment buttons, plus `:focus` outline suppressed (kept for `:focus-visible`/keyboard) so the button no longer shows a lingering gold border after a mouse click
- "Charge →" renamed to **Payment**, recolored green (`var(--theme-green)`), moved into its own row alongside **Send Order** (each 48% width, matching size/placement)
- KOT and BOT resized to match (48/48 split in their own row below); bold text + badge (no color fill) when a station has unsent items (`ticket-btn--pending`)
- Send Order width tuned down from 100% → 80% → 40% → 48% across the session, left-aligned (no longer centered)

**Tip.js positioning bug (found + fixed)**
- Root cause: `Tip`'s wrapper `<span>` was hardcoded `display:inline`, which sizes to a thin text-line "strut" instead of its actual content height — invisible for small text labels, but once KOT/BOT/Payment became full-height buttons the tooltip's `getBoundingClientRect()` anchor was ~13px too low, so the tooltip rendered overlapping the button instead of floating above it
- Verified with an isolated headless-browser (Playwright) reproduction of the exact DOM/CSS before touching the real component — no login or live data needed, since the app's Supabase project has no seeded test credentials available in this environment
- Fix: `Tip.js` now accepts an optional `style` prop merged onto the wrapper span (opt-in — every other existing `<Tip>` call site across the app is unaffected). Applied `style={{ display: 'inline-block', width: '100%', borderBottom: 'none' }}` to KOT, BOT, and Payment's `Tip` wrappers

**Print documents — black fonts**
- Tax Invoice/PAN Bill, KOT/BOT kitchen/bar tickets, and the Complimentary Slip all had gray accent text (`#555`/`#333`) on timestamp/cashier/table lines — changed to pure black (`#000`) for consistent thermal-print legibility; shift X/Z reports were left untouched (out of scope)

**Tax Invoice — Covers on the bill**
- The table/timestamp row and Cashier row were combined: row 1 now shows `Dine-In: Table N` + `Covers: #N` (was table + timestamp); row 2 shows `Cashier: {name}` + the timestamp (was cashier alone, no row partner). Uses `order.covers`, already present on the `pos_orders` row for both the live-close and reprint paths

**Complimentary Slip — signature line**
- Added a blank signature + date line at the bottom (`buildCompSlipHtml`) — 60%-width underline for the signature, 32%-width underline for the date, labeled underneath. Feeds both the live in-modal preview and the actual print
- Verified the "no outlet name shown" claim in the Mark Complimentary confirmation copy against the actual slip HTML — found `outletName` was still being printed (leftover from copy-pasting the Tax Invoice template, contradicts the documented Complimentary Slip design of no outlet name/PAN/invoice number). **Left as-is per user decision** — not fixed this session.

- **Files:** `src/modules/pos/orders/PosOrders.jsx`, `src/components/Layout.css`, `src/components/Tip.js`

### S226 — 2026-07-02 — HR module bug audit + fixes (11 findings, all addressed)

No DB migration. Full code audit of `src/modules/hr/` (payroll/TDS engines, payroll runner, attendance, advances, settlement, gratuity, every insert path). TDS slabs, SSF cap/waiver math, YTD projection, and advance auto-repayment idempotency all verified correct against the Nepal payroll-law reference. Fixes:

**High (silent failures)**
- **Final Settlement never deducted outstanding advances** — it queried `hr_advances` columns that don't exist (`balance`, `issue_date`, `description`; the table has `issued_date`, `purpose`, and no balance column). The query errored silently and every settlement showed zero advance recovery. Now fetches advances + repayments and derives outstanding = amount − repaid, same as PayrollRun's advance map; UI rows show `amount − repaid` per advance.
- **Payroll Generate broke the OT refetch** — `generate()` called `loadAll(period.id)` without the bs_year/bs_month args, so the overtime-entries query ran `.eq('bs_year', undefined)`, errored, and cleared the OT list; clicking Regenerate right after Generate silently dropped all approved overtime from payslips. One-line fix (pass all three args).

**Medium**
- **OT double-pay flagging** — overtime can be recorded in both the attendance sheet's OT column and the Overtime module, and both are paid. Rather than silently dropping one source, the payroll register now shows an amber **⚠ OT ×2?** badge on any employee with hours in both sources for the period, with a Tip explaining the fix; matching warnings added to the attendance OT column Tip and Help.
- **Settlement gratuity now nets out the SSF-funded portion** — for SSF-enrolled staff, the employer's monthly contribution already funds gratuity (3.33% of capped basic), so paying full accrual at settlement double-paid it. Now `gratuity = accrued − SSF-covered` (matching GratuityTracker's own model), with the formula shown on the settlement statement.
- **Missing `if (!clientId)` guards added** on HolidayCalendar save/seed, LeaveManagement submit/approve/decide/addType, Overtime save, FestivalAllowance generate/regenerate — the known NULL-client_id hydration bug class (records saved during an admin client-switch went invisible).
- **Absence deduction now on gross, not basic** — previously an employee absent the whole month still received 100% of allowances. Unpaid days now forfeit the full day's pay (gross ÷ month days × unpaid days).

**Low**
- SSF is now contributed on the basic actually earned (prorated by unpaid days, capped) — deductions can no longer exceed pay in heavy-absence months.
- Daily-wage staff now get paid for `paid_leave` days (that's what makes the leave paid); hourly staff get a standard 8-hour day credited per paid-leave day.
- Payslip absence row relabelled "Absence / Unpaid Leave" (the old label showed only absent days while the amount also covered unpaid leave and half-days).
- Tips/Help updated to match the new formulas.

**Flagged, not changed:** gratuity vesting is 12 months in code (consistent across settlement + tracker) while the law reference says 3 years — verify with the accountant before changing. Settlement TDS baseline approximates annual income as basic × 12 (documented approximation).

### S225 — 2026-07-02 — Dynamic payment QR on bills + Billing modal (NepalPay/FonePay EMVCo)

**DB migration run ✓:**
```sql
ALTER TABLE settings ADD COLUMN IF NOT EXISTS payment_qr_data text;
```

Closes the last "Coming soon" item (QR payments) at the **dynamic QR** tier — per-bill QR with the exact amount pre-filled, no provider API onboarding needed. (Full webhook auto-confirmation remains a future, per-client-onboarded project.)

**How it works** — every Nepali payment QR (FonePay/NepalPay/eSewa merchant QR) is an EMVCo merchant-presented TLV payload ending in a CRC-16/CCITT-FALSE checksum. A static standee QR becomes a per-bill dynamic QR by pure string manipulation: set tag 01 → "12" (one-time), inject tag 54 = the bill's exact amount, recompute the checksum. The customer's banking app then shows the amount pre-filled and locked — no fat-finger errors, no API involved.

**`src/utils/emvQr.js`** (new) — `crc16()`, `parseEmvQr()` (TLV parser), `validateEmvQr()` (structure + checksum + merchant-name checks, friendly error messages), `buildDynamicQr(base, amount)` (tag surgery + CRC recompute, keeps tags in ascending order). Logic verified with a Node round-trip test: static → dynamic → re-validates, garbage and tampered payloads rejected. New dependency: `qrcode` (^1.5.4) renders payloads to data-URL images client-side.

**`src/pages/Settings.js` — Property tab (one-time setup)** — new "Payment QR (merchant payload)" textarea: the owner scans their counter standee with any QR-reader app (yields the raw `000201…` text) and pastes it. Live validation shows "✓ Valid payment QR — merchant: {name}" (parsed from tag 59) plus a rendered preview QR to scan-test with a banking app *before* saving, or a specific error (malformed / checksum mismatch / not a payment QR). Invalid saved data is harmless — generation re-validates and simply renders no QR.

**`src/modules/pos/orders/PosOrders.jsx`**
- **Billing modal (Pay tab)** — when the payment method is eSewa/Khalti/FonePay and a merchant payload is configured, a scan-to-pay QR card appears above Confirm Payment, regenerating live as the total changes (e.g. while a discount is typed) — always encodes the exact current `payTotal`.
- **Printed bill** — `buildBillHtml()` gained an optional `qrUrl` param: a "Scan to pay — amount pre-filled" QR block prints between the amount-in-words and the thank-you line. `printBill()` (and therefore reprints) generates it from the order's actual `paid_amount`; the live preview iframe shows the same QR via the shared builder, so preview and print can't drift. Complimentary slips get no QR (nothing to pay).
- Data-URL images render instantly in the print window (no network fetch), so the existing 300ms print delay is safe.
- **Known limitation (by design):** no payment confirmation — the app generates the QR but can't know the money landed; the cashier confirms after seeing it on the merchant app. Auto-confirmation = FonePay/eSewa webhook integration, a separate future project requiring per-client merchant API credentials.
- Hooks note: the computed-totals block (`subEx`…`payTotal`) moved above the `hasPosAccess` early return so the QR-regeneration `useEffect` satisfies the rules-of-hooks — pure derivation, no behavior change.

### S224 — 2026-07-02 — POS Shift Management (X/Z reports, denomination-based cash drawer counts)

**DB migration run ✓:**
```sql
CREATE TABLE IF NOT EXISTS pos_shifts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label                 text,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_at             timestamptz NOT NULL DEFAULT now(),
  opened_by             uuid REFERENCES profiles(id) ON DELETE SET NULL,
  opening_cash          numeric NOT NULL DEFAULT 0,
  opening_denominations jsonb,
  closed_at             timestamptz,
  closed_by             uuid REFERENCES profiles(id) ON DELETE SET NULL,
  closing_cash          numeric,
  closing_denominations jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS pos_shifts_one_open_per_client ON pos_shifts (client_id) WHERE status = 'open';
ALTER TABLE pos_shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pos_shifts_client" ON pos_shifts FOR ALL TO authenticated
  USING (client_id = (SELECT client_id FROM profiles WHERE id = auth.uid())
         OR (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');
GRANT ALL ON pos_shifts TO authenticated;

ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES pos_shifts(id) ON DELETE SET NULL;
```

Last of the three agreed fast-follows (Customers ✓ → Sales Exception Report ✓ → **Shift Management**). `src/modules/pos/Pos.js`'s "Coming soon" footer literally listed "Shift Z-reports" — now removed since it's shipped (KOT printing and Billing were also stale on that list and removed at the same time; QR payments is the only genuinely-still-pending item left).

**`src/modules/pos/shifts/PosShifts.jsx`** (new page, route `/pos/shifts`, Supervisor+, `pos-floor` sidebar group)
- **Denomination-based counting** — both Open Shift and Close Shift count NPR notes/coins individually (1000, 500, 100, 50, 20, 10, 5, 2, 1 × quantity, auto-summed) rather than a single total, per explicit user decision — more audit-accurate, matches real cash-counting practice.
- **Current Shift tab (X-report)** — live, non-destructive, repeatable snapshot of the open shift: order count, sales by payment method, total discount given, total void value, total comp food cost (same per-type valuation as the Sales Exception Report — Discount = `discount_amount`, Void = menu value incl. VAT, Comp = food cost via `computeRecipeCosts()`), and a Cash Reconciliation section showing Expected Cash = opening count + cash sales so far. If no shift is open, an **Open Shift** button starts one.
- **Close Shift (Z-Report)** — one-time, final: enter the closing count, and the report locks in `closing_cash` and the variance (`counted − expected`, signed: green "Balanced" near zero, red if short, amber if over).
- **Shift History tab** — lazy-loaded (mirrors `PosCustomers.jsx`'s pattern), past closed shifts with duration/opened-by/closed-by/variance badge; click a row to expand its frozen Z-report.
- **Multiple shifts per day, one open at a time** — a partial unique index (`WHERE status = 'open'`) enforces this at the DB level rather than app logic, so two supervisors racing to open a shift from two devices get a clean "already open" message (Postgres error `23505`) instead of a data-integrity problem. Deliberately *not* the advisory-lock pattern used for invoice numbering — opening a shift is a single INSERT with no counter to compute, so the unique constraint alone is the correct concurrency guard.
- **Non-blocking, per explicit user decision** — `pos_orders.shift_id` is stamped from `PosOrders.jsx`'s cached `openShiftId` state (loaded once, refreshed inside the existing `loadFloor()` call after every close — no extra query on the hot billing path). Charge never checks for an open shift; an order closed with no shift open just gets `shift_id = null` and doesn't appear in any shift's totals. An order still in progress when a shift closes gets stamped with whichever shift is open when it eventually closes (possibly the next one, or null) — documented inline as intentional bookkeeping, not a bug.

### S223 — 2026-07-02 — Sidebar rebuilt as icon rail + flyout panel (VS Code / Azure Portal pattern)

No DB migration. `src/components/Layout.js`, `Layout.css`, Help FAQ entry, service-worker cache bump (v14 → v15, breaking CSS change).

The sidebar had grown to ~50 links/headers when all three modules were enabled — group-level collapsing existed, but the modules' groups still stacked vertically, forcing constant scrolling. Started as a module-level accordion (built, then superseded within the same session by user decision), landed on the industry-standard **rail + flyout panel** pattern:

- **Icon rail (56px, always visible)** — one icon per module: Admin ⊛ (Crest admin only, with a pulsing red/amber dot when trial signups need attention), IMS ▤, HR 👥, POS ◉ — plus Help, a panel show/hide toggle, and Sign out pinned at the bottom. The brand logo sits at the top.
- **Flyout panel (220px)** — shows *only the selected module's* links: panel title, the admin client-switcher / plan badge (unchanged), the module's collapsible task groups, the upgrade teaser (IMS), and the user identity footer. Switching modules swaps the panel content — nothing ever stacks, nothing scrolls past other modules.
- **Panel follows the route** — navigating into `/hr/...` selects the HR panel, `/pos/...` the POS panel, etc. Two shared-route guards: `/menu-pricing` (lives in both IMS and POS) won't yank a POS user over to the IMS panel, and `/periods`+`/settings` won't switch an admin away from the Admin panel. Clicking a rail icon switches panels *without* navigating, so you can peek at another module's pages.
- **Collapse = rail only** — the ‹ toggle hides the panel entirely (main content reflows to 56px margin); clicking any module icon brings it back. Mobile hamburger opens rail + panel together as an overlay.
- **IMS Reports split by characteristic** (kept from the accordion iteration): the single 21-item "Reports" group is now **Summary Reports** / **Stock Reports** / **Finance Reports** / **Menu & Vendors**, all default-collapsed — open just the slice you need. `REPORTS` gained a `cat` field; the flat array is preserved because the upgrade teaser reads it.

### S222 — 2026-07-02 — POS Sales Exception Report (Discounts + Voids + Comps, by reason & staff)

No DB migration — every field this report reads (`close_type`, `close_reason`, `discount_amount`, `discount_reason`, `closed_by`, `closed_at`) already exists on `pos_orders`.

Second of the three agreed fast-follows (Customers ✓ → **Exception Report** → Shift management). Follows the industry-standard single-report pattern (SpotOn/Rezku/Toast "sales exception report"): Discounts, Voids, and Comps together — all three are revenue that leaked — rather than three siloed reports.

**`src/modules/pos/reports/PosExceptionReport.jsx`** (new page, route `/pos/exceptions`, Manager+, new "Reports" sidebar group under POS — shift management's X/Z reports will join it later)
- **Filters**: BS date range (two `BsCalendarPicker`s, defaults to current BS month → today), exception type pills (All/Discounts/Voids/Comps), staff dropdown (populated only with staff who actually closed exceptions in range).
- **Valuation per type** — each means something different, deliberately: Discount = NPR knocked off (`discount_amount`); Void = full menu value forgone incl. VAT (summed live from `pos_order_items`); Comp = **food cost** via `computeRecipeCosts()` (one batched call across all comp orders' recipe ids), matching how the Complimentary Slip itself values comps.
- **Stat cards**: Discounts total, Voided Value, Comp Food Cost, Total Exceptions — each with count + Tip explaining what the number means.
- **By Staff Member rollup** — the report's real job: per-staff counts and totals per type, sorted by total leaked, so an owner can spot one cashier discounting far more than everyone else (training gap or permission creep).
- **Detail table**: BS date + time, Bill No (TI/PB/NC formatted), table, type badge (gold/red/amber), reason, amount, closed-by.
- **⬇ Excel export** (SheetJS, same pattern as IMS reports) of the filtered detail list with both AD date and BS Miti columns — accountant-ready.

### S221 — 2026-07-02 — POS Customers page + Credit collection tracking

**DB migration run ✓:**
```sql
CREATE TABLE IF NOT EXISTS pos_customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name       text NOT NULL,
  phone      text NOT NULL,
  address    text,
  pan        text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (client_id, phone)
);
ALTER TABLE pos_customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pos_customers_client" ON pos_customers FOR ALL TO authenticated
  USING (client_id = (SELECT client_id FROM profiles WHERE id = auth.uid())
         OR (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');
GRANT ALL ON pos_customers TO authenticated;

ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS credit_settled_at     timestamptz;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS credit_settled_by     uuid REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS credit_settled_method text CHECK (credit_settled_method IN ('Cash','Card','eSewa','Khalti','FonePay'));
```

First of the three agreed fast-follows (Customers + Credit collection → Sales Exception Report → Shift management).

**`src/modules/pos/customers/PosCustomers.jsx`** (new page, route `/pos/customers`, Supervisor+, sidebar "Floor" group)
- **Customers tab** — customer book built automatically, zero manual entry: `closeOrder()` in PosOrders.jsx now upserts a `pos_customers` row (keyed `client_id + phone`) whenever a bill closes with buyer Name + Phone filled in — which every discount and Credit sale requires. Address/PAN only overwrite when provided, so a later bill with blank address doesn't wipe a saved one. Non-fatal: if the upsert fails (e.g. migration not yet run), billing itself is unaffected. Searchable by name/phone; clicking a row lazy-loads that customer's full order history (matched by `buyer_phone`) with per-order payment method and Credit collected/outstanding badges.
- **Outstanding Credit tab** — lists unsettled Credit bills (`payment_method='Credit'`, `credit_settled_at IS NULL`) with stat cards (total outstanding, bill count), bill age ("chase the old ones first"), and a **Settle** action: pick the method the customer actually paid with (Cash/Card/eSewa/Khalti/FonePay) → writes `credit_settled_at/by/method`. Full settle only (no partial payments — per user decision). Collected bills show below as history. Settling is Supervisor+ (routine cashier work); *issuing* credit stays Manager+.
- No backfill of old orders (per user decision) — the book fills organically from now on.
- Design decisions made via user Q&A: full-settle-only, dedicated page (not crammed into the floor view), Supervisor+ settle, no backfill.

### S220 — 2026-07-02 — POS Billing: Credit payment method (Manager+, mandatory buyer ID)

**DB migration run ✓:**
```sql
ALTER TABLE pos_orders DROP CONSTRAINT IF EXISTS pos_orders_payment_method_check;
ALTER TABLE pos_orders ADD CONSTRAINT pos_orders_payment_method_check
  CHECK (payment_method IN ('Cash','Card','eSewa','Khalti','FonePay','Credit'));
```

**`src/modules/pos/orders/PosOrders.jsx` — Pay tab**
- New **Credit** button on the payment-method row, styled red to stand out from Cash/Card/eSewa/Khalti/FonePay, visible only to Manager+ (`hasPosAccess('manager')`) — stricter than Discount's Supervisor+.
- Researched how Toast/Lightspeed handle this (House Accounts / Customer Credit): the order **closes normally as a real sale** — consumes a Tax Invoice/Bill number, writes `sales_entries`, counts in revenue reporting immediately — only the *collection* is deferred, not the sale itself. Crest's Credit button follows the same accrual pattern: `payment_method: 'Credit'`, `paid_amount` is the full billed total (not the amount actually collected), no Tender/Change shown (same as Card/eSewa/etc).
- New shared `requireBuyerId` computed flag (`discountAmt > 0 || payMethod === 'Credit'`) — buyer Name + Phone become compulsory under either condition, reusing the exact same red-border/disabled-Confirm-button mechanism built for Discount in S219 rather than duplicating it.
- **Known gap, deliberately deferred (per user decision):** no outstanding-balance ledger or "mark as collected" action yet — a Credit bill just sits as billed-but-uncollected. Fast-follow scope (not this session): a small `customers` table (dedup by phone, already captured on every buyer-required order) backing both a Credit balance/collection view and a general customer lookup; plus a combined Discount/Void/Comp "Sales Exception Report" (industry-standard pattern per SpotOn/Rezku — tracked by reason/employee/date, not three separate reports).

### S219 — 2026-07-02 — POS Billing: order-level Discount (₨/% toggle, mandatory reason + buyer ID)

**DB migration run ✓:**
```sql
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS discount_amount numeric;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS discount_reason text;

ALTER TABLE settings ADD COLUMN IF NOT EXISTS pos_discount_reasons text[];
```

**`src/modules/pos/orders/PosOrders.jsx` — Pay tab**
- New Discount input on the Pay tab: a `₨`/`%` mode toggle + amount field. Percent mode shows a live "≈ NPR X" hint. Discount reduces the pre-VAT taxable base, and VAT is recalculated on the discounted amount (matches the existing `purchase_entries.discount_amount` convention in Purchases.js — *"Applied before VAT, VAT is levied only on the net taxable amount"*), not a flat subtraction off the total.
- **Applying any discount makes buyer Name and Phone compulsory** (they're normally optional under the IRD ≤NPR 10,000 abbreviated-invoice exemption) and requires selecting a **Discount Reason** — Confirm Payment stays disabled until both are filled in, giving an identifiable, audited record of who received every discount.
- Discount reasons are admin-customizable (new **Discounts** tab in Table Management — see below), not a hardcoded list, but ship with sensible built-in defaults (Loyalty customer, Promo/coupon code, Manager goodwill, Bulk/corporate order, Price match, Other) so the dropdown is never empty on a new client.
- `buildBillHtml()` now reads the real `order.discount_amount` (was a hardcoded `0` placeholder since S218) — Gross Amount stays the pre-discount figure, Taxable/Nontaxable/VAT rows are scaled down proportionally by the discount ratio, Net Amount reflects the discounted total. The live in-modal preview reflects the discount as it's typed, same as every other field.
- The modal's header total, Tender placeholder, Change math, and Confirm Payment button all switch to the discounted `payTotal` on the Pay tab — the Void tab still shows the full undiscounted total (a discount typed into the Pay tab must not leak into Void's display).
- `pos_orders.paid_amount` is written as the discounted total, so Recent Bills / any future revenue reporting automatically reflects real collected revenue with no separate changes needed.
- Scope: whole-order only (one discount per bill), not per line-item — matches the single "Discount" row already on the printed invoice; item-level discount/comp is a flagged future gap alongside item-level Complimentary.

**`src/modules/pos/tables/PosTableManagement.jsx`** — new **Discounts** tab (Supervisor+, same page-level gate as the rest of Table Management), built as a line-for-line mirror of the existing Quick Notes tab: a `text[]` column on `settings` (`pos_discount_reasons`), managed via a chip-list add/remove/save UI, falling back to the same built-in defaults when empty.

### S218 — 2026-07-02 — Tax Invoice/Bill print overhaul: two-column preview, Gross Amount fix, Round Off, IRD copy terms

No DB migration.

**`src/modules/pos/orders/PosOrders.jsx` — Billing modal & print templates**
- Billing modal restructured to a two-column layout: live bill/slip preview pinned on the left (sized to 100mm, with the 80mm receipt body centered inside — no lopsided blank gap), form fields/tabs/buttons scrollable on the right. Modal widened to `min(980px, 96vw)`.
- **Fixed a real Gross Amount bug** — `buildBillHtml()` was computing `gross = subEx + vatAmt` and `net = gross`, so Gross Amount and Net Amount printed the identical VAT-inclusive figure. Gross Amount now correctly shows the ex-VAT sum (`subEx`), matching the reference Casa Acai invoice where Gross = Taxable when there's no discount.
- Added a **Discount** row (hardcoded `0.00` — no discount feature exists yet, but IRD-format invoices expect the line) between Gross Amount and Taxable/VAT.
- Added a **Rate** column and reordered the item table to `Sn | HSC | Particulars | Qty | Rate | Amount`, matching the reference invoice. Fixed-width columns (`table-layout:fixed`) to stop header text (Qty, Sn) from wrapping and numeric columns from squashing together.
- Combined buyer PAN No/Phone into a single row; kept Remarks.
- Moved the Dine-In/Table + Cashier identity line up from the bottom footer to directly after Remarks (before the item table).
- Relabeled that identity line from "Counter:" to **"Dine-In: {table}"** / **"Takeaway"** — researched that "Counter:" is quick-service terminology; table-service receipts standardly show "Table"/"Server" (confirmed via Toast POS docs).
- **Round Off row** — `net` is now rounded to the nearest rupee so Net Amount matches the amount-in-words line (previously could print e.g. "1039.99" next to "Rs. One Thousand Forty only" — a visible mismatch). New "Round Off: +0.01"-style row between VAT 13% and Net Amount. The modal's live total/Confirm Payment amount/`paid_amount` is rounded the same way so what's charged always matches what prints.
- Relabeled "PAN No.:" to conditional **"VAT No: "** (VAT-registered) / **"PAN No: "** (non-VAT) for the outlet's own registration number.
- **Copy-label terminology corrected to match Nepal IRD's Rule 17 wording** — researched and confirmed IRD's three-copy rule is Original (buyer) / Duplicate (produced to authorities on demand) / Triplicate (seller's own record). Relabeled `COPY_LABEL()` from ORIGINAL/DUPLICATE/TRIPLICATE to **ORIGINAL-COPY/SECOND-COPY/THIRD-COPY**, moved to print below the TAX INVOICE/BILL header instead of at the very top.
- All font sizes reduced by 1px across both the Tax Invoice/Bill and Complimentary Slip templates; footer message changed to "Thank you for stopping by! We hope to see you again soon."

**Sources:** [BizSewa — Nepal VAT Tax Invoice Formats (Schedule 5)](https://bizsewa.com/nepal-amends-vat-rules-new-tax-invoice-formats-introduced-new-vat-bill-format/), [Union Nepal — VAT Bill in Nepal](https://www.unionnepal.com/vat-bill-in-nepal), [Nepal Taxes — Provisions Relating to Invoices](https://nepaltaxes.com/provisions-relating-to-invoices-guide-to-invoice-abbreviated-tax-invoice/), [Toast — Configuring customer printed receipts](https://doc.toasttab.com/doc/platformguide/adminReceiptSetup.html)

### S217 — 2026-07-02 — Complimentary Slip polish: outlet name, NC sequence, more reasons, live bill preview

**DB migration required** — re-run `assign_pos_invoice_no()` (idempotent `CREATE OR REPLACE`, safe to re-apply):
```sql
CREATE OR REPLACE FUNCTION assign_pos_invoice_no()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'billed' AND NEW.invoice_no IS NULL AND NEW.invoice_fy IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('pos_invoice_no:' || NEW.client_id::text || ':' || NEW.invoice_fy || ':' || NEW.close_type));
    SELECT COALESCE(MAX(invoice_no), 0) + 1 INTO NEW.invoice_no
    FROM pos_orders WHERE client_id = NEW.client_id AND invoice_fy = NEW.invoice_fy AND close_type = NEW.close_type;
  END IF;
  RETURN NEW;
END $$;
```
Adds `close_type` to the partition key so Pay (TI/PB) and Complimentary (NC) get **independent counters** instead of sharing one sequence.

**`src/modules/pos/orders/PosOrders.jsx`**
- **Complimentary Slip now prints the outlet name** (reversing S216's "no company name" call) and a **sequential `NC-01`-style number**, same per-fiscal-year reset mechanic as Tax Invoice/PAN Bill numbers but its own counter (see migration above). `closeOrder()` now sets `invoice_fy` for Complimentary too, not just Pay.
- **`COMP_REASONS`** gained `Owners` and `Company Guest` alongside the existing walkout/goodwill/complaint/staff-error/other options.
- **Food-cost preview fix** — the modal's on-screen item list was always showing menu price, even on the Complimentary tab, so what the cashier saw didn't match what the slip would print. New `openCompTab()` fetches `computeRecipeCosts()` into `compCostMap` as soon as that tab opens; the header total and item list both switch to food-cost values while on it.
- **Live bill/slip preview** — `printBill()`/`printCompSlip()` split into pure `buildBillHtml()`/`buildCompSlipHtml()` (no DB calls, no side effects) plus a thin orchestrator that fetches data and prints. The same pure builders now also render a **live preview** inside the modal (an `<iframe srcDoc={...}>`, real 80mm receipt layout, updates as buyer/payment/reason fields are typed) — guarantees the preview can never drift from what actually prints, since it's the exact same code path. Void has no preview (nothing prints for a Void).

### S216 — 2026-07-02 — Billing refinements: itemized review, Supervisor-only Charge, Write-off → Complimentary

Follow-on polish to S215's Billing/Charge screen, no DB migration needed.

**`src/modules/pos/orders/PosOrders.jsx` — Billing modal**
- **Itemized order review** — the modal previously showed only the grand total with no line items, so a cashier had no way to visually verify what they were about to charge/void/comp before confirming. Researched checkout UX practice ([Baymard](https://baymard.com/learn/checkout-flow-ux-optimization), [TouchBistro](https://www.touchbistro.com/blog/the-ultimate-guide-to-payment-processing-for-restaurants/)) — a visible order summary before payment is standard. Added a scrollable item list (`×N Name — NPR amount`, notes indented italic, same convention as KOT/BOT tickets) between the total and the tab bar, visible on all three tabs.
- **Charge → is now Supervisor+ only, hidden entirely for Staff** — previously any staff could open the Pay tab. The button no longer renders at all (not just disabled) for `pos_role='staff'`, matching how Void/Write-off were already hidden for lower roles. Corrected the role-permission strip in `PosStaff.jsx` (`PERMISSION_LEVELS`) and Help.js copy to match — Staff = "Take orders, view floor" only, billing moved to Supervisor's description.
- **Write-off renamed to Complimentary, and redesigned as an internal document — not a Tax Invoice or PAN Bill.** Researched restaurant accounting practice for comps: industry term is "NC" (No Charge), synonymous with "Comp" — an item that was made and served but not charged, which must still count in sales/inventory/food-cost reporting (unlike a Void, which never happened). Confirmed via [Restaurant365](https://www.restaurant365.com/blog/how-to-reduce-restaurant-comps-and-voids/) and [ARF Financial](https://www.arffinancial.com/restaurant-comps-on-the-pl/) that standard practice values comps **at food cost, not menu price**, so retail pricing doesn't distort the P&L.
  - `close_type: 'writeoff'` (DB value unchanged — only the user-facing label changed) no longer gets a sequential `invoice_no`/`invoice_fy` — a comped item was never sold, so it can't be a Tax Invoice or PAN Bill and must not consume that numbering sequence
  - New `printCompSlip()` prints a distinct **"COMPLIMENTARY SLIP"** — explicitly labelled "Internal record — not a Tax Invoice or PAN Bill", **no outlet/company name printed at all**, no PAN/VAT number, no invoice number. Shows internal order #, reason, who authorized it, and each line valued at **food cost** (via new `computeRecipeCosts()` util) instead of menu price
  - Buyer Name/Address/PAN/Phone fields removed from this tab (irrelevant — it's not a tax document); replaced with a simple optional Remarks field
  - `sales_entries` still written exactly as before — the "still counts in food-cost/inventory reporting" requirement was already true from S215, unchanged here
  - Reprint (Recent Bills) now branches to `printCompSlip()` for `close_type='writeoff'` orders instead of `printBill()`

**`src/utils/recipeCost.js`** — new `computeRecipeCosts(supabase, recipeIds)`, mirrors `MenuPricing.js`'s cost-per-portion calculation (ingredient rate × qty ÷ yield%, one level of sub-recipe recursion), scoped to an arbitrary recipe id list rather than the client's full menu. Not yet deduplicated against `MenuPricing.js`'s inline version — a future cleanup, not done this session to avoid touching a working page.

**Sources:** [Baymard — Checkout Flow UX](https://baymard.com/learn/checkout-flow-ux-optimization), [TouchBistro — Restaurant Payment Processing](https://www.touchbistro.com/blog/the-ultimate-guide-to-payment-processing-for-restaurants/), [Reelo — Comps glossary](https://reelo.io/glossary/comps/), [Restaurant365 — Comps vs Voids](https://www.restaurant365.com/blog/how-to-reduce-restaurant-comps-and-voids/), [ARF Financial — Accounting for Comps on the P&L](https://www.arffinancial.com/restaurant-comps-on-the-pl/), [David Scott Peters — Void vs Comp](https://www.davidscottpeters.com/blog/Independent-Restaurant-Tip-for-Difference-Between-a-Void-and-a-Comp)

### S215 — 2026-07-02 — Billing / Charge screen — Void/Write-off + Nepal IRD tax-invoice compliance

Researched IRD (Nepal Inland Revenue Department) VAT/PAN billing rules before building — see sources at the bottom of this entry. Built the entire close-a-table flow from scratch; previously `pos_orders.status` never left `'open'` and nothing released a table back to `'available'`.

**`src/modules/pos/orders/PosOrders.jsx` — Charge → Billing modal**
- Three tabs, role-gated with the existing `hasPosAccess()`: **Pay** (staff+ — Cash/Card/eSewa/Khalti/FonePay, Tender/Change for Cash), **Void** (supervisor+ — mistake/duplicate/test order, no revenue or food-cost impact, no invoice number consumed), **Write-off** (manager+ — walkout/comp/complaint, ₨0 collected but still counts as a sale so `sales_entries` still gets written for food-cost accuracy)
- Optional buyer Name/Address/PAN/Phone/Remarks — IRD allows omitting these for bills ≤ NPR 10,000 (abbreviated invoice); fill in when a customer requests a full invoice
- `closeOrder()` writes `close_type`/`payment_method`/`paid_amount`/`tendered_amount`/`close_reason`/buyer fields, releases the table, writes `sales_entries` (source `'pos'`) for Pay/Write-off by resolving the open BS period + today's `bs_day` (same pattern as `Sales.js`), then prints the bill
- **Sequential tax-invoice numbering per Nepal fiscal year** — new `assign_pos_invoice_no()` trigger (mirrors S211's `assign_pos_order_no()` advisory-lock pattern, keyed by `client_id + fiscal_year`), fires on the `status → 'billed'` transition. Only Pay/Write-off consume a number; Void never does, since a voided order was never actually invoiced
- **Printed bill** (`printBill()`, same 80mm thermal pattern as `printTicket()`): header is `TAX INVOICE` (with Taxable/VAT/Net breakdown) if `settings.is_vat_registered`, else plain `BILL` (PAN only, no VAT line). Invoice number format `TI{seq}-{prefix}-{fy}` / `PB{seq}-{prefix}-{fy}`. Includes HSC code per line (live-looked-up from `recipes` by `recipe_id` at print time — see HSC redesign below), Tender/Change, Total Qty, amount-in-words (new `numberToWordsNpr()` util, Nepali Lakh/Crore numbering), Counter/Cashier
- **Copy labelling** — a thermal printer can't produce carbon triplicates like a manual bill pad, so the app prints one copy and labels it by a `print_count` counter: 1st = ORIGINAL, 2nd = DUPLICATE, 3rd = TRIPLICATE, 4th+ = REPRINT #N. "📄 Recent Bills" on the floor view lists today's closed orders with a Reprint button, satisfying IRD's 6-year-retention duty via a reproducible digital record rather than physical triplicate copies
- Floor view: admin-only `⚠ Clear Occupied` testing button unaffected (still scoped to `status='open'` only)

**`src/utils/bsCalendar.js`** — new `getBsFiscalYear(bsYear, bsMonth)`, Shrawan(4)→Ashadh(3) rule, returns `'82/83'`-style label.
**`src/utils/numberToWords.js`** (new) — integer-rupee amount-in-words, Nepali Lakh/Crore numbering.
**`src/pages/AdminClients.js`** — Settings tab: new `VAT Registered` toggle and `Invoice Prefix` field (auto-suggested from property-name initials, e.g. "Casa Acai Cafe" → "CAC", editable) next to VAT Number. *(Discovered along the way: the client-facing `Settings.js` "Property" tab was unreachable — filtered out of `TABS` for both admin and client roles by a pre-existing asymmetry between `ADMIN_TABS` and `CLIENT_HIDDEN`. Fixed same session — `Property` added to `ADMIN_TABS`, and the same VAT Registered/Invoice Prefix fields added there too for parity with `AdminClients.js`, plus a checkbox CSS fix: `.form-field input` is a descendant selector meant for text inputs, which was also stretching the checkbox into a giant empty box — fixed with explicit inline sizing on both checkboxes.)*

**HSC Code — redesigned mid-session after a regression.** Originally added as a `recipes.hsc_code` field editable inline in both `MenuPricing.js` branches, denormalized onto `pos_order_items.hsc_code` at order-save time. That broke Menu Pricing (blank item list) **and silently broke core Order Taking** — `loadMenu()`, `openTable()`, and `performSave()` all referenced the not-yet-migrated columns, so menu loading, opening an existing order, and saving/updating any order all failed until the migration ran. Redesigned: `recipes.hsc_code` is now the only column (no `pos_order_items.hsc_code` — removed from the migration below); `printBill()` does a live `.in('id', recipeIds)` lookup by `recipe_id` at print time instead of denormalizing. Editing UI moved out of Menu Pricing entirely into a single new **HSC Codes** tab in `src/modules/pos/tables/PosTableManagement.jsx` (alongside Tables / Ticket Routing / Quick Notes), lazy-loaded so it can't break any other tab or screen if the migration hasn't run yet — only that one tab would show empty until then. Researched the actual IRD rule while fixing the tooltip copy too: HSC is only mandatory for items that are **imported goods sold as-is** (e.g. imported bottled drinks), never for freshly prepared dishes — the field stays optional/blank for the vast majority of any F&B menu.

**DB migration (S215) — run ✓ 2026-07-02**
```sql
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS close_type      text CHECK (close_type IN ('paid','writeoff','void'));
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS payment_method  text CHECK (payment_method IN ('Cash','Card','eSewa','Khalti','FonePay'));
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS paid_amount     numeric;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS tendered_amount numeric;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS close_reason    text;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS closed_by       uuid REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS buyer_name    text;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS buyer_address text;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS buyer_pan     text;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS buyer_phone   text;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS bill_remarks  text;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS invoice_no integer;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS invoice_fy text;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS print_count integer DEFAULT 0;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS is_vat_registered boolean DEFAULT true;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS invoice_prefix    text;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS hsc_code text;

CREATE OR REPLACE FUNCTION assign_pos_invoice_no()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'billed' AND NEW.invoice_no IS NULL AND NEW.invoice_fy IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('pos_invoice_no:' || NEW.client_id::text || ':' || NEW.invoice_fy));
    SELECT COALESCE(MAX(invoice_no), 0) + 1 INTO NEW.invoice_no
    FROM pos_orders WHERE client_id = NEW.client_id AND invoice_fy = NEW.invoice_fy;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_assign_pos_invoice_no ON pos_orders;
CREATE TRIGGER trg_assign_pos_invoice_no BEFORE UPDATE ON pos_orders FOR EACH ROW EXECUTE FUNCTION assign_pos_invoice_no();
```

**Known limitations (documented, not solved this session):** `Sales.js` manual entry can still overwrite POS-written `sales_entries` for the same day (unscoped delete-then-reinsert); no in-app manager-PIN re-auth for Void/Write-off (role-gated by the signed-in user only); no reporting page yet (Payment Summary / write-off totals); no Credit Note workflow for correcting an already-billed order (IRD requires a formal Credit Note — accountant-handled, outside the app); no real-time IRD CBMS e-billing integration (not legally required below NPR 5 crore/year for restaurants — far above any realistic Crest client); no Service Charge line (considered, explicitly deferred).

**Sources:** [Union Nepal — VAT Bill](https://www.unionnepal.com/vat-bill-in-nepal), [Union Nepal — PAN Bill](https://www.unionnepal.com/pan-bill-in-nepal), [Common Law Nepal — VAT Invoice Rules & Penalties](https://commonlaw.com.np/publications/vat-invoice-rules-and-penalties-in-nepal), [eStartup Nepal — VAT vs PAN Bill](https://estartupnepal.com/article/vat-and-pan-bill-in-nepal), [HamroInvoice — IRD Bill Format & HS Code Guide](https://hamroinvoice.com/blog/nepal-ird-bill-format-hs-code-guide), [eStartup Nepal — E-Billing in Nepal](https://estartupnepal.com/article/e-billing-in-nepal), [Kathmandu Post — Extra charge cannot be added to menu](https://kathmandupost.com/money/2022/09/28/vat-service-charge-added-to-food-bill-deemed-illegal)

### S214 — 2026-07-02 — KOT/BOT remarks, BS ticket date, pending-ticket indicators, admin table reset

**`src/modules/pos/orders/PosOrders.jsx`**
- Ticket date now prints in Bikram Sambat (`adToBs`/`BS_MONTHS`) instead of AD
- Per-item note field (`+ Add note`) on order lines — free-typed remark prints indented under that item on the KOT/BOT (`↳ no onion`). Editing a note after the item was already sent flips it back to unsent (same pattern as qty-change) so staff know to resend
- Quick-note chips: while a note field is focused, preset chips from `settings.pos_note_presets` appear below it — tap to append instead of typing (`onMouseDown` `preventDefault` keeps focus so the click registers before blur)
- Floor view: amber `⚠ N tables · M items pending` pill under `+ Takeaway`, plus a small `⚠ N` badge per occupied table card — both derived from `sent_to_kot` on open orders (added to `loadFloor()`'s select), catching orders added but never fired to the kitchen/bar
- Admin-only `⚠ Clear Occupied` button (testing utility) — confirms, then deletes all open orders/items for the client and releases occupied tables back to `available`. Gated on `isAdmin` from AuthContext, not POS role

**`src/modules/pos/tables/PosTableManagement.jsx`**
- New **Quick Notes** tab (alongside Tables / Ticket Routing) — manager types a phrase, saves to `settings.pos_note_presets text[]`, staff see it as a tappable chip in Order Taking

**DB migration (S214) — run ✓**
```sql
ALTER TABLE settings ADD COLUMN IF NOT EXISTS pos_note_presets text[];
```

**`src/pages/Help.js`** — Order Taking + Table Management entries: 5 new tips covering BS ticket dates, per-item notes, quick-note chips, resend-on-edit behavior, and the pending-tickets floor indicator

**Design decision (not built this session):** researched walkout/no-payment handling for the upcoming Billing/Charge screen — decided on a split **Void** (mistake, excluded from revenue/food-cost) vs **Write-off** (walkout/comp, still counts as a sale for food-cost accuracy, ₨0 collected) rather than one generic "close without payment" action. Deferred until the Billing session starts; decision recorded in project memory so it isn't re-litigated then.

### S213 — 2026-07-02 — Dashboard: trend chart tooltip label color fix

**`src/pages/Dashboard.js`** — daily trend chart Tooltip (Purchases/Sales/Projection) had no `labelStyle`, so the "Day N" label rendered in Recharts' default dark text — unreadable on the dark theme card. Added `labelStyle={{ color: '#fff' }}`.

### S212 — 2026-07-02 — Purchases: item count in Add Purchase Bill summary

**`src/pages/Purchases.js`** — bill footer now shows an "Items: N" line above Taxable/Non-taxable, counting valid lines (item selected, qty > 0, rate > 0) — same count already used for the "Save N Entries" button label.

### S211 — 2026-07-02 — KOT/BOT ticket upgrade: order number, outlet name, Taken by

Benchmarked our ticket against a real CMS Hospitality (competitor) order slip; added the three fields it had that we lacked. Kept our advantages: `+N` addition deltas, station-specific titles (KOT/BOT), `×N` qty format, wrap-safe flex rows.

**`src/modules/pos/orders/PosOrders.jsx`**
- `pos_orders.order_no` — per-client sequential order number, assigned by DB trigger on insert (advisory-lock serialized, race-safe)
- Order number threaded through: `openTable` (existing order select), `performSave` (returns `{ oid, oNo }` so first-save tickets have it before state flushes), reset in `confirmCovers`/`openTakeaway`/`backToFloor`
- Ticket header now prints: outlet name (`clients.name`, centered top) → station title → table name + bold `#N` → `Taken by: <staff full_name>` + `Covers: N` → date/time
- Top bar shows accent `#N` chip (with Tip) once the order is saved
- All three new fields degrade gracefully — line omitted if missing (e.g. migration not yet run → no `#N`)

**`src/pages/Help.js`** — Order Taking entry: 2 new tips (order number, outlet name/Taken by on tickets)

**DB migration (S211) — `pos_order_no.sql`**
- `ALTER TABLE pos_orders ADD COLUMN order_no integer` + `assign_pos_order_no()` BEFORE INSERT trigger (per-client `MAX+1` under `pg_advisory_xact_lock`) + backfill of existing orders by `created_at`

**IMS debug sweep (same session)**
- `Dashboard.js` — `recipe_ingredients` was fetched UNSCOPED (no `.in('recipe_id', …)`); pulled every client's rows into the browser (results were filtered client-side so numbers were correct, but it was a cross-tenant leak surface + growing payload). Now fetched after recipes, scoped by recipe IDs.
- NULL `client_id` guard added to 5 unguarded inserts: `Dashboard.closeAndAdvancePeriod` (monthly_periods), `ReorderReport.savePar` (par_levels), `MenuPricing.saveNewItem` (recipes), `MenuPricing.savePairings` (recipe_suggestions), `OutstandingPayables.addPayment` (payable_payments)
- Verified clean: `is_sub_recipe` filters (all 6 required pages), `per_uom_rate` never in write payloads, Sales/Stock/Purchases inserts period-scoped (no client_id column exposure)

### S210 — 2026-07-02 — Upsell/Cross-sell ME suggestion engine (all 3 layers)

**`src/pages/MenuEngineering.js` — me_class writeback**
- After classifying all recipes, fires background upsert of `me_class` to DB per item (`r.quadrant.toLowerCase()`)
- Silent, no UI impact — next POS menu load picks up quadrant data automatically

**`src/modules/pos/orders/PosOrders.jsx` — suggestion chips (3 layers)**
- `me_class` added to menu select query; `manualSuggestions` state loaded from `recipe_suggestions` table alongside menu
- `menuLoaded` reset in `backToFloor()` so menu reloads fresh on each table open (picks up new me_class writes)
- `computeSuggestions(recipe)` — async, fires on every `addItem()`:
  - **Layer 3 (immediate)**: manual pairings from `recipe_suggestions` score 100 — always first, accent-color "PAIRED" badge
  - **Layer 2 (immediate)**: ME scoring — Stars 10, Puzzles 6, others 2; cross-category +3 always; Plowhouse same-category −4; Puzzles get amber "CHEF'S PICK" badge
  - **Layer 1 (async re-rank)**: `get_cooccurrence` RPC fires after initial chips shown; adds 0–5 co-occurrence bonus then re-ranks
- "Pair with" chip strip shown between order items and totals; ✕ dismiss; chips show name + price + badge

**`src/pages/MenuPricing.js` — manual pairings UI (POS-only view only)**
- "Pair" inline link added to each row in the POS-only slim table (clients without IMS)
- Clicking opens "Pair with" modal: searchable checklist of all other items, checkbox multi-select, Save (N) button
- `suggMap` state loaded in `load()` from `recipe_suggestions`; updates locally on save
- IMS view unchanged (IMS+POS clients use ME intelligence; manual pairings not needed)

**DB migrations run (S210)**
- `ALTER TABLE recipes ADD COLUMN IF NOT EXISTS me_class text CHECK (me_class IN ('star','plowhouse','puzzle','dog'))`
- `CREATE TABLE recipe_suggestions (...)` with RLS + policy + GRANT
- `CREATE OR REPLACE FUNCTION get_cooccurrence(...)` RPC — co-occurrence join on `pos_order_items` + `pos_orders`, 90-day window, top 10

**Memory**
- `feedback_menu_pricing_branches.md` — always ask which branch (POS-only or IMS) before editing MenuPricing.js

### S209 — 2026-07-02 — Auto-send KOT/BOT + Tooltips + Help page + Upsell/ME design

**`src/modules/pos/orders/PosOrders.jsx` — auto-send on new order**
- `Send Order` (new table) now auto-fires KOT and BOT tickets immediately on first save — no extra button press needed
- `Update Order` (existing order) saves only; staff press KOT/BOT manually for additions (delta tracking unchanged)
- Button label changed: "Save Order" → "Send Order" for new orders; spinner shows "Sending…"
- `saveOrder()`: captures `wasNew = !orderId` before `performSave()`; on new order marks all items `sent_to_kot: true` in DB, updates local state, prints both tickets

**Tooltips added**
- KOT button: "Kitchen Order Ticket — sends unsent food items to the kitchen printer. Badge shows how many items are waiting."
- BOT button: "Bar Order Ticket — sends unsent bar/beverage items to the bar printer."
- ✓ KOT/BOT sent badge: explains ticket already sent, only press again for additions
- +N amber badge: explains how many extra added since last ticket, prompts KOT/BOT
- Ticket Routing tab: explains KOT/BOT concept on hover

**`src/pages/Help.js` — new Order Taking entry + Table Management update**
- Added full Order Taking entry with 6 tips covering Send Order auto-send, +N badge, ✓ badge, routing config
- Updated Table Management entry to describe Ticket Routing tab and default Beverage → BOT behaviour

**Research & design: Upsell / Cross-sell + Menu Engineering integration**
- Researched ME quadrant strategies (Stars, Plowhorses, Puzzles, Dogs) and their point-of-sale implications
- Designed three-layer suggestion engine: co-occurrence (Layer 1) + ME filter overlay (Layer 2) + chips UI (Layer 3)
- Key insight: ME filter corrects co-occurrence — suppresses Dogs, redirects Plowhorse cross-sells to high-margin categories, injects Puzzles that never appear in co-occurrence because nobody orders them unprompted
- Architecture: `me_class` column on `recipes` (written back when ME report runs) + `recipe_suggestions` table + co-occurrence query + JS filter logic
- Feature gating: POS Starter = category nudge; POS Growth = manual suggestions; POS+IMS Growth = co-occurrence; POS+IMS Pro = full ME filter + Puzzle injection

### S208 — 2026-07-02 — KOT \& BOT + Ticket Routing + Menu Pricing food cost fix

**`src/pages/MenuPricing.js` — sub-recipe food cost fix**
- IMS clients whose recipes use sub-recipe ingredients (e.g. AMERICANO with "2 sub") showed "—" for food cost
- Root cause: `load()` only read `items.per_uom_rate` directly; sub-recipe ingredients have `sub_recipe_id` not `item_id`, so `ri.items` was null → cost = 0
- Fix: fetches sub-recipes + their ingredients in parallel; recursive `subCostPerUnit()` computes cost per sub-recipe unit (same logic as Recipe Costing); main recipe cost accumulates both item and sub-recipe costs
- Food costs in Menu Pricing now match Recipe Costing exactly

**`src/modules/pos/orders/PosOrders.jsx` — KOT \& BOT**
- **DB:** `ALTER TABLE pos_order_items ADD COLUMN IF NOT EXISTS category text;`
- `category` stored per order item (from `recipe.category` at add time; preserved on `performSave`; loaded when resuming existing orders)
- KOT button → Food/Dessert/Snack/Other categories; BOT button → Beverage (routing configurable via Ticket Routing tab)
- Both buttons show a red badge with unsent-item count; disabled when nothing to send
- Sent items show green **✓ KOT** or **✓ BOT** badge in the order panel
- `performSave()` helper: refactored save to preserve `sent_to_kot` + `category` on delete+re-insert (old logic always reset `sent_to_kot: false`)
- Print: 80mm thermal-ready pop-up window, `window.print()`

**KOT/BOT — qty bump delta tracking**
- `sent_qty` field tracks how many of each item have already been sent to a station
- Bumping qty on a sent item → amber **+N** badge next to item name (e.g. "+1") in the order panel
- Print ticket: bumped items print as `+1 Pasta` not `×3 Pasta` — kitchen knows to make 1 more, not restart
- `sent_qty` updates to current `qty` when KOT/BOT is sent

**`src/modules/pos/tables/PosTableManagement.jsx` — Ticket Routing tab**
- **DB:** `ALTER TABLE settings ADD COLUMN IF NOT EXISTS pos_bot_categories text[];`
- New top-level tab bar on Table Management: **Tables** | **Ticket Routing**
- Ticket Routing lists all POS-enabled recipe categories with a KOT/BOT pill toggle per row
- Categories pulled from `recipes WHERE pos_enabled = true` — works for both IMS and POS-only clients
- Saves to `settings.pos_bot_categories`; default `['Beverage']` → BOT
- PosOrders loads routing on mount; falls back to `['Beverage']` if not set
- Use case: assign "Cakes" (in Beverage) to KOT, or route a "Kitchenette" category independently

- **Files:** `src/pages/MenuPricing.js`, `src/modules/pos/orders/PosOrders.jsx`, `src/modules/pos/tables/PosTableManagement.jsx`

---


### S207 — 2026-07-01 — Menu Pricing: POS-only view + Add Item + DB fix

**DB fix:** `feature_flags` table was missing the `menu_pricing` column — admin Save was failing with schema cache error. Fix: `ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS menu_pricing boolean;`

**`src/pages/MenuPricing.js` — dual-mode rendering**
- POS-only clients (no IMS) saw "No menu items found. Add recipes in Recipe Costing first." — unusable since they can't access Recipe Costing
- Added `clientModules` to `useAuth()` destructure; `!clientModules.ims` triggers a separate early return for POS-only clients
- **POS-only view**: slim table (# | On POS | Item | Price) + `+ Add Item` button + modal to create menu items directly (name, category, VAT toggle, price incl-VAT). Items inserted into `recipes` table with `pos_enabled: true`
- **IMS view**: full food-cost/FC%/new-price table completely unchanged — zero impact on IMS clients
- Empty-state message updated: "No menu items yet. Use **+ Add Item** above to add your first item."

---

### S206 — 2026-07-01 — POS order-taking polish + admin feature access fix

**`src/pages/AdminClients.js` — FeatureAccessModal**
- Previously blocked admin from granting any feature flags when `ims_enabled = false` ("Crest IMS only" wall)
- Replaced single `!imsEnabled` guard with three-branch ternary: (1) neither IMS nor POS → updated block message; (2) POS-only → slim grid showing only `menu_pricing` toggle (manually grantable, not plan-locked); (3) IMS enabled → full `FEATURE_GROUPS` grid as before
- Added `posEnabled = !!client.pos_enabled`; header `activeModule` now reads `POS` for POS-only clients; Save button + hint text shown in POS-only mode too

**`src/modules/pos/orders/PosOrders.jsx` — covers modal + UI polish**
- **Covers modal on new table**: tapping an available table now shows a modal asking for cover count before entering the order screen; tables with an existing open order skip the modal
- **Numpad input**: replaced +/− stepper with a full 3×3 digit pad (1–9, CLR, 0, ⌫); digits append to string display; caps at 99; defaults to 1 if confirmed empty
- **Button centering**: all full-width buttons use `justifyContent: 'center'` (`.btn` is `inline-flex`; `textAlign` alone had no effect)
- **Cancel button**: matched Open Order button size; styled `btn-danger` (red)

---

### S205 — 2026-07-01 — POS Order Taking (`/pos/orders`)

New page for taking table orders. Full-screen two-panel UI: left = menu browser, right = live order bill.

**SQL run (Supabase):**
```sql
CREATE TABLE pos_orders (id uuid PK, client_id, table_id, table_name, status DEFAULT 'open', covers DEFAULT 1, notes, opened_by, opened_at, closed_at, created_at)
CREATE TABLE pos_order_items (id uuid PK, order_id FK→pos_orders CASCADE, client_id, recipe_id, name, qty, unit_price ex-VAT, vat_rate, notes, sent_to_kot bool DEFAULT false, created_at)
-- RLS + GRANT on both tables
```

**`src/modules/pos/orders/PosOrders.jsx`** (new)
- **Floor view** — table grid showing running total + item count on occupied tables; accent border on tables with open orders; "Takeaway" button for non-table orders
- **Order screen** — `position: fixed` full-screen overlay (hides sidebar entirely for max screen space)
  - Top bar: back button, section label, covers stepper
  - Left panel: category tabs + item grid; items gated on `pos_enabled` (`or('pos_enabled.is.null,pos_enabled.eq.true')`); qty badge on items already in the order
  - Right panel (320px): order items list with `−`/`+` qty steppers + `×` remove; Subtotal (ex-VAT) / VAT / TOTAL breakdown; **Save Order** / **Update Order** button; KOT + Charge buttons stubbed out (disabled, tooltipped "coming next session")
- On first save: creates `pos_orders` row, inserts all items, auto-sets table status → `occupied`
- On update: syncs covers to order, delete-all + re-insert items (KOT session will add smarter diffing)
- Accessible to all `pos_role` levels including staff (supervisor/manager auto-pass via `hasPosAccess`)
- Menu loads lazily on first open to avoid loading all recipes on the floor view

**`src/App.js`** — added `PosOrders` import + `/pos/orders` route (ModuleGate pos)
**`src/components/Layout.js`** — added `Orders` nav item (icon ◉, minPosRole: 'staff') to `pos-floor` group above Tables
**`src/modules/pos/Pos.js`** — removed "Order taking" from coming-soon text

---

### S204 — 2026-07-01 — Memory sync + Stock.css CSS variable cleanup

**Memory files updated** to reflect full current state (S193–S203):
- `memory/product_roadmap.md` — HR marked fully complete (all 12 sessions done S177); POS status changed from "Planned" to "Building Now" with built-features table (Tables, PIN Login, Staff CRUD, Custom Roles, Menu Pricing), DB columns, edge function actions, RPCs, and ordered next-build list; Owner Dashboard gate confirmed (build last, Suite-only); HR deferred list updated (TADA, incentives, self-service PWA, biometric, roster publish/swap/forecast)
- `memory/project_modules.md` — Routes table updated with `/menu-pricing`, `/stock-report`, `/menu-repricing`, `/pos`, `/pos/login`, `/pos/tables`, `/pos/staff`; STARTER_KEYS updated to include `menu_pricing` + `stock_report`; GROWTH_KEYS updated to include `menu_repricing`; POS section expanded with full role system, edge function actions, RPC signatures, and DB column additions; HR pending list added; note corrected: `clients.pos_enabled` column NOW EXISTS (added S193)
- `memory/MEMORY.md` index — Product Roadmap description updated

**`src/pages/Stock.css` — CSS variable cleanup**
- All 12 hardcoded hex values replaced with CSS variables (25 total occurrences)
- `#181c27` → `var(--theme-card)` · `#2a2f3d` → `var(--theme-border)` · `#9ca3af` → `var(--theme-text3)` · `#c9a84c` → `var(--theme-accent)` · `#e8e0d0` → `var(--theme-text1)` · `#6b7280` → `var(--theme-text2)` · `#0f1117` (input) → `var(--theme-input-bg)` · `#0f1117` (save bar bg) → `var(--theme-bg)` · `rgba(201,168,76,0.15)` → `var(--theme-focus-ring)`
- Three rgba tints with no direct variable use `color-mix()`: `rgba(201,168,76,0.25)` → `color-mix(in srgb, var(--theme-accent) 25%, transparent)` · `rgba(201,168,76,0.35)` → `color-mix(in srgb, var(--theme-accent) 35%, transparent)` · `rgba(251,191,36,0.5)` → `color-mix(in srgb, var(--theme-amber) 50%, transparent)`
- Stock.css now fully theme-aware — mobile stock count UI (category strip, progress bar, item cards, save bar) adapts to all 9 presets
- **Files:** `src/pages/Stock.css`

---

### S203 — 2026-07-01 — POS staff access-level sync + PIN-picker lock flow

Bug fixes for POS staff role mismatches and sign-out UX. No DB changes.

**`src/modules/pos/staff/PosStaff.jsx`**
- Merged `load()` + `loadRoles()` into a single `init()` that runs both in parallel on mount. After loading, it silently detects and fixes any staff whose `pos_role` in the DB doesn't match the permission level configured for their `pos_job_title` (e.g. staff created before custom roles were properly configured all had `pos_role = 'staff'`). Fixes are applied via the `update_pos_role` edge function and reflected in local state immediately.
- Removed dead `loadRoles()` function (superseded by `init()`).

**`src/components/Layout.js`**
- `handleSignOut`: POS staff (has `posRole`, device bound via `pos_device_client_id` in localStorage) now redirect to `/pos/login` instead of `/login` after signing out. Owner and admin still go to `/login`. Matches standard POS shift-handoff behavior — staff tap lock and land back at the PIN picker.
- Sign-out button tooltip updated to "Lock POS" for staff, "Sign out" for everyone else.

---

### S202 — 2026-07-01 — POS onboarding fixes + dashboard improvements

Bug fixes discovered while onboarding the first real POS client (Choila Bhatti). No DB changes.

**`src/components/Layout.js`**
- POS sidebar was hidden for the client owner because the guard `(isAdmin || posRole)` excluded owners (`posRole = null` by design). Fixed to `(isAdmin || posRole || isOwner)`.

**`src/context/AuthContext.js`**
- `plan` was reading the legacy `plan` column only, so POS-only clients (IMS off) showed "Starter" in the sidebar. Now derives the highest tier across all enabled module plans (`ims_plan`, `hr_plan`, `pos_plan`).

**`src/pages/Dashboard.js`**
- "No open period" banner was showing for IMS-off clients (HR-only, POS-only) because `loadStats()` is skipped when IMS is off, leaving `activePeriod = null`. Gated the banner on `clientModules.ims`.
- Page `<h1>` title is now dynamic: Admin → `Admin Dashboard`; single-module clients → `Inventory / HR / POS Dashboard`; multi-module → `Dashboard`.

**`src/modules/pos/login/PosLogin.jsx`**
- Removed unused `deactivate()` function left over from S197 (was causing CI build failure).

**`src/modules/pos/staff/PosStaff.jsx`**
- Manage Roles modal: replaced static level badge with an editable dropdown per row — changing permission level auto-saves without needing to remove and re-add.
- Errors from `saveRoles` now surface inside the modal via `rolesError` state (was writing to `msg` state behind the modal overlay, effectively invisible).

---

### S201 — 2026-07-01 — Comprehensive tooltip audit + Help.js missing entries

Full sweep of all pages and HR/POS modules for missing `<Tip>` tooltips. All gaps filled. No DB changes.

**Tooltip additions:**
- **Vendors.js** — Code column, PAN/VAT No. column, Status column; form: Contact Person, PAN/VAT No. labels
- **Settings.js** — FC Warning %, FC Critical %, Expiry Warning, Variance Flag % thresholds; Item/Vendor/Sub-Recipe Code Prefix labels; VAT Registration Number
- **AuditLog.js** — all 6 table headers: Time, Client, User, Action, Area, Summary
- **Periods.js** — BS Year and BS Month form labels; BS Year, BS Month, Status, Created table headers
- **Sales.js** — Category, Selling Price, Total Qty Sold, Period Revenue stat card; day-column headers
- **AdminClients.js** — Billing Cycle, Subscription end date per module, FC Warning/Critical %, Expiry Warning (days), Variance Flag %, VAT Number, Location and Contact Person (Add + Edit forms)
- **EmployeeList.jsx** — Code, Supervisor, and Type column headers

**Help.js additions:**
- **Roster** entry added to HR module guide (planning vs attendance, shift types, export)
- **POS Login** entry added to POS module guide (PIN login screen, Owner button, role requirement)
- **Audit Log** entry added in a new admin-only "Admin Tools" section (only rendered for `isAdmin`)

---

### S200 — 2026-07-01 — Menu Pricing page + POS toggle

**New page: `/menu-pricing` (all plans, feature key `menu_pricing`)**

Serves as the single source of truth for both internal pricing review and the future POS menu. The POS will query `recipes WHERE pos_enabled = true` rather than reading from Recipe Costing directly — so items can be hidden from POS without deactivating the recipe or losing history.

**Changes:**
- **`src/pages/MenuPricing.js`** (new) — category tabs (Food/Beverage/Dessert/Other), table with Food Cost · Current Price (incl VAT) · FC% · New Price input (live FC% + change diff) · On POS toggle · Save per row.
- **`recipes.pos_enabled boolean DEFAULT true`** — new column (migration run). NULL treated as true for existing rows.
- **On POS toggle** — checkbox per row; saves instantly. Rows with `pos_enabled = false` are dimmed (opacity 0.45). Summary strip shows how many items are on/off POS.
- **Pricing save** — user types VAT-inclusive new price; ex-VAT is back-calculated and written to `recipes.selling_price`. Press Enter or click Save.
- Wired into `AuthContext` (STARTER_KEYS), `SettingsContext`, `AdminClients`, `App.js`, `Layout.js` (COSTING section), `Help.js`.

---

### S199 — 2026-07-01 — Purchases: Expiry Date + Shelf Life as Inline Table Columns

**Problem:** Expiry date and shelf-life fields were stacked below the item dropdown in a sub-row (or inline div), making the bill form feel cramped and disconnected from the other fields.

**Changes (`src/pages/Purchases.js`):**
- **Removed sub-row / inline-div layout** — expiry date and shelf life no longer live beneath the item dropdown.
- **Two new table columns** — `Expiry Date` (140 px) and `Days` (95 px) added after Amount, before the delete button. Both sit on the same `<tr>` as Item, Qty, Rate, VAT, Total, Amount.
- **Modal widened** — `maxWidth` raised from 960 → 1160 px.
- **Table minWidth** raised from 640 → 920 px.
- No logic changes — shelf-life → expiry auto-calc and all save/edit paths unchanged.

---

### S198 — 2026-07-01 — Purchases: Per-Line VAT

**Problem:** The "Add Purchase Bill" form had a single bill-level VAT toggle — all items on a bill were either all-taxable or all-non-taxable. Real vendor invoices can have mixed items (e.g. 4 of 10 items VAT-able).

**Changes (`src/pages/Purchases.js`):**
- **Per-line VAT checkbox** — new column in the bill form table between Rate and Total. Each line independently controls its own `vat_inclusive` flag. Shows a small "13%" label below the checkbox when checked.
- **Header VAT toggle** → "apply to all" mass action. Visual state derived from lines: gold (all on), amber "VAT Mixed" (some on), off (none). Clicking toggles all lines at once for convenience.
- **Totals breakdown** — now shows Taxable (ex-VAT) and Non-taxable subtotals separately; VAT 13% applies only to the taxable portion; discount is prorated proportionally across all lines before VAT is levied (Nepal IRD practice).
- **`setLineTotal` back-calc** — Total column now divides by `line.vat_inclusive ? 1.13 : 1` (was `billHeader.vat_inclusive`).
- **`saveBill`** — stores `vat_inclusive: l.vat_inclusive` per entry (was `billHeader.vat_inclusive`).
- **No DB change** — `purchase_entries.vat_inclusive` was already per-row; the list view and all reports (VatReport, NonVatReport, VendorReport) were already reading per-entry values. Change only affects the form.

---

### S197 — 2026-07-01 — Owner Access, Custom Roles, PIN Login UI, Staff CRUD (complete)

**Access model:**
- Owner (client user with no `pos_role`) logs in via `/login` (email+password)
- All POS staff (including managers) log in via PIN on `/pos/login`
- `isOwner` exposed from AuthContext; owner gets `posRole = 'manager'` for access control, shows "Owner" label in sidebar footer

**Custom role names per client (`Manage Roles`):**
- `pos_custom_roles jsonb DEFAULT '[]'` added to `settings` table
- Manager opens "Manage Roles" modal → defines custom names (e.g. Cashier, Barista) mapping to permission levels (staff/supervisor/manager)
- `effectiveRoles = customRoles.length > 0 ? customRoles : DEFAULT_ROLES` — falls back to Staff/Supervisor/Manager if none defined
- `pos_job_title text` on `profiles` stores the selected label; `pos_role` stores the permission level
- Role updates go through `update_pos_role` edge function action (service role — no RLS issues)

**Staff list via SECURITY DEFINER RPC (`get_pos_staff_list`):**
- Direct `profiles` SELECT blocked for owner JWT (no same-client SELECT policy; adding one caused infinite recursion since policy subquery re-entered itself)
- Fix: `get_pos_staff_list(p_client_id uuid)` SECURITY DEFINER function — verifies caller is admin or same-client, then reads profiles bypassing RLS
- Returns `id, full_name, pos_role, pos_job_title, last_seen_at` filtered by `pos_email IS NOT NULL`

**PIN login UI improvements:**
- Circular numpad buttons (`borderRadius: 50%`), `scale(0.92)` press effect, glow on filled PIN dots
- "Enter PIN for {name}" — 18px, weight 600, prominent
- Back (108px) + Login (120px) as a flex row
- Removed "Deactivate device" from footer (security risk)

**`admin-user-ops` edge function additions:**
- `isCallerOwner`: `role === 'client' && !pos_role` — owner can create/delete/reset staff
- `pos_job_title` included in `create_pos_staff` upsert
- `update_pos_role` action: updates `pos_role` + `pos_job_title` with same-client guard
- `delete_pos_staff` action: managers can delete staff/supervisors; only admin can delete managers

**DB (run in Supabase):**
```sql
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS pos_job_title text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS hr_employee_id uuid REFERENCES hr_employees(id) ON DELETE SET NULL;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS pos_custom_roles jsonb DEFAULT '[]'::jsonb;
ALTER TABLE sales_entries ADD COLUMN IF NOT EXISTS source text DEFAULT 'manual' CHECK (source IN ('manual', 'pos'));

-- RLS SELECT policy on profiles was NOT added (recursive — breaks login)
-- Staff list uses get_pos_staff_list() SECURITY DEFINER RPC instead

DROP FUNCTION IF EXISTS get_pos_staff_list(uuid);
CREATE OR REPLACE FUNCTION get_pos_staff_list(p_client_id uuid)
RETURNS TABLE(id uuid, full_name text, pos_role text, pos_job_title text, last_seen_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE caller_client_id uuid; caller_role text;
BEGIN
  SELECT p.client_id, p.role INTO caller_client_id, caller_role FROM profiles p WHERE p.id = auth.uid();
  IF caller_role = 'admin' OR caller_client_id = p_client_id THEN
    RETURN QUERY SELECT p.id, p.full_name, p.pos_role, p.pos_job_title, p.last_seen_at
      FROM profiles p WHERE p.client_id = p_client_id AND p.role = 'client' AND p.pos_email IS NOT NULL
      ORDER BY p.full_name;
  END IF;
END; $$;
GRANT EXECUTE ON FUNCTION get_pos_staff_list(uuid) TO authenticated;
```

---

### S197 — 2026-07-01 — POS Login Model Clarification + Delete Staff + Integration Foundations

**POS ↔ IMS ↔ HR integration foundations:**

Two schema migrations run to wire the three modules together before POS screens are built:

```sql
-- Distinguishes POS auto-writes from manual IMS sales entries in reports
ALTER TABLE sales_entries
  ADD COLUMN IF NOT EXISTS source text DEFAULT 'manual'
  CHECK (source IN ('manual', 'pos'));

-- Links POS staff account → HR employee; enables future shift→attendance sync
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS hr_employee_id uuid REFERENCES hr_employees(id) ON DELETE SET NULL;
```

**Integration design (deferred until order-taking is built):**
- POS writes to `sales_entries` with `source = 'pos'` → IMS Best Sellers, Variance, Recipe Margin light up automatically
- `stock_movements` perpetual ledger (new table, not yet created) — POS sale explodes recipe → negative movements per ingredient
- `pos_orders` / `pos_order_items` tables — to be created when `/pos/orders` is built
- `hr_employee_id` on profiles → POS shift close writes hours to `hr_attendance` for payroll

### S197 — 2026-07-01 — POS Login Model Clarification + Delete Staff

**Access model clarified:**
- Main client (owner) logs in with email + password via `/login`
- Everyone else (manager / supervisor / staff) logs in via PIN on `/pos/login`
- All POS accounts are created via "Add Staff" (name + PIN + role) — no email required

**`src/modules/pos/login/PosLogin.jsx`:**
- Reverted manager filter — managers now appear on the PIN picker (they use PINs like everyone else)
- "Manager login" footer link renamed to "Owner login" — clarifies it's for the main client account only

**`src/modules/pos/staff/PosStaff.jsx`:**
- Delete button added (red, alongside Reset PIN); triggers `window.confirm` before proceeding
- "PIN" column header renamed to "Actions"
- Managers can delete staff/supervisors; only admin can delete managers

**`supabase/functions/admin-user-ops/index.ts`:**
- `delete_pos_staff` action added (before admin-only guard): calls `admin.auth.admin.deleteUser()` which cascades profile deletion; managers blocked from deleting other managers

---

### S196 — 2026-06-30 — POS Staff Creation + Device Activation + PIN Login

**POS Add Staff (name + PIN only):**

Manager can now create staff accounts directly from POS Staff → "+ Add Staff". No email required — staff log in with name + PIN only. Auto-generated internal email (`slug_xxxxx@pos.internal`) is stored in `profiles.pos_email` and never shown to staff.

**`supabase/functions/admin-user-ops/index.ts`:**
- `create_pos_staff` action: accepts `{ full_name, pin, pos_role, client_id }`, auto-generates internal email, creates Supabase Auth user, upserts profile with `pos_email` stored
- `reset_pos_pin` action: manager can reset any same-client staff PIN; cross-checks `client_id` to prevent cross-client resets
- Profile fetch changed to use service-role (`admin`) client — anon+JWT fetch was returning null due to RLS, causing "client_id required" error
- Admin callers must pass `client_id` in request body; manager callers use `profile.client_id` server-side

**`src/modules/pos/staff/PosStaff.jsx`:**
- "+ Add Staff" button (manager only) opens modal: Full Name + PIN (4–6 digits, masked) + POS Role
- PIN input strips non-digits, max 6 chars
- "Reset PIN" column added to staff table — opens modal to set a new PIN for any staff member
- `client_id` now passed in edge function call body (fixes admin-viewing-as-client case)

**DB (run in Supabase):**
```sql
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS pos_email text;

CREATE OR REPLACE FUNCTION get_pos_staff(p_client_id uuid)
RETURNS TABLE(id uuid, full_name text, pos_role text, pos_email text)
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT id, full_name, pos_role, pos_email FROM profiles
  WHERE client_id = p_client_id AND pos_role IS NOT NULL AND pos_email IS NOT NULL
  ORDER BY full_name;
$$;

GRANT EXECUTE ON FUNCTION get_pos_staff(uuid) TO anon;
```

**Device activation (`src/modules/pos/Pos.js` — rewritten):**
- Manager sees "Activate for [Client Name]" card on `/pos`
- On click: saves `pos_device_client_id` + `pos_device_client_name` to `localStorage`
- Activated state shows "Device activated · Bound to: X" with "Open POS Login Screen" + "Deactivate Device" buttons
- Only visible to managers; Staff/Supervisor see Coming Soon text only

**POS PIN login screen (`src/modules/pos/login/PosLogin.jsx` — new):**
- Public route (`/pos/login`) — no auth required
- Reads `pos_device_client_id` from `localStorage`; redirects to `/login` if not set
- Calls `supabase.rpc('get_pos_staff', { p_client_id })` to fetch staff list without auth (SECURITY DEFINER + anon grant)
- Staff picker: name cards in a responsive grid
- On tap: PIN numpad (3×4 grid, 0–9 + ⌫) with dot indicators; keyboard also supported
- On confirm: `supabase.auth.signInWithPassword({ email: staff.pos_email, password: pin })`; wrong PIN clears and shows error
- Footer links: "Deactivate device" (clears localStorage) · "Manager login" (goes to `/login`)

**`src/App.js`:**
- Added `import PosLogin` + `<Route path="/pos/login" element={<PosLogin />} />` as public route (outside ProtectedRoute)
- `RootRedirect` component: checks `localStorage` for `pos_device_client_id` — bound devices go to `/pos/login`, others go to `/dashboard`

**`src/components/Layout.js`:**
- Added `pos-setup` group to `POS_GROUPS`: "POS Setup" link → `/pos` (manager+)

---

### S195 — 2026-06-30 — POS Role System + Bug Fixes

**POS 4-tier role model** (`staff` / `supervisor` / `manager` / admin):

**DB (run in Supabase):**
```sql
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS pos_role text
  CHECK (pos_role IN ('staff', 'supervisor', 'manager'));

CREATE POLICY "profiles_pos_role_manager_update" ON profiles
FOR UPDATE TO authenticated
USING (
  client_id = (SELECT client_id FROM profiles WHERE id = auth.uid())
  AND (SELECT pos_role FROM profiles WHERE id = auth.uid()) = 'manager'
)
WITH CHECK (
  client_id = (SELECT client_id FROM profiles WHERE id = auth.uid())
);
```

**`src/context/AuthContext.js`:**
- Added `pos_role` to profiles `.select()` string
- `posEnabled` extracted as a variable (was inline in context value only)
- `posRole` exposed: admin gets `'manager'`; client users get `profile.pos_role || null`
- `hasPosAccess(minLevel)` exported — returns true for admin, checks `POS_RANK` for client users; returns false if `pos_role` is null

**`src/components/Layout.js`:**
- `POS_GROUPS` updated: Tables gets `minPosRole: 'supervisor'`; new "Admin" group with POS Staff (`minPosRole: 'manager'`)
- POS sidebar block now hidden entirely if `posRole` is null (no role assigned)
- Nav items filtered per `hasPosAccess(item.minPosRole)` before rendering
- Sidebar footer now shows `POS · Supervisor` etc. instead of plain "Client"

**`src/modules/pos/staff/PosStaff.jsx`** (new — `/pos/staff`):
- Manager-only screen listing all client profiles
- Dropdown to assign `staff / supervisor / manager` (or revoke access) per user
- Live save on change with saving indicator
- Role legend card at top explaining each level
- Read-only view for non-managers with explanation message
- Tip tooltips on POS Role and Last Seen columns
- Redirects to `/pos/tables` if below manager

**`src/modules/pos/tables/PosTableManagement.jsx`:**
- Added `Navigate` import and `hasPosAccess('supervisor')` gate (redirects to `/pos` if below supervisor)
- Fixed Section input in Add Table modal: removed pre-fill with `existingSections[0]` (was appearing as locked dropdown); replaced `form-select` class with plain text-input styles so dropdown arrow is gone

**`src/App.js`:** Added `/pos/staff` route + `PosStaff` import

**`src/pages/Help.js`:** Added POS Staff feature card with 4 tips

**`src/utils/subscription.js`** (bug fix):
- `getSubStatus` was only checking `ims_ends_at || subscription_ends_at` — POS-only clients with `pos_ends_at` set still showed "Trial · Xmo"
- Fixed to take `Math.max` across all of `ims_ends_at`, `hr_ends_at`, `pos_ends_at`, `subscription_ends_at`

**Setup flow:** Crest admin views as client → `/pos/staff` → assigns `manager` to client owner → owner logs in → assigns roles to their waiters.

---

### S194 — 2026-06-30 — Crest POS: Table Management

**`src/modules/pos/tables/PosTableManagement.jsx`** (new page — `/pos/tables`):
- **⚡ Quick Setup panel** — bulk generator: Prefix + Start# + Count + Section + Seats → one click creates e.g. "Table 1 … Table 10". Auto-expands on first visit (no tables yet), collapses once tables exist. Live preview line shows exactly what will be created. Max 50 per batch; run multiple times for different sections/prefixes. No drag-drop — faster than Toast/Square for initial setup.
- Floor-plan grid of table cards: name, section, capacity, status badge
- Status badge clickable directly on the card to cycle Available → Reserved → Occupied → Inactive (no modal needed)
- Section filter tabs auto-appear when more than one section exists
- 4 stat cards: Total Tables / Available / Occupied / Reserved (with Tip tooltips)
- **Fab visible only after tables exist** — single-table add modal: Name + Section (datalist autocomplete) + Capacity (3 fields, no Sort Order clutter)
- Edit modal (click any card): all fields + Status dropdown + Sort Order + Delete with confirm
- Tip tooltips on all fields, stat cards, floor card status badge (explains future auto-Occupied), and seats display

**`src/App.js`:** Added `/pos/tables` route + imported `PosTableManagement`

**`src/components/Layout.js`:**
- Replaced `POS_DASHBOARD` single link with `POS_GROUPS` collapsible group structure (mirrors HR pattern)
- Currently: one group "Floor" with Tables; will grow as Orders, Shifts, Reports are added

**`src/pages/Help.js`:** Added Crest POS section (gated on `posEnabled`) with Table Management feature card + 4 tips

**DB (run in Supabase):**
```sql
CREATE TABLE IF NOT EXISTS pos_tables (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  name text NOT NULL,
  section text,
  capacity integer DEFAULT 2,
  status text DEFAULT 'available' CHECK (status IN ('available','occupied','reserved','inactive')),
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE pos_tables ENABLE ROW LEVEL SECURITY;
CREATE POLICY "client_own" ON pos_tables
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pos_tables TO authenticated;
```

---

### S193 — 2026-06-30 — Crest POS infrastructure layer

**Goal:** Wire up the POS module so it can be toggled on per client and routed to — before building any POS UI.

**DB (run in Supabase):**
- `ALTER TABLE clients ADD COLUMN IF NOT EXISTS pos_enabled boolean DEFAULT false`
- `ALTER TABLE clients ADD COLUMN IF NOT EXISTS pos_plan text CHECK (pos_plan IN ('starter','growth','pro'))`

**`src/context/AuthContext.js`:**
- Added `pos_enabled, pos_plan` to clients `.select()` string
- `posEnabled` now reads `profile?.clients?.pos_enabled ?? false` (was hardcoded false)
- `posPlan` added to context value
- `viewModules` effect now fetches `pos_enabled` and reflects it in `clientModules.pos`

**`src/components/ModuleGate.js`:**
- Added `posEnabled` from `useAuth()` + `if (module === 'pos' && !posEnabled) → /dashboard` guard

**`src/App.js`:**
- Imported `Pos` from `./modules/pos/Pos`
- Added `/pos` route wrapped in `<ModuleGate module="pos">`

**`src/components/Layout.js`:**
- Added `POS_DASHBOARD = { to: '/pos', label: 'Point of Sale', icon: '⊕' }`
- Added sidebar block gated on `clientModules.pos` (renders after HR nav block)

**`src/pages/AdminClients.js`:**
- Added `posEnabled` / `posPlan` state initialized from `client.pos_enabled` / `client.pos_plan`
- `posEndsAt` converted from `const` to stateful (setter needed for billing date picker)
- Added `handleTogglePos()` — instant save to `clients.pos_enabled`
- POS live toggle added to the Modules section in Billing tab (alongside IMS/HR)
- POS added to per-module subscription section (plan cards + end date picker)
- `pos_plan` now saved in `handleSaveSub`
- POS pill added to module pills on client card

**Result:** Toggling POS on for a client in AdminClients → sidebar shows "Point of Sale" link → routes to placeholder page. Build clean (0 warnings).

---

### S192 — 2026-06-30 — Display improvements: purchase-unit in Stock & Variance + HR audit

**Display improvements — purchase-unit equivalent in Net Purchased / Purchased columns:**
- Added `dispPurch(baseQty, item)` helper to `src/pages/Stock.js` and `src/pages/Variance.js`
- For items with `conversion_factor > 1` and `purchase_unit` set, shows `10 CTN (240 BTL)` format instead of raw base-unit qty
- Applied to: **Net Purchased** column in Variance report, **Purchased** column in Stock Summary per-item table, **Purchased** ref on mobile stock cards
- Falls back to plain base-unit display for items without conversion

**HR module audit (code verified, memory corrected):**
- All 7 of 8 "pending" HR features confirmed built: Gratuity Tracker, Final Settlement, OT Logging, Advances/Recovery, Annual TDS Certificate, Insurance+married-schedule TDS, TDS on festival allowance
- Additional untracked features found: HR Dashboard, PaySetup/PayForm, Roster, Holiday Calendar, Employee Joining Form
- **Service-charge pool distribution removed from scope** — will not be built in Crest HR

**Shorthands added to memory:** `cb` = check for build (`CI=true npm run build`)

---

### S191 — 2026-06-30 — Hotfix: restore admin_clear_audit_logs for authenticated users

**Supabase SQL (dashboard):**
- S188 over-revoked `admin_clear_audit_logs` from `authenticated` — broke the Audit Log "Clear" button with "permission denied" error
- Fix: `GRANT EXECUTE ON FUNCTION public.admin_clear_audit_logs(uuid, text, timestamptz) TO authenticated;`
- Linter will still flag it as a warning (acceptable — function is the security boundary)

### S190 — 2026-06-30 — Items: per-UOM rate fix when Total is used

**Item Master (`src/pages/Items.js`):**
- Fixed "Per GM rate" showing wrong value when Total field is used: when Total is entered, Rate is back-calculated as `Total ÷ Purchase Qty` (already per base unit) — dividing by Qty again was wrong (e.g. 0.70 showed as 0.0007)
- Now: when `amtDraft` is set, Per UOM rate displays `Rate` directly; when Total is blank and Rate entered directly (conversion setup), old `Rate ÷ Qty` formula still applies

### S189 — 2026-06-30 — Trial signup fixes + Danger Zone tooltips + Admin Clients dedup

**Trial signup (`supabase/functions/admin-user-ops/index.ts`):**
- Fixed `profiles_pkey` violation on all trial signups — `handle_new_user` trigger auto-inserts a bare profile on auth user creation; switched edge function from `insert` to `upsert` (onConflict: id) so our values always win
- Friendly error message when email already registered: "An account with this email already exists. Please sign in instead." (detected via `code === '23505'` or `profiles_pkey` in message)

**Login page (`src/pages/Login.js`):**
- Frontend maps "already exists / already registered / profiles_pkey" errors to: "An account with this email already exists. Use the sign-in form above."

**Admin Clients (`src/pages/AdminClients.js`):**
- Trial clients now excluded from main client list (`filter(c => !c.is_trial)`) — they only appear in the Trial Accounts section at top
- Added `Tip` tooltips to all three Danger Zone buttons: Clear All Conversions, Clear Client Data, Delete Client
- Sidebar amber badge auto-clears after 7 days from signup; also clears immediately on Convert to Paid

### S188 — 2026-06-30 — Security hardening + sidebar trial badge redesign + orphaned user delete fix

**Supabase security hardening (SQL run in dashboard — no code changes):**
- Revoked `EXECUTE` from `PUBLIC` on 6 sensitive functions: `admin_clear_audit_logs`, `client_user_emails`, `find_user_id_by_email`, `request_subscription`, `handle_new_user`, `log_audit`
- Granted back `EXECUTE` to `authenticated` on `request_subscription` (called by logged-in trial users)
- Added `SET search_path = public` to 4 functions with mutable search_path: `my_client_id`, `is_admin`, `admin_clear_audit_logs`, `request_subscription`
- Remaining acceptable warnings: `is_admin` + `my_client_id` (RLS dependency), Logos bucket listing, leaked password protection (Pro plan required)

**Admin Clients (`src/pages/AdminClients.js`):**
- Delete user now handles orphaned profiles gracefully — if auth user is already gone ("not found"), falls through and deletes the `profiles` row instead of blocking with an error

**Sidebar (`src/components/Layout.js`):**
- New trial badge redesigned for strong visual presence: number badge on icon (not tiny dot), amber left border + background tint on entire Clients row, bold "N NEW" pill (expanded) / number on icon (collapsed)
- Red variant shows "N want to sub" when `subscribe_requested` clients exist; amber shows when new trials in last 7 days

### S187 — 2026-06-30 — Trial signup awareness: contact_person, signup time display, sidebar amber badge

**Edge Function (`supabase/functions/admin-user-ops/index.ts`):**
- `register_trial` action now saves `contact_person: full_name || business_name` to the `clients` row on signup

**Admin Clients (`src/pages/AdminClients.js`):**
- Trial rows now show "Signed up X ago · [contact_person]" using the existing `relativeTime()` helper
- Contact person only shown when it differs from the business name

**Sidebar (`src/components/Layout.js`):**
- Added `newTrialCount` state — counts trial clients with `trial_start_date` in the last 7 days
- Amber badge `"N new"` appended to Clients nav label when `newTrialCount > 0` (distinct from the red subscribe-requested badge)
- Collapsed-mode: amber dot shown when `newTrialCount > 0` and no pending red badge already showing
- **Deploy required:** `supabase functions deploy admin-user-ops` to activate contact_person capture

### S186 — 2026-06-30 — Purchases + Non-VAT Report: discount header field, footer buttons, Non-VAT discount handling

**Add Purchase Bill (`src/pages/Purchases.js`):**
- **Discount field moved to header row** — always visible as a 90px fixed-width input (was hidden in totals section behind `subTotal > 0` gate); header grid now `2fr 1fr 1.4fr auto 90px 1fr`
- **Footer row restructured** — 3-column grid: Cancel (left) · + Add Item (center) · Save Entries (right)
- **+ Add Item button** — moved from table sub-row into footer; amber background, black font, `fontSize: 13`
- **Cancel button** — red ghost style (matches Delete All); natural width via `justifySelf: start`; `fontSize: 13` on all three footer buttons for uniformity

**Non-VAT Report (`src/pages/NonVatReport.js`):**
- Bill-level `discount_amount` now subtracted from gross to produce net total (mirrors VatReport logic)
- CA Summary gains conditional Gross / Discount / Net columns (Discount column only when any bill has a discount)
- Empty state copy updated: references VAT toggle, not old per-line checkbox
- Excel export includes Gross, Discount, Net columns

### S185 — 2026-06-30 — Purchases: Add Purchase Bill — header layout & UX polish

- **VAT toggle moved to header row** — now a bill-level switch between Invoice Ref and Payment (one toggle applies to all items; removed per-line toggle from the Rate cell)
- **Invoice Ref shortened by ~30%** — header grid changed from `2fr 1fr 2fr 1fr` to `2fr 1fr 1.4fr auto 1fr`
- **Fonts/inputs standardised** — all header form controls explicitly set to `fontSize: 13` matching the line-item cell inputs
- **"+ Add Item" button moved** — from bottom-left to the right side of the last line's sub-row (under the Amount column), alongside Expiry and Shelf Life fields
- **File:** `src/pages/Purchases.js`

### S184 — 2026-06-30 — Purchases: VAT pill replaced with amber sliding toggle switch

- Replaced the `+ VAT / ✓ VAT 13%` pill button with a proper sliding toggle (34×18px track, 12px thumb)
- Track turns amber when VAT is on; thumb slides right; label reads **VAT 13%** (amber/bold) or **VAT** (dim)
- **File:** `src/pages/Purchases.js`

### S183 — 2026-06-30 — Items + Purchases: UI polish — Total field, VAT toggle, layout cleanup

**Item Master (`src/pages/Items.js`):**
- Total (NPR) always visible (removed qty > 0 condition); promoted to standalone grid field beside Rate
- Form field order changed: Item Name → Category → Yield % → UOM → Purchase Qty → Rate → Total
- Per-UOM rate display: dynamic decimal precision — up to 6 dp for values < 0.01 (fixes "NPR 0.00" for small rates)

**Add Purchase Bill (`src/pages/Purchases.js`):**
- Total (NPR) always visible (removed qty > 0 condition); given its own column
- VAT checkbox replaced with a pill toggle button below Rate (`+ VAT` / `✓ VAT 13%`); VAT column removed
- Each bill line split into two `<tr>` rows: main inputs on row 1; Expiry date + Shelf life on row 2 — same input height/font as all other fields

### S182 — 2026-06-30 — Item Master: Total-amount back-calculate Rate

**Add/Edit Item modal — "Total" sub-input below Rate field:**
- New `amtDraft` state tracks the user's typed total; clears when Rate or Purchase Qty is edited directly
- `setTotalAmount(val)` handler: `rate = totalAmount ÷ purchaseQty` (no VAT — Item Master rates are base rates)
- Total input placeholder shows computed total (`rate × purchase_qty`) when draft is empty
- Clears on `openNew` and `openEdit` so modal always opens clean
- **File:** `src/pages/Items.js`

### S181 — 2026-06-30 — HR: Advances & Loans — payroll integration (auto-recovery)

**Advance/loan deduction wired into payroll generation and finalize:**
- `payrollCompute.js`: `computePayslip` gains 7th param `advanceDeduction = 0` — subtracted from `net_pay` in all three pay bases (monthly/daily/hourly); stored as `advance_deduction` on result object
- `PayrollRun.jsx`:
  - Fetches `hr_advances` + `hr_advance_repayments` on every `loadAll`
  - `buildAdvanceMap()`: per-employee deduction = `min(installment_amount, outstanding_balance)` across all active advances; no installment → full outstanding (one-shot)
  - New **Advance** column in register table (orange `−X`); "Advance / Loan Recovery" line on payslip modal + print
  - `updateTds` net-pay formula includes `advance_deduction`
  - **Finalize**: writes `hr_advance_repayments` rows tagged with `payroll_run_id` (idempotent delete+re-insert); auto-settles advances whose balance reaches zero
  - **Reopen**: deletes auto-repayments for that run; reactivates any advances that now have outstanding balance
  - Excel export gains "Advance Ded" column
- `Help.js`: Advances & Loans entry rewritten to describe auto-deduction flow

**DB migrations run:**
```sql
ALTER TABLE hr_payslips ADD COLUMN IF NOT EXISTS advance_deduction numeric DEFAULT 0;
ALTER TABLE hr_advance_repayments ADD COLUMN IF NOT EXISTS payroll_run_id uuid REFERENCES hr_payroll_runs(id);
```
**RLS policies added** (were missing — "permission denied" on insert): standard client-own policy + `GRANT ALL TO authenticated` on both `hr_advances` and `hr_advance_repayments`.

**Note:** S165 entry "Repayments are manually recorded" is superseded by this session — repayments are now auto-recorded on Finalize.

**Files:** `src/modules/hr/payroll/payrollCompute.js`, `src/modules/hr/payroll/PayrollRun.jsx`, `src/pages/Help.js`

---

### S180 — 2026-06-30 — Purchases: Total-amount back-calculate rate

**Reverse-rate calculator in Purchase Bill form (`src/pages/Purchases.js`):**
- Added **Total** helper input below the Rate field (visible once QTY is entered)
- User types the total amount paid → Rate is back-calculated: `rate = total ÷ qty ÷ (1.13 if VAT)`
- Placeholder shows the current computed total so the field doubles as a live readout
- Editing Rate directly clears the Total input (reverts to placeholder); changing item or toggling VAT also resets it
- `_amtDraft` field on each bill line holds the user's typed total (not persisted — derived state only)
- New `setLineTotal()` function handles the back-calc; `updateBillLine` clears `_amtDraft` on `rate` / `vat_inclusive` / `item_id` changes

**Files:** `src/pages/Purchases.js`

---

### S179 — 2026-06-30 — HR sidebar groups + Overtime Est. Amount column

**HR sidebar rearranged into collapsible groups (`src/components/Layout.js`):**
- Replaced flat `HR_ITEMS` (14 items in one group) with `HR_DASHBOARD` (pinned) + `HR_GROUPS` (4 collapsible sections)
- Groups: **People** (Employees, Pay Setup, Holiday Calendar) · **Attendance** (Staff Roster, Attendance, Leave, Overtime) · **Payroll** (Payroll, Festival Allowance, Advances & Loans) · **Reports** (HR Reports, Gratuity, Final Settlement)
- HR Dashboard pinned above the groups (mirrors IMS Dashboard pinned above `IMS_GROUPS`)
- Active-route force-open and icon-collapsed mode work unchanged via existing `renderGroup` / `renderNavItem`

**Overtime: Est. Amount column + Est. OT Cost stat card (`src/modules/hr/overtime/Overtime.jsx`):**
- Employee fetch now includes `basic_salary`
- `otAmt(entry, emp)` helper: `hours × (basic ÷ daysInMonth ÷ 8) × multiplier` (monthly); `hours × (basic ÷ 8) × multiplier` (daily); `hours × basic × multiplier` (hourly); returns `null` if no salary on file
- New **Est. Amount** column in table — amber, right-aligned; shows `—` when salary missing
- New **Est. OT Cost** stat card (4th) — sums approved entries only, excludes employees with no salary data

**Files:** `src/components/Layout.js`, `src/modules/hr/overtime/Overtime.jsx`

---

### S178 — 2026-06-30 — Festival Allowance: TDS reconciliation with payroll YTD

**Updated `src/modules/hr/festival/FestivalAllowance.jsx`:**

**Core change — YTD-based TDS instead of salary × 12 estimate:**
- `load()` now fetches all finalized payslips for the current FY (`hr_payslips` + `hr_payroll_runs!inner` + `monthly_periods!inner`) and builds a `ytdMap` (employee_id → `{ gross, ssf, months }`)
- New `calcFestivalTds({ emp, amount, ytd, fyStart })` helper: projects annual income as `ytdGross + basic × remainingMonths`, deducts SSF + insurance caps (NPR 40k life / NPR 20k health), then applies `computeBonusTds()` at the resulting `annualTaxable`. Falls back to salary projection if no finalized payroll months exist.
- Shows **"YTD"** badge on the TDS KPI card and column header when real payslip data was used; tooltip explains the source.

**TDS saved to DB (new column):**
- `hr_festival_allowances.tds integer not null default 0` — run SQL migration below
- `buildRows()` includes computed `tds` in the upsert
- `updateAmount()` recomputes + saves both `amount` and `tds` on blur
- `updateTds()` allows manual TDS override (same pattern as PayrollRun); TDS input uses `key={r.tds}` so it re-mounts with the new computed value when amount changes

**UI additions:**
- TDS column is now an editable input (while draft) — allows CA override
- New **Net** column in table = gross − TDS (the bank transfer amount)
- KPI cards: TDS Withheld + Net Payout now reflect saved `r.tds` values from state
- Bank export (Excel/CSV) now includes Gross, TDS, Net Transfer columns

**Also fixed:** removed unused `fiscalYearOf` import from `src/modules/hr/overtime/Overtime.jsx` (caused ESLint build failure)

**DB migration (run in Supabase SQL editor):**
```sql
alter table hr_festival_allowances
  add column if not exists tds integer not null default 0;

grant select, insert, update, delete on hr_festival_allowances to authenticated, anon;
```

Existing rows default to `tds = 0`; hit **Regenerate** on any existing festival run to compute and save accurate TDS.

---

### S177 — 2026-06-30 — HR Dashboard

**New page — `src/modules/hr/dashboard/HrDashboard.jsx`** (`/hr/dashboard`, HR module gate, top of HR sidebar):

**Headcount KPI row (6 cards):**
- Active Staff (+ probation sub-label) → `/hr/employees`
- Basic Payroll / Month (active + probation basic salary total) → `/hr/payroll`
- Leave Pending (count, amber when >0) → `/hr/leave`
- OT Pending (count, amber when >0) → `/hr/overtime`
- Advances Outstanding (NPR total of active unsettled advances) → `/hr/advances`
- Retiring Soon (active/probation retiring within 180 days, amber when >0) → `/hr/employees`

**Last Finalized Payroll section (4 cards, only when a finalized run exists):**
- Net Payable (total take-home from last finalized payroll)
- SSF Employee (11% total)
- SSF Employer (20% total)
- SSF Total to Deposit (31% combined, amber, deposit deadline = 15th of next BS month) → `/hr/reports`

**Pending queues (2-column layout):**
- Left: pending leave requests table (employee / type / from / to) → click row or button → `/hr/leave`
- Right: pending OT entries table (employee / BS date / hours / weekday or holiday) → click → `/hr/overtime`

No DB migration needed — reads existing tables.

---

### S176 — 2026-06-30 — Overtime Management

**New page — `src/modules/hr/overtime/Overtime.jsx`** (`/hr/overtime`, HR module gate):
- Log OT entries per employee per BS date with an approval flow: Pending → Approved / Rejected
- Two OT rates (Nepal Labour Act): Weekday = 1.5×, Public Holiday = 2×
- Date auto-detects holiday type from `hr_holiday_calendar` — pre-selects "Public Holiday (2×)" when date matches a gazetted holiday
- "Undo" button reverts Approved/Rejected entries back to Pending
- Stat cards: Pending count, Approved count + total hours, Total OT hours approved
- Status filter tabs: All / Pending / Approved / Rejected
- Note on page: only Approved entries feed into payroll; Regenerate payroll after approving

**Payroll integration (`src/modules/hr/payroll/`):**
- `payrollConstants.js` — added `OT_HOLIDAY_MULTIPLIER = 2.0`
- `payrollCompute.js` — refactored to accept `approvedOtEntries[]` as 6th param; entry OT computed at end: weekday hours × 1.5× + holiday hours × 2× of employee's hourly rate; stacks on top of attendance OT; backward-compatible (empty array = no change)
- `PayrollRun.jsx` — `loadAll()` now accepts `bsYear, bsMonth`; fetches approved `hr_overtime_entries` for the period; passes per-employee entries to `computePayslip`

**DB migration required:**
```sql
create table hr_overtime_entries (
  id uuid default gen_random_uuid() primary key,
  client_id uuid not null references clients(id) on delete cascade,
  employee_id uuid not null references hr_employees(id) on delete cascade,
  bs_year int not null,
  bs_month int not null check (bs_month between 1 and 12),
  bs_day int not null check (bs_day between 1 and 32),
  ot_hours numeric not null check (ot_hours > 0),
  ot_type text not null default 'weekday' check (ot_type in ('weekday', 'holiday')),
  reason text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz default now()
);
create index on hr_overtime_entries(client_id, bs_year, bs_month);
create index on hr_overtime_entries(employee_id);
alter table hr_overtime_entries enable row level security;
create policy "client_rw" on hr_overtime_entries
  using (
    (select role from profiles where id = auth.uid()) = 'admin'
    or client_id = (select client_id from profiles where id = auth.uid())
  )
  with check (
    (select role from profiles where id = auth.uid()) = 'admin'
    or client_id = (select client_id from profiles where id = auth.uid())
  );
grant select, insert, update, delete on hr_overtime_entries to authenticated, anon;
```

---

### S175 — 2026-06-30 — Holiday Calendar

**New page — `src/modules/hr/holidays/HolidayCalendar.jsx`** (`/hr/holidays`, HR module gate):
- Per-client Nepal public holiday list, grouped by BS fiscal year (Shrawan–Ashadh)
- Two holiday types: **Public** (gazetted — 2× OT rate, all staff entitled to day off) and **Optional** (floating, employer discretion)
- FY selector auto-defaults to current FY; prior-year FYs appear once holidays exist for them
- **Seed Fixed** button auto-inserts 5 fixed-date Nepal gazetted holidays (safe to re-click — skips already-existing names):
  - Constitution Day (Sambidhan Diwas) — Ashwin 3
  - Prithvi Narayan Shah's Birthday — Poush 27
  - Martyrs' Day (Sahid Diwas) — Magh 5
  - National Democracy Day (Prajatantra Diwas) — Falgun 7
  - Republic Day (Ganatantra Diwas) — Jestha 15 (next BS year)
- Movable holidays (Dashain, Tihar, Holi, Buddha Jayanti, Teej, Eid, etc.) added manually from the Nepal government gazette each FY
- Month selector auto-resolves the correct BS year (months 4–12 = FY start year; months 1–3 = FY start + 1)
- Stat cards: Public count, Optional count, Total for selected FY
- Full Add / Edit / Delete per row
- Nav entry added to HR sidebar between Leave and Payroll

**DB migration required — run in Supabase SQL editor:**
```sql
create table hr_holiday_calendar (
  id uuid default gen_random_uuid() primary key,
  client_id uuid not null references clients(id) on delete cascade,
  bs_year int not null,
  bs_month int not null check (bs_month between 1 and 12),
  bs_day int not null check (bs_day between 1 and 32),
  name text not null,
  holiday_type text not null default 'public' check (holiday_type in ('public', 'optional')),
  created_at timestamptz default now()
);
create index on hr_holiday_calendar(client_id, bs_year);
alter table hr_holiday_calendar enable row level security;
create policy "client_rw" on hr_holiday_calendar
  using (
    (select role from profiles where id = auth.uid()) = 'admin'
    or client_id = (select client_id from profiles where id = auth.uid())
  )
  with check (
    (select role from profiles where id = auth.uid()) = 'admin'
    or client_id = (select client_id from profiles where id = auth.uid())
  );
```

---

### S174 — 2026-06-30 — Monthly roster split, duplicate shift fix, employee joining print form

**Monthly roster — two-half split (`src/modules/hr/roster/Roster.jsx`):**
- Monthly board now renders two stacked tables: days 1–16 (top) + days 17–end (bottom)
- Fixes overflow — all 28–32 BS days visible on screen and in print without horizontal scroll
- Weekly view unchanged (single-table). "Hrs" total column appears only on second-half table (monthly total = sum over all days via full `columns` array)
- `colChunks` computed from `columns` before render; `isLast` flag controls Hrs th/td and colgroup extra col

**Duplicate shift types auto-heal (`src/modules/hr/roster/Roster.jsx`):**
- Bug: React 18 Strict Mode double-invokes effects in dev → two concurrent seed inserts when `hr_shift_types` is empty → 12 rows (6 duplicates)
- Fix: on load, deduplicate by `name` (keep first per name), delete extras from DB via `.delete().in('id', toDelete)`
- Self-healing: runs once on next page load; no migration or manual cleanup needed

**Employee Joining Form — new printable physical form:**
- New file: `src/modules/hr/employees/EmployeeJoiningForm.jsx`
- Button: "🖨 Print Joining Form" in Employees page header; opens full-screen preview → Print / Save PDF → `window.print()`
- A4 portrait, forced B&W via `@media print`; dark theme fully overridden
- 7 sections matching the Add Employee tabs:
  1. **Personal** — Employee Code, Full Name, Gender (checkboxes), DOB (BS+AD), NID/Citizenship, PAN (if applicable), Phone, Email, Emergency Contact — with passport photo box (3.5×4.5 cm)
  2. **Employment** — Designation, Department, Employment Type (checkboxes), Join Date (BS+AD), Contract End Date, Reporting Supervisor, Status checkboxes, Notes
  3. **Address** — Permanent: Province (all 7 checkboxes), District, Municipality/VDC, Ward, Tole + same-as-permanent tick + Current Address (same fields)
  4. **Family** — Marital Status (checkboxes), No. of Children, Spouse Name, Father's Name, Mother's Name, Grandfather's Name
  5. **Nominee** — Nominee Name, Relationship, Phone (for SSF/Gratuity/Final Settlement)
  6. **Bank & SSF** — Bank Name, Branch, Account No., Account Holder Name, SSF No., SSF Enrolled? (Yes/No checkboxes)
  7. **Pay Details** — Pay Basis (Monthly/Daily/Hourly checkboxes), Basic Salary/Rate
  8. **Declaration** — pre-printed declaration text + 3 signature blocks (Employee / HR & Admin / Authorised By) each with date line
- Org name reads from `profile.clients.name` (client user) or `adminViewClientName` (admin viewing-as-client) — updates when client is switched
- Retirement date excluded (HR computes from DOB via ↻ Age 60 button; not employee-supplied)
- NID / Citizenship No. appears before PAN No. (PAN marked "if applicable")

**No DB migration required for S174.**

---

### S173 — 2026-06-30 — Staff Roster + customizable shift types

**New page — `src/modules/hr/roster/Roster.jsx`** (`/hr/roster`, HR module gate):

**Roster Board tab:**
- Weekly view (Sun–Sat, week starts Sunday) + Monthly view (full BS month, like Attendance Sheet)
- Navigation: prev/next week or month with "Today / This Month" shortcut
- Department filter dropdown (auto-hidden when no departments defined)
- Grid: employees as rows, days as columns; Saturday columns highlighted amber
- Each cell: click → `createPortal` dropdown to assign a shift or clear (Day Off); optimistic update on select
- Weekly cell shows: shift name + time range + hours. Monthly cell shows: 2-char abbreviation
- Footer row: total scheduled hours per day; right column: total hours per employee for the period
- Print button (🖨 Print) → `window.print()`; A4 landscape, forced B&W (white background, #111 text, shift cells print as light gray `#e8e8e8`); print-only header shows period label + full shift legend with times

**Shift Types tab (per-client, fully customizable):**
- Table of shift templates: color (color picker), name, start time, end time, hours
- Hours auto-hint computes from start/end in real time; enter manually for flexible (Split) shifts
- Overnight shifts (e.g. Night 21:00–07:00) handled correctly (next-day wrap in `calcHours`)
- Add / inline-edit / active toggle / delete
- Default shifts seeded on first visit: Morning 7–3 (8h), Afternoon 1–9 (8h), Evening 5–1am (8h), Night 9–7am (8h), Full Day 9–6 (9h), Split (manual hours)

**DB tables required (run in Supabase SQL editor):**
```sql
-- hr_shift_types: per-client shift templates
CREATE TABLE hr_shift_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name text NOT NULL, color text NOT NULL DEFAULT '#6B7280',
  start_time text, end_time text, hours numeric,
  sort_order int NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE hr_shift_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY "client_access" ON hr_shift_types FOR ALL USING (
  (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));
GRANT ALL ON hr_shift_types TO authenticated;

-- hr_roster: one row per employee per BS day
CREATE TABLE hr_roster (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  shift_type_id uuid REFERENCES hr_shift_types(id) ON DELETE SET NULL,
  bs_year int NOT NULL, bs_month int NOT NULL, bs_day int NOT NULL,
  note text, created_at timestamptz DEFAULT now(),
  UNIQUE (client_id, employee_id, bs_year, bs_month, bs_day)
);
ALTER TABLE hr_roster ENABLE ROW LEVEL SECURITY;
CREATE POLICY "client_access" ON hr_roster FOR ALL USING (
  (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));
GRANT ALL ON hr_roster TO authenticated;
```

**Other changes:**
- `src/shared/constants/shiftTypes.js` — now superseded by DB-driven `hr_shift_types` (file kept but unused)
- Route `/hr/roster` added to `src/App.js`
- Nav entry "📅 Staff Roster" added between Employees and Attendance in `src/components/Layout.js`

### S172 — 2026-06-29 — Chart expand modals + daily trend 10-day window

**New component — `src/components/ChartCard.js`:**
- Reusable card wrapper with `renderChart(height)` render prop — chart JSX written once, called at card size and modal size
- Expand button (⛶ icon) in every chart header opens a `createPortal` fullscreen modal (92% viewport, max 1100px wide, 440px chart height)
- `titleStyle` + `cardStyle` props allow override for non-standard card layouts
- Modal uses `h > 200` check inside renderChart to scale dot sizes, bar counts, font sizes, margins

**Charts upgraded across 3 files:**
- `Dashboard.js`: Spend by Category (pie scales inner/outer radius in modal) · Daily Purchases vs Sales · Top Items by Spend (modal shows all 10 vs 6) · Food Cost % Monthly Trend
- `MenuEngineering.js`: Popularity vs Profitability scatter · Top Items by Revenue bar
- `BestSellers.js`: Top 10 bar

**Daily Purchases vs Sales — 10-day window (`Dashboard.js`):**
- Current month: chart shows only day (today−6) → day (today+3); projected month-end revenue footer still uses full-month trend math
- Past/closed months: show full actuals as before

**Old manual modal removed** from Dashboard.js (`chartExpanded` state + fullscreen block replaced by ChartCard)

### S171 — 2026-06-29 — Admin dashboard rebuild + ESLint fixes + login page polish

**ESLint fixes (`src/pages/AdminClients.js`):**
- `[posEndsAt]` — removed unused setter from destructure (POS has no billing UI yet; state initialises from DB)
- `toggleImsEnabled` / `toggleHrEnabled` — deleted both; dead code, duplicates of the wired-up `handleToggleIms` / `handleToggleHr`

**Admin dashboard rebuild (`src/pages/Dashboard.js`):**
- Query extended to include `ims_enabled`, `hr_enabled`, `is_trial`, `subscribe_requested`, `trial_expires_at`
- **6 KPI cards** (was 4): Active Properties (with IMS/HR/POS module adoption pills) · Active Today (own card, green pulse, names listed) · Expiring ≤30 Days (turns red + "X critical ≤7 days" when churn risk detected) · No Open Period · MRR + ARR · Trial Signups
- MRR now sums IMS + HR billing (`ims_ends_at || subscription_ends_at` + `hr_ends_at`); ARR = MRR × 12 shown as sub-line
- **Two tables merged into one** "All Properties" table: Property (green active-today dot) · Modules (IMS/HR pills) · Plan (+ HR plan if different) · Monthly Value (IMS+HR combined) · Billing type (+ "HR exp. Xd" warning if HR expiring separately) · Expires (BS) · Sub Status badge · Period · Actions
- Trial Signups card: amber border when trials exist, red border + pulsing dot when any trial user clicked "Subscribe"; clicking navigates to `/admin/clients`

**Login page (`src/pages/Login.css`):**
- Modal widened: `max-width` 840px → 1020px (more rectangular landscape shape)
- All font sizes +1pt (10→11, 11→12, 12→13, 13→14, 16→17, 20→21, 22→23)
- Height reduced: panel padding 32px → 22px, brand/pitch/highlights/form gaps and margins all tightened

### S170 — 2026-06-29 — Crest HR: Phase 2 Compliance — married TDS, festival TDS, gratuity tracker, final settlement

**TDS engine (`src/modules/hr/payroll/tds.js`):**
- Added `SLABS_2082_83_MARRIED` — married/couple schedule for FY 2082/83: first 3 bands are +1L wider than single (6L/8L/11L vs 5L/7L/10L); the distinction was removed in FY 2083/84 (unified `SLABS_2083_84` already in place)
- `slabsFor(fyStart, isMarried)` — returns married slabs for FY ≤ 2082, unified slabs for FY ≥ 2083 regardless of marital status
- `computeMonthlyTds` — added `isMarried` and `festivalBonus` params to the signature
- `computeBonusTds({ annualTaxable, bonusAmount, isSsf, isMarried, fyStart })` — new export: incremental marginal TDS on lump-sum payments using tax(base+bonus) − tax(base)

**PayrollRun (`src/modules/hr/payroll/PayrollRun.jsx`):**
- Employee fetch now includes `marital_status`
- `buildRows()` detects `isMarried = emp.marital_status === 'married'` and passes it to `computeMonthlyTds`

**FestivalAllowance (`src/modules/hr/festival/FestivalAllowance.jsx`):**
- Employee fetch now includes `marital_status`, `ssf_enrolled`
- TDS estimated per employee via `computeBonusTds` using annual basic as the taxable income baseline and marginal rate on the bonus amount
- 5 stat cards (was 3): Gross Payout, Total TDS (red), Net Payout (green), Employees, Average Gross
- TDS column added to table with per-employee estimated TDS; footer shows total TDS
- Excel export now outputs Gross Amount / TDS (est.) / Net Amount columns
- Footer note updated explaining TDS computation and married/single schedule

**New: GratuityTracker (`src/modules/hr/gratuity/GratuityTracker.jsx`) — route `/hr/gratuity`:**
- Read-only accrual tracker for all active monthly-paid employees
- Per-employee: service months, monthly accrual (basic ÷ 12), Labour Act total accrued, SSF-covered portion (3.33% of capped basic × months), net cash liability
- 4 stat cards: Total Liability (net), Monthly Accrual, Vested Employees, SSF Fund (est.)
- Filters: All / Vested ≥1 yr / Vesting <1 yr + department selector
- Excel export; daily/hourly staff excluded with banner warning

**New: FinalSettlement (`src/modules/hr/settlement/FinalSettlement.jsx`) — route `/hr/settlement`:**
- Pure calculator — no DB writes; inputs: employee, separation reason, last BS working date, leave days, notice served, festival paid this FY
- Computes: partial-month salary (basic ÷ BS month days × days worked), leave encashment (basic ÷ 26 × days), gratuity (if vested), festival pro-ration (if not paid), notice deduction, advance recovery (auto-fetched outstanding balances), TDS on lump sum via `computeBonusTds`
- Earnings table + Deductions table + Net payout card with printable output

**Wiring:**
- Routes added to `src/App.js`: `/hr/gratuity` and `/hr/settlement`, both wrapped in `<ModuleGate module="hr">`
- Nav entries added to `HR_ITEMS` in `src/components/Layout.js`: Gratuity 💰, Final Settlement 🧾
- Help entries added for Gratuity and Final Settlement with tips in `src/pages/Help.js`
- Festival Allowance Help tip updated: TDS is now estimated (no longer "no tax withheld yet")

**Files:** `src/modules/hr/payroll/tds.js`, `src/modules/hr/payroll/PayrollRun.jsx`, `src/modules/hr/festival/FestivalAllowance.jsx`, `src/modules/hr/gratuity/GratuityTracker.jsx` (new), `src/modules/hr/settlement/FinalSettlement.jsx` (new), `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`

**Admin Dashboard bug fixes (`src/pages/Dashboard.js`):**
- `loadAdminStats()` query was missing `ims_ends_at`, `hr_ends_at`, `billing_cycle`, `hr_plan` — `getSubStatus()` always fell back to the legacy `subscription_ends_at`, showing wrong subscription badges/expiry for all clients on per-module billing
- `PLAN_MRR` was `{ starter: 8000, growth: 18000, pro: 25000 }` — corrected to actual plan prices `{ starter: 5000, growth: 8000, pro: 12000 }`
- `estMRR`, `isPaying`, `expiryIso`, and the "paying clients" count all checked `c.subscription_ends_at` directly, missing `ims_ends_at` — all updated to use `c.ims_ends_at || c.subscription_ends_at`

---

### S169 — 2026-06-29 — Admin: Billing tab overhaul — module toggles, per-module subscriptions, compact cards

**Modules tab removed; Billing tab consolidated:**
- Modules tab removed from admin client drawer entirely
- New Modules section at top of Billing tab: on/off toggle switches for Crest IMS, Crest HR, Crest POS (coming soon); toggles instantly save `ims_enabled`/`hr_enabled` to DB
- Plan pills removed from module toggle rows — plan selection moved to dedicated plan card sections below
- HR plan cards added below IMS plan cards; both show price detail (NPR X,XXX/mo) that updates with billing cycle
- Admin Free Trial (1-month) card removed — disconnected legacy mechanism; real trial is the 7-day self-service flow via `register_trial` Edge Function (`is_trial`, `trial_expires_at`, `trial_purge_at`)

**Per-module subscription end dates:**
- `clients` table: new columns `ims_ends_at timestamptz`, `hr_ends_at timestamptz`, `pos_ends_at timestamptz`
- Billing tab now shows a separate section per enabled module (IMS / HR): plan cards + date picker + quick extend (+7 Days / +1 Month / +3 Months / +1 Year) + Clear button + inline status badge (green / amber / red / Expired)
- `handleSaveSub` saves all three module dates instead of global `subscription_ends_at`
- IMS date pre-fills from legacy `subscription_ends_at` on first open (migration path — no data lost)
- `loadClients` expiry check: client stays active while ANY module date is valid; only deactivated when all module dates have expired
- `subscription.js`: new `getDateStatus(endsAt)` helper for per-module badges; `getSubStatus` updated to use `ims_ends_at → subscription_ends_at → trial` fallback chain
- AuthContext + Layout `allClients` query updated to include the three new columns

**Compact client cards:**
- Removed 3-column module strip (toggles, plan labels) and separate action footer
- Module status now shown as inline pills in the main row: `IMS · Pro`, `HR · Starter`, `HR · off` (color-coded by plan tier)
- Manage → button moved into the main row alongside Sub badge + Annual badge
- Features ⊞ and Deactivate/Activate moved to a slim secondary bar below
- Card height roughly halved; all clients fit without scrolling

**DB migrations:**
```sql
ALTER TABLE clients
  ADD COLUMN ims_ends_at timestamptz,
  ADD COLUMN hr_ends_at  timestamptz,
  ADD COLUMN pos_ends_at timestamptz;
```

**Files:** `src/pages/AdminClients.js`, `src/utils/subscription.js`, `src/context/AuthContext.js`, `src/components/Layout.js`

---

### S168 — 2026-06-29 — Admin: Billing cycle + corrected plan prices

**Billing cycle (monthly vs annual) added to admin client billing:**
- `clients` table: new `billing_cycle text DEFAULT 'monthly'` column
- Billing tab: Monthly / Annual toggle above plan selector — "Annual · Save 25%" lights up in accent gold when selected
- Plan cards now show correct prices matching the public Pricing page: Starter NPR 5,000/8,000 · Growth NPR 6,000/8,000 → wait, corrected: Starter 5k/3.75k · Growth 8k/6k · Pro 12k/9k (monthly/annual)
- Rate note below plans shows full annual cost (e.g. NPR 3,750/mo × 12 = NPR 45,000/yr) or monthly rate
- `handleSaveSub` saves `billing_cycle` alongside `plan` and `subscription_ends_at`
- Client card: gold "Annual" badge appears next to subscription status badge for annual subscribers
- Fixed: previous billing tab showed wrong monthly prices (8k/18k/25k instead of 5k/8k/12k)

**DB migration:** `ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_cycle text DEFAULT 'monthly';`

**Files:** `src/pages/AdminClients.js`

---

### S167 — 2026-06-29 — HR: Annual TDS Certificate

**Annual TDS Certificate (new tab in HR Reports):**
- New "TDS Certificate" tab in `HrReports.jsx` — independent of the monthly period selector
- Fiscal year dropdown (derived from existing periods via `fiscalYearOf`) + employee dropdown
- Fetches all finalized payslips for the selected employee + FY, sorted by month in FY order
- Certificate shows: employer/employee details, month-wise gross/SSF/other deductions/TDS table, taxable income computation (subtracting SSF + capped insurance deductions), TDS summary panel, signature blocks
- Insurance premium deductions pulled from `hr_employees` (life + health, caps applied)
- Employer PAN left as blank line (filled by hand) — employee PAN shown from record with amber warning if missing
- Print button triggers `window.print()` for browser PDF; tab/period selector hidden via `no-print`
- Client name fetched from `clients` table for certificate header

**Files:** `src/modules/hr/reports/HrReports.jsx`, `src/pages/Help.js`

---

### S166 — 2026-06-29 — HR: Insurance premium TDS deductions

**Insurance premium TDS deductions (life + health):**
- `hr_employees`: two new columns — `life_insurance_premium numeric DEFAULT 0`, `health_insurance_premium numeric DEFAULT 0`
- `tds.js`: `computeMonthlyTds` now accepts `annualLifeInsurance` + `annualHealthInsurance`; caps at NPR 40,000 (life) and NPR 20,000 (health) per Nepal Income Tax Act 2058 Section 12; deducted from `annualTaxable` before slab computation
- `PayForm.jsx`: new "Tax Deduction Declarations" section in Bank/SSF tab — two number fields (annual NPR amounts, with cap warnings); saved to `hr_employees`
- `PayrollRun.jsx`: passes both insurance fields from employee record into `computeMonthlyTds`
- Help: Pay Setup entry updated to describe the Tax Deduction Declarations section

**DB migration:** `ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS life_insurance_premium numeric DEFAULT 0, ADD COLUMN IF NOT EXISTS health_insurance_premium numeric DEFAULT 0;`

**Files:** `src/modules/hr/payroll/tds.js`, `src/modules/hr/pay/PayForm.jsx`, `src/modules/hr/payroll/PayrollRun.jsx`, `src/pages/Help.js`

---

### S165 — 2026-06-29 — HR: SSF enrollment gate + Advances & Loans ledger

**SSF enrollment gate decoupled (`payrollCompute.js`, `PayrollRun.jsx`, `HrReports.jsx`, `PayForm.jsx`, `EmployeeForm.jsx`):**
- Added `ssf_enrolled boolean DEFAULT false` column to `hr_employees`; auto-migrated existing rows with `ssf_no` set to `true`
- `payrollCompute.js`: gate now uses `employee.ssf_enrolled` (not `ssf_no`) — SSF computed for all enrolled employees regardless of whether a registration number is on file
- `PayForm.jsx`: Bank/SSF tab now has an "SSF Enrolled" checkbox (with 11%/20% rate reminder); SSF No. field only shows when enrolled is checked
- `PayrollRun.jsx`: `isSsf` (TDS 1% slab waiver) and "no SSF" badge both use `ssf_enrolled`
- `HrReports.jsx`: SSF Challan filters `ssf_enrolled AND ssf_no` — needs both enrollment flag and a registration number to appear in the challan export
- Fix: Employer Cost in HR Reports is now accurate even before SSF numbers are entered

**Advances & Loans ledger (new feature):**
- New DB tables: `hr_advances` + `hr_advance_repayments` with RLS
- New page `src/modules/hr/advances/Advances.jsx` — issue advances/loans, filter by type/status, click row to see repayment history + progress bar, record repayments, settle with confirmation
- Route `/hr/advances` (ModuleGate hr); nav entry "Advances & Loans 💳"; Help entry added
- Advances = short-term (next payslip); Loans = multi-month with installment amount
- Repayments are manually recorded (not auto-deducted from payroll — installment amount shows as a reminder)

**Files:** `src/modules/hr/payroll/payrollCompute.js`, `src/modules/hr/payroll/PayrollRun.jsx`, `src/modules/hr/reports/HrReports.jsx`, `src/modules/hr/pay/PayForm.jsx`, `src/modules/hr/employees/EmployeeForm.jsx`, `src/modules/hr/advances/Advances.jsx`, `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`

---

### S164 — 2026-06-29 — Tooling: Google Stitch MCP connected

Connected Google Stitch to Claude Code via MCP (Model Context Protocol).

**What was done:**
- Located the correct Claude Code config file (`~/.claude.json` project `mcpServers` object) and created `.mcp.json` at the project root — the VS Code extension reads `.mcp.json`, not `settings.json`
- Stitch connected successfully and all 14 MCP tools loaded (`list_projects`, `list_screens`, `get_screen`, `generate_screen_from_text`, etc.)
- Listed the existing Stitch project "Inventory Management Dashboard" with 5 HTML screens: Stock Count Operation, Item Master List, Dashboard YOLO: Tactile Organic / Command Center / Minimalist Canvas
- User cancelled mid-session and disconnected Stitch — `.mcp.json` removed, `.claude.json` reverted

**To reconnect Stitch in future:** create `.mcp.json` in project root with `{ "mcpServers": { "stitch": { "type": "http", "url": "https://stitch.googleapis.com/mcp", "headers": { "X-Goog-Api-Key": "<key>" } } } }` then reload VS Code window.

No code changes. No commit.

---

### S163 — 2026-06-29 — HR: Pay Setup overhaul — dearness, CTC, Cash in Hand, compact calendar

**Pay Setup overhaul (`src/modules/hr/pay/PayForm.jsx`, `src/modules/hr/pay/PaySetup.jsx`):**
- Replaced the old "split from gross" helper with three dedicated fields: **Basic Salary**, **Dearness Allowance (महँगी भत्ता)**, and **Other Allowances** — dearness is stored as a named `hr_salary_components` row (no DB migration needed)
- Modal widened to 780px; two-column layout — inputs left, live Monthly Summary right
- Monthly Summary now shows: Basic → Dearness → Other Allowances → Gross → −SSF → **Net (Cash in Hand)** → **Cost to Company (CTC)** (blue) → Employer SSF. CTC = Gross + Employer SSF
- Compliance panel: checks Basic ≥ 12,170 / Dearness ≥ 7,380 / Gross ≥ 19,550 all at once with ✓/✗ per line; green "all clear" when all pass
- Daily/hourly staff now show estimated monthly cost (~rate × 26 days or × 8h × 26) in the summary table
- `getSalary()` separates dearness from other allowances; Excel export now has `'Dearness Allowance (NPR)'` and `'Other Allowances (NPR)'` as separate columns
- Allowances column tooltip updated to mention dearness is included

**PayrollRun payslip (`src/modules/hr/payroll/PayrollRun.jsx`):** "Allowances" label changed to "Allowances (incl. Dearness)" on the payslip modal/print

**payrollCompute.js:** removed stale comment referencing deleted SalaryList.jsx

**BsCalendarPicker compact (`src/components/BsCalendarPicker.js`):**
- Day buttons: `aspectRatio: 1` (square ~40px) → `height: 26px` fixed — reduces popup from ~320px to ~230px tall
- Popover width capped at 280px regardless of input width; left-edge clamped to viewport
- `above` threshold 300px → 240px; `bottom` anchor corrected for above-mode; `maxHeight: calc(100vh - 16px)` + `overflowY: auto` prevents viewport clip

**Help.js:** Pay Setup guide rewritten to document dearness field, CTC, Cash in Hand, and compliance panel.

No DB change. Build clean.

**Files:** `src/modules/hr/pay/PayForm.jsx`, `src/modules/hr/pay/PaySetup.jsx`, `src/modules/hr/payroll/PayrollRun.jsx`, `src/modules/hr/payroll/payrollCompute.js`, `src/components/BsCalendarPicker.js`, `src/pages/Help.js`

---

### S162 — 2026-06-29 — IMS cleanup: full BsCalendarPicker rollout + dead code removal

Completed the BS calendar picker migration across all remaining date fields.

**BsCalendarPicker free-mode fix:** Updated `src/components/BsCalendarPicker.js` to handle full ISO timestamps (from quick-extend buttons) in addition to `YYYY-MM-DD` strings — prevents `Invalid Date` when loading existing subscription end dates stored as ISO.

**AdminClients subscription date:** Replaced `BsFullDatePicker` (three cascading `<select>` dropdowns) with `BsCalendarPicker` visual grid (free mode). `extendSub()` now stores `YYYY-MM-DD` via `formatAd()` consistently. Added `clearable` prop.

**BsDatePicker.js deleted:** The old period-locked day dropdown and `BsFullDatePicker` components are no longer used anywhere — file removed entirely.

**Security fix:** Dropped `public.inventory_summary` view from Supabase (was SECURITY DEFINER — bypassed RLS, unused by app code). Removed from `supabase_schema.sql`.

**Files changed:** `src/components/BsCalendarPicker.js`, `src/pages/AdminClients.js`, `supabase_schema.sql`. `src/components/BsDatePicker.js` deleted.

---

### S161 — 2026-06-29 — HR: Employee form — Address, Family, Supervisor, Retirement tabs

Extended `src/modules/hr/employees/EmployeeForm.jsx` with two new tabs and additions to the Employment tab. No new child tables — all flat columns on `hr_employees`.

**Address tab (new):** Province (7 Nepal provinces) → District → Municipality/VDC → Ward → Tole for both **Permanent** and **Current** address. "Current address same as permanent" checkbox — when ticked, current is mirrored from permanent on save. Legacy single-line `address` value shown read-only as "On file" for existing employees; old `address` input removed from Personal tab.

**Family tab (new):** Marital Status (single/married/divorced/widowed) — Spouse Name appears only when married. Father's Name, Mother's Name, Grandfather's Name (with Tip noting lineage requirement on Nepal forms), Number of Children. **Nominee** sub-section (Name, Relationship, Contact) with Tip that nominee receives SSF/gratuity on death.

**Employment tab additions:** Reporting Supervisor `<select>` (active employees only, self excluded, shows "Name — Designation") with self-referential FK `ON DELETE SET NULL`. Retirement Date `BsCalendarPicker` + **↻ Age 60** button (DOB + 60 years; disabled until DOB entered; Tip notes SSF pension age).

**DB migration run ✓** (22 `ALTER TABLE IF NOT EXISTS` columns on `hr_employees`): `supervisor_id`, `retirement_date`, `marital_status`, `spouse_name`, `father_name`, `mother_name`, `grandfather_name`, `children_count`, `nominee_name`, `nominee_relationship`, `nominee_contact`, `perm_province/district/municipality/ward/tole`, `same_as_permanent`, `temp_province/district/municipality/ward/tole`.

No service-worker bump needed (JS-only change). Build clean.

**File:** `src/modules/hr/employees/EmployeeForm.jsx`

---

### S160 — 2026-06-29 — Login redesign (split layout + trial); signup phone field; full BS calendar picker

**Login page — two-column split layout (`src/pages/Login.js`, `Login.css`):**
- Left panel: brand + tagline **"Smarter menus. Better margins."** + 4 feature highlights (live recipe FC% on every purchase, stock/variance, BS calendar + supplier tracking + payables aging, menu engineering) + the trial signup form. Right panel: clean "Welcome back" sign-in. Vertical divider; stacks vertically on mobile (sign-in on top). Tabs removed entirely; plain `/login` works as a shareable link for both prospects and existing users. `?trial=1` still focuses the trial form first. Layout compressed to fit a single viewport without scrolling.

**Trial signup — phone field:**
- Added required **Phone** field to the trial form, stored on `clients.contact_phone` (Edge Function `register_trial` passes it through). Admin Trial Accounts panel shows the phone as a clickable `wa.me/977…` WhatsApp link for instant outreach.

**Full Bikram Sambat calendar picker (`src/components/BsCalendarPicker.js` — NEW):**
- Visual month-grid picker (Su–Sa headers, click-to-select day, Today highlight, prev/next month nav, optional Clear). Uses `createPortal` + fixed positioning so it never clips inside modals/cards; flips above the trigger near the viewport bottom.
- **Two modes:** *free* (value = AD ISO `YYYY-MM-DD`, month nav enabled) and *period-locked* (`lockYear`+`lockMonth` → value = day-number, grid pinned to the open period, no month nav — a drop-in for the old `BsDatePicker` dropdown so entries can't escape their accounting period).
- **Replaced free-mode AD `type="date"` inputs:** PurchaseOrders expected delivery, OutstandingPayables paid date, EmployeeForm date_of_birth / join_date / contract end_date / retirement_date, LeaveManagement start/end (was `BsFullDatePicker`). Dropped "(AD)" labels.
- **Replaced period-locked day pickers/selects:** Purchases bill day, Requisitions day, Sales day selector (kept ‹ › steppers + Today), Stock daily-wastage day.
- Left as-is: report period selectors (BS year/month dropdowns) and AdminClients subscription date (`BsFullDatePicker`, ISO-timestamp dating). `src/components/BsDatePicker.js` retained for that one admin use.

No DB change beyond the S159 trial columns. Build clean (Edge Function `admin-user-ops` redeployed for the phone passthrough).

**Files:** `src/pages/Login.js`, `src/pages/Login.css`, `src/components/BsCalendarPicker.js` (new), `src/pages/Purchases.js`, `src/pages/Requisitions.js`, `src/pages/Sales.js`, `src/pages/Stock.js`, `src/pages/PurchaseOrders.js`, `src/pages/OutstandingPayables.js`, `src/modules/hr/employees/EmployeeForm.jsx`, `src/modules/hr/leave/LeaveManagement.jsx`, `src/pages/AdminClients.js`, `supabase/functions/admin-user-ops/index.ts`

---

### S159 — 2026-06-29 — Items filter chips; Menu Engineering + Overheads charts; break-even fix; free trial system

**Item Master filter chips:**
Usage filter row added above the table — All / Recipes (R) / Purchases (P) / Stock (OS/CS) / Unused. Reads from existing `usageMap` badge data; category tab counts also respect the active usage filter.

**Menu Engineering — Charts view tab:**
Third view tab (Table | Matrix | Charts) with: scatter plot (FC% vs Qty Sold, quadrant reference lines at median qty and FC_CUTOFF=35%, per-quadrant hex colours for Star/Plowhouse/Puzzle/Dog); top-10 items by revenue (horizontal bar chart); category breakdown pivot table (count per quadrant per category). Charts always use all items regardless of the search/filter.

**Overheads — Cost Visualisation card:**
Inserted between P&L and break-even: revenue cost stack bar (CSS flexbox, segments coloured by category % of revenue), per-bucket mini bars, and a cross-bucket all-items ranked table (amount + % of total + % of revenue).

**Break-even message fix:**
Previously "Enter cost data to calculate" appeared for both zero overheads AND negative contribution margin (FC% > 100%). Now: FC > revenue → "Purchase cost X% FC exceeds revenue — break-even is undefined"; no overheads → "Enter overhead costs above and save to calculate".

**Free trial system (full implementation):**
- **Pricing page** (`src/pages/Pricing.js`) — FAQ button/modal, Starter CTA → `/login?trial=1`, `CONTACT_EMAIL` constant for easy swap, footer email link.
- **Login page** (`src/pages/Login.js`) — rewritten: detects `?trial=1`, shows two-tab layout (Start Free Trial | Sign In); trial form (Business Name, Your Name optional, Email, Password); calls `register_trial` Edge Function then auto-signs in.
- **Edge Function** (`supabase/functions/admin-user-ops/index.ts`) — `register_trial` action handled before admin JWT check: creates auth user → client (`is_trial=true`, `plan='starter'`, `trial_expires_at=+7d`, `trial_purge_at=+22d`) → profile; rolls back on partial failure. All other actions still require admin role.
- **AuthContext** (`src/context/AuthContext.js`) — reads `is_trial, trial_expires_at, trial_purge_at, subscribe_requested`; computes `isTrial, trialExpired, trialDaysLeft, trialPurgeInDays, subscribeRequested`; exposes `requestSubscription()` via `request_subscription` RPC (SECURITY DEFINER).
- **Layout** (`src/components/Layout.js`) — amber banner (≤4 days left, not expired): shows days left + "I Want to Subscribe" button; red banner (expired, purge pending): retention countdown + "Subscribe Now"; pulsing red dot + count badge on Clients nav item when `pendingTrialCount > 0`.
- **AdminClients** (`src/pages/AdminClients.js`) — "Trial Accounts" panel (red border, dark-red gradient header, count badge); per-row: business name, days left/expired, purge deadline, pulsing dot for subscribe_requested; actions: "Convert to Paid" (clears trial flags, opens drawer), "+7 Days" (extends both timestamps), "✓ Dismiss" (clears subscribe flag), "Manage" (opens drawer).

**DB migration required (run in Supabase SQL editor):**
```sql
ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_trial boolean DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS trial_start_date date;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS trial_expires_at timestamptz;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS trial_purge_at timestamptz;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS subscribe_requested boolean DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS subscribe_requested_at timestamptz;

CREATE OR REPLACE FUNCTION request_subscription()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE clients
  SET subscribe_requested = true, subscribe_requested_at = now()
  WHERE id = (SELECT client_id FROM profiles WHERE id = auth.uid());
END;
$$;
```

No other DB change. Build clean.

**Files:** `src/pages/Items.js`, `src/pages/MenuEngineering.js`, `src/pages/Overheads.js`, `src/pages/Pricing.js`, `src/pages/Login.js`, `src/context/AuthContext.js`, `src/components/Layout.js`, `src/components/Layout.css`, `src/pages/AdminClients.js`, `supabase/functions/admin-user-ops/index.ts`

---

### S158 — 2026-06-29 — Purchases: discount before VAT; Vendor Report discounts tab + combobox

**Discount-before-VAT fix (correct Nepal IRD treatment):**

Previously the purchase bill footer computed `Subtotal + VAT − Discount`. Corrected to `Subtotal − Discount = Taxable → +VAT(13%) = Grand Total`, matching vendor invoices and Nepal IRD practice (VAT is levied on net taxable value, not list price).

- **`src/pages/Purchases.js`** — bill entry form: discount input moved above VAT line; Taxable row shown when discount > 0; VAT now computed on `vatSubtotal × (1 − discount/billTotal)`. List view group header also corrected.
- **`src/pages/VatReport.js`** — input VAT now computed on discount-adjusted taxable base. Entry table footer adds Trade Discount and Taxable Totals rows when discount exists. CA Summary table gains Discount and Taxable Base columns. Excel CA Summary sheet updated. `buildVendorSummary` updated to track per-vendor discount.

**Vendor Report enhancements:**

- **Discount Received tab** — new third tab showing vendor-level discount summary (# bills, total discount, avg %) and bill-by-bill detail (Day, Vendor, Invoice, Bill Total, Discount, Disc %, VAT, Grand Total, Payment). Excel export gains a "Discounts Received" sheet when discounts exist.
- **Vendor Summary** — now deducts bill-level discounts from Net Spend. New Discount column added to the table. `grandNet` and all derived figures (%, Avg/Day, payment splits) reflect the corrected net. Grand Total stat card similarly corrected.
- **Spend split legend** — bar segments are now clean color blocks; percentages for every vendor (including small ones) shown in the color-coded legend below.
- **Vendor search** — replaced plain input with a combobox dropdown: click/type to open vendor list with net spend on the right, click to filter, × to clear.

No DB change. Build clean.

**Files:** `src/pages/Purchases.js`, `src/pages/VatReport.js`, `src/pages/VendorReport.js`

---

### S157 — 2026-06-26 — Tooltip audit: add missing Tip tooltips across all pages

Full audit of every page and module for missing `<Tip>` tooltips on non-obvious column headers. 18 tooltips added across 6 files.

- **Stock.js** — Category summary: `Production / Purchase (NPR)` (explains "production" = sub-recipes), `COGS (NPR)` (formula). Item detail value columns: `Open. Value`, `Purch. Value`, `Wastage Value`, `Staff Meals Value`, `Close Value` (all explain qty × rate), `COGS (NPR)` (formula).
- **Items.js** — `Purch. Qty` (base units per purchase unit), `Rate (NPR)` (per purchase unit), `/ UOM` (generated per-base-unit rate), `Conversion` (unit mapping), `Used In` (recipe count).
- **Requisitions.js** — `Rate / UOM` and `Est. Value` / `Value Issued` / `Value` in all three requisition tables (entry, issue confirm, history).
- **HrReports.jsx** — SSF Challan: `Employee 11%`, `Employer 20%`, `Total 31%` (contribution details and cap).
- **PayrollRun.jsx** — `Other Ded` (all deductions except SSF).
- **Overheads.js** — `% of Bucket` (share of the bucket's total).

No DB change. Build clean.

**Files:** `src/pages/Stock.js`, `src/pages/Items.js`, `src/pages/Requisitions.js`, `src/modules/hr/reports/HrReports.jsx`, `src/modules/hr/payroll/PayrollRun.jsx`, `src/pages/Overheads.js`

---

### S156 — 2026-06-26 — HR: fold Salary Structure into Pay Setup; drop the separate page

Merged all of SalaryList's functionality into **Pay Setup** so there is one place for both viewing and editing employee pay. Pay Setup now shows stat cards (Total Gross Payroll, SSF Employee, SSF Employer, Net Payroll), a full breakdown table (Basic / Allowances / Gross / Deductions / Net / SSF Employer / Bank), totals footer, and Excel export — plus the existing click-to-edit modal. Salary Structure is removed.

- `src/modules/hr/pay/PaySetup.jsx` — fully rewritten: stat cards + getSalary/totals logic + full breakdown table + export ported from SalaryList; click row → PayForm modal unchanged.
- `src/modules/hr/salary/SalaryList.jsx` — deleted.
- `src/App.js` — removed `import SalaryList` and `/hr/salary` route.
- `src/components/Layout.js` — removed Salary Structure nav item.
- `src/pages/Help.js` — replaced Salary Structure entry with Pay Setup guide.
- Service worker cache `crest-v13` → `crest-v14`.

No DB change. Build clean.

**Files:** `src/modules/hr/pay/PaySetup.jsx`, `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`, `public/service-worker.js`

---

### S155 — 2026-06-25 — HR: split Salary + Bank/SSF into a dedicated "Pay Setup" page

The Add/Edit Employee modal carried Salary and Bank/SSF tabs. Moved them out into a new **Pay Setup** page (sidebar, between Employees and Salary Structure) so the employee form stays about the person, and pay/banking is managed on its own.

- **New** `src/modules/hr/pay/PaySetup.jsx` (`/hr/pay-setup`) — employee directory (name, department, pay basis, basic/rate, net, bank set/not-set) filtered by status; click a row → edit modal.
- **New** `src/modules/hr/pay/PayForm.jsx` — centered modal with the combined **Salary** + **Bank/SSF** tabs (pay basis, split-from-gross, basic, allowances/deductions with quick chips, SSF auto-calc + net summary, bank + SSF no.). Saves the pay/bank columns on `hr_employees` and syncs `hr_salary_components` (delete-all + re-insert).
- **EmployeeForm** trimmed to Personal · Employment · Address · Family. Removed the salary/component state, split logic, SSF calc, and — importantly — the `hr_salary_components` delete/re-insert from its save, so editing an employee no longer touches their pay components. The pay/bank columns still round-trip untouched on save.
- Nav: added **Pay Setup** between Employees and Salary Structure (`Layout.js`); route in `App.js`.

No DB change (reuses existing columns/tables). Build clean. Service worker cache `crest-v12` → `crest-v13`.

**Files:** `src/modules/hr/pay/PaySetup.jsx`, `src/modules/hr/pay/PayForm.jsx`, `src/modules/hr/employees/EmployeeForm.jsx`, `src/App.js`, `src/components/Layout.js`, `public/service-worker.js`

---

### S154 — 2026-06-25 — HR: Employee form as centered modal (was right drawer)

The Add/Edit Employee form (`EmployeeForm.jsx`) opened as a right-side slide-in drawer. Converted it to a **centered floating modal** — outer container now `justify/align center` with padding; the panel is `560px`, `maxHeight 90vh`, `borderRadius 12`, full border + drop shadow, `overflow hidden`. The existing header/footer stay fixed and the body scrolls inside (already `flex:1; overflow-y:auto`). Backdrop-click close unchanged.

No DB change. Build clean. Service worker cache `crest-v11` → `crest-v12`.

**Files:** `src/modules/hr/employees/EmployeeForm.jsx`, `public/service-worker.js`

---

### S153 — 2026-06-25 — HR: surface supervisor + retirement (list, reports, retiring-soon flag)

Built on S152 — exposes the new `supervisor_id` / `retirement_date` fields across the HR module.

- **Employee List** (`EmployeeList.jsx`) — added **Supervisor** and **Retirement** columns, a **Retiring Soon** stat card (active/probation retiring ≤180 days, click to filter), row chips ("Retiring soon" amber / "Retired" red), a **supervisor filter** `<select>` (incl. "No supervisor"), and a "Retiring soon" toggle pill. Supervisor names resolved from the in-memory employee list (`nameById`).
- **HR Reports** (`HrReports.jsx`) — new **Roster** tab: full employee directory (Code, Name, Department, Designation, **Supervisor**, Join Date, **Retirement** + flag, Status) with retiring-soon count, "Retiring soon" toggle, and Excel export. Employee master now loads independently of a payroll run, and the run-gate was restructured so Roster works even before any payroll is generated (the 4 payroll tabs stay gated).
- Shared 180-day `retireInfo()` helper (retired/soon/none) inlined in both files; threshold `RETIRE_SOON_DAYS = 180`.

No DB change (uses S152 columns). Build clean. Service worker cache `crest-v10` → `crest-v11`.

**Files:** `src/modules/hr/employees/EmployeeList.jsx`, `src/modules/hr/reports/HrReports.jsx`, `public/service-worker.js`

---

### S152 — 2026-06-25 — HR employee: family, structured address, supervisor, retirement

Expanded the Add/Edit Employee form (`EmployeeForm.jsx`) to match Nepal HR norms (researched against Nimble HRMS + Nepal govt/PAN employee forms). Two new tabs + two Employment fields, all flat columns on `hr_employees`.

- **Address tab** — structured Nepal address (Province → District → Municipality/VDC → Ward → Tole) for **permanent** + **current**, with a "current same as permanent" toggle that mirrors on save. Replaces the old single free-text `address` line (legacy `address` retained in DB, shown read-only "On file" when present).
- **Family tab** — Marital Status, Spouse (shown when married), Father / Mother / Grandfather names, No. of Children, and a **Nominee** (name, relationship, contact) for SSF/gratuity settlement.
- **Employment tab** — **Reporting Supervisor** (self-referential select of active employees, excludes self) and **Retirement Date** with a "↻ Age 60" auto-fill (DOB + 60, Nepal SSF pension age).
- Typed empties serialize to `null` (supervisor_id/retirement_date/children_count) to avoid Postgres type errors; `supervisor_id` FK is `ON DELETE SET NULL`.

**DB migration required** (all nullable, idempotent — see db_schema run log): `supervisor_id`, `retirement_date`, `marital_status`, `spouse_name`, `father_name`, `mother_name`, `grandfather_name`, `children_count`, `nominee_name`, `nominee_relationship`, `nominee_contact`, and `perm_*`/`temp_*` address columns + `same_as_permanent`.

Build clean. Service worker cache `crest-v9` → `crest-v10`.

**Files:** `src/modules/hr/employees/EmployeeForm.jsx`, `public/service-worker.js`

---

### S151 — 2026-06-25 — Sync public Pricing page with actual plan tiers

Audited the plan/pricing feature lists against the live gating in `AuthContext` (`STARTER_KEYS` / `GROWTH_KEYS` / `PRO_KEYS`). The in-app `Help.js` lists were accurate but missing the two newest Growth features; the public `Pricing.js` page was significantly stale.

- **Pricing.js** was selling Starter features (Sales Entry, Monthly Summary, Payment Summary, Reorder, VAT) as *Growth* extras, omitted ~9 Starter features, missed several Growth features (Outstanding Payables, Requisitions, Dead Stock, Recipe Margin, Staff Meals), missed Pro's Period Comparison + Shrinkage Report, and mis-listed Settings under Pro. Rewrote all three feature arrays to match the real tiers (prices unchanged).
- Added the two newest Growth features — **Menu Repricing** and **Nutrition Facts** — to both `Pricing.js` and `Help.js` Growth lists.

No DB change. Build clean. Service worker cache `crest-v8` → `crest-v9`.

**Files:** `src/pages/Pricing.js`, `src/pages/Help.js`, `public/service-worker.js`

---

### S150 — 2026-06-25 — Menu Repricing report + Dashboard "Menu Health" card

New owner-facing report (the gap industry sources rank #1: "Menu Price Analysis"). Surfaces, in one prioritized list, **which dishes are priced below their target food-cost % and how much margin that leaks per month** — and the exact price to charge to fix it. All inputs already existed (`target_fc_pct`, `getSuggestedPrice`, sales qty); nothing was being aggregated this way.

- **New page** `src/pages/MenuRepricing.js` (`/menu-repricing`, Growth, feature key `menu_repricing`), modeled on `RecipeMargin.js`. Columns: Qty Sold, Food Cost/Portion, Current Price (ex-VAT), Current FC%, Target FC%, Suggested Menu Price (incl VAT, rounded), Price Gap (ex-VAT), Monthly Opportunity (gap × qty). Sort by Opportunity / Price Gap / Most-over-target; filters for "Only underpriced" + "Only with sales" + category. Print + Excel export. Stat cards: Underpriced Dishes, Monthly Opportunity, Biggest Leak.
- **Math (ex-VAT, matching app-wide FC%):** `suggestedExVat = cost / (target/100)`, `gap = max(0, suggestedExVat − price)`, `monthly = gap × qtySold`. Underpriced when `currentFcPct > target`. The displayed Suggested Menu Price is VAT-inclusive (via shared `getSuggestedPrice`) and clearly labeled so it isn't conflated with the ex-VAT gap.
- **Shared util:** extracted `getSuggestedPrice` out of `Recipes.js` into `src/utils/recipeCost.js`, imported by both the Recipes page and the new report (no duplicated formula).
- **Dashboard "Menu Health" card** (gated on `menu_repricing`): "N of M dishes under target" + "NPR X/mo opportunity →", links to the report. Computed in the existing IMS fetch (added `target_fc_pct`/`category`/`is_active` to the recipes select and `items(per_uom_rate)` to the ingredient join; reuses the period sales map) so the card and report match exactly.
- Wired the feature flag across `AuthContext` (GROWTH_KEYS), `SettingsContext`, `AdminClients` (Growth group), `App.js` route, `Layout.js` REPORTS nav, and `Help.js`.

**DB migration required:**
```sql
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS menu_repricing boolean;
```

Service worker cache bumped `crest-v7` → `crest-v8`. Build clean.

**Files:** `src/pages/MenuRepricing.js`, `src/utils/recipeCost.js`, `src/pages/Recipes.js`, `src/pages/Dashboard.js`, `src/context/AuthContext.js`, `src/context/SettingsContext.js`, `src/pages/AdminClients.js`, `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`, `public/service-worker.js`

---

### S149 — 2026-06-25 — UI: stop mouse wheel from changing focused number inputs

A focused `type="number"` input treats the mouse wheel as increment/decrement. When entering daily sales, scrolling the page to continue silently nudged the qty-sold value up/down, so the wrong number got stored on "Save Day".

- Global passive `wheel` listener in `index.js` blurs the focused number input on scroll — the page still scrolls, but the entered value stays as typed
- One place, covers every number field (Sales, Requisitions, recipe forms, etc.)
- Service worker cache bumped `crest-v6` → `crest-v7`

No DB change. Build clean.

**Files:** `src/index.js`, `public/service-worker.js`

---

### S148 — 2026-06-25 — UI: remove number-input spinner arrows app-wide

Hid the up/down stepper arrows on all `type="number"` inputs (qty boxes in Sales, Requisitions, recipe forms, etc.) for a cleaner look. Inputs stay true number fields — mobile numeric keypad and `min`/`max` validation are preserved.

- Single rule in `Layout.css` targeting `::-webkit-inner/outer-spin-button` (Chrome/Safari/Edge) + `appearance: textfield` (Firefox) — applies everywhere, no per-field markup
- Service worker cache bumped `crest-v5` → `crest-v6`

No DB change. Build clean.

**Files:** `src/components/Layout.css`, `public/service-worker.js`

---

### S147 — 2026-06-25 — Admin/UI: ghost-button contrast + module-aware Feature Access

Two fixes. **Button contrast:** `.btn-ghost` and `.btn-danger` were near-invisible against card backgrounds (transparent fill, faint `--theme-text2` text + `--theme-border` outline), so the print/Edit/Save/Del actions disappeared. Gave them a filled `--theme-input-bg` surface, brighter `--theme-text1` text, lighter border, and an accent-colored hover — readable across all 9 themes, fixed in one place.

**Feature Access modal (AdminClients):** the modal lists only Crest IMS feature flags and showed `client.plan` (the IMS plan) regardless of the client's actual module — misleading for an HR-only client like "HR TEST".

- Title now reads **"Feature Access · Crest {module}"** and the badge reflects the **active module's** plan (`hr_plan` for an HR-only client, not the irrelevant IMS plan), mirroring the admin's Modules-tab selection
- When IMS is not enabled, the IMS plan grid is replaced with a notice ("Granular feature access applies to Crest IMS only…") and the Save button is hidden — nothing to grant since `ModuleGate` blocks all IMS routes anyway
- Service worker cache bumped `crest-v4` → `crest-v5`

No DB change. Build clean.

**Files:** `src/components/Layout.css`, `src/pages/AdminClients.js`, `public/service-worker.js`

---

### S146 — 2026-06-25 — Recipes: fix 0% VAT silently coerced to 13%

A recipe saved with **0% (No VAT)** came back as 13% on reopen — the menu price grossed itself up (e.g. 25 → 28.25). Root cause: `parseFloat('0')` is falsy, so every `parseFloat(vat_rate) || 0.13` fallback coerced a 0% selection back to 13%.

- **Save** (`payload.vat_rate`) wrote `0.13` to the DB even with No VAT selected — this is what corrupted the stored value
- **openEdit** hydration flipped a stored `0` back to `'0.13'`, and now uses `String(rec.vat_rate)` so the value matches the `<select>` option keys
- **Display paths** (detail view ×2, print card) routed through a new module-level `vatOf(rec)` helper so a legitimately 0% recipe no longer shows grossed-up at 13%
- Live form math, the Menu Price label, and the "Ex-VAT stored" / "incl. % VAT, rounded" hints are now VAT-aware (show "no VAT" / "Stored" at 0%)
- The Menu Price input is keyed on `vat_rate` so the displayed gross-up recalculates when the rate dropdown changes

Note: recipes saved before this fix retain `0.13` in the DB — reopen, re-select 0% VAT, and save once to correct them.

No DB change. Build clean.

**Files:** `src/pages/Recipes.js`

---

### S145 — 2026-06-25 — Recipes: Target FC% editable by all users + inline save

The **Target FC%** field was admin-only (lock icon). Unlocked it for all users and gave it a self-contained save flow so the target can be tuned without re-saving the whole recipe.

- Removed the `isAdmin` gate / lock icon from the field
- Permanent status dot next to the label: **green** = matches the DB value, **amber** = unsaved change
- Inline **Save** button (edit mode only) does a targeted `UPDATE recipes.target_fc_pct` and syncs `selectedRecipe` + `recipes` local state; disabled when value already matches saved
- New recipes save the target with the main Save Recipe button as before (no separate button shown)
- `fcPctSaved` state (string | null) tracks the DB-committed value; the live value feeds the suggested-price calc unchanged

No DB change. Build clean.

**Files:** `src/pages/Recipes.js`

---

### S144 — 2026-06-25 — Recipes: FC% filter pill strip on list view

Added a quick-filter pill strip above the recipe list to slice by food-cost band (e.g. All / ≤30% / 31–38% / >38%), matching the green/amber/red colour coding used elsewhere.

No DB change. Build clean.

**Files:** `src/pages/Recipes.js`

---

### S143 — 2026-06-25 — Settings: user-configurable recipe categories

Added a **Recipe Categories** tab to Settings (visible to clients with `recipe_costing` feature). Users can add, remove, and reorder their own category names — changes take effect immediately in the recipe form dropdown and the filter tab bar.

- `SettingsContext` exports `DEFAULT_RECIPE_CATS` and a derived `recipeCategories` value that reads `settings.recipe_categories` (text[] column) with automatic fallback to the defaults — zero disruption for existing clients
- `Recipes.js` replaces the hardcoded `RECIPE_CATS` constant with `recipeCategories` from context; tab bar order follows the user-defined list; recipes tagged with a removed category still appear under All Recipes (orphan-safe)
- Sub-Recipe / Prep Item is excluded from the user list — it remains system-managed

**DB migration required:**
```sql
ALTER TABLE settings ADD COLUMN IF NOT EXISTS recipe_categories text[];
```

Build clean.

**Files:** `src/context/SettingsContext.js`, `src/pages/Settings.js`, `src/pages/Recipes.js`

---

### S142 — 2026-06-25 — Recipes: USDA FoodData Central live nutrition fallback

When "⚡ Auto-fill nutrition" can't match an ingredient in the regional seed library, it now fires a live lookup against the **USDA FoodData Central API** (80,000+ foods, free, CC0) as a fallback. Seed matches still take priority; USDA fills the gaps.

- New utility: `src/utils/usdaNutrition.js` — searches FDC, maps nutrient IDs to our schema (energy, protein, carbs, fat, sugar, sodium), returns `{ basis_qty: 100, basis_unit: 'GM', ..., source: 'USDA FDC' }`
- `autoFillNutrition()` rewritten: seed matches first → USDA live lookup for misses → confirm dialog shows source split ("3 from regional library · 2 from USDA FoodData Central")
- Falls back to `DEMO_KEY` (30 req/hr) if `REACT_APP_USDA_API_KEY` is not set; free registered key allows 1,000 req/hr (sign up at fdc.nal.usda.gov/api-key-signup.html)
- `.env.example` updated with the new key entry

No DB change. Build clean.

**Files:** `src/utils/usdaNutrition.js`, `src/pages/Recipes.js`, `.env.example`

---

### S141 — 2026-06-25 — Recipes: % of Total column in ingredient edit form

Added a **% of Total** column to the ingredients table inside the recipe edit form (between Cost and Nutrition). Each ingredient row now shows its share of the total recipe cost (`ingredient cost ÷ liveCost × 100`). Rows with no cost show `—`. The column was already present in the read/detail view; this brings it into the edit view as well.

No DB change. Build clean.

**Files:** `src/pages/Recipes.js`

---

### S140 — 2026-06-25 — Recipes: remove Clone button + fix stale-data bug on save

Two fixes to Recipe Costing:

- **Removed Clone button** from both the regular recipes table and the sub-recipes table. The now-unused `cloneRecipe` function was also deleted.
- **Fixed stale-data bug** — `save()` was calling `setView('list')` before `await`-ing `init()`, so opening a recipe immediately after saving could show the old ingredient list. Reordered to `await init()` first, then switch to list — the "Saving…" state stays until fresh data is loaded.

No DB change. Build clean.

**Files:** `src/pages/Recipes.js`

---

### S139 — 2026-06-25 — Purchases: day pill strip filter

By mid-month the Purchases list grows long (10+ days of bills), making it tedious to scroll to find or edit a specific day's entries. Replaced the "All Days" dropdown with a horizontal scrollable **pill strip** above the item filter.

- Each pill shows the BS day number and a bill count (`Day 10 · 3 bills`). Clicking any pill filters the list instantly to that day's entries only; clicking **All Days** resets.
- The `billCountPerDay` map is derived from `purchases` via `useMemo` (counts distinct `purchase_group_id` per day).
- The item filter select and entry count remain on the row below the strip, unchanged.
- No DB change. Build clean.

**Files:** `src/pages/Purchases.js`

---

### S138 — 2026-06-24 — Save & Next/Prev navigation in edit dialogs

Editing many records one-by-one meant closing and reopening the modal each time. Added in-modal record navigation.

- **Items** ([Items.js](src/pages/Items.js)) and **Vendors** ([Vendors.js](src/pages/Vendors.js)) edit dialogs now have **← Prev / Next →** buttons with an **"X of Y"** counter in the footer. Each saves the current record (`doSave()` — validates + writes, returns success) then opens the adjacent record **in the visible sorted/filtered order** (`filtered`). Disabled at the list ends; only shown when editing an existing record (not on Add). On validation/DB error it stays put and shows the error.
- Refactored each page's `save()` into a reusable `doSave()` (no close/reload) + thin `save()` (close + reload) + `saveAndGo(dir)`.
- Applicable scope: the per-record edit **modals**. Other editors are day/period or multi-line forms (Purchases, Requisitions, POs, Overheads, Periods) where "next record" doesn't map; Recipes is a full-page editor (could get it later if wanted).
- Build clean. Help (Item Master tip) updated.

**Files:** `src/pages/Items.js`, `src/pages/Vendors.js`, `src/pages/Help.js`

---

### S137 — 2026-06-24 — Dashboard layout fix + daily sales totals + dropdown flip-up

UX polish follow-ups after the Purchases-vs-Sales chart shipped.

- **Chart squeezing the donut (fixed)** — the Purchases-vs-Sales card sits in a 3-col grid; its scroll wrapper's large `minWidth` made the grid column refuse to shrink (grid items default to `min-width: auto`), ballooning the track and squeezing the Spend-by-Category + Top-Items cards. Added `minWidth: 0` to the chart card so the column holds its share and the horizontal scrollbar works *inside* it. Also widened the row to `1fr 1.6fr 1fr` so the (richer) chart gets more room. [Dashboard.js](src/pages/Dashboard.js)
- **Daily sales day totals** — [Sales.js](src/pages/Sales.js) daily entry now shows a live **"Total qty sold (Day N)"** + **Day revenue** strip above the table, recomputed as quantities are typed and reflecting saved values when switching days.
- **SearchableSelect flip-up** — the fixed-position combobox dropdown always opened downward, pushing the list off-screen for rows near the bottom of the viewport. `measure()` now flips the panel **above** the field when there's not enough room below, and clamps the list height to the available space (min ~120px, internal scroll). Improves every picker (recipe ingredients, purchases, stock, requisitions). [SearchableSelect.js](src/components/SearchableSelect.js)

**Files:** `src/pages/Dashboard.js`, `src/pages/Sales.js`, `src/components/SearchableSelect.js`

---

### S136 — 2026-06-24 — Dashboard "Purchases vs Sales" trend + revenue projection

Reworked the Daily Purchase Trend card in [Dashboard.js](src/pages/Dashboard.js) into a dual-line trend with a forecast, designed POS-forward.

- **Sales overlay** — daily revenue line (green) over the purchase line (gold), shared NPR axis, with a legend. Revenue = Σ(`qty_sold` that day × recipe `selling_price`).
- **Daily-only / graceful degrade** — the sales query now also selects `bs_day`; the sales line is built **only from day-attributed entries (`bs_day > 0`)**. Bulk monthly entries (`bs_day = 0`) have no daily breakdown, so the line is hidden and a hint shows ("Enter daily sales to see the sales trend"). The monthly Food Cost % calc is unchanged.
- **Month-end projection** — least-squares linear trend on daily revenue, extended (dashed, lighter green) to the last BS day of the month; shown only for the **current open month with ≥5 sales days**. **Dampened:** each projected day is clamped to `[0, 1.25 × recent peak]` so a steep slope fitted to a few volatile early days can't run away (early build showed it climbing to ~140k/day; now capped near recent pace, keeping the y-axis readable). Revenue rounded to whole NPR. A "Projected month-end revenue: NPR X · trend estimate" figure sits under the chart. Past/closed months show actuals only.
- **POS-forward** — the chart reads a single `day → revenue` map (`daySalesMap`); when the POS module lands it feeds that same shape with no chart change. The forecast is an isolated least-squares step that can later graduate to weekday-seasonality.
- **Honesty guardrail** — the gap between the lines is buying-vs-selling cash rhythm, **not** profit (purchases ≠ that day's COGS); no "margin/profit" shading or labels. Lumpy purchase days bridge via `connectNulls`.
- Verified projection math + trend assembly via node (forecast total, anchor connection, bulk-only suppression, <5-day & past-month guards); `npm run build` clean. Help guide + FAQ updated.

**Files:** `src/pages/Dashboard.js`, `src/pages/Help.js`

---

### S135 — 2026-06-24 — Bulk recipe import (Excel) + Clone recipe

Line-by-line ingredient entry was tedious for onboarding a whole menu. Added a spreadsheet importer + one-click clone to [Recipes.js](src/pages/Recipes.js).

- **↓ Template** — generates `Recipe-Import-Template.xlsx`: a **Recipes** sheet (cols: Menu Item, Category, Selling Price, Yield, Ingredient (name or code), Qty, Unit) + auto-filled **"Your Items"** and **"Your Sub-Recipes"** reference sheets (exact names/codes/units to copy from).
- **↑ Import Excel** — reads the sheet (SheetJS `XLSX.read`), groups rows by recipe (recipe-level fields on the first row; blank = same recipe continuing), matches each ingredient to the Item Master **by name or item code**, and to sub-recipes by name. Units auto-convert KG↔GM / LTR↔ML via `convertQty`. Shows a **validation preview modal** (recipes ready, ingredients matched ✓, unmatched ✗ with reason, unit warnings) before committing.
- **Unmatched handling:** flag & skip — recipe imports with its matched ingredients; unmatched lines are listed so the user adds those items first and re-imports. Recipes that already exist (by name) and rows with category `Sub-Recipe` are skipped (create sub-recipes in-app for the linked-item/cost sync).
- **Clone** — row button duplicates a recipe into the New Recipe form (`"… (Copy)"`) with all ingredients prefilled; reuses the normal save path (so clone works for sub-recipes too).
- Bulk insert guarded against the NULL-client_id bug. Verified: parse/match/convert logic + SheetJS write→read round-trip via node; `npm run build` clean. Help page + FAQ updated.

**Files:** `src/pages/Recipes.js`, `src/pages/Help.js`

---

### S134 — 2026-06-24 — Recover "missing" recipes (NULL client_id bug)

User reported food recipes vanished from Recipe Costing (only 2 of ~8 showed). Diagnosed against the live DB (service-role read): the recipes were **not deleted** — **15 recipes had `client_id = NULL`** and the list query filters `.eq('client_id', clientId)`, so they were invisible.

- **Root cause:** AuthContext `clientId = isAdmin ? adminViewClientId : (profile?.client_id || null)`. `adminViewClientId` hydrates from localStorage, so there's a window (post-login / hard-refresh / before picking a client) where it's null. [Recipes.js](src/pages/Recipes.js) `save()` wrote `client_id: clientId` with **no guard**, persisting NULLs.
- **Recovered:** backfilled all 15 recipes (6 Food: Acai Indulgent Bowl, Classic Brazilian Bowl, Club Sandwich, Scrambled Eggs Croissant, Grilled Chicken Sandwich, Ham & Cheese Sandwich; 8 Beverage; 1 Sub-Recipe: Ranch Dressing) + 1 linked item (SRC-016 Ranch Dressing) → Casa Acai's client_id. Ingredients survived (recipe_ingredients link by recipe_id). Casa now: Food 8 / Beverage 40 / Sub-Recipe 31. **0 orphans remain.**
- **Code fix:** `save()` now guards `if (!clientId) { setError('No client selected…'); return }` — blocks any NULL-client insert (recipe + sub-recipe linked-item). **Extended the same guard to every other create path:** Items (`save` + `initDefaultCategories`), Vendors, Periods (`createPeriod`), Purchases (`saveReturn`/vendor_returns), Requisitions, Overheads, Purchase Orders. (`purchase_entries`/`sales_entries`/stock tables have no `client_id` — scoped by period_id — so they can't be orphaned.)
- **Categories junk root cause:** `Items.initDefaultCategories` seeded `DEFAULT_CATEGORIES` with `client_id: clientId` via `upsert(onConflict: 'client_id,name', ignoreDuplicates)`. When `clientId` was NULL, the unique-conflict can't dedupe (SQL `NULL ≠ NULL`), so repeated runs created the 43 duplicate NULL-client categories. Now guarded.
- **Cleanup done:** repointed the Ranch Dressing item to Casa's real "Sub-Recipes" category, then **deleted 43 unused duplicate NULL-client categories** (seed junk). Casa keeps its 7 real categories; 0 NULL categories remain.
- **DB backstop (run in Supabase):** `ALTER TABLE … ALTER COLUMN client_id SET NOT NULL` on the 10 clean client-scoped tables (recipes, items, vendors, categories, monthly_periods, requisitions, overheads, purchase_orders, vendor_returns, feature_flags). NOT applied to `settings`/`audit_logs` (legitimate NULLs). `client_settings` is not a real table.
- **Still optional:** an audit trigger on `recipes` (currently unaudited; `recipe_ingredients` is ON DELETE CASCADE so deletions leave no trace).

**Files:** `src/pages/Recipes.js` (+ live-DB data backfill via service role)

---

### S133 — 2026-06-24 — Content-page light-theme migration (36 pages)

Closed the gap noted in S132: content pages used hardcoded inline hex, so the light themes (Latte, Rosé Dawn, Solarized, Light) only restyled the chrome + Dashboard while inner page content stayed dark. Swept **36 page files** to map their semantic inline colors onto the theme CSS variables.

- **Semantic mapping applied** across all `src/pages/*.js` except the two Recharts files: gold `#c9a84c`→`var(--theme-accent)`, red `#f87171`→`var(--theme-red)`, green `#34d399`→`var(--theme-green)`, amber `#fbbf24`→`var(--theme-amber)`, primary text `#e8e0d0`→`var(--theme-text1)`, muted `#6b7280`→`var(--theme-text2)`, dim `#9ca3af`/`#4b5563`/`#374151`→`var(--theme-text3)`, border `#2a2f3d`→`var(--theme-border)`, `#1e2330`→`var(--theme-border-lt)`, bg darks (`#0f1117`/`#13171f`/`#141820`/`#131721`)→`var(--theme-bg)`, card darks (`#181c27`/`#1a1f2e`/`#161b27`/`#1f2937`)→`var(--theme-card)`.
- **Excluded (intentional):** [Dashboard.js](src/pages/Dashboard.js) (already migrated in S131; its remaining hex are Recharts SVG props) and [BestSellers.js](src/pages/BestSellers.js) (charts) — because **CSS `var()` does not resolve inside SVG presentation attributes** (Recharts `fill`/`stroke`/`tick`). Verified no `var()` landed inside any SVG attr.
- **Left as literal hex (correct):** mid-tone categorical/series accent colors (`#a78bfa`, `#60a5fa`, `#818cf8`, `#f59e0b`, `#22d3ee`, `#f472b6`, `#fb923c`, `#f97316`) used for badges/legend dots — they read fine on both light and dark backgrounds. Translucent `rgba()` badge fills also kept (they tint correctly on either theme).
- Pure 1:1 swap (1380 insertions / 1380 deletions, no structural change); `$env:CI='true'; npm run build` → **Compiled successfully**, 0 warnings.

**Result:** light themes now restyle inner page content (tables, stat values, labels, status colors) — not just the chrome. Now app-wide.

**Files:** 36 × `src/pages/*.js` (AdminClients, AnnualSummary, AuditLog, BudgetVsActual, DeadStock, FifoReport, Help, Items, Login, MenuEngineering, MonthlySummary, OutstandingPayables, Overheads, PaymentReport, PeriodComparison, Periods, Placeholders, Pricing, PurchaseOrders, Purchases, RecipeMargin, Recipes, ReorderReport, Requisitions, Sales, Settings, ShrinkageReport, Stock, StockReport, SupplierPriceTracker, TheoreticalVariance, Variance, VatReport, VendorReport, Vendors, WastageReport)

---

### S132 — 2026-06-24 — Trending theme palettes + sidebar follows theme

Reworked the preset set and made the sidebar theme-aware (it was staying dark on every preset).

- **9 curated palettes** in [src/context/ThemeContext.js](src/context/ThemeContext.js) inspired by trending schemes: **Dark** (gold), **Tokyo Night** (indigo), **Dracula** (purple/pink), **Nord** (frost cyan), **Catppuccin** (mauve pastel), **Latte** (light pastel), **Rosé Dawn** (warm rose light), **Solarized** (cream/blue light), **Light** (warm white). Each has its own `green/red/amber` + a `description` field.
- **Descriptions fixed** — Settings preset swatches showed "Clean light — professional feel" on everything (hardcoded `key==='dark' ? … : …`); now use `preset.description` ([Settings.js](src/pages/Settings.js)).
- **Sidebar now follows the theme** — `sidebar` color is theme-appropriate (dark for dark themes, light for light), and ~25 hardcoded sidebar text/border/tint colors in [Layout.css](src/components/Layout.css) (+ the inline group-header & brand-mark colors in [Layout.js](src/components/Layout.js)) were swapped to `var(--theme-text1/2/3 | border | table-hover | focus-ring | accent)`. So sidebar text contrasts correctly on light *and* dark sidebars (it was fixed light-on-dark before, hence "vague"/stuck-dark).

**Still true:** content pages with hardcoded inline colors aren't fully migrated — light themes fully restyle the chrome (sidebar, cards, buttons, Dashboard) but inner page content stays dark-styled until a per-page sweep.

**Files:** `src/context/ThemeContext.js`, `src/pages/Settings.js`, `src/components/Layout.css`, `src/components/Layout.js`

---

### S131 — 2026-06-24 — Theme presets + theme-responsive Dashboard

The theme engine (`ThemeContext` → CSS `--theme-*` vars → Settings → Theme tab swatches) only shipped 2 presets, and the **Dashboard** used hardcoded inline hex so it never recolored. Also the sidebar nav looked "vague."

- **4 new presets** in [src/context/ThemeContext.js](src/context/ThemeContext.js) — **Midnight** (navy/blue), **Slate** (graphite/indigo), **Emerald** (near-black/green), **Plum** (violet) — plus a **refined Light** (better text/border contrast so `.btn-ghost` & secondary text aren't washed out). They auto-appear in the Theme tab (`Object.entries(PRESETS).map`), with live preview, and persist (localStorage `crest_theme`). Dark-family presets recolor the whole app cohesively; light presets fully restyle the chrome (content pages migrate progressively).
- **Dashboard made theme-responsive** ([src/pages/Dashboard.js](src/pages/Dashboard.js)) — every inline design token swapped to `var(--theme-*)` (card/border/text1-3/accent/green/red/amber). **Recharts SVG props kept as literal hex** (CSS `var()` doesn't resolve in SVG `fill`/`stroke` attributes) — only the HTML tooltip/legend styles use vars.
- **Sidebar legibility** ([Layout.css](src/components/Layout.css)) — nav links lifted from `rgba(255,255,255,0.45)` → `0.64`; the viewing/brand blues neutralized to white-alpha so they read on any preset's (always-dark) sidebar; group headers lifted too.

**Files:** `src/context/ThemeContext.js`, `src/pages/Dashboard.js`, `src/components/Layout.css`, `src/components/Layout.js`

---

### S130 — 2026-06-23 — Outstanding Payables: pay by bill (invoice), not per item

Payables tracked payment per **line item** (`payable_payments.purchase_entry_id`), so an 8-item bill showed 8 separate "Pay" rows — but you pay vendors **one amount per invoice**. Reworked [src/pages/OutstandingPayables.js](src/pages/OutstandingPayables.js) to group by **bill** (vendor + invoice ref + period + day):

- **One row per bill** — Invoice · Period · Items(count) · Bill Total · Paid · Remaining · Days · Status. Expand to see the bill's line items + aggregated payment history.
- **One payment settles the whole bill** — `payBill()` distributes the amount across the bill's unpaid line items (oldest-first), writing the existing per-line `payable_payments` rows and stamping `paid_at` on each line as it's covered. So the underlying ledger (and every report that reads it) is unchanged; only the UX is invoice-level. **No schema change.** Verified the split via a unit test (full / partial / overpay-capped, incl. NPR decimals).
- **"Pay in full"** button pre-fills the exact remaining; payment is capped at the bill's remaining (no overpay). Stat cards now count **bills** not line items.
- Purchase *entry* stays item-wise (inventory needs per-item qty) — only payment became bill-wise.

**Files:** `src/pages/OutstandingPayables.js`

---

### S129 — 2026-06-23 — Stock Report (inventory valuation + movement)

New standalone **Stock Report** ([src/pages/StockReport.js](src/pages/StockReport.js), `/stock-report`, **Starter** `stock_report` flag) — answers "what stock do I hold and what's it worth," which the buried Stock-Count Summary tab didn't surface. Value-focused sibling of the Reorder Report.

- **On-hand per item** = closing physical count if entered, else theoretical `Opening + Net Purchases − Usage − Wastage − Staff Meals − Requisitioned` (clamped ≥0; raw-negative flagged as a data issue). `Stock Value = on-hand × per_uom_rate`.
- **Headline** = Total Stock Value (NPR); stat cards for Low / Out-of-stock / Items tracked; negative-stock warning banner.
- Table (sorted by value): Item · Category · UOM · On-hand (+ Physical/Theor. badge) · Opening · Purchased · Used · Wastage · Rate · **Stock Value** · Status (Low ≤ par, Out = 0). Category/search/status filters, `tfoot` total, **Excel** + **Print**. Tip tooltips on On-hand / Stock Value.
- Wired like `reorder_report`: STARTER_KEYS + both DEFAULT_FLAGS + AdminClients Starter group; route in App.js; nav entry in the Reports group ([Layout.js](src/components/Layout.js)).

**DB migration (run in Supabase):**
```sql
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS stock_report boolean DEFAULT false;
```

**Files:** `src/pages/StockReport.js` (new), `src/context/AuthContext.js`, `src/context/SettingsContext.js`, `src/pages/AdminClients.js`, `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`

---

### S128 — 2026-06-23 — Collapsible sidebar nav groups

A Pro/admin client had ~33 flat nav links (12 ops + ~20 reports) → constant scrolling. Grouped the IMS nav into **collapsible sections** in [src/components/Layout.js](src/components/Layout.js): **Operations** (Periods…Sales Entry), **Costing** (Recipe Costing/Menu Eng/Overheads), **Reports** (all reports, **collapsed by default** — the big win), plus **Human Resources** as a group. Dashboard stays pinned on top, Settings below; the brand header + user footer were already sticky (`.sidebar-nav` is the only scroll area).

- Group header shows **label · count · chevron**; click toggles, **persisted to localStorage** (`crest_nav_groups`).
- The group containing the **active route is force-open** so the current page is always visible.
- `unlockedItems` filters per group (empty groups hide; counts reflect plan/feature access).
- Icon-collapsed mode unchanged (items render flat, no headers).

**Files:** `src/components/Layout.js`

---

### S127 — 2026-06-23 — Plan-aware, module-composable client Dashboard

Reworked the **client** dashboard ([src/pages/Dashboard.js](src/pages/Dashboard.js)) to surface what each client can actually use, driven entirely by `hasFeature(key)` (plan tier **+ admin per-client `feature_flags` grants** + admin=all) — never a hardcoded plan name, so admin overrides reshape it live.

- **Fixed real bug:** "Fixed Costs % of Revenue" + "Est. Net Margin %" cards rendered for everyone and linked to **/overheads** (a Pro page); now gated on `hasFeature('overheads')`.
- **Relaxed Food Cost %** from `(canSales && canVariance)` → `canSales` (it's `purchaseTotal ÷ revenueTotal`, no variance needed) so Starter sees the headline metric; card links to `/variance` or `/summary` per access.
- **Upsell nudges** (`UpsellCard` helper, dashed/dimmed, → `/pricing`) replace silently-hidden high-value KPIs — **Costed Recipes** (Growth), **Variance & Shrinkage** (Growth), **Fixed Costs & Net Margin** (Pro). Suppressed when `hasFeature` is true (admin grant flips nudge → real KPI).
- **Module-composable:** sections render additively in order **Inventory → HR → POS**, each with a header shown only when **2+ modules** are active (single-module clients stay clean). Empty state now also checks POS.
- **Sections + sidebar nav reflect the displayed client's ACTUAL subscription** (not the admin route bypass), via a new central **`AuthContext.clientModules`** `{ ims, hr, pos }`: real client = own `*_enabled` flags; **admin "view as client" = the viewed client's flags** (fetched from `clients` when `adminViewClientId` set); admin's own view = all-on (full nav for management). Both [Layout.js](src/components/Layout.js) nav blocks and the dashboard sections key off this. **Fixes:** admin previewing an IMS-only client used to see HR (and POS) nav + sections because `imsEnabled/hrEnabled` are `true` for admin. `imsEnabled/hrEnabled` are **kept** for `ModuleGate` route access (admin can still reach any route by URL); only *display* now reflects subscription. Real clients were already correct.
- **POS-ready (not built):** `AuthContext` exposes `posEnabled` + `clientModules.pos`; dashboard has a "Crest POS — coming soon" slot. **Note:** `clients.pos_enabled` column doesn't exist yet, so it's deliberately **not** in the auth `.select(...)` (would 400 and break login) — POS is false for clients / true for admin-own until POS launches.

**Files:** `src/context/AuthContext.js`, `src/pages/Dashboard.js`, `src/components/Layout.js`

---

### S126 — 2026-06-23 — Tooltip + Help pass (S123–S125 features)

- **Help** ([src/pages/Help.js](src/pages/Help.js)): FAQ *"Why won't an item delete?"* (reference block, Hide vs. admin Force Delete) and *"How do I quickly find an item in a long dropdown?"* (searchable pickers + ingredient search); Recipe Costing guide tip for the "Find ingredient in recipes" box.
- **Tooltip** ([src/pages/Recipes.js](src/pages/Recipes.js)): ⓘ tooltip beside the ingredient-search box explaining the recursive (through sub-recipes) match. (Used a standalone ⓘ icon rather than wrapping the `<input>` in `Tip`, which adds a dashed underline / help-cursor meant for text labels.)

**Files:** `src/pages/Help.js`, `src/pages/Recipes.js`

---

### S125 — 2026-06-23 — Item delete: surface blocks + admin force-delete

Deleting an item silently did nothing when the DB rejected it (FK reference) — the error only rendered inside the closed Add/Edit modal. Fixes in [src/pages/Items.js](src/pages/Items.js):
- **Surfaced the failure** via `alert` (list view has no inline error), explaining it's still referenced and even a zero-qty row counts.
- **Broadened the usage check** (`checkAllUsage`) to also cover `staff_meals`, `requisition_lines`, `vendor_returns` (was only recipes/purchases/opening/closing/wastage), and to skip tables that error rather than break; added `SM`/`RQ`/`VR` to `USAGE_LABELS`.
- **Admin-only `forceDeleteItem`** — when a referenced item is deleted, an admin gets a force-delete confirm that clears every FK reference (`vendor_returns` → `recipe_ingredients` → `requisition_lines` → `staff_meals` → `wastages` → `opening_stock` → `closing_stock` → `purchase_entries`, in that order) then deletes the item. Non-admins still get "Hide it instead." Triggers audit-log delete rows for the audited tables.

**Files:** `src/pages/Items.js`

---

### S124 — 2026-06-23 — Recipe Costing: find-by-ingredient search

Added a second search box (right of the toolbar, 🔍 + clear ×) on the Recipe Costing list that filters recipes **by an ingredient they contain** — distinct from the existing name search. `recipeHasIngredient(recipe, q, allRecipes)` is **recursive** (matches items + nested sub-recipe names/ingredients), so searching "coffee" surfaces a Flat White even when coffee lives in its Doppio sub-recipe. ANDs with the name search + category tabs; shows a "(N found)" helper line and updates tab counts.

**Files:** `src/pages/Recipes.js`

---

### S123 — 2026-06-23 — Searchable item picker (Purchases)

The native `<select>` for items (218+) was painful to scroll. Added a reusable **`src/components/SearchableSelect.js`** — a type-to-filter combobox: a styled trigger button opens a panel with a search input + filtered list; **↑/↓ to move, Enter to pick, Esc/outside-click to close**, mouse hover highlights. The dropdown is **`position:fixed`** (measured from the trigger's rect, repositioned on scroll/resize) so it's never clipped by the bill modal/table overflow. Drop-in API: `value` / `onChange(value)` / `options=[{value,label}]` / `placeholder`.

Wired into the item dropdowns across **Purchases** (bill lines), **Recipes** (ingredient + sub-recipe pickers), **Stock** (Daily Wastage entry), and **Requisitions** (request lines); each builds a memoized `options` list from `items` (Purchases/Requisitions include the category/uom in the label, Recipes' sub-recipe picker shows yield).

**Files:** `src/components/SearchableSelect.js` (new), `src/pages/Purchases.js`, `src/pages/Recipes.js`, `src/pages/Stock.js`, `src/pages/Requisitions.js`

---

### S122 — 2026-06-23 — Default brand mark → gold hexagon

Replaced the default `logo.png` Crest brand mark with a gold hexagon glyph (**⬢**, `#c9a84c`) in the two places it rendered: the sidebar brand ([src/components/Layout.js](src/components/Layout.js)) and the login card ([src/pages/Login.js](src/pages/Login.js)). A paying client's own uploaded logo (`settings.logo_url`) still takes priority — only the default fallback changed. Removed the now-unused `logo.png` imports (the asset file remains in `src/assets/`). The logo-upload feature (Admin/Settings) is untouched.

**Favicon / PWA icons → hexagon too:** added `public/favicon.svg` (vector gold hexagon on dark rounded square) and regenerated `public/favicon.ico` + `public/logo192.png` + `public/logo512.png` as the same hexagon (via a Node `zlib` PNG/ICO generator with 2× supersampling — no ImageMagick available). `public/index.html` now references the SVG favicon (preferred) + PNG + ICO fallbacks; `manifest.json` already pointed at these filenames with gold `theme_color`/dark `background_color`, so no manifest change.

**Files:** `src/components/Layout.js`, `src/pages/Login.js`, `public/index.html`, `public/favicon.svg`, `public/favicon.ico`, `public/logo192.png`, `public/logo512.png`

---

### S121 — 2026-06-23 — Recipe Costing: Nutritional Facts

Per-portion **nutrition label** (energy, protein, carbs, fat, sugar, sodium) + **allergens** on recipes, reusing the recipe cost engine's recursive ingredient/sub-recipe walk.

- **Key principle:** nutrition is the same traversal as cost but **without the yield-pct division** — cost divides by `yield_pct` because you buy more than you serve, but the diner eats exactly `qty_per_portion` (the edible amount). Sub-recipes recurse per yield unit (÷ `yield_qty`), exactly like `calcSubRecipeCostPerUnit`.
- **Per-item data** is stored on `items.nutrition` (jsonb), expressed *per a reference quantity of the item's own UOM* (default per 100 GM/ML, or per 1 PCS for counted items) — so the math stays unit-agnostic.
- **Entry lives in Recipe Costing, not Item Master** (data is still stored per-ingredient on `items.nutrition` so it auto-sums; only the *entry point* moved). While editing a recipe, each **item ingredient row** has a Nutrition button (● has data / + add) that opens an inline editor (Modal): per-qty/unit basis + 6 nutrient inputs + Allergens + **⚡ Suggest from library**. Saved once per ingredient → fills every recipe that uses it; local state updates so the per-portion label recomputes immediately. Sub-recipe rows show "auto" (derived from their own ingredients). The Item Master Nutrition tab was removed.
- **Suggest from library** shows matching candidates with their **source** to pick from (never auto-applied). Multi-source library (124 rows): **USDA**, **IFCT 2017** (Indian Food Composition Tables), **DFTQC Nepal** (Food Composition Table for Nepal) — regional sources listed first; staples (rice, dals, mustard oil, paneer, milk) carry multiple sources, plus Nepal-only items (gundruk, chhurpi, phapar/buckwheat, kodo/millet, chiura, sukuti, buffalo milk/meat). Chosen source is stored in `nutrition.source`. Regional values are transcribed table estimates — verify for branded/prepared items.
- **Unit-aware** (`convertQty`/`defaultBasisUnit` in nutrition.js): the engine converts the recipe qty (in the item's uom) into the nutrition basis unit across **mass (KG↔GM)** and **volume (LTR↔ML)**. So an item used as `0.009 KG` of coffee with nutrition entered **per 100 GM** computes correctly (9 g → 18 kcal) — no need to change the item's UOM (which would reinterpret purchase/stock history) or recipe quantities. The editor defaults the basis to **GM/ML** for mass/volume items so per-100 g library/OFF/table values drop in directly. Counts (PCS/PKT/BTL) and mismatched dimensions fall back to a same-unit assumption.
- **⚡ Auto-fill nutrition** (button in the recipe editor's Ingredients header): one click loops every ingredient missing nutrition, applies its **best library match** (regional-first), bulk-saves to `items.nutrition` (parallel updates), and reports which had no match for manual entry. Skips ingredients that already have data; Open Food Facts (branded, ambiguous) stays manual. Confirm dialog lists what will be skipped; everything is editable afterward.
- **Fetch from Open Food Facts** (in the same editor): for **branded/packaged goods** the static library doesn't cover. Search by product name or paste a barcode → live call to the free OFF REST API (`/api/v2/product/{barcode}.json` for barcodes, `/cgi/search.pl` for names; no key, browser-CORS-friendly) → maps per-100 g nutriments (`energy-kcal_100g`, `proteins/carbohydrates/fat/sugars_100g`, `sodium_100g` or `salt_100g`÷2.5, kJ→kcal fallback, `allergens_tags` stripped of `en:`) → pick a result to fill, stored as `source: "Open Food Facts"`. Attribution + "crowd-sourced, verify" note shown (ODbL). Verified live against the OFF API (Coca-Cola barcode + Wai Wai search).
- **Recipe detail:** "Nutrition (per portion)" panel with **data coverage** (e.g. 3/4 ingredients) + estimate disclaimer when incomplete; allergen chips aggregated across nested ingredients. Live one-line preview in the edit view. Nutrition strip added to both print cost cards.
- **Gating:** new `nutrition_facts` flag at **Growth** tier (added to `GROWTH_KEYS`, both `DEFAULT_FLAGS`, and the Growth group in AdminClients `FEATURE_GROUPS`) — individually grantable.

**SQL applied in Supabase:**
```sql
ALTER TABLE items ADD COLUMN IF NOT EXISTS nutrition jsonb;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS nutrition_facts boolean DEFAULT false;
```
`items.nutrition` shape: `{ basis_qty, basis_unit, energy_kcal, protein_g, carbs_g, fat_g, sugar_g, sodium_mg, allergens }`. NULL = no data (counts against a recipe's coverage). No RLS change (both tables already client-scoped).

**Files:** `src/utils/nutrition.js` (new, pure engine — verified: 150 g item = ×1.5 not yield-adjusted, sub-recipe ÷ yield, coverage count), `src/data/nutritionSeed.js` (new, **124-row multi-source library** USDA/IFCT 2017/DFTQC Nepal + `suggestSeeds`/`suggestSeed`), `src/pages/Recipes.js` (join select + detail/live/print panels + **inline per-ingredient nutrition editor Modal** writing to `items.nutrition`, with **library Suggest** + **Open Food Facts fetch**), `src/context/AuthContext.js`, `src/context/SettingsContext.js`, `src/pages/AdminClients.js`, `src/pages/Help.js`. (`src/pages/Items.js` had a Nutrition tab in the first pass — removed when entry moved to Recipe Costing.)

---

### S120 — 2026-06-23 — Audit log: HR + user-management coverage

Audit logging is **trigger-based** (`audit_<table>` → `log_audit()`; source-agnostic, captures action + old/new JSON). Extended coverage:

- **Fixed:** `vendor_returns` + `wastages` triggers now fire on `UPDATE` too (were INSERT/DELETE only — edits were silently unlogged despite the help text claiming "Edit").
- **Added (recommended set):** `hr_employees`, `hr_salary_components`, `hr_payroll_runs`, `hr_festival_allowances`, `hr_leave_types`, `hr_leave_requests`, and **`profiles`** (client-login create / reassign / delete).
- **Left out (high-volume, optional):** `hr_attendance`, `hr_payslips` — would flood the log; the payroll run's draft→finalize is already captured via `hr_payroll_runs`.

`log_audit()` is safe to attach anywhere — it ends with `EXCEPTION WHEN OTHERS THEN RETURN NULL`, so a trigger can never break the underlying write; for non-stock tables it reads `NEW.id` + `NEW.client_id` (all HR tables + profiles have both).

**SQL applied in Supabase:**
```sql
-- UPDATE added to the two partial triggers
DROP TRIGGER IF EXISTS audit_wastages ON public.wastages;
CREATE TRIGGER audit_wastages AFTER INSERT OR UPDATE OR DELETE ON public.wastages FOR EACH ROW EXECUTE FUNCTION log_audit();
DROP TRIGGER IF EXISTS audit_vendor_returns ON public.vendor_returns;
CREATE TRIGGER audit_vendor_returns AFTER INSERT OR UPDATE OR DELETE ON public.vendor_returns FOR EACH ROW EXECUTE FUNCTION log_audit();
-- HR + user management
CREATE OR REPLACE TRIGGER audit_hr_employees           AFTER INSERT OR UPDATE OR DELETE ON public.hr_employees           FOR EACH ROW EXECUTE FUNCTION log_audit();
CREATE OR REPLACE TRIGGER audit_hr_salary_components   AFTER INSERT OR UPDATE OR DELETE ON public.hr_salary_components   FOR EACH ROW EXECUTE FUNCTION log_audit();
CREATE OR REPLACE TRIGGER audit_hr_payroll_runs        AFTER INSERT OR UPDATE OR DELETE ON public.hr_payroll_runs        FOR EACH ROW EXECUTE FUNCTION log_audit();
CREATE OR REPLACE TRIGGER audit_hr_festival_allowances AFTER INSERT OR UPDATE OR DELETE ON public.hr_festival_allowances FOR EACH ROW EXECUTE FUNCTION log_audit();
CREATE OR REPLACE TRIGGER audit_hr_leave_types         AFTER INSERT OR UPDATE OR DELETE ON public.hr_leave_types         FOR EACH ROW EXECUTE FUNCTION log_audit();
CREATE OR REPLACE TRIGGER audit_hr_leave_requests      AFTER INSERT OR UPDATE OR DELETE ON public.hr_leave_requests      FOR EACH ROW EXECUTE FUNCTION log_audit();
CREATE OR REPLACE TRIGGER audit_profiles               AFTER INSERT OR UPDATE OR DELETE ON public.profiles               FOR EACH ROW EXECUTE FUNCTION log_audit();
```

**App (`AuditLog.js`):** added `TABLE_LABELS`, `getSummary` cases, and `HELP_ITEMS` for the HR areas + User, so they appear in the Area filter and render readable summaries (employee name, leave status/days, "role changed / client changed", etc.). Still **not audited:** sales, recipes, vendors, categories, purchase orders, requisitions, budgets, settings.

**Files:** `src/pages/AuditLog.js`

---

### S119 — 2026-06-23 — Client-user reassignment + orphaned-profile fixes

Admins can now point a client login at any client, and broken/missing profile links self-heal.

**Code (`AdminClients.js`):**
- `adminOp` now surfaces the **real** edge-function error (reads `error.context` body) instead of the generic "non-2xx status code", so failures are diagnosable.
- **Add User reassigns:** an existing email is **moved** to the current client (admin-guarded — refuses `role='admin'` accounts; confirms before moving). Uses the SQL function `find_user_id_by_email` for the email→id lookup (no edge redeploy).
- **Upsert self-heal:** new-user link and reassign use `upsert` (not `update`), so an auth user with **no `profiles` row** (orphan from before the profile trigger) gets a row created instead of a silent 0-row no-op.
- **Delete hardened:** stops if the auth deletion fails (no orphaned login keeping the email locked).

**Database (run in Supabase — already applied):**
```sql
-- Admin-guarded email→id lookup (reassignment)
CREATE OR REPLACE FUNCTION public.find_user_id_by_email(p_email text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid;
BEGIN
  IF (SELECT role FROM public.profiles WHERE id = auth.uid()) <> 'admin' THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  SELECT id INTO uid FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1;
  RETURN uid;
END; $$;
GRANT EXECUTE ON FUNCTION public.find_user_id_by_email(text) TO authenticated;

-- Consolidate profiles UPDATE policies so admins can update ANY profile
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_own"          ON public.profiles;
DROP POLICY IF EXISTS "profiles_update"              ON public.profiles;
CREATE POLICY "profiles_update" ON public.profiles FOR UPDATE
  USING (id = auth.uid() OR is_admin()) WITH CHECK (id = auth.uid() OR is_admin());

-- Batched email lookup for the Existing Users list (replaces N per-user edge calls)
CREATE OR REPLACE FUNCTION public.client_user_emails(p_client_id uuid)
RETURNS TABLE(id uuid, email text) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.email FROM public.profiles p JOIN auth.users u ON u.id = p.id
  WHERE p.client_id = p_client_id AND public.is_admin();
$$;
GRANT EXECUTE ON FUNCTION public.client_user_emails(uuid) TO authenticated;
```

`loadUsers` now does one `rpc('client_user_emails', …)` instead of one `getUser` edge call per user — kills the blank-email rows / 401 bursts and is faster.

**Gotcha learned:** orphaned auth users (no `profiles` row, e.g. `aashish727572@…`) made every `UPDATE profiles WHERE id=…` match 0 rows silently. Fix is `INSERT … ON CONFLICT (id) DO UPDATE` (SQL) / `upsert` (app). Founder uses a **separate non-admin email** to experience the app as a paying client (admin = `xrestha@…`).

**Files:** `src/pages/AdminClients.js` (edge function `admin-user-ops/index.ts` reverted to original — no redeploy needed)

---

### S118 — 2026-06-22 — Daily Wastage Tracker

Wastage can now be logged **per day with a reason**, on top of the existing monthly figure.

**Migration (run in Supabase):**
```sql
ALTER TABLE wastages ADD COLUMN IF NOT EXISTS bs_day     integer;      -- NULL = monthly catch-all; set = daily entry
ALTER TABLE wastages ADD COLUMN IF NOT EXISTS reason     text;         -- dropdown value (daily entries)
ALTER TABLE wastages ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
```

**Model:** `wastages` rows with `bs_day = NULL` are the **monthly catch-all** (the existing Wastage tab); rows with a `bs_day` are **daily entries** with a reason. Period total wastage = catch-all + daily, so COGS is unchanged. Existing rows become the catch-all automatically.

**Stock Count (`Stock.js`):**
- New **Daily Wastage** tab — BS day selector, add-entry row (item · qty · reason dropdown: Spoilage / Expiry / Over-prep / Breakage / Spillage / Customer return / Other), that day's entries list with delete + day total, and a "days with wastage" strip showing per-day NPR.
- The **Wastage tab** now edits only the catch-all (`bs_day IS NULL`); `getUsed`, the Summary tab, and the Excel register all use catch-all + daily. Daily entries are online-only (not in the offline queue).

**Wastage Report (`WastageReport.js`):** now **aggregates by item** (an item can have many rows), plus a **By Reason** breakdown card + second Excel sheet. Undated catch-all shows as "Monthly (untagged)".

**Deferred:** offline queue for daily entries, in-place edit (delete + re-add for now), deeper reason analytics.

**Files:** `src/pages/Stock.js`, `src/pages/WastageReport.js`, `src/pages/Help.js`

---

### S117 — 2026-06-22 — Floating "+ Add" buttons + modal create-forms

UX pass: every create page now uses a single **floating action button** (fixed bottom-right, always reachable regardless of scroll) instead of a top/bottom button. Create forms that used to render at the top of the page (so they looked dead when triggered from a long list) now pop up as **centered modals** in front of the user.

- **New reusable components:** `src/components/Fab.js` (fixed bottom-right `+ Add` button; `show` prop gates on tab/view/lock state; `no-print`) and `src/components/Modal.js` (centered overlay hosting a form; × button + backdrop click close).
- **FAB + Modal** (forms were top-of-page cards): Purchases (Purchases + Returns tabs), Vendors, Item Master.
- **FAB only** (forms are full-view switches or a slide-in drawer — no scroll problem, modal not applicable): Recipes, Purchase Orders, Requisitions, Employees. Their list-view create button was relocated to the FAB.
- Old top/bottom create buttons removed on all of the above; FAB hides while a form/drawer is open and respects each page's lock/period rules.
- **Not FAB'd:** Stock Count & Sales Entry (bulk pages with Save All / mobile save bar a FAB would collide with), in-form "+ Add Row" buttons, AdminClients, Periods.

**Files:** `src/components/Fab.js` (new), `src/components/Modal.js` (new), `src/pages/Purchases.js`, `src/pages/Vendors.js`, `src/pages/Items.js`, `src/pages/Recipes.js`, `src/pages/PurchaseOrders.js`, `src/pages/Requisitions.js`, `src/modules/hr/employees/EmployeeList.jsx`

---

### S116 — 2026-06-22 — Crest HR: Leave Management

New HR feature `/hr/leave` — leave entitlements, requests, and balances, with automatic Attendance integration. Closes the gap where paid/unpaid leave had to be hand-marked day-by-day in the Attendance sheet.

**Tables (migration — run in Supabase):**
```sql
CREATE TABLE IF NOT EXISTS hr_leave_types (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  name text NOT NULL, code text NOT NULL,
  paid boolean NOT NULL DEFAULT true,
  annual_quota numeric(5,1) NOT NULL DEFAULT 0,
  carry_forward boolean NOT NULL DEFAULT false,
  color text DEFAULT '#60a5fa', active boolean NOT NULL DEFAULT true,
  sort_order integer DEFAULT 0, created_at timestamptz DEFAULT now(),
  UNIQUE (client_id, code)
);
CREATE TABLE IF NOT EXISTS hr_leave_requests (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  employee_id uuid REFERENCES hr_employees(id) ON DELETE CASCADE NOT NULL,
  leave_type_id uuid REFERENCES hr_leave_types(id) ON DELETE SET NULL,
  start_date date NOT NULL, end_date date NOT NULL,
  days numeric(5,1) NOT NULL DEFAULT 0, reason text,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
  decided_at timestamptz, note text, created_at timestamptz DEFAULT now()
);
ALTER TABLE hr_leave_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_leave_requests ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "client_own" ON hr_leave_types FOR ALL
    USING ((SELECT role FROM profiles WHERE id=auth.uid())='admin' OR client_id=(SELECT client_id FROM profiles WHERE id=auth.uid()))
    WITH CHECK ((SELECT role FROM profiles WHERE id=auth.uid())='admin' OR client_id=(SELECT client_id FROM profiles WHERE id=auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "client_own" ON hr_leave_requests FOR ALL
    USING ((SELECT role FROM profiles WHERE id=auth.uid())='admin' OR client_id=(SELECT client_id FROM profiles WHERE id=auth.uid()))
    WITH CHECK ((SELECT role FROM profiles WHERE id=auth.uid())='admin' OR client_id=(SELECT client_id FROM profiles WHERE id=auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_leave_types TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_leave_requests TO authenticated;
```

**Page (`/hr/leave`):** three tabs.
- **Requests** — apply via BS date pickers (`BsFullDatePicker`); working days counted excluding Saturdays; admin Approve/Reject/Cancel. Per-row remaining balance shown.
- **Balances** — employee × leave-type grid (used / annual quota) for the selected BS year; Excel export.
- **Leave Types** (admin) — inline-editable name / paid / quota / carry-forward / active.

**Attendance integration:** approving a request maps the AD range → BS days, finds the matching `monthly_periods`, and upserts `hr_attendance` rows as `paid_leave` / `unpaid_leave` (`onConflict: employee_id,period_id,bs_day`). Reject/cancel of an approved request reverts those days to `present`. Months with no period yet are skipped with a warning. Payroll needed **no change** — `payrollCompute.js` already counts `unpaid_leave` as an unpaid day.

**Seed:** first visit auto-inserts six Nepal Labour Act 2074 leave types (Home/Annual 18, Sick 12, Bereavement 13, Maternity 98, Paternity 15, Unpaid).

**Deferred:** auto-accrual / carry-forward roll-over, holiday calendar, half-day leave, employee self-service.

**Files:** `src/modules/hr/leave/leaveConstants.js` (new), `src/modules/hr/leave/LeaveManagement.jsx` (new), `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`

---

### S115 — 2026-06-22 — Add-User Duplicate-Email Handling + Festival Tooltips

**Add User (AdminClients):** trying to add a user whose email already exists (e.g. the admin's own email) failed with a raw Supabase error. Root cause is structural — one login = one profile = one `client_id` + role, so an email can't be both the platform admin and a client user. Rather than demote/lock out the admin, the form now:
- Detects the "already registered" error and shows an actionable message suggesting a **plus-addressed** separate login (e.g. `you+casa@gmail.com` — same inbox, distinct account).
- Adds an inline hint under the Email field explaining the one-login-one-account rule and the `+name` trick.
- No edge-function change; admin access is never altered.

**Tooltips:** beefed up the thin coverage on **Festival Allowance** — stat cards (Total Payout / Employees / Average) and the Basic-Rate / Amount column headers now have `Tip` tooltips. Verified Help entries exist for all six HR pages (Employees, Salary, Attendance, Payroll, HR Reports, Festival).

**Files:** `src/pages/AdminClients.js`, `src/modules/hr/festival/FestivalAllowance.jsx`

---

### S114 — 2026-06-22 — Crest HR: Festival Allowance

The legally-required annual festival bonus (Dashain / पर्व खर्च) — broadly one month's basic, pro-rated for mid-year joiners.

**DB migration (run in Supabase SQL editor):**
```sql
CREATE TABLE IF NOT EXISTS hr_festival_allowances (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id     uuid REFERENCES clients(id)       ON DELETE CASCADE NOT NULL,
  employee_id   uuid REFERENCES hr_employees(id)  ON DELETE CASCADE NOT NULL,
  bs_year       integer NOT NULL,
  festival_name text NOT NULL DEFAULT 'Dashain',
  pay_basis     text,
  basic         numeric(12,2) DEFAULT 0,
  months_worked numeric(4,1)  DEFAULT 12,
  amount        numeric(12,2) DEFAULT 0,
  status        text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','finalized')),
  note          text,
  created_at    timestamptz DEFAULT now(),
  UNIQUE (client_id, employee_id, bs_year, festival_name)
);
ALTER TABLE hr_festival_allowances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "client_own" ON hr_festival_allowances FOR ALL
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_festival_allowances TO authenticated;
```

**FestivalAllowance (`/hr/festival`):**
- Keyed by **BS year + festival name** (default Dashain), not a monthly period. Generate→review→Finalize flow (mirrors Payroll); admin Reopen.
- **Generate:** per active employee — `monthsWorked = clamp(0..12, full months from join_date to bsToAd(bsYear, 6, 15))`; **monthly** `amount = round(basic × monthsWorked/12)`; **daily/hourly** default 0 (editable). Upsert `onConflict: client_id,employee_id,bs_year,festival_name`.
- Inline-editable Amount + Note while draft; stat cards (Total / Headcount / Average); register Excel + **bank-transfer Excel/CSV** (generic columns, missing-bank flag).
- **No TDS** — recorded gross (festival pay is taxable; reconciliation deferred). Nav "Festival Allowance" (🎉); Help entry added.

**Deferred:** TDS on the bonus, multi-festival auto-handling, advance/loan recovery against it.

**Files:** `src/modules/hr/festival/FestivalAllowance.jsx` (new), `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`

---

### S113 — 2026-06-22 — Crest HR: HR Reports

Turns finalized payroll into filing/disbursement artefacts. **No DB migration** — read-only aggregation over `hr_payslips` + `hr_employees`.

**HrReports (`/hr/reports`):** period selector loads the run + payslips + employees (for bank/SSF/PAN fields). Empty state if no run; amber note if the run is a draft. Four tabs, each with Excel export + print-clean layout:
- **Payroll Summary** — stat cards (Total Gross / Deductions / Net Payable / **Employer Cost** = gross + OT + employer SSF) + by-department table.
- **SSF Challan** — SSF-enrolled employees only: SSF No · SSF Basic (min(basic, 100k)) · 11% · 20% · 31%, with grand total to deposit and a count of excluded (no-SSF) staff.
- **Bank Transfer / Salary Disbursement** — Employee · Bank · Account No · Net Pay; missing bank details flagged amber; **Excel + CSV** export (generic columns: Name, Bank, Account No, Amount).
- **TDS Report** — Employee · PAN · Taxable (gross + OT − SSF) · TDS (period) · **TDS YTD** (sum of finalized payslips in the same fiscal year, via `fiscalYearOf` from `tds.js`).

Nav "HR Reports" (📊) under Human Resources; Help HR_FEATURES entry added.

**Deferred:** bank-specific upload templates, annual rollups, SSF return XML / IRD e-filing formats, payslip email/SMS.

**Files:** `src/modules/hr/reports/HrReports.jsx` (new), `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`

---

### S112 — 2026-06-22 — Crest HR: Automatic TDS (Income Tax)

Replaces the manual TDS field on payslips with an automatic income-tax engine. **No DB migration** — TDS already exists on `hr_payslips` and year-to-date figures are derived from existing columns.

**Tax engine — `src/modules/hr/payroll/tds.js` (pure):**
- Slab sets: **FY 2083/84** unified (1% ≤10L · 10% 10–15L · 20% 15–25L · 27% 25–40L · 29% >40L) and **FY 2082/83** single-person schedule. `slabsFor(fyStart)` picks by fiscal year.
- `fiscalYearOf(bsYear, bsMonth)` — Nepal FY runs Shrawan (month 4) → Ashadh; returns `{ fyStart, monthInFy }`.
- `applySlabs(taxable, slabs, isSsf)` — marginal tax; **SSF contributors get the 1% first slab (SST) waived**.
- `computeMonthlyTds({ period, monthlyGross, monthlySsf, ytdGross, ytdSsf, ytdWithheld, isSsf })` — **YTD cumulative projection**: annualise (YTD actuals + current-month rate for remaining months), deduct SSF (capped at min 5L or ⅓ income), apply slabs, take the cumulative share due through the current month minus tax already withheld. Self-correcting month to month.

**Decisions (this session):** YTD-projection method; **no insurance** deductions yet; **single schedule only** (no married/single field). So no new employee columns.

**PayrollRun integration:**
- `fetchYtdMap()` sums `(gross − ssf_employee)` and `tds` from **prior finalized** payslips in the same fiscal year (embedded query `hr_payslips → hr_payroll_runs!inner → monthly_periods!inner`, filtered to finalized + earlier months).
- `buildRows()` now computes TDS per employee via `computeMonthlyTds` and nets it out. TDS is auto-filled but stays **editable inline as an override** while draft; Regenerate recomputes.
- Column tooltip + footer note updated; Help Payroll tips updated.

**Deferred:** insurance-premium deductions, married/couple schedule, festival allowance, advances. The YTD method assumes earlier months of the FY are finalized in order.

**Files:** `src/modules/hr/payroll/tds.js` (new), `src/modules/hr/payroll/PayrollRun.jsx`, `src/pages/Help.js`

---

### S111 — 2026-06-22 — Crest HR: Payroll Module

HR roadmap session 4 — the keystone. Combines salary structure (S105) + pay basis (S108) + SSF/min-wage (S106–S108) + attendance (S110) into actual pay, frozen as payslips.

**DB migration (run in Supabase SQL editor):**
```sql
CREATE TABLE IF NOT EXISTS hr_payroll_runs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  period_id uuid REFERENCES monthly_periods(id) ON DELETE CASCADE NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','finalized')),
  created_at timestamptz DEFAULT now(), finalized_at timestamptz,
  UNIQUE (client_id, period_id)
);
CREATE TABLE IF NOT EXISTS hr_payslips (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id uuid REFERENCES hr_payroll_runs(id) ON DELETE CASCADE NOT NULL,
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  employee_id uuid REFERENCES hr_employees(id) ON DELETE CASCADE NOT NULL,
  pay_basis text, basic numeric(12,2) DEFAULT 0, allowances numeric(12,2) DEFAULT 0,
  gross numeric(12,2) DEFAULT 0, present_days numeric(5,1) DEFAULT 0, absent_days numeric(5,1) DEFAULT 0,
  worked_days numeric(5,1) DEFAULT 0, hours_worked numeric(7,2) DEFAULT 0, ot_hours numeric(7,2) DEFAULT 0,
  ot_amount numeric(12,2) DEFAULT 0, absence_deduction numeric(12,2) DEFAULT 0,
  ssf_employee numeric(12,2) DEFAULT 0, ssf_employer numeric(12,2) DEFAULT 0,
  other_deductions numeric(12,2) DEFAULT 0, tds numeric(12,2) DEFAULT 0, net_pay numeric(12,2) DEFAULT 0,
  created_at timestamptz DEFAULT now(), UNIQUE (run_id, employee_id)
);
ALTER TABLE hr_payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_payslips     ENABLE ROW LEVEL SECURITY;
CREATE POLICY "client_own" ON hr_payroll_runs FOR ALL
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));
CREATE POLICY "client_own" ON hr_payslips FOR ALL
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_payroll_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_payslips     TO authenticated;
```

**Computation — `src/modules/hr/payroll/payrollCompute.js` (pure):**
- `computePayslip(employee, components, attendanceRows, period, tds)` per pay basis:
  - **Monthly:** gross = basic + allowances; absence deduction = `basic ÷ daysInBsMonth × unpaid days` (unpaid = absent + unpaid_leave + ½·half-day); OT = `otHrs × (basic ÷ (days×8)) × 1.5`; net = gross + OT − absence − SSF − other − TDS
  - **Daily:** earned = rate × worked days (present + ½·half); OT = `otHrs × (rate÷8) × 1.5`
  - **Hourly:** earned = rate × hours worked; OT = `otHrs × rate × 1.5`
  - **SSF only for employees with an `ssf_no`** (11%/20% on capped basic/earned)

**PayrollRun (`/hr/payroll`):**
- Generate (draft) → review register → Finalize (locks, frozen snapshot). Regenerate recomputes from current salary/attendance; admin can Reopen a finalized run.
- Stat cards (Total Gross / Deductions / Net Payable / Employer SSF); register table with per-row inline **TDS** edit (draft only) + tfoot totals.
- Per-employee **printable payslip** (modal + `.print-only` block using existing print CSS); **Excel export**.
- Nav "Payroll" (💵) under Human Resources; Help HR_FEATURES entry.

**Deferred:** automatic **TDS** (FY 2083/84 slabs + caps — next session; `tds` stays manual), festival allowance run, salary advances, bank-transfer file export.

**Files:** `src/modules/hr/payroll/payrollCompute.js` (new), `src/modules/hr/payroll/PayrollRun.jsx` (new), `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`

---

### S110 — 2026-06-22 — Crest HR: Attendance Module

HR roadmap session 3. Builds the daily attendance sheet — the data source the future Payroll module needs to compute pay for daily/hourly staff and apply overtime.

**DB migration (run in Supabase SQL editor):**
```sql
CREATE TABLE IF NOT EXISTS hr_attendance (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id    uuid REFERENCES clients(id)          ON DELETE CASCADE NOT NULL,
  employee_id  uuid REFERENCES hr_employees(id)     ON DELETE CASCADE NOT NULL,
  period_id    uuid REFERENCES monthly_periods(id)  ON DELETE CASCADE NOT NULL,
  bs_day       integer NOT NULL,
  status       text NOT NULL DEFAULT 'present'
               CHECK(status IN ('present','absent','half_day','paid_leave','unpaid_leave','weekly_off','holiday')),
  hours_worked numeric(5,2) DEFAULT 0,
  ot_hours     numeric(5,2) DEFAULT 0,
  note         text,
  created_at   timestamptz DEFAULT now(),
  UNIQUE (employee_id, period_id, bs_day)
);
ALTER TABLE hr_attendance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "client_own" ON hr_attendance FOR ALL
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_attendance TO authenticated;
```

**AttendanceSheet (`/hr/attendance`) — new page:**
- Period selector (reuses `monthly_periods`); fetches active/probation employees + the period's attendance once
- **Mark Attendance tab:** BS day selector (defaults to today in the current month); per-employee status dropdown (Present / Half-day / Absent / Paid Leave / Unpaid Leave / Weekly Off / Holiday), Hours input (hourly staff only), OT hours, Note. Bulk buttons (All Present / All Weekly Off / All Holiday). **Save Day** upserts a complete row set for every active employee (`onConflict: 'employee_id,period_id,bs_day'`)
- **Saturday auto weekly-off:** derived from `bsToAd(...).getDay() === 6` — Saturdays default to Weekly Off with an amber banner; no holiday calendar stored
- **Month Summary tab:** colour-coded grid (employees × BS days), Saturdays shaded, sticky employee column, per-employee totals (present incl. half-days, absent, OT hours); Excel export
- New constants in `payrollConstants.js`: `STANDARD_HOURS_PER_DAY` (8), `OT_MULTIPLIER` (1.5), `WEEKLY_OFF_WEEKDAY` (6), `ATTENDANCE_STATUSES`
- Nav "Attendance" (🗓️) under Human Resources; Help page HR_FEATURES entry added

**Deferred:** Payroll (computes rate × days/hours + OT × 1.5 from this data — next HR session), leave-approval workflow, rosters, biometric import, maintained public-holiday calendar.

**Files:** `src/modules/hr/attendance/AttendanceSheet.jsx` (new), `src/modules/hr/payrollConstants.js`, `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`

---

### S109 — 2026-06-22 — Fix: Service Worker Served Stale Bundle in Development

**Symptom:** AdminClients (and any page) kept rendering an old pre-S101 design on every load, even though the source had the new layout and compiled cleanly.

**Root cause:** The PWA service worker (`public/service-worker.js`) uses a **cache-first** strategy for JS/CSS. In production that's fine — CRA emits hashed filenames, so a new build = new URL = cache miss = fresh fetch. But the SW was also registered in **development** (`npm start`), where the dev bundle has a *stable* filename. The SW cached the dev bundle once and served it forever, ignoring all subsequent code changes — so the UI "fell back" to whatever was first cached.

**Fix:**
- `src/index.js`: register the service worker **only when `process.env.NODE_ENV === 'production'`**. In development, actively `unregister()` any existing SW and clear all caches — so a dev browser that was already stuck self-heals on next load.
- `public/service-worker.js`: bumped `CACHE_NAME` `crest-v3` → `crest-v4`. Browsers always re-fetch the SW script itself (bypassing the cache), detect the change, install the new SW, and its `activate` handler deletes the old `crest-v3` cache.

**Manual unstick (if a browser is still showing the old UI):** DevTools → Application → Service Workers → Unregister; then Application → Storage → Clear site data; hard reload (Ctrl+Shift+R).

**Files:** `src/index.js`, `public/service-worker.js`

---

### S108 — 2026-06-22 — HR Salary: Pay Basis (Monthly/Daily/Hourly) + Minimum Wage Validation

Researched Nepal minimum wage (FY 2082/83): NPR 19,550/month = 12,170 basic + 7,380 dearness; daily NPR 754; hourly NPR 101 (part-time 107). Found two real bugs and a structural gap.

**Bug 1 — Split helper could produce an illegal basic.** At minimum gross (19,550) a 60% split = 11,730, below the legal minimum basic of 12,170. The 60% relative rule is weaker than the absolute minimum at the low end. Fix: `applySplit` now clamps basic up to `MIN_BASIC_MONTHLY` (12,170) when gross ≥ minimum wage.

**Bug 2 — No absolute minimum-wage check.** S106 only validated the basic ≥ 60% *ratio*, never the *amount*. Added warnings for basic/rate below the statutory minimum and gross below NPR 19,550 (monthly).

**Structural gap — part-time/contract on daily/hourly rates had no home.** The engine assumed everyone is monthly-salaried.
- New `pay_basis` column on `hr_employees` (`monthly` / `daily` / `hourly`) — **DB migration required** (see below)
- New shared constants module `src/modules/hr/payrollConstants.js` (SSF rates+cap, minimum wage by basis, 60% rule, `minRateFor()`)
- EmployeeForm Salary tab: Pay Basis selector at top; basis-aware label (Basic /month vs Rate /day vs /hour); split helper + allowances + deductions + monthly summary shown **only for monthly**; daily/hourly show a rate field + minimum-rate warning + "paid via Payroll from attendance (coming soon)" note
- SalaryList: daily/hourly rows show a "per day/hour" badge and their rate spanning the numeric columns ("paid via payroll from attendance"); excluded from monthly payroll totals; stat cards/footer now count monthly employees only; Excel export emits rate + note for non-monthly

**DB migration (run in Supabase SQL editor):**
```sql
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS pay_basis text DEFAULT 'monthly' CHECK(pay_basis IN ('monthly','daily','hourly'));
```

**Tooltips:** Added `Tip` tooltips to all four SalaryList stat cards (Total Gross / SSF Employee / SSF Employer / Net Payroll) and all six table column headers (Basic / Allowances / Gross / Deductions / Net / SSF Employer) — the page previously had none. Also audited all IMS + HR pages for tooltip coverage: added tooltips to **PaymentReport** (stat cards + Net/% columns — clarifies it's purchase spend, not sales revenue; previously had none). Settings already uses always-visible inline hints under each threshold field; Vendors is a plain CRUD list — both intentionally left without tooltips. Admin-only pages (AdminClients, AuditLog) and non-data pages (Login, Pricing, Help) are out of scope.

**Files:** `src/modules/hr/payrollConstants.js` (new), `src/modules/hr/employees/EmployeeForm.jsx`, `src/modules/hr/salary/SalaryList.jsx`

---

### S107 — 2026-06-22 — HR Salary: "Split from Gross" Helper

Employers hire on a gross/total figure then split it — the form previously forced bottom-up entry from basic. Added a one-shot calculator.

**EmployeeForm — Salary tab:**
- Collapsible "⚡ Split from gross salary" helper above the Basic Salary field
- Inputs: Gross (NPR/month) + Basic % (60/70/80/100, 60% floor per Labour Act)
- Live preview: "→ Basic NPR X · Other Allowances NPR Y"
- **Apply split** sets `basic_salary = gross × pct` and writes the remainder into an editable `Other Allowances` earning line (reuses the line if it already exists, else prepends it)
- Data model unchanged — it just populates the existing basic + components fields; everything stays editable afterwards (rename/split the allowance, adjust %)
- Tip notes the SSF trade-off (higher basic % = higher SSF, since SSF is on basic only)

Deliberately a populate-once helper, not a separate "gross mode" — avoids the basic↔gross sync problem once explicit allowances are added.

**Files:** `src/modules/hr/employees/EmployeeForm.jsx`

---

### S106 — 2026-06-22 — HR Salary: SSF Cap + Basic Salary Validation (Nepal Law Compliance)

Researched current Nepal payroll law (FY 2082/83 and the new FY 2083/84 budget) and corrected the salary engine.

**Research findings (sources in memory):**
- SSF: 11% employee + 20% employer, computed on **basic salary capped at NPR 100,000/month** (the cap was missing in S105)
- Labour Act: basic salary must be **≥ 60% of gross pay**
- Income tax FY 2083/84 (effective mid-July 2026): unified single schedule (no married/single split), first slab NPR 10L @ 1%, top rate cut 39% → 29%. SSF contributors get the 1% first-slab tax waived → most F&B staff under ~NPR 83k/month gross pay **zero income tax**. (Informs the future TDS module — not built this session.)

**Fix 1 — SSF cap (NPR 100,000 basic)**
- `EmployeeForm.jsx` + `SalaryList.jsx`: `ssf_base = Math.min(basic, 100000)`; SSF employee/employer computed on `ssf_base` not raw basic
- SSF auto-row label shows "· capped" when basic exceeds the cap

**Fix 2 — Basic salary 60%-of-gross validation**
- Amber warning under the Basic Salary field when `basic < 0.6 × gross` (gross = basic + allowances)

**Deferred (planned, not built):** TDS module (`/hr/tds`), Festival Allowance (annual 1× basic at Dashain — deliberately kept out of monthly chips to avoid corrupting monthly net), Gratuity accrual tracker.

**Files:** `src/modules/hr/employees/EmployeeForm.jsx`, `src/modules/hr/salary/SalaryList.jsx`

---

### S105 — 2026-06-22 — HR Salary Structure: Per-Employee Components + Salary List Page

First HR session after Employee Master. Builds the Salary Structure feature (HR roadmap session 2).

**DB migration required (run in Supabase SQL editor):**
```sql
CREATE TABLE IF NOT EXISTS hr_salary_components (
  id          uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id   uuid    REFERENCES clients(id)       ON DELETE CASCADE NOT NULL,
  employee_id uuid    REFERENCES hr_employees(id)  ON DELETE CASCADE NOT NULL,
  name        text    NOT NULL,
  type        text    NOT NULL CHECK(type IN ('earning', 'deduction')),
  calc_type   text    NOT NULL DEFAULT 'fixed' CHECK(calc_type IN ('fixed', 'percent_of_basic')),
  value       numeric(12,2) NOT NULL DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);
ALTER TABLE hr_salary_components ENABLE ROW LEVEL SECURITY;
CREATE POLICY "client_own" ON hr_salary_components FOR ALL
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_salary_components TO authenticated;
```

**EmployeeForm — Salary tab rebuilt:**
- Loads existing `hr_salary_components` on edit (useEffect)
- Add/remove Allowances (earnings) and Deductions with inline rows; `calc_type` = Fixed NPR or % of Basic (live computed display)
- Quick-add chips: Housing, Transport, Medical, Food, Grade Pay (earnings); CIT/PF, Advance Recovery, Other (deductions)
- SSF Employee (11%) auto-row always shown, read-only
- Live Monthly Summary panel: Gross → Deductions → Net Salary
- Components synced on Save (delete-all + re-insert, same pattern as overheads/wastages)

**SalaryList (`/hr/salary`) — new page:**
- Fetches all employees + all salary components for the client
- Per-employee computed: Basic / Allowances / Gross / Deductions / Net / SSF Employer
- Stat cards: Total Gross Payroll, SSF Employee, SSF Employer, Net Payroll
- Status filter tabs (Active / All / Inactive); table with tfoot totals; Export Excel
- Nav: added "Salary Structure" (₿) under Human Resources in Layout

**Files:** `src/modules/hr/employees/EmployeeForm.jsx`, `src/modules/hr/salary/SalaryList.jsx`, `src/App.js`, `src/components/Layout.js`

---

### S104 — 2026-06-21 — HR Employee: RLS Fix, Gender Constraint Fix, Delete Employee

Three fixes for the HR Employee Master after first real-world Add Employee attempt.

**Fix 1 — hr_employees RLS policy used `my_client_id()` function (doesn't exist)**
- The original `CREATE POLICY` used `client_id = my_client_id()` — a custom function that was never created, causing all writes to be blocked with "new row violates row-level security policy".
- Fix: Run the following in Supabase SQL Editor to replace with safe inline subquery pattern (same as all other tables):
```sql
DROP POLICY IF EXISTS "client_owns_employees" ON public.hr_employees;
CREATE POLICY "hr_employees_select" ON public.hr_employees FOR SELECT USING (
  (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid())
);
CREATE POLICY "hr_employees_insert" ON public.hr_employees FOR INSERT WITH CHECK (
  (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid())
);
CREATE POLICY "hr_employees_update" ON public.hr_employees FOR UPDATE
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));
CREATE POLICY "hr_employees_delete" ON public.hr_employees FOR DELETE USING (
  (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid())
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_employees TO authenticated;
```

**Fix 2 — Gender CHECK constraint rejected empty string**
- DB constraint: `CHECK(gender IN ('male','female','other'))`. When no gender is selected the form sends `''` (empty string), which the constraint rejects.
- Fix: `EmployeeForm.jsx` payload now converts empty strings to `null` for `gender`, `pan_no`, and `citizenship_no` before the DB call (`form.gender || null`).

**Fix 3 — Added Delete Employee (hard delete with double confirm)**
- Added `handleDelete()` function: two `window.confirm` prompts → `supabase.from('hr_employees').delete().eq('id', employee.id)` → `onSave()`.
- Added **Delete** button in the form footer next to the existing Deactivate button. Only visible in edit mode.
- Hard delete — row is permanently removed. Future linked tables (payroll, leave, etc.) will cascade-delete automatically via `ON DELETE CASCADE` on the FK.

**Files:** `src/modules/hr/employees/EmployeeForm.jsx`

---

### S103 — 2026-06-21 — Help Page Module-Based Reorganisation

Full rewrite of `src/pages/Help.js` — the Module Guide tab is now module-aware and plan-tier aware.

**Problem:** The previous Help page had a flat MODULES array with all features listed in order of plan tier, regardless of which modules the client had enabled. A client with only IMS would still see Crest HR features listed, and there was no visual distinction between features the client could access vs features locked behind a higher plan.

**Change — Module Guide tab:**
- Added `useAuth()` import to extract `imsEnabled`, `hrEnabled`, `plan`, `isAdmin`
- Replaced flat `MODULES` array with two structured collections:
  - `IMS_TIERS`: array of 4 tiers — Core (All Plans), Starter Plan, Growth Plan, Pro Plan — each containing their feature entries (icon, name, guide text, tips)
  - `HR_FEATURES`: single array for the HR module (currently Employees)
- **Module sections**: Crest IMS renders only when `imsEnabled`; Crest HR renders only when `hrEnabled`; if both are off, a "No modules active" message is shown
- **Tier unlock logic** (`isTierUnlocked`): `core` and `starter` always unlocked for active IMS users; `growth` requires `plan === 'growth' || plan === 'pro'`; `pro` requires `plan === 'pro'`; `isAdmin` bypasses all
- **Unlocked features**: full expandable accordion card with guide text and tips (same as before)
- **Locked features**: compact dimmed row (opacity 0.45), non-expandable, lock icon visual — shows what exists without full detail
- **Upgrade nudge**: each locked tier gets a dismissible-style banner — "Upgrade to Growth/Pro to unlock X features" with a "View plans →" button linking to `/pricing`
- Module header for each active section shows module name + Active badge + current plan label

**Other tabs:** Getting Started, Glossary, FAQ, Pricing — content identical, no structural changes.

**Files:** `src/pages/Help.js`

---

### S102 — 2026-06-21 — Full Codebase Audit + 4 Bug Fixes

Full cross-check of all pages, feature functions, and logic. No new features — pure bug fixes.

**Bug 1 — Dashboard.js: `canSales`/`canReorder` wrong for Starter plan users**
- `canSales = isAdmin || isPremium || isFeatureEnabled('sales_entry')` evaluated to `false` for Starter users because `isFeatureEnabled` (SettingsContext) only returns `true` for admin or premium (Growth/Pro) users. But `sales_entry` is in `STARTER_KEYS` — all plans should see Revenue, FC%, Net Margin, and related charts.
- Same bug for `canReorder` (`reorder_report` ∈ `STARTER_KEYS`).
- Fix: replaced all four `can*` variables with `hasFeature(key)` from AuthContext, which correctly respects STARTER_KEYS/GROWTH_KEYS/PRO_KEYS tier logic. Removed now-unused `useSettings` import and `isPremium` destructure from Dashboard.

**Bug 2 — AdminClients.js: `handleSaveHr` wrote stale `hr_enabled` snapshot**
- `ClientDrawer` captured `hr_enabled` in a read-only `useState` snapshot at drawer-open time. If the card toggle changed `hr_enabled` while the drawer was open, clicking Save in the Modules tab would write the stale snapshot value back to the DB, overwriting the toggle's change.
- Fix: `handleSaveHr` now only saves `{ hr_plan: hrPlan }`. The `hr_enabled` flag is owned exclusively by the card toggle (`toggleHrEnabled`) — the drawer Modules tab only controls plan tier.

**Bug 3 — Stock.js: Staff Meals tab always visible regardless of plan**
- The `TABS` array included `{ id: 'staff_meal', ... }` unconditionally. `staff_meals` is a Growth-plan feature — Starter users should not see or use this tab.
- Fix: added `hasFeature` to `useAuth()` destructure; the `staff_meal` entry is now spread into TABS only when `hasFeature('staff_meals')` is true.

**Bug 4 — Help.js: No HR / Employees documentation**
- The HR Employee Master (S100) and HR module (S101) were never documented in the Help page, violating the project rule "update Help after every new feature".
- Fix: added `Employees (HR)` entry to the Module Guide MODULES array with full guide text and 4 tips. Added `'Crest HR'` plan badge case (blue `#60a5fa`) to the plan badge colour renderer alongside the existing Pro/Growth+/Starter+ cases.

**Files:** `src/pages/Dashboard.js`, `src/pages/AdminClients.js`, `src/pages/Stock.js`, `src/pages/Help.js`

---

### S101 — 2026-06-21 — Module Access Control: IMS Toggle + AdminClients Redesign + Conditional Dashboard

**DB migration (run S101):**
- `ALTER TABLE clients ADD COLUMN IF NOT EXISTS ims_enabled boolean DEFAULT true` — existing clients unaffected (null treated as true via `?? true` fallback)

**EmployeeForm.jsx (polish):**
- Added `fontFamily: 'inherit'` to the `inp` style constant → date/number inputs now use Georgia (brand font) instead of browser default
- Renamed "Citizenship No." → "National Identity No." (placeholder: "NID / Citizenship No."); DB column `citizenship_no` unchanged

**AdminClients.js — full redesign:**
- Replaced flat table with **card-per-client layout** — each card has: header (name, sub badge, last seen, contact), 3-column module strip, footer actions
- **Module strip (IMS / HR / POS):** each column shows toggle switch + current plan; toggle fires immediately (no Save needed for on/off)
- `toggleImsEnabled()`: confirmation dialog when disabling IMS ("No data is deleted. Re-enabling restores full access instantly."); uses `client.ims_enabled !== false ? false : true` to safely handle null legacy rows
- `toggleHrEnabled()`: saves `hr_enabled` (and clears `hr_plan` to null when disabling)
- **Modules tab in drawer** redesigned: purely plan-tier selectors (IMS plan / HR plan / POS plan — Coming Soon), with individual **Save** buttons per module (`handleSaveIms`, `handleSaveHr`)

**AuthContext.js:**
- Added `ims_enabled` to `clients` select query
- Exposed `imsEnabled`: `isAdmin || (profile?.clients?.ims_enabled ?? true)` — admin always true; `?? true` ensures null legacy rows = on

**Layout.js:**
- Imports `imsEnabled` from `useAuth()`
- Entire IMS nav block gated on `imsEnabled` — clients with IMS off see no IMS pages in sidebar

**ModuleGate.js (new — `src/components/ModuleGate.js`):**
- Route-level guard: `isAdmin` always passes; `module="ims"` redirects to `/dashboard` if `!imsEnabled`; `module="hr"` redirects if `!hrEnabled`
- Applied to every IMS route and the HR `/hr/employees` route in App.js
- IMS + PremiumGate stacked: `<ModuleGate module="ims"><PremiumGate ...><Page /></PremiumGate></ModuleGate>`

**Dashboard.js — conditional rendering:**
- `imsEnabled && hrEnabled` both read from `useAuth()`
- `loadStats()` (IMS data fetch) only called when `imsEnabled`; otherwise `setLoading(false)` immediately
- `loadHrStats()` fetches `hr_employees` (total / active / probation / basic_salary sum) when `hrEnabled`
- **IMS off:** entire KPI grid + charts hidden
- **HR on:** HR stat cards (Total Employees / Active / Basic Payroll/Month) shown below IMS section
- **Both off:** "No modules enabled — contact your consultant to activate your subscription." message

**Toggle safety — data integrity:**
- Toggling IMS off sets `ims_enabled = false` only; zero data deleted, zero cascade
- Re-enabling restores full access instantly (just a boolean flip)

**Files:** `src/modules/hr/employees/EmployeeForm.jsx`, `src/pages/AdminClients.js`, `src/context/AuthContext.js`, `src/components/Layout.js`, `src/components/ModuleGate.js` (new), `src/App.js`, `src/pages/Dashboard.js`

---

### S100 — 2026-06-21 — Crest HR Foundation + Employee Master (Session 1)

**Architecture confirmed:** Crest Suite is ONE React app, ONE Supabase project, ONE Vercel deployment. Three modules (IMS, HR, POS) controlled by per-client feature flags. Sell individually or as a bundle.

**DB migrations (run S100):**
- `ALTER TABLE clients ADD COLUMN hr_enabled boolean DEFAULT false, ADD COLUMN hr_plan text DEFAULT null`
- `CREATE TABLE hr_employees` — 24 columns: identity (code, name, gender, DOB, PAN, citizenship), employment (designation, department, type, join_date, end_date, status), contact (phone, email, address, emergency contact), banking (bank name/account/branch), SSF no., basic_salary, notes
- RLS: `client_id = my_client_id()` policy on hr_employees

**AuthContext.js:**
- `clients` select query extended to include `hr_enabled`, `hr_plan`
- Context now exposes `hrEnabled` (true for admin, or `clients.hr_enabled` for client) and `hrPlan`

**AdminClients.js — Modules tab (initial):**
- New **Modules** tab added to client drawer (between Users and Billing)
- Shows all three modules: Crest IMS (plan selector), Crest HR (toggle + plan selector), Crest POS (coming soon)
- `handleSaveModules()` saves `plan`, `hr_enabled`, `hr_plan`; Billing tab = subscription/trial only
- *(Note: card layout + individual Save buttons + IMS toggle added in S101)*

**Layout.js:**
- Imports `hrEnabled` from `useAuth()`
- HR nav section renders below IMS nav when `hrEnabled && (!isAdmin || adminViewClientId)`
- Shows: Human Resources section header + Employees link (`/hr/employees`)

**HR Session 1 — Employee Master:**
- `src/modules/hr/employees/EmployeeList.jsx` (new): stat cards (total / active / basic payroll), search input, status filter tabs (All / Active / Probation / Resigned / Terminated / Inactive), table with code / name / designation / department / type / join date / basic salary / status badge / Edit button
- `src/modules/hr/employees/EmployeeForm.jsx` (new): slide-in drawer, 4 tabs:
  - Personal — code, name, gender, DOB, PAN, citizenship, phone, email, address, emergency contact
  - Employment — designation, department, type (permanent/probation/contract/part-time), join date, end date (contract only), status, notes
  - Salary — basic salary input + live SSF preview (11% employee / 20% employer / 31% total)
  - Bank / SSF — bank name, account no., branch, SSF registration no.
- Add / Edit / Deactivate flows; validation on full_name and join_date
- `App.js`: `import EmployeeList` + `<Route path="/hr/employees" element={<EmployeeList />} />`

**How to enable HR for a client:**
1. `/admin/clients` → open client drawer → **Modules** tab
2. Toggle Crest HR on → select plan → **Save Modules**
3. Client re-logs in → Human Resources → Employees appears in sidebar

**Files:** `src/context/AuthContext.js`, `src/pages/AdminClients.js`, `src/components/Layout.js`, `src/modules/hr/employees/EmployeeList.jsx` (new), `src/modules/hr/employees/EmployeeForm.jsx` (new), `src/App.js`

---

### S99 — 2026-06-21 — Cross-Client Data Leak Fixes + Admin Impersonation + Bug Fixes

**recipe_ingredients cross-client data leak (no client_id column):**
- `recipe_ingredients` has no `client_id` — was being fetched with no filter, returning all clients' ingredient data
- Fix pattern: first fetch client-scoped recipes, extract `recipeIds`, then fetch `recipe_ingredients.in('recipe_id', recipeIds)`
- Applied to: `Recipes.js`, `Variance.js`, `ReorderReport.js`, `ShrinkageReport.js`, `TheoreticalVariance.js`
- `Dashboard.js`: parallel fetch retained (performance), post-load JS filter using `clientRecipeIdSet`

**Admin impersonation bug (effectiveClientId pattern):**
- 7 pages were using `clientId` directly — admins (who have no `client_id` of their own) saw empty data
- Fix: `const effectiveClientId = clientId || profile?.client_id` on every affected page
- Applied to: `BestSellers.js`, `DeadStock.js`, `VatReport.js`, `WastageReport.js`, `RecipeMargin.js`, `NonVatReport.js`, `PeriodComparison.js`

**MonthlySummary tfoot column offset:**
- `tfoot` had 9 `<td>` cells vs 10 `<thead>` columns — Staff Meals total was missing, shifting all totals right of Wastage under wrong headers
- Fix: inserted Staff Meals `<td>` in correct position; updated COGS formula text to include "Staff Meals"

**Layout.js nav plan flag corrections:**
- `/sales` (Sales Entry): `minPlan: 'growth'` → `'starter'` — Sales Entry is a Starter feature
- `/payments` (Payment Summary): `minPlan: 'growth'` → `'starter'` — Payment Summary is a Starter feature

**Files:** `src/pages/Recipes.js`, `src/pages/Variance.js`, `src/pages/ReorderReport.js`, `src/pages/ShrinkageReport.js`, `src/pages/TheoreticalVariance.js`, `src/pages/Dashboard.js`, `src/pages/BestSellers.js`, `src/pages/DeadStock.js`, `src/pages/VatReport.js`, `src/pages/WastageReport.js`, `src/pages/RecipeMargin.js`, `src/pages/NonVatReport.js`, `src/pages/PeriodComparison.js`, `src/pages/MonthlySummary.js`, `src/components/Layout.js`

---

### S94 — 2026-06-20 — Help Page: All 28 Modules + Corrected Pricing

**Module Guide expanded from 9 to 28 modules (`src/pages/Help.js`):**
- Every page in the app now has a full entry with guide text, tips, and a colour-coded plan badge: no badge = All plans; grey `Starter+`; green `Growth+`; purple `Pro`
- Newly documented: Payment Summary, Annual Summary, Reorder Report, VAT Report, Non-VAT Report, Wastage Report, Outstanding Payables, Budget vs Actual, Requisitions, Dead Stock, Recipe Margin, Best Sellers, Purchase Orders, Period Comparison, Shrinkage Report, Menu Engineering, FIFO, Vendor Report, Supplier Price Tracker, Overheads, Theoretical Variance
- Updated existing: Stock Count now describes all 4 tabs (Opening / Closing / Wastage / Staff Meals); Purchases notes bill-level discount

**Pricing tab corrections:**
- Prices fixed: Starter NPR 5,000 / Growth 8,000 / Pro 12,000 (monthly); 3,750 / 6,000 / 9,000 (annual)
- "Save 40%" → "Save 25%" on annual billing toggle
- Starter feature list expanded to 14 items (was 6 — was only listing Basic-tier features)
- Growth extras (10 items) and Pro extras (8 items) now match actual gate config

**Monthly Workflow — Sales Entry plan badge corrected:** Growth+ → Starter+

**Outstanding Payables — Partial Payment Ledger:**
- Added `payable_payments` table: one row per payment installment, FK to `purchase_entries(id) ON DELETE CASCADE`
- RLS policy joins through `purchase_entries → monthly_periods → client_id`
- New `Paid History` tab added to Outstanding Payables page
- Row expand panel: shows full payment ledger for that invoice + Add Payment form (amount, date, note)
- `paid_at` on `purchase_entries` is now set automatically when cumulative payments reach the invoice total
- Partial badge (purple) shown when some payment made but balance remaining; aging badge otherwise
- **DB migration run ✓** (`payable_payments` table + RLS + GRANT — run S94)

**Files:** `src/pages/Help.js`, `src/pages/OutstandingPayables.js`  
**Commits:** `5c8e97b`, `1671522`

---

### S98 — 2026-06-21 — Plans & Pricing + Help: Title Case Standardisation

**Capitalization audit — all feature list items standardised to Title Case:**
- `src/pages/Pricing.js`: fixed 20 items across `STARTER_FEATURES`, `GROWTH_EXTRAS`, `PRO_EXTRAS`
  - Examples: `'Vendor management'` → `'Vendor Management'`, `'Best & Worst Sellers analysis'` → `'Best & Worst Sellers Analysis'`, `'FIFO / expiry tracking'` → `'FIFO / Expiry Tracking'`
- `src/pages/Help.js`: fixed 33 items across its own `STARTER_FEATURES`, `GROWTH_EXTRAS`, `PRO_EXTRAS` lists
  - Examples: `'Stock count (opening / closing / wastage / staff meals)'` → `'Stock Count (Opening / Closing / Wastage / Staff Meals)'`, `'Sales entry (bulk or daily)'` → `'Sales Entry (Bulk or Daily)'`
- Conjunctions and prepositions (vs, with, by, or, to, and) kept lowercase per standard title case rules

**Files:** `src/pages/Pricing.js`, `src/pages/Help.js`  
**Commits:** `c912f0f` (Pricing.js), `b7ae7c8` (Help.js)

---

### S97 — 2026-06-21 — PWA Offline Stock Count (IndexedDB + Sync Queue)

**Offline-first stock counting (no DB change):**
- `src/utils/offlineQueue.js` (new): IndexedDB wrapper (`crest-offline` DB, 5 object stores)
  - `items_cache`, `categories_cache`, `periods_cache` — full list cache, keyed by `client_id`
  - `stock_cache` — full stock data snapshot (stockData + purchases + returns + requisitioned), keyed by `period_id`
  - `sync_queue` — pending write operations (periodId, itemId, fieldKey, qty), auto-increment id
- `Stock.js`:
  - On every successful online load: caches all items, categories, periods, and stock data to IndexedDB
  - On page load when offline: reads from cache; applies any pending queue entries on top so in-progress offline counts are reflected immediately
  - `persistValue()` → if offline: enqueues to IndexedDB instead of calling Supabase
  - `persistValueDirect()` extracted: takes `periodId` as param; used by both online save and queue flush
  - `flushQueue()`: drains IndexedDB queue to Supabase on reconnect; counts down `pendingSync`; uses `flushRef` to avoid stale closure in online event handler
  - `online` / `offline` event listeners: set `isOnline` state; flush queue on reconnect
  - First load while online also flushes any queue left from a prior offline session
  - Period change while offline: loads cached stock data for selected period
- UX:
  - Amber offline banner: "📵 Offline — entries saved locally, will sync on reconnect" + pending count pill
  - Green syncing banner while flush is in progress
  - Mobile cards: dashed amber border (`mobile-stock-card.pending`) for items with queued offline entries

**Help page updates (same session):**
- `Mobile App` module added (All Plans, no badge) — PWA install instructions + offline counting flow + banner/badge explanations
- `Dashboard` module added (All Plans) — was missing entirely
- `Settings` module added (Starter+) — was missing entirely
- `Stock Count` guide updated: mentions mobile card layout + tip pointing to Mobile App entry
- `STARTER_FEATURES` pricing list: added "Mobile app — installable PWA, offline stock counting"
- Plan reclassification audit: all 31 existing module entries already had correct plan labels; only Dashboard and Settings were missing
- `manifest.json` `start_url` changed from `/` to `/stock` — installed PWA opens directly to Stock Count

**Files:** `src/utils/offlineQueue.js` (new), `src/pages/Stock.js`, `src/pages/Stock.css`, `src/pages/Help.js`, `public/manifest.json`  
**Commits:** `f4b4c6c` (offline), `52f5b02` (start_url → /stock), `50d1ccf` (Help: Mobile App + Stock Count tips), `0ef016a` (Help: Dashboard + Settings modules)

---

### S96 — 2026-06-21 — GHC Logo + Mobile-First Stock Count UX

**GHC gold hexagon logo added:**
- `GHC.png` (gold hexagon brand asset) moved from repo root to `src/assets/logo.png`
- Login page: replaced `⬡` placeholder with `<img>` using the real logo
- Sidebar: replaced `⬡` fallback (shown when no `settings.logo_url`) with the real logo
- PWA icons: `public/logo192.png` + `public/logo512.png` replaced with the GHC logo
- Browser tab favicon updated in `public/index.html` to reference `logo192.png` (PNG, replaces default CRA `.ico`)

**Mobile-first Stock Count UX (no DB change):**
- `Layout.js` / `Layout.css`: responsive sidebar added — sidebar hides on viewports <768px; hamburger ☰ button (position fixed, top-left) slides the sidebar in; overlay tap closes it; all NavLinks close sidebar on tap
- `Stock.js` / `Stock.css` (new): `isMobile` state via `window.innerWidth` + resize listener; on mobile, entry tabs (Opening / Closing / Wastage / Staff Meals) switch from table layout to:
  - Full-width search input
  - Scrollable category pill strip (All + one per category)
  - Progress bar showing X / Y items counted in gold
  - Vertical card list per item — item name, category badge, UOM, purchased/returned reference, 20px number input (auto-saves on blur)
  - Gold border on card when a value is entered
  - Fixed "Save All" bar at bottom of screen
- Desktop table layout unchanged; Summary and Print Sheet tabs unaffected

**Files:** `src/assets/logo.png` (new), `public/logo192.png`, `public/logo512.png`, `public/index.html`, `src/pages/Login.js`, `src/components/Layout.js`, `src/components/Layout.css`, `src/pages/Stock.js`, `src/pages/Stock.css` (new)
**Commits:** `c8cd4d3` (logo), `c962015` (mobile UX)

---

### S95 — 2026-06-21 — Outstanding Payables Bug Fixes + Vercel Cache Fix

**payable_payments RLS fix:**
- Initial RLS policy used a two-level subquery (`purchase_entries → monthly_periods → client_id`) which caused 403 permission denied errors on both SELECT and INSERT
- Fix: added `client_id` column directly to `payable_payments` (same denormalized pattern as `budgets`, `overheads`)
- Dropped old policy, created new simple `client_id = (SELECT client_id FROM profiles WHERE id = auth.uid())` policy
- JS updated to pass `client_id: effectiveClientId` on insert
- Added error handling to `addPayment()` — insert errors now shown inline in red below the payment form
- **DB migration run ✓** (`ALTER TABLE payable_payments ADD COLUMN client_id` + new RLS policy + re-GRANT)

**Outstanding Payables page-hang on browser refresh fixed:**
- `useEffect` was watching `[clientId]` — regular client users never have `clientId` set (they use `profile.client_id`), so `effectiveClientId` was always undefined on mount and `load()` never fired
- Fixed by changing dependency to `[effectiveClientId]`

**Vercel cache fix (`vercel.json` added):**
- Normal browser refresh was serving stale `index.html` from CDN cache → old JS bundle → old UI (e.g. Add Purchase button in wrong position)
- Hard refresh (Ctrl+Shift+R) bypassed cache and loaded correct code
- Fix: `vercel.json` sets `Cache-Control: no-cache, no-store, must-revalidate` on `/index.html` so it is always fetched fresh; content-hashed JS/CSS assets remain long-cached

**VAT Report — returns now reflected:**
- VAT report previously only queried `purchase_entries`; `vendor_returns` were invisible
- Now fetches `vendor_returns` in parallel, filters to those where `purchase_entries.vat_inclusive = true`
- Entries tab: new red "VAT-Inclusive Returns" section below purchases with `−qty / −Base / −VAT Reversed / −Total` columns and a net summary row
- Stat cards updated: Net VAT Purchases, Net Input VAT (Gross − Returns), Net ex-VAT
- CA Summary tab: Gross / Returned / Net Base / Net Input VAT / Net Total per vendor
- Excel export: new "VAT Returns" sheet + CA Summary now includes net columns
- No DB change required

**Files:** `src/pages/OutstandingPayables.js`, `src/pages/VatReport.js`, `vercel.json`  
**Commits:** `a395b71`, `6b47b97`, `730e016`, `80a5c3e`

---

### S93 — 2026-06-20 — Staff Meals Tracking + Purchase Rate Modal Fix

**Staff Meals tracking (new feature):**
- New `Staff Meals` tab in Stock Count alongside Wastage — enter qty consumed by staff/comps per item per period
- New DB table `staff_meals` (period_id, item_id, qty, type CHECK IN ('staff','comp'))
- Formula change across Stock, Variance, Monthly Summary: Used = Opening + Net Purchases − Wastage − **Staff Meals** − Closing
- Stock Summary: Staff Meals column (purple) in both category table and per-item table + two new Excel export columns
- Monthly Summary: Staff Meals column added to category breakdown; COGS tooltip updated
- Variance: staff meals subtracted from actualUsed so recipe-based variance is more accurate
- Feature flag: `staff_meals` (Growth plan) — added to GROWTH_KEYS, DEFAULT_FLAGS, FEATURE_GROUPS

**DB migration run ✓** (`CREATE TABLE staff_meals` + RLS + GRANT + feature_flags column — run S93)

**Files:** `src/pages/Stock.js`, `src/pages/Variance.js`, `src/pages/MonthlySummary.js`, `src/context/AuthContext.js`, `src/pages/AdminClients.js`  
**Commit:** `74a5afb`

---

**Purchase Rate Update — Multi-Item Modal:**

**Rate change detection now covers all items in a bill:**
- Previously: after saving a bill, only the first item with a changed rate triggered a toast prompt; the rest were silently skipped
- Now: all changed items are collected, then shown in a centered checkbox modal — all pre-checked (opt-out model)
- "Update N items" applies only checked items; "Skip all" dismisses without changes
- `applyRateUpdates()` batches all selected updates in parallel via `Promise.all`

**Files:** `src/pages/Purchases.js`  
**Commit:** `94da53b`

---

**Plan structure alignment (S93 continuation):**
- Audited all three sources of plan gating (AuthContext.js STARTER/GROWTH/PRO_KEYS, App.js PremiumGate minPlan, AdminClients.js FEATURE_GROUPS + DEFAULT_FLAGS) against canonical Feature Access modal screenshot
- Fixed `minPlan` in App.js: `/sales` and `/payments` corrected from Growth → Starter; `/settings` confirmed Starter
- Moved `/purchase-orders` route from the "Basic — all users" comment block to the Growth section in App.js (was gated correctly but visually misplaced)
- Added `settings` to `DEFAULT_FLAGS` and to the Starter tier in `FEATURE_GROUPS` in AdminClients.js — was in STARTER_KEYS but admin couldn't grant it as an individual override

**Files:** `src/App.js`, `src/pages/AdminClients.js`  
**Commits:** `4a4c29a`, `781f683`

---

**Settings — Sub-Recipe Codes tab hidden for Starter clients:**
- Sub-Recipe Codes tab was visible to all clients even though sub-recipes require `recipe_costing` (Growth+)
- Added `hasFeature('recipe_costing')` check to the TABS filter
- Starter clients now see: Thresholds | Item Codes | Vendor Codes | Theme

**Files:** `src/pages/Settings.js`  
**Commit:** `2068bca`

---

### S92 — 2026-06-20 — Feature Access Modal Redesign + Feature Flag Fixes

**Feature Access modal (standalone, per-client):**
- Removed Feature Access tab from ClientDrawer; replaced with "Features ⊞" button per client row in the clients table
- Modal opens standalone at `min(1120px, 96vw)` with 4-column CSS grid layout (Core / Starter / Growth / Pro) — no vertical scroll
- Plan-included features locked ON (non-clickable, cursor: default) with a "Plan" badge in tier color
- Admin can only GRANT features above the plan tier — toggle cycles `null ↔ true`, never stores `false`
- Feature rows above plan tier show "Override" badge (gold) when explicitly granted by admin

**Plan tier reorganization:**
- `sales_entry` and `payment_summary` moved from Growth to Starter tier
- `requisitions` moved from add-on to Growth tier (alongside `purchase_orders`)
- Add-on tier eliminated entirely
- `AuthContext.js` `STARTER_KEYS` / `GROWTH_KEYS` updated to match

**Feature flag bug fixes:**
- `SettingsContext.js` `saveFeatureFlags`: added explicit `{ error }` check on both update and insert paths — Supabase-js v2 never rejects promises, errors were swallowed silently
- `hasFeature` in `AuthContext.js`: removed `flagVal === false` revoke check — plan-granted features can no longer be revoked by admin flag
- `DEFAULT_FLAGS` in `AdminClients.js`: all values changed from `false` to `null` (no override by default)

**Add Purchase button relocated:**
- Moved from page header to same row as "All Days / All Items" filters, right-aligned

**DB migration required (run in Supabase SQL Editor if not already done):**
```sql
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS annual_summary boolean;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS outstanding_payables boolean;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS shrinkage_report boolean;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS best_sellers boolean;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS vat_report boolean;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS non_vat_report boolean;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS purchase_orders boolean;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS theoretical_variance boolean;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS requisitions boolean;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS wastage_report boolean;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS dead_stock boolean;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS recipe_margin boolean;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS period_comparison boolean;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS budget_vs_actual boolean;

DO $$ DECLARE cols text[] := ARRAY['sales_entry','monthly_summary','payment_summary','vendor_report','variance_report','fifo_report','reorder_report','price_tracker','recipe_costing','menu_engineering','overheads','budget_vs_actual','best_sellers','vat_report','non_vat_report','purchase_orders','requisitions','wastage_report','dead_stock','recipe_margin','period_comparison','theoretical_variance','annual_summary','outstanding_payables','shrinkage_report']; col text;
BEGIN FOREACH col IN ARRAY cols LOOP EXECUTE format('ALTER TABLE feature_flags ALTER COLUMN %I SET DEFAULT NULL', col); EXECUTE format('UPDATE feature_flags SET %I = NULL WHERE %I = false', col, col); END LOOP; END $$;
```

**Files:** `src/pages/AdminClients.js`, `src/context/AuthContext.js`, `src/context/SettingsContext.js`, `src/pages/Purchases.js`  
**Commits:** `0cca7b7`, `9610d21`, `f9f4896`

**S92 cross-check (same date):**
- Full page-by-page audit of all 37 pages and route/navigate calls
- Fixed `Dashboard.js`: Wastage Value KPI card navigated to `/wastage` (404) → corrected to `/wastage-report`
- Noted `is_sub_recipe` and `yield_pct` as undocumented columns on `items` table (DB schema memory updated)

---

### S91 — 2026-06-20 — Purchases: Bill-Form Redesign, VAT Fix, Daily Register + Items Filter

**VAT formula corrections:**
- `VatReport.js`: stored rates are ex-VAT bases (NetRate on vendor bill), not VAT-inclusive. Fixed all formulas from `total ÷ 1.13` to `base × 0.13`. Columns reordered to Base (ex-VAT) → VAT (13%) → Total (incl. VAT). Stat cards now show Grand Total = what was actually paid. Excel export updated to match.
- `Purchases.js` group header: VAT hint was using `× 13/113` (extractive) — reverted to `× 0.13` (additive) matching vendor bill's "Tax Collected" figure.

**Purchase form redesigned to match vendor bill layout:**
- Rate field now takes **ex-VAT NetRate** (as printed on bill), not VAT-inclusive price. Removed `/1.13` division from `saveBill()` and rate-update check.
- Added **Amount column** (qty × rate for non-VAT; qty × rate × 1.13 for VAT items — what you actually pay).
- VAT hint changed from `ex-VAT: X` → `+VAT: X → total Y per unit`.
- Expiry date + shelf life moved as compact inline fields below the item dropdown, with `Expiry` / `Shelf life` labels.
- Footer redesigned to 3-line bill breakdown: **Subtotal (ex-VAT) / VAT (13%) / Grand Total** matching the vendor's bill totals exactly.

**Bill-level discount added:**
- New `Discount (NPR)` input in the bill footer — deducted from Grand Total.
- Stored as `discount_amount` column on every row in the group (denormalized like `purchase_group_id`).
- Grouped bill view shows net Grand Total with red `−Disc: X` line below.
- Edit flow loads discount from DB.

**SQL required:**
```sql
ALTER TABLE purchase_entries ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) DEFAULT 0;
```

**Daily Purchase Register tab added to Purchases page:**
- New "Daily Register" tab — matrix view: rows = items (grouped by category), columns = days of the month.
- Purchased days highlighted in amber with base-unit qty; empty days show `·`.
- Columns: S.No | Item Name | UOM | Day 1 … Day N (P.Qty / Rate / Per UOM / Opening removed per user request).
- Export Excel downloads full register as `.xlsx`.
- Opening stock fetched from `stock_counts` on tab switch (kept in state, used for Excel export).

**Items page — "With Conversion" filter:**
- Toggle button next to the search box; when active (teal) floats all items with `purchase_unit + conversion_factor > 1` to the top of the list.

**Files:** `src/pages/Purchases.js`, `src/pages/VatReport.js`, `src/pages/Items.js`  
**Commits:** `46af719`, `c9dd99f`, `7ed98e5`, `29a4f09`, `5739ea6`, `6775a17`, `cc16965`, `c5d8b1b`

---

### S90 — 2026-06-20 — Purchases: Grouped Bill View + Cross-Page Bug Fixes

**Purchases page reworked from per-item rows to per-bill groups:**

- Added `purchase_group_id UUID` column to `purchase_entries`. All items saved in one bill session share a UUID; existing rows backfilled via smart SQL grouping by `(period_id, vendor_id, bs_day, invoice_ref, payment_method)`.
- Table now renders a **group header row** per bill (vendor, invoice ref, item count, group total + VAT amount, payment badge, Edit/Del) followed by **item sub-rows** (name, category, qty, uom, rate, item total, expiry). No per-item Edit/Del buttons.
- Edit button pre-fills the multi-item bill form with all entries in the group; Save = delete old entries + re-insert with same UUID.
- Delete button removes the entire bill group with confirmation showing item count + total.
- Removed the Payment column from the table header; payment badge now lives inline in the group header next to Edit/Del.
- Bill Total + incl. VAT both show 2 decimal places.
- `+VAT: NPR X.XX` shown below group total when any item in the group has VAT.

**SQL required (run once in Supabase SQL Editor):**
```sql
ALTER TABLE purchase_entries ADD COLUMN IF NOT EXISTS purchase_group_id UUID;
DO $$
DECLARE r RECORD; new_uuid UUID;
BEGIN
  FOR r IN (SELECT DISTINCT period_id, vendor_id, bs_day, invoice_ref, payment_method FROM purchase_entries WHERE purchase_group_id IS NULL) LOOP
    new_uuid := gen_random_uuid();
    UPDATE purchase_entries SET purchase_group_id = new_uuid
    WHERE purchase_group_id IS NULL AND period_id = r.period_id
      AND (vendor_id = r.vendor_id OR (vendor_id IS NULL AND r.vendor_id IS NULL))
      AND bs_day = r.bs_day
      AND (invoice_ref = r.invoice_ref OR (invoice_ref IS NULL AND r.invoice_ref IS NULL))
      AND (payment_method = r.payment_method OR (payment_method IS NULL AND r.payment_method IS NULL));
  END LOOP;
END $$;
ALTER TABLE purchase_entries ALTER COLUMN purchase_group_id SET DEFAULT gen_random_uuid();
```

**Cross-page bug fixes (caught via audit):**
- `SupplierPriceTracker.js`: removed `per_uom_rate` from `.update()` payload — it's a generated column, the write was silently failing.
- `ShrinkageReport.js`, `Variance.js`, `TheoreticalVariance.js`, `MonthlySummary.js`, `AnnualSummary.js`: added `.eq('is_sub_recipe', false)` to items fetch — sub-recipe mirror items were leaking into cost calculations.

**Files:** `src/pages/Purchases.js`, `src/pages/SupplierPriceTracker.js`, `src/pages/ShrinkageReport.js`, `src/pages/Variance.js`, `src/pages/TheoreticalVariance.js`, `src/pages/MonthlySummary.js`, `src/pages/AnnualSummary.js`  
**Commit:** `829d86c`

---

### S89 — 2026-06-20 — Dashboard Rework: Net Margin, Wastage KPI, SR Count Fix

**Three targeted improvements to the client dashboard:**

- **Est. Net Margin %** card added to Row 1 KPIs — `(Revenue − Food Cost − Overheads) / Revenue × 100`. Green ≥20%, yellow 10–20%, red <10%. Only shows when revenue data exists. This is the "money the business keeps" number.
- **Wastage Value** card added to Row 2 KPIs — total NPR value of wastage recorded this period (`qty × per_uom_rate` per item). Shows red when >0, links to Wastage Report.
- **Items in Master count fixed** — dashboard was counting SR mirror items (`is_sub_recipe = true`) inflating the item count. Now correctly excludes them.
- **Items data fetch fixed** — spend/variance/reorder calculations now exclude SR mirror items (they have no purchase history so were producing noise).
- Grid columns tightened from `minmax(200px,1fr)` to `minmax(160px,1fr)` to fit 5 primary KPI cards.

**Files:** `src/pages/Dashboard.js`  
**Commit:** `0424401`

---

### S88 — 2026-06-20 — Stock Count: Value (NPR) Column on Entry Tabs

Added a **Value (NPR)** column after the Returned column on the Opening Stock, Closing Stock, and Wastage tabs. Shows `qty entered × per_uom_rate` rounded to nearest rupee. Displays bold gold when there is a value, `—` when qty or rate is zero. Includes a Tip tooltip.

**Files:** `src/pages/Stock.js`  
**Commit:** `d92b63e`

---

### S87 — 2026-06-20 — Fix SR Sync: per_uom_rate is a Generated Column

Sub-recipe → item auto-sync (S86) was silently failing on save. Added error surfacing to the sync block to expose the Supabase 400 error: `Column "per_uom_rate" is a generated column — cannot insert a non-DEFAULT value`. Removed `per_uom_rate` from the `itemPayload`; Supabase auto-computes it from `rate`. Also added error handling to category create and item update paths so future failures surface as red text in the UI rather than failing silently.

**Files:** `src/pages/Recipes.js`  
**Commit:** `0d23676`

---

### S86 — 2026-06-20 — Sub-Recipe → Item Auto-Sync for Stock Tracking

**Sub-recipes now appear in Stock Count (Opening/Closing/Wastage) automatically.**

When a Sub-Recipe is saved in Recipe Costing, a mirror item is auto-created in the `items` table (`is_sub_recipe = true`) with the SR's name, yield UOM, and cost-per-unit as `per_uom_rate`. On re-save the item updates; on delete the item is soft-deleted. A "Sub-Recipes" category is auto-created in `categories` if it doesn't exist.

SR items are hidden from: Item Master, Purchases, Purchase Orders, Requisitions, Reorder Report, Supplier Price Tracker, Dead Stock, and the Recipe ingredient picker. They appear in: Stock Count, Variance, Theoretical Variance, Wastage Report, Shrinkage Report, Monthly/Annual Summary.

"Kitchen Production" removed from default category list — pre-made purchased items go under Groceries; in-house made items become Sub-Recipes.

**SQL required (run once in Supabase SQL Editor):**
```sql
ALTER TABLE items ADD COLUMN IF NOT EXISTS is_sub_recipe boolean DEFAULT false;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS linked_item_id uuid REFERENCES items(id);
```

**Files:** `src/pages/Recipes.js` (save + deleteRecipe), `src/pages/Items.js` (filter SR items + remove Kitchen Production default), `src/pages/Purchases.js`, `src/pages/PurchaseOrders.js`, `src/pages/Requisitions.js`, `src/pages/ReorderReport.js`, `src/pages/SupplierPriceTracker.js`, `src/pages/DeadStock.js`  
**Commit:** `4618164`

---

### S85 — 2026-06-20 — Login: Show Password Toggle

Added "Show password" checkbox below the password field on the login page. Toggles input type between `password` and `text`. Checkbox uses `accent-color` gold to match the theme.

**Files:** `src/pages/Login.js`, `src/pages/Login.css`  
**Commit:** `38b5460`

---

### S84 — 2026-06-20 — IMS Reports: Annual Summary + Outstanding Payables + Shrinkage

**Three new report pages:**

- **Annual Summary** (`/annual-summary`, Starter+) — Full-year rollup with Calendar Year / Fiscal Year toggle (Nepal FY = Shrawan–Ashadh). Month-by-month table: Revenue, Gross Purchases, Returns, Net Purchases, Wastage, COGS, FC% with pp trend vs prior month. Annual totals footer. Print + Excel export. FC% colour-coded green/amber/red.
- **Outstanding Payables** (`/payables`, Growth) — Unpaid credit purchases by vendor with aging buckets (Current / 31–60 / 61–90 / 90+ days). Inline "✓ Mark Paid" button sets `paid_at` on the entry and removes it from the list. Setup banner shows the required SQL if `paid_at` column not yet added. Vendor filter + aging filter.
- **Shrinkage Report** (`/shrinkage`, Pro) — Multi-period unexplained stock loss analysis. Computes variance (actual used − theoretical) across last 3/6/12 closed periods per item. Only items with recipe coverage included. Status badges: Consistent (≥67% of periods flagged), Occasional (2+ periods), Once, Clear. Sorted by total loss value NPR.

**SQL required for Outstanding Payables (run once in Supabase SQL Editor):**
```sql
ALTER TABLE purchase_entries ADD COLUMN IF NOT EXISTS paid_at date;
```

**Files:** `src/pages/AnnualSummary.js` (new), `src/pages/OutstandingPayables.js` (new), `src/pages/ShrinkageReport.js` (new), `src/context/AuthContext.js` (added annual_summary/outstanding_payables/shrinkage_report to plan sets), `src/App.js` (3 routes), `src/components/Layout.js` (3 nav entries)  
**Commit:** TBD

---

### S83 — 2026-06-20 — Crest Suite Scaffold + IMS Pricing Corrected

**Scaffolded Crest Suite module structure** based on `CREST_SUITE_PROJECT_CONTEXT.md`:
- `src/modules/{ims,pos,hr}/` — 28 sub-directories with `.gitkeep` files
- `src/shared/hooks/` — `useClientFeatures.js`, `useBS.js`, `index.js`
- `src/shared/constants/` — `leaveTypes.js`, `taxSlabs.js` (computeAnnualTDS/Monthly), `ssfRates.js` (computeSSF), `shiftTypes.js`, `index.js`
- `src/dashboard/OwnerDashboard.js` — placeholder (Suite Growth+)
- `src/auth/PinEntry.js` — working 4-digit PIN pad component
- `supabase/migrations/` — directory created

**IMS Pricing corrected** (`src/pages/Pricing.js`): Starter NPR 5,000, Growth NPR 8,000, Pro NPR 12,000/mo. Annual badge corrected from 40% → 25%.

**Files:** 44 new/modified files across scaffold + Pricing.js  
**Commit:** `8a83d6f`

---

### S81 — 2026-06-20 — Getting Started Guide Expanded

**Rewrote Help → Getting Started tab (`src/pages/Help.js`)**
- Added welcome card with plain-English intro and the COGS formula highlighted in a callout box.
- First-Time Setup steps now include a "Why this matters" line per step + Growth+ plan badges on relevant steps.
- Monthly Workflow steps now note which are ongoing (steps 1–4) vs month-end (steps 5–9).
- Added "Common Mistakes to Avoid" card (5 red-flagged pitfalls: closing before closing stock, skipping opening stock, batch-entering purchases, ignoring Variance, estimated closing counts).

**Files:** `src/pages/Help.js`  
**Commit:** `08051ad`

---

### S80 — 2026-06-19 — PWA Icons Updated

**Replaced default CRA icons with Crest gold hexagon logo (`public/`)**
- `logo192.png`, `logo512.png`, `favicon.ico` all regenerated from `GHC.png` source file.
- Icons use dark navy (`#0f1117`) background with logo centered at 84% of canvas (8% padding each side — maskable safe zone compliant).
- Used `sharp` npm package for correct alpha compositing; uninstalled after use.
- `manifest.json` unchanged — already pointed to correct filenames with `purpose: "any maskable"`.

**Files:** `public/logo192.png`, `public/logo512.png`, `public/favicon.ico`  
**Commit:** `8c79a30`

---

### S79 — 2026-06-19 — Admin: Clear Audit Logs

**Clear All button on Audit Log page (`src/pages/AuditLog.js`)**
- Added `clearLogs()` function — builds filters matching the active Client / Area / Time selectors and calls a Supabase RPC to delete matching rows.
- Direct `DELETE` on `audit_logs` was blocked by RLS → switched to `supabase.rpc('admin_clear_audit_logs', {...})` with a `SECURITY DEFINER` Postgres function that bypasses RLS.
- "✕ Clear Logs" button appears in page header (red ghost style, next to Refresh) only when logs are visible.
- Confirm dialog shows entry count and current filter scope before deleting.

**SQL added to Supabase:** `admin_clear_audit_logs(p_client_id, p_table_name, p_cutoff)` — accepts optional filters, deletes matching rows, returns deleted count.

**Files:** `src/pages/AuditLog.js`  
**Commits:** `4dc4b98`, `2206e7b`

---

### S78 — 2026-06-19 — Table Column Padding Tightened

**Reduced horizontal padding on all data tables (`src/components/Layout.css`)**
- `table.data-table th` and `td` horizontal padding reduced: `14px → 5px`.
- Vertical padding unchanged (`11px`) — only column spacing tightened.
- Applies globally to all tables in the app (Item Master, Purchases, Stock, Vendors, Reports, etc.).

**Files:** `src/components/Layout.css`

---

### S77 — 2026-06-19 — Admin: Clear All Conversions

**Admin-only bulk clear for unit conversions (`src/pages/Items.js`, `src/pages/AdminClients.js`)**

- **Items page** (`src/pages/Items.js`): Added `isAdmin` from `useAuth()`. New `clearAllConversions()` function — counts items with a conversion, shows count in confirm dialog, bulk-updates all affected items: `purchase_unit = null`, `base_unit = null`, `conversion_factor = 1`, `purchase_qty = 1`. Button (red ghost style) appears in page header only when `isAdmin && items.some(i => i.purchase_unit)` — hidden for non-admins and when no conversions exist.

- **AdminClients Danger Zone** (`src/pages/AdminClients.js`): Added `handleClearConversions()` — queries how many items have a conversion first, confirms with count, then bulk-updates. Button added as the first (lightest) action in the Danger Zone button row, before "Clear Client Data" and "Delete Client". Success/error message reuses `deleteMsg` state. Accessible without switching into a client context.

**Files:** `src/pages/Items.js`, `src/pages/AdminClients.js`

---

### S76 — 2026-06-19 — Purchases Multi-Row Bill Entry Form

**Redesigned Add Purchase form — bill-header + line-items (`src/pages/Purchases.js`)**
- Replaced single-item-at-a-time entry with a two-section bill form matching real-world purchasing workflow.
- **Header row** (shared across all items on the bill): Vendor · BS Day · Invoice Ref · Payment Method.
- **Line table** (one row per item): Item dropdown (auto-fills rate from item master) · Qty (shows UOM, converts to base units if CF set) · Rate (shows ex-VAT amount below when VAT ticked, line total in gold) · Expiry Date · Shelf Life in days (auto-calculates expiry from header day; updates all lines when header day changes) · VAT checkbox per line (each item independently taxable) · × remove row.
- **Bottom bar**: Bill total + VAT amount summary · `+ Add Item` button · `Save N Entries` button (only counts valid lines).
- Batch inserts all valid lines in one `supabase.from('purchase_entries').insert(entries[])` call.
- Rate update prompt shown for first item with a changed rate (same logic as before).
- Edit flow (clicking Edit on an existing entry) unchanged — still uses single-row form.
- Build confirmed clean before push.

**Files:** `src/pages/Purchases.js`

---

### S75 — 2026-06-19 — PO Admin Delete · Deploy to Vercel

**PO delete restricted to admin only (`src/pages/PurchaseOrders.js`)**
- Delete button now only visible when `isAdmin = true` — client users see no delete button at all.
- Admin can delete any PO status (Draft, Sent, Partial, Received, Cancelled), not just drafts.
- Cleanup order: deletes `purchase_order_items` first (FK constraint), then `purchase_orders`.
- Non-draft deletions show a warning that linked purchase entries are not affected.

**First production deployment to Vercel**
- All changes since initial commit (S62–S73) committed and pushed to `xrestha/crest-inventory` on GitHub.
- Vercel auto-deployed at `https://crest-inventory.vercel.app`.
- Environment variables set in Vercel dashboard: `REACT_APP_SUPABASE_URL`, `REACT_APP_SUPABASE_ANON_KEY`, `REACT_APP_SUPABASE_SERVICE_ROLE_KEY` (legacy anon/service_role keys).
- Future deploys are automatic on every `git push origin master`.

**Files:** `src/pages/PurchaseOrders.js`

---

### S74 — 2026-06-19 — First Production Deployment to Vercel

**App deployed to Vercel — now live at `https://crest-inventory.vercel.app`**
- Committed all changes since initial commit (S62–S73) in one bundle: 59 files, 18,040 insertions.
- Pushed to `origin/master` (GitHub: `xrestha/crest-inventory`) — Vercel auto-deployed on push.
- Environment variables set in Vercel dashboard:
  - `REACT_APP_SUPABASE_URL` = `https://dkgusgktifwnqmqkkshz.supabase.co`
  - `REACT_APP_SUPABASE_ANON_KEY` = legacy anon/public key
  - `REACT_APP_SUPABASE_SERVICE_ROLE_KEY` = legacy service_role key
- Used **Legacy anon, service_role API keys** tab in Supabase (not the new Publishable/Secret format).
- Build completed with 2 warnings (non-blocking), login screen confirmed on Vercel preview.
- **Future deploys are automatic** — every `git push origin master` triggers a new Vercel build (2–3 min).
- Custom domain deferred — Vercel URL sufficient for now.

**Files:** All source files committed. Excel salary files and `verify_login.png` intentionally excluded from repo.

---

### S73 — 2026-06-19 — Dashboard Locked KPI Cleanup

**Hide locked KPIs from client dashboard instead of showing blurred lock overlays (`src/pages/Dashboard.js`)**
- Removed `LockedSection` component entirely — the blurred padlock overlay is gone.
- Revenue, Food Cost %, Costed Recipes, Variance, and Reorder KPI cards now render `null` when the client's plan doesn't include them, instead of showing a greyed-out locked placeholder.
- Row 1 and Row 2 KPI grids changed from `repeat(4, 1fr)` to `repeat(auto-fit, minmax(200px, 1fr))` — remaining visible cards expand naturally to fill the row with no empty slots.
- Bottom row (Variance + Reorder): entire section hidden when both panels are locked. If only one is unlocked, it renders full-width. If both unlocked, side-by-side as before.
- **Growth and Pro clients unaffected:** `isPremium = true` for both plans → all `can*` flags are `true` → all KPI cards always visible. Only Starter clients without individual feature flags see fewer cards.

**Files:** `src/pages/Dashboard.js`

---

### S72 — 2026-06-19 — PurchaseOrders Select Theming · SW Cache Bump

**PurchaseOrders dropdowns — browser-default white appearance fixed (`src/pages/PurchaseOrders.js`)**
- 5 selects were unstyled: period header selector (`filter-select` — undefined class), vendor in PO form, period in PO form, item-per-line in PO form, payment method in receive panel.
- Fixed: all converted to `className="form-select"`. Inline style on item select replaced with `className="form-select" style={{ width: '100%' }}`.

**Service worker cache bump (`public/service-worker.js`)**
- Bumped `CACHE_NAME` from `crest-v2` → `crest-v3` to evict cached JS bundles and make the new class names visible in browser.

**Audit Log access verified (S71)**
- Admin can see Audit Log while viewing a client workspace — expected, `isAdmin` remains true for the admin account regardless of which client is being viewed.
- Confirmed: real client users cannot see Audit Log — link absent from sidebar, direct URL redirects to `/dashboard` via `ProtectedRoute adminOnly`. No fix required.

**Files:** `src/pages/PurchaseOrders.js`, `public/service-worker.js`

---

### S71 — 2026-06-19 — Audit Log Access Verified

**Audit Log access control confirmed correct**
- Admin reported seeing Audit Log while viewing a client workspace — this is expected. The admin sidebar always shows admin-only links (`Clients`, `Periods`, `Audit Log`, `Settings`) regardless of which client is being viewed, because `isAdmin` remains true.
- Verified by logging in as a real client user in a separate browser: Audit Log link does not appear in sidebar, and direct navigation to `/admin/audit` redirects to `/dashboard` via `ProtectedRoute adminOnly`. No fix required.

---

### S70 — 2026-06-19 — Clear Client Data Bug Fix · Edge Function Hardening

**Bug: Clear Client Data silently did nothing (`supabase/functions/admin-user-ops/index.ts`)**
- Root cause 1 — Missing tables: `purchase_orders`, `purchase_order_items`, `requisitions`, `requisition_lines`, `budgets` were not in the delete sequence. These tables have FK references to `vendors` and `items`, so deleting `vendors`/`items` was silently blocked by PostgreSQL FK constraints.
- Root cause 2 — No error checking: the Edge Function never checked `error` on any individual `.delete()` call. All deletions failed silently and the function returned `{ success: true }` regardless.
- Root cause 3 — Non-2xx masking: the function returned 500 on errors, but `supabase.functions.invoke` swallows non-2xx bodies and replaces them with a generic "Edge Function returned a non-2xx status code" message — the real error was invisible. Fixed by always returning 200 with `{ error: string }` in the body.
- Fix: Added `del()` helper that throws on any Supabase error. Correct FK-order delete sequence:
  1. `recipe_ingredients`, `purchase_order_items`, `requisition_lines` (deepest FK children)
  2. `purchase_entries`, `vendor_returns`, `opening_stock`, `closing_stock`, `wastages`, `sales_entries`, `budgets` (period-keyed)
  3. `purchase_orders`, `requisitions` (by client_id)
  4. `overheads`, `par_levels`, `monthly_periods`, `recipes`, `items`, `vendors`, `categories` (root client-keyed)

**SQL run this session (Supabase SQL Editor):**
```sql
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
```
Required because tables created via SQL migrations (rather than Supabase dashboard) don't automatically get service_role grants. This allows the Edge Function (which runs as service_role) to DELETE from all tables.

**Files:** `supabase/functions/admin-user-ops/index.ts` — redeployed via `npx supabase functions deploy admin-user-ops`

---

### S69 — 2026-06-19 — Scrollbar Theming · Print/Export Button Fix · Non-VAT Report · VAT & Non-VAT CA Summary Tab

**Themed scrollbars (`src/components/Layout.css`)**
- Added global `-webkit-scrollbar` + Firefox `scrollbar-width/color` rules. Track: `--theme-bg`, Thumb: `--theme-border` (6px slim), Hover: `--theme-text2`. Applies to sidebar, table overflows, and all scroll containers.

**Print/Export button consistency (`src/pages/DeadStock.js`, `WastageReport.js`, `PeriodComparison.js`, `RecipeMargin.js`)**
- These 4 pages used `btn btn-secondary` — a class with no definition in Layout.css, causing browser-default white button rendering.
- Replaced with `btn btn-ghost` to match all other Print/Export buttons in the app.

**Non-VAT Report — new page (`src/pages/NonVatReport.js`)**
- New Starter+ report at `/non-vat-report` (feature flag: `non_vat_report`).
- Fetches `purchase_entries` where `vat_inclusive = false` (server-side filter).
- 4 stat cards: Total Non-VAT Purchases, Unique Vendors, Avg per Entry, Input VAT Credit (NIL).
- Entries tab: Day, Item, Category, Vendor, Qty, UOM, Rate, Total — with totals row.
- CA Summary tab: vendor-wise grouped with PAN/VAT No., # Bills, Total, VAT Credit = NIL. Missing PAN shown in red with "add in Vendors" prompt.
- Print + Export Excel (two sheets: Entries + CA Summary).
- Wired into: App.js, Layout.js (sidebar), AuthContext.js (STARTER_KEYS), AdminClients.js (DEFAULT_FLAGS + FLAG_LABELS).

**VAT Report — CA Summary tab + Excel export added (`src/pages/VatReport.js`)**
- Added "Entries" / "CA Summary" tab switcher (tab-btn pattern).
- CA Summary: vendor-wise breakdown — Vendor, PAN/VAT No., # Bills, Total (incl. VAT), Base (ex-VAT), Input VAT (13%). Period total row at bottom. Missing PAN flagged in red.
- Added Export Excel: produces two sheets — "VAT Entries" (full line-by-line) + "CA Summary" (vendor-wise) — in one file.
- `vendors(name)` select expanded to `vendors(name, pan_vat_no)` to pull PAN into both tabs.
- "For reference only — verify bills with your CA before filing" disclaimer badge on CA Summary tab.
- Replaced all hardcoded hex colours with CSS variables (`var(--theme-accent)` etc.) throughout.

**Non-VAT Report — CA Summary tab (`src/pages/NonVatReport.js`)**
- Same Entries / CA Summary tab pattern. CA Summary: Vendor, PAN/VAT No., # Bills, Total, VAT Credit = NIL per vendor.
- Export Excel: two sheets — "Non-VAT Entries" + "CA Summary".

**Files:** `src/components/Layout.css`, `src/pages/DeadStock.js`, `src/pages/WastageReport.js`, `src/pages/PeriodComparison.js`, `src/pages/RecipeMargin.js`, `src/pages/NonVatReport.js`, `src/pages/VatReport.js`, `src/App.js`, `src/components/Layout.js`, `src/context/AuthContext.js`, `src/pages/AdminClients.js`

---

### S68 — 2026-06-19 — Pill/Select Consistency Sweep · Service Worker Cache Fix

**Pill button consistency — all pages (`src/components/Layout.css`, multiple pages)**
- Audited every page for filter/sort pill buttons. Found 5 pages using non-standard patterns: `btn-primary`/`btn-ghost` (FifoReport, Requisitions), custom inline `TAB()` styles (BestSellers), inline style objects (PurchaseOrders), and inline styles (MenuEngineering).
- Converted all to `tab-btn` / `tab-btn--active` / `tab-bar` classes. Intentional underline-nav tabs (Items category tabs, PaymentReport Summary/Daily) left unchanged.

**Select dropdown consistency — all pages**
- Audited all select elements. Found 9 pages with inline `selectStyle` / `SEL` constant objects duplicating the same dark-theme styles.
- Removed all `selectStyle`/`SEL` constants and replaced `style={...}` with `className="form-select"` across: AuditLog, Purchases, ReorderReport, VatReport, VendorReport, Variance, PaymentReport, FifoReport, SupplierPriceTracker, MenuEngineering, BestSellers.
- `SupplierPriceTracker` had two selects with spread syntax (`{...selectStyle, minWidth:220}`) — converted to `className="form-select" style={{minWidth:220}}`.

**`tab-btn` appearance fix (`src/components/Layout.css`)**
- Added `-webkit-appearance: none; appearance: none` to prevent native OS button chrome from overriding the dark background.
- Changed background from `rgba(255,255,255,0.04)` to `var(--theme-card)` for an explicit dark base.

**Dead code removed (`src/pages/Periods.js`)**
- Removed `adminReopenLatest()` — defined but never called anywhere (ESLint `no-unused-vars` warning).

**Service worker cache bump (`public/service-worker.js`)**
- Root cause of "no change" after CSS edits: the SW used a cache-first strategy with `CACHE_NAME = 'crest-v1'` — once a CSS bundle was cached it was served indefinitely, making all CSS changes invisible.
- Bumped to `CACHE_NAME = 'crest-v2'`. On next SW install, old cache is purged and all assets are re-fetched fresh.

**Files:** `src/components/Layout.css`, `src/pages/FifoReport.js`, `src/pages/Requisitions.js`, `src/pages/BestSellers.js`, `src/pages/PurchaseOrders.js`, `src/pages/MenuEngineering.js`, `src/pages/AuditLog.js`, `src/pages/Purchases.js`, `src/pages/ReorderReport.js`, `src/pages/VatReport.js`, `src/pages/VendorReport.js`, `src/pages/Variance.js`, `src/pages/PaymentReport.js`, `src/pages/SupplierPriceTracker.js`, `src/pages/Periods.js`, `public/service-worker.js`

---

### S67 — 2026-06-19 — End Period · CSS Fixes · Tooltip Consistency

**End Period button (`src/pages/Periods.js`)**
- Added `adminEndPeriod(period, cid)` — closes the current period without creating a new one. Client is blocked from recording data until admin creates a new period.
- Button sits next to "Close & Start Next" in the admin all-clients Periods table, styled darker red to signal higher destructiveness.
- Fixed `adminCreatePeriod` — previously threw "A period for this month already exists" when clicking "+ Create Period" after ending a period (the closed record still existed). Now checks `allClientPeriods` for an existing closed period for the current BS month and reopens it instead of inserting a duplicate.
- Info tooltip uses `Tip` component (not native `title`) — `ⓘ` icon beside the End Period button.

**Tooltip consistency (`src/pages/ReorderReport.js`)**
- "Set par" clickable span: replaced `title="Click to set par level"` with `<Tip>` wrapping the span.
- Physical/Calc'd badge: replaced dynamic `title={...}` with `<Tip>` wrapping the badge.

**Settings — Data tab hidden from clients (`src/pages/Settings.js`)**
- Added `'Data'` to `CLIENT_HIDDEN` set. Clients now see: Thresholds, Item Codes, Vendor Codes, Sub-Recipe Codes, Theme. Data tab (Archive Periods, Data Export, Reset) is admin-only.

**Sign-out button fix (`src/components/Layout.js`, `Layout.css`)**
- Root cause: sidebar-footer was `display: flex` (row direction); Upgrade button had `width: 100%` which pushed sign-out button off-screen.
- Fix: changed `.sidebar-footer` to `flex-direction: column; align-items: stretch`. Wrapped user info + sign-out button in a `display: flex; justify-content: space-between` row div so the ⎋ button is always visible.

**Missing CSS classes — three classes used in newer pages but never defined (`src/components/Layout.css`)**
- **`stats-row`** (undefined) → renamed to `stat-grid` in 4 pages: DeadStock, WastageReport, RecipeMargin, PeriodComparison. These cards were stacking vertically instead of in a horizontal grid.
- **`.form-select`** (undefined) → added to Layout.css: dark background (`--theme-input-bg`), themed border and text — fixes white browser-default select boxes in the same 4 pages.
- **`.tab-btn` / `.tab-btn--active` / `.tab-bar`** (undefined) → added to Layout.css: dark-themed pill filter/sort buttons with gold active state, matching the app design system. Used in DeadStock, WastageReport, RecipeMargin.

**Files:** `src/pages/Periods.js`, `src/pages/ReorderReport.js`, `src/pages/Settings.js`, `src/components/Layout.js`, `src/components/Layout.css`, `src/pages/DeadStock.js`, `src/pages/WastageReport.js`, `src/pages/RecipeMargin.js`, `src/pages/PeriodComparison.js`

---

### S66 — 2026-06-19 — Last Seen Tracking · Admin Periods · Danger Zone Cleanup

**Last Seen / Active Today tracking**
- SQL: `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;`
- `src/context/AuthContext.js` — fire-and-forget presence ping after every successful `fetchProfile`. Uses `.then(() => {})` to trigger Supabase lazy promise execution (without `.then()` the HTTP request never fires). Updates `last_seen_at` to `now()` on every app load/tab focus.
- `src/pages/Dashboard.js` — admin Active Properties stat card now shows "X active today" with a green dot and a name list of which clients have been seen in the last 24h. `loadAdminStats` queries profiles by `last_seen_at >= now - 24h`, cross-references with the clients array already fetched.
- `src/pages/AdminClients.js` — "Last Seen" column added to the clients table. `loadLastSeen()` queries all profiles with `last_seen_at IS NOT NULL`, groups by `client_id` taking the max timestamp. Shows relative time: "Just now" / "Xm ago" / "Xh ago" / "Yesterday" / "Xd ago" / "Never". Green + bold when seen within 24h.

**Service worker `clone` fix (`public/service-worker.js`)**
- Bug: `res.clone()` was called inside an async `.then(caches.open(...).then(...))` callback — by the time `caches.open` resolved, the response body could already be consumed by the page, causing `TypeError: Failed to execute 'clone' on 'Response': Response body is already used`.
- Fix: call `const toCache = res.clone()` synchronously before any async operation, then pass `toCache` into the cache write.

**Admin drawer — Item Code Prefix removed (`src/pages/AdminClients.js`)**
- Removed "Item Code Prefix" field from AdminClients → Settings tab. Clients manage their own prefixes via Settings → Item Codes. Admin doesn't need to set this.

**Settings page — code prefix tabs moved to Starter tier (`src/context/AuthContext.js`)**
- `'settings'` moved from `PRO_KEYS` to `STARTER_KEYS`. All clients on any plan now see Settings → Thresholds, Item Codes, Vendor Codes, Sub-Recipe Codes, Data, Theme tabs. Admin-only tabs (Branding, Contact, Property) remain hidden from clients via `CLIENT_HIDDEN`.
- Routes table updated: `/settings` now Starter+.

**Danger Zone simplified (`src/pages/AdminClients.js`)**
- Removed two-step destruction guard (type property name + enter admin password). Replaced with a single `window.confirm()` dialog showing full warning text.
- "Delete All Client Data" renamed to **"Clear Client Data"** — deletes operational data only, keeps client record and users.
- Added **"Delete Client"** button — fully deletes the client: all user auth accounts (via `adminOp('deleteUser')` per profile), all operational data (`deleteClientData`), `settings`, `feature_flags`, and finally the `clients` row. Closes drawer on completion.

**Expired period banner — admin button (`src/pages/Dashboard.js`)**
- Admin now sees "Go to Periods →" button in the expired period banner (was info-only text). Navigates to `/periods` for the currently viewed client.

**Admin sidebar — Periods always visible (`src/components/Layout.js`)**
- Added `Periods` NavLink to the admin-only section of the sidebar (between Clients and Audit Log). Visible regardless of whether a client is selected.

**Periods page — admin all-clients view (`src/pages/Periods.js`)**
- When admin visits `/periods` with no client selected, shows a full table of all clients instead of "No periods yet."
- Columns: Property (clickable — switches admin context), Open Period, Status (OPEN / EXPIRED / NO PERIOD), Total periods count, Actions.
- Actions per row: **✏ Edit** (inline year/month fields with Save/Cancel), **Close & Start Next** (for open periods), **+ Create Period** (creates a period for the current BS month when none exists).
- Subtitle shows "X need attention" count for active clients with expired or missing periods.
- Clicking a client name calls `switchAdminClient()` and navigates to `/periods` — switches to per-client detailed view.

**SQL run this session:**
```sql
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
```

**Files:** `src/context/AuthContext.js`, `src/pages/Dashboard.js`, `src/pages/AdminClients.js`, `src/pages/Periods.js`, `src/components/Layout.js`, `public/service-worker.js`

---

### S65 — 2026-06-19 — Sidebar UX · Admin Cleanup · Settings Fixes

**Sidebar — hide locked pages for client users (`src/components/Layout.js`)**
- Locked pages no longer appear in sidebar for client users — hidden entirely (was: shown at 40% opacity with 🔒)
- `unlockedItems()` replaces `sortNavItems()` — simply filters to accessible items only
- **Upgrade teaser card** appears below Reports section showing the next tier's features (Starter→Growth green card, Growth→Pro gold card). Lists up to 5 feature names + count + "Upgrade to X ↑" button → `/pricing`
- Collapsed sidebar: teaser becomes a small `↑` badge
- **Footer upgrade pill** — `Starter · Upgrade ↑` (green) or `Growth · Upgrade ↑` (gold) above sign-out; links to `/pricing`. Hidden for Pro and Admin.
- Admin-unlocked individual flags: those pages appear in the sidebar normally and are removed from the teaser list automatically

**Admin sidebar simplified (`src/components/Layout.js`)**
- When admin has no client selected (`!adminViewClientId`): sidebar shows only Dashboard, Clients, Audit Log, Settings, Help
- When admin switches into a client: full operational nav appears (Periods, Items, Vendors, Purchases, Stock, Reports, etc.)

**Settings tabs simplified for admin (`src/pages/Settings.js`)**
- Admin Settings now shows 4 tabs only: **Branding · Contact · Theme · Data** (removed Property, Thresholds, Item Codes, Vendor Codes, Sub-Recipe Codes — these are per-client, managed via AdminClients drawer)
- Client default tab fixed: was incorrectly initialising to 'Branding' (hidden tab); now defaults to 'Thresholds'
- Logo upload moved into Settings → Branding (was: "Logo is managed via Admin → Clients → Settings drawer" note). Full upload UI: 64×64 preview, ↑ Upload Logo button, Remove button, success/error message. Saves immediately on upload; path: `Logos/{clientId||'admin'}/logo.{ext}`
- Helper text removed from App Name and Tagline inputs

**Settings save bug fixed (`src/context/SettingsContext.js`)**
- Root cause: `saveSettings()` was sending the full `form` object (including DB metadata columns `id`, `client_id`, `created_at`, `updated_at`) in the UPDATE payload. PostgREST silently rejected updates to the primary key `id`, so saves never persisted but showed "✓ Saved"
- Fix: destructure and strip metadata before UPDATE/INSERT. Also added `if (error) throw new Error(error.message)` so errors surface in the UI instead of being swallowed

**Fix: Enable All in Feature Access not toggling Theoretical Variance (`src/pages/AdminClients.js`)**
- `theoretical_variance` was in FLAG_LABELS but missing from DEFAULT_FLAGS. `toggleAllFlags()` iterates `Object.keys(DEFAULT_FLAGS)` so it silently skipped it
- Fix: added `theoretical_variance: false` to DEFAULT_FLAGS

**Back button on Pricing page (`src/pages/Pricing.js`)**
- Added "← Back" button (ghost style) before "Start Free Trial →" in the CTA section. Uses `navigate(-1)` to return to wherever the user came from (sidebar upgrade link, login page, etc.)

**SQL run in Supabase:**
```sql
ALTER TABLE settings ADD COLUMN IF NOT EXISTS sub_recipe_code_prefix text DEFAULT 'SRC';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS vendor_code_prefix text DEFAULT 'VND';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS property_address text;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS property_phone text;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS property_email text;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS vat_number text;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS contact_phone text;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS contact_email text;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS contact_website text;
```

**Files:** `src/components/Layout.js`, `src/pages/Settings.js`, `src/context/SettingsContext.js`, `src/pages/AdminClients.js`, `src/pages/Pricing.js`

---

### S64 — 2026-06-19 — Plan Reclassification & Feature Access Restructure

**Analysis:** Starter plan had zero reports — hard to justify NPR 8,000/mo. Growth was overloaded with basic compliance and operational reports that should be available to all. New classification:

| Tier | Auto-unlocked features |
|---|---|
| **Starter** | Monthly Summary, Reorder Report, VAT Report, Wastage Report |
| **Growth** | Sales Entry, Recipe Costing, Variance, Payment Summary, Budget vs Actual, Best Sellers, Purchase Orders, Dead Stock, Recipe Margin |
| **Pro** | Menu Engineering, FIFO, Vendor Report, Price Tracker, Overheads, Theoretical Variance, Period Comparison, Settings |
| **Flag-only** | Requisitions (admin enables per client) |

**Files changed:**
- `src/context/AuthContext.js` — Added `STARTER_KEYS` set; removed monthly_summary/reorder_report/vat_report from GROWTH_KEYS; added wastage_report to STARTER_KEYS; added dead_stock/recipe_margin to GROWTH_KEYS; added period_comparison to PRO_KEYS; updated `hasFeature()` to check STARTER_KEYS first (returns true for all plans)
- `src/components/Layout.js` — REPORTS array reordered by tier; removed minPlan from Starter reports; period_comparison moved to minPlan: 'pro'
- `src/App.js` — PremiumGate minPlan updated: monthly_summary/reorder_report/vat_report/wastage_report → 'starter'; period_comparison → 'pro'
- `src/components/PremiumGate.js` — Added 'Starter' to PLAN_LABEL; updated upgradeDesc for Growth and Pro to reflect new feature lists
- `src/pages/AdminClients.js` — FLAG_LABELS reorganised into 4 sections (Main / Starter / Reports[Growth] / Pro); Feature Access tab now renders 4 labelled sections with sub-headers explaining which plan auto-unlocks them

---

### S63 — 2026-06-19 — Recipe Contribution Margin + Period-over-Period Comparison

**`src/pages/RecipeMargin.js`** (new) — Route `/recipe-margin`, Growth, `recipe_margin` flag
- Period selector. 3 stat cards: Total Contribution (green), Weighted Avg FC%, Top Contributor recipe.
- Sort tabs: Total Contribution | Margin/Portion | FC% (best first). Checkbox: "Only recipes with sales" (default on).
- Category filter tabs. Table: # | Recipe | Category | Selling Price | Food Cost/Portion | Contribution/Portion (green/red) | Qty Sold | Total Contribution (gold) | FC% (colour-coded). Footer row with weighted totals.
- Recipes with no sales shown at 45% opacity when checkbox unchecked. Sub-recipes excluded.
- Print + Export Excel. Filename: `RecipeMargin-YYYY-M.xlsx`.

**`src/pages/PeriodComparison.js`** (new) — Route `/period-comparison`, Growth, `period_comparison` flag
- No period selector — shows all periods. Limit dropdown: Last 6 / Last 12 / Last 24 / All.
- 3 stat cards: Latest FC% + pp trend vs prev, Best FC% Period, Latest Revenue.
- Table: Period | Net Purchases | Wastage | COGS | Revenue (ex-VAT) | FC% (colour-coded) | vs Prev (↑↓ pp change, green=improving/down, red=worsening/up).
- COGS = Opening Value + Net Purchases − Wastage − Closing Value (all NPR). Revenue = qty_sold × selling_price ex-VAT.
- FC% shows — when no sales data entered. Open period badge (green OPEN tag). Wastage cell amber when non-zero.
- Multi-period Supabase fetch using `.in('period_id', ids)` for all 6 tables. Aggregated in JS per period.
- Print + Export Excel. Filename: `PeriodComparison.xlsx`.

**Supporting changes:**
- `src/App.js` — imports + routes for both (Growth PremiumGate)
- `src/components/Layout.js` — added Recipe Margin (◈) + Period Comparison (⇄) to REPORTS array
- `src/pages/AdminClients.js` — `recipe_margin` + `period_comparison` in DEFAULT_FLAGS + FLAG_LABELS (Reports)

**SQL to run in Supabase:**
```sql
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS recipe_margin boolean DEFAULT false;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS period_comparison boolean DEFAULT false;
```

---

### S62 — 2026-06-19 — Wastage Report + Dead Stock / Slow Movers

**`src/pages/WastageReport.js`** (new) — Route `/wastage-report`, Growth plan, `wastage_report` flag
- Period selector. 3 stat cards: Total Wastage Value (red), Items with Wastage count, Top Wastage Category + value.
- Category filter tabs (auto-built from data).
- Table: Item | Category | UOM | Qty Wasted | Value (NPR) | % of Total. Sorted by value descending.
- Footer row with totals. Tip tooltips on Qty Wasted, Value, % of Total.
- Print + Export Excel. Filename: `Wastage-YYYY-M.xlsx`.

**`src/pages/DeadStock.js`** (new) — Route `/dead-stock`, Growth plan, `dead_stock` flag
- Period selector. 3 stat cards: Dead count (red), Slow count (amber), Value at Risk (red).
- Status filter tabs: All / Dead (N) / Slow (N). Category filter tabs alongside.
- Dead = Used = 0 (zero consumption). Slow = Used < 20% of net available (opening + purchased − returned).
- Table: Item | Category | UOM | Opening | Net Purchased | Wasted | Used | Closing | Value at Risk | Status badge.
- Value at Risk = Closing qty × per_uom_rate. Sorted by Value at Risk descending.
- Export Excel (12 columns). Print.

**Supporting changes:**
- `src/App.js` — added imports + routes for both pages (Growth plan PremiumGate)
- `src/components/Layout.js` — added to REPORTS array above Best Sellers: Wastage Report (⚠), Dead Stock (⊘)
- `src/pages/AdminClients.js` — added `wastage_report` + `dead_stock` to DEFAULT_FLAGS and FLAG_LABELS (Reports section)

**SQL to run in Supabase:**
```sql
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS wastage_report boolean DEFAULT false;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS dead_stock boolean DEFAULT false;
```

---

### S61 — 2026-06-19 — PWA Installable Shell

**Files changed:**
- `public/manifest.json` — renamed app to "Crest Inventory Management" / "Crest IMS", set `theme_color: #c9a84c` (gold accent), `background_color: #0f1117` (dark), `display: standalone`, `orientation: portrait-primary`, `scope: /`
- `public/service-worker.js` — new vanilla service worker. Strategies: navigation requests = network-first (fallback to cached root); static assets = cache-first; Supabase API calls = never cached (pass-through). Cache name `crest-v1` — increment to bust on breaking deploys.
- `src/index.js` — registers `/service-worker.js` on `window load` with silent `.catch(() => {})`
- `public/index.html` — `<title>Crest Inventory</title>`, `theme-color` meta updated to `#c9a84c`, added `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-mobile-web-app-title` metas for iOS

**To do after deploy:**
- Replace `public/logo192.png` + `public/logo512.png` with actual Crest logo at 192×192 and 512×512 px
- On Chrome mobile: visit site → browser shows "Add to Home Screen" prompt automatically
- On Safari iOS: Share → "Add to Home Screen" manually

---

### S60 — 2026-06-19 — Requisitions / Internal Transfers

**Requisitions feature (`src/pages/Requisitions.js` — new)**
- Route `/requisitions`, Growth plan, `requisitions` feature flag. Nav item "Requisitions ↔" between Stock Count and Sales Entry.
- Internal stock transfers from main store to departments (Kitchen, Bar, Pastry, Banquet, Room Service, etc.).
- **List view** — 4 stat cards (Total Requisitions / Issued / Draft count / Total Issued Value). Department filter tabs (auto-built from data). Table: Day, Dept, Items, Status badge (DRAFT yellow / ISSUED green), Value, View/Del actions.
- **New Requisition form** — BS day picker (defaults to today when period = current BS month), department `<select>` with 18 hospitality presets (Kitchen, Bar, Pastry/Bakery, Banquet, Room Service, Coffee Shop, Staff Cafeteria, Housekeeping, Laundry, Stewarding, Engineering, Front Office, Concierge, Spa, Pool, Security, Administration, Other), notes field, item lines table (Item dropdown, UOM, Qty Requested, Qty Issued, Rate/UOM, Est. Value, remove ×). "Save as Draft" / "Save & Issue" buttons.
- **View/Issue mode** — Header card with Day/Dept/Status/Notes. Draft: Issue button → confirm-quantities flow (per-line qty_issued editable, supports partial issue — partial shown in red). Issued: read-only lines with partial badge. Print + Export Excel always shown.
- **Print** — `.no-print` on header controls and action card; `.print-only` "Store Requisition Slip" header with period/day/dept/status/notes table + `<hr>` divider; line items table prints via existing print CSS (white bg, bordered cells).
- **Export Excel** — downloads `Requisition-Day{N}-{Dept}-{Period}.xlsx` with columns: Item, Category, UOM, Qty Requested, Qty Issued, Rate, Value.

**Stock.js — Requisitioned column**
- `requisitioned` state added. `loadStockData` runs a try/catch query on `requisition_lines` joined to `requisitions` (filter: `period_id` + `status = 'issued'`) to build `reqMap` per item.
- Summary tab: "Requisitioned" column (purple `#a78bfa`) added between Used and Opening Value. Tooltip: "Total qty issued from the store via requisition slips. Should align with Used quantity."
- Excel export: "Requisitioned Qty" column added.

**CSS fix — dark background on table-cell inputs/selects**
- Added `table.data-table td select` + `table.data-table td input` rules to `Layout.css` using `var(--theme-input-bg)` / `var(--theme-border)` / `var(--theme-accent)` — fixes white dropdown background in Requisitions and any other editable table cells.

**SQL to run in Supabase:**
```sql
CREATE TABLE requisitions ( id uuid DEFAULT gen_random_uuid() PRIMARY KEY, client_id uuid REFERENCES clients(id) ON DELETE CASCADE, period_id uuid REFERENCES monthly_periods(id) ON DELETE CASCADE, bs_day integer NOT NULL, department text DEFAULT 'Kitchen', status text DEFAULT 'draft' CHECK (status IN ('draft','issued')), notes text, created_at timestamptz DEFAULT now() );
ALTER TABLE requisitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "client_own" ON requisitions USING ((SELECT role FROM profiles WHERE id=auth.uid())='admin' OR client_id=(SELECT client_id FROM profiles WHERE id=auth.uid())) WITH CHECK ((SELECT role FROM profiles WHERE id=auth.uid())='admin' OR client_id=(SELECT client_id FROM profiles WHERE id=auth.uid()));
GRANT SELECT,INSERT,UPDATE,DELETE ON public.requisitions TO authenticated;
CREATE TABLE requisition_lines ( id uuid DEFAULT gen_random_uuid() PRIMARY KEY, requisition_id uuid REFERENCES requisitions(id) ON DELETE CASCADE, item_id uuid REFERENCES items(id) ON DELETE CASCADE, qty_requested numeric NOT NULL DEFAULT 0, qty_issued numeric DEFAULT 0 );
ALTER TABLE requisition_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "client_own" ON requisition_lines USING ((SELECT role FROM profiles WHERE id=auth.uid())='admin' OR requisition_id IN (SELECT id FROM requisitions WHERE client_id=(SELECT client_id FROM profiles WHERE id=auth.uid()))) WITH CHECK ((SELECT role FROM profiles WHERE id=auth.uid())='admin' OR requisition_id IN (SELECT id FROM requisitions WHERE client_id=(SELECT client_id FROM profiles WHERE id=auth.uid())));
GRANT SELECT,INSERT,UPDATE,DELETE ON public.requisition_lines TO authenticated;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS requisitions boolean DEFAULT false;
```

**Files:** `src/pages/Requisitions.js` (new), `src/App.js`, `src/components/Layout.js`, `src/pages/AdminClients.js`, `src/pages/Stock.js`, `src/components/Layout.css`

---

### S59 — 2026-06-19 — Horizontal Scrollbar Fixes · GRN VAT Toggle · Purchases Column Merge

**Horizontal scrollbar — root fix (`src/index.css`)**
- Added `html, body { overflow-x: hidden }` to prevent page-level horizontal scroll. Internal `.table-wrap { overflow-x: auto }` still works correctly.

**Purchases column merge (`src/pages/Purchases.js`)**
- 13 columns → 11 columns. Invoice / VAT / Expiry merged: `<th>Invoice / Expiry</th>` + combined cell (invoice ref on top, expiry date below in amber). VAT shown as `+VAT` label inside the Payment badge column (no separate column). Totals row `colSpan` corrected from 4 → 2.

**GRN VAT inclusive toggle (`src/pages/PurchaseOrders.js`)**
- When a PO is confirmed received (GRN), items previously went straight to `purchase_entries` with `vat_inclusive: false` hardcoded — user had to go back to Purchases and manually tick VAT per item.
- Fix: added `receiveVatInclusive` state + checkbox in the GRN receive form (styled gold when checked, Tip tooltip explaining 13% strip). `confirmReceive()` now sets `vat_inclusive: receiveVatInclusive` and stores `rate: receiveVatInclusive ? l.unit_price / 1.13 : l.unit_price` (ex-VAT, consistent with Purchases.js save logic).
- Removed unused `remaining` variable that was causing an ESLint warning.

**App-wide `table-wrap` audit — 11 tables fixed**
All screen-visible tables that were missing `<div className="table-wrap">` wrappers were wrapped. Print-only tables (`print-sheet-table`, print cost cards, print PO document) correctly left alone.
- `Help.js` — glossary table
- `AuditLog.js` — help panel table (inside existing `overflow: hidden` div)
- `Overheads.js` — main overheads table
- `PaymentReport.js` — both Method Summary and Daily Breakdown tables
- `Sales.js` — period summary table + daily entry table
- `SupplierPriceTracker.js` — main price tracker table (10+ columns, most critical)
- `Recipes.js` — ingredient edit table (form) + ingredient detail view table
- `Dashboard.js` — variance widget inline table

**Files:** `src/index.css`, `src/pages/Purchases.js`, `src/pages/PurchaseOrders.js`, `src/pages/Help.js`, `src/pages/AuditLog.js`, `src/pages/Overheads.js`, `src/pages/PaymentReport.js`, `src/pages/Sales.js`, `src/pages/SupplierPriceTracker.js`, `src/pages/Recipes.js`, `src/pages/Dashboard.js`

---

### S58 — 2026-06-19 — Purchase Orders · Yield % Fixes · App-wide Tooltips

**Purchase Order Workflow (`src/pages/PurchaseOrders.js` — new)**
- Route `/purchase-orders`, Growth plan, `purchase_orders` feature key.
- 3 views: PO list, PO create/edit form, Goods Receipt Note (GRN) receive form.
- Status flow: Draft → Sent → Partial/Received/Cancelled. Auto PO number (PO-001, PO-002…).
- Auto-fills unit_price from item's `per_uom_rate` on item select.
- GRN creates `purchase_entries` rows (period_id, item_id, vendor_id, bs_day, qty, rate, payment_method, `invoice_ref = po_number`). Cumulative `qty_received` per line. Status auto-sets to `partial` (some received) or `received` (all done).
- 13 Tip tooltips on all action buttons, column headers, and form labels.
- Supporting changes: `AuthContext.js` adds `purchase_orders` to GROWTH_KEYS; `Layout.js` adds nav item; `App.js` adds route; `Pricing.js` adds to GROWTH_EXTRAS (now 10 items); `PremiumGate.js` growth description updated; `AdminClients.js` adds `purchase_orders: false` to DEFAULT_FLAGS and FLAG_LABELS.

**Yield % Fixes (Variance.js + Dashboard.js)**
- `Variance.js` — Added `yieldMap` from items. `theoreticalMap` now divides by `yieldFactor` per item. Added `if (!ri.item_id) return` guard for sub-recipe rows.
- `Dashboard.js` — Items select updated to include `yield_pct`. Same yieldMap + yieldFactor pattern applied to theoreticalMap calculation.

**App-wide Tooltips (8 additional pages)**
- Added `Tip` import and tooltips to: `Purchases.js` (Invoice Ref, Expiry Date, Shelf Life, Payment, VAT Incl.), `Recipes.js` (FC % column, Selling Price, Menu Price, VAT Rate, Target FC %, Yield Qty/UOM labels), `Sales.js` (Total Revenue, % of Revenue), `BestSellers.js` (Revenue, Margin — both tables), `BudgetVsActual.js` (Budget, Actual Net, Variance NPR, Variance %), `VatReport.js` (Total incl. VAT, Base ex-VAT, VAT 13%), `VendorReport.js` (Returns, Net Spend, % of Net Total, Avg/Day), `SupplierPriceTracker.js` (Master Rate, Update Rate, Last Rate, Trend, Change %).
- Memory updated: `feedback_tooltips.md` added — all future new modules must include Tip tooltips.

**Files:** `src/pages/PurchaseOrders.js` (new), `src/context/AuthContext.js`, `src/components/Layout.js`, `src/App.js`, `src/pages/Pricing.js`, `src/components/PremiumGate.js`, `src/pages/AdminClients.js`, `src/pages/Variance.js`, `src/pages/Dashboard.js`, `src/pages/Purchases.js`, `src/pages/Recipes.js`, `src/pages/Sales.js`, `src/pages/BestSellers.js`, `src/pages/BudgetVsActual.js`, `src/pages/VatReport.js`, `src/pages/VendorReport.js`, `src/pages/SupplierPriceTracker.js`

---

### S57 — 2026-06-18 — Yield % on Ingredients · Product Roadmap

**Yield % on Ingredients (3 files + 1 DB migration)**
- New `yield_pct` column on `items` table (`NUMERIC(5,2) NOT NULL DEFAULT 100`). DB migration: `ALTER TABLE items ADD COLUMN IF NOT EXISTS yield_pct NUMERIC(5,2) NOT NULL DEFAULT 100;`
- Semantic: `qty_per_portion` = net (usable) qty needed. Effective as-purchased cost = `qty / (yield_pct / 100) × rate`. Default 100 = no trim loss, no change to existing data.
- `Items.js` — `yield_pct` added to EMPTY_FORM, openEdit, save payload. New form field with `Tip` tooltip explaining trim loss with real examples (whole chicken 70%, spinach 60%, onion 85%). Shows in items table column, red when <100.
- `Recipes.js` — all 3 cost functions updated (`calcSubRecipeCostPerUnit`, `calcRecipeCost`, `calcLiveCost`). Ingredient row in edit form uses adjusted cost. Detail view adds Yield % column (red when <100), total row colspan fixed from 5→6.
- `TheoreticalVariance.js` — `expandIngredients` now accepts `itemList` parameter and divides each item's net qty by its `yield_pct` to produce gross (as-purchased) theoretical consumption. Recursive sub-recipe call also passes `itemList`. All 3 call sites updated.

**Tip tooltip component**
- `Tip` component (`src/components/Tip.js`) imported into Items.js for the first time.
- Two tooltip placements: form field label (detailed with examples, width 260), table column header (short, width 240).

**Product Roadmap (memory only — no code)**
- Decided: Crest HR and Crest POS will be separate products, not built into Crest Inventory.
- Crest HR scope documented: payroll, SSF (11%+20%) / EPF toggle, Dashain bonus, advance/loan tracking, gratuity, TDS, final settlement, service charge distribution.
- Crest POS: integration point with Inventory for real-time recipe depletion and Sales Entry auto-population.
- Priority: Finish Crest Inventory first.

**Files:** `src/pages/Items.js`, `src/pages/Recipes.js`, `src/pages/TheoreticalVariance.js`

---

### S56 — 2026-06-18 — Theoretical vs Actual Food Cost · Package Classification Fix

**Theoretical vs Actual Food Cost (`src/pages/TheoreticalVariance.js` — new)**
- Route `/theoretical-variance`, Pro plan, `theoretical_variance` feature key.
- Per-ingredient comparison: Theoretical consumption (recipes × qty sold, with sub-recipe expansion) vs. Actual consumption (opening + purchased − returned − wastage − closing).
- Sub-recipe expansion is recursive — qty_per_portion / yield_qty cascades correctly into raw ingredients.
- Variance = Actual − Theoretical. Positive = over-consumed (waste/theft/over-portioning). Negative = under-portioning or data error.
- Color coding: red >+5%, amber <−5%, green within ±5% tolerance.
- 4 summary stat cards: Theoretical Cost, Actual Cost, Total Variance Value, Items Over-used count.
- Filters: category, over/under-consumed toggle, sort (by variance value / % / name).
- Footer totals row. Export to Excel (8 columns).
- Shows empty state with guidance when no sales or recipe data exists for the period.

**Package Classification Fix (3 files)**
- `AuthContext.js` — added `budget_vs_actual`, `best_sellers`, `vat_report` to `GROWTH_KEYS`. These were gated correctly in App.js but missing from GROWTH_KEYS, causing Growth plan users to see them as 🔒 locked in the sidebar.
- `AuthContext.js` — added `theoretical_variance` to `PRO_KEYS`.
- `Pricing.js` — Growth extras expanded from 6 → 9 features (Budget vs Actual, Best & Worst Sellers, VAT Report added). Pro extras include Theoretical Variance.
- `PremiumGate.js` — upgrade descriptions updated to match actual feature lists.
- `Layout.js` — Theoretical Variance nav item added to REPORTS section (Pro, `⊿` icon).
- `App.js` — route registered with PremiumGate Pro gate.

**Stock Register Value Columns (from S56 plan — `src/pages/Stock.js`)**
- 5 NPR value columns added to per-item Summary table: Open. Value, Purch. Value, Wastage Value, Close Value, COGS (NPR).
- Left-border visual separator between qty block and value block.
- Format: `NPR X,XXX` (en-NP locale), shows `—` when rate=0 or qty=0.

**Sales.js fix**
- `sortedRecipes` was computed but Bulk Entry table used `recipes.map` directly. Fixed — bulk entry table now uses `sortedRecipes.map` so sort controls take effect.

**Files:** `src/pages/TheoreticalVariance.js` (new), `src/context/AuthContext.js`, `src/pages/Pricing.js`, `src/components/PremiumGate.js`, `src/components/Layout.js`, `src/App.js`, `src/pages/Stock.js`, `src/pages/Sales.js`

---

### S55 — 2026-06-18 — Sales Daily Entry Tab + Daily Breakdown Tab

**Daily Entry tab restored (`Sales.js`)**
- New "Daily Entry" tab added between Bulk Entry and Period Summary.
- Day picker: ‹ / › arrow buttons + 1–32 dropdown. Defaults to today's BS day when the open period matches the current BS month (via `getBsToday()`); resets to 1 when switching to a past/future period.
- Day count uses `daysInBsMonth(bs_year, bs_month)` instead of hardcoded 32 — accurate per period.
- "Today (day X)" button appears only when on the current BS month and user has navigated away from today — one-click jump back.
- Save Day / Clear buttons at both top and bottom of the table (so users don't scroll back up on long lists).
- Data stored in `sales_entries` with `bs_day = 1..32` (bulk entry continues to use `bs_day = 0`).
- Period Summary tab now aggregates `allDaySums` — sum of ALL `sales_entries` rows across all `bs_day` values (bulk + daily combined) so the summary reflects whichever entry method the client uses.
- **Bug fix:** Clear button was not persisting — `parseFloat('')` returns `NaN`, causing `saveDaily()` to fall back to the saved DB value instead of deleting. Fixed by treating `''` explicitly as `0`.

**Daily Breakdown tab (`Sales.js`)**
- New 4th tab "Daily Breakdown" — pivot table view of all daily sales for the period.
- Rows: menu items with any sales. Columns: only days that have data (compact, no empty columns), plus a "Bulk" column when `bs_day=0` entries exist.
- Today's day column header highlighted gold with ⬤ dot when viewing the current BS month.
- Menu Item + Category columns are sticky (CSS `position: sticky`) so they stay visible while scrolling horizontally through many day columns.
- Day totals row (footer) + row totals column (right). Grand total bottom-right.
- Zeros shown as muted `—` to surface active entries at a glance.
- Loads fresh on tab activation or period change via dedicated `useEffect`.

**Files:** `src/pages/Sales.js`

### S54 — 2026-06-18 — Recipe PDF Cost Card · Dashboard FC% Trend Chart

**Recipe PDF Cost Card (`Recipes.js`)**
- 🖶 Print Cost Card button added to every row in both the regular recipes and sub-recipes list tables (no need to open detail view).
- 🖶 button also in detail view alongside Edit Recipe.
- Print fires `window.print()` — app UI hides (`no-print`), cost card renders (`print-only`).
- Cost card layout: business name (from Settings) + recipe name + date header · summary strip (Food Cost / Selling Price ex-VAT / Menu Price incl. VAT / FC% / Gross Margin%) · ingredient table (Ingredient, Qty, UOM, Rate, Cost, % of Dish, totals row) · True Cost with Overheads panel (auto-shown when overhead data exists) · Confidential footer.
- Sub-recipe variant shows Batch Cost / Cost per Unit / Yield instead of selling price fields.
- Page header ("Recipe Costing" title) hidden on print via conditional `no-print` class.
- List view table hidden on print via `no-print` wrapper when `printRecipe` state is set.
- `printRecipe` state + 80ms `setTimeout` useEffect auto-fires print dialog after DOM renders.

**Dashboard FC% Trend Chart (`Dashboard.js`)**
- Full-width line chart added between the 3-chart row and Variance/Reorder panels.
- Fetches last 11 closed periods in bulk (3 queries: `purchase_entries`, `vendor_returns`, `sales_entries` all using `.in('period_id', [...])`); appends current open period's already-computed FC%.
- X-axis: abbreviated BS month + year ("Asa 2082", "Kar 2082"…), oldest → newest.
- Dots color-coded: green ≤35%, amber 35–45%, red >45%. Current open period dot has white ring.
- Dashed reference lines at 35% (green) and 45% (red) with inline labels.
- Tooltip: FC% · NPR Purchases · NPR Revenue for that period.
- Only visible when `canSales` is true and ≥2 data points exist.
- `ReferenceLine` added to Recharts import.

**Files:** `src/pages/Recipes.js`, `src/pages/Dashboard.js`

### S53 — 2026-06-18 — Archive Periods · Best/Worst Sellers · VAT Report · Audit Improvements

**Archive Periods (`Periods.js`)**
- Periods closed >12 months ago are hidden by default. "Show Archived (N)" toggle in page header.
- Open periods always visible regardless of age.

**Best & Worst Sellers (`src/pages/BestSellers.js` — new)**
- Route `/best-sellers`, Growth plan, `best_sellers` feature flag.
- Period selector + rank toggle (By Revenue / By Volume / By Margin %).
- Top 10 bar chart (Recharts). Top 10 + Bottom 10 tables: Rank, Item, Category, Qty, Revenue, Margin %.
- Summary strip: Total Revenue, COGS, Gross Profit, Overall Margin %, Items Sold.

**VAT on Purchases + VAT Report**
- `purchase_entries.vat_inclusive boolean DEFAULT false` — new column.
- Purchase form: "VAT Incl. (13%)" checkbox per entry. When checked, total breakdown shows Base (ex-VAT) + VAT (13%) live.
- Purchases table: "VAT" column shows amber badge on VAT-inclusive rows.
- `src/pages/VatReport.js` (new) — route `/vat-report`, Growth plan, `vat_report` flag.
  - 5 summary cards: Total Purchases · Non-VAT Purchases · VAT-Inclusive total · Input VAT (claimable) · Net ex-VAT.
  - Table of VAT-inclusive entries: Total incl. VAT / Base ex-VAT / VAT (13%) columns + totals row.
  - Non-VAT purchases summary below.

**Audit Log improvements**
- Help panel: collapsible "What does the Audit Log record?" toggle — table of 7 areas, operations tracked, notes.
- Item Master now tracked: `CREATE TRIGGER audit_items AFTER INSERT OR UPDATE OR DELETE ON items`.
  - `TABLE_LABELS` + `getSummary()` updated for `items` — edit summaries show what changed (Name/Rate/UOM diffs).
- Trigger bug fixed: nested IF for `monthly_periods` status check (prevented `record "old" has no field "status"` error on other tables).

**SQL run this session:**
```sql
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS best_sellers boolean DEFAULT false;
ALTER TABLE purchase_entries ADD COLUMN IF NOT EXISTS vat_inclusive boolean DEFAULT false;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS vat_report boolean DEFAULT false;
-- audit_items trigger already existed from S52
```

**Files:** `Periods.js`, `Purchases.js`, `AuditLog.js`, `App.js`, `Layout.js`, `AdminClients.js`,
`src/pages/BestSellers.js` (new), `src/pages/VatReport.js` (new)

### S52 — 2026-06-18 — Audit Log (Admin)

New admin-only page `/admin/audit`. Tracks all data changes across clients via PostgreSQL triggers. Filters: Client · Area · Time range. Table: Time · Client · User · Action badge (Added/Updated/Deleted) · Area · Summary. Newest-first, limit 500. Refresh button.

**Tracked tables:** `purchase_entries`, `vendor_returns`, `opening_stock`, `closing_stock`, `wastages`, `monthly_periods` (status changes only).

**Supabase SQL required:**
```sql
-- audit_logs table
CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  client_name text,
  user_id uuid,
  user_name text,
  table_name text NOT NULL,
  action text NOT NULL,
  record_id uuid,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_read" ON audit_logs FOR SELECT
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');
GRANT SELECT ON public.audit_logs TO authenticated;

-- Trigger function
CREATE OR REPLACE FUNCTION log_audit()
RETURNS TRIGGER AS $$
DECLARE
  _client_id uuid; _client_name text; _user_id uuid; _user_name text; _record_id uuid;
BEGIN
  _user_id := auth.uid();
  SELECT full_name INTO _user_name FROM profiles WHERE id = _user_id;
  IF TG_OP = 'DELETE' THEN
    _record_id := OLD.id;
    CASE TG_TABLE_NAME
      WHEN 'purchase_entries' THEN SELECT client_id INTO _client_id FROM monthly_periods WHERE id = OLD.period_id;
      WHEN 'opening_stock'    THEN SELECT client_id INTO _client_id FROM monthly_periods WHERE id = OLD.period_id;
      WHEN 'closing_stock'    THEN SELECT client_id INTO _client_id FROM monthly_periods WHERE id = OLD.period_id;
      WHEN 'wastages'         THEN SELECT client_id INTO _client_id FROM monthly_periods WHERE id = OLD.period_id;
      ELSE _client_id := OLD.client_id;
    END CASE;
  ELSE
    _record_id := NEW.id;
    CASE TG_TABLE_NAME
      WHEN 'purchase_entries' THEN SELECT client_id INTO _client_id FROM monthly_periods WHERE id = NEW.period_id;
      WHEN 'opening_stock'    THEN SELECT client_id INTO _client_id FROM monthly_periods WHERE id = NEW.period_id;
      WHEN 'closing_stock'    THEN SELECT client_id INTO _client_id FROM monthly_periods WHERE id = NEW.period_id;
      WHEN 'wastages'         THEN SELECT client_id INTO _client_id FROM monthly_periods WHERE id = NEW.period_id;
      ELSE _client_id := NEW.client_id;
    END CASE;
  END IF;
  IF TG_TABLE_NAME = 'monthly_periods' AND TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN RETURN NULL; END IF;
  SELECT name INTO _client_name FROM clients WHERE id = _client_id;
  INSERT INTO audit_logs (client_id, client_name, user_id, user_name, table_name, action, record_id, old_data, new_data)
  VALUES (_client_id, _client_name, _user_id, _user_name, TG_TABLE_NAME, TG_OP, _record_id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Triggers
CREATE TRIGGER audit_purchase_entries AFTER INSERT OR UPDATE OR DELETE ON purchase_entries FOR EACH ROW EXECUTE FUNCTION log_audit();
CREATE TRIGGER audit_vendor_returns   AFTER INSERT OR DELETE ON vendor_returns FOR EACH ROW EXECUTE FUNCTION log_audit();
CREATE TRIGGER audit_opening_stock    AFTER INSERT OR UPDATE OR DELETE ON opening_stock FOR EACH ROW EXECUTE FUNCTION log_audit();
CREATE TRIGGER audit_closing_stock    AFTER INSERT OR UPDATE OR DELETE ON closing_stock FOR EACH ROW EXECUTE FUNCTION log_audit();
CREATE TRIGGER audit_wastages         AFTER INSERT OR DELETE ON wastages FOR EACH ROW EXECUTE FUNCTION log_audit();
CREATE TRIGGER audit_monthly_periods  AFTER UPDATE ON monthly_periods FOR EACH ROW EXECUTE FUNCTION log_audit();
```

- **Files:** `src/pages/AuditLog.js` (new), `src/App.js`, `src/components/Layout.js`

### S51 — 2026-06-18 — Budget vs Actual

New page `/budget` (Growth plan, `budget_vs_actual` feature flag). Per-category table: Budget (inline editable, auto-saves on blur), Actual Net Purchases, Variance NPR, Variance %, Status badge (Under/Over/No Budget). Totals row. Budgets stored in new `budgets` Supabase table (upsert on `period_id, category_id`). Wired into sidebar REPORTS, App.js route, AdminClients feature flags.

**Supabase SQL required (run in dashboard):**
```sql
CREATE TABLE IF NOT EXISTS budgets (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  period_id uuid REFERENCES monthly_periods(id) ON DELETE CASCADE,
  category_id uuid REFERENCES categories(id) ON DELETE CASCADE,
  amount numeric DEFAULT 0,
  UNIQUE (period_id, category_id)
);
ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "client_own" ON budgets USING (
  client_id = (SELECT client_id FROM profiles WHERE id = auth.uid())
);
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS budget_vs_actual boolean DEFAULT false;
```

- **Files:** `src/pages/BudgetVsActual.js` (new), `src/App.js`, `src/components/Layout.js`, `src/pages/AdminClients.js`

### S50 — 2026-06-18 — Stock Register: Value Columns + Excel Export

Added NPR value columns and Excel export to the Stock Summary tab.

- **Category stat cards** — expanded from 2 metrics (Opening/Closing) to 4 (Opening Value, Purchases Value, Closing Value, COGS Value) per category
- **Summary table** — added 5 NPR value columns after the existing qty columns: Opening Value, Purchase Value, Wastage Value, Closing Value, COGS (bold gold). Values use `per_uom_rate × qty`; show `—` when rate is zero. Table scrolls horizontally.
- **Export Excel** — button on Summary tab; 15-column xlsx file (`Stock-Register-YYYY-MM.xlsx`) with qty + value pairs for all movements
- No new Supabase queries — `per_uom_rate` already fetched via `items SELECT *`

- **Files:** `src/pages/Stock.js`

### S49 — 2026-06-18 — DB Schema Reference (Memory)

Compiled full column-level schema for all 18 Supabase tables into `memory/db_schema.md`: `clients`, `profiles`, `feature_flags`, `settings`, `categories`, `items`, `vendors`, `monthly_periods`, `purchase_entries`, `vendor_returns`, `opening_stock`, `closing_stock`, `wastages`, `sales_entries`, `recipes`, `recipe_ingredients`, `overheads`, `par_levels`. Includes types, FK relationships, UNIQUE constraints, unit-conversion gotchas (`purchase_entries.qty`/`rate` in base units), upsert patterns, and a SQL run log of all ALTER TABLE migrations since initial deploy. Indexed in `MEMORY.md`.

- **Files:** `memory/db_schema.md`, `memory/MEMORY.md`

### S48 — 2026-06-18 — Unit Conversion Propagation (Purchases)

**Problem:** `conversion_factor` was stored on items but never applied — users had to manually convert before entering quantities (e.g. type 48 LTR instead of 2 CTN).

**Storage convention:** Both qty and rate are stored in base units in `purchase_entries`.
- qty stored = entered_qty × conversion_factor (e.g. 2 CTN × 24 = 48 LTR)
- rate stored = entered_rate ÷ conversion_factor (e.g. NPR 500/CTN ÷ 24 = NPR 20.833/LTR)
- Total = stored_qty × stored_rate = 48 × 20.833 = NPR 1,000 ✓
- All downstream modules (Stock, Variance, FIFO, Reorder) sum `purchase_entries.qty` in base units — **no changes needed there**

**Purchases entry form:**
- Qty label shows `purchase_unit` (e.g. CTN) when conversion exists, `uom` otherwise
- Sub-text under qty input: "= 48 LTR" conversion preview
- Rate label shows "Rate /CTN (NPR)" when conversion exists
- Preview bar: "2 CTN × NPR 500 = 48 LTR" + "Per LTR: NPR 20.8333"
- `save()`: applies `getCf()` helper to convert qty and rate before storing

**Purchases table:**
- Qty column shows purchase units (stored ÷ cf) with base unit sub-text when conversion exists
- Rate column shows per-purchase-unit rate (stored × cf) with per-base-unit sub-text
- Total column (NPR) unchanged — qty × rate in base units = correct value

**Returns form:**
- Qty label shows purchase units when conversion exists
- Max hint shows in purchase units (linked.qty ÷ cf)
- "Original: 2 CTN (48 LTR)" helper text
- "= 48 LTR" conversion preview under input
- Validation: `enteredRetQty × cf ≤ linked.qty` (both in base units)
- `saveReturn()`: stores `returnForm.qty × cf` (base units)
- Purchase dropdown shows purchase unit qty and rate

**Returns table:** displays qty and rate in purchase units (same reconversion logic)

**Dashboard admin bug fix (previous session):** `showAdminDash = isAdmin && !adminViewClientId` — when admin selects a client, client dashboard renders instead of admin platform overview.

- **Files:** `src/pages/Purchases.js`

### S47 — 2026-06-18 — CSS Variable Theme System + Settings Theme Tab

**CSS variable theme engine (ThemeContext)**
- Created `src/context/ThemeContext.js` — two presets (Dark / Light) with full color palettes; custom color override support
- `applyTheme()` sets 18 CSS custom properties on `:root` (`--theme-bg`, `--theme-card`, `--theme-border`, `--theme-accent`, `--theme-sidebar`, etc.)
- Stores in `localStorage` as `{ key: 'dark'|'light'|'custom', colors: {...} }` — persists across reloads
- `switchPreset(key)` — switches full preset; `updateColor(colorKey, value)` — single-color override → sets `themeKey = 'custom'`
- `ThemeProvider` wrapped around entire app in `App.js`

**CSS files rewritten with CSS variables**
- `Layout.css` — full rewrite; `:root` defaults to dark palette; all structural classes use `var(--theme-*)` references
- `Login.css` — full rewrite; login card/inputs/button all CSS-variable driven
- `index.css` body background changed to `var(--theme-bg, #0f1117)`

**Theme tab in Settings**
- `'Theme'` added to `ALL_TABS` in `Settings.js`; tab visible to all users (admin + client)
- **Presets section** — Dark / Light preset buttons with 4-swatch mini palette preview; active preset shows gold checkmark + gold border
- **Customize Colors section** — 10 color pickers (Background, Card/Panel, Border, Sidebar, Primary Text, Secondary Text, Accent/Buttons, Button Text, Success/Green, Danger/Red) using `<input type="color">` native pickers behind a styled swatch div; live hex code displayed beside each row
- **Reset buttons** — "↺ Reset to Dark" / "↺ Reset to Light" buttons below pickers
- **Live Preview section** — shows primary button, ghost button, Active badge, Error badge + a mini table with actual theme colors; updates instantly on any color change
- No Save button needed — ThemeContext auto-saves to localStorage on every change
- Sidebar hard-coded to `--theme-sidebar` dark (navy/charcoal) in both presets so nav stays legible

**Sidebar label fix (previous session)**
- Sidebar client-context label: "Crest Admin" when no client selected (was "— Select property —"), "Viewing" when viewing a client
- `allClients.find(c => c.id === adminViewClientId)?.name || 'Crest Admin'` as dropdown trigger text

- **Files:** `src/context/ThemeContext.js` (new), `src/components/Layout.css`, `src/pages/Login.css`, `src/index.css`, `src/App.js`, `src/pages/Settings.js`, `src/components/Layout.js` + all 21 page files (dark-theme inline colors restored)

### S23 — 2026 (earlier)
- Purchase rate → item master toast (rate-change confirmation after saving a purchase)
- Overhead panel in Recipe detail view (Overhead/Portion, True Cost, True Margin%, Suggested Price)
- Per-recipe `target_fc_pct` field (admin-only, default 30%)
- **Files:** `Purchases.js`, `Recipes.js`

### S24 — 2026 (earlier)
- Periods inline edit for all users on open periods (pencil icon, BS year/month dropdowns, save guarded by `WHERE status='open'`)
- **Files:** `Periods.js`

### S24/S25 — 2026 (earlier) — Vendor Returns System
- Created `vendor_returns` table + RLS in Supabase
- Returns tab in Purchases: purchase-linked, qty validated ≤ original, auto-inherited rate/vendor/payment/bs_day
- Used formula + System Ref Qty updated in Stock to subtract returns
- All 9 affected modules updated: `Purchases.js`, `Stock.js`, `MonthlySummary.js`, `Variance.js`, `PaymentReport.js`, `VendorReport.js`, `Dashboard.js`, `FifoReport.js`, `ReorderReport.js`

### S26 — 2026 (earlier) — Unit Conversion + Supplier Price Tracker Redesign
- Conversion tab added to Items (purchase_unit, base_unit, conversion_factor, live preview badge)
- `purchase_qty` auto-synced from `conversion_factor` on save
- Supplier Price Tracker: replaced sidebar with vendor dropdown, full-width table, Print button, All Vendors option, Category column
- **Files:** `Items.js`, `SupplierPriceTracker.js`

### S27 — 2026 (earlier) — Table Overflow Fix + Collapsible Sidebar
- Fixed buttons clipped off-screen in Item Master table (root causes: flex on td, table width, min-width on main-content)
- Sidebar now collapsible: 220px ↔ 56px (icon-only) with smooth CSS transition, gold toggle button, tooltips on hover
- **Files:** `Items.js`, `Layout.js`, `Layout.css`

### S28 — 2026 (earlier) — Recipes Tab Layout + Decimal Precision
- Replaced stacked tables with tab bar: All Recipes · per-category tabs · ⚙ Sub-Recipes
- Live count badge on each tab; empty-category tabs hidden; Category column hidden on single-category tabs
- All NPR amounts capped at 2 decimal places throughout Recipes.js
- **Files:** `Recipes.js`

### S45 — 2026-06-17 — Admin Drawer Improvements + Pricing Cleanup

**Settings stale data bug fix**
- `SettingsContext.loadSettings()` was merging into previous state with `...prev` — switching clients bleed the previous client's name/logo through
- Fixed: always reset to `DEFAULT_SETTINGS` first, then overlay DB row; `setSettings(data ? { ...DEFAULT_SETTINGS, ...data } : DEFAULT_SETTINGS)`

**AdminClients drawer — Thresholds tab**
- Split Thresholds out of the Settings tab into its own dedicated tab
- Drawer tabs now: Users · Billing · Settings · Thresholds · Feature Access · ⚠ Danger
- Thresholds tab has two sections: Food Cost Thresholds (FC Warning % / FC Critical %) and Alerts (Expiry Warning days / Variance Flag %) each with a short description
- `fetchClientSettings` triggered on both `settings` and `thresholds` tab activation

**AdminClients drawer — Billing tab subscription activation flow**
- Added plan selector (Starter / Growth / Pro) with list price under each button
- Annual rate hint updates live as plan is switched
- `handleSaveSub` now saves `plan` alongside `subscription_ends_at` in one click
- "Start 30-day trial" button hidden when active paid subscription exists (was showing incorrectly for paying clients)
- Full flow: pick plan → set end date (or quick-extend) → Save — all in one tab

**Pricing page + Help page — colour consistency**
- Swapped badge colours: "1 Month Free" badge = gold, "Most Popular" badge = green
- Starter card: ◎ icon + checkmarks + "FREE FOR 1 MONTH" inline text all changed to gold to match badge
- Growth card: ◈ icon + checkmarks changed to green to match badge
- Trial offer corrected: all "3 months free" references updated to "1 month free" (badge, inline label, hero pill, FAQ) in both `Pricing.js` and `Help.js`

- **Files:** `SettingsContext.js`, `AdminClients.js`, `Pricing.js`, `Help.js`

### S46 — 2026-06-17 — Full App Light Theme Redesign

**Motivation:** Graffiti sidebar + dark background felt heavy; replaced with a minimal, elegant light theme inspired by slate blue + bronze accents.

**New palette:**
- Background: `#f7f4f0` (warm off-white) · Card: `#ffffff` · Border: `#ebe4de`
- Sidebar: `#162032` (deep slate navy) — slate blue active states
- Text: `#1c1917` / `#78716c` / `#a8a29e`
- Primary accent: `#4a6fa3` (slate blue) · Secondary: `#9a7c4a` (bronze, replaces gold `#c9a84c`)
- Green: `#16a34a` · Red: `#dc2626` · Amber: `#d97706`

**Changes:**
- `Layout.css` — full rewrite: removed graffiti, warm off-white main content, slate navy sidebar, slate blue active nav states, custom dropdown CSS (`.sidebar-dropdown-*`), card/input/button/table/badge styles all light-theme
- `index.css` — added `background: #f7f4f0` to body
- `Login.css` — full rewrite: white card on warm bg, slate blue submit button, warm form inputs
- `Layout.js` — removed `ADMIN_NAV`, replaced native `<select>` with custom inline dropdown panel (subscription badge per client, click-outside detection via `useRef`)
- **21 page files** — systematic color swap (bare hex + quoted + rgba variants): `Dashboard.js`, `AdminClients.js`, `Items.js`, `Vendors.js`, `Purchases.js`, `Stock.js`, `Sales.js`, `Periods.js`, `Recipes.js`, `MonthlySummary.js`, `Variance.js`, `Settings.js`, `Overheads.js`, `PaymentReport.js`, `VendorReport.js`, `FifoReport.js`, `ReorderReport.js`, `SupplierPriceTracker.js`, `MenuEngineering.js`, `Help.js`, `Pricing.js`
- `Pricing.js` — updated constants (`GOLD`, `GREEN`, `INDIGO`, `BG`, `CARD`, `BORDER`) to new palette; badge text lightened to `#f7f4f0`

- **Files:** `Layout.css`, `index.css`, `Login.css`, `Layout.js` + all 21 page files above

### S31 — 2026-06-17 — Graffiti UI + ESLint Fixes
- **Dashboard graffiti background** — CSS-only spray-paint effect scoped to Dashboard page only via `.dashboard-bg` class
  - 7 layered `radial-gradient` blobs: neon green (top-left), hot pink (top-right), electric cyan (bottom-right), orange (bottom-left), purple (right), yellow (centre), magenta (upper-centre)
  - 52% dark overlay for readability
  - SVG `feTurbulence` fractal noise grain texture (data URI) for spray-can feel
  - Cards go frosted dark glass: `rgba(14,17,26,0.82)` + `backdrop-filter: blur(6px)`
  - Page title gets gold text-shadow glow
  - Applied with `margin: -32px / padding: 32px` to bleed edge-to-edge inside `.main-content`
- **Sidebar graffiti** — same colour family flows into the sidebar as one continuous wall
  - Green top, orange bottom, pink left-edge, purple right-edge, cyan centre
  - 68% dark overlay (heavier than dashboard — nav text must stay crisp)
  - Same SVG grain texture
  - All sidebar borders/dividers updated to `rgba(255,255,255,0.07–0.12)` — graffiti bleeds through
  - `.layout-root` background updated `#0f1117` → `#090909` to match
  - Sidebar text (section labels, role label, brand sub) bumped to `rgba(white, 0.28–0.32)` for legibility
- **ESLint fixes** in `AdminClients.js` and `Dashboard.js`
  - Removed unused `EMPTY_CLIENT` constant (duplicate of `EMPTY_CLIENT_FORM`)
  - Added `eslint-disable` comments on 3 `useEffect` calls with intentionally omitted deps (adding them would cause infinite re-render loops)
- **Files:** `Layout.css`, `Dashboard.js`, `AdminClients.js`

### S30 — 2026-06-17 — 3-Tier Plan System (Starter / Growth / Pro)
- Implemented full 3-tier plan system replacing the old Basic/Premium binary
- **DB:** `ALTER TABLE clients ADD COLUMN plan text CHECK('starter','growth','pro') DEFAULT 'starter'` + `trial_ends_at timestamptz`. Migration: `UPDATE clients SET plan = 'pro' WHERE is_premium = true`
- **AuthContext.js:** Loads `plan` + `trial_ends_at` from clients table. `hasFeature(key)` now checks plan tier (GROWTH_KEYS / PRO_KEYS sets) before falling back to feature flag overrides. Exposes `plan`, `isTrialing`, `trialEndsAt`. `isPremium` = plan !== 'starter' (backward compat). Fallback: reads `is_premium` for pre-migration rows.
- **PremiumGate.js:** Added `minPlan` prop ('growth'|'pro', default 'growth'). Plan rank comparison. Gate message now says "Growth Plan Required" or "Pro Plan Required" with tier-appropriate description.
- **App.js:** All 12 gated routes tagged with explicit `minPlan` — Growth routes: sales/recipes/variance/summary/payments/reorder; Pro routes: menu-engineering/fifo/vendors-report/supplier-prices/overheads/settings
- **Layout.js:** `renderNavItem` now uses `hasFeature()` from AuthContext (replaces `isAdmin||isPremium||isFeatureEnabled`). Locked items show a "G" or "P" tier badge. Sidebar property label shows plan name (Starter/Growth/Pro) in plan colour. Nav items annotated with `minPlan`.
- **AdminClients.js:** Replaced Basic/Premium toggle button with a plan `<select>` dropdown (Starter/Growth/Pro) in table. Drawer Feature Access tab: added 3-button plan selector (Starter/Growth/Pro) with active highlight. Updated plan badge in drawer header. Feature Access warning updated to show plan-specific message.
- **Files:** `AuthContext.js`, `PremiumGate.js`, `App.js`, `Layout.js`, `AdminClients.js`

### S29 — 2026-06-17 — 3-Tier Pricing & Landing Page
- Designed 3-tier packaging: Starter / Growth / Pro with bargaining headroom in list prices
  - Starter: NPR 8,000/mo list (NPR 5,000/mo annual) — 3-month free trial
  - Growth: NPR 18,000/mo list (NPR 10,000/mo annual)
  - Pro: NPR 25,000/mo list (NPR 15,000/mo annual)
- Created `Pricing.js` — standalone public landing page at `/pricing` (no auth required)
  - Sticky nav with logo + Login button
  - Monthly/Annual billing toggle ("Save up to 40%" badge)
  - 3 plan cards with tier-additive feature lists and CTA buttons
  - FAQ section (6 questions tailored to Nepal F&B market)
  - Footer CTA with email link
- Added Pricing tab to `Help.js` — compact plan comparison for logged-in users
  - Billing toggle, 3 plan cards, contact bar (pulls phone/email/website from Settings → Contact)
  - "View full pricing page →" link to `/pricing`
- Added public `/pricing` route to `App.js`
- **Files:** `src/pages/Pricing.js` (new), `src/pages/Help.js`, `src/App.js`

### S44 — 2026-06-17 — Admin Dashboard Revenue Table + Logo Upload + Branding Sync

**Revenue & Billing table on admin dashboard**
- New table above Client Health table showing per-client billing breakdown
- Columns: Property, Plan badge, Monthly Value (NPR — only for paying clients), Billing Type (Subscription/Trial/Expired/No billing), Expires (BS month + year), Subscription badge
- Total row at bottom sums MRR from paying clients only (trial clients excluded)
- MRR calculation fixed: only counts clients with active `subscription_ends_at` (not trial)
- `adToBs()` imported in Dashboard.js to convert ISO expiry dates to BS month names
- Dashboard now re-fetches on every navigation (`location.key` dependency) — fixes stale data after subscription changes

**Logo upload system**
- Supabase Storage bucket `Logos` (public) with 4 RLS policies (INSERT/SELECT/UPDATE/DELETE for authenticated)
- `logo_url text` column added to `settings` table
- Settings → Branding tab: 80×80 preview box, file picker (PNG/JPG/SVG/WebP, max 2MB), Remove button
- Upload path: `Logos/{clientId}/logo.{ext}` for clients, `Logos/admin/logo.{ext}` for admin global
- Sidebar (`Layout.js`): shows `<img>` when `settings.logo_url` is set, falls back to `⬡` hex icon
- Preview box in Settings also shows live logo image

**Branding sync fixes**
- `SettingsContext.js`: when admin is viewing a client (`clientId` set), loads/saves that client's settings instead of global admin settings — fixes admin seeing "Crest Inventory" when editing client branding
- `AdminClients.js` `saveClientEdit()`: when client name is changed, auto-updates `settings.app_name` to match
- `AdminClients.js` `createClient()`: seeds a `settings` row with `app_name = client name` on creation

**Admin sidebar reorder**
- Clients and Settings links moved to top of sidebar (below Dashboard) for admin users
- Divider separates them from main operational nav (Periods, Items, Vendors, etc.)
- Client users: Settings remains in original position after Reports

**Billing tab additions**
- "Start 30-day trial" button appears when no trial is set (fixes existing clients with no `trial_ends_at`)
- "Cancel subscription" button inline in Paid Subscription box — confirm dialog explains fallback behavior
- After cancel: `subscription_ends_at = null`, client falls back to trial or gets auto-deactivated

**ESLint cleanup (end of session)**
- Removed logo upload state (`logoUploading`, `logoMsg`) and functions (`handleLogoUpload`, `handleLogoRemove`) from `Settings.js` entirely — logo is now admin-only via AdminClients drawer
- Removed unused `ADMIN_NAV` constant from `Layout.js` (was orphaned after sidebar reorder moved Clients link inline)
- Client users see read-only branding panel (logo + name + tagline + "Contact your consultant" note) before the tab bar

- **Files:** `Dashboard.js`, `Settings.js`, `SettingsContext.js`, `AdminClients.js`, `Layout.js`
- **SQL run:** `ALTER TABLE settings ADD COLUMN IF NOT EXISTS logo_url text;`
- **Storage:** Supabase bucket `Logos` (public) + 4 RLS policies created

### S43 — 2026-06-17 — Admin Platform Dashboard

**Admin dashboard completely replaced** — when logged in as admin, Dashboard shows a platform health overview instead of single-client financial data.

**Platform KPI row (4 cards):**
- Active Properties — count active vs inactive vs total
- Expiring Soon — count of active clients with subscription/trial ≤ 30 days (amber border when > 0)
- No Open Period — count of active clients with no open BS period (red border when > 0)
- Est. Monthly Revenue — sum of plan list prices for paying clients only (NPR)

**Client Health table:**
- Columns: Property (+ location), Plan badge, Subscription badge (from getSubStatus), Current Period (name + Open/Closed/⚠ No period yet), Status badge, Actions
- Sorted: clients with issues first (expiring or no open period), then healthy active, then inactive
- Row click → `switchAdminClient()` — sets sidebar to that property so admin can browse their data on other pages
- "Periods" button → switch to client + navigate to Periods page
- "Manage →" button → navigate to /admin/clients
- Inactive rows dimmed to 45% opacity

**Client financial dashboard unchanged** — client users see the existing Net Purchases / Revenue / Food Cost etc. view. Admin never sees that view on Dashboard.
- **Files:** `Dashboard.js`

### S42 — 2026-06-17 — Subscription Timer & Auto-Deactivation

**SQL required:** `ALTER TABLE clients ADD COLUMN IF NOT EXISTS subscription_ends_at timestamptz;`

**Subscription badge in Clients table**
- New "Expires" column shows a colored badge per client: green (>30 days), amber (≤30 days), red (≤7 days or expired), gold (trial · X days), gray (no date set)
- `getSubStatus(client)` helper — prefers `subscription_ends_at`, falls back to `trial_ends_at`
- `SubBadge` component renders the badge inline

**Billing tab in client drawer**
- Shows free trial end date + days remaining/expired
- Shows paid subscription status with current expiry
- Date picker to set `subscription_ends_at` manually
- Quick-extend buttons: +1 Month, +3 Months, +1 Year from today
- Clear button to remove the subscription date
- Saves directly to `clients.subscription_ends_at`

**Auto-deactivation on page load**
- `loadClients()` checks all active clients after fetching
- Auto-sets `is_active = false` if: subscription expired OR (no subscription + trial expired)
- Reloads client list after deactivating — no manual step needed

**New client defaults**
- `createClient()` now sets `trial_ends_at = today + 30 days` automatically (1-month free trial, down from 3 months)

- **Files:** `AdminClients.js`, `AuthContext.js`, `Layout.js`, `Dashboard.js`, `utils/subscription.js` (new)

**Subscription visible to client users**
- **Sidebar** — small badge under property name, always visible: `Trial · 28d` (gold), `47d left` (green), `12d left` (amber), `3d left` / `Expired` (red)
- **Dashboard banner** — only shown when ≤ 7 days remaining or already expired: "Your trial expires in 3 days — contact your consultant to renew"
- `getSubStatus(client)` extracted to `src/utils/subscription.js` — shared across AdminClients, Layout, Dashboard

### S41 — 2026-06-17 — Auto-Period Management + Expired Period Banner

**Auto-create period on client creation**
- `AdminClients.js` — `createClient()` now uses `.select('id').single()` to capture the new client's ID after insert
- After insert, calls `getBsToday()` from `bsCalendar.js` utility to get the current BS year/month and immediately inserts an `open` period into `monthly_periods` for the new client
- Uses the exact BS calendar lookup table (not an approximation)

**Close & Start Next Month button**
- `Periods.js` — replaced "Close Period" button with "Close & Start Next Month" for open periods (admin only)
- `closeAndAdvance(period)` — confirms with admin (shows month names), closes the current period, then inserts the next BS month as a new `open` period
- Handles BS year rollover: Chaitra (12) → Baisakh (1) of the next BS year
- Duplicate conflict ignored silently
- Edit (pencil) button restricted to admin only — clients don't need to change period BS dates

**Expired period banner on Dashboard**
- `Dashboard.js` — after each data load, compares open period's BS month against `getBsToday()` to detect if the period month has passed
- **Client users**: see amber banner "Ashadh 2083 has ended" with action button "End Ashadh & Start Shrawan →" — closes period and opens the next one immediately, then reloads stats
- **Admin**: sees same banner info-only (text only, no button) — "go to Periods to close and advance for this property"
- Grace period built-in: banner appears only after the month ends, not at midnight on the last day. Client can finish stock count on the 1st/2nd with the period still open
- **Files:** `AdminClients.js`, `Periods.js`, `Dashboard.js`, `utils/bsCalendar.js` (now shared)

### S33 — 2026-06-17 — Vendor Codes, Search Improvements, ESLint Fixes

- **Vendors — Inactive badge** changed from gray to red (`badge-gray` → `badge-red`) for deactivated suppliers
- **Vendor codes** added (format: VND-001) matching Item Master pattern
  - `vendor_code` column added to vendors table (run: `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS vendor_code text`)
  - `getNextVendorCode()` auto-increments on new vendor insert, reads prefix from Settings
  - Code column added to Vendors table in gold monospace
- **Settings — Vendor Codes tab** added (between Item Codes and Contact)
  - Code prefix input (default `VND`) with live preview
  - Regenerate All Vendor Codes button — renumbers all vendors alphabetically
- **Vendor Purchase Report — search field** added above view tabs
  - Filters by vendor name or vendor code in real time
  - Shows match count when active; vendor code shown in gold monospace in Summary table
  - Daily Breakdown columns also narrow to matched vendors
- **Item Master search** now matches item code as well as item name; placeholder updated to "Search by name or code…"
- **Tab labels** — long category names (>13 chars) abbreviated in tab bar: "Kitchen Production" → "Kitchen Prod."
- **Item Master column headers** shortened: "Purchase Qty" → "Purch. Qty", "Per UOM Rate" → "/ UOM"
- **ESLint fixes** — `eslint-disable-line` added to `useEffect` calls in `Periods.js`, `VendorReport.js`, `Vendors.js`
- **Files:** `Vendors.js`, `Settings.js`, `VendorReport.js`, `Items.js`, `Periods.js`

### S32 — 2026-06-17 — Item Master: Category Filter → Tab Bar
- Replaced `<select>` category dropdown in Item Master with a tab bar matching the Recipe Costing pattern
- Tabs: "All Items" + one tab per category that has at least one item (empty categories hidden)
- Each tab shows a live count badge (respects the current search filter)
- Category column (`<th>` and `<td>`) is hidden when a single category tab is selected, shown on "All Items"
- Search input moved above the tab bar (no longer inline with the dropdown)
- Tab bar connects flush to the card below (card top corners flattened to 0)
- **Files:** `src/pages/Items.js`

### S40 — 2026-06-17 — Admin/Client Role Separation + Settings Cleanup

**Admin/client profile separation**
- Admin profile `client_id` set to `NULL` in Supabase (`UPDATE profiles SET client_id = NULL WHERE role = 'admin'`) — pure consultant account, no property affiliation
- Admin uses sidebar dropdown to switch between any client; client users stay locked to their own property

**Client switcher persistence fix (localStorage)**
- `AuthContext.js` — `adminViewClientId`/`adminViewClientName` now initialized from `localStorage` (`crest_admin_client_id`, `crest_admin_client_name`)
- `switchAdminClient()` writes to localStorage on every change; `signOut()` clears both keys
- Fixes: token refresh (Supabase re-fires `onAuthStateChange` on tab focus) was resetting the selection to null on every window switch

**Pages not loading data after client switch**
- Root bug: `Items.js`, `Vendors.js`, `Periods.js` were computing `clientId = profile?.client_id` locally instead of using AuthContext's exported `clientId`; `profile.client_id = NULL` now for admin so all three showed empty data
- Fix: all three now destructure `clientId` directly from `useAuth()` and use `[clientId]` as the `useEffect` dep array

**Settings page — client vs admin separation**
- `Contact` tab hidden for client users (admin-only: consultant phone/email for upgrade prompts)
- `Danger Zone` card hidden for client users in the Data tab; admin alert updated to point to Admin → Clients → ⚠ Danger
- Branding tab: heading/label/placeholders now say "Property Branding / Property Name / e.g. Casa Acai Cafe" for client users instead of "App Branding / Crest Inventory"
- `SettingsContext.js` — `loadSettings(cid)` and `saveSettings` now client-aware: admin always targets `client_id = NULL` (global), clients load/save their own `client_id` row — no more cross-client contamination when a client saves settings
- `DEFAULT_SETTINGS` — added `vendor_code_prefix: 'VND'` and `sub_recipe_code_prefix: 'SRC'` so Vendor Codes and Sub-Recipe Codes tabs show the default prefix as a value (not faint placeholder), matching Item Codes behaviour
- **Files:** `AuthContext.js`, `SettingsContext.js`, `Settings.js`, `Items.js`, `Vendors.js`, `Periods.js`

### S39 — 2026-06-17 — Admin Client Switcher + Dashboard Property Name

- **AuthContext.js** — added `adminViewClientId` / `adminViewClientName` state + `switchAdminClient(id, name)` function
  - `clientId` export now returns `adminViewClientId` when admin (instead of always returning the admin's own `profile.client_id`)
  - Initialized from `profile.client_id` / `profile.clients.name` on login
  - All pages automatically pick up the switched client via `effectiveClientId = clientId || profile?.client_id`
- **Layout.js** — admin "Viewing" section in sidebar replaced static "Consultant" label with a live `<select>` dropdown
  - Fetches all clients (`id, name`) from Supabase on mount (admin only)
  - On change: calls `switchAdminClient()` — instantly switches all pages to that client's data
- **Dashboard.js** — subtitle now shows the selected property name instead of "Consultant view"
  - Admin: `{adminViewClientName} · {period} · Open`
  - Client: `{profile.clients.name} · {period} · Open`
- **Files:** `AuthContext.js`, `Layout.js`, `Dashboard.js`

### S38 — 2026-06-17 — Admin: Delete Client Data (Danger Zone)

**New Danger Zone tab in ClientDrawer (AdminClients.js)**
- 4th tab labelled "⚠ Danger" — styled red; resets on tab switch
- **Two-step destruction guard:**
  1. Admin types the property name exactly (case-sensitive, must match `client.name`)
  2. Admin enters their login password — verified via `supabase.auth.signInWithPassword()` (session stays active; just re-validates credentials)
  3. On both checks passing: calls edge function `deleteClientData` and shows green confirmation
- **Edge function `admin-user-ops` updated** — new `deleteClientData` action (requires admin JWT like other actions):
  - Fetches all `monthly_periods.id` for the client
  - Deletes period-keyed tables in order: `purchase_entries`, `vendor_returns`, `opening_stock`, `closing_stock`, `wastages`, `sales_entries`
  - Fetches all `recipes.id` for the client → deletes `recipe_ingredients`
  - Deletes client-keyed tables: `overheads`, `par_levels`, `monthly_periods`, `recipes`, `items`, `vendors`, `categories`
  - **Preserved:** `clients`, `profiles`, `feature_flags`, `settings` — client record + users + config intact
- **⚠ Redeploy edge function** after this session (paste updated `supabase/functions/admin-user-ops/index.ts` into Supabase Dashboard → Edge Functions → Open Editor)
- **Files:** `src/pages/AdminClients.js`, `supabase/functions/admin-user-ops/index.ts`

### S37 — 2026-06-17 — Security Fix: Service Role Key + Edge Function + RLS Audit

**Security issue fixed: `REACT_APP_SUPABASE_SERVICE_ROLE_KEY` removed from frontend bundle**
- Created `supabase/functions/admin-user-ops/index.ts` — Supabase Edge Function (Deno/TypeScript)
  - Handles 3 auth-admin operations: `getUser`, `createUser`, `deleteUser`
  - Verifies caller has `role = 'admin'` in profiles table using their JWT before executing
  - Uses `SUPABASE_SERVICE_ROLE_KEY` from Deno.env (auto-injected server-side, never in bundle)
- `AdminClients.js` rewritten to call the edge function via `supabase.functions.invoke('admin-user-ops', { body: { action, ...params } })`
  - Removed `createClient` import, removed `const supabaseAdmin = createClient(...)`, removed `REACT_APP_SUPABASE_SERVICE_ROLE_KEY` usage
  - Added `adminOp(action, params)` helper that calls the function and throws on error
  - All 3 call sites updated: `loadUsers`, `createUser`, `deleteUser`

**Edge function deployed ✓** — `admin-user-ops` live on Supabase Dashboard → Edge Functions (deployed via browser editor 2026-06-17).

**RLS audit SQL**: `supabase/rls-audit.sql`
- Run Section 1 in Supabase Dashboard → SQL Editor to check RLS status on all 18 tables
- Section 2 lists all active policies
- Sections 3–4 have corrective SQL if any table shows "RLS OFF"
- Tables: clients, profiles, feature_flags, settings, categories, items, vendors, monthly_periods, purchase_entries, vendor_returns, opening_stock, closing_stock, wastages, sales_entries, recipes, recipe_ingredients, overheads, par_levels

**RLS audit result (confirmed clean 2026-06-17):**
- 18/18 tables have RLS ON
- 3 security holes fixed: `feature_flags` (2 policies had `USING(true)`), `monthly_periods` (`periods_all` had `USING(true)`), `profiles` (`profiles_select_own` had `USING(true)`) — all exposed cross-client data to any authenticated user
- Zero `USING(true)` policies remain; verified with `SELECT ... WHERE qual = 'true'` returning 0 rows
- `{public}` role policies are safe — `my_client_id()` and `is_admin()` both call `auth.uid()` which returns NULL for anon, blocking unauthenticated access

- **Files:** `supabase/functions/admin-user-ops/index.ts` (new), `supabase/rls-audit.sql` (new), `AdminClients.js`

### S36 — 2026-06-17 — Full Codebase Bug Audit & Cleanup

Audited all 30 source files. Build is now `0 warnings`.

**Real bugs fixed:**
- `Recipes.js` — 2 dead state declarations removed (`overheadPerPortion` with eslint-disable, `setFilterCat` replaced with constant `'all'`); unused `rErr` destructure removed; stale `// clientId removed` comment removed
- `SettingsContext.js` — `isPremium` removed from `loadFeatureFlags` useEffect dep array (it was causing unnecessary re-fetches on login; the effect doesn't use `isPremium`)
- `SupplierPriceTracker.js` — added `eslint-disable-line` on line 32 useEffect (missing `init` dep that would cause infinite loop if added)

**False positives (verified & cleared):**
- `AuthContext.js` `data.clients = client` — intentional mutation of profile object before `setProfile()`; correct
- `Purchases.js` freshItem null guard — already present at line 183 (`if (freshItem)`)
- `Stock.js` delete+upsert — paths are mutually exclusive (`if qty <= 0 delete; else upsert`); correct
- All `[clientId]` dep arrays across pages — intentionally narrowed to avoid infinite re-render loops; eslint-disable already in place

**Security note (not fixed — requires architectural change):**
- `AdminClients.js` uses `REACT_APP_SUPABASE_SERVICE_ROLE_KEY` via `createClient()` on the frontend. This key is visible in the browser bundle. Proper fix = Supabase Edge Function for admin user creation. Left as-is since this page is admin-only and the risk is accepted for now.

- **Files:** `Recipes.js`, `SettingsContext.js`, `SupplierPriceTracker.js`

### S35 — 2026-06-17 — Overheads Redesign (3-Tab P&L + Break-Even)

**SQL run:** `ALTER TABLE overheads ADD COLUMN IF NOT EXISTS bucket text DEFAULT 'overhead'`

**Overheads.js — complete rebuild**
- 3-tab entry: **Fixed Overheads** (Rent, Utilities, Tech, Marketing, Insurance, Misc) · **Labor Costs** (Manager, Kitchen, Service, Part-time, Benefits) · **Tax & Fees** (VAT, Card Processing, Bank Charges, License, Accountant)
- Each row saved with `bucket = 'overhead' | 'labor' | 'tax_fees'`
- Preset category dropdowns per tab with context-aware placeholders; "+ Add Row" for custom entries
- KPI cards (5): Fixed Overheads total + % rev · Labor total + % rev · Tax & Fees total + % rev · Total Fixed Costs + % rev · Daily Fixed Cost (÷30); all with Tip tooltips
- **P&L Summary panel**: 5-row breakdown (Food Cost / Labor / Overhead / Tax & Fees / Net Profit) each with traffic-light % vs target bar, actual NPR amount, and target %. Revenue + COGS derived from sales_entries × recipe prices + net purchases. Net profit callout card (green/red).
- **Break-Even panel**: Need (Revenue + Covers) vs Actual (Revenue + Covers). Formula: Total Fixed ÷ (1 − FC%). Green border above break-even, red below. Shows NPR gap.
- **Cost per Cover panel**: Fixed OH / Labor / Tax / Total per cover. "Every sale must earn X just to keep the lights on."
- Footer note explains overhead-per-portion allocation (only Fixed Overheads, not labor/tax, go into recipe costing)
- Locked-period guard: shows red banner, disables all inputs + save

**Dashboard.js** — "Overheads % of Revenue" KPI renamed to **"Fixed Costs % of Revenue"**; tooltip updated; threshold now ≤50% green / ≤65% yellow / >65% red (was 20/30 — wrong for total fixed costs)

**Recipes.js** — Overhead allocation query now filters `.eq('bucket', 'overhead')` so labor and tax rows don't inflate the overhead-per-portion in recipe costing
- **Files:** `Overheads.js`, `Dashboard.js`, `Recipes.js`

### S34 — 2026-06-17 — Menu Engineering Fix + Tooltip System + Reorder Clear All

**Menu Engineering fix**
- Root bug: recipes query selected `total_cost` which is not a DB column → Supabase returned `null` → early return fired → 0 items shown
- Fixed: removed `total_cost` from SELECT; removed `.eq('is_active', true)` (replaced with `.neq('is_active', false)` to include NULL rows); added `clientId` guard to `loadData` useEffect
- Ingredient cost calculation already correct after previous session's `qty` → `qty_per_portion` fix
- **Files:** `MenuEngineering.js`

**Shared Tip tooltip component**
- Created `src/components/Tip.js` — reusable hover tooltip (dark card, dashed underline, `width` prop)
- Uses `createPortal` to render into `document.body` — escapes all `overflow: hidden/auto` containers (table wrappers, etc.)
- Positions via `getBoundingClientRect()` + `position: fixed` so it never gets clipped
- Replaced inline `Tip` function in `MenuEngineering.js` with shared import
- Added tooltips to high-priority jargon across 6 pages:
  - **Dashboard:** Food Cost %, Target 28–35%, Overheads % of Revenue, Over-used column, Value at Risk column
  - **MonthlySummary:** COGS stat card, Cost of Goods Used box, Food Cost % box, Purchase-Based FC% box, Net Purchases / COGS / % of Total COGS column headers
  - **Variance:** Flagged Items, Total Variance Value, Data Coverage stat cards; Actual Used, Theoretical, Variance column headers
  - **ReorderReport:** Par Level, Source, Shortfall column headers
  - **Stock:** ★ column, System Ref Qty column (print sheet); Used column (summary tab)
  - **FifoReport:** FIFO title, Expiring Soon, Value at Risk stat cards; Net Qty column header
- Also added tooltips to Menu Engineering legend: FC% cutoff, Volume cutoff median, Period
- **Files:** `src/components/Tip.js` (new), `MenuEngineering.js`, `Dashboard.js`, `MonthlySummary.js`, `Variance.js`, `ReorderReport.js`, `Stock.js`, `FifoReport.js`

**Reorder Report — Clear All Par button**
- Moved "Reset Par Levels" button from page header to filter bar (right-aligned, more visible)
- Renamed to "✕ Clear All Par" for clarity; prompts before deleting
- **Files:** `ReorderReport.js`

**ESLint fixes**
- `eslint-disable-line react-hooks/exhaustive-deps` added to `useEffect` in: `MonthlySummary.js`, `Variance.js`, `FifoReport.js`, `ReorderReport.js`, `Stock.js`, `PaymentReport.js`
- **Pending SQL** (run in Supabase if not already done):
  - `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS vendor_code text;`
  - `ALTER TABLE recipes ADD COLUMN IF NOT EXISTS recipe_code text;`
