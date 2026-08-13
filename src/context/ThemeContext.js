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
// Dark presets declare none of these — applyTheme falls back to the base colour for each.
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
  tokyo: {
    name: 'Tokyo Night', description: 'Deep indigo & blue',
    bg: '#1a1b26', card: '#24283b', border: '#343a52', borderLt: '#222539', sidebar: '#16161e',
    text1: '#c0caf5', text2: '#787c99', text3: '#9aa0c0',
    accent: '#7aa2f7', accentHover: '#9bb8fa', accentText: '#16161e',
    inputBg: '#1a1b26', tableHover: 'rgba(122,162,247,0.07)', focusRing: 'rgba(122,162,247,0.18)',
    green: '#9ece6a', red: '#f7768e', amber: '#e0af68', purple: '#bb9af7',
    cardShadow: 'inset 0 1px 0 0 rgba(192,202,245,0.06), 0 10px 24px -8px rgba(26,27,38,0.55), 0 3px 8px -3px rgba(26,27,38,0.4)',
  },
  dracula: {
    name: 'Dracula', description: 'Purple & pink night',
    bg: '#282a36', card: '#343746', border: '#44475a', borderLt: '#2f3240', sidebar: '#21222c',
    text1: '#f8f8f2', text2: '#8a8ea8', text3: '#a8abc8',
    accent: '#bd93f9', accentHover: '#d0b3fb', accentText: '#21222c',
    inputBg: '#282a36', tableHover: 'rgba(189,147,249,0.08)', focusRing: 'rgba(189,147,249,0.2)',
    green: '#50fa7b', red: '#ff5555', amber: '#ffb86c', purple: '#bd93f9',
    cardShadow: 'inset 0 1px 0 0 rgba(248,248,242,0.06), 0 10px 24px -8px rgba(40,42,54,0.55), 0 3px 8px -3px rgba(40,42,54,0.4)',
  },
  nord: {
    name: 'Nord', description: 'Arctic frost blue',
    bg: '#2e3440', card: '#3b4252', border: '#4c566a', borderLt: '#353c4a', sidebar: '#272c36',
    text1: '#eceff4', text2: '#8a93a5', text3: '#aeb6c5',
    accent: '#88c0d0', accentHover: '#9fd0dd', accentText: '#2e3440',
    inputBg: '#2e3440', tableHover: 'rgba(136,192,208,0.08)', focusRing: 'rgba(136,192,208,0.2)',
    green: '#a3be8c', red: '#bf616a', amber: '#ebcb8b', purple: '#b48ead',
    cardShadow: 'inset 0 1px 0 0 rgba(236,239,244,0.06), 0 10px 24px -8px rgba(46,52,64,0.55), 0 3px 8px -3px rgba(46,52,64,0.4)',
  },
  catppuccin: {
    name: 'Catppuccin', description: 'Mocha pastel dark',
    bg: '#1e1e2e', card: '#2a2b3c', border: '#45475a', borderLt: '#313244', sidebar: '#181825',
    text1: '#cdd6f4', text2: '#8087a2', text3: '#a6adc8',
    accent: '#cba6f7', accentHover: '#d8bef9', accentText: '#181825',
    inputBg: '#1e1e2e', tableHover: 'rgba(203,166,247,0.08)', focusRing: 'rgba(203,166,247,0.2)',
    green: '#a6e3a1', red: '#f38ba8', amber: '#f9e2af', purple: '#cba6f7',
    cardShadow: 'inset 0 1px 0 0 rgba(205,214,244,0.06), 0 10px 24px -8px rgba(30,30,46,0.55), 0 3px 8px -3px rgba(30,30,46,0.4)',
  },
  latte: {
    name: 'Latte', description: 'Soft pastel light',
    bg: '#eff1f5', card: '#ffffff', border: '#ccd0da', borderLt: '#e6e9ef', sidebar: '#e6e9ef',
    // Neutral ramp darkened 2026-08-12 for AA. Unlike the signal colours above, these tokens are
    // ONLY ever text — there is no fill or chart use to preserve — so they are corrected in place
    // rather than given variants. text3 failed on all five light presets (3.72–4.02:1); text2 also
    // failed here on Latte. Targets keep three distinct tiers (~6.5 / ~5.6 / ~4.6) instead of
    // flattening them all onto the 4.5 floor.
    text1: '#4c4f69', text2: '#57596b', text3: '#64667a',
    accent: '#8839ef', accentHover: '#7a2fd8', accentText: '#ffffff',
    inputBg: '#f7f8fb', tableHover: '#e9ebf1', focusRing: 'rgba(136,57,239,0.12)',
    green: '#40a02b', red: '#d20f39', amber: '#df8e1d', purple: '#8839ef',
    greenText: '#2f7620', redText: '#b00d30', amberText: '#925d13', purpleText: '#7c33d9', accentInk: '#7c33d9',
    cardShadow: '0 1px 2px rgba(76,79,105,0.06), 0 10px 24px -8px rgba(76,79,105,0.1)',
  },
  dawn: {
    name: 'Rosé Dawn', description: 'Warm rose light',
    bg: '#faf4ed', card: '#fffaf3', border: '#dfd9d3', borderLt: '#f2e9e1', sidebar: '#f2e9e1',
    text1: '#524d72', text2: '#5c5971', text3: '#6c657a',
    accent: '#d7827e', accentHover: '#c66e6a', accentText: '#ffffff',
    inputBg: '#fffaf3', tableHover: '#f4ece4', focusRing: 'rgba(215,130,126,0.16)',
    green: '#56949f', red: '#b4637a', amber: '#ea9d34', purple: '#907aa9',
    greenText: '#417179', redText: '#965266', amberText: '#906020', purpleText: '#746389', accentInk: '#955a57',
    cardShadow: '0 1px 2px rgba(87,82,121,0.06), 0 10px 24px -8px rgba(87,82,121,0.1)',
  },
  solarized: {
    name: 'Solarized', description: 'Cream & ocean blue',
    bg: '#fdf6e3', card: '#fffbf0', border: '#e2dac0', borderLt: '#f0e9d6', sidebar: '#eee8d5',
    text1: '#435359', text2: '#525c5c', text3: '#5c6a6a',
    accent: '#268bd2', accentHover: '#1f6fa8', accentText: '#ffffff',
    inputBg: '#fffbf0', tableHover: '#f3edda', focusRing: 'rgba(38,139,210,0.12)',
    green: '#859900', red: '#dc322f', amber: '#b58900', purple: '#6c71c4',
    greenText: '#5f6d00', redText: '#c32c2a', amberText: '#816200', purpleText: '#5d61a8', accentInk: '#1e6da5',
    cardShadow: '0 1px 2px rgba(88,110,117,0.06), 0 10px 24px -8px rgba(88,110,117,0.1)',
  },
  light: {
    name: 'Light', description: 'Clean warm white',
    bg: '#f6f3ef', card: '#ffffff', border: '#ddd6cf', borderLt: '#ece6df', sidebar: '#ece6dd',
    text1: '#1c1917', text2: '#5c554e', text3: '#6b655e',
    accent: '#b07d2b', accentHover: '#946720', accentText: '#ffffff',
    inputBg: '#fbf9f6', tableHover: '#f3ede6', focusRing: 'rgba(176,125,43,0.14)',
    green: '#15803d', red: '#dc2626', amber: '#b45309', purple: '#7c3aed',
    greenText: '#137538', redText: '#c92323', amberText: '#a44c08', purpleText: '#7c3aed', accentInk: '#865f21',
    cardShadow: '0 1px 2px rgba(28,25,23,0.06), 0 10px 24px -8px rgba(28,25,23,0.1)',
  },
  bright: {
    name: 'Bright', description: 'Crisp cool-bright blue',
    bg: '#f4f7fc', card: '#ffffff', border: '#dde4f0', borderLt: '#eaeff8', sidebar: '#eaf0fb',
    text1: '#0f172a', text2: '#515f77', text3: '#5e6c86',
    accent: '#3a6df0', accentHover: '#2f5cdb', accentText: '#ffffff',
    inputBg: '#f8faff', tableHover: '#eaf0fc', focusRing: 'rgba(58,109,240,0.14)',
    green: '#16a34a', red: '#dc2626', amber: '#d97706', purple: '#7c3aed',
    greenText: '#117c38', redText: '#cf2424', amberText: '#a55a05', purpleText: '#7c3aed', accentInk: '#3563db',
    cardShadow: '0 1px 2px rgba(15,23,42,0.05), 0 10px 26px -8px rgba(58,109,240,0.16), 0 3px 8px -3px rgba(15,23,42,0.06)',
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
  r.style.setProperty('--theme-card-shadow', t.cardShadow)
}

