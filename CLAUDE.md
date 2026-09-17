# CLAUDE.md

Crest Suite is a multi-tenant SaaS for Nepal F&B businesses: IMS, HR and POS modules in one React app
on one Supabase project, switched per client by `clients.ims_enabled` / `hr_enabled` / `pos_enabled`.
This file loads on **every** request, so it holds only what applies to every task. Module detail lives
in `.claude/rules/*.md`; each rules file loads automatically when you open a file its `paths:` matches.

## Where a new rule goes

- **Default to `.claude/rules/`, not this file.** Ask which files a rule is *reachable from*: one module or a few files → the matching rules file (add a `paths:` glob or start a new file); anywhere → here (safety prohibitions, tenant isolation, access control).
- **Every other new rule goes in a path-scoped rules file, never here.** An incident story goes to `docs/rules-archive/<rules-file>.md`, and the rule keeps a one-line `History:` pointer to it. `check:docs` warns when an area's median rules load rises more than 15%.
- `scripts/check-claude-size.mjs` holds a ratcheting ceiling on this file. When the file shrinks, lower `CEILING` in the same commit; never raise it.
- A `paths:` glob that matches nothing is a rule that silently stopped loading. `npm run check:docs` catches that and a pointer to an empty destination, but not a glob scoped to the *wrong* file.
- Never embed a value that moves (a cache version, a count) in a permanent rule; point at the file. A migrated section must actually shrink here to its one-line pointer.

## Commands

- `npm start`: CRA dev server on `localhost:3000`.
- `npm run build:verify`: the local verification build. Runs `check:docs`, deletes the stale `.eslintcache`, then builds with `CI=true` so warnings fail. There is no separate lint script: ESLint runs inside the build. `npm run build` is what Vercel runs; leave it as a plain `react-scripts build`.
- `npm run check:docs`: rules-glob, pointer-stub and CLAUDE.md size checks. Run it after any edit to this file or `.claude/rules/`.
- Tests: `npx react-scripts test --watchAll=false <pattern>`. Jest via CRA; `*.test.js` files sit next to their source.
- Docs: a session entry goes in the newest `CHANGELOG/S###-S###.md`, then `npm run changelog:index`, never in `README.md`. After editing tracked `.md` files, run `npm run mirror:docs` to copy them to the E: backup drive.
- **Trim command output without hiding exit codes: redirect to a file, echo the exit code, then tail.** Builds and tests run through the Bash tool, so this works as written: `npm run build:verify > /tmp/build.log 2>&1; echo "exit=$?"; tail -40 /tmp/build.log`. Never pipe a build or test run straight into `tail`: a pipeline reports `tail`'s status, so a build that printed `Failed to compile` reads as exit 0 (S693).

## Context discipline

- Locate before reading: grep/glob first, then read only relevant line ranges. Don't read whole files over ~300 lines unless the task needs it.
- Never read lockfiles, `build/static/`, `node_modules/`, generated or minified files, or `.env*.local`, by any tool: `.claude/settings.json` denies them to Read and Grep, not to `cat`, `head` or `grep` in Bash.
- Run only the relevant test file unless asked for the full suite. Trim its output as in Commands above.
- For open-ended exploration ("where is X handled", "how does Y work"), use a subagent and return a short summary with file paths and line numbers.
- When more than 3 source files will change, give a short plan and wait for approval before editing. The CHANGELOG entry, the changelog index, `CACHE_NAME` and `APP_VERSION` don't count. Any migration always gets a plan first.
- Don't re-read files already read this session unless they changed.
- When a task is complete, say so and remind me to run /clear before the next task.
- If a session has grown long and I switch to an unrelated task, tell me to /clear or /handoff first.

## Stack

