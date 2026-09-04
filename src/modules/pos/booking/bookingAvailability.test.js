import { loadMapFrom, hoursTouched, slotIsFull, dayFlags } from './bookingAvailability'

test('hoursTouched spans every hour a sitting occupies and stops at midnight', () => {
  expect(hoursTouched('19:30', 90)).toEqual([19, 20])   // 19:30–21:00
  expect(hoursTouched('19:00', 60)).toEqual([19])       // ends on the hour: no spill
  expect(hoursTouched('20:15', 60)).toEqual([20, 21])   // 20:15–21:15
  expect(hoursTouched('23:30', 120)).toEqual([23])      // past midnight is another date
  expect(hoursTouched('garbage', 60)).toEqual([])
})

test('slotIsFull compares booked covers plus the party against the room, hour by hour', () => {
  const load = loadMapFrom([
    { day: '2026-09-05', hour: 19, covers: 20 },
    { day: '2026-09-05', hour: 20, covers: 22 },
    { day: '2026-09-06', hour: 19, covers: 2 },
  ])
  const base = { dayIso: '2026-09-05', hm: '19:30', durationMinutes: 90, load, totalSeats: 24 }
  expect(slotIsFull({ ...base, party: 2 })).toBe(false)  // 20+2, 22+2 both fit
  expect(slotIsFull({ ...base, party: 3 })).toBe(true)   // 22+3 > 24 in the 20:00 hour
  expect(slotIsFull({ ...base, dayIso: '2026-09-06', party: 10 })).toBe(false)
  // No capacity set: never full — the host decides at Accept.
  expect(slotIsFull({ ...base, party: 50, totalSeats: 0 })).toBe(false)
})

test('dayFlags reads the weekly off, the listed dates and walk-in-only weekdays', () => {
  const page = { closed_weekdays: [6], closed_dates: ['2026-10-01'], walk_in_weekdays: [5, 6] }
  expect(dayFlags({ weekdayIdx: 6, iso: '2026-09-05' }, page)).toEqual({ closed: true, walkIn: false })   // Saturday: closed wins
  expect(dayFlags({ weekdayIdx: 5, iso: '2026-09-04' }, page)).toEqual({ closed: false, walkIn: true })
  expect(dayFlags({ weekdayIdx: 4, iso: '2026-10-01' }, page)).toEqual({ closed: true, walkIn: false })
  expect(dayFlags({ weekdayIdx: 1, iso: '2026-09-07' }, page)).toEqual({ closed: false, walkIn: false })
  expect(dayFlags({ weekdayIdx: 1, iso: '2026-09-07' }, null)).toEqual({ closed: false, walkIn: false })
})
