import { useState, useEffect, Fragment } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { scopedFrom as scopedFromRaw } from '../../../shared/scopedDb'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import Tip from '../../../components/Tip'
import RowDisclosure from '../../../components/RowDisclosure'
import Modal from '../../../components/Modal'
import ConfirmModal from '../../../components/ConfirmModal'
import { computeRecipeCosts } from '../../../utils/recipeCost'
import { adToBs, BS_MONTHS } from '../../../utils/bsCalendar'
import { PAYMENT_METHODS } from '../orders/posOrdersConstants'
import { escapeHtml as esc } from '../../../utils/escapeHtml'
import { nepalTime } from '../../../shared/nepalTime'

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`
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
const EMPTY_COUNTS = Object.fromEntries(DENOMINATIONS.map(d => [d, '']))

function sumDenoms(counts) {
  return DENOMINATIONS.reduce((s, d) => s + d * (parseInt(counts[d]) || 0), 0)
}

// Suggests a generic shift label from the current time — Morning/Afternoon/Evening/Night,
// matching standard F&B daypart terms. Pre-fills the Label field on Open Shift; fully editable.
function suggestShiftLabel() {
  const h = new Date().getHours()
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
          <div key={d} style={{ background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 8, padding: '6px 8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text1)' }}>₨{d}</span>
              <span style={{ fontSize: 10, color: 'var(--theme-text3)' }}>{fmtNpr(d * (parseInt(counts[d]) || 0))}</span>
            </div>
            <input type="number" min="0" step="1" value={counts[d]}
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

function fmtAdBs(date) {
  const dt = new Date(date)
  const ad = dt.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })
  const bs = adToBs(dt)
  return `${ad} (${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year})`
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
  const varianceLabel = Math.abs(variance) < 1 ? 'Balanced' : `${variance > 0 ? '+' : ''}NPR ${variance.toFixed(2)} (${variance > 0 ? 'over' : 'short'})`

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
  <div class="row tot"><span>Total Sales:</span><span>NPR ${report.salesTotal.toFixed(2)}</span></div>
  ${PAY_METHODS.filter(m => report.byMethod[m]).map(m => `<div class="row ind"><span>${m}</span><span>${report.byMethod[m].toFixed(2)}</span></div>`).join('')}
  <hr>
  <div class="row"><span>Bills (Paid):</span><span>${report.paidCount}</span></div>
  <div class="row"><span>Voided:</span><span>${report.voidCount}</span></div>
  <div class="row"><span>Complimentary:</span><span>${report.compCount}</span></div>
  <hr>
  <div class="row"><span>Opening Cash:</span><span>${opening.toFixed(2)}</span></div>
  <div class="row"><span>Cash Sales:</span><span>${report.cashSales.toFixed(2)}</span></div>
  ${report.cashIn  ? `<div class="row"><span>Cash In${report.creditSettlementsCash ? ` (incl. ${report.creditSettlementsCash.toFixed(2)} credit settled)` : ''}:</span><span>+${report.cashIn.toFixed(2)}</span></div>` : ''}
  ${report.cashOut ? `<div class="row"><span>Cash Out:</span><span>-${report.cashOut.toFixed(2)}</span></div>` : ''}
  <div class="row tot"><span>Expected Cash:</span><span>${expected.toFixed(2)}</span></div>
  <div class="row"><span>Counted Cash:</span><span>${closing.toFixed(2)}</span></div>
  <div class="row tot"><span>Variance:</span><span>${varianceLabel}</span></div>
  ` : ''}
  <hr>
  <div class="c b" style="margin:2px 0">DENOMINATION</div>
  ${DENOMINATIONS.map(d => {
    const qty = parseInt(denomCounts[d]) || 0
    return `<div class="row"><span>₨${d} × ${qty}</span><span>${(d * qty).toFixed(2)}</span></div>`
  }).join('')}
  <hr>
  <div class="row tot"><span>Total</span><span>NPR ${total.toFixed(2)}</span></div>
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

