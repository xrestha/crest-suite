// ─────────────────────────────────────────────────────────────
// Bikram Sambat (BS) <-> Gregorian (AD) conversion utilities
//
// The BS_CALENDAR table below gives the number of days in each BS
// month for years 2079–2087 (covers roughly AD 2022–2031).
//
// Corrected S352 (2026-07-11) — the whole table (all 9 years) and the EPOCH_AD anchor below were
// re-derived from scratch and cross-checked against two independent, actively-maintained
// open-source Nepali calendar libraries: opensource-nepal/py-nepali (Python) and
// remotemerge/nepali-date-converter (TypeScript) — both agree on every single month for every
// year in this table. The re-derived epoch also reproduces the well-documented public fact that
// Baisakh 1, 2079 (Nepali New Year) fell on Thursday 14 April 2022. Previously: EPOCH_AD was 2
// days off (12 Apr instead of 14 Apr, found S347), and — separately — 2079/2080/2081/2082/2084-
// 2087 had never been independently verified at all (only 2083 was hand-fixed, S349/350); 2080
// and 2082 turned out to also be wrong (each one month-length off, both no longer sum to 366).
//
// To extend the range, add more `bsYear: [12 month-lengths]` rows — re-derive/cross-check them
// the same way rather than typing in a single unverified source.
// ─────────────────────────────────────────────────────────────

export const BS_MONTHS = [
  'Baisakh', 'Jestha', 'Ashadh', 'Shrawan', 'Bhadra', 'Ashwin',
  'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'
]

const BS_CALENDAR = {
  2079: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2080: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30],
  2081: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
  2082: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2083: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2084: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
  2085: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
  2086: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2087: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
}

const EPOCH_BS = { year: 2079, month: 1, day: 1 }
const EPOCH_AD = new Date(2022, 3, 14) // 14 April 2022 (months are 0-indexed) — corrected S352, see note above

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Number of days in a given BS month (1-12). Falls back to 30 if year not in table. */
export function daysInBsMonth(bsYear, bsMonth) {
  const cal = BS_CALENDAR[bsYear]
  if (!cal || !cal[bsMonth - 1]) return 30
  return cal[bsMonth - 1]
}

function bsYearLength(bsYear) {
  const cal = BS_CALENDAR[bsYear]
  if (!cal) return 365
  return cal.reduce((a, b) => a + b, 0)
}

/** Convert a BS date (year, month 1-12, day) to a JS Date (AD). */
export function bsToAd(bsYear, bsMonth, bsDay) {
  let totalDays = 0
  if (bsYear >= EPOCH_BS.year) {
    for (let y = EPOCH_BS.year; y < bsYear; y++) totalDays += bsYearLength(y)
  } else {
    for (let y = bsYear; y < EPOCH_BS.year; y++) totalDays -= bsYearLength(y)
  }
  for (let m = 1; m < bsMonth; m++) totalDays += daysInBsMonth(bsYear, m)
  totalDays += (bsDay - 1)

  const ad = new Date(EPOCH_AD)
  ad.setDate(ad.getDate() + totalDays)
  return ad
}

/** Convert a JS Date (AD) to a BS date { year, month, day }. */
export function adToBs(adDate) {
  let remaining = Math.floor((startOfDay(adDate) - startOfDay(EPOCH_AD)) / 86400000)
  let bsYear = EPOCH_BS.year

  if (remaining >= 0) {
    while (remaining >= bsYearLength(bsYear)) {
      remaining -= bsYearLength(bsYear)
      bsYear++
    }
  } else {
    while (remaining < 0) {
      bsYear--
      remaining += bsYearLength(bsYear)
    }
  }

  let bsMonth = 1
  while (remaining >= daysInBsMonth(bsYear, bsMonth)) {
    remaining -= daysInBsMonth(bsYear, bsMonth)
    bsMonth++
  }

  return { year: bsYear, month: bsMonth, day: remaining + 1 }
}

/** BS date corresponding to the current moment. */
export function getBsToday() {
  return adToBs(new Date())
}

/** Nepal fiscal year label (e.g. '82/83') for a BS year/month. FY runs Shrawan (month 4) -> Ashadh (month 3) of the following year. */
export function getBsFiscalYear(bsYear, bsMonth) {
  const start = bsMonth >= 4 ? bsYear : bsYear - 1
  const end = start + 1
  return `${start % 100}/${end % 100}`
}

// 4-digit BS year a fiscal year (Shrawan->Ashadh) starting from this bs_year/bs_month belongs to.
// Companion to getBsFiscalYear() (which only returns the short "82/83" label) — this returns the
// actual year integer needed for date-range math (e.g. bsToAd cutoffs).
export function getBsFiscalYearStart(bsYear, bsMonth) {
  return bsMonth >= 4 ? bsYear : bsYear - 1
}

/** Format a JS Date as YYYY-MM-DD for <input type="date"> values. */
export function formatAd(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Add (or subtract, with a negative n) n days to a BS date. Returns { year, month, day }. */
export function bsAddDays(bsYear, bsMonth, bsDay, n) {
  const ad = bsToAd(bsYear, bsMonth, bsDay)
  ad.setDate(ad.getDate() + n)
  return adToBs(ad)
}

/**
 * A BS date as an AD day boundary carrying Nepal's own +05:45 offset.
 *
 * Never build one of these with `.toISOString()`. bsToAd returns a Date at LOCAL midnight, so
 * .toISOString() converts it using the RUNTIME's offset — at Nepal's +05:45 that lands at 18:15Z
 * on the PREVIOUS day, and slicing the first 10 characters then yields the wrong date for every
 * user in the country. Formatting from the Date's local getters (what formatAd does) reproduces
 * the calendar day the caller asked for whatever the runtime's timezone, and pinning the offset
 * explicitly makes the comparison against a genuine timestamptz column (pos_orders.closed_at)
 * mean the same thing for a viewer inside Nepal and an admin outside it.
 *
 * @param endOfDay  false → start of that day, true → last millisecond of it.
 */
export function bsDayBoundaryIso(bsYear, bsMonth, bsDay, endOfDay) {
  const d = bsToAd(bsYear, bsMonth, bsDay)
  if (!(d instanceof Date) || isNaN(d)) return null
  return `${formatAd(d)}${endOfDay ? 'T23:59:59.999+05:45' : 'T00:00:00.000+05:45'}`
}

/** Number of days from BS date 1 to BS date 2 (positive if date 2 is later). */
export function bsDiffDays(y1, m1, d1, y2, m2, d2) {
  const ad1 = bsToAd(y1, m1, d1)
  const ad2 = bsToAd(y2, m2, d2)
  return Math.round((startOfDay(ad2) - startOfDay(ad1)) / 86400000)
}
