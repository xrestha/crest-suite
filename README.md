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
| Plan | List Price | Annual Price | Includes |
|---|---|---|---|
| Starter | NPR 8,000/mo | NPR 5,000/mo | Dashboard, Items, Vendors, Periods, Purchases, Stock + Monthly Summary, Reorder, VAT Report, Wastage Report |
| Growth | NPR 18,000/mo | NPR 10,000/mo | + Sales, Recipes, Variance, Payments, Budget vs Actual, Best Sellers, Purchase Orders, Dead Stock, Recipe Margin |
| Pro | NPR 25,000/mo | NPR 15,000/mo | + Menu Engineering, FIFO, Vendor Report, Overheads, Period Comparison, Theoretical Variance, Settings |

Starter: 3-month free trial. Prices listed with bargaining headroom (~35–40%).

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
| `/summary` | **Starter+** | `monthly_summary` |
| `/reorder` | **Starter+** | `reorder_report` |
| `/vat-report` | **Starter+** | `vat_report` |
| `/non-vat-report` | **Starter+** | `non_vat_report` |
| `/wastage-report` | **Starter+** | `wastage_report` |
| `/sales` | Growth+ | `sales_entry` |
| `/recipes` | Growth+ | `recipe_costing` |
| `/variance` | Growth+ | `variance_report` |
| `/payments` | Growth+ | `payment_summary` |
| `/budget` | Growth+ | `budget_vs_actual` |
| `/best-sellers` | Growth+ | `best_sellers` |
| `/purchase-orders` | Growth+ | `purchase_orders` |
| `/dead-stock` | Growth+ | `dead_stock` |
| `/recipe-margin` | Growth+ | `recipe_margin` |
| `/requisitions` | Flag-only | `requisitions` |
| `/menu-engineering` | Pro | `menu_engineering` |
| `/fifo` | Pro | `fifo_report` |
| `/vendors-report` | Pro | `vendor_report` |
| `/supplier-prices` | Pro | `price_tracker` |
| `/overheads` | Pro | `overheads` |
| `/theoretical-variance` | Pro | `theoretical_variance` |
| `/period-comparison` | Pro | `period_comparison` |
| `/settings` | **Starter+** | `settings` |
| `/admin/clients` | Admin only | — |
| `/admin/audit` | Admin only | — |

---

## Pending Features

### Reports Backlog
- **Done (S62):** Wastage Report — `/wastage-report`, Starter+, period wastage by item/category with NPR value and % of total
- **Done (S62):** Dead Stock / Slow Movers — `/dead-stock`, Growth, Dead=Used=0 / Slow=Used<20% of available; Value at Risk
- **Done (S63):** Recipe Contribution Margin — `/recipe-margin`, Growth, (Selling Price − Food Cost) × Qty Sold; sort by contribution/margin/FC%
- **Done (S63):** Period-over-Period Comparison — `/period-comparison`, Pro, FC%/COGS/Revenue side-by-side; ↑↓ pp trend vs prev period
- **Later:** Shrinkage Report — items with consistent negative variance across multiple periods (multi-period query, loss-prevention tool). Different from Wastage: wastage is logged, shrinkage is unexplained.
- **Later:** Annual Summary — rollup of all monthly_periods in a BS fiscal year
- **Later:** Outstanding Payables — Credit purchases by vendor with aging (needs `paid_at` column on `purchase_entries`)

### Features Backlog
- **Done (S61):** PWA — installable shell. `manifest.json` updated (name, colors, scope), `public/service-worker.js` added (cache-first for assets, network-first for navigation, never caches Supabase calls), registered in `src/index.js`. Icons: replace `public/logo192.png` + `public/logo512.png` with actual Crest logo at those sizes.
- **Later:** PWA offline stock count entry — IndexedDB + background sync for counts with no signal
- **Later:** Staff meal & complimentary tracking (separate consumption category)
- **Later:** Mobile-first stock count UX (dedicated counting flow)
- **Later:** Owner Dashboard (mobile-first single-page P&L view — deferred)
- **Later:** Role-based users Owner/Manager (deferred)

---

## Session Log

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
