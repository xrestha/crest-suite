---
paths:
  - "src/modules/ims/reports/**"
  - "src/modules/ims/purchases/**"
  - "src/modules/ims/vendors/**"
  - "src/modules/ownerReport/computeVendorPurchasingSection.js"
---

# Vendor balance / payables (billKeyOf, aging, payment allocation layers)

> Moved out of the root CLAUDE.md (2026-08-18 /doctor pass) so it loads only when working on these files. Root CLAUDE.md keeps the universal invariants.

### The `vendors` row is the only copy of the supplier's NAME (S671)

`purchase_entries`, `purchase_orders` and `vendor_returns` store a `vendor_id` and nothing else;
every report resolves the name by joining `vendors`. `ims_gate_passes` is the sole table carrying a
`vendor_name` of its own. So that row is not a lookup convenience — **deleting it is what erases the
supplier from the client's own history**, on every past bill, Vendor Report, Outstanding Payables
line and balance confirmation at once.

**And the FK layer protects only half of it, which is the part worth remembering.** The four tables
split by `ON DELETE` behaviour and the two halves fail in opposite directions:

| Table | On vendor delete | Result |
| --- | --- | --- |
| `purchase_entries`, `purchase_orders` | plain FK (NO ACTION) | Postgres **refuses**; nothing is lost |
| `vendor_returns`, `ims_gate_passes` | `ON DELETE SET NULL` | the delete **succeeds** and the rows silently lose their supplier |

A guard that leans on "the database will stop me" is therefore right about two tables and wrong
about two, with no error on the wrong half — and `vendor_returns` keeps no name, so that loss is
unrecoverable. **Check every referencing table in the app, and check `confdeltype` before assuming a
foreign key is a guard at all.** `payable_payments` hangs off `purchase_entry_id` rather than the
vendor, so it is covered transitively.

**The answer for a vendor with history is `vendors.archived_at` (migration `20260903120000`), not a
delete.** The row is kept and hidden: every FK, join and report is untouched, and the vendor leaves
the Vendors page and every picker. A `CHECK (archived_at IS NULL OR is_active IS NOT TRUE)` carries
the one invariant that matters — `is_active` is what every purchase, PO and gate-pass picker filters
on, so an archived-but-active vendor would keep appearing in the dropdowns it was archived to leave.
Restore clears `archived_at` and **deliberately leaves the vendor inactive**, so the two columns
never have to be reasoned about in one write. A hard delete survives only where it is genuinely
free: a vendor nothing points at.

**Denormalising a `vendor_name` snapshot onto the other three was considered and rejected.** It
needs `vendor_id` to go nullable on `purchase_entries`, and `VendorReport`/`OutstandingPayables`
group by `vendor_id` — so two deleted vendors would both become NULL and **merge their outstanding
balances**. A hidden row costs one column; a denormalised name costs an invariant on the module's
most important table.

### `purchase_entries.created_at` is a BILL-level fact, not a row-level one (S670)

It no longer answers "when was this row written". The edit path in `PurchaseBillForm.jsx` inserts
replacement lines and deletes the originals, so the column used to restamp to `now()` on every
correction — a bill's "Entered" time was really the moment of its last typo fix, and the Purchases
list (ordered `bs_day, created_at, id`) jumped it to the end of its day. The edit now carries the
earliest superseded row's stamp forward onto every replacement line, so one bill has one entry time,
in the same way `invoice_ref`, `payment_method` and `discount_amount` are already repeated
identically on every line of a bill.

Three consequences worth knowing before touching this:

- **Lines added during an edit inherit the bill's original stamp.** That is deliberate, not a
  rounding-off: the insert rewrites every line on every save, so there is no old-line/new-line
  distinction available, and a per-line stamp would make the bill's displayed time depend on which
  line happened to sort first.
- **`.order('created_at')` still works but means less.** In `Purchases.js` it orders bills within a
  day and `id` remains the unique paging tiebreaker; in `PurchaseBillPage.jsx` the per-bill line sort
  now collapses onto `id`.
