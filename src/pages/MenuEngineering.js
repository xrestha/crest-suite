import { useEffect, useState, useMemo } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import Tip from '../components/Tip'

const QUADRANTS = {
  Star:      { color: '#34d399', bg: 'rgba(52,211,153,0.10)', border: 'rgba(52,211,153,0.30)', icon: '★', desc: 'High profit · High popularity' },
  Plowhouse: { color: '#60a5fa', bg: 'rgba(96,165,250,0.10)', border: 'rgba(96,165,250,0.30)', icon: '⬛', desc: 'High profit · Low popularity' },
  Puzzle:    { color: '#f59e0b', bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.30)',  icon: '?', desc: 'Low profit · High popularity' },
  Dog:       { color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.30)', icon: '✕', desc: 'Low profit · Low popularity' },
}

const FC_CUTOFF = 35 // %

function classify(fcPct, qtySold, medianQty) {
  const highProfit = fcPct <= FC_CUTOFF
  const highPop    = qtySold >= medianQty
  if (highProfit && highPop)  return 'Star'
  if (highProfit && !highPop) return 'Plowhouse'
  if (!highProfit && highPop) return 'Puzzle'
  return 'Dog'
}

function median(arr) {
  if (!arr.length) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export default function MenuEngineering() {
  const { profile, clientId: authClientId, loading: authLoading } = useAuth()
  const clientId = authClientId || profile?.client_id

  const [periods, setPeriods]     = useState([])
  const [periodId, setPeriodId]   = useState('')
  const [items, setItems]         = useState([])   // enriched recipe rows
  const [loading, setLoading]     = useState(false)
  const [filterQ, setFilterQ]     = useState('All')
  const [search, setSearch]       = useState('')
  const [viewMode, setViewMode]   = useState('table') // 'table' | 'matrix'

  useEffect(() => { if (!authLoading && clientId) loadPeriods() }, [clientId, authLoading]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (periodId && clientId) loadData() }, [periodId, clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

  async function loadPeriods() {
    const { data } = await supabase
      .from('monthly_periods')
      .select('id, bs_year, bs_month, status')
      .eq('client_id', clientId)
      .order('bs_year', { ascending: false })
      .order('bs_month', { ascending: false })
    const withLabel = (data || []).map(p => ({
      ...p,
      label: `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}`
    }))
    setPeriods(withLabel)
    const active = withLabel.find(p => p.status === 'open') || withLabel[0]
    if (active) setPeriodId(active.id)
  }

  async function loadData() {
    setLoading(true)

    // Load recipes (menu items only — exclude sub-recipes)
    const { data: recipes } = await supabase
      .from('recipes')
      .select('id, name, category, selling_price')
      .eq('client_id', clientId)
      .neq('is_active', false)
      .neq('category', 'Sub-Recipe')

    // Load recipe_ingredients for cost calculation
    const { data: ingredients } = await supabase
      .from('recipe_ingredients')
      .select('recipe_id, qty_per_portion, item_id, sub_recipe_id, items(per_uom_rate)')

    // Load sales for this period
    const { data: sales } = await supabase
      .from('sales_entries')
      .select('recipe_id, qty_sold')
      .eq('period_id', periodId)

    if (!recipes) { setLoading(false); return }

    // Build sales map: recipe_id -> total qty sold
    const salesMap = {}
    ;(sales || []).forEach(s => {
      salesMap[s.recipe_id] = (salesMap[s.recipe_id] || 0) + (parseFloat(s.qty_sold) || 0)
    })

    // Build ingredient cost map per recipe
    const ingMap = {}
    ;(ingredients || []).forEach(ing => {
      if (!ingMap[ing.recipe_id]) ingMap[ing.recipe_id] = 0
      const qty = parseFloat(ing.qty_per_portion) || 0
      if (ing.item_id && ing.items?.per_uom_rate) {
        ingMap[ing.recipe_id] += qty * parseFloat(ing.items.per_uom_rate)
      }
    })

    // Enrich recipes
    const enriched = recipes.map(r => {
      const ingredientCost = ingMap[r.id] || 0
      const sellingPrice   = parseFloat(r.selling_price) || 0
      const fcPct          = sellingPrice > 0 ? (ingredientCost / sellingPrice) * 100 : 0
      const qtySold        = salesMap[r.id] || 0
      const revenue        = sellingPrice * qtySold
      return { ...r, ingredientCost, sellingPrice, fcPct, qtySold, revenue }
    })

    // Calculate median qty sold across all items
    const allQtys = enriched.map(r => r.qtySold)
    const med     = median(allQtys)

    // Classify
    const final = enriched.map(r => ({
      ...r,
      quadrant: classify(r.fcPct, r.qtySold, med),
      medianQty: med,
    }))

    setItems(final)
    setLoading(false)
  }

  const filtered = useMemo(() => {
    return items.filter(r => {
      const matchQ = filterQ === 'All' || r.quadrant === filterQ
      const matchS = r.name.toLowerCase().includes(search.toLowerCase())
      return matchQ && matchS
    })
  }, [items, filterQ, search])

  // Quadrant summary counts
  const summary = useMemo(() => {
    const s = { Star: 0, Plowhouse: 0, Puzzle: 0, Dog: 0 }
    items.forEach(r => { if (s[r.quadrant] !== undefined) s[r.quadrant]++ })
    return s
  }, [items])

  const medianQty = items[0]?.medianQty ?? 0

  const totalRevenue = filtered.reduce((a, r) => a + r.revenue, 0)
  const totalQty     = filtered.reduce((a, r) => a + r.qtySold, 0)

  // For matrix view — group by quadrant
  const byQuadrant = useMemo(() => {
    const map = { Star: [], Plowhouse: [], Puzzle: [], Dog: [] }
    filtered.forEach(r => map[r.quadrant]?.push(r))
    return map
  }, [filtered])

  return (
    <div>
      {/* Header */}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Menu Engineering</h1>
          <p className="page-subtitle">
            FC% cutoff: 35% · Volume cutoff: median ({medianQty.toFixed(1)} portions)
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="form-select" value={periodId} onChange={e => setPeriodId(e.target.value)}>
            {periods.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          {/* View toggle */}
          <div className="tab-bar">
            <button className={`tab-btn${viewMode === 'table'  ? ' tab-btn--active' : ''}`} onClick={() => setViewMode('table')}>☰ Table</button>
            <button className={`tab-btn${viewMode === 'matrix' ? ' tab-btn--active' : ''}`} onClick={() => setViewMode('matrix')}>⊞ Matrix</button>
          </div>
        </div>
      </div>

      {/* Quadrant summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        {Object.entries(QUADRANTS).map(([name, q]) => (
          <div
            key={name}
            onClick={() => setFilterQ(filterQ === name ? 'All' : name)}
            style={{
              background: filterQ === name ? q.bg : '#181c27',
              border: `1px solid ${filterQ === name ? q.border : '#2a2f3d'}`,
              borderRadius: 8, padding: '14px 16px', cursor: 'pointer',
              transition: 'all 0.15s'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 18, color: q.color }}>{q.icon}</span>
              <span style={{
                fontSize: 22, fontWeight: 700, color: q.color
              }}>{summary[name]}</span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#e8e0d0' }}>{name}</div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{q.desc}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          placeholder="Search menu items…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none', width: 220 }}
        />
        <select className="form-select" value={filterQ} onChange={e => setFilterQ(e.target.value)}>
          <option value="All">All Quadrants</option>
          {Object.keys(QUADRANTS).map(q => <option key={q} value={q}>{q}</option>)}
        </select>
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          {filtered.length} item{filtered.length !== 1 ? 's' : ''} · Revenue: NPR {totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })} · Qty: {totalQty.toLocaleString()}
        </span>
      </div>

      {loading ? (
        <div className="card"><p style={{ color: '#6b7280', fontSize: 13 }}>Loading…</p></div>
      ) : items.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">◎</div>
            <p className="empty-state-text">No menu items found. Add recipes with selling prices and record sales to see the matrix.</p>
          </div>
        </div>
      ) : viewMode === 'table' ? (
        /* TABLE VIEW */
        <div className="card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Menu Item</th>
                  <th>Category</th>
                  <th style={{ textAlign: 'right' }}>Selling Price</th>
                  <th style={{ textAlign: 'right' }}>Ingredient Cost</th>
                  <th style={{ textAlign: 'right' }}>FC%</th>
                  <th style={{ textAlign: 'right' }}>Qty Sold</th>
                  <th style={{ textAlign: 'right' }}>Revenue (NPR)</th>
                  <th>Quadrant</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const q = QUADRANTS[r.quadrant]
                  return (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600, color: '#e8e0d0' }}>{r.name}</td>
                      <td style={{ color: '#6b7280', fontSize: 12 }}>{r.category || '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.sellingPrice > 0 ? r.sellingPrice.toLocaleString() : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.ingredientCost.toFixed(2)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span style={{
                          color: r.fcPct <= 30 ? '#34d399' : r.fcPct <= 38 ? '#f59e0b' : '#f87171',
                          fontWeight: 600
                        }}>
                          {r.sellingPrice > 0 ? r.fcPct.toFixed(1) + '%' : '—'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>{r.qtySold > 0 ? r.qtySold.toLocaleString() : <span style={{ color: '#9ca3af' }}>0</span>}</td>
                      <td style={{ textAlign: 'right' }}>{r.revenue > 0 ? r.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</td>
                      <td>
                        <span style={{
                          fontSize: 12, fontWeight: 700,
                          background: q.bg, color: q.color,
                          border: `1px solid ${q.border}`,
                          borderRadius: 4, padding: '3px 8px',
                          whiteSpace: 'nowrap'
                        }}>
                          {q.icon} {r.quadrant}
                        </span>
                      </td>
                      <td style={{ fontSize: 11, color: '#6b7280', maxWidth: 160 }}>
                        {r.quadrant === 'Star'      && 'Keep on menu. Feature prominently.'}
                        {r.quadrant === 'Plowhouse' && 'Good margin. Promote to boost volume.'}
                        {r.quadrant === 'Puzzle'    && 'Review recipe cost. Can price be raised?'}
                        {r.quadrant === 'Dog'       && 'Consider removing or redesigning.'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* MATRIX VIEW — 2x2 quadrant grid */
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {Object.entries(QUADRANTS).map(([name, q]) => (
            <div key={name} style={{
              background: '#181c27',
              border: `1px solid ${q.border}`,
              borderRadius: 10, overflow: 'hidden'
            }}>
              {/* Quadrant header */}
              <div style={{
                background: q.bg, padding: '12px 16px',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                borderBottom: `1px solid ${q.border}`
              }}>
                <div>
                  <span style={{ fontSize: 15, fontWeight: 700, color: q.color }}>{q.icon} {name}</span>
                  <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 10 }}>{q.desc}</span>
                </div>
                <span style={{ fontSize: 20, fontWeight: 700, color: q.color }}>{byQuadrant[name].length}</span>
              </div>
              {/* Items */}
              <div style={{ padding: '8px 0', minHeight: 60 }}>
                {byQuadrant[name].length === 0 ? (
                  <p style={{ color: '#9ca3af', fontSize: 12, textAlign: 'center', padding: '16px 0' }}>No items</p>
                ) : byQuadrant[name].map(r => (
                  <div key={r.id} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '8px 16px', borderBottom: '1px solid #2a2f3d'
                  }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#e8e0d0' }}>{r.name}</div>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>{r.category}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{
                        fontSize: 12, fontWeight: 700,
                        color: r.fcPct <= 30 ? '#34d399' : r.fcPct <= 38 ? '#f59e0b' : '#f87171'
                      }}>
                        {r.sellingPrice > 0 ? r.fcPct.toFixed(1) + '%' : '—'} FC
                      </div>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>{r.qtySold} sold</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Legend */}
      {!loading && items.length > 0 && (
        <div className="card" style={{ marginTop: 16, display: 'flex', gap: 24, flexWrap: 'wrap', padding: '12px 20px' }}>
          <span style={{ fontSize: 11, color: '#6b7280', alignSelf: 'center' }}>Thresholds:</span>
          <Tip text="Items with food cost ≤ 35% of selling price are 'high profit'. Above 35% = low profit.">
            <span style={{ fontSize: 12, color: '#6b7280' }}>FC% cutoff <span style={{ color: '#c9a84c' }}>35%</span></span>
          </Tip>
          <Tip text={`Median portions sold this period. Items at or above ${medianQty.toFixed(0)} are 'high popularity'; below = low popularity.`}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>Volume cutoff <span style={{ color: '#c9a84c' }}>median = {medianQty.toFixed(1)} portions</span></span>
          </Tip>
          <Tip text="The Bikram Sambat period being analysed. Change the period in the dropdown above to compare months.">
            <span style={{ fontSize: 12, color: '#6b7280' }}>Period <span style={{ color: '#c9a84c' }}>{periods.find(p => p.id === periodId)?.label || ''}</span></span>
          </Tip>
        </div>
      )}
    </div>
  )
}
