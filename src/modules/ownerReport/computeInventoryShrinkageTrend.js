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
// Since S792 stage 3 the observation loop, the banding and the status come from the SAME module the
// live page calls (ims/variance/shrinkageCalc.js), which takes its population, count test and
// surrogate from variancePopulation.js. Until then this file carried pinned twins of the page's
// private `bandItem`, `shrinkageStatus` and loop. What stays here is only what a frozen report does
// differently: the trailing window ending at its own period, and the frozen shape below.
import { supabase } from '../../supabaseClient'
import { scopedFrom } from '../../shared/scopedDb'
import { fetchAllRows } from '../../shared/fetchAllRows'
import { throwFirstError } from '../../shared/queryError'
import { varianceThresholds } from '../../shared/imsFormulas'
import { explodeRecipeIngredients } from '../../utils/recipeCost'
import { loadDeltaExplosion } from '../../utils/orderLineIngredients'
import { buildShrinkageObservations, bandShrinkageItem } from '../ims/variance/shrinkageCalc'

const WINDOW_SIZE = 6

/**
 * Pure: the section from already-read rows, exported so the arithmetic is tested without a
 * database. `window` is the closed periods analysed, newest first; `sales` rows must carry
 * `period_id, recipe_id, qty_sold, bs_day, source, ingredient_deltas`.
 */
export function buildShrinkageTrendSection({ window, items, opening, closing, purchases, returns, wastages, staffMeals, sales, breakdown, explosion = null, settings = null }) {
  const periodIds = (window || []).map(p => p.id)
  const { rows: observed, uncountedItems, uncountedItemPeriods } = buildShrinkageObservations({
    periodIds, items, opening, closing, purchases, returns, wastages, staffMeals, sales, breakdown, explosion,
  })
  // The frozen row names its item by id and name (resolved at generation, S435), not the item row.
  const rows = observed.map(({ item, rate, observations, uncountedPeriods }) =>
    bandShrinkageItem({ itemId: item.id, name: item.name, rate, observations, uncountedPeriods }, settings))

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
    // Paged (S792): these ids seed the recipe walk; a recipe past the 1000-row cap (sub-recipes
    // count) would consume nothing, and low theoretical usage reads as shrinkage — frozen.
    fetchAllRows(() => scopedFrom('recipes', clientId, 'id').order('id')),
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
