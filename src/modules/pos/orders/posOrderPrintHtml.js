import { BS_MONTHS } from '../../../utils/bsCalendar'
import { nepalTime, nepalBs, nepalDateAd } from '../../../shared/nepalTime'
import { numberToWordsNpr } from '../../../utils/numberToWords'
import { npr2, nprPaisa } from '../../../shared/nepalMoney'
import { computeOrderAmounts, billVatRegistered } from '../../../utils/posBillingMath'
import { escapeHtml as esc } from '../../../utils/escapeHtml'
import { kotBotDoc, voidSlipDoc, moveSlipDoc, renderTicketDocHtml } from '../printing/ticketDoc'
import { invoiceCodeOf } from '../../../shared/invoiceCode'
import { groupComboLines } from './comboBillRows'

// Pure 80mm-thermal HTML builders for PosOrders.jsx — no React, no Supabase, no component state.
// Everything they need (outlet/billing settings, table name, cashier name, HSC codes) is passed
// in explicitly so the same functions back both the real print (printBill/printCompSlip) and the
// live in-modal preview, and so they can be unit-tested independently of the component.

// The three station slips are documents since S837 (kitchen and bar printers): ticketDoc.js
// describes each one once, and the till's print window, the print station page and the Crest Print
// Helper render that description, so the paper is the same whoever prints it.
export function buildKotBotHtml(args) {
  return renderTicketDocHtml(kotBotDoc(args))
}

export function buildVoidSlipHtml(args) {
  return renderTicketDocHtml(voidSlipDoc(args))
}

export function buildMoveSlipHtml(args) {
  return renderTicketDocHtml(moveSlipDoc(args))
}

// One bill line per dish at its combined price, with the choices listed underneath (owner decision,
// S758): a paid choice with what it added, a free one by name. The Rate column is still unit_price,
// so nothing in the bill's arithmetic changes. Exported for the credit note's copy of the lines.
// `indent` (px) sets the row in under a combo's dish (S839); left out, the row prints as it always has.
export function billOptionRow(i, { indent = 0 } = {}) {
  if (!i.options?.length && !i.option_summary) return ''
  const text = i.options?.length
    ? i.options.map(o => {
        const d = Math.round(Number(o.price_delta) || 0)
        return esc(o.option_name || '') + (d ? ` ${d > 0 ? '+' : '−'}${Math.abs(d)}` : '')
      }).join(', ')
    : esc(i.option_summary)
  return `<tr><td></td><td></td><td colspan="4" style="font-size:10px;padding-top:0${indent ? `;padding-left:${indent}px` : ''}">${text}</td></tr>`
}

// Combos (S839, docs/pos-combos.md): how far a combo's dishes, and their choices, sit in under it.
const COMBO_DISH_INDENT = 10
const COMBO_CHOICE_INDENT = 18

// The item rows of a bill or a credit note. An ordinary line prints as it always has: S.N., HSC, name,
// qty, rate, amount, and its choices under it. The dishes of one combo (groupComboLines) print as ONE
// row at the place of its first dish: the combo's name, no HSC, its quantity, amount = the sum of its
// dishes' qty × unit_price and rate = amount ÷ qty; each dish is listed under it by name, unpriced,
// with its own choices (whose charges are inside the combo's amount). S.N. counts printed rows.
// `optionRowOf(line, opts)` prints a line's choices: the credit note passes its reader of the stored ones.
export function billItemRowsHtml(items, hscMap, optionRowOf = billOptionRow) {
  return groupComboLines(items).map((r, idx) => (r.combo
    ? `<tr><td>${idx + 1}</td><td></td><td>${esc(r.name)}</td><td>${r.qty}</td><td>${npr2(r.rate)}</td><td>${npr2(r.amount)}</td></tr>` +
      r.dishes.map(d => `<tr><td></td><td></td><td colspan="4" style="padding-top:0;padding-left:${COMBO_DISH_INDENT}px">${esc(d.name)}</td></tr>${optionRowOf(d, { indent: COMBO_CHOICE_INDENT })}`).join('')
    : `<tr><td>${idx + 1}</td><td>${esc(hscMap[r.item.recipe_id] || '')}</td><td>${esc(r.item.name)}</td><td>${r.item.qty}</td><td>${npr2(r.item.unit_price)}</td><td>${npr2(r.item.qty * r.item.unit_price)}</td></tr>${optionRowOf(r.item)}`
  )).join('')
}

