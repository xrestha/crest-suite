import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import * as XLSX from 'xlsx'
import { Navigate } from 'react-router-dom'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']
const METHODS = ['Cash', 'Credit', 'FonePay']
const METHOD_COLORS = { Cash: 'var(--theme-green)', Credit: 'var(--theme-red)', FonePay: 'var(--theme-accent)' }

export default function PaymentReport() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [purchases, setPurchases] = useState([])
  const [returns, setReturns] = useState([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState('summary')

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const { data: p } = await scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
    setPeriods(p || [])
    const open = (p || []).find(x => x.status === 'open')
    if (open) { setSelectedPeriod(open); await loadData(open.id) }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setLoading(true)
    await loadData(periodId)
    setLoading(false)
  }

  async function loadData(periodId) {
    const [{ data: p }, { data: r }] = await Promise.all([
      supabase.from('purchase_entries').select('*, items(name, categories(name)), vendors(name)').eq('period_id', periodId).order('bs_day'),
      scopedFrom('vendor_returns', '*, items(name), vendors(name)').eq('period_id', periodId).order('bs_day')
    ])
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

  function exportExcel() {
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

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Payment Summary</h1>
          <p className="page-subtitle">Purchase spend by payment method (net of returns) — {periodLabel}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <select className="form-select" value={selectedPeriod?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={exportExcel}>⬇ Export Excel</button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(5,1fr)', marginBottom: 24 }}>
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
          <div className="stat-value" style={{ fontSize: 17, color: 'var(--theme-red)' }}>
            {grandReturn > 0 ? `−NPR ${grandReturn.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}
          </div>
        </div>
        {summary.map(s => (
          <div key={s.method} className="stat-card">
            <div className="stat-label">
              <Tip text={`Net purchase spend paid via ${s.method} (gross − returns) for this period.`} width={240}>{s.method} (Net)</Tip>
            </div>
            <div className="stat-value" style={{ fontSize: 17, color: METHOD_COLORS[s.method] }}>
              NPR {s.net.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
            </div>
            <div className="stat-sub">
              {grandNet > 0 ? ((s.net / grandNet) * 100).toFixed(1) : 0}% · {s.count} entries
              {s.returnCount > 0 && ` · ${s.returnCount} return${s.returnCount > 1 ? 's' : ''}`}
            </div>
          </div>
        ))}
      </div>

      {/* Visual split */}
      {grandNet > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 10 }}>Payment Method Split (Net)</div>
          <div style={{ display: 'flex', height: 20, borderRadius: 6, overflow: 'hidden', gap: 2 }}>
            {summary.filter(s => s.net > 0).map(s => (
              <div key={s.method} style={{
                width: `${(s.net / grandNet) * 100}%`,
                background: METHOD_COLORS[s.method],
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, fontWeight: 700, color: 'var(--theme-bg)'
              }}>
                {((s.net / grandNet) * 100) > 10 ? `${((s.net / grandNet) * 100).toFixed(0)}%` : ''}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
            {summary.map(s => (
              <div key={s.method} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: METHOD_COLORS[s.method] }} />
                <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{s.method}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--theme-border)' }}>
        {['summary', 'daily'].map(m => (
          <button key={m} onClick={() => setViewMode(m)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '10px 20px',
            fontSize: 13, fontWeight: 500,
            color: viewMode === m ? 'var(--theme-accent)' : 'var(--theme-text2)',
            borderBottom: viewMode === m ? '2px solid var(--theme-accent)' : '2px solid transparent', marginBottom: -1
          }}>{m === 'summary' ? 'Method Summary' : 'Daily Breakdown'}</button>
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
                  <th style={{ textAlign: 'right', color: 'var(--theme-red)' }}>Returns</th>
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
                    <td style={{ fontWeight: 600, color: METHOD_COLORS[s.method] }}>{s.method}</td>
                    <td style={{ textAlign: 'right' }}>NPR {s.gross.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>
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
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red)', paddingTop: 12 }}>
                    {grandReturn > 0 ? `−NPR ${grandReturn.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)', paddingTop: 12 }}>NPR {grandNet.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
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
                  {METHODS.map(m => <th key={m} style={{ textAlign: 'right', color: METHOD_COLORS[m] }}>{m} (Net)</th>)}
                  <th style={{ textAlign: 'right' }}>Day Total</th>
                </tr>
              </thead>
              <tbody>
                {dailyByMethod.map(d => (
                  <tr key={d.day}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-accent)' }}>{d.day}</td>
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
    </div>
  )
}
