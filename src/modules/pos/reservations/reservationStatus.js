// The reservation status ladder, and what each step may become.
//
// A booking is a promise about a future table, not a table state — see the migration
// (20260904200000) for why it is derived onto the floor rather than written into
// pos_tables.status. This file is the one place the legal moves are written down; the page,
// the floor and the tests all read it, and the database enforces only the two consequences that
// matter to other readers (seated ⇒ order_id, cancelled ⇒ reason).

import { nepalCivilDate } from '../../../shared/nepalTime'
import { formatAd } from '../../../utils/bsCalendar'

export const STATUSES = ['requested', 'booked', 'confirmed', 'arrived', 'seated', 'completed', 'no_show', 'cancelled']

// Still in play: anything that could yet turn into a seated party.
export const LIVE_STATUSES = ['requested', 'booked', 'confirmed', 'arrived', 'seated']
// What the floor plan shows on a tile: a party expected or waiting. A seated party's tile already
// shows its order, and a request is a staff decision on the Reservations page, not a table fact.
export const FLOOR_STATUSES = ['booked', 'confirmed', 'arrived']

export const STATUS_LABEL = {
  requested: 'Requested',
  booked:    'Booked',
  confirmed: 'Confirmed',
  arrived:   'Arrived',
  seated:    'Seated',
  completed: 'Completed',
  no_show:   'No-show',
  cancelled: 'Cancelled',
}

// 'completed' is reachable without passing through 'seated' on purpose: a party seated while the
// till was offline, or seated by hand at a table nobody tapped, never gets its order_id written
// (the seated ⇒ order_id CHECK would refuse the row), and the host still needs a way to say the
// visit happened. The Covers Report's booked-vs-walk-in split reads order_id, so such a booking
// counts as kept but contributes no covers — honest, rather than a no-show it was not.
//
// Two REVERSALS exist since S681, and only two. A no-show is recorded against a phone number and
// shown on every future booking form from it; a guest marked at 8:20 who walks in at 8:25 needs a
// way back, and "create a second booking and leave the mark" is not one. Likewise a booking
// cancelled by mistake. Both are allowed until the end of the booking's Nepal day by `canRevive()`
// on the page, the days before it included (S818, Q23 a); this table is about what is ever legal,
// not when. Completed stays terminal: it means the visit happened, and the bill that closed it is
// its own record.
export const TRANSITIONS = {
  requested: ['confirmed', 'cancelled'],
  booked:    ['confirmed', 'arrived', 'seated', 'completed', 'no_show', 'cancelled'],
  confirmed: ['arrived', 'seated', 'completed', 'no_show', 'cancelled'],
  arrived:   ['seated', 'completed', 'no_show', 'cancelled'],
  seated:    ['completed'],
  completed: [],
  no_show:   ['arrived'],
  cancelled: ['booked'],
}

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to)
}

const STAMP_COLUMN = {
  confirmed: 'confirmed_at',
  arrived:   'arrived_at',
  seated:    'seated_at',
  completed: 'completed_at',
  no_show:   'no_show_at',
  cancelled: 'cancelled_at',
}

// What a REVERSAL clears on the way out: the mark the row is leaving, so a customer's no-show
// count and the Covers Report forget it, and the cancel_has_reason CHECK is satisfied both ways.
const REVERSAL_CLEARS = {
  no_show:   { no_show_at: null },
  cancelled: { cancelled_at: null, cancel_reason: null },
}

/**
 * The UPDATE payload for moving to `status` — the status plus the timestamp that step owns. Pass
 * `from` when the move leaves a terminal state, so its mark is cleared in the same write; the
 * two-argument form is unchanged for every forward move (PosOrders calls it that way).
 */
export function stampFor(status, nowIso = new Date().toISOString(), from = null) {
  const col = STAMP_COLUMN[status]
  const base = col ? { status, [col]: nowIso } : { status }
  return from && REVERSAL_CLEARS[from] ? { ...base, ...REVERSAL_CLEARS[from] } : base
}

/**
 * May this terminal booking be revived right now? Until the end of its Nepal civil day: a no-show
 * undone a week later is a record being edited, not a guest turning up. Before the day it always
 * may (S818, RESERVATIONS-7, Q23 a): a booking cancelled by mistake on Monday for Saturday used to
 * wait for Saturday, its tables free for anyone in between, although the cancel dialog promised
 * "until the end of its day". False for anything that is not no_show or cancelled.
 */
export function canRevive(res, nowMs = Date.now()) {
  if (!REVERSAL_CLEARS[res?.status]) return false
  const a = nepalCivilDate(res.reserved_for)
  const b = nepalCivilDate(new Date(nowMs))
  // 'YYYY-MM-DD' strings order as the days do.
  return !!(a && b) && formatAd(b) <= formatAd(a)
}

/**
 * May this booking be marked a no-show right now? Only from its booked time (S818, D23): before it
 * the party is not late yet, and a guest who calls ahead to say they will not come is a Cancel. A
 * no-show pressed on next Saturday's booking showed on the guest's next booking form at once.
 */
export function canMarkNoShow(res, nowMs = Date.now()) {
  if (!canTransition(res?.status, 'no_show')) return false
  const at = new Date(res.reserved_for).getTime()
  return Number.isFinite(at) && nowMs >= at
}

/**
 * The widest window a stored booking can have: the duration field's ceiling (720 min, the
 * validation in ReservationModal and normalizeReservationSettings, and the table's CHECK). A read
 * that must see a booking still running must reach back this far before its own start.
 */
