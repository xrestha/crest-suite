import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '../../../supabaseClient'
import { useAuth } from '../../../context/AuthContext'
import { adToBs, bsToAd, daysInBsMonth, getBsToday, BS_MONTHS } from '../../../utils/bsCalendar'
import Tip from '../../../components/Tip'

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_SHIFTS = [
  { name: 'Morning',   color: '#3B82F6', start_time: '07:00', end_time: '15:00', hours: 8,  sort_order: 1 },
  { name: 'Afternoon', color: '#F59E0B', start_time: '13:00', end_time: '21:00', hours: 8,  sort_order: 2 },
  { name: 'Evening',   color: '#8B5CF6', start_time: '17:00', end_time: '01:00', hours: 8,  sort_order: 3 },
  { name: 'Night',     color: '#64748B', start_time: '21:00', end_time: '07:00', hours: 8,  sort_order: 4 },
  { name: 'Full Day',  color: '#10B981', start_time: '09:00', end_time: '18:00', hours: 9,  sort_order: 5 },
  { name: 'Split',     color: '#EC4899', start_time: null,    end_time: null,    hours: null, sort_order: 6 },
]

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcHours(start, end) {
  if (!start || !end) return null
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  let mins = (eh * 60 + em) - (sh * 60 + sm)
  if (mins < 0) mins += 24 * 60  // overnight shift
  return parseFloat((mins / 60).toFixed(1))
}

