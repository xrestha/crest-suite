import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import ReportLoadError from '../../../components/ReportLoadError'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { BS_MONTHS, formatBsDay } from '../../../utils/bsCalendar'

const METHODS = ['Cash', 'Credit', 'FonePay']
// Two roles, two values: the base token is the FILL (split bar, legend swatch), the -text variant
// is the TEXT (the KPI figure). One value cannot do both — the base tokens fail AA as text on all
// five light presets. Note these are semantic here, not a series palette: Cash/Credit/FonePay
// genuinely mean paid / owed / digital.
const METHOD_COLORS = { Cash: 'var(--theme-green)', Credit: 'var(--theme-red)', FonePay: 'var(--theme-purple)' }
const METHOD_TEXT   = { Cash: 'var(--theme-green-text)', Credit: 'var(--theme-red-text)', FonePay: 'var(--theme-purple-text)' }

export default function PaymentReport() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const periodReq = useLatestRequest()
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [purchases, setPurchases] = useState([])
  const [returns, setReturns] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [viewMode, setViewMode] = useState('summary')

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    setLoadError(null)
    const { data: p, error } = await scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
    if (error) { setLoadError(error.message); setLoading(false); return }
    setPeriods(p || [])
    const open = (p || []).find(x => x.status === 'open')
    if (open) { setSelectedPeriod(open); await loadData(open.id) }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    periodReq.begin(periodId)   // claim the page before any await
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setLoading(true)
    await loadData(periodId)
    setLoading(false)
  }

  async function loadData(periodId) {
    setLoadError(null)
    const results = await Promise.all([
      fetchAllRows(() => supabase.from('purchase_entries').select('*, items(name, categories(name)), vendors(name)').eq('period_id', periodId).order('bs_day').order('id')),
      fetchAllRows(() => scopedFrom('vendor_returns', '*, items(name), vendors(name)').eq('period_id', periodId).order('bs_day').order('id'))
    ])
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    // A failed read must not render as a quiet period of NPR 0 (S612 silent-zero rule).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setPurchases([]); setReturns([]); return }
    const [{ data: p }, { data: r }] = results
    setPurchases(p || [])
    setReturns(r || [])
  }

  // Gross purchases by method
  const grossByMethod = METHODS.map(method => {
    const mp = purchases.filter(p => (p.payment_method || 'Cash') === method)
    return { method, gross: mp.reduce((s, p) => s + p.qty * p.rate, 0), count: mp.length }
  })

  // Returns by method (inherited from purchase)
  const returnsByMethod = METHODS.map(method => {
    const mr = returns.filter(r => (r.payment_method || 'Cash') === method)
    return { method, returnAmt: mr.reduce((s, r) => s + r.qty * r.rate, 0), count: mr.length }
  })

  // Summary net
  const summary = METHODS.map((method, i) => ({
    method,
    gross: grossByMethod[i].gross,
    returnAmt: returnsByMethod[i].returnAmt,
    net: grossByMethod[i].gross - returnsByMethod[i].returnAmt,
    count: grossByMethod[i].count,
    returnCount: returnsByMethod[i].count
  }))

  const grandGross  = summary.reduce((s, r) => s + r.gross, 0)
  const grandReturn = summary.reduce((s, r) => s + r.returnAmt, 0)
  const grandNet    = grandGross - grandReturn

  // Daily breakdown (net per day per method)
  const days = [...new Set([...purchases.map(p => p.bs_day), ...returns.map(r => r.bs_day)])].sort((a, b) => a - b)
  const dailyByMethod = days.map(day => {
    const byMethod = {}
    METHODS.forEach(m => {
      const gross = purchases.filter(p => p.bs_day === day && (p.payment_method || 'Cash') === m).reduce((s, p) => s + p.qty * p.rate, 0)
      const ret   = returns.filter(r => r.bs_day === day && (r.payment_method || 'Cash') === m).reduce((s, r) => s + r.qty * r.rate, 0)
      byMethod[m] = gross - ret
    })
    const dayGross  = purchases.filter(p => p.bs_day === day).reduce((s, p) => s + p.qty * p.rate, 0)
    const dayReturn = returns.filter(r => r.bs_day === day).reduce((s, r) => s + r.qty * r.rate, 0)
    return { day, byMethod, dayTotal: dayGross - dayReturn, dayGross, dayReturn }
  })

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const summaryData = summary.map(s => ({
      'Payment Method': s.method,
      'Gross Purchases': s.gross.toFixed(0),
      'Returns': s.returnAmt.toFixed(0),
      'Net Amount (NPR)': s.net.toFixed(0),
      '% of Net Total': grandNet > 0 ? ((s.net / grandNet) * 100).toFixed(1) + '%' : '0%',
      'Transactions': s.count,
      'Return Entries': s.returnCount
    }))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryData), 'Summary')
    const dailyData = dailyByMethod.map(d => ({
      'Day': d.day,
      'Cash Net (NPR)': d.byMethod['Cash'].toFixed(0),
      'Credit Net (NPR)': d.byMethod['Credit'].toFixed(0),
      'FonePay Net (NPR)': d.byMethod['FonePay'].toFixed(0),
      'Day Total Net (NPR)': d.dayTotal.toFixed(0)
    }))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dailyData), 'Daily Breakdown')
    XLSX.writeFile(wb, `Payment-Report-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="the payment report" />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Payment Summary</h1>
          <p className="page-subtitle">Purchase spend by payment method (net of returns) — {periodLabel}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <select aria-label="Period" className="form-select" value={selectedPeriod?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={exportExcel}>Export Excel</button>
        </div>
      </div>

      {loadError && <ReportLoadError error={loadError} />}

      {/* Summary cards — gated on !loading too: a stat computed from rows that have not arrived
          is NPR 0 wearing the confidence of a real figure (S594 rule). */}
      {!loadError && !loading && (
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Total purchase spend for the period, before returns. This is money paid to suppliers — not sales revenue." width={260}>Gross Purchases</Tip>
          </div>
          <div className="stat-value gold" style={{ fontSize: 17 }}>NPR {grandGross.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Value of goods returned to suppliers, subtracted from gross to get net spend." width={250}>Total Returns</Tip>
          </div>
          <div className="stat-value" style={{ fontSize: 17, color: 'var(--theme-red-text)' }}>
            {grandReturn > 0 ? `−NPR ${grandReturn.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}
          </div>
        </div>
        {summary.map(s => (
          <div key={s.method} className="stat-card">
            <div className="stat-label">
              <Tip text={`Net purchase spend paid via ${s.method} (gross − returns) for this period.`} width={240}>{s.method} (Net)</Tip>
            </div>
            <div className="stat-value" style={{ fontSize: 17, color: METHOD_TEXT[s.method] || METHOD_COLORS[s.method] }}>
              NPR {s.net.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
            </div>
            <div className="stat-sub">
              {grandNet > 0 ? ((s.net / grandNet) * 100).toFixed(1) : 0}% · {s.count} entries
              {s.returnCount > 0 && ` · ${s.returnCount} return${s.returnCount > 1 ? 's' : ''}`}
            </div>
          </div>
        ))}
      </div>
      )}

      {/* Visual split */}
      {!loadError && !loading && grandNet > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 10 }}>Payment Method Split (Net)</div>
          <div style={{ display: 'flex', height: 20, borderRadius: 'var(--radius-sm)', overflow: 'hidden', gap: 2 }}>
            {summary.filter(s => s.net > 0).map(s => (
              <div key={s.method} style={{
                width: `${(s.net / grandNet) * 100}%`,
                background: METHOD_COLORS[s.method],
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }} title={`${s.method}: ${((s.net / grandNet) * 100).toFixed(1)}%`}>
                {/* The percentage moved to the legend below: on the fill it was --theme-bg on a
                    signal colour, 3.14:1 on Rosé Dawn, and there is no one foreground that works
                    on green, red and purple across ten presets. */}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
            {summary.map(s => (
              <div key={s.method} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 10, height: 10, borderRadius: 'var(--radius-xs)', background: METHOD_COLORS[s.method] }} />
                <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{s.method}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text1)' }}>
                  {grandNet > 0 ? `${((s.net / grandNet) * 100).toFixed(1)}%` : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      {!loadError && (
      <>
      <div className="panel-tab-bar" role="tablist" aria-label="Payment report views">
        {['summary', 'daily'].map(m => (
          <button key={m} type="button" role="tab" aria-selected={viewMode === m}
            className={`panel-tab${viewMode === m ? ' panel-tab--active' : ''}`}
            onClick={() => setViewMode(m)}>{m === 'summary' ? 'Method Summary' : 'Daily Breakdown'}</button>
        ))}
      </div>

      <div className="card">
        {loading ? <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p> :
          viewMode === 'summary' ? (
            <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Payment Method</th>
                  <th style={{ textAlign: 'right' }}>Gross Purchases</th>
                  <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>Returns</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Gross purchases − returns for this method." width={220}>Net Amount</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="This method's net spend as a share of total net purchases." width={230}>% of Net Total</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>Transactions</th>
                </tr>
              </thead>
              <tbody>
                {summary.map(s => (
                  <tr key={s.method}>
                    <td style={{ fontWeight: 600, color: METHOD_TEXT[s.method] || METHOD_COLORS[s.method] }}>{s.method}</td>
                    <td style={{ textAlign: 'right' }}>NPR {s.gross.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>
                      {s.returnAmt > 0 ? `−NPR ${s.returnAmt.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>NPR {s.net.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                      {grandNet > 0 ? ((s.net / grandNet) * 100).toFixed(1) : 0}%
                    </td>
                    <td style={{ textAlign: 'right' }}>{s.count}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                  <td style={{ fontWeight: 700, paddingTop: 12 }}>Total</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, paddingTop: 12 }}>NPR {grandGross.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)', paddingTop: 12 }}>
                    {grandReturn > 0 ? `−NPR ${grandReturn.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', paddingTop: 12 }}>NPR {grandNet.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                  <td style={{ textAlign: 'right', paddingTop: 12 }}>100%</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, paddingTop: 12 }}>{purchases.length}</td>
                </tr>
              </tbody>
            </table>
            </div>
          ) : (
            <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Day</th>
                  {METHODS.map(m => <th key={m} style={{ textAlign: 'right', color: METHOD_TEXT[m] || METHOD_COLORS[m] }}>{m} (Net)</th>)}
                  <th style={{ textAlign: 'right' }}>Day Total</th>
                </tr>
              </thead>
              <tbody>
                {dailyByMethod.map(d => (
                  <tr key={d.day}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-accent-ink)', whiteSpace: 'nowrap' }}>{formatBsDay(d.day, selectedPeriod?.bs_month)}</td>
                    {METHODS.map(m => (
                      <td key={m} style={{ textAlign: 'right', color: d.byMethod[m] !== 0 ? METHOD_COLORS[m] : 'var(--theme-text3)' }}>
                        {d.byMethod[m] !== 0 ? `NPR ${d.byMethod[m].toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}
                      </td>
                    ))}
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>NPR {d.dayTotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
      </div>
      </>
      )}
    </div>
  )
}
