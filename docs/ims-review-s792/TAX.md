# TAX — VAT / Non-VAT / 1L (Annexure 13) / Vendor Report / Supplier Contribution / Payment Summary / Owner Report vendor section
Files reviewed: 13 — VatReport.js, NonVatReport.js, purchaseTaxSplit.js (+test list), PurchaseOneLakhAboveReport.js, VendorReport.js (1404 lines, read 44–800 and the drilldown 1219–1390), SupplierContribution.js (1–330), supplierAttribution.js, readPriorBillLines.js, PaymentReport.js, computeVendorPurchasingSection.js, excelLetterhead.js, useBizInfo.js, useLatestRequest.js; plus purchasesHelpers.js (calcBillTotals / invoiceMismatch / billKeyOf), payablesAllocation.js valueBillLines, OutstandingPayables.js returns read, periodCost.js, fetchAllRows.js, loadDeltaExplosion (S758), App.js/Layout.js gates, purchase_entries RLS in the baseline migration.
Skipped: VendorReport.js 800–1218 (summary/matrix JSX, only spot-read), SupplierContribution.js 330–636 (render/export), VendorBalanceConfirmation (not in scope).

### TAX-1 [P1] Vendor Report drilldown "Total paid" is not what was paid (total − remaining, on two different bases)
- Where: src/modules/ims/reports/VendorReport.js:1380 (value) with :366 (`total`) and :392–410 (`owed`, `remaining`)
- What happens: `Total paid` prints `b.total - b.remaining`. `b.total` is Σ qty×rate — ex-VAT, before discount and returns. `b.remaining` has been `owed − paid` since S727, and `owed` is VAT-inclusive, discount-net and return-net. So the line reads `total − owed + paid`. A VAT credit bill of 10,000 paid in full (11,300): payment rows sum to 11,300, "Total paid" reads **10,000**. The same bill part-paid 5,000: rows sum to 5,000, "Total paid" reads **3,700**. Wrong on every credit bill that has payments and any VAT line, discount or return — the common case.
- Evidence: `NPR {(b.total - b.remaining)...}` under "Total paid"; `remaining = Math.round((owed - paid) * 100) / 100`. git blame: :1380 is from b6f4c892 (2026-09-06). :410 is from 1138f48a (2026-09-10, S727). Before S727 `remaining = max(0, total − paid)`, so `total − remaining` equalled paid. S727 changed the basis and left this line on the old one.
- Status: missed by S756 (a regression S727 introduced)
- Fix: print the sum of `b.payments` amounts, which is `paid`. Carry `paid` out of the allBills memo.
- Confidence: Confirmed

### TAX-2 [P1] Vendor Report's "Payable"/status disagrees with Outstanding Payables for any bill that has a return in a LATER month (D10)
- Where: VendorReport.js:118 (returns read `.eq('period_id', periodId)`), :368 and :387–399 (`billReturns` / `returnedByEntry` from `ix.retByEntry`), :410–413 (status). Payable tooltip :1235.
- What happens: Outstanding Payables reads every return against a line, from any month (OutstandingPayables.js:249, `.in('purchase_entry_id', …)`), and nets it into `owed`. Vendor Report replicates that arithmetic "exactly" (the S727 rule) but only over returns sitting in the month on screen. Example: a Credit bill in Bhadra, goods partly returned in Ashwin (allowed since D10), and the reduced amount paid in Outstanding Payables. Outstanding Payables shows the bill **Paid**. Vendor Report for Bhadra: `owed` is the full bill and `remaining` equals the return value including VAT, so the badge reads **Partial**, the row says "due NPR X", and the drilldown's "Outstanding: NPR X" header adds it up. The Payable column's own tooltip says "it is what Outstanding Payables shows for the same bill". That is false in this case.
- Evidence: `const billReturns = billEntries.flatMap(p => ix.retByEntry.get(p.id) || [])`, where `retByEntry` is built only from this period's `returns`.
- Status: NEW (since S756 D10). The S756 fix covered the return's own month (the "Earlier bill" row) but not the bill's month.
- Fix: for Credit bills in the period, read `vendor_returns` by `purchase_entry_id` (chunked, any month) for the owed/settlement arithmetic only. Keep the period's own returns for Net/Returns.
- Confidence: Confirmed (code path). Needs a Credit bill with a later-month return.

