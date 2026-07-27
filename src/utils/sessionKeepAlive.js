import { withTimeout } from './withTimeout'

// Supabase access tokens last 1 hour (the project default — confirmed live: exp - iat = 3600).
// auth-js refreshes them on a ~30s ticker, but that ticker only runs while the tab is actually
// awake: background a tab, lock the laptop, or leave a data-entry screen open over lunch, and no
// refresh happens. You come back to an already-expired token, and the very next request has to
// refresh synchronously before it can do anything.
//
// That's the real cause of the "session has stopped responding" reports (S458). It is a UX problem
// specific to this app's shape: Sales Entry, Stock Count and Purchases are screens where a human
// legitimately spends 30-60+ minutes typing before they ever press Save. An hour-long token and a
// save-at-the-end workflow are a bad match, and the fix belongs here rather than in each page.
//
// Refreshing when the tab wakes up costs one small request and means the token is already valid by
// the time the user gets back to typing.
const REFRESH_MARGIN_SEC = 300 // treat "expires within 5 minutes" as needing a refresh now
const AUTH_OP_TIMEOUT_MS = 20000 // never tighter than authFetchTimeout's own 15s cap (see below)

// `supabase` is passed in rather than imported so this module stays free of the client singleton —
// importing it at module load would need REACT_APP_SUPABASE_URL present just to run a unit test.
//
// Returns the current session, refreshing it first if it is expired or close to it.
// Throws only if there is a session that genuinely cannot be renewed; returns null when signed out.
export async function ensureFreshSession(supabase, { marginSec = REFRESH_MARGIN_SEC } = {}) {
  const { data } = await withTimeout(supabase.auth.getSession(), AUTH_OP_TIMEOUT_MS, 'Session check')
  const session = data?.session
  if (!session) return null

  const secondsLeft = (session.expires_at || 0) - Math.floor(Date.now() / 1000)
  if (secondsLeft > marginSec) return session

  const { data: refreshed, error } = await withTimeout(
    supabase.auth.refreshSession(), AUTH_OP_TIMEOUT_MS, 'Session refresh'
  )
  if (error) throw new Error(error.message)
  return refreshed?.session ?? null
}

// Wire up the wake-up triggers. Returns an unsubscribe function.
export function startSessionKeepAlive(supabase, { ensure = () => ensureFreshSession(supabase) } = {}) {
  let running = false
  const wake = () => {
    if (running) return // one in flight is enough; these events often fire together
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    running = true
    // Best-effort by design: this is a background top-up, not something the user asked for, so a
    // failure here must never surface as an error. A genuinely dead session still gets reported
    // by whatever real request the user makes next.
    Promise.resolve(ensure())
      .catch(err => console.warn('Session keep-alive skipped:', err?.message || err))
      .finally(() => { running = false })
  }

  document.addEventListener('visibilitychange', wake)
  window.addEventListener('focus', wake)
  window.addEventListener('online', wake)

  return () => {
    document.removeEventListener('visibilitychange', wake)
    window.removeEventListener('focus', wake)
    window.removeEventListener('online', wake)
  }
}

// Is this error the server rejecting our token, rather than a genuine application failure?
// PGRST301 is PostgREST's "JWT expired / invalid" code.
export function isAuthExpiredError(error) {
  if (!error) return false
  if (error.status === 401 || error.code === 'PGRST301') return true
  return /jwt expired|invalid jwt|jwt is expired|token is expired|not authenticated/i.test(
    `${error.message || ''} ${error.hint || ''}`
  )
}
