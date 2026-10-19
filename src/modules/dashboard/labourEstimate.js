/**
 * The ONE HR wage estimate (S849, GAPS-4 / SU11 (a), OWNER-DASHBOARD-3/4/5, SU16, SU17).
 *
 * For an outlet on Crest HR, labour is the finalized payroll run, and until the month's run is finalized
 * it is this estimate, on every page: the Owner Dashboard, the Inventory Dashboard / Home, Overheads, the
 * frozen Owner Report, Consolidated P&L and the Group Console. Before S849 there were two estimates (the
 * Owner Dashboard's inline `estimateLaborCost` and the Owner Report's `estimatePayrollAccrual` + its own
 * overtime loop) and both differed from payroll in three ways this file fixes:
 *
 *   1. WHO is counted (OWNER-DASHBOARD-3). Payroll's own list (`fetchPayrollEmployees`, payrollData.js):
 *      active/probation staff AND anyone with an End Date, employed on at least one day of the month, less
 *      anyone whose FINALIZED Final Settlement already paid that month (current employment only). The old
 *      estimates counted a leaver only when the End Date fell in the month and counted a settled leaver a
 *      second time. A leaver with no End Date is not counted (payroll holds Finalize for them) and is named.
 *   2. ATTENDANCE (OWNER-DASHBOARD-4, SU16). Monthly staff dock the sheet's unpaid days; daily and hourly
 *      staff are paid the engine's weights on a day WITH a sheet row and a full day (8 h) on a day not yet
 *      marked; overtime typed on the attendance sheet is priced like payroll (`hourlyRateOf` ×
 *      OT_MULTIPLIER), and an approved Overtime entry replaces the sheet's OT on its own day
 *      (`computePayslip`'s rule). The old estimates read no attendance at all.
 *   3. NO PAY SET (OWNER-DASHBOARD-5, SU17). Staff on payroll with a blank or zero basic were counted at 0,
 *      so a cafe that had not finished Pay Setup read Labour 0.0% ✓. They are listed (`noPay`), and the
 *      labour rule (`resolveOutletLabour`) keeps the figure but withholds every labour verdict.
 *
 * Accrued to `throughDay` (mtdClock.countedDays for the running month, the month's length for a closed
 * one): nothing here is scaled again afterwards. Pure: no Supabase, no React. The reads are
 * `loadOutletLabour.js`; the group pages get the same rows from `get_group_labour_inputs`.
 */
import { bsToAd, formatAd, daysInBsMonth } from '../../utils/bsCalendar'
import { calcAmount, hourlyRateOf, isSsfContributor, employedInPeriod, tallyAttendance } from '../hr/payroll/payrollCompute'
import {
  OT_MULTIPLIER, OT_HOLIDAY_MULTIPLIER, STANDARD_HOURS_PER_DAY, SSF_CAP, SSF_EMPLOYER_PCT,
} from '../hr/payrollConstants'

export const ESTIMATE_EMPLOYEE_COLUMNS = 'id, full_name, status, basic_salary, pay_basis, ssf_enrolled, ssf_no, join_date, end_date'
export const ESTIMATE_COMPONENT_COLUMNS = 'employee_id, type, calc_type, value'
export const ESTIMATE_OT_COLUMNS = 'employee_id, bs_day, ot_hours, ot_type'          // status = 'approved' rows
export const ESTIMATE_ATTENDANCE_COLUMNS = 'employee_id, bs_day, status, hours_worked, ot_hours'
export const ESTIMATE_SETTLEMENT_COLUMNS = 'employee_id, last_working_date'          // status = 'finalized'

/**
 * Employer SSF in the estimate for a MONTHLY employee paid `daysWorked` of the month's `monthDays` days
 * (and, kept for its older callers, daily/hourly month-equivalent pay). The caller has already checked
 * `isSsfContributor`.
 *
 * SSF is charged on BASIC salary, so a monthly employee's base is basic × days ÷ month days, then capped:
 * the engine's own order (`computePayslip`: min(basic × paid fraction, cap)). Both old estimates charged it
 * on basic + allowances (S798 4b, LABOUR-FIGURES-8). Re-exported from labourSource.js under its old name.
 */
export function estimatedEmployerSsf({ basis, basic, monthlyEquivGross, daysWorked, monthDays }) {
  if (!(monthDays > 0) || !(daysWorked > 0)) return 0
  const fraction = daysWorked / monthDays
  const base = (basis || 'monthly') === 'monthly'
    ? Math.min((basic || 0) * fraction, SSF_CAP)
    : Math.min(monthlyEquivGross || 0, SSF_CAP) * fraction
  return base * SSF_EMPLOYER_PCT
}

