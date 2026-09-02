# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Where a new rule goes

**Default to `.claude/rules/`, not this file.** Everything here loads on *every* request, so a rule
that only matters while one module is open is paid for by every session that never opens it. Four
`/doctor` passes have now had to migrate sections out (2026-08-18, S605, S615, S663 — that
last one halved the file, 110k → 51k chars), and between the second and third the root file regrew
7,052 chars in three days — not through carelessness, but because a new
rule has one obvious home and no single session can see that it is the fortieth to pick it.

Ask which file the rule is *reachable from*, not which file it is about:

- **Reachable from one module or a few files** → the matching `.claude/rules/*.md` (add a `paths:`
  entry, or start a new file), with a short pointer stub left here if a root-file read should still
  surface that the guidance exists.
- **Reachable from anywhere** → here. Safety-critical prohibitions ("never do X"), multi-tenant
  isolation, access control, and anything that must be present *before* someone thinks to ask.

A section can be split when both are true — the BS calendar keeps its rules here and its
table-provenance in `.claude/rules/bs-calendar.md`.

**A `paths:` glob that no longer matches is a rule that silently stopped loading.** Four had rotted
by S663 — `src/contexts/AuthContext.js` (the directory is `context`, singular) meant
`accounts-and-logins.md` never loaded for the file it is most about, and three more pointed at pages
that had moved from `src/pages/` into `src/modules/`. Nothing warns. After moving or renaming a file,
grep `.claude/rules/*.md` for its old path, and check each glob still resolves.

**Never embed a value that moves** (a cache version, a table count, a file count) in a rule that is
otherwise permanent: the rule stays correct while the number rots inside it, and a derivability
audit will not catch it because the rule around it genuinely is not derivable. Point at the file
instead.

---

## The sister repo (hss-suite)

**HR, payroll, settlement and `src/utils/bsCalendar.js` are shared with hss-suite**, whose HR module
was ported from this one; the BS table is identical in both. **A bug fixed on either side stays open
on the other until it is filed in `docs/CROSS-REPO.md` there** — that file is the backlog both ways,
and says what is genuinely shared versus what only looks it.

