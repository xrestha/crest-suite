# frontend-performance.md: archived sections

Moved word for word out of .claude/rules/frontend-performance.md in the S770 context pass (2026-09-17). This is history and is not auto-loaded: no rules glob matches docs/. The live rule stays in the rules file, usually with a pointer here. Line numbers refer to the rules file before the move.

---

_Original lines 219–249:_

## The POS sweep, S629 — what was actually slow

Measured before changing anything, because three of the candidates were not worth touching.

- **The POS→IMS backfill was three sequential round trips per bill** (`sales_entries` insert,
  `stock_movements` insert, `ims_posted_at` stamp) plus one per already-posted bill. At ~200 ms a
  trip that is ~8 minutes for an 800-bill month, against a 120 s wall clock in `Periods.js` — so it
  could not finish a busy month at all, and the operator saw a timeout. Now batched 40 orders at a
  time (~64 trips for that month), with a per-bill retry when a batch is rejected so one bad bill
  does not cost its 39 neighbours. `backfillPosToIms.test.js` asserts the trip counts, because a
  regression to per-order writes is invisible otherwise.
- **The Billing modal rebuilt the whole bill document per keystroke.** Assigning `srcDoc` replaces
  the iframe's document, measured at **17 ms median / 22 ms p90** in Chromium on a desktop for a
  22-line bill — paid per character typed into the buyer, discount and tender fields, on a till that
  is usually a slower tablet. Now handed to the iframe on a 200 ms trailing delay
  (`PREVIEW_DEBOUNCE_MS`), immediate on open/close/tab-change. Building the string itself is
  0.4 ms and was never the cost.
- **The Z-report ran four reads in a waterfall**, two of which needed nothing from the other.
  `loadShiftReport` is rebuilt on page load and on every expanded history row.
- **Not slow, left alone**: the till's menu filter (0.05 ms per render at 300 items — memoizing it
  would be churn), the Guest Menu's category grouping, and `PosExceptionReport`'s render-body
  rollups (no text input on the page; only date pickers and two selects).
- **Deliberately not changed**: `closeOrder`'s ordering beyond two overlappable writes. Its steps
  look independent and are not — `award_loyalty_points` resolves the customer from
  `pos_customers` by phone and returns 0 if the row is absent, so the customer upsert **must**
  land first or a first-time customer silently earns nothing. Only the customer upsert and the
  table release were moved to run alongside the IMS post; both were verified to read nothing that
  post produces. The offline queue's per-send KOT inserts were left sequential too: 1–3 trips on a
  reconnect path, against changing failure granularity on the one path that only runs when the
  network is already unreliable.

---

_Original lines 282–283:_

**A second test, added S626: the cached sections must be able to shorten the SKELETON.** Caching a page's reference lists while its *core content* still blocks on a fresh read buys nothing visible — the user waits for the core read either way — so it is dead code carrying a staleness risk. `PurchaseOrders.js` fails both tests (its PO list is the page, and `confirmReceive` writes `qty_received + receiving` off that state, so a stale row double-counts a delivery) and `Variance.js` fails the same way; both were wired up, measured as pointless, and reverted with the reasoning left in a comment at their state declarations so the next sweep doesn't re-attempt it. The round-trip and per-keystroke rules this came out of are in `.claude/rules/frontend-performance.md`.

---

_Original lines 401–401:_

**An `.in(column, ids)` filter is a URL as well as a row count (S629).** PostgREST spells the id list out in the request URL, so a few hundred uuids is already past what proxies and CDNs accept — a loud 414 — while the 1000-row cap still applies underneath. Reach for `fetchAllRowsChunked(ids, makeQuery)`, or `runChunkedByIds(ids, makeQuery)` for a write filtered the same way (sequential, first error wins, and **not** atomic — some chunks may already have landed).

---

_Original lines 403–403:_

The sweeps since S528, their per-table thresholds, and the two traps that cost rounds — a misplaced closing paren that only fails at runtime, and the stale `.eslintcache` that `npm run build:verify` exists to clear — are in the next section.

---

_Original lines 405–546:_

