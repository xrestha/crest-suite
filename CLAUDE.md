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

**`SuiteGate`** (`src/components/SuiteGate.js`, added S317 for Owner Dashboard) is a third gate type on a genuinely separate axis: `clients.suite_plan` (the Crest Suite bundle tier — IMS+HR+POS together — nullable, with no free-default tier unlike `hr_plan`/`pos_plan`). It differs from `ModuleGate`/`PremiumGate` in one important way: **it never redirects on failure** — an ineligible viewer sees an inline upsell/explanation rendered in place, since the feature's nav entry must stay visible regardless of eligibility. Used as an in-page wrapper inside the gated component, not at the route level. Reach for this pattern only for a genuinely cross-module/bundle-tier feature; a single-module feature still wants `ModuleGate` + `PremiumGate`.

### Three dashboards, deliberately not one (as of S330 analysis)

A client with 2+ modules sees three separate dashboard destinations, each a different altitude and gate — don't merge them without re-reading this:

- **`/dashboard`** (`ClientDashboard.jsx`, universal, no plan gate) — the "quick glance" one. Already merges IMS/HR/POS sections onto a single page when `clientModules.{ims,hr,pos}` says 2+ are enabled (a `moduleHeader()` per section), but each module's slice here is deliberately light (HR is just 3 cards: Total Employees / Active / Basic Payroll).
- **`/hr/dashboard`** (`HrDashboard.jsx`, `ModuleGate` only) — the operational HR console: an **Approvals** row (Leave/OT/TADA/Swap pending counts, S330) plus queue tables you act on directly, SSF breakdown, advances. This is a working tool, not a glance.
- **`/owner-dashboard`** (`OwnerDashboard.jsx`, `SuiteGate` at Growth+) — the strategic cross-module view: margin%, labor cost% (needs HR wage data + IMS revenue together, computed nowhere else). IMS+HR only so far; POS integration is an explicit Phase 2.

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

### Component library (reusable)

