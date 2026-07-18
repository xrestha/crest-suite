import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import * as XLSX from 'xlsx'
import Tip from '../../../components/Tip'
import { printWithTitle } from '../../../utils/printTitle'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

export default function WastageReport() {
  const { clientId, profile } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const [periods, setPeriods]           = useState([])
  const [selectedPeriod, setSelected]   = useState(null)
  const [rows, setRows]                 = useState([])
  const [reasons, setReasons]           = useState([])
  const [catFilter, setCatFilter]       = useState('All')
  const [loading, setLoading]           = useState(false)

  useEffect(() => {
    if (!effectiveClientId) return
    scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .then(({ data }) => {
        setPeriods(data || [])
        if (data?.length) setSelected(data[0])
      })
  }, [effectiveClientId, scopedFrom])

  useEffect(() => {
    if (selectedPeriod) fetchData(selectedPeriod.id)
  }, [selectedPeriod]) // eslint-disable-line

  async function fetchData(periodId) {
    setLoading(true)
    const { data } = await supabase
      .from('wastages')
      .select('item_id, qty, bs_day, reason, items(name, uom, per_uom_rate, categories(name))')
      .eq('period_id', periodId)

    // Aggregate by item — an item can now have many rows (monthly catch-all + dated daily entries).
    const byItem = {}
    const byReason = {}
    ;(data || []).forEach(r => {
      const qty = parseFloat(r.qty || 0)
      if (qty <= 0) return
      const rate  = parseFloat(r.items?.per_uom_rate || 0)
      const value = qty * rate
      if (!byItem[r.item_id]) {
        byItem[r.item_id] = {
          item_id: r.item_id, name: r.items?.name || '—',
          category: r.items?.categories?.name || 'Uncategorised',
          uom: r.items?.uom || '', rate, qty: 0, value: 0,
        }
      }
      byItem[r.item_id].qty   += qty
      byItem[r.item_id].value += value
      // Reason breakdown — undated catch-all rows have no reason.
      const reason = r.bs_day == null ? 'Monthly (untagged)' : (r.reason || 'Other')
      if (!byReason[reason]) byReason[reason] = { reason, qty: 0, value: 0 }
      byReason[reason].qty   += qty
      byReason[reason].value += value
    })

    setRows(Object.values(byItem).sort((a, b) => b.value - a.value))
    setReasons(Object.values(byReason).sort((a, b) => b.value - a.value))
    setCatFilter('All')
    setLoading(false)
  }

  const totalValue  = rows.reduce((s, r) => s + r.value, 0)
  const categories  = ['All', ...Array.from(new Set(rows.map(r => r.category))).sort()]
  const filtered    = catFilter === 'All' ? rows : rows.filter(r => r.category === catFilter)

  const catTotals = {}
  rows.forEach(r => { catTotals[r.category] = (catTotals[r.category] || 0) + r.value })
  const topCat = Object.entries(catTotals).sort((a, b) => b[1] - a[1])[0]

  const periodLabel = selectedPeriod
    ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}`
    : ''

  function fmt(n) {
    if (!n) return '—'
    return 'NPR ' + Number(n).toLocaleString('en-NP', { maximumFractionDigits: 0 })
  }

  function exportExcel() {
    const wb   = XLSX.utils.book_new()
    const data = rows.map(r => ({
      'Item':         r.name,
      'Category':     r.category,
      'UOM':          r.uom,
      'Qty Wasted':   r.qty || '',
      'Value (NPR)':  r.value ? r.value.toFixed(0) : '',
      '% of Total':   totalValue ? ((r.value / totalValue) * 100).toFixed(1) + '%' : '0%',
    }))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Wastage')
    if (reasons.length) {
      const rData = reasons.map(r => ({
        'Reason':      r.reason,
        'Qty':         r.qty || '',
        'Value (NPR)': r.value ? r.value.toFixed(0) : '',
        '% of Total':  totalValue ? ((r.value / totalValue) * 100).toFixed(1) + '%' : '0%',
      }))
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rData), 'By Reason')
    }
    XLSX.writeFile(wb, `Wastage-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  return (
    <div className="page-container">

      {/* Print-only header */}
      <div className="print-only" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Wastage Report — {periodLabel}</h2>
      </div>

      {/* Screen header */}
      <div className="no-print" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Wastage Report</h1>
          <p className="page-subtitle">Items logged as waste this period — quantity and NPR cost</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="form-select" value={selectedPeriod?.id || ''} onChange={e => setSelected(periods.find(p => p.id === e.target.value))}>
            {periods.map(p => (
              <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year}</option>
            ))}
          </select>
          <button className="btn btn-ghost" onClick={() => printWithTitle(`Wastage Report - ${periodLabel}`)}>Print</button>
          <button className="btn btn-ghost" onClick={exportExcel} disabled={!rows.length}>Export Excel</button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="stat-grid no-print" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Total Wastage Value</div>
          <div className="stat-value" style={{ color: 'var(--theme-red)' }}>{fmt(totalValue)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Items with Wastage</div>
          <div className="stat-value">{rows.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Top Wastage Category</div>
          <div className="stat-value" style={{ fontSize: 16 }}>{topCat ? topCat[0] : '—'}</div>
          {topCat && <div className="stat-label" style={{ marginTop: 4 }}>{fmt(topCat[1])}</div>}
        </div>
      </div>

      {/* By Reason breakdown */}
      {reasons.length > 0 && (
        <div className="card no-print" style={{ marginBottom: 20, padding: 0 }}>
          <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            <Tip text="Wastage grouped by reason. Daily Wastage entries carry a reason; the monthly catch-all from the Wastage tab shows as “Monthly (untagged)”." width={280}>By Reason</Tip>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Reason</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Value (NPR)</th>
                  <th style={{ textAlign: 'right' }}>% of Total</th>
                </tr>
              </thead>
              <tbody>
                {reasons.map(r => (
                  <tr key={r.reason}>
                    <td><span className="badge badge-yellow">{r.reason}</span></td>
                    <td style={{ textAlign: 'right' }}>{Number(r.qty).toLocaleString()}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>{fmt(r.value)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{totalValue ? ((r.value / totalValue) * 100).toFixed(1) + '%' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Category filter tabs */}
      {categories.length > 2 && (
        <div className="tab-bar no-print" style={{ marginBottom: 16 }}>
          {categories.map(c => (
            <button key={c} className={`tab-btn${catFilter === c ? ' tab-btn--active' : ''}`} onClick={() => setCatFilter(c)}>{c}</button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">No wastage entries for this period.</div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th>UOM</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Total quantity logged as waste in the Wastage tab of Stock Count." width={220}>Qty Wasted</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Qty Wasted × per-unit rate. Represents the NPR cost of goods lost." width={240}>Value (NPR)</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="This item's wastage value as a % of total wastage value for the period." width={240}>% of Total</Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.item_id}>
                  <td><strong>{r.name}</strong></td>
                  <td>{r.category}</td>
                  <td>{r.uom}</td>
                  <td style={{ textAlign: 'right' }}>{Number(r.qty).toLocaleString()}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>{fmt(r.value)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                    {totalValue ? ((r.value / totalValue) * 100).toFixed(1) + '%' : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={3}>Total ({filtered.length} items)</td>
                <td />
                <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>{fmt(filtered.reduce((s, r) => s + r.value, 0))}</td>
                <td style={{ textAlign: 'right' }}>
                  {catFilter === 'All' ? '100%' : totalValue ? ((filtered.reduce((s,r) => s+r.value, 0) / totalValue * 100).toFixed(1) + '%') : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
