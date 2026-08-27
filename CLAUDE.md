# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Where a new rule goes

**Default to `.claude/rules/`, not this file.** Everything here loads on *every* request, so a rule
that only matters while one module is open is paid for by every session that never opens it. Three
`/doctor` passes have now had to migrate sections out (2026-08-18, S605, S615), and between the last
two the root file regrew 7,052 chars in three days — not through carelessness, but because a new
rule has one obvious home and no single session can see that it is the fortieth to pick it.

Ask which file the rule is *reachable from*, not which file it is about:

- **Reachable from one module or a few files** → the matching `.claude/rules/*.md` (add a `paths:`
  entry, or start a new file), with a short pointer stub left here if a root-file read should still
  surface that the guidance exists.
- **Reachable from anywhere** → here. Safety-critical prohibitions ("never do X"), multi-tenant
  isolation, access control, and anything that must be present *before* someone thinks to ask.

A section can be split when both are true — the BS calendar keeps its rules here and its
table-provenance in `.claude/rules/bs-calendar.md`.

**Never embed a value that moves** (a cache version, a table count, a file count) in a rule that is
otherwise permanent: the rule stays correct while the number rots inside it, and a derivability
audit will not catch it because the rule around it genuinely is not derivable. Point at the file
instead.

---

## Stack

- **React 19 (CRA)** — no Vite, no custom webpack config, no TypeScript
- **Supabase JS v2** — single client at `src/supabaseClient.js`; anon key only in the browser bundle
- **Recharts** for charts, **SheetJS (xlsx)** for Excel exports
- **React Router v7** — all routes in `src/App.js`
- **Code splitting (S440)** — every page component in `App.js` is route-level `React.lazy(() => import(...))`; only structural pieces stay eager (contexts, `Layout`, `ProtectedRoute`, `ModuleGate`/`PremiumGate`). Keep new page routes lazy too. Two `Suspense` boundaries: one around `Layout.js`'s `<Outlet />` (so the sidebar persists during in-app navigation — only the content area shows `RouteFallback`) and a top-level one in `App.js` for the public routes. Any `import './x.css'` must stay **above** the lazy `const`s or ESLint's `import/first` fails the CI build. This cut initial JS from ~931 kB → ~165 kB gzipped (the rest lazy-loads as ~97 on-demand chunks)
- **`xlsx` is always `import('xlsx')` inside the click handler, never a top-level `import * as XLSX from 'xlsx'` (S522).** Route-level lazy-loading (S440 above) only defers a *page's own* code — it does nothing about a library that page statically imports, which webpack still must fetch as a parallel chunk the moment the route itself loads. `xlsx` (SheetJS) is genuinely huge (138 kB gzipped, the single largest chunk in the app after `main.js`) and is only ever touched by an explicit "Export Excel"/"Import Excel" click, never by simply viewing a page — so a static import was paying that 138 kB on every visit to any of the 37 pages that have an Excel button, whether or not the button was ever clicked. Fixed across all 37 by making the export/import handler function `async` and adding `const XLSX = await import('xlsx')` as its first line; verified in the built output (`r.e(1238).then(r.bind(r,1238))` now sits inside the button's `onClick`, not at module top level). Two files needed a different shape rather than a flat per-function fix: `SalesReport.jsx`/`CoversReport.jsx` share one `withLetterhead(title, ...)` helper across every tab's export branch, so `XLSX` is now its first parameter instead, passed down from the one `await import('xlsx')` in `exportExcel`; `MonthlyOwnerReport.jsx`'s `monthlyReportExcel.js` uses `XLSX` throughout a whole dedicated helper file, so instead of touching every internal function, the *page* now dynamically imports the whole module at click time (`const { exportMonthlyReportExcel } = await import('../../modules/ownerReport/monthlyReportExcel')`) and that file's own top-level `import * as XLSX from 'xlsx'` was left untouched. `recharts` (102 kB gzipped, the other large chunk) was deliberately left as a static import everywhere it's used — charts are core above-the-fold content on those pages, not a deferred click action, so eagerly loading it is correct per `/impeccable optimize`'s own rule against lazy-loading above-fold content.
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

**`plan` is the IMS plan and nothing else** (fixed S548). It used to be the MAXIMUM across `clients.plan`, `ims_plan`, `hr_plan`, `pos_plan` and `is_premium` — a revenue leak found live: a client at `plan='starter'` with `hr_plan`/`pos_plan` at `'pro'` resolved to Pro and got every IMS Pro feature having bought none. **Crest HR and Crest POS are yes/no modules with no tiers**, so `hr_plan`/`pos_plan` are vestigial columns — no longer read or written anywhere, and nothing should start. Anything asking "does this client have HR/POS" reads `hrEnabled`/`posEnabled`. (`ims_plan` was in that array too and **has never existed as a column** — `42703` against the live DB.) `is_premium` survived S548 as the last plan-raiser and was retired in S574: it appeared on no admin screen, in no MRR figure and in no control, so a Starter client carrying it received every IMS Pro feature while every surface said — and billed — Starter. Migration `20260818180000` folded it into `clients.plan` (`'pro'` wherever set) so no entitlement changed; the column is now vestigial like `hr_plan`/`pos_plan`. `plan` therefore resolves as plain `clients.plan`, no max over anything.

**Trial state lives in ONE column set** (S574): `is_trial` + `trial_start_date` + `trial_expires_at` + `trial_purge_at` — the set `register_trial` writes. `trial_ends_at` is vestigial (folded by migration `20260818190000`): it was a second trial column that only the admin "+ New Client" form wrote and only one badge fallback read, so admin-created and self-service trials were invisible to each other's screens. `createClient` now writes the canonical set (30 days; self-service gets 7). Related: the auto-deactivation sweep in `AdminClients.js` deliberately has **no trial clause** — `getAccessState` locks expired trials through its own `is_trial`/`trial_expires_at` branch without needing `is_active`, and a sweep clause on a column the lock model ignores meant merely opening Admin → Clients could hard-lock a client the runtime let through. And `getSubStatus`'s no-dates fallback returns an explicit **"No end date"** chip, never a silent "—": that state means unlimited free access (fails open, skipped by the sweep), so it is precisely the one an operator must notice.

**`false` in `feature_flags` is not a revoke.** `hasFeature()` only tests `flagVal === true`; `null`, `undefined` and `false` all fall through to the plan check identically, and `FeatureAccessModal`'s toggle only ever writes `true` or `null`. A stray `false` is inert. Assuming otherwise cost a round in S548 — a grandfather sweep used `COALESCE(flag, true)` to "preserve" those falses and under-granted three clients.

**`SuiteGate`** (`src/components/SuiteGate.js`, added S317 for Owner Dashboard) is a third gate type on a genuinely separate axis: `clients.suite_plan`. It differs from `ModuleGate`/`PremiumGate` in one important way: **it never redirects on failure** — an ineligible viewer sees an inline upsell/explanation rendered in place, since the feature's nav entry must stay visible regardless of eligibility. Used as an in-page wrapper inside the gated component, not at the route level; a nav item for a Suite feature therefore carries **no** `featureKey`/`minPlan`, or it would disappear instead of upselling.

**A billed axis must be visible on the screens that bill it (S552).** `suite_plan` was selected by `AdminDashboardOverview.jsx` and priced into `clientMRR()` at NPR 2,000/outlet, and rendered **nowhere** — the client list showed IMS/HR/POS pills off the three `*_enabled` flags and nothing for Suite, so a Suite Pro client looked identical to one without it while its revenue sat in the MRR figure on the same page. The Sub Status column tracks IMS only (plus a bolted-on HR hint), so a lapsing Suite was silent too. Both admin surfaces now carry a `★ SUITE` pill and the dashboard warns on `Suite exp. Nd` / `Suite lapsed`, resolving through the same `suite_ends_at → IMS window` fallback `clientMRR()` uses so the pill and the money can never disagree. **Anything added to `clients` that changes what a client pays needs a place in the admin list in the same change** — a module flag gets one for free by joining the pill map; an axis like this one does not.