## The 1000-row truncation sweeps: S528, S529, S613, S628

The rule is the section above; its one-line form stays in the root `CLAUDE.md`. These are the sweep histories behind it, migrated S663 — read them before starting another sweep.

Found live (S528) on Stock Movements: the page reported "1000 movements / NPR 49,241 depleted" for a period that actually had 1753 / NPR 87,043. The round number was the only tell, and it had been wrong in production for as long as that client had been busy enough to cross the cap. `ReorderReport.js` had the same shape on the same table, so **Book Stock — a figure people place purchase orders against — was silently low too.**

S529 swept the rest: **61 call sites across 42 files**. Row-count thresholds worth knowing, since they decide whether a table needs this at all — `hr_attendance` is one row per employee **per day**, so it crosses 1000 at ~34 staff (that one silently zeroed daily/hourly pay and removed absence deductions for monthly staff, since employees past the cutoff simply appeared to have no attendance); `pos_order_items` is one row per line per bill, so a month of ordinary service is thousands; `purchase_entries` is fine for one period but not for the fiscal-year and all-time reports (Annual Summary, VAT/Non-VAT, One Lakh Above, Vendor Balance Confirmation, Supplier Price Tracker, and Outstanding Payables — that last one unbounded by period, so it gets worse the longer the system is used).

**S613 (2026-08-26) swept the tail S529 left, and its shape is the lesson: a sweep that works
table-by-table finishes the table it was named after and leaves its neighbours.** S529 wrapped
`purchase_entries` almost everywhere and `wastages` almost nowhere — 10 of 12 `wastages` reads were
still bare, including the multi-period windows in `AnnualSummary`, `PeriodComparison` and
`ShrinkageReport`, while `sales_entries` split 9 wrapped / 9 not. 35 more sites across 25 files are
now paged. Two worth knowing: `Sales.js`'s `loadAllDaySums` is every PERIOD figure on that page —
the three stat cards and the whole Period Summary tab — so a truncated read there reports a
believable short revenue against a full cost; and `Items.js`'s `checkAllUsage` feeds the
force-delete guard, so its truncation reported a used item as unused. (S613 justified wrapping it
by calling it "the save-time fallback baseline for every item the user did not type into", copied
from the comment on the function. That was never true — the baselines are `sales` for Bulk and
`dailySales` for Daily — and the claim survived two sessions because it argued for the right
action. **A wrong reason attached to a correct fix is the hardest kind of stale doc to notice**;
S699 corrected both the comment and this sentence.)

**S706 found the `checkAllUsage` half of that was itself half a fix.** `fetchAllRows` had been
wrapped around the eight per-table reads and around neither the `scopedFrom('items','id')` that
builds their `.in()` list nor `loadItems()` itself — so past 1000 SKUs the page showed a partial
item book as the whole one, and every item after the cap was never checked for usage at all, on
the read that decides whether an item is safe to delete. **A sweep that pages the read it was named
after and not the read that FEEDS it has not finished**: ask what produces the id list, not only
what consumes it.

**S708 found the same pair on the Vendors page, and it had been missed for the same reason.**
`loadUsage` was correctly `fetchAllRowsChunked` over all four referencing tables, while
`loadVendors` — the read that produces the id list it chunks — was a bare `scopedFrom('vendors')`,
so past 1000 suppliers the usage chips and the delete guard simply never saw the tail of the book.
Two pages now, both times the consumer paged and the producer not. The knock-on here is worse than
a missing chip: `getNextVendorCode()` takes its max over that same array, so a truncated read mints
a duplicate `VND-` code off the visible slice, exactly as `getNextItemCode()` did. **A page that
mints a sequential code from a client-side max has a paging bug and a uniqueness bug wearing one
coat** — `items` answered the second half with `items_client_name_key`; `vendors` has neither index
yet, so on that page the paging IS the guard.