export const MAX_DURATION_MINUTES = 720

/**
 * The instant a "today" read starts from once it also carries the evening before (S818,
 * RESERVATIONS-8): today's start less the longest booking, so an 11:30 PM party still being seated
 * at 12:10 AM is read. `stillInPlay` then keeps only the ones not over yet.
 */
export function carryOverFrom(dayStartIso) {
  const t = new Date(dayStartIso).getTime()
  return Number.isFinite(t) ? new Date(t - MAX_DURATION_MINUTES * 60000).toISOString() : dayStartIso
}

/**
 * Does this booking belong on today's floor, tile or Upcoming list? Anything booked from today's
 * start does; one booked before it only while it is still live and its booked window has not
 * ended (D24). At midnight a late-evening booking still in play used to vanish from all three.
 */
export function stillInPlay(res, dayStartMs, nowMs = Date.now()) {
  const start = new Date(res.reserved_for).getTime()
  if (!Number.isFinite(start)) return false
  if (start >= dayStartMs) return true
  return LIVE_STATUSES.includes(res.status) && windowOf(res).end > nowMs
}

export const SOURCES = [
  { key: 'phone',     label: 'Phone' },
  { key: 'walk_in',   label: 'Walk-in' },
  { key: 'whatsapp',  label: 'WhatsApp' },
  { key: 'facebook',  label: 'Facebook' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'website',   label: 'Online (QR / link)' },
  { key: 'other',     label: 'Other' },
]
export const SOURCE_LABEL = Object.fromEntries(SOURCES.map(s => [s.key, s.label]))

export const CANCEL_REASONS = [
  'Guest cancelled',
  'Could not reach the guest',
  'Duplicate booking',
  'No table available',
  'Restaurant closed that day',
  'Other',
]

// A REQUEST is declined, not cancelled, and the reason is shown on the guest's phone — so it has
// to be true from where they stand. "Guest cancelled" shown to a guest who asked and was refused
// is not. Stored in the same cancel_reason column; the page picks the list by status.
// S818 (RESERVATIONS-9): the reason submit_reservation_request writes when it clears a phone's own
// request whose time passed unanswered. The same words are a decline reason staff can pick, and the
// guest's page shows them; `reservationStatus.test.js` holds the migration to this string.
export const EXPIRED_REQUEST_REASON = 'Not answered in time'

export const DECLINE_REASONS = [
  'No table at that time',
  'Closed that day',
  'Party too large for us',
  EXPIRED_REQUEST_REASON,
  'Other',
]

export const OCCASIONS = ['Birthday', 'Anniversary', 'Business', 'Family gathering', 'Date', 'Other']

// Every column the page and the floor read. pos_reservation_tables is embedded so one read
// carries the table assignment.
export const RESERVATION_SELECT =
  'id, customer_name, phone, party_size, reserved_for, duration_minutes, status, source, occasion, notes, ' +
  'cancel_reason, order_id, confirmed_at, arrived_at, seated_at, completed_at, no_show_at, cancelled_at, ' +
  'created_by, created_at, updated_at, pos_reservation_tables(id, table_id)'

/** Millisecond window a booking occupies: [reserved_for, reserved_for + duration). */
export function windowOf(res) {
  const start = new Date(res.reserved_for).getTime()
  const end = start + (Number(res.duration_minutes) || 90) * 60000
  return { start, end }
}

/**
 * Is this booking the one a host would seat if they tapped its table right now? True from
 * `seatWindowMinutes` before the booked time until the booked duration has elapsed. Only
 * bookings still expected count — a seated or completed one is already on its order.
 */
export function isDue(res, nowMs = Date.now(), seatWindowMinutes = 45) {
  if (!FLOOR_STATUSES.includes(res.status)) return false
  const { start, end } = windowOf(res)
  return nowMs >= start - seatWindowMinutes * 60000 && nowMs < end
}

/** Past the booked time by more than the grace period and nobody has marked them arrived. */
export function isLate(res, nowMs = Date.now(), graceMinutes = 20) {
  if (res.status !== 'booked' && res.status !== 'confirmed') return false
  return nowMs > new Date(res.reserved_for).getTime() + graceMinutes * 60000
}

/**
 * Whole minutes an ARRIVED party has been waiting for a table, or null for any other status (or
 * an arrived row with no stamp — pre-S677 data). `isLate` stops caring the moment a party is
 * marked arrived; this is the clock that starts then.
 */
export function waitingMinutes(res, nowMs = Date.now()) {
  if (res.status !== 'arrived' || !res.arrived_at) return null
  const t = new Date(res.arrived_at).getTime()
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((nowMs - t) / 60000))
}

/** The table ids a reservation holds, from the embedded join rows. */
export function tableIdsOf(res) {
  return (res.pos_reservation_tables || []).map(t => t.table_id).filter(Boolean)
}

/**
 * The booking a host seats by tapping this table on the floor, or null (S809 RESERVATIONS-2). The
 * floor tile's own order: a booking due now, then a party marked arrived whatever the clock says. A
 * party who waited past their booking's window, or came very early, is still the one standing there;
 * the tap used to give them the covers numpad, so the booking stayed Arrived for good.
 */
export function bookingToSeatOnTap(rows, tableId, nowMs = Date.now(), seatWindowMinutes = 45) {
  const onTable = (rows || []).filter(r => tableIdsOf(r).includes(tableId))
  return onTable.find(r => isDue(r, nowMs, seatWindowMinutes)) || onTable.find(r => r.status === 'arrived') || null
}
