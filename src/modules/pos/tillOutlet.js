// A till stays with the outlet it was set up for (S809 GAP-OUTLETS-1 and ACCESS-4, owner decision
// Q24 (a)).
//
// A grouped login holds ONE selected outlet (profiles.active_client_id), and every RLS policy
// resolves through it. S798 decided that a window follows its login there, which is right for a
// dashboard and wrong for a till: the Owner opening the PKR branch on her phone moved BLOOM's counter
// tablet with her, and its next bill took PKR's invoice number, name and PAN on a printed tax invoice.
// The tablet knows which counter it stands at (`pos_device_client_id`, written when it was activated
// in Till Devices); the login does not. So on a bound tablet the till pages run only while the window
// shows the tablet's own outlet, and stop with a notice otherwise (TillOutletGate.jsx). A PIN login
// cannot leave its outlet at all: set_active_outlet refuses it (migration 20261009130000).
//
// The second stop is a window that is no till and kept its outlet because it holds offline changes
// for it while the login moved on (AuthContext's checkOutletStillCurrent): those changes can only be
// sent from that outlet, so the window waits for the login to come back rather than carry them
// across. A bound till needs no such hold: its till pages run in no other outlet, so its queue waits.

// The screens that bill, ticket or hold the drawer. Reports and setup screens are left to follow the
// login: they read the outlet they show, they do not print under it at a counter.
export const TILL_PATHS = ['/pos/orders', '/pos/billing', '/pos/shifts', '/pos/kds']

export function isTillPath(pathname) {
  const p = String(pathname || '')
  return TILL_PATHS.some(t => p === t || p.startsWith(`${t}/`))
}

// What this browser was activated as, read fresh each time (Pos.js writes and forgets it). Blocked
// storage reads as "not a till", which is what a browser with no activation is.
export function readTillDevice() {
  try {
    return {
      clientId: localStorage.getItem('pos_device_client_id') || null,
      clientName: localStorage.getItem('pos_device_client_name') || '',
    }
  } catch (_) {
    return { clientId: null, clientName: '' }
  }
}

/**
 * Why a till page must not run in this window, or null.
 *   'held' — this window stayed on its outlet because it holds offline changes, and the login is
 *            now somewhere else, so nothing here can load or save until the login comes back.
 *   'away' — this browser is a bound till, and the window now shows another outlet than the till's.
 * 'held' wins: it is the state in which even the till's own outlet cannot be reached.
 */
export function tillStop({ deviceClientId, clientId, held }) {
  if (held) return 'held'
  if (deviceClientId && clientId && clientId !== deviceClientId) return 'away'
  return null
}

/**
 * The outlet id to hand set_active_outlet for "take my login back to `targetId`". NULL is the RPC's
 * reset-to-home, open to every login. The home id itself is refused to any login that is not the
 * Owner, because Outlet Access never stores a row for a login's own outlet, so going home is always
 * sent as NULL.
 */
export function outletSwitchArg(targetId, homeClientId) {
  if (!targetId || targetId === homeClientId) return null
  return targetId
}