- **React 19 on CRA** (no Vite, no custom webpack, no TypeScript). **Supabase JS v2**: a single client in `src/supabaseClient.js`, with only the anon key in the browser. **Vercel** deploys; `vercel.json` sets `no-cache` on `index.html`.
- **Every page route in `App.js` is `React.lazy`** (S440); only contexts, `Layout`, `ProtectedRoute` and the gates stay eager. Keep any `import './x.css'` above the lazy `const`s, or ESLint `import/first` fails the CI build.
- **`xlsx` is only ever `await import('xlsx')` inside the click handler**, never a top-level import (138 kB gzipped). `recharts` stays static on purpose.
- **Bump `CACHE_NAME` in `public/service-worker.js` on every JS/CSS change users should receive.** The service worker is cache-first, so a plain deploy keeps serving old chunks. Read the current value from the file.
- **Security headers live in `vercel.json`, which is strict JSON, so no comments.** `connect-src` is the exfiltration boundary: a new third-party origin must be added there, or the call works in dev and fails silently in production (`.claude/rules/security-headers.md`).

## Sister repo (hss-suite)

- HR, payroll, settlement and `src/utils/bsCalendar.js` are shared with hss-suite. A bug fixed on either side stays open on the other until it is filed in `docs/CROSS-REPO.md` there.
- Never copy a permission gate across: here `isAdmin` is the Crest platform OPERATOR and the tenant's Owner is `isOwner`; there `isAdmin` aliases that company's Owner.

## Hard rules: tenancy and privilege

- **Use the scoped data layer (`useScopedDb()` / `src/shared/scopedDb.js`), never a hand-written `.eq('client_id', …)`.** It fails closed without a `clientId` and accepts only `CLIENT_SCOPED_TABLES`. Parent-scoped tables, nullable-`client_id` tables (`settings`, `budgets`) and `clients` stay on raw `supabase.from()`. `recipe_ingredients` has no `client_id`, so scope it with `.in('recipe_id', recipeIds)`.
- **`profiles` is the root of trust.** A client session may write only `full_name` and `last_seen_at`, enforced by the allow-list trigger `guard_profiles_privileged_columns()`. **`active_client_id` picks the tenant for every RLS policy, and only `set_active_outlet()` may write it.**
- **A staff-management action verifies what its target *is*, not just its client** (`requireStaffTarget` in `admin-user-ops`). The Owner shares the staff's `client_id`.
- **If the browser can skip a check, it is advisory.** PIN lockouts run inside the login Edge Functions, and the frontend must not also call `record_*_pin_attempt`. Discount caps, voids and comps are BEFORE UPDATE triggers, and attribution comes from `auth.uid()`, never a parameter.
- **A secret never lives on a row its subject can read.** Secrets go in `client_secrets`: admin-only RLS, and deliberately not audited, because `log_audit()` stores full rows. Postgres has no column-level RLS.
- **Wrap every authorisation condition in `COALESCE(…, false)`.** `NULL IN (…)` evaluates to NULL and `IF NOT NULL` never fires, so a bare rank check falls open for exactly the accounts with no rank. `is_admin()` can return NULL too.
- **Owner is a negative test: the absence of every staff marker.** It exists in three copies: `isOwner` (`AuthContext.js`), `isCallerOwner` (`admin-user-ops/index.ts`) and `is_client_owner()` (SQL). A new staff-marker column goes into all three. Giving the Owner's own login a staff role demotes them.
- **Group-spanning reads go through `SECURITY DEFINER` RPCs that filter server-side** (`get_group_summary()`), never a client-side filter over another outlet's rows.
- **A new business table must be added to every matching restrictive staff-isolation policy list**, or a bare same-client policy reopens it. `feature_flags` writes are admin-only, and `register_trial` is rate-limited. Full rationale: `.claude/rules/supabase-sql.md`.

## Hard rules: access control

