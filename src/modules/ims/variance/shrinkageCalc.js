// Shrinkage's arithmetic, in one place: the Shrinkage Report (ShrinkageReport.js) and the frozen
// Monthly Owner Report's Shrinkage Trend (ownerReport/computeInventoryShrinkageTrend.js) both call
// it (S792, stage 3). Until then the page kept its observation loop, `bandItem` and
// `shrinkageStatus` private and the Owner Report carried pinned twins of all three, with a comment
// on each side saying "if either side changes, change both" — the shape a frozen artifact can least
// afford, since a snapshot built on a drifted twin is never recomputed.
//
// Pure: no React, no Supabase. The population, the count test and the no-sales surrogate come from
// variancePopulation.js, the Variance Report's own rules (D17/D36).
import { varianceBand } from '../../../shared/imsFormulas'
import { buildUsageMap } from '../stockcount/stockReportCalc'
import { selectDepletingSalesAcrossPeriods } from '../sales/salesDepletion'
import { linkedItemIdsOf, bandPctOf, isClosingCount } from './variancePopulation'

const num = v => parseFloat(v) || 0

/**
 * Consistent / Occasional / Once / Clear. "Consistent" is over-use in at least two periods AND in
 * 67%+ of the periods tracked — so 2 of 3 (0.667) is Occasional, by the page's long-standing line.
 */
export function shrinkageStatus(shrinkCount, coveredPeriods) {
  const ratio = coveredPeriods > 0 ? shrinkCount / coveredPeriods : 0
  if (ratio >= 0.67 && shrinkCount >= 2) return 'Consistent'
  if (shrinkCount >= 2) return 'Occasional'
  if (shrinkCount === 1) return 'Once'
  return 'Clear'
}

/**
 * One item's verdict from its observations `[{ variance, theor, actual, rate }]`. A period counts as
 * shrinkage only when the variance is OVER the client's tolerance AND material (S756) — the old test
 * was `variance > 0.001`, a hundredth of a gram over recipe, while the Variance Report called the
 * same months OK. A month whose dishes sold nothing has no percentage (÷ 0); `bandPctOf` gives it the
 * Variance Report's signed surrogate (D36), since `null` bands as "no verdict" and could never count.
 * Pure over the observations, so a settings change re-bands without a re-read.
 */
export function bandShrinkageItem(raw, settings) {
  let shrinkCount = 0
  let totalShrinkQty = 0
  ;(raw.observations || []).forEach(({ variance, theor, actual, rate }) => {
    const pct = bandPctOf({
      theoreticalUsed: theor, actualUsed: actual,
      variancePct: theor > 0 ? (variance / theor) * 100 : null,
    })
    if (varianceBand(pct, variance * rate, settings, { measured: true }).key === 'over') {
      shrinkCount++
      totalShrinkQty += variance
    }
  })
  const coveredPeriods = (raw.observations || []).length
  return {
    ...raw,
    shrinkCount,
    coveredPeriods,
    totalShrinkQty,
    totalShrinkValue: totalShrinkQty * raw.rate,
    avgShrinkQty: shrinkCount > 0 ? totalShrinkQty / shrinkCount : 0,
    status: shrinkageStatus(shrinkCount, coveredPeriods),
  }
}

function byPeriodItem(rows, field) {
  const m = {}
  ;(rows || []).forEach(r => {
    if (!m[r.period_id]) m[r.period_id] = {}
    m[r.period_id][r.item_id] = (m[r.period_id][r.item_id] || 0) + num(r[field])
  })
  return m
}

