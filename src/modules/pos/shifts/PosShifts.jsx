import { npr, npr2 } from '../../../shared/nepalMoney'
import { useState, useEffect, useRef, Fragment } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { scopedFrom as scopedFromRaw } from '../../../shared/scopedDb'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import Tip from '../../../components/Tip'
import Tabs from '../../../components/Tabs'
import { errorLine } from '../../../shared/errorText'
import ActionError, { asActionError } from '../../../components/ActionError'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { withTimeout, settleWithin } from '../../../utils/withTimeout'
import { profileNamesRpc, namesMapOf, useMissingProfileNames } from '../../../shared/profileNames'
import RowDisclosure from '../../../components/RowDisclosure'
import Modal from '../../../components/Modal'
import ConfirmModal from '../../../components/ConfirmModal'
import ReportLoadError from '../../../components/ReportLoadError'
import { posLineCosts, buildYourOwnAmong, LINE_CHOICE_STOCK } from '../orders/posRecipeBook'
import { outletHasIms } from '../orders/posImsWaiting'
import { forgoneMenuValue } from '../reports/salesReportMath'
import { PAYMENT_METHODS } from '../orders/posOrdersConstants'
import { escapeHtml as esc } from '../../../utils/escapeHtml'
import { nepalTime, nepalDateAd, nepalBsLong, nepalHour } from '../../../shared/nepalTime'
import {
  shiftDates, historyRowLabel, asOfLabel, isNoAnswer, openUnknownText, closeUnknownText,
  cashUnknownText, detailSuffix, slipNotPrintedText, shiftReadFailLead, SHIFT_ALREADY_CLOSED_TEXT, SHIFT_ALREADY_OPEN_TEXT,
  openOrdersLabel,
} from './shiftText'

const fmtNpr = npr
// Was its own hardcoded copy of the tender-type list (drifted from posOrdersConstants.js) — a
// new payment method added there would have silently vanished from this shift report. Now
// derived from the same source of truth, plus 'Credit' (a shift-reporting-only bucket, not an
// actual Charge-tab tender button). Foodmandu/Pathao are buyers on Credit bills, not their own
// payment_method (see posOrdersConstants.js) — they're already covered under 'Credit' here.
// 'Loyalty' is appended here but is deliberately absent from PAYMENT_METHODS: that constant is
// the list a cashier can PICK, and a points redemption is not picked — it is applied when the
// customer has a balance (S290->S291 learned the same distinction with Foodmandu/Pathao). It has
// to be in THIS list though, because the breakdown below only accumulates methods it already
// knows: `if (byMethod[p.payment_method] !== undefined)` silently drops anything else, so a
// redeemed bill would leave the method breakdown short of the bill total with nothing saying so.
const PAY_METHODS = [...PAYMENT_METHODS, 'Loyalty', 'Credit']
const DENOMINATIONS = [1000, 500, 100, 50, 20, 10, 5, 2, 1]
// Time limits (S809 SHIFTS-9). A supabase call can hang with no error (withTimeout.js), and Cancel is
// inert while a dialog saves, so an unbounded wait was a page whose only way out was a reload that
// threw the drawer count away. The report is two waves of reads plus a recipe-cost walk, hence longer.
const SHIFT_READ_MS = 15000
const SHIFT_WRITE_MS = 20000
const SHIFT_REPORT_MS = 60000
const EMPTY_COUNTS = Object.fromEntries(DENOMINATIONS.map(d => [d, '']))

function sumDenoms(counts) {
  return DENOMINATIONS.reduce((s, d) => s + d * (parseInt(counts[d]) || 0), 0)
}

// Suggests a generic shift label from the current time — Morning/Afternoon/Evening/Night,
// matching standard F&B daypart terms. Pre-fills the Label field on Open Shift; fully editable.
function suggestShiftLabel() {
  // Nepal's clock, not the device's: a till or an operator in another timezone still gets the
  // daypart the outlet is actually in.
  const h = nepalHour(new Date())
  if (h >= 4 && h < 11) return 'Morning'
  if (h >= 11 && h < 16) return 'Afternoon'
  if (h >= 16 && h < 21) return 'Evening'
  return 'Night'
}

function fmtSpan(from, to) {
  const f = new Date(from), t = to ? new Date(to) : new Date()
  const mins = Math.round((t - f) / 60000)
  const h = Math.floor(mins / 60), m = mins % 60
  return `${h}h ${m}m`
}

