# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Commands

```bash
npm start          # Dev server → http://localhost:3000
npm run build      # Production build (use CI=true npm run build to treat warnings as errors)
npm test           # Jest watch mode
```

No custom linting scripts — ESLint runs via `react-scripts`. Build warnings are non-blocking in dev but fail CI when `CI=true`.

---

## Stack

- **React 19 (CRA)** — no Vite, no custom webpack config, no TypeScript
- **Supabase JS v2** — single client at `src/supabaseClient.js`; anon key only in the browser bundle
- **Recharts** for charts, **SheetJS (xlsx)** for Excel exports
- **React Router v7** — all routes in `src/App.js`
- **Code splitting (S440)** — every page component in `App.js` is route-level `React.lazy(() => import(...))`; only structural pieces stay eager (contexts, `Layout`, `ProtectedRoute`, `ModuleGate`/`PremiumGate`). Keep new page routes lazy too. Two `Suspense` boundaries: one around `Layout.js`'s `<Outlet />` (so the sidebar persists during in-app navigation — only the content area shows `RouteFallback`) and a top-level one in `App.js` for the public routes. Any `import './x.css'` must stay **above** the lazy `const`s or ESLint's `import/first` fails the CI build. This cut initial JS from ~931 kB → ~165 kB gzipped (the rest lazy-loads as ~97 on-demand chunks)
- **Vercel** for deployment — `vercel.json` sets `no-cache` on `index.html` to prevent CDN serving stale bundles
- **PWA service worker** at `public/service-worker.js` — registered only in production (`src/index.js`). Cache name is `crest-v4`; bump it when breaking CSS/JS changes need cache invalidation

---

## Architecture

### Context providers (wrap the whole app in order)

`ThemeProvider → AuthProvider → SettingsProvider → BrowserRouter`

| Context | File | Purpose |
| --- | --- | --- |
| `ThemeContext` | `src/context/ThemeContext.js` | CSS variable theme engine; 9 presets; persisted to `localStorage` (`crest_theme`) |
| `AuthContext` | `src/context/AuthContext.js` | Session, profile, plan tier, feature flags, module access, admin client-switching |
| `SettingsContext` | `src/context/SettingsContext.js` | Per-client settings + feature flag helpers |

### Access control — two-layer route guard

Every protected route uses both guards stacked:

```jsx
<ModuleGate module="ims">
  <PremiumGate featureKey="recipe_costing" minPlan="growth">
    <Recipes />
  </PremiumGate>
</ModuleGate>
```

- **`ModuleGate`** (`src/components/ModuleGate.js`) — checks `imsEnabled` / `hrEnabled` on the client record; admin always passes
- **`PremiumGate`** (`src/components/PremiumGate.js`) — checks `hasFeature(key)` which respects plan tier first, then individual admin override flags

Plan ranks: `starter (0) < growth (1) < pro (2)`. Keys auto-unlocked by plan live in `STARTER_KEYS`, `GROWTH_KEYS`, `PRO_KEYS` sets in `AuthContext.js`. Admin can grant individual features above the plan tier via `feature_flags` table.

**`SuiteGate`** (`src/components/SuiteGate.js`, added S317 for Owner Dashboard) is a third gate type on a genuinely separate axis: `clients.suite_plan` (the Crest Suite bundle tier — IMS+HR+POS together — nullable, with no free-default tier unlike `hr_plan`/`pos_plan`). It differs from `ModuleGate`/`PremiumGate` in one important way: **it never redirects on failure** — an ineligible viewer sees an inline upsell/explanation rendered in place, since the feature's nav entry must stay visible regardless of eligibility. Used as an in-page wrapper inside the gated component, not at the route level. Reach for this pattern only for a genuinely cross-module/bundle-tier feature; a single-module feature still wants `ModuleGate` + `PremiumGate`. Takes a `requireModules` prop (array, default `['ims','hr']` — Owner Dashboard's original, unchanged behavior) added S434 for the Monthly Owner/Manager Report, which only hard-requires `['ims']` and adapts its own sections for whichever of HR/POS are actually present beyond that — don't assume every `SuiteGate` caller needs the same module set Owner Dashboard does.

### Three dashboards, deliberately not one (as of S330 analysis)

A client with 2+ modules sees three separate dashboard destinations, each a different altitude and gate — don't merge them without re-reading this:

