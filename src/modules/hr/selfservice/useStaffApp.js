import { useEffect, useState } from 'react'
import { canInstall, promptInstall, subscribeToInstallPrompt } from '../../../utils/installPrompt'

// Crest Staff is a second installable app served from the same origin as Crest Suite.
//
// An employee has no login for the admin app and should never see its icon on their phone, so the
// portal points the browser at its own manifest — different name, different icon, and a start_url
// that opens on their shifts rather than on IMS Stock Count. index.html can only carry one
// <link rel="manifest">, so the swap happens here, at runtime: both Chrome's install flow and
// iOS's Share → Add to Home Screen read the live DOM at the moment the user acts, not the HTML as
// it was served. The tags are restored on unmount so an admin who happens to open this route does
// not end up installing the staff app.
const STAFF = {
  manifest: '/staff.webmanifest',
  appleIcon: '/staff180.png',
  appleTitle: 'Crest Staff',
  themeColor: '#0f1117',
}

function setTag(selector, attr, value) {
  const el = document.head.querySelector(selector)
  if (!el) return null
  const previous = el.getAttribute(attr)
  el.setAttribute(attr, value)
  return () => el.setAttribute(attr, previous)
}

/**
 * Declares this page as Crest Staff rather than Crest Suite.
 *
 * Called once per portal page (Home and Login), at the top level — NOT from inside a dialog, or
 * the identity would only be correct while that dialog happened to be open.
 */
export function useStaffAppManifest() {
  useEffect(() => {
    const restores = [
      setTag('link[rel="manifest"]', 'href', STAFF.manifest),
      setTag('link[rel="apple-touch-icon"]', 'href', STAFF.appleIcon),
      setTag('meta[name="apple-mobile-web-app-title"]', 'content', STAFF.appleTitle),
      // The admin app's theme-color is the gold accent; on this surface the browser bar should
      // read as part of the app's own ground, which is what the manifest declares too.
      setTag('meta[name="theme-color"]', 'content', STAFF.themeColor),
    ].filter(Boolean)
    return () => restores.forEach(fn => fn())
  }, [])
}

/**
 * Whether the browser can install the app right now, and the call that asks it to.
 * `promptInstall()` resolves to 'accepted' | 'dismissed' | 'unavailable'.
 *
 * False forever on iOS, which has no programmatic install — there the portal shows the manual
 * Share → Add to Home Screen instruction instead.
 */
export function useInstallPrompt() {
  const [installable, setInstallable] = useState(canInstall)
  useEffect(() => subscribeToInstallPrompt(setInstallable), [])
  return { installable, promptInstall }
}