function DenomGrid({ counts, onChange }) {
  return (
    <div>
      {/* Auto-fit, not repeat(3, 1fr): nine denominations are a flat list, so a fixed count is
          just a media query nobody wrote — at 390px it left each note ~98px wide, with the
          ₨-label and its running subtotal squeezed onto one 82px line. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))', gap: 8 }}>
        {DENOMINATIONS.map(d => (
          <div key={d} style={{ background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 0, padding: '6px 8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text1)' }}>₨{d}</span>
              <span style={{ fontSize: 10, color: 'var(--theme-text3)' }}>{fmtNpr(d * (parseInt(counts[d]) || 0))}</span>
            </div>
            <input type="number" min="0" step="1" value={counts[d]} aria-label={`Count of ₨${d} notes`}
              // min="0" only blocks the spinner arrows — a typed "-5" still lands in the input
              // unless clamped here, since every downstream sum just does parseInt(...) || 0.
              onChange={e => onChange({ ...counts, [d]: e.target.value === '' ? '' : String(Math.max(0, parseInt(e.target.value) || 0)) })}
              className="form-input" style={{ width: '100%', textAlign: 'center', padding: '4px 6px' }} />
          </div>
        ))}
      </div>
      <p style={{ margin: '10px 0 0', textAlign: 'right', fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)' }}>
        Total: {fmtNpr(sumDenoms(counts))}
      </p>
    </div>
  )
}

// The one verdict on a drawer variance (S776), for the counting box, the Z-report table and Shift
// History alike. They had three schemes: the counting box was GREEN for any shortfall under NPR 100
// and red for an overage over it, while the report and history called short red and over amber. A
// short drawer is money missing, whatever its size, and a cashier must not see green for it on one
// screen and red on the next. The mark carries it too, since red and amber collide under
// deuteranopia on Light (posSignals.js): ✓ balanced, ▲ short (act), △ over (check).
function varianceSignal(v) {
  if (Math.abs(v) < 1) return { tone: 'green', mark: '✓', word: 'Balanced' }
  return v < 0 ? { tone: 'red', mark: '▲', word: 'short' } : { tone: 'amber', mark: '△', word: 'over' }
}

// The slip's date, as read IN NEPAL (S776): the runtime's toLocaleDateString and adToBsSafe named the
// next or previous day for a shift closed late at night and printed from a device in another zone.
function fmtAdBs(date) {
  const ad = nepalDateAd(date)
  const bs = nepalBsLong(date)
  return bs ? `${ad} (${bs})` : ad
}

// 80mm thermal-printable Cash Settlement / Shift Opening slip — same template conventions as
// buildBillHtml/buildCompSlipHtml in PosOrders.jsx (Courier New, dashed hr, .row flex layout) so
// it looks consistent with the rest of Crest POS's printed output. Pure builder, no DB calls —
// takes everything it needs as params so it can run right after a save (before any re-fetch) or
// as a standalone reprint from Shift History.
function buildShiftSlipHtml({ mode, outletName, propertyAddress, label, openedByName, closedByName, openedAt, closedAt, denomCounts, opening, closing, report }) {
  const now    = new Date()
  const nowStr = nepalTime(now)
  const total  = mode === 'open' ? opening : closing
  // Variance derives from the SAME expected-cash figure the slip prints two rows above it —
  // through expectedCashOf, the one definition (hoisted; see below). A local formula here once
  // ignored cash in/out, so any shift with a supplier payment or credit settlement printed a
  // signed slip whose Variance disagreed with its own Expected Cash line and with the screen.
  const expected = mode === 'close' ? expectedCashOf({ opening_cash: opening }, report) : 0
  const variance = mode === 'close' ? closing - expected : 0
  const varianceLabel = Math.abs(variance) < 1 ? 'Balanced' : `${variance > 0 ? '+' : ''}NPR ${npr2(variance)} (${variance > 0 ? 'over' : 'short'})`

  return `<!DOCTYPE html>
<html><head><title>${mode === 'open' ? 'Shift Opening' : 'Cash Settlement'}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Courier New',monospace; font-size:11px; width:80mm; padding:8px 10px; margin:0 auto; color:#000; }
  .c   { text-align:center; }
  .b   { font-weight:bold; }
  .lg  { font-size:14px; letter-spacing:1px; }
  hr   { border:none; border-top:1px dashed #000; margin:6px 0; }
  .row { display:flex; justify-content:space-between; align-items:baseline; padding:2px 0; }
  .ind { padding-left:10px; }
  .tot { font-weight:bold; font-size:12px; }
</style>
</head><body>
  ${outletName ? `<div class="c b" style="font-size:13px">${esc(outletName)}</div>` : ''}
  ${propertyAddress ? `<div class="c" style="font-size:11px">${esc(propertyAddress)}</div>` : ''}
  <div class="c b lg" style="margin-top:4px">${mode === 'open' ? 'SHIFT OPENING' : 'CASH SETTLEMENT'}</div>
  <hr>
  <div class="row"><span>Shift:</span><span class="b">${esc(label || 'Shift')}</span></div>
  <div class="row"><span>Opened:</span><span>${fmtAdBs(openedAt)}</span></div>
  ${mode === 'close' ? `<div class="row"><span>Closed:</span><span>${fmtAdBs(closedAt)}</span></div>` : ''}
  <div class="row"><span>Opened By:</span><span>${esc(openedByName || '')}</span></div>
  ${mode === 'close' ? `<div class="row"><span>Closed By:</span><span>${esc(closedByName || '')}</span></div>` : ''}
  ${mode === 'close' && report ? `
  <hr>
  <!-- "Total Sales", not "Total Collection": salesTotal includes Credit bills, which are billed
       but not collected. The screen already labelled this honestly; the signed paper slip did not. -->
  <div class="row tot"><span>Total Sales:</span><span>NPR ${npr2(report.salesTotal)}</span></div>
  ${PAY_METHODS.filter(m => report.byMethod[m]).map(m => `<div class="row ind"><span>${m}</span><span>${npr2(report.byMethod[m])}</span></div>`).join('')}
  <hr>
  <div class="row"><span>Bills (Paid):</span><span>${report.paidCount}</span></div>
  <div class="row"><span>Voided:</span><span>${report.voidCount}</span></div>
  <div class="row"><span>Complimentary:</span><span>${report.compCount}</span></div>
  <hr>
  <div class="row"><span>Opening Cash:</span><span>${npr2(opening)}</span></div>
  <div class="row"><span>Cash Sales:</span><span>${npr2(report.cashSales)}</span></div>
  ${report.cashIn  ? `<div class="row"><span>Cash In${report.creditSettlementsCash ? ` (incl. ${npr2(report.creditSettlementsCash)} from credit customers)` : ''}:</span><span>+${npr2(report.cashIn)}</span></div>` : ''}
  ${report.cashOut ? `<div class="row"><span>Cash Out${esc(cashOutParts(report, npr2, 'refunded'))}:</span><span>-${npr2(report.cashOut)}</span></div>` : ''}
  ${(report.movements || []).filter(m => m.kind === 'refund' || m.kind === 'credit_receipt_cancel').map(m => `<div class="row ind"><span>${esc(m.kind === 'credit_receipt_cancel' && m.reason ? m.reason : movementLabel(m))}</span><span>-${npr2(Number(m.amount) || 0)}</span></div>`).join('')}
  <div class="row tot"><span>Expected Cash:</span><span>${npr2(expected)}</span></div>
  <div class="row"><span>Counted Cash:</span><span>${npr2(closing)}</span></div>
  <div class="row tot"><span>Variance:</span><span>${varianceLabel}</span></div>
  ` : ''}
  <hr>
  <div class="c b" style="margin:2px 0">DENOMINATION</div>
  ${DENOMINATIONS.map(d => {
    const qty = parseInt(denomCounts[d]) || 0
    return `<div class="row"><span>₨${d} × ${qty}</span><span>${npr2(d * qty)}</span></div>`
  }).join('')}
  <hr>
  <div class="row tot"><span>Total</span><span>NPR ${npr2(total)}</span></div>
  <hr>
  <div class="row" style="font-size:11px"><span>Print Time:</span><span>${nowStr}</span></div>
  <div style="margin-top:14px">
    <div class="row">
      <span style="border-bottom:1px solid #000; width:46%; display:inline-block">&nbsp;</span>
      <span style="border-bottom:1px solid #000; width:46%; display:inline-block">&nbsp;</span>
    </div>
    <div class="row" style="font-size:10px; margin-top:2px">
      <span>Cashier</span><span>${mode === 'close' ? 'Verified By' : 'Witness'}</span>
    </div>
  </div>
</body></html>`
}

// The throwing form of firstError() (shared/queryError.js), keeping the Supabase error OBJECT so
// ReportLoadError/errorLine can still show its code (S754).
function throwIfFailed(results) {
  const bad = (results || []).find(r => r && r.error)
  if (bad) throw bad.error
}

// Shared X/Z-report totals from a shift's closed orders — used for the live Current Shift view
// and for expanding a past shift in History. Voided Value is the voided bills' menu value before VAT
// (forgoneMenuValue, S814 4d), the Sales Exceptions basis; Comp Food Cost is the till's own recipe
// book with each dish's choices (posLineCosts), as on the Complimentary Slip. `compCost` says how:
// { inventory } the outlet has Crest IMS, { customization } Crest Customization is on. A shift already
// closed keeps the figure frozen in its closing_report; only a live read or a close uses this.
export async function loadShiftReport(clientId, shiftId, compCost = {}) {
  // Both reads are filtered on the shift alone — neither needs the other's result — so they go
  // together. This is the report the drawer is counted against and it is rebuilt every time a
  // history row is expanded, so a needless round trip here is paid over and over.
  //
  // The orders read is paged: every figure below is summed from it, and a bare select that
  // stopped at 1000 would understate the drawer with no error anywhere — the silently-wrong-total
  // shape, on the one screen whose entire job is reconciling against cash. `.order('id')` is both
  // the tiebreaker paging needs and the deterministic order the query previously had none of.
  const firstWave = await Promise.all([
    fetchAllRows(() => scopedFromRaw('pos_orders', clientId, 'id, close_type, payment_method, paid_amount, discount_amount, closed_at')
      .eq('shift_id', shiftId).order('id')),
    // Cash that moved without being a sale: supplier payments, staff advances, float drops, and
    // customers settling an older Credit bill in cash. Expected Cash used to be `opening + cash
    // sales`, which meant a credit settlement put real money in the drawer that the reconciliation
    // did not know about — the shift then reported an unexplainable "over" (S573).
    // `*`, not a column list (S754): pos_credit_note_id arrives with migration 20260916110000, and
    // naming a column the database does not have yet fails this whole read — the Z-report the
    // drawer is closed against — rather than one label.
    scopedFromRaw('pos_cash_movements', clientId, '*')
      .eq('shift_id', shiftId).order('created_at'),
  ])
  // S754: both batches used to drop `error`, so a failed read built a complete Z-report of NPR 0 —
  // and the close flow froze THAT into closing_report and printed it on the signed slip. Throw the
  // original error object (not firstError's message string) so its code survives into the detail
  // line; every caller catches and refuses to render or close on it.
  throwIfFailed(firstWave)
  const [{ data: orders }, { data: movements }] = firstWave
  const list = orders || []
  const moveList = movements || []
  const cashIn  = moveList.filter(m => m.direction === 'in').reduce((s, m) => s + (Number(m.amount) || 0), 0)
  const cashOut = moveList.filter(m => m.direction === 'out').reduce((s, m) => s + (Number(m.amount) || 0), 0)
  // Cash a credit customer or delivery partner paid in: the old whole-bill settlement (one entry per
  // bill, order_id set) and, since S843, a payment receipt's Cash In (one entry per receipt, order_id
  // NULL, credit_receipt_id set — a receipt can cover several bills). Both are kind
  // 'credit_settlement', direction 'in', so neither needs the bill.
  const creditSettlementsCash = moveList
    .filter(m => m.kind === 'credit_settlement').reduce((s, m) => s + (Number(m.amount) || 0), 0)
  // Credit Note cash refunds (S754). Already inside cashOut — the database pins a refund to
  // direction 'out' — so expectedCashOf needs no change; this is only so the screen and the signed
  // slip can say how much of Cash Out went back to customers.
  const refundsCash = moveList
    .filter(m => m.kind === 'refund').reduce((s, m) => s + (Number(m.amount) || 0), 0)
  // A cash customer payment cancelled as a mistake (S843, cancel_credit_receipt): its cash leaves the
  // drawer as its own entry, pinned to direction 'out' like a refund, so it is already in cashOut and
  // in pos_shifts_guard's sum. Named only so the screen and the slip can say what that cash was.
  const receiptCancelsCash = moveList
    .filter(m => m.kind === 'credit_receipt_cancel').reduce((s, m) => s + (Number(m.amount) || 0), 0)
  // The note number beside each refund. A label, never a figure, so a failed lookup degrades to
  // "Refund" rather than failing the report the drawer is counted against. S847: started here and
  // awaited with the second wave below, which needs nothing of it — it used to be a round trip of its
  // own in front of that wave on every shift with a refund.
  const noteIds = [...new Set(moveList.filter(m => m.kind === 'refund' && m.pos_credit_note_id).map(m => m.pos_credit_note_id))]
  const noteLabels = noteIds.length > 0
    ? scopedFromRaw('pos_credit_notes', clientId, 'id, credit_note_no, invoice_fy').in('id', noteIds)
    : Promise.resolve({ data: [], error: null })

  // Split-payment orders (multiple tenders against one bill) don't carry a single payment_method
  // — their real per-method breakdown lives in pos_order_payments instead. Fetched up front so the
  // aggregation loop below can attribute each tender to its own method rather than lumping the
  // whole order under one bucket.
  const splitOrderIds = list.filter(o => o.close_type === 'paid' && o.payment_method === 'Split').map(o => o.id)
  const needItems = list.filter(o => o.close_type === 'void' || o.close_type === 'writeoff')

  // Both derive their id list from `orders` above and neither reads the other, so they are one
  // wave rather than two. Chunked because an `.in()` list is spelled out in the URL and both
  // return several rows per order — a busy shift's split bills alone can outgrow either limit.
  const [notesRes, ...secondWave] = await Promise.all([
    noteLabels,
    fetchAllRowsChunked(splitOrderIds,
      ids => scopedFromRaw('pos_order_payments', clientId, 'order_id, payment_method, amount').in('order_id', ids).order('id')),
    // With each line's choices' stock lines, which a Complimentary bill's food cost includes.
    fetchAllRowsChunked(needItems.map(o => o.id),
      ids => scopedFromRaw('pos_order_items', clientId, `order_id, qty, unit_price, vat_rate, recipe_id, ${LINE_CHOICE_STOCK}`).in('order_id', ids).order('id')),
  ])
  if (!notesRes.error) {
    const byId = new Map((notesRes.data || []).map(n => [n.id, n]))
    for (const m of moveList) {
      const n = m.kind === 'refund' ? byId.get(m.pos_credit_note_id) : null
      if (n) m.credit_note_label = `Credit Note ${n.credit_note_no ?? '?'}${n.invoice_fy ? ` (${n.invoice_fy})` : ''}`
    }
  }
  throwIfFailed(secondWave)
  const [{ data: payments }, { data: items }] = secondWave
  const paymentsByOrder = (payments || []).reduce((acc, p) => { (acc[p.order_id] = acc[p.order_id] || []).push(p); return acc }, {})
  const itemsByOrder = (items || []).reduce((acc, i) => { (acc[i.order_id] = acc[i.order_id] || []).push(i); return acc }, {})

  // One lookup per order id instead of a .find() down `needItems` per item row.
  const closeTypeById = new Map(needItems.map(o => [o.id, o.close_type]))
  const compLines = (items || []).filter(i => closeTypeById.get(i.order_id) === 'writeoff')
  // The till's own read (S809 IMS-HANDOFF-3): a supervisor closing the shift on a PIN cannot read
  // `items`, so the Z-report froze each Complimentary bill at its typed Cost Price (usually NPR 0).
  // Each dish is costed with its choices, as on its Complimentary Slip.
  const inventory = compCost.inventory !== false
  const costing = compLines.length > 0
    ? await posLineCosts(supabase, clientId, compLines, {
        inventory,
        buildYourOwn: inventory && compCost.customization
          ? buildYourOwnAmong((t, sel) => scopedFromRaw(t, clientId, sel), compLines.map(i => i.recipe_id)) : [],
      })
    : null

  const byMethod = Object.fromEntries(PAY_METHODS.map(m => [m, 0]))
  let discountTotal = 0, voidTotal = 0, compTotal = 0, salesTotal = 0, orderCount = 0
  let paidCount = 0, voidCount = 0, compCount = 0

  for (const o of list) {
    if (o.close_type === 'paid') {
      orderCount++; paidCount++
      salesTotal += o.paid_amount || 0
      discountTotal += o.discount_amount || 0
      if (o.payment_method === 'Split') {
        (paymentsByOrder[o.id] || []).forEach(p => {
          if (byMethod[p.payment_method] !== undefined) byMethod[p.payment_method] += p.amount || 0
        })
      } else if (byMethod[o.payment_method] !== undefined) {
        byMethod[o.payment_method] += o.paid_amount || 0
      }
    } else if (o.close_type === 'void') {
      orderCount++; voidCount++
      voidTotal += forgoneMenuValue(itemsByOrder[o.id])
    } else if (o.close_type === 'writeoff') {
      orderCount++; compCount++
      compTotal += (itemsByOrder[o.id] || []).reduce((s, i) => s + i.qty * costing.costOf(i), 0)
    }
  }

  const cashSales = byMethod.Cash || 0
  return {
    orderCount, paidCount, voidCount, compCount, byMethod,
    discountTotal, voidTotal, compTotal, salesTotal, cashSales,
    movements: moveList, cashIn, cashOut, creditSettlementsCash, refundsCash, receiptCancelsCash,
    // What Voided Value is measured in, frozen with the report (S814 4d, SHIFTS-5). A closing_report
    // without it was frozen when voids were valued with VAT; the History row says so. Not one of the
    // eight cash figures pos_shifts_guard checks, so it can never refuse a close.
    voidBasis: 'ex_vat',
  }
}

// One label per movement kind, for the screen and the signed slip alike. A refund used to fall
// into "Cash out" (S754). A customer's cash payment is a receipt since S843 (credit_receipt_id set,
// no bill), and its cancellation a cash out of its own; the entry's reason names the receipt.
// expectedCashTwin.test.js checks every kind the database allows has a label here.
function movementLabel(m) {
  if (m.kind === 'credit_settlement') return m.credit_receipt_id ? 'Customer payment' : 'Credit settled'
  if (m.kind === 'credit_receipt_cancel') return 'Customer payment cancelled'
  if (m.kind === 'refund') return m.credit_note_label ? `Refund — ${m.credit_note_label}` : 'Refund'
  return m.direction === 'in' ? 'Cash in' : 'Cash out'
}

// What Cash Out holds besides ordinary cash outs, for its label: "incl. NPR 300 refunded on Credit
// Notes, NPR 500 customer payments cancelled". A closing_report frozen before S843 has no
// receiptCancelsCash, which reads as none.
function cashOutParts(report, fmt, refundWords) {
  const parts = []
  if (report.refundsCash > 0) parts.push(`${fmt(report.refundsCash)} ${refundWords}`)
  if (report.receiptCancelsCash > 0) parts.push(`${fmt(report.receiptCancelsCash)} customer payments cancelled`)
  return parts.length ? ` (incl. ${parts.join(', ')})` : ''
}

// The one definition of what should be in the drawer. Opening float, plus cash taken over the
// counter, plus every non-sale cash-in (credit settlements included), minus every cash-out.
// S809 1l: pos_shifts_guard repeats this sum, and loadShiftReport's cash figures, in SQL, and refuses
// a close whose report disagrees with it — so a change to either copy goes in the same commit as the
// other, or every close is refused. expectedCashTwin.test.js reads both.
function expectedCashOf(shift, report) {
  if (!shift || !report) return 0
  return (Number(shift.opening_cash) || 0) + (report.cashSales || 0) + (report.cashIn || 0) - (report.cashOut || 0)
}

function ReportBody({ report, opening, closing, variance }) {
  return (
    <>
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="card" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Total Sales</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-text1)' }}>{fmtNpr(report.salesTotal)}</div>
          <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{report.orderCount} order{report.orderCount !== 1 ? 's' : ''}</div>
        </div>
        <div className="card" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Discounts</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-text1)' }}>{fmtNpr(report.discountTotal)}</div>
        </div>
        <div className="card" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
            <Tip text={report.voidBasis === 'ex_vat'
              ? 'Menu value of this shift\'s voided bills, before VAT — the Sales Exceptions basis'
              : 'Menu value of this shift\'s voided bills, VAT included: this shift was closed before Crest valued voids before VAT, and its signed report keeps the figure it was closed with.'} width={260}>
              Voided Value
            </Tip>
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-red-text)' }}>{fmtNpr(report.voidTotal)}</div>
          {report.voidBasis !== 'ex_vat' && (
            <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>incl. VAT (closed before this change)</div>
          )}
        </div>
        <div className="card" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Comp Food Cost</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-text1)', fontVariantNumeric: 'tabular-nums' }}>{fmtNpr(report.compTotal)}</div>
        </div>
      </div>

      <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>Sales by Payment Method</p>
      <div className="table-wrap" style={{ marginBottom: 20 }}>
        <table className="data-table">
          <tbody>
            {PAY_METHODS.map(m => (
              <tr key={m}><td>{m}</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtNpr(report.byMethod[m] || 0)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>Cash Reconciliation</p>
      <div className="table-wrap">
        <table className="data-table">
          <tbody>
            <tr><td>Opening Cash</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtNpr(opening)}</td></tr>
            <tr><td>Cash Sales</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtNpr(report.cashSales)}</td></tr>
            {(report.cashIn || 0) > 0 && (
              <tr>
                <td>
                  <Tip text="Cash that entered the drawer without being a sale — a pay-in, or a credit customer or delivery partner paying in cash towards their Credit bills (in full or in part). Those payments used to be invisible here, so the drawer read as 'over' by the amount paid.">
                    Cash In{report.creditSettlementsCash > 0 ? ` (incl. ${fmtNpr(report.creditSettlementsCash)} from credit customers)` : ''}
                  </Tip>
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-green-text)' }}>+{fmtNpr(report.cashIn)}</td>
              </tr>
            )}
            {(report.cashOut || 0) > 0 && (
              <tr>
                <td><Tip text="Cash taken out of the drawer during the shift — paying a supplier, a staff advance, a float drop to the safe, a refund handed back on a Credit Note, or the cash of a customer payment cancelled as a mistake.">
                  Cash Out{cashOutParts(report, fmtNpr, 'refunded on Credit Notes')}
                </Tip></td>
                <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-red-text)' }}>−{fmtNpr(report.cashOut)}</td>
              </tr>
            )}
            {/* expectedCashOf, not an inline copy of it (S754) — the one definition the slip,
                the close modal and the frozen snapshot all use. */}
            <tr><td style={{ fontWeight: 700 }}>Expected Cash</td><td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(expectedCashOf({ opening_cash: opening }, report))}</td></tr>
            {closing != null && (
              <>
                <tr><td>Counted Cash</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtNpr(closing)}</td></tr>
                <tr>
                  <td style={{ fontWeight: 700 }}>Variance</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: `var(--theme-${varianceSignal(variance).tone}-text)` }}>
                    {varianceSignal(variance).mark}{' '}
                    {Math.abs(variance) < 1 ? 'Balanced' : `${variance > 0 ? '+' : ''}${fmtNpr(variance)} (${varianceSignal(variance).word})`}
                  </td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

