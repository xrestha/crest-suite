import { compareFigures } from './compareFigures'

describe('compareFigures', () => {
  test('a rise and a fall carry their glyph and verdict', () => {
    expect(compareFigures(1200, 1000)).toMatchObject({ glyph: '▲', good: true })
    expect(compareFigures(800, 1000)).toMatchObject({ glyph: '▼', good: false })
    expect(compareFigures(1020, 1000)).toMatchObject({ glyph: '≈', good: null })
  })

  test('nothing to compare against is no comparison', () => {
    expect(compareFigures(1000, null)).toBeNull()
    expect(compareFigures(1000, 0)).toBeNull()
  })

  // S887: a period whose bills were all credited back sums to a float residue like 5e-13, not 0,
  // and a change measured against it read as a rise of billions of percent.
  test('a residue baseline is no baseline; one paisa still is', () => {
    expect(compareFigures(150000, 5.2e-13, { floor: 1000 })).toBeNull()
    expect(compareFigures(0.02, 0.01)).toMatchObject({ glyph: '▲', gapPct: 100 })
  })
})
