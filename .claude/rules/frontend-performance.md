---
paths:
  - "src/shared/fetchAllRows.js"
  - "src/shared/sessionDataCache.js"
  - "src/shared/hooks/useLatestRequest.js"
  - "src/modules/ims/**"
  - "src/modules/hr/**"
  - "src/modules/pos/**"
  - "src/shared/setIfChanged.js"
  - "src/supabaseClient.js"
  - "src/utils/withTimeout.js"
  - "src/utils/authFetchTimeout.js"
  - "src/context/AuthContext.js"
---

# Round trips and keystrokes: the two shapes that make a page feel slow

From the `/impeccable optimize` sweeps over IMS (S625/S626), HR (S628) and POS (S629). **Each sweep
found every one of these shapes again**, which is the argument for the rule rather than a note on it
— `src/modules/hr/**` was not on the `paths:` list above until S628 and `src/modules/pos/**` not
until S629, so none of this loaded while anyone worked there. A rule scoped to the module it was
learned in is a rule the next module repeats. Both shapes are invisible in review —
the code reads correctly, nothing errors, and the cost only appears on a real client's data volume
at a real network latency (150–500 ms per round trip). Neither is caught by any detector in this
project.

## A loop with an `await` inside it is one round trip per iteration

Every `await supabase…` / `await scopedFrom(…)` is a network request. A `for (const x of list)`
that writes per row therefore costs `list.length` **sequential** requests, and the list is usually
the thing that grows with the client.

The worst instance shipped for as long as the page existed: **Stock Count's "Save All" wrote one
item at a time** — two round trips on the delete-then-insert tabs — so a real 300-item count paid
300–600 sequential requests per click, minutes of wall clock, on the page a month is closed from.

- **Bulk it into set operations**: one `upsert(rows, { onConflict: … })` plus one
  `.in('item_id', ids)` delete, not one call per row. `persistValuesBulk()` in `Stock.js` is the
  worked example.
- **A per-key promise-chain lock survives bulking, but only if you keep both halves.** Stock
  Count's `persistLocks` serialises repeat writes to the same `(item, field)` so an onBlur autosave
  can't interleave its delete/insert pair with a bulk write. The bulk path must therefore *await
  every affected key's pending promise before it starts* and *register itself as each key's new
  tail* — dropping either half reintroduces exactly the double-row bug the lock was written for.
- Where a true bulk isn't available (independent per-row `UPDATE`s by id), `Promise.all` over the
  rows is the fallback. **Sequencing per-row writes never bought atomicity** — Purchase Orders'
  receive loop stopped on first failure to "protect consistency" while its `purchase_entries`
  insert had already committed either way. Report *every* failed row instead of only the first.

**The same rule applies to reads.** Independent queries awaited one after another are a waterfall:
Items' page load ran eight usage reads serially, Outstanding Payables three, Recipes/MenuPricing/
MenuEngineering/Stock one level each. The test is not "does B use A's result" but "does B use A's
result *for its own filter*" — three reads that all derive their `.in()` list from query 1 are
dependent on query 1 and independent of **each other**, so they belong in one `Promise.all`.

