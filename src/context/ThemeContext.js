import { createContext, useContext, useState, useEffect, useMemo } from 'react'

// ── Modernist: two presets, one signal red ───────────────────────────────────────────────────
// The product ships exactly TWO palettes — Modernist Night (dark) and Modernist Light — plus a
// `system` MODE that resolves to one of them. Ten curated palettes (Tokyo Night, Dracula, Nord,
// Catppuccin, Rosé Pine, Solarized…) shipped until they were measured and cut to the two that
// came out clean; several comments elsewhere in the codebase still name them, and those are
// history, not live presets.
//
// `sidebar` is theme-appropriate (darker than the page on Night, level with the card on Light) so
// the shell recedes behind the work; sidebar text uses --theme-text* and contrasts accordingly.
//
// ── The *Text variants, and why they exist (added 2026-08-12) ────────────────────────────────
// A signal colour does two different jobs: it FILLS things (chart series, badge tints, borders,
// dots) and it is TEXT (a status badge's label, a KPI figure, a variance number). On a dark preset
// one value serves both, because a bright green on a near-black card clears AA easily. On a LIGHT
// preset it cannot — measured, 23 of 25 signal-colour/surface combinations failed WCAG AA across
// the light presets of the day. So each light preset declares a darkened, hue-preserving TEXT
// variant while the base tokens stay correct for charts, tints, borders and dots.
//
// Note `accentInk` is NOT `accentText`, and the two are easy to confuse: `accentText` is the
// foreground that sits ON an accent-coloured fill; `accentInk` is the accent itself used AS text.
// Dark presets historically declared no *Text variants at all — applyTheme falls back to the base
// colour for each, which is correct there — but BOTH presets now declare an `accentInk`, because
// `.tab-btn--active` sets accent-as-text on a tint of that same accent and the base accent does
// not survive that composite on either ground.
//
// ── What Modernist changed, and what it deliberately did not ─────────────────────────────────
// Ground, ink and accent are new. The four signal colours and the light preset's four *Text
// variants are carried over BYTE-IDENTICAL from the previous palette: they were tuned for AA and
// for red-green colour blindness over three separate passes, and none of that work is about the
// accent. The one thing a red accent DID force is both presets' `accentInk`, which had to move a
// ramp step further from the danger and warning slots — the per-preset comments below carry the
// measurements and are the thing to read before touching either value.
export const PRESETS = {
  dark: {
    name: 'Modernist Night', description: 'Ink & signal red',
    bg: '#191817', card: '#242221', border: '#3a3836', borderLt: '#2c2a29', sidebar: '#141312',
    text1: '#f3f2f2', text2: '#bab6b6', text3: '#9b9797',
    accent: '#ff563c', accentHover: '#ff9783', accentText: '#201e1d',
    // accent-300, not the accent-400 the Modernist handoff specified. Measured against this
    // preset's OWN signal set, #ff9783 sat at ΔE 7.4 from `red` under deuteranopia and 7.8 from
    // `green` under protanopia — both under the floor of 8, i.e. the accent-as-text slot and the
    // danger slot reading as one colour for ~8% of men. That is the S608 failure recurring, and it
    // is specific to a RED accent: the old brass never landed near red at all. #ffc4b8 clears at
    // 10.4 worst-pair and still measures 10.44:1 on the card and 9.02:1 on its own accent tint
    // (the .tab-btn--active case this token exists for). Don't restore #ff9783 without re-running
    // those pairs. The Light half needed the same correction in the other direction.
    accentInk: '#ffc4b8',
    inputBg: '#1e1d1c', tableHover: 'rgba(255,255,255,0.04)', focusRing: 'rgba(255,86,60,0.15)',
    // Deliberately carried over UNCHANGED from the previous palette. These four were tuned for AA
    // and for red-green colour blindness across S551/S608/S683; Modernist replaces ground, ink and
    // accent only. Retuning them to "match" the new accent would undo that work.
    green: '#34d399', red: '#f87171', amber: '#fbbf24', purple: '#a78bfa',
    cardShadow: 'inset 0 1px 0 0 rgba(243,242,242,0.05), 0 10px 24px -8px rgba(0,0,0,0.55), 0 3px 8px -3px rgba(0,0,0,0.4)',
  },
  light: {
    name: 'Modernist Light', description: 'Paper & signal red',
    bg: '#f3f2f2', card: '#eae9e9', border: '#d7d3d3', borderLt: '#e5e3e3', sidebar: '#eae9e9',
    text1: '#201e1d', text2: '#605d5d', text3: '#7d7979',
    // accentText is plain white here and that is a MEASURED 4.20:1 on the accent — legal as large
    // text, not as normal text. The product's answer is the label size, not a darker ink: .btn is
    // 15px/600, which is where WCAG's large-text threshold begins. Any accent fill carrying text
    // below that (::selection, which inherits whatever size it lands on) uses #dd2b0f instead,
    // where white clears 4.74:1. See DESIGN.md -> Components -> Buttons.
    accent: '#ec3013', accentHover: '#dd2b0f', accentText: '#ffffff',
    // accent-800, not the accent-700 the handoff specified — the mirror of the Night correction
    // above. #ae1800 measured ΔE 0.5 from amberText under deuteranopia and 6.5 under protanopia:
    // the categorical slot ("decided, unpaid" / a rank / a close type) and the open-and-waiting
    // slot collapsing into one colour, on exactly the HR approval queues a manager reads to tell
    // them apart. #7c1405 clears at 16.1/21.3 and holds 8.85:1 on the card, 9.59:1 on the page and
    // 8.11:1 on its own badge tint over the page ground (the S683 second-ground rule).
    accentInk: '#7c1405',
    inputBg: '#ffffff', tableHover: '#e6e4e4', focusRing: 'rgba(236,48,19,0.12)',
    green: '#15803d', red: '#dc2626', amber: '#b45309', purple: '#7c3aed',
    // Unchanged from the pre-Modernist palette, and see the S608/S683 history in git: these are
    // the only pair (of 120 searched) clearing both deuteranopia and protanopia while every
    // variant still holds 4.5:1 on card, page and its own badge tint. Don't tidy them toward the
    // new accent — redText is a crimson and accentInk is an orange-red, and that ΔE 33 separation
    // under deuteranopia is now the ONLY thing keeping "refused" apart from "decided, unpaid".
    greenText: '#116b33', redText: '#8f2440', amberText: '#964900', purpleText: '#6d28d9',
    cardShadow: '0 1px 2px rgba(45,43,43,0.14)',
  },
}

