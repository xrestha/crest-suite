// Shrinkage Trend for the frozen Monthly Owner Report — ShrinkageReport.js's per-item arithmetic
// over a TRAILING window of closed periods ending at the report's own (the live page picks the most
// recent 3/6/12 closed periods whatever is being viewed; a frozen report must not move with time).
// Returns null when fewer than 2 closed periods are available: not enough signal for a trend.
//
// S792 (FIGURES-2, SALES-3, schema v9): rebuilt. It had been a pre-S719 copy that kept none of the
// live page's fixes:
//   - six periods of opening, closing, returns and staff meals were read unpaged — 6 × 200 items is
//     already past PostgREST's silent 1000-row cap, and which closing rows were lost (each one read
//     as "counted 0", the whole shelf "used") changed from one generation to the next;
//   - a missing closing row was a counted 0, the defect S756 fixed on the page;
//   - a period counted as shrinkage at `variance > 0.001` — a hundredth of a gram over recipe —
//     with no tolerance and no NPR floor;
//   - sales were summed raw, so a credit note (`pos_credit`, negative qty, and its choice lines
//     since S758) subtracted usage and a day on both the till and manual entry counted twice.
//
// It now follows ShrinkageReport.js: every read paged; sales grouped BY PERIOD and run through
// `buildUsageMap`, which applies the depletion rule — the rule is keyed on a day NUMBER, so it must
// never see two months at once (S718); the items judged are the Variance Report's population
// (recipe-linked at any depth, or reached through a sold option — D17); a month is observed when the
// item was counted (a NULL physical_qty is not a count) AND either its dishes sold or its stock moved
// with nothing sold (D36); a month with stock or expected use but no count is counted rather than
// dropped; and a month is shrinkage only when `varianceBand` calls it Over at the client's own
// tolerance and the NPR floor (S756), through the Variance Report's signed surrogate when nothing
// sold. The tolerance and floor are frozen into the section.
//
// The population, the count test and the surrogate come from the live pages' shared module
// (variancePopulation.js). ShrinkageReport.js keeps its observation loop, `bandItem` and
// `shrinkageStatus` private; `bandShrinkageItem`, `shrinkageStatus` and the loop below are their
// twins, pinned by this file's test. If either side changes, change both.
import { supabase } from '../../supabaseClient'
import { scopedFrom } from '../../shared/scopedDb'
import { fetchAllRows } from '../../shared/fetchAllRows'
import { throwFirstError } from '../../shared/queryError'
import { varianceBand, varianceThresholds } from '../../shared/imsFormulas'
import { explodeRecipeIngredients } from '../../utils/recipeCost'
import { loadDeltaExplosion } from '../../utils/orderLineIngredients'
import { buildUsageMap } from '../ims/stockcount/stockReportCalc'
import { selectDepletingSalesAcrossPeriods } from '../ims/sales/salesDepletion'
import { linkedItemIdsOf, bandPctOf, isClosingCount } from '../ims/variance/variancePopulation'

const WINDOW_SIZE = 6

const num = v => parseFloat(v) || 0

/** Consistent / Occasional / Once / Clear — the live page's labels and thresholds. */
export function shrinkageStatus(shrinkCount, coveredPeriods) {
  const ratio = coveredPeriods > 0 ? shrinkCount / coveredPeriods : 0
  if (ratio >= 0.67 && shrinkCount >= 2) return 'Consistent'
  if (shrinkCount >= 2) return 'Occasional'
  if (shrinkCount === 1) return 'Once'
  return 'Clear'
}

/**
 * One item's verdict from its observations `[{ variance, theor, actual, rate }]` — a period counts
 * as shrinkage only when it is OVER the client's tolerance AND material (S756), never at any
 * positive variance. A month whose dishes sold nothing has no percentage (÷ 0); `bandPctOf` gives it
 * the Variance Report's signed surrogate, so stock that vanished with nothing sold can count here as
 * it does there (D36) — `null` would band as "no verdict" and could never count.
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
    shrinkCount, coveredPeriods, totalShrinkQty,
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
 * Pure: the section from already-read rows, exported so the arithmetic is tested without a
 * database. `window` is the closed periods analysed, newest first; `sales` rows must carry
 * `period_id, recipe_id, qty_sold, bs_day, source, ingredient_deltas`.
 */
