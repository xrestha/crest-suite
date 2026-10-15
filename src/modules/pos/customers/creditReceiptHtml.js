import { escapeHtml as esc } from '../../../utils/escapeHtml'
import { numberToWordsNpr } from '../../../utils/numberToWords'
import { npr2 } from '../../../shared/nepalMoney'
import { nepalBsLong, nepalDateAd, nepalTime } from '../../../shared/nepalTime'
import { invoiceCodeOf } from '../../../shared/invoiceCode'
import { AGE_BUCKETS, creditBillLabel, receiptNoLabel, toPaisa } from './creditLedger'

// Printed papers for customer credit (S843): the money receipt (80mm thermal, the bill's own layout
// family and CSS, so it comes off the same printer looking like it belongs), the account statement and
// the who-owes-by-age list (A4). Pure string builders, as posOrderPrintHtml.js and creditNoteHtml.js:
// no React, no Supabase. Every typed value goes through escapeHtml.
//
// The receipt is NOT a tax invoice (owner decision): the VAT was invoiced on the bill at the sale, and
// a second VAT document would count it twice. So it carries no VAT or PAN block and says so at the foot.

/** The day as Nepal reads it, in BS ("29 Asoj 2083"), or the AD date marked (AD) past the BS table. */
export function bsDay(ts) {
  if (!ts) return ''
  return nepalBsLong(ts) || `${nepalDateAd(ts)} (AD)`
}

/** Rupees and paisa in words: "Five Thousand Two Hundred Rupees and Fifty Paisa only". */
export function amountInWords(amount) {
  const p = Math.abs(toPaisa(amount))
  const rupees = Math.floor(p / 100)
  const paisa = p % 100
  return `${numberToWordsNpr(rupees)} ${rupees === 1 ? 'Rupee' : 'Rupees'}${paisa ? ` and ${numberToWordsNpr(paisa)} Paisa` : ''} only`
}

