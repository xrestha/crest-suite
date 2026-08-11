import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { chartMotion } from '../../shared/chartMotion'
import { useTheme } from '../../context/ThemeContext'
import ChartCard from '../../components/ChartCard'
import StatPill from '../../components/StatPill'
import { useFoodBeverageSplit } from './useFoodBeverageSplit'

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString('en-NP')}`

// Fallback categorical rotation for any category beyond Food/Beverage (which get fixed semantic
// colors below) — mirrors ClientDashboard.jsx's own CHART_COLORS array for the same "Spend by
// Category" visual language, duplicated locally rather than imported since that constant lives in
// a page file, not a shared module.
const FALLBACK_HEX = ['#c9a84c', '#60a5fa', '#f87171', '#fb923c', '#22d3ee', '#f472b6', '#facc15', '#818cf8']

// Pie chart summarizing this period's revenue by menu category — combines whichever of the manual
// (sales_entries) and POS (pos_order_items) sources apply, so it reads as one total regardless of
// how many sales channels this client has active. Shows every real category present (the same set
// SalesPivot.jsx's Category × Day table shows), not a collapsed Food/Beverage/Other split. Wrapped
// in ChartCard (S487) for the same expand-to-modal + stat-strip treatment every other dashboard
// chart already has (S484/S486) — the little pie alone couldn't show a percent-on-slice label or
// the summary stats at dashboard-tile size, only once expanded.
export default function FoodBeverageSplit({ activePeriod, includeManual, includePos }) {
  const { colors } = useTheme()
  const { buckets, loading } = useFoodBeverageSplit({ activePeriod, includeManual, includePos })
  const categories = Object.keys(buckets).filter(c => buckets[c] > 0).sort((a, b) => buckets[b] - buckets[a])
  const total = categories.reduce((s, c) => s + buckets[c], 0)

  const colorOf = (() => {
    let nextFallback = 0
    const assigned = {}
    return (cat) => {
      if (assigned[cat]) return assigned[cat]
      if (cat === 'Food') return (assigned[cat] = colors.green)
      if (cat === 'Beverage') return (assigned[cat] = colors.purple)
      return (assigned[cat] = FALLBACK_HEX[nextFallback++ % FALLBACK_HEX.length])
    }
  })()

  if (loading) {
    return (
      <div className="card" style={{ padding: '14px 16px' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Sales Mix</div>
        <span className="skeleton" style={{ display: 'inline-block', width: '100%', height: '4em' }} />
      </div>
    )
  }

  if (total <= 0) return null

  const pieData = categories.map(c => ({ name: c, value: buckets[c] }))
  const summary = `Sales mix this period: ${categories.map(c => `${c} NPR ${Math.round(buckets[c]).toLocaleString('en-NP')} (${((buckets[c] / total) * 100).toFixed(0)}%)`).join(', ')}.`

  return (
    <ChartCard
      title="Sales Mix"
      smallHeight={140}
      footer={<p className="sr-only">{summary}</p>}
      renderChart={h => {
        const big = h > 200
        return (
          <>
            {big && (
              <div className="chart-stat-strip" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                <StatPill label="Total revenue" value={fmtNpr(total)} />
                <StatPill label="Top category" value={`${categories[0]} (${((buckets[categories[0]] / total) * 100).toFixed(0)}%)`} color={colorOf(categories[0])} />
                <StatPill label="Categories" value={categories.length} />
              </div>
            )}
            <ResponsiveContainer width="100%" height={big ? h - 60 : h}>
              <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                <Pie
                  {...chartMotion()}
                  data={pieData} dataKey="value" nameKey="name"
                  cx="50%" cy="50%"
                  innerRadius={big ? 80 : 38} outerRadius={big ? 140 : 60}
                  paddingAngle={2}
                  {...(big ? {
                    label: ({ percent }) => `${(percent * 100).toFixed(0)}%`,
                    labelLine: { stroke: colors.text3, strokeWidth: 1 },
                  } : {})}
                >
                  {pieData.map(entry => <Cell key={entry.name} fill={colorOf(entry.name)} />)}
                </Pie>
                <Tooltip
                  contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, fontSize: 11 }}
                  formatter={(v, name) => [`${fmtNpr(v)} (${((v / total) * 100).toFixed(1)}%)`, name]}
                />
              </PieChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
              {categories.map(cat => {
                const amount = buckets[cat]
                const pct = (amount / total) * 100
                return (
                  <div key={cat} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--theme-text1)' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: colorOf(cat), flexShrink: 0 }} />
                      {cat}
                    </span>
                    <span style={{ color: 'var(--theme-text2)' }}>{fmtNpr(amount)} · {pct.toFixed(0)}%</span>
                  </div>
                )
              })}
            </div>
          </>
        )
      }}
    />
  )
}
