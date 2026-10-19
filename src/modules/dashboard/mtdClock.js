/**
 * The month-to-date clock both dashboards (and the group pages) share (S849, OWNER-DASHBOARD-1/8/17).
 *
 * One clock, so a ratio means the same thing on every page:
 *
 *   - "Today" is Nepal's BS date (`nepalBs`), never the viewer's device clock. An operator in Sydney at
 *     01:00 on 6 Poush is looking at a Kathmandu outlet that is still on 5 Poush (OWNER-DASHBOARD-17).
 *   - A ratio counts FINISHED days only (`countedDays = today − 1` in the running month), the demand
 *     forecast's rule that today is never a sample (S792). Labour is accrued to yesterday, so revenue,
 *     purchases and returns feeding a ratio must stop at yesterday too: Labour % on day 3 at 10 am counted
 *     three days of wages against two days and two hours of sales (OWNER-DASHBOARD-8). Day 1 has no
 *     finished day, so every ratio waits (`firstDay`).
 *   - A WHOLE-MONTH amount (rent, Tax & Fees, a typed Labor tab, a finalized run) is counted for the days
 *     that have passed: `prorate(x, clock)` = x × countedDays ÷ monthDays (SU4 (a), OWNER-DASHBOARD-1).
 *     Before it, the whole month's rent came off eleven days of sales and True Net Margin climbed all
 *     month with nothing in the business having changed.
 *
 * A closed month, or an open month that has ended, is not running: countedDays = monthDays, fraction 1.
 * Pure: no Supabase, no React.
 */
import { getBsToday, daysInBsMonth } from '../../utils/bsCalendar'
import { nepalBs } from '../../shared/nepalTime'

/** Nepal's BS date now — moved here from ClientDashboard so every page reads the same "today". */
export const nepalBsToday = (now = new Date()) => nepalBs(now) || getBsToday()

/**
 * @param {?{ bs_year: number, bs_month: number }} period
 * @param {?{ year: number, month: number, day: number }} [today] Nepal's BS date (default: now)
 * @returns {{ running: boolean, monthDays: number, today: ?number, countedDays: number,
 *             fraction: number, firstDay: boolean }}
 *   running: the period is today's BS month in Nepal. today: the BS day when running, else null.
 *   countedDays: finished days when running (today − 1), else every day of the month.
 *   fraction: countedDays ÷ monthDays (1 when not running). firstDay: running with no finished day.
 */
export function mtdClock(period, today = nepalBsToday()) {
  if (!period || !period.bs_year || !period.bs_month) {
    return { running: false, monthDays: 0, today: null, countedDays: 0, fraction: 1, firstDay: false }
  }
  const monthDays = daysInBsMonth(period.bs_year, period.bs_month)
  const running = !!today && today.year === period.bs_year && today.month === period.bs_month
  const day = running ? Math.min(Math.max(Number(today.day) || 1, 1), monthDays) : null
  const countedDays = running ? day - 1 : monthDays
  const fraction = monthDays > 0 ? countedDays / monthDays : 1
  return { running, monthDays, today: day, countedDays, fraction, firstDay: running && countedDays === 0 }
}

/**
 * Whether a row dated `bsDay` is inside the counted days. A row with no day (a Bulk or undated entry,
 * bs_day null or 0) belongs to the month as a whole and always counts.
 */
export function inCountedDays(bsDay, clock) {
  const d = Number(bsDay)
  if (bsDay == null || !Number.isFinite(d) || d <= 0) return true
  if (!clock) return true
  return d <= clock.countedDays
}

/** A whole-month amount counted for the finished days (0 on day 1). null stays null. */
export function prorate(amount, clock) {
  if (amount == null) return null
  const n = Number(amount)
  if (!Number.isFinite(n)) return null
  return n * (clock ? clock.fraction : 1)
}

/** 'Days 1–11 of 30', 'Day 1 of 30', or '' when the month is not running or no day has finished. */
export function countedDaysText(clock) {
  if (!clock?.running || !(clock.countedDays > 0)) return ''
  return clock.countedDays === 1
    ? `Day 1 of ${clock.monthDays}`
    : `Days 1–${clock.countedDays} of ${clock.monthDays}`
}