const ON_PAYROLL_STATUSES = new Set(['active', 'probation'])
const day10 = v => (v ? String(v).slice(0, 10) : null)

function monthBounds(period) {
  const monthDays = daysInBsMonth(period.bs_year, period.bs_month)
  return {
    monthDays,
    start: formatAd(bsToAd(period.bs_year, period.bs_month, 1)),
    end: formatAd(bsToAd(period.bs_year, period.bs_month, monthDays)),
  }
}

/**
 * Payroll's own list for the month (`fetchPayrollEmployees`' rule, in JS so the group pages can run it
 * on the RPC's rows): on the list = active/probation OR an End Date set, employed on at least one day of
 * the month (`employedInPeriod`), less anyone with a finalized settlement whose last working day is on or
 * before the month's end and on or after their join date (the current employment).
 *
 * @returns {{ onPayroll: object[], settled: object[], unended: object[] }}
 */
export function payrollRoster({ employees, settlements, period }) {
  if (!period) return { onPayroll: [], settled: [], unended: [] }
  const { start, end } = monthBounds(period)
  const emps = employees || []
  const joinOf = new Map(emps.map(e => [e.id, day10(e.join_date)]))
  const settledIds = new Set((settlements || [])
    .filter(s => {
      const lwd = day10(s.last_working_date)
      if (!lwd || lwd > end) return false
      const j = joinOf.get(s.employee_id)
      return !j || lwd >= j
    })
    .map(s => s.employee_id))
  const onList = e => ON_PAYROLL_STATUSES.has(e.status) || !!e.end_date
  const inMonth = emps.filter(e => onList(e) && employedInPeriod(e, start, end))
  return {
    onPayroll: inMonth.filter(e => !settledIds.has(e.id)),
    settled: inMonth.filter(e => settledIds.has(e.id)),
    unended: emps.filter(e => !onList(e) && employedInPeriod(e, start, end) && !settledIds.has(e.id)),
  }
}

// Daily pay per sheet row: computePayslip's daily weights (a paid half-day leave pays the whole day,
// an unpaid half pays the worked half; a Holiday is paid, S749).
const DAILY_WEIGHT = { present: 1, half_day: 0.5, paid_leave: 1, half_paid_leave: 1, half_unpaid_leave: 0.5, holiday: 1 }
// Monthly unpaid days per sheet row: computePayslip's absence deduction.
const MONTHLY_UNPAID = { absent: 1, unpaid_leave: 1, half_day: 0.5, half_unpaid_leave: 0.5 }

function groupBy(rows, key = 'employee_id') {
  const m = new Map()
  for (const r of rows || []) {
    const k = r[key]
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(r)
  }
  return m
}

const named = e => ({ id: e.id, name: e.full_name || null })

/**
 * @param {object} a
 * @param {object[]} a.employees   hr_employees rows (ESTIMATE_EMPLOYEE_COLUMNS; the group RPC's carry no name)
 * @param {object[]} a.components  earning components (ESTIMATE_COMPONENT_COLUMNS)
 * @param {object[]} a.otEntries   APPROVED overtime entries of the month (ESTIMATE_OT_COLUMNS)
 * @param {object[]} a.attendance  the month's attendance rows (ESTIMATE_ATTENDANCE_COLUMNS)
 * @param {object[]} a.settlements FINALIZED settlements (ESTIMATE_SETTLEMENT_COLUMNS); filtered by month end here
 * @param {{ bs_year: number, bs_month: number }} a.period
 * @param {number} [a.throughDay]  last BS day counted; default the whole month; 0 → amount 0
 */
