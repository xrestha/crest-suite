// Credit Note print builder — satisfies Nepal VAT Rules 2053, Rule 20(1)(a)-(h): serial number,
// date of issue, supplier name/address/registration, recipient name/address/registration, number+
// date of the original tax invoice, goods/service + credit details, amount credited, tax credited.
// Same 80mm thermal layout family as buildBillHtml/buildCompSlipHtml in PosOrders.jsx, kept in its
// own module (not PosOrders.jsx) so it can be printed/reprinted from both the Recent Bills quick
// action and the standalone Credit Notes page without either depending on the other's state.

import { adToBs, BS_MONTHS } from '../../../utils/bsCalendar'
import { numberToWordsNpr } from '../../../utils/numberToWords'
import { scopedUpdate } from '../../../shared/scopedDb'
import { escapeHtml as esc } from '../../../utils/escapeHtml'

// Imported (and re-exported for existing callers) rather than defined here. This file used to
// carry its own ORIGINAL-COPY/SECOND-COPY/THIRD-COPY/REPRINT#n copy — the exact scheme
// posOrdersConstants deliberately abandoned (it borrows Rule 17(2)'s triplicate wording for
// sequential reprints, which don't map) — so a bill and its own credit note, printed minutes
// apart, carried contradictory copy labels. One definition, one convention.
import { COPY_LABEL } from '../orders/posOrdersConstants'
export { COPY_LABEL }

export function buildCreditNoteHtml(creditNote, items, settings, outletName, hscMap, copyLabel) {
  const vatReg = settings.is_vat_registered
  const prefix = esc(settings.invoice_prefix || '')
  const cnNo   = `CN${creditNote.credit_note_no}-${prefix}${prefix ? '-' : ''}${esc(creditNote.invoice_fy || '')}`
  const now       = new Date(creditNote.created_at || Date.now())
  const nowStr    = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  const adDateStr = now.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const bs        = adToBs(now)
  const bsDateStr = `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`
  const totalQty  = items.reduce((s, i) => s + i.qty, 0)

  return `<!DOCTYPE html>
<html><head><title>Credit Note</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Courier New',monospace; font-size:11px; width:80mm; padding:8px 10px; margin:0 auto; color:#000; }
  .c   { text-align:center; }
  .b   { font-weight:bold; }
  .lg  { font-size:15px; letter-spacing:1px; }
  hr   { border:none; border-top:1px dashed #000; margin:6px 0; }
  .row { display:flex; justify-content:space-between; align-items:baseline; padding:2px 0; }
  table { width:100%; border-collapse:collapse; font-size:11px; table-layout:fixed; }
  th, td { text-align:left; padding:2px 4px 2px 0; word-wrap:break-word; }
  th:last-child, td:last-child { padding-right:0; }
  th:nth-child(1), td:nth-child(1) { width:19px; }
  th:nth-child(2), td:nth-child(2) { width:24px; }
  th:nth-child(4), td:nth-child(4) { width:26px; text-align:center; padding-right:0; }
  th:nth-child(5), td:nth-child(5) { width:46px; text-align:right; }
  th:nth-child(6), td:nth-child(6) { width:54px; text-align:right; }
  .tot  { font-weight:bold; font-size:13px; }
  .copy { font-size:11px; letter-spacing:1px; }
</style>
</head><body>
  ${outletName ? `<div class="c b" style="font-size:13px">${esc(outletName)}</div>` : ''}
  ${settings.property_address ? `<div class="c" style="font-size:11px">${esc(settings.property_address)}</div>` : ''}
  ${settings.property_phone ? `<div class="c" style="font-size:11px">${esc(settings.property_phone)}</div>` : ''}
  ${settings.vat_number ? `<div class="c" style="font-size:11px">${vatReg ? 'VAT No' : 'PAN No'}: ${esc(settings.vat_number)}</div>` : ''}
  <div class="c b lg" style="margin-top:4px">CREDIT NOTE</div>
  <div class="c copy">${esc(copyLabel)}</div>
  <hr>
  <div class="row"><span>CN No:</span><span class="b">${cnNo}</span></div>
  <div class="row"><span>Date:</span><span>${adDateStr}</span></div>
  <div class="row"><span>Miti:</span><span>${bsDateStr}</span></div>
  <div class="row"><span>Ref. Invoice:</span><span class="b">${esc(creditNote.original_invoice_label)}</span></div>
  <div class="row"><span>Invoice Date:</span><span>${esc(creditNote.original_invoice_date_bs)}</span></div>
  <div class="row"><span>Name:</span><span>${esc(creditNote.buyer_name || '')}</span></div>
  <div class="row"><span>Address:</span><span>${esc(creditNote.buyer_address || '')}</span></div>
  <div class="row"><span>PAN No: ${esc(creditNote.buyer_pan || '')}</span><span>Phone: ${esc(creditNote.buyer_phone || '')}</span></div>
  <div class="row"><span>Reason:</span><span>${esc(creditNote.reason)}</span></div>
  <hr>
  <table>
    <thead><tr><th>Sn</th><th>HSC</th><th>Particulars</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
    <tbody>
      ${items.map((i, idx) => `<tr><td>${idx + 1}</td><td>${esc(hscMap[i.recipe_id] || '')}</td><td>${esc(i.name)}</td><td>${i.qty}</td><td>${i.unit_price.toFixed(2)}</td><td>${(i.qty * i.unit_price).toFixed(2)}</td></tr>`).join('')}
    </tbody>
  </table>
  <hr>
  <div class="row"><span>Gross Amount:</span><span>${creditNote.gross_amount.toFixed(2)}</span></div>
  <div class="row"><span>Discount:</span><span>${creditNote.discount_amount.toFixed(2)}</span></div>
  ${vatReg ? `
  <div class="row"><span>Taxable:</span><span>${creditNote.taxable_amount.toFixed(2)}</span></div>
  <div class="row"><span>Nontaxable:</span><span>${creditNote.non_taxable_amount.toFixed(2)}</span></div>
  <div class="row"><span>VAT 13%:</span><span>${creditNote.vat_amount.toFixed(2)}</span></div>
  ` : ''}
  <div class="row tot"><span>Net Credited:</span><span>${creditNote.net_amount.toFixed(2)}</span></div>
  <hr>
  <div class="row"><span>Total Qty:</span><span>${totalQty}</span></div>
  <hr>
  <div style="font-size:11px; margin:4px 0">Rs. ${numberToWordsNpr(creditNote.net_amount)} only</div>
  <hr>
  <div class="row" style="font-size:11px;color:#000"><span>Issued at:</span><span>${nowStr}</span></div>
  <div class="c" style="font-size:11px; margin-top:8px">This Credit Note corrects the referenced Tax Invoice / PAN Bill per VAT Rules 2053, Rule 20.</div>
</body></html>`
}

export function printCreditNoteHtml(html, onPopupBlocked) {
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

// Shared by first-print (issuance) and reprint (Credit Note Book) so print_count/copy-label
// behaves identically to buildBillHtml/printBill.
export async function printCreditNote(clientId, creditNote, items, settings, outletName, hscMap) {
  const newCount = (creditNote.print_count || 0) + 1
  await scopedUpdate('pos_credit_notes', clientId, { print_count: newCount }).eq('id', creditNote.id)
  printCreditNoteHtml(buildCreditNoteHtml(creditNote, items, settings, outletName, hscMap, COPY_LABEL(newCount)))
}
