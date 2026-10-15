// What a Credit bill still owes, once customers can pay it off in parts (S843).
//
// A bill is paid by receipts now, one or several, each split over the bills it covers
// (pos_credit_receipt_lines). A bill is stamped credit_settled_* only when its receipts reach its
// total, so a part-paid bill is still "unsettled" while owing less than its paid_amount. Anything
// that shows what is owed must therefore take the receipts off, or a part-paid bill reads as owing
// the whole of it.
//
// The database's one definition is pos_credit_open_bills() (migration 20261015120000):
//   owed = round(paid_amount − Σ amount − Σ commission, 2), over the lines of receipts NOT cancelled,
//   for a paid, billed Credit bill with no settlement and no credit note.
// This is its browser copy, for two reasons: a report reads the bills of a date range (which that
// function, a list of every open bill, does not answer), and the function scopes itself by
// my_client_id(), which is not the outlet Crest support is viewing. creditOwed.test.js holds the two
// copies together; change both in one commit.
import { fetchAllRowsChunked } from '../../shared/fetchAllRows'

// The receipt each line belongs to rides along (an inner embed: a line is always read with its
// receipt), so a cancelled one can be left out here rather than by a second read.
export const RECEIPT_LINE_COLUMNS = 'order_id, amount, commission, pos_credit_receipts!inner(method, cancelled_at)'

const round2 = n => Math.round(n * 100) / 100

/**
 * The receipt lines of these bills, every one (a bill can have many, and the ids travel in the URL),
 * cancelled receipts included: `receiptTotalsByBill` leaves those out. Resolves `{ data, error }`.
 */
export function readReceiptLines(scopedFrom, orderIds) {
  return fetchAllRowsChunked(orderIds || [], ids =>
    scopedFrom('pos_credit_receipt_lines', RECEIPT_LINE_COLUMNS).in('order_id', ids).order('id'))
}

/**
 * Per bill, over the lines of receipts not cancelled: what was received, the commission a delivery
 * partner kept, and the part received in cash. `{ [order_id]: { received, commission, cash } }`.
 */
export function receiptTotalsByBill(lines) {
  const by = {}
  for (const l of lines || []) {
    const r = l.pos_credit_receipts
    // A cancelled payment put the bill back to owing it (cancel_credit_receipt).
    if (!r || r.cancelled_at) continue
    const t = by[l.order_id] = by[l.order_id] || { received: 0, commission: 0, cash: 0 }
    const amount = Number(l.amount) || 0
    t.received += amount
    t.commission += Number(l.commission) || 0
    if (r.method === 'Cash') t.cash += amount
  }
  for (const t of Object.values(by)) {
    t.received = round2(t.received)
    t.commission = round2(t.commission)
    t.cash = round2(t.cash)
  }
  return by
}

/** What one unsettled, uncredited Credit bill still owes: pos_credit_open_bills' `owed`. */
export function owedOn(paidAmount, totals) {
  return round2((Number(paidAmount) || 0) - (totals?.received || 0) - (totals?.commission || 0))
}

/** True when some of the bill has been paid (or kept as commission) and some is still owed. */
export function isPartPaid(paidAmount, totals) {
  const cleared = (totals?.received || 0) + (totals?.commission || 0)
  return cleared > 0 && owedOn(paidAmount, totals) > 0.005
}

/**
 * How a settled bill was paid, in words. 'Mixed' is a bill its receipts paid off by more than one
 * method (S843); every other value is the method itself.
 */
export function settledMethodLabel(method) {
  if (!method) return '—'
  return method === 'Mixed' ? 'Mixed (several payments)' : method
}
