import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'

function shrinkageStatus(count, covered) {
  const ratio = covered > 0 ? count / covered : 0
  if (ratio >= 0.67 && count >= 2) return { label: 'Consistent', color: 'var(--theme-red)', bg: 'rgba(248,113,113,0.1)' }
  if (count >= 2)                  return { label: 'Occasional', color: '#f97316', bg: 'rgba(249,115,22,0.1)'  }
  if (count === 1)                 return { label: 'Once',       color: 'var(--theme-accent)', bg: 'rgba(201,168,76,0.1)'  }
  return                                  { label: 'Clear',      color: 'var(--theme-green)', bg: 'rgba(52,211,153,0.1)'  }
}

export default function ShrinkageReport() {
  const { clientId, profile, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id

  const [periods, setPeriods]         = useState([])
  const [periodCount, setPeriodCount] = useState(6)
  const [categories, setCategories]   = useState([])
  const [filterCat, setFilterCat]     = useState('all')
  const [filterStatus, setFilterStatus] = useState('flagged')
  const [report, setReport]           = useState([])
  const [summary, setSummary]         = useState(null)
  const [loading, setLoading]         = useState(true)
  const [periodsUsed, setPeriodsUsed] = useState(0)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line
  useEffect(() => { if (periods.length) buildReport() }, [periodCount, periods]) // eslint-disable-line

  async function init() {
    const [{ data: p }, { data: c }] = await Promise.all([
      supabase.from('monthly_periods').select('*')
        .eq('client_id', effectiveClientId).eq('status', 'closed')
        .order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      supabase.from('categories').select('*').eq('client_id', effectiveClientId).order('sort_order'),
    ])
    setCategories(c || [])
    setPeriods(p || [])
  }

  async function buildReport() {
    setLoading(true)
    const selected = periods.slice(0, periodCount)
    if (!selected.length) { setReport([]); setSummary(null); setLoading(false); return }
    const periodIds = selected.map(p => p.id)
    setPeriodsUsed(selected.length)

    const [
      { data: items },
      { data: opening },
      { data: closing },
      { data: purchases },
      { data: returns },
      { data: wastages },
      { data: sales },
      { data: clientRecipes },
    ] = await Promise.all([
      supabase.from('items').select('*, categories(name)').eq('client_id', effectiveClientId).eq('is_active', true).eq('is_sub_recipe', false),
      supabase.from('opening_stock').select('period_id, item_id, qty').in('period_id', periodIds),
      supabase.from('closing_stock').select('period_id, item_id, physical_qty').in('period_id', periodIds),
      supabase.from('purchase_entries').select('period_id, item_id, qty').in('period_id', periodIds),
      supabase.from('vendor_returns').select('period_id, item_id, qty').in('period_id', periodIds),
      supabase.from('wastages').select('period_id, item_id, qty').in('period_id', periodIds),
      supabase.from('sales_entries').select('period_id, recipe_id, qty_sold').in('period_id', periodIds),
      supabase.from('recipes').select('id').eq('client_id', effectiveClientId),
    ])

    const shrinkRecipeIds = (clientRecipes || []).map(r => r.id)
    const { data: recipeIngs } = shrinkRecipeIds.length > 0
      ? await supabase.from('recipe_ingredients').select('recipe_id, item_id, qty_per_portion').not('item_id', 'is', null).in('recipe_id', shrinkRecipeIds)
      : { data: [] }

    // Build per-period-per-item lookups
    function makeMap(rows, valKey) {
      const m = {}
      ;(rows || []).forEach(r => {
        if (!m[r.period_id]) m[r.period_id] = {}
        m[r.period_id][r.item_id] = (m[r.period_id][r.item_id] || 0) + parseFloat(r[valKey] || 0)
      })
      return m
    }

    const openMap  = makeMap(opening, 'qty')
    const wasteMap = makeMap(wastages, 'qty')

    const closeMap = {}
    ;(closing || []).forEach(r => {
      if (!closeMap[r.period_id]) closeMap[r.period_id] = {}
      closeMap[r.period_id][r.item_id] = parseFloat(r.physical_qty || 0)
    })

    const purchMap = {}
    ;(purchases || []).forEach(r => {
      if (!purchMap[r.period_id]) purchMap[r.period_id] = {}
      purchMap[r.period_id][r.item_id] = (purchMap[r.period_id][r.item_id] || 0) + parseFloat(r.qty)
    })
    ;(returns || []).forEach(r => {
      if (!purchMap[r.period_id]) purchMap[r.period_id] = {}
      purchMap[r.period_id][r.item_id] = (purchMap[r.period_id][r.item_id] || 0) - parseFloat(r.qty)
    })

    // Theoretical usage: sold × qty_per_portion, per period per item
    const soldMap = {}
    ;(sales || []).forEach(s => {
      if (!soldMap[s.period_id]) soldMap[s.period_id] = {}
      soldMap[s.period_id][s.recipe_id] = (soldMap[s.period_id][s.recipe_id] || 0) + parseFloat(s.qty_sold)
    })
    const theorMap = {}
    ;(recipeIngs || []).forEach(ri => {
      periodIds.forEach(pid => {
        const sold = soldMap[pid]?.[ri.recipe_id] || 0
        if (sold <= 0) return
        if (!theorMap[pid]) theorMap[pid] = {}
        theorMap[pid][ri.item_id] = (theorMap[pid][ri.item_id] || 0) + sold * parseFloat(ri.qty_per_portion)
      })
    })

    // Aggregate per item
    const rows = (items || []).map(item => {
      let shrinkCount    = 0
      let totalShrinkQty = 0
      let coveredPeriods = 0

      periodIds.forEach(pid => {
        const theor = theorMap[pid]?.[item.id] || 0
        if (theor <= 0) return
        coveredPeriods++
        const open   = openMap[pid]?.[item.id]  || 0
        const close  = closeMap[pid]?.[item.id] || 0
        const purch  = purchMap[pid]?.[item.id] || 0
        const waste  = wasteMap[pid]?.[item.id] || 0
        const actual = open + purch - close - waste
        const variance = actual - theor
        if (variance > 0.001) {
          shrinkCount++
          totalShrinkQty += variance
        }
      })

      if (coveredPeriods === 0) return null

      const totalShrinkValue = totalShrinkQty * parseFloat(item.per_uom_rate || 0)
      const status = shrinkageStatus(shrinkCount, coveredPeriods)

      return {
        item,
        shrinkCount,
        coveredPeriods,
        totalShrinkQty,
        totalShrinkValue,
        avgShrinkQty: shrinkCount > 0 ? totalShrinkQty / shrinkCount : 0,
        status,
        category: item.categories?.name || 'Uncategorised',
      }
    }).filter(Boolean)

    const consistent    = rows.filter(r => r.status.label === 'Consistent').length
    const anyFlagged    = rows.filter(r => r.shrinkCount > 0).length
    const totalLossVal  = rows.reduce((s, r) => s + r.totalShrinkValue, 0)

    setSummary({ consistent, anyFlagged, totalLossVal, totalTracked: rows.length })
    setReport(rows)
    setLoading(false)
  }

  const filtered = report
    .filter(r => {
      const matchCat = filterCat === 'all' || r.category === filterCat
      const matchSt  = filterStatus === 'all'
        || (filterStatus === 'flagged'    && r.shrinkCount > 0)
        || (filterStatus === 'consistent' && r.status.label === 'Consistent')
      return matchCat && matchSt
    })
    .sort((a, b) => b.totalShrinkValue - a.totalShrinkValue)

  function fmt(v) { return `NPR ${Number(v).toLocaleString('en-NP', { maximumFractionDigits: 0 })}` }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Shrinkage Report</h1>
          <p className="page-subtitle">Consistent unexplained stock loss across periods — {periodsUsed} closed periods analysed</p>
        </div>
        <select className="form-select" value={periodCount} onChange={e => setPeriodCount(Number(e.target.value))}>
          <option value={3}>Last 3 periods</option>
          <option value={6}>Last 6 periods</option>
          <option value={12}>Last 12 periods</option>
        </select>
      </div>

      <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.15)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
        <strong style={{ color: 'var(--theme-accent)' }}>What this shows:</strong> Items where actual usage consistently exceeded theoretical (recipe-based) usage across multiple closed periods.
        Unlike wastage — which is <em style={{ color: 'var(--theme-text1)' }}>logged</em> — shrinkage is <em style={{ color: 'var(--theme-red)' }}>unexplained</em>. Possible causes: theft, over-portioning, unlogged spillage, or data entry errors.
        Only items linked to recipes (with sales data) are analysed.
      </div>

      {summary && (
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 24 }}>
          <div className="stat-card">
            <div className="stat-label">Periods Analysed</div>
            <div className="stat-value">{periodsUsed}</div>
            <div className="stat-sub">closed periods</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">
              <Tip text="Items over-used in 67%+ of monitored periods — your highest-risk items." width={240}>Consistent Shrinkage</Tip>
            </div>
            <div className="stat-value" style={{ color: summary.consistent > 0 ? 'var(--theme-red)' : 'var(--theme-green)' }}>{summary.consistent}</div>
            <div className="stat-sub">items</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">
              <Tip text="Items with at least one period of unexplained over-use vs theoretical usage." width={220}>Any Shrinkage</Tip>
            </div>
            <div className="stat-value" style={{ color: summary.anyFlagged > 0 ? '#f97316' : 'var(--theme-green)' }}>{summary.anyFlagged}</div>
            <div className="stat-sub">of {summary.totalTracked} recipe-covered items</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">
              <Tip text="Total NPR value of unexplained loss across all periods analysed (qty × item rate)." width={240}>Total Loss Value</Tip>
            </div>
            <div className="stat-value" style={{ fontSize: 16, color: summary.totalLossVal > 0 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>
              {summary.totalLossVal > 0 ? fmt(summary.totalLossVal) : '—'}
            </div>
            <div className="stat-sub">across all analysed periods</div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="form-select" value={filterCat} onChange={e => setFilterCat(e.target.value)}>
          <option value="all">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <select className="form-select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="flagged">Flagged items only</option>
          <option value="consistent">Consistent only</option>
          <option value="all">All tracked items</option>
        </select>
        <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{filtered.length} items</span>
      </div>

      <div className="card">
        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Analysing {periodCount} closed periods…</p>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">✓</div>
            <p className="empty-state-text">
              {filterStatus !== 'all'
                ? 'No items match this filter — try "All tracked items" to see the full list.'
                : 'No recipe-covered items found in closed periods. Close a period and add sales entries to enable shrinkage analysis.'}
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th>UOM</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Number of closed periods where this item was over-used vs theoretical recipe usage." width={240}>Shrinkage Count</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Number of periods where this item had recipe coverage (sales + recipe data)." width={230}>Periods Tracked</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Average unexplained over-usage per period it occurred, in base UOM." width={220}>Avg Qty / Period</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Total unexplained loss value across all periods (qty × item rate per UOM)." width={240}>Total Loss (NPR)</Tip>
                  </th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(row => (
                  <tr key={row.item.id} style={{ background: row.status.label === 'Consistent' ? 'rgba(248,113,113,0.03)' : 'transparent' }}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{row.item.name}</td>
                    <td><span className="badge badge-yellow">{row.category}</span></td>
                    <td style={{ color: 'var(--theme-text2)' }}>{row.item.uom}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: row.shrinkCount > 0 ? row.status.color : 'var(--theme-text2)' }}>
                      {row.shrinkCount > 0 ? row.shrinkCount : '—'}
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{row.coveredPeriods}</td>
                    <td style={{ textAlign: 'right', color: row.shrinkCount > 0 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>
                      {row.avgShrinkQty > 0 ? Number(row.avgShrinkQty.toFixed(3)).toLocaleString() : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: row.totalShrinkValue > 0 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>
                      {row.totalShrinkValue > 0 ? fmt(row.totalShrinkValue) : '—'}
                    </td>
                    <td>
                      <span style={{
                        fontSize: 11, fontWeight: 700, color: row.status.color,
                        background: row.status.bg, border: `1px solid ${row.status.color}40`,
                        borderRadius: 4, padding: '2px 8px'
                      }}>
                        {row.status.label}
                      </span>
                    </td>
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
