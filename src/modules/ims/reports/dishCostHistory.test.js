import {
  buildDishCostHistory, monthlyAveragePrices, itemPriceSeries, monthsAscending, windowMonths,
  todayRatesOf, dishesOf, sortDishRows, dishCostSummary, dishCostSheetRows, changeDirection,
  DISH_STATUS, PRICE_SOURCE, SORTS, monthLabel,
} from './dishCostHistory'
import { buildRecipeBook, explodeRecipeIngredients, computeRecipeCosts, ingredientCostOf } from '../../../utils/recipeCost'

// Four months, handed over newest first the way the shared period list arrives.
const P1 = { id: 'p1', bs_year: 2082, bs_month: 4 }   // Shrawan
const P2 = { id: 'p2', bs_year: 2082, bs_month: 5 }   // Bhadra
const P3 = { id: 'p3', bs_year: 2082, bs_month: 6 }   // Ashwin
const P4 = { id: 'p4', bs_year: 2082, bs_month: 7 }   // Kartik
const PERIODS = [P4, P3, P2, P1]

const line = (item_id, period_id, qty, rate, extra = {}) => ({ id: `${item_id}-${period_id}-${qty}-${rate}`, item_id, period_id, qty, rate, vat_inclusive: false, vat_is_cost: false, ...extra })

// A recipe book shaped like loadRecipeBook's read (RECIPE_BOOK_SELECT), so the report is fed by the
// same walk every other cost figure uses.
function bookOf() {
  return buildRecipeBook([
    { id: 'momo', name: 'Chicken Momo', category: 'Food', yield_qty: 1, cost_price: null, recipe_ingredients: [
      { id: 'i1', recipe_id: 'momo', qty_per_portion: 0.2, item_id: 'chicken', sub_recipe_id: null, items: { name: 'Chicken', per_uom_rate: 130, yield_pct: 100 } },
      { id: 'i2', recipe_id: 'momo', qty_per_portion: 0.5, item_id: 'flour', sub_recipe_id: null, items: { name: 'Flour', per_uom_rate: 60, yield_pct: 100 } },
    ] },
    // Achar uses a sub-recipe: half a litre of a sauce whose batch makes 2 litres, so a quarter batch.
    { id: 'achar', name: 'Achar Plate', category: 'Food', yield_qty: 1, cost_price: null, recipe_ingredients: [
      { id: 'i3', recipe_id: 'achar', qty_per_portion: 0.5, item_id: null, sub_recipe_id: 'sauce', items: null },
    ] },
    { id: 'sauce', name: 'Tomato Sauce', category: 'Sub-Recipe', yield_qty: 2, cost_price: null, recipe_ingredients: [
      // 50% yield: 1 kg bought gives 0.5 kg usable, so the walk doubles the raw quantity.
      { id: 'i4', recipe_id: 'sauce', qty_per_portion: 1, item_id: 'tomato', sub_recipe_id: null, items: { name: 'Tomato', per_uom_rate: 80, yield_pct: 50 } },
    ] },
    // An ingredient hidden in Item Master: the embed carries no filter, and neither does the report.
    { id: 'lassi', name: 'Lassi', category: 'Beverage', yield_qty: 1, cost_price: null, recipe_ingredients: [
      { id: 'i5', recipe_id: 'lassi', qty_per_portion: 0.3, item_id: 'curd', sub_recipe_id: null, items: { name: 'Curd', per_uom_rate: 200, yield_pct: 100, is_active: false } },
    ] },
    { id: 'tea', name: 'Masala Tea', category: 'Beverage', yield_qty: 1, cost_price: 35, recipe_ingredients: [] },
    { id: 'bowl', name: 'Acai Bowl', category: 'Food', yield_qty: 1, cost_price: null, is_build_your_own: true, recipe_ingredients: [
      { id: 'i6', recipe_id: 'bowl', qty_per_portion: 1, item_id: 'flour', sub_recipe_id: null, items: { name: 'Flour', per_uom_rate: 60, yield_pct: 100 } },
    ] },
    { id: 'empty', name: 'New Dish', category: 'Food', yield_qty: 1, cost_price: null, recipe_ingredients: [] },
    { id: 'water', name: 'Water', category: 'Beverage', yield_qty: 1, cost_price: null, recipe_ingredients: [
      { id: 'i7', recipe_id: 'water', qty_per_portion: 1, item_id: 'gift', sub_recipe_id: null, items: { name: 'Gift Bottle', per_uom_rate: 0, yield_pct: 100 } },
    ] },
  ])
}