### TAX-3 [P2] One Lakh (Annexure 13) values a cross-year late return at the LIST rate — the D10 "fifth reader"
- Where: src/modules/ims/reports/PurchaseOneLakhAboveReport.js:108–109 (`buildVendorSummary(allocated, returns, netFactors(allocated))`)
- What happens: the report reads this fiscal year's bills and returns. A return in Shrawan–Ashadh can be against a bill from the previous fiscal year (up to 12 months back, D10). That bill is not in `allocated`, so `returnBase` falls back to factor 1. The supplier's Returned figure is overstated by that bill's discount share, and Net / VAT / Total Invoiced are understated. That can take a supplier under the NPR 1,00,000 line. The report never calls `readPriorBillLines` / `priorBillFactors`. vendor-payables.md lists the readers D10 fixed and warns that "a reader that only looks at this month's bills falls back to the list rate, which is the defect to watch for in a fifth reader". This page is that fifth reader.
- Evidence: grep shows `priorBill|readPriorBillLines` in every sibling (VAT, Non-VAT, Payment, Vendor, Supplier Contribution, computeVendorPurchasingSection) and not in PurchaseOneLakhAboveReport.js.
- Status: missed by S756
- Fix: `returnLinesOutsidePeriod(entries, returns)` → `readPriorBillLines` → `mergeFactors(netFactors(allocated), priorBillFactors(prior))`. A failed read fails the report.
- Confidence: Confirmed. The magnitude is small: the discount% of cross-year returns only.

### TAX-4 [P2] Vendor Report and Payment Summary: a superseded period load clears `loading`, so the page shows (and Vendor Report exports) the old month under the new month's name
- Where: VendorReport.js:105–112 (`handlePeriodChange` → `await loadData` → `setLoading(false)` unconditionally). PaymentReport.js:71–78 has the same shape.
- What happens: arrow the period `<select>` A → B. `loadData(A)` sees `isCurrent(A)` false and returns without setting anything. `handlePeriodChange(A)` then runs `setLoading(false)` while B is still loading. The page un-gates: KPI strip, tables, and on Vendor Report the loading-gated Export button. It shows the previous period's purchases under B's chip. An export in that window writes those figures under B's scope line and filename. This is the exact class S756 fixed on Variance, TheoreticalVariance, MonthlySummary and BudgetVsActual ("Superseded load clears loading"). SupplierContribution has the fix (`if (periodReq.isCurrent(periodId)) setLoading(false)`, :120). These two pages were not swept.
- Status: missed by S756
- Fix: `if (periodReq.isCurrent(periodId)) setLoading(false)` in both `handlePeriodChange`s (and in `init`).
- Confidence: Confirmed (code path; timing window)

### TAX-5 [P2] Payment Summary's Export Excel is not gated at all
- Where: src/modules/ims/reports/PaymentReport.js:212 — `<button className="btn btn-ghost" onClick={exportExcel}>Export Excel</button>`
- What happens: there is no `disabled`. After a failed read (`purchases = []`) it exports a Summary sheet of NPR 0 for every method under the period's scope line. During a period change it exports the old period's figures under the new period's label and filename. With `biz.error` it exports a blank company name. Every sibling was gated in S756 (2e list); Payment Summary was not on that list.
- Status: missed by S756
- Fix: `disabled={loading || !!loadError || !!biz.error || !selectedPeriod}`, plus the biz.error notice the siblings carry.
- Confidence: Confirmed

