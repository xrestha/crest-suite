// Top Variance Items on the dashboard (S852, the 2026-10-20 audit's P0).
//
// The card read the open month, where most closing counts do not exist yet, and worked out
// `actual = opening + purchases − (closeMap[id] || 0)`: a missing count became a count of 0, so every
// item bought and not yet used up by recipe sales read as "Over-used", in red, with a "Value at
// Risk", every day until the month-end count, on the first screen the Owner opens. The Variance page
// and the Owner Report stopped doing that in S719/S792; this card had never been moved onto them.
//
// It now judges exactly the population they judge, through variancePopulation.js (never a copy):
// measurability PER ITEM (`closingCountMap`, where a 0 is a count and a NULL is not), recipe-linked
// only (`linkedItemIdsOf`, D17), actual use through `computeUsed` with wastage and staff meals in,
// sales through the depletion rule (`buildUsageMap`), stock transfers like purchases and returns
// (S849), and the verdict from `varianceRowBand` at the client's own tolerance and the NPR floor.
//
// The verdict is taken at render (`topVarianceRows`), as on the Variance page, because the client's
// settings can land after the load. So the load keeps the candidates: judged rows that used more
// than recipes explain, largest value first. An item without a count is never one of them.
import { computeUsed } from '../../shared/imsFormulas'
import { selectDepletingSales } from '../../modules/ims/sales/salesDepletion'
import { buildUsageMap, transferNetQtyMap } from '../../modules/ims/stockcount/stockReportCalc'
import {
  closingCountMap, linkedItemIdsOf, judgedRows, isUncountedGap, varianceRowBand,
} from '../../modules/ims/variance/variancePopulation'

/** The cached shape's version: a pre-S852 cache held a bare array of rows built the old way; 3 (S862)
 *  links an item to the client's choice stock lines, so a view cached before it is not reused. */
export const TOP_VARIANCE_VERSION = 3

// Enough that the client's own tolerance, applied at render, still finds the five it shows: a row
// can be large in rupees and still inside tolerance. Kept small because the view is cached.
const CANDIDATE_LIMIT = 50

const num = v => parseFloat(v) || 0

function sumByItem(rows, field) {
  const out = {}
  ;(rows || []).forEach(r => { out[r.item_id] = (out[r.item_id] || 0) + num(r[field]) })
  return out
}

/**
 * The card's view of one period, from rows already read. Pure.
 *
 *   items       active, non-sub-recipe items (`id, name, uom, per_uom_rate`), the Variance page's set
 *   opening, closing, purchases, returns, wastages, staffMeals   the period's rows (`item_id`, qty)
 *   sales       `recipe_id, qty_sold, bs_day, source, ingredient_deltas`, every source (comps used stock)
 *   breakdown   `{ recipeId: [{ item_id, qty }] }` over the whole recipe book
 *   explosion   loadDeltaExplosion's result, for option stock lines (S758)
 *   transfers   readPeriodTransfers' rows (S849)
 *   choiceItemIds  loadChoiceLinkedItemIds' set (S862 REPORTS-STOCK-3): an item only a choice uses is
 *               judged in a month nobody picked it, as on the Variance page
 *
 * Returns `{ v, countedItems, uncounted, candidates }`. `countedItems` is how many items have a
 * closing count; 0 means nothing can be judged yet ("Needs a stock count"). `uncounted` is how many
 * items with stock have none (`isUncountedGap`), named under the table rather than judged.
 */
export function buildTopVariance({ items, opening, closing, purchases, returns, wastages, staffMeals, sales, breakdown, explosion = null, transfers = null, choiceItemIds = null }) {
  const openMap = sumByItem(opening, 'qty')
  const closeMap = closingCountMap(closing)
  // Local, never state: does the month have any count at all.
  const hasClosingRows = Object.keys(closeMap).length > 0
  const purchMap = sumByItem(purchases, 'qty')
  ;(returns || []).forEach(r => { purchMap[r.item_id] = (purchMap[r.item_id] || 0) - num(r.qty) })
  Object.entries(transferNetQtyMap(transfers)).forEach(([id, q]) => { purchMap[id] = (purchMap[id] || 0) + q })
  const wasteMap = sumByItem(wastages, 'qty')
  const staffMap = sumByItem(staffMeals, 'qty')

  const depleting = selectDepletingSales(sales || [])
  const theoreticalMap = buildUsageMap(depleting, breakdown, explosion)
  const linked = linkedItemIdsOf(breakdown, depleting, explosion, choiceItemIds)

  const rows = (items || []).map(item => {
    const openQty = openMap[item.id] || 0
    const purchQty = purchMap[item.id] || 0 // net of returns and transfers
    const hasCount = item.id in closeMap
    const actualUsed = computeUsed({
      opening: openQty, purchases: purchQty, wastage: wasteMap[item.id] || 0,
      staffMeals: staffMap[item.id] || 0, closing: hasCount ? closeMap[item.id] : 0,
    })
    const theoreticalUsed = theoreticalMap[item.id] || 0
    const variance = actualUsed - theoreticalUsed
    return {
      itemId: item.id, name: item.name, uom: item.uom, openQty, purchQty, hasCount,
      measured: hasClosingRows && hasCount,
      noRecipe: !linked.has(item.id),
      actualUsed, theoreticalUsed, variance,
      variancePct: theoreticalUsed > 0 ? (variance / theoreticalUsed) * 100 : null,
      value: variance * num(item.per_uom_rate),
    }
  })

  const candidates = judgedRows(rows)
    .filter(r => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, CANDIDATE_LIMIT)
    // Only what the verdict and the table read: the view is cached.
    .map(({ itemId, name, uom, measured, noRecipe, actualUsed, theoreticalUsed, variance, variancePct, value }) =>
      ({ itemId, name, uom, measured, noRecipe, actualUsed, theoreticalUsed, variance, variancePct, value }))

  return {
    v: TOP_VARIANCE_VERSION,
    countedItems: rows.filter(r => r.measured).length,
    uncounted: rows.filter(isUncountedGap).length,
    candidates,
  }
}

/** A view built by this file, not a pre-S852 cached array. */
export function isTopVarianceView(view) {
  return view?.v === TOP_VARIANCE_VERSION && Array.isArray(view.candidates)
}

/** The rows the card shows: judged Over at the client's own tolerance, largest value first. */
export function topVarianceRows(view, settings, limit = 5) {
  if (!isTopVarianceView(view)) return []
  return view.candidates
    .map(r => ({ ...r, band: varianceRowBand(r, settings) }))
    .filter(r => r.band.flag === 'over')
    .slice(0, limit)
}
