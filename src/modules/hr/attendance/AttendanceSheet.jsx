import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { errorLine, errorInfo } from '../../../shared/errorText'
import Tip from '../../../components/Tip'
import Tabs from '../../../components/Tabs'
import ConfirmModal from '../../../components/ConfirmModal'
import { useConfirm, CONFIRM_TIMEOUT_MS, CONFIRM_TIMEOUT_TEXT } from '../../../shared/hooks/useConfirm'
import { settleWithin } from '../../../utils/withTimeout'
import FieldError, { fieldAria } from '../../../components/FieldError'
import { BS_MONTHS, daysInBsMonth, bsToAd, getBsToday, formatBsDay, bsDayOrdinal, formatAdAsBs } from '../../../utils/bsCalendar'
import { ATTENDANCE_STATUSES, STANDARD_HOURS_PER_DAY } from '../payrollConstants'
import { planAttendanceFromRoster } from './attendanceFromRoster'
import { isNonWorking, withStatus, fillBlankCells, attendanceRowFor, unsavedKeys, carryUnsavedEdits, splitCellKey, splitFirstMarks, firstMarksKeptOut, keysOutsideList, bsOrdinal, employmentBounds, dayBlock, describeBlocked } from './attendanceRules'
import { stillIncomplete } from './attendanceImportPlan'
import AttendanceImportModal from './AttendanceImportModal'
import { calcHours, shiftHours, shiftRegularHours, hasUnknownHours } from '../roster/laborForecast'
import { nepalBs } from '../../../shared/nepalTime'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { unmarkedWindow, unmarkedDaysFor } from '../payroll/monthStatus'

// The sheet's staff list. join_date / end_date: Import from machine marks no day before someone
// joined or after they left. Read on load and again after a write meets a settled leaver.
const EMPLOYEE_COLS = 'id, full_name, employee_code, pay_basis, status, department, join_date, end_date'
// The longest the sheet waits on a write before saying it could not confirm (S803). Save, Generate
// and the clears used to wait for ever: a hung request left "Saving…" up, and Generate's confirm —
// inert while busy, by design — trapped the clerk over a month of unsaved marks.
const WRITE_MS = 25000

// Which pay-month refusal a write met (hr_pay_month_guard, S791), or null. Neither can be retried
// past, so a message for one must never say "press Save again" (S798, ATTENDANCE-8).
function payLockOf(err) {
  const m = err?.message || ''
  if (/hr_month_finalized/i.test(m)) return 'finalized'
  if (/hr_month_settled/i.test(m)) return 'settled'
  return null
}

const STATUS_MAP = Object.fromEntries(ATTENDANCE_STATUSES.map(s => [s.key, s]))
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// The grid's controls wear `.form-input` / `.form-select` (S768) so a locked month's boxes take the
// shared `:disabled` treatment, an invalid time takes the `[aria-invalid]` border, and a tablet gets
// the coarse-pointer 16px floor. Only the padding differs from the class: a row per employee is a
// dense ledger, and the class's 9px/12px would add ~4px to every row of a 40-person sheet.
const CELL_PAD = '7px 10px'

// The product's amber banner — PayrollRun's stale-draft card and LeaveManagement's gap banner
// wear exactly this, the whole border tinted and an 8% fill (design-system.md, S741).
const amberBanner = {
  marginBottom: 14, padding: '12px 16px',
  borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)',
  background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
}

function weekdayOf(period, day) {
  if (!period) return ''
  return WEEKDAYS[bsToAd(period.bs_year, period.bs_month, day).getDay()]
}

// Start/End are punched in as plain text (24-hour HH:MM), not a native time-picker widget. Also
// accepts colon-free digits — "0800"/"800"/"08" — same shorthand a time-clock calculator takes,
// so the admin doesn't have to type the colon by hand; normalized to canonical "H:MM" on blur.
// Also accepts a trailing ":SS" (Postgres's `time` column reads back as "08:00:00") so existing
// saved records don't come back flagged invalid — the seconds are simply dropped.
// Returns the canonical string, '' for blank, or null if genuinely unparseable.
function parseTimeInput(raw) {
  const s = (raw || '').trim()
  if (!s) return ''
  const colon = s.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/)
  if (colon) return `${parseInt(colon[1], 10)}:${colon[2]}`
  if (/^\d{1,4}$/.test(s)) {
    let hour, minute
    if (s.length <= 2) { hour = parseInt(s, 10); minute = 0 }
    else if (s.length === 3) { hour = parseInt(s.slice(0, 1), 10); minute = parseInt(s.slice(1), 10) }
    else { hour = parseInt(s.slice(0, 2), 10); minute = parseInt(s.slice(2), 10) }
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return `${hour}:${String(minute).padStart(2, '0')}`
  }
  return null
}

// What `cellSignature` compares a clock time by: the canonical "H:MM", or — for something that does
// not parse yet — the text as typed, so a half-typed time still counts as an unsaved edit.
function timeKey(raw) {
  const parsed = parseTimeInput(raw)
  return parsed === null ? String(raw).trim() : parsed
}

// `lenient` (the field is currently focused / mid-typing) treats 1-3 bare digits as still-in-
// progress rather than flashing red before the admin has finished typing a 4-digit HHMM entry.
function isValidTimeStr(s, lenient) {
  const v = (s || '').trim()
  if (!v) return true
  if (lenient && /^\d{1,3}$/.test(v)) return true
  return parseTimeInput(v) !== null
}

