import { bigUnitOf, fmtUnitRate, unitRateCell, unitRateParts, unitRateText } from './unitRate'

// S797: a per-gram or per-ml rate is shown per KG / LTR first, with the stored figure beside it.
// These pin the arithmetic (×1000, never on the stored value) and the precision, since a rate
// printed at two decimals was the defect that asked for this.

describe('bigUnitOf', () => {
  it('knows GM and ML, in any case, and nothing else', () => {
    expect(bigUnitOf('GM')).toEqual({ unit: 'KG', factor: 1000 })
    expect(bigUnitOf('ml')).toEqual({ unit: 'LTR', factor: 1000 })
    expect(bigUnitOf('PCS')).toBeNull()
    expect(bigUnitOf('KG')).toBeNull()
    expect(bigUnitOf('')).toBeNull()
    expect(bigUnitOf(null)).toBeNull()
  })
})

describe('fmtUnitRate', () => {
  it('keeps four decimals below NPR 1 and six below NPR 0.01', () => {
    expect(fmtUnitRate(0.1944)).toBe('0.1944')
    expect(fmtUnitRate(0.115)).toBe('0.115')
    expect(fmtUnitRate(0.004)).toBe('0.004')
    expect(fmtUnitRate(0.0000126)).toBe('0.000013')
  })
  it('groups the Nepali way at two decimals from NPR 1 up', () => {
    expect(fmtUnitRate(50)).toBe('50.00')
    expect(fmtUnitRate(124865)).toBe('1,24,865.00')
  })
  it('keeps four decimals from NPR 1 up when asked to be precise', () => {
    expect(fmtUnitRate(18.3612)).toBe('18.36')
    expect(fmtUnitRate(18.3612, { precise: true })).toBe('18.3612')
    expect(unitRateCell(18.3645, 'PCS', { precise: true })).toBe('18.3645')
    expect(unitRateText(0.1944123, 'GM', { precise: true })).toBe('NPR 194.4123 per KG (0.1944 per GM)')
  })
  it('is a dash for a missing, zero or negative rate', () => {
    expect(fmtUnitRate(0)).toBe('—')
    expect(fmtUnitRate(-2)).toBe('—')
    expect(fmtUnitRate(null)).toBe('—')
    expect(fmtUnitRate('abc')).toBe('—')
  })
})

describe('unitRateParts / unitRateText', () => {
  it('shows a per-gram rate per KG first and the stored figure beside it', () => {
    expect(unitRateParts(0.1944, 'GM')).toEqual({
      primary: { value: '194.40', unit: 'KG' },
      secondary: { value: '0.1944', unit: 'GM' },
    })
    expect(unitRateText(0.1944, 'GM')).toBe('NPR 194.40 per KG (0.1944 per GM)')
    expect(unitRateText(0.1944, 'GM', { prefix: '', per: '/' })).toBe('194.40/KG (0.1944/GM)')
  })
  it('does the same per LTR for a per-ml rate', () => {
    expect(unitRateText(0.3, 'ML')).toBe('NPR 300.00 per LTR (0.30 per ML)')
  })
  it('leaves a unit with no bigger one as it is', () => {
    expect(unitRateText(50, 'BTL')).toBe('NPR 50.00 per BTL')
    expect(unitRateText(0.004, 'PCS')).toBe('NPR 0.004 per PCS')
    expect(unitRateText(12, '')).toBe('NPR 12.00')
  })
  it('keeps a tiny per-KG figure honest too', () => {
    // NPR 0.115 a kilo is 0.000115 a gram; neither half may round to zero.
    expect(unitRateText(0.000115, 'GM')).toBe('NPR 0.115 per KG (0.000115 per GM)')
  })
  it('has a cell form that names the unit only where it converts', () => {
    expect(unitRateCell(0.1944, 'GM')).toBe('194.40/KG (0.1944/GM)')
    expect(unitRateCell(18.36, 'PCS')).toBe('18.36')
    expect(unitRateCell(0.004, 'PCS')).toBe('0.004')
    expect(unitRateCell(0, 'GM')).toBe('—')
  })
  it('is a dash for a rate that is not a positive number', () => {
    expect(unitRateParts(0, 'GM')).toBeNull()
    expect(unitRateText(0, 'GM')).toBe('—')
    expect(unitRateText(undefined, 'GM')).toBe('—')
  })
})
