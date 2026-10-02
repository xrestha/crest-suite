import { priceMovers } from './priceMovers'

const items = { chk: { name: 'Chicken', uom: 'kg' }, jeera: { name: 'Jeera', uom: 'g' }, rice: { name: 'Rice', uom: 'kg' } }

test('ranks by rupee impact this month, not by percentage', () => {
  const now = [
    { item_id: 'chk', qty: 100, rate: 530 },  // +6% on 100 kg = +3,000
    { item_id: 'jeera', qty: 50, rate: 1.4 }, // +40% on 50 g = +20
  ]
  const before = [{ item_id: 'chk', qty: 80, rate: 500 }, { item_id: 'jeera', qty: 50, rate: 1 }]
  const rows = priceMovers(now, before, items)
  expect(rows.map(r => r.name)).toEqual(['Chicken', 'Jeera'])
  expect(Math.round(rows[0].impact)).toBe(3000)
  expect(Math.round(rows[0].changePct)).toBe(6)
})

test('averages several bills by quantity, and a fall is a negative impact', () => {
  const now = [{ item_id: 'rice', qty: 10, rate: 90 }, { item_id: 'rice', qty: 30, rate: 110 }] // avg 105
  const before = [{ item_id: 'rice', qty: 40, rate: 120 }]
  const [r] = priceMovers(now, before, items)
  expect(r.rateNow).toBe(105)
  expect(r.impact).toBe(-600)
})

test('an item bought in only one of the two months is not a mover', () => {
  expect(priceMovers([{ item_id: 'chk', qty: 5, rate: 500 }], [], items)).toEqual([])
  expect(priceMovers([], [{ item_id: 'chk', qty: 5, rate: 500 }], items)).toEqual([])
})