export function buildBillHtml({ order, items, copyLabel, qrUrl, payments, qrAmount, outletName, billingSettings, hscMap, tableName, cashierName }) {
  // S809 2c (CHECKOUT-6): a closed bill prints as the type it was issued as, from its own stamp, so a
  // reprint after the outlet's VAT registration changed keeps its heading, its VAT and its total.
  // Today's setting decides only an order with no stamp (the live preview of an open order).
  const vatReg      = billVatRegistered(order, billingSettings.is_vat_registered)
  // S834 (D35): the code the bill was printed under; today's only for one closed before bills kept theirs.
  const prefix      = esc(invoiceCodeOf(order, billingSettings.invoice_prefix))
  const invoiceNo   = order.invoice_no != null
    ? `${vatReg ? 'TI' : 'PB'}${order.invoice_no}-${prefix}${prefix ? '-' : ''}${esc(order.invoice_fy || '')}`
    : `${vatReg ? 'TI' : 'PB'}-(on confirm)`
  // The bill's OWN moment, not the print moment (S670). This was `new Date()`, so a reprint — and
  // every preview opened from the Sales Report's Bill Register, which is exactly what that row
  // click does — stamped the slip with today's date and time. A month-old bill reprinted for a
  // customer therefore carried the wrong date on the document itself.
  // Falls back to now only for a bill being closed right now, which has no closed_at yet.
  const stamp       = order.closed_at ? new Date(order.closed_at) : new Date()
  const nowStr      = nepalTime(stamp)
  const adDateStr   = nepalDateAd(stamp)
  const bs          = nepalBs(stamp)
  const bsDateStr   = bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : ''
  const payLabel    = order.payment_method || ''
  // Split payment — multiple tenders against one bill/one invoice number (not a split bill).
  // `payments` is [{ method, amount }], sourced either from pos_order_payments (real print) or
  // the live `tenders` state (in-modal preview) — same shape either way.
  const isSplitBill = payLabel === 'Split' && payments && payments.length > 0

  const { grossAmt, discount, taxableBase, nonTaxableBase, vatAmt: netVatAmt, net, roundOff, totalQty } =
    computeOrderAmounts(order, items, vatReg)
  const tendered = order.tendered_amount ?? net
  const change   = !isSplitBill && payLabel === 'Cash' ? Math.max(0, tendered - net) : 0
  // Nothing was handed over on a Credit bill, so it says what is owed rather than printing a Tender
  // and a Change as if the guest had paid (S809 CHECKOUT-13).
  const onCredit = !isSplitBill && payLabel === 'Credit'
  // Round Off prints on EVERY bill, PAN bills included (S809 CHECKOUT-13, owner decision): a PAN bill
  // of 1,172.48 printed Net 1,172.00 with nothing explaining the 0.48. Rounded to the paisa it prints
  // in, so nothing rounded reads 0.00, never "+0.00" or a float's "-0.00" (`|| 0` drops a -0).
  const roundOffShown = Math.round(roundOff * 100) / 100 || 0

  return `<!DOCTYPE html>
<html><head><title>Bill</title>
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
  ${billingSettings.property_address ? `<div class="c" style="font-size:11px">${esc(billingSettings.property_address)}</div>` : ''}
  ${billingSettings.property_phone ? `<div class="c" style="font-size:11px">${esc(billingSettings.property_phone)}</div>` : ''}
  ${billingSettings.vat_number ? `<div class="c" style="font-size:11px">${vatReg ? 'VAT No' : 'PAN No'}: ${esc(billingSettings.vat_number)}</div>` : ''}
  <div class="c b lg" style="margin-top:4px">${vatReg ? 'TAX INVOICE' : 'BILL'}</div>
  ${copyLabel ? `<div class="c copy">${esc(copyLabel)}</div>` : ''}
  <hr>
  <div class="row"><span>Bill No:</span><span class="b">${invoiceNo}</span></div>
  <div class="row"><span>Date:</span><span>${adDateStr}</span></div>
  <div class="row"><span>Miti:</span><span>${bsDateStr}</span></div>
  <div class="row"><span>Name:</span><span>${esc(order.buyer_name || '')}</span></div>
  <div class="row"><span>Address:</span><span>${esc(order.buyer_address || '')}</span></div>
  <div class="row"><span>PAN No: ${esc(order.buyer_pan || '')}</span><span>Phone: ${esc(order.buyer_phone || '')}</span></div>
  <div class="row"><span>Payment Mode:</span><span>${isSplitBill ? 'Split' : esc(payLabel)}</span></div>
  <div class="row"><span>Remarks:</span><span>${esc(order.bill_remarks || '')}</span></div>
  <div class="row" style="font-size:11px;color:#000"><span>${tableName === 'Takeaway' ? 'Takeaway' : `Dine-In: ${esc(tableName)}`}</span><span>Covers: ${order.covers ?? ''}</span></div>
  <div class="row" style="font-size:11px;color:#000"><span>Cashier: ${esc(cashierName || '')}</span><span>${nowStr}</span></div>
  <hr>
  <table>
    <thead><tr><th>Sn</th><th>HSC</th><th>Particulars</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
    <tbody>
      ${billItemRowsHtml(items, hscMap)}
    </tbody>
  </table>
  <hr>
  <div class="row"><span>Gross Amount:</span><span>${npr2(grossAmt)}</span></div>
  <div class="row"><span>Discount:</span><span>${npr2(discount)}</span></div>
  ${vatReg ? `
  <div class="row"><span>Taxable:</span><span>${npr2(taxableBase)}</span></div>
  <div class="row"><span>Nontaxable:</span><span>${npr2(nonTaxableBase)}</span></div>
  <div class="row"><span>VAT 13%:</span><span>${npr2(netVatAmt)}</span></div>
  ` : ''}
  <div class="row"><span>Round Off:</span><span>${roundOffShown > 0 ? '+' : ''}${npr2(roundOffShown)}</span></div>
  <div class="row tot"><span>Net Amount:</span><span>${npr2(net)}</span></div>
  <hr>
  ${isSplitBill ? payments.map(p => `<div class="row"><span>${esc(p.method)}:</span><span>${npr2(p.amount)}</span></div>`).join('') : onCredit ? `
  <div class="row b"><span>Amount on credit:</span><span>${npr2(net)}</span></div>
  ` : `
  <div class="row"><span>Tender:</span><span>${npr2(tendered)}</span></div>
  <div class="row"><span>Change:</span><span>${npr2(change)}</span></div>
  `}
  <hr>
  <div class="row"><span>Total Qty:</span><span>${totalQty}</span></div>
  <hr>
  <div style="font-size:11px; margin:4px 0">Rs. ${numberToWordsNpr(net)} only</div>
  <hr>
  ${qrUrl ? `
  <div class="c" style="margin:6px 0">
    <img src="${qrUrl}" alt="Scan to pay" style="width:120px;height:120px;display:block;margin:0 auto" />
    <div style="font-size:11px;margin-top:2px">Scan to pay ${(qrAmount ?? net).toFixed(0)} — amount pre-filled</div>
  </div>
  <hr>
  ` : ''}
  ${payLabel === 'Credit' ? `
  <div style="margin-top:16px">
    <div class="row">
      <span style="border-bottom:1px solid #000; width:60%; display:inline-block">&nbsp;</span>
      <span style="border-bottom:1px solid #000; width:32%; display:inline-block">&nbsp;</span>
    </div>
    <div class="row" style="font-size:10px; margin-top:2px">
      <span>Customer Signature</span><span>Date</span>
    </div>
  </div>
  ` : ''}
  <div class="c" style="font-size:11px">Thank you for stopping by! We hope to see you again soon.</div>
</body></html>`
}

