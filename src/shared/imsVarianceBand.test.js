import { varianceBand, varianceFigure, VARIANCE_MATERIALITY_NPR } from './imsFormulas'

const S = { variance_flag_pct: 10 }

describe('varianceBand', () => {
  test('reads the client tolerance, not a hardcoded one', () => {
    // The whole point of the helper: TheoreticalVariance hardcoded +-5 and never saw this value.
    expect(varianceBand(7, 9000, { variance_flag_pct: 5 }).key).toBe('over')
    expect(varianceBand(7, 9000, { variance_flag_pct: 10 }).key).toBe('ok')
  })

  test('defaults to 10% when the client has configured nothing', () => {
    expect(varianceBand(9, 9000, {}).key).toBe('ok')
    expect(varianceBand(11, 9000, {}).key).toBe('over')
  })

  test('colour agrees with the flag badge at the boundary', () => {
    // Variance.js painted `variance > 0` red while its own badge used the tolerance, so a +0.4%
    // row was red beside a badge reading OK. Anything inside tolerance is one verdict now.
    expect(varianceBand(0.4, 9000, S).key).toBe('ok')
    expect(varianceBand(10, 9000, S).key).toBe('ok')      // inclusive
    expect(varianceBand(10.01, 9000, S).key).toBe('over')
  })

  test('direction is literal: over is red, under is amber', () => {
    expect(varianceBand(25, 9000, S)).toMatchObject({ key: 'over', mark: '▲', color: 'var(--theme-red-text)' })
    expect(varianceBand(-25, -9000, S)).toMatchObject({ key: 'under', mark: '▼', color: 'var(--theme-amber-text)' })
  })

  test('the dead zone suppresses a large percentage on a trivial amount', () => {
    // A spice line: +40%, worth NPR 20. Without the floor this is the loudest red on the page.
    expect(varianceBand(40, 20, S).key).toBe('immaterial')
    expect(varianceBand(40, 20, S).mark).toBe('≈')
    expect(varianceBand(40, 20, S).color).toBe('var(--theme-text3)')
  })

  test('materiality is checked before tolerance, in both directions', () => {
    expect(varianceBand(-40, -20, S).key).toBe('immaterial')
    expect(varianceBand(2, 10, S).key).toBe('immaterial')
  })

  test('a material amount is judged on percentage, however large the rupees', () => {
    expect(varianceBand(2, 80000, S).key).toBe('ok')
  })

  test('the floor is the documented constant and is overridable per call', () => {
    expect(VARIANCE_MATERIALITY_NPR).toBe(500)
    expect(varianceBand(40, 600, S).key).toBe('over')
    expect(varianceBand(40, 600, S, { floorValue: 1000 }).key).toBe('immaterial')
  })

  test('an unmeasured period is never painted as a finding', () => {
    // No closing count: every figure is an artefact of the gap, not a verdict.
    expect(varianceBand(80, 90000, S, { measured: false })).toMatchObject({ key: 'none', mark: '', color: 'var(--theme-text2)' })
    expect(varianceBand(null, null, S).key).toBe('none')
    expect(varianceBand(Infinity, 9000, S).key).toBe('none')
  })

  test('every band except none carries a non-colour mark', () => {
    const marks = [
      varianceBand(25, 9000, S), varianceBand(-25, -9000, S),
      varianceBand(1, 9000, S), varianceBand(40, 20, S),
    ].map(b => b.mark)
    expect(marks.every(m => m && m.length > 0)).toBe(true)
    expect(new Set(marks).size).toBe(4)   // distinguished by shape, not hue
  })
})

describe('varianceFigure', () => {
  test('prints the sign, the mark, and a title that explains the band', () => {
    const f = varianceFigure(23.456, 9000, S)
    expect(f.text).toBe('+23.5% ▲')
    expect(f.style.color).toBe('var(--theme-red-text)')
    expect(f.title).toMatch(/Over-used by more than 10%/)
  })

  test('an immaterial figure still prints its number', () => {
    // Showing what you are calling immaterial is more honest than hiding it.
    expect(varianceFigure(40, 20, S).text).toBe('+40.0% ≈')
  })

  test('an absent figure is a dash with no title', () => {
    const f = varianceFigure(null, null, S)
    expect(f.text).toBe('—')
    expect(f.title).toBeUndefined()
  })
})
