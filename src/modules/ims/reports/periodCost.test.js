// periodCost.js is the revenue and COGS arithmetic Monthly Summary and Consolidated P&L share
// (S774). Every expected figure below is worked by hand from the fixture, so a change to either
// convention fails here before it reaches the two pages.
import { computeUsed } from '../../../shared/imsFormulas'
import { periodRevenue, periodStockMaps, valuePeriodItems } from './periodCost'

describe('periodRevenue', () => {
  const recipes = [
    { id: 'r1', selling_price: '100' },
    { id: 'r2', selling_price: '50' },
  ]

  it('prices each row at sale, falls back to the current price, and nets its discount', () => {
    const rows = [
      // price at sale (120) wins over today's menu price (100): 2 × 120 − 10
      { recipe_id: 'r1', qty_sold: 2, unit_price: '120', discount: '10', source: 'manual' },
      // a row from before unit_price existed takes the current price, and a NULL source is kept
      { recipe_id: 'r2', qty_sold: 1, unit_price: null, discount: null, source: null },
    ]
    expect(periodRevenue(rows, recipes)).toBe(280)
  })

  it('excludes comps', () => {
    const rows = [{ recipe_id: 'r1', qty_sold: 3, unit_price: '100', discount: 0, source: 'pos_comp' }]
    expect(periodRevenue(rows, recipes)).toBe(0)
  })

  it('keeps a price of zero at sale rather than replacing it with the menu price', () => {
    const rows = [{ recipe_id: 'r1', qty_sold: 1, unit_price: '0', discount: 0, source: 'pos' }]
    expect(periodRevenue(rows, recipes)).toBe(0)
  })

  it('reads a legacy row whose recipe is gone as zero', () => {
    const rows = [{ recipe_id: 'gone', qty_sold: 1, unit_price: null, discount: 0, source: 'manual' }]
    expect(periodRevenue(rows, recipes)).toBe(0)
  })

  it('returns zero for no rows', () => {
    expect(periodRevenue(null, null)).toBe(0)
  })
})

describe('periodStockMaps and valuePeriodItems', () => {
  // A and B are in the valued set; C stands for an inactive or sub-recipe item the caller's read
  // excluded, and sits on the same bill so its share of the discount must not leak in.
  const A = { id: 'A', per_uom_rate: '10' }
  const B = { id: 'B', per_uom_rate: '5' }
  const bill = { purchase_group_id: 'g1', discount_amount: '30', vendor_id: 'v1', invoice_ref: '7', bs_day: 3 }
  const maps = periodStockMaps({
    opening: [{ item_id: 'A', qty: '4' }, { item_id: 'B', qty: '2' }, { item_id: 'C', qty: '1' }],
    closing: [{ item_id: 'A', physical_qty: '3' }, { item_id: 'B', physical_qty: '4' }, { item_id: 'C', physical_qty: '1' }],
    // one 300 bill with a 30 discount: each 100 line carries 10 of it
    purchases: [
      { ...bill, item_id: 'A', qty: '10', rate: '10' },
      { ...bill, item_id: 'B', qty: '20', rate: '5' },
      { ...bill, item_id: 'C', qty: '1', rate: '100' },
    ],
    returns: [{ item_id: 'A', qty: '1', rate: '10' }],
    // two wastage rows for one item sum
    wastages: [{ item_id: 'A', qty: '0.5' }, { item_id: 'A', qty: '0.5' }],
    staffMeals: [{ item_id: 'B', qty: '2' }],
  })

  it('values the listed items, with the bill discount credited only for their lines', () => {
    const v = valuePeriodItems([A, B], maps)
    expect(v.openingVal).toBeCloseTo(50)       // 4 × 10 + 2 × 5
    expect(v.purchaseVal).toBeCloseTo(200)     // gross, before the discount
    expect(v.discountVal).toBeCloseTo(20)      // A's 10 + B's 10, not the bill's 30
    expect(v.returnVal).toBeCloseTo(10)        // 1 × 10
    expect(v.netPurchaseVal).toBeCloseTo(170)  // 200 − 20 − 10
    expect(v.wastageVal).toBeCloseTo(10)       // 1 × 10
    expect(v.staffMealsVal).toBeCloseTo(10)    // 2 × 5
    expect(v.closingVal).toBeCloseTo(50)       // 3 × 10 + 4 × 5
    expect(v.cogsVal).toBeCloseTo(150)         // 50 + 170 − 10 − 10 − 50
  })

  it('splits by category without losing anything: the per-category COGS sum to the total', () => {
    const a = valuePeriodItems([A], maps)
    const b = valuePeriodItems([B], maps)
    expect(a.cogsVal).toBeCloseTo(80)          // 40 + 80 − 10 − 0 − 30
    expect(b.cogsVal).toBeCloseTo(70)          // 10 + 90 − 0 − 10 − 20
    expect(a.cogsVal + b.cogsVal).toBeCloseTo(valuePeriodItems([A, B], maps).cogsVal)
  })

  it("gives the P&L's statement inputs the same COGS as Monthly Summary's columns", () => {
    // ConsolidatedPnl passes purchases net of discount and returns separately to computeUsed().
    const v = valuePeriodItems([A, B], maps)
    const pnlCogs = computeUsed({
      opening: v.openingVal, purchases: v.purchaseVal - v.discountVal, returns: v.returnVal,
      wastage: v.wastageVal, staffMeals: v.staffMealsVal, closing: v.closingVal,
    })
    expect(pnlCogs).toBeCloseTo(v.cogsVal)
  })

  it('exposes the per-item maps findUncountedItems reads', () => {
    expect(maps.opening.A).toBe(4)
    expect(maps.purchases.A.qty).toBe(10)
    expect(maps.purchases.A.gross).toBeCloseTo(100)
    expect(maps.purchases.A.value).toBeCloseTo(90)
  })

  it('returns zeros for an empty period', () => {
    const v = valuePeriodItems([A], periodStockMaps({}))
    expect(Object.values(v).every(x => x === 0)).toBe(true)
  })
})
