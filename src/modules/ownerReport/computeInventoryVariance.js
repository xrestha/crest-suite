// Item-level Theoretical vs Actual Variance for the frozen Monthly Owner Report: the figures the
// live Variance page (src/modules/ims/variance/Variance.js) shows for the same closed month.
//
// S792 (FIGURES-2, SALES-3, schema v9): rebuilt. It had been a pre-S719 copy that kept none of the
// live page's fixes while this header said it mirrored the page "exactly":
//   - opening, closing and returns were read unpaged, and a closing row lost past PostgREST's
//     silent 1000-row cap reads as "counted 0", so the whole shelf read as used;
//   - an item with no closing count was a counted 0: it wore a red Over flag with a made-up value,
//     and that value was added into Total Variance Value;
//   - the flag was a fixed ±10% with no NPR materiality floor, whatever the client set in Settings;
//   - sales were summed raw, so a credit note (`pos_credit`, negative qty, and since S758 its choice
//     lines) TOOK usage away, and a day entered on the till and by hand counted twice;
//   - staff meals were left out of actual usage, so every item fed to staff read over-used;
//   - the two totals added kilograms to litres to pieces.
//
// It now follows Variance.js step for step, through the shared helpers rather than a copy of them:
// every per-item read paged with a unique tiebreaker; sales through the depletion rule
// (`buildUsageMap` runs `selectDepletingSales`); actual usage through `computeUsed` (staff meals
// in); measurability PER ITEM (`in closeMap`, a count of 0 is a count, S695/S719); D17's "no recipe
// linked" state for gas, foil and napkins; D36's signed surrogate for "the dishes sold nothing but
// the stock fell"; the verdict from `varianceBand` at the client's own tolerance and the NPR floor;
// and the loss total over measured, recipe-linked rows only. The tolerance and floor used are
// frozen into the section so the report can say what "flagged" meant when it was generated.
//
// The population and the verdict are not copied here: they come from the live pages' own shared
// module, variancePopulation.js (S792, FIGURES-4) — `closingCountMap` (a NULL physical_qty is not a
// count), `linkedItemIdsOf` (D17), `varianceRowBand` (D36's surrogate, the NPR floor),
// `judgedRows`, `isUncountedGap`, `hasVarianceActivity`. So the page and the snapshot cannot drift.
import { supabase } from '../../supabaseClient'
import { scopedFrom } from '../../shared/scopedDb'
import { fetchAllRows } from '../../shared/fetchAllRows'
import { throwFirstError } from '../../shared/queryError'
import { computeUsed, varianceThresholds } from '../../shared/imsFormulas'
import { explodeRecipeIngredients } from '../../utils/recipeCost'
import { loadDeltaExplosion } from '../../utils/orderLineIngredients'
import { selectDepletingSales } from '../ims/sales/salesDepletion'
import { buildUsageMap } from '../ims/stockcount/stockReportCalc'
import {
  closingCountMap, linkedItemIdsOf, varianceRowBand, judgedRows, isUncountedGap, hasVarianceActivity,
} from '../ims/variance/variancePopulation'

const num = v => parseFloat(v) || 0

function sumByItem(rows, field) {
  const out = {}
  ;(rows || []).forEach(r => { out[r.item_id] = (out[r.item_id] || 0) + num(r[field]) })
  return out
}

/**
 * Pure: the section from already-read rows, exported so the arithmetic is tested without a
 * database. `sales` rows must carry `recipe_id, qty_sold, bs_day, source, ingredient_deltas` — the
 * depletion rule cannot run without `bs_day` and `source`. `settings` supplies
 * `variance_flag_pct`; anything missing falls back to varianceBand's defaults.
 */