- **`/dashboard`** (`ClientDashboard.jsx`, universal, no plan gate) — the "quick glance" one. Already merges IMS/HR/POS sections onto a single page when `clientModules.{ims,hr,pos}` says 2+ are enabled (a `moduleHeader()` per section). S438 first shipped this as **weighted** columns (IMS 1.5fr vs HR/POS 1fr each); live feedback reversed that call for this specific page — three peer modules coexisting for whichever combination a client bought reads differently than a single-purpose executive dashboard, so **S439 made the columns equal** (`.dash-3col-*` in `Layout.css`, all `1fr`) and instead trimmed *card count*: at 2+ modules (`showModuleHeaders`), IMS's top row drops from 11 cards to 5 "money" pills (Net Purchases, Revenue, Food Cost%, Net Margin%, Wastage Value) matching HR's 4 / POS's 4, while the other 6 IMS cards (Active Period, Items, Vendors, Recipes, Menu Health, Fixed Costs%) plus all charts/tables render full-width *below* the equal-width grid instead of squeezed into a narrow column — `imsChartsAndTables` and the individual card JSX are extracted into variables in `ClientDashboard.jsx` so the exact same elements compose into either this split layout or the original untouched single-column arrangement a 1-module client still gets. HR's "Approvals-lite" card (Leave/OT/TADA/Swap pending counts) sources from the shared `useHrApprovalCounts` hook (`src/modules/hr/dashboard/useHrApprovalCounts.js`) so it and the real HR console (`HrDashboard.jsx`'s Approvals row) read one query instead of two independently-drifting copies. The Category × Day sales pivot (`PivotTable`, `src/components/PivotTable.jsx`; data via `useSalesPivotData.js`, `src/modules/dashboard/`) was originally either/or (POS pivot replacing the manual one) — S439 made both render side by side in a shared full-width "Sales Breakdown" section instead (`SalesPivot` now takes a `title` prop: "Manual Sales by Category" / "POS Sales by Category"), since a client can carry real revenue on both and the two were never meant to tie out anyway (same philosophy as the Owner/Manager Report's POS section below). This required `loadFromSalesEntries` (in `useSalesPivotData.js`) to additionally exclude `source:'pos'` rows — a POS-enabled client's `sales_entries` already contains POS-stamped rows (`PosOrders.jsx`'s convention, noted above), so showing both pivots together would otherwise double-count that revenue. Same section also has a **Food vs Beverage split** (`useFoodBeverageSplit.js` + `FoodBeverageSplit.jsx`, both `src/modules/dashboard/`) bucketing combined manual+POS revenue by exact match against `recipes.category` (`'Food'`/`'Beverage'`/else-`'Other'`, excluding `'Sub-Recipe'`) — legitimate because Recipes.js constrains that field to a real `<select>` (`recipeCategories`, client-customizable but defaults to `['Food','Beverage','Dessert','Snack','Other']`), not free text. Kitchen/bar `pos_team` accounts get none of the Sales Breakdown content (no use for a revenue breakdown).
- **`/hr/dashboard`** (`HrDashboard.jsx`, `ModuleGate` only) — the operational HR console: an **Approvals** row (Leave/OT/TADA/Swap pending counts, S330) plus queue tables you act on directly, SSF breakdown, advances. This is a working tool, not a glance.
- **`/owner-dashboard`** (`OwnerDashboard.jsx`, `SuiteGate` at Growth+) — the strategic cross-module view: margin%, labor cost% (needs HR wage data + IMS revenue together, computed nowhere else). IMS+HR only so far; POS integration is an explicit Phase 2.

A related but distinct artifact, not a fourth dashboard: **`/owner-report`** (`MonthlyOwnerReport.jsx`, `SuiteGate` with `requireModules={['ims']}`) — see "Monthly Owner/Manager Report" below. Where all three above are always live (re-query on every load, reflect the currently-open period), this one is a **frozen snapshot** captured once when a period *closes* and never recomputed afterward, even if the underlying data is later corrected in place.

### Monthly Owner/Manager Report (frozen snapshot, added S434)

`monthly_owner_reports` (one row per `client_id`+`period_id`, `UNIQUE` constraint enforces it) stores a `snapshot` jsonb captured at generation time — combined IMS + HR + POS figures for a closed period, computed by `src/modules/ownerReport/computeMonthlyReport.js` and written by `generateMonthlyReport.js`. Auto-generation only ever `INSERT`s (a repeat attempt 23505s and is swallowed); the only overwrite path is an explicit admin "Regenerate Snapshot" button on the report page, which always confirms first. RLS blocks every staff-account type regardless of module rank (same `no_self_service_accounts`/`no_pos_pin_staff`/`no_ims_staff`/`no_hr_role_staff` RESTRICTIVE pattern as the codebase's other sensitive tables) — this table carries HR payroll/headcount detail alongside IMS/POS financials, owner/admin only.

Generation is triggered from all three period-closing call sites in `Periods.js` (`closeAndAdvance`, `adminCloseAndAdvance`, `adminEndPeriod`) as a best-effort, non-blocking step (try/catch, `console.error` only) — report generation must never prevent the period itself from actually closing. The safety net for a failed/pre-existing-period generation is `MonthlyOwnerReport.jsx` lazily generating-and-caching a snapshot on first view of any closed period that doesn't have one yet.

Two figures are deliberately redefined from Owner Dashboard's live formulas, both because a frozen artifact needs period-bound facts rather than live ones: Payables is "this period's Credit purchases still unpaid as of generation" (not Owner Dashboard's live ">60 days overdue, any period" figure, which would drift once time passes after generation); labor cost needs no "days elapsed so far" proration since a closed period is fully elapsed by construction. The POS section is genuinely new (Owner Dashboard's own POS integration is still an explicit deferred Phase 2) and has its own gotcha: `pos_orders` has no `period_id`/BS columns at all, only AD `closed_at` — the BS period must be converted to an AD range (`bsToAd` start/end of month) before querying, matching `SalesReport.jsx`'s own convention. Separately, `sales_entries` already carries POS revenue for POS-enabled clients (`PosOrders.jsx` stamps a `source:'pos'` row per bill at close), so the report's top-line Revenue figure (from `sales_entries`) and its independently-derived POS Net Sales figure (from raw `pos_orders`/`pos_order_items`, different discount/VAT rounding) will never tie out to the penny — that's expected, labeled distinctly in the UI, not a bug to chase.

**Labor cost prefers the actual finalized payroll run over a re-derived estimate, when one exists.** `computeHrSection` checks `hr_payroll_runs` for a `status='finalized'` row on this `period_id` first and sums the real `hr_payslips` (gross/ot_hours/ot_amount/ssf_employer) — the exact Nepal-payroll-engine output (`payrollCompute.js`), including OT from *both* attendance (`hr_attendance.ot_hours`) and approved claims (`hr_overtime_entries`). Only falls back to Owner Dashboard's prorated join/end-date estimate when the period's payroll was never finalized. Found live (S435): the estimate-only version undercounted a real client's payroll by ~13% and showed zero OT entirely, because it only read `hr_overtime_entries` (claims) and never attendance-based OT — the two are genuinely separate OT sources that `computePayslip` sums together but the naive estimate didn't. `snapshot.hr.payrollSource` (`'finalized'` | `'estimated'`) is surfaced in the UI so a reader knows which basis they're looking at. General lesson for any future field added to this report: **resolve foreign-key lookups (like `hr_leave_types.name`) to their display value AT GENERATION TIME**, not the raw id — a frozen snapshot that stores a raw UUID instead of a name is a real bug (shipped once, S435), not just unpolished.

**Any figure that values `items` (Opening/Closing Stock, Wastage Value) must query with `.eq('is_active', true)` first**, matching `Stock.js`'s own Summary tab and `MonthlySummary.js` exactly — sub-recipes stay included (Stock Count counts those too, unlike the `is_sub_recipe` exclusion elsewhere), only inactive items are excluded. Found live (S436): `computeImsSection`'s `items` query had no `is_active` filter, so a leftover `opening_stock` row on a deactivated item inflated Opening Stock Value ~NPR 42 above what Stock Count itself showed for the identical period — caught only by comparing the two pages directly, not by any test or type check.

**S437 3-phase deep-dive expansion** (Menu Engineering, Labor Analytics, Vendor/Purchasing, Inventory Depth, Trend) turned the report from "surface-level" into a full multi-page document, ordered Financial → Menu → Labor → Inventory → Vendor → Trend. Each new section mirrors an existing standalone report page's own formula exactly rather than re-deriving one, so the frozen snapshot always agrees with what that live page would have shown for the same period: Menu Engineering mirrors `MenuEngineering.js`'s `classify()`/`median()`/`FC_CUTOFF=35%` (including zero-sale items in the median) but deliberately skips that page's `recipes.me_class` write-back — a report generator stays read-only. Labor Analytics (Sales per Labor Hour, Scheduled-vs-Actual Hours) is genuinely new: actual hours from `hr_attendance` (period_id-scoped), scheduled hours from `hr_roster` (no `period_id` column — filtered by the period's bs_year/bs_month instead), reusing `shiftHours()`/`calcHours()` from `laborForecast.js` verbatim. Vendor & Purchasing mirrors `VendorReport.js`'s net-spend/discount-dedup/cash-credit-split formulas, with bill aging pinned to a `generatedAt` timestamp captured once at generation — not live `new Date()` like the source page, since a frozen artifact's aging bucket must not keep drifting after the freeze. Inventory Depth is 4 independently try/catch'd sub-sections (Dead/Slow Stock mirroring `DeadStock.js`; a new pure-function Turnover Ratio/Days-on-Hand built entirely from figures the IMS section already computed, no new queries; item-level Theoretical-vs-Actual Variance mirroring `Variance.js`, exposing a theoretical-usage map the IMS section already built internally but never surfaced; Shrinkage Trend adapted from `ShrinkageReport.js` into a trailing 6-period window ending at the report's own period). Trend compares this period against its own already-frozen `monthly_owner_reports` rows for last-period and same-month-last-year — reads prior snapshots directly rather than re-deriving, and never auto-generates a missing prior snapshot as a side effect.

