import { supabase } from '../supabaseClient'
import { isIos, isStandalone } from './deviceEnv'

// Web Push subscribe/unsubscribe for the Crest Staff (HR Self-Service) app. The VAPID public key
// is safe to expose — that's the point of the keypair — and is set as REACT_APP_VAPID_PUBLIC_KEY
// at build time.
//
// The device checks live in deviceEnv.js so `pushEnvironment.js` can ask the same questions
// BEFORE offering a button, rather than this module answering them by throwing after the tap.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

export async function subscribeToPush(profileId, clientId) {
  // iOS Safari never exposes the Push API to a regular browser tab — only to a page added to the
  // Home Screen. Push genuinely works on iOS 16.4+ once installed, so this is an instruction, not
  // a refusal. `pushEnvironment` normally catches this first and shows the instruction instead of
  // a button; the throw stays as the backstop for any other caller.
  if (isIos() && !isStandalone()) {
    const err = new Error('On iPhone/iPad: tap the Share button, choose "Add to Home Screen", then open Crest Staff from that icon and try again — notifications only work from the installed app, not a Safari tab.')
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

/**
 * Turn notifications off for THIS device: drop the row the Edge Function fans out to, then
 * release the browser subscription. The row goes first — a subscription that survives with no row
 * simply receives nothing, while a row that survives with no subscription is a dead endpoint the
 * server keeps trying until a 404/410 prunes it.
 */
export async function unsubscribeFromPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) return

  const { endpoint } = subscription.toJSON()
  // RLS on push_subscriptions is `profile_id = auth.uid()`, so this can only ever delete our own.
  const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
  if (error) throw error
  await subscription.unsubscribe()
}

/**
 * Is THIS employee subscribed on this device?
 *
 * Asking the browser alone is not enough, and used to be all this did. A push subscription belongs
 * to the browser, not to the account: on a shared phone one employee's subscription made the next
 * one's portal report "notifications are on" for a subscription that fans out to somebody else.
 * The endpoint row is the thing the server actually sends to, so that is what gets asked — and
 * RLS means a row only comes back if it is ours.
 */
export async function isPushSubscribed() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) return false

  const { endpoint } = subscription.toJSON()
  const { data, error } = await supabase
    .from('push_subscriptions').select('id').eq('endpoint', endpoint).maybeSingle()
  // A failed read is not proof of anything, so it reads as "not subscribed" — which offers the
  // employee a button whose action is an idempotent upsert. Claiming it is on would be the one
  // answer with no way back.
  if (error) return false
  return !!data
}
