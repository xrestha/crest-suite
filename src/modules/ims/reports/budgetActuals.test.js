// Budget vs Actual's Totals row must BE Monthly Summary's Net Purchases for the same period
// (S792, FIGURES-9). The reconciliation is asserted against periodCost.js — the arithmetic Monthly
// Summary itself runs — rather than against a figure typed here.
import { budgetActuals } from './budgetActuals'
import { periodStockMaps, valuePeriodItems } from './periodCost'

describe('budgetActuals', () => {
  // Every non-sub-recipe item, as both pages now read them: Oil and Rice in Dry Goods, Rice hidden
  // since (D29), Salt with no category. `M` is a prep item's mirror row, which neither page values.
  const items = [
    { id: 'O', category_id: 'dry', per_uom_rate: '10', is_active: true },
    { id: 'R', category_id: 'dry', per_uom_rate: '20', is_active: false },
    { id: 'S', category_id: null, per_uom_rate: '1', is_active: true },
  ]
  const categories = [{ id: 'dry' }, { id: 'dairy' }]
  const bill = { purchase_group_id: 'g1', discount_amount: '40', vendor_id: 'v', invoice_ref: '9', bs_day: 2 }
  // One 400 bill with a 40 discount, one line per item: each 100 line carries 10 of it.
  const purchases = [
    { ...bill, item_id: 'O', qty: '10', rate: '10' },
    { ...bill, item_id: 'R', qty: '5', rate: '20' },
    { ...bill, item_id: 'S', qty: '100', rate: '1' },
    { ...bill, item_id: 'M', qty: '1', rate: '100' },
  ]
  const returns = [{ item_id: 'O', qty: '1', rate: '10' }, { item_id: 'M', qty: '0.5', rate: '100' }]
  const out = budgetActuals({ items, categories, purchases, returns })

  it("keeps a hidden item's spend in the category it was bought under", () => {
    // Oil 90 − 10 returned + Rice 90
    expect(out.byCategory.dry).toBeCloseTo(170)
    expect(out.byCategory.dairy).toBe(0)
  })

  it('reports uncategorised spend as its own row, inside the total', () => {
    expect(out.uncategorised).toBeCloseTo(90)
    expect(out.total).toBeCloseTo(260)
  })

  it('keeps a line neither page values out of the total, and names it', () => {
    // M: 90 − 50 returned
    expect(out.excluded).toBeCloseTo(40)
  })

  it("ties to Monthly Summary's Net Purchases for the same rows", () => {
    const monthly = valuePeriodItems(items, periodStockMaps({ purchases, returns }))
    expect(out.total).toBeCloseTo(monthly.netPurchaseVal)
  })

  it('puts an item whose category is not on the list with the uncategorised spend', () => {
    const r = budgetActuals({
      items: [{ id: 'X', category_id: 'gone' }], categories,
      purchases: [{ item_id: 'X', qty: '1', rate: '50', purchase_group_id: 'g', discount_amount: '0' }], returns: [],
    })
    expect(r.uncategorised).toBeCloseTo(50)
    expect(r.total).toBeCloseTo(50)
  })

  it('is all zeros for an empty period', () => {
    expect(budgetActuals({ items, categories })).toEqual({ byCategory: { dry: 0, dairy: 0 }, uncategorised: 0, excluded: 0, total: 0 })
  })
})
