import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import * as XLSX from 'xlsx'
import { BS_MONTHS, daysInBsMonth, bsToAd, getBsToday } from '../../../utils/bsCalendar'
import { ATTENDANCE_STATUSES, WEEKLY_OFF_WEEKDAY } from '../payrollConstants'
import { buildAttendanceFromRoster } from './attendanceFromRoster'

const STATUS_MAP = Object.fromEntries(ATTENDANCE_STATUSES.map(s => [s.key, s]))
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const inp = {
  background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 6,
  padding: '7px 10px', fontSize: 13, color: '#e8e0d0', outline: 'none',
  fontFamily: 'inherit',
}

function weekdayOf(period, day) {
  if (!period) return ''
  return WEEKDAYS[bsToAd(period.bs_year, period.bs_month, day).getDay()]
}

export default function AttendanceSheet() {
  const { clientId } = useAuth()
  const { scopedFrom, scopedUpsert } = useScopedDb()
  const [periods,   setPeriods]   = useState([])
  const [period,    setPeriod]    = useState(null)
  const [employees, setEmployees] = useState([])
  const [records,   setRecords]   = useState({})   // `${employee_id}:${bs_day}` -> row
  const [loading,   setLoading]   = useState(true)
  const [tab,       setTab]       = useState('mark')
  const [selectedDay, setSelectedDay] = useState(getBsToday().day)
  const [saving,    setSaving]    = useState(false)
  const [savedMsg,  setSavedMsg]  = useState('')
  const [generating, setGenerating] = useState(false)
  const [weeklyOffWeekday, setWeeklyOffWeekday] = useState(WEEKLY_OFF_WEEKDAY) // 0=Sun..6=Sat

  function isSaturday(period, day) {
    if (!period) return false
    return bsToAd(period.bs_year, period.bs_month, day).getDay() === weeklyOffWeekday
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
      const [{ data: p }, { data: emps }, { data: settings }] = await Promise.all([
        scopedFrom('monthly_periods')
          .order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
        scopedFrom('hr_employees', 'id, full_name, employee_code, pay_basis, status, department')
          .in('status', ['active', 'probation']).order('full_name'),
        supabase.from('settings').select('weekly_off_weekday').eq('client_id', clientId).maybeSingle(),
      ])
      setPeriods(p || [])
      setEmployees(emps || [])
      setWeeklyOffWeekday(settings?.weekly_off_weekday ?? WEEKLY_OFF_WEEKDAY)
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
  function defaultStatus(day) {
    return isSaturday(period, day) ? 'weekly_off' : 'present'
  }
  function statusFor(empId, day) {
    return cellFor(empId, day)?.status ?? defaultStatus(day)
  }
  function setCell(empId, field, value) {
    const key = `${empId}:${selectedDay}`
    setRecords(m => {
      const prev = m[key] || { employee_id: empId, bs_day: selectedDay, status: defaultStatus(selectedDay) }
      return { ...m, [key]: { ...prev, [field]: value } }
    })
  }
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

  async function saveDay() {
    if (!period) return
    setSaving(true); setSavedMsg('')
    const rows = employees.map(emp => {
      const rec = cellFor(emp.id, selectedDay)
      return {
        employee_id:  emp.id,
        period_id:    period.id,
        bs_day:       selectedDay,
        status:       rec?.status ?? defaultStatus(selectedDay),
        hours_worked: parseFloat(rec?.hours_worked) || 0,
        ot_hours:     parseFloat(rec?.ot_hours) || 0,
        note:         rec?.note || null,
      }
    })
    const { error } = await scopedUpsert('hr_attendance', rows, { onConflict: 'employee_id,period_id,bs_day' })
    if (error) { setSavedMsg('error:' + error.message); setSaving(false); return }
    await loadAttendance(period.id)
    setSavedMsg('ok:Saved Day ' + selectedDay)
    setSaving(false)
  }

  async function generateFromRoster() {
    if (!period) return
    setGenerating(true); setSavedMsg('')
    const [{ data: rosterRows }, { data: shiftTypes }] = await Promise.all([
      scopedFrom('hr_roster', 'employee_id, shift_type_id, bs_day')
        .eq('bs_year', period.bs_year).eq('bs_month', period.bs_month),
      scopedFrom('hr_shift_types', 'id, hours, start_time, end_time'),
    ])
    const shiftTypesById = Object.fromEntries((shiftTypes || []).map(s => [s.id, s]))
    const alreadySet = Object.keys(records).length
    const rows = buildAttendanceFromRoster({
      rosterRows: rosterRows || [],
      shiftTypesById,
      employeeIds: employees.map(e => e.id),
      existingDayKeys: new Set(Object.keys(records)),
      bsYear: period.bs_year,
      bsMonth: period.bs_month,
      days,
      periodId: period.id,
      offWeekday: weeklyOffWeekday,
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

  // ── Month summary aggregation ──────────────────────────────────────────────
  const dayCount = period ? daysInBsMonth(period.bs_year, period.bs_month) : 0
  const days = Array.from({ length: dayCount }, (_, i) => i + 1)

  function summaryFor(emp) {
    const counts = { present: 0, half_day: 0, absent: 0, paid_leave: 0, unpaid_leave: 0, weekly_off: 0, holiday: 0 }
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
      row['Paid Leave'] = s.counts.paid_leave
      row['Unpaid Leave'] = s.counts.unpaid_leave
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
  const dayIsSaturday = isSaturday(period, selectedDay)

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
        {[{ id: 'mark', label: 'Mark Attendance' }, { id: 'summary', label: 'Month Summary' }].map(t => (
          <button key={t.id} className={`tab-btn${tab === t.id ? ' tab-btn--active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {loading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
      ) : employees.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>
          No active employees. Add employees in HR → Employees first.
        </div>
      ) : !period ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>
          No period found. Create a period in Periods first.
        </div>
      ) : tab === 'mark' ? (
        /* ── MARK ATTENDANCE ── */
        <div>
          {/* Day selector + bulk actions */}
          <div className="card" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: '#6b7280' }}>Day</span>
              <select style={inp} value={selectedDay} onChange={e => setSelectedDay(parseInt(e.target.value, 10))}>
                {days.map(d => <option key={d} value={d}>{d} · {weekdayOf(period, d)}{isSaturday(period, d) ? ' (off)' : ''}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => markAll('present')}>All Present</button>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => markAll('weekly_off')}>All Weekly Off</button>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => markAll('holiday')}>All Holiday</button>
            </div>
            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={generateFromRoster} disabled={generating}>
              {generating ? 'Generating…' : '⚡ Generate from Roster'}
            </button>
            <div style={{ flex: 1 }} />
            {savedMsg && (
              <span style={{ fontSize: 12, color: savedMsg.startsWith('ok') ? '#34d399' : '#f87171' }}>
                {savedMsg.split(':').slice(1).join(':')}
              </span>
            )}
            <button className="btn btn-primary" onClick={saveDay} disabled={saving} style={{ fontSize: 13 }}>
              {saving ? 'Saving…' : 'Save Day'}
            </button>
          </div>

          {dayIsSaturday && (
            <div style={{ marginBottom: 14, padding: '10px 14px', background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.25)', borderRadius: 8, fontSize: 12, color: '#c9a84c' }}>
              ⚠ Day {selectedDay} is a Saturday — defaulted to Weekly Off. Adjust any staff who worked.
            </div>
          )}

          <div style={{ marginBottom: 14, fontSize: 11, color: '#6b7280', lineHeight: 1.6 }}>
            <Tip text="Fills blank days across the whole month from Staff Roster shift assignments — marked Present, with hours from the shift — and defaults unrostered Saturdays to Weekly Off. A roster shift with no hours (e.g. a custom 'LEAVE' or 'Day Off' entry) is marked Holiday rather than Present. Never overwrites a day that already has an entry, so a formal approved Leave Request or manual correction still takes precedence if entered afterward." width={320}>
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
                    <th style={{ width: 110, textAlign: 'right' }}>
                      <Tip text="Hours worked that day. Only used for hourly-paid staff." width={220}>Hours</Tip>
                    </th>
                    <th style={{ width: 110, textAlign: 'right' }}>
                      <Tip text="Overtime hours, paid at 1.5× the normal hourly rate during payroll. Don't also log the same hours in the Overtime module — both sources are paid, so duplicates pay twice (payroll flags this with an ⚠ OT ×2? badge)." width={270}>OT Hours</Tip>
                    </th>
                    <th>Note</th>
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
                          <div style={{ fontWeight: 600, color: '#e8e0d0', fontSize: 13 }}>{emp.full_name}</div>
                          <div style={{ fontSize: 10, color: '#6b7280' }}>
                            {emp.employee_code || ''}{emp.pay_basis && emp.pay_basis !== 'monthly' ? ` · ${emp.pay_basis}` : ''}
                          </div>
                        </td>
                        <td>
                          <select
                            style={{ ...inp, color: sc?.color || '#e8e0d0', fontWeight: 600, width: '100%' }}
                            value={status}
                            onChange={e => setCell(emp.id, 'status', e.target.value)}
                          >
                            {ATTENDANCE_STATUSES.map(s => <option key={s.key} value={s.key} style={{ color: '#e8e0d0' }}>{s.label}</option>)}
                          </select>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {emp.pay_basis === 'hourly' ? (
                            <input type="number" min="0" step="0.5" style={{ ...inp, width: 90, textAlign: 'right' }}
                              value={rec?.hours_worked ?? ''} onChange={e => setCell(emp.id, 'hours_worked', e.target.value)} placeholder="0" />
                          ) : <span style={{ color: '#4b5563' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <input type="number" min="0" step="0.5" style={{ ...inp, width: 90, textAlign: 'right' }}
                            value={rec?.ot_hours ?? ''} onChange={e => setCell(emp.id, 'ot_hours', e.target.value)} placeholder="0" />
                        </td>
                        <td>
                          <input style={{ ...inp, width: '100%' }} value={rec?.note ?? ''} onChange={e => setCell(emp.id, 'note', e.target.value)} placeholder="—" />
                        </td>
                      </tr>
                    )
                  })}
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
            <span style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Legend</span>
            {ATTENDANCE_STATUSES.map(s => (
              <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#9ca3af' }}>
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
                    <th style={{ position: 'sticky', left: 0, background: '#141820', zIndex: 1 }}>Employee</th>
                    {days.map(d => (
                      <th key={d} style={{ textAlign: 'center', padding: '8px 4px', background: isSaturday(period, d) ? 'rgba(75,85,99,0.18)' : undefined, color: isSaturday(period, d) ? '#9ca3af' : undefined }}>
                        {d}
                      </th>
                    ))}
                    <th style={{ textAlign: 'right', borderLeft: '2px solid #2a2f3d' }}>
                      <Tip text="Present days for the month (half-days count as 0.5)." width={230}>P</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Absent days for the month." width={180}>A</Tip>
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
                        <td style={{ position: 'sticky', left: 0, background: '#141820', zIndex: 1, fontWeight: 600, color: '#e8e0d0', whiteSpace: 'nowrap' }}>
                          {emp.full_name}
                        </td>
                        {days.map(d => {
                          const rec = cellFor(emp.id, d)
                          const sc = rec ? STATUS_MAP[rec.status] : null
                          const sat = isSaturday(period, d)
                          return (
                            <td key={d} style={{ textAlign: 'center', padding: '6px 4px', background: sat ? 'rgba(75,85,99,0.12)' : undefined }}>
                              {sc ? <span style={{ color: sc.color, fontWeight: 700 }}>{sc.short}</span> : <span style={{ color: '#2a2f3d' }}>·</span>}
                            </td>
                          )
                        })}
                        <td style={{ textAlign: 'right', borderLeft: '2px solid #2a2f3d', color: '#34d399', fontWeight: 600 }}>{s.counts.present + s.counts.half_day * 0.5 || 0}</td>
                        <td style={{ textAlign: 'right', color: '#f87171' }}>{s.counts.absent || 0}</td>
                        <td style={{ textAlign: 'right', color: '#c9a84c', fontWeight: 600 }}>{s.otHours || 0}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: '#4b5563', lineHeight: 1.6 }}>
            P column counts present days (half-days as 0.5). Saturdays are shaded and default to Weekly Off. Hours and overtime feed the future Payroll module, which computes actual pay for daily/hourly staff.
          </div>
        </div>
      )}
    </div>
  )
}