The orchestrator (`computeMonthlyReport.js`) used to `Promise.all` every section flat, so one section throwing meant no report got written at all for the period. Every section — including the original IMS/HR/POS — now runs through a `runSection(key, fn, errors)` wrapper that degrades a failed section to `null` plus a `snapshot.sectionErrors[key]` entry instead, so the rest of the report and the row write still succeed; the page shows a dismissible "couldn't be generated" note per missing section. `schema_version` is now `CURRENT_SCHEMA_VERSION` (bumped to `2`, exported instead of a duplicated hardcoded `1`) — no migration tooling needed, since every existing read already uses optional chaining and treats new fields as absent on old snapshots. Print CSS is real multi-page pagination (`page-break-inside:avoid` on sections/tables) rather than the original 1-page aggressive shrink.

No PDF library exists in this codebase (nor is one added for this) — "Print / Save as PDF" reuses the existing `printWithTitle()` browser-print mechanism already used by every bill/credit-note/KOT.

### Multi-tenant data isolation

Every Supabase table is client-scoped. **Use the scoped data-access layer, not hand-written `.eq('client_id', ...)`:**

```js
import { useScopedDb } from '../../../shared/hooks/useScopedDb'

const { scopedFrom, scopedInsert, scopedUpsert, scopedUpdate, scopedDelete } = useScopedDb()

const { data } = await scopedFrom('items', 'id, name').eq('is_active', true)
await scopedInsert('vendors', { name: 'Big Mart' })                    // stamps client_id
await scopedInsert('categories', { name: 'Dairy' }, { single: true })  // .insert().select().single()
await scopedUpsert('hr_roster', rows, { onConflict: '...' })           // always selects the row(s) back
await scopedUpdate('items', { is_active: false }).eq('id', itemId)
await scopedDelete('vendors').eq('id', vendorId)
```

