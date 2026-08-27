import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import { BS_MONTHS, adToBs, adToBsSafe, formatAd, getBsToday, formatBsDay, bsDayOrdinal } from '../../../utils/bsCalendar'
import { workingDaysInRange, DAY_TYPES } from '../leave/leaveConstants'
import { CATEGORIES, VEHICLE_TYPES, DEFAULT_PURPOSE_OPTIONS, DEFAULT_START_POINTS, OTHER_PURPOSE, PURCHASE_PURPOSE, EMPTY_TADA_ITEM, recomputeTadaAmount } from '../tada/tadaShared'
import SearchableSelect from '../../../components/SearchableSelect'
import Modal from '../../../components/Modal'
import PayslipBody from '../payroll/PayslipBody'
import SelfServiceShell, { TABS } from './SelfServiceShell'
import SelfServiceToday from './SelfServiceToday'
import RosterWeek from './RosterWeek'
import { todayView, nextShift, pendingSwapsForMe } from './todayView'
import { employeeErrorText } from './employeeError'
import { useStaffAppManifest } from './useStaffApp'
import { rememberedStaffClient } from './staffClient'
import './selfService.css'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function startOfWeek(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  x.setDate(x.getDate() - x.getDay())
  return x
}
function addDays(d, n) {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

// One AD calendar day per cell, each independently converted to its own BS date — a week straddles
// two BS months often enough that a single conversion for the whole week would be wrong (BS months
// run 28–32 days and never align to a 7-day week).
function cellsFrom(start, count) {
  return Array.from({ length: count }, (_, i) => {
    const ad = addDays(start, i)
    const bs = adToBs(ad)
    return { ad, bsYear: bs.year, bsMonth: bs.month, bsDay: bs.day, weekday: WEEKDAYS[ad.getDay()] }
  })
}

const fmt = n => Math.round(n || 0).toLocaleString('en-NP')

// A stored date goes through adToBsSafe, not adToBs: outside the verified BS table adToBs does not
// throw, it returns a confident wrong date, and a leave request is exactly the kind of arbitrary
// stored date that can fall outside it. Out of range renders the truthful AD value instead.
// A bare 'YYYY-MM-DD' is parsed as UTC by `new Date`, which lands on the previous day in Nepal —
// hence the explicit local midnight.
function bsParts(iso) {
  if (!iso) return null
  return adToBsSafe(new Date(iso.includes('T') ? iso : iso + 'T00:00:00'))
}
const fmtBs = iso => {
  const bs = bsParts(iso)
  return bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : (iso ? `${iso.slice(0, 10)} (AD)` : '—')
}
// Leave and TADA both print a range, and both used to print raw AD ISO strings in an app whose
// every other date is Bikram Sambat.
function fmtBsRange(a, b) {
  const A = bsParts(a), B = bsParts(b)
  if (!A || !B) return `${fmtBs(a)} → ${fmtBs(b)}`
  if (A.year === B.year && A.month === B.month) return `${A.day}–${B.day} ${BS_MONTHS[A.month - 1]} ${A.year}`
  if (A.year === B.year) return `${A.day} ${BS_MONTHS[A.month - 1]} – ${B.day} ${BS_MONTHS[B.month - 1]} ${A.year}`
  return `${fmtBs(a)} – ${fmtBs(b)}`
}

// 16px, not 13: below it iOS Safari zooms the viewport on focus and never zooms back. An inline
// fontSize beats the .self-service rule in selfService.css, so it has to be restated here.
const inp = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-md)',
  padding: '11px 12px', fontSize: 16, color: 'var(--theme-text1)', outline: 'none', width: '100%', fontFamily: 'inherit',
}
const STATUS_BADGE = { pending: 'badge-amber', approved: 'badge-green', rejected: 'badge-red', cancelled: 'badge-gray' }
const TADA_STATUS_BADGE = { pending: 'badge-amber', approved: 'badge-yellow', rejected: 'badge-red', paid: 'badge-green' }
const SWAP_STATUS_BADGE = {
  pending_target: 'badge-amber', pending_admin: 'badge-amber', approved: 'badge-green',
  rejected_by_target: 'badge-red', rejected_by_admin: 'badge-red', cancelled: 'badge-gray',
}

function emptyTadaForm() {
  const today = formatAd(new Date())
  return { trip_purpose: '', destination: '', start_point: '', start_date: today, end_date: today, notes: '', items: [EMPTY_TADA_ITEM()] }
}

// "Sat 6 Bhadra · 22 Aug" — or "Sat 6 Bha" where the column is 76px wide. The BS date is the one
// an employee's roster is planned in; the AD date is the one their phone's calendar shows, and a
// roster row that reads only "Day 6" makes them work out which is which.
// No range guard is needed here the way adToBsSafe exists for stored dates: these cells were built
// FROM real AD dates a few days either side of today, so the conversion is inside the verified
// table by construction.
function labelFor(cell, mode) {
  const month = BS_MONTHS[cell.bsMonth - 1] || ''
  if (mode === 'short') return `${cell.weekday} ${cell.bsDay} ${month.slice(0, 3)}`
  const ad = cell.ad.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return `${cell.weekday} ${cell.bsDay} ${month} · ${ad}`
}

