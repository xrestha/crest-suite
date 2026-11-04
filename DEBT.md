# Technical debt register

Known shortcuts and leftovers in the code. Each one works today, is left as it is on purpose, and names the event that should make someone deal with it.
When an entry is paid off, delete it from this file and record the payoff in the CHANGELOG entry of the session that paid it.

---

## 1. The build tool, Create React App, is no longer maintained

**What it is.** The app is built and tested with Create React App (`react-scripts` 5 in `package.json`), which the React team deprecated in February 2025. It gets no new releases, so the webpack, Babel, ESLint and Jest 27 inside it stay where they are. React 19 runs on it without trouble. Vercel deploys with a plain `npm run build` (`react-scripts build`), and ESLint runs inside that build: there is no separate lint script, and `npm run build:verify` makes every lint warning fail.

**What it already costs.** Jest 27 needed two workarounds before a component test could run at all: the `jest.moduleNameMapper` block in `package.json` (react-router-dom 7 points Jest at a file it does not ship) and the `TextEncoder` shim in `src/setupTests.js`. It cannot load ESM-only packages in tests either, which is why the legal pages render their markdown with a small hand-written component instead of `react-markdown`. `scripts/build-verify.mjs` exists partly because a running CRA dev server rewrites the ESLint cache underneath a build.

**Why it is left.** Moving to another build tool (Vite is the usual choice) is a large change no client would see, it would land in the middle of a launch, and CLAUDE.md's Stack line records the setup as CRA with "no Vite". Nothing is blocked today.

**Trigger:** When an upgrade you actually need cannot be installed or built under `react-scripts` 5 (a security fix in code that ships to the browser, or a library the product needs), plan the migration as its own change, with the owner's approval and the CLAUDE.md Stack line updated in the same change. The new setup must still fail the build on a lint error, and `npm run build` must stay what Vercel runs. An `npm audit` warning is not the trigger on its own: read the dependency path it prints first, because the ones that trace back to `react-scripts` are usually build and dev-server tooling that never reaches the browser.

**Where to look:** `package.json` (`react-scripts`, `scripts`, `jest`), `src/setupTests.js`, `scripts/build-verify.mjs`, `.claude/rules/legal-documents.md` (the "Two Jest fixes" section).

---

## 2. Page files are split between `src/pages/` and `src/modules/`

**What it is.** Module code lives under `src/modules/` (`ims/`, `hr/`, `pos/`, `customization/`, `dashboard/`, `ownerReport/`, `admin/`), each area keeping its pages, helpers and tests together. `src/pages/` holds the screens that belong to no single module: sign-in and sign-up, Settings, Help, Periods, Pricing, Legal, the operator's admin screens, and the dashboards in `src/pages/dashboard/`.

**What the record says.** No plan to empty `src/pages/` is recorded anywhere. S249 moved every IMS page out of it into `src/modules/ims/` and deliberately left the app-shell and admin pages behind as "not module-specific" (`CHANGELOG/S200-S249.md`). The untidy part is the dashboards: their screens sit in `src/pages/dashboard/` while their data and arithmetic helpers sit in `src/modules/dashboard/` and `src/modules/ownerReport/`, so one feature spans two trees. Separately, `src/pages/Placeholders.js` is an early scaffold ("Coming in Session 2") that nothing imports.

**Convention for new code** (what the code follows; no rules file states it): a page or helper that belongs to one module goes in `src/modules/<module>/<area>/`, shared hooks and helpers in `src/shared/`, shared components in `src/components/`, and `src/pages/` only for app-shell or cross-module screens.

**Why it is left.** A move changes no behaviour, and it costs more than the renames: several `.claude/rules/*.md` files name `src/pages/dashboard/` paths in their `paths:` globs or pointers, and a glob left pointing at the old place silently stops loading its rule.

**Trigger:** When dashboard work is about to touch most of `src/pages/dashboard/` anyway, move that folder under `src/modules/dashboard/` as its own commit: a pure move, no behaviour change, every rules glob and pointer updated, `npm run check:docs` clean. Never move files as a side effect of another change. When anyone next edits in `src/pages/`, confirm `Placeholders.js` is still unimported and delete it.

**Where to look:** `ls src/pages src/modules`; `grep -rln "src/pages/dashboard" .claude/rules`; `grep -rn "import.*Placeholders" src`.

---

## 3. Switched-off "missing dependency" warnings in React effects

**What it is.** Many `useEffect` and `useMemo` calls carry `// eslint-disable-line react-hooks/exhaustive-deps` (or the `-next-line` form). That comment silences React's lint check that every value an effect reads is listed in its dependency array. Most are deliberate.

**The usual reasons**, from a sample across IMS, HR, POS, the dashboards and the shared components:
- The effect calls a loader declared inside the component (`init()`, `load()`, `loadUsers()`). That function is a new object on every render and it sets state, so listing it would re-run the effect after every render and the page would reload in a loop. The early CHANGELOG (`CHANGELOG/S023-S099.md`) gives exactly this as the reason for the `[clientId]` arrays.
- The effect should run on a narrower trigger than everything it reads: a client switch (`[clientId]`), a period or tab change, a reload counter.
- Mount-only focus handling (`Modal.js`, `ChartCard.js`, `Calculator.js`): the parent passes a fresh `onClose` arrow on every render, and depending on it would pull focus back on every keystroke.
- A helper the linter cannot tell is stable (`AuthContext.js`).