`src/shared/scopedDb.js` fails closed (a sentinel UUID on reads/updates/deletes, an error object on inserts/upserts) when `clientId` is missing, instead of silently running unfiltered or leaking a NULL row — this matters most on **reads**, since an admin's RLS policy (`role='admin' OR client_id=own`) allows every tenant's rows and only the per-query filter narrows an admin "viewing as" session down to one client. Only tables in the `CLIENT_SCOPED_TABLES` allowlist (mirrors the DB's `client_id NOT NULL` constraints) can go through it — `scopedDb` throws for anything else. Tables scoped by `period_id`/parent-id instead of `client_id` (`purchase_entries`, `sales_entries`, `recipe_ingredients`, `opening_stock`, `closing_stock`, `wastages`, `staff_meals`, etc.), tables with a nullable `client_id` (`settings`, `budgets`), and the `clients` table itself stay on raw `supabase.from()`.

`clientId` in `AuthContext` (and thus in `useScopedDb()`) resolves as:

- Admin: `adminViewClientId` (from `localStorage`; set when admin "views as" a client)
- Client user: `profile.client_id`

Admin switches clients via the sidebar dropdown → `switchAdminClient(id, name)` → all pages re-fetch via `useEffect([clientId, ...])`.

As of 2026-07-05, every IMS, HR, and POS page, plus `Dashboard.js`, `Periods.js`, and `Settings.js`, is migrated to `scopedDb`. Two pages are correctly exempt, not pending: `AuditLog.js` (a cross-client admin viewer — `audit_logs.client_id` is nullable and its own "All Clients" filter is incompatible with auto-scoping to one client) and `AdminClients.js` (has no `clientId` of its own — it loops over an explicit client list and acts on whichever `client.id` a row targets, so it calls the raw `scopedFrom`/`scopedInsert`/`scopedUpdate`/`scopedDelete` functions from `scopedDb.js` directly with that `client.id`, instead of the `useScopedDb()` hook). `Periods.js`'s admin "all clients" view and `Dashboard.js`'s `loadAdminStats()` use the same raw-function-with-explicit-id pattern for their per-client actions, while their genuinely cross-tenant reads (no single client to scope to) stay on plain `supabase.from()`.

### Modules

The app is one React app / one Supabase project with three modules toggled by per-client flags on the `clients` table:

| Flag | Column | Default |
| --- | --- | --- |
| Crest IMS | `ims_enabled` | `true` |
| Crest HR | `hr_enabled` | `false` |
| Crest POS | `pos_enabled` | `false` (real column, added S193) |

`clientModules` in `AuthContext` drives **display** (sidebar + dashboard sections). `imsEnabled` / `hrEnabled` drive **route access** (admin bypasses both).

### Staff role systems (POS / IMS / HR)

Three independent rank axes on `profiles` — `pos_role`, `ims_role`, `hr_role` (each `staff|supervisor|manager`, `NULL` = no access to that module at all) — checked via `hasPosAccess(minLevel)` / `hasImsAccess(minLevel)` / `hasHrAccess(minLevel)` in `AuthContext.js` (`POS_RANK`/`IMS_RANK`/`HR_RANK`, identical `{staff:1,supervisor:2,manager:3}` shape, deliberately mirrored — IMS copied POS's shape at S417, HR copied IMS's at S430). A staff account having one of these set implies nothing about the other two — a POS PIN account with no `ims_role` is correctly blocked from every IMS page. Admin/Owner always resolve to `'manager'` on all three; `isOwner` is a **negative** test (`role==='client'` with none of `pos_role`/`ims_role`/`hr_role`/`hr_self_service` set) — assigning any one of these to an account deliberately demotes it out of Owner-level access, so a new staff-account marker must be added to every `isOwner`/`isCallerOwner` computation (`AuthContext.js` and `admin-user-ops/index.ts` both) or it silently breaks Owner detection for every other marker.

Each axis gates two things that must both be kept in sync when adding a page: the **route guard** (`if (!hasXAccess(minLevel)) return <Navigate to="/dashboard" replace />` inside the page component itself) and **nav visibility** (a `minPosRole`/`minImsRole`/`minHrRole` tag on the `Layout.js` nav item, read by the shared `isItemVisible()` predicate that also drives the command palette and pinned favorites). A page with one but not the other is either unreachable-but-still-linked, or reachable-but-hidden — a dashboard/summary page that's the redirect *target* of a guard is the easiest place to miss this, since it's tempting to assume the redirect target is inherently safe (see S430's dashboard leak in the README session log, where the redirect target itself leaked the data every other page was gated to protect).

`pos_team` (`foh|kitchen|bar`, default `foh`, added S431) is a separate, **orthogonal** axis on `profiles` — which physical station a POS account works, independent of `pos_role`'s rank (a kitchen-team account can be Staff or Manager rank; the team axis only changes what's in its nav, not what its rank permits). Gated by an explicit allowlist (`Layout.js`'s `KITCHEN_TEAM_ALLOWED_PATHS`) rather than per-item tags — fail-closed, so a newly-added POS page is hidden from kitchen/bar by default until someone deliberately adds it to the list. `KitchenDisplay.jsx` additionally uses it to lock the KOT/BOT ticket-station toggle (not the same "station" concept — `pos_kot_log.station` is the ticket's printer routing, unrelated to the staff `pos_team` column) to the account's own queue.

### Splitting a page component once it outgrows one file

As of 2026-07-06, the six pages that had grown past 1,200 lines (`AdminClients.js`, `Roster.jsx`, `Dashboard.js`, `Purchases.js`, `Recipes.js`, `PosOrders.jsx`) were each split, using whichever of these fits what's actually inside — don't force a pattern that doesn't match:

- **Already-self-contained sub-component sitting in the same file** (a modal or panel with its own local state, just not in its own file yet) → move it verbatim into a same-name subfolder (e.g. `src/pages/adminClients/ClientDrawer.js`). Pure relocation, no behavior change — a near-identical production bundle hash is the sanity check.
- **One file secretly rendering two unrelated views behind a boolean** (e.g. `Dashboard.js`'s admin-overview vs. per-client view, sharing almost no state) → split along that boolean into two components, each with its own `useAuth()`/data loading, and leave the original file as a thin router.
- **Genuinely tangled state with no existing seam** (e.g. `Purchases.js`'s bill-entry form, `Recipes.js`'s nutrition editor) → extract a new self-contained component that owns its own form state and reports back through a single `onSaved(...)`/`onChanged()` callback, rather than lifting the state up and prop-threading it.
- **Pure HTML/string builders that close over component state** (receipt/KOT print templates) → parameterize them explicitly and move to a plain `.js` file (see `posOrderPrintHtml.js`, `creditNoteHtml.js`) so the same builder can back both the real print path and a live preview without duplicating logic.

For a high-traffic, stateful screen (`PosOrders.jsx` — live order-taking, billing, offline sync), prefer the smallest safe cut (pure builders/constants only) over a full architectural split — the risk of a subtle real-time bug that only surfaces on a live device outweighs the line-count win.

### Bikram Sambat (BS) calendar

All periods and dates in the app use the Nepali calendar. Key utilities in `src/utils/bsCalendar.js`:

- `bsToAd(year, month, day)` → JS Date
- `adToBs(date)` → `{ year, month, day }`
- `daysInBsMonth(year, month)` — each BS month has a different number of days (28–32); never assume 30
- `getBsToday()` → current BS date
- Nepal fiscal year runs **Shrawan (month 4) → Ashadh (month 3)** of the following BS year

The lookup table covers BS 2079–2087. Out-of-range years fall back to a 30-day approximation.

### HR payroll engine (pure functions)

`src/modules/hr/payroll/payrollCompute.js` — no React, no Supabase. Three pay bases: `monthly`, `daily`, `hourly`.

`src/modules/hr/payroll/tds.js` — Nepal income-tax TDS via YTD cumulative projection. FY 2083/84 slabs apply from Shrawan 2083 onwards. SSF contributors have the 1% first slab waived.

Constants in `src/modules/hr/payrollConstants.js`: SSF rates (11% employee / 20% employer), SSF cap (NPR 100,000 basic), OT multiplier (1.5×).

---

## Design conventions

### Design context (PRODUCT.md / DESIGN.md)

`PRODUCT.md` (strategic: users, positioning, brand personality, anti-references) and `DESIGN.md` (visual: colors, typography, components, extracted from the actual `Layout.css`/`ThemeContext.js` tokens) exist at the project root, written by the `impeccable` skill's `init`/`document` commands. Read them before any design-focused work — `DESIGN.md` in particular documents named rules (the accent-text pairing rule, the one-accent rule, flat-by-default elevation) that are already enforced in code but weren't written down anywhere before this. `.impeccable/design.json` is the machine-readable sidecar; don't hand-edit it, regenerate via `/impeccable document`.

### CSS variable theme system

All colors must use CSS variables, not hardcoded hex. The full token set:

```text
--theme-bg          --theme-card        --theme-border      --theme-border-lt
--theme-text1       --theme-text2       --theme-text3
--theme-accent      --theme-green       --theme-red         --theme-amber       --theme-purple
--theme-sidebar     --theme-input-bg    --theme-table-hover --theme-focus-ring
```

`--theme-purple` (added during the UI/UX audit pass) is for a genuine 4th/5th categorical color — e.g. Staff Meals in Stock.js/MonthlySummary.js, the sub-recipe tab underline in Recipes.js — that several files had previously hardcoded independently as the same violet hex with no shared source of truth. It is not a general-purpose semantic color like green/red/amber; reach for it only when a page already needs a distinct categorical hue beyond what accent/green/red/amber cover.

**Exception:** Recharts SVG props (`fill`, `stroke`, `tick`) must stay as literal hex — CSS `var()` does not resolve inside SVG presentation attributes.

Shape and type have their own token sets at the top of `Layout.css`: `--radius-sm|md|lg|xl|full` (8/12/18/24/999px) and `--font-size-rail-icon|brand|nav-icon|nav-item|group-label|micro|chevron`. Both scales are **closed sets** — DESIGN.md's frontmatter is the source of truth for which steps exist, and the `/impeccable` hook flags any literal off those scales. If a genuinely new step is needed, add it to DESIGN.md first, then use it.

**Alpha tints must be an rgba() of a documented color, not a near-miss.** The codebase's convention is a literal `rgba(201,168,76,0.35)`-style tint rather than `color-mix()`; the hook resolves those back to the palette, so `rgba(248,113,113,…)` (signal-danger) passes while `rgba(220,38,38,…)` (a second, undocumented red) is flagged as drift. Two named traps, both of which shipped as real bugs and were fixed in S424: **a solid signal-color fill needs a paired foreground token, and only `--theme-accent` has one** (`--theme-accent-text`). `--theme-red` ranges from light (`#f87171` Dark) to dark (`#dc2626` Bright) across the ten presets, so no single foreground contrasts on all of them — use DESIGN.md's tint pattern (alpha fill + full-opacity signal text) for red/amber/green instead of a solid fill. And **`rgba(255,255,255,…)` as a "slightly brighter border" is invisible on the five light presets** — step the border to the accent at low alpha instead.

### Component library (reusable)

| Component | File | Notes |
| --- | --- | --- |
| `Tip` | `src/components/Tip.js` | Hover tooltip using `createPortal` — escapes `overflow:hidden` containers. All non-obvious columns and form labels must have one. |
| `SearchableSelect` | `src/components/SearchableSelect.js` | Drop-in for long `<select>` lists. `position:fixed` dropdown never clips inside modals. Flips above the trigger near the bottom of the viewport. |
| `Fab` | `src/components/Fab.js` | Fixed bottom-right `+ Add` button |
| `Modal` | `src/components/Modal.js` | Centered overlay with backdrop-click close |
| `BsCalendarPicker` | `src/components/BsCalendarPicker.js` | BS year/month/day picker, calendar-grid UI |
| `QtyInput` | `src/components/QtyInput.js` | Numeric field that also accepts arithmetic (`3*24+7` → `79`). Use for any qty/rate box. Takes `onChange` (fires live for plain numbers) + `onCommit` (fires on blur/Enter with the evaluated number), and a `wrapperStyle` for the positioning span the result badge anchors to. **The raw expression never leaves the component** — the parent only ever receives a number or `''`. |
| `Calculator` | `src/components/Calculator.js` | App-wide Quick Calculator modal (Alt+C), mounted once in `Layout.js`. Import it aliased — `Calculator` is also a lucide icon name. |
| `ModuleGate` | `src/components/ModuleGate.js` | Module-level route guard |
| `PremiumGate` | `src/components/PremiumGate.js` | Plan/feature-level route guard |

### Class names

Use these global classes from `Layout.css` — don't repeat inline styles:

- `data-table` — styled table
- `table-wrap` — horizontal scroll wrapper (required on all wide tables)
- `tab-btn` / `tab-btn--active` / `tab-bar` — pill filter/sort buttons
- `form-select` — styled `<select>`
- `stat-grid` — horizontal KPI card row
- `btn`, `btn-ghost`, `btn-primary` — button variants
- `badge-green`, `badge-red`, `badge-amber`, `badge-gold`, `badge-gray` — status chips
- `no-print` / `print-only` — print visibility

### Every `type="password"` input needs an explicit `autoComplete`

Without one, Chrome guesses from `type` + surrounding context — and any `type="password"` field anywhere on the page makes it treat the nearest preceding text input as a login username, which has bled a saved login into unrelated fields (a `SearchableSelect` search box, a signup form) more than once (S329). Use `autoComplete="new-password"` on every PIN/account-creation field (POS Staff Add/Reset PIN, Enable Self-Service, trial signup), and `autoComplete="username"` / `"current-password"` on an actual sign-in form's email/password. PIN-pad login screens (POS/HR Self-Service) build their own keypad UI rather than a text input, so they're unaffected.

### Arithmetic in input fields

`src/utils/evalMath.js` is the single evaluator behind both `QtyInput` and the Quick Calculator. It is a hand-written recursive-descent parser, **never `eval()` / `new Function()`** — these are inputs where a pasted string reaches the evaluator directly, and the grammar (`expr → term → factor`, supporting `+ - * / ( )`, unary minus, `×`/`÷` glyphs and comma separators) can only ever produce a number. It also keeps working under a strict CSP. `evaluate()` returns `null` for anything malformed — including division by zero, so `Infinity` can never reach a saved quantity — and every caller reads `null` as "not an expression, leave the user's input alone" rather than as an error to surface. `looksLikeExpression()` gates the whole deferred-commit path: a plain `146` or a leading-minus `-5` is not an expression and must keep behaving exactly as a bare `<input type="number">` did.

### Purchases: qty/rate storage convention

`purchase_entries.qty` and `rate` are stored in **base units**, not purchase units:

- `stored_qty = entered_qty × conversion_factor`
- `stored_rate = entered_rate ÷ conversion_factor`

All downstream calculations (Stock, Variance, FIFO, Reorder) read these base-unit values directly.

### `recipe_ingredients` has no `client_id` column

Always scope ingredient fetches by recipe IDs first:

```js
const recipeIds = recipes.map(r => r.id)
supabase.from('recipe_ingredients').select('*').in('recipe_id', recipeIds)
```

### Sub-recipe mirror items

Recipes with `type = 'sub_recipe'` auto-create a mirror row in `items` with `is_sub_recipe = true`. Filter these out of Item Master, Purchases, POs, Requisitions, Reorder Report, and Supplier Price Tracker:

```js
.eq('is_sub_recipe', false)
```

---

## When adding a new feature

1. **Feature flag**: add a boolean column to `feature_flags` table, add the key to the correct tier set in `AuthContext.js` (`STARTER_KEYS` / `GROWTH_KEYS` / `PRO_KEYS`), add to `DEFAULT_FLAGS` in `SettingsContext.js`, and add to the matching group in `AdminClients.js`.
2. **Route**: wrap with `<ModuleGate module="ims">` + `<PremiumGate featureKey="..." minPlan="...">` in `App.js`.
3. **Nav**: add an entry to `NAV` or `REPORTS` in `Layout.js` with `featureKey` and `minPlan`.
4. **Tooltips**: every non-obvious column header and form label needs a `<Tip>` tooltip.
5. **Help page**: add an entry to `src/pages/Help.js`.
6. **README**: update both `C:\crest-suite\README.md` and `E:\CREST SUITE MANAGEMENT\README.md`.
7. **Danger Zone**: if the feature adds a new client-scoped table (a `client_id` column, directly or via a parent it cascades from), add it to `clearModuleData` and `deleteClientData` in `supabase/functions/admin-user-ops/index.ts`, then `supabase functions deploy admin-user-ops`. These two actions back the Admin → Danger Zone "Clear X Transactions"/"Clear Client Data"/"Delete Client" buttons; a table left out isn't just stale data left behind — most of these FKs default to `NO ACTION` (no cascade), so the button throws a foreign-key violation and aborts mid-sequence the first time a client actually has a row in the missed table (found live, S382, via `pos_credit_notes`). Check for **reverse** FKs too, not just the new table's own `client_id`/parent FK — `pos_orders.credit_note_id → pos_credit_notes.id` is a circular reference in the opposite direction that a table-by-table read-through missed; it only surfaced as a real error when tested against a client with an actual credit note.

---

## Supabase / DB notes

- RLS is enabled on all 18+ tables. The standard policy pattern uses an inline subquery:

  ```sql
  (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid())
  ```

- Admin operations that need the service role key go through the Supabase Edge Function `admin-user-ops` (deployed at `supabase/functions/admin-user-ops/`). Never put `SUPABASE_SERVICE_ROLE_KEY` in the frontend bundle.
- Real Web Push (Roster publish + shift-swap notifications) is sent from the Edge Function `hr-push` (`supabase/functions/hr-push/`) — the only place holding the VAPID private key (`VAPID_PRIVATE_KEY` secret; the public half is `REACT_APP_VAPID_PUBLIC_KEY`, safe to expose). `src/utils/webPush.js` handles the frontend subscribe flow, including the iOS Safari quirk where the Push API is only available to a page added to the Home Screen, never a regular tab.
- `profiles` itself is the one table that does **not** follow the standard same-client pattern above — `profiles_select` RLS is self-or-admin only (`id = auth.uid() OR is_admin()`). A raw `supabase.from('profiles').eq('client_id', ...)` query, run by a real (non-admin) client login, silently returns nothing but the caller's own row. To resolve another staff member's name (closed_by/comped_by/sent_by/etc.), call the `get_client_profile_names(p_client_id)` RPC (all profiles for that client) or `get_pos_staff_list(p_client_id)` (PIN-based POS staff only, excludes the Owner — used by Staff Management specifically). Never a raw `profiles` query for anyone but the caller's own row.
- **Staff accounts are same-client at the RLS level** — POS PIN staff (`pos_email IS NOT NULL`), IMS staff (`ims_role IS NOT NULL`), HR staff (`hr_role IS NOT NULL`), and HR self-service accounts (`hr_self_service = true`) all share `role='client'` + `client_id` with the owner, so the standard admin-or-same-client policy alone gives any of them owner-level data access. S316 (`20260708130000_staff_account_business_table_isolation.sql`) fenced off POS/self-service with **RESTRICTIVE** `no_self_service_accounts` / `no_pos_pin_staff` policies per table; S419 added `no_ims_staff` for IMS staff; S430 added `no_hr_role_staff` for HR staff (helpers: `is_hr_self_service()`, `is_pos_pin_staff()`, `is_ims_staff()`, `is_hr_role_staff()`). **When creating a new business table, add it to every matching restrictive-policy list** — a new table doesn't inherit the exclusions, and a bare same-client policy re-opens the hole for whichever staff-account type's JWT touches it.
- **`profiles.hr_employee_id`** links a login to an `hr_employees` record — originally written only by HR Self-Service (`create_hr_self_service_login`), and as of S328 also optionally written by `create_pos_staff` (POS Staff's "+ Add Staff" → HR Employee mode) so a client running both HR and POS doesn't have to enter the same person twice under two different names. A partial unique index (`profiles_hr_employee_pos_unique` on `hr_employee_id WHERE pos_email IS NOT NULL`) plus an Edge Function check stop the same employee from getting two POS accounts; nothing stops one employee from separately having both a POS account and an HR Self-Service account, since those are different login mechanisms for the same person.
- `per_uom_rate` on `items` is a **generated column** — never include it in INSERT/UPDATE payloads.
- `pos_orders.order_no` is assigned by a **BEFORE INSERT trigger** (per-client sequential) — never set it from the frontend; read it back via `.select('id, order_no')` after insert. Same pattern for `pos_orders.invoice_no` (BEFORE UPDATE, partitioned by `client_id + invoice_fy + close_type`) and `pos_credit_notes.credit_note_no` (BEFORE INSERT, partitioned by `client_id + invoice_fy`) — never set these from the frontend either. Item-level comps (`pos_order_items.comp_no`) share the **same NC-series** as a whole-order Complimentary Slip — the frontend calls `get_next_pos_comp_slip_no(client_id, fy)` RPC once per Charge action (one number per comp event, not per line) and passes the result in explicitly; `assign_pos_invoice_no()`'s `close_type='writeoff'` branch locks on and considers that same pool, so the two paths can never collide.
- The offline stock count (and POS order-taking) uses IndexedDB (`src/utils/offlineQueue.js`, DB name `crest-offline`) with 10 object stores. Sync flushes automatically on reconnect. **Any read-modify-write on an offline store must happen inside a single `readwrite` transaction** (get + merge + put together), never a readonly get followed by a separate readwrite put — IndexedDB only serialises *overlapping readwrite* transactions on a store, so the two-transaction shape lets concurrent callers read the same pre-image and clobber each other's write. This was a real bug (S440): `saveOrder` fires `logKotSend('KOT')` + `logKotSend('BOT')` un-awaited, both routing through `enqueuePosOrder`, which silently dropped one station's queued KOT send offline until the merge was made atomic. POS billing is hard-gated offline (`payDisabled` includes `!isOnline`), so the offline surface is order-taking only — no money path is ever reachable without a live server.
- `settings` was, until S290 (`20260707150000_settings_rls_same_client_write.sql`), the one client-scoped table whose INSERT/UPDATE RLS policies were **admin-only** with no same-client allowance — every settings-writing tab in `PosTableManagement.jsx` (Discounts, Quick Notes, Ticket Routing, Delivery Partners) had been silently no-op'ing for any real (non-admin) client login, since an RLS-blocked write returns zero rows changed with no error rather than throwing. Now follows the standard `is_admin() OR client_id = my_client_id()` pattern like every other table; the `client_id IS NULL` global-defaults row (`app_name`, `app_tagline`, etc.) stays admin-only automatically since a real client's `client_id` can never equal `NULL`. Still stays on raw `supabase.from()` rather than `scopedDb` (see the `scopedDb` note above) — that's about the nullable `client_id`, unrelated to this RLS fix.
- **Public, unauthenticated routes** (a page with no login at all — `/pos/login`, `/pos/menu/:tableId`) can't gate data access through `profiles`/`auth.uid()` the normal way, since there's no session. The established pattern: a plain SQL or PL/pgSQL function, **always `SECURITY DEFINER`** (an anonymous caller has no RLS-passing identity at all, so even a function reading "already-public-by-design" data needs it), callable by the `anon` role via Postgres's default PUBLIC-execute grant. The function itself does whatever authorization makes sense for that page (e.g. `get_guest_menu` resolves table → client → checks `pos_enabled`) and returns only deliberately whitelisted columns — never a full row, never anything from a sales/orders table. Anonymous callers hitting an internal helper function directly (bypassing the public entry point) are still blocked by that helper's own RLS as long as the helper isn't itself `SECURITY DEFINER`. A 2026-07-12 Security Advisor pass also found the `anon` PUBLIC-execute grant had never been revoked from 22 other `SECURITY DEFINER` functions that are meant for authenticated sessions only (most already had the standard caller check below, so this was defense-in-depth, not an active hole) — see `20260712210000_security_advisor_anon_execute_hardening.sql`. **`get_pos_staff` used to be the one exception with genuinely no internal auth check at all** — it read `profiles` (whose `profiles_select` RLS is self-or-admin-only per the note above, so a non-`SECURITY DEFINER` version would've returned zero rows) and trusted whatever `p_client_id` the frontend passed in, sourced from a plain, unverified `localStorage` value written once at device activation. S372 (2026-07-13) found this let anyone who set `localStorage['pos_device_client_id']` to a guessed/obtained client UUID pull that client's full staff roster (names + emails) from an anonymous browser — fixed by adding `clients.pos_device_secret` (an unguessable per-client value, migration `20260713010859_pos_device_secret_hardening.sql`) as a required second parameter, fetched by `Pos.js` only from an authenticated session and verified server-side inside the function before returning any rows.
- **Every `SECURITY DEFINER` function meant for a *logged-in* caller (not the public/anon case above) must check the caller itself** — `SECURITY DEFINER` bypasses RLS entirely, so skipping this check isn't "relying on RLS as a backstop," it's no check at all. The standard shape, used by `apply_pos_item_comps`/`get_pos_staff_list`/`get_client_profile_names`/`get_cooccurrence`/`get_next_pos_comp_slip_no`: `IF NOT (public.is_admin() OR p_client_id = (SELECT client_id FROM profiles WHERE id = auth.uid())) THEN RAISE EXCEPTION ...`. A Security Advisor pass (S293, 2026-07-07) found two functions shipped without it — `admin_clear_audit_logs` (zero check at all; any authenticated user could wipe every client's audit log — the `adminOnly` frontend route guard on `AuditLog.js` doesn't protect the RPC itself) and `get_cooccurrence` (no caller-matches-`p_client_id` check; leaked any client's item-pairing sales data to any other logged-in user, or even `anon`). Also always set `SET search_path TO 'public'` explicitly on new functions — the Advisor's `function_search_path_mutable` warning is cheap to avoid and was missing on 4 functions as of S293.
- **`monthly_periods` allows at most one `open` period per client** (`monthly_periods_one_open_per_client`, a partial unique index `WHERE status='open'`, added 2026-07-13) — virtually every IMS/HR/Owner Dashboard page assumes this via a plain `.eq('status','open').limit(1).single()` read. Practical consequence: `Periods.js`'s "Reopen" action on a *past* closed period will always fail once a more recent period is open — which is the only realistic time anyone reopens a past period, so always check the update's `error` before treating a reopen as successful (S432, 2026-07-21, found an unhandled case that silently did nothing and gave no indication why). Separately, **admin doesn't need to reopen a period to edit it** — `Stock.js`'s `isLocked = !isAdmin && status==='closed'` (mirrored on every other period-scoped entry page) exempts admin from the read-only lock entirely regardless of status. Reopening only matters for handing edit access back to the *client's own* login; if admin is making the correction personally, editing in place and then re-propagating forward (`Periods.js`'s `carryForwardOpeningStock`, safe to call standalone — it's an idempotent upsert, exposed via the "Resync Opening Stock" action) is the simpler, unblocked path.
- **`REVOKE EXECUTE ... FROM anon` (or any role) is a silent no-op if `PUBLIC` still holds the grant.** Postgres ACLs are additive — a role's effective privilege is its own grants **union** `PUBLIC`'s — so revoking from a role that never had its own separate grant entry changes nothing, with no error to say so. This is exactly what happened to the `20260712210000` migration referenced above: `REVOKE EXECUTE ... FROM anon` ran on all 25 functions, reported success, and **never took effect on a single one** — `has_function_privilege('anon', ..., 'EXECUTE')` still returned `true` a week later. Found 2026-07-20 while re-verifying an unrelated RPC fix, not by the original migration or any test. Fixed in `20260720150000_fix_ineffective_anon_execute_revokes.sql` (functions: `REVOKE ... FROM PUBLIC` then `GRANT ... TO authenticated, service_role` — `service_role` needs the explicit grant too, it is **not** a Postgres superuser in this project, only `rolbypassrls`) and `20260720160000_anon_least_privilege_table_grants.sql` (the identical pattern at the table level: `anon`/`authenticated` both held stray `TRUNCATE`/`REFERENCES`/`TRIGGER` on every table, and `anon` separately held full `SELECT`/`INSERT`/`UPDATE`/`DELETE` on 22 real tables including `profiles`/`clients`/`sales_entries`, safe only because every write policy on them requires `client_id = my_client_id()`). Deliberately left alone: `is_admin()`/`is_hr_self_service()`/`is_pos_pin_staff()`/`my_client_id()` have this same ineffective revoke and were **not** fixed — they're embedded in RLS policies across dozens of tables, and `anon` has a genuine, intentional `SELECT` grant on `settings` for a pre-login `app_name` read gated by a policy that calls `my_client_id()`; tested in a rolled-back transaction that revoking it from `PUBLIC` breaks that read with `permission denied for function my_client_id` even filtered to the safe row, since Postgres doesn't reliably short-circuit past the second `OR` operand once RLS folds into the row filter. **Always verify a revoke actually worked** with `has_function_privilege('anon', 'public.foo(...)', 'EXECUTE')` / `has_table_privilege('anon', 'public.sometable', 'SELECT')` — never trust "Success. No rows returned" from the SQL Editor alone.

### Schema migrations

The Supabase CLI is installed and linked to the live project (`supabase link`, ref in `supabase/.temp/`). `supabase/migrations/` is the source of truth for schema history — a root-level `supabase_schema.sql` snapshot used to serve this purpose and is retired as of the `20260705074838_baseline_schema.sql` migration (a full `pg_dump --schema-only` of the live DB at that point in time).

**Workflow for every schema change:**

1. Create a new file: `supabase/migrations/<YYYYMMDDHHMMSS>_<description>.sql` (or `supabase migration new <description>` to scaffold the filename).
2. Write the SQL in that file.
3. Apply it the normal way — paste it into the Supabase Dashboard → SQL Editor and run it.
4. Commit the file. Never run ad hoc schema SQL in the dashboard without also saving it as a migration file first — that file is the only record of what changed and when.

**Docker note:** `supabase db pull` / `supabase db dump` require Docker Desktop (they shell out to a version-matched `pg_dump` via a Docker image) — not installed on this machine. The baseline was produced instead with a standalone `pg_dump 17.10` client (`C:\Program Files\PostgreSQL\17\bin`) against the pooler connection string, which is sufficient for the write-a-file-by-hand workflow above. Installing Docker Desktop would additionally unlock `supabase db diff` (auto-generates a migration from a local schema change) — not required unless that workflow is wanted later.
