import { buildTopVariance, topVarianceRows, isTopVarianceView, TOP_VARIANCE_VERSION } from './homeTopVariance'

// S852 (the 2026-10-20 audit's P0): the card read a missing closing count as a count of 0, so
// every item bought and not yet used by recipe sales was "Over-used" with a "Value at Risk".
const SETTINGS = { variance_flag_pct: 10 }

const item = (id, rate = 100, uom = 'kg') => ({ id, name: `Item ${id}`, uom, per_uom_rate: rate })
// One dish, recipe r1: 1 kg of A and 1 kg of D per plate.
const BREAKDOWN = { r1: [{ item_id: 'A', qty: 1 }, { item_id: 'D', qty: 1 }, { item_id: 'B', qty: 1 }] }
const SALES = [{ recipe_id: 'r1', qty_sold: 10, bs_day: 3, source: 'manual' }]

function view(over = {}) {
  return buildTopVariance({
    items: [item('A'), item('B'), item('C'), item('D')],
    opening: [{ item_id: 'A', qty: 5 }, { item_id: 'B', qty: 20 }, { item_id: 'C', qty: 4 }, { item_id: 'D', qty: 5 }],
    purchases: [{ item_id: 'A', qty: 30 }, { item_id: 'B', qty: 30 }, { item_id: 'C', qty: 10 }, { item_id: 'D', qty: 10 }],
    returns: [], wastages: [], staffMeals: [], transfers: [],
    // A counted: 5 + 30 − 5 = 30 used against 10 expected → Over. D counted: 5 + 10 − 4.5 = 10.5
    // against 10 → within ±10%. B is NOT counted. C is in no recipe.
    closing: [{ item_id: 'A', physical_qty: 5 }, { item_id: 'C', physical_qty: 1 }, { item_id: 'D', physical_qty: 4.5 }],
    sales: SALES, breakdown: BREAKDOWN,
    ...over,
  })
}

describe('buildTopVariance', () => {
  test('an item with no closing count is never a candidate, however much stock it had', () => {
    const v = view()
    expect(v.candidates.map(r => r.itemId)).not.toContain('B')
    expect(v.uncounted).toBe(1)
    expect(v.countedItems).toBe(3)
  })

  test('an item in no recipe is not judged (D17), and a counted recipe item is', () => {
    const ids = view().candidates.map(r => r.itemId)
    expect(ids).not.toContain('C')
    expect(ids).toContain('A')
  })

  test('a month with no count at all has nothing to judge', () => {
    const v = view({ closing: [] })
    expect(v.countedItems).toBe(0)
    expect(v.candidates).toEqual([])
    expect(topVarianceRows(v, SETTINGS)).toEqual([])
  })

  test('a NULL physical_qty is not a count', () => {
    const v = view({ closing: [{ item_id: 'A', physical_qty: null }] })
    expect(v.countedItems).toBe(0)
    expect(v.candidates).toEqual([])
  })

  test('a count of 0 is a count', () => {
    const v = view({ closing: [{ item_id: 'B', physical_qty: 0 }] })
    expect(v.countedItems).toBe(1)
    // B: 20 + 30 − 0 = 50 used against 10 expected.
    expect(v.candidates.map(r => r.itemId)).toEqual(['B'])
  })

  test('wastage and staff meals come off actual use, as on the Variance page', () => {
    const v = view({ wastages: [{ item_id: 'A', qty: 15 }], staffMeals: [{ item_id: 'A', qty: 5 }] })
    const a = v.candidates.find(r => r.itemId === 'A')
    expect(a).toBeUndefined() // 30 − 15 − 5 = 10 used against 10 expected: nothing over
  })

  test('stock sent to another outlet is not over-use', () => {
    const v = view({ transfers: [{ item_id: 'A', qty: 20, direction: 'out' }] })
    expect(v.candidates.find(r => r.itemId === 'A')).toBeUndefined()
  })
})

describe('topVarianceRows: the verdict at the tolerance the client set', () => {
  test('only rows judged Over are shown, with the band that judged them', () => {
    const rows = topVarianceRows(view(), SETTINGS)
    expect(rows.map(r => r.itemId)).toEqual(['A'])
    expect(rows[0].band.flag).toBe('over')
    expect(rows[0].band.mark).toBe('▲')
    expect(rows[0].value).toBe(2000)
  })

  test('a tighter tolerance judges more rows Over', () => {
    // D: 0.5 kg over 10 (5%), NPR 50: under the NPR floor, so never Over.
    expect(topVarianceRows(view(), { variance_flag_pct: 2 }).map(r => r.itemId)).toEqual(['A'])
    const bigD = view({ items: [item('A'), item('B'), item('C'), item('D', 2000)] })
    expect(topVarianceRows(bigD, { variance_flag_pct: 2 }).map(r => r.itemId)).toEqual(['A', 'D'])
    expect(topVarianceRows(bigD, SETTINGS).map(r => r.itemId)).toEqual(['A'])
  })

  test('a pre-S852 cached array is not a view', () => {
    expect(isTopVarianceView([{ name: 'Rice', variance: 4, value: 400 }])).toBe(false)
    expect(topVarianceRows([{ name: 'Rice', variance: 4, value: 400 }], SETTINGS)).toEqual([])
    expect(isTopVarianceView({ v: TOP_VARIANCE_VERSION, candidates: [] })).toBe(true)
  })
})
