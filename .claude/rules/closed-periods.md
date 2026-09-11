---
paths:
  - "src/pages/Periods.js"
  - "src/pages/periods/**"
  - "src/pages/dashboard/ClientDashboard.jsx"
  - "src/modules/ims/purchases/**"
  - "src/modules/ims/sales/**"
  - "src/modules/ims/stockcount/**"
  - "src/modules/ims/reports/Overheads.js"
---

# A closed period is read-only for the CLIENT and writable for ADMIN (S651)

> Split out of the root CLAUDE.md so it loads only on the pages that carry the lock. The root file
> keeps the one-open-period constraint itself, since that is reachable from anywhere.

Every period-scoped entry page spells the same line:

```js
const isLocked = !isAdmin && selectedPeriod?.status === 'closed'
```

`Purchases.js`, `PurchaseBillPage.jsx`, `Sales.js`, `Stock.js`, `Overheads.js` and — since S709 —
`PurchaseOrders.js`: six copies, all agreeing. **The `!isAdmin` carve-out is the feature, not an
oversight**: an admin correcting history is a real, expected job, and the alternative (reopen the
month) is structurally unavailable.

## The page that writes a locked table is not always the page that looks locked (S709)

`PurchaseOrders.js` had no `isLocked` for its whole life, and the reason it went unnoticed is worth
keeping: **it does not look like an entry page.** It is a document workflow — raise, send, receive —
and the count of pages that lock was taken from the pages that have a period selector over a grid of
figures. But Receive writes `purchase_entries`, the same table `Purchases.js` locks four lines away,
so this was the way around a period close for anyone who happened to be on it. Ask which TABLES a
page writes, not which shape it has.

**S710 found the other half of that sentence still wrong.** Eight IMS surfaces carry the lock — `grep -rn "periodClosed\|isLocked" src/modules/ims` returns Purchases, PurchaseBillPage, ReturnsTab, PurchaseOrders, Sales, Stock, Overheads and Requisitions — while the Dashboard's close dialog and the module guide both enumerated **four** of them. Requisitions had locked since it was built and was named nowhere; Purchase Orders joined the list in S709 and the copy did not move with it. Periods.js is fine because it says "IMS entry pages lock" and enumerates nothing. **An enumeration in user-facing copy is a second definition of the lock set, and it rots the moment a page joins.** Prefer the generic phrasing; where a list is genuinely more useful, re-derive it from that grep whenever a page gains or loses `periodClosed`.

It is also the first period lock with a **server-side** half: `receive_purchase_order()` refuses a
closed period itself (`po_period_closed`), with the same `is_admin()` carve-out, wrapped in
COALESCE. The other five remain browser-only, which is defensible while they are the only door to
their tables — but the rule that made this one different is that a receipt is an RPC, and an RPC
that can be called directly is a door the page does not control.

## HR is deliberately NOT locked by the close, and the dialog must say so (S683)

`grep -rn "status === 'closed'\|isClosed" src/modules/hr` returns nothing, and that is a decision,
not a gap. HR does its month's work AFTER the stock month closes — the count is on the 1st, OT is
approved and payroll finalized by the 5th — so an IMS-style `isLocked` on Attendance, Overtime or
Payroll Run would block every HR client's payroll for the month just ended. **HR's lock is Payroll
Run's own finalize**, and an attendance edit after that is surfaced as `⚠ Stale` on
`/hr/calculation`, not prevented.

What was wrong was the sentence. Both close dialogs said *"entry pages become read-only"* with no
qualifier, so the frozen Monthly Report's labour figure could move after a month the Owner had
been told was locked. Every close dialog now names what locks — *IMS entry pages (Purchases,
Sales, Stock Count, Overheads)* — and, when HR is on, says HR stays open. A **payroll preflight**
(`payrollPreflight()` / `payrollNote()`) sits beside the closing-count one: amber when payroll is
not finalized, because the frozen report then carries an ESTIMATED labour cost
(`computeMonthlyReport.js` prefers a finalized run and falls back to an estimate, labelled
`payrollSource: 'estimated'`) until an admin runs Regenerate Snapshot. It informs and never blocks,
on the same contract as the closing-count note. **Do not add a period-close lock to an HR page**
without re-reading this; if the product ever wants one, it has to be "closed AND payroll
finalized", which is just the payroll lock that already exists.

## The close is ONE routine — `performPeriodClose()` — and the Dashboard uses it too (S683)

