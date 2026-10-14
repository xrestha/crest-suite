import { computeOrderAmounts, computeCategoryAmounts, computeItemAmounts, computeGroupAmounts, billVatRegistered } from './posBillingMath'

// S809 2c (CHECKOUT-6 / REPORTS-1): a bill keeps the tax status its close stamped on it.
describe('billVatRegistered', () => {
  test('a stamped bill answers for itself, whatever today\'s setting says', () => {
    expect(billVatRegistered({ vat_registered: true }, false)).toBe(true)
    expect(billVatRegistered({ vat_registered: false }, true)).toBe(false)
  })

  test('no stamp (an open order, a bill restored from before 2c, a select without the column) falls back to today\'s setting', () => {
    expect(billVatRegistered({ vat_registered: null }, true)).toBe(true)
    expect(billVatRegistered({ vat_registered: null }, false)).toBe(false)
    expect(billVatRegistered({}, false)).toBe(false)
    expect(billVatRegistered(null, true)).toBe(true)
    expect(billVatRegistered(undefined, false)).toBe(false)
  })

  test('TI880 (1,000 + 130 VAT) reprinted after the outlet switched VAT off still totals 1,130', () => {
    const bill = { discount_amount: 0, vat_registered: true }
    const items = [{ qty: 1, unit_price: 1000, vat_rate: 0.13 }]
    expect(computeOrderAmounts(bill, items, billVatRegistered(bill, false)).net).toBe(1130)
    // What the reprint used to print, from today's setting alone:
    expect(computeOrderAmounts(bill, items, false).net).toBe(1000)
  })
})

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

// computeGroupAmounts is the primitive the two above delegate to, so the Product Type tab's own
// axes (Kitchen/Bar, VAT mode, Veg) inherit the discount allocation rather than re-deriving it.
// The invariant that matters is the same one: whatever the key, the buckets must sum back to the
// order total, or a tab silently disagrees with the bill it came from.
describe('computeGroupAmounts with an arbitrary key', () => {
  const order = { discount_amount: 120 }
  const items = [
    { recipe_id: 'r1', name: 'Momo',  category: 'Food',     qty: 2, unit_price: 300, vat_rate: 0.13 },
    { recipe_id: 'r2', name: 'Beer',  category: 'Beverage', qty: 3, unit_price: 400, vat_rate: 0.13 },
    { recipe_id: 'r3', name: 'Water', category: 'Beverage', qty: 1, unit_price: 50,  vat_rate: 0 },
  ]
  const bar = new Set(['Beverage'])
  const stationOf = i => (bar.has(i.category || 'Other') ? 'Bar (BOT)' : 'Kitchen (KOT)')

  test('station subtotals sum to the same order-level totals', () => {
    const byStation = computeGroupAmounts(order, items, true, stationOf)
    const totals = computeOrderAmounts(order, items, true)
    const sum = f => Object.values(byStation).reduce((s, v) => s + v[f], 0)

    expect(Object.keys(byStation).sort()).toEqual(['Bar (BOT)', 'Kitchen (KOT)'])
    expect(sum('gross')).toBeCloseTo(totals.grossAmt, 6)
    expect(sum('discount')).toBeCloseTo(totals.discount, 6)
    expect(sum('vat')).toBeCloseTo(totals.vatAmt, 6)
    expect(sum('taxable')).toBeCloseTo(totals.taxableBase, 6)
    expect(sum('nonTaxable')).toBeCloseTo(totals.nonTaxableBase, 6)
    expect(sum('qty')).toBe(totals.totalQty)
  })

  test('a zero-rated line lands in nonTaxable, so a VAT-mode split cannot double-count it', () => {
    const byVat = computeGroupAmounts(order, items, true, i => ((i.vat_rate ?? 0) > 0 ? 'Taxable' : 'Non-Taxable'))
    expect(byVat['Taxable'].nonTaxable).toBe(0)
    expect(byVat['Non-Taxable'].taxable).toBe(0)
    expect(byVat['Non-Taxable'].vat).toBe(0)
  })

  test('seedOf stamps extra fields on a bucket the first time it is created', () => {
    const byItem = computeGroupAmounts(order, items, true, i => i.recipe_id, i => ({ name: i.name }))
    expect(byItem['r1'].name).toBe('Momo')
    expect(byItem['r3'].name).toBe('Water')
  })
})

