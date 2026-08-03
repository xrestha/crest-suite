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

function withinRange(date, start, end) {
  return date >= start && date <= end
}

// qty*rate (pre-VAT) of goods returned per purchase_entry_id. Pass `beforeDate` to only count
// returns dated before a cutoff (used for Opening Balance, which must not net a return that
// hasn't happened yet as of the fiscal year's start).
function sumReturnsByEntry(returns, beforeDate = null) {
  const map = {}
  returns.forEach(r => {
    if (beforeDate) {
      const p = r.monthly_periods
      const returnDate = bsToAd(p.bs_year, p.bs_month, r.bs_day || 1)
      if (!(returnDate < beforeDate)) return
    }
    map[r.purchase_entry_id] = (map[r.purchase_entry_id] || 0) + parseFloat(r.qty || 0) * parseFloat(r.rate || 0)
  })
  return map
}

function paymentsByEntryMap(payments) {
  const map = {}
  payments.forEach(p => { (map[p.purchase_entry_id] = map[p.purchase_entry_id] || []).push(p) })
  return map
}

function sumPayments(paymentsList, beforeDate) {
  return paymentsList.reduce((s, p) => (new Date(p.paid_at) < beforeDate ? s + parseFloat(p.amount) : s), 0)
}

// Groups purchase_entries rows (already joined to monthly_periods) into bills and computes each
// bill's VAT-correct grand total via calcBillTotals — same pattern as OutstandingPayables.js's
// load(), generalized to any payment_method so Cash/FonePay bills can appear in the schedule too.
// `returnedByEntry` decides which returns get netted into the total — the caller controls this so
// pre-FY bills (Opening Balance) and in-FY bills (the schedule) can apply different cutoffs.
function groupIntoBills(entries, returnedByEntry) {
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
        entryIds: [],
        lines: [],
      }
    }
    const netLine = Math.max(0, parseFloat(e.qty) * parseFloat(e.rate) - (returnedByEntry[e.id] || 0))
    byBill[key].entryIds.push(e.id)
    byBill[key].lines.push({
      netLine,
      vat_inclusive: e.vat_inclusive,
      discount_amount: e.discount_amount,
      purchase_group_id: e.purchase_group_id,
      id: e.id,
    })
  })
  return Object.values(byBill).map(bill => {
    const discountByGroup = {}
    bill.lines.forEach(l => { discountByGroup[l.purchase_group_id || l.id] = parseFloat(l.discount_amount || 0) })
    const billDiscount = Object.values(discountByGroup).reduce((s, d) => s + d, 0)
    const { grandTotal } = calcBillTotals(
      bill.lines.map(l => ({ qty: 1, rate: l.netLine, vat_inclusive: l.vat_inclusive })),
      billDiscount
    )
    return { ...bill, grandTotal }
  })
}

// Balance owed to this vendor as of the fiscal year's start date — the amount every Credit bill
// dated before fyStart still had outstanding once payments made before fyStart are subtracted.
// Cannot reuse OutstandingPayables.js's `remaining` field: that nets against ALL payments ever
// made (a live "today" snapshot), not a historical as-of-fyStart cutoff.
export function computeOpeningBalance(creditEntries, payments, returns, fyStart) {
  const preFyEntries = creditEntries.filter(e => billDateOf(e) < fyStart)
  if (preFyEntries.length === 0) return 0
  const returnedBeforeFy = sumReturnsByEntry(returns, fyStart)
  const bills = groupIntoBills(preFyEntries, returnedBeforeFy)
  const pmtMap = paymentsByEntryMap(payments)
  return bills.reduce((total, bill) => {
    const paidBeforeFy = bill.entryIds.reduce((s, id) => s + sumPayments(pmtMap[id] || [], fyStart), 0)
    return total + Math.max(0, bill.grandTotal - paidBeforeFy)
  }, 0)
}

