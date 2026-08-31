import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useTheme } from '../../../context/ThemeContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import ReportLoadError from '../../../components/ReportLoadError'
import ChartCard from '../../../components/ChartCard'
import StatPill from '../../../components/StatPill'
import { printWithTitle } from '../../../utils/printTitle'
import { Navigate } from 'react-router-dom'
import {
  ComposedChart, LineChart, BarChart, Bar, Area, Line,
  XAxis, YAxis, CartesianGrid, ReferenceLine, Tooltip as RTooltip, ResponsiveContainer,
} from 'recharts'
import { chartMotion } from '../../../shared/chartMotion'
import { COGS_FORMULA, computeUsed, fcBand, fcThresholds } from '../../../shared/imsFormulas'
import { useSettings } from '../../../context/SettingsContext'
import { BS_MONTHS, BS_MONTHS_SHORT } from '../../../utils/bsCalendar'

// Fallback categorical rotation for any recipe category beyond Food/Beverage (which get fixed
// semantic colors) — mirrors the Dashboard's Sales Mix convention (ClientDashboard.jsx) so a
// category reads the same color everywhere in the app, duplicated locally since that constant
// lives in a page file.
const FALLBACK_HEX = ['#c9a84c', '#60a5fa', '#f87171', '#fb923c', '#22d3ee', '#f472b6', '#facc15', '#818cf8']

// `short` feeds the X axis and tooltip header of all three charts on this page. It used to be
// `m.slice(0, 3)`, which renders Ashadh AND Ashwin as "Ash" — two different months under one tick,
// same year on both, on 9 of the 12 possible 12-month windows.
function periodLabel(p, short) {
  return `${short ? BS_MONTHS_SHORT[p.bs_month - 1] : BS_MONTHS[p.bs_month - 1]} ${p.bs_year}`
}

// curr vs prev as a % change — null when there's no meaningful baseline to compare against
// (no prior period, or the prior value was zero, where a % change is undefined/infinite).
function pctDelta(curr, prev) {
  if (curr == null || prev == null || prev === 0) return null
  return ((curr - prev) / Math.abs(prev)) * 100
}

// Small inline "↑ 12.3% vs prev" line rendered under a table cell's headline value. `judge`
// controls whether an increase reads as good (revenue) or is left neutral (purchases — more
// spend isn't inherently bad, it might just mean more volume).
function DeltaRow({ pct, suffix, judge = 'neutral' }) {
  if (pct == null) return null
  const up = pct >= 0
  let color = 'var(--theme-text2)'
  if (judge === 'good-up')   color = up ? 'var(--theme-green-text)' : 'var(--theme-red-text)'
  if (judge === 'good-down') color = up ? 'var(--theme-red-text)'   : 'var(--theme-green-text)'
  return (
    <div style={{ fontSize: 11, color, marginTop: 1, fontStyle: suffix === 'vs LY' ? 'italic' : 'normal' }}>
      {up ? '↑' : '↓'} {Math.abs(pct).toFixed(1)}% {suffix}
    </div>
  )
}

// Same idea as DeltaRow but for a percentage-POINT difference (FC%'s own unit) rather than a %
// change — down is always "good" here since it means food cost fell as a share of revenue.
function PpDeltaRow({ curr, prev, suffix }) {
  if (curr == null || prev == null) return null
  const diff = curr - prev
  const color = diff < 0 ? 'var(--theme-green-text)' : diff > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)'
  return (
    <div style={{ fontSize: 11, color, marginTop: 1, fontStyle: suffix === 'vs LY' ? 'italic' : 'normal' }}>
      {diff < 0 ? '↓' : diff > 0 ? '↑' : '→'} {Math.abs(diff).toFixed(1)}pp {suffix}
    </div>
  )
}

