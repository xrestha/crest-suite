// Pure payroll computation — no React, no Supabase. Reused by the payroll
// register and the payslip view. See memory: nepal-payroll-law.
import { daysInBsMonth } from '../../../utils/bsCalendar'
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
export function tallyAttendance(attendanceRows) {
  const t = { present: 0, half_day: 0, absent: 0, paid_leave: 0, unpaid_leave: 0, weekly_off: 0, holiday: 0, sumHours: 0, sumOt: 0 }
  attendanceRows.forEach(a => {
    if (t[a.status] != null) t[a.status] += 1
    t.sumHours += parseFloat(a.hours_worked) || 0
    t.sumOt    += parseFloat(a.ot_hours) || 0
  })
  return t
}

// Hourly rate for a given employee and period — used for OT entry pricing.
function hourlyRateOf(basis, basic, monthDays) {
  if (basis === 'hourly') return basic
  if (basis === 'daily')  return basic / STANDARD_HOURS_PER_DAY
  return monthDays > 0 ? basic / (monthDays * STANDARD_HOURS_PER_DAY) : 0
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
// `approvedOtEntries` is an array of approved hr_overtime_entries rows for this
// employee in this period — their OT amount is added on top of attendance OT.
// Returns an object whose keys match the hr_payslips columns.
export function computePayslip(employee, components, attendanceRows, period, tds = 0, approvedOtEntries = []) {
  const basis    = employee.pay_basis || 'monthly'
  const basic    = parseFloat(employee.basic_salary) || 0
  const enrolled = !!(employee.ssf_enrolled)
  const t        = tallyAttendance(attendanceRows)
  const tdsVal   = parseFloat(tds) || 0
  const monthDays = daysInBsMonth(period.bs_year, period.bs_month)
  const hr        = hourlyRateOf(basis, basic, monthDays)

  const base = {
    pay_basis: basis,
    basic,
    present_days: t.present + t.half_day * 0.5,
    absent_days:  t.absent,
    worked_days:  0,
    hours_worked: t.sumHours,
    ot_hours:     t.sumOt,
    tds:          tdsVal,
  }

  let result

  if (basis === 'daily') {
    const workedDays = t.present + t.half_day * 0.5
    const earned     = r(basic * workedDays)
    const otAmount   = r(t.sumOt * (basic / STANDARD_HOURS_PER_DAY) * OT_MULTIPLIER)
    const ssfEmp     = enrolled ? r(Math.min(earned, SSF_CAP) * SSF_EMPLOYEE_PCT) : 0
    const ssfEmpr    = enrolled ? r(Math.min(earned, SSF_CAP) * SSF_EMPLOYER_PCT) : 0
    result = {
      ...base, worked_days: workedDays,
      allowances: 0, gross: earned, absence_deduction: 0, other_deductions: 0,
      ot_amount: otAmount, ssf_employee: ssfEmp, ssf_employer: ssfEmpr,
      net_pay: earned + otAmount - ssfEmp - tdsVal,
    }
  } else if (basis === 'hourly') {
    const earned   = r(basic * t.sumHours)
    const otAmount = r(t.sumOt * basic * OT_MULTIPLIER)
    const ssfEmp   = enrolled ? r(Math.min(earned, SSF_CAP) * SSF_EMPLOYEE_PCT) : 0
    const ssfEmpr  = enrolled ? r(Math.min(earned, SSF_CAP) * SSF_EMPLOYER_PCT) : 0
    result = {
      ...base,
      allowances: 0, gross: earned, absence_deduction: 0, other_deductions: 0,
      ot_amount: otAmount, ssf_employee: ssfEmp, ssf_employer: ssfEmpr,
      net_pay: earned + otAmount - ssfEmp - tdsVal,
    }
  } else {
    // monthly
    const earnings    = components.filter(c => c.type === 'earning')
    const deductions  = components.filter(c => c.type === 'deduction')
    const allowances  = earnings.reduce((s, c)   => s + calcAmount(c, basic), 0)
    const otherDed    = deductions.reduce((s, c) => s + calcAmount(c, basic), 0)
    const gross       = basic + allowances
    const unpaidDays  = t.absent + t.unpaid_leave + t.half_day * 0.5
    const perDay      = monthDays > 0 ? basic / monthDays : 0
    const absenceDed  = r(perDay * unpaidDays)
    const otAmount    = r(t.sumOt * hr * OT_MULTIPLIER)
    const ssfBase     = Math.min(basic, SSF_CAP)
    const ssfEmp      = enrolled ? r(ssfBase * SSF_EMPLOYEE_PCT) : 0
    const ssfEmpr     = enrolled ? r(ssfBase * SSF_EMPLOYER_PCT) : 0
    result = {
      ...base,
      allowances, gross,
      absence_deduction: absenceDed,
      other_deductions:  otherDed,
      ot_amount:         otAmount,
      ssf_employee:      ssfEmp,
      ssf_employer:      ssfEmpr,
      net_pay: gross + otAmount - absenceDed - ssfEmp - otherDed - tdsVal,
    }
  }

  // Add OT from approved overtime entries on top of attendance OT.
  const { extraHrs, extraAmt } = entryOt(approvedOtEntries, hr)
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
