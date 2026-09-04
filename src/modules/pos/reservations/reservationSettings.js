import { PARTY_BANDS, bandFor } from '../reports/coversMath'

// settings.pos_reservation_settings — one jsonb, edited on Table Management → Reservations.
//
// The duration defaults are deliberately pessimistic round numbers; the settings tab shows the
// outlet's own MEASURED dwell per band beside each field (turnoverByBand over the last 90 days)
// with a one-tap "use measured" — the point of building reservations on top of the Covers
// Report is that nobody has to guess a turn time.

export const DEFAULT_WHATSAPP_TEMPLATE =
  'Namaste {name}! Your table for {party} at {outlet} is booked for {date} at {time}. ' +
  'Reply here if anything changes. See you soon!'

export const DEFAULT_RESERVATION_SETTINGS = {
  duration_by_band: { '1-2': 60, '3-4': 90, '5-6': 105, '7+': 120 },
  // A booked party counts as late this many minutes after its time, if nobody has marked it arrived.
  arrival_grace_minutes: 20,
  // Tapping a table this many minutes before its booking offers "Seat <name>" instead of the numpad.
  seat_window_minutes: 45,
  whatsapp_template: DEFAULT_WHATSAPP_TEMPLATE,
  // The public booking page (/pos/book/:clientId). Off until an outlet switches it on.
  public_booking_enabled: false,
  max_party_online: 20,
  min_lead_minutes: 60,
  // Days the page greys out. 0 = Sunday … 6 = Saturday. Closed wins over walk-in-only. Dates are
  // AD 'YYYY-MM-DD' (picked on the BS calendar, stored the way every date in this product is).
  closed_weekdays: [],
  walk_in_weekdays: [],
  closed_dates: [],
  // One line under the page title — "Walk-ins only on Saturdays", "Groups over 12 please call".
  page_notice: '',
}

const int = (v, fallback, min, max) => {
  const n = parseInt(v, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
const weekdayList = v => Array.isArray(v)
  ? [...new Set(v.map(n => parseInt(n, 10)).filter(n => n >= 0 && n <= 6))].sort((a, b) => a - b)
  : []
const dateList = v => Array.isArray(v)
  ? [...new Set(v.filter(s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)))].sort()
  : []

/** A stored jsonb (possibly null, partial, or from an older shape) → a complete settings object. */
export function normalizeReservationSettings(raw) {
  const d = DEFAULT_RESERVATION_SETTINGS
  const r = raw && typeof raw === 'object' ? raw : {}
  const bands = {}
  for (const b of PARTY_BANDS) bands[b.key] = int(r.duration_by_band?.[b.key], d.duration_by_band[b.key], 15, 720)
  return {
    duration_by_band:       bands,
    arrival_grace_minutes:  int(r.arrival_grace_minutes, d.arrival_grace_minutes, 0, 180),
    seat_window_minutes:    int(r.seat_window_minutes, d.seat_window_minutes, 0, 240),
    whatsapp_template:      typeof r.whatsapp_template === 'string' && r.whatsapp_template.trim() ? r.whatsapp_template : d.whatsapp_template,
    public_booking_enabled: r.public_booking_enabled === true,
    max_party_online:       int(r.max_party_online, d.max_party_online, 1, 99),
    min_lead_minutes:       int(r.min_lead_minutes, d.min_lead_minutes, 0, 1440),
    closed_weekdays:        weekdayList(r.closed_weekdays),
    // A day cannot be both; closed wins.
    walk_in_weekdays:       weekdayList(r.walk_in_weekdays).filter(n => !weekdayList(r.closed_weekdays).includes(n)),
    closed_dates:           dateList(r.closed_dates),
    page_notice:            typeof r.page_notice === 'string' ? r.page_notice.trim().slice(0, 160) : '',
  }
}

/** Expected sitting length for a party of `partySize`, per the outlet's band settings. */
export function durationFor(partySize, settings) {
  const s = settings || DEFAULT_RESERVATION_SETTINGS
  const band = bandFor(partySize)
  return band ? (s.duration_by_band?.[band.key] || DEFAULT_RESERVATION_SETTINGS.duration_by_band[band.key]) : 90
}
