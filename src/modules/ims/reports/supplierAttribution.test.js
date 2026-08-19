import {
  allocateBillDiscounts, vendorNetByItem, vendorShares, attributeConsumption, vendorNetTotals,
  NO_VENDOR, UNATTRIBUTED,
} from './supplierAttribution'

// A bill's discount_amount is repeated on every one of its lines, so summing it is the obvious
// wrong answer — Vendor Report dedupes by purchase_group_id and this must agree with it.
describe('allocateBillDiscounts', () => {
  const bill = [
    { purchase_group_id: 'g1', item_id: 'i1', vendor_id: 'v1', qty: 10, rate: 30, discount_amount: 100 },
    { purchase_group_id: 'g1', item_id: 'i2', vendor_id: 'v1', qty: 10, rate: 20, discount_amount: 100 },
  ]

  test('the bill discount is counted once and split in proportion to line value', () => {
    const rows = allocateBillDiscounts(bill)
    expect(rows.map(r => r.lineGross)).toEqual([300, 200])
    expect(rows[0].lineNet).toBeCloseTo(300 - 60, 6) // 60% of the 100
    expect(rows[1].lineNet).toBeCloseTo(200 - 40, 6)
    expect(rows.reduce((s, r) => s + r.lineNet, 0)).toBeCloseTo(500 - 100, 6)
  })

  test('lines with no purchase_group_id fall back to vendor|invoice|day, as Vendor Report does', () => {
    const rows = allocateBillDiscounts([
      { item_id: 'i1', vendor_id: 'v1', invoice_ref: 'INV-9', bs_day: 4, qty: 1, rate: 100, discount_amount: 10 },
      { item_id: 'i2', vendor_id: 'v1', invoice_ref: 'INV-9', bs_day: 4, qty: 1, rate: 100, discount_amount: 10 },
    ])
    expect(rows.reduce((s, r) => s + r.lineNet, 0)).toBeCloseTo(190, 6) // one 10, not two
  })
})

describe('vendorNetByItem', () => {
  const purchases = [
    { purchase_group_id: 'g1', item_id: 'i1', vendor_id: 'v1', qty: 10, rate: 50, discount_amount: 0 },
    { purchase_group_id: 'g2', item_id: 'i1', vendor_id: 'v2', qty: 10, rate: 50, discount_amount: 0 },
    { purchase_group_id: 'g3', item_id: 'i2', vendor_id: null, qty: 5, rate: 20, discount_amount: 0 },
  ]
  const returns = [{ item_id: 'i1', vendor_id: 'v2', qty: 2, rate: 50 }]

  test('splits an item across the vendors that supplied it, net of returns', () => {
    const net = vendorNetByItem(purchases, returns)
    expect(net.i1.byVendor.v1).toBe(500)
    expect(net.i1.byVendor.v2).toBe(400) // 500 bought − 100 returned
    expect(net.i1.total).toBe(900)
  })

  test('a purchase with no vendor recorded is kept under its own key, not dropped', () => {
    const net = vendorNetByItem(purchases, returns)
    expect(net.i2.byVendor[NO_VENDOR]).toBe(100)
  })

  test('vendorNetTotals sums back to gross − discount − returns, i.e. Vendor Report net spend', () => {
    const totals = vendorNetTotals(vendorNetByItem(purchases, returns))
    expect(totals.v1).toBe(500)
    expect(totals.v2).toBe(400)
    expect(totals[NO_VENDOR]).toBe(100)
  })
})

describe('vendorShares', () => {
  test('shares come from the positive parts and sum to 1', () => {
    const shares = vendorShares({ v1: 750, v2: 250 })
    expect(shares.v1).toBeCloseTo(0.75, 6)
    expect(shares.v2).toBeCloseTo(0.25, 6)
  })

  test('an item that nets to zero or less has no meaningful split', () => {
    expect(vendorShares({ v1: 0 })).toBeNull()
    expect(vendorShares({ v1: 100, v2: -300 })).toEqual({ v1: 1 })
    expect(vendorShares(undefined)).toBeNull()
  })
})

describe('attributeConsumption', () => {
  const consumed = {
    i1: { value: 1000, byRecipe: { r1: 600, r2: 400 } },
    i2: { value: 200, byRecipe: { r1: 200 } },
  }

  test('an item is split across its suppliers in proportion to what was bought from each', () => {
    const net = vendorNetByItem([
      { purchase_group_id: 'g1', item_id: 'i1', vendor_id: 'v1', qty: 3, rate: 100, discount_amount: 0 },
      { purchase_group_id: 'g2', item_id: 'i1', vendor_id: 'v2', qty: 1, rate: 100, discount_amount: 0 },
      { purchase_group_id: 'g3', item_id: 'i2', vendor_id: 'v2', qty: 1, rate: 100, discount_amount: 0 },
    ], [])
    const out = attributeConsumption(consumed, net)

    expect(out.total).toBe(1200)
    expect(out.byVendor.v1.value).toBeCloseTo(750, 6)  // 75% of i1
    expect(out.byVendor.v2.value).toBeCloseTo(450, 6)  // 25% of i1 + all of i2
    expect(out.unattributed.value).toBe(0)
  })

  test('the menu items behind a supplier carry the same share as the ingredient', () => {
    const net = vendorNetByItem([
      { purchase_group_id: 'g1', item_id: 'i1', vendor_id: 'v1', qty: 1, rate: 100, discount_amount: 0 },
    ], [])
    const out = attributeConsumption({ i1: consumed.i1 }, net)
    expect(out.byVendor.v1.recipes.r1).toBeCloseTo(600, 6)
    expect(out.byVendor.v1.recipes.r2).toBeCloseTo(400, 6)
  })

  test('an item consumed but bought in no earlier-recorded purchase is named, not dropped', () => {
    const out = attributeConsumption(consumed, vendorNetByItem([
      { purchase_group_id: 'g1', item_id: 'i1', vendor_id: 'v1', qty: 1, rate: 100, discount_amount: 0 },
    ], []))
    expect(out.byVendor[UNATTRIBUTED].value).toBe(200) // i2, bought in an earlier period
    expect(out.unattributed.items.i2).toBe(200)
    // the invariant that matters: attributed + unattributed is the whole consumed value
    const sum = Object.values(out.byVendor).reduce((s, v) => s + v.value, 0)
    expect(sum).toBeCloseTo(out.total, 6)
  })

  test('attributed value always sums back to total consumed, however the shares fall', () => {
    const net = vendorNetByItem([
      { purchase_group_id: 'g1', item_id: 'i1', vendor_id: 'v1', qty: 7, rate: 13, discount_amount: 11 },
      { purchase_group_id: 'g2', item_id: 'i1', vendor_id: 'v2', qty: 3, rate: 29, discount_amount: 5 },
      { purchase_group_id: 'g3', item_id: 'i2', vendor_id: 'v3', qty: 2, rate: 7, discount_amount: 0 },
    ], [{ item_id: 'i1', vendor_id: 'v1', qty: 1, rate: 13 }])
    const out = attributeConsumption(consumed, net)
    const sum = Object.values(out.byVendor).reduce((s, v) => s + v.value, 0)
    expect(sum).toBeCloseTo(1200, 6)
  })
})
