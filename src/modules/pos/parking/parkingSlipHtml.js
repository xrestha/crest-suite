import { adToBs, BS_MONTHS } from '../../../utils/bsCalendar'
import { escapeHtml as esc } from '../../../utils/escapeHtml'
import { scopedUpdate } from '../../../shared/scopedDb'

// Pure 80mm-thermal parking token builder — same shape as posOrderPrintHtml.js/creditNoteHtml.js.
// Not a bill: no items, no VAT — just a claim ticket so the vehicle number is what a valet reads
// back to reunite car with customer, so it prints large/bold as the single most prominent line.
export function buildParkingSlipHtml(slip, outletName, propertyAddress, issuedByName, copyLabel) {
  const now       = new Date(slip.time_in || Date.now())
  const nowStr    = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  const adDateStr = now.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const bs        = adToBs(now)
  const bsDateStr = `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`

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

export function printParkingSlipHtml(html, onPopupBlocked) {
  // noopener as a window.open feature makes the call return null (no way to then write/print/
  // close the popup) — sever window.opener manually instead, on the reference we keep, for the
  // same "can't reach back into the live app" protection without losing that reference.
  const w = window.open('', '_blank', 'width=340,height=480,left=200,top=100')
  if (!w) { onPopupBlocked?.(); return false }
  w.opener = null
  w.document.write(html)
  w.document.close()
  w.focus()
  setTimeout(() => { w.print(); w.close() }, 300)
  return true
}

// Shared by first-print (issuance) and Reprint from the log, so print_count behaves identically
// to buildBillHtml/printBill and buildCreditNoteHtml/printCreditNote.
export async function printParkingSlip(clientId, slip, outletName, propertyAddress, issuedByName, onPopupBlocked) {
  const newCount = (slip.print_count || 0) + 1
  await scopedUpdate('pos_parking_slips', clientId, { print_count: newCount }).eq('id', slip.id)
  const copyLabel = newCount > 1 ? `REPRINT #${newCount}` : null
  printParkingSlipHtml(buildParkingSlipHtml(slip, outletName, propertyAddress, issuedByName, copyLabel), onPopupBlocked)
}