// Optional courtesy slip for one split-payment tender — not a Tax Invoice/PAN Bill, just proof
// of that person's own payment while the rest of the table is still settling up. The one real
// invoice still only prints once, at full close, via buildBillHtml above.
export function buildTenderSlipHtml({ tender, remainingAfter, outletName, tableName }) {
  const nowStr    = nepalTime(new Date())
  const change    = tender.tenderedAmount != null ? Math.max(0, tender.tenderedAmount - tender.amount) : 0

  return `<!DOCTYPE html>
<html><head><title>Payment Slip</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Courier New',monospace; font-size:11px; width:80mm; padding:8px 10px; margin:0 auto; color:#000; }
  .c   { text-align:center; }
  .b   { font-weight:bold; }
  hr   { border:none; border-top:1px dashed #000; margin:6px 0; }
  .row { display:flex; justify-content:space-between; align-items:baseline; padding:2px 0; }
  .tot { font-weight:bold; font-size:12px; }
</style>
</head><body>
  ${outletName ? `<div class="c b" style="font-size:13px">${esc(outletName)}</div>` : ''}
  <div class="c" style="font-size:11px; margin-top:2px">Payment Received</div>
  <hr>
  <div class="row"><span>Table:</span><span>${esc(tableName)}</span></div>
  <div class="row"><span>Method:</span><span class="b">${esc(tender.method)}</span></div>
  <div class="row tot"><span>Amount:</span><span>NPR ${npr2(tender.amount)}</span></div>
  ${tender.tenderedAmount != null ? `
  <div class="row"><span>Tendered:</span><span>${npr2(tender.tenderedAmount)}</span></div>
  <div class="row"><span>Change:</span><span>${npr2(change)}</span></div>
  ` : ''}
  <hr>
  <div class="row"><span>Remaining on bill:</span><span>${remainingAfter > 0 ? `NPR ${npr2(remainingAfter)}` : 'Paid in full'}</span></div>
  <div class="row" style="font-size:10px; margin-top:6px"><span>Not a Tax Invoice / PAN Bill</span><span>${nowStr}</span></div>
  <hr>
  <div class="c" style="font-size:11px">Thank you for stopping by! We hope to see you again soon.</div>
</body></html>`
}

