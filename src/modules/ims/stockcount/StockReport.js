import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import * as XLSX from 'xlsx'
import Tip from '../../../components/Tip'
import { printWithTitle } from '../../../utils/printTitle'
import { explodeRecipeIngredients } from '../../../utils/recipeCost'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']
const npr = n => Number(n || 0).toLocaleString('en-NP', { maximumFractionDigits: 0 })

export default function StockReport() {
  const { clientId, profile, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()

  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [rows, setRows] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [filterCat, setFilterCat] = useState('all')
  const [filterStatus, setFilterStatus] = useState('all')
  const [search, setSearch] = useState('')

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const [{ data: p }, { data: c }] = await Promise.all([
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      scopedFrom('categories').order('sort_order')
    ])
    setPeriods(p || [])
    setCategories(c || [])
    const open = (p || []).find(x => x.status === 'open') || (p || [])[0]
    if (open) { setSelectedPeriod(open); await loadReport(open.id) }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setLoading(true)
    await loadReport(periodId)
    setLoading(false)
  }

  async function loadReport(periodId) {
    const [
      { data: items }, { data: opening }, { data: closing }, { data: purchases },
      { data: returns }, { data: wastages }, { data: staffMeals }, { data: clientRecipes },
      { data: sales }, { data: pars }, { data: reqLines }
    ] = await Promise.all([
      scopedFrom('items', '*, categories(name)').eq('is_active', true).eq('is_sub_recipe', false).order('name'),
      supabase.from('opening_stock').select('item_id, qty').eq('period_id', periodId),
      supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', periodId),
      supabase.from('purchase_entries').select('item_id, qty').eq('period_id', periodId),
      scopedFrom('vendor_returns', 'item_id, qty').eq('period_id', periodId),
      supabase.from('wastages').select('item_id, qty').eq('period_id', periodId),
      supabase.from('staff_meals').select('item_id, qty').eq('period_id', periodId),
      scopedFrom('recipes', 'id'),
      supabase.from('sales_entries').select('recipe_id, qty_sold').eq('period_id', periodId),
      scopedFrom('par_levels', 'item_id, par_qty'),
      supabase.from('requisition_lines').select('item_id, qty_issued, requisitions!inner(period_id, status)').eq('requisitions.period_id', periodId).eq('requisitions.status', 'issued'),
    ])

    const recipeIds = (clientRecipes || []).map(r => r.id)
    // explodeRecipeIngredients recurses through sub-recipe ingredients and applies yield_pct —
    // the previous direct recipe_ingredients read only picked up rows with item_id set (dropping
    // sub-recipe ingredients) and never divided by yield_pct at all, understating usage and
    // overstating the computed on-hand qty for any item with trim/prep loss.
    const breakdown = recipeIds.length > 0 ? await explodeRecipeIngredients(supabase, recipeIds) : {}

    const openMap = {}; (opening || []).forEach(r => { openMap[r.item_id] = parseFloat(r.qty) || 0 })
    const closeMap = {}; (closing || []).forEach(r => { closeMap[r.item_id] = parseFloat(r.physical_qty) || 0 })
    const wasteMap = {}; (wastages || []).forEach(r => { wasteMap[r.item_id] = (wasteMap[r.item_id] || 0) + (parseFloat(r.qty) || 0) })
    const staffMap = {}; (staffMeals || []).forEach(r => { staffMap[r.item_id] = (staffMap[r.item_id] || 0) + (parseFloat(r.qty) || 0) })
    const parMap = {}; (pars || []).forEach(r => { parMap[r.item_id] = parseFloat(r.par_qty) || 0 })
    const reqMap = {}; (reqLines || []).forEach(r => { reqMap[r.item_id] = (reqMap[r.item_id] || 0) + (parseFloat(r.qty_issued) || 0) })

    // Net purchases (purchases − returns)
    const purchMap = {}
    ;(purchases || []).forEach(r => { purchMap[r.item_id] = (purchMap[r.item_id] || 0) + (parseFloat(r.qty) || 0) })
    ;(returns   || []).forEach(r => { purchMap[r.item_id] = (purchMap[r.item_id] || 0) - (parseFloat(r.qty) || 0) })

    // Usage from sales × recipe. breakdown[recipeId] is already yield_pct-adjusted, per-one-
    // portion raw-ingredient qty (recursed through any sub-recipe nesting).
    const soldMap = {}; (sales || []).forEach(s => { soldMap[s.recipe_id] = (soldMap[s.recipe_id] || 0) + (parseFloat(s.qty_sold) || 0) })
    const usageMap = {}
    Object.entries(breakdown).forEach(([recipeId, rows]) => {
      const sold = soldMap[recipeId] || 0
      if (sold <= 0) return
      rows.forEach(({ item_id, qty }) => { usageMap[item_id] = (usageMap[item_id] || 0) + sold * qty })
    })

    const built = (items || []).map(item => {
      const openQty   = openMap[item.id] || 0
      const netPurch  = purchMap[item.id] || 0
      const wasteQty  = wasteMap[item.id] || 0
      const usageQty  = usageMap[item.id] || 0
      const staffQty  = staffMap[item.id] || 0
      const reqQty    = reqMap[item.id] || 0
      const hasClosing = item.id in closeMap
      const rawTheoretical = openQty + netPurch - usageQty - wasteQty - staffQty - reqQty
      const onHand    = hasClosing ? closeMap[item.id] : Math.max(0, rawTheoretical)
      const isNegative = !hasClosing && rawTheoretical < 0
      const par       = parMap[item.id] || 0
      const unitRate  = parseFloat(item.per_uom_rate) || 0
      const stockValue = onHand * unitRate

      let status
      if (onHand <= 0) status = 'out'
      else if (par > 0 && onHand <= par) status = 'low'
      else status = 'ok'

      return {
        item, category: item.categories?.name || 'Uncategorised',
        openQty, netPurch, usageQty, wasteQty, staffQty, reqQty,
        onHand, isNegative, par, unitRate, stockValue,
        stockSource: hasClosing ? 'closing' : 'theoretical', status,
      }
    })

    setRows(built)
  }

  const filtered = rows.filter(r => {
    const matchCat = filterCat === 'all' || r.category === filterCat
    const matchStatus = filterStatus === 'all' || r.status === filterStatus
    const s = search.toLowerCase()
    const matchSearch = r.item.name.toLowerCase().includes(s) || (r.item.item_code || '').toLowerCase().includes(s)
    return matchCat && matchStatus && matchSearch
  }).sort((a, b) => b.stockValue - a.stockValue)

  const totalValue   = rows.reduce((s, r) => s + r.stockValue, 0)
  const filteredValue = filtered.reduce((s, r) => s + r.stockValue, 0)
  const inStockCount = rows.filter(r => r.onHand > 0).length
  const lowCount     = rows.filter(r => r.status === 'low').length
  const outCount     = rows.filter(r => r.status === 'out').length
  const negativeCount = rows.filter(r => r.isNegative).length

  function exportExcel() {
    const data = filtered.map(r => ({
      'Item': r.item.name,
      'Code': r.item.item_code || '',
      'Category': r.category,
      'UOM': r.item.uom,
      'On-hand': parseFloat(r.onHand.toFixed(3)),
      'Source': r.stockSource === 'closing' ? 'Physical Count' : 'Theoretical',
      'Opening': parseFloat(r.openQty.toFixed(3)),
      'Purchased (net)': parseFloat(r.netPurch.toFixed(3)),
      'Used': parseFloat(r.usageQty.toFixed(3)),
      'Wastage': parseFloat(r.wasteQty.toFixed(3)),
      'Unit Rate (NPR)': r.unitRate,
      'Stock Value (NPR)': parseFloat(r.stockValue.toFixed(0)),
      'Status': r.status === 'out' ? 'OUT' : r.status === 'low' ? 'LOW' : 'OK',
    }))
    const ws = XLSX.utils.json_to_sheet(data)
    ws['!cols'] = [22,10,18,8,11,14,10,14,10,10,14,16,8].map(w => ({ wch: w }))
    const wb = XLSX.utils.book_new()
    const period = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : 'Report'
    XLSX.utils.book_append_sheet(wb, ws, 'Stock Report')
    XLSX.writeFile(wb, `Stock_Report_${period.replace(' ', '_')}.xlsx`)
  }

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'
  const statusBadge = (st) => st === 'out'
    ? <span className="badge badge-red">Out</span>
    : st === 'low' ? <span className="badge badge-yellow">Low</span> : <span className="badge badge-green">OK</span>

  return (
    <div>
      <div className="page-header no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Stock Report</h1>
          <p className="page-subtitle">Current inventory on hand & valuation — {periodLabel}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-ghost" onClick={() => printWithTitle(`Stock Report - ${periodLabel}`)} style={{ fontSize: 12 }}>🖶 Print</button>
          <button className="btn btn-ghost" onClick={exportExcel} style={{ fontSize: 12 }}>↓ Export Excel</button>
          <select className="form-select" value={selectedPeriod?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : '(closed)'}</option>)}
          </select>
        </div>
      </div>

      <div className="stat-grid no-print" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label"><Tip text="On-hand quantity × unit rate, summed across all items. What your current stock is worth." width={240}>Total Stock Value</Tip></div>
          <div className="stat-value gold" style={{ fontSize: 20 }}>NPR {npr(totalValue)}</div>
          <div className="stat-sub">{inStockCount} item{inStockCount !== 1 ? 's' : ''} in stock</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Low Stock</div>
          <div className="stat-value" style={{ color: lowCount > 0 ? 'var(--theme-accent)' : 'var(--theme-green)' }}>{lowCount}</div>
          <div className="stat-sub">at or below par level</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Out of Stock</div>
          <div className="stat-value" style={{ color: outCount > 0 ? 'var(--theme-red)' : 'var(--theme-green)' }}>{outCount}</div>
          <div className="stat-sub">zero on hand</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Items Tracked</div>
          <div className="stat-value">{rows.length}</div>
          <div className="stat-sub">{selectedPeriod?.status === 'open' ? 'Open period' : 'Closed period'}</div>
        </div>
      </div>

      {negativeCount > 0 && (
        <div className="no-print" style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-text2)' }}>
          <strong style={{ color: 'var(--theme-red)' }}>⚠ {negativeCount} item{negativeCount !== 1 ? 's show' : ' shows'} negative theoretical stock</strong> — usage/wastage exceeds recorded purchases + opening. Check for missing purchase entries or over-recorded usage. Shown as 0 on hand.
        </div>
      )}

      <div className="no-print" style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 200 }}
          placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)} />
        <select className="form-select" value={filterCat} onChange={e => setFilterCat(e.target.value)}>
          <option value="all">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <select className="form-select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="all">All Statuses</option>
          <option value="low">Low Stock</option>
          <option value="out">Out of Stock</option>
          <option value="ok">In Stock</option>
        </select>
        <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{filtered.length} item{filtered.length !== 1 ? 's' : ''} · NPR {npr(filteredValue)}</span>
      </div>

      <div className="card">
        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Building report…</p>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">◈</div>
            <p className="empty-state-text">No items match your filters.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th><th>Category</th><th>UOM</th>
                  <th style={{ textAlign: 'right' }}><Tip text="Closing physical count if entered for this period; otherwise estimated as Opening + Net Purchases − Usage − Wastage − Staff Meals − Requisitioned." width={280}>On-hand</Tip></th>
                  <th><Tip text="Physical = your closing count. Theoretical = calculated (less reliable until you do a stock count)." width={240}>Source</Tip></th>
                  <th style={{ textAlign: 'right' }}>Opening</th>
                  <th style={{ textAlign: 'right' }}>Purchased</th>
                  <th style={{ textAlign: 'right' }}>Used</th>
                  <th style={{ textAlign: 'right' }}>Wastage</th>
                  <th style={{ textAlign: 'right' }}>Rate</th>
                  <th style={{ textAlign: 'right' }}><Tip text="On-hand quantity × unit rate — the value of this item currently in stock." width={220}>Stock Value</Tip></th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.item.id} style={{ background: r.status === 'out' ? 'rgba(248,113,113,0.03)' : 'transparent' }}>
                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.item.name}</div>
                      {r.item.item_code && <div style={{ fontSize: 11, color: 'var(--theme-text3)', fontFamily: 'monospace' }}>{r.item.item_code}</div>}
                    </td>
                    <td><span className="badge badge-yellow">{r.category}</span></td>
                    <td style={{ color: 'var(--theme-text2)' }}>{r.item.uom}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: r.status === 'out' ? 'var(--theme-red)' : r.status === 'low' ? 'var(--theme-accent)' : 'var(--theme-text1)' }}>
                      {r.onHand.toFixed(2)}
                      {r.isNegative && <span title="Negative theoretical — data issue" style={{ color: 'var(--theme-red)', marginLeft: 4 }}>⚠</span>}
                    </td>
                    <td>
                      <span className={`badge ${r.stockSource === 'closing' ? 'badge-green' : 'badge-gray'}`}>
                        {r.stockSource === 'closing' ? 'Physical' : 'Theor.'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{r.openQty ? r.openQty.toFixed(1) : '—'}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{r.netPurch ? r.netPurch.toFixed(1) : '—'}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{r.usageQty ? r.usageQty.toFixed(1) : '—'}</td>
                    <td style={{ textAlign: 'right', color: r.wasteQty ? 'var(--theme-red)' : 'var(--theme-text2)' }}>{r.wasteQty ? r.wasteQty.toFixed(1) : '—'}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{r.unitRate.toFixed(2)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)' }}>{r.stockValue > 0 ? npr(r.stockValue) : '—'}</td>
                    <td>{statusBadge(r.status)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                  <td colSpan={10} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>Total stock value ({filtered.length} item{filtered.length !== 1 ? 's' : ''})</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)', fontSize: 15, paddingTop: 12 }}>NPR {npr(filteredValue)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