const DISHES = [
  { id: 'momo', name: 'Chicken Momo', category: 'Food', cost_price: null },
  { id: 'achar', name: 'Achar Plate', category: 'Food', cost_price: null },
  { id: 'lassi', name: 'Lassi', category: 'Beverage', cost_price: null },
  { id: 'tea', name: 'Masala Tea', category: 'Beverage', cost_price: 35 },
  { id: 'bowl', name: 'Acai Bowl', category: 'Food', cost_price: null, is_build_your_own: true },
  { id: 'empty', name: 'New Dish', category: 'Food', cost_price: null },
  { id: 'water', name: 'Water', category: 'Beverage', cost_price: null },
]

const PURCHASES = [
  // Chicken: first bought in Bhadra (two bills, weighted), a free crate that month, nothing in
  // Ashwin, a PAN-bill VAT line in Kartik.
  line('chicken', 'p2', 10, 100),
  line('chicken', 'p2', 30, 120),
  line('chicken', 'p2', 5, 0),
  line('chicken', 'p4', 20, 100, { vat_inclusive: true, vat_is_cost: true }),
  // Flour bought every month; a VAT line on a VAT-registered outlet stays ex-VAT.
  line('flour', 'p1', 50, 50),
  line('flour', 'p2', 50, 55),
  line('flour', 'p3', 50, 58, { vat_inclusive: true, vat_is_cost: false }),
  line('flour', 'p4', 50, 62),
  // Tomato bought in Shrawan and Kartik only.
  line('tomato', 'p1', 10, 70),
  line('tomato', 'p4', 10, 90),
  // Curd (hidden item) bought in Ashwin.
  line('curd', 'p3', 5, 180),
  // A line whose month the client does not have: cannot be placed in time.
  line('flour', 'ghost', 50, 999),
  // The gift bottle was only ever received free.
  line('gift', 'p2', 12, 0),
]

async function report({ months = monthsAscending(PERIODS), customizationEnabled = true, purchases = PURCHASES } = {}) {
  const book = bookOf()
  const ids = DISHES.map(d => d.id)
  const breakdown = await explodeRecipeIngredients(null, ids, { book })
  return {
    book, breakdown,
    result: buildDishCostHistory({ dishes: DISHES, breakdown, purchases, periods: PERIODS, months, todayRates: todayRatesOf(book), customizationEnabled }),
  }
}
const rowOf = (result, id) => result.rows.find(r => r.id === id)
const close = (a, b) => expect(a).toBeCloseTo(b, 6)

describe('months', () => {
  test('sorts oldest first and labels by BS month', () => {
    expect(monthsAscending(PERIODS).map(p => p.id)).toEqual(['p1', 'p2', 'p3', 'p4'])
    expect(monthLabel(P1)).toBe('Shrawan 2082')
  })

  test('a window is the N existing months ending at the chosen one', () => {
    const asc = monthsAscending(PERIODS)
    expect(windowMonths(asc, 'p4', 3).map(p => p.id)).toEqual(['p2', 'p3', 'p4'])
    expect(windowMonths(asc, 'p3', 6).map(p => p.id)).toEqual(['p1', 'p2', 'p3'])
    expect(windowMonths(asc, 'p2', 0).map(p => p.id)).toEqual(['p1', 'p2'])
    // An unknown end month falls back to the latest rather than to nothing.
    expect(windowMonths(asc, 'nope', 2).map(p => p.id)).toEqual(['p3', 'p4'])
    expect(windowMonths([], 'p1', 3)).toEqual([])
  })
})

describe('monthly price per ingredient', () => {
  const monthly = monthlyAveragePrices(PURCHASES, PERIODS)

  test('is the average paid, weighted by quantity', () => {
    close(monthly.get('chicken').get('p2').avg, (10 * 100 + 30 * 120) / 40)
  })

  test('drops a free line rather than averaging it in', () => {
    expect(monthly.get('chicken').get('p2').qty).toBe(40)
    expect(monthly.has('gift')).toBe(false)
  })

  test('counts the 13% on a PAN-bill VAT line as cost, and only there', () => {
    close(monthly.get('chicken').get('p4').avg, 113)
    close(monthly.get('flour').get('p3').avg, 58)
  })

  test('leaves out a line whose month the client does not have', () => {
    expect(monthly.get('flour').has('ghost')).toBe(false)
  })

  test('carries the last bought month forward and estimates before the first purchase', () => {
    const series = itemPriceSeries(monthly.get('chicken'), monthsAscending(PERIODS), 130)
    expect(series.map(s => s.source)).toEqual([PRICE_SOURCE.estimated, PRICE_SOURCE.bought, PRICE_SOURCE.carried, PRICE_SOURCE.bought])
    expect(series[0].price).toBe(130)          // today's Item Master rate stands in
    close(series[2].price, 115)                // Ashwin carries Bhadra's average
  })
})

