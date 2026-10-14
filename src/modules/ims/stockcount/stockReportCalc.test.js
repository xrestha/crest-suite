import { buildStockRows, buildUsageMap, summarizeReorder } from './stockReportCalc'

const item = (id, rate = 10) => ({ id, name: id, per_uom_rate: rate, categories: { name: 'Dry' } })
const dish = { dish: [{ item_id: 'rice', qty: 0.2 }] }

function rowsFor(over = {}) {
  return buildStockRows({
    items: [item('rice')],
    opening: [], closing: [], purchases: [], returns: [], wastages: [], staffMeals: [],
    sales: [], breakdown: dish, pars: [],
    ...over,
  })
}

describe('Stock Report on-hand (stockReportCalc)', () => {
  test('requisitions are not a deduction — only opening, purchases, returns, usage, wastage and staff meals move stock', () => {
    const [r] = rowsFor({
      opening: [{ item_id: 'rice', qty: 10 }],
      purchases: [{ item_id: 'rice', qty: 5 }],
      returns: [{ item_id: 'rice', qty: 1 }],
      wastages: [{ item_id: 'rice', qty: 0.5 }],
      staffMeals: [{ item_id: 'rice', qty: 0.5 }],
      sales: [{ recipe_id: 'dish', qty_sold: 10, bs_day: 3, source: 'pos' }],
    })
    // 10 + 5 − 1 − (10 × 0.2) − 0.5 − 0.5 = 11 — nothing else is allowed to touch it.
    expect(r.onHand).toBeCloseTo(11)
    expect(r.stockSource).toBe('theoretical')
    expect(r.status).toBe('ok')
    expect(r.stockValue).toBeCloseTo(110)
  })

  test('a closing row of 0 is a real count: Physical, 0 on hand, out of stock, no phantom value', () => {
    const [r] = rowsFor({
      opening: [{ item_id: 'rice', qty: 10 }],
      closing: [{ item_id: 'rice', physical_qty: 0 }],
    })
    expect(r.stockSource).toBe('closing')
    expect(r.onHand).toBe(0)
    expect(r.status).toBe('out')
    expect(r.stockValue).toBe(0)
  })

  test('an item with no activity at all is idle, not out of stock', () => {
    const [r] = rowsFor()
    expect(r.status).toBe('idle')
    expect(r.onHand).toBe(0)
  })

  test('a negative theoretical figure is flagged and clamped to 0', () => {
    const [r] = rowsFor({
      opening: [{ item_id: 'rice', qty: 1 }],
      sales: [{ recipe_id: 'dish', qty_sold: 10, bs_day: 3, source: 'pos' }],
    })
    expect(r.isNegative).toBe(true)
    expect(r.onHand).toBe(0)
    expect(r.status).toBe('out')
  })

  test('low when under par, only when par is set', () => {
    const [low] = rowsFor({ opening: [{ item_id: 'rice', qty: 4 }], pars: [{ item_id: 'rice', par_qty: 5 }] })
    expect(low.status).toBe('low')
    const [ok] = rowsFor({ opening: [{ item_id: 'rice', qty: 4 }] })
    expect(ok.status).toBe('ok')
  })
})

describe('Below par is one rule for every surface (S696)', () => {
  test('under par: flagged, with the shortfall and its value', () => {
    const [r] = rowsFor({ opening: [{ item_id: 'rice', qty: 3 }], pars: [{ item_id: 'rice', par_qty: 5 }] })
    expect(r.needsReorder).toBe(true)
    expect(r.shortfall).toBeCloseTo(2)
    expect(r.shortfallValue).toBeCloseTo(20)
  })

  test('exactly at par is fine — nothing to buy, so nothing to flag', () => {
    const [r] = rowsFor({ opening: [{ item_id: 'rice', qty: 5 }], pars: [{ item_id: 'rice', par_qty: 5 }] })
    expect(r.needsReorder).toBe(false)
    expect(r.shortfall).toBe(0)
    expect(r.status).toBe('ok')
  })

  test('no par set: never flagged, whatever the stock', () => {
    const [r] = rowsFor({ opening: [{ item_id: 'rice', qty: 0.001 }] })
    expect(r.needsReorder).toBe(false)
    expect(r.par).toBe(0)
  })

  test('staff meals come off the shelf and can push an item below par', () => {
    const base = { opening: [{ item_id: 'rice', qty: 5 }], pars: [{ item_id: 'rice', par_qty: 5 }] }
    expect(rowsFor(base)[0].needsReorder).toBe(false)
    const [r] = rowsFor({ ...base, staffMeals: [{ item_id: 'rice', qty: 1 }] })
    expect(r.needsReorder).toBe(true)
    expect(r.shortfall).toBeCloseTo(1)
  })

  test('a counted 0 with a par is below par by the whole par', () => {
    const [r] = rowsFor({ closing: [{ item_id: 'rice', physical_qty: 0 }], pars: [{ item_id: 'rice', par_qty: 5 }] })
    expect(r.needsReorder).toBe(true)
    expect(r.shortfall).toBe(5)
  })

  test('summarizeReorder counts flagged rows and sums their value', () => {
    const rows = buildStockRows({
      items: [item('rice'), item('dal', 20), item('salt')],
      opening: [{ item_id: 'rice', qty: 1 }, { item_id: 'dal', qty: 1 }, { item_id: 'salt', qty: 9 }],
      pars: [{ item_id: 'rice', par_qty: 3 }, { item_id: 'dal', par_qty: 2 }, { item_id: 'salt', par_qty: 9 }],
      breakdown: {},
    })
    expect(summarizeReorder(rows)).toEqual({ count: 2, estValueTotal: 2 * 10 + 1 * 20 })
  })
})

