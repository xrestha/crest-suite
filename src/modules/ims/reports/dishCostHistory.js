// Dish Cost History (S885) — pure, pinned by dishCostHistory.test.js.
//
// What each dish would have cost per portion in each BS month, at THAT month's purchase prices, on
// TODAY's recipe. Nothing is stored: the recipe walk is the shared one (`explodeRecipeIngredients`,
// fed the recipe book), and its multiply step is `ingredientCostOf` from the same file, so this page
// prices exactly the raw items, yields and sub-recipe scaling that Recipe Costing and COGS use. Only
// the rate map changes from month to month. The figure answers "what did price moves do to this
// dish", not "what did it cost to make it then" (a recipe edit is not history here).
//
// A month's price for an ingredient is the AVERAGE PAID that month, weighted by quantity, read the
// way Price Tracker reads a price (owner decision): the line's rate × `vatCostFactor` (the 13% a
// PAN-bill outlet cannot claim back), free lines dropped (Price Tracker's `priced()` rule: a rate of
// 0 is a gift, not a price), before any bill-level discount, so the two pages agree.
//   - A month in which the ingredient was not bought carries the price of the last month it was
//     bought in ("carried"), so a dish line stays flat through a month nobody bought anything.
//   - Before the ingredient's very first priced purchase there is no price paid to use, so today's
//     Item Master rate (`per_uom_rate`) stands in, and every dish-month cell that leans on such a
//     stand-in is marked ESTIMATED.
//   - An item hidden in Item Master keeps its history: nothing here filters on `is_active`, because a
//     recipe still consumes a hidden item (recipes-and-subrecipes.md, the S711 `calcLiveCost` note).
//
// Dishes this cannot follow are listed with a dash and the reason, and sort last (owner decision):
// a dish priced by hand (no ingredients, a manual `cost_price`), a build-your-own dish while
// Customization is on (`isCostedByBuild`: its plate is the guest's picks), and a dish with no
// ingredients and no cost at all. A cost of zero is never shown as a cost (S724).

import { vatCostFactor } from './supplierAttribution'
import { ingredientCostOf } from '../../../utils/recipeCost'
import { isCostedByBuild, BYO_REASON } from '../recipes/buildYourOwnRating'
import { SUB_RECIPE_CATEGORY } from '../../../shared/productCode'
import { BS_MONTHS } from '../../../utils/bsCalendar'

/** Why a row has no figures. `costed` rows have them. */
export const DISH_STATUS = {
  costed: 'costed',
  manual: 'manual',
  byo: 'byo',
  noCost: 'nocost',
  unpriced: 'unpriced',
}

export const DISH_REASON = {
  manual: 'Priced by hand: it has no ingredients for the price history to follow',
  byo: BYO_REASON,
  nocost: 'No ingredients and no cost entered yet',
  unpriced: 'Its ingredients have no purchase price and no Item Master price yet',
}

/** Where a month's ingredient price came from. */
export const PRICE_SOURCE = { bought: 'bought', carried: 'carried', estimated: 'estimated' }

// Below this a move is noise, not a rise or a fall (Price Tracker's dead zone, S644): a per-portion
// change under half a percent, or under a paisa.
export const STEADY_PCT = 0.5
export const STEADY_NPR = 0.01

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }

/** "Shrawan 2082" */
export function monthLabel(p) {
  return p ? `${BS_MONTHS[p.bs_month - 1] || '?'} ${p.bs_year}` : ''
}

/** Months oldest first, by BS year and month (the period list arrives newest first). */
export function monthsAscending(periods) {
  return [...(periods || [])].sort((a, b) =>
    (a.bs_year - b.bs_year) || (a.bs_month - b.bs_month) || String(a.id).localeCompare(String(b.id)))
}

/**
 * The months a window shows: the `span` existing months ending at `toId` (all of them up to it when
 * `span` is falsy or larger than what exists). A month missing from the list is simply not a column.
 */
export function windowMonths(ascending, toId, span) {
  const list = ascending || []
  if (list.length === 0) return []
  let end = list.findIndex(p => p.id === toId)
  if (end < 0) end = list.length - 1
  const start = span > 0 ? Math.max(0, end - span + 1) : 0
  return list.slice(start, end + 1)
}

/**
 * Item id → period id → { qty, value, avg }: the quantity-weighted average price paid per base unit
 * in each month, over the PRICED lines only. A line whose period is not in `periods` cannot be placed
 * in time and is left out; a line with no quantity carries no weight.
 */
