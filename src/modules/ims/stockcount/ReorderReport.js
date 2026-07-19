import { useEffect, useState } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import * as XLSX from 'xlsx'
import Tip from '../../../components/Tip'
import { explodeRecipeIngredients } from '../../../utils/recipeCost'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

export default function ReorderReport() {
  const { clientId, profile, isAdmin, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const navigate = useNavigate()

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
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      scopedFrom('categories').order('sort_order')
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
      { data: sales },
      { data: pars },
      { data: movements }
    ] = await Promise.all([
      scopedFrom('items', '*, categories(name)').eq('is_active', true).eq('is_sub_recipe', false).order('name'),
      supabase.from('opening_stock').select('item_id, qty').eq('period_id', periodId),
      supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', periodId),
      supabase.from('purchase_entries').select('item_id, qty').eq('period_id', periodId),
      scopedFrom('vendor_returns', 'item_id, qty').eq('period_id', periodId),
      supabase.from('wastages').select('item_id, qty').eq('period_id', periodId),
      supabase.from('sales_entries').select('recipe_id, qty_sold').eq('period_id', periodId),
      scopedFrom('par_levels'),
      scopedFrom('stock_movements', 'item_id, qty').eq('period_id', periodId)
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

    const movementMap = {}
    ;(movements || []).forEach(m => { movementMap[m.item_id] = (movementMap[m.item_id] || 0) + (parseFloat(m.qty) || 0) })

    const soldMap = {}; (sales || []).forEach(s => { soldMap[s.recipe_id] = (soldMap[s.recipe_id] || 0) + (parseFloat(s.qty_sold) || 0) })
    const soldRecipeIds = Object.keys(soldMap).filter(id => soldMap[id] > 0)
    const breakdown = await explodeRecipeIngredients(supabase, soldRecipeIds)
    const usageMap = {}
    soldRecipeIds.forEach(recipeId => {
      (breakdown[recipeId] || []).forEach(({ item_id, qty }) => {
        usageMap[item_id] = (usageMap[item_id] || 0) + qty * soldMap[recipeId]
      })
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
      const hasMovements = item.id in movementMap
      const bookStock = hasMovements ? Math.max(0, openQty + netPurch - wasteQty + movementMap[item.id]) : null

      return {
        item, openQty, purchQty: netPurch, wasteQty, usageQty,
        currentStock, stockSource: hasClosing ? 'closing' : 'theoretical',
        bookStock, hasMovements,
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
    if (!effectiveClientId) return // never insert par_levels with a null client_id
    const val = parseFloat(editingPar[itemId])
    if (isNaN(val) || val < 0) {
      setEditingPar(p => { const n = { ...p }; delete n[itemId]; return n })
      return
    }
    setSavingPar(p => ({ ...p, [itemId]: true }))
    const existing = parLevels[itemId]
    if (existing) {
      await scopedUpdate('par_levels', { par_qty: val, updated_at: new Date().toISOString() }).eq('id', existing.id)
    } else {
      await scopedInsert('par_levels', { item_id: itemId, par_qty: val })
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
      'Book Stock (POS)': r.hasMovements ? parseFloat(r.bookStock.toFixed(3)) : '',
      'Stock Source': r.stockSource === 'closing' ? 'Physical Count' : 'Theoretical (Net Purchases)',
      'Shortfall': r.shortfall > 0 ? parseFloat(r.shortfall.toFixed(3)) : '',
      'Unit Rate (NPR)': r.unitValue,
      'Shortfall Value (NPR)': r.shortfall > 0 ? parseFloat(r.shortfallValue.toFixed(0)) : '',
      'Status': r.needsReorder ? 'REORDER' : r.par === 0 ? 'No Par Set' : 'OK'
    }))
    const ws = XLSX.utils.json_to_sheet(data)
    ws['!cols'] = [22,10,18,8,10,14,14,24,10,14,18,10].map(w => ({ wch: w }))
    const wb = XLSX.utils.book_new()
    const period = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : 'Report'
    XLSX.utils.book_append_sheet(wb, ws, 'Reorder Report')
    XLSX.writeFile(wb, `Reorder_Report_${period.replace(' ', '_')}.xlsx`)
  }

  async function resetAllPar() {
    if (!window.confirm('Reset ALL par levels to 0? This cannot be undone.')) return
    await scopedDelete('par_levels')
    setParLevels({})
    setRows(r => r.map(row => ({ ...row, par: 0, shortfall: 0, needsReorder: false, shortfallValue: 0 })))
  }

  async function clearBookStock() {
    if (!selectedPeriod) return
    if (!window.confirm(`Delete all stock_movements ledger rows for ${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}? Book Stock resets to "—" for every item in this period. Physical counts and Current Stock are unaffected. Cannot be undone.`)) return
    await scopedDelete('stock_movements').eq('period_id', selectedPeriod.id)
    setRows(r => r.map(row => ({ ...row, bookStock: null, hasMovements: false })))
  }

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />

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
          <div className="stat-value" style={{ color: reorderCount > 0 ? 'var(--theme-red)' : 'var(--theme-green)' }}>{reorderCount}</div>
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
          <div className="stat-value" style={{ fontSize: 16, color: 'var(--theme-accent)' }}>{periodLabel}</div>
          <div className="stat-sub">{selectedPeriod?.status === 'open' ? 'Open period' : 'Closed period'}</div>
        </div>
      </div>

      {noPar > 0 && (
        <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.15)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-text2)' }}>
          <strong style={{ color: 'var(--theme-accent)' }}>Tip:</strong> {noPar} item{noPar !== 1 ? 's have' : ' has'} no par level set. Click the par field in any row to set it inline — press Enter to save.
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 200 }}
          placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)} />
        <select className="form-select" value={filterCat} onChange={e => setFilterCat(e.target.value)}>
          <option value="all">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <select className="form-select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="reorder">Reorder Only</option>
          <option value="all">All Items</option>
        </select>
        <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{filtered.length} item{filtered.length !== 1 ? 's' : ''}</span>
        <button
          className="btn btn-ghost"
          onClick={resetAllPar}
          style={{ fontSize: 12, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.3)', marginLeft: 'auto' }}
        >
          ✕ Clear All Par
        </button>
        {isAdmin && (
          <Tip text="Deletes every stock_movements ledger row for the selected period — resets the Book Stock column back to '—'. Does not touch physical stock counts or Current Stock. Admin only.">
            <button
              className="btn btn-ghost"
              onClick={clearBookStock}
              style={{ fontSize: 12, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.3)' }}
            >
              ✕ Clear Book Stock
            </button>
          </Tip>
        )}
      </div>

      <div className="card">
        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Building report…</p>
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
                  <th style={{ textAlign: 'right' }}><Tip text="Live stock based on POS sales/comps recorded this period. Shown only for items sold through POS — '—' means no POS activity yet, not zero usage." width={260}>Book Stock</Tip></th>
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
                          <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{row.item.name}</div>
                          {row.item.item_code && <div style={{ fontSize: 11, color: 'var(--theme-text3)', fontFamily: 'monospace' }}>{row.item.item_code}</div>}
                        </td>
                        <td><span className="badge badge-yellow">{row.category}</span></td>
                        <td style={{ color: 'var(--theme-text2)' }}>{row.item.uom}</td>
                        <td style={{ textAlign: 'right' }}>
                          {isEditing ? (
                            <input type="number" min="0" step="0.001"
                              value={editingPar[row.item.id]}
                              onChange={e => setEditingPar(p => ({ ...p, [row.item.id]: e.target.value }))}
                              onBlur={() => savePar(row.item.id)}
                              onKeyDown={e => handleParKey(e, row.item.id)}
                              autoFocus
                              style={{ width: 80, textAlign: 'right', background: 'var(--theme-bg)', border: '1px solid var(--theme-accent)', borderRadius: 4, padding: '4px 8px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none' }}
                            />
                          ) : (
                            <Tip text="Click to set the par level — minimum stock quantity before reorder is triggered." width={230}>
                              <span onClick={() => startEditPar(row.item.id, row.par)}
                                style={{ cursor: 'pointer', color: row.par > 0 ? 'var(--theme-text1)' : 'var(--theme-text3)', borderBottom: '1px dashed var(--theme-border)', paddingBottom: 1, fontWeight: row.par > 0 ? 600 : 400 }}>
                                {isSaving ? '…' : row.par > 0 ? row.par.toLocaleString() : 'Set par'}
                              </span>
                            </Tip>
                          )}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: row.needsReorder ? 'var(--theme-red)' : 'var(--theme-green)' }}>
                          {row.currentStock.toFixed(2)}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                          {row.hasMovements ? (
                            <Tip text="Click to see every stock-depletion entry behind this number, with the POS order that caused each one." width={260}>
                              <span
                                onClick={() => navigate(`/stock-movements?item=${row.item.id}&period=${selectedPeriod.id}`)}
                                role="button" tabIndex={0} className="interactive-card"
                                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/stock-movements?item=${row.item.id}&period=${selectedPeriod.id}`) } }}
                                style={{ cursor: 'pointer', borderBottom: '1px dashed var(--theme-border)', paddingBottom: 1 }}
                              >
                                {row.bookStock.toFixed(2)}
                              </span>
                            </Tip>
                          ) : '—'}
                        </td>
                        <td>
                          <Tip text={row.stockSource === 'closing' ? 'Physical closing count entered via stock count.' : 'Calculated: Opening + Net Purchases − Usage − Wastage'} width={240}>
                            <span className={`badge ${row.stockSource === 'closing' ? 'badge-green' : 'badge-gray'}`}>
                              {row.stockSource === 'closing' ? 'Physical' : "Calc'd"}
                            </span>
                          </Tip>
                        </td>
                        <td style={{ textAlign: 'right', color: row.shortfall > 0 ? 'var(--theme-red)' : 'var(--theme-text2)', fontWeight: row.shortfall > 0 ? 700 : 400 }}>
                          {row.shortfall > 0 ? row.shortfall.toFixed(2) : '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: row.shortfallValue > 0 ? 'var(--theme-red)' : 'var(--theme-text2)', fontWeight: row.shortfallValue > 0 ? 600 : 400 }}>
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
                  <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                    <td colSpan={8} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>Total estimated purchase needed</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red)', fontSize: 15, paddingTop: 12 }}>
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
