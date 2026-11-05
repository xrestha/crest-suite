import { compareItemPrices } from './groupItemPriceMath'

const row = (item_key, client_id, client_name, qty, net_value, extra = {}) => ({
  item_key, client_id, client_name, item_name: 'Flour', uom: 'GM', qty, net_value, lines: 1, ...extra,
})

describe('compareItemPrices', () => {
  test('prices each outlet per unit and charges the gap over the lowest price on its own quantity', () => {
    const { items, totalExtra, comparable } = compareItemPrices([
      row('k1', 'a', 'Bloom', 1000, 100),          // 0.10 / GM
      row('k1', 'b', 'Bloom PKR', 500, 54),        // 0.108 / GM
    ])
    expect(comparable).toBe(1)
    const [it] = items
    expect(it.minRate).toBeCloseTo(0.1)
    expect(it.maxRate).toBeCloseTo(0.108)
    expect(it.spreadPct).toBeCloseTo(8)
    expect(it.extra).toBeCloseTo(4)                 // (0.108 − 0.10) × 500
    expect(totalExtra).toBeCloseTo(4)
    expect(it.outlets.find(o => o.clientId === 'a').cheapest).toBe(true)
    expect(it.outlets.find(o => o.clientId === 'b').cheapest).toBe(false)
  })

  test('the same price everywhere marks no outlet cheapest and costs nothing extra', () => {
    const { items } = compareItemPrices([row('k1', 'a', 'A', 10, 100), row('k1', 'b', 'B', 20, 200)])
    expect(items[0].extra).toBe(0)
    expect(items[0].outlets.some(o => o.cheapest)).toBe(false)
  })

  test('units that differ are listed last and never compared', () => {
    const { items, comparable, totalExtra } = compareItemPrices([
      row('sugar', 'a', 'A', 2, 200, { uom: 'KG', item_name: 'Sugar' }),
      row('sugar', 'b', 'B', 1000, 100, { uom: 'GM', item_name: 'Sugar' }),
      row('k1', 'a', 'A', 10, 100),
      row('k1', 'b', 'B', 10, 120),
    ])
    expect(comparable).toBe(1)
    expect(items.map(i => i.key)).toEqual(['k1', 'sugar'])
    expect(items[1].unitsDiffer).toBe(true)
    expect(items[1].extra).toBeNull()
    expect(totalExtra).toBeCloseTo(20)
  })

  test('a zero-value line is not a price, so it can never be the cheapest', () => {
    const { items } = compareItemPrices([row('k1', 'a', 'A', 10, 0), row('k1', 'b', 'B', 10, 120)])
    expect(items).toEqual([])
  })

  test('ranks by what was paid above the lowest price, and keeps the other outlet names', () => {
    const { items } = compareItemPrices([
      row('small', 'a', 'A', 10, 100), row('small', 'b', 'B', 10, 110),            // extra 10
      row('big', 'a', 'A', 100, 1000, { item_name: 'Rice' }),
      row('big', 'b', 'B', 100, 1500, { item_name: 'Basmati rice' }),             // extra 500
    ])
    expect(items.map(i => i.key)).toEqual(['big', 'small'])
    expect(items[0].name).toBe('Rice')
    expect(items[0].otherNames).toEqual(['Basmati rice'])
  })

  test('an empty or missing result is an empty comparison', () => {
    expect(compareItemPrices(null)).toEqual({ items: [], comparable: 0, totalExtra: 0 })
  })
})
