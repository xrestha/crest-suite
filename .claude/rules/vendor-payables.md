---
paths:
  - "src/modules/ims/reports/**"
  - "src/modules/ims/purchases/**"
  - "src/modules/ims/vendors/**"
  - "src/modules/ownerReport/computeVendorPurchasingSection.js"
---

# Vendor balance / payables (billKeyOf, aging, payment allocation layers)

> Moved out of the root CLAUDE.md (2026-08-18 /doctor pass) so it loads only when working on these files. Root CLAUDE.md keeps the universal invariants.

### Fixing one side of a two-sided invariant is how you break it (S727)

S725 moved `VendorReport`'s returns onto the discounted basis (`returnBase`, the S722 rule) and
left `supplierAttribution.js`'s `vendorNetByItem` on the list rate. The two pages' Net Spend /
Net Purchases then silently stopped agreeing — on a figure **three places still asserted was the
same one**: `supplierAttribution.js`'s own header comment, the column tooltip on
`SupplierContribution.js`, and the S580 section of this file.

```text
bill 10,000 gross · 1,000 discount · fully returned
  Vendor Report       9,000 − 9,000  =      0
  Supplier Contrib.   9,000 − 10,000 = −1,000
```

And it is not confined to one column: `vendorShares` takes **positive parts only**, so a negative
net drops that vendor out of the split and the item's whole consumed value falls into
**Not attributed**. The ranking moves, not the cell.

**Before applying a rule to one page, grep for the other pages that assert they agree with it.**
The S580 tie-out is stated in prose in three files and enforced nowhere, which is what let a
careful single-page fix break it. It is now pinned in `supplierAttribution.test.js`.

**The correction would have been a silent no-op without widening two SELECTs.** `netFactors` keys
on the purchase row's `id`; `returnBase` looks up `purchase_entry_id` on the return. Supplier
Contribution selected neither, and `returnBase` **falls back to the list rate** rather than
dropping the row — deliberately, since a return nobody can price is still a return. So the wrong
answer and the un-fixed answer are byte-identical, with no error anywhere. **A helper whose
fallback is "behave as before" needs its join keys asserted by a test, not by a reviewer** — the
tests were verified to fail against the pre-fix arithmetic before being kept.

`netFactors`/`returnBase` now live in `supplierAttribution.js` beside `allocateBillDiscounts`,
which is the only thing they are derived from; `purchaseTaxSplit.js` imports that file, so it could
not have been the other way round without a cycle, and it re-exports both.

### A drilldown is a page that nobody re-reads (S727)

`VendorReport`'s `allBills` was the one block S725 never opened, so it kept the pre-S725
arithmetic — raw `qty × rate`, list-rate returns — while every figure around it moved. **Repairing
the summary therefore WIDENED the divergence**: the modal now contradicted the row that opened it.

Worse, `remaining = Math.max(0, total − paid)` measured `payable_payments.amount` — which
Outstanding Payables writes **VAT-inclusive, discount-net and return-net** — against an ex-VAT,
pre-discount, pre-return total. A 10,000 bill with a 1,000 discount, paid in full, read
**`Partial — NPR 1,000 outstanding`**.

**Settle against the basis used by whatever WRITES the payment rows, and replicate it rather than
approximating it.** Outstanding Payables nets returns per line at list rate and then runs
`calcBillTotals`, so the discount and the VAT land on the returns-netted base; the drilldown now
does exactly that. The `Math.max(0, …)` is gone for S723's reason — a credit is money — so an
over-returned bill reads **Credit**.

**And show the number the badge is judged against.** A `Partial` chip beside a Net column it was
not computed from is unfalsifiable; the reader cannot tell a real balance from a phantom one. The
drilldown carries a **Payable** column now.

### A page can disagree with itself, and a TAB is where it hides (S725)

S723's rule above is a tab filter deciding which ROWS a record is valued from. This is the next one
along: **two tabs of one page computing the same figure from two different expressions**, both
labelled Net.

`VendorReport.js`'s `vendorSummary` computed `gross − discount − returns`. The `netByDay` /
`netByVendor` / `netByVendorDay` maps behind the Daily Breakdown matrix summed a raw `qty × rate`
with returns subtracted and **no bill discount at all**:

