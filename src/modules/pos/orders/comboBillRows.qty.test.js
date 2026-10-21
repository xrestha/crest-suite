// Total Qty as the paper counts it (S856, owner decision): a combo once, at its quantity. The bill
// already counted it so; the credit note and the Complimentary Slip counted every dish inside it, so a
// live bill read "Total Qty: 2" and its credit note "Total Qty: 3".
import { printedQtyOf } from './comboBillRows'
import { computeOrderAmounts } from '../../../utils/posBillingMath'

const LINE = '7f0c2c1e-0000-4000-8000-000000000009'
const dish = (name, group, qty = 1) => ({
  recipe_id: `r-${name}`, name, qty, unit_price: 100, vat_rate: 0.13,
  combo_line_id: LINE, combo_name: 'Test Combo', combo_group_id: group, selection_key: `@${LINE}/${group}`,
})
const SODA = { recipe_id: 'r-soda', name: 'Fresh Lime Soda', qty: 1, unit_price: 160, vat_rate: 0.13 }

test('the live bill: one combo of two dishes plus a soda is 2, as its bill printed', () => {
  const items = [dish('Chicken Chowmein', 'g-main'), dish('Americano', 'g-drink'), SODA]
  expect(printedQtyOf(items)).toBe(2)
  expect(computeOrderAmounts({ discount_amount: 0 }, items, true).totalQty).toBe(2)
})

test('two of one combo count 2; plain lines count their quantity', () => {
  expect(printedQtyOf([dish('Momo', 'g-a', 2), dish('Coke', 'g-b', 2), { ...SODA, qty: 3 }])).toBe(5)
  expect(printedQtyOf([{ ...SODA, qty: 2 }])).toBe(2)
  expect(printedQtyOf([])).toBe(0)
})
