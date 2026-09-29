import { adToBsSafe } from '../utils/bsCalendar'
import { nepalCivilDate } from './nepalTime'

/**
 * The day of a BS period on which an instant fell IN NEPAL, or null when it fell outside that
 * period's month (or outside the verified BS calendar table).
 *
 * WHY (S792, SALES-6). The POS backfill and the credit-note backfill chose each period's window in
 * Nepal time (`bsDayBoundaryIso` pins +05:45) and then dated every bill with
 * `adToBs(new Date(closed_at)).day`, which reads the VIEWER's local getters. Run from outside Nepal,
 * a bill closed at 00:10 on 1 Ashwin came out as the last day of Bhadra and was stored as bs_day 31
 * inside the Ashwin period: the wrong day on Daily Breakdown, and no longer superseding that day's
 * manual row. `nepalCivilDate` pins the calendar day to Asia/Kathmandu first, so the answer no
 * longer depends on where the operator is sitting.
 *
 * The period check is the other half. A day number means nothing outside its own month, so a stamp
 * from a different month comes back null for the caller to refuse, rather than as a plausible day
 * written into the wrong period.
 */
export function nepalDayInPeriod(ts, period) {
  if (!period) return null
  const civil = nepalCivilDate(ts)
  const bs = civil ? adToBsSafe(civil) : null
  if (!bs || bs.year !== Number(period.bs_year) || bs.month !== Number(period.bs_month)) return null
  return bs.day
}
