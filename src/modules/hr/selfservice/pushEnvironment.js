import { isIos, isStandalone } from '../../../utils/deviceEnv'

// What can this device actually DO about notifications, and what should we therefore say?
//
// The portal used to render a permanent "🔔 Enable Notifications" button in its header and hide it
// the moment `isPushSubscribed()` returned true — which only ever asked the browser whether *a*
// subscription existed, never whether it belonged to this employee. On a shared phone that reads
// as "notifications are already on" for someone who has never subscribed. And on an iPhone opened
// from a chat app the button was there to be tapped, only to throw an add-to-Home-Screen
// instruction after the tap rather than before it.
//
// Capability-first, NOT user-agent sniffing. That is deliberate: on iOS an in-app browser
// (WhatsApp, Instagram, any WKWebView) reports a perfectly ordinary Safari user-agent, so a UA
// test cannot tell them apart — but neither one can receive Web Push, and both need the same
// answer: open in Safari, add to the Home Screen. The Push API is only ever exposed to a Home
// Screen web app on iOS; a tab has no PushManager at all. Checking what the browser HAS gets both
// cases right without guessing at strings.

// Re-exported so callers (and the tests) have one place to ask about push, while the detection
// itself stays dependency-free in utils/ where webPush.js can use it too.
export { isIos, isStandalone }

export const PUSH = {
  /** Already subscribed on this device, as this employee. */
  ENABLED: 'enabled',
  /** Can prompt for permission right now. */
  READY: 'ready',
  /** iOS, running as a tab: must be added to the Home Screen first. */
  NEEDS_INSTALL: 'needs_install',
  /** The user said no. Only they can undo this, in browser settings. */
  DENIED: 'denied',
  /** No service worker / no PushManager / no VAPID key — nothing to offer. */
  UNSUPPORTED: 'unsupported',
}

/**
 * Pure, so every device/permission combination is testable without a browser.
 * `read()` below supplies the real values.
 */
export function pushState({ ios, standalone, hasServiceWorker, hasPushManager, permission, subscribed, configured }) {
  if (subscribed) return PUSH.ENABLED
  // Checked before capability: on iOS a tab genuinely has no PushManager, and reporting that as
  // "your browser doesn't support notifications" would be both wrong and a dead end. The same
  // device supports them perfectly well once installed.
  if (ios && !standalone) return PUSH.NEEDS_INSTALL
  if (!hasServiceWorker || !hasPushManager) return PUSH.UNSUPPORTED
  // No VAPID key in the build means the server side was never provisioned. Surfaced as
  // unsupported rather than offering a button that would throw on tap.
  if (!configured) return PUSH.UNSUPPORTED
  if (permission === 'denied') return PUSH.DENIED
  return PUSH.READY
}

/** The live state for this device. */
export function read({ subscribed = false } = {}) {
  const hasNotification = typeof window !== 'undefined' && 'Notification' in window
  return pushState({
    ios: isIos(),
    standalone: isStandalone(),
    hasServiceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    hasPushManager: typeof window !== 'undefined' && 'PushManager' in window,
    permission: hasNotification ? window.Notification.permission : 'default',
    subscribed,
    configured: !!process.env.REACT_APP_VAPID_PUBLIC_KEY,
  })
}

/**
 * What to show the employee. Never claims something is on when it isn't, and only ENABLED and
 * READY get a button — a control that cannot work is what made the old version dishonest.
 */
export const PUSH_COPY = {
  [PUSH.ENABLED]: {
    title: 'Notifications are on',
    body: 'You will be told when your roster is published, and when a colleague asks to swap a shift.',
  },
  [PUSH.READY]: {
    title: 'Turn on notifications',
    body: 'Get told when your roster is published, and when a colleague asks to swap a shift.',
  },
  [PUSH.NEEDS_INSTALL]: {
    title: 'Add Crest Staff to your Home Screen first',
    body: 'On iPhone, notifications only work from the installed app. If you opened this from a '
      + 'chat, tap the share icon and choose "Open in Safari" first — then Share → Add to Home '
      + 'Screen, and open it from that icon.',
  },
  [PUSH.DENIED]: {
    title: 'Notifications are blocked',
    body: 'Notifications were turned off for this app. Allow them again in your browser or phone '
      + 'settings, then come back here.',
  },
  [PUSH.UNSUPPORTED]: {
    title: 'Notifications are not available',
    body: 'This device or browser cannot receive them yet.',
  },
}
