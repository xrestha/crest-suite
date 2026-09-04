import { nepalHour } from '../../../shared/nepalTime'
import { windowOf } from './reservationStatus'

/**
 * Booked covers per hour of the day (24 buckets), in Nepal's clock.
 *
 * A booking occupies every hour its window touches: a 7:30 PM ×4 for 90 minutes sits in the 19
 * and 20 buckets. This is what the Reservations page's capacity strip compares against the
 * room's total seats — a SOFT warning, never a block (a host will always take the ninth booking
 * for a forty-seat room; the strip exists so they take it knowingly).
 *
 * `hourOf` is injectable so the arithmetic is testable without a timezone; production passes
 * nothing and gets nepalHour. Nepal has no DST, so stepping the window in whole hours from its
 * start cannot land on a repeated or missing hour.
 */
export function bookedCoversByHour(rows, hourOf = nepalHour) {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, covers: 0, bookings: 0 }))
  for (const r of rows || []) {
    const { start, end } = windowOf(r)
    if (!Number.isFinite(start) || end <= start) continue
    const covers = Number(r.party_size) || 0
    // Sample the window every hour from its start, plus its final millisecond: the hourly steps
    // land in consecutive hours, and the one hour they can miss is the last, which a booking
    // that runs past the top of the hour still touches (20:15 + 60 min occupies 21:00–21:15).
    const seen = new Set()
    const samples = []
    for (let t = start; t < end; t += 3600000) samples.push(t)
    samples.push(end - 1)
    for (const t of samples) {
      const h = hourOf(t)
      if (h == null || seen.has(h)) continue
      seen.add(h)
      buckets[h].covers += covers
      buckets[h].bookings += 1
    }
  }
  return buckets
}

/** The hours whose booked covers exceed the seats available. */
export function overSeatsHours(buckets, totalSeats) {
  if (!(totalSeats > 0)) return []
  return buckets.filter(b => b.covers > totalSeats).map(b => b.hour)
}
