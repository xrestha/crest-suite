import { BS_MONTHS, BS_YEAR_MAX, BS_YEAR_MIN, bsToAd, daysInBsMonth, formatAd } from '../../../utils/bsCalendar'
import { todayNepalBs } from '../reports/reportRange'

// Customers' birthdays and anniversaries, and which fall in the next N days (S843).
//
// A date is stored as month + day (+ an optional year) in the calendar the customer gave it in:
// Nepali (BS) or English (AD), chosen per date. Kept only with the customer's agreement
// (consent_at; the database CHECK holds that, and this file filters on it anyway).
//
// Crest-only on purpose: src/utils/bsCalendar.js is mirrored byte-for-byte with hss-suite, so nothing
// new goes there. "Today" is Nepal's (todayNepalBs), never the viewer's own clock, so an operator
// abroad sees the same list as the till.
//
// The window is walked a day at a time with daysInBsMonth, so Chaitra rolls into Baisakh of the next
// BS year, and each day carries its AD date from one bsToAd anchor (Dec → Jan is ordinary Date
// arithmetic). A BS day stored past a month's length (32 in a 31-day month, in this year) falls on
// that month's last day; an AD 29 February falls on the 28th in a year that has no 29th.

export const AD_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
export const CALENDAR_LABELS = { BS: 'Nepali (BS)', AD: 'English (AD)' }
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const KIND_ORDER = { birthday: 0, anniversary: 1 }
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

/** The customer-book columns the occasion lists read. */
export const OCCASION_COLUMNS = 'id, name, phone, birth_month, birth_day, birth_year, birth_calendar, '
  + 'anniv_month, anniv_day, anniv_year, anniv_calendar, consent_at'

const isLeapAd = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

/** Days in an AD month. With no year, February has 29: a 29 February birthday is a real one. */
export function adDaysInMonth(month, year = null) {
  if (month === 2) return year == null ? 29 : (isLeapAd(year) ? 29 : 28)
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/**
 * The most days a stored date's month can have, which is what a form offers and checks. A BS month
 * runs 29 to 32 days depending on the year, so with no year (or a year past the verified table) it is
 * 32, as the database holds it; with a year in the table it is that month's real length.
 */
export function maxDayOf(calendar, month, year = null) {
  const m = Number(month)
  const y = year == null || year === '' ? null : Number(year)
  if (!(m >= 1 && m <= 12)) return calendar === 'AD' ? 31 : 32
  if (calendar === 'AD') return adDaysInMonth(m, Number.isFinite(y) ? y : null)
  if (Number.isFinite(y) && y >= BS_YEAR_MIN && y <= BS_YEAR_MAX) return daysInBsMonth(y, m)
  return 32
}

/** A month's name in its own calendar. */
export function monthName(calendar, month) {
  return (calendar === 'AD' ? AD_MONTHS : BS_MONTHS)[Number(month) - 1] || ''
}

/** A stored date as words: "3 Kartik 2052 (BS)", "14 March (AD)". */
export function storedDateLabel({ calendar, month, day, year }) {
  const name = monthName(calendar, month)
  if (!name || !day) return ''
  return `${day} ${name}${year ? ` ${year}` : ''} (${calendar === 'AD' ? 'AD' : 'BS'})`
}

/**
 * The customer's dates as `{ kind, calendar, month, day, year }`, only when the customer agreed and
 * the date is whole (month, day and calendar together, as the database holds them).
 */
export function occasionDatesOf(c) {
  if (!c || c.consent_at == null) return []
  const out = []
  for (const [kind, p] of [['birthday', 'birth'], ['anniversary', 'anniv']]) {
    const month = Number(c[`${p}_month`])
    const day = Number(c[`${p}_day`])
    const calendar = c[`${p}_calendar`]
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 32) || (calendar !== 'BS' && calendar !== 'AD')) continue
    const rawYear = c[`${p}_year`]
    const year = rawYear == null || rawYear === '' ? null : Number(rawYear)
    out.push({ kind, calendar, month, day, year: Number.isFinite(year) ? year : null })
  }
  return out
}

/**
 * The next `days` days from `todayBs` (today is day 0), each as its BS date, that BS month's length
 * and its AD date (a Date at local midnight, from one bsToAd anchor).
 */
export function windowDays(todayBs, days) {
  const n = Math.max(0, Math.floor(Number(days) || 0))
  if (!todayBs || n === 0) return []
  const start = bsToAd(todayBs.year, todayBs.month, todayBs.day)
  const out = []
  let y = todayBs.year
  let m = todayBs.month
  let d = todayBs.day
  for (let i = 0; i < n; i++) {
    const last = daysInBsMonth(y, m)
    out.push({
      i,
      bs: { year: y, month: m, day: d },
      bsLast: last,
      ad: new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
    })
    d += 1
    if (d > last) {
      d = 1
      m += 1
      if (m > 12) { m = 1; y += 1 }
    }
  }
  return out
}

