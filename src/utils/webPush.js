import { supabase } from '../supabaseClient'

// Web Push subscribe helper for the HR Self-Service PWA. VAPID public key is safe to expose
// (that's the point of the keypair) — set as REACT_APP_VAPID_PUBLIC_KEY at build time.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

// iOS Safari never exposes the Push API to a page running as a regular browser tab — only to
// one that's been "Added to Home Screen" (installed as a standalone PWA). Without this check,
// every iPhone/iPad user hits the generic "not supported" message with no way forward, even
// though push genuinely does work on iOS 16.4+ once installed. `navigator.standalone` is the
// iOS-specific flag for this; `display-mode: standalone` is the cross-platform equivalent.
function isIosSafari() {
  return /iPad|iPhone|iPod/.test(window.navigator.userAgent) && !window.MSStream
}
function isStandalonePwa() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches
}

export async function subscribeToPush(profileId, clientId) {
  if (isIosSafari() && !isStandalonePwa()) {
    const err = new Error('On iPhone/iPad: tap the Share button, choose "Add to Home Screen", then open Crest from that icon and try again — notifications only work from the installed app, not a regular Safari tab.')
    err.code = 'ios_add_to_home_screen'
    throw err
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Push notifications are not supported on this device/browser.')
  }
  const vapidKey = process.env.REACT_APP_VAPID_PUBLIC_KEY
  if (!vapidKey) throw new Error('Push is not configured yet.')

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notification permission was not granted.')

  const registration = await navigator.serviceWorker.ready
  let subscription = await registration.pushManager.getSubscription()
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    })
  }

  const json = subscription.toJSON()
  const { error } = await supabase.from('push_subscriptions').upsert({
    profile_id: profileId,
    client_id: clientId,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
  }, { onConflict: 'endpoint' })
  if (error) throw error
}

export async function isPushSubscribed() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  return !!subscription
}