A backward walk over periods (Overheads' carry-forward) is the same shape wearing a loop: one
`.in()` over every candidate, then walk the result **in memory**. That also removes the
failed-read-mid-walk ambiguity, since there is now one error to check.

**A table's cardinality, not its name, decides whether it needs paging.** `hr_attendance` was
swept (one row per employee per day, crosses at ~34 staff) and `hr_roster` — the same shape, read
on the same page, ten lines above it — was not. Its truncation painted real shifts as empty cells
on the Roster board, made Attendance's OT auto-calc measure overtime against a fallback 8 hours,
and made Copy Week under-count what it was about to overwrite on a dialog whose own comment says a
failed read must stop the copy. **Truncation returns no error, so every guard written against a
failed read passes.** Before deciding a table is safe, write down its rows-per-what: per employee
per day and per-anything-per-month both cross 1000 inside one real client-year.

**Bulking a read means re-checking the 1000-row cap.** Collapsing N per-period queries into one
`.in()` multiplies the row count — page it with `fetchAllRows` and give the sort a unique
tiebreaker, or the fix trades a slow page for a silently truncated one.

## A derivation in the render body re-runs on every keystroke

A controlled input re-renders its whole page component per character. Anything computed in the
render body — a filter, a sort, an aggregation, a recipe-cost explosion — runs again each time, on
the full dataset, whether or not the input has anything to do with it.

- **Build an index once, not a scan per row.** VendorReport's Daily Breakdown called a helper per
  **cell** that re-filtered the entire purchases *and* returns arrays: days × vendors × entries,
  millions of element visits per keystroke of the vendor search. One `useMemo` pass now builds
  per-vendor / per-bill / per-vendor-per-day maps and every derivation reads those. The tell is
  `.find()` or `.filter()` inside a `.map()` over a different large array.
- **Per-tab counts are the most-copied instance of this**: `items.filter(predicate).length` inside
  `tabs.map()` re-runs the same predicate once per tab per keystroke. Build a counts map in the
  same pass that builds the filtered list (Items, Recipes, MenuPricing all had it).
- **Compute a recursive cost once per data change, not once per row.** `calcRecipeCost` explodes
  sub-recipe trees and was called per rendered row *and* again inside the food-cost filter. A
  memoized `Map<recipeId, cost>` keyed on `recipes` replaces both.
- **Hoist `search.toLowerCase()` out of the loop**, and cache an `Intl.Collator` rather than paying
  `localeCompare`'s uncached setup per comparison across thousands of rows.
- **Derivations that are only *rendered* under a condition are still *computed* unconditionally.**
  ReorderReport computed four full sorts on every keystroke, three of them for print modes that
  were not on screen.
- **Writing the same filter chain twice** (once for the `.length === 0` empty check, once for the
  `.map()`) runs it twice per render. Compute the list once.

### A sort that reads the state its own input writes is a UX bug, not just a slow one

`Sales.js` sorted the menu through `getQtyNum()`, which reads `bulkForm` — the very state the Qty
box writes. Typing a quantity re-sorted the whole menu *and physically moved the row out from under
the cursor*. Sort by the **saved** figures (`sales`), so the order refreshes on save/reload rather
than mid-keystroke; that is also what makes the memo possible, since the draft is no longer a
dependency.

### Adding a text input to an old page is a performance change (added S650)

Everything above is written as *finding* pages that are already slow. The cheaper moment to act is
the one where a page **acquires** its first controlled text input, because that is when every
render-body derivation on it retroactively becomes a per-keystroke cost — including the ones
written years earlier by someone who could reasonably assume the page only re-rendered on a load.

Purchases is the worked example: adding a Bill no. search box put `filtered` (a scan of the
period's rows), `byDay` (a regroup of them) and `filteredPayable` (which walks every bill group
through `calcBillTotals`) on the keystroke path in one edit. All three were memoized in the same
change, values unchanged.

**So: before adding a search or filter box to an existing page, read its render body and memoize
what is already there.** Doing it in the same commit is the difference between a fix and a
regression — and unlike the audits above, this one has a trigger you can actually notice.

### The trigger is not always a keystroke

A controlled input is the most common cause, not the only one. Any state a *pointer gesture* writes
has the same effect, and those fire faster than typing:

- **A drag-select.** Roster's `onMouseEnter` calls `setSelection` on every cell the pointer crosses,
  so one drag across a 32-column row is 32 full re-renders. It was rebuilding the columns, re-running
  a 100-iteration contrast search per shift type, and recomputing a 32-column labor strip each time
  — 2.75 ms → 0.19 ms per render once memoized, measured at 40 staff.
- **A row disclosure.** `PayrollCalculation`'s only interactive state is `expandedId`, and expanding
  one employee's detail panel re-ran `computePayslip` plus a TDS slab walk for *every* employee.
- **A status message or a busy flag.** `PayrollRun`'s freshness check was a bare render-body IIFE
  running the whole payroll engine, so `setMsg`, `setBusy` and opening the Finalize confirm each
  re-ran it. None of those move any of its inputs.

Ask what the page's cheapest state write is, not whether it has a text box.

### A `.filter()` per row over a per-row-per-day array is the same shape wearing a join

Both payroll pages built one payslip per employee and took that employee's slice of `components`,
`attendance` and `otEntries` with a `.filter()` inside the `employees.map()`. `attendance` is one
row per employee per **day** — ~1,200 rows at 40 staff — so it was walked 40 times over: 56,000
element visits where 1,400 would do. `groupByEmployee`/`sliceFor` in `payrollData.js` partition
each array once.

Two properties are load-bearing, and the second is why there is a test rather than just a helper:
`.filter()` preserves source order and so does appending in source order, so the slices are
**byte-identical** to what the filters produced — which matters because both callers feed them
straight into `computePayslip` on a path that WRITES payslips. `payrollData.test.js` asserts it.

### When NOT to memoize the row

`React.memo` on a table row needs stable callback identities, which means ref-wrapping the
handlers. On a page whose row handler is on a read–modify–write path (Stock Count's `saveRow`), a
stale closure corrupts a saved figure rather than merely rendering an old number. Take the smallest
safe cut — memoize the derived lists — and leave the row alone. Same reasoning as `PosOrders.jsx`.

## A poll that always calls its setter re-renders the page forever (added S629, POS)

A `setState(freshRows)` always re-renders, because the array is new even when every row in it is
identical — normally harmless, but a **screen that polls** does it on a timer for as long as the
screen is open, whether or not anything moved. POS Orders polls its KOT tickets and its pending
guest requests every 5 s each and set both unconditionally, so the largest component in the product
reconciled its whole tree roughly every 2.5 s for the length of a service; the Kitchen Display did
the same on a wall-mounted screen that is never closed. The overwhelmingly common answer to all
three polls is "nothing has changed".

`setIfChanged(setState, next, signOf)` (`src/shared/setIfChanged.js`) returns `prev` unchanged when
the signature matches, which is React's own documented render bail-out — one string comparison
instead of a render. `rowsSignature(rows, fields)` and `mapSignature(obj, valueOf)` build the
signature.

Two things to keep right, and the first is the dangerous one:

- **The signature must cover every field the screen draws.** One omitted field is a stale render
  that never repaints, which is worse than the cost it saves. Adding a column to the *query* needs
  no change here; starting to *display* one does.
- **Immutability is what lets a field be left out, and it has to be true.** Both POS call sites omit
  `pos_kot_log.items` because a ticket's lines never change after it is written — a later send
  inserts a new row and a pulled line lands in `pos_kot_removals` — so any real change arrives as a
  different set of ids. That is a fact about the table, stated at each call site; do not copy the
  omission to a table where it does not hold.

Distinct from memoizing a derivation: that makes a render cheaper, this removes the render.

## An `.in(column, ids)` list is a URL, not just a row count (added S629)

A `.in()` filter is spelled out in the request URL. A uuid costs ~37 characters, so a few hundred
ids is already past what proxies accept — and that failure is a **414, i.e. loud**. The quiet half
is that the 1000-row cap still applies underneath, and one parent can own many rows: a list of 200
order ids matches thousands of `pos_order_items`.

`fetchAllRowsChunked(ids, makeQuery)` splits the list, pages each chunk through `fetchAllRows` and
runs the chunks together; `runChunkedByIds(ids, makeQuery)` is the write-side equivalent for an
`UPDATE`/`DELETE` filtered the same way (sequential, first error wins, and **not** atomic — some
chunks may already have landed).

The POS→IMS backfill is the worked example and shows why both halves matter at once: its
already-posted guard read `sales_entries` by `.in('pos_order_id', everyCandidate)`, so on a real
month it was both too long for the URL and far past 1000 rows — and either failure makes posted
bills look unposted, which re-posts their revenue. That is the exact bug the guard exists to
prevent. It now aborts on a read error rather than treating an empty result as "none of these has
posted".

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

## Whether a page can adopt `sessionDataCache`

Two independent tests, and a page must pass **both**:

1. **Nothing on the page batch-saves using on-screen state as a baseline.** This is the existing
   rule in `CLAUDE.md` (Stock's "Save All", Sales' per-mode save). Purchase Orders fails it too —
   `confirmReceive` writes `qty_received + receiving`, so a stale cached row double-counts a
   delivery.
2. **The cached sections must be able to shorten the skeleton.** Caching a page's reference lists
   while its *core content* still blocks on a fresh read buys nothing visible — the skeleton waits
   for the core read regardless. That is dead code carrying a staleness risk, so don't wire it.

Items and Vendors pass both (their saves write only the record being edited, and the list *is* the
page). Purchase Orders and Variance fail both and are deliberately unwired, with the reasoning left
in a comment at the state declarations so the next sweep doesn't re-attempt it.

## Page-revisit caching (`src/shared/sessionDataCache.js`, added S460)

Migrated from the root `CLAUDE.md` (S663).

Route-level pages unmount on navigation, wiping local `useState` — so revisiting a page (Dashboard → Stock → Dashboard) re-fetches everything from scratch by default, which is a real chunk of the app's felt slowness on top of the usual network latency. `sessionDataCache.js` is a deliberately dumb `sessionStorage` key-value cache (`readPageCache(page, section, clientId)` / `writePageCache(...)`, 10-minute max age, keys namespaced per page so two pages can each have their own `items` section without colliding) — it does no calculation of its own, just storage, so adopting it never touches a page's actual data-fetching or math. The pattern: seed each relevant `useState`'s initial value from the cache (`useState(() => readPageCache(...) ?? fallback)`) so a revisit paints instantly, and wrap the existing setter calls in a small local `setAndCache(setter, section, value)` helper that also persists to the cache — no other change to the load function.

**Before adding this to a new page, check whether anything on it batch-saves "every visible row" trusting current on-screen state as the baseline** — that's the one shape where this pattern is actively dangerous, not just ineffective. `Stock.js`'s "Save All" (writes every visible item's currently-shown count, not just user-edited ones) and `Sales.js`'s per-mode save (merges typed edits against "the current saved value" as a fallback for every *other* item) both have this shape, and for a POS-enabled client `sales_entries` keeps changing in the background all day as bills close — so a stale cached number reaching one of these saves could silently overwrite a real figure. `Sales.js` only caches `periods`/`recipes` (the menu/period list, never a save-time baseline) for exactly this reason; `Stock.js` was left with no caching at all, since on that page essentially everything load-bearing is save-sensitive. Pages where saving only ever writes the one record being edited (`Purchases.js`, `Recipes.js`, `Items.js`, `Vendors.js`, `ClientDashboard.jsx` which never saves at all) are safe for the full treatment — confirm which shape a new page has before wiring this in, don't assume.

**A second test, added S626: the cached sections must be able to shorten the SKELETON.** Caching a page's reference lists while its *core content* still blocks on a fresh read buys nothing visible — the user waits for the core read either way — so it is dead code carrying a staleness risk. `PurchaseOrders.js` fails both tests (its PO list is the page, and `confirmReceive` writes `qty_received + receiving` off that state, so a stale row double-counts a delivery) and `Variance.js` fails the same way; both were wired up, measured as pointless, and reverted with the reasoning left in a comment at their state declarations so the next sweep doesn't re-attempt it. The round-trip and per-keystroke rules this came out of are in `.claude/rules/frontend-performance.md`.

`AuthContext.js`'s own `fetchProfile()` waterfall (`profiles` → `clients` → `feature_flags`) was also part of this same pass — `clients` and `feature_flags` only depend on `client_id`, not on each other, so they now run as `Promise.all` instead of two sequential round trips.

---

## An overlapping load must not win the page (S601)

Migrated from the root `CLAUDE.md` (S663).

Every period-scoped page had the same handler: `setSelectedPeriod(…)` → `setLoading(true)` →
`await buildReport(id)` → `setLoading(false)`, with the load setting its data whenever it resolved.
Nothing identified which load was current. A closed native `<select>` fires `change` on every arrow
keypress, so arrowing a 12-period list starts twelve concurrent loads — each a `Promise.all` of eight
to eleven queries — and **the last response to land wins the figures while `selectedPeriod` is
whatever was clicked last**. On Consolidated P&L that label drives the subtitle, the print title, the
Excel `scopeLine` AND the downloaded filename, so one month's figures could leave the building inside
another month's workbook.

`src/shared/hooks/useLatestRequest.js` is the one guard, now on **22 pages (measured by grep,
2026-08-30)** — the S601 sweep claimed 19 while never wiring `ConsolidatedPnl.jsx` or
`StockAgeing.js`, the two pages this rule's own text is about; both were caught by the S612
critique re-run and wired then. `GroupDashboard.jsx` was the 22nd (S657): it appeared in neither
the swept list nor the not-swept one, and its loader is a `useCallback` keyed on `(bsYear,
bsMonth)`, so arrowing either `<select>` starts one `get_group_summary` per keypress on the page
that compares outlets' money across months. Call `periodReq.begin(id)`
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

**Not swept:** `AttendanceSheet.jsx` and `Overtime.jsx`, and
`SupplierPriceTracker.js`/`MonthlyOwnerReport.jsx`, which select an id and derive rather than load.
The first two were skipped because their loaders take `(bsYear, bsMonth)` rather than one id and
"would need a composite key" — S657 built exactly that on `GroupDashboard` (a `bsYear-bsMonth` key),
so the stated reason no longer holds and the pair is simply unswept.

## The 1000-row truncation sweeps: S528, S529, S613, S628

The RULE (and `fetchAllRowsChunked`) stays in the root `CLAUDE.md`. These are the sweep histories behind it, migrated S663 — read them before starting another sweep.

Found live (S528) on Stock Movements: the page reported "1000 movements / NPR 49,241 depleted" for a period that actually had 1753 / NPR 87,043. The round number was the only tell, and it had been wrong in production for as long as that client had been busy enough to cross the cap. `ReorderReport.js` had the same shape on the same table, so **Book Stock — a figure people place purchase orders against — was silently low too.**

S529 swept the rest: **61 call sites across 42 files**. Row-count thresholds worth knowing, since they decide whether a table needs this at all — `hr_attendance` is one row per employee **per day**, so it crosses 1000 at ~34 staff (that one silently zeroed daily/hourly pay and removed absence deductions for monthly staff, since employees past the cutoff simply appeared to have no attendance); `pos_order_items` is one row per line per bill, so a month of ordinary service is thousands; `purchase_entries` is fine for one period but not for the fiscal-year and all-time reports (Annual Summary, VAT/Non-VAT, One Lakh Above, Vendor Balance Confirmation, Supplier Price Tracker, and Outstanding Payables — that last one unbounded by period, so it gets worse the longer the system is used).

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

**S628 found four more of that exact shape in HR** — `HrReports`' YTD TDS, Festival Allowance's and
Incentive Run's YTD gross, and `fetchSsfStartMap` — every one on a tax or gratuity figure, all
sitting a file or two from the `payrollData.js` helpers S620 had just fixed. It also found
**`hr_roster` unpaged while `hr_attendance` beside it was paged**, on the same page, ten lines
apart, at the same cardinality. **Decide by rows-per-what, not by table name:** per-employee-per-day
and per-anything-per-month both cross 1000 inside one real client-year. And note the guard problem
— truncation returns **no error**, so every `if (error)` check written against a failed read passes
happily over a short one. Details and the HR-specific consequences are in
`.claude/rules/frontend-performance.md`.

**Two traps when doing a sweep like this**, both hit live: (1) if the original chain continued past the line you're editing, the closing paren lands too early and the trailing `.order(...)` gets applied to fetchAllRows' *result* — a plain `{data,error}`, not a builder — which is a runtime `TypeError`, not a build error, so only actually loading the page catches it (`Purchases.js`, found exactly this way). (2) A CRA dev server left running shares `node_modules/.cache` with `npm run build` and will keep rewriting stale ESLint entries underneath it, producing phantom errors on files where the import and the usage are both plainly present — `'fetchAllRows' is defined but never used`, and equally `'X' is not defined` on an import sitting at the top of the file. **The one file that matters is `node_modules/.cache/.eslintcache`** (deleting the whole `.cache` directory fails while the dev server holds `babel-loader` open, which reads as the fix not working). **`npm run build:verify` is the packaged answer** — `scripts/build-verify.mjs` removes that one file and then runs the build with `CI=true`, without disturbing a running dev server; if it still reports the error, the error is real. Zero dependencies and Node-based on purpose: `rimraf` is present only transitively here and would vanish on an install, and `rm -f` plus a `VAR=value` prefix is POSIX-only on a Windows machine. `npm run build` stays a plain `react-scripts build` because that is what Vercel runs. Verify the import really is present with a grep before assuming a phantom — the two look identical in the build output.

## The `xlsx` dynamic-import sweep (S522)

Migrated from the root `CLAUDE.md` (S663). The rule — `xlsx` is always `import('xlsx')` inside the click handler — stays resident there; this is the sweep that applied it across all 37 pages, including the three files that needed a different shape.

- **`xlsx` is always `import('xlsx')` inside the click handler, never a top-level `import * as XLSX from 'xlsx'` (S522).** Route-level lazy-loading (S440 above) only defers a *page's own* code — it does nothing about a library that page statically imports, which webpack still must fetch as a parallel chunk the moment the route itself loads. `xlsx` (SheetJS) is genuinely huge (138 kB gzipped, the single largest chunk in the app after `main.js`) and is only ever touched by an explicit "Export Excel"/"Import Excel" click, never by simply viewing a page — so a static import was paying that 138 kB on every visit to any of the 37 pages that have an Excel button, whether or not the button was ever clicked. Fixed across all 37 by making the export/import handler function `async` and adding `const XLSX = await import('xlsx')` as its first line; verified in the built output (`r.e(1238).then(r.bind(r,1238))` now sits inside the button's `onClick`, not at module top level). Two files needed a different shape rather than a flat per-function fix: `SalesReport.jsx`/`CoversReport.jsx` share one `withLetterhead(title, ...)` helper across every tab's export branch, so `XLSX` is now its first parameter instead, passed down from the one `await import('xlsx')` in `exportExcel`; `MonthlyOwnerReport.jsx`'s `monthlyReportExcel.js` uses `XLSX` throughout a whole dedicated helper file, so instead of touching every internal function, the *page* now dynamically imports the whole module at click time (`const { exportMonthlyReportExcel } = await import('../../modules/ownerReport/monthlyReportExcel')`) and that file's own top-level `import * as XLSX from 'xlsx'` was left untouched. `recharts` (102 kB gzipped, the other large chunk) was deliberately left as a static import everywhere it's used — charts are core above-the-fold content on those pages, not a deferred click action, so eagerly loading it is correct per `/impeccable optimize`'s own rule against lazy-loading above-fold content.

## Why a supabase-js call hangs: the auth-stall diagnosis (S449–S455)

Migrated from the root `CLAUDE.md` (S663). The rules — guard user-gating awaits with `withTimeout()`, and only `/auth/v1/` is bounded at the client level — stay resident there. This is the mechanism, which is what makes the rules make sense.

- **A supabase-js call can hang forever — and `.abortSignal()` does not save you.** Every call goes through `fetchWithAuth` (`@supabase/supabase-js/src/lib/fetch.ts`), which does `await getAccessToken()` on **line 43** and only reaches `fetch(...)` on **line 70**. `getAccessToken()` calls `auth.getSession()`, which can itself stall (a token refresh that never settles, or one of the known GoTrue init/lock deadlocks — the reason `supabaseClient.js` already installs a no-op `lock`). When it stalls, `fetch` is never invoked, so the AbortController passed via `.abortSignal()` is attached to nothing and firing it does *nothing*: the promise never resolves **and** never rejects, so a `try/finally` that resets a `saving` flag never runs and the button stays disabled forever. Guard any user-gating await with `withTimeout()` (`src/utils/withTimeout.js`) — a `Promise.race` against a wall clock is the only thing immune to where the hang is. Keep `.abortSignal()` alongside it (that's still what cancels a genuinely in-flight request); it's a complement, not a substitute. S449→S454 burned four rounds on this exact bug in `Sales.js` because each fix only covered the layer above the real one.

- **Why `getSession()` stalls in the first place, and the client-level fix (S455).** auth-js sets **no timeout on its own network calls**. An expired access token makes the next `getSession()` call `_callRefreshToken()` → `fetch('/auth/v1/token')`; if that stalls, the auth client wedges *permanently*, not just for that call — `_acquireLock` drains via `while (this.pendingInLock.length) { await Promise.all(waitOn) }` (`GoTrueClient.ts` ~2803), so one never-settling promise means the loop never exits, `lockAcquired` is never reset, and every later `_acquireLock` chains `await last` onto the dead promise. Because supabase-js awaits `getAccessToken()` before *every* DB request, one stalled refresh silently freezes every query/insert/update app-wide with no error anywhere until the tab is closed. `src/supabaseClient.js` now passes `global.fetch` (handed straight to the auth client by supabase-js, `SupabaseClient.ts:340-344`) through `makeAuthTimeoutFetch()` (`src/utils/authFetchTimeout.js`), which bounds **only** `/auth/v1/` requests at 15s so the promise settles, the drain loop completes and the client self-heals. PostgREST and Storage traffic is deliberately left unbounded there so a slow report or a large upload is never cut off — bound those per-call with `withTimeout()` instead.
