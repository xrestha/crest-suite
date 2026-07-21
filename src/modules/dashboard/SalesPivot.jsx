import { useNavigate } from 'react-router-dom'
import PivotTable from '../../components/PivotTable'
import { useSalesPivotData } from './useSalesPivotData'

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString('en-NP')}`

// Dashboard-card wrapper around the generic PivotTable — Category × Day, top 6 categories by
// revenue × the most recent 7 days that actually have data (not necessarily the last 7 calendar
// days of the period, which could be mostly empty early in a month). Given the narrower column
// this card lives in, NPR is shown (not qty — qty doesn't roll up meaningfully across mixed
// categories the way NPR does), and the "Bulk" (non-day-attributed manual entries) bucket folds
// silently into row totals rather than getting its own column — that nuance belongs on the full
// report linked at the bottom, not a glanceable tile.
export default function SalesPivot({ activePeriod, posEnabled }) {
  const navigate = useNavigate()
  const { rows, loading } = useSalesPivotData({ activePeriod, posEnabled })

  if (loading) {
    return (
      <div className="card" style={{ padding: '14px 16px' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Sales by Category</div>
        <span className="skeleton" style={{ display: 'inline-block', width: '100%', height: '4em' }} />
      </div>
    )
  }

  const dayRows = rows.filter(r => r.day > 0)
  if (dayRows.length === 0) {
    return (
      <div className="card" style={{ padding: '14px 16px' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Sales by Category</div>
        <p style={{ color: 'var(--theme-text3)', fontSize: 12, margin: 0 }}>No day-attributed sales yet this period.</p>
      </div>
    )
  }

  const catTotals = {}
  dayRows.forEach(r => { catTotals[r.category] = (catTotals[r.category] || 0) + r.amount })
  const topCategories = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([category]) => category)

  const recentDays = [...new Set(dayRows.map(r => r.day))].sort((a, b) => b - a).slice(0, 7).sort((a, b) => a - b)

  const values = {}
  dayRows.forEach(r => {
    if (!topCategories.includes(r.category) || !recentDays.includes(r.day)) return
    values[r.category] = values[r.category] || {}
    values[r.category][r.day] = (values[r.category][r.day] || 0) + r.amount
  })

  const pivotRows = topCategories.map(c => ({ key: c, label: c }))
  const pivotCols = recentDays.map(d => ({ key: d, label: String(d) }))

  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h3 style={{ fontSize: 12, fontWeight: 600, margin: 0, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Sales by Category</h3>
        <button
          className="btn btn-ghost" style={{ fontSize: 10, padding: '9px 12px' }}
          onClick={() => navigate(posEnabled ? '/pos/sales-report' : '/sales')}
        >
          View Full Report →
        </button>
      </div>
      <PivotTable rows={pivotRows} cols={pivotCols} values={values} rowHeader="Category" formatValue={fmtNpr} />
    </div>
  )
}
