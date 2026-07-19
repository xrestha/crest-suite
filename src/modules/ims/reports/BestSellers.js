import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import Tip from '../../../components/Tip'
import ChartCard from '../../../components/ChartCard'
import { computeRecipeCosts } from '../../../utils/recipeCost'
import { Navigate } from 'react-router-dom'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

// Recharts SVG props (fill, tick) don't resolve CSS vars — these fixed hexes back only
// the two chart call sites below; everything else uses the theme-token constants beneath.
const GOLD_HEX  = '#c9a84c'
const GREEN_HEX = '#34d399'
const MUTED_HEX = '#6b7280'

const GOLD  = 'var(--theme-accent)'
const GREEN = 'var(--theme-green)'
const RED   = 'var(--theme-red)'
const MUTED = 'var(--theme-text2)'

export default function BestSellers() {
  const { clientId, profile, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const [periods, setPeriods]         = useState([])
  const [selectedPeriod, setSelected] = useState(null)
  const [rows, setRows]               = useState([])
  const [sortBy, setSortBy]           = useState('revenue') // 'revenue' | 'qty' | 'margin'
  const [loading, setLoading]         = useState(false)

  useEffect(() => {
    if (!effectiveClientId) return
    scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .then(({ data }) => {
        setPeriods(data || [])
        if (data && data.length > 0) setSelected(data[0])
      })
  }, [effectiveClientId, scopedFrom])

  useEffect(() => {
    if (selectedPeriod) fetchData(selectedPeriod.id)
  }, [selectedPeriod]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchData(periodId) {
    setLoading(true)
    const [{ data: entries }, { data: recipes }] = await Promise.all([
      // "Best seller" ranks by real demand — comps (source='pos_comp') never sold at menu
      // price and would misleadingly inflate a heavily-comped item's qty/revenue rank.
      supabase.from('sales_entries').select('recipe_id, qty_sold, unit_price').eq('period_id', periodId).neq('source', 'pos_comp'),
      scopedFrom('recipes', 'id, name, category, selling_price').neq('category', 'Sub-Recipe'),
    ])

    // computeRecipeCosts recurses through sub-recipe ingredients and applies yield_pct — a
    // hand-rolled costMap reading only direct item_id ingredients (as this used to) silently
    // costs any sub-recipe-based ingredient at zero, understating COGS/inflating margin here.
    const recipeIds = (recipes || []).map(r => r.id)
    const costMap = recipeIds.length > 0 ? await computeRecipeCosts(supabase, recipeIds) : {}

    const currentPriceMap = {}
    ;(recipes || []).forEach(r => { currentPriceMap[r.id] = parseFloat(r.selling_price || 0) })

    // unit_price captured on the row (price actually charged) is used per-row when present, else
    // that specific row falls back to the recipe's current price — previously this report always
    // used the recipe's current price for every row, so past-period revenue silently shifted
    // whenever a menu price changed later.
    const qtyMap = {}, revenueMap = {}
    for (const e of entries || []) {
      const qty = parseFloat(e.qty_sold || 0)
      const price = e.unit_price != null ? parseFloat(e.unit_price) : (currentPriceMap[e.recipe_id] || 0)
      qtyMap[e.recipe_id] = (qtyMap[e.recipe_id] || 0) + qty
      revenueMap[e.recipe_id] = (revenueMap[e.recipe_id] || 0) + qty * price
    }

    const built = (recipes || [])
      .filter(r => qtyMap[r.id] > 0)
      .map(r => {
        const qty      = qtyMap[r.id] || 0
        const revenue  = revenueMap[r.id] || 0
        const price    = qty > 0 ? revenue / qty : currentPriceMap[r.id]
        const cost     = costMap[r.id] || 0
        const cogs     = qty * cost
        const profit   = revenue - cogs
        const margin   = revenue > 0 ? (profit / revenue) * 100 : 0
        return { name: r.name, category: r.category, qty, price, revenue, cogs, profit, margin }
      })

    setRows(built)
    setLoading(false)
  }

  const sorted = [...rows].sort((a, b) => b[sortBy] - a[sortBy])
  const top10  = sorted.slice(0, 10)
  const bot10  = [...sorted].reverse().slice(0, 10)

  const chartData = top10.map(r => ({
    name: r.name.length > 14 ? r.name.slice(0, 13) + '…' : r.name,
    value: sortBy === 'qty' ? r.qty : sortBy === 'margin' ? parseFloat(r.margin.toFixed(1)) : Math.round(r.revenue),
  }))

  const fmt = (n) => `NPR ${Math.round(n).toLocaleString('en-NP')}`
  const periodLabel = (p) => p ? `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}` : ''

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Best &amp; Worst Sellers</h1>
          <p className="page-subtitle">Rank menu items by revenue, volume, or margin for the period</p>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="form-select" value={selectedPeriod?.id || ''} onChange={e => setSelected(periods.find(p => p.id === e.target.value))}>
          {periods.map(p => <option key={p.id} value={p.id}>{periodLabel(p)}</option>)}
        </select>
        <div className="tab-bar">
          <button className={`tab-btn${sortBy === 'revenue' ? ' tab-btn--active' : ''}`} onClick={() => setSortBy('revenue')}>By Revenue</button>
          <button className={`tab-btn${sortBy === 'qty'     ? ' tab-btn--active' : ''}`} onClick={() => setSortBy('qty')}>By Volume</button>
          <button className={`tab-btn${sortBy === 'margin'  ? ' tab-btn--active' : ''}`} onClick={() => setSortBy('margin')}>By Margin %</button>
        </div>
        {!loading && rows.length > 0 && (
          <span style={{ fontSize: 13, color: MUTED }}>{rows.length} items sold this period</span>
        )}
      </div>

      {loading ? (
        <p style={{ color: MUTED, fontSize: 13 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">◈</div>
            <p className="empty-state-text">No sales data for this period.</p>
          </div>
        </div>
      ) : (
        <>
          {/* Bar chart — top 10 */}
          <ChartCard
            title={`Top 10 — ${sortBy === 'qty' ? 'Units Sold' : sortBy === 'margin' ? 'Gross Margin %' : 'Revenue (NPR)'}`}
            titleStyle={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)' }}
            cardStyle={{ marginBottom: 24 }}
            smallHeight={220}
            renderChart={h => (
              <ResponsiveContainer width="100%" height={h}>
                <BarChart data={chartData} margin={{ top: 0, right: 10, left: 0, bottom: h > 200 ? 60 : 40 }}>
                  <XAxis dataKey="name" tick={{ fill: MUTED_HEX, fontSize: 11 }} angle={-30} textAnchor="end" interval={0} />
                  <YAxis tick={{ fill: MUTED_HEX, fontSize: 11 }} tickFormatter={v => sortBy === 'revenue' ? `${Math.round(v/1000)}k` : v} />
                  <Tooltip
                    contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 8, fontSize: 12, color: 'var(--theme-text1)' }}
                    labelStyle={{ color: 'var(--theme-text1)' }}
                    itemStyle={{ color: 'var(--theme-text1)' }}
                    formatter={(v) => [sortBy === 'revenue' ? fmt(v) : sortBy === 'margin' ? `${v}%` : v, sortBy === 'revenue' ? 'Revenue' : sortBy === 'qty' ? 'Qty Sold' : 'Margin']}
                  />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {chartData.map((_, i) => <Cell key={i} fill={i < 3 ? GOLD_HEX : GREEN_HEX} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            {/* Best sellers */}
            <div className="card">
              <h3 style={{ margin: '0 0 14px', fontSize: 14, color: GREEN }}>▲ Top 10 Performers</h3>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Item</th>
                      <th style={{ textAlign: 'right' }}>Qty</th>
                      <th style={{ textAlign: 'right' }}><Tip text="Total revenue = qty sold × selling price (ex-VAT).">Revenue</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Gross margin % = (Revenue − COGS) ÷ Revenue. Target: 60%+ for F&B." width={220}>Margin</Tip></th>
                    </tr>
                  </thead>
                  <tbody>
                    {top10.map((r, i) => (
                      <tr key={r.name}>
                        <td style={{ color: i < 3 ? GOLD : MUTED, fontWeight: i < 3 ? 700 : 400, width: 28 }}>{i + 1}</td>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                          {r.name}
                          <div style={{ fontSize: 11, color: MUTED, fontWeight: 400 }}>{r.category}</div>
                        </td>
                        <td style={{ textAlign: 'right', color: MUTED }}>{Math.round(r.qty).toLocaleString()}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(r.revenue)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: r.margin >= 60 ? GREEN : r.margin >= 40 ? GOLD : RED }}>
                          {r.margin.toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Worst sellers */}
            <div className="card">
              <h3 style={{ margin: '0 0 14px', fontSize: 14, color: RED }}>▼ Bottom 10 Performers</h3>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Item</th>
                      <th style={{ textAlign: 'right' }}>Qty</th>
                      <th style={{ textAlign: 'right' }}><Tip text="Total revenue = qty sold × selling price (ex-VAT).">Revenue</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Gross margin % = (Revenue − COGS) ÷ Revenue. Target: 60%+ for F&B." width={220}>Margin</Tip></th>
                    </tr>
                  </thead>
                  <tbody>
                    {bot10.map((r, i) => (
                      <tr key={r.name}>
                        <td style={{ color: MUTED, width: 28 }}>{i + 1}</td>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                          {r.name}
                          <div style={{ fontSize: 11, color: MUTED, fontWeight: 400 }}>{r.category}</div>
                        </td>
                        <td style={{ textAlign: 'right', color: MUTED }}>{Math.round(r.qty).toLocaleString()}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(r.revenue)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: r.margin >= 60 ? GREEN : r.margin >= 40 ? GOLD : RED }}>
                          {r.margin.toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Summary strip */}
          <div className="card" style={{ marginTop: 20, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            {[
              { label: 'Total Revenue',   val: fmt(rows.reduce((s, r) => s + r.revenue, 0)),  color: GREEN },
              { label: 'Total COGS',      val: fmt(rows.reduce((s, r) => s + r.cogs,    0)),  color: RED },
              { label: 'Gross Profit',    val: fmt(rows.reduce((s, r) => s + r.profit,  0)),  color: GOLD },
              { label: 'Overall Margin',  val: (() => { const rev = rows.reduce((s, r) => s + r.revenue, 0); const prof = rows.reduce((s, r) => s + r.profit, 0); return rev > 0 ? `${((prof/rev)*100).toFixed(1)}%` : '—' })(), color: GOLD },
              { label: 'Items Sold',      val: rows.length,                                   color: MUTED },
            ].map(s => (
              <div key={s.label}>
                <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{s.label}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.val}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
