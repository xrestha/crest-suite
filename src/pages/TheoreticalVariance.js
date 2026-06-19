import { useEffect, useState } from 'react'
import * as XLSX from 'xlsx'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import Tip from '../components/Tip'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

export default function TheoreticalVariance() {
  const { clientId, profile, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id

  const [periods,         setPeriods]         = useState([])
  const [selectedPeriod,  setSelectedPeriod]  = useState(null)
  const [items,           setItems]           = useState([])
  const [categories,      setCategories]      = useState([])
  const [recipes,         setRecipes]         = useState([])
  const [rows,            setRows]            = useState([])
  const [loading,         setLoading]         = useState(true)
  const [computing,       setComputing]       = useState(false)
  const [filterCat,       setFilterCat]       = useState('all')
  const [filterType,      setFilterType]      = useState('all') // all | over | under
  const [sortBy,          setSortBy]          = useState('variance_val')

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line

  async function init() {
    setLoading(true)
    const [{ data: p }, { data: i }, { data: c }, { data: r }, { data: ri }] = await Promise.all([
      supabase.from('monthly_periods').select('*').eq('client_id', effectiveClientId).order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      supabase.from('items').select('*, categories(name)').eq('client_id', effectiveClientId).eq('is_active', true),
      supabase.from('categories').select('*').eq('client_id', effectiveClientId).order('sort_order'),
      supabase.from('recipes').select('id, name, yield_qty').eq('client_id', effectiveClientId),
      supabase.from('recipe_ingredients').select('recipe_id, item_id, sub_recipe_id, qty_per_portion'),
    ])

    setPeriods(p || [])
    setItems(i || [])
    setCategories(c || [])

    // Attach ingredients to recipes
    const allRecipes = (r || []).map(recipe => ({
      ...recipe,
      recipe_ingredients: (ri || []).filter(x => x.recipe_id === recipe.id)
    }))
    // Attach sub_recipe object for expansion
    allRecipes.forEach(recipe => {
      recipe.recipe_ingredients.forEach(ing => {
        if (ing.sub_recipe_id) ing.sub_recipe = allRecipes.find(x => x.id === ing.sub_recipe_id) || null
      })
    })
    setRecipes(allRecipes)

    const open = (p || []).find(x => x.status === 'open')
    if (open) {
      setSelectedPeriod(open)
      await computeVariance(open.id, i || [], allRecipes)
    }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setComputing(true)
    await computeVariance(periodId, items, recipes)
    setComputing(false)
  }

  // Recursively expand a recipe's ingredients into raw { item_id, qty } pairs.
  // scale accounts for sub-recipe yield (qty used ÷ yield_qty of sub-recipe).
  // qty is as-purchased (gross), accounting for item yield_pct trim loss.
  function expandIngredients(recipe, allRecipes, itemList, scale = 1) {
    const result = []
    ;(recipe.recipe_ingredients || []).forEach(ri => {
      const qty = parseFloat(ri.qty_per_portion || 0) * scale
      if (ri.item_id) {
        const item = itemList.find(x => x.id === ri.item_id)
        const yieldFactor = (parseFloat(item?.yield_pct) || 100) / 100
        result.push({ item_id: ri.item_id, qty: qty / yieldFactor })
      } else if (ri.sub_recipe_id) {
        const sr = ri.sub_recipe || allRecipes.find(x => x.id === ri.sub_recipe_id)
        if (sr) {
          const yieldQty = parseFloat(sr.yield_qty) || 1
          result.push(...expandIngredients(sr, allRecipes, itemList, qty / yieldQty))
        }
      }
    })
    return result
  }

  async function computeVariance(periodId, itemList, allRecipes) {
    const [{ data: sales }, { data: opening }, { data: closing }, { data: purch }, { data: rets }, { data: wast }] = await Promise.all([
      supabase.from('sales_entries').select('recipe_id, qty_sold').eq('period_id', periodId),
      supabase.from('opening_stock').select('item_id, qty').eq('period_id', periodId),
      supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', periodId),
      supabase.from('purchase_entries').select('item_id, qty').eq('period_id', periodId),
      supabase.from('vendor_returns').select('item_id, qty').eq('period_id', periodId),
      supabase.from('wastages').select('item_id, qty').eq('period_id', periodId),
    ])

    // Sales map: recipe_id → total qty sold
    const salesMap = {}
    ;(sales || []).forEach(e => { salesMap[e.recipe_id] = (salesMap[e.recipe_id] || 0) + parseFloat(e.qty_sold || 0) })

    // Theoretical consumption: item_id → qty
    const theoretical = {}
    allRecipes.forEach(recipe => {
      const sold = salesMap[recipe.id] || 0
      if (sold <= 0) return
      expandIngredients(recipe, allRecipes, itemList).forEach(({ item_id, qty }) => {
        theoretical[item_id] = (theoretical[item_id] || 0) + qty * sold
      })
    })

    // Actual consumption maps
    const openMap = {}, closeMap = {}, purchMap = {}, retMap = {}, wastMap = {}
    ;(opening || []).forEach(r => { openMap[r.item_id]  = parseFloat(r.qty || 0) })
    ;(closing || []).forEach(r => { closeMap[r.item_id] = parseFloat(r.physical_qty || 0) })
    ;(purch   || []).forEach(r => { purchMap[r.item_id] = (purchMap[r.item_id] || 0) + parseFloat(r.qty || 0) })
    ;(rets    || []).forEach(r => { retMap[r.item_id]   = (retMap[r.item_id]   || 0) + parseFloat(r.qty || 0) })
    ;(wast    || []).forEach(r => { wastMap[r.item_id]  = (wastMap[r.item_id]  || 0) + parseFloat(r.qty || 0) })

    const computed = itemList
      .filter(item => (theoretical[item.id] || 0) > 0.001)
      .map(item => {
        const theor  = theoretical[item.id] || 0
        const actual = (openMap[item.id] || 0) + (purchMap[item.id] || 0) - (retMap[item.id] || 0) - (closeMap[item.id] || 0) - (wastMap[item.id] || 0)
        const variance    = actual - theor
        const variancePct = theor > 0 ? (variance / theor) * 100 : 0
        const rate        = parseFloat(item.per_uom_rate || 0)
        const varianceVal = variance * rate
        return { item, theor, actual, variance, variancePct, varianceVal, rate }
      })

    setRows(computed)
  }

  function filteredRows() {
    return rows
      .filter(r => {
        if (filterCat !== 'all' && r.item.category_id !== filterCat) return false
        if (filterType === 'over'  && r.variance <= 0.01)  return false
        if (filterType === 'under' && r.variance >= -0.01) return false
        return true
      })
      .sort((a, b) => {
        if (sortBy === 'variance_val')  return Math.abs(b.varianceVal)  - Math.abs(a.varianceVal)
        if (sortBy === 'variance_pct')  return Math.abs(b.variancePct)  - Math.abs(a.variancePct)
        if (sortBy === 'name')          return a.item.name.localeCompare(b.item.name)
        return 0
      })
  }

  function exportExcel() {
    const wb = XLSX.utils.book_new()
    const data = filteredRows().map(({ item, theor, actual, variance, variancePct, varianceVal }) => ({
      'Item':                item.name,
      'Category':            item.categories?.name || '',
      'UOM':                 item.uom,
      'Theoretical Qty':     +theor.toFixed(3),
      'Actual Qty':          +actual.toFixed(3),
      'Variance Qty':        +variance.toFixed(3),
      'Variance %':          +variancePct.toFixed(1),
      'Variance Value (NPR)': Math.round(varianceVal),
    }))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Theoretical Variance')
    XLSX.writeFile(wb, `Theoretical-Variance-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  const visible          = filteredRows()
  const totalTheorVal    = rows.reduce((s, r) => s + r.theor   * r.rate, 0)
  const totalActualVal   = rows.reduce((s, r) => s + r.actual  * r.rate, 0)
  const totalVarianceVal = rows.reduce((s, r) => s + r.varianceVal, 0)
  const overCount        = rows.filter(r => r.variance >  0.01).length
  const underCount       = rows.filter(r => r.variance < -0.01).length
  const noSales          = rows.length === 0 && !loading && !computing

  const periodLabel = selectedPeriod
    ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}`
    : '—'

  const fmtNPR  = v => `NPR ${Math.abs(Math.round(v)).toLocaleString('en-NP')}`
  const fmtQty  = v => v === 0 ? '—' : v.toLocaleString('en-NP', { maximumFractionDigits: 3 })
  const fmtPct  = v => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`

  function varianceColor(pct) {
    if (pct >  5) return '#f87171'  // red — over-consumed
    if (pct < -5) return '#fbbf24'  // amber — under-consumed (possible under-portioning)
    return '#34d399'                // green — within tolerance
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Theoretical vs Actual</h1>
          <p className="page-subtitle">
            Compare what should have been consumed (recipes × sales) against what was actually used — {periodLabel}
          </p>
        </div>
        <select
          style={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none' }}
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

      {/* Explanation banner */}
      <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: '#c9a84c' }}>
        <strong>How to read this:</strong> Theoretical = what your recipes say you should have used based on sales.
        Actual = opening + purchased − returned − wastage − closing. The gap reveals over-portioning, theft, or data entry errors.
        Red rows need investigation. Green = within ±5% tolerance.
      </div>

      {/* Stat cards */}
      {!loading && !computing && rows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 24 }}>
          {[
            { label: 'Theoretical Cost',  value: fmtNPR(totalTheorVal),    sub: 'Based on recipes × sales',      color: '#9ca3af' },
            { label: 'Actual Cost',        value: fmtNPR(totalActualVal),   sub: 'From stock movements',          color: '#e8e0d0' },
            { label: 'Total Variance',     value: fmtNPR(totalVarianceVal), sub: totalVarianceVal >= 0 ? 'Over-consumed' : 'Under-consumed', color: totalVarianceVal > 0 ? '#f87171' : '#34d399' },
            { label: 'Items Over-used',    value: overCount,                sub: `${underCount} under-consumed`,  color: overCount > 0 ? '#f87171' : '#34d399' },
          ].map(card => (
            <div key={card.label} className="card" style={{ padding: '16px 20px' }}>
              <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>{card.label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: card.color, marginBottom: 4 }}>{card.value}</div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>{card.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filters + export */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <select
            style={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, padding: '7px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none' }}
            value={filterCat} onChange={e => setFilterCat(e.target.value)}
          >
            <option value="all">All Categories</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>

          <div style={{ display: 'flex', background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, overflow: 'hidden' }}>
            {[['all', 'All'], ['over', '🔴 Over-consumed'], ['under', '🟡 Under-consumed']].map(([val, lbl]) => (
              <button key={val} onClick={() => setFilterType(val)} style={{
                background: filterType === val ? 'rgba(201,168,76,0.12)' : 'none',
                border: 'none', borderRight: '1px solid #2a2f3d', cursor: 'pointer',
                padding: '7px 14px', fontSize: 12, fontWeight: 600,
                color: filterType === val ? '#c9a84c' : '#6b7280',
              }}>{lbl}</button>
            ))}
          </div>

          <select
            style={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, padding: '7px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none' }}
            value={sortBy} onChange={e => setSortBy(e.target.value)}
          >
            <option value="variance_val">Sort: Variance Value ↓</option>
            <option value="variance_pct">Sort: Variance % ↓</option>
            <option value="name">Sort: Name A–Z</option>
          </select>
        </div>

        <button className="btn btn-ghost" onClick={exportExcel} disabled={rows.length === 0}>Export Excel</button>
      </div>

      {/* Table */}
      {loading || computing ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>
          {loading ? 'Loading…' : 'Computing variance…'}
        </div>
      ) : noSales ? (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
          <div style={{ color: '#e8e0d0', fontWeight: 600, marginBottom: 8 }}>No data for this period</div>
          <div style={{ color: '#6b7280', fontSize: 13 }}>
            This report requires both Sales entries and Recipes with ingredients.<br />
            Make sure sales are recorded and recipes have ingredients set up.
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th>UOM</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="What your recipes say should have been consumed based on qty sold × ingredient qty per portion." width={240}>Theoretical</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Opening + Purchased − Returned − Wastage − Closing. The actual stock consumed this period." width={240}>Actual</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Actual − Theoretical. Positive = over-consumed (waste/theft/over-portioning). Negative = under-consumed (under-portioning or missing sales data)." width={280}>Variance</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>Variance %</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Variance Qty × cost per UOM. Shows the NPR impact of the gap." width={220}>Value (NPR)</Tip>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map(({ item, theor, actual, variance, variancePct, varianceVal }) => {
                  const color = varianceColor(variancePct)
                  const isOver = variancePct > 5
                  return (
                    <tr key={item.id}>
                      <td style={{ fontWeight: 600, color: '#e8e0d0' }}>{item.name}</td>
                      <td><span className="badge badge-yellow">{item.categories?.name}</span></td>
                      <td style={{ color: '#6b7280' }}>{item.uom}</td>
                      <td style={{ textAlign: 'right', color: '#9ca3af' }}>{fmtQty(theor)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtQty(actual)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: color }}>
                        {variance === 0 ? '—' : `${variance > 0 ? '+' : ''}${variance.toLocaleString('en-NP', { maximumFractionDigits: 3 })}`}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: color }}>
                        {Math.abs(variancePct) < 0.1 ? '✓' : fmtPct(variancePct)}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: color }}>
                        {varianceVal === 0 ? '—' : (
                          <span>
                            {isOver ? '▲ ' : variancePct < -5 ? '▼ ' : ''}{fmtNPR(varianceVal)}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              {visible.length > 1 && (
                <tfoot>
                  <tr style={{ borderTop: '2px solid #2a2f3d' }}>
                    <td colSpan={3} style={{ fontWeight: 700, color: '#c9a84c' }}>
                      {visible.length} items shown
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#9ca3af' }}>
                      {fmtNPR(visible.reduce((s, r) => s + r.theor * r.rate, 0))}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>
                      {fmtNPR(visible.reduce((s, r) => s + r.actual * r.rate, 0))}
                    </td>
                    <td colSpan={2} />
                    <td style={{ textAlign: 'right', fontWeight: 700, color: visible.reduce((s, r) => s + r.varianceVal, 0) > 0 ? '#f87171' : '#34d399' }}>
                      {fmtNPR(visible.reduce((s, r) => s + r.varianceVal, 0))}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
