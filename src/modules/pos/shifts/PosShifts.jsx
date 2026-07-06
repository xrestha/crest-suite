import { useState, useEffect, Fragment } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { scopedFrom as scopedFromRaw } from '../../../shared/scopedDb'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import { computeRecipeCosts } from '../../../utils/recipeCost'
import { adToBs, BS_MONTHS } from '../../../utils/bsCalendar'

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`
const PAY_METHODS = ['Cash', 'Card', 'eSewa', 'Khalti', 'FonePay', 'Credit']
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {DENOMINATIONS.map(d => (
          <div key={d} style={{ background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 8, padding: '6px 8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text1)' }}>₨{d}</span>
              <span style={{ fontSize: 10, color: 'var(--theme-text3)' }}>{fmtNpr(d * (parseInt(counts[d]) || 0))}</span>
            </div>
            <input type="number" min="0" step="1" value={counts[d]}
              onChange={e => onChange({ ...counts, [d]: e.target.value })}
              className="form-select" style={{ width: '100%', textAlign: 'center', padding: '4px 6px' }} />
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
  const nowStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  const total  = mode === 'open' ? opening : closing
  const variance = mode === 'close' ? closing - (opening + (report?.cashSales || 0)) : 0
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
  ${outletName ? `<div class="c b" style="font-size:13px">${outletName}</div>` : ''}
  ${propertyAddress ? `<div class="c" style="font-size:11px">${propertyAddress}</div>` : ''}
  <div class="c b lg" style="margin-top:4px">${mode === 'open' ? 'SHIFT OPENING' : 'CASH SETTLEMENT'}</div>
  <hr>
  <div class="row"><span>Shift:</span><span class="b">${label || 'Shift'}</span></div>
  <div class="row"><span>Opened:</span><span>${fmtAdBs(openedAt)}</span></div>
  ${mode === 'close' ? `<div class="row"><span>Closed:</span><span>${fmtAdBs(closedAt)}</span></div>` : ''}
  <div class="row"><span>Opened By:</span><span>${openedByName || ''}</span></div>
  ${mode === 'close' ? `<div class="row"><span>Closed By:</span><span>${closedByName || ''}</span></div>` : ''}
  ${mode === 'close' && report ? `
  <hr>
  <div class="row tot"><span>Total Collection:</span><span>NPR ${report.salesTotal.toFixed(2)}</span></div>
  ${PAY_METHODS.filter(m => report.byMethod[m]).map(m => `<div class="row ind"><span>${m}</span><span>${report.byMethod[m].toFixed(2)}</span></div>`).join('')}
  <hr>
  <div class="row"><span>Bills (Paid):</span><span>${report.paidCount}</span></div>
  <div class="row"><span>Voided:</span><span>${report.voidCount}</span></div>
  <div class="row"><span>Complimentary:</span><span>${report.compCount}</span></div>
  <hr>
  <div class="row"><span>Opening Cash:</span><span>${opening.toFixed(2)}</span></div>
  <div class="row"><span>Cash Sales:</span><span>${report.cashSales.toFixed(2)}</span></div>
  <div class="row tot"><span>Expected Cash:</span><span>${(opening + report.cashSales).toFixed(2)}</span></div>
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
  const { data: orders } = await scopedFromRaw('pos_orders', clientId, 'id, close_type, payment_method, paid_amount, discount_amount, closed_at')
    .eq('shift_id', shiftId)
  const list = orders || []

  // Split-payment orders (multiple tenders against one bill) don't carry a single payment_method
  // — their real per-method breakdown lives in pos_order_payments instead. Fetched up front so the
  // aggregation loop below can attribute each tender to its own method rather than lumping the
  // whole order under one bucket.
  const splitOrderIds = list.filter(o => o.close_type === 'paid' && o.payment_method === 'Split').map(o => o.id)
  let paymentsByOrder = {}
  if (splitOrderIds.length > 0) {
    const { data: payments } = await scopedFromRaw('pos_order_payments', clientId, 'order_id, payment_method, amount')
      .in('order_id', splitOrderIds)
    paymentsByOrder = (payments || []).reduce((acc, p) => { (acc[p.order_id] = acc[p.order_id] || []).push(p); return acc }, {})
  }

  const needItems = list.filter(o => o.close_type === 'void' || o.close_type === 'writeoff')
  let itemsByOrder = {}, costMap = {}
  if (needItems.length > 0) {
    const { data: items } = await scopedFromRaw('pos_order_items', clientId, 'order_id, qty, unit_price, vat_rate, recipe_id')
      .in('order_id', needItems.map(o => o.id))
    itemsByOrder = (items || []).reduce((acc, i) => { (acc[i.order_id] = acc[i.order_id] || []).push(i); return acc }, {})
    const compRecipeIds = [...new Set((items || [])
      .filter(i => needItems.find(o => o.id === i.order_id)?.close_type === 'writeoff')
      .map(i => i.recipe_id).filter(Boolean))]
    if (compRecipeIds.length > 0) costMap = await computeRecipeCosts(supabase, compRecipeIds)
  }

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
  return { orderCount, paidCount, voidCount, compCount, byMethod, discountTotal, voidTotal, compTotal, salesTotal, cashSales }
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
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-red)' }}>{fmtNpr(report.voidTotal)}</div>
        </div>
        <div className="card" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Comp Food Cost</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-amber)' }}>{fmtNpr(report.compTotal)}</div>
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
            <tr><td style={{ fontWeight: 700 }}>Expected Cash</td><td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(opening + report.cashSales)}</td></tr>
            {closing != null && (
              <>
                <tr><td>Counted Cash</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtNpr(closing)}</td></tr>
                <tr>
                  <td style={{ fontWeight: 700 }}>Variance</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: Math.abs(variance) < 1 ? 'var(--theme-green)' : variance < 0 ? 'var(--theme-red)' : 'var(--theme-amber)' }}>
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

  const [modal, setModal] = useState(null) // 'open' | 'close' | null
  const [denomCounts, setDenomCounts] = useState(EMPTY_COUNTS)
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const [staffNames, setStaffNames] = useState({})
  const [history, setHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [expandedId, setExpandedId] = useState(null)
  const [reportsMap, setReportsMap] = useState({}) // { shiftId: report }

  const [outletName,     setOutletName]     = useState('')
  const [propertyAddress, setPropertyAddress] = useState('')

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
  }, [clientId]) // eslint-disable-line

  // Same pattern as PosOrders.jsx's printHtml — a popup window that auto-prints and closes.
  // On a POS device launched with Chrome's --kiosk-printing flag this goes straight to the
  // default printer with no dialog; without that flag it falls back to the normal print dialog.
  function printHtml(html) {
    const w = window.open('', '_blank', 'width=340,height=480,left=200,top=100')
    if (!w) return false
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
    const { data } = await scopedFrom('pos_shifts').eq('status', 'closed')
      .order('closed_at', { ascending: false })
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
    const report = await loadShiftReport(clientId, shift.id)
    setReportsMap(m => ({ ...m, [shift.id]: report }))
  }

  function openModal(type) {
    setDenomCounts(EMPTY_COUNTS)
    setLabel(type === 'open' ? suggestShiftLabel() : '')
    setMsg('')
    setModal(type)
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
    const closing_cash = sumDenoms(denomCounts)
    const closedAt = new Date()
    const { error } = await scopedUpdate('pos_shifts', {
      status: 'closed', closed_at: closedAt.toISOString(), closed_by: profile?.id || null,
      closing_cash,
      closing_denominations: Object.fromEntries(DENOMINATIONS.map(d => [d, parseInt(denomCounts[d]) || 0])),
    }).eq('id', openShift.id)
    setSaving(false)
    if (error) { setMsg('error:' + error.message); return }
    printHtml(buildShiftSlipHtml({
      mode: 'close', outletName, propertyAddress,
      label: openShift.label || 'Shift',
      openedByName: staffNames[openShift.opened_by], closedByName: profile?.full_name,
      openedAt: openShift.opened_at, closedAt,
      denomCounts, opening: openShift.opening_cash, closing: closing_cash, report: currentReport,
    }))
    setModal(null)
    setHistoryLoaded(false) // force a refetch next time History is opened
    await loadOpenShift()
  }

  const expectedCash = openShift ? openShift.opening_cash + (currentReport?.cashSales || 0) : 0

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100 }}>

      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: 'var(--theme-text1)', fontSize: 20 }}>Shifts</h2>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--theme-text3)' }}>
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
                  <span className="badge-green" style={{ fontSize: 11, marginRight: 10 }}>OPEN</span>
                  <span style={{ fontSize: 13, color: 'var(--theme-text1)', fontWeight: 600 }}>{openShift.label || 'Shift'}</span>
                  <span style={{ fontSize: 12, color: 'var(--theme-text3)', marginLeft: 10 }}>
                    Opened by {staffNames[openShift.opened_by] || '—'} · {fmtSpan(openShift.opened_at)} ago
                  </span>
                </div>
                <button className="btn" style={{ background: 'var(--theme-red)', color: '#fff', borderColor: 'var(--theme-red)' }}
                  onClick={() => openModal('close')}>Close Shift (Z-Report)</button>
              </div>

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
                          <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{s.label || 'Shift'}</td>
                          <td>{fmtSpan(s.opened_at, s.closed_at)}</td>
                          <td style={{ fontSize: 12 }}>{staffNames[s.opened_by] || '—'} / {staffNames[s.closed_by] || '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            {reportsMap[s.id] ? (
                              <span className={Math.abs(variance) < 1 ? 'badge-green' : variance < 0 ? 'badge-red' : 'badge-amber'} style={{ fontSize: 11 }}>
                                {Math.abs(variance) < 1 ? 'Balanced' : fmtNpr(variance)}
                              </span>
                            ) : '—'}
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>{expandedId === s.id ? '▲ hide' : '▼ Z-report'}</td>
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
        <div onClick={e => { if (e.target === e.currentTarget && !saving) setModal(null) }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
          <div style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 14, width: 'min(480px, 96vw)', maxHeight: '90vh', overflowY: 'auto', padding: '24px 28px' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 18, color: 'var(--theme-text1)' }}>
              {modal === 'open' ? 'Open Shift' : 'Close Shift — Z-Report'}
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-text3)' }}>
              Count the drawer and enter the quantity of each note/coin.
            </p>

            {modal === 'open' && (
              <input placeholder="Label (optional, e.g. Morning)" value={label} onChange={e => setLabel(e.target.value)}
                className="form-select" style={{ width: '100%', marginBottom: 14 }} />
            )}

            {modal === 'close' && currentReport && (
              <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--theme-text2)' }}>
                Expected cash: <strong>{fmtNpr(expectedCash)}</strong> (opening {fmtNpr(openShift.opening_cash)} + cash sales {fmtNpr(currentReport.cashSales)})
              </p>
            )}

            <DenomGrid counts={denomCounts} onChange={setDenomCounts} />

            {msg && <p style={{ margin: '14px 0 0', fontSize: 12, color: msg.startsWith('error:') ? 'var(--theme-red)' : 'var(--theme-green)' }}>{msg.replace(/^(error|ok):/, '')}</p>}

            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setModal(null)} disabled={saving}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }}
                onClick={modal === 'open' ? submitOpen : submitClose} disabled={saving}>
                {saving ? 'Saving…' : modal === 'open' ? 'Open Shift' : 'Close Shift'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
