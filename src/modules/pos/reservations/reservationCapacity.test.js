import { bookedCoversByHour, overSeatsHours } from './reservationCapacity'

// UTC hour as the "local" hour, so the test needs no timezone.
const utcHour = ms => new Date(ms).getUTCHours()
const at = (h, m) => new Date(Date.UTC(2026, 8, 4, h, m)).toISOString()

test('a 7:30 PM ×4 booking of 90 minutes lands in the 19 and 20 buckets', () => {
  const b = bookedCoversByHour([{ reserved_for: at(19, 30), duration_minutes: 90, party_size: 4 }], utcHour)
  expect(b[19]).toEqual({ hour: 19, covers: 4, bookings: 1 })
  expect(b[20]).toEqual({ hour: 20, covers: 4, bookings: 1 })
  expect(b[21].covers).toBe(0)
  expect(b[18].covers).toBe(0)
})

test('a booking ending exactly on the hour does not spill into the next bucket', () => {
  const b = bookedCoversByHour([{ reserved_for: at(19, 0), duration_minutes: 60, party_size: 2 }], utcHour)
  expect(b[19].covers).toBe(2)
  expect(b[20].covers).toBe(0)
})

test('overlapping bookings add up per hour and rows without a valid time are skipped', () => {
  const b = bookedCoversByHour([
    { reserved_for: at(19, 0),  duration_minutes: 120, party_size: 6 },
    { reserved_for: at(20, 15), duration_minutes: 60,  party_size: 3 },
    { reserved_for: 'garbage',  duration_minutes: 60,  party_size: 99 },
  ], utcHour)
  expect(b[19].covers).toBe(6)
  expect(b[20].covers).toBe(9)
  expect(b[20].bookings).toBe(2)
  expect(b[21].covers).toBe(3)
  expect(b.reduce((s, x) => s + x.covers, 0)).toBe(18)
})

test('overSeatsHours names only the hours past capacity, and never with zero seats', () => {
  const b = bookedCoversByHour([
    { reserved_for: at(19, 0), duration_minutes: 120, party_size: 30 },
    { reserved_for: at(20, 0), duration_minutes: 60,  party_size: 15 },
  ], utcHour)
  expect(overSeatsHours(b, 40)).toEqual([20])
  expect(overSeatsHours(b, 0)).toEqual([])
})
