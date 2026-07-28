import { useNavigate } from 'react-router-dom'
import PivotTable from '../../components/PivotTable'
import { useSalesPivotData } from './useSalesPivotData'

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString('en-NP')}`

// Dashboard-card wrapper around the generic PivotTable — Category × Day, top 6 categories by
// revenue × the most recent 7 days that actually have data (not necessarily the last 7 calendar
// days of the period, which could be mostly empty early in a month). Given the narrower column
// this card lives in, NPR is shown (not qty — qty doesn't roll up meaningfully across mixed
// categories the way NPR does).
//
// The day columns are DETAIL; the Period column is the real total. Those are different scopes on
// purpose, and getting that wrong was a live bug: `dayRows` drops bs_day 0 (Bulk Entry) rows, and
// `values` only ever received the 6 shown categories × 7 shown days — but PivotTable derived its
// row and grand totals from `values`, so a column headed TOTAL was really a 6-category, 7-day,
// bulk-excluding subtotal. On a client entering sales in bulk, or with sales earlier in the month
// than the last 7 active days, it read far below the period's actual revenue and did not tie to
// Sales Entry's Period Summary. Totals are now computed from ALL rows and passed in explicitly.
export default function SalesPivot({ activePeriod, posEnabled, title = 'Sales by Category' }) {
  const navigate = useNavigate()
  const { rows, loading } = useSalesPivotData({ activePeriod, posEnabled })

  if (loading) {
    return (
      <div className="card" style={{ padding: '14px 16px' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>{title}</div>
        <span className="skeleton" style={{ display: 'inline-block', width: '100%', height: '4em' }} />
      </div>
    )
  }

  // Empty only when there is no revenue AT ALL. A bulk-only client has no day rows but does have
  // sales, and used to get "No day-attributed sales yet this period" while the period showed real
  // revenue everywhere else — it now renders with no day columns and a populated Period column.
  if (rows.length === 0) {
    return (
      <div className="card" style={{ padding: '14px 16px' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>{title}</div>
        <p style={{ color: 'var(--theme-text3)', fontSize: 12, margin: 0 }}>No sales recorded yet this period.</p>
      </div>
    )
  }

  const dayRows = rows.filter(r => r.day > 0)

  // Period totals: EVERY row, bulk (day 0) included. Drives both which categories are worth
  // showing and the totals handed to PivotTable.
  const catTotals = {}
  rows.forEach(r => { catTotals[r.category] = (catTotals[r.category] || 0) + r.amount })
  const periodTotal = Object.values(catTotals).reduce((s, v) => s + v, 0)

  const topCategories = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([category]) => category)
  const hiddenCategories = Object.keys(catTotals).filter(c => !topCategories.includes(c))
  const hiddenTotal = hiddenCategories.reduce((s, c) => s + catTotals[c], 0)

  const recentDays = [...new Set(dayRows.map(r => r.day))].sort((a, b) => b - a).slice(0, 7).sort((a, b) => a - b)
  const olderDaysShown = [...new Set(dayRows.map(r => r.day))].length > recentDays.length
  const hasBulk = rows.some(r => r.day === 0)

  const values = {}
  dayRows.forEach(r => {
    if (!topCategories.includes(r.category) || !recentDays.includes(r.day)) return
    values[r.category] = values[r.category] || {}
    values[r.category][r.day] = (values[r.category][r.day] || 0) + r.amount
  })

  const pivotRows = topCategories.map(c => ({ key: c, label: c }))
  const pivotCols = recentDays.map(d => ({ key: d, label: String(d) }))

  // Spelled out whenever the Period column genuinely covers more than the visible cells, so the
  // rows not adding up across is read as scope rather than as a broken total.
  const scopeNotes = []
  if (olderDaysShown) scopeNotes.push(`day columns show the latest ${recentDays.length} days with sales`)
  if (hasBulk) scopeNotes.push('bulk entries have no day column')
  if (hiddenTotal > 0) scopeNotes.push(`${hiddenCategories.length} smaller categor${hiddenCategories.length === 1 ? 'y' : 'ies'} (${fmtNpr(hiddenTotal)}) not listed`)

  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h3 style={{ fontSize: 12, fontWeight: 600, margin: 0, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{title}</h3>
        <button
          className="btn btn-ghost" style={{ fontSize: 10, padding: '9px 12px' }}
          onClick={() => navigate(posEnabled ? '/pos/sales-report' : '/sales')}
        >
          View Full Report →
        </button>
      </div>
      <PivotTable
        rows={pivotRows} cols={pivotCols} values={values}
        rowHeader="Category" formatValue={fmtNpr}
        totalsHeader="Period" rowTotals={catTotals} grandTotal={periodTotal}
      />
      {scopeNotes.length > 0 && (
        <p style={{ color: 'var(--theme-text3)', fontSize: 10, margin: '8px 0 0', lineHeight: 1.5 }}>
          Period column covers the whole period — {scopeNotes.join('; ')}.
        </p>
      )}
    </div>
  )
}
