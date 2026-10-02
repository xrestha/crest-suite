// S792, owner decision D34 (PURCHASES-4): the typed Total is after VAT when the line is ticked, and
// ticking or unticking VAT changes the Rate, never the Total — in either order, and from the
// header's toggle-all too.
import {
  rateFromLineTotal, withLineTotal, withLineVat, withAllLinesVat,
  TOTALS_AFTER_VAT, TOTALS_BEFORE_VAT, totalsBasisOf, withHeaderTotalsBasis, withTotalsBasis,
} from './billLineVat'
import { calcBillTotals, invoiceMismatch } from './purchasesHelpers'

const line = over => ({ _key: 1, qty: '10', rate: '', vat_inclusive: false, _amtDraft: '', ...over })
const amount = l => (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0) * (l.vat_inclusive ? 1.13 : 1)

describe('the typed Total means one thing whichever order it is entered in', () => {
  test('type 1,130 then tick VAT: Rate 100, Amount 1,130 (was Rate 113, Amount 1,276.90)', () => {
    const l = withLineVat(withLineTotal(line(), '1130'), true)
    expect(l._amtDraft).toBe('1130')
    expect(parseFloat(l.rate)).toBeCloseTo(100, 5)
    expect(amount(l)).toBeCloseTo(1130, 2)
  })

  test('tick VAT then type 1,130: the same Rate and Amount', () => {
    const l = withLineTotal(withLineVat(line(), true), '1130')
    expect(parseFloat(l.rate)).toBeCloseTo(100, 5)
    expect(amount(l)).toBeCloseTo(1130, 2)
  })

  test('unticking keeps the Total and moves the Rate back', () => {
    const l = withLineVat(withLineVat(withLineTotal(line(), '1130'), true), false)
    expect(l._amtDraft).toBe('1130')
    expect(parseFloat(l.rate)).toBeCloseTo(113, 5)
    expect(amount(l)).toBeCloseTo(1130, 2)
  })
})

describe('a line whose Rate was typed', () => {
  test('ticking VAT keeps the Rate and adds 13% on top — the Rate box is ex-VAT', () => {
    const l = withLineVat(line({ rate: '100' }), true)
    expect(l.rate).toBe('100')
    expect(amount(l)).toBeCloseTo(1130, 2)
  })

  test('a Total box left blank or unusable never moves the Rate', () => {
    expect(withLineVat(line({ rate: '100', _amtDraft: '' }), true).rate).toBe('100')
    expect(withLineVat(line({ rate: '100', _amtDraft: '0' }), true).rate).toBe('100')
    expect(withLineVat(line({ qty: '', rate: '100', _amtDraft: '1130' }), true).rate).toBe('100')
    expect(withLineTotal(line({ qty: '', rate: '7' }), '500').rate).toBe('7')
  })
})

describe("the header's VAT toggle-all", () => {
  test('keeps every typed Total and makes Amount agree with it (was: Totals 1,130 beside Amounts 1,276.90)', () => {
    const lines = [
      withLineTotal(line({ _key: 1 }), '1130'),
      withLineTotal(line({ _key: 2, qty: '4' }), '452'),
      line({ _key: 3, qty: '2', rate: '50' }),
    ]
    const on = withAllLinesVat(lines)
    expect(on.every(l => l.vat_inclusive)).toBe(true)
    expect(on.map(l => l._amtDraft)).toEqual(['1130', '452', ''])
    expect(amount(on[0])).toBeCloseTo(1130, 2)
    expect(amount(on[1])).toBeCloseTo(452, 2)
    // The rate-typed line keeps its rate and gains VAT.
    expect(on[2].rate).toBe('50')
    expect(amount(on[2])).toBeCloseTo(113, 2)

    const off = withAllLinesVat(on)
    expect(off.every(l => !l.vat_inclusive)).toBe(true)
    expect(amount(off[0])).toBeCloseTo(1130, 2)
    expect(amount(off[1])).toBeCloseTo(452, 2)
  })

  test('a mixed bill is ticked all the way, not flipped line by line', () => {
    const out = withAllLinesVat([line({ vat_inclusive: true }), line({ _key: 2 })])
    expect(out.map(l => l.vat_inclusive)).toEqual([true, true])
  })
})

test('rateFromLineTotal: five decimals, null when it cannot be worked out', () => {
  expect(rateFromLineTotal('3', '1000', false)).toBe('333.33333')
  expect(rateFromLineTotal('3', '1000', true)).toBe('294.98525')
  expect(rateFromLineTotal('0', '1000', true)).toBeNull()
  expect(rateFromLineTotal('3', '', true)).toBeNull()
})