**Copying a permission gate is the trap**: here `isAdmin` is the Crest platform OPERATOR (the
tenant's Owner is `isOwner`), there it aliases that one company's Owner. Same spelling, different
meaning.

---

## Stack

- **React 19 (CRA)** — no Vite, no custom webpack config, no TypeScript
- **Supabase JS v2** — single client at `src/supabaseClient.js`; anon key only in the browser bundle
- **Code splitting (S440)** — every page component in `App.js` is route-level `React.lazy(() => import(...))`; only structural pieces stay eager (contexts, `Layout`, `ProtectedRoute`, `ModuleGate`/`PremiumGate`). Keep new page routes lazy too. Two `Suspense` boundaries: one around `Layout.js`'s `<Outlet />` (so the sidebar persists during in-app navigation — only the content area shows `RouteFallback`) and a top-level one in `App.js` for the public routes. Any `import './x.css'` must stay **above** the lazy `const`s or ESLint's `import/first` fails the CI build. This cut initial JS from ~931 kB → ~165 kB gzipped (the rest lazy-loads as ~97 on-demand chunks)
- **`xlsx` is always `import('xlsx')` inside the click handler, never a top-level `import * as XLSX from 'xlsx'` (S522).** Route-level lazy-loading (S440 above) only defers a *page's own* code — it does nothing about a library that page statically imports, which webpack still must fetch the moment the route loads. `xlsx` is 138 kB gzipped and is only ever touched by an explicit Export/Import click, so a static import paid it on every visit to all 37 pages with an Excel button. Make the handler `async` and put `const XLSX = await import('xlsx')` on its first line. `recharts` (102 kB) is deliberately left static — charts are above-the-fold content, not a deferred click. The three files that needed a different shape, and how the fix was verified in the built output, are in `.claude/rules/frontend-performance.md`.
- **Vercel** for deployment — `vercel.json` sets `no-cache` on `index.html` to prevent CDN serving stale bundles
- **PWA service worker** at `public/service-worker.js` — registered only in production (`src/index.js`). `CACHE_NAME` (read the current value from the file — it moves constantly) must be bumped on **every** JS/CSS change you want existing users to actually receive, not just breaking ones — the fetch handler is cache-first for static assets, so a plain deploy (or even a hard refresh) leaves already-cached chunks serving the old code indefinitely until this constant changes and `activate` purges the old cache (S452 found a real fix silently never reached the browser because of this)

---

## Architecture

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

**Two mechanisms decide the same thing and must be changed together.** `PremiumGate` gates on the **`minPlan` rank prop** in `App.js`; `isItemVisible()` (nav) gates on **`hasFeature()`**, i.e. the key sets. `featureKey` on `PremiumGate` is only an *override* path, not the gate. Move a feature between tiers and you must edit the key set in `AuthContext.js` **and** the `minPlan` on its route **and** the `minPlan` tag on its `Layout.js` nav item, or you get a page that is reachable-but-hidden or visible-but-blocked.

**Guest QR Ordering comes WITH the POS module, and `pos_enabled` is its only gate** (settled S632, migration `20260829170000`). `POS_MODULE_KEYS` in `AuthContext.js` grants it on `posEnabled` alone, both server functions already return/raise at the `pos_enabled` gate, and `feature_flags.guest_ordering` now gates nothing — a condition that can only have one answer reads like a control that exists. **`pos_enabled` is now the only thing standing between a client and a public guest menu, so never remove that check** — the migration asserts it is still present for exactly that reason. Anything asking "does this client have HR/POS" reads `hrEnabled`/`posEnabled`.

**`false` in `feature_flags` is not a revoke.** `hasFeature()` only tests `flagVal === true`; `null`, `undefined` and `false` all fall through to the plan check identically, and `FeatureAccessModal`'s toggle only ever writes `true` or `null`. A stray `false` is inert. Assuming otherwise cost a round in S548 — a grandfather sweep used `COALESCE(flag, true)` to "preserve" those falses and under-granted three clients.

**`SuiteGate`** (`src/components/SuiteGate.js`, added S317 for Owner Dashboard) is a third gate type on a genuinely separate axis: `clients.suite_plan`. It differs from `ModuleGate`/`PremiumGate` in one important way: **it never redirects on failure** — an ineligible viewer sees an inline upsell/explanation rendered in place, since the feature's nav entry must stay visible regardless of eligibility. Used as an in-page wrapper inside the gated component, not at the route level; a nav item for a Suite feature therefore carries **no** `featureKey`/`minPlan`, or it would disappear instead of upselling. Suite is an **add-on priced per outlet on top of a client's modules**, not a bundle containing them; `requireModules` (array, default `['ims','hr']`) varies per feature, so don't assume every caller needs Owner Dashboard's set.

**Anything added to `clients` that changes what a client pays needs a place in the admin list in the same change**, and the screen that changes what a client pays must show the money. The MRR arithmetic lives in **`src/shared/clientMrr.js`** (`clientMRR` / `clientMrrBreakdown`, pure over `(client, planPrices)`) and is imported by both admin surfaces — **do not write a second copy.**

The entitlement histories behind these rules — why `plan` is plain `clients.plan` with no max over anything (S548/S574), the one canonical trial column set (S574), why Suite has one tier and how it became sellable in the shell (S638–S643), and each of `clientMrr.js`'s rules — live in `.claude/rules/access-control.md`, which auto-loads when editing `AuthContext.js`, `App.js`, the gates, `clientMrr.js` or the admin client screens.

### Which tier a feature belongs in

Placement is by attribute, not by when it was built. The tier thesis: **Starter = Record & Comply, Growth = Control, Pro = Strategy, Crest Suite Pro = Synthesis** (cross-module, owner altitude). Two rules fall out of it, both already broken once: **a feature must be able to produce a number on its own tier's data**, and **a statutory obligation never gates above the base tier** — nor may a data-entry page sit above the tier of any figure that consumes it.

**Moving a feature between tiers requires a grandfather sweep in the same deploy.** `hasFeature()` is "plan tier OR explicit flag", so setting the flag `true` for affected clients restores prior access with no code change. Upward-*available* moves need no sweep.

The five scoring attributes and the specific features that were misplaced are in `.claude/rules/access-control.md`.

### The IMS figures that must come from one place (S551)

See `.claude/rules/ims-figures.md` (auto-loads when editing `imsFormulas.js`, stock count, or the
IMS report/summary modules). Headline rules: import `COGS_FORMULA` wherever the formula is PRINTED
and `computeUsed()` wherever it is COMPUTED (staff meals are in COGS); food-cost banding goes through
`fcBand(pct, settings)` and variance banding through `varianceBand(pct, value, settings)`, never a
hardcoded copy — and the OTHER three operating ratios (labour, prime, net margin) band in
`src/shared/operatingBands.js`, whose `bandFigure()` is what stops a call site taking the colour and
dropping the ✓/△/▲; a settings field with no reader is worse than no field — and "it is wired now" is a
claim worth re-checking, since `variance_flag_pct` was declared wired while reaching one of its three
consumers; Stock Count's Summary holds two tables built from different loops that must be kept tying
out; a variance-style report must default to a CLOSED period, and must STATE which period it is on
(`PeriodScope`) rather than trailing it off the end of a sentence.

### Multi-outlet: one login, several clients (S548)

A group of outlets is several `clients` rows joined by `clients.group_id → client_groups`; `profiles.active_client_id` re-scopes every RLS policy through `my_client_id()`, which stays a join-free `coalesce`. Two rules are safety-critical and stay here:

- **`active_client_id` is privilege-bearing and must never be user-writable.** It decides which tenant every RLS policy resolves to, is deliberately NOT on `guard_profiles_privileged_columns()`'s allow-list (S531 invariant #1), and `set_active_outlet()` is the only write path.
- **Group-spanning reads cannot go through scoped queries.** `get_group_summary()` is `SECURITY DEFINER` with its own caller check and filters to `suite_plan = 'pro'` **server-side** — a client-side filter would ship an unpaid outlet's revenue to the browser and then hide it.

The architecture (selected-outlet indirection, not policy rewriting), `profile_outlet_access`, the HQ→branch `push_master_data` refusals, and the three defects that sat unreachable from S548 to S617 are in `.claude/rules/multi-outlet.md`.

### Subscription access — the third guard (S544)

`ModuleGate`/`PremiumGate`/`SuiteGate` answer "which features has this client bought". None answers "is this client still paying". `getAccessState(client)` in `src/utils/subscription.js` is the single place that decision is made, enforced in **`ProtectedRoute`** — the one choke point every in-app route passes through. **Do not add this check per-page**: a per-page guard reopens the whole product the first time someone adds a route and forgets it, which is precisely how `is_active` came to mean nothing.

**It fails OPEN** — only a date that exists *and* has passed locks anything — and **this is a UI gate, not a security boundary**: RLS still lets a locked client's JWT read and write its own rows, and two doors stay open after the lock (HR Self-Service, mounted outside `ProtectedRoute`, and the public guest-menu route).

`GRACE_DAYS`, the auto-deactivation sweep that must honour it, and the trial carve-out are in `.claude/rules/subscription-access.md`.

### Client data Export / Import (S545)

See `.claude/rules/data-export.md` (auto-loads when working in `src/modules/admin/dataExport/` or the admin client screens). Headline rules: never ship the .xlsx without the .json; restore refuses non-empty clients; Archive > Delete.

### Three dashboards, deliberately not one

See `.claude/rules/dashboards.md` (auto-loads when editing dashboard files). Headline rules: /dashboard, /hr/dashboard and /owner-dashboard are different altitudes/gates — don't merge them; the `overheads` three-bucket trap (labor double-count) is documented there.

### Monthly Owner/Manager Report (frozen snapshot, S434)

See `.claude/rules/owner-report.md` (auto-loads when editing `src/modules/ownerReport/` or MonthlyOwnerReport.jsx). Headline rules: snapshot is captured at period close and never recomputed; resolve FK display values at generation time; `.eq('is_active', true)` on any figure valuing items.

### The four privilege invariants (S531 security review — do not regress these)

A full review on 2026-08-10 found that most of the app's access control was enforced one layer above where it was actually decided. Four rules came out of it, each of which had already been violated:

1. **`profiles` is the root of trust, so a client session may only write `full_name` and `last_seen_at` on it.** `profiles_update` had no column restriction, so any user — including a POS PIN waiter — could PATCH `role = 'admin'` and read every tenant's data, or clear their own `pos_role`/`ims_role`/`hr_role`/`hr_self_service` to shed all four RESTRICTIVE isolation policy families at once *and* pass the negative `isOwner` test. `guard_profiles_privileged_columns()` (migration `20260810120000`) is a `BEFORE UPDATE` trigger enforcing this. It is an **allow-list** on purpose: a deny-list of today's privileged columns silently reopens on the next column added, which is exactly what happened to `admin-user-ops`' conditional-write list twice. It is also deliberately **SECURITY INVOKER** — it keys off `current_user NOT IN ('anon','authenticated')` to let the service role and every `SECURITY DEFINER` body through, and under `SECURITY DEFINER` `current_user` would be the owner every time and the check would never fire. **Adding a column to `profiles` requires no change here; adding a genuinely user-editable one does.**
2. **A staff-management action must verify what its target *is*, not just which client it belongs to.** Every reset/delete/role action in `admin-user-ops` checked only `targetProfile.client_id === profile.client_id` — and the Owner shares that `client_id`, so a module manager could reset the Owner's password and log in as them. `requireStaffTarget(target, module)` now refuses any target that is not already a staff account of that module (marker per module mirrors that module's own RLS predicate: `pos_email` / `ims_role` / `hr_role`), or that is an admin. Admin callers are exempt from the marker requirement — resetting a locked-out Owner's password is legitimate operator support.
3. **A lockout the client calls around an operation is not a lockout.** POS and HR Self-Service both had `check_*_pin_lock` before and `record_*_pin_attempt` after, in the browser, with nothing server-side consulting them — so skipping the two RPCs walked a 4-digit PIN unimpeded. Both now run **inside** `pos-staff-login` / `hr-selfservice-login`, on the same request that signs in. Corollary: the frontend must **not** also call `record_*_pin_attempt`, or every failure double-counts and locks a fat-fingered employee out in 3 attempts instead of 5. Same reasoning applies to any future server-side check — **if the browser can skip the call, it is advisory.** The POS discount cap, void permission and item-level comp were the same shape and were fixed the same way (S576/S579), as BEFORE UPDATE **triggers rather than RPCs**, because an RPC protects only the callers that choose to call it and leaves the open policy in place; **attribution the subject of the attribution can choose is not attribution**, so `comped_by` comes from `auth.uid()`, never a parameter. Detail in `.claude/rules/pos-billing.md`.
4. **A secret must not live on a row the subject of the secret can read.** `clients.pos_device_secret` and `settings.pos_webhook_secret` were both readable by every account of the client. Both now live in **`client_secrets`**, admin-only at the RLS level, reached otherwise through `get_pos_device_secret()` (checks admin/Owner/POS-manager rank) or the service role inside an Edge Function. Postgres has **no column-level RLS**, and the REVOKE-then-GRANT-per-column alternative breaks `select('*')` and fails closed on every column added later — a separate table is the only clean answer. `client_secrets` is deliberately **not** audited: `log_audit()` stores full row snapshots and would put both secrets in `audit_logs` in plaintext.