- **A genuine "when was this row written" need requires its own column.** Do not reach for
  `created_at` for that, and do not reach for `updated_at` either — no trigger maintains it anywhere
  in this schema.

The new-bill path is untouched and still lets `DEFAULT now()` fire; it only `.select()`s the value
back so the auto-printed voucher can print the server's stamp instead of the browser's clock.
Because that path is the server's own clock, a purchase entry time has none of the till-vs-server
skew that POS `opened_at`/`closed_at` do.

### A key with a fallback must be honoured by every predicate that reads it (S648)

A bill is identified by **`purchase_group_id || id`** — the `billKeyOf` shape above, and the same
expression `Purchases.js` keys its rows by. The fallback half is not hypothetical: bills written
before grouping existed carry `purchase_group_id IS NULL`, so their key is the single row's own id.

Editing one of those duplicated it, silently, from the day grouping was added until S648. The save
inserts the new lines stamped with `editingGroupId` and then deleted the old ones with
`.eq('purchase_group_id', editingGroupId)` — which matches the rows it had *just written* and not
the legacy row, whose group column is still NULL. The original line survived beside its own
replacement, and every IMS figure that sums purchases counted it twice with nothing on screen to
say so. `deleteGroup()` had always branched for this (`hasGroupId ? .eq(group) : .in('id', …)`),
which is what made the omission in the edit path invisible: the feature looked handled.

**The fix is to stop deriving the row set from the key at all.** The edit path deletes the ids it
actually loaded. That is exact for both shapes, needs no `.not('id','in',…)` guard (a fresh insert
cannot collide with an id you already held), and it declines to remove a line someone else added to
the bill since it was opened — the group predicate would have taken that with it, and deleting a row
this editor never saw is the worse of the two failures. An edit that arrives with an empty id list
is refused rather than saved, since the insert runs either way and an empty delete is exactly the
duplicate.

**Generally: `a || b` as an identity means every read, write and delete that touches it needs both
branches.** Grep the fallback expression, not the column name — the column name appears in the
predicate that is wrong.

**A second instance landed one session later, on a different column (S650).** `payment_method` is
NULL on bills written before the column existed, and every screen renders `|| 'Cash'` — so the new
Payment filter, written against the raw column, would have hidden rows the page itself labels Cash
while the entry count and both footer totals silently agreed with the filter rather than the
screen. `methodOf(p)` now resolves it once for the filter, the option list and the row badge. Note
the pattern's reach: `purchase_group_id || id` is an *identity*, `payment_method || 'Cash'` is a
*display default*, and both break the same way. **If a value is displayed through a fallback it
must also be filtered, grouped and counted through it.**

### `billKeyOf`/`aging` are centralized in `purchasesHelpers.js` — but not everywhere

Added S501 for **Vendor Balance Confirmation** (`/vendor-balance-confirmation`, Pro, Reports → Menu & Vendors — a printable per-vendor/per-BS-fiscal-year balance letter + running-balance schedule for Nepal IRD Annexure 13 reconciliation). `billKeyOf(e, period)` (bill grouping key, `purchase_group_id`-first with a vendor+invoice+date fallback) and `aging(days)` used to be duplicated across `VendorReport.js` and `OutstandingPayables.js` with two genuinely different shapes — `OutstandingPayables.js` now imports the centralized version from `purchasesHelpers.js` (safe, its old shape was byte-compatible once made `purchase_group_id`-aware). **`VendorReport.js` and the owner-report's `computeVendorPurchasingSection.js` were deliberately left on their own local copies** — theirs are single-period-scoped by construction (no year/month in the fallback key), and reusing the centralized cross-period-safe version there would silently misgroup bills across period boundaries, not simplify anything. Don't "finish the cleanup" by pointing those two at the shared helper without re-deriving their period-scoping first.