- **Route guards stack `ModuleGate` (module) outside `PremiumGate` (plan tier or feature flag)**. `ProtectedRoute` enforces subscription state via `getAccessState()`; never add that check per page. It fails open and is a UI gate, not a security boundary.
- **Moving a feature between tiers takes three edits in one change:** the key set in `AuthContext.js`, `minPlan` on its `App.js` route, and `minPlan` on its `Layout.js` nav item. Placement: Starter = Record & Comply, Growth = Control, Pro = Strategy, Crest Suite Pro = Synthesis.
- **`SuiteGate` (`clients.suite_plan`) upsells in place instead of redirecting**, so a Suite nav item carries no `featureKey`/`minPlan`.
- **A nav item hidden by role is not a guard.** No gate checks a role, and restrictive RLS returns `[]` instead of an error, so an unguarded report shows confident wrong figures. Put the role check (e.g. `if (!isAdmin && !isOwner) return <Navigate to="/dashboard" replace />`) in the page after its hooks. Audit by grepping `Layout.js` for `minPosRole`/`minImsRole`/`minHrRole` and `isAdmin || isOwner`. A sub-route inherits nothing from its parent.
- **Staff ranks** are `pos_role`/`ims_role`/`hr_role` (`staff|supervisor|manager`, NULL = none). Admin and Owner resolve to `manager`, so gate staff-only (till) behaviour on the raw `profile.pos_role`. A page's rank guard must match its nav tag.
- **Guest QR Ordering's only gate is `pos_enabled`; never remove that check.** `false` in `feature_flags` does not revoke anything.
- `clientModules` drives display (nav, dashboard sections); `imsEnabled`/`hrEnabled` drive route access. Anything asking "does this client have HR/POS" reads `hrEnabled`/`posEnabled`.
- Client MRR is computed only in `src/shared/clientMrr.js`, and prices resolve through `useSettings().pricing`. Anything added to `clients` that changes what a client pays needs a place in the admin client list.

## Hard rules: data correctness

- **supabase-js resolves `{ data, error }` and does not throw**, so a `try/catch` around a call catches nothing. Always destructure `error`: a guard that drops its read error passes vacuously, and a failed poll must keep the last good state rather than blank it. Decide per site whether to fail loudly, retry, or swallow to `console.error`.
- **A query builder that is never awaited never sends.** For fire-and-forget, use `void p.then(ok, onErr)`.
- **A bare `.select()` silently stops at 1000 rows.** Read transaction tables with `fetchAllRows(() => query)`: pass a function, and sort on a unique tiebreaker (`.order('id')`). Large `.in()` id lists use `fetchAllRowsChunked` / `runChunkedByIds`, because the ids travel in the URL. Judge by what the query returns, not by the table name.
- **A supabase call can hang forever, and `.abortSignal()` doesn't prevent it.** Wrap any await that blocks the user in `withTimeout()` (`src/utils/withTimeout.js`). Only `/auth/v1/` is bounded at the client level.
- **One write never proves another landed.** When a best-effort write follows a primary one, give each table its own link back to the source row.
- **A report never shows a number it did not compute.** A failed read is not an empty period: use `firstError(results)` / `ReportLoadError`, and don't render KPIs while loading or after a failure.
- **An overlapping load must not win the page.** Call `useLatestRequest`'s `begin(id)` synchronously in the handler, and check `isCurrent(id)` after the last await, before any setter.
- **A foreign key is not a delete guard until you check `confdeltype`.** With `ON DELETE SET NULL` the delete succeeds and the child rows lose their parent. Run the step the FK can refuse first.
- **User-facing errors go through `src/shared/errorText.js` → `ActionError`**, converted at the call site. Never claim a failed write did not land. Name the consequence, and keep the technical detail as fine print.
- `monthly_periods` allows one `open` period per client (a partial unique index). `profiles` RLS is self-or-admin, so resolve other staff names with `get_client_profile_names(p_client_id)`. A page that batch-saves every visible row must not use `sessionDataCache`.

## Hard rules: dates (Bikram Sambat)

- All periods and dates are BS, via `src/utils/bsCalendar.js`. Months run 28–32 days, so use `daysInBsMonth()` and never assume 30. The fiscal year runs Shrawan (month 4) → Ashadh (month 3).
- **Never `.toISOString()` a Date from `bsToAd`.** It is local midnight, so at UTC+05:45 it lands on the previous day. Use `formatAd()` for a bare date (including `date` RPC params) and `bsDayBoundaryIso()` when comparing against a `timestamptz`.
- A date picked in BS is stored as AD, so fixing the table never repairs stored rows. `BS_MONTHS` has one definition; import it (`.claude/rules/bs-calendar.md`).

## UI conventions

