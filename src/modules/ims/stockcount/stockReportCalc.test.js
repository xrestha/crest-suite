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

  test('legacy rows with a NULL source still count as manual', () => {
    const usage = buildUsageMap([{ recipe_id: 'dish', qty_sold: 5, bs_day: 2, source: null }], dish)
    expect(usage.rice).toBeCloseTo(1)
  })
})