**Why it is left.** Each site is a decision about when a load should run. Not every one is right: `src/components/Layout.js` records (S852) a missing dependency that kept offering the previous outlet's pages after an outlet switch. So a site is either deliberate or a bug, and only reading it tells which. Most sites carry no comment; the few that explain themselves do so on the line above.

**Do not "fix" one by adding the missing dependency without understanding why it was left out.** Adding the loader function is the classic way to make a page reload forever and hammer the database.

**Trigger:** When a page shows stale figures after a switch of outlet, period or client and the cause is an effect that did not re-run, fix that one site: add the missing value (never the loader function itself), or move the loader inside the effect, or wrap it in `useCallback` with its own dependencies. Then open the page with the browser's Network tab and confirm it does not keep re-requesting. Never sweep these in bulk.

**Where to look:** `grep -rn "react-hooks/exhaustive-deps" src` (add `| wc -l` for the current count).

---

## 4. Three POS screens read by date with no index on that date

**What it is.** Three POS screens fetch rows by a date range from tables that grow with every sale, and the database has no index on (outlet, that date). Postgres finds all of the outlet's rows through the `client_id` index and then checks the date on each one, so these reads slow down as the outlet's history grows, however short the chosen range. They are still fast today because the tables are young.

| Table and date column | Screen | Indexes today |
| --- | --- | --- |
| `pos_kot_log.sent_at` | KOT Log, KOT Register tab (`src/modules/pos/reports/KotLog.jsx`) | `client_id`; `(client_id, sent_at)` only for live tickets, and nearly every stored ticket is `served`, so the register's all-status read cannot use it |
| `pos_order_items.comped_at` | Sales Exceptions, item comps (`src/modules/pos/reports/PosExceptionReport.jsx`) | `client_id`; comped lines are a tiny share of all lines |
| `pos_orders.credit_settled_at` | Customers, Credit tab, bills paid whole (`src/modules/pos/customers/CreditTab.jsx`) | `(client_id, closed_at)` and others, none on this column; lowest priority |

**How this was judged** (read-only): a grep of `src` for `.gte(` / `.lte(` / `.lt(` found the range reads; `pg_indexes` showed what exists; plain `EXPLAIN` confirmed the date is applied as a filter after the `client_id` index scan; `pg_stat_user_tables` and `pg_stats` gave size and shape. "Big enough to matter" means a per-transaction table (one row per kitchen ticket, bill line or bill) that is already among the largest in the database and grows with every sale. Left out: range-read tables that stay small by nature (`pos_credit_notes`, `hr_leave_requests`, `hr_tada_claims`); tables that already have the index (`pos_orders.closed_at`, `pos_reservations`, `pos_credit_receipts`, `pos_kot_removals`, `pos_table_moves`, `pos_parking_slips`, and `pos_waitlist`'s live read); the IMS ledgers (`sales_entries`, `purchase_entries`, `stock_movements`), which are read by `period_id`, indexed, not by date; and `audit_logs`, which is read newest-first by `id` with a limit, where a date index would not help.

**Why it is left.** An index is written on every insert, and these are the busiest POS tables. `.claude/rules/supabase-sql.md` says to index because a query needs it, not in advance, and nothing is slow yet.

**Trigger:** When the KOT Register, Sales Exceptions or the Credit tab gets noticeably slow over a month's range for a busy outlet (or one of these reads shows near the top of Supabase's Query Performance page), add that table's index in a migration through the `apply-migration` skill. Every migration needs the owner's explicit "apply" in a new message. Likely shapes: `pos_kot_log (client_id, sent_at)`; `pos_order_items (client_id, comped_at) WHERE comped`; `pos_orders (client_id, credit_settled_at) WHERE payment_method = 'Credit'`.

**Where to look:** the three files above. Re-check with read-only SQL: `supabase db query --linked "SELECT tablename, indexdef FROM pg_indexes WHERE tablename IN ('pos_kot_log','pos_order_items','pos_orders')"`, then a plain `EXPLAIN` of the read with a real `client_id`.

---

## 5. The supplier delete check keeps two lists that nothing compares

**What it is.** Before a supplier can be deleted, both the Vendors page and the database count the records that still name it. The list of tables to count is written twice, once in JavaScript and once in SQL, and no test compares them. They agree today. In detail: `VENDOR_REF_TABLES` in `src/modules/ims/vendors/Vendors.js` and the body of `vendor_reference_counts()` (migration `20260909140000`, used by the `vendors_guard_referenced_delete` trigger). Items have the same pair with a guard: `src/modules/ims/items/itemRefTables.test.js` parses the migration and fails on a mismatch. Vendors have no such test (`.claude/rules/supabase-sql.md`).

**Why it is left.** Correct today, and only a new table with a foreign key to `vendors` can break it.

**Trigger:** When a new table gets a foreign key to `vendors`, add it to both lists in the same change and write the missing test, modelled on `itemRefTables.test.js`.

**Where to look:** the two places above; list the foreign keys with `supabase db query --linked "SELECT conrelid::regclass FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public.vendors'::regclass"`.
