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
- **Idle lock is WIRED** — `usePosIdleLock` runs from `Layout.js`: PIN-staff sessions on a
  bound device (`pos_device_client_id` in localStorage) lock to `/pos/login` after 3 idle
  minutes, 20s `role="alert"` countdown first. `/pos/kds` and owner/admin sessions are
  deliberately exempt. Don't add a second lock per page. **The exemption must key off the RAW
  `profile.pos_role` column (`isPinStaff` in Layout.js), never the resolved `posRole` rank** —
  that rank is 'manager' for every admin and Owner, so gating on it enables the lock for
  exactly the people it must exempt. This shipped broken (S575→S583): any admin or Owner on a
  machine that had ever completed POS device binding was silently signed out after 3 idle
  minutes, reported as "why does the app sign me out when I leave for a while". The same raw
  test drives the rail button's Lock-POS-vs-Sign-out label and the sign-out routing to
  `/pos/login` vs `/login`.
- **Sales Exceptions ranks by Revenue Impact** (discount + void menu value + comp *potential
  sales value*) — one coherent unit. Comp food cost stays in its own column. Never reintroduce a
  total that adds comp COST to revenue figures.
- **The printed settlement slip's Variance now derives from `expectedCashOf`** — the same figure
  as its own Expected Cash line and the frozen `closing_report`. Exactly one definition; a local
  formula in `buildShiftSlipHtml` is how it broke last time.

## Server-side enforcement of the close (S577)

`pos_orders_client` is a plain same-client `FOR ALL` policy, so a Staff-rank till JWT holds UPDATE
on every one of its own client's orders — and the discount cap and the void permission were both
React. A single PATCH with `{"close_type":"void"}` or any `discount_amount` walked past them.
Privilege invariant #3 in its POS form.

**`guard_pos_order_close()` (migration `20260819120000`) is a BEFORE UPDATE trigger, not the
`close_pos_order(...)` RPC the phase-6 critique proposed.** An RPC only protects the callers that
choose to call it and leaves the open policy in place; a trigger sees every write to the table,
through PostgREST or anywhere else, now and for any path added later. Same reasoning, same
`current_user NOT IN ('anon','authenticated')` seam, as `guard_profiles_privileged_columns()`.

Three things to know before touching it:

- **It fires only when `close_type`, `status` or `discount_amount` actually change.** Everything
  else on `pos_orders` — the `ims_posted_at` stamp closeOrder writes straight after the close,
  credit-note linkage, reprint counters, the offline queue replaying `covers` — pays nothing.
- **`paid_amount` is deliberately NOT enforced.** Re-deriving the bill total in SQL means a second
  copy of the VAT-on-discounted-base arithmetic and the round-to-the-rupee rule, i.e. a second
  definition of a figure the product is sold on. A drifted copy would not misreport a number, it
  would REJECT real bills mid-service. The two checks that ARE enforced need no money formula: the
  cap is measured against a plain `SUM(qty * unit_price)` over non-comped lines, which is
  byte-for-byte `paySubEx`.
- **`closeOrder` now persists the cart through `save_pos_order_items` before billing a paid
  order**, because the trigger can only measure the cap against STORED lines and the Payment
  button never gated on a dirty cart. That also closed a quieter divergence that predates the
  trigger: `writeSalesEntries` posts revenue from the in-memory cart, so an unsaved line was
  already reaching IMS revenue and the printed bill while never existing in `pos_order_items`.

## Pulling an already-fired item is now on the record (S577)

`save_pos_order_items` replaces an order's lines wholesale, so a line carrying `sent_to_kot` simply
ceased to exist on the next save: food cooked, ticket printed, line gone from the bill and from
every report that reads it. The only surviving trace was `pos_kot_log`, which is why KOT
Reconciliation could say *that* it happened but never who, when or why. No privilege was needed.

**The fix is a record, not a block, and that is deliberate** — pulling a fired item is routine and
legitimate (kitchen ran out, wrong item fired, customer changed their mind), and rank-gating it
would stall a live service behind a manager on every genuine mistake. What was missing was the
name against it.