**Wrap every authorisation condition in `COALESCE(..., false)`.** `pos_role` is NULL for any account with no POS access, `NULL IN ('supervisor','manager')` evaluates to NULL rather than false, `NULL OR false` is NULL, and `IF NOT NULL THEN` never fires — so the natural form of a rank check falls open for exactly the accounts that have no rank. This is the `is_admin()`-returns-NULL trap in a second guise; assume any three-valued expression in a guard is a fail-open until it is wrapped.

`is_client_owner()` is the **third** copy of the negative Owner test, alongside `isOwner` in `AuthContext.js` and `isCallerOwner` in `admin-user-ops/index.ts`. A new staff-account marker column must be added to **all three** — miss one and Owner detection breaks silently and in the permissive direction.

**Security headers live in `vercel.json`, and that file cannot carry comments** — it is strict JSON validated against Vercel's schema, so the usual `"//": "why"` trick fails the *build* rather than being ignored. **`connect-src` is the control that matters most — it is the exfiltration boundary, and adding any new third-party API call requires adding its origin there or it fails silently in production and works fine in dev.** The rest of the rationale is in `.claude/rules/security-headers.md`.

Two entitlement/abuse fixes from the same pass: `feature_flags` writes are now admin-only (one `FOR ALL` policy previously let any account of the client set every Pro flag true, and `hasFeature()` is "plan tier OR explicit flag", so that was a free tier upgrade); and `register_trial` — unauthenticated by design — is rate-limited per-IP (3/hr) and globally (30/hr) via `trial_signup_attempts`, recorded *before* the attempt so a failing loop burns quota too.

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