export function buildShrinkageTrendSection({ window, items, opening, closing, purchases, returns, wastages, staffMeals, sales, breakdown, explosion = null, settings = null }) {
  const periodIds = (window || []).map(p => p.id)
  const openMap = byPeriodItem(opening, 'qty')
  const wasteMap = byPeriodItem(wastages, 'qty')
  const staffMap = byPeriodItem(staffMeals, 'qty')
  const purchMap = byPeriodItem(purchases, 'qty')
  ;(returns || []).forEach(r => {
    if (!purchMap[r.period_id]) purchMap[r.period_id] = {}
    purchMap[r.period_id][r.item_id] = (purchMap[r.period_id][r.item_id] || 0) - num(r.qty)
  })
  // Presence per period: a count of 0 is a count, a NULL is not (S695, isClosingCount).
  const closeMap = {}
  ;(closing || []).forEach(r => {
    if (!isClosingCount(r)) return
    if (!closeMap[r.period_id]) closeMap[r.period_id] = {}
    closeMap[r.period_id][r.item_id] = num(r.physical_qty)
  })

  // Theoretical usage one period at a time: the POS-supersedes-manual rule is keyed on bs_day, so
  // handing it two months lets a till sale on the 5th of one silence a manual sale on the 5th of
  // another (S718). buildUsageMap drops credit notes and superseded manual rows, then adds each
  // surviving customized plate's option lines (S758).
  const salesByPeriod = {}
  ;(sales || []).forEach(s => { (salesByPeriod[s.period_id] = salesByPeriod[s.period_id] || []).push(s) })
  const theorMap = {}
  periodIds.forEach(pid => { theorMap[pid] = buildUsageMap(salesByPeriod[pid] || [], breakdown, explosion) })

  // The Variance Report's population (D17/D36): every item a recipe at any depth, or a sold option
  // line, consumes — not "had theoretical usage this month", which never saw an ingredient whose
  // dishes sold nothing while its stock fell. An item in no recipe is not judged (gas, foil, napkins).
  // The depletion rule runs per period here too, through the across-periods form.
  const linked = linkedItemIdsOf(breakdown, selectDepletingSalesAcrossPeriods(sales || []), explosion)

  // Observations: a month is observed when the item was counted AND either its dishes sold or its
  // stock moved with nothing sold (D36) — the months the Variance Report would judge. A month with
  // expected use or stock on hand but no count is skipped and counted — never read as the whole
  // shelf consumed. A month where nothing sold and nothing moved has nothing to judge.
  let uncountedItems = 0
  let uncountedItemPeriods = 0
  const rows = []
  ;(items || []).forEach(item => {
    if (!linked.has(item.id)) return
    const rate = num(item.per_uom_rate)
    const observations = []
    let skipped = 0
    periodIds.forEach(pid => {
      const theor = theorMap[pid]?.[item.id] || 0
      const open = openMap[pid]?.[item.id] || 0
      const purch = purchMap[pid]?.[item.id] || 0
      if (!closeMap[pid] || !(item.id in closeMap[pid])) {
        if (theor > 0 || open > 0 || purch > 0) skipped++
        return
      }
      // computeUsed's terms, in ShrinkageReport.js's own order: the `actual === 0` test below is
      // exact, and a different order of float subtractions can land a hair off zero.
      const actual = open + purch - closeMap[pid][item.id] - (wasteMap[pid]?.[item.id] || 0) - (staffMap[pid]?.[item.id] || 0)
      if (theor <= 0 && actual === 0) return
      observations.push({ variance: actual - theor, theor, actual, rate })
    })
    if (skipped > 0) { uncountedItems++; uncountedItemPeriods += skipped }
    if (observations.length > 0) rows.push(bandShrinkageItem({ itemId: item.id, name: item.name, rate, observations, uncountedPeriods: skipped }, settings))
  })

  const flagged = rows
    .filter(r => r.shrinkCount > 0)
    .sort((a, b) => b.totalShrinkValue - a.totalShrinkValue)
  const { tolerancePct, floorValue } = varianceThresholds(settings)

  return {
    periodsAnalyzed: periodIds.length, windowPeriodIds: periodIds,
    tolerancePct, floorValue,
    trackedCount: rows.length,
    consistentCount: flagged.filter(r => r.status === 'Consistent').length,
    anyFlaggedCount: flagged.length,
    totalLossValue: flagged.reduce((s, r) => s + r.totalShrinkValue, 0),
    uncountedItems, uncountedItemPeriods,
    // The observations stay out of the snapshot; the frozen row is the verdict and its figures.
    items: flagged.slice(0, 15).map(({ observations, ...r }) => r),
  }
}

