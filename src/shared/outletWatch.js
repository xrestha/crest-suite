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
// login's outlet list (an admin moved the login to another client entirely).
export function outletMovedText(name) {
  const where = name ? `This window now shows ${name}` : 'This window now shows another outlet'
  return `${where}: your account changed outlet in another window or on another device. ` +
    'The page you had open was closed, and anything typed there but not saved was not kept.'
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