// Employee-facing app — own payslip / leave / TADA / roster only, through narrow RPCs scoped to
// the caller's own hr_employee_id (migration 20260707260000). No Layout/ModuleGate chrome: it is a
// standalone surface, the same reasoning as PosLogin.jsx → /pos, for a different restricted
// account. Since S598 it wears its own app shell and installs as "Crest Staff".
//
// This component is the container: it owns every fetch and the tab switch. The shell owns the
// chrome, and each screen is a pure component that receives what it renders.
export default function SelfServiceHome() {
  const { session, profile, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  useStaffAppManifest()

  // The tab lives in the URL so the phone's own Back gesture moves between destinations instead
  // of leaving the app — the single thing that most makes an installed PWA feel like a web page.
  const [searchParams, setSearchParams] = useSearchParams()
  const urlTab = searchParams.get('tab')
  const tab = TABS.some(t => t.key === urlTab) ? urlTab : 'home'
  const setTab = key => setSearchParams(key === 'home' ? {} : { tab: key })

  const today = useMemo(() => getBsToday(), [])
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()))

  const [payslips, setPayslips] = useState(null)
  const [viewSlip, setViewSlip] = useState(null)
  const [bizInfo, setBizInfo] = useState({ name: '', address: '', vatNumber: '' })
  // One message per area, not one shared string: a failed payslip read must not blank the roster
  // that loaded fine, and "could not load" must never be rendered as "you have none".
  const [errs, setErrs] = useState({})
  const setErrFor = (key, value) => setErrs(prev => ({ ...prev, [key]: value }))

  const [leaveTypes, setLeaveTypes] = useState([])
  const [leaveRequests, setLeaveRequests] = useState(null)
  const [roster, setRoster] = useState(new Map())          // Map<"year-month-day", row>
  const [rosterLoaded, setRosterLoaded] = useState(false)
  const [publishMap, setPublishMap] = useState(new Map())  // Map<"year-month", boolean>

  const [requestTab, setRequestTab] = useState('leave')
  const [done, setDone] = useState('')

  const [leaveOpen, setLeaveOpen] = useState(false)
  const [leaveTypeId, setLeaveTypeId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [reason, setReason] = useState('')
  const [dayType, setDayType] = useState('full')
  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState('')

  const [tadaOpen, setTadaOpen] = useState(false)
  const [tadaClaims, setTadaClaims] = useState(null)
  const [tadaVendors, setTadaVendors] = useState([])
  const [tadaForm, setTadaForm] = useState(emptyTadaForm)
  const [tadaPurposeMode, setTadaPurposeMode] = useState('preset')       // 'preset' | 'custom'
  const [tadaStartPointMode, setTadaStartPointMode] = useState('preset') // 'preset' | 'custom'
  const [tadaPurposeOptions, setTadaPurposeOptions] = useState(DEFAULT_PURPOSE_OPTIONS)
  const [tadaStartPoints, setTadaStartPoints] = useState(DEFAULT_START_POINTS)
  const [tadaVehicleRates, setTadaVehicleRates] = useState({ '2w': null, '4w': null, ev: null })
  const [tadaSubmitting, setTadaSubmitting] = useState(false)
  const [tadaMsg, setTadaMsg] = useState('')

  const [swapRequests, setSwapRequests] = useState(null)
  const [swapDay, setSwapDay] = useState(null)
  const [coworkerRoster, setCoworkerRoster] = useState([])
  const [coworkerLoading, setCoworkerLoading] = useState(false)
  const [swapTargetEmpId, setSwapTargetEmpId] = useState('')
  const [swapTargetDay, setSwapTargetDay] = useState('')
  const [swapNote, setSwapNote] = useState('')
  const [swapSubmitting, setSwapSubmitting] = useState(false)
  const [swapMsg, setSwapMsg] = useState('')

  useEffect(() => {
    if (!authLoading && (!session || !profile?.hr_self_service)) {
      // Back to the PIN pad for the company this phone was set up with, not the admin sign-in
      // page — this is where an installed Crest Staff icon lands once a session has expired.
      const known = rememberedStaffClient()
      navigate(known ? `/hr/self-service/login/${known}` : '/login', { replace: true })
    }
  }, [authLoading, session, profile, navigate])

  // settings isn't excluded from self-service RLS (only the HR personal-data tables are), so this
  // reads it directly rather than needing a dedicated RPC.
  useEffect(() => {
    if (!profile?.client_id) return
    supabase.from('settings').select('tada_vehicle_rates, tada_purpose_options, tada_start_points, property_address, vat_number').eq('client_id', profile.client_id).maybeSingle()
      .then(({ data }) => {
        setTadaVehicleRates({ '2w': null, '4w': null, ev: null, ...(data?.tada_vehicle_rates || {}) })
        setTadaPurposeOptions(data?.tada_purpose_options?.length ? data.tada_purpose_options : DEFAULT_PURPOSE_OPTIONS)
        setTadaStartPoints(data?.tada_start_points?.length ? data.tada_start_points : DEFAULT_START_POINTS)
        // Letterhead for the employee's own payslip — same source the owner's copy uses.
        setBizInfo({
          name: profile.clients?.name || '',
          address: data?.property_address || '',
          vatNumber: data?.vat_number || '',
        })
      })
  }, [profile?.client_id, profile?.clients?.name])

  // ── The days we hold roster for ────────────────────────────────────────────────────────────
  // The Roster tab shows the selected week; Home additionally needs the NEXT one, so "next shift"
  // can still answer on a Saturday instead of going quiet at the week boundary. Both read the same
  // maps, so this is at most one extra get_my_roster pair, never a second source of truth.
  const weekDays = useMemo(() => cellsFrom(weekStart, 7), [weekStart])
  const homeDays = useMemo(() => cellsFrom(startOfWeek(new Date()), 14), [])

  const monthsNeeded = useMemo(() => {
    const map = new Map()
    ;[...weekDays, ...homeDays].forEach(d => map.set(`${d.bsYear}-${d.bsMonth}`, { year: d.bsYear, month: d.bsMonth }))
    return [...map.values()]
  }, [weekDays, homeDays])

  const weekRangeLabel = useMemo(() => {
    const first = weekDays[0], last = weekDays[6]
    if (first.bsYear === last.bsYear && first.bsMonth === last.bsMonth) {
      return `${BS_MONTHS[first.bsMonth - 1]} ${first.bsDay}–${last.bsDay}, ${first.bsYear}`
    }
    // A week crossing a BS month is the common case, so this string has to stay on one line at
    // 390px — the year is stated once, and the month names are unambiguously BS.
    if (first.bsYear === last.bsYear) {
      return `${BS_MONTHS[first.bsMonth - 1]} ${first.bsDay} – ${BS_MONTHS[last.bsMonth - 1]} ${last.bsDay}, ${first.bsYear}`
    }
    return `${BS_MONTHS[first.bsMonth - 1]} ${first.bsDay}, ${first.bsYear} – ${BS_MONTHS[last.bsMonth - 1]} ${last.bsDay}, ${last.bsYear}`
  }, [weekDays])

  // ── Loaders ────────────────────────────────────────────────────────────────────────────────
  const loadPayslips = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_my_hr_payslips')
    setErrFor('payslips', error ? employeeErrorText(error) : '')
    if (!error) setPayslips(data || [])
  }, [])

  const loadLeave = useCallback(async () => {
    const [{ data: types, error: tErr }, { data: reqs, error: rErr }] = await Promise.all([
      supabase.rpc('get_my_leave_types'),
      supabase.rpc('get_my_leave_requests'),
    ])
    const error = tErr || rErr
    setErrFor('leave', error ? employeeErrorText(error) : '')
    if (error) return
    setLeaveTypes(types || [])
    setLeaveRequests(reqs || [])
    if (!leaveTypeId && types?.length > 0) setLeaveTypeId(types[0].id)
  }, [leaveTypeId])

  const loadRoster = useCallback(async () => {
    const results = await Promise.all(monthsNeeded.map(async ({ year, month }) => {
      const [{ data, error }, { data: published }] = await Promise.all([
        supabase.rpc('get_my_roster', { p_bs_year: year, p_bs_month: month }),
        supabase.rpc('get_my_roster_publish_status', { p_bs_year: year, p_bs_month: month }),
      ])
      return { year, month, rows: data || [], error, published: !!published }
    }))
    const failed = results.find(r => r.error)
    setErrFor('roster', failed ? employeeErrorText(failed.error) : '')
    if (failed) return
    const rowMap = new Map()
    const pubMap = new Map()
    results.forEach(r => {
      pubMap.set(`${r.year}-${r.month}`, r.published)
      r.rows.forEach(row => rowMap.set(`${r.year}-${r.month}-${row.bs_day}`, row))
    })
    setRoster(rowMap)
    setPublishMap(pubMap)
    setRosterLoaded(true)
  }, [monthsNeeded])

  const loadSwapRequests = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_my_swap_requests')
    setErrFor('swaps', error ? employeeErrorText(error) : '')
    if (!error) setSwapRequests(data || [])
  }, [])

  const loadTada = useCallback(async () => {
    const [{ data, error }, { data: vends }] = await Promise.all([
      supabase.rpc('get_my_tada_claims'),
      supabase.rpc('get_my_client_vendors'),
    ])
    setErrFor('tada', error ? employeeErrorText(error) : '')
    if (error) return
    setTadaClaims(data || [])
    setTadaVendors(vends || [])
  }, [])

  // Home is built from the roster, the swap queue and the latest payslip, so those three load
  // together on arrival rather than one tab at a time.
  const refetchForTab = useCallback(() => {
    if (!profile?.hr_self_service) return
    if (tab === 'home') { loadRoster(); loadSwapRequests(); loadPayslips() }
    else if (tab === 'roster') { loadRoster(); loadSwapRequests() }
    else if (tab === 'requests') { loadLeave(); loadTada() }
    else if (tab === 'pay') loadPayslips()
  }, [profile, tab, loadRoster, loadSwapRequests, loadPayslips, loadLeave, loadTada])

  useEffect(() => { refetchForTab() }, [refetchForTab])

  // An installed iOS PWA is frozen rather than reloaded when it is closed: reopening from the home
  // screen icon resumes the exact in-memory state from last time (a payroll run finalised while the
  // app sat suspended never appears) with none of the effects above re-firing.
  useEffect(() => {
    if (!profile?.hr_self_service) return undefined
    function onVisibility() { if (document.visibilityState === 'visible') refetchForTab() }
    function onPageShow(e) { if (e.persisted) refetchForTab() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [profile, refetchForTab])

  // ── Swaps ──────────────────────────────────────────────────────────────────────────────────
  function openSwapRequest(day) {
    setSwapDay(day); setSwapTargetEmpId(''); setSwapTargetDay(''); setSwapNote(''); setSwapMsg('')
    // Clear stale data and show a loading state, or the picker renders holding only its
    // placeholder while the fetch is in flight and reads as "nobody is scheduled".
    setCoworkerRoster([]); setCoworkerLoading(true)
    supabase.rpc('get_coworker_roster', { p_bs_year: day.bsYear, p_bs_month: day.bsMonth })
      .then(({ data, error }) => {
        setCoworkerLoading(false)
        if (error) { setSwapMsg(employeeErrorText(error)); return }
        setCoworkerRoster(data || [])
      })
  }

  const coworkerNames = [...new Map(coworkerRoster.map(r => [r.employee_id, r.full_name])).entries()]
  const coworkerDays = coworkerRoster.filter(r => r.employee_id === swapTargetEmpId)

  async function submitSwapRequest() {
    if (!swapTargetEmpId || !swapTargetDay) { setSwapMsg('Pick a colleague and one of their scheduled days.'); return }
    setSwapSubmitting(true); setSwapMsg('')
    const { data: requestId, error } = await supabase.rpc('request_shift_swap', {
      p_target_employee_id: swapTargetEmpId, p_bs_year: swapDay.bsYear, p_bs_month: swapDay.bsMonth,
      p_my_bs_day: swapDay.bsDay, p_target_bs_day: parseInt(swapTargetDay, 10), p_note: swapNote,
    })
    setSwapSubmitting(false)
    if (error) { setSwapMsg(employeeErrorText(error)); return }
    supabase.functions.invoke('hr-push', { body: { action: 'notify_swap_request', request_id: requestId } })
    setSwapDay(null)
    // The confirmation has to outlive the sheet that produced it, or it disappears with the thing
    // the employee was looking at when they tapped Send.
    setDone('Swap request sent — your colleague has to accept it first.')
    loadSwapRequests()
  }

  async function respondSwap(requestId, accept) {
    const { error } = await supabase.rpc('respond_shift_swap', { p_request_id: requestId, p_accept: accept })
    if (error) { setErrFor('swaps', employeeErrorText(error)); return }
    supabase.functions.invoke('hr-push', { body: { action: 'notify_swap_target_response', request_id: requestId } })
    setDone(accept ? 'Accepted — your manager still has to approve the swap.' : 'Declined.')
    loadSwapRequests()
  }

  // ── Leave ──────────────────────────────────────────────────────────────────────────────────
  const isSingleDay = startDate && endDate && startDate === endDate
  const workingDays = startDate && endDate ? workingDaysInRange(startDate, endDate) : []
  const days = isSingleDay && dayType !== 'full' ? 0.5 : workingDays.length

  useEffect(() => { if (!isSingleDay) setDayType('full') }, [isSingleDay])

  function openLeave() {
    setStartDate(''); setEndDate(''); setReason(''); setDayType('full'); setMsg(''); setDone('')
    setLeaveOpen(true)
  }

  async function submitLeave() {
    if (!leaveTypeId) { setMsg('Select a leave type.'); return }
    if (!startDate || !endDate) { setMsg('Select start and end dates.'); return }
    if (workingDays.length === 0) { setMsg('No days in that range.'); return }
    setSubmitting(true); setMsg('')
    const { error } = await supabase.rpc('submit_my_leave_request', {
      p_leave_type_id: leaveTypeId, p_start_date: startDate, p_end_date: endDate, p_days: days,
      p_reason: reason, p_day_type: dayType,
    })
    setSubmitting(false)
    if (error) { setMsg(employeeErrorText(error)); return }
    setLeaveOpen(false)
    setDone('Leave request submitted — your manager will review it.')
    loadLeave()
  }

  // ── TADA ───────────────────────────────────────────────────────────────────────────────────
  function setTada(f, v) { setTadaForm(p => ({ ...p, [f]: v })) }
  function setTadaItem(idx, f, v) {
    setTadaForm(p => ({ ...p, items: p.items.map((it, i) => i === idx ? { ...it, [f]: v } : it) }))
  }
  function addTadaItemRow() { setTadaForm(p => ({ ...p, items: [...p.items, EMPTY_TADA_ITEM()] })) }
  function removeTadaItemRow(idx) { setTadaForm(p => ({ ...p, items: p.items.filter((_, i) => i !== idx) })) }
  function setTadaItemDistance(idx, v) {
    setTadaForm(p => ({
      ...p,
      items: p.items.map((it, i) => i === idx ? { ...it, distanceKm: v, amount: recomputeTadaAmount(it, v, it.vehicle, tadaVehicleRates) } : it),
    }))
  }
  function setTadaItemVehicle(idx, v) {
    setTadaForm(p => ({
      ...p,
      items: p.items.map((it, i) => i === idx ? { ...it, vehicle: v, amount: recomputeTadaAmount(it, it.distanceKm, v, tadaVehicleRates) } : it),
    }))
  }
  const tadaTotal = tadaForm.items.reduce((s, it) => s + (parseFloat(it.amount) || 0), 0)

  function openTada() {
    setTadaForm(emptyTadaForm()); setTadaPurposeMode('preset'); setTadaStartPointMode('preset')
    setTadaMsg(''); setDone('')
    setTadaOpen(true)
  }

  async function submitTada() {
    if (!tadaForm.start_date || !tadaForm.end_date) { setTadaMsg('Set the trip dates.'); return }
    const validItems = tadaForm.items.filter(it => parseFloat(it.amount) > 0)
    if (validItems.length === 0) { setTadaMsg('Add at least one expense line with an amount.'); return }
    setTadaSubmitting(true); setTadaMsg('')
    const { error } = await supabase.rpc('submit_my_tada_claim', {
      p_trip_purpose: tadaForm.trip_purpose, p_destination: tadaForm.destination,
      p_start_date: tadaForm.start_date, p_end_date: tadaForm.end_date, p_notes: tadaForm.notes,
      p_items: validItems.map(it => ({ category: it.category, description: it.description || null, amount: parseFloat(it.amount) })),
      p_start_point: tadaForm.start_point,
    })
    setTadaSubmitting(false)
    if (error) { setTadaMsg(employeeErrorText(error)); return }
    setTadaOpen(false)
    setDone('Claim submitted for approval.')
    loadTada()
  }

  async function signOut() {
    await supabase.auth.signOut()
    navigate('/login', { replace: true })
  }

  if (authLoading || !profile?.hr_self_service) {
    return <div style={{ padding: 40, color: 'var(--theme-text3)', textAlign: 'center' }}>Loading…</div>
  }

  const swapsForMe = pendingSwapsForMe(swapRequests, profile.hr_employee_id)
  const todayState = todayView({ days: homeDays, roster, publishMap, today })
  const next = nextShift({ days: homeDays, roster, publishMap, today })
  const latest = payslips === null ? undefined : (payslips[0] || null)

  return (
    <SelfServiceShell
      profile={profile}
      tab={tab}
      onTab={setTab}
      badges={{ roster: swapsForMe.length }}
      onSignOut={signOut}
    >
      {tab === 'home' && (
        <SelfServiceToday
          today={rosterLoaded || errs.roster ? todayState : { state: 'unknown' }}
          next={next}
          swapsForMe={swapsForMe}
          latestPayslip={latest && { label: `${BS_MONTHS[latest.bs_month - 1]} ${latest.bs_year}`, net: fmt(latest.net_pay) }}
          rosterErr={errs.roster}
          payslipsErr={errs.payslips}
          onRetryRoster={loadRoster}
          onRetryPayslips={loadPayslips}
          labelFor={labelFor}
          onGo={setTab}
        />
      )}

      {tab === 'roster' && (
        <>
          {done && <Done text={done} onClear={() => setDone('')} />}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 14 }}>
            <button className="btn btn-ghost" onClick={() => setWeekStart(w => addDays(w, -7))} aria-label="Previous week"
              style={{ width: 44, minWidth: 44, padding: 0, justifyContent: 'center' }}>‹</button>
            <div style={{ textAlign: 'center', minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}>{weekRangeLabel}</div>
              <button className="btn btn-ghost" style={{ fontSize: 12, minHeight: 32, padding: '4px 10px', marginTop: 2 }}
                onClick={() => setWeekStart(startOfWeek(new Date()))}>This week</button>
            </div>
            <button className="btn btn-ghost" onClick={() => setWeekStart(w => addDays(w, 7))} aria-label="Next week"
              style={{ width: 44, minWidth: 44, padding: 0, justifyContent: 'center' }}>›</button>
          </div>

          {errs.roster ? (
            <ErrorCard text={errs.roster} onRetry={loadRoster} />
          ) : !rosterLoaded ? (
            <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
          ) : (
            <RosterWeek
              days={weekDays}
              roster={roster}
              publishMap={publishMap}
              today={today}
              onRequestSwap={openSwapRequest}
              labelFor={labelFor}
            />
          )}

          <section className="ss-section">
            <h2 className="ss-label">Swap requests</h2>
            {errs.swaps ? <ErrorCard text={errs.swaps} onRetry={loadSwapRequests} />
              : swapRequests === null ? <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
              : swapRequests.length === 0 ? <Empty text="No swap requests yet." />
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {swapRequests.map(r => {
                    const iAmTarget = r.target_employee_id === profile.hr_employee_id
                    return (
                      <div key={r.id} className={`card${iAmTarget && r.status === 'pending_target' ? ' ss-attention' : ''}`} style={{ padding: 14 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                          <div style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.5 }}>
                            <b style={{ color: 'var(--theme-text1)' }}>{r.requester_name}</b> ({bsDayOrdinal(r.requester_bs_day)}, {r.requester_shift_name || '—'})
                            {' ⇄ '}
                            <b style={{ color: 'var(--theme-text1)' }}>{r.target_name}</b> ({bsDayOrdinal(r.target_bs_day)}, {r.target_shift_name || '—'})
                          </div>
                          <span className={SWAP_STATUS_BADGE[r.status] || 'badge-gray'} style={{ textTransform: 'capitalize', whiteSpace: 'nowrap' }}>
                            {r.status.replace(/_/g, ' ')}
                          </span>
                        </div>
                        {iAmTarget && r.status === 'pending_target' && (
                          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                            <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={() => respondSwap(r.id, false)}>Decline</button>
                            <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => respondSwap(r.id, true)}>Accept</button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
          </section>
        </>
      )}

      {tab === 'requests' && (
        <>
          {/* Leave and TADA are the same act from the employee's side, so they share a
              destination and separate here, one level down. */}
          <div className="tab-bar" style={{ marginBottom: 14 }}>
            {[['leave', 'Leave'], ['tada', 'TADA']].map(([val, label]) => (
              <button
                key={val}
                className={`tab-btn${requestTab === val ? ' tab-btn--active' : ''}`}
                aria-current={requestTab === val ? 'true' : undefined}
                onClick={() => setRequestTab(val)}
                style={{ fontSize: 14, padding: '10px 20px' }}
              >
                {label}
              </button>
            ))}
          </div>

          {done && <Done text={done} onClear={() => setDone('')} />}

          {requestTab === 'leave' ? (
            <>
              <button className="btn btn-primary btn-block" style={{ width: '100%', justifyContent: 'center', marginBottom: 16 }} onClick={openLeave}>
                Request leave
              </button>
              {errs.leave ? <ErrorCard text={errs.leave} onRetry={loadLeave} />
                : leaveRequests === null ? <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
                : leaveRequests.length === 0 ? <Empty text="No leave requests yet." />
                : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {leaveRequests.map(r => (
                      <div key={r.id} className="card" style={{ padding: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 14, color: 'var(--theme-text1)' }}>{fmtBsRange(r.start_date, r.end_date)} ({r.days}d)</div>
                          {r.reason && <div style={{ fontSize: 12, marginTop: 2, color: 'var(--theme-text3)' }}>{r.reason}</div>}
                        </div>
                        <span className={STATUS_BADGE[r.status]} style={{ textTransform: 'capitalize' }}>{r.status}</span>
                      </div>
                    ))}
                  </div>
                )}
            </>
          ) : (
            <>
              <button className="btn btn-primary btn-block" style={{ width: '100%', justifyContent: 'center', marginBottom: 16 }} onClick={openTada}>
                New TADA claim
              </button>
              {errs.tada ? <ErrorCard text={errs.tada} onRetry={loadTada} />
                : tadaClaims === null ? <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
                : tadaClaims.length === 0 ? <Empty text="No claims yet. TADA covers travel and daily allowance for a work trip." />
                : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {tadaClaims.map(c => (
                      <div key={c.id} className="card" style={{ padding: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 14, color: 'var(--theme-text1)' }}>{fmtBsRange(c.start_date, c.end_date)} · NPR {fmt(c.total_amount)}</div>
                          <div style={{ fontSize: 12, marginTop: 2, color: 'var(--theme-text3)' }}>
                            {[c.start_point && c.destination ? `${c.start_point} → ${c.destination}` : c.destination, c.trip_purpose].filter(Boolean).join(' · ') || '—'}
                            {c.status === 'paid' && ` · Paid via ${c.paid_method}`}
                          </div>
                        </div>
                        <span className={TADA_STATUS_BADGE[c.status]} style={{ textTransform: 'capitalize', whiteSpace: 'nowrap' }}>{c.status}</span>
                      </div>
                    ))}
                  </div>
                )}
            </>
          )}
        </>
      )}

      {tab === 'pay' && (
        errs.payslips ? <ErrorCard text={errs.payslips} onRetry={loadPayslips} />
        : payslips === null ? <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
        : payslips.length === 0 ? <Empty text="No finalised payslips yet. Your payslip appears here once payroll is run." />
        : (
          // A month row opens the FULL payslip rather than showing a partial breakdown inline: a
          // summary that lists some lines but not all is what made the old card unreadable, since
          // Net Pay didn't follow from anything on screen. Net Pay alone is honest at this level.
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {payslips.map(p => (
              <button
                key={p.id}
                className="card"
                onClick={() => setViewSlip(p)}
                style={{
                  padding: 16, width: '100%', textAlign: 'left', cursor: 'pointer',
                  font: 'inherit', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                }}
              >
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)' }}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year}</span>
                  <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Tap to view full payslip</span>
                </span>
                <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--theme-green-text)', whiteSpace: 'nowrap' }}>NPR {fmt(p.net_pay)}</span>
              </button>
            ))}
          </div>
        )
      )}

      {/* ── Sheets ────────────────────────────────────────────────────────────────────────────
          Long forms dock to the bottom of the screen instead of expanding inline. The TADA form
          in particular is the heaviest thing in this app, and inline it pushed the claim list —
          which is what most visits actually want — off the screen entirely. */}
      {leaveOpen && (
        <Modal variant="sheet" title="Request leave" onClose={() => setLeaveOpen(false)}>
          <div className="ss-sheet-head">
            <h2>Request leave</h2>
            <button className="btn btn-ghost" onClick={() => setLeaveOpen(false)} aria-label="Close"
              style={{ width: 44, minWidth: 44, padding: 0, justifyContent: 'center' }}>✕</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="ss-field">
              <label htmlFor="ss-leave-type">Leave type</label>
              <select id="ss-leave-type" className="form-select" style={{ width: '100%' }} value={leaveTypeId} onChange={e => setLeaveTypeId(e.target.value)}>
                {leaveTypes.map(t => <option key={t.id} value={t.id}>{t.name}{t.annual_quota > 0 ? ` (${t.annual_quota}/yr)` : ''}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div className="ss-field" style={{ flex: 1 }}>
                <label htmlFor="ss-leave-start">Start (BS)</label>
                <BsCalendarPicker id="ss-leave-start" touch value={startDate} onChange={setStartDate} placeholder="Select date" clearable />
              </div>
              <div className="ss-field" style={{ flex: 1 }}>
                <label htmlFor="ss-leave-end">End (BS)</label>
                <BsCalendarPicker id="ss-leave-end" touch value={endDate} onChange={setEndDate} placeholder="Select date" clearable />
              </div>
            </div>
            {isSingleDay && (
              <div className="ss-field">
                <label htmlFor="ss-leave-daytype">Day type</label>
                <select id="ss-leave-daytype" className="form-select" style={{ width: '100%' }} value={dayType} onChange={e => setDayType(e.target.value)}>
                  {DAY_TYPES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </div>
            )}
            {days > 0 && <div style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{days} day{days !== 1 ? 's' : ''} will be deducted.</div>}
            <div className="ss-field">
              <label htmlFor="ss-leave-reason">Reason</label>
              <textarea id="ss-leave-reason" style={{ ...inp, height: 76, resize: 'vertical' }} value={reason} onChange={e => setReason(e.target.value)} />
            </div>
            {msg && <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--theme-red-text)' }}>{msg}</p>}
            <button className="btn btn-primary btn-block" onClick={submitLeave} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
        </Modal>
      )}

      {tadaOpen && (
        <Modal variant="sheet" title="New TADA claim" onClose={() => setTadaOpen(false)}>
          <div className="ss-sheet-head">
            <div>
              <h2>New TADA claim</h2>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--theme-text3)' }}>Travel &amp; daily allowance — trip expenses you paid for</p>
            </div>
            <button className="btn btn-ghost" onClick={() => setTadaOpen(false)} aria-label="Close"
              style={{ width: 44, minWidth: 44, padding: 0, justifyContent: 'center' }}>✕</button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="ss-field">
              <label htmlFor="ss-tada-startpoint">Start point</label>
              <select
                id="ss-tada-startpoint"
                className="form-select" style={{ width: '100%' }}
                value={tadaStartPointMode === 'custom' ? OTHER_PURPOSE : tadaForm.start_point}
                onChange={e => {
                  if (e.target.value === OTHER_PURPOSE) { setTadaStartPointMode('custom'); setTada('start_point', '') }
                  else { setTadaStartPointMode('preset'); setTada('start_point', e.target.value) }
                }}
              >
                <option value="">Select start point…</option>
                {tadaStartPoints.map(p => <option key={p} value={p}>{p}</option>)}
                <option value={OTHER_PURPOSE}>Other (type below)</option>
              </select>
              {tadaStartPointMode === 'custom' && (
                <input aria-label="Trip start point" style={inp} placeholder="Where did the trip start?" value={tadaForm.start_point} onChange={e => setTada('start_point', e.target.value)} />
              )}
            </div>

            <div className="ss-field">
              <label htmlFor="ss-tada-purpose">Purpose</label>
              <select
                id="ss-tada-purpose"
                className="form-select" style={{ width: '100%' }}
                value={tadaPurposeMode === 'custom' ? OTHER_PURPOSE : tadaForm.trip_purpose}
                onChange={e => {
                  if (e.target.value === OTHER_PURPOSE) { setTadaPurposeMode('custom'); setTada('trip_purpose', '') }
                  else { setTadaPurposeMode('preset'); setTada('trip_purpose', e.target.value) }
                }}
              >
                <option value="">Select purpose…</option>
                {tadaPurposeOptions.map(p => <option key={p} value={p}>{p}</option>)}
                <option value={OTHER_PURPOSE}>Other (type below)</option>
              </select>
              {tadaPurposeMode === 'custom' && (
                <input aria-label="Trip purpose" style={inp} placeholder="Describe the purpose" value={tadaForm.trip_purpose} onChange={e => setTada('trip_purpose', e.target.value)} />
              )}
            </div>

            <div className="ss-field">
              <label htmlFor="ss-tada-destination">Destination</label>
              <input id="ss-tada-destination" style={inp} placeholder="e.g. Pokhara" value={tadaForm.destination} onChange={e => setTada('destination', e.target.value)} />
              {tadaForm.trip_purpose === PURCHASE_PURPOSE && (
                <SearchableSelect
                  touch
                  options={tadaVendors.map(v => ({ value: v.id, label: v.name }))}
                  value="" onChange={vId => { const v = tadaVendors.find(x => x.id === vId); if (v) setTada('destination', v.name) }}
                  placeholder="🏬 Or pick a registered vendor…"
                />
              )}
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <div className="ss-field" style={{ flex: 1 }}>
                <label htmlFor="ss-tada-start">Start (BS)</label>
                <BsCalendarPicker id="ss-tada-start" touch value={tadaForm.start_date} onChange={v => setTada('start_date', v)} placeholder="Select date" clearable />
              </div>
              <div className="ss-field" style={{ flex: 1 }}>
                <label htmlFor="ss-tada-end">End (BS)</label>
                <BsCalendarPicker id="ss-tada-end" touch value={tadaForm.end_date} onChange={v => setTada('end_date', v)} placeholder="Select date" clearable />
              </div>
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span className="ss-label" style={{ margin: 0 }}>Expenses</span>
                <button className="btn btn-ghost" onClick={addTadaItemRow}>+ Add line</button>
              </div>

              {/* One field per row. At 390px the previous single flex row wrapped a 130px select,
                  a description and a 100px amount unpredictably, so no two lines looked alike. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {tadaForm.items.map((it, idx) => (
                  <div key={idx} className="ss-line">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text3)' }}>Line {idx + 1}</span>
                      {tadaForm.items.length > 1 && (
                        <button
                          aria-label={`Remove expense line ${idx + 1}`}
                          onClick={() => removeTadaItemRow(idx)}
                          style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 16, width: 44, height: 44 }}
                        >✕</button>
                      )}
                    </div>
                    <select aria-label={`Category for line ${idx + 1}`} className="form-select" style={{ width: '100%' }} value={it.category} onChange={e => setTadaItem(idx, 'category', e.target.value)}>
                      {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <input aria-label={`Description for line ${idx + 1}`} style={inp} placeholder="Description (optional)" value={it.description} onChange={e => setTadaItem(idx, 'description', e.target.value)} />
                    <input aria-label={`Amount for line ${idx + 1}`} style={inp} type="number" min="0" inputMode="decimal" placeholder="Amount (NPR)" value={it.amount} onChange={e => setTadaItem(idx, 'amount', e.target.value)} />
                    {it.category === 'Transport' && (
                      <>
                        <select aria-label={`Vehicle for line ${idx + 1}`} className="form-select" style={{ width: '100%' }} value={it.vehicle} onChange={e => setTadaItemVehicle(idx, e.target.value)}>
                          {VEHICLE_TYPES.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
                        </select>
                        <input aria-label={`Distance in kilometres for line ${idx + 1}`} style={inp} type="number" min="0" step="0.1" inputMode="decimal" placeholder="Distance (km)" value={it.distanceKm} onChange={e => setTadaItemDistance(idx, e.target.value)} />
                        {tadaVehicleRates[it.vehicle] == null ? (
                          <span style={{ fontSize: 12, color: 'var(--theme-amber-text)' }}>No rate set — enter the amount yourself.</span>
                        ) : (
                          <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>× NPR {tadaVehicleRates[it.vehicle]}/km</span>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>

              <div style={{ textAlign: 'right', marginTop: 10, fontSize: 15, fontWeight: 700, color: 'var(--theme-accent-ink)' }}>
                Total: NPR {fmt(tadaTotal)}
              </div>
            </div>

            <div className="ss-field">
              <label htmlFor="ss-tada-notes">Notes</label>
              <textarea id="ss-tada-notes" style={{ ...inp, height: 66, resize: 'vertical' }} placeholder="Optional" value={tadaForm.notes} onChange={e => setTada('notes', e.target.value)} />
            </div>

            {tadaMsg && <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--theme-red-text)' }}>{tadaMsg}</p>}
            <button className="btn btn-primary btn-block" onClick={submitTada} disabled={tadaSubmitting}>
              {tadaSubmitting ? 'Submitting…' : 'Submit claim'}
            </button>
          </div>
        </Modal>
      )}

      {swapDay && (
        <Modal variant="sheet" title="Request a shift swap" onClose={() => setSwapDay(null)}>
          <div className="ss-sheet-head">
            <div>
              <h2>Request a swap</h2>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--theme-text3)' }}>Your {labelFor(swapDay)} shift</p>
            </div>
            <button className="btn btn-ghost" onClick={() => setSwapDay(null)} aria-label="Close"
              style={{ width: 44, minWidth: 44, padding: 0, justifyContent: 'center' }}>✕</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {coworkerLoading ? (
              <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>Loading colleagues…</p>
            ) : coworkerNames.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>No colleague has a published shift this month yet.</p>
            ) : (
              <div className="ss-field">
                <label htmlFor="ss-swap-with">Swap with</label>
                <select id="ss-swap-with" className="form-select" style={{ width: '100%' }} value={swapTargetEmpId}
                  onChange={e => { setSwapTargetEmpId(e.target.value); setSwapTargetDay('') }}>
                  <option value="">Choose a colleague…</option>
                  {coworkerNames.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
              </div>
            )}
            {swapTargetEmpId && (
              <div className="ss-field">
                <label htmlFor="ss-swap-day">Their day</label>
                <select id="ss-swap-day" className="form-select" style={{ width: '100%' }} value={swapTargetDay} onChange={e => setSwapTargetDay(e.target.value)}>
                  <option value="">Choose a day…</option>
                  {coworkerDays.map(cd => <option key={cd.bs_day} value={cd.bs_day}>{formatBsDay(cd.bs_day, swapDay.bsMonth)} — {cd.shift_type_name || '—'}</option>)}
                </select>
              </div>
            )}
            <div className="ss-field">
              <label htmlFor="ss-swap-note">Note</label>
              <textarea id="ss-swap-note" placeholder="Optional" style={{ ...inp, height: 66, resize: 'vertical' }} value={swapNote} onChange={e => setSwapNote(e.target.value)} />
            </div>
            {swapMsg && <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--theme-red-text)' }}>{swapMsg}</p>}
            <button className="btn btn-primary btn-block" disabled={swapSubmitting} onClick={submitSwapRequest}>
              {swapSubmitting ? 'Sending…' : 'Send request'}
            </button>
          </div>
        </Modal>
      )}

      {/* The employee's own copy of the exact document the owner sees — the same PayslipBody, so
          the two can never drift. It opens as a sheet here because this is a phone. */}
      {viewSlip && (
        <Modal variant="sheet" onClose={() => setViewSlip(null)} title="Payslip">
          <div className="ss-sheet-head">
            <h2>{BS_MONTHS[viewSlip.bs_month - 1]} {viewSlip.bs_year}</h2>
            <button className="btn btn-ghost" onClick={() => setViewSlip(null)} aria-label="Close"
              style={{ width: 44, minWidth: 44, padding: 0, justifyContent: 'center' }}>✕</button>
          </div>
          <PayslipBody
            slip={viewSlip}
            emp={viewSlip}
            periodLabel={`${BS_MONTHS[viewSlip.bs_month - 1]} ${viewSlip.bs_year}`}
            bizInfo={bizInfo}
          />
        </Modal>
      )}
    </SelfServiceShell>
  )
}

// A confirmation outlives the sheet that produced it, and lands on the list the employee is
// returned to. role="status" so it is announced rather than only seen.
function Done({ text, onClear }) {
  return (
    <div
      role="status"
      className="card"
      style={{
        padding: '12px 14px', marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center',
        background: 'color-mix(in srgb, var(--theme-green) 10%, var(--theme-card))',
        borderColor: 'color-mix(in srgb, var(--theme-green) 35%, var(--theme-border))',
      }}
    >
      <span style={{ flex: 1, fontSize: 13, color: 'var(--theme-text1)' }}>{text}</span>
      <button className="btn btn-ghost" onClick={onClear} aria-label="Dismiss"
        style={{ width: 44, minWidth: 44, padding: 0, justifyContent: 'center' }}>✕</button>
    </div>
  )
}

function ErrorCard({ text, onRetry }) {
  return (
    <div className="card" role="alert" style={{ padding: 14, borderColor: 'color-mix(in srgb, var(--theme-red) 35%, var(--theme-border))' }}>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--theme-text1)' }}>{text}</p>
      {onRetry && <button className="btn btn-ghost" style={{ marginTop: 10 }} onClick={onRetry}>Try again</button>}
    </div>
  )
}

function Empty({ text }) {
  return <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--theme-text3)' }}>{text}</p>
}
