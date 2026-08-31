import {
  lcBand, pcBand, nmBand, descendingBand, bandFigure,
  LABOR_WARN, LABOR_CRITICAL, PRIME_WARN, PRIME_CRITICAL, MARGIN_GOOD, MARGIN_WATCH,
} from './operatingBands'

// These bands feed three surfaces that a single owner reads in one sitting — the Roster board's
// Labor Forecast, the Owner Dashboard's KPI row and the frozen Monthly Owner Report. The whole
// point of the module is that they cannot disagree, so the boundaries are asserted rather than
// left to whichever page is opened first.

describe('lcBand — Labor Cost %', () => {
  it('bands on the published 25–30% target, not a borrowed food-cost threshold', () => {
    expect(LABOR_WARN).toBe(30)
    expect(LABOR_CRITICAL).toBe(37)
  })
  it('is inclusive at each boundary', () => {
    expect(lcBand(30).key).toBe('good')
    expect(lcBand(30.1).key).toBe('watch')
    expect(lcBand(37).key).toBe('watch')
    expect(lcBand(37.1).key).toBe('high')
  })
  // The Roster board used to paint 34% amber and 45% the same amber, with no healthy state at all.
  it('separates a healthy day, a watch day and a bad day', () => {
    expect([lcBand(22).key, lcBand(34).key, lcBand(45).key]).toEqual(['good', 'watch', 'high'])
  })
})

describe('pcBand — Prime Cost %', () => {
  it('bands on the 60–65% benchmark the product prints', () => {
    expect([PRIME_WARN, PRIME_CRITICAL]).toEqual([60, 65])
    expect([pcBand(55).key, pcBand(63).key, pcBand(70).key]).toEqual(['good', 'watch', 'high'])
  })
})

describe('nmBand — Net Margin %', () => {
  it('is INVERTED: higher is better', () => {
    expect([MARGIN_GOOD, MARGIN_WATCH]).toEqual([20, 10])
    expect([nmBand(25).key, nmBand(15).key, nmBand(4).key]).toEqual(['good', 'watch', 'high'])
  })
  it('treats a loss as the worst band, not as a missing figure', () => {
    expect(nmBand(-8).key).toBe('high')
  })
})

describe('the band is never carried by colour alone', () => {
  // S608's rule, restated as a test: green and accent-ink are close enough under deuteranopia that
  // Healthy and Watch read as one colour for roughly 1 in 12 men. The marks differ by FILL, not
  // hue, so they survive greyscale and the owner report's monochrome print.
  it('gives every real band a distinct shape mark', () => {
    const marks = [lcBand(10), lcBand(34), lcBand(50)].map(b => b.mark)
    expect(marks).toEqual(['✓', '△', '▲'])
    expect(new Set(marks).size).toBe(3)
    expect([nmBand(25), nmBand(15), nmBand(4)].map(b => b.mark)).toEqual(['✓', '△', '▲'])
  })
  it('gives every real band a distinct colour token as well as a mark', () => {
    const colors = [lcBand(10), lcBand(34), lcBand(50)].map(b => b.color)
    expect(new Set(colors).size).toBe(3)
  })
})

describe('an absent figure gets no verdict', () => {
  it.each([null, undefined, NaN, Infinity])('%p bands as none', v => {
    expect(lcBand(v).key).toBe('none')
    expect(pcBand(v).key).toBe('none')
    expect(nmBand(v).key).toBe('none')
    expect(lcBand(v).mark).toBe('')
  })
  it('renders a dash with no mark and no title', () => {
    const f = bandFigure(null, lcBand)
    expect(f.text).toBe('—')
    expect(f.title).toBeUndefined()
  })
})

describe('bandFigure', () => {
  it('appends the mark to the number so a call site cannot drop it', () => {
    expect(bandFigure(22.34, lcBand).text).toBe('22.3% ✓')
    expect(bandFigure(45, lcBand).text).toBe('45.0% ▲')
  })
  it('honours the caller decimals — the Roster board shows whole percents', () => {
    expect(bandFigure(33.6, lcBand, { decimals: 0 }).text).toBe('34% △')
  })
  it('carries the band name as a title', () => {
    expect(bandFigure(22, lcBand).title).toBe('Healthy (≤30%)')
    expect(bandFigure(50, lcBand).title).toBe('Needs attention (>37%)')
  })
})

describe('descendingBand — the primitive the Monthly Owner Report bands food cost with', () => {
  it('takes the caller thresholds and names them in the title', () => {
    const b = descendingBand(38, 30, 40, ' — your Settings thresholds')
    expect(b.key).toBe('watch')
    expect(b.label).toBe('Watch (30–40% — your Settings thresholds)')
  })
  it('keeps this file’s accent-ink middle step, not fcBand’s amber', () => {
    expect(descendingBand(38, 30, 40).color).toBe('var(--theme-accent-ink)')
  })
})