function fmtTime(t) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  const ampm = h < 12 ? 'am' : 'pm'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`
}

function weekSunday(date) {
  const d = new Date(date)
  d.setDate(d.getDate() - d.getDay())  // subtract days since Sunday (0=Sun,1=Mon…)
  d.setHours(0, 0, 0, 0)
  return d
}

function weekDays(start) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    return d
  })
}

function rKey(year, month, day, empId) {
  return `${year}:${month}:${day}:${empId}`
}

const stickyCol = {
  position: 'sticky',
  left: 0,
  zIndex: 1,
  background: 'var(--theme-card)',
}
const STICKY_CLS = 'roster-sticky'

const INP = {
  background: 'var(--theme-input-bg)',
  border: '1px solid var(--theme-border)',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 13,
  color: 'var(--theme-text1)',
  outline: 'none',
  fontFamily: 'inherit',
}

// ── ShiftPicker dropdown ──────────────────────────────────────────────────────

function ShiftPicker({ shifts, anchorRef, onSelect, onClose }) {
  const ref = useRef()

  useEffect(() => {
    function onDown(e) {
      if (
        ref.current && !ref.current.contains(e.target) &&
        anchorRef.current && !anchorRef.current.contains(e.target)
      ) onClose()
    }
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, anchorRef])

  const rect = anchorRef.current?.getBoundingClientRect()
  if (!rect) return null

  let top  = rect.bottom + 6
  let left = rect.left
  if (left + 210 > window.innerWidth)  left = window.innerWidth - 218
  if (top  + 320 > window.innerHeight) top  = rect.top - 320

  const active = shifts.filter(s => s.active !== false)

  return createPortal(
    <div ref={ref} style={{
      position: 'fixed', top, left, zIndex: 2100,
      background: 'var(--theme-card)', border: '1px solid var(--theme-border)',
      borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
      minWidth: 200, overflow: 'hidden',
    }}>
      {active.map(s => {
        const hrs = s.hours ?? calcHours(s.start_time, s.end_time)
        return (
          <button key={s.id} onClick={() => onSelect(s.id)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%',
              padding: '9px 14px', background: 'none', border: 'none',
              cursor: 'pointer', color: 'var(--theme-text1)', fontSize: 13, textAlign: 'left' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--theme-table-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'none'}
          >
            <span style={{ width: 12, height: 12, borderRadius: 3, background: s.color, flexShrink: 0 }} />
            <span style={{ flex: 1, fontWeight: 500 }}>{s.name}</span>
            {s.start_time && <span style={{ fontSize: 10, color: 'var(--theme-text3)' }}>{fmtTime(s.start_time)}</span>}
            {hrs != null && <span style={{ fontSize: 11, color: 'var(--theme-text3)', fontWeight: 600 }}>{hrs}h</span>}
          </button>
        )
      })}
      <div style={{ borderTop: '1px solid var(--theme-border)', padding: '2px 0' }}>
        <button onClick={() => onSelect(null)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%',
            padding: '8px 14px', background: 'none', border: 'none',
            cursor: 'pointer', color: 'var(--theme-text3)', fontSize: 12 }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--theme-table-hover)'}
          onMouseLeave={e => e.currentTarget.style.background = 'none'}
        >
          <span style={{ width: 12, height: 12, borderRadius: 3, border: '1px dashed var(--theme-text3)', flexShrink: 0 }} />
          Clear (Day Off)
        </button>
      </div>
    </div>,
    document.body
  )
}

// ── Shift Settings tab ────────────────────────────────────────────────────────

function ShiftSettingsPanel({ clientId, shiftTypes, setShiftTypes }) {
  const [editing, setEditing] = useState(null)
  const [adding,  setAdding]  = useState(false)
  const [form,    setForm]    = useState({ name: '', color: '#6B7280', start_time: '', end_time: '', hours: '' })
  const [saving,  setSaving]  = useState(false)

  function resolveHours(startT, endT, hoursVal) {
    if (hoursVal !== '' && hoursVal != null) return parseFloat(hoursVal)
    return calcHours(startT || null, endT || null)
  }

  async function saveEdit() {
    if (!editing?.name?.trim()) return
    setSaving(true)
    const { data } = await supabase.from('hr_shift_types').update({
      name:       editing.name.trim(),
      color:      editing.color,
      start_time: editing.start_time || null,
      end_time:   editing.end_time   || null,
      hours:      resolveHours(editing.start_time, editing.end_time, editing.hours),
    }).eq('id', editing.id).select().single()
    if (data) setShiftTypes(prev => prev.map(s => s.id === data.id ? data : s))
    setEditing(null)
    setSaving(false)
  }

  async function saveNew() {
    if (!form.name.trim() || !clientId) return
    setSaving(true)
    const { data } = await supabase.from('hr_shift_types').insert({
      client_id:  clientId,
      name:       form.name.trim(),
      color:      form.color,
      start_time: form.start_time || null,
      end_time:   form.end_time   || null,
      hours:      resolveHours(form.start_time, form.end_time, form.hours),
      sort_order: shiftTypes.length + 1,
    }).select().single()
    if (data) {
      setShiftTypes(prev => [...prev, data])
      setForm({ name: '', color: '#6B7280', start_time: '', end_time: '', hours: '' })
      setAdding(false)
    }
    setSaving(false)
  }

  async function toggleActive(s) {
    const { data } = await supabase.from('hr_shift_types')
      .update({ active: !s.active }).eq('id', s.id).select().single()
    if (data) setShiftTypes(prev => prev.map(x => x.id === data.id ? data : x))
  }

  async function deleteShift(id) {
    if (!window.confirm('Delete this shift type? Roster entries that use it will appear blank.')) return
    await supabase.from('hr_shift_types').delete().eq('id', id)
    setShiftTypes(prev => prev.filter(s => s.id !== id))
  }

  // Inline auto-hint for hours field
  function HoursHint({ startT, endT, val }) {
    if (val !== '' && val != null) return null
    const c = calcHours(startT, endT)
    if (c == null) return <span style={{ fontSize: 10, color: 'var(--theme-text3)' }}>auto</span>
    return <span style={{ fontSize: 10, color: 'var(--theme-accent)' }}>= {c}h</span>
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)' }}>Shift Types</h3>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text3)' }}>
            Customize the shift templates shown on the roster board
          </p>
        </div>
        {!adding && (
          <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={() => setAdding(true)}>
            + Add Shift
          </button>
        )}
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 44 }}>Color</th>
              <th>Name</th>
              <th><Tip text="When the shift starts (24-hour time). Used for display on the roster board.">Start</Tip></th>
              <th><Tip text="When the shift ends. Overnight shifts (e.g. 21:00–07:00) wrap correctly.">End</Tip></th>
              <th style={{ textAlign: 'right' }}>
                <Tip text="Total hours for this shift. Auto-calculated from start/end times if left blank. Set manually for split or flexible shifts.">Hours</Tip>
              </th>
              <th style={{ textAlign: 'center' }}>
                <Tip text="Inactive shifts are hidden from the picker but existing roster assignments are preserved.">Active</Tip>
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shiftTypes.map(s => {
              const compH  = calcHours(s.start_time, s.end_time)
              const dispH  = s.hours ?? compH
              const isEd   = editing?.id === s.id

              return (
                <tr key={s.id}>
                  {isEd ? (
                    <>
                      <td>
                        <input type="color" value={editing.color}
                          onChange={e => setEditing(p => ({ ...p, color: e.target.value }))}
                          style={{ width: 34, height: 28, border: 'none', borderRadius: 4, cursor: 'pointer', padding: 2, background: 'none' }} />
                      </td>
                      <td>
                        <input style={{ ...INP, minWidth: 120 }} value={editing.name}
                          onChange={e => setEditing(p => ({ ...p, name: e.target.value }))} />
                      </td>
                      <td>
                        <input type="time" style={{ ...INP, width: 112 }} value={editing.start_time || ''}
                          onChange={e => setEditing(p => ({ ...p, start_time: e.target.value }))} />
                      </td>
                      <td>
                        <input type="time" style={{ ...INP, width: 112 }} value={editing.end_time || ''}
                          onChange={e => setEditing(p => ({ ...p, end_time: e.target.value }))} />
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                          <HoursHint startT={editing.start_time} endT={editing.end_time} val={editing.hours} />
                          <input type="number" style={{ ...INP, width: 64 }} step="0.5" min="0" max="24"
                            placeholder="auto" value={editing.hours ?? ''}
                            onChange={e => setEditing(p => ({ ...p, hours: e.target.value }))} />
                        </div>
                      </td>
                      <td />
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-primary" style={{ fontSize: 11, padding: '4px 10px' }}
                            onClick={saveEdit} disabled={saving || !editing.name?.trim()}>Save</button>
                          <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                            onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>
                        <span style={{ display: 'inline-block', width: 22, height: 22, borderRadius: 4, background: s.color }} />
                      </td>
                      <td style={{ fontWeight: 600, color: s.color }}>{s.name}</td>
                      <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{s.start_time ? fmtTime(s.start_time) : '—'}</td>
                      <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{s.end_time   ? fmtTime(s.end_time)   : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{dispH != null ? `${dispH}h` : '—'}</td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={s.active !== false} onChange={() => toggleActive(s)} />
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-ghost" style={{ fontSize: 11 }}
                            onClick={() => setEditing({ ...s, hours: s.hours ?? '' })}>Edit</button>
                          <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red)' }}
                            onClick={() => deleteShift(s.id)}>Delete</button>
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              )
            })}

            {adding && (
              <tr>
                <td>
                  <input type="color" value={form.color}
                    onChange={e => setForm(p => ({ ...p, color: e.target.value }))}
                    style={{ width: 34, height: 28, border: 'none', borderRadius: 4, cursor: 'pointer', padding: 2, background: 'none' }} />
                </td>
                <td>
                  <input style={{ ...INP, minWidth: 120 }} placeholder="e.g. Morning"
                    value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
                </td>
                <td>
                  <input type="time" style={{ ...INP, width: 112 }} value={form.start_time}
                    onChange={e => setForm(p => ({ ...p, start_time: e.target.value }))} />
                </td>
                <td>
                  <input type="time" style={{ ...INP, width: 112 }} value={form.end_time}
                    onChange={e => setForm(p => ({ ...p, end_time: e.target.value }))} />
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                    <HoursHint startT={form.start_time} endT={form.end_time} val={form.hours} />
                    <input type="number" style={{ ...INP, width: 64 }} step="0.5" min="0" max="24"
                      placeholder="auto" value={form.hours}
                      onChange={e => setForm(p => ({ ...p, hours: e.target.value }))} />
                  </div>
                </td>
                <td />
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-primary" style={{ fontSize: 11, padding: '4px 10px' }}
                      onClick={saveNew} disabled={saving || !form.name.trim()}>Add</button>
                    <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                      onClick={() => { setAdding(false); setForm({ name: '', color: '#6B7280', start_time: '', end_time: '', hours: '' }) }}>
                      Cancel
                    </button>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 10, marginBottom: 0 }}>
        Leave Hours blank to auto-calculate from start/end times. Overnight shifts (e.g. Night 21:00–07:00) wrap past midnight automatically.
      </p>
    </div>
  )
}

// ── Main Roster ───────────────────────────────────────────────────────────────

export default function Roster() {
  const { clientId } = useAuth()
  const today = getBsToday()

  const [tab,        setTab]        = useState('board')
  const [viewMode,   setViewMode]   = useState('weekly')
  const [weekStart,  setWeekStart]  = useState(() => weekSunday(new Date()))
  const [bsYear,     setBsYear]     = useState(today.year)
  const [bsMonth,    setBsMonth]    = useState(today.month)
  const [deptFilter, setDeptFilter] = useState('All')

  const [shiftTypes, setShiftTypes] = useState([])
  const [employees,  setEmployees]  = useState([])
  const [roster,     setRoster]     = useState({})
  const [loading,    setLoading]    = useState(true)

  const [activeCell, setActiveCell] = useState(null)
  const anchorRef = useRef(null)

  // ── Load shift types + employees (once per clientId) ───────────────────────
  useEffect(() => {
    if (!clientId) return
    async function init() {
      const [{ data: st }, { data: emps }] = await Promise.all([
        supabase.from('hr_shift_types').select('*').eq('client_id', clientId).order('sort_order'),
        supabase.from('hr_employees')
          .select('id, full_name, employee_code, department, status')
          .eq('client_id', clientId)
          .in('status', ['active', 'probation'])
          .order('full_name'),
      ])
      let shifts = st || []
      if (shifts.length === 0) {
        const { data: seeded } = await supabase.from('hr_shift_types')
          .insert(DEFAULT_SHIFTS.map(s => ({ ...s, client_id: clientId }))).select()
        shifts = seeded || []
      }
      setShiftTypes(shifts)
      setEmployees(emps || [])
    }
    init()
  }, [clientId])

  // ── Load roster entries for the visible date range ─────────────────────────
  const loadRoster = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    let all = []

    if (viewMode === 'weekly') {
      // Week can span two BS months — group unique year/month combos
      const months = new Map()
      weekDays(weekStart).forEach(d => {
        const bs = adToBs(d)
        const k  = `${bs.year}:${bs.month}`
        if (!months.has(k)) months.set(k, bs)
      })
      for (const bs of months.values()) {
        const { data } = await supabase.from('hr_roster').select('*')
          .eq('client_id', clientId).eq('bs_year', bs.year).eq('bs_month', bs.month)
        all.push(...(data || []))
      }
    } else {
      const { data } = await supabase.from('hr_roster').select('*')
        .eq('client_id', clientId).eq('bs_year', bsYear).eq('bs_month', bsMonth)
      all = data || []
    }

    const map = {}
    all.forEach(r => { map[rKey(r.bs_year, r.bs_month, r.bs_day, r.employee_id)] = r })
    setRoster(map)
    setLoading(false)
  }, [clientId, viewMode, weekStart, bsYear, bsMonth])

  useEffect(() => { loadRoster() }, [loadRoster])

  // ── Assign or clear a shift on one cell ───────────────────────────────────
  async function assignShift(year, month, day, empId, shiftTypeId) {
    if (!clientId) return
    const key = rKey(year, month, day, empId)

    // Capture existing before optimistic update
    const existing = roster[key]

    // Optimistic update
    setRoster(prev => {
      if (shiftTypeId === null) {
        const next = { ...prev }
        delete next[key]
        return next
      }
      return {
        ...prev,
        [key]: { ...(prev[key] || {}), shift_type_id: shiftTypeId, bs_year: year, bs_month: month, bs_day: day, employee_id: empId },
      }
    })
    setActiveCell(null)

    if (shiftTypeId === null) {
      if (existing?.id) await supabase.from('hr_roster').delete().eq('id', existing.id)
    } else {
      const { data } = await supabase.from('hr_roster').upsert({
        client_id: clientId, employee_id: empId,
        shift_type_id: shiftTypeId,
        bs_year: year, bs_month: month, bs_day: day,
      }, { onConflict: 'client_id,employee_id,bs_year,bs_month,bs_day' }).select().single()
      if (data) setRoster(prev => ({ ...prev, [key]: data }))
    }
  }

  // ── Compute columns for current view ──────────────────────────────────────
  let columns = []
  if (viewMode === 'weekly') {
    columns = weekDays(weekStart).map(d => {
      const bs = adToBs(d)
      return {
        bsYear: bs.year, bsMonth: bs.month, bsDay: bs.day,
        label:    WEEKDAYS[d.getDay()],
        sublabel: `${bs.day} ${BS_MONTHS[bs.month - 1].slice(0, 3)}`,
        isSat:    d.getDay() === 6,
      }
    })
  } else {
    const total = daysInBsMonth(bsYear, bsMonth)
    for (let d = 1; d <= total; d++) {
      const adDate = bsToAd(bsYear, bsMonth, d)
      columns.push({
        bsYear, bsMonth, bsDay: d,
        label:    d,
        sublabel: WEEKDAYS[adDate.getDay()].slice(0, 2),
        isSat:    adDate.getDay() === 6,
      })
    }
  }

  const shiftMap     = Object.fromEntries(shiftTypes.map(s => [s.id, s]))
  const depts        = ['All', ...Array.from(new Set(employees.map(e => e.department).filter(Boolean))).sort()]
  const filteredEmps = deptFilter === 'All' ? employees : employees.filter(e => e.department === deptFilter)

  function empHrs(empId) {
    return columns.reduce((sum, col) => {
      const e = roster[rKey(col.bsYear, col.bsMonth, col.bsDay, empId)]
      const s = e ? shiftMap[e.shift_type_id] : null
      return sum + (s ? (s.hours ?? calcHours(s.start_time, s.end_time) ?? 0) : 0)
    }, 0)
  }

  function dayHrs(col) {
    return filteredEmps.reduce((sum, emp) => {
      const e = roster[rKey(col.bsYear, col.bsMonth, col.bsDay, emp.id)]
      const s = e ? shiftMap[e.shift_type_id] : null
      return sum + (s ? (s.hours ?? calcHours(s.start_time, s.end_time) ?? 0) : 0)
    }, 0)
  }

  // Weekly label spanning potentially 2 BS months
  const weekLabel = (() => {
    const days = weekDays(weekStart)
    const s    = adToBs(days[0])
    const e    = adToBs(days[6])
    const sm   = BS_MONTHS[s.month - 1]
    const em   = BS_MONTHS[e.month - 1]
    if (s.month === e.month && s.year === e.year) return `${sm} ${s.day}–${e.day}, ${s.year}`
    return `${sm} ${s.day} – ${em} ${e.day}, ${s.year}`
  })()

  const periodLabel = viewMode === 'weekly'
    ? weekLabel
    : `${BS_MONTHS[bsMonth - 1]} ${bsYear}`

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div>
      <style>{`
        @media print {
          @page { size: A4 landscape; margin: 12mm 10mm; }
          .roster-print-header, .roster-print-header *,
          .roster-board, .roster-board * {
            background: #fff !important;
            color: #111 !important;
            border-color: #bbb !important;
            box-shadow: none !important;
            outline: none !important;
          }
          .roster-sticky { position: static !important; }
          .roster-wrap   { overflow: visible !important; }
          .roster-cell   { border: 1px solid #ccc !important; }
          .roster-cell.filled { background: #e8e8e8 !important; border-color: #888 !important; }
        }
      `}</style>

      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Staff Roster</h1>
          <p className="page-subtitle">Plan weekly and monthly shift schedules for all staff</p>
        </div>
      </div>

      {/* Top tab bar */}
      <div className="tab-bar no-print" style={{ marginBottom: 20 }}>
        <button className={`tab-btn${tab === 'board'  ? ' tab-btn--active' : ''}`} onClick={() => setTab('board')}>Roster Board</button>
        <button className={`tab-btn${tab === 'shifts' ? ' tab-btn--active' : ''}`} onClick={() => setTab('shifts')}>Shift Types</button>
      </div>

      {/* ── Shift Settings tab ── */}
      {tab === 'shifts' && (
        <ShiftSettingsPanel clientId={clientId} shiftTypes={shiftTypes} setShiftTypes={setShiftTypes} />
      )}

      {/* ── Roster Board tab ── */}
      {tab === 'board' && (
        <>
          {/* Print-only header */}
          <div className="print-only roster-print-header" style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Staff Roster — {periodLabel}</div>
            <div style={{ fontSize: 11, marginTop: 4, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {shiftTypes.filter(s => s.active !== false).map(s => {
                const hrs = s.hours ?? calcHours(s.start_time, s.end_time)
                return (
                  <span key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: s.color }} />
                    {s.name}{s.start_time ? ` ${fmtTime(s.start_time)}–${fmtTime(s.end_time)}` : ''}{hrs != null ? ` (${hrs}h)` : ''}
                  </span>
                )
              })}
            </div>
          </div>

          {/* Controls */}
          <div className="no-print" style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>

            {/* View mode */}
            <div className="tab-bar">
              <button className={`tab-btn${viewMode === 'weekly'  ? ' tab-btn--active' : ''}`} onClick={() => setViewMode('weekly')}>Weekly</button>
              <button className={`tab-btn${viewMode === 'monthly' ? ' tab-btn--active' : ''}`} onClick={() => setViewMode('monthly')}>Monthly</button>
            </div>

            {/* Navigation */}
            {viewMode === 'weekly' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button className="btn btn-ghost" style={{ padding: '4px 10px' }}
                  onClick={() => { const d = new Date(weekStart); d.setDate(d.getDate() - 7); setWeekStart(d) }}>‹</button>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', minWidth: 210, textAlign: 'center' }}>
                  {weekLabel}
                </span>
                <button className="btn btn-ghost" style={{ padding: '4px 10px' }}
                  onClick={() => { const d = new Date(weekStart); d.setDate(d.getDate() + 7); setWeekStart(d) }}>›</button>
                <button className="btn btn-ghost" style={{ fontSize: 11 }}
                  onClick={() => setWeekStart(weekSunday(new Date()))}>Today</button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button className="btn btn-ghost" style={{ padding: '4px 10px' }}
                  onClick={() => { if (bsMonth === 1) { setBsYear(y => y - 1); setBsMonth(12) } else setBsMonth(m => m - 1) }}>‹</button>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', minWidth: 150, textAlign: 'center' }}>
                  {BS_MONTHS[bsMonth - 1]} {bsYear}
                </span>
                <button className="btn btn-ghost" style={{ padding: '4px 10px' }}
                  onClick={() => { if (bsMonth === 12) { setBsYear(y => y + 1); setBsMonth(1) } else setBsMonth(m => m + 1) }}>›</button>
                <button className="btn btn-ghost" style={{ fontSize: 11 }}
                  onClick={() => { setBsYear(today.year); setBsMonth(today.month) }}>This Month</button>
              </div>
            )}

            {/* Department filter */}
            {depts.length > 2 && (
              <select className="form-select" value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
                {depts.map(d => <option key={d}>{d}</option>)}
              </select>
            )}

            {/* Legend + Print */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginLeft: 'auto', alignItems: 'center' }}>
              {shiftTypes.filter(s => s.active !== false).map(s => {
                const hrs = s.hours ?? calcHours(s.start_time, s.end_time)
                return (
                  <span key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--theme-text2)' }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                    {s.name}{hrs != null ? ` ${hrs}h` : ''}
                  </span>
                )
              })}
              <button className="btn btn-ghost" style={{ fontSize: 12, marginLeft: 4 }}
                onClick={() => window.print()}>
                🖨 Print
              </button>
            </div>
          </div>

          {/* Board */}
          {loading ? (
            <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
          ) : filteredEmps.length === 0 ? (
            <div className="card">
              <div className="empty-state">
                <div className="empty-state-icon">👤</div>
                <p className="empty-state-text">No active employees found.</p>
              </div>
            </div>
          ) : (
            <div className="card roster-board" style={{ padding: 0 }}>
              <div className="table-wrap roster-wrap">
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                  <colgroup>
                    <col style={{ minWidth: 160 }} />
                    {columns.map((_, i) => (
                      <col key={i} style={{ minWidth: viewMode === 'weekly' ? 116 : 38 }} />
                    ))}
                    <col style={{ minWidth: 52 }} />
                  </colgroup>

                  <thead>
                    <tr style={{ borderBottom: '2px solid var(--theme-border)' }}>
                      <th className={STICKY_CLS} style={{ ...stickyCol, padding: '10px 14px', textAlign: 'left',
                        color: 'var(--theme-text2)', fontSize: 11, textTransform: 'uppercase',
                        letterSpacing: '0.05em', fontWeight: 600,
                        borderRight: '2px solid var(--theme-border)' }}>
                        Staff
                      </th>
                      {columns.map((col, i) => (
                        <th key={i} style={{
                          padding: viewMode === 'weekly' ? '8px 4px' : '6px 2px',
                          textAlign: 'center',
                          color:      col.isSat ? 'var(--theme-amber)' : 'var(--theme-text3)',
                          background: col.isSat ? 'rgba(245,158,11,0.06)' : 'inherit',
                          borderRight: '1px solid var(--theme-border-lt)',
                          fontWeight: 500,
                        }}>
                          <div style={{ fontSize: viewMode === 'weekly' ? 12 : 11, color: 'var(--theme-text2)' }}>{col.label}</div>
                          <div style={{ fontSize: 10, color: col.isSat ? 'var(--theme-amber)' : 'var(--theme-text3)' }}>{col.sublabel}</div>
                        </th>
                      ))}
                      <th style={{ padding: '8px 8px', textAlign: 'right', color: 'var(--theme-text3)', fontSize: 11, fontWeight: 500 }}>
                        Hrs
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {filteredEmps.map(emp => (
                      <tr key={emp.id} style={{ borderBottom: '1px solid var(--theme-border-lt)' }}>
                        <td className={STICKY_CLS} style={{ ...stickyCol, padding: '8px 14px', borderRight: '2px solid var(--theme-border)' }}>
                          <div style={{ fontWeight: 600, color: 'var(--theme-text1)', whiteSpace: 'nowrap', fontSize: 13 }}>
                            {emp.full_name}
                          </div>
                          {emp.department && (
                            <div style={{ fontSize: 10, color: 'var(--theme-text3)' }}>{emp.department}</div>
                          )}
                        </td>

                        {columns.map((col, ci) => {
                          const key   = rKey(col.bsYear, col.bsMonth, col.bsDay, emp.id)
                          const entry = roster[key]
                          const shift = entry ? shiftMap[entry.shift_type_id] : null
                          const hrs   = shift ? (shift.hours ?? calcHours(shift.start_time, shift.end_time)) : null
                          const isAct = activeCell?.empId === emp.id &&
                                        activeCell?.year  === col.bsYear &&
                                        activeCell?.month === col.bsMonth &&
                                        activeCell?.day   === col.bsDay

                          return (
                            <td key={ci} style={{
                              padding: 3,
                              background: col.isSat ? 'rgba(245,158,11,0.04)' : 'inherit',
                              borderRight: '1px solid var(--theme-border-lt)',
                            }}>
                              <button
                                className={`roster-cell${shift ? ' filled' : ''}`}
                                title={shift
                                  ? `${shift.name}${hrs != null ? ` · ${hrs}h` : ''}${shift.start_time ? ` · ${fmtTime(shift.start_time)}–${fmtTime(shift.end_time)}` : ''}`
                                  : 'Assign shift'}
                                onClick={e => {
                                  if (isAct) { setActiveCell(null); return }
                                  anchorRef.current = e.currentTarget
                                  setActiveCell({ year: col.bsYear, month: col.bsMonth, day: col.bsDay, empId: emp.id })
                                }}
                                style={{
                                  width: '100%',
                                  minHeight: viewMode === 'weekly' ? 56 : 30,
                                  background: shift ? shift.color + '22' : 'transparent',
                                  border:     shift ? `1px solid ${shift.color}55` : '1px dashed var(--theme-border)',
                                  borderRadius: 6, cursor: 'pointer',
                                  padding: viewMode === 'weekly' ? '6px 6px' : '2px',
                                  display: 'flex', flexDirection: 'column',
                                  alignItems: 'center', justifyContent: 'center', gap: 1,
                                  outline: isAct ? '2px solid var(--theme-accent)' : 'none',
                                  outlineOffset: -1,
                                }}
                              >
                                {shift ? (
                                  <>
                                    <span style={{ fontSize: viewMode === 'weekly' ? 11 : 9, fontWeight: 700, color: shift.color, lineHeight: 1.2 }}>
                                      {viewMode === 'weekly' ? shift.name : shift.name.slice(0, 2).toUpperCase()}
                                    </span>
                                    {viewMode === 'weekly' && shift.start_time && (
                                      <span style={{ fontSize: 9, color: 'var(--theme-text3)', lineHeight: 1 }}>
                                        {fmtTime(shift.start_time)}–{fmtTime(shift.end_time)}
                                      </span>
                                    )}
                                    {hrs != null && (
                                      <span style={{ fontSize: 9, color: 'var(--theme-text3)', lineHeight: 1 }}>{hrs}h</span>
                                    )}
                                  </>
                                ) : (
                                  <span style={{ fontSize: 16, color: 'var(--theme-border)', lineHeight: 1 }}>+</span>
                                )}
                              </button>
                            </td>
                          )
                        })}

                        <td style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 600, fontSize: 12, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>
                          {(() => { const h = empHrs(emp.id); return h > 0 ? `${h}h` : '—' })()}
                        </td>
                      </tr>
                    ))}
                  </tbody>

                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--theme-border)', background: 'var(--theme-bg)' }}>
                      <td className={STICKY_CLS} style={{ ...stickyCol, background: 'var(--theme-bg)', padding: '8px 14px',
                        fontSize: 11, color: 'var(--theme-text3)', fontWeight: 600,
                        borderRight: '2px solid var(--theme-border)' }}>
                        Total hrs/day
                      </td>
                      {columns.map((col, i) => {
                        const h = dayHrs(col)
                        return (
                          <td key={i} style={{
                            textAlign: 'center', padding: '8px 2px', fontSize: 11,
                            color:      h > 0 ? 'var(--theme-text2)' : 'var(--theme-border)',
                            fontWeight: h > 0 ? 600 : 400,
                            borderRight: '1px solid var(--theme-border-lt)',
                          }}>
                            {h > 0 ? `${h}h` : '—'}
                          </td>
                        )
                      })}
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {/* Shift picker dropdown */}
          {activeCell && (
            <ShiftPicker
              shifts={shiftTypes}
              anchorRef={anchorRef}
              onSelect={shiftId => assignShift(activeCell.year, activeCell.month, activeCell.day, activeCell.empId, shiftId)}
              onClose={() => setActiveCell(null)}
            />
          )}
        </>
      )}
    </div>
  )
}
