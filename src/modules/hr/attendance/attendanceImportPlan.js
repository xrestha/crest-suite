// What an imported file does to the attendance sheet — no React, no Supabase (S775).
//
// Four decisions taken with Aashish (2026-09-17) live here, so the dialog's review and the sheet's
// apply cannot each hold a copy:
//   1. People are matched by the reader on every import — nothing is remembered (the dialog).
//   2. A day with no punch follows the roster: rostered off → Off (or the leave or holiday its
//      name says), rostered to work → Absent, not on the roster → left blank.
//   3. An incomplete day (one punch, or in and out under an hour apart) comes in as Present with
//      the times the machine has, hours left blank, and is flagged for the reader to fix.
//   4. A day already on the sheet is never overwritten, except that a Present day takes the
//      machine's in and out times — each such change listed, and can be unticked.
// Two more guard the roster rule from marking days that have not happened: nothing is marked
// after today, and a day with no punch yet TODAY is left alone. Days before an employee joined or
// after they left are not marked either.
import { adToBs } from '../../../utils/bsCalendar'
import { withStatus, isNonWorking } from './attendanceRules'
import { zeroHourStatus } from './attendanceFromRoster'
import { isOnDutyShift } from '../roster/laborForecast'

export const SKIP = 'skip'
// Under an hour between in and out is a double tap or a mistake, not a shift; over 16 hours is a
// missed punch-out that caught the next morning's punch-in.
export const SHORT_DAY_MIN = 60
export const LONG_DAY_MIN = 16 * 60

const minutesOf = t => {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/)
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null
}
const spanMinutes = (a, b) => { const d = minutesOf(b) - minutesOf(a); return d < 0 ? d + 1440 : d }

/** 'complete' | 'odd' | 'mark' | 'none' — what the file says about one day. */
export function machineDayKind(day) {
  if (!day) return 'none'
  if (day.in && day.out) {
    const span = spanMinutes(day.in, day.out)
    return span >= SHORT_DAY_MIN && span <= LONG_DAY_MIN ? 'complete' : 'odd'
  }
  if (day.in || day.out) return 'odd'
  return day.mark ? 'mark' : 'none'
}

/** The machine's record of a day in words: "8:05–20:00", "20:01 only", "11:30–11:31, 1 min apart". */
export function describeMachineDay(day) {
  if (!day) return 'no punch'
  if (day.in && day.out) {
    const span = spanMinutes(day.in, day.out)
    const range = `${day.in}–${day.out}`
    if (span < SHORT_DAY_MIN) return `${range}, ${span} min apart`
    if (span > LONG_DAY_MIN) return `${range}, ${Math.floor(span / 60)}h ${span % 60}m apart`
    return range
  }
  if (day.in) return `${day.in} only`
  if (day.out) return `out ${day.out} only`
  return day.mark || 'no punch'
}

// An AD 'YYYY-MM-DD' column as a comparable BS number, built from its parts: `new Date('YYYY-MM-DD')`
// is UTC midnight, which lands on the previous day at Nepal's +05:45.
function bsOrdinal(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  const bs = adToBs(new Date(+m[1], +m[2] - 1, +m[3]))
  return bs.year * 10000 + bs.month * 100 + bs.day
}

const LEAVE_OR_HOLIDAY = new Set(['paid_leave', 'unpaid_leave', 'holiday'])

/**
 * The changes an import makes, and a count of everything it did not.
 *
 * @param people          readAttendance(...).people
 * @param coverage        readAttendance(...).coverage — the days the file speaks for
 * @param matches         { [personKey]: employeeId | SKIP }
 * @param employees       [{ id, full_name, join_date, end_date }]
 * @param records         the sheet's cells, unsaved edits included: `${employee_id}:${bs_day}` → cell
 * @param rosterByKey     `${employee_id}:${bs_day}` → shift_type_id (the key present = on the roster)
 * @param shiftTypesById  shift_type_id → hr_shift_types row
 * @param autoHours       (employeeId, day, start, end, breakMinutes) → { hours_worked, ot_hours } | null
 *                        — the sheet's own auto-calc, so an imported day measures OT exactly as a typed one
 * @param today           { year, month, day } in BS
 * @returns {{
 *   changes: Array<{ key, employeeId, day, kind: 'worked'|'updated'|'flagged'|'marked'|'absent'|'off', cell, before, machine }>,
 *   conflicts: Array<{ key, employeeId, day, status, machine }>,
 *   byEmployee: { [employeeId]: counts },
 *   skipped: { future, notEmployed },
 * }}
 */