// Shared X/Z-report totals from a shift's closed orders — used for the live Current Shift view
// and for expanding a past shift in History. Void/Comp valuation mirrors PosExceptionReport.jsx.
async function loadShiftReport(clientId, shiftId) {
  // Both reads are filtered on the shift alone — neither needs the other's result — so they go
  // together. This is the report the drawer is counted against and it is rebuilt every time a
  // history row is expanded, so a needless round trip here is paid over and over.
  //
  // The orders read is paged: every figure below is summed from it, and a bare select that
  // stopped at 1000 would understate the drawer with no error anywhere — the silently-wrong-total
  // shape, on the one screen whose entire job is reconciling against cash. `.order('id')` is both
  // the tiebreaker paging needs and the deterministic order the query previously had none of.
  const [{ data: orders }, { data: movements }] = await Promise.all([
    fetchAllRows(() => scopedFromRaw('pos_orders', clientId, 'id, close_type, payment_method, paid_amount, discount_amount, closed_at')
      .eq('shift_id', shiftId).order('id')),
    // Cash that moved without being a sale: supplier payments, staff advances, float drops, and
    // customers settling an older Credit bill in cash. Expected Cash used to be `opening + cash
    // sales`, which meant a credit settlement put real money in the drawer that the reconciliation
    // did not know about — the shift then reported an unexplainable "over" (S573).
    scopedFromRaw('pos_cash_movements', clientId, 'id, direction, kind, amount, reason, created_at, created_by')
      .eq('shift_id', shiftId).order('created_at'),
  ])
  const list = orders || []
  const moveList = movements || []
  const cashIn  = moveList.filter(m => m.direction === 'in').reduce((s, m) => s + (Number(m.amount) || 0), 0)
  const cashOut = moveList.filter(m => m.direction === 'out').reduce((s, m) => s + (Number(m.amount) || 0), 0)
  const creditSettlementsCash = moveList
    .filter(m => m.kind === 'credit_settlement').reduce((s, m) => s + (Number(m.amount) || 0), 0)

  // Split-payment orders (multiple tenders against one bill) don't carry a single payment_method
  // — their real per-method breakdown lives in pos_order_payments instead. Fetched up front so the
  // aggregation loop below can attribute each tender to its own method rather than lumping the
  // whole order under one bucket.
  const splitOrderIds = list.filter(o => o.close_type === 'paid' && o.payment_method === 'Split').map(o => o.id)
  const needItems = list.filter(o => o.close_type === 'void' || o.close_type === 'writeoff')

  // Both derive their id list from `orders` above and neither reads the other, so they are one
  // wave rather than two. Chunked because an `.in()` list is spelled out in the URL and both
  // return several rows per order — a busy shift's split bills alone can outgrow either limit.
  const [{ data: payments }, { data: items }] = await Promise.all([
    fetchAllRowsChunked(splitOrderIds,
      ids => scopedFromRaw('pos_order_payments', clientId, 'order_id, payment_method, amount').in('order_id', ids).order('id')),
    fetchAllRowsChunked(needItems.map(o => o.id),
      ids => scopedFromRaw('pos_order_items', clientId, 'order_id, qty, unit_price, vat_rate, recipe_id').in('order_id', ids).order('id')),
  ])
  const paymentsByOrder = (payments || []).reduce((acc, p) => { (acc[p.order_id] = acc[p.order_id] || []).push(p); return acc }, {})
  const itemsByOrder = (items || []).reduce((acc, i) => { (acc[i.order_id] = acc[i.order_id] || []).push(i); return acc }, {})

  // One lookup per order id instead of a .find() down `needItems` per item row.
  const closeTypeById = new Map(needItems.map(o => [o.id, o.close_type]))
  const compRecipeIds = [...new Set((items || [])
    .filter(i => closeTypeById.get(i.order_id) === 'writeoff')
    .map(i => i.recipe_id).filter(Boolean))]
  const costMap = compRecipeIds.length > 0 ? await computeRecipeCosts(supabase, compRecipeIds) : {}

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
      voidTotal += (itemsByOrder[o.id] || []).reduce((s, i) => s + i.qty * i.unit_price * (1 + (i.vat_rate ?? 0)), 0)
    } else if (o.close_type === 'writeoff') {
      orderCount++; compCount++
      compTotal += (itemsByOrder[o.id] || []).reduce((s, i) => s + i.qty * (costMap[i.recipe_id] || 0), 0)
    }
  }

  const cashSales = byMethod.Cash || 0
  return {
    orderCount, paidCount, voidCount, compCount, byMethod,
    discountTotal, voidTotal, compTotal, salesTotal, cashSales,
    movements: moveList, cashIn, cashOut, creditSettlementsCash,
  }
}

