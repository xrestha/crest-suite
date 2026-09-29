// Overheads: what a period's saved rows mean, and what Save writes (S792, COSTS-14).
//
// Save used to store only rows with an amount, so a month deliberately saved with no fixed costs
// (the shop was shut for Dashain, say) stored nothing at all — and the next visit read "nothing is
// saved yet", copied last month's rent and wages in as a draft, and built the page's P&L from them,
// while the Dashboard and the Owner Report read the month's saved zero. There was no way to record
// "zero this month".
//
// Owner-decided shape (no migration): a Save with nothing above zero stores ONE marker row at
// amount 0. Every other reader of `overheads` only SUMS `amount` (ClientDashboard, OwnerDashboard,
// computeMonthlyReport, ConsolidatedPnl, Recipes, get_group_pnl), so the marker changes no figure
// anywhere; this page reads amount-0 rows as "saved, nothing to show", never as editable lines.
// Pure: no React, no Supabase.

export const BUCKETS = ['overhead', 'labor', 'tax_fees']

/** The row Save stores when there is nothing above zero to store. */
export const NO_FIXED_COSTS_ROW = Object.freeze({
  bucket: 'overhead',
  category: 'No fixed costs',
  description: 'Saved with no fixed costs for this month',
  amount: 0,
})

/** A row that carries a figure. Zero or blank is not one — the marker, or a line with nothing in it. */
export const isFigureRow = r => {
  const n = parseFloat(r?.amount)
  return Number.isFinite(n) && n !== 0
}

/**
 * One period's saved rows, grouped by bucket for the page, figure rows only. `savedEmpty` is true
 * when the period HAS saved rows and none of them carries a figure: saved with no fixed costs, which
 * is a record, not an absence. An unknown bucket files under 'overhead', as it always has.
 */
export function groupSavedRows(rows) {
  const grouped = { overhead: [], labor: [], tax_fees: [] }
  const list = rows || []
  list.filter(isFigureRow).forEach(r => {
    const b = BUCKETS.includes(r.bucket) ? r.bucket : 'overhead'
    grouped[b].push({ ...r, _dirty: false })
  })
  return { grouped, savedEmpty: list.length > 0 && !list.some(isFigureRow) }
}

/**
 * The period a new month's draft is copied from: the nearest of `candidatePeriods` (nearest first)
 * with at least one figure row, and those rows only. A month saved with no fixed costs is skipped,
 * so the month after a closed-for-Dashain month carries from the last month with real figures
 * rather than from the empty one.
 */
export function nearestPeriodWithFigures(candidatePeriods, rows) {
  const byPeriod = new Map()
  ;(rows || []).forEach(r => {
    if (!isFigureRow(r)) return
    const list = byPeriod.get(r.period_id)
    if (list) list.push(r)
    else byPeriod.set(r.period_id, [r])
  })
  for (const p of candidatePeriods || []) {
    const found = byPeriod.get(p.id)
    if (found && found.length > 0) return { rows: found, period: p }
  }
  return { rows: null, period: null }
}

/**
 * What Save inserts for `periodId` from the rows on screen: every row with a category and an amount
 * above zero — and when there is none, the marker, so the month reads as saved with no fixed costs.
 */
export function overheadInserts(rowsByBucket, periodId) {
  const inserts = []
  Object.entries(rowsByBucket || {}).forEach(([bucket, bucketRows]) => {
    ;(bucketRows || [])
      .filter(r => r.category?.trim() && parseFloat(r.amount) > 0)
      .forEach(r => inserts.push({
        period_id: periodId,
        bucket,
        category: r.category.trim(),
        description: r.description?.trim() || '',
        amount: parseFloat(r.amount) || 0,
      }))
  })
  return inserts.length > 0 ? inserts : [{ period_id: periodId, ...NO_FIXED_COSTS_ROW }]
}