```text
one bill, 10,000 gross, 1,000 trade discount, no returns
  Vendor Summary tab  →  Net Spend        9,000
  Daily Breakdown tab →  TOTAL / Day Net  10,000
  KPI card above BOTH →  Net Spend        9,000
  Excel 'Daily Breakdown' sheet →         10,000
```

The stat strip renders above the tab switch, so the wrong total sat directly under a card stating
the right one. Nothing on the page cross-checks the two, and each was individually plausible.

**The fix is one arithmetic exposed once, not two expressions kept in step.** `allocateBillDiscounts()`
runs at the top of the `ix` memo and `lineNetOf(p)` / `retValueOf(r)` come out of it; the summary
column, the matrix, the per-method columns, the drilldown and every workbook sheet read those. The
per-vendor Discount column is **derived** as `gross − allocatedNet` rather than read from a parallel
rollup, so the Discount cell and the Net Spend beside it cannot be computed two ways.

**The tell is a page with tabs or view modes over one dataset, where each mode builds its own
totals.** Ask which expression each mode's money comes from, and make it one.

### `VendorReport` now genuinely reaches `calcBillTotals` (S725)

The section below ("Four pages value a bill") named it as one of the four, and so did
`purchaseTaxSplit.js`'s own header comment. **It never imported it** — it re-typed the
discount-apportioned VAT base inline in `discountedBills`. The arithmetic was identical, which is
exactly what makes an independent copy dangerous rather than harmless: it agrees until one of them
is changed, and nothing points at the other.

**A rules file saying a page uses a helper is not evidence that it does.** Grep the import before
trusting a claim of this shape — in either direction. Both claims are true now.

### The hardcoded `100%` footer, third instance (S725)

S594 found it on Supplier Contribution. S719 found it on Wastage Report. `VendorReport`'s
`% of Net Total` footer was the third, and it diverged for **two independent reasons at once**:

- the rows divide by `grandNet`, which carries the **Unassigned** (`vendor_id IS NULL`) bills — and
  those had no Net cell of their own, only a count and a gross under a `colSpan={8}`;
- the footer printed the whole period's grand totals under a **search-filtered** row list, so
  narrowing to one vendor showed one row above a TOTAL for every vendor.

