import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import Tip from '../components/Tip'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

export default function Variance() {
  const { clientId, profile, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [report, setReport] = useState([])
  const [loading, setLoading] = useState(true)
  const [filterCat, setFilterCat] = useState('all')
  const [filterFlag, setFilterFlag] = useState('all')
  const [categories, setCategories] = useState([])
  const [summary, setSummary] = useState(null)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const [{ data: p }, { data: c }] = await Promise.all([
      supabase.from('monthly_periods').select('*').eq('client_id', effectiveClientId).order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      supabase.from('categories').select('*').eq('client_id', effectiveClientId).order('sort_order')
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
    const [
      { data: items },
      { data: opening },
      { data: closing },
      { data: purchases },
      { data: returns },
      { data: wastages },
      { data: staffMealsData },
      { data: sales },
      { data: recipeIngs }
    ] = await Promise.all([
      supabase.from('items').select('*, categories(name)').eq('client_id', effectiveClientId).eq('is_active', true).eq('is_sub_recipe', false),
      supabase.from('opening_stock').select('*').eq('period_id', periodId),
      supabase.from('closing_stock').select('*').eq('period_id', periodId),
      supabase.from('purchase_entries').select('item_id, qty').eq('period_id', periodId),
      supabase.from('vendor_returns').select('item_id, qty').eq('period_id', periodId),
      supabase.from('wastages').select('item_id, qty').eq('period_id', periodId),
      supabase.from('staff_meals').select('item_id, qty').eq('period_id', periodId),
      supabase.from('sales_entries').select('recipe_id, qty_sold').eq('period_id', periodId),
      supabase.from('recipe_ingredients').select('recipe_id, item_id, qty_per_portion')
    ])

    const openMap = {}; (opening || []).forEach(r => { openMap[r.item_id] = parseFloat(r.qty) || 0 })
    const closeMap = {}; (closing || []).forEach(r => { closeMap[r.item_id] = parseFloat(r.physical_qty) || 0 })

    // PATCHED: build purchMap net of returns
    const purchMap = {}
    ;(purchases || []).forEach(r => { purchMap[r.item_id] = (purchMap[r.item_id] || 0) + parseFloat(r.qty) })
    ;(returns || []).forEach(r => { purchMap[r.item_id] = (purchMap[r.item_id] || 0) - parseFloat(r.qty) })

    const wasteMap = {}
    ;(wastages || []).forEach(r => { wasteMap[r.item_id] = (wasteMap[r.item_id] || 0) + parseFloat(r.qty) })

    const staffMealMap = {}
    ;(staffMealsData || []).forEach(r => { staffMealMap[r.item_id] = (staffMealMap[r.item_id] || 0) + parseFloat(r.qty) })

    const soldMap = {}
    ;(sales || []).forEach(s => { soldMap[s.recipe_id] = (soldMap[s.recipe_id] || 0) + parseFloat(s.qty_sold) })

    const yieldMap = {}
    ;(items || []).forEach(i => { yieldMap[i.id] = (parseFloat(i.yield_pct) || 100) / 100 })

    const theoreticalMap = {}
    ;(recipeIngs || []).forEach(ri => {
      if (!ri.item_id) return
      const sold = soldMap[ri.recipe_id] || 0
      const yieldFactor = yieldMap[ri.item_id] || 1
      if (sold > 0) theoreticalMap[ri.item_id] = (theoreticalMap[ri.item_id] || 0) + (sold * parseFloat(ri.qty_per_portion) / yieldFactor)
    })

    const rows = (items || []).map(item => {
      const openQty      = openMap[item.id] || 0
      const netPurchQty  = purchMap[item.id] || 0  // already net of returns
      const closeQty     = closeMap[item.id] || 0
      const wasteQty     = wasteMap[item.id]     || 0
      const staffMealQty = staffMealMap[item.id] || 0
      const actualUsed   = openQty + netPurchQty - closeQty - wasteQty - staffMealQty
      const theoreticalUsed = theoreticalMap[item.id] || 0
      const variance     = actualUsed - theoreticalUsed
      const variancePct  = theoreticalUsed > 0 ? (variance / theoreticalUsed) * 100 : null
      const value        = variance * parseFloat(item.per_uom_rate || 0)

      let flag = 'ok'
      if (variancePct !== null) {
        if (variancePct > 10) flag = 'over'
        else if (variancePct < -10) flag = 'under'
      }
      if (theoreticalUsed === 0 && actualUsed > 0) flag = 'over'

      return {
        item, openQty,
        purchQty: netPurchQty, // net figure displayed
        closeQty, wasteQty,
        actualUsed, theoreticalUsed, variance,
        variancePct, value, flag,
        category: item.categories?.name || 'Uncategorised'
      }
    })

    const totalActual         = rows.reduce((s, r) => s + Math.max(r.actualUsed, 0), 0)
    const totalTheoretical    = rows.reduce((s, r) => s + r.theoreticalUsed, 0)
    const totalVarianceValue  = rows.reduce((s, r) => s + r.value, 0)
    const flaggedCount        = rows.filter(r => r.flag !== 'ok' && (r.actualUsed > 0 || r.theoreticalUsed > 0)).length

    setSummary({ totalActual, totalTheoretical, totalVarianceValue, flaggedCount, totalItems: rows.length })
    setReport(rows)
  }

  const filtered = report.filter(r => {
    const matchCat  = filterCat === 'all' || r.item.categories?.name === filterCat
    const matchFlag = filterFlag === 'all' || r.flag === filterFlag
    const hasActivity = r.actualUsed !== 0 || r.theoreticalUsed > 0 || r.openQty > 0 || r.purchQty > 0
    return matchCat && matchFlag && hasActivity
  })

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'

  function flagBadge(flag) {
    if (flag === 'over') return <span className="badge badge-red">Over</span>
    if (flag === 'under') return <span className="badge badge-yellow">Under</span>
    return <span className="badge badge-green">OK</span>
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Variance Report</h1>
          <p className="page-subtitle">Theoretical vs actual usage — the money report — {periodLabel}</p>
        </div>
        <select
          className="form-select"
          value={selectedPeriod?.id || ''}
          onChange={e => handlePeriodChange(e.target.value)}
        >
          {periods.map(p => (
            <option key={p.id} value={p.id}>
              {BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : '(closed)'}
            </option>
          ))}
        </select>
      </div>

      {summary && (
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 24 }}>
          <div className="stat-card">
            <div className="stat-label">Items Analysed</div>
            <div className="stat-value">{filtered.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">
              <Tip text="Items where actual usage differs from theoretical by more than 10%. These need investigation." width={230}>Flagged Items</Tip>
            </div>
            <div className="stat-value" style={{ color: summary.flaggedCount > 0 ? '#f87171' : '#34d399' }}>{summary.flaggedCount}</div>
            <div className="stat-sub">&gt;10% variance</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">
              <Tip text="Sum of (over-used qty × item rate) across all items. This is the NPR value of stock you can't account for." width={240}>Total Variance Value</Tip>
            </div>
            <div className="stat-value gold" style={{ fontSize: 18, color: summary.totalVarianceValue > 0 ? '#f87171' : '#34d399' }}>
              NPR {Math.abs(summary.totalVarianceValue).toLocaleString('en-NP', { maximumFractionDigits: 0 })}
            </div>
            <div className="stat-sub">{summary.totalVarianceValue > 0 ? 'Over-used (potential loss)' : 'Under-used'}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">
              <Tip text="Whether sales data is linked. Without sales, theoretical usage can't be calculated and variance won't be meaningful." width={240}>Data Coverage</Tip>
            </div>
            <div className="stat-value" style={{ fontSize: 16 }}>
              {summary.totalTheoretical > 0 ? <span className="badge badge-green">Sales linked</span> : <span className="badge badge-yellow">No sales data</span>}
            </div>
            <div className="stat-sub">{summary.totalTheoretical > 0 ? 'Theoretical usage calculated' : 'Add sales entries to compare'}</div>
          </div>
        </div>
      )}

      <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.15)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>
        <strong style={{ color: '#c9a84c' }}>How to read this:</strong> Theoretical = what should have been used based on sales × recipe qty. Actual = Opening + Net Purchases (after returns) − Closing − Wastage.
        <span style={{ color: '#f87171' }}> Over variance</span> = more used than sold (waste, theft, over-portioning).
        <span style={{ color: '#c9a84c' }}> Under variance</span> = less used than expected (under-portioning or data gap).
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="form-select"
          value={filterCat} onChange={e => setFilterCat(e.target.value)}>
          <option value="all">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <select className="form-select"
          value={filterFlag} onChange={e => setFilterFlag(e.target.value)}>
          <option value="all">All Items</option>
          <option value="over">Over variance only</option>
          <option value="under">Under variance only</option>
          <option value="ok">OK only</option>
        </select>
        <span style={{ fontSize: 13, color: '#6b7280' }}>{filtered.length} items</span>
      </div>

      <div className="card">
        {loading ? (
          <p style={{ color: '#6b7280', fontSize: 13 }}>Building report…</p>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">△</div>
            <p className="empty-state-text">No data yet. Complete stock count and add purchase entries to generate the variance report.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th>UOM</th>
                  <th style={{ textAlign: 'right' }}>Opening</th>
                  <th style={{ textAlign: 'right' }}>Net Purchased</th>
                  <th style={{ textAlign: 'right' }}>Wastage</th>
                  <th style={{ textAlign: 'right' }}>Closing</th>
                  <th style={{ textAlign: 'right' }}><Tip text="Opening + Net Purchases − Closing − Wastage. What was actually consumed based on stock movement." width={230}>Actual Used</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="What should have been used based on recipes sold × ingredient qty per portion." width={220}>Theoretical</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Actual − Theoretical. Positive (red) = over-used = loss. Negative (yellow) = under-used = possible data gap." width={240}>Variance</Tip></th>
                  <th style={{ textAlign: 'right' }}>Var %</th>
                  <th style={{ textAlign: 'right' }}>Value (NPR)</th>
                  <th>Flag</th>
                </tr>
              </thead>
              <tbody>
                {filtered.sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).map(row => {
                  const varColor = row.variance > 0 ? '#f87171' : row.variance < 0 ? '#c9a84c' : '#6b7280'
                  return (
                    <tr key={row.item.id} style={{ background: row.flag === 'over' ? 'rgba(248,113,113,0.03)' : 'transparent' }}>
                      <td style={{ fontWeight: 600, color: '#e8e0d0' }}>{row.item.name}</td>
                      <td><span className="badge badge-yellow">{row.category}</span></td>
                      <td style={{ color: '#6b7280' }}>{row.item.uom}</td>
                      <td style={{ textAlign: 'right', color: '#6b7280' }}>{row.openQty > 0 ? row.openQty.toLocaleString() : '—'}</td>
                      <td style={{ textAlign: 'right', color: '#c9a84c' }}>{row.purchQty !== 0 ? row.purchQty.toLocaleString() : '—'}</td>
                      <td style={{ textAlign: 'right', color: '#f87171' }}>{row.wasteQty > 0 ? row.wasteQty.toLocaleString() : '—'}</td>
                      <td style={{ textAlign: 'right', color: '#34d399' }}>{row.closeQty > 0 ? row.closeQty.toLocaleString() : '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{row.actualUsed !== 0 ? Number(row.actualUsed.toFixed(3)).toLocaleString() : '—'}</td>
                      <td style={{ textAlign: 'right', color: '#6b7280' }}>{row.theoreticalUsed > 0 ? Number(row.theoreticalUsed.toFixed(3)).toLocaleString() : '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: varColor }}>
                        {row.variance !== 0 ? (row.variance > 0 ? '+' : '') + Number(row.variance.toFixed(3)).toLocaleString() : '—'}
                      </td>
                      <td style={{ textAlign: 'right', color: varColor }}>
                        {row.variancePct != null ? `${row.variancePct > 0 ? '+' : ''}${row.variancePct.toFixed(1)}%` : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: varColor }}>
                        {row.value !== 0 ? `${row.value > 0 ? '+' : ''}${Number(row.value.toFixed(0)).toLocaleString()}` : '—'}
                      </td>
                      <td>{flagBadge(row.flag)}</td>
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
