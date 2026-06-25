import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import { getSuggestedPrice } from '../utils/recipeCost'
import * as XLSX from 'xlsx'
import Tip from '../components/Tip'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

function fcColor(pct) {
  if (pct <= 30) return 'var(--theme-green)'
  if (pct <= 38) return 'var(--theme-amber)'
  return 'var(--theme-red)'
}

// vat_rate may be 0 (No VAT); null/undefined falls back to 13%.
function vatOf(r) {
  return (r.vat_rate === null || r.vat_rate === undefined) ? 0.13 : parseFloat(r.vat_rate)
}

export default function MenuRepricing() {
  const { clientId, profile } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const [periods, setPeriods]         = useState([])
  const [selectedPeriod, setSelected] = useState(null)
  const [rows, setRows]               = useState([])
  const [sortBy, setSortBy]           = useState('opportunity')
  const [catFilter, setCatFilter]     = useState('All')
  const [onlyUnderpriced, setOnlyUnderpriced] = useState(true)
  const [onlyWithSales, setOnlyWithSales]     = useState(false)
  const [loading, setLoading]         = useState(false)

  useEffect(() => {
    if (!effectiveClientId) return
    supabase.from('monthly_periods')
      .select('*').eq('client_id', effectiveClientId)
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .then(({ data }) => {
        setPeriods(data || [])
        if (data?.length) setSelected(data[0])
      })
  }, [effectiveClientId])

  useEffect(() => {
    if (selectedPeriod) fetchData(selectedPeriod.id)
  }, [selectedPeriod]) // eslint-disable-line

  async function fetchData(periodId) {
    setLoading(true)
    const [{ data: salesData }, { data: recipes }] = await Promise.all([
      supabase.from('sales_entries').select('recipe_id, qty_sold').eq('period_id', periodId),
      supabase.from('recipes')
        .select('id, name, category, selling_price, vat_rate, target_fc_pct')
        .eq('client_id', effectiveClientId)
        .neq('category', 'Sub-Recipe')
        .eq('is_active', true),
    ])

    const recipeIds = (recipes || []).map(r => r.id)
    const { data: ingredients } = recipeIds.length > 0
      ? await supabase.from('recipe_ingredients')
          .select('recipe_id, qty_per_portion, items(per_uom_rate)')
          .in('recipe_id', recipeIds)
      : { data: [] }

    const costMap = {}
    for (const ing of (ingredients || [])) {
      const c = parseFloat(ing.qty_per_portion || 0) * parseFloat(ing.items?.per_uom_rate || 0)
      costMap[ing.recipe_id] = (costMap[ing.recipe_id] || 0) + c
    }

    const qtyMap = {}
    for (const s of (salesData || [])) {
      qtyMap[s.recipe_id] = (qtyMap[s.recipe_id] || 0) + parseFloat(s.qty_sold || 0)
    }

    const built = (recipes || [])
      .filter(r => r.selling_price != null && parseFloat(r.selling_price) > 0)
      .map(r => {
        const price    = parseFloat(r.selling_price || 0)
        const cost     = parseFloat(costMap[r.id] || 0)
        const qty      = parseFloat(qtyMap[r.id] || 0)
        const targetPct = parseFloat(r.target_fc_pct) || 30
        const currentFcPct = price > 0 ? (cost / price) * 100 : 0
        // Ex-VAT price that would hit the target FC% (FC% is computed ex-VAT app-wide).
        const suggestedExVat = targetPct > 0 ? cost / (targetPct / 100) : 0
        const priceGap = Math.max(0, suggestedExVat - price)
        const vat = vatOf(r)
        return {
          id: r.id,
          name: r.name,
          category: r.category,
          price, cost, qty, targetPct, currentFcPct,
          priceGap,
          monthlyOpportunity: priceGap * qty,
          // VAT-inclusive, rounded — the number to print on the menu.
          suggestedMenuPrice: getSuggestedPrice(cost, vat, targetPct / 100),
          underpriced: currentFcPct > targetPct,
        }
      })

    setRows(built)
    setCatFilter('All')
    setLoading(false)
  }

  const underpricedRows = rows.filter(r => r.underpriced)
  const totalOpportunity = underpricedRows.reduce((s, r) => s + r.monthlyOpportunity, 0)
  const biggestLeak = [...underpricedRows].sort((a, b) =>
    (b.monthlyOpportunity - a.monthlyOpportunity) || (b.priceGap - a.priceGap))[0]
  const categories = ['All', ...Array.from(new Set(rows.map(r => r.category))).sort()]

  let display = rows
  if (onlyUnderpriced) display = display.filter(r => r.underpriced)
  if (onlyWithSales)   display = display.filter(r => r.qty > 0)
  if (catFilter !== 'All') display = display.filter(r => r.category === catFilter)
  if (sortBy === 'opportunity')   display = [...display].sort((a, b) => b.monthlyOpportunity - a.monthlyOpportunity)
  else if (sortBy === 'gap')      display = [...display].sort((a, b) => b.priceGap - a.priceGap)
  else if (sortBy === 'fc')       display = [...display].sort((a, b) => (b.currentFcPct - b.targetPct) - (a.currentFcPct - a.targetPct))

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
      '#':                          i + 1,
      'Recipe':                     r.name,
      'Category':                   r.category,
      'Qty Sold':                   r.qty || '',
      'Food Cost / Portion':        r.cost.toFixed(2),
      'Current Price (ex-VAT)':     r.price.toFixed(2),
      'Current FC%':                r.currentFcPct.toFixed(1) + '%',
      'Target FC%':                 r.targetPct.toFixed(0) + '%',
      'Suggested Menu Price (incl VAT)': r.suggestedMenuPrice.toFixed(0),
      'Price Gap (ex-VAT)':         r.priceGap.toFixed(2),
      'Monthly Opportunity (NPR)':  r.monthlyOpportunity ? r.monthlyOpportunity.toFixed(0) : '',
    }))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Menu Repricing')
    XLSX.writeFile(wb, `MenuRepricing-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  return (
    <div className="page-container">

      <div className="print-only" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Menu Repricing — {periodLabel}</h2>
      </div>

      <div className="no-print" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Menu Repricing</h1>
          <p className="page-subtitle">Dishes priced below their target food-cost % — and the price to charge to fix it</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="form-select" value={selectedPeriod?.id || ''} onChange={e => setSelected(periods.find(p => p.id === e.target.value))}>
            {periods.map(p => (
              <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year}</option>
            ))}
          </select>
          <button className="btn btn-ghost" onClick={() => window.print()}>Print</button>
          <button className="btn btn-ghost" onClick={exportExcel} disabled={!display.length}>Export Excel</button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="stat-grid no-print" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Number of priced dishes whose current food-cost % is above their target — i.e. priced too low to hit the margin you set." width={300}>Underpriced Dishes</Tip>
          </div>
          <div className="stat-value" style={{ color: underpricedRows.length ? 'var(--theme-red)' : 'var(--theme-green)' }}>
            {underpricedRows.length}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Sum of (Price Gap × Qty Sold) across all underpriced dishes this period. Extra margin you'd capture by repricing to target — ingredient cost is unchanged, so it drops straight to the bottom line." width={320}>Monthly Opportunity</Tip>
          </div>
          <div className="stat-value" style={{ color: totalOpportunity ? 'var(--theme-accent)' : 'var(--theme-green)' }}>{fmtNPR(totalOpportunity)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Biggest Leak</div>
          <div className="stat-value" style={{ fontSize: 15 }}>{biggestLeak ? biggestLeak.name : '—'}</div>
          {biggestLeak && <div className="stat-label" style={{ marginTop: 4 }}>{fmtNPR(biggestLeak.monthlyOpportunity || biggestLeak.priceGap)}{biggestLeak.monthlyOpportunity ? '/mo' : '/portion'}</div>}
        </div>
      </div>

      {/* Sort + filter bar */}
      <div className="no-print" style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ color: 'var(--theme-text2)', fontSize: 12 }}>Sort:</span>
        {[
          ['opportunity', 'Monthly Opportunity'],
          ['gap',         'Price Gap'],
          ['fc',          'Most over target'],
        ].map(([key, label]) => (
          <button key={key} className={`tab-btn${sortBy === key ? ' tab-btn--active' : ''}`} onClick={() => setSortBy(key)}>{label}</button>
        ))}
        <label style={{ marginLeft: 12, fontSize: 12, color: 'var(--theme-text2)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyUnderpriced} onChange={e => setOnlyUnderpriced(e.target.checked)} />
          Only underpriced
        </label>
        <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyWithSales} onChange={e => setOnlyWithSales(e.target.checked)} />
          Only with sales
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
          {onlyUnderpriced ? 'No underpriced dishes — every priced dish is at or below its target food cost. 🎉' : 'No priced recipes found for this period.'}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Recipe</th>
                <th>Category</th>
                <th style={{ textAlign: 'right' }}>Qty Sold</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Total ingredient cost per portion based on current item rates." width={240}>Food Cost / Portion</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Current selling price excluding VAT (as entered in Recipe Costing)." width={240}>Current Price</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Food Cost ÷ Current Price. How much of each sale goes to ingredients right now." width={260}>Current FC%</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="The food-cost % you set as the goal for this dish (Recipe Costing → Target FC%)." width={260}>Target FC%</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Price to charge to hit the target FC%, VAT-inclusive and rounded up to NPR 5 — the number to print on the menu." width={300}>Suggested Menu Price</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Suggested ex-VAT price − current ex-VAT price. How much you're under per portion." width={260}>Price Gap</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Price Gap × Qty Sold this period. Extra margin captured by repricing to target." width={280}>Monthly Opportunity</Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {display.map((r, i) => (
                <tr key={r.id} style={{ opacity: r.underpriced ? 1 : 0.5 }}>
                  <td style={{ color: 'var(--theme-text2)' }}>{i + 1}</td>
                  <td><strong>{r.name}</strong></td>
                  <td>{r.category}</td>
                  <td style={{ textAlign: 'right' }}>{r.qty ? Number(r.qty).toLocaleString() : '—'}</td>
                  <td style={{ textAlign: 'right' }}>NPR {r.cost.toFixed(2)}</td>
                  <td style={{ textAlign: 'right' }}>NPR {r.price.toFixed(0)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: fcColor(r.currentFcPct) }}>{r.currentFcPct.toFixed(1)}%</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{r.targetPct.toFixed(0)}%</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-green)' }}>NPR {r.suggestedMenuPrice.toFixed(0)}</td>
                  <td style={{ textAlign: 'right', color: r.priceGap > 0 ? 'var(--theme-amber)' : 'var(--theme-text2)' }}>
                    {r.priceGap > 0 ? `NPR ${r.priceGap.toFixed(2)}` : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: r.monthlyOpportunity > 0 ? 'var(--theme-accent)' : 'var(--theme-text2)' }}>
                    {r.monthlyOpportunity > 0 ? fmtNPR(r.monthlyOpportunity) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={10}>Total ({display.filter(r => r.underpriced).length} underpriced)</td>
                <td style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>
                  {fmtNPR(display.reduce((s, r) => s + r.monthlyOpportunity, 0))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
