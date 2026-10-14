// A guest QR order nobody answers is turned away after 30 minutes (S834, owner decision D34).
//
// The database turns it away (pos_turn_away_stale_guest_orders, migration 20261014100000) when the
// guest's phone, a new guest order, the PIN screen or a till next asks. Until one of them does, the
// row may still read 'pending', so every screen that lists waiting guest orders leaves such a row out
// itself, and a till that sees one asks the server to turn it away (turn_away_stale_guest_orders).
// GUEST_ORDER_STALE_MS is the JS twin of pos_guest_order_stale_after(): change the two together
// (guestOrderStale.test.js reads the migration).

export const GUEST_ORDER_STALE_MS = 30 * 60 * 1000

/** Whether a waiting guest order sent at `createdAt` has waited past the limit. */
export function isStaleGuestOrder(createdAt, now = Date.now()) {
  if (!createdAt) return false // new Date(null) is 1970, which would read as past any limit
  const t = new Date(createdAt).getTime()
  return Number.isFinite(t) && now - t >= GUEST_ORDER_STALE_MS
}

/** The ISO instant before which a waiting guest order is past the limit, for a `.gt('created_at', …)`. */
export function staleGuestOrderCutoffIso(now = Date.now()) {
  return new Date(now - GUEST_ORDER_STALE_MS).toISOString()
}

/** Whether a turned-away order was turned away because nobody answered it in time: decided at least
 *  the limit after the guest sent it (a staff turn-away or a bill closing comes sooner). `sentAt` is
 *  the guest page's own clock, so a minute's slack covers a phone running fast. */
export function turnedAwayUnanswered(sentAt, decidedAt) {
  // An order stored before S834 carries no sentAt; new Date(null) is 1970 and would read as unanswered.
  if (!sentAt || !decidedAt) return false
  const sent = new Date(sentAt).getTime()
  const decided = new Date(decidedAt).getTime()
  if (!Number.isFinite(sent) || !Number.isFinite(decided)) return false
  return decided - sent >= GUEST_ORDER_STALE_MS - 60 * 1000
}
