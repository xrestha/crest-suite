// Pure payroll computation — no React, no Supabase. Reused by the payroll
// register and the payslip view. See memory: nepal-payroll-law.
import { daysInBsMonth, bsToAd } from '../../../utils/bsCalendar'
import {
  SSF_CAP, SSF_EMPLOYEE_PCT, SSF_EMPLOYER_PCT,
  OT_MULTIPLIER, OT_HOLIDAY_MULTIPLIER, STANDARD_HOURS_PER_DAY,
} from '../payrollConstants'

const r = n => Math.round((n + Number.EPSILON))

// Value of a salary component given the basic salary.
export function calcAmount(comp, basic) {
  const v = parseFloat(comp.value) || 0
  if (comp.calc_type === 'percent_of_basic') return Math.round((parseFloat(basic) || 0) * v / 100)
  return Math.round(v)
}

// Tally an employee's attendance rows for the period.
//
// `supersededOtDays` is an optional Set of bs_days on which an APPROVED overtime entry exists.
// OT typed on the attendance sheet for those days is not counted (see computePayslip) — the two
// sources are alternatives, not addends. Callers that don't care pass nothing and behave exactly
// as before; `sumOtSuperseded` reports what was withheld so a page can explain the difference.
export function tallyAttendance(attendanceRows, supersededOtDays) {
  const t = {
    present: 0, half_day: 0, absent: 0, paid_leave: 0, unpaid_leave: 0,
    half_paid_leave: 0, half_unpaid_leave: 0, weekly_off: 0, holiday: 0,
    sumHours: 0, sumOt: 0, sumOtSuperseded: 0,
  }
  attendanceRows.forEach(a => {
    if (t[a.status] != null) t[a.status] += 1
    t.sumHours += parseFloat(a.hours_worked) || 0
    const ot = parseFloat(a.ot_hours) || 0
    if (supersededOtDays && supersededOtDays.has(a.bs_day)) t.sumOtSuperseded += ot
    else                                                    t.sumOt += ot
  })
  return t
}

// Hourly rate for a given employee and period — used for OT entry pricing, and reused (not the
// whole payroll engine) by the Roster board's live labor-cost overlay (laborForecast.js).
export function hourlyRateOf(basis, basic, monthDays) {
  if (basis === 'hourly') return basic
  if (basis === 'daily')  return basic / STANDARD_HOURS_PER_DAY
  return monthDays > 0 ? basic / (monthDays * STANDARD_HOURS_PER_DAY) : 0
}

// Days within this BS period that fall before the employee's join date — folded into unpaidDays
// below so a newly hired employee (or one who joins mid-period) is paid only for days they've
// actually been employed, not a full contractual month. Attendance rows can't exist for days
// before an employee's record was even created, so without this a monthly employee joining after
// (or partway through) a period would otherwise draw full basic + allowances for days they never
// worked — daily/hourly staff don't have this gap since their pay is derived from attendance rows
// directly, which are naturally absent for pre-join days.
function daysNotYetJoined(joinDateStr, period, monthDays) {
  if (!joinDateStr) return 0
  const [jy, jm, jd] = joinDateStr.split('-').map(Number)
  if (!jy || !jm || !jd) return 0
  const join = new Date(jy, jm - 1, jd)
  let count = 0
  for (let d = 1; d <= monthDays; d++) {
    if (bsToAd(period.bs_year, period.bs_month, d) < join) count++
  }
  return count
}

// The mirror of daysNotYetJoined, for the other end of the employment. Days within this BS period
// that fall AFTER the employee's last working day, folded into the same unpaidDays sum.
//
// Without it a leaver drew a full contractual month for a month they worked part of, and Final
// Settlement then added its own partial-month figure on top — the same month paid roughly 1.5
// times. Running the settlement first instead simply dropped them out of the payroll picker
// (every picker filters status IN ('active','probation')), losing their allowances, overtime and
// that month's SSF entirely. Neither ordering was right, and neither page said so; with this the
// two converge. Added S600.
//
// Deliberately NOT implemented by writing 'absent' attendance rows for the post-exit days:
// `absent_days` is a reported figure (Payroll Run's Excel column, HR Reports) and that would
// misreport a departure as absenteeism.
function daysAfterExit(endDateStr, period, monthDays) {
  if (!endDateStr) return 0
  const [ey, em, ed] = endDateStr.split('-').map(Number)
  if (!ey || !em || !ed) return 0
  const end = new Date(ey, em - 1, ed)
  let count = 0
  for (let d = 1; d <= monthDays; d++) {
    // Strictly after: the last working day itself is worked and paid.
    if (bsToAd(period.bs_year, period.bs_month, d) > end) count++
  }
  return count
}

