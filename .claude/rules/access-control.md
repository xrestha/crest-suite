---
paths:
  - "src/context/AuthContext.js"
  - "src/App.js"
  - "src/components/ModuleGate.js"
  - "src/components/PremiumGate.js"
  - "src/components/SuiteGate.js"
  - "src/components/Layout.js"
  - "src/shared/clientMrr.js"
  - "src/pages/AdminClients.js"
  - "src/pages/adminClients/**"
---

# Access control — entitlement, plans and billed axes

The gate mechanics and the short prohibitions stay in `CLAUDE.md`. This file holds the
entitlement history behind them: why `plan` resolves the way it does, how trial state and the
Suite axis are stored, and where the money arithmetic lives. Every rule here was wrong once.
**`plan` is the IMS plan and nothing else** (fixed S548). It used to be the MAXIMUM across `clients.plan`, `ims_plan`, `hr_plan`, `pos_plan` and `is_premium` — a revenue leak found live: a client at `plan='starter'` with `hr_plan`/`pos_plan` at `'pro'` resolved to Pro and got every IMS Pro feature having bought none. **Crest HR and Crest POS are yes/no modules with no tiers**, so `hr_plan`/`pos_plan` are vestigial columns — nothing writes them and nothing should start. **"Read by nothing" was only ever true of the frontend, and the SQL layer went unswept for seven weeks (found S630, fixed S631).** S548 cleaned up JS and never touched SQL: `submit_guest_order` and `get_guest_menu` both unlocked Guest QR Ordering on `v_pos_plan = 'pro'`, so a client carrying a stale `pos_plan` had a Pro feature without the `guest_ordering` flag, off a column no admin screen shows — the same plan-raiser shape S548 and S574 existed to remove. Migration `20260829150000` grandfathers every client that was relying on it into an explicit `feature_flags.guest_ordering = true` **before** removing the clause, so no entitlement changed. Both columns are now genuinely inert apart from `billing-export` passively exporting them. **The general rule: a retirement sweep that only greps `src/` has not finished** — entitlement logic lives in `SECURITY DEFINER` functions too, and nothing there fails loudly when a column stops being maintained.

**Trial state lives in ONE column set** (S574): `is_trial` + `trial_start_date` + `trial_expires_at` + `trial_purge_at` — the set `register_trial` writes. `trial_ends_at` is vestigial (folded by migration `20260818190000`): it was a second trial column that only the admin "+ New Client" form wrote and only one badge fallback read, so admin-created and self-service trials were invisible to each other's screens. `createClient` now writes the canonical set (30 days; self-service gets 7). Related: the auto-deactivation sweep in `AdminClients.js` deliberately has **no trial clause** — `getAccessState` locks expired trials through its own `is_trial`/`trial_expires_at` branch without needing `is_active`, and a sweep clause on a column the lock model ignores meant merely opening Admin → Clients could hard-lock a client the runtime let through. And `getSubStatus`'s no-dates fallback returns an explicit **"No end date"** chip, never a silent "—": that state means unlimited free access (fails open, skipped by the sweep), so it is precisely the one an operator must notice.