function applyTheme(t) {
  const r = document.documentElement
  r.style.setProperty('--theme-bg', t.bg)
  r.style.setProperty('--theme-card', t.card)
  r.style.setProperty('--theme-border', t.border)
  r.style.setProperty('--theme-border-lt', t.borderLt)
  r.style.setProperty('--theme-sidebar', t.sidebar)
  r.style.setProperty('--theme-text1', t.text1)
  r.style.setProperty('--theme-text2', t.text2)
  r.style.setProperty('--theme-text3', t.text3)
  r.style.setProperty('--theme-accent', t.accent)
  r.style.setProperty('--theme-accent-hover', t.accentHover)
  r.style.setProperty('--theme-accent-text', t.accentText)
  r.style.setProperty('--theme-input-bg', t.inputBg)
  r.style.setProperty('--theme-table-hover', t.tableHover)
  r.style.setProperty('--theme-focus-ring', t.focusRing)
  r.style.setProperty('--theme-green', t.green)
  r.style.setProperty('--theme-red', t.red)
  r.style.setProperty('--theme-amber', t.amber)
  r.style.setProperty('--theme-purple', t.purple)
  // Text variants — see the block comment above PRESETS. A preset that does not declare one is a
  // dark preset, where the base colour already clears AA against its own surfaces, so it falls
  // back rather than needing 5 duplicate keys per preset. A custom theme built from a dark base
  // inherits the same fallback, which is correct: it only ever darkens a value that needed it.
  r.style.setProperty('--theme-green-text', t.greenText || t.green)
  r.style.setProperty('--theme-red-text', t.redText || t.red)
  r.style.setProperty('--theme-amber-text', t.amberText || t.amber)
  r.style.setProperty('--theme-purple-text', t.purpleText || t.purple)
  r.style.setProperty('--theme-accent-ink', t.accentInk || t.accent)
  // Solid keyboard-focus indicator. --theme-focus-ring is a TINT token — it doubles as the
  // active-state background for rail buttons, module tabs and sidebar links, so its alpha must
  // stay low (raising it to make focus visible would flood every active surface). Measured on
  // Rosé Dawn the ring alone composited to 1.15:1 against the card, 2.6× below the WCAG 2.2
  // 3:1 floor for a focus indicator (S574). Focus rules pair the tint with this solid colour:
  // accentInk is already the accent darkened to ≥4.5:1 as text on the light presets, and on the
  // dark presets the accent itself clears the floor against their surfaces.
  r.style.setProperty('--theme-focus-outline', t.accentInk || t.accent)
  r.style.setProperty('--theme-card-shadow', t.cardShadow)
}

