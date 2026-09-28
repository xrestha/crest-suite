# PURCHASES — buying and paying suppliers (bills, drafts, returns, POs, payables, balance letter)
Files reviewed (18 source + 4 migrations): purchases/PurchaseBillForm.jsx, PurchaseBillPage.jsx, purchaseBillDraft.js,
Purchases.js, ReturnsTab.jsx, purchasesHelpers.js, PurchaseOrders.js (load/save/receive paths), SupplierPriceTracker.js
(reads + price save), PurchaseBillPrint.jsx (arithmetic); reports/OutstandingPayables.js, payablesAllocation.js,
vendorBalanceHelpers.js, VendorBalanceConfirmation.js, VendorBalanceConfirmationPrint.jsx (totals), readPriorBillLines.js,
purchaseTaxSplit.js (billPayables only), supplierAttribution.js (returnBase/netFactors only); migrations 20260918100000,
20260918120000, 20260918130000, baseline `purchase_order_items`. Skipped: test files, PO/price-tracker rendering-only JSX,
Vendor Report and VAT pages (other reviewers).

### PURCHASES-1 [P1] A PO receipt rounds every per-base-unit price to 2 decimals — gram/ml items are mispriced, cheap ones become free lines
- Where: `supabase/migrations/20260705074838_baseline_schema.sql:1242` (`purchase_order_items.unit_price numeric(12,2)`, no later ALTER);
  `20260918100000_ims_integrity_s756.sql:265` (`receive_purchase_order`: `COALESCE(round((v_line ->> 'rate')::numeric, 2), 0)`);
  `src/modules/ims/purchases/PurchaseOrders.js:249` (prefills bare `per_uom_rate`), `:327` (saves it), `:559` (receipt rate).
- What happens: POs are in BASE units by design (S709), and since S597 items are stored in their smallest unit, so most
  per-unit prices are sub-rupee with 3–4 decimals. Sugar at NPR 0.115/GM: the PO form shows 5,000 GM = NPR 575; the saved
  line holds 0.12 and the receipt books NPR 600 (+4.3%). Oil at 0.035/ML → 0.04 (+14%). Anything under 0.005/unit (salt,
  napkins by the piece) stores 0.00, so the receipt writes a **free line** — stock up, spend zero — into COGS, VAT and payables.
  With "VAT Incl." ticked it rounds twice (0.12/1.13 = 0.106 → 0.11).
- Evidence: the column type and the RPC's explicit `round(…, 2)`; the form never shows the rounded value until reopened.
- Status: missed by S756 (S709 code; S756 re-created the RPC body unchanged).
- Fix: `ALTER … unit_price TYPE numeric` and drop the `round(…,2)` in `receive_purchase_order` (round to 6 at most).
- Confidence: Confirmed from migrations (a live `\d purchase_order_items` would settle it absolutely).

### PURCHASES-2 [P1] A bill-edit draft (S779) is restored over a NEWER saved version of the bill and silently reverts it
- Where: `src/modules/ims/purchases/purchaseBillDraft.js:115` (`all[id] = { header, lines, savedAt: now }` — the baseline
  signature decides whether to store, but is not stored); `PurchaseBillForm.jsx:85-93` (restore in the initialiser),
  `:395` (superseded ids = the rows loaded now); `PurchaseBillPage.jsx:295,313` ("← Purchases" navigates without clearing the
  draft; so does the sidebar).
- What happens: A opens bill G to edit, changes a quantity, then leaves by "← Purchases"/the sidebar (or the tab dies) → draft
  `edit:G:A` kept 7 days. B (or A on another device) edits G properly — fixes a rate — and saves; the lines get new ids. When A
  next opens G, the form loads B's version as its baseline, then replaces it with A's stale lines under "↺ Brought back what you
  were typing … Nothing has been recorded yet — check it over and Save." Nothing says the bill changed since. A saves:
  `save_purchase_bill` deletes B's fresh ids (count matches, so `purchase_bill_stale` does not fire) and writes A's old lines.
  B's correction is gone with no trace on screen.
- Status: NEW (S779).
- Fix: store `baseSignature` (or the superseded ids / newest `created_at`) in the draft; on restore, if it differs from the
  pristine signature, do not auto-restore — say "this bill was changed after your unsaved edit" and offer keep/discard. Owner question 4.
- Confidence: Confirmed (code path).

