---
paths:
  - "src/shared/fetchAllRows.js"
  - "src/shared/sessionDataCache.js"
  - "src/utils/offlineQueue.js"
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
  That page became Payroll's expandable row in S768, and the shape moved with it: `PayrollRun`'s
  `liveRows` is a `useMemo` that does not list `expandedId`, so opening a working reads the row
  already computed instead of re-running the engine.
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

**Items' usage scan was the same shape with the opposite failure (S706).** It passed every one of
the client's item ids — 254 in the reference client, ~9 KB of uuids — into eight `.in()` reads, and
each read's failure was then `if (error || !data) return`, skipped quietly as "table may not exist
for this client". So the loud 414 this rule promises was caught and silenced one line later,
blanking the whole Used In column and opening a delete guard that three `ON DELETE CASCADE` tables
do not back up. **A 414 is only loud if the call site lets it be**: check what the caller does with
the error before counting on the failure being visible, and never spend a table's read error on a
"that table might not exist" assumption that no longer holds.

The POS→IMS backfill is the worked example and shows why both halves matter at once: its
already-posted guard read `sales_entries` by `.in('pos_order_id', everyCandidate)`, so on a real
month it was both too long for the URL and far past 1000 rows — and either failure makes posted
bills look unposted, which re-posts their revenue. That is the exact bug the guard exists to
prevent. It now aborts on a read error rather than treating an empty result as "none of these has
posted".

## Caching and offline

Page-revisit caching (`sessionDataCache`) and whether a page may adopt it, caches that outlive the session that filled them, and what `navigator.onLine` does and does not tell you: `.claude/rules/offline-and-cache.md` (auto-loads for `sessionDataCache.js`, `offlineQueue.js`, `AuthContext.js` and the pages that use either).

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
rendering permanently blank. Of the two possible mistakes only one is recoverable by the user.

