import { lineState, calcBillTotals, billTotalsByKey, billDiscountError } from './purchasesHelpers'

// What a bill line IS before it is saved (S698). The old filter — item && qty > 0 && rate > 0 —
// dropped a row with an item and a quantity but no price from the save with nothing on screen to
// say so, and made free goods (buy 10 get 1 free) unrecordable. Three states, each with a
// different consequence: blank is ignored, incomplete is refused BY NAME, complete saves — and a
// complete line with rate 0 or blank is a free line.

const line = over => ({ item_id: '', qty: '', rate: '', expiry_date: '', shelf_life: '', vat_inclusive: false, _amtDraft: '', ...over })

describe('lineState', () => {
  test('the default empty row is blank, not incomplete', () => {
    expect(lineState(line())).toBe('blank')
  })

  test('item + qty + rate is complete', () => {
    expect(lineState(line({ item_id: 'i1', qty: '10', rate: '25' }))).toBe('complete')
    expect(lineState(line({ item_id: 'i1', qty: 10, rate: 25 }))).toBe('complete')   // QtyInput commits numbers
  })

  test('a free line — item + qty, rate blank or 0 — is complete', () => {
    expect(lineState(line({ item_id: 'i1', qty: '1', rate: '' }))).toBe('complete')
    expect(lineState(line({ item_id: 'i1', qty: '1', rate: '0' }))).toBe('complete')
    expect(lineState(line({ item_id: 'i1', qty: 1, rate: 0 }))).toBe('complete')
  })

  test('an item with no quantity is incomplete, never silently dropped', () => {
    expect(lineState(line({ item_id: 'i1' }))).toBe('incomplete')
    expect(lineState(line({ item_id: 'i1', qty: '0', rate: '25' }))).toBe('incomplete')
    expect(lineState(line({ item_id: 'i1', qty: 0 }))).toBe('incomplete')
  })

  test('a quantity or rate with no item is incomplete', () => {
    expect(lineState(line({ qty: '5' }))).toBe('incomplete')
    expect(lineState(line({ rate: '25' }))).toBe('incomplete')
    expect(lineState(line({ rate: 25 }))).toBe('incomplete')
  })

  test('a negative rate is incomplete', () => {
    expect(lineState(line({ item_id: 'i1', qty: '1', rate: '-5' }))).toBe('incomplete')
  })

  test('an expiry or shelf life alone marks the row touched, so it is refused rather than ignored', () => {
    expect(lineState(line({ expiry_date: '2026-10-01' }))).toBe('incomplete')
    expect(lineState(line({ shelf_life: '30' }))).toBe('incomplete')
  })
})

// S756. The Purchases register valued each shown bill from whatever lines survived its filters, and
// the Item filter narrows per LINE — so the bill-level discount came off one line. A bill is valued
// over ALL its lines; a filter only decides which bills and lines are displayed.
describe('billTotalsByKey', () => {
  // A 10-line NPR 10,000 bill (lines of 500 and 1,055.5556…) with a 1,000 bill discount, no VAT.
  const bill = Array.from({ length: 10 }, (_, i) => ({
    id: `e${i}`, purchase_group_id: 'g1', item_id: `i${i}`,
    qty: 1, rate: i === 0 ? 500 : 9500 / 9, vat_inclusive: false, discount_amount: 1000,
  }))

  test('values the whole bill, whichever line a filter would leave on screen', () => {
    const totals = billTotalsByKey(bill)
    expect(totals.get('g1').grandTotal).toBeCloseTo(9000, 2)
    expect(totals.get('g1').lineCount).toBe(10)
    // The defect it replaces: valuing the one line the Item filter kept, with the whole discount.
    const filteredToOneLine = bill.filter(e => e.item_id === 'i0')
    expect(calcBillTotals(filteredToOneLine, 1000).grandTotal).toBeCloseTo(-500, 2)
  })

  test('takes the discount once — the max the lines repeat, never a sum', () => {
    const totals = billTotalsByKey(bill)
    expect(totals.get('g1').discount).toBe(1000)
  })

  test('a legacy row with no purchase_group_id is its own bill, keyed by its id', () => {
    const legacy = [{ id: 'x1', purchase_group_id: null, qty: 2, rate: 100, vat_inclusive: true, discount_amount: 0 }]
    const t = billTotalsByKey([...bill, ...legacy])
    expect(t.size).toBe(2)
    expect(t.get('x1').grandTotal).toBeCloseTo(226, 2)
  })

  test('VAT is levied on the taxable share net of its part of the discount, over the whole bill', () => {
    const mixed = [
      { id: 'a', purchase_group_id: 'g2', qty: 1, rate: 6000, vat_inclusive: true, discount_amount: 1000 },
      { id: 'b', purchase_group_id: 'g2', qty: 1, rate: 4000, vat_inclusive: false, discount_amount: 1000 },
    ]
    // 10,000 − 1,000 + 13% × 6,000 × 0.9 = 9,702
    expect(billTotalsByKey(mixed).get('g2').grandTotal).toBeCloseTo(9702, 2)
  })
})

// S756. The discount box accepted a negative, or more than the goods, and saved a grand total below
// zero. Blank and zero are fine; exactly the goods value is fine (a bill given away entirely).
describe('billDiscountError', () => {
  test('blank, zero and an ordinary discount pass', () => {
    expect(billDiscountError('', 5000)).toBe('')
    expect(billDiscountError(null, 5000)).toBe('')
    expect(billDiscountError('0', 5000)).toBe('')
    expect(billDiscountError('250.50', 5000)).toBe('')
  })

  test('a discount equal to the goods value passes, float noise included', () => {
    expect(billDiscountError('5000', 5000)).toBe('')
    expect(billDiscountError('0.3', 0.1 + 0.2)).toBe('')
  })

  test('a negative discount is refused', () => {
    expect(billDiscountError('-10', 5000)).toMatch(/cannot be negative/)
  })

  test('a discount larger than the goods is refused, naming both figures', () => {
    const msg = billDiscountError('6000', 4500)
    expect(msg).toMatch(/6,000\.00/)
    expect(msg).toMatch(/4,500\.00/)
  })

  test('any discount on a bill of only free lines is refused', () => {
    expect(billDiscountError('1', 0)).not.toBe('')
  })

  test('something that is not a number is refused rather than read as zero', () => {
    expect(billDiscountError('12abc', 5000)).toMatch(/number/)
  })
})