// The one definition of what should be in the drawer. Opening float, plus cash taken over the
// counter, plus every non-sale cash-in (credit settlements included), minus every cash-out.
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
          <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Voided Value</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-red-text)' }}>{fmtNpr(report.voidTotal)}</div>
        </div>
        <div className="card" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Comp Food Cost</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-accent-ink)' }}>{fmtNpr(report.compTotal)}</div>
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
                  <Tip text="Cash that entered the drawer without being a sale — a pay-in, or a customer settling an older Credit bill in cash. Credit settlements used to be invisible here, so the drawer read as 'over' by the settled amount.">
                    Cash In{report.creditSettlementsCash > 0 ? ` (incl. ${fmtNpr(report.creditSettlementsCash)} credit settled)` : ''}
                  </Tip>
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-green-text)' }}>+{fmtNpr(report.cashIn)}</td>
              </tr>
            )}
            {(report.cashOut || 0) > 0 && (
              <tr>
                <td><Tip text="Cash taken out of the drawer during the shift — paying a supplier, a staff advance, or a float drop to the safe.">Cash Out</Tip></td>
                <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-red-text)' }}>−{fmtNpr(report.cashOut)}</td>
              </tr>
            )}
            <tr><td style={{ fontWeight: 700 }}>Expected Cash</td><td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(opening + report.cashSales + (report.cashIn || 0) - (report.cashOut || 0))}</td></tr>
            {closing != null && (
              <>
                <tr><td>Counted Cash</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtNpr(closing)}</td></tr>
                <tr>
                  <td style={{ fontWeight: 700 }}>Variance</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: Math.abs(variance) < 1 ? 'var(--theme-green-text)' : variance < 0 ? 'var(--theme-red-text)' : 'var(--theme-amber-text)' }}>
                    {Math.abs(variance) < 1 ? 'Balanced' : `${variance > 0 ? '+' : ''}${fmtNpr(variance)} ${variance > 0 ? '(over)' : '(short)'}`}
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
  const { clientId, profile, hasPosAccess } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate } = useScopedDb()

  const [mainTab, setMainTab] = useState('current') // 'current' | 'history'

  const [openShift,   setOpenShift]   = useState(undefined) // undefined = loading, null = none open
  const [currentReport, setCurrentReport] = useState(null)
  const [reportLoading, setReportLoading] = useState(false)
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
  // A material drawer discrepancy pending explicit confirmation: { freshReport, closing_cash,
  // expected, diff } — set by submitClose, committed by commitClose. Held as state (not a
  // window.confirm) so the ask renders in the product's own dialog, on top of the close modal.
  const [confirmShort, setConfirmShort] = useState(null)

  const [staffNames, setStaffNames] = useState({})
  const [history, setHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [expandedId, setExpandedId] = useState(null)
  const [reportsMap, setReportsMap] = useState({}) // { shiftId: report }

  const [outletName,     setOutletName]     = useState('')
  const [propertyAddress, setPropertyAddress] = useState('')

  // Escape-to-close — this modal doesn't use the shared Modal.js component.
  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape' && modal && !saving) setModal(null) }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [modal, saving])

  useEffect(() => {
    if (!clientId) return
    loadOpenShift()
    // Raw `profiles` reads are RLS-limited to the caller's own row (id = auth.uid() OR admin) —
    // resolving OTHER staff members' names needs get_client_profile_names(), a SECURITY
    // DEFINER RPC. A raw query here silently showed "—" for every staff member except
    // whoever was logged in.
    supabase.rpc('get_client_profile_names', { p_client_id: clientId })
      .then(({ data }) => setStaffNames(Object.fromEntries((data || []).map(p => [p.id, p.full_name]))))
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
    setExpandedId(null)
    setHistoryLoaded(false)
    if (mainTab === 'history') loadHistory()
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

  async function loadOpenShift() {
    const { data } = await scopedFrom('pos_shifts').eq('status', 'open').maybeSingle()
    setOpenShift(data || null)
    if (data) {
      setReportLoading(true)
      const report = await loadShiftReport(clientId, data.id)
      setCurrentReport(report)
      setReportLoading(false)
    } else {
      setCurrentReport(null)
    }
  }

  async function loadHistory() {
    setHistoryLoading(true)
    // Paged: two or three shifts a day with no date bound crosses 1000 rows inside the first
    // year, and the truncation would take the OLDEST shifts off a screen whose whole purpose is
    // looking back at them.
    const { data } = await fetchAllRows(() => scopedFrom('pos_shifts').eq('status', 'closed')
      .order('closed_at', { ascending: false }).order('id'))
    setHistory(data || [])
    setHistoryLoading(false)
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
    // Prefer the snapshot frozen at close — recomputing live is what let a reprinted Z-report
    // disagree with the signed one. Only shifts closed before S573 have no snapshot and fall
    // back to a live recompute.
    const report = shift.closing_report || await loadShiftReport(clientId, shift.id)
    setReportsMap(m => ({ ...m, [shift.id]: report }))
  }

  function openModal(type) {
    setDenomCounts(EMPTY_COUNTS)
    setLabel(type === 'open' ? suggestShiftLabel() : '')
    setMsg('')
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
    const { error } = await scopedInsert('pos_cash_movements', {
      shift_id: openShift.id,
      direction: cashMoveDir,
      kind: cashMoveDir === 'in' ? 'pay_in' : 'pay_out',
      amount: amt,
      reason: cashMoveReason.trim(),
      created_by: profile?.id || null,
    })
    setCashMoveSaving(false)
    if (error) { setCashMoveMsg('Error: ' + error.message); return }
    setCashMoveAmount(''); setCashMoveReason(''); setCashMoveOpen(false)
    await loadOpenShift()
  }

  async function submitOpen() {
    setSaving(true); setMsg('')
    const opening_cash = sumDenoms(denomCounts)
    const openedAt = new Date()
    const { error } = await scopedInsert('pos_shifts', {
      status: 'open', label: label.trim() || null,
      opened_by: profile?.id || null, opening_cash,
      opening_denominations: Object.fromEntries(DENOMINATIONS.map(d => [d, parseInt(denomCounts[d]) || 0])),
    })
    setSaving(false)
    if (error) {
      setMsg(error.code === '23505' ? 'error:A shift is already open — refresh the page.' : 'error:' + error.message)
      return
    }
    printHtml(buildShiftSlipHtml({
      mode: 'open', outletName, propertyAddress,
      label: label.trim() || 'Shift', openedByName: profile?.full_name, openedAt,
      denomCounts, opening: opening_cash,
    }))
    setModal(null)
    await loadOpenShift()
  }

  async function submitClose() {
    if (!openShift || !currentReport) return
    setSaving(true); setMsg('')

    // A table still open past shift-end never shows up in loadShiftReport (it only aggregates
    // paid/void/writeoff orders) — closing anyway lets that order get paid later under an
    // already-closed, already-signed-off shift, so its cash silently never reconciles.
    const { count: openOrderCount } = await scopedFrom('pos_orders', 'id', { count: 'exact', head: true })
      .eq('shift_id', openShift.id).eq('status', 'open')
    if (openOrderCount > 0) {
      setSaving(false)
      setMsg(`error:${openOrderCount} order${openOrderCount !== 1 ? 's are' : ' is'} still open on this shift — settle or void ${openOrderCount !== 1 ? 'them' : 'it'} before closing.`)
      return
    }

    // Re-read once more immediately before writing. The modal refresh above can be minutes old by
    // the time the drawer has actually been counted, and a bill closed during the count belongs in
    // this shift's figures. This is the snapshot that gets frozen and signed.
    const freshReport = await loadShiftReport(clientId, openShift.id)
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
    setSaving(true)
    setConfirmShort(null)
    const closedAt = new Date()
    // .eq('status', 'open') + .select() together detect a double-close: the DB's only relevant
    // constraint (pos_shifts_one_open_per_client) guards concurrent opens, not closes, so without
    // this a second supervisor closing the same shift on another terminal would silently overwrite
    // the first person's real cash count with no error (a WHERE clause matching zero rows isn't a
    // Postgres error — it just updates nothing).
    const { data: closed, error } = await scopedUpdate('pos_shifts', {
      status: 'closed', closed_at: closedAt.toISOString(), closed_by: profile?.id || null,
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
        capturedAt: closedAt.toISOString(),
      },
    }).eq('id', openShift.id).eq('status', 'open').select()
    setSaving(false)
    if (error) { setMsg('error:' + error.message); return }
    if (!closed || closed.length === 0) {
      setMsg('error:This shift was already closed — refresh to see the latest reconciliation.')
      setModal(null)
      await loadOpenShift()
      return
    }
    printHtml(buildShiftSlipHtml({
      mode: 'close', outletName, propertyAddress,
      label: openShift.label || 'Shift',
      openedByName: staffNames[openShift.opened_by], closedByName: profile?.full_name,
      openedAt: openShift.opened_at, closedAt,
      denomCounts, opening: openShift.opening_cash, closing: closing_cash, report: freshReport,
    }))
    setModal(null)
    setHistoryLoaded(false) // force a refetch next time History is opened
    await loadOpenShift()
  }

  const expectedCash = expectedCashOf(openShift, currentReport)

  return (
    <div>

      <div className="page-header">
        <h1 className="page-title">Shifts</h1>
        <p className="page-subtitle">
          Open a shift with a starting cash count, watch live totals as the shift runs, and reconcile the drawer with a Z-report when it ends.
        </p>
      </div>

      <div className="tab-bar" style={{ marginBottom: 24 }}>
        <button className={`tab-btn${mainTab === 'current' ? ' tab-btn--active' : ''}`} onClick={() => setMainTab('current')}>Current Shift</button>
        <Tip text="Past closed shifts — click one to see its full Z-report">
          <button className={`tab-btn${mainTab === 'history' ? ' tab-btn--active' : ''}`} onClick={openHistoryTab}>Shift History</button>
        </Tip>
      </div>

      {/* ══ CURRENT SHIFT TAB ══ */}
      {mainTab === 'current' && (
        <>
          {openShift === undefined ? (
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
                  <span className="badge-yellow" style={{ fontSize: 11, marginRight: 10 }}>OPEN</span>
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
                    onClick={() => openModal('close')}>Close Shift (Z-Report)</button>
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
                            {m.kind === 'credit_settlement' ? 'Credit settled' : m.direction === 'in' ? 'Cash in' : 'Cash out'}
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

              {reportLoading || !currentReport ? (
                <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading live totals…</p>
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
                    <th>Duration</th>
                    <th>Opened / Closed By</th>
                    <th style={{ textAlign: 'right' }}>Variance</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(s => {
                    const variance = (s.closing_cash || 0) - (s.opening_cash + (reportsMap[s.id]?.cashSales || 0))
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
                              label={`Z-report for ${s.label || 'shift'} on ${fmtSpan(s.opened_at, s.closed_at)}`}
                            /> {s.label || 'Shift'}
                          </td>
                          <td>{fmtSpan(s.opened_at, s.closed_at)}</td>
                          <td style={{ fontSize: 12 }}>{staffNames[s.opened_by] || '—'} / {staffNames[s.closed_by] || '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            {reportsMap[s.id] ? (
                              <span className={Math.abs(variance) < 1 ? 'badge-green' : variance < 0 ? 'badge-red' : 'badge-amber'} style={{ fontSize: 11 }}>
                                {Math.abs(variance) < 1 ? 'Balanced' : fmtNpr(variance)}
                              </span>
                            ) : '—'}
                          </td>
                          {/* Mouse affordance only — the RowDisclosure carries aria-expanded. */}
                          <td aria-hidden="true" style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>{expandedId === s.id ? '▲ hide' : '▼ Z-report'}</td>
                        </tr>
                        {expandedId === s.id && (
                          <tr>
                            <td colSpan={5} style={{ background: 'var(--theme-bg)', padding: '16px 18px' }}>
                              {!reportsMap[s.id] ? (
                                <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Loading…</span>
                              ) : (
                                <>
                                  <ReportBody report={reportsMap[s.id]} opening={s.opening_cash} closing={s.closing_cash} variance={variance} />
                                  <button className="btn btn-ghost" style={{ fontSize: 12, marginTop: 14 }}
                                    onClick={() => printHtml(buildShiftSlipHtml({
                                      mode: 'close', outletName, propertyAddress,
                                      label: s.label || 'Shift',
                                      openedByName: staffNames[s.opened_by], closedByName: staffNames[s.closed_by],
                                      openedAt: s.opened_at, closedAt: s.closed_at,
                                      denomCounts: s.closing_denominations || EMPTY_COUNTS,
                                      opening: s.opening_cash, closing: s.closing_cash || 0, report: reportsMap[s.id],
                                    }))}>
                                    🖨 Reprint Z-Report
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
          title={modal === 'open' ? 'Open Shift' : 'Close Shift — Z-Report'}
          onClose={() => { if (!saving) setModal(null) }}
          maxWidth={480}
          zIndex={1100}
        >
            <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-text3)' }}>
              Count the drawer and enter the quantity of each note/coin.
            </p>

            {modal === 'open' && (
              <input placeholder="Label (optional, e.g. Morning)" value={label} onChange={e => setLabel(e.target.value)}
                className="form-input" style={{ width: '100%', marginBottom: 14 }} />
            )}

            {modal === 'close' && currentReport && (
              <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--theme-text2)' }}>
                Expected cash: <strong>{fmtNpr(expectedCash)}</strong> (opening {fmtNpr(openShift.opening_cash)} + cash sales {fmtNpr(currentReport.cashSales)}
                {currentReport.cashIn  > 0 && <> + cash in {fmtNpr(currentReport.cashIn)}</>}
                {currentReport.cashOut > 0 && <> − cash out {fmtNpr(currentReport.cashOut)}</>})
              </p>
            )}

            <DenomGrid counts={denomCounts} onChange={setDenomCounts} />

            {/* Live variance as the drawer is counted. Closing NPR 5,000 short used to take
                exactly the same single tap as closing balanced — the figure only appeared after
                the shift was closed and the slip printed, which is too late to recount. */}
            {modal === 'close' && currentReport && (() => {
              const counted = sumDenoms(denomCounts)
              const diff = counted - expectedCash
              const over = diff > 0
              const material = Math.abs(diff) >= 100
              return (
                <div style={{
                  marginTop: 14, padding: '10px 14px', borderRadius: 10,
                  border: `1px solid color-mix(in srgb, ${material ? 'var(--theme-red)' : 'var(--theme-green)'} 30%, transparent)`,
                  background: `color-mix(in srgb, ${material ? 'var(--theme-red)' : 'var(--theme-green)'} 8%, transparent)`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span style={{ color: 'var(--theme-text2)' }}>Counted</span>
                    <strong style={{ color: 'var(--theme-text1)' }}>{fmtNpr(counted)}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginTop: 4 }}>
                    <span style={{ color: 'var(--theme-text2)' }}>{diff === 0 ? 'Balanced' : over ? 'Over by' : 'Short by'}</span>
                    <strong style={{ color: material ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
                      {diff === 0 ? '—' : fmtNpr(Math.abs(diff))}
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
