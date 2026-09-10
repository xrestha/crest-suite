// Shared short-lived per-tab cache so a page can show its last-known data instantly on
// revisit instead of a blank skeleton while it re-fetches from Supabase from scratch.
// sessionStorage (not localStorage) so nothing survives past this tab/session. That is NOT on its
// own enough to stop data lingering across a sign-out/sign-in — this header used to claim it was.
// sessionStorage lives as long as the TAB, not the session, and the key below carries the client
// id but no user id, so signing out and back in as a different account of the same client used to
// read the previous account's cached data straight back — past the RESTRICTIVE staff-isolation
// policies that are the whole reason two accounts of one client see different rows. `signOut()`
// in AuthContext now clears sessionStorage, the same way `switchOutlet()` already did; keep that
// call alive if either is rewritten. Deliberately dumb
// key-value storage of already-computed values — this file does no calculation of its own, so
// it carries none of the risk of touching a page's actual data/logic.
//
// `page` namespaces keys per page (e.g. 'dashboard', 'purchases') so two pages caching a
// section with the same name (e.g. both having an 'items' section) never collide.
const MAX_AGE_MS = 10 * 60 * 1000 // 10 minutes: long enough to help normal page-to-page
// navigation, short enough that stale data is never shown as if current.

function cacheKey(page, section, clientId) {
  return `crest_cache_${page}_${section}_${clientId}`
}

export function readPageCache(page, section, clientId) {
  if (!clientId) return null
  try {
    const raw = sessionStorage.getItem(cacheKey(page, section, clientId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > MAX_AGE_MS) return null
    return parsed.value
  } catch {
    return null
  }
}

export function writePageCache(page, section, clientId, value) {
  if (!clientId) return
  try {
    sessionStorage.setItem(cacheKey(page, section, clientId), JSON.stringify({ value, savedAt: Date.now() }))
  } catch {
    // sessionStorage can throw (private browsing, quota) — caching is a nice-to-have, never fatal
  }
}