export function monthlyAveragePrices(purchases, periods) {
  const known = new Set((periods || []).map(p => p.id))
  const out = new Map()
  for (const pe of purchases || []) {
    if (!pe || !pe.item_id || !known.has(pe.period_id)) continue
    const paid = num(pe.rate) * vatCostFactor(pe)
    const qty = num(pe.qty)
    if (!(paid > 0) || !(qty > 0)) continue   // a free line is not a price (Price Tracker's priced())
    let byMonth = out.get(pe.item_id)
    if (!byMonth) { byMonth = new Map(); out.set(pe.item_id, byMonth) }
    const a = byMonth.get(pe.period_id) || { qty: 0, value: 0, avg: 0 }
    a.qty += qty
    a.value += qty * paid
    a.avg = a.value / a.qty
    byMonth.set(pe.period_id, a)
  }
  return out
}

/**
 * One item's price in every month of `ascending` (all the client's months, oldest first):
 * `[{ price, source }]` in the same order. `todayRate` is the Item Master rate that stands in before
 * the first purchase.
 */
export function itemPriceSeries(byMonth, ascending, todayRate) {
  const series = []
  let last = null
  for (const p of ascending || []) {
    const bought = byMonth ? byMonth.get(p.id) : null
    if (bought) {
      last = bought.avg
      series.push({ price: bought.avg, source: PRICE_SOURCE.bought })
    } else if (last != null) {
      series.push({ price: last, source: PRICE_SOURCE.carried })
    } else {
      series.push({ price: num(todayRate), source: PRICE_SOURCE.estimated })
    }
  }
  return series
}

/** Item id → today's Item Master rate per base unit, from a recipe book (`buildRecipeBook`). */
export function todayRatesOf(book) {
  const rates = {}
  if (book && book.items) book.items.forEach((item, id) => { rates[id] = num(item && item.per_uom_rate) })
  return rates
}

/** The dishes the report lists: every recipe that is not a sub-recipe and is not hidden. */
export function dishesOf(recipes) {
  return (recipes || []).filter(r => r && r.is_active !== false && r.category !== SUB_RECIPE_CATEGORY)
}

/**
 * The report.
 * @param {object} args
 * @param {Array} args.dishes      recipes to list ({ id, name, category, cost_price, is_build_your_own })
 * @param {object} args.breakdown  explodeRecipeIngredients output: dish id → [{ item_id, qty }] per portion
 * @param {Array} args.purchases   purchase_entries ({ item_id, period_id, rate, qty, vat_inclusive, vat_is_cost })
 * @param {Array} args.periods     every month the client has ({ id, bs_year, bs_month }), any order
 * @param {Array} args.months      the months to show, oldest first (a slice of the above)
 * @param {object} args.todayRates item id → today's Item Master rate per base unit
 * @param {boolean} args.customizationEnabled
 * @returns {{ months, rows }} rows: { id, name, category, status, reason, cells: [{ periodId, cost, estimated }],
 *   now, change, changePct, changeEstimated, estimatedCells }
 */
export function buildDishCostHistory({ dishes, breakdown, purchases, periods, months, todayRates = {}, customizationEnabled = false }) {
  const ascending = monthsAscending(periods)
  const shown = months || []
  const indexOf = new Map(ascending.map((p, i) => [p.id, i]))
  const monthly = monthlyAveragePrices(purchases, ascending)

  // Each ingredient's series is worked out once, however many dishes use it.
  const seriesCache = new Map()
  const seriesOf = itemId => {
    if (!seriesCache.has(itemId)) seriesCache.set(itemId, itemPriceSeries(monthly.get(itemId), ascending, todayRates[itemId]))
    return seriesCache.get(itemId)
  }

  // One rate map and one estimated set per shown month, over every item any dish uses.
  const itemIds = new Set()
  for (const d of dishes || []) for (const r of (breakdown && breakdown[d.id]) || []) itemIds.add(r.item_id)
  const monthRates = shown.map(p => {
    const i = indexOf.get(p.id)
    const rates = {}
    const estimated = new Set()
    for (const id of itemIds) {
      const point = i == null ? null : seriesOf(id)[i]
      if (!point) { rates[id] = num(todayRates[id]); estimated.add(id); continue }
      rates[id] = point.price
      if (point.source === PRICE_SOURCE.estimated) estimated.add(id)
    }
    return { rates, estimated }
  })

  const rows = (dishes || []).map(d => {
    const base = { id: d.id, name: d.name || '', category: d.category || '' }
    const blank = (status) => ({
      ...base, status, reason: DISH_REASON[status],
      cells: shown.map(p => ({ periodId: p.id, cost: null, estimated: false })),
      now: null, change: null, changePct: null, changeEstimated: false, estimatedCells: 0,
    })
    if (isCostedByBuild(d, customizationEnabled)) return blank(DISH_STATUS.byo)
    const lines = ((breakdown && breakdown[d.id]) || []).filter(r => num(r.qty) > 0)
    if (lines.length === 0) return blank(num(d.cost_price) > 0 ? DISH_STATUS.manual : DISH_STATUS.noCost)

    const cells = shown.map((p, k) => {
      const cost = ingredientCostOf(lines, monthRates[k].rates)
      return {
        periodId: p.id,
        cost: cost > 0 ? cost : null,
        estimated: lines.some(r => monthRates[k].estimated.has(r.item_id)),
      }
    })
    const nowCost = ingredientCostOf(lines, todayRates)
    const now = nowCost > 0 ? nowCost : null
    if (now == null && cells.every(c => c.cost == null)) return blank(DISH_STATUS.unpriced)

    const first = cells[0], last = cells[cells.length - 1]
    let change = null, changePct = null
    if (cells.length >= 2 && first.cost != null && last.cost != null) {
      change = last.cost - first.cost
      changePct = first.cost > 0 ? (change / first.cost) * 100 : null
    }
    return {
      ...base, status: DISH_STATUS.costed, reason: null, cells, now, change, changePct,
      changeEstimated: change != null && (first.estimated || last.estimated),
      estimatedCells: cells.filter(c => c.estimated && c.cost != null).length,
    }
  })
  return { months: shown, rows }
}