**Suite has ONE tier** (S548): `suite_plan` is `NULL | 'pro'`. It was `starter|growth|pro`, but both call sites were `minTier="growth"` — so Suite Starter unlocked nothing at all and Suite Pro added nothing over Suite Growth on its own axis. It is also an **add-on priced per outlet on top of a client's modules**, not a bundle containing them: turning it on implies only that IMS is enabled (`requireModules`' floor) and says nothing about HR, POS, or which IMS tier the client is on. `requireModules` (array, default `['ims','hr']` — Owner Dashboard's original behavior) varies per feature; Monthly Owner Report, Demand Forecast and Fixed Assets pass `['ims']`. Don't assume every caller needs Owner Dashboard's set.

### Which tier a feature belongs in

Placement is by attribute, not by when it was built (framework from the S548 retier). Score against five: **persona altitude**, **prerequisite depth**, **frequency**, **value type**, **substitutability**. The tier thesis falls out of the fourth — **Starter = Record & Comply, Growth = Control, Pro = Strategy, Crest Suite Pro = Synthesis** (cross-module, owner altitude).

Two rules fall out of it, both of which had already been broken:

- **A feature must be able to produce a number on its own tier's data.** `reorder_report` and `stock_movement_log` sat in `STARTER_KEYS` while deriving their core figure from recipe explosion (`ReorderReport.js`'s `explodeRecipeIngredients`, `StockMovements.js`'s `subRecipeUsage`) — and `recipe_costing` is Growth. Starter clients were sold a Reorder Report with no consumption figure and a permanently empty ledger. Neither fails loudly; they render nothing, forever.
- **A statutory obligation never gates above the base tier**, and **a data-entry page must not sit above the tier of any figure that consumes it.** `vendor_balance_confirmation` (IRD Annexure 13) sat at Pro while `vat_report`/`non_vat_report` were always Starter; `overheads` sat at Pro while `ClientDashboard`, `OwnerDashboard`, `computeMonthlyReport` and `Recipes`' True Cost all read what it writes.

**Moving a feature between tiers requires a grandfather sweep in the same deploy.** `hasFeature()` is "plan tier OR explicit flag", so setting the flag `true` for affected clients restores prior access with no code change — that is what the `feature_flags` override exists for. Upward-*available* moves (a feature becoming available at a lower tier) need no sweep.

### The IMS figures that must come from one place (S551)

See `.claude/rules/ims-figures.md` (auto-loads when editing `imsFormulas.js`, stock count, or the
IMS report/summary modules). Headline rules: import `COGS_FORMULA` wherever the formula is PRINTED
and `computeUsed()` wherever it is COMPUTED (staff meals are in COGS); food-cost banding goes through
`fcBand(pct, settings)`, never a hardcoded copy; a settings field with no reader is worse than no
field; Stock Count's Summary holds two tables built from different loops that must be kept tying out;
and a variance-style report must default to a CLOSED period.
### Multi-outlet: one login, several clients (S548)

A group of outlets is several `clients` rows joined by `clients.group_id → client_groups`. An Owner switches between them from the sidebar; the Group Console (`/group-dashboard`, Suite Pro) rolls them up.

**The architecture is selected-outlet indirection, NOT policy rewriting.** `my_client_id()` appears in ~151 places across 18 migrations. Rewriting them to a set-returning `my_client_ids()` would touch every policy on ~50 tables and permanently widen RLS from "one client" to "any client in my group", removing RLS as the backstop behind `scopedDb`'s filter. Instead `profiles.active_client_id` was added and **only `my_client_id()` changed**, to `coalesce(active_client_id, client_id)`. Every policy keeps its exact shape and resolves to the selected outlet. The frontend gets it free: `useScopedDb` binds `clientId` from `AuthContext`, so one value re-scopes ~200 call sites and all 65 `CLIENT_SCOPED_TABLES`.

Both columns default NULL, so an ungrouped client is byte-identical to before — which is what makes this safe to have shipped across the whole book at once.

Five things to know before touching it:

- **`active_client_id` is privilege-bearing and must never be user-writable.** It decides which tenant every RLS policy resolves to. It is deliberately NOT on `guard_profiles_privileged_columns()`'s allow-list (S531 invariant #1); `set_active_outlet()` is the only write path, and under `SECURITY DEFINER` `current_user` is the owner so the guard passes it through — the same mechanism `record_pos_pin_attempt` relies on.
- **Membership is validated at WRITE time, not in `my_client_id()`.** That function runs per row across ~120 policies, so it stays a join-free `coalesce`; a trigger on `clients.group_id` clears stale selections instead.
- **`clients_select` is the one policy that had to widen** — it was `id = my_client_id() OR is_admin()`, so a customer could not read that a sibling outlet existed at all.
- **Group-spanning reads cannot go through scoped queries** — that's intended. `get_group_summary()` is `SECURITY DEFINER` with its own caller check, returns **raw aggregates** (the page derives food-cost %/labour %, so this doesn't become a fourth definition of those formulas), filters to `suite_plan = 'pro'` **server-side**, and returns excluded outlets by name so the page can state its coverage. A client-side filter would ship an unpaid outlet's revenue to the browser and then hide it.
- **Outlets keep independent periods** (`monthly_periods` is `UNIQUE(client_id, bs_year, bs_month)`), so align on `(bs_year, bs_month)`, never `period_id`. And **`pos_orders` has no `period_id` or BS columns** — only AD `closed_at` — while BS→AD conversion lives in JS, so the RPC takes `p_ad_start`/`p_ad_end` from the caller.

Suite Pro is sold **per outlet**, including inside a group, which is why the console shows only paid outlets and names the rest rather than silently under-reporting. Switching is blocked while the offline queue is non-empty (**both** `getQueue()` and `getPosOrderQueue()` — stock ops write against the current tenant just as POS orders do).

**Who may switch is `profile_outlet_access`, and it grants REACH, never RANK (S617).** An Owner reaches every outlet in the group; anyone else reaches their home outlet plus what they have been allowlisted into, at the same rank they already hold. Deliberately not a per-outlet role matrix — that would put a second rank rule into `AuthContext`, all three `hasXAccess` helpers and `is_client_owner()`. The table has **no write policy at all**, so `set_outlet_access()` is the only path, and a revoke clears `active_client_id` so it evicts rather than merely denying the next switch.

**HQ→branch master-data push is built** (`push_master_data`, S617), and three of its refusals are the rules, not the implementation. **`items.rate` is never pushed on update** — that is what the BRANCH pays its own supplier and the input to every costing figure it produces, so HQ's rate would put another city's prices into its food cost; it is seeded on create only, because the column is NOT NULL. **Selling price is a separate opt-in**, never swept along with the recipe definition. **An ingredient with no counterpart at the branch is reported, never dropped** — a recipe costed from a silently-shortened list is the wrong-number-nobody-questions shape. Records are matched on `master_id` (`items`/`recipes` have no `UNIQUE(client_id, name)`; only `categories` does), with **one** exception: the first push into a branch that already has data has no `master_id` yet, so it matches by name once, calls it `adopt`, and shows every one in the preview before writing. The preview IS the plan — a dry run computes into a temp table with pure SELECTs and the write pass applies from that same table, because two implementations of "what will happen" is how a preview comes to lie.

**Three defects sat in this feature from S548 until S617 and none were reachable, because no client has ever had a `group_id`.** Worth knowing as a shape: a feature with no users accumulates faults that every review passes over. `set_active_outlet()` and `get_group_summary()` each checked group MEMBERSHIP and called it authorisation, so the Owner-only rule lived only in React; `/group-dashboard` had no role guard at all while the command palette advertised it; and `active_client_id` was read in two places in `AuthContext` and never selected, so switching outlets would have left every scoped query filtering on the home id while RLS resolved to the new one — every client-scoped table returning zero rows with `error: null`.

### Subscription access — the third guard, and the one that used to enforce nothing (S544)

`ModuleGate`/`PremiumGate`/`SuiteGate` all answer "which features has this client bought". None of them answers "is this client still paying". Until S544 **nothing did**: `clients.is_active` and every `*_ends_at` column were read only by the admin UI — `is_active` appears in no RLS policy and nowhere in `AuthContext`/`Login`/`ProtectedRoute`, so a client marked Inactive, or lapsed years ago, kept full access forever. The Activate/Deactivate button was a badge colour.

`getAccessState(client)` in `src/utils/subscription.js` is now the single place that decision is made, sharing the "farthest end date across all modules" logic with `getSubStatus`. It is consumed as `accessLocked`/`accessReason`/`graceDaysLeft` from `AuthContext`, and enforced in **`ProtectedRoute`** — the one choke point every in-app route (IMS, HR, POS alike) passes through via `<ProtectedRoute><Layout /></ProtectedRoute>` in `App.js`. A locked client sees `SubscriptionLock.js` in place of the app. **Do not add this check per-page**: a per-page guard reopens the whole product the first time someone adds a route and forgets it, which is precisely how `is_active` came to mean nothing.

Four rules, each of which cost something to learn:

