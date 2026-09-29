import { issuingByItem, findShortfalls } from './requisitionShortfall'

describe('issuingByItem', () => {
  test('sums one item across every line it appears on, keeping first-seen order', () => {
    const m = issuingByItem([
      { item_id: 'flour', qty_issued: '5' },
      { item_id: 'oil', qty_issued: 2 },
      { item_id: 'flour', qty_issued: 5 },
    ])
    expect([...m.keys()]).toEqual(['flour', 'oil'])
    expect(m.get('flour')).toEqual({ issuing: 10, lines: 2 })
    expect(m.get('oil')).toEqual({ issuing: 2, lines: 1 })
  })

  test('a blank or unparseable quantity is 0, and a line with no item is skipped', () => {
    const m = issuingByItem([
      { item_id: 'flour', qty_issued: '' },
      { item_id: 'flour', qty_issued: 'abc' },
      { item_id: '', qty_issued: 9 },
      { qty_issued: 9 },
    ])
    expect(m.get('flour')).toEqual({ issuing: 0, lines: 2 })
    expect(m.size).toBe(1)
  })

  test('tolerates no lines at all', () => {
    expect(issuingByItem(undefined).size).toBe(0)
    expect(issuingByItem([]).size).toBe(0)
  })
})

describe('findShortfalls', () => {
  test('two lines of one item that each fit but together do not are a shortfall (SALES-7)', () => {
    const lines = [{ item_id: 'flour', qty_issued: 5 }, { item_id: 'flour', qty_issued: 5 }]
    expect(findShortfalls(lines, { flour: 7 })).toEqual([{ item_id: 'flour', issuing: 10, available: 7, lines: 2 }])
  })

  test('issuing exactly what is on hand is not a shortfall, even when the sum is a float', () => {
    const lines = [{ item_id: 'milk', qty_issued: 0.1 }, { item_id: 'milk', qty_issued: 0.2 }]
    expect(findShortfalls(lines, { milk: 0.3 })).toEqual([])
    expect(findShortfalls([{ item_id: 'flour', qty_issued: 7 }], { flour: 7 })).toEqual([])
  })

  test('an item with no on-hand figure has nothing on hand', () => {
    expect(findShortfalls([{ item_id: 'saffron', qty_issued: 1 }], {}))
      .toEqual([{ item_id: 'saffron', issuing: 1, available: 0, lines: 1 }])
  })

  test('only the items over their stock are listed, in slip order', () => {
    const lines = [
      { item_id: 'oil', qty_issued: 3 },
      { item_id: 'flour', qty_issued: 4 },
      { item_id: 'rice', qty_issued: 1 },
      { item_id: 'oil', qty_issued: 3 },
    ]
    const res = findShortfalls(lines, { oil: 5, flour: 10, rice: 0 })
    expect(res.map(r => r.item_id)).toEqual(['oil', 'rice'])
  })

  test('a negative on-hand estimate still compares as a number', () => {
    expect(findShortfalls([{ item_id: 'eggs', qty_issued: 1 }], { eggs: -2 }))
      .toEqual([{ item_id: 'eggs', issuing: 1, available: -2, lines: 1 }])
  })
})
