// The on-hand / below-par arithmetic for EVERY surface that shows it, kept free of Supabase so
// it has a test file (S695, widened S696).
//
// Six surfaces show "how much of this item is on the shelf, and is it below par": Stock Report,
// Reorder Report, the Dashboard's Items to Reorder panel and Top Variance table, the Owner
// Dashboard's Items Below Par tile, the frozen Monthly Owner Report and Requisitions' over-issue
// guard. Until S696 they carried five different copies of this formula, no two alike — three of
// them deducted no wastage, one excluded comps from consumption, two flagged "below par" where
// this page flagged "at or below" — so the Dashboard tile that says 3 linked to a report that said
// 7. They all call `buildStockRows` now. Do not write a sixth copy.
//
// The rules, each of which produced a believable figure rather than an error when broken:
//
//   1. A requisition is NOT a deduction. Issuing stock from the store to the kitchen moves it;
//      the recipes the kitchen then cooks are what consume it, and sales × recipe is already
//      subtracted below. Deducting both took every item that was requisitioned AND cooked off
//      twice, drove it negative, and blamed "a missing purchase entry". The module guide says the
//      Requisitioned column is a cross-check. Decided with Aashish 2026-09-08: recipes only.
//   2. Sales rows are deduplicated through the one shared rule (`selectDepletingSales`) before
//      they become usage. Without it a day sold in both POS and manual entry consumed its
//      ingredients twice, and a credit-note row ('pos_credit', negative qty) put stock BACK on
//      the shelf that never physically returned.
//   3. A closing row with physical_qty 0 is a real count — "we looked and there was none" — and
//      the item is Physical with 0 on hand. That only became expressible once Stock Count stopped
//      deleting the row for a 0 (same session); before, a counted-empty item fell back to the
//      theoretical estimate and was valued into Total Stock Value as though it were on the shelf.
//   4. Staff meals come off the shelf. The food came out of the same stock (the S551 COGS
//      decision), and Stock Report already deducted them while Reorder Report and both dashboards
//      did not — so an item Stock Report called Low read OK on the page a purchase list is printed
//      from. Decided with Aashish 2026-09-08 (S696).
//   5. An item sitting exactly AT its par level is fine. Par is "the minimum I want on hand";
//      being at it is having it. Reorder Report used to flag `<= par`, which painted the row red
//      with a shortfall of "—" and printed a line to buy 0.00 on the purchase list, while both
//      dashboards counted strictly below. Decided with Aashish 2026-09-08 (S696): below only.
//
// An item with no activity at all — no opening, no purchases, no usage, no wastage, no staff
// meals and no closing row — is `idle`, not `out`: nothing in the data says it was ever stocked,
// so counting it as "out of stock" inflated that KPI by every dormant item in the master list.

import { selectDepletingSales } from '../sales/salesDepletion'

const num = v => parseFloat(v) || 0

function sumBy(rows, key, valueKey) {
  const out = {}
  ;(rows || []).forEach(r => { out[r[key]] = (out[r[key]] || 0) + num(r[valueKey]) })
  return out
}

/** Sales × exploded recipe → per-item consumption for the period. */
export function buildUsageMap(sales, breakdown) {
  const soldMap = {}
  selectDepletingSales(sales || []).forEach(s => {
    soldMap[s.recipe_id] = (soldMap[s.recipe_id] || 0) + num(s.qty_sold)
  })
  const usageMap = {}
  Object.entries(breakdown || {}).forEach(([recipeId, rows]) => {
    const sold = soldMap[recipeId] || 0
    if (sold <= 0) return
    rows.forEach(({ item_id, qty }) => { usageMap[item_id] = (usageMap[item_id] || 0) + sold * qty })
  })
  return usageMap
}

/**
 * One row per item: on-hand, its source, the par comparison and the reorder shortfall.
 *
 * `sales` rows must carry `bs_day` and `source` (rule 2 cannot run without them — select them).
 * `pars` may be omitted by a caller that only wants on-hand; every reorder field then reads as
 * "no par". Items are taken as given: a caller that must exclude sub-recipes filters first.
 */
export function buildStockRows({ items, opening, closing, purchases, returns, wastages, staffMeals, sales, breakdown, pars }) {
  const openMap = {}; (opening || []).forEach(r => { openMap[r.item_id] = num(r.qty) })
  const closeMap = {}; (closing || []).forEach(r => { closeMap[r.item_id] = num(r.physical_qty) })
  const wasteMap = sumBy(wastages, 'item_id', 'qty')
  const staffMap = sumBy(staffMeals, 'item_id', 'qty')
  const parMap = {}; (pars || []).forEach(r => { parMap[r.item_id] = num(r.par_qty) })
  const purchMap = sumBy(purchases, 'item_id', 'qty')
  ;(returns || []).forEach(r => { purchMap[r.item_id] = (purchMap[r.item_id] || 0) - num(r.qty) })
  const usageMap = buildUsageMap(sales, breakdown)

  return (items || []).map(item => {
    const openQty  = openMap[item.id] || 0
    const netPurch = purchMap[item.id] || 0
    const wasteQty = wasteMap[item.id] || 0
    const usageQty = usageMap[item.id] || 0
    const staffQty = staffMap[item.id] || 0
    const hasClosing = item.id in closeMap
    const hasActivity = hasClosing || openQty !== 0 || netPurch !== 0 || usageQty !== 0 || wasteQty !== 0 || staffQty !== 0
    const rawTheoretical = openQty + netPurch - usageQty - wasteQty - staffQty
    const onHand = hasClosing ? closeMap[item.id] : Math.max(0, rawTheoretical)
    const isNegative = !hasClosing && rawTheoretical < 0
    const par = parMap[item.id] || 0
    const unitRate = num(item.per_uom_rate)
    const stockValue = onHand * unitRate

    // Rule 5: below par, never at it. `shortfall` is what to buy to get back to par.
    const needsReorder = par > 0 && onHand < par
    const shortfall = needsReorder ? par - onHand : 0
    const shortfallValue = shortfall * unitRate

    let status
    if (!hasActivity) status = 'idle'
    else if (onHand <= 0) status = 'out'
    else if (needsReorder) status = 'low'
    else status = 'ok'

    return {
      item, category: item.categories?.name || 'Uncategorised',
      openQty, netPurch, usageQty, wasteQty, staffQty,
      onHand, isNegative, par, unitRate, stockValue,
      needsReorder, shortfall, shortfallValue,
      stockSource: hasClosing ? 'closing' : 'theoretical', status,
    }
  })
}

/** The two figures every dashboard tile wants: how many items are below par, and what it costs to restore them. */
export function summarizeReorder(rows) {
  let count = 0, estValueTotal = 0
  ;(rows || []).forEach(r => { if (r.needsReorder) { count += 1; estValueTotal += r.shortfallValue } })
  return { count, estValueTotal }
}
