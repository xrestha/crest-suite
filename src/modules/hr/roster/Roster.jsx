import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../../../supabaseClient'
import { useAuth } from '../../../context/AuthContext'
import { useTheme } from '../../../context/ThemeContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { adToBs, bsToAd, daysInBsMonth, getBsToday, BS_MONTHS, BS_MONTHS_SHORT, formatAd } from '../../../utils/bsCalendar'
import Tip from '../../../components/Tip'
import ConfirmModal from '../../../components/ConfirmModal'
import { printWithTitle } from '../../../utils/printTitle'
import {
  calcHours, rKey, computeEmpHours, computeDayHours,
  computePlannedLaborCost, computeRecommendedHeadcount,
} from './laborForecast'
import { fmtTime, shiftTextColor } from './rosterHelpers'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import ShiftPicker from './ShiftPicker'
import SuggestPopover from './SuggestPopover'
import ShiftSettingsPanel from './ShiftSettingsPanel'
import SwapRequestsPanel from './SwapRequestsPanel'

// ── Constants ──────────────────────────────────────────────────────────────────

// These hexes are a per-shift CATEGORICAL palette, not UI chrome — the same exemption chart series
// take (DESIGN.md): a shift's colour has to stay distinguishable from the six others beside it on
// the board, which five semantic tokens can't do, and the client can repaint any of them from Shift
// Types anyway. They are FILL values only; the chip's label text goes through shiftTextColor()
// (rosterHelpers.js) so a categorical hue never doubles as low-contrast type.
const DEFAULT_SHIFTS = [
  { name: 'Morning',   color: '#3B82F6', start_time: '07:00', end_time: '15:00', hours: 8,  sort_order: 1 },
  { name: 'Afternoon', color: '#F59E0B', start_time: '13:00', end_time: '21:00', hours: 8,  sort_order: 2 },
  { name: 'Evening',   color: '#8B5CF6', start_time: '17:00', end_time: '01:00', hours: 8,  sort_order: 3 },
  { name: 'Night',     color: '#64748B', start_time: '21:00', end_time: '07:00', hours: 8,  sort_order: 4 },
  { name: 'Full Day',  color: '#10B981', start_time: '09:00', end_time: '18:00', hours: 9,  sort_order: 5 },
  { name: 'Split',     color: '#EC4899', start_time: null,    end_time: null,    hours: null, sort_order: 6 },
  // Zero-hour, purely a visible marker — unlike "Clear (Unassign)" in the shift picker (which
  // deletes the roster row entirely), assigning this actually writes a row, so the day shows up
  // correctly on the board, in Attendance's Generate from Roster, and in the employee's own
  // Self-Service roster instead of silently disappearing.
  { name: 'Day Off',   color: '#6B7280', start_time: null,    end_time: null,    hours: 0, sort_order: 7 },
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

// Labels a week the way the toolbar does, spanning potentially 2 BS months. Lifted out of the
// component so the copy-week dialog can name the target week in the same words.
function weekLabelFor(start) {
  const days = weekDays(start)
  const s    = adToBs(days[0])
  const e    = adToBs(days[6])
  const sm   = BS_MONTHS[s.month - 1]
  const em   = BS_MONTHS[e.month - 1]
  if (s.month === e.month && s.year === e.year) return `${sm} ${s.day}–${e.day}, ${s.year}`
  return `${sm} ${s.day} – ${em} ${e.day}, ${s.year}`
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
  const { clientId, profile, hasHrAccess } = useAuth()
  const { colors } = useTheme()
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
      // One read per BS month the week spans — in parallel, not one after the other. A week
      // straddling a month boundary needs two, and awaiting them in sequence doubled the wait
      // for no reason: neither read's filter depends on the other's result.
      const results = await Promise.all([...months.values()].map(bs =>
        scopedFrom('demand_forecast_daily', 'bs_year, bs_month, bs_day, forecast_covers, forecast_revenue, generated_at, holiday_name, holiday_multiplier')
          .is('recipe_id', null).eq('bs_year', bs.year).eq('bs_month', bs.month)))
      for (const { data } of results) all.push(...(data || []))
    } else {
      const { data } = await scopedFrom('demand_forecast_daily', 'bs_year, bs_month, bs_day, forecast_covers, forecast_revenue, generated_at, holiday_name, holiday_multiplier')
        .is('recipe_id', null).eq('bs_year', bsYear).eq('bs_month', bsMonth)
      all = data || []
    }
    const map = {}
    for (const r of all) {
      const key = `${r.bs_year}:${r.bs_month}:${r.bs_day}`
      // A day can have both a 7-day and 30-day forecast row — prefer whichever was generated most recently.
      if (!map[key] || new Date(r.generated_at) > new Date(map[key].generated_at)) {
        map[key] = {
          covers: r.forecast_covers, revenue: r.forecast_revenue, generated_at: r.generated_at,
          holiday: r.holiday_name ? { name: r.holiday_name, multiplier: r.holiday_multiplier } : null,
        }
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

  // Touch path for the same multi-cell assignment (added S570). Drag-select is mouse-only by
  // construction: a finger produces no mouseenter over the cells it passes across, and the obvious
  // touchmove/elementFromPoint version has to preventDefault to stop the page scrolling — which
  // would kill horizontal scrolling of a 32-column board on the exact devices this is for. So
  // instead of touching the drag logic at all, "Select range" is an explicit mode: tap the first
  // cell, tap the last, the picker opens for the rectangle between them. mousedown bails out while
  // it's on, so the two paths can never both be live, and it works for keyboard and mouse too.
  const [rangeMode,   setRangeMode]   = useState(false)
  const [rangeAnchor, setRangeAnchor] = useState(null) // {chunkIdx, r, c} — first tap

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
        const { data: seeded, error: seedErr } = await scopedInsert('hr_shift_types', DEFAULT_SHIFTS)
        // A dropped WRITE error is silent data loss, not a silent zero (S613): a failed seed left
        // the board with no shift types and nothing painted, with no explanation anywhere.
        if (seedErr) { console.error('shift-type seed failed:', seedErr); window.alert('Could not set up the default shift types: ' + seedErr.message) }
        shifts = seeded || []
      }
      setShiftTypes(shifts)
      setEmployees(emps || [])
    }
    init()
  }, [clientId, scopedFrom, scopedDelete, scopedInsert])

  // One BS month of roster rows, PAGED. `hr_roster` is one row per employee per rostered day —
  // the same cardinality as `hr_attendance`, which AttendanceSheet.jsx pages for exactly this
  // reason — so a fully-rostered 30-day month crosses PostgREST's 1000-row cap at ~33 staff. Over
  // it the read returns the first 1000 rows with no error and nothing in the data to say so, and
  // the board then paints real shifts as empty cells. `.order('id')` is the unique tiebreaker
  // fetchAllRows requires; without one, paging repeats a row on one page and skips it on the next.
  const monthRosterRows = useCallback((year, month, cols) =>
    fetchAllRows(() => scopedFrom('hr_roster', cols)
      .eq('bs_year', year).eq('bs_month', month)
      .order('id')), [scopedFrom])

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
      const results = await Promise.all([...months.values()].map(bs => monthRosterRows(bs.year, bs.month)))
      for (const { data } of results) all.push(...(data || []))
    } else {
      const { data } = await monthRosterRows(bsYear, bsMonth)
      all = data || []
    }

    const map = {}
    all.forEach(r => { map[rKey(r.bs_year, r.bs_month, r.bs_day, r.employee_id)] = r })
    setRoster(map)
    setLoading(false)
  }, [clientId, viewMode, weekStart, bsYear, bsMonth, monthRosterRows])

  useEffect(() => { loadRoster() }, [loadRoster])

  // ── Publish state — day-grain (one row per published day, not per published month) ─────────
  // Self-service employees never see a draft roster; get_my_roster only returns rows for days
  // that have a matching hr_roster_publish_state row (see the migration). Loaded for the
  // currently-visible range using the same "group visible days by unique year:month" pattern as
  // loadForecast, since a week can span two BS months.
  const [publishedDays, setPublishedDays] = useState(new Set()) // Set of `${year}:${month}:${day}`
  const [publishing,    setPublishing]    = useState(false)

  const loadPublishedDays = useCallback(async () => {
    if (!clientId) return
    let all = []
    if (viewMode === 'weekly') {
      const months = new Map()
      weekDays(weekStart).forEach(d => {
        const bs = adToBs(d)
        const k = `${bs.year}:${bs.month}`
        if (!months.has(k)) months.set(k, bs)
      })
      const results = await Promise.all([...months.values()].map(bs =>
        scopedFrom('hr_roster_publish_state', 'bs_year, bs_month, bs_day')
          .eq('bs_year', bs.year).eq('bs_month', bs.month)))
      for (const { data } of results) all.push(...(data || []))
    } else {
      const { data } = await scopedFrom('hr_roster_publish_state', 'bs_year, bs_month, bs_day')
        .eq('bs_year', bsYear).eq('bs_month', bsMonth)
      all = data || []
    }
    setPublishedDays(new Set(all.map(r => `${r.bs_year}:${r.bs_month}:${r.bs_day}`)))
  }, [clientId, viewMode, weekStart, bsYear, bsMonth, scopedFrom])
  useEffect(() => { loadPublishedDays() }, [loadPublishedDays])

  // Publishes every day in `dayGroups` (usually one group, two if a visible week straddles a BS
  // month boundary) and notifies affected staff once per group — only employees scheduled on
  // those specific days, not the whole month's.
  async function publishDays(dayGroups) {
    if (!clientId || publishing) return
    setPublishing(true)
    for (const g of dayGroups) {
      const rows = g.bsDays.map(d => ({
        bs_year: g.bsYear, bs_month: g.bsMonth, bs_day: d,
        published_at: new Date().toISOString(), published_by: profile?.id,
      }))
      const { error } = await scopedUpsert('hr_roster_publish_state', rows, { onConflict: 'client_id,bs_year,bs_month,bs_day' })
      if (!error) {
        supabase.functions.invoke('hr-push', {
          body: { action: 'notify_roster_published', client_id: clientId, bs_year: g.bsYear, bs_month: g.bsMonth, bs_days: g.bsDays },
        })
      }
    }
    await loadPublishedDays()
    setPublishing(false)
  }

  function publishMonth() {
    publishDays([{ bsYear, bsMonth, bsDays: Array.from({ length: daysInBsMonth(bsYear, bsMonth) }, (_, i) => i + 1) }])
  }

  function publishWeek() {
    const groups = new Map() // `${year}:${month}` -> { bsYear, bsMonth, bsDays: [] }
    weekDays(weekStart).forEach(d => {
      const bs = adToBs(d)
      const k = `${bs.year}:${bs.month}`
      if (!groups.has(k)) groups.set(k, { bsYear: bs.year, bsMonth: bs.month, bsDays: [] })
      groups.get(k).bsDays.push(bs.day)
    })
    publishDays(Array.from(groups.values()))
  }

  const monthTotalDays = daysInBsMonth(bsYear, bsMonth)
  const monthPublishedCount = Array.from({ length: monthTotalDays }, (_, i) => i + 1)
    .filter(d => publishedDays.has(`${bsYear}:${bsMonth}:${d}`)).length
  const weekPublishedCount = weekDays(weekStart)
    .filter(d => { const bs = adToBs(d); return publishedDays.has(`${bs.year}:${bs.month}:${bs.day}`) }).length

  // ── Leave-conflict detection ────────────────────────────────────────────────────────────────
  // Approved leave requests for the client, fetched once (small table) — same "fetch all, filter
  // in JS" precedent as LeaveManagement.jsx. Used to flag/block scheduling an employee on a day
  // they already have approved leave for.
  const [approvedLeaveByEmp, setApprovedLeaveByEmp] = useState({}) // { employeeId: [{start:Date, end:Date}] }
  useEffect(() => {
    if (!clientId) return
    scopedFrom('hr_leave_requests', 'employee_id, start_date, end_date').eq('status', 'approved')
      .then(({ data }) => {
        const map = {}
        for (const r of data || []) {
          if (!map[r.employee_id]) map[r.employee_id] = []
          // Keep as YYYY-MM-DD strings (already what Postgres returns for a `date` column) and
          // compare lexicographically below — new Date("YYYY-MM-DD") parses as UTC midnight,
          // which in Nepal (UTC+5:45) is later than local midnight, so a Date-object comparison
          // silently missed single-day leave and the first day of every multi-day leave.
          map[r.employee_id].push({ start: r.start_date, end: r.end_date })
        }
        setApprovedLeaveByEmp(map)
      })
  }, [clientId, scopedFrom])

  function isOnApprovedLeave(empId, col) {
    const ranges = approvedLeaveByEmp[empId]
    if (!ranges || ranges.length === 0) return false
    const d = adDateFor(col)
    return ranges.some(r => d >= r.start && d <= r.end)
  }

  // ── Assign or clear a shift across every cell in the current selection ────
  // A plain click is just a 1-cell selection, so this single path covers both.
  async function assignShiftBulk(cells, shiftTypeId) {
    if (!clientId || cells.length === 0) return

    // Leave-conflict auto-block (with override): assigning a shift, not clearing one, onto a day
    // an employee already has approved leave for gets a confirm rather than silently succeeding.
    if (shiftTypeId !== null) {
      const conflicts = cells.filter(c => isOnApprovedLeave(c.empId, { bsYear: c.year, bsMonth: c.month, bsDay: c.day }))
      if (conflicts.length > 0) {
        const names = [...new Set(conflicts.map(c => employees.find(e => e.id === c.empId)?.full_name).filter(Boolean))]
        const proceed = window.confirm(
          `${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} approved leave on the selected day(s) — assign the shift anyway?`
        )
        if (!proceed) return
      }
    }

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
    setRangeAnchor(null)

    if (shiftTypeId === null) {
      const ids = existingRows.map(r => r.id).filter(Boolean)
      if (ids.length > 0) {
        const { error: clearErr } = await scopedDelete('hr_roster').in('id', ids)
        if (clearErr) {
          console.error('roster clear failed:', clearErr)
          window.alert('Could not clear that shift: ' + clearErr.message)
          loadRoster()
          return
        }
      }
    } else {
      const rows = cells.map(c => ({
        employee_id: c.empId,
        shift_type_id: shiftTypeId,
        bs_year: c.year, bs_month: c.month, bs_day: c.day,
      }))
      const { data, error: paintErr } = await scopedUpsert('hr_roster', rows, { onConflict: 'client_id,employee_id,bs_year,bs_month,bs_day' })
      // The paint above is optimistic — on a dropped error the board showed the shift as saved
      // while nothing was written (S613, the silent-data-loss class). Say so and reload the truth.
      if (paintErr) {
        console.error('roster paint failed:', paintErr)
        window.alert('Could not save that roster change: ' + paintErr.message)
        loadRoster()
        return
      }
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
  //
  // Everything from here to `forecastRowByKey` is memoized, and the reason is the drag-select:
  // `onMouseEnter` calls `setSelection` on every cell the pointer crosses, so dragging across a
  // 32-column row is 32 full re-renders of this component. Unmemoized, each one rebuilt the
  // columns (a bsToAd per day), re-ran shiftTextColor's contrast search (up to 100 HSL→RGB
  // iterations per shift type), and recomputed the whole labor-forecast strip — 32 columns x
  // three passes over every employee. Measured at 40 staff x 32 days: 1.94 ms per render of
  // derivations alone, 62 ms across one drag, before React reconciles a single cell.
  //
  // The CELLS are deliberately left unmemoized. React.memo on a roster cell needs ref-wrapped
  // handlers, and these sit on the optimistic-write path (assignShiftBulk paints state, then
  // writes) — a stale closure there saves a wrong shift rather than merely rendering an old
  // number. Same call as Stock Count's saveRow and PosOrders: take the derived lists, leave the
  // row alone.
  const columns = useMemo(() => {
    if (viewMode === 'weekly') {
      return weekDays(weekStart).map(d => {
        const bs = adToBs(d)
        return {
          bsYear: bs.year, bsMonth: bs.month, bsDay: bs.day,
          label:    WEEKDAYS[d.getDay()],
          sublabel: `${bs.day} ${BS_MONTHS_SHORT[bs.month - 1]}`,
        }
      })
    }
    const out = []
    const total = daysInBsMonth(bsYear, bsMonth)
    for (let d = 1; d <= total; d++) {
      const adDate = bsToAd(bsYear, bsMonth, d)
      out.push({
        bsYear, bsMonth, bsDay: d,
        label:    d,
        sublabel: WEEKDAYS[adDate.getDay()].slice(0, 2),
      })
    }
    return out
  }, [viewMode, weekStart, bsYear, bsMonth])

  const colChunks = useMemo(() => viewMode === 'monthly'
    ? [columns.slice(0, 16), columns.slice(16)]
    : [columns], [viewMode, columns])

  // The board calls this once per CELL — employees x columns, so ~1,280 calls at 40 staff on a
  // monthly view, each doing its own BS→AD conversion and string format. The conversion depends
  // only on the column, so it is done once per column here; `adDateFor` falls back to computing
  // for a column outside the visible set, which is what openCopyWeek passes (next week's days).
  const colAdByKey = useMemo(() => {
    const m = {}
    for (const c of columns) m[`${c.bsYear}:${c.bsMonth}:${c.bsDay}`] = formatAd(bsToAd(c.bsYear, c.bsMonth, c.bsDay))
    return m
  }, [columns])
  function adDateFor(col) {
    return colAdByKey[`${col.bsYear}:${col.bsMonth}:${col.bsDay}`]
      ?? formatAd(bsToAd(col.bsYear, col.bsMonth, col.bsDay))
  }

  const shiftMap = useMemo(() => Object.fromEntries(shiftTypes.map(s => [s.id, s])), [shiftTypes])
  // Chip LABEL colours, derived from each shift's fill colour and the current card surface (the
  // chip is that fill at 0x22 alpha over the card). See rosterHelpers.js — the fill stays the
  // categorical hue, only the type is corrected for contrast. Keyed on the shift types and the
  // theme, which is all it actually depends on; it had been re-searching for a passing contrast
  // ratio on every render, including every step of a drag.
  const shiftTextById = useMemo(() => Object.fromEntries(
    shiftTypes.map(s => [s.id, shiftTextColor(s.color, colors.card, 0x22 / 255)])
  ), [shiftTypes, colors.card])
  const depts = useMemo(
    () => ['All', ...Array.from(new Set(employees.map(e => e.department).filter(Boolean))).sort()],
    [employees])
  const filteredEmps = useMemo(
    () => deptFilter === 'All' ? employees : employees.filter(e => e.department === deptFilter),
    [employees, deptFilter])

  // Hours per employee across the visible columns, built in ONE pass instead of a
  // columns-length scan per row. The board reads it once per employee row, and candidatesFor()
  // read it again per candidate — an O(employees x columns) walk repeated per employee.
  const empHrsById = useMemo(() => {
    const m = {}
    for (const emp of employees) m[emp.id] = computeEmpHours(columns, roster, shiftMap, emp.id)
    return m
  }, [employees, columns, roster, shiftMap])
  const empHrs = empId => empHrsById[empId] ?? 0

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
  const weekLabel = weekLabelFor(weekStart)

  const periodLabel = viewMode === 'weekly'
    ? weekLabel
    : `${BS_MONTHS[bsMonth - 1]} ${bsYear}`

  // ── Copy this week onto next week ─────────────────────────────────────────────────────────
  // Most weeks repeat — the same people on the same shifts, with two or three edits — and
  // rebuilding that cell by cell is the most repetitive thing on this page. This stamps the whole
  // visible week onto the next one, same weekday to same weekday, and then lands you on it so
  // the edits happen on a real board rather than on trust.
  //
  // It MIRRORS rather than merges: a cell that is empty this week is cleared next week, because
  // "copy the week" means the two weeks look identical, and a merge quietly leaves shifts standing
  // that nobody put there deliberately. Everything it will overwrite or clear is counted in the
  // confirm dialog before a single row is written.
  //
  // The target week's existing rows are read from the DB, never from `roster`: that state holds
  // only the BS months the VISIBLE week spans, and +7 days routinely lands in the next BS month
  // (they run 28–32 days), so a local lookup would report an empty target week and overwrite a
  // real one silently.
  const [copyPlan,  setCopyPlan]  = useState(null)
  const [copyBusy,  setCopyBusy]  = useState(false)
  const [copyError, setCopyError] = useState('')

  const weekShiftCount = useMemo(() => viewMode === 'weekly'
    ? columns.reduce((n, col) => n + filteredEmps.filter(e => roster[rKey(col.bsYear, col.bsMonth, col.bsDay, e.id)]).length, 0)
    : 0, [viewMode, columns, filteredEmps, roster])

  async function openCopyWeek() {
    if (!clientId || copyBusy) return
    setCopyBusy(true)
    setCopyError('')
    try {
      const pairs = weekDays(weekStart).map(d => {
        const t = new Date(d)
        t.setDate(t.getDate() + 7)
        return { from: adToBs(d), to: adToBs(t) }
      })

      const writes = []
      const targetKeys = new Set()
      for (const emp of filteredEmps) {
        for (const p of pairs) {
          targetKeys.add(rKey(p.to.year, p.to.month, p.to.day, emp.id))
          const row = roster[rKey(p.from.year, p.from.month, p.from.day, emp.id)]
          if (row?.shift_type_id) writes.push({ empId: emp.id, to: p.to, shiftTypeId: row.shift_type_id })
        }
      }

      // What's already on the target week — rows and publish state — one read per BS month it spans.
      const months = new Map()
      pairs.forEach(p => { const k = `${p.to.year}:${p.to.month}`; if (!months.has(k)) months.set(k, p.to) })
      const existingId = new Map()   // target cell key -> hr_roster.id
      const publishedTargetDays = new Set()
      // Both months' reads run together rather than month-then-month; neither filters on the other.
      const monthReads = await Promise.all([...months.values()].map(bs => Promise.all([
        monthRosterRows(bs.year, bs.month, 'id, employee_id, bs_year, bs_month, bs_day'),
        scopedFrom('hr_roster_publish_state', 'bs_year, bs_month, bs_day')
          .eq('bs_year', bs.year).eq('bs_month', bs.month),
      ])))
      for (const [rows, pub] of monthReads) {
        // A failed read here would understate what the copy is about to destroy, so it stops the
        // whole thing rather than opening a dialog full of confident zeros. A TRUNCATED read did
        // the same damage silently until the roster read above was paged — truncation returns no
        // error, so the dialog under-counted the shifts the mirror was about to overwrite and clear.
        if (rows.error) throw rows.error
        if (pub.error)  throw pub.error
        for (const r of rows.data || []) {
          const k = rKey(r.bs_year, r.bs_month, r.bs_day, r.employee_id)
          if (targetKeys.has(k)) existingId.set(k, r.id)
        }
        for (const r of pub.data || []) publishedTargetDays.add(`${r.bs_year}:${r.bs_month}:${r.bs_day}`)
      }

      const writeKeys = new Set(writes.map(w => rKey(w.to.year, w.to.month, w.to.day, w.empId)))
      const overwrite = writes.filter(w => existingId.has(rKey(w.to.year, w.to.month, w.to.day, w.empId))).length
      const clearIds  = [...existingId.entries()].filter(([k]) => !writeKeys.has(k)).map(([, id]) => id)

      const conflicts = [...new Set(
        writes
          .filter(w => isOnApprovedLeave(w.empId, { bsYear: w.to.year, bsMonth: w.to.month, bsDay: w.to.day }))
          .map(w => employees.find(e => e.id === w.empId)?.full_name)
          .filter(Boolean)
      )]

      const targetStart = new Date(weekStart)
      targetStart.setDate(targetStart.getDate() + 7)

      setCopyPlan({
        writes, clearIds, overwrite, conflicts,
        publishedCount: pairs.filter(p => publishedTargetDays.has(`${p.to.year}:${p.to.month}:${p.to.day}`)).length,
        targetLabel: weekLabelFor(targetStart),
      })
    } catch (e) {
      setCopyError(e?.message || 'Could not read next week — nothing was copied.')
    } finally {
      setCopyBusy(false)
    }
  }

  async function runCopyWeek() {
    if (!copyPlan || copyBusy) return
    setCopyBusy(true)
    setCopyError('')
    try {
      // Write first, clear second. If the second half fails, next week carries the copied shifts
      // plus a few leftovers — visible on the board and fixable — rather than a week that was
      // emptied for a copy that never arrived.
      if (copyPlan.writes.length > 0) {
        const rows = copyPlan.writes.map(w => ({
          employee_id: w.empId,
          shift_type_id: w.shiftTypeId,
          bs_year: w.to.year, bs_month: w.to.month, bs_day: w.to.day,
        }))
        const { error } = await scopedUpsert('hr_roster', rows, { onConflict: 'client_id,employee_id,bs_year,bs_month,bs_day' })
        if (error) throw error
      }
      if (copyPlan.clearIds.length > 0) {
        const { error } = await scopedDelete('hr_roster').in('id', copyPlan.clearIds)
        if (error) throw error
      }
      setCopyPlan(null)
      // Land on the week that was just written — the copy is then something the manager reads off
      // the board, not something the dialog claims happened.
      const d = new Date(weekStart)
      d.setDate(d.getDate() + 7)
      setWeekStart(d)
    } catch (e) {
      setCopyError(e?.message || 'The copy did not finish — check next week before running it again.')
    } finally {
      setCopyBusy(false)
    }
  }

  // Per-day labor-forecast rows for the Labor Forecast tab — one row per visible column,
  // combining scheduled hours/cost (from the roster) with the demand forecast (if any).
  // Three passes over every employee, per column — the single most expensive thing on the page,
  // and it was recomputed on every drag step even though a drag changes none of its inputs.
  const laborForecastRows = useMemo(() => columns.map(col => {
    const f = forecastByDay[`${col.bsYear}:${col.bsMonth}:${col.bsDay}`]
    const scheduledHrs   = computeDayHours(col, filteredEmps, roster, shiftMap)
    const plannedCost    = computePlannedLaborCost(col, filteredEmps, roster, shiftMap, daysInBsMonth(col.bsYear, col.bsMonth))
    const scheduledCount = filteredEmps.filter(emp => roster[rKey(col.bsYear, col.bsMonth, col.bsDay, emp.id)]).length
    const recommended    = computeRecommendedHeadcount(f?.covers, coversPerStaffTarget)
    const costPct        = f?.revenue > 0 ? (plannedCost / f.revenue) * 100 : null
    return { col, scheduledHrs, plannedCost, scheduledCount, recommended, costPct, forecastRevenue: f?.revenue ?? null, forecastCovers: f?.covers ?? null, holiday: f?.holiday ?? null }
  }), [columns, forecastByDay, filteredEmps, roster, shiftMap, coversPerStaffTarget])
  const forecastRowByKey = useMemo(
    () => Object.fromEntries(laborForecastRows.map(r => [`${r.col.bsYear}:${r.col.bsMonth}:${r.col.bsDay}`, r])),
    [laborForecastRows])

  if (!hasHrAccess('supervisor')) return <Navigate to="/dashboard" replace />

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
        <ShiftSettingsPanel
          clientId={clientId} shiftTypes={shiftTypes} setShiftTypes={setShiftTypes}
        />
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
          <div className="no-print" style={{ display: 'flex', gap: 20, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>

            {/* View mode + date navigation — one temporal-control cluster, kept tight since
                picking a mode and stepping through it are the same action-in-progress. */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <div className="tab-bar">
                <button className={`tab-btn${viewMode === 'weekly'  ? ' tab-btn--active' : ''}`} onClick={() => setViewMode('weekly')}>Weekly</button>
                <button className={`tab-btn${viewMode === 'monthly' ? ' tab-btn--active' : ''}`} onClick={() => setViewMode('monthly')}>Monthly</button>
              </div>

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
            </div>

            {/* Department filter */}
            {depts.length > 2 && (
              <select id="roster-dept-filter" aria-label="Filter roster by department"
                className="form-select" value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
                {depts.map(d => <option key={d}>{d}</option>)}
              </select>
            )}

            {/* Copy the visible week onto the next one. Weekly only — "next month" is not a
                fixed-length copy the way "next week" is (BS months run 28–32 days), so the same
                button on the monthly view would have to answer a different question. */}
            {viewMode === 'weekly' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Tip width={280} style={{ borderBottom: 'none', cursor: 'pointer' }} text="Stamps every shift on this week onto the same weekday next week, so next week ends up matching this one exactly. You see what would be overwritten before anything is written.">
                  <button className="btn btn-ghost" style={{ fontSize: 12 }}
                    disabled={copyBusy || weekShiftCount === 0}
                    onClick={openCopyWeek}>
                    {copyBusy && !copyPlan ? 'Checking…' : '⧉ Copy to Next Week'}
                  </button>
                </Tip>
                {copyError && !copyPlan && (
                  <span style={{ fontSize: 11, color: 'var(--theme-red-text)' }}>{copyError}</span>
                )}
              </div>
            )}

            {/* Publish — day-grain, so a manager can publish a week at a time instead of having
                to finish the whole month first. Self-service employees never see a draft day
                until it's been published. */}
            {(() => {
              const publishedCount = viewMode === 'weekly' ? weekPublishedCount : monthPublishedCount
              const totalCount     = viewMode === 'weekly' ? 7 : monthTotalDays
              const allPublished   = publishedCount === totalCount
              const nonePublished  = publishedCount === 0
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {nonePublished ? (
                    <span className="badge-gray" style={{ fontSize: 10 }}>Draft</span>
                  ) : allPublished ? (
                    <Tip text="Every visible day has been published. Further edits aren't auto-notified — use Re-Publish to push an update.">
                      <span className="badge-green" style={{ fontSize: 10 }}>✓ Published</span>
                    </Tip>
                  ) : (
                    <Tip text={`${publishedCount} of ${totalCount} visible days have been published so far.`}>
                      <span className="badge-amber" style={{ fontSize: 10 }}>◐ {publishedCount}/{totalCount} Published</span>
                    </Tip>
                  )}
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={publishing}
                    onClick={viewMode === 'weekly' ? publishWeek : publishMonth}>
                    {publishing ? 'Publishing…' : nonePublished ? `Publish ${viewMode === 'weekly' ? 'Week' : 'Month'} + Notify` : 'Re-Publish + Notify'}
                  </button>
                </div>
              )
            })()}

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

          <SwapRequestsPanel employees={employees} shiftMap={shiftMap} />

          <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '0 0 10px' }}>
            <button
              className={`btn${rangeMode ? ' btn-primary' : ' btn-ghost'}`}
              style={{ fontSize: 11 }}
              aria-pressed={rangeMode}
              onClick={() => {
                setRangeMode(m => !m)
                setRangeAnchor(null); setSelection(null); setPickerOpen(false)
              }}
            >
              {rangeMode ? '✓ Select range: on' : '⬚ Select range'}
            </button>
            <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: 0 }}>
              {rangeMode
                ? (rangeAnchor
                    ? 'Now tap the last cell of the block — the shift you pick applies to everything between.'
                    : 'Tap the first cell of the block, then the last one. Works on touch and keyboard as well as mouse.')
                : 'Tip: click and drag across cells to assign the same shift to multiple days at once — or use Select range on a tablet.'}
            </p>
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
                                color:      'var(--theme-text3)',
                                borderRight: '1px solid var(--theme-border-lt)',
                                fontWeight: 500,
                              }}>
                                <div style={{ fontSize: viewMode === 'weekly' ? 12 : 11, color: 'var(--theme-text2)' }}>{col.label}</div>
                                <div style={{ fontSize: 10, color: 'var(--theme-text3)' }}>{col.sublabel}</div>
                                {fr?.recommended != null && (
                                  <div className="no-print" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, marginTop: 2 }}>
                                    <Tip text={`Recommended ${fr.recommended} staff (~${Math.round(fr.forecastCovers)} forecasted covers ÷ ${coversPerStaffTarget}/staff). Scheduled: ${fr.scheduledCount}. See the Labor Forecast tab for the full breakdown.`} width={240}>
                                      <span style={{ fontSize: 9, fontWeight: short ? 700 : 500, color: short ? 'var(--theme-amber-text)' : 'var(--theme-text3)', cursor: 'default' }}>
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
                                const onLeave = isOnApprovedLeave(emp.id, col)

                                return (
                                  <td key={ci} style={{
                                    padding: 3,
                                    borderRight: '1px solid var(--theme-border-lt)',
                                  }}>
                                    <button
                                      className={`roster-cell${shift ? ' filled' : ''}`}
                                      title={onLeave
                                        ? `⚠ On approved leave${shift ? ` — but still scheduled for ${shift.name}` : ''}`
                                        : shift
                                          ? `${shift.name}${hrs != null ? ` · ${hrs}h` : ''}${shift.start_time ? ` · ${fmtTime(shift.start_time)}–${fmtTime(shift.end_time)}` : ''}`
                                          : 'Assign shift — click and drag across cells to assign multiple at once'}
                                      onMouseDown={e => {
                                        e.preventDefault()
                                        if (rangeMode) return   // tap-to-tap mode owns the click instead
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
                                      onClick={e => {
                                        // Range mode is checked FIRST — it's the touch/keyboard path, and a tap
                                        // arrives as a click with detail >= 1, so it has to run before the
                                        // keyboard-only guard below.
                                        if (rangeMode) {
                                          anchorRef.current = e.currentTarget
                                          if (!rangeAnchor || rangeAnchor.chunkIdx !== chunkIdx) {
                                            setRangeAnchor({ chunkIdx, r: ri, c: ci })
                                            setSelection({ chunkIdx, anchorR: ri, anchorC: ci, curR: ri, curC: ci })
                                            setPickerOpen(false)
                                          } else {
                                            setSelection({ chunkIdx, anchorR: rangeAnchor.r, anchorC: rangeAnchor.c, curR: ri, curC: ci })
                                            setRangeAnchor(null)
                                            setPickerOpen(true)
                                          }
                                          return
                                        }
                                        // e.detail is 0 for a keyboard-triggered click (Enter/Space) and >=1 for a
                                        // real mouse click — mouse clicks are already handled by the mousedown +
                                        // global mouseup drag-select pair above, so only act here for keyboard.
                                        if (e.detail !== 0) return
                                        const alreadyOpenSameCell = pickerOpen && selection &&
                                          selection.chunkIdx === chunkIdx &&
                                          selection.anchorR === ri && selection.anchorC === ci &&
                                          selection.curR === ri && selection.curC === ci
                                        if (alreadyOpenSameCell) {
                                          setSelection(null)
                                          setPickerOpen(false)
                                        } else {
                                          anchorRef.current = e.currentTarget
                                          setSelection({ chunkIdx, anchorR: ri, anchorC: ci, curR: ri, curC: ci })
                                          setPickerOpen(true)
                                        }
                                      }}
                                      style={{
                                        width: '100%',
                                        minHeight: viewMode === 'weekly' ? 56 : 30,
                                        background: onLeave
                                          ? 'repeating-linear-gradient(45deg, rgba(248,113,113,0.18), rgba(248,113,113,0.18) 4px, rgba(248,113,113,0.06) 4px, rgba(248,113,113,0.06) 8px)'
                                          : shift ? shift.color + '22' : 'transparent',
                                        border:     onLeave ? '1px solid rgba(248,113,113,0.55)' : shift ? `1px solid ${shift.color}55` : '1px dashed var(--theme-border)',
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
                                          <span style={{ fontSize: viewMode === 'weekly' ? 11 : 9, fontWeight: 700, color: shiftTextById[shift.id] || shift.color, lineHeight: 1.2 }}>
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
                                        // The one affordance telling a manager an empty cell is clickable.
                                        // Was --theme-border, which measured 1.27:1 on the Dark preset
                                        // (rgb(42,47,61) on rgb(24,28,39)) — it read as an empty box.
                                        <span aria-hidden="true" style={{ fontSize: 16, color: 'var(--theme-text3)', lineHeight: 1 }}>+</span>
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
                              const h = forecastRowByKey[`${col.bsYear}:${col.bsMonth}:${col.bsDay}`]?.scheduledHrs ?? 0
                              return (
                                <td key={i} style={{
                                  textAlign: 'center', padding: '8px 2px', fontSize: 11,
                                  color:      h > 0 ? 'var(--theme-text2)' : 'var(--theme-text3)',
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
                onClose={() => { setSelection(null); setPickerOpen(false); setRangeAnchor(null) }}
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

          {/* Copy-week confirmation. The body is a count of what will actually change, not an
              "are you sure?" — this writes across a week the manager isn't looking at. */}
          {copyPlan && (
            <ConfirmModal
              title={`Copy this week onto ${copyPlan.targetLabel}?`}
              confirmLabel="Copy week"
              busyLabel="Copying…"
              busy={copyBusy}
              danger={copyPlan.overwrite + copyPlan.clearIds.length > 0}
              onCancel={() => { setCopyPlan(null); setCopyError('') }}
              onConfirm={runCopyWeek}
            >
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li>
                  <strong>{copyPlan.writes.length}</strong> shift{copyPlan.writes.length === 1 ? '' : 's'} copied
                  onto {copyPlan.targetLabel}, each on the same weekday
                  {deptFilter !== 'All' ? ` — ${deptFilter} only, because that filter is on` : ''}.
                </li>
                {copyPlan.overwrite > 0 && (
                  <li>
                    <strong>{copyPlan.overwrite}</strong> shift{copyPlan.overwrite === 1 ? '' : 's'} already
                    scheduled next week {copyPlan.overwrite === 1 ? 'is' : 'are'} replaced.
                  </li>
                )}
                {copyPlan.clearIds.length > 0 && (
                  <li>
                    <strong>{copyPlan.clearIds.length}</strong> shift{copyPlan.clearIds.length === 1 ? '' : 's'} next
                    week sit{copyPlan.clearIds.length === 1 ? 's' : ''} on a cell that is empty this week, so
                    {copyPlan.clearIds.length === 1 ? ' it is' : ' they are'} cleared and the two weeks match.
                  </li>
                )}
                {copyPlan.conflicts.length > 0 && (
                  <li style={{ color: 'var(--theme-amber-text)' }}>
                    {copyPlan.conflicts.join(', ')} {copyPlan.conflicts.length === 1 ? 'has' : 'have'} approved
                    leave next week — those days are still filled, so check them afterwards.
                  </li>
                )}
                {copyPlan.publishedCount > 0 && (
                  <li style={{ color: 'var(--theme-amber-text)' }}>
                    {copyPlan.publishedCount} of next week's days {copyPlan.publishedCount === 1 ? 'is' : 'are'} already
                    published — staff have seen the old version, so press Re-Publish + Notify once you're done editing.
                  </li>
                )}
              </ul>
              {copyError && (
                <p style={{ marginTop: 12, marginBottom: 0, color: 'var(--theme-red-text)' }}>{copyError}</p>
              )}
            </ConfirmModal>
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
              <label htmlFor="roster-covers-target" style={{ fontSize: 11, color: 'var(--theme-text3)' }}>
                <Tip text="Target covers each staff member can comfortably serve — used to compute Recommended Staff below. Saved per client.">
                  Covers/Staff target
                </Tip>
              </label>
              <input id="roster-covers-target" type="number" min="1" step="1" defaultValue={coversPerStaffTarget}
                onBlur={e => saveCoversPerStaffTarget(e.target.value)}
                className="form-input" style={{ width: 56, padding: '3px 6px', fontSize: 12 }} />
            </div>
          </div>

          <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 14px' }}>
            Scheduled hours/cost come from the roster; Forecast Revenue/Covers come from Demand Forecast (run/update it on the Demand Forecast page) — a day with no forecast yet just shows "—". A festival/holiday badge next to a date means that day's forecast was adjusted by the multiplier set for it in Holiday Calendar — an unadjusted badge (no "×N") means the holiday is known but no multiplier has been set yet.
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
                        {weekday} {r.col.bsDay} {BS_MONTHS_SHORT[r.col.bsMonth - 1]}
                        {r.holiday && (
                          r.holiday.multiplier != null
                            ? <Tip text={`Forecast Revenue/Covers on this row are adjusted ×${r.holiday.multiplier} for ${r.holiday.name} (set in Holiday Calendar).`} width={260}>
                                <span className="badge-amber" style={{ fontSize: 9, marginLeft: 6 }}>{r.holiday.name} ×{r.holiday.multiplier}</span>
                              </Tip>
                            : <Tip text={`${r.holiday.name} — no demand multiplier set in Holiday Calendar, so Forecast Revenue/Covers on this row are NOT adjusted for it.`} width={260}>
                                <span className="badge-amber" style={{ fontSize: 9, marginLeft: 6 }}>{r.holiday.name}</span>
                              </Tip>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>{r.scheduledHrs > 0 ? `${r.scheduledHrs}h` : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.forecastRevenue != null ? fmtNpr(r.forecastRevenue) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.plannedCost > 0 ? fmtNpr(r.plannedCost) : '—'}</td>
                      <td style={{ textAlign: 'right', color: r.costPct != null && r.costPct > 35 ? 'var(--theme-amber-text)' : 'inherit' }}>
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
