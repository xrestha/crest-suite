// Device/browser capability checks with no dependencies of their own.
//
// These live in utils/ rather than beside the self-service portal that uses them because
// webPush.js needs them too, and a util reaching up into src/modules/ inverts the dependency
// direction. Keeping them import-free also means the pure push-state tests never drag the
// Supabase client into jsdom.

export function isIos(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  if (/iPad|iPhone|iPod/.test(ua)) return true
  // iPadOS 13+ reports a Macintosh user-agent by default; the touch-point count is the standard
  // way to tell a real Mac from an iPad pretending to be one.
  return /Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1
}

/** True when the page is running as an installed app rather than a browser tab. */
export function isStandalone() {
  if (typeof window === 'undefined') return false
  // navigator.standalone is the iOS-specific flag; display-mode is the cross-platform equivalent.
  if (window.navigator?.standalone === true) return true
  try {
    return window.matchMedia?.('(display-mode: standalone)')?.matches === true
  } catch {
    return false
  }
}