As of 2026-07-05 every IMS, HR and POS page, plus `Dashboard.js`, `Periods.js` and `Settings.js`, goes through `scopedDb`. Two pages are **correctly exempt, not pending**: `AuditLog.js` (a cross-client admin viewer — `audit_logs.client_id` is nullable and its "All Clients" filter is incompatible with auto-scoping to one client) and `AdminClients.js` (has no `clientId` of its own — it loops over an explicit client list and acts on whichever `client.id` a row targets, so it calls the raw `scopedFrom`/`scopedInsert`/`scopedUpdate`/`scopedDelete` functions from `scopedDb.js` directly with that `client.id`, instead of the `useScopedDb()` hook). `Periods.js`'s admin "all clients" view and `Dashboard.js`'s `loadAdminStats()` use that same raw-function-with-explicit-id pattern, while their genuinely cross-tenant reads stay on plain `supabase.from()`.

### Modules

The app is one React app / one Supabase project with three modules toggled by per-client flags on the `clients` table:

| Flag | Column | Default |
| --- | --- | --- |
| Crest IMS | `ims_enabled` | `true` |
| Crest HR | `hr_enabled` | `false` |
| Crest POS | `pos_enabled` | `false` (real column, added S193) |

`clientModules` in `AuthContext` drives **display** (sidebar + dashboard sections). `imsEnabled` / `hrEnabled` drive **route access** (admin bypasses both).

### Staff role systems (POS / IMS / HR)

Three independent rank axes on `profiles` — `pos_role`, `ims_role`, `hr_role` (each `staff|supervisor|manager`, `NULL` = no access) — checked via `hasPosAccess`/`hasImsAccess`/`hasHrAccess` in `AuthContext.js`. Admin/Owner always resolve to `'manager'` on all three, **which makes the resolved ranks the WRONG test for "is this a staff/till session"**: gate any staff-only behaviour on the raw `profile.pos_role` column, never the rank. `isOwner` is a **negative** test, so a new staff-account marker column must be added to every `isOwner`/`isCallerOwner` computation (`AuthContext.js` and `admin-user-ops/index.ts` both) or it silently breaks Owner detection for every other marker.

Each axis gates two things that must both be kept in sync when adding a page: the **route guard** inside the page component and **nav visibility** (a `minPosRole`/`minImsRole`/`minHrRole` tag on the `Layout.js` nav item).

`pos_team`, `pos_discount_limit`/`pos_allow_void`, and the `admin-user-ops` conditional-write rule that any new field in that family must follow from the start are in `.claude/rules/accounts-and-logins.md`.

### Who logs in where, and how an Owner account comes to exist

See `.claude/rules/accounts-and-logins.md` (auto-loads when editing AuthContext, Login, or any
staff/employee management screen). Headline rules: there are three front doors (`/login` for Owner,
IMS staff, HR staff and admin; `/pos/login` and `/hr/self-service` for PINs) and an owner never uses
a PIN; **Owner is the ABSENCE of staff markers, so giving the owner's own login a staff role demotes
them**; and `hr_employees.status` is payroll eligibility only — `access_blocked` is what revokes a
Self-Service login.

### Splitting a page component once it outgrows one file

Six pages past 1,200 lines were split in 2026-07-06 using whichever of four patterns matched what was actually inside. **A page with more than one `return` will happily render your new UI where nobody can reach it** — `PosOrders.jsx` early-returns the order screen and then falls through to the floor view, so a modal added at the tail of the file lands in the floor view while its opener lives on the order screen. It compiles, passes every detector, and reads correctly in review (S578). Check which return a handler lives in before placing its modal, and prefer a live click over any amount of static checking.

The four patterns and when each applies are in `.claude/rules/component-library.md`.

### Bikram Sambat (BS) calendar

All periods and dates in the app use the Nepali calendar; the utilities are in `src/utils/bsCalendar.js`. Four things the signatures don't tell you:

- `formatAd(date)` reads the Date's **local** getters — that is the whole point of it
- `bsDayBoundaryIso(y, m, d, endOfDay)` returns an AD instant carrying Nepal's `+05:45`
- `daysInBsMonth(year, month)` — each BS month has a different number of days (28–32); **never assume 30**
- Nepal fiscal year runs **Shrawan (month 4) → Ashadh (month 3)** of the following BS year

The lookup table covers BS 2000–2087; out-of-range years fall back to a 30-day approximation. Its provenance, why 2084–2087 are deliberately left alone, and what `BS_YEAR_MIN`/`BS_YEAR_MAX`/`adToBsSafe` are for live in `.claude/rules/bs-calendar.md`. Read it before extending the table.

**Never `.toISOString()` a Date that came from `bsToAd`.** It returns local midnight, so at Nepal's UTC+05:45 `.toISOString()` lands at 18:15Z on the *previous* day and `.slice(0,10)` yields the wrong date for every user in the country. This shipped twice. Use `formatAd` where a bare date string is wanted — including any RPC declaring its parameter as `date` — and `bsDayBoundaryIso` where the value is compared against a real `timestamptz`.

**A date picked in BS is STORED as AD, so fixing the table never fixes the stored value.** `BsCalendarPicker` commits `formatAd(bsToAd(...))`; two converter faults have shipped and rows written under either are still wrong today with nothing to signal it — dates of birth worst. A picker given `lockYear`/`lockMonth` stores a day NUMBER instead and is unaffected. **`BS_MONTHS` has exactly one definition and it lives in `bsCalendar.js`** — import it, never retype it. The era table, the repair derivation, `scripts/bs-date-audit.mjs` and `formatBsDay` are all in `.claude/rules/bs-calendar.md`.

