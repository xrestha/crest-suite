// The Stock Report's arithmetic, kept free of Supabase so it has a test file (S695).
//
// Three rules live here that the page used to get wrong, each of which produced a believable
// figure rather than an error:
//
//   1. A requisition is NOT a deduction. Issuing stock from the store to the kitchen moves it;
//      the recipes the kitchen then cooks are what consume it, and sales × recipe is already
//      subtracted below. Deducting both took every item that was requisitioned AND cooked off
//      twice, drove it negative, and blamed "a missing purchase entry". Every other stock page
//      (Variance, Reorder, the dashboards) deducts recipe usage only; the module guide says the
//      Requisitioned column is a cross-check. Decided with Aashish 2026-09-08: recipes only.
//   2. Sales rows are deduplicated through the one shared rule (`selectDepletingSales`) before
//      they become usage. Without it a day sold in both POS and manual entry consumed its
//      ingredients twice, and a credit-note row ('pos_credit', negative qty) put stock BACK on
//      the shelf that never physically returned.
//   3. A closing row with physical_qty 0 is a real count — "we looked and there was none" — and
//      the item is Physical with 0 on hand. That only became expressible once Stock Count stopped
//      deleting the row for a 0 (same session); before, a counted-empty item fell back to the
//      theoretical estimate and was valued into Total Stock Value as though it were on the shelf.
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

    let status
    if (!hasActivity) status = 'idle'
    else if (onHand <= 0) status = 'out'
    else if (par > 0 && onHand <= par) status = 'low'
    else status = 'ok'

    return {
      item, category: item.categories?.name || 'Uncategorised',
      openQty, netPurch, usageQty, wasteQty, staffQty,
      onHand, isNegative, par, unitRate, stockValue,
      stockSource: hasClosing ? 'closing' : 'theoretical', status,
    }
  })
}
