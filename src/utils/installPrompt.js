// "Add to Home Screen", captured at boot rather than where it is offered.
//
// Chrome fires `beforeinstallprompt` once, early, and only if the page is installable at that
// moment — before the lazily-loaded self-service chunk has mounted anything. A listener attached
// inside the portal component would therefore miss it on most visits. So the event is caught in
// index.js at startup and parked here; the account sheet asks this module whether an install is
// available and, if it is, hands the stored event back to the browser on tap.
//
// iOS has no equivalent API at all — Safari offers only the manual Share → Add to Home Screen —
// so `canInstall()` is false there forever and the portal shows the instruction instead. That is
// also why this cannot be the only path to installing: it is an accelerator, not the mechanism.

let deferred = null
const listeners = new Set()

function emit() {
  for (const fn of listeners) fn(!!deferred)
}

export function initInstallPrompt() {
  if (typeof window === 'undefined') return
  window.addEventListener('beforeinstallprompt', e => {
    // Chrome's own mini-infobar is suppressed by preventDefault so the offer appears where it
    // makes sense — inside the account sheet, next to the notification setting it enables.
    e.preventDefault()
    deferred = e
    emit()
  })
  window.addEventListener('appinstalled', () => {
    // The stored event is single-use and now spent.
    deferred = null
    emit()
  })
}

export function canInstall() {
  return !!deferred
}

export function subscribeToInstallPrompt(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Returns 'accepted' | 'dismissed' | 'unavailable'. */
export async function promptInstall() {
  if (!deferred) return 'unavailable'
  const evt = deferred
  deferred = null
  emit()
  evt.prompt()
  const { outcome } = await evt.userChoice
  return outcome
}
