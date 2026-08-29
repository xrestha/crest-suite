---
paths:
  - "src/shared/fetchAllRows.js"
  - "src/shared/sessionDataCache.js"
  - "src/shared/hooks/useLatestRequest.js"
  - "src/modules/ims/**"
  - "src/modules/hr/**"
---

# Round trips and keystrokes: the two shapes that make a page feel slow

From the `/impeccable optimize` sweeps over IMS (S625/S626) and HR (S628). **The HR sweep found
every one of these shapes again**, which is the argument for the rule rather than a note on it —
`src/modules/hr/**` was not on the `paths:` list above until S628, so none of this loaded while
anyone worked there. A rule scoped to the module it was learned in is a rule the next module
repeats. Both shapes are invisible in review —
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
