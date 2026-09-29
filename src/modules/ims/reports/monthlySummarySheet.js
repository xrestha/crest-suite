// Monthly Summary's Excel workbook, and the few sentences the page and the sheet must share
// (S792, FIGURES-10).
//
// Help has told owners since the page was written to "Export to Excel for your accountant" from
// Monthly Summary, and the page had only a Print button — the one month-end report in IMS with no
// workbook, while the P&L beside it had one. The sheet is built HERE, as plain rows, so the row
// order, the labels and the TOTAL can be tested without a browser; the page only does the
// `await import('xlsx')` and the file write.
//
// It carries what the page shows, in the page's order and under the page's labels: the headline
// figures (the KPI row, then the food-cost box) on a Summary sheet, then the Category Breakdown
// table with its TOTAL row. The verdict under Food Cost %, the "% of revenue" line under COGS and
// the rule for when the uncounted items are named are exported from this file and read by the page
// too, so a mailed workbook cannot say something the screen did not.
import { COGS_FORMULA, fcBand } from '../../../shared/imsFormulas'
import { gapNote } from '../../../shared/uncountedItems'
import { SPEND_LABEL, SPEND_SO_FAR_LABEL } from './foodCostBasis'

/**
 * Whether the FC% verdict is withheld (S756): D7, the month is still OPEN (closing stock is counted
 * at month end, so COGS counts every shelf as used), or D6, a MATERIAL share of its stock was never
 * counted. Either is enough. The figure still prints; only the colour, the mark and the sentence go.
 */
export function verdictWithheld(periodStatus, gap) {
  return periodStatus === 'open' || !!gap?.material
}

/**
 * Whether the uncounted items are NAMED (the banner, the per-category badges, the sheet's column and
 * note): always on a closed month; on an open month only once counting has begun, since before that
 * every item is uncounted and the provisional line already says why.
 */
export function uncountedNamed(gap, periodStatus) {
  if (!gap) return false
  return periodStatus !== 'open' || gap.uncountedCount < gap.presentCount
}

/**
 * The food-cost box's band. A withheld verdict takes the neutral 'unjudged' key, so the tint, the
 * figure and the sentence all drop the verdict together (S720's rule: check what is touching a
 * banded figure). No sales keeps 'none'.
 */
export function foodCostVerdict(fcPct, settings, { withhold = false } = {}) {
  const judged = fcBand(fcPct, settings)
  return withhold && judged.key !== 'none' ? { ...judged, key: 'unjudged' } : judged
}

/** The sentence under Food Cost %, on the page and in the sheet's Note column. */
export function foodCostSentence(verdict, periodStatus) {
  if (verdict.key === 'none') return 'Add sales entries to calculate'
  if (verdict.key === 'unjudged') return periodStatus === 'open' ? 'Not judged: month still open' : 'Not judged: count incomplete'
  if (verdict.key === 'good') return `✓ Within your target (≤${verdict.warn}%)`
  if (verdict.key === 'watch') return `△ Above target — review purchases (${verdict.warn}–${verdict.critical}%)`
  return `▲ Critical — immediate review needed (>${verdict.critical}%)`
}

/** The line under the COGS tile: its share of revenue, or why there is none. */
export function cogsShareLine(fcPct, withhold) {
  return fcPct != null ? `${fcPct.toFixed(1)}% of revenue${withhold ? ' · not judged' : ''}` : 'No sales data'
}

// A money cell is a NUMBER to the paisa (vendor-payables.md, S725): a string does not sum, and
// whole rupees per row would let the column drift a few rupees off its own TOTAL. `|| 0` folds -0.
const money = v => Number((Number(v) || 0).toFixed(2)) || 0
const pct1 = v => (v == null || !Number.isFinite(v) ? '' : Number(v.toFixed(1)))

/**
 * Everything the export needs, from the page's own `report` and the period it was built for.
 *
 * @param {object} report       MonthlySummary's report state (catRows, the totals, fcPct,
 *                              purchaseFcPct, gap)
 * @param {object} args
 * @param {string} args.periodLabel   e.g. "Bhadra 2082"
 * @param {string} args.periodStatus  'open' | 'closed'
 * @param {object} args.settings      the client's settings row (fc thresholds)
 * @returns {{ scopeLine, notes, summaryRows, categoryRows, filename }}
 */
