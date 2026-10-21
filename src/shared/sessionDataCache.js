// Shared short-lived per-tab cache so a page can show its last-known data instantly on
// revisit instead of a blank skeleton while it re-fetches from Supabase from scratch.
// sessionStorage (not localStorage) so nothing survives past this tab. That is NOT on its own
// enough to stop data lingering across a sign-out/sign-in: sessionStorage lives as long as the TAB,
// not the session, and two accounts of one client see different rows (the RESTRICTIVE
// staff-isolation policies), so a cache filled by one must never be read by the other.
//
// Since S849 (GAPS-7) the key carries the signed-in USER as well as the client, and nothing is read
// or written with no user known. AuthContext tells this file who is signed in (`setPageCacheUser`)
// wherever it learns the session — on load and on every auth event, so a sign-out in ANOTHER tab,
// a session that ends by itself, and a sign-in as someone else in this tab all re-key it — and on
// no session it calls `clearPageCache()`, which removes only this cache's own keys (the guest menu
// and booking pages keep their own sessionStorage state under the same provider and see that
// branch on every load). `signOut()` and `switchOutlet()` still clear sessionStorage as before.
// Deliberately dumb key-value storage of already-computed values — this file does no calculation
// of its own, so it carries none of the risk of touching a page's actual data/logic.
//
// `page` namespaces keys per page (e.g. 'dashboard', 'purchases') so two pages caching a
// section with the same name (e.g. both having an 'items' section) never collide.
const MAX_AGE_MS = 10 * 60 * 1000 // 10 minutes: long enough to help normal page-to-page
// navigation, short enough that stale data is never shown as if current.

const PREFIX = 'crest_cache_'

// Module-level: one signed-in user per tab. null = nobody known, which reads and writes nothing.
let cacheUserId = null

// In-memory caches that must be emptied with this one (the shared month list, `periodList.js`,
// S855). They register here rather than this file importing them, so it stays dumb storage.
const clearListeners = new Set()

/** Runs `fn` whenever the page cache is cleared or a different user is set. Returns an unsubscribe. */
export function onPageCacheClear(fn) {
  clearListeners.add(fn)
  return () => clearListeners.delete(fn)
}

function notifyClear() {
  clearListeners.forEach(fn => { try { fn() } catch (e) { console.error('page cache clear listener', e) } })
}

/** Who the cache belongs to. Called by AuthContext wherever it learns the session. */
export function setPageCacheUser(userId) {
  const next = userId || null
  // A different login in this tab must not read the last one's in-memory caches either.
  if (next !== cacheUserId) notifyClear()
  cacheUserId = next
}

/** Removes every page-cache entry in this tab and nothing else. */
export function clearPageCache() {
  notifyClear()
  try {
    const keys = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith(PREFIX)) keys.push(k)
    }
    keys.forEach(k => sessionStorage.removeItem(k))
  } catch {
    // sessionStorage can throw (private browsing) — nothing to clear then
  }
}

function cacheKey(page, section, clientId) {
  return `${PREFIX}${cacheUserId}_${page}_${section}_${clientId}`
}

export function readPageCache(page, section, clientId) {
  if (!clientId || !cacheUserId) return null
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
  if (!clientId || !cacheUserId) return
  try {
    sessionStorage.setItem(cacheKey(page, section, clientId), JSON.stringify({ value, savedAt: Date.now() }))
  } catch {
    // sessionStorage can throw (private browsing, quota) — caching is a nice-to-have, never fatal
  }
}
