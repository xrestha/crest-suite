import { nprPaisa } from '../../../shared/nepalMoney'
import { evaluate } from '../../../utils/evalMath'

// Booking deposits (S854), the pure half: the balance arithmetic, what a booking row says about its
// deposit, which actions it offers, and the sentences around taking and refunding one. No React, no
// Supabase, so every rule here is tested on its own (depositState.test.js).
//
// Owner decisions (S854): a supervisor or manager takes a deposit and the guest gets a numbered deposit
// receipt with no VAT on it; VAT is charged on the final bill, which the deposit pays in part as a
// tender (the Deposit payment line), never a discount; whatever is not used is ALWAYS refunded the way
// it came, and a cancellation or a no-show refunds all of it. A deposit is never kept.

/** How a deposit can be paid (record_booking_deposit, and the table CHECK). */
export const DEPOSIT_METHODS = ['Cash', 'Card', 'eSewa', 'Khalti', 'FonePay']

/** Booking states that take a deposit (the server list in record_booking_deposit). */
export const DEPOSIT_TAKE_STATUSES = ['requested', 'booked', 'confirmed', 'arrived']

/** Booking states that are over: what is left on the deposit is owed back. */
export const DEPOSIT_ENDED_STATUSES = ['cancelled', 'no_show', 'completed']

/** The columns every deposit read asks for. */
export const DEPOSIT_COLS = 'id, client_id, reservation_id, invoice_fy, receipt_no, amount, method, used_amount, ' +
  'refunded_amount, order_id, shift_id, taken_by, taken_at, refund_method, refunded_by, refunded_at, refund_shift_id, notes'

const toPaisa = n => Math.round((Number(n) || 0) * 100)

/** `NPR 5,000`, or `NPR 2,499.50` when there are paisa. */
export const depositMoney = n => `NPR ${nprPaisa(n)}`

/** The deposit receipt number as it prints: DP-12. */
export function depositReceiptLabel(row) {
  return `DP-${row?.receipt_no ?? ''}`
}

/** What is left on a deposit: amount less what the bill used and what was refunded, never below 0. */
export function depositBalance(row) {
  if (!row) return 0
  return Math.max(0, toPaisa(row.amount) - toPaisa(row.used_amount) - toPaisa(row.refunded_amount)) / 100
}

/** Deposit rows grouped by booking: `{ [reservation_id]: [rows, newest first] }`. */
export function depositsByReservation(rows) {
  const out = {}
  for (const d of rows || []) {
    if (!d?.reservation_id) continue
    ;(out[d.reservation_id] = out[d.reservation_id] || []).push(d)
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => String(b.taken_at || '').localeCompare(String(a.taken_at || '')))
  return out
}

/** The deposit a booking row speaks for: the live one (a balance left), else the newest. */
export function depositOfReservation(list) {
  const rows = list || []
  return rows.find(d => depositBalance(d) > 0) || rows[0] || null
}

/**
 * The deposit the payment window may use on a bill, from the rows read for it (those already on the
 * bill, and those of the booking seated on it): the one on the bill now, else the only one with a
 * balance that is on no other bill and has paid no bill. Two candidates is the server refusal
 * (booking_deposit_ambiguous), so none is offered. Returns the row with `balance` and `onThisBill`.
 */
export function pickOrderDeposit(rows, orderId) {
  const seen = new Map()
  for (const d of rows || []) if (d?.id && !seen.has(d.id)) seen.set(d.id, d)
  const list = [...seen.values()]
  const usable = d => depositBalance(d) > 0 && toPaisa(d.used_amount) === 0
  const onBill = list.find(d => d.order_id === orderId && usable(d))
  const pick = onBill || (() => {
    const free = list.filter(d => usable(d) && (d.order_id == null || d.order_id === orderId))
    return free.length === 1 ? free[0] : null
  })()
  if (!pick) return null
  return { ...pick, balance: depositBalance(pick), onThisBill: pick.order_id === orderId, label: depositReceiptLabel(pick) }
}

/**
 * What the booking row says about its deposit, or null when it has none.
 * `{ kind, text, badge, tip }`: kind is
 *   'held'        a booking still to come, or seated, with money held for its bill
 *   'on_bill'     the deposit is a Deposit line on the open bill now
 *   'refund_due'  the booking is over (or its bill used part) and money is left: it is owed back
 *   'used'        nothing left: the bill used it (any rest was refunded)
 *   'refunded'    nothing left: it was refunded
 */
