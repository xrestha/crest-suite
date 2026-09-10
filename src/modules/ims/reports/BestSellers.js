import { npr } from '../../../shared/nepalMoney'
import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { supabase } from '../../../supabaseClient'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { chartMotion } from '../../../shared/chartMotion'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import ChartCard from '../../../components/ChartCard'
import ReportLoadError from '../../../components/ReportLoadError'
import { computeRecipeCosts } from '../../../utils/recipeCost'
import { recipeCostOf, unratedReason } from '../../../shared/imsFormulas'
import { Navigate } from 'react-router-dom'
import { BS_MONTHS } from '../../../utils/bsCalendar'

// Recharts SVG props (fill, tick) don't resolve CSS vars — these fixed hexes back only
// the two chart call sites below; everything else uses the theme-token constants beneath.
const GOLD_HEX  = '#c9a84c'
const GREEN_HEX = '#34d399'
const MUTED_HEX = '#6b7280'

// Every one of these constants is only ever used as TEXT on this page (rank numbers, margin
// figures, the "% of total revenue" callout, KPI values), so they take the -text/-ink variants.
// The base tokens above stay on the chart, where they are fills.
const GOLD  = 'var(--theme-accent-ink)'
const GREEN = 'var(--theme-green-text)'
const RED   = 'var(--theme-red-text)'
const MUTED = 'var(--theme-text2)'

/**
 * The margin cell, written once because both tables render it and only one of them used to be
 * kept in step. A null margin is an em-dash carrying the reason, never a number: the previous form
 * (`r.margin >= 60 ? GREEN : …`) turned an uncosted dish's manufactured 100% into the greenest
 * figure on the page.
 */
function MarginCell({ row }) {
  if (row.margin == null) {
    return (
      <td style={{ textAlign: 'right', color: MUTED }} title={row.costReason || 'Margin needs a food cost and positive revenue'}>—</td>
    )
  }
  return (
    <td style={{ textAlign: 'right', fontWeight: 600, color: row.margin >= 60 ? GREEN : row.margin >= 40 ? GOLD : RED }}>
      {row.margin.toFixed(1)}%
    </td>
  )
}

