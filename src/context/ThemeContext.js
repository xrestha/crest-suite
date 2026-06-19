import { createContext, useContext, useState, useEffect } from 'react'

export const PRESETS = {
  dark: {
    name: 'Dark',
    bg: '#0f1117',
    card: '#181c27',
    border: '#2a2f3d',
    borderLt: '#1e2330',
    sidebar: '#0e1117',
    text1: '#e8e0d0',
    text2: '#6b7280',
    text3: '#9ca3af',
    accent: '#c9a84c',
    accentHover: '#d4b96a',
    accentText: '#0f1117',
    inputBg: '#0f1117',
    tableHover: 'rgba(255,255,255,0.02)',
    focusRing: 'rgba(201,168,76,0.15)',
    green: '#34d399',
    red: '#f87171',
    amber: '#fbbf24',
  },
  light: {
    name: 'Light',
    bg: '#f7f4f0',
    card: '#ffffff',
    border: '#ebe4de',
    borderLt: '#f2ece6',
    sidebar: '#162032',
    text1: '#1c1917',
    text2: '#78716c',
    text3: '#a8a29e',
    accent: '#4a6fa3',
    accentHover: '#3d5e8e',
    accentText: '#ffffff',
    inputBg: '#faf7f4',
    tableHover: '#f7f0ec',
    focusRing: 'rgba(74,111,163,0.10)',
    green: '#16a34a',
    red: '#dc2626',
    amber: '#d97706',
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
}

function loadSaved() {
  try {
    const raw = localStorage.getItem('crest_theme')
    if (!raw) return { key: 'dark', colors: PRESETS.dark }
    return JSON.parse(raw)
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

  return (
    <ThemeContext.Provider value={{ themeKey, colors, switchPreset, updateColor, resetToPreset, PRESETS }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() { return useContext(ThemeContext) }
