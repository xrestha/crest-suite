import { adToBs, adToBsSafe, bsToAd, daysInBsMonth, formatAd } from '../../../utils/bsCalendar'
import { nepalCivilDate } from '../../../shared/nepalTime'

/**
 * The date-range arithmetic the four POS report pages share (S754).
 *
 * Each page held its own copy of `new Date(fromIso + 'T00:00:00').toISOString()`, which reads the
 * AD date as the RUNTIME's midnight. In Kathmandu that is right by accident; for an operator viewing
 * a client from anywhere else the range starts and ends 5h45m (or more) away from the business day,
 * so a bill closed at 00:15 Nepal time lands in the wrong day's report — on every tab and in every
 * workbook, with nothing on the page to say so. `bsDayBoundaryIso()` already pins +05:45 for a BS
 * date; these are the same boundaries for the AD `YYYY-MM-DD` string BsCalendarPicker hands back.
 * Four copies of a fix is how three of them drift, so it lives here.
 */

/** The first instant of an AD day in Nepal, as a timestamptz string. */
export function nepalDayStartTs(adIso) {
  return `${adIso}T00:00:00+05:45`
}

/** The last instant of an AD day in Nepal, as a timestamptz string. */
export function nepalDayEndTs(adIso) {
  return `${adIso}T23:59:59.999+05:45`
}

/**
 * Today's AD date as Nepal reads it, for a picker's default. `formatAd(new Date())` is the viewer's
 * own day, which for anyone west of Nepal is still yesterday for the first hours of Nepal's morning.
 */
export function todayNepalAdIso() {
  return formatAd(nepalCivilDate(new Date()))
}

/** Today as Nepal reads it, in BS — the anchor every month preset counts from. */
export function todayNepalBs() {
  return adToBs(nepalCivilDate(new Date()))
}

/** The BS { year, month } `offset` months away from a BS date (offset 0 = its own month). */
export function shiftBsMonth(bsYear, bsMonth, offset) {
  const idx = bsYear * 12 + (bsMonth - 1) + offset
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 }
}

/**
 * A range of whole BS months as AD `YYYY-MM-DD` strings, for a report's range presets (S759).
 *
 *   bsMonthRangeIso(0)      this month     — 1st of this BS month → today
 *   bsMonthRangeIso(-1)     last month     — 1st → last day of last BS month
 *   bsMonthRangeIso(-2, 0)  last 3 months  — 1st of two months ago → today
 *
 * `from` is day 1 of the month `fromOffset` months from today's; `to` is the last day of the month
 * `toOffset` months from today's, capped at today so a range never runs into the future. Both go
 * through `formatAd(bsToAd(...))` — never `.toISOString()`, which at +05:45 lands a day early.
 * `todayBs` is injectable for tests.
 */
export function bsMonthRangeIso(fromOffset, toOffset = fromOffset, todayBs = todayNepalBs()) {
  const start = shiftBsMonth(todayBs.year, todayBs.month, fromOffset)
  const end = shiftBsMonth(todayBs.year, todayBs.month, toOffset)
  const from = formatAd(bsToAd(start.year, start.month, 1))
  const to = toOffset >= 0
    ? formatAd(bsToAd(todayBs.year, todayBs.month, todayBs.day))
    : formatAd(bsToAd(end.year, end.month, daysInBsMonth(end.year, end.month)))
  return { from, to }
}

/**
 * An AD `YYYY-MM-DD` as a BS `DD/MM/YYYY`, for a workbook's scope line.
 *
 * Parsed into a LOCAL-midnight Date on purpose: `new Date('2026-09-14')` is UTC midnight, and
 * adToBs reads local getters, so for a viewer west of UTC the scope line named the previous BS day.
 */
export function bsSlash(adIso) {
  const [y, m, d] = String(adIso || '').split('-').map(Number)
  const bs = Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)
    ? adToBsSafe(new Date(y, m - 1, d))
    : null
  return bs ? `${String(bs.day).padStart(2, '0')}/${String(bs.month).padStart(2, '0')}/${bs.year}` : '—'
}