// S801 (owner): a bill says whether its paper prints line totals before or after VAT.
describe('a bill whose line totals are printed BEFORE VAT', () => {
  const B = TOTALS_BEFORE_VAT

  // The receipt that reported it: Big Mart, 02/Oct/2026. Oats and sugar carry 13% VAT, the cheese
  // is exempt, and every line amount on the paper is before VAT — VAT 97.78, grand total 1,114.98.
  const bigMart = basis => [
    withLineVat(withLineTotal(line({ _key: 1, qty: '1000' }), '486.70', basis), true, basis),
    withLineVat(withLineTotal(line({ _key: 2, qty: '1000' }), '265.50', basis), true, basis),
    withLineTotal(line({ _key: 3, qty: '200' }), '265.00', basis),
  ]

  test('the Big Mart bill comes to what its paper says, within the NPR 1 the form allows', () => {
    const lines = bigMart(B)
    expect(lines.map(l => l.rate)).toEqual(['0.48670', '0.26550', '1.32500'])
    const t = calcBillTotals(lines, '')
    expect(t.taxableBase).toBeCloseTo(752.20, 2)
    expect(t.nonTaxableBase).toBeCloseTo(265.00, 2)
    expect(t.vatTotal).toBeCloseTo(97.786, 3)
    expect(t.grandTotal).toBeCloseTo(1114.986, 3)
    expect(invoiceMismatch({ invoiceVat: 97.78, invoiceTotal: 1114.98 }, t).mismatch).toBe(false)
  })

  test('the same keystrokes on an after-VAT bill are the 13%-short bill that was reported', () => {
    const t = calcBillTotals(bigMart(TOTALS_AFTER_VAT), '')
    expect(t.grandTotal).toBeCloseTo(1017.20, 1)
    expect(invoiceMismatch({ invoiceVat: 97.78, invoiceTotal: 1114.98 }, t).totalMismatch).toBe(true)
  })

  test('ticking VAT keeps the Total AND the Rate, and adds 13% on top', () => {
    const typedFirst = withLineTotal(line(), '1000', B)
    expect(typedFirst.rate).toBe('100.00000')
    const ticked = withLineVat(typedFirst, true, B)
    expect(ticked._amtDraft).toBe('1000')
    expect(ticked.rate).toBe('100.00000')
    expect(amount(ticked)).toBeCloseTo(1130, 2)
    // Tick first, then type: the same line.
    expect(withLineTotal(withLineVat(line(), true, B), '1000', B).rate).toBe('100.00000')
  })

  test('the toggle-all keeps every Rate on a before-VAT bill', () => {
    const on = withAllLinesVat([withLineTotal(line({ _key: 1 }), '1000', B), line({ _key: 2, qty: '2', rate: '50' })], B)
    expect(on.map(l => l.rate)).toEqual(['100.00000', '50'])
    expect(on.every(l => l.vat_inclusive)).toBe(true)
  })
})

describe('switching the bill between after and before VAT', () => {
  test('keeps every typed Total and re-works its Rate, in both directions', () => {
    const after = [
      withLineVat(withLineTotal(line({ _key: 1 }), '1130'), true),
      withLineTotal(line({ _key: 2, qty: '4' }), '400'),
    ]
    expect(after[0].rate).toBe('100.00000')

    const before = withTotalsBasis(after, TOTALS_BEFORE_VAT)
    expect(before.map(l => l._amtDraft)).toEqual(['1130', '400'])
    expect(before[0].rate).toBe('113.00000')
    expect(amount(before[0])).toBeCloseTo(1276.90, 2)
    // An unticked line has no VAT either way, so its Rate does not move.
    expect(before[1].rate).toBe('100.00000')

    const back = withTotalsBasis(before, TOTALS_AFTER_VAT)
    expect(back[0].rate).toBe('100.00000')
    expect(amount(back[0])).toBeCloseTo(1130, 2)
  })

  test('a line whose Rate was typed is untouched — the Rate box is ex-VAT on either bill', () => {
    const l = line({ rate: '100', vat_inclusive: true })
    expect(withTotalsBasis([l], TOTALS_BEFORE_VAT)[0]).toBe(l)
  })
})

describe("the bill's choice in its header", () => {
  test('reads as after VAT unless before VAT was chosen', () => {
    expect(totalsBasisOf({})).toBe(TOTALS_AFTER_VAT)
    expect(totalsBasisOf(null)).toBe(TOTALS_AFTER_VAT)
    expect(totalsBasisOf({ totals_basis: 'nonsense' })).toBe(TOTALS_AFTER_VAT)
    expect(totalsBasisOf({ totals_basis: TOTALS_BEFORE_VAT })).toBe(TOTALS_BEFORE_VAT)
  })

  test('going back to after VAT leaves the header exactly as a bill that never left it', () => {
    const opened = { vendor_id: 'v1', discount: '' }
    const before = withHeaderTotalsBasis(opened, TOTALS_BEFORE_VAT)
    expect(before.totals_basis).toBe(TOTALS_BEFORE_VAT)
    const back = withHeaderTotalsBasis(before, TOTALS_AFTER_VAT)
    expect(JSON.stringify(back)).toBe(JSON.stringify(opened))
  })
})
