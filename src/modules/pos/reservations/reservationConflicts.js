import { LIVE_STATUSES, windowOf, tableIdsOf } from './reservationStatus'
import { nepalTime, nepalBs } from '../../../shared/nepalTime'
import { BS_MONTHS } from '../../../utils/bsCalendar'

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

/**
 * The database half of the rule (S755, migration 20260917100000): guard_pos_reservation_table_hold
 * refuses a table link, a window move or a revival that overlaps another live booking on the same
 * table, under a per-table lock — so the same-second save this page's fresh read cannot see is
 * refused there, with HINT 'table_hold_overlap' and the other booking as JSON in DETAIL.
 *
 * Returns `{ text, detail }` worded the way this page words its own conflicts (the page's clock and
 * BS calendar, not the server's), or null when `err` is not that refusal. A DETAIL that did not
 * survive the trip still gets a sentence, just without the other booking's name.
 */
export function describeHoldRefusal(err) {
  if (!err) return null
  const isHold = err.hint === 'table_hold_overlap' || /(^|[^a-z_])table_hold_overlap([^a-z_]|$)/i.test(err.message || '')
  if (!isHold) return null
  let d = null
  try { d = typeof err.details === 'string' ? JSON.parse(err.details) : (err.details && typeof err.details === 'object' ? err.details : null) } catch { d = null }
  const detail = [err.code, err.message].filter(Boolean).join(' · ')
  if (!d || !d.reserved_for) {
    return { text: 'One of these tables was booked on another device a moment ago for an overlapping time, so it cannot be held for this booking too. Refresh the list, then pick another table or change the time.', detail }
  }
  const bs = nepalBs(d.reserved_for)
  const day = bs ? ` on ${bs.day} ${BS_MONTHS[bs.month - 1]}` : ''
  const who = d.customer_name ? `${d.customer_name}${d.party_size ? ` ×${d.party_size}` : ''}` : 'another booking'
  return {
    text: `${d.table_name || 'A selected table'} is already held for ${who} at ${nepalTime(d.reserved_for)}${day} — booked on another device a moment ago. Pick another table or change the time.`,
    detail,
  }
}