**A footer totals the rows rendered above it, and a percentage is computed.** Where the footer is
deliberately page-level while the rows are filtered, say so on the page (this one prints the
period's own totals in a line beneath the filtered footer). And when a report has a catch-all row,
give it every column the real rows have — a row that cannot be added up is why the column does not.

### An `is_active` picker filter, third page (S725)

After `VendorReport` and `VendorBalanceConfirmation` (S708). `SupplierPriceTracker` loaded vendors
with `.eq('is_active', true)` — correct for its dropdown, which is a picker — but its **"All
Vendors" mode scans every purchase row**, including rows belonging to a vendor since archived. Those
rows rendered with a blank Vendor cell, because `vendorMap` could not resolve them. Archiving forces
`is_active = false`, so *using the feature* was what produced the defect, as it was both times before.

**A page can need both answers at once.** Load every vendor for RESOLUTION and split the picker —
active first, an inactive `No longer active` optgroup after — rather than choosing one population
for the page. That is `VendorBalanceConfirmation`'s shape and it is the one to copy.

### An export that ignores the filters on screen is a different report (S725)

`SupplierPriceTracker`'s Export re-derived its rows from vendor and month and ignored the **Search
box and the Trend filter**. Filtering to "↑ Rising Only", reading six items and pressing Export
handed you a sheet of 240 with nothing in it to say the two were different lists — and the filename
named only the two filters it had honoured.

Export the rows the reader is looking at, and state **every** active filter in the `scopeLine`. Same
family as S594's rule that a report stating a scope must state it everywhere it goes; the failure
here is one step earlier, in the report not having the scope it appeared to.

**And a money cell in a workbook is a NUMBER.** Two of Vendor Report's three sheets wrote
`x.toFixed(0)` — a string Excel will not sum, sort or format — while the third sheet in the same
file wrote `Number(x.toFixed(2))`. Price Tracker wrote its rates as `.toFixed(4)` strings on a sheet
whose entire purpose is sorting by price. `Number(v.toFixed(2))` at every money site, and a TOTAL
row on any sheet a reader is expected to reconcile.

### An exclusion a report cannot value must be counted and named (S725)

`SupplierContribution` walked its consumed ingredients with `if (!item) continue` over an
`is_active = true` read. The filter is right and stays — `Variance`, `TheoreticalVariance` and
`ShrinkageReport` all read `items` that way, and S588 aligned the four deliberately, so dropping it
here alone would make this page disagree with the three it is reconciled against.

What was wrong is that the exclusion was **silent**. The cost of a hidden ingredient a sold dish
consumed is simply absent from Cost of Sales, and the page's own stated invariant — attributed plus
not-attributed equals the whole consumed value — held only over the items that survived the filter.
The page already has the right instinct one row over: `Not attributed` exists precisely so a rollup
that cannot claim a row does not produce a believable short total (S567). The same courtesy now
applies to the rows it cannot value: a banner naming the count and the affected dishes, and a line in
the workbook's notes so the caveat survives the sheet being mailed on.

**A filter that is correct is not automatically a filter that can be applied quietly.** Ask what
falls out of it, and whether the reader would want to know.

### A tab filter is not a valuation boundary (S723)

The S722 rule below is a report reading half a bill because its QUERY narrowed the rows. This is the
same defect produced by a UI affordance instead, and it is worth stating separately because nothing
about the query looks like scoping — it looks like a tab.

Outstanding Payables' two tabs are `.is('paid_at', null)` and its complement. **`paid_at` is stamped
PER LINE**, and `allocatePayment` settles a bill's lines oldest-first, so a PARTIAL payment on a
multi-line bill stamps some lines and not others and the tab filter then hands each tab half a bill.
The page valued whatever arrived, and `calcBillTotals` is **not linear in the bill-level discount**:

```text
2-line VAT-inclusive bill, 1,000 + 1,000, bill discount 200  →  true total 2,034.00
pay 1,017.00                                                 →  the older line settles
Outstanding then shows   Bill Total 904.00   Remaining 904.00   Paid —   (no payment history)
Paid History shows the same bill, at 904.00, as settled
```

113 short of what is owed, the recorded payment invisible on the bill it belongs to, and one bill
present on both tabs at once. Without a discount the arithmetic is linear and only the *display* is
wrong, which is why this survived: the failure needs a bill discount to become a wrong number.

**A tab, a filter or a search may decide which RECORDS are shown; it must never decide which rows a
record is computed from.** The fix is to let the filter select the bills and then complete each one
(`.in('purchase_group_id', …)`, chunked) before valuing it. Two properties are load-bearing: tab
membership is a property of the whole bill (outstanding while ANY line is unsettled), and it is
keyed on `paid_at` rather than on `remaining > 0`, because a bill settled before `payable_payments`
existed carries the stamp and no payment rows — a remaining-based test drags every one of those back
into Outstanding as a full balance owed.

The tell is a page whose query carries a WHERE clause on a per-line column and whose arithmetic is
per-bill. Grep for a `.eq`/`.is`/`.not` on `paid_at`, `vat_inclusive`, `source` or `status` sitting
above a `calcBillTotals`, an `allocateBillDiscounts` or any `Object.values(byBill)` regroup.

### A paged read whose follow-up reads are bare has not been paged (S723)

Outstanding Payables' bills read is `fetchAllRows`-wrapped under a comment calling it *"the single
most likely place in the app to cross PostgREST's silent 1000-row cap"*. The two reads that hang off
its id list — `payable_payments` and `vendor_returns` — were bare `.in('purchase_entry_id', ids)`.
Same shape on Vendor Balance Confirmation, whose own comment says a truncated read *"would
understate the balance on a document sent to the vendor for signature"*, four lines above two
unpaged reads.

**`payable_payments` is one row per LINE per settlement, so it grows FASTER than the bills it hangs
off** — a client settling 50 eight-line bills a month writes 400 payment rows a month. Truncate it
and paid bills render as unpaid and Total Remaining inflates; truncate `vendor_returns` and every
returned bill overstates what is owed. Neither returns an error, so no guard on either page fires.
The id list is also a URL: on Paid History it is every settled credit line the client has ever
recorded, on the letter every credit line ever billed to that vendor (S629). `fetchAllRowsChunked`
answers both halves.

This is S706/S708's producer-and-consumer rule pointing the other way — there the consumer was paged
and the producer was not; here the seed read was paged and everything downstream of it was not.
**Ask what else is read FROM the ids a paged read produces**, and remember that a child table's
cardinality is the parent's multiplied by something.

### A credit is money, and clamping it to zero is not neutral (S723)

`Math.max(0, value − paid)` reads as defensive and is a decision: it deletes the state where the
VENDOR owes US. That state is ordinary — goods returned against an already-settled bill — and
`ReturnsTab` has no guard against creating it, nor should it, since that is exactly what a credit
note is.

It was clamped per line in Outstanding Payables and per bill in `computeOpeningBalance`, while the
confirmation letter's FY schedule applies returns with **no clamp at all** — so one credit note
appeared in the letter if it fell after Shrawan 1 and vanished if it fell before it, on the two
halves of one document. Decision, Aashish 2026-09-10: show it. A bill in that state wears a
**Credit** badge, Paid History totals them in a card rendered only when there is one, and the pay
form is replaced by a sentence — Save on such a bill had been a button that did nothing silently,
since `allocatePayment` skips every line at or under `EPS`.

**Before writing a `Math.max(0, …)` around a money figure, name the state on the other side of the
zero and say what happens to it.** If the answer is "it cannot happen", check whether any screen in
the product can create it; if it is "it does not belong on this page", it still has to go somewhere.

### `purchase_entries.payment_method` is the third nullable column a `.neq` has silently emptied (S723)

After `sales_entries.source` (S699) and `recipes.category` (S714). Vendor Balance Confirmation read
its cash bills with `.neq('payment_method', 'Credit')`, and the column is NULL on every bill written
before it existed — `NULL <> 'Credit'` is NULL, not true, so those rows appeared in NEITHER read and
a vendor's legacy cash purchases were simply absent from the FY's Purchases total on the letter.

Two things make this one worth naming despite the rule already existing twice. **It is a column this
file already documents as needing a fallback** — S650's `methodOf(p)` rule says a value displayed
through `|| 'Cash'` must also be filtered, grouped and counted through it — and the `.neq` was
written anyway, in a different module, by someone who would have found that rule only by loading
this file. And **`groupRawBills` was passing the raw NULL through**, so the schedule's Particulars
column rendered "Purchase (null)" for any legacy bill that did reach it; the fallback is resolved
once at the grouping boundary now rather than at each of the four places downstream that compare or
print it.

### A headline that counts money the schedule below it does not show (S723)

The confirmation letter's "Payments (FY)" box added every Cash/FonePay bill's net settlement, while
those bills printed in the supporting schedule only as **purchases**. Arithmetically consistent —
the purchase and the settlement cancel, so the letter's own sentence still reconciled — and useless
to the reader it exists for: a vendor asked to verify the letter line by line finds a payments total
the payment lines do not add up to. The Amount column's own total had the same problem from the
other side, summing cash purchases that never touch the balance.

A cash bill now emits its settlement as its own row (net of that bill's returns, moving the running
balance by nothing), every payment total is read off the schedule rather than computed beside it,
and the Amount column totals to exactly (Closing − Opening).

**On a document someone else checks, "the total is correct" is not the standard — "the reader can
derive the total from what is printed" is.** Same family as S594's Supplier Contribution finding: a
footer that cannot be reconciled against the rows above it discredits the rows as much as itself.

### A bill is mixed, so a query cannot be the split (S722)

**`vat_inclusive` is PER LINE and `discount_amount` is PER BILL.** `PurchaseBillForm` puts a VAT
checkbox on every row and a toggle-all above them — the toggle-all exists *because* mixed bills are
ordinary. Put the two facts together and a bill's single discount has to be **apportioned across
both halves** before either the VAT Report or the Non-VAT Report can claim any of it.

So **a report that wants one half must still READ the whole bill.** Non-VAT Report's query carried
`.eq('vat_inclusive', false)`, which looks like the obvious way to scope the page and is the defect:
it could not see the VAT lines, so it charged the **entire** bill discount against the non-VAT half
while VAT Report was independently charging its proportional share. On a 10,000 bill (6,000 VAT /
4,000 non-VAT) with a 1,000 discount the two pages claimed **1,600**, and "non-VAT purchases this
period" read 4,000 on one page and 3,000 on the other. Both figures are filed with the IRD.

`src/modules/ims/reports/purchaseTaxSplit.js` is the one place that split happens.
`splitPurchaseVat(entries, returns)` runs `allocateBillDiscounts()` over every line and returns both
halves; VAT Report and Non-VAT Report each read fields off the **same call over the same rows**, so
they cannot fail to sum back to the bill. Its `buildVendorSummary()` has **no `discountScope`
option** — per-line allocation makes "prorate across the bill" and "prorate across its VAT lines"
the same arithmetic (`discount × line / billGross`), and the only thing that ever differed was which
lines the caller passed. VAT Report passes the VAT lines; Annexure-13 passes all of them.

**A return is credited at its bill's DISCOUNTED rate.** `vendor_returns.rate` stores the linked
line's list rate, and it was being subtracted from a base that had already lost the discount — so
returning a whole discounted bill drove the taxable base **negative by the discount** and filed a
negative input VAT claim. `returnBase()` scales every return by its own line's net factor; a full
return now nets to exactly zero. The lookup is by `purchase_entry_id` and **falls back to the list
rate rather than dropping the row** — a return nobody can price is still a return.

### Four pages value a bill, and they must all say `calcBillTotals` (S722)

"What does this bill cost" has exactly one answer: `(gross − discount) + 13% VAT on the taxable
portion net of its share of that discount`. The Purchases register, `VendorReport`'s discount table,
`OutstandingPayables` and the printed voucher all reach it through `calcBillTotals()`.

**Payment Summary did not.** It summed `qty × rate` per line — **ex-VAT and pre-discount**, which is
neither the cost basis nor the money owed, so it tied to nothing: not the register, not Outstanding
Payables, not the P&L. Its own module guide had carried the defect as a written gotcha for months
without it being fixed. It now goes through `billPayables()` in `purchaseTaxSplit.js`, which is
`calcBillTotals()` per bill, so the Credit column and Outstanding Payables finally quote one number.

Two properties of that page worth keeping: `payment_method` is a **bill-level** choice written onto
every line, so a bill belongs to exactly one method and is counted **once** however many lines it
has; and NULL reads as Cash (`PURCHASE_PAYMENT_METHODS`' documented rule) — a filter that misses
NULL loses real bills.

**Defaulting to the open period is not a default.** Payment Summary picked
`periods.find(status === 'open')` and, finding none, selected nothing, loaded nothing, and still
rendered the whole stat grid at NPR 0 with a total row reading 100%. Fall back to `periods[0]`.

### A bill with payments recorded against it is frozen, and a return has its own day (S698)

Six things settled by the S698 re-analysis of the purchases module, each a decision Aashish made
in plain words on 2026-09-08 — do not re-litigate them:

- **A bill with vendor payments cannot be deleted or edited.** `payable_payments` cascades off
  `purchase_entries`, so both used to erase money that had actually left the bank, from Payment
  Report and Vendor Balance Confirmation alike, with no trace. The guard is a `BEFORE DELETE`
  trigger plus the RPC plus a worded pre-check on the list page — see `supabase-sql.md`. The
  message tells the reader to remove the payments in Outstanding Payables first.
- **A return is dated to the day the goods went back**, through its own `Day Returned` picker
  (pre-filled with the bill's day). It used to copy `linked.bs_day`, so every return was dated to
  the purchase, Vendor Balance Confirmation's running ledger showed returns before they happened,
  and the Returns tab's own Day tooltip promised the opposite. Rows written before S698 still
  carry the bill's day; nothing signals that, and it is only wrong where the return genuinely
  happened later.
- **A free line is a line.** `lineState()` in `purchasesHelpers.js` (tested) has three states —
  blank (ignored), incomplete (refused by name), complete — and a complete line with rate 0 or
  blank saves as free goods: stock up, spend unchanged. The rate-sync prompt skips it, or a gift
  would offer to zero the Item Master rate. The old filter dropped any priced-at-0 or unpriced row
  silently.
- **Same vendor + same bill number is a WARNING, not a stop.** `findDuplicateBill()` asks before
  saving (case-insensitive, any month, excluding the bill being edited). Some vendors reuse
  numbers. A failed check asks too, rather than passing as "no duplicate".
- **A PO receipt is ONE bill.** `purchase_group_id` defaults to `gen_random_uuid()` PER ROW, so an
  insert that omits it gets a different group on every line — `PurchaseOrders.confirmReceive`
  did, and a six-line delivery was six bills on the Purchases list. Any new writer of
  `purchase_entries` must stamp one shared id per bill.
- **Delete All is Supervisor+.** Staff keeps single-bill add/edit/delete.

Two tooltips were corrected in the same pass and the correction is worth keeping true: the
Purchases page's gross figure is bill rate BEFORE discount, Monthly Summary and P&L take the same
bills NET of allocated discounts (S601), and Stock Count's Summary values what arrived at the
ITEM MASTER rate — three legitimately different figures, so no tooltip may claim they match. And
the Daily Register's Total is a QUANTITY in the base unit, not money.

### Purchase Orders was the un-swept sibling, and a receipt is a purchase (S709)

`PurchaseOrders.js` writes `purchase_entries` — the same table `Purchases.js` does — and every
piece of discipline S698 put into that page was absent from this one: no closed-period lock, no
`firstError`, no asserted row counts, no atomic save, four of its writes dropping their errors
outright. **When one page in a module is repaired, the question to ask is which other page writes
the same table**, not which other page looks like it. The receipt path is now
`receive_purchase_order` (see `supabase-sql.md`); the rest of what changed:

- **A receipt links back to its order.** `purchase_entries.po_id`, nullable forever — NULL means
  "typed in by hand", never "unknown" — and `save_purchase_bill` carries it through an edit. This
  is the reconciliation `invoice_ref = po_number` could never be: that field is free text and
  Purchases lets anyone overwrite it.
- **A PO with bills against it cannot be deleted**, by anyone, operator included; Cancel is the way
  through, and on a part-received order it is labelled **Close Short** — the goods that arrived
  keep their bills and their stock, only the outstanding quantity closes. The old Cancel tooltip
  promised "no purchase entries will be created" on orders whose entries already existed.
- **Editing needs draft AND nothing received.** An edit replaces the line rows and a replacement
  starts at `qty_received: 0`, so the draft-only rule was one silent status write away from wiping
  the evidence of a delivery.
- **The order's period is where the bill lands, not the month you are in.** The Day Received picker
  is locked to the PO's own BS month (it was a 1–32 number box pre-filled with *today's* day
  number, whatever month today was in), and the screen says so when the two differ.
- **Everything on this page is in BASE units** — `qty_ordered`, `unit_price`, and therefore the
  `purchase_entries` rows it writes. No conversion factor is applied anywhere on it, unlike a
  Purchase Bill whose qty is in purchase units. That is why it prefills bare `per_uom_rate`
  (corrected in `item-master-rates.md`, S698) and why nothing here calls `getCf`.

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

### An `is_active` filter on a REPORT is a picker convention one file too far (S708)

S671 kept the `vendors` row so history stays readable, and the Vendors page promises exactly that in
those words. Two reports broke the promise, because **archiving forces `is_active = false`** and both
filtered on it — so using the feature was what triggered the defect.

- **`VendorReport.js`** built `vendorSummary`, the Daily Breakdown matrix, the vendor combobox and
  the Excel export from active vendors, while the footer TOTAL, the four KPI cards and
  `% of Net Total` were computed over EVERY purchase row in the period. A vendor deactivated
  mid-year had its spend in the total with no row above it. `vendorSummary` already ends in
  `.filter(r => r.gross > 0 || r.returned > 0)`, so **dropping the filter adds only vendors that
  genuinely traded in the month** — it does not lengthen the list with dormant suppliers.
- **`VendorBalanceConfirmation.js`** was a dead end rather than a wrong number: the `?vendor=` link
  Vendors.js puts on every row preselects only if the id is in the loaded list, so an archived
  vendor failed that test silently and the button landed on "Select a vendor" with the vendor
  absent from the dropdown. The membership test itself is right and stays — it is what stops a
  stale id selecting a vendor the client cannot see. The picker now loads every vendor and splits
  the inactive ones under a **No longer active** optgroup.

**The general rule: `.eq('is_active', true)` belongs on a PICKER, which asks what may be chosen
NOW. A report asks what happened, and its vendor list is its row set.** Before copying that filter
into a new query, ask which of the two the list is. The live consumers that are correctly pickers:
`TadaClaims`, `SupplierPriceTracker`, `GatePasses`, `computeVendorPurchasingSection`,
`ClientDashboard`'s count, and `Purchases.js` — the last of which pairs it with
`PurchaseBillPage`'s `_inactive` backfill, so an existing bill still names a vendor the picker no
longer offers. That backfill is the pattern to copy where a picker must also render history.

### The vendor delete guard is a trigger, and there is deliberately no force-delete (S708)

`vendors_guard_referenced_delete` (migration `20260909140000`) is a BEFORE DELETE trigger over
`vendor_reference_counts()`, the direct sibling of S707's items guard. The browser guard in
Vendors.js is thorough and stays — it is what words the refusal — but `vendors` carries no
`no_ims_staff` fence, so every IMS account of any rank could `DELETE /rest/v1/vendors?id=eq.<uuid>`
with its own JWT, including an `ims_role = 'staff'` account that cannot open the page at all. Two
of the four referencing tables refuse; `vendor_returns` and `ims_gate_passes` are ON DELETE SET
NULL, so it succeeded silently. The trigger also closes a race the page cannot: its re-check and
its DELETE are two round trips.

**`vendors` has no audit trigger**, so a deleted vendor row leaves no snapshot anywhere. That is
what makes the `vendor_returns` loss unrecoverable rather than merely awkward: the SET NULL is
logged as an UPDATE carrying the old `vendor_id`, but that id resolves to a row that is gone, and
`vendors` was the only copy of the name.

**There is no `force_delete_vendor()`, and that is the decision, not an omission.**
`force_delete_item` exists because an item can be a genuine mis-entry. A vendor with history is a
supplier the client really did buy from, and the only thing a force-delete could do is destroy the
record proving it — Archive already loses nothing. No bypass for a client account of any rank,
operator included; the service role stays the escape hatch that keeps Danger Zone working.

`vendor_reference_counts(p_ids uuid[])` is also the one-round-trip answer to "what points at these
vendors", where `loadUsage()` currently transfers every purchase line the client has ever entered
to count them. **The SQL table list is the twin of `VENDOR_REF_TABLES` in `Vendors.js`** — unlike
`ITEM_REF_TABLES` there is no test holding the two together yet, so change both.

### Still open on vendors, as decisions rather than omissions (S708)

`vendors` has **no `UNIQUE (client_id, lower(name))` and no client-side duplicate check either** —
it sits where `items` was before S706. A duplicate splits one supplier's payables across two rows
in Outstanding Payables, two lines in Vendor Report and two balance letters each carrying half the
balance, and a lost response on Add Vendor retried makes the second row silently (the S619 rule).
`vendor_code` has the same client-side-max root cause as `item_code` and the same verdict — nothing
keys off it — but note `getNextVendorCode()` mints from the page's own array, so it is only as good
as that read. Also unfixed: no `loadedClientRef` guard (switching client leaves the previous one's
rows up, and a late old response can win the page); the code prefix goes into `new RegExp`
unescaped, in Items.js too; and Settings' vendor renumber loop checks no error yet reports success.

### `purchase_entries.created_at` is a BILL-level fact, not a row-level one (S670)

It no longer answers "when was this row written". The edit path in `PurchaseBillForm.jsx` replaces
every line (since S698 inside `save_purchase_bill`, one transaction), so the column used to restamp to `now()` on every
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
`supplierAttribution.js` all dedupe it by bill before use. The P&L was the first place caught
ignoring it entirely — `sum(qty * rate)` charged the undiscounted price into COGS, so COGS ran
high and Net Profit low by the whole discount while the Purchases register showed the discounted
total for the same bill. Measured on the reference client, one month was **NPR 289,456** overstated.

Fixed in one change across the three places then known to disagree: `ConsolidatedPnl.jsx`,
`MonthlySummary.js` (both via `allocateBillDiscounts()` from `supplierAttribution.js`) and
`get_group_pnl` (migration `20260822140000`, the same arithmetic in SQL).

**The set is now six**, because that fix did not travel on its own: `AnnualSummary.js`,
`PeriodComparison.js` and `BudgetVsActual.js` each summed a raw `qty * rate` until S720, so COGS
and their own "Net Purchases" column ran high by the whole bill discount on three pages a client
reads beside Monthly Summary. Those four summary pages are now held to it by
`summaryReads.test.js`, which reads their source for `allocateBillDiscounts(`, the five columns it
needs (`discount_amount`, `purchase_group_id`, `vendor_id`, `invoice_ref`, `bs_day`) and a
`lineGross`/`lineNet` figure rather than a raw product. **Any page that values purchases joins this
list.**

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