**That "no featureKey" rule left Suite unsellable in the shell, and the fix is a section rather than a flag (S638–S640).** With no `featureKey`, Suite rows rendered identically to included features — and neither upsell surface could reach them: `renderUpgradeTeaser()` filters on `featureKey && minPlan === nextTier` (which no Suite item has, by the rule above) and returns `null` once `plan === 'pro'`, and the footer chip is hidden at Pro too. So an IMS Pro client without Suite saw **no upsell anywhere**. All six Suite features now live in one `SUITE_NAV` list rendered as a labelled **CREST SUITE** group with a `PRO` chip in place of the item count when unentitled; the rows stay clickable so `SuiteGate` still does the selling. Two gates coexist inside that one list — `ownerOnly` on the four owner-altitude pages, `minImsRole` on Demand Forecast and Fixed Assets, which are Suite-billed but IMS-shaped — because gating the *group* owner-only would have revoked those two from every IMS supervisor who has them. The group renders on every panel, **last on the admin panel** (there it is a client-facing layer being inspected from outside, not the operator's own work) and under the Dashboard everywhere else.

**A billed axis must be visible on the screens that bill it (S552).** `suite_plan` was selected by `AdminDashboardOverview.jsx` and priced into `clientMRR()` at NPR 2,000/outlet, and rendered **nowhere** — the client list showed IMS/HR/POS pills off the three `*_enabled` flags and nothing for Suite, so a Suite Pro client looked identical to one without it while its revenue sat in the MRR figure on the same page. The Sub Status column tracks IMS only (plus a bolted-on HR hint), so a lapsing Suite was silent too. Both admin surfaces now carry a `★ SUITE` pill and the dashboard warns on `Suite exp. Nd` / `Suite lapsed`, resolving through the same `suite_ends_at → IMS window` fallback `clientMRR()` uses so the pill and the money can never disagree. **Anything added to `clients` that changes what a client pays needs a place in the admin list in the same change** — a module flag gets one for free by joining the pill map; an axis like this one does not.

**And the screen that CHANGES what a client pays must show the money, not just the axis (S643).**
S552 put the `★ SUITE` pill on Admin → Clients; the *figure* stayed on the dashboard. But Clients is
where modules are activated, dates extended and Suite toggled — every one of those moves MRR — so
the operator was editing revenue on a page that never named it, while the dashboard reported a
platform total nobody could attribute to a client. The arithmetic now lives in
**`src/shared/clientMrr.js`** (`clientMRR` / `clientMrrBreakdown`, pure over `(client,
planPrices)`), imported by both. Do not write a second copy: each of its rules is one that was
wrong once — a module counts only when ENABLED *and* paid through, Suite ADDS rather than replaces,
Suite resolves via `suite_ends_at` with the IMS window as a legacy fallback, and annual is 25% off
*except* Suite's annual, which is a published price. Two presentation rules ride with it: **zero is
a real state and says why** ("Not billing", never `NPR 0`, which reads as a price we charge), and an
unbilled module is **omitted** from the breakdown rather than listed at zero — except a *live*
module priced at zero, whose line stays, because dropping it would read as the module being off.

**Suite has ONE tier** (S548): `suite_plan` is `NULL | 'pro'`. It was `starter|growth|pro`, but both call sites were `minTier="growth"` — so Suite Starter unlocked nothing at all and Suite Pro added nothing over Suite Growth on its own axis. It is also an **add-on priced per outlet on top of a client's modules**, not a bundle containing them: turning it on implies only that IMS is enabled (`requireModules`' floor) and says nothing about HR, POS, or which IMS tier the client is on. `requireModules` (array, default `['ims','hr']` — Owner Dashboard's original behavior) varies per feature; Monthly Owner Report, Demand Forecast and Fixed Assets pass `['ims']`. Don't assume every caller needs Owner Dashboard's set.

## Which tier a feature belongs in

Migrated from the root `CLAUDE.md` (S663). The root keeps only the tier thesis one-liner.

Placement is by attribute, not by when it was built (framework from the S548 retier). Score against five: **persona altitude**, **prerequisite depth**, **frequency**, **value type**, **substitutability**. The tier thesis falls out of the fourth — **Starter = Record & Comply, Growth = Control, Pro = Strategy, Crest Suite Pro = Synthesis** (cross-module, owner altitude).

Two rules fall out of it, both of which had already been broken:

- **A feature must be able to produce a number on its own tier's data.** `reorder_report` and `stock_movement_log` sat in `STARTER_KEYS` while deriving their core figure from recipe explosion (`ReorderReport.js`'s `explodeRecipeIngredients`, `StockMovements.js`'s `subRecipeUsage`) — and `recipe_costing` is Growth. Starter clients were sold a Reorder Report with no consumption figure and a permanently empty ledger. Neither fails loudly; they render nothing, forever.
- **A statutory obligation never gates above the base tier**, and **a data-entry page must not sit above the tier of any figure that consumes it.** `vendor_balance_confirmation` (IRD Annexure 13) sat at Pro while `vat_report`/`non_vat_report` were always Starter; `overheads` sat at Pro while `ClientDashboard`, `OwnerDashboard`, `computeMonthlyReport` and `Recipes`' True Cost all read what it writes.

**Moving a feature between tiers requires a grandfather sweep in the same deploy.** `hasFeature()` is "plan tier OR explicit flag", so setting the flag `true` for affected clients restores prior access with no code change — that is what the `feature_flags` override exists for. Upward-*available* moves (a feature becoming available at a lower tier) need no sweep.

## A page reachable by URL needs the guard its nav item implies (S601)

Migrated from the root `CLAUDE.md` (S663). The root keeps the rule and the audit method; this is the leak that produced it and the five pages it has recurred on.

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

**This keeps recurring because the nav condition and the route guard are written in different files
by different hands.** `/group-dashboard` was the fourth (S617) and `/pos` the fifth (S636) — POS
Setup is tagged `minPosRole: 'manager'` in the nav and documented "Manager only", and had no route
guard at all. That one leaked nothing (its single control is behind `canManage` and the device
secret is rank-checked inside `get_pos_device_secret`, server-side, which is where it belongs), but
"nothing leaked" is a property of that page, not of the pattern. **Audit by grepping `Layout.js` for
`minPosRole`/`minImsRole`/`minHrRole` and the `isAdmin || isOwner` render conditions, then checking
each named route has a matching early return in its own component.** The general form of the fix is
in `.claude/rules/design-system.md` — put the condition on the nav ITEM, where every consumer reads
it, rather than hand-writing it at each render site.

**A SUB-route has no nav item to audit, and inherits nothing from its parent page (S647).**
`/purchases/new` and `/purchases/:groupId/edit` are reached from a button on `/purchases`, so
neither appears in `Layout.js` and the grep above cannot find them — but they are typeable, and
`ModuleGate` checks the module, never the role. They carry `hasImsAccess('staff')` themselves.
The second half is the one that is easy to miss: **turning a modal into a route makes its record id
a URL parameter, so a filter the parent page performed in memory has to become a real check.** The
bill form used to receive rows already narrowed from a client-scoped list; the page loads by id, and
`purchases_select` passes `is_admin()` — so an admin viewing client A could open client B's bill by
id. The page requires the bill's `period_id` to appear in its own scoped period list.

## `is_premium`, `ims_plan` and how `plan` finally came to resolve

Migrated from the root `CLAUDE.md` (S663). This is the tail of the original Guest QR Ordering paragraph; the root keeps the `pos_enabled` prohibition.

**Guest QR Ordering comes WITH the POS module, and `pos_enabled` is its only gate** (settled S632, migration `20260829170000`). The flag hunt above ended one step short: with `pos_plan` gone, `feature_flags.guest_ordering` was left as the sole gate — matching the SQL, `posGuideData.js` and the original migration's "Pro-tier feature" comment. But `POS_MODULE_KEYS` in `AuthContext.js` grants it on `posEnabled` alone and `FeatureAccessModal` renders it **locked with a "Plan" chip** once POS is on, so the admin screen promised a feature the server refused. POS is flat and its features are part of it; both functions already return/raise at the `pos_enabled` gate, so the flag check was deleted rather than widened to `flag OR pos_enabled` — a condition that can only have one answer reads like a control that exists. `feature_flags.guest_ordering` now gates nothing (the modal still offers it while POS is off, where it grants nothing usable). **`pos_enabled` is now the only thing standing between a client and a public guest menu, so never remove that check** — the migration asserts it is still present for exactly that reason. Anything asking "does this client have HR/POS" reads `hrEnabled`/`posEnabled`. (`ims_plan` was in that array too and **has never existed as a column** — `42703` against the live DB.) `is_premium` survived S548 as the last plan-raiser and was retired in S574: it appeared on no admin screen, in no MRR figure and in no control, so a Starter client carrying it received every IMS Pro feature while every surface said — and billed — Starter. Migration `20260818180000` folded it into `clients.plan` (`'pro'` wherever set) so no entitlement changed; the column is now vestigial like `hr_plan`/`pos_plan`. `plan` therefore resolves as plain `clients.plan`, no max over anything.
