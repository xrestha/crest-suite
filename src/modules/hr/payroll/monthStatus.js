// Where one month's payroll stands — the arithmetic behind PayrollMonthStatus (S768). Pure, so the
// two numbers a manager acts on from it are tested rather than eyeballed.
//
// The payroll month moves through four steps — attendance, approvals, the run, the SSF deposit —
// across five pages, and until S768 no screen said which step a month was on: the HR Dashboard
// showed only the last FINALIZED run, so a manager opening it mid-Bhadra learned about Shrawan.
import { bsToAd, daysInBsMonth, formatAd, getBsToday } from '../../../utils/bsCalendar'
import { SSF_DEPOSIT_DAY } from '../payrollConstants'

const ordinal = (year, month) => year * 12 + month

/**
 * How far into a month attendance can be owed: every day of a past month, today in the running
 * month, none of a future one. `adOf[d]` is each counted day's AD date, for the employment test.
 */
export function unmarkedWindow(period, today = getBsToday()) {
  const periodOrd = ordinal(period.bs_year, period.bs_month)
  const todayOrd = ordinal(today.year, today.month)
  const monthDays = daysInBsMonth(period.bs_year, period.bs_month)
  const future = periodOrd > todayOrd
  const cutoff = future ? 0 : periodOrd === todayOrd ? Math.min(today.day, monthDays) : monthDays
  const adOf = []
  for (let d = 1; d <= cutoff; d++) adOf[d] = formatAd(bsToAd(period.bs_year, period.bs_month, d))
  return { future, cutoff, adOf }
}

/**
 * One employee's unmarked days that will PAY NOTHING, or null for monthly staff (S798 ATTENDANCE-9).
 * The Attendance sheet's Month Summary and attendanceGaps below both count through this, so the
 * sheet and the payroll strip can never disagree about what a gap is.
 *
 * @param isMarked (day) => boolean
 */
export function unmarkedDaysFor(employee, window, isMarked) {
  if (employee.pay_basis !== 'daily' && employee.pay_basis !== 'hourly') return null
  let n = 0
  for (let d = 1; d <= window.cutoff; d++) {
    if (employee.join_date && employee.join_date > window.adOf[d]) continue
    if (employee.end_date && employee.end_date < window.adOf[d]) continue
    if (!isMarked(d)) n++
  }
  return n
}

/**
 * Unmarked days that will PAY NOTHING — daily and hourly staff only.
 *
 * A blank day is paid in full for monthly staff (unpaidDays comes only from rows that exist), so a
 * monthly employee's blank day is not a gap and is not counted. For a daily or hourly employee a
 * blank day is an unpaid day, which is the thing worth saying before payroll runs. Only days they
 * were employed on count (join_date … end_date), and only days that have happened: a current month
 * is counted to today, a future month not at all.
 *
 * @returns {{ future: boolean, cutoff: number, wageStaff: number, gaps: number, staffWithGaps: number }}
 */
export function attendanceGaps({ period, employees, attendance, today = getBsToday() }) {
  const window = unmarkedWindow(period, today)
  const { future, cutoff } = window
  const wage = (employees || []).filter(e => e.pay_basis === 'daily' || e.pay_basis === 'hourly')
  if (future || wage.length === 0) return { future, cutoff, wageStaff: wage.length, gaps: 0, staffWithGaps: 0 }

  const marked = new Set((attendance || []).map(r => `${r.employee_id}:${r.bs_day}`))

  let gaps = 0, staffWithGaps = 0
  for (const e of wage) {
    const mine = unmarkedDaysFor(e, window, d => marked.has(`${e.id}:${d}`))
    gaps += mine
    if (mine > 0) staffWithGaps++
  }
  return { future, cutoff, wageStaff: wage.length, gaps, staffWithGaps }
}

/**
 * The month the HR Dashboard should talk about. Payroll is run after a month ends, so on 3rd Ashwin
 * the live task is Bhadra, not the Ashwin the stock module has already opened: LAST month (found by
 * year and month, not the next-older row) while its payroll is not finalized, otherwise the RUNNING
 * month (S798 REPORTS-3, H32 — the strip moves on at Finalize, not at Mark paid). Never further back.
 *
 * It used to take the newest STARTED month not finalized — the running month counts as started, so
 * all through payroll week the strip described the month still running and never the one being paid
 * (its test pinned that, while this docstring and Help promised Bhadra). And with the running month
 * finalized early, it walked back through the year to the newest month with no run: for a client that
 * used IMS before HR, a month from before HR, "Ashadh 2083 payroll: Not generated yet".
 *
 * Without a running-month period (the stock module has not opened it), last month even if finalized:
 * its staff payments and SSF deposit are still the live questions.
 *
 * @param periods any order
 * @param runStatusByPeriod period id -> 'draft' | 'finalized'
 */
export function pickStatusPeriod(periods, runStatusByPeriod, today = getBsToday()) {
  const find = (y, m) => (periods || []).find(p => p.bs_year === y && p.bs_month === m) || null
  const last = today.month === 1 ? find(today.year - 1, 12) : find(today.year, today.month - 1)
  if (last && runStatusByPeriod[last.id] !== 'finalized') return last
  return find(today.year, today.month) || last
}

/**
 * The SSF deposit deadline for a month's payroll — the SSF_DEPOSIT_DAY of the following BS month.
 * `overdue` once that day has passed, `dueThisMonth` in the month it falls due. Nothing here knows
 * whether the deposit was made (the product does not record deposits), so a caller must not call a
 * passed date a missed one.
 */
export function ssfDeadline(bsYear, bsMonth, today = getBsToday()) {
  const month = bsMonth === 12 ? 1 : bsMonth + 1
  const year = bsMonth === 12 ? bsYear + 1 : bsYear
  const dueOrd = ordinal(year, month)
  const nowOrd = ordinal(today.year, today.month)
  return {
    year, month, day: SSF_DEPOSIT_DAY,
    overdue: nowOrd > dueOrd || (nowOrd === dueOrd && today.day > SSF_DEPOSIT_DAY),
    dueThisMonth: nowOrd === dueOrd && today.day <= SSF_DEPOSIT_DAY,
  }
}
