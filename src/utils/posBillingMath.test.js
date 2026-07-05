import { computeOrderAmounts, computeCategoryAmounts, computeItemAmounts } from './posBillingMath'

describe('computeOrderAmounts', () => {
  test('no discount, uniform VAT rate', () => {
    const order = { discount_amount: 0 }
    const items = [
      { qty: 2, unit_price: 100, vat_rate: 0.13 },
      { qty: 1, unit_price: 300, vat_rate: 0.13 },
    ]
    expect(computeOrderAmounts(order, items, true)).toEqual({
      grossAmt: 500, discount: 0, taxableBase: 500, nonTaxableBase: 0,
      vatAmt: 65, net: 565, roundOff: 0, totalQty: 3,
    })
  })

  test('a discount proportionally reduces the VAT base too, not just the gross', () => {
    const order = { discount_amount: 100 }
    const items = [{ qty: 1, unit_price: 1000, vat_rate: 0.13 }]
    expect(computeOrderAmounts(order, items, true)).toEqual({
      grossAmt: 1000, discount: 100, taxableBase: 900, nonTaxableBase: 0,
      vatAmt: 117, net: 1017, roundOff: 0, totalQty: 1,
    })
  })

  test('net is rounded to the nearest rupee and roundOff captures the remainder', () => {
    const order = { discount_amount: 0 }
    const items = [{ qty: 3, unit_price: 33.33, vat_rate: 0.13 }]
    const result = computeOrderAmounts(order, items, true)
    expect(result.net).toBe(113)
    expect(result.roundOff).toBeCloseTo(113 - (99.99 + 99.99 * 0.13), 4)
  })

  test('non-VAT-registered orders charge no VAT and the whole amount is non-taxable', () => {
    const order = { discount_amount: 0 }
    const items = [{ qty: 2, unit_price: 250, vat_rate: 0.13 }]
    expect(computeOrderAmounts(order, items, false)).toEqual({
      grossAmt: 500, discount: 0, taxableBase: 0, nonTaxableBase: 500,
      vatAmt: 0, net: 500, roundOff: 0, totalQty: 2,
    })
  })
})

describe('computeCategoryAmounts reconciles to computeOrderAmounts', () => {
  test('category subtotals sum to the same order-level totals', () => {
    const order = { discount_amount: 50 }
    const items = [
      { qty: 2, unit_price: 100, vat_rate: 0.13, category: 'Food' },
      { qty: 1, unit_price: 300, vat_rate: 0.13, category: 'Drinks' },
      { qty: 4, unit_price: 25, vat_rate: 0, category: 'Food' },
    ]
    const orderTotals = computeOrderAmounts(order, items, true)
    const byCat = computeCategoryAmounts(order, items, true)
    const sums = Object.values(byCat).reduce((s, c) => ({
      gross: s.gross + c.gross,
      discount: s.discount + c.discount,
      vat: s.vat + c.vat,
      taxable: s.taxable + c.taxable,
      nonTaxable: s.nonTaxable + c.nonTaxable,
    }), { gross: 0, discount: 0, vat: 0, taxable: 0, nonTaxable: 0 })

    expect(sums.gross).toBeCloseTo(orderTotals.grossAmt, 6)
    expect(sums.discount).toBeCloseTo(orderTotals.discount, 6)
    expect(sums.vat).toBeCloseTo(orderTotals.vatAmt, 6)
    expect(sums.taxable).toBeCloseTo(orderTotals.taxableBase, 6)
    expect(sums.nonTaxable).toBeCloseTo(orderTotals.nonTaxableBase, 6)
  })
})

describe('computeItemAmounts reconciles to computeOrderAmounts', () => {
  test('per-item subtotals sum to the same order-level totals', () => {
    const order = { discount_amount: 50 }
    const items = [
      { recipe_id: 'r1', name: 'Momo', qty: 2, unit_price: 100, vat_rate: 0.13 },
      { recipe_id: 'r2', name: 'Coke', qty: 1, unit_price: 300, vat_rate: 0.13 },
    ]
    const orderTotals = computeOrderAmounts(order, items, true)
    const byItem = computeItemAmounts(order, items, true)
    const sums = Object.values(byItem).reduce((s, i) => ({
      gross: s.gross + i.gross,
      discount: s.discount + i.discount,
      vat: s.vat + i.vat,
    }), { gross: 0, discount: 0, vat: 0 })

    expect(sums.gross).toBeCloseTo(orderTotals.grossAmt, 6)
    expect(sums.discount).toBeCloseTo(orderTotals.discount, 6)
    expect(sums.vat).toBeCloseTo(orderTotals.vatAmt, 6)
  })
})
