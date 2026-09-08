import { buildStockRows, buildUsageMap } from './stockReportCalc'

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

  test('low when at or under par, only when par is set', () => {
    const [low] = rowsFor({ opening: [{ item_id: 'rice', qty: 4 }], pars: [{ item_id: 'rice', par_qty: 5 }] })
    expect(low.status).toBe('low')
    const [ok] = rowsFor({ opening: [{ item_id: 'rice', qty: 4 }] })
    expect(ok.status).toBe('ok')
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

  test('legacy rows with a NULL source still count as manual', () => {
    const usage = buildUsageMap([{ recipe_id: 'dish', qty_sold: 5, bs_day: 2, source: null }], dish)
    expect(usage.rice).toBeCloseTo(1)
  })
})
