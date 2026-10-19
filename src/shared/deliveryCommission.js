// Delivery-partner commission for one BS month: what Foodmandu, Pathao or another delivery partner
// kept from the bills sold that month, as recorded when the outlet took the partner's payment in
// Customers → Credit (S849, PNL-1, SU3 (a)).
//
// ONE rule, three readers: the Profit & Loss (its own cost line), the Owner Dashboard and the Monthly
// Owner Report (both subtract `amount` from Net Margin, naming `unsettledBills`). get_group_pnl holds
// the same rule in SQL (its `delivery_commission` / `delivery_unsettled` columns, mig S849 §2): change
// one, change the other.
//
// The month is the month the bill was SOLD (its Nepal day: the month its revenue posts to), never the
// month the partner paid. So a closed month's figure moves when one of its bills is settled later, and
// the callers say so while `unsettledBills` is above 0.
//
// The base is "what the partner kept, as recorded at settlement" (POS records it on the ex-VAT base,
// pos-billing.md S596). This helper never recomputes it.
//
// Per bill: if it has ANY receipt line (settled through Credit since S843), the commission is the sum
// of `commission` over its lines whose receipt is not cancelled; a bill whose receipts were all
// cancelled therefore counts 0. A bill with no receipt line (settled before S843, or never settled)
// falls back to `pos_orders.commission_amount`. Since S843 both receipt functions also rewrite
// `commission_amount`, but this reads the lines explicitly so it does not depend on that copy.
import { fetchAllRows } from './fetchAllRows'
import { bsDayBoundaryIso } from '../utils/bsCalendar'

export const DELIVERY_COMMISSION_SELECT =
  'id, closed_at, credit_settled_at, credit_note_id, commission_amount, ' +
  'pos_credit_receipt_lines(commission, pos_credit_receipts(cancelled_at))'

const toPaisa = v => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

// A receipt line embeds its receipt as an object (many-to-one); tolerate an array too, so a
// PostgREST shape change cannot silently count a cancelled receipt.
function receiptCancelled(line) {
  const r = line?.pos_credit_receipts
  const one = Array.isArray(r) ? r[0] : r
  return one?.cancelled_at != null
}

/** Pure: the bills read by loadDeliveryCommission → { amount, unsettledBills }. */
export function deliveryCommissionFromBills(bills) {
  let paisa = 0
  let unsettledBills = 0
  for (const bill of bills || []) {
    if (!bill) continue
    const lines = Array.isArray(bill.pos_credit_receipt_lines) ? bill.pos_credit_receipt_lines : []
    if (lines.length > 0) {
      for (const line of lines) {
        if (!receiptCancelled(line)) paisa += toPaisa(line.commission)
      }
    } else {
      paisa += toPaisa(bill.commission_amount)
    }
    // A part-paid bill is still unsettled (the commission kept on it so far is already counted). A
    // bill closed by a credit note is not waiting for the partner.
    if (bill.credit_settled_at == null && bill.credit_note_id == null) unsettledBills += 1
  }
  return { amount: paisa / 100, unsettledBills }
}

/** The BS month as a [start, end) Nepal-time window: start of day 1, start of the next month's day 1. */
export function bsMonthWindow(bsYear, bsMonth) {
  const y = Number(bsYear)
  const m = Number(bsMonth)
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return { startIso: null, endIso: null }
  const nextY = m === 12 ? y + 1 : y
  const nextM = m === 12 ? 1 : m + 1
  return {
    startIso: bsDayBoundaryIso(y, m, 1, false),
    endIso: bsDayBoundaryIso(nextY, nextM, 1, false),
  }
}

/**
 * The read. `db` is what useScopedDb() returns ({ scopedFrom, … }). Never throws.
 *
 * Call it only for a POS client: pass `posEnabled: false` and an IMS-only client gets
 * { amount: 0, unsettledBills: 0 } without a read. An outlet with delivery bills but no partner
 * commission, or no delivery bills at all, gets 0 (not an error).
 *
 * On a failed read: { amount: null, unsettledBills: null, error }. A failed read is NOT "no
 * commission": the caller refuses the figure (the P&L through firstError → ReportLoadError).
 * The caller wraps its batch in withTimeout().
 */
export async function loadDeliveryCommission(db, { startIso, endIso, posEnabled } = {}) {
  if (posEnabled === false) return { amount: 0, unsettledBills: 0, error: null }
  if (!db || typeof db.scopedFrom !== 'function' || !startIso || !endIso) {
    return {
      amount: null,
      unsettledBills: null,
      error: { message: 'Delivery commission could not be read: no outlet or no month was given.' },
    }
  }
  try {
    const { data, error } = await fetchAllRows(() => db.scopedFrom('pos_orders', DELIVERY_COMMISSION_SELECT)
      .not('delivery_partner', 'is', null)
      .eq('status', 'billed')
      .eq('close_type', 'paid')
      .gte('closed_at', startIso)
      .lt('closed_at', endIso)
      .order('closed_at')
      .order('id'))
    if (error) return { amount: null, unsettledBills: null, error }
    const { amount, unsettledBills } = deliveryCommissionFromBills(data)
    return { amount, unsettledBills, error: null }
  } catch (e) {
    return { amount: null, unsettledBills: null, error: { message: e?.message || String(e) } }
  }
}
