// ─────────────────────────────────────────────────────────────
// Bikram Sambat (BS) <-> Gregorian (AD) conversion utilities
//
// IMPORTANT: The BS_CALENDAR table below gives the number of days
// in each BS month for years 2079–2087 (covers roughly AD
// 2022–2031). This data is the commonly published Nepali calendar
// month-length table, but it's worth spot-checking a couple of
// dates against an official source (e.g. ashesh.com.np or
// hamropatro.com) before relying on it for legal/compliance dates.
//
// To extend the range, add more `bsYear: [12 month-lengths]` rows.
// Anything outside the table falls back to a 30-day/365-day
// approximation so the app doesn't crash, but conversions for
// out-of-range years won't be exact.
//
// Reference anchor: BS 2079/01/01 (Baisakh 1, 2079) = AD 12 Apr 2022 (verified against Nepali Patro)
// ─────────────────────────────────────────────────────────────

export const BS_MONTHS = [
  'Baisakh', 'Jestha', 'Ashadh', 'Shrawan', 'Bhadra', 'Ashwin',
  'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'
]

const BS_CALENDAR = {
  2079: [31, 32, 31, 32, 31, 30, 30, 29, 30, 29, 30, 30],
  2080: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
  2081: [31, 32, 31, 32, 31, 30, 30, 29, 30, 29, 30, 30],
  2082: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 29, 31],
  2083: [31, 32, 31, 32, 31, 30, 30, 29, 30, 29, 30, 30],
  2084: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30],
  2085: [31, 32, 31, 31, 32, 30, 30, 30, 29, 30, 30, 30],
  2086: [31, 32, 31, 32, 31, 31, 30, 30, 29, 30, 29, 31],
  2087: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30],
}

const EPOCH_BS = { year: 2079, month: 1, day: 1 }
const EPOCH_AD = new Date(2022, 3, 12) // 12 April 2022 (months are 0-indexed) — verified against Nepali Patro

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

/** Format a JS Date as YYYY-MM-DD for <input type="date"> values. */
export function formatAd(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