- **It fails OPEN.** A client with no end date on any module has never been given one — most of the existing book predates per-module dates — and must keep working. Only a date that exists *and* has passed locks anything.
- **`GRACE_DAYS` (7) exists because a lapsed invoice here is usually a collection delay**, not a decision to leave; cutting a restaurant off at midnight on the due date strands a live service. Expiry shows a countdown banner in `Layout.js` first, then locks. Trials get **no** grace — their expiry date *is* the decision point, and `trial_purge_at`'s retention window is about keeping the data, not access.
- **`AdminClients.js`'s auto-deactivation sweep must honour the same `GRACE_DAYS`.** It flips `is_active = false` for clients whose dates have all passed, and it runs on every visit to Admin → Clients. Since `is_active = false` is an *immediate* lock, sweeping at the raw expiry date silently defeated the grace period — a client would be cut off early because an admin happened to open a page. The sweep now measures against `now − GRACE_DAYS`; the manual Deactivate button is deliberately unaffected.
- **This is a UI gate, not a security boundary.** RLS still lets a locked client's JWT read and write its own rows. Real enforcement would mean an expiry check inside the RESTRICTIVE policy families on ~50 tables. Also note **two doors stay open** after the lock: HR Self-Service (`/hr/self-service` is mounted *outside* `ProtectedRoute`) and the public guest-menu ordering route (`get_guest_menu` gates on `pos_enabled` only).

### Client data Export / Import (S545)

See `.claude/rules/data-export.md` (auto-loads when working in `src/modules/admin/dataExport/` or the admin client screens). Headline rules: never ship the .xlsx without the .json; restore refuses non-empty clients; Archive > Delete.

### Three dashboards, deliberately not one

See `.claude/rules/dashboards.md` (auto-loads when editing dashboard files). Headline rules: /dashboard, /hr/dashboard and /owner-dashboard are different altitudes/gates — don't merge them; the `overheads` three-bucket trap (labor double-count) is documented there.

### Monthly Owner/Manager Report (frozen snapshot, S434)

See `.claude/rules/owner-report.md` (auto-loads when editing `src/modules/ownerReport/` or MonthlyOwnerReport.jsx). Headline rules: snapshot is captured at period close and never recomputed; resolve FK display values at generation time; `.eq('is_active', true)` on any figure valuing items.

### The four privilege invariants (S531 security review — do not regress these)

A full review on 2026-08-10 found that most of the app's access control was enforced one layer above where it was actually decided. Four rules came out of it, each of which had already been violated:

