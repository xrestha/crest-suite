import { npr } from '../../shared/nepalMoney'
import { useNavigate } from 'react-router-dom'
import PivotTable from '../../components/PivotTable'
import { useSalesPivotData } from './useSalesPivotData'
import { BS_MONTHS, formatBsDay } from '../../utils/bsCalendar'
import { nepalBs, nepalTime } from '../../shared/nepalTime'

const fmtNpr = npr

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
//
// S814 4d (REPORTS-9): the two cards say what they count. The POS card is the till's bills after
// discount with VAT, a credit note a minus on the day it was issued (the Sales Report's rule), and
// how fresh it is; the manual card is hand-entered sales only, before VAT. Day columns name the
// month ("11th Ashwin"), as every period-scoped day column does.
const cardTitleStyle = { fontSize: 12, fontWeight: 600, margin: 0, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }
const subStyle = { color: 'var(--theme-text3)', fontSize: 11, margin: '2px 0 0', lineHeight: 1.4 }

export default function SalesPivot({ activePeriod, posEnabled, title, refreshKey = 0 }) {
  const navigate = useNavigate()
  const { rows, loading, error, asOf, refreshError } = useSalesPivotData({ activePeriod, posEnabled, refreshKey })

  const monthLabel = activePeriod ? `${BS_MONTHS[activePeriod.bs_month - 1]} ${activePeriod.bs_year}` : ''
  const heading = title || (posEnabled ? `POS sales by category${monthLabel ? ` — ${monthLabel}` : ''}` : 'Sales by Category')
  const basis = posEnabled
    ? `after discount, VAT included · credit notes on their issue day${asOf ? ` · as of ${nepalTime(asOf)}` : ''}`
    : 'hand-entered (Sales Entry), after discount, before VAT'
  // The open month can run past its own end (nobody has closed it yet); the till's bills from today
  // then belong to a month this card is not showing, and the card must say so rather than look short.
  const today = nepalBs(Date.now())
  const notThisMonth = posEnabled && activePeriod && today
    && (today.year !== activePeriod.bs_year || today.month !== activePeriod.bs_month)
  const header = (
    <div style={{ marginBottom: 10 }}>
      <h3 style={cardTitleStyle}>{heading}</h3>
      <p style={subStyle}>{basis}</p>
      {notThisMonth && (
        <p style={subStyle}>{BS_MONTHS[activePeriod.bs_month - 1]} is still the open month; today&apos;s bills are not in it.</p>
      )}
    </div>
  )

  if (loading) {
    return (
      <div className="card" style={{ padding: '14px 16px' }}>
        {header}
        <span className="skeleton" style={{ display: 'inline-block', width: '100%', height: '4em' }} />
      </div>
    )
  }

  // A failed read is not an empty period, and on this card the empty state reads as a fact about
  // the month's trading (S682).
  if (error) {
    return (
      <div className="card" style={{ padding: '14px 16px' }} role="alert">
        {header}
        <p style={{ color: 'var(--theme-red-text)', fontSize: 12, margin: 0 }}>
          Couldn't load this breakdown — nothing here is a real figure. Reload the page.
        </p>
      </div>
    )
  }

  // Empty only when there is no revenue AT ALL. A bulk-only client has no day rows but does have
  // sales, and used to get "No day-attributed sales yet this period" while the period showed real
  // revenue everywhere else — it now renders with no day columns and a populated Period column.
  if (rows.length === 0) {
    return (
      <div className="card" style={{ padding: '14px 16px' }}>
        {header}
        <p style={{ color: 'var(--theme-text3)', fontSize: 12, margin: 0 }}>
          {posEnabled ? 'No till sales yet this period.' : 'No hand-entered sales this period.'}
        </p>
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
  const pivotCols = recentDays.map(d => ({ key: d, label: formatBsDay(d, activePeriod?.bs_month) || String(d) }))

  // Spelled out whenever the Period column genuinely covers more than the visible cells, so the
  // rows not adding up across is read as scope rather than as a broken total.
  const scopeNotes = []
  if (olderDaysShown) scopeNotes.push(`day columns show the latest ${recentDays.length} days with sales`)
  if (hasBulk) scopeNotes.push('bulk entries have no day column')
  if (hiddenTotal !== 0) scopeNotes.push(`${hiddenCategories.length} smaller categor${hiddenCategories.length === 1 ? 'y' : 'ies'} (${fmtNpr(hiddenTotal)}) not listed`)

  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        {header}
        <button
          className="btn btn-ghost" style={{ fontSize: 10, padding: '9px 12px', flexShrink: 0 }}
          onClick={() => navigate(posEnabled ? '/pos/sales-report' : '/sales')}
        >
          View Full Report →
        </button>
      </div>
      {refreshError && (
        <p role="status" style={{ color: 'var(--theme-amber-text)', fontSize: 11, margin: '0 0 8px' }}>
          Couldn&apos;t refresh — these are the figures from {nepalTime(asOf)}.
        </p>
      )}
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
