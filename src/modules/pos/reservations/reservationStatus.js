// The reservation status ladder, and what each step may become.
//
// A booking is a promise about a future table, not a table state — see the migration
// (20260904200000) for why it is derived onto the floor rather than written into
// pos_tables.status. This file is the one place the legal moves are written down; the page,
// the floor and the tests all read it, and the database enforces only the two consequences that
// matter to other readers (seated ⇒ order_id, cancelled ⇒ reason).

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
export const TRANSITIONS = {
  requested: ['confirmed', 'cancelled'],
  booked:    ['confirmed', 'arrived', 'seated', 'completed', 'no_show', 'cancelled'],
  confirmed: ['arrived', 'seated', 'completed', 'no_show', 'cancelled'],
  arrived:   ['seated', 'completed', 'no_show', 'cancelled'],
  seated:    ['completed'],
  completed: [],
  no_show:   [],
  cancelled: [],
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

/** The UPDATE payload for moving to `status` — the status plus the timestamp that step owns. */
export function stampFor(status, nowIso = new Date().toISOString()) {
  const col = STAMP_COLUMN[status]
  return col ? { status, [col]: nowIso } : { status }
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

export const OCCASIONS = ['Birthday', 'Anniversary', 'Business', 'Family gathering', 'Date', 'Other']

// Every column the page and the floor read. pos_reservation_tables is embedded so one read
// carries the table assignment.
export const RESERVATION_SELECT =
  'id, customer_name, phone, party_size, reserved_for, duration_minutes, status, source, occasion, notes, ' +
  'cancel_reason, order_id, confirmed_at, arrived_at, seated_at, completed_at, no_show_at, cancelled_at, ' +
  'created_by, created_at, pos_reservation_tables(id, table_id)'

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

/** The table ids a reservation holds, from the embedded join rows. */
export function tableIdsOf(res) {
  return (res.pos_reservation_tables || []).map(t => t.table_id).filter(Boolean)
}
