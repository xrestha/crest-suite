// Shared by Roster.jsx, ShiftPicker.jsx, and ShiftSettingsPanel.jsx — centralized here instead of
// duplicated so all three format shift times identically.
export function fmtTime(t) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  const ampm = h < 12 ? 'am' : 'pm'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`
}

// ── Shift-chip label colour ───────────────────────────────────────────────────────────────────
// A shift's `color` is a per-shift CATEGORICAL hue (DEFAULT_SHIFTS' literal hex, or whatever the
// client picked in Shift Types' colour picker) — deliberately NOT a theme token, and exempt from
// the design system's token rule for that reason. But the roster board used that one value for
// BOTH the chip fill (`color + '22'`) and the chip's label text, which is the fill/text conflation
// DESIGN.md warns about: measured on the Dark preset, "Morning" came out at 3.92:1 and "Split" at
// 4.17:1 at 11px/700, both under WCAG AA.
//
// A static paired text value can't fix it, for two reasons: `hr_shift_types` has no text column
// (adding one to DEFAULT_SHIFTS would break the seed INSERT), and the colour is user-editable
// anyway, so any hand-picked pairing covers only the seven seeds. So the label colour is DERIVED:
// same hue, lightness stepped away from the composited chip background until it clears 4.5:1.
// A colour that already clears it is returned untouched, so Afternoon/Full Day keep their exact
// value on every dark preset. Verified across all 7 default shifts × all 10 presets: worst case
// 4.50:1, none below.
//
// The FILL keeps the base colour everywhere (swatches, legend dots, chip background, borders) —
// only the label text goes through this.

const AA_MIN = 4.5

function hexToRgb(hex) {
  if (typeof hex !== 'string') return null
  let h = hex.trim().replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function rgbToHex([r, g, b]) {
  return '#' + [r, g, b]
    .map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0'))
    .join('')
}

function luminance([r, g, b]) {
  const f = c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(a, b) {
  const la = luminance(a), lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function over(fg, alpha, bg) {
  return [0, 1, 2].map(i => fg[i] * alpha + bg[i] * (1 - alpha))
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  let h = 0, s = 0
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r)      h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else                h = (r - g) / d + 4
    h /= 6
  }
  return [h, s, l]
}

function hslToRgb([h, s, l]) {
  if (s === 0) { const v = l * 255; return [v, v, v] }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = t => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255]
}

// `surfaceHex` is the card/panel the chip sits on (ThemeContext's `colors.card`); `tintAlpha` is
// the alpha the shift colour is painted onto that surface with (0x22 → 0.133 for a roster cell,
// 0 where the label sits straight on the card). Returns a hex string, or the input untouched when
// it isn't a parseable hex (a caller passing a `var()` token gets it back unchanged).
export function shiftTextColor(shiftHex, surfaceHex, tintAlpha = 0) {
  const fg = hexToRgb(shiftHex)
  if (!fg) return shiftHex
  const surface = hexToRgb(surfaceHex) || [24, 28, 39]
  const bg = tintAlpha > 0 ? over(fg, tintAlpha, surface) : surface
  if (contrast(fg, bg) >= AA_MIN) return shiftHex

  const [h, s, l0] = rgbToHsl(fg)
  // Step toward whichever end of the ramp the background leaves room for — darker text on a light
  // chip, lighter text on a dark one — nudging saturation up slightly so the hue survives the move.
  const darken = contrast([0, 0, 0], bg) >= contrast([255, 255, 255], bg)
  const sat = Math.min(1, s * 1.05)
  for (let i = 1; i <= 100; i++) {
    const l = darken ? Math.max(0, l0 - i / 100) : Math.min(1, l0 + i / 100)
    const cand = hslToRgb([h, sat, l])
    if (contrast(cand, bg) >= AA_MIN) return rgbToHex(cand)
    if (l === 0 || l === 1) break
  }
  return darken ? '#000000' : '#ffffff'
}