describe('dish cost per month', () => {
  test('prices the recipe as it is today at each month of ingredient prices', async () => {
    const { result } = await report()
    const momo = rowOf(result, 'momo')
    expect(momo.status).toBe(DISH_STATUS.costed)
    // 0.2 chicken + 0.5 flour per portion
    close(momo.cells[0].cost, 0.2 * 130 + 0.5 * 50)    // Shrawan: chicken not bought yet
    close(momo.cells[1].cost, 0.2 * 115 + 0.5 * 55)
    close(momo.cells[2].cost, 0.2 * 115 + 0.5 * 58)    // chicken carried
    close(momo.cells[3].cost, 0.2 * 113 + 0.5 * 62)
    close(momo.now, 0.2 * 130 + 0.5 * 60)              // Item Master today
  })

  test('marks a cell estimated when any ingredient leans on the stand-in price', async () => {
    const { result } = await report()
    const momo = rowOf(result, 'momo')
    expect(momo.cells.map(c => c.estimated)).toEqual([true, false, false, false])
    expect(momo.estimatedCells).toBe(1)
    // A carried month is a price actually paid, so it is not estimated.
    expect(rowOf(result, 'achar').cells.map(c => c.estimated)).toEqual([false, false, false, false])
  })

  test('follows sub-recipe scaling and yield through the exploded recipe', async () => {
    const { result, breakdown } = await report()
    // 0.5 L of a 2 L batch = 0.25 batch; 1 kg tomato per batch at 50% yield = 2 kg raw, so 0.5 kg.
    expect(breakdown.achar).toEqual([{ item_id: 'tomato', qty: 0.5 }])
    const achar = rowOf(result, 'achar')
    close(achar.cells[0].cost, 0.5 * 70)
    close(achar.cells[2].cost, 0.5 * 70)    // carried through Bhadra and Ashwin
    close(achar.cells[3].cost, 0.5 * 90)
  })

  test('keeps the history of an ingredient hidden in Item Master', async () => {
    const { book, result } = await report()
    expect(todayRatesOf(book).curd).toBe(200)
    const lassi = rowOf(result, 'lassi')
    expect(lassi.status).toBe(DISH_STATUS.costed)
    close(lassi.cells[2].cost, 0.3 * 180)
    expect(lassi.cells.map(c => c.estimated)).toEqual([true, true, false, false])
  })

  test('change runs from the first month shown to the last, in NPR and %', async () => {
    const { result } = await report()
    const momo = rowOf(result, 'momo')
    const first = 0.2 * 130 + 0.5 * 50, last = 0.2 * 113 + 0.5 * 62
    close(momo.change, last - first)
    close(momo.changePct, ((last - first) / first) * 100)
    expect(momo.changeEstimated).toBe(true)    // its first month is estimated
    const achar = rowOf(result, 'achar')
    close(achar.change, 0.5 * 90 - 0.5 * 70)
    expect(achar.changeEstimated).toBe(false)
  })

  test('a window narrower than the history still carries prices from before it', async () => {
    const months = windowMonths(monthsAscending(PERIODS), 'p3', 1)
    const { result } = await report({ months })
    const achar = rowOf(result, 'achar')
    close(achar.cells[0].cost, 0.5 * 70)       // Ashwin, carried from Shrawan outside the window
    expect(achar.change).toBeNull()            // one month has nothing to compare
  })

  test('Now matches the shared cost engine on the same book', async () => {
    const { book, breakdown, result } = await report()
    const costs = await computeRecipeCosts(null, ['momo', 'achar', 'lassi'], { book })
    for (const id of ['momo', 'achar', 'lassi']) close(rowOf(result, id).now, costs[id])
    close(ingredientCostOf(breakdown.momo, { chicken: 1, flour: 1 }), 0.7)
  })
})