- `pos_kot_removals` (migration `20260819130000`) is written **inside** `save_pos_order_items`, by
  diffing stored sent quantities against the incoming rows in the same transaction. A caller
  cannot remove a fired line without producing the record, whatever it sends.
- The browser contributes **only the reason** (`p_removal_reason`), which the RPC has no way to
  invent. A missing reason renders as `none given` rather than hiding the row — that is what an
  offline sync, or a till on a pre-S577 bundle, honestly looks like.
- The **offline replay** was moved onto the same RPC. It was still delete-then-insert, which meant
  going offline was a way to pull a fired item leaving no trace — and it carried S573's
  non-atomic-save risk besides.
- Surfaced on **KOT Log → Pulled Items**. Keep Reconciliation too: it *infers* a pull from the
  order's current state, so it still catches one made by a path that predates the record.
- The 2-arg `save_pos_order_items` signature was **dropped**, against the standing keep-the-old-
  arity rule in `.claude/rules/supabase-sql.md`. PostgREST resolves by argument name, so keeping
  both would make every 2-arg call ambiguous (`function is not unique`) — dropping it is what lets
  a stale bundle keep working via the parameter default.

## PosOrders.jsx has TWO returns, and a modal put in the wrong one is invisible

Worth its own heading because it cost a real bug (S578) and nothing static catches it. The file
early-returns the **order screen** (`if (view === 'order') return (...)`) and then falls through to
the **floor view** (`return (<>...</>)`). They render completely different trees.

The KOT-pull prompt was placed beside the credit-note modal at the tail of the file — i.e. in the
floor view — while `setQty` only ever runs on the order screen. Pressing × on an already-fired item
therefore did **nothing visible at all**: the state was set, the removal was correctly blocked, and
no dialog appeared anywhere. It compiled, passed the label/colour/duplicate-id detectors, and read
correctly in review. Only pressing the button in a browser found it.

Before adding a modal here, check which return the handler that opens it lives in. Nothing about a
misplaced one fails loudly, and the failure mode — a button that silently does nothing — is the one
a cashier reports as "the till is broken" rather than as a bug you can search for.

Note also that neither branch needs an explicit `zIndex` on a child dialog: the order screen is
`position: fixed` at 1000 and therefore its own stacking context, so a nested overlay at the default
100 already paints above it. The billing modal's 1100 is belt-and-braces, not a requirement.

## How to smoke-test any of these guards

All three were exercised this way; do the same for the next one.

**Admin and Owner are exempt from every one of them by design, so an admin session proves nothing.**
Use a POS PIN account on a dummy client. The definitive check is not the UI — it is a request fired
straight at PostgREST with that session's own token, which is precisely the attack the guard exists
to stop. Read the anon key out of `/static/js/bundle.js` and the `access_token` out of
`localStorage`, then `fetch` the REST endpoint directly.

**Always include a control that must still succeed.** A guard that refuses everything looks
identical to a guard that works, right up until order-taking breaks. The close guard's control was
an ordinary bill closing; the comp guard's was a plain `{"notes": "..."}` edit on the very row whose
comp columns had just been refused.

**To test a RANK refusal you need the staff token while an admin changes that staff member's role.**
Stash the JWT in `sessionStorage` first — it stays valid independently of the session that issued
it, so one browser profile is enough. Restore the role afterwards and re-read the page to confirm it
took, rather than trusting the change event.

Results, all confirmed live on 2026-08-19:

- **Close guard (S577)** — `{"close_type":"void"}` → 403; a 30% discount → 403 naming the cap; a 10%
  discount → 200. An ordinary close still assigns an invoice, stamps `ims_posted_at`, and leaves
  `pos_order_items` matching the `sales_entries` row.
- **KOT-removal record (S577)** — the prompt names the item and quantity, Remove stays disabled
  until a reason is chosen, and KOT Log → Pulled Items renders the row with the staff name resolved.
- **Comp guard (S579)** — direct `PATCH {comped:true}` → 403, the same dressed with a forged
  `comp_no`/`comped_by` → 403, an INSERT arriving already comped → 403, an ordinary `notes` edit →
  200. The RPC called with `p_comped_by` set to a colleague's real uuid stored the **caller's** id
  instead, and returned 403 once the account was demoted to Staff.