**`recipe_ingredients` was the fourth producer/consumer instance (S721)**, and its direction is
the interesting part. Stock Movements pages the `sales_entries` read that produces `soldRecipeIds`
and then fed that list to a bare `.in()` on `recipe_ingredients` — one row per ingredient per
recipe, so ~130 sold dishes at ~8 ingredients each is past the cap. The truncation lands on the
**wrong side of a comparison**: recipes whose rows fell past the cut are absent from
`withIngredients`, so the page's amber banner names them as having NO ingredients and sends the
owner to Recipes to add ones that are already there. A truncated read usually shortens a figure;
here it LENGTHENED a warning list, which is the same silence wearing the opposite sign.

**`getNextPoNumber()` was the third instance (S709)**, and the one that already had the uniqueness
half: `purchase_orders` carries a `client_id + po_number` unique index and `savePo` retries three
times on a `23505`. That combination is worse than it sounds — the retry recomputes the max off the
*same truncated window*, so it produces the same colliding number three times and then surfaces a
constraint violation, where the paging bug alone would have been one silent duplicate. It also
shows why the obvious shortcut is not one: ordering by `po_number` and taking the first row is
wrong at exactly the volume the cap starts mattering, because `'PO-1000'` sorts below `'PO-999'` as
text. And its failed read now stops the save rather than numbering off a short list — **a code
minted from a max is only as trustworthy as the completeness of the read behind it**, so "I could
not read the list" and "the list is empty" must not lead to the same number.

**S720 closed the IMS tail, and where it was found is the lesson.** Every single-period page in
the module already paged `opening_stock`/`closing_stock`/`staff_meals`; the only three unpaged
sites left were **the two pages that read those tables across 12 and 24 periods at once** (Annual
Summary, Period Comparison) plus Monthly Summary. One row per item per period × 12 crosses the cap
at about **85 items**, so the pages with the largest windows were the ones a client trips first —
and they were the last swept, exactly as S706 and S708 found for producer-vs-consumer reads. Note
that Period Comparison's `sales_entries` read carried a comment naming the cap "across up to 24
periods" while the three reads directly beneath it were bare: **a paging comment on one line of a
`Promise.all` is not a claim about the others.**

**S722 found the same shape one array element apart, on the two statutory reports.** VAT Report and
Non-VAT Report each read `purchase_entries` through `fetchAllRows` and `vendor_returns` bare, inside
the same `Promise.all` — the second entry in a two-entry array, on pages whose figures are filed
with the IRD. `PaymentReport` beside them paged both, so the correct version was one file away the
whole time. Returns rarely cross 1000 in a month, which is exactly why it survived: **a read is not
exempt because its table is usually small, it is exempt because someone decided it was and wrote
down the rows-per-what.** Neither had a comment either way. Same pass: the `.order('id')` tiebreaker
has to be added with the wrapper, since a `vendor_returns` read ordered only by `bs_day` repeats a
row on one page and skips it on the next the moment it does page.

**S723 found the direction nobody had swept: a PAGED read whose FOLLOW-UP reads are bare.** Both
payables pages wrapped the read they were named after — under comments calling it the likeliest read
in the app to cross the cap, and warning that truncation would understate a document sent to a
vendor for signature — and then hung two bare `.in('purchase_entry_id', ids)` reads off its id list.
`payable_payments` is one row per LINE per settlement, so it grows FASTER than the bills it hangs
off: truncate it and paid bills render as unpaid and Total Remaining inflates. This is S706/S708's
producer-and-consumer rule pointing backwards — there the consumer was paged and the producer was
not. **Ask what else is read FROM the ids a paged read produces**, and price a child table at the
parent's cardinality multiplied by something.

**S728 found the producer/consumer pair once more, and the giveaway was a COMMENT.**
`SupplierPriceTracker` paged its `purchase_entries` read under a six-line comment about the 1000-row
cap — and left the `items` read directly above it bare. `itemMap` is what every purchase row is
gated on (`if (!item) return`), so the truncation does not shorten a column: past 1000 SKUs it
deletes the **entire price history** of every item after the cut, from the table, both Excel sheets
and the vendor dropdown's item count. `SupplierContribution` had the same unpaged `items` read, and
there it silently understates Cost of Sales. Fourth and fifth instances after S706, S708 and S721.