export default function BestSellers() {
  const { clientId, profile, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const periodReq = useLatestRequest()
  const [periods, setPeriods]         = useState([])
  const [selectedPeriod, setSelected] = useState(null)
  const [rows, setRows]               = useState([])
  const [sortBy, setSortBy]           = useState('revenue') // 'revenue' | 'qty' | 'margin'
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [loading, setLoading]         = useState(false)
  const [loadError, setLoadError]     = useState(null)

  useEffect(() => {
    if (!effectiveClientId) return
    scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .then(({ data, error }) => {
        if (error) { setLoadError(error.message); return }
        setPeriods(data || [])
        if (data && data.length > 0) setSelected(data[0])
      })
  }, [effectiveClientId, scopedFrom])

  useEffect(() => {
    if (selectedPeriod) fetchData(selectedPeriod.id)
    setCategoryFilter('all')
  }, [selectedPeriod]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchData(periodId) {
    periodReq.begin(periodId)   // claim the page before any await (S601)
    setLoading(true)
    setLoadError(null)
    const results = await Promise.all([
      // "Best seller" ranks by real demand — comps (source='pos_comp') never sold at menu
      // price and would misleadingly inflate a heavily-comped item's qty/revenue rank.
      // Paged: a busy month's sales_entries can cross PostgREST's silent 1000-row cap (S528).
      //
      // `source` is SELECTED and comps filtered in JS, never `.neq('source', …)` (S724). The
      // column is nullable — DEFAULT 'manual', no NOT NULL — and `NULL <> 'pos_comp'` is NULL
      // rather than true, so the server-side form drops every legacy row silently. This page's
      // figure is a RANK, which is why it stopped being one of the ~12 left on the old form:
      // a short qty for one dish does not shorten a column, it moves that dish DOWN the order,
      // and the guide's own advice for the bottom of that order is "candidates for menu
      // removal". A dish deleted off the menu because rows nobody was shown went missing.
      fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, unit_price, discount, source').eq('period_id', periodId).order('id')),
      // NULL-safe (S714): .neq on a nullable column drops NULL rows too, so an uncategorised
      // dish was missing from the ranking with nothing to say a row had been filtered out.
      // `cost_price` is the manual cost Menu Pricing's + Add Item writes — without it a dish
      // costed by hand read as costed there and uncosted here, i.e. 100% margin (S724).
      scopedFrom('recipes', 'id, name, category, selling_price, cost_price').or('category.is.null,category.neq.Sub-Recipe'),
    ])
    // A failed read must not rank a confident NPR 0 (S612 silent-zero rule).
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setRows([]); setLoading(false); return }
    const [{ data: entries }, { data: recipes }] = results

    // computeRecipeCosts recurses through sub-recipe ingredients and applies yield_pct — a
    // hand-rolled costMap reading only direct item_id ingredients (as this used to) silently
    // costs any sub-recipe-based ingredient at zero, understating COGS/inflating margin here.
    const recipeIds = (recipes || []).map(r => r.id)
    // computeRecipeCosts THROWS on a failed read (S695/S711) and this call site did not catch
    // it, so a dead `items` read rejected the loader's promise before `setLoading(false)` and
    // left the page on the loading state indefinitely — no error card, nothing to retry (S715).
    let costMap = {}
    try {
      if (recipeIds.length > 0) costMap = await computeRecipeCosts(supabase, recipeIds)
    } catch (err) {
      if (!periodReq.isCurrent(periodId)) return
      setLoadError(err); setRows([]); setLoading(false); return
    }

    const currentPriceMap = {}
    ;(recipes || []).forEach(r => { currentPriceMap[r.id] = parseFloat(r.selling_price || 0) })

    // unit_price captured on the row (price actually charged) is used per-row when present, else
    // that specific row falls back to the recipe's current price — previously this report always
    // used the recipe's current price for every row, so past-period revenue silently shifted
    // whenever a menu price changed later.
    const qtyMap = {}, revenueMap = {}
    for (const e of entries || []) {
      if (e.source === 'pos_comp') continue   // see the read above — filtered here, not server-side
      const qty = parseFloat(e.qty_sold || 0)
      const price = e.unit_price != null ? parseFloat(e.unit_price) : (currentPriceMap[e.recipe_id] || 0)
      qtyMap[e.recipe_id] = (qtyMap[e.recipe_id] || 0) + qty
      revenueMap[e.recipe_id] = (revenueMap[e.recipe_id] || 0) + qty * price - (parseFloat(e.discount) || 0)
    }

    const built = (recipes || [])
      .filter(r => qtyMap[r.id] > 0)
      .map(r => {
        const qty      = qtyMap[r.id] || 0
        const revenue  = revenueMap[r.id] || 0
        // null, never 0, when nothing has costed this dish (S724). `cost = costMap[r.id] || 0`
        // made COGS 0, profit the whole of revenue and margin a flat **100%** — coloured green,
        // sorted to the top of "By Margin %", and added to Gross Profit as if it were real. A
        // dish nobody has costed is not the most profitable thing on the menu; it is a dish
        // nobody has costed, and `Recipes.js`'s own + New Recipe creates one on every click.
        const cost     = recipeCostOf(costMap, r)
        const cogs     = cost == null ? null : qty * cost
        const profit   = cost == null ? null : revenue - cogs
        // Revenue must be positive for the ratio to mean anything: a fully-discounted dish, or one
        // a Credit Note has reversed past zero, produces a percentage whose sign is noise.
        const margin   = (cost != null && revenue > 0) ? (profit / revenue) * 100 : null
        return {
          name: r.name, category: r.category, qty, revenue, cogs, profit, margin,
          costReason: cost == null ? unratedReason(0, currentPriceMap[r.id]) : null,
        }
      })

    setRows(built)
    setLoading(false)
  }

  const categories = [...new Set(rows.map(r => r.category).filter(Boolean))].sort()
  const filteredRows = categoryFilter === 'all' ? rows : rows.filter(r => r.category === categoryFilter)

  // Only rows that HAVE the active metric can be ranked by it. On Revenue and Volume that is every
  // row; on Margin % it excludes the uncosted ones, which is the whole point — they used to arrive
  // here as a confident 100% and take the top of the chart and the table.
  const ranked = [...filteredRows]
    .filter(r => r[sortBy] != null)
    .sort((a, b) => b[sortBy] - a[sortBy])
  const unrankable = filteredRows.length - ranked.length

  const top10 = ranked.slice(0, 10)
  // The bottom list starts AFTER the top one. It used to be `[...sorted].reverse().slice(0, 10)`,
  // the bottom of the whole list — so with 12 dishes sold, eight of them appeared in both panels,
  // each one simultaneously a "Top 10 Performer" and a "Bottom 10 Performer" (S724). The module
  // guide has recorded the overlap as a gotcha since the page was written; the page never said it.
  const botStart = Math.max(10, ranked.length - 10)
  const bot10 = ranked.slice(botStart).reverse()

  const chartData = top10.map(r => ({
    name: r.name.length > 14 ? r.name.slice(0, 13) + '…' : r.name,
    value: sortBy === 'qty' ? r.qty : sortBy === 'margin' ? parseFloat(r.margin.toFixed(1)) : Math.round(r.revenue),
  }))

  const fmt = npr
  const periodLabel = (p) => p ? `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}` : ''

  // Top-10 chart footer stat — shown inside the ChartCard modal too, so the "how does the top 10
  // compare to everything" context (otherwise only in the page-level Summary strip below) survives
  // when the chart is expanded full-screen. What it shows adapts to the active sort, since summing
  // margin % across items isn't meaningful the way summing revenue/qty is.
  const totalRevenueAll = filteredRows.reduce((s, r) => s + r.revenue, 0)
  const totalQtyAll = filteredRows.reduce((s, r) => s + r.qty, 0)
  const top10Revenue = top10.reduce((s, r) => s + r.revenue, 0)
  const top10Qty = top10.reduce((s, r) => s + r.qty, 0)
  // Both of these are SIMPLE averages of each dish's own margin, and both are now taken over the
  // same population — `overallAvgMargin` used to average `filteredRows` while the sentence beside
  // it counted `rows`, so under a category filter the number was the category's and the count was
  // the whole menu's. They are also deliberately NOT the same figure as the Summary strip's
  // "Overall Margin", which is revenue-weighted; the two disagree by design and each says so.
  // Computed over the costed rows explicitly rather than over `ranked`: `ranked` only excludes
  // null margins while the Margin sort is active, so under Revenue or Volume these would sum a
  // null into NaN — unrendered today, and one `&&` away from being rendered tomorrow.
  const avgMarginOf = (list) => {
    const withMargin = list.filter(r => r.margin != null)
    return withMargin.length > 0 ? withMargin.reduce((s, r) => s + r.margin, 0) / withMargin.length : 0
  }
  const top10AvgMargin = avgMarginOf(top10)
  const overallAvgMargin = avgMarginOf(ranked)

  // COGS, Gross Profit and Overall Margin can only be summed over dishes that HAVE a cost. An
  // uncosted dish contributes its revenue and no COGS, which does not read as missing data — it
  // reads as an unusually profitable month.
  const costedRows = filteredRows.filter(r => r.cogs != null)
  const uncostedCount = filteredRows.length - costedRows.length
  const costedRevenue = costedRows.reduce((s, r) => s + r.revenue, 0)
  const costedCogs = costedRows.reduce((s, r) => s + r.cogs, 0)
  const costedProfit = costedRows.reduce((s, r) => s + r.profit, 0)

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Best &amp; Worst Sellers</h1>
          <p className="page-subtitle">Rank menu items by revenue, volume, or margin</p>
          <div className="page-scope-row">
            <PeriodScope label={periodLabel(selectedPeriod)} status={selectedPeriod?.status} />
          </div>
        </div>
      </div>

      {loadError && <ReportLoadError error={loadError} />}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 20, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select aria-label="Period" className="form-select" value={selectedPeriod?.id || ''} onChange={e => setSelected(periods.find(p => p.id === e.target.value))}>
            {periods.map(p => <option key={p.id} value={p.id}>{periodLabel(p)}</option>)}
          </select>
          {categories.length > 0 && (
            <select aria-label="Filter by category" className="form-select" value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
              <option value="all">All Categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>
        <div className="tab-bar">
          <button className={`tab-btn${sortBy === 'revenue' ? ' tab-btn--active' : ''}`} onClick={() => setSortBy('revenue')}>By Revenue</button>
          <button className={`tab-btn${sortBy === 'qty'     ? ' tab-btn--active' : ''}`} onClick={() => setSortBy('qty')}>By Volume</button>
          <button className={`tab-btn${sortBy === 'margin'  ? ' tab-btn--active' : ''}`} onClick={() => setSortBy('margin')}>By Margin %</button>
        </div>
        {!loading && filteredRows.length > 0 && (
          <span style={{ fontSize: 13, color: MUTED, marginLeft: 'auto' }}>{filteredRows.length} items sold this period</span>
        )}
      </div>

      {loadError ? null : loading ? (
        <p style={{ color: MUTED, fontSize: 13 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">◈</div>
            <p className="empty-state-text">No sales data for this period.</p>
          </div>
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">◈</div>
            <p className="empty-state-text">No sales in this category for this period.</p>
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
            footer={
              <div style={{ fontSize: 11, color: MUTED, marginTop: 8 }}>
                {sortBy === 'revenue' && totalRevenueAll > 0 && (
                  <>Top 10 = <strong style={{ color: 'var(--theme-text1)' }}>{fmt(top10Revenue)}</strong> · <span style={{ color: GOLD, fontWeight: 600 }}>{((top10Revenue / totalRevenueAll) * 100).toFixed(0)}%</span> of total revenue</>
                )}
                {sortBy === 'qty' && totalQtyAll > 0 && (
                  <>Top 10 = <strong style={{ color: 'var(--theme-text1)' }}>{Math.round(top10Qty).toLocaleString('en-IN')} units</strong> · <span style={{ color: GOLD, fontWeight: 600 }}>{((top10Qty / totalQtyAll) * 100).toFixed(0)}%</span> of total volume sold</>
                )}
                {sortBy === 'margin' && (
                  <>Top 10 average margin <strong style={{ color: 'var(--theme-text1)' }}>{top10AvgMargin.toFixed(1)}%</strong> vs <span style={{ color: MUTED }}>{overallAvgMargin.toFixed(1)}%</span> across all {ranked.length} costed items · simple average of each dish's margin</>
                )}
              </div>
            }
            renderChart={h => (
              <ResponsiveContainer width="100%" height={h}>
                <BarChart data={chartData} margin={{ top: 0, right: 10, left: 0, bottom: h > 200 ? 60 : 40 }}>
                  <XAxis dataKey="name" tick={{ fill: MUTED_HEX, fontSize: 11 }} angle={-30} textAnchor="end" interval={0} />
                  <YAxis tick={{ fill: MUTED_HEX, fontSize: 11 }} tickFormatter={v => sortBy === 'revenue' ? `${Math.round(v/1000)}k` : v} />
                  <Tooltip
                    contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', fontSize: 12, color: 'var(--theme-text1)' }}
                    labelStyle={{ color: 'var(--theme-text1)' }}
                    itemStyle={{ color: 'var(--theme-text1)' }}
                    formatter={(v) => [sortBy === 'revenue' ? fmt(v) : sortBy === 'margin' ? `${v}%` : v, sortBy === 'revenue' ? 'Revenue' : sortBy === 'qty' ? 'Qty Sold' : 'Margin']}
                  />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} {...chartMotion()}>
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
                      <th style={{ textAlign: 'right' }}><Tip text="Revenue, ex-VAT: each sale valued at the price actually charged on it, less discounts. A sale recorded before Crest started capturing that price falls back to the dish's current selling price." width={280}>Revenue</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Gross margin % = (Revenue − COGS) ÷ Revenue. Target: 60%+ for F&B. Shows — for a dish with no costed ingredients and no manual cost, because there is no COGS to subtract." width={260}>Margin</Tip></th>
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
                        <td style={{ textAlign: 'right', color: MUTED }}>{Math.round(r.qty).toLocaleString('en-IN')}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(r.revenue)}</td>
                        <MarginCell row={r} />
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
                      <th style={{ textAlign: 'right' }}><Tip text="Revenue, ex-VAT: each sale valued at the price actually charged on it, less discounts. A sale recorded before Crest started capturing that price falls back to the dish's current selling price." width={280}>Revenue</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Gross margin % = (Revenue − COGS) ÷ Revenue. Target: 60%+ for F&B. Shows — for a dish with no costed ingredients and no manual cost, because there is no COGS to subtract." width={260}>Margin</Tip></th>
                    </tr>
                  </thead>
                  <tbody>
                    {bot10.map((r, i) => (
                      <tr key={r.name}>
                        {/* The dish's real position in the ranking, not its position in this
                            panel — a "1" here used to sit under a heading that means last. */}
                        <td style={{ color: MUTED, width: 28 }}>{ranked.length - i}</td>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                          {r.name}
                          <div style={{ fontSize: 11, color: MUTED, fontWeight: 400 }}>{r.category}</div>
                        </td>
                        <td style={{ textAlign: 'right', color: MUTED }}>{Math.round(r.qty).toLocaleString('en-IN')}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(r.revenue)}</td>
                        <MarginCell row={r} />
                      </tr>
                    ))}
                  </tbody>
                </table>
                {bot10.length === 0 && (
                  <p style={{ fontSize: 12, color: MUTED, margin: '10px 2px 0' }}>
                    Every item sold this period is already in the Top 10 — there is no separate bottom to show.
                  </p>
                )}
              </div>
            </div>
          </div>

          {unrankable > 0 && sortBy === 'margin' && (
            <p style={{ fontSize: 12, color: MUTED, marginTop: 12 }}>
              {unrankable} {unrankable === 1 ? 'dish is' : 'dishes are'} not ranked here — margin needs a food cost, and
              {unrankable === 1 ? ' it has' : ' they have'} neither costed ingredients nor a manual cost. Add one in Recipe Costing or Menu Pricing.
            </p>
          )}

          {/* Summary strip. Revenue and Items Sold span every dish; the three cost-derived figures
              span only the costed ones and say so, rather than counting an uncosted dish's revenue
              against no COGS and reporting the difference as profit. */}
          <div className="card" style={{ marginTop: 20, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            {[
              { label: 'Total Revenue',  tip: 'Every dish sold this period, valued at the price actually charged, less discounts.',
                val: fmt(totalRevenueAll), color: GREEN },
              { label: 'Total COGS',     tip: 'Ingredient cost of the dishes that have one. Dishes with no cost are left out of this and of the two figures beside it.',
                val: fmt(costedCogs), color: RED },
              { label: 'Gross Profit',   tip: 'Revenue − COGS across the costed dishes only.',
                val: fmt(costedProfit), color: GOLD },
              { label: 'Overall Margin', tip: 'Gross Profit ÷ Revenue across the costed dishes — weighted by revenue, so a high-volume dish moves it more than a rarely-ordered one. The chart footer shows the unweighted average instead, and the two will not match.',
                val: costedRevenue > 0 ? `${((costedProfit / costedRevenue) * 100).toFixed(1)}%` : '—', color: GOLD },
              { label: 'Items Sold',     tip: 'Distinct menu items with at least one sale this period.',
                val: filteredRows.length, color: MUTED },
            ].map(s => (
              <div key={s.label}>
                <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                  <Tip text={s.tip} width={280}>{s.label}</Tip>
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>{s.val}</div>
              </div>
            ))}
          </div>
          {uncostedCount > 0 && (
            <p style={{ fontSize: 12, color: MUTED, marginTop: 10 }}>
              COGS, Gross Profit and Overall Margin cover {costedRows.length} of {filteredRows.length} items
              — {uncostedCount} {uncostedCount === 1 ? 'has' : 'have'} no food cost recorded, so {uncostedCount === 1 ? 'its' : 'their'} revenue
              is counted above while {uncostedCount === 1 ? 'its' : 'their'} cost is not known.
            </p>
          )}
        </>
      )}
    </div>
  )
}
