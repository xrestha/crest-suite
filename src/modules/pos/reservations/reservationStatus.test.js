import {
  STATUSES, LIVE_STATUSES, FLOOR_STATUSES, TRANSITIONS, canTransition, stampFor,
  isDue, isLate, windowOf, tableIdsOf,
} from './reservationStatus'

test('every status has a transition entry, and terminal states go nowhere', () => {
  for (const s of STATUSES) expect(Array.isArray(TRANSITIONS[s])).toBe(true)
  expect(TRANSITIONS.completed).toEqual([])
  expect(TRANSITIONS.no_show).toEqual([])
  expect(TRANSITIONS.cancelled).toEqual([])
})

test('the full transition table', () => {
  const allowed = [
    ['requested', 'confirmed'], ['requested', 'cancelled'],
    ['booked', 'confirmed'], ['booked', 'arrived'], ['booked', 'seated'], ['booked', 'completed'], ['booked', 'no_show'], ['booked', 'cancelled'],
    ['confirmed', 'arrived'], ['confirmed', 'seated'], ['confirmed', 'completed'], ['confirmed', 'no_show'], ['confirmed', 'cancelled'],
    ['arrived', 'seated'], ['arrived', 'completed'], ['arrived', 'no_show'], ['arrived', 'cancelled'],
    ['seated', 'completed'],
  ]
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const expected = allowed.some(([f, t]) => f === from && t === to)
      expect([from, to, canTransition(from, to)]).toEqual([from, to, expected])
    }
  }
  // A request can never skip straight to seated — a human Accept comes first.
  expect(canTransition('requested', 'seated')).toBe(false)
  expect(canTransition('completed', 'seated')).toBe(false)
})

test('stampFor writes the timestamp the step owns, and only that one', () => {
  const now = '2026-09-04T14:00:00.000Z'
  expect(stampFor('confirmed', now)).toEqual({ status: 'confirmed', confirmed_at: now })
  expect(stampFor('arrived', now)).toEqual({ status: 'arrived', arrived_at: now })
  expect(stampFor('seated', now)).toEqual({ status: 'seated', seated_at: now })
  expect(stampFor('completed', now)).toEqual({ status: 'completed', completed_at: now })
  expect(stampFor('no_show', now)).toEqual({ status: 'no_show', no_show_at: now })
  expect(stampFor('cancelled', now)).toEqual({ status: 'cancelled', cancelled_at: now })
  expect(stampFor('booked', now)).toEqual({ status: 'booked' })
})

test('live and floor sets are subsets of the ladder', () => {
  for (const s of LIVE_STATUSES) expect(STATUSES).toContain(s)
  for (const s of FLOOR_STATUSES) expect(LIVE_STATUSES).toContain(s)
  expect(FLOOR_STATUSES).not.toContain('seated')
  expect(FLOOR_STATUSES).not.toContain('requested')
})

const res = (over = {}) => ({
  status: 'confirmed', reserved_for: '2026-09-04T13:45:00.000Z', duration_minutes: 90, ...over,
})
const T = iso => new Date(iso).getTime()

test('isDue opens the seat window before the booked time and closes when the duration elapses', () => {
  const r = res()
  expect(isDue(r, T('2026-09-04T12:59:00.000Z'), 45)).toBe(false)  // 46 min early
  expect(isDue(r, T('2026-09-04T13:00:00.000Z'), 45)).toBe(true)   // exactly 45 min early
  expect(isDue(r, T('2026-09-04T14:30:00.000Z'), 45)).toBe(true)   // mid-sitting
  expect(isDue(r, T('2026-09-04T15:14:59.000Z'), 45)).toBe(true)   // last second
  expect(isDue(r, T('2026-09-04T15:15:00.000Z'), 45)).toBe(false)  // duration over
  expect(isDue(res({ status: 'seated' }), T('2026-09-04T13:45:00.000Z'))).toBe(false)
  expect(isDue(res({ status: 'requested' }), T('2026-09-04T13:45:00.000Z'))).toBe(false)
})

test('isLate needs the grace period to pass and the party still unarrived', () => {
  const r = res({ status: 'booked' })
  expect(isLate(r, T('2026-09-04T14:04:59.000Z'), 20)).toBe(false)
  expect(isLate(r, T('2026-09-04T14:05:01.000Z'), 20)).toBe(true)
  expect(isLate(res({ status: 'arrived' }), T('2026-09-04T16:00:00.000Z'), 20)).toBe(false)
})

test('windowOf falls back to 90 minutes and tableIdsOf reads the embedded join', () => {
  const w = windowOf({ reserved_for: '2026-09-04T13:45:00.000Z', duration_minutes: null })
  expect(w.end - w.start).toBe(90 * 60000)
  expect(tableIdsOf({ pos_reservation_tables: [{ id: 'x', table_id: 't1' }, { id: 'y', table_id: 't2' }] })).toEqual(['t1', 't2'])
  expect(tableIdsOf({})).toEqual([])
})
