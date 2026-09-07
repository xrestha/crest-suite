import fs from 'fs'
import path from 'path'
import { PRESETS } from './ThemeContext'

// `:root` in Layout.css is the PRE-HYDRATION copy of PRESETS.dark. It is not an independent set of
// defaults — it paints in the window before ThemeContext's applyTheme() runs, which is exactly when
// a wrong value is on screen and nothing has overwritten it yet. The block's own comment says it
// must stay byte-identical to the preset.
//
// Nothing enforced that, and it has now drifted twice. The first time (2026-08-12) --theme-text2
// was #6b7280 against the preset's own value and --theme-table-hover was 0.02 alpha against 0.03.
// The second time (S620) the text2/text3 ROLE SWAP landed in ThemeContext and never reached here,
// so the pre-hydration paint carried the inverted ladder for eleven days. Both were found by
// diffing the two blocks by hand, months apart — which is the argument for this file. The failure
// has no symptom: the wrong values are replaced milliseconds later, so nothing looks broken, no
// test fails, and only someone deliberately comparing the two notices.
//
// Deliberately parses the CSS as TEXT rather than importing it. The point is to check what ships in
// the stylesheet, and a CSS-module import under jest would give us a stub, not the declarations.
const CSS_PATH = path.join(__dirname, '..', 'components', 'Layout.css')

// preset key -> the custom property applyTheme() writes it to. Kept explicit rather than derived
// from a camelCase->kebab rule so that adding a preset field forces a decision here: a new colour
// that applyTheme writes has to be added to :root too, and this list is where that is noticed.
const TOKEN_OF = {
  bg: '--theme-bg',
  card: '--theme-card',
  border: '--theme-border',
  borderLt: '--theme-border-lt',
  sidebar: '--theme-sidebar',
  text1: '--theme-text1',
  text2: '--theme-text2',
  text3: '--theme-text3',
  accent: '--theme-accent',
  accentHover: '--theme-accent-hover',
  accentText: '--theme-accent-text',
  accentInk: '--theme-accent-ink',
  inputBg: '--theme-input-bg',
  tableHover: '--theme-table-hover',
  focusRing: '--theme-focus-ring',
  green: '--theme-green',
  red: '--theme-red',
  amber: '--theme-amber',
  purple: '--theme-purple',
  cardShadow: '--theme-card-shadow',
}

function rootBlock() {
  const css = fs.readFileSync(CSS_PATH, 'utf8')
  const m = /:root \{[\s\S]*?\n\}/.exec(css)
  if (!m) throw new Error('Could not find the :root block in Layout.css')
  return m[0]
}

function declared(root, prop) {
  const m = new RegExp(prop.replace(/-/g, '\\-') + ':\\s*([^;]+);').exec(root)
  return m ? m[1].trim() : null
}

describe(':root pre-hydration tokens match PRESETS.dark', () => {
  const root = rootBlock()

  for (const [presetKey, prop] of Object.entries(TOKEN_OF)) {
    it(`${prop} equals PRESETS.dark.${presetKey}`, () => {
      expect(declared(root, prop)).toBe(PRESETS.dark[presetKey])
    })
  }

  // The pair that actually drifted, asserted as a ROLE rather than as two values: text2 is the
  // SECONDARY tier and text3 the quietest. Both clear AA, which is why the S620 inversion was
  // invisible to every contrast audit — the ladder was wrong, not the contrast — and why asserting
  // the ordering is worth more than asserting the hexes. A swap in either file alone fails this.
  //
  // Values updated for Modernist Night (they were #9ca3af / #8a92a3 on the pre-Modernist charcoal
  // palette, measured 6.70:1 and 5.45:1 on that preset's card). The assertion is deliberately
  // written as "text2 is lighter than text3 on a dark ground" rather than as two literals, so the
  // next palette change cannot silently re-invert the ladder the way the last one did.
  it('keeps the text ladder in the same order in both files', () => {
    const lum = (hex) => {
      const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map(v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    }
    // On a DARK ground the secondary tier is the LIGHTER of the two — it has to outrank the
    // quietest tier, which is exactly what the inversion broke.
    expect(lum(PRESETS.dark.text2)).toBeGreaterThan(lum(PRESETS.dark.text3))
    expect(declared(root, '--theme-text2')).toBe(PRESETS.dark.text2)
    expect(declared(root, '--theme-text3')).toBe(PRESETS.dark.text3)
  })

  // A colour applyTheme() writes but :root never declares has no pre-hydration value at all, so it
  // falls back to whatever the consuming rule's own `var(..., fallback)` says — or to nothing.
  it('declares every colour field the dark preset carries', () => {
    const missing = Object.keys(PRESETS.dark)
      .filter(k => !['name', 'description'].includes(k))
      .filter(k => !TOKEN_OF[k])
    expect(missing).toEqual([])
  })
})
