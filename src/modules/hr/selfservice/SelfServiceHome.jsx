import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import { getBsToday, BS_MONTHS, adToBs, formatAd } from '../../../utils/bsCalendar'
import { workingDaysInRange, DAY_TYPES } from '../leave/leaveConstants'
import { isOffDay } from '../payrollConstants'
import { subscribeToPush, isPushSubscribed } from '../../../utils/webPush'
import { CATEGORIES, VEHICLE_TYPES, DEFAULT_PURPOSE_OPTIONS, DEFAULT_START_POINTS, OTHER_PURPOSE, PURCHASE_PURPOSE, EMPTY_TADA_ITEM, recomputeTadaAmount } from '../tada/tadaShared'
import SearchableSelect from '../../../components/SearchableSelect'

const fmt = n => Math.round(n || 0).toLocaleString('en-NP')
const fmtD = iso => {
  if (!iso) return '—'
  const bs = adToBs(new Date(iso + 'T00:00:00'))
  return `${bs.year}-${String(bs.month).padStart(2, '0')}-${String(bs.day).padStart(2, '0')}`
}
const inp = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6,
  padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%', fontFamily: 'inherit',
}
const lbl = { fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4, display: 'block' }
const STATUS_BADGE = { pending: 'badge-amber', approved: 'badge-green', rejected: 'badge-red', cancelled: 'badge-gray' }
const TADA_STATUS_BADGE = { pending: 'badge-amber', approved: 'badge-yellow', rejected: 'badge-red', paid: 'badge-green' }
function emptyTadaForm() {
  const today = formatAd(new Date())
  return { trip_purpose: '', destination: '', start_point: '', start_date: today, end_date: today, notes: '', items: [EMPTY_TADA_ITEM()] }
}
// isOffDay (imported from payrollConstants.js) highlights an employee's own off days on their
// roster view — same convention attendanceFromRoster.js uses to decide whether a zero-hour
// roster row generates an Off vs Holiday attendance row.
const SWAP_STATUS_BADGE = {
  pending_target: 'badge-amber', pending_admin: 'badge-amber', approved: 'badge-green',
  rejected_by_target: 'badge-red', rejected_by_admin: 'badge-red', cancelled: 'badge-gray',
}