| Component | File | Notes |
| --- | --- | --- |
| `Tip` | `src/components/Tip.js` | Hover tooltip using `createPortal` — escapes `overflow:hidden` containers. All non-obvious columns and form labels must have one. |
| `SearchableSelect` | `src/components/SearchableSelect.js` | Drop-in for long `<select>` lists. `position:fixed` dropdown never clips inside modals. Flips above the trigger near the bottom of the viewport. |
| `Fab` | `src/components/Fab.js` | Fixed bottom-right `+ Add` button |
| `Modal` | `src/components/Modal.js` | Centered overlay with backdrop-click close |
| `BsCalendarPicker` | `src/components/BsCalendarPicker.js` | BS year/month/day picker, calendar-grid UI |
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
- Real Web Push (Roster publish + shift-swap notifications) is sent from the Edge Function `hr-push` (`supabase/functions/hr-push/`) — the only place holding the VAPID private key (`VAPID_PRIVATE_KEY` secret; the public half is `REACT_APP_VAPID_PUBLIC_KEY`, safe to expose). `src/utils/webPush.js` handles the frontend subscribe flow, including the iOS Safari quirk where the Push API is only available to a page added to the Home Screen, never a regular tab.
- `profiles` itself is the one table that does **not** follow the standard same-client pattern above — `profiles_select` RLS is self-or-admin only (`id = auth.uid() OR is_admin()`). A raw `supabase.from('profiles').eq('client_id', ...)` query, run by a real (non-admin) client login, silently returns nothing but the caller's own row. To resolve another staff member's name (closed_by/comped_by/sent_by/etc.), call the `get_client_profile_names(p_client_id)` RPC (all profiles for that client) or `get_pos_staff_list(p_client_id)` (PIN-based POS staff only, excludes the Owner — used by Staff Management specifically). Never a raw `profiles` query for anyone but the caller's own row.
- **Staff accounts are same-client at the RLS level** — POS PIN staff (`pos_email IS NOT NULL`) and HR self-service accounts (`hr_self_service = true`) share `role='client'` + `client_id` with the owner, so the standard admin-or-same-client policy alone gives them owner-level data access. S316 (`20260708130000_staff_account_business_table_isolation.sql`) fenced them off with **RESTRICTIVE** `no_self_service_accounts` / `no_pos_pin_staff` policies per table (helpers: `is_hr_self_service()`, `is_pos_pin_staff()`). **When creating a new business table, add it to the matching restrictive-policy lists too** — a new table doesn't inherit the exclusions, and a bare same-client policy re-opens the hole for staff JWTs.
- **`profiles.hr_employee_id`** links a login to an `hr_employees` record — originally written only by HR Self-Service (`create_hr_self_service_login`), and as of S328 also optionally written by `create_pos_staff` (POS Staff's "+ Add Staff" → HR Employee mode) so a client running both HR and POS doesn't have to enter the same person twice under two different names. A partial unique index (`profiles_hr_employee_pos_unique` on `hr_employee_id WHERE pos_email IS NOT NULL`) plus an Edge Function check stop the same employee from getting two POS accounts; nothing stops one employee from separately having both a POS account and an HR Self-Service account, since those are different login mechanisms for the same person.
- `per_uom_rate` on `items` is a **generated column** — never include it in INSERT/UPDATE payloads.
- `pos_orders.order_no` is assigned by a **BEFORE INSERT trigger** (per-client sequential) — never set it from the frontend; read it back via `.select('id, order_no')` after insert. Same pattern for `pos_orders.invoice_no` (BEFORE UPDATE, partitioned by `client_id + invoice_fy + close_type`) and `pos_credit_notes.credit_note_no` (BEFORE INSERT, partitioned by `client_id + invoice_fy`) — never set these from the frontend either. Item-level comps (`pos_order_items.comp_no`) share the **same NC-series** as a whole-order Complimentary Slip — the frontend calls `get_next_pos_comp_slip_no(client_id, fy)` RPC once per Charge action (one number per comp event, not per line) and passes the result in explicitly; `assign_pos_invoice_no()`'s `close_type='writeoff'` branch locks on and considers that same pool, so the two paths can never collide.
- The offline stock count uses IndexedDB (`src/utils/offlineQueue.js`, DB name `crest-offline`) with 5 object stores. Sync flushes automatically on reconnect.
- `settings` was, until S290 (`20260707150000_settings_rls_same_client_write.sql`), the one client-scoped table whose INSERT/UPDATE RLS policies were **admin-only** with no same-client allowance — every settings-writing tab in `PosTableManagement.jsx` (Discounts, Quick Notes, Ticket Routing, Delivery Partners) had been silently no-op'ing for any real (non-admin) client login, since an RLS-blocked write returns zero rows changed with no error rather than throwing. Now follows the standard `is_admin() OR client_id = my_client_id()` pattern like every other table; the `client_id IS NULL` global-defaults row (`app_name`, `app_tagline`, etc.) stays admin-only automatically since a real client's `client_id` can never equal `NULL`. Still stays on raw `supabase.from()` rather than `scopedDb` (see the `scopedDb` note above) — that's about the nullable `client_id`, unrelated to this RLS fix.
- **Public, unauthenticated routes** (a page with no login at all — `/pos/login`, `/pos/menu/:tableId`) can't gate data access through `profiles`/`auth.uid()` the normal way, since there's no session. The established pattern: a plain SQL or PL/pgSQL function, **always `SECURITY DEFINER`** (an anonymous caller has no RLS-passing identity at all, so even a function reading "already-public-by-design" data like `get_pos_staff` needs it — e.g. `get_pos_staff` reads `profiles`, whose `profiles_select` RLS is self-or-admin-only per the note below, so a non-`SECURITY DEFINER` version would return zero rows for a real anonymous caller) with **no internal auth check**, callable by the `anon` role via Postgres's default PUBLIC-execute grant. The function itself does whatever authorization makes sense for that page (e.g. `get_guest_menu` resolves table → client → checks `pos_enabled`) and returns only deliberately whitelisted columns — never a full row, never anything from a sales/orders table. Anonymous callers hitting an internal helper function directly (bypassing the public entry point) are still blocked by that helper's own RLS as long as the helper isn't itself `SECURITY DEFINER`. A 2026-07-12 Security Advisor pass also found the `anon` PUBLIC-execute grant had never been revoked from 22 other `SECURITY DEFINER` functions that are meant for authenticated sessions only (most already had the standard caller check below, so this was defense-in-depth, not an active hole) — see `20260712210000_security_advisor_anon_execute_hardening.sql`.
- **Every `SECURITY DEFINER` function meant for a *logged-in* caller (not the public/anon case above) must check the caller itself** — `SECURITY DEFINER` bypasses RLS entirely, so skipping this check isn't "relying on RLS as a backstop," it's no check at all. The standard shape, used by `apply_pos_item_comps`/`get_pos_staff_list`/`get_client_profile_names`/`get_cooccurrence`/`get_next_pos_comp_slip_no`: `IF NOT (public.is_admin() OR p_client_id = (SELECT client_id FROM profiles WHERE id = auth.uid())) THEN RAISE EXCEPTION ...`. A Security Advisor pass (S293, 2026-07-07) found two functions shipped without it — `admin_clear_audit_logs` (zero check at all; any authenticated user could wipe every client's audit log — the `adminOnly` frontend route guard on `AuditLog.js` doesn't protect the RPC itself) and `get_cooccurrence` (no caller-matches-`p_client_id` check; leaked any client's item-pairing sales data to any other logged-in user, or even `anon`). Also always set `SET search_path TO 'public'` explicitly on new functions — the Advisor's `function_search_path_mutable` warning is cheap to avoid and was missing on 4 functions as of S293.

### Schema migrations

The Supabase CLI is installed and linked to the live project (`supabase link`, ref in `supabase/.temp/`). `supabase/migrations/` is the source of truth for schema history — a root-level `supabase_schema.sql` snapshot used to serve this purpose and is retired as of the `20260705074838_baseline_schema.sql` migration (a full `pg_dump --schema-only` of the live DB at that point in time).

**Workflow for every schema change:**

1. Create a new file: `supabase/migrations/<YYYYMMDDHHMMSS>_<description>.sql` (or `supabase migration new <description>` to scaffold the filename).
2. Write the SQL in that file.
3. Apply it the normal way — paste it into the Supabase Dashboard → SQL Editor and run it.
4. Commit the file. Never run ad hoc schema SQL in the dashboard without also saving it as a migration file first — that file is the only record of what changed and when.

**Docker note:** `supabase db pull` / `supabase db dump` require Docker Desktop (they shell out to a version-matched `pg_dump` via a Docker image) — not installed on this machine. The baseline was produced instead with a standalone `pg_dump 17.10` client (`C:\Program Files\PostgreSQL\17\bin`) against the pooler connection string, which is sufficient for the write-a-file-by-hand workflow above. Installing Docker Desktop would additionally unlock `supabase db diff` (auto-generates a migration from a local schema change) — not required unless that workflow is wanted later.
