// Has this login changed outlet somewhere else since this window rendered? (S798 GAP-OUTLETS-2)
//
// A grouped login holds ONE selected outlet, `profiles.active_client_id`, and my_client_id()
// resolves every RLS policy through it. Switching on the phone therefore moves every request the
// laptop sends, while the laptop's pages still filter by the outlet they rendered: every scoped read
// comes back empty with no error and an update by id touches nothing. A revoke from Outlet Access
// does the same, since set_outlet_access() clears the column and tells no open window.
//
// AuthContext asks on three triggers: a window waking (sessionKeepAlive's afterRefresh), a page
// change inside the app (Layout), and a switch announced by another tab of this browser (below).

// The outlet the account is working in now, from a fresh profiles row: my_client_id()'s own rule.
export function accountOutlet(row) {
  return row?.active_client_id || row?.client_id || null
}

// True only when both sides are known and differ. An unreadable row or a window with no outlet yet
// is not evidence of a move.
export function outletMovedElsewhere(renderedClientId, freshRow) {
  const now = accountOutlet(freshRow)
  if (!renderedClientId || !now) return false
  return now !== renderedClientId
}

// What the window says after it has moved itself. `name` is null when the outlet is not in this
// login's outlet list (an admin moved the login to another client entirely). `cartKeptAt` names the
// outlet whose till kept an order not yet sent (S809 GAP-OUTLETS-1): the order screen keeps it the
// way a till lock does, so the sentence must not say it was lost.
export function outletMovedText(name, { cartKeptAt } = {}) {
  const where = name ? `This window now shows ${name}` : 'This window now shows another outlet'
  const lost = cartKeptAt
    ? `The till order you had not sent is kept, and comes back when you open Orders at ${cartKeptAt} again. Anything else typed there but not saved was not kept.`
    : 'Anything typed there but not saved was not kept.'
  return `${where}: your account changed outlet in another window or on another device. ` +
    `The page you had open was closed. ${lost}`
}

// A window that did NOT follow its login, because it holds offline changes for the outlet it shows
// (S809 GAP-OUTLETS-1). Those changes can only be sent while the login is on that outlet, so moving
// the window would replay them under the other one. `here` is the outlet this window shows, `there`
// where the login is now (null when it is not in this login's outlet list).
export function outletHeldText({ here, there, pending }) {
  const n = Number(pending) || 0
  const changes = `${n} change${n === 1 ? '' : 's'}`
  const away = there ? `to ${there} ` : ''
  const at = here || 'this outlet'
  return `Your account moved ${away}in another window or on another device, but this window still holds ` +
    `${changes} made offline at ${at} that ${n === 1 ? 'has' : 'have'} not reached the server. They can only be sent from ${at}, ` +
    `so this window stays there, and nothing on it can load or save until your account is back on ${at}.`
}

// Another tab of this browser switched outlet. The message carries no outlet: a receiver re-reads
// its own profile row, so nothing a tab posts is trusted. The tab id stops a tab answering its own
// announcement (a second BroadcastChannel object in the same tab does receive it).
const CHANNEL = 'crest-outlet'
const TAB_ID = Math.random().toString(36).slice(2)

function openChannel() {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL)
  } catch {
    return null
  }
}

export function announceOutletSwitch(userId) {
  const ch = openChannel()
  if (!ch || !userId) return
  try { ch.postMessage({ type: 'outlet-switched', userId, tab: TAB_ID }) } catch { /* best effort */ }
  ch.close()
}

// Returns an unsubscribe function. A no-op where BroadcastChannel does not exist; the wake and
// page-change triggers still catch the move there.
export function listenForOutletSwitch(userId, onSwitch) {
  const ch = openChannel()
  if (!ch || !userId) return () => {}
  ch.onmessage = e => {
    const m = e?.data
    if (m?.type === 'outlet-switched' && m.userId === userId && m.tab !== TAB_ID) onSwitch()
  }
  return () => ch.close()
}