export function buildMonthlySummaryWorkbook(report, { periodLabel, periodStatus, settings }) {
  const open = periodStatus === 'open'
  const withhold = verdictWithheld(periodStatus, report.gap)
  const named = uncountedNamed(report.gap, periodStatus)
  const verdict = foodCostVerdict(report.fcPct, settings, { withhold })

  // The provisional marker rides on the scope line, the one line sheetWithLetterhead requires, so it
  // cannot be dropped from the sheet without dropping the period with it.
  const scopeLine = `Period : ${periodLabel}${open
    ? ' — PROVISIONAL: month still open, closing stock not counted yet, so food cost reads high until the month is closed'
    : ' (closed)'} · all categories, sub-recipes (prep items) excluded`

  const notes = [
    ...(named && gapNote(report.gap, periodLabel) ? [gapNote(report.gap, periodLabel)] : []),
    'All figures in NPR. Discount and Returns are amounts taken off Gross Purchases.',
    `COGS = ${COGS_FORMULA} · Net Purchases = Gross − bill discounts − returns · Food Cost % = COGS ÷ Net Sales Revenue × 100`,
    "Excludes sub-recipes (prep items). Stock Count's Summary includes them, so its COGS differs from this sheet by exactly the sub-recipe amount; both are correct for what they count.",
  ]

  // The KPI row, then the food-cost box, top to bottom. Discount and Net Purchases are the Returns
  // tile's second line on screen; here they are figures of their own, in the table's column order,
  // and Staff Meals is the table TOTAL's — so COGS can be rebuilt from this sheet alone. The box's
  // own COGS repeats the tile's and is not written twice.
  const row = (figure, amount, pct, note = '') => ({ Figure: figure, 'Amount (NPR)': amount, '%': pct, Note: note })
  const summaryRows = [
    row('Opening Stock',     money(report.totalOpening),     ''),
    row('Gross Purchases',   money(report.totalPurchase),    ''),
    row('Discount',          money(report.totalDiscount),    ''),
    row('Returns',           money(report.totalReturn),      ''),
    row('Net Purchases',     money(report.totalNetPurchase), ''),
    row('Wastage',           money(report.totalWastage),     ''),
    row('Staff Meals',       money(report.totalStaffMeals),  ''),
    row('Closing Stock',     money(report.totalClosing),     ''),
    row('COGS',              money(report.totalCOGS),        '', cogsShareLine(report.fcPct, withhold)),
    row('Net Sales Revenue', money(report.totalRevenue),     '', 'From sales entries (excl. VAT)'),
    row('Food Cost %',       '', pct1(report.fcPct), foodCostSentence(verdict, periodStatus)),
    row(open ? SPEND_SO_FAR_LABEL : SPEND_LABEL, '', pct1(report.purchaseFcPct), 'Net purchases ÷ revenue'),
  ]

  // The Category Breakdown table, same columns in the same order. The share column is COMPUTED on
  // every row and on the TOTAL (the S725 rule: a footer percentage is computed, never asserted), and
  // a negative share is written as the number it is — the screen dashes it, but a column whose cells
  // cannot add up to its own TOTAL is unreadable.
  const totalCogs = report.totalCOGS
  const shareOf = v => (totalCogs > 0 ? pct1((v / totalCogs) * 100) : '')
  const categoryRows = report.catRows.map(r => ({
    'Category':        r.category,
    'Items':           r.itemCount,
    'Not counted':     named ? r.uncountedCount : '',
    'Opening Stock':   money(r.openingVal),
    'Gross Purchases': money(r.purchaseVal),
    'Discount':        money(r.discountVal),
    'Returns':         money(r.returnVal),
    'Net Purchases':   money(r.netPurchaseVal),
    'Wastage':         money(r.wastageVal),
    'Staff Meals':     money(r.staffMealsVal),
    'Closing Stock':   money(r.closingVal),
    'COGS':            money(r.cogsVal),
    '% of Total COGS': shareOf(r.cogsVal),
  }))
  const sum = key => report.catRows.reduce((s, r) => s + (Number(r[key]) || 0), 0)
  categoryRows.push({
    'Category':        'TOTAL',
    'Items':           sum('itemCount'),
    'Not counted':     named ? sum('uncountedCount') : '',
    'Opening Stock':   money(report.totalOpening),
    'Gross Purchases': money(report.totalPurchase),
    'Discount':        money(report.totalDiscount),
    'Returns':         money(report.totalReturn),
    'Net Purchases':   money(report.totalNetPurchase),
    'Wastage':         money(report.totalWastage),
    'Staff Meals':     money(report.totalStaffMeals),
    'Closing Stock':   money(report.totalClosing),
    'COGS':            money(report.totalCOGS),
    '% of Total COGS': shareOf(sum('cogsVal')),
  })

  const filename = `Monthly-Summary-${periodLabel.replace(/\s+/g, '-')}${open ? '-provisional' : ''}.xlsx`
  return { scopeLine, notes, summaryRows, categoryRows, filename }
}
