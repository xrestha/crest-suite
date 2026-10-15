import { noAnswer } from '../orders/sendAttempt'
import { settleWithin, isTimeout } from '../../../utils/withTimeout'
import { npr2 } from '../../../shared/nepalMoney'
import { errorText } from '../../../shared/errorText'
import { nepalBsLong, nepalDateAd, nepalTime } from '../../../shared/nepalTime'
import { fromPaisa, receiptNoLabel } from './creditLedger'

// Recording and cancelling a customer's credit payment (S843), the half that can be tested without the
// page. Until S843 a Credit bill was settled whole by one conditional UPDATE from this page, its cash
// posted by a second write; a lost answer was read back bill by bill (S809 3l). Now a payment is ONE
// call, record_credit_receipt, which writes the numbered receipt, its lines, the cash entry and each
// bill's settled stamp in one transaction, so there is no second write to lose.
//
// What is left of S809 3l is the lost answer itself. Each press mints a request id (p_request_id) and
// a retry sends the SAME id: the server answers a repeat with the first receipt (`replayed: true`), so
// a payment is never recorded twice however often its answer goes missing. A retry that is refused
// after a lost first answer may be refused BECAUSE the first landed meanwhile (the bills it cleared are
// no longer unpaid, or the request id is already taken), so one more send asks for that replay before
// anything is called refused.

/** How long the write waits for an answer before it counts as lost (then it is sent again). */
export const SETTLE_WRITE_MS = 20000
/** The reads around it: the party's bills, the open shift, a receipt read back for printing. */
export const SETTLE_READ_MS = 8000

/** The ways a credit customer or a delivery partner pays (the RPC's list, and the receipts table's CHECK). */
export const RECEIPT_METHODS = ['Cash', 'Card', 'eSewa', 'Khalti', 'FonePay', 'Cheque', 'Bank Transfer']

/** "9 Kartik 2083 at 7:42 PM", as Nepal reads it. */
export function settledWhen(ts) {
  const day = nepalBsLong(ts) || nepalDateAd(ts)
  const time = nepalTime(ts)
  return time ? `${day} at ${time}` : day
}

// One bounded call. The request is cancelled once the clock runs out: what was never sent is never
// sent, and what the server already had finishes inside its own limits (the retry's id covers it).
async function sendOnce(rpc, name, args, ms, label) {
  const ctrl = new AbortController()
  const res = await settleWithin(rpc(name, args, ctrl.signal), ms, label)
  if (isTimeout(res.error)) ctrl.abort()
  return res
}

/**
 * Records one payment. `rpc(name, args, signal)` is the page's supabase.rpc. `amount` is rupees to
 * the paisa and `lines` the [{ order_id, amount, commission }] that add up to it (creditLedger's
 * allocatePayment). `priorLost` marks Check again: the same request, sent after its answer was lost.
 * Returns
 *   { status: 'recorded' | 'replayed', receipt }   the receipt the server holds for this request
 *   { status: 'refused', error }                   the server's refusal: nothing was recorded
 *   { status: 'unknown', error }                   no answer: it may have landed; send the same id again
 */
export async function recordCreditReceipt({
  rpc, requestId, partyKey, method, amount, lines, reference = null, note = null, priorLost = false, ms = SETTLE_WRITE_MS,
}) {
  const args = {
    p_request_id: requestId, p_party_key: partyKey, p_method: method, p_amount: amount, p_lines: lines,
    p_reference: (reference || '').trim() || null, p_note: (note || '').trim() || null,
  }
  const send = () => sendOnce(rpc, 'record_credit_receipt', args, ms, 'Recording the payment')
  let res = await send()
  // `priorLost`: this is Check again, after an earlier press of this same request went unanswered.
  let lost = priorLost
  if (res.error && noAnswer(res)) { lost = true; res = await send() }
  // Refused after a lost answer: the first send may be what made the bills stale (or took the id),
  // and it may still have been finishing when the retry arrived. One more send asks for its replay.
  if (lost && res.error && !noAnswer(res)) res = await send()
  if (!res.error && res.data?.receipt_id) {
    return { status: res.data.replayed ? 'replayed' : 'recorded', receipt: res.data, lost }
  }
  if (!res.error) return { status: 'unknown', error: { message: 'record_credit_receipt answered with no receipt' }, lost }
  if (noAnswer(res)) return { status: 'unknown', error: res.error, lost: true }
  return { status: 'refused', error: res.error, lost }
}

/**
 * Cancels one receipt, with the reason the server keeps on it. Cancelling is idempotent (a cancelled
 * receipt answers `already_cancelled`), so a lost answer is simply sent again. Returns
 *   { status: 'cancelled', data }          this press cancelled it (also when only the retry heard so)
 *   { status: 'already', data }            it had been cancelled before this press
 *   { status: 'refused' | 'unknown', error }
 */
export async function cancelCreditReceipt({ rpc, receiptId, reason, ms = SETTLE_WRITE_MS }) {
  const args = { p_receipt_id: receiptId, p_reason: String(reason ?? '').trim() }
  const send = () => sendOnce(rpc, 'cancel_credit_receipt', args, ms, 'Cancelling the payment')
  let res = await send()
  let lost = false
  if (res.error && noAnswer(res)) { lost = true; res = await send() }
  if (!res.error && res.data) {
    return { status: res.data.already_cancelled && !lost ? 'already' : 'cancelled', data: res.data, lost }
  }
  if (!res.error) return { status: 'unknown', error: { message: 'cancel_credit_receipt answered with nothing' }, lost }
  if (noAnswer(res)) return { status: 'unknown', error: res.error, lost: true }
  return { status: 'refused', error: res.error, lost }
}

