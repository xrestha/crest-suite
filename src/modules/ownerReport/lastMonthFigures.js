// The Financial Summary's "Last month" column (S857, the Crest Suite Pro critique: the comparison sat
// only in the Trend section at the back). Pure, no React.
//
// Every figure comes from the copy of last month this report froze in its own Trend entry
// (`snapshot.trend.vsLastPeriod`, built by trendSnapshotOf at generation). Nothing is read again or
// worked out from live data: a frozen report shows the last month it was made beside, even after
// that month is regenerated.
//
// A figure whose method changed between the two months is not shown, by the same tests buildDeltas
// uses to leave the Trend change blank (foodCostBasisOf, labourBasisOf, netMarginTaxFeesOf,
// netMarginPnlCostsOf), so this column and the Trend section can never disagree about which months
// compare. The Trend section prints the long reason; this column carries it in a Tip.
import { BS_MONTHS } from '../../utils/bsCalendar'
import { foodCostBasisOf, labourBasisOf, netMarginTaxFeesOf, netMarginPnlCostsOf } from './computeMonthlyReport'
import { trendUnavailableText, priorFailedSections } from './sectionNames'

/**
 * @param {object} snapshot  a monthly_owner_reports snapshot
 * @returns {{ available: boolean, label: string, why: string|null, rows: object }}
 *   `rows.revenue|foodCost|labour|prime|netMargin` = `{ value, why, changed }`: `value` is the frozen
 *   figure or null; `why` is the Tip for a dash; `changed` says the dash is a change of method.
 *   When `available` is false, `rows` is empty and `why` says why for the whole column.
 */
export function lastMonthFigures(snapshot) {
  const t = snapshot?.trend?.vsLastPeriod
  const label = t?.period ? `${BS_MONTHS[t.period.bs_month - 1]} ${t.period.bs_year}` : ''
  const none = why => ({ available: false, label, why, rows: {} })
  if (!t) {
    return none(snapshot?.sectionErrors?.trend
      ? 'The comparison with last month could not be worked out when this report was made.'
      : 'This report was made without a comparison with last month.')
  }
  if (!t.available || !t.snapshot) return none(trendUnavailableText(t))

  const prior = t.snapshot
  const pc = prior.combined || {}
  const missingIms = priorFailedSections(prior).includes('ims')
  const foodChanged = foodCostBasisOf(snapshot) !== foodCostBasisOf(prior)
  const labourChanged = labourBasisOf(snapshot) !== labourBasisOf(prior)
  const marginChanged = foodChanged || labourChanged
    || netMarginTaxFeesOf(snapshot) !== netMarginTaxFeesOf(prior)
    || netMarginPnlCostsOf(snapshot) !== netMarginPnlCostsOf(prior)

  const cell = (value, { changed = false, needsIms = false } = {}) => {
    // The prior lost its Crest IMS section: the Trend section does not compare these either.
    if (needsIms && missingIms) return { value: null, why: `Not compared: the ${label} report is missing its Crest IMS section.`, changed: false }
    if (changed) {
      return { value: null, why: `Not compared: Crest changed how this figure is worked out between ${label} and this month. Regenerate ${label}, then this report, to compare them.`, changed: true }
    }
    if (value == null) return { value: null, why: `The ${label} report has no figure for this.`, changed: false }
    return { value, why: null, changed: false }
  }

  return {
    available: true,
    label,
    why: null,
    rows: {
      revenue: cell(pc.revenueTotal),
      foodCost: cell(pc.foodCostPct, { changed: foodChanged, needsIms: true }),
      labour: cell(pc.laborCostPct, { changed: labourChanged }),
      prime: cell(pc.primeCostPct, { changed: foodChanged || labourChanged, needsIms: true }),
      netMargin: cell(pc.netMarginPct, { changed: marginChanged, needsIms: true }),
    },
  }
}
