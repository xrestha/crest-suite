import { PRESETS, legibleBorder, isDarkGround } from './ThemeContext'

// WCAG contrast, written out again here so the test does not trust the module's own maths.
const lum = hex => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('the text-field border (S852)', () => {
  // A field's edge is a control boundary, so WCAG 1.4.11 asks 3:1 against everything it sits on.
  for (const key of ['dark', 'light']) {
    const p = PRESETS[key]
    it(`${p.name}: the authored inputBorder clears 3:1 on card, well and page`, () => {
      for (const ground of [p.card, p.inputBg, p.bg]) {
        expect(contrast(p.inputBorder, ground)).toBeGreaterThanOrEqual(3)
      }
    })
  }

  it('derives a border that clears 3:1 when a custom theme re-grounds the card', () => {
    const grounds = ['#d0cccc', '#ffffff', '#f3f2f2']
    const out = legibleBorder('#d7d3d3', grounds)
    for (const ground of grounds) expect(contrast(out, ground)).toBeGreaterThanOrEqual(3)
  })

  it('moves a dark theme border toward white, not black', () => {
    const out = legibleBorder('#3a3836', ['#242221', '#1e1d1c', '#191817'])
    expect(lum(out)).toBeGreaterThan(lum('#3a3836'))
  })

  it('returns a border that already clears unchanged', () => {
    expect(legibleBorder('#757170', ['#242221', '#1e1d1c', '#191817'])).toBe('#757170')
  })
})

describe('isDarkGround', () => {
  it('reads both presets the right way round, and treats junk as dark', () => {
    expect(isDarkGround(PRESETS.dark.bg)).toBe(true)
    expect(isDarkGround(PRESETS.light.bg)).toBe(false)
    expect(isDarkGround('not-a-colour')).toBe(true)
  })
})
