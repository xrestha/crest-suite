import { useSyncExternalStore } from 'react'

// What the till screen tells the app-wide guest-order alert, and the one Mute every guest-order
// alert on this device obeys (S809 3c).
//
// The alert lives in the app shell (Layout.js + useGuestOrderAlerts) because a guest's QR order has
// to be heard from any page (S763). Two things it needs to know live only inside the till screen
// (PosOrders.jsx), which publishes them here:
//
//   * Which view is up. The floor has its own guest-order banner and glowing tables, so the shell's
//     banner stands aside there (the sound does not). The order screen shows only the table on
//     screen, so there the shell's banner is the one that says ANOTHER table is waiting
//     (FLOOR-KITCHEN-1). It used to be off on the whole of /pos/orders, the order screen included.
//   * Which waiting orders this till already holds. Accept puts a guest's dishes in the cart, and the
//     request stays "waiting" in the database until the order is saved, so a till that walks away
//     without saving leaves it waiting, accurately. The shell's poll read it as unanswered and kept
//     ringing on the very till that had just accepted it (S809.4).
//
// The Mute is shared for the same reason the alert is app-wide: one press silences the floor, the
// order screen and the PIN screen of this device, rather than each starting the alarm again.

// Muting silences the sound. It deliberately does NOT hide any banner: the order is still waiting,
// and a control that makes the evidence disappear is how this gets missed a second time (S763).
export const GUEST_ALERT_MUTE_MS = 300000

let tillView = null
let muteState = { until: 0, on: false }
let muteTimer = null
const listeners = new Set()

function emit() { for (const l of listeners) l() }
function subscribe(l) { listeners.add(l); return () => { listeners.delete(l) } }

const sigOf = v => (v ? `${v.view}|${v.openTableId || ''}|${[...v.heldIds].sort().join(',')}` : '')

/**
 * Called by the till screen after every render; a call that changes nothing notifies nobody.
 * `view` is 'floor' | 'order' | 'bills'; `openTableId` the table on the order screen (null on a
 * takeaway or another view); `heldIds` the waiting guest-order ids this till holds.
 */
export function publishTillGuestView({ view, openTableId = null, heldIds = [] }) {
  const next = { view, openTableId: openTableId || null, heldIds: new Set(heldIds) }
  if (sigOf(next) === sigOf(tillView)) return
  tillView = next
  emit()
}

/** Called when the till screen unmounts: no till view, nothing held. */
export function clearTillGuestView() {
  if (!tillView) return
  tillView = null
  emit()
}

/** The till screen's last published view, or null when no till screen is mounted. */
export function useTillGuestView() {
  return useSyncExternalStore(subscribe, () => tillView, () => null)
}

export function muteGuestAlerts(ms = GUEST_ALERT_MUTE_MS) {
  const until = Date.now() + ms
  muteState = { until, on: true }
  clearTimeout(muteTimer)
  // A timer, so a screen that shows "Muted" flips back without waiting for something else to render.
  muteTimer = setTimeout(() => { muteState = { until, on: false }; emit() }, ms)
  emit()
}

const muteNow = () => muteGuestAlerts()

/** `{ muted, mutedUntil, mute }`, shared by every guest-order alert on this device. */
export function useGuestAlertMute() {
  const state = useSyncExternalStore(subscribe, () => muteState, () => muteState)
  return { muted: state.on, mutedUntil: state.until, mute: muteNow }
}

/** Tests only. */
export function resetGuestAlertBridge() {
  tillView = null
  muteState = { until: 0, on: false }
  clearTimeout(muteTimer)
  muteTimer = null
  emit()
}

/**
 * What the shell's guest-order alert does on this screen. `requests` are the waiting orders this
 * till does not hold (useGuestOrderAlerts has already dropped the held ones); `till` is the till
 * screen's published view, or null.
 *
 * `where` picks the banner's sentence and whether it carries Open Orders:
 *   'shell'        any other page, the Billing list, or a bill on the Billing station: Open Orders.
 *   'order-screen' the order screen on /pos/orders, another table waiting: Open Orders would only
 *                  reopen the screen the waiter is on, so the banner says how to get there instead.
 *   'this-table'   every waiting order is the table on screen, whose own strip has Accept.
 */
export function shellGuestAlertPlan({ pathname, till, requests }) {
  // The kitchen cannot accept a guest order, and a kitchen-team login cannot even reach Orders; the
  // board raises its own alert for what the kitchen can act on (S763).
  if (pathname === '/pos/kds' || !requests || requests.length === 0) {
    return { sound: false, banner: false, where: 'shell' }
  }
  const onTill = !!till && (pathname === '/pos/orders' || pathname === '/pos/billing')
  const floor = onTill && pathname === '/pos/orders' && till.view === 'floor'
  const orderScreen = onTill && till.view === 'order'
  const allOnScreen = orderScreen && !!till.openTableId && requests.every(r => r.tableId === till.openTableId)
  return {
    sound: true,
    banner: !floor,
    where: allOnScreen ? 'this-table' : (orderScreen && pathname === '/pos/orders') ? 'order-screen' : 'shell',
  }
}

/** "New guest order — Table 7", or "2 new guest orders — Table 7, Table 3". */
export function guestAlertTitle(requests) {
  const list = requests || []
  const tables = [...new Set(list.map(r => r.tableName || 'a table'))]
  return list.length === 1
    ? `New guest order — ${tables[0]}`
    : `${list.length} new guest orders — ${tables.join(', ')}`
}

const HOW = {
  shell: 'Nothing reaches the kitchen until a staff member accepts it.',
  'order-screen': 'Nothing reaches the kitchen until it is accepted: go back to the floor (← at the top left) and tap the table.',
  'this-table': 'It is for the table on this screen: Accept or Dismiss it just below the top bar.',
  pin: 'Nothing reaches the kitchen until a staff member signs in and accepts it.',
}

/**
 * The banner's second line. `soundOff` adds the browser's audio block: a tablet that reloaded (a
 * new release, a power cut) plays nothing until someone touches the screen.
 */
export function guestAlertDetail({ waitedMs = 0, where = 'shell', soundOff = false } = {}) {
  const mins = Math.floor(Math.max(0, waitedMs) / 60000)
  const wait = mins < 1 ? 'Just in.' : `Waiting ${mins} min.`
  const sound = soundOff ? ' The sound is off on this tablet until someone taps the screen.' : ''
  return `${wait} ${HOW[where] || HOW.shell}${sound}`
}
