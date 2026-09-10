// A dynamic import that fails to load is almost never a bug in the code that asked for it. It is
// a DEPLOY (S731).
//
// Every page component in App.js is `React.lazy(() => import(...))` and `xlsx` is `await
// import('xlsx')` inside 43 click handlers, so the app fetches its own code on demand, by hashed
// filename, from an index.html that was served before the deploy. Vercel replaces the deployment's
// files, so those hashes 404; the service worker's `activate` deletes every non-current cache on
// the same event, so the copy that WAS cached goes too. An open tab therefore loses the ability to
// load its own routes the moment a deploy lands, and nothing about that is visible until the next
// navigation or Export click.
//
// The two halves land in different places, which is why this lives in its own module rather than
// inside the error boundary:
//   * a lazy ROUTE rejects during render, so React surfaces it as an error and AppErrorBoundary
//     catches it;
//   * an `import('xlsx')` inside an onClick is thrown from an event handler, which that boundary
//     structurally CANNOT catch — the rejection is unhandled and the button just does nothing.
//     src/index.js listens for `unhandledrejection` to cover exactly that.
//
// Reloading is the fix because index.html is served `no-cache` (vercel.json) and the SW's
// navigation branch is network-first: the reload gets the new document, the new hashes, and a
// working app. It is not a workaround for a broken build.

const RELOAD_KEY = 'crest_chunk_reload_at'
// One reload per minute at most. Without this, an error that ISN'T a stale deploy — a chunk that
// genuinely 500s, a proxy mangling one file — turns into a reload loop, which is a worse failure
// than the one being fixed and much harder to diagnose from a phone.
const RELOAD_WINDOW_MS = 60 * 1000

// Each bundler and browser words this differently, and the message is the only thing they agree to
// carry. webpack throws a real `ChunkLoadError`; Safari and Firefox report a native ESM failure.
const PATTERNS = [
  /chunkloaderror/i,
  /loading chunk \S+ failed/i,
  /loading css chunk/i,
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
]

/** True when the failure is "this build's code is no longer fetchable", not a fault in it. */
export function isChunkLoadError(err) {
  if (!err) return false
  if (err.name === 'ChunkLoadError') return true
  const text = `${err.name || ''} ${err.message || ''}`
  return PATTERNS.some(re => re.test(text))
}

/**
 * Reloads once if `err` is a stale-deploy chunk failure and a reload can plausibly help.
 * Returns true when a reload was started, so the caller knows not to also render a fallback.
 *
 * Deliberately does NOT reload while offline: the reload would be answered from the cached shell
 * and fail in exactly the same way, having spent the one attempt this allows. That case is a real
 * message instead — the screen has not been opened on this device since the last update, which is
 * a fact the reader can act on (reconnect) rather than an error.
 */
export function recoverFromChunkError(err) {
  if (!isChunkLoadError(err)) return false
  if (typeof window === 'undefined') return false
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false

  let last = 0
  try { last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0 } catch { /* private mode */ }
  if (Date.now() - last < RELOAD_WINDOW_MS) return false
  try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())) } catch { /* private mode */ }

  window.location.reload()
  return true
}

/**
 * The message for a chunk failure a reload could not fix, or could not be attempted for.
 * Two genuinely different states, and telling them apart is the whole point: one is waiting for a
 * signal, the other is waiting for a tap.
 */
export function chunkErrorMessage() {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  return offline
    ? 'This screen has not been opened on this device since the app was last updated, so it is not available offline. Reconnect and it will load — anything you have already saved is unaffected.'
    : 'The app was updated while this screen was open, so part of it could not be loaded. Reload to pick up the new version — anything you have already saved is unaffected.'
}

/** Wired from src/index.js. Catches the rejections no React boundary can see. */
export function initChunkReloadGuard() {
  if (typeof window === 'undefined') return
  window.addEventListener('unhandledrejection', e => { recoverFromChunkError(e?.reason) })
  // Safari reports a failed module script as a window `error` rather than a rejection.
  window.addEventListener('error', e => { recoverFromChunkError(e?.error) })
}
