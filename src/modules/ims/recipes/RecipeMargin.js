import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import * as XLSX from 'xlsx'
import Tip from '../../../components/Tip'
import { printWithTitle } from '../../../utils/printTitle'
import { computeRecipeCosts } from '../../../utils/recipeCost'
import { Navigate } from 'react-router-dom'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

function fcColor(pct) {
  if (pct <= 30) return 'var(--theme-green)'
  if (pct <= 38) return 'var(--theme-amber)'
  return 'var(--theme-red)'
}

export default function RecipeMargin() {
  const { clientId, profile, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const [periods, setPeriods]         = useState([])
  const [selectedPeriod, setSelected] = useState(null)
  const [rows, setRows]               = useState([])
  const [sortBy, setSortBy]           = useState('contribution')
  const [catFilter, setCatFilter]     = useState('All')
  const [onlyWithSales, setOnlyWithSales] = useState(true)
  const [loading, setLoading]         = useState(false)

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
    const [{ data: salesData }, { data: recipes }] = await Promise.all([
      // Margin is revenue-based — comps (source='pos_comp') never sold at menu price and would
      // understate the true margin percentage if counted as if they had.
      supabase.from('sales_entries').select('recipe_id, qty_sold').eq('period_id', periodId).neq('source', 'pos_comp'),
      scopedFrom('recipes', 'id, name, category, selling_price')
        .neq('category', 'Sub-Recipe')
        .eq('is_active', true),
    ])

    // computeRecipeCosts recurses through sub-recipe ingredients and applies yield_pct — a
    // hand-rolled costMap reading only direct item_id ingredients (as this used to) silently
    // costs any sub-recipe-based ingredient (sauces, batters, prepped components) at zero and
    // ignores trim/prep loss, understating food cost and margin for exactly those dishes.
    const recipeIds = (recipes || []).map(r => r.id)
    const costMap = await computeRecipeCosts(supabase, recipeIds)

    const qtyMap = {}
    for (const s of (salesData || [])) {
      qtyMap[s.recipe_id] = (qtyMap[s.recipe_id] || 0) + parseFloat(s.qty_sold || 0)
    }

    const built = (recipes || [])
      .filter(r => r.selling_price != null)
      .map(r => {
        const price  = parseFloat(r.selling_price || 0)
        const cost   = parseFloat(costMap[r.id] || 0)
        const margin = price - cost
        const qty    = parseFloat(qtyMap[r.id] || 0)
        const fcPct  = price > 0 ? (cost / price) * 100 : 0
        return {
          id: r.id,
          name: r.name,
          category: r.category,
          price, cost, margin, qty,
          totalContribution: margin * qty,
          fcPct,
        }
      })

    setRows(built)
    setCatFilter('All')
    setLoading(false)
  }

  const withSales       = rows.filter(r => r.qty > 0)
  const totalContrib    = withSales.reduce((s, r) => s + r.totalContribution, 0)
  const totalRevenue    = withSales.reduce((s, r) => s + r.price * r.qty, 0)
  const totalCost       = withSales.reduce((s, r) => s + r.cost * r.qty, 0)
  const avgFcPct        = totalRevenue > 0 ? (totalCost / totalRevenue) * 100 : 0
  const topRecipe       = [...withSales].sort((a, b) => b.totalContribution - a.totalContribution)[0]
  const categories      = ['All', ...Array.from(new Set(rows.map(r => r.category))).sort()]

  let display = onlyWithSales ? rows.filter(r => r.qty > 0) : rows
  if (catFilter !== 'All') display = display.filter(r => r.category === catFilter)
  if (sortBy === 'contribution') display = [...display].sort((a, b) => b.totalContribution - a.totalContribution)
  else if (sortBy === 'margin')  display = [...display].sort((a, b) => b.margin - a.margin)
  else if (sortBy === 'fc')      display = [...display].sort((a, b) => a.fcPct - b.fcPct)

  const periodLabel = selectedPeriod
    ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}`
    : ''

  function fmtNPR(n) {
    if (!n && n !== 0) return '—'
    return 'NPR ' + Number(n).toLocaleString('en-NP', { maximumFractionDigits: 0 })
  }

  function exportExcel() {
    const wb   = XLSX.utils.book_new()
    const data = display.map((r, i) => ({
      '#':                       i + 1,
      'Recipe':                  r.name,
      'Category':                r.category,
      'Selling Price (ex-VAT)':  r.price.toFixed(2),
      'Food Cost / Portion':     r.cost.toFixed(2),
      'Contribution / Portion':  r.margin.toFixed(2),
      'Qty Sold':                r.qty || '',
      'Total Contribution (NPR)':r.totalContribution ? r.totalContribution.toFixed(0) : '',
      'FC%':                     r.fcPct.toFixed(1) + '%',
    }))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Recipe Margin')
    XLSX.writeFile(wb, `RecipeMargin-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div className="page-container">

      <div className="print-only" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Recipe Contribution Margin — {periodLabel}</h2>
      </div>

      <div className="no-print" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Recipe Contribution Margin</h1>
          <p className="page-subtitle">(Selling Price − Food Cost) × Qty Sold — total NPR profit contribution per recipe</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="form-select" value={selectedPeriod?.id || ''} onChange={e => setSelected(periods.find(p => p.id === e.target.value))}>
            {periods.map(p => (
              <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year}</option>
            ))}
          </select>
          <button className="btn btn-ghost" onClick={() => printWithTitle(`Recipe Contribution Margin - ${periodLabel}`)}>Print</button>
          <button className="btn btn-ghost" onClick={exportExcel} disabled={!display.length}>Export Excel</button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="stat-grid no-print" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Sum of (Selling Price − Food Cost) × Qty Sold across all recipes with sales this period." width={280}>Total Contribution</Tip>
          </div>
          <div className="stat-value" style={{ color: 'var(--theme-green)' }}>{fmtNPR(totalContrib)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Weighted average FC% = Total Food Cost ÷ Total Revenue across all recipes sold this period." width={280}>Weighted Avg FC%</Tip>
          </div>
          <div className="stat-value" style={{ color: fcColor(avgFcPct) }}>
            {avgFcPct ? avgFcPct.toFixed(1) + '%' : '—'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Top Contributor</div>
          <div className="stat-value" style={{ fontSize: 15 }}>{topRecipe ? topRecipe.name : '—'}</div>
          {topRecipe && <div className="stat-label" style={{ marginTop: 4 }}>{fmtNPR(topRecipe.totalContribution)}</div>}
        </div>
      </div>

      {/* Sort + filter bar */}
      <div className="no-print" style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ color: 'var(--theme-text2)', fontSize: 12 }}>Sort:</span>
        {[
          ['contribution', 'Total Contribution'],
          ['margin',       'Margin / Portion'],
          ['fc',           'FC% (best first)'],
        ].map(([key, label]) => (
          <button key={key} className={`tab-btn${sortBy === key ? ' tab-btn--active' : ''}`} onClick={() => setSortBy(key)}>{label}</button>
        ))}
        <label style={{ marginLeft: 12, fontSize: 12, color: 'var(--theme-text2)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyWithSales} onChange={e => setOnlyWithSales(e.target.checked)} />
          Only recipes with sales
        </label>
      </div>

      {categories.length > 2 && (
        <div className="tab-bar no-print" style={{ marginBottom: 16 }}>
          {categories.map(c => (
            <button key={c} className={`tab-btn${catFilter === c ? ' tab-btn--active' : ''}`} onClick={() => setCatFilter(c)}>{c}</button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="loading-state">Loading...</div>
      ) : display.length === 0 ? (
        <div className="empty-state">
          No recipes found.{onlyWithSales ? ' Try unchecking "Only recipes with sales".' : ''}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Recipe</th>
                <th>Category</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Selling price excluding VAT (as entered in Recipe Costing)." width={220}>Selling Price</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Total ingredient cost per portion based on current item rates." width={240}>Food Cost / Portion</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Selling Price − Food Cost per portion. NPR margin earned on each sale." width={260}>Contribution / Portion</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>Qty Sold</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Contribution per Portion × Qty Sold. Total NPR profit this recipe generated this period." width={280}>Total Contribution</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>FC%</th>
              </tr>
            </thead>
            <tbody>
              {display.map((r, i) => (
                <tr key={r.id} style={{ opacity: r.qty === 0 ? 0.45 : 1 }}>
                  <td style={{ color: 'var(--theme-text2)' }}>{i + 1}</td>
                  <td><strong>{r.name}</strong></td>
                  <td>{r.category}</td>
                  <td style={{ textAlign: 'right' }}>NPR {r.price.toFixed(0)}</td>
                  <td style={{ textAlign: 'right' }}>NPR {r.cost.toFixed(2)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: r.margin >= 0 ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                    NPR {r.margin.toFixed(2)}
                  </td>
                  <td style={{ textAlign: 'right' }}>{r.qty ? Number(r.qty).toLocaleString() : '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-accent)' }}>
                    {r.totalContribution ? fmtNPR(r.totalContribution) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: fcColor(r.fcPct) }}>
                    {r.fcPct.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={6}>Total ({withSales.length} recipes sold)</td>
                <td style={{ textAlign: 'right' }}>{withSales.reduce((s, r) => s + r.qty, 0).toLocaleString()}</td>
                <td style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>{fmtNPR(totalContrib)}</td>
                <td style={{ textAlign: 'right', color: fcColor(avgFcPct) }}>{avgFcPct.toFixed(1)}%</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
