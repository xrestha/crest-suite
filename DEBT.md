# Technical debt register

Known shortcuts and leftovers in the code. Each one works today, is left as it is on purpose, and names the event that should make someone deal with it.
When an entry is paid off, delete it from this file and record the payoff in the CHANGELOG entry of the session that paid it.

---

## 1. The build tool, Create React App, is no longer maintained

**What it is.** The app is built and tested with Create React App (`react-scripts` 5 in `package.json`), which the React team deprecated in February 2025. It gets no new releases, so the webpack, Babel, ESLint and Jest 27 inside it stay where they are. React 19 runs on it without trouble. Vercel deploys with a plain `npm run build` (`react-scripts build`), and ESLint runs inside that build: there is no separate lint script, and `npm run build:verify` makes every lint warning fail.

**What it already costs.** Jest 27 needed two workarounds before a component test could run at all: the `jest.moduleNameMapper` block in `package.json` (react-router-dom 7 points Jest at a file it does not ship) and the `TextEncoder` shim in `src/setupTests.js`. It cannot load ESM-only packages in tests either, which is why the legal pages render their markdown with a small hand-written component instead of `react-markdown`. `scripts/build-verify.mjs` exists partly because a running CRA dev server rewrites the ESLint cache underneath a build.

**Why it is left.** Moving to another build tool (Vite is the usual choice) is a large change no client would see, it would land in the middle of a launch, and CLAUDE.md's Stack line records the setup as CRA with "no Vite". Nothing is blocked today.

**Owner decision (2026-11-05, S890, asked in plain words): leave it until the trigger below.**

**Trigger:** When an upgrade you actually need cannot be installed or built under `react-scripts` 5 (a security fix in code that ships to the browser, or a library the product needs), plan the migration as its own change, with the owner's approval and the CLAUDE.md Stack line updated in the same change. The new setup must still fail the build on a lint error, and `npm run build` must stay what Vercel runs. An `npm audit` warning is not the trigger on its own: read the dependency path it prints first, because the ones that trace back to `react-scripts` are usually build and dev-server tooling that never reaches the browser.

**Where to look:** `package.json` (`react-scripts`, `scripts`, `jest`), `src/setupTests.js`, `scripts/build-verify.mjs`, `.claude/rules/legal-documents.md` (the "Two Jest fixes" section).

---

## 2. Three POS screens read by date with no index on that date

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

## 3. The food tables were extracted once, from a PDF, by Python scripts

**What it is.** `src/data/foodTables.json` (the nutrition library's 1,115 Nepal and Indian foods, S884) is built by three Python scripts in `scripts/food-tables/`, the only Python in the repo. The Nepal half is read out of the 2012 PDF with `pdftotext`, by page position, and 332 display names (wrapped, misspelt or unclear in the book) are set by hand in a CSV. The 225 Nepal-to-Indian pairs that supply sugar and sodium were judged one by one. Nothing in `npm` or CI runs any of it; the reviewed CSVs and the JSON are committed.

**Why it is left.** Both books are fixed editions, so the extraction runs once per edition. A Node port would add nothing a reader can see.

**Owner decision (2026-11-05, S890): leave the scripts in Python.** A rewrite would change nothing anyone sees.

**Trigger:** When either table publishes a new edition, or a figure in the library is reported wrong. Re-run the README's rebuild steps, diff the CSVs and re-check the pairs, rather than editing the JSON.

**Where to look:** `scripts/food-tables/README.md` (sources, rebuild, review rules), the CSVs beside it, `src/data/nutritionSeed.test.js` (the invariants a rebuild must keep).
