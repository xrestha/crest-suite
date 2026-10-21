import { supabase } from '../../../supabaseClient'
import { scopedFrom } from '../../../shared/scopedDb'
import { settleWithin, isTimeout } from '../../../utils/withTimeout'
import { fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { errorInfo } from '../../../shared/errorText'
import { noAnswer } from '../orders/sendAttempt'
import {
  DEPOSIT_COLS, depositBalance, depositMoney, depositReceiptLabel, depositsByReservation, pickOrderDeposit,
} from './depositState'

// Booking deposits (S854), the half that talks to the server. Every write is ONE call to a SECURITY
// DEFINER function (migration 20261021110000) that checks rank, outlet and balance itself, in one
// transaction:
//   record_booking_deposit(p_reservation_id, p_amount, p_method, p_request_id, p_note)  Take deposit
//   refund_booking_deposit(p_deposit_id, p_request_id)                                   Refund
//   apply_booking_deposit(p_order_id, p_amount)                         the Deposit line on an open bill
// A take or a refund carries a request id: a press whose answer was lost is sent again with the SAME
// id, and the server answers it with the first deposit or refund (`replayed`), so money is never taken
// or handed back twice however often an answer goes missing. Every await that blocks a person is
// time-limited (withTimeout.js). Errors come back as the Supabase error OBJECT, so the call site words
// them (depositErrorInfo, below, or errorText.js) and the code survives into the fine print.

export { depositBalance, depositMoney, depositReceiptLabel }

/** A read the page waits on. */
export const DEPOSIT_READ_MS = 15000
/** A write: how long before its answer counts as lost (it is then sent again with the same id). */
export const DEPOSIT_WRITE_MS = 20000

/**
 * The deposits of a set of bookings, for the bookings list. `db` is the page useScopedDb() (its
 * scopedFrom(table, columns)). Chunked (an `.in()` list is a URL) and paged. Returns
 * `{ data, byReservation, error }`; on a failed read data and byReservation are null, never empty:
 * a failed read is not "no deposits".
 */
export async function loadReservationDeposits(db, reservationIds, { ms = DEPOSIT_READ_MS } = {}) {
  const ids = [...new Set((reservationIds || []).filter(Boolean))]
  if (ids.length === 0) return { data: [], byReservation: {}, error: null }
  const res = await settleWithin(
    fetchAllRowsChunked(ids, part => db.scopedFrom('pos_booking_deposits', DEPOSIT_COLS).in('reservation_id', part).order('id')),
    ms, 'Reading the booking deposits')
  if (res.error) return { data: null, byReservation: null, error: res.error }
  const rows = res.data || []
  return { data: rows, byReservation: depositsByReservation(rows), error: null }
}

/**
 * The deposit the payment window may use on a bill, or null: the one already on the bill, else the
 * one of the booking seated on it (pos_reservations.order_id). `clientId` scopes the reads (they fail
 * closed without one). Returns `{ data, error }`; data is the deposit row plus
 *   balance     what is left to use, in rupees
 *   onThisBill  true when its Deposit line is on this bill now
 *   label       the receipt number, DP-12
 */
export async function loadOrderDeposit(orderId, clientId, { ms = DEPOSIT_READ_MS } = {}) {
  if (!orderId) return { data: null, error: null }
  const [onBill, seated] = await Promise.all([
    settleWithin(scopedFrom('pos_booking_deposits', clientId, DEPOSIT_COLS).eq('order_id', orderId).order('id'),
      ms, 'Reading the deposit on this bill'),
    settleWithin(scopedFrom('pos_reservations', clientId, 'id').eq('order_id', orderId).order('id'),
      ms, 'Reading the booking on this bill'),
  ])
  if (onBill.error) return { data: null, error: onBill.error }
  if (seated.error) return { data: null, error: seated.error }
  let rows = onBill.data || []
  const reservationIds = (seated.data || []).map(r => r.id)
  if (reservationIds.length > 0) {
    const byBooking = await settleWithin(
      scopedFrom('pos_booking_deposits', clientId, DEPOSIT_COLS).in('reservation_id', reservationIds).order('id'),
      ms, 'Reading the booking deposit')
    if (byBooking.error) return { data: null, error: byBooking.error }
    rows = rows.concat(byBooking.data || [])
  }
  return { data: pickOrderDeposit(rows, orderId), error: null }
}

// One bounded call. The request is cancelled once the clock runs out: what was never sent is never
// sent, and what the server already had finishes inside its own transaction (the request id covers it).
async function sendOnce(name, args, ms, label) {
  const ctrl = new AbortController()
  const call = supabase.rpc(name, args)
  const res = await settleWithin(typeof call?.abortSignal === 'function' ? call.abortSignal(ctrl.signal) : call, ms, label)
  if (isTimeout(res?.error)) ctrl.abort()
  return res || { data: null, error: { message: `${name} answered nothing` } }
}

// The shared retry: a lost answer is sent again with the same request id; a refusal after a lost
// answer may be BECAUSE the first landed meanwhile, so one more send asks for its replay before
// anything is called refused (the S843 receipts shape).
async function sendWithReplay(name, args, { ms, label, priorLost }) {
  const send = () => sendOnce(name, args, ms, label)
  let res = await send()
  let lost = !!priorLost
  if (res.error && noAnswer(res)) { lost = true; res = await send() }
  if (lost && res.error && !noAnswer(res)) res = await send()
  return { res, lost }
}

/**
 * Takes a deposit. `amount` in rupees to the paisa, `method` one of DEPOSIT_METHODS, `requestId` minted
 * once per press (randomUUID) and sent again unchanged by Check again (`priorLost`). Returns
 *   { status: 'recorded' | 'replayed', deposit }   the deposit the server holds for this press
 *   { status: 'refused', error }                   refused before anything was written
 *   { status: 'unknown', error }                   no answer: it may have landed; send the same id again
 * `deposit` is the row plus balance, customer_name, party_size and reserved_for.
 */
export async function recordDeposit({ reservationId, amount, method, requestId, note = null, priorLost = false, ms = DEPOSIT_WRITE_MS }) {
  const args = {
    p_reservation_id: reservationId, p_amount: amount, p_method: method, p_request_id: requestId,
    p_note: String(note || '').trim() || null,
  }
  const { res, lost } = await sendWithReplay('record_booking_deposit', args, { ms, label: 'Taking the deposit', priorLost })
  if (!res.error && res.data?.id) return { status: res.data.replayed ? 'replayed' : 'recorded', deposit: res.data, lost }
  if (!res.error) return { status: 'unknown', error: { message: 'record_booking_deposit answered with no deposit' }, lost }
  if (noAnswer(res)) return { status: 'unknown', error: res.error, lost: true }
  return { status: 'refused', error: res.error, lost }
}

/**
 * Refunds what is left on a deposit, the whole of it, the way it came. Same shape as recordDeposit:
 *   { status: 'refunded' | 'replayed', deposit }   `deposit.refunded_now` is the amount handed back
 *   { status: 'refused' | 'unknown', error }
 */
export async function refundDeposit({ depositId, requestId, priorLost = false, ms = DEPOSIT_WRITE_MS }) {
  const args = { p_deposit_id: depositId, p_request_id: requestId }
  const { res, lost } = await sendWithReplay('refund_booking_deposit', args, { ms, label: 'Refunding the deposit', priorLost })
  if (!res.error && res.data?.id) return { status: res.data.replayed ? 'replayed' : 'refunded', deposit: res.data, lost }
  if (!res.error) return { status: 'unknown', error: { message: 'refund_booking_deposit answered with no deposit' }, lost }
  if (noAnswer(res)) return { status: 'unknown', error: res.error, lost: true }
  return { status: 'refused', error: res.error, lost }
}

/**
 * Puts `amount` of the bill booking deposit on the OPEN bill as its Deposit line, replacing any
 * earlier one; 0 takes it off again (the handback). The payment window calls it at Charge time, just
 * before the Split close, and with 0 before a charge that is not Split (the server hands it back on
 * any other close anyway). Returns `{ data, error, noAnswer }`: data is the amount now on the bill (a
 * number, 0 after a handback) or null. A timeout is `noAnswer`: it may have landed, so read the bill
 * Deposit line back before charging.
 */
export async function applyDeposit(orderId, amount, { ms = DEPOSIT_WRITE_MS } = {}) {
  const res = await sendOnce('apply_booking_deposit', { p_order_id: orderId, p_amount: amount }, ms, 'Using the deposit')
  if (res.error) return { data: null, error: res.error, noAnswer: noAnswer(res) }
  const n = Number(res.data)
  return { data: Number.isFinite(n) ? n : null, error: null, noAnswer: false }
}

// ── Wording ───────────────────────────────────────────────────────────────────────────────────────
// The server refusals, by the code it puts in the HINT (and at the head of the message). Each is
// raised before anything is written, inside the one transaction, so each may say nothing changed. A
// dropped connection is not one of these: it falls through to errorText.js, which claims nothing.
const RULES = [
  { code: 'booking_deposit_rank', viaMessage: true,
    text: 'Taking, using or refunding a booking deposit needs a POS supervisor, a POS manager or the Owner, so nothing was done from this login.' },
  { code: 'booking_deposit_auth',
    text: 'This login is not signed in to the outlet of this booking or bill, so nothing was done. Sign in again with a login of this outlet, then try again.' },
  { code: 'booking_deposit_bad',
    text: 'The deposit was refused as entered (the reason is in the detail below), so nothing was taken or changed. Check the amount and how it was paid.' },
  { code: 'booking_deposit_no_booking',
    text: 'That booking is not on this outlet records any more, so no deposit was taken. Reload the bookings.' },
  { code: 'booking_deposit_booking_closed',
    text: 'This booking is no longer one still to come (it was seated, done, cancelled or marked no-show on another device), so no deposit was taken. Reload the bookings.' },
  { code: 'booking_deposit_exists',
    text: 'This booking already holds a deposit, so a second one was not taken. To take a different amount, refund the first one, then take the new amount.' },
  { code: 'booking_deposit_no_shift',
    text: 'Cash goes into the open shift drawer, and no shift is open, so no deposit was taken and no receipt was numbered. Open a shift in POS, Shifts, then take it again, or pick the way the money really came.' },
  { code: 'booking_deposit_missing',
    text: 'That deposit is not on this outlet records, so nothing was refunded. Reload the bookings.' },
  { code: 'booking_deposit_nothing_left',
    text: 'Nothing is left on this deposit to refund: it was used on the bill or refunded already (the figures are in the detail below). Nothing was changed. Reload the bookings.' },
  { code: 'booking_deposit_on_open_bill',
    text: 'This deposit is on an open bill as its Deposit line, so it was not refunded. Take it off the bill in the payment window, or charge the bill, then refund what is left.' },
  { code: 'booking_deposit_refund_no_shift',
    text: 'A cash refund comes out of the open shift drawer, and no shift is open, so nothing was refunded. Open a shift in POS, Shifts, then refund it.' },
  { code: 'booking_deposit_no_bill',
    text: 'That bill was not found, so no deposit was used. Open the order again.' },
  { code: 'booking_deposit_bill_closed',
    text: 'This bill is already closed, so no deposit was used on it. Any deposit left is refunded from Reservations.' },
  { code: 'booking_deposit_none',
    text: 'No booking with a deposit left is seated on this bill, so no deposit was used. Charge the bill without it.' },
  { code: 'booking_deposit_ambiguous',
    text: 'More than one booking with a deposit is seated on this bill, so Crest cannot tell which to use, and none was used. Refund the deposit of the booking not paying this bill, then try again.' },
  { code: 'booking_deposit_already_used',
    text: 'This deposit already paid part of another bill. What is left is refunded from Reservations, never moved to a second bill. Nothing was used here.' },
  { code: 'booking_deposit_on_other_bill',
    text: 'This deposit is already on another open bill, so it was not used here. Take it off that bill in its payment window first.' },
  { code: 'booking_deposit_over_balance',
    text: 'That is more than the deposit has left (the figures are in the detail below), so none of it was used. Use no more than the balance.' },
  { code: 'booking_deposit_over_bill',
    text: 'That is more of the deposit than this bill comes to, so none of it was used. Use no more than the bill total; the rest is refunded afterwards.' },
  { code: 'pos_deposit_split_only',
    text: 'A booking deposit pays its part of a bill as a Split payment line, never as the method of the whole bill. The bill was not closed and nothing was charged. Charge it as Split.' },
  { code: 'pos_deposit_over_bill',
    text: 'The deposit line is more than the bill total, so the bill was not closed and nothing was charged. Take less from the deposit, then charge again.' },
  { code: 'pos_deposit_missing',
    text: 'This bill carries a Deposit line but no booking deposit is on it, so the bill was not closed and nothing was charged. Take the deposit off in the payment window, add it again, then charge.' },
  { code: 'pos_booking_deposit_locked',
    text: 'A booking deposit is taken, used and refunded only by Crest itself and is never changed by hand, so nothing was changed. If a page sent this, reload it.' },
  { code: 'pos_cash_deposit_direct',
    text: 'A deposit and its refund put their own cash on the drawer, so this cash entry was not recorded. Take or refund the deposit on Reservations instead.' },
]

function matches(e, code, viaMessage) {
  const msg = e?.message || ''
  const inMessage = new RegExp(`(^|[^a-z_])${code}([^a-z_]|$)`, 'i').test(msg)
  if (viaMessage) return inMessage
  return e?.hint === code || inMessage
}

/**
 * `{ text, detail }` for a deposit refusal: the sentence above for one of the deposit codes, else
 * errorText.js (a dropped connection, a timeout, anything else). `detail` keeps `code · message`.
 */
export function depositErrorInfo(err, audience = 'operator') {
  const base = errorInfo(err, audience)
  if (!err || typeof err === 'string') return base
  const hit = RULES.find(r => matches(err, r.code, r.viaMessage))
  return hit ? { text: hit.text, detail: base.detail } : base
}

// ── What a press did, in words ────────────────────────────────────────────────────────────────────

/** The line once a Take deposit press has an answer. `{ kind: 'ok' | 'warn' | 'error', text, error }`. */
export function recordOutcome(result, { customerName } = {}) {
  const who = customerName || 'the guest'
  if (result.status === 'recorded' || result.status === 'replayed') {
    const d = result.deposit || {}
    const cash = d.method === 'Cash' ? ' The cash is on the open shift drawer count.' : ''
    const replay = result.status === 'replayed' || result.lost
      ? ' The first answer was lost, so this was checked with the server: the deposit is recorded once.' : ''
    return {
      kind: 'ok',
      text: `Deposit ${depositReceiptLabel(d)} (${d.invoice_fy || ''}): ${depositMoney(d.amount)} from ${d.customer_name || who} by ${d.method}.${cash}${replay}`,
      error: null,
    }
  }
  if (result.status === 'unknown') {
    return {
      kind: 'warn',
      text: `No answer came back, so it is not known whether the deposit from ${who} was taken. Do not hand any money back and do not take it again with a new press: press Check again, which asks the server about this same press and can never take it twice.`,
      error: result.error,
    }
  }
  const { text } = depositErrorInfo(result.error)
  return { kind: 'error', text: `No deposit was taken, and no receipt was numbered. ${text}`, error: result.error }
}

/**
 * The line once a Refund press has an answer. `checkAgain` false is the refund a Cancel or No-show runs
 * on its own, where there is no Check again button: the unknown case then points at the row instead.
 */
export function refundOutcome(result, deposit, { customerName, checkAgain = true } = {}) {
  const who = customerName || deposit?.customer_name || 'the guest'
  const label = depositReceiptLabel(deposit)
  if (result.status === 'refunded' || result.status === 'replayed') {
    const d = result.deposit || {}
    const amount = d.refunded_now ?? d.refunded_amount
    const cash = d.method === 'Cash'
      ? ` ${depositMoney(amount)} went on the open shift as cash taken out: hand it to ${who}.`
      : ` Pay it back to ${who} by ${d.method}.`
    const replay = result.status === 'replayed' || result.lost
      ? ' The first answer was lost, so this was checked with the server: it was refunded once.' : ''
    return { kind: 'ok', text: `Deposit ${label} refunded: ${depositMoney(amount)}.${cash}${replay}`, error: null }
  }
  if (result.status === 'unknown') {
    return {
      kind: 'warn',
      text: checkAgain
        ? `No answer came back, so it is not known whether deposit ${label} was refunded. Do not hand money back yet: press Check again, which asks the server about this same refund and can never refund it twice.`
        : `No answer came back, so it is not known whether deposit ${label} was refunded. Do not hand money back yet: reload the page, and if the booking still shows Refund due, refund it from its row. A deposit can only be refunded once.`,
      error: result.error,
    }
  }
  const { text } = depositErrorInfo(result.error)
  return { kind: 'error', text: `Deposit ${label} was not refunded. ${text}`, error: result.error }
}