### TAX-6 [P2] One Lakh report: an admin switching client can land the previous client's suppliers on the new client's page and in its export
- Where: PurchaseOneLakhAboveReport.js:45–60 (periods effect) and :69–123 (`load`, deps `[effectiveClientId, selectedFy, periods, …]`), key `${effectiveClientId}:${selectedFy}`
- What happens: when the client changes, `load` is recreated and runs straight away with the NEW client id but the OLD `periods` and `selectedFy`. It reads `purchase_entries` via raw `supabase.from(...).in('period_id', oldClientPeriodIds)`, and the admin's RLS (`is_admin()`) returns those rows. When the new periods land with the same FY label (both clients are in the current FY), `load` runs again under the SAME key string, so `isCurrent` passes for both in-flight loads and whichever resolves LAST wins. Switching from a big client to a small one makes the stale read the slower one. The new client's page, letterhead and Excel then carry the old client's supplier totals, with no returns (those go through scopedFrom under the new id).
- Status: missed by S756 (S756 added the client to the key; the key does not separate the stale-periods run)
- Fix: clear `periods`/`selectedFy` when the client changes, or skip `load` until `periodsLoaded` for the current client (put the periods' client id into the key).
- Confidence: Plausible. The code path is confirmed; the race depends on timing. Confirm by switching client in the top bar from a large client to a small one while the page is open.

### TAX-7 [P2] Owner Report vendor section names a deactivated or archived supplier "Unknown Vendor" (and its outstanding bills "Unassigned"), frozen into the snapshot
- Where: src/modules/ownerReport/computeVendorPurchasingSection.js:39 (`scopedFrom('vendors', clientId, 'id, name').eq('is_active', true)`), :103, :135
- What happens: the vendor list is used only to resolve names for rows built from purchase lines. A supplier deactivated or archived (archive forces `is_active=false`) keeps its spend. At close, or on a later Regenerate Snapshot, its row is frozen as "Unknown Vendor" and its unpaid credit bills are listed as "Unassigned" — the word the product uses for bills with NO vendor. vendor-payables.md (S708) lists this file among the "live consumers that are correctly pickers". It is not a picker; it is a report's name map (the S708 rule itself).
- Status: missed by S756 (and the rules file mislabels it)
- Fix: drop `.eq('is_active', true)`. Correct the S708 list in vendor-payables.md.
- Confidence: Confirmed

### TAX-8 [P2] VAT Report: the Returns card and its "Net Input VAT" row render the previous month's figures while a new month loads
- Where: VatReport.js:520 (`{vatReturns.length > 0 && (` inside `!loadError && tab === 'entries'`, no `!loading`), net row :581–594
- What happens: `fetchData` does not clear `entries`/`returns`. While the next period loads, the Purchases card correctly shows "Loading…", but the Returns table and its Net Base / Net Input VAT / Net (incl. VAT) sit beneath it with the old month's figures under the new chip. It corrects itself when the load lands, and export is gated. This is the S616 positional rule ("gating the stat-grid is not gating the page").
- Status: missed by S756
- Fix: add `!loading &&` to the returns card.
- Confidence: Confirmed

### TAX-9 [P3] Workbook sheets an accountant reconciles have no TOTAL row
- Where: VatReport.js export — 'VAT Purchases' (:181), 'VAT Returns' (:249), 'CA Summary' (:269; the screen has a PERIOD NET row); NonVatReport.js — 'Non-VAT Entries' (:148), 'CA Summary' (:169); PaymentReport.js 'Daily Breakdown' (:183). The Payment Summary daily tab has no total on screen either.
- What happens: per-line VAT is rounded to 2 dp per row while the page's Net Input VAT is 13% of the unrounded sum. An accountant summing the column gets a figure a few paisa off the card, with no printed total to tie to. vendor-payables.md (S723/S725): "a TOTAL row on any sheet a reader is expected to reconcile". Only Bill-wise, 1L and Vendor Report have one.
- Status: missed by S756
- Fix: push a TOTAL row built from the split totals.
- Confidence: Confirmed

### TAX-10 [P3] Payment Summary's "% of Net Total" footer is hard-coded "100%"
- Where: PaymentReport.js:358. The rows use `grandNet > 0 ? … : 0`.
- What happens: in a month whose returns exceed purchases (`grandNet <= 0`), every row reads 0% above a Total of 100%. This is the S594/S719/S725 "hardcoded 100% footer" shape, fourth instance. PeriodScope also lacks `provisionalWhenOpen` here, unlike its siblings.
- Status: missed by S756
- Fix: compute it the way Vendor Report does (`foot.net / grandNet`).
- Confidence: Confirmed

### TAX-11 [P3] PAN is free text; D12 merges by PAN after removing whitespace only
- Where: Vendors.js:236/253 (`pan_vat_no: form.pan_vat_no.trim()`, no validation); purchaseTaxSplit.js:230 `normalisePan`
- What happens: "601-234-567", "PAN 601234567" and "601234567" are three suppliers on the Annexure 13 disclosure. Each is tested against NPR 1,00,000 separately, which is exactly the under-disclosure D12 exists to prevent. Nothing checks that a Nepal PAN is 9 digits.
- Status: missed by S756
- Fix: validate 9 digits on the Vendors form (warn, don't block) and normalise to digits only in `normalisePan`.
- Confidence: Confirmed (behaviour). Whether real data carries such variants is unverified.

### TAX-12 [P3] One Lakh report groups legacy bills (NULL purchase_group_id) across months as one bill
- Where: PurchaseOneLakhAboveReport.js:108 `allocateBillDiscounts(entries)` over 12 periods; supplierAttribution.js:36 fallback key `vendor|invoice|bs_day` (no period)
- What happens: two legacy bills from different months with the same vendor, day number and blank or same invoice merge. The discount is taken once (max) instead of per bill, and the bill count drops. `priorBillFactors` period-scopes that key for exactly this reason; the FY-wide caller does not.
- Status: missed by S756
- Fix: period-scope the fallback key for multi-period callers, as priorBillFactors does.
- Confidence: Plausible. It needs NULL purchase_group_id rows, and the column defaults to gen_random_uuid(). Confirm with a count of NULLs.

### TAX-13 [P3] fetchAllRows stops silently at 100,000 rows; the One Lakh report is the widest purchase read
- Where: src/shared/fetchAllRows.js:20 (`maxRows = 100000`, returns `error: null` at the cap); PurchaseOneLakhAboveReport.js:87
- What happens: a fiscal year of `purchase_entries` lines is 100 sequential pages at the cap. Past it the disclosure is silently short, the one failure the helper exists to prevent. That needs about 275 lines a day, so a large client only, but it is a statutory figure. Loading is also slow: up to 100 round trips.
- Status: missed by S756
- Fix: return an error (or a `truncated` flag) at maxRows; raise maxRows here.
- Confidence: Plausible (volume)

### KNOWN+ Owner Report vendor aging (known ⚪ item)
- computeVendorPurchasingSection.js:126–130 also nets no RETURNS (same-month or D10 late) and no DISCOUNT against `paid`. On a non-VAT credit bill with a discount, paid in full, the discount reads as an outstanding 1–30-day balance. Every returned bill likewise shows the return as unpaid. The `Math.max(0, …)` hides credits (S723). Same fix as the known item: value through `valueBillLines`.

## GAPs
- **Non-VAT-registered outlets.** `settings.is_vat_registered` is read nowhere in IMS. A PAN-only café is told by VAT Report that its "Net Input VAT (13%)" is "claimable… use this for your IRD VAT return" (VatReport.js:408). The "Net (ex-VAT) — Actual cost basis" card (:417) calls the ex-VAT figure the real expense, and every food-cost page values purchases ex-VAT. For an outlet that cannot reclaim VAT, the 13% it pays suppliers is real cost, so its food cost reads low.
- **No bill-level view on screen.** The D28 Bill-wise sheet (with the D13 "Matches Supplier Bill?" check) exists only in Excel. On screen the owner sees a count of mismatches and has to open Purchases to find each one.
- **The Bill-wise sheet carries only a day number** (the month is in the scope line). The IRD purchase book (खरिद खाता) is kept by full invoice date, so the accountant must rebuild dates by hand. That was a deliberate choice for the item sheets; for the purchase-book sheet it is worth revisiting.
- **The One Lakh report cannot drill down.** A flagged supplier cannot be opened to see the bills behind the total, which is the first thing an accountant asks before disclosing.
- **Payment Summary** has no daily TOTAL, no "provisional" chip, and no warning when Excel is off. It reads as the least-finished of the tax pages next to VAT/Non-VAT.

## Owner questions
1. **Outlets not registered for VAT (PAN only).** Such an outlet cannot claim back the 13% VAT it pays suppliers, so that VAT is part of what the food cost it. What should Crest do?
   (a) Keep things as they are: food cost ex-VAT everywhere, and the VAT Report says "claimable".
   (b) When Settings says "not VAT registered", change the VAT Report's wording to "VAT paid (not claimable)" and add a note on the food-cost pages. The figures stay the same.
   (c) (b), plus count supplier VAT inside food cost for those outlets.
   Recommendation: (b) now, and ask an accountant before (c). (c) changes every food-cost figure for those clients.
2. **Returns across fiscal years on the One Lakh report.** Goods bought in Ashadh and sent back in Shrawan fall in two different fiscal years. Which year's total should the return reduce?
   (a) The year the goods went back (today's behaviour, matching D10).
   (b) The year of the bill.
   Recommendation: (a), valued at the bill's discounted price (TAX-3), with the page saying so. It is the same accountant question D10 already flags for monthly VAT.

## Checked and fine
- splitPurchaseVat: the discount is apportioned per line across VAT and non-VAT lines before VAT. VAT = 13% × post-discount taxable, identical to calcBillTotals (`taxableBase × (1 − discount/subTotal)`). The two halves sum back to the bill (S722 holds).
- Returns: the VAT or non-VAT half follows the original line's `vat_inclusive` through the embed, in any month. Same-month returns are valued at their bill's discount factor, earlier-month returns via readPriorBillLines/priorBillFactors (VAT, Non-VAT, Payment, Vendor, Supplier Contribution, Owner Report). Unlinked returns are deducted from neither half and are named on screen and in the workbook (✅ S756 purchaseTaxSplit:42-43 holds).
- VatReport.js:297 ✅ still holds: on-screen per-line VAT uses `lineNet`, as the workbook does.
- D13: billWiseVat/billTotalsByKey compare against calcBillTotals' vatTotal/grandTotal with a NPR 1 tolerance; blank means not typed, never 0.
- D28: the Bill-wise sheet reconciles (Taxable = vatBase, Exempt = nonVatBase) and has a TOTAL row.
- D12: annexure13Rows merges cards by normalised PAN, keeps PAN-less cards apart, runs both threshold tests on the aggregate, and the flag is strictly > 1,00,000.
- 1L ✅ S756: letterhead and scope, no infinite Loading with no periods, `isCurrent` before any setter — all hold.
- Export gating on loading / loadError / biz.error holds on VAT, Non-VAT, 1L and Vendor Report (not Payment Summary, TAX-5). provisionalWhenOpen is present on VAT, Non-VAT, Vendor and 1L.
- Every purchase and return read in scope is fetchAllRows-paged with `.order('id')`. payable_payments and prior-bill lines are chunked. A failed prior-bill read fails the report on every reader rather than falling back to the list rate.
- Vendor Report: no `is_active` filter (S708 holds); `methodOf` fallback on purchases and returns; bills counted, not lines; footer computed rather than asserted; unassigned row has full columns; workbook money cells are numbers and carry a TOTAL (S725/S728 hold).
- Supplier Contribution / Vendor Report tie-out for late returns: both merge the same prior factors (mergeFactors, own wins). S758's choice-stock lines load under the same try/catch and throw on failure.
- PaymentReport: falls back to periods[0] (S722 holds); billPayables counts a bill once per method, with NULL read as Cash; returns carry VAT back only when the original line had VAT.
- Route guards: every tax page is `hasImsAccess('manager')` inside the component, matching `minImsRole: 'manager'` in Layout; ModuleGate outside PremiumGate in App.js.
