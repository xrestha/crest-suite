import { useEffect, useState, useMemo } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import ChartCard from '../../../components/ChartCard'
import { computeRecipeCosts } from '../../../utils/recipeCost'
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ReferenceLine, ResponsiveContainer,
  Cell, BarChart, Bar,
} from 'recharts'

const QUADRANTS = {
  Star:      { color: 'var(--theme-green)', bg: 'rgba(52,211,153,0.10)', border: 'rgba(52,211,153,0.30)', icon: '★', desc: 'High profit · High popularity' },
  Plowhouse: { color: 'var(--theme-purple)', bg: 'color-mix(in srgb, var(--theme-purple) 10%, transparent)', border: 'color-mix(in srgb, var(--theme-purple) 30%, transparent)', icon: '⬛', desc: 'High profit · Low popularity' },
  Puzzle:    { color: 'var(--theme-amber)', bg: 'color-mix(in srgb, var(--theme-amber) 10%, transparent)',  border: 'color-mix(in srgb, var(--theme-amber) 30%, transparent)',  icon: '?', desc: 'Low profit · High popularity' },
  Dog:       { color: 'var(--theme-red)', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.30)', icon: '✕', desc: 'Low profit · Low popularity' },
}

const FC_CUTOFF = 35 // %

// Hex colors for Recharts SVG (CSS vars don't resolve inside SVG presentation attributes)
const Q_HEX = { Star: '#34d399', Plowhouse: '#60a5fa', Puzzle: '#f59e0b', Dog: '#f87171' }

function ScatterDot({ cx, cy, payload }) {
  const color = Q_HEX[payload.quadrant] || '#888'
  return <circle cx={cx} cy={cy} r={5} fill={color} fillOpacity={0.85} stroke={color} strokeWidth={1} />
}

