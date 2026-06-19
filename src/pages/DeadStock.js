import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import * as XLSX from 'xlsx'
import Tip from '../components/Tip'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

// Item is "Slow" if used < 20% of net available
const SLOW_THRESHOLD = 0.2

export default function DeadStock() {
  const { clientId } = useAuth()
  const [periods, setPeriods]           = useState([])
  const [selectedPeriod, setSelected]   = useState(null)
  const [rows, setRows]                 = useState([])
  const [statusFilter, setStatusFilter] = useState('All')
  const [catFilter, setCatFilter]       = useState('All')
  const [loading, setLoading]           = useState(false)

  useEffect(() => {
    if (!clientId) return
    supabase.from('monthly_periods')
      .select('*').eq('client_id', clientId)
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .then(({ data }) => {
        setPeriods(data || [])
        if (data?.length) setSelected(data[0])
      })
  }, [clientId])

  useEffect(() => {
    if (selectedPeriod) fetchData(selectedPeriod.id)
  }, [selectedPeriod]) // eslint-disable-line

  async function fetchData(periodId) {
    setLoading(true)
    const [
      { data: itemsData },
      { data: openings },
      { data: purchases },
      { data: rets },
      { data: wastes },
      { data: closings },
    ] = await Promise.all([
      supabase.from('items').select('id, name, uom, per_uom_rate, categories(name)').eq('client_id', clientId).eq('is_active', true),
      supabase.from('opening_stock').select('item_id, qty').eq('period_id', periodId),
      supabase.from('purchase_entries').select('item_id, qty').eq('period_id', periodId),
      supabase.from('vendor_returns').select('item_id, qty').eq('period_id', periodId),
      supabase.from('wastages').select('item_id, qty').eq('period_id', periodId),
      supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', periodId),
    ])

    function sumField(arr, field, itemId) {
      return (arr || []).filter(r => r.item_id === itemId).reduce((s, r) => s + parseFloat(r[field] || 0), 0)
    }

    const built = []
    for (const item of (itemsData || [])) {
      const opening   = sumField(openings,  'qty',          item.id)
      const purchased = sumField(purchases, 'qty',          item.id)
      const returned  = sumField(rets,      'qty',          item.id)
      const wasted    = sumField(wastes,    'qty',          item.id)
      const closing   = sumField(closings,  'physical_qty', item.id)
      const available = opening + purchased - returned
      const used      = Math.max(available - wasted - closing, 0)

      // Skip items with no stock presence at all
      if (available <= 0 && closing <= 0) continue

      const status = used === 0
        ? 'Dead'
        : available > 0 && used / available < SLOW_THRESHOLD
          ? 'Slow'
          : null

      if (!status) continue

      const rate = parseFloat(item.per_uom_rate || 0)
      built.push({
        id:          item.id,
        name:        item.name,
        category:    item.categories?.name || 'Uncategorised',
        uom:         item.uom,
        opening,
        purchased,
        returned,
        wasted,
        used,
        closing,
        available,
        rate,
        valueAtRisk: closing * rate,
        status,
      })
    }

    built.sort((a, b) => b.valueAtRisk - a.valueAtRisk)
    setRows(built)
    setStatusFilter('All')
    setCatFilter('All')
    setLoading(false)
  }

  const deadCount        = rows.filter(r => r.status === 'Dead').length
  const slowCount        = rows.filter(r => r.status === 'Slow').length
  const totalValueAtRisk = rows.reduce((s, r) => s + r.valueAtRisk, 0)
  const categories       = ['All', ...Array.from(new Set(rows.map(r => r.category))).sort()]

  let filtered = rows
  if (statusFilter !== 'All') filtered = filtered.filter(r => r.status === statusFilter)
  if (catFilter !== 'All')   filtered = filtered.filter(r => r.category === catFilter)

  const periodLabel = selectedPeriod
    ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}`
    : ''

  function fmt(n) {
    if (!n) return '—'
    return 'NPR ' + Number(n).toLocaleString('en-NP', { maximumFractionDigits: 0 })
  }

  function fmtQty(n) {
    return n ? Number(n).toLocaleString() : '—'
  }

  function exportExcel() {
    const wb   = XLSX.utils.book_new()
    const data = rows.map(r => ({
      'Item':               r.name,
      'Category':           r.category,
      'UOM':                r.uom,
      'Status':             r.status,
      'Opening Qty':        r.opening   || '',
      'Purchased Qty':      r.purchased || '',
      'Returned Qty':       r.returned  || '',
      'Net Available':      r.available || '',
      'Wasted Qty':         r.wasted    || '',
      'Used Qty':           r.used      || '',
      'Closing Qty':        r.closing   || '',
      'Value at Risk (NPR)':r.valueAtRisk ? r.valueAtRisk.toFixed(0) : '',
    }))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Dead Stock')
    XLSX.writeFile(wb, `DeadStock-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  return (
    <div className="page-container">

      {/* Print-only header */}
      <div className="print-only" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Dead Stock / Slow Movers — {periodLabel}</h2>
      </div>

      {/* Screen header */}
      <div className="no-print" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Dead Stock / Slow Movers</h1>
          <p className="page-subtitle">Items with zero or low consumption — capital tied up in stock</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="form-select" value={selectedPeriod?.id || ''} onChange={e => setSelected(periods.find(p => p.id === e.target.value))}>
            {periods.map(p => (
              <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year}</option>
            ))}
          </select>
          <button className="btn btn-ghost" onClick={() => window.print()}>Print</button>
          <button className="btn btn-ghost" onClick={exportExcel} disabled={!rows.length}>Export Excel</button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="stat-grid no-print" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Dead Stock Items</div>
          <div className="stat-value" style={{ color: '#f87171' }}>{deadCount}</div>
          <div className="stat-label" style={{ marginTop: 4 }}>Zero consumption</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Slow Movers</div>
          <div className="stat-value" style={{ color: '#fbbf24' }}>{slowCount}</div>
          <div className="stat-label" style={{ marginTop: 4 }}>Used &lt;20% of available</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Total closing stock value of all dead and slow-moving items — capital currently tied up in idle inventory." width={260}>Value at Risk</Tip>
          </div>
          <div className="stat-value" style={{ color: '#f87171' }}>{fmt(totalValueAtRisk)}</div>
        </div>
      </div>

      {/* Filters */}
      <div className="no-print" style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {['All', 'Dead', 'Slow'].map(s => (
          <button
            key={s}
            className={`tab-btn${statusFilter === s ? ' tab-btn--active' : ''}`}
            onClick={() => setStatusFilter(s)}
          >
            {s} ({s === 'All' ? rows.length : s === 'Dead' ? deadCount : slowCount})
          </button>
        ))}
        {categories.length > 2 && (
          <div style={{ marginLeft: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {categories.map(c => (
              <button key={c} className={`tab-btn${catFilter === c ? ' tab-btn--active' : ''}`} onClick={() => setCatFilter(c)}>{c}</button>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <div className="loading-state">Loading...</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">No dead or slow-moving stock this period.</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">No items match the selected filters.</div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th>UOM</th>
                <th style={{ textAlign: 'right' }}>Opening</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Net purchases this period (purchases minus vendor returns)." width={220}>Net Purchased</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>Wasted</th>
                <th style={{ textAlign: 'right' }}>Used</th>
                <th style={{ textAlign: 'right' }}>Closing</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Closing stock × per-unit rate. NPR value currently sitting idle in inventory." width={240}>Value at Risk</Tip>
                </th>
                <th>
                  <Tip text="Dead = zero consumption this period. Slow = used less than 20% of net available stock." width={260}>Status</Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id} style={{ opacity: r.status === 'Dead' ? 1 : 0.85 }}>
                  <td><strong>{r.name}</strong></td>
                  <td>{r.category}</td>
                  <td>{r.uom}</td>
                  <td style={{ textAlign: 'right' }}>{fmtQty(r.opening)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtQty(r.purchased - r.returned)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtQty(r.wasted)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtQty(r.used)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtQty(r.closing)}</td>
                  <td style={{ textAlign: 'right', color: '#f87171', fontWeight: 600 }}>{fmt(r.valueAtRisk)}</td>
                  <td>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                      color:      r.status === 'Dead' ? '#f87171' : '#fbbf24',
                      background: r.status === 'Dead' ? 'rgba(248,113,113,0.1)' : 'rgba(251,191,36,0.1)',
                      border:     `1px solid ${r.status === 'Dead' ? 'rgba(248,113,113,0.25)' : 'rgba(251,191,36,0.25)'}`,
                    }}>
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
