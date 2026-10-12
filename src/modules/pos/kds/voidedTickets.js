// A voided order's tickets on the Kitchen Display (S817 4i, FLOOR-KITCHEN-4; owner decision D18).
//
// They used to vanish the moment the bill was voided, mid-cook included, so a cook glancing back saw an
// empty column and plated the food from the paper ticket. The server now cancels a voided order's
// tickets in the void's own transaction and stamps `cancelled_at` (migration 20261012120000), and the
// board keeps each one up, struck through, in the column it was in, until a cook taps OK on that
// screen or VOID_VISIBLE_MS after this screen first saw it. A Served ticket is never cancelled by a
// void, so it never comes back here.

// How long a voided card stays up on a screen that has not tapped OK on it.
export const VOID_VISIBLE_MS = 10 * 60 * 1000
// How far back the board reads, by the tablet's clock. Wider than VOID_VISIBLE_MS so a tablet whose
// clock runs a little fast still sees a void; how long it SHOWS is counted by this screen (see below).
export const VOID_READ_WINDOW_MS = 15 * 60 * 1000

// The column a voided ticket was in when it was cancelled, worked out from the stage times the server
// stamped. A cancel keeps them, so a ticket that reached Ready still carries its ready time.
export function voidColumn(t) {
  if (t?.ready_at) return 'ready'
  if (t?.started_at) return 'in_progress'
  return 'new'
}

// The voided cards this screen still shows. `firstSeen` (id → ms) is when this screen first read each
// one, so the ten minutes never depend on the tablet's clock agreeing with the server's; `dismissed`
// holds the ids a cook tapped OK on here.
export function visibleVoids(voids, { firstSeen, dismissed, now, visibleMs = VOID_VISIBLE_MS }) {
  return (voids || []).filter(t => {
    if (dismissed?.has(t.id)) return false
    const seen = firstSeen?.get(t.id)
    return seen == null || now - seen < visibleMs
  })
}
