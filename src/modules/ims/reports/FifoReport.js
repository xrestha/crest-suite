import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useSettings } from '../../../context/SettingsContext'
import { supabase } from '../../../supabaseClient'
import * as XLSX from 'xlsx'
import Tip from '../../../components/Tip'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

export default function FifoReport() {
  const { clientId, profile, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { settings } = useSettings()
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [filterFlag, setFilterFlag] = useState('all')
  const [filterCat, setFilterCat] = useState('all')
  const [categories, setCategories] = useState([])

  const warningDays = settings?.expiry_warning_days || 7

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const [{ data: p }, { data: c }] = await Promise.all([
      supabase.from('monthly_periods').select('*').eq('client_id', effectiveClientId).order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      supabase.from('categories').select('*').eq('client_id', effectiveClientId)
    ])
    setPeriods(p || [])
    setCategories(c || [])
    const open = (p || []).find(x => x.status === 'open')
    if (open) { setSelectedPeriod(open); await buildReport(open.id) }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setLoading(true)
    await buildReport(periodId)
    setLoading(false)
  }

  async function buildReport(periodId) {
    // Fetch purchases with expiry dates AND returns for the same period
    const [{ data: purchases }, { data: returns }] = await Promise.all([
      supabase.from('purchase_entries')
        .select('*, items(name, uom, per_uom_rate, categories(name))')
        .eq('period_id', periodId)
        .not('expiry_date', 'is', null)
        .order('expiry_date'),
      supabase.from('vendor_returns')
        .select('purchase_entry_id, qty')
        .eq('period_id', periodId)
    ])

    // Build a map of returned qty per purchase entry
    const returnedMap = {}
    ;(returns || []).forEach(r => {
      if (r.purchase_entry_id) {
        returnedMap[r.purchase_entry_id] = (returnedMap[r.purchase_entry_id] || 0) + parseFloat(r.qty)
      }
    })

    const today = new Date()
    const reportRows = (purchases || []).map(p => {
      // PATCHED: subtract returned qty from this purchase row
      const returnedQty = returnedMap[p.id] || 0
      const netQty = Math.max(0, p.qty - returnedQty)
      const expiry = new Date(p.expiry_date)
      const daysUntilExpiry = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24))
      const value = netQty * p.rate

      let flag = 'ok'
      if (daysUntilExpiry < 0) flag = 'expired'
      else if (daysUntilExpiry <= warningDays) flag = 'warning'

      return {
        id: p.id,
        itemName: p.items?.name,
        category: p.items?.categories?.name,
        uom: p.items?.uom,
        qty: netQty,
        originalQty: p.qty,
        returnedQty,
        rate: p.rate,
        value,
        expiryDate: p.expiry_date,
        daysUntilExpiry,
        flag,
        perUomRate: p.items?.per_uom_rate,
        bsDay: p.bs_day
      }
    }).filter(r => r.qty > 0) // hide fully-returned rows

    setRows(reportRows)
  }

  const filtered = rows.filter(r => {
    const matchFlag = filterFlag === 'all' || r.flag === filterFlag
    const matchCat  = filterCat === 'all' || r.category === filterCat
    return matchFlag && matchCat
  })

  const totalAtRisk   = filtered.filter(r => r.flag !== 'ok').reduce((s, r) => s + r.value, 0)
  const expiredCount  = filtered.filter(r => r.flag === 'expired').length
  const warningCount  = filtered.filter(r => r.flag === 'warning').length

  function exportExcel() {
    const data = filtered.map(r => ({
      'Item': r.itemName,
      'Category': r.category,
      'UOM': r.uom,
      'Net Qty (after returns)': r.qty,
      'Original Qty': r.originalQty,
      'Returned Qty': r.returnedQty || 0,
      'Rate': r.rate,
      'Value (NPR)': r.value.toFixed(0),
      'Expiry Date': r.expiryDate,
      'Days Until Expiry': r.daysUntilExpiry,
      'Status': r.flag === 'expired' ? 'EXPIRED' : r.flag === 'warning' ? 'EXPIRING SOON' : 'OK'
    }))
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'FIFO Report')
    XLSX.writeFile(wb, `FIFO-Report-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'

  function flagStyle(flag) {
    if (flag === 'expired') return { color: 'var(--theme-red)', badge: 'badge-red', label: 'Expired' }
    if (flag === 'warning') return { color: 'var(--theme-accent)', badge: 'badge-yellow', label: `Expiring in ${warningDays}d` }
    return { color: 'var(--theme-green)', badge: 'badge-green', label: 'OK' }
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title"><Tip text="First In, First Out — tracks which stock batches expire soonest so you use older stock before newer stock." width={240}>FIFO</Tip> / Expiry Report</h1>
          <p className="page-subtitle">Stock expiry tracking — net of returns — {periodLabel}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <select className="form-select" value={selectedPeriod?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={exportExcel}>⬇ Export Excel</button>
        </div>
      </div>

      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Items Tracked</div>
          <div className="stat-value">{rows.length}</div>
          <div className="stat-sub">With expiry dates (net of returns)</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Expired</div>
          <div className="stat-value" style={{ color: expiredCount > 0 ? 'var(--theme-red)' : 'var(--theme-green)' }}>{expiredCount}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text={`Items whose expiry date is within ${warningDays} days from today. Configurable in Settings → Thresholds.`} width={240}>Expiring Soon</Tip>
          </div>
          <div className="stat-value" style={{ color: warningCount > 0 ? 'var(--theme-accent)' : 'var(--theme-green)' }}>{warningCount}</div>
          <div className="stat-sub">Within {warningDays} days</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Total NPR value of stock that is expired or expiring soon. This is the potential loss if not used or returned in time." width={240}>Value at Risk</Tip>
          </div>
          <div className="stat-value" style={{ fontSize: 18, color: totalAtRisk > 0 ? 'var(--theme-red)' : 'var(--theme-green)' }}>
            NPR {totalAtRisk.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
          </div>
        </div>
      </div>

      <div className="tab-bar" style={{ marginBottom: 16, alignItems: 'center' }}>
        {['all', 'expired', 'warning', 'ok'].map(f => (
          <button key={f} onClick={() => setFilterFlag(f)} className={`tab-btn${filterFlag === f ? ' tab-btn--active' : ''}`}>
            {f === 'all' ? 'All' : f === 'warning' ? 'Expiring Soon' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <select className="form-select" value={filterCat} onChange={e => setFilterCat(e.target.value)}>
          <option value="all">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
      </div>

      <div className="card">
        {loading ? <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p> :
          rows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">◷</div>
              <p className="empty-state-text">No purchase entries with expiry dates found. Add expiry dates when recording purchases.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Category</th>
                    <th style={{ textAlign: 'right' }}><Tip text="Original purchased quantity minus any returns to vendor. This is the stock still on hand from this batch." width={230}>Net Qty</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-red)' }}>Returned</th>
                    <th>UOM</th>
                    <th style={{ textAlign: 'right' }}>Rate</th>
                    <th style={{ textAlign: 'right' }}>Value</th>
                    <th>Expiry Date</th>
                    <th style={{ textAlign: 'right' }}>Days Left</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(row => {
                    const fs = flagStyle(row.flag)
                    return (
                      <tr key={row.id} style={{ background: row.flag === 'expired' ? 'rgba(248,113,113,0.04)' : row.flag === 'warning' ? 'rgba(201,168,76,0.04)' : 'transparent' }}>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{row.itemName}</td>
                        <td><span className="badge badge-yellow">{row.category}</span></td>
                        <td style={{ textAlign: 'right' }}>{Number(row.qty).toLocaleString()}</td>
                        <td style={{ textAlign: 'right', color: row.returnedQty > 0 ? 'var(--theme-red)' : 'var(--theme-text3)' }}>
                          {row.returnedQty > 0 ? `−${Number(row.returnedQty).toLocaleString()}` : '—'}
                        </td>
                        <td style={{ color: 'var(--theme-text2)' }}>{row.uom}</td>
                        <td style={{ textAlign: 'right' }}>{Number(row.rate).toLocaleString()}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent)', fontWeight: 600 }}>NPR {Number(row.value.toFixed(0)).toLocaleString()}</td>
                        <td style={{ color: fs.color }}>{row.expiryDate}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: fs.color }}>
                          {row.daysUntilExpiry < 0 ? `${Math.abs(row.daysUntilExpiry)}d ago` : `${row.daysUntilExpiry}d`}
                        </td>
                        <td><span className={`badge ${fs.badge}`}>{fs.label}</span></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </div>
  )
}
