import { useEffect, useState } from 'react'
import { useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import * as XLSX from 'xlsx'
import Tip from '../../../components/Tip'
import { viewPosBill } from '../../../utils/viewPosBill'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

export default function StockMovements() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const [searchParams] = useSearchParams()

  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [rows, setRows] = useState([])
  const [staffNames, setStaffNames] = useState({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterSource, setFilterSource] = useState('all')
  const [noBomRecipes, setNoBomRecipes] = useState([])

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const { data: p } = await scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
    setPeriods(p || [])

    // Arriving from Reorder Report's "Book Stock" link (?period=&item=) lands on that same
    // period instead of always defaulting to open — the item name pre-fills the search box
    // rather than adding a second, hidden filter mode alongside the visible one.
    const periodParam = searchParams.get('period')
    const itemParam = searchParams.get('item')
    const target = (p || []).find(x => x.id === periodParam) || (p || []).find(x => x.status === 'open')
    if (target) { setSelectedPeriod(target); await loadReport(target.id, itemParam) }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setLoading(true)
    await loadReport(periodId)
    setLoading(false)
  }

  async function loadReport(periodId, presetItemId) {
    const [{ data: movements }, { data: profs }, { data: soldEntries }] = await Promise.all([
      scopedFrom('stock_movements',
        'id, item_id, bs_day, qty, source, ref_id, created_at, ' +
        'items(name, uom, item_code, per_uom_rate, categories(name)), ' +
        'pos_orders(order_no, close_type, closed_by)'
      ).eq('period_id', periodId).order('created_at', { ascending: false }),
      supabase.rpc('get_client_profile_names', { p_client_id: effectiveClientId }),
      // sales_entries is period_id-scoped, not client_id-scoped — stays on raw supabase.from() (see scopedDb notes)
      supabase.from('sales_entries').select('recipe_id').eq('period_id', periodId).in('source', ['pos', 'pos_comp']),
    ])
    setStaffNames(Object.fromEntries((profs || []).map(s => [s.id, s.full_name])))

    // Cross-reference recipes actually sold this period against ones with zero recipe_ingredients
    // rows — explodeRecipeIngredients() (PosOrders.jsx) produces nothing to deplete for those, so
    // they were sold but never wrote a stock_movements row and would otherwise vanish silently.
    const soldRecipeIds = [...new Set((soldEntries || []).map(s => s.recipe_id).filter(Boolean))]
    if (soldRecipeIds.length > 0) {
      const [{ data: ingRows }, { data: recipeRows }] = await Promise.all([
        supabase.from('recipe_ingredients').select('recipe_id').in('recipe_id', soldRecipeIds),
        scopedFrom('recipes', 'id, name').in('id', soldRecipeIds),
      ])
      const withIngredients = new Set((ingRows || []).map(r => r.recipe_id))
      setNoBomRecipes((recipeRows || []).filter(r => !withIngredients.has(r.id)).map(r => r.name).sort())
    } else {
      setNoBomRecipes([])
    }

    const built = (movements || []).map(m => {
      const item = m.items || {}
      const order = m.pos_orders || null
      const qtyAbs = Math.abs(parseFloat(m.qty) || 0)
      const value = qtyAbs * (parseFloat(item.per_uom_rate) || 0)
      return {
        id: m.id, item_id: m.item_id, ref_id: m.ref_id, item, order, qtyAbs, value,
        source: m.source, bsDay: m.bs_day,
        category: item.categories?.name || 'Uncategorised',
      }
    })
    setRows(built)

    if (presetItemId) {
      const match = built.find(r => r.item_id === presetItemId)
      if (match) setSearch(match.item.name)
    }
  }

  const filtered = rows.filter(r => {
    const matchSource = filterSource === 'all' || r.source === filterSource
    const matchSearch = (r.item.name || '').toLowerCase().includes(search.toLowerCase())
    return matchSource && matchSearch
  })

  const totalValue = filtered.reduce((s, r) => s + r.value, 0)
  const compValue = filtered.filter(r => r.source === 'pos_comp').reduce((s, r) => s + r.value, 0)
  const itemsAffected = new Set(filtered.map(r => r.item?.name)).size

  function exportExcel() {
    const data = filtered.map(r => ({
      'Day': r.bsDay || '',
      'Item': r.item.name || '',
      'Category': r.category,
      'UOM': r.item.uom || '',
      'Qty Depleted': parseFloat(r.qtyAbs.toFixed(3)),
      'Source': r.source === 'pos_comp' ? 'POS Comp' : 'POS Sale',
      'Order #': r.order?.order_no || '',
      'Staff': (r.order && staffNames[r.order.closed_by]) || '',
      'Value (NPR)': parseFloat(r.value.toFixed(0)),
    }))
    const ws = XLSX.utils.json_to_sheet(data)
    ws['!cols'] = [6,22,18,8,12,10,10,18,12].map(w => ({ wch: w }))
    const wb = XLSX.utils.book_new()
    const period = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : 'Report'
    XLSX.utils.book_append_sheet(wb, ws, 'Stock Movements')
    XLSX.writeFile(wb, `Stock_Movements_${period.replace(' ', '_')}.xlsx`)
  }

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Stock Movements</h1>
          <p className="page-subtitle">Ledger of every POS-driven stock depletion — {periodLabel}</p>
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
          <div className="stat-label">Movements</div>
          <div className="stat-value">{filtered.length}</div>
          <div className="stat-sub">depletion entries this period</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Sum of qty depleted × per-unit rate across every movement below — the food-cost value POS activity consumed this period." width={260}>Value Depleted</Tip></div>
          <div className="stat-value gold" style={{ fontSize: 18 }}>NPR {totalValue.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</div>
          <div className="stat-sub">POS sale + comp, at cost</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Same calc, restricted to POS Comp rows — the food-cost value of dishes given away complimentary, with zero revenue collected." width={260}>Comp Value</Tip></div>
          <div className="stat-value" style={{ fontSize: 18, color: 'var(--theme-purple)' }}>NPR {compValue.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</div>
          <div className="stat-sub">value given away</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Items Affected</div>
          <div className="stat-value">{itemsAffected}</div>
          <div className="stat-sub">distinct items depleted</div>
        </div>
      </div>

      {noBomRecipes.length > 0 && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 25%, transparent)', borderRadius: 8, padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-amber)' }}>
          <span>⚠</span>
          <span>
            {noBomRecipes.length} item{noBomRecipes.length !== 1 ? 's' : ''} sold this period {noBomRecipes.length !== 1 ? 'have' : 'has'} no ingredients linked, so no stock was depleted for {noBomRecipes.length !== 1 ? 'them' : 'it'}: <strong>{noBomRecipes.join(', ')}</strong>. Add ingredients under Recipes to fix this going forward.
          </span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 200 }}
          placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)} />
        <select className="form-select" value={filterSource} onChange={e => setFilterSource(e.target.value)}>
          <option value="all">All Sources</option>
          <option value="pos_sale">POS Sale</option>
          <option value="pos_comp">POS Comp</option>
        </select>
        <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{filtered.length} entr{filtered.length !== 1 ? 'ies' : 'y'}</span>
      </div>

      <div className="card">
        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Building report…</p>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">✓</div>
            <p className="empty-state-text">No stock movements yet for this period. Entries appear here automatically the moment a POS bill is charged or marked Complimentary.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Day</th><th>Item</th><th>Category</th><th>UOM</th>
                  <th style={{ textAlign: 'right' }}>Qty Depleted</th>
                  <th><Tip text="POS Sale = billed and paid for. POS Comp = given away complimentary — zero revenue, but the food cost was still consumed." width={260}>Source</Tip></th>
                  <th><Tip text="Click to open the exact original bill or complimentary slip this depletion came from." width={240}>Order #</Tip></th>
                  <th>Staff</th>
                  <th style={{ textAlign: 'right' }}>Value (NPR)</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.id}>
                    <td style={{ color: 'var(--theme-text2)' }}>{r.bsDay}</td>
                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.item.name}</div>
                      {r.item.item_code && <div style={{ fontSize: 11, color: 'var(--theme-text3)', fontFamily: 'monospace' }}>{r.item.item_code}</div>}
                    </td>
                    <td><span className="badge badge-yellow">{r.category}</span></td>
                    <td style={{ color: 'var(--theme-text2)' }}>{r.item.uom}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-text1)' }}>{r.qtyAbs.toFixed(3)}</td>
                    <td>
                      <span className={`badge ${r.source === 'pos_comp' ? 'badge-amber' : 'badge-green'}`}>
                        {r.source === 'pos_comp' ? 'POS Comp' : 'POS Sale'}
                      </span>
                    </td>
                    <td>
                      {r.order?.order_no ? (
                        <span
                          onClick={() => viewPosBill(effectiveClientId, { id: r.ref_id, close_type: r.order.close_type })}
                          role="button" tabIndex={0} className="interactive-card"
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); viewPosBill(effectiveClientId, { id: r.ref_id, close_type: r.order.close_type }) } }}
                          style={{ cursor: 'pointer', color: 'var(--theme-accent)', borderBottom: '1px dashed var(--theme-accent)', paddingBottom: 1 }}
                        >
                          #{r.order.order_no}
                        </span>
                      ) : '—'}
                    </td>
                    <td style={{ color: 'var(--theme-text2)' }}>{(r.order && staffNames[r.order.closed_by]) || '—'}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{r.value.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
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
