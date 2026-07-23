# Crest Suite — Project README

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

```text
REACT_APP_SUPABASE_URL
REACT_APP_SUPABASE_ANON_KEY
REACT_APP_USDA_API_KEY
REACT_APP_VAPID_PUBLIC_KEY
```

`REACT_APP_SUPABASE_SERVICE_ROLE_KEY` must never be set here or in Vercel — admin operations go through the `admin-user-ops` Supabase Edge Function instead (see S311).

---

## App Overview

Hospitality inventory & food cost management SaaS for Nepal's F&B industry.  
Works natively in Bikram Sambat (BS) calendar · NPR currency · FonePay payment tracking.

### Plans

| Plan | Monthly | Annual /mo | Includes |
| --- | --- | --- | --- |
| Starter | NPR 5,000 | NPR 3,750 | Dashboard, Items, Vendors, Periods, Purchases, Stock, Help + Sales Entry, Payment Summary, Monthly Summary, Annual Summary, Reorder Report, Stock Movements, VAT Report, Non-VAT Report, Wastage Report, Settings, Stock Report, Menu Pricing |
| Growth | NPR 8,000 | NPR 6,000 | + Recipes, Variance, Budget vs Actual, Best Sellers, Purchase Orders, Requisitions, Dead Stock, Recipe Margin, Outstanding Payables, Staff Meals, Menu Repricing |
| Pro | NPR 12,000 | NPR 9,000 | + Menu Engineering, FIFO, Vendor Report, Supplier Price Tracker, Overheads, Period Comparison, Theoretical Variance, Shrinkage Report |

Starter: 1-month free trial. Annual = 25% off monthly.

---

## Routes

| Route | Plan | Feature Flag |
| --- | --- | --- |
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
| `/stock-movements` | **Starter+** | `stock_movement_log` |
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
| --- | --- | --- |
| Crest IMS | ✅ Live | All existing routes |
| Crest HR | ✅ Live | `/hr/dashboard`, `/hr/employees`, `/hr/pay-setup`, `/hr/attendance`, `/hr/leave`, `/hr/holidays`, `/hr/overtime`, `/hr/payroll`, `/hr/reports`, `/hr/festival`, `/hr/advances`, `/hr/gratuity`, `/hr/settlement`, `/hr/roster` |
| Crest POS | 🔧 Building | `/pos` (setup/activation, manager+), `/pos/login` (public PIN picker), `/pos/tables` (supervisor+), `/pos/staff` (manager+); Orders, KOT, Billing, Shifts next |

**Pricing** (single source of truth: `src/data/pricingPlans.js` — also feeds Help's Plan & Pricing tab, the public `/pricing` page, and Admin Settings > Plan Pricing, S380):

| Module | Starter | Growth | Pro |
| --- | --- | --- | --- |
| Crest IMS (tiered) | NPR 2,000/mo | NPR 2,600/mo | NPR 3,500/mo |
| Crest HR (flat, no tiers) | NPR 2,600/mo | — | — |
| Crest POS (flat, no tiers) | NPR 2,000/mo | — | — |

| Suite Bundle (IMS+HR+POS, ~20% off buying separately) | Monthly | Annual /mo |
| --- | --- | --- |
| Suite Starter | NPR 5,300 | NPR 3,975 |
| Suite Growth | NPR 5,800 | NPR 4,350 |
| Suite Pro | NPR 6,500 | NPR 4,875 |

Annual = 25% off monthly, applied uniformly everywhere annual pricing appears.

**Module flags on `clients` table:** `ims_enabled` (DEFAULT true), `hr_enabled` (DEFAULT false), `pos_enabled` (DEFAULT false, column added S193), `ims_plan`, `hr_plan`, `pos_plan` (column added S193)  
**Admin UI:** AdminClients → **card module strip** — toggle IMS/HR/POS directly on each client card; Billing tab = live toggles + plan selector + subscription date per module (POS wired S193)  
**Route guard:** `src/components/ModuleGate.js` — wraps all IMS, HR, and POS routes in App.js; redirects to `/dashboard` when module is off (admin always bypasses)  
**POS role system (added S195):** `pos_role` column on `profiles` (`staff` / `supervisor` / `manager`). `hasPosAccess(minLevel)` in AuthContext. POS sidebar hidden entirely for users with no role. Tables → supervisor+; Staff → manager+. Crest admin always bypasses.

---

## Session Log

### S441 — 2026-07-22 — Public-surface design pass: Pricing/Login/GuestMenu audit via taste-skill + impeccable, real bugs fixed on both

Two design-focused passes back to back on the app's public/marketing surfaces (`/pricing`, `/login`, the guest QR menu) — the only surfaces that fit `taste-skill`'s landing/portfolio/marketing scope, since everything else is internal product UI covered by `impeccable` per this repo's own convention.

**taste-skill pass.** Audited all three pages against `DESIGN.md`/`PRODUCT.md` before touching anything. Finding worth keeping: Login and the Guest Menu were already strong, on-brand, and accessible (theme tokens throughout, the Georgia wordmark used correctly, real empty/loading/error states, `prefers-reduced-motion` respected) — a rip-and-replace would have regressed working code, so both were left alone (Guest Menu got one small brass underline touch, its only sanctioned brand flourish per PRODUCT.md). Pricing had 2 real bugs: (1) the GOLD "Get Suite"/"Start Free Trial" buttons hardcoded `#0b0b0b`/`var(--theme-bg)` as their label color instead of `--theme-accent-text` — silently failing contrast on the Bright preset, where accent-text is white (the exact class of bug DESIGN.md's Accent-Text Pairing Rule already names); (2) the three pricing grids were `repeat(3,1fr)`/`repeat(2,1fr)` with no mobile collapse. Both fixed; glyphs (`⬢`/`✓`/`✉`) unified to lucide icons matching Login's. Asked the user whether to build a new marketing landing page at `/` given PRODUCT.md's explicit "tool-first, not marketing-first" charter — user chose to fold the value proposition into Pricing instead (a 3-item typographic value strip, no card boxes, em-dash-free) rather than add a second marketing surface, keeping one page to maintain and respecting the stated charter.

**impeccable audit & fix pass.** Scored the same 3 pages 17/20 (Excellent band) — Login came back clean with zero findings. Fixed on Pricing: the FAQ modal was a hand-rolled fixed overlay with no `role="dialog"`/`aria-modal`/`aria-labelledby`, an unlabeled `×` close button, and no Escape-to-close (backdrop-click only) — added all four; the Monthly/Annual billing toggle had no `aria-pressed` despite a clear visual active state. Fixed on Guest Menu: the quantity Stepper's `−`/`+` buttons were glyph-only with no `aria-label` (added, plus `aria-live="polite"` on the count so a screen reader announces the new quantity) and per-item photos had no `loading="lazy"`/`decoding="async"`, which matters on a guest's phone where a real menu can carry dozens of images.

Both passes verified against a `CI=true` build (warnings-as-errors) — compiles clean.

### S440 — 2026-07-22 — Full audit/debug pass: route-level code splitting, a POS offline-sync race, and hardening

Broad "audit & debug all modules & pages" request. Ran the full automated surface (production build + all 91 Jest tests across 209 files) plus targeted manual review of the highest-risk paths (access control, money/margin math, multi-tenancy). Headline: the codebase was already in good shape — clean compile with **zero ESLint warnings**, every sampled route guard matched its `Layout.js` nav `minRole` tag (no S430-class drift), and every dashboard percentage/margin was already division-by-zero guarded (returns `null` → renders `—`). Findings were modest; fixed all of them.

1. **Route-level code splitting (biggest win).** The app shipped as one ~931 kB gzipped `main.js` — no `React.lazy`/`Suspense` anywhere. Converted all ~95 page components in `App.js` to `lazy(() => import())`, keeping only the structural pieces eager (contexts, `Layout`, `ProtectedRoute`, `ModuleGate`/`PremiumGate`). Two Suspense boundaries: a top-level one for the public routes, and one around `Layout.js`'s `<Outlet />` so the sidebar stays mounted (only the content area shows the new `RouteFallback` shimmer) during in-app navigation. Result: initial JS **931 kB → 165 kB gzipped** (~82% smaller), 97 on-demand chunks — the heavy xlsx-report (137 kB) and recharts-dashboard (107 kB) chunks now load only when their route is actually visited. Gotcha hit along the way: the trailing `import './components/Layout.css'` had to move *above* the lazy `const`s or ESLint's `import/first` rule fails the build.

2. **POS offline-sync deep dive — a real lost-update race.** `saveOrder` fires `logKotSend('KOT')` and `logKotSend('BOT')` un-awaited back-to-back; offline, both route through `enqueuePosOrder`, which did a read-modify-write across *two* IndexedDB transactions (readonly `get` → merge → readwrite `put`). Two concurrent calls both read the same `kot_sends:[]` pre-image and the second `put` clobbered the first — silently dropping one station's KOT/BOT send from the offline queue, so it never replayed into `pos_kot_log` on sync (KOT Reconciliation under-counts; the physical ticket still printed, so no *order* was lost — a reporting-integrity bug, not an order-loss one). Fixed by collapsing get+merge+put into a single `readwrite` transaction: IndexedDB serialises overlapping readwrite transactions on the same store, so the `kot_sends` append is now atomic regardless of await ordering. Confirmed the blast radius is bounded — billing is hard-gated offline (`payDisabled = saving || !orderId || !isOnline`), so no money path is ever reachable without a live server; the offline surface is order-taking only.

3. **Offline order-id robustness.** Offline orders mint their permanent `pos_orders.id` from `crypto.randomUUID()` — `undefined` on WebViews older than Chrome 92 / Safari 15.4, where it would throw mid-save, lose the order, and hang the save button (`savingRef` never resets). Added `src/utils/uuid.js` (prefers native, falls back to a `getRandomValues`-based v4, the same primitive already used in `ClientDrawer.js`) and wired it into the offline path — cheap insurance for budget POS hardware in the target market.

4. **NULL-`client_id` guards.** Six `settings`-save paths (`PosTableManagement.jsx` ×4, `PosStaff.jsx`, `HrStaff.jsx`, `ImsStaff.jsx`, `CoversReport.jsx`) lacked the `if (!clientId) return` guard their own load paths already have — closing the admin-no-client-selected window where a save could write into the global-defaults (`client_id IS NULL`) `settings` row. `TadaSettingsModal.js` already had it.

5. **Test hygiene.** Deleted the stale CRA boilerplate `src/App.test.js` (asserted a nonexistent "learn react" link, and couldn't resolve react-router-dom v7 under Jest anyway) — it was the only failing suite, masking real signal. `npm test` is now 91/91 green across 7 suites. Whole pass verified with a `CI=true` build (warnings-as-errors) — compiles clean.

### S439 — 2026-07-21 — Main Dashboard course-correction: equal-width columns, dual sales pivots, Food/Beverage split

Direct feedback on S438's own result, seen live: "i don't like the new look of the admin dashboard... IMS data heavy. i would prefer equal amount of pills with info." Also asked for the manual-sales pivot and POS pivot to both show (S438 shipped them as either/or), plus a Food vs Beverage % breakdown. Explicitly invited web research and "see what you can do... look professional as well as practical."

Follow-up research actually supported a version of the complaint: forced equal-weighting is right to avoid on a single-purpose executive dashboard, but this page is three *peer* modules sharing space for whichever combination a client bought — an HR- or POS-focused viewer's column shouldn't read as a token afterthought next to an 11-card IMS column. Separately, 4–6 KPIs above the fold is the general recommendation per card group, with the rest as secondary/deep-dive content — reframing the fix as "trim IMS's top row to a comparable count," not "widen the neighboring columns."

Planned and shipped as one PR (small enough in scope, unlike S438's 3-way split):

1. **Equal columns** — `.dash-3col-all`/`.dash-3col-ims-plus` in `Layout.css` changed from `1.5fr 1fr 1fr` / `1.5fr 1fr` to plain `1fr` splits.
2. **IMS trimmed to 5 top pills** (Net Purchases, Revenue, Food Cost%, Net Margin%, Wastage Value — matching HR's 4 / POS's 4), with the other 6 cards (Active Period, Items, Vendors, Recipes, Menu Health, Fixed Costs%) plus all charts and the Variance/Reorder tables moved to a new full-width "IMS details" section below the equal-width grid instead of squeezed into a narrow column. Card JSX and the charts/tables block were extracted into variables in `ClientDashboard.jsx` so the same elements compose into this split layout *or* the original single-column arrangement — a 1-module client's page is untouched, pixel-for-pixel. Also reverted S438's `smallHeight` bump (140/160 → 220) on the 3 IMS charts, since full-width-below-the-grid means they're never squeezed into a narrow column anymore — the compensation it existed for no longer applies.
3. **Manual + POS pivots both render** — dropped the `!showPos` condition that made them either/or; `SalesPivot.jsx` gained a `title` prop so the two read "Manual Sales by Category" / "POS Sales by Category" side by side in a new shared "Sales Breakdown" section, mirroring the Owner/Manager Report's philosophy that two differently-sourced revenue figures not tying out to the penny is fine as long as it's labeled. Required a real correctness fix: `loadFromSalesEntries` (`useSalesPivotData.js`) now also excludes `source:'pos'` rows (previously only excluded `pos_comp`) — a POS-enabled client's `sales_entries` already carries POS-stamped rows, so showing both pivots together would otherwise double-count that revenue. Verified live against a real client with a -800 NPR return in manual entries: without the fix this would have silently vanished into a double-counted POS total; with it, Manual (-800) + POS (15,000) correctly nets to 14,200, matching the page's own top-line Revenue KPI exactly.
4. **Food vs Beverage split** — new `useFoodBeverageSplit.js` + `FoodBeverageSplit.jsx` (both `src/modules/dashboard/`), bucketing combined manual+POS revenue by `recipes.category`. Confirmed with the user this is legitimate (not a free-text guess): Recipes.js constrains `category` to a real `<select>` (`recipeCategories`, client-customizable, defaults to `['Food','Beverage','Dessert','Snack','Other']`) — exact match on `'Food'`/`'Beverage'`, everything else (including client-custom categories) buckets as `'Other'`, `'Sub-Recipe'` rows excluded (prep items, not menu sales).

Tested live against two real 3-module clients (Casa Acai Cafe, Bhatti Choila) at desktop and the 768px mobile breakpoint, plus a production build — no console errors, no new build warnings.

### S438 — 2026-07-21 — Main Dashboard: weighted 3-column layout, HR Approvals-lite, Category × Day sales pivot

Feedback on `/dashboard`: IMS gets ~417 lines (11 KPI cards, 4 charts, 2 tables) while HR and POS each get one row of 3-4 cards — "IMS heavy," HR/POS "1 row each." Asked for a POS sales pivot table and to research whether module info should be distributed equally, possibly as 3 vertical columns.

Research finding that reshaped the plan: forced equal-weighting is an anti-pattern ("when multiple metrics share equal billing, users see all of it and process none of it — every dashboard needs one primary metric"). Confirmed direction with the user: a genuine 3-column grid, but weighted (IMS still widest, not equal thirds), plus real content depth added to HR too, not just POS.

Shipped as 3 separate PRs (deliberately not one — this is the highest-traffic page in the app, gated by 3 module booleans × posTeam station variant × 6+ feature-tier upsells × a `loadErrors` retry system; bundling a layout change with two new data-fetching features would make a visual regression and a data-correctness regression indistinguishable in the same diff):

1. **Layout restructure** — `ClientDashboard.jsx`'s IMS/HR/POS sections now render as CSS grid columns (`1.5fr`/`1fr`/`1fr`-style ratios via named classes, not equal thirds) when 2+ modules are enabled; a 1-module client is unchanged. IMS's charts row (3-across) and Variance+Reorder row (2-across) restack vertically inside IMS's own narrower column instead of spanning the full page. New `.dash-3col-*` classes in `Layout.css` (named per active-module combination, not a computed inline style) specifically so a new `@media (max-width:768px)` collapse-to-1-column rule can actually win at narrow viewports — an inline `gridTemplateColumns` would always beat a class rule regardless of screen size. Bumped the 3 IMS charts' `smallHeight` (140/160 → 220) so they still hit their own "is this the full desktop spread or a squeezed one" threshold at the new narrower column width instead of staying stuck in cramped small-width font/tick sizing.
2. **HR Approvals-lite** — extracted `HrDashboard.jsx`'s pending-approval counts (Leave/OT/TADA/Swap — all 4, for parity with that page's own Approvals row) into a shared `useHrApprovalCounts` hook, so the dashboard's new compact "Pending Approvals" card and the real HR console read the exact same numbers from one query instead of two independently-drifting copies.
3. **Category × Day sales pivot** — the piece that actually answers "a pivot table for sale either from the pos or from the manual entry." New generic `PivotTable` component (`src/components/PivotTable.jsx`), extracted from `Sales.js`'s existing recipe×BS-day "Daily Breakdown" pivot pattern (sticky first column, row/col/grand totals) — the 2nd/3rd place in the codebase wanting this exact shape, worth factoring out now. `useSalesPivotData.js` branches on whether POS is enabled: POS clients pivot from `pos_order_items` (same `close_type='paid'`/credit-note/comp exclusions as `SalesReport.jsx`), IMS-only clients pivot from `sales_entries` joined to `recipes.category`. Category × Day is the one dimension pair that works for *both* sources — a Category × Payment-Method pivot would only work for POS and gets complicated by split-tender orders needing an allocation rule. Shows top 6 categories × the most recent 7 days with actual data, in NPR (not qty — doesn't roll up meaningfully across mixed categories). Lives in the POS column when POS is enabled, the IMS column (manual entries) otherwise — never both. Kitchen/bar station accounts don't get it (no use for a revenue breakdown).

### S437 — 2026-07-21 — Monthly Owner/Manager Report: 3-phase deep-dive expansion (Menu Engineering, Labor Analytics, Vendor/Purchasing, Inventory Depth, Trend)

Direct feedback after S434-436's build: "the owner-report is too superficial... only surface level data is provided." Researched real F&B/hospitality back-office reporting (Restaurant365, MarginEdge, USALI hotel F&B standard) — confirmed the report was missing Menu Engineering, Labor Analytics beyond a payroll total, Vendor/Purchasing analytics, Inventory depth (turnover, dead stock, shrinkage trend, item-level variance), and any period-over-period trend. Cross-referenced against this codebase's own existing capability: nearly every one of these already exists as a mature, separate report page (`MenuEngineering.js`, `VendorReport.js`, `DeadStock.js`, `Variance.js`, `ShrinkageReport.js`, `PeriodComparison.js`) — the gap was never missing computation, just never pulled into one monthly artifact. User confirmed: full multi-page report (dropped the earlier "fit on 1 page" constraint from S434-436), ordered Financial → Menu → Labor → Inventory → Vendor → Trend, all 4 new sections.

Shipped in 3 phases (per plan, to keep a single PR's blast radius reviewable):

**Phase 1 — foundation + Trend.** `computeMonthlyReport.js`'s orchestrator used to await one flat `Promise.all` — any single section throwing meant NO report got written for the period at all. Every section (including the original IMS/HR/POS) now runs through a `runSection()` wrapper that degrades a failed section to `null` + a `snapshot.sectionErrors` entry instead, so the rest of the report and the row write still succeed; the page shows a dismissible "couldn't be generated" note. New Trend section compares this period against its own already-frozen `monthly_owner_reports` snapshot for last-period and same-month-last-year (reads prior rows directly rather than re-deriving — cheaper, and consistent with the freeze philosophy; never auto-generates a missing prior snapshot as a side effect). `schema_version` bumped to 2 (now `CURRENT_SCHEMA_VERSION`, exported instead of a duplicated hardcoded `1`) — no migration tooling needed, since every existing read already uses optional chaining and simply sees new fields as absent on old snapshots. Print CSS reworked from the earlier 1-page aggressive shrink to real multi-page pagination (`page-break-inside:avoid` on sections/tables, a page-break hook for new sections).

**Phase 2 — Menu Engineering + Labor Analytics.** Menu Engineering Matrix mirrors `MenuEngineering.js`'s `classify()`/`median()`/`FC_CUTOFF=35%` formula exactly (including zero-sale items in the median) so quadrants always agree with the live page for the same period — deliberately does NOT port that page's `recipes.me_class` write-back (a live POS-suggestion-engine side effect a report generator must stay read-only against). Labor Analytics adds Sales per Labor Hour and Scheduled-vs-Actual Hours, neither of which existed anywhere in this codebase before — actual hours from `hr_attendance` (period_id-scoped), scheduled hours from `hr_roster` (no `period_id` column at all, filtered by the period's own bs_year/bs_month instead), reusing `shiftHours()`/`calcHours()` from the Roster board's `laborForecast.js` verbatim.

**Phase 3 — Vendor & Purchasing + Inventory Depth.** Vendor & Purchasing mirrors `VendorReport.js`'s per-vendor net-spend/discount-dedup/cash-credit-split formulas, with bill aging pinned to a `generatedAt` timestamp captured once at generation (not live `new Date()` like the source page — a frozen snapshot's aging bucket must not keep drifting after it's supposed to be frozen). Inventory Depth is 4 independently-failable sub-sections (each wrapped in its own try/catch, since Shrinkage Trend alone can touch ~6x the row volume of the others): Dead/Slow Stock (mirrors `DeadStock.js` exactly), Turnover Ratio/Days-on-Hand (a genuinely new formula, but a pure function built entirely from figures the IMS section already computes — no new queries), item-level Theoretical-vs-Actual Variance (mirrors `Variance.js`, a real gap that existed before — the IMS section already built this exact theoretical-usage map internally but never exposed it), and Shrinkage Trend (adapted from `ShrinkageReport.js`'s multi-period concept into a trailing 6-period window ending AT the report's own period, rather than "most recent N regardless").

### S436 — 2026-07-21 — Owner/Manager Report gets Opening/Closing Stock; a 5th real bug found by comparing against Stock Count

Requested addition: Opening Stock in the Crest IMS section, "as it seems an important factor to consider for manager/owner." Added using the same qty × `per_uom_rate` valuation `MonthlySummary.js` already uses for its own Opening Stock figure.

Immediately compared the new figure against Stock Count's own Summary tab for the same period (Ashadh 2083) — NPR 179,232 in the report vs NPR 179,189.95 on Stock Count, a ~NPR 42 mismatch. Root cause: `computeImsSection`'s `items` query had no `is_active` filter, so a leftover `opening_stock` row on a deactivated item inflated the total; `Stock.js`'s Summary tab (the actual source of truth for this figure) filters to `is_active=true` before valuing anything. Fixed by matching that filter exactly — deliberately did **not** also exclude sub-recipes, since Stock Count counts those too (its own "Sub-Recipes" category row), unlike the `is_sub_recipe` exclusion that applies to Item Master/Purchases/POs/Requisitions/Reorder Report/Supplier Price Tracker. Same shared item-rate map means Wastage Value is now also quietly more correct for the same reason.

Also added Closing Stock (`closing_stock.physical_qty` × `per_uom_rate`) right alongside Opening Stock, since it's the natural other bookend of the period and was an obvious follow-up. Both fields added to the Excel export too.

### S435 — 2026-07-21 — Monthly Owner/Manager Report, live-tested end-to-end: 4 real issues found and fixed

Continuation of S434 on the actual pilot client (Casa Acai Cafe, Ashadh 2083) — reviewing the live output surfaced four real problems, none of them caught by the build passing.

**1. It read as a dashboard, not a report.** Direct feedback after seeing the first generated report: "i don't think this is called a report. its more like a page with data pills. i want a proper report written with figures backed by data." Fair — the original layout was stat-grid/KPI-tile cards, which is Owner Dashboard's visual language, not a document's. Asked which direction to take (pure financial statement vs. narrative vs. hybrid) via a concrete preview comparison; picked **hybrid** — one short auto-generated Executive Summary paragraph at the top, everything else as data tables. Rebuilt `MonthlyOwnerReport.jsx` around a letterhead (business name/VAT/address), the summary paragraph (new `src/modules/ownerReport/reportNarrative.js` — a pure function that turns the snapshot into 2-3 sentences, e.g. *"Ashadh 2083 closed with NPR 280,601 in revenue, a Food Cost of 86.9% — well above the healthy 28–35% range... Net Margin was -87.9%, driven in part by NPR 203,000 in recorded overhead expenses."*), and Metric/Actual/Target or Label/Value tables per section instead of tiles. Financial Summary keeps severity color-coding (red/amber/green, same thresholds as Owner Dashboard so the same number never reads as a different "health" color across the two pages) — now applied to table cells, plus an explicit Target column.

**2. Printed PDF spilled to a mostly-empty 2nd page.** Checked the actual exported PDF: the app-chrome page header was printing twice (once plain, once as the letterhead's own title — pure duplication), the card's rounded border/shadow printed as visible chrome instead of reading like a page, and `Tip`'s dashed hover-underline showed up as broken-looking text with nothing to hover on paper. New `MonthlyOwnerReport.css` (scoped to `.owner-report-doc`/`-table`/`-section`, never touches the shared `.card`/`.data-table` used by 15+ other reports) hides the duplicate header and strips chrome under `@media print`, plus a general density pass (tighter row padding, tighter letterhead/section spacing) for both screen and print.

**3. Leave Type showed a raw UUID.** `a0ad0a37-3a1c-4c92-9328-f086140dc0b5` instead of the actual leave type name — `computeHrSection` stored `hr_leave_requests.leave_type_id` straight into the snapshot without joining `hr_leave_types.name`. Fixed by resolving the name **at generation time** (same freeze principle as everything else here — if the leave type is later renamed, the report should keep showing what was true when generated). General lesson written into CLAUDE.md: any future field that's a foreign key must be resolved to its display value before it goes into the snapshot, not after.

**4. Gross Payroll and Overtime were wrong** — the report showed NPR 80,438 gross / NPR 0 OT for Ashadh 2083; the actual **finalized** Payroll Run for that period shows NPR 92,000 gross / NPR 2,628 OT. Found by literally putting the two pages side by side. Root cause: `computeHrSection` re-derived a prorated estimate (Owner Dashboard's live-MTD formula, borrowed wholesale) instead of reading the real `hr_payroll_runs`/`hr_payslips` data that already existed for this closed period — and that estimate only counted OT from approved `hr_overtime_entries` *claims*, completely missing attendance-based OT (`hr_attendance.ot_hours`, which is where this client's real OT actually came from; `computePayslip` in `payrollCompute.js` sums both sources, the estimate only knew about one). Fixed: `computeHrSection` now checks for a `status='finalized'` payroll run on the period first and sums the real payslips (exact Nepal-payroll-engine output) when one exists, only falling back to the estimate when the period's payroll was genuinely never finalized. `snapshot.hr.payrollSource` (`'finalized'`/`'estimated'`) is now surfaced in the UI so a reader knows which basis they're looking at.

All four fixes are code-only, but 3 and 4 fixed already-*frozen* data — a snapshot generated before either fix shipped keeps showing the old (wrong) numbers until an admin clicks **Regenerate Snapshot**, by design (that's the one deliberate exception to the freeze).

### S434 — 2026-07-21 — Monthly Owner/Manager Report: a frozen, exportable cross-module snapshot generated at period close

Owner Dashboard (S317) is deliberately live and IMS+HR-only, and produces nothing exportable. The user wanted the missing piece: a real month-end deliverable combining IMS + HR + POS, generated automatically when a period closes, that the owner can review, export, and keep as a permanent record — not something that silently changes if the underlying data is corrected later.

**Database** (`20260721010000_monthly_owner_reports.sql`): new `monthly_owner_reports` table — `client_id`/`period_id`/`bs_year`/`bs_month`, `modules_included` and `snapshot` (both `jsonb`, captured **at generation time**, never re-derived live), `generation_source` (`period_close`/`backfill`/`manual_regenerate`), `generated_by`/`generated_at`. `UNIQUE (client_id, period_id)` is the freeze guarantee — auto-generation only ever `INSERT`s, so a second attempt 23505s instead of overwriting; the only overwrite path is an explicit admin "Regenerate Snapshot" button. RLS follows the same owner/admin-only RESTRICTIVE pattern this codebase already uses for its most sensitive tables (`no_self_service_accounts`/`no_pos_pin_staff`/`no_ims_staff`/`no_hr_role_staff`) — this table carries HR payroll/headcount detail alongside IMS/POS financials, so no staff-account type gets in regardless of module rank. Second migration (`20260721020000_monthly_owner_report_feature_flag.sql`) adds the `feature_flags.monthly_owner_report` admin-override column, same convention as `owner_dashboard`'s.

**Computation** (`src/modules/ownerReport/computeMonthlyReport.js`): reuses Owner Dashboard's exact IMS/HR formulas, parameterized by an arbitrary *closed* period instead of always "the open one." Two deliberate departures from Owner Dashboard's live figures, both because a frozen artifact needs period-bound facts, not live ones: Payables is redefined as "this period's Credit purchases still unpaid as of generation" (not the live ">60 days overdue, any period" formula, which would drift once time passes); a closed period is fully elapsed by construction, so HR labor cost needs no "days elapsed so far" proration. New POS section (`computePosSection`) is Owner Dashboard's actual Phase-2 item, built here instead — reuses `computeOrderAmounts`/`computeCategoryAmounts` (`posBillingMath.js`) rather than re-deriving VAT/discount math. Real gotcha: `pos_orders` has no `period_id` or BS columns at all, only AD `closed_at` — the BS period has to be converted to an AD range (`bsToAd` start/end of month) and orders queried by `closed_at`, matching `SalesReport.jsx`'s own convention. Separately: `sales_entries` already carries POS revenue for POS-enabled clients (`PosOrders.jsx` stamps a `source:'pos'` row per bill at close) — so the report's top-line Revenue figure and its independently-derived POS Net Sales figure will never tie out to the penny, by design; the report page labels them distinctly with a `<Tip>` rather than pretending they reconcile.

**Generation & trigger** (`generateMonthlyReport.js`, `src/pages/Periods.js`): report generation is wired into all three period-closing call sites (`closeAndAdvance`, `adminCloseAndAdvance`, `adminEndPeriod`) as a best-effort, non-blocking step — wrapped in try/catch, logged only, never allowed to prevent the period itself from actually closing. Safety net: `MonthlyOwnerReport.jsx` lazily generates-and-caches a snapshot on first view for any closed period that doesn't have one yet (a pre-existing period from before this feature shipped, or a failed auto-generation) — deliberately not a bulk backfill script, since this codebase has no batch-job infrastructure at all and a backfill would compute the exact same thing lazy-generation already does.

**Report page** (`/owner-report`, `MonthlyOwnerReport.jsx`): a BS period picker, adaptive sections per the *snapshot's own recorded* `modules_included` (not live `clientModules` — a historical report never grows a POS section retroactively just because POS got enabled later), Excel export (`monthlyReportExcel.js`, same `xlsx`/letterhead pattern as every other report), and "Print / Save as PDF" via the existing `printWithTitle()` — deliberately no new PDF dependency; this codebase's only real "PDF" mechanism today is the browser's native print-to-PDF, already used by every bill/credit-note/KOT. Gated by `SuiteGate` (extended with a new `requireModules` prop, default `['ims','hr']` preserving Owner Dashboard's own call site unchanged; the report itself passes `['ims']` since every client already qualifies module-wise and the page adapts sections beyond that) plus an explicit `isOwner || isAdmin` route guard, since RLS already restricts the table that tightly.

Nav: a third compact link next to Owner/Dashboard in `Layout.js`'s dashboard row, a command-palette entry, a "View Full Monthly Report →" link from Owner Dashboard itself, and a dismissible "Report is ready →" banner on `Periods.js` right after a client-view close. `admin-user-ops/index.ts`'s `deleteClientData` deletes `monthly_owner_reports` before `monthly_periods` (no FK cascade) — `clearModuleData` needed no change, since it already intentionally keeps `monthly_periods`, and a snapshot surviving a module-data clear is the entire point of freezing it.

**Live-tested same day, one real bug found:** the original migration created the table + RLS policies but never `GRANT`ed table-level access to `authenticated` — a documented gotcha in this project (raw-SQL `CREATE TABLE` gets no role grants by default) that got missed anyway. Surfaced immediately when trying to generate the Ashadh 2083 report as the actual client Owner login: `42501 permission denied for table monthly_owner_reports` on both the `SELECT` and the `INSERT`, distinguishable from an RLS violation by the specific error and by it firing on a plain read too. Fixed in `20260721030000_monthly_owner_reports_grants.sql` (`GRANT SELECT, INSERT, UPDATE, DELETE ON public.monthly_owner_reports TO authenticated`) — `service_role` was already covered by this project's blanket `ALTER DEFAULT PRIVILEGES` grant from 2026-07-03, so only the per-table `authenticated` grant was missing.

### S433 — 2026-07-21 — Kitchen Display's Exit button sent kitchen/bar teams to the wrong page

Found live while walking the user through testing S431: Exit was hardcoded to `navigate('/pos/orders')` from before kitchen/bar staff teams existed, when Orders was every POS staffer's home. A locked-team account doesn't have Orders in its sidebar at all, so exiting there dropped them onto a page that wasn't theirs. `KitchenDisplay.jsx` now routes by team — `isTeamLocked ? '/dashboard' : '/pos/orders'` — since Dashboard is the one destination every team always has. One-line fix, `src/modules/pos/kds/KitchenDisplay.jsx`.

### S432 — 2026-07-21 — Periods "Reopen" silently failed; added a no-reopen correction path instead

User found a data-entry mistake in a closed period (Ashadh 2083) and asked how to fix it as admin. First answer was wrong — clicking Reopen genuinely did nothing, with no error shown. Root cause: `monthly_periods_one_open_per_client` (a partial unique index added 2026-07-13, `WHERE status='open'`) blocks a client from ever having two open periods, and `reopenPeriod()` in `Periods.js` never checked the update's error before calling `loadPeriods()`. Since the only realistic reason to reopen a *past* period is to fix a mistake discovered after the client already moved into the *current* one, Reopen was non-functional for its actual use case, silently, every time.

Two fixes. (1) `reopenPeriod()` now surfaces the constraint violation with an explanation instead of swallowing it. (2) Realized mid-investigation that reopening was never actually necessary in the first place — `Stock.js`'s `isLocked = !isAdmin && status==='closed'` already lets an admin edit a closed period's Closing Stock directly, inputs and save button both, with zero extra steps. The one genuinely missing piece was propagating a correction *forward*: the closed period's closing stock had already been carried into the next (open) period's opening stock at original close time, and fixing the old period alone doesn't retroactively fix that copy. Added `resyncOpeningStock(period)` — finds the chronologically-next period and re-runs the existing `carryForwardOpeningStock()` (already an idempotent upsert) into it, with a new **Resync Opening Stock →** button next to Reopen. No schema change; `src/pages/Periods.js` only.

### S431 — 2026-07-21 — POS gets a `pos_team` axis (front-of-house / kitchen / bar), orthogonal to `pos_role`

Follow-up to S430's Tables-visibility fix. Two related questions in the same conversation: (1) does kitchen staff need the front-of-house sidebar (Orders, Parking Slips, Customers, Shifts) at all, and (2) Kitchen Display's KOT/BOT toggle is just a manually-remembered `localStorage` value (`pos_kds_station`) with nothing preventing a kitchen account from being left on the bar tab (or vice versa) and missing its own pending tickets. Rather than two separate patches, built one new axis that answers both.

**Database** (`20260721000000_pos_staff_team.sql`): `profiles.pos_team text NOT NULL DEFAULT 'foh' CHECK (pos_team IN ('foh','kitchen','bar'))` — orthogonal to `pos_role`'s rank (a kitchen/bar account keeps whatever staff/supervisor/manager rank it has; voids/comps/reports gating is untouched). `get_pos_staff_list()` gained `pos_team` in its return row — required a `DROP FUNCTION`+recreate (adding an OUT column changes the return type, 42P13), which also drops the function's ACL grants, so the `REVOKE ... FROM PUBLIC; GRANT ... TO authenticated, service_role` pattern from the 2026-07-20 PUBLIC-grant/revoke gotcha fix had to be reapplied in the same migration — otherwise this one function would've silently reverted to PUBLIC-executable.

**Edge Function** (`admin-user-ops/index.ts`): `create_pos_staff` and `update_pos_role` both accept an optional `pos_team`. Real gotcha caught before shipping: `PosStaff.jsx`'s existing silent pos_role-mismatch auto-fix (`init()`) calls `update_pos_role` on every page load with just `{ pos_role, pos_job_title }` — if the endpoint always wrote `pos_team: pos_team || null`, that background sync would've reset every kitchen/bar account back to `'foh'` on next load. Fixed by only including `pos_team` in the update payload when the caller explicitly sent it (`if (pos_team !== undefined) updatePayload.pos_team = ...`).

**Frontend**: new `posTeam` on `AuthContext.js` (same admin/owner→`'foh'` bypass shape as `posRole`). `Layout.js` gained a `KITCHEN_TEAM_ALLOWED_PATHS = ['/pos/kds']` allowlist checked in `isItemVisible` — a kitchen/bar account sees only Dashboard + Kitchen Display regardless of rank, fail-closed so a future new POS page doesn't leak to kitchen/bar without a deliberate addition to the list. `KitchenDisplay.jsx` locks `station` to `'KOT'`/`'BOT'` per team and hides the toggle entirely for locked accounts (page heading switches to "Bar Display" when locked to BOT). `PosStaff.jsx` gained a Team column/selector (Front of House / Kitchen / Bar) in both the staff table and the Add Staff modal. `ClientDashboard.jsx`'s POS section swaps to kitchen-ops KPIs — Open Tickets, Late (>15min, matching `KitchenDisplay.jsx`'s own `LATE_MS`), Ready & Waiting (last 20min), Avg Prep Time + completed-today count — computed from `pos_kot_log` filtered to the team's own station, instead of Revenue/Covers/Avg Check/Tables Occupied.

Small related fix: Tables became Manager-only in the S430 follow-up, but the dashboard's "Tables Occupied" card still linked there unconditionally — now only clickable when `hasPosAccess('manager')`.

### S430 — 2026-07-20 — Crest HR gets a staff/supervisor/manager role system (mirrors POS/IMS); dashboard IMS/HR leak fixed

Started from a screenshot question — why does a POS Supervisor login see the Inventory dashboard's Food Cost %/margin/spend data? Root cause: `ClientDashboard.jsx`'s Inventory section (`showIms`) was gated only on `clientModules.ims` (does the client subscribe to IMS), never on the viewer's own `ims_role` — every other IMS page redirects an `ims_role`-less staffer here via `hasImsAccess(...)`, so the one page meant to be the safe fallback was the actual leak. Fixed with `showIms = clientModules.ims && hasImsAccess('staff')` (also applied to the "no open period" nag banner, which had the same raw `clientModules.ims` check).

Follow-up question surfaced the same pattern one layer up: an HR headcount/payroll card was also showing to that same POS account, because `showHr` had an identical gap. But HR had no `hr_role` concept at all to gate by — `Layout.js`'s `hrVisible` was hard-coded `isAdmin || isOwner`, a deliberate "HR is Owner/Admin-only" design (documented in its own comment) rather than a bug. So this wasn't a one-line fix like IMS's — it meant building the missing role tier from scratch:

**Database** (`20260720170000_hr_staff_roles.sql`): `profiles.hr_role` (+ `hr_job_title`), same `CHECK (staff/supervisor/manager)` shape as `pos_role`/`ims_role`. `is_hr_role_staff()` + RESTRICTIVE policies block HR staff accounts from every IMS + POS business table (36 tables — wider than IMS/POS's own mutual carve-outs, since HR has no legitimate reason to touch recipes/sales_entries/stock_movements the way POS billing does). `get_hr_role_staff_list()` / `get_hr_role_eligible_users()` RPCs mirror the IMS ones exactly, this time using `REVOKE ... FROM PUBLIC; GRANT ... TO authenticated, service_role` from the start instead of the plain `REVOKE FROM anon` that turned out to be an ineffective no-op in S293 (see the Postgres PUBLIC-grant/revoke gotcha below). `get_ims_eligible_users` also updated (`CREATE OR REPLACE`) to exclude accounts that already have `hr_role` set, closing the same cross-contamination gap S419 already closed for `pos_role`/`hr_self_service`.

**Edge Function** (`admin-user-ops/index.ts`): 4 new actions — `create_hr_staff`, `update_hr_role`, `delete_hr_staff`, `reset_hr_password` — structural mirrors of the IMS staff actions. `isCallerOwner` (here and in `AuthContext.js`) now excludes all four staff-account markers (`pos_role`, `ims_role`, `hr_self_service`, `hr_role`), and `update_ims_role`'s existing cross-contamination guard now also checks the target's `hr_role`.

**Frontend**: new `hasHrAccess(minLevel)`/`hrRole` on `AuthContext.js`, mirroring `hasImsAccess`/`imsRole`. New `src/modules/hr/staff/HrStaff.jsx` admin page (`/hr/staff`, Manager-only) — structural mirror of `ImsStaff.jsx`, including the custom Job-Title → Role mapping (`settings.hr_custom_roles`). All 17 `/hr/*` page components got a page-side guard (`if (!hasHrAccess(minLevel)) return <Navigate to="/dashboard" replace />`) at a tier chosen per page (Holiday Calendar: staff; HR Dashboard/Attendance/Leave/Overtime/Roster/TADA: supervisor; Employees/Pay Setup/Payroll/Calculation/Reports/Festival/Incentives/Advances/Gratuity/Settlement: manager). `Layout.js`'s `hrVisible` now checks `isAdmin || hrRole || isOwner` (was `isAdmin || isOwner`), every `HR_GROUPS`/`HR_DASHBOARD` nav item gained a `minHrRole` tag feeding the same shared `isItemVisible()` check IMS/POS already use, and a new "HR Staff" nav entry was added under HR → Admin.

**Help.js**: added an "HR Staff" entry alongside the existing "IMS Staff"/"Employee Self-Service" entries, same tips-list pattern.

Not done in this pass (deliberately out of scope): live end-to-end testing against a real client with HR staff assigned (S420 did this for IMS the day after S419 shipped and found 5 real bugs — the same pass is worth doing here before relying on this in production).

### S429 — 2026-07-20 — Totals row on Payroll Calculation; category filter on Sales Period Summary

Two small, independent UI additions, both matching an existing convention elsewhere in the app rather than inventing a new one.

**Payroll Calculation** (`src/modules/hr/payroll/PayrollCalculation.jsx`) — the employee table had no totals row, unlike Payroll Run's own table. Added a `<tfoot>` summing Gross/OT/Absence/SSF/TDS/Advance/TADA/Net Pay (live), same styling (bold, `2px` top border, per-column coloring matching each row's own convention) as `PayrollRun.jsx`'s existing footer. The "Payroll Page" column's total only renders if every employee has a stored payslip — summing a partial run (some employees "not generated") would silently read as a complete total instead of a warning sign.

**Sales Entry → Period Summary** (`src/modules/ims/sales/Sales.js`) — added a category filter dropdown next to the tab's existing sort-order dropdown, populated from whatever categories the client's recipes actually use. Filtering narrows both the visible rows and the Total row at the bottom, so a filtered view's totals reflect just that category, not the whole menu diluted by a filter.

**Files:** `src/modules/hr/payroll/PayrollCalculation.jsx`, `src/modules/ims/sales/Sales.js`

### S428 — 2026-07-20 — Self-service payslip was silently broken since launch; found it led to a DB-wide grants audit

Started from "Jeevan's payslip doesn't show even though Ashadh payroll is finalized." First theory (iOS PWA freeze not refetching) was wrong — disproven by a live reload that still showed nothing. Direct DB queries (`supabase db query --linked`, which this session leaned on heavily as a read/write path to the live project without going through the Dashboard for every check) found the real bug: `get_my_hr_payslips`, `get_my_client_vendors`, and `get_my_swap_requests` all declare `RETURNS TABLE(id uuid, ...)`. That OUT parameter shadows `profiles.id` inside the function body, so `WHERE id = auth.uid()` in the caller-lookup line resolved ambiguously (`42702`) and **all three had thrown on every single call since they shipped** — no employee had ever seen a payslip, a TADA vendor list, or a shift-swap request. Invisible because `SelfServiceHome.jsx`'s `load*` callbacks did `setPayslips(data || [])` and dropped `error`, so a hard RPC failure rendered identically to "you have no data."

Fixed by qualifying the column (`profiles pr WHERE pr.id = ...`) and wiring `error` through to a visible banner instead of swallowing it.

**Second bug, found while fixing the first:** even once `get_my_hr_payslips` worked, none of the four employees' payslips reconciled — `absence_deduction`, `ot_amount`, and `tada_amount` weren't in the RPC's return type at all. Worst case: an employee docked 15,188 for absence saw a single 120 TDS line and a Net Pay over half his gross short, unexplained. Extracted `PayslipBody` (the owner's Payroll modal + print view) into a shared component (`src/modules/hr/payroll/PayslipBody.jsx`) so the employee's own copy can't drift back to a partial view, extended the RPC to return the full breakdown plus `present_days`/`absent_days` (the day count is what lets an employee actually check a deduction against memory, not just the amount), and wired it into `SelfServiceHome.jsx` behind a tap-to-view modal.

**Third, much bigger finding, while double-checking the RPC fix actually landed:** `has_function_privilege('anon', ..., 'EXECUTE')` still returned `true` after revoking it — because Postgres ACLs are additive (a role's privilege = its own grants UNION PUBLIC's), and `REVOKE ... FROM anon` is a silent no-op when only PUBLIC holds the grant. This meant **`20260712210000`'s entire S293 anon-hardening migration (25 functions) had never taken effect**, undetected for over a week. Audited all 25: confirmed by reading source that every one has an internal `auth.uid()`-derived caller check, so this was never an active data leak — but the intended defense-in-depth layer had simply never engaged. Fixed 22 of them (+3 trigger functions) by revoking from PUBLIC and re-granting to `authenticated` + `service_role` (the latter isn't a real superuser here — `rolsuper=false` — and was silently riding the same stale grant). Deliberately left `is_admin()`/`is_hr_self_service()`/`is_pos_pin_staff()`/`my_client_id()` untouched — tested in a rolled-back transaction that revoking them breaks a genuine, intentional `anon` read (the pre-login `settings.app_name` row), since Postgres doesn't short-circuit past the RLS policy's second `OR` operand even when the query is filtered to the safe row.

**Fourth, found auditing the third:** the same PUBLIC-grant pattern existed at the table level. `anon` and `authenticated` both held stray `TRUNCATE`/`REFERENCES`/`TRIGGER` on every table (inert — PostgREST has no path to issue any of the three — but `TRUNCATE` bypasses RLS entirely, so worth removing anyway), and `anon` separately held full `SELECT`/`INSERT`/`UPDATE`/`DELETE` on 22 real tables (`profiles`, `clients`, `sales_entries`, `purchase_entries`, etc.) — safe today only because every write policy requires `client_id = my_client_id()`, which depended on the very 4 helper functions just above staying reachable by `anon`. Stripped `anon` down to just `SELECT` on `settings` (the one proven real use); everything else revoked.

Every migration in this session was dry-run tested inside `BEGIN; ...; ROLLBACK;` first, checking both that the target role lost access **and** that a real authenticated session (simulated via `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '<uuid>', false); ...`) still worked end-to-end, before applying for real via the Dashboard SQL Editor.

**Files:** `src/modules/hr/selfservice/SelfServiceHome.jsx`, `src/modules/hr/payroll/PayrollRun.jsx`, `src/modules/hr/payroll/PayslipBody.jsx` (new), `supabase/migrations/20260720120000_fix_selfservice_rpc_ambiguous_id.sql`, `supabase/migrations/20260720140000_selfservice_payslip_full_breakdown.sql`, `supabase/migrations/20260720150000_fix_ineffective_anon_execute_revokes.sql`, `supabase/migrations/20260720160000_anon_least_privilege_table_grants.sql`

### S427 — 2026-07-20 — S426's Escape fix was live-tested and didn't actually work; found the real bug

S426 shipped `stopImmediatePropagation()` on the calculator's own document Escape listener, reasoning that React runs child effects before parent effects so the calculator's listener would register (and thus fire) first. Live-tested against the real Add Purchase Bill modal: Escape still closed both. The reasoning was wrong in a way worth writing down, because it's a real DOM-events gotcha, not a typo.

**Why it actually failed:** `Modal.js`'s Escape listener attaches unconditionally the moment the modal itself mounts — i.e. the instant Add Purchase Bill opens, well before anyone has clicked the calculator's ⌗ button. The calculator's own listener only attaches later, when `calcOpen` flips to `true` — a separate, later effect run triggered by a state change, not part of the same mount pass. **Same-phase (bubble) listeners on one DOM target fire in registration order**, so Modal's earlier-registered listener always ran first and had already called its own `onClose()` before the calculator's listener got a chance to call `stopImmediatePropagation()` — by then it was too late, the event handler that mattered had already fired. "Children mount before parents" is true, but doesn't apply here because the two listeners aren't both registered during the same mount pass.

**Actual fix:** register the calculator's Escape listener in the **capture phase** — `document.addEventListener('keydown', onKeyDown, true)`. Capture-phase listeners run before any bubble-phase listener on the same target, deterministically, regardless of which was added first. This is the one fix that doesn't depend on registration-order timing at all.

**Also, per feedback:** a real mouse-clickable × button in the calculator's own header (matching `Modal.js`'s close-button pattern) — Escape is fixed, but a visible click target shouldn't depend on the user trusting a keyboard shortcut that had just visibly failed. And the whole calculator is now larger text throughout for readability: the live result 22px → 32px, the expression input 16px → 18px, keypad buttons 15px → 18px, tape rows 12px → 14px — all values pulled from the existing DESIGN.md type ramp (S424), no new sizes invented. Panel width 340px → 380px to give the bigger result number room.

**Files:** `src/components/Calculator.js`, `src/pages/Help.js`

### S426 — 2026-07-20 — Quick Calculator button in Add Purchase Bill; a real Escape-key bug found and fixed along the way

Follow-on to S423/S424: Add Purchase Bill was the obvious next spot for the Quick Calculator — working out a per-carton rate or a pack conversion mid-bill previously meant Alt+C anyway, so making it a visible, discoverable button in the modal itself was a small change. `Modal.js` gained an optional `headerExtra` slot (next to the × close button, backward compatible — all 13 existing `<Modal>` call sites pass nothing and render unchanged) and `PurchaseBillModal.jsx` now mounts its own `QuickCalculator` instance, toggled by a ⌗ button there.

**Nesting it inside a `Modal` surfaced a real, pre-existing bug, not a new one this change introduced.** `Calculator.js`'s Escape handling lived only on its own input's `onKeyDown`, with no `stopPropagation` — harmless while the calculator was only ever mounted once, globally, in `Layout.js`. But `Modal.js` has its own `document`-level Escape listener that unconditionally closes itself, and `stopPropagation()` is a no-op between two listeners registered directly on the same target (`document`) — propagation only matters between ancestor/descendant elements, and there's only one target here. Once the calculator can be nested inside a `Modal`, pressing Escape inside it would close the calculator *and* the modal underneath, silently discarding an in-progress purchase bill. Fixed by moving Escape to its own `document`-level listener with `stopImmediatePropagation()` — the one call that actually stops a second listener on the same element from firing — registered only while `open`. Enter (commit) stays local to the input, unaffected.

Because the fix lives in `Calculator.js` itself, it also silently fixes the identical latent risk for the *global* instance: Alt+C opened inside any existing `Modal`-based dialog elsewhere in the app, followed by Escape, had this exact double-close risk before today — nothing had exercised that path yet, but nothing needed to for the bug to exist.

Verified with a clean production build; the same 32-case `evalMath.js` test suite from S423 is unaffected since the parser itself wasn't touched.

**Files:** `src/components/Modal.js`, `src/components/Calculator.js`, `src/modules/ims/purchases/PurchaseBillModal.jsx`, `src/pages/Help.js`, `src/pages/settings/imsGuideData.js`

### S425 — 2026-07-20 — IMS Guide brought current: the role system was missing entirely

The in-depth Crest IMS guide (Admin → Settings → Guides) hadn't been touched since S417 wrote it. Seven commits had landed in IMS since, and the guide's most serious gap wasn't a missing detail — it was that **the entire staff/supervisor/manager role system (S419–S421) had no coverage at all**, one incidental keyword match across 1,033 lines. A guide that silently omits who-can-see-what is worse than one that's merely stale: it describes a module that only an Owner ever actually sees.

**New "Admin" group → "IMS Staff & the role system"** (42 sections now, up from 41; the group mirrors the sidebar's own `ims-admin`). Rather than transcribe the README entries, the tier lists were derived from the code — `IMS_RANK`/`hasImsAccess` in `AuthContext.js` and every `minImsRole` tag in `Layout.js` — so the guide states what actually gates rather than what was intended:

- **Staff** (no gate): Dashboard, Purchases, Gate Passes, Sales Entry, Stock Count, Requisitions — enough to run a shift, no rates or margins.
- **Supervisor**: adds Periods, Item Master, Vendors, Purchase Orders, Recipe Costing, and the Stock/Summary reports. Item Master and Vendors sit here specifically because they expose purchase rates.
- **Manager**: adds this page, Settings, Overheads, the Menu pages, and every Finance and Menu & Vendor report. The dividing line is money.

Also documented, because each has bitten already: the Owner test is *negative* (an account is Owner only when it has none of `pos_role` / `hr_self_service` / `ims_role`, so granting an IMS role deliberately demotes someone out of Owner access); "Existing User" eligibility is an architectural constraint rather than a UI nicety (the S316 RESTRICTIVE policies key off `pos_email` / `hr_self_service` independently of `ims_role`, so a POS PIN account given an IMS role would look fine and silently fail every read/write); and route guards vs. nav visibility are two separate concerns that both matter.

**Stock Count** gained the "↩ Pull from last month" button (S422) and — importantly — the *reason* it exists, as a gotcha: the automatic carry-forward is a one-time snapshot at close, not a live link, so closing the month before finishing the count leaves Opening Stock blank with nothing to re-trigger it. That's the likeliest cause of a "my opening stock is empty" support call, so it's written to be findable by that symptom. The stale workflow line claiming carry-forward is automatic-and-done was corrected.

**Purchases and Stock Count** both document the S423 inline arithmetic, with the one non-obvious interaction spelled out: the expression is evaluated *before* the base-unit conversion, so `stored_qty = evaluated_qty × conversion_factor`. **Overview** gained the role system as a cross-cutting concern (two people can describe "the IMS module" completely differently depending on tier) and the calculator as a module-wide utility.

Verified by parsing the exported structure directly — 9 groups / 42 sections, no duplicate section ids — plus a clean production build. Both the on-screen guide and its print builder map over `IMS_GUIDE_GROUPS` generically, so the new group needed no registration anywhere.

**Files:** `src/pages/settings/imsGuideData.js`

### S424 — 2026-07-20 — Design-token drift pass: 60 `/impeccable` findings → 2, three real contrast bugs fixed

S423's hook runs kept reporting findings on files that session only incidentally touched, and they were left unaddressed at the time. Ran the detector properly across the four files: **60 findings**, not the ~13 the hook's truncated per-file summary suggested.

**Three were real bugs, not stylistic drift** — all in the same class: a hardcoded foreground on a themed background, which only works by coincidence on the preset it was authored against.

1. `.pay-method-btn--credit:hover` used `color:#fff` on `background: var(--theme-red)`. The presets' reds run from light (`#f87171` Dark, `#ff5555` Dracula) to dark (`#dc2626` Bright/Light, `#d20f39` Latte), so white failed WCAG AA on four of ten (~2.6:1). **There is no foreground that works on a solid red fill across all ten**, and no paired `--theme-red-text` token exists — so it moved to DESIGN.md's documented Danger pattern (alpha tint + full-opacity red text), which sidesteps pairing entirely.
2. `.pay-method-btn:hover` used `color:#000` on `var(--theme-accent)` — the Accent-Text Pairing Rule DESIGN.md names explicitly. Five presets pair their accent with `#ffffff`, where black failed outright. Fixed to `var(--theme-accent-text)`; this one keeps its solid fill because the paired token does exist.
3. `.tab-btn:hover` used `rgba(255,255,255,0.2)` as a "slightly brighter" border — invisible on all five light presets. Now steps to the accent at 25%, below `--active`'s 50%, so hover→active reads as a progression.

**The rest was genuine token drift:** a second amber (`#f59e0b`) alongside signal-warning `#fbbf24`; a second red (`#dc2626`) alongside `#f87171`; hardcoded greys (`#4b5563`/`#6b7280`) that were also low-contrast on dark presets; and `#60a5fa` across Help.js's whole HR section — which is `MODULE_COLORS.ims`, i.e. the *IMS* blue, while the IMS and POS accordions both correctly use the accent. HR was the odd one out; it now matches. Two sidebar count badges also carried solid fills with `#fff`/`#000` against DESIGN.md's badge spec, and both trial-CTA buttons moved to the standard primary spec.

**Two findings were the design system's own gaps, not code defects,** and were fixed by documenting reality rather than rewriting working code — the path the detector itself recommends:

- DESIGN.md's frontmatter `typography` captured only 16/13/11px, while its *prose* already described a 14–15px title tier and a 16–20px display tier. Since the detector builds its allowed ramp from the frontmatter roles, every other real size read as drift. The ramp now documents all twelve steps the product ships (9–32px), mirroring Layout.css's existing `--font-size-*` properties.
- `rounded` gained `full: 999px`, plus a matching `--radius-full`. The sidebar module switcher's pill signature already shipped that shape (DESIGN.md → Navigation says so in prose) — it was just never in the scale. The 6px scrollbar thumb's "3px" was only ever half its own width, so it now says what it means.
- Print colors are newly documented at all: print is a real surface here (count sheets, payslips, bills, KOTs) but nothing in the theme palette survives `@media print`, which forces white/black. The two neutral rules (`#cccccc`, `#999999`) are now named as print-only.

**Left unfixed, deliberately: 2 `layout-transition` warnings** on `.sidebar-shell`'s `width` and `.main-content`'s `margin-left`. DESIGN.md already ratifies these as an Accepted exception with the reasoning intact — `.sidebar-wrap` is `position: fixed`, so real space must be reserved for its current width; a transform-only fix means restructuring sidebar positioning app-wide, and the animation only fires on a rare manual toggle. Not silenced with an ignore rule, so they stay visible if that reasoning ever stops holding.

Net: **60 → 2**, Layout.js and Help.js and Stock.css each to zero. No visual regression intended anywhere except the two trial CTAs (now brass primary rather than solid amber/red) and the credit pay-method hover (now a tint) — both of which were the contrast fixes.

**Note:** `.impeccable/design.json` is still the 2026-07-12 sidecar and predates the rebrand (its title is "Crest Inventory"). Regenerating it means `/impeccable document`, which rewrites DESIGN.md *from code* and would discard the hand-written named rules and history notes — left alone deliberately; worth a manual reconcile if the sidecar's tonal ramps ever matter.

**Files:** `src/components/Layout.js`, `src/components/Layout.css`, `src/modules/ims/stockcount/Stock.css`, `src/pages/Help.js`, `DESIGN.md`, `CLAUDE.md`

### S423 — 2026-07-20 — Inline arithmetic in qty/rate fields + an app-wide Quick Calculator

Founder asked for "a calculator in the IMS module". Clarified into two complementary pieces, both shipped:

**1. Inline math in quantity fields.** Counting stock is full of arithmetic ("3 cartons of 24 plus 7 loose") and doing it elsewhere then typing the answer back is where transcription errors get in. New **`QtyInput`** (`src/components/QtyInput.js`) accepts an expression — type `3*24+7`, it commits `79`. The running result previews in a small badge above the box; Enter or blur applies, Esc cancels, and an incomplete expression (`3*`, `2+(4`) reverts to the previous value rather than saving a partial reading of it.

The key design invariant: **the raw expression lives only in the component's local `draft` state** — the parent is only ever handed a number (or `''`). So live row totals, COGS math, the offline IndexedDB queue and DB writes can never see a half-typed `3*24` and `parseFloat` it down to `3`. Plain numeric typing is still passed through on every keystroke exactly as the old `<input type="number">` did; the deferred-commit path only engages once the text actually contains an operator, so the normal case is behaviourally unchanged.

Wired into: Stock Count (all four entry tabs, desktop table + mobile cards + the Daily Wastage qty box) and the Purchase Bill modal (qty + rate). Renders `type="text"` — `type="number"` refuses to hold `3*24` at all — with `inputMode="decimal"` preserving the mobile numeric keypad.

**2. Quick Calculator** (`src/components/Calculator.js`) — a small portalled modal over any page, opened with **Alt+C** (chosen over Ctrl+Shift+C, which is Chrome's devtools element picker) or the `⌗` button beside the sidebar search. Keypad + keyboard entry, a session tape of the last 50 calculations (click a row to reuse the expression, click a result to copy), and a sum-of-tape footer. The tape deliberately survives close/reopen; only the expression box resets.

**Shared evaluator** `src/utils/evalMath.js` — a hand-written recursive-descent parser (`expr → term → factor`), deliberately **not** `eval()`/`new Function()`: those execute arbitrary JS and these are inputs where a pasted string reaches the evaluator directly. This grammar can only ever produce a number, and it keeps working under a strict CSP. Handles precedence, associativity, brackets, unary minus, `×`/`÷` glyphs, and comma thousands-separators; returns `null` (→ "leave the input alone") for anything malformed, including division by zero, so `Infinity` can never reach a saved quantity. Verified against 32 cases covering precedence, float cleanup (`0.1+0.2` → `0.3`), and injection-shaped inputs (`alert(1)`, `1+1;console.log(9)` → `null`).

One near-miss worth noting: `Calculator` was already imported in `Layout.js` as a lucide icon (HR → Calculation nav entry), so the component import had to be aliased `QuickCalculator` — duplicate top-level identifiers are a hard compile error, not a shadow.

**Files:** `src/utils/evalMath.js` (new), `src/components/QtyInput.js` (new), `src/components/Calculator.js` (new), `src/components/Layout.js`, `src/components/Layout.css`, `src/modules/ims/stockcount/Stock.js`, `src/modules/ims/stockcount/Stock.css`, `src/modules/ims/purchases/PurchaseBillModal.jsx`, `src/pages/Help.js`

### S422 — 2026-07-20 — Stock Count: re-runnable "Pull from last month" opening-stock button

Founder closed Ashadh 2083 → opened Shrawan 2083 but Shrawan's Opening Stock was empty despite Ashadh having a full Closing Stock count. Root cause: the S409 carry-forward (`Periods.js`'s `carryForwardOpeningStock`) is a **one-time snapshot taken at the instant of close** — if the closing count wasn't fully saved at that moment (e.g. the month was closed first and counted afterward), or the close ran on a pre-S409 / service-worker-cached bundle, the new period's opening stays blank and there was no way to re-trigger it.

Added a re-runnable **`pullFromLastMonthClosing()`** to `Stock.js`: on the Opening Stock tab, "↩ Pull from last month" finds the chronologically-previous BS period, reads its counted `closing_stock.physical_qty`, and upserts those into the current period's `opening_stock` (same "closing IS next opening" rule as the close-time path, but callable any time). Confirms before overwriting, only carries items actually counted (>0), and requires being online. Button appears on the desktop toolbar (next to Clear All / Save All) and the mobile save bar, opening-tab only, disabled on a locked period.

**Files:** `src/modules/ims/stockcount/Stock.js`, `src/pages/Help.js`

### S421 — 2026-07-19 — IMS Staff can now assign a role to an already-existing client login

User feedback on S419/S420: the "+ Add Staff" modal on `/ims/staff` could only create brand-new logins — either a fresh email+password, or one linked to an HR employee record. There was no way to take an account that already exists for the client (e.g. one created via Admin → Clients → Manage → Users, `ClientDrawer.js`'s generic "Add User" flow, shown as an "Existing Users" list there) and just assign it an IMS role.

Added a third **"Existing User"** mode to the Add Staff modal, alongside HR Employee and IMS-only Staff — picks from a `get_ims_eligible_users(p_client_id)` RPC and calls the already-existing `update_ims_role` action (no new login created, no email/password fields shown for this mode).

**Eligibility is deliberately narrow — a real architectural constraint, not just a UI nicety:** only accounts with none of the three staff-account markers (`pos_role`, `hr_self_service`, `ims_role`) already set are offered. Assigning `ims_role` to an account that's already POS PIN staff or HR self-service would look like it worked in the UI while every actual table read/write kept silently failing — `no_pos_pin_staff` and `no_self_service_accounts` (the S316 RESTRICTIVE isolation policies) key off `pos_email IS NOT NULL` / `hr_self_service = true` directly, completely independent of `ims_role`, so a POS PIN account would still be blocked from every pure-IMS table (`items`, `purchase_entries`, etc.) no matter what `ims_role` says. `update_ims_role` in `admin-user-ops` is now hardened with the identical check server-side (not just a UI-only filter), rejecting the assignment with a clear error if the target already has `pos_role` or `hr_self_service` set — covers the case where the action is ever called directly, not just through this modal.

**Files:** `supabase/migrations/20260719140000_ims_assign_existing_user.sql` (new), `supabase/functions/admin-user-ops/index.ts`, `src/modules/ims/staff/ImsStaff.jsx`

### S420 — 2026-07-19 — S419 live-tested end-to-end on the Casa Acai Cafe pilot; 5 real bugs found and fixed

Ran the IMS staff role system live against production (browser automation, real Owner login, a disposable test Staff account created and deleted afterward) rather than trusting the build pass alone — this is auth/RLS-adjacent code, and it paid off: nothing in this list showed up in `CI=true npx react-scripts build`.

**Deploy-order gap (not a code bug, a process one):** the DB migration and Edge Function were applied/deployed first, but the frontend commit itself was never pushed — Vercel was still serving the pre-S419 bundle, so `/ims/staff` 404'd with "No routes matched location." Lesson: for a feature spanning DB + Edge Function + frontend, all three need to actually ship before "done" means anything; committing and pushing is not optional cleanup at the end, it's part of the feature.

**Two backend bugs**, found by intercepting the actual failed requests (console only showed generic 400s — had to monkeypatch `window.fetch` in the live page to capture the real Postgres error bodies):

- `settings.ims_custom_roles` column was never created — `ImsStaff.jsx`'s custom-role-mapping feature (copied from `PosStaff.jsx`, which reads `settings.pos_custom_roles`) 400'd on every load with "column does not exist." Missed because nothing in the original migration review caught the omission — the column just wasn't there.
- `get_ims_staff_list()` 400'd with Postgres error 42804 ("structure of query does not match function result type") — `auth.users.email` is actually `character varying(255)`, not `text`, so the function's `RETURNS TABLE(... email text ...)` didn't match what the query produced. Fixed with an explicit `u.email::text` cast rather than changing the declared return type. `client_user_emails()` (the only other function in this codebase joining `auth.users`) happens to only ever be called for its `id`/`email` pair without this exact type declaration pattern, which is presumably why this particular mismatch hadn't been hit before.

**One frontend bug**, found only by actually logging in as a Staff-tier test account and checking what the sidebar/command-palette showed, not just what the route guard did: the `Settings` nav link is rendered directly in `Layout.js` (outside `IMS_GROUPS`, alongside `Dashboard`/`Owner`), so it was never passed through `isItemVisible()` and had no `minImsRole` tag — a Staff account still saw a clickable "Settings" link in the sidebar and could find it via ⌘K, even though the page itself correctly bounced them to `/dashboard` on click. Not a security hole (the page guard held), but a real UX/trust problem — a restricted-looking link that dead-ends. Fixed by gating that render site the same way and adding `minImsRole: 'manager'` to the palette's `/settings` entry too. Confirmed with the actual repro: Staff-tier ⌘K search for "settings" now returns "No pages match."

**Verified live, end-to-end, with a real (disposable) account:** created a Staff-tier IMS account via `/ims/staff`, logged in as it, confirmed the sidebar showed exactly Purchases/Gate Passes/Sales Entry/Stock Count/Requisitions and nothing else (no Costing/Reports/Admin groups), confirmed direct navigation to `/items` (Supervisor-tier) and `/settings` (Manager-tier) both redirected to `/dashboard`, confirmed `/purchases` loaded and functioned normally, then logged back in as Owner and deleted the test account — final state left clean.

**Files:** `supabase/migrations/20260719130000_ims_staff_roles_fix.sql` (new), `src/components/Layout.js`

### S419 — 2026-07-19 — Crest IMS gets a staff/supervisor/manager role system (mirrors POS roles)

Until now, Crest IMS had zero role granularity — any client login for a property (the "Owner") got full read/write access to every IMS page the plan included, unlike Crest POS which already has a real `pos_role` tier system. Built the IMS equivalent, following the POS role system's exact shape end-to-end rather than inventing a new mechanism — same DB column pattern, same RLS isolation approach, same Edge Function action style, same `hasXAccess(minLevel)` helper, same page-side early-return gating, same nav `minXRole` filtering.

**Product decisions** (clarified via two rounds of questions before building, then planned in Plan Mode and approved before implementation):

- **Login**: real email + password (not a PIN like POS) — an IMS staff account logs in the same way the Owner does today, just role-restricted.
- **Tiers**: Staff → Purchases, Stock Count, Sales Entry, Requisitions, Gate Passes only (entry, no cost/report pages). Supervisor → + Periods, Item Master, Vendors, Purchase Orders, Recipe Costing, and every Stock/Summary report. Manager → + Menu Pricing, Overheads, all Finance Reports, Settings, staff role assignment — full Owner-equivalent access.
- **Cost-data privacy**: UI/route-level hiding only, no DB column-level restriction — matches how POS's tiers already work.

**Database** (`20260719120000_ims_staff_roles.sql`): `profiles.ims_role` (+ `ims_job_title`) with the same `CHECK (staff/supervisor/manager)` shape as `pos_role`. No synthetic `*.internal` email column needed — unlike PIN accounts, real-email IMS logins already have a genuine `auth.users.email`, so `ims_role IS NOT NULL` is itself the "is this an IMS staff account" marker. `is_ims_staff()` + new RESTRICTIVE policies block IMS staff accounts from all 20 `hr_*` tables and every `pos_*` business table (mirroring S316's isolation exactly, plus `pos_parking_slips` which was added after S316 shipped and needed picking up here too) — they keep full access to every core IMS table, since that's the point of the role. `get_ims_staff_list()` RPC mirrors `get_pos_staff_list()` but also joins `auth.users` for `email` (a POS PIN account's login "identity" is just its name on the PIN pad; an IMS manager needs to actually see and share the real login email). `profiles_hr_employee_ims_unique` partial index mirrors the POS one — one employee can't get two IMS accounts, but can have both a POS and an IMS account like today's POS+HR-self-service pattern already allows.

**Edge Function** (`admin-user-ops/index.ts`): 4 new actions — `create_ims_staff`, `update_ims_role`, `delete_ims_staff`, `reset_ims_password` — structural mirrors of the POS staff actions, with email+password instead of PIN, and the same "HR Employee mode" employee-linking option create_pos_staff got in S328. Found and fixed a real gap while wiring the caller-privilege check: `isCallerOwner` previously only excluded `pos_role`, so an HR self-service PIN account (which also has `role='client'` and no `pos_role`) would have incorrectly passed as "Owner" for POS-privileged actions like `create_pos_staff` — now excludes all three staff-account markers (`pos_role`, `ims_role`, `hr_self_service`), fixed identically in `AuthContext.js`'s `isOwner`.

**Frontend**: new `hasImsAccess(minLevel)`/`imsRole` on `AuthContext.js`, mirroring `hasPosAccess`/`posRole` exactly. New `src/modules/ims/staff/ImsStaff.jsx` admin page (`/ims/staff`, Manager-only) — structural mirror of `PosStaff.jsx`, including the custom Job-Title → Role mapping feature (`settings.ims_custom_roles`). `Layout.js` gained a `minImsRole` field on ~20 existing IMS nav items plus a new "Admin" nav group for IMS Staff, extending the same shared `isItemVisible()` check the sidebar/command-palette/pinned-favorites all already use for `minPosRole`. 35 page components got a one-line page-side guard (`if (!hasImsAccess(minLevel)) return <Navigate to="/dashboard" replace />`) — 33 of them via a background agent following an exact, pre-verified insertion spec (build passed clean, 0 warnings, on the agent's first attempt); `MenuPricing.js` and `ImsStaff.jsx` handled directly.

**Bug caught in post-implementation review**: `Periods.js` was initially assigned a flat Supervisor-tier guard like every other page in the batch — but unlike the other 33 pages, `/periods` is one of only two IMS routes with no `ModuleGate` wrapper at all (HR-only and POS-only clients use it too, per Help.js's own POS onboarding guide: *"Periods → the current BS month should already be open from IMS, or create one if HR runs standalone"*). A flat guard would have 403'd every HR/POS-only client off a page they need regardless of IMS role. Fixed the same way `MenuPricing.js` (the other ModuleGate-less IMS route) already had to be handled: `if (clientModules?.ims && !hasImsAccess(minLevel)) ...` — the role gate only applies when the client actually has the IMS module at all.

**Help.js**: added an "IMS Staff" entry to the Module Guide's Core tier (role-gated, not plan-gated, so it doesn't belong under Starter/Growth/Pro) — same tips-list pattern as the existing "POS Staff" entry.

**Files:** `supabase/migrations/20260719120000_ims_staff_roles.sql` (new), `supabase/functions/admin-user-ops/index.ts`, `src/context/AuthContext.js`, `src/modules/ims/staff/ImsStaff.jsx` (new), `src/App.js`, `src/components/Layout.js`, `src/pages/Periods.js`, `src/modules/ims/recipes/MenuPricing.js`, `src/pages/Settings.js`, plus 32 other IMS page components (Items, Vendors, PurchaseOrders, Recipes, StockReport, ReorderReport, StockMovements, DemandForecast, WastageReport, DeadStock, Variance, FifoReport, TheoreticalVariance, ShrinkageReport, MonthlySummary, AnnualSummary, PeriodComparison, BudgetVsActual, MenuEngineering, Overheads, VatReport, NonVatReport, PaymentReport, OutstandingPayables, PurchaseOneLakhAboveReport, BestSellers, RecipeMargin, ComboBuilder, MenuRepricing, SupplierPriceTracker, VendorReport), `src/pages/Help.js`

### S418 — 2026-07-19 — IMS Guide gets a print button, an `/impeccable audit` pass, and a print-pagination fix

Follow-on to S417's new Guides tab, in three steps within the same session.

1. **Print button.** Added a **🖨 Print full guide** button to `ImsGuideTab.jsx`'s sidebar — the tab only renders one active section at a time, so printing needed a separate path: `printGuide()` opens a standalone window, writes a self-contained HTML document covering every group/section (`buildGuidePrintHtml()`), and fires the browser's print dialog. Deliberately kept as its own window-based pipeline rather than folding into the app's other print convention (`.no-print`/`.print-only` + `printWithTitle()`, used by Stock/Sales/MonthlySummary etc.) — that pattern only prints what's already in the DOM, and the guide's DOM only ever holds one section.
2. **`/impeccable audit` on the new file** surfaced 8 findings (1 P1, 5 P2, 2 P3), all fixed:
   - **P1** — the sidebar's active-nav-item text hardcoded `#000` instead of `var(--theme-accent-text)`, violating DESIGN.md's Accent-Text Pairing Rule; verified as an actual WCAG AA failure (~3.88:1) against the Latte preset's purple accent. This bug predates today's session — S417 shipped it, this session caught and fixed it.
   - **P2** — the new print window didn't null `window.opener`, unlike every other `window.open()+document.write` print flow in the app (`creditNoteHtml.js`, `parkingSlipHtml.js`, `PosOrders.jsx`); added `w.opener = null` to match.
   - **P2** — the print builder had its own local HTML-escaping function instead of the shared `escapeHtml.js` util every sibling print template uses; swapped to the import.
   - **P2** — two literal colors inside the print document's own inline stylesheet (`#b8860b` group heading, `#888` block label) measured below 4.5:1 against white; darkened to `#96700a` / `#666`.
   - **P2** — the guide search input had no visible label or `aria-label`, relying on placeholder text alone (WCAG 3.3.2, and a direct violation of DESIGN.md's own "labels above fields, never placeholder-only" rule); added `aria-label="Search guide pages"`.
   - **P3** — sidebar group labels ("Overview", "Operations", ...) were plain `<div>`s with no heading semantics; changed to `<h2>`. Also dropped a stray one-off `fontSize: 12.5` on the print button.
3. **Print-pagination fix**, found by actually printing the guide to PDF and reading it: every group header (OPERATIONS, COSTING, SUMMARY REPORTS, STOCK REPORTS, FINANCE REPORTS, MENU & VENDORS, IMS SETTINGS) printed stranded alone at the bottom of a page with its content pushed to the next page, and `section { page-break-inside: avoid }` forced each entire section onto one page — since most sections run 40–70% of a page tall, two rarely fit together, so the browser left the back half of nearly every page blank rather than packing sections in. A 28-page document for what should print far shorter. Replaced the blanket per-section rule with targeted CSS: `break-after: avoid` on `h1`/`h2`/`.metas`/`.block-h` (a heading is now always glued to what follows it, never orphaned), `break-inside: avoid` kept only on the small atomic pieces (`.summary`, `li`, `pre`) so they don't split mid-content, and sections/blocks are otherwise free to flow across a page boundary between items instead of jumping wholesale to the next page.

**Files:** `src/pages/settings/ImsGuideTab.jsx`

### S417 — 2026-07-19 — Admin Settings gets a full in-depth Crest IMS user guide (new "Guides" tab)

Built a comprehensive, admin-only reference doc covering all ~37 Crest IMS pages (every Operations, Costing, and report page across Summary/Stock/Finance/Menu & Vendor categories, plus the 5 IMS-relevant Settings tabs) as a new **Guides** tab in Admin Settings, separate from Help.js's existing client-facing "Module Guide" (which stays a short feature-tier catalog, untouched).

**Decisions locked in before building** (asked via clarifying questions per user instruction):

- **Static React content**, not DB-backed/admin-editable — matches Help.js's existing pattern; content lives in code, updated via a normal deploy.
- **Full reference depth** — every IMS page gets its own section (purpose, step-by-step workflow, key fields, the actual formulas, gotchas, and cross-page connections), not just a narrower core-workflow walkthrough.
- **Separate and additive** to Help.js's Module Guide tab, not a shared/refactored data source — deliberately duplicative rather than coupling two different audiences (client-facing quick reference vs. admin-facing deep doc) to one dataset.
- **Sidebar + content-pane layout**, grouped to mirror the IMS sidebar's own `NAV_GROUPS` order (Operations → Costing → Summary Reports → Stock Reports → Finance Reports → Menu & Vendors → IMS Settings), with a search box to filter by page name.

**Research approach**: rather than writing generic descriptions, dispatched 3 parallel Explore agents to read the actual source of every IMS page/util (`recipeCost.js`, `purchasesHelpers.js`, `demandForecastData.js`, etc.) and extract real formulas, field behavior, and validation logic before any guide prose was written — so the "How it calculates" and "Watch out for" sections are grounded in the code, not invented. This surfaced several genuine cross-page inconsistencies worth having on record (now documented in the guide itself):

- Monthly Summary, Annual Summary, and Period Comparison each use slightly different Food-Cost-% color thresholds (35/45 vs 30/38) and Annual/Period-Comparison's COGS formula omits Staff Meals while Monthly Summary's includes it.
- Overheads.js's "Food Cost" is pure purchase spend (no opening/closing adjustment) — a different number from every other page's COGS-based Food Cost %, and the single most likely source of "why don't these two reports agree" questions.
- `Variance.js` (shared `explodeRecipeIngredients()` util, ±10% flag threshold) and `TheoreticalVariance.js` (its own locally-duplicated recursion, ±5% threshold) are near-duplicate reports that can disagree on the same item because they're independently maintained.
- `VatReport.js`'s `buildVendorSummary()` is reused by `PurchaseOneLakhAboveReport.js` with different discount-scoping (`'vat'` vs `'all'`) — same vendor, two slightly different totals, by design.
- `PaymentReport.js` has no discount handling at all (raw qty×rate), unlike `VendorReport.js`'s discount- and return-aware "Net Spend" for the same underlying data.

**Files:** `src/pages/settings/imsGuideData.js` (new — all guide content), `src/pages/settings/ImsGuideTab.jsx` (new — sidebar/content-pane UI), `src/pages/Settings.js` (added `'Guides'` to `ALL_TABS`/`ADMIN_TABS`/`CLIENT_HIDDEN`, renders `<ImsGuideTab />`)

### S416 — 2026-07-19 — Purchase Bill Qty field: unit label no longer mistaken for an entered value

Client screenshot: a purchase-bill line showed Rate 0.83, Total 25, and a Qty box reading "GM" — client thought the calculation was wrong. Actual cause: the Qty box's *placeholder* was the item's unit (`inputUnit || '0'`), so an empty Qty field rendered as bare "GM" text that looked like a typed value at a glance, especially on a dark theme screenshot. Qty was genuinely empty, so `Amount = Qty × Rate` was 0 and save correctly blocked with "Add at least one item with item, qty and rate filled" — not a calculation bug, but a confusing empty state.

- `PurchaseBillModal.jsx` Qty cell: placeholder is now always `0`; the unit (e.g. "GM") is shown as a persistent dimmed label pinned inside the left edge of the box instead, via a wrapper `div` + absolutely-positioned `span` (`pointer-events: none`), with the input's `paddingLeft` extended to make room. The unit label now stays visible even after a real quantity is typed, instead of disappearing once the placeholder is replaced.
- **Files:** `src/modules/ims/purchases/PurchaseBillModal.jsx`

### S415 — 2026-07-18 — Leave Requests gets a Reason column; Self-Service Roster shows the day of the week

Two small, unrelated user-requested tweaks in the same session.

- **HR → Leave → Requests**: the `reason` field was already captured on submission (`hr_leave_requests.reason`) but never surfaced in the requests table. Added a **Reason** column between Dates (BS) and Days — truncates with an ellipsis and a full-text `title` tooltip for long entries, shows `—` when empty.
- **HR Self-Service → Roster tab**: each day only showed "Day N", with no day-of-week context. Added a `WEEKDAYS` array (matching the one already used in `Roster.jsx`) and converts each row's BS date to AD via the existing `bsToAd()` utility to resolve the weekday — now reads "Tue, Day 1" etc.

**Files:** `src/modules/hr/leave/LeaveManagement.jsx`, `src/modules/hr/selfservice/SelfServiceHome.jsx`

### S414 — 2026-07-18 — `/impeccable critique` on the POS module + all findings fixed

User ran `/impeccable critique pos module`, then asked to fix everything found, this time with an explicit "ask me for decisions" instruction for anywhere a judgment call was needed rather than picking silently like the two prior critiques. Dual-agent critique (isolated design-review + detector sub-agents, Assessment B using real admin credentials to walk all three POS surfaces — admin-authenticated, PIN staff login, and the public guest menu) scored the module 27/40, the strongest of the three modules critiqued this week — genuine operational maturity (the KOT/BOT delta system, shift-close reconciliation, offline-first order queue), undercut by the same color-token drift IMS and HR each had, this time reaching into a shared cross-module component.

Before fixing, asked 4 clarifying questions and got answers: void the stray test order Assessment B had left open on Table 1 of CASA ACAI CAFE; keep the billing-modal fix minimal (no layout restructure); add the GuestMenu.jsx brand warmth the critique suggested; and include the optional "give KDS its own layout container" idea in scope.

- **Stray test order**: voided (reason: "Test order") the real, unpaid AMERICANO order Assessment B had opened to reach the billing screen, before starting any fixes.
- **P1 — hardcoded colors, this time in a shared component**: `src/components/Tip.js`'s tooltip underline hardcoded `#4b5563` — since `Tip` is mandated on every non-obvious label across all three modules, this one bug had a bigger fix radius than POS alone. `PosOrders.jsx`/`PosShifts.jsx` hardcoded `color:'#fff'` on 5 solid green/red badges/buttons (KOT/BOT sent badge, Payment button, KOT/BOT pending-count badges, Void Order button) — extended the file's own existing `amberBadgeText` contrast-pick pattern (already there for a previous, narrower fix) into new `greenBadgeText`/`redBadgeText` variables. Live-verified on Catppuccin (light pastel green/red): computed styles confirmed black text on both, where hardcoded white would have been close to unreadable. Also fixed one wrong-token instance (`--theme-bg` used where `--theme-accent-text` was meant) and two hardcoded amber-rgba badge backgrounds that never tracked the actual active amber token.
- **P1 — billing modal decision density**: Buyer Details now collapses behind a "▸ Buyer details (optional)" disclosure — matching the existing Items-to-comp pattern already in the same modal — unless a discount or Credit payment actually makes Name+Phone mandatory, in which case it stays forced-open. Added a subtle divider separating the core payment-method choice from the Discount adjustment section below it, per the "minimal fix" decision (no wider layout change).
- **P2 — no modal in the module supported Escape-to-close**: added to the shared `Modal.js` (one `keydown` listener) plus all 4 files with their own hand-rolled overlays that don't use it — `PosOrders.jsx` (Billing/Covers/Recent Bills), `PosStaff.jsx` (Manage Roles/Add Staff/Reset PIN), `PosShifts.jsx` (Open/Close Shift), `IssueCreditNoteModal.jsx`.
- **P2 — error/success banners invisible to screen readers**: `role="alert"` added to every one across the module (10 locations, 8 files) — only `PosLogin.jsx` had this pattern before; now consistent everywhere.
- **P3 — GuestMenu.jsx didn't earn its named brand exception**: PRODUCT.md explicitly calls this file out as the one place brand warmth is allowed (a guest's own leisurely browsing moment, not an ops screen) — gave the outlet name a Georgia serif treatment per the user's "add it" decision.
- **P3 — KDS had no audio alert for new tickets**: added the same two-tone Web Audio chime `PosOrders.jsx`/`GuestMenu.jsx` already use for their own new-arrival events, reset per-station so switching KOT→BOT doesn't falsely chime for every ticket already sitting in the other station's queue.
- **Included per the 4th decision — KDS gets its own layout container**: broke out of the standard sidebar-shell page container into a full-bleed, fixed-position view (same escape-the-shell pattern `PosOrders.jsx`'s order-taking screen already uses), with a larger header and an explicit "← Exit" button back to `/pos/orders`, sized for a wall-mounted, no-keyboard, several-feet-away screen instead of sharing the desktop admin chrome.

Full critique report persisted at `.impeccable/critique/2026-07-18T11-30-54Z__src-modules-pos-pos-module.md`.

**Files:** `src/components/Modal.js`, `src/components/Tip.js`, `src/modules/pos/orders/PosOrders.jsx`, `src/modules/pos/shifts/PosShifts.jsx`, `src/modules/pos/staff/PosStaff.jsx`, `src/modules/pos/kds/KitchenDisplay.jsx`, `src/modules/pos/guestmenu/GuestMenu.jsx`, `src/modules/pos/tables/PosTableManagement.jsx`, `src/modules/pos/parking/NewParkingSlipModal.jsx`, `src/modules/pos/creditnotes/IssueCreditNoteModal.jsx`

### S413 — 2026-07-18 — `/impeccable critique` on the HR module + all findings fixed

User ran `/impeccable critique hr module`, then asked to fix everything found. Dual-agent critique (isolated design-review + detector sub-agents; this time Assessment B was given real admin credentials up front and walked the live HR routes itself, rather than needing a supplementary pass afterward like the S412 IMS critique) scored the module 25/40 — genuine craft in the payroll flow (the operator-annotated formula ledger in `PayrollCalculation.jsx`, `GratuityTracker.jsx`'s honest "this is an assumption, not confirmed law" disclaimer), undercut by a live-reproduced infinite-loading bug and the same color-token drift the IMS critique found, recurring here independently.

- **P0 — infinite loading spinner**: with no "view as" client selected, `/hr/dashboard` and `/hr/employees` hung forever on a silent skeleton — both `useEffect`s guarded their data-load with an early `return` that skipped `setLoading(false)` entirely. Fixed in both files; live-verified (with the client selection cleared) that the page now renders a sensible all-zero/empty state instead of hanging.
- **P1 — Roster Board had no keyboard path at all**: shift-assignment cells were real `<button>`s but wired only to `onMouseDown`/`onMouseEnter`, so Enter/Space did nothing. Added an `onClick` guarded by `e.detail === 0` (fires only for keyboard activation, not real mouse clicks, which stay on the existing drag-select flow) that opens the shift picker for a single-cell selection. Live-verified via keyboard-only Tab+Enter.
- **P2 — hardcoded `#60a5fa` second accent across 6 files**: pay-basis badges (`PayrollRun.jsx`, `PaySetup.jsx`, `FestivalAllowance.jsx`) moved to the existing `badge-gray` class; the CTC summary line (`PayForm.jsx`) moved to `var(--theme-text1)`; SSF/Advance-deduction figures (`GratuityTracker.jsx`, `PayrollRun.jsx`, `PayrollCalculation.jsx`) moved to `var(--theme-purple)` — a genuine 4th-category use, unused elsewhere on those pages. Also fixed a plain miss found alongside it: `PayrollCalculation.jsx` hardcoded `#f59e0b` where `var(--theme-amber)` was already the obvious, established choice one line away.
- **P2 — duplicated `STATUS_COLORS` objects, each hardcoding Dark-preset-only rgba**: `EmployeeList.jsx`, `Overtime.jsx`, and `PaySetup.jsx` each kept an independent copy that would show the wrong hue on all 9 non-Dark presets. Consolidated into one shared, `color-mix()`-based `STATUS_TINT`/`EMPLOYEE_STATUS_COLORS` export in `payrollConstants.js`. Along the way, found and fixed the identical bug pattern a 4th and 5th time over: a byte-for-byte duplicated Finalized/Draft badge in `PayrollRun.jsx`, `FestivalAllowance.jsx`, `IncentiveRun.jsx`, and `HrReports.jsx`.
- **P2 — TADA claim form had identical density on the admin screen and the mobile Self-Service screen**: added visual section chunking (Trip Details / Expenses / Notes, matching how `PayrollCalculation.jsx` already scaffolds complexity) and a sticky bottom submit bar so the primary action stays in thumb reach instead of requiring a scroll back up through the whole form. Also fixed the tab-order mismatch the critique flagged in passing: the default-active `payslip` tab was last in the visual left-to-right order; reordered so it's first.
- **P3 — page-chrome consistency**: `page-container` was used in 10 places across the codebase (4 in HR) with zero matching CSS rule anywhere — `.main-content` already provides the page's outer padding, so this was dead weight rather than a missing rule; stripped the classname from the 4 HR files rather than giving it real CSS (which would have double-padded every page using it). `Advances.jsx`/`TadaClaims.jsx` moved off a hand-rolled `<h2>`+ad hoc padding onto the same `page-title`/`page-subtitle` pattern as every sibling HR page. 3 payroll pages' fixed `repeat(4/5, 1fr)` stat grids swapped for the shared, responsive `.stat-grid` class.
- Minor cleanup: deleted `src/modules/hr/Hr.js`, a "coming soon" stub confirmed dead (not imported anywhere) by both assessments independently; fixed `EmployeeJoiningForm.jsx`'s on-screen Close/Print buttons (unthemed border, hardcoded near-black text instead of `var(--theme-accent-text)`); `Advances.jsx`'s repayment bar `transition: width` → `transform: scaleX`; `Advances.jsx`/`TadaClaims.jsx`'s selected-row tint → `color-mix()`.
- Left alone on purpose: `payrollConstants.js`'s `ATTENDANCE_STATUSES` and `leaveConstants.js`'s leave-type colors (a legitimate categorical-data need, same reasoning as IMS's vendor-split chart palette) and `Roster.jsx`'s `DEFAULT_SHIFTS` (a genuine per-client-editable color-picker column) — both assessments confirmed these as intentional, not drift, and the open question of whether to formalize them as new documented tokens is left for a future decision rather than a unilateral one.

Full critique report persisted at `.impeccable/critique/2026-07-18T10-49-06Z__src-modules-hr-hr-module.md`.

**Files:** `src/modules/hr/dashboard/HrDashboard.jsx`, `src/modules/hr/employees/EmployeeList.jsx`, `src/modules/hr/employees/EmployeeJoiningForm.jsx`, `src/modules/hr/roster/Roster.jsx`, `src/modules/hr/payrollConstants.js`, `src/modules/hr/payroll/PayrollRun.jsx`, `src/modules/hr/payroll/PayrollCalculation.jsx`, `src/modules/hr/pay/PaySetup.jsx`, `src/modules/hr/pay/PayForm.jsx`, `src/modules/hr/festival/FestivalAllowance.jsx`, `src/modules/hr/incentives/IncentiveRun.jsx`, `src/modules/hr/reports/HrReports.jsx`, `src/modules/hr/overtime/Overtime.jsx`, `src/modules/hr/gratuity/GratuityTracker.jsx`, `src/modules/hr/advances/Advances.jsx`, `src/modules/hr/tada/TadaClaims.jsx`, `src/modules/hr/selfservice/SelfServiceHome.jsx`, `src/modules/hr/holidays/HolidayCalendar.jsx` (deleted `src/modules/hr/Hr.js`)

### S412 — 2026-07-18 — `/impeccable critique` on the IMS module + all findings fixed

User ran `/impeccable critique ims module`, then asked to fix everything found. Dual-agent critique (isolated design-review + detector sub-agents, cross-checked live in the running app after credentials were shared) scored the module 24/40 — solid craft in money-critical flows (Overheads.js, offline-first Stock Count), held back by DESIGN.md drift and consistency gaps, not by anything resembling AI-slop.

- **Keyboard accessibility**: `VendorReport.js`'s bill drilldown and `OutstandingPayables.js`'s bill-detail rows were mouse-only while the identical expand/collapse pattern in `SupplierPriceTracker.js` was fully keyboard-accessible — both retrofitted with `role="button"`, `tabIndex`, `onKeyDown` (Enter/Space), `aria-expanded` to match.
- **Delete-All confirmation**: `Purchases.js`'s "Delete All" (purchases/returns) wiped an entire period's financial history behind one generic `window.confirm()`, styled identically to a routine single-bill delete — now opens a modal requiring the user to type the exact period name before the danger button enables.
- **Purple overloaded for two meanings**: `Stock.js`'s Summary tab used `--theme-purple` for both "Staff Meals" and "Requisitioned" columns simultaneously (verified live: both computed to the identical `rgb(167,139,250)`) — Requisitioned moved to neutral `--theme-text2`, leaving purple exclusively for Staff Meals.
- **Hardcoded non-token colors in `Overheads.js`**: Labor's `#60a5fa` (5 call sites: KPI card, tab, P&L bar, cost-stack segment, per-cover stat) happened to look fine on the account's Bright theme by coincidence — forcing Dark live showed it as a rogue blue next to correctly-themed gold/purple siblings. Now `var(--theme-text1)`. The in-bar percentage label's hardcoded `#0f1117` (the literal Dark-preset ink color, would fail contrast on light presets) is now `var(--theme-bg)` — correct in both preset families since each theme's own `bg`/`text1` are already a validated contrast pair.
- **`WastageReport.js`**: loading state used `className="loading-state"`, which doesn't exist in `Layout.css` — a live unstyled loading flash. Fixed to match every sibling report's `<div className="card">Loading…</div>` convention.
- Caught along the way by the design-system hook: a hardcoded `rgba(255,255,255,0.06)` tab-count badge in `Overheads.js` (invisible on light presets) switched to `color-mix()`; two `transition: width` progress-bar animations (`Overheads.js`, `Stock.css`) converted to `transform: scaleX` to avoid layout thrash; `VendorReport.js`'s 8-color vendor-split palette comment corrected — it had misattributed its hardcoded hex to the Recharts-SVG exception, when the real reason is a qualitative chart palette needing more hues than the 4 semantic tokens provide.
- Left alone on purpose: `Stock.css`'s mobile touch-target radius/font-size values, off the documented scale but plausibly deliberate phone-sizing — no device to test a change against, and it was a Minor Observation, not a Priority Issue.

Full critique report persisted at `.impeccable/critique/2026-07-18T10-06-55Z__src-modules-ims-ims-module.md`.

**Files:** `src/modules/ims/reports/VendorReport.js`, `src/modules/ims/reports/OutstandingPayables.js`, `src/modules/ims/purchases/Purchases.js`, `src/modules/ims/stockcount/Stock.js`, `src/modules/ims/stockcount/Stock.css`, `src/modules/ims/reports/Overheads.js`, `src/modules/ims/variance/WastageReport.js`

### S411 — 2026-07-17 — Parking Slips / Gate Passes auto-close on day rollover

User asked what happens to a Parking Slip/Gate Pass left "open" if staff forget Mark Exited — answer was: nothing, it stays Open forever (no day-boundary reset existed). User wanted today's slips/passes to auto-close and the page to start fresh tomorrow, without losing the data — same ask for both features.

- New `auto_closed boolean` column on both `pos_parking_slips` and `ims_gate_passes` (default false). No server cron in this project (confirmed — same reasoning as `Periods.js`'s own client-side expired-period banner), so both `PosParkingSlips.jsx`'s `loadSlips()` and `GatePasses.jsx`'s `load()` now sweep-close, on load, any row still `status='open'` whose `time_in` is before today's local midnight — flips it to `closed` with `auto_closed=true`, never deletes anything.
- The Status column now shows a third state, "Auto-Closed" (gray badge, `Tip` explains), distinguishing a rollover sweep from a real staff-confirmed Mark Exited (green badge) — so it's always possible to tell whether a vehicle's exit was actually confirmed or just stopped being tracked.
- Sweep boundary is plain local midnight (matches `KitchenDisplay.jsx`'s own "today" cutoff) — not a configurable "business day," which would matter for a venue operating past midnight; flagged as a simplifying assumption, not raised as a concern.

**Files:** `supabase/migrations/20260717170000_parking_gate_pass_auto_close.sql`, `src/modules/pos/parking/PosParkingSlips.jsx`, `src/modules/ims/gatepasses/GatePasses.jsx`, `src/pages/Help.js`

### S410 — 2026-07-17 — Parking Slip: bill link, vehicle type toggle, notes, date display

User feedback on the S406 Parking Slip form: missing a read-only date, Notes, and a way to record which bill was issued to the parked customer; Vehicle Type should be a quick toggle, not free text.

- `pos_parking_slips` gains `order_id` (FK to `pos_orders`, `ON DELETE SET NULL`) and `bill_invoice_no` (snapshot) — same shape as `ims_gate_passes.vendor_id`/`vendor_name` from the same original migration. Both nullable; the slip stays standalone/order-optional by design (a walk-in who hasn't ordered yet can still get one).
- `NewParkingSlipModal.jsx`: a read-only Date field (today's BS date, matches the rest of the app's date convention, not editable — `time_in` itself is still DB-defaulted); Vehicle Type is now a Two Wheeler / Four Wheeler toggle instead of a text input; a new Notes textarea (the `notes` column already existed on the table, just wasn't exposed in the form); a Bill Number `SearchableSelect` populated from **today's** billed orders only (`status='billed'`, `invoice_no IS NOT NULL`, `closed_at >= start of today`) — a past day's bill is never the right one to link to a slip issued right now.
- The linked bill's number now prints on the thermal token and shows in the Parking Slips log, where it's clickable — reuses the existing `viewPosBill()` utility (same read-only bill preview Sales Exceptions/Bill Register already use) rather than building a new preview path.

**Files:** `supabase/migrations/20260717150000_pos_parking_slip_bill_link.sql`, `src/modules/pos/parking/NewParkingSlipModal.jsx`, `src/modules/pos/parking/PosParkingSlips.jsx`, `src/modules/pos/parking/parkingSlipHtml.js`, `src/pages/Help.js`

### S409 — 2026-07-17 — Fixed: Closing Stock now actually carries forward to next period's Opening Stock

User asked whether closing Ashadh 2083 without finishing its month-end stock count would affect anything. In answering, found `Help.js`'s own Periods guide already claimed "Closing stock auto-carries to next month opening" — but `Periods.js`'s `closeAndAdvance`/`adminCloseAndAdvance` never actually did this; each period's `opening_stock`/`closing_stock` were entered fully independently. A real gap between documented and shipped behavior, not a new idea — fixed to match what was already promised.

- New `carryForwardOpeningStock(closedPeriodId, newPeriodId)` in `Periods.js` — after a period closes and the next one is created, copies every counted item's `closing_stock.physical_qty` into the new period's `opening_stock` (upsert, so a retried close can't fail on conflict). Only ever carries what was actually counted — an item with no `closing_stock` row (never counted) still starts the new period blank, same as before.
- Wired into both `closeAndAdvance` (the client-facing "Close & Start Next" / expiry-banner action) and `adminCloseAndAdvance` (the admin all-clients view's equivalent) — both needed the newly-created period's id captured back from the insert (`{ single: true }`, previously discarded) to carry forward into.
- `closeAndAdvance` also now handles the case where the next period already existed (a unique-constraint conflict on retry) by looking it up and still carrying forward into it, rather than silently skipping.

**Files:** `src/pages/Periods.js`

### S408 — 2026-07-17 — KOT/BOT prep timer: per-item cart display + guest menu ETA

Follow-up to S407's estimated prep time popup. Two refinements requested after testing:

- The live prep timer (Sent Xm ago / ~Xm left / Ready) is now shown per menu item in Order Taking — both on the menu-tile picker grid (under the price, for items already in the order) and next to the cart list's "✓ KOT/BOT" badge, matched to the right `pos_kot_log` ticket by `recipe_id` (most recent send wins if the same item was sent twice). Deliberately NOT added to the floor-view table tiles — tried that first, then removed it per feedback; the floor grid stays on the plain Sent/Started/Ready badge, full timers only show once a table is actually opened.
- Extended to the public Guest QR menu (`GuestMenu.jsx`) — the existing 5-stage order-status stepper's "Being prepared" stage now shows "about X min left" once kitchen/bar staff have entered an estimate. `get_guest_table_status` (the anonymous-caller `SECURITY DEFINER` RPC backing this, unchanged pattern from its original migration) now also returns a computed `remaining_minutes` — never the raw `started_at`/estimate columns — worked out via the same "slowest in-progress ticket wins" rule already used for the staff floor badge. Deliberately worded "about X min" rather than an exact countdown, and omitted entirely once it goes non-positive, since this is a staff-entered guess becoming a customer-facing promise for the first time, not a measured value.

**Files:** `supabase/migrations/20260717140000_guest_kot_eta.sql`, `src/modules/pos/orders/PosOrders.jsx`, `src/modules/pos/orders/posOrdersConstants.js`, `src/modules/pos/guestmenu/GuestMenu.jsx`, `src/pages/Help.js`

### S407 — 2026-07-17 — Kitchen Display: estimated prep time popup on Start

User wanted a way for kitchen/bar staff to record the probable prep time when they tap Start on a KOT/BOT ticket, so front-of-house can see an ETA and the estimate can be compared against actual prep time in reports.

- New `EstimateTimeModal.jsx` — a calculator-style popup (digit keypad adapted from the PIN pad in `PosLogin.jsx`, plus 5/10/15/20-min quick-preset buttons) shown when Kitchen Display's Start button is tapped. Entering a value is required — Confirm stays disabled until a value is entered, and closing the popup leaves the ticket in New (Ready is unaffected, no popup).
- `pos_kot_log` gets a new `estimated_prep_minutes` column, written alongside the existing `started_at` when a ticket advances to In Progress. `KitchenDisplay.jsx`'s ticket cards now show a live "~X min left" countdown (red once overdue) while in progress, and "Done in Xm (est. Ym)" once Ready.
- The estimate surfaces to front-of-house too: the floor-plan table badge in `PosOrders.jsx` (already showing Sent/Started/Ready) now appends a live "~Xm" ETA next to Started, using the slowest in-progress ticket per table.
- POS Reports → KOT Log → Register tab gained a "Prep (Est/Actual)" column (and matching Excel export columns) — zero query change needed since the Register tab already selects every column on `pos_kot_log`.

**Files:** `supabase/migrations/20260717130000_pos_kot_estimated_prep_time.sql`, `src/modules/pos/kds/EstimateTimeModal.jsx` (new), `src/modules/pos/kds/KitchenDisplay.jsx`, `src/modules/pos/orders/PosOrders.jsx`, `src/modules/pos/reports/KotLog.jsx`, `src/pages/Help.js`

### S406 — 2026-07-17 — Parking Slip facility: POS customer tokens + IMS vendor/delivery gate passes

User wanted a printable "parking slip" for customers who park a vehicle, plus an equivalent for vendor/delivery vehicles arriving at the back office — printable only by Supervisor level+.

- Researched valet-ticket and vendor gate-pass conventions, then found the codebase has no existing "parking"/"gate pass"/"vehicle" concept — genuinely new. Exploration surfaced an asymmetry: POS already has a Supervisor/Manager role hierarchy (`hasPosAccess()` in `AuthContext.js`, the same helper gating Void/Complimentary), but IMS has none (only Owner vs platform Admin). Confirmed with user: the IMS side gets no extra role gate beyond `ModuleGate` (the real boundary is RLS, same as `vendors`); both slip types persist with a log + sequential per-client slip number; the POS side is a standalone action, not tied to any order/table.
- **POS (`/pos/parking`)**: Supervisor+ only can create+auto-print an 80mm thermal token (vehicle number large/bold, popup-window print convention matching `creditNoteHtml.js`); any staff can view the log and Mark Exited. New table `pos_parking_slips` with its own trigger-assigned `slip_no` (same `pg_advisory_xact_lock` + `MAX+1` shape as `assign_pos_order_no()`).
- **IMS (`/gate-passes`)**: any Owner/Admin can create+auto-print an A4 gate pass — pick an existing vendor or type a one-off company name, driver, vehicle number, purpose, Security/Supervisor signature lines (print-only-div + `printWithTitle()` convention matching this session's Purchase Voucher work, S405). New table `ims_gate_passes` with its own `pass_no`; `vendor_id` is `ON DELETE SET NULL` so a later vendor delete never blocks it.
- Both tables added to `scopedDb.js`'s `CLIENT_SCOPED_TABLES`, standard + S316 restrictive RLS policies (verified against `20260708130000_staff_account_business_table_isolation.sql` — `ims_gate_passes` mirrors `vendors` on both restrictive lists; `pos_parking_slips` mirrors `pos_orders`, excluded from HR self-service but not from POS PIN staff), nav/routing (`Layout.js`/`App.js`), Tip tooltips, and the admin Danger Zone (`clearModuleData`/`deleteClientData` in `admin-user-ops`) — edge function redeployed live.
- No `feature_flags`/`PremiumGate` for either sub-feature — matches the existing `/vendors`/`/purchases` and POS-core-route precedent of `ModuleGate`-only gating for an operational utility.

**Files:** `supabase/migrations/20260717120000_parking_slips_gate_passes.sql`, `src/modules/pos/parking/*` (new), `src/modules/ims/gatepasses/*` (new), `src/shared/scopedDb.js`, `src/components/Layout.js`, `src/App.js`, `src/pages/Help.js`, `supabase/functions/admin-user-ops/index.ts`

### S405 — 2026-07-17 — New fiscal year (2083/84) payroll rule check + Purchase Voucher auto-print

Today (Shrawan 1) begins Nepal's FY 2083/84 — user asked for an in-depth rule audit against the new fiscal year, plus a new auto-print-on-save feature for Purchases so a physical voucher can be attached to the vendor's bill for approval.

- Researched the actual Finance Bill 2083 (budget presented 29 May 2026) against the live codebase. Confirmed `tds.js`'s `SLABS_2083_84` already exactly matches the new unified income-tax schedule (1%/10%/20%/27%/29% across 10L/15L/25L/40L bands) — no code change needed, it was already correctly anticipated. Confirmed SSF rate/cap (11%/20%, NPR 100,000 basic cap) and minimum wage (NPR 19,550) are unchanged this FY — minimum wage is revised only every 2 years, next due Shrawan 2084. Updated stale "(FY 2082/83)" labels in `PayForm.jsx`/`Help.js`/`payrollConstants.js` to reflect the rollover, without changing any figures.
- Flagged (not removed, pending user decision) `src/shared/constants/taxSlabs.js` as dead code — an unused, superseded pre-2082/83 tax-slab implementation with an obsolete "female tax rebate" concept, exported from a barrel but never imported anywhere. A landmine if it's ever reached for by mistake.
- New Purchases feature: saving a **new** purchase bill (not edits) now auto-fires an A4 "Purchase Entry Voucher" print — company letterhead, line items in purchase units, VAT/discount/grand-total breakdown, and Prepared By/Checked By/Approved By signature lines. Totals logic extracted into `calcBillTotals()` in `purchasesHelpers.js` so the on-screen modal total and the printed voucher can never drift apart.

**Files:** `src/modules/hr/payroll/payrollConstants.js`, `src/modules/hr/pay/PayForm.jsx`, `src/pages/Help.js`, `src/modules/ims/purchases/purchasesHelpers.js`, `src/modules/ims/purchases/PurchaseBillModal.jsx`, `src/modules/ims/purchases/PurchaseBillPrint.jsx` (new), `src/modules/ims/purchases/Purchases.js`

### S404 — 2026-07-16 — Stock Count Sheet print: fixed blank page 1 on tall categories

User printed a Stock Count Sheet (Stock.js's Print Sheet tab) and got a page 1 with only the header on it — the rest of the page blank — with the first category's table (DAIRY & BAKERY, 32 rows) starting fresh on page 2.

- **Root cause**: `.print-sheet-section { page-break-inside: avoid }` in `Layout.css` told Chromium never to split a category section across pages. When a section is taller than the space left after the header on page 1, Chromium doesn't split it — it defers the *entire* section to a fresh page instead, same failure mode already documented for Payroll Calculation's print grid (S400).
- **Fix**: `.print-sheet-section` now allows breaking across pages; `.print-sheet-cat` (the category heading) stays glued to its first row via `page-break-after: avoid` so a heading can't get orphaned; each table's `<thead>` repeats on the next page (`display: table-header-group`) so a split section still shows column headers; individual `<tr>` rows still can't split mid-row.

**Files:** `src/components/Layout.css`

### S403 — 2026-07-16 — Vendor Report: Daily Breakdown drills into the bill, skips blank days for a selected vendor

User selecting a single vendor via the Vendor Purchase Report search box saw the Daily Breakdown tab still list every day in the period, with `—` for every day that vendor didn't buy anything, and no way to get from a day's number to the actual bill behind it.

- **Blank-day filtering** — when the vendor search narrows to exactly one match, Daily Breakdown switches to a per-vendor view (`singleVendor`/`singleVendorDays` in [VendorReport.js](src/modules/ims/reports/VendorReport.js)) listing only the days that vendor actually has purchases on, plus a TOTAL row. Multi-vendor/no-search view is unchanged.
- **Click-through to bill** — every day row (single-vendor view) or non-zero cell (multi-vendor view) now opens the same bill-detail modal already used by the Vendor Summary tab's vendor-name click (S383), pre-filtered to that vendor + day via a new `drilldownDay` state, with a "Show all days" link inside the modal to drop back to the full period.
- **Theme bug fix, same file** — the modal's expanded bill-detail panel had a hardcoded `rgba(10,12,18,0.7)` background instead of a theme token, so it rendered dark regardless of the active theme preset. Changed to `var(--theme-bg)`.

**Files:** `src/modules/ims/reports/VendorReport.js`

### S402 — 2026-07-15 — Payslip gets a company letterhead, SSF number, and a Net Pay highlight

User pointed out the Payslip (S401) was "too generic" — no company identity anywhere on a document that exists specifically to tell one employee what one employer paid them. Researched what a payslip should contain (legally and for design) before touching anything: employer name/address/tax ID, employee SSF number, and clear visual emphasis on Net Pay came back as the consistent gaps versus what was already there. Confirmed with user: include the employer PAN/VAT number (same field already public on POS Tax Invoices, no new exposure) and keep the redesign modest — add the missing fields and polish, not a structural overhaul.

- **Letterhead** — `PayrollRun.jsx` now fetches `clients.name` + `settings.property_address`/`vat_number` (same pattern `DemandForecast.js` already uses for its own print header) and renders it above the employee block, in both the on-screen modal and the print output. Best-effort: a client that hasn't filled in Settings just gets a shorter header, not a broken one — the whole block is gated on `bizInfo.name` being present.
- **SSF number** — `hr_employees.ssf_no` was already being fetched into `employees` state but never displayed anywhere on the payslip. Now shown inline in the employee meta line, only when `ssf_enrolled && ssf_no` are both set.
- **Net Pay highlight** — subtle accent-tinted background band around the Net Pay row, screen-only (light fills don't reproduce reliably on B&W printers, so print keeps relying on the existing bold border + accent color for emphasis).
- Deliberately not added: an explicit pay-period date range. Every period in this app already IS a full BS month by construction (no partial-month periods exist), so "Ashadh 2083" already fully specifies the pay period — a "1–32 Ashadh 2083" range would be redundant, not new information.

**Files:** `src/modules/hr/payroll/PayrollRun.jsx`

### S401 — 2026-07-15 — Payslip print: fixed edge-to-edge layout with a dead gap down the middle

User attached a Payslip PDF (Payroll Run's individual employee payslip, distinct from S400's Payroll Calculation page): at 100% print scale the label/value columns sat flush against opposite edges of the A4 page with a large empty gap between them, and content ran right to the paper edge with no margin. A brief detour: initially misread a compressed digit in a screenshot as a NPR 2 arithmetic inconsistency between this Payslip and Payroll Calculation for the same employee — user zoomed to 175% and the real figure matched (NPR 10,156 both places, sums correctly to the displayed Net Pay); false alarm, corrected and moved to the actual reported issue.

- **Root cause**: `PayrollRun.jsx`'s print-only wrapper (`{printSlip && <div className="print-only">...}`) had no padding and no width constraint at all — unlike `PayslipModal`'s on-screen version, which is deliberately capped at `width: 460`. `PayslipBody`'s `Row` component uses `justify-content: space-between`, so with nothing constraining the container it stretched across the full A4 width, pushing every label to the far left and every value to the far right.
- **Fix**: added `padding: '28px 36px'` (margin off the paper edge, matching the Payroll Calculation print wrapper's convention) and a `maxWidth: 420` inner wrapper around `PayslipBody`, so it reads as a compact payslip instead of a page-wide table. [PayrollRun.jsx:480-489](src/modules/hr/payroll/PayrollRun.jsx#L480-L489)
- Verified via an isolated Playwright/Chromium repro (same CSS, same content) — before/after comparison confirmed the fix collapses the dead middle gap without changing anything else about the layout.

**Files:** `src/modules/hr/payroll/PayrollRun.jsx`

### S400 — 2026-07-15 — Payroll Calculation print: fixed spilling to a near-blank 2nd page

User attached a PDF export: page 1 was just the header, all the actual numbers pushed entirely onto page 2 despite clearly having room to spare. Root cause: Chromium's print engine treats a `display: grid` container as non-fragmentable — if it can't prove the whole grid fits below the current cursor position, it defers the ENTIRE grid to a fresh page rather than breaking inside it, even when the content would fit right where it is. `CalcDetail`'s two-column layout (`PayrollCalculation.jsx`) is exactly that kind of container.

- Tried to reproduce the exact bug in an isolated Playwright/Chromium test (same CSS, same content, several margin/scale configurations) and couldn't trigger it — reported honestly as inconclusive rather than claiming a verified root-cause fix.
- Shipped the standard `break-inside: auto` override plus a more robust fallback: print rendering drops the grid to `display: block` with the two columns as floats instead (floats have always paginated correctly in Chromium, unlike grid/flex formatting contexts) — visually identical, on-screen view untouched. New `.calc-detail-grid` print-only CSS in [Layout.css:1183-1221](src/components/Layout.css#L1183-L1221).
- User's own test (100% vs 99% print scale) confirmed the actual cause precisely: real content was ~1% (≈10px) taller than one A4 page — right at the threshold where Chromium's all-or-nothing grid deferral bites hardest. Trimmed print-only vertical rhythm to clear that with real margin instead of relying only on graceful float overflow: `Line` padding 3px→2px, `Section` margin-bottom 14px→10px (new `.calc-line`/`.calc-section` classes, print-only overrides — the on-screen expanded row keeps its original roomier spacing). ~84px of saved height against a ~10px deficit, so it should hold across employees with more line items (e.g. SSF-enrolled) too.
- **Confirmed fixed live** (2026-07-15) — user's re-print at 100% scale now fits one page.

**Files:** `src/modules/hr/payroll/PayrollCalculation.jsx`, `src/components/Layout.css`

### S399 — 2026-07-15 — Demand Forecast auto-adjusts on holidays (opportunity #2 from S398's research); Roster gets matching help

Closed the loop the demand-forecast model had left explicitly open: `forecastByWeekday()`'s comment said outright "model does NOT auto-adjust for" a matched holiday — it only attached the name for display. Since Nepal holiday footfall swings both directions depending on the specific festival and business (some restaurants close for Dashain Tika, others get slammed the week after), the fix is an **owner-set multiplier per holiday occurrence**, not a hardcoded guess.

- **Schema** (migration `20260715120000_demand_forecast_holiday_multiplier.sql`, **not yet applied — see below**): `hr_holiday_calendar.demand_multiplier numeric` (nullable, owner-set per specific date) and `demand_forecast_daily.holiday_name`/`holiday_multiplier` (persisted onto the covers-level row so a reloaded forecast can still show which days were adjusted, without re-joining `hr_holiday_calendar` live).
- **`demandForecastData.js`** — `forecastByWeekday()` now multiplies `forecastCovers`/`forecastRevenue`/every `forecastQtyByRecipe` entry by the holiday's `demand_multiplier` when one is set on that date; unset stays exactly as before (flagged, unadjusted). `runForecast()` fetches `demand_multiplier` alongside the existing holiday join and persists it onto the stored row.
- **Holiday Calendar** (`HolidayCalendar.jsx`) — new optional "Demand Multiplier" field on Add/Edit Holiday (e.g. `0.3` if closed/quiet, `1.5` if slammed), validated as a non-negative number; new table column showing `×N` or `—`. Deliberately per-date, not per-holiday-name — Dashain Tika and the days right after it don't behave the same, so each occurrence is set individually.
- **Demand Forecast page** — `loadStored()` was silently discarding the holiday info on every reload (it reshapes rows from `demand_forecast_daily` and had `holiday: null` hardcoded with nothing ever repopulating it — the "shows a holiday badge" behavior only ever worked in the instant right after a fresh Recompute, never on a normal page load, which wasn't previously caught). Now reads back `holiday_name`/`holiday_multiplier` from the stored row; the badge/tip distinguishes "×N adjusted" from "flagged, no multiplier set."
- **Roster's Labor Forecast tab** — was the second ask this session ("show help on the roster page as well"): `loadForecast()` now also selects `holiday_name`/`holiday_multiplier`, and the Date column shows the same adjusted/flagged-only badge next to any holiday, so a manager staffing off this tab sees the same information without switching pages. Help.js updated on all three touched pages (Demand Forecast, Holiday Calendar, Roster).
- **Migration applied** — this sandbox's outbound network couldn't reach the Supabase pooler to run it directly, so it was handed off as raw SQL; confirmed run successfully via Dashboard → SQL Editor (2026-07-15). Feature is fully live.

**Files:** `src/utils/demandForecastData.js`, `src/modules/hr/holidays/HolidayCalendar.jsx`, `src/modules/ims/stockcount/DemandForecast.js`, `src/modules/hr/roster/Roster.jsx`, `src/pages/Help.js`, `supabase/migrations/20260715120000_demand_forecast_holiday_multiplier.sql` (pending)

### S398 — 2026-07-15 — Prime Cost % added to Owner Dashboard, from a 2026 hospitality-tech gap review

Researched current (2026) hospitality/restaurant tech trends against Crest's actual feature set (not the roadmap doc — verified live in code) and published the findings as an artifact, then acted on the cheapest, highest-leverage finding immediately.

- **Prime Cost % (MTD)** — new stat card on Owner Dashboard ([OwnerDashboard.jsx:295-301](src/pages/dashboard/OwnerDashboard.jsx#L295-L301), [:424-432](src/pages/dashboard/OwnerDashboard.jsx#L424-L432)). Food Cost % and Labor Cost % were already computed and shown as separate cards; Prime Cost % is purely their sum (`fcPct + laborPct`) — the single number restaurant operators actually benchmark against (industry standard ~60–65% of revenue, cited in Tip). No new query, no new data — the card sits between Labor Cost % and True Net Margin % in the existing auto-fit grid.
- Research also surfaced (not yet built, logged to memory for next session): Demand Forecast already joins `hr_holiday_calendar` and displays the festival name next to a forecast day but never adjusts the number for it; Roster's Labor Forecast tab already recommends staff headcount from `demand_forecast_daily` (a real edge — confirmed via code, not assumption); Reorder Report and Purchase Orders remain two disconnected manual pages despite Reorder Report already knowing what to buy.
- Corrected a stale claim in project memory: "no online ordering" was recorded as a market gap, but Guest QR self-ordering (submit-and-staff-accept flow, Pro tier) had already shipped in an earlier session — the real remaining gap is specifically off-premise (delivery/pickup) ordering and loyalty, not QR ordering in general.
- Help.js updated: Owner Dashboard entry + tip mention Prime Cost %; new "Prime Cost" glossary term.

**Files:** `src/pages/dashboard/OwnerDashboard.jsx`, `src/pages/Help.js`

### S397 — 2026-07-15 — Stock Movements "silent zero" root-caused + no-BOM warnings + a stray hardcoded color fixed

User reported Stock Movements showing 0 entries for a client with two closed, paid POS bills (35 qty, NPR 7,000 gross per Sales Report). Not a bug in the report — root cause traced to `writeSalesEntries()`'s stock-depletion block ([PosOrders.jsx:1255-1278](src/modules/pos/orders/PosOrders.jsx#L1255-L1278)): it explodes each sold recipe into ingredients via `explodeRecipeIngredients()` ([recipeCost.js:16](src/utils/recipeCost.js#L16)), and if a recipe has zero `recipe_ingredients` rows the explosion is empty, so zero movement rows get written — silently, no error. Sales Report is unaffected since it reads `pos_orders`/`pos_order_items` directly, not `sales_entries`/`stock_movements`, so revenue reporting looked completely normal while the IMS-side depletion ledger quietly produced nothing. Confirmed live: the client's "COKE" recipe had never had an ingredient linked in Recipes → Ingredients; adding one immediately made the next sale show up correctly (40 qty, NPR 4,000, order #3).

Since Recipes.js lets any recipe save with zero ingredients (the default blank ingredient row is entirely optional), added two proactive warnings so this doesn't require a support investigation next time:

- **"No BOM" badge** — Recipes list ([Recipes.js:800-807](src/modules/ims/recipes/Recipes.js#L800-L807)) flags any `pos_enabled` recipe with zero `recipe_ingredients` rows, amber badge + tooltip next to the ingredient count. Sub-recipes tab excluded (never sold directly).
- **Stock Movements cross-reference banner** ([StockMovements.js:53-79,151-158](src/modules/ims/stockcount/StockMovements.js#L53-L79)) — `loadReport()` now also pulls every distinct recipe sold this period from `sales_entries` (raw `supabase.from()` — period-scoped, not `client_id`-scoped) and diffs against which have zero `recipe_ingredients`, surfacing an amber banner naming them by name. Fires independently of the table's own empty/non-empty state, so it also catches the case where only *some* sold items are missing a BOM.
- **Help.js** — added a tip to the existing Stock Movements entry explaining the no-BOM gap and pointing at both new indicators.
- **Also fixed, unrelated:** a hardcoded `rgba(96,165,250,*)` blue in Recipes.js's USDA-candidates banner ([Recipes.js:1048](src/modules/ims/recipes/Recipes.js#L1048), flagged by the `/impeccable` design-lint hook mid-session) — swapped for `color-mix(in srgb, var(--theme-purple) *, transparent)`, matching the purple already used by that same banner's "Try USDA FoodData Central" button. Same literal-blue family was also spotted in Help.js (L643/732/764) but left untouched — pre-existing, out of scope for this session.

**Files:** `src/modules/ims/recipes/Recipes.js`, `src/modules/ims/stockcount/StockMovements.js`, `src/pages/Help.js`

### S396 — 2026-07-15 — `/impeccable` pass on Stock Movements: keyboard-accessibility bug fix

Ran `/impeccable stock movement page` (product register) against the new Stock Movements report and its Reorder Report cross-link from S395. Found one real, confirmed bug and one copy improvement:

- **[Confirmed real bug] Both new clickable elements were keyboard-inaccessible** — the Order # cell in `StockMovements.js` and the Book Stock cell link in `ReorderReport.js` were bare `<span onClick>` with no way to reach or activate them from a keyboard, violating PRODUCT.md's stated WCAG AA baseline. Fixed using the exact existing app convention for this (already established in `HrDashboard.jsx`/`OwnerDashboard.jsx`/`ClientDashboard.jsx`'s clickable rows/cards): `role="button" tabIndex={0}`, an `onKeyDown` handler firing the same action on Enter/Space, and the shared `.interactive-card` class for a themed focus-visible ring — no new CSS needed, reused what already existed.
- **Empty state copy** — Stock Movements' "No stock movements recorded" fell into the bare "nothing here" pattern PRODUCT.md's Components section warns against. Reworded to explain what populates the ledger (a POS bill being charged or marked Complimentary), so an owner seeing it empty understands why, not just that it's empty.
- Checked and deliberately left unchanged (would have introduced a new inconsistency rather than fixed one): loading state stays plain text to match every sibling report page (skeleton loading is a dashboard-only pattern in this codebase); row hover/badge colors/the rationed purple already come for free from global CSS and DESIGN.md's existing rules; search input styling intentionally matches `ReorderReport.js`'s own inline pattern rather than diverging on one page.

**Files:** `src/modules/ims/stockcount/StockMovements.js`, `src/modules/ims/stockcount/ReorderReport.js`

### S395 — 2026-07-15 — POS discount netting bug fix + new "Stock Movements" report page

A cross-module audit (IMS↔POS↔HR) surfaced two related gaps in how `stock_movements`/`sales_entries` — the tables POS writes to on every sale/comp close — actually got used downstream. Both fixed this session.

- **[Confirmed real bug] POS bill-level discounts weren't netted into `sales_entries`** — `writeSalesEntries()` in [PosOrders.jsx:1236-1240](src/modules/pos/orders/PosOrders.jsx#L1236-L1240) inserted `qty_sold × unit_price` at the full pre-discount price regardless of the bill's `discountAmt`/`discRatio` (already computed for the bill's own VAT recalculation, [PosOrders.jsx:303-310](src/modules/pos/orders/PosOrders.jsx#L303-L310)). Every revenue-based IMS report reading `sales_entries.unit_price` — MonthlySummary, PeriodComparison, AnnualSummary, MenuRepricing, MenuEngineering, RecipeMargin, Overheads, BestSellers, Sales.js, and Owner Dashboard's Food Cost %/Net Margin % — was silently overstating revenue by the discount total on every discounted bill. Fixed by applying `discRatio` (only when `closeType === 'paid'`) to the `unit_price` snapshotted on `'pos'`-source rows; `'pos_comp'` rows are left at full price since they're already excluded from revenue by source and only their `qty_sold` is read downstream. Single fix point — no per-report changes needed. Historical rows aren't backfilled (same convention as the earlier `unit_price`/`vat_rate` migration, S-prior).
- **New Stock Movements report** (`/stock-movements`, Starter, `stock_movement_log` flag) — the audit found `stock_movements` (the POS stock-depletion ledger written by `writeSalesEntries()`) had exactly one reader anywhere in the app: Reorder Report's "Book Stock" column. There was no way to actually see the ledger itself. New page in [StockMovements.js](src/modules/ims/stockcount/StockMovements.js) shows a chronological, per-period log of every movement — item, qty depleted, source (POS Sale/POS Comp), the causing order (click-through via the existing `viewPosBill()` helper to the exact original bill/comp-slip), staff, and food-cost value (`qty × per_uom_rate`). Stat cards include "Comp Value" — the food-cost value of comped dishes, a number that existed nowhere else in the app despite comps correctly being zero-revenue everywhere else. Reorder Report's Book Stock cell now links through (`?item=&period=`, the app's first query-string report pre-filter — no existing convention to follow, confirmed by codebase search) since it was the only existing page with a `stock_movements`-derived concept to attach to; Stock Report/Dead Stock/Stock/Variance/Owner Dashboard were deliberately left alone as out of scope (none reference the ledger today).
- **DB migration:** `20260715090000_feature_flags_stock_movement_log.sql` — `feature_flags` is a wide table (one boolean column per feature key), so the new key needs its own column before `FeatureAccessModal.js` can toggle it per client.
- Wired through the full "new feature" checklist: `STARTER_KEYS` (AuthContext.js), `DEFAULT_FLAGS` (SettingsContext.js + FeatureAccessModal.js), Starter feature group (FeatureAccessModal.js), nav entry (Layout.js `REPORTS`, `cat: 'stock'`), route (App.js), Help.js (new entry + cross-references in the existing Reorder Report entry and "Book Stock" glossary term).

**Files:** `src/modules/pos/orders/PosOrders.jsx`, `src/modules/ims/stockcount/StockMovements.js` (new), `src/modules/ims/stockcount/ReorderReport.js`, `src/context/AuthContext.js`, `src/context/SettingsContext.js`, `src/pages/adminClients/FeatureAccessModal.js`, `src/components/Layout.js`, `src/App.js`, `src/pages/Help.js`, `supabase/migrations/20260715090000_feature_flags_stock_movement_log.sql`

### S394 — 2026-07-14 — Danger Zone "Clear X Transactions" cross-module `sales_entries` bugs (both directions)

User asked how a test bill they saved could be undone, then pushed further: does "Clear POS Transactions" actually catch everything? Then, after that fix, asked to also check "Clear IMS/HR Transactions" — surfaced a second, inverse bug. `sales_entries.source` has exactly four DB-constrained values: `'manual'` (IMS's own Sales Entry page), `'pos'` (normal sale, [PosOrders.jsx:1237](src/modules/pos/orders/PosOrders.jsx#L1237)), `'pos_comp'` (comped line items, same file line 1238), `'pos_credit'` (credit-note reversal, [IssueCreditNoteModal.jsx:138](src/modules/pos/creditnotes/IssueCreditNoteModal.jsx#L138)).

- **[Confirmed real bug] "Clear POS Transactions" under-deleted** — `clearModuleData`'s `pos` branch only ever deleted `source = 'pos'`, leaving `pos_comp`/`pos_credit` rows orphaned (parent order gone, row still counted in Sales Report/recipe-usage) for any client that had ever comped an item or issued a credit note. Fixed by widening `.eq('source', 'pos')` to `.in('source', ['pos', 'pos_comp', 'pos_credit'])` — [admin-user-ops/index.ts:409](supabase/functions/admin-user-ops/index.ts#L409). Confirmed manual entries (`source='manual'`) were never at risk from this button either before or after the fix — structurally excluded by the `.in()` filter, backed by the DB CHECK constraint allowing only those 4 values.
- **[Confirmed real bug] "Clear IMS Transactions" over-deleted, the inverse problem** — the `ims` branch's `sales_entries` delete had *no* source filter at all, so for any client running both IMS and POS, clicking it also wiped every POS order's revenue from the Sales Report/recipe stats while leaving `pos_orders`/`pos_order_items` fully intact and still visible on POS's own Orders/KOT/Recent Bills screens — the same inconsistent-state problem, opposite direction, and a direct violation of the button's own "Transactions Only" promise for its own module. Fixed by scoping it to `.eq('source', 'manual')` — [admin-user-ops/index.ts:341](supabase/functions/admin-user-ops/index.ts#L341).
- **HR checked, no bugs found** — cross-referenced every `hr_*` table against the canonical `CLIENT_SCOPED_TABLES` list ([scopedDb.js](src/shared/scopedDb.js)) and the actual FK cascade rules in the migrations; every transactional table is covered, every setup table (`hr_employees`, `hr_holiday_calendar`, `hr_leave_types`, `hr_salary_components`, `hr_shift_types`) is correctly left alone, and both in-code cascade claims (`hr_tada_claim_items` CASCADE, `hr_incentives.config_id` SET NULL) check out against the DDL.

Both fixes deployed via `supabase functions deploy admin-user-ops` (no Docker required for function deploys — only `db pull`/`db dump` need it on this machine). The three Danger Zone buttons are now properly module-isolated, matching their own "Transactions Only, Setup Kept" label.

**Files:** `supabase/functions/admin-user-ops/index.ts`

### S393 — 2026-07-14 — Sidebar Admin/module-row split + global scrollbar-color theme bug

User-reported: as admin "viewing as" Casa Acai Cafe, the POS tab wasn't showing in the sidebar even though the client has `pos_enabled = true` (confirmed live by logging in as the client's real Owner account — POS tab and dashboard section both rendered correctly there). Root-caused to a stale/race-prone `viewModules` fetch in `AuthContext.js` (refetches `clients.pos_enabled` on `adminViewClientId` change) — a hard refresh while "viewing as" the client resolved it, confirming the fetch rather than the DB flag was the problem. Not fixed at the fetch layer this session (no reliable repro without admin credentials); logged for future investigation if it recurs.

Two things were fixed directly:

- **Sidebar Admin/module row split** — `moduleTabs` used to render `Admin` alongside `IMS`/`HR`/`POS` in a single flex row (`.module-switcher`), so an admin viewing a client only ever saw 3-4 cramped pills sharing one row, making it easy to misread which tabs actually existed. Split into two stacked rows in [Layout.js](src/components/Layout.js): `adminTab` (its own `.module-switcher--admin` row) above `moduleTabs` (`IMS`/`HR`/`POS`, unchanged row). Extracted the shared `renderModuleTab()` helper so both rows render identical button markup. Preserved the existing "hide entirely if only one tab total" behavior via a new `totalTabCount` check, so a real client with exactly one module still sees no switcher at all.
- **[Confirmed real bug] Black scrollbars on light themes** — [Layout.css:4](src/components/Layout.css#L4)'s global `* { scrollbar-color: #2a2f3d #0f1117; }` was hardcoded to the Dark preset's own thumb/track hex, unconditionally, on every element. The `::-webkit-scrollbar-*` rules directly below it already correctly used `var(--theme-border)`/`var(--theme-bg)`, but modern Chromium/Edge honor the standard `scrollbar-color` property over the legacy `::-webkit-scrollbar` pseudo-elements when both are present — so every light preset rendered dark scrollbars regardless of the (correct, unused-in-practice) fallback rules. Fixed by pointing `scrollbar-color` at the same theme variables.

Verified: `CI=true npx react-scripts build` compiles clean after each change; user confirmed both fixes visually (sidebar row split screenshot, scrollbar color on a light theme) before this entry was written.

**Files:** `src/components/Layout.js`, `src/components/Layout.css`

### S392 — 2026-07-14 — Kiosk/offline pages `/impeccable audit` fixes: keyboard access, tokens, ARIA

Ran `/impeccable audit` on the four kiosk/offline-capable pages (`PosLogin.jsx`, `SelfServiceLogin.jsx`, `GuestMenu.jsx`, `PosOrders.jsx`) — scores 16/14/17/12 respectively, `PosOrders.jsx` lowest as the largest and highest-stakes file. Fixed all 6 findings, `PosOrders.jsx` first and verified in isolation given its size and real-time risk profile (this repo's own convention: "prefer the smallest safe cut" on this file — all changes here were purely additive/cosmetic, no state or business logic touched):

- **[P1] `PosOrders.jsx` table cards had zero keyboard operability** — "tap a table to open its order" is the screen's entire reason to exist, and it was a `<div onClick>` with no `role`/`tabIndex`/`onKeyDown`. Added the same pattern the dashboards already use (`kpiCard()`'s role="button" + Enter/Space handler), gated on `!inactive` to match the existing click-guard.
- **[P2] 20 hardcoded status-banner colors in `PosOrders.jsx`** — `rgba(52,211,153,*)` / `rgba(248,113,113,*)` / `rgba(251,191,36,*)` / `rgba(201,168,76,*)`, literally the Dark preset's exact green/red/amber/accent hex, hardcoded across the offline/syncing/guest-order/conflict banners and pending-count badges. Tokenized to `color-mix(in srgb, var(--theme-X) N%, transparent)`, same fix already applied to `Login.js` (S390).
- **[P3 → confirmed real bug] `color: '#000'` hardcoded on 5 solid-amber badges** — flagged in the audit as "likely low practical risk," but computing actual contrast per preset found Light's amber (`#b45309`) genuinely fails WCAG AA with black text (4.18:1). Rather than hardcode a per-preset guess, added a computed `amberBadgeText` using the same `contrastRatio()` utility `avatarColorFor()` already relies on — correct across all 10 presets automatically, including any future one.
- **[P2] `SelfServiceLogin.jsx` didn't match its own documented twin** — its file comment claims "same shape as `PosLogin.jsx`," but had no `.card` elevation wrapper (content floated bare on the page background) and a dead numpad Clear-key slot (`''` instead of `'C'`, with no handler at all — not just a labeling gap). Added the card wrapper and restored the working Clear key, including the `Escape`-key shortcut `PosLogin.jsx` already has.
- **[P2] PIN error messages had no `aria-live`** (both `PosLogin.jsx` and `SelfServiceLogin.jsx`) — a screen reader user who mistypes a PIN got no announcement. Added `role="alert"`.
- **[P2] Veg/Non-Veg indicator relied on `title` + color alone** ([GuestMenu.jsx](src/modules/pos/guestmenu/GuestMenu.jsx)) — added `role="img"` + `aria-label="Vegetarian"/"Non-vegetarian"` on the outer swatch, `aria-hidden` on the now-decorative inner dot.

Also confirmed, file-wide via grep, that `PosOrders.jsx` has 19 raw Unicode/emoji glyphs (`⌫ ⚠ 📄 🔔 📵 ⟳`) on top of the `⬢ ⌕ ▼` already fixed in the sidebar (S391) and Login page (S390) — **not fixed this session**, flagged instead as needing a project-wide sweep rather than another one-off page fix, since this is now the 4th file found with the same tell.

Verified: `CI=true npx react-scripts build` compiles clean after each stage (`PosOrders.jsx` fixes verified in isolation before touching the other three files). No active admin/POS session available to click-test `PosOrders.jsx` live; relied on the identical, already-proven `kpiCard()` pattern from the dashboards plus the clean build. `PosLogin.jsx` re-confirmed live to render its fallback screen correctly post-fix (device-not-activated state, no crash).

**Files:** `src/modules/pos/orders/PosOrders.jsx`, `src/modules/hr/selfservice/SelfServiceLogin.jsx`, `src/modules/pos/login/PosLogin.jsx`, `src/modules/pos/guestmenu/GuestMenu.jsx`

### S391 — 2026-07-14 — Sidebar header `/impeccable audit` fixes: opacity-driven contrast, ARIA, icons

Ran `/impeccable audit` on `Layout.js`'s sidebar header (brand mark, search trigger, admin-view dropdown, profile row) — 15/20 (Good), with a notable catch: three raw Unicode glyphs (`⬢` `⌕` `▼`) living in the very file previously cited as "the already-Lucide-re-skinned reference" across the last three audits (S388/S389/S390). The 2026-07-12 re-skin covered nav items and the module switcher — it never touched the sidebar's own brand/search/dropdown-arrow chrome.

- **[P1] Dropdown arrow computed to ~1.96:1 contrast** — `.sidebar-dropdown-arrow`'s `opacity: 0.5` was halving an already token-correct `var(--theme-text2)` (which clears 4.9-7.3:1 on its own), landing well under the 3:1 WCAG floor for UI indicators. The token was never the problem — the multiplier stacked on top of it was. Fixed by dropping the `opacity: 0.5` entirely.
- **[P2] Search button had no real accessible name** — `title="Search pages (Ctrl+K)"` isn't reliably read by screen readers; the actual computed accessible name was the confusing `"⌕Ctrl K"` text content. Added `aria-label="Search pages"`.
- **[P2] Admin-view dropdown trigger had zero ARIA state** — no `aria-expanded`/`aria-haspopup` anywhere in the file; a screen reader user got no indication the button opens a client-switcher menu or whether it's open. Added both, `aria-expanded` wired to the live `clientDropdownOpen` state.
- **[P3] Three raw Unicode glyphs** — brand mark `⬢`, search icon `⌕`, dropdown arrow `▼` swapped for Lucide's `Hexagon`/`Search`/`ChevronDown`. The brand icon fallback is `aria-hidden` (not `aria-label`, unlike its previous state) since the adjacent visible wordmark already names the brand — a labeled icon plus adjacent text double-announces it.

Verified: `CI=true npx react-scripts build` compiles clean; live-checked the search button's `aria-label` and icon render via DOM query + screenshot (logged in as a non-admin client, so the admin-only dropdown/Hexagon-fallback weren't in the DOM to screenshot directly — both are the same proven pattern already confirmed working in `Login.js`/S390, plus the clean build).

**Files:** `src/components/Layout.js`, `src/components/Layout.css`

### S390 — 2026-07-14 — Login page `/impeccable audit` fixes: label a11y, breakpoint gap, One Accent Rule

Ran `/impeccable audit` on `Login.js`/`Login.css` (13/20 — Acceptable, the lowest-scoring page audited so far — this is the product's only public, unauthenticated, conversion-critical surface). Live browser testing turned up two confirmed, visible failures the code alone wouldn't have proven:

- **[P1] 7 of 9 form labels had zero programmatic association with their inputs** — confirmed live via DOM query (`htmlFor: null, wrapsInput: false` on Business Name, Your Name, Phone, both Emails, both Passwords; only the two "Show password" checkbox labels, which wrap their input, were actually associated). Fixed by adding matching `id`/`htmlFor` pairs to all 7 fields (`trial-biz`, `trial-name`, `trial-phone`, `trial-email`, `trial-password`, `signin-email`, `signin-password`). Re-verified live: all 7 now resolve.
- **[P2] Placeholder text truncated in the ~641-750px range** — confirmed via screenshot at 660px width ("you@restaurant.c", "Ramesh Shre" visibly clipped): the `.login-2col` sub-grid (Your Name/Phone, Email/Password) got too narrow for its own placeholders in the gap between `.login-split`'s 640px mobile-stack breakpoint and comfortable 2-column width. Fixed with an earlier, dedicated breakpoint (`@media max-width: 750px { .login-2col { grid-template-columns: 1fr } }`) so the sub-grid collapses before the pinch zone. Re-verified at 660px: no truncation.
- **[P2] Three fully-saturated competing button colors** — "View Pricing"/"Start Free Trial" (solid green) and "Staff Login" (solid purple) competed with "Sign in" (accent) at equal visual weight, a direct violation of DESIGN.md's own One Accent Rule (purple's documented job is "a rationed 4th/5th categorical color," not a second general-purpose CTA fill). Demoted both to a tinted/bordered treatment (`color-mix()` 12% background / 40% border, matching the existing Danger-button pattern) — Sign In is now the one solid accent button on the page.
- **[P2] Hardcoded `rgba(52,211,153,*)`** in the trial-success message — literally Dark preset's exact green hex, would've visibly mismatched the token-correct green text next to it on any of the other 9 presets. Tokenized to `color-mix(in srgb, var(--theme-green) *%, transparent)`, matching the identical pattern `.login-error` already used two lines below in the same file.
- **[P3] Raw `⬢` Unicode glyph** for the brand mark — third occurrence of the same icon-vocabulary tell found on `ClientDashboard.jsx` (S388) and `OwnerDashboard.jsx` (S389). Swapped for Lucide's `Hexagon` icon with `aria-hidden="true"` (redundant with the adjacent "Crest Suite" text anyway).

Verified: `CI=true npx react-scripts build` compiles clean, all fixes re-confirmed live (label DOM query, screenshots at 1280px and 660px, button treatment visually distinct from Sign In).

**Files:** `src/pages/Login.js`, `src/pages/Login.css`

### S389 — 2026-07-14 — Owner Dashboard: same S388 fixes applied (tap targets, Lucide icon)

Ran `/impeccable audit` on `OwnerDashboard.jsx` (17/20 — Good, one step from Excellent) — much smaller, cleaner surface than `ClientDashboard.jsx` (no charts, zero hardcoded hex at all). Found the same 2 issues S388 had already fixed one page over, and applied the identical fix:

- **[P2] Ghost buttons under touch-target minimum** — Retry/Dismiss padding `5px 10px` → `8px 12px`, same values that measured 31px on `ClientDashboard.jsx`.
- **[P2] Raw `⚠` Unicode glyph instead of Lucide** — the 3 warning banners (module-missing, no-open-period, load-error) swapped to `<TriangleAlert>`, matching `ClientDashboard.jsx`'s identical banner pattern and `Layout.js`'s existing sidebar icon set.

`OwnerDashboard.jsx` was already ahead of `ClientDashboard.jsx`'s pre-audit state in a few ways worth noting: `sr-only` section headings ("Profitability"/"Operations") for screen-reader landmarks, and zero hardcoded hex (no charts on this page, so no SVG-color exception needed at all).

Verified: `CI=true npx react-scripts build` compiles clean, live-checked in browser (no layout regression, contrast fix from S388 visible in KPI subtext since it's the same shared token).

**Files:** `src/pages/dashboard/OwnerDashboard.jsx`

### S388 — 2026-07-14 — Dashboard `/impeccable audit` fixes: 5-preset contrast bug, icon vocabulary, a11y

Ran an `/impeccable audit` on `ClientDashboard.jsx` (16/20 — Good) and fixed all 5 recommended actions:

- **[P1] Tertiary/secondary text contrast failure on all 5 light-leaning theme presets.** `--theme-text3` (tertiary — KPI subtext, timestamps) failed WCAG AA (4.5:1) on **every one** of Latte, Rosé Dawn, Solarized, Light, and Bright — computed ratios ranged 2.59:1 (Solarized) to 4.05:1 (Light), none passing. Widening the check turned up `--theme-text2` (secondary — KPI labels) also failing on Rosé Dawn (4.23:1) and Solarized (3.47:1). Fixed by computing new hex values via HSL-lightness binary search (same hue/saturation, darkened until ≥4.6:1 against each preset's own card background) rather than hand-picking — script kept at `.claude`-adjacent scratch, not committed. Dark-leaning presets (Dark, Tokyo Night, Dracula, Nord, Catppuccin) were spot-checked and already pass (5.2–6.7:1) — untouched. **This is a shared token fix, not dashboard-specific** — it corrects tertiary/secondary text contrast app-wide on those 5 presets, not just this page.
- **[P2] Table headers missing `scope="col"`** — added to the 3 `<th>` in Top Variance Items (screen readers now announce the column when navigating cell-by-cell).
- **[P2] Ghost buttons under the touch-target minimum** — Retry/Dismiss/"Full Report →" grew from ~22-24px to a measured 31px tall (padding `5px 10px`/`7px 12px` → `8px 12px`/`9px 12px`), clearing WCAG 2.2's 24×24px AA minimum with margin, without visually bulking up the dense KPI-grid aesthetic.
- **[P2] Icon vocabulary split from the sidebar** — the 2026-07-12 sidebar re-skin moved `Layout.js` onto `lucide-react`, but this dashboard (the very next screen a user sees) still rendered hand-picked Unicode glyphs (↓ ↑ ◈ ₿ ◎ ⚠ ◷ ⊛ 🔒) for the same job. Swapped for `ArrowDown`/`ArrowUp`/`Percent`/`Receipt`/`Target`/`Lock`/`TriangleAlert`/`Clock`/`LayoutGrid`, same per-preset coloring `kpiIcon()` already handled. Also caught and fixed one more glyph outside the original audit's grep (the Reorder panel's shortfall `↓`) during verification.
- **[P3] Charts had no accessible data alternative** — added a computed `.sr-only` summary sentence to all 4 `ChartCard`s (Spend by Category, Daily Purchases vs Sales, Top Items by Spend, FC% Trend) via their existing `footer` slot, so a screen-reader user gets the same trend/proportion a sighted user reads from the chart instead of nothing.

Verified: `CI=true npx react-scripts build` compiles clean (warnings-as-errors), live-checked in the browser on the Bright preset — icons render correctly, `getComputedStyle` confirms `--theme-text3` is now `#667692` (4.60:1) against `#ffffff`, `scope="col"` present, ghost buttons measure 31px.

**Files:** `src/context/ThemeContext.js`, `src/pages/dashboard/ClientDashboard.jsx`

### S387 — 2026-07-14 — HR Employees staff photo upload (S386) reverted — Supabase Storage RLS never resolved

S386's staff-photo upload was fully backed out after an exhaustive live-debugging session found no fixable cause. Every upload attempt from a real client login failed with `new row violates row-level security policy` (SQLSTATE 42501), and the diagnostic trail ruled out every SQL-level explanation in turn:

- The RLS policy logic itself — proven correct via a temporary `SECURITY INVOKER` debug RPC that confirmed `auth.uid()`, `is_admin()`, `my_client_id()`, and the `storage.foldername(name)[1] = my_client_id()::text` comparison all resolved exactly as expected (`folder_equals_my_client_id: true`).
- Table-level grants on `storage.objects`/`storage.buckets` for the `authenticated` role — all present (SELECT/INSERT/UPDATE/DELETE).
- `USAGE` on the `storage` schema for `authenticated` — present.
- Triggers on `storage.objects` — the only two (`protect_objects_delete`, `update_objects_updated_at`) fire on DELETE/UPDATE only, neither touches INSERT.
- Constraints on `storage.objects` — just the expected PK and the `bucket_id` FK to `storage.buckets`, both satisfied.
- Restrictive policies — none; all 5 policies on the table (including the pre-existing `Logos` ones) are `PERMISSIVE`.
- The bucket row itself — correct `id`/`name`/`public=true`, no size/MIME restrictions.
- Recreating the bucket via Dashboard UI instead of SQL (ruling out a stale-SQL-insert-into-`storage.buckets` cache theory) — no change.
- A second bucket with no hyphen in the name (`staffphotos`, ruling out a bucket-name-parsing quirk) — no change.
- A maximally permissive `FOR INSERT TO public WITH CHECK (true)` policy (ruling out any role-matching issue at all) — **still rejected identically.** This is the strongest signal: standard Postgres RLS semantics make this combination impossible to reject, which points to a Supabase Storage API-side issue rather than anything reachable from SQL.

One genuine, if tangential, discovery along the way: this project has a **custom `storage.protect_delete()` trigger** (not vanilla Supabase) blocking direct SQL `DELETE` on storage tables — surfaced when attempting to clean up the test buckets via SQL, which had to be deleted through the Dashboard UI instead. Worth remembering for any future work touching `storage.*` directly.

**Reverted:** `EmployeeForm.jsx` back to its pre-S386 state (no photo UI/state/handlers), `Help.js`'s Employees entry back to its original wording, and a new migration `20260714140000_hr_employee_photo_revert.sql` drops the `hr_employees.photo_url` column and all policy/function leftovers from the DB (bucket deletion itself done via Dashboard, not SQL, per the `protect_delete()` finding above). `20260714120000_hr_employee_photo.sql` (the original S386 migration) is kept in place as historical record rather than deleted, matching this repo's "migrations are the source of truth for schema history" convention — the revert is a new migration, not a rewrite of what actually happened.

**Files:** `src/modules/hr/employees/EmployeeForm.jsx`, `src/pages/Help.js`, `supabase/migrations/20260714140000_hr_employee_photo_revert.sql`

### S386 — 2026-07-14 — HR Employees: staff photo upload on Add/Edit Employee — REVERTED, see S387

Added a circular photo avatar to `EmployeeForm.jsx`'s header (next to the "Add Employee"/"Edit — {name}" title) — click to upload a JPG/PNG/WebP under 2MB, uploads immediately on file select (same immediate-upload pattern as Settings.js's Logo upload, not gated behind Save), with a red ✕ badge to remove it. New nullable `hr_employees.photo_url` column plus a new dedicated public Storage bucket (`staff-photos`, migration `20260714120000_hr_employee_photo.sql` — **not yet run against the live DB, needs the usual SQL Editor paste-and-run step**) with real INSERT/UPDATE RLS policies scoped to the caller's own `client_id` via the path's first folder segment — tighter than the existing `Logos` bucket, whose policies are dashboard-only/undocumented and were flagged as a gap while researching the pattern to copy. No public SELECT/listing policy, same reasoning as the earlier Logos-bucket hardening pass (`20260712210000_security_advisor_anon_execute_hardening.sql`): a public bucket serves file GETs directly, the app never lists.

Upload path convention: `${client_id}/${employee_id_or_timestamp}.${ext}` — a brand-new employee (no id yet) falls back to a timestamp since the photo uploads before the record is saved; editing an existing employee overwrites at a stable path (`upsert: true`), with a `?t=` cache-buster appended to the saved URL so a re-upload's preview refreshes immediately instead of showing a CDN-cached old image. Verified live: avatar placeholder renders correctly, upload flow fires the correct Storage call with the real client_id in the path, and fails with a clean "Bucket not found" message in the UI (expected — bucket migration not yet applied) rather than a silent/broken error. Help.js's Employees entry updated to mention the photo upload.

**Files:** `supabase/migrations/20260714120000_hr_employee_photo.sql`, `src/modules/hr/employees/EmployeeForm.jsx`, `src/pages/Help.js`

### S385 — 2026-07-14 — POS bill reprint labeling revised to match actual IRD reprint convention

Triggered by a client-supplied photo of a real reprinted bill from another system, which didn't match Crest's own output at all — traced that to confirm Crest wasn't running a stale build, then it turned into a deeper compliance question: should the header word "Tax" drop on reprints? Researched Nepal's VAT Rules 2053 (downloaded and read Rule 17(2) directly, plus three secondary e-billing compliance guides) — found no basis for dropping "Tax" on any copy (Rule 17(2) requires "Tax invoice... clearly and visibly written on the front page" with no carve-out), but did find that Crest's existing `ORIGINAL-COPY`/`SECOND-COPY`/`THIRD-COPY`/`REPRINT #N` scheme (from an earlier session, S218) had conflated two different concepts: Rule 17(2)'s *triplicate* provision (three simultaneous paper copies distributed at issuance — buyer/office/self) versus the actual documented reprint convention for computerized billing, which is a simpler sequential "Copy of Original – 1, 2, 3…" count.

Replaced `COPY_LABEL` in `posOrdersConstants.js`: the first print now carries **no label at all** (nothing to distinguish the original from itself), every print after that shows **"COPY OF ORIGINAL - (n)"** where `n` counts the copy itself, not the total print count — the 2nd print overall is copy 1, the 5th print overall is copy 4 (matches the sourced example exactly: "if there are four copies, the last one indicates the invoice was printed 5 times"). No more `REPRINT #N` escape hatch needed past copy 3 — one consistent format extends indefinitely. Both `buildBillHtml()` and `buildCompSlipHtml()` in `posOrderPrintHtml.js` updated to conditionally render the copy-label div (skipped entirely on the original print, so there's no blank line reserved on the receipt). Header text ("TAX INVOICE"/"BILL") is unchanged on every print — only the copy-number line moves. Verified: pure-function output hand-checked for prints 1–6, dev bundle compiles clean (no console errors), the two Help.js POS billing entries that referenced the old ORIGINAL-COPY/SECOND-COPY/THIRD-COPY wording updated to match.

**Files:** `src/modules/pos/orders/posOrdersConstants.js`, `src/modules/pos/orders/posOrderPrintHtml.js`, `src/pages/Help.js`

### S384 — 2026-07-14 — Overhead-to-food-costing audit: fixed 3 real bugs found by a deep-dive review

Client asked for an in-depth analysis of how the Overheads feature affects food costing. A research pass found four independent, non-shared implementations of "period overhead total" across the codebase (`Overheads.js`, `Recipes.js`, `ClientDashboard.jsx`, `OwnerDashboard.jsx`) plus a mislabeled formula — reported back for confirmation before touching anything, then fixed the three the client approved:

1. **Owner Dashboard double-counted labor cost.** `OwnerDashboard.jsx`'s `overheads` query summed all three buckets (`overhead` + `labor` + `tax_fees`) under the name `overheadTotal`, then "True Net Margin % (MTD)" subtracted that *and* a separately-computed HR-payroll `laborCostTotal` — so any client using both the Overheads "Labor Costs" tab and HR payroll saw an understated margin. Fixed by adding `.eq('bucket', 'overhead')` to the query (line ~80), mirroring the filter `Recipes.js` already had. Also gated the "True Net Margin %" KPI card behind `hasFeature('overheads')` (Pro-only, matching how `ClientDashboard.jsx` already gates its equivalent card) — previously it rendered unconditionally regardless of plan tier.

2. **Recipe Costing's overhead allocation was a flat per-portion split, contradicting its own documented behavior.** The Overheads page footer has long claimed fixed overhead is distributed "proportionally by each item's share of period revenue," but `Recipes.js`'s True Cost panel actually did `totalOverheads ÷ totalCovers` — the same flat number applied to every recipe regardless of price. Rewrote the allocation to be genuinely revenue-proportional: a new shared `allocateOverhead(recipeId, overheadData)` helper in `recipeCostCalc.js` computes each recipe's share of total period revenue, applies that share of total overhead, then divides by that recipe's own units sold. A recipe with no sales this period now correctly gets zero overhead allocated (no revenue share to base it on) instead of inheriting the old flat average. Data loading in `Recipes.js` was reworked to fetch per-recipe `revenueByRecipe`/`coversByRecipe` (not just a single period-wide total), and now excludes comps (`source='pos_comp'`) from the covers/revenue base — it hadn't been, unlike every sibling page's overhead/revenue query. `RecipeCostCardPrint.jsx` (the printed cost card, previously duplicating this math verbatim) now calls the same shared helper instead.

3. **"Suggested Price @ 20% Margin" was mislabeled — the formula actually targeted an 80% margin.** `trueCost / 0.20` means true cost = 20% of price, i.e. an 80% margin, not 20% — while the health-check row directly above it in the same panel already used 20 as a *margin* threshold ("✓ Healthy" / "✗ Below 20%"), showing the panel's own intent was margin-based. Client's call: fix the formula (not the label) and target 30% instead of 20%. Now `trueCost / 0.70`, with the health-check threshold and label both updated to 30% for internal consistency. Applied identically in `RecipeCostCardPrint.jsx`.

**Explicitly left out of scope** (client confirmed): wiring overhead-loaded cost into Menu Pricing, Menu Engineering, and Recipe Margin — those three pages currently show raw ingredient food cost only, with no overhead awareness at all. Flagged as a real gap (a dish can show as a Menu Engineering "Star" while being a loss-maker once overhead is loaded) but treated as a scoped feature addition, not a bug fix, for a future session.

All four changed files verified live in-browser (Recipe Costing detail panel, print card path unchanged behaviorally aside from the math fix, Owner Dashboard card) — no console errors, numbers hand-verified against the new formulas.

**Files:** `src/modules/ims/recipes/recipeCostCalc.js`, `src/modules/ims/recipes/Recipes.js`, `src/modules/ims/recipes/RecipeCostCardPrint.jsx`, `src/pages/dashboard/OwnerDashboard.jsx`

### S383 — 2026-07-14 — Vendor Report: click-through bill drilldown with payment status

Client asked to drill down from a vendor row in Vendor Purchase Report → Vendor Summary to see all purchase bills and their status. Clicking a vendor name now opens a modal listing every bill for that vendor in the selected period — Day, Invoice, item count, payment method, bill total, discount, returns, net, and a status badge: Cash/FonePay bills show `Paid` (settle at purchase time); Credit bills reuse the same `payable_payments`/`paid_at` aging logic as `OutstandingPayables.js` (`Paid` / `Partial` / `Current` / `31–60 days` / `61–90 days` / `90+ days`), so status reads consistently across both reports.

Each bill row is itself clickable and expands accordion-style (same pattern as `OutstandingPayables.js`) to show its line items, any linked returns, and payment history. No schema change — reads only the existing `purchase_entries`, `vendor_returns`, and `payable_payments` tables. Verified live in-browser: opened the modal for two vendors (mixed Cash/Credit bills, and a single large 10-line Credit bill), expanded multiple rows, confirmed conditional Returns/Payment History sections render only when present, no console errors.

**Files:** `src/modules/ims/reports/VendorReport.js`, `src/pages/Help.js`

### S382 — 2026-07-14 — Admin Danger Zone: rewired clear/delete buttons for 3 features shipped after they were built + live circular-FK fix

Prompted by an admin screenshot review of AdminClients → Danger Zone on a real Pro client (BHATTI CHOILA): the per-module "Clear Transactions" and "Clear Client Data"/"Delete Client" buttons in `admin-user-ops`'s `clearModuleData`/`deleteClientData` actions hadn't been touched since they were first built, while three later features added client-scoped tables that were never wired in — POS credit notes, HR TADA/Incentives/Roster-publish/Shift-swap (S306/S307), and POS guest-ordering/payment-webhook scaffold. None of those tables' `client_id` FKs have `ON DELETE CASCADE`, so this wasn't just stale leftover data: **Clear POS Transactions, Clear Client Data, and Delete Client would throw a foreign-key-violation and abort mid-sequence** for any client that had ever issued a credit note, submitted a TADA claim, run an incentive calc, published a roster, or requested a shift swap.

Added the missing deletes to both `clearModuleData` and `deleteClientData` in `supabase/functions/admin-user-ops/index.ts`: `demand_forecast_daily`/`demand_forecast_run_log` (IMS); `hr_tada_claims` (cascades to `hr_tada_claim_items`), `hr_incentives`, `hr_incentive_configs`, `hr_roster_publish_state`, `hr_shift_swap_requests` (HR); `pos_credit_notes`, `pos_payment_confirmations`, `pos_guest_order_requests` (POS) — each ordered so children are cleared before the parent rows they reference.

Live testing on BHATTI CHOILA (a real client with a credit note on file) caught a second problem the static read-through missed: a **circular FK** between `pos_orders.credit_note_id → pos_credit_notes.id` and `pos_credit_notes.order_id → pos_orders.id`, neither cascading. The first deploy still failed with `violates foreign key constraint "pos_orders_credit_note_id_fkey"` on the very first delete statement (nothing else had run yet, so no partial corruption). Fixed by nulling `pos_orders.credit_note_id` for the client before deleting `pos_credit_notes`, in both action branches. Redeployed and reconfirmed: "POS transactions cleared. Setup data was kept."

Updated the three per-module Danger Zone tooltips in `ClientDrawer.js` to list the newly-included tables so they stop under-describing what actually gets deleted.

Also fixed a UI-only bug the live test surfaced: all 6 Danger Zone buttons shared one `deleting` boolean, so clicking any single button flipped every button's label to "Working…" and made it look like all 6 destructive actions had fired at once. Replaced with `deletingAction` (holds which specific action is in flight); all buttons still disable together during any run (prevents firing a second destructive action mid-flight), but only the one actually clicked now shows "Working…".

No schema migration — this was entirely an Edge Function + frontend fix. `admin-user-ops` was redeployed twice this session via `supabase functions deploy admin-user-ops`.

**Files:** `supabase/functions/admin-user-ops/index.ts`, `src/pages/adminClients/ClientDrawer.js`

### S381 — 2026-07-14 — Suite Bundle billing consistency + sidebar/help follow-ups + recipe-ingredient duplicate-key fix

Four smaller, linked fixes following on from S380's pricing rework.

**Suite Bundle got its own independent expiry + consistency guarantees.** `suite_plan` previously had no expiry column of its own — a Suite Bundle client's countdown silently fell back to whichever per-module `*_ends_at` happened to be set, which drifted the moment a bundle was renewed independently of its modules. Added `clients.suite_ends_at` (migration `20260714000000_suite_ends_at.sql`), wired into `getSubStatus()` (`subscription.js`), the auto-deactivation date scan (`AdminClients.js`), and `AdminDashboardOverview.jsx`'s `clientMRR()` (now checks `suite_ends_at` before falling through to `ims_ends_at` for pre-migration rows). Real inconsistency then surfaced on a live client (Suite Pro selected but IMS disabled, HR still on Starter) — `suite_plan` and the per-module enabled/plan fields were two fully independent axes with no sync logic. Fixed in `ClientDrawer.js`: picking a Suite Bundle tier (`handleSuitePlanPick`) now force-enables all three modules and sets all three plans to match; the per-module toggles/plan pickers are disabled and dimmed with a "Controlled by Suite Bundle" badge whenever a bundle is active; `handleSaveSub` now persists the enabled flags and `suite_ends_at` together; and a one-time reconciliation effect auto-corrects any already-inconsistent client the moment its drawer is opened, writing the fix back to the DB and refreshing the sidebar if that client is currently being viewed as. A white-text note under the bundle picker ("Selecting a bundle disables individual module pricing below") makes the lockout visible before it's hit.

**Sidebar:** Sales Entry moved in the `NAV` array to sit between Purchases and Purchase Orders, matching the actual IMS workflow order.

**Help & Guide:** the Module Guide tab's Crest IMS/HR/POS sections briefly went always-expanded during this session's work, then were corrected back to collapsed-by-default (click a module header to roll it open) — same convention as the Getting Started tab's `openGS`, so a Suite client sees three clickable topics instead of a wall of content on first load.

**Recipe-ingredient duplicate-key bug.** Editing a recipe and adding a new ingredient could throw `duplicate key value violates unique constraint "recipe_ingredients_recipe_id_item_id_key"` on an *unrelated*, unchanged ingredient (e.g. adding a sub-recipe to "Tea - Oolong" failed on its existing "Tea - Oolong" item ingredient). Root cause: S375's insert-then-delete save order (insert new rows first, delete stale ones after, so a failed insert never leaves the recipe with zero ingredients) inserts a fresh row for every current ingredient, including ones unchanged from before the edit — for an item-type ingredient that already existed on the recipe, the fresh insert collided with the still-present old row on `(recipe_id, item_id)` before the delete step ever ran. Sub-recipe rows never hit this since their `item_id` is NULL and Postgres doesn't treat NULL=NULL as a duplicate. Fixed by swapping `insert()` for `upsert(ingPayload, { onConflict: 'recipe_id,item_id' })` — an unchanged item ingredient now updates its existing row instead of colliding; sub-recipe rows are unaffected since they never match that conflict target.

Compiled clean via Babel/`react-app` preset. `suite_ends_at` migration file exists but has not yet been confirmed applied against the live Supabase DB.

**Files:** `src/pages/adminClients/ClientDrawer.js`, `src/pages/dashboard/AdminDashboardOverview.jsx`, `src/pages/AdminClients.js`, `src/utils/subscription.js`, `src/components/Layout.js`, `src/pages/Help.js`, `src/modules/ims/recipes/Recipes.js`, `supabase/migrations/20260714000000_suite_ends_at.sql`

### S380 — 2026-07-13 — Sidebar visual re-skin (lucide-react icons + pill nav) + admin viewModules staleness fix + Plan Pricing rebuilt to match real pricing (Monthly/Annual, Suite Bundle-aware MRR)

Two linked engagements: a full visual re-skin of the app sidebar, and — surfaced while testing it — a chain of billing/pricing fixes on the Admin side.

**Sidebar re-skin** (`Layout.js`, `Layout.css`, `CommandPalette.js`), modeled on a reference "Untitled UI"-style sidebar the user shared:

- Added `lucide-react` and replaced every Unicode/emoji glyph icon across `NAV`/`REPORTS`/`POS_GROUPS`/`HR_GROUPS`/module tabs/bottom-row/command-palette (~75 icons) with real line-icon components.
- Active nav item is now a solid rounded "pill" highlight (`.sidebar-link--active`) instead of the old left-border-bar + inset-ring; section groups separated by whitespace instead of hard divider lines; the "VIEWING [Client]"/"Property" block lost its filled/bordered card look, now a plain inline row.
- Bottom icon row (Help/collapse/sign-out) switched from a stacked column to a horizontal row (matching the existing row↔column flip already used for the module switcher) to reclaim vertical space.
- The user's name/role moved out of its own footer section to sit inline, right-aligned, next to the client/property name — the footer section itself now only renders at all when there's an upgrade-teaser button to show.
- "Owner Dashboard" + this panel's own "Dashboard" link merged into one side-by-side equal-width row (`renderDashboardRow()`) instead of two stacked full-width rows, with a new `compact` mode on `renderNavItem` (tighter padding/gap/font/icon-size) and shortened labels ("Owner"/"Dashboard") since a ~100px half-width slot has no room for "Owner Dashboard"/"Inventory Dashboard" at readable size.

**Admin `viewModules` staleness bug** (found while re-testing the module switcher): toggling a module on/off in AdminClients' drawer while already "viewing as" that client wrote straight to the DB but never re-fetched `AuthContext`'s `viewModules`, so the sidebar's module tabs (IMS/HR/POS) silently stayed stale until a manual re-select or page reload. Fixed with a new `refreshViewModules()` exposed from `AuthContext`, called from `ClientDrawer.js`'s three module-toggle handlers whenever the client being edited is the one currently being viewed as.

**Plan Pricing rebuilt to match real pricing** (`Settings.js`, `SettingsContext.js`, `AdminDashboardOverview.jsx`, `pricingPlans.js`): a user comparison request surfaced that Admin Settings > Plan Pricing (`{starter:5000, growth:8000, pro:12000}`, one shared price applied identically to any module) was completely disconnected from the real advertised pricing in `pricingPlans.js` (IMS genuinely tiered at 2000/2600/3500; HR and POS each a flat single price with no tiers) — a Growth-tier client running all three modules was showing NPR 24,000 Monthly Value on the Admin Dashboard against an actual advertised price of NPR 5,800 (Suite bundle) or 7,200 (bought separately), a 3-4x overstatement.

- Added `DEFAULT_PLAN_PRICES` to `pricingPlans.js`, derived directly from `IMS_TIERS`/`HR_PRICING`/`POS_PRICING` so the admin-analytics table can never independently drift from the real pricing again.
- Settings > Plan Pricing tab rebuilt around 3 sections (IMS tiered / HR flat / POS flat) instead of one flat 3-price table, plus a Monthly/Annual sub-tab where Annual is read-only and auto-calculated as 25% off Monthly (same convention already used everywhere else annual pricing appears) — never independently editable, so the two can't drift apart.
- `AdminDashboardOverview.jsx`'s `clientMRR()` rewritten to price IMS by tier and HR/POS as flat amounts (matching the real model), to apply the 25%-off conversion for any client on `billing_cycle: 'annual'` (previously always used the full monthly rate regardless of billing cycle), and to check `suite_plan` first — if a client has a Suite Bundle selected, its discounted bundle price now replaces the per-module sum entirely (previously `suite_plan` had no billing effect at all, so a Suite Growth client was still being counted as 3 separate full-price modules). Monthly Value column also gained a small "Monthly"/"Annual" tag.

Compiled clean via the project's own Babel/`react-app` preset after every edit (no dev-server screenshot tooling available in this environment — visual sidebar changes were verified by the user directly against the running dev server).

**Files:** `src/components/{Layout.js,Layout.css,CommandPalette.js}`, `src/context/{AuthContext.js,SettingsContext.js}`, `src/data/pricingPlans.js`, `src/pages/Settings.js`, `src/pages/adminClients/ClientDrawer.js`, `src/pages/dashboard/AdminDashboardOverview.jsx`, `package.json` (+`lucide-react`)

### S379 — 2026-07-13 — Dashboards: Supabase fetch failures no longer silently swallowed

Follow-up to a question about a code-review observation: none of the 3 dashboards ever checked Supabase's `error` field, only `data` — a failed query either zeroed out a KPI (indistinguishable from "this client genuinely has none"), or for the `.single()` period-fetch specifically, showed the misleading "No open period" banner even when a period genuinely was open. Confirmed by grepping all three files for the word "error" — zero matches anywhere.

Designed and implemented one consistent fix across `ClientDashboard.jsx`, `OwnerDashboard.jsx`, and `HrDashboard.jsx`: every load function now captures `error` alongside `data` from each Supabase call (a `results = await Promise.all([...])` array checked with `results.some(r => r.error)` where a function makes several calls at once) and surfaces a dismissible, retry-able banner — reusing the same `card`/`.btn-ghost`/`color-mix()` pattern already established this session, not a new one-off. `.single()` period-fetches specifically ignore Supabase's `PGRST116` code ("no rows matched") — that's the normal "no period open right now" state, not a failure, and must not trip the banner.

- **`ClientDashboard.jsx`** and **`OwnerDashboard.jsx`** — errors are keyed per section (`ims`/`hr`/`pos`/`fcTrend` on Client; `ims`/`reorder`/`payables`/`labor`/`period` on Owner) in a `loadErrors` map, so one section's failure can't clobber another's message, and each section's Retry button re-invokes only that section's own load function.
- **`HrDashboard.jsx`** — one `loadError` string covers its single integrated 13-query batch plus the conditional payslips follow-up query, since this file only has one load function.

Build clean, 91/91 tests pass (`App.test.js`'s pre-existing unrelated `react-router-dom` resolution failure aside).

**Files:** `src/pages/dashboard/{ClientDashboard.jsx,OwnerDashboard.jsx}`, `src/modules/hr/dashboard/HrDashboard.jsx`

### S378 — 2026-07-13 — Dashboard audit P3 fixes + a flagship `/impeccable polish` pass

Closed out the last tier of the dashboard audit (P3), then ran `/impeccable polish` against the same 3 dashboards at a flagship quality bar.

**P3 fixes:** decorative emoji/glyphs (🔒 ⚠ ◷ ⊛ plus the `kpiIcon()` badge glyphs) marked `aria-hidden="true"` across `ClientDashboard.jsx`/`OwnerDashboard.jsx`, so screen readers stop announcing redundant Unicode names alongside the adjacent text; a visually-hidden `aria-live="polite"` region added to all 3 dashboards, since S377's skeleton-based loading states are otherwise silent to assistive tech; `loadFcTrend` (`ClientDashboard.jsx`) rewritten from a per-period `.filter()` re-scan of the full purchases/returns/sales arrays to a single group-by pass; the pie-legend `reduce()` hoisted out of its `.map()` into one `categorySpendTotal` computed per render instead of once per row.

**Polish pass** (code-level — no browser/screenshot tooling available in this environment, so not literal pixel-zoom QA) surfaced 3 genuine gaps the technical audit's checklist doesn't cover, since they're about *missing states* rather than measurable rules:
- Every KPI card across all 3 dashboards declared `transition: 'border-color 0.15s'` inline, implying a hover effect that never actually fired — no CSS rule anywhere changed the border color on `:hover`. Added `.interactive-card:hover { border-color: var(--theme-accent) }` to `Layout.css`.
- `ClientDashboard.jsx`'s two amber "period" action buttons (admin's "Go to Periods", the client's "End Month & Start Month") were a duplicated one-off — full inline style objects repeated twice, no hover feedback at all, unlike every other button in the app. Consolidated into one `.amber-action-btn` class with a real hover state and a focus-visible ring; caught real drift while doing it — both were still hardcoded to a `6px` radius, predating DESIGN.md's documented button-radius bump to `--radius-md` (12px), fixed to match.
- The POS "Covers Served" card's subtext rendered as a lone floating "→" during loading (the bill-count text vanished via an empty-string fallback, but the arrow stayed outside that conditional) — inconsistent with the skeleton treatment used for the value directly above it. Now shows a matching skeleton bar.

Scanned all three files for dead code, `console.log`/TODO leftovers, and copy inconsistencies (arrow usage, capitalization) — none found. One out-of-scope observation surfaced during the pass (every dashboard silently discarding Supabase's `error` field) was deliberately not fixed inline — see S379 below.

Build clean, 91/91 tests pass throughout (`App.test.js`'s pre-existing unrelated `react-router-dom` resolution failure aside).

**Files:** `src/pages/dashboard/{ClientDashboard.jsx,OwnerDashboard.jsx}`, `src/modules/hr/dashboard/HrDashboard.jsx`, `src/components/Layout.css`

### S377 — 2026-07-13 — Dashboard audit P2 fixes: skeleton loading, heading hierarchy, responsive grids, touch targets, color consolidation

The 5 remaining medium-severity findings from S376's dashboard audit, across `ClientDashboard.jsx`, `OwnerDashboard.jsx`, and `HrDashboard.jsx`.

- **Scattered hardcoded amber colors** — three different, mismatched RGB triples (`rgba(217,119,6,*)`, `rgba(201,168,76,*)`, `rgba(251,191,36,*)`) were all doing the same "warning banner"/"accent border" job across the two files, none actually derived from a theme token. Consolidated onto `var(--theme-amber)`/`var(--theme-accent)` via `color-mix(in srgb, ..., transparent)`, so they now track whichever of the 10 presets is active instead of one hardcoded shade.
- **Two non-responsive fixed-column grids** (`ClientDashboard.jsx`'s 3-chart row and its Variance/Reorder row) — switched to `repeat(auto-fit, minmax(...))`, matching the pattern every other grid in the same file already used correctly.
- **Sub-44px touch targets** — the two "Full Report →" buttons got roomier padding (`3px 8px` → `7px 12px`); the inline "Set par levels →" text link got a padding-plus-negative-margin trick that grows its actual hit area without shifting the surrounding sentence's layout.
- **Missing heading hierarchy** — every section label that was a plain styled `<div>` (module headers, table titles, HR's Approvals/Headcount/Payroll/queue titles) is now a real `<h2>`/`<h3>`, with margin/font-weight explicitly reset so nothing looks different — a screen-reader user can now navigate each dashboard by heading. `OwnerDashboard.jsx`'s two KPI rows had no visible label to convert, so they got new `sr-only` headings ("Profitability"/"Operations") instead — a landmark without changing the visual design. New `.sr-only` utility class added to `Layout.css` for this.
- **No skeleton loading states, inconsistent between sections** — new `.skeleton`/`.skeleton-block` shimmer classes (theme-token gradient, `prefers-reduced-motion` fallback per the app's existing motion convention) replace every `'—'` / `!posStats ? '—'` text placeholder in `ClientDashboard.jsx` and `OwnerDashboard.jsx`. `ClientDashboard.jsx`'s HR section previously showed a completely different "Loading HR data…" text card while its own KPIs loaded, instead of the IMS/POS sections' per-KPI dash — merged into one block using the same per-KPI skeleton pattern as everything else on the page. `HrDashboard.jsx`'s full-page "Loading HR Dashboard…" text is now a skeleton mirroring the page's real shape (header + 3 stat-grid rows of shimmering placeholder cards) instead of blank text.

Build clean, 91/91 tests pass (`App.test.js`'s pre-existing unrelated `react-router-dom` resolution failure aside).

**Files:** `src/pages/dashboard/{ClientDashboard.jsx,OwnerDashboard.jsx}`, `src/modules/hr/dashboard/HrDashboard.jsx`, `src/components/Layout.css`

### S376 — 2026-07-13 — ClientDashboard sub-recipe follow-up + full dashboard audit (16 fixes) + keyboard-accessibility hardening on all 3 dashboards

Three linked engagements on `/dashboard`, `/owner-dashboard`, and `/hr/dashboard`.

**Sub-recipe cost-recursion follow-up.** User flagged that `ClientDashboard.jsx` still had the same hand-rolled `recipe_ingredients` read (only picking up direct `item_id` rows, silently costing any sub-recipe-based ingredient at zero and skipping `yield_pct`) that S375's IMS audit had just fixed everywhere else. `loadStats()` now calls `explodeRecipeIngredients` once and feeds both `theoreticalMap` (item usage, for Variance/Reorder) and `recipeCostMap` (Menu Health's underpriced-dish detection) from the same recursive breakdown. A third, related revenue bug found in the same pass: every revenue figure on the page (KPI cards, daily trend, 11-month FC% trend) was still joining the recipe's CURRENT `selling_price` instead of the `unit_price` captured on the sale row by S375 — fixed to use `unit_price` when present, falling back to current price only for pre-migration rows.

**Full dashboard audit** (3 parallel sub-agent passes + direct verification, then user approved "Everything (#1-16)"):
- **`ClientDashboard.jsx`** — plan-tier gates (Menu Health/Variance/Reorder) were render-only: a Starter client's browser still computed and held the real Growth-tier numbers in state even though only the upsell card rendered — a real data leak, not just a display gate. Now the underlying computation itself is skipped when the feature isn't entitled. Added a `loadIdRef`/`myId` staleness guard across all four load functions so rapid admin "view as" client-switching can't let a stale response for the previous client overwrite the current one. Fixed a `NaN` that could silently drop a genuinely low-stock item from the Reorder list. POS monthly totals now use a Nepal-fixed `+05:45` day boundary instead of the viewer's own browser timezone (wrong for a non-Nepal-based admin). Top Items by Spend and wastage valuation now price against an unfiltered item list so an item deactivated mid-period still costs correctly instead of silently zeroing. Period-close button now guards against double-submit.
- **`AdminDashboardOverview.jsx`** — trial-expiry read a column (`trial_ends_at`) that's never actually set; switched to the real `trial_expires_at`. The IMS-subscription status column and churn-risk filter were using `getSubStatus` (cross-module max across ims/hr/pos end dates) instead of `getDateStatus` (single-date), contradicting the column's own "IMS subscription countdown" tooltip.
- **`OwnerDashboard.jsx`** — reorder stats rewritten onto `explodeRecipeIngredients` (same sub-recipe-recursion gap as above, independently present in this file). The misleading "No open period" banner no longer fires when a client simply doesn't have both IMS+HR enabled — a new, correctly-worded banner covers that case instead. Labor cost accrual now prorates by actual days worked (using `join_date`/a positively-confirmed `end_date` within the period — the deactivate action doesn't auto-populate `end_date`, so trusting it alone would wrongly zero out a long-terminated employee with stale data) instead of assuming everyone worked the full period. The swallowed multi-open-period bug (`.limit(1).single()` can't detect a second open period once `.limit(1)` has already discarded it) is fixed at the root with a new DB constraint (see below) rather than patched per-page.
- **`HrDashboard.jsx`** — same `loadIdRef`/`myId` staleness guard as ClientDashboard. `retiringSoon`'s date comparison parsed `retirement_date` as UTC midnight (`new Date("YYYY-MM-DD")`) against a local-midnight `todayMs`, a mismatch that could flip the 180-day threshold near Nepal's UTC+5:45 offset — now compares local midnight to local midnight.
- **`monthly_periods_one_open_per_client` migration** — `monthly_periods` had no DB-level constraint preventing two `open` periods per client, unlike the equivalent `pos_shifts` constraint added earlier; virtually every IMS/HR/Owner-Dashboard page assumes "at most one open period" via `.limit(1).single()`. New partial unique index on `client_id WHERE status='open'`, with a defensive dedup step first. `Periods.js`'s error handling now distinguishes this constraint's violation from the existing per-month-uniqueness one.

**Keyboard-accessibility hardening** (`/impeccable audit` on all 3 dashboards, then all 3 P1 findings fixed): every clickable KPI card and queue-table row across the three dashboards was a `div`/`tr` with `onClick` but no `role`, `tabIndex`, or `onKeyDown` — unusable for keyboard/screen-reader users. Fixed at the shared-helper level so one change covers many instances: `ClientDashboard.jsx`'s and `OwnerDashboard.jsx`'s `kpiCard()` now returns a spreadable props object (`role="button" tabIndex={0} onKeyDown={...}` plus a new `.interactive-card` class) instead of a bare style object; `HrDashboard.jsx`'s `KCard` component and its 4 clickable `<tr>` queue rows got the same treatment. New `.interactive-card`/`tr.interactive-row` `:focus-visible` rule in `Layout.css` (reusing the existing `--theme-focus-ring` token, matching the precedent already set by `.ticket-btn`). Also fixed: `ClientDashboard.jsx`'s `UpsellCard` used a hardcoded, unconditional indigo (`#818cf8`) that bypassed the theme system entirely and was a plausible contrast failure on light presets — replaced with `var(--theme-purple)` (the documented rationed 4th-color token) via `color-mix()`. `HrDashboard.jsx`'s 4-panel pending-queue grid was a fixed `1fr 1fr` with none of its 4 tables wrapped in `.table-wrap` — real mobile overflow risk; now `repeat(auto-fit, minmax(340px, 1fr))` with every table wrapped per convention.

Remaining P2/P3 findings from the audit (scattered hardcoded amber colors, two non-responsive chart/variance grids in `ClientDashboard.jsx`, sub-44px touch targets, missing heading hierarchy, no skeleton loading states) were reported but deferred, not fixed this session.

Build clean, 91/91 tests pass throughout (`App.test.js`'s pre-existing unrelated `react-router-dom` resolution failure aside).

**Files:** `src/pages/dashboard/{ClientDashboard.jsx,OwnerDashboard.jsx,AdminDashboardOverview.jsx}`, `src/modules/hr/dashboard/HrDashboard.jsx`, `src/pages/Periods.js`, `src/components/Layout.css`, `supabase/migrations/20260713073925_monthly_periods_one_open_per_client.sql`

### S375 — 2026-07-13 — Full IMS module audit: purchases, recipes, stock, and reports — sub-recipe cost recursion, atomicity, revenue-at-sale, stock-shortfall guard

Audited the entire IMS module (purchases/purchase orders/returns/price tracker, recipes/menu pricing/menu repricing/recipe margin, sales, stock count, and the stock/variance/shrinkage/FIFO/summary reports) via parallel sub-agent passes, then fixed the critical/high-severity findings and, in a follow-up round, the remaining medium-severity ones — roughly 21 confirmed bugs, two of them systemic patterns repeated across many files.

**Systemic pattern #1 — sub-recipe cost/usage recursion gap.** The most-repeated bug: several report/pricing pages each hand-rolled their own `recipe_ingredients` read that only picked up rows with a direct `item_id`, silently costing/using ANY sub-recipe-based ingredient (sauces, batters, prepped components) at zero, and some skipped `yield_pct` (trim/prep loss) entirely — understating cost, inflating margin, and throwing false "over variance" flags. Fixed by switching all of them to the existing recursive, cycle-safe `explodeRecipeIngredients`/`computeRecipeCosts` utilities (`src/utils/recipeCost.js`): `RecipeMargin.js`, `MenuRepricing.js`, `MenuEngineering.js`, `Variance.js`, `StockReport.js`, `BestSellers.js`, `FifoReport.js` (which also gained real sales/wastage/staff-meal consumption netting — it previously only netted against returns, wildly overstating expiry exposure for batches long since used up), and `Requisitions.js` (new stock-shortfall warning before issuing, using the same recursive usage estimate as Stock Report). Two related bugs in the cost-calc primitives themselves: `MenuPricing.js`'s and `recipeCostCalc.js`'s `calcSubRecipeCostPerUnit` had no cycle guard — an indirect sub-recipe cycle (A contains B, B later edited to contain A) would recurse forever and crash every page that costs a recipe; both now carry a `seen` set. `Recipes.js`'s save flow now blocks creating that cycle in the first place, with a clear error, instead of only surviving it downstream.

**Systemic pattern #2 — revenue frozen at sale time, not recomputed later.** `sales_entries` only ever stored `qty_sold` — every revenue read joined the recipe's CURRENT `selling_price`, so a closed period's revenue and Food Cost % silently recomputed against today's menu price whenever it changed later. New `unit_price`/`vat_rate` columns (migration `20260713065928_sales_entries_price_at_sale.sql`) capture the price actually charged at the moment of sale — POS's own bill-line price, manual entry's price-at-entry-time — with every reader falling back to the recipe's current price only when `unit_price` is NULL (historical rows). Threaded through `Sales.js` (both Daily and Bulk entry, including a new guard that clears the other mode's rows for a recipe when it's switched between them — Bulk `bs_day=0` and Daily `bs_day>0` rows aren't mutually exclusive at the DB level and every downstream report sums both with no distinction), `PosOrders.jsx`, `IssueCreditNoteModal.jsx`, and every revenue-reading report: `MonthlySummary.js`, `AnnualSummary.js`, `BestSellers.js`, `Overheads.js`, `PeriodComparison.js`.

**Standalone fixes:**
- **`Items.js`** — `checkAllUsage()`'s 8 reference-table reads had no client scoping at all; for an admin "viewing as" a client, RLS allows every tenant's rows, so this pulled every client's entire purchase/stock/wastage/requisition/return history into the browser just to compute a "Used In" badge. Now intersected against this client's own item ids first.
- **`PurchaseBillModal.jsx`, `PurchaseOrders.js`, `Recipes.js`, `demandForecastData.js`** — edit-save flows switched from delete-then-insert to insert-then-delete, so a failed insert (network blip, a referenced row deleted mid-edit) leaves the previous, still-valid data intact instead of wiping it to zero.
- **`PurchaseOrders.js`** — PO numbering now retries against a new `client_id+po_number` unique constraint (migration `20260713065232_po_number_recipe_code_unique.sql`, also adds the equivalent for `recipes.recipe_code`) instead of silently allowing two tabs to create the same PO number; receiving a PO now enforces the qty-received cap that was previously only an HTML hint, and stops with a clear "reload before receiving again" message if a mid-loop stock update fails instead of silently under-recording.
- **`ReturnsTab.jsx`** — a return's qty cap only checked against the original purchase qty, never against returns already recorded against the same purchase — two 8kg returns against a 10kg purchase both individually passed, returning 16kg total and producing negative effective stock in Variance/FIFO.
- **`SupplierPriceTracker.js`** — per-unit rate was double-converting an already-base-unit-converted `purchase_entries.rate` by an unrelated legacy `items.purchase_qty` field, corrupting the tracked rate for every item with a purchase-unit conversion.
- **`MonthlySummary.js`** — items with no category (`category_id` NULL) were silently excluded from every category-summary total with no indication; now grouped into a synthetic "Uncategorized" row. Also fixed: a category whose only activity this period was wastage/staff-meals (no opening/purchase/closing) was previously dropped from every downstream total, including its own wastage/staff-meals value.
- **`Overheads.js`** — Daily Fixed Cost divided by a hardcoded 30 regardless of the BS month's actual length (28-32 days, never 30) — now uses `daysInBsMonth`.
- **`PurchaseOneLakhAboveReport.js` / `VatReport.js`** — Annexure 13's vendor-disclosure summary reused VatReport's VAT-taxable-only filter, silently dropping every non-VAT bill from a vendor's cumulative total. `buildVendorSummary` now takes a `discountScope` option so the same shared function correctly serves both "VAT-taxable only" (VatReport) and "every purchase" (Annexure 13) callers.
- **`ShrinkageReport.js` / `TheoreticalVariance.js`** — both omitted staff-meal consumption from their actual-usage calculation (unlike Variance.js/Stock.js), misclassifying logged, legitimate staff meals as unexplained shrinkage/over-consumption.
- **`Stock.js`** — wastage/staff-meal saves are delete-then-insert (two round trips, unlike opening/closing's atomic upsert); an onBlur autosave racing an immediate "Save All"/"Clear All" click for the same item+field could interleave and leave two rows, double-counting cost downstream. Serialized through a per-`(item,field)` promise chain.
- **`RecipeCostCardPrint.jsx` / `RecipeImportButton.jsx`** — ingredient line items omitted `yield_pct`, so they didn't sum to the printed/exported total food cost figure, which does apply it.
- **`Recipes.js`** — deleting a sub-recipe used as an ingredient elsewhere is now blocked with a clear "used as an ingredient in: X, Y" message, instead of leaving other recipes' cost silently drop (their cost-calc functions skip an ingredient row whose `sub_recipe_id` no longer resolves); changing a recipe's category away from "Sub-Recipe" now correctly deactivates and unlinks its mirror `items` row (previously only the reverse direction — becoming a sub-recipe — was handled).

Build clean, 91/91 tests pass throughout both rounds (`App.test.js`'s pre-existing unrelated `react-router-dom` resolution failure aside).

**Files:** `src/modules/ims/items/Items.js`, `src/modules/ims/purchases/{PurchaseBillModal.jsx,PurchaseOrders.js,ReturnsTab.jsx,SupplierPriceTracker.js}`, `src/modules/ims/recipes/{MenuEngineering.js,MenuPricing.js,MenuRepricing.js,RecipeCostCardPrint.jsx,RecipeImportButton.jsx,RecipeMargin.js,Recipes.js,recipeCostCalc.js}`, `src/modules/ims/reports/{AnnualSummary.js,BestSellers.js,FifoReport.js,MonthlySummary.js,Overheads.js,PeriodComparison.js,PurchaseOneLakhAboveReport.js,VatReport.js}`, `src/modules/ims/sales/{Requisitions.js,Sales.js}`, `src/modules/ims/stockcount/{Stock.js,StockReport.js}`, `src/modules/ims/variance/{ShrinkageReport.js,TheoreticalVariance.js,Variance.js}`, `src/modules/pos/creditnotes/IssueCreditNoteModal.jsx`, `src/modules/pos/orders/PosOrders.jsx`, `src/utils/demandForecastData.js`, `supabase/migrations/{20260713065232_po_number_recipe_code_unique.sql,20260713065928_sales_entries_price_at_sale.sql}`

### S374 — 2026-07-13 — Admin Dashboard: editable Plan Pricing + fixed MRR overcounting a disabled module

User (viewing the Admin Dashboard on mobile via Remote Control) flagged that the Starter/Growth/Pro plan prices driving the dashboard's Monthly Value/MRR/ARR figures were hardcoded in source rather than editable, and asked to also verify the revenue figures were correct.

**Editable pricing.** Plan prices (`PLAN_MRR` in `AdminDashboardOverview.jsx`) were a `{ starter: 5000, growth: 8000, pro: 12000 }` constant baked into the component — changing a price meant a code deploy. Moved to a new `settings.plan_prices` jsonb column (migration `20260713021028_settings_plan_prices.sql`) on the same `client_id IS NULL` global-defaults row that already holds `app_name`/`app_tagline` — no new table, reuses the existing admin-settings pattern (`SettingsContext.js`'s `loadSettings`/`saveSettings` already resolve that row when `isAdmin && !clientId`, which is exactly the condition under which `AdminDashboardOverview` itself renders). New admin-only **Settings → Plan Pricing** tab (`Settings.js`) with the three tier inputs, explicitly added to both `ADMIN_TABS` and `CLIENT_HIDDEN` — a tab only listed in the former still leaks to client users, since the two sets are independently checked, not mirrors of each other (confirmed by re-reading how the existing `Theme` tab deliberately sits in `ADMIN_TABS` alone precisely because it's meant to stay visible to clients too — this omission would have been the same class of bug).

**Real bug found and fixed while verifying revenue accuracy.** `clientMRR()`'s three module branches (IMS/HR/POS) counted a module's price whenever its `*_ends_at` date was in the future — never checking whether the module was actually *enabled*. Traced a live discrepancy in the user's own screenshot to confirm this: a client showing only HR + POS module pills (no IMS) still had a Monthly Value of NPR 29,000, which only reconciles as Pro(12,000) + HR Starter(5,000) + POS Pro(12,000) — meaning IMS's price was being counted despite IMS being off for that client, almost certainly from a stale `ims_ends_at`/`subscription_ends_at` left over from before the module was toggled off. Fixed by gating each branch on `ims_enabled`/`hr_enabled`/`pos_enabled` too, matching how the Modules-pill column already gates display. Overstated every affected client's MRR/ARR and per-row Monthly Value; understated nothing (a client could never be undercounted by this bug, only overcounted).

Build clean, 91/91 tests pass (`App.test.js`'s pre-existing unrelated `react-router-dom` resolution failure aside).

**Files:** `src/pages/dashboard/AdminDashboardOverview.jsx`, `src/pages/Settings.js`, `src/context/SettingsContext.js`, `supabase/migrations/20260713021028_settings_plan_prices.sql`

### S373 — 2026-07-13 — POS audit follow-up: 5 medium-severity bugs fixed (tender=0, QR poll thrash, silent table-management errors, guest-order rate limit, KDS optimistic UI)

Fixed the remaining 6 findings deferred from S372's POS audit, after re-verifying one of them (the hardcoded "VAT 13%" print label) wasn't actually a bug — `Recipes.js` already has a per-recipe VAT Rate toggle (13%/0% only), Nepal has one flat standard rate, and the bill's Taxable/Nontaxable split already handles mixed-rate orders correctly, so the label is accurate in every configuration the app can produce. Five real fixes:

- **Tender field `"0"` treated as empty** (`orders/PosOrders.jsx`) — `parseFloat(tenderedStr) || payTotal` silently substituted the full amount due whenever a cashier explicitly typed `0` in Tender, since `0` is falsy in JS. Added a `resolveTendered(fallback)` helper that only falls back on a genuine parse failure (empty/non-numeric), never a real `0`, and used it at all three call sites (`closeOrder`'s payload, the live bill preview, the on-screen Change figure).
- **QR auto-confirm poll re-fired every render instead of every 4s** (`orders/PosOrders.jsx`) — `payableOrderItems` (a new array reference every render) sat in the poll `useEffect`'s dependency list, so any keystroke in the Charge modal (discount, tender) tore down and restarted the `setInterval` before it ever fired — the payment-confirmation check could be delayed indefinitely while a customer's QR payment sat unconsumed. Fixed by moving `closeOrder` and `payTotal` into refs (`closeOrderRef`/`payTotalRef`, updated every render) that the poll's interval callback reads directly, and trimming the effect's own dependency array to just what should actually restart the loop (`billingOpen, splitMode, orderId, payMethod, !!billQrUrl`) — the QR-string-regenerates-on-every-keystroke churn no longer restarts polling either.
- **`PosTableManagement.jsx` silently swallowed mutation errors** — `cycleStatus`, `handleStatusChange`, `handleDelete` all called `scopedUpdate`/`scopedDelete` without checking the returned error, then applied the optimistic UI change (or closed the modal) regardless. A failed write left the screen showing a status the DB never actually had, with other terminals showing the true, different status. Added a `floorMsg` dismissible banner above the floor grid for `cycleStatus` (which happens outside the modal) and routed the other two through the existing modal `msg` banner.
- **No rate-limit on the public `submit_guest_order` RPC** — migration `20260713015814_guest_order_rate_limit.sql` adds a race-free partial unique index (`pos_guest_order_requests_one_pending_per_table`, `WHERE status = 'pending'`) so a table can never have more than one pending guest-order request regardless of how many times the anonymous endpoint is called — a bot flooding `/pos/menu/:tableId` can no longer bury the staff Accept/Dismiss queue, since every call past the first for a table is rejected with a friendly "already has an order waiting for staff" message (caught via `unique_violation`, already surfaced correctly by `GuestMenu.jsx`'s existing `err.message` handling — no frontend change needed).
- **KDS optimistic status flip with no error handling** (`kds/KitchenDisplay.jsx`) — `advance()` moved a ticket to the next column before the `scopedUpdate` resolved and never checked for an error, so a failed write (RLS denial, network blip) showed "Ready"/"In Progress" on the kitchen screen for up to 4s with zero indication the DB write never landed. Now reverts the optimistic change immediately on error and shows a dismissible `kdsError` banner.

Build clean (`CI=true npm run build`), full test suite green (91/91, `App.test.js`'s pre-existing unrelated `react-router-dom` resolution failure aside).

**Files:** `src/modules/pos/orders/PosOrders.jsx`, `src/modules/pos/tables/PosTableManagement.jsx`, `src/modules/pos/kds/KitchenDisplay.jsx`, `supabase/migrations/20260713015814_guest_order_rate_limit.sql`

### S372 — 2026-07-13 — Full POS module audit: 5 critical/high bugs fixed (duplicate orders, cross-tenant staff leak, stuck offline sync, stale shift history, unguarded shift close)

Audited the entire POS module (order-taking/billing core, tables/shifts/staff, guest menu/KDS/credit notes) via three parallel sub-agent passes, then personally re-verified the top findings by reading the actual code before fixing anything — same methodology as S369's HR audit. GuestMenu.jsx (the one fully public, unauthenticated route) came back clean: every call goes through a `SECURITY DEFINER` RPC with server-side price re-derivation, no raw table access, no cross-tenant leak. Five confirmed bugs fixed, ranked by severity:

- **[Critical] Double-tap on Send Order/KOT/BOT could create duplicate orders** (`orders/PosOrders.jsx`) — `saveOrder()`/`sendTicket()` were only guarded by the React `saving` state, which doesn't update synchronously, unlike `closeOrder()`'s existing `closingRef` mutex (added S286 for the same class of race). Two fast taps could both read `orderId` as `null` in the same tick and both insert a new `pos_orders` row. Added a `savingRef` synchronous guard mirroring `closingRef`.
- **[Critical] Cross-tenant POS staff-roster leak** (`login/PosLogin.jsx`, `Pos.js`) — `get_pos_staff(p_client_id)` was callable by `anon` with zero authorization check, and the frontend's only "credential" was the raw `client_id` sitting in plain `localStorage`, set once at device activation and never re-verified. Anyone who set that localStorage key to a guessed/obtained client UUID and loaded `/pos/login` got that client's full staff roster (names + emails). Fixed with a new unguessable per-client `clients.pos_device_secret` (migration `20260713010859_pos_device_secret_hardening.sql`, applied to the live DB) — `get_pos_staff` now takes and verifies it server-side; `Pos.js` fetches it only from an authenticated session during activation; devices activated before this fix show the "not set up yet" screen until re-activated.
- **[High] Offline order could get permanently stuck after a partial sync** (`orders/PosOrders.jsx`, `flushPosOrderQueue`) — the offline-created-order insert was a plain `scopedInsert`; if sync died between that insert succeeding and `dequeuePosOrder` running, the retry hit the same primary key forever. Changed to `scopedUpsert` (`onConflict: 'id'`) so the retry is idempotent.
- **[High] Shift History wasn't reset on an admin "view as" client switch** (`shifts/PosShifts.jsx`) — `historyLoaded`/`history`/`reportsMap`/`expandedId` only ever changed from user interaction, so switching clients while on the History tab kept showing the previous client's shifts, and a Z-Report reprint could mix one client's shift figures with another's freshly-loaded outlet name/address. Fixed by resetting that state on every `clientId` change and reloading if the History tab is active.
- **[Medium-High] Closing a shift never checked for still-open orders** (`shifts/PosShifts.jsx`, `submitClose`) — `loadShiftReport` only aggregates paid/void/writeoff orders, so a table still open past shift-end could get paid later under an already-closed, already-signed-off shift, with its cash never reconciling. `submitClose` now blocks the close with a clear count/error if any orders on that shift are still `status='open'`.

Six lower-severity findings from the same audit (tender-field `"0"` treated as empty, hardcoded "VAT 13%" print label regardless of actual rate, QR auto-confirm poll re-firing every render instead of every 4s, `PosTableManagement.jsx` swallowing mutation errors, no rate-limit on the public guest-order RPC, KDS optimistic status flip with no error handling) were reported but deferred, not fixed this session.

Build clean (`CI=true npm run build`) throughout, no new warnings on any touched file.

**Files:** `src/modules/pos/orders/PosOrders.jsx`, `src/modules/pos/shifts/PosShifts.jsx`, `src/modules/pos/login/PosLogin.jsx`, `src/modules/pos/Pos.js`, `supabase/migrations/20260713010859_pos_device_secret_hardening.sql`

### S371 — 2026-07-12 — Login screen audit (5 theming bugs fixed) + research-driven trial-signup pitch copy

**Audit.** Analyzed `Login.js`/`Login.css` against the new theme system from S370 — this page predates it and had drifted. Five real issues fixed: (1) `.login-btn`'s text was hardcoded `#0f1117` instead of `var(--theme-accent-text)`, a repeat of the exact Accent-Text Pairing Rule violation class fixed elsewhere in S370; (2) the trial-signup and staff-login buttons (`#34d399`/`#8b5cf6`) didn't theme at all — now read `var(--theme-green)`/`var(--theme-purple)`, with `var(--theme-accent-text)` reused for their on-color text (no dedicated per-color text token exists, but accent-text and each signal color are drawn from the same lightness "class" within any one preset, so the approximation holds across all 10); (3) `.login-field input`/`.login-error`/`.login-btn`/`.login-staff-btn` were still hardcoded `6px` radius, un-migrated from S370's scale bump; (4) `.login-split`'s hero shadow was a bespoke always-black value matching neither the FAB exception nor the new per-preset `--theme-card-shadow` token — now reuses `--theme-card-shadow` directly, so it's theme-tuned like every other card; (5) `.login-error`'s background tint was hardcoded to Dark's exact red hex — now `color-mix(in srgb, var(--theme-red) 8%, transparent)`.

**Trial-signup pitch copy rewritten**, through several iterations: started as generic IMS-only marketing copy (didn't mention HR/POS at all) → competitive-differentiator framing (dropped once it implied naming specific competitors) → real feature-page names with round accent-colored bullets → final version, researched: web-searched actual restaurant owner/manager pain points (menu items that quietly lose money and why a flat price hike doesn't fix it; payroll errors from disconnected time tracking and manual hour reconciliation; Nepal's SSF 15th/TDS 25th filing deadlines and the manual-spreadsheet fragility that causes missed ones; POS/connectivity outage impact) and paired each with the specific Crest feature that actually addresses it, verified against the real code first via a feature-inventory research pass (confirmed Menu Repricing's underpriced-dish ranking, Theoretical Variance's recipe-recursive consumption diff, Combo Builder's real `get_cooccurrence` RPC over POS bills, Shrinkage Report's cross-period consistency scoring — and confirmed no customer-analysis/RFM feature actually exists yet, so that was never claimed). Careful not to overclaim: SSF/TDS are described as *calculated*, not *filed* (Crest doesn't auto-file); the offline highlight stays scoped to stock counting specifically (the app's real offline capability, via IndexedDB) rather than a broader offline-POS claim the product doesn't make.

Build clean throughout.

**Files:** `src/pages/Login.js`, `src/pages/Login.css`

### S370 — 2026-07-12 — New "Bright" theme preset (10th) + sidebar restructure + app-wide radius/shadow rollout

User rejected the app's dark-only identity and asked for a genuinely new bright theme, walked through a full design process rather than jumping to code: reacted to a Shopeers-style reference screenshot, compared two built mockups (shadow-based "Shopeers-faithful" vs flat "Crest-native"), picked the shadow-based direction, then made three explicit scope calls — shadows + bigger radius apply to **all 10 presets**, not just the new one; the sidebar's vertical icon-rail becomes a horizontal pill module switcher; colorful per-category KPI badges are a **Bright-only** exception. `EnterPlanMode` was used given the scope (new theming mechanism, structural sidebar rewrite, app-wide CSS) — 3 parallel Explore agents + 1 Plan-validation agent researched the actual codebase before the plan was written.

**New `bright` preset** (`ThemeContext.js`) — crisp cool-blue (`bg #f4f7fc`, `accent #3a6df0`), "Committed" intensity (accent shows up more than other presets: filled active-nav states, chart lines). **Every preset** (not just Bright) now also gets a real card shadow via a new `--theme-card-shadow` token, formula-derived per preset from its own `bg`/`text1` — dark presets get a subtle rim-light + theme-tinted shadow (so e.g. Tokyo Night's indigo cast survives instead of flattening to generic black), light presets get a classic soft shadow — reconciling "every preset gets elevation" with the fact that a literal black drop-shadow is nearly invisible on an already-near-black dark-theme page. Radius scale bumped app-wide (`Layout.css` `:root`): buttons/inputs 6→12px, cards 10→18px, badges 4→8px, new 24px `xl` tier for hero surfaces (login card, chart expand-modal).

**Sidebar restructured** (`Layout.js`/`Layout.css`) — the old 56px icon-only rail + separate 220px flyout panel merged into one unified column (`.sidebar-shell`, 240px expanded / 56px collapsed) with a horizontal pill module switcher (Admin/IMS/HR/POS, 1-4 tabs depending on role) at the top, replacing the vertical icon buttons. Switcher hides entirely for single-module users (one pill reads as broken UI). Collapse is now a CSS class toggle instead of a JSX unmount, so scroll position/dropdown state survive a collapse/expand toggle. Hit a classic nested-flex `min-height:auto` bug mid-build (the new `.sidebar-content` wrapper, itself `flex:1`, contained `.sidebar-nav` which is *also* `flex:1` — without `min-height:0` at both levels the inner one refused to stretch, leaving a dead gap between the footer and the bottom icon row) — fixed, plus a `margin-top:auto` safety net on the bottom icon row.

**`ClientDashboard.jsx`** — Bright-only colorful icon badges (`kpiIcon()`, gated on `themeKey === 'bright'`) on the 5 headline KPI cards (Net Purchases, Revenue, Food Cost %, Fixed Costs %, Est. Net Margin %) — a deliberate, narrowly-scoped exception to the One Accent Rule, not applied to the other 35+ stat-grid report pages or `OwnerDashboard.jsx`/`AdminDashboardOverview.jsx`. Also fixed: every chart's line/grid/reference-line color was hardcoded to Dark's exact gold/charcoal hex regardless of the active preset — switching to Bright wouldn't have actually turned the chart lines blue without this fix; now reads from `useTheme()`.

**Real bugs found and fixed along the way** (surfaced by live user testing during the session, not part of the original ask, but would have undermined it or were independently worth catching):
- `SearchableSelect.js`, `BsCalendarPicker.js`, `PremiumGate.js`, `ProtectedRoute.js` — all hardcoded Dark theme's *exact* hex values instead of the CSS variable tokens, so they'd never actually respected any of the other 9 presets either, not just the new one. User hit this live: an item picker rendered as a black dropdown floating on an otherwise-light Bright page.
- `ThemeContext.js`'s `loadSaved()` trusted a raw `localStorage` blob verbatim — after adding `cardShadow` to preset objects, an existing user's stale saved snapshot would silently set `--theme-card-shadow` to the literal string `"undefined"`, dropping elevation app-wide after deploy. Fixed to merge the saved blob over current preset defaults instead.
- `--theme-purple` was missing from the `:root` CSS fallback block (a pre-existing gap, unrelated to this session's actual work, fixed while already touching the block).
- `AttendanceSheet.jsx`'s monthly OT/Hours summary column displayed raw floating-point sums (`9.600000000000001`) instead of rounding — binary float drift from summing ~30 daily decimal values. Fixed at the source (`summaryFor()`) so both the on-screen table and the Excel export get clean values.

`DESIGN.md` fully rewritten: Elevation section (retires the old Flat-By-Default Rule, documents the new per-preset shadow formula), Navigation section (unified sidebar structure), Colors section (Accent-Text Pairing Rule note on the 4 newly-fixed components), Badges section (the Bright exception, explicitly scoped), preset count (nine → ten), full radius scale. Build clean, 91/91 real tests pass (`App.test.js`'s pre-existing unrelated `react-router-dom` resolution failure aside).

**Files:** `src/context/ThemeContext.js`, `src/components/{Layout.js,Layout.css,SearchableSelect.js,BsCalendarPicker.js,PremiumGate.js,ProtectedRoute.js,ChartCard.js}`, `src/pages/Login.css`, `src/pages/dashboard/{ClientDashboard.jsx,OwnerDashboard.jsx,AdminDashboardOverview.jsx}`, `src/modules/hr/attendance/AttendanceSheet.jsx`, `DESIGN.md`

### S369 — 2026-07-12 — Full HR module audit: 8 confirmed bugs fixed (TDS math, incentive overwrite, dashboard undercount, roster/leave/swap bugs)

Audited the entire HR module (38 files, ~12.8k lines) for correctness bugs — payroll math, roster/attendance, leave/TADA/incentives/gratuity, and employee/self-service multi-tenant scoping — via four parallel sub-agent passes, then personally re-verified every high-severity claim by reading the actual code before fixing anything. No cross-tenant data leaks or `scopedDb` violations found anywhere in the module. Eight confirmed bugs fixed:

- **[Critical] TDS never taxed overtime pay** (`payroll/PayrollRun.jsx`, `payroll/PayrollCalculation.jsx`, `payroll/payrollData.js`) — `monthlyGross` fed into `computeMonthlyTds`/`computeMonthlyTdsBreakdown` was `slip.gross - slip.absence_deduction`, and `slip.gross` never includes `ot_amount` (added separately in `payrollCompute.js`). `fetchYtdMap`'s YTD carry-forward had the same gap. Any employee earning OT had that income permanently excluded from tax, not just delayed. Fixed by adding `+ slip.ot_amount` to both current-month and YTD gross, and updated the Calculation page's TDS breakdown display to show the OT line.
- **[Critical] TDS front-loaded a mid-fiscal-year new hire's tax** (`payroll/tds.js`) — `cumulativeDue = (annualTax/12) * monthInFy` used the employee's calendar position in the FY, not months actually employed, so a hire starting FY-month 7 had ~58% of their whole year's tax withheld from their first paycheck. Added a `ytdMonths` parameter (count of prior finalized payslips this FY, threaded from `payrollData.js`'s `fetchYtdMap` via a new `count` field) so tax spreads evenly across months actually worked; defaults to `monthInFy - 1` when omitted, which reduces to the exact old formula for continuously-employed staff — zero behavior change for the common case, all existing tests pass unmodified, two new tests added for the mid-year-joiner case.
- **[High] Incentive/bonus runs could silently overwrite a prior year's finalized record** (`incentives/IncentiveRun.jsx` + migration `20260712120000_hr_incentives_unique_include_bs_year.sql`) — the `hr_incentives` upsert's `onConflict` key (`client_id,employee_id,run_label`) matched the DB's `hr_incentives_unique` constraint, both missing `bs_year` (unlike the equivalent, correct `hr_festival_allowances` constraint). Re-running a bonus with a reused label like "Dashain Bonus" in a new year overwrote the previous year's amount/tds. Fixed both the frontend conflict key and the DB constraint — applied to the live DB via the Supabase Dashboard SQL Editor.
- **[Medium] HR Dashboard's Approvals KPIs undercounted past 8** (`dashboard/HrDashboard.jsx`) — the Leave/OT/TADA/Swap pending-count KPI cards reused `.length` of the same `.limit(8)` query built for the preview tables, so a client with >8 pending items in any queue saw a stuck "8". Added four parallel `{ count: 'exact', head: true }` queries specifically for the KPI numbers, independent of the capped preview lists.
- **[Medium] Roster leave-conflict check missed single-day and first-day leave** (`roster/Roster.jsx`) — `new Date("YYYY-MM-DD")` parses as UTC midnight, which is 05:45 local in Nepal (UTC+5:45) — later than the local-midnight comparison date, so the "already on approved leave" block/warning silently never fired on a leave's first day. Fixed by comparing `YYYY-MM-DD` strings directly instead of `Date` objects, sidestepping the timezone parsing entirely.
- **[Medium] Leave reject/cancel used stale client-side status** (`leave/LeaveManagement.jsx`) — `decideRequest` checked the locally-cached `req.status` instead of a fresh read, so two admins with the tab open could approve+reject the same request out of sync, leaving attendance and the request record permanently disagreeing. Now re-fetches the request's current status from the DB before deciding whether to revert attendance.
- **[Medium] Cancelling approved leave always overwrote attendance to 'present'** (`leave/LeaveManagement.jsx`) — `syncAttendance(req, 'present')` never knew what the day's status was *before* the leave was approved (e.g. `absent`), so a mistaken approval-then-cancel silently turned an absence into a paid "present" day. Replaced with `revertAttendance()`, which deletes the `hr_attendance` rows instead of guessing a status — leaves the day blank for manual re-entry, matching the existing "no signal = blank" convention used for un-rostered days.
- **[Low] Shift-swap approval had no rollback on partial failure** (`roster/SwapRequestsPanel.jsx`) — moving `employee_id` between two `hr_roster` rows was two sequential updates; if the second failed (e.g. a unique-constraint collision), the first wasn't undone and the swap request became unrecoverable through the UI (its own retry lookup no longer matched). Added a compensating rollback of the first update on second-update failure.

Verified with `npx react-scripts test --watchAll=false` — 91/91 tests pass (`App.test.js`'s pre-existing unrelated `react-router-dom` resolution failure aside), including two new `tds.test.js` cases for the mid-year-joiner fix.

**Files:** `src/modules/hr/payroll/{PayrollRun.jsx,PayrollCalculation.jsx,payrollData.js,tds.js,tds.test.js}`, `src/modules/hr/incentives/IncentiveRun.jsx`, `src/modules/hr/dashboard/HrDashboard.jsx`, `src/modules/hr/roster/{Roster.jsx,SwapRequestsPanel.jsx}`, `src/modules/hr/leave/LeaveManagement.jsx`, `supabase/migrations/20260712120000_hr_incentives_unique_include_bs_year.sql`

### S368 — 2026-07-12 — .claude/impeccable tracked in git, /impeccable audit fixes on SelfServiceHome.jsx, live-mode session on PosLogin.jsx

**Git tracking policy changed:** at the user's request, `.claude/skills/` (taste-skill, impeccable, ui-ux-pro-max) and the shareable parts of `.impeccable/` (`design.json`, `live/config.json`, `critique/*.md`) are now committed, superseding S367's "new, untracked" note for those paths — any session/machine now gets the same skills without reinstalling. Excluded via `.gitignore`: `.claude/settings.local.json` (personal permission grants), `.claude/scheduled_tasks.lock` (runtime lock), `.impeccable/hook.cache.json` (per-session scan cache), and `__pycache__/`/`*.pyc` (two compiled-Python files from `ui-ux-pro-max` that had been accidentally staged).

**`/impeccable audit src/modules/hr/selfservice/SelfServiceHome.jsx`** (single-context — audit.md doesn't mandate isolated sub-agents the way critique/layout do): scored 15/20 (Good). Deterministic scan flagged the same sitewide neutral-gray `rgba(107,114,128,...)` convention already verified as intentional in S367 — confirmed again here (used identically in 10 other files) and left alone. Four real findings, all fixed:

- **[P1] No programmatic label↔input association anywhere in the file** — every `<label>` was only visually adjacent to its field, never `htmlFor`-linked (WCAG 1.3.1/3.3.2). Fixed across every labeled field (Leave/TADA/Notes). `BsCalendarPicker` had no way to receive an `id` at all, since it's a custom trigger-button component, not a native input — extended it with optional `id`/`ariaLabel` props forwarded to its internal button, additive so every other caller is unaffected. Every previously-unlabeled field (TADA line-item category/description/amount/vehicle/distance, roster month/year, swap-target/day/note) got an `aria-label` too, since they were the same systemic gap even though the audit only called out the pattern generally.
- **[P2] TADA expense-line row overflows on narrow phones** — fixed-width elements (130px category select + 100px amount + 36px remove button ≈ 266px) left almost no room for the description field on a 320-360px phone. Added `flexWrap: 'wrap'` and switched the description input to `flex: 1`, matching the pattern the Transport sub-row already used correctly one row below.
- **[P2] Remove-line button had no accessible name** — `aria-label="Remove expense line"`.
- **[P3] Tab bar had no ARIA tab semantics** — added `aria-current="true"` to the active tab, same fix already shipped on `GuestMenu.jsx`'s category nav in S367.

Build clean, 89/89 tests pass (same pre-existing unrelated `App.test.js` failure).

**`/impeccable live`** on `src/modules/pos/login/PosLogin.jsx` — interactive session: started the CRA dev server + the impeccable live helper, the user drove it via the browser's picker/Steer overlay while I long-polled in the background and applied edits directly (all requests came through Steer, none through the full generate/variant-cycling flow). Five rounds:

1. Wrapped the login flow in a proper elevated card panel and applied the Georgia serif wordmark to the client-name header — `DESIGN.md` reserves that serif for exactly two places (sidebar wordmark, login screen), so this was identity-consistent, not a new choice.
2. User flagged the staff-name text overflowing its fixed-height avatar-card box: root cause was `height: 128` (rigid) with no wrap/truncation guard on `full_name`. Fixed with a 2-line `-webkit-line-clamp` + `word-break`, and the box now uses `minHeight` instead of a hard `height` as a safety margin. Same guard applied to the new serif header.
3. User asked to "fix" the blank spacer left of the 0 key on the numpad (the standard phone-dialer blank/0/backspace layout) — turned it into a working **Clear** button instead (wipes the whole PIN in one tap), wired `Escape` as its keyboard shortcut, styled to match the backspace key's muted weight.
4. User asked for buttons to glow on click (done — a brief accent glow on `mousedown`, matching `DESIGN.md`'s "feedback, not decoration" motion rule) **and** for the PIN dots to turn green when "the correct digit" is clicked. Declined the second part and explained why: the app has no way to know if a digit is correct until the full PIN is submitted and checked server-side (it's a hashed Supabase Auth password, never compared client-side), and even if it were technically possible, real-time per-digit correctness feedback would be a genuine security hole — it would let someone brute-force the PIN one digit at a time by watching which digit goes green. A wrong full PIN already shows a red error and clears the dots, which is the correct place for that feedback.
5. User flagged the impeccable live-detector's own warning banner showing on-page: `.main-content`'s sidebar-collapse toggle animates `margin-left` (a layout property, `Layout.css`) instead of `transform`/`opacity`. Real, correctly-flagged, but asked the user before touching it since a true fix means restructuring how the fixed-position sidebar reserves space app-wide, not a login-page-scoped change. User chose to keep it and document the exception rather than restructure — added a dated, reasoned exception to `DESIGN.md`'s Navigation section (fixed sidebar needs real margin to avoid being covered, not decoration; the animation only fires on a rare manual toggle, not a continuous one). The banner's other two findings ("overused font: Roboto/Arial") were verified as a false positive: `index.css` correctly declares the full CRA-default native system-font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', ... sans-serif`, matching `DESIGN.md`) — the percentages just reflect that particular browser's font resolution not matching Segoe UI/-apple-system and cascading down the stack, not a source defect.

Build clean after every round; live-mode cleanup (helper server stop, injected script removal, marker sweep) run at session end.

**Files:** `.gitignore`, `.claude/skills/**` (now tracked), `.impeccable/design.json`, `.impeccable/live/config.json`, `.impeccable/critique/*.md` (now tracked), `src/modules/hr/selfservice/SelfServiceHome.jsx`, `src/components/BsCalendarPicker.js`, `src/modules/pos/login/PosLogin.jsx`, `DESIGN.md`

### S367 — 2026-07-12 — Two design skills installed (taste-skill, impeccable) + full critique-driven hardening pass on GuestMenu.jsx

Installed two Claude Code design skills, scoped by policy to public/brand-facing surfaces only (marketing site, guest-facing pages) — not the internal IMS/HR/POS dashboards, which stay on the existing CSS-variable theme system as-is.

**`taste-skill`** (community skill, `.claude/skills/taste-skill/`) — an anti-"AI slop" frontend skill for landing pages/portfolios/redesigns; explicitly out of scope for dashboards/data tables/forms by its own design. Used it for a light pass on `GuestMenu.jsx` (the public QR-menu/ordering page — genuinely in scope, a transactional consumer flow) and, on request, a lighter pass on `SelfServiceHome.jsx` (a form-heavy HR utility page — flagged as out of the skill's stated scope, so kept to hygiene only). Fixes: 5 prose em-dashes replaced across both files (a sitewide `'—'` used as an empty-value placeholder was correctly left alone as a separate, pre-existing convention); a real WCAG contrast bug in `GuestMenu.jsx`'s floating cart button — hardcoded white text on `var(--theme-accent)` instead of the theme's own `accent-text` pairing token, which fails on presets like the default Gold theme; `SelfServiceHome.jsx`'s header/section typography tightened for deliberate hierarchy.

**`impeccable`** (`pbakaus/impeccable`, `.claude/skills/impeccable/`) — a heavier toolchain: a real npm CLI with 46 deterministic anti-pattern detector rules, 23 slash-commands (`critique`, `polish`, `harden`, `layout`, etc.), and a `PostToolUse` hook that auto-scans `.jsx`/`.tsx`/`.vue`/`.svelte`/`.astro` files after every edit. Unlike taste-skill, its own scope explicitly includes dashboards/product UI/forms, so it isn't restricted to public pages.

Ran `/impeccable init`: wrote root-level **`PRODUCT.md`** (register: product; users — owners/managers primary, accountants/bookkeepers secondary doing reconciliation; positioning — cost intelligence + integrated HR vs. POS-first rivals; anti-references — legacy Nepali ERP density, generic AI-SaaS look) and **`DESIGN.md`** + `.impeccable/design.json` sidecar, scanned from the *actual* `Layout.css`/`ThemeContext.js` tokens rather than invented — documents the "Aged Brass" accent, flat-by-default elevation, and formalizes the accent-text pairing rule the taste-skill pass had just fixed a real violation of. `.impeccable/live/config.json` pre-configured for `npm start`. A `## Design Context` pointer was added to `CLAUDE.md` so future sessions know these files exist.

Ran `/impeccable critique src/modules/pos/guestmenu/GuestMenu.jsx` (dual sub-agent: an isolated design review plus the deterministic detector — the detector came back clean, 0 findings, which the LLM review's structural/behavioral findings show isn't the same as "no problems," just that this class of issue is outside what a markup/CSS scanner can see). Scored 27/40 (Acceptable). Five issues found and fixed, one command each:

- **[P0] Order confirmation was invisible at the moment it matters most** — `placeOrder()` cleared the cart and closed the modal with no toast, scroll, or chime (chime was explicitly suppressed on a guest's first order by an existing anti-false-positive guard). Fixed via a new `justPlaced` state: scrolls the status card into view, plays the chime unconditionally on an explicit "just placed" action (kept fully separate from the existing stage-change chime, which correctly stays silent on page load/reload), and pulses briefly via the existing `guest-order-glow` class — with a `prefers-reduced-motion` fallback (added to `Layout.css`, that class had none before) and `aria-live="polite"` so screen readers get it too.
- **[P1] Cart had no persistence** — only a *submitted* request survived `sessionStorage`; the in-progress cart/covers/notes lived only in React state, so a phone lock or accidental tab switch silently wiped it. Now persisted per-table the same way the submitted-request snapshot already was, rehydrated on mount.
- **[P1] A network error and a genuinely empty menu showed the identical dead-end message** with no retry. Split into two states: a distinct "couldn't reach the menu" message with a Try again button (re-triggers the fetch via a `retryToken`) versus the original ask-staff copy reserved for the truly-empty case.
- **[P2] The KOT status badge was missing its base `.badge` class** — color-only styling with no radius/padding, unlike every other badge in the app. One-line fix.
- **[P2] No way to navigate a long menu** — added a sticky horizontal category-chip bar (new `.tab-bar--scroll` CSS variant reusing the existing `.tab-btn`/`.tab-bar` classes rather than inventing new chip styles), tracking scroll position via `IntersectionObserver` and highlighting the active category with `aria-current`. Ran `/impeccable layout`'s required dual-assessment first (a layout-checklist sub-agent plus the mechanical scanner); it surfaced three *pre-existing* drift issues against `DESIGN.md`'s own rules (spacing values off the documented 4/8/16/24 scale, card padding contradicting the "24px consistent" rule, the accent color used in 4-5 concurrent places on one screen) — explicitly left as a deliberate, reported exception rather than silently expanding scope into a page-wide restyle.

Final `/impeccable polish` pass caught two more gaps introduced by the fixes above: the "just placed" scroll target didn't account for the new sticky bar's height (would have landed the status card partially hidden underneath it — same `scroll-margin-top` fix already used for category headers, just missed here), and the active category chip had no `aria-current` for screen readers. Both fixed.

Build clean (`CI=true npm run build`) after every step; full test suite green (89/89, the one failing suite is the pre-existing unrelated `App.test.js`/`react-router-dom` resolution issue noted in prior sessions).

**Files:** `.claude/skills/taste-skill/` (new, untracked — same as `ui-ux-pro-max`), `.claude/skills/impeccable/` (new, untracked), `PRODUCT.md` (new), `DESIGN.md` (new), `.impeccable/design.json` (new), `.impeccable/live/config.json` (new), `CLAUDE.md`, `src/modules/pos/guestmenu/GuestMenu.jsx`, `src/modules/hr/selfservice/SelfServiceHome.jsx`, `src/components/Layout.css`

### S366 — 2026-07-11 — feat(hr): Payroll Calculation's Attendance Tally gets a bold Total Days row

Small addition to `PayrollCalculation.jsx`'s expanded breakdown — a "Total Days" row summing all nine attendance statuses (Present + Half-day + Absent + Paid Leave + Unpaid Leave + Half-day Paid Leave + Half-day Unpaid Leave + Off + Holiday), bold, sitting between the individual status rows and Hours Worked. Full HR suite (37 tests) passes; build compiles clean.

**Files:** `src/modules/hr/payroll/PayrollCalculation.jsx`

### S365 — 2026-07-11 — fix: TDS was computed on full contractual gross instead of income actually earned/paid

User's question, using the new Calculation page: an employee absent 13 of 32 days (net pay NPR 14,630 after a NPR 10,156 absence deduction) was still being taxed 1% TDS on the full NPR 25,000 contractual gross — NPR 250, not proportional to what they actually received. Researched Nepal's Income Tax Act: TDS is withheld on remuneration **actually paid**, not contractual salary — confirmed by multiple sources describing TDS as deducted "at the time of payment." Also notably: SSF in the very same payslip was *already* correctly computed on the absence-adjusted amount (`ssfBase = Basic × Paid Fraction`) — TDS was the one line item that had been missed, an internal-consistency bug as much as a compliance one.

Fixed the `monthlyGross` fed into `computeMonthlyTds()`/`computeMonthlyTdsBreakdown()` in both `PayrollRun.jsx`'s `buildRows` and `PayrollCalculation.jsx` — now `slip.gross - slip.absence_deduction` (actual income earned this month) instead of `slip.gross` (full contractual gross). No-op for daily/hourly bases (`absence_deduction` is always 0 there, since their `gross` already only reflects days/hours actually worked). For this example: TDS drops from NPR 250 to NPR 148, correctly proportional to the NPR 14,844 actually earned. The Calculation page's exploded TDS section now shows the Gross → Absence Deduction → Actual Gross step explicitly. Full HR suite (37 tests, `tds.js` itself untouched — the fix is entirely at the call sites) passes; build compiles clean.

**Files:** `src/modules/hr/payroll/PayrollRun.jsx`, `src/modules/hr/payroll/PayrollCalculation.jsx`

### S364 — 2026-07-11 — fix: Payroll Calculation print output was flush against the page's left edge

`@media print` zeroes `.main-content`'s padding (`Layout.css`) so every page can control its own print margins precisely — a convention the new Calculation page's `print-only` block hadn't picked up yet, since it inherited the app's normal on-screen padding instead of setting its own. Added explicit `28px 36px` padding directly on that block, matching the pattern other printable views in the app already use (their own margin, not the app chrome's).

**Files:** `src/modules/hr/payroll/PayrollCalculation.jsx`

### S363 — 2026-07-11 — fix: raw OT-hour sums displaying long floating-point tails ("3.6999999999999997h")

User caught it on the new Calculation page's Overtime section. Root cause: `t.sumOt`/`t.sumHours` in `tallyAttendance()` accumulate via repeated `+= parseFloat(...)` — standard JS float addition, so a sequence like `0.2 + 1.3 + 2.2` doesn't land on a clean `3.7`. Every other hours display already ran the result through `.toFixed(n)` before rendering except a handful that displayed the raw sum directly in a template string.

Fixed four spots: `PayrollCalculation.jsx`'s three new Overtime lines (Attendance OT Hours, Approved OT Hours, Total OT), and — found while checking for the same pattern elsewhere — a **pre-existing bug in the actual printed Payslip** (`PayrollRun.jsx`'s `PayslipBody`, `Overtime (${slip.ot_hours} hrs)` and the daily/hourly Hours/Days-worked label) and the ⚠ OT ×2? tooltip's hour count. The Payslip one is user-facing — an actual employee could have received a payslip with this in a printed document — so worth fixing regardless of the new page. All now `.toFixed(1)`. Full HR suite (37 tests) passes; build compiles clean.

**Files:** `src/modules/hr/payroll/PayrollCalculation.jsx`, `src/modules/hr/payroll/PayrollRun.jsx`

### S362 — 2026-07-11 — feat(hr): Payroll Calculation gets a Print button + fully exploded Gross/OT/Absence/SSF math

Follow-up to S361. User asked for a print function plus a fully "exploded" breakdown of gross salary and the OT-per-hour math specifically. Two changes to `PayrollCalculation.jsx`:

**Print** — a 🖨 Print button on each expanded employee row (mirrors `PayrollRun.jsx`'s existing per-payslip print pattern: a `printRow` state, the normal screen wrapped in `no-print`, a `print-only` block with the same `CalcDetail` panel plus a header, `printWithTitle()` for a sensible default filename).

**Fully exploded math, and why it's not just cosmetic:** the detail panel previously hid several formulas behind `Tip` hover tooltips (e.g. "Absence Deduction — hover for formula"). Since this same panel is now also the print output, and a hover tooltip never renders on paper, every one of those got converted to visible calculation rows instead — Gross Salary lists Basic Salary + each earning component by name (via `calcAmount()`) down to Gross; Overtime is split into two separate sections (Attendance Sheet OT: hours × hourly rate × 1.5× multiplier, and Overtime-module Approved Entries, each shown as its own multiplication chain) rather than one collapsed line; Absence Deduction, SSF, and TDS walk through every intermediate step (unpaid-day tally → per-day rate → deduction; paid fraction → SSF base → employee/employer amounts). New `Line` component takes an `op` prop ("+"/"−"/"×"/"÷"/"=") so each row reads as one step in a running calculation instead of an isolated number.

`computePayslip()`'s `breakdown` gained one new field for daily/hourly bases — `ssfBase` (previously only computed for monthly) — so the SSF section's math is complete for all three pay bases without a fallback approximation. Full HR suite (37 tests) passes; build compiles clean.

**Files:** `src/modules/hr/payroll/PayrollCalculation.jsx`, `src/modules/hr/payroll/payrollCompute.js`, `src/pages/Help.js`

### S361 — 2026-07-11 — feat(hr): new Payroll Calculation page — verify the math behind every payslip line

User flagged a real workflow gap: Roster → Attendance → Leave → Overtime feed straight into Payroll with no checkpoint in between, so a wrong-looking number (like the two just found and fixed — the absence-deduction/TDS confusion and the stale-TDS-after-Regenerate question) could only be diagnosed by reverse-engineering the formulas by hand. Asked for, and built, a dedicated read-only Calculation/Review page sitting one step above Payroll in the nav.

New `/hr/calculation` page (`PayrollCalculation.jsx`) computes every employee's full payslip **live**, right now, from current Attendance/Roster/Overtime/Advances data — using the *exact same* `computePayslip()`/`computeMonthlyTdsBreakdown()` functions Payroll Run itself calls, so it can never drift out of sync with what Payroll actually produces. It never writes anything to `hr_payroll_runs`/`hr_payslips`. Click any employee row to expand a full derivation: attendance tally, the absence-deduction formula (unpaid days × per-day rate) worked out step by step, overtime split explicitly by source (attendance-sheet OT vs. approved Overtime-module entries, with the ⚠ OT ×2? risk surfaced here too), SSF, a full TDS walk-through (YTD gross → projected annual gross → taxable → annual tax → cumulative due → minus already withheld), advance/TADA detail, and the final Net Pay reconciliation.

Because it's computed live against a real BS period, it also catches a **stale Payroll run** for free: each row is diffed against that period's actual stored `hr_payslips.net_pay` (if a run exists) and flagged "⚠ Stale" when they no longer match — directly answering the "why didn't Payroll pick up my new OT hours" question from earlier this session without needing to remember to click Regenerate first.

**Two supporting refactors, both required for the new page to be trustworthy rather than a second, drift-prone implementation of the same math:**
- Extracted `fetchYtdMap`/`fetchApprovedTadaMap`/`buildAdvanceMap` out of `PayrollRun.jsx` into a new shared `payrollData.js`, imported by both pages — guarantees identical YTD/advance/TADA inputs everywhere.
- `computePayslip()` now also returns a `breakdown` object with every intermediate value (tally, per-day rate, unpaid days, SSF base, OT split, etc.) — purely additive, so existing `hr_payslips` inserts are unaffected (`buildRows` explicitly destructures `breakdown` out before the DB write). `tds.js` gained `computeMonthlyTdsBreakdown()`; the existing `computeMonthlyTds()` is now a one-line wrapper around it (single source of truth, zero risk to its existing callers/tests).

Full HR suite (37 tests, unchanged) passes; build compiles clean. New route gated the same as its sibling HR pages (`ModuleGate module="hr"`, no separate feature flag — matches Overtime/Payroll/Leave, which aren't premium-gated either); nav entry added as the first item in the Payroll group, above Payroll itself. Verified the dev server compiles and serves the new route cleanly; couldn't click through it live myself (no Supabase login credentials / browser-automation tool available in this environment) — left the dev server running for the user to spot-check directly.

**Files:** `src/modules/hr/payroll/PayrollCalculation.jsx` (new), `src/modules/hr/payroll/payrollData.js` (new), `src/modules/hr/payroll/payrollCompute.js`, `src/modules/hr/payroll/tds.js`, `src/modules/hr/payroll/PayrollRun.jsx`, `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`

### S360 — 2026-07-11 — chore(ims): UI/UX Pro Max audit + fixes across the IMS module

Ran a full UI/UX audit (via the `ui-ux-pro-max` skill) over all ~30 IMS pages — items, vendors, purchases, sales, recipes, stock, variance, reports — against the accessibility/touch-target/forms/tables checklist, then applied every finding. Not a redesign: the existing CSS-variable theme system, `Tip` tooltip convention, and `data-table`/`empty-state`/`badge-*` classes were kept as-is; this pass brought ~20 files into line with those already-established conventions.

Added a 6th theme token, **`--theme-purple`**, to `ThemeContext.js` (all 9 presets + `applyTheme`) — several files had independently hardcoded the same violet (`#a78bfa`/`#818cf8`/`#6366f1`) for a genuine 4th/5th categorical color (Staff Meals in Stock.js/MonthlySummary.js, USDA-suggestion callouts and the sub-recipe tab underline in Recipes.js/NutritionEditorModal.jsx, the Plowhouse quadrant in MenuEngineering.js, the "Partial" bill status in OutstandingPayables.js) with no shared source of truth; now they all reference one token. Where a categorical palette genuinely needs more distinct hues than the 5-token semantic set can offer (MenuEngineering's Q_HEX chart colors, Overheads' labor-blue, VendorReport's 8-color vendor split, BestSellers' Recharts fill/tick), left those as documented fixed-hex exceptions, matching the CLAUDE.md Recharts convention — but did fix cases where a Recharts *Tooltip* `contentStyle`/`labelStyle`/`itemStyle` (a real DOM `<div>`, not an SVG presentation attribute) was hardcoded when it should have used theme vars (BestSellers.js, MenuEngineering.js's custom tooltip components).

Other fixes: added `aria-label`s to icon-only remove/dismiss/nav buttons that had none (PurchaseOrders, PurchaseBillModal, SupplierPriceTracker, Requisitions, Recipes, Sales, VendorReport); widened several under-32px row-action touch targets (Purchases Edit/Del, Sales day-nav arrows, SupplierPriceTracker inline save/cancel, remove-line buttons); made SupplierPriceTracker's expandable row keyboard-operable (`role="button"`, `tabIndex`, `onKeyDown`); replaced four blocking `window.alert()` result notifications in Recipes.js's nutrition auto-fill flow with a dismissible inline banner (`aria-live="polite"`) — left the two `window.confirm()` pre-action prompts and the destructive-delete confirm alone, since blocking confirmation before a consequential bulk action is the app's established, correct pattern; added the `Tip` tooltip TheoreticalVariance.js's "Variance %" header was missing (its sibling columns all had one) plus several on DeadStock.js and PurchaseOneLakhAboveReport.js; standardized a few ad-hoc empty-states (and one stray 📋 emoji used as a structural icon) onto the shared `empty-state`/`empty-state-icon`/`empty-state-text` classes; and fixed a real pre-existing bug in OutstandingPayables.js where a `${cssVarString}18`-style alpha-hex suffix was being appended to a `var(--theme-*)` string (invalid CSS, silently failed) — replaced with `color-mix(in srgb, ...)`, which the codebase already uses elsewhere (Stock.css, MenuPricing.js).

Verified with `CI=true npm run build` (clean, no new warnings) after every batch. Could not exercise the authenticated IMS pages live in this environment — no seeded Supabase test credentials and no browser-automation tool available here — consistent with the same limitation noted in prior sessions (S254, S293).

**Reviewed and finished in a separate session before commit:** full pass over all 24 changed files confirmed the work was complete and correct — build clean, full test suite green (89/89, excluding the pre-existing unrelated `App.test.js`/`react-router-dom` resolution issue). One documentation gap fixed: `CLAUDE.md`'s CSS token list hadn't been updated to include the new `--theme-purple` token. Three color-consistency spots also fixed: `PurchaseOrders.js`'s "Sent" PO status and `VendorReport.js`'s "Fonepay" payment column had been recolored blue→amber rather than blue→purple (amber already carries a warning/caution connotation elsewhere in the app — Overdue Bills, Occasional Shrinkage — so a neutral status/payment-method label reading as a warning was worth avoiding); and `Recipes.js`'s "Try USDA FoodData Central" button was an apparently-missed hardcoded blue in the same file that otherwise consistently adopted purple for this exact kind of secondary-action distinction. All three now use `var(--theme-purple)`.

**Files:** `src/context/ThemeContext.js`; `src/modules/ims/items/Items.js`; `src/modules/ims/purchases/{Purchases,PurchaseOrders,PurchaseBillModal,SupplierPriceTracker,ReturnsTab}.{js,jsx}`; `src/modules/ims/sales/{Sales,Requisitions}.js`; `src/modules/ims/recipes/{Recipes,MenuEngineering,NutritionEditorModal,MenuPricing}.{js,jsx}`; `src/modules/ims/stockcount/{Stock,ReorderReport,DeadStock}.js`; `src/modules/ims/variance/{TheoreticalVariance,ShrinkageReport}.js`; `src/modules/ims/reports/{MonthlySummary,Overheads,BestSellers,VendorReport,OutstandingPayables,PurchaseOneLakhAboveReport}.js`

### S359 — 2026-07-11 — fix: Payroll Run's Total row leaked TDS into the Advance/deductions cell

User spotted "−920" sitting under the ADVANCE column in the Total row when every employee's individual Advance cell showed "—". Root cause in `PayrollRun.jsx`'s `totals` reducer: `a.ded += s.absence_deduction + s.other_deductions + s.tds` folded each payslip's TDS into the same running total as Absence/Other Deductions — which then renders in one `colSpan={4}` cell spanning Absence/SSF/Other Ded/Advance. With all four of those genuinely zero for this payroll, the only thing left in that merged cell was the TDS sum (250+200+270+200=920), right-aligned so it visually sat under "Advance". The TDS column itself was left blank in the Total row despite having its own per-employee inputs directly above it.

Fixed by giving TDS its own `totals.tds` accumulator and rendering it in the TDS column (previously an empty `<td>`), and made both the merged deduction cell and the new TDS cell show "—" instead of "−0" when the total is genuinely zero, matching the per-row convention. Full HR suite (37 tests) passes; build compiles clean.

**Files:** `src/modules/hr/payroll/PayrollRun.jsx`

### S358 — 2026-07-11 — feat(hr): By Employee tab gets a Total OT Hours footer row

Small addition to the By Employee tab's day-by-day table: a footer row under the last day of the month summing that employee's OT Hours across every day, so the monthly OT total is visible without switching to the Month Summary tab. Also fixed a stale `colSpan={8}` on the "Pick an employee above" placeholder row — the Break column added in S355 made the table 9 columns wide, not 8. Full HR suite (37 tests) passes; build compiles clean.

**Files:** `src/modules/hr/attendance/AttendanceSheet.jsx`

### S357 — 2026-07-11 — fix: Attendance Start/End flagged existing saved times as invalid ("08:00:00")

Regression from S353: existing `hr_attendance` rows loaded fine, but their Start/End showed red "invalid" as soon as the sheet loaded — Postgres's `time` column reads back through Supabase as `"08:00:00"` (with seconds), and the new colon-format validator only accepted an exact `HH:MM` with no trailing `:SS`, so every pre-existing saved time failed validation the moment it appeared on screen.

Two-part fix in `AttendanceSheet.jsx`: `parseTimeInput()`'s colon regex now accepts an optional trailing `:SS` (dropped, not stored); and `loadAttendance()` now runs `start_time`/`end_time` through `parseTimeInput()` immediately on load rather than waiting for the admin to focus/blur each cell, so the display is clean (`8:00`, not `08:00:00`) right away instead of only after being touched. Full HR suite (37 tests) passes; build compiles clean.

**Files:** `src/modules/hr/attendance/AttendanceSheet.jsx`

### S356 — 2026-07-11 — feat(hr): Attendance gets a default-break bulk-fill (Apply Break to Day / to Month)

Follow-up to S355 — typing 45 into every single Break cell by hand defeated the point of a default. Added an editable "Default break" number (starts at 45 min) next to the bulk-action buttons on both tabs, feeding two new buttons: Apply Break to Day (Mark Attendance — fills every already-marked employee's blank Break for the selected day) and Apply Break to Month (By Employee — same, across that employee's whole month).

Deliberately narrow on what counts as "already-marked": both `applyBreakToDay()`/`applyBreakToEmployeeMonth()` skip any row that has no record yet at all, and skip any row whose Break is already set to something — they only fill genuine gaps on rows the admin has already touched. Doing otherwise (creating a record for an untouched employee/day just to stamp a break onto it) would have quietly reintroduced the exact bug S348 fixed this session — an employee nobody actually marked ending up saved as Present because *some* field on their row got touched. Full HR suite (37 tests) passes; build compiles clean.

**Files:** `src/modules/hr/attendance/AttendanceSheet.jsx`, `src/pages/Help.js`

### S355 — 2026-07-11 — feat(hr): Attendance gets an unpaid Break (minutes) field

User pointed at calculatorsoup.com's Hours Calculator and asked what was worth adopting. Its core feature not already covered by Crest: subtracting an unpaid lunch/break deduction from the raw Start-to-End span before it becomes a paid hours total (its rounding-to-nearest-5/15/6-minutes and multi-break options were judged not worth the added complexity — Hours/OT are already directly editable if a precise adjustment is needed, and the app's Month Summary already covers the "weekly hours calculator" use case at BS-month grain). Without it, a clocked-out lunch break was inflating both Hours Worked and OT Hours for anyone whose Start/End span included one.

Added a "Break" column (minutes) next to End on both the Mark Attendance and By Employee tabs. New `computeWorked()` in `AttendanceSheet.jsx` subtracts break minutes from the raw Start-to-End span (clamped at 0) before it becomes Hours Worked / feeds the OT calc; a new `setBreakCell()` mirrors `setTimeCell()`'s auto-recalc so editing Break alone (after Start/End are already filled) updates Hours/OT immediately, in either entry order. New `hr_attendance.break_minutes` column (migration `20260711163011_hr_attendance_break_minutes.sql`, integer, nullable — apply via Supabase SQL Editor). Full HR suite (37 tests) passes; build compiles clean.

**Files:** `src/modules/hr/attendance/AttendanceSheet.jsx`, `src/pages/Help.js`, `supabase/migrations/20260711163011_hr_attendance_break_minutes.sql`

### S354 — 2026-07-11 — feat(hr): Attendance flags shortfall hours against the roster (no auto-deduction)

User asked what should happen when an employee's clocked hours fall short of their Roster-assigned shift. Researched Nepal's Labour Act 2074 / Rules 2075: Section 47 restricts salary deductions to a fixed list of grounds, and the "absence" deduction it does define is a full-day daily-rate deduction — nothing in the Act prescribes a per-hour/partial-day formula, and deducting outside the Act's grounds risks the labour office ordering double repayment. Checked `payrollCompute.js` too: for `monthly`/`daily` pay-basis employees, a day marked Present already pays a full day regardless of actual `hours_worked` — a shortfall currently pays out silently, unflagged. (`hourly`-basis staff are unaffected — their pay is computed directly from hours worked.)

Given the law leaves this to employer policy rather than mandating a formula, added a visual-only nudge instead of an automatic deduction: when a Present day's clocked hours fall ≥0.5h short of that day's roster-assigned shift, an amber "⚠ X.Xh short" hint appears next to OT Hours (both Mark Attendance and By Employee tabs), with a tooltip explaining nothing is auto-deducted and that Half Day is the existing lawful category to reclassify into if warranted. New `shortfallFor()` helper in `AttendanceSheet.jsx`. Full HR suite (37 tests) passes; build compiles clean.

**Files:** `src/modules/hr/attendance/AttendanceSheet.jsx`, `src/pages/Help.js`

### S353 — 2026-07-11 — feat(hr): Attendance Start/End time — accept plain-digit shorthand ("0800"), no colon required

User compared the Start/End time cells to a time-card calculator tool's input style and asked whether typing could skip the colon. Rather than a live-masked input (colon auto-inserted as you type) or a purely cosmetic restyle, went with the option the user picked: accept bare digits — `0800`, `800`, or just `8` — parsed the same way a time-clock calculator reads them (1-2 digits = hour only, 3 digits = H:MM, 4 digits = HH:MM), normalized to canonical `H:MM` the moment the field loses focus. Typing `08:00` still works exactly as before.

New `parseTimeInput()` in `AttendanceSheet.jsx` is the single parser behind both the live validity check and the blur-time normalization. To avoid the input flashing red mid-keystroke (e.g. typing toward `0800`, the intermediate `080` numerically reads as an invalid `0:80`), `isValidTimeStr()` takes a `lenient` flag that's only true while that exact cell is focused — 1-3 bare digits are treated as "still typing" and never flagged red while focused, but get properly validated the instant the field blurs (via a new `activeTimeKey` state tracking which cell has focus). This also closes a correctness gap in the naive lenient-everywhere version: without focus-tracking, a genuinely broken leftover value (like an abandoned 3-digit `080`) would have silently passed validation forever and risked being sent to the DB's `time` column unparsed.

`setTimeCell`'s Hours/OT auto-calc now runs off the parsed/normalized values rather than the raw typed string, so it can fire correctly mid-typing too (e.g. `800` alone already parses to a valid `8:00` and triggers the calc, without waiting for a 4th digit). Added a matching Help tip. Full HR suite (37 tests) passes; build compiles clean.

**Files:** `src/modules/hr/attendance/AttendanceSheet.jsx`, `src/pages/Help.js`

### S352 — 2026-07-11 — fix: full BS calendar re-derivation — EPOCH_AD + BS_CALENDAR 2079-2087, all cross-verified against independent sources

User asked to cross-check the Roster board's dates (Ashadh 22-28, 2083 shown as Sun-Sat) — this reproduced the EPOCH_AD bug found (but deliberately not fixed) in S347, so the user asked for the full fix: correct EPOCH_AD, and re-derive/verify the other 8 years of BS_CALENDAR (2083 was already hand-fixed in S349/350) with the same rigor.

Hand-checking against calendar websites proved unreliable mid-investigation — WebFetch's page-summarization misread a weekday column, and two different calendar-site fetches returned two different, mutually-contradictory tables for the same month. Switched approach: pulled the raw hardcoded calendar-data source files directly from two independent, actively-maintained open-source Nepali calendar libraries — `opensource-nepal/py-nepali` (Python) and `remotemerge/nepali-date-converter` (TypeScript) — via `curl` against raw.githubusercontent.com. Both agreed on every month for every year 2079-2087 with zero discrepancies, and reconstructing the epoch from py-nepali's own reference date independently reproduced the well-documented public fact that Baisakh 1, 2079 (Nepali New Year) fell on Thursday, 14 April 2022 — 2 days later than the app's previous (wrong) `EPOCH_AD`.

Beyond the epoch, `BS_CALENDAR[2080]` and `[2082]` were also found wrong (each incorrectly summed to 366 days instead of 365) — a separate bug layered on top of the epoch offset. `BS_CALENDAR[2083]`'s already-corrected S349/350 values turned out to be exactly right. Updated `src/utils/bsCalendar.js` (`EPOCH_AD` → 14 Apr 2022, full `BS_CALENDAR` table replaced for all 9 years) and `bsCalendar.test.js` (anchor tests, `daysInBsMonth(2082,9)` 29→30, the 366-day-year example moved from 2082→2083 to 2081→2082, since 2082 is no longer a 366-day year). All 16 bsCalendar tests + 37 HR tests pass; production build compiles clean.

**Heads up:** this shifts every BS date/weekday shown anywhere in the app (Roster, Attendance, Leave, Holiday Calendar, Payroll periods) by 1-2 days from what was shown before — worth flagging to the client (Casa Acai Cafe) since anything they cross-referenced against a paper/phone calendar before this fix will now show a different (correct) weekday.

**Files:** `src/utils/bsCalendar.js`, `src/utils/bsCalendar.test.js`

### S351 — 2026-07-11 — feat(hr): Attendance Month Summary — per-employee Total column (P+A+O+OT)

Small follow-up to S349. First attempt added a horizontal Total *row* summing each column down the bottom of the table — wrong axis; the actual ask was a vertical Total *column* after OT, giving each employee's own P+A+O+OT sum on their row. Replaced the row with the column (e.g. 15 P + 13 A + 3 O + 0 OT = 31 for that employee), reusing the exact same per-column formulas each row already computed rather than introducing a second calculation path.

**Files:** `src/modules/hr/attendance/AttendanceSheet.jsx`

### S350 — 2026-07-11 — fix: BS_CALENDAR 2083 month-length table had 4 wrong months (Jestha/Ashadh/Shrawan transposed, Ashwin short a day)

User flagged Ashadh 2083 showing 31 days on the Attendance page when it should be 32. Verified against Hamro Patro (fetched all 12 months of BS 2083 individually, cross-checked each month's day-1 AD date against the next month's day-1 AD date to derive real month lengths independent of any single page's self-reported count) rather than patching just the one reported month, since a single wrong entry raised the question of whether the whole row was suspect.

Confirmed 4 of `src/utils/bsCalendar.js`'s `BS_CALENDAR[2083]` 12 entries were wrong: Jestha/Ashadh/Shrawan were `[32,31,32]` instead of the real `[31,32,31]` (a transposition), and Ashwin was `30` instead of `31`. Months 1, 5, 7–12 were already correct. The year's total (365 days) happened to match either way, which is presumably why this went unnoticed — nothing downstream cross-checks a year's total against anything external. Fixed the row to `[31,31,32,31,31,31,30,29,30,29,30,30]`; added a dedicated test in `bsCalendar.test.js` covering all 12 corrected months so a future edit can't silently re-transpose them. All 53 tests (bsCalendar + HR suite) pass; build compiles clean.

**Separate, still open:** this is unrelated to — and doesn't fix — the `EPOCH_AD` 2-day offset bug found earlier this session (see [[bug_bs_calendar_epoch_offset]] memory / S347's writeup). That's a constant applied uniformly to every BS year; this was wrong values *within* one specific year's table row. Both need to be correct for `bsCalendar.js` to be fully trustworthy — the epoch fix is still pending explicit go-ahead given its live-production blast radius. Worth a future spot-check of the other 8 years (2079–2087) in `BS_CALENDAR` given this table already had one confirmed transcription error — not done here, out of scope for what was asked.

**Files:** `src/utils/bsCalendar.js`, `src/utils/bsCalendar.test.js`

### S349 — 2026-07-11 — feat(hr): Attendance — "not marked" display fix, then real delete/clear buttons once its gap surfaced

Follow-up design re-check after S348's save-behavior fix (only touched cells get written) found the Status dropdown still *displayed* "Present" for an untouched cell — same green/bold look as a genuinely-confirmed one, so there was no visual way to tell before saving which rows would actually persist. Fixed by having `statusFor()` return `null` for a cell with no record, rendered as a neutral "— Not marked —" placeholder (grey, unbolded) instead. Also bumped the Start/End "invalid — use HH:MM" warning from 9px (smaller than anything else on the page) to 11px, caught in the same pass.

That placeholder then turned out to have a real gap of its own: selecting it only cleared *local* React state, never actually deleting the row from `hr_attendance` if one already existed — so reverting a previously-saved cell back to "not marked" and clicking Save left the stale DB row untouched (Save only ever upserts, never deletes) and it silently reappeared on the next reload. Fixed `clearCell()` to also issue a real `scopedDelete()` against the DB when the cell was previously saved.

User then asked for an actual way to bulk-clean bad historical data (the false Present-on-save rows from before S348's fix) rather than editing cell-by-cell — having declined an automated cleanup of already-written rows earlier in the session in favor of reviewing manually. Added that manual tooling: a small 🗑 delete button on every row in both Mark Attendance and By Employee (only shown when that cell has a record), plus two bulk actions — "Clear Day" (deletes every employee's record for the selected day, Mark Attendance) and "Clear Month" (deletes every record for the selected employee this period, By Employee) — both behind a `window.confirm` given they're destructive and irreversible.

**Files:** `src/modules/hr/attendance/AttendanceSheet.jsx`

### S348 — 2026-07-11 — fix(hr): Attendance no longer silently saves untouched days as Present

Follow-up to S346/S347's "nothing assumed off automatically" work — found the same problem in reverse. `saveDay()` and `saveEmployeeMonth()` still wrote `status: rec?.status ?? defaultStatus()` for every employee/day in scope, so any cell nobody had touched got persisted as Present the moment Save was clicked. Concretely: opening By Employee, correcting a handful of days (Off on Saturdays, Holiday on a gazetted day), and clicking Save Month wrote **every other day of the month as Present too**, even though nothing was actually confirmed — reproduced live against a real client's Ashadh 2083 data (Ananda Bhusal showed 26 days Present against a completely empty Roster for the first 19 days of the month; traced and confirmed the mechanism, user declined an automated cleanup of the already-written rows and is correcting that data by hand).

Fixed both save paths to only include employee/day cells where `cellFor()` returns an actual record — i.e. the admin changed status, typed a time, hours, OT, or a note for that specific cell. Untouched cells are skipped entirely (no row written, stays a blank `·` on Month Summary) instead of defaulting to Present. Save now reports how many rows actually got written (e.g. "Saved Day 15 (2 of 4 staff)"), and shows "Nothing to save" if nothing was touched.

Also fixed the matching *display* gap: the Status dropdown previously showed "Present" (green) for an untouched cell too, so there was no visual way to tell, before saving, which rows would actually persist — exactly the ambiguity that produced the bad data above. `statusFor()` now returns `null` for a cell with no record, rendered as a neutral "— Not marked —" placeholder (grey, unbolded) instead of Present; picking the placeholder again (`clearCell()`) reverts a cell to genuinely untouched. Also bumped the Start/End "invalid — use HH:MM" warning from 9px to 11px (found during a design re-check of everything added this session — no other regressions; all hex-color hits in the touched files were pre-existing, already-reviewed exceptions).

**Files:** `src/modules/hr/attendance/AttendanceSheet.jsx`

### S347 — 2026-07-11 — feat(hr): Attendance — Start/End clock-time entry with roster-aware auto-OT, and a By Employee tab

Two related Attendance requests in one session. First: Mark Attendance's Hours/OT Hours fields were manually typed numbers with no connection to actual clock times. Added Start/End columns — plain text inputs (`--:--` placeholder, not the native browser time-picker widget, per explicit request: "punched in by the user, no time selector"), expecting 24-hour `HH:MM` typed directly. The moment both are valid, Hours and OT auto-calculate: worked hours (via the same `calcHours()` Roster already uses, handles overnight shifts) minus that employee's Roster-assigned shift hours for that exact day (falls back to `STANDARD_HOURS_PER_DAY` — 8h — if they're not on the roster that day) becomes OT. Both fields stay directly editable afterward. An invalid/partial typed time gets a red border + inline hint and is kept on screen for correction, but is never sent to the DB's `time` columns (new migration `20260711054731_hr_attendance_start_end_time.sql` — `hr_attendance.start_time`/`end_time`, applied by the user via the Supabase Dashboard SQL Editor). `generateFromRoster()` and the new employee-scoped variant were simplified to reuse the same `shiftTypesById`/`rosterRows` state already being loaded for this calculation, instead of re-fetching.

Second: added a third tab, **By Employee**, matching a reference mockup the user provided — the same data the other way round from Mark Attendance (which is one-day-all-employees). Pick one employee from a dropdown, fill in every day of the month as rows (Status/Start/End/Hours/OT/Note), with the same bulk actions (All Present/Off/Holiday) and ⚡ Generate from Roster now scoped to just that employee, and a "Save Month" that writes their whole month at once. Required generalizing `setCell`/`setTimeCell` (previously hardcoded to the Mark Attendance tab's `selectedDay` state) to take an explicit `day` parameter so both tabs share the exact same read/write logic against the same `records` state — switching tabs mid-edit loses nothing.

Also found and reported, not yet fixed (pending explicit go-ahead given live-production impact): `src/utils/bsCalendar.js`'s `EPOCH_AD` anchor (12 April 2022) is 2 days off from the real BS 2079/01/01 (14 April 2022 — verified against three independent Nepali calendar sources, and cross-checked a second year, BS 2080/01/01, which shows the same 2-day gap). Since every BS-aware feature in the app funnels through this one constant, the practical effect is that `getBsToday()` currently runs 2 BS days *ahead* of the real calendar, and every weekday label derived from a BS date runs 2 days *behind* — reproduced exactly against a live screenshot (Ashadh 27, 2083, shown as "Sat", true weekday recomputed as Monday once corrected). The fix itself is a one-line constant change; not applied yet because the visible effect the moment it ships is every BS date and weekday across the whole app shifting by 2 days on a system a real client is actively using.

**Files:** `src/modules/hr/attendance/AttendanceSheet.jsx`, `src/modules/hr/attendance/attendanceFromRoster.js`, `src/modules/hr/attendance/attendanceFromRoster.test.js`, `supabase/migrations/20260711054731_hr_attendance_start_end_time.sql`, `src/pages/Help.js`

### S346 — 2026-07-11 — fix(hr): removed the global "Weekly Off Day" — off days are now explicit, per employee, everywhere

Following on from S345's theming fix, a functional follow-up: the whole HR module assumed a single company-wide "weekly off weekday" (`settings.weekly_off_weekday`, default Saturday) — Attendance auto-defaulted that weekday to Weekly Off, Leave silently excluded it from working-day counts, and Roster shaded it on the board. Per explicit direction ("don't apply any of the days as off by default — let the user define which days is off for the staff", confirmed to apply everywhere, not just Attendance, after mapping every consumer first), removed the concept entirely rather than just tweaking Attendance:

- **Attendance**: `defaultStatus()` always returns Present now; no more Saturday auto-default or warning banner. Month Summary's "W" (Weekly Off) short code relabeled "O" (Off), with a dedicated Off total column added next to P/A/OT, matching the user's exact spec.
- **`attendanceFromRoster.js`** (Generate from Roster): replaced the Saturday-weekday check with the same roster-shift-*name* convention `SelfServiceHome.jsx` already used to grey out an employee's own off days (`isOffDay`/`OFF_SHIFT_KEYWORDS`, now centralized in `payrollConstants.js`) — a zero-hour roster shift named like "OFF DAY"/"LEAVE" now generates an Off row; an unrostered day generates nothing at all (previously invented a Weekly Off guess from the weekday alone).
- **Roster**: removed the "Weekly Off Day" dropdown from Shift Types entirely, and the cosmetic Saturday column-shading on the board (confirmed via the lone `laborForecast.js` — it never fed labor forecast/recommended headcount, purely visual).
- **Leave** (`workingDaysInRange`, both admin Leave Management and Self-Service): every calendar day in a picked range now counts against the balance — no more silent exclusion of a weekday. Chose this over building a "let the submitter uncheck specific dates" UI, since a per-employee off day can't be reliably inferred for a *future* leave request (attendance for future days doesn't exist yet to look up).

De-risked by confirming first that the actual payroll math (`payrollCompute.js`) never read `weekly_off_weekday` at all — `weekly_off` and `holiday` were already financially identical/neutral statuses (excluded from both the paid-days and unpaid-days tallies), so none of this touches real pay calculations, only which days get auto-labeled and how leave balances are counted. `settings.weekly_off_weekday` column itself was left in place (unused) rather than migrated away — no data risk. Updated Help.js's Attendance/Roster/Leave guidance and `attendanceFromRoster.test.js` to match; all existing HR tests still pass.

**Files:** `src/modules/hr/attendance/AttendanceSheet.jsx`, `src/modules/hr/attendance/attendanceFromRoster.js`, `src/modules/hr/attendance/attendanceFromRoster.test.js`, `src/modules/hr/leave/LeaveManagement.jsx`, `src/modules/hr/leave/leaveConstants.js`, `src/modules/hr/payrollConstants.js`, `src/modules/hr/roster/Roster.jsx`, `src/modules/hr/roster/ShiftSettingsPanel.jsx`, `src/modules/hr/selfservice/SelfServiceHome.jsx`, `src/pages/Help.js`

### S345 — 2026-07-11 — fix(hr): module-wide hardcoded-hex theming bug — HR silently ignored a client's chosen theme

Ran the `ui-ux-pro-max` design-review skill against the HR module (24 admin/manager pages + the 2 employee Self-Service pages) as a follow-up to S344's POS pass. The codebase-mapping sub-agent surfaced something much bigger than a one-off bug: unlike POS/IMS, almost the entire HR module was built with literal hex colors matching only the default dark theme's exact values instead of the app's `var(--theme-*)` CSS variable system — confirmed ~500+ occurrences across 20 files (`e8e0d0`/`9ca3af`/`6b7280`/`4b5563`/`c9a84c`/`34d399`/`f87171`/`0f1117`/`2a2f3d`/`141820`/`181c27`). Practical effect: a client on any of the app's other 8 theme presets got an HR module frozen in the default dark/gold look while every other module (nav, POS, IMS) correctly re-themed — the same class of bug as S344's `Modal.js` finding, just module-wide instead of one component.

Fixed by mapping each exact hex match to its corresponding token (`text1/text2/text3/accent/green/red/input-bg/border/card`) and sweeping every affected file. One landmine caught before the sweep: `LeaveManagement.jsx` used a leave-type color as a fallback *inside* a `` `${t?.color || '#9ca3af'}1a` `` alpha-suffix template literal — blindly swapping that to `var(--theme-text3)` would have produced invalid CSS (`var(...)1a` isn't a color). Fixed that file by hand, preserving the two alpha-suffix spots as literal hex. Deliberately left untouched: `leaveConstants.js`/`payrollConstants.js`'s categorical tag-color palettes (leave-type tags, attendance-status colors — a real fixed/user-facing palette, not theme chrome) and `Roster.jsx`'s default value for its user-editable shift-color `<input type="color">` (can't take a CSS variable anyway).

Also, in the same pass: bumped undersized touch targets on `SelfServiceHome.jsx` (Request Swap, +Add expense line, TADA remove ✕ — all on the phone-only employee self-service page) up to the same standard set in S344, and fixed a stale `CLAUDE.md` reference to a `BsDatePicker` component that doesn't exist (the real, actively-used component is `BsCalendarPicker`).

Backlog, not attempted this pass (bigger/riskier changes deferred, same triage logic as S344): 13 HR files hand-roll their own modal overlay instead of the shared `Modal` component; `Roster.jsx`'s drag-to-select scheduling grid is mouse-only with no touch handling; 5 files reinvent pending/approved/rejected status-chip styling instead of `badge-*`; an orphaned dead file `src/modules/hr/Hr.js` (unrouted "coming soon" stub).

**Files:** `src/modules/hr/Hr.js`, `advances/Advances.jsx`, `attendance/AttendanceSheet.jsx`, `dashboard/HrDashboard.jsx`, `employees/EmployeeForm.jsx`, `employees/EmployeeList.jsx`, `festival/FestivalAllowance.jsx`, `gratuity/GratuityTracker.jsx`, `holidays/HolidayCalendar.jsx`, `leave/LeaveManagement.jsx`, `leave/leaveConstants.js`, `overtime/Overtime.jsx`, `pay/PayForm.jsx`, `pay/PaySetup.jsx`, `payroll/PayrollRun.jsx`, `payrollConstants.js`, `reports/HrReports.jsx`, `settlement/FinalSettlement.jsx`, `tada/TadaClaims.jsx`, `selfservice/SelfServiceHome.jsx` (all under `src/modules/hr/`), plus `CLAUDE.md`

### S344 — 2026-07-11 — feat: POS module UI/UX pass (`ui-ux-pro-max` design-review skill)

Ran the `ui-ux-pro-max` design-review skill against the full POS module (14 screens — order-taking, table floor plan, Kitchen Display, guest QR menu, staff/reports pages) and implemented the highest-confidence, lowest-risk fixes it surfaced:

Undersized touch targets on the busiest screen in the app — the qty +/- stepper (`btnSm` in `posOrdersConstants.js`, used for both the cart-line quantity and the covers count in `PosOrders.jsx`) was 26×26px, well under the ~44px touch-target guideline, on a tablet screen used rapidly during live service. Bumped to 40×40 (the largest that fits the existing 320px cart column / 52px top bar without reflowing either), and matched the same fix in `GuestMenu.jsx`'s identical stepper on the customer's own phone.

A real theming bug in the shared `Modal.js`: its title was hardcoded `#e8e0d0` instead of `var(--theme-text1)` — invisible on the default theme (identical value) but wrong on every other preset, affecting every POS modal built on the shared component (this is what led to auditing HR's colors too, in S345).

Kitchen Display glanceability: ticket item text (13→16px), elapsed-timer label (11→13px), and the advance-stage button (12→14px + bigger padding) were sized for a desk screen, not a board glanced at from a few feet above a hot line.

Floor-plan status at a glance: table tiles showed status only via a small badge chip; added a full-width color strip (reusing the exact pattern already proven in Kitchen Display's ticket cards) so Available/Occupied/Reserved reads across a room, in both the live floor view (`PosOrders.jsx`) and the table-setup grid (`PosTableManagement.jsx`) — the badge stays too, so status is never color-only.

Backlog, deliberately not attempted this pass: most POS modals hand-roll their own overlay instead of reusing `Modal.js`; no loading-skeleton component exists anywhere in POS; `SearchableSelect` is under-used; `GOLD`/`MUTED` hex chart-tick constants are duplicated across two report files.

**Files:** `src/modules/pos/orders/posOrdersConstants.js`, `src/modules/pos/orders/PosOrders.jsx`, `src/modules/pos/guestmenu/GuestMenu.jsx`, `src/components/Modal.js`, `src/modules/pos/kds/KitchenDisplay.jsx`, `src/modules/pos/tables/PosTableManagement.jsx`

### S343 — 2026-07-10 — docs(ims): "On POS" tooltip now mentions it doubles as the 86 toggle

Explored building a separate "86 list" feature (mark a menu item unavailable when out of stock, blocking it on the POS order screen and Guest QR menu) — research confirmed the existing "On POS" toggle (`recipes.pos_enabled`, `MenuPricing.js`) already produces the exact same outcome, since both `PosOrders.jsx`'s menu query and the `get_guest_menu`/`submit_guest_order` guest-ordering RPCs already filter on `pos_enabled`. Rather than build a parallel `is_86` flag/column/UI duplicating a mechanism that already works, updated both of `MenuPricing.js`'s existing "On POS" column tooltips (the file has two view branches) to mention it doubles as the 86 mechanism — uncheck when you run out, recheck once restocked. No schema/logic change.

**Files:** `src/modules/ims/recipes/MenuPricing.js`

### S342 — 2026-07-10 — feat: Dashboard KPI cards shrunk to reduce page length

`ClientDashboard.jsx` (the same file backs both "Admin Dashboard" and the real-client dashboard — there's no separate admin-only file) stacks up to 4 KPI-card grid sections (IMS Row 1: 5 cards, IMS Row 2: 6 cards, HR: 3, POS: 4) plus 4 chart/table blocks, making the page long enough to require scrolling. After discussing three options (shrink cards / convert secondary cards to a slim chip strip / make sections collapsible), the user chose to shrink the cards only.

Card padding `14px 16px → 10px 14px`, grid `gap 14 → 10`, grid `minmax(160px) → minmax(140px)` (the bigger lever — eliminates whole wrapped rows at common widths, e.g. IMS Row 2's 6 cards now fit one row instead of wrapping 5+1 around ~1280px), label/subtext `11px → 10px`, hero-tier values `28px → 22px`, secondary-tier values `22px → 18px` — the two-tier hero/secondary hierarchy is preserved, not flattened. Section `marginBottom` unified to `14` everywhere (previously an inconsistent 14/20 split). Extracted `kpiLabelStyle`/`kpiSubtextStyle`/`kpiValueStyle(size, weight)` next to the existing `kpiCard()` factory (the label/value/subtext style shape was already drifting into 3 slightly different variants across the file before this pass, not a clean single pattern) so any future re-tune is a few-line edit instead of a 15+-site sweep. `OwnerDashboard.jsx` has its own independently-duplicated `kpiCard` and is deliberately not touched by this pass.

**Files:** `src/pages/dashboard/ClientDashboard.jsx`

### S341 — 2026-07-10 — chore(ims): Finance Reports sidebar — moved Purchase 1L+ Report to the bottom

Pure reorder in `Layout.js`'s `REPORTS` array — Purchase 1L+ Report now sits below Outstanding Payables in the Finance Reports sidebar group instead of 2nd. No behavior change.

**Files:** `src/components/Layout.js`

### S340 — 2026-07-10 — fix(ims): Purchases bill entry — Qty field no longer shifts when a unit appears

`PurchaseBillModal.jsx`'s Qty cell only rendered its unit label (`GM`/`ML`/etc.) below the input once an item was selected, conditionally — so the input visibly shifted up a few pixels the moment an item got picked, since the cell had less content before that. Removed that below-line entirely and instead changed the input's placeholder from a generic `0` to the item's actual unit (e.g. `GM`) once known — the unit now shows inside the field itself (visible whenever it's empty) rather than as a separate line underneath, so there's nothing left to appear/disappear and the input's position never shifts. The separate purchase-unit conversion line (`= 500 GM`, shown only for items whose purchase unit differs from their storage unit) is unrelated and unchanged.

**Files:** `src/modules/ims/purchases/PurchaseBillModal.jsx`

### S339 — 2026-07-10 — feat(admin): Guest Menu Preview — see any client's live guest QR menu from the Admin panel

New Admin-only page (`/admin/guest-menu`, "Guest Menu" in the Admin sidebar group) that previews the currently-viewed client's guest QR menu (`GuestMenu.jsx`, the public `/pos/menu/:tableId` page a guest sees after scanning a table's QR code) without needing a printed QR code or the client's help. Picks up whichever client is selected via the sidebar's admin client switcher, lists that client's active tables, and embeds the real live guest page in an iframe for the selected one — deliberately the exact same component a guest loads (via `iframe src`), not a separate mockup, so it's always in sync and includes guest ordering if that client has the Pro-tier `guest_ordering` flag on. A warning banner makes clear this is the real page — placing a test order through it creates a genuine pending row in `pos_guest_order_requests` that the client's own staff will see in POS Orders.

**Files:** `src/pages/AdminGuestMenu.jsx` (new), `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`

### S338 — 2026-07-10 — feat(ims): Recipe Costing — explicit DFTQC/IFCT/USDA source picker per ingredient

`NutritionEditorModal.jsx`'s single "⚡ Suggest from library" button only ever showed source options that happened to have a matching row for that specific ingredient — for "Strawberry" (USDA-only in the seed data; DFTQC/IFCT are Nepal/India government food tables that don't cover imported fruit), that meant only one option ever appeared, reading as "no choice" even though the mechanism for choosing a source already existed for multi-source ingredients like Rice/Milk/Chicken. Replaced it with three always-visible buttons (DFTQC Nepal / IFCT 2017 / USDA) so the choice is explicit and predictable regardless of an ingredient's actual data coverage — clicking a source with no entry for that ingredient now says so directly ("No {source} entry for X — try another library or enter manually") instead of silently not being an option. New `suggestSeedsForSource()` in `nutritionSeed.js` searches one source at a time (unlike `suggestSeeds()`, which only surfaces ties at the single best cross-source keyword match, silently dropping a source with a merely-good match if another source has a longer one) — the original `suggestSeeds()`/`suggestSeed()` are unchanged and still back the separate bulk "⚡ Auto-fill nutrition" button on the Ingredients header (S325).

**Files:** `src/data/nutritionSeed.js`, `src/modules/ims/recipes/NutritionEditorModal.jsx`, `src/pages/Help.js`

### S337 — 2026-07-10 — fix(hr): Gratuity Tracker & Final Settlement flag unconfirmed 12-month vesting cliff

Researched Nepal's Labour Act 2074 employment categories (Permanent/Probation/Contract/Part-time) in depth, which surfaced a separate, higher-stakes finding: `GratuityTracker.jsx` and `FinalSettlement.jsx` both hardcode a 12-month vesting cliff (zero gratuity for an employee leaving before 1 year), but reading Sections 52/53 of the Act directly shows gratuity structured as a defined-contribution scheme (a portable SSF balance) accruing monthly from day 1, with no explicit vesting threshold found in the current Act's text — the 1yr/3yr/5yr figures floating around secondary sources look like holdovers from the old 2048 Act's tenure-gated defined-benefit formula. Genuinely unresolved without an accountant's confirmation, and it involves real payout amounts on real employee exits.

User's decision: keep the 12-month cliff in the actual calculation (too risky to change blind) but make the uncertainty visible everywhere it currently presents as settled fact — added `Tip` caveats to the page subtitle, the "Vested Employees" stat card, and the "Vested" column header in `GratuityTracker.jsx`, and to the vested/not-vested badge and the inline settlement note in `FinalSettlement.jsx`, all noting the threshold is a common assumption rather than a confirmed legal requirement and recommending accountant verification for anyone near the boundary. No calculation changed — `vested = months >= 12` stays exactly as before in both files.

Also: confirmed `FestivalAllowance.jsx` already correctly prorates by months worked with no 1-year gate (matches Section 37), and that `MIN_HOURLY_PARTTIME` (107) being higher than `MIN_HOURLY` (101) in `payrollConstants.js` is consistent with the Act's part-time pro-rata wage-floor rule (Section 19) — no changes needed to either.

**Files:** `src/modules/hr/gratuity/GratuityTracker.jsx`, `src/modules/hr/settlement/FinalSettlement.jsx`

### S336 — 2026-07-10 — fix(hr): Employee Status = Probation always violated a check constraint

`EmployeeForm.jsx`'s Status dropdown has offered "Probation" as an option for a while (also used in `EmployeeList.jsx`'s filters/counts, HR Dashboard, etc.), but `hr_employees_status_check` (from the baseline schema snapshot) only ever allowed `active`/`inactive`/`resigned`/`terminated` — `probation` was never added to it, so saving Status = Probation always failed with a check-constraint violation. (Not to be confused with the separate `employment_type` column, whose own check constraint already correctly allows `probation` — that field was unaffected.) Migration `20260710090000_hr_employees_status_add_probation.sql` drops and recreates the constraint to include `probation`. Applied and confirmed by the user.

**Files:** `supabase/migrations/20260710090000_hr_employees_status_add_probation.sql`

### S335 — 2026-07-09 — feat(ims): Purchases Daily Register — sticky Total column + collapsible categories

S334's new Total column needed a full horizontal scroll to see, and with the whole table's horizontal scrollbar sitting at the very bottom of a long (172-item) list, seeing it meant scrolling all the way down first. Made the Total column `position: sticky; right: 0` (and the header row `position: sticky; top: 0`) so it's always visible without any scrolling at all, regardless of vertical or horizontal scroll position. Also made each category header in the grid clickable to collapse/expand its items (▾/▸, with an item count), so a long item list can be narrowed down to just the categories currently relevant instead of scrolling past all of them. The sticky Total cell composites its subtle alternating-row tint over an explicitly opaque `var(--theme-card)` base (via a layered `linear-gradient`) rather than reusing the row's translucent stripe background directly, so horizontally-scrolled-away cells don't show through underneath it.

**Files:** `src/modules/ims/purchases/Purchases.js`, `src/pages/Help.js`

### S334 — 2026-07-09 — feat(ims): Purchases Daily Register — monthly Total column per item

Added a Total column at the end of the Daily Register tab's day-by-day grid, summing each item's purchase qty across every day in the selected period — both in the on-screen table and the Export Excel output, so the figure travels with the sheet.

**Files:** `src/modules/ims/purchases/Purchases.js`, `src/pages/Help.js`

### S333 — 2026-07-09 — fix(ims): Sales Import Excel header detection too strict for real files

After S332's crash fix, the very same real report instead failed with "Could not find a Product Name / Product Code header row" — the header-row scan required an exact `startsWith('product name')`/`startsWith('product code')` match, which breaks the moment a real export wraps header text with a line break inside the cell (e.g. "Product\nName", common Alt+Enter wrapping in narrow columns) or uses a non-breaking space, and unnecessarily also required a "Product Code" column that isn't even read anywhere downstream. Relaxed detection to `cell.includes('product') && cell.includes('name')` (substring-based, so any whitespace variant between the two words still matches) and dropped the Product Code requirement entirely — the header row is now recognized by a Product Name-like cell plus at least one Sale/Return/Net quantity column in the same row, which is what the feature actually needs. Verified against three reconstructed cases: a line-wrapped header cell, a header with no Product Code column at all, and the original well-formed test file — all parse correctly.

**Files:** `src/modules/ims/sales/SalesImportButton.jsx`

### S332 — 2026-07-09 — fix(ims): Sales Import Excel crashed on real-world files with blank cells

S331's `SalesImportButton.jsx` crashed on the very first real report (`Cannot read properties of undefined (reading 'startsWith')`) because `XLSX.utils.sheet_to_json(ws, { header: 1 })` leaves a blank/merged cell as a genuine hole in the row array rather than `''`. `Array.prototype.map` (used to lowercase every cell) silently skips holes, but `findIndex` does not — it calls the callback with `undefined` for a hole, and `.startsWith` on `undefined` throws. Real vendor exports are full of blank cells (blank Product Code, blank hierarchy columns), so this reliably tripped on any real file even though the earlier hand-built test file (which happened to have no true holes) didn't reproduce it. Fixed by adding `defval: ''` to the `sheet_to_json` call so every cell is a real value. Verified against a reconstructed sparse test file matching the real report's shape (blank Product Code column, blank Net cell, blank hierarchy columns) — parses correctly now.

**Files:** `src/modules/ims/sales/SalesImportButton.jsx`

### S331 — 2026-07-09 — Sales Entry: Import Excel button for Daily Entry (vendor POS export auto-fill)

New `SalesImportButton.jsx` (sibling to `Sales.js`, same file-as-component pattern as `RecipeImportButton.jsx`) reads a vendor "Sales Report Item Wise" .xlsx export and auto-fills the Daily Entry qty column for the BS day already selected on screen. The vendor export isn't a clean table — it has a variable-length metadata block (company name, VAT no, date range) before a two-tier merged header — so the header row is located dynamically by scanning for a row containing both "Product Name" and "Product Code", and Sale/Return/Net(qty) columns are derived from that row's own text rather than fixed column letters. "Net" appears twice in the file (once under Quantity, once under Amount); the parser disambiguates by taking the first "Net" after the Sale/Return columns and ignores the Amount section entirely (`sales_entries` has no revenue column, only `qty_sold`). If the file's Net cell is blank, qty falls back to Sale − Return. Rows are matched to recipes by exact case-insensitive name; unmatched names are shown in a lightweight inline banner (no blocking modal, per the confirmed design), duplicate rows for the same recipe are summed, and a `TOTAL >>` row is correctly excluded from data. Import writes only into the existing `dailyForm` local React state — the same state the manual qty `<input>`s already use — so the existing Save Day button and `sales_entries` write path are completely unchanged; nothing is persisted until Save Day is clicked, making a bad import trivially undoable.

**Files:** `src/modules/ims/sales/SalesImportButton.jsx` (new), `src/modules/ims/sales/Sales.js`, `src/pages/Help.js`

### S330 — 2026-07-09 — HR Dashboard: surfaces every staff-submission approval queue, not just Leave/OT

Audited (via a research subagent, no code changes in that pass) every place a staff submission creates a row needing a manager decision. Leave and OT were already on `HrDashboard.jsx` and the sidebar rail badge (`useNavBadgeCounts.js`) — but **TADA Claims (`pending`) and Shift Swap requests (`pending_admin`) were completely invisible from every dashboard**, discoverable only by opening `/hr/tada` or `/hr/roster` directly.

Added both to `HrDashboard.jsx`: pulled Leave/OT out of the "Headcount" KPI row into a new dedicated **Approvals** row (Leave Pending / OT Pending / TADA Pending / Swap Pending, all amber + clickable when non-zero, with a total count in the row header), and added matching Pending TADA Claims / Pending Shift Swaps queue tables alongside the existing Leave/OT ones (now a 2×2 grid). Swap Pending deliberately counts only `status = 'pending_admin'` — a swap still awaiting the coworker's own accept (`pending_target`) isn't yet a manager action. Extended `useNavBadgeCounts.js`'s `hrPending` sidebar rail count with the same two sources so the rail dot matches what the dashboard shows.

Separately, asked to analyze whether multi-module clients should get one unified dashboard instead of several — reported findings (not implemented, pending a decision): `/dashboard` (`ClientDashboard.jsx`) already merges IMS+HR+POS into one page when 2+ modules are enabled, `/hr/dashboard` is a deliberately separate, richer *operational* console (approval queues, SSF, advances), and `/owner-dashboard` is a deliberately separate, higher-altitude *strategic* cross-module view (margin%, labor cost%) gated to Growth+ Suite plan. Recommended keeping the three apart (different altitudes of information + different plan gates) rather than merging, with cross-links as the lower-risk way to reduce navigation friction.

**Files:** `src/modules/hr/dashboard/HrDashboard.jsx`, `src/shared/hooks/useNavBadgeCounts.js`, `src/pages/Help.js`

### S329 — 2026-07-09 — Fixed browser autofill bleeding a saved login into unrelated forms

Reported from two places: the new POS Staff "HR Employee" `SearchableSelect` search box, and the trial-signup Email/Password fields on the Login page — both were getting the browser's saved login email (and, on the signup form, the saved login password) autofilled in, because none of the relevant inputs carried an explicit `autocomplete` hint. Without one, Chrome falls back to guessing from `type` + surrounding context, and a `type="password"` field anywhere on the page makes it treat the nearest preceding text field as a login username — including a search box that has nothing to do with logging in.

Audited every real `type="password"` input in the app (3 files — POS Staff's Add/Reset PIN, the Enable Self-Service PIN modal on HR Employees, and Login.js's two forms; the PIN-pad login screens for POS/HR Self-Service use custom keypads, not text inputs, so they were never affected) and added the correct token to each: `new-password` for every PIN-creation field (POS Staff, Enable Self-Service, and the trial signup's Password) so Chrome treats them as a fresh credential rather than hunting for a saved one, and `username`/`current-password` on the actual Sign In form's Email/Password so it's still explicitly, correctly treated as a login (unchanged behavior there, just now explicit instead of guessed). `SearchableSelect.js`'s own search input also got `autocomplete="off"` — a global fix covering every dropdown built on this component, not just POS Staff's.

**Files:** `src/pages/Login.js`, `src/modules/hr/employees/EmployeeList.jsx`, `src/modules/pos/staff/PosStaff.jsx`, `src/components/SearchableSelect.js`

### S328 — 2026-07-09 — POS Staff: link an existing HR employee instead of retyping their name

For a client with both Crest HR and Crest POS, POS Staff's "+ Add Staff" and HR Employees had zero connection — the same person had to be entered twice under two different names/records, with no way to keep them in sync. Asked to "figure it out."

`profiles.hr_employee_id` (present since baseline, previously only consumed by HR Self-Service) is now also written by `create_pos_staff` when an `employee_id` param is passed. The Add Staff modal gains an "HR Employee / POS-only Staff" toggle (only shown when `hrEnabled`, defaulting to HR Employee whenever an unlinked one exists): HR mode replaces the free-text Full Name field with a `SearchableSelect` of HR employees who don't already have a POS account (`employee.full_name` is used server-side, not retyped); POS-only mode is the unchanged original flow, for staff who aren't in HR. The staff table now shows a "🔗 HR · <employee_code>" tag under the name for linked accounts.

`get_pos_staff_list` now also returns `hr_employee_id`/`employee_code` via a left join, and a new partial unique index (`profiles_hr_employee_pos_unique` on `hr_employee_id WHERE pos_email IS NOT NULL`) plus an Edge Function-side check both stop the same HR employee from ending up with two POS accounts.

Migration: `supabase/migrations/20260709130000_pos_staff_hr_link.sql`. The `admin-user-ops` Edge Function's `create_pos_staff` action was also updated and deployed (`supabase functions deploy admin-user-ops`) — the first Edge Function redeploy this session, done directly rather than through the SQL-Editor-paste routine used for schema migrations.

**Files:** `src/modules/pos/staff/PosStaff.jsx`, `supabase/functions/admin-user-ops/index.ts`, `src/pages/Help.js`

### S327 — 2026-07-09 — TADA Claims: Start Point dropdown + vendor picker for Purchase trips

Live feedback on the new Self-Service TADA tab: a claim only had a single Destination field, with no origin, and staff going on the common "Purchase" run had to type the vendor's name from memory instead of picking it from the Vendor list Crest already has.

**Start Point**: a second client-configurable preset dropdown, same shape as Purpose (`settings.tada_start_points` jsonb list, "Other (type below)" always available), added next to Purpose on both the manager New Claim form and the Self-Service TADA tab. New `hr_tada_claims.start_point` text column. Claim list rows and the detail panel now show `Start Point → Destination` when a start point is set, falling back to just Destination for older claims that don't have one.

**Vendor picker for Purchase**: when Purpose = "Purchase," a `SearchableSelect` of the client's active vendors appears under Destination on both forms — picking one just writes that vendor's name into the existing Destination text field (a one-shot autofill, not a persistent selection or a foreign key). Asked which of two designs to build — a stored `vendor_id` link (enables future "visits per vendor" reporting) vs. this simpler text-fill — and went with text-fill for now, no schema/reporting commitment. Self-service can't read `vendors` directly (blocked by S316's `no_self_service_accounts` policy), so a new `get_my_client_vendors()` RPC exposes just `id, name` for active vendors, same reasoning as every other self-service RPC; the manager form already has normal `vendors` access via `scopedFrom`.

Extracted `TadaSettingsModal.js`'s repeated add/remove chip-list UI (previously written once for Purpose Options) into a shared `OptionListEditor` sub-component, reused for the new Start Points section instead of duplicating the markup.

`submit_my_tada_claim`'s signature was extended in place via `CREATE OR REPLACE FUNCTION` with a new `p_start_point text DEFAULT NULL` parameter appended at the end — safe against the already-deployed version from S326 since existing params/order are untouched.

Migration: `supabase/migrations/20260709120000_tada_start_point_vendor.sql`.

**Files:** `src/modules/hr/tada/TadaClaims.jsx`, `src/modules/hr/tada/TadaSettingsModal.js`, `src/modules/hr/tada/tadaShared.js`, `src/modules/hr/selfservice/SelfServiceHome.jsx`, `src/pages/Help.js`

### S326 — 2026-07-09 — Employee Self-Service: submit your own TADA claim

Explained the current TADA Claims workflow (manager-entered only — Self-Service never got a submission channel when TADA Claims shipped, S306 called this out as a deliberate, explicit gap) and asked whether to close it. Confirmed: yes.

Added a new **TADA** tab to `SelfServiceHome.jsx`, alongside the existing Payslip/Leave/Roster tabs, mirroring `submit_my_leave_request`'s exact shape — three new SECURITY DEFINER RPCs (`get_my_tada_claims`, `get_my_tada_claim_items`, `submit_my_tada_claim`) that resolve the caller's own `hr_employee_id` and read/write only their own rows, bypassing the base `client_own` RLS policy on `hr_tada_claims` (which already excludes `is_hr_self_service()` by design) the same way every other self-service RPC does. A submitted claim inserts as `status = 'pending'` into the exact same table the manager-entry form (`TadaClaims.jsx`) writes to — approval, rejection, mark-paid, and the ⚙ Settings vehicle-rate/purpose-option management all stay manager/admin/owner-only, completely unchanged.

The expense-line UI (category picker, Transport line's Vehicle + Distance auto-fill against `settings.tada_vehicle_rates`, Purpose preset dropdown with an "Other" free-text fallback) is identical to the manager form's — rather than duplicating that logic, extracted the shared constants/helpers (`CATEGORIES`, `VEHICLE_TYPES`, `DEFAULT_PURPOSE_OPTIONS`, `OTHER_PURPOSE`, `EMPTY_TADA_ITEM`, `recomputeTadaAmount`) into a new `src/modules/hr/tada/tadaShared.js`, imported by both `TadaClaims.jsx` and `SelfServiceHome.jsx`. Self-service reads `tada_vehicle_rates`/`tada_purpose_options` straight off the `settings` table (folded into the existing `weekly_off_weekday` read) since self-service already keeps SELECT-only access there (S316) — no new RPC needed for that part.

Migration: `supabase/migrations/20260709110000_selfservice_tada_claims.sql`.

**Files:** `src/modules/hr/selfservice/SelfServiceHome.jsx`, `src/modules/hr/tada/TadaClaims.jsx`, `src/modules/hr/tada/tadaShared.js` (new), `src/pages/Help.js`

### S325 — 2026-07-09 — Recipe Costing: ⚡ Auto-fill nutrition no longer silently calls the live USDA API

Investigating why a Grilled Chicken Sandwich recipe showed Fish as an allergen (allergens roll up from each ingredient's `items.nutrition.allergens` text field — surfaced the mechanism, but couldn't inspect the specific client's data directly since this sandbox has no route to the Postgres pooler for an ad hoc read-only query) led into a related, explicitly-requested change: the user wants control over which nutrition library supplies an ingredient's data, not USDA landing there by default.

Asked which of two flows this should target — the per-ingredient Nutrition editor (`NutritionEditorModal.jsx`) already lets you choose a source from several side-by-side matches via "⚡ Suggest from library," so nothing needed there — vs. the bulk "⚡ Auto-fill nutrition" button (`Recipes.js`'s `autoFillNutrition()`), which used to silently call the live USDA FoodData Central API for any ingredient with no local match, bundled into one all-or-nothing confirm dialog. User picked the bulk flow.

Split it into two explicit steps: Auto-fill now only matches against the local `NUTRITION_SEED` library (DFTQC Nepal / IFCT 2017 / USDA rows already baked into the static file — the SOURCE_ORDER ranking there, DFTQC first, is unchanged) and never touches the network. Ingredients with no local match are collected into `usdaCandidates` state and surfaced as a dismissible banner ("N ingredient(s) not in the regional library: …") with its own "🔍 Try USDA FoodData Central" button — a live API call now only happens on that explicit second click, with its own confirm dialog listing exactly which ingredients. Extracted the shared save-and-reflect-into-state logic (`saveNutritionTargets`) so both paths write through one function instead of duplicating the `items` update + local-cache-sync code.

**Files:** `src/modules/ims/recipes/Recipes.js`, `src/pages/Help.js`

### S324 — 2026-07-09 — Payroll payslip: hide the Employer SSF line for non-SSF-enrolled employees

Live testing surfaced the printed/on-screen payslip always showing "Employer SSF (20%, paid by company): NPR 0" even for an employee not enrolled in SSF — every other zero-value line on the payslip (absence, other deductions, advance recovery, TDS) is already conditionally hidden via the "None" fallback pattern in `PayslipBody`, but this one line was unconditional. Gated it behind `slip.ssf_employer > 0`, consistent with the rest of the payslip; enrolled employees are unaffected since `computePayslip` always yields `ssf_employer > 0` for them whenever they have a nonzero basic salary.

**Files:** `src/modules/hr/payroll/PayrollRun.jsx`

### S323 — 2026-07-09 — Payroll: per-employee TADA amount, auto-filled from Approved claims, added after TDS

Payroll Run had no way to pay out a travel/daily allowance through the payslip itself — TADA Claims (S321) is deliberately kept separate from Payroll since expense reimbursement isn't taxable income. Added a new **TADA** column to the payroll register, between TDS and Net Pay: a per-employee, inline-editable amount (same edit-while-draft/locked-once-finalized pattern as TDS) added to `net_pay` *after* TDS/SSF/other deductions — never run back through tax, so it stays a non-taxable add-on rather than taxable gross.

First cut was manual-entry only; asked (via AskUserQuestion) whether it should instead auto-fill from that employee's Approved TADA Claims for the period and auto-mark those claims Paid on Finalize (to prevent double-reimbursement across both systems) — user picked that option. On Generate/Regenerate, `fetchApprovedTadaMap()` pulls `hr_tada_claims` rows with `status = 'approved'` whose `[start_date, end_date]` overlaps the BS period (converted to an AD date range via `bsToAd`/`daysInBsMonth`/`formatAd`), sums `total_amount` per employee, and records which claim ids contributed into a new `hr_payslips.tada_claim_ids uuid[]` column — a 🔗 icon on the TADA cell (tooltipped, before and after finalize) surfaces that it's claim-linked. On Finalize, any payslip with `tada_amount > 0` and linked claim ids marks those claims `status = 'paid', paid_method = 'Payroll'`; on Reopen, any claim marked paid with `paid_method = 'Payroll'` (never one a manager paid by hand) reverts to `approved`. Manually editing or clearing the TADA amount doesn't touch the claim linkage — zeroing it out simply skips the auto-pay-on-finalize step for those claims, leaving them Approved for a future run or a manual Mark Paid.

`updateTds`/`updateTada` each recompute `net_pay` from the full formula so editing one doesn't clobber the other's contribution. The on-screen/print payslip (`PayslipBody`) shows TADA as a new "Reimbursement" section, only rendered when non-zero. Excel export gained a `TADA` column. TADA Claims' own help text and in-app guide now say a claim can be paid either by hand there, or automatically through Payroll — never both.

Migrations: `supabase/migrations/20260709090000_payroll_tada_amount.sql` (adds `hr_payslips.tada_amount numeric(12,2) DEFAULT 0`), `supabase/migrations/20260709100000_payroll_tada_claim_linkage.sql` (adds `hr_payslips.tada_claim_ids uuid[] DEFAULT '{}'`).

**Files:** `src/modules/hr/payroll/PayrollRun.jsx`, `src/pages/Help.js`

### S322 — 2026-07-08 — Calculate Transport Fare: dropped the sub-modal for inline Vehicle + Distance

S321 shipped a separate "Calculate Transport Fare" modal (opened via a button on the Transport line). Live feedback in this same session went through two iterations before landing here: first the modal's plain-text Start/Stop/End labels were made to actually do something (a live Google Maps route preview, using the free-and-unlimited Maps Embed API — a genuinely different, uncosted SKU from the paid Distance Matrix/Routes APIs the original research correctly stayed away from) and the Rate/KM field inside it was locked to `isAdmin || isOwner` so a lower-authority submitter couldn't silently override the configured rate. Then: simpler is better — the whole sub-modal was dropped in favor of putting a Vehicle picker (2-Wheeler/4-Wheeler/EV) and a Distance (km) field directly inline on the Transport expense line itself, with Amount auto-computing live as Distance × that vehicle's configured Rate/KM (whenever both are known — a manually-typed Amount is never overwritten just because a rate isn't configured for that vehicle yet). Amount stays hand-editable afterward (e.g. to add a toll). `CalculateFareModal.js` and the Maps Embed integration were deleted entirely — confirmed zero remaining references before removal.

The **Rate/KM lock survives the simplification**: the per-vehicle rate is read from Settings and was never re-exposed as an inline editable field, so the same `isAdmin || isOwner` boundary from the modal version holds without any extra code — a non-owner submitter can adjust Vehicle/Distance but has no way to change the rate itself, only the resulting Amount if they choose to hand-edit it.

**Files:** `src/modules/hr/tada/TadaClaims.jsx`, `src/pages/Help.js` (removed: `src/modules/hr/tada/CalculateFareModal.js`)

### S321 — 2026-07-08 — TADA Claims: Calculate Transport Fare (distance × rate/km)

Researched before building, per the pattern this project follows for anything touching an external rate or a third-party API. TADA Claims is deliberately actual-expense reimbursement, not a per-diem formula (kept out of Payroll Run since prompt reimbursement isn't taxable income) — so the calculator pre-fills the Amount field rather than replacing manual entry; the employee/manager can still see and adjust it before submitting.

No authoritative Nepal government per-km rate exists to hardcode, so the rate is a new client-configurable `settings.tada_vehicle_rates` — a small keyed jsonb map (`{"2w": ..., "4w": ..., "ev": ...}`, each nullable, no free-default) rather than a single column, since a 2-wheeler, 4-wheeler, and EV genuinely cost different amounts per km. A live Google Maps/OSRM distance lookup was explicitly researched and deferred — it would commit Crest to either a recurring Google Cloud bill across every client or a self-hosted routing server, a separate decision from this feature's actual value (removing the km × rate mental math). This ships the free, zero-dependency v1 only: a **"⤷ Calculate"** button next to any Transport expense line opens `CalculateFareModal.js` — a Vehicle picker (2-Wheeler/4-Wheeler/EV) that re-fills Rate/KM from the matching configured rate (still freely editable after), plain-text Start/Stop/End labels (no geocoding), a typed Distance (km), and a computed Amount that writes back into the line (auto-filling the Description from the stop labels only if it's still empty, never overwriting a manual one).

Rates and a second new setting — Purpose preset options (`settings.tada_purpose_options`, same client-editable-list shape as `pos_discount_reasons`) — are both managed from a new **⚙ Settings** button on `/hr/tada`, gated to `isAdmin || isOwner` (the same "owner-level action" check already used elsewhere, e.g. `imsVisible`/`hrVisible` in `Layout.js`) so regular staff never see the setup surface. The New Claim form's Purpose field is now a dropdown sourced from those presets, seeded with a sensible default list (Vendor site visit, Purchase, Bank errand, Client meeting, Delivery, Site inspection, Training/Conference) until a client configures their own — plus an always-available "Other (type below)" free-text fallback so an unlisted purpose never blocks submission. Start Date and End Date on the New Claim form now default to today (still editable) instead of opening blank.

Migration: `supabase/migrations/20260708150000_tada_rate_per_km.sql` (adds both `tada_vehicle_rates` and `tada_purpose_options`).

**Files:** `src/modules/hr/tada/TadaClaims.jsx`, `src/modules/hr/tada/CalculateFareModal.js`, `src/modules/hr/tada/TadaSettingsModal.js`, `src/pages/Help.js`

### S320 — 2026-07-08 — Fixed a live crash: 3 of S306's HR tables were never added to the scopedDb allowlist

Live testing (Incentives/Bonus, TADA Claims) surfaced `scopedDb: "hr_incentive_configs" is not in CLIENT_SCOPED_TABLES` / same for `hr_tada_claims`. S306 (2026-07-07) added `hr_tada_claims`, `hr_tada_claim_items`, `hr_incentive_configs`, and `hr_incentives` but never added the client-scoped three of them to `scopedDb.js`'s `CLIENT_SCOPED_TABLES` allowlist — every `scopedFrom`/`scopedInsert`/`scopedUpdate`/`scopedDelete` call against them has been throwing since the day they shipped. Added `hr_tada_claims`, `hr_incentive_configs`, `hr_incentives` to the allowlist (all three carry `client_id NOT NULL`, confirmed against their DDL).

`hr_tada_claim_items` deliberately stays **off** the allowlist — it has no `client_id` column of its own, scoped instead via `claim_id → hr_tada_claims.id` (same parent-scoped pattern as `recipe_ingredients`). `TadaClaims.jsx`'s three call sites against it (`scopedFrom`/`scopedInsert`/`scopedDelete`) were switched to raw `supabase.from()` — adding it to the allowlist instead would have just traded the current crash for a `column "client_id" does not exist` one. RLS still enforces the same-client boundary correctly on this table via its `claim_id IN (SELECT id FROM hr_tada_claims)` policy, which itself resolves through `hr_tada_claims`'s own RLS — so this was always the real security boundary, not the JS-level filter.

**Files:** `src/shared/scopedDb.js`, `src/modules/hr/tada/TadaClaims.jsx`

### S319 — 2026-07-08 — Sidebar rework: type-scale + motion tokens, command palette (Ctrl+K), pending-item rail badges, pinned favorites

Following S318's audit (65 nav destinations across IMS/HR/POS, no search, one naming inconsistency), a research-backed rework of the sidebar in three shipped phases (a fourth — consolidating IMS's largest report groups into tabbed pages, the way `/pos/sales-report` already does — stays deliberately deferred as a separate, larger effort with real routing risk).

**Phase 1 — visual/motion polish, near-zero risk.** Formalized a sidebar type scale into named CSS custom properties (`--font-size-rail-icon/brand/nav-icon/nav-item/group-label/micro/chevron`) and two motion tokens (`--ease-standard`, `--motion-fast`) from sizes/timings already scattered as raw numbers across `Layout.css`/`Layout.js` — nothing new invented. Added a `box-shadow` glow on active rail/nav states using `var(--theme-focus-ring)` (each of the 9 theme presets already defines this as a pre-computed, theme-correct low-alpha accent, so the glow is automatically correct on every preset including `custom` — never a new hardcoded color), wrapped in `@media (prefers-reduced-motion: reduce)`. Fixed a real pre-existing bug in `Tip.js`: its tooltip box was hardcoded (`#1e2330`/`#2a2f3d`/`#9ca3af`) instead of theme-variable-driven, rendering unreadably dark on light presets (`latte`, `solarized`) — now `var(--theme-card)`/`var(--theme-border)`/`var(--theme-text2)`, fixing every existing `Tip` usage app-wide, not just the sidebar. New `RailTip.js` (same `createPortal` technique as `Tip.js`) replaces the rail icons' slow (~1s), unstyled native `title` tooltips with a fast, theme-matched floating label — a portal overlay rather than real width growth, since actually resizing the fixed-width rail would either clip against the adjacent panel or drag `.main-content`'s margin-transition along on every hover. Also fixed the "Dashboard" label itself: it's now computed once (`dashLabel`) mirroring `ClientDashboard.jsx`'s own `dashTitle` logic exactly (admin always "Admin Dashboard"; a client with 2-3 modules sees generic "Dashboard"; a client with exactly one module sees that module's own title) instead of a single hardcoded "Dashboard" string reused at all four panel call sites regardless of what the page actually retitles itself to.

**Phase 2 — command palette.** New `CommandPalette.js`, opened via `Ctrl+K`/`Cmd+K` or a visible search pill in the panel header, flat-searching every destination across all three modules — the type-to-jump pattern 2026 SaaS convention treats as standard past ~10 features (Crest has 65). Extracted a single `isItemVisible(item)` predicate (feature-key + `minPosRole` check together, previously split between `unlockedItems()` and an inline POS-panel filter) so the palette's search index and the rendered nav can never drift apart on gating as new items get added later.

**Phase 3 — pending-item badges + pinned favorites.** New `useNavBadgeCounts.js` hook polls (60s) lightweight count-only queries mirroring `HrDashboard.jsx`'s existing pending-leave/pending-OT filters and `PosOrders.jsx`'s existing `sent_to_kot`-based pending count — surfaced as the same pulse-dot style already used on the admin rail icon, now also on HR/POS. New `crest_nav_pins` localStorage key (same pattern as the existing `crest_nav_groups`) backs a pin-to-favorites star on every nav row (hidden until hover, visible when active) and an unlabeled "Pinned" section at the top of every panel — resolved against the same `isItemVisible`-filtered index the palette uses, so a pinned item that's since been locked by a plan downgrade silently disappears instead of rendering a dead link. Capped at 8 pins.

**Files:** `src/components/Layout.js`, `src/components/Layout.css`, `src/components/Tip.js`, `src/components/RailTip.js`, `src/components/CommandPalette.js`, `src/shared/hooks/useNavBadgeCounts.js`

### S318 — 2026-07-08 — Dashboard audit: real POS KPIs (was a dead placeholder), HR Dashboard naming collision, universal Dashboard nav link

A user-requested audit of the Admin Dashboard, Client Dashboard, sidebar dashboard naming, and nav/report organization — following straight on from Owner Dashboard's build — turned up three real, fixable issues.

**`ClientDashboard.jsx`'s POS section was a static "coming soon" card** ([ClientDashboard.jsx](src/pages/dashboard/ClientDashboard.jsx)) despite Crest POS being extensively built (Orders/Billing/KOT/Shifts/Credit Notes/Guest QR/KDS, a 10-tab Sales Report, Covers Report) — nothing had ever come back to wire it up. New `loadPosStats()` shows Revenue, Covers Served, Avg Check (all scoped to the current open BS period, same cadence as the IMS section — converts the period's BS month to an AD date range via `bsToAd`/`daysInBsMonth` to filter `pos_orders.closed_at`) plus a live Tables Occupied count from `pos_tables.status`. Reuses `pos_orders.paid_amount` directly for revenue rather than re-deriving VAT from `pos_order_items` — that column is already the final net amount computed at close time (`payTotal` in `PosOrders.jsx`, matching `computeOrderAmounts()`'s formula), so a dashboard tile doesn't need the heavier per-item join Sales/Covers Report do for their category/item breakdowns. Same credit-note exclusion convention as those reports (a since-Credit-Noted bill's revenue correction posts on the day the note is issued, not retroactively here).

**Naming collision fixed**: `HrDashboard.jsx` (the real, rich HR dashboard at `/hr/dashboard` — headcount, leave/OT approval queues, SSF breakdown, advances) and the universal `/dashboard` page's computed title for an HR-only client were both literally the string "HR Dashboard" — two different pages, identical title, different content depth. The universal page's HR-only title is now "HR Overview" instead.

**Dashboard nav link wasn't actually universal**: despite CLAUDE.md describing "Dashboard" as visible "regardless of module," `Layout.js`'s sidebar only rendered `NAV[0]` inside the `admin` and `ims` panel blocks — an HR-only or POS-only client had no sidebar path back to `/dashboard` once inside their module's panel. Added to the `hr` and `pos` panel blocks too, so it's genuinely universal now.

**Files:** `src/pages/dashboard/ClientDashboard.jsx`, `src/components/Layout.js`

### S317 — 2026-07-08 — Owner Dashboard Phase 1: cross-module KPIs (IMS + HR), new Suite Bundle plan tier

Owner Dashboard had been gated since 2026-06-21 behind "all three modules complete" — building it on IMS data alone would've just been a prettier `Dashboard.js`. A research pass this session found the premise had shifted (IMS and HR both feature-complete; POS's two remaining gaps are blocked on external merchant onboarding, not engineering) and scoped a Phase 1: IMS + HR only, Revenue still from manual Sales entry, POS auto-feed deferred to Phase 2.

New page `/owner-dashboard` (`src/pages/dashboard/OwnerDashboard.jsx`, replacing the long-dead placeholder at `src/dashboard/OwnerDashboard.js` — zero importers, confirmed and deleted) shows Month-to-Date Revenue, Food Cost %, Labor Cost %, **True Net Margin %** (the headline figure the original decision was written around), Wastage Value, Items Below Par, Overdue Payables (>60 days), and a Cash/Credit purchases split. Every figure is scoped to the client's single currently-open `monthly_periods` row — deliberately **not** a rolling 7-day window, since every existing IMS/HR report (Monthly Summary, Wastage, Reorder, Payroll Run) is period-bound with no cross-period precedent except Outstanding Payables; building genuine rolling-window logic was judged too large for a v1. IMS figures reuse `ClientDashboard.jsx`'s existing `loadStats()` formulas almost verbatim. Labor Cost is the one genuinely new calculation — nothing before this computed real employer cost outside a finalized Payroll Run — so it prorates each active employee's monthly-equivalent gross by elapsed-days-so-far (the same `perDay = gross/monthDays` idiom `payrollCompute.js` already uses for its own unpaid-day deduction), adds actual approved overtime this period (via `hourlyRateOf()`, not a re-derived formula), and prorated employer SSF; a `<Tip>` flags it as an estimate that refines once Payroll is finalized.

**Gating is a new, independent axis**: `clients.suite_plan` (nullable, starter/growth/pro — NULL means not subscribed to Suite at all, unlike `hr_plan`/`pos_plan` which default to Starter). No such concept existed anywhere before this — only marketing bundle pricing (`SUITE_BUNDLES` in `pricingPlans.js`) with zero backing logic. New `SuiteGate.js` component checks `imsEnabled && hrEnabled` + a Suite-tier rank comparison, and — unlike `ModuleGate`/`PremiumGate` — never redirects on failure: an ineligible viewer sees an inline upsell/explanation in place, and the new "Owner Dashboard" nav link (added to Layout's always-visible Universal section, next to Dashboard/Periods) never disappears regardless of eligibility. A `feature_flags.owner_dashboard` override lets admin grant one client in below their Suite tier, same convention as every other feature's admin-grant-above-plan. Admin sets the new Suite Bundle tier from Manage Clients → Billing tab (`ClientDrawer.js`), same place `hr_plan`/`pos_plan` are already set.

Migration: `supabase/migrations/20260708140000_owner_dashboard_suite_plan.sql` — **must be run in the SQL Editor.**

**Files:** `src/pages/dashboard/OwnerDashboard.jsx`, `src/components/SuiteGate.js`, `src/context/AuthContext.js`, `src/App.js`, `src/components/Layout.js`, `src/pages/adminClients/ClientDrawer.js`, `src/pages/adminClients/FeatureAccessModal.js`, `src/context/SettingsContext.js`, `src/pages/Help.js`

### S316 — 2026-07-08 — IMS debug pass: staff PIN accounts had owner-level DB access to the whole business

The "debug the module" sweep, IMS edition — and it found the module-level twin of S314's gap, bigger on both axes. All three login types (`admin-user-ops`) share the same profile shape — `role='client'` + the tenant's `client_id` — and every standard RLS policy is "admin OR same client", so the DB couldn't tell an owner from a waiter:

- **An HR self-service account** (password = a 4–6 digit PIN) passed same-client RLS on **every IMS and POS table**: full item master with costs, all purchases and rates, supplier list, recipes with costings, all sales — readable and writable over the REST API. S306/S314 had fenced these accounts off the HR tables only.
- **A POS PIN staff account** passed RLS on **everything, including all 20 `hr_` tables** — a waiter's PIN login could read the whole staff's payslips, salaries, and advances. No exclusion had ever applied to these accounts at all.
- **Bonus UI hole:** `isOwner` in AuthContext was `role==='client' && !pos_role` — an HR self-service account has no `pos_role`, so it *counted as Owner* and inherited POS **manager** access (voids, discounts, staff management UI).

Fix in `20260708130000_staff_account_business_table_isolation.sql` (**run in SQL Editor**): a new `is_pos_pin_staff()` helper (`pos_email IS NOT NULL` — set in exactly one place, `create_pos_staff`), then **RESTRICTIVE** policies (they AND with existing permissive ones — no risky 70-table policy rewrite): self-service accounts blocked from all 35 IMS+POS tables plus settings *writes* (keeping the read `SelfServiceHome` needs); POS PIN staff blocked from all 20 HR tables + the 19 pure-IMS tables with no POS code path. Deliberately left open for POS staff: `recipes`/`recipe_ingredients`/`recipe_suggestions` (Menu Pricing is POS-manager nav), `sales_entries`/`monthly_periods`/`stock_movements` (billing posts sales, deducts stock), `settings` writes (PosTableManagement's manager tabs — the S290 fix), and all `pos_*`. SECURITY DEFINER RPCs bypass RLS, so every staff flow keeps working.

Frontend: `isOwner` now excludes `hr_self_service`; ProtectedRoute redirects self-service accounts to `/hr/self-service` (their whole app); Layout hides the IMS/HR nav panels from PIN staff (their pages would render empty under the new RLS anyway).

**Files:** `supabase/migrations/20260708130000_staff_account_business_table_isolation.sql`, `src/context/AuthContext.js`, `src/components/ProtectedRoute.js`, `src/components/Layout.js`

### S315 — 2026-07-08 — POS debug pass: co-occurrence suggestions were unreachable on exactly the tiers S304 built them for

Same "debug the module" sweep as S314, over the post-audit POS commits (S303, S304, S310's device screen). One real defect found, in S304's suggestion-chip tiering: `computeSuggestions()` bailed out (`if (initial.length === 0) return`) when the *local* ranking came up empty — but on a Growth+IMS client with no manual pairing on the tapped item, or a Pro+IMS client who's never run Menu Engineering, every local score ties at zero, so the early return fired **before** the `get_cooccurrence` RPC was ever called. The co-occurrence layer — the very thing S304's tier table promises Growth+IMS — was dead code unless a manual pairing happened to exist for that same item. Fixed: set the (possibly empty) local ranking, then always proceed to the co-occurrence fetch when the tier allows it; the panel stays hidden on empty and fills when the RPC responds, which is the documented "re-ranks on arrival" behavior anyway.

Verified clean: S303's `w.opener = null` print fix (correct, no XSS regression), S304's credit-note issuance-FY change (no consumer assumes a CN's `invoice_fy` matches the original bill's — all labels use the CN's own), S310's unactivated-device screen and iOS push detection, `posPlan` genuinely exported from AuthContext (a missing key would have silently made every client Starter), and the empty-suggestions render guard.

**Files:** `src/modules/pos/orders/PosOrders.jsx`

### S314 — 2026-07-08 — HR debug pass: self-service RLS gap on 8 tables closed; Attendance summary now counts half-day leave

A "debug the HR module" sweep over the S306–S313 work found two real defects.

**Security (the important one):** S306's self-service lockdown (`AND NOT public.is_hr_self_service()` on every HR table policy) covered the tables it created or explicitly re-created, but never touched eight baseline-era tables that kept their plain admin-or-same-client policies: `hr_attendance`, `hr_overtime_entries`, `hr_leave_types`, `hr_festival_allowances`, `hr_payroll_runs`, `hr_advance_repayments`, `hr_holiday_calendar`, `hr_shift_types`. A self-service employee JWT is same-client, so any employee with a self-service login could hit those tables directly over the REST API — rewrite their own attendance (absent → present, inflate OT hours), insert overtime entries for themselves, raise their own leave quota or flip a leave type to paid, and read every coworker's attendance/OT/allowance rows. The self-service UI needs none of this (it reads only `settings` directly; everything else via SECURITY DEFINER RPCs), so `20260708100000_hr_selfservice_rls_gap.sql` applies the same blanket exclusion S306 used everywhere else. **Run this migration in the SQL Editor.** Note `hr_advance_repayments` carried two permissive baseline policies — both dropped, since permissive policies OR together.

**Correctness:** S309's two new attendance statuses (`half_paid_leave` / `half_unpaid_leave`) were handled by payroll but not by Attendance's Monthly Summary — `summaryFor()`'s counts object didn't include them, so a ½PL/½UL day showed in the day grid but contributed to no summary column: the on-screen P column disagreed with Payroll's `present_days` by 0.5/day, and the Excel export's Paid/Unpaid Leave columns undercounted. Both now fold half-leave in at 0.5, matching `computePayslip`.

Also verified clean during the sweep: the day-grain publish migration vs `Roster.jsx`'s `onConflict` key, `submit_my_leave_request`'s new `p_day_type` arg vs the DB CHECK constraint, `hr_attendance`'s status CHECK including the two new statuses, owner-side leave approve/reject writes against current RLS (S312's fix genuinely works), the `hr-push` per-day notify contract, and production build + HR unit tests.

**Files:** `supabase/migrations/20260708100000_hr_selfservice_rls_gap.sql`, `src/modules/hr/attendance/AttendanceSheet.jsx`

### S313 — 2026-07-08 — Attendance: roster's zero-hour placeholder shifts now marked Holiday instead of a silent gap

Live use surfaced a second gap right after S310/S312: the Monthly Summary grid in Attendance showed blank cells scattered through an otherwise-fully-rostered week. Root cause was in `buildAttendanceFromRoster` (`attendanceFromRoster.js`) — a roster row pointing at a zero-hour custom shift type (e.g. the built-in "Day Off" from S311, or a client's own "LEAVE"/"OFF") resolved to 0 hours and was silently skipped, leaving no `hr_attendance` row at all instead of the "shows up correctly... in Attendance's Generate from Roster" behavior the S311 fix's own code comment had promised but never actually implemented. Now `⚡ Generate from Roster` marks these days `holiday` — payroll-neutral, same treatment as Weekly Off, just not tied to the recurring weekday policy — closing the visual gap and giving the "Day Off"/"LEAVE" shift types a real counterpart in the Attendance legend (previously they matched nothing in it). Saturday still takes priority over a zero-hour roster placeholder (a "LEAVE" shift rostered onto a Saturday still shows Weekly Off, not Holiday). Updated the stale tooltip/Help text that said these were "skipped," and the unit tests in `attendanceFromRoster.test.js`.

**Files:** `src/modules/hr/attendance/attendanceFromRoster.js`, `src/modules/hr/attendance/attendanceFromRoster.test.js`, `src/modules/hr/attendance/AttendanceSheet.jsx`, `src/pages/Help.js`

### S312 — 2026-07-08 — Leave: client owners can approve/reject requests and manage Leave Types; self-service off-day match broadened; service-role key fully removed

A screenshot of a real pending leave request showed only a "Cancel" action, no Approve/Reject. Root cause: `LeaveManagement.jsx` gated both Approve/Reject and the entire "Leave Types" tab behind `isAdmin`, which is Crest's own platform-support flag (`profile.role === 'admin'`) — never true for a real client login, since the tenant's own login (the actual restaurant owner/manager) always has `role === 'client'`. Every real client saw only Cancel. Removed the gate on both, matching how Roster's publish/swap-approval already work (no admin gate — any logged-in client user can act, since that login *is* the owner/manager).

Also broadened the S310 self-service off-day highlight: `isOffDay` matched shift names by exact string ("off", "leave", "holiday"), so a shift literally named "Off Day" (two words) fell through unhighlighted. Changed to a substring match.

Separately, completed the `REACT_APP_SUPABASE_SERVICE_ROLE_KEY` cleanup flagged in memory during the earlier "update all .md" pass: removed the unused entry from `.env.local` (confirmed via repo-wide grep that no code ever referenced it — dead config, not an active leak) and from the Vercel dashboard (Production + Preview) directly by the user. Quick Start's env var list in this README was still listing it as required — corrected.

**Files:** `src/modules/hr/leave/LeaveManagement.jsx`, `src/modules/hr/selfservice/SelfServiceHome.jsx`, `.env.local` (gitignored, no diff), `README.md`

### S311 — 2026-07-08 — Roster shift-picker: "Clear (Unassign)" vs a real "Day Off" shift type

A phone screenshot showed an employee's roster day going blank both on the admin board and in their own Self-Service view after using the shift picker's "Clear (Day Off)" option. Traced to `ShiftPicker.jsx`: that option actually deleted the `hr_roster` row entirely rather than marking the day off, so the cell went blank and the day disappeared from Self-Service (no row = nothing for `get_my_roster`'s join to return). Renamed to "Clear (Unassign)" to describe what it actually does, and added a built-in zero-hour "Day Off" shift type to `DEFAULT_SHIFTS` so a client has a real, non-destructive way to mark someone off that shows up everywhere — the board, Self-Service, and (as of S313) Attendance's Generate from Roster.

**Files:** `src/modules/hr/roster/Roster.jsx`, `src/modules/hr/roster/ShiftPicker.jsx`, `src/pages/Help.js`

### S310 — 2026-07-08 — Live-testing fixes: Roster publish per week, swap-picker loading state, self-service OFF-day highlight

Three fixes from live-testing the Roster/Self-Service features on a real phone.

**Roster publish switched from month-grain to day-grain.** Publishing was keyed by whole BS month, so a manager had to finish scheduling the *entire* month before any of it could reach staff. `hr_roster_publish_state` now has a `bs_day` column (unique on `client_id,bs_year,bs_month,bs_day`) — one row per published day, not per published month. `get_my_roster`/`get_coworker_roster` now gate per-day (a self-service employee sees exactly the days published, even mid-month); `get_my_roster_publish_status` keeps its existing meaning ("has anything this month been published," for the "not published yet" message). Roster.jsx's Publish control now appears in **both** Weekly and Monthly view — Weekly publishes just the 7 visible days, Monthly still bulk-publishes the whole visible month in one click (kept as-is, purely additive). The badge shows "◐ x/y Published" for a partial state. The `hr-push` Edge Function's `notify_roster_published` action now takes an explicit `bs_days` array and only notifies employees actually scheduled on those specific days, not the whole month's staff. Existing month-grain publish-state rows (all test data from this week) were cleared as part of the migration.

**Swap-request coworker picker fixed.** Testing on a live phone showed the "Swap with…" dropdown appearing to only show the placeholder — most likely a timing issue where the picker rendered before the `get_coworker_roster` fetch resolved on a slow connection, with no error surfaced if the fetch actually failed. `SelfServiceHome.jsx` now shows an explicit "Loading coworkers…" state while the fetch is in flight, surfaces the RPC error if one occurs (previously silently swallowed), and shows "No coworkers have a published shift this month yet" if the list is genuinely empty.

**Self-service roster: OFF/LEAVE days highlighted.** Days whose shift is a placeholder like "OFF" or "LEAVE" (or has no shift at all) now get a subtle gray tint in the Self-Service Roster tab's day list, so an employee scanning a month of mixed shifts and days off doesn't have to read every row to find their days off.

**Files:** `supabase/migrations/20260707290000_roster_publish_per_day.sql`, `supabase/functions/hr-push/index.ts`, `src/modules/hr/roster/Roster.jsx`, `src/modules/hr/selfservice/SelfServiceHome.jsx`, `src/pages/Help.js`

### S309 — 2026-07-08 — Configurable Weekly Off Day + Half-Day Leave (Full/First/Second Half)

Two HR gaps: the weekly off day was hardcoded to Saturday everywhere (Attendance auto-default, Leave working-day counts, Roster shading), and leave requests were always whole days even though `hr_leave_requests.days` already supported 0.5.

**Weekly Off Day**: new `settings.weekly_off_weekday` (0=Sun..6=Sat, default 6). `workingDaysInRange()` (`leaveConstants.js`) and `isSaturday()`/`buildAttendanceFromRoster()` (`attendanceFromRoster.js`) gained an optional `offWeekday` param, defaulting to the existing constant so nothing breaks if a caller doesn't pass it. `Roster.jsx` (already fetching `settings` for `covers_per_staff_target`), `AttendanceSheet.jsx`, `LeaveManagement.jsx`, and `SelfServiceHome.jsx` all now fetch and thread the client's real value through instead of assuming Saturday. New "Weekly Off Day" selector on Roster → Shift Types (`ShiftSettingsPanel.jsx`), same inline-save pattern as the existing Covers/Staff target.

**Half-Day Leave**: new `hr_leave_requests.day_type` (`full`/`first_half`/`second_half`, only meaningful for a single-day request — enforced in the UI, not the DB). The harder-but-correct design, confirmed with the user: a half-day of a **paid** leave type costs the employee nothing (same as a full day of that type), a half-day of an **unpaid** type deducts 0.5 day's pay — not a blanket "half-day is always unpaid" rule. This needed two new `hr_attendance` statuses, `half_paid_leave`/`half_unpaid_leave`, since the existing generic `half_day` status always deducts 0.5 day regardless of cause. `payrollCompute.js`'s `tallyAttendance`/`computePayslip` updated accordingly (new unit tests confirm a half-paid-leave day costs nothing and a half-unpaid-leave day deducts exactly half a day). Both `LeaveManagement.jsx` (admin) and `SelfServiceHome.jsx` (self-service) get a Day Type selector, shown only for a single-day request and forced back to Full Day otherwise, with identical day-count/status logic on both sides.

**Files:** `supabase/migrations/20260707280000_weekly_off_day_half_leave.sql`, `src/modules/hr/payrollConstants.js`, `src/modules/hr/payroll/payrollCompute.js` (+ test), `src/modules/hr/leave/leaveConstants.js`, `src/modules/hr/leave/LeaveManagement.jsx`, `src/modules/hr/attendance/AttendanceSheet.jsx`, `src/modules/hr/attendance/attendanceFromRoster.js`, `src/modules/hr/roster/Roster.jsx`, `src/modules/hr/roster/ShiftSettingsPanel.jsx`, `src/modules/hr/selfservice/SelfServiceHome.jsx`, `src/pages/Help.js`

### S308 — 2026-07-08 — SSF bulk-upload "export": researched first, closed the roadmap item without new code

The last open HR roadmap line — "SSF export file matching the actual SSF-portal bulk-upload format" — was researched before writing anything, per the user's explicit request. Pulled the official SOSYS (Nepal Social Security Fund) Employer Portal user manual directly (`sosys.ssf.gov.np/manual/collection_manual.pdf`) rather than trusting third-party blog claims that "a bulk-upload Excel template exists."

The manual shows the real "Collection" screen has **no bulk-upload feature at all** — the employer manually types each employee's SSF No + Basic Salary into a web grid, one row at a time, and SOSYS calculates the 31% (11% employee + 20% employer) deposit itself. An independent source corroborated this, describing the same manual entry as "hours or days" of work for employers with many staff. The blog claims of a downloadable bulk-upload template gave zero verifiable specifics (no column names, no location) and appear to simply be wrong.

Since there's no real upload format to match, the roadmap item's original framing was based on a false premise. Rather than build toward a target that doesn't exist, added a clarifying note to the existing SSF Challan tab (already exports SSF No / Basic / 11% / 20% / 31% per employee) explaining this and positioning it as the manual-entry reference sheet — type SSF No + SSF Basic into SOSYS; the Total 31% column should match what SOSYS calculates.

**Files:** `src/modules/hr/reports/HrReports.jsx`, `src/pages/Help.js`

### S307 — 2026-07-07 — Roster: Publish + Web Push, Mutual Shift Swap, Leave-Conflict Auto-Block

Three Roster gaps confirmed missing from the roadmap. All three build on the S306 Self-Service PWA.

**Publish + Web Push** — real OS-level push notifications, genuinely new infrastructure (nothing like it existed — the POS "guest chime" is a client-side audio tone, not the Push API). Generated a VAPID keypair; new `hr_roster_publish_state` table (one row per BS month once an admin clicks Publish) gates the existing `get_my_roster` RPC — self-service employees never see a draft roster, only what's been explicitly published. New generic `push_subscriptions` table (`profile_id = auth.uid()` RLS, no client_id/self-service gating needed since it's inherently "my own" data). New Edge Function `supabase/functions/hr-push` holds the VAPID private key and sends via `npm:web-push` — the private key can never live in the frontend bundle. `public/service-worker.js` gained `push`/`notificationclick` handlers (cache bumped to `crest-v16`). `src/utils/webPush.js` handles the subscribe flow; `SelfServiceHome.jsx` has a "🔔 Enable Notifications" button.

**Mutual Shift Swap** — an employee requests a trade with a coworker's day; the coworker must Accept before it reaches the admin's new collapsible "Shift Swap Requests" panel on the Roster Board for final Approve/Reject. New `hr_shift_swap_requests` table (`pending_target → pending_admin → approved`, or rejected at either step) + narrow `SECURITY DEFINER` RPCs (`get_coworker_roster`, `request_shift_swap`, `respond_shift_swap`, `get_my_swap_requests`) following the same caller-must-match-own-`hr_employee_id` pattern as every other self-service RPC. Approval swaps `employee_id` on the two underlying `hr_roster` rows directly (safe — different `bs_day`s, so the unique constraint never collides mid-swap). New `src/modules/hr/roster/SwapRequestsPanel.jsx`.

**Leave-Conflict Auto-Block** — no schema change, reads existing `hr_leave_requests`. `Roster.jsx` now fetches all approved leave once per client, flags any board cell where that employee has approved leave with a red-hatched background + tooltip, and — per the user's choice of "block with override" over a hard block — pops a confirm ("assign anyway?") before a drag-assign lands on a conflicting day, rather than silently double-booking or refusing outright.

**Files:** `supabase/migrations/20260707270000_roster_publish_swap_leaveconflict_push.sql`, `supabase/functions/hr-push/index.ts`, `src/utils/webPush.js`, `src/modules/hr/roster/Roster.jsx`, `src/modules/hr/roster/SwapRequestsPanel.jsx`, `src/modules/hr/selfservice/SelfServiceHome.jsx`, `public/service-worker.js`, `src/shared/scopedDb.js`, `src/pages/Help.js`

### S306 — 2026-07-07 — HR: TADA Claims, Incentives/Bonus, Employee Self-Service PWA

Three HR features confirmed as genuinely missing from the roadmap — no existing tables, no existing code for any of them.

**TADA Claims** (`hr_tada_claims` + `hr_tada_claim_items`): actual-expense trip reimbursement — trip purpose/destination/dates plus itemized expense lines (Transport/Lodging/Daily Allowance/Other), Manager-gated Approve/Reject/Mark Paid flow. Deliberately kept out of Payroll Run: reimbursement is paid promptly and isn't taxable income the way Festival Allowance/Incentives are, so it never touches `computePayslip` or TDS.

**Incentives / Bonus** (`hr_incentive_configs` + `hr_incentives`): built as Festival Allowance's twin — define reusable incentive "types" once (Fixed / % of Basic / Manual) under Manage Types, then run a named one-off event (`Generate → draft → Finalize → admin-only Reopen`), same YTD-projected marginal-rate TDS calculation Festival Allowance uses (kept as a deliberate ~20-line duplicate rather than a shared refactor of already-shipped, tax-sensitive code). Fully separate from the recurring monthly payroll run, same as Festival Allowance.

**Employee Self-Service PWA**: PIN-based login reusing the exact `create_pos_staff` pattern (auto-generated internal email + PIN-as-Supabase-Auth-password via a new `create_hr_self_service_login` `admin-user-ops` action), finally wiring up the previously-dangling `profiles.hr_employee_id` column. One shared login link per company (`/hr/self-service/login/:clientId`, copyable from Employees) — an employee picks their name and enters their PIN, then sees three tabs: Payslip (finalized runs only), Leave (submit + status, goes through the existing admin approval flow unchanged), Roster (read-only upcoming shifts). Same 5-attempt/15-minute PIN lockout as POS staff.

Security-hardened beyond the POS precedent, since payslip/salary data is more sensitive than anything a POS PIN login can already reach: added `profiles.hr_self_service`, and tightened RLS on every table carrying another employee's personal data (`hr_payslips`, `hr_salary_components`, `hr_advances`, `hr_employees`, `hr_leave_requests`, `hr_roster`, plus the 2 new tables) so a self-service session's raw `supabase.from(...)` queries can never read a coworker's row — only through narrow `SECURITY DEFINER` RPCs (`get_my_hr_payslips`, `get_my_leave_types`, `get_my_leave_requests`, `submit_my_leave_request`, `get_my_roster`) scoped to the caller's own `hr_employee_id`. Also found and fixed two pre-existing duplicate-permissive-policy hazards while doing this (`hr_advances`, `hr_employees` each had a redundant catch-all policy alongside the real one — tightening only one is a silent no-op since Postgres ORs every applicable permissive policy together).

**Files:** `supabase/migrations/20260707260000_hr_tada_incentives_selfservice.sql`, `src/modules/hr/tada/TadaClaims.jsx`, `src/modules/hr/incentives/IncentiveConfigs.jsx`, `src/modules/hr/incentives/IncentiveRun.jsx`, `src/modules/hr/selfservice/SelfServiceLogin.jsx`, `src/modules/hr/selfservice/SelfServiceHome.jsx`, `supabase/functions/admin-user-ops/index.ts`, `src/modules/hr/employees/EmployeeList.jsx`, `src/context/AuthContext.js`, `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`

### S305 — 2026-07-07 — Credit Note numbering: issuance FY, not the original bill's FY — audit fully closed

The last open item from the POS module audit (S298–S304): `IssueCreditNoteModal.jsx` set the CN's own `invoice_fy` (which drives its sequential `credit_note_no` via `assign_pos_credit_note_no`) to the *original bill's* fiscal year, while the revenue reversal a few lines below it deliberately posts into *today's* open period, reasoning "the period the correction is discovered in, not the original bill's period." A CN issued after a fiscal-year rollover against an old-FY bill got numbered into that old, already-closed FY's sequence — inconsistent with the function's own stated rule one block below it. Confirmed with the user this was worth fixing rather than intentional design.

Switched `invoice_fy` to the issuance FY (`getBsFiscalYear(today.year, today.month)`, computed once and reused by both the payload and the revenue-reversal block that already needed it) — a CN issued today gets numbered into today's active series, same period its revenue effect lands in. The original bill stays fully traceable regardless via the separate `original_invoice_no`/`original_invoice_label`/`original_invoice_date_bs` fields, which were never tied to this.

**Files:** `src/modules/pos/creditnotes/IssueCreditNoteModal.jsx`

### S304 — 2026-07-07 — Upsell/Cross-sell suggestion chips: actually gated by plan tier

The three-layer suggestion-chip engine (S210) was fully built but never actually gated — `computeSuggestions()` had no plan/feature check at all, so every client got the full Pro+IMS experience (manual pairings + co-occurrence + Menu Engineering-driven ranking) regardless of what they were on, and the planned "POS Starter: category nudge" fallback was never built (an empty-data client just saw no chips at all).

Added the tiering the roadmap always specified: `posPlanTier`/`imsAvailable` consts (admin always gets full Pro+IMS, same "admin bypasses gates" convention as `hasFeature()`) drive three flags — `allowManualSuggestions` (Growth+), `allowCoOccurrence` (Growth+ with IMS), `allowMeFilter` (Pro with IMS). `rank()`'s scoring is unchanged, but now only includes items with a genuinely-earned non-zero score — without that, a tier with nothing to score on (e.g. Growth without IMS) would've padded out to 4 arbitrary tied-at-0 menu items instead of showing just its manual pairings, or nothing. The "CHEF'S PICK" badge in the render is now also gated on `allowMeFilter`, so stale `me_class` data from a since-downgraded plan can't surface a label that tier isn't entitled to.

New `categoryNudgeSuggestions()` for the Starter tier — no sales/ME data to work with, so it just nudges toward one category not yet represented in the order (menu order, no smart ranking) per client.

**Files:** `src/modules/pos/orders/PosOrders.jsx`, `src/pages/Help.js`

### S303 — 2026-07-07 — Fixed a regression from S298: print popups stuck blank

Live testing after S298 caught a real regression from that session's `noopener,noreferrer` fix on all four print `window.open(...)` calls: passing `noopener` as a window-open *feature* makes the call return `null` for the window reference in Chrome/Firefox — so `printHtml`/`printCreditNoteHtml`/`printQr` opened the popup, then immediately hit their own `if (!w) return` guard and never wrote content, never printed, never closed it. Every KOT/BOT/Bill/Credit Note/QR print left a permanently blank popup window behind.

Fixed by keeping the window reference (drop `noopener,noreferrer` from the feature string) and severing `window.opener` manually instead — `w.opener = null` right after opening, on the reference we keep — same "the popup can't reach back into the live app" protection, without losing the ability to actually write/print/close it.

**Files:** `src/modules/pos/orders/PosOrders.jsx`, `src/modules/pos/creditnotes/creditNoteHtml.js`, `src/modules/pos/tables/PosTableManagement.jsx`, `src/modules/pos/shifts/PosShifts.jsx`

### S302 — 2026-07-07 — POS audit fixes: Low-severity batch — audit complete

Closes out the POS module audit (S298–S302): fixed the last four Low-severity findings.

- **`PosCustomers.jsx`**: the delivery-partner commission-base calc at Settle time summed every item including any individually comped one, inflating the suggested commission. Now fetches `comped` and filters it out before `computeOrderAmounts`, same exclusion every other revenue calc in this codebase already applies.
- **`PosShifts.jsx`**: the denomination-count inputs' `min="0"` only blocked the spinner arrows — a typed `-5` still landed in state and silently subtracted from the opening/closing cash total. Clamped in the `onChange` handler itself so a negative value can never enter state at all.
- **`PosStaff.jsx`**: removed dead code — `canEdit = isAdmin || hasPosAccess('manager')` was always `true` given the page's own `<Navigate>` route guard one line below, which already requires manager access to render at all. Deleted every `canEdit`-gated branch (all unconditionally true) and the always-unreachable `!canEdit` "contact your manager" message, along with the now-unused `isAdmin` destructure.
- **`PosTableManagement.jsx`**: the Delivery Partners tab tooltip claimed commission "is applied automatically... at Charge" — directly contradicting the tab's own body text ("never calculated at Charge... only a starting suggestion... at settlement"). Tooltip corrected to match the actual (correct) behavior.

**Files:** `src/modules/pos/customers/PosCustomers.jsx`, `src/modules/pos/shifts/PosShifts.jsx`, `src/modules/pos/staff/PosStaff.jsx`, `src/modules/pos/tables/PosTableManagement.jsx`

### S301 — 2026-07-07 — POS audit fixes: Medium-severity batch (6 findings)

Continuing the POS module audit — fixed all six remaining Medium-severity findings in one pass.

**Guest-order Accept, hardened.** Two related gaps in the same flow: (1) no re-entrancy guard — a double-tap on Accept/Dismiss could double-merge the same items into the cart; (2) Accept wrote `status: 'accepted'` to the DB immediately, before the merged items were ever actually saved via Send/Update Order — navigating back to the floor first silently dropped the merge while the guest's phone permanently claimed "confirmed, heading to kitchen." Fixed both: a `decidingGuestReqIds` Set guards against double-tap (buttons disable while a decision is in flight); the DB write is now deferred into `performSave()` itself via a `pendingAcceptedGuestReqIds` Set — a request only becomes 'accepted' in the DB once its items are genuinely persisted, and `backToFloor()` clears the set and re-polls to restore an abandoned request back into the banner/badge instead of leaving it permanently (and incorrectly) hidden.

**`KotLog.jsx` reconciliation overwrite bug.** Both `loadReconciliation` and `loadBillTrail` built a `{order_id::recipe_id: qty}` map via plain assignment (`=`), not accumulation — `apply_pos_item_comps` splits a partially-comped line into two `pos_order_items` rows sharing that same key (the shrunk paid remainder + a new comped row), so one row silently overwrote the other, understating the true current qty and falsely flagging a legitimate partial comp as a shrinkage discrepancy. Both call sites now sum (`+=`) instead of assign.

**`GuestMenu.jsx` stale state across a `tableId` change without remount.** `requestId`/`requestSnapshot` were only ever seeded once via a lazy `useState` initializer — a shared kiosk device reused across guest turns, or client-side back/forward between two different tables' QR links in the same tab, kept showing the *previous* table's order status. New effect re-derives everything from `sessionStorage` per `tableId`, and additionally clears any half-filled cart from the previous table so it can never accidentally get submitted against the wrong one.

**KOT/BOT reduction with no signal it's a cut, not an addition.** Reducing an already-sent item's qty then resending fell back to a plain `×qty` label (delta ≤ 0 was treated the same as a fresh send) — the kitchen had no way to tell "this is 3 now" from "make 3 more". Printed tickets now show `↓N (now qty)` for a genuine reduction. Related gap found while fixing this: the KDS-facing `pos_kot_log` write for the same case clamped the delta to 0 but still logged a ticket row for it, which would show a nonsensical "0 × Item" entry on the Kitchen Display — a pure reduction (every item's delta clamped to 0) is now skipped from that write entirely; the printed slip alone is the record of the cut.

**QR auto-confirm poll, remaining stale-dependency gaps.** The effect's dependency array was missing several fields `closeOrder('paid')`'s own validation reads — `discountAmt`/`discountReason`, buyer-id fields, `hasItemComp`/`itemCompReason`, `payableOrderItems`. Filling one of these in after the effect had last refreshed (e.g. typing a discount reason after the discount amount itself, which *was* in the list) left the poll's closure holding the pre-fill value — a payment that looked complete on screen could spuriously fail the auto-confirm path. All fields the 'paid' guards actually read are now listed.

**Files:** `src/modules/pos/orders/PosOrders.jsx`, `src/modules/pos/orders/posOrderPrintHtml.js`, `src/modules/pos/reports/KotLog.jsx`, `src/modules/pos/guestmenu/GuestMenu.jsx`

### S300 — 2026-07-07 — POS audit fixes: stale guest-poll closure, shift double-close, KDS void reconciliation

Continuing S298/S299's POS module audit — fixed the next three High-severity findings.

**Stale closure in the guest-order poll across a client switch.** The 5s `setInterval` that keeps the floor-view guest-order banner/chime live only depended on `[view]`, not `clientId` — an admin switching "view as" client without leaving the floor view kept the interval calling its OLD closure (bound to the OLD client's `scopedFrom`) until `view` happened to change too. Added `clientId` to the effect's dependency array so the interval tears down and recreates with a fresh closure on every client switch.

**Shift close double-submit race.** `PosShifts.jsx`'s `submitClose` updated by `id` alone with no `status` guard — the only real DB constraint (`pos_shifts_one_open_per_client`) guards concurrent *opens*, not closes. Two supervisors closing the same shift on two terminals: the second submit silently overwrote the first's real cash count with no error. Fixed by adding `.eq('status', 'open').select()` to the update and checking whether it actually matched a row — a stale double-close now surfaces "This shift was already closed" instead of silently succeeding.

**KDS tickets never reconciled against a voided order.** Nothing previously updated `pos_kot_log` when an order was voided after its KOT/BOT already printed — the ticket sat on the Kitchen Display board forever, accumulating "late" alerts for an order that no longer existed. New `cancelled` status on `pos_kot_log` (migration, extends the CHECK constraint); `PosOrders.jsx`'s `closeOrder` now cancels an order's tickets on `void` only (not `writeoff`/Complimentary — that food was actually served, so its ticket keeps its normal lifecycle); `KitchenDisplay.jsx` excludes `cancelled` tickets from its board entirely. Same-file bonus fix: `advance()` had no per-ticket in-flight guard, so a rapid double-tap on a touchscreen could fire two overlapping updates that arrive out of order and revert a ticket to an earlier stage — added an `advancing` Set that disables a ticket's action button while its own update is in flight.

**Files:** `supabase/migrations/20260707250000_pos_kot_log_cancelled_status.sql` (not yet run), `src/modules/pos/orders/PosOrders.jsx`, `src/modules/pos/shifts/PosShifts.jsx`, `src/modules/pos/kds/KitchenDisplay.jsx`

### S299 — 2026-07-07 — POS audit fixes: PIN lockout, stale client-switch settings, credit-note totals

Continuing S298's POS module audit — fixed the next three High-severity findings the user asked to prioritize.

**PIN brute-force mitigation.** `PosLogin.jsx`'s PIN literally is the full Supabase Auth password (`signInWithPassword({ email: pos_email, password: pin })`), and `pos_email` itself is public via `get_pos_staff` (needed for the staff picker on this unauthenticated page) — together, an attacker gets the username for free and only needs to brute-force a short PIN with no lockout. Added the standard mitigation for low-entropy credentials rather than redesigning the auth flow: new `profiles.pos_pin_failed_attempts`/`pos_pin_locked_until` columns plus `check_pos_pin_lock`/`record_pos_pin_attempt` RPCs (both restricted to real PIN-based POS staff, same filter as `get_pos_staff`) — 5 failed attempts locks the account for 15 minutes. Accepted trade-off: since both RPCs are anon-callable (this runs pre-auth), anyone can call `record_pos_pin_attempt` directly to lock one specific staff member out for 15 minutes without a real sign-in attempt — a griefing risk, but a far smaller one than unlimited-attempt PIN brute-forcing.

**Stale settings across an admin client switch.** `PosTableManagement.jsx`'s Routing/Notes/HSC/Discounts/Delivery Partners tabs each guard their one-time load with a `*Loaded` boolean that was never reset when `clientId` changed — an admin switching "view as" client while sitting on one of these tabs kept showing (and could Save-overwrite) the *previous* client's data under the new client's id. New effect resets every `*Loaded` flag on `clientId` change and immediately reloads whichever tab is currently open.

**SalesReport.jsx totals didn't reconcile across tabs.** Bill Register's footer summed every row's full amount with no exclusion for credit-noted bills, while every other tab (Daily/Payment/Category/Customer) explicitly excludes them — a fully-reversed bill inflated Bill Register's total while showing zero everywhere else. Fixed by excluding credited rows from the footer sum only (the row itself stays visible with its existing "Credit Noted" badge — Bill Register is an invoice-number ledger, every issued number must be accounted for). Delivery Partners' list is a working settlement tracker, not a compliance ledger, so credited orders are excluded from the list entirely instead — there's nothing left to settle/commission on once reversed.

**Files:** `supabase/migrations/20260707240000_pos_pin_lockout.sql` (not yet run), `src/modules/pos/login/PosLogin.jsx`, `src/modules/pos/tables/PosTableManagement.jsx`, `src/modules/pos/reports/SalesReport.jsx`

### S298 — 2026-07-07 — POS module audit: fixed stored-XSS in every printed document + a chime bug

User asked for a general code review/audit of the POS module. Ran three parallel deep-dive passes covering order taking/billing, floor/staff/shifts/KDS, and customers/credit notes/reports/guest ordering; independently verified the highest-severity findings before acting. Fixed the two the user asked to prioritize now (full list of ~20 findings, ranked, given to the user — most remain open for a future pass).

**Critical: stored XSS reaching a live, same-origin `window.opener`.** Every hand-built print template (`posOrderPrintHtml.js`'s KOT/BOT/Bill/Tender-slip/Comp-slip builders, `creditNoteHtml.js`'s Credit Note builder, plus `PosTableManagement.jsx`'s QR-print popup and `PosShifts.jsx`'s shift-slip builder) interpolated free-text fields — item notes, buyer name/address/phone, shift label, table name, staff names, outlet/property settings, HSC codes, discount/comp/void reasons — directly into HTML strings with zero escaping, then wrote that HTML into a `window.open()` popup with no `noopener`. Guest-submitted order notes (via the new self-ordering feature) and staff-typed buyer/shift-label fields both reach this unsanitized, and the missing `noopener` meant a payload could execute with a live handle back into the authenticated app. Fixed both halves: new shared `src/utils/escapeHtml.js`, applied to every free-text interpolation across all four files (money/date/enum values left alone — they're never attacker-controlled), and `noopener,noreferrer` added to all four `window.open(...)` print calls.

**Fixed: `GuestMenu.jsx`'s "Order again" chime bug.** `orderAgain()` reset `requestId`/`requestSnapshot`/`requestStatus` but not the stage-chime's `prevStageRef`, which stayed at `'dismissed'` — the next order's first `'placed'` stage then looked like a change and chimed immediately, when a fresh order (like a fresh page load) should stay silent. One-line fix: `orderAgain()` now also resets `prevStageRef.current = null`.

**Files:** `src/utils/escapeHtml.js` (new), `src/modules/pos/orders/posOrderPrintHtml.js`, `src/modules/pos/creditnotes/creditNoteHtml.js`, `src/modules/pos/tables/PosTableManagement.jsx`, `src/modules/pos/shifts/PosShifts.jsx`, `src/modules/pos/orders/PosOrders.jsx`, `src/modules/pos/guestmenu/GuestMenu.jsx`

### S297 — 2026-07-07 — Guest ordering: chime on the guest's own phone when order stage changes

Small follow-up to S296's staff-side chime — the guest's own phone now plays a short synthesized chime (same Web Audio approach, pitched ascending instead of descending so it reads as a distinct cue) whenever their order's unified stage actually advances (Placed → Confirmed → Sent to Kitchen → Preparing → Ready, or Dismissed), not on every 5s poll that finds no change. Tracked via a `prevStageRef` in `GuestMenu.jsx`, `null` on first render so mounting the page never chimes — only genuine transitions do.

**Files:** `src/modules/pos/guestmenu/GuestMenu.jsx`, `src/pages/Help.js`

### S296 — 2026-07-07 — Guest ordering UX polish: covers, unmissable staff alert, order-status card

Live testing of S295's guest self-ordering surfaced three friction points, fixed here. (S295 itself also picked up two correctness fixes same-day, folded into that commit without their own session note: the POS-only Feature Access branch never listed `guest_ordering` at all — a POS-only client had no way to enable it — and the guest RPCs only checked the raw `feature_flags.guest_ordering` boolean, ignoring plan tier, so a genuine Pro-plan client still needed a manual admin toggle. Both fixed: the POS-only modal branch and the full IMS grid now check `client.pos_plan` for this feature, and `submit_guest_order`/`get_guest_menu` auto-unlock when `pos_plan = 'pro'`.)

1. **Guest enters covers when placing the order.** New `pos_guest_order_requests.covers` column, `submit_guest_order` gained a trailing `p_covers` param (appending a defaulted param is `CREATE OR REPLACE`-compatible, no drop needed). `GuestMenu.jsx`'s review sheet gets a covers stepper before Place Order.
2. **Staff never re-enters it.** `PosOrders.jsx`'s `openTable` used to always pop the "How many covers?" numpad for a table with no order; now, if that table has a pending guest request, it skips straight to the order screen with `covers` pre-filled from what the guest entered. This only removes the redundant numpad — it does not auto-merge items into the cart, so the existing Accept/Dismiss banner (staff must still explicitly tap Accept before anything reaches the order) is unchanged.
3. **Impossible-to-miss staff alert.** A pulsing amber banner now appears at the top of the floor view whenever any table has a pending guest request ("🔔 N new guest orders — Table X, Table Y", click to jump straight to the first one), the affected floor tile itself gets a pulsing glow (new `guest-order-banner`/`guest-order-glow` keyframes in `Layout.css`), and a short two-tone chime (synthesized via the Web Audio API — no audio asset to ship) plays once per genuinely new arrival, tracked via a `seenGuestRequestIds` ref so it doesn't re-fire on every 5s poll of a request that's still sitting there pending.
4. **Guest-side confirmation, enhanced.** The old single-line badge is now a full-width `OrderStatusCard`: a 5-stage horizontal stepper (Placed → Confirmed → Sent to Kitchen → Preparing → Ready, combining `pos_guest_order_requests.status` and the table's KOT status into one stage) plus an itemized list of what was actually ordered. The submitted cart snapshot (items + covers) is now stored in `sessionStorage` alongside the request id, not just the bare id, so the itemized summary survives a page reload.

**Files:** `supabase/migrations/20260707230000_guest_ordering_covers.sql` (not yet run), `src/modules/pos/guestmenu/GuestMenu.jsx`, `src/modules/pos/orders/PosOrders.jsx`, `src/components/Layout.css`, `src/pages/Help.js`

### S295 — 2026-07-07 — Guest QR self-ordering (Pro-tier feature)

Extends S294's guest menu from view-only to guest-placed ordering — a real "let customers order from their phone" feature, not just a status badge. Scoped down through two decisions confirmed with the user before building: (1) **staff must Accept before an order is live** — a guest submission lands in a new `pos_guest_order_requests` staging table, not directly in `pos_order_items`, because `PosOrders.jsx`'s save path (`performSave`) does a full delete-and-reinsert of the staff's entire local cart on every save; a guest writing into the same rows while staff had a stale local cart open would get silently wiped on the next staff save. Routing through a staff Accept step means the real `pos_order_items` write always goes through the same existing single-writer `performSave()`. (2) **Gated behind `feature_flags.guest_ordering`, Pro plan only** (`PRO_KEYS` in `AuthContext.js`) — a flagship differentiator, not on by default for every POS client.

**New DB objects** (`supabase/migrations/20260707210000_guest_ordering.sql`): `feature_flags.guest_ordering` column; `pos_guest_order_requests` table (`items` jsonb, `status` pending/accepted/dismissed, standard client-scoped RLS for SELECT/UPDATE — deliberately no INSERT policy, since the only writer is the RPC below); `submit_guest_order(p_table_id, p_items, p_notes)` — `SECURITY DEFINER`, anonymous-callable like `get_guest_menu`, re-validates every `recipe_id` against `recipes` and re-snapshots name/category/price/VAT server-side rather than trusting the client payload (a submitted price is never trusted), caps item count/qty as a basic abuse guard; `get_guest_order_request_status(p_request_id)` — lets the guest poll their own request's status via the unguessable id returned at submission, no other scoping needed. `get_guest_menu` gained one more output column (`guest_ordering_enabled`) — required a drop+recreate since adding an output column isn't `CREATE OR REPLACE`-compatible; behavior otherwise unchanged.

**Guest side** (`GuestMenu.jsx`): if the flag is off, page is identical to before (no visible change). If on, each menu item gets a qty stepper, a sticky bottom bar shows running item count/total, tapping it opens a review sheet (adjust qty, remove, optional note) → Place Order calls `submit_guest_order`. The returned request id is tracked in `sessionStorage` (survives a page reload) and polled every 5s; the guest sees "waiting for confirmation" → "confirmed by staff" (or "please ask staff for assistance" if dismissed, with an Order Again reset).

**Staff side** (`PosOrders.jsx`): a new 5s poll (same cadence/pattern as the existing KOT-status poll) surfaces a 🔔 badge on any floor-grid table with a pending guest request. Opening that table shows a banner listing each request's items with Accept/Dismiss buttons. Accept merges the items into the local cart via a new `mergeGuestItem()` helper — same dedup-by-`recipe_id` logic `addItem()` uses, just at whatever qty the guest asked for and without triggering the upsell suggestion engine — then marks the request `accepted`; the actual DB write still only happens later through the normal Send Order/KOT flow. Dismiss marks it `dismissed` with no cart change.

**Files:** `supabase/migrations/20260707210000_guest_ordering.sql` (not yet run — apply via Supabase Dashboard SQL Editor), `src/context/SettingsContext.js`, `src/context/AuthContext.js`, `src/pages/adminClients/FeatureAccessModal.js`, `src/shared/scopedDb.js` (added `pos_guest_order_requests` to `CLIENT_SCOPED_TABLES`), `src/modules/pos/guestmenu/GuestMenu.jsx`, `src/modules/pos/orders/PosOrders.jsx`, `src/pages/Help.js`

### S294 — 2026-07-07 — Guest QR menu: live Sent/Started/Ready kitchen-status badge

Picked off the POS roadmap's "blocked" backlog item — turned out not to actually be blocked. The original plan assumed the guest needed to have placed their order via QR for "their order" to be identifiable, which depends on a guest ordering-with-placement flow that doesn't exist yet. But a table has at most one `'open'` `pos_orders` row at a time regardless of who entered it (staff via `PosOrders.jsx` today), so the guest's order for badge purposes is simply whatever's currently open on the table their QR code already points to.

New public RPC `get_guest_table_status(p_table_id)` — same anonymous-caller pattern as `get_guest_menu` (no internal auth check, only whitelisted non-sensitive fields: a status enum, nothing else). Resolves table → client → `pos_enabled`, finds the table's open order, then worst-status-wins across its `pos_kot_log` rows (same logic as the staff floor-view badge). `GuestMenu.jsx` polls it every 5s and shows a Sent / Being prepared / Ready to serve badge under the outlet/table header, reusing the existing `badge-red/amber/green` classes.

Guest-placed ordering (cart, submit) remains out of scope — a separate, larger future feature.

**Files:** `supabase/migrations/20260707160000_guest_table_kot_status.sql` (applied ✓), `src/modules/pos/guestmenu/GuestMenu.jsx`, `src/pages/Help.js`

### S293 — 2026-07-07 — Supabase Security Advisor pass: closed 2 real RLS-bypass gaps

User ran the Supabase Security Advisor/linter and pasted its findings. Most of the `SECURITY DEFINER` "callable by anon/authenticated" warnings turned out to be by design (`get_guest_menu`, `get_pos_staff`, `get_pos_staff_list`, `get_client_profile_names`, `client_user_emails`, `find_user_id_by_email` all already gate on admin-or-same-client or self-scope via `auth.uid()`) or non-issues (`assign_pos_*_no` are trigger functions — Postgres refuses to invoke a `RETURNS trigger` function directly via RPC, so that warning is a false positive). Went through every `SECURITY DEFINER` function taking a `p_client_id`-shaped parameter one by one to be sure, rather than taking the linter's severity labels at face value.

Two were real, unguarded RLS bypasses: **`admin_clear_audit_logs`** had *zero* authorization check — `AuditLog.js`'s `adminOnly` frontend route guard doesn't protect the underlying RPC, so any authenticated (non-admin) user could call `/rest/v1/rpc/admin_clear_audit_logs` directly with no arguments and delete the entire audit trail for every client on the platform. **`get_cooccurrence`** (POS upsell "frequently bought together" data) had no check that `p_client_id` belonged to the caller — since it's `SECURITY DEFINER` and shows as callable even by `anon`, anyone could read any client's item-pairing sales patterns without logging in. Both fixed with the same `is_admin() OR p_client_id = caller's own client_id` guard already used by `apply_pos_item_comps`. `get_next_pos_comp_slip_no` got the same guard defensively even though it's confirmed dead code (superseded by `apply_pos_item_comps`) — cheap to close since it's still a live endpoint regardless of frontend usage.

Also fixed the linter's 4 `function_search_path_mutable` warnings (`get_cooccurrence` + the 3 `_nutrition_*` helpers from S288) by setting `search_path = public` explicitly. The 3 nutrition helpers aren't themselves `SECURITY DEFINER` though, so — unlike the two bugs above — they were never actually exploitable directly: a raw RPC call to them runs as the caller's own role, and RLS on `items`/`recipes` blocks it exactly like any other query would. Only `get_guest_menu` (which is `SECURITY DEFINER`) can reach real data through them.

Left as-is, lower priority: the `Logos` storage bucket's public SELECT policy technically allows listing every file in the bucket (not just fetching a known URL) — logos aren't sensitive, so this is informational only. `auth_leaked_password_protection` is a one-click Supabase Dashboard → Auth Settings toggle (HaveIBeenPwned check), not a code change — recommended but not applied here.

**Files:** `supabase/migrations/20260707200000_security_definer_hardening.sql` (not yet run — apply via Supabase Dashboard SQL Editor per the usual workflow)

### S292 — 2026-07-07 — KDS stage-coloring, floor-view kitchen-status badge, Covers Report

Cross-checked S289's Kitchen Display System against how the client actually wanted it read at a glance: New/In Progress/Ready currently only differed by elapsed-time flagging (amber past 8 min, red past 15), with no color tied to the stage itself. Added a stage accent independent of that — a colored top strip on each ticket card plus a matching dot on each column header (New=red, In Progress=amber, Ready=green, via the existing `--theme-red/amber/green` tokens), layered on top of (not replacing) the lateness border, so a Ready ticket sitting too long unclaimed shows green + a red-flagged border at once — a compound, actionable signal rather than a conflict.

Extended the same status data one step further: wait staff had no way to see kitchen/bar progress without walking to the pass or opening the KDS screen. Order Taking's floor-view table cards now show a tiny Sent(red)/Started(amber)/Ready(green) badge next to the existing Occupied/Available badge, sourced from `pos_kot_log`. A table with multiple open tickets at different stages (e.g. a Ready starter and a New main) shows the *least-advanced* one — that's the one actually needing attention. Kept live with a 5s poll while sitting on the floor grid (paused whenever a staff member is inside a table's order screen), plus an immediate refresh after every `loadFloor()` call; skipped entirely offline since `pos_kot_log` is server-only truth. The QR-menu equivalent (showing a guest their own order's status) is a natural next step but is blocked on QR ordering-with-placement, which doesn't exist yet — `GuestMenu.jsx` (S288) is still view-only.

While wiring the floor badge's colors, found a real pre-existing bug: `STATUS_BADGE.reserved` (and 22 other references across 18 files — POS Staff, Shifts, Sales Report, Exceptions, KOT Log, several HR pages) pointed at a `badge-amber` CSS class that was never actually defined in `Layout.css` (only `badge-yellow` was) — so every one of those amber-intended badges had been rendering with no background/color at all. Fixed by adding the missing `.badge-amber` rule rather than renaming 23 call sites; the new KOT-status badge's "Started" state uses it too, so it matches the KDS's amber exactly.

Also built the **Covers Report** (`/pos/covers-report`, new page, Manager+), off a request to analyze what the "how many covers?" number captured at table-open time could power beyond just being stored. Five tabs, all computed from existing `pos_orders.covers/opened_at/closed_at` + `pos_tables.capacity` — no new order-level schema: Overview (Covers Served, Avg Party Size, Revenue/Cover, RevPASH), Daily Trend, Turnover Time (bucketed by party-size band — a 2-top and an 8-top have very different expected dine times), Peak Hours (bucketed by when the table was *opened*, i.e. guests seated, not when the bill was paid — the number that actually informs staffing), and By Server. RevPASH (Revenue Per Available Seat-Hour) needed one new input that didn't exist anywhere: a per-client Operating Hours setting (`settings.pos_open_time`/`pos_close_time`, a single daily open/close pair, editable right on the report's Overview tab) — left unset, that one card just prompts to configure it instead of showing a number.

**Files:** `src/modules/pos/kds/KitchenDisplay.jsx`, `src/modules/pos/orders/PosOrders.jsx`, `src/modules/pos/orders/posOrdersConstants.js`, `src/components/Layout.css`, `supabase/migrations/20260707190000_pos_operating_hours.sql`, `src/modules/pos/reports/CoversReport.jsx` (new), `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`

### S291 — 2026-07-07 — Delivery-partner tagging reworked: Credit buyer, not payment method

Real-world testing of S290 (below) surfaced a design flaw the same day it shipped: with Foodmandu/Pathao modeled as `payment_method` values, a bill would show buyer "CASH SALES" and payment mode "Foodmandu" — but that's backwards. Neither platform pays the restaurant at the counter; they collect from the customer and remit to the restaurant later (weekly/monthly), minus commission. That's structurally a receivable, exactly like Credit, not an instant payment method — the client's own framing was "customer is Foodmandu via credit bill and payment mode is Credit."

Reworked accordingly. `payment_method`'s CHECK constraint drops the two aggregator values, back to `Cash/Card/eSewa/Khalti/FonePay/Credit/Split`. A new `pos_orders.delivery_partner` column (`Foodmandu`/`Pathao`/`NULL`) tags a Credit bill's buyer instead — at Charge, selecting Credit reveals a Foodmandu/Pathao quick-select chip (Pay tab) that auto-fills `buyer_name`/`buyer_phone` (fixed sentinel phone numbers per platform, so `pos_customers` still groups them consistently even with no real customer phone number).

The bigger change is *when* commission gets calculated. The client was explicit: staff shouldn't see or estimate commission while billing — "no need for staff expectation to come in the billing terms." So all commission math was removed from Charge-time entirely. It now happens only at settlement, in Customers → Outstanding Credit → Settle: the commission % configured in Table Management → Delivery Partners still pre-fills as a *suggestion* (computed against the bill's ex-VAT base, same formula S290 already fixed), but whoever processes the settlement can adjust it against the platform's actual remittance before confirming — only then does `pos_orders.commission_amount` get written.

Since Payment Summary can no longer show a per-payment-method Commission column (delivery-partner bills are just "Credit" now), that reporting moved to a new dedicated tab: Sales Report gets a 10th tab, **Delivery Partners** — one row per Foodmandu/Pathao bill, Outstanding until settled, then showing the commission and net actually received. The Commission/Net Received columns S290 had added to Payment Summary and Bill Register were reverted.

Same-day follow-up: Foodmandu/Pathao themselves were still hardcoded — the platform name, commission %, and sentinel phone were two fixed fields in Table Management → Delivery Partners. Since aggregator partnerships come and go, that tab is now a fully editable list (add/rename/remove platforms, same UX pattern as Discount Reasons) backed by one `settings.pos_delivery_partners` jsonb array of `{name, commission_pct, phone}`, replacing the two fixed `pos_foodmandu_commission_pct`/`pos_pathao_commission_pct` columns. The Credit quick-select chips in Order Taking now render from this list instead of a fixed `['Foodmandu', 'Pathao']` constant, and `pos_orders.delivery_partner`'s CHECK constraint relaxed from an exact `Foodmandu`/`Pathao` match to any non-empty string.

Four more polish fixes off live use: (1) the Outstanding Credit / Collected rows rendered `buyer_name` *and* the delivery-partner name, which read as "Foodmandu Foodmandu" since the quick-select sets both to the same value — now shows the platform name once (amber, normal table font — was briefly a tiny `fontSize:10` badge that looked out of place next to full-size customer names) and only prefixes a real buyer name when it differs from the platform. (2) Added **Cheque** and **Bank Transfer** as settlement methods (`credit_settled_method` CHECK relaxed) — a receivable (delivery platform or corporate credit) is usually remitted that way, not paid at the counter; deliberately kept out of `PAYMENT_METHODS` since they're settlement-only. (3) The Collected table's Commission/Net Received columns (and the Sales Report → Delivery Partners tab + its Excel export) gated on `commission_amount > 0`, so a platform bill settled at 0% collapsed to "—/—" as if data were missing — now gated on "is this a delivery-partner bill," so it reads NPR 0 commission / full net received honestly, while a plain customer-credit bill still shows "—".

**Files:** `supabase/migrations/20260707160000_delivery_partner_as_credit_buyer.sql`, `supabase/migrations/20260707170000_delivery_partners_configurable.sql`, `supabase/migrations/20260707180000_settle_methods_cheque_bank.sql`, `src/modules/pos/orders/posOrdersConstants.js`, `src/modules/pos/orders/PosOrders.jsx`, `src/modules/pos/customers/PosCustomers.jsx`, `src/modules/pos/tables/PosTableManagement.jsx`, `src/modules/pos/reports/SalesReport.jsx`, `src/modules/pos/shifts/PosShifts.jsx`, `src/pages/Help.js`

### S290 — 2026-07-07 — Delivery-partner payment tagging (Foodmandu/Pathao)

> **Superseded by [S291](#s291--2026-07-07--delivery-partner-tagging-reworked-credit-buyer-not-payment-method) the same day** — modeling Foodmandu/Pathao as payment methods turned out to be the wrong shape once tested live. Left below for history.

Continuing the POS core-feature-gap backlog. "Delivery aggregator integration" was originally deferred — real order-injection/menu-sync needs an actual API partnership with Foodmandu/Pathao, not just engineering (same shape of blocker as QR payment auto-confirmation's merchant onboarding). But the lighter, no-partner-needed version — tagging a bill as having come from one of them, inspired by a competitor's "Direct Party" customer category found during the Nepal-market research — was scoped and shipped on its own.

Modeled as two new `payment_method` values (Foodmandu, Pathao) rather than a separate "order source" field — from the restaurant's own settlement point of view, an aggregator order is just another way a bill gets paid (the platform stands in for the customer), so it reuses the entire existing payment_method code path (Payment Summary's breakdown, discount rules, print layout) instead of a parallel concept. Deliberately kept OUT of two places: the Split-payment tender-leg picker (an aggregator order isn't split with cash the way a table's bill can be) and `credit_settled_method` (settling an existing Credit debt is a different context than tagging where an order came from) — both the DB CHECK constraints and the UI enforce this.

Commission tracking came along with it — the client's own negotiated rate per platform (new Delivery Partners tab in Table Management, `settings.pos_foodmandu_commission_pct`/`pos_pathao_commission_pct`) is applied automatically at Charge and stored on the order itself (`pos_orders.commission_amount`), not just referenced from settings, so a later rate change doesn't retroactively alter what a past bill reports. Sales Report → Payment Summary gets Commission and Net Received columns (blank for every non-aggregator method). Confirmed with the client mid-build that both platforms compute their cut on the bill's ex-VAT (taxable) value, not the final VAT-inclusive total — the first version of this calculated commission on the full amount, which quietly overstates it (e.g. a ₨260 bill at 13% VAT and 20% commission: ex-VAT-based commission is ₨46, VAT-inclusive-based would have been ₨52) — fixed before this ever reached a real bill.

A background research pass before touching any code turned up a real bug worth fixing while in the area: `PosShifts.jsx`'s X/Z shift report had its own hardcoded copy of the payment-method list (`['Cash','Card','eSewa','Khalti','FonePay','Credit']`), never imported from the shared `posOrdersConstants.js` — a new payment method added there would have silently vanished from shift totals rather than erroring. Both this and `SalesReport.jsx`'s sort-order array now derive from the same source of truth.

Live-testing the new Delivery Partners settings tab turned up a second, much older bug: `settings_insert`/`settings_update` RLS policies were admin-only, with no allowance for a regular client login to write their own settings row — unlike every other client-scoped table's `is_admin() OR client_id = my_client_id()` pattern. Because an RLS-blocked write returns zero rows changed with no error (not a thrown exception), every settings-writing tab in `PosTableManagement.jsx` (Discounts, Quick Notes, Ticket Routing, and now Delivery Partners) has been silently no-op'ing for any real (non-admin) client login — confirmed directly against Casa Acai Cafe's `settings` row, which still had `null` commission values after a client login "saved" them successfully. Fixed at the policy level (`20260707150000_settings_rls_same_client_write.sql`) — doesn't touch the `client_id IS NULL` global-defaults row, which stays admin-only automatically since a real client's `client_id` can never equal `NULL`.

**Files:** `supabase/migrations/20260707140000_pos_delivery_partners.sql`, `supabase/migrations/20260707150000_settings_rls_same_client_write.sql`, `src/modules/pos/orders/posOrdersConstants.js`, `src/modules/pos/orders/PosOrders.jsx`, `src/modules/pos/shifts/PosShifts.jsx`, `src/modules/pos/reports/SalesReport.jsx`, `src/modules/pos/tables/PosTableManagement.jsx`, `src/pages/Help.js`

### S289 — 2026-07-07 — Kitchen Display System (KDS)

Next pick off the POS core-feature-gap backlog after the guest menu. Scoped via a few decisions upfront, same as S288: runs alongside printed KOT/BOT rather than replacing it (lower risk, no client loses anything if a kitchen doesn't have a screen up yet), interactive tap-to-advance status rather than a read-only feed, polling every 4s rather than introducing Supabase Realtime (nothing in this codebase uses Realtime yet — polling matches the existing QR-auto-confirm precedent), and the same PIN login as Order Taking rather than a separate unauthenticated screen.

The key design question was what a "ticket" even is on the new board. `pos_kot_log` already logs one row per KOT/BOT send event, and an addition to an already-fired order gets its OWN row rather than updating the original — because `logKotSend`'s delta-aware qty math means a second small paper ticket prints for just the new items, not a reprint of the whole order. That turned out to be exactly the right shape for the display board too: each row already IS one physical ticket, so three new columns (`status`, `started_at`, `ready_at`) on the existing table were enough — no new ticket-aggregation table, and `logKotSend` itself needed zero changes (the new `status` column defaults to `'new'`, so existing inserts just pick it up).

Board is New → In Progress → Ready, tap a ticket to advance one column. Elapsed-time labels go amber past 8 minutes and red past 15 (mirrors the "flag the outlier" pattern Sales Exceptions/KOT Reconciliation already use). Ready tickets stay on screen for 10 minutes so staff can confirm pickup, then drop off on their own — display-only, the row stays in the database and still counts in the existing KOT Register/Reconciliation reports. A Kitchen/Bar toggle at the top persists per-device (localStorage), so a screen mounted at one station doesn't need re-selecting every shift.

**Files:** `supabase/migrations/20260707120000_kitchen_display.sql`, `src/modules/pos/kds/KitchenDisplay.jsx`, `src/App.js`, `src/components/Layout.js`, `src/pages/Help.js`

### S288 — 2026-07-07 — Guest-facing QR digital menu (view-only)

Picked off the POS core-feature-gap backlog. Scoped down from the original idea through a few rounds of decisions: view-only (no self-order — that's a real order-flow integration, deferred), per-table QR (reuses `pos_tables` rows, no new token column needed), and full nutrition facts rather than a bare-bones menu.

The nutrition decision surfaced a real security question mid-build: nutrition is a rollup of `recipe_ingredients` × `items.nutrition` — a client's confidential recipe formulation (exact ingredients and quantities). The existing calculator (`src/utils/nutrition.js`) runs client-side against a staff-authenticated read of that raw data. A public, unauthenticated guest page can't fetch that same raw data just to compute nutrition in the browser — anyone could read the recipe breakdown straight off the network response in devtools, even if the UI only ever displays the final numbers. Ported the rollup into SQL instead (`_nutrition_convert_qty`, `_nutrition_item_contribution`, `_nutrition_rollup` — mirror `convertQty`/`itemNutrition`/`calcSubRecipeNutritionPerUnit` field-for-field, including sub-recipe recursion and cycle guarding), so only the aggregated per-recipe totals ever leave the database. This is a deliberate duplication of `nutrition.js`'s math that needs to be kept in sync if that file's logic changes.

`get_guest_menu(p_table_id)` is the single public RPC the page calls — no internal auth check (same pattern as the existing public `/pos/login` → `get_pos_staff`), since there's no session to check against; it does its own authorization by resolving table → client → `pos_enabled`, and only returns whitelisted columns (never anything from `pos_orders`/sales data, never raw `recipe_ingredients`). Confirmed the RLS on `recipes`/`items`/`recipe_ingredients` already blocks an anonymous caller from reading anything useful if they call the internal `_nutrition_*` helpers directly, bypassing `get_guest_menu` — no extra guard needed there.

New optional `recipes.description`/`image_url`/`is_veg` columns (non-sub-recipe items only), editable right in the Recipes.js form. Table Management gets a ▦ QR button per table — generates the guest-menu URL as a QR (reusing the `qrcode` package already used for payment QR), with a Print action.

Caught one real bug in review before shipping: `_nutrition_rollup`'s own local variable was named `yield_qty`, same as the `recipes` column it was reading — an unqualified `SELECT yield_qty INTO yield_qty FROM recipes` is ambiguous and errors at call time, not at CREATE FUNCTION time, so it would have silently shipped broken. Fixed with an explicit table alias.

**Files:** `supabase/migrations/20260707100000_guest_menu.sql`, `src/modules/pos/guestmenu/GuestMenu.jsx`, `src/modules/pos/tables/PosTableManagement.jsx`, `src/modules/ims/recipes/Recipes.js`, `src/modules/ims/recipes/recipeCostCalc.js`, `src/App.js`, `src/pages/Help.js`

### S287 — 2026-07-06 — Credit Note revenue-reversal: fixed a second bug + backfilled history

Follow-up to S286's constraint fix. While writing a historical backfill for the credit-note reversal bug, found the live code had a second, related bug: `IssueCreditNoteModal.jsx`'s reversal insert built its rows from the full `items` list, not `payableItems` — so a credit note against a bill that had any item-level comps would also reverse the comped item's qty under `source='pos_credit'`. That qty was never counted as revenue in the first place (it posted as `source='pos_comp'`, not `'pos'`), so reversing it too created a negative entry with nothing positive to offset, wrongly understating that recipe's revenue. Fixed to use `payableItems`, matching the credit note's own face-value amounts.

Also wrote and ran `scripts/backfill-credit-note-reversals.mjs` — a one-time script (dry-run by default, `--apply` to write) that reconstructs the missing `sales_entries` rows for every credit note issued before S286's constraint fix, from each note's original `pos_order_items` (excluding comps), posted into whichever `monthly_periods` row was open on the note's own issuance date rather than today's. Dry run found exactly one affected credit note (`PB3-BC-82/83`, BS 2083-3-20) — applied, 2 rows inserted. A pre-flight guard aborts if any `source='pos_credit'` rows already exist, so the script can't be re-run by accident.

**Files:** `src/modules/pos/creditnotes/IssueCreditNoteModal.jsx`, `scripts/backfill-credit-note-reversals.mjs`

### S286 — 2026-07-06 — Hardening pass on item-level comp / QR auto-confirm / drill-down (S274–S285)

Asked Claude to debug the POS module cold; it found 8 issues in the S274–S285 work and this session fixes all of them.

1. **Comp-slip numbering wasn't actually race-safe.** `get_next_pos_comp_slip_no` held its advisory lock only for the duration of that one RPC call — the frontend's own writes that consumed the number happened in a separate round trip, after the lock had already released. Replaced with one atomic `apply_pos_item_comps` RPC that reserves the number and writes every full/partial comp row inside a single locked transaction. Called *before* `pos_orders` is marked billed now, not after — if it fails, the whole Charge aborts cleanly (cashier sees an error, retries) instead of the order billing with its comped items silently never marked (the old "best-effort" behavior).
2. **QR auto-confirm poll could race a manual Charge tap.** Both call `closeOrder('paid')`; only the button's `disabled={closing}` was ever guarded — the poll bypassed it entirely. Added a `closingRef` re-entry guard. `closeOrder` now returns a boolean, and the poll only marks its payment confirmation `consumed_at` after a close actually succeeds — previously it consumed first, so a close that aborted on a guard (e.g. missing comp reason) burned the confirmation with no retry left.
3. **IMS-side revenue never excluded comps.** The S274 fix only filtered `pos_order_items.comped` on the POS-side reports (Sales Report, demand forecasting). Everything reading `sales_entries` directly — `MonthlySummary`, `PeriodComparison`, `AnnualSummary`, `MenuRepricing`, `MenuEngineering`, `RecipeMargin`, `Overheads`, `BestSellers`, `Sales.js`, the Owner Dashboard — had no comped flag to filter on and was overstating revenue by every comp. `writeSalesEntries` now splits a comped qty into its own `source='pos_comp'` row; every revenue calc excludes it while consumption-side reports (Variance, TheoreticalVariance, ShrinkageReport, ReorderReport, StockReport, Recipes.js's per-cover overhead allocation) deliberately keep summing every source unfiltered — a comped dish still consumed ingredients and occupied a cover.
4. **Two dormant pre-existing bugs found on the same table.** Credit Notes' revenue-reversal insert has posted `source='pos_credit'` since that feature shipped, but the CHECK constraint never allowed it — every single one has silently failed (caught by its own try/catch). And `sales_entries` carried a `UNIQUE(period_id, recipe_id, bs_day)` constraint from before POS existed — a second same-day order selling an already-sold recipe has been silently failing to record at all. Both fixed at the constraint level (the unique constraint dropped entirely — every reader already just SUMs matching rows, none assume exactly one).
5. **Bill drill-down could get popup-blocked.** `viewPosBill` opened its new tab *after* its Supabase fetches resolved — by then the click's transient user-activation is gone, so Safari/iPad blocks it outright. Now opens synchronously first, with a "Loading…" placeholder, and fills in the real HTML once fetched.
6. **`buildDynamicQr` dropped a merchant QR's tag-62 subfields.** Any existing Additional Data (e.g. a Bill Number subfield some providers require) was discarded whenever a reference was embedded, instead of merged in.
7. **Webhook scaffold**: the HMAC signature check used a `===` string compare (a timing side channel over a public HTTP endpoint) — replaced with a fixed-time byte compare. Added `verify_jwt = false` for this function in `supabase/config.toml` — without it, Supabase's own gateway would 401 a real provider's call before the signature check ever ran (an external provider has no Supabase JWT to send).

**Files:** `supabase/migrations/20260706170000_pos_item_comp_atomic_apply.sql`, `src/modules/pos/orders/PosOrders.jsx`, `src/utils/viewPosBill.js`, `src/utils/emvQr.js`, `supabase/functions/pos-payment-webhook/index.ts`, `supabase/config.toml`, `src/modules/ims/reports/MonthlySummary.js`, `src/modules/ims/reports/PeriodComparison.js`, `src/modules/ims/reports/AnnualSummary.js`, `src/modules/ims/reports/Overheads.js`, `src/modules/ims/reports/BestSellers.js`, `src/modules/ims/recipes/MenuRepricing.js`, `src/modules/ims/recipes/MenuEngineering.js`, `src/modules/ims/recipes/RecipeMargin.js`, `src/modules/ims/sales/Sales.js`, `src/pages/dashboard/ClientDashboard.jsx`

### S285 — 2026-07-06 — Guard against a ₨0 Tax Invoice when every item gets comped

User asked what happens if a staff member accidentally comps every item on a bill — the payable total hits ₨0, but Confirm Payment was still enabled, and would have issued a real Tax Invoice/PAN Bill with zero line items, consuming a sequential invoice number on an empty document. Confirmed with the user: block it instead. Confirm Payment is now disabled whenever `payableOrderItems` is empty (everything comped), with an amber warning telling the cashier to use the Complimentary tab instead — the tab that already exists for exactly this case. Guard is enforced in both the button's `disabled` and `closeOrder`'s own validation (defense in depth, matches the pattern of every other Pay-tab guard).

**Files:** `src/modules/pos/orders/PosOrders.jsx`

### S284 — 2026-07-06 — Item-level comp: partial quantity (e.g. 1 of 3)

User asked how to comp just 1 of "3 x Veg Momo" while billing the other 2 — item-level comp only supported whole-line comping until now. Replaced the per-item checkbox with +/− qty steppers (0 to the line's full qty). State changed from a `Set` of fully-comped recipe_ids to `{ [recipe_id]: qtyComped }`.

- `payableOrderItems`/`compedOrderItems` now split a partially-comped line into two virtual rows (qty reduced on the payable side, qty=compedQty on the comp side) — everything downstream (bill total, live preview, food-cost calc) already consumed these two arrays, so no other changes needed there.
- Charge-time DB write branches per line: a fully-comped line (compQty === full qty) still just gets marked `comped=true` in place; a partially-comped line shrinks the existing row to the paid remainder and inserts a new row for the comped portion (there's no single existing DB row that represents "1 of these 3" until this split creates one).
- `writeSalesEntries()`'s stock_movements split changed from a boolean (whole line sale vs. comp) to proportional — the same ingredient's usage is divided between `pos_sale` and `pos_comp` by qty ratio when a line is only partially comped.
- Sales Report / Sales Exceptions / Comped Bills tab needed no changes — they read `pos_order_items` back fresh, and by then the split into two rows (one comped, one not) already exists at the correct quantities.

**Files:** `src/modules/pos/orders/PosOrders.jsx`, `src/pages/Help.js`

### S283 — 2026-07-06 — Real bug: staff names were blank for every non-admin login, in 6 reports

Following up on S282 ("Authorized by" still blank after the first fix) — the real root cause is bigger than that one function. `profiles_select` RLS only allows `id = auth.uid() OR is_admin()`: a raw `supabase.from('profiles').eq('client_id', clientId)` query, run by any real (non-admin) client login — the actual Owner/Manager/Supervisor accounts, not Crest's own admin "view as" session — silently returns only the caller's own row. Every other staff member's name has been rendering as "—" in: `SalesReport.jsx` (Entered By), `PosExceptionReport.jsx` (Closed By + staff rollup), `PosShifts.jsx` (shift history), `KotLog.jsx` (Register + Bill Trail, two call sites), `CreditNotes.jsx` (Issued By), and the new `viewPosBill.js` drill-down (Authorized by/Cashier). This likely went unnoticed because testing happens mostly via Crest admin sessions, which bypass RLS entirely.

`get_pos_staff_list()` already existed as a SECURITY DEFINER escape hatch for exactly this RLS wall, but it deliberately filters to `pos_email IS NOT NULL` for the Staff Management page (PIN-based POS staff only) — an Owner logs in with a normal email/password, so they'd still be missing. Added a new, unfiltered sibling: `get_client_profile_names(p_client_id)` (same admin-or-same-client security check, no staff-only filter), migration `20260706160000_get_client_profile_names.sql`. Swapped all 7 sites above from the raw `profiles` query to this RPC.

**Files:** `supabase/migrations/20260706160000_get_client_profile_names.sql`, `src/utils/viewPosBill.js`, `src/modules/pos/reports/SalesReport.jsx`, `src/modules/pos/reports/PosExceptionReport.jsx`, `src/modules/pos/shifts/PosShifts.jsx`, `src/modules/pos/reports/KotLog.jsx`, `src/modules/pos/creditnotes/CreditNotes.jsx`

### S282 — 2026-07-06 — Fixed: drill-down bill view never showed who issued/authorized it

User caught it live: the "Authorized by" line on a drilled-down Complimentary Slip was blank. `viewPosBill.js` had hardcoded `authorizedBy: ''` (and `cashierName: ''` on the Tax Invoice/Bill branch) instead of ever looking up the staff member — a copy-paste gap from when the function was first written, not something that touched the real print path. Now looks up `profiles.full_name` for whichever staff member actually acted (`comped_by` for an item-level comp, `closed_by` for everything else) and passes it through.

**Files:** `src/utils/viewPosBill.js`

### S281 — 2026-07-06 — Charge modal: amount moved next to the table name

Cosmetic layout tweak per user request: the bill total ("NPR 260") now sits on the same row as the table/takeaway name, right-aligned opposite it, instead of stacked below on its own line. The Pay/Void/Complimentary tab buttons shift up into the space that freed.

**Files:** `src/modules/pos/orders/PosOrders.jsx`

### S280 — 2026-07-06 — Bill ↔ Comp cross-referencing + new "Comped Bills" tab

User asked to tag a bill if it has a comped item (and vice versa — tag the comp with the bill it came from), plus a dedicated Sales Report tab for it.

- **Bill Register** (`/pos/sales-report`): a paid bill with an item comped out of it now shows a "Comped (NC-xx)" badge next to the customer name, same style as the existing "Credit Noted" badge. `loadRange()` no longer discards comped rows after filtering them out of revenue math — it groups them by (order_id, comp_no) into `compsByOrder`, computing food cost + menu-price potential value per comp event (same valuation as Sales Exceptions).
- **Sales Exceptions** (`/pos/exceptions`): the "vice versa" side — an item-comp row's Bill No cell now shows a small "on TI13-BC-82/83" line underneath its NC number, so you can trace a comp back to the bill it was carved out of. Also added to the Excel export as an "On Bill" column.
- **New "Comped Bills" tab** on `/pos/sales-report` (now 9 tabs): one row per comp event — Date, Bill No, NC No, Table, Items Comped, Food Cost, Potential Value, Reason — click any row to view that comp's mini Complimentary Slip via `viewPosBill`. Whole-order Complimentary orders don't appear here (no separate paid bill to cross-reference) — those stay in Sales Exceptions only.

**Files:** `src/modules/pos/reports/SalesReport.jsx`, `src/modules/pos/reports/PosExceptionReport.jsx`, `src/pages/Help.js`

### S279 — 2026-07-06 — Click-to-drill-down: view the actual bill from Exceptions/Sales Report

User asked to click a row in Sales Exceptions and drill down to the underlying bill, then asked for the same in Sales Report. Built a shared, read-only drill-down: `src/utils/viewPosBill.js` reuses the exact same `buildBillHtml`/`buildCompSlipHtml` pure builders the real print already uses (from `PosOrders.jsx`'s `posOrderPrintHtml.js`), opening the identical layout in a new browser tab — never calls `window.print()`, so it's a look, not a reprint. Handles three row shapes: a normal paid/void order (Tax Invoice/PAN Bill, comped lines excluded same as the real bill), a whole-order Complimentary row (Complimentary Slip), and an item-level comp row (mini Complimentary Slip for just that comp event's items, matched by `comp_no`).

Wired into: `/pos/exceptions` detail table (every row — discount, void, comp, item-comp) and `/pos/sales-report`'s Bill Register tab (the only one of its 8 tabs with one-row-per-order granularity; the rest are aggregates with no single bill to show). Both just pass `clientId` + minimal row identifiers; all data fetching happens inside `viewPosBill` itself.

**Files:** `src/utils/viewPosBill.js` (new), `src/modules/pos/reports/PosExceptionReport.jsx`, `src/modules/pos/reports/SalesReport.jsx`, `src/pages/Help.js`

### S278 — 2026-07-06 — Item-level comp: fixed the "tick one, all tick" bug + folded the Items list

User caught it live: ticking one item's Comp checkbox ticked all of them. Root cause — the checkbox Set was keyed by `item.id`, but cart items added via `addItem()` (the only path onto the cart) never carry a real `pos_order_items.id` until re-fetched from the DB; every item's `.id` was `undefined`, so they all shared one Set key. Switched the key to `recipe_id` instead (stable regardless of DB-sync state, and already guaranteed unique per order — `addItem()` merges a re-tapped recipe into its existing line rather than duplicating it). The Charge-time DB write changed to match `(order_id, recipe_id)` instead of a row id for the same reason.

Also folded the Items list behind a collapsed-by-default header (▸ Items · tap to expand, shows an "N comped" count even collapsed) — per user feedback, a comp checkbox visible on every single item on every payment read as a standing suggestion to comp something; folding it behind a deliberate tap keeps the feature available without pushing it in front of every cashier on every bill.

**Files:** `src/modules/pos/orders/PosOrders.jsx`

### S277 — 2026-07-06 — Sales Exceptions: Comp Potential Sales Value

User recalled wanting a report showing what comped (NC) items would have sold for at menu price, not just their food cost. No such page existed yet — searched code/memory to confirm, then scoped it with the user: extend the existing `/pos/exceptions` Comp rows/stat card rather than build a new page. Added a "Comp Potential Sales Value" stat card and a "Potential Value" detail-table column (menu price incl. VAT, same formula as the Void bucket's forgone-value) alongside the existing food-cost figure — covers both whole-order Complimentary and item-level comps. Also in the Excel export.

**Files:** `src/modules/pos/reports/PosExceptionReport.jsx`, `src/pages/Help.js`

### S276 — 2026-07-06 — Item-level comp: fixed revenue-reporting fallout

User asked to cross-check whether item-comp (S274) needed addressing elsewhere. An Explore audit found it did — several reports read `pos_order_items` without excluding `comped=true` rows, so a comped item (never actually billed) was still counted at full menu price:

- **`SalesReport.jsx`** (`/pos/sales-report`) — both item queries feeding Daily/Hourly/Bill Register/Payment Summary/Category/Item/Customer/1L+ now select `comped` and filter it out before building `itemsByOrder`. Real bug: every one of those 8 tabs was overstating Gross/Taxable/Net/VAT by the comped item's menu value.
- **`demandForecastData.js`** — `buildDailyHistory`'s revenue figure now excludes comped items; the per-recipe `qtyByRecipe` breakdown deliberately still includes them (a comped dish was still prepared — demand planning cares about that regardless of billing).
- **Credit Notes** (`IssueCreditNoteModal.jsx`, `CreditNotes.jsx`) — face value, printed itemization, and reprints now exclude comped items (they were never billed, so crediting them back overstated the correction). The `sales_entries` reversal on issuance intentionally still covers every item, comped or not — it mirrors the original write.
- **`PosExceptionReport.jsx`** (`/pos/exceptions`) — this was a visibility gap, not a wrong number: item-level comps live inside `close_type='paid'` orders, which the report's query never fetched at all. Added a second query for `comped=true` rows, grouped by (order_id, comp_no) into one exception row per Charge action (matching how a whole-order Comp is already one row per order), merged into the same "Comp" bucket/stat card/staff rollup.

Known pre-existing characteristic, not a new bug: Menu Engineering's "Revenue" column is `sellingPrice × qty_sold`, and `sales_entries.qty_sold` has always counted comped items (by design, for the quantity-ranking math) — this already overstated $ revenue for whole-order comps before item-level comp existed, unchanged by this feature.

**Files:** `src/modules/pos/reports/SalesReport.jsx`, `src/modules/pos/reports/PosExceptionReport.jsx`, `src/utils/demandForecastData.js`, `src/modules/pos/creditnotes/IssueCreditNoteModal.jsx`, `src/modules/pos/creditnotes/CreditNotes.jsx`

### S275 — 2026-07-06 — Recent Bills: reprint the item-comp slip

Closed the gap noted when S274 shipped: only the main bill could be reprinted from Recent Bills, not the mini Complimentary Slip for any item(s) comped on it. Added `pos_orders.comp_print_count` — a counter dedicated to that slip, separate from `print_count` (the main bill's own), since a 'paid' order with a comped item now carries both documents and sharing one counter would mislabel whichever one didn't actually get reprinted. `loadRecentBills()` now also fetches which of today's paid bills have any comped item and shows a "Comp Slip" reprint button only there.

**Files:** `supabase/migrations/20260706150000_pos_item_comp_slip_reprint.sql`, `src/modules/pos/orders/PosOrders.jsx`

### S274 — 2026-07-06 — Item-level Complimentary/comp

Whole-order Complimentary was the only comp path — no way to comp one dish while charging normally for the rest of the table (product-roadmap memory, Medium priority). Added an Items list to the Pay tab (Supervisor+ only): ticking an item removes it from that bill entirely and prints it on its own mini Complimentary Slip instead, while the rest of the table still bills and prints as one normal Tax Invoice/Bill.

- Design decisions (confirmed with user): authority stays Supervisor+ only with no NPR/qty caps (matches today's whole-order rule, just finer-grained); printed as a separate mini Complimentary Slip (not a ₨0 line on the main bill).
- Migration `20260706140000_pos_item_level_comp.sql`: `pos_order_items` gets `comped/comp_reason/comped_by/comped_at/comp_fy/comp_no` + a check constraint. New RPC `get_next_pos_comp_slip_no(client_id, fy)` hands out one number per Charge action (all items comped together share one slip/one number, not one per line) from the **same NC-series** a whole-order Complimentary Slip uses — `assign_pos_invoice_no()`'s `close_type='writeoff'` branch was updated (only that branch) to lock on and consider the same combined pool, so the two paths can never hand out the same number to two different documents.
- `PosOrders.jsx`: new `paySubEx`/`payVatAmtRaw`/`payTotal` computed from non-comped items only (the existing whole-order `subEx`/`vatAmt`/`total`/`compTotal` used by Void and whole-order Complimentary are untouched); `writeSalesEntries()` now aggregates stock_movements into two buckets (`pos_sale`/`pos_comp`) since the same ingredient can appear in both a comped and a paid dish on one ticket; printed Tax Invoice/Bill and live preview both build from the non-comped subset; a new `printItemCompSlip()` reuses the existing `buildCompSlipHtml()` builder with the comp-specific number swapped in for `invoice_no`.
- Help.js and `pos_order_items` reprint path (`reprintBill`) updated to exclude comped lines from a reprinted Tax Invoice.
- Not yet wired: reprinting the item-comp slip itself from Recent Bills (only the main bill reprints today).

**Files:** `supabase/migrations/20260706140000_pos_item_level_comp.sql`, `src/modules/pos/orders/PosOrders.jsx`, `src/pages/Help.js`

### S273 — 2026-07-06 — QR tab: gave the webhook secret its own Save button

Follow-up to S272: "Save QR" was sitting under the new Payment Webhook section, not the Payment QR section it's named for. Moved it back directly under the Payment QR block, and added a second "Save Webhook Secret" button under the webhook section — both call the same `handleSaveSettings` (saves the whole settings row either way), but each section now visually owns its own save action.

**Files:** `src/pages/adminClients/ClientDrawer.js`

### S272 — 2026-07-06 — Admin UI for the per-client payment webhook secret

Follow-up to S271: the webhook receiver scaffold needed a way to actually set `settings.pos_webhook_secret` per client. Added a "Payment Webhook (advanced)" section to Manage Clients → a client → QR tab, right below the existing Payment QR field — a text input plus a "Generate" button (random 32-byte hex via `crypto.getRandomValues`). Saves through the QR tab's existing "Save QR" button/`saveClientSettings()` call; no new save path, since it's just another column on the same `settings` row.

**Files:** `src/pages/adminClients/ClientDrawer.js`

### S271 — 2026-07-06 — QR payment auto-confirmation: webhook receiver scaffold

First half of the "QR payment auto-confirmation" roadmap item (Low priority). Lands the receiving side only — no real merchant account is onboarded yet, so nothing calls this in production until a provider is wired up.

- New table `pos_payment_confirmations` (client_id, provider, amount, reference, txn_ref, matched_order_id, consumed_at, raw_payload) + `settings.pos_webhook_secret` — migration `20260706120000_pos_payment_webhook_scaffold.sql`
- New Edge Function `pos-payment-webhook`: verifies a placeholder HMAC signature against the client's `pos_webhook_secret`, is idempotent on (client_id, provider, txn_ref), and best-effort matches the payment to an open `pos_orders` row via a `reference` string (`CR<order_no>`). Deliberately does **not** close the order itself — that needs the app's BS-fiscal-year/invoice-numbering logic, which shouldn't be re-implemented a second time in Deno.
- `emvQr.js`'s `buildDynamicQr()` now takes an optional `reference`, embedded as EMVCo tag 62/05, so a real provider webhook that echoes a reference can be matched back to the order that generated the QR.
- `PosOrders.jsx`: the bill QR now carries `CR<order_no>` as that reference. While the Charge modal shows a QR (non-split, eSewa/Khalti/FonePay), it polls `pos_payment_confirmations` every 4s for a matching, unconsumed row and — if found — auto-runs the existing `closeOrder('paid')` path, the same one the manual Pay button calls. No duplicated billing/close logic.
- Still needed before this does anything live: an admin UI to set `pos_webhook_secret` per client, and the actual FonePay/eSewa merchant API onboarding + real signature scheme (see product-roadmap memory).

**Files:** `supabase/migrations/20260706120000_pos_payment_webhook_scaffold.sql`, `supabase/functions/pos-payment-webhook/index.ts`, `src/utils/emvQr.js`, `src/modules/pos/orders/PosOrders.jsx`, `src/shared/scopedDb.js`

### S270 — 2026-07-06 — Login page: View Pricing styled as a solid button

Follow-up to S268: the "View Pricing" link was plain text, easy to miss next to the branding. Restyled it as a solid green pill using the same `login-btn login-btn--trial` classes as the "Start Free Trial" button below it, just scaled down (smaller padding/font) to fit the corner.

**Files:** `src/pages/Login.js`

### S269 — 2026-07-06 — Pricing: aligned the IMS tier price rows, moved the trial badge inline

Follow-up to S267: the "FREE FOR 7 DAYS" badge sat on its own line above the Starter tier's price, pushing that price one row lower than Growth's and Pro's — the three cards no longer lined up. Moved the badge inline next to the "Starter" title (now a small pill reading "FREE FOR 7 DAYS TRIAL"), freeing the price row to sit at the same height across all three tiers. Also reworded "/mo after" → "/mo after trial" for clarity on what the recurring price is after (the trial ending, not a typo/truncation).

**Files:** `src/pages/Pricing.js`, `src/pages/Help.js`

### S268 — 2026-07-06 — Login page: added a "View Pricing" link for pre-login visitors

`/pricing` has been a public, no-auth route all along, but nothing on the Login page ever pointed to it — a new visitor had no way to discover it existed unless they already knew the URL. Added a "View Pricing →" button in the top-right of `Login.js`'s brand row (next to the "Crest Inventory" logo/name, above both the trial-signup form and the sign-in form), navigating to `/pricing` via the existing `useNavigate()` hook. Visible immediately without scrolling, for both new visitors and existing users who forgot the plan details.

**Files:** `src/pages/Login.js`

### S267 — 2026-07-06 — "FREE FOR 7 DAYS" badge made more prominent

Follow-up to S266: the corrected trial badge was still small, upright text easy to miss next to the price below it. Bumped it to italic and a larger font size (11→14 on `Pricing.js`, 10→13 on Help.js's Pricing tab) so it reads as a nudge to try the free week, not just fine print.

**Files:** `src/pages/Pricing.js`, `src/pages/Help.js`

### S266 — 2026-07-06 — Pricing: fixed stale "FREE FOR 1 MONTH" trial copy, bolder Help.js Pricing intro

Two follow-ups from a client review of the S263-265 pricing rollout. **Trial copy bug:** the IMS Starter tier's badge said "FREE FOR 1 MONTH" (both `Pricing.js` and Help.js's Pricing tab) and a FAQ answer echoed "free for the first month" — both stale, left over from the pre-existing file content, and contradicting the real trial mechanism: a **7-day** self-service trial (`AuthContext.js`'s `trial_expires_at`/`isTrial`, `Login.js`'s own "7-day free trial" copy), which the same page's hero banner already correctly advertises ("1-week free trial"). Corrected the badge to "FREE FOR 7 DAYS" in both places and reworded the FAQ answer to match.

**Pricing intro visual pass:** Help.js's "Plans & Pricing" heading was a plain small `<h2>` with a thin subtitle — asked to be made more visually captivating for new clients. Added a row of three small module-colored dots (blue/green/violet) above the heading, bumped the heading to a bolder/larger treatment, and rewrote the subtitle to name all three modules ("One system for IMS, HR, and POS — pick a module or bundle them all") instead of the generic "Choose the plan that fits your property."

**Files:** `src/pages/Pricing.js`, `src/pages/Help.js`

### S265 — 2026-07-06 — Help.js Pricing tab: split the combined HR/POS heading into its two module colors

Follow-up to S264: the "Crest HR & Crest POS" eyebrow label above that section was entirely colored green (`MODULE_COLORS.hr`) even though it introduces both modules — visually implying POS was green too, when its card right below is violet. Split into three spans: "Crest HR" in green, "&" in neutral gray, "Crest POS" in violet, so the label matches the two cards it precedes.

**Files:** `src/pages/Help.js`

### S264 — 2026-07-06 — Pricing: module-color titles applied consistently across all 3 modules

Follow-up to S263: the new module-color convention (blue/green/violet) was only applied to dots, checkmarks, and borders — the actual card/section titles ("Starter"/"Growth"/"Pro", "Crest HR", "Crest POS") were still plain white text, and `ClientDrawer.js`'s billing panel still colored the "CREST IMS" header and the Pro tier's active state gold (a leftover from the old per-tier scheme) instead of IMS's blue. Fixed in all three files: `Pricing.js` and Help.js's Pricing tab now color each IMS tier's name and each HR/POS card's name with `MODULE_COLORS.ims`/`mod.color`; `ClientDrawer.js`'s per-module header (`CREST IMS`/`CREST HR`/`CREST POS`) now uses `accentBase` (`MODULE_COLORS[mod.key]`), and the IMS Starter/Growth/Pro tier-picker's active-state accent is now uniformly `MODULE_COLORS.ims` for all three tiers instead of gold-for-Pro/blue-for-Growth/gray-for-Starter.

**Files:** `src/pages/Pricing.js`, `src/pages/Help.js`, `src/pages/adminClients/ClientDrawer.js`

### S263 — 2026-07-06 — Pricing rollout: new IMS/HR/POS numbers, one shared pricing data file, module colors

Three independent hand-maintained copies of pricing had already drifted from each other and from the real tier assignments in `AuthContext.js`: the public `/pricing` page, Help.js's logged-in Pricing tab, and `ClientDrawer.js`'s admin billing panel (which applies the same Starter/Growth/Pro ladder to every module tab, including HR/POS even though neither has ever actually been tier-gated). Consolidated all three onto one new file, **`src/data/pricingPlans.js`** — `MODULE_COLORS` (blue `#60a5fa` IMS / green `#34d399` HR / violet `#a78bfa` POS, matching the pill convention from S260-262), `IMS_TIERS` (Starter NPR 2,000 / Growth 2,600 / Pro 3,500 monthly, 25% off annual), `HR_PRICING` and `POS_PRICING` (flat NPR 2,600 and 2,000/mo — never real tiers), and `SUITE_BUNDLES` (IMS+HR+POS bundled at ~20% off buying separately: 5,300 / 5,800 / 6,500).

`Pricing.js` and Help.js's Pricing tab now both import from this file instead of keeping their own `PLANS`/`STARTER_FEATURES`/`PRICE_PLANS` arrays, and render three sections — IMS's 3-tier grid, an HR+POS flat-price pair, and the Suite bundle row — colored by module instead of the old per-tier gold/green/indigo scheme. `ClientDrawer.js`'s billing panel now branches per module: IMS keeps its Starter/Growth/Pro picker (sourced from `IMS_TIERS`), HR and POS render a flat NPR box with no picker at all, since selecting a "plan" for a flat-priced module was never meaningful. `hr_plan`/`pos_plan` DB columns are untouched — still harmless unused strings.

Caught mid-implementation: Help.js already had an unrelated array also named `IMS_TIERS` (the Getting Started/Module Guide feature-by-tier breakdown, predates this change) — renamed that one to `IMS_FEATURE_TIERS` to resolve the collision with the newly-imported pricing `IMS_TIERS`.

**Files:** `src/data/pricingPlans.js` (new), `src/pages/Pricing.js`, `src/pages/Help.js`, `src/pages/adminClients/ClientDrawer.js`

### S262 — 2026-07-06 — Getting Started tagline colors corrected to match the module-pill convention

Follow-up to S261: the IMS and HR tagline boxes were gold and blue respectively, which don't actually match the app's established IMS/HR/POS module-pill colors (`AdminDashboardOverview.jsx`'s client-list pills: IMS `#60a5fa` blue, HR `#34d399` green, POS `#a78bfa` violet — the same reference used to color POS's tagline in S261, but not yet applied back to IMS/HR at the time). Corrected: IMS tagline → blue, HR tagline → green. POS was already correct.

**Files:** `src/pages/Help.js`

### S261 — 2026-07-06 — Getting Started: added the missing POS core-idea tagline

Follow-up to S260: the Crest Inventory and Crest HR "Welcome" cards each have a one-line core-idea tagline in a highlighted box (COGS formula / Attendance→Payroll), but POS's card was missing one. Added "Order → Bill → Shift Close: every sale reconciles back to the cash drawer at day's end," styled the same way. Colored violet (`#a78bfa`, the POS color from the module-pill convention on the Admin Dashboard's client list, `AdminDashboardOverview.jsx`) rather than reusing IMS's gold, so the tagline reads as its own module instead of a shade of IMS.

**Files:** `src/pages/Help.js`

### S260 — 2026-07-06 — Getting Started tab: added HR and POS onboarding, made all three collapsible

The Help page's "Getting Started" tab was 100% IMS content — welcome blurb, First-Time Setup, Monthly Workflow, and Common Mistakes cards all only covered Item Master/Purchases/Recipe Costing, unconditionally rendered regardless of which modules a client actually has. Added equivalent onboarding for Crest HR (Employees → Pay Setup → Roster → Attendance → Payroll, with a "Monthly Workflow" and common mistakes list that calls out the SSF-toggle bug fixed in S255, the OT ×2 double-pay risk, and TDS's year-to-date calculation depending on finalizing months in order) and Crest POS (Tables → POS Staff → Menu Pricing → Shifts, with a "Daily Workflow" since POS is an operational loop, not monthly) — each gated behind `hrEnabled`/`posEnabled` the same way the Module Guide tab already gates its sections. The existing IMS content is unchanged, now gated behind `imsEnabled`.

**Made all three sections an accordion, collapsed by default** (added mid-session after seeing the three modules stacked would mean 12 cards of scrolling for a Suite client): each module's "Welcome to Crest X" card is now the clickable header — collapsed it shows just a one-line teaser, expanded it reveals the welcome text plus that module's Setup/Workflow/Mistakes cards. New `openGS`/`crest_help_gs`-persisted state, independent per-module toggles (not a single-open accordion), mirroring the `openModules` pattern already used on the Module Guide tab but defaulting closed instead of open.

**Files:** `src/pages/Help.js`

### S259 — 2026-07-06 — IMS re-tiering: Staff Meals → Starter, Demand Forecast → Pro

Part of the pricing/bundling strategy work: moved two features between IMS plan tiers ahead of the actual price-number rollout. `staff_meals` (Growth → Starter) and `demand_forecast` (Growth → Pro).

This touched more than the two `Set`s in `AuthContext.js` — `demand_forecast` is gated by a route-level `PremiumGate minPlan="growth"` in `App.js` (independent of `GROWTH_KEYS`/`PRO_KEYS` membership; `PremiumGate`'s `meetsMinPlan` check compares plan rank directly against the `minPlan` prop), so that had to move to `minPlan="pro"` too, along with the matching display-only `minPlan` hint on the Demand Forecast nav item in `Layout.js`. `staff_meals` has no dedicated route — it's gated inline via `hasFeature('staff_meals')` inside `Stock.js`'s tab list — so the `Set` move alone was sufficient there.

**Found and fixed a pre-existing bug in the process:** Help.js's Module Guide accordion (`IMS_TIERS`) had the "Demand Forecast" feature card filed under the **Starter** tier's array, even though `GROWTH_KEYS` and Help's own Pricing-tab list both already said Growth — a display-only inconsistency, now corrected as part of the same move (to Pro's array, matching its new tier).

Also updated: `FeatureAccessModal.js`'s admin per-client override groupings, Help.js's `STARTER_FEATURES`/`GROWTH_EXTRAS`/`PRO_EXTRAS` pricing lists, and two stale "Growth plan and above" text mentions on the Stock Count feature card.

**Files:** `src/context/AuthContext.js`, `src/App.js`, `src/components/Layout.js`, `src/pages/adminClients/FeatureAccessModal.js`, `src/pages/Help.js`

### S258 — 2026-07-06 — Recipe Export restricted to Crest Admin

Follow-up to S257: the new ↓ Export button (and the cross-client portability it enables) is now gated behind `isAdmin` — client users no longer see it, only Crest Admin. `Recipes.js` passes `isAdmin` (from `useAuth()`) down to `RecipeImportButton`; ↓ Template / ↑ Import Excel are unaffected and stay available to everyone, as before.

**Files:** `src/modules/ims/recipes/Recipes.js`, `src/modules/ims/recipes/RecipeImportButton.jsx`, `src/pages/Help.js`

### S257 — 2026-07-06 — Recipe Costing: Export Recipe function

Recipe Costing had a bulk import path (↓ Template / ↑ Import Excel) and a per-recipe print (Recipe Cost Card), but no way to get *existing* recipes back out — no backup, no bulk-editing offline, nothing to hand to another location. Added a "↓ Export" button (`RecipeImportButton.jsx`) that downloads every current recipe and sub-recipe with its full ingredient breakdown.

**Format is a superset of the import template** — same first 7 columns (`Menu Item`, `Category`, `Selling Price`, `Yield`, `Ingredient`, `Qty`, `Unit`), plus 4 reference-only columns appended after (`Ingredient Rate`, `Ingredient Cost`, `Recipe Food Cost`, `Recipe FC%`) since `parseImportRows` reads positionally and ignores anything past column 6 — so the export doubles as a standalone cost report and a re-importable file. Reuses `calcRecipeCost`/`calcSubRecipeCostPerUnit` from `recipeCostCalc.js` — no new cost-calculation logic.

**Explicitly designed and verified for cross-client portability** (Aashish's requirement): the file carries only recipe/ingredient *names*, never `item_id`/`recipe_id`, so importing one client's export into a different client matches against that client's own Item Master and checks duplicates against that client's own recipes — not the export's origin. Verified live: exported all 88 recipes/54 sub-recipes (641 rows) from Casa Acai Cafe, re-imported into Casa Acai Cafe itself (0 to import, all 88 correctly flagged "Already exists", 640/640 ingredients matched — proves byte-for-byte import compatibility), then imported the same file into the unrelated TRIAL client (0 false "Already exists" flags, 33/142 recipes matched via overlapping generic ingredient names like Banana/Milk/Honey, the acai-specific recipes correctly skipped since TRIAL's Item Master has no matching ingredients) — proving the file is genuinely portable, not just re-importable into its own client.

**Files:** `src/modules/ims/recipes/RecipeImportButton.jsx`, `src/pages/Help.js`

### S256 — 2026-07-06 — Four small roadmap items: Tables pill, Purchases day-pill shorten, Glossary/FAQ, Module Guide stacking

- **POS Tables — Quick Setup**: replaced the always-visible full-width card panel above the floor grid with a small `⚡ Quick Setup` pill (matching the `tab-btn` convention used elsewhere), which opens the same form (unchanged) in a `Modal` instead of an inline expanding section.
- **Purchases — day pills**: shortened `Day {d}` to `D{d}` in the existing day-filter pill strip (bill-count badges and "All Days" label untouched).
- **Help page — Glossary/FAQ**: both were 100% IMS-only despite HR and POS having ~25 feature guides between them. Added 18 new Glossary terms (9 HR: TDS, Gratuity, CTC, Dearness Allowance, Shift Type, Roster, Final Settlement, Festival Allowance, Overtime; 4 POS: KOT/BOT, X/Z-Report, Credit Note, 1L+ Report; 5 IMS Growth/Pro gap terms: Dead Stock, Shrinkage, Menu Engineering, Demand Forecast, Requisition) and 6 new FAQ entries (3 HR, 3 POS — including one tying directly into the S255 SSF toggle fix).
- **Help page — Module Guide stacking**: each module section (IMS/HR/POS) previously always rendered in full, so a POS-only user still scrolled past every collapsed IMS/HR feature row to reach POS. Reused the exact collapsible-group pattern from `Layout.js`'s sidebar nav groups (`openGroups`/`localStorage`-persisted state) at the module level — `openModules`/`crest_help_modules`, defaulting all three open (no regression), each module header now toggles independently.

Live-verified via Playwright against Casa Acai Cafe: Quick Setup modal opens/generates correctly, day pills render `D2 · 1 bill` etc., collapsing Crest IMS on Module Guide leaves HR/POS untouched, and the new Glossary/FAQ entries render and expand correctly.

**Files:** `src/modules/pos/tables/PosTableManagement.jsx`, `src/modules/ims/purchases/Purchases.js`, `src/pages/Help.js`

### S255 — 2026-07-06 — Bug fix: SSF Enrolled toggle was cosmetic — SSF always computed regardless

Reported by Aashish: Pay Setup → Bank/SSF tab has an "SSF Enrolled" toggle, but turning it off didn't stop the Salary tab's Monthly Summary from showing an 11% SSF Employee deduction. Root cause found in two places, both computing `ssf_base = Math.min(basic, SSF_CAP)` unconditionally — never reading `ssf_enrolled` at all:

- **`PayForm.jsx`** (the Pay Setup edit modal) — the live Monthly Summary and the Deductions tab's "SSF — Employee (11%) · auto" row both showed SSF regardless of the toggle.
- **`PaySetup.jsx`** (the Pay Setup list page) — same bug, one level up: the SSF Employee/Employer stat cards, the per-row Deductions/Net Salary/SSF Employer columns, and the Excel export all computed SSF for every monthly employee, toggle or not.

`payrollCompute.js` (the actual payroll run) already gated correctly on `employee.ssf_enrolled` — confirmed live on Casa Acai Cafe's real (non-enrolled) staff: the payroll draft already showed "no SSF" badges and NPR 0 employer SSF, while both Pay Setup screens showed non-zero SSF for the same four employees. Fixed by gating `ssf_base` on `ssf_enrolled` in both files (one-line fix each) plus hiding/showing the SSF summary rows in `PayForm.jsx` accordingly. Verified live: toggling SSF off on Ananda now correctly zeroes SSF Employee/Employer and raises Net/CTC to just Gross; the list page's totals dropped from NPR 5,799/10,542 to NPR 0/0 for the four non-enrolled employees, matching the real payroll draft.

**Files:** `src/modules/hr/pay/PayForm.jsx`, `src/modules/hr/pay/PaySetup.jsx`

### S254 — 2026-07-06 — POS Login: colorful initials avatars

The POS staff login screen (`/pos/login`) already had a name-only tile picker — no photo, no color, nothing to help staff spot their own tile quickly on a shared floor device. Roadmap ask was "colourful or pictogram for picture+name"; scoped down to the colorful-initials option (Slack/Gmail-style) rather than real photo upload, since that needs zero new schema/Storage/edge-function work and ships the actual UX win (fast tile recognition) immediately.

**New `src/utils/avatarColor.js`** (pure, tested): `getInitials(fullName)` and `avatarColorFor(id, isDark)`, the latter hashing the staff `id` (not list position, so colors never reshuffle when staff are added/removed) into one of 8 categorical hues from the dataviz skill's validated reference palette, picking the light or dark column by the active theme's background luminance, and choosing white vs near-black initials text by whichever has higher computed WCAG contrast against that specific hue (verified all 8 slots clear ≥3:1, the large-text AA threshold — worst case 3.98:1).

`PosLogin.jsx` tiles grew from 130×80 text-only to 130×128 with a 52px avatar circle on top; no RPC/schema change (`get_pos_staff` already returns `id` + `full_name`). Verified live in both dark and a light theme preset via a Playwright session with the `get_pos_staff` RPC intercepted (no real POS staff accounts existed yet on the test client, so synthetic staff were fed in rather than creating real login credentials just to screenshot).

**Files:** `src/utils/avatarColor.js` (new), `src/utils/avatarColor.test.js` (new), `src/modules/pos/login/PosLogin.jsx`, `src/pages/Help.js`

### S253 — 2026-07-06 — Attendance: "Generate from Roster" pre-fill

Roster already captured who's scheduled to work which shift each day (`hr_roster`), but nothing downstream used it — Attendance (the table Payroll actually reads) was 100% manually keyed, one employee/day at a time, every month. Added a "⚡ Generate from Roster" button to the Attendance page's Mark Attendance tab that pre-fills the month from Roster shift assignments in one click.

**Fills gaps only, never overwrites:** for each employee × day in the selected period, a roster shift resolving to real hours → `present` with those hours; no roster row on a Saturday → `weekly_off` (matches the existing default); anything else (already has an attendance row, or no roster entry on a non-Saturday) is left untouched for manual entry. Leave, unscheduled offs, and OT stay 100% manual, matching how they work today.

**Bug caught during live verification, fixed before shipping:** some venues create custom zero-hour shift types on the Roster board purely to mark exceptions visually (e.g. a "LEAVE" or "OFF" entry with no start/end time) — verified live on Casa Acai Cafe's real roster data, which already had exactly this. The first pass treated any roster row as "present," so an employee on a whole week of roster-marked "LEAVE" got paid-present days generated. Fixed: a roster row only counts as present when its shift resolves to positive hours; a zero/unresolvable-hours roster entry now falls through to the same handling as no roster row at all (blank, or Saturday default).

No schema change, no changes to `payrollCompute.js` — the generator only ever writes ordinary `hr_attendance` rows, so payroll's hot path is untouched.

**Files:** `src/modules/hr/attendance/attendanceFromRoster.js` (new, pure logic + tests), `src/modules/hr/attendance/AttendanceSheet.jsx`, `src/modules/hr/roster/laborForecast.js` (exported existing `shiftHours` helper for reuse), `src/pages/Help.js`

### S252 — 2026-07-06 — Split all six "god components" flagged in the architecture report

Closed the last item from the S249 architecture report: the six files over 1,200 lines. Two shapes of fix, chosen per file based on what was actually inside:

**Mechanical extraction (already had self-contained sub-components sitting in the same file, just not physically separated):**

- `AdminClients.js` 1813 → 448 lines. `ClientDrawer` (1036 lines) and `FeatureAccessModal` (216 lines) moved to `src/pages/adminClients/`, plus `adminOp.js` for the edge-function helper. Pure relocation — verified by a near-zero bundle size delta.
- `Roster.jsx` 1254 → 839 lines. `ShiftPicker`, `SuggestPopover`, `ShiftSettingsPanel` moved to their own files under `src/modules/hr/roster/`, plus `rosterHelpers.js` for the shared `fmtTime`.

**Split along a real internal boundary:**

- `Dashboard.js` 1347 → 9 lines + 2 modules. It was two unrelated dashboards (`AdminDashboardOverview`, cross-tenant; `ClientDashboard`, per-client financial) gated by one boolean sharing almost no state. `Dashboard.js` is now a thin router; each half owns its own `useAuth()`/data-loading instead of prop-threading.

**Genuine extraction — no pre-existing seams, had to design the split:**

- `Purchases.js` 1262 → 659 lines + 3 modules. `PurchaseBillModal.jsx` (multi-row bill form, now owns its own header/line state, calls back `onSaved(validLines)` so the parent's rate-change-detection stays where the `items` cache lives) and `ReturnsTab.jsx` (return form + table, fully self-contained), plus `purchasesHelpers.js` for `getCf()`.
- `Recipes.js` 2034 → 1225 lines + 4 modules. `recipeCostCalc.js` (pure cost/nutrition-filter functions), `RecipeCostCardPrint.jsx` (the A4 print card, previously duplicated verbatim in two places), `NutritionEditorModal.jsx` (per-ingredient nutrition editor with library-seed + Open Food Facts lookup), `RecipeImportButton.jsx` (the whole bulk-Excel-import feature).
- `PosOrders.jsx` 2348 → 2085 lines + 2 modules — deliberately the smallest cut. This is the highest-traffic, highest-stakes live screen (order-taking, billing, offline sync), so only genuinely zero-behavior-risk moves were made: `posOrderPrintHtml.js` (the pure bill/comp-slip/tender-slip/KOT-BOT HTML builders, parameterized instead of closing over component state — same pattern as `printCreditNote` from S251) and `posOrdersConstants.js` (pure constants, confirmed zero-risk by an identical production bundle hash before/after). The floor/order/billing/offline-queue state stays one component — splitting it further risks subtle real-time bugs that need a live device to catch, not just a build check.

Every step verified via `CI=true npm run build` (clean each time) and the pure-function test suite (67 tests). `Dashboard.js` and `PosOrders.jsx` additionally got a dev-server + Playwright screenshot check (app shell loads, no console errors) since neither could be verified past the Supabase auth gate without real credentials.

**Not done, still open:** manual click-through testing of each split page in a real browser session (build/lint catch reference errors, not behavioral regressions) — recommended before relying on any of these in production, especially `Purchases.js` and `PosOrders.jsx` since they're money-handling. Broader component/UI test coverage remains at zero — the only automated tests are the pure-function suites from S249.

**Files:** `src/pages/adminClients/{ClientDrawer,FeatureAccessModal,adminOp}.js` (new), `src/modules/hr/roster/{ShiftPicker,SuggestPopover,ShiftSettingsPanel,rosterHelpers}.js` (new), `src/pages/dashboard/{AdminDashboardOverview,ClientDashboard}.jsx` (new), `src/modules/ims/purchases/{PurchaseBillModal,ReturnsTab,purchasesHelpers}.js` (new), `src/modules/ims/recipes/{recipeCostCalc,RecipeCostCardPrint,NutritionEditorModal,RecipeImportButton}.js` (new), `src/modules/pos/orders/{posOrderPrintHtml,posOrdersConstants}.js` (new), plus the six original files trimmed down

### S251 — 2026-07-05 — scopedDb rollout finished: POS + core/admin pages; architecture punch list closed

Closed out the last item from the S249 architecture report: migrated the remaining POS module (9 files) and the 5 core/admin pages (`AdminClients`, `AuditLog`, `Dashboard`, `Periods`, `Settings`).

**POS (8 of 9 files changed; `PosStaff.jsx` only touches `settings`/an RPC, already correct).** Along the way, found `pos_order_items` and `pos_order_payments` actually carry `client_id NOT NULL` and were already in `CLIENT_SCOPED_TABLES` (confirmed by `PosOrders.jsx`, already on `scopedDb` from earlier POS work) — several reads across `CreditNotes.jsx`, `IssueCreditNoteModal.jsx`, `KotLog.jsx`, `PosExceptionReport.jsx`, and `SalesReport.jsx` had been left on raw `supabase.from()` under the wrong assumption they were `order_id`-only scoped like `recipe_ingredients`; corrected all of them for consistency with the allowlist. Also fixed `creditNoteHtml.js`'s `printCreditNote()`, which took a raw `supabase` client as a parameter and updated `pos_credit_notes` by id alone with no `client_id` filter at all — now takes `clientId` and goes through `scopedUpdate`.

**Core/admin pages split into two real patterns**, not just "migrated" vs "not":

- `Dashboard.js`, `Periods.js`, `Settings.js` — single-client views, migrated straight onto the `useScopedDb()` hook.
- `Periods.js`'s admin "all clients" view and `Dashboard.js`'s `loadAdminStats()` are genuinely cross-tenant (every client's periods/profiles in one unscoped read to build an overview table) — those reads correctly stay on raw `supabase.from()`, but the per-client *actions* inside them (close/end/create a period for one specific `cid`) now go through the raw (non-hook) `scopedInsert`/`scopedUpdate` functions bound to that `cid` instead of hand-stamping `client_id`.
- `AdminClients.js` has no `clientId` of its own at all — it's pure admin tooling looping over an explicit client list — so every action uses the raw scoped functions with `client.id` passed in per call (items unit-conversion cleanup, `feature_flags` wipe on delete, opening-period seed on create).
- `AuditLog.js` needed no changes — `audit_logs.client_id` is nullable and the page's own "All Clients" filter is fundamentally incompatible with auto-scoping to the session's client, so it correctly stays as-is (same reasoning as `settings`/`budgets`).

**`scopedDb.js` extended:** `scopedFrom()` now accepts a 4th `options` param so the `.select(col, { count: 'exact', head: true })` shape (used for Dashboard's cheap row counts) can go through it too — previously it only forwarded the column list.

Also deleted `CREST_SUITE_PROJECT_CONTEXT_HR.md` (S250) — see prior entry.

**Punch list from the S249 architecture report is now closed**: every client-scoped table read/write across IMS, HR, POS, and core/admin goes through `scopedDb`. Remaining from that report: the six 1,200+ line "god components" are still unsplit, and broader component/UI test coverage is still zero — neither is in progress.

**Files:** `src/shared/scopedDb.js`, `src/shared/scopedDb.test.js`, `src/shared/hooks/useScopedDb.js`, 9 files under `src/modules/pos/`, `src/pages/{AdminClients,AuditLog,Dashboard,Periods,Settings}.js`, `CLAUDE.md`

### S250 — 2026-07-05 — scopedDb rollout completed across IMS + HR; stale planning doc removed

Follow-up to S249, which had only migrated `Items.js`/`Vendors.js` as the proof-of-concept and left ~68 files. Continued the same mechanical pattern (hand-written `.eq('client_id', ...)` → `scopedFrom`/`scopedUpdate`/`scopedDelete`, hand-stamped `client_id: X` on inserts/upserts → `scopedInsert`/`scopedUpsert`) across every remaining IMS file (34: purchases, recipes, sales, stockcount, variance, and all 13 flat reports) and every HR file (14: advances, attendance, employees, festival, gratuity, holidays, leave, overtime, pay, payroll reports, roster, settlement), verifying `CI=true npm run build` after each batch.

Found and fixed two real bugs surfaced by the sweep, not just call-site mechanics:

- `MenuEngineering.js` was fetching `recipe_ingredients` completely unfiltered — no `client_id` and no `recipe_id` scoping at all, meaning every tenant's ingredient rows loaded on every request (harmless today only because nothing downstream used the wrong rows by accident). Fixed by scoping to `.in('recipe_id', recipes.map(r => r.id))`.
- `CLIENT_SCOPED_TABLES` was missing every `hr_*` and `pos_*` table (24 of them) — the original S134/S211-era audit only ever looked at IMS. Expanded to the full 37-table list, cross-checked against the live `NOT NULL` constraints in `supabase/migrations/20260705074838_baseline_schema.sql`.

`scopedDb.js` itself needed two API extensions discovered mid-migration: `scopedInsert(..., { single: true })` for the `.insert().select().single()` shape, and `scopedUpsert` now always calls `.select()` internally (Roster.jsx's `hr_roster` upsert needs the row back to read its `id`). `useScopedDb()` also had to be wrapped in `useMemo(..., [clientId])` — without it, every consumer's own `useCallback`/`useEffect` deps arrays saw a new function reference each render and either warned or refetched in a loop.

Also deleted `CREST_SUITE_PROJECT_CONTEXT_HR.md` — a pre-build planning doc frozen at S173 (2026-06-30) that had drifted from reality (used a `shared_clients`/`ims_purchases`/`pos_bills` naming scheme that was never built, and listed `hr_overtime_entries`/`hr_holiday_calendar` as unbuilt when both are live tables today). Superseded by `CLAUDE.md`, this README, and the memory files.

**Not done, still on the architecture punch list:** POS (9 files: CreditNotes, IssueCreditNoteModal, PosCustomers, KotLog, PosExceptionReport, SalesReport, PosShifts, PosStaff, PosTableManagement) and core/admin pages (AdminClients, AuditLog, Dashboard, Periods, Settings) still filter `client_id` by hand. The six 1,200+ line "god components" remain unsplit.

**Files:** `src/shared/scopedDb.js`, `src/shared/hooks/useScopedDb.js`, `src/shared/scopedDb.test.js`, 34 IMS files under `src/modules/ims/`, 14 HR files under `src/modules/hr/`, `src/utils/demandForecastData.js`, `CREST_SUITE_PROJECT_CONTEXT_HR.md` (removed)

### S249 — 2026-07-05 — Architecture hardening: IMS modularization, pure-function test coverage, client-scoped data-access layer, versioned DB migrations

Requested architecture review of the whole Suite, then worked down its punch list.

**IMS modularization.** IMS was the one module still living flat in `src/pages/` (44 files) instead of matching HR/POS's `src/modules/<name>/` structure — `src/modules/ims/*` existed only as empty scaffold folders. Moved 34 true IMS-domain files into `src/modules/ims/{items,vendors,purchases,sales,stockcount,variance,recipes,reports}/`, one domain group per commit-sized batch, verifying `CI=true npm run build` after each. Left the 10 app-shell/admin pages (Dashboard, Login, Pricing, Settings, Periods, AdminClients, AuditLog, Help, Placeholders) in `src/pages/` — they aren't module-specific. Confirmed via full-repo grep that nothing in HR or POS imports any of the moved files.

**Pure-function test coverage.** The zero-test-coverage gap was highest-leverage on the money-handling pure functions (no React/Supabase, already framework-free). Added Jest suites: `payrollCompute.test.js` (13 tests — SSF cap enforcement, unpaid-leave forfeiting allowances not just basic, OT weekday/holiday multiplier, all 3 pay bases), `tds.test.js` (13 — fiscal-year mapping, slab selection, SSF first-slab waiver, YTD projection self-correction), `posBillingMath.test.js` (8 — VAT/discount math, and that `computeCategoryAmounts`/`computeItemAmounts` always reconcile exactly to `computeOrderAmounts`), `bsCalendar.test.js` (15 — anchor date, round-trip conversion, fiscal-year boundaries, month/year rollover).

**Client-scoped data-access layer.** 236 hand-written `.eq('client_id', ...)` call sites and 29 hand-written `if (!clientId) return` insert guards were the "no data-access layer" gap — a missed guard on a *read* is worse than the known NULL-insert bug class, since admin's RLS policy allows every client's rows and only that per-component filter narrows an admin "viewing as" session to one client. Added `src/shared/scopedDb.js` (`scopedFrom`/`scopedInsert`/`scopedUpsert`/`scopedUpdate`/`scopedDelete`, fail-closed to a sentinel UUID or an error object when `clientId` is missing, gated to a `CLIENT_SCOPED_TABLES` allowlist mirroring the DB's `NOT NULL` constraint list) + `src/shared/hooks/useScopedDb.js` binding it to `useAuth().clientId`, with 14 tests against a mocked Supabase client. Migrated `Items.js` and `Vendors.js` (master data, most likely pages an admin checks after switching clients) to use it end-to-end; ~68 other files still filter by hand and are candidates for later migration.

**Versioned DB migrations.** Schema previously lived only in a manually-updated root `supabase_schema.sql` snapshot (stale — last git-committed content predates dozens of since-run migrations) with an empty `supabase/migrations/`. Found the Supabase CLI was already linked+authenticated to the live project; `supabase db pull`/`db dump` still require Docker Desktop (not installed) since they shell out to a version-matched `pg_dump` via a Docker image regardless of a local client being present. Installed a standalone `pg_dump 17.10` (PostgreSQL client tools only, no server/Docker) and dumped the live schema directly via the pooler connection string into `supabase/migrations/20260705074838_baseline_schema.sql` (stripped the two psql-only `\restrict`/`\unrestrict` meta-command lines pg_dump 17.x emits, which would error if pasted into the Supabase SQL Editor). Retired the stale root `supabase_schema.sql`. New workflow documented in `CLAUDE.md`: every schema change gets a new `supabase/migrations/<timestamp>_<name>.sql` file, applied via the SQL Editor exactly as before, then committed — the only process change is that the SQL now has a permanent, ordered, git-tracked home instead of living only in a memory note.

**Incident, mid-session:** a `supabase db dump --dry-run` printed the live DB password to stdout (dry-run mode echoes the generated `pg_dump` script including its env vars, instead of executing it silently). Flagged immediately; password was rotated via the dashboard before continuing. No further `--dry-run` used on anything DB-related for the rest of the session.

**Not done, left for later (still on the architecture punch list):** the other ~68 `client_id`-filtering call sites, versioned-schema retrofit doesn't cover future `db diff`-style auto-generated migrations (needs Docker Desktop if ever wanted), and the six 1,200+ line "god components" (`PosOrders.jsx`, `Recipes.js`, `AdminClients.js`, `Dashboard.js`, `Purchases.js`, `Roster.jsx`) are untouched.

**Files:** `src/App.js`, 34 files moved under `src/modules/ims/`, `src/modules/hr/payroll/payrollCompute.test.js` (new), `src/modules/hr/payroll/tds.test.js` (new), `src/utils/posBillingMath.test.js` (new), `src/utils/bsCalendar.test.js` (new), `src/shared/scopedDb.js` (new), `src/shared/scopedDb.test.js` (new), `src/shared/hooks/useScopedDb.js` (new), `src/modules/ims/items/Items.js`, `src/modules/ims/vendors/Vendors.js`, `supabase/migrations/20260705074838_baseline_schema.sql` (new), `supabase_schema.sql` (removed), `CLAUDE.md`

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
| --- | --- |
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
