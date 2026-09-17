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
 * A cell reduced to what it SAVES as, so two cells that would write the same row compare equal
 * (S768). The sheet holds what was typed — "0800", "7.50", '' — while a reloaded row holds what
 * Postgres returned — "08:00:00", 7.5, null — and comparing those raw would call every saved cell
 * unsaved. `timeKey` canonicalises a clock time and must return a typed-but-unparseable one as
 * itself, so a half-typed time still counts as an edit the reader has not saved.
 */
export function cellSignature(rec, timeKey) {
  if (!rec) return ''
  const status = rec.status ?? 'present'
  const note = rec.note || ''
  if (isNonWorking(status)) return [status, '', '', '', '', '', note].join('|')
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) && n !== 0 ? String(n) : '' }
  return [status, timeKey(rec.start_time) || '', timeKey(rec.end_time) || '',
    num(rec.break_minutes), num(rec.hours_worked), num(rec.ot_hours), note].join('|')
}

/**
 * The cells on screen that differ from what was last read from the database — the sheet's unsaved
 * edits, across every day and every employee, not only the day being looked at (S768).
 *
 * Only keys still in `records` are considered: clearing a cell deletes its row straight away, so a
 * key that has left `records` is not an edit waiting for Save.
 */
export function unsavedKeys(records, saved, timeKey) {
  const keys = []
  for (const [key, rec] of Object.entries(records)) {
    if (cellSignature(rec, timeKey) !== cellSignature(saved[key], timeKey)) keys.push(key)
  }
  return keys
}

/** `${employee_id}:${bs_day}` → its two parts. Employee ids are uuids, which carry no colon. */
export function splitCellKey(key) {
  const i = key.lastIndexOf(':')
  return { employeeId: key.slice(0, i), day: parseInt(key.slice(i + 1), 10) }
}

/**
 * The records to show after a reload, keeping every edit the reader has not saved (S768).
 *
 * Every write on the sheet — a save, a generate, a clear — reloads the whole month, and the reload
 * used to replace `records` outright. So marking Days 1–3, moving to Day 4 and saving it threw the
 * first three days away without a word: for daily and hourly staff a blank day pays nothing.
 *
 * A cell is carried over when it differs from what the PREVIOUS read held (it was an edit) and
 * from what this read holds (the write did not already store it). The second test is what lets a
 * saved edit give way to the server's copy of itself, while a value typed during the save survives.
 * `drop(key)` names cells the write just deleted on purpose — a cleared day stays cleared.
 */
export function carryUnsavedEdits(fresh, current, prevSaved, timeKey, drop = () => false) {
  const next = { ...fresh }
  for (const [key, rec] of Object.entries(current)) {
    if (drop(key)) continue
    const sig = cellSignature(rec, timeKey)
    if (sig === cellSignature(prevSaved[key], timeKey)) continue
    if (sig === cellSignature(fresh[key], timeKey)) continue
    next[key] = rec
  }
  return next
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