export async function computeInventoryShrinkageTrend(clientId, period) {
  const closedPeriodsRes = await scopedFrom('monthly_periods', clientId, 'id, bs_year, bs_month')
    .eq('status', 'closed')
    .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
  // Throw on a failed read: this section returns null for "fewer than 2 closed periods", and a
  // failed read must not wear that legitimate absence as a disguise (S612).
  throwFirstError([closedPeriodsRes])
  const { data: closedPeriods } = closedPeriodsRes

  const thisKey = period.bs_year * 100 + period.bs_month
  const window = (closedPeriods || [])
    .filter(p => p.bs_year * 100 + p.bs_month <= thisKey)
    .slice(0, WINDOW_SIZE)
  if (window.length < 2) return null

  const windowIds = window.map(p => p.id)
  const results = await Promise.all([
    // Every read paged with a unique tiebreaker (S719): one row per item per period, multiplied by
    // the window — six periods cross the 1000-row cap at ~167 items.
    fetchAllRows(() => scopedFrom('items', clientId, 'id, name, per_uom_rate').eq('is_active', true).eq('is_sub_recipe', false).order('id')),
    fetchAllRows(() => supabase.from('opening_stock').select('period_id, item_id, qty').in('period_id', windowIds).order('id')),
    fetchAllRows(() => supabase.from('closing_stock').select('period_id, item_id, physical_qty').in('period_id', windowIds).order('id')),
    fetchAllRows(() => supabase.from('purchase_entries').select('period_id, item_id, qty').in('period_id', windowIds).order('id')),
    fetchAllRows(() => scopedFrom('vendor_returns', clientId, 'period_id, item_id, qty').in('period_id', windowIds).order('id')),
    fetchAllRows(() => supabase.from('wastages').select('period_id, item_id, qty').in('period_id', windowIds).order('id')),
    fetchAllRows(() => supabase.from('staff_meals').select('period_id, item_id, qty').in('period_id', windowIds).order('id')),
    // Comps INCLUDED: a comped dish still consumed its ingredients. bs_day + source feed the
    // per-period depletion rule; ingredient_deltas carry a customized plate's option lines (S758).
    fetchAllRows(() => supabase.from('sales_entries').select('period_id, recipe_id, qty_sold, bs_day, source, ingredient_deltas').in('period_id', windowIds).order('id')),
    scopedFrom('recipes', clientId, 'id'),
    // The client's own tolerance, frozen with the section. Raw supabase.from: nullable client_id.
    supabase.from('settings').select('variance_flag_pct').eq('client_id', clientId).maybeSingle(),
  ])
  throwFirstError(results)
  const [
    { data: items }, { data: opening }, { data: closing }, { data: purchases }, { data: returns },
    { data: wastages }, { data: staffMeals }, { data: sales }, { data: recipes }, { data: settings },
  ] = results

  const recipeIds = (recipes || []).map(r => r.id)
  // Both walks throw on a failed read, so a failure names this section as failed rather than
  // freezing zero theoretical usage — which reads as every item shrinking.
  const [breakdown, explosion] = await Promise.all([
    recipeIds.length > 0 ? explodeRecipeIngredients(supabase, recipeIds) : {},
    loadDeltaExplosion(supabase, (sales || []).map(s => s.ingredient_deltas)),
  ])

  return buildShrinkageTrendSection({ window, items, opening, closing, purchases, returns, wastages, staffMeals, sales, breakdown, explosion, settings })
}