export default function AttendanceSheet() {
  const { clientId, hasHrAccess, isAdmin } = useAuth()
  const { scopedFrom, scopedUpsert, scopedDelete } = useScopedDb()
  const [periods,   setPeriods]   = useState([])
  const [period,    setPeriod]    = useState(null)
  const [employees, setEmployees] = useState([])
  const [records,   setRecords]   = useState({})   // `${employee_id}:${bs_day}` -> row
  // What the database held at the last read. `records` minus this is the reader's unsaved work,
  // across every day of the month (S768) — the ref is the same map for the async reload paths.
  const [savedRecords, setSavedRecords] = useState({})
  const savedRef = useRef({})
  // The ask before a SAVED day is deleted (S803, owner decision): one tap on 🗑 used to remove a
  // pay-affecting row from hr_attendance with no confirm and no undo.
  // A busy confirm cannot be cancelled, so it is released after a time limit and the page says it
  // could not confirm (S803).
  const { ask: askConfirm, confirmEl } = useConfirm({ timeoutMs: CONFIRM_TIMEOUT_MS, onTimeout: () => setSavedMsg('error:' + CONFIRM_TIMEOUT_TEXT) })
  // A period switch waiting on "discard N unsaved changes?".
  const [pendingPeriodId, setPendingPeriodId] = useState(null)
  const [loading,   setLoading]   = useState(true)
  const [tab,       setTab]       = useState('mark')
  const [selectedDay, setSelectedDay] = useState(getBsToday().day)
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('') // By Employee tab
  const [activeTimeKey, setActiveTimeKey] = useState('') // `${empId}:${day}:${field}` currently focused — suppresses the invalid-red flash while mid-typing a digit shorthand
  const [defaultBreakMin, setDefaultBreakMin] = useState(45) // editable default fed to both "Apply Break" bulk buttons
  const [saving,    setSaving]    = useState(false)
  const [savedMsg,  setSavedMsg]  = useState('')
  // Pending destructive clear awaiting its ConfirmModal: { kind: 'day', count } or
  // { kind: 'employee', empId, name, count }. A cleared day/month changes pay for daily/hourly
  // staff, so the ask is a real dialog with that consequence named, not window.confirm.
  const [confirmClear, setConfirmClear] = useState(null)
  const [generating, setGenerating] = useState(false)
  // Generate from Roster awaiting its ConfirmModal: { rows, who, kept }. It writes pay rows across a
  // month, so the ask names what it will write rather than a window.confirm count (S749).
  const [pendingGenerate, setPendingGenerate] = useState(null)
  // Import from machine (S775). `importFlags` holds the imported days that came in incomplete (one
  // punch, or in and out under an hour apart): `${employee_id}:${bs_day}` → the machine's record in
  // words. A flag shows in amber until the day's times make a shift or it stops being a working day
  // (`stillIncomplete`), and Save asks once while any unsaved one is still open.
  const [importing, setImporting] = useState(false)
  const [importFlags, setImportFlags] = useState({})
  const [confirmSaveFlags, setConfirmSaveFlags] = useState(false)
  // Shift types (client-wide) + this period's roster assignments — used to auto-calc OT when an
  // admin enters a Start/End time: worked hours beyond the employee's roster-assigned shift for
  // that day (or STANDARD_HOURS_PER_DAY if they're not on the roster that day) become OT.
  const [shiftTypesById, setShiftTypesById] = useState({})
  const [rosterRows,     setRosterRows]     = useState([])
  // Either read failing makes the OT auto-calc WRONG rather than absent (S749): with no shift map
  // every rostered day's whole span became overtime, and with no roster rows every day was
  // measured against 8 hours — and that OT is what payroll pays. So a failure is held here, the
  // auto-calc and Generate from Roster stand down while it is set, and the sheet says why.
  const [shiftTypesError, setShiftTypesError] = useState(null)
  const [rosterError,     setRosterError]     = useState(null)
  const rosterReadError = shiftTypesError || rosterError
  // Whether this month's payroll has been finalized: 'none' | 'draft' | 'finalized' | 'unknown'.
  // 'unknown' is a failed read, and it locks the sheet like 'finalized' does — a check that could
  // not run has not passed (decided 2026-09-14: a paid month is read-only).
  const [runStatus, setRunStatus] = useState('none')
  const [loadError, setLoadError] = useState(null)
  // The month's own attendance read failed (S798 ATTENDANCE-1). Held apart from `loadError` (the
  // periods and staff reads) because it is per month, and the sheet renders an error card in place
  // of the grid while it is set: a grid that could not be read looks blank, and Generate, All
  // Present and Import decide "blank" from the screen, so they overwrote approved unpaid leave and
  // absences with Present days that payroll then paid.
  const [attendanceError, setAttendanceError] = useState(null)
  // One sheet at a time (S749). Arrowing the period <select> starts a load per keypress, and the
  // last response to land used to win `records` while `period` was whatever was picked last —
  // so Save Day then wrote one month's rows under another month's period_id.
  const periodReq = useLatestRequest()

  useEffect(() => {
    if (!clientId) return
    // `*` rather than a column list: `regular_hours` (S742) must reach the OT auto-calc, and naming
    // it here would fail this whole read on a database the migration has not reached yet — which
    // leaves shiftTypesById empty, so every rostered day's whole worked span became overtime.
    let live = true
    scopedFrom('hr_shift_types').then(({ data, error }) => {
      if (!live) return
      setShiftTypesError(error || null)
      if (error) return
      setShiftTypesById(Object.fromEntries((data || []).map(s => [s.id, s])))
    })
    return () => { live = false }
  }, [clientId, scopedFrom])

  useEffect(() => {
    if (!period) { setRosterRows([]); return }
    // Paged, for the same reason the attendance read below is: `hr_roster` is one row per employee
    // per rostered day, so a month crosses PostgREST's 1000-row cap at ~33 staff. Truncated, the
    // missing rows read as "not on the roster that day" and assignedHoursFor() silently falls back
    // to STANDARD_HOURS_PER_DAY — so the OT auto-calc measures overtime against 8 hours instead of
    // the employee's real shift, and that OT is what payroll pays.
    // `live` drops a response for a month that is no longer on screen.
    let live = true
    fetchAllRows(() => scopedFrom('hr_roster', 'employee_id, shift_type_id, bs_day')
      .eq('bs_year', period.bs_year).eq('bs_month', period.bs_month)
      .order('id'))
      .then(({ data, error }) => {
        if (!live) return
        setRosterError(error || null)
        setRosterRows(error ? [] : (data || []))
      })
    return () => { live = false }
  }, [period?.bs_year, period?.bs_month, scopedFrom]) // eslint-disable-line react-hooks/exhaustive-deps

  const locked = runStatus === 'finalized' || runStatus === 'unknown'

  // Memoized: this sheet is a grid of controlled inputs, so every keystroke in any of ~7 fields
  // per employee re-renders the page — and this rebuilt an index over the whole month's roster
  // (up to ~1,000 rows) on each one, for a lookup table that changes only when the period does.
  const rosterByKey = useMemo(
    () => Object.fromEntries(rosterRows.map(r => [`${r.employee_id}:${r.bs_day}`, r.shift_type_id])),
    [rosterRows])
  function shiftFor(empId, day) {
    const shiftTypeId = rosterByKey[`${empId}:${day}`]
    return shiftTypeId ? shiftTypesById[shiftTypeId] : null
  }
  // The length a day is measured against. A working shift nobody gave a length to (the ready-made
  // "Split": no hours, no times) is an ordinary day, like a day with no roster entry (S798,
  // ATTENDANCE-2, H10 (a)): measured against 0 hours, every hour worked became overtime.
  function assignedHoursFor(empId, day) {
    const shiftTypeId = rosterByKey[`${empId}:${day}`]
    if (!shiftTypeId) return STANDARD_HOURS_PER_DAY
    const shift = shiftTypesById[shiftTypeId]
    return hasUnknownHours(shift) ? STANDARD_HOURS_PER_DAY : shiftHours(shift)
  }
  // The working shifts rostered this month with no hours set, and on how many days — named in a
  // banner, since every such day is measured against the 8-hour stand-in above.
  const unknownHourShifts = useMemo(() => {
    const byId = {}
    rosterRows.forEach(r => {
      const s = shiftTypesById[r.shift_type_id]
      if (s && hasUnknownHours(s)) (byId[r.shift_type_id] ||= { name: s.name, days: 0 }).days += 1
    })
    return Object.values(byId)
  }, [rosterRows, shiftTypesById])

  // Who was employed on which day, as BS ordinals: once per staff list, not once per cell.
  const boundsByEmp = useMemo(() => Object.fromEntries(employees.map(e => [e.id, employmentBounds(e)])), [employees])
  // Before joining or after leaving (S798, ATTENDANCE-5): greyed on both tabs, never filled in bulk.
  function employmentBlock(empId, day) {
    if (!period) return null
    return dayBlock(boundsByEmp[empId], bsOrdinal({ year: period.bs_year, month: period.bs_month, day }))
  }
  // The words under a greyed day: "Before joining (10 Kartik 2083)", or null inside the employment.
  function outsideLabel(emp, day) {
    const block = emp ? employmentBlock(emp.id, day) : null
    if (block === 'before_joining') return `Before joining (${formatAdAsBs(emp.join_date)})`
    if (block === 'after_leaving') return `After leaving (${formatAdAsBs(emp.end_date)})`
    return null
  }
  // What a bulk fill may not mark: outside the employment, or after today in Nepal (H7 (a)). Read at
  // the moment of the click, so a sheet left open overnight does not fill tomorrow.
  function bulkBlocker() {
    if (!period) return () => null
    const today = nepalBs(new Date()) || getBsToday()
    const todayOrd = bsOrdinal(today)
    return (empId, day) => dayBlock(boundsByEmp[empId], bsOrdinal({ year: period.bs_year, month: period.bs_month, day }), todayOrd)
  }
  // Two ways to measure a punched day, chosen by the day's shift (S742):
  //   • the shift has Normal hours → CLOCK time. OT is the Start-to-End span beyond those normal
  //     hours, lunch included, so 8am–8pm on a 9-normal-hour shift is 3h OT whatever Break says.
  //   • it does not → exactly as before: hours worked (span minus Break) beyond the shift's length.
  // The second stays untouched because a shift typed with a NET length (8h for 8am–5pm with an
  // unpaid hour) would otherwise gain an hour of OT on every day a break is entered.
  function autoHoursFor(empId, day, startNorm, endNorm, breakMinutes) {
    // Without the shift map or the roster the figure below is not merely rough, it is wrong — and
    // it is what payroll pays. Stand down and leave Hours/OT to be typed (the sheet says why).
    if (rosterReadError) return null
    const span = calcHours(startNorm, endNorm)
    if (span == null) return null
    const worked = Math.max(0, parseFloat((span - (parseFloat(breakMinutes) || 0) / 60).toFixed(2)))
    const regular = shiftRegularHours(shiftFor(empId, day))
    const over = regular != null ? span - regular : worked - assignedHoursFor(empId, day)
    return { hours_worked: worked, ot_hours: Math.max(0, parseFloat(over.toFixed(1))) }
  }
  // A meaningful shortfall against the roster-assigned shift is surfaced as a visual nudge, not
  // an automatic pay deduction — Nepal's Labour Act only defines a full-day absence deduction
  // (Section 47 + Rules), nothing per-hour, so prorating pay here would be inventing a rule the
  // Act doesn't authorize. Left for the admin to notice and decide (e.g. reclassify as Half Day).
  // Measured on the same basis as the OT above: clock time for a shift with Normal hours, so a
  // 45-minute break on a full 8am–5pm day no longer reads as "0.75h short".
  const SHORTFALL_FLAG_HOURS = 0.5
  function shortfallFor(rec, empId, day) {
    if (!rec || rec.status !== 'present' || !rec.start_time || !rec.end_time) return null
    if (!isValidTimeStr(rec.start_time) || !isValidTimeStr(rec.end_time)) return null
    const clockBasis = shiftRegularHours(shiftFor(empId, day)) != null
    const measured = clockBasis
      ? calcHours(parseTimeInput(rec.start_time), parseTimeInput(rec.end_time))
      : parseFloat(rec.hours_worked)
    if (!Number.isFinite(measured)) return null
    const gap = parseFloat((assignedHoursFor(empId, day) - measured).toFixed(1))
    return gap >= SHORTFALL_FLAG_HOURS ? { gap, measured } : null
  }

  // The message for a Start/End box, or null. `activeKey` is the box being typed in, where 1–3 bare
  // digits are still a time in progress rather than a mistake.
  function timeError(value, activeKey) {
    return isValidTimeStr(value, activeTimeKey === activeKey) ? null : 'Invalid — use HH:MM or 0800'
  }

  // `carry` keeps the reader's unsaved edits through the reload (every write on the sheet reloads
  // the month, and used to wipe them); `drop(key)` names cells the write just deleted on purpose.
  // A period switch passes neither — another month's edits must not follow the reader into this one.
  // Returns true when the month loaded, false when the read failed, null when a newer load took over,
  // so a write never reports plain success over a sheet it could not re-read.
  const loadAttendance = useCallback(async (periodId, { carry = false, drop } = {}) => {
    // Paged: one row per employee per day, so the grid itself silently loses whole employees'
    // rows past the 1000-row cap at ~34 staff — and this sheet is what payroll then reads (S529).
    // The payroll run rides along: a finalized month is read-only (S749).
    const [{ data, error }, runRes] = await Promise.all([
      fetchAllRows(() => scopedFrom('hr_attendance').eq('period_id', periodId).order('id')),
      scopedFrom('hr_payroll_runs', 'status').eq('period_id', periodId).maybeSingle(),
    ])
    if (!periodReq.isCurrent(periodId)) return null
    setRunStatus(runRes.error ? 'unknown' : (runRes.data?.status || 'none'))
    // A failed read is not a blank sheet (S682): this grid batch-saves what is on screen, so
    // painting it empty and letting a Save through would write blanks over real days. Keeping "the
    // last successful load" was no answer either — on a first load there was none, and after a month
    // switch it was the previous month's marks under this month's name. So the grid goes (S798).
    if (error) { setAttendanceError(error); return false }
    setAttendanceError(null)
    const map = {}
    // Postgres's `time` column reads back as "08:00:00" — normalize to the display convention
    // ("8:00") on load rather than waiting for the admin to focus/blur each cell once.
    ;(data || []).forEach(r => {
      map[`${r.employee_id}:${r.bs_day}`] = {
        ...r,
        start_time: parseTimeInput(r.start_time) || r.start_time,
        end_time:   parseTimeInput(r.end_time)   || r.end_time,
      }
    })
    const prevSaved = savedRef.current
    savedRef.current = map
    setSavedRecords(map)
    setRecords(current => carry ? carryUnsavedEdits(map, current, prevSaved, timeKey, drop) : map)
    return true
  }, [scopedFrom, periodReq])

  // Empties the sheet before a month is read, so nothing from another month or client can stand in
  // for this one while the read is in flight or after it fails.
  function resetSheet() {
    savedRef.current = {}
    setSavedRecords({})
    setRecords({})
    setAttendanceError(null)
  }

  // The error card's Try again. A fresh load, never `carry`: the grid was hidden, so nothing on it
  // could have been edited, and carrying would lay whatever `records` still holds over real days.
  async function retryAttendance() {
    if (!period) return
    periodReq.begin(period.id)
    resetSheet()
    setSavedMsg('')
    setLoading(true)
    await loadAttendance(period.id)
    if (periodReq.isCurrent(period.id)) setLoading(false)
  }

  // Words for a write that landed when the reload after it did not (S798): the card replaces the
  // grid, so this is the only place the reader learns the write itself went through.
  function landedButUnread(what) {
    return `ok:${what}. The sheet could not be read back afterwards, so it is hidden until it loads.`
  }

  // The staff list again, after a write met a settled leaver. Finalize makes them Resigned (or
  // Terminated, or Inactive), so they drop out of active/probation. Returns who left the sheet, or
  // null when the read failed.
  async function refreshEmployees() {
    const { data, error } = await scopedFrom('hr_employees', EMPLOYEE_COLS).in('status', ['active', 'probation']).order('full_name')
    if (error) return null
    const next = data || []
    const keep = new Set(next.map(e => e.id))
    setEmployees(next)
    setSelectedEmployeeId(prev => (keep.has(prev) ? prev : next[0]?.id || ''))
    return employees.filter(e => !keep.has(e.id))
  }

  // A write the pay-month guard refused (S798, ATTENDANCE-8). The sheet loaded before payroll was
  // finalized, or before a leaver was settled, in another tab, and used to answer "press Save again"
  // over a lock no retry passes, while staying editable. `lead` says what did not happen.
  //   finalized → the run is re-read, which puts the lock banner up. A Save's marks stay on screen.
  //   settled   → the staff list is re-read, so the leaver leaves the sheet, and their unsaved marks
  //               are dropped: one of their rows refused every other unsaved mark with it. The rest
  //               can then be saved, so that retry is offered (`pending`, a Save's refused keys), or
  //               the caller's own `retry` sentence.
  // `drop` is passed through to the reload for cells the write settled either way.
  async function answerPayLock({ kind, lead, error, pending = null, retry = '', drop }) {
    const { detail } = errorInfo(error, 'operator')
    const fine = detail ? ` (${detail})` : ''
    if (kind === 'finalized') {
      await loadAttendance(period.id, { carry: true, drop })
      const kept = pending?.length ? ' What you entered is still on screen, but it cannot be saved while the run is finalized.' : ''
      setSavedMsg(`error:${lead} Payroll for ${periodLabel} was finalized after this sheet was opened, so its attendance is now locked.${kept} Reopen the payroll run first if the month really needs correcting.${fine}`)
      return
    }
    const gone = await refreshEmployees()
    if (!gone || gone.length === 0) {
      setSavedMsg(`error:${lead} ` + errorLine(error) + ' Reload the page to see who is still on this sheet.')
      return
    }
    const goneIds = new Set(gone.map(e => e.id))
    const isGone = k => goneIds.has(splitCellKey(k).employeeId)
    const lost = unsaved.filter(isGone).length
    await loadAttendance(period.id, { carry: true, drop: k => isGone(k) || (drop ? drop(k) : false) })
    const one = gone.length === 1
    const names = gone.map(e => e.full_name).join(', ')
    const dropped = lost ? ` Their ${lost} unsaved mark${lost === 1 ? ' was' : 's were'} dropped — nothing pays a day in a month their settlement already paid.` : ''
    const left = pending ? pending.filter(k => !isGone(k)) : null
    const next = left
      ? (left.length ? ` ${describeChanges(left)} for everyone else ${left.length === 1 ? 'is' : 'are'} still on screen, not saved — press Save again.` : '')
      : (retry ? ` ${retry}` : '')
    setSavedMsg(`error:${lead} ${names} ${one ? 'is' : 'are'} no longer on this sheet: ${one ? 'their Final Settlement was' : 'their Final Settlements were'} finalized after it was opened.${dropped}${next}${fine}`)
  }

  function applyPeriod(p) {
    setPeriod(p)
    const today = getBsToday()
    // Default the day selector to today when viewing the current BS month, else day 1.
    setSelectedDay(p.bs_year === today.year && p.bs_month === today.month ? today.day : 1)
  }

  useEffect(() => {
    if (!clientId) return
    async function load() {
      setLoading(true); setLoadError(null)
      const [pRes, eRes] = await Promise.all([
        scopedFrom('monthly_periods')
          .order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
        scopedFrom('hr_employees', EMPLOYEE_COLS).in('status', ['active', 'probation']).order('full_name'),
      ])
      // A failed read is not "No active employees" or "No period found" (S749) — both of those
      // send the reader to go and create something that already exists.
      if (pRes.error || eRes.error) { setLoadError(pRes.error || eRes.error); setLoading(false); return }
      const p = pRes.data || [], emps = eRes.data || []
      setPeriods(p)
      setEmployees(emps)
      // Kept only while still listed (S798, GAP-OPERATOR-2): after an operator's client switch the old
      // id matched no option, the dropdown showed this client's first person, and the grid and Save
      // went on writing the previous client's employee.
      setSelectedEmployeeId(prev => (emps.some(e => e.id === prev) ? prev : emps[0]?.id || ''))
      const open = p.find(x => x.status === 'open') || p[0]
      if (open) {
        periodReq.begin(open.id); applyPeriod(open)
        // resetSheet(), spelled out: an admin's client switch re-runs this over the last client's grid.
        savedRef.current = {}; setSavedRecords({}); setRecords({}); setAttendanceError(null)
        await loadAttendance(open.id)
      }
      setLoading(false)
    }
    load()
  }, [clientId, scopedFrom, loadAttendance, periodReq])

  // Switching month discards unsaved edits, so it asks first. Switching DAY or TAB does not: both
  // tabs read and write the same `records`, and an edit on Day 3 is still there on Day 4 (S768).
  function handlePeriodChange(id) {
    if (id === period?.id) return
    if (unsaved.length > 0) { setPendingPeriodId(id); return }
    switchPeriod(id)
  }
  async function switchPeriod(id) {
    setPendingPeriodId(null)
    const p = periods.find(x => x.id === id)
    if (!p) return
    periodReq.begin(id)
    applyPeriod(p)
    setImportFlags({})
    setRunStatus('none')
    resetSheet()
    setLoading(true)
    await loadAttendance(id)
    if (periodReq.isCurrent(id)) setLoading(false)
  }

  // Every write on this page checks this first. The trigger behind it refuses too; this is what
  // lets the page say so in words before anything is attempted.
  function refuseIfLocked() {
    if (!locked) return false
    setSavedMsg(runStatus === 'unknown'
      ? 'error:Could not check whether payroll for this month is finalized, so nothing was changed. Reload to try again.'
      : `error:Payroll for ${periodLabel} is finalized, so its attendance is locked. Reopen the payroll run first if the month really needs correcting.`)
    return true
  }

  // ── Mark-tab cell helpers ──────────────────────────────────────────────────
  function cellFor(empId, day) {
    return records[`${empId}:${day}`]
  }
  // No more auto-computed off day — a cell only gets a status once it's actually touched (Off
  // included), same as marking Absent or Leave. 'present' is only the fallback for a record
  // that's ALREADY been created via some other field (note/hours/time) but never got an
  // explicit status pick — genuinely untouched cells stay null (see statusFor).
  function defaultStatus() {
    return 'present'
  }
  // null (not 'present') for a cell nobody has touched — the dropdown shows a neutral "not
  // marked" placeholder instead of a misleading green Present, so what's on screen matches what
  // Save will actually persist (an untouched cell is skipped, not saved as Present).
  function statusFor(empId, day) {
    return cellFor(empId, day)?.status ?? null
  }
  function setCell(empId, day, field, value) {
    if (locked) return
    const key = `${empId}:${day}`
    setRecords(m => {
      const prev = m[key] || { employee_id: empId, bs_day: day, status: defaultStatus() }
      // A day switched to Absent / Leave / Off / Holiday drops the hours and overtime typed on it
      // (decided 2026-09-14) — payroll pays OT from every row whatever its status.
      if (field === 'status') return { ...m, [key]: withStatus(prev, value) }
      return { ...m, [key]: { ...prev, [field]: value } }
    })
  }
  // Reverts a cell to genuinely untouched — used both by the Status dropdown's "— Not marked —"
  // placeholder and the per-row delete button. Removes it from local state immediately for a
  // snappy UI, and if it was ever actually saved, deletes the row in the DB too — Save Day's
  // upsert only ever inserts/updates, never deletes, so without this a previously-saved value
  // would just silently reappear on the next reload.
  async function clearCell(empId, day) {
    if (refuseIfLocked()) return
    const key = `${empId}:${day}`
    const before = records[key]
    setRecords(m => {
      if (!(key in m)) return m
      const next = { ...m }
      delete next[key]
      return next
    })
    if (!period) return
    const dayName = formatBsDay(day, period.bs_month)
    // Bounded (S803): this runs inside the confirm dialog, which cannot be dismissed while busy.
    const { error } = await settleWithin(
      scopedDelete('hr_attendance').eq('employee_id', empId).eq('period_id', period.id).eq('bs_day', day),
      WRITE_MS, 'Clearing the day')
    if (error) {
      // The cell was cleared optimistically; put it back so the sheet shows what is stored.
      if (before) setRecords(m => ({ ...m, [key]: before }))
      const lock = payLockOf(error)
      if (lock) { await answerPayLock({ kind: lock, lead: `${dayName} was not cleared.`, error }); return }
      setSavedMsg(`error:${dayName} may not have been cleared — reload to see what is stored. ` + errorLine(error))
      return
    }
    // The row is gone, so it leaves the saved copy too — or marking the same day again would
    // compare equal to a row that no longer exists and never be saved.
    if (key in savedRef.current) {
      const nextSaved = { ...savedRef.current }
      delete nextSaved[key]
      savedRef.current = nextSaved
      setSavedRecords(nextSaved)
    }
  }
  // The 🗑 button and the Status box's "— Not marked —" both come here (S803, owner decision). A mark
  // not yet saved clears at once, as typing over it would; a SAVED day is a pay row, so deleting it
  // asks first and says what the blank day then means for this person's pay.
  function requestClearCell(empId, day) {
    if (refuseIfLocked()) return
    if (!(`${empId}:${day}` in savedRef.current) || !period) { clearCell(empId, day); return }
    const emp = employees.find(e => e.id === empId)
    const dayName = formatBsDay(day, period.bs_month)
    const monthly = (emp?.pay_basis || 'monthly') === 'monthly'
    askConfirm({
      title: `Delete ${emp?.full_name || 'this employee'}'s ${dayName}?`,
      body: (
        <p style={{ margin: 0 }}>
          The saved mark is removed and {dayName} goes back to Not Marked.{' '}
          {monthly
            ? 'A monthly employee is still paid for an unmarked day.'
            : `${emp?.pay_basis === 'hourly' ? 'An hourly' : 'A daily'} employee is paid nothing for an unmarked day.`}
        </p>
      ),
      confirmLabel: 'Delete the day', danger: true, busyLabel: 'Deleting…',
      run: () => clearCell(empId, day),
    })
  }
  // Unpaid break/lunch minutes are subtracted from the raw Start-to-End span to give Hours Worked
  // (clamped at 0) — see autoHoursFor above for when they also reduce OT and when they do not.
  // Start/End are punched in as plain text (24-hour HH:MM) — auto-computes Hours + OT (worked
  // hours beyond that day's roster-assigned shift) the moment both are valid times. Still just
  // seeds the Hours/OT Hours fields, which stay directly editable afterward if the auto-calc
  // needs a manual tweak. An invalid/partial time is kept as typed (so the admin can keep
  // fixing it) but never touches Hours/OT — the input border + a small "invalid" hint flag it.
  function setTimeCell(empId, day, field, value) {
    if (locked) return
    const key = `${empId}:${day}`
    setRecords(m => {
      const prev = m[key] || { employee_id: empId, bs_day: day, status: defaultStatus() }
      const next = { ...prev, [field]: value }
      const start = field === 'start_time' ? value : prev.start_time
      const end   = field === 'end_time'   ? value : prev.end_time
      const startNorm = parseTimeInput(start)
      const endNorm   = parseTimeInput(end)
      if (startNorm && endNorm) {
        const auto = autoHoursFor(empId, day, startNorm, endNorm, prev.break_minutes)
        if (auto) Object.assign(next, auto)
      }
      return { ...m, [key]: next }
    })
  }
  // Editing the break-minutes field re-runs the same Hours/OT auto-calc against the already-
  // stored Start/End (mirrors setTimeCell's recompute, just triggered from the other input).
  function setBreakCell(empId, day, value) {
    if (locked) return
    const key = `${empId}:${day}`
    setRecords(m => {
      const prev = m[key] || { employee_id: empId, bs_day: day, status: defaultStatus() }
      const next = { ...prev, break_minutes: value }
      const startNorm = parseTimeInput(prev.start_time)
      const endNorm   = parseTimeInput(prev.end_time)
      if (startNorm && endNorm) {
        const auto = autoHoursFor(empId, day, startNorm, endNorm, value)
        if (auto) Object.assign(next, auto)
      }
      return { ...m, [key]: next }
    })
  }
  // Leaving a Start/End field commits whatever shorthand was typed ("0800"/"800"/"08") into the
  // canonical "H:MM" it'll be saved and displayed as (and re-runs the Hours/OT auto-calc against
  // that normalized value). A leftover genuinely-invalid value (e.g. a 3-digit "080" left mid-
  // entry) is kept as typed so the red "invalid" hint can flag it.
  function normalizeTimeCell(empId, day, field) {
    const rec = records[`${empId}:${day}`]
    if (!rec) return
    const normalized = parseTimeInput(rec[field])
    if (normalized !== null && normalized !== (rec[field] || '')) setTimeCell(empId, day, field, normalized)
  }
  // Bulk marks fill BLANK cells only (decided 2026-09-14): they used to overwrite every cell, so
  // "All Present" after a leave approval turned the approved leave days into Present on save.
  // Computed off `records` (not inside the setter) so the message can say what was left alone.
  // Since S798 (ATTENDANCE-5, H7 (a)) a bulk mark also leaves blank a day before someone joined,
  // after they left, or after today: mark such a day one at a time if it really is one.
  function bulkMark(cells, status, scope) {
    if (refuseIfLocked()) return
    const blockOf = bulkBlocker()
    const { next, filled, kept, skipped } = fillBlankCells(records, cells, status, c => blockOf(c.employeeId, c.day))
    setRecords(next)
    const label = STATUS_MAP[status]?.label || status
    const left = describeBlocked(skipped)
    const leftNote = left ? ` · left blank: ${left}` : ''
    setSavedMsg(filled === 0
      ? (left
        ? `ok:Nothing marked — left blank: ${left}${kept ? ` · ${kept} already marked` : ''}. Mark a day one at a time if it really needs one.`
        : `ok:Nothing marked — every ${scope} already has a mark. Change a day one at a time to override it.`)
      : `ok:${filled} blank ${filled === 1 ? scope : scope + 's'} marked ${label}${kept ? ` · ${kept} already marked left as they were` : ''}${leftNote}. Save to keep them.`)
  }
  // All employees, one day (Mark Attendance tab's bulk buttons).
  function markAll(status) {
    bulkMark(employees.map(emp => ({ key: `${emp.id}:${selectedDay}`, employeeId: emp.id, day: selectedDay })), status, 'employee')
  }
  // One employee, every day of the month (By Employee tab's bulk buttons).
  function markAllDaysForEmployee(empId, status) {
    if (!empId) return
    bulkMark(days.map(d => ({ key: `${empId}:${d}`, employeeId: empId, day: d })), status, 'day')
  }
  // Fills in the default break length wherever it's still blank — only on rows that already have
  // a record (i.e. the admin has already marked something for that cell). Deliberately never
  // touches an otherwise-untouched employee/day, matching the "only writes what you've actually
  // touched" rule Save Day/Save Month rely on (S348) — this must not be how a cell gets its first
  // touch, or an employee nobody marked would silently end up saved as Present.
  function applyBreakToDay() {
    if (refuseIfLocked()) return
    setRecords(m => {
      const next = { ...m }
      employees.forEach(emp => {
        const key = `${emp.id}:${selectedDay}`
        const prev = next[key]
        if (!prev || isNonWorking(prev.status) || (prev.break_minutes != null && prev.break_minutes !== '')) return
        const rec = { ...prev, break_minutes: defaultBreakMin }
        const startNorm = parseTimeInput(rec.start_time)
        const endNorm = parseTimeInput(rec.end_time)
        if (startNorm && endNorm) {
          const auto = autoHoursFor(emp.id, selectedDay, startNorm, endNorm, defaultBreakMin)
          if (auto) Object.assign(rec, auto)
        }
        next[key] = rec
      })
      return next
    })
  }
  function applyBreakToEmployeeMonth(empId) {
    if (refuseIfLocked()) return
    setRecords(m => {
      const next = { ...m }
      days.forEach(d => {
        const key = `${empId}:${d}`
        const prev = next[key]
        if (!prev || isNonWorking(prev.status) || (prev.break_minutes != null && prev.break_minutes !== '')) return
        const rec = { ...prev, break_minutes: defaultBreakMin }
        const startNorm = parseTimeInput(rec.start_time)
        const endNorm = parseTimeInput(rec.end_time)
        if (startNorm && endNorm) {
          const auto = autoHoursFor(empId, d, startNorm, endNorm, defaultBreakMin)
          if (auto) Object.assign(rec, auto)
        }
        next[key] = rec
      })
      return next
    })
  }

  // ONE save for the whole sheet (S768). It used to be Save Day on one tab and Save Month on the
  // other, each writing only its own slice while the grid happily held edits for every day — so a
  // day marked and then left for another day was never written, and the next save's reload wiped
  // it from the screen too. For daily and hourly staff a blank day pays nothing. Now every unsaved
  // cell goes in one upsert, whichever tab or day the reader happens to be on.
  // `force` is the "Save anyway" answer to imported days still flagged incomplete.
  async function saveChanges({ force = false } = {}) {
    if (!period || refuseIfLocked()) return
    const keys = unsaved
    if (keys.length === 0) {
      setSavedMsg('ok:Nothing to save — every mark on this sheet is already saved.')
      return
    }
    // S798 (GAP-OPERATOR-2): a mark for someone not on this sheet came from another client's sheet,
    // and would be filed under this client against the wrong person. The state is suspect, so nothing goes.
    const strays = keysOutsideList(keys, employees.map(e => e.id))
    if (strays.length > 0) {
      setSavedMsg(`error:${strays.length} unsaved mark${strays.length === 1 ? ' belongs' : 's belong'} to someone who is not on this sheet, so nothing was saved. Reload the page and enter the marks again.`)
      return
    }
    if (!force && unsavedFlags.length > 0) { setConfirmSaveFlags(true); return }
    setConfirmSaveFlags(false)
    setSaving(true); setSavedMsg('')
    const sent = records
    const rowFor = key => {
      const { employeeId, day } = splitCellKey(key)
      return attendanceRowFor(sent[key], { employeeId, periodId: period.id, day, isValidTime: s => isValidTimeStr(s) })
    }
    // An edit overwrites the row it was loaded from. A first mark never overwrites (S798, ATTENDANCE-6):
    // the screen saw a blank day, and only the database knows whether a leave approval or another tab
    // has marked it since. RETURNING lists the first marks that went in.
    const { first, edits } = splitFirstMarks(keys, savedRef.current)
    const none = { data: [], error: null }
    const out = await settleWithin(Promise.all([
      edits.length ? scopedUpsert('hr_attendance', edits.map(rowFor), { onConflict: 'employee_id,period_id,bs_day' }) : none,
      first.length ? scopedUpsert('hr_attendance', first.map(rowFor), { onConflict: 'employee_id,period_id,bs_day', ignoreDuplicates: true }) : none,
    ]), WRITE_MS, 'Saving attendance')
    if (!Array.isArray(out)) {
      // Timed out (S803). Either half may have landed; both are safe to send again (an edit
      // overwrites its own row, a first mark never overwrites), and the marks are still on screen.
      setSavedMsg(`error:Could not confirm ${describeChanges(keys)} saved — the server took too long to answer. What you entered is still on screen — press Save again (saving twice is safe). ` + errorLine(out.error))
      setSaving(false); return
    }
    const [editRes, firstRes] = out
    const error = editRes.error || firstRes.error
    const lockErr = [editRes.error, firstRes.error].find(e => payLockOf(e))
    if (lockErr) {
      // The guard refuses a whole statement, so each half either landed in full or not at all. The
      // other half may have gone in: a settled leaver's row refuses only the statement it sits in.
      const refused = [...(editRes.error ? edits : []), ...(firstRes.error ? first : [])]
      const refusedSet = new Set(refused)
      const landedFirst = new Set((firstRes.data || []).map(r => `${r.employee_id}:${r.bs_day}`))
      const keptOut = !firstRes.error && Array.isArray(firstRes.data) ? first.filter(k => !landedFirst.has(k)) : []
      const keptOutSet = new Set(keptOut)
      const landed = keys.filter(k => !refusedSet.has(k) && !keptOutSet.has(k))
      setImportFlags(f => {
        const next = { ...f }
        landed.forEach(k => { delete next[k] })
        return next
      })
      const notSaved = `${describeChanges(refused)} ${refused.length === 1 ? 'was' : 'were'} not saved.`
      const lead = (landed.length ? `Saved ${describeChanges(landed)}, but ${notSaved.charAt(0).toLowerCase()}${notSaved.slice(1)}` : notSaved)
        + (keptOut.length ? ` ${keptOut.length} day${keptOut.length === 1 ? ' was' : 's were'} marked from another screen meanwhile and left as stored.` : '')
      await answerPayLock({ kind: payLockOf(lockErr), lead, error: lockErr, pending: refused, drop: k => keptOutSet.has(k) })
      setSaving(false); return
    }
    if (error) { setSavedMsg(`error:${describeChanges(keys)} may not have saved. What you entered is still on screen — press Save again (saving twice is safe). ` + errorLine(error)); setSaving(false); return }
    // A flagged day that has been saved was a decision: the reader fixed it or chose Save anyway.
    setImportFlags(f => {
      const next = { ...f }
      keys.forEach(k => { delete next[k] })
      return next
    })
    // A first mark kept out gives way to what is stored, so the sheet shows the leave, not the mark.
    const landed = new Set((firstRes.data || []).map(r => `${r.employee_id}:${r.bs_day}`))
    const notLanded = Array.isArray(firstRes.data) ? new Set(first.filter(k => !landed.has(k))) : new Set()
    const reread = await loadAttendance(period.id, { carry: true, drop: k => notLanded.has(k) })
    if (reread === false) { setSavedMsg(landedButUnread(`Saved ${describeChanges(keys)}`)); setSaving(false); return }
    const keptOut = reread ? firstMarksKeptOut(first, firstRes.data, sent, savedRef.current, timeKey) : []
    const savedKeys = keys.filter(k => !keptOut.includes(k))
    const named = keptOut.slice(0, 4).map(k => {
      const { employeeId, day } = splitCellKey(k)
      const who = employees.find(e => e.id === employeeId)?.full_name || 'Someone'
      const now = savedRef.current[k]
      return `${who} on ${formatBsDay(day, period.bs_month)} (${now ? STATUS_MAP[now.status]?.label || now.status : 'cleared'})`
    })
    const one = keptOut.length === 1
    const keptLine = `${keptOut.length} day${one ? ' was' : 's were'} marked from another screen after this sheet opened, so ${one ? 'it was' : 'they were'} left as stored and your mark${one ? ' was' : 's were'} not saved: ${named.join('; ')}${keptOut.length > 4 ? `, and ${keptOut.length - 4} more` : ''}. Change ${one ? 'it' : 'them'} again if you still mean to.`
    setSavedMsg(keptOut.length === 0 ? `ok:Saved ${describeChanges(keys)}`
      : savedKeys.length === 0 ? `error:Nothing was saved — ${keptLine}`
      : `error:Saved ${describeChanges(savedKeys)}, but ${keptLine}`)
    setSaving(false)
  }

  // ── Import from machine ────────────────────────────────────────────────────
  function openImport() {
    if (!period || attendanceError || refuseIfLocked()) return
    // A day with no punch follows the roster, and a punched day's overtime is measured against its
    // shift, so an unread roster would mark working days Off and pay the wrong overtime.
    if (rosterReadError) {
      setSavedMsg('error:The roster or its shift types could not be read, so nothing can be imported — days with no punch are marked from the roster, and overtime is measured against each day\'s shift. Reload to try again. ' + errorLine(rosterReadError))
      return
    }
    setSavedMsg('')
    setImporting(true)
  }
  // The dialog's changes land as unsaved marks, like a bulk mark, so the sheet's own Save writes them.
  // Each change carries the cell it was planned against; one that moved meanwhile is left alone.
  function applyImport(changes) {
    setImporting(false)
    if (refuseIfLocked()) return
    const next = { ...records }
    const flags = {}
    let applied = 0, moved = 0
    for (const ch of changes) {
      if (next[ch.key] !== ch.before) { moved += 1; continue }
      next[ch.key] = ch.cell
      applied += 1
      if (ch.kind === 'flagged') flags[ch.key] = ch.machine
    }
    setRecords(next)
    setImportFlags(f => ({ ...f, ...flags }))
    const toCheck = Object.keys(flags).length
    setSavedMsg(`ok:${applied} day${applied === 1 ? '' : 's'} filled in from the machine file`
      + (toCheck ? ` · ${toCheck} to check, shown in amber` : '')
      + (moved ? ` · ${moved} left alone because the sheet changed meanwhile` : '')
      + '. Nothing is saved until you press Save.')
  }

  // Deletes every employee's record for the selected day — reverts the whole day back to
  // genuinely blank, e.g. to clean up a day that was wrongly bulk-marked before the save-behavior
  // fix. Destructive, so it asks first — via ConfirmModal (see render), since a cleared day
  // changes pay for daily/hourly staff and window.confirm's OS chrome undersold that.
  function requestClearDay() {
    if (!period || refuseIfLocked()) return
    const touched = employees.filter(emp => cellFor(emp.id, selectedDay))
    if (touched.length === 0) {
      setSavedMsg('ok:Nothing to clear — Day ' + selectedDay + ' has no records.')
      return
    }
    setConfirmClear({ kind: 'day', count: touched.length })
  }
  async function clearDay() {
    if (!period || refuseIfLocked()) return
    setConfirmClear(null)
    setSaving(true); setSavedMsg('')
    // Scoped to the staff on this sheet, never the whole day (S749 — the S743 Clear Month rule,
    // which this sibling missed). The sheet lists active/probation staff only, and a mid-month
    // leaver's days are what Final Settlement reads.
    const { error } = await settleWithin(scopedDelete('hr_attendance').eq('period_id', period.id).eq('bs_day', selectedDay)
      .in('employee_id', employees.map(e => e.id)), WRITE_MS, 'Clearing the day')
    if (error) {
      const lock = payLockOf(error)
      if (lock) await answerPayLock({ kind: lock, lead: `Day ${selectedDay} was not cleared.`, error, retry: 'Clear the day again to clear it for everyone else.' })
      else setSavedMsg(`error:Day ${selectedDay} may not have been cleared — reload to see what is stored. ` + errorLine(error))
      setSaving(false); return
    }
    const listed = new Set(employees.map(e => e.id))
    const reread = await loadAttendance(period.id, { carry: true, drop: key => { const k = splitCellKey(key); return k.day === selectedDay && listed.has(k.employeeId) } })
    setSavedMsg(reread === false ? landedButUnread(`Cleared Day ${selectedDay}`) : `ok:Cleared Day ${selectedDay}`)
    setSaving(false)
  }

  // Generate reads the same roster and shift map the auto-calc does, so it refuses on the same
  // failed read: a missing shift map turns every rostered day into an Off day.
  function refuseIfRosterUnread() {
    if (!rosterReadError) return false
    setSavedMsg('error:The roster or its shift types could not be read, so nothing was generated — a day with no shift would have been marked Off. Reload to try again. ' + errorLine(rosterReadError))
    return true
  }

  function generateFromRoster() {
    if (!period || refuseIfLocked() || refuseIfRosterUnread()) return
    setSavedMsg('')
    // Reuses the shiftTypesById/rosterRows state already loaded for the Start/End OT auto-calc
    // above — same period, same shift types, no need to re-fetch.
    const plan = planAttendanceFromRoster({
      rosterRows,
      shiftTypesById,
      employeeIds: employees.map(e => e.id),
      existingDayKeys: new Set(Object.keys(records)),
      days,
      periodId: period.id,
      blockOf: bulkBlocker(),
    })
    if (plan.rows.length === 0) {
      const left = describeBlocked(plan.skipped)
      setSavedMsg(left
        ? `ok:Nothing to generate — the rostered days still blank are ${left}, and Generate leaves those blank.`
        : 'ok:Nothing to generate — every day already has an entry, or no employees are on the roster this month.')
      return
    }
    setPendingGenerate({ ...plan, who: `all ${employees.length} listed staff`, kept: Object.keys(records).length })
  }

  async function runGenerate() {
    const plan = pendingGenerate
    if (!plan || !period || refuseIfLocked()) { setPendingGenerate(null); return }
    setGenerating(true); setSavedMsg('')
    // ON CONFLICT DO NOTHING (S798): the plan decided "blank" from the screen, and only the database
    // knows what is really stored. A day saved meanwhile, in another tab or by a leave approval, is
    // kept rather than overwritten; RETURNING lists only the rows that went in.
    // Bounded (S803): the Generate confirm is inert while busy, so a hung write used to leave it on
    // screen with no way out but a reload.
    const { data: written, error } = await settleWithin(
      scopedUpsert('hr_attendance', plan.rows, { onConflict: 'employee_id,period_id,bs_day', ignoreDuplicates: true }),
      WRITE_MS, 'Generating from roster')
    setPendingGenerate(null)
    if (error) {
      const lock = payLockOf(error)
      if (lock) await answerPayLock({ kind: lock, lead: 'Nothing was generated.', error, retry: 'Generate again for everyone else.' })
      else setSavedMsg('error:The roster days may not have been written — reload to see what is stored, then generate again (it never overwrites a day that already has a mark). ' + errorLine(error))
      setGenerating(false); return
    }
    const made = written?.length ?? plan.rows.length
    const kept = plan.rows.length - made
    const done = `Generated ${made} entr${made === 1 ? 'y' : 'ies'} from roster`
      + (kept > 0 ? ` · ${kept} day${kept === 1 ? '' : 's'} already had a mark saved and ${kept === 1 ? 'was' : 'were'} left as ${kept === 1 ? 'it was' : 'they were'}` : '')
    const reread = await loadAttendance(period.id, { carry: true })
    setSavedMsg(reread === false ? landedButUnread(done) : `ok:${done}`)
    setGenerating(false)
  }

  // ── By Employee tab: one employee × every day of the month, instead of every employee × one day.
  // Saving is the shared saveChanges() above. ─────────────────────────────────────────────────────
  // Deletes every record for this employee, this whole period — e.g. to wipe a month that was
  // wrongly bulk-marked before the save-behavior fix and re-enter it clean. Destructive, asks
  // first — via ConfirmModal, same reasoning as requestClearDay.
  function requestClearEmployeeMonth(empId) {
    if (!period || !empId || refuseIfLocked()) return
    const name = employees.find(e => e.id === empId)?.full_name || 'employee'
    const touchedCount = days.filter(d => cellFor(empId, d)).length
    if (touchedCount === 0) {
      setSavedMsg(`ok:Nothing to clear — no records for ${name}.`)
      return
    }
    setConfirmClear({ kind: 'employee', empId, name, count: touchedCount })
  }
  async function clearEmployeeMonth(empId) {
    if (!period || !empId || refuseIfLocked()) return
    const name = employees.find(e => e.id === empId)?.full_name || 'employee'
    setConfirmClear(null)
    setSaving(true); setSavedMsg('')
    const { error } = await settleWithin(
      scopedDelete('hr_attendance').eq('employee_id', empId).eq('period_id', period.id),
      WRITE_MS, 'Clearing the month')
    if (error) {
      const lock = payLockOf(error)
      if (lock) await answerPayLock({ kind: lock, lead: `${name}'s records were not cleared.`, error })
      else setSavedMsg(`error:${name}'s records may not have been cleared — reload to see what is stored. ` + errorLine(error))
      setSaving(false); return
    }
    const reread = await loadAttendance(period.id, { carry: true, drop: key => splitCellKey(key).employeeId === empId })
    const done = `Cleared ${name}'s records for ${periodLabel}`
    setSavedMsg(reread === false ? landedButUnread(done) : `ok:${done}`)
    setSaving(false)
  }

  // Every listed employee's records for the whole month — Month Summary's clear. Two things the
  // per-day and per-employee clears never had to consider, because a month is what payroll reads:
  //   • A FINALIZED payroll run was built from these rows, so clearing them would leave issued
  //     payslips with nothing behind them. Refused, and a failed read of the run refuses too — a
  //     check that could not run has not passed.
  //   • The delete is scoped to the employees on this sheet (active/probation), not to the period:
  //     someone who left mid-month is not listed here, and their days are what Final Settlement
  //     reads — a period-wide delete would destroy them from a screen that never showed them.
  async function requestClearMonth() {
    if (!period) return
    const ids = new Set(employees.map(e => e.id))
    const count = Object.values(records).filter(r => ids.has(r.employee_id)).length
    if (count === 0) {
      setSavedMsg(`ok:Nothing to clear — ${periodLabel} has no records.`)
      return
    }
    const { data: run, error } = await scopedFrom('hr_payroll_runs', 'status').eq('period_id', period.id).maybeSingle()
    if (error) {
      setSavedMsg('error:Could not check whether payroll is already finalized for this month, so nothing was cleared. ' + errorLine(error))
      return
    }
    if (run?.status === 'finalized') {
      setSavedMsg(`error:Payroll for ${periodLabel} is finalized and its payslips were built from this attendance, so it can't be cleared. Reopen the payroll run first if the month really needs re-entering.`)
      return
    }
    setConfirmClear({ kind: 'month', count, draftRun: run?.status === 'draft' })
  }
  async function clearMonth() {
    if (!period || refuseIfLocked()) return
    setConfirmClear(null)
    setSaving(true); setSavedMsg('')
    const { error } = await settleWithin(
      scopedDelete('hr_attendance').eq('period_id', period.id).in('employee_id', employees.map(e => e.id)),
      WRITE_MS, 'Clearing the month')
    if (error) {
      const lock = payLockOf(error)
      if (lock) await answerPayLock({ kind: lock, lead: `${periodLabel} was not cleared.`, error, retry: 'Clear Month again to clear it for everyone else.' })
      else setSavedMsg(`error:${periodLabel} may not have been cleared — reload to see what is stored. ` + errorLine(error))
      setSaving(false); return
    }
    const listed = new Set(employees.map(e => e.id))
    const reread = await loadAttendance(period.id, { carry: true, drop: key => listed.has(splitCellKey(key).employeeId) })
    const done = `Cleared ${periodLabel} for all ${employees.length} listed staff`
    setSavedMsg(reread === false ? landedButUnread(done) : `ok:${done}`)
    setSaving(false)
  }

  function generateFromRosterForEmployee(empId) {
    if (!period || !empId || refuseIfLocked() || refuseIfRosterUnread()) return
    setSavedMsg('')
    const existing = Object.keys(records).filter(k => k.startsWith(`${empId}:`))
    const plan = planAttendanceFromRoster({
      rosterRows,
      shiftTypesById,
      employeeIds: [empId],
      existingDayKeys: new Set(existing),
      days,
      periodId: period.id,
      blockOf: bulkBlocker(),
    })
    if (plan.rows.length === 0) {
      const left = describeBlocked(plan.skipped)
      setSavedMsg(left
        ? `ok:Nothing to generate — the rostered days still blank are ${left}, and Generate leaves those blank.`
        : 'ok:Nothing to generate — every day already has an entry, or this employee isn\'t on the roster this month.')
      return
    }
    setPendingGenerate({ ...plan, who: employees.find(e => e.id === empId)?.full_name || 'this employee', kept: existing.length })
  }

  // ── Month summary aggregation ──────────────────────────────────────────────
  const dayCount = period ? daysInBsMonth(period.bs_year, period.bs_month) : 0
  const days = Array.from({ length: dayCount }, (_, i) => i + 1)

  // ── Unsaved work ───────────────────────────────────────────────────────────
  // Recomputed per keystroke over at most employees × days cells — a string join each, well under a
  // millisecond at 40 staff — which is what lets every marker below be exact rather than a flag
  // that one code path forgot to set.
  const unsaved = useMemo(() => unsavedKeys(records, savedRecords, timeKey), [records, savedRecords])
  const unsavedDays = useMemo(() => new Set(unsaved.map(k => splitCellKey(k).day)), [unsaved])
  const unsavedEmployees = useMemo(() => new Set(unsaved.map(k => splitCellKey(k).employeeId)), [unsaved])
  const unsavedSet = useMemo(() => new Set(unsaved), [unsaved])
  const openFlags = useMemo(() => Object.keys(importFlags).filter(k => stillIncomplete(records[k])), [importFlags, records])
  const openFlagSet = useMemo(() => new Set(openFlags), [openFlags])
  const unsavedFlags = useMemo(() => openFlags.filter(k => unsavedSet.has(k)), [openFlags, unsavedSet])
  // "Ronish — 6th, 9th" per employee, in sheet order, for the banner's shortcuts.
  const flagsByEmployee = useMemo(() => employees
    .map(emp => ({ emp, days: openFlags.map(splitCellKey).filter(k => k.employeeId === emp.id).map(k => k.day).sort((a, b) => a - b) }))
    .filter(x => x.days.length > 0), [employees, openFlags])
  // "3 changes on 5th Bhadra and 6th Bhadra" — the days named, because the day is what a reader goes
  // back to.
  function describeChanges(keys) {
    const ds = [...new Set(keys.map(k => splitCellKey(k).day))].sort((a, b) => a - b)
    const n = keys.length
    const what = `${n} change${n === 1 ? '' : 's'}`
    if (ds.length === 0) return what
    if (ds.length <= 3) {
      const named = ds.map(d => formatBsDay(d, period?.bs_month))
      return `${what} on ${named.length === 1 ? named[0] : named.slice(0, -1).join(', ') + ' and ' + named[named.length - 1]}`
    }
    return `${what} across ${ds.length} days`
  }
  const saveLabel = unsaved.length === 0
    ? 'All saved'
    : `Save ${unsaved.length} change${unsaved.length === 1 ? '' : 's'}${unsavedDays.size > 1 ? ` · ${unsavedDays.size} days` : ''}`

  // Closing or reloading the tab with unsaved marks asks first. In-app navigation cannot be held
  // here (a plain BrowserRouter has no blocker), which is why the banner above the grid says so.
  useEffect(() => {
    if (unsaved.length === 0) return
    const onBeforeUnload = e => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [unsaved.length])

  // How far into the month a blank day is owed (to today in the running month), for Unmarked.
  const unmarkedSpan = useMemo(() => (period ? unmarkedWindow(period) : null), [period])

  function summaryFor(emp) {
    const counts = {
      present: 0, half_day: 0, absent: 0, paid_leave: 0, unpaid_leave: 0,
      half_paid_leave: 0, half_unpaid_leave: 0, weekly_off: 0, holiday: 0,
    }
    let otHours = 0, hoursWorked = 0
    days.forEach(d => {
      const rec = cellFor(emp.id, d)
      if (!rec) return
      if (counts[rec.status] != null) counts[rec.status] += 1
      otHours     += parseFloat(rec.ot_hours) || 0
      hoursWorked += parseFloat(rec.hours_worked) || 0
    })
    // Round off the binary float drift from summing decimal hours across ~30 days (e.g. repeated
    // 0.1-type fractions summing to 9.600000000000001) rather than displaying/exporting it raw.
    otHours     = Math.round(otHours * 100) / 100
    hoursWorked = Math.round(hoursWorked * 100) / 100
    // Every marked day lands in exactly one of P, A, O, L or H (S798, ATTENDANCE-9), so they add up
    // to the days marked. A half day splits: the worked half is P, the other half A (a plain half
    // day, which payroll docks 0.5) or L (half-day leave). Total Days used to be P + A + O, which
    // left out leave and holidays, so a fully marked month could never read as one.
    const c = counts
    const present = c.present + (c.half_day + c.half_paid_leave + c.half_unpaid_leave) * 0.5
    const absent  = c.absent + c.half_day * 0.5
    const leave   = c.paid_leave + c.unpaid_leave + (c.half_paid_leave + c.half_unpaid_leave) * 0.5
    const marked  = Object.values(c).reduce((a, n) => a + n, 0)
    // Daily and hourly staff only (null for monthly, whose blank day is paid): the same count the
    // payroll month strip makes, through the same helper, over what is on screen now.
    const unmarked = unmarkedSpan ? unmarkedDaysFor(emp, unmarkedSpan, d => !!cellFor(emp.id, d)) : null
    return { counts, otHours, hoursWorked, present, absent, off: c.weekly_off, leave, holiday: c.holiday, marked, unmarked }
  }

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const rows = employees.map(emp => {
      const row = { 'Employee': emp.full_name, 'Code': emp.employee_code || '', 'Pay Basis': emp.pay_basis || 'monthly' }
      days.forEach(d => {
        const rec = cellFor(emp.id, d)
        row[`D${d}`] = rec ? (STATUS_MAP[rec.status]?.short || '') : ''
      })
      const s = summaryFor(emp)
      row['Present'] = s.counts.present
      row['Half'] = s.counts.half_day
      row['Absent'] = s.counts.absent
      row['Off'] = s.counts.weekly_off
      row['Paid Leave'] = s.counts.paid_leave + s.counts.half_paid_leave * 0.5
      row['Unpaid Leave'] = s.counts.unpaid_leave + s.counts.half_unpaid_leave * 0.5
      row['Holiday'] = s.holiday
      row['Total Days'] = s.marked
      // Blank for monthly staff, whose unmarked day is paid in full.
      row['Unmarked'] = s.unmarked ?? ''
      row['OT Hours'] = s.otHours
      if (emp.pay_basis === 'hourly') row['Hours Worked'] = s.hoursWorked
      return row
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance')
    const label = period ? `${BS_MONTHS[period.bs_month - 1]}-${period.bs_year}` : ''
    XLSX.writeFile(wb, `attendance_${label}.xlsx`)
  }

  const periodLabel = period ? `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}` : '—'

  if (!hasHrAccess('supervisor')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Attendance</h1>
          <p className="page-subtitle">Daily attendance, hours, and overtime — {periodLabel}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <select id="att-period" aria-label="Attendance period" className="form-select" value={period?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => (
              <option key={p.id} value={p.id}>
                {BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}
              </option>
            ))}
          </select>
          <Tip text="Bring in a month of punches from the attendance machine's Excel or CSV export. You pick which Crest employee each person on the machine is, and see what will change before anything goes on the sheet. Nothing is saved until you press Save." width={280}>
            <button className="btn btn-ghost" onClick={openImport} disabled={loading || !period || employees.length === 0 || !!attendanceError} style={{ fontSize: 12 }}>↑ Import from machine</button>
          </Tip>
          {tab === 'summary' && !attendanceError && <button className="btn btn-ghost" onClick={exportExcel} style={{ fontSize: 12 }}>⬇ Export Excel</button>}
        </div>
      </div>

      {/* Tabs */}
      <Tabs idBase="att" label="Attendance views" active={tab} onChange={setTab} style={{ marginBottom: 18 }}
        tabs={[{ key: 'mark', label: 'Mark Attendance' }, { key: 'employee', label: 'By Employee' }, { key: 'summary', label: 'Month Summary' }]} />

      {/* A paid month is read-only (S749). Amber, the product's banner shape (PayrollRun's
          stale-draft card): the whole border tinted, never a side rule. */}
      {!loading && period && locked && (
        <div role="alert" className="card" style={amberBanner}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>
            {runStatus === 'unknown' ? 'This sheet is locked — payroll status could not be checked' : `Payroll for ${periodLabel} is finalized — this sheet is locked`}
          </strong>
          <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 4, lineHeight: 1.6 }}>
            {runStatus === 'unknown'
              ? 'Nothing here can be changed until the page can confirm payroll for this month has not been finalized. Reload to try again.'
              : 'Its payslips were built from these records, so nothing on this sheet can be changed. To correct it, reopen the payroll run for this month, fix the days here, then finalize payroll again.'}
          </div>
        </div>
      )}
      {!loading && period && !locked && openFlags.length > 0 && (
        <div role="status" className="card" style={amberBanner}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>
            △ {openFlags.length} imported day{openFlags.length === 1 ? '' : 's'} to check
          </strong>
          <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 4, lineHeight: 1.6 }}>
            The machine has only one punch, or an in and out under an hour apart. Type the missing time, or change the day to Half-day, Absent or Off. Hours stay blank until you do — for hourly-paid staff a Present day with no hours pays nothing.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {flagsByEmployee.map(({ emp, days: flagDays }) => (
              <button key={emp.id} type="button" className="btn btn-ghost btn-sm"
                onClick={() => { setSelectedEmployeeId(emp.id); setTab('employee') }}>
                {emp.full_name} — {flagDays.map(bsDayOrdinal).join(', ')}
              </button>
            ))}
          </div>
        </div>
      )}
      {!loading && period && !locked && rosterReadError && (
        <div role="alert" className="card" style={amberBanner}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>The roster could not be read, so overtime is not being calculated</strong>
          <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 4, lineHeight: 1.6 }}>
            Typing a Start and End time will not fill in Hours or OT, and Generate from Roster is off — without each day&apos;s shift the figures would be measured against the wrong length of day, and payroll pays that overtime. Type Hours and OT yourself, or reload to try again. <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--theme-text3)' }}>{errorLine(rosterReadError)}</span>
          </div>
        </div>
      )}
      {/* S798 (ATTENDANCE-2): a working shift with no length is measured as an ordinary day, which is
          a stand-in, so the sheet says which shift needs its hours rather than let the figure pass. */}
      {!loading && period && !locked && !rosterReadError && unknownHourShifts.length > 0 && (
        <div className="card" style={amberBanner}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>
            △ {unknownHourShifts.map(s => `${s.name} (${s.days} day${s.days === 1 ? '' : 's'})`).join(', ')} {unknownHourShifts.length === 1 ? 'has' : 'have'} no hours set
          </strong>
          <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 4, lineHeight: 1.6 }}>
            Those days count as an ordinary {STANDARD_HOURS_PER_DAY}-hour day: typed or imported times put only the hours beyond {STANDARD_HOURS_PER_DAY} into OT, and Generate from Roster marks them Present for {STANDARD_HOURS_PER_DAY} hours. Set the shift&apos;s hours on Staff Roster → Shift Types so each day is measured against the real shift.
          </div>
        </div>
      )}

      {loading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>Loading…</div>
      ) : loadError ? (
        <div role="alert" className="card" style={{ padding: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-red-text)', marginBottom: 6 }}>Could not load the attendance sheet</div>
          <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{errorLine(loadError)}</div>
        </div>
      ) : employees.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>
          No active employees. Add employees in HR → Employees first.
        </div>
      ) : !period ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>
          {/* Only Crest creates a month from nothing, so a client is told who opens it (S790). */}
          {isAdmin
            ? 'No period found. Create a period in Periods first.'
            : 'No month is open yet. Crest opens your first month for you, so contact Crest support if it is missing.'}
        </div>
      ) : attendanceError ? (
        /* In place of the grid, never above it (S798): every write here decides from what is on
           screen, and an unread month would show as blank. */
        <div role="alert" className="card" style={{ padding: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-red-text)', marginBottom: 6 }}>Could not load {periodLabel}&apos;s attendance</div>
          <div style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6, marginBottom: 12 }}>
            Nothing can be marked, generated, imported or saved until it loads. A sheet that could not be read looks blank, and filling it in would replace days already marked, such as approved leave and absences.
          </div>
          {savedMsg && (
            <div role="status" style={{ fontSize: 12, color: savedMsg.startsWith('ok') ? 'var(--theme-green-text)' : 'var(--theme-red-text)', marginBottom: 12 }}>
              {savedMsg.split(':').slice(1).join(':')}
            </div>
          )}
          <button type="button" className="btn btn-primary" onClick={retryAttendance}>Try again</button>
          <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--theme-text3)', marginTop: 12 }}>{errorLine(attendanceError)}</div>
        </div>
      ) : tab === 'mark' ? (
        /* ── MARK ATTENDANCE ── */
        <div>
          {/* Day selector + bulk actions. Three clusters, deliberately separated: entry aids ·
              commit (Save Day) · destructive (Clear Day), the last pushed to its own bordered
              group at the end so a delete-everything action can't sit mid-row beside a bulk-fill
              button distinguished only by its text colour. */}
          <div className="card" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label htmlFor="att-day" style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Day</label>
                <select id="att-day" className="form-select" style={{ padding: CELL_PAD }} value={selectedDay} onChange={e => setSelectedDay(parseInt(e.target.value, 10))}>
                  {days.map(d => <option key={d} value={d}>{d} · {weekdayOf(period, d)}{unsavedDays.has(d) ? ' — unsaved' : ''}</option>)}
                </select>
              </div>
              <Tip text="Marks only the staff who have nothing marked for this day yet. Leave, absences and anything already marked are left as they are — change those one at a time." width={260} style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default' }}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => markAll('present')} disabled={locked}>All Present</button>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => markAll('weekly_off')} disabled={locked}>All Off</button>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => markAll('holiday')} disabled={locked}>All Holiday</button>
                </div>
              </Tip>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={generateFromRoster} disabled={generating || locked || !!rosterReadError}>
                {generating ? 'Generating…' : '⚡ Generate from Roster'}
              </button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Tip text="Feeds both 'Apply Break' buttons on this page — change it once to use a different default." width={220}>
                  <label htmlFor="att-default-break" style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Default break</label>
                </Tip>
                <input id="att-default-break" type="number" min="0" step="5" className="form-input form-input--auto" style={{ width: 60, textAlign: 'right', padding: CELL_PAD }}
                  value={defaultBreakMin} onChange={e => setDefaultBreakMin(parseInt(e.target.value, 10) || 0)} />
                <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>min</span>
                <Tip text="Fills the default break into every already-marked employee's blank Break cell for this day. Never overwrites a Break value already entered, and never marks an untouched employee." width={260}>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={applyBreakToDay} disabled={locked}>Apply Break to Day</button>
                </Tip>
              </div>
            </div>
            <div style={{ flex: 1 }} />
            {savedMsg && (
              <span role={savedMsg.startsWith('ok') ? 'status' : 'alert'}
                style={{ fontSize: 12, color: savedMsg.startsWith('ok') ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                {savedMsg.split(':').slice(1).join(':')}
              </span>
            )}
            <Tip text="Saves every unsaved mark on this sheet — every day and every employee, on either tab — in one go." width={240}>
              <button className="btn btn-primary" onClick={saveChanges} disabled={saving || locked || unsaved.length === 0}>
                {saving ? 'Saving…' : saveLabel}
              </button>
            </Tip>
            <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 14, borderLeft: '1px solid var(--theme-border)' }}>
              <Tip text="Deletes the saved record of every employee listed on this sheet for this day — the day reverts to blank for them. Staff who have left are not touched. Can't be undone.">
                <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red-text)' }} onClick={requestClearDay} disabled={saving || locked}>
                  🗑 Clear Day
                </button>
              </Tip>
            </div>
          </div>

          {unsaved.length > 0 && !locked && (
            <div className="card" style={amberBanner}>
              <strong style={{ color: 'var(--theme-amber-text)' }}>{describeChanges(unsaved)} not saved yet</strong>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 4, lineHeight: 1.6 }}>
                Marks stay on screen while you move between days and tabs, but nothing reaches payroll until you press Save. Leaving this page from the menu discards them — and for daily- and hourly-paid staff an unsaved day pays nothing.
              </div>
            </div>
          )}

          <div style={{ marginBottom: 14, fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            Only the days you actually mark are saved — an untouched day stays blank and is never assumed Present or Off. For daily- and hourly-paid staff a blank day pays nothing, so mark every day of the month (Present/Off/Holiday/Leave) before payroll runs.{' '}
            <Tip text="Fills blank days up to today from Staff Roster shift assignments — marked Present, with hours from the shift, and any hours beyond the shift's Normal hours filled in as OT. A working shift with no hours set counts as an ordinary 8-hour day. A zero-hour roster entry is read by its name: 'PAID LEAVE' becomes Paid Leave, any other 'LEAVE' becomes Unpaid Leave, a 'Holiday' becomes Holiday, and 'OFF DAY' becomes Off. Days after today, before someone joined or after they left, and days with no roster entry are left blank. Never overwrites a day that already has an entry, so a formal approved Leave Request or manual correction still takes precedence if entered afterward." width={320}>
              ⚡ Generate from Roster
            </Tip>{' '}pre-fills this month from Staff Roster shift assignments; it never overwrites a day you've already marked.
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th style={{ width: 150 }}>Status</th>
                    <th style={{ width: 100 }}>
                      <Tip text="Clock-in time — type 24-hour HH:MM (e.g. 09:00). Once both Start and End are valid, Hours and OT Hours are calculated automatically. If that day's roster shift has Normal hours set, OT is the clock time from Start to End beyond those normal hours (lunch included). Otherwise OT is the hours worked beyond the shift's length (or 8h if not on the roster that day)." width={300}>Start</Tip>
                    </th>
                    <th style={{ width: 100 }}>
                      <Tip text="Clock-out time — type 24-hour HH:MM (e.g. 18:30). Overnight shifts (end time earlier than start time) are handled automatically." width={260}>End</Tip>
                    </th>
                    <th style={{ width: 70, textAlign: 'right' }}>
                      <Tip text="Unpaid lunch/break minutes to subtract from the raw Start-to-End span before it becomes Hours Worked. On a shift with Normal hours set, the break does not reduce OT — those normal hours already include lunch. Leave blank if the shift has no unpaid break." width={260}>Break</Tip>
                    </th>
                    <th style={{ width: 90, textAlign: 'right' }}>
                      <Tip text="Hours worked that day — auto-filled from Start/End minus Break, or enter directly. Only used for hourly-paid staff." width={250}>Hours</Tip>
                    </th>
                    <th style={{ width: 90, textAlign: 'right' }}>
                      <Tip text="Overtime hours, paid at 1.5× the normal hourly rate during payroll — auto-filled from Start/End against that day's roster shift (its Normal hours when set), or enter directly. If the same day also has an approved entry in the Overtime module, that approved entry is what gets paid and the hours here are ignored for that day — so the same overtime can never be paid twice. Holiday overtime at 2× is only available through the Overtime module." width={280}>OT Hours</Tip>
                    </th>
                    <th>Note</th>
                    <th style={{ width: 32 }} />
                  </tr>
                </thead>
                <tbody>
                  {employees.map(emp => {
                    const status = statusFor(emp.id, selectedDay)
                    const rec = cellFor(emp.id, selectedDay)
                    const sc = STATUS_MAP[status]
                    // A day that was not worked takes no times, hours or OT (S749) — the boxes are
                    // off rather than silently discarded on save, so what is on screen is what pays.
                    const noClock = locked || isNonWorking(status)
                    const clockTitle = !locked && isNonWorking(status) ? `${sc?.label || 'This status'} is not a working day, so it takes no hours or overtime` : undefined
                    // Greyed by the name's colour and weight, never row opacity (page-layout.md). Still
                    // editable: the bulk buttons and Generate are what skip it (S798, ATTENDANCE-5).
                    const outside = outsideLabel(emp, selectedDay)
                    return (
                      <tr key={emp.id}>
                        <td>
                          <div style={{ fontWeight: outside ? 400 : 600, color: outside ? 'var(--theme-text3)' : 'var(--theme-text1)', fontSize: 13 }}>{emp.full_name}</div>
                          <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>
                            {emp.employee_code || ''}{emp.pay_basis && emp.pay_basis !== 'monthly' ? ` · ${emp.pay_basis}` : ''}
                          </div>
                          {outside && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{outside}</div>}
                          {unsavedSet.has(`${emp.id}:${selectedDay}`) && <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--theme-amber-text)' }}>Unsaved</div>}
                          {openFlagSet.has(`${emp.id}:${selectedDay}`) && <div style={{ fontSize: 11, color: 'var(--theme-amber-text)' }}>△ Check · machine: {importFlags[`${emp.id}:${selectedDay}`]}</div>}
                        </td>
                        <td>
                          <select
                            id={`att-status-${emp.id}`}
                            aria-label={`${emp.full_name} — status`}
                            className="form-select" style={{ padding: CELL_PAD, color: sc?.textColor || 'var(--theme-text3)', fontWeight: sc ? 600 : 400, width: '100%' }}
                            value={status || ''} disabled={locked}
                            onChange={e => e.target.value ? setCell(emp.id, selectedDay, 'status', e.target.value) : requestClearCell(emp.id, selectedDay)}
                          >
                            <option value="" style={{ color: 'var(--theme-text3)' }}>— Not marked —</option>
                            {ATTENDANCE_STATUSES.map(s => <option key={s.key} value={s.key} style={{ color: 'var(--theme-text1)' }}>{s.label}</option>)}
                          </select>
                        </td>
                        <td>
                          <input type="text" placeholder="--:--" id={`att-start-${emp.id}`} aria-label={`${emp.full_name} — start time`}
                            disabled={noClock} title={clockTitle}
                            className="form-input form-input--auto" style={{ width: 92, padding: CELL_PAD }}
                            {...fieldAria(`att-start-${emp.id}`, timeError(rec?.start_time, `${emp.id}:${selectedDay}:start_time`))}
                            value={rec?.start_time || ''} onChange={e => setTimeCell(emp.id, selectedDay, 'start_time', e.target.value)}
                            onFocus={() => setActiveTimeKey(`${emp.id}:${selectedDay}:start_time`)}
                            onBlur={() => { normalizeTimeCell(emp.id, selectedDay, 'start_time'); setActiveTimeKey('') }} />
                          <FieldError id={`att-start-${emp.id}`} message={timeError(rec?.start_time, `${emp.id}:${selectedDay}:start_time`)} />
                        </td>
                        <td>
                          <input type="text" placeholder="--:--" id={`att-end-${emp.id}`} aria-label={`${emp.full_name} — end time`}
                            disabled={noClock} title={clockTitle}
                            className="form-input form-input--auto" style={{ width: 92, padding: CELL_PAD }}
                            {...fieldAria(`att-end-${emp.id}`, timeError(rec?.end_time, `${emp.id}:${selectedDay}:end_time`))}
                            value={rec?.end_time || ''} onChange={e => setTimeCell(emp.id, selectedDay, 'end_time', e.target.value)}
                            onFocus={() => setActiveTimeKey(`${emp.id}:${selectedDay}:end_time`)}
                            onBlur={() => { normalizeTimeCell(emp.id, selectedDay, 'end_time'); setActiveTimeKey('') }} />
                          <FieldError id={`att-end-${emp.id}`} message={timeError(rec?.end_time, `${emp.id}:${selectedDay}:end_time`)} />
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <input type="number" min="0" step="5" id={`att-break-${emp.id}`} aria-label={`${emp.full_name} — unpaid break minutes`}
                            disabled={noClock} title={clockTitle}
                            className="form-input form-input--auto" style={{ width: 60, textAlign: 'right', padding: CELL_PAD }}
                            value={rec?.break_minutes ?? ''} onChange={e => setBreakCell(emp.id, selectedDay, e.target.value)} placeholder="0" />
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {emp.pay_basis === 'hourly' ? (
                            <input type="number" min="0" step="0.5" id={`att-hours-${emp.id}`} aria-label={`${emp.full_name} — hours worked`}
                              disabled={noClock} title={clockTitle}
                              className="form-input form-input--auto" style={{ width: 80, textAlign: 'right', padding: CELL_PAD }}
                              value={rec?.hours_worked ?? ''} onChange={e => setCell(emp.id, selectedDay, 'hours_worked', e.target.value)} placeholder="0" />
                          ) : <span style={{ color: 'var(--theme-text2)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <input type="number" min="0" step="0.5" id={`att-ot-${emp.id}`} aria-label={`${emp.full_name} — overtime hours`}
                            disabled={noClock} title={clockTitle}
                            className="form-input form-input--auto" style={{ width: 80, textAlign: 'right', padding: CELL_PAD }}
                            value={rec?.ot_hours ?? ''} onChange={e => setCell(emp.id, selectedDay, 'ot_hours', e.target.value)} placeholder="0" />
                          {(() => {
                            const short = shortfallFor(rec, emp.id, selectedDay)
                            return short && (
                              <Tip text={`Clocked ${short.measured}h against a ${assignedHoursFor(emp.id, selectedDay)}h roster shift — ${short.gap}h short. Not auto-deducted; reclassify as Half Day if warranted.`} width={230}>
                                <div style={{ fontSize: 11, color: 'var(--theme-amber-text)', marginTop: 2 }}>⚠ {short.gap}h short</div>
                              </Tip>
                            )
                          })()}
                        </td>
                        <td>
                          <input id={`att-note-${emp.id}`} aria-label={`${emp.full_name} — note`} disabled={locked}
                            className="form-input" style={{ padding: CELL_PAD }} value={rec?.note ?? ''} onChange={e => setCell(emp.id, selectedDay, 'note', e.target.value)} placeholder="—" />
                        </td>
                        <td>
                          {rec && !locked && (
                            <Tip text="Delete this record — reverts to Not Marked">
                              <button type="button" onClick={() => requestClearCell(emp.id, selectedDay)}
                                className="btn btn-ghost btn-sm btn-icon btn-icon--delete"
                                aria-label={`Delete ${emp.full_name}'s record for ${formatBsDay(selectedDay, period?.bs_month)}`}
                              ><span aria-hidden="true">🗑</span></button>
                            </Tip>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : tab === 'employee' ? (
        /* ── BY EMPLOYEE ── */
        <div>
          {/* Employee selector + bulk actions — same three-cluster grouping as the Mark tab:
              entry aids · commit (Save Month) · destructive (Clear Month), separated. */}
          <div className="card" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label htmlFor="att-emp" style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Employee</label>
                <select id="att-emp" className="form-select" style={{ padding: CELL_PAD }} value={selectedEmployeeId} onChange={e => setSelectedEmployeeId(e.target.value)}>
                  {employees.map(emp => <option key={emp.id} value={emp.id}>{emp.full_name}{unsavedEmployees.has(emp.id) ? ' — unsaved' : ''}</option>)}
                </select>
              </div>
              <Tip text="Marks only this employee's days that have nothing marked yet. Leave, absences and anything already marked are left as they are — change those one at a time." width={260} style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default' }}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => markAllDaysForEmployee(selectedEmployeeId, 'present')} disabled={locked}>All Present</button>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => markAllDaysForEmployee(selectedEmployeeId, 'weekly_off')} disabled={locked}>All Off</button>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => markAllDaysForEmployee(selectedEmployeeId, 'holiday')} disabled={locked}>All Holiday</button>
                </div>
              </Tip>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => generateFromRosterForEmployee(selectedEmployeeId)} disabled={generating || locked || !!rosterReadError}>
                {generating ? 'Generating…' : '⚡ Generate from Roster'}
              </button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Tip text="Feeds both 'Apply Break' buttons on this page — change it once to use a different default." width={220}>
                  <label htmlFor="att-emp-default-break" style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Default break</label>
                </Tip>
                <input id="att-emp-default-break" type="number" min="0" step="5" className="form-input form-input--auto" style={{ width: 60, textAlign: 'right', padding: CELL_PAD }}
                  value={defaultBreakMin} onChange={e => setDefaultBreakMin(parseInt(e.target.value, 10) || 0)} />
                <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>min</span>
                <Tip text="Fills the default break into every already-marked day's blank Break cell for this employee. Never overwrites a Break value already entered, and never marks an untouched day." width={260}>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => applyBreakToEmployeeMonth(selectedEmployeeId)} disabled={locked}>Apply Break to Month</button>
                </Tip>
              </div>
            </div>
            <div style={{ flex: 1 }} />
            {savedMsg && (
              <span role={savedMsg.startsWith('ok') ? 'status' : 'alert'}
                style={{ fontSize: 12, color: savedMsg.startsWith('ok') ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                {savedMsg.split(':').slice(1).join(':')}
              </span>
            )}
            <Tip text="Saves every unsaved mark on this sheet — every day and every employee, on either tab — in one go." width={240}>
              <button className="btn btn-primary" onClick={saveChanges} disabled={saving || locked || unsaved.length === 0}>
                {saving ? 'Saving…' : saveLabel}
              </button>
            </Tip>
            <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 14, borderLeft: '1px solid var(--theme-border)' }}>
              <Tip text="Deletes every saved record for this employee, this whole month — reverts it back to genuinely blank. Can't be undone.">
                <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red-text)' }} onClick={() => requestClearEmployeeMonth(selectedEmployeeId)} disabled={saving || locked}>
                  🗑 Clear Month
                </button>
              </Tip>
            </div>
          </div>

          {unsaved.length > 0 && !locked && (
            <div className="card" style={amberBanner}>
              <strong style={{ color: 'var(--theme-amber-text)' }}>{describeChanges(unsaved)} not saved yet</strong>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 4, lineHeight: 1.6 }}>
                Marks stay on screen while you move between days and tabs, but nothing reaches payroll until you press Save. Leaving this page from the menu discards them — and for daily- and hourly-paid staff an unsaved day pays nothing.
              </div>
            </div>
          )}

          <div style={{ marginBottom: 14, fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            Fill in this one employee's whole month here, day by day, instead of switching days on the Mark Attendance tab. Same data either way — both tabs read and write the same records, and one Save covers both.
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>Date</th>
                    <th style={{ width: 150 }}>Status</th>
                    <th style={{ width: 100 }}>
                      <Tip text="Clock-in time — type 24-hour HH:MM (e.g. 09:00). Once both Start and End are valid, Hours and OT Hours are calculated automatically. If that day's roster shift has Normal hours set, OT is the clock time from Start to End beyond those normal hours (lunch included). Otherwise OT is the hours worked beyond the shift's length (or 8h if not on the roster that day)." width={300}>Start</Tip>
                    </th>
                    <th style={{ width: 100 }}>
                      <Tip text="Clock-out time — type 24-hour HH:MM (e.g. 18:30). Overnight shifts (end time earlier than start time) are handled automatically." width={260}>End</Tip>
                    </th>
                    <th style={{ width: 70, textAlign: 'right' }}>
                      <Tip text="Unpaid lunch/break minutes to subtract from the raw Start-to-End span before it becomes Hours Worked. On a shift with Normal hours set, the break does not reduce OT — those normal hours already include lunch. Leave blank if the shift has no unpaid break." width={260}>Break</Tip>
                    </th>
                    <th style={{ width: 90, textAlign: 'right' }}>
                      <Tip text="Hours worked that day — auto-filled from Start/End minus Break, or enter directly. Only used for hourly-paid staff." width={250}>Hours</Tip>
                    </th>
                    <th style={{ width: 90, textAlign: 'right' }}>
                      <Tip text="Overtime hours, paid at 1.5× the normal hourly rate during payroll — auto-filled from Start/End against that day's roster shift (its Normal hours when set), or enter directly." width={280}>OT Hours</Tip>
                    </th>
                    <th>Note</th>
                    <th style={{ width: 32 }} />
                  </tr>
                </thead>
                <tbody>
                  {!selectedEmployeeId ? (
                    <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--theme-text2)', padding: 24 }}>Pick an employee above</td></tr>
                  ) : (() => {
                    const emp = employees.find(e => e.id === selectedEmployeeId)
                    return days.map(d => {
                      const status = statusFor(selectedEmployeeId, d)
                      const rec = cellFor(selectedEmployeeId, d)
                      const sc = STATUS_MAP[status]
                      const noClock = locked || isNonWorking(status)
                      const clockTitle = !locked && isNonWorking(status) ? `${sc?.label || 'This status'} is not a working day, so it takes no hours or overtime` : undefined
                      const outside = outsideLabel(emp, d)
                      return (
                        <tr key={d}>
                          <td style={{ color: outside ? 'var(--theme-text3)' : 'var(--theme-text1)', fontWeight: outside ? 400 : 600, fontSize: 13 }}>
                            {d} · {weekdayOf(period, d)}
                            {outside && <div style={{ fontSize: 11 }}>{outside}</div>}
                            {unsavedSet.has(`${selectedEmployeeId}:${d}`) && <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--theme-amber-text)' }}>Unsaved</div>}
                            {openFlagSet.has(`${selectedEmployeeId}:${d}`) && <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-amber-text)' }}>△ Check · machine: {importFlags[`${selectedEmployeeId}:${d}`]}</div>}
                          </td>
                          <td>
                            <select
                              id={`att-emp-status-${d}`}
                              aria-label={`Day ${d} — status`}
                              className="form-select" style={{ padding: CELL_PAD, color: sc?.textColor || 'var(--theme-text3)', fontWeight: sc ? 600 : 400, width: '100%' }}
                              value={status || ''} disabled={locked}
                              onChange={e => e.target.value ? setCell(selectedEmployeeId, d, 'status', e.target.value) : requestClearCell(selectedEmployeeId, d)}
                            >
                              <option value="" style={{ color: 'var(--theme-text3)' }}>— Not marked —</option>
                              {ATTENDANCE_STATUSES.map(s => <option key={s.key} value={s.key} style={{ color: 'var(--theme-text1)' }}>{s.label}</option>)}
                            </select>
                          </td>
                          <td>
                            <input type="text" placeholder="--:--" id={`att-emp-start-${d}`} aria-label={`Day ${d} — start time`}
                              disabled={noClock} title={clockTitle}
                              className="form-input form-input--auto" style={{ width: 92, padding: CELL_PAD }}
                              {...fieldAria(`att-emp-start-${d}`, timeError(rec?.start_time, `${selectedEmployeeId}:${d}:start_time`))}
                              value={rec?.start_time || ''} onChange={e => setTimeCell(selectedEmployeeId, d, 'start_time', e.target.value)}
                              onFocus={() => setActiveTimeKey(`${selectedEmployeeId}:${d}:start_time`)}
                              onBlur={() => { normalizeTimeCell(selectedEmployeeId, d, 'start_time'); setActiveTimeKey('') }} />
                            <FieldError id={`att-emp-start-${d}`} message={timeError(rec?.start_time, `${selectedEmployeeId}:${d}:start_time`)} />
                          </td>
                          <td>
                            <input type="text" placeholder="--:--" id={`att-emp-end-${d}`} aria-label={`Day ${d} — end time`}
                              disabled={noClock} title={clockTitle}
                              className="form-input form-input--auto" style={{ width: 92, padding: CELL_PAD }}
                              {...fieldAria(`att-emp-end-${d}`, timeError(rec?.end_time, `${selectedEmployeeId}:${d}:end_time`))}
                              value={rec?.end_time || ''} onChange={e => setTimeCell(selectedEmployeeId, d, 'end_time', e.target.value)}
                              onFocus={() => setActiveTimeKey(`${selectedEmployeeId}:${d}:end_time`)}
                              onBlur={() => { normalizeTimeCell(selectedEmployeeId, d, 'end_time'); setActiveTimeKey('') }} />
                            <FieldError id={`att-emp-end-${d}`} message={timeError(rec?.end_time, `${selectedEmployeeId}:${d}:end_time`)} />
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <input type="number" min="0" step="5" id={`att-emp-break-${d}`} aria-label={`Day ${d} — unpaid break minutes`}
                              disabled={noClock} title={clockTitle}
                              className="form-input form-input--auto" style={{ width: 60, textAlign: 'right', padding: CELL_PAD }}
                              value={rec?.break_minutes ?? ''} onChange={e => setBreakCell(selectedEmployeeId, d, e.target.value)} placeholder="0" />
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {emp?.pay_basis === 'hourly' ? (
                              <input type="number" min="0" step="0.5" id={`att-emp-hours-${d}`} aria-label={`Day ${d} — hours worked`}
                                disabled={noClock} title={clockTitle}
                                className="form-input form-input--auto" style={{ width: 80, textAlign: 'right', padding: CELL_PAD }}
                                value={rec?.hours_worked ?? ''} onChange={e => setCell(selectedEmployeeId, d, 'hours_worked', e.target.value)} placeholder="0" />
                            ) : <span style={{ color: 'var(--theme-text2)' }}>—</span>}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <input type="number" min="0" step="0.5" id={`att-emp-ot-${d}`} aria-label={`Day ${d} — overtime hours`}
                              disabled={noClock} title={clockTitle}
                              className="form-input form-input--auto" style={{ width: 80, textAlign: 'right', padding: CELL_PAD }}
                              value={rec?.ot_hours ?? ''} onChange={e => setCell(selectedEmployeeId, d, 'ot_hours', e.target.value)} placeholder="0" />
                            {(() => {
                              const short = shortfallFor(rec, selectedEmployeeId, d)
                              return short && (
                                <Tip text={`Clocked ${short.measured}h against a ${assignedHoursFor(selectedEmployeeId, d)}h roster shift — ${short.gap}h short. Not auto-deducted; reclassify as Half Day if warranted.`} width={230}>
                                  <div style={{ fontSize: 11, color: 'var(--theme-amber-text)', marginTop: 2 }}>⚠ {short.gap}h short</div>
                                </Tip>
                              )
                            })()}
                          </td>
                          <td>
                            <input id={`att-emp-note-${d}`} aria-label={`Day ${d} — note`} disabled={locked}
                              className="form-input" style={{ padding: CELL_PAD }} value={rec?.note ?? ''} onChange={e => setCell(selectedEmployeeId, d, 'note', e.target.value)} placeholder="—" />
                          </td>
                          <td>
                            {rec && !locked && (
                              <Tip text="Delete this record — reverts to Not Marked">
                                <button type="button" onClick={() => requestClearCell(selectedEmployeeId, d)}
                                  className="btn btn-ghost btn-sm btn-icon btn-icon--delete"
                                  aria-label={`Delete the record for ${formatBsDay(d, period?.bs_month)}`}
                                ><span aria-hidden="true">🗑</span></button>
                              </Tip>
                            )}
                          </td>
                        </tr>
                      )
                    })
                  })()}
                </tbody>
                {selectedEmployeeId && (
                  <tfoot>
                    <tr>
                      <td colSpan={6} style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)' }}>Total OT Hours</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)' }}>
                        {days.reduce((sum, d) => sum + (parseFloat(cellFor(selectedEmployeeId, d)?.ot_hours) || 0), 0).toFixed(1)}
                      </td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </div>
      ) : (
        /* ── MONTH SUMMARY ── */
        <div>
          {/* The summary counts what is on screen, unsaved marks included — so it says when that is
              not what payroll will read. */}
          {unsaved.length > 0 && !locked && (
            <div className="card" style={amberBanner}>
              <strong style={{ color: 'var(--theme-amber-text)' }}>{describeChanges(unsaved)} not saved yet — these totals include them</strong>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 4, lineHeight: 1.6 }}>
                Payroll reads only what is saved. Go back to Mark Attendance or By Employee and press Save.
              </div>
            </div>
          )}
          {/* Legend */}
          <div className="card" style={{ marginBottom: 14, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Legend</span>
            {ATTENDANCE_STATUSES.map(s => (
              <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--theme-text3)' }}>
                {/* Swatch fill/border are a tint of the BASE token, the short code on top is the
                    readable *-text variant. color-mix, not `${s.color}22` — a `var()` can't carry
                    a concatenated alpha suffix, so that produced invalid CSS (i.e. no tint at all)
                    for every status already on a token. */}
                <span style={{ width: 18, height: 18, borderRadius: 0, background: `color-mix(in srgb, ${s.color} 13%, transparent)`, border: `1px solid color-mix(in srgb, ${s.color} 33%, transparent)`, color: s.textColor, fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{s.short}</span>
                {s.label}
              </span>
            ))}
            <div style={{ flex: 1 }} />
            {savedMsg && (
              <span role={savedMsg.startsWith('ok') ? 'status' : 'alert'}
                style={{ fontSize: 12, color: savedMsg.startsWith('ok') ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                {savedMsg.split(':').slice(1).join(':')}
              </span>
            )}
            <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 14, borderLeft: '1px solid var(--theme-border)' }}>
              <Tip text="Deletes every listed employee's saved records for this whole month — the sheet reverts to blank. Refused once payroll for the month is finalized. Can't be undone.">
                <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red-text)' }} onClick={requestClearMonth} disabled={saving || locked}>
                  🗑 Clear Month
                </button>
              </Tip>
            </div>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="data-table" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ position: 'sticky', left: 0, background: 'var(--theme-card)', zIndex: 1 }}>Employee</th>
                    {days.map(d => (
                      <th key={d} style={{ textAlign: 'center', padding: '8px 4px' }}>
                        {d}
                      </th>
                    ))}
                    <th style={{ textAlign: 'right', borderLeft: '2px solid var(--theme-border)' }}>
                      <Tip text="Present days for the month — half-days and half-day leave (paid or unpaid) count as 0.5, matching how Payroll counts present days." width={250}>P</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Absent days for the month. A half day counts 0.5 here (the half not worked, which payroll docks) and 0.5 under P." width={240}>A</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Off days for the month — marked explicitly per employee, either directly or via Generate from Roster." width={220}>O</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Leave days, paid and unpaid together (the Excel export splits them). Half-day leave counts 0.5 here and 0.5 under P." width={240}>L</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Public holidays marked Holiday. A holiday pays daily and hourly staff for the day; monthly pay does not move." width={240}>H</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Total overtime hours for the month." width={200}>OT</Tip>
                    </th>
                    <th style={{ textAlign: 'right', borderLeft: '2px solid var(--theme-border)' }}>
                      {/* Days only — OT is hours and stays in its own column beside this one.
                          Adding the two together produced a figure in no unit at all. */}
                      <Tip text="Every marked day — P + A + O + L + H. Compare it with the month's length to see who still has blank days. Overtime is not included: it's hours, not days, and has its own column." width={260}>Total Days</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Daily and hourly staff only: days they were employed, up to today, with no mark at all. Payroll pays them nothing for a blank day, so mark every day they worked. Monthly staff show —, because a blank day is paid in full for them. Counts what is on screen, saved or not." width={280}>Unmarked</Tip>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map(emp => {
                    const s = summaryFor(emp)
                    return (
                      <tr key={emp.id}>
                        <td style={{ position: 'sticky', left: 0, background: 'var(--theme-card)', zIndex: 1, fontWeight: 600, color: 'var(--theme-text1)', whiteSpace: 'nowrap' }}>
                          {emp.full_name}
                        </td>
                        {days.map(d => {
                          const rec = cellFor(emp.id, d)
                          const sc = rec ? STATUS_MAP[rec.status] : null
                          const flagged = openFlagSet.has(`${emp.id}:${d}`)
                          return (
                            <td key={d} title={flagged ? `Imported day to check — machine: ${importFlags[`${emp.id}:${d}`]}` : undefined}
                              style={{ textAlign: 'center', padding: '6px 4px', ...(flagged ? { outline: '1px dashed var(--theme-amber)', outlineOffset: -3 } : null) }}>
                              {/* An unmarked day: text3, not the border token (1.22:1 Light, 1.36:1 Night),
                                  and named for a screen reader rather than read as "middle dot" (S803). */}
                              {sc ? <span style={{ color: sc.textColor, fontWeight: 700 }}>{sc.short}</span> : <span style={{ color: 'var(--theme-text3)' }}><span aria-hidden="true">·</span><span className="visually-hidden">Not marked</span></span>}
                            </td>
                          )
                        })}
                        <td style={{ textAlign: 'right', borderLeft: '2px solid var(--theme-border)', color: 'var(--theme-green-text)', fontWeight: 600 }}>{s.present || 0}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{s.absent || 0}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{s.off || 0}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{s.leave || 0}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{s.holiday || 0}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 600 }}>{s.otHours || 0}</td>
                        <td style={{ textAlign: 'right', borderLeft: '2px solid var(--theme-border)', color: 'var(--theme-text1)', fontWeight: 700 }}>
                          {s.marked}<span style={{ color: 'var(--theme-text3)', fontWeight: 400 }}> / {dayCount}</span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {s.unmarked == null
                            ? <span style={{ color: 'var(--theme-text3)' }}>—</span>
                            : s.unmarked > 0
                              ? <span style={{ color: 'var(--theme-amber-text)', fontWeight: 600 }}>△ {s.unmarked}</span>
                              : <span style={{ color: 'var(--theme-text2)' }}>0</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            P, A, O, L and H add up to Total Days, every day marked (a half day is 0.5 in each of its two columns). O counts explicit Off days. Unmarked counts the blank days that pay daily and hourly staff nothing. Nothing is marked off automatically — mark each staff member's off days directly, or via Generate from Roster. Payroll reads this sheet: marked absences and unpaid leave are deducted, daily and hourly staff are paid for the days and hours marked here, and overtime is paid at 1.5× unless an approved Overtime entry covers that day. Once payroll for a month is finalized, its sheet is locked.
          </div>
        </div>
      )}

      {importing && period && (
        <AttendanceImportModal
          period={period} periodLabel={periodLabel} employees={employees} records={records}
          rosterByKey={rosterByKey} shiftTypesById={shiftTypesById} autoHours={autoHoursFor}
          defaultBreak={defaultBreakMin}
          onApply={applyImport} onClose={() => setImporting(false)}
        />
      )}

      {confirmSaveFlags && (
        <ConfirmModal
          title={`Save with ${unsavedFlags.length} imported day${unsavedFlags.length === 1 ? '' : 's'} still to check?`}
          confirmLabel="Save anyway"
          busy={saving} busyLabel="Saving…"
          onConfirm={() => saveChanges({ force: true })}
          onCancel={() => setConfirmSaveFlags(false)}
        >
          <p style={{ margin: '0 0 10px' }}>
            {unsavedFlags.length === 1 ? 'This day has' : 'These days have'} only one punch, or an in and out under an hour apart. Saved as {unsavedFlags.length === 1 ? 'it is' : 'they are'},
            each is a Present day with no hours: a daily-paid employee is paid for the day, an hourly-paid employee is paid nothing for it, and no overtime is counted.
          </p>
          <p style={{ margin: 0 }}>
            To fix them first, cancel — they are listed in the amber box at the top of the sheet.
          </p>
        </ConfirmModal>
      )}

      {pendingPeriodId && (
        <ConfirmModal
          title={`Discard ${unsaved.length} unsaved change${unsaved.length === 1 ? '' : 's'}?`}
          confirmLabel="Discard and switch month"
          danger
          onConfirm={() => switchPeriod(pendingPeriodId)}
          onCancel={() => setPendingPeriodId(null)}
        >
          <p style={{ margin: '0 0 10px' }}>
            {describeChanges(unsaved)} in {periodLabel} {unsaved.length === 1 ? 'has' : 'have'} not been saved. Switching month now throws {unsaved.length === 1 ? 'it' : 'them'} away.
          </p>
          <p style={{ margin: 0 }}>
            To keep {unsaved.length === 1 ? 'it' : 'them'}, cancel and press Save first. For daily- and hourly-paid staff an unsaved day pays nothing.
          </p>
        </ConfirmModal>
      )}

      {pendingGenerate && (() => {
        const n = pendingGenerate.rows.length
        const count = st => pendingGenerate.rows.filter(r => r.status === st).length
        const unknown = pendingGenerate.unknownHours || 0
        const present = count('present') - unknown, ot = pendingGenerate.rows.filter(r => (r.ot_hours || 0) > 0).length
        const other = n - present - unknown
        const left = describeBlocked(pendingGenerate.skipped)
        return (
          <ConfirmModal
            title={`Fill ${n} blank day${n === 1 ? '' : 's'} from the roster?`}
            confirmLabel={`Fill ${n} day${n === 1 ? '' : 's'}`}
            busy={generating} busyLabel="Filling…"
            onConfirm={runGenerate}
            onCancel={() => setPendingGenerate(null)}
          >
            <p style={{ margin: '0 0 10px' }}>
              For {pendingGenerate.who}, {periodLabel}: <strong>{present}</strong> rostered working day{present === 1 ? '' : 's'} marked Present with the shift&apos;s hours
              {ot > 0 ? <> (<strong>{ot}</strong> of them carrying overtime beyond the shift&apos;s Normal hours, which payroll pays at 1.5×)</> : null}
              {other > 0 ? <>, and <strong>{other}</strong> zero-hour roster day{other === 1 ? '' : 's'} marked by the shift&apos;s name — Off, Holiday, or Paid / Unpaid Leave</> : null}.
            </p>
            {unknown > 0 && (
              <p style={{ margin: '0 0 10px', color: 'var(--theme-amber-text)' }}>
                △ <strong>{unknown}</strong> day{unknown === 1 ? ' is' : 's are'} on a working shift with no hours set ({unknownHourShifts.map(s => s.name).join(', ')}), marked Present for an ordinary {STANDARD_HOURS_PER_DAY}-hour day with no overtime. Set the shift&apos;s hours on Staff Roster → Shift Types if that is not right.
              </p>
            )}
            {left && (
              <p style={{ margin: '0 0 10px' }}>
                Left blank: {left}. Generate fills only days someone was employed, up to today; mark a later day one at a time if it really needs a mark now.
              </p>
            )}
            <p style={{ margin: 0 }}>
              Only blank days are filled — {pendingGenerate.kept} day{pendingGenerate.kept === 1 ? '' : 's'} already marked stay{pendingGenerate.kept === 1 ? 's' : ''} exactly as {pendingGenerate.kept === 1 ? 'it is' : 'they are'}, and a day with no roster entry stays blank. The filled days are saved straight away.
            </p>
          </ConfirmModal>
        )
      })()}

      {confirmClear && (
        <ConfirmModal
          title={confirmClear.kind === 'day'
            ? `Clear every record for Day ${selectedDay}?`
            : confirmClear.kind === 'month'
              ? `Clear all of ${periodLabel}?`
              : `Clear ${confirmClear.name}'s whole month?`}
          confirmLabel={confirmClear.kind === 'day'
            ? `Clear Day ${selectedDay} (${confirmClear.count})`
            : `Clear ${confirmClear.count} record${confirmClear.count === 1 ? '' : 's'}`}
          danger
          busy={saving} busyLabel="Clearing…"
          onConfirm={() => confirmClear.kind === 'day' ? clearDay()
            : confirmClear.kind === 'month' ? clearMonth()
            : clearEmployeeMonth(confirmClear.empId)}
          onCancel={() => setConfirmClear(null)}
        >
          <p style={{ margin: '0 0 10px' }}>
            {confirmClear.kind === 'day'
              ? <>All <strong>{confirmClear.count}</strong> attendance record{confirmClear.count === 1 ? '' : 's'} for {formatBsDay(selectedDay, period?.bs_month)} will be deleted, and any unsaved marks on that day with them — the day reverts to blank for every employee listed on this sheet. Staff who have left are not touched.</>
              : confirmClear.kind === 'month'
                ? <>All <strong>{confirmClear.count}</strong> attendance record{confirmClear.count === 1 ? '' : 's'} for {periodLabel} will be deleted, for all {employees.length} staff listed on this sheet — including approved leave days, which Leave → Mark approved leave puts back.</>
                : <>All <strong>{confirmClear.count}</strong> of {confirmClear.name}&apos;s attendance record{confirmClear.count === 1 ? '' : 's'} this month will be deleted.</>}
          </p>
          {confirmClear.kind === 'month' && confirmClear.draftRun && (
            <p style={{ margin: '0 0 10px' }}>
              A draft payroll run exists for this month. Regenerate it after re-entering attendance, or it will not finalize.
            </p>
          )}
          <p style={{ margin: 0 }}>
            A blank day pays <strong>zero</strong> for daily/hourly staff. Monthly staff are paid in
            full for a blank day, so any absence or unpaid leave that was marked stops being deducted.
            Re-enter the days (or Generate from Roster) before running payroll. This can&apos;t be undone.
          </p>
        </ConfirmModal>
      )}
      {confirmEl}
    </div>
  )
}
