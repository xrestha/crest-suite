// Inventory Depth — thin orchestrator over 4 independently-failable sub-analyses. Each one is
// wrapped separately (not just the section as a whole) since they source from four different
// pages/formulas and differ hugely in cost — Shrinkage Trend alone can touch up to 6x the row
// volume of a single-period read; it must not be able to take Dead Stock/Turnover/Variance down
// with it if something about a large client's history trips it up.
import { daysInBsMonth } from '../../utils/bsCalendar'
import { computeInventoryDeadStock } from './computeInventoryDeadStock'
import { computeInventoryTurnover } from './computeInventoryTurnover'
import { computeInventoryVariance } from './computeInventoryVariance'
import { computeInventoryShrinkageTrend } from './computeInventoryShrinkageTrend'

async function runSub(key, fn, errors) {
  try {
    return await fn()
  } catch (e) {
    console.error(`computeInventoryDepthSection: sub-section "${key}" failed:`, e)
    errors[key] = e.message || String(e)
    return null
  }
}

export async function computeInventoryDepthSection(clientId, period, { ims } = {}) {
  const errors = {}
  const monthDays = daysInBsMonth(period.bs_year, period.bs_month)

  const [deadSlowStock, variance, shrinkageTrend] = await Promise.all([
    runSub('deadSlowStock', () => computeInventoryDeadStock(clientId, period), errors),
    runSub('variance', () => computeInventoryVariance(clientId, period), errors),
    runSub('shrinkageTrend', () => computeInventoryShrinkageTrend(clientId, period), errors),
  ])

  // Pure, sync — no query, so no try/catch needed, but still guarded against missing `ims`
  // (e.g. IMS somehow failed upstream — Inventory Depth is only computed when ims is present,
  // but stay defensive since this is cheap to do).
  // On the report's COGS and the stock of the same items since schema 18 (OWNER-REPORT-15).
  const turnover = ims ? computeInventoryTurnover({
    usedValue: ims.cogsTotal, openingValue: ims.cogsOpeningValue, closingValue: ims.cogsClosingValue, monthDays,
  }) : null

  return { deadSlowStock, turnover, variance, shrinkageTrend, sectionErrors: Object.keys(errors).length > 0 ? errors : null }
}
