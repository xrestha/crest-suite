// Pure computation for the Vendor Balance Confirmation report — no React, no Supabase calls, so
// the opening-balance/running-balance math can be reasoned about and eyeballed in isolation from
// data fetching. Callers (VendorBalanceConfirmation.js) fetch the raw rows and pass them in.
//
// Feeds Nepal IRD Annexure 13 (अनुसूची १३) disclosure — Opening/Purchases/Payments/Closing balance
// per vendor for a fiscal year — and doubles as NSA 17 (External Confirmations) audit evidence.
import { bsToAd, daysInBsMonth } from '../../../utils/bsCalendar'
import { calcBillTotals, billKeyOf } from '../purchases/purchasesHelpers'

// AD start/end of the BS fiscal year that begins in `fyStartYear` (Shrawan 1 -> last day of the
// following year's Ashadh). `end` is pushed to end-of-day so same-day comparisons against dates
// derived from `paid_at`/bs_day conversions (which land at midnight) don't fall just outside it.
export function getFiscalYearAdRange(fyStartYear) {
  const start = bsToAd(fyStartYear, 4, 1)
  const end = bsToAd(fyStartYear + 1, 3, daysInBsMonth(fyStartYear + 1, 3))
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

function billDateOf(e) {
  const p = e.monthly_periods
  return bsToAd(p.bs_year, p.bs_month, e.bs_day || 1)
}

function returnDateOf(r) {
  const p = r.monthly_periods
  return bsToAd(p.bs_year, p.bs_month, r.bs_day || 1)
}

function withinRange(date, start, end) {
  return date >= start && date <= end
}

function paymentsByEntryMap(payments) {
  const map = {}
  payments.forEach(p => { (map[p.purchase_entry_id] = map[p.purchase_entry_id] || []).push(p) })
  return map
}

function sumPayments(paymentsList, beforeDate) {
  return paymentsList.reduce((s, p) => (new Date(p.paid_at) < beforeDate ? s + parseFloat(p.amount) : s), 0)
}

// Groups purchase_entries rows (already joined to monthly_periods) into bills, keeping each
// line's RAW qty/rate — deliberately not netting returns here. Returns get their own ledger line
// with their own VAT/discount-adjusted value (see walkBillReturns below) instead of being baked
// invisibly into the bill's total, which used to hide the return from the printed schedule
// entirely and made the headline "Purchases − Payments/Returns" arithmetic not actually add up
// (Purchases was silently already net-of-return, so subtracting the return again double-counted
// it in the displayed formula even though the final balance itself was computed correctly).
function groupRawBills(entries) {
  const byBill = {}
  entries.forEach(e => {
    const period = e.monthly_periods
    const key = billKeyOf(e, period)
    if (!byBill[key]) {
      byBill[key] = {
        billKey: key,
        vendorId: e.vendor_id,
        paymentMethod: e.payment_method,
        invoiceRef: e.invoice_ref,
        billDate: billDateOf(e),
        lines: [],
      }
    }
    byBill[key].lines.push({
      id: e.id,
      qty: parseFloat(e.qty) || 0,
      rate: parseFloat(e.rate) || 0,
      vat_inclusive: e.vat_inclusive,
      discount_amount: e.discount_amount,
      purchase_group_id: e.purchase_group_id,
    })
  })
  return Object.values(byBill)
}

// discount_amount is stored on every line of a bill but represents ONE bill-level discount —
// deduped per purchase_group_id before summing, same convention as VendorReport.js.
function billDiscountOf(lines) {
  const discountByGroup = {}
  lines.forEach(l => { discountByGroup[l.purchase_group_id || l.id] = parseFloat(l.discount_amount || 0) })
  return Object.values(discountByGroup).reduce((s, d) => s + d, 0)
}

// VAT-correct grand total for a bill's lines via calcBillTotals. `netByEntry` (optional) nets a
// qty*rate return amount out of each line first — omit it (or pass an empty map) for the bill's
// GROSS total as originally billed. Rounded to currency precision (2dp) immediately: this report
// fetches a bill's lines with no guaranteed order, and floating-point addition isn't associative —
// summing the same line amounts in a different order than another page's own independent
// calcBillTotals call (e.g. Outstanding Payables', which drives what a user actually types into
// "Pay in full") can differ by a paisa or two. Found live: a bill paid in full via that exact
// amount still showed a phantom NPR 0.01 balance here. Rounding here (rather than only at display
// time via fmt()) means the running-balance walk itself operates on clean currency amounts, so a
// fully-settled bill nets to exactly 0.00 instead of carrying sub-paisa float noise forward.
function billGrandTotal(lines, netByEntry) {
  const discount = billDiscountOf(lines)
  const calcLines = lines.map(l => ({
    qty: 1,
    rate: Math.max(0, l.qty * l.rate - (netByEntry?.[l.id] || 0)),
    vat_inclusive: l.vat_inclusive,
  }))
  return Math.round(calcBillTotals(calcLines, discount).grandTotal * 100) / 100
}

// Walks a bill's returns in date order, computing each one's own VAT/discount-adjusted impact —
// NOT a flat qty*rate figure, since VAT recalculates on the shrinking post-return base each time.
// Returns an array of { returnRow, date, effectiveValue }, one per return, in chronological order.
// Starting from the bill's GROSS total means the returned array's effectiveValues always sum to
// exactly (grossTotal − finalNetTotal), so "Purchase" (gross) and "Return" (effective) lines shown
// separately in a ledger always reconcile to the same net figure a single netted line would have.
function walkBillReturns(bill, billReturns) {
  const sorted = [...billReturns].sort((a, b) => returnDateOf(a) - returnDateOf(b))
  const returnedSoFar = {}
  let runningTotal = billGrandTotal(bill.lines, null)
  return sorted.map(r => {
    returnedSoFar[r.purchase_entry_id] = (returnedSoFar[r.purchase_entry_id] || 0) + parseFloat(r.qty || 0) * parseFloat(r.rate || 0)
    const newTotal = billGrandTotal(bill.lines, returnedSoFar)
    const effectiveValue = runningTotal - newTotal
    runningTotal = newTotal
    return { returnRow: r, date: returnDateOf(r), effectiveValue }
  })
}

// Balance owed to this vendor as of the fiscal year's start date — the amount every Credit bill
// dated before fyStart still had outstanding once payments made before fyStart are subtracted.
// Cannot reuse OutstandingPayables.js's `remaining` field: that nets against ALL payments ever
// made (a live "today" snapshot), not a historical as-of-fyStart cutoff. This is a single carried-
// forward lump sum (no separate display), so returns before the cutoff are netted directly here —
// unlike the FY schedule itself, there's no "Balance b/f" breakdown to preserve.
export function computeOpeningBalance(creditEntries, payments, returns, fyStart) {
  const preFyEntries = creditEntries.filter(e => billDateOf(e) < fyStart)
  if (preFyEntries.length === 0) return 0
  const bills = groupRawBills(preFyEntries)
  const pmtMap = paymentsByEntryMap(payments)
  return bills.reduce((total, bill) => {
    const billEntryIds = new Set(bill.lines.map(l => l.id))
    const billReturns = returns.filter(r => billEntryIds.has(r.purchase_entry_id) && returnDateOf(r) < fyStart)
    const returnedBeforeFy = {}
    billReturns.forEach(r => { returnedBeforeFy[r.purchase_entry_id] = (returnedBeforeFy[r.purchase_entry_id] || 0) + parseFloat(r.qty || 0) * parseFloat(r.rate || 0) })
    const grandTotal = billGrandTotal(bill.lines, returnedBeforeFy)
    const paidBeforeFy = bill.lines.reduce((s, l) => s + sumPayments(pmtMap[l.id] || [], fyStart), 0)
    return total + Math.max(0, grandTotal - paidBeforeFy)
  }, 0)
}

// Chronological Dr/Cr ledger for the fiscal year: an opening-balance row, then every bill/payment/
// return dated within the FY, each carrying the running balance after it. Credit bills add to the
// balance; payments and returns-against-a-Credit-bill subtract. Cash/FonePay bills (and any return
// against one) are listed for full-turnover visibility per Annexure 13, but never touch the
// running balance — they're simultaneously a purchase and an instant settlement.
export function buildFySchedule({ creditEntries, cashEntries, payments, returns, fyStart, fyEnd, openingBalance }) {
  const inFyCredit = creditEntries.filter(e => withinRange(billDateOf(e), fyStart, fyEnd))
  const preFyCredit = creditEntries.filter(e => billDateOf(e) < fyStart)

  const rawInFyBills = groupRawBills([...inFyCredit, ...cashEntries])
  const rawPreFyBills = groupRawBills(preFyCredit) // lookup only — never shown as a 'bill' event; needed to correctly compute a return posted this FY against a bill from before it

  const billByEntryId = {}
  rawInFyBills.forEach(bill => bill.lines.forEach(l => { billByEntryId[l.id] = bill }))

  const events = [{ type: 'opening', date: fyStart, amount: openingBalance }]

  // Bill events at GROSS value — any return against it prints as its own line below, rather than
  // silently pre-netting it into a single figure that hides the return from the visible ledger.
  rawInFyBills.forEach(bill => {
    const grossGrandTotal = billGrandTotal(bill.lines, null)
    events.push({ type: 'bill', date: bill.billDate, ref: bill.invoiceRef, method: bill.paymentMethod, amount: grossGrandTotal, billKey: bill.billKey })
  })

  // Payments allocate per LINE, not per bill (see CLAUDE.md's payable_payments note) — settling a
  // multi-line bill in one action writes one payable_payments row per line, all sharing the same
  // paid_at/note/payment_mode. Grouped back into one ledger line per (bill, date, note,
  // payment_mode) so the letter shows what actually happened — one settlement — rather than an
  // internal allocation detail the vendor has no reason to see; payment_mode is folded into the
  // group key alongside note so rows genuinely paid differently (e.g. split Cash + Cheque on the
  // same day) still show as separate lines instead of silently merging. Payments during the FY
  // against ANY Credit bill (whether the bill itself is pre-FY or in-FY) always reduce what's owed.
  const invoiceRefByEntryId = {}
  creditEntries.forEach(e => { invoiceRefByEntryId[e.id] = e.invoice_ref })

  const paymentGroups = {}
  payments.forEach(p => {
    const d = new Date(p.paid_at)
    if (!withinRange(d, fyStart, fyEnd)) return
    const bill = billByEntryId[p.purchase_entry_id] || rawPreFyBills.find(b => b.lines.some(l => l.id === p.purchase_entry_id))
    const billKey = bill?.billKey || p.purchase_entry_id
    const groupKey = `${billKey}|${p.paid_at}|${p.note || ''}|${p.payment_mode || ''}`
    if (!paymentGroups[groupKey]) {
      paymentGroups[groupKey] = { date: d, amount: 0, purchaseEntryId: p.purchase_entry_id, note: p.note || null, paymentMode: p.payment_mode || null }
    }
    paymentGroups[groupKey].amount += parseFloat(p.amount)
  })
  Object.values(paymentGroups).forEach(g => {
    events.push({ type: 'payment', date: g.date, ref: invoiceRefByEntryId[g.purchaseEntryId] || null, note: g.note, paymentMode: g.paymentMode, amount: g.amount, purchaseEntryId: g.purchaseEntryId })
  })

  // Returns: walk EVERY touched bill's own returns from its gross total, chronologically, so each
  // return's ledger amount is that specific return's true VAT/discount-adjusted impact. For a
  // pre-FY bill, the walk still processes returns dated before fyStart (needed to reach the
  // correct starting balance for one landing inside the FY) but only emits events for the ones
  // actually dated within [fyStart, fyEnd] — anything earlier is already folded into Opening
  // Balance.
  const allBillsToWalk = [...rawInFyBills, ...rawPreFyBills]
  allBillsToWalk.forEach(bill => {
    const billEntryIds = new Set(bill.lines.map(l => l.id))
    const billReturns = returns.filter(r => billEntryIds.has(r.purchase_entry_id))
    if (billReturns.length === 0) return
    walkBillReturns(bill, billReturns).forEach(({ returnRow, date, effectiveValue }) => {
      if (!withinRange(date, fyStart, fyEnd)) return
      events.push({ type: 'return', date, ref: bill.invoiceRef, method: bill.paymentMethod, amount: effectiveValue, purchaseEntryId: returnRow.purchase_entry_id })
    })
  })

  events.sort((a, b) => a.date - b.date)

  let balance = openingBalance
  const schedule = events.map(e => {
    if (e.type === 'bill' && e.method === 'Credit') balance += e.amount
    if (e.type === 'payment') balance -= e.amount
    if (e.type === 'return' && e.method === 'Credit') balance -= e.amount
    return { ...e, runningBalance: balance }
  })
  const closingBalance = balance

  // Purchases/Returns are both GROSS-basis now, so "Opening + Purchases − Payments/Returns" in the
  // printed letter actually reconciles to the shown Closing Balance — previously Purchases was
  // silently net-of-return already, so subtracting the return again double-counted it on screen.
  const totalPurchasesFy = rawInFyBills.reduce((s, b) => s + billGrandTotal(b.lines, null), 0)
  const totalReturnsFy = schedule.filter(e => e.type === 'return').reduce((s, e) => s + e.amount, 0)
  const totalPaymentsFy = schedule.filter(e => e.type === 'payment').reduce((s, e) => s + e.amount, 0)
    + rawInFyBills.filter(b => b.paymentMethod !== 'Credit').reduce((s, b) => {
      const billEntryIds = new Set(b.lines.map(l => l.id))
      const netByEntry = {}
      returns.filter(r => billEntryIds.has(r.purchase_entry_id)).forEach(r => {
        netByEntry[r.purchase_entry_id] = (netByEntry[r.purchase_entry_id] || 0) + parseFloat(r.qty || 0) * parseFloat(r.rate || 0)
      })
      return s + billGrandTotal(b.lines, netByEntry) // net settlement — what actually left the register after its own return(s)
    }, 0)

  if (process.env.NODE_ENV !== 'production') {
    // Independent reconciliation check: opening + this-FY Credit bill (gross) totals − this-FY
    // payments − this-FY Credit-bill returns should equal the walk's own closing figure. Catches a
    // stray filter/typo in the walk above without relying on the walk to grade itself.
    const creditBillSum = rawInFyBills.filter(b => b.paymentMethod === 'Credit').reduce((s, b) => s + billGrandTotal(b.lines, null), 0)
    const paymentSum = schedule.filter(e => e.type === 'payment').reduce((s, e) => s + e.amount, 0)
    const creditReturnSum = schedule.filter(e => e.type === 'return' && e.method === 'Credit').reduce((s, e) => s + e.amount, 0)
    const expected = openingBalance + creditBillSum - paymentSum - creditReturnSum
    console.assert(Math.abs(expected - closingBalance) < 0.01,
      'Vendor Balance Confirmation: closing balance reconciliation mismatch', { expected, closingBalance })
  }

  return { schedule, closingBalance, totals: { totalPurchasesFy, totalPaymentsFy, totalReturnsFy } }
}

// Top-level orchestrator the page component calls once all rows are fetched.
export function computeVendorBalance({ creditEntries, cashEntries, payments, returns, fyStart, fyEnd }) {
  const openingBalance = computeOpeningBalance(creditEntries, payments, returns, fyStart)
  const { schedule, closingBalance, totals } = buildFySchedule({
    creditEntries, cashEntries, payments, returns, fyStart, fyEnd, openingBalance,
  })
  return { openingBalance, schedule, closingBalance, totals }
}