export default function PosShifts() {
  const { clientId, profile, hasPosAccess, isAdmin, imsEnabled, clientModules, customizationEnabled } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate } = useScopedDb()
  // How the Z-report costs a Complimentary bill (loadShiftReport): with its choices where the outlet has
  // Crest IMS, a build-your-own dish by its build while Customization is on.
  const compCost = { inventory: outletHasIms({ isAdmin, imsEnabled, clientModules }), customization: customizationEnabled }

  const [mainTab, setMainTab] = useState('current') // 'current' | 'history'

  const [openShift,   setOpenShift]   = useState(undefined) // undefined = loading, null = none open
  const [currentReport, setCurrentReport] = useState(null)
  const [reportLoading, setReportLoading] = useState(false)
  // S754: a failed Z-report read. Rendered as ReportLoadError in place of the totals, never as zeros.
  const [reportError, setReportError] = useState(null)
  // Pay In / Pay Out — cash that moves without being a sale (S573).
  const [cashMoveOpen,   setCashMoveOpen]   = useState(false)
  const [cashMoveDir,    setCashMoveDir]    = useState('out')
  const [cashMoveAmount, setCashMoveAmount] = useState('')
  const [cashMoveReason, setCashMoveReason] = useState('')
  const [cashMoveSaving, setCashMoveSaving] = useState(false)
  const [cashMoveMsg,    setCashMoveMsg]    = useState('')

  const [modal, setModal] = useState(null) // 'open' | 'close' | null
  const [denomCounts, setDenomCounts] = useState(EMPTY_COUNTS)
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  // S809 SHIFTS-10: when the totals on screen were read. They are read when the page opens, on
  // Refresh and when this tab comes back into view, never on a timer (owner decision), so the page
  // says how old they are.
  const [reportAsOf, setReportAsOf] = useState(null)
  // S809 SHIFTS-11: the page's own message slots, above the tabs. `msg` renders only inside the
  // dialog, so a failed first read left "Loading…" on screen for good and "already closed" was set
  // as the dialog vanished. shiftReadError is the open-shift read, cleared by the next good one;
  // pageMsg is what an action came to ({ text, detail?, toHistory? }), cleared when a dialog opens.
  const [shiftReadError, setShiftReadError] = useState(null)
  const [pageMsg, setPageMsg] = useState(null)
  // An older open-shift read must never land over a newer one: a read started before a close and
  // answered after it would put the closed shift back on screen. Keyed per call, because every
  // caller is a full reload of the same thing and the newest one is the truth.
  const shiftReq = useLatestRequest()
  const shiftReqSeq = useRef(0)
  // The shift the totals on screen belong to, so one shift's figures never show under another's header.
  const reportShiftRef = useRef(null)
  // The shift the Close dialog was opened for. A reload while the drawer is counted (coming back to
  // this tab) can find it closed elsewhere and ANOTHER shift open; that count is never put on the new one.
  const closingShiftRef = useRef(null)
  // A material drawer discrepancy pending explicit confirmation: { freshReport, closing_cash,
  // expected, diff } — set by submitClose, committed by commitClose. Held as state (not a
  // window.confirm) so the ask renders in the product's own dialog, on top of the close modal.
  const [confirmShort, setConfirmShort] = useState(null)
  // S754 (owner decision): orders still open at close — { count, label } — pending a confirm. Closing
  // is allowed; the bills simply land on whichever shift is open when they are charged.
  const [confirmOpenOrders, setConfirmOpenOrders] = useState(null)

  const [staffNames, setStaffNames] = useState({})
  const [staffNamesLoaded, setStaffNamesLoaded] = useState(false)
  const [history, setHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [historyError, setHistoryError] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [reportsMap, setReportsMap] = useState({}) // { shiftId: report }
  const [reportErrorsMap, setReportErrorsMap] = useState({}) // { shiftId: error } — S754

  const [outletName,     setOutletName]     = useState('')
  const [propertyAddress, setPropertyAddress] = useState('')

  // S754: the page-level document Escape listener that lived here is gone. The dialog is on the
  // shared Modal now, whose Escape stack answers only the TOPMOST dialog — this listener fired
  // regardless, so Escape on the drawer-short ConfirmModal also closed the Close Shift modal behind
  // it and reopening wiped the denomination count. Modal's onClose below does the same
  // `if (!saving) setModal(null)`.

  useEffect(() => {
    if (!clientId) return
    loadOpenShift()
    // Raw `profiles` reads are RLS-limited to the caller's own row (id = auth.uid() OR admin) —
    // resolving OTHER staff members' names needs get_client_profile_names(), a SECURITY
    // DEFINER RPC. A raw query here silently showed "—" for every staff member except
    // whoever was logged in.
    // A failed read leaves the names as they were (logged): the shifts and their figures still stand.
    setStaffNamesLoaded(false)
    profileNamesRpc(supabase, clientId)
      .then(({ data, error }) => {
        if (error) { console.error('Shifts: staff names could not be read:', error); return }
        setStaffNames(namesMapOf(data))
        setStaffNamesLoaded(true)
      }, err => console.error('Shifts: staff names could not be read:', err))
    supabase.from('clients').select('name').eq('id', clientId).single()
      .then(({ data }) => setOutletName(data?.name || ''))
    supabase.from('settings').select('property_address').eq('client_id', clientId).maybeSingle()
      .then(({ data }) => setPropertyAddress(data?.property_address || ''))

    // Shift History wasn't reset here — an admin switching "view as" client while sitting on the
    // History tab kept showing the PREVIOUS client's shifts (and would print the previous
    // client's Z-Report figures under the freshly-loaded outlet name/address above). History is
    // reloaded lazily (openHistoryTab), not eagerly, to avoid an extra query on every client
    // switch for the common case where nobody's looking at History.
    setHistory([])
    setReportsMap({})
    setReportErrorsMap({})
    setHistoryError(null)
    setExpandedId(null)
    setHistoryLoaded(false)
    setShiftReadError(null)
    setPageMsg(null)
    if (mainTab === 'history') loadHistory()
  }, [clientId]) // eslint-disable-line

  // S840: the names read above leaves out Crest support, which the RPC names only for an id asked
  // for, so a shift it opened or closed would show no name and print none on its slip. The ones the
  // names read did not name are asked for once the shifts are in (usually none, and then nothing is sent).
  useMissingProfileNames({
    supabase, clientId, names: staffNames, ready: staffNamesLoaded,
    ids: [openShift?.opened_by, ...history.flatMap(sh => [sh.opened_by, sh.closed_by])],
    onFound: found => setStaffNames(prev => ({ ...prev, ...found })),
  })

  // S809 SHIFTS-10 (owner decision): read again when this tab comes back into view, not on a timer.
  // The office PC left on Shifts at 8 pm shows 10 pm's figures the moment someone looks at it again,
  // and "as of" beside the totals says when they were read.
  useEffect(() => {
    if (!clientId) return
    const onVisible = () => { if (document.visibilityState === 'visible') loadOpenShift() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [clientId]) // eslint-disable-line

  // Same pattern as PosOrders.jsx's printHtml — a popup window that auto-prints and closes.
  // On a POS device launched with Chrome's --kiosk-printing flag this goes straight to the
  // default printer with no dialog; without that flag it falls back to the normal print dialog.
  function printHtml(html) {
    // noopener as a window.open feature makes the call return null (no way to then write/print/
    // close the popup) — sever window.opener manually instead, on the reference we keep, for the
    // same "can't reach back into the live app" protection without losing that reference.
    const w = window.open('', '_blank', 'width=340,height=480,left=200,top=100')
    if (!w) return false
    w.opener = null
    w.document.write(html)
    w.document.close()
    w.focus()
    setTimeout(() => { w.print(); w.close() }, 300)
    return true
  }

  if (!hasPosAccess('supervisor')) return <Navigate to="/pos" replace />

  // Resolves with the open shift's row, null when the server shows none open, or undefined when the
  // read failed — the server's answer even when a newer read has taken the page, so a caller deciding
  // something (submitOpen) can use it. The totals carry on loading after it resolves.
  async function loadOpenShift() {
    const reqId = shiftReq.begin(++shiftReqSeq.current)
    const { data, error } = await settleWithin(scopedFrom('pos_shifts').eq('status', 'open').maybeSingle(),
      SHIFT_READ_MS, 'Checking the shift')
    const row = error ? undefined : (data || null)
    if (!shiftReq.isCurrent(reqId)) return row
    // A failed read is not "no shift is open" — that offered Open Shift over a shift already
    // running (S682). Keep the last-known state and say so, on the page (SHIFTS-11).
    // reportLoading is cleared here too: an older read's totals still loading are now superseded and
    // will not clear it themselves.
    if (error) { setShiftReadError(error); setReportLoading(false); return row }
    setShiftReadError(null)
    setOpenShift(row)
    const shiftId = row ? row.id : null
    if (reportShiftRef.current !== shiftId) {
      setCurrentReport(null)
      setReportError(null)
      setReportAsOf(null)
      reportShiftRef.current = shiftId
    }
    if (row) void loadCurrentReport(reqId, row.id)
    else setReportLoading(false)
    return row
  }

  // Current Shift's totals. Never rejects; superseded by any newer loadOpenShift.
  async function loadCurrentReport(reqId, shiftId) {
    setReportLoading(true)
    let report = null
    let failure = null
    try {
      report = await withTimeout(loadShiftReport(clientId, shiftId, compCost), SHIFT_REPORT_MS, 'Reading the shift totals')
    } catch (err) {
      failure = err
    }
    if (!shiftReq.isCurrent(reqId)) return
    if (failure) {
      // S754: a failed read is not a quiet shift. Null the report too, so the close modal cannot
      // show an Expected Cash left over from an earlier read — submitClose re-reads regardless.
      setCurrentReport(null)
      setReportError(failure)
    } else {
      setCurrentReport(report)
      setReportError(null)
      setReportAsOf(new Date())
    }
    setReportLoading(false)
  }

  // The Retry on a page whose first read failed: back to "Loading…" while it reads again.
  function retryFirstRead() {
    setShiftReadError(null)
    loadOpenShift()
  }

  async function loadHistory() {
    setHistoryLoading(true)
    setHistoryError(null)
    // Paged: two or three shifts a day with no date bound crosses 1000 rows inside the first
    // year, and the truncation would take the OLDEST shifts off a screen whose whole purpose is
    // looking back at them.
    const { data, error } = await fetchAllRows(() => scopedFrom('pos_shifts').eq('status', 'closed')
      .order('closed_at', { ascending: false }).order('id'))
    setHistoryLoading(false)
    // S754: rendered "No closed shifts yet." on a failed read. Left un-loaded so reopening the
    // tab retries.
    if (error) { setHistoryError(error); return }
    setHistory(data || [])
    setHistoryLoaded(true)
  }

  function openHistoryTab() {
    setMainTab('history')
    if (!historyLoaded) loadHistory()
  }

  async function toggleExpand(shift) {
    if (expandedId === shift.id) { setExpandedId(null); return }
    setExpandedId(shift.id)
    if (reportsMap[shift.id]) return
    setReportErrorsMap(m => ({ ...m, [shift.id]: null }))
    // Prefer the snapshot frozen at close — recomputing live is what let a reprinted Z-report
    // disagree with the signed one. Only shifts closed before S573 have no snapshot and fall
    // back to a live recompute.
    try {
      const report = shift.closing_report
        || await withTimeout(loadShiftReport(clientId, shift.id, compCost), SHIFT_REPORT_MS, 'Reading the closing report')
      setReportsMap(m => ({ ...m, [shift.id]: report }))
    } catch (err) {
      // S754: the row shows the failure, not a Z-report of zeros. Not cached, so re-expanding retries.
      setReportErrorsMap(m => ({ ...m, [shift.id]: err }))
    }
  }

  function openModal(type) {
    setDenomCounts(EMPTY_COUNTS)
    setLabel(type === 'open' ? suggestShiftLabel() : '')
    setMsg('')
    setPageMsg(null)
    closingShiftRef.current = type === 'close' ? (openShift?.id ?? null) : null
    setModal(type)
    // Re-read the money before showing Expected Cash. This page loads its report once, on mount,
    // so a shift opened at 8pm and closed at 11pm was being reconciled against 8pm's figures —
    // the cashier was told they were short by three hours of takings (S573).
    if (type === 'close') loadOpenShift()
  }

  // Records cash that moved without being a sale, against the open shift. Without this the
  // drawer's real contents and Expected Cash diverge every time a supplier is paid or a float is
  // dropped, and the supervisor is left explaining a variance the system created.
  async function submitCashMovement() {
    if (!openShift) return
    const amt = parseFloat(cashMoveAmount)
    if (!amt || amt <= 0) { setCashMoveMsg('Enter an amount greater than zero.'); return }
    if (!cashMoveReason.trim()) { setCashMoveMsg('A reason is required — this is a cash record.'); return }
    setCashMoveSaving(true); setCashMoveMsg('')
    const { error } = await settleWithin(scopedInsert('pos_cash_movements', {
      shift_id: openShift.id,
      direction: cashMoveDir,
      kind: cashMoveDir === 'in' ? 'pay_in' : 'pay_out',
      amount: amt,
      reason: cashMoveReason.trim(),
      created_by: profile?.id || null,
    }), SHIFT_WRITE_MS, 'Recording the cash')
    setCashMoveSaving(false)
    if (error) {
      // S754: a guard refusal (rank, closed shift) is raised before the insert, and errorLine names
      // it. A dropped connection or a timeout proves nothing either way, so it sends them to the
      // list instead of claiming the drawer is unchanged — a blind retry would record the cash twice.
      if (isNoAnswer(error)) {
        setCashMoveMsg(cashUnknownText(error) + detailSuffix(error))
        await loadOpenShift()
      } else {
        setCashMoveMsg(errorLine(error))
        // A closed shift underneath the form: show the page's real state.
        if (error.hint === 'pos_cash_movement_shift_closed' || /pos_cash_movement_shift_closed/.test(error.message || '')) await loadOpenShift()
      }
      return
    }
    setCashMoveAmount(''); setCashMoveReason(''); setCashMoveOpen(false)
    await loadOpenShift()
  }

  async function submitOpen() {
    setSaving(true); setMsg('')
    const opening_cash = sumDenoms(denomCounts)
    const openedAt = new Date()
    const { error } = await settleWithin(scopedInsert('pos_shifts', {
      status: 'open', label: label.trim() || null,
      opened_by: profile?.id || null, opening_cash,
      opening_denominations: Object.fromEntries(DENOMINATIONS.map(d => [d, parseInt(denomCounts[d]) || 0])),
    }), SHIFT_WRITE_MS, 'Opening the shift')
    if (error && isNoAnswer(error)) {
      // S809 SHIFTS-9: no answer is not "not opened" — the insert may have landed. Read what the
      // server holds: a shift open now goes on the page; otherwise the count stays in the dialog for
      // a retry, which the one-open-shift index answers (23505, below) if the first press did land.
      const found = await loadOpenShift()
      setSaving(false)
      if (found) {
        setModal(null)
        setPageMsg({ text: openUnknownText(error, found), detail: asActionError(error).detail })
      } else {
        setMsg('error:' + openUnknownText(error, found) + detailSuffix(error))
      }
      return
    }
    setSaving(false)
    if (error) {
      if (error.code === '23505') {
        // A definite answer: one shift per outlet. Show the open one rather than "refresh the page".
        setModal(null)
        setPageMsg({ text: SHIFT_ALREADY_OPEN_TEXT })
        await loadOpenShift()
        return
      }
      setMsg('error:The shift was not opened. ' + errorLine(error))
      return
    }
    const printed = printHtml(buildShiftSlipHtml({
      mode: 'open', outletName, propertyAddress,
      label: label.trim() || 'Shift', openedByName: profile?.full_name, openedAt,
      denomCounts, opening: opening_cash,
    }))
    setModal(null)
    // printHtml is false when the browser blocked the print window (SHIFTS-9).
    if (!printed) setPageMsg({ text: slipNotPrintedText('open') })
    await loadOpenShift()
  }

  async function submitClose() {
    // No `!currentReport` bail (S754): the report is re-read below before anything is written, and
    // after a failed modal-open read that bail made Close Shift a button that silently did nothing.
    // S809 SHIFTS-10: nor a silent `!openShift` one. Opening this dialog (and coming back to this tab)
    // re-reads the shift; none open, or another one, means the shift being counted was closed
    // elsewhere: say so on the page, behind no scrim, and close the dialog.
    if (!closingThisShift()) { showClosedElsewhere(); return }
    setSaving(true); setMsg('')

    // S754 (owner decision): WARN about orders still open, then let the close proceed. The check
    // this replaces filtered `.eq('shift_id', openShift.id)` — but shift_id is written onto an
    // order only when it is BILLED (closeOrder), so an open order never carries one and the
    // refusal could not fire. Every open order for the client is read instead. Carry-over needs no
    // write: an order billed after this close is stamped with the shift open at that moment, so its
    // cash reconciles on the next shift. A failed read refuses the close — a check that could not
    // run has not passed. `part_of_order_id` (S836): an open part bill is named by its table in the
    // warning (openOrdersLabel), not counted as a takeaway.
    const { data: openOrders, error: openErr } = await settleWithin(scopedFrom('pos_orders', 'id, order_no, table_id, part_of_order_id, table_name')
      .eq('status', 'open').order('order_no'), SHIFT_READ_MS, 'Checking for open orders')
    if (openErr) {
      setSaving(false)
      setMsg('error:Could not check whether any orders are still open, so nothing was closed. Try Close Shift again. ' + errorLine(openErr))
      return
    }
    if ((openOrders || []).length > 0) {
      setSaving(false)
      setConfirmOpenOrders({ count: openOrders.length, label: openOrdersLabel(openOrders) })
      return
    }
    await continueClose()
  }

  // Still the shift the dialog was opened for, and still open as far as the page knows.
  function closingThisShift() {
    return !!openShift && openShift.id === closingShiftRef.current
  }

  // The shift this dialog is closing was closed somewhere else (SHIFTS-10/11): on the page, never in
  // the dialog that is going away, naming where the signed count is. This count was not saved.
  function showClosedElsewhere() {
    setSaving(false)
    setConfirmOpenOrders(null)
    setConfirmShort(null)
    setModal(null)
    setPageMsg({ text: SHIFT_ALREADY_CLOSED_TEXT, toHistory: true })
    setHistoryLoaded(false)
  }

  // The rest of the close, after the open-orders warning has been answered (or was not needed).
  async function continueClose() {
    // A reload while the open-orders question was up (coming back to this tab) can find the shift
    // closed elsewhere; the confirm calls the newest render's continueClose, which sees it.
    if (!closingThisShift()) { showClosedElsewhere(); return }
    setConfirmOpenOrders(null)
    setSaving(true); setMsg('')

    // Re-read once more immediately before writing. The modal refresh above can be minutes old by
    // the time the drawer has actually been counted, and a bill closed during the count belongs in
    // this shift's figures. This is the snapshot that gets frozen and signed.
    let freshReport
    try {
      freshReport = await withTimeout(loadShiftReport(clientId, openShift.id, compCost), SHIFT_REPORT_MS, "Reading this shift's sales")
    } catch (err) {
      // S754: this used to freeze a Z-report of zeros into closing_report and print it on the
      // signed slip. The close write has not been attempted, so "nothing was closed" is true.
      setSaving(false)
      setMsg("error:This shift's sales could not be read, so Expected Cash cannot be worked out — nothing was closed. The count you entered is still here; try Close Shift again. " + errorLine(err))
      return
    }
    const closing_cash = sumDenoms(denomCounts)
    const expected = expectedCashOf(openShift, freshReport)

    // A material discrepancy gets an explicit confirmation naming the amount. Closing NPR 5,000
    // short should not be the same single tap as closing balanced — and the recount has to be
    // offered while the drawer is still open, not after the slip prints. The ask is the
    // ConfirmModal below; commitClose is the write it guards.
    const diff = closing_cash - expected
    if (Math.abs(diff) >= 100) {
      setSaving(false)
      setConfirmShort({ freshReport, closing_cash, expected, diff })
      return
    }
    await commitClose(freshReport, closing_cash, expected)
  }

  async function commitClose(freshReport, closing_cash, expected) {
    if (!closingThisShift()) { showClosedElsewhere(); return }
    setSaving(true)
    setConfirmShort(null)
    // .eq('status', 'open') + .select() together detect a double-close: the DB's only relevant
    // constraint (pos_shifts_one_open_per_client) guards concurrent opens, not closes, so without
    // this a second supervisor closing the same shift on another terminal would silently overwrite
    // the first person's real cash count with no error (a WHERE clause matching zero rows isn't a
    // Postgres error — it just updates nothing).
    // S809 2b (SHIFTS-7): no close time is sent. pos_shifts_guard stamps closed_at and the report's
    // capturedAt from the server clock, and the slip below prints the time the row came back with,
    // so a tablet whose clock reset cannot date the shift (or the paper) to another day.
    const { data: closed, error } = await settleWithin(scopedUpdate('pos_shifts', {
      status: 'closed', closed_by: profile?.id || null,
      closing_cash,
      closing_denominations: Object.fromEntries(DENOMINATIONS.map(d => [d, parseInt(denomCounts[d]) || 0])),
      // Frozen at close, never recomputed — the same capture-once principle the Monthly Owner
      // Report uses. Shift History used to recompute these live, so a REPRINTED Z-report could
      // show different numbers from the one that was signed, with nothing saying which was right.
      closing_report: {
        ...freshReport,
        openingCash: Number(openShift.opening_cash) || 0,
        closingCash: closing_cash,
        expectedCash: expected,
        variance: closing_cash - expected,
      },
    }).eq('id', openShift.id).eq('status', 'open').select(), SHIFT_WRITE_MS, 'Closing the shift')
    setSaving(false)
    // S754: pos_shifts_guard refuses an UPDATE of a closed shift outright (it used to match zero
    // rows and fall to the branch below), so that refusal is the same double-close and is handled
    // the same way. Rank and other refusals are worded by errorLine.
    const closedUnderneath = error && (error.hint === 'pos_shift_closed' || /pos_shift_closed/.test(error.message || ''))
    if (error && !closedUnderneath) {
      // S809 SHIFTS-9: a timeout is no answer too, so it gets the "not known" wording, never "not closed".
      setMsg(isNoAnswer(error)
        ? 'error:' + closeUnknownText(error) + detailSuffix(error)
        : 'error:The shift was not closed. ' + errorLine(error))
      return
    }
    if (closedUnderneath || !closed || closed.length === 0) {
      // S809 SHIFTS-11: on the page, not in the dialog that is closing, and naming where the signed
      // count is (another supervisor's close won; this count was not saved and no slip prints).
      showClosedElsewhere()
      await loadOpenShift()
      return
    }
    const printed = printHtml(buildShiftSlipHtml({
      mode: 'close', outletName, propertyAddress,
      label: openShift.label || 'Shift',
      openedByName: staffNames[openShift.opened_by], closedByName: profile?.full_name,
      openedAt: openShift.opened_at, closedAt: closed[0].closed_at,
      denomCounts, opening: openShift.opening_cash, closing: closing_cash, report: freshReport,
    }))
    setModal(null)
    // printHtml is false when the browser blocked the print window (SHIFTS-9): the slip is in History.
    if (!printed) setPageMsg({ text: slipNotPrintedText('close'), toHistory: true, slip: true })
    setHistoryLoaded(false) // force a refetch next time History is opened
    await loadOpenShift()
  }

  const expectedCash = expectedCashOf(openShift, currentReport)
  // The open-shift read's failure, worded for the page (SHIFTS-11): converted here, where the reader
  // is known to be a supervisor or above, never at render inside ActionError.
  const shiftReadView = shiftReadError ? (() => {
    const { text, detail } = asActionError(shiftReadError, 'operator')
    return { text: `${shiftReadFailLead(openShift === undefined)} ${text}`, detail }
  })() : null

  return (
    <div>

      <div className="page-header">
        <h1 className="page-title">Shifts</h1>
        <p className="page-subtitle">
          Open a shift with a starting cash count, check its totals as the shift runs (read again when you come back to this page or press Refresh), and count the drawer against the takings when it ends — the closing report, often called a Z-report.
        </p>
      </div>

      {/* S809 SHIFTS-11: the page's own message slots. The dialog's line is unseen once the dialog
          closes, and on a failed first read there is no dialog at all. */}
      {shiftReadView && <ActionError className="action-error--top" error={shiftReadView} />}
      {pageMsg && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 280px', minWidth: 0 }}>
            <ActionError className="action-error--top" error={pageMsg} />
          </div>
          {pageMsg.toHistory && mainTab !== 'history' && (
            <button className="btn btn-ghost btn-sm" onClick={openHistoryTab}>Open Shift History</button>
          )}
        </div>
      )}

      <Tabs idBase="pos-shifts" label="Shift views" active={mainTab} style={{ marginBottom: 24 }}
        onChange={key => (key === 'history' ? openHistoryTab() : setMainTab('current'))}
        tabs={[
          { key: 'current', label: 'Current Shift' },
          { key: 'history', label: 'Shift History', title: 'Past closed shifts — open one to see its closing report' },
        ]} />

      {/* ══ CURRENT SHIFT TAB ══ */}
      {mainTab === 'current' && (
        <>
          {openShift === undefined && shiftReadError ? (
            // S809 SHIFTS-11: the first read failed, so there is no last state to show — not
            // "Loading…" for good. The reason is in the message above.
            <div className="card" style={{ padding: 32, textAlign: 'center' }}>
              <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--theme-text3)' }}>Nothing is shown until the shift can be read.</p>
              <button className="btn btn-primary" onClick={retryFirstRead}>Retry</button>
            </div>
          ) : openShift === undefined ? (
            <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
          ) : openShift === null ? (
            <div className="card" style={{ padding: 32, textAlign: 'center' }}>
              <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--theme-text3)' }}>No shift is currently open.</p>
              <button className="btn btn-primary" onClick={() => openModal('open')}>Open Shift</button>
            </div>
          ) : (
            <>
              <div className="card" style={{ padding: '14px 18px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <span className="badge-gray" style={{ fontSize: 11, marginRight: 10 }}>◷ OPEN</span>
                  <span style={{ fontSize: 13, color: 'var(--theme-text1)', fontWeight: 600 }}>{openShift.label || 'Shift'}</span>
                  <span style={{ fontSize: 12, color: 'var(--theme-text3)', marginLeft: 10 }}>
                    Opened by {staffNames[openShift.opened_by] || '—'} · {fmtSpan(openShift.opened_at)} ago
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost" onClick={() => { setCashMoveOpen(o => !o); setCashMoveMsg('') }}>
                    ± Cash In / Out
                  </button>
                  <button className="btn btn-danger"
                    onClick={() => openModal('close')}>Close Shift &amp; Count Cash</button>
                </div>
              </div>

              {cashMoveOpen && (
                <div className="card" style={{ padding: '14px 16px', marginBottom: 16 }}>
                  <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--theme-text2)' }}>
                    Record cash that moved without being a sale — paying a supplier, a staff advance, a float
                    drop to the safe, or money added to the drawer. This keeps Expected Cash matching what is
                    physically there, so the shift doesn't report a variance it created itself.
                  </p>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <div>
                      <label htmlFor="cashmove-dir" style={{ display: 'block', fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4 }}>Direction</label>
                      <select id="cashmove-dir" className="form-select" value={cashMoveDir} onChange={e => setCashMoveDir(e.target.value)} style={{ width: 130 }}>
                        <option value="out">Cash Out</option>
                        <option value="in">Cash In</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="cashmove-amount" style={{ display: 'block', fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4 }}>Amount (NPR)</label>
                      <input id="cashmove-amount" className="form-input" type="number" min="0" step="1" style={{ width: 130 }}
                        value={cashMoveAmount} onChange={e => setCashMoveAmount(e.target.value)} placeholder="0" />
                    </div>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <label htmlFor="cashmove-reason" style={{ display: 'block', fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4 }}>Reason *</label>
                      <input id="cashmove-reason" className="form-input" style={{ width: '100%' }}
                        value={cashMoveReason} onChange={e => setCashMoveReason(e.target.value)}
                        placeholder="e.g. Paid vegetable supplier" />
                    </div>
                    <button className="btn btn-primary" onClick={submitCashMovement} disabled={cashMoveSaving}>
                      {cashMoveSaving ? 'Saving…' : 'Record'}
                    </button>
                  </div>
                  {cashMoveMsg && <p role="alert" style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--theme-red-text)' }}>{cashMoveMsg}</p>}
                  {(currentReport?.movements || []).length > 0 && (
                    <div style={{ marginTop: 12, borderTop: '1px solid var(--theme-border)', paddingTop: 10 }}>
                      {currentReport.movements.map(m => (
                        <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', color: 'var(--theme-text2)' }}>
                          <span>
                            {movementLabel(m)}
                            {m.reason ? ` — ${m.reason}` : ''}
                          </span>
                          <strong style={{ color: m.direction === 'in' ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                            {m.direction === 'in' ? '+' : '−'}{fmtNpr(Number(m.amount) || 0)}
                          </strong>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* S809 SHIFTS-10: how old the totals are, and a way to read them again. A refresh keeps
                  the figures on screen until the new ones land. */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                {reportAsOf && (
                  <Tip text="These totals were read at this time. They are read again when you come back to this page and when you press Refresh, not by themselves — refresh before deciding anything from them.">
                    <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Totals {asOfLabel(reportAsOf)}</span>
                  </Tip>
                )}
                <button className="btn btn-ghost btn-sm" onClick={() => loadOpenShift()} disabled={reportLoading}>
                  {reportLoading ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>
              {!currentReport && !reportError ? (
                <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>
                  {reportLoading ? 'Loading totals…' : 'The totals have not been read yet — press Refresh.'}
                </p>
              ) : reportError ? (
                <ReportLoadError error={reportError} />
              ) : (
                <ReportBody report={currentReport} opening={openShift.opening_cash} closing={null} variance={0} />
              )}
            </>
          )}
        </>
      )}

      {/* ══ SHIFT HISTORY TAB ══ */}
      {mainTab === 'history' && (
        <>
          {historyLoading ? (
            <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
          ) : historyError ? (
            <ReportLoadError error={historyError} />
          ) : history.length === 0 ? (
            <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
              No closed shifts yet.
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Shift</th>
                    <th><Tip text="The Nepali date the shift opened. A shift that closed on a later day shows that day and time underneath.">Date</Tip></th>
                    <th>Duration</th>
                    <th>Opened / Closed By</th>
                    <th style={{ textAlign: 'right' }}>Variance</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(s => {
                    // S754: this was `closing - (opening + cashSales)`, ignoring cash in/out, so any
                    // shift with a supplier payment or credit settlement showed a variance that
                    // disagreed with its own Z-report. The frozen snapshot's variance is the signed
                    // figure; only a pre-S573 recompute has none and derives it through the one
                    // definition. The snapshot needs no expand, so the column shows it straight away.
                    const shiftReport = reportsMap[s.id] || s.closing_report
                    const variance = !shiftReport ? 0
                      : shiftReport.variance != null ? Number(shiftReport.variance)
                      : (Number(s.closing_cash) || 0) - expectedCashOf(s, shiftReport)
                    const dates = shiftDates(s.opened_at, s.closed_at)
                    return (
                      <Fragment key={s.id}>
                        <tr onClick={() => toggleExpand(s)} style={{ cursor: 'pointer' }}>
                          {/* RowDisclosure is the keyboard/SR path to the Z-report — the row
                              onClick stays as the mouse convenience, never role="button" on
                              the tr (it would strip the row out of the table's structure). */}
                          <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                            <RowDisclosure
                              expanded={expandedId === s.id}
                              onToggle={() => toggleExpand(s)}
                              label={historyRowLabel(s)}
                            /> {s.label || 'Shift'}
                          </td>
                          {/* S809 SHIFTS-8: the day, so "last Tuesday's evening shift" is found by reading. */}
                          <td>
                            <span style={{ whiteSpace: 'nowrap' }}>{dates.opened || '—'}</span>
                            {dates.closed && (
                              <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>
                                closed <span style={{ whiteSpace: 'nowrap' }}>{dates.closed}</span>
                              </div>
                            )}
                          </td>
                          <td>{fmtSpan(s.opened_at, s.closed_at)}</td>
                          <td style={{ fontSize: 12 }}>{staffNames[s.opened_by] || '—'} / {staffNames[s.closed_by] || '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            {shiftReport ? (
                              <span className={`badge-${varianceSignal(variance).tone}`} style={{ fontSize: 11 }}>
                                {varianceSignal(variance).mark} {Math.abs(variance) < 1 ? 'Balanced' : `${fmtNpr(variance)} ${varianceSignal(variance).word}`}
                              </span>
                            ) : '—'}
                          </td>
                          {/* Mouse affordance only — the RowDisclosure carries aria-expanded. */}
                          <td aria-hidden="true" style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>{expandedId === s.id ? '▲ hide' : '▼ closing report'}</td>
                        </tr>
                        {expandedId === s.id && (
                          <tr>
                            <td colSpan={6} style={{ background: 'var(--theme-bg)', padding: '16px 18px' }}>
                              {reportErrorsMap[s.id] ? (
                                <ReportLoadError error={reportErrorsMap[s.id]} />
                              ) : !reportsMap[s.id] ? (
                                <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Loading…</span>
                              ) : (
                                <>
                                  <ReportBody report={reportsMap[s.id]} opening={s.opening_cash} closing={s.closing_cash} variance={variance} />
                                  <button className="btn btn-ghost" style={{ fontSize: 12, marginTop: 14 }}
                                    onClick={() => {
                                      const printed = printHtml(buildShiftSlipHtml({
                                        mode: 'close', outletName, propertyAddress,
                                        label: s.label || 'Shift',
                                        openedByName: staffNames[s.opened_by], closedByName: staffNames[s.closed_by],
                                        openedAt: s.opened_at, closedAt: s.closed_at,
                                        denomCounts: s.closing_denominations || EMPTY_COUNTS,
                                        opening: s.opening_cash, closing: s.closing_cash || 0, report: reportsMap[s.id],
                                      }))
                                      // A slip that printed now answers any earlier "did not print".
                                      setPageMsg(m => (printed ? (m?.slip ? null : m) : { text: slipNotPrintedText('reprint'), slip: true }))
                                    }}>
                                    🖨 Reprint closing report
                                  </button>
                                </>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ══ OPEN / CLOSE MODAL ══ */}
      {modal && (
        <Modal
          title={modal === 'open' ? 'Open Shift' : 'Close Shift — count the drawer'}
          onClose={() => { if (!saving) setModal(null) }}
          maxWidth={480}
          zIndex={1100}
        >
            <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-text3)' }}>
              Count the drawer and enter the quantity of each note/coin.
            </p>

            {modal === 'open' && (
              <input placeholder="Label (optional, e.g. Morning)" aria-label="Shift label" value={label} onChange={e => setLabel(e.target.value)}
                className="form-input" style={{ width: '100%', marginBottom: 14 }} />
            )}

            {modal === 'close' && currentReport && (
              <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--theme-text2)' }}>
                Expected cash: <strong>{fmtNpr(expectedCash)}</strong> (opening {fmtNpr(openShift.opening_cash)} + cash sales {fmtNpr(currentReport.cashSales)}
                {currentReport.cashIn  > 0 && <> + cash in {fmtNpr(currentReport.cashIn)}</>}
                {currentReport.cashOut > 0 && <> − cash out {fmtNpr(currentReport.cashOut)}</>})
              </p>
            )}
            {/* S754: without this the modal simply had no Expected Cash line and no live variance,
                with nothing saying why. */}
            {/* The page's read-error line is behind this dialog's scrim, so the dialog says it too. */}
            {modal === 'close' && shiftReadError && (
              <p role="alert" style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-red-text)' }}>
                The shift could not be read again, so the Expected Cash shown may be out of date. Close
                Shift reads the sales again first, and closes nothing if that read fails.
              </p>
            )}
            {modal === 'close' && reportError && !reportLoading && (
              <p role="alert" style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-red-text)' }}>
                This shift's sales could not be read, so Expected Cash is unknown. You can still count the
                drawer — Close Shift reads the sales again first, and closes nothing if that read fails too.
              </p>
            )}

            <DenomGrid counts={denomCounts} onChange={setDenomCounts} />

            {/* Live variance as the drawer is counted. Closing NPR 5,000 short used to take
                exactly the same single tap as closing balanced — the figure only appeared after
                the shift was closed and the slip printed, which is too late to recount. */}
            {modal === 'close' && currentReport && (() => {
              const counted = sumDenoms(denomCounts)
              // S846: before a single box is filled in, nothing has been counted, so there is no
              // variance to judge yet. The dialog used to open on a red "▲ Short by" the whole
              // Expected Cash. A typed 0 is '0', so it counts as counting.
              const nothingCounted = DENOMINATIONS.every(d => denomCounts[d] === '' || denomCounts[d] == null)
              if (nothingCounted) {
                return (
                  <div style={{
                    marginTop: 14, padding: '10px 14px', borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--theme-border)', background: 'var(--theme-card)',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: 'var(--theme-text2)' }}>Counted</span>
                      <strong style={{ color: 'var(--theme-text1)', fontVariantNumeric: 'tabular-nums' }}>{fmtNpr(counted)}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginTop: 4 }}>
                      <span style={{ color: 'var(--theme-text2)' }}>Still to count</span>
                      <strong style={{ color: 'var(--theme-text1)', fontVariantNumeric: 'tabular-nums' }}>{fmtNpr(expectedCash)}</strong>
                    </div>
                  </div>
                )
              }
              const diff = counted - expectedCash
              const over = diff > 0
              const signal = varianceSignal(diff)
              return (
                <div style={{
                  marginTop: 14, padding: '10px 14px', borderRadius: 'var(--radius-md)',
                  border: `1px solid color-mix(in srgb, var(--theme-${signal.tone}) 30%, transparent)`,
                  background: `color-mix(in srgb, var(--theme-${signal.tone}) 8%, transparent)`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span style={{ color: 'var(--theme-text2)' }}>Counted</span>
                    <strong style={{ color: 'var(--theme-text1)' }}>{fmtNpr(counted)}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginTop: 4 }}>
                    <span style={{ color: 'var(--theme-text2)' }}>{Math.abs(diff) < 1 ? 'Balanced' : over ? 'Over by' : 'Short by'}</span>
                    <strong style={{ color: `var(--theme-${signal.tone}-text)` }}>
                      {signal.mark} {Math.abs(diff) < 1 ? '—' : fmtNpr(Math.abs(diff))}
                    </strong>
                  </div>
                </div>
              )
            })()}

            {msg && <p role="alert" style={{ margin: '14px 0 0', fontSize: 12, color: msg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>{msg.replace(/^(error|ok):/, '')}</p>}

            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setModal(null)} disabled={saving}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }}
                onClick={modal === 'open' ? submitOpen : submitClose} disabled={saving}>
                {saving ? 'Saving…' : modal === 'open' ? 'Open Shift' : 'Close Shift'}
              </button>
            </div>

            {/* Still rendered INSIDE this dialog rather than beside it. The parent Modal is
                position:fixed with zIndex 1100 and therefore its own stacking context, so a child
                overlay stacks above the panel for free; a sibling at the default 100 would render
                underneath. Modal nests properly since S574 — only the topmost answers Escape and
                Tab — and ConfirmModal takes a zIndex prop now if this ever needs to move out. */}
            {/* S754: same placement rule as the drawer-short confirm below — a child of this dialog. */}
            {confirmOpenOrders && (
              <ConfirmModal
                title={`${confirmOpenOrders.count} order${confirmOpenOrders.count === 1 ? ' is' : 's are'} still open`}
                confirmLabel="Close shift anyway"
                busy={saving} busyLabel="Closing…"
                onConfirm={continueClose}
                onCancel={() => setConfirmOpenOrders(null)}
              >
                <p style={{ margin: '0 0 10px' }}>
                  <strong>{confirmOpenOrders.label}</strong> {confirmOpenOrders.count === 1 ? 'is' : 'are'} still open — {confirmOpenOrders.count === 1 ? "it'll" : "they'll"} be billed on the next shift.
                </p>
                <p style={{ margin: 0 }}>
                  {confirmOpenOrders.count === 1 ? 'It is' : 'They are'} not on this shift's Z-report, and the cash taken for {confirmOpenOrders.count === 1 ? 'it' : 'them'} counts
                  toward the drawer of whichever shift is open when {confirmOpenOrders.count === 1 ? "it's" : "they're"} charged. Cancel to bill {confirmOpenOrders.count === 1 ? 'it' : 'them'} first.
                </p>
              </ConfirmModal>
            )}
            {confirmShort && (
              <ConfirmModal
                title={`Drawer is ${confirmShort.diff > 0 ? 'over' : 'short'} by ${fmtNpr(Math.abs(confirmShort.diff))}`}
                confirmLabel={`Close shift ${confirmShort.diff > 0 ? 'over' : 'short'} by ${fmtNpr(Math.abs(confirmShort.diff))}`}
                danger
                busy={saving} busyLabel="Closing…"
                onConfirm={() => commitClose(confirmShort.freshReport, confirmShort.closing_cash, confirmShort.expected)}
                onCancel={() => setConfirmShort(null)}
              >
                <p style={{ margin: '0 0 10px' }}>
                  Expected <strong>{fmtNpr(confirmShort.expected)}</strong> · Counted <strong>{fmtNpr(confirmShort.closing_cash)}</strong>
                </p>
                <p style={{ margin: 0 }}>
                  Recount before closing if that looks wrong — the drawer is still open. This figure
                  is printed on the Z-report and kept as the shift record.
                </p>
              </ConfirmModal>
            )}
        </Modal>
      )}
    </div>
  )
}