export function buildVarianceSection({ items, opening, closing, purchases, returns, wastages, staffMeals, sales, breakdown, explosion = null, settings = null }) {
  const openMap = sumByItem(opening, 'qty')
  const closeMap = closingCountMap(closing)
  // Local, never state: the month has any count at all. Without one nothing is measured.
  const hasClosingRows = Object.keys(closeMap).length > 0
  const purchMap = sumByItem(purchases, 'qty')
  ;(returns || []).forEach(r => { purchMap[r.item_id] = (purchMap[r.item_id] || 0) - num(r.qty) })
  const wasteMap = sumByItem(wastages, 'qty')
  const staffMap = sumByItem(staffMeals, 'qty')

  // Credit notes never deplete and a manual row gives way to the till's for the same dish and day
  // (salesDepletion.js). buildUsageMap applies the same rule itself; the list is needed below too.
  const depleting = selectDepletingSales(sales || [])
  const theoreticalMap = buildUsageMap(depleting, breakdown, explosion)

  // Every item any recipe consumes at any depth, plus anything a sold plate's options reach (S758):
  // D17's "no recipe linked" is this set, NOT "theoretical use was 0 this month".
  const linked = linkedItemIdsOf(breakdown, depleting, explosion)

  const rows = (items || []).map(item => {
    const openQty = openMap[item.id] || 0
    const purchQty = purchMap[item.id] || 0 // already net of returns
    const hasCount = item.id in closeMap
    const closeQty = hasCount ? closeMap[item.id] : 0
    const actualUsed = computeUsed({
      opening: openQty, purchases: purchQty, wastage: wasteMap[item.id] || 0, staffMeals: staffMap[item.id] || 0, closing: closeQty,
    })
    const theoreticalUsed = theoreticalMap[item.id] || 0
    const variance = actualUsed - theoreticalUsed
    const rate = num(item.per_uom_rate)
    const row = {
      itemId: item.id, name: item.name, openQty, purchQty, hasCount,
      measured: hasClosingRows && hasCount,
      noRecipe: !linked.has(item.id),
      actualUsed, theoreticalUsed, variance,
      variancePct: theoreticalUsed > 0 ? (variance / theoreticalUsed) * 100 : null,
      value: variance * rate, rate,
    }
    return { ...row, band: varianceRowBand(row, settings) }
  })

  // Headline figures over MEASURED, recipe-linked rows only (S719, D17): an uncounted shelf or a
  // bag of napkins added in would be a "potential loss" nobody had.
  const measured = rows.filter(r => r.measured)
  const judged = judgedRows(rows)
  const flagged = rows.filter(r => r.band.flag === 'over' || r.band.flag === 'under')
  const { tolerancePct, floorValue } = varianceThresholds(settings)

  return {
    tolerancePct, floorValue, hasClosingRows,
    itemCount: rows.length,
    measuredCount: measured.length,
    judgedCount: judged.length,
    // An item with no stock presence was never going to be counted and is not a gap.
    uncountedCount: rows.filter(isUncountedGap).length,
    noRecipeCount: rows.filter(r => r.band.flag === 'no_recipe' && hasVarianceActivity(r)).length,
    flaggedCount: flagged.length,
    overCount: flagged.filter(r => r.band.flag === 'over').length,
    underCount: flagged.filter(r => r.band.flag === 'under').length,
    // Values, never quantities: a kilogram and a litre do not add.
    totalVarianceValue: judged.reduce((s, r) => s + r.value, 0),
    totalTheoreticalValue: judged.reduce((s, r) => s + r.theoreticalUsed * r.rate, 0),
    // Only the rows the report prints: the flagged ones, largest value first. `variancePct` is null
    // when the dishes sold nothing (`noSales`), and the renderers say so rather than print a number.
    items: flagged
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .map(r => ({
        itemId: r.itemId, name: r.name, actualUsed: r.actualUsed, theoreticalUsed: r.theoreticalUsed,
        variance: r.variance, variancePct: r.variancePct, value: r.value, flag: r.band.flag,
        noSales: !(r.theoreticalUsed > 0),
      })),
  }
}

export async function computeInventoryVariance(clientId, period) {
  const results = await Promise.all([
    // Every per-item-per-period read is paged with a unique tiebreaker (S719). Truncation returns
    // no error, and a missing closing row is indistinguishable from an uncounted item. `items` is
    // paged because it yields the ids every other read is joined against. Same population as
    // Variance.js: active, non-sub-recipe items.
    fetchAllRows(() => scopedFrom('items', clientId, 'id, name, per_uom_rate').eq('is_active', true).eq('is_sub_recipe', false).order('id')),
    fetchAllRows(() => supabase.from('opening_stock').select('item_id, qty').eq('period_id', period.id).order('id')),
    fetchAllRows(() => supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', period.id).order('id')),
    fetchAllRows(() => supabase.from('purchase_entries').select('item_id, qty').eq('period_id', period.id).order('id')),
    fetchAllRows(() => scopedFrom('vendor_returns', clientId, 'item_id, qty').eq('period_id', period.id).order('id')),
    fetchAllRows(() => supabase.from('wastages').select('item_id, qty').eq('period_id', period.id).order('id')),
    fetchAllRows(() => supabase.from('staff_meals').select('item_id, qty').eq('period_id', period.id).order('id')),
    // Comps INCLUDED (they consumed stock); bs_day + source feed the depletion rule; ingredient_deltas
    // because a customized plate also consumes (or spares) its options' stock lines (S758).
    fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, bs_day, source, ingredient_deltas').eq('period_id', period.id).order('id')),
    // Paged (S792): these ids seed the recipe walk; a recipe past the 1000-row cap (sub-recipes
    // count) would consume nothing, and a falsely low theoretical usage is a false Over — frozen.
    fetchAllRows(() => scopedFrom('recipes', clientId, 'id').order('id')),
    // The client's own tolerance, read at generation and frozen with the section. `settings` has a
    // nullable client_id, so it stays on raw supabase.from (CLAUDE.md).
    supabase.from('settings').select('variance_flag_pct').eq('client_id', clientId).maybeSingle(),
  ])
  // Throw on a failed read so the section is named as failed instead of freezing a variance table
  // built on zeros into the immutable snapshot (S612).
  throwFirstError(results)
  const [
    { data: items }, { data: opening }, { data: closing }, { data: purchases }, { data: returns },
    { data: wastages }, { data: staffMeals }, { data: sales }, { data: recipes }, { data: settings },
  ] = results

  const recipeIds = (recipes || []).map(r => r.id)
  // Both walks throw on a failed read (S695/S758), so a failure names this section as failed rather
  // than freezing zero theoretical usage, which reads as every item over-consumed.
  const [breakdown, explosion] = await Promise.all([
    recipeIds.length > 0 ? explodeRecipeIngredients(supabase, recipeIds) : {},
    loadDeltaExplosion(supabase, (sales || []).map(s => s.ingredient_deltas)),
  ])

  return buildVarianceSection({ items, opening, closing, purchases, returns, wastages, staffMeals, sales, breakdown, explosion, settings })
}
