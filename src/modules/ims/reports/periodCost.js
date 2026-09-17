// Revenue and COGS for one period, computed in one place (S774).
//
// MonthlySummary.js calls these once per category and ConsolidatedPnl.jsx once for the whole
// outlet, so the P&L's revenue and COGS tie to Monthly Summary's by construction. Before S774 each
// page carried its own copy with comments citing the other, and the copies had already drifted:
// Monthly Summary paged its per-item reads and the P&L did not.
//
// The grouped P&L derives the same raw aggregates in SQL (`get_group_pnl`), which cannot import
// this file. A change to either convention here must be mirrored there by hand.
//
// The callers do the reads. Two conventions live in those reads, not here: `items` is active,
// non-sub-recipe items only (S436; prep is counted at the raw-item level), and `sales_entries`
// selects `source` with no server-side `.neq` (S756), because `source` is nullable.
import { computeUsed } from '../../../shared/imsFormulas'
import { allocateBillDiscounts } from './supplierAttribution'

/**
 * Revenue: each row at the price charged at the time of sale (`unit_price`), falling back to the
 * recipe's current price only for rows recorded before that column existed, net of the row's own
 * discount. Comps are excluded here in JS: a comped dish was never paid for.
 */
export function periodRevenue(salesRows, recipes) {
  const currentPrice = {}
  ;(recipes || []).forEach(r => { currentPrice[r.id] = parseFloat(r.selling_price) || 0 })
  return (salesRows || [])
    .filter(row => row.source !== 'pos_comp')
    .reduce((s, row) => {
      const price = row.unit_price != null ? parseFloat(row.unit_price) : (currentPrice[row.recipe_id] || 0)
      return s + parseFloat(row.qty_sold || 0) * price - (parseFloat(row.discount) || 0)
    }, 0)
}

/**
 * Per-item quantities and purchase values for a period, keyed by item id.
 * `purchases` go through `allocateBillDiscounts`, so each item's `value` is net of its share of
 * the bill discount while `qty` is untouched (a discount changes what was paid, not what arrived).
 * Returns `{ opening, closing, wastage, staffMeals }` as id → qty, `purchases` as
 * id → `{ qty, gross, value }` and `returns` as id → `{ qty, value }`.
 */
export function periodStockMaps({ opening, closing, purchases, returns, wastages, staffMeals }) {
  const qtyBy = (rows, col) => {
    const m = {}
    ;(rows || []).forEach(r => { m[r.item_id] = (m[r.item_id] || 0) + (parseFloat(r[col]) || 0) })
    return m
  }
  const purchaseMap = {}
  allocateBillDiscounts(purchases).forEach(p => {
    const e = purchaseMap[p.item_id] || (purchaseMap[p.item_id] = { qty: 0, gross: 0, value: 0 })
    e.qty += parseFloat(p.qty) || 0
    e.gross += p.lineGross
    e.value += p.lineNet
  })
  const returnMap = {}
  ;(returns || []).forEach(r => {
    const e = returnMap[r.item_id] || (returnMap[r.item_id] = { qty: 0, value: 0 })
    e.qty += parseFloat(r.qty) || 0
    e.value += (parseFloat(r.qty) || 0) * (parseFloat(r.rate) || 0)
  })
  return {
    opening: qtyBy(opening, 'qty'),
    closing: qtyBy(closing, 'physical_qty'),
    wastage: qtyBy(wastages, 'qty'),
    staffMeals: qtyBy(staffMeals, 'qty'),
    purchases: purchaseMap,
    returns: returnMap,
  }
}

/**
 * Values `items` against `periodStockMaps` output. Stock quantities are valued at the item's
 * `per_uom_rate`; purchases and returns carry their own recorded value. Only the ids in `items`
 * count, so a bill discount is credited only for the lines inside the list.
 *
 * `purchaseVal` is gross (before the bill discount), `netPurchaseVal` is after discount and
 * returns, and `cogsVal` is `computeUsed()` over those values.
 */
export function valuePeriodItems(items, maps) {
  let openingVal = 0, purchaseVal = 0, purchaseNetVal = 0, returnVal = 0
  let wastageVal = 0, staffMealsVal = 0, closingVal = 0
  ;(items || []).forEach(i => {
    const rate = parseFloat(i.per_uom_rate) || 0
    openingVal     += (maps.opening[i.id] || 0) * rate
    purchaseVal    += maps.purchases[i.id]?.gross || 0
    purchaseNetVal += maps.purchases[i.id]?.value || 0
    returnVal      += maps.returns[i.id]?.value || 0
    wastageVal     += (maps.wastage[i.id] || 0) * rate
    staffMealsVal  += (maps.staffMeals[i.id] || 0) * rate
    closingVal     += (maps.closing[i.id] || 0) * rate
  })
  const discountVal = purchaseVal - purchaseNetVal
  const netPurchaseVal = purchaseVal - discountVal - returnVal
  const cogsVal = computeUsed({
    opening: openingVal, purchases: netPurchaseVal, returns: 0,
    wastage: wastageVal, staffMeals: staffMealsVal, closing: closingVal,
  })
  return { openingVal, purchaseVal, discountVal, returnVal, netPurchaseVal, wastageVal, staffMealsVal, closingVal, cogsVal }
}
