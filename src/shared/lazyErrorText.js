// The error sentences, for the screens on the main file (S876, PERF-8).
//
// errorText.js is one table of ~178 KB, and it used to ride in the main file every page waits for,
// because three eager screens imported it: SettingsContext (a failed settings save), TillOutletGate
// (a failed switch back to the till's outlet) and LegalReacceptance (a failed acceptance). Each needs
// a sentence only after something has failed, so they fetch the table here at that moment instead.
// Every other caller keeps its ordinary import: those pages are lazy chunks already.
//
// Layout prefetches the table once the browser is idle after sign-in, so the service worker holds it
// long before any failure needs it. If it still cannot be fetched (offline on a device that never
// downloaded it), the caller gets UNAVAILABLE_TEXT below with the technical detail kept beside it:
// it names the consequence and, like every sentence in the table, never claims the write did not land.

export const UNAVAILABLE_TEXT = 'That did not work, and the explanation could not be loaded on this connection. Check your internet, then check whether it went through before trying again.'

// The same `code · message` errorInfo builds, so the fine print reads the same either way.
function detailOf(err) {
  if (!err) return ''
  const e = typeof err === 'string' ? { message: err } : err
  return [e.code, e.message].filter(Boolean).join(' · ')
}

export const loadErrorText = () => import('./errorText')

/** errorInfo's `{ text, detail }`, fetched on demand. Never rejects. */
export async function errorInfoLater(err, audience = 'operator') {
  try {
    const { errorInfo } = await loadErrorText()
    return errorInfo(err, audience)
  } catch (_) {
    return { text: UNAVAILABLE_TEXT, detail: detailOf(err) }
  }
}

/** errorLine's one string (`text (detail)`), fetched on demand. Never rejects. */
export async function errorLineLater(err, audience = 'operator') {
  const { text, detail } = await errorInfoLater(err, audience)
  return detail ? `${text} (${detail})` : text
}

/** Fetches the table ahead of need. The catch is load-bearing: an unhandled rejection from a failed
 *  import() is what chunkReload.js answers with a page reload. */
export function prefetchErrorText() {
  loadErrorText().catch(() => {})
}