### PURCHASES-3 [P1] Payables credit a return against a discounted bill at LIST price and keep the whole discount — payable understated, can go below zero; the balance letter tells a supplier they owe us the discount
- Where: `src/modules/ims/reports/payablesAllocation.js:49,76-97` (`netLine = qty×rate − returned at list`, then
  `calcBillTotals(…, full billDiscount)`); `vendorBalanceHelpers.js:105-113,121-132` (`billGrandTotal`, no `netSum > 0` guard);
  `OutstandingPayables.js:279-283,365-367`. Contrast `purchaseTaxSplit.js:344-351` (`billPayables` → `returnBase`, discounted).
- What happens (non-VAT figures):
  - Credit bill: line A 6,000 + line B 4,000, bill discount 1,000, unpaid; all of B goes back. At the price actually charged the
    supplier credits 3,600 and is owed 5,400. Outstanding Payables and the letter say 5,000; Payment Report (S756 D10, discounted
    returns) nets 5,400. S722's "the Credit column and Outstanding Payables quote one number" no longer holds.
  - Same bill fully returned: Outstanding shows 0 (its `netSum > 0` guard), but the letter computes `billGrandTotal` = 0 − 1,000
    = −1,000, prints a Return of 10,000 against a 9,000 bill and closes at **"Advance / Credit Balance NPR 1,000"** — on the IRD
    Annexure-13 letter sent to the supplier for signature (and in the WhatsApp summary).
  - Heavy partial return on an unpaid bill (9,500 of 10,000 list back): Outstanding's grand total is −500, the unpaid bill wears a
    purple "500 cr / Credit" badge and subtracts 500 from Total Remaining; offering it as supplier credit (D11) is then refused by
    the pair trigger ("more supplier credit was taken from that bill than was ever paid on it") — a confusing refusal.
  - Paid 9,000, then half the goods returned: Outstanding offers 5,000 of supplier credit where the supplier's credit note says
    4,500; D11 lets the extra 500 settle another bill the supplier still considers owed.