/**
 * Per-item OBSERVATIONS over a window of periods — not verdicts, which depend on settings and come
 * from `bandShrinkageItem`. Every row passed in carries `period_id`; `sales` rows carry
 * `period_id, recipe_id, qty_sold, bs_day, source, ingredient_deltas`; `breakdown` is
 * explodeRecipeIngredients' output and `explosion` loadDeltaExplosion's.
 *
 * Returns `{ rows: [{ item, rate, observations, uncountedPeriods }], uncountedItems,
 * uncountedItemPeriods }`, rows in `items` order, only items with at least one observation.
 *
 * - Theoretical usage runs ONE period at a time: the POS-supersedes-manual rule is keyed on a day
 *   NUMBER, so two months at once let a till sale on the 5th of one silence a manual sale on the 5th
 *   of another (S718). buildUsageMap drops credit notes and superseded manual rows, then adds each
 *   surviving customized plate's option lines (S758).
 * - The items judged are the Variance Report's (D17/D36): every item a recipe at any depth, or a
 *   sold option line, consumes. An item in no recipe is never judged (gas, foil, napkins).
 * - A month is observed when the item was COUNTED (a NULL physical_qty is not a count, a 0 is —
 *   S695) and either its dishes sold or its stock moved with nothing sold (D36). A month with
 *   expected use or stock on hand but no count is skipped and counted, never read as the whole shelf
 *   consumed (S756). A month where nothing sold and nothing moved has nothing to judge.
 * - Staff meals are logged use, like wastage, so neither is shrinkage (actual usage takes both off).
 */
export function buildShrinkageObservations({ periodIds, items, opening, closing, purchases, returns, wastages, staffMeals, sales, breakdown, explosion = null }) {
  const ids = periodIds || []
  const openMap = byPeriodItem(opening, 'qty')
  const wasteMap = byPeriodItem(wastages, 'qty')
  const staffMap = byPeriodItem(staffMeals, 'qty')
  const purchMap = byPeriodItem(purchases, 'qty')
  ;(returns || []).forEach(r => {
    if (!purchMap[r.period_id]) purchMap[r.period_id] = {}
    purchMap[r.period_id][r.item_id] = (purchMap[r.period_id][r.item_id] || 0) - num(r.qty)
  })
  const closeMap = {}
  ;(closing || []).forEach(r => {
    if (!isClosingCount(r)) return
    if (!closeMap[r.period_id]) closeMap[r.period_id] = {}
    closeMap[r.period_id][r.item_id] = num(r.physical_qty)
  })

  const salesByPeriod = {}
  ;(sales || []).forEach(s => { (salesByPeriod[s.period_id] = salesByPeriod[s.period_id] || []).push(s) })
  const theorMap = {}
  ids.forEach(pid => { theorMap[pid] = buildUsageMap(salesByPeriod[pid] || [], breakdown || {}, explosion) })

  const linked = linkedItemIdsOf(breakdown || {}, selectDepletingSalesAcrossPeriods(sales || []), explosion)

  let uncountedItems = 0
  let uncountedItemPeriods = 0
  const rows = []
  ;(items || []).forEach(item => {
    if (!linked.has(item.id)) return
    const rate = num(item.per_uom_rate)
    const observations = []
    let skipped = 0
    ids.forEach(pid => {
      const theor = theorMap[pid]?.[item.id] || 0
      const open = openMap[pid]?.[item.id] || 0
      const purch = purchMap[pid]?.[item.id] || 0
      if (!closeMap[pid] || !(item.id in closeMap[pid])) {
        if (theor > 0 || open > 0 || purch > 0) skipped++
        return
      }
      // computeUsed's terms in a fixed order: the `actual === 0` test below is exact, and a
      // different order of float subtractions can land a hair off zero.
      const actual = open + purch - closeMap[pid][item.id] - (wasteMap[pid]?.[item.id] || 0) - (staffMap[pid]?.[item.id] || 0)
      if (theor <= 0 && actual === 0) return
      observations.push({ variance: actual - theor, theor, actual, rate })
    })
    if (skipped > 0) { uncountedItems++; uncountedItemPeriods += skipped }
    if (observations.length > 0) rows.push({ item, rate, observations, uncountedPeriods: skipped })
  })
  return { rows, uncountedItems, uncountedItemPeriods }
}