// Equal split (S836, owner decision): the table keeps ONE tax invoice, printed when the bill is paid,
// and each guest is handed a slip saying what their share is. Not a Tax Invoice or PAN Bill, and the
// slip says so at the top and again at the foot, because the guest walks away with it. One slip per
// share, each on its own page so the printer cuts between them. `shares` comes from equalShares
// (shareSplit.js); this prints what it is given and does no arithmetic of its own. Stamped with the
// moment the split was printed (`printedAt`); there is no bill moment yet, the bill is still open.
export function buildShareSlipsHtml({ outletName, tableName, orderNo, total, shares, printedAt }) {
  const stamp  = printedAt ? new Date(printedAt) : new Date()
  const bs     = nepalBs(stamp)
  const date   = bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : ''
  const nowStr = nepalTime(stamp)
  const list   = shares || []
  const n      = list.length
  const billNo = orderNo != null ? `#${esc(String(orderNo))}` : ''

  return `<!DOCTYPE html>
<html><head><title>Share Slips</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Courier New',monospace; font-size:11px; width:80mm; margin:0 auto; color:#000; }
  .slip { padding:8px 10px; }
  .slip + .slip { break-before:page; page-break-before:always; }
  .c   { text-align:center; }
  .b   { font-weight:bold; }
  .lg  { font-size:15px; letter-spacing:1px; }
  .amt { font-size:24px; letter-spacing:1px; padding:4px 0; }
  hr   { border:none; border-top:1px dashed #000; margin:6px 0; }
  .row { display:flex; justify-content:space-between; align-items:baseline; padding:2px 0; }
</style>
</head><body>
${list.map((amount, i) => `<div class="slip">
  ${outletName ? `<div class="c b" style="font-size:13px">${esc(outletName)}</div>` : ''}
  <div class="c b lg" style="margin-top:4px">SHARE ${i + 1} OF ${n}</div>
  <div class="c" style="font-size:11px">Not a tax invoice</div>
  <hr>
  <div class="row"><span>Table:</span><span class="b">${esc(tableName || 'Takeaway')}</span></div>
  <div class="row"><span>Bill:</span><span class="b">${billNo}</span></div>
  <div class="row"><span>Bill total:</span><span>NPR ${nprPaisa(total)}</span></div>
  <div class="row"><span>Split:</span><span>${n} equal shares</span></div>
  <hr>
  <div class="c">Share ${i + 1} of ${n}</div>
  <div class="c b amt">NPR ${nprPaisa(amount)}</div>
  <hr>
  <div class="row" style="font-size:11px;color:#000"><span>${date}</span><span>${nowStr}</span></div>
  <div class="c" style="font-size:11px;margin-top:4px">Not a tax invoice — the tax invoice prints when the bill is paid.</div>
</div>`).join('\n')}
</body></html>`
}