- Status: missed by S756 — stage 4 moved Payment Report / Vendor Report / Supplier Contribution / VAT to discounted returns; the two
  payables readers (and Vendor Report's drilldown Payable column, which copies Outstanding) stayed on list rate. (S747's "returns
  stay at list price" is a COGS decision; see Owner question 1.)
- Fix: value each return at its line's net factor (as `returnBase` does) in `valueBillLines` and `billGrandTotal`, and never let
  returns alone take a bill below zero.
- Confidence: Confirmed (arithmetic traced through both helpers).

### PURCHASES-4 [P2] The line "Total" box means before-VAT or after-VAT depending on whether VAT was ticked first; S779 made "after" the tab order, and the header VAT toggle leaves the typed Total contradicting Amount
- Where: `PurchaseBillForm.jsx:200-210` (`setLineTotal` divides by 1.13 only if the line is ALREADY ticked), `:190` (ticking a line
  clears the Total draft, keeps the rate), `:512` (header toggle-all flips `vat_inclusive`, keeps `_amtDraft`); column move in
  commit 4a31be81 (Qty | Rate | Total | VAT | Amount).
- What happens: Qty 10, type Total 1,130 off the paper, Tab to the VAT tick → rate stays 113 ex-VAT, Amount becomes 1,276.90.
  Tick first, then type 1,130 → rate 100, Amount 1,130. Same keystrokes, 13% apart. With the header "VAT" toggle after typing a
  column of totals, every Total box still shows its typed 1,130 while Amount beside it reads 1,276.90 — the "two figures on one
  row disagreeing" S698 removed. The Total tooltip says "total paid for this line", i.e. incl. VAT.
- Status: NEW (S779 changed the order) + missed by S756 (header toggle).
- Fix: when VAT flips on a line with a typed Total, re-derive the rate from that Total (the paper figure stays authoritative);
  same in the header toggle. Owner question 2.
- Confidence: Confirmed (code); only caught at save if the optional D13 invoice total is typed.

### PURCHASES-5 [P2] Editing an old bill (or filing a missed one into a closed month) offers — pre-ticked — to roll Item Master back to that month's prices
- Where: `PurchaseBillPage.jsx:219-235` (`handleBillSaved` runs `detectRateChanges` for edits and closed-month bills alike),
  `:227` (every changed item pre-selected), `:423-426` (primary button "Update N items").
- What happens: the Owner fixes a quantity typo on a Shrawan bill in Mangsir. Prices moved since, so the prompt says "This bill's
  rate differs from Item Master for 8 items", all ticked. One click on the highlighted button sets Item Master back to Shrawan
  prices, re-valuing every count, wastage, staff meal and recipe cost in every month. The D5 note says so, but the default action
  is the harmful one and the premise ("this bill is the new price") is false for an old bill.
- Status: missed by S756 (D5 added the warning, not the premise).
- Fix: offer the sync only where the line is the item's latest priced purchase; untick by default on edits/closed months. Owner question 3.
- Confidence: Confirmed (code path; harm needs the click).

### PURCHASES-6 [P2] Price Tracker changes the Item Master price with no D5 warning and no zero-row check
- Where: `src/modules/ims/purchases/SupplierPriceTracker.js:255-298` (`scopedUpdate('items', { rate }).eq('id', item.id)` — no
  confirm, no `.select('id')`; the only message is the after-the-fact "N recipes affected" banner, `:482-499`).
- What happens: D5 says a price change warns first, naming how many past records it re-values (Items.js does; the bill page's
  prompt carries the wording). This third writer of `items.rate` saves on Enter with no warning, re-valuing closed months'
  counts, wastage and recipe costs silently; an update matching zero rows (item deleted meanwhile) updates the screen anyway.
- Status: missed by S756 (D5 not applied to the third writer).
- Fix: route through the same confirm as Items.js; `.select('id')` and refuse on zero rows.
- Confidence: Confirmed.

### PURCHASES-7 [P2] Balance letter: "Share via WhatsApp" (and Print) stay live during a recompute, sending the previous vendor's balance under the new vendor's name
- Where: `src/modules/ims/reports/VendorBalanceConfirmation.js:209` (`vendor && result && !isEmpty` — no `!computing`),
  `:76-81` (`load` never clears `result`), `:179-194` (`buildWhatsAppText` takes the NEW `vendor`/`selectedFy`, OLD `result`).
- What happens: letter for Vendor A on screen; pick Vendor B; while the body reads "Computing…" the header still offers Share —
  the message reads "Business → Vendor B, FY … Balance Payable NPR <A's balance>".
- Status: missed by S756 (S728 rule: an export/share control gates on loading).
- Fix: render the actions only when `!computing`; clear `result` at the start of `load`.
- Confidence: Confirmed.

### PURCHASES-8 [P3] A credit bill with nothing left to pay never leaves Outstanding (fully returned, or a paid line later returned)
- Where: `OutstandingPayables.js:298-300` (tab by `paid_at`), `:1127-1133` (status chip = aging label), `:1261-1266`;
  `payablesAllocation.js:184,358-360` (only lines that receive money can be stamped).
- What happens: a Credit bill whose goods all went back has remaining 0 and no line ever gets `paid_at`, so it sits on Outstanding
  for ever with a red "90+ days" chip, counted in "N bills", with no control to close it. Same when a bill's first line was paid and
  then returned (that line goes negative) while line 2 is unpaid: paying the bill's remaining puts it all on line 2, which never
  reaches its own value, so it is never stamped.
- Status: missed by S756. Fix: after a write (and on load) stamp every line of a bill whose remaining ≤ EPS, or offer "Settled by
  returns — close it". Confidence: Confirmed (code); frequency plausible (a wrong delivery sent back whole).

### PURCHASES-9 [P3] Per-base-unit rates print to 2 decimals on the register, Returns tab and voucher
- Where: `Purchases.js:887,958`; `ReturnsTab.jsx:255,416,498` (`maximumFractionDigits: 2`); `PurchaseBillPrint.jsx:77` (`toFixed(2)`).
- What happens: a 0.004/GM line reads "0", 0.115 reads "0.12" — the values `fmtRate` exists to show. Fix: `fmtRate`. Confirmed.

### PURCHASES-10 [P3] Smaller, each confirmed in code
- `PurchaseBillPage.jsx:62-69` — the voucher letterhead read drops its errors; a failed read prints the voucher with a blank business name.
- `PurchaseBillForm.jsx:92,365-366` — a restored NEW-bill draft whose item was hidden in Item Master since: `items` (active only)
  lacks it, `getCf` returns 1, and a qty typed in cartons saves as that many base units (Plausible; needs a hide between typing and saving).
- No server-side overpayment guard: two managers paying the same bill (or a lump sum from a stale page) both land; the bill then
  shows as Credit. Visible after reload, so P3.
- `PurchaseOrders.js:123-131` — with no open period (between closing one month and opening the next) the page selects nothing and
  shows an empty list rather than falling back to the latest period (S722 rule).

## GAPs
1. **Outstanding Payables cannot be printed or exported.** The aged payables list — what an accountant asks for at month end — has
   no Print and no Excel (grep finds neither in `OutstandingPayables.js`).
2. **"Overdue" ignores the supplier's terms.** Payment terms are free text; Overdue is a fixed "> 60 days" for every supplier, so a
   Net-7 vegetable supplier is never overdue and a Net-90 distributor always is.
3. **No way to close a rupee-or-less difference with a supplier.** D13 tolerates ±NPR 1 between paper and Crest, but a payment must
   match Crest's figure to settle; paying the paper amount leaves e.g. NPR 0.40 "Partial" for ever, and paying more is refused. An
   owner expects "round off / write off small balance".
4. **An unsaved bill is invisible to everyone else.** The S779 draft lives only on the device that typed it: a colleague on another
   device sees no "bill in progress" and keys the same paper bill again; a staff draft for a month that then closes is unreachable
   and nobody is told.
5. **A PO receipt cannot carry a discount or mixed VAT.** VAT is one tick for the whole delivery and there is no discount/invoice
   figure on Receive, so a delivery with a trade discount or mixed VAT must be received and then edited in Purchases.

## Owner questions
1. **When you send back goods from a bill that had a discount, how much comes off what you owe?** (a) The discounted price you
   actually paid for those goods — what the VAT Report and Payment Report already use; (b) the full list price, keeping the whole
   discount — what Outstanding Payables and the balance letter do now (this can make a returned bill show the supplier owing you);
   (c) whatever the supplier's credit note says, typed in. **Recommend (a)**, with (c) as a later option.
2. **The "Total" box on a bill line: is the figure you copy off the paper before VAT or after?** (a) After VAT when the line is
   ticked — ticking or unticking VAT keeps your Total and changes the Rate; (b) before VAT — ticking VAT adds 13% on top of it.
   Today it is (a) or (b) depending on which you did first. **Recommend (a)**; the tooltip already says "total paid".
3. **After editing an old bill, should Crest offer to change today's Item Master price to that bill's price?** (a) Never for edits
   or closed months; (b) offer, but nothing ticked; (c) as now, all ticked. **Recommend (a)** for closed months and edits, (b) otherwise.
4. **An unsaved edit is found, but someone saved that bill since.** (a) Show "this bill changed after your unsaved edit" and let the
   person choose which to keep; (b) throw the unsaved edit away with a notice; (c) restore it as now. **Recommend (a).**

## Checked and fine
- D26: `save_purchase_bill` refuses a bill with returns (any month, by line id), a bill with payments, and asserts the delete count (`20260918130000:62-96`); D13 invoice columns NULL vs 0 preserved; CHECK ≥ 0 on both.
- S756 bill-form fixes hold: discount validated against saving lines (`billDiscountError`), Save frozen after commit (`saved` + `committingRef`), duplicate-bill check refuses vacuous pass on a failed read.
- D1: `ims_closed_period_guard` on `purchase_entries`/`vendor_returns` with the `paid_at`-only carve-out; `payable_payments` not locked, so paying a closed month's bill works; `receive_purchase_order` has the Owner carve-out; list/form/PO/Returns hide writes via `isLocked`, amber banner for Owner/admin.
- D10: return sits in the month on screen; over-return cap re-read fresh across every month at save and refuses on a failed read; "not before its bill" only for same-month bills; late-return note names the accountant question.
- Rank fences: `purchase_entries` staff (UPDATE manager), `vendor_returns` staff, `payable_payments` manager, count PIN refused by `ims_caller_has_rank`; Outstanding Payables, Price Tracker and the letter are manager-gated pages, PO supervisor, Purchases staff.
- D9 lump sum: oldest bill first, refuses over-total, filters never limit which bills it lands on, split shown before saving; cumulative rounding holds to the paisa.
- D11 credit pair: one insert, deferred pair trigger, pair deleted together (`expandCreditPartners` + `or(credit_link_id…)`), mode edit refused for credit rows, credit rows kept out of the letter's Payments (FY).
- S723/S756 payables fixes hold: tab completes whole bills, follow-up reads paged + chunked, overpay refused (not capped), `writePaidAt` chunked and counted, `todayIso` is Nepal's date, discount via max not sum (`billDiscountOf`, `valueBillLines`).
- Purchases register: whole-bill valuation under filters (`billTotalsByKey`), paged reads with `begin()` in init and `isCurrent`, Delete All zero-row/shortfall checks, paid-bill pre-check through the DEFINER RPC, Delete All inclusion-list gating.
- S779 draft: keyed per login and fails closed without one; period/group UUIDs keep clients apart; cleared on save (before onSaved) and on Cancel; stored only when different from the opened bill; restore announced, never silent.
- Letter: vendor list includes archived vendors; cash read is NULL-safe (`payment_method.is.null,…`); every error path re-checks `isCurrent`.
- PO: receipt is one RPC with row lock and increment, one bill per receipt, Day locked to the PO's month.
