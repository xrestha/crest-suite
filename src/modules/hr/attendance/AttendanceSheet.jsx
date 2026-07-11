import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import * as XLSX from 'xlsx'
import { BS_MONTHS, daysInBsMonth, bsToAd, getBsToday } from '../../../utils/bsCalendar'
import { ATTENDANCE_STATUSES, STANDARD_HOURS_PER_DAY } from '../payrollConstants'
import { buildAttendanceFromRoster } from './attendanceFromRoster'
import { calcHours, shiftHours } from '../roster/laborForecast'

const STATUS_MAP = Object.fromEntries(ATTENDANCE_STATUSES.map(s => [s.key, s]))
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const inp = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6,
  padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none',
  fontFamily: 'inherit',
}

function weekdayOf(period, day) {
  if (!period) return ''
  return WEEKDAYS[bsToAd(period.bs_year, period.bs_month, day).getDay()]
}

// Start/End are punched in as plain text (24-hour HH:MM), not a native time-picker widget —
// empty is fine (still typing / not entered), anything else must match the pattern exactly.
function isValidTimeStr(s) {
  return !s || /^([01]?\d|2[0-3]):[0-5]\d$/.test(s.trim())
}

export default function AttendanceSheet() {
  const { clientId } = useAuth()
  const { scopedFrom, scopedUpsert, scopedDelete } = useScopedDb()
  const [periods,   setPeriods]   = useState([])
  const [period,    setPeriod]    = useState(null)
  const [employees, setEmployees] = useState([])
  const [records,   setRecords]   = useState({})   // `${employee_id}:${bs_day}` -> row
  const [loading,   setLoading]   = useState(true)
  const [tab,       setTab]       = useState('mark')
  const [selectedDay, setSelectedDay] = useState(getBsToday().day)
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('') // By Employee tab
  const [saving,    setSaving]    = useState(false)
  const [savedMsg,  setSavedMsg]  = useState('')
  const [generating, setGenerating] = useState(false)
  // Shift types (client-wide) + this period's roster assignments — used to auto-calc OT when an
  // admin enters a Start/End time: worked hours beyond the employee's roster-assigned shift for
  // that day (or STANDARD_HOURS_PER_DAY if they're not on the roster that day) become OT.
  const [shiftTypesById, setShiftTypesById] = useState({})
  const [rosterRows,     setRosterRows]     = useState([])

  useEffect(() => {
    if (!clientId) return
    scopedFrom('hr_shift_types', 'id, name, hours, start_time, end_time').then(({ data }) => {
      setShiftTypesById(Object.fromEntries((data || []).map(s => [s.id, s])))
    })
  }, [clientId, scopedFrom])

  useEffect(() => {
    if (!period) { setRosterRows([]); return }
    scopedFrom('hr_roster', 'employee_id, shift_type_id, bs_day')
      .eq('bs_year', period.bs_year).eq('bs_month', period.bs_month)
      .then(({ data }) => setRosterRows(data || []))
  }, [period?.bs_year, period?.bs_month, scopedFrom]) // eslint-disable-line react-hooks/exhaustive-deps

  const rosterByKey = Object.fromEntries(rosterRows.map(r => [`${r.employee_id}:${r.bs_day}`, r.shift_type_id]))
  function assignedHoursFor(empId, day) {
    const shiftTypeId = rosterByKey[`${empId}:${day}`]
    return shiftTypeId ? shiftHours(shiftTypesById[shiftTypeId]) : STANDARD_HOURS_PER_DAY
  }

  const loadAttendance = useCallback(async (periodId) => {
    const { data } = await scopedFrom('hr_attendance').eq('period_id', periodId)
    const map = {}
    ;(data || []).forEach(r => { map[`${r.employee_id}:${r.bs_day}`] = r })
    setRecords(map)
  }, [scopedFrom])

  function applyPeriod(p) {
    setPeriod(p)
    const today = getBsToday()
    // Default the day selector to today when viewing the current BS month, else day 1.
    setSelectedDay(p.bs_year === today.year && p.bs_month === today.month ? today.day : 1)
  }

  useEffect(() => {
    if (!clientId) return
    async function load() {
      setLoading(true)
      const [{ data: p }, { data: emps }] = await Promise.all([
        scopedFrom('monthly_periods')
          .order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
        scopedFrom('hr_employees', 'id, full_name, employee_code, pay_basis, status, department')
          .in('status', ['active', 'probation']).order('full_name'),
      ])
      setPeriods(p || [])
      setEmployees(emps || [])
      setSelectedEmployeeId(prev => prev || (emps || [])[0]?.id || '')
      const open = (p || []).find(x => x.status === 'open') || (p || [])[0]
      if (open) { applyPeriod(open); await loadAttendance(open.id) }
      setLoading(false)
    }
    load()
  }, [clientId, scopedFrom, loadAttendance])

  async function handlePeriodChange(id) {
    const p = periods.find(x => x.id === id)
    if (!p) return
    applyPeriod(p)
    setLoading(true)
    await loadAttendance(id)
    setLoading(false)
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
    const key = `${empId}:${day}`
    setRecords(m => {
      const prev = m[key] || { employee_id: empId, bs_day: day, status: defaultStatus() }
      return { ...m, [key]: { ...prev, [field]: value } }
    })
  }
  // Reverts a cell to genuinely untouched — used both by the Status dropdown's "— Not marked —"
  // placeholder and the per-row delete button. Removes it from local state immediately for a
  // snappy UI, and if it was ever actually saved, deletes the row in the DB too — Save Day's
  // upsert only ever inserts/updates, never deletes, so without this a previously-saved value
  // would just silently reappear on the next reload.
  async function clearCell(empId, day) {
    const key = `${empId}:${day}`
    setRecords(m => {
      if (!(key in m)) return m
      const next = { ...m }
      delete next[key]
      return next
    })
    if (!period) return
    const { error } = await scopedDelete('hr_attendance').eq('employee_id', empId).eq('period_id', period.id).eq('bs_day', day)
    if (error) setSavedMsg('error:' + error.message)
  }
  // Start/End are punched in as plain text (24-hour HH:MM) — auto-computes Hours + OT (worked
  // hours beyond that day's roster-assigned shift) the moment both are valid times. Still just
  // seeds the Hours/OT Hours fields, which stay directly editable afterward if the auto-calc
  // needs a manual tweak. An invalid/partial time is kept as typed (so the admin can keep
  // fixing it) but never touches Hours/OT — the input border + a small "invalid" hint flag it.
  function setTimeCell(empId, day, field, value) {
    const key = `${empId}:${day}`
    setRecords(m => {
      const prev = m[key] || { employee_id: empId, bs_day: day, status: defaultStatus() }
      const next = { ...prev, [field]: value }
      const start = field === 'start_time' ? value : prev.start_time
      const end   = field === 'end_time'   ? value : prev.end_time
      if (isValidTimeStr(start) && isValidTimeStr(end)) {
        const worked = calcHours(start, end)
        if (worked != null) {
          next.hours_worked = worked
          next.ot_hours = Math.max(0, parseFloat((worked - assignedHoursFor(empId, day)).toFixed(1)))
        }
      }
      return { ...m, [key]: next }
    })
  }
  // All employees, one day (Mark Attendance tab's bulk buttons).
  function markAll(status) {
    setRecords(m => {
      const next = { ...m }
      employees.forEach(emp => {
        const key = `${emp.id}:${selectedDay}`
        next[key] = { ...(next[key] || { employee_id: emp.id, bs_day: selectedDay }), status }
      })
      return next
    })
  }
  // One employee, every day of the month (By Employee tab's bulk buttons).
  function markAllDaysForEmployee(empId, status) {
    setRecords(m => {
      const next = { ...m }
      days.forEach(d => {
        const key = `${empId}:${d}`
        next[key] = { ...(next[key] || { employee_id: empId, bs_day: d }), status }
      })
      return next
    })
  }

  async function saveDay() {
    if (!period) return
    setSaving(true); setSavedMsg('')
    // Only staff whose cell was actually touched (status changed, a time/hours/OT/note typed)
    // get written — an employee nobody clicked on for this day is skipped entirely rather than
    // silently persisted as Present. cellFor() returns undefined until setCell/setTimeCell has
    // run at least once for that key.
    const rows = employees
      .map(emp => {
        const rec = cellFor(emp.id, selectedDay)
        if (!rec) return null
        return {
          employee_id:  emp.id,
          period_id:    period.id,
          bs_day:       selectedDay,
          status:       rec.status ?? defaultStatus(),
          hours_worked: parseFloat(rec.hours_worked) || 0,
          ot_hours:     parseFloat(rec.ot_hours) || 0,
          note:         rec.note || null,
          // An invalid/partial typed time never reaches the DB's `time` column — it just isn't
          // saved (the admin still sees what they typed on screen until they fix or clear it).
          start_time:   isValidTimeStr(rec.start_time) ? (rec.start_time || null) : null,
          end_time:     isValidTimeStr(rec.end_time)   ? (rec.end_time   || null) : null,
        }
      })
      .filter(Boolean)
    if (rows.length === 0) {
      setSavedMsg('ok:Nothing to save — no changes were made for Day ' + selectedDay)
      setSaving(false)
      return
    }
    const { error } = await scopedUpsert('hr_attendance', rows, { onConflict: 'employee_id,period_id,bs_day' })
    if (error) { setSavedMsg('error:' + error.message); setSaving(false); return }
    await loadAttendance(period.id)
    setSavedMsg(`ok:Saved Day ${selectedDay} (${rows.length} of ${employees.length} staff)`)
    setSaving(false)
  }

  // Deletes every employee's record for the selected day — reverts the whole day back to
  // genuinely blank, e.g. to clean up a day that was wrongly bulk-marked before the save-behavior
  // fix. Destructive, so it asks first.
  async function clearDay() {
    if (!period) return
    const touched = employees.filter(emp => cellFor(emp.id, selectedDay))
    if (touched.length === 0) {
      setSavedMsg('ok:Nothing to clear — Day ' + selectedDay + ' has no records.')
      return
    }
    const ok = window.confirm(`Delete all ${touched.length} record(s) for Day ${selectedDay}? This can't be undone.`)
    if (!ok) return
    setSaving(true); setSavedMsg('')
    const { error } = await scopedDelete('hr_attendance').eq('period_id', period.id).eq('bs_day', selectedDay)
    if (error) { setSavedMsg('error:' + error.message); setSaving(false); return }
    await loadAttendance(period.id)
    setSavedMsg(`ok:Cleared Day ${selectedDay}`)
    setSaving(false)
  }

  async function generateFromRoster() {
    if (!period) return
    setGenerating(true); setSavedMsg('')
    // Reuses the shiftTypesById/rosterRows state already loaded for the Start/End OT auto-calc
    // above — same period, same shift types, no need to re-fetch.
    const alreadySet = Object.keys(records).length
    const rows = buildAttendanceFromRoster({
      rosterRows,
      shiftTypesById,
      employeeIds: employees.map(e => e.id),
      existingDayKeys: new Set(Object.keys(records)),
      days,
      periodId: period.id,
    })
    if (rows.length === 0) {
      setSavedMsg('ok:Nothing to generate — every day already has an entry, or no employees are on the roster this month.')
      setGenerating(false)
      return
    }
    const ok = window.confirm(
      `Generate attendance for ${rows.length} employee-day(s) from the roster?\n` +
      `${alreadySet} day(s) already have entries and will be left unchanged.`
    )
    if (!ok) { setGenerating(false); return }
    const { error } = await scopedUpsert('hr_attendance', rows, { onConflict: 'employee_id,period_id,bs_day' })
    if (error) { setSavedMsg('error:' + error.message); setGenerating(false); return }
    await loadAttendance(period.id)
    setSavedMsg(`ok:Generated ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} from roster`)
    setGenerating(false)
  }

  // ── By Employee tab: same idea as saveDay/generateFromRoster, but one employee × every day
  // of the month instead of every employee × one day. ─────────────────────────────────────────
  async function saveEmployeeMonth(empId) {
    if (!period || !empId) return
    setSaving(true); setSavedMsg('')
    // Only days actually touched for this employee get written — an untouched day is skipped
    // entirely rather than silently persisted as Present (same rule as saveDay()).
    const rows = days
      .map(d => {
        const rec = cellFor(empId, d)
        if (!rec) return null
        return {
          employee_id:  empId,
          period_id:    period.id,
          bs_day:       d,
          status:       rec.status ?? defaultStatus(),
          hours_worked: parseFloat(rec.hours_worked) || 0,
          ot_hours:     parseFloat(rec.ot_hours) || 0,
          note:         rec.note || null,
          start_time:   isValidTimeStr(rec.start_time) ? (rec.start_time || null) : null,
          end_time:     isValidTimeStr(rec.end_time)   ? (rec.end_time   || null) : null,
        }
      })
      .filter(Boolean)
    const name = employees.find(e => e.id === empId)?.full_name || 'employee'
    if (rows.length === 0) {
      setSavedMsg(`ok:Nothing to save — no changes were made for ${name}`)
      setSaving(false)
      return
    }
    const { error } = await scopedUpsert('hr_attendance', rows, { onConflict: 'employee_id,period_id,bs_day' })
    if (error) { setSavedMsg('error:' + error.message); setSaving(false); return }
    await loadAttendance(period.id)
    setSavedMsg(`ok:Saved ${rows.length} day${rows.length === 1 ? '' : 's'} for ${name}`)
    setSaving(false)
  }

  // Deletes every record for this employee, this whole period — e.g. to wipe a month that was
  // wrongly bulk-marked before the save-behavior fix and re-enter it clean. Destructive, asks first.
  async function clearEmployeeMonth(empId) {
    if (!period || !empId) return
    const name = employees.find(e => e.id === empId)?.full_name || 'employee'
    const touchedCount = days.filter(d => cellFor(empId, d)).length
    if (touchedCount === 0) {
      setSavedMsg(`ok:Nothing to clear — no records for ${name}.`)
      return
    }
    const ok = window.confirm(`Delete all ${touchedCount} record(s) for ${name} this month? This can't be undone.`)
    if (!ok) return
    setSaving(true); setSavedMsg('')
    const { error } = await scopedDelete('hr_attendance').eq('employee_id', empId).eq('period_id', period.id)
    if (error) { setSavedMsg('error:' + error.message); setSaving(false); return }
    await loadAttendance(period.id)
    setSavedMsg(`ok:Cleared ${name}'s records for ${periodLabel}`)
    setSaving(false)
  }

  async function generateFromRosterForEmployee(empId) {
    if (!period || !empId) return
    setGenerating(true); setSavedMsg('')
    const rows = buildAttendanceFromRoster({
      rosterRows,
      shiftTypesById,
      employeeIds: [empId],
      existingDayKeys: new Set(Object.keys(records).filter(k => k.startsWith(`${empId}:`))),
      days,
      periodId: period.id,
    })
    if (rows.length === 0) {
      setSavedMsg('ok:Nothing to generate — every day already has an entry, or this employee isn\'t on the roster this month.')
      setGenerating(false)
      return
    }
    const ok = window.confirm(`Generate attendance for ${rows.length} day(s) from the roster for this employee?`)
    if (!ok) { setGenerating(false); return }
    const { error } = await scopedUpsert('hr_attendance', rows, { onConflict: 'employee_id,period_id,bs_day' })
    if (error) { setSavedMsg('error:' + error.message); setGenerating(false); return }
    await loadAttendance(period.id)
    setSavedMsg(`ok:Generated ${rows.length} day${rows.length === 1 ? '' : 's'} from roster`)
    setGenerating(false)
  }

  // ── Month summary aggregation ──────────────────────────────────────────────
  const dayCount = period ? daysInBsMonth(period.bs_year, period.bs_month) : 0
  const days = Array.from({ length: dayCount }, (_, i) => i + 1)

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
    return { counts, otHours, hoursWorked }
  }

  function exportExcel() {
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

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Attendance</h1>
          <p className="page-subtitle">Daily attendance, hours, and overtime — {periodLabel}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <select className="form-select" value={period?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => (
              <option key={p.id} value={p.id}>
                {BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}
              </option>
            ))}
          </select>
          {tab === 'summary' && <button className="btn btn-ghost" onClick={exportExcel} style={{ fontSize: 12 }}>⬇ Export Excel</button>}
        </div>
      </div>

      {/* Tabs */}
      <div className="tab-bar" style={{ marginBottom: 18 }}>
        {[{ id: 'mark', label: 'Mark Attendance' }, { id: 'employee', label: 'By Employee' }, { id: 'summary', label: 'Month Summary' }].map(t => (
          <button key={t.id} className={`tab-btn${tab === t.id ? ' tab-btn--active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {loading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>Loading…</div>
      ) : employees.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>
          No active employees. Add employees in HR → Employees first.
        </div>
      ) : !period ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>
          No period found. Create a period in Periods first.
        </div>
      ) : tab === 'mark' ? (
        /* ── MARK ATTENDANCE ── */
        <div>
          {/* Day selector + bulk actions */}
          <div className="card" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Day</span>
              <select style={inp} value={selectedDay} onChange={e => setSelectedDay(parseInt(e.target.value, 10))}>
                {days.map(d => <option key={d} value={d}>{d} · {weekdayOf(period, d)}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => markAll('present')}>All Present</button>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => markAll('weekly_off')}>All Off</button>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => markAll('holiday')}>All Holiday</button>
            </div>
            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={generateFromRoster} disabled={generating}>
              {generating ? 'Generating…' : '⚡ Generate from Roster'}
            </button>
            <Tip text="Deletes every employee's saved record for this day — reverts the whole day back to genuinely blank. Can't be undone.">
              <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red)' }} onClick={clearDay} disabled={saving}>
                🗑 Clear Day
              </button>
            </Tip>
            <div style={{ flex: 1 }} />
            {savedMsg && (
              <span style={{ fontSize: 12, color: savedMsg.startsWith('ok') ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                {savedMsg.split(':').slice(1).join(':')}
              </span>
            )}
            <button className="btn btn-primary" onClick={saveDay} disabled={saving} style={{ fontSize: 13 }}>
              {saving ? 'Saving…' : 'Save Day'}
            </button>
          </div>

          <div style={{ marginBottom: 14, fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            Every day defaults to Present until you mark it otherwise — nothing is assumed off automatically; use Off/Holiday/Leave per staff member as needed.{' '}
            <Tip text="Fills blank days across the whole month from Staff Roster shift assignments — marked Present, with hours from the shift. A zero-hour roster entry named like an off day (e.g. 'OFF DAY', 'LEAVE') is marked Off; any other zero-hour entry is marked Holiday. Days with no roster entry at all are left blank for manual entry. Never overwrites a day that already has an entry, so a formal approved Leave Request or manual correction still takes precedence if entered afterward." width={320}>
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
                      <Tip text="Clock-in time — type 24-hour HH:MM (e.g. 09:00). Once both Start and End are valid, Hours and OT Hours are calculated automatically — worked hours beyond that day's roster-assigned shift (or 8h if not on the roster that day) become OT." width={300}>Start</Tip>
                    </th>
                    <th style={{ width: 100 }}>
                      <Tip text="Clock-out time — type 24-hour HH:MM (e.g. 18:30). Overnight shifts (end time earlier than start time) are handled automatically." width={260}>End</Tip>
                    </th>
                    <th style={{ width: 90, textAlign: 'right' }}>
                      <Tip text="Hours worked that day — auto-filled from Start/End, or enter directly. Only used for hourly-paid staff." width={240}>Hours</Tip>
                    </th>
                    <th style={{ width: 90, textAlign: 'right' }}>
                      <Tip text="Overtime hours, paid at 1.5× the normal hourly rate during payroll — auto-filled from Start/End against that day's roster-assigned shift, or enter directly. Don't also log the same hours in the Overtime module — both sources are paid, so duplicates pay twice (payroll flags this with an ⚠ OT ×2? badge)." width={280}>OT Hours</Tip>
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
                    return (
                      <tr key={emp.id}>
                        <td>
                          <div style={{ fontWeight: 600, color: 'var(--theme-text1)', fontSize: 13 }}>{emp.full_name}</div>
                          <div style={{ fontSize: 10, color: 'var(--theme-text2)' }}>
                            {emp.employee_code || ''}{emp.pay_basis && emp.pay_basis !== 'monthly' ? ` · ${emp.pay_basis}` : ''}
                          </div>
                        </td>
                        <td>
                          <select
                            style={{ ...inp, color: sc?.color || 'var(--theme-text3)', fontWeight: sc ? 600 : 400, width: '100%' }}
                            value={status || ''}
                            onChange={e => e.target.value ? setCell(emp.id, selectedDay, 'status', e.target.value) : clearCell(emp.id, selectedDay)}
                          >
                            <option value="" style={{ color: 'var(--theme-text3)' }}>— Not marked —</option>
                            {ATTENDANCE_STATUSES.map(s => <option key={s.key} value={s.key} style={{ color: 'var(--theme-text1)' }}>{s.label}</option>)}
                          </select>
                        </td>
                        <td>
                          <input type="text" placeholder="--:--" style={{ ...inp, width: 92, borderColor: !isValidTimeStr(rec?.start_time) ? 'var(--theme-red)' : undefined }}
                            value={rec?.start_time || ''} onChange={e => setTimeCell(emp.id, selectedDay, 'start_time', e.target.value)} />
                          {!isValidTimeStr(rec?.start_time) && <div style={{ fontSize: 11, color: 'var(--theme-red)', marginTop: 2 }}>invalid — use HH:MM</div>}
                        </td>
                        <td>
                          <input type="text" placeholder="--:--" style={{ ...inp, width: 92, borderColor: !isValidTimeStr(rec?.end_time) ? 'var(--theme-red)' : undefined }}
                            value={rec?.end_time || ''} onChange={e => setTimeCell(emp.id, selectedDay, 'end_time', e.target.value)} />
                          {!isValidTimeStr(rec?.end_time) && <div style={{ fontSize: 11, color: 'var(--theme-red)', marginTop: 2 }}>invalid — use HH:MM</div>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {emp.pay_basis === 'hourly' ? (
                            <input type="number" min="0" step="0.5" style={{ ...inp, width: 80, textAlign: 'right' }}
                              value={rec?.hours_worked ?? ''} onChange={e => setCell(emp.id, selectedDay, 'hours_worked', e.target.value)} placeholder="0" />
                          ) : <span style={{ color: 'var(--theme-text2)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <input type="number" min="0" step="0.5" style={{ ...inp, width: 80, textAlign: 'right' }}
                            value={rec?.ot_hours ?? ''} onChange={e => setCell(emp.id, selectedDay, 'ot_hours', e.target.value)} placeholder="0" />
                        </td>
                        <td>
                          <input style={{ ...inp, width: '100%' }} value={rec?.note ?? ''} onChange={e => setCell(emp.id, selectedDay, 'note', e.target.value)} placeholder="—" />
                        </td>
                        <td>
                          {rec && (
                            <Tip text="Delete this record — reverts to Not Marked">
                              <button onClick={() => clearCell(emp.id, selectedDay)}
                                style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 15, padding: 4, lineHeight: 1 }}
                                onMouseEnter={e => { e.currentTarget.style.color = 'var(--theme-red)' }}
                                onMouseLeave={e => { e.currentTarget.style.color = 'var(--theme-text3)' }}
                              >🗑</button>
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
          {/* Employee selector + bulk actions */}
          <div className="card" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Employee</span>
              <select style={inp} value={selectedEmployeeId} onChange={e => setSelectedEmployeeId(e.target.value)}>
                {employees.map(emp => <option key={emp.id} value={emp.id}>{emp.full_name}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => markAllDaysForEmployee(selectedEmployeeId, 'present')}>All Present</button>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => markAllDaysForEmployee(selectedEmployeeId, 'weekly_off')}>All Off</button>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => markAllDaysForEmployee(selectedEmployeeId, 'holiday')}>All Holiday</button>
            </div>
            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => generateFromRosterForEmployee(selectedEmployeeId)} disabled={generating}>
              {generating ? 'Generating…' : '⚡ Generate from Roster'}
            </button>
            <Tip text="Deletes every saved record for this employee, this whole month — reverts it back to genuinely blank. Can't be undone.">
              <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red)' }} onClick={() => clearEmployeeMonth(selectedEmployeeId)} disabled={saving}>
                🗑 Clear Month
              </button>
            </Tip>
            <div style={{ flex: 1 }} />
            {savedMsg && (
              <span style={{ fontSize: 12, color: savedMsg.startsWith('ok') ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                {savedMsg.split(':').slice(1).join(':')}
              </span>
            )}
            <button className="btn btn-primary" onClick={() => saveEmployeeMonth(selectedEmployeeId)} disabled={saving} style={{ fontSize: 13 }}>
              {saving ? 'Saving…' : 'Save Month'}
            </button>
          </div>

          <div style={{ marginBottom: 14, fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            Fill in this one employee's whole month here, day by day, instead of switching days on the Mark Attendance tab. Same data either way — both tabs read and write the same records.
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>Date</th>
                    <th style={{ width: 150 }}>Status</th>
                    <th style={{ width: 100 }}>
                      <Tip text="Clock-in time — type 24-hour HH:MM (e.g. 09:00). Once both Start and End are valid, Hours and OT Hours are calculated automatically — worked hours beyond that day's roster-assigned shift (or 8h if not on the roster that day) become OT." width={300}>Start</Tip>
                    </th>
                    <th style={{ width: 100 }}>
                      <Tip text="Clock-out time — type 24-hour HH:MM (e.g. 18:30). Overnight shifts (end time earlier than start time) are handled automatically." width={260}>End</Tip>
                    </th>
                    <th style={{ width: 90, textAlign: 'right' }}>
                      <Tip text="Hours worked that day — auto-filled from Start/End, or enter directly. Only used for hourly-paid staff." width={240}>Hours</Tip>
                    </th>
                    <th style={{ width: 90, textAlign: 'right' }}>
                      <Tip text="Overtime hours, paid at 1.5× the normal hourly rate during payroll — auto-filled from Start/End against that day's roster-assigned shift, or enter directly." width={280}>OT Hours</Tip>
                    </th>
                    <th>Note</th>
                    <th style={{ width: 32 }} />
                  </tr>
                </thead>
                <tbody>
                  {!selectedEmployeeId ? (
                    <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--theme-text2)', padding: 24 }}>Pick an employee above</td></tr>
                  ) : (() => {
                    const emp = employees.find(e => e.id === selectedEmployeeId)
                    return days.map(d => {
                      const status = statusFor(selectedEmployeeId, d)
                      const rec = cellFor(selectedEmployeeId, d)
                      const sc = STATUS_MAP[status]
                      return (
                        <tr key={d}>
                          <td style={{ color: 'var(--theme-text1)', fontWeight: 600, fontSize: 13 }}>{d} · {weekdayOf(period, d)}</td>
                          <td>
                            <select
                              style={{ ...inp, color: sc?.color || 'var(--theme-text3)', fontWeight: sc ? 600 : 400, width: '100%' }}
                              value={status || ''}
                              onChange={e => e.target.value ? setCell(selectedEmployeeId, d, 'status', e.target.value) : clearCell(selectedEmployeeId, d)}
                            >
                              <option value="" style={{ color: 'var(--theme-text3)' }}>— Not marked —</option>
                              {ATTENDANCE_STATUSES.map(s => <option key={s.key} value={s.key} style={{ color: 'var(--theme-text1)' }}>{s.label}</option>)}
                            </select>
                          </td>
                          <td>
                            <input type="text" placeholder="--:--" style={{ ...inp, width: 92, borderColor: !isValidTimeStr(rec?.start_time) ? 'var(--theme-red)' : undefined }}
                              value={rec?.start_time || ''} onChange={e => setTimeCell(selectedEmployeeId, d, 'start_time', e.target.value)} />
                            {!isValidTimeStr(rec?.start_time) && <div style={{ fontSize: 11, color: 'var(--theme-red)', marginTop: 2 }}>invalid — use HH:MM</div>}
                          </td>
                          <td>
                            <input type="text" placeholder="--:--" style={{ ...inp, width: 92, borderColor: !isValidTimeStr(rec?.end_time) ? 'var(--theme-red)' : undefined }}
                              value={rec?.end_time || ''} onChange={e => setTimeCell(selectedEmployeeId, d, 'end_time', e.target.value)} />
                            {!isValidTimeStr(rec?.end_time) && <div style={{ fontSize: 11, color: 'var(--theme-red)', marginTop: 2 }}>invalid — use HH:MM</div>}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {emp?.pay_basis === 'hourly' ? (
                              <input type="number" min="0" step="0.5" style={{ ...inp, width: 80, textAlign: 'right' }}
                                value={rec?.hours_worked ?? ''} onChange={e => setCell(selectedEmployeeId, d, 'hours_worked', e.target.value)} placeholder="0" />
                            ) : <span style={{ color: 'var(--theme-text2)' }}>—</span>}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <input type="number" min="0" step="0.5" style={{ ...inp, width: 80, textAlign: 'right' }}
                              value={rec?.ot_hours ?? ''} onChange={e => setCell(selectedEmployeeId, d, 'ot_hours', e.target.value)} placeholder="0" />
                          </td>
                          <td>
                            <input style={{ ...inp, width: '100%' }} value={rec?.note ?? ''} onChange={e => setCell(selectedEmployeeId, d, 'note', e.target.value)} placeholder="—" />
                          </td>
                          <td>
                            {rec && (
                              <Tip text="Delete this record — reverts to Not Marked">
                                <button onClick={() => clearCell(selectedEmployeeId, d)}
                                  style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 15, padding: 4, lineHeight: 1 }}
                                  onMouseEnter={e => { e.currentTarget.style.color = 'var(--theme-red)' }}
                                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--theme-text3)' }}
                                >🗑</button>
                              </Tip>
                            )}
                          </td>
                        </tr>
                      )
                    })
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        /* ── MONTH SUMMARY ── */
        <div>
          {/* Legend */}
          <div className="card" style={{ marginBottom: 14, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Legend</span>
            {ATTENDANCE_STATUSES.map(s => (
              <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--theme-text3)' }}>
                <span style={{ width: 18, height: 18, borderRadius: 4, background: `${s.color}22`, border: `1px solid ${s.color}55`, color: s.color, fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{s.short}</span>
                {s.label}
              </span>
            ))}
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
                      <Tip text="Present days for the month — half-days and half-day paid leave count as 0.5, matching how Payroll counts present days." width={250}>P</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Absent days for the month." width={180}>A</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Off days for the month — marked explicitly per employee, either directly or via Generate from Roster." width={220}>O</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Total overtime hours for the month." width={200}>OT</Tip>
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
                          return (
                            <td key={d} style={{ textAlign: 'center', padding: '6px 4px' }}>
                              {sc ? <span style={{ color: sc.color, fontWeight: 700 }}>{sc.short}</span> : <span style={{ color: 'var(--theme-border)' }}>·</span>}
                            </td>
                          )
                        })}
                        <td style={{ textAlign: 'right', borderLeft: '2px solid var(--theme-border)', color: 'var(--theme-green)', fontWeight: 600 }}>{s.counts.present + s.counts.half_day * 0.5 + s.counts.half_paid_leave * 0.5 || 0}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>{s.counts.absent || 0}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{s.counts.weekly_off || 0}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent)', fontWeight: 600 }}>{s.otHours || 0}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            P column counts present days (half-days as 0.5). O counts explicit Off days. Nothing is marked off automatically — mark each staff member's off days directly, or via Generate from Roster. Hours and overtime feed the future Payroll module, which computes actual pay for daily/hourly staff.
          </div>
        </div>
      )}
    </div>
  )
}