1. **`profiles` is the root of trust, so a client session may only write `full_name` and `last_seen_at` on it.** `profiles_update` was `USING (id = auth.uid() OR is_admin())` with no column restriction, so any user — including a POS PIN waiter — could PATCH `role = 'admin'` and read every tenant's data, or clear their own `pos_role`/`ims_role`/`hr_role`/`hr_self_service` to shed all four RESTRICTIVE isolation policy families at once *and* pass the negative `isOwner` test. `guard_profiles_privileged_columns()` (migration `20260810120000`) is a `BEFORE UPDATE` trigger enforcing this. It is an **allow-list** on purpose: a deny-list of today's privileged columns silently reopens on the next column added, which is exactly what happened to `admin-user-ops`' conditional-write list with `pos_team` (S431) and `pos_discount_limit`/`pos_allow_void` (S517). It is also deliberately **SECURITY INVOKER** — it keys off `current_user NOT IN ('anon','authenticated')` to let the service role and every `SECURITY DEFINER` body through (e.g. `record_pos_pin_attempt` writing another user's lock columns during an anonymous PIN login), and under `SECURITY DEFINER` `current_user` would be the owner every time and the check would never fire. **Adding a column to `profiles` requires no change here; adding a genuinely user-editable one does.**
2. **A staff-management action must verify what its target *is*, not just which client it belongs to.** Every reset/delete/role action in `admin-user-ops` checked only `targetProfile.client_id === profile.client_id` — and the Owner shares that `client_id`. Combined with `get_ims_eligible_users` handing the Owner's real email to any same-client caller, a module manager could reset the Owner's password and log in as them. `requireStaffTarget(target, module)` now refuses any target that is not already a staff account of that module (marker per module mirrors that module's own RLS predicate: `pos_email` / `ims_role` / `hr_role`), or that is an admin. Admin callers are exempt from the marker requirement — resetting a locked-out Owner's password is legitimate operator support.
3. **A lockout the client calls around an operation is not a lockout.** POS and HR Self-Service both had `check_*_pin_lock` before and `record_*_pin_attempt` after, in the browser, with nothing server-side consulting them — so skipping the two RPCs walked a 4-digit PIN unimpeded. Both now run **inside** `pos-staff-login` / `hr-selfservice-login`, on the same request that signs in. Corollary: the frontend must **not** also call `record_*_pin_attempt`, or every failure double-counts and locks a fat-fingered employee out in 3 attempts instead of 5. Same reasoning applies to any future server-side check — if the browser can skip the call, it is advisory. **The POS close was the same shape and was fixed the same way in S576** — the discount cap (`pos_discount_limit`) and the void permission (`pos_allow_void`) were both React, over a plain same-client `FOR ALL` policy that hands every till session UPDATE on its own orders. It is now `guard_pos_order_close()`, a BEFORE UPDATE trigger rather than the `close_pos_order(...)` RPC the critique proposed: an RPC protects only the callers that choose to call it and leaves the open policy in place, while a trigger sees every write to the table. Note what it deliberately does *not* enforce — `paid_amount`, because re-deriving the bill total in SQL would be a second copy of the VAT-and-rounding arithmetic, and a drifted copy would reject real bills mid-service rather than merely misreport a number. **Item-level comp was the third and last of the family (S579)**: `guard_pos_item_comp()` fences the comp columns on `pos_order_items` while `apply_pos_item_comps` stays `SECURITY DEFINER` and so remains the only write path — and that RPC now checks Supervisor *rank* (it had only ever checked client) and derives `comped_by` from `auth.uid()` instead of a caller-supplied parameter. **Attribution the subject of the attribution can choose is not attribution**; `comped_by` is what the Sales Exception Report ranks staff by, so a caller able to pass any uuid could comp under a colleague's name.

**Wrap every authorisation condition in `COALESCE(..., false)`.** `pos_role` is NULL for any account with no POS access, `NULL IN ('supervisor','manager')` evaluates to NULL rather than false, `NULL OR false` is NULL, and `IF NOT NULL THEN` never fires — so the natural form of a rank check falls open for exactly the accounts that have no rank. The same shape was already sitting in `apply_pos_item_comps`' original client check (a caller with no `profiles` row made both operands NULL) and was wrapped at the same time. This is the `is_admin()`-returns-NULL trap in a second guise; assume any three-valued expression in a guard is a fail-open until it is wrapped.
4. **A secret must not live on a row the subject of the secret can read.** `clients.pos_device_secret` and `settings.pos_webhook_secret` were both readable by every account of the client (`clients_select`/`settings_select` allow same-client, and S316's restrictive staff policies on `settings` cover INSERT/UPDATE/DELETE only, never SELECT). Both now live in **`client_secrets`**, admin-only at the RLS level, reached otherwise through `get_pos_device_secret()` (checks admin/Owner/POS-manager rank) or the service role inside an Edge Function. Note Postgres has **no column-level RLS**, and the REVOKE-then-GRANT-per-column alternative breaks `select('*')` (real callers: `SettingsContext.js:69`, `AdminClients.js:71`) and fails closed on every column added later — a separate table is the only clean answer. `client_secrets` is deliberately **not** audited: `log_audit()` stores full row snapshots and would put both secrets in `audit_logs` in plaintext.

`is_client_owner()` (added by `20260810130000`) is now the **third** copy of the negative Owner test, alongside `isOwner` in `AuthContext.js` and `isCallerOwner` in `admin-user-ops/index.ts`. A new staff-account marker column must be added to **all three** — miss one and Owner detection breaks silently and in the permissive direction.

**Security headers live in `vercel.json`, and that file cannot carry comments** — it is strict JSON validated against Vercel's schema, which rejects any unknown property, so the usual `"//": "why"` trick fails the *build* rather than being ignored (found the hard way: the first deploy of these headers errored with ``headers[1].headers[0]` should NOT have additional property `//``). The rationale therefore lives here:

- **`script-src 'self'` with no `'unsafe-inline'`** is only viable because the production build emits a single external `<script src=/static/js/main.*.js>` and no inline runtime chunk — verified against real build output, and re-checkable with `grep -o "<script[^>]*>" build/index.html`. If a future CRA/webpack change starts inlining the runtime, every page will fail to boot with a CSP violation in the console; the fix is `INLINE_RUNTIME_CHUNK=false`, **not** adding `'unsafe-inline'` back.
- **`style-src` does allow inline**: the Google Fonts stylesheet is an external `<link>`, and chart/UI libraries inject `<style>` elements at runtime. React's own `style={{}}` prop sets CSSOM properties directly and is not subject to CSP at all.
- **`X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'`, not `DENY`/`'none'` (corrected S604).** Both shipped at their strictest in the S531 review, and `DENY` blocks framing *including same-origin* — which silently killed **Admin → Guest Menu Preview**, whose whole design is an `<iframe src>` of the real public route so the preview is byte-for-byte what a guest sees rather than a second component to keep in sync. It had never worked in production and nobody knew, because `vercel.json` headers do not apply to the CRA dev server: on localhost the preview renders perfectly, so every review of that page passed. **Anything verified only on `npm start` is unverified against the header stack** — reach for `curl -I` on the deployed URL. The relaxation is deliberate and small: `'self'` permits only our own origin to frame us, and clickjacking requires an *attacker-controlled* framing page, which `'self'` grants nobody. An attacker who could serve a page from our origin already has XSS, at which point framing is moot. Both keys had to move together — modern browsers prefer `frame-ancestors` and older ones honour `X-Frame-Options`, so leaving either at its strictest keeps the frame blocked. Note this does **not** affect `PosOrders.jsx`'s bill-preview iframe, which uses `srcDoc` (no HTTP response, so neither header is consulted) and is instead governed by the parent's `style-src 'unsafe-inline'`.
- **`connect-src` is the control that matters most** — it is the exfiltration boundary. Supabase (REST + realtime websocket + storage) plus the two nutrition APIs (`usdaNutrition.js`, `NutritionEditorModal.jsx`), and nothing else. `wa.me` is only ever a navigation target, never fetched, so it needs no entry. **Adding any new third-party API call requires adding its origin here or it fails silently in production and works fine in dev.**
- The print/KOT windows are unaffected: their templates are script-free, and `w.print()` is called from the *opener*, not from inline script in the written document.
- **A service worker inherits the CSP served with its own script**, so `public/service-worker.js` is bound by the same `connect-src` — any `fetch()` it makes to an origin not on that list is blocked. Combined with `cache.put()` rejecting on opaque cross-origin responses, that made intercepting third-party requests strictly lose-lose, so the fetch handler now returns early on `url.origin !== self.location.origin` (which also subsumes the older Supabase-specific skip). Don't reintroduce cross-origin handling there.

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

Three independent rank axes on `profiles` — `pos_role`, `ims_role`, `hr_role` (each `staff|supervisor|manager`, `NULL` = no access to that module at all) — checked via `hasPosAccess(minLevel)` / `hasImsAccess(minLevel)` / `hasHrAccess(minLevel)` in `AuthContext.js` (`POS_RANK`/`IMS_RANK`/`HR_RANK`, identical `{staff:1,supervisor:2,manager:3}` shape, deliberately mirrored — IMS copied POS's shape at S417, HR copied IMS's at S430). A staff account having one of these set implies nothing about the other two — a POS PIN account with no `ims_role` is correctly blocked from every IMS page. Admin/Owner always resolve to `'manager'` on all three — **which makes the resolved ranks (`posRole`/`imsRole`/`hrRole` from `useAuth()`) the WRONG test for "is this a staff/till session"**: gate any staff-only behaviour on the raw `profile.pos_role` (etc.) column, never the rank. Layout.js's `isPinStaff` exists because gating the POS idle lock on the rank signed every admin/Owner out after 3 idle minutes on any machine that had ever completed POS device binding (S583, reported as a session mystery). `isOwner` is a **negative** test (`role==='client'` with none of `pos_role`/`ims_role`/`hr_role`/`hr_self_service` set) — assigning any one of these to an account deliberately demotes it out of Owner-level access, so a new staff-account marker must be added to every `isOwner`/`isCallerOwner` computation (`AuthContext.js` and `admin-user-ops/index.ts` both) or it silently breaks Owner detection for every other marker.

Each axis gates two things that must both be kept in sync when adding a page: the **route guard** (`if (!hasXAccess(minLevel)) return <Navigate to="/dashboard" replace />` inside the page component itself) and **nav visibility** (a `minPosRole`/`minImsRole`/`minHrRole` tag on the `Layout.js` nav item, read by the shared `isItemVisible()` predicate that also drives the command palette and pinned favorites). A page with one but not the other is either unreachable-but-still-linked, or reachable-but-hidden — a dashboard/summary page that's the redirect *target* of a guard is the easiest place to miss this, since it's tempting to assume the redirect target is inherently safe (see S430's dashboard leak in the README session log, where the redirect target itself leaked the data every other page was gated to protect).

`pos_team` (`foh|kitchen|bar`, default `foh`, added S431) is a separate, **orthogonal** axis on `profiles` — which physical station a POS account works, independent of `pos_role`'s rank (a kitchen-team account can be Staff or Manager rank; the team axis only changes what's in its nav, not what its rank permits). Gated by an explicit allowlist (`Layout.js`'s `KITCHEN_TEAM_ALLOWED_PATHS`) rather than per-item tags — fail-closed, so a newly-added POS page is hidden from kitchen/bar by default until someone deliberately adds it to the list. `KitchenDisplay.jsx` additionally uses it to lock the KOT/BOT ticket-station toggle (not the same "station" concept — `pos_kot_log.station` is the ticket's printer routing, unrelated to the staff `pos_team` column) to the account's own queue.

`pos_discount_limit` (nullable numeric %, `NULL` = unlimited) and `pos_allow_void` (boolean, default `false`, added S517) are two more per-staff overrides on `profiles`, same family as `pos_team` — a manager sets them per staff member on `/pos/staff` (POS Staff), and both are enforced in `PosOrders.jsx` against `profile.pos_discount_limit`/`pos_allow_void` from `useAuth()` (never against rank alone — a Supervisor isn't automatically capped/voidable, only whoever has the flag set). **`admin-user-ops`'s `update_pos_role` action must build every field it writes conditionally** (`if (x !== undefined) updatePayload.x = x`), never unconditionally as `x || null` — `updateTeam`/`updateDiscountLimit`/`updateAllowVoid` each call this one action with only their own single field in the request body, so any field written unconditionally gets silently reset to its default on every other field's update. This bit `pos_role` itself: it was unconditional from the start (only `pos_team` got the conditional treatment when added at S431), so setting a staff member's Discount Limit or Allow Void was silently wiping their role to "No Access" — found live smoke-testing S517 against a real staff account, fixed by making `pos_role`/`pos_job_title` conditional too. Any future field added to this same staff-permission family must follow the conditional pattern from the start, not retrofit it after the same bug repeats.

### Who logs in where, and how an Owner account comes to exist

See `.claude/rules/accounts-and-logins.md` (auto-loads when editing AuthContext, Login, or any
staff/employee management screen). Headline rules: there are three front doors (`/login` for Owner,
IMS staff, HR staff and admin; `/pos/login` and `/hr/self-service` for PINs) and an owner never uses
a PIN; **Owner is the ABSENCE of staff markers, so giving the owner's own login a staff role demotes
them**; and `hr_employees.status` is payroll eligibility only — `access_blocked` is what revokes a
Self-Service login.
### Splitting a page component once it outgrows one file

As of 2026-07-06, the six pages that had grown past 1,200 lines (`AdminClients.js`, `Roster.jsx`, `Dashboard.js`, `Purchases.js`, `Recipes.js`, `PosOrders.jsx`) were each split, using whichever of these fits what's actually inside — don't force a pattern that doesn't match:

- **Already-self-contained sub-component sitting in the same file** (a modal or panel with its own local state, just not in its own file yet) → move it verbatim into a same-name subfolder (e.g. `src/pages/adminClients/ClientDrawer.js`). Pure relocation, no behavior change — a near-identical production bundle hash is the sanity check.
- **One file secretly rendering two unrelated views behind a boolean** (e.g. `Dashboard.js`'s admin-overview vs. per-client view, sharing almost no state) → split along that boolean into two components, each with its own `useAuth()`/data loading, and leave the original file as a thin router.
- **Genuinely tangled state with no existing seam** (e.g. `Purchases.js`'s bill-entry form, `Recipes.js`'s nutrition editor) → extract a new self-contained component that owns its own form state and reports back through a single `onSaved(...)`/`onChanged()` callback, rather than lifting the state up and prop-threading it.

**A page with more than one `return` will happily render your new UI where nobody can reach it.** `PosOrders.jsx` early-returns the order screen (`if (view === 'order') return (...)`) and then falls through to the floor view — two completely different trees. A modal added at the tail of the file lands in the floor view; if the handler that opens it lives on the order screen, pressing the button sets the state, blocks correctly, and shows *nothing*. It compiles, passes every detector, and reads correctly in review (S578). Check which return a handler lives in before placing its modal, and prefer a live click over any amount of static checking to confirm it.
- **Pure HTML/string builders that close over component state** (receipt/KOT print templates) → parameterize them explicitly and move to a plain `.js` file (see `posOrderPrintHtml.js`, `creditNoteHtml.js`) so the same builder can back both the real print path and a live preview without duplicating logic.

For a high-traffic, stateful screen (`PosOrders.jsx` — live order-taking, billing, offline sync), prefer the smallest safe cut (pure builders/constants only) over a full architectural split — the risk of a subtle real-time bug that only surfaces on a live device outweighs the line-count win.

### Bikram Sambat (BS) calendar

All periods and dates in the app use the Nepali calendar. Key utilities in `src/utils/bsCalendar.js`:

- `bsToAd(year, month, day)` → JS Date
- `adToBs(date)` → `{ year, month, day }`
- `formatAd(date)` → `YYYY-MM-DD` from the Date's **local** getters
- `bsDayBoundaryIso(y, m, d, endOfDay)` → an AD instant carrying Nepal's `+05:45`

- `daysInBsMonth(year, month)` — each BS month has a different number of days (28–32); never assume 30
- `getBsToday()` → current BS date
- Nepal fiscal year runs **Shrawan (month 4) → Ashadh (month 3)** of the following BS year

The lookup table covers BS 2000–2087 (extended from 2079–2087, S559). Out-of-range years fall back to a 30-day approximation.

The lookup table's provenance — how BS 2000–2087 was cross-verified, why 2084–2087 are deliberately
left alone, and what `BS_YEAR_MIN`/`BS_YEAR_MAX`/`adToBsSafe` are actually for — lives in
`.claude/rules/bs-calendar.md`, which auto-loads when editing `bsCalendar.js` or
`BsCalendarPicker.js`. Read it before extending the table.

**A day inside a chosen period renders as `formatBsDay(day, bsMonth)` — "1st Bhadra" (S614).** Every
period-scoped Day column in IMS printed a bare number and leaned on the page header to say which month
it was; that stops working the moment the sheet is printed, scrolled past, or read back later. Two
properties are load-bearing: an absent or out-of-range month **degrades to the bare ordinal rather
than naming the wrong month**, and day 0 (Sales' Bulk-entry sentinel) returns `''` so each caller
keeps its own dash. It is deliberately NOT the full-date form (`1 Bhadra 2083`, what DemandForecast
and the pickers render) — this one names a day inside the period you already chose, so it carries no
year. Use `bsDayOrdinal(day)` alone where the month is already stated beside it. **Excel exports keep
the numeric Day column** — text breaks a spreadsheet's sorting and filtering.

**`BS_MONTHS` has exactly one definition and it lives here.** It was copy-pasted into 31 files until
S614 (all byte-identical, so nothing rendered wrong — it was simply a list that only had to be edited
once to disagree with itself). Three of those 31 hid from a `^const BS_MONTHS =` grep: one held the
same twelve strings under a different name (`BS_MONTH_NAMES`), one wrapped the array across two lines,
and one declared it inside a component body. Import it; never retype it.

**Never `.toISOString()` a Date that came from `bsToAd`.** It returns local midnight, so at Nepal's UTC+05:45 `.toISOString()` lands at 18:15Z on the *previous* day and `.slice(0,10)` yields the wrong date for every user in the country. This shipped twice: `ClientDashboard` documented and worked around it, then `GroupDashboard` reintroduced it and silently shifted both bounds of the multi-outlet comparison by a day (fixed S550 by lifting the helper into `bsCalendar.js`). Use `formatAd` where a bare date string is wanted — including any RPC declaring its parameter as `date`, which is what `get_group_summary` does — and `bsDayBoundaryIso` where the value is compared against a real `timestamptz` such as `pos_orders.closed_at`.

### HR payroll engine

See `.claude/rules/hr-payroll.md` (auto-loads when editing `src/modules/hr/`). Headline rules: pure functions in `payrollCompute.js`; monthly pay prorates for `join_date`; `payrollData.js` helpers must be robust to what Finalize changes (S565 Stale-badge trap); `hr_tada_claims` has no period columns. As of S570: SSF needs enrolment flag **and** `ssf_no` (three call sites must agree); approved OT supersedes attendance OT per `bs_day` (so OT queries must select `bs_day`); Payroll Run blocks Finalize on a stale draft. As of S600: Final Settlement WRITES (draft-first, then advances/employee/login, then finalize) and `computePayslip` prorates for `end_date` as well as `join_date` — so any query feeding it must select `end_date`; gratuity is one shared module whose SSF offset counts only the months contributions were actually made.

### Page-revisit caching (`src/shared/sessionDataCache.js`, added S460)

Route-level pages unmount on navigation, wiping local `useState` — so revisiting a page (Dashboard → Stock → Dashboard) re-fetches everything from scratch by default, which is a real chunk of the app's felt slowness on top of the usual network latency. `sessionDataCache.js` is a deliberately dumb `sessionStorage` key-value cache (`readPageCache(page, section, clientId)` / `writePageCache(...)`, 10-minute max age, keys namespaced per page so two pages can each have their own `items` section without colliding) — it does no calculation of its own, just storage, so adopting it never touches a page's actual data-fetching or math. The pattern: seed each relevant `useState`'s initial value from the cache (`useState(() => readPageCache(...) ?? fallback)`) so a revisit paints instantly, and wrap the existing setter calls in a small local `setAndCache(setter, section, value)` helper that also persists to the cache — no other change to the load function.

**Before adding this to a new page, check whether anything on it batch-saves "every visible row" trusting current on-screen state as the baseline** — that's the one shape where this pattern is actively dangerous, not just ineffective. `Stock.js`'s "Save All" (writes every visible item's currently-shown count, not just user-edited ones) and `Sales.js`'s per-mode save (merges typed edits against "the current saved value" as a fallback for every *other* item) both have this shape, and for a POS-enabled client `sales_entries` keeps changing in the background all day as bills close — so a stale cached number reaching one of these saves could silently overwrite a real figure. `Sales.js` only caches `periods`/`recipes` (the menu/period list, never a save-time baseline) for exactly this reason; `Stock.js` was left with no caching at all, since on that page essentially everything load-bearing is save-sensitive. Pages where saving only ever writes the one record being edited (`Purchases.js`, `Recipes.js`, `ClientDashboard.jsx` which never saves at all) are safe for the full treatment — confirm which shape a new page has before wiring this in, don't assume.

`AuthContext.js`'s own `fetchProfile()` waterfall (`profiles` → `clients` → `feature_flags`) was also part of this same pass — `clients` and `feature_flags` only depend on `client_id`, not on each other, so they now run as `Promise.all` instead of two sequential round trips.

---

## Design conventions

### Design context (PRODUCT.md / DESIGN.md)

`PRODUCT.md` (strategic: users, positioning, brand personality, anti-references) and `DESIGN.md` (visual: colors, typography, components, extracted from the actual `Layout.css`/`ThemeContext.js` tokens) exist at the project root, written by the `impeccable` skill's `init`/`document` commands. Read them before any design-focused work — `DESIGN.md` in particular documents named rules (the accent-text pairing rule, the one-accent rule, flat-by-default elevation) that are already enforced in code but weren't written down anywhere before this. `.impeccable/design.json` is the machine-readable sidecar; don't hand-edit it, regenerate via `/impeccable document`.

### Design system — tokens, motion, class names, field states

See `.claude/rules/design-system.md` (auto-loads when editing CSS, components, pages or modules).
Headline rules: all colors are CSS variables, never hardcoded hex, and a signal color used as TEXT
takes the `*-text` variant while a FILL takes the base token; never build a multi-series chart
palette out of the semantic tokens (Recharts SVG props stay literal hex); motion uses the four
`--motion-*`/`--ease-*` tokens, and Recharts series animation is unreachable from CSS so every
series needs `{...chartMotion()}`; the radius/type scales are CLOSED sets defined in `DESIGN.md`;
reach for a global class (`data-table`, `btn`, `badge-*`, `form-input`, `form-select`) rather than
inline styles — an inline-styled control escapes the `:disabled` treatment, the `[aria-invalid]`
hook and the `@media (pointer: coarse)` 16px touch floor. There is no `badge-gold`.
### Component library (reusable)

See `.claude/rules/component-library.md` (auto-loads when editing components, pages or modules) for
the full table — `Tip`, `SearchableSelect`, `Fab`, `Modal`/`ConfirmModal`, `FieldError`,
`BsCalendarPicker`, `QtyInput`, `Calculator`, `ChartCard`, `StatPill`, `ReportPage`,
`RowDisclosure`, `ModuleGate`, `PremiumGate` — with the rationale behind each. Reach for one of
these before hand-rolling an overlay, a numeric field or a report shell.
### A gating wrapper cannot protect an eagerly-evaluated children expression (S601)

`ConsolidatedPnl.jsx` passed its whole table as `ReportPage`'s `children`. `ReportPage` renders
`children` only once the page has loaded — but **JSX children are an ARGUMENT**: the expression is
fully evaluated by the parent and handed over as a finished element tree, so the gate inside the
wrapper never gets a say. `pnl` is `useState(null)` and `loading` is `useState(true)`, so
`LINES.map(l => … pnl[l.key] …)` ran on the first render and threw on `revenue`. It crashed on
**every** visit for a single-outlet client, before `SuiteGate` even rendered — so the entitlement
gate could not stop it either. Only an early return, a guard at the call site (`{!stmt ? null : …}`),
or a render prop can protect it. The same applies to `banners`/`stats`/`note`/`filters`/`footnote`:
`ReportPage` suppresses them while loading or after an error, but the caller still *evaluates* them.

Related, from the same audit: **`banners` is no longer rendered over the error card.** A banner is
derived from state the caller set before the read, so ConsolidatedPnl's "Provisional — this period is
still open… the statement is reliable once the period is closed" printed directly above ReportPage's
own "Nothing here is a real figure — this is a failed read". Two contradictory sentences, one of them
asserting a statement exists.

### An overlapping load must not win the page (S601)

Every period-scoped page had the same handler: `setSelectedPeriod(…)` → `setLoading(true)` →
`await buildReport(id)` → `setLoading(false)`, with the load setting its data whenever it resolved.
Nothing identified which load was current. A closed native `<select>` fires `change` on every arrow
keypress, so arrowing a 12-period list starts twelve concurrent loads — each a `Promise.all` of eight
to eleven queries — and **the last response to land wins the figures while `selectedPeriod` is
whatever was clicked last**. On Consolidated P&L that label drives the subtitle, the print title, the
Excel `scopeLine` AND the downloaded filename, so one month's figures could leave the building inside
another month's workbook.

`src/shared/hooks/useLatestRequest.js` is the one guard, now on **21 pages (measured by grep,
2026-08-26)** — the S601 sweep claimed 19 while never wiring `ConsolidatedPnl.jsx` or
`StockAgeing.js`, the two pages this rule's own text is about; both were caught by the S612
critique re-run and wired then. Call `periodReq.begin(id)`
synchronously in `handlePeriodChange` before any await, and
`if (!periodReq.isCurrent(periodId)) return` after the last await and before the first setter.

Two properties worth not re-deriving. **The key is the period id, not a counter** — these loaders are
also called after a save, after a period close, on a manual refresh, and none of those go through
`handlePeriodChange`; a counter would treat every one as stale and silently discard a legitimate
reload. And **it fails open**: before any `begin()` the ref is null and `isCurrent()` returns true, so
a page that adopts the check and forgets the claim degrades to the old racy behaviour rather than
rendering permanently blank. Of the two possible mistakes only one is recoverable by the user — which
is also why a page's own `init()` needs no `begin()`: once the handler claims, init's stale load is
correctly rejected on its own.

**Not swept:** `AttendanceSheet.jsx` and `Overtime.jsx` (their loaders are `useCallback` with a
different signature — `loadEntries(bsYear, bsMonth)` would need a composite key), and
`SupplierPriceTracker.js`/`MonthlyOwnerReport.jsx`, which select an id and derive rather than load.

### A page reachable by URL needs the guard its nav item implies (S601)

`/pnl` and `/owner-dashboard` are rendered in `Layout.js` only for `isAdmin || isOwner`, but both sat
inside `ProtectedRoute` + `SuiteGate` alone and **neither of those checks a role**. `SuiteGate` gates
on `suite_plan`; `PremiumGate` on plan/feature. Nothing gated on who was asking.

The consequence was worse than a leak, and it is the reason this deserves its own rule. The
staff-isolation policies (S316/S419/S430) are **RESTRICTIVE SELECT filters**, so a fenced table
returns `{ data: [], error: null }` — indistinguishable from an empty period, and invisible to
`firstError()`. A POS PIN account reaching `/pnl` had `sales_entries` readable while `items`,
`opening_stock`, `closing_stock`, `purchase_entries`, `overheads` and every `hr_*` table came back
empty, so the page rendered a complete, confident statement with real Revenue, COGS NPR 0, Gross
Profit = Revenue and **Net Profit = Revenue at a 100% margin, in green**. `MonthlyOwnerReport` — the
third page behind the identical nav condition — has always carried
`if (!isAdmin && !isOwner) return <Navigate to="/dashboard" replace />`. Copy that line; place it
after every hook, and rely on `ProtectedRoute` having already resolved `profile`.

### A report page must not show a number it has not computed (S594)

See `.claude/rules/report-pages.md` (auto-loads when editing `ReportPage.jsx` or any reports
module). Headline rules: a failed read is not an empty period and must never render as one — use
`firstError(results)` / `ReportLoadError`, never `{ data } … || []`; a dropped WRITE error is silent
data loss and a guard that drops its READ error passes vacuously; the KPI strip does not render
while loading or after a failure; and a report that states a scope must state it everywhere the
report goes (subtitle, print header, workbook, filename).
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

`src/utils/evalMath.js` is the single evaluator behind both `QtyInput` and the Quick Calculator. It is a hand-written recursive-descent parser, **never `eval()` / `new Function()`** — these are inputs where a pasted string reaches the evaluator directly, and the grammar (`expr → term → factor`, supporting `+ - * / ( )`, unary minus, `×`/`÷` glyphs and comma separators) can only ever produce a number. It also keeps working under a strict CSP. `evaluate()` returns `null` for anything malformed — including division by zero, so `Infinity` can never reach a saved quantity — and every caller reads `null` as "not an expression, leave the user's input alone" rather than as an error to surface. `looksLikeExpression()` gates the whole deferred-commit path: a plain `146` or a leading-minus `-5` is not an expression and must keep behaving exactly as a bare `<input type="number">` did.

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

`save_sales_day(p_period_id, p_bs_day, p_rows)` (migration `20260727120000`) does delete + insert + cross-mode cleanup in a single transaction; `src/modules/ims/sales/persistSalesDay.js` is the only caller and serves **both** Daily (`bsDay` 1–32) and Bulk (`bsDay` 0) — they're the same operation, the 0 just flips which side the cross-mode cleanup supersedes. It was three separate HTTP requests until S456, which meant a stall between the delete and the insert left the day's rows deleted with nothing written back (a live smoke test measured one round trip at 12.4s against sub-second neighbours, so this was reachable, not theoretical).

The function is deliberately **`SECURITY INVOKER`** (i.e. no `SECURITY DEFINER`). `sales_entries` carries RESTRICTIVE staff-isolation policies (`no_self_service_accounts`, `no_hr_role_staff`) on top of the permissive client-scoping ones, and INVOKER keeps every one of them enforced for free. Adding `SECURITY DEFINER` here would silently punch through that isolation and require hand-reimplementing all four checks — don't.

`persistSalesDay` also carries a legacy three-call fallback, used **only** when the RPC returns `PGRST202`/`42883` (function not in the schema cache). That exists purely because this project applies migrations by hand in the dashboard, so there's a real window where deployed code predates the migration; it is not a retry-on-failure path, and every other error is rethrown untouched so nothing gets written twice. Once the migration is applied everywhere, the fallback and `isMissingFunctionError` can be deleted.

### `recipe_ingredients` has no `client_id` column

Always scope ingredient fetches by recipe IDs first:

```js
const recipeIds = recipes.map(r => r.id)
supabase.from('recipe_ingredients').select('*').in('recipe_id', recipeIds)
```

### POS billing, shifts and the IMS handoff

See `.claude/rules/pos-billing.md` (auto-loads when editing `src/modules/pos/`). Headline rules: a
closed bill that can't reach IMS is stamped `ims_posted_at IS NULL` and surfaced, never silent;
`sales_entries` and `stock_movements` can diverge, so neither proves the other posted (both now
carry a link to the order); `sales_entries` is period-scoped so `scopedDb` rejects it; the Z-report
is captured at close and frozen; order lines are replaced through `save_pos_order_items`, never
delete-then-insert — which also means a line already fired to the kitchen vanishes silently unless
something records it, so that RPC now writes `pos_kot_removals` from its own before/after diff and
`closeOrder` persists the cart before billing it. Since S580 it also carries the bill-math rule: a
new way to slice a bill is a new `keyOf` passed to `computeGroupAmounts`, never a fourth copy of
the proportional-discount arithmetic. S596 adds the delivery-partner rules: commission is measured
against the ex-VAT, post-discount base and never `paid_amount` (off the VAT-inclusive total it reads
~13 points low on every bill, so a report built that way accuses every platform of over-charging),
an unsettled bill is excluded from both sides of the rate, and a rate-mismatch flag needs a
percentage tolerance AND a rupee one or per-bill rounding raises false alarms.

### Sub-recipe mirror items

See `.claude/rules/recipes-and-subrecipes.md` (auto-loads when editing Recipes.js, `recipeCost.js` or
the IMS recipe/stock-count modules). Headline rules: a recipe with `type = 'sub_recipe'` auto-creates
a mirror row in `items` with `is_sub_recipe = true`, so filter `.eq('is_sub_recipe', false)` out of
Item Master, Purchases, POs, Requisitions, Reorder Report and Supplier Price Tracker; a sub-recipe
can never appear in `stock_movements` and must not be written there; sub-recipes nest, so a cycle
guard must be a PATH set (not a visited set) or a shared base costs 0 on its second branch.
## When adding a new feature

See `.claude/skills/new-feature-checklist/SKILL.md` — invoke it before shipping any new page,
report or module feature. Eight steps: the `feature_flags` **DB column** (the one that breaks every
other client’s flag save when skipped) plus the tier set in `AuthContext.js`, route guards in
`App.js`, the `Layout.js` nav entry, `Tip` tooltips, the Help page, both README files, Danger Zone
registration in `admin-user-ops`, and `RESTORE_ORDER` in the Export/Import restore.
---

## Supabase / DB notes

- **A supabase-js call can hang forever — and `.abortSignal()` does not save you.** Every call goes through `fetchWithAuth` (`@supabase/supabase-js/src/lib/fetch.ts`), which does `await getAccessToken()` on **line 43** and only reaches `fetch(...)` on **line 70**. `getAccessToken()` calls `auth.getSession()`, which can itself stall (a token refresh that never settles, or one of the known GoTrue init/lock deadlocks — the reason `supabaseClient.js` already installs a no-op `lock`). When it stalls, `fetch` is never invoked, so the AbortController passed via `.abortSignal()` is attached to nothing and firing it does *nothing*: the promise never resolves **and** never rejects, so a `try/finally` that resets a `saving` flag never runs and the button stays disabled forever. Guard any user-gating await with `withTimeout()` (`src/utils/withTimeout.js`) — a `Promise.race` against a wall clock is the only thing immune to where the hang is. Keep `.abortSignal()` alongside it (that's still what cancels a genuinely in-flight request); it's a complement, not a substitute. S449→S454 burned four rounds on this exact bug in `Sales.js` because each fix only covered the layer above the real one.
- **Why `getSession()` stalls in the first place, and the client-level fix (S455).** auth-js sets **no timeout on its own network calls**. An expired access token makes the next `getSession()` call `_callRefreshToken()` → `fetch('/auth/v1/token')`; if that stalls, the auth client wedges *permanently*, not just for that call — `_acquireLock` drains via `while (this.pendingInLock.length) { await Promise.all(waitOn) }` (`GoTrueClient.ts` ~2803), so one never-settling promise means the loop never exits, `lockAcquired` is never reset, and every later `_acquireLock` chains `await last` onto the dead promise. Because supabase-js awaits `getAccessToken()` before *every* DB request, one stalled refresh silently freezes every query/insert/update app-wide with no error anywhere until the tab is closed. `src/supabaseClient.js` now passes `global.fetch` (handed straight to the auth client by supabase-js, `SupabaseClient.ts:340-344`) through `makeAuthTimeoutFetch()` (`src/utils/authFetchTimeout.js`), which bounds **only** `/auth/v1/` requests at 15s so the promise settles, the drain loop completes and the client self-heals. PostgREST and Storage traffic is deliberately left unbounded there so a slow report or a large upload is never cut off — bound those per-call with `withTimeout()` instead.
- **`onAuthStateChange` always fires `INITIAL_SESSION` on subscribe — don't also fetch the profile yourself without gating on event type (S463).** `AuthContext.js`'s effect used to call its own `initialize()` (`getSession()` + `fetchProfile()`) *and* subscribe via `supabase.auth.onAuthStateChange(callback)`, with the callback re-running `fetchProfile()` for every event unconditionally. Checked against the installed `@supabase/auth-js` source (`GoTrueClient.ts`'s `_emitInitialSession`, scheduled in an IIFE the moment you subscribe): `onAuthStateChange` **always** replays the current session as an `INITIAL_SESSION` event, in production exactly as in dev — not a React StrictMode artifact (checked; `index.js` does wrap the app in `StrictMode`, which was a real candidate before ruling it out). So `initialize()` and the callback's `INITIAL_SESSION` replay both independently ran the full `profiles` → `Promise.all(clients, feature_flags)` → `last_seen_at` `PATCH` waterfall on **every single page load** — confirmed live via the network tab (`profiles` ×2, `clients` ×2, `feature_flags` ×3, `PATCH` ×2 on one dashboard load). `TOKEN_REFRESHED` compounded it further: `startSessionKeepAlive` (S458) calls `ensureFreshSession()` on every tab `focus`/`visibilitychange`/`online`, not just once an hour, so the same redundant waterfall was also re-running on ordinary alt-tabbing throughout a session — this, not any one slow query, was the real cause of "pages load slowly, sometimes get stuck." Fixed by returning early on `event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED'` **after** `setSession(session)` already ran (so context consumers still see a refreshed token) but **before** `fetchProfile()` — nothing about who the user is changes on either event. Re-verified live: `profiles`/`clients`/`PATCH` each fire exactly once now. A second `feature_flags` read remains — that's `SettingsContext`'s own independent fetch, a separate provider, not part of this bug.
- **SQL authoring rules live in `.claude/rules/supabase-sql.md`** (auto-loads when editing anything under `supabase/` or AuditLog.js): the RLS policy pattern and `(select auth.uid())` wrapping, one-permissive-policy-per-command, per-row helper-function costs, FK/index discipline, the REVOKE-vs-PUBLIC and per-signature grant gotchas, `log_audit()` trigger conventions, and the schema-migration workflow (migration file first, then Dashboard SQL Editor, then commit).
- Admin operations that need the service role key go through the Supabase Edge Function `admin-user-ops` (deployed at `supabase/functions/admin-user-ops/`). Never put `SUPABASE_SERVICE_ROLE_KEY` in the frontend bundle.
- Real Web Push (Roster publish + shift-swap notifications) is sent from the Edge Function `hr-push` (`supabase/functions/hr-push/`) — the only place holding the VAPID private key (`VAPID_PRIVATE_KEY` secret; the public half is `REACT_APP_VAPID_PUBLIC_KEY`, safe to expose). `src/utils/webPush.js` handles the frontend subscribe flow, including the iOS Safari quirk where the Push API is only available to a page added to the Home Screen, never a regular tab.
- `hr-selfservice-login` (`supabase/functions/hr-selfservice-login/`, added S464) completes HR Self-Service PIN login server-side: takes `{ staff_id, pin }`, resolves the real email with the service role, calls `signInWithPassword` itself, and returns only the resulting session tokens — added specifically so the browser never has to hold or transmit the account's actual email during login. `SelfServiceLogin.jsx` calls it via `supabase.functions.invoke(...)` and then `supabase.auth.setSession({access_token, refresh_token})` on success, since `signInWithPassword` used to do that step implicitly and now the real auth call happens off-browser.
- `profiles` itself is the one table that does **not** follow the standard same-client pattern above — `profiles_select` RLS is self-or-admin only (`id = auth.uid() OR is_admin()`). A raw `supabase.from('profiles').eq('client_id', ...)` query, run by a real (non-admin) client login, silently returns nothing but the caller's own row. To resolve another staff member's name (closed_by/comped_by/sent_by/etc.), call the `get_client_profile_names(p_client_id)` RPC (all profiles for that client) or `get_pos_staff_list(p_client_id)` (PIN-based POS staff only, excludes the Owner — used by Staff Management specifically). Never a raw `profiles` query for anyone but the caller's own row.
- **Staff accounts are same-client at the RLS level** — POS PIN staff (`pos_email IS NOT NULL`), IMS staff (`ims_role IS NOT NULL`), HR staff (`hr_role IS NOT NULL`), and HR self-service accounts (`hr_self_service = true`) all share `role='client'` + `client_id` with the owner, so the standard admin-or-same-client policy alone gives any of them owner-level data access. S316 (`20260708130000_staff_account_business_table_isolation.sql`) fenced off POS/self-service with **RESTRICTIVE** `no_self_service_accounts` / `no_pos_pin_staff` policies per table; S419 added `no_ims_staff` for IMS staff; S430 added `no_hr_role_staff` for HR staff (helpers: `is_hr_self_service()`, `is_pos_pin_staff()`, `is_ims_staff()`, `is_hr_role_staff()`). **When creating a new business table, add it to every matching restrictive-policy list** — a new table doesn't inherit the exclusions, and a bare same-client policy re-opens the hole for whichever staff-account type's JWT touches it.
- **`profiles.hr_employee_id`** links a login to an `hr_employees` record — originally written only by HR Self-Service (`create_hr_self_service_login`), and as of S328 also optionally written by `create_pos_staff` (POS Staff's "+ Add Staff" → HR Employee mode) so a client running both HR and POS doesn't have to enter the same person twice under two different names. A partial unique index (`profiles_hr_employee_pos_unique` on `hr_employee_id WHERE pos_email IS NOT NULL`) plus an Edge Function check stop the same employee from getting two POS accounts; nothing stops one employee from separately having both a POS account and an HR Self-Service account, since those are different login mechanisms for the same person.
- `per_uom_rate` on `items` is a **generated column** — never include it in INSERT/UPDATE payloads.
- `pos_orders.order_no` is assigned by a **BEFORE INSERT trigger** (per-client sequential) — never set it from the frontend; read it back via `.select('id, order_no')` after insert. Same pattern for `pos_orders.invoice_no` (BEFORE UPDATE, partitioned by `client_id + invoice_fy + close_type`) and `pos_credit_notes.credit_note_no` (BEFORE INSERT, partitioned by `client_id + invoice_fy`) — never set these from the frontend either. Item-level comps (`pos_order_items.comp_no`) share the **same NC-series** as a whole-order Complimentary Slip — the frontend calls `get_next_pos_comp_slip_no(client_id, fy)` RPC once per Charge action (one number per comp event, not per line) and passes the result in explicitly; `assign_pos_invoice_no()`'s `close_type='writeoff'` branch locks on and considers that same pool, so the two paths can never collide.
- The offline stock count (and POS order-taking) uses IndexedDB (`src/utils/offlineQueue.js`, DB name `crest-offline`) with 10 object stores. Sync flushes automatically on reconnect. **Any read-modify-write on an offline store must happen inside a single `readwrite` transaction** (get + merge + put together), never a readonly get followed by a separate readwrite put — IndexedDB only serialises *overlapping readwrite* transactions on a store, so the two-transaction shape lets concurrent callers read the same pre-image and clobber each other's write. This was a real bug (S440): `saveOrder` fires `logKotSend('KOT')` + `logKotSend('BOT')` un-awaited, both routing through `enqueuePosOrder`, which silently dropped one station's queued KOT send offline until the merge was made atomic. POS billing is hard-gated offline (`payDisabled` includes `!isOnline`), so the offline surface is order-taking only — no money path is ever reachable without a live server.
- `settings` was, until S290 (`20260707150000_settings_rls_same_client_write.sql`), the one client-scoped table whose INSERT/UPDATE RLS policies were **admin-only** with no same-client allowance — every settings-writing tab in `PosTableManagement.jsx` (Discounts, Quick Notes, Ticket Routing, Delivery Partners) had been silently no-op'ing for any real (non-admin) client login, since an RLS-blocked write returns zero rows changed with no error rather than throwing. Now follows the standard `is_admin() OR client_id = my_client_id()` pattern like every other table; the `client_id IS NULL` global-defaults row (`app_name`, `app_tagline`, etc.) stays admin-only automatically since a real client's `client_id` can never equal `NULL`. Still stays on raw `supabase.from()` rather than `scopedDb` (see the `scopedDb` note above) — that's about the nullable `client_id`, unrelated to this RLS fix.
- **Closing a period is preflighted on the closing count (S613).** The close locks the month *and*
  mints the frozen Monthly Report, and COGS subtracts closing stock — so an uncounted month freezes
  "closing = 0 for every item" into an artifact nothing recomputes. All three close paths in
  `Periods.js` now run `closingCountPreflight()` and state what it found inside the ConfirmModal,
  red when nothing is counted. It **informs and never blocks** (an admin correcting history
  legitimately closes uncounted months), a failed preflight says it could not check rather than
  blocking, and it counts the same `physical_qty IS NOT NULL` rows `carryForwardOpeningStock` uses
  so the sentence and the carry-forward cannot disagree. Full reasoning in
  `.claude/rules/owner-report.md`.
- **`monthly_periods` allows at most one `open` period per client** (`monthly_periods_one_open_per_client`, a partial unique index `WHERE status='open'`, added 2026-07-13) — virtually every IMS/HR/Owner Dashboard page assumes this via a plain `.eq('status','open').limit(1).single()` read. Practical consequence: `Periods.js`'s "Reopen" action on a *past* closed period will always fail once a more recent period is open — which is the only realistic time anyone reopens a past period, so always check the update's `error` before treating a reopen as successful (S432, 2026-07-21, found an unhandled case that silently did nothing and gave no indication why). Separately, **admin doesn't need to reopen a period to edit it** — `Stock.js`'s `isLocked = !isAdmin && status==='closed'` (mirrored on every other period-scoped entry page) exempts admin from the read-only lock entirely regardless of status. Reopening only matters for handing edit access back to the *client's own* login; if admin is making the correction personally, editing in place and then re-propagating forward (`Periods.js`'s `carryForwardOpeningStock`, safe to call standalone — it's an idempotent upsert, exposed via the "Resync Opening Stock" action) is the simpler, unblocked path.

### Two writes in one function can diverge, so one is never evidence of the other

A pattern worth recognising beyond POS. `writeSalesEntries` writes revenue to `sales_entries` and
then depletion to `stock_movements` inside a try/catch that swallows failures — deliberately, so a
depletion problem never blocks a bill closing. The consequence is that **a bill can have revenue
and no movements**, and a later guard that inferred "has this already posted?" from
`stock_movements` was therefore *wrong* rather than merely incomplete: it re-posted two bills'
revenue on real data (S573). Whenever a best-effort second write follows a primary one, the second
one's absence proves nothing — give each table its own link back to the source row and ask the
table you actually mean.

### A bare `.select()` silently truncates at 1000 rows

Supabase sets PostgREST's `db-max-rows` to 1000. A `.select()` with no `.range()` that matches more rows than that returns the first 1000 with **no error and nothing in the data to say so** — the only marker is the `content-range: 0-999/*` response header, which supabase-js does not surface. Every total summed from that array is then wrong, and wrong quietly, which is the dangerous part: it reads as a real figure until someone compares it against another source.

Found live (S528) on Stock Movements: the page reported "1000 movements / NPR 49,241 depleted" for a period that actually had 1753 / NPR 87,043. The round number was the only tell, and it had been wrong in production for as long as that client had been busy enough to cross the cap. `ReorderReport.js` had the same shape on the same table, so **Book Stock — a figure people place purchase orders against — was silently low too.**

Use `fetchAllRows(makeQuery)` (`src/shared/fetchAllRows.js`) for any period-scoped read that can realistically exceed 1000 rows: transaction tables (`stock_movements`, `sales_entries`, `purchase_entries`, `pos_order_items`, `pos_kot_log`, `hr_attendance`, `hr_roster`) rather than master data (`items`, `vendors`, `recipes`), which no single client comes close to filling. Two rules: it takes a **function** returning a fresh builder (a supabase-js builder is a one-shot thenable and cannot be awaited twice), and that query must carry a **unique tiebreaker in its sort** (`.order('id')` after whatever the display order is) — paging a non-uniquely-ordered query can repeat a row on one page and skip it on the next, which just trades a truncation bug for a subtler one.

S529 swept the rest: **61 call sites across 42 files**. Row-count thresholds worth knowing, since they decide whether a table needs this at all — `hr_attendance` is one row per employee **per day**, so it crosses 1000 at ~34 staff (that one silently zeroed daily/hourly pay and removed absence deductions for monthly staff, since employees past the cutoff simply appeared to have no attendance); `pos_order_items` is one row per line per bill, so a month of ordinary service is thousands; `purchase_entries` is fine for one period but not for the fiscal-year and all-time reports (Annual Summary, VAT/Non-VAT, One Lakh Above, Vendor Balance Confirmation, Supplier Price Tracker, and Outstanding Payables — that last one unbounded by period, so it gets worse the longer the system is used).

**Deliberately not wrapped:** single-parent reads (`.eq('order_id', X)` for one bill — a bill can't have 1000 lines) and `head: true` count queries (`Vendors.js`'s delete guard returns a count, not rows, so the cap cannot apply). Wrapping either would be noise.

**S613 (2026-08-26) swept the tail S529 left, and its shape is the lesson: a sweep that works
table-by-table finishes the table it was named after and leaves its neighbours.** S529 wrapped
`purchase_entries` almost everywhere and `wastages` almost nowhere — 10 of 12 `wastages` reads were
still bare, including the multi-period windows in `AnnualSummary`, `PeriodComparison` and
`ShrinkageReport`, while `sales_entries` split 9 wrapped / 9 not. 35 more sites across 25 files are
now paged. Two worth knowing: `Sales.js`'s `loadAllDaySums` doubles as the **save-time fallback
baseline** for every item the user did not type into, so a truncated read there could be *written
back*, not merely displayed; and `Items.js`'s `checkAllUsage` feeds the force-delete guard, so its
truncation reported a used item as unused. **Deliberately not wrapped**, so the next sweep does not
churn them: single-day reads, `head: true` count queries, id-bounded backfill lookups, and
`persistSalesDay`'s legacy three-call fallback.

**Two traps when doing a sweep like this**, both hit live: (1) if the original chain continued past the line you're editing, the closing paren lands too early and the trailing `.order(...)` gets applied to fetchAllRows' *result* — a plain `{data,error}`, not a builder — which is a runtime `TypeError`, not a build error, so only actually loading the page catches it (`Purchases.js`, found exactly this way). (2) A CRA dev server left running shares `node_modules/.cache` with `npm run build` and will keep rewriting stale ESLint entries underneath it, producing phantom `'fetchAllRows' is defined but never used` errors on files where the import and the usage are both plainly present. Stop the dev server before trusting a CI build.