The transferable part: **a careful paging comment on one line of a `Promise.all` is evidence that
someone thought about the cap, and no evidence at all about the line above it** — S720 recorded the
same tell on Period Comparison. When you find a paged read, look at its neighbours and at whatever
produces the ids it filters on, in both directions.

**S734 swept the five dashboards and found the producer half again — nine times, and every one
was MASTER DATA.** `items`, `recipes`, `par_levels`, `opening_stock`, `closing_stock` and
`vendor_returns` across ClientDashboard and OwnerDashboard, plus an unpaged `pos_orders` feeding a
paged (and unchunked) `pos_order_items` in `useSalesPivotData`. Every transaction read on those
pages had been paged years earlier; these had survived every sweep because a transaction table
obviously grows and a master table obviously does not.

**That is the wrong question on a dashboard, because these reads are MAPS and the rows looked up
in them are already complete** — so a truncation does not shorten anything a reader can see, it
deletes rows from a figure computed over everything:

| producer | what a row past the cut does |
| --- | --- |
| `recipes` | prices its sales at **0** — Revenue understated, so every ratio dividing by it fails HIGH |
| `items` | values its wastage and spend at **rate 0** — reads low, i.e. like a good month |
| `par_levels` | reads as "no par set" — the item can never surface as below par |
| `opening_stock` / `closing_stock` | reads as a **zero count** — a large false over-consumption in Variance |

Note the direction: three of those four make the business look BETTER, which is the half nobody
reports. Ask what a missing row does to the arithmetic, not to the list — and prefer that question
to "is this table big", which is the one that let nine of these through.

**Deliberately not wrapped**, so the next sweep does not
churn them: single-day reads, `head: true` count queries, id-bounded backfill lookups,
`persistSalesDay`'s legacy three-call fallback, and `overheads` (one row per named fixed cost per
period — tens of rows, and now written down beside both dashboard reads rather than assumed).

**S628 found four more of that exact shape in HR** — `HrReports`' YTD TDS, Festival Allowance's and
Incentive Run's YTD gross, and `fetchSsfStartMap` — every one on a tax or gratuity figure, all
sitting a file or two from the `payrollData.js` helpers S620 had just fixed. It also found
**`hr_roster` unpaged while `hr_attendance` beside it was paged**, on the same page, ten lines
apart, at the same cardinality. **Decide by rows-per-what, not by table name:** per-employee-per-day
and per-anything-per-month both cross 1000 inside one real client-year. And note the guard problem
— truncation returns **no error**, so every `if (error)` check written against a failed read passes
happily over a short one. Details and the HR-specific consequences are in
`.claude/rules/frontend-performance.md`.

---

_Original lines 549–557:_

**Never read a build's exit code through a pipe (S693).** `npm run build:verify 2>&1 | tail -8` is
the natural way to run it, and in a POSIX shell a pipeline's status is the status of the LAST
command — `tail`, which always succeeds. So a build that printed `Failed to compile` and a build
that printed `The build folder is ready to be deployed` both reported exit 0, and a background task
runner reported "completed (exit code 0)" for the failure. `scripts/build-verify.mjs` propagates
the real status correctly; the pipe is what discards it. Redirect to a file and echo `$?`, or read
the tail of the output for the success line, but do not report a build as passing on a piped exit
code alone.

---

_Original lines 558–563:_

## The `xlsx` dynamic-import sweep (S522)

Migrated from the root `CLAUDE.md` (S663). The rule — `xlsx` is always `import('xlsx')` inside the click handler — stays resident there; this is the sweep that applied it across all 37 pages, including the three files that needed a different shape.

