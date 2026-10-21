import { escapeHtml as esc } from '../../../utils/escapeHtml'
import { npr2 } from '../../../shared/nepalMoney'
import { nepalTime } from '../../../shared/nepalTime'
import { amountInWords, bsDay, closeQuietly, writeAndPrint } from '../customers/creditReceiptHtml'
import { depositReceiptLabel } from './depositState'

// The deposit receipt (S854): an 80mm slip in the bill own layout family, the payment receipt CSS of
// S843, so it comes off the same printer looking like it belongs. A pure string builder (no React, no
// Supabase), every typed value through escapeHtml.
//
// It is NOT a tax invoice and carries no VAT or PAN block (owner decision): VAT is charged on the final
// bill, which the deposit pays in part as its Deposit payment line. A reprint after the bill or a refund
// shows what the deposit paid and what went back, so the paper the guest holds matches the books.

const SLIP_CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:"Courier New",monospace; font-size:11px; width:80mm; padding:8px 10px; margin:0 auto; color:#000; }
  .c   { text-align:center; }
  .b   { font-weight:bold; }
  .lg  { font-size:15px; letter-spacing:1px; }
  hr   { border:none; border-top:1px dashed #000; margin:6px 0; }
  .row { display:flex; justify-content:space-between; align-items:baseline; padding:2px 0; gap:6px; }
  .row span:last-child { text-align:right; }
  .tot  { font-weight:bold; font-size:13px; }
  .copy { font-size:11px; letter-spacing:1px; }
  .void { border:2px solid #000; padding:4px; margin:6px 0; text-align:center; font-weight:bold; }
`

/** The line the receipt states its purpose with (the owner wording). */
export const DEPOSIT_RECEIPT_PURPOSE = 'Advance against booking. VAT is charged on the final bill.'

/**
 * The receipt. `deposit` is the pos_booking_deposits row (as stored, or as a deposit function
 * answered); `booking` { customer_name, phone, party_size, reserved_for }; `takenBy` and `refundedBy`
 * the names of who took and who refunded it; `outlet` { name, address, phone }; `copyLabel` empty on
 * the first print, COPY on a reprint.
 */
export function buildDepositReceiptHtml({ deposit, booking = {}, takenBy = '', refundedBy = '', outlet = {}, copyLabel = '' }) {
  const d = deposit || {}
  const b = booking || {}
  const label = depositReceiptLabel(d)
  const used = Number(d.used_amount) || 0
  const refunded = Number(d.refunded_amount) || 0
  const bookedFor = b.reserved_for ? `${bsDay(b.reserved_for)}, ${nepalTime(b.reserved_for)}` : ''
  const refundBlock = refunded > 0
    ? `<div class="void">REFUNDED NPR ${npr2(refunded)}<br><span style="font-weight:normal">by ${esc(d.refund_method || d.method || '')}${d.refunded_at ? `, ${esc(bsDay(d.refunded_at))} ${esc(nepalTime(d.refunded_at))}` : ''}${refundedBy ? `<br>by ${esc(refundedBy)}` : ''}</span></div>`
    : ''

  return `<!DOCTYPE html>
<html><head><title>Deposit Receipt ${esc(label)}</title>
<style>${SLIP_CSS}</style>
</head><body>
  ${outlet.name ? `<div class="c b" style="font-size:13px">${esc(outlet.name)}</div>` : ''}
  ${outlet.address ? `<div class="c" style="font-size:11px">${esc(outlet.address)}</div>` : ''}
  ${outlet.phone ? `<div class="c" style="font-size:11px">${esc(outlet.phone)}</div>` : ''}
  <div class="c b lg" style="margin-top:4px">DEPOSIT RECEIPT</div>
  <div class="c b">अग्रिम रकम प्राप्ति रसिद</div>
  ${copyLabel ? `<div class="c copy">${esc(copyLabel)}</div>` : ''}
  ${refundBlock}
  <hr>
  <div class="row"><span>Receipt No:</span><span class="b">${esc(label)}</span></div>
  <div class="row"><span>Fiscal Year:</span><span>${esc(d.invoice_fy || '')}</span></div>
  <div class="row"><span>Miti:</span><span>${esc(bsDay(d.taken_at))}</span></div>
  <div class="row"><span>Time:</span><span>${esc(nepalTime(d.taken_at))}</span></div>
  <hr>
  <div class="row"><span>Received from:</span><span class="b">${esc(b.customer_name || '')}</span></div>
  ${b.phone ? `<div class="row"><span>Phone:</span><span>${esc(b.phone)}</span></div>` : ''}
  ${b.party_size ? `<div class="row"><span>Party:</span><span>${esc(b.party_size)} guests</span></div>` : ''}
  ${bookedFor ? `<div class="row"><span>Booking for:</span><span>${esc(bookedFor)}</span></div>` : ''}
  <hr>
  <div class="row tot"><span>Amount:</span><span>NPR ${npr2(d.amount)}</span></div>
  <div style="font-size:11px; margin:4px 0">${esc(amountInWords(d.amount))}</div>
  <div class="row"><span>Paid by:</span><span>${esc(d.method || '')}</span></div>
  ${d.notes ? `<div class="row"><span>Note:</span><span>${esc(d.notes)}</span></div>` : ''}
  ${used > 0 ? `<div class="row"><span>Used on the bill:</span><span>${npr2(used)}</span></div>` : ''}
  <hr>
  <div style="font-size:11px; margin:2px 0">${esc(DEPOSIT_RECEIPT_PURPOSE)}</div>
  <hr>
  <div class="row"><span>Received by:</span><span>${esc(takenBy || '')}</span></div>
  <div style="margin-top:16px">
    <div class="row"><span style="border-bottom:1px solid #000; width:60%; display:inline-block">&nbsp;</span></div>
    <div class="row" style="font-size:10px; margin-top:2px"><span>Signature</span></div>
  </div>
  <hr>
  <div class="c" style="font-size:10px">This is a receipt for an advance, not a tax invoice. Any amount not used on the bill is refunded the way it was paid.</div>
</body></html>`
}

/**
 * Prints one receipt into `w`, a window opened on the press itself (before anything was awaited, so
 * the browser keeps the click permission to open it). Nothing prints without the outlet letterhead:
 * the window is closed and `error` says why. Returns `{ printed, error }`.
 */
export function printDepositReceipt(w, { deposit, booking, takenBy, refundedBy, outlet, copyLabel = '' }) {
  if (!w) return { printed: false, error: { blocked: true, message: 'The print window was blocked. Allow pop-ups for this site, then press Print deposit receipt on the booking.' } }
  if (!outlet || !outlet.name) {
    closeQuietly(w)
    return { printed: false, error: { message: 'The outlet name could not be read, so the receipt was not printed. Reload the page, then print it from the booking.' } }
  }
  const printed = writeAndPrint(w, buildDepositReceiptHtml({ deposit, booking, takenBy, refundedBy, outlet, copyLabel }))
  return { printed, error: printed ? null : { message: 'The print window was closed before the receipt could go into it. Print it again from the booking.' } }
}