// The 80mm slip's CSS: buildBillHtml's own, so the receipt and the bill read as one family.
const SLIP_CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Courier New',monospace; font-size:11px; width:80mm; padding:8px 10px; margin:0 auto; color:#000; }
  .c   { text-align:center; }
  .b   { font-weight:bold; }
  .lg  { font-size:15px; letter-spacing:1px; }
  hr   { border:none; border-top:1px dashed #000; margin:6px 0; }
  .row { display:flex; justify-content:space-between; align-items:baseline; padding:2px 0; gap:6px; }
  .row span:last-child { text-align:right; }
  table { width:100%; border-collapse:collapse; font-size:11px; table-layout:fixed; }
  th, td { text-align:left; padding:2px 4px 2px 0; word-wrap:break-word; vertical-align:top; }
  th:last-child, td:last-child { padding-right:0; }
  th.n, td.n { text-align:right; }
  .tot  { font-weight:bold; font-size:13px; }
  .copy { font-size:11px; letter-spacing:1px; }
  .void { border:2px solid #000; padding:4px; margin:6px 0; text-align:center; font-weight:bold; }
`

/**
 * The money receipt. `receipt` is the pos_credit_receipts row; `bills` the bills it paid, each
 * { label, closedAt, amount, commission, owedAfter } as at the receipt's own moment; `previousBalance`
 * and `newBalance` the party's balance either side of it; `receivedBy` the name of who took it;
 * `outlet` { name, address, phone }; `copyLabel` '' on the first print, the COPY line on a reprint.
 */
export function buildReceiptHtml({ receipt, bills, previousBalance, newBalance, receivedBy, outlet = {}, copyLabel = '' }) {
  const r = receipt || {}
  const partner = String(r.party_key || '').startsWith('partner:')
  const commission = Number(r.commission_total) || 0
  const method = esc(r.method || '')
  const paidBy = r.reference ? `${method} · ${esc(r.reference)}` : method
  const anyCommission = (bills || []).some(b => Number(b.commission) > 0)
  const billRows = (bills || []).map(b => `
      <tr>
        <td>${esc(b.label)}<br><span style="font-size:10px">${esc(bsDay(b.closedAt))}</span></td>
        <td class="n">${npr2(b.amount)}${anyCommission && Number(b.commission) > 0 ? `<br><span style="font-size:10px">+${npr2(b.commission)} comm.</span>` : ''}</td>
        <td class="n">${npr2(b.owedAfter)}</td>
      </tr>`).join('')
  const cancelled = r.cancelled_at
    ? `<div class="void">CANCELLED ${esc(bsDay(r.cancelled_at))}<br><span style="font-weight:normal">${esc(r.cancel_reason || '')}</span></div>`
    : ''

  return `<!DOCTYPE html>
<html><head><title>Money Receipt ${esc(receiptNoLabel(r))}</title>
<style>${SLIP_CSS}</style>
</head><body>
  ${outlet.name ? `<div class="c b" style="font-size:13px">${esc(outlet.name)}</div>` : ''}
  ${outlet.address ? `<div class="c" style="font-size:11px">${esc(outlet.address)}</div>` : ''}
  ${outlet.phone ? `<div class="c" style="font-size:11px">${esc(outlet.phone)}</div>` : ''}
  <div class="c b lg" style="margin-top:4px">MONEY RECEIPT</div>
  <div class="c b">रकम प्राप्ति रसिद</div>
  ${copyLabel ? `<div class="c copy">${esc(copyLabel)}</div>` : ''}
  ${cancelled}
  <hr>
  <div class="row"><span>Receipt No:</span><span class="b">${esc(receiptNoLabel(r))}</span></div>
  <div class="row"><span>Fiscal Year:</span><span>${esc(r.invoice_fy || '')}</span></div>
  <div class="row"><span>Miti:</span><span>${esc(bsDay(r.received_at))}</span></div>
  <div class="row"><span>Time:</span><span>${esc(nepalTime(r.received_at))}</span></div>
  <hr>
  <div class="row"><span>Received from:</span><span class="b">${esc(r.party_name || '')}</span></div>
  ${r.party_phone ? `<div class="row"><span>Phone:</span><span>${esc(r.party_phone)}</span></div>` : ''}
  <hr>
  <div class="row tot"><span>Amount:</span><span>NPR ${npr2(r.amount)}</span></div>
  <div style="font-size:11px; margin:4px 0">${esc(amountInWords(r.amount))}</div>
  <div class="row"><span>Paid by:</span><span>${paidBy}</span></div>
  ${partner && commission > 0 ? `<div class="row"><span>Commission kept:</span><span>${npr2(commission)}</span></div>` : ''}
  ${r.note ? `<div class="row"><span>Note:</span><span>${esc(r.note)}</span></div>` : ''}
  <hr>
  <div class="b" style="margin-bottom:2px">Bills paid</div>
  <table>
    <thead><tr><th>Bill / date</th><th class="n" style="width:30%">Paid</th><th class="n" style="width:30%">Still owed</th></tr></thead>
    <tbody>${billRows}
    </tbody>
  </table>
  <hr>
  <div class="row"><span>Previous balance:</span><span>${npr2(previousBalance)}</span></div>
  <div class="row"><span>This payment:</span><span>-${npr2(Number(r.amount) + (partner ? commission : 0))}</span></div>
  <div class="row b"><span>New balance:</span><span>${npr2(newBalance)}</span></div>
  <hr>
  <div class="row"><span>Received by:</span><span>${esc(receivedBy || '')}</span></div>
  <div style="margin-top:16px">
    <div class="row"><span style="border-bottom:1px solid #000; width:60%; display:inline-block">&nbsp;</span></div>
    <div class="row" style="font-size:10px; margin-top:2px"><span>Signature</span></div>
  </div>
  <hr>
  <div class="c" style="font-size:10px">This is a receipt for money received, not a tax invoice.</div>
</body></html>`
}

// ── A4 papers ────────────────────────────────────────────────────────────────────────────────────

const A4_CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  @page { size: A4; margin: 14mm; }
  body { font-family: Archivo, sans-serif; font-size: 11px; color:#000; }
  h1 { font-size: 16px; margin: 6px 0 2px; }
  .muted { color:#333; }
  .head { text-align:center; margin-bottom: 10px; }
  .meta { display:flex; justify-content:space-between; gap:16px; margin: 8px 0 10px; }
  table { width:100%; border-collapse:collapse; margin-top: 6px; }
  th, td { border-bottom: 1px solid #999; padding: 4px 6px; text-align:left; vertical-align: top; }
  th { border-bottom: 1.5px solid #000; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
  td.n, th.n { text-align:right; white-space:nowrap; font-variant-numeric: tabular-nums; }
  tfoot td { border-top: 1.5px solid #000; border-bottom: none; font-weight: bold; }
  .foot { margin-top: 12px; font-size: 10px; color:#333; }
  h2 { font-size: 12px; margin: 14px 0 0; }
`

function outletHead(outlet = {}) {
  return `<div class="head">
    ${outlet.name ? `<div style="font-size:14px;font-weight:bold">${esc(outlet.name)}</div>` : ''}
    ${outlet.address ? `<div class="muted">${esc(outlet.address)}</div>` : ''}
    ${outlet.phone ? `<div class="muted">${esc(outlet.phone)}</div>` : ''}
  </div>`
}

/**
 * What one pos_credit_party_events row is, in words, for the statement on screen and on paper.
 * `vatById` maps an order id to its own vat_registered stamp (TI or PB as the bill was issued).
 */
export function eventParticulars(e, { vatReg = true, prefix = '', vatById = null } = {}) {
  const bill = () => creditBillLabel({
    invoice_no: e.doc_no, invoice_fy: e.doc_fy, invoice_prefix: e.doc_prefix,
    vat_registered: vatById && e.order_id ? vatById[e.order_id] : undefined,
  }, vatReg, prefix)
  const rc = `Receipt ${receiptNoLabel({ receipt_no: e.doc_no })} (${e.doc_fy || ''})`
  switch (e.kind) {
    case 'bill': return `Credit bill ${bill()}${e.detail ? ` · ${e.detail}` : ''}`
    case 'settled': return `Bill ${bill()} paid in full by ${e.method || 'an unrecorded method'}${e.detail ? ` (${e.detail})` : ''}`
    case 'receipt': return `${rc}, ${e.method || ''}${e.detail ? ` · ${e.detail}` : ''}`
    case 'receipt_cancelled': return `${rc} cancelled${e.detail ? `: ${e.detail}` : ''}`
    case 'credit_note': {
      const code = invoiceCodeOf({ invoice_prefix: e.doc_prefix }, prefix)
      return `Credit note CN${e.doc_no ?? ''}-${code}${code ? '-' : ''}${e.doc_fy || ''}${e.detail ? ` · ${e.detail}` : ''}`
    }
    default: return e.kind || ''
  }
}

/**
 * The account statement. `statement` is creditLedger's statementOf; `ageing` its ageingOf over the
 * party's unpaid bills today; `particulars(row)` names a row (eventParticulars, bound to the outlet).
 */
export function buildStatementHtml({ outlet, party, fromLabel, toLabel, statement, ageing, particulars, printedAt = new Date() }) {
  const s = statement || { opening: 0, rows: [], closing: 0, totalDebit: 0, totalCredit: 0 }
  const body = s.rows.map(row => `
      <tr>
        <td style="white-space:nowrap">${esc(bsDay(row.event_at))}</td>
        <td>${esc(particulars(row))}</td>
        <td class="n">${Number(row.debit) ? npr2(row.debit) : ''}</td>
        <td class="n">${Number(row.credit) ? npr2(row.credit) : ''}</td>
        <td class="n">${npr2(row.balance)}</td>
      </tr>`).join('')
  const ageHead = AGE_BUCKETS.map(b => `<th class="n">${esc(b.label)}</th>`).join('')
  const ageCells = AGE_BUCKETS.map(b => `<td class="n">${npr2(ageing?.buckets?.[b.key] || 0)}</td>`).join('')
  return `<!DOCTYPE html>
<html><head><title>Statement - ${esc(party?.name || '')}</title><style>${A4_CSS}</style></head><body>
  ${outletHead(outlet)}
  <h1>Statement of account</h1>
  <div class="meta">
    <div><b>${esc(party?.name || '')}</b>${party?.phone ? `<br>${esc(party.phone)}` : ''}${party?.kind === 'partner' ? '<br>Delivery partner' : ''}</div>
    <div style="text-align:right">From ${esc(fromLabel)} to ${esc(toLabel)}<br>Printed ${esc(bsDay(printedAt))}, ${esc(nepalTime(printedAt))}</div>
  </div>
  <table>
    <thead><tr><th>Date</th><th>Particulars</th><th class="n">Charged</th><th class="n">Paid</th><th class="n">Balance</th></tr></thead>
    <tbody>
      <tr><td></td><td><b>Balance brought forward</b></td><td class="n"></td><td class="n"></td><td class="n">${npr2(s.opening)}</td></tr>
      ${body}
    </tbody>
    <tfoot><tr><td></td><td>Balance at ${esc(toLabel)}</td><td class="n">${npr2(s.totalDebit)}</td><td class="n">${npr2(s.totalCredit)}</td><td class="n">${npr2(s.closing)}</td></tr></tfoot>
  </table>
  <h2>Still owed today, by age of bill</h2>
  <table>
    <thead><tr>${ageHead}<th class="n">Total</th></tr></thead>
    <tbody><tr>${ageCells}<td class="n"><b>${npr2(ageing?.total || 0)}</b></td></tr></tbody>
  </table>
  <div class="foot">All figures in NPR. Charged is a Credit bill; Paid is a payment received, a commission a delivery partner kept, or a credit note. A cancelled payment is charged back on the day it was cancelled.</div>
</body></html>`
}

/** Who owes, by age (creditLedger's ageingByParty), as an A4 list. `asOf` is the moment the ages are counted to. */
export function buildAgeingHtml({ outlet, ageing, asOf = new Date() }) {
  const a = ageing || { rows: [], totals: {}, total: 0 }
  const head = AGE_BUCKETS.map(b => `<th class="n">${esc(b.label)}</th>`).join('')
  const rows = a.rows.map(r => `
      <tr>
        <td>${esc(r.name)}${r.kind === 'partner' ? ' (delivery partner)' : ''}${r.phone ? `<br><span class="muted">${esc(r.phone)}</span>` : ''}</td>
        ${AGE_BUCKETS.map(b => `<td class="n">${r.buckets[b.key] ? npr2(r.buckets[b.key]) : ''}</td>`).join('')}
        <td class="n"><b>${npr2(r.total)}</b></td>
      </tr>`).join('')
  return `<!DOCTYPE html>
<html><head><title>Who owes, by age</title><style>${A4_CSS}</style></head><body>
  ${outletHead(outlet)}
  <h1>Who owes, by age</h1>
  <div class="meta"><div>Unpaid Credit bills, by days since the bill was closed</div><div>As at ${esc(bsDay(asOf))}, ${esc(nepalTime(asOf))}</div></div>
  <table>
    <thead><tr><th>Customer or partner</th>${head}<th class="n">Total</th></tr></thead>
    <tbody>${rows}
    </tbody>
    <tfoot><tr><td>Total</td>${AGE_BUCKETS.map(b => `<td class="n">${npr2(a.totals[b.key] || 0)}</td>`).join('')}<td class="n">${npr2(a.total)}</td></tr></tfoot>
  </table>
  <div class="foot">All figures in NPR. Days are counted on Nepal's calendar from the day the bill was closed.</div>
</body></html>`
}

// ── The print window (the credit note's own shape) ───────────────────────────────────────────────

// Opened on the press itself, before anything is awaited, so a browser keeps the click's permission to
// open it. noopener as a window.open feature makes the call return null, so opener is severed by hand.
export function openPrintWindow({ wide = false } = {}) {
  const w = window.open('', '_blank', wide ? 'width=900,height=700,left=120,top=60' : 'width=340,height=480,left=200,top=100')
  if (!w) return null
  w.opener = null
  w.document.write('<p style="font-family:sans-serif;color:#666;padding:24px">Preparing…</p>')
  return w
}

export function writeAndPrint(w, html) {
  if (!w || w.closed) return false
  // .open() clears the placeholder: document.write() on a still-open document appends instead.
  w.document.open()
  w.document.write(html)
  w.document.close()
  w.focus()
  setTimeout(() => { w.print(); w.close() }, 300)
  return true
}

export function closeQuietly(w) {
  try { if (w && !w.closed) w.close() } catch (e) { /* a window already gone */ }
}