describe('dishes the report cannot follow', () => {
  test('a dish priced by hand is a dash with its reason', async () => {
    const { result } = await report()
    const tea = rowOf(result, 'tea')
    expect(tea.status).toBe(DISH_STATUS.manual)
    expect(tea.reason).toMatch(/by hand/)
    expect(tea.cells.every(c => c.cost == null)).toBe(true)
    expect(tea.now).toBeNull()
    expect(tea.change).toBeNull()
  })

  test('a build-your-own dish is not followed while Customization is on, and is costed while it is off', async () => {
    const on = rowOf((await report()).result, 'bowl')
    expect(on.status).toBe(DISH_STATUS.byo)
    expect(on.now).toBeNull()
    const off = rowOf((await report({ customizationEnabled: false })).result, 'bowl')
    expect(off.status).toBe(DISH_STATUS.costed)
    close(off.cells[0].cost, 50)
  })

  test('no ingredients and no cost, or ingredients with no price at all, are dashes too', async () => {
    const { result } = await report()
    expect(rowOf(result, 'empty').status).toBe(DISH_STATUS.noCost)
    // Only ever received free, and no Item Master price: a zero is not a cost.
    const water = rowOf(result, 'water')
    expect(water.status).toBe(DISH_STATUS.unpriced)
    expect(water.cells.every(c => c.cost == null)).toBe(true)
  })

  test('the dish list leaves out sub-recipes and hidden dishes', () => {
    const listed = dishesOf([
      { id: 'a', category: 'Food' },
      { id: 'b', category: 'Sub-Recipe' },
      { id: 'c', category: 'Food', is_active: false },
      { id: 'd', category: null, is_active: null },
    ])
    expect(listed.map(d => d.id)).toEqual(['a', 'd'])
  })
})

describe('sorting', () => {
  test('biggest rise first, the dash rows last in both directions', async () => {
    const { result } = await report()
    const desc = sortDishRows(result.rows, SORTS.rise, 'desc').map(r => r.id)
    const asc = sortDishRows(result.rows, SORTS.rise, 'asc').map(r => r.id)
    const dashes = ['bowl', 'tea', 'empty', 'water'].sort((a, b) =>
      rowOf(result, a).name.localeCompare(rowOf(result, b).name))
    expect(desc.slice(-4)).toEqual(dashes)
    expect(asc.slice(-4)).toEqual(dashes)
    const costed = desc.slice(0, 3)
    const changes = costed.map(id => rowOf(result, id).change)
    expect([...changes].sort((a, b) => b - a)).toEqual(changes)
    expect(asc.slice(0, 3)).toEqual([...costed].reverse())
  })

  test('by name and by cost today', async () => {
    const { result } = await report()
    const byName = sortDishRows(result.rows, SORTS.name, 'asc').map(r => r.name)
    expect(byName.slice(0, 3)).toEqual(['Achar Plate', 'Chicken Momo', 'Lassi'])
    const byNow = sortDishRows(result.rows, SORTS.now, 'desc').slice(0, 3).map(r => r.id)
    expect(byNow).toEqual(['lassi', 'momo', 'achar'])
  })
})

describe('summary and sheet', () => {
  test('counts what rose, what fell and what the report could not follow', async () => {
    const { result } = await report()
    const s = dishCostSummary(result.rows)
    expect(s.listed).toBe(7)
    expect(s.costed).toBe(3)
    expect(s.notFollowed).toBe(4)
    // Momo and Achar rose; Lassi fell, its curd bought below the Item Master rate that stood in.
    expect(s.rising).toBe(2)
    expect(s.falling).toBe(1)
    expect(s.biggestRise.id).toBe('achar')
    expect(s.withEstimates).toBe(2)
  })

  test('the dead zone calls a tiny move steady', () => {
    expect(changeDirection({ change: 0.004, changePct: 0.01 })).toBe('steady')
    expect(changeDirection({ change: 0.2, changePct: 0.3 })).toBe('steady')
    expect(changeDirection({ change: -5, changePct: -4 })).toBe('down')
    expect(changeDirection({ change: null })).toBeNull()
  })

  test('the sheet keeps numbers as numbers and lists the estimated months', async () => {
    const { result } = await report()
    const rows = dishCostSheetRows(sortDishRows(result.rows, SORTS.name, 'asc'), result.months)
    const momo = rows.find(r => r.Dish === 'Chicken Momo')
    expect(typeof momo['Shrawan 2082']).toBe('number')
    expect(momo['Shrawan 2082']).toBe(Number((0.2 * 130 + 0.5 * 50).toFixed(2)))
    expect(momo['Estimated months']).toBe('Shrawan 2082')
    const tea = rows.find(r => r.Dish === 'Masala Tea')
    expect(tea['Kartik 2082']).toBe('')
    expect(tea['Now (Item Master)']).toBe('')
    expect(tea.Note).toMatch(/by hand/)
    expect(Object.keys(momo)).toEqual(['Dish', 'Category', 'Shrawan 2082', 'Bhadra 2082', 'Ashwin 2082', 'Kartik 2082',
      'Now (Item Master)', 'Change (NPR)', 'Change %', 'Estimated months', 'Note'])
  })
})
