import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import * as XLSX from 'xlsx'
import Tip from '../components/Tip'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

export default function ReorderReport() {
  const { clientId, profile, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id

  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [rows, setRows] = useState([])
  const [parLevels, setParLevels] = useState({})
  const [editingPar, setEditingPar] = useState({})
  const [savingPar, setSavingPar] = useState({})
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [filterCat, setFilterCat] = useState('all')
  const [filterStatus, setFilterStatus] = useState('reorder')
  const [search, setSearch] = useState('')

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
      { data: items },
      { data: opening },
      { data: closing },
      { data: purchases },
      { data: returns },
      { data: wastages },
      { data: recipeIngs },
      { data: sales },
      { data: pars }
    ] = await Promise.all([
      supabase.from('items').select('*, categories(name)').eq('client_id', effectiveClientId).eq('is_active', true).order('name'),
      supabase.from('opening_stock').select('item_id, qty').eq('period_id', periodId),
      supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', periodId),
      supabase.from('purchase_entries').select('item_id, qty').eq('period_id', periodId),
      supabase.from('vendor_returns').select('item_id, qty').eq('period_id', periodId),
      supabase.from('wastages').select('item_id, qty').eq('period_id', periodId),
      supabase.from('recipe_ingredients').select('recipe_id, item_id, qty_per_portion'),
      supabase.from('sales_entries').select('recipe_id, qty_sold').eq('period_id', periodId),
      supabase.from('par_levels').select('*').eq('client_id', effectiveClientId)
    ])

    const parMap = {}
    ;(pars || []).forEach(p => { parMap[p.item_id] = { id: p.id, par_qty: parseFloat(p.par_qty) || 0 } })
    setParLevels(parMap)

    const openMap  = {}; (opening  || []).forEach(r => { openMap[r.item_id]  = parseFloat(r.qty) || 0 })
    const closeMap = {}; (closing  || []).forEach(r => { closeMap[r.item_id] = parseFloat(r.physical_qty) || 0 })
    const wasteMap = {}; (wastages || []).forEach(r => { wasteMap[r.item_id] = (wasteMap[r.item_id] || 0) + (parseFloat(r.qty) || 0) })

    // PATCHED: net purchase map (purchases − returns)
    const purchMap = {}
    ;(purchases || []).forEach(r => { purchMap[r.item_id] = (purchMap[r.item_id] || 0) + (parseFloat(r.qty) || 0) })
    ;(returns   || []).forEach(r => { purchMap[r.item_id] = (purchMap[r.item_id] || 0) - (parseFloat(r.qty) || 0) })

    const soldMap = {}; (sales || []).forEach(s => { soldMap[s.recipe_id] = (soldMap[s.recipe_id] || 0) + (parseFloat(s.qty_sold) || 0) })
    const usageMap = {}
    ;(recipeIngs || []).forEach(ri => {
      const sold = soldMap[ri.recipe_id] || 0
      if (sold > 0 && ri.item_id) usageMap[ri.item_id] = (usageMap[ri.item_id] || 0) + sold * parseFloat(ri.qty_per_portion)
    })

    const built = (items || []).map(item => {
      const openQty  = openMap[item.id] || 0
      const netPurch = purchMap[item.id] || 0
      const wasteQty = wasteMap[item.id] || 0
      const usageQty = usageMap[item.id] || 0
      const hasClosing = item.id in closeMap
      // PATCHED: theoretical stock uses net purchase
      const currentStock = hasClosing
        ? closeMap[item.id]
        : Math.max(0, openQty + netPurch - wasteQty - usageQty)
      const par = parMap[item.id]?.par_qty || 0
      const shortfall = Math.max(0, par - currentStock)
      const needsReorder = par > 0 && currentStock <= par

      return {
        item, openQty, purchQty: netPurch, wasteQty, usageQty,
        currentStock, stockSource: hasClosing ? 'closing' : 'theoretical',
        par, shortfall, needsReorder,
        category: item.categories?.name || 'Uncategorised',
        unitValue: parseFloat(item.per_uom_rate) || 0,
        shortfallValue: shortfall * (parseFloat(item.per_uom_rate) || 0)
      }
    })

    setRows(built)
  }

  function startEditPar(itemId, current) {
    setEditingPar(p => ({ ...p, [itemId]: String(current || '') }))
  }

  async function savePar(itemId) {
    const val = parseFloat(editingPar[itemId])
    if (isNaN(val) || val < 0) {
      setEditingPar(p => { const n = { ...p }; delete n[itemId]; return n })
      return
    }
    setSavingPar(p => ({ ...p, [itemId]: true }))
    const existing = parLevels[itemId]
    if (existing) {
      await supabase.from('par_levels').update({ par_qty: val, updated_at: new Date().toISOString() }).eq('id', existing.id)
    } else {
      await supabase.from('par_levels').insert({ client_id: effectiveClientId, item_id: itemId, par_qty: val })
    }
    setParLevels(p => ({ ...p, [itemId]: { ...(p[itemId] || {}), par_qty: val } }))
    setRows(r => r.map(row => {
      if (row.item.id !== itemId) return row
      const shortfall = Math.max(0, val - row.currentStock)
      return { ...row, par: val, shortfall, needsReorder: val > 0 && row.currentStock <= val, shortfallValue: shortfall * row.unitValue }
    }))
    setEditingPar(p => { const n = { ...p }; delete n[itemId]; return n })
    setSavingPar(p => { const n = { ...p }; delete n[itemId]; return n })
  }

  function handleParKey(e, itemId) {
    if (e.key === 'Enter') savePar(itemId)
    if (e.key === 'Escape') setEditingPar(p => { const n = { ...p }; delete n[itemId]; return n })
  }

  const filtered = rows.filter(r => {
    const matchCat    = filterCat === 'all' || r.category === filterCat
    const matchStatus = filterStatus === 'all' || r.needsReorder
    const matchSearch = r.item.name.toLowerCase().includes(search.toLowerCase())
    return matchCat && matchStatus && matchSearch
  })

  const reorderCount        = rows.filter(r => r.needsReorder).length
  const totalShortfallValue = rows.filter(r => r.needsReorder).reduce((s, r) => s + r.shortfallValue, 0)
  const noPar               = rows.filter(r => r.par === 0).length

  function exportExcel() {
    const data = filtered.map(r => ({
      'Item': r.item.name,
      'Code': r.item.item_code || '',
      'Category': r.category,
      'UOM': r.item.uom,
      'Par Level': r.par || '',
      'Current Stock': parseFloat(r.currentStock.toFixed(3)),
      'Stock Source': r.stockSource === 'closing' ? 'Physical Count' : 'Theoretical (Net Purchases)',
      'Shortfall': r.shortfall > 0 ? parseFloat(r.shortfall.toFixed(3)) : '',
      'Unit Rate (NPR)': r.unitValue,
      'Shortfall Value (NPR)': r.shortfall > 0 ? parseFloat(r.shortfallValue.toFixed(0)) : '',
      'Status': r.needsReorder ? 'REORDER' : r.par === 0 ? 'No Par Set' : 'OK'
    }))
    const ws = XLSX.utils.json_to_sheet(data)
    ws['!cols'] = [22,10,18,8,10,14,24,10,14,18,10].map(w => ({ wch: w }))
    const wb = XLSX.utils.book_new()
    const period = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : 'Report'
    XLSX.utils.book_append_sheet(wb, ws, 'Reorder Report')
    XLSX.writeFile(wb, `Reorder_Report_${period.replace(' ', '_')}.xlsx`)
  }

  async function resetAllPar() {
    if (!window.confirm('Reset ALL par levels to 0? This cannot be undone.')) return
    await supabase.from('par_levels').delete().eq('client_id', effectiveClientId)
    setParLevels({})
    setRows(r => r.map(row => ({ ...row, par: 0, shortfall: 0, needsReorder: false, shortfallValue: 0 })))
  }

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'
  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Reorder Report</h1>
          <p className="page-subtitle">Items below par level — auto purchase list — {periodLabel}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-ghost" onClick={exportExcel} style={{ fontSize: 12 }}>↓ Export Excel</button>
          <select className="form-select" value={selectedPeriod?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : '(closed)'}</option>)}
          </select>
        </div>
      </div>

      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-label">Items to Reorder</div>
          <div className="stat-value" style={{ color: reorderCount > 0 ? '#f87171' : '#34d399' }}>{reorderCount}</div>
          <div className="stat-sub">at or below par level</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Reorder Value</div>
          <div className="stat-value gold" style={{ fontSize: 18 }}>NPR {totalShortfallValue.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</div>
          <div className="stat-sub">estimated purchase needed</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Items Tracked</div>
          <div className="stat-value">{rows.length}</div>
          <div className="stat-sub">{noPar} without par level set</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Period</div>
          <div className="stat-value" style={{ fontSize: 16, color: '#c9a84c' }}>{periodLabel}</div>
          <div className="stat-sub">{selectedPeriod?.status === 'open' ? 'Open period' : 'Closed period'}</div>
        </div>
      </div>

      {noPar > 0 && (
        <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.15)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: '#6b7280' }}>
          <strong style={{ color: '#c9a84c' }}>Tip:</strong> {noPar} item{noPar !== 1 ? 's have' : ' has'} no par level set. Click the par field in any row to set it inline — press Enter to save.
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none', width: 200 }}
          placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)} />
        <select className="form-select" value={filterCat} onChange={e => setFilterCat(e.target.value)}>
          <option value="all">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <select className="form-select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="reorder">Reorder Only</option>
          <option value="all">All Items</option>
        </select>
        <span style={{ fontSize: 13, color: '#6b7280' }}>{filtered.length} item{filtered.length !== 1 ? 's' : ''}</span>
        <button
          className="btn btn-ghost"
          onClick={resetAllPar}
          style={{ fontSize: 12, color: '#f87171', borderColor: 'rgba(248,113,113,0.3)', marginLeft: 'auto' }}
        >
          ✕ Clear All Par
        </button>
      </div>

      <div className="card">
        {loading ? (
          <p style={{ color: '#6b7280', fontSize: 13 }}>Building report…</p>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">✓</div>
            <p className="empty-state-text">
              {filterStatus === 'reorder' && reorderCount === 0 ? 'All items are above par level. Stock is healthy.' : 'No items match your filters.'}
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th><th>Category</th><th>UOM</th>
                  <th style={{ textAlign: 'right' }}><Tip text="Minimum stock you want on hand at all times. Set this per item — when stock falls to or below par, a reorder is triggered." width={240}>Par Level</Tip></th>
                  <th style={{ textAlign: 'right' }}>Current Stock</th>
                  <th><Tip text="Physical = based on your closing count entry. Calc'd = estimated from Opening + Net Purchases − Usage − Wastage (less reliable)." width={250}>Source</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Par Level − Current Stock. The quantity you need to order to get back to par." width={210}>Shortfall</Tip></th>
                  <th style={{ textAlign: 'right' }}>Est. Value (NPR)</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered
                  .sort((a, b) => { if (a.needsReorder !== b.needsReorder) return a.needsReorder ? -1 : 1; return b.shortfallValue - a.shortfallValue })
                  .map(row => {
                    const isEditing = row.item.id in editingPar
                    const isSaving  = savingPar[row.item.id]
                    return (
                      <tr key={row.item.id} style={{ background: row.needsReorder ? 'rgba(248,113,113,0.03)' : 'transparent' }}>
                        <td>
                          <div style={{ fontWeight: 600, color: '#e8e0d0' }}>{row.item.name}</div>
                          {row.item.item_code && <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>{row.item.item_code}</div>}
                        </td>
                        <td><span className="badge badge-yellow">{row.category}</span></td>
                        <td style={{ color: '#6b7280' }}>{row.item.uom}</td>
                        <td style={{ textAlign: 'right' }}>
                          {isEditing ? (
                            <input type="number" min="0" step="0.001"
                              value={editingPar[row.item.id]}
                              onChange={e => setEditingPar(p => ({ ...p, [row.item.id]: e.target.value }))}
                              onBlur={() => savePar(row.item.id)}
                              onKeyDown={e => handleParKey(e, row.item.id)}
                              autoFocus
                              style={{ width: 80, textAlign: 'right', background: '#0f1117', border: '1px solid #c9a84c', borderRadius: 4, padding: '4px 8px', fontSize: 13, color: '#e8e0d0', outline: 'none' }}
                            />
                          ) : (
                            <Tip text="Click to set the par level — minimum stock quantity before reorder is triggered." width={230}>
                              <span onClick={() => startEditPar(row.item.id, row.par)}
                                style={{ cursor: 'pointer', color: row.par > 0 ? '#e8e0d0' : '#9ca3af', borderBottom: '1px dashed #3d4251', paddingBottom: 1, fontWeight: row.par > 0 ? 600 : 400 }}>
                                {isSaving ? '…' : row.par > 0 ? row.par.toLocaleString() : 'Set par'}
                              </span>
                            </Tip>
                          )}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: row.needsReorder ? '#f87171' : '#34d399' }}>
                          {row.currentStock.toFixed(2)}
                        </td>
                        <td>
                          <Tip text={row.stockSource === 'closing' ? 'Physical closing count entered via stock count.' : 'Calculated: Opening + Net Purchases − Usage − Wastage'} width={240}>
                            <span className={`badge ${row.stockSource === 'closing' ? 'badge-green' : 'badge-gray'}`}>
                              {row.stockSource === 'closing' ? 'Physical' : "Calc'd"}
                            </span>
                          </Tip>
                        </td>
                        <td style={{ textAlign: 'right', color: row.shortfall > 0 ? '#f87171' : '#6b7280', fontWeight: row.shortfall > 0 ? 700 : 400 }}>
                          {row.shortfall > 0 ? row.shortfall.toFixed(2) : '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: row.shortfallValue > 0 ? '#f87171' : '#6b7280', fontWeight: row.shortfallValue > 0 ? 600 : 400 }}>
                          {row.shortfallValue > 0 ? row.shortfallValue.toLocaleString('en-NP', { maximumFractionDigits: 0 }) : '—'}
                        </td>
                        <td>
                          {row.par === 0
                            ? <span className="badge badge-gray">No Par</span>
                            : row.needsReorder
                              ? <span className="badge badge-red">Reorder</span>
                              : <span className="badge badge-green">OK</span>}
                        </td>
                      </tr>
                    )
                  })}
              </tbody>
              {reorderCount > 0 && filterStatus === 'reorder' && (
                <tfoot>
                  <tr style={{ borderTop: '2px solid #2a2f3d' }}>
                    <td colSpan={7} style={{ fontWeight: 700, color: '#6b7280', paddingTop: 12 }}>Total estimated purchase needed</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#f87171', fontSize: 15, paddingTop: 12 }}>
                      NPR {totalShortfallValue.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
