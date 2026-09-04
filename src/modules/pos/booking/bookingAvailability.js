// What the public booking page can decide on its own before a guest picks: which days are
// closed or walk-in only, and which slots the room cannot hold. All pure — the server enforces
// the same rules in submit_reservation_request, so this is the page saying "no" early rather
// than the guest finding out on submit.

/** 'YYYY-MM-DD|hour' → booked covers, from get_booking_availability's rows. */
export function loadMapFrom(rows) {
  const m = {}
  for (const r of rows || []) {
    if (!r || r.day == null || r.hour == null) continue
    m[`${r.day}|${r.hour}`] = Number(r.covers) || 0
  }
  return m
}

/**
 * The hours of the day a sitting starting at 'HH:MM' touches, for `durationMinutes`. Arithmetic
 * on the clock, not on timestamps: the slot is already in the outlet's own clock and Nepal has
 * no DST. A sitting that runs past midnight is counted to 23 and stops — those hours belong to
 * another date, and the server's check does the same.
 */
export function hoursTouched(hm, durationMinutes) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '')
  if (!m) return []
  const start = Number(m[1]) * 60 + Number(m[2])
  const end = start + Math.max(1, Number(durationMinutes) || 90)
  const first = Math.floor(start / 60)
  const last = Math.min(23, Math.floor((end - 1) / 60))
  const out = []
  for (let h = first; h <= last; h++) out.push(h)
  return out
}

/** True when, in any hour this party would sit, booked covers plus the party exceed the room. */
export function slotIsFull({ dayIso, hm, party, durationMinutes, load, totalSeats }) {
  if (!(totalSeats > 0)) return false
  const p = Number(party) || 0
  for (const h of hoursTouched(hm, durationMinutes)) {
    const booked = load?.[`${dayIso}|${h}`] || 0
    if (booked + p > totalSeats) return true
  }
  return false
}

/** { closed, walkIn } for a calendar day, from the page's rules. */
export function dayFlags({ weekdayIdx, iso }, page) {
  const closed = (page?.closed_weekdays || []).includes(weekdayIdx) || (page?.closed_dates || []).includes(iso)
  const walkIn = !closed && (page?.walk_in_weekdays || []).includes(weekdayIdx)
  return { closed, walkIn }
}