Until S683 the product had two closes. `Periods.js`'s three paths closed the month, opened the
next one, carried the closing count forward, minted the frozen report, and (since S613) ran the
closing-count preflight. The Dashboard's **"End Bhadra & Start Ashwin →"** — the button an Owner
actually presses, from the "has ended" banner — updated the status and inserted the next row, and
did nothing else, under a dialog promising all three. The IMS module guide had noticed (*"the
Dashboard's shortcut does NOT carry forward… always close from Periods"*) and taught the workaround
instead of the fix — **a guide that documents a defect as advice is the tell that the defect is
old.** Every month closed from the Dashboard before S683 opened with no opening stock and no
snapshot until someone visited the report; "Resync Opening Stock" is the repair.

`src/pages/periods/closePeriod.js` now holds the whole thing: both preflights, the carry-forward,
`performPeriodClose({ clientId, period, openNext, actorId })`, and `closeFailureText()`.
`CloseConfirmBody` renders every close dialog's notes. Four ASKS with four framings (Owner on the
Dashboard, client on Periods, admin close-and-advance, admin End Period), one COMMIT. Three
properties of the commit are load-bearing:

- **It never throws; each stage records its failure and the later stages still run where they
  can.** A failed carry-forward must not stop the report; a failed report must never stop the
  close. The one exception is the close itself — if the status update fails, nothing else runs.
- **`failures` is ordered by how much the reader has to do about it**, and callers surface
  `failures[0]` through `closeFailureText()` — a consequence sentence (what state the month is in
  now, and the repair), never `error.message`. The `close` stage says *"may not have closed"*: a
  dead fetch does not prove the update did not land, and inviting a retry over a month that is
  already closed is worse than sending them to look.
- **"Report is ready" renders only when `reportSaved` is true.** `Periods.js` used to show that
  banner after a failed generation.

`closePeriod.test.js` pins all of it against a mocked db, including the `23505`-on-retry branch
and the S682 "failed closing_stock read is a failure, not an empty count" rule. Change the commit
there, not in a page.

**The carry-forward read is PAGED (S705).** It is one
row per item, so a bare `.select()` sat exactly on PostgREST's 1000-row cap and a 1000-SKU client
carried forward only the first 1000 — no error, nothing in the data to say so. What makes it worse
than an ordinary truncation is that `closingCountPreflight()` counts with `count: 'exact', head:
true`, which is **not** capped: the dialog said *"All 1,203 active items have a closing count"*
while 203 of them entered the new month at zero. S616 aligned those two populations deliberately
("the sentence and the carry-forward cannot disagree") and the row cap silently un-aligned them
above 1000 — **an invariant asserted between two queries is only as true as the smaller query's
limit.** `fetchAllRows` with `.order('item_id')` as the tiebreaker; `closePeriod.test.js` pins it
with a 1000-row first page, and that test was verified to fail against the unfixed code before
being kept.

## "The next period" is the next one that EXISTS, never `bs_month + 1` (S738)

The product skips months by design: **End Period** closes a month and opens nothing, and
**+ Create Period** mints *today's* month whenever the client comes back — so a client paused for
two months has a gap in its list. Periods' "Resync Opening Stock" resolved its target by
arithmetic and told exactly that admin *"No Ashwin period exists yet — nothing to sync into"*,
naming a month that would never exist, while Stock Count's "Pull last month's closing" walked the
list. Two carry-forwards, two definitions of "next".

`nextExistingPeriod()` / `previousExistingPeriod()` in `closePeriod.js` are the one definition,
and all three carry-forwards use them. **A period created by hand carries forward too**
(`createPeriodWithCarryForward()`): both "+ Create Period" buttons used to open the month with no
opening stock and say nothing — COGS = opening + purchases − closing, so a month opened at zero
*understates* COGS and flatters food-cost %, a wrong figure rather than an error. The notice
after a create says which month the count came from, or that there was nothing to carry, and
`carryForwardOpeningStock()` returns `carried` so a caller can tell an empty source from a
successful copy.

Three more rules from the same pass:

- **A period rename is a data move, and the audit trail has to see it.** Thirteen tables hang off
  `monthly_periods` by `period_id`; relabelling Bhadra → Ashwin moves the month's every row into a
  different reporting month. `log_audit()` skipped every `monthly_periods` update that was not a
  status change until migration `20260911120000`, so the highest-consequence write on the page was
  the one with no trace. Both edit paths confirm through the shared modal; the
  `.eq('status','open')` guard is followed by `.select('id')`, because zero rows back is
  `error: null` and used to report a save over a value that had not changed.
- **A button's label is the verb it performs.** The all-clients "+ Create Period" silently reopened
  a closed period when today's month already existed. It is now "Reopen <month>" in that state,
  behind a confirm, and only the create branch creates.
- **The POS backfill button follows the `!isAdmin && closed` lock.** It writes `sales_entries` and
  `stock_movements`, and was the one control on Periods that let an Owner or an IMS supervisor
  write into a closed month. Admin keeps it on every row; posting into a closed month says the
  frozen report is stale and names Regenerate Snapshot, as the Purchases banner does.

## Reopen is not the admin path, and cannot become one

`monthly_periods_one_open_per_client` is a partial unique index, so at most one period per client is
`open`. A missing bill is discovered *after* the month moved on, which means a later period is
already open, which means Reopen is guaranteed to 23505. Widening the index is not an option either
— virtually every IMS/HR/Owner page resolves "the current period" with a bare
`.eq('status','open').limit(1).single()`, so a second open row breaks the app rather than the rule.

