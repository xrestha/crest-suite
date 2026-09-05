import {
  STATUSES, LIVE_STATUSES, FLOOR_STATUSES, TRANSITIONS, canTransition, stampFor, canRevive,
  isDue, isLate, waitingMinutes, windowOf, tableIdsOf, CANCEL_REASONS, DECLINE_REASONS,
} from './reservationStatus'

test('every status has a transition entry; completed is terminal, no-show and cancelled reverse one step', () => {
  for (const s of STATUSES) expect(Array.isArray(TRANSITIONS[s])).toBe(true)
  expect(TRANSITIONS.completed).toEqual([])
  // S681: the two reversals, and nothing else — a no-show never jumps to seated or completed.
  expect(TRANSITIONS.no_show).toEqual(['arrived'])
  expect(TRANSITIONS.cancelled).toEqual(['booked'])
})

test('the full transition table', () => {
  const allowed = [
    ['requested', 'confirmed'], ['requested', 'cancelled'],
    ['booked', 'confirmed'], ['booked', 'arrived'], ['booked', 'seated'], ['booked', 'completed'], ['booked', 'no_show'], ['booked', 'cancelled'],
    ['confirmed', 'arrived'], ['confirmed', 'seated'], ['confirmed', 'completed'], ['confirmed', 'no_show'], ['confirmed', 'cancelled'],
    ['arrived', 'seated'], ['arrived', 'completed'], ['arrived', 'no_show'], ['arrived', 'cancelled'],
    ['seated', 'completed'],
    ['no_show', 'arrived'], ['cancelled', 'booked'],
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

test('stampFor clears the mark a reversal leaves, and only for the two reversals', () => {
  const now = '2026-09-04T14:00:00.000Z'
  expect(stampFor('arrived', now, 'no_show')).toEqual({ status: 'arrived', arrived_at: now, no_show_at: null })
  expect(stampFor('booked', now, 'cancelled')).toEqual({ status: 'booked', cancelled_at: null, cancel_reason: null })
  // A forward move passing its origin clears nothing — the two-argument shape PosOrders uses.
  expect(stampFor('confirmed', now, 'booked')).toEqual({ status: 'confirmed', confirmed_at: now })
  expect(stampFor('seated', now)).toEqual({ status: 'seated', seated_at: now })
})

test('canRevive is true only for a terminal row on its own Nepal civil day', () => {
  // 13:45Z is 19:30 in Kathmandu on 4 Sep; 18:30Z is 00:15 on 5 Sep.
  const r = { status: 'no_show', reserved_for: '2026-09-04T13:45:00.000Z' }
  expect(canRevive(r, new Date('2026-09-04T17:00:00.000Z').getTime())).toBe(true)   // 22:45 same day
  expect(canRevive(r, new Date('2026-09-04T18:30:00.000Z').getTime())).toBe(false)  // past Nepal midnight
  expect(canRevive(r, new Date('2026-09-03T10:00:00.000Z').getTime())).toBe(false)  // the day before
  expect(canRevive({ ...r, status: 'cancelled' }, new Date('2026-09-04T17:00:00.000Z').getTime())).toBe(true)
  expect(canRevive({ ...r, status: 'completed' }, new Date('2026-09-04T17:00:00.000Z').getTime())).toBe(false)
  expect(canRevive({ ...r, status: 'confirmed' }, new Date('2026-09-04T17:00:00.000Z').getTime())).toBe(false)
})

test('waitingMinutes counts from arrived_at for arrived rows only', () => {
  const at = '2026-09-04T14:00:00.000Z'
  expect(waitingMinutes({ status: 'arrived', arrived_at: at }, new Date('2026-09-04T14:25:30.000Z').getTime())).toBe(25)
  expect(waitingMinutes({ status: 'arrived', arrived_at: null }, Date.now())).toBeNull()
  expect(waitingMinutes({ status: 'booked', arrived_at: at }, Date.now())).toBeNull()
  expect(waitingMinutes({ status: 'arrived', arrived_at: at }, new Date('2026-09-04T13:59:00.000Z').getTime())).toBe(0)
})

test('decline reasons are a separate list from cancel reasons, and every one is true from the guest side', () => {
  expect(DECLINE_REASONS.length).toBeGreaterThan(1)
  for (const r of DECLINE_REASONS) expect(CANCEL_REASONS.includes(r) && r !== 'Other').toBe(false)
  expect(DECLINE_REASONS).not.toContain('Guest cancelled')
  expect(DECLINE_REASONS).not.toContain('Could not reach the guest')
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
