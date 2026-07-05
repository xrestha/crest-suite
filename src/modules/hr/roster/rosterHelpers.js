// Shared by Roster.jsx, ShiftPicker.jsx, and ShiftSettingsPanel.jsx — centralized here instead of
// duplicated so all three format shift times identically.
export function fmtTime(t) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  const ampm = h < 12 ? 'am' : 'pm'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`
}
