import { useState, useEffect, Fragment } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import { computeRecipeCosts } from '../../../utils/recipeCost'

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`
const PAY_METHODS = ['Cash', 'Card', 'eSewa', 'Khalti', 'FonePay', 'Credit']
const DENOMINATIONS = [1000, 500, 100, 50, 20, 10, 5, 2, 1]
const EMPTY_COUNTS = Object.fromEntries(DENOMINATIONS.map(d => [d, '']))

function sumDenoms(counts) {
  return DENOMINATIONS.reduce((s, d) => s + d * (parseInt(counts[d]) || 0), 0)
}

function fmtSpan(from, to) {
  const f = new Date(from), t = to ? new Date(to) : new Date()
  const mins = Math.round((t - f) / 60000)
  const h = Math.floor(mins / 60), m = mins % 60
  return `${h}h ${m}m`
}

function DenomGrid({ counts, onChange }) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead><tr><th>Denomination</th><th style={{ width: 100 }}>Qty</th><th style={{ textAlign: 'right' }}>Subtotal</th></tr></thead>
        <tbody>
          {DENOMINATIONS.map(d => (
            <tr key={d}>
              <td style={{ fontWeight: 600 }}>₨{d}</td>
              <td>
                <input type="number" min="0" step="1" value={counts[d]}
                  onChange={e => onChange({ ...counts, [d]: e.target.value })}
                  className="form-select" style={{ width: '100%' }} />
              </td>
              <td style={{ textAlign: 'right' }}>{fmtNpr(d * (parseInt(counts[d]) || 0))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ margin: '10px 0 0', textAlign: 'right', fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)' }}>
        Total: {fmtNpr(sumDenoms(counts))}
      </p>
    </div>
  )
}

// Shared X/Z-report totals from a shift's closed orders — used for the live Current Shift view
// and for expanding a past shift in History. Void/Comp valuation mirrors PosExceptionReport.jsx.
async function loadShiftReport(clientId, shiftId) {
  const { data: orders } = await supabase.from('pos_orders')
    .select('id, close_type, payment_method, paid_amount, discount_amount, closed_at')
    .eq('client_id', clientId).eq('shift_id', shiftId)
  const list = orders || []

  const needItems = list.filter(o => o.close_type === 'void' || o.close_type === 'writeoff')
  let itemsByOrder = {}, costMap = {}
  if (needItems.length > 0) {
    const { data: items } = await supabase.from('pos_order_items')
      .select('order_id, qty, unit_price, vat_rate, recipe_id')
      .in('order_id', needItems.map(o => o.id))
    itemsByOrder = (items || []).reduce((acc, i) => { (acc[i.order_id] = acc[i.order_id] || []).push(i); return acc }, {})
    const compRecipeIds = [...new Set((items || [])
      .filter(i => needItems.find(o => o.id === i.order_id)?.close_type === 'writeoff')
      .map(i => i.recipe_id).filter(Boolean))]
    if (compRecipeIds.length > 0) costMap = await computeRecipeCosts(supabase, compRecipeIds)
  }

  const byMethod = Object.fromEntries(PAY_METHODS.map(m => [m, 0]))
  let discountTotal = 0, voidTotal = 0, compTotal = 0, salesTotal = 0, orderCount = 0

  for (const o of list) {
    if (o.close_type === 'paid') {
      orderCount++
      salesTotal += o.paid_amount || 0
      discountTotal += o.discount_amount || 0
      if (byMethod[o.payment_method] !== undefined) byMethod[o.payment_method] += o.paid_amount || 0
    } else if (o.close_type === 'void') {
      orderCount++
      voidTotal += (itemsByOrder[o.id] || []).reduce((s, i) => s + i.qty * i.unit_price * (1 + (i.vat_rate ?? 0)), 0)
    } else if (o.close_type === 'writeoff') {
      orderCount++
      compTotal += (itemsByOrder[o.id] || []).reduce((s, i) => s + i.qty * (costMap[i.recipe_id] || 0), 0)
    }
  }

  const cashSales = byMethod.Cash || 0
  return { orderCount, byMethod, discountTotal, voidTotal, compTotal, salesTotal, cashSales }
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

  useEffect(() => {
    if (!clientId) return
    loadOpenShift()
    supabase.from('profiles').select('id, full_name').eq('client_id', clientId)
      .then(({ data }) => setStaffNames(Object.fromEntries((data || []).map(p => [p.id, p.full_name]))))
  }, [clientId]) // eslint-disable-line

  if (!hasPosAccess('supervisor')) return <Navigate to="/pos" replace />

  async function loadOpenShift() {
    const { data } = await supabase.from('pos_shifts').select('*')
      .eq('client_id', clientId).eq('status', 'open').maybeSingle()
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
    const { data } = await supabase.from('pos_shifts').select('*')
      .eq('client_id', clientId).eq('status', 'closed')
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
    setLabel('')
    setMsg('')
    setModal(type)
  }

  async function submitOpen() {
    setSaving(true); setMsg('')
    const opening_cash = sumDenoms(denomCounts)
    const { error } = await supabase.from('pos_shifts').insert({
      client_id: clientId, status: 'open', label: label.trim() || null,
      opened_by: profile?.id || null, opening_cash,
      opening_denominations: Object.fromEntries(DENOMINATIONS.map(d => [d, parseInt(denomCounts[d]) || 0])),
    })
    setSaving(false)
    if (error) {
      setMsg(error.code === '23505' ? 'error:A shift is already open — refresh the page.' : 'error:' + error.message)
      return
    }
    setModal(null)
    await loadOpenShift()
  }

  async function submitClose() {
    if (!openShift || !currentReport) return
    setSaving(true); setMsg('')
    const closing_cash = sumDenoms(denomCounts)
    const { error } = await supabase.from('pos_shifts').update({
      status: 'closed', closed_at: new Date().toISOString(), closed_by: profile?.id || null,
      closing_cash,
      closing_denominations: Object.fromEntries(DENOMINATIONS.map(d => [d, parseInt(denomCounts[d]) || 0])),
    }).eq('id', openShift.id)
    setSaving(false)
    if (error) { setMsg('error:' + error.message); return }
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
                                <ReportBody report={reportsMap[s.id]} opening={s.opening_cash} closing={s.closing_cash} variance={variance} />
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