// Compute OT amount from approved hr_overtime_entries rows.
// Weekday entries at 1.5×, holiday entries at 2×.
function entryOt(approvedOtEntries, hr) {
  let weekdayHrs = 0, holidayHrs = 0
  approvedOtEntries.forEach(e => {
    const h = parseFloat(e.ot_hours) || 0
    if (e.ot_type === 'holiday') holidayHrs += h
    else                          weekdayHrs += h
  })
  return {
    extraHrs: weekdayHrs + holidayHrs,
    extraAmt: r(weekdayHrs * hr * OT_MULTIPLIER + holidayHrs * hr * OT_HOLIDAY_MULTIPLIER),
  }
}

// Compute one payslip breakdown.
// `tds` is an optional manual override (default 0).
// `approvedOtEntries` is an array of approved hr_overtime_entries rows for this employee in this
// period. Approved entries SUPERSEDE attendance-sheet OT on the same bs_day (decision 2026-08-18,
// same shape as POS-supersedes-manual in sales depletion): the Overtime module is the approval
// path and carries the holiday 2× rate, so where both exist the approved figure is the one that
// was actually authorised. Days with no approved entry still pay their attendance OT at 1.5×.
// Returns an object whose keys match the hr_payslips columns.
export function computePayslip(employee, components, attendanceRows, period, tds = 0, approvedOtEntries = [], advanceDeduction = 0) {
  const basis    = employee.pay_basis || 'monthly'
  const basic    = parseFloat(employee.basic_salary) || 0
  // SSF requires BOTH the enrolment flag and a registration number (decision 2026-08-18). Until
  // then the flag alone deducted 11% while HrReports' challan tab filters on `ssf_no` too — so a
  // flagged employee with a blank number had money withheld that no filing sheet ever claimed.
  // Deducting nothing is the recoverable direction; the number is entered once, in Pay Setup.
  const enrolled = !!(employee.ssf_enrolled && String(employee.ssf_no || '').trim())
  const supersededOtDays = new Set(
    approvedOtEntries.map(e => e.bs_day).filter(d => d != null)
  )
  const t        = tallyAttendance(attendanceRows, supersededOtDays)
  const tdsVal   = parseFloat(tds) || 0
  const advDed   = Math.round(parseFloat(advanceDeduction) || 0)
  const monthDays = daysInBsMonth(period.bs_year, period.bs_month)
  const hr        = hourlyRateOf(basis, basic, monthDays)

  const base = {
    pay_basis: basis,
    basic,
    present_days:      t.present + t.half_day * 0.5 + t.half_paid_leave * 0.5,
    absent_days:       t.absent,
    // Every day the absence deduction actually docks — absences PLUS unpaid leave, half days and
    // pre-join days. `absent_days` stays literal absences (Payroll Run's Excel column is labelled
    // "Absent Days"), so the payslip needs its own figure: it prints this count beside the dock,
    // and printing t.absent there understated it whenever any other unpaid component existed.
    unpaid_days:       0,
    worked_days:       0,
    hours_worked:      t.sumHours,
    ot_hours:          t.sumOt,
    tds:               tdsVal,
    advance_deduction: advDed,
  }

  let result

  if (basis === 'daily') {
    // Paid-leave days are paid for daily-wage staff too — that's what makes the leave "paid".
    const workedDays = t.present + t.half_day * 0.5 + t.paid_leave + t.half_paid_leave * 0.5
    const earned     = r(basic * workedDays)
    const otAmount   = r(t.sumOt * (basic / STANDARD_HOURS_PER_DAY) * OT_MULTIPLIER)
    const ssfEmp     = enrolled ? r(Math.min(earned, SSF_CAP) * SSF_EMPLOYEE_PCT) : 0
    const ssfEmpr    = enrolled ? r(Math.min(earned, SSF_CAP) * SSF_EMPLOYER_PCT) : 0
    result = {
      ...base, worked_days: workedDays,
      allowances: 0, gross: earned, absence_deduction: 0, other_deductions: 0,
      ot_amount: otAmount, ssf_employee: ssfEmp, ssf_employer: ssfEmpr,
      net_pay: earned + otAmount - ssfEmp - tdsVal - advDed,
      breakdown: { basis, monthDays, tally: t, dailyRate: basic, workedDays, hourlyRate: basic / STANDARD_HOURS_PER_DAY, otAttendanceHrs: t.sumOt, otAttendanceAmt: otAmount, ssfBase: Math.min(earned, SSF_CAP) },
    }
  } else if (basis === 'hourly') {
    // Paid-leave days credit a standard working day of hours for hourly staff.
    const paidHours = t.sumHours + t.paid_leave * STANDARD_HOURS_PER_DAY + t.half_paid_leave * STANDARD_HOURS_PER_DAY * 0.5
    const earned   = r(basic * paidHours)
    const otAmount = r(t.sumOt * basic * OT_MULTIPLIER)
    const ssfEmp   = enrolled ? r(Math.min(earned, SSF_CAP) * SSF_EMPLOYEE_PCT) : 0
    const ssfEmpr  = enrolled ? r(Math.min(earned, SSF_CAP) * SSF_EMPLOYER_PCT) : 0
    result = {
      ...base,
      allowances: 0, gross: earned, absence_deduction: 0, other_deductions: 0,
      ot_amount: otAmount, ssf_employee: ssfEmp, ssf_employer: ssfEmpr,
      net_pay: earned + otAmount - ssfEmp - tdsVal - advDed,
      breakdown: { basis, monthDays, tally: t, hourlyRate: basic, paidHours, otAttendanceHrs: t.sumOt, otAttendanceAmt: otAmount, ssfBase: Math.min(earned, SSF_CAP) },
    }
  } else {
    // monthly
    const earnings    = components.filter(c => c.type === 'earning')
    const deductions  = components.filter(c => c.type === 'deduction')
    const allowances  = earnings.reduce((s, c)   => s + calcAmount(c, basic), 0)
    const otherDed    = deductions.reduce((s, c) => s + calcAmount(c, basic), 0)
    const gross       = basic + allowances
    const preJoinDays  = daysNotYetJoined(employee.join_date, period, monthDays)
    const postExitDays = daysAfterExit(employee.end_date, period, monthDays)
    // A month can contain both a join and an exit (a short spell). The two windows are disjoint by
    // construction — before the join, after the exit — so they add; the clamp only guards the
    // nonsense case of an end_date earlier than the join_date, where they would overlap and
    // otherwise deduct more days than the month has.
    const notEmployedDays = Math.min(monthDays, preJoinDays + postExitDays)
    const unpaidDays  = t.absent + t.unpaid_leave + t.half_day * 0.5 + t.half_unpaid_leave * 0.5 + notEmployedDays
    // Unpaid days forfeit the whole day's pay — allowances included, not just the basic
    // portion (otherwise a full-month absence would still pay full allowances).
    const perDay      = monthDays > 0 ? gross / monthDays : 0
    const absenceDed  = r(perDay * unpaidDays)
    const otAmount    = r(t.sumOt * hr * OT_MULTIPLIER)
    // SSF is contributed on the basic actually earned this month (basic minus the unpaid-day
    // share of basic), capped — keeps deductions from exceeding pay in heavy-absence months.
    const paidFraction = monthDays > 0 ? Math.max(0, 1 - unpaidDays / monthDays) : 1
    const ssfBase     = Math.min(basic * paidFraction, SSF_CAP)
    const ssfEmp      = enrolled ? r(ssfBase * SSF_EMPLOYEE_PCT) : 0
    const ssfEmpr     = enrolled ? r(ssfBase * SSF_EMPLOYER_PCT) : 0
    result = {
      ...base,
      allowances, gross,
      unpaid_days:       unpaidDays,
      absence_deduction: absenceDed,
      other_deductions:  otherDed,
      ot_amount:         otAmount,
      ssf_employee:      ssfEmp,
      ssf_employer:      ssfEmpr,
      net_pay: gross + otAmount - absenceDed - ssfEmp - otherDed - tdsVal - advDed,
      breakdown: { basis, monthDays, tally: t, hourlyRate: hr, gross, unpaidDays, perDay, paidFraction, ssfBase, preJoinDays, postExitDays, notEmployedDays, otAttendanceHrs: t.sumOt, otAttendanceAmt: otAmount },
    }
  }

  // Add OT from approved overtime entries. Attendance OT for those same days was already withheld
  // by tallyAttendance above, so this ADDS to a total that no longer contains the superseded
  // hours — the two sources can't double-pay a day any more. `otSupersededHrs` records what the
  // approval displaced so the Calculation page can explain a figure that differs from the
  // attendance sheet, rather than the user finding an unexplained gap.
  const { extraHrs, extraAmt } = entryOt(approvedOtEntries, hr)
  result.breakdown = {
    ...result.breakdown,
    otApprovedHrs: extraHrs, otApprovedAmt: extraAmt,
    otSupersededHrs: t.sumOtSuperseded,
  }
  if (extraHrs > 0) {
    result = {
      ...result,
      ot_hours:  result.ot_hours + extraHrs,
      ot_amount: result.ot_amount + extraAmt,
      net_pay:   result.net_pay + extraAmt,
    }
  }

  return result
}
