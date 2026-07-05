import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import * as XLSX from 'xlsx'
import Tip from '../../../components/Tip'
import { printWithTitle } from '../../../utils/printTitle'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

function fcColor(pct) {
  if (pct == null) return 'var(--theme-text2)'
  if (pct <= 30) return 'var(--theme-green)'
  if (pct <= 38) return 'var(--theme-amber)'
  return 'var(--theme-red)'
}

export default function PeriodComparison() {
  const { clientId, profile } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const [periods, setPeriods] = useState([])
  const [stats, setStats]     = useState({})
  const [limit, setLimit]     = useState(12)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!effectiveClientId) return
    supabase.from('monthly_periods')
      .select('*').eq('client_id', effectiveClientId)
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .then(({ data }) => setPeriods(data || []))
  }, [effectiveClientId])

  useEffect(() => {
    if (periods.length > 0) fetchData()
  }, [periods, limit]) // eslint-disable-line

  async function fetchData() {
    setLoading(true)
    const shown = periods.slice(0, limit)
    const ids   = shown.map(p => p.id)
    if (!ids.length) { setLoading(false); return }

    const [
      { data: purchases },
      { data: returns },
      { data: wastes },
      { data: openings },
      { data: closings },
      { data: sales },
    ] = await Promise.all([
      supabase.from('purchase_entries').select('period_id, qty, rate').in('period_id', ids),
      supabase.from('vendor_returns').select('period_id, qty, rate').in('period_id', ids),
      supabase.from('wastages').select('period_id, qty, items(per_uom_rate)').in('period_id', ids),
      supabase.from('opening_stock').select('period_id, qty, items(per_uom_rate)').in('period_id', ids),
      supabase.from('closing_stock').select('period_id, physical_qty, items(per_uom_rate)').in('period_id', ids),
      supabase.from('sales_entries').select('period_id, qty_sold, recipes(selling_price)').in('period_id', ids),
    ])

    const result = {}
    for (const pid of ids) {
      const purchV   = (purchases||[]).filter(r=>r.period_id===pid).reduce((s,r)=>s+parseFloat(r.qty||0)*parseFloat(r.rate||0),0)
      const retV     = (returns||[]).filter(r=>r.period_id===pid).reduce((s,r)=>s+parseFloat(r.qty||0)*parseFloat(r.rate||0),0)
      const wasteV   = (wastes||[]).filter(r=>r.period_id===pid).reduce((s,r)=>s+parseFloat(r.qty||0)*parseFloat(r.items?.per_uom_rate||0),0)
      const openV    = (openings||[]).filter(r=>r.period_id===pid).reduce((s,r)=>s+parseFloat(r.qty||0)*parseFloat(r.items?.per_uom_rate||0),0)
      const closeV   = (closings||[]).filter(r=>r.period_id===pid).reduce((s,r)=>s+parseFloat(r.physical_qty||0)*parseFloat(r.items?.per_uom_rate||0),0)
      const revenue  = (sales||[]).filter(r=>r.period_id===pid&&r.recipes?.selling_price).reduce((s,r)=>s+parseFloat(r.qty_sold||0)*parseFloat(r.recipes?.selling_price||0),0)
      const netPurch = purchV - retV
      const cogs     = openV + netPurch - wasteV - closeV
      const fcPct    = revenue > 0 ? (cogs / revenue) * 100 : null
      result[pid]    = { purchV, retV, netPurch, wasteV, openV, closeV, revenue, cogs, fcPct }
    }
    setStats(result)
    setLoading(false)
  }

  const shown        = periods.slice(0, limit)
  const latestStats  = shown.length > 0 ? stats[shown[0]?.id] : null
  const prevStats    = shown.length > 1 ? stats[shown[1]?.id] : null
  const fcTrend      = latestStats?.fcPct != null && prevStats?.fcPct != null
    ? latestStats.fcPct - prevStats.fcPct
    : null

  const bestFcPeriod = shown.reduce((best, p) => {
    const s = stats[p.id]
    if (!s || s.fcPct == null) return best
    if (!best || s.fcPct < (stats[best.id]?.fcPct ?? Infinity)) return p
    return best
  }, null)

  function fmt(n) {
    if (!n) return '—'
    return 'NPR ' + Number(n).toLocaleString('en-NP', { maximumFractionDigits: 0 })
  }

  function trendIcon(curr, prev) {
    if (curr == null || prev == null) return null
    const diff = curr - prev
    if (Math.abs(diff) < 0.3) return <span style={{ color: 'var(--theme-text2)' }}>→</span>
    // For FC%: down is better (lower cost)
    return diff < 0
      ? <span style={{ color: 'var(--theme-green)' }}>↓ {Math.abs(diff).toFixed(1)}pp</span>
      : <span style={{ color: 'var(--theme-red)' }}>↑ {Math.abs(diff).toFixed(1)}pp</span>
  }

  function exportExcel() {
    const wb   = XLSX.utils.book_new()
    const data = shown.map(p => {
      const s = stats[p.id] || {}
      return {
        'Period':              `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}`,
        'Status':              p.status.toUpperCase(),
        'Net Purchases (NPR)': s.netPurch ? s.netPurch.toFixed(0) : '',
        'Wastage Value (NPR)': s.wasteV   ? s.wasteV.toFixed(0)   : '',
        'COGS (NPR)':          s.cogs     ? s.cogs.toFixed(0)     : '',
        'Revenue ex-VAT (NPR)':s.revenue  ? s.revenue.toFixed(0)  : '',
        'FC%':                 s.fcPct != null ? s.fcPct.toFixed(1) + '%' : '',
      }
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Period Comparison')
    XLSX.writeFile(wb, `PeriodComparison.xlsx`)
  }

  return (
    <div className="page-container">

      <div className="print-only" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Period-over-Period Comparison</h2>
      </div>

      <div className="no-print" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Period-over-Period Comparison</h1>
          <p className="page-subtitle">Net Purchases, Wastage, COGS, Revenue and FC% across all BS periods</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="form-select" value={limit} onChange={e => setLimit(Number(e.target.value))}>
            <option value={6}>Last 6 periods</option>
            <option value={12}>Last 12 periods</option>
            <option value={24}>Last 24 periods</option>
            <option value={9999}>All periods</option>
          </select>
          <button className="btn btn-ghost" onClick={() => printWithTitle('Period-over-Period Comparison')}>Print</button>
          <button className="btn btn-ghost" onClick={exportExcel} disabled={!shown.length}>Export Excel</button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="stat-grid no-print" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Latest FC%</div>
          <div className="stat-value" style={{ color: fcColor(latestStats?.fcPct) }}>
            {latestStats?.fcPct != null ? latestStats.fcPct.toFixed(1) + '%' : '—'}
          </div>
          {fcTrend != null && (
            <div className="stat-label" style={{ marginTop: 4, color: fcTrend < 0 ? 'var(--theme-green)' : 'var(--theme-red)' }}>
              {fcTrend < 0 ? '↓' : '↑'} {Math.abs(fcTrend).toFixed(1)}pp vs prev period
            </div>
          )}
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Period with the lowest food cost % in the selected range." width={220}>Best FC% Period</Tip>
          </div>
          <div className="stat-value" style={{ fontSize: 15 }}>
            {bestFcPeriod ? `${BS_MONTHS[bestFcPeriod.bs_month - 1]} ${bestFcPeriod.bs_year}` : '—'}
          </div>
          {bestFcPeriod && stats[bestFcPeriod.id]?.fcPct != null && (
            <div className="stat-label" style={{ marginTop: 4, color: 'var(--theme-green)' }}>
              {stats[bestFcPeriod.id].fcPct.toFixed(1)}%
            </div>
          )}
        </div>
        <div className="stat-card">
          <div className="stat-label">Latest Revenue</div>
          <div className="stat-value" style={{ fontSize: 16 }}>{fmt(latestStats?.revenue)}</div>
          <div className="stat-label" style={{ marginTop: 4 }}>ex-VAT</div>
        </div>
      </div>

      {loading ? (
        <div className="loading-state">Loading...</div>
      ) : shown.length === 0 ? (
        <div className="empty-state">No periods found.</div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Period</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Gross purchases minus vendor returns (NPR value)." width={220}>Net Purchases</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Total value of wastage logged in Stock Count (qty × per-unit rate)." width={240}>Wastage</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Opening Value + Net Purchases − Wastage − Closing Value." width={260}>COGS</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Qty Sold × Selling Price ex-VAT from Sales Entry. Shows — if no sales data entered for this period." width={280}>Revenue (ex-VAT)</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="COGS ÷ Revenue. Green ≤30%, Amber 31–38%, Red >38%. Shows — when revenue is zero." width={260}>FC%</Tip>
                </th>
                <th style={{ textAlign: 'center' }}>
                  <Tip text="FC% change vs previous period. ↓ green = improving, ↑ red = worsening." width={240}>vs Prev</Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p, i) => {
                const s    = stats[p.id] || {}
                const prev = i < shown.length - 1 ? stats[shown[i + 1]?.id] : null
                return (
                  <tr key={p.id}>
                    <td>
                      <strong>{BS_MONTHS[p.bs_month - 1]} {p.bs_year}</strong>
                      {p.status === 'open' && (
                        <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: 'var(--theme-green)', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: 3, padding: '1px 5px' }}>
                          OPEN
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>{fmt(s.netPurch)}</td>
                    <td style={{ textAlign: 'right', color: s.wasteV ? 'var(--theme-amber)' : 'var(--theme-text2)' }}>{fmt(s.wasteV)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(s.cogs)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(s.revenue)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: fcColor(s.fcPct) }}>
                      {s.fcPct != null ? s.fcPct.toFixed(1) + '%' : '—'}
                    </td>
                    <td style={{ textAlign: 'center', fontSize: 13 }}>
                      {trendIcon(s.fcPct, prev?.fcPct)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