// S839 (docs/pos-combos.md): a bill discount never touches a combo's dishes.
describe('a bill discount skips combo dishes', () => {
  const { discountableSubtotal, lineDiscountRatio, isComboItem } = require('./posBillingMath')
  const plain = { recipe_id: 'r1', qty: 1, unit_price: 100, vat_rate: 0.13 }
  const comboMomo = { recipe_id: 'r2', qty: 1, unit_price: 206.49, vat_rate: 0.13, combo_line_id: 'c1', selection_key: '@c1/g1' }
  const comboCoke = { recipe_id: 'r3', qty: 1, unit_price: 103.25, vat_rate: 0.13, selection_key: '@c1/g2' }  // key only

  test('a combo dish is known by its tag or by its key', () => {
    expect(isComboItem(comboMomo)).toBe(true)
    expect(isComboItem(comboCoke)).toBe(true)
    expect(isComboItem(plain)).toBe(false)
    expect(isComboItem({ selection_key: 'opt1+opt2' })).toBe(false)
  })

  test('the discountable subtotal leaves the combo out', () => {
    expect(discountableSubtotal([plain, comboMomo, comboCoke])).toBe(100)
    const ratioOf = lineDiscountRatio({ discount_amount: 10 }, [plain, comboMomo, comboCoke])
    expect(ratioOf(plain)).toBeCloseTo(0.1, 10)
    expect(ratioOf(comboMomo)).toBe(0)
  })

  test('VAT and the bases follow each line: the combo is taxed in full', () => {
    const a = computeOrderAmounts({ discount_amount: 10 }, [plain, comboMomo, comboCoke], true)
    expect(a.grossAmt).toBeCloseTo(409.74, 6)
    expect(a.taxableBase).toBeCloseTo(90 + 206.49 + 103.25, 6)
    expect(a.vatAmt).toBeCloseTo((90 + 206.49 + 103.25) * 0.13, 6)
    expect(a.net).toBe(Math.round(409.74 - 10 + (90 + 206.49 + 103.25) * 0.13))
    expect(a.taxableBase + a.nonTaxableBase).toBeCloseTo(a.grossAmt - a.discount, 6)
  })

  test('grouped amounts reconcile to the bill with a combo on it', () => {
    const items = [plain, comboMomo, comboCoke]
    const order = { discount_amount: 10 }
    const groups = Object.values(computeGroupAmounts(order, items, true, i => i.recipe_id))
    const bill = computeOrderAmounts(order, items, true)
    expect(groups.reduce((s, g) => s + g.discount, 0)).toBeCloseTo(10, 6)
    expect(groups.reduce((s, g) => s + g.vat, 0)).toBeCloseTo(bill.vatAmt, 6)
    expect(groups.find(g => g.gross === 206.49).discount).toBe(0)
  })

  test('a bill with no combo computes exactly as before', () => {
    const items = [plain, { ...plain, recipe_id: 'r9', unit_price: 50, vat_rate: 0 }]
    const a = computeOrderAmounts({ discount_amount: 15 }, items, true)
    const discRatio = 15 / 150
    expect(a.vatAmt).toBe(100 * 0.13 * (1 - discRatio))
    expect(a.taxableBase).toBe(100 * (1 - discRatio))
  })
})

describe('Total Qty counts a combo once', () => {
  test('a two-dish combo at qty 2 counts 2, beside a plain line', () => {
    const items = [
      { qty: 1, unit_price: 100, vat_rate: 0.13 },
      { qty: 2, unit_price: 200, vat_rate: 0.13, combo_line_id: 'c1', combo_group_id: 'g1', selection_key: '@c1/g1' },
      { qty: 2, unit_price: 100, vat_rate: 0.13, combo_line_id: 'c1', combo_group_id: 'g2', selection_key: '@c1/g2' },
    ]
    expect(computeOrderAmounts({ discount_amount: 0 }, items, true).totalQty).toBe(3)
  })
})