const money = n => `NPR ${npr2(n)}`

/**
 * The sentences shown before a payment is recorded (the Receive payment dialog's last paragraph), from
 * the allocation the dialog shows. `rows` are allocatePayment's rows; `label(bill)` names a bill.
 */
export function paymentSummary({ partyName, partner = false, method, total, commissionTotal = 0, rows, label, shiftOpen }) {
  const taking = (rows || []).filter(r => r.ticked && (r.amount + r.commission) > 0)
  const full = taking.filter(r => r.owedAfter === 0)
  const part = taking.filter(r => r.owedAfter > 0)
  const parts = []
  if (full.length) parts.push(`clears ${full.map(r => label(r.bill)).join(', ')} in full`)
  if (part.length) parts.push(part.map(r => `puts ${money(fromPaisa(r.amount + r.commission))} against ${label(r.bill)} (${money(fromPaisa(r.owedAfter))} still owed on it)`).join(', '))
  const who = partyName || 'the customer'
  const lines = [`${money(fromPaisa(total))} from ${who} by ${method}${parts.length ? `: ${parts.join(' and ')}` : ''}.`]
  if (partner && commissionTotal > 0) lines.push(`${who} keeps ${money(fromPaisa(commissionTotal))} as commission on these bills, so together they clear ${money(fromPaisa(total + commissionTotal))}.`)
  lines.push(method === 'Cash'
    ? (shiftOpen === false
      ? 'No shift is open, so a Cash payment will be refused: open a shift first, or pick how they really paid.'
      : "The cash goes on the open shift's drawer count, so the drawer count expects it.")
    : 'Nothing goes into the cash drawer count. Only a Cash payment does.')
  lines.push('A numbered money receipt is recorded and printed. A payment entered by mistake can be cancelled with a reason, never deleted.')
  return lines
}

/**
 * The line shown once a record press has an answer. `result` is recordCreditReceipt's; returns
 * { kind: 'ok' | 'warn' | 'error', text, error }. A refusal says nothing was recorded, which is true:
 * the function raises inside its one transaction, so a refusal rolls the whole payment back.
 */
export function recordOutcome(result, { partyName, method, amount }) {
  const who = partyName || 'the customer'
  if (result.status === 'recorded' || result.status === 'replayed') {
    const r = result.receipt || {}
    const settled = (r.bills || []).filter(b => b.settled).length
    const head = `Receipt ${receiptNoLabel(r)} (${r.invoice_fy || ''}): ${money(amount)} from ${who} by ${method}.`
    const cleared = settled ? ` ${settled} bill${settled === 1 ? '' : 's'} paid in full.` : ''
    const replay = result.status === 'replayed' || result.lost
      ? ' The first answer was lost, so this was checked with the server: the payment is recorded once.' : ''
    const cash = method === 'Cash' ? " The cash is on the open shift's drawer count." : ''
    return { kind: 'ok', text: head + cleared + cash + replay, error: null }
  }
  if (result.status === 'unknown') {
    return {
      kind: 'warn',
      text: `No answer came back, so it is not known whether ${money(amount)} from ${who} was recorded. Do not hand any money back and do not record it again: press Check again, which asks the server about this same payment and can never record it twice.${method === 'Cash' ? ' Keep the cash aside until then.' : ''}`,
      error: result.error,
    }
  }
  return { kind: 'error', text: `The payment was not recorded, and no receipt was made. ${errorText(result.error, 'operator')}`, error: result.error }
}

/** The confirm text for cancelling a receipt (S843 owner decision): the amount, and where its cash goes. */
export function cancelConsequence(receipt) {
  const amt = money(receipt.amount)
  const lines = [
    `Receipt ${receiptNoLabel(receipt)} (${receipt.invoice_fy || ''}) for ${amt} from ${receipt.party_name || 'the customer'} is marked Cancelled, with your reason. It is never deleted.`,
    'The bills it paid owe that money again, and any bill it had paid in full goes back to unpaid.',
  ]
  lines.push(receipt.method === 'Cash'
    ? `${amt} leaves the cash drawer: it goes on the OPEN shift as cash taken out, so hand the money back or take it out of the drawer now. With no shift open, the cancel is refused.`
    : `It was paid by ${receipt.method}, so nothing leaves the cash drawer. Return the money the same way if it is owed back.`)
  return lines
}

/** The line shown once a cancel press has an answer. */
export function cancelOutcome(result, receipt) {
  const name = `Receipt ${receiptNoLabel(receipt)}`
  if (result.status === 'cancelled') {
    return {
      kind: 'ok',
      text: `${name} is cancelled.${receipt.method === 'Cash' ? ` ${money(receipt.amount)} went on the open shift as cash taken out.` : ''} Its bills are owed again.`,
      error: null,
    }
  }
  if (result.status === 'already') return { kind: 'warn', text: `${name} had already been cancelled, so nothing changed.`, error: null }
  if (result.status === 'unknown') {
    return { kind: 'warn', text: `No answer came back, so it is not known whether ${name} was cancelled. Reload the page: Collected shows it as Cancelled if it was. Pressing Cancel again is safe, as it can only be cancelled once.`, error: result.error }
  }
  return { kind: 'error', text: `${name} was not cancelled. It stands as it was. ${errorText(result.error, 'operator')}`, error: result.error }
}
