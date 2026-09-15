import { toNum, parseSalesReport, findDateRange, dateMismatchWarning } from './SalesImportButton'
import { adToBs } from '../../../utils/bsCalendar'

describe('toNum (S756)', () => {
  test('thousands separators no longer truncate a figure to its first group', () => {
    expect(toNum('1,250.00')).toBe(1250)
    expect(toNum('1,25,000')).toBe(125000)      // Nepali/Indian grouping
    expect(toNum(' 2 500 ')).toBe(2500)
    expect(toNum('3 400.5')).toBe(3400.5)  // non-breaking space
  })

  test('numbers pass through, blanks and text are null, (x) is negative', () => {
    expect(toNum(42)).toBe(42)
    expect(toNum('')).toBeNull()
    expect(toNum('abc')).toBeNull()
    expect(toNum(NaN)).toBeNull()
    expect(toNum('(50)')).toBe(-50)
  })
})

const META = [
  ['Sales Report Item Wise'],
  ['CompanyName : Test Cafe'],
  ['@As On Dated : 2083/05/16  To : 2083/05/16'],
]

describe('parseSalesReport — the discount column (S756)', () => {
  test('prefers the amount column over a percentage column that comes first', () => {
    const aoa = [
      ...META,
      ['Product Name', 'Sale', 'Return', 'Net', 'Gross', 'Disc %', 'Discount Amt'],
      ['Momo', '10', '0', '10', '2,000.00', '10', '200.00'],
    ]
    const { rows } = parseSalesReport(aoa)
    expect(rows).toEqual([{ productName: 'Momo', qty: 10, discount: 200 }])
  })

  test('a sheet whose only discount column is a percentage imports no discount', () => {
    const aoa = [
      ['Product Name', 'Sale', 'Return', 'Net', 'Discount (%)'],
      ['Momo', '10', '0', '10', '15'],
    ]
    expect(parseSalesReport(aoa).rows[0].discount).toBe(0)
  })

  test('a grouped quantity reads in full', () => {
    const aoa = [
      ['Product Name', 'Sale', 'Return', 'Net', 'Discount'],
      ['Water', '1,250', '0', '1,250', '1,000.50'],
    ]
    expect(parseSalesReport(aoa).rows[0]).toEqual({ productName: 'Water', qty: 1250, discount: 1000.5 })
  })
})

describe('the file date range (S756, D28)', () => {
  test('reads a BS range from the block above the header, and ignores dates in the data', () => {
    const aoa = [...META, ['Product Name', 'Net'], ['Momo 2083/01/01', '3']]
    expect(parseSalesReport(aoa).dateRange).toEqual({
      from: { year: 2083, month: 5, day: 16 }, to: { year: 2083, month: 5, day: 16 },
    })
  })

  test("Crest's own export prints AD and BS together; the BS dates win", () => {
    const r = findDateRange([['@As On Dated : 2026-09-01 (B.S. 2083/05/16)  To : 2026-09-03 (B.S. 2083/05/18)']])
    expect(r).toEqual({ from: { year: 2083, month: 5, day: 16 }, to: { year: 2083, month: 5, day: 18 } })
  })

  test('an AD-only range is converted to BS', () => {
    const r = findDateRange([['From 2026-09-01 To 2026-09-01']])
    const bs = adToBs(new Date(2026, 8, 1))
    expect(r).toEqual({ from: bs, to: bs })
  })

  test('no recognisable date → no range, so no warning', () => {
    expect(findDateRange([['Sales Report'], ['Date: 16 Bhadra 2083']])).toBeNull()
    expect(dateMismatchWarning(null, { year: 2083, month: 5, day: 16 })).toBeNull()
  })

  test('warns on a different day and on a multi-day file; silent on a match', () => {
    const day = d => ({ year: 2083, month: 5, day: d })
    expect(dateMismatchWarning({ from: day(16), to: day(16) }, day(16))).toBeNull()
    expect(dateMismatchWarning({ from: day(15), to: day(15) }, day(16))).toMatch(/for 15 .* 2083, but you are filling in 16 .* 2083/)
    expect(dateMismatchWarning({ from: day(1), to: day(31) }, day(16))).toMatch(/more than one day/)
  })
})
