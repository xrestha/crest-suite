// Credit Note print builder — satisfies Nepal VAT Rules 2053, Rule 20(1)(a)-(h): serial number,
// date of issue, supplier name/address/registration, recipient name/address/registration, number+
// date of the original tax invoice, goods/service + credit details, amount credited, tax credited.
// Same 80mm thermal layout family as buildBillHtml/buildCompSlipHtml in PosOrders.jsx, kept in its
// own module (not PosOrders.jsx) so it can be printed/reprinted from both the Recent Bills quick
// action and the standalone Credit Notes page without either depending on the other's state.

import { numberToWordsNpr } from '../../../utils/numberToWords'
import { scopedUpdate } from '../../../shared/scopedDb'
import { escapeHtml as esc } from '../../../utils/escapeHtml'
import { settleWithin } from '../../../utils/withTimeout'

// Imported (and re-exported for existing callers) rather than defined here. This file used to
// carry its own ORIGINAL-COPY/SECOND-COPY/THIRD-COPY/REPRINT#n copy — the exact scheme
// posOrdersConstants deliberately abandoned (it borrows Rule 17(2)'s triplicate wording for
// sequential reprints, which don't map) — so a bill and its own credit note, printed minutes
// apart, carried contradictory copy labels. One definition, one convention.
import { COPY_LABEL } from '../orders/posOrdersConstants'
import { nepalTime, nepalDateAd, nepalBsLong } from '../../../shared/nepalTime'
import { npr2 } from '../../../shared/nepalMoney'
// The bill's own choices row (S758) and item rows (S839: a combo is one row with its dishes under it),
// so the note's lines read as they did on the bill.
// A line's choices as the bill printed them (S809 4c, CREDIT-NOTES-8): two "Chicken Momo" lines at
// 400.00 and 550.00 were unexplained on the note. Both item reads (the issuing modal's and the Book's
// reprint) carry the stored pos_order_item_options embed, which withChoices turns into `options`; it
// lives beside billOptionRow since S862, as the bill's reprint reads the same way.
import { billOptionRow, billItemRowsHtml, withChoices, BILL_TABLE_CSS, BILL_TABLE_HEAD } from '../orders/posOrderPrintHtml'
import { printedQtyOf } from '../orders/comboBillRows'
import { invoiceCodeOf } from '../../../shared/invoiceCode'
export { COPY_LABEL }

// Round Off from the note's own stored figures, as they print (S809 4c, CREDIT-NOTES-8). The note's
// Net Credited is the bill's, rounded to the rupee, so on a VAT note Taxable 1,327.44 + VAT 172.57 =
// 1,500.01 printed above a Net Credited of 1,500.00 with nothing explaining the 0.01. A VAT note
// rounds from taxable + non-taxable + VAT, a PAN note from gross − discount. Each figure is taken as
// it prints (two decimals), so the printed lines always add up. Printed on every note, 0.00 when
// nothing was rounded (owner decision, the same as the bill).
export function creditNoteRoundOff(creditNote, vatReg) {
  const shown = n => Number((Number(n) || 0).toFixed(2))
  const before = vatReg
    ? shown(creditNote.taxable_amount) + shown(creditNote.non_taxable_amount) + shown(creditNote.vat_amount)
    : shown(creditNote.gross_amount) - shown(creditNote.discount_amount)
  // `|| 0` drops a float's -0, so nothing rounded prints 0.00, never "-0.00".
  return Math.round((shown(creditNote.net_amount) - before) * 100) / 100 || 0
}

// The copy a print makes when the server's count does not answer (S809 4c; since S828 5d the label
// normally comes from the count the print's own write returns, printCreditNote below). `counts` are
// every print count this page knows for the note. Counts only go up, so the highest is the truest.
export function nextCreditNoteCopy(...counts) {
  const count = Math.max(0, ...counts.map(c => Number(c) || 0)) + 1
  return { count, label: COPY_LABEL(count) }
}

