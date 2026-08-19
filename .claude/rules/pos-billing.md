---
paths:
  - "src/modules/pos/**"
  - "src/utils/posBillingMath.js"
  - "src/utils/viewPosBill.js"
  - "src/utils/emvQr.js"
---

# POS billing, shifts and the IMS handoff

Written after the S573 critique of the POS module (campaign phase 6), which found five money-path
defects. Everything here is a rule that was broken once, in production code.

## The IMS handoff is the seam where money goes missing

**A closed POS bill must reach IMS, and if it can't, that must be visible.** `writeSalesEntries()`
returns early when there is no open `monthly_periods` row, or when today's BS month isn't the open
one. It used to return silently: the bill still closed, printed and consumed an invoice number
while Inventory never saw its revenue or ingredient usage, so POS Sales Report and IMS
MonthlySummary disagreed by an unbounded amount with nothing on either page saying so. Found live
on a test client — 15 bills, NPR 18,900 — caused by Ashadh 2083 being left open past its end while
Shrawan was never created, so every bill rung after the BS rollover bailed.

It now returns a boolean, the close path stamps `pos_orders.ims_posted_at` **only on a confirmed
post**, the POS floor shows a standing count of unposted bills, and Periods carries **Post POS
bills to Inventory** per period (`src/modules/pos/orders/backfillPosToIms.js`). The bill still
closes either way — refusing a sale mid-service is not acceptable.

**`sales_entries` and `stock_movements` can diverge, so neither is evidence of the other.**
`writeSalesEntries` writes revenue first and depletion second, inside a try/catch that swallows
failures — by design, so a depletion problem never blocks a bill. The consequence is that a bill
can have revenue and no movements. A backfill guard that inferred "already posted?" from
`stock_movements` was therefore **wrong**, not merely incomplete, and double-posted two bills'
revenue on real data. Both tables now carry a link to the order (`stock_movements.ref_id`,
`sales_entries.pos_order_id`); ask the table you actually mean.

**`ims_posted_at IS NULL` means "unknown" on any row closed before that column existed**, not
"unposted". Treating unknown as unposted is what caused the double-post. On a client that predates
the column, stamp the rows that already posted before running the first backfill.

**A recipe with no linked ingredients produces no `stock_movements` at all**, legitimately — the
Stock Movements page says so in its own banner. Don't read an empty movements list as a failed
post.

## Table-scoping traps in this module

**`sales_entries` is period-scoped, not client-scoped**, so it is deliberately absent from
`CLIENT_SCOPED_TABLES` and `scopedDb` throws for it — use plain `supabase.from()`, as
`writeSalesEntries` does. `stock_movements` and `pos_orders` *are* client-scoped and stay on
`scopedDb`. Getting this wrong fails loudly, which is the point.

**Every period-scoped read here needs `fetchAllRows`.** Six `pos_orders` reads had none and capped
silently at 1000 rows. The worst fed the **IRD Annexure 13** one-lakh threshold, where truncation
drops a party below the disclosure line on a statutory filing — and its *child* item read was
already paged, with a comment explaining why, while the parent was not. Same asymmetry existed on
Covers (truncation skews averages, not just totals), Exceptions, the KOT Register and Customers'
unbounded outstanding-credit read.

## Shifts

**The Z-report must be captured at close, not at page load, and then frozen.** It used to be
computed when the page mounted and never persisted: opening at 8pm and closing at 11pm omitted
three hours of takings from Expected Cash and the Variance, and because Shift History recomputed
live, a *reprinted* Z-report could show different numbers from the one that was signed. The report
is now re-read when the close modal opens **and** again immediately before the write (the drawer
count itself takes minutes), then stored on `pos_shifts.closing_report`. History renders that
snapshot; only pre-S573 shifts fall back to a recompute.

**Expected Cash is `opening + cash sales + cash in − cash out`, from one helper
(`expectedCashOf`)** used by the screen, the close modal and the printed slip. Cash genuinely
moves without being a sale in this market — supplier payments, staff advances, float drops — and
most importantly a customer settling an older **Credit** bill in cash: that order's
`payment_method` stays `'Credit'` forever, so the drawer read as "over" by the settled amount with
no explanation. `pos_cash_movements` (pay_in / pay_out / credit_settlement) is that ledger, and
`PosCustomers`' settle action posts to it automatically.

**`salesTotal` is "Total Sales", not "Total Collection"** — it includes Credit bills, which are
billed but not collected. The screen had this right and the signed paper slip had it wrong.

## Order lines

**Replacing an order's lines must be atomic.** It was a `DELETE` then a separate `INSERT` from the
browser, so a failure or stall between them left a live order with **zero lines** on the server —
the floor tile reads NPR 0 and only the browser's in-memory state can recover it. Same shape that
cost Sales Entry real data (S456). Use `save_pos_order_items(p_order_id, p_rows)`, which is
`SECURITY INVOKER` so all three RESTRICTIVE staff-isolation families on `pos_order_items` stay
enforced, and derives `client_id` from the order rather than taking it as a parameter.

## Closed in S575 (phase 8), for the record

- **Short cash tender**: single-payment Cash now blocks Confirm Payment when tendered < bill
  total (`cashShortfall` in `PosOrders.jsx` — guard in `closeOrder` too, covering the QR-poll
  path; the Change field flips to a red "Short by"). Split mode always guarded this.
- **Idle lock is WIRED** — `usePosIdleLock` runs from `Layout.js`: PIN-staff sessions
  (`posRole` set) on a bound device (`pos_device_client_id` in localStorage) lock to
  `/pos/login` after 3 idle minutes, 20s `role="alert"` countdown first. `/pos/kds` and
  owner/admin sessions are deliberately exempt. Don't add a second lock per page.
- **Sales Exceptions ranks by Revenue Impact** (discount + void menu value + comp *potential
  sales value*) — one coherent unit. Comp food cost stays in its own column. Never reintroduce a
  total that adds comp COST to revenue figures.
- **The printed settlement slip's Variance now derives from `expectedCashOf`** — the same figure
  as its own Expected Cash line and the frozen `closing_report`. Exactly one definition; a local
  formula in `buildShiftSlipHtml` is how it broke last time.

## Still open from the phase 6 critique

Recorded so they aren't rediscovered from scratch:

- **Discount cap, void and comp are enforced only in the browser.** `pos_orders_client` is a plain
  same-client `FOR ALL` policy, so a Staff-rank till JWT can PATCH `discount_amount`,
  `close_type` or `paid_amount` directly. This is privilege invariant #3 in its POS form; the fix
  is a `close_pos_order(...)` RPC re-deriving the cap and re-checking `pos_allow_void` server-side.
- **An item already fired to the kitchen can be removed by any Staff-rank account** with no
  permission, reason or order-level record — caught after the fact by KOT Reconciliation only.
- **The mechanical sweep**: ~52 bare labels (POS measures 60 `<label>` vs 7 `htmlFor`), 9
  hand-rolled modals, and ~104 base-signal-token text sites vs 10 contrast-variant adoptions —
  the one module the S549–S551 sweeps never reached.
