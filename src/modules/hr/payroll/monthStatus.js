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
  const periodOrd = ordinal(period.bs_year, period.bs_month)
  const todayOrd = ordinal(today.year, today.month)
  const monthDays = daysInBsMonth(period.bs_year, period.bs_month)
  const future = periodOrd > todayOrd
  const cutoff = future ? 0 : periodOrd === todayOrd ? Math.min(today.day, monthDays) : monthDays
  const wage = (employees || []).filter(e => e.pay_basis === 'daily' || e.pay_basis === 'hourly')
  if (future || wage.length === 0) return { future, cutoff, wageStaff: wage.length, gaps: 0, staffWithGaps: 0 }

  const adOf = []
  for (let d = 1; d <= cutoff; d++) adOf[d] = formatAd(bsToAd(period.bs_year, period.bs_month, d))
  const marked = new Set((attendance || []).map(r => `${r.employee_id}:${r.bs_day}`))

  let gaps = 0, staffWithGaps = 0
  for (const e of wage) {
    let mine = 0
    for (let d = 1; d <= cutoff; d++) {
      if (e.join_date && e.join_date > adOf[d]) continue
      if (e.end_date && e.end_date < adOf[d]) continue
      if (!marked.has(`${e.id}:${d}`)) mine++
    }
    gaps += mine
    if (mine > 0) staffWithGaps++
  }
  return { future, cutoff, wageStaff: wage.length, gaps, staffWithGaps }
}

/**
 * The month the HR Dashboard should talk about: the most recent one that has STARTED and whose
 * payroll is not finalized yet — payroll is run after a month ends, so on 3rd Ashwin the live task
 * is usually Bhadra, not the Ashwin the stock module has already opened. When every started month
 * is finalized, the most recent started one (its SSF deposit may still be due).
 *
 * @param periods newest first, as every period read in the app orders them
 * @param runStatusByPeriod period id -> 'draft' | 'finalized'
 */
export function pickStatusPeriod(periods, runStatusByPeriod, today = getBsToday()) {
  const todayOrd = ordinal(today.year, today.month)
  const started = (periods || []).filter(p => ordinal(p.bs_year, p.bs_month) <= todayOrd)
  return started.find(p => runStatusByPeriod[p.id] !== 'finalized') || started[0] || null
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
