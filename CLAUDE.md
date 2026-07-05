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
- **Vercel** for deployment — `vercel.json` sets `no-cache` on `index.html` to prevent CDN serving stale bundles
- **PWA service worker** at `public/service-worker.js` — registered only in production (`src/index.js`). Cache name is `crest-v4`; bump it when breaking CSS/JS changes need cache invalidation

---

## Architecture

### Context providers (wrap the whole app in order)

`ThemeProvider → AuthProvider → SettingsProvider → BrowserRouter`

| Context | File | Purpose |
|---|---|---|
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

### Multi-tenant data isolation

Every Supabase table is client-scoped. **Critical invariant:**

```js
// Guard every insert — clientId can be null during admin hydration
if (!clientId) { setError('No client selected'); return }
```

`clientId` in `AuthContext` resolves as:
- Admin: `adminViewClientId` (from `localStorage`; set when admin "views as" a client)
- Client user: `profile.client_id`

Admin switches clients via the sidebar dropdown → `switchAdminClient(id, name)` → all pages re-fetch via `useEffect([clientId, ...])`.

### Modules

The app is one React app / one Supabase project with three modules toggled by per-client flags on the `clients` table:

| Flag | Column | Default |
|---|---|---|
| Crest IMS | `ims_enabled` | `true` |
| Crest HR | `hr_enabled` | `false` |
| Crest POS | `pos_enabled` | not yet a real column — hardcoded false for clients |

`clientModules` in `AuthContext` drives **display** (sidebar + dashboard sections). `imsEnabled` / `hrEnabled` drive **route access** (admin bypasses both).

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

### CSS variable theme system

All colors must use CSS variables, not hardcoded hex. The full token set:

```
--theme-bg          --theme-card        --theme-border      --theme-border-lt
--theme-text1       --theme-text2       --theme-text3
--theme-accent      --theme-green       --theme-red         --theme-amber
--theme-sidebar     --theme-input-bg    --theme-table-hover --theme-focus-ring
```

**Exception:** Recharts SVG props (`fill`, `stroke`, `tick`) must stay as literal hex — CSS `var()` does not resolve inside SVG presentation attributes.

### Component library (reusable)

| Component | File | Notes |
|---|---|---|
| `Tip` | `src/components/Tip.js` | Hover tooltip using `createPortal` — escapes `overflow:hidden` containers. All non-obvious columns and form labels must have one. |
| `SearchableSelect` | `src/components/SearchableSelect.js` | Drop-in for long `<select>` lists. `position:fixed` dropdown never clips inside modals. Flips above the trigger near the bottom of the viewport. |
| `Fab` | `src/components/Fab.js` | Fixed bottom-right `+ Add` button |
| `Modal` | `src/components/Modal.js` | Centered overlay with backdrop-click close |
| `BsDatePicker` | `src/components/BsDatePicker.js` | BS year/month/day pickers |
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
6. **README**: update both `C:\crest-inventory\README.md` and `E:\CREST INVENTORY MANAGEMENT\README.md`.

---

## Supabase / DB notes

- RLS is enabled on all 18+ tables. The standard policy pattern uses an inline subquery:
  ```sql
  (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid())
  ```
- Admin operations that need the service role key go through the Supabase Edge Function `admin-user-ops` (deployed at `supabase/functions/admin-user-ops/`). Never put `SUPABASE_SERVICE_ROLE_KEY` in the frontend bundle.
- `per_uom_rate` on `items` is a **generated column** — never include it in INSERT/UPDATE payloads.
- `pos_orders.order_no` is assigned by a **BEFORE INSERT trigger** (per-client sequential) — never set it from the frontend; read it back via `.select('id, order_no')` after insert. Same pattern for `pos_orders.invoice_no` (BEFORE UPDATE, partitioned by `client_id + invoice_fy + close_type`) and `pos_credit_notes.credit_note_no` (BEFORE INSERT, partitioned by `client_id + invoice_fy`) — never set these from the frontend either.
- The offline stock count uses IndexedDB (`src/utils/offlineQueue.js`, DB name `crest-offline`) with 5 object stores. Sync flushes automatically on reconnect.

### Schema migrations

The Supabase CLI is installed and linked to the live project (`supabase link`, ref in `supabase/.temp/`). `supabase/migrations/` is the source of truth for schema history — a root-level `supabase_schema.sql` snapshot used to serve this purpose and is retired as of the `20260705074838_baseline_schema.sql` migration (a full `pg_dump --schema-only` of the live DB at that point in time).

**Workflow for every schema change:**
1. Create a new file: `supabase/migrations/<YYYYMMDDHHMMSS>_<description>.sql` (or `supabase migration new <description>` to scaffold the filename).
2. Write the SQL in that file.
3. Apply it the normal way — paste it into the Supabase Dashboard → SQL Editor and run it.
4. Commit the file. Never run ad hoc schema SQL in the dashboard without also saving it as a migration file first — that file is the only record of what changed and when.

**Docker note:** `supabase db pull` / `supabase db dump` require Docker Desktop (they shell out to a version-matched `pg_dump` via a Docker image) — not installed on this machine. The baseline was produced instead with a standalone `pg_dump 17.10` client (`C:\Program Files\PostgreSQL\17\bin`) against the pooler connection string, which is sufficient for the write-a-file-by-hand workflow above. Installing Docker Desktop would additionally unlock `supabase db diff` (auto-generates a migration from a local schema change) — not required unless that workflow is wanted later.
