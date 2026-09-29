// periodCost.js is the revenue and COGS arithmetic Monthly Summary and Consolidated P&L share
// (S774). Every expected figure below is worked by hand from the fixture, so a change to either
// convention fails here before it reaches the two pages.
import { computeUsed } from '../../../shared/imsFormulas'
import {
  periodRevenue, periodStockMaps, valuePeriodItems,
  periodRowIds, periodValuationItems, periodGap, valuePeriods,
  periodWastageValue, wastageRowValue, WASTAGE_VALUE_SELECT,
} from './periodCost'

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

describe('the valued item set: hiding an item never changes a past month (S792, D29)', () => {
  // Rice was bought and used all month, then hidden in Item Master (its advice on a unit change).
  const A    = { id: 'A', name: 'Oil', per_uom_rate: '10', is_active: true }
  const RICE = { id: 'R', name: 'Rice (bag)', per_uom_rate: '20', is_active: false }
  const OLD  = { id: 'Z', name: 'Retired long ago', per_uom_rate: '5', is_active: false }
  // is_active is nullable (DEFAULT true, no NOT NULL): only an explicit false is hidden.
  const NULLISH = { id: 'N', name: 'Legacy row', per_uom_rate: '1', is_active: null }
  const rows = {
    opening:   [{ item_id: 'A', qty: '2' }, { item_id: 'R', qty: '5' }],
    closing:   [{ item_id: 'A', physical_qty: '1' }, { item_id: 'R', physical_qty: '3' }],
    purchases: [{ item_id: 'R', qty: '10', rate: '20', purchase_group_id: 'g1', discount_amount: '0' }],
    returns: [], wastages: [], staffMeals: [],
  }
  const maps = periodStockMaps(rows)

  it('names every item with a row of any kind', () => {
    const ids = periodRowIds({
      opening: [{ item_id: 'a' }], closing: [{ item_id: 'b', physical_qty: null }],
      purchases: [{ item_id: 'c' }], returns: [{ item_id: 'd' }],
      wastages: [{ item_id: 'e' }], staffMeals: [{ item_id: 'f' }, { item_id: null }],
    })
    expect([...ids].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(periodRowIds().size).toBe(0)
  })

  it('keeps active items and the hidden ones with a row, and drops a hidden item nothing happened to', () => {
    const valued = periodValuationItems([A, RICE, OLD, NULLISH], periodRowIds(rows))
    expect(valued.map(i => i.id)).toEqual(['A', 'R', 'N'])
  })

  it("keeps the hidden item's purchases and stock in the month's COGS", () => {
    const valued = periodValuationItems([A, RICE, OLD, NULLISH], periodRowIds(rows))
    const v = valuePeriodItems(valued, maps)
    // Oil: 2×10 − 1×10 = 10. Rice: 5×20 + 200 − 3×20 = 240.
    expect(v.purchaseVal).toBeCloseTo(200)
    expect(v.cogsVal).toBeCloseTo(250)
    // The pre-S792 read (active items only) lost the whole of Rice from the month.
    expect(valuePeriodItems([A], maps).cogsVal).toBeCloseTo(10)
  })

  it('counts a hidden item the same in every column of its row (S720)', () => {
    const v = valuePeriodItems([RICE], maps)
    expect(v.openingVal).toBeCloseTo(100)
    expect(v.purchaseVal).toBeCloseTo(200)
    expect(v.closingVal).toBeCloseTo(60)
    expect(v.cogsVal).toBeCloseTo(240)
  })

  it('names uncounted stock by physical_qty IS NOT NULL, and leaves a hidden item out of the gap', () => {
    const r = {
      ...rows,
      // Oil has a closing ROW with a null count — not a count; Rice has no closing row at all.
      closing: [{ item_id: 'A', physical_qty: null }],
    }
    const m = periodStockMaps(r)
    const gap = periodGap({ items: [A, RICE], maps: m, closing: r.closing, cogs: 300 })
    expect(gap.uncounted.map(u => u.id)).toEqual(['A'])   // Rice is hidden: Stock Count cannot offer it
    expect(gap.presentCount).toBe(1)
    // A count of 0 is a count.
    const zero = periodGap({ items: [A], maps: m, closing: [{ item_id: 'A', physical_qty: '0' }], cogs: 300 })
    expect(zero.uncountedCount).toBe(0)
  })
})

describe('valuePeriods: several months at once, each valued on its own', () => {
  const A = { id: 'A', name: 'Oil', per_uom_rate: '10', is_active: true }
  const H = { id: 'H', name: 'Hidden flour', per_uom_rate: '2', is_active: false }
  // A legacy bill (no purchase_group_id) with the same vendor, invoice and day number in two months:
  // before S792 the fallback bill key carried no period, so a year-wide allocation merged them into one bill
  // and credited ONE discount (max) across both (FIGURES-6). Per month, each keeps its own.
  const legacy = { purchase_group_id: null, vendor_id: 'v', invoice_ref: '', bs_day: 5, discount_amount: '10' }
  const args = {
    periodIds: ['p1', 'p2'],
    items: [A, H],
    opening: [{ period_id: 'p1', item_id: 'A', qty: '1' }],
    closing: [{ period_id: 'p1', item_id: 'A', physical_qty: '1' }, { period_id: 'p2', item_id: 'H', physical_qty: '0' }],
    purchases: [
      { ...legacy, period_id: 'p1', item_id: 'A', qty: '10', rate: '10' },
      { ...legacy, period_id: 'p2', item_id: 'H', qty: '50', rate: '2' },
      { ...legacy, period_id: 'p3', item_id: 'A', qty: '99', rate: '10' },   // a month not asked for
    ],
    returns: [], wastages: [{ period_id: 'p2', item_id: 'H', qty: '5' }], staffMeals: [],
  }
  const out = valuePeriods(args)

  it('returns only the months asked for', () => {
    expect(Object.keys(out).sort()).toEqual(['p1', 'p2'])
  })

  it("allocates each month's bill discounts on their own", () => {
    expect(out.p1.discountVal).toBeCloseTo(10)
    expect(out.p2.discountVal).toBeCloseTo(10)
  })

  it('matches valuePeriodItems for the month, hidden items included', () => {
    // p1: 1×10 + (100 − 10) − 1×10 = 90
    expect(out.p1.cogsVal).toBeCloseTo(90)
    // p2: the hidden flour — 0 + (100 − 10) − 5×2 − 0 = 80
    expect(out.p2.cogsVal).toBeCloseTo(80)
    expect(out.p2.itemCount).toBe(2)   // Oil (active) + the hidden flour, which had rows
  })

  it('carries each month its own uncounted-items gap', () => {
    expect(out.p1.gap.uncountedCount).toBe(0)
    expect(out.p2.gap.uncountedCount).toBe(0)   // the hidden flour is never asked about
  })

  it('returns an empty map for no months', () => {
    expect(valuePeriods({ periodIds: [], items: [A] })).toEqual({})
  })
})

describe('periodWastageValue: one item set for every Wastage tile (S792, FIGURES-5)', () => {
  // Rows as WASTAGE_VALUE_SELECT reads them: the rate rides on the row's own item join.
  const w = (item_id, qty, rate) => ({ item_id, qty, items: rate == null ? null : { per_uom_rate: rate } })
  const rows = [
    w('oil', '2', '10'),        // a raw item: 20
    w('sauce', '1.5', '40'),    // prep (a sub-recipe mirror item): 60
    w('rice', '3', '5'),        // a hidden item: 15
    w('oil', '1', '10'),        // a second (daily) row for the same item: 10
  ]

  it('values every row at its own item rate — prep and hidden items included', () => {
    expect(periodWastageValue(rows)).toBeCloseTo(105)
  })

  it("skips a row of zero or less, as the Wastage Report does", () => {
    expect(wastageRowValue(w('oil', '0', '10'))).toBe(0)
    expect(wastageRowValue(w('oil', '-2', '10'))).toBe(0)
    expect(periodWastageValue([...rows, w('oil', '-4', '10')])).toBeCloseTo(105)
  })

  it('reads a row whose item could not be joined as zero, not NaN', () => {
    expect(wastageRowValue(w('gone', '2', null))).toBe(0)
    expect(periodWastageValue(null)).toBe(0)
  })

  it('reads the rate through the join, so no page item list can narrow the set', () => {
    expect(WASTAGE_VALUE_SELECT).toMatch(/items\(per_uom_rate\)/)
    expect(WASTAGE_VALUE_SELECT).toMatch(/\bqty\b/)
  })

  it("is not COGS's wastage term: valuePeriodItems still takes off only the items it is given", () => {
    // COGS values raw items only, so prep wastage stays out of the arithmetic — its raw ingredients
    // are already inside COGS. Monthly Summary's table keeps adding up.
    const maps = periodStockMaps({ wastages: rows })
    const raw = valuePeriodItems([{ id: 'oil', per_uom_rate: '10' }, { id: 'rice', per_uom_rate: '5' }], maps)
    expect(raw.wastageVal).toBeCloseTo(45)
    expect(periodWastageValue(rows) - raw.wastageVal).toBeCloseTo(60)   // exactly the prep
  })
})