export function planImport({ people, coverage, matches, employees, records, period, rosterByKey, shiftTypesById, autoHours, breakMinutes, today }) {
  const empById = new Map(employees.map(e => [e.id, e]))
  const breakValue = Number(breakMinutes) > 0 ? Number(breakMinutes) : ''
  const todayOrdinal = today.year * 10000 + today.month * 100 + today.day
  const changes = [], conflicts = []
  const byEmployee = {}
  const skipped = { future: 0, notEmployed: 0 }

  for (const person of people) {
    const employeeId = matches[person.key]
    const emp = employeeId && employeeId !== SKIP ? empById.get(employeeId) : null
    if (!emp) continue
    const counts = byEmployee[emp.id] ||= { worked: 0, updated: 0, flagged: 0, marked: 0, absent: 0, off: 0, blank: 0, kept: 0 }
    const joined = bsOrdinal(emp.join_date), left = bsOrdinal(emp.end_date)

    for (const day of coverage) {
      const ordinal = period.bs_year * 10000 + period.bs_month * 100 + day
      const machineDay = person.days[day]
      const kind = machineDayKind(machineDay)
      if (ordinal > todayOrdinal || (ordinal === todayOrdinal && kind === 'none')) { skipped.future += 1; continue }
      if ((joined && ordinal < joined) || (left && ordinal > left)) { skipped.notEmployed += 1; continue }

      const key = `${emp.id}:${day}`
      const existing = records[key]
      // A cell with no status saves as Present (attendanceRowFor), so it is read as one here.
      const existingStatus = existing ? (existing.status ?? 'present') : null
      const base = { employee_id: emp.id, bs_day: day }
      const machine = describeMachineDay(machineDay)
      const change = (k, cell) => { changes.push({ key, employeeId: emp.id, day, kind: k, cell, before: existing, machine }); counts[k] += 1 }
      const conflict = () => { conflicts.push({ key, employeeId: emp.id, day, status: existingStatus, machine }); counts.kept += 1 }

      if (kind === 'complete') {
        const timed = (rec, breakMin) => {
          const auto = autoHours(emp.id, day, machineDay.in, machineDay.out, breakMin)
          return { ...rec, start_time: machineDay.in, end_time: machineDay.out, break_minutes: breakMin, hours_worked: auto ? auto.hours_worked : '', ot_hours: auto ? auto.ot_hours : '' }
        }
        if (!existing) { change('worked', timed({ ...base, status: 'present', note: '' }, breakValue)); continue }
        if (existingStatus !== 'present') {
          if (isNonWorking(existingStatus)) conflict(); else counts.kept += 1
          continue
        }
        if (minutesOf(existing.start_time) === minutesOf(machineDay.in) && minutesOf(existing.end_time) === minutesOf(machineDay.out)) { counts.kept += 1; continue }
        const keptBreak = existing.break_minutes != null && existing.break_minutes !== '' ? existing.break_minutes : breakValue
        change('updated', timed(existing, keptBreak))
        continue
      }

      if (kind === 'odd') {
        if (existing) {
          if (isNonWorking(existingStatus)) conflict(); else counts.kept += 1
          continue
        }
        change('flagged', { ...base, status: 'present', start_time: machineDay.in || '', end_time: machineDay.out || '', break_minutes: '', hours_worked: '', ot_hours: '', note: '' })
        continue
      }

      if (kind === 'mark') {
        if (!existing) { change('marked', withStatus(base, machineDay.mark)); continue }
        if (existingStatus !== machineDay.mark) conflict(); else counts.kept += 1
        continue
      }

      // No punch: the roster decides (decision 2).
      if (existing) { counts.kept += 1; continue }
      if (!(key in rosterByKey)) { counts.blank += 1; continue }
      const shift = shiftTypesById[rosterByKey[key]]
      const status = shift?.name ? zeroHourStatus(shift.name) : 'weekly_off'
      if (isOnDutyShift(shift) && !LEAVE_OR_HOLIDAY.has(status)) change('absent', withStatus(base, 'absent'))
      else change('off', withStatus(base, status))
    }
  }
  return { changes, conflicts, byEmployee, skipped }
}

/**
 * Whether an imported day still needs the reader: it is on the sheet, it is a working day, and its
 * times still do not make a whole shift. Typing the missing time, or marking the day Absent or Off,
 * settles it.
 */
export function stillIncomplete(rec) {
  if (!rec || isNonWorking(rec.status)) return false
  const start = minutesOf(rec.start_time), end = minutesOf(rec.end_time)
  if (start == null || end == null) return true
  const span = end - start < 0 ? end - start + 1440 : end - start
  return span < SHORT_DAY_MIN || span > LONG_DAY_MIN
}
