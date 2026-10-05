// Pure logic for pre-filling hr_attendance from hr_roster — no React, no Supabase.
// Only ever fills gaps: a day/employee that already has an hr_attendance row is left untouched,
// so re-running this after manual overrides (leave, OT, corrections) never clobbers them.
// There's no more company-wide "weekly off weekday" — off days are whatever the roster actually
// says for that employee on that day, same source of truth SelfServiceHome.jsx already uses to
// grey out an employee's own off days (shift_kind / `shiftKind`, S798). Generate keys on HOURS, so a
// shift with hours is Present whatever its name; `shiftKind` agrees, except that a leave-named
// shift with hours set is leave there.
import { shiftHours, shiftOvertimeHours, shiftRegularHours, hasUnknownHours, isOnDutyShift } from '../roster/laborForecast'
import { STANDARD_HOURS_PER_DAY } from '../payrollConstants'

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
  // No name, an off-named marker ("OFF DAY", "Day Off"), or a zero-hour custom type named like none
  // of these ("Training"). The last used to become Holiday, which was harmless while Holiday paid
  // nobody extra — since S749 a Holiday day PAYS daily and hourly staff (Labour Act s.41), so only a
  // shift that says "holiday" may produce one. Off is unpaid for them and neutral for monthly staff.
  return 'weekly_off'
}

// rosterRows: hr_roster rows for the BS month (employee_id, shift_type_id, bs_day)
// shiftTypesById: { [shift_type_id]: hr_shift_types row }
// employeeIds: ids of active employees to consider
// existingDayKeys: Set of `${employee_id}:${bs_day}` already present in hr_attendance for this period
// days: array of bs_day numbers in the period (1..daysInBsMonth)
// blockOf: optional (employeeId, day) → 'before_joining' | 'after_leaving' | 'future' | null
//   (attendanceRules' dayBlock). A blocked day is left blank and counted (S798, ATTENDANCE-5, H7 (a)).
// Returns { rows, skipped, unknownHours }: hr_attendance row objects ready for scopedUpsert (never
// overlapping existingDayKeys), the rostered blank days left alone by reason, and how many rows are
// on a working shift with no hours set (ATTENDANCE-2), which the confirm names on their own line.
export function planAttendanceFromRoster({ rosterRows, shiftTypesById, employeeIds, existingDayKeys, days, periodId, blockOf }) {
  const rosterByKey = {}
  rosterRows.forEach(r => { rosterByKey[`${r.employee_id}:${r.bs_day}`] = r })

  const rows = []
  const skipped = { before_joining: 0, after_leaving: 0, future: 0 }
  let unknownHours = 0
  employeeIds.forEach(empId => {
    days.forEach(day => {
      const key = `${empId}:${day}`
      if (existingDayKeys.has(key)) return

      const rosterRow = rosterByKey[key]
      if (!rosterRow) return // no roster signal at all — leave it for manual entry, nothing to infer

      const block = blockOf ? blockOf(empId, day) : null
      if (block) { skipped[block] += 1; return }

      const shiftType = shiftTypesById[rosterRow.shift_type_id]
      // A working shift nobody gave a length to (the ready-made "Split": no hours, no times) is a
      // day worked, not a day off (H10 (a)): an ordinary 8-hour day with no overtime, the way a day
      // with no roster entry is measured. It used to fall to the zero-hour branch below and become
      // Off, so a daily-wage worker rostered Split was paid nothing for the day.
      if (hasUnknownHours(shiftType)) {
        unknownHours += 1
        rows.push({
          employee_id:  empId,
          period_id:    periodId,
          bs_day:       day,
          status:       'present',
          hours_worked: STANDARD_HOURS_PER_DAY,
          ot_hours:     0,
          note:         null,
        })
        return
      }

      // Some clients create custom zero-hour shift types (e.g. "OFF DAY", "LEAVE", "Public
      // Holiday") purely to mark exceptions on the roster board visually — those aren't real
      // work, so a roster row only counts as "present" when it resolves to actual hours.
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
  return { rows, skipped, unknownHours }
}

// The rows alone, for a caller that needs no counts.
export function buildAttendanceFromRoster(args) {
  return planAttendanceFromRoster(args).rows
}

// What a rostered day on this shift type becomes in Attendance, as one comparable string: the row
// Generate writes, the length typed or imported times are measured against, and whether a no-show is
// Absent. Shift Types compares the shape before and after an edit; when it moves, the edit changes pay
// on every rostered day not yet generated, so it asks from which day (S798, ROSTER-1, H12 (a)).
// A rename that changes nothing here (a working shift, or "Day Off" → "OFF DAY") does not ask.
export function rosterDayShape(shift) {
  if (!shift) return 'none'
  const regular = shiftRegularHours(shift) ?? ''
  if (hasUnknownHours(shift)) return `present|${STANDARD_HOURS_PER_DAY}|0|${regular}|duty`
  const hours = shiftHours(shift)
  const duty = isOnDutyShift(shift) ? 'duty' : 'off'
  if (hours > 0) return `present|${hours}|${shiftOvertimeHours(shift)}|${regular}|${duty}`
  return `marker|${zeroHourStatus(shift.name)}|${duty}`
}

// The leave or holiday status a roster cell stands for when it is a DATED marker, else null (S798,
// ROSTER-10): a zero-hour marker that Generate from Roster turns into paid or unpaid leave or a paid
// holiday. Those belong to their dates, not to a weekly pattern, so Copy to Next Week neither copies
// one forward nor overwrites or clears one already there. A Day Off is a pattern and copies. The
// branches are rosterDayShape's: unknown hours and any hours are worked days, never markers.
export function datedMarkerStatus(shift) {
  if (!shift || hasUnknownHours(shift) || shiftHours(shift) > 0) return null
  const status = zeroHourStatus(shift.name)
  return status === 'weekly_off' ? null : status
}