## Item-level comp is enforced server-side too (S579)

The last member of the family, and the one with the most to lose: a comp is the single action whose
purpose is to make revenue disappear on purpose. Three holes, all in the same act:

- **Nothing guarded the columns.** A till JWT could PATCH `comped = true` onto any of its client's
  lines — the line leaves the bill (`payableOrderItems`, SalesReport, demandForecastData and both
  Credit Note files all filter on it) with no NC number, no reason, no attribution, no slip.
- **The RPC checked client, not rank.** `apply_pos_item_comps`' guard was `is_admin() OR same
  client`, while the UI gates the comp panel on `hasPosAccess('supervisor')`. A Staff-rank account
  that never sees the control could call the function directly.
- **`p_comped_by` was caller-supplied**, and it feeds the column the Sales Exception Report ranks
  staff by. A caller could comp under a colleague's name. **Attribution the subject can choose is
  not attribution** — same lesson `save_pos_order_items` already applies to `client_id`.

`guard_pos_item_comp()` (migration `20260819140000`) fences the six comp columns on INSERT and
UPDATE; `apply_pos_item_comps` stays `SECURITY DEFINER`, so `current_user` inside it is the owner
and the guard waves it through — the only write path, the same mechanism as `set_active_outlet()`.
The RPC now checks Supervisor rank and derives `comped_by` from `auth.uid()`.

Two things to preserve if this is ever touched:

- **The cheap test must stay first in the trigger.** It fires per row on the busiest table in POS —
  `save_pos_order_items` replaces a whole line set per save — and `is_admin()` is
  `SECURITY DEFINER`, which Postgres will not inline. Comparing six columns before reaching for
  identity keeps an ordinary line at a few boolean tests.
- **`COALESCE(..., false)` around every authorisation condition.** `pos_role` is NULL for any
  account with no POS access, `NULL IN ('supervisor','manager')` is NULL, and `IF NOT NULL THEN`
  never fires — so the unwrapped form falls open for precisely the accounts with no rank. The
  pre-existing client check had the same shape and was wrapped at the same time.

## Still open from the phase 6 critique

Recorded so they aren't rediscovered from scratch:

- Nothing. All three server-side items (discount cap, void, item comp) are closed, applied and
  smoke-tested; what remains on this page's beat is the payment-QR work blocked on FonePay/eSewa
  merchant onboarding, which is a business relationship rather than engineering — tracked in
  `POS_TODO.md`.
- ~~**The mechanical sweep.**~~ **Closed across S576–S578**, with a fourth pass in S603. Labels: 0
  bare `<label>` vs 54 `htmlFor`, every `<select>` named. Colour: 117 base-signal-token `color:` sites converted, 0
  remain, 128 contrast-variant references now. Modals: all 9 hand-rolled overlays are on the
  shared `Modal`. Three shapes recur here and are worth copying rather than rediscovering — a
  caption over a button group or a read-only figure must be a `<span>` plus
  `role="group"`/`aria-labelledby` (a `<label>` naming no labelable element announces a name the
  browser never binds); a label for a conditionally-rendered control still pairs by `id`, since
  `SearchableSelect` and `BsCalendarPicker` both forward one; and a dialog opened from the order
  screen or the KDS needs `Modal`'s `zIndex` prop, because those are `position: fixed` layers at
  1000 and therefore their own stacking contexts — that single fact is why POS grew nine
  hand-rolled overlays instead of using the component.

  **S603's pass was the input classes.** POS carried 20 of the 62 text controls in the product that
  were wearing `className="form-select"` — a `<select>` class, so `cursor: pointer`, so a text box
  announcing itself as a menu — across `PosTableManagement`, `PosShifts`, `PosStaff`,
  `PosCustomers`, `CreditNotes`, `CoversReport` and the parking slip modal. All on `.form-input`
  now, with `.form-input--auto` where the control sizes to a toolbar rather than filling a field.
  The same pass gave the whole app the 16px `pointer: coarse` floor it had never had, which matters
  more on this module than any other: **the till is a tablet**, and every field on it was 13px, i.e.
  under the threshold at which iOS Safari zooms the viewport on focus and never zooms back.

## One bill-math primitive, however the report slices it (S580)

`computeCategoryAmounts` and `computeItemAmounts` in `posBillingMath.js` were byte-for-byte the
same proportional-discount allocation differing only in the grouping key, and the Product Type tab
would have made a third. Both are now delegates of
`computeGroupAmounts(order, items, vatReg, keyOf, seedOf)` — signatures unchanged, so no call site
moved. **A new way to slice a bill is a new `keyOf`, never a new copy of the arithmetic**: this is
money math on the bill, and the rule that keeps COGS in one place (`imsFormulas.js`, S551) applies
here for the same reason. The proof the refactor was exact is that the pre-existing reconciliation
tests passed untouched; the invariant they assert — buckets sum back to `computeOrderAmounts` —
now covers any key.

One level up, `SalesReport.jsx`'s `buildGroupedRows(keyOf, labelOf)` is the same consolidation for
the row builders, **including the credit-note branch**: a credit-noted bill contributes returned
quantity only and never revenue, because the reversal posts on the day the note is issued. That
branch is part of the rule, not incidental — three hand-written copies of it is how the tabs would
come to disagree about a return.

**The Product Type tab's axes come from data that already existed and nothing was reading:**
`settings.pos_bot_categories` (Kitchen/Bar — the same set `sendTicket()` routes BOT by, same
`['Beverage']` fallback, so the report and the tickets cannot disagree), `pos_order_items.vat_rate`
(as billed), and `recipes.is_veg`. An axis that could only ever produce one row is **hidden, not
rendered empty**. When verifying that, note a hidden axis and a broken lookup look identical on
screen — confirm the fetch returned 200 before concluding the client simply has no data.

## A delivery platform is a party, not a tag on a bill (S596)

Sales Report → Delivery Partners listed every Foodmandu/Pathao bill and totalled all of them
together, and Customers → Outstanding Credit was bill-by-bill too. So **no screen in the product
could say what one platform owed, or what one platform had taken** — the platform existed only as
a badge on a row. Both screens now carry a per-partner rollup. Four rules came out of building it:

**Commission is measured against the ex-VAT, post-discount base with comped lines excluded — never
`paid_amount`.** That is the base `PosCustomers.jsx` settles on, because it is the base Foodmandu
and Pathao themselves invoice on (confirmed with the client at S290, and the reason the very first
version of the settle flow was wrong). An effective rate computed off the VAT-inclusive total reads
about 13 percentage points low on **every** bill of a VAT-registered client, so a report built that
way would accuse every platform of over-charging, every month, in the alarming direction. Recompute
through `computeOrderAmounts` rather than storing a second copy of the base.

**An unsettled bill is excluded from BOTH sides of the rate.** Commission is recorded at settlement,
never at Charge — deliberately, so staff never see or estimate a platform's cut while billing. An
outstanding bill therefore has a base and no commission, and letting it into the denominator drags
every partner's measured rate toward zero as the month fills up. The absence of a number here is
structural, not missing data; the same distinction the Outstanding column already makes.

**A rate-mismatch flag needs two tolerances or it cries wolf.** Each bill's commission is
`round(base × pct / 100)` at settlement, so a platform charging exactly the agreed rate still
lands up to NPR 0.5 off per bill — a visible percentage swing across a handful of small delivery
orders. The flag requires a gap of ≥0.5 percentage points **and** a rupee gap larger than
rounding could produce (`max(1, settledBills × 0.5)` in aggregate, NPR 1 on a single bill). A
report that raises a false alarm about a supplier relationship is worse than one that stays quiet.

**A rollup must reconcile with the total printed beside it.** Customers' rollup keeps a
**Direct customers** row for non-partner Credit precisely so its Outstanding column ties to the KPI
card directly above it (S567's Stock Count lesson, applied before it could bite). Its figures
legitimately differ from the report's — that page is every Credit bill ever, the report is a date
range — which is stated in a line under the table, because two screens showing the same words and
different numbers is a support call.

Effective rate = settled commission ÷ ex-VAT settled base. The contracted rate it is checked
against is `settings.pos_delivery_partners[].commission_pct`, which existed for a long time as a
settle-time pre-fill and was read by nothing else.