**Reopen therefore means exactly one thing: hand entry for this month back to the CLIENT'S own
logins.** It is never the admin's own correction path. Say that in any copy that describes it.

## A capability with no route to it is not a capability

This lock had been admin-writable since it was written, and it still read as impossible to use,
because **`Purchases.js` opens on the OPEN period and nothing pointed anywhere else**. The only
visible affordance on a closed row was the one button that could not work. Reported as "let admin
reopen closed periods to enter missing purchase bills" — a feature request for something already
built, which is what an unreachable capability always looks like from outside.

The route is `/purchases?period=<id>`, from **"Add missing bills →"** on every closed row in
Periods. Three properties hold it together and each is load-bearing:

- **The id is validated against the client's own period list** before it is used, so a stale or
  cross-tenant link degrades to the open period instead of rendering an empty month.
- **The list keeps the URL in sync** on every period change (`replace`, so arrowing the dropdown
  does not fill the back button) — a refresh or a bookmark returns to the month on screen.
- **The bill form returns to the bill's OWN month**, not to a bare `/purchases`. All four
  `navigate` sites carry `?period=`. Without it, an admin who filed into Shrawan lands back on the
  open month and cannot see what they just entered, which reads as the save having failed.

When a modal becomes a route, check every exit as well as every entrance — S647 moved the bill form
to a route and left all four exits pointing at the default month.

## Admin must be TOLD the month is closed

The same `!isAdmin` that unlocks the page also suppresses the red "this period is closed" banner, so
before S651 an admin editing history saw a screen identical to the open month. Both Purchases
screens now render an **amber** banner whenever `isAdmin && period.status === 'closed'`. Any page
that adopts the `isLocked` line owes its admin the same notice — the lock and the notice are the
same fact, and only one of them was being shown.

## The frozen snapshot does not follow the write

Adding a bill to a closed month changes that month's COGS, and `monthly_owner_reports` is captured
at close and never recomputed (see `owner-report.md`). The banner says so and names **Regenerate
Snapshot** — deliberately *not* automatic, because that button is an explicit overwrite of a frozen
artifact and stays an admin decision. A closing-count correction has a second follow-up,
**Resync Opening Stock**, which pushes the corrected count into the next period; a purchase bill
does not need it, since carry-forward is built from physical counts, not purchases.

## Closing a period: the preflight and the one-open-period index

Migrated from the root `CLAUDE.md` (S663).

- **Closing a period is preflighted on the closing count (S613).** The close locks the month *and*
  mints the frozen Monthly Report, and COGS subtracts closing stock — so an uncounted month freezes
  "closing = 0 for every item" into an artifact nothing recomputes. All three close paths in
  `Periods.js` now run `closingCountPreflight()` and state what it found inside the ConfirmModal,
  red when nothing is counted. It **informs and never blocks** (an admin correcting history
  legitimately closes uncounted months), a failed preflight says it could not check rather than
  blocking, and it counts the same `physical_qty IS NOT NULL` rows `carryForwardOpeningStock` uses
  so the sentence and the carry-forward cannot disagree. Full reasoning in
  `.claude/rules/owner-report.md`.
- **`monthly_periods` allows at most one `open` period per client** (`monthly_periods_one_open_per_client`, a partial unique index `WHERE status='open'`, added 2026-07-13) — virtually every IMS/HR/Owner Dashboard page assumes this via a plain `.eq('status','open').limit(1).single()` read. Practical consequence: `Periods.js`'s "Reopen" action on a *past* closed period will always fail once a more recent period is open — which is the only realistic time anyone reopens a past period, so always check the update's `error` before treating a reopen as successful (S432, 2026-07-21, found an unhandled case that silently did nothing and gave no indication why). Separately, **admin doesn't need to reopen a period to edit it** — `Stock.js`'s `isLocked = !isAdmin && status==='closed'` (mirrored on every other period-scoped entry page) exempts admin from the read-only lock entirely regardless of status. Reopening only matters for handing edit access back to the *client's own* login; if admin is making the correction personally, editing in place and then re-propagating forward (`Periods.js`'s `carryForwardOpeningStock`, safe to call standalone — it's an idempotent upsert, exposed via the "Resync Opening Stock" action) is the simpler, unblocked path. **That write-through went unreachable for a year and read as a missing feature** (S651): `Purchases.js` opens on the OPEN period, so a closed month could not be got to, and the only button on a closed row was the one that cannot work. "Add missing bills →" now links to `/purchases?period=<id>`, and both purchase screens carry an amber "you are editing a closed month" banner — the `!isAdmin` carve-out had been suppressing the closed-period notice along with the lock. See `.claude/rules/closed-periods.md` before touching any `isLocked` line.
