import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import * as XLSX from 'xlsx'
import Tip from '../components/Tip'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

export default function VendorReport() {
  const { clientId, profile, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [purchases, setPurchases] = useState([])
  const [returns, setReturns] = useState([])
  const [vendors, setVendors] = useState([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState('summary')
  const [vendorSearch, setVendorSearch] = useState('')

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const [{ data: p }, { data: v }] = await Promise.all([
      supabase.from('monthly_periods').select('*').eq('client_id', effectiveClientId).order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      supabase.from('vendors').select('*').eq('client_id', effectiveClientId).eq('is_active', true).order('name')
    ])
    setPeriods(p || [])
    setVendors(v || [])
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
      supabase.from('purchase_entries').select('*, items(name, categories(name)), vendors(name), payment_method').eq('period_id', periodId).order('bs_day'),
      supabase.from('vendor_returns').select('*, items(name), vendors(name), payment_method').eq('period_id', periodId).order('bs_day')
    ])
    setPurchases(p || [])
    setReturns(r || [])
  }

  // Vendor summary — net spend
  const vendorSummary = vendors.map(vendor => {
    const vPurchases = purchases.filter(p => p.vendor_id === vendor.id)
    const vReturns   = returns.filter(r => r.vendor_id === vendor.id)
    const gross      = vPurchases.reduce((s, p) => s + p.qty * p.rate, 0)
    const returned   = vReturns.reduce((s, r) => s + r.qty * r.rate, 0)
    const net        = gross - returned
    const count      = vPurchases.length
    const returnCount = vReturns.length
    const days       = [...new Set(vPurchases.map(p => p.bs_day))].length
    const cash    = vPurchases.filter(p => p.payment_method === 'Cash').reduce((s, p) => s + p.qty * p.rate, 0)
      - vReturns.filter(r => r.payment_method === 'Cash').reduce((s, r) => s + r.qty * r.rate, 0)
    const credit  = vPurchases.filter(p => p.payment_method === 'Credit').reduce((s, p) => s + p.qty * p.rate, 0)
      - vReturns.filter(r => r.payment_method === 'Credit').reduce((s, r) => s + r.qty * r.rate, 0)
    const fonepay = vPurchases.filter(p => p.payment_method === 'FonePay').reduce((s, p) => s + p.qty * p.rate, 0)
      - vReturns.filter(r => r.payment_method === 'FonePay').reduce((s, r) => s + r.qty * r.rate, 0)
    return { vendor, gross, returned, net, count, returnCount, days, cash, credit, fonepay }
  }).filter(r => r.gross > 0 || r.returned > 0)

  const unassigned = purchases.filter(p => !p.vendor_id)
  const unassignedTotal = unassigned.reduce((s, p) => s + p.qty * p.rate, 0)

  const grandGross  = purchases.reduce((s, p) => s + p.qty * p.rate, 0)
  const grandReturn = returns.reduce((s, r) => s + r.qty * r.rate, 0)
  const grandNet    = grandGross - grandReturn

  const allDays = [...new Set([...purchases.map(p => p.bs_day), ...returns.map(r => r.bs_day)])].sort((a, b) => a - b)
  const activeVendors = vendors.filter(v => purchases.some(p => p.vendor_id === v.id))

  const searchLower = vendorSearch.toLowerCase()
  const filteredSummary = vendorSearch
    ? vendorSummary.filter(r =>
        r.vendor.name.toLowerCase().includes(searchLower) ||
        (r.vendor.vendor_code || '').toLowerCase().includes(searchLower)
      )
    : vendorSummary
  const filteredActiveVendors = vendorSearch
    ? activeVendors.filter(v =>
        v.name.toLowerCase().includes(searchLower) ||
        (v.vendor_code || '').toLowerCase().includes(searchLower)
      )
    : activeVendors

  function vendorDayNet(vendorId, day) {
    const gross = purchases.filter(p => p.vendor_id === vendorId && p.bs_day === day).reduce((s, p) => s + p.qty * p.rate, 0)
    const ret   = returns.filter(r => r.vendor_id === vendorId && r.bs_day === day).reduce((s, r) => s + r.qty * r.rate, 0)
    return gross - ret
  }

  function dayNet(day) {
    const gross = purchases.filter(p => p.bs_day === day).reduce((s, p) => s + p.qty * p.rate, 0)
    const ret   = returns.filter(r => r.bs_day === day).reduce((s, r) => s + r.qty * r.rate, 0)
    return gross - ret
  }

  function vendorNet(vendorId) {
    const gross = purchases.filter(p => p.vendor_id === vendorId).reduce((s, p) => s + p.qty * p.rate, 0)
    const ret   = returns.filter(r => r.vendor_id === vendorId).reduce((s, r) => s + r.qty * r.rate, 0)
    return gross - ret
  }

  function fmt(val) {
    return val !== 0 ? `NPR ${Number(val.toFixed(0)).toLocaleString('en-NP')}` : '—'
  }

  function exportExcel() {
    const wb = XLSX.utils.book_new()
    const summaryData = vendorSummary.map(r => ({
      'Vendor': r.vendor.name,
      'Transactions': r.count,
      'Days Active': r.days,
      'Gross Purchases (NPR)': r.gross.toFixed(0),
      'Returns (NPR)': r.returned.toFixed(0),
      'Net Spend (NPR)': r.net.toFixed(0),
      '% of Net Total': grandNet > 0 ? ((r.net / grandNet) * 100).toFixed(1) + '%' : '0%'
    }))
    if (unassignedTotal > 0) summaryData.push({
      'Vendor': 'Unassigned', 'Transactions': unassigned.length,
      'Days Active': [...new Set(unassigned.map(p => p.bs_day))].length,
      'Gross Purchases (NPR)': unassignedTotal.toFixed(0), 'Returns (NPR)': '0',
      'Net Spend (NPR)': unassignedTotal.toFixed(0),
      '% of Net Total': grandNet > 0 ? ((unassignedTotal / grandNet) * 100).toFixed(1) + '%' : '0%'
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryData), 'Vendor Summary')
    const dailyData = allDays.map(day => {
      const row = { 'Day': day }
      activeVendors.forEach(v => { const val = vendorDayNet(v.id, day); row[v.name] = val !== 0 ? val.toFixed(0) : '' })
      row['Day Net Total (NPR)'] = dayNet(day).toFixed(0)
      return row
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dailyData), 'Daily Breakdown')
    XLSX.writeFile(wb, `Vendor-Report-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Vendor Purchase Report</h1>
          <p className="page-subtitle">Net spend by supplier (gross purchases − returns) — {periodLabel}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <select className="form-select" value={selectedPeriod?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={exportExcel}>⬇ Export Excel</button>
        </div>
      </div>

      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(5,1fr)', marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-label">Gross Purchases</div>
          <div className="stat-value gold" style={{ fontSize: 17 }}>NPR {grandGross.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total Returns</div>
          <div className="stat-value" style={{ fontSize: 17, color: grandReturn > 0 ? '#f87171' : '#6b7280' }}>
            {grandReturn > 0 ? `−NPR ${grandReturn.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Net Spend</div>
          <div className="stat-value gold" style={{ fontSize: 17 }}>NPR {grandNet.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Active Vendors</div>
          <div className="stat-value">{vendorSummary.length}</div>
          <div className="stat-sub">With purchases this period</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Days with Purchases</div>
          <div className="stat-value">{allDays.length}</div>
        </div>
      </div>

      {/* Visual spend split */}
      {grandNet > 0 && vendorSummary.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>Vendor Net Spend Split</div>
          <div style={{ display: 'flex', height: 20, borderRadius: 6, overflow: 'hidden', gap: 2 }}>
            {vendorSummary.map((r, i) => {
              const pct = (r.net / grandNet) * 100
              const colors = ['#c9a84c','#34d399','#60a5fa','#f87171','#a78bfa','#fb923c','#22d3ee','#f472b6']
              return (
                <div key={r.vendor.id} style={{ width: `${pct}%`, background: colors[i % colors.length], display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: '#0f1117', minWidth: pct > 8 ? 'auto' : 0 }}>
                  {pct > 8 ? `${pct.toFixed(0)}%` : ''}
                </div>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
            {vendorSummary.map((r, i) => {
              const colors = ['#c9a84c','#34d399','#60a5fa','#f87171','#a78bfa','#fb923c','#22d3ee','#f472b6']
              return (
                <div key={r.vendor.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: colors[i % colors.length] }} />
                  <span style={{ fontSize: 12, color: '#6b7280' }}>{r.vendor.name}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Vendor search */}
      <div style={{ marginBottom: 16 }}>
        <input
          value={vendorSearch}
          onChange={e => setVendorSearch(e.target.value)}
          placeholder="Search vendor name or code…"
          style={{
            background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6,
            padding: '8px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none', width: 280
          }}
        />
        {vendorSearch && (
          <span style={{ marginLeft: 10, fontSize: 12, color: '#6b7280' }}>
            {filteredSummary.length} vendor{filteredSummary.length !== 1 ? 's' : ''} matched
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #2a2f3d' }}>
        {['summary', 'daily'].map(m => (
          <button key={m} onClick={() => setViewMode(m)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '10px 20px', fontSize: 13, fontWeight: 500,
            color: viewMode === m ? '#c9a84c' : '#6b7280',
            borderBottom: viewMode === m ? '2px solid #c9a84c' : '2px solid transparent', marginBottom: -1
          }}>{m === 'summary' ? 'Vendor Summary' : 'Daily Breakdown'}</button>
        ))}
      </div>

      <div className="card">
        {loading ? (
          <p style={{ color: '#6b7280', fontSize: 13 }}>Loading…</p>
        ) : purchases.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">⊙</div>
            <p className="empty-state-text">No purchases recorded for this period yet.</p>
          </div>
        ) : viewMode === 'summary' ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th style={{ textAlign: 'right' }}>Transactions</th>
                  <th style={{ textAlign: 'right' }}>Gross Purchases</th>
                  <th style={{ textAlign: 'right', color: '#f87171' }}><Tip text="Total value of items returned to this vendor this period.">Returns</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Net spend = Gross purchases − Returns. Your true payment obligation to this vendor.">Net Spend</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="This vendor's share of total net purchase spend for the period." width={220}>% of Net Total</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Average daily spend (net) across days this vendor had deliveries.">Avg/Day</Tip></th>
                  <th style={{ textAlign: 'right' }}>Cash (Net)</th>
                  <th style={{ textAlign: 'right' }}>Credit (Net)</th>
                  <th style={{ textAlign: 'right' }}>FonePay (Net)</th>
                </tr>
              </thead>
              <tbody>
                {filteredSummary.sort((a, b) => b.net - a.net).map(r => {
                  const pct = grandNet > 0 ? (r.net / grandNet) * 100 : 0
                  return (
                    <tr key={r.vendor.id}>
                      <td style={{ fontWeight: 600, color: '#e8e0d0' }}>
                        {r.vendor.vendor_code && (
                          <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#c9a84c', marginRight: 8 }}>{r.vendor.vendor_code}</span>
                        )}
                        {r.vendor.name}
                        {r.returnCount > 0 && <span style={{ fontSize: 11, color: '#f87171', marginLeft: 6 }}>({r.returnCount} return{r.returnCount > 1 ? 's' : ''})</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>{r.count}</td>
                      <td style={{ textAlign: 'right', color: '#c9a84c' }}>NPR {r.gross.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                      <td style={{ textAlign: 'right', color: '#f87171' }}>{r.returned > 0 ? `−NPR ${r.returned.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: '#c9a84c' }}>NPR {r.net.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                          <div style={{ width: 70, height: 5, background: '#2a2f3d', borderRadius: 3 }}>
                            <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: '#c9a84c', borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: 12, color: '#6b7280', minWidth: 38 }}>{pct.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', color: '#6b7280' }}>
                        NPR {r.days > 0 ? (r.net / r.days).toLocaleString('en-NP', { maximumFractionDigits: 0 }) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', color: r.cash > 0 ? '#34d399' : '#9ca3af' }}>{fmt(r.cash)}</td>
                      <td style={{ textAlign: 'right', color: r.credit > 0 ? '#f87171' : '#9ca3af' }}>{fmt(r.credit)}</td>
                      <td style={{ textAlign: 'right', color: r.fonepay > 0 ? '#60a5fa' : '#9ca3af' }}>{fmt(r.fonepay)}</td>
                    </tr>
                  )
                })}
                {unassignedTotal > 0 && (
                  <tr>
                    <td style={{ color: '#9ca3af', fontStyle: 'italic' }}>Unassigned</td>
                    <td style={{ textAlign: 'right', color: '#9ca3af' }}>{unassigned.length}</td>
                    <td style={{ textAlign: 'right', color: '#9ca3af' }}>NPR {unassignedTotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                    <td colSpan={7}></td>
                  </tr>
                )}
                <tr style={{ borderTop: '2px solid #2a2f3d' }}>
                  <td style={{ fontWeight: 800, color: '#e8e0d0', paddingTop: 12 }}>TOTAL</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, paddingTop: 12 }}>{purchases.length}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#c9a84c', paddingTop: 12 }}>NPR {grandGross.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#f87171', paddingTop: 12 }}>{grandReturn > 0 ? `−NPR ${grandReturn.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 800, color: '#c9a84c', fontSize: 15, paddingTop: 12 }}>NPR {grandNet.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#6b7280', paddingTop: 12 }}>100%</td>
                  <td colSpan={4}></td>
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
                  {filteredActiveVendors.map(v => <th key={v.id} style={{ textAlign: 'right' }}>{v.name}</th>)}
                  <th style={{ textAlign: 'right', color: '#c9a84c' }}>Day Net Total</th>
                </tr>
              </thead>
              <tbody>
                {allDays.map(day => {
                  const dn = dayNet(day)
                  return (
                    <tr key={day}>
                      <td style={{ fontWeight: 700, color: '#c9a84c' }}>{day}</td>
                      {filteredActiveVendors.map(v => {
                        const val = vendorDayNet(v.id, day)
                        return (
                          <td key={v.id} style={{ textAlign: 'right', color: val !== 0 ? '#e8e0d0' : '#2a2f3d' }}>
                            {val !== 0 ? val.toLocaleString('en-NP', { maximumFractionDigits: 0 }) : '—'}
                          </td>
                        )
                      })}
                      <td style={{ textAlign: 'right', fontWeight: 700, color: '#c9a84c' }}>
                        NPR {dn.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                      </td>
                    </tr>
                  )
                })}
                <tr style={{ borderTop: '2px solid #2a2f3d' }}>
                  <td style={{ fontWeight: 800, color: '#e8e0d0', paddingTop: 12 }}>TOTAL</td>
                  {filteredActiveVendors.map(v => (
                    <td key={v.id} style={{ textAlign: 'right', fontWeight: 700, color: '#c9a84c', paddingTop: 12 }}>
                      NPR {vendorNet(v.id).toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                    </td>
                  ))}
                  <td style={{ textAlign: 'right', fontWeight: 800, color: '#c9a84c', fontSize: 15, paddingTop: 12 }}>
                    NPR {grandNet.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
