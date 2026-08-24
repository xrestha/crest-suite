import { createContext, useContext, useState, useEffect, useMemo } from 'react'

// Curated, trending palettes (Tokyo Night, Dracula, Nord, Catppuccin, Rosé Pine, Solarized…).
// `sidebar` is theme-appropriate (dark sidebar for dark themes, light for light) so the sidebar
// follows the selected theme; sidebar text uses --theme-text* which contrast accordingly.
//
// ── The *Text variants, and why they exist (added 2026-08-12) ────────────────────────────────
// A signal colour does two different jobs: it FILLS things (chart series, badge tints, borders,
// dots) and it is TEXT (a status badge's label, a KPI figure, a variance number). On a dark
// preset one value serves both, because a bright green on a near-black card clears AA easily.
// On a LIGHT preset it cannot: measured against their own surfaces, 23 of the 25
// signal-colour/preset combinations across the five light presets failed WCAG AA — Latte's amber
// at 2.15:1, Rosé Dawn's at 1.87:1, its accent at 2.37:1. Every status badge and signal figure in
// the product was affected on half the shipped themes.
//
// Darkening `green`/`red`/`amber` outright would have fixed the text and broken the identity:
// Latte, Rosé Dawn and Solarized are faithful reproductions of palettes people choose *because*
// they recognise those exact values, and the same tokens paint charts and tints where the lighter
// value is correct. So the palettes are untouched and each light preset additionally declares a
// darkened, hue-preserving TEXT variant, clearing 4.5:1 against that preset's worst surface (its
// own sidebar). This mirrors the accent/accentText pairing that already exists.
//
// Note `accentInk` is NOT `accentText`, and the two are easy to confuse: `accentText` is the
// foreground that sits ON an accent-coloured fill; `accentInk` is the accent itself used AS text.
//
// `accentText` was plain `#ffffff` on all five light presets, and on three of them that failed:
// measured live (S551) at 2.84:1 on Rosé Dawn, 3.61:1 on Light and 3.68:1 on Solarized — i.e.
// every `.btn-primary` in the product, on those themes. Fixed by giving those three a dark,
// hue-matched ink instead of darkening the accent itself, since the accent is a brand value and
// also serves as a tint/border/dot colour where it is already correct. Latte (5.41:1) and Bright
// (4.54:1) keep white.
//
// Dark presets declare none of the *Text variants — applyTheme falls back to the base colour for
// each, which is correct there. Three of them (Tokyo Night, Dracula, Nord) DO now declare an
// `accentInk`, for a different reason: `.tab-btn--active` sets accent-as-text on a tint of that
// same accent, and measured against that composited surface the base accent fell to 4.19 / 3.49 /
// 3.50:1 — a light accent on a dark card is not automatically safe once the card is tinted with
// the accent itself. Their inks are LIGHTER than the accent; the light presets' are darker. All
// ten now clear 4.5:1 on both card and page background (S551).
export const PRESETS = {
  dark: {
    name: 'Dark', description: 'Classic charcoal & gold',
    bg: '#0f1117', card: '#181c27', border: '#2a2f3d', borderLt: '#1e2330', sidebar: '#0e1117',
    text1: '#e8e0d0', text2: '#8a92a3', text3: '#9ca3af',
    accent: '#c9a84c', accentHover: '#d4b96a', accentText: '#0f1117',
    inputBg: '#0f1117', tableHover: 'rgba(255,255,255,0.03)', focusRing: 'rgba(201,168,76,0.15)',
    green: '#34d399', red: '#f87171', amber: '#fbbf24', purple: '#a78bfa',
    cardShadow: 'inset 0 1px 0 0 rgba(232,224,208,0.06), 0 10px 24px -8px rgba(15,17,23,0.55), 0 3px 8px -3px rgba(15,17,23,0.4)',
  },
  light: {
    name: 'Light', description: 'Clean warm white',
    bg: '#f6f3ef', card: '#ffffff', border: '#ddd6cf', borderLt: '#ece6df', sidebar: '#ece6dd',
    text1: '#1c1917', text2: '#5c554e', text3: '#6b655e',
    accent: '#b07d2b', accentHover: '#946720', accentText: '#241a08',
    inputBg: '#fbf9f6', tableHover: '#f3ede6', focusRing: 'rgba(176,125,43,0.14)',
    green: '#15803d', red: '#dc2626', amber: '#b45309', purple: '#7c3aed',
    greenText: '#137538', redText: '#c92323', amberText: '#a44c08', purpleText: '#7c3aed', accentInk: '#7a561e',
    cardShadow: '0 1px 2px rgba(28,25,23,0.06), 0 10px 24px -8px rgba(28,25,23,0.1)',
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
// The pair is `dark` ↔ `light` deliberately. Those two are the same design in two schemes (gold
// accent on charcoal / gold accent on warm white), so following the OS changes the SCHEME and
// nothing else. Pairing the light half with Latte or Rosé Dawn would swap the accent hue at
// sunset too, which reads as a different app rather than the same one in daylight.
//
// `system` is deliberately NOT a member of PRESETS: it has no palette of its own, and PRESETS is
// a map of real hex values that colour work (and any contrast check over it) iterates. It is a
// MODE that resolves to one of them.
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
    const base = PRESETS[saved.key] || PRESETS.dark
    return { key: saved.key, colors: { ...base, ...saved.colors } }
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
      key === SYSTEM_KEY ? { key } : { key, colors: next },
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
    setColors(updated)
    setThemeKey('custom')
    localStorage.setItem('crest_theme', JSON.stringify({ key: 'custom', colors: updated }))
  }

  function resetToPreset(key) {
    switchPreset(key || (themeKey === 'dark' ? 'dark' : 'light'))
  }

  // The -text/-ink variants exist only on the five light presets — a dark preset's base signal
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