export function estimateLabour({ employees, components, otEntries, attendance, settlements, period, throughDay }) {
  const empty = {
    amount: 0, gross: 0, ssfEmployer: 0, sheetOt: { hours: 0, amount: 0 }, approvedOt: { hours: 0, amount: 0 },
    staffCounted: 0, onPayroll: 0, noPay: [], unended: [], settledOut: 0, calendarStaff: 0, throughDay: 0, monthDays: 0,
  }
  if (!period) return empty
  const { monthDays } = monthBounds(period)
  const td = Math.max(0, Math.min(monthDays, Number.isFinite(Number(throughDay)) && throughDay != null ? Math.floor(Number(throughDay)) : monthDays))
  const roster = payrollRoster({ employees, settlements, period })

  // The AD date of each counted BS day, once (YYYY-MM-DD strings compare lexically, as employedInPeriod).
  const dayAd = []
  for (let d = 1; d <= td; d++) dayAd[d] = formatAd(bsToAd(period.bs_year, period.bs_month, d))
  const countedDay = bsDay => bsDay == null || Number(bsDay) <= 0 || Number(bsDay) <= td

  const compsBy = groupBy((components || []).filter(c => c.type === 'earning'))
  const attBy = groupBy(attendance)
  const otBy = groupBy(otEntries)

  const out = {
    ...empty, throughDay: td, monthDays,
    onPayroll: roster.onPayroll.length,
    unended: roster.unended.map(named),
    settledOut: roster.settled.length,
  }

  for (const emp of roster.onPayroll) {
    const basic = parseFloat(emp.basic_salary)
    if (!(basic > 0)) { out.noPay.push(named(emp)); continue }
    if (td === 0) continue

    const join = day10(emp.join_date), end = day10(emp.end_date)
    const employedDays = []
    for (let d = 1; d <= td; d++) {
      if ((!join || dayAd[d] >= join) && (!end || dayAd[d] <= end)) employedDays.push(d)
    }
    if (employedDays.length === 0) continue
    out.staffCounted += 1

    const basis = emp.pay_basis || 'monthly'
    const employedSet = new Set(employedDays)
    const approved = (otBy.get(emp.id) || []).filter(e => countedDay(e.bs_day))
    const approvedDays = new Set(approved.map(e => e.bs_day).filter(d => d != null).map(Number))
    // Monthly pay docks the days outside the employment, so a sheet row there must not also count
    // (computePayslip, S791); daily and hourly staff are paid per row recorded, so they keep every row.
    const rows = (attBy.get(emp.id) || []).filter(a => countedDay(a.bs_day)
      && (basis !== 'monthly' || a.bs_day == null || employedSet.has(Number(a.bs_day))))
    const tally = tallyAttendance(rows, approvedDays)
    const markedDays = new Set(rows.map(a => Number(a.bs_day)).filter(d => d > 0))
    const blankDays = employedDays.filter(d => !markedDays.has(d)).length
    const hr = hourlyRateOf(basis, basic, monthDays)
    const enrolled = isSsfContributor(emp)

    let earned = 0, ssf = 0
    if (basis === 'daily') {
      const paidDays = rows.reduce((s, a) => s + (DAILY_WEIGHT[a.status] || 0), 0) + blankDays
      earned = basic * paidDays
      if (enrolled) ssf = Math.min(earned, SSF_CAP) * SSF_EMPLOYER_PCT
      if (blankDays > 0) out.calendarStaff += 1
    } else if (basis === 'hourly') {
      const regular = Math.max(0, tally.sumHours - tally.sumOt - tally.sumOtSuperseded)
      const paidHours = regular
        + (tally.paid_leave + tally.holiday) * STANDARD_HOURS_PER_DAY
        + tally.half_paid_leave * STANDARD_HOURS_PER_DAY * 0.5
        + blankDays * STANDARD_HOURS_PER_DAY
      earned = basic * paidHours
      if (enrolled) ssf = Math.min(earned, SSF_CAP) * SSF_EMPLOYER_PCT
      if (blankDays > 0) out.calendarStaff += 1
    } else {
      const allowances = (compsBy.get(emp.id) || []).reduce((s, c) => s + calcAmount(c, basic), 0)
      const perDay = monthDays > 0 ? (basic + allowances) / monthDays : 0
      const unpaid = rows.reduce((s, a) => s + (MONTHLY_UNPAID[a.status] || 0), 0)
      const paidDays = Math.max(0, employedDays.length - unpaid)
      earned = perDay * paidDays
      if (enrolled) ssf = estimatedEmployerSsf({ basis: 'monthly', basic, daysWorked: paidDays, monthDays })
    }
    out.gross += earned
    out.ssfEmployer += ssf

    // Sheet overtime on days with no approved entry, priced as payroll prices it.
    if (tally.sumOt > 0) {
      out.sheetOt.hours += tally.sumOt
      out.sheetOt.amount += tally.sumOt * hr * OT_MULTIPLIER
    }
    for (const e of approved) {
      const h = parseFloat(e.ot_hours) || 0
      if (!h) continue
      out.approvedOt.hours += h
      out.approvedOt.amount += h * hr * (e.ot_type === 'holiday' ? OT_HOLIDAY_MULTIPLIER : OT_MULTIPLIER)
    }
  }

  out.amount = out.gross + out.sheetOt.amount + out.approvedOt.amount + out.ssfEmployer
  return out
}
