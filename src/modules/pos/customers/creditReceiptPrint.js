import { settleWithin } from '../../../utils/withTimeout'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { COPY_LABEL } from '../orders/posOrdersConstants'
import { owedAfterReceipt, receiptBalances, toPaisa, fromPaisa } from './creditLedger'
import { buildReceiptHtml, writeAndPrint, closeQuietly } from './creditReceiptHtml'
import { SETTLE_READ_MS } from './settleCredit'

// Printing a money receipt, first time and every reprint alike (S843). Both print from what the server
// STORED, never from the page's own figures: the receipt row, how it was split over the bills, each
// bill's total, every other receipt on those bills (for what each still owed straight after this one)
// and the party's account history (for the balance either side of it). So a reprint a month later says
// what the original said, with COPY on it.
//
// Every read is bounded, and any read failing prints nothing: a receipt with a wrong balance or a
// missing bill is wrong, not partial (the bill reprint's rule, billReprintData.js).

/** A list read (the party's history and receipts grow without end) waits this long. */
export const RECEIPT_LIST_MS = 20000

/**
 * Everything a receipt prints, read from the server. `db` is the page's reads:
 *   receipt(id)            the pos_credit_receipts row
 *   receiptLines(id)       its lines (order_id, amount, commission)
 *   partyEvents(key)       a fresh pos_credit_party_events builder (paged)
 *   partyReceipts(key)     a fresh builder over the party's receipts: id, received_at, cancelled_at (paged)
 *   billsByIds(ids)        the bills, for their number, date and total (chunked)
 *   linesByOrders(ids)     every receipt line on those bills (chunked)
 * `label(bill)` names a bill as it was printed. Returns { data: { receipt, bills, previousBalance,
 * newBalance }, error }.
 */
export async function readReceiptForPrint({ db, receiptId, partyKey, label, ms = SETTLE_READ_MS, listMs = RECEIPT_LIST_MS }) {
  const wave1 = await Promise.all([
    settleWithin(db.receipt(receiptId), ms, 'Reading the receipt'),
    settleWithin(db.receiptLines(receiptId), ms, "Reading the receipt's bills"),
    settleWithin(fetchAllRows(() => db.partyEvents(partyKey)), listMs, "Reading the customer's account"),
    settleWithin(fetchAllRows(() => db.partyReceipts(partyKey)), listMs, "Reading the customer's receipts"),
  ])
  const err1 = firstErrorObject(wave1)
  if (err1) return { data: null, error: err1 }
  const [{ data: receipt }, { data: ownLines }, { data: events }, { data: partyReceipts }] = wave1
  if (!receipt) return { data: null, error: { message: 'pos_credit_receipts: that receipt was not found on this outlet' } }
  const orderIds = (ownLines || []).map(l => l.order_id)
  const wave2 = await Promise.all([
    settleWithin(fetchAllRowsChunked(orderIds, ids => db.billsByIds(ids)), listMs, 'Reading the bills'),
    settleWithin(fetchAllRowsChunked(orderIds, ids => db.linesByOrders(ids)), listMs, "Reading the bills' payments"),
  ])
  const err2 = firstErrorObject(wave2)
  if (err2) return { data: null, error: err2 }
  const [{ data: billRows }, { data: allLines }] = wave2
  const billById = new Map((billRows || []).map(b => [b.id, b]))
  const receiptsById = Object.fromEntries((partyReceipts || []).map(r => [r.id, r]))
  const linesByOrder = new Map()
  for (const l of allLines || []) {
    if (!linesByOrder.has(l.order_id)) linesByOrder.set(l.order_id, [])
    linesByOrder.get(l.order_id).push(l)
  }
  const missing = orderIds.filter(id => !billById.has(id))
  if (missing.length) return { data: null, error: { message: `pos_orders: ${missing.length} of the receipt's bills could not be read` } }

  let cleared = 0
  const bills = (ownLines || []).map(l => {
    const bill = billById.get(l.order_id)
    cleared += toPaisa(l.amount) + toPaisa(l.commission)
    return {
      orderId: l.order_id, label: label(bill), closedAt: bill.closed_at,
      amount: Number(l.amount) || 0, commission: Number(l.commission) || 0,
      owedAfter: owedAfterReceipt({ paid: bill.paid_amount, lines: linesByOrder.get(l.order_id) || [], receiptsById, receipt }),
    }
  }).sort((a, b) => (Date.parse(a.closedAt) - Date.parse(b.closedAt)) || (a.orderId < b.orderId ? -1 : 1))
  const { previous, next } = receiptBalances(events, receipt, fromPaisa(cleared))
  return { data: { receipt, bills, previousBalance: previous, newBalance: next }, error: null }
}

// The first failed read's error OBJECT (firstError() hands back only its message), so its code and
// hint still reach errorText.
function firstErrorObject(results) {
  return (results || []).find(r => r?.error)?.error || null
}

/**
 * Counts one print and says which copy it is. The guard keeps the higher of the stored and the sent
 * count (a till a print behind never fails), so this sends the stored count + 1 and labels from what
 * comes back: 1 is the original, anything higher a COPY. A refused or lost write still prints, labelled
 * from the count this page knows, and `countError` says the print was not counted.
 */
export async function countReceiptPrint({ db, receipt, ms = SETTLE_READ_MS }) {
  const known = Number(receipt?.print_count) || 0
  const { data, error } = await settleWithin(db.bumpPrintCount(receipt.id, known + 1), ms, 'Counting the print')
  const counted = Number(data?.print_count)
  const countError = error
    || (data ? null : { message: 'pos_credit_receipts: print count update matched no row' })
    || (counted > known ? null : { message: 'pos_credit_receipts: the print count was not raised' })
  const count = countError ? known + 1 : counted
  return { count, label: COPY_LABEL(count), countError }
}

/**
 * Reads, counts and prints one receipt into `w` (a window opened on the press). `outlet` is
 * { name, address, phone } as read for this outlet, or null when that read failed; `receivedByName(id)`
 * names the login that took the money, or returns null when it cannot. Nothing prints when anything
 * it needs is missing: the window is closed and `error` says why.
 * Returns { printed, error, countError }.
 */
export async function printCreditReceipt({ w, db, receiptId, partyKey, label, outlet, receivedByName }) {
  if (!w) return { printed: false, error: { blocked: true, message: 'The print window was blocked. Allow pop-ups for this site, then press Reprint.' }, countError: null }
  if (!outlet) {
    closeQuietly(w)
    return { printed: false, error: { message: "The outlet's name and address could not be read, so the receipt was not printed." }, countError: null }
  }
  const read = await readReceiptForPrint({ db, receiptId, partyKey, label })
  if (read.error) { closeQuietly(w); return { printed: false, error: read.error, countError: null } }
  const { receipt } = read.data
  const receivedBy = receivedByName(receipt.received_by)
  if (receivedBy == null) {
    closeQuietly(w)
    return { printed: false, error: { message: 'The name of who took this payment could not be read, so the receipt was not printed.' }, countError: null }
  }
  const { label: copyLabel, countError } = await countReceiptPrint({ db, receipt })
  const printed = writeAndPrint(w, buildReceiptHtml({ ...read.data, receivedBy, outlet, copyLabel }))
  return { printed, error: printed ? null : { message: 'The print window was closed before the receipt could go into it.' }, countError }
}
