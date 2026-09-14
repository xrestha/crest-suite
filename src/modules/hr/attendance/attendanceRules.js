// Pure rules for the Attendance sheet — no React, no Supabase (S749).
//
// Three decisions made with Aashish on 2026-09-14 live here so the sheet's two tabs, its save
// path and the Leave page's approval write cannot each hold their own copy.

// A day on one of these statuses was not worked, so it carries no clock times, no hours and no
// overtime. `tallyAttendance` adds `ot_hours` from EVERY row whatever its status, and the hourly
// branch pays `hours_worked` the same way — so a day switched from Present to Absent kept paying
// the overtime (and, for an hourly employee, the hours) typed on it before. Found live: an Off day
// carrying 9 hours. The half-day statuses are deliberately absent: half of that day was worked.
export const NON_WORKING_STATUSES = new Set(['absent', 'paid_leave', 'unpaid_leave', 'weekly_off', 'holiday'])

export const isNonWorking = status => NON_WORKING_STATUSES.has(status)

// The clock/hours fields a non-working day must not carry, as the sheet holds them (blank strings).
const CLEARED_CELL = { start_time: '', end_time: '', break_minutes: '', hours_worked: '', ot_hours: '' }

/** A cell with its status set — and, on a non-working status, its hours cleared with it. */
export function withStatus(rec, status) {
  return isNonWorking(status) ? { ...rec, ...CLEARED_CELL, status } : { ...rec, status }
}

/**
 * Bulk-mark only the cells nobody has marked yet (decided 2026-09-14).
 *
 * "All Present" used to overwrite every cell in the row or column, so pressing it after leave had
 * been approved turned the approved leave days into Present on the next save — an unpaid leave
 * then stopped deducting while the Leave page still read Approved. It fills blanks now, and the
 * counts come back so the sheet can say what it left alone.
 *
 * @param {Object} records  `${employee_id}:${bs_day}` → cell
 * @param {Array<{key: string, employeeId: string, day: number}>} cells
 * @returns {{ next: Object, filled: number, kept: number }}
 */
export function fillBlankCells(records, cells, status) {
  const next = { ...records }
  let filled = 0, kept = 0
  for (const c of cells) {
    if (next[c.key]) { kept += 1; continue }
    next[c.key] = withStatus({ employee_id: c.employeeId, bs_day: c.day }, status)
    filled += 1
  }
  return { next, filled, kept }
}

/**
 * The hr_attendance row a sheet cell saves as. A non-working status saves no times, hours or
 * overtime even if the cell was loaded carrying some — which is how a row written before S749
 * gets corrected the next time its day is saved.
 */
export function attendanceRowFor(rec, { employeeId, periodId, day, isValidTime }) {
  const status = rec.status ?? 'present'
  if (isNonWorking(status)) {
    return {
      employee_id: employeeId, period_id: periodId, bs_day: day, status,
      hours_worked: 0, ot_hours: 0, break_minutes: null, note: rec.note || null,
      start_time: null, end_time: null,
    }
  }
  return {
    employee_id:  employeeId,
    period_id:    periodId,
    bs_day:       day,
    status,
    hours_worked: parseFloat(rec.hours_worked) || 0,
    ot_hours:     parseFloat(rec.ot_hours) || 0,
    break_minutes: parseFloat(rec.break_minutes) || null,
    note:         rec.note || null,
    // An invalid/partial typed time never reaches the DB's `time` column — it just isn't saved
    // (the admin still sees what they typed on screen until they fix or clear it).
    start_time:   isValidTime(rec.start_time) ? (rec.start_time || null) : null,
    end_time:     isValidTime(rec.end_time)   ? (rec.end_time   || null) : null,
  }
}