Vendor Balance Confirmation's Opening Balance (balance as of a fiscal year's *start* date) is genuinely new logic with no reusable analog: every other balance figure in the codebase (`OutstandingPayables.js`'s `remaining`) is a live "as of today" snapshot, so it nets against *all* payments/returns ever recorded — using that field for a historical cutoff would be wrong. `vendorBalanceHelpers.js`'s `computeOpeningBalance()` instead nets only payments/returns dated *before* the cutoff. Opening Balance itself stays a single carried-forward lump sum with no line-item breakdown (same convention as a bank statement's "Balance Brought Forward") — it's only the fiscal year's *own* schedule (below) that needs to show returns individually.

**The FY schedule shows every bill at its GROSS value, with any return against it as its own separate ledger line — never silently netted into the bill's total.** Found live (S502 smoke test): the original version netted a same-FY return directly into its bill's displayed total, which (a) made the return invisible in the printed schedule even though the headline "Payments/Returns" figure counted it, and (b) broke the headline sentence's own arithmetic — "Opening + Purchases − Payments/Returns" didn't equal the shown Closing Balance, because Purchases was silently already net-of-return while the same return got subtracted again in the display. A return's *displayed* value is never a flat `qty × rate` either — `walkBillReturns()` processes a bill's returns chronologically from its gross total via `calcBillTotals`, since VAT recalculates on the shrinking post-return base each time (two returns on the same bill are not simply additive pre-VAT). This makes "Purchase" (gross) and "Return" (VAT-adjusted effective value) sum to exactly what a single netted line would have shown, so nothing is lost — it's just no longer hidden. Applies uniformly to a return against a bill from *this* FY and a return during this FY against a bill from a *prior* FY (walked from that bill's gross total too, silently passing through any pre-fyStart returns already folded into Opening Balance before it starts emitting FY-dated events) — the one place in this feature actually worth re-reading if extending it.

**A phantom sub-paisa balance on a fully-settled bill can come from three genuinely different layers — don't assume the first (or second) fix found the real cause.** S502's fix above (rounding `billGrandTotal()`'s output) covers *this report's own* summation-order float noise, but a separate bug lived one layer down, in `OutstandingPayables.js`'s payment-allocation itself: `payBill()`/`paySelectedBills()` used to compute each unpaid line's proportional share as a raw float and let Postgres round each of the (say) 10 inserted `payable_payments.amount` rows independently to 2dp on write — independent per-line rounding can lose fractions of a paisa in aggregate, so a "Pay in full" lump sum can land a paisa short of the real total with no way to ever fully clear the bill afterward. Found live (S505) re-entering a real vendor payment: the rounding tweak from S502 alone did *not* fix it — verified by direct `payable_payments` inspection, not assumed — because the true cause was upstream of this report entirely. Fixed via a shared `allocatePayment()` in `OutstandingPayables.js` using running-cumulative rounding (round the cumulative allocated-so-far total at each line, take the difference from the previous cumulative rounded total) so the inserted rows always sum to exactly the rounded payment amount, however many lines it splits across.

A third, distinct layer surfaced later (S510): `OutstandingPayables.js`'s own `l.value`/`l.remaining` (the per-line figures `allocatePayment()` allocates against) were carried **unrounded** — a per-line rate with 3+ decimals (e.g. an NPR/gram cost like `0.20915`) can leave a bill's true net total sub-paisa (NPR 1400.00175, not a clean 1400.00) even though every displayed figure shows only 2dp. "Pay in full" pre-fills the editable amount via `.toFixed(2)`, and `Math.min(amount, bill.remaining)` then silently caps the actual payment a hair below the true unrounded remaining — the shortfall lands entirely on whichever line `allocatePayment()` processes *last*: its written `payable_payments.amount` still rounds to a clean figure (so Payment History shows it as fully paid), but the *raw* allocation used for the settle check (`e.paidTotal + rawAlloc >= e.value - EPS`) falls just short of that line's unrounded `e.value`, so it never gets `purchase_entries.paid_at` stamped — the bill stays stuck "outstanding" with a line that visibly shows zero remaining. `allocatePayment()`'s own cumulative-rounding fix from S505 does not touch this, since the bug is upstream of it, in the inputs it receives. Fixed the same way as S502's `billGrandTotal()`: round `l.value`/`l.remaining` to currency precision the moment they're computed, not just at display time. If a phantom-balance or stuck-settlement report ever recurs, check all three layers independently rather than assuming any prior fix subsumes the others.

### Supplier Contribution: a supplier can only ever be DERIVED (S580)

`items` has **no vendor column**. A supplier exists in Crest only on a purchase line, so nothing
about a sale can name one — which is why the competitor ERP's "Sales Report – Supplier Wise" has
no direct equivalent and shipped instead as `/supplier-contribution` (Pro), a cost-attribution
report: what sold (`selectDepletingSales`) → what it consumed (`explodeRecipeIngredients`, valued
at `per_uom_rate`) → split across the vendors that supplied each item that period, in proportion to
net spend with each. The arithmetic is pure and tested in
`src/modules/ims/reports/supplierAttribution.js` (+ `.test.js`).

Three rules if this is ever touched:

- **Net spend must keep meaning exactly what `VendorReport.js` means by it** — gross less bill
  discount less returns, with the discount deduped by `purchase_group_id` because
  `purchase_entries.discount_amount` is a bill-level figure repeated on every line. The one
  extension is allocating that discount across the bill's own lines proportionally, since
  attribution is per item where Vendor Report only ever needed per vendor; the vendor totals still
  sum to Vendor Report's number. Verified live (S580) at NPR 250,000 on both pages for the same
  period. Two figures for the same thing that disagree by a discount rule is the S551 defect class.
- **Shares are taken from positive parts only, and an item with none is NAMED.** A return larger
  than the period's purchases can leave an (item, vendor) pair negative, and a negative share is
  meaningless. An item consumed this period but last bought in an earlier one is ordinary, not an
  error — it lands in an explicit **Not attributed** row so attributed + unattributed is always the
  whole consumed value (asserted in the tests). A rollup that silently cannot claim a row produces
  a believable wrong total, which is S567's lesson.
- **The figure is recipe-theoretical consumption, not count-based COGS**, and wastage/staff meals
  are excluded (this is the cost of what was *sold*). Both are stated on the page. It needs no
  closed period, since nothing here subtracts a closing count — so the Variance-style
  closed-period default deliberately does not apply.

S594 (2026-08-19, `/impeccable critique`) added a fourth rule and renamed a column:

- **The KPI and the table's TOTAL are different figures on purpose, and both must say so.** The
  `Attributed Cost of Sales` card excludes the `Not attributed` row; the footer's `Cost of Sales`
  total includes it. Both were labelled with the same words in the same units about 200px apart,
  so an accountant reconciling against Vendor Report found the vendor rows tie exactly and the
  total not at all — which is worse than a missing total, because it discredits the rows that were
  right. The footer now reads **TOTAL (incl. not attributed)** and carries a `Tip` naming the gap.
- **The `% of Purchases` total is computed, never asserted.** It was a hardcoded `100.0%` over a
  column whose denominator (`purchaseTotal`) filters `v > 0` while the footer's Net Purchases cell
  (`purchaseGrandTotal`) sums negatives too. A vendor whose returns exceeded that period's
  purchases — routine — therefore made the column genuinely sum past 100 while the footer swore it
  did not. It is now `pct(purchaseGrandTotal, purchaseShareBase)`, so a real divergence shows.
- **`Δ` / `pp` became `Reliance Gap` / `pts`.** Bare mathematical notation is the wrong register
  for a page an owner scans between rushes; the `Tip` was good and a `Tip` is a hover.
- The `+ N more` truncation in an expanded row was a dead end in the UI *and* in the export (which
  shipped `itemRows.length`, a count, rather than the rows). There is now a Show-all control and a
  second **Ingredient Detail** sheet in the workbook. The expandable `<tr>` also became keyboard-
  reachable (`tabIndex`/`role="button"`/`aria-expanded`/`onKeyDown`) — it is the page's only
  interaction and was mouse-only.

Acted on S588 (2026-08-19): **`Variance.js`, `TheoreticalVariance.js` and `ShrinkageReport.js` now
run `sales_entries` through `selectDepletingSales`** before summing `qty_sold`, so a client running
POS *and* manual bulk entry no longer double-counts a dish into theoretical usage (which inflated
theoretical, pushed variance down, and MASKED real over-consumption — backwards on the money
report). All four consumers of that figure — these three plus Supplier Contribution — now agree.
The dedup is applied per-period on Shrinkage (the POS-supersedes-manual rule is bs_day-scoped), and
the same pass added `fetchAllRows` paging to all three previously-unpaged sales reads.

### Bill discounts belong in COGS, and `allocateBillDiscounts()` is the only way to get them there (S601)

`purchase_entries.discount_amount` is a **BILL-level** figure repeated on every line of the bill.
`VendorReport.js`, `OutstandingPayables.js`, `VatReport.js`, `NonVatReport.js` and
`supplierAttribution.js` all dedupe it by bill before use. The P&L was the one place that ignored it
entirely — `sum(qty * rate)` charged the undiscounted price into COGS, so COGS ran high and Net
Profit low by the whole discount while the Purchases register showed the discounted total for the
same bill. Measured on the reference client, one month was **NPR 289,456** overstated.

Fixed across the three places that are required to agree, in one change: `ConsolidatedPnl.jsx`,
`MonthlySummary.js` (both via `allocateBillDiscounts()` from `supplierAttribution.js`) and
`get_group_pnl` (migration `20260822140000`, the same arithmetic in SQL).

Three things not to re-derive:

- **`max(discount_amount)`, never `sum`.** The value is repeated per line, so summing it multiplies
  the discount by the bill's line count.
- **Allocation is PROPORTIONAL, not a flat subtraction.** Those totals are summed only over ACTIVE,
  non-sub-recipe items (S436), and a bill can contain a line for an item outside that filter — so
  subtracting the whole bill's discount from a total that never included the whole bill's gross
  over-credits it. The `bill` CTE's `gross` is deliberately computed over ALL lines; narrowing it
  silently inflates every share.
- **`qty` is untouched.** A discount changes what was paid, not what arrived.

Also settled by the same audit, so it does not get re-asked: `buildStatement()` does **not**
double-count wastage and staff meals. `computeUsed()` subtracts them from COGS and the statement
re-deducts them as their own lines; `netProfit = Rev − (O + P − R − C) − L − OH − T`, so the two
cancel exactly and total food cost recognised (`cogs + W + S`) equals full depletion.

## Day columns name the month (S614)

Every period-scoped **Day** column on these pages — Vendor Report (four tables plus its drilldown
title), VAT/Non-VAT, Payment Report — renders `formatBsDay(day, selectedPeriod?.bs_month)` from
`src/utils/bsCalendar.js`: **"1st Bhadra"**, not a bare `1`. A bare number is legible only while the
page header that names the month is on screen, which stops being true the moment the sheet is
printed or read back later — and these are the pages an accountant reconciles months afterwards.

Two behaviours are load-bearing rather than cosmetic: an absent or out-of-range month **degrades to
the bare ordinal rather than naming the wrong month** (so a page whose period has not loaded yet
prints "1st", never "1st Baisakh"), and day 0 returns `''` so the caller keeps its own dash. The
**Excel exports deliberately keep the numeric Day column** — text breaks a spreadsheet's sorting and
filtering, and `sheetWithLetterhead`'s `scopeLine` already states the period.
