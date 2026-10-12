import { BS_MONTHS } from '../../../utils/bsCalendar'
import { escapeHtml as esc } from '../../../utils/escapeHtml'
import { scopedUpdate } from '../../../shared/scopedDb'
import { nepalTime, nepalDateAd, nepalBs } from '../../../shared/nepalTime'
import { settleWithin } from '../../../utils/withTimeout'
// The bill's own copy convention (owner decision D8): the first print is the original and carries no
// label, every later one reads "COPY OF ORIGINAL - (N)". The token used to say "REPRINT #N" — and
// the guest's only token said "REPRINT #2" whenever the first print had been lost to a blocked pop-up.
import { COPY_LABEL } from '../orders/posOrdersConstants'

// Pure 80mm-thermal parking token builder — same shape as posOrderPrintHtml.js/creditNoteHtml.js.
// Not a bill: no items, no VAT — just a claim ticket so the vehicle number is what a valet reads
// back to reunite car with customer, so it prints large/bold as the single most prominent line.
export function buildParkingSlipHtml(slip, outletName, propertyAddress, issuedByName, copyLabel) {
  const now       = new Date(slip.time_in || Date.now())
  const nowStr    = nepalTime(now)
  // S754: Date and Miti pinned to Nepal like the Time In beside them. toLocaleDateString and
  // adToBsSafe(now) read the RUNTIME's day, so a token issued 00:15 Kathmandu printed the previous
  // day's date under that morning's time for any till not set to Nepal time.
  const adDateStr = nepalDateAd(now)
  const bs        = nepalBs(now)
  const bsDateStr = bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : ''

  return `<!DOCTYPE html>
<html><head><title>Parking Slip</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Courier New',monospace; font-size:11px; width:80mm; padding:8px 10px; margin:0 auto; color:#000; }
  .c   { text-align:center; }
  .b   { font-weight:bold; }
  .lg  { font-size:15px; letter-spacing:1px; }
  hr   { border:none; border-top:1px dashed #000; margin:6px 0; }
  .row { display:flex; justify-content:space-between; align-items:baseline; padding:2px 0; }
  .vehicle { font-size:26px; font-weight:bold; letter-spacing:1px; text-align:center; padding:8px 0; }
  .copy { font-size:11px; letter-spacing:1px; }
</style>
</head><body>
  ${outletName ? `<div class="c b" style="font-size:13px">${esc(outletName)}</div>` : ''}
  ${propertyAddress ? `<div class="c" style="font-size:11px">${esc(propertyAddress)}</div>` : ''}
  <div class="c b lg" style="margin-top:4px">PARKING TOKEN</div>
  ${copyLabel ? `<div class="c copy">${esc(copyLabel)}</div>` : ''}
  <hr>
  <div class="row"><span>Slip No:</span><span class="b">P-${slip.slip_no}</span></div>
  <div class="row"><span>Date:</span><span>${adDateStr}</span></div>
  <div class="row"><span>Miti:</span><span>${bsDateStr}</span></div>
  <div class="row"><span>Time In:</span><span class="b">${nowStr}</span></div>
  <hr>
  <div class="vehicle">${esc(slip.vehicle_number)}</div>
  ${slip.vehicle_type ? `<div class="c" style="margin-bottom:4px">${esc(slip.vehicle_type)}</div>` : ''}
  ${slip.customer_name ? `<div class="row"><span>Customer:</span><span>${esc(slip.customer_name)}</span></div>` : ''}
  ${slip.bill_invoice_no ? `<div class="row"><span>Bill No:</span><span>${esc(String(slip.bill_invoice_no))}</span></div>` : ''}
  <div class="row"><span>Issued By:</span><span>${esc(issuedByName || '')}</span></div>
  ${slip.notes ? `<hr><div style="font-size:10px">${esc(slip.notes)}</div>` : ''}
  <hr>
  <div class="c" style="font-size:11px; margin-top:4px">Please retain this slip — required to reclaim your vehicle.</div>
</body></html>`
}

// How long a print waits for its count before printing anyway. The window is already open and says
// "Printing…", so this is a guest standing at the desk, not a background write.
export const SLIP_COUNT_MS = 8000

// What the count write sends. pos_parking_slips_guard (20261009170000) answers ANY print_count that
// differs from the stored one with `OLD.print_count + 1`, so the tablet never sends its own idea of
// the count: it sends a value no stored count can equal (the column starts at 0 and only goes up)
// and reads back what the server made of it. Sending `local + 1` was a no-op whenever the tablet's
// copy was already current with another tablet's reprint, and the slip then printed one copy behind.
export const PRINT_COUNT_BUMP = -1

const POPUP_FEATURES = 'width=340,height=480,left=200,top=100'

/**
 * Open the print window NOW, on the tap (owner decision D10), before anything is awaited. A browser
 * allows a pop-up only inside the gesture that asked for it; opened after a database answer it is
 * blocked on Safari/iPad and often on Chrome over a slow connection (viewPosBill's reason). Returns
 * null when the browser refused it.
 */
export function openSlipWindow() {
  const w = window.open('', '_blank', POPUP_FEATURES)
  if (!w) return null
  // noopener as a window.open feature makes the call return null (no way to then write/print/
  // close the popup) — sever window.opener manually instead, on the reference we keep, for the
  // same "can't reach back into the live app" protection without losing that reference.
  w.opener = null
  w.document.write('<p style="font-family:sans-serif;color:#666;padding:24px">Printing…</p>')
  return w
}

function writeAndPrint(w, html) {
  w.document.open()
  w.document.write(html)
  w.document.close()
  w.focus()
  setTimeout(() => { w.print(); w.close() }, 300)
}

/**
 * Print a slip into a window opened on the tap (openSlipWindow), counting only a print that happens.
 * Shared by the first print (issue) and Reprint, like printCreditNote/printBill.
 *
 * Returns `{ printed, closed, count, countError }`:
 * - no window (blocked): nothing is written, `printed: false` — the next print is still the original;
 * - the window was closed before the token could go into it: `closed: true`, nothing printed;
 * - otherwise it prints with the label for `count`, the server's count after this print. When the
 *   count write is refused or does not answer it still prints, labelled from the count this page
 *   knows, and says so in `countError`: the guest is at the desk and a token beats no token.
 */
export async function printParkingSlip({ w, clientId, slip, outletName, propertyAddress, issuedByName, timeoutMs = SLIP_COUNT_MS }) {
  if (!w) return { printed: false, closed: false, count: null, countError: null }
  if (w.closed) return { printed: false, closed: true, count: null, countError: null }

  const { data, error } = await settleWithin(
    scopedUpdate('pos_parking_slips', clientId, { print_count: PRINT_COUNT_BUMP })
      .eq('id', slip.id).select('print_count').maybeSingle(),
    timeoutMs, 'Saving the print count',
  )
  // Zero rows matched is a refusal too (RLS answers it with no error), so it is not a count.
  const countError = error || (data ? null : { message: 'pos_parking_slips: print count update matched no row' })
  const count = countError ? (Number(slip.print_count) || 0) + 1 : Number(data.print_count)

  if (w.closed) return { printed: false, closed: true, count, countError }
  writeAndPrint(w, buildParkingSlipHtml(slip, outletName, propertyAddress, issuedByName, COPY_LABEL(count) || null))
  return { printed: true, closed: false, count, countError }
}