export default function PeriodComparison() {
  const { clientId, profile, hasImsAccess } = useAuth()
  const { colors } = useTheme()
  const { settings } = useSettings()
  // Was a module-level hardcoded 30/38 scale; now the client's own thresholds, like every other
  // FC% surface (src/shared/imsFormulas.js).
  const fcColor = pct => fcBand(pct, settings).color
  // The band must not be carried by colour alone (S608) — see fcBand's note.
  const fcLabel = pct => fcBand(pct, settings).label
  const fcMark  = pct => fcBand(pct, settings).mark
  const fcT = fcThresholds(settings)
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const [periods, setPeriods] = useState([])
  const [stats, setStats]     = useState({})
  const [limit, setLimit]     = useState(12)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [showYoy, setShowYoy] = useState(false)

  useEffect(() => {
    if (!effectiveClientId) return
    scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .then(({ data, error }) => {
        if (error) { setLoadError(error.message); return }
        setPeriods(data || [])
      })
  }, [effectiveClientId, scopedFrom])

  useEffect(() => {
    if (periods.length > 0) fetchData()
  }, [periods, limit]) // eslint-disable-line

  function findYoy(p) {
    return periods.find(x => x.bs_year === p.bs_year - 1 && x.bs_month === p.bs_month) || null
  }

  async function fetchData() {
    setLoading(true)
    setLoadError(null)
    const shownList = periods.slice(0, limit)
    // Always pull each shown period's same-month-last-year twin too (if it exists) so toggling
    // "Compare vs last year" on doesn't need a re-fetch — it's the same bulk .in() queries either
    // way, just a few more ids in the IN list.
    const yoyList = shownList.map(findYoy).filter(Boolean)
    const ids = Array.from(new Set([...shownList.map(p => p.id), ...yoyList.map(p => p.id)]))
    if (!ids.length) { setLoading(false); return }

    const results = await Promise.all([
      fetchAllRows(() => supabase.from('purchase_entries').select('period_id, qty, rate').in('period_id', ids).order('id')),
      scopedFrom('vendor_returns', 'period_id, qty, rate').in('period_id', ids),
      fetchAllRows(() => supabase.from('wastages').select('period_id, qty, items(per_uom_rate)').in('period_id', ids).order('id')),
      // Staff meals belong in COGS (src/shared/imsFormulas.js) — omitted here until 2026-08-13,
      // which put this page's COGS and FC% below MonthlySummary's for the identical month.
      supabase.from('staff_meals').select('period_id, qty, items(per_uom_rate)').in('period_id', ids),
      supabase.from('opening_stock').select('period_id, qty, items(per_uom_rate)').in('period_id', ids),
      supabase.from('closing_stock').select('period_id, physical_qty, items(per_uom_rate)').in('period_id', ids),
      // Revenue excludes comps (source='pos_comp') — a comped dish was never paid for.
      // Paged like its purchase_entries sibling above: sales across up to 24 periods crosses
      // PostgREST's silent 1000-row cap easily (S528).
      fetchAllRows(() => supabase.from('sales_entries').select('period_id, qty_sold, unit_price, discount, recipes(selling_price, category)').in('period_id', ids).neq('source', 'pos_comp').order('id')),
    ])
    // A failed read must not render as a quiet run of NPR 0 periods (S612 silent-zero rule).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setStats({}); setLoading(false); return }
    const [
      { data: purchases },
      { data: returns },
      { data: wastes },
      { data: staffMeals },
      { data: openings },
      { data: closings },
      { data: sales },
    ] = results

    const result = {}
    for (const pid of ids) {
      const purchV   = (purchases||[]).filter(r=>r.period_id===pid).reduce((s,r)=>s+parseFloat(r.qty||0)*parseFloat(r.rate||0),0)
      const retV     = (returns||[]).filter(r=>r.period_id===pid).reduce((s,r)=>s+parseFloat(r.qty||0)*parseFloat(r.rate||0),0)
      const wasteV   = (wastes||[]).filter(r=>r.period_id===pid).reduce((s,r)=>s+parseFloat(r.qty||0)*parseFloat(r.items?.per_uom_rate||0),0)
      const staffV   = (staffMeals||[]).filter(r=>r.period_id===pid).reduce((s,r)=>s+parseFloat(r.qty||0)*parseFloat(r.items?.per_uom_rate||0),0)
      const openV    = (openings||[]).filter(r=>r.period_id===pid).reduce((s,r)=>s+parseFloat(r.qty||0)*parseFloat(r.items?.per_uom_rate||0),0)
      const closeV   = (closings||[]).filter(r=>r.period_id===pid).reduce((s,r)=>s+parseFloat(r.physical_qty||0)*parseFloat(r.items?.per_uom_rate||0),0)
      // Uses unit_price captured on the row (the price actually charged that period) when
      // present, falling back to the joined recipe's current price only for rows recorded before
      // that column existed — otherwise the "vs Prev" trend was comparing today's menu price
      // against itself across periods, not what was actually charged in each one.
      const periodSales = (sales||[]).filter(r=>r.period_id===pid&&(r.unit_price!=null||r.recipes?.selling_price))
      const revenue  = periodSales.reduce((s,r)=>{
        const price = r.unit_price != null ? parseFloat(r.unit_price) : parseFloat(r.recipes?.selling_price||0)
        return s + parseFloat(r.qty_sold||0) * price - (parseFloat(r.discount) || 0)
      },0)
      // Revenue by menu category (same recipes.category taxonomy as the Dashboard's Sales Mix
      // pie) — 'Sub-Recipe' rows are prep items, not menu sales, same exclusion the Dashboard's
      // Sales Mix logic uses.
      const catRev = {}
      periodSales.forEach(r => {
        const cat = r.recipes?.category
        if (!cat || cat === 'Sub-Recipe') return
        const price = r.unit_price != null ? parseFloat(r.unit_price) : parseFloat(r.recipes?.selling_price||0)
        const amt = parseFloat(r.qty_sold||0) * price - (parseFloat(r.discount) || 0)
        catRev[cat] = (catRev[cat] || 0) + amt
      })
      const netPurch = purchV - retV
      const cogs     = computeUsed({ opening: openV, purchases: netPurch, wastage: wasteV, staffMeals: staffV, closing: closeV })
      const fcPct    = revenue > 0 ? (cogs / revenue) * 100 : null
      result[pid]    = { purchV, retV, netPurch, wasteV, openV, closeV, revenue, cogs, fcPct, catRev }
    }
    setStats(result)
    setLoading(false)
  }

  const shown        = periods.slice(0, limit)
  const latestStats  = shown.length > 0 ? stats[shown[0]?.id] : null
  const prevStats    = shown.length > 1 ? stats[shown[1]?.id] : null
  const fcTrend      = latestStats?.fcPct != null && prevStats?.fcPct != null
    ? latestStats.fcPct - prevStats.fcPct
    : null

  const bestFcPeriod = shown.reduce((best, p) => {
    const s = stats[p.id]
    if (!s || s.fcPct == null) return best
    if (!best || s.fcPct < (stats[best.id]?.fcPct ?? Infinity)) return p
    return best
  }, null)

  const highestRevenuePeriod = shown.reduce((best, p) => {
    const s = stats[p.id]
    if (!s || !s.revenue) return best
    if (!best || s.revenue > (stats[best.id]?.revenue ?? -Infinity)) return p
    return best
  }, null)

  const highestPurchasePeriod = shown.reduce((best, p) => {
    const s = stats[p.id]
    if (!s || !s.netPurch) return best
    if (!best || s.netPurch > (stats[best.id]?.netPurch ?? -Infinity)) return p
    return best
  }, null)

  function fmt(n) {
    if (!n) return '—'
    return 'NPR ' + Number(n).toLocaleString('en-NP', { maximumFractionDigits: 0 })
  }

  function trendIcon(curr, prev) {
    if (curr == null || prev == null) return null
    const diff = curr - prev
    if (Math.abs(diff) < 0.3) return <span style={{ color: 'var(--theme-text2)' }}>→</span>
    // For FC%: down is better (lower cost)
    return diff < 0
      ? <span style={{ color: 'var(--theme-green-text)' }}>↓ {Math.abs(diff).toFixed(1)}pp</span>
      : <span style={{ color: 'var(--theme-red-text)' }}>↑ {Math.abs(diff).toFixed(1)}pp</span>
  }

  // Chart data, oldest → newest (the table itself stays newest-first, but a trend chart reads
  // left-to-right in time order).
  const chartPeriods = [...shown].reverse().map(p => {
    const s = stats[p.id] || {}
    return {
      label: periodLabel(p, true),
      purchases: s.netPurch ?? null,
      revenue: s.revenue ?? null,
      fc: s.fcPct != null ? Number(s.fcPct.toFixed(1)) : null,
      open: p.status === 'open',
    }
  })
  const hasChartData = chartPeriods.some(d => d.purchases != null || d.revenue != null)

  const catTotals = {}
  shown.forEach(p => {
    const cr = stats[p.id]?.catRev || {}
    Object.entries(cr).forEach(([c, v]) => { catTotals[c] = (catTotals[c] || 0) + v })
  })
  const categories = Object.keys(catTotals).sort((a, b) => catTotals[b] - catTotals[a])
  const categoryChartData = [...shown].reverse().map(p => {
    const cr = stats[p.id]?.catRev || {}
    const row = { label: periodLabel(p, true) }
    categories.forEach(c => { row[c] = cr[c] || 0 })
    return row
  })
  const colorOf = (() => {
    let next = 0
    const assigned = {}
    return (cat) => {
      if (assigned[cat]) return assigned[cat]
      if (cat === 'Food') return (assigned[cat] = colors.green)
      if (cat === 'Beverage') return (assigned[cat] = colors.purple)
      return (assigned[cat] = FALLBACK_HEX[next++ % FALLBACK_HEX.length])
    }
  })()

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb   = XLSX.utils.book_new()
    const data = shown.map((p, i) => {
      const s    = stats[p.id] || {}
      const prev = i < shown.length - 1 ? stats[shown[i + 1]?.id] : null
      const ly   = showYoy ? findYoy(p) : null
      const lyS  = ly ? stats[ly.id] : null
      const row = {
        'Period':                `${periodLabel(p)}`,
        'Status':                p.status.toUpperCase(),
        'Net Purchases (NPR)':   s.netPurch ? s.netPurch.toFixed(0) : '',
        'Purchases Δ% vs Prev':  (() => { const d = pctDelta(s.netPurch, prev?.netPurch); return d != null ? d.toFixed(1) + '%' : '' })(),
        'Wastage Value (NPR)':   s.wasteV   ? s.wasteV.toFixed(0)   : '',
        'COGS (NPR)':            s.cogs     ? s.cogs.toFixed(0)     : '',
        'Revenue ex-VAT (NPR)':  s.revenue  ? s.revenue.toFixed(0)  : '',
        'Revenue Δ% vs Prev':    (() => { const d = pctDelta(s.revenue, prev?.revenue); return d != null ? d.toFixed(1) + '%' : '' })(),
        'FC%':                   s.fcPct != null ? s.fcPct.toFixed(1) + '%' : '',
      }
      if (showYoy) {
        row['LY Net Purchases (NPR)'] = lyS?.netPurch ? lyS.netPurch.toFixed(0) : ''
        row['YoY Purchases Δ%']       = (() => { const d = pctDelta(s.netPurch, lyS?.netPurch); return d != null ? d.toFixed(1) + '%' : '' })()
        row['LY Revenue (NPR)']       = lyS?.revenue ? lyS.revenue.toFixed(0) : ''
        row['YoY Revenue Δ%']         = (() => { const d = pctDelta(s.revenue, lyS?.revenue); return d != null ? d.toFixed(1) + '%' : '' })()
        row['LY FC%']                 = lyS?.fcPct != null ? lyS.fcPct.toFixed(1) + '%' : ''
      }
      return row
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Period Comparison')
    if (categories.length > 0) {
      const catData = categoryChartData.map(row => ({
        Period: row.label,
        ...Object.fromEntries(categories.map(c => [c, Math.round(row[c] || 0)])),
      }))
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(catData), 'Revenue by Category')
    }
    XLSX.writeFile(wb, `PeriodComparison.xlsx`)
  }

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />

  return (
    <div className="page-container">

      <div className="print-only" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Period-over-Period Comparison</h2>
      </div>

      <div className="page-header page-header--split no-print">
        <div>
          <h1 className="page-title">Period-over-Period Comparison</h1>
          {/* No <PeriodScope> here, deliberately: this report's scope IS every period, so a chip
              naming one would contradict the table under it. Left as prose so the next sweep does
              not churn it. Same for OutstandingPayables, which is unbounded by period. */}
          <p className="page-subtitle">Net Purchases, Wastage, COGS, Revenue and FC% across all BS periods</p>
        </div>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* The label WRAPS the checkbox (implicit association) — it used to also carry
                htmlFor="period-f1", which pointed at the SELECT below, so the checkbox read as
                unnamed and the select was announced as "Compare vs last year" (S613). */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--theme-text2)', cursor: 'pointer' }}>
              <input type="checkbox" checked={showYoy} onChange={e => setShowYoy(e.target.checked)} />
              <Tip text="Adds an italic 'vs LY' line under each figure, comparing this period to the same BS month one year earlier — useful for spotting festival/seasonal swings a plain month-to-month view can't tell apart from real drift." width={280}>
                Compare vs last year
              </Tip>
            </label>
            <select id="period-f1" className="form-select" aria-label="How many periods to compare" value={limit} onChange={e => setLimit(Number(e.target.value))}>
              <option value={6}>Last 6 periods</option>
              <option value={12}>Last 12 periods</option>
              <option value={24}>Last 24 periods</option>
              <option value={9999}>All periods</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-ghost" onClick={() => printWithTitle('Period-over-Period Comparison')}>Print</button>
            <button className="btn btn-ghost" onClick={exportExcel} disabled={!shown.length}>Export Excel</button>
          </div>
        </div>
      </div>

      {loadError && <ReportLoadError error={loadError} />}

      {/* Stat cards — gated on !loading too: a stat computed from rows that have not arrived
          is NPR 0 wearing the confidence of a real figure (S594 rule). */}
      {!loadError && !loading && (
      <div className="stat-grid no-print">
        <div className="stat-card">
          <div className="stat-label">Latest FC%</div>
          <div className="stat-value" style={{ color: fcColor(latestStats?.fcPct) }} title={fcLabel(latestStats?.fcPct)}>
            {latestStats?.fcPct != null ? `${latestStats.fcPct.toFixed(1)}% ${fcMark(latestStats.fcPct)}` : '—'}
          </div>
          {fcTrend != null && (
            <div className="stat-label" style={{ marginTop: 4, color: fcTrend < 0 ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
              {fcTrend < 0 ? '↓' : '↑'} {Math.abs(fcTrend).toFixed(1)}pp vs prev period
            </div>
          )}
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Period with the lowest food cost % in the selected range." width={220}>Best FC% Period</Tip>
          </div>
          <div className="stat-value" style={{ fontSize: 14 }}>
            {bestFcPeriod ? periodLabel(bestFcPeriod) : '—'}
          </div>
          {bestFcPeriod && stats[bestFcPeriod.id]?.fcPct != null && (
            <div className="stat-label" style={{ marginTop: 4, color: 'var(--theme-green-text)' }}>
              {stats[bestFcPeriod.id].fcPct.toFixed(1)}%
            </div>
          )}
        </div>
        <div className="stat-card">
          <div className="stat-label">Latest Revenue</div>
          <div className="stat-value" style={{ fontSize: 16 }}>{fmt(latestStats?.revenue)}</div>
          <div className="stat-label" style={{ marginTop: 4 }}>ex-VAT</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Period with the highest revenue in the selected range." width={220}>Highest Revenue Period</Tip>
          </div>
          <div className="stat-value" style={{ fontSize: 14 }}>
            {highestRevenuePeriod ? periodLabel(highestRevenuePeriod) : '—'}
          </div>
          {highestRevenuePeriod && (
            <div className="stat-label" style={{ marginTop: 4, color: 'var(--theme-green-text)' }}>
              {fmt(stats[highestRevenuePeriod.id]?.revenue)}
            </div>
          )}
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Period with the highest net purchases in the selected range." width={220}>Highest Purchases Period</Tip>
          </div>
          <div className="stat-value" style={{ fontSize: 14 }}>
            {highestPurchasePeriod ? periodLabel(highestPurchasePeriod) : '—'}
          </div>
          {highestPurchasePeriod && (
            <div className="stat-label" style={{ marginTop: 4, color: 'var(--theme-accent-ink)' }}>
              {fmt(stats[highestPurchasePeriod.id]?.netPurch)}
            </div>
          )}
        </div>
      </div>
      )}

      {/* Trend charts */}
      {!loadError && !loading && hasChartData && (
        <div className="no-print" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14, marginBottom: 14 }}>
          <ChartCard
            title="Revenue vs Net Purchases — Period Trend"
            legend={<>
              {/* Swatch keeps the series colour, label carries the contrast — the whole string
                  coloured measured 2.74:1 on Rosé Dawn. Same split as StatPill's color/textColor. */}
              <span style={{ color: 'var(--theme-text2)' }}><span style={{ color: colors.accent }}>●</span> Purchases</span>
              <span style={{ color: 'var(--theme-text2)' }}><span style={{ color: colors.green }}>●</span> Revenue</span>
            </>}
            renderChart={h => {
              const big = h > 200
              const totalRevenue   = chartPeriods.reduce((s, d) => s + (d.revenue || 0), 0)
              const totalPurchases = chartPeriods.reduce((s, d) => s + (d.purchases || 0), 0)
              const chart = (
                <ResponsiveContainer width="100%" height={big ? h - 60 : h}>
                  <ComposedChart data={chartPeriods} margin={{ top: big ? 8 : 4, right: big ? 16 : 8, bottom: big ? 4 : 0, left: big ? 8 : 0 }}>
                    {big && (
                      <defs>
                        <linearGradient id="pcPurchasesFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={colors.accent} stopOpacity={0.28} />
                          <stop offset="100%" stopColor={colors.accent} stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="pcRevenueFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={colors.green} stopOpacity={0.28} />
                          <stop offset="100%" stopColor={colors.green} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                    )}
                    <CartesianGrid stroke={colors.border} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tick={{ fill: colors.text3, fontSize: big ? 11 : 9 }} tickLine={false} axisLine={false} interval={0} />
                    <YAxis tick={{ fill: colors.text3, fontSize: big ? 11 : 9 }} tickLine={false} axisLine={false} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} width={big ? 44 : 32} />
                    <RTooltip
                      contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', fontSize: big ? 12 : 11 }}
                      labelStyle={{ color: colors.text1 }}
                      formatter={(value, name) => [`NPR ${Math.round(Number(value)).toLocaleString()}`, name]}
                    />
                    {big ? (
                      <Area type="monotone" dataKey="purchases" name="Purchases" stroke={colors.accent} strokeWidth={2.5} fill="url(#pcPurchasesFill)" connectNulls dot={{ r: 3, fill: colors.accent, strokeWidth: 0 }} activeDot={{ r: 5, fill: colors.accent }} {...chartMotion()} />
                    ) : (
                      <Line type="monotone" dataKey="purchases" name="Purchases" stroke={colors.accent} strokeWidth={2} connectNulls dot={{ r: 2, fill: colors.accent, strokeWidth: 0 }} activeDot={{ r: 4, fill: colors.accent }} {...chartMotion()} />
                    )}
                    {big ? (
                      <Area type="monotone" dataKey="revenue" name="Revenue" stroke={colors.green} strokeWidth={2.5} fill="url(#pcRevenueFill)" connectNulls dot={{ r: 3, fill: colors.green, strokeWidth: 0 }} activeDot={{ r: 5, fill: colors.green }} {...chartMotion()} />
                    ) : (
                      <Line type="monotone" dataKey="revenue" name="Revenue" stroke={colors.green} strokeWidth={2} connectNulls dot={{ r: 2, fill: colors.green, strokeWidth: 0 }} activeDot={{ r: 4, fill: colors.green }} {...chartMotion()} />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              )
              return (
                <>
                  {big && (
                    <div className="chart-stat-strip" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                      <StatPill label="Total revenue" value={fmt(totalRevenue)} color={colors.green} />
                      <StatPill label="Total purchases" value={fmt(totalPurchases)} color={colors.accent} />
                      <StatPill label="Net position" value={fmt(totalRevenue - totalPurchases)} />
                      <StatPill label="Periods shown" value={chartPeriods.length} />
                    </div>
                  )}
                  {chart}
                </>
              )
            }}
          />

          <ChartCard
            title="Food Cost % — Period Trend"
            footer={
              <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 11, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--theme-green-text)' }}>● ≤{fcT.warn}% Good</span>
                <span style={{ color: 'var(--theme-amber-text)' }}>● {fcT.warn}–{fcT.critical}% Watch</span>
                <span style={{ color: 'var(--theme-red-text)' }}>● &gt;{fcT.critical}% High</span>
                <span style={{ marginLeft: 'auto', color: 'var(--theme-text2)' }}>⊙ = current open period</span>
              </div>
            }
            renderChart={h => (
              <ResponsiveContainer width="100%" height={h}>
                <LineChart data={chartPeriods} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={colors.border} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: colors.text3, fontSize: 10 }} tickLine={false} axisLine={false} interval={0} />
                  <YAxis tick={{ fill: colors.text3, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => `${v}%`} domain={['auto', 'auto']} width={36} />
                  {/* The legend below this chart always read the client's own thresholds while
                      these lines and the dots below stayed on the pre-S551 hardcoded 30/38 — so a
                      dot could sit above the line it was drawn against and still be painted green.
                      One source now, the same one fcBand() uses. */}
                  <ReferenceLine y={fcT.warn} stroke={colors.green} strokeDasharray="4 3" strokeOpacity={0.5} label={{ value: `${fcT.warn}%`, fill: colors.green, fontSize: 9, position: 'right' }} />
                  <ReferenceLine y={fcT.critical} stroke={colors.red} strokeDasharray="4 3" strokeOpacity={0.5} label={{ value: `${fcT.critical}%`, fill: colors.red, fontSize: 9, position: 'right' }} />
                  <RTooltip
                    contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', fontSize: 11, color: 'var(--theme-text1)' }}
                    labelStyle={{ color: 'var(--theme-text1)' }}
                    itemStyle={{ color: 'var(--theme-text1)' }}
                    formatter={(v, _n, props) => {
                      const p = props.payload
                      const lines = [`${v}%`]
                      if (p.purchases != null) lines.push(`Purchases: NPR ${p.purchases.toLocaleString('en-NP')}`)
                      if (p.revenue != null)   lines.push(`Revenue: NPR ${p.revenue.toLocaleString('en-NP')}`)
                      return [lines.join(' · '), 'Food Cost %']
                    }}
                  />
                  <Line type="monotone" dataKey="fc" strokeWidth={2} stroke={colors.accent} connectNulls={false} {...chartMotion()}
                    dot={(props) => {
                      const { cx, cy, payload } = props
                      const col = payload.fc == null ? colors.text3 : payload.fc <= fcT.warn ? colors.green : payload.fc <= fcT.critical ? colors.amber : colors.red
                      return <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={payload.open ? 5 : 3} fill={col} stroke={payload.open ? colors.text1 : 'none'} strokeWidth={1.5} />
                    }}
                    activeDot={{ r: 5, fill: colors.accent }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          />
        </div>
      )}

      {!loadError && !loading && categories.length > 0 && (
        <div className="no-print" style={{ marginBottom: 20 }}>
          <ChartCard
            title="Revenue by Category — Period Trend"
            legend={<div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {categories.map(c => <span key={c} style={{ color: 'var(--theme-text2)' }}><span style={{ color: colorOf(c) }}>●</span> {c}</span>)}
            </div>}
            smallHeight={200}
            renderChart={h => (
              <ResponsiveContainer width="100%" height={h}>
                <BarChart data={categoryChartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={colors.border} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: colors.text3, fontSize: 10 }} tickLine={false} axisLine={false} interval={0} />
                  <YAxis tick={{ fill: colors.text3, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} width={36} />
                  <RTooltip
                    contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', fontSize: 11 }}
                    formatter={(value, name) => [`NPR ${Math.round(Number(value)).toLocaleString()}`, name]}
                  />
                  {categories.map(c => (
                    <Bar key={c} dataKey={c} name={c} stackId="rev" fill={colorOf(c)} radius={c === categories[categories.length - 1] ? [3, 3, 0, 0] : 0} {...chartMotion()} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          />
        </div>
      )}

      {loadError ? null : loading ? (
        <div className="loading-state">Loading...</div>
      ) : shown.length === 0 ? (
        <div className="empty-state">No periods found.</div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Period</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Gross purchases minus vendor returns (NPR value). The line beneath shows the % change vs the previous period, and vs the same month last year when that toggle is on." width={280}>Net Purchases</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Total value of wastage logged in Stock Count (qty × per-unit rate)." width={240}>Wastage</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text={`${COGS_FORMULA}, in value.`} width={260}>COGS</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Qty Sold × Selling Price ex-VAT from Sales Entry. Shows — if no sales data entered for this period. The line beneath shows the % change vs the previous period, and vs the same month last year when that toggle is on." width={300}>Revenue (ex-VAT)</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="COGS ÷ Revenue. Green ≤30%, Amber 31–38%, Red >38%. Shows — when revenue is zero." width={260}>FC%</Tip>
                </th>
                <th style={{ textAlign: 'center' }}>
                  <Tip text="FC% change vs previous period. ↓ green = improving, ↑ red = worsening." width={240}>vs Prev</Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p, i) => {
                const s    = stats[p.id] || {}
                const prev = i < shown.length - 1 ? stats[shown[i + 1]?.id] : null
                const ly   = showYoy ? findYoy(p) : null
                const lyS  = ly ? stats[ly.id] : null
                return (
                  <tr key={p.id}>
                    <td>
                      <strong>{periodLabel(p)}</strong>
                      {p.status === 'open' && (
                        <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: 'var(--theme-green-text)', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: 'var(--radius-xs)', padding: '1px 5px' }}>
                          OPEN
                        </span>
                      )}
                      {showYoy && (
                        <div style={{ fontSize: 11, color: 'var(--theme-text3)', fontStyle: 'italic', marginTop: 2 }}>
                          {ly ? `LY: ${periodLabel(ly)}` : 'LY: no matching period'}
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {fmt(s.netPurch)}
                      <DeltaRow pct={pctDelta(s.netPurch, prev?.netPurch)} suffix="vs prev" judge="neutral" />
                      {showYoy && <DeltaRow pct={pctDelta(s.netPurch, lyS?.netPurch)} suffix="vs LY" judge="neutral" />}
                    </td>
                    <td style={{ textAlign: 'right', color: s.wasteV ? 'var(--theme-amber-text)' : 'var(--theme-text2)' }}>{fmt(s.wasteV)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(s.cogs)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {fmt(s.revenue)}
                      <DeltaRow pct={pctDelta(s.revenue, prev?.revenue)} suffix="vs prev" judge="good-up" />
                      {showYoy && <DeltaRow pct={pctDelta(s.revenue, lyS?.revenue)} suffix="vs LY" judge="good-up" />}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: fcColor(s.fcPct) }} title={fcLabel(s.fcPct)}>
                      {s.fcPct != null ? `${s.fcPct.toFixed(1)}% ${fcMark(s.fcPct)}` : '—'}
                      {showYoy && <PpDeltaRow curr={s.fcPct} prev={lyS?.fcPct} suffix="vs LY" />}
                    </td>
                    <td style={{ textAlign: 'center', fontSize: 13 }}>
                      {trendIcon(s.fcPct, prev?.fcPct)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
