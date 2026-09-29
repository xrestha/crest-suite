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
// The callers do the reads. Two conventions live in those reads, not here: `items` is every
// non-sub-recipe item, HIDDEN ONES INCLUDED (prep is counted at the raw-item level), and
// `sales_entries` selects `source` with no server-side `.neq` (S756), because `source` is nullable.
//
// Hidden items are in the read since S792 (FIGURES-1, owner decision D29: hiding never changes
// history). Every one of these pages read `items` with `.eq('is_active', true)` and valued
// purchases and returns only for the ids in that list, so an item bought and used all year and then
// hidden — which Item Master tells the owner to do on a unit change — left every past month's Net
// Purchases, COGS and Food Cost %, closed months included, while the frozen Owner Report kept it.
// `is_active` now belongs to pickers and "on the shelf now" views only. A period is valued over
// every item with a row in it (`periodValuationItems`); S720's within-row rule still holds, since an
// item is in every column of a row or in none.
import { computeUsed } from '../../../shared/imsFormulas'
import { findUncountedItems } from '../../../shared/uncountedItems'
import { allocateBillDiscounts, returnCostValue } from './supplierAttribution'

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
 *
 * Values are on the COST basis (S792, D32): `gross`/`value` are `lineGrossCost`/`lineCost`, so a
 * VAT-ticked line on a `vat_is_cost` (PAN-bill) bill counts its 13% as food cost, and a return takes
 * its linked line's basis through `returnCostValue` — read returns with `RETURN_COST_EMBED` and
 * purchases with `vat_inclusive, vat_is_cost`, or both silently value at ex-VAT.
 * `get_group_pnl` mirrors this by hand.
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
    e.gross += p.lineGrossCost
    e.value += p.lineCost
  })
  const returnMap = {}
  ;(returns || []).forEach(r => {
    const e = returnMap[r.item_id] || (returnMap[r.item_id] = { qty: 0, value: 0 })
    e.qty += parseFloat(r.qty) || 0
    e.value += returnCostValue(r)
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
 *
 * `wastageVal` is COGS's wastage term, over the same `items` (no prep), which is why it is not the
 * figure a Wastage tile shows — that is `periodWastageValue()` below (S792, FIGURES-5).
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

/**
 * "Wastage value" for a period: the one figure every Wastage tile and the Wastage Report show
 * (S792, FIGURES-5). Each tile had valued the same month over its own item list — Monthly Summary
 * and the Dashboard over raw items (no prep), the Owner Dashboard over every item, the Owner Report
 * over active items only (prep in, hidden out) — so two tiles both called "Wastage Value" could
 * differ for the same open month with nothing saying why. This is the Wastage Report's set:
 * every wastage row, whatever its item — hidden ones (D29: hiding never changes history) and prep
 * (sub-recipe mirror items, which Stock Count lets you log) included — at the item's per_uom_rate.
 *
 * The rate comes from the row's own join (`WASTAGE_VALUE_SELECT`), not from a caller's item list,
 * so no page's list can narrow the set again. A row of 0 or less is not counted, as on the report.
 *
 * INFORMATION ONLY. Never pass it to computeUsed() or show it as a cost line beside COGS: COGS
 * values raw items only (prep is costed at the raw-item level), so a wasted tray of prep is already
 * inside COGS through the raw ingredients it was made from. Taking it off COGS would pull real food
 * cost out of Food Cost %; showing it as Consolidated P&L's Wastage line while COGS keeps it would
 * count it twice. `valuePeriodItems`' `wastageVal` is the COGS term and stays over the caller's
 * raw items.
 */
export const WASTAGE_VALUE_SELECT = 'item_id, qty, items(per_uom_rate)'

/** One wastage row's value, the Wastage Report's rule: qty × the item's rate, 0 for qty ≤ 0. */
export function wastageRowValue(row) {
  const qty = parseFloat(row?.qty) || 0
  if (qty <= 0) return 0
  return qty * (parseFloat(row?.items?.per_uom_rate) || 0)
}

/** Σ `wastageRowValue` over a period's wastage rows, read with `WASTAGE_VALUE_SELECT`. */
export function periodWastageValue(rows) {
  return (rows || []).reduce((s, r) => s + wastageRowValue(r), 0)
}

/**
 * Every item id with a row in the period — an opening figure, a purchase line, a return, a closing
 * row (a count of 0 and a blank count both count as a ROW), a wastage or a staff meal. Takes the raw
 * rows, not `periodStockMaps` output, so a page whose purchase read carries no rate (Stock Report)
 * can ask the same question.
 */
export function periodRowIds({ opening, closing, purchases, returns, wastages, staffMeals } = {}) {
  const ids = new Set()
  for (const rows of [opening, closing, purchases, returns, wastages, staffMeals]) {
    for (const r of rows || []) if (r && r.item_id != null) ids.add(r.item_id)
  }
  return ids
}

/**
 * The items a period is valued over (S792, D29): every active item, plus every HIDDEN item that has
 * a row in the period. `items` is the caller's read of every non-sub-recipe item, active or not;
 * `rowIds` is `periodRowIds(...)` for the same period.
 *
 * The totals would be the same over the whole read — a hidden item with no row contributes zero —
 * so this exists for what a page LISTS and COUNTS: a category's "N items", the uncounted-items
 * banner, Stock Report's rows. A hidden item nothing happened to in the month is not part of it.
 * `is_active` is nullable (DEFAULT true, no NOT NULL), so only an explicit `false` is hidden.
 */
export function periodValuationItems(items, rowIds) {
  const has = id => (rowIds instanceof Set ? rowIds.has(id) : !!rowIds?.[id])
  return (items || []).filter(i => i && (i.is_active !== false || has(i.id)))
}

/**
 * The uncounted-items gap (S756, D6) for one period, from the same maps its COGS came from. A
 * closing row whose `physical_qty` is null is not a count; one holding 0 is (closePeriod.js's
 * `physical_qty IS NOT NULL` rule), which is why this reads the raw closing rows and not the map.
 */
export function periodGap({ items, maps, closing, cogs }) {
  const countedIds = new Set((closing || []).filter(r => r.physical_qty != null).map(r => r.item_id))
  const purchaseQty = {}; const purchaseValue = {}
  Object.entries(maps.purchases || {}).forEach(([id, v]) => { purchaseQty[id] = v.qty; purchaseValue[id] = v.value })
  return findUncountedItems({ items, openingQty: maps.opening || {}, purchaseQty, purchaseValue, countedIds, cogs })
}

/**
 * Several periods valued at once — the Dashboard's Food Cost trend reads eleven closed months in one
 * batch. Every row carries `period_id`. Each period is valued on its own, so its purchases get their
 * own `allocateBillDiscounts` pass. That once kept two legacy bills from different months apart
 * (FIGURES-6); since S792 the fallback bill key carries period_id itself (supplierAttribution.js
 * `allocationBillKey`), so the per-period pass is correct but no longer necessary for that.
 * Returns period id → `valuePeriodItems` output plus that period's `gap` and `itemCount`.
 */
export function valuePeriods({ periodIds, items, opening, closing, purchases, returns, wastages, staffMeals }) {
  const byPeriod = rows => {
    const m = new Map()
    for (const r of rows || []) {
      const list = m.get(r.period_id)
      if (list) list.push(r); else m.set(r.period_id, [r])
    }
    return m
  }
  const tables = {
    opening: byPeriod(opening), closing: byPeriod(closing), purchases: byPeriod(purchases),
    returns: byPeriod(returns), wastages: byPeriod(wastages), staffMeals: byPeriod(staffMeals),
  }
  const out = {}
  for (const pid of periodIds || []) {
    const rows = {}
    for (const [k, m] of Object.entries(tables)) rows[k] = m.get(pid) || []
    const maps = periodStockMaps(rows)
    const valued = periodValuationItems(items, periodRowIds(rows))
    const v = valuePeriodItems(valued, maps)
    out[pid] = { ...v, itemCount: valued.length, gap: periodGap({ items: valued, maps, closing: rows.closing, cogs: v.cogsVal }) }
  }
  return out
}