// Complimentary items were never sold — this is an internal cost-tracking slip, not a Tax
// Invoice or PAN Bill: no VAT/PAN, own NC-prefixed sequence (separate from TI/PB), and line
// amounts are valued at food cost (not menu price) so the P&L impact isn't distorted by
// retail pricing. Standard practice per restaurant accounting for comps.
// `plateCostOf(line)` is one plate's food cost: the dish's recipe cost plus that line's choices
// (posRecipeBook.posLineCosts), so "Momo + extra cheese" is costed with its cheese and a
// build-your-own bowl with its toppings. It used to be costMap[recipe_id], the recipe alone.
export function buildCompSlipHtml({ order, items, plateCostOf, copyLabel, outletName, tableName, authorizedBy }) {
  const ncNo      = order.invoice_no != null ? `NC-${String(order.invoice_no).padStart(2, '0')}` : 'NC-(on confirm)'
  // The slip's OWN moment, not the moment it was reprinted — see buildBillHtml above. The
  // fallback is load-bearing, not padding: the in-modal preview renders before the order is
  // closed, so closed_at genuinely does not exist yet on that path.
  const stamp     = order.closed_at ? new Date(order.closed_at) : new Date()
  const nowStr    = nepalTime(stamp)
  const adDateStr = nepalDateAd(stamp)
  const bs        = nepalBs(stamp)
  const bsDateStr = bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : ''

  const totalQty  = items.reduce((s, i) => s + i.qty, 0)
  const lineCost  = i => i.qty * (Number(plateCostOf?.(i)) || 0)
  const totalCost = items.reduce((s, i) => s + lineCost(i), 0)
  // A combo is one row here too (S839, groupComboLines): its name, its quantity, and the food cost of
  // all its dishes, which are listed under it by name. Every other line prints as it always has.
  const itemRow = i => `<tr><td>${esc(i.name)}${i.option_summary ? `<div style="font-size:10px">${esc(i.option_summary)}</div>` : ''}</td><td>${i.qty}</td><td>${npr2(lineCost(i))}</td></tr>`
  const comboRow = r => `<tr><td>${esc(r.name)}${r.dishes.map(d =>
    `<div style="font-size:10px;padding-left:${COMBO_DISH_INDENT}px">${esc(d.name)}</div>${d.option_summary ? `<div style="font-size:10px;padding-left:${COMBO_CHOICE_INDENT}px">${esc(d.option_summary)}</div>` : ''}`).join('')}</td><td>${r.qty}</td><td>${npr2(r.lines.reduce((s, l) => s + lineCost(l), 0))}</td></tr>`

  return `<!DOCTYPE html>
<html><head><title>Complimentary Slip</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Courier New',monospace; font-size:11px; width:80mm; padding:8px 10px; margin:0 auto; color:#000; }
  .c   { text-align:center; }
  .b   { font-weight:bold; }
  .lg  { font-size:14px; letter-spacing:1px; }
  hr   { border:none; border-top:1px dashed #000; margin:6px 0; }
  .row { display:flex; justify-content:space-between; align-items:baseline; padding:2px 0; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th, td { text-align:left; padding:2px 0; }
  th:last-child, td:last-child { text-align:right; }
  .tot  { font-weight:bold; font-size:12px; }
  .copy { font-size:11px; letter-spacing:1px; }
</style>
</head><body>
  ${copyLabel ? `<div class="c copy">${esc(copyLabel)}</div>` : ''}
  ${outletName ? `<div class="c b" style="font-size:13px">${esc(outletName)}</div>` : ''}
  <div class="c b lg" style="margin-top:4px">COMPLIMENTARY SLIP</div>
  <div class="c" style="font-size:11px">Internal record — not a Tax Invoice or PAN Bill</div>
  <hr>
  <div class="row"><span>No:</span><span class="b">${ncNo}</span></div>
  <div class="row"><span>Order Ref:</span><span>#${order.order_no ?? ''}</span></div>
  <div class="row"><span>Table:</span><span>${esc(tableName)}</span></div>
  <div class="row"><span>Date:</span><span>${adDateStr}</span></div>
  <div class="row"><span>Miti:</span><span>${bsDateStr}</span></div>
  <div class="row"><span>Reason:</span><span>${esc(order.close_reason || '')}</span></div>
  <div class="row"><span>Authorized by:</span><span>${esc(authorizedBy || '')}</span></div>
  <div class="row"><span>Remarks:</span><span>${esc(order.bill_remarks || '')}</span></div>
  <hr>
  <table>
    <thead><tr><th>Item</th><th>Qty</th><th>Cost</th></tr></thead>
    <tbody>
      ${groupComboLines(items).map(r => (r.combo ? comboRow(r) : itemRow(r.item))).join('')}
    </tbody>
  </table>
  <hr>
  <div class="row"><span>Total Qty:</span><span>${totalQty}</span></div>
  <div class="row tot"><span>Total Food Cost:</span><span>NPR ${npr2(totalCost)}</span></div>
  <hr>
  <div class="row" style="font-size:11px;color:#000"><span>Table: ${esc(tableName)}</span><span>${nowStr}</span></div>
  <div style="margin-top:16px">
    <div class="row">
      <span style="border-bottom:1px solid #000; width:60%; display:inline-block">&nbsp;</span>
      <span style="border-bottom:1px solid #000; width:32%; display:inline-block">&nbsp;</span>
    </div>
    <div class="row" style="font-size:10px; margin-top:2px">
      <span>Customer Signature</span><span>Date</span>
    </div>
  </div>
</body></html>`
}