function loadSaved() {
  try {
    const raw = localStorage.getItem('crest_theme')
    if (!raw) return { key: 'dark', colors: PRESETS.dark }
    const saved = JSON.parse(raw)
    // Merge over the current preset defaults rather than trusting the saved blob verbatim — a
    // snapshot captured before a field (e.g. cardShadow) existed would otherwise permanently miss
    // it, since switchPreset/updateColor both persist a full colors object to localStorage.
    const base = PRESETS[saved.key] || PRESETS.dark
    return { key: saved.key, colors: { ...base, ...saved.colors } }
  } catch {
    return { key: 'dark', colors: PRESETS.dark }
  }
}

const ThemeContext = createContext({})

export function ThemeProvider({ children }) {
  const initial = loadSaved()
  const [themeKey, setThemeKey] = useState(initial.key)
  const [colors, setColors] = useState(initial.colors)

  useEffect(() => { applyTheme(colors) }, [colors])

  function switchPreset(key) {
    const preset = PRESETS[key]
    if (!preset) return
    setThemeKey(key)
    setColors(preset)
    localStorage.setItem('crest_theme', JSON.stringify({ key, colors: preset }))
  }

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
    <ThemeContext.Provider value={{ themeKey, colors: resolved, switchPreset, updateColor, resetToPreset, PRESETS }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() { return useContext(ThemeContext) }
