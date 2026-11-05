// Clearing a tiny leftover on a supplier bill without paying it (S885, owner decision 3).
//
// A supplier bill left with NPR 10 or less owed (a rounding gap on the supplier's invoice, a rupee
// the cashier did not have) can be cleared by the Owner or an IMS manager, so it stops sitting on
// Outstanding Payables for ever. A cleared amount is a `payable_payments` row with
// `payment_mode = 'Write-off'`, recorded through record_payable_payments like any payment: it
// reduces what the bill owes, and the bill moves to Paid History. It is never money paid:
//
//   - the balance letter and Vendor Report show it as "Written off", never inside a payments total;
//   - it can never be turned into a cash payment later, nor a payment into one (the server refuses
//     an UPDATE of payment_mode into or out of 'Write-off', HINT write_off_mode_locked);
//   - it never counts toward supplier credit (supplierCreditSlots in payablesAllocation.js, and the
//     server's credit-pair check, both leave it out of what a line was paid).
//
// The limit is per BILL (all lines together, the bill being purchase_group_id, else the line):
// the write-offs on one bill total at most NPR 10 (HINT write_off_over_cap). This file has no
// imports so payablesAllocation.js can use it without a cycle.

export const WRITE_OFF_MODE = 'Write-off'
export const WRITE_OFF_MAX_NPR = 10

const toPaisa = n => Math.round((Number(n) || 0) * 100)
const MAX_PAISA = WRITE_OFF_MAX_NPR * 100

/** A payable_payments row that clears a leftover rather than paying it. */
export function isWriteOff(p) {
  return p?.payment_mode === WRITE_OFF_MODE
}

/** What a set of payable_payments rows cleared without paying, to the paisa. */
export function writtenOffOf(payments) {
  return (payments || []).reduce((s, p) => s + (isWriteOff(p) ? toPaisa(p.amount) : 0), 0) / 100
}

/** What a set of payable_payments rows paid, write-offs left out, to the paisa (signed). */
export function paidExcludingWriteOffs(payments) {
  return (payments || []).reduce((s, p) => s + (isWriteOff(p) ? 0 : toPaisa(p.amount)), 0) / 100
}

/** How much more a bill may still have cleared, given what it already has (`writtenOff`). */
export function writeOffRoom(writtenOff) {
  return Math.max(0, MAX_PAISA - toPaisa(writtenOff)) / 100
}

/**
 * The amount "Clear" would write on a grouped bill (groupIntoBills: `remaining`, `writtenOff`), or
 * null when the bill cannot be cleared: nothing owed, more than NPR 10 owed, or so much already
 * cleared that this would take the bill past NPR 10 in all.
 */
export function clearableAmount(bill) {
  if (!bill) return null
  const owed = toPaisa(bill.remaining)
  if (!(owed > 0)) return null
  if (owed + toPaisa(bill.writtenOff) > MAX_PAISA) return null
  return owed / 100
}

/** The login a payment row was recorded by, when the server stamped one (older rows have none). */
export function recordedByOf(p) {
  const name = typeof p?.recorded_by_name === 'string' ? p.recorded_by_name.trim() : ''
  return name || null
}