### HR payroll engine

See `.claude/rules/hr-payroll.md` (auto-loads when editing `src/modules/hr/`). Headline rules: pure functions in `payrollCompute.js`; `computePayslip` prorates for both `join_date` and `end_date`, so any query feeding it must select both; SSF needs the enrolment flag **and** `ssf_no`; approved OT supersedes attendance OT per `bs_day`; `hr_tada_claims` has no period columns; Final Settlement writes draft-first; and HR's five approval queues share ONE status vocabulary in `payrollConstants.js`, where amber means open and brass means decided-but-unpaid.

### Page-revisit caching (`src/shared/sessionDataCache.js`, added S460)

Route-level pages unmount on navigation, so revisiting one re-fetches everything by default. `sessionDataCache.js` is a deliberately dumb `sessionStorage` key-value cache that does no calculation of its own.

**Before adding it to a page, check whether anything on it batch-saves "every visible row" trusting current on-screen state as the baseline** — that is the one shape where this pattern is actively dangerous rather than merely ineffective, because a stale cached number can be *written back* over a real figure. `Stock.js` and `Sales.js` both have that shape.

The adoption test, the pages deliberately left unwired, and why, are in `.claude/rules/frontend-performance.md`.

---

## Design conventions

### Design context (PRODUCT.md / DESIGN.md)

`PRODUCT.md` (strategic: users, positioning, brand personality, anti-references) and `DESIGN.md` (visual: colors, typography, components, extracted from the actual `Layout.css`/`ThemeContext.js` tokens) exist at the project root, written by the `impeccable` skill's `init`/`document` commands. Read them before any design-focused work — `DESIGN.md` in particular documents named rules (the Accent-Text Pairing Rule, the One Accent Rule, the One Signal Meaning Rule, the Chart Palette Rule) that are already enforced in code but weren't written down anywhere before this. `.impeccable/design.json` is the machine-readable sidecar; don't hand-edit it, regenerate via `/impeccable document` — which **defaults to sidecar-only here**; the usual right answer is the middle path, sidecar plus surgical `DESIGN.md` edits where the code has moved past it (S668), and a full `DESIGN.md` rewrite is a deliberate, user-approved call (S645, revised S662). See `.claude/rules/design-system.md`. (This line previously cited "flat-by-default elevation", a rule retired on 2026-07-12 when every preset gained a real `--theme-card-shadow`; card elevation is now uniform policy.)

### Design system — tokens, motion, class names, field states

See `.claude/rules/design-system.md` (auto-loads when editing CSS, components, pages or modules).
Headline rules: all colors are CSS variables, never hardcoded hex, and a signal color used as TEXT
takes the `*-text` variant while a FILL takes the base token; never build a multi-series chart
palette out of the semantic tokens (Recharts SVG props stay literal hex); motion uses the four
`--motion-*`/`--ease-*` tokens, and Recharts series animation is unreachable from CSS so every
series needs `{...chartMotion()}`; the radius/type scales are CLOSED sets defined in `DESIGN.md`;
reach for a global class (`data-table`, `btn`, `badge-*`, `form-input`, `form-select`, `page-header`/`page-header--split`) rather than
inline styles — an inline-styled control escapes the `:disabled` treatment, the `[aria-invalid]`
hook and the `@media (pointer: coarse)` 16px touch floor. There is no `badge-gold`. A table needs
at least one column that can absorb a squeeze, so `white-space: nowrap` goes on the unbreakable
ATOM (a date, an item name), never on the whole cell — every column nowrap and the table can only
overflow, which is not the same thing as scrolling.

### Component library (reusable)

See `.claude/rules/component-library.md` (auto-loads when editing components, pages or modules) for
the full table — `Tip`, `SearchableSelect`, `Fab`, `Modal`/`ConfirmModal`, `FieldError`,
`BsCalendarPicker`, `QtyInput`, `Calculator`, `ChartCard`, `StatPill`, `ReportPage`,
`RowDisclosure`, `ModuleGate`, `PremiumGate` — with the rationale behind each. Reach for one of
these before hand-rolling an overlay, a numeric field or a report shell.

### A gating wrapper cannot protect an eagerly-evaluated children expression (S601)

**JSX children are an ARGUMENT**: the expression is fully evaluated by the parent and handed over as a finished element tree, so a gate inside the wrapper never gets a say. `ConsolidatedPnl.jsx` passed its whole table as `ReportPage`'s `children` and crashed on **every** visit before `SuiteGate` even rendered. Only an early return, a guard at the call site (`{!stmt ? null : …}`), or a render prop can protect it — and the same applies to `banners`/`stats`/`note`/`filters`/`footnote`.

Detail in `.claude/rules/report-pages.md`.

### An overlapping load must not win the page (S601)

A closed native `<select>` fires `change` on every arrow keypress, so arrowing a 12-period list starts twelve concurrent loads and **the last response to land wins the figures** while the label is whatever was clicked last — which on Consolidated P&L drives the subtitle, print title, workbook and filename alike. `src/shared/hooks/useLatestRequest.js` is the one guard: call `periodReq.begin(id)` synchronously in the handler before any await, and `if (!periodReq.isCurrent(periodId)) return` after the last await and before the first setter.

**The key is the period id, not a counter**, and **it fails open**. The current adoption list (22 pages), the two properties behind those choices, and the pages still unswept are in `.claude/rules/frontend-performance.md`.

### A page reachable by URL needs the guard its nav item implies (S601)

