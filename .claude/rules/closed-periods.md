---
paths:
  - "src/pages/Periods.js"
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

`Purchases.js`, `PurchaseBillPage.jsx`, `Sales.js`, `Stock.js` and `Overheads.js` — five copies, all
agreeing. **The `!isAdmin` carve-out is the feature, not an oversight**: an admin correcting history
is a real, expected job, and the alternative (reopen the month) is structurally unavailable.

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
