import { normalizeReservationSettings, durationFor, DEFAULT_RESERVATION_SETTINGS } from './reservationSettings'

test('a missing or partial jsonb comes back complete, with every number clamped', () => {
  expect(normalizeReservationSettings(null)).toEqual(DEFAULT_RESERVATION_SETTINGS)
  const s = normalizeReservationSettings({ duration_by_band: { '1-2': '5', '7+': 9999 }, arrival_grace_minutes: -4, max_party_online: '200' })
  expect(s.duration_by_band).toEqual({ '1-2': 15, '3-4': 90, '5-6': 105, '7+': 720 })
  expect(s.arrival_grace_minutes).toBe(0)
  expect(s.max_party_online).toBe(99)
  expect(s.public_booking_enabled).toBe(false)
})

test('the availability rules are de-duplicated, sorted, and closed wins over walk-in', () => {
  const s = normalizeReservationSettings({
    closed_weekdays: [6, '6', 9, -1, 0],
    walk_in_weekdays: [6, 5, 5],
    closed_dates: ['2026-10-01', 'nope', '2026-09-30', '2026-10-01'],
    page_notice: '  Walk-ins only on Saturdays  ',
  })
  expect(s.closed_weekdays).toEqual([0, 6])
  expect(s.walk_in_weekdays).toEqual([5])
  expect(s.closed_dates).toEqual(['2026-09-30', '2026-10-01'])
  expect(s.page_notice).toBe('Walk-ins only on Saturdays')
})

test('durationFor reads the band for the party size', () => {
  const s = normalizeReservationSettings({ duration_by_band: { '3-4': 100 } })
  expect(durationFor(4, s)).toBe(100)
  expect(durationFor(1, s)).toBe(60)
  expect(durationFor(12, s)).toBe(120)
})
