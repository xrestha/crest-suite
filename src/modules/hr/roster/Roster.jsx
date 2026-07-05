import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../../../supabaseClient'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { adToBs, bsToAd, daysInBsMonth, getBsToday, BS_MONTHS } from '../../../utils/bsCalendar'
import Tip from '../../../components/Tip'
import { printWithTitle } from '../../../utils/printTitle'
import {
  calcHours, rKey, computeEmpHours, computeDayHours,
  computePlannedLaborCost, computeRecommendedHeadcount,
} from './laborForecast'
import { fmtTime } from './rosterHelpers'
import ShiftPicker from './ShiftPicker'
import SuggestPopover from './SuggestPopover'
import ShiftSettingsPanel from './ShiftSettingsPanel'

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

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`

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

const stickyCol = {
  position: 'sticky',
  left: 0,
  zIndex: 1,
  background: 'var(--theme-card)',
}
const STICKY_CLS = 'roster-sticky'

// ── Main Roster ───────────────────────────────────────────────────────────────

export default function Roster() {
  const { clientId } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpsert, scopedDelete } = useScopedDb()
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

  // Letterhead info for the print header + labor-scheduling target — fetched once per client
  const [bizInfo, setBizInfo] = useState({ name: '', address: '' })
  const [coversPerStaffTarget, setCoversPerStaffTarget] = useState(20)
  useEffect(() => {
    if (!clientId) return
    Promise.all([
      supabase.from('clients').select('name').eq('id', clientId).single(),
      supabase.from('settings').select('property_address, covers_per_staff_target').eq('client_id', clientId).maybeSingle(),
    ]).then(([{ data: client }, { data: settings }]) => {
      setBizInfo({ name: client?.name || '', address: settings?.property_address || '' })
      setCoversPerStaffTarget(settings?.covers_per_staff_target ?? 20)
    })
  }, [clientId])

  async function saveCoversPerStaffTarget(raw) {
    const n = Math.max(1, parseInt(raw) || 20)
    setCoversPerStaffTarget(n)
    if (!clientId) return
    await supabase.from('settings').update({ covers_per_staff_target: n }).eq('client_id', clientId)
  }

  // Demand-forecast overlay: day-level covers/revenue forecast (recipe_id IS NULL rows in
  // demand_forecast_daily, from src/utils/demandForecastData.js's runForecast). Best-effort — a
  // client who's never run Demand Forecast just sees an empty overlay, not an error.
  const [forecastByDay, setForecastByDay] = useState({}) // { 'y:m:d': { covers, revenue, generated_at } }
  const loadForecast = useCallback(async () => {
    if (!clientId) return
    let all = []
    if (viewMode === 'weekly') {
      const months = new Map()
      weekDays(weekStart).forEach(d => {
        const bs = adToBs(d)
        const k = `${bs.year}:${bs.month}`
        if (!months.has(k)) months.set(k, bs)
      })
      for (const bs of months.values()) {
        const { data } = await scopedFrom('demand_forecast_daily', 'bs_year, bs_month, bs_day, forecast_covers, forecast_revenue, generated_at')
          .is('recipe_id', null).eq('bs_year', bs.year).eq('bs_month', bs.month)
        all.push(...(data || []))
      }
    } else {
      const { data } = await scopedFrom('demand_forecast_daily', 'bs_year, bs_month, bs_day, forecast_covers, forecast_revenue, generated_at')
        .is('recipe_id', null).eq('bs_year', bsYear).eq('bs_month', bsMonth)
      all = data || []
    }
    const map = {}
    for (const r of all) {
      const key = `${r.bs_year}:${r.bs_month}:${r.bs_day}`
      // A day can have both a 7-day and 30-day forecast row — prefer whichever was generated most recently.
      if (!map[key] || new Date(r.generated_at) > new Date(map[key].generated_at)) {
        map[key] = { covers: r.forecast_covers, revenue: r.forecast_revenue, generated_at: r.generated_at }
      }
    }
    setForecastByDay(map)
  }, [clientId, viewMode, weekStart, bsYear, bsMonth, scopedFrom])

  useEffect(() => { loadForecast() }, [loadForecast])

  // Drag-to-select: mousedown starts a selection anchor, mouseenter while dragging extends
  // it, global mouseup finalizes and opens the shift picker for every cell in the rectangle —
  // so assigning the same shift across a week (e.g. a multi-day Leave block) is one action
  // instead of one click per day. A plain click is just a 1x1 selection, so this one path
  // covers both single-cell and multi-cell assignment.
  const [selection,  setSelection]  = useState(null) // {chunkIdx, anchorR, anchorC, curR, curC}
  const [pickerOpen, setPickerOpen] = useState(false)
  const isDraggingRef = useRef(false)
  const dragInfoRef   = useRef(null) // {chunkIdx, closingSameCell}
  const anchorRef     = useRef(null)

  // "Suggest who to schedule" — opened from the ✨ button on a short-staffed day's column header
  const [suggestCol, setSuggestCol] = useState(null) // the day column currently being suggested for
  const suggestAnchorRef = useRef(null)
  function openSuggest(e, col) {
    e.stopPropagation()
    suggestAnchorRef.current = e.currentTarget
    setSuggestCol(col)
  }

  useEffect(() => {
    function onUp() {
      if (!isDraggingRef.current) return
      isDraggingRef.current = false
      if (dragInfoRef.current?.closingSameCell) {
        setSelection(null)
        setPickerOpen(false)
      } else {
        setPickerOpen(true)
      }
      dragInfoRef.current = null
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [])

  // ── Load shift types + employees (once per clientId) ───────────────────────
  useEffect(() => {
    if (!clientId) return
    async function init() {
      const [{ data: st }, { data: emps }] = await Promise.all([
        scopedFrom('hr_shift_types').order('sort_order'),
        scopedFrom('hr_employees', 'id, full_name, employee_code, department, status, pay_basis, basic_salary')
          .in('status', ['active', 'probation'])
          .order('full_name'),
      ])
      let shifts = st || []

      // Deduplicate by name — React Strict Mode double-invokes effects in dev,
      // which can cause two concurrent seed inserts before either sees rows.
      // Keep earliest sort_order per name; delete the extras from DB.
      const byName = {}
      const toDelete = []
      for (const s of shifts) {
        if (byName[s.name]) {
          toDelete.push(s.id)
        } else {
          byName[s.name] = s
        }
      }
      if (toDelete.length > 0) {
        await scopedDelete('hr_shift_types').in('id', toDelete)
        shifts = Object.values(byName).sort((a, b) => (a.sort_order ?? 99) - (b.sort_order ?? 99))
      }

      if (shifts.length === 0) {
        const { data: seeded } = await scopedInsert('hr_shift_types', DEFAULT_SHIFTS)
        shifts = seeded || []
      }
      setShiftTypes(shifts)
      setEmployees(emps || [])
    }
    init()
  }, [clientId, scopedFrom, scopedDelete, scopedInsert])

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
        const { data } = await scopedFrom('hr_roster')
          .eq('bs_year', bs.year).eq('bs_month', bs.month)
        all.push(...(data || []))
      }
    } else {
      const { data } = await scopedFrom('hr_roster')
        .eq('bs_year', bsYear).eq('bs_month', bsMonth)
      all = data || []
    }

    const map = {}
    all.forEach(r => { map[rKey(r.bs_year, r.bs_month, r.bs_day, r.employee_id)] = r })
    setRoster(map)
    setLoading(false)
  }, [clientId, viewMode, weekStart, bsYear, bsMonth, scopedFrom])

  useEffect(() => { loadRoster() }, [loadRoster])

  // ── Assign or clear a shift across every cell in the current selection ────
  // A plain click is just a 1-cell selection, so this single path covers both.
  async function assignShiftBulk(cells, shiftTypeId) {
    if (!clientId || cells.length === 0) return
    const existingRows = cells
      .map(c => roster[rKey(c.year, c.month, c.day, c.empId)])
      .filter(Boolean)

    // Optimistic update
    setRoster(prev => {
      const next = { ...prev }
      for (const c of cells) {
        const key = rKey(c.year, c.month, c.day, c.empId)
        if (shiftTypeId === null) {
          delete next[key]
        } else {
          next[key] = { ...(next[key] || {}), shift_type_id: shiftTypeId, bs_year: c.year, bs_month: c.month, bs_day: c.day, employee_id: c.empId }
        }
      }
      return next
    })
    setSelection(null)
    setPickerOpen(false)

    if (shiftTypeId === null) {
      const ids = existingRows.map(r => r.id).filter(Boolean)
      if (ids.length > 0) await scopedDelete('hr_roster').in('id', ids)
    } else {
      const rows = cells.map(c => ({
        employee_id: c.empId,
        shift_type_id: shiftTypeId,
        bs_year: c.year, bs_month: c.month, bs_day: c.day,
      }))
      const { data } = await scopedUpsert('hr_roster', rows, { onConflict: 'client_id,employee_id,bs_year,bs_month,bs_day' })
      if (data) {
        setRoster(prev => {
          const next = { ...prev }
          for (const row of data) next[rKey(row.bs_year, row.bs_month, row.bs_day, row.employee_id)] = row
          return next
        })
      }
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

  const colChunks = viewMode === 'monthly'
    ? [columns.slice(0, 16), columns.slice(16)]
    : [columns]

  const shiftMap     = Object.fromEntries(shiftTypes.map(s => [s.id, s]))
  const depts        = ['All', ...Array.from(new Set(employees.map(e => e.department).filter(Boolean))).sort()]
  const filteredEmps = deptFilter === 'All' ? employees : employees.filter(e => e.department === deptFilter)

  function empHrs(empId) {
    return computeEmpHours(columns, roster, shiftMap, empId)
  }

  function dayHrs(col) {
    return computeDayHours(col, filteredEmps, roster, shiftMap)
  }

  function dayLaborCost(col) {
    return computePlannedLaborCost(col, filteredEmps, roster, shiftMap, daysInBsMonth(col.bsYear, col.bsMonth))
  }

  // Ranked "who should cover this day" candidates for SuggestPopover — pulled from filteredEmps
  // (whatever the board's current Department filter shows), excluding anyone already scheduled
  // that day, ranked by fewest hours scheduled this period first.
  function candidatesFor(col) {
    return filteredEmps
      .filter(emp => !roster[rKey(col.bsYear, col.bsMonth, col.bsDay, emp.id)])
      .map(emp => ({ ...emp, hrsThisPeriod: empHrs(emp.id) }))
      .sort((a, b) => a.hrsThisPeriod - b.hrsThisPeriod)
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

  // Per-day labor-forecast rows for the Labor Forecast tab — one row per visible column,
  // combining scheduled hours/cost (from the roster) with the demand forecast (if any).
  const laborForecastRows = columns.map(col => {
    const f = forecastByDay[`${col.bsYear}:${col.bsMonth}:${col.bsDay}`]
    const scheduledHrs   = dayHrs(col)
    const plannedCost    = dayLaborCost(col)
    const scheduledCount = filteredEmps.filter(emp => roster[rKey(col.bsYear, col.bsMonth, col.bsDay, emp.id)]).length
    const recommended    = computeRecommendedHeadcount(f?.covers, coversPerStaffTarget)
    const costPct        = f?.revenue > 0 ? (plannedCost / f.revenue) * 100 : null
    return { col, scheduledHrs, plannedCost, scheduledCount, recommended, costPct, forecastRevenue: f?.revenue ?? null, forecastCovers: f?.covers ?? null }
  })
  const forecastRowByKey = Object.fromEntries(laborForecastRows.map(r => [`${r.col.bsYear}:${r.col.bsMonth}:${r.col.bsDay}`, r]))

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="roster-print-page">
      <style>{`
        @media print {
          @page { size: A4 landscape; margin: 12mm 10mm; }
          /* Some browsers' print dialogs let the user override @page margins with "None" —
             bake real padding into the content itself so there's always visible whitespace
             around the edge regardless of that setting. */
          .roster-print-page { padding: 8mm 10mm !important; }
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
          /* Layout.css hides all <button> elements on print (.btn, button { display: none }) —
             roster cells are buttons on screen for click/drag, so they need display restored here. */
          .roster-cell   { display: flex !important; border: 1px solid #ccc !important; }
          .roster-cell.filled { background: #e8e8e8 !important; border-color: #888 !important; }
        }
      `}</style>

      <div className="page-header no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Staff Roster</h1>
          <p className="page-subtitle">Plan weekly and monthly shift schedules for all staff</p>
        </div>
      </div>

      {/* Top tab bar */}
      <div className="tab-bar no-print" style={{ marginBottom: 20 }}>
        <button className={`tab-btn${tab === 'board'  ? ' tab-btn--active' : ''}`} onClick={() => setTab('board')}>Roster Board</button>
        <button className={`tab-btn${tab === 'shifts' ? ' tab-btn--active' : ''}`} onClick={() => setTab('shifts')}>Shift Types</button>
        <button className={`tab-btn${tab === 'labor'  ? ' tab-btn--active' : ''}`} onClick={() => setTab('labor')}>Labor Forecast</button>
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
            {bizInfo.name && <div style={{ fontWeight: 700, fontSize: 15 }}>{bizInfo.name}</div>}
            {bizInfo.address && <div style={{ fontSize: 11 }}>{bizInfo.address}</div>}
            <div style={{ fontWeight: 700, fontSize: 16, marginTop: bizInfo.name ? 6 : 0 }}>Staff Roster — {periodLabel}</div>
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
                onClick={() => printWithTitle(`${bizInfo.name ? bizInfo.name + ' - ' : ''}Staff Roster - ${periodLabel}`)}>
                🖨 Print
              </button>
            </div>
          </div>

          <p className="no-print" style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '0 0 10px' }}>
            Tip: click and drag across cells to assign the same shift to multiple days at once.
          </p>

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
            <>
              {colChunks.map((cols, chunkIdx) => {
                const isLast = chunkIdx === colChunks.length - 1
                return (
                  <div key={chunkIdx} className="card roster-board"
                    style={{ padding: 0, marginBottom: !isLast ? 12 : 0, userSelect: selection ? 'none' : 'auto' }}>
                    <div className="table-wrap roster-wrap">
                      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                        <colgroup>
                          <col style={{ minWidth: 160 }} />
                          {cols.map((_, i) => (
                            <col key={i} style={{ minWidth: viewMode === 'weekly' ? 116 : 38 }} />
                          ))}
                          {isLast && <col style={{ minWidth: 52 }} />}
                        </colgroup>

                        <thead>
                          <tr style={{ borderBottom: '2px solid var(--theme-border)' }}>
                            <th className={STICKY_CLS} style={{ ...stickyCol, padding: '10px 14px', textAlign: 'left',
                              color: 'var(--theme-text2)', fontSize: 11, textTransform: 'uppercase',
                              letterSpacing: '0.05em', fontWeight: 600,
                              borderRight: '2px solid var(--theme-border)' }}>
                              Staff
                            </th>
                            {cols.map((col, i) => {
                              const fr = forecastRowByKey[`${col.bsYear}:${col.bsMonth}:${col.bsDay}`]
                              const short = fr?.recommended != null && fr.scheduledCount < fr.recommended
                              return (
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
                                {fr?.recommended != null && (
                                  <div className="no-print" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, marginTop: 2 }}>
                                    <Tip text={`Recommended ${fr.recommended} staff (~${Math.round(fr.forecastCovers)} forecasted covers ÷ ${coversPerStaffTarget}/staff). Scheduled: ${fr.scheduledCount}. See the Labor Forecast tab for the full breakdown.`} width={240}>
                                      <span style={{ fontSize: 9, fontWeight: short ? 700 : 500, color: short ? 'var(--theme-amber)' : 'var(--theme-text3)', cursor: 'default' }}>
                                        Rec: {fr.recommended}
                                      </span>
                                    </Tip>
                                    {short && (
                                      <button onClick={e => openSuggest(e, col)} title="Suggest who to schedule"
                                        style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 11, padding: 0, lineHeight: 1 }}>
                                        ✨
                                      </button>
                                    )}
                                  </div>
                                )}
                              </th>
                              )
                            })}
                            {isLast && (
                              <th style={{ padding: '8px 8px', textAlign: 'right', color: 'var(--theme-text3)', fontSize: 11, fontWeight: 500 }}>
                                Hrs
                              </th>
                            )}
                          </tr>
                        </thead>

                        <tbody>
                          {filteredEmps.map((emp, ri) => (
                            <tr key={emp.id} style={{ borderBottom: '1px solid var(--theme-border-lt)' }}>
                              <td className={STICKY_CLS} style={{ ...stickyCol, padding: '8px 14px', borderRight: '2px solid var(--theme-border)' }}>
                                <div style={{ fontWeight: 600, color: 'var(--theme-text1)', whiteSpace: 'nowrap', fontSize: 13 }}>
                                  {emp.full_name}
                                </div>
                                {emp.department && (
                                  <div style={{ fontSize: 10, color: 'var(--theme-text3)' }}>{emp.department}</div>
                                )}
                              </td>

                              {cols.map((col, ci) => {
                                const key   = rKey(col.bsYear, col.bsMonth, col.bsDay, emp.id)
                                const entry = roster[key]
                                const shift = entry ? shiftMap[entry.shift_type_id] : null
                                const hrs   = shift ? (shift.hours ?? calcHours(shift.start_time, shift.end_time)) : null
                                const inSel = selection?.chunkIdx === chunkIdx &&
                                              ri >= Math.min(selection.anchorR, selection.curR) && ri <= Math.max(selection.anchorR, selection.curR) &&
                                              ci >= Math.min(selection.anchorC, selection.curC) && ci <= Math.max(selection.anchorC, selection.curC)

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
                                        : 'Assign shift — click and drag across cells to assign multiple at once'}
                                      onMouseDown={e => {
                                        e.preventDefault()
                                        const closingSameCell = pickerOpen && selection &&
                                          selection.chunkIdx === chunkIdx &&
                                          selection.anchorR === ri && selection.anchorC === ci &&
                                          selection.curR === ri && selection.curC === ci
                                        isDraggingRef.current = true
                                        dragInfoRef.current = { chunkIdx, closingSameCell }
                                        anchorRef.current = e.currentTarget
                                        setSelection({ chunkIdx, anchorR: ri, anchorC: ci, curR: ri, curC: ci })
                                        setPickerOpen(false)
                                      }}
                                      onMouseEnter={e => {
                                        if (!isDraggingRef.current || dragInfoRef.current?.chunkIdx !== chunkIdx) return
                                        anchorRef.current = e.currentTarget
                                        setSelection(prev => prev ? { ...prev, curR: ri, curC: ci } : prev)
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
                                        outline: inSel ? '2px solid var(--theme-accent)' : 'none',
                                        outlineOffset: -1,
                                        userSelect: 'none',
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

                              {isLast && (
                                <td style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 600, fontSize: 12, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>
                                  {(() => { const h = empHrs(emp.id); return h > 0 ? `${h}h` : '—' })()}
                                </td>
                              )}
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
                            {cols.map((col, i) => {
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
                            {isLast && <td />}
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                )
              })}
            </>
          )}

          {/* Shift picker dropdown — applies to every cell in the current selection rectangle */}
          {pickerOpen && selection && (() => {
            const rMin = Math.min(selection.anchorR, selection.curR)
            const rMax = Math.max(selection.anchorR, selection.curR)
            const cMin = Math.min(selection.anchorC, selection.curC)
            const cMax = Math.max(selection.anchorC, selection.curC)
            const chunkCols = colChunks[selection.chunkIdx] || []
            const cells = []
            for (let r = rMin; r <= rMax; r++) {
              const emp = filteredEmps[r]
              if (!emp) continue
              for (let c = cMin; c <= cMax; c++) {
                const col = chunkCols[c]
                if (!col) continue
                cells.push({ year: col.bsYear, month: col.bsMonth, day: col.bsDay, empId: emp.id })
              }
            }
            return (
              <ShiftPicker
                shifts={shiftTypes}
                anchorRef={anchorRef}
                cellCount={cells.length}
                onSelect={shiftId => assignShiftBulk(cells, shiftId)}
                onClose={() => { setSelection(null); setPickerOpen(false) }}
              />
            )
          })()}

          {/* Suggest-who-to-schedule popover, opened from the ✨ button on a short-staffed day */}
          {suggestCol && (
            <SuggestPopover
              candidates={candidatesFor(suggestCol)}
              shiftTypes={shiftTypes}
              anchorRef={suggestAnchorRef}
              onAssign={(empId, shiftId) => {
                assignShiftBulk([{ year: suggestCol.bsYear, month: suggestCol.bsMonth, day: suggestCol.bsDay, empId }], shiftId)
                setSuggestCol(null)
              }}
              onClose={() => setSuggestCol(null)}
            />
          )}
        </>
      )}

      {/* ── Labor Forecast tab — kept separate from the Roster Board so this management-only
          data never bleeds into the printed schedule handed to staff ── */}
      {tab === 'labor' && (
        <div className="no-print">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 16 }}>
            <div className="tab-bar" style={{ marginBottom: 0 }}>
              <button className={`tab-btn${viewMode === 'weekly'  ? ' tab-btn--active' : ''}`} onClick={() => setViewMode('weekly')}>Weekly</button>
              <button className={`tab-btn${viewMode === 'monthly' ? ' tab-btn--active' : ''}`} onClick={() => setViewMode('monthly')}>Monthly</button>
            </div>

            {viewMode === 'weekly' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button className="btn btn-ghost" style={{ padding: '4px 10px' }}
                  onClick={() => { const d = new Date(weekStart); d.setDate(d.getDate() - 7); setWeekStart(d) }}>‹</button>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', minWidth: 210, textAlign: 'center' }}>{weekLabel}</span>
                <button className="btn btn-ghost" style={{ padding: '4px 10px' }}
                  onClick={() => { const d = new Date(weekStart); d.setDate(d.getDate() + 7); setWeekStart(d) }}>›</button>
                <button className="btn btn-ghost" style={{ fontSize: 11 }}
                  onClick={() => setWeekStart(weekSunday(new Date()))}>Today</button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button className="btn btn-ghost" style={{ padding: '4px 10px' }}
                  onClick={() => { if (bsMonth === 1) { setBsYear(y => y - 1); setBsMonth(12) } else setBsMonth(m => m - 1) }}>‹</button>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', minWidth: 150, textAlign: 'center' }}>{BS_MONTHS[bsMonth - 1]} {bsYear}</span>
                <button className="btn btn-ghost" style={{ padding: '4px 10px' }}
                  onClick={() => { if (bsMonth === 12) { setBsYear(y => y + 1); setBsMonth(1) } else setBsMonth(m => m + 1) }}>›</button>
                <button className="btn btn-ghost" style={{ fontSize: 11 }}
                  onClick={() => { setBsYear(today.year); setBsMonth(today.month) }}>This Month</button>
              </div>
            )}

            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Tip text="Target covers each staff member can comfortably serve — used to compute Recommended Staff below. Saved per client.">
                <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>Covers/Staff target</span>
              </Tip>
              <input type="number" min="1" step="1" defaultValue={coversPerStaffTarget}
                onBlur={e => saveCoversPerStaffTarget(e.target.value)}
                className="form-select" style={{ width: 56, padding: '3px 6px', fontSize: 12 }} />
            </div>
          </div>

          <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 14px' }}>
            Scheduled hours/cost come from the roster; Forecast Revenue/Covers come from Demand Forecast (run/update it on the Demand Forecast page) — a day with no forecast yet just shows "—".
          </p>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th style={{ textAlign: 'right' }}>Scheduled Hours</th>
                  <th style={{ textAlign: 'right' }}>Forecast Revenue</th>
                  <th style={{ textAlign: 'right' }}>Planned Labor Cost</th>
                  <th style={{ textAlign: 'right' }}>Cost %</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Ceil(forecasted covers ÷ Covers/Staff target)" width={200}>Recommended Staff</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>Scheduled Staff</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {laborForecastRows.map((r, i) => {
                  const weekday = WEEKDAYS[bsToAd(r.col.bsYear, r.col.bsMonth, r.col.bsDay).getDay()]
                  const short = r.recommended != null && r.scheduledCount < r.recommended
                  return (
                    <tr key={i}>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                        {weekday} {r.col.bsDay} {BS_MONTHS[r.col.bsMonth - 1].slice(0, 3)}
                      </td>
                      <td style={{ textAlign: 'right' }}>{r.scheduledHrs > 0 ? `${r.scheduledHrs}h` : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.forecastRevenue != null ? fmtNpr(r.forecastRevenue) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.plannedCost > 0 ? fmtNpr(r.plannedCost) : '—'}</td>
                      <td style={{ textAlign: 'right', color: r.costPct != null && r.costPct > 35 ? 'var(--theme-amber)' : 'inherit' }}>
                        {r.costPct != null ? `${r.costPct.toFixed(0)}%` : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }}>{r.recommended ?? '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.scheduledCount}</td>
                      <td>
                        {r.recommended == null ? '—' : short
                          ? <span className="badge-amber" style={{ fontSize: 10 }}>⚠ Short</span>
                          : <span className="badge-green" style={{ fontSize: 10 }}>✓ Covered</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
