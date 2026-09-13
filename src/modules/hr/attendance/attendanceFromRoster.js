// Pure logic for pre-filling hr_attendance from hr_roster — no React, no Supabase.
// Only ever fills gaps: a day/employee that already has an hr_attendance row is left untouched,
// so re-running this after manual overrides (leave, OT, corrections) never clobbers them.
// There's no more company-wide "weekly off weekday" — off days are whatever the roster actually
// says for that employee on that day, same source of truth SelfServiceHome.jsx already uses to
// grey out an employee's own off days (isOffDay/OFF_SHIFT_KEYWORDS).
import { isOffDay } from '../payrollConstants'
import { shiftHours, shiftOvertimeHours } from '../roster/laborForecast'

// The attendance status a zero-hour roster marker stands for. Before S742 every name containing
// "leave" became 'weekly_off' — so a rostered "LEAVE" (unpaid) paid a monthly employee in full and
// a rostered "PAID LEAVE" paid a daily-wage employee nothing. Order matters: "UNPAID LEAVE"
// contains "paid leave", so unpaid is tested first. A leave name that says neither is UNPAID — the
// client's decision (2026-09-13) for a plain "LEAVE"; a paid kind has to say so ("Paid Sick Leave").
// The Leave page stays the authority: an approved request has already written its days, and this
// only ever fills blanks.
export function zeroHourStatus(name) {
  const n = String(name || '').trim().toLowerCase()
  if (n.includes('leave')) {
    if (n.includes('unpaid') || n.includes('without pay')) return 'unpaid_leave'
    if (/(^|[^a-z])paid/.test(n)) return 'paid_leave'
    return 'unpaid_leave'
  }
  if (n.includes('holiday')) return 'holiday'
  // No name, or an off-named marker ("OFF DAY", "Day Off").
  if (isOffDay(name)) return 'weekly_off'
  // A zero-hour custom type named like none of those (unusual) — payroll-neutral, same as before.
  return 'holiday'
}

// rosterRows: hr_roster rows for the BS month (employee_id, shift_type_id, bs_day)
// shiftTypesById: { [shift_type_id]: hr_shift_types row }
// employeeIds: ids of active employees to consider
// existingDayKeys: Set of `${employee_id}:${bs_day}` already present in hr_attendance for this period
// days: array of bs_day numbers in the period (1..daysInBsMonth)
// Returns hr_attendance row objects ready for scopedUpsert — never overlaps existingDayKeys.
export function buildAttendanceFromRoster({ rosterRows, shiftTypesById, employeeIds, existingDayKeys, days, periodId }) {
  const rosterByKey = {}
  rosterRows.forEach(r => { rosterByKey[`${r.employee_id}:${r.bs_day}`] = r })

  const rows = []
  employeeIds.forEach(empId => {
    days.forEach(day => {
      const key = `${empId}:${day}`
      if (existingDayKeys.has(key)) return

      const rosterRow = rosterByKey[key]
      if (!rosterRow) return // no roster signal at all — leave it for manual entry, nothing to infer

      // Some clients create custom zero-hour shift types (e.g. "OFF DAY", "LEAVE", "Public
      // Holiday") purely to mark exceptions on the roster board visually — those aren't real
      // work, so a roster row only counts as "present" when it resolves to actual hours.
      const shiftType = shiftTypesById[rosterRow.shift_type_id]
      const hours = shiftHours(shiftType)
      if (hours > 0) {
        rows.push({
          employee_id:  empId,
          period_id:    periodId,
          bs_day:       day,
          status:       'present',
          hours_worked: hours,
          // The shift's length beyond its Normal hours (S742) — 0 when none are set, as before.
          ot_hours:     shiftOvertimeHours(shiftType),
          note:         null,
        })
      } else {
        rows.push({
          employee_id:  empId,
          period_id:    periodId,
          bs_day:       day,
          status:       zeroHourStatus(shiftType?.name),
          hours_worked: 0,
          ot_hours:     0,
          note:         null,
        })
      }
    })
  })
  return rows
}
