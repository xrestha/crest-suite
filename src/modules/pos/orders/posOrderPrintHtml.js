import { adToBs, BS_MONTHS } from '../../../utils/bsCalendar'
import { numberToWordsNpr } from '../../../utils/numberToWords'
import { computeOrderAmounts } from '../../../utils/posBillingMath'

// Pure 80mm-thermal HTML builders for PosOrders.jsx — no React, no Supabase, no component state.
// Everything they need (outlet/billing settings, table name, cashier name, HSC codes) is passed
// in explicitly so the same functions back both the real print (printBill/printCompSlip) and the
// live in-modal preview, and so they can be unit-tested independently of the component.

export function buildKotBotHtml({ station, items, ticketNo, outletName, tableName, takenBy, covers }) {
  const now          = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  const bs           = adToBs(new Date())
  const date         = `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`
  const stationLabel = station === 'BOT' ? 'BAR ORDER TICKET' : 'KITCHEN ORDER TICKET'

  return `<!DOCTYPE html>
<html><head><title>${station}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Courier New',monospace; font-size:13px; width:80mm; padding:8px 10px; color:#000; }
  .c   { text-align:center; }
  .b   { font-weight:bold; }
  .lg  { font-size:17px; letter-spacing:1px; }
  hr   { border:none; border-top:1px dashed #000; margin:7px 0; }
  .row { display:flex; justify-content:space-between; align-items:baseline; padding:3px 0; }
  .qty { font-weight:bold; font-size:15px; min-width:34px; text-align:right; }
  .note { font-size:11px; font-style:italic; color:#000; padding:0 0 3px 10px; }
</style>
</head><body>
  ${outletName ? `<div class="c b" style="font-size:14px">${outletName}</div>` : ''}
  <div class="c b lg">${stationLabel}</div>
  <hr>
  <div class="row"><span class="b" style="font-size:15px">${tableName}</span><span class="b" style="font-size:15px">${ticketNo ? `#${ticketNo}` : ''}</span></div>
  <div class="row"><span>${takenBy ? `Taken by: ${takenBy}` : ''}</span><span>Covers: ${covers}</span></div>
  <div class="row" style="font-size:11px;color:#000"><span>${date}</span><span>${now}</span></div>
  <hr>
  ${items.map(i => {
      const delta = (i.sent_qty || 0) > 0 ? i.qty - i.sent_qty : 0
      const label = delta > 0 ? `+${delta}` : `×${i.qty}`
      const note  = i.notes ? `<div class="note">↳ ${i.notes}</div>` : ''
      return `<div class="row"><span class="b">${i.name}</span><span class="qty">${label}</span></div>${note}`
    }).join('')}
  <hr>
</body></html>`
}

export function buildBillHtml({ order, items, copyLabel, qrUrl, payments, qrAmount, outletName, billingSettings, hscMap, tableName, cashierName }) {
  const vatReg      = billingSettings.is_vat_registered
  const prefix      = billingSettings.invoice_prefix || ''
  const invoiceNo   = order.invoice_no != null
    ? `${vatReg ? 'TI' : 'PB'}${order.invoice_no}-${prefix}${prefix ? '-' : ''}${order.invoice_fy || ''}`
    : `${vatReg ? 'TI' : 'PB'}-(on confirm)`
  const now         = new Date()
  const nowStr      = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  const adDateStr   = now.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const bs          = adToBs(now)
  const bsDateStr   = `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`
  const payLabel    = order.payment_method || ''
  // Split payment — multiple tenders against one bill/one invoice number (not a split bill).
  // `payments` is [{ method, amount }], sourced either from pos_order_payments (real print) or
  // the live `tenders` state (in-modal preview) — same shape either way.
  const isSplitBill = payLabel === 'Split' && payments && payments.length > 0

  const { grossAmt, discount, taxableBase, nonTaxableBase, vatAmt: netVatAmt, net, roundOff, totalQty } =
    computeOrderAmounts(order, items, vatReg)
  const tendered = order.tendered_amount ?? net
  const change   = !isSplitBill && payLabel === 'Cash' ? Math.max(0, tendered - net) : 0

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
  ${outletName ? `<div class="c b" style="font-size:13px">${outletName}</div>` : ''}
  ${billingSettings.property_address ? `<div class="c" style="font-size:11px">${billingSettings.property_address}</div>` : ''}
  ${billingSettings.property_phone ? `<div class="c" style="font-size:11px">${billingSettings.property_phone}</div>` : ''}
  ${billingSettings.vat_number ? `<div class="c" style="font-size:11px">${vatReg ? 'VAT No' : 'PAN No'}: ${billingSettings.vat_number}</div>` : ''}
  <div class="c b lg" style="margin-top:4px">${vatReg ? 'TAX INVOICE' : 'BILL'}</div>
  <div class="c copy">${copyLabel}</div>
  <hr>
  <div class="row"><span>Bill No:</span><span class="b">${invoiceNo}</span></div>
  <div class="row"><span>Date:</span><span>${adDateStr}</span></div>
  <div class="row"><span>Miti:</span><span>${bsDateStr}</span></div>
  <div class="row"><span>Name:</span><span>${order.buyer_name || ''}</span></div>
  <div class="row"><span>Address:</span><span>${order.buyer_address || ''}</span></div>
  <div class="row"><span>PAN No: ${order.buyer_pan || ''}</span><span>Phone: ${order.buyer_phone || ''}</span></div>
  <div class="row"><span>Payment Mode:</span><span>${isSplitBill ? 'Split' : payLabel}</span></div>
  <div class="row"><span>Remarks:</span><span>${order.bill_remarks || ''}</span></div>
  <div class="row" style="font-size:11px;color:#000"><span>${tableName === 'Takeaway' ? 'Takeaway' : `Dine-In: ${tableName}`}</span><span>Covers: ${order.covers ?? ''}</span></div>
  <div class="row" style="font-size:11px;color:#000"><span>Cashier: ${cashierName || ''}</span><span>${nowStr}</span></div>
  <hr>
  <table>
    <thead><tr><th>Sn</th><th>HSC</th><th>Particulars</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
    <tbody>
      ${items.map((i, idx) => `<tr><td>${idx + 1}</td><td>${hscMap[i.recipe_id] || ''}</td><td>${i.name}</td><td>${i.qty}</td><td>${i.unit_price.toFixed(2)}</td><td>${(i.qty * i.unit_price).toFixed(2)}</td></tr>`).join('')}
    </tbody>
  </table>
  <hr>
  <div class="row"><span>Gross Amount:</span><span>${grossAmt.toFixed(2)}</span></div>
  <div class="row"><span>Discount:</span><span>${discount.toFixed(2)}</span></div>
  ${vatReg ? `
  <div class="row"><span>Taxable:</span><span>${taxableBase.toFixed(2)}</span></div>
  <div class="row"><span>Nontaxable:</span><span>${nonTaxableBase.toFixed(2)}</span></div>
  <div class="row"><span>VAT 13%:</span><span>${netVatAmt.toFixed(2)}</span></div>
  <div class="row"><span>Round Off:</span><span>${roundOff >= 0 ? '+' : ''}${roundOff.toFixed(2)}</span></div>
  ` : ''}
  <div class="row tot"><span>Net Amount:</span><span>${net.toFixed(2)}</span></div>
  <hr>
  ${isSplitBill ? payments.map(p => `<div class="row"><span>${p.method}:</span><span>${p.amount.toFixed(2)}</span></div>`).join('') : `
  <div class="row"><span>Tender:</span><span>${tendered.toFixed(2)}</span></div>
  <div class="row"><span>Change:</span><span>${change.toFixed(2)}</span></div>
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
  const now       = new Date()
  const nowStr    = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
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
  ${outletName ? `<div class="c b" style="font-size:13px">${outletName}</div>` : ''}
  <div class="c" style="font-size:11px; margin-top:2px">Payment Received</div>
  <hr>
  <div class="row"><span>Table:</span><span>${tableName}</span></div>
  <div class="row"><span>Method:</span><span class="b">${tender.method}</span></div>
  <div class="row tot"><span>Amount:</span><span>NPR ${tender.amount.toFixed(2)}</span></div>
  ${tender.tenderedAmount != null ? `
  <div class="row"><span>Tendered:</span><span>${tender.tenderedAmount.toFixed(2)}</span></div>
  <div class="row"><span>Change:</span><span>${change.toFixed(2)}</span></div>
  ` : ''}
  <hr>
  <div class="row"><span>Remaining on bill:</span><span>${remainingAfter > 0 ? `NPR ${remainingAfter.toFixed(2)}` : 'Paid in full'}</span></div>
  <div class="row" style="font-size:10px; margin-top:6px"><span>Not a Tax Invoice / PAN Bill</span><span>${nowStr}</span></div>
  <hr>
  <div class="c" style="font-size:11px">Thank you for stopping by! We hope to see you again soon.</div>
</body></html>`
}

// Complimentary items were never sold — this is an internal cost-tracking slip, not a Tax
// Invoice or PAN Bill: no VAT/PAN, own NC-prefixed sequence (separate from TI/PB), and line
// amounts are valued at food cost (not menu price) so the P&L impact isn't distorted by
// retail pricing. Standard practice per restaurant accounting for comps.
export function buildCompSlipHtml({ order, items, costMap, copyLabel, outletName, tableName, authorizedBy }) {
  const ncNo      = order.invoice_no != null ? `NC-${String(order.invoice_no).padStart(2, '0')}` : 'NC-(on confirm)'
  const now       = new Date()
  const nowStr    = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  const adDateStr = now.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const bs        = adToBs(now)
  const bsDateStr = `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`

  const totalQty  = items.reduce((s, i) => s + i.qty, 0)
  const totalCost = items.reduce((s, i) => s + i.qty * (costMap[i.recipe_id] || 0), 0)

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
  <div class="c copy">${copyLabel}</div>
  ${outletName ? `<div class="c b" style="font-size:13px">${outletName}</div>` : ''}
  <div class="c b lg" style="margin-top:4px">COMPLIMENTARY SLIP</div>
  <div class="c" style="font-size:11px">Internal record — not a Tax Invoice or PAN Bill</div>
  <hr>
  <div class="row"><span>No:</span><span class="b">${ncNo}</span></div>
  <div class="row"><span>Order Ref:</span><span>#${order.order_no ?? ''}</span></div>
  <div class="row"><span>Table:</span><span>${tableName}</span></div>
  <div class="row"><span>Date:</span><span>${adDateStr}</span></div>
  <div class="row"><span>Miti:</span><span>${bsDateStr}</span></div>
  <div class="row"><span>Reason:</span><span>${order.close_reason || ''}</span></div>
  <div class="row"><span>Authorized by:</span><span>${authorizedBy || ''}</span></div>
  <div class="row"><span>Remarks:</span><span>${order.bill_remarks || ''}</span></div>
  <hr>
  <table>
    <thead><tr><th>Item</th><th>Qty</th><th>Cost</th></tr></thead>
    <tbody>
      ${items.map(i => `<tr><td>${i.name}</td><td>${i.qty}</td><td>${(i.qty * (costMap[i.recipe_id] || 0)).toFixed(2)}</td></tr>`).join('')}
    </tbody>
  </table>
  <hr>
  <div class="row"><span>Total Qty:</span><span>${totalQty}</span></div>
  <div class="row tot"><span>Total Food Cost:</span><span>NPR ${totalCost.toFixed(2)}</span></div>
  <hr>
  <div class="row" style="font-size:11px;color:#000"><span>Table: ${tableName}</span><span>${nowStr}</span></div>
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