// Employee-facing self-service home — own payslip / leave / roster only, via narrow RPCs scoped
// to the caller's own hr_employee_id (see migration 20260707260000). No ModuleGate/Layout chrome,
// same "standalone public-entry page" reasoning as PosLogin.jsx→/pos, just for a different kind
// of restricted account.
export default function SelfServiceHome() {
  const { session, profile, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const today = getBsToday()

  const [tab, setTab] = useState('payslip') // payslip | leave | tada | roster
  const [payslips, setPayslips] = useState(null)
  const [leaveTypes, setLeaveTypes] = useState([])
  const [leaveRequests, setLeaveRequests] = useState(null)
  const [rosterYear, setRosterYear] = useState(today.year)
  const [rosterMonth, setRosterMonth] = useState(today.month)
  const [roster, setRoster] = useState(null)
  const [rosterPublished, setRosterPublished] = useState(false)

  const [leaveTypeId, setLeaveTypeId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [reason, setReason] = useState('')
  const [dayType, setDayType] = useState('full')
  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState('')

  const [tadaClaims,    setTadaClaims]    = useState(null)
  const [tadaVendors,   setTadaVendors]   = useState([])
  const [tadaForm,      setTadaForm]      = useState(emptyTadaForm)
  const [tadaPurposeMode, setTadaPurposeMode] = useState('preset') // 'preset' | 'custom'
  const [tadaStartPointMode, setTadaStartPointMode] = useState('preset') // 'preset' | 'custom'
  const [tadaPurposeOptions, setTadaPurposeOptions] = useState(DEFAULT_PURPOSE_OPTIONS)
  const [tadaStartPoints, setTadaStartPoints] = useState(DEFAULT_START_POINTS)
  const [tadaVehicleRates, setTadaVehicleRates] = useState({ '2w': null, '4w': null, ev: null })
  const [tadaSubmitting, setTadaSubmitting] = useState(false)
  const [tadaMsg,        setTadaMsg]        = useState('')

  const [pushEnabled, setPushEnabled] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushMsg, setPushMsg] = useState('')

  const [swapRequests, setSwapRequests] = useState(null)
  const [swapDay, setSwapDay] = useState(null) // the requester's own day being offered
  const [coworkerRoster, setCoworkerRoster] = useState([])
  const [coworkerLoading, setCoworkerLoading] = useState(false)
  const [swapTargetEmpId, setSwapTargetEmpId] = useState('')
  const [swapTargetDay, setSwapTargetDay] = useState('')
  const [swapNote, setSwapNote] = useState('')
  const [swapSubmitting, setSwapSubmitting] = useState(false)
  const [swapMsg, setSwapMsg] = useState('')

  useEffect(() => {
    if (!authLoading && (!session || !profile?.hr_self_service)) {
      navigate('/login', { replace: true })
    }
  }, [authLoading, session, profile, navigate])

  useEffect(() => { isPushSubscribed().then(setPushEnabled) }, [])

  // settings isn't excluded from self-service RLS (only HR personal-data tables are), so this
  // can read it directly rather than needing a dedicated RPC.
  useEffect(() => {
    if (!profile?.client_id) return
    supabase.from('settings').select('tada_vehicle_rates, tada_purpose_options, tada_start_points').eq('client_id', profile.client_id).maybeSingle()
      .then(({ data }) => {
        setTadaVehicleRates({ '2w': null, '4w': null, ev: null, ...(data?.tada_vehicle_rates || {}) })
        setTadaPurposeOptions(data?.tada_purpose_options?.length ? data.tada_purpose_options : DEFAULT_PURPOSE_OPTIONS)
        setTadaStartPoints(data?.tada_start_points?.length ? data.tada_start_points : DEFAULT_START_POINTS)
      })
  }, [profile?.client_id])

  async function enableNotifications() {
    setPushBusy(true); setPushMsg('')
    try {
      await subscribeToPush(session.user.id, profile.client_id)
      setPushEnabled(true)
    } catch (err) {
      // ios_add_to_home_screen is instructions, not a failure — shown in amber, not red.
      const prefix = err.code === 'ios_add_to_home_screen' ? 'info' : 'error'
      setPushMsg(prefix + ':' + (err.message || 'Could not enable notifications.'))
    }
    setPushBusy(false)
  }

  const loadPayslips = useCallback(async () => {
    const { data } = await supabase.rpc('get_my_hr_payslips')
    setPayslips(data || [])
  }, [])

  const loadLeave = useCallback(async () => {
    const [{ data: types }, { data: reqs }] = await Promise.all([
      supabase.rpc('get_my_leave_types'),
      supabase.rpc('get_my_leave_requests'),
    ])
    setLeaveTypes(types || [])
    setLeaveRequests(reqs || [])
    if (!leaveTypeId && types?.length > 0) setLeaveTypeId(types[0].id)
  }, [leaveTypeId])

  const loadRoster = useCallback(async () => {
    const [{ data }, { data: published }] = await Promise.all([
      supabase.rpc('get_my_roster', { p_bs_year: rosterYear, p_bs_month: rosterMonth }),
      supabase.rpc('get_my_roster_publish_status', { p_bs_year: rosterYear, p_bs_month: rosterMonth }),
    ])
    setRoster(data || [])
    setRosterPublished(!!published)
  }, [rosterYear, rosterMonth])

  const loadSwapRequests = useCallback(async () => {
    const { data } = await supabase.rpc('get_my_swap_requests')
    setSwapRequests(data || [])
  }, [])

  const loadTada = useCallback(async () => {
    const [{ data }, { data: vends }] = await Promise.all([
      supabase.rpc('get_my_tada_claims'),
      supabase.rpc('get_my_client_vendors'),
    ])
    setTadaClaims(data || [])
    setTadaVendors(vends || [])
  }, [])

  useEffect(() => { if (profile?.hr_self_service && tab === 'payslip') loadPayslips() }, [profile, tab, loadPayslips])
  useEffect(() => { if (profile?.hr_self_service && tab === 'leave') loadLeave() }, [profile, tab, loadLeave])
  useEffect(() => { if (profile?.hr_self_service && tab === 'tada') loadTada() }, [profile, tab, loadTada])
  useEffect(() => { if (profile?.hr_self_service && tab === 'roster') { loadRoster(); loadSwapRequests() } }, [profile, tab, loadRoster, loadSwapRequests])

  function openSwapRequest(bsDay) {
    setSwapDay(bsDay); setSwapTargetEmpId(''); setSwapTargetDay(''); setSwapNote(''); setSwapMsg('')
    // Clear stale data and show a loading state — otherwise the picker briefly renders with only
    // the placeholder option while the fetch is in flight, which on a slow connection can look
    // like coworkers never loaded at all.
    setCoworkerRoster([]); setCoworkerLoading(true)
    supabase.rpc('get_coworker_roster', { p_bs_year: rosterYear, p_bs_month: rosterMonth })
      .then(({ data, error }) => {
        setCoworkerLoading(false)
        if (error) { setSwapMsg(error.message); return }
        setCoworkerRoster(data || [])
      })
  }

  const coworkerNames = [...new Map(coworkerRoster.map(r => [r.employee_id, r.full_name])).entries()]
  const coworkerDays = coworkerRoster.filter(r => r.employee_id === swapTargetEmpId)

  async function submitSwapRequest() {
    if (!swapTargetEmpId || !swapTargetDay) { setSwapMsg('Pick a coworker and one of their scheduled days.'); return }
    setSwapSubmitting(true); setSwapMsg('')
    const { data: requestId, error } = await supabase.rpc('request_shift_swap', {
      p_target_employee_id: swapTargetEmpId, p_bs_year: rosterYear, p_bs_month: rosterMonth,
      p_my_bs_day: swapDay, p_target_bs_day: parseInt(swapTargetDay, 10), p_note: swapNote,
    })
    setSwapSubmitting(false)
    if (error) { setSwapMsg(error.message); return }
    supabase.functions.invoke('hr-push', { body: { action: 'notify_swap_request', request_id: requestId } })
    setSwapDay(null)
    loadSwapRequests()
  }

  async function respondSwap(requestId, accept) {
    const { error } = await supabase.rpc('respond_shift_swap', { p_request_id: requestId, p_accept: accept })
    if (!error) {
      supabase.functions.invoke('hr-push', { body: { action: 'notify_swap_target_response', request_id: requestId } })
      loadSwapRequests()
    }
  }

  const isSingleDay = startDate && endDate && startDate === endDate
  const workingDays = startDate && endDate ? workingDaysInRange(startDate, endDate) : []
  const days = isSingleDay && dayType !== 'full' ? 0.5 : workingDays.length

  useEffect(() => { if (!isSingleDay) setDayType('full') }, [isSingleDay])

  async function submitLeave() {
    if (!leaveTypeId) { setMsg('error:Select a leave type.'); return }
    if (!startDate || !endDate) { setMsg('error:Select start and end dates.'); return }
    if (workingDays.length === 0) { setMsg('error:No days in that range.'); return }
    setSubmitting(true); setMsg('')
    const { error } = await supabase.rpc('submit_my_leave_request', {
      p_leave_type_id: leaveTypeId, p_start_date: startDate, p_end_date: endDate, p_days: days,
      p_reason: reason, p_day_type: dayType,
    })
    setSubmitting(false)
    if (error) { setMsg('error:' + error.message); return }
    setStartDate(''); setEndDate(''); setReason(''); setDayType('full'); setMsg('ok:Leave request submitted.')
    loadLeave()
  }

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

  async function submitTada() {
    if (!tadaForm.start_date || !tadaForm.end_date) { setTadaMsg('error:Set the trip dates.'); return }
    const validItems = tadaForm.items.filter(it => parseFloat(it.amount) > 0)
    if (validItems.length === 0) { setTadaMsg('error:Add at least one expense line with an amount.'); return }
    setTadaSubmitting(true); setTadaMsg('')
    const { error } = await supabase.rpc('submit_my_tada_claim', {
      p_trip_purpose: tadaForm.trip_purpose, p_destination: tadaForm.destination,
      p_start_date: tadaForm.start_date, p_end_date: tadaForm.end_date, p_notes: tadaForm.notes,
      p_items: validItems.map(it => ({ category: it.category, description: it.description || null, amount: parseFloat(it.amount) })),
      p_start_point: tadaForm.start_point,
    })
    setTadaSubmitting(false)
    if (error) { setTadaMsg('error:' + error.message); return }
    setTadaForm(emptyTadaForm()); setTadaPurposeMode('preset'); setTadaStartPointMode('preset'); setTadaMsg('ok:Claim submitted for approval.')
    loadTada()
  }

  async function signOut() {
    await supabase.auth.signOut()
    navigate('/login', { replace: true })
  }

  if (authLoading || !profile?.hr_self_service) {
    return <div style={{ padding: 40, color: 'var(--theme-text3)', textAlign: 'center' }}>Loading…</div>
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--theme-bg)' }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '28px 20px 60px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <h1 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 700, color: 'var(--theme-text1)' }}>{profile.full_name}</h1>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text3)' }}>Employee Self-Service</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={signOut}>Sign Out</button>
            {!pushEnabled && (
              <button className="btn btn-ghost" style={{ fontSize: 11 }} disabled={pushBusy} onClick={enableNotifications}>
                {pushBusy ? 'Enabling…' : '🔔 Enable Notifications'}
              </button>
            )}
          </div>
        </div>
        {pushMsg && (
          <p style={{
            fontSize: 11, margin: '-14px 0 14px', textAlign: 'right', lineHeight: 1.5,
            color: pushMsg.startsWith('info:') ? 'var(--theme-amber)' : 'var(--theme-red)',
          }}>
            {pushMsg.replace(/^(info|error):/, '')}
          </p>
        )}

        <div className="tab-bar" style={{ marginBottom: 20 }}>
          {[
            ['roster', 'Roster'], ['tada', 'TADA'], ['leave', 'Leave'], ['payslip', 'Payslip'],
          ].map(([val, label]) => (
            <button
              key={val}
              className={`tab-btn${tab === val ? ' tab-btn--active' : ''}`}
              onClick={() => setTab(val)}
              style={{ fontSize: 13, padding: '8px 18px', textTransform: 'uppercase', letterSpacing: '0.04em' }}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'payslip' && (
          payslips === null ? <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
          : payslips.length === 0 ? <p style={{ color: 'var(--theme-text3)' }}>No finalized payslips yet.</p>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {payslips.map(p => (
                <div key={p.id} className="card" style={{ padding: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontWeight: 700, color: 'var(--theme-text1)' }}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year}</span>
                    <span style={{ fontWeight: 700, color: 'var(--theme-green)' }}>NPR {fmt(p.net_pay)}</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 12, color: 'var(--theme-text2)' }}>
                    <span>Basic</span><span style={{ textAlign: 'right' }}>{fmt(p.basic)}</span>
                    <span>Allowances</span><span style={{ textAlign: 'right' }}>{fmt(p.allowances)}</span>
                    <span>Gross</span><span style={{ textAlign: 'right' }}>{fmt(p.gross)}</span>
                    <span>SSF (Employee)</span><span style={{ textAlign: 'right' }}>−{fmt(p.ssf_employee)}</span>
                    {p.advance_deduction > 0 && (<><span>Advance</span><span style={{ textAlign: 'right' }}>−{fmt(p.advance_deduction)}</span></>)}
                    {p.tds > 0 && (<><span>TDS</span><span style={{ textAlign: 'right' }}>−{fmt(p.tds)}</span></>)}
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {tab === 'leave' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div className="card" style={{ padding: 16 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--theme-text1)' }}>Submit Leave Request</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <label style={lbl}>Leave Type</label>
                  <select className="form-select" style={{ width: '100%' }} value={leaveTypeId} onChange={e => setLeaveTypeId(e.target.value)}>
                    {leaveTypes.map(t => <option key={t.id} value={t.id}>{t.name}{t.annual_quota > 0 ? ` (${t.annual_quota}/yr)` : ''}</option>)}
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <label style={lbl}>Start (BS)</label>
                    <BsCalendarPicker value={startDate} onChange={setStartDate} placeholder="Select date" clearable />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={lbl}>End (BS)</label>
                    <BsCalendarPicker value={endDate} onChange={setEndDate} placeholder="Select date" clearable />
                  </div>
                </div>
                {isSingleDay && (
                  <div>
                    <label style={lbl}>Day Type</label>
                    <select className="form-select" style={{ width: '100%' }} value={dayType} onChange={e => setDayType(e.target.value)}>
                      {DAY_TYPES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                    </select>
                  </div>
                )}
                {days > 0 && <div style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{days} day{days !== 1 ? 's' : ''}</div>}
                <div>
                  <label style={lbl}>Reason</label>
                  <textarea style={{ ...inp, height: 60, resize: 'vertical' }} value={reason} onChange={e => setReason(e.target.value)} />
                </div>
                {msg && <div style={{ fontSize: 12, color: msg.startsWith('ok') ? 'var(--theme-green)' : 'var(--theme-red)' }}>{msg.replace(/^(ok|error):/, '')}</div>}
                <button className="btn btn-primary" onClick={submitLeave} disabled={submitting} style={{ alignSelf: 'flex-end' }}>
                  {submitting ? 'Submitting…' : 'Submit Request'}
                </button>
              </div>
            </div>

            <div>
              <h3 style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--theme-text1)' }}>My Requests</h3>
              {leaveRequests === null ? <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
                : leaveRequests.length === 0 ? <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>No requests yet.</p>
                : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {leaveRequests.map(r => (
                      <div key={r.id} className="card" style={{ padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontSize: 13, color: 'var(--theme-text1)' }}>{r.start_date} → {r.end_date} ({r.days}d)</div>
                          {r.reason && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{r.reason}</div>}
                        </div>
                        <span className={STATUS_BADGE[r.status]} style={{ textTransform: 'capitalize', fontSize: 10 }}>{r.status}</span>
                      </div>
                    ))}
                  </div>
                )}
            </div>
          </div>
        )}

        {tab === 'tada' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div className="card" style={{ padding: 16 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--theme-text1)' }}>Submit TADA Claim</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <label style={lbl}>Start Point</label>
                    <select
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
                      <input style={{ ...inp, marginTop: 6 }} placeholder="Where did the trip start?" value={tadaForm.start_point} onChange={e => setTada('start_point', e.target.value)} />
                    )}
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={lbl}>Purpose</label>
                    <select
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
                      <input style={{ ...inp, marginTop: 6 }} placeholder="Describe the purpose" value={tadaForm.trip_purpose} onChange={e => setTada('trip_purpose', e.target.value)} />
                    )}
                  </div>
                </div>
                <div>
                  <label style={lbl}>Destination</label>
                  <input style={inp} placeholder="e.g. Pokhara" value={tadaForm.destination} onChange={e => setTada('destination', e.target.value)} />
                  {tadaForm.trip_purpose === PURCHASE_PURPOSE && (
                    <div style={{ marginTop: 6 }}>
                      <SearchableSelect
                        options={tadaVendors.map(v => ({ value: v.id, label: v.name }))}
                        value="" onChange={vId => { const v = tadaVendors.find(x => x.id === vId); if (v) setTada('destination', v.name) }}
                        placeholder="🏬 Or pick a registered vendor…"
                      />
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <label style={lbl}>Start (BS)</label>
                    <BsCalendarPicker value={tadaForm.start_date} onChange={v => setTada('start_date', v)} placeholder="Select date" clearable />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={lbl}>End (BS)</label>
                    <BsCalendarPicker value={tadaForm.end_date} onChange={v => setTada('end_date', v)} placeholder="Select date" clearable />
                  </div>
                </div>

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <label style={{ ...lbl, marginBottom: 0 }}>Expenses</label>
                    <button className="btn btn-ghost" style={{ fontSize: 12, padding: '8px 14px' }} onClick={addTadaItemRow}>+ Add line</button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {tadaForm.items.map((it, idx) => (
                      <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <select className="form-select" style={{ width: 130, flexShrink: 0 }} value={it.category} onChange={e => setTadaItem(idx, 'category', e.target.value)}>
                            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                          <input style={inp} placeholder="Description (optional)" value={it.description} onChange={e => setTadaItem(idx, 'description', e.target.value)} />
                          <input style={{ ...inp, width: 100, flexShrink: 0 }} type="number" min="0" placeholder="Amount" value={it.amount} onChange={e => setTadaItem(idx, 'amount', e.target.value)} />
                          {tadaForm.items.length > 1 && (
                            <button style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 16, flexShrink: 0, width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => removeTadaItemRow(idx)}>✕</button>
                          )}
                        </div>
                        {it.category === 'Transport' && (
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingLeft: 2, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 12, flexShrink: 0 }}>🧮</span>
                            <select className="form-select" style={{ width: 100, flexShrink: 0, fontSize: 12 }} value={it.vehicle} onChange={e => setTadaItemVehicle(idx, e.target.value)}>
                              {VEHICLE_TYPES.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
                            </select>
                            <input style={{ ...inp, width: 90, flexShrink: 0 }} type="number" min="0" step="0.1" placeholder="Distance (km)" value={it.distanceKm} onChange={e => setTadaItemDistance(idx, e.target.value)} />
                            {tadaVehicleRates[it.vehicle] == null ? (
                              <span style={{ fontSize: 11, color: 'var(--theme-amber)' }}>No rate set — enter Amount manually</span>
                            ) : (
                              <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>× NPR {tadaVehicleRates[it.vehicle]}/km</span>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div style={{ textAlign: 'right', marginTop: 8, fontSize: 13, fontWeight: 700, color: 'var(--theme-accent)' }}>
                    Total: NPR {fmt(tadaTotal)}
                  </div>
                </div>

                <div>
                  <label style={lbl}>Notes</label>
                  <textarea style={{ ...inp, height: 50, resize: 'vertical' }} placeholder="Optional" value={tadaForm.notes} onChange={e => setTada('notes', e.target.value)} />
                </div>

                {tadaMsg && <div style={{ fontSize: 12, color: tadaMsg.startsWith('ok') ? 'var(--theme-green)' : 'var(--theme-red)' }}>{tadaMsg.replace(/^(ok|error):/, '')}</div>}
                <button className="btn btn-primary" onClick={submitTada} disabled={tadaSubmitting} style={{ alignSelf: 'flex-end' }}>
                  {tadaSubmitting ? 'Submitting…' : 'Submit Claim'}
                </button>
              </div>
            </div>

            <div>
              <h3 style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--theme-text1)' }}>My Claims</h3>
              {tadaClaims === null ? <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
                : tadaClaims.length === 0 ? <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>No claims yet.</p>
                : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {tadaClaims.map(c => (
                      <div key={c.id} className="card" style={{ padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontSize: 13, color: 'var(--theme-text1)' }}>{fmtD(c.start_date)} → {fmtD(c.end_date)} — NPR {fmt(c.total_amount)}</div>
                          <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>
                            {[c.start_point && c.destination ? `${c.start_point} → ${c.destination}` : c.destination, c.trip_purpose].filter(Boolean).join(' · ') || '—'}
                            {c.status === 'paid' && ` · Paid via ${c.paid_method}`}
                          </div>
                        </div>
                        <span className={TADA_STATUS_BADGE[c.status]} style={{ textTransform: 'capitalize', fontSize: 10 }}>{c.status}</span>
                      </div>
                    ))}
                  </div>
                )}
            </div>
          </div>
        )}

        {tab === 'roster' && (
          <div>
            <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
              <select className="form-select" value={rosterMonth} onChange={e => setRosterMonth(parseInt(e.target.value, 10))}>
                {BS_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
              <select className="form-select" value={rosterYear} onChange={e => setRosterYear(parseInt(e.target.value, 10))}>
                {Array.from({ length: 3 }, (_, i) => today.year - 1 + i).map(y => <option key={y} value={y}>BS {y}</option>)}
              </select>
            </div>
            {roster === null ? <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
              : !rosterPublished ? <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Your manager hasn't published the schedule for this month yet.</p>
              : roster.length === 0 ? <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>No shifts scheduled this month.</p>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
                  {roster.map((r, i) => {
                    const off = isOffDay(r.shift_type_name)
                    return (
                    <div key={i} className="card" style={{ padding: 12, background: off ? 'rgba(107,114,128,0.12)' : undefined, border: off ? '1px solid rgba(107,114,128,0.3)' : undefined }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 13, color: 'var(--theme-text1)', fontWeight: 600 }}>Day {r.bs_day}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 13, color: off ? 'var(--theme-text3)' : 'var(--theme-text2)', fontWeight: off ? 600 : 400 }}>
                            {r.shift_type_name || '—'}{r.shift_start && ` (${r.shift_start}–${r.shift_end})`}
                          </span>
                          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '8px 14px' }} onClick={() => openSwapRequest(r.bs_day)}>
                            Request Swap
                          </button>
                        </div>
                      </div>

                      {swapDay === r.bs_day && (
                        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--theme-border-lt)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {coworkerLoading ? (
                            <div style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Loading coworkers…</div>
                          ) : coworkerNames.length === 0 ? (
                            <div style={{ fontSize: 12, color: 'var(--theme-text3)' }}>No coworkers have a published shift this month yet.</div>
                          ) : (
                            <select className="form-select" style={{ width: '100%' }} value={swapTargetEmpId}
                              onChange={e => { setSwapTargetEmpId(e.target.value); setSwapTargetDay('') }}>
                              <option value="">Swap with…</option>
                              {coworkerNames.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                            </select>
                          )}
                          {swapTargetEmpId && (
                            <select className="form-select" style={{ width: '100%' }} value={swapTargetDay} onChange={e => setSwapTargetDay(e.target.value)}>
                              <option value="">Their day…</option>
                              {coworkerDays.map(d => <option key={d.bs_day} value={d.bs_day}>Day {d.bs_day} — {d.shift_type_name || '—'}</option>)}
                            </select>
                          )}
                          <textarea placeholder="Note (optional)" style={{ ...inp, height: 44, resize: 'vertical' }} value={swapNote} onChange={e => setSwapNote(e.target.value)} />
                          {swapMsg && <div style={{ fontSize: 11, color: 'var(--theme-red)' }}>{swapMsg}</div>}
                          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setSwapDay(null)}>Cancel</button>
                            <button className="btn btn-primary" style={{ fontSize: 12 }} disabled={swapSubmitting} onClick={submitSwapRequest}>
                              {swapSubmitting ? 'Sending…' : 'Send Request'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )})}
                </div>
              )}

            <h3 style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--theme-text1)' }}>Swap Requests</h3>
            {swapRequests === null ? <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
              : swapRequests.length === 0 ? <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>No swap requests yet.</p>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {swapRequests.map(r => {
                    const iAmTarget = r.target_employee_id === profile.hr_employee_id
                    return (
                      <div key={r.id} className="card" style={{ padding: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                            <b style={{ color: 'var(--theme-text1)' }}>{r.requester_name}</b> (day {r.requester_bs_day}, {r.requester_shift_name || '—'})
                            {' ⇄ '}
                            <b style={{ color: 'var(--theme-text1)' }}>{r.target_name}</b> (day {r.target_bs_day}, {r.target_shift_name || '—'})
                          </div>
                          <span className={SWAP_STATUS_BADGE[r.status] || 'badge-gray'} style={{ fontSize: 9, textTransform: 'capitalize', whiteSpace: 'nowrap' }}>
                            {r.status.replace(/_/g, ' ')}
                          </span>
                        </div>
                        {iAmTarget && r.status === 'pending_target' && (
                          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => respondSwap(r.id, false)}>Decline</button>
                            <button className="btn btn-primary" style={{ fontSize: 11 }} onClick={() => respondSwap(r.id, true)}>Accept</button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
          </div>
        )}
      </div>
    </div>
  )
}