/** 'up' | 'down' | 'steady' | null for a row's change, with the dead zone above. */
export function changeDirection(row) {
  if (!row || row.change == null) return null
  if (Math.abs(row.change) < STEADY_NPR) return 'steady'
  if (row.changePct != null && Math.abs(row.changePct) < STEADY_PCT) return 'steady'
  return row.change > 0 ? 'up' : 'down'
}

export const SORTS = {
  rise: 'rise',
  risePct: 'risePct',
  name: 'name',
  now: 'now',
}

/**
 * Rows in display order. A figure sort opens descending; rows WITHOUT the figure (a dash) sort last
 * in both directions (page-layout.md), and a row the report cannot follow sorts after those.
 */
export function sortDishRows(rows, key = SORTS.rise, dir = 'desc') {
  const sign = dir === 'asc' ? 1 : -1
  const figureOf = r => key === SORTS.rise ? r.change
    : key === SORTS.risePct ? r.changePct
    : key === SORTS.now ? r.now
    : null
  const tier = r => r.status !== DISH_STATUS.costed ? 2 : (key !== SORTS.name && figureOf(r) == null ? 1 : 0)
  const byName = (a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id))
  return [...(rows || [])].sort((a, b) => {
    const t = tier(a) - tier(b)
    if (t) return t
    if (key === SORTS.name) return sign * byName(a, b)
    if (tier(a) > 0) return byName(a, b)   // the dash rows keep A to Z whichever way the figure runs
    const d = figureOf(a) - figureOf(b)
    return d ? sign * d : byName(a, b)
  })
}

/** The headline counts, over the rows given (the filtered list on screen). */
export function dishCostSummary(rows) {
  const costed = (rows || []).filter(r => r.status === DISH_STATUS.costed)
  const compared = costed.filter(r => r.change != null)
  const up = compared.filter(r => changeDirection(r) === 'up')
  const down = compared.filter(r => changeDirection(r) === 'down')
  const biggest = up.reduce((best, r) => (best == null || r.change > best.change ? r : best), null)
  return {
    listed: (rows || []).length,
    costed: costed.length,
    compared: compared.length,
    rising: up.length,
    falling: down.length,
    biggestRise: biggest,
    notFollowed: (rows || []).length - costed.length,
    withEstimates: costed.filter(r => r.estimatedCells > 0).length,
  }
}

/** Rounded for a sheet cell: a number, or '' for a missing figure. */
export function sheetNumber(n, dp = 2) {
  return n == null || !Number.isFinite(n) ? '' : Number(n.toFixed(dp))
}

/**
 * The Excel rows: the same rows in the same order, numbers as numbers, one column per month.
 * Estimated cells are listed by month in their own column, since a number cell cannot carry the mark.
 */
export function dishCostSheetRows(rows, months) {
  const labels = (months || []).map(monthLabel)
  return (rows || []).map(r => {
    const out = { 'Dish': r.name, 'Category': r.category }
    r.cells.forEach((c, k) => { out[labels[k]] = sheetNumber(c.cost) })
    out['Now (Item Master)'] = sheetNumber(r.now)
    out['Change (NPR)'] = sheetNumber(r.change)
    out['Change %'] = sheetNumber(r.changePct)
    out['Estimated months'] = r.cells.map((c, k) => (c.estimated && c.cost != null ? labels[k] : null)).filter(Boolean).join(', ')
    out['Note'] = r.reason || ''
    return out
  })
}