// ── `system`: follow the phone's own light/dark setting ──────────────────────────────────────
// Added for the Crest Staff employee app. An employee reaches the portal on their own phone and
// cannot open Settings → Appearance at all — ProtectedRoute bounces a self-service account away
// from every admin route — so the only theme they could ever have was whatever the hardcoded
// default happened to be: a dark app held up in Kathmandu daylight, with no way to change it.
//
// The pair is `dark` ↔ `light` deliberately. Those two are the same design in two schemes —
// signal red on ink, signal red on paper — so following the OS changes the SCHEME and nothing
// else. This is why Modernist was built as a PAIR rather than as one palette with a dark mode
// bolted on: pairing the light half with a differently-hued preset would swap the accent at
// sunset too, which reads as a different app rather than the same one in daylight.
//
// `system` is deliberately NOT a member of PRESETS: it has no palette of its own, and PRESETS is
// a map of real hex values that colour work (and any contrast check over it) iterates. It is a
// MODE that resolves to one of them.
// ── Deriving the accent's siblings (Settings → Theme offers 10 swatches; the palette has ~20) ──
// Kept as plain functions over hex so they are testable and so applyTheme stays a list of
// assignments. `--theme-accent-hover` and `--theme-focus-ring` have NO fallback in applyTheme, so
// they must always be present on a custom theme: an unset CSS variable makes every rule that reads
// it resolve to nothing, which is a broken hover rather than a flat one.
const hexToRgb = h => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || ''))
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const toHex = rgb => '#' + rgb.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')
const mixTo = (rgb, target, amt) => rgb.map((c, i) => c + (target[i] - c) * amt)
// WCAG relative luminance and contrast ratio — the same formulas the palette was tuned against.
const relLum = ([r, g, b]) => {
  const f = c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const ratio = (a, b) => {
  const [hi, lo] = relLum(a) > relLum(b) ? [relLum(a), relLum(b)] : [relLum(b), relLum(a)]
  return (hi + 0.05) / (lo + 0.05)
}

/** `rgba()` tint of a hex colour — the shape --theme-focus-ring holds in every preset. */
export function tintOf(hex, alpha) {
  const rgb = hexToRgb(hex)
  return rgb ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})` : `rgba(0,0,0,${alpha})`
}

/** Hover shift, in the direction each preset already shifts its own: lighter on a dark accent, darker on a light one. */
export function hoverOf(hex) {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  return toHex(relLum(rgb) < 0.4 ? mixTo(rgb, [255, 255, 255], 0.28) : mixTo(rgb, [0, 0, 0], 0.16))
}

/**
 * The accent darkened (or lightened) until it clears 4.5:1 as TEXT on the given surface — what the
 * presets author by hand as `accentInk` and what --theme-accent-ink / --theme-focus-outline read.
 * Returns the accent itself when it already clears, and gives up at pure black/white rather than
 * looping: an accent on a mid-grey card can have no legible version of itself, and a 4.4:1 ink is
 * still far better than the previous accent's.
 */
export function legibleInk(accentHex, surfaceHex) {
  const accent = hexToRgb(accentHex)
  const surface = hexToRgb(surfaceHex)
  if (!accent) return accentHex
  if (!surface) return accentHex
  if (ratio(accent, surface) >= 4.5) return accentHex
  const target = relLum(surface) > 0.45 ? [0, 0, 0] : [255, 255, 255]
  let best = accent
  for (let amt = 0.05; amt <= 1.0001; amt += 0.05) {
    best = mixTo(accent, target, amt)
    if (ratio(best, surface) >= 4.5) break
  }
  return toHex(best)
}

export const SYSTEM_KEY = 'system'
const SYSTEM_PAIR = { dark: 'dark', light: 'light' }

function prefersDark() {
  try {
    // Default to dark when the query is unavailable — that is what this product has always been.
    return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? true
  } catch {
    return true
  }
}

function resolveColors(key) {
  if (key === SYSTEM_KEY) return PRESETS[prefersDark() ? SYSTEM_PAIR.dark : SYSTEM_PAIR.light]
  return PRESETS[key] || PRESETS.dark
}

// Only the employee portal defaults to following the device. The admin app keeps its `dark`
// default: silently re-theming every owner who has never opened Settings is a different change
// from the one this was built for. An explicitly chosen preset always wins on both surfaces.
function defaultKeyForSurface() {
  try {
    return window.location.pathname.startsWith('/hr/self-service') ? SYSTEM_KEY : 'dark'
  } catch {
    return 'dark'
  }
}

// Bumped when a palette change must reach users who are pinned to their own edited colours.
// A saved blob without this exact stamp predates the change and is discarded once (see the
// `custom` branch in loadSaved). This is the ONLY mechanism that reaches a 'custom' user — every
// other key resolves fresh from PRESETS and needs nothing.
const THEME_SCHEMA = 'modernist-1'

function loadSaved() {
  try {
    const raw = localStorage.getItem('crest_theme')
    if (!raw) {
      const key = defaultKeyForSurface()
      return { key, colors: resolveColors(key) }
    }
    const saved = JSON.parse(raw)
    // `system` persists the KEY ONLY, so there is nothing to merge — re-ask the device instead.
    // Storing its resolved colours would replay whichever scheme was last active and defeat the
    // entire point on the next load.
    if (saved.key === SYSTEM_KEY) return { key: SYSTEM_KEY, colors: resolveColors(SYSTEM_KEY) }
    // Merge over the current preset defaults rather than trusting the saved blob verbatim — a
    // snapshot captured before a field (e.g. cardShadow) existed would otherwise permanently miss
    // it, since switchPreset/updateColor both persist a full colors object to localStorage.
    // A RETIRED preset (S607 cut eight of them) must not survive in localStorage. switchPreset
    // persists the full colours object, so `{ ...base, ...saved.colors }` would let the saved blob
    // override the fallback completely and keep rendering a theme that no longer exists — with
    // nothing selected in the picker, and no way back to it once the user switched away. `custom`
    // is deliberately exempt: it is not a preset key, and its colours ARE the user's own edits.
    if (saved.key !== 'custom' && !PRESETS[saved.key]) {
      const key = defaultKeyForSurface()
      return { key, colors: resolveColors(key) }
    }
    // A NON-CUSTOM key is always an unedited snapshot: updateColor flips the key to 'custom' the
    // moment anything is changed, so `saved.colors` under a preset key is only ever a copy of that
    // preset as it stood when it was picked. Merging it back over the preset therefore does not
    // preserve a choice — it pins the user to a stale copy, and a corrected token never reaches
    // anyone who has ever selected a theme. Found while fixing the dark text ladder above: the
    // swap would have shipped to new installs only. Resolving fresh also subsumes what the merge
    // was written for (a snapshot predating a newly-added field like cardShadow).
    if (saved.key !== 'custom') return { key: saved.key, colors: resolveColors(saved.key) }
    // `custom` IS the user's own edits, so here the saved values normally win — with the preset
    // underneath only to fill in fields that did not exist when the snapshot was taken.
    //
    // The exception, and it is deliberate: a 'custom' blob saved before the Modernist re-theme is
    // DISCARDED. switchPreset persists the FULL colours object before updateColor overwrites any
    // of it, so someone who once nudged a single swatch is carrying all twenty values of the old
    // gold-on-charcoal palette — and because the saved blob wins, they would keep that palette
    // forever, with 'Custom ✓' in the picker and no route back. That is not "preserving their
    // edits"; it is pinning them to a product that no longer exists. Dropping it once costs at
    // most a handful of swatch tweaks and is the only way the re-theme reaches them at all.
    //
    // Everything saved from here on carries THEME_SCHEMA, so this fires exactly once per user.
    if (saved.schema !== THEME_SCHEMA) {
      const key = defaultKeyForSurface()
      return { key, colors: resolveColors(key) }
    }
    return { key: 'custom', colors: { ...PRESETS.dark, ...saved.colors } }
  } catch {
    const key = defaultKeyForSurface()
    return { key, colors: resolveColors(key) }
  }
}

const ThemeContext = createContext({})

export function ThemeProvider({ children }) {
  const initial = loadSaved()
  const [themeKey, setThemeKey] = useState(initial.key)
  const [colors, setColors] = useState(initial.colors)

  useEffect(() => { applyTheme(colors) }, [colors])

  function switchPreset(key) {
    if (key !== SYSTEM_KEY && !PRESETS[key]) return
    const next = resolveColors(key)
    setThemeKey(key)
    setColors(next)
    // See loadSaved: the system mode stores its key and nothing else.
    localStorage.setItem('crest_theme', JSON.stringify(
      key === SYSTEM_KEY ? { key, schema: THEME_SCHEMA } : { key, colors: next, schema: THEME_SCHEMA },
    ))
  }

  // Track the device live while — and only while — the mode is `system`, so a phone flipping to
  // dark at sunset repaints without a reload, and an explicitly chosen preset is never quietly
  // overridden by the OS.
  useEffect(() => {
    if (themeKey !== SYSTEM_KEY) return undefined
    let mq
    try { mq = window.matchMedia('(prefers-color-scheme: dark)') } catch { return undefined }
    if (!mq?.addEventListener) return undefined
    const onChange = () => setColors(resolveColors(SYSTEM_KEY))
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [themeKey])

  function updateColor(colorKey, value) {
    const updated = { ...colors, [colorKey]: value }
    // The accent is three tokens, not one. `colors` here is the RESOLVED object, so a plain spread
    // carried the PREVIOUS accent's `accentInk` into the custom theme as if it had been authored —
    // and Settings → Theme offers no control for it. The result: the buttons changed colour and
    // every accent-coloured piece of TEXT did not. Set the accent to green on Light and the active
    // tab, the links, the ⬢ mark and the focus outline all stayed #7c1405 crimson, permanently.
    // Re-derive instead: the ink darkened (or lightened) until it is legible as type on the card,
    // the hover shifted the way each preset shifts its own, and the focus tint re-tinted.
    if (colorKey === 'accent') {
      updated.accentInk = legibleInk(value, updated.card)
      updated.accentHover = hoverOf(value)
      updated.focusRing = tintOf(value, 0.15)
    }
    // The same applies in reverse: re-grounding the card can leave a derived ink unreadable on it.
    if (colorKey === 'card' && colors.accent) updated.accentInk = legibleInk(updated.accent, value)
    setColors(updated)
    setThemeKey('custom')
    localStorage.setItem('crest_theme', JSON.stringify({ key: 'custom', colors: updated, schema: THEME_SCHEMA }))
  }

  function resetToPreset(key) {
    switchPreset(key || (themeKey === 'dark' ? 'dark' : 'light'))
  }

  // The -text/-ink variants exist only on the light preset — a dark preset's base signal
  // colour is already legible as type, so there was nothing to darken. applyTheme() resolves that
  // asymmetry for CSS; this resolves it for JS.
  //
  // It matters because Recharts reads plain values, not CSS variables: a chart that wants the
  // legible variant would otherwise have to write `colors.greenText || colors.green` at every
  // call site, and the one place someone forgets is a dark-preset crash or a silent revert to
  // the low-contrast base. Resolving once here means `resolved.greenText` is always a colour.
  const resolved = useMemo(() => ({
    ...colors,
    greenText:  colors.greenText  || colors.green,
    redText:    colors.redText    || colors.red,
    amberText:  colors.amberText  || colors.amber,
    purpleText: colors.purpleText || colors.purple,
    accentInk:  colors.accentInk  || colors.accent,
  }), [colors])

  return (
    <ThemeContext.Provider value={{ themeKey, colors: resolved, switchPreset, updateColor, resetToPreset, PRESETS, SYSTEM_KEY }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() { return useContext(ThemeContext) }
