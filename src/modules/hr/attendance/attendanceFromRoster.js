// Pure logic for pre-filling hr_attendance from hr_roster — no React, no Supabase.
// Only ever fills gaps: a day/employee that already has an hr_attendance row is left untouched,
// so re-running this after manual overrides (leave, OT, corrections) never clobbers them.
import { bsToAd } from '../../../utils/bsCalendar'
import { WEEKLY_OFF_WEEKDAY } from '../payrollConstants'
import { shiftHours } from '../roster/laborForecast'

export function isSaturday(bsYear, bsMonth, bsDay, offWeekday = WEEKLY_OFF_WEEKDAY) {
  return bsToAd(bsYear, bsMonth, bsDay).getDay() === offWeekday
}

// rosterRows: hr_roster rows for the BS month (employee_id, shift_type_id, bs_day)
// shiftTypesById: { [shift_type_id]: hr_shift_types row }
// employeeIds: ids of active employees to consider
// existingDayKeys: Set of `${employee_id}:${bs_day}` already present in hr_attendance for this period
// days: array of bs_day numbers in the period (1..daysInBsMonth)
// offWeekday: 0=Sun..6=Sat, the client's configured weekly off day (defaults to Saturday)
// Returns hr_attendance row objects ready for scopedUpsert — never overlaps existingDayKeys.
export function buildAttendanceFromRoster({ rosterRows, shiftTypesById, employeeIds, existingDayKeys, bsYear, bsMonth, days, periodId, offWeekday = WEEKLY_OFF_WEEKDAY }) {
  const rosterByKey = {}
  rosterRows.forEach(r => { rosterByKey[`${r.employee_id}:${r.bs_day}`] = r })

  const rows = []
  employeeIds.forEach(empId => {
    days.forEach(day => {
      const key = `${empId}:${day}`
      if (existingDayKeys.has(key)) return

      const rosterRow = rosterByKey[key]
      // Some clients create custom zero-hour shift types (e.g. "LEAVE", "Day Off") purely to mark
      // exceptions on the roster board visually — those aren't real work, so a roster row only
      // counts as "present" when it resolves to actual hours. A zero-hour roster row still marks
      // the day (as 'holiday' — payroll-neutral, same as Weekly Off, just not tied to the
      // recurring weekday policy) rather than leaving a gap with no attendance row at all.
      const hours = rosterRow ? shiftHours(shiftTypesById[rosterRow.shift_type_id]) : 0
      if (rosterRow && hours > 0) {
        rows.push({
          employee_id:  empId,
          period_id:    periodId,
          bs_day:       day,
          status:       'present',
          hours_worked: hours,
          ot_hours:     0,
          note:         null,
        })
      } else if (isSaturday(bsYear, bsMonth, day, offWeekday)) {
        rows.push({
          employee_id:  empId,
          period_id:    periodId,
          bs_day:       day,
          status:       'weekly_off',
          hours_worked: 0,
          ot_hours:     0,
          note:         null,
        })
      } else if (rosterRow) {
        rows.push({
          employee_id:  empId,
          period_id:    periodId,
          bs_day:       day,
          status:       'holiday',
          hours_worked: 0,
          ot_hours:     0,
          note:         null,
        })
      }
    })
  })
  return rows
}