function falls(date, w) {
  if (date.calendar === 'BS') return w.bs.month === date.month && w.bs.day === Math.min(date.day, w.bsLast)
  const y = w.ad.getFullYear()
  const m = w.ad.getMonth() + 1
  return m === date.month && w.ad.getDate() === Math.min(date.day, adDaysInMonth(m, y))
}

// Only when the year is stored, counted in the date's own calendar: a BS year against the BS year
// of the day it falls on, an AD year against the AD year. A year not yet passed gives nothing.
function yearsAt(date, w) {
  if (date.year == null) return null
  const n = (date.calendar === 'BS' ? w.bs.year : w.ad.getFullYear()) - date.year
  return n >= 1 ? n : null
}

/**
 * Every birthday and anniversary of `rows` (customer-book rows) falling in the next `days` days,
 * today included as day 0, so `days` 7 is today and the six days after it. Sorted by days away, then
 * name, birthday before anniversary. Each item:
 *   { key, customerId, name, phone, kind, calendar, daysAway, bs: {year, month, day}, adIso, weekday, years }
 * `years` is the age turned or the years married, or null when the year is not stored.
 */
export function upcomingOccasions(rows, days, todayBs = todayNepalBs()) {
  const win = windowDays(todayBs, days)
  if (!win.length) return []
  // Each month's days in the window, in window order, so a date checks at most a handful of days.
  const byBs = new Map()
  const byAd = new Map()
  for (const w of win) {
    const bm = w.bs.month
    const am = w.ad.getMonth() + 1
    if (!byBs.has(bm)) byBs.set(bm, [])
    if (!byAd.has(am)) byAd.set(am, [])
    byBs.get(bm).push(w)
    byAd.get(am).push(w)
  }
  const items = []
  for (const c of rows || []) {
    for (const date of occasionDatesOf(c)) {
      const w = ((date.calendar === 'BS' ? byBs : byAd).get(date.month) || []).find(x => falls(date, x))
      if (!w) continue
      items.push({
        key: `${c.id}:${date.kind}`,
        customerId: c.id,
        name: c.name || '',
        phone: c.phone || '',
        kind: date.kind,
        calendar: date.calendar,
        daysAway: w.i,
        bs: w.bs,
        adIso: formatAd(w.ad),
        weekday: WEEKDAYS[w.ad.getDay()],
        years: yearsAt(date, w),
      })
    }
  }
  items.sort((a, b) => (a.daysAway - b.daysAway)
    || collator.compare(a.name, b.name)
    || (KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
    || String(a.customerId).localeCompare(String(b.customerId)))
  return items
}

/** The ids of customers with a birthday or an anniversary in the next `days` days. */
export function customerIdsWithOccasion(rows, days, todayBs = todayNepalBs()) {
  return new Set(upcomingOccasions(rows, days, todayBs).map(it => it.customerId))
}

/** "today", "tomorrow", "in 5 days". */
export function daysAwayLabel(n) {
  if (n === 0) return 'today'
  if (n === 1) return 'tomorrow'
  return `in ${n} days`
}

/** "Birthday · turns 30", "Anniversary · 5 years", or the kind alone when the year is not stored. */
export function occasionWhat(item) {
  if (item.kind === 'anniversary') {
    return item.years ? `Anniversary · ${item.years} year${item.years === 1 ? '' : 's'}` : 'Anniversary'
  }
  return item.years ? `Birthday · turns ${item.years}` : 'Birthday'
}

/** The day it falls on, in BS with its weekday: "Friday, 3 Kartik". */
export function occasionDayLabel(item) {
  return `${item.weekday}, ${item.bs.day} ${BS_MONTHS[item.bs.month - 1] || ''}`.trim()
}

/** The WhatsApp wish, prefilled for staff to read and send from their own phone. */
export function occasionWish(item, outletName = '') {
  const first = String(item.name || '').trim().split(/\s+/)[0] || ''
  const to = first ? `, ${first}` : ''
  const from = outletName ? ` from all of us at ${outletName}` : ''
  const what = item.kind === 'anniversary' ? 'anniversary' : 'birthday'
  if (item.daysAway === 0) return `Happy ${what}${to}! Warm wishes${from}. We would love to celebrate with you.`
  return `Wishing you a very happy ${what}${to}, coming up on ${occasionDayLabel(item)}! Warm wishes${from}. We would love to celebrate with you.`
}