- Read `PRODUCT.md` and `DESIGN.md` before design work. Never hand-edit `.impeccable/design.json`; regenerate it with `/impeccable document`.
- Colours are CSS variables, never hex. A signal colour used as text takes the `*-text` token; a fill takes the base token. Chart series use literal hex, never the semantic tokens.
- Use global classes (`btn` plus a colour variant, `data-table`, `form-input`, `form-select`, `badge-*`, `page-header`) rather than inline styles, which miss `:disabled`, `[aria-invalid]` and the touch floor. Reach for the shared components before building your own (`.claude/rules/component-library.md`).
- **JSX children are evaluated before the wrapper runs**, so a gate inside a wrapper cannot protect them. Use an early return, a guard at the call site, or a render prop.
- If a page has more than one `return`, new UI can land in one nobody reaches. Check which return a handler's modal belongs in.
- Every `type="password"` input sets `autoComplete`: `new-password` for PIN or account creation, `current-password` for a real sign-in.
- Input arithmetic goes only through `src/utils/evalMath.js`. Never use `eval()` or `new Function()`.
- Non-obvious columns, metrics and form labels get a `Tip`.

## When adding a new feature

Invoke `.claude/skills/new-feature-checklist/SKILL.md` before shipping any page, report or module feature. The `feature_flags` DB column is the step that breaks every other client's flag save when skipped.

## Module pointers

Each file loads on its own when you open a matching path. Read it first when planning work before you have opened one.

| Working on | Read |
| --- | --- |
| Plans, tiers, gates, MRR, admin client screens | `.claude/rules/access-control.md`, `.claude/rules/subscription-access.md` |
| Logins, Owner vs staff, PINs, passwords, login page UX | `.claude/rules/accounts-and-logins.md`, `.claude/rules/auth-and-pins.md`, `.claude/rules/login-pages.md` |
| Multi-outlet groups, `scopedDb` exemptions | `.claude/rules/multi-outlet.md` |
| SQL, RLS, grants, migrations, Edge Functions | `.claude/rules/supabase-sql.md` |
| IMS figures: COGS, food-cost bands, on-hand/par | `.claude/rules/ims-figures.md` |
| Item master, purchases, base-unit rates | `.claude/rules/item-master-rates.md` |
| Recipes and sub-recipe mirror items | `.claude/rules/recipes-and-subrecipes.md` |
| Vendors, payables, supplier reports | `.claude/rules/vendor-payables.md` |
| Period close and locked periods | `.claude/rules/closed-periods.md` |
| Report pages | `.claude/rules/report-pages.md` |
| The three dashboards | `.claude/rules/dashboards.md` |
| Monthly Owner Report snapshot | `.claude/rules/owner-report.md` |
| POS billing, shifts, IMS handoff, offline queue | `.claude/rules/pos-billing.md` |
| POS reservations, booking, arrival alert | `.claude/rules/pos-reservations-alerts.md` |
| HR payroll, settlement, approvals | `.claude/rules/hr-payroll.md` |
| Crest Staff (Self-Service PWA), web push | `.claude/rules/staff-app.md` |
| Settings row | `.claude/rules/settings-row.md` |
| Client data export/import | `.claude/rules/data-export.md` |
| CSS, class names, motion | `.claude/rules/design-system.md` |
| Page layout in JSX: tables, sticky, scrims, stat grids, money/time | `.claude/rules/page-layout.md` |
| Theme tokens and presets; sidebar and command palette | `.claude/rules/design-tokens.md`, `.claude/rules/navigation.md` |
| Error messages | `.claude/rules/error-messages.md` |
| Paging, hangs, slow pages; page caching and offline | `.claude/rules/frontend-performance.md`, `.claude/rules/offline-and-cache.md` |
| Archived rule history (never auto-loads) | `docs/rules-archive/` |
| BS calendar table and stored-date repair | `.claude/rules/bs-calendar.md` |
| Input arithmetic | `.claude/rules/input-arithmetic.md` |
| Legal documents | `.claude/rules/legal-documents.md` |
| Support contact line, app version | `.claude/rules/support-contact.md` |