`Layout.js` rendering a nav item only for `isAdmin || isOwner` is **not** a guard. `SuiteGate` gates on `suite_plan`, `PremiumGate` on plan/feature, `ModuleGate` on the module — **none of them checks a role.** Put the check in the page component itself, after every hook: `if (!isAdmin && !isOwner) return <Navigate to="/dashboard" replace />`.

This matters more than a plain leak, because the staff-isolation policies are **RESTRICTIVE SELECT filters**: a fenced table returns `{ data: [], error: null }`, indistinguishable from an empty period and invisible to `firstError()`. A POS PIN account reaching `/pnl` therefore rendered a complete, confident statement at **Net Profit = Revenue, 100% margin, in green** — not an error.

**Audit by grepping `Layout.js` for `minPosRole`/`minImsRole`/`minHrRole` and the `isAdmin || isOwner` render conditions, then checking each named route has a matching early return in its own component.** **A SUB-route has no nav item to audit and inherits nothing from its parent page (S647)** — `/purchases/new` and `/purchases/:groupId/edit` are typeable but appear in no nav, and turning a modal into a route makes its record id a URL parameter, so a filter the parent page did in memory has to become a real check.

The five pages this has recurred on, and what each one did or didn't leak, are in `.claude/rules/access-control.md`.

### A report page must not show a number it has not computed (S594)

See `.claude/rules/report-pages.md` (auto-loads when editing `ReportPage.jsx` or any reports
module). Headline rules: a failed read is not an empty period and must never render as one — use
`firstError(results)` / `ReportLoadError`, never `{ data } … || []`; a dropped WRITE error is silent
data loss and a guard that drops its READ error passes vacuously; the KPI strip does not render
while loading or after a failure; and a report that states a scope must state it everywhere the
report goes (subtitle, print header, workbook, filename).

### An error surfaced as `error.message` is not a message (S619)

`src/shared/errorText.js` is the ONE table turning a Supabase/Postgres error into a sentence its reader can act on, with two audiences (`'staff'` can only escalate; `'operator'` is the person who fixes it). `src/components/ActionError.jsx` is where that sentence goes — convert at the CALL SITE, never at render.

Two rules are load-bearing and a test asserts the first: **no message claims a failed write did not land** (a dead fetch does not prove that, and `items` has no `UNIQUE(client_id, name)`, so a retry over a committed insert silently creates a second item), and **a message names the CONSEQUENCE, not the constraint** — say what state the record is in now and how to get out of it. **Never destroy the technical detail**; it rides along as fine print.

The full table, the `ActionError`/`FieldError`/`ReportLoadError` family, and the ~20 call sites this replaced are in `.claude/rules/error-messages.md`.

### Every `type="password"` input needs an explicit `autoComplete`

Without one, Chrome guesses from `type` + surrounding context — and any `type="password"` field anywhere on the page makes it treat the nearest preceding text input as a login username, which has bled a saved login into unrelated fields (a `SearchableSelect` search box, a signup form) more than once (S329). Use `autoComplete="new-password"` on every PIN/account-creation field (POS Staff Add/Reset PIN, Enable Self-Service, trial signup), and `autoComplete="username"` / `"current-password"` on an actual sign-in form's email/password. PIN-pad login screens (POS/HR Self-Service) build their own keypad UI rather than a text input, so they're unaffected.

### Crest Staff — the employee app

See `.claude/rules/staff-app.md` (auto-loads when editing `src/modules/hr/selfservice/`, `webPush.js`
or the service worker). Headline rules: `/hr/self-service` is a **second installable PWA** with its
own manifest/icon/start URL, swapped onto the page at runtime; a day with no shift and a day whose
month is unpublished are identical in the data and must never look identical on screen; a failed
read is never an empty list; push only offers a button in the states where pressing it can work
(iOS-not-installed is checked BEFORE capability); 16px fields / 44px controls scoped to
`.self-service`, with `touch` props on the two inline-styled pickers; and the whole thing runs on
RPCs that already existed — no migration, no Edge Function deploy.

### Password policy, leaked-password protection, PIN vault, login pages

See `.claude/rules/auth-and-pins.md` (auto-loads when editing Login/ResetPassword/PosStaff/SelfService files, `weakPasswords.js`, or `supabase/functions/`). Headline rules: `MIN_PASSWORD_LENGTH` has an independent server copy; PINs are never raw auth passwords (peppered HMAC); the PIN vault is a deliberate weakening, PINs only, never staff passwords.

### Arithmetic in input fields

`src/utils/evalMath.js` is the single evaluator behind both `QtyInput` and the Quick Calculator. It is a hand-written recursive-descent parser, **never `eval()` / `new Function()`** — these are inputs where a pasted string reaches the evaluator directly, and it must keep working under a strict CSP. `evaluate()` returns `null` for anything malformed, including division by zero, so `Infinity` can never reach a saved quantity.

