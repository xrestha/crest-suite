// The hand-off between the setup guide and the page a step opens (S790). Pressing Start on a step
// stores what to press there; the Layout strip reads it on that page. Research on first-time users
// found this hand-off is where they get lost: the instruction stayed behind on the dashboard.
//
// sessionStorage, not localStorage: it belongs to this tab's visit, and signOut()/switchOutlet()
// already clear sessionStorage, so one login's tip never shows to the next. Every access is wrapped
// — a private window or blocked storage just means no strip.
const KEY = 'crest:setup-strip'
const MAX_AGE_MS = 3 * 60 * 60 * 1000

export function writeSetupStrip(payload) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ ...payload, at: Date.now() })) } catch { /* storage unavailable */ }
}

export function readSetupStrip() {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const p = JSON.parse(raw)
    if (!p || typeof p.route !== 'string' || Date.now() - (p.at || 0) > MAX_AGE_MS) return null
    return p
  } catch { return null }
}

export function clearSetupStrip() {
  try { sessionStorage.removeItem(KEY) } catch { /* storage unavailable */ }
}