describe('Stock Report usage goes through the shared depletion rule', () => {
  test('a day sold in both POS and manual entry consumes its ingredients once', () => {
    const usage = buildUsageMap([
      { recipe_id: 'dish', qty_sold: 10, bs_day: 3, source: 'pos' },
      { recipe_id: 'dish', qty_sold: 10, bs_day: 3, source: 'manual' },
    ], dish)
    expect(usage.rice).toBeCloseTo(2)
  })

  test('a credit note reverses revenue, not stock', () => {
    const usage = buildUsageMap([
      { recipe_id: 'dish', qty_sold: 10, bs_day: 3, source: 'pos' },
      { recipe_id: 'dish', qty_sold: -4, bs_day: 3, source: 'pos_credit' },
    ], dish)
    expect(usage.rice).toBeCloseTo(2)
  })

  // S809 2e (CREDIT-NOTES-1, Q10 a): a bill credited because it is billed again (or was a duplicate)
  // says its food was not served on it, so the re-rung bill's plates are not counted twice.
  test('a credit note whose food was not served puts its plates back', () => {
    const usage = buildUsageMap([
      { recipe_id: 'dish', qty_sold: 2, bs_day: 3, source: 'pos' },                  // the wrong bill
      { recipe_id: 'dish', qty_sold: -2, bs_day: 3, source: 'pos_credit_restock' },  // its credit note
      { recipe_id: 'dish', qty_sold: 2, bs_day: 3, source: 'pos' },                  // rung again, right
    ], dish)
    expect(usage.rice).toBeCloseTo(0.4)   // 2 plates × 0.2, not 4
  })

  test('legacy rows with a NULL source still count as manual', () => {
    const usage = buildUsageMap([{ recipe_id: 'dish', qty_sold: 5, bs_day: 2, source: null }], dish)
    expect(usage.rice).toBeCloseTo(1)
  })
})

// S835 (owner decision): a dish's choice extras follow the dish. Its recipe part is skipped when the
// month's net sold is 0 or less, and its extras now are too, instead of being added row by row.
describe('choice extras follow their dish', () => {
  const cheese = [{ item_id: 'cheese', qty: 0.03 }]

  test('a dish that sold: each plate adds its extras', () => {
    const usage = buildUsageMap([
      { recipe_id: 'dish', qty_sold: 3, bs_day: 3, source: 'pos', ingredient_deltas: cheese },
    ], dish)
    expect(usage.rice).toBeCloseTo(0.6)
    expect(usage.cheese).toBeCloseTo(0.09)
  })

  test('a month netted to zero by a restock credit: no base and no extras', () => {
    const usage = buildUsageMap([
      { recipe_id: 'dish', qty_sold: 2, bs_day: 3, source: 'pos', ingredient_deltas: cheese },
      { recipe_id: 'dish', qty_sold: -2, bs_day: 3, source: 'pos_credit_restock', ingredient_deltas: cheese },
    ], dish)
    expect(usage.rice).toBeUndefined()
    expect(usage.cheese).toBeUndefined()
  })

  test('a month netted below zero: the extras on the sold rows are not added', () => {
    const usage = buildUsageMap([
      { recipe_id: 'dish', qty_sold: 1, bs_day: 3, source: 'pos', ingredient_deltas: cheese },
      { recipe_id: 'dish', qty_sold: -3, bs_day: 4, source: 'pos_credit_restock' },
    ], dish)
    expect(usage.rice).toBeUndefined()
    expect(usage.cheese).toBeUndefined()
  })

  test('another dish that sold keeps its own extras', () => {
    const usage = buildUsageMap([
      { recipe_id: 'dish', qty_sold: 1, bs_day: 3, source: 'pos', ingredient_deltas: cheese },
      { recipe_id: 'dish', qty_sold: -1, bs_day: 3, source: 'pos_credit_restock', ingredient_deltas: cheese },
      { recipe_id: 'bowl', qty_sold: 2, bs_day: 3, source: 'pos', ingredient_deltas: cheese },
    ], { ...dish, bowl: [] })
    expect(usage.rice).toBeUndefined()
    expect(usage.cheese).toBeCloseTo(0.06)
  })

  test('a "no onion" extra on a dish that sold still takes onion off, unclamped', () => {
    const usage = buildUsageMap([
      { recipe_id: 'dish', qty_sold: 2, bs_day: 3, source: 'pos', ingredient_deltas: [{ item_id: 'onion', qty: -0.05 }] },
    ], dish)
    expect(usage.onion).toBeCloseTo(-0.1)
  })
})
