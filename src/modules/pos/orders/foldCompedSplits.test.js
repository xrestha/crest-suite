// S809 2b (CHECKOUT-10). A comp left on an OPEN order by a close that failed and was cancelled
// reloaded as a second plain line of the same dish, and "comp 1" then comped more than was chosen.
// foldCompedSplits puts such a row back into its line before the cart is built.
import { foldCompedSplits, cartLineFromStored, lineKeyOf, OPEN_ORDER_SELECT } from './posOrdersConstants'

const MOMO = 'r-momo'
const COKE = 'r-coke'
const row = (over) => ({
  id: Math.random().toString(36).slice(2), recipe_id: MOMO, name: 'Veg Momo', category: 'Food',
  qty: 1, unit_price: 250, vat_rate: 0.13, sent_to_kot: false, sent_qty: 0, notes: null,
  selection_key: '', comped: false, ...over,
})

describe('foldCompedSplits', () => {
  test('the open-order read carries the comped flag the fold needs', () => {
    expect(OPEN_ORDER_SELECT).toMatch(/pos_order_items\([^)]*\bcomped\b/)
  })

  test('an order with no comp keeps every line as it was, without the comped flag', () => {
    const rows = [row({ qty: 2 }), row({ recipe_id: COKE, name: 'Coke', qty: 1 })]
    expect(foldCompedSplits(rows)).toEqual(rows.map(({ comped, ...r }) => r))
    expect(foldCompedSplits(null)).toEqual([])
    expect(foldCompedSplits(undefined)).toEqual([])
  })

  test('3 momo with 1 comped (sent) come back as one line of 3, all sent', () => {
    // apply_pos_item_comps on a sent line of 3, comp 1: charged row qty 2 / sent 2, comp row qty 1 / sent 1
    const rows = [
      row({ qty: 2, sent_to_kot: true, sent_qty: 2 }),
      row({ qty: 1, sent_to_kot: true, sent_qty: 1, comped: true }),
    ]
    const lines = foldCompedSplits(rows).map(cartLineFromStored)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ recipe_id: MOMO, qty: 3, sent_to_kot: true, sent_qty: 3 })
    expect(lines[0]).not.toHaveProperty('comped')
  })

  test('a part-sent line keeps its kitchen count: 2 of 3 sent, the comp took 1 sent unit', () => {
    const rows = [
      row({ qty: 2, sent_to_kot: false, sent_qty: 1 }),
      row({ qty: 1, sent_to_kot: false, sent_qty: 1, comped: true }),
    ]
    const [line] = foldCompedSplits(rows).map(cartLineFromStored)
    expect(line).toMatchObject({ qty: 3, sent_to_kot: false, sent_qty: 2 })
  })

  test('a whole-line comp with no charged row left comes back as that line, uncomped', () => {
    const rows = [row({ qty: 2 }), row({ recipe_id: COKE, name: 'Coke', qty: 1, comped: true, sent_to_kot: true })]
    const lines = foldCompedSplits(rows)
    expect(lines).toHaveLength(2)
    const coke = lines.find(l => l.recipe_id === COKE)
    expect(coke).toMatchObject({ qty: 1, sent_to_kot: true })
    expect(coke).not.toHaveProperty('comped')
  })

  test('a comp folds only into its own line: two customizations of one dish stay apart', () => {
    const rows = [
      row({ qty: 1, selection_key: 'a' }),
      row({ qty: 2, selection_key: 'b' }),
      row({ qty: 1, selection_key: 'b', comped: true }),
    ]
    const lines = foldCompedSplits(rows)
    expect(lines.map(l => [lineKeyOf(l), l.qty])).toEqual([[`${MOMO}#a`, 1], [`${MOMO}#b`, 3]])
  })

  test('the stored rows are not mutated', () => {
    const charged = row({ qty: 2 })
    const comp = row({ qty: 1, comped: true })
    foldCompedSplits([charged, comp])
    expect(charged.qty).toBe(2)
    expect(comp.comped).toBe(true)
  })
})
