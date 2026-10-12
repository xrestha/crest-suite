// S809 4e (IMS-HANDOFF-6, owner decision D5): Stock Movements nets every row by its sign, as Book Stock
// does, and names a sale that ADDED stock instead of counting it as a depletion.
import { movementFigures } from './stockMovementRows'

describe('movementFigures', () => {
  test('an ordinary sale (−20) is 20 out, valued positive, not an addition', () => {
    expect(movementFigures({ qty: -20, source: 'pos_sale' }, 5)).toEqual({ qtyOut: 20, value: 100, addsStock: false, unexpectedAdd: false })
  })

  test('a sale that added stock (+20) is −20 out, takes its value OFF the total, and is flagged', () => {
    expect(movementFigures({ qty: 20, source: 'pos_sale' }, 5)).toEqual({ qtyOut: -20, value: -100, addsStock: true, unexpectedAdd: true })
    // A comp and a manual Sales Entry row can carry the same shape.
    expect(movementFigures({ qty: '3.5', source: 'pos_comp' }, '2').unexpectedAdd).toBe(true)
    expect(movementFigures({ qty: 1, source: 'manual' }, 2).unexpectedAdd).toBe(true)
  })

  test('a Credit Note put-back (+5) adds stock as it should: netted off, not flagged', () => {
    expect(movementFigures({ qty: 5, source: 'pos_credit_restock' }, 10)).toEqual({ qtyOut: -5, value: -50, addsStock: true, unexpectedAdd: false })
  })

  test('an unparsable qty or rate is 0, never NaN, and is no addition', () => {
    expect(movementFigures({ qty: 'abc', source: 'pos_sale' }, 5)).toEqual({ qtyOut: 0, value: 0, addsStock: false, unexpectedAdd: false })
    expect(movementFigures({ qty: null, source: 'pos_sale' }, 5).qtyOut).toBe(0)
    expect(Object.is(movementFigures({ qty: 0 }, 5).qtyOut, -0)).toBe(false)
    expect(movementFigures({ qty: -2, source: 'pos_sale' }, undefined)).toEqual({ qtyOut: 2, value: 0, addsStock: false, unexpectedAdd: false })
  })

  test('the rows sum to a net figure, as Book Stock nets them', () => {
    const rows = [
      { qty: -20, source: 'pos_sale' },
      { qty: 20, source: 'pos_sale' },
      { qty: 5, source: 'pos_credit_restock' },
    ]
    expect(rows.reduce((s, m) => s + movementFigures(m, 1).value, 0)).toBe(-5)
  })
})
