import { adToBsSafe, formatAd } from '../../../utils/bsCalendar'
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
