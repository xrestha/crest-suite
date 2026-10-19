// What is still owed on this month's credit bills, valued the way Outstanding Payables values them
// (S849, OWNER-REPORT-8). Pure: no React, no Supabase.
//
// The frozen report's "Unpaid Credit (this period)" and the vendor section's bill aging compared what
// was PAID against a raw qty × rate per line. But a payment is made against the bill as invoiced:
// VAT added, the bill discount taken off, and any goods sent back credited (D33). So a 40,000 bill
// with a 2,000 discount, paid its 38,000 in full, froze 2,000 "unpaid"; a VAT bill of 40,000
// (45,200 with VAT) paid half, 22,600, froze 17,400 instead of 22,600; and a bill settled net of a
// return still owed the returned goods. It also counted unpaid LINES, under a column that said bills.
//
// Each bill here is valued by `billOwedAfterReturns` (payablesAllocation.js), the one answer
// Outstanding Payables, the balance letter and Vendor Report share; its payments are every
// payable_payments row on its lines, and its returns every vendor_returns row against its lines from
// any month (a return made after the month still reduces what is owed on the month's bill, as on
// Outstanding Payables).
import { allocationBillKey } from '../ims/reports/supplierAttribution'
import { billOwedAfterReturns, EPS } from '../ims/reports/payablesAllocation'

const round2 = n => Math.round((Number(n) || 0) * 100) / 100

/** `{ [purchase_entry_id]: Σ amount }` from payable_payments rows. */
export function paidByEntryOf(payments) {
  const out = {}
  for (const p of payments || []) {
    if (!p?.purchase_entry_id) continue
    out[p.purchase_entry_id] = (out[p.purchase_entry_id] || 0) + (parseFloat(p.amount) || 0)
  }
  return out
}

/** `{ [purchase_entry_id]: Σ qty × rate }` from vendor_returns rows (the line's list value, as on Outstanding Payables). */
export function returnedByEntryOf(returns) {
  const out = {}
  for (const r of returns || []) {
    if (!r?.purchase_entry_id) continue
    out[r.purchase_entry_id] = (out[r.purchase_entry_id] || 0) + (parseFloat(r.qty) || 0) * (parseFloat(r.rate) || 0)
  }
  return out
}

/**
 * One row per Credit bill among `lines` (this month's purchase lines; each bill's lines are all in
 * the month, as bills are per period). Lines need `id, qty, rate, vat_inclusive, discount_amount,
 * payment_method` and the bill-key columns (`purchase_group_id`, `vendor_id`, `invoice_ref`, `bs_day`).
 *
 * @returns {Array<{ key: string, firstLine: object, owed: number, paid: number, remaining: number }>}
 *   `remaining` is owed − paid, rounded to the paisa; below zero when the bill was over-paid (a
 *   return after payment: the supplier owes the outlet), which is not "unpaid".
 */
export function unpaidCreditBills({ lines, returnedByEntry = {}, paidByEntry = {} }) {
  const bills = new Map()
  for (const l of lines || []) {
    if (l?.payment_method !== 'Credit') continue
    const key = allocationBillKey(l)
    if (!bills.has(key)) bills.set(key, [])
    bills.get(key).push(l)
  }
  const out = []
  for (const [key, billLines] of bills) {
    // discount_amount is the bill's one discount repeated on every line: the max, never a sum.
    const discount = Math.max(0, ...billLines.map(l => parseFloat(l.discount_amount) || 0))
    const owed = round2(billOwedAfterReturns(billLines, returnedByEntry, discount))
    const paid = round2(billLines.reduce((s, l) => s + (paidByEntry[l.id] || 0), 0))
    out.push({ key, firstLine: billLines[0], owed, paid, remaining: round2(owed - paid) })
  }
  return out
}

/** The total still owed and how many BILLS owe it (over-paid bills are not unpaid). */
export function unpaidCreditTotals(bills) {
  let unpaidTotal = 0
  let unpaidCount = 0
  for (const b of bills || []) {
    if (b.remaining > EPS) { unpaidTotal += b.remaining; unpaidCount += 1 }
  }
  return { unpaidTotal: round2(unpaidTotal), unpaidCount }
}