**A page's own `init()` DOES need its `begin()`** — this paragraph used to say the opposite, on the
reasoning that once the handler claims, init's stale load is rejected by its own `isCurrent`. That
is true of the DATA and not of the LABEL: `init` also calls `setSelectedPeriod`, which no guard
covers, so a period change during a first load left the dropdown snapping back to the open month
over another month's table — figures and label disagreeing, the exact thing the guard exists to
prevent. S698 fixed it in `Purchases.js`, S709 in `PurchaseOrders.js`, S718 in `StockAgeing.js`,
S721 in `StockMovements.js` and S722 in `PaymentReport.js` — all five against the hook's own
documented contract ("anything
that auto-selects a period must call `begin()` too"), while this file was arguing they did not have
to. **S721 is the instance that shows the stakes are not always a flicker**: once
`handlePeriodChange` has run even once the ref is permanently non-null, so `isCurrent` stops
failing open — and an ADMIN SWITCHING CLIENT re-runs `init()` on a still-mounted component with the
previous client's period id still in the ref. Every setter in the loader is then skipped, and the
new tenant gets the old period chip over an empty ledger. The fail-open property that makes a
missed `begin()` survivable only holds until the FIRST claim.

The S718 instance is worth noting separately because that page is where this whole rule was
written: `StockAgeing` selects a fiscal YEAR rather than a period, and `init()`'s `setSelectedFy`
is exactly the unguarded label write the rule describes. A page whose dropdown cannot render until
loading finishes is safe either way; claim it anyway, rather than making every reader re-derive
which kind it is.

**S682 took it to 38 pages (measured by grep) and closed the report tail.** The twelve period-driven IMS reports that
had never been swept — VAT, Non-VAT, Purchase 1L+, Annual Summary, Vendor Balance Confirmation,
Wastage, Dead Stock, Shrinkage, Best Sellers, Menu Engineering, Menu Repricing, Recipe Margin —
plus `MonthlyOwnerReport` and `Overtime`. Two of those are **statutory filings** whose selected
period is also the print title, the workbook scope line and the filename, which is the case this
rule was written about. `Overtime` was on the not-swept list below for taking `(bsYear, bsMonth)`
rather than one id; it uses a `${bsYear}-${bsMonth}` composite key, exactly as `GroupDashboard`
does, so that reason is now spent everywhere it was given.

**S693 added a 39th, and it is the first that is not period-driven.** Roster's Labor Forecast tab
now runs TWO guarded loaders side by side: the actuals loader keyed on the visible range, and the
labour-standard loader keyed on `clientId`. The second one needs the guard for a different reason
from every other adopter — not arrowing through periods, but an ADMIN SWITCHING CLIENTS with the
tab open, which would otherwise let one outlet's 120-day history land on another outlet's rows.
Two loaders on one page is fine; each holds its own `useLatestRequest`, since a shared one would
have them cancelling each other.

**S699 added a 40th, and it is the first SECOND AXIS inside a page that was already swept.**
`Sales.js` had `periodReq` from the original sweep and was counted done — but `periodReq` keys on
the period id, and the Daily tab reloads on every `‹`/`›` press, so the axis the page actually
races on had no guard at all. Two quick clicks start two loads; the later-landing one wins
`dailySales`. Three things generalise:

- **A page is swept per LOADER, not per page.** Ask what each loader is keyed by and whether every
  control that can restart it moves that key. Here `loadDailySales(periodId, day)` took a second
  argument that no guard mentioned, in a file whose adoption of the rule was already on record.
- **On a WRITE surface the stakes are not a flicker.** `dailySales` is the baseline
  `buildDailyRows()` merges every untouched row against, so the losing load did not merely display
  the wrong day — Save Day wrote one day's whole grid onto another day's `bs_day`, after
  `save_sales_day` had deleted what was there. Sweep the entry pages before the report pages.
- **A composite key is the answer here too**, as it was for `GroupDashboard` and `Overtime`:
  `` `${periodId}:${day}` ``. The paragraph below said the composite-key reason was spent
  everywhere it had been given; this was the one place it had never been asked.

**`AttendanceSheet.jsx` was swept in S749**, and it was a write surface: a stale load won `records`
while `period` was the last pick, so Save Day wrote one month's rows under another month's
`period_id`. It holds a `periodReq` keyed on the period id now — it had stood on this list for a
stated reason ("its loaders take `(bsYear, bsMonth)` and would need a composite key") that S657 had
already spent and that no longer even fit its one-id loader. **Not swept:** `SupplierPriceTracker.js`,
which selects an id and derives rather than loads. `MonthlyOwnerReport.jsx` stood on this list until S682 wired it and holds a `periodReq`
now.

**The four POS report pages were swept in S754**: `SalesReport`, `CoversReport`,
`PosExceptionReport` and `KotLog`, the last with one guard per tab loader. They pick a date RANGE
rather than a period, so the key is `` `${clientId}:${fromIso}:${toIso}` ``, and the 1L+ tab keys
on client + fiscal year. A reload of the same range still lands, and an admin's client switch does
not. The race here was the S601 one exactly: the export's scope line and filename come from the
pickers, which move before the data does.

## A bare `.select()` silently truncates at 1000 rows — the rule

Moved verbatim from the root `CLAUDE.md` (S769 context-reduction pass). The root keeps only the one-line rule.

Supabase sets PostgREST's `db-max-rows` to 1000. A `.select()` with no `.range()` that matches more rows than that returns the first 1000 with **no error and nothing in the data to say so** — every total summed from that array is then wrong, and wrong quietly, which is the dangerous part: it reads as a real figure until someone compares it against another source. Found live (S528) reporting 1000 movements / NPR 49,241 against a real 1753 / NPR 87,043.

Use `fetchAllRows(makeQuery)` (`src/shared/fetchAllRows.js`) for any read that can realistically exceed 1000 rows — transaction tables rather than master data. Two rules: it takes a **function** returning a fresh builder (a supabase-js builder is a one-shot thenable and cannot be awaited twice), and that query must carry a **unique tiebreaker in its sort** (`.order('id')` after the display order), or paging a non-uniquely-ordered query repeats a row on one page and skips it on the next.

**Decide by rows-per-what, not by table name, and count what the QUERY returns rather than what the function is named after.** A read narrowed in JS is bigger than it reads: `fetchYtdMap` looked scoped to one month while pulling the client's entire history. Per-employee-per-day and per-anything-per-month both cross 1000 inside one real client-year. And note the guard problem — truncation returns **no error**, so every `if (error)` check written against a failed read passes happily over a short one.

**Deliberately not wrapped:** single-parent reads (`.eq('order_id', X)` for one bill), `head: true` count queries, single-day reads, and id-bounded backfill lookups. Wrapping those would be noise.

**`.in(column, ids)` lists:** see "An `.in(column, ids)` list is a URL, not just a row count" above (`fetchAllRowsChunked` for reads, `runChunkedByIds` for writes, which is not atomic).

The two traps that cost rounds when converting a read to `fetchAllRows` follow. The sweep records themselves are archived (see "Sweep records and diagnoses" below).

**Two traps when doing a sweep like this**, both hit live: (1) if the original chain continued past the line you're editing, the closing paren lands too early and the trailing `.order(...)` gets applied to fetchAllRows' *result* — a plain `{data,error}`, not a builder — which is a runtime `TypeError`, not a build error, so only actually loading the page catches it (`Purchases.js`, found exactly this way). (2) A CRA dev server left running shares `node_modules/.cache` with `npm run build` and will keep rewriting stale ESLint entries underneath it, producing phantom errors on files where the import and the usage are both plainly present — `'fetchAllRows' is defined but never used`, and equally `'X' is not defined` on an import sitting at the top of the file. **The one file that matters is `node_modules/.cache/.eslintcache`** (deleting the whole `.cache` directory fails while the dev server holds `babel-loader` open, which reads as the fix not working). **`npm run build:verify` is the packaged answer** — `scripts/build-verify.mjs` removes that one file and then runs the build with `CI=true`, without disturbing a running dev server; if it still reports the error, the error is real. Zero dependencies and Node-based on purpose: `rimraf` is present only transitively here and would vanish on an install, and `rm -f` plus a `VAR=value` prefix is POSIX-only on a Windows machine. `npm run build` stays a plain `react-scripts build` because that is what Vercel runs. Verify the import really is present with a grep before assuming a phantom — the two look identical in the build output.

## Sweep records and diagnoses (archived)

The 1000-row truncation sweeps (S528, S529, S613, S628), the POS sweep (S629), the `xlsx` dynamic-import sweep (S522) and the supabase-js auth-stall diagnosis (S449–S455) moved word for word to `docs/rules-archive/frontend-performance.md`. That file is not auto-loaded; read it before starting a new sweep. The build exit-code rule (S693) is now in the root `CLAUDE.md`, Commands.

## A `try/catch` around a supabase call catches nothing (S654)

Moved verbatim from the root `CLAUDE.md` (S769 context-reduction pass). The root keeps only the one-line rule.

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

**A builder that is never `await`ed never runs.** postgrest-js sends inside `then()`, so a bare
`supabase.from(x).update(y).eq(…)` statement builds an object and drops it — no request, no error.
It reads like deliberate fire-and-forget, which is why review misses it; S715 found one dead since
it shipped, a paid feature's column NULL for every client. Fire-and-forget is `void p.then(ok, onErr)`.