- **`xlsx` is always `import('xlsx')` inside the click handler, never a top-level `import * as XLSX from 'xlsx'` (S522).** Route-level lazy-loading (S440 above) only defers a *page's own* code — it does nothing about a library that page statically imports, which webpack still must fetch as a parallel chunk the moment the route itself loads. `xlsx` (SheetJS) is genuinely huge (138 kB gzipped, the single largest chunk in the app after `main.js`) and is only ever touched by an explicit "Export Excel"/"Import Excel" click, never by simply viewing a page — so a static import was paying that 138 kB on every visit to any of the 37 pages that have an Excel button, whether or not the button was ever clicked. Fixed across all 37 by making the export/import handler function `async` and adding `const XLSX = await import('xlsx')` as its first line; verified in the built output (`r.e(1238).then(r.bind(r,1238))` now sits inside the button's `onClick`, not at module top level). Two files needed a different shape rather than a flat per-function fix: `SalesReport.jsx`/`CoversReport.jsx` share one `withLetterhead(title, ...)` helper across every tab's export branch, so `XLSX` is now its first parameter instead, passed down from the one `await import('xlsx')` in `exportExcel`; `MonthlyOwnerReport.jsx`'s `monthlyReportExcel.js` uses `XLSX` throughout a whole dedicated helper file, so instead of touching every internal function, the *page* now dynamically imports the whole module at click time (`const { exportMonthlyReportExcel } = await import('../../modules/ownerReport/monthlyReportExcel')`) and that file's own top-level `import * as XLSX from 'xlsx'` was left untouched. `recharts` (102 kB gzipped, the other large chunk) was deliberately left as a static import everywhere it's used — charts are core above-the-fold content on those pages, not a deferred click action, so eagerly loading it is correct per `/impeccable optimize`'s own rule against lazy-loading above-fold content.

---

_Original lines 600–607:_

## Why a supabase-js call hangs: the auth-stall diagnosis (S449–S455)

Migrated from the root `CLAUDE.md` (S663). The rules — guard user-gating awaits with `withTimeout()`, and only `/auth/v1/` is bounded at the client level — stay resident there. This is the mechanism, which is what makes the rules make sense.

- **A supabase-js call can hang forever — and `.abortSignal()` does not save you.** Every call goes through `fetchWithAuth` (`@supabase/supabase-js/src/lib/fetch.ts`), which does `await getAccessToken()` on **line 43** and only reaches `fetch(...)` on **line 70**. `getAccessToken()` calls `auth.getSession()`, which can itself stall (a token refresh that never settles, or one of the known GoTrue init/lock deadlocks — the reason `supabaseClient.js` already installs a no-op `lock`). When it stalls, `fetch` is never invoked, so the AbortController passed via `.abortSignal()` is attached to nothing and firing it does *nothing*: the promise never resolves **and** never rejects, so a `try/finally` that resets a `saving` flag never runs and the button stays disabled forever. Guard any user-gating await with `withTimeout()` (`src/utils/withTimeout.js`) — a `Promise.race` against a wall clock is the only thing immune to where the hang is. Keep `.abortSignal()` alongside it (that's still what cancels a genuinely in-flight request); it's a complement, not a substitute. S449→S454 burned four rounds on this exact bug in `Sales.js` because each fix only covered the layer above the real one.

- **Why `getSession()` stalls in the first place, and the client-level fix (S455).** auth-js sets **no timeout on its own network calls**. An expired access token makes the next `getSession()` call `_callRefreshToken()` → `fetch('/auth/v1/token')`; if that stalls, the auth client wedges *permanently*, not just for that call — `_acquireLock` drains via `while (this.pendingInLock.length) { await Promise.all(waitOn) }` (`GoTrueClient.ts` ~2803), so one never-settling promise means the loop never exits, `lockAcquired` is never reset, and every later `_acquireLock` chains `await last` onto the dead promise. Because supabase-js awaits `getAccessToken()` before *every* DB request, one stalled refresh silently freezes every query/insert/update app-wide with no error anywhere until the tab is closed. `src/supabaseClient.js` now passes `global.fetch` (handed straight to the auth client by supabase-js, `SupabaseClient.ts:340-344`) through `makeAuthTimeoutFetch()` (`src/utils/authFetchTimeout.js`), which bounds **only** `/auth/v1/` requests at 15s so the promise settles, the drain loop completes and the client self-heals. PostgREST and Storage traffic is deliberately left unbounded there so a slow report or a large upload is never cut off — bound those per-call with `withTimeout()` instead.
