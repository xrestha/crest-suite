// Bounds supabase-js's AUTH network calls so a stalled token refresh can't wedge the whole client.
//
// auth-js has NO timeout on its own network calls. When the access token expires, the next
// `auth.getSession()` triggers `_callRefreshToken()` → a fetch to `/auth/v1/token`. If that fetch
// stalls (flaky wifi, captive portal, proxy), the auth client wedges — permanently, not just for
// that one call. `_acquireLock` pushes every in-flight operation into `pendingInLock` and drains
// it with `while (this.pendingInLock.length) { await Promise.all(waitOn) }` (GoTrueClient.ts
// ~2803). A promise that never settles means that loop never exits, so `lockAcquired` is never
// reset to false, so every later `_acquireLock` takes the `if (this.lockAcquired)` branch and
// chains `await last` onto the dead promise. Every auth call from then on hangs forever.
//
// That matters far beyond auth, because supabase-js awaits `getAccessToken()` (→ `getSession()`)
// before EVERY database request — see src/utils/withTimeout.js. So one stalled token refresh
// silently freezes every query, insert and update in the app, with no error anywhere, until the
// tab is closed. That is exactly what froze Sales Entry's Save Day across S449–S454.
//
// Bounding the fetch turns "hangs forever" into "rejects in 15s": the pending promise settles,
// the drain loop completes, `lockAcquired` resets, and the client self-heals rather than staying
// wedged. Deliberately scoped to `/auth/v1/` — PostgREST queries and Storage uploads are left
// alone so a genuinely slow report or a large upload is never cut off mid-flight.

// 15s is already pathological for a token refresh, which is a tiny request.
export const AUTH_FETCH_TIMEOUT_MS = 15000
const AUTH_PATH = '/auth/v1/'

export function makeAuthTimeoutFetch(baseFetch, timeoutMs = AUTH_FETCH_TIMEOUT_MS) {
  return function authTimeoutFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    if (!url.includes(AUTH_PATH)) return baseFetch(input, init)

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)

    // Respect a caller-supplied signal rather than discarding it — auth-js doesn't pass one
    // today, but silently dropping an abort signal would be a nasty thing to leave behind.
    const outer = init.signal
    if (outer) {
      if (outer.aborted) ctl.abort()
      else outer.addEventListener('abort', () => ctl.abort(), { once: true })
    }

    return baseFetch(input, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer))
  }
}
