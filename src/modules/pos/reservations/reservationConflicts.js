import { LIVE_STATUSES, windowOf, tableIdsOf } from './reservationStatus'

// S754 (owner decision): the same table may not be held for two bookings whose windows overlap.
//
// A booking's window is `windowOf()` — [reserved_for, reserved_for + duration_minutes) — the same
// window `isDue` and the capacity strip already read, so "overlap" here cannot come to mean
// something different from what the floor shows. Only bookings still in play count
// (LIVE_STATUSES): a cancelled, declined (stored as cancelled), no-show or completed booking no
// longer holds anything.
//
// Half-open on purpose: a 6:00–7:30 booking and a 7:30 booking on the same table do NOT clash — the
// second party sits down as the first one's turn ends, which is the whole point of a turn time.

/** Do two [start, end) millisecond windows intersect? Touching ends do not. */
export function windowsOverlap(a, b) {
  if (!a || !b) return false
  if (![a.start, a.end, b.start, b.end].every(Number.isFinite)) return false
  return a.start < b.end && b.start < a.end
}

/**
 * The live bookings that already hold one of `tableIds` during `candidate`'s window.
 *
 * `candidate` is `{ id?, reserved_for, duration_minutes }` — the booking being saved; its own id
 * (on an edit) is skipped so a booking never clashes with itself. `bookings` are rows carrying
 * `pos_reservation_tables` (the RESERVATION_SELECT embed). Returns `[{ tableId, booking }]`, one per
 * clashing table-and-booking pair, earliest booking first.
 */
export function findTableConflicts(candidate, tableIds, bookings) {
  const wanted = new Set(tableIds || [])
  if (wanted.size === 0 || !candidate) return []
  const win = windowOf(candidate)
  const out = []
  for (const b of bookings || []) {
    if (!b || (candidate.id && b.id === candidate.id)) continue
    if (!LIVE_STATUSES.includes(b.status)) continue
    if (!windowsOverlap(win, windowOf(b))) continue
    for (const tableId of tableIdsOf(b)) {
      if (wanted.has(tableId)) out.push({ tableId, booking: b })
    }
  }
  return out.sort((x, y) => new Date(x.booking.reserved_for) - new Date(y.booking.reserved_for))
}

/**
 * The widest window a stored booking can have — the duration field's own ceiling (720 min, the
 * validation in ReservationModal and normalizeReservationSettings). A fresh read for conflicts
 * must reach back this far before the candidate's start, or a long booking that began earlier and
 * is still running would be missed.
 */
export const MAX_DURATION_MINUTES = 720