export function depositBadge(reservation, deposit, { onOpenBill = false } = {}) {
  if (!deposit) return null
  const balance = depositBalance(deposit)
  const used = Number(deposit.used_amount) || 0
  const refunded = Number(deposit.refunded_amount) || 0
  const label = depositReceiptLabel(deposit)
  const how = deposit.method || 'its method'
  const ended = DEPOSIT_ENDED_STATUSES.includes(reservation?.status)

  if (balance > 0 && onOpenBill) {
    return {
      kind: 'on_bill', badge: 'badge-gray', text: `Deposit ${depositMoney(balance)} on the bill`,
      tip: `Receipt ${label}, paid by ${how}. It is on the open bill as its Deposit line. Whatever the bill does not use is refunded afterwards.`,
    }
  }
  if (balance > 0 && (ended || used > 0)) {
    return {
      kind: 'refund_due', badge: 'badge-amber', text: `△ Refund due ${depositMoney(balance)}`,
      tip: `${depositMoney(balance)} of deposit ${label} is still held and the booking is over. A deposit is always refunded, by ${how}, the way it came. A supervisor or a manager refunds it from this row.`,
    }
  }
  if (balance > 0) {
    return {
      kind: 'held', badge: 'badge-gray', text: `Deposit ${depositMoney(balance)}`,
      tip: `Receipt ${label}, paid by ${how}. It pays part of the final bill as the Deposit payment line, and the bill carries VAT as usual. Whatever is not used is refunded.`,
    }
  }
  if (used > 0) {
    return {
      kind: 'used', badge: 'badge-gray', text: `Deposit used ${depositMoney(used)}`,
      tip: `Deposit ${label} paid ${depositMoney(used)} of the bill${refunded > 0 ? ` and ${depositMoney(refunded)} was refunded by ${deposit.refund_method || how}` : ''}.`,
    }
  }
  return {
    kind: 'refunded', badge: 'badge-gray', text: `Deposit refunded ${depositMoney(refunded)}`,
    tip: `Deposit ${label} was refunded in full by ${deposit.refund_method || how}.`,
  }
}

/**
 * Which deposit actions a booking row offers. `canMoney` is Supervisor and above on the outlet own
 * login (Crest support records no money for an outlet). A deposit on an open bill cannot be refunded
 * until it is taken off in the payment window (the server refuses it too).
 */
export function depositActions({ reservation, deposit, canMoney, onOpenBill = false }) {
  const balance = depositBalance(deposit)
  const live = DEPOSIT_TAKE_STATUSES.includes(reservation?.status)
  const ended = DEPOSIT_ENDED_STATUSES.includes(reservation?.status)
  const refundDue = !!deposit && balance > 0 && (ended || (Number(deposit.used_amount) || 0) > 0)
  return {
    canTake: !!canMoney && live && !(deposit && balance > 0),
    canRefund: !!canMoney && !!deposit && balance > 0 && !onOpenBill,
    canReprint: !!deposit,
    refundDue,
    balance,
  }
}

/**
 * What a Cancel or No-show does with the booking deposit (always refunded, owner decision). Returns
 * null with nothing left on it, else `{ refund, amount, text }`: `refund` true when this login refunds
 * it in the same flow, and `text` the sentence for the dialog.
 */
export function refundOnEndPlan({ deposit, canMoney, onOpenBill = false }) {
  const amount = depositBalance(deposit)
  if (!deposit || amount <= 0) return null
  const money = depositMoney(amount)
  if (onOpenBill) {
    return { refund: false, amount, text: `The deposit (${money}) is on the open bill. Take it off the bill in the payment window, then refund it from this row.` }
  }
  if (!canMoney) {
    return { refund: false, amount, text: `The deposit left (${money}) must be refunded. A supervisor or a manager refunds it from this row, where it shows Refund due.` }
  }
  return {
    refund: true, amount,
    text: deposit.method === 'Cash'
      ? `The deposit left (${money}) is refunded now in cash: it comes out of the open shift drawer, so hand it back. A deposit is never kept.`
      : `The deposit left (${money}) is recorded as refunded by ${deposit.method}: pay it back to the guest by ${deposit.method}. A deposit is never kept.`,
  }
}

/** The lines of the Refund deposit confirm: how much, which way, and where the cash goes. */
export function refundConsequence(deposit, customerName) {
  const amount = depositBalance(deposit)
  const money = depositMoney(amount)
  const who = customerName || 'the guest'
  const lines = [`${money} of deposit ${depositReceiptLabel(deposit)} goes back to ${who}, the whole amount left on it. A refund cannot be undone.`]
  lines.push(deposit?.method === 'Cash'
    ? `It was paid in cash, so ${money} leaves the cash drawer: it goes on the OPEN shift as cash taken out. With no shift open, the refund is refused.`
    : `It was paid by ${deposit?.method}, so nothing leaves the cash drawer. Pay it back to the guest by ${deposit?.method}.`)
  return lines
}

/**
 * Parses the typed deposit amount through the one evaluator (evalMath), so "2500*4" and "10,000" both
 * work and a typed sum is never read by its prefix. Returns `{ amount, error }`: amount in rupees to
 * the paisa, or null with the sentence to show.
 */
export function parseDepositAmount(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return { amount: null, error: 'Type the amount the guest is paying now.' }
  const value = evaluate(raw)
  if (value === null || !Number.isFinite(value)) return { amount: null, error: 'Type the amount as a number, like 5000 or 2500*2.' }
  const paisa = Math.round(value * 100)
  if (paisa <= 0) return { amount: null, error: 'A deposit is more than zero.' }
  if (paisa >= 1000000000000) return { amount: null, error: 'That amount is too large for a deposit.' }
  return { amount: paisa / 100, error: null }
}
