// Pure payroll computation — no React, no Supabase. Reused by the payroll
// register and the payslip view. See memory: nepal-payroll-law.
import { daysInBsMonth } from '../../../utils/bsCalendar'
import {
  SSF_CAP, SSF_EMPLOYEE_PCT, SSF_EMPLOYER_PCT,
  OT_MULTIPLIER, STANDARD_HOURS_PER_DAY,
} from '../payrollConstants'

const r = n => Math.round((n + Number.EPSILON))

// Value of a salary component given the basic (mirrors SalaryList.jsx).
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

// Compute one payslip breakdown. `tds` is an optional manual override (default 0).
// Returns an object whose keys match the hr_payslips columns.
export function computePayslip(employee, components, attendanceRows, period, tds = 0) {
  const basis    = employee.pay_basis || 'monthly'
  const basic    = parseFloat(employee.basic_salary) || 0
  const enrolled = !!(employee.ssf_no && String(employee.ssf_no).trim())
  const t        = tallyAttendance(attendanceRows)
  const tdsVal   = parseFloat(tds) || 0
  const monthDays = daysInBsMonth(period.bs_year, period.bs_month)

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

  if (basis === 'daily') {
    const workedDays = t.present + t.half_day * 0.5
    const earned     = r(basic * workedDays)
    const otAmount   = r(t.sumOt * (basic / STANDARD_HOURS_PER_DAY) * OT_MULTIPLIER)
    const ssfEmp     = enrolled ? r(Math.min(earned, SSF_CAP) * SSF_EMPLOYEE_PCT) : 0
    const ssfEmpr    = enrolled ? r(Math.min(earned, SSF_CAP) * SSF_EMPLOYER_PCT) : 0
    return {
      ...base, worked_days: workedDays,
      allowances: 0, gross: earned, absence_deduction: 0, other_deductions: 0,
      ot_amount: otAmount, ssf_employee: ssfEmp, ssf_employer: ssfEmpr,
      net_pay: earned + otAmount - ssfEmp - tdsVal,
    }
  }

  if (basis === 'hourly') {
    const earned   = r(basic * t.sumHours)
    const otAmount = r(t.sumOt * basic * OT_MULTIPLIER)
    const ssfEmp   = enrolled ? r(Math.min(earned, SSF_CAP) * SSF_EMPLOYEE_PCT) : 0
    const ssfEmpr  = enrolled ? r(Math.min(earned, SSF_CAP) * SSF_EMPLOYER_PCT) : 0
    return {
      ...base,
      allowances: 0, gross: earned, absence_deduction: 0, other_deductions: 0,
      ot_amount: otAmount, ssf_employee: ssfEmp, ssf_employer: ssfEmpr,
      net_pay: earned + otAmount - ssfEmp - tdsVal,
    }
  }

  // monthly
  const earnings    = components.filter(c => c.type === 'earning')
  const deductions  = components.filter(c => c.type === 'deduction')
  const allowances  = earnings.reduce((s, c)   => s + calcAmount(c, basic), 0)
  const otherDed    = deductions.reduce((s, c) => s + calcAmount(c, basic), 0)
  const gross       = basic + allowances
  const unpaidDays  = t.absent + t.unpaid_leave + t.half_day * 0.5
  const perDay      = monthDays > 0 ? basic / monthDays : 0
  const absenceDed  = r(perDay * unpaidDays)
  const hourlyRate  = monthDays > 0 ? basic / (monthDays * STANDARD_HOURS_PER_DAY) : 0
  const otAmount    = r(t.sumOt * hourlyRate * OT_MULTIPLIER)
  const ssfBase     = Math.min(basic, SSF_CAP)
  const ssfEmp      = enrolled ? r(ssfBase * SSF_EMPLOYEE_PCT) : 0
  const ssfEmpr     = enrolled ? r(ssfBase * SSF_EMPLOYER_PCT) : 0

  return {
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