// Chronological Dr/Cr ledger for the fiscal year: an opening-balance row, then every bill/payment/
// return dated within the FY, each carrying the running balance after it. Credit bills add to the
// balance; payments and returns-against-a-pre-FY-Credit-bill subtract. Cash/FonePay bills are
// listed (full-turnover visibility, per Annexure 13) but net to zero — they're simultaneously a
// purchase and an instant settlement.
export function buildFySchedule({ creditEntries, cashEntries, payments, returns, fyStart, fyEnd, openingBalance }) {
  const allReturnedByEntry = sumReturnsByEntry(returns) // unconditional — bakes into each FY bill's own total
  const inFyCredit = creditEntries.filter(e => withinRange(billDateOf(e), fyStart, fyEnd))
  const preFyCreditIds = new Set(
    creditEntries.filter(e => billDateOf(e) < fyStart).map(e => e.id)
  )

  const fyBills = groupIntoBills([...inFyCredit, ...cashEntries], allReturnedByEntry)

  const events = [{ type: 'opening', date: fyStart, amount: openingBalance }]

  fyBills.forEach(bill => {
    events.push({ type: 'bill', date: bill.billDate, ref: bill.invoiceRef, method: bill.paymentMethod, amount: bill.grandTotal, billKey: bill.billKey })
  })

  // Payments during the FY against ANY Credit bill (whether the bill itself is pre-FY or in-FY)
  // always reduce what's owed.
  payments.forEach(p => {
    const d = new Date(p.paid_at)
    if (withinRange(d, fyStart, fyEnd)) {
      events.push({ type: 'payment', date: d, ref: p.note || '', amount: parseFloat(p.amount), purchaseEntryId: p.purchase_entry_id })
    }
  })

  // Returns during the FY against a PRE-FY Credit bill: not netted into Opening Balance (which
  // only counts returns dated before fyStart) and the bill itself isn't in this FY's schedule to
  // net it into — so it needs its own ledger line. Returns against an in-FY bill are already
  // baked into that bill's grandTotal above and must NOT also appear here (double-count).
  returns.forEach(r => {
    if (!preFyCreditIds.has(r.purchase_entry_id)) return
    const p = r.monthly_periods
    const d = bsToAd(p.bs_year, p.bs_month, r.bs_day || 1)
    if (withinRange(d, fyStart, fyEnd)) {
      events.push({ type: 'return', date: d, amount: parseFloat(r.qty || 0) * parseFloat(r.rate || 0), purchaseEntryId: r.purchase_entry_id })
    }
  })

  events.sort((a, b) => a.date - b.date)

  let balance = openingBalance
  const schedule = events.map(e => {
    if (e.type === 'bill' && e.method === 'Credit') balance += e.amount
    if (e.type === 'payment') balance -= e.amount
    if (e.type === 'return') balance -= e.amount
    return { ...e, runningBalance: balance }
  })
  const closingBalance = balance

  const totalPurchasesFy = fyBills.reduce((s, b) => s + b.grandTotal, 0)
  const totalPaymentsFy = events.filter(e => e.type === 'payment').reduce((s, e) => s + e.amount, 0)
    + fyBills.filter(b => b.paymentMethod !== 'Credit').reduce((s, b) => s + b.grandTotal, 0)
  const totalReturnsFy = returns.reduce((s, r) => {
    const p = r.monthly_periods
    const d = bsToAd(p.bs_year, p.bs_month, r.bs_day || 1)
    return withinRange(d, fyStart, fyEnd) ? s + parseFloat(r.qty || 0) * parseFloat(r.rate || 0) : s
  }, 0)

  if (process.env.NODE_ENV !== 'production') {
    // Independent reconciliation check: opening + this-FY Credit purchases − this-FY payments −
    // this-FY returns-against-pre-FY-bills should equal the walk's own closing figure. Catches a
    // stray filter/typo in the walk above without relying on the walk to grade itself.
    const creditBillSum = fyBills.filter(b => b.paymentMethod === 'Credit').reduce((s, b) => s + b.grandTotal, 0)
    const paymentSum = events.filter(e => e.type === 'payment').reduce((s, e) => s + e.amount, 0)
    const returnSum = events.filter(e => e.type === 'return').reduce((s, e) => s + e.amount, 0)
    const expected = openingBalance + creditBillSum - paymentSum - returnSum
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