function ScatterTooltipContent({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  const q = QUADRANTS[d.quadrant]
  return (
    <div style={{
      background: 'var(--theme-card)', border: `1px solid ${q.border}`,
      borderRadius: 8, padding: '10px 14px', fontSize: 12, minWidth: 160
    }}>
      <div style={{ fontWeight: 700, color: q.color, marginBottom: 6 }}>{q.icon} {d.name}</div>
      <div style={{ color: 'var(--theme-text2)' }}>FC%: <span style={{ fontWeight: 600, color: d.fcPct > FC_CUTOFF ? 'var(--theme-red)' : 'var(--theme-green)' }}>{d.sellingPrice > 0 ? d.fcPct.toFixed(1) + '%' : '—'}</span></div>
      <div style={{ color: 'var(--theme-text2)' }}>Qty Sold: <span style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{d.qtySold}</span></div>
      <div style={{ color: 'var(--theme-text2)' }}>Revenue: <span style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>NPR {d.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></div>
    </div>
  )
}

function BarTooltipContent({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 4 }}>{label}</div>
      <div style={{ color: 'var(--theme-text2)' }}>Revenue: <span style={{ fontWeight: 600, color: 'var(--theme-accent)' }}>NPR {(payload[0]?.value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></div>
    </div>
  )
}

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
  const { scopedFrom, scopedUpdate } = useScopedDb()

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
    const { data } = await scopedFrom('monthly_periods', 'id, bs_year, bs_month, status')
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
    const { data: recipes } = await scopedFrom('recipes', 'id, name, category, selling_price')
      .neq('is_active', false)
      .neq('category', 'Sub-Recipe')

    // computeRecipeCosts recurses through sub-recipe ingredients and applies yield_pct — a
    // hand-rolled ingMap reading only direct item_id ingredients (as this used to) silently
    // costs any sub-recipe-based ingredient at zero, which could misclassify a genuinely
    // unprofitable dish as a "Star" in the quadrant below.
    const ingMap = (recipes || []).length > 0
      ? await computeRecipeCosts(supabase, recipes.map(r => r.id))
      : {}

    // Load sales for this period — comps (source='pos_comp') excluded, since the BCG-style
    // revenue/margin quadrant below is about what actually sold at menu price, not what was
    // given away.
    const { data: sales } = await supabase
      .from('sales_entries')
      .select('recipe_id, qty_sold')
      .eq('period_id', periodId)
      .neq('source', 'pos_comp')

    if (!recipes) { setLoading(false); return }

    // Build sales map: recipe_id -> total qty sold
    const salesMap = {}
    ;(sales || []).forEach(s => {
      salesMap[s.recipe_id] = (salesMap[s.recipe_id] || 0) + (parseFloat(s.qty_sold) || 0)
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
    // Background: write me_class to DB — read by POS suggestion engine on next menu load
    final.forEach(r => {
      scopedUpdate('recipes', { me_class: r.quadrant.toLowerCase() }).eq('id', r.id)
    })
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

  // Charts — always use all items (full picture regardless of filter)
  const scatterData = useMemo(() =>
    items.map(r => ({
      x: r.qtySold,
      y: parseFloat((100 - r.fcPct).toFixed(1)), // higher = more profitable
      name: r.name, fcPct: r.fcPct, qtySold: r.qtySold,
      revenue: r.revenue, quadrant: r.quadrant, sellingPrice: r.sellingPrice,
    }))
  , [items])

  const topItems = useMemo(() =>
    [...items]
      .filter(r => r.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)
      .map(r => ({ name: r.name.length > 22 ? r.name.slice(0, 20) + '…' : r.name, revenue: Math.round(r.revenue), quadrant: r.quadrant }))
  , [items])

  const categoryPivot = useMemo(() => {
    const map = {}
    items.forEach(r => {
      const cat = r.category || 'Uncategorized'
      if (!map[cat]) map[cat] = { Star: 0, Plowhouse: 0, Puzzle: 0, Dog: 0, total: 0 }
      map[cat][r.quadrant]++
      map[cat].total++
    })
    return Object.entries(map).sort((a, b) => b[1].total - a[1].total)
  }, [items])

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
            <button className={`tab-btn${viewMode === 'charts' ? ' tab-btn--active' : ''}`} onClick={() => setViewMode('charts')}>◉ Charts</button>
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
              background: filterQ === name ? q.bg : 'var(--theme-card)',
              border: `1px solid ${filterQ === name ? q.border : 'var(--theme-border)'}`,
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
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}>{name}</div>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>{q.desc}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          placeholder="Search menu items…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 220 }}
        />
        <select className="form-select" value={filterQ} onChange={e => setFilterQ(e.target.value)}>
          <option value="All">All Quadrants</option>
          {Object.keys(QUADRANTS).map(q => <option key={q} value={q}>{q}</option>)}
        </select>
        <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
          {filtered.length} item{filtered.length !== 1 ? 's' : ''} · Revenue: NPR {totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })} · Qty: {totalQty.toLocaleString()}
        </span>
      </div>

      {loading ? (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p></div>
      ) : items.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">◎</div>
            <p className="empty-state-text">No menu items found. Add recipes with selling prices and record sales to see the matrix.</p>
          </div>
        </div>
      ) : viewMode === 'charts' ? (
        /* CHARTS VIEW */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Scatter chart — FC% Profitability vs Qty Sold */}
          <ChartCard
            title={<>Popularity vs Profitability <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--theme-text2)', marginLeft: 10, textTransform: 'none', letterSpacing: 0 }}>Each dot = one menu item</span></>}
            titleStyle={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)' }}
            cardStyle={{ padding: '20px 20px 12px' }}
            smallHeight={320}
            legend={
              <div style={{ display: 'flex', gap: 16 }}>
                {Object.entries(Q_HEX).map(([name, hex]) => (
                  <span key={name} style={{ fontSize: 11, color: 'var(--theme-text2)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: hex, display: 'inline-block' }} />
                    {name}
                  </span>
                ))}
              </div>
            }
            footer={
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginTop: 4 }}>
                {[
                  { q: 'Star',      pos: 'right + top (high qty, low FC%)',     hint: 'Keep, feature prominently' },
                  { q: 'Plowhouse', pos: 'left + top (low qty, low FC%)',       hint: 'Good margin — promote harder' },
                  { q: 'Puzzle',    pos: 'right + bottom (high qty, high FC%)', hint: 'Popular — review recipe cost' },
                  { q: 'Dog',       pos: 'left + bottom (low qty, high FC%)',   hint: 'Consider redesign or removal' },
                ].map(({ q, pos, hint }) => (
                  <div key={q} style={{ background: 'var(--theme-table-hover)', borderRadius: 6, padding: '8px 10px', borderLeft: `3px solid ${Q_HEX[q]}` }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: Q_HEX[q] }}>{QUADRANTS[q].icon} {q}</div>
                    <div style={{ fontSize: 10, color: 'var(--theme-text3)', marginTop: 2 }}>{pos}</div>
                    <div style={{ fontSize: 10, color: 'var(--theme-text2)', marginTop: 2 }}>{hint}</div>
                  </div>
                ))}
              </div>
            }
            renderChart={h => (
              <ResponsiveContainer width="100%" height={h}>
                <ScatterChart margin={{ top: 10, right: 20, bottom: 30, left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2d3240" />
                  <XAxis type="number" dataKey="x" name="Qty Sold" label={{ value: 'Qty Sold →', position: 'insideBottom', offset: -16, fill: '#6b7280', fontSize: 11 }} tick={{ fill: '#6b7280', fontSize: 11 }} />
                  <YAxis type="number" dataKey="y" name="Profitability" domain={[0, 100]} label={{ value: 'Profitability % →', angle: -90, position: 'insideLeft', offset: 10, fill: '#6b7280', fontSize: 11 }} tick={{ fill: '#6b7280', fontSize: 11 }} tickFormatter={v => `${v}%`} />
                  <ReferenceLine x={medianQty} stroke="#4b5563" strokeDasharray="5 4" label={{ value: `median ${medianQty.toFixed(0)}`, position: 'top', fill: '#6b7280', fontSize: 10 }} />
                  <ReferenceLine y={100 - FC_CUTOFF} stroke="#4b5563" strokeDasharray="5 4" label={{ value: `FC ${FC_CUTOFF}%`, position: 'right', fill: '#6b7280', fontSize: 10 }} />
                  <ReferenceLine x={0} stroke="none" label={{ value: '★ STARS', position: 'insideTopRight', fill: '#34d399', fontSize: 9, offset: 8 }} />
                  <RTooltip content={<ScatterTooltipContent />} cursor={{ strokeDasharray: '3 3' }} />
                  <Scatter data={scatterData} shape={<ScatterDot />} />
                </ScatterChart>
              </ResponsiveContainer>
            )}
          />

          {/* Bottom row: Top Revenue Items + Category Pivot */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

            {/* Top 10 by Revenue */}
            <ChartCard
              title="Top Items by Revenue"
              titleStyle={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}
              cardStyle={{ padding: '16px 16px 8px' }}
              smallHeight={Math.max(topItems.length * 32 + 20, 80)}
              renderChart={h => topItems.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--theme-text3)' }}>No sales recorded this period.</p>
              ) : (
                <ResponsiveContainer width="100%" height={h}>
                  <BarChart data={topItems} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 0 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" width={140} tick={{ fill: '#9ca3af', fontSize: 11 }} />
                    <RTooltip content={<BarTooltipContent />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <Bar dataKey="revenue" radius={[0, 4, 4, 0]}>
                      {topItems.map((entry, i) => (
                        <Cell key={i} fill={Q_HEX[entry.quadrant] || '#c9a84c'} fillOpacity={0.8} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            />

            {/* Category Pivot */}
            <div className="card" style={{ padding: '16px' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)', marginBottom: 12 }}>
                Category Breakdown
                <Tip text="How each menu category distributes across the four quadrants. A category heavy in Dogs or Puzzles may need a pricing or cost review." width={240}>
                  <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--theme-text3)', cursor: 'default' }}>?</span>
                </Tip>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', color: 'var(--theme-text3)', fontWeight: 600, padding: '4px 8px 8px 0', borderBottom: '1px solid var(--theme-border)' }}>Category</th>
                      {Object.entries(Q_HEX).map(([name, hex]) => (
                        <th key={name} style={{ textAlign: 'center', color: hex, fontWeight: 700, padding: '4px 6px 8px', borderBottom: '1px solid var(--theme-border)', fontSize: 11 }}>
                          {QUADRANTS[name].icon}<br />{name}
                        </th>
                      ))}
                      <th style={{ textAlign: 'right', color: 'var(--theme-text3)', fontWeight: 600, padding: '4px 0 8px 6px', borderBottom: '1px solid var(--theme-border)' }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categoryPivot.map(([cat, counts]) => (
                      <tr key={cat} style={{ borderBottom: '1px solid var(--theme-border-lt)' }}>
                        <td style={{ padding: '7px 8px 7px 0', color: 'var(--theme-text1)', fontWeight: 500 }}>{cat}</td>
                        {Object.keys(Q_HEX).map(q => (
                          <td key={q} style={{ textAlign: 'center', padding: '7px 6px', color: counts[q] > 0 ? Q_HEX[q] : 'var(--theme-text3)', fontWeight: counts[q] > 0 ? 700 : 400 }}>
                            {counts[q] > 0 ? counts[q] : '—'}
                          </td>
                        ))}
                        <td style={{ textAlign: 'right', padding: '7px 0 7px 6px', color: 'var(--theme-text2)' }}>{counts.total}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                      <td style={{ padding: '8px 8px 4px 0', color: 'var(--theme-text3)', fontWeight: 600, fontSize: 11 }}>TOTAL</td>
                      {Object.keys(Q_HEX).map(q => (
                        <td key={q} style={{ textAlign: 'center', padding: '8px 6px 4px', fontWeight: 700, color: Q_HEX[q] }}>{summary[q]}</td>
                      ))}
                      <td style={{ textAlign: 'right', padding: '8px 0 4px 6px', color: 'var(--theme-text2)', fontWeight: 600 }}>{items.length}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

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
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.name}</td>
                      <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{r.category || '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.sellingPrice > 0 ? r.sellingPrice.toLocaleString() : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.ingredientCost.toFixed(2)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span style={{
                          color: r.fcPct <= 30 ? 'var(--theme-green)' : r.fcPct <= 38 ? 'var(--theme-amber)' : 'var(--theme-red)',
                          fontWeight: 600
                        }}>
                          {r.sellingPrice > 0 ? r.fcPct.toFixed(1) + '%' : '—'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>{r.qtySold > 0 ? r.qtySold.toLocaleString() : <span style={{ color: 'var(--theme-text3)' }}>0</span>}</td>
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
                      <td style={{ fontSize: 11, color: 'var(--theme-text2)', maxWidth: 160 }}>
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
              background: 'var(--theme-card)',
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
                  <span style={{ fontSize: 11, color: 'var(--theme-text2)', marginLeft: 10 }}>{q.desc}</span>
                </div>
                <span style={{ fontSize: 20, fontWeight: 700, color: q.color }}>{byQuadrant[name].length}</span>
              </div>
              {/* Items */}
              <div style={{ padding: '8px 0', minHeight: 60 }}>
                {byQuadrant[name].length === 0 ? (
                  <p style={{ color: 'var(--theme-text3)', fontSize: 12, textAlign: 'center', padding: '16px 0' }}>No items</p>
                ) : byQuadrant[name].map(r => (
                  <div key={r.id} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '8px 16px', borderBottom: '1px solid var(--theme-border)'
                  }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>{r.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{r.category}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{
                        fontSize: 12, fontWeight: 700,
                        color: r.fcPct <= 30 ? 'var(--theme-green)' : r.fcPct <= 38 ? 'var(--theme-amber)' : 'var(--theme-red)'
                      }}>
                        {r.sellingPrice > 0 ? r.fcPct.toFixed(1) + '%' : '—'} FC
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{r.qtySold} sold</div>
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
          <span style={{ fontSize: 11, color: 'var(--theme-text2)', alignSelf: 'center' }}>Thresholds:</span>
          <Tip text="Items with food cost ≤ 35% of selling price are 'high profit'. Above 35% = low profit.">
            <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>FC% cutoff <span style={{ color: 'var(--theme-accent)' }}>35%</span></span>
          </Tip>
          <Tip text={`Median portions sold this period. Items at or above ${medianQty.toFixed(0)} are 'high popularity'; below = low popularity.`}>
            <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Volume cutoff <span style={{ color: 'var(--theme-accent)' }}>median = {medianQty.toFixed(1)} portions</span></span>
          </Tip>
          <Tip text="The Bikram Sambat period being analysed. Change the period in the dropdown above to compare months.">
            <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Period <span style={{ color: 'var(--theme-accent)' }}>{periods.find(p => p.id === periodId)?.label || ''}</span></span>
          </Tip>
        </div>
      )}
    </div>
  )
}