// `billVat` (S809 2c, CREDIT-NOTES-5): the tax status of the BILL this note credits, from its own
// stamp (pos_orders.vat_registered). A note corrects a Tax Invoice or a PAN bill because its bill was
// one, so its VAT/PAN label and its Taxable/VAT lines follow the bill, not today's setting: a VAT
// note reprinted after a deregistration keeps the VAT its Net Credited includes. Today's setting
// answers only when the bill has no stamp (null).
export function buildCreditNoteHtml(creditNote, items, settings, outletName, hscMap, copyLabel, billVat = null) {
  const vatReg = typeof billVat === 'boolean' ? billVat : settings.is_vat_registered
  // S834 (D35): the code the note was printed under; today's only for one issued before notes kept theirs.
  const prefix = esc(invoiceCodeOf(creditNote, settings.invoice_prefix))
  const cnNo   = `CN${creditNote.credit_note_no}-${prefix}${prefix ? '-' : ''}${esc(creditNote.invoice_fy || '')}`
  const now       = new Date(creditNote.created_at || Date.now())
  const nowStr    = nepalTime(now)
  // Date and Miti as read IN NEPAL (S776), through the shared helpers the bill already uses. These
  // were the runtime's toLocaleDateString and adToBsSafe, so a note printed after 18:15 UTC by a viewer
  // abroad carried the next or previous day beside a Nepal-pinned clock.
  const adDateStr = nepalDateAd(now)
  const bsDateStr = nepalBsLong(now)
  const totalQty  = printedQtyOf(items)   // a combo once, as its bill counts it (S856)
  // Every figure prints through the bill's own npr2 (S833), bare as the bill prints it, so a note
  // reads 12,345.00 beside its bill rather than 12345.00. The maths (Round Off) stays on numbers;
  // npr2 rounds to the paisa as toFixed(2) did, so only the grouping changes.
  const roundOff  = creditNoteRoundOff(creditNote, vatReg)

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
${BILL_TABLE_CSS}
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
    ${BILL_TABLE_HEAD}
    <tbody>
      ${billItemRowsHtml(items, hscMap, (i, opts) => billOptionRow(withChoices(i), opts))}
    </tbody>
  </table>
  <hr>
  <div class="row"><span>Gross Amount:</span><span>${npr2(creditNote.gross_amount)}</span></div>
  <div class="row"><span>Discount:</span><span>${npr2(creditNote.discount_amount)}</span></div>
  ${vatReg ? `
  <div class="row"><span>Taxable:</span><span>${npr2(creditNote.taxable_amount)}</span></div>
  <div class="row"><span>Nontaxable:</span><span>${npr2(creditNote.non_taxable_amount)}</span></div>
  <div class="row"><span>VAT 13%:</span><span>${npr2(creditNote.vat_amount)}</span></div>
  ` : ''}
  <div class="row"><span>Round Off:</span><span>${roundOff > 0 ? '+' : ''}${npr2(roundOff)}</span></div>
  <div class="row tot"><span>Net Credited:</span><span>${npr2(creditNote.net_amount)}</span></div>
  <hr>
  <div class="row"><span>Total Qty:</span><span>${totalQty}</span></div>
  <hr>
  <div style="font-size:11px; margin:4px 0">Rs. ${numberToWordsNpr(creditNote.net_amount)} only</div>
  <hr>
  <div class="row" style="font-size:11px;color:#000"><span>Issued at:</span><span>${nowStr}</span></div>
  <div class="c" style="font-size:11px; margin-top:8px">This Credit Note corrects the referenced Tax Invoice / PAN Bill per VAT Rules 2053, Rule 20.</div>
</body></html>`
}

// How long a print waits for its copy count before printing anyway. The window is already open and
// says "Printing…", so this is a manager waiting at the till, not a background write.
export const CN_COUNT_MS = 8000

// What the count write sends (S828 5d). guard_pos_credit_note answers ANY print_count that differs
// from the stored one with the stored one + 1, as pos_parking_slips_guard does for a parking token,
// so the page never sends its own idea of the count: it sends a value no stored count can equal (the
// column starts at 0 and only goes up) and labels from what the server made of it. Two managers
// reprinting one note at the same moment each sent their page's count + 1 before this, so both
// stored one count and printed the same copy number.
export const CN_PRINT_COUNT_BUMP = -1

// noopener as a window.open feature makes the call return null (no way to then write/print/close
// the popup) — sever window.opener manually instead, on the reference we keep, for the same "can't
// reach back into the live app" protection without losing that reference.
function openCreditNoteWindow() {
  const w = window.open('', '_blank', 'width=340,height=480,left=200,top=100')
  if (!w) return null
  w.opener = null
  w.document.write('<p style="font-family:sans-serif;color:#555;padding:24px">Printing…</p>')
  return w
}

function writeAndPrint(w, html) {
  // .open() clears "Printing…": document.write() on a still-open document appends instead.
  w.document.open()
  w.document.write(html)
  w.document.close()
  w.focus()
  setTimeout(() => { w.print(); w.close() }, 300)
}

// Shared by first-print (issuance) and reprint (Credit Note Book) so print_count/copy-label
// behaves identically to buildBillHtml/printBill.
//
// Returns { printed, newCount, countError }. The window opens first, before anything is awaited, and
// nothing is counted when the browser blocks it (S754: a blocked pop-up used to advance the count, so
// the next real print came out as a later copy than any that existed). Then the count write, bounded;
// the label is the copy the SERVER counted (S828 5d). When that write is refused, does not answer or
// comes back without a higher count (a server older than 5d keeps the stored count for -1), the note
// still prints, labelled from the count this page knows, and `countError` says the count was not
// saved. A window closed before the note could go into it prints nothing (`printed: false`), though
// the server may already have counted that copy.
export async function printCreditNote(clientId, creditNote, items, settings, outletName, hscMap, billVat = null, { timeoutMs = CN_COUNT_MS } = {}) {
  const known = Number(creditNote.print_count) || 0
  const w = openCreditNoteWindow()
  if (!w) return { printed: false, newCount: known, countError: null }

  const { data, error } = await settleWithin(
    scopedUpdate('pos_credit_notes', clientId, { print_count: CN_PRINT_COUNT_BUMP })
      .eq('id', creditNote.id).select('print_count').maybeSingle(),
    timeoutMs, 'Saving the print count',
  )
  const counted = Number(data?.print_count)
  // Zero rows matched is a refusal too (RLS answers it with no error), so it is not a count.
  const countError = error
    || (data ? null : { message: 'pos_credit_notes: print count update matched no row' })
    || (counted > known ? null : { message: 'pos_credit_notes: the print count was not raised' })
  const newCount = countError ? nextCreditNoteCopy(known).count : counted

  if (w.closed) return { printed: false, newCount, countError }
  writeAndPrint(w, buildCreditNoteHtml(creditNote, items, settings, outletName, hscMap, COPY_LABEL(newCount), billVat))
  return { printed: true, newCount, countError }
}