The three invariants from S623 (detection must cover everything `tokenize()` normalises; `QtyInput` never hands a raw unparseable string up; Escape's cancel is a ref, not state) are in `.claude/rules/input-arithmetic.md`, each with the live bug it came from.

### Purchases: qty/rate storage convention

`purchase_entries.qty` and `rate` are stored in **base units**, not purchase units:

- `stored_qty = entered_qty × conversion_factor`
- `stored_rate = entered_rate ÷ conversion_factor`

All downstream calculations (Stock, Variance, FIFO, Reorder) read these base-unit values directly.

### Every item is stored in its SMALLEST unit — `purchase_qty` is always 1 (S597)

See `.claude/rules/item-master-rates.md` (auto-loads when editing the IMS items or purchases
modules). Headline rules: `items.rate` is the price of ONE base unit and equals the generated
`per_uom_rate`, held by a `CHECK (purchase_qty = 1)`; `purchase_qty` no longer mirrors
`conversion_factor`; a purchase bill prefills `per_uom_rate × cf`, never `items.rate`; and a field
that is only arithmetic must not look like a field that is stored. Distinct from the
`purchase_entries` qty/rate convention above — different columns, different arithmetic.

### `billKeyOf`/`aging` are centralized in `purchasesHelpers.js` — but not everywhere

See `.claude/rules/vendor-payables.md` (auto-loads when editing IMS report files). Headline rules: `VendorReport.js` and `computeVendorPurchasingSection.js` deliberately keep local single-period copies; a phantom sub-paisa balance can come from three different layers (S502/S505/S510) — check all three. As of S580 it also covers **Supplier Contribution** (`/supplier-contribution`, Pro): `items` has no vendor column, so a supplier is only ever DERIVED — what sold, exploded into ingredients, split across the vendors that supplied them — and its net-spend figure must keep meaning exactly what `VendorReport.js` means by it.

### Sales Entry saves through one atomic RPC, not three round trips

`save_sales_day(p_period_id, p_bs_day, p_rows)` does delete + insert + cross-mode cleanup in a single transaction; `src/modules/ims/sales/persistSalesDay.js` is the only caller and serves both Daily and Bulk. It is deliberately **`SECURITY INVOKER`** — `sales_entries` carries RESTRICTIVE staff-isolation policies and INVOKER keeps every one enforced for free. Adding `SECURITY DEFINER` here would silently punch through that isolation; don't.

The legacy three-call fallback and when it can be deleted are in `.claude/rules/supabase-sql.md`.

### `recipe_ingredients` has no `client_id` column

Always scope ingredient fetches by recipe IDs first:

```js
const recipeIds = recipes.map(r => r.id)
supabase.from('recipe_ingredients').select('*').in('recipe_id', recipeIds)
```

### POS billing, shifts and the IMS handoff

See `.claude/rules/pos-billing.md` (auto-loads when editing `src/modules/pos/`). Headline rules: a closed bill that can't reach IMS is stamped `ims_posted_at IS NULL` and surfaced, never silent; `sales_entries` and `stock_movements` can diverge, so neither proves the other posted; order lines are replaced through `save_pos_order_items`, never delete-then-insert; a new way to slice a bill is a new `keyOf` passed to `computeGroupAmounts`, never a fourth copy of the proportional-discount arithmetic; delivery commission is measured against the ex-VAT, post-discount base and never `paid_amount`. That file also holds the module's colour vocabulary (`posSignals.js`) — reach for it before picking a colour anywhere in POS.

### Sub-recipe mirror items

See `.claude/rules/recipes-and-subrecipes.md` (auto-loads when editing Recipes.js, `recipeCost.js` or
the IMS recipe/stock-count modules). Headline rules: a recipe with `type = 'sub_recipe'` auto-creates
a mirror row in `items` with `is_sub_recipe = true`, so filter `.eq('is_sub_recipe', false)` out of
Item Master, Purchases, POs, Requisitions, Reorder Report and Supplier Price Tracker; a sub-recipe
can never appear in `stock_movements` and must not be written there; sub-recipes nest, so a cycle
guard must be a PATH set (not a visited set) or a shared base costs 0 on its second branch.

## When adding a new feature

See `.claude/skills/new-feature-checklist/SKILL.md` — invoke it before shipping any new page,
report or module feature. Nine steps: the `feature_flags` **DB column** (the one that breaks every
other client’s flag save when skipped) plus the tier set in `AuthContext.js`, route guards in
`App.js`, the `Layout.js` nav entry, `Tip` tooltips, the Help page, the `CHANGELOG/` entry and
E-drive mirror, Danger Zone registration in `admin-user-ops`, `RESTORE_ORDER` in the Export/Import
restore, and closing the entry in any `*_TODO.md` that carries the feature.

---

## Supabase / DB notes

- **A supabase-js call can hang forever — and `.abortSignal()` does not save you.** Every call `await`s `getAccessToken()` *before* it ever reaches `fetch(...)`, so when the auth layer stalls the AbortController is attached to nothing: the promise never resolves **and** never rejects, and a `try/finally` that resets a `saving` flag never runs. Guard any user-gating await with `withTimeout()` (`src/utils/withTimeout.js`) — a `Promise.race` against a wall clock is the only thing immune to where the hang is. Keep `.abortSignal()` alongside it; it's a complement, not a substitute. S449→S454 burned four rounds on this because each fix only covered the layer above the real one.
- **Why `getSession()` stalls, and the client-level fix (S455).** auth-js sets no timeout on its own network calls, and one never-settling refresh wedges `_acquireLock` permanently — freezing every query app-wide with no error anywhere until the tab is closed. `src/supabaseClient.js` passes `global.fetch` through `makeAuthTimeoutFetch()` (`src/utils/authFetchTimeout.js`), which bounds **only** `/auth/v1/` requests at 15s so the promise settles and the client self-heals. PostgREST and Storage traffic is deliberately left unbounded there — bound those per-call with `withTimeout()` instead.
- **SQL authoring rules live in `.claude/rules/supabase-sql.md`** (auto-loads when editing anything under `supabase/` or AuditLog.js): the RLS policy pattern and `(select auth.uid())` wrapping, one-permissive-policy-per-command, per-row helper-function costs, FK/index discipline, the REVOKE-vs-PUBLIC and per-signature grant gotchas, `log_audit()` trigger conventions, and the schema-migration workflow. It also now holds the Edge Function inventory and the restrictive staff-isolation policy families — **when creating a new business table, add it to every matching restrictive-policy list**, or a bare same-client policy re-opens the hole for whichever staff-account type's JWT touches it.
- **`profiles` does not follow the standard same-client pattern** — `profiles_select` RLS is self-or-admin only, so a raw `profiles` query run by a real client login silently returns nothing but the caller's own row. Use the `get_client_profile_names(p_client_id)` RPC to resolve another staff member's name; never a raw `profiles` query for anyone but the caller's own row. Session/profile-read details are in `.claude/rules/accounts-and-logins.md`.
- Generated columns, server-assigned numbers, the offline IndexedDB queue and the `settings` RLS history moved to the rules files that scope them: `per_uom_rate` → `.claude/rules/item-master-rates.md`; `pos_orders.order_no`/`invoice_no`/`comp_no` triggers, `offlineQueue.js` and `settings` → `.claude/rules/pos-billing.md`; the period-close preflight and the one-open-period index → `.claude/rules/closed-periods.md`.

### Two writes in one function can diverge, so one is never evidence of the other

A pattern worth recognising beyond POS. `writeSalesEntries` writes revenue to `sales_entries` and
then depletion to `stock_movements` inside a try/catch that swallows failures — deliberately, so a
depletion problem never blocks a bill closing. The consequence is that **a bill can have revenue
and no movements**, and a later guard that inferred "has this already posted?" from
`stock_movements` was therefore *wrong* rather than merely incomplete: it re-posted two bills'
revenue on real data (S573). Whenever a best-effort second write follows a primary one, the second
one's absence proves nothing — give each table its own link back to the source row and ask the
table you actually mean.

### A `try/catch` around a supabase call catches nothing

supabase-js **resolves** with `{ data, error }`; it does not throw on a database error. An RLS
refusal, a constraint violation, a `42703` — all arrive as a returned value. So
`try { await scopedUpdate(...) } catch (e) { … }` is inert: the catch can only fire on a bug in the
arguments, and every real failure passes through it untouched. Three blocks in `PosOrders.jsx` were
written that way, each with a `console.error` in the catch that had never once run (S654).

The same fact makes the bare form worse than it looks. `await scopedUpdate(...)` with nothing
destructured, or `const { data } = await …` without `error`, **discards the only evidence the call
failed** — and the code below then proceeds as though it succeeded. Two shapes are worth naming
because both shipped:

- **A guard that drops its read error passes vacuously.** The POS offline-sync replay checked
  `pos_orders.status` before overwriting an order another device might have billed — but on a
  failed read `data` is null, the `if` is false, and the replay proceeds. The check that exists to
  prevent the overwrite is precisely what stops working when the network does.
- **A failed poll that writes its empty result BLANKS live state.** `setKotStatusByTable({})` on a
  dropped read wipes every table's kitchen badge, which a waiter reads as "nothing has been
  started", not as a failed read. On a poll, return early and keep the last good value.

The decision each site needs is **fail loudly, retry, or genuinely swallow** — and it is per-site,
not per-file. Making all of them loud is its own bug: a till that throws red at a cashier holding up
a queue is worse than a stale reprint counter. The test for whether a failure belongs in front of a
user is whether there is an action they can take; if there is not, `console.error` is the honest
floor. Where a write fails *after* the thing it belongs to is already committed — a bill is closed
and numbered, so refusing it is not available — surface it non-blockingly and name the downstream
consequence, not the error (`PosOrders.jsx`'s `warnWrite` + floor banner is the reference).

### A bare `.select()` silently truncates at 1000 rows

Supabase sets PostgREST's `db-max-rows` to 1000. A `.select()` with no `.range()` that matches more rows than that returns the first 1000 with **no error and nothing in the data to say so** — every total summed from that array is then wrong, and wrong quietly, which is the dangerous part: it reads as a real figure until someone compares it against another source. Found live (S528) reporting 1000 movements / NPR 49,241 against a real 1753 / NPR 87,043.

Use `fetchAllRows(makeQuery)` (`src/shared/fetchAllRows.js`) for any read that can realistically exceed 1000 rows — transaction tables rather than master data. Two rules: it takes a **function** returning a fresh builder (a supabase-js builder is a one-shot thenable and cannot be awaited twice), and that query must carry a **unique tiebreaker in its sort** (`.order('id')` after the display order), or paging a non-uniquely-ordered query repeats a row on one page and skips it on the next.

**Decide by rows-per-what, not by table name, and count what the QUERY returns rather than what the function is named after.** A read narrowed in JS is bigger than it reads: `fetchYtdMap` looked scoped to one month while pulling the client's entire history. Per-employee-per-day and per-anything-per-month both cross 1000 inside one real client-year. And note the guard problem — truncation returns **no error**, so every `if (error)` check written against a failed read passes happily over a short one.

**Deliberately not wrapped:** single-parent reads (`.eq('order_id', X)` for one bill), `head: true` count queries, single-day reads, and id-bounded backfill lookups. Wrapping those would be noise.

**An `.in(column, ids)` filter is a URL as well as a row count (S629).** PostgREST spells the id list out in the request URL, so a few hundred uuids is already past what proxies and CDNs accept — a loud 414 — while the 1000-row cap still applies underneath. Reach for `fetchAllRowsChunked(ids, makeQuery)`, or `runChunkedByIds(ids, makeQuery)` for a write filtered the same way (sequential, first error wins, and **not** atomic — some chunks may already have landed).

The four sweeps (S528, S529, S613, S628), their per-table thresholds, and the two traps that cost rounds — a misplaced closing paren that only fails at runtime, and the stale `.eslintcache` that `npm run build:verify` exists to clear — are in `.claude/rules/frontend-performance.md`.
