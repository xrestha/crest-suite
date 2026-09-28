// S792, owner decision D34 (PURCHASES-4): the typed Total is after VAT when the line is ticked, and
// ticking or unticking VAT changes the Rate, never the Total — in either order, and from the
// header's toggle-all too.
import { rateFromLineTotal, withLineTotal, withLineVat, withAllLinesVat } from './billLineVat'

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
