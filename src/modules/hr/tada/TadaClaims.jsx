import { nprInt } from '../../../shared/nepalMoney'
import { Fragment, useState, useEffect, useCallback, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import { FilterChips } from '../../../components/Tabs'
import Modal from '../../../components/Modal'
import SearchableSelect from '../../../components/SearchableSelect'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import FieldError from '../../../components/FieldError'
import TadaSettingsModal from './TadaSettingsModal'
import ActionError, { asActionError } from '../../../components/ActionError'
import RowDisclosure from '../../../components/RowDisclosure'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { DecisionButtons, BulkApproveBar, decideEach } from '../ApprovalControls'
import { nepalBs, nepalDateAd } from '../../../shared/nepalTime'
import { adToBs, adToBsSafe, formatAd, BS_MONTHS } from '../../../utils/bsCalendar'
import {
  CATEGORIES, VEHICLE_TYPES, DEFAULT_PURPOSE_OPTIONS, DEFAULT_START_POINTS, OTHER_PURPOSE, PURCHASE_PURPOSE,
  EMPTY_TADA_ITEM, recomputeTadaAmount, tadaLineAmount, tadaItemsTotal, acceptTadaAmount, tadaDatesError, findLookAlikeClaim,
} from './tadaShared'
import { TADA_REQUEST_STATUS } from '../payrollConstants'

const fmt = nprInt
const pad2 = n => String(n).padStart(2, '0')
const fmtD = iso => {
  if (!iso) return '—'
  const bs = adToBsSafe(new Date(iso + 'T00:00:00'))
  // Out of the BS table's range: show the AD date, marked, never a confident wrong BS date (S753).
  if (!bs) return `${iso} (AD)`
  return `${bs.year}-${pad2(bs.month)}-${pad2(bs.day)}`
}
// A timestamp's BS day AS READ IN NEPAL. `paid_at.slice(0, 10)` took the UTC date, so a payment
// between 00:00 and 05:45 Kathmandu printed under the previous day (S751).
const fmtTs = ts => {
  if (!ts) return '—'
  const bs = nepalBs(ts)
  return bs ? `${bs.year}-${pad2(bs.month)}-${pad2(bs.day)}` : (nepalDateAd(ts) || '—')
}
const inp = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  borderRadius: 0, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)',
  outline: 'none', width: '100%', fontFamily: 'inherit',
}
const lbl = { fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4, display: 'block' }
// PayrollRun's stale-draft card is this product's amber banner; same shape as Leave and Attendance.
const amberBanner = {
  marginBottom: 14, padding: '12px 16px',
  borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)',
  background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
}
const quietNote = { fontSize: 11, color: 'var(--theme-text3)', marginTop: 3, whiteSpace: 'normal' }

// Status ladder, shared with every other HR queue and with the employee app — see
// TADA_REQUEST_STATUS. This page used to invert the module's two loudest signals: Pending was GREY
// (the colour that means cancelled/void everywhere else, so the one column actually waiting on a
// decision read as the most inert thing on screen) and Approved was AMBER (the colour that means
// "waiting on you" on the HR Dashboard and in the employee's own copy of this same claim). Approved
// here is brass — decided, but the cash has not left — and paid takes green.
const STATUS_BADGE = Object.fromEntries(
  Object.entries(TADA_REQUEST_STATUS).map(([k, v]) => [k, v.badge]))
function emptyAddForm() {
  const today = formatAd(new Date())
  return {
    employee_id: '', trip_purpose: '', destination: '', start_point: '', start_date: today, end_date: today, notes: '',
    items: [EMPTY_TADA_ITEM()],
  }
}
const PAID_METHODS = ['Cash', 'Bank Transfer', 'Cheque']
// The month filter narrows HISTORY only (S751). It used to default to the open month on every tab,
// so a pending claim from a trip last month was invisible on the Pending tab while the HR Dashboard
// counted it — a queue a manager works from must show everything still waiting, whatever month.
const HISTORY_TABS = new Set(['paid', 'rejected', 'all'])

export default function TadaClaims() {
  const { clientId, session, profile, isAdmin, isOwner, hasHrAccess } = useAuth()
  const canManageSettings = isAdmin || isOwner || hasHrAccess('manager')
  // Decision 7 (S751): a supervisor approves or rejects OTHER people's claims; marking one paid
  // needs a manager. The database enforces both (tada_own_claim / tada_pay_rank) — this only keeps
  // the page from offering a button that is certain to be refused.
  const canPay = hasHrAccess('manager')
  const { scopedFrom, scopedUpdate, scopedDelete } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()
  const loadReq = useLatestRequest()
  const [actionError, setActionError] = useState(null) // an approve/reject/pay/delete that did not land
  const [busyId, setBusyId] = useState(null)

  const [employees, setEmployees] = useState([])
  const [vendors,   setVendors]   = useState([])
  const [claims,    setClaims]    = useState([])
  const [items,     setItems]     = useState([])
  const [loading,   setLoading]   = useState(true)
  // The client whose claims are on screen (the Advances pattern). `loading` alone cannot say it: a
  // reload after a decision keeps the same client's rows visible, while an admin client switch must
  // not leave the previous client's claims clickable — an Approve on one matches nothing here.
  const [loadedFor, setLoadedFor] = useState(null)
  const [loadError, setLoadError] = useState(null) // a failed read is not an empty queue
  // claim id → { label, key } of the earliest payroll DRAFT whose payslips carry it. null = not
  // known (not read yet, or the read failed) — which must render as no chip, never as "not in one".
  const [draftByClaim, setDraftByClaim] = useState(null)
  const [payrollError, setPayrollError] = useState(null)

  const [filterStatus, setFilterStatus] = useState('pending') // pending | approved | rejected | paid | all
  // hr_tada_claims has no bs_year/bs_month of its own — it's a standalone ledger of plain AD
  // start_date/end_date, deliberately not plumbed through monthly_periods. Month filter buckets
  // by start_date's BS month client-side instead.
  const [monthFilter,    setMonthFilter]    = useState('all') // 'all' | `${bsYear}-${bsMonth}`
  const [selected,     setSelected]     = useState(null)
  const [showAdd,      setShowAdd]      = useState(false)
  const [addForm,      setAddForm]      = useState(emptyAddForm)
  const [purposeMode,    setPurposeMode]    = useState('preset') // 'preset' | 'custom' — UI-only, doesn't affect what's submitted
  const [startPointMode, setStartPointMode] = useState('preset') // 'preset' | 'custom'
  const [saving,       setSaving]       = useState(false)
  const [error,        setError]        = useState('') // string (validation) or { text, detail } (a refused save)
  const [payTarget,    setPayTarget]    = useState(null)
  const [payMethod,    setPayMethod]    = useState('Cash')
  const [rejectTarget, setRejectTarget] = useState(null)
  // Vehicle-type rates (NPR/km) — a single rate wasn't enough since a 2-wheeler, 4-wheeler, and
  // EV genuinely cost different amounts per km. Keyed object, not a fully-editable named list like
  // settings.pos_delivery_partners — the three categories are fixed, only their rates vary.
  // Managed from TadaSettingsModal (admin/owner-only), not inline here.
  const [vehicleRates,   setVehicleRates]   = useState({ '2w': null, '4w': null, ev: null })
  const [purposeOptions, setPurposeOptions] = useState(DEFAULT_PURPOSE_OPTIONS)
  const [startPoints,    setStartPoints]    = useState(DEFAULT_START_POINTS)
  const [showSettings,   setShowSettings]   = useState(false)

  // Where each approved claim stands against payroll (decision 5, S751). A claim is paid by the
  // first payroll generated after approval with the trip over (fetchApprovedTadaMap), and a draft
  // run's payslips name the claims they will close in `tada_claim_ids` — Finalize closes exactly
  // those, and only on a payslip still carrying a TADA amount. Read once per load, paged.
  const readPayrollDrafts = useCallback(async () => {
    const runsRes = await fetchAllRows(() =>
      scopedFrom('hr_payroll_runs', 'id, period_id, status, monthly_periods(bs_year, bs_month)').eq('status', 'draft').order('id'))
    if (runsRes.error) return { data: null, error: runsRes.error }
    const runs = runsRes.data || []
    if (runs.length === 0) return { data: {}, error: null }
    const slipsRes = await fetchAllRowsChunked(runs.map(r => r.id), ids =>
      scopedFrom('hr_payslips', 'id, run_id, tada_amount, tada_claim_ids').in('run_id', ids).gt('tada_amount', 0).order('id'))
    if (slipsRes.error) return { data: null, error: slipsRes.error }
    const runById = Object.fromEntries(runs.map(r => [r.id, r]))
    const map = {}
    ;(slipsRes.data || []).forEach(s => {
      const mp = runById[s.run_id]?.monthly_periods
      // An HR login's RLS view of monthly_periods is empty, so the month may be unknowable here;
      // it then sorts last and the chip says "a payroll draft" rather than guessing one.
      const key = mp ? mp.bs_year * 100 + mp.bs_month : Number.MAX_SAFE_INTEGER
      const label = mp ? `${BS_MONTHS[mp.bs_month - 1]} ${mp.bs_year}` : null
      ;(Array.isArray(s.tada_claim_ids) ? s.tada_claim_ids : []).forEach(id => {
        if (!map[id] || key < map[id].key) map[id] = { key, label }
      })
    })
    return { data: map, error: null }
  }, [scopedFrom])

  // Returns the freshly read claims, or null when the read failed or was superseded — the stale-
  // action message below names where a claim is NOW, so it needs the list this load produced.
  const load = useCallback(async () => {
    if (!clientId) return null
    const key = loadReq.begin(clientId)
    setLoading(true)
    const results = await Promise.all([
      scopedFrom('hr_employees', 'id, full_name, employee_code, status, email').order('full_name'),
      scopedFrom('vendors', 'id, name').eq('is_active', true).order('name'),
      // Paged (S682): every claim the client has ever filed, so the silent 1000-row cap would
      // drop the OLDEST claims from the list with no error. `.order('id')` is the tiebreaker.
      fetchAllRows(() => scopedFrom('hr_tada_claims').order('created_at', { ascending: false }).order('id')),
      // settings has a nullable client_id (no free-default tier for it, unlike most tables) —
      // stays on raw supabase.from() rather than scopedDb, same as every other settings read.
      supabase.from('settings').select('tada_vehicle_rates, tada_purpose_options, tada_start_points').eq('client_id', clientId).maybeSingle(),
    ])
    if (!loadReq.isCurrent(key)) return null
    const failed = results.find(r => r && r.error)
    if (failed) {
      setLoadError(asActionError(failed.error, 'operator'))
      setLoading(false)
      return null
    }
    const [{ data: emps }, { data: vends }, { data: cls }, { data: settingsRow }] = results
    const claimIds = (cls || []).map(c => c.id)
    // hr_tada_claim_items has no client_id column of its own — scoped via claim_id against this
    // client's already-scoped claim ids, same parent-scoped pattern as recipe_ingredients.
    // Chunked: an .in() list of every claim id is a URL as well as a row count (S629).
    const [itemsRes, payrollRes] = await Promise.all([
      claimIds.length > 0
        ? fetchAllRowsChunked(claimIds, ids => supabase.from('hr_tada_claim_items').select('*').in('claim_id', ids).order('id'))
        : Promise.resolve({ data: [], error: null }),
      readPayrollDrafts(),
    ])
    if (!loadReq.isCurrent(key)) return null
    if (itemsRes.error) { setLoadError(asActionError(itemsRes.error, 'operator')); setLoading(false); return null }
    setLoadError(null)
    setEmployees(emps || [])
    setVendors(vends || [])
    setClaims(cls || [])
    setItems(itemsRes.data || [])
    // Fail SOFT: the payroll standing is a hint beside the claim, not the claim. A failed read shows
    // no chip at all and says so in a banner — never a confident "will be paid by the next payroll".
    setDraftByClaim(payrollRes.error ? null : payrollRes.data)
    setPayrollError(payrollRes.error ? asActionError(payrollRes.error, 'operator') : null)
    setVehicleRates({ '2w': null, '4w': null, ev: null, ...(settingsRow?.tada_vehicle_rates || {}) })
    setPurposeOptions(settingsRow?.tada_purpose_options?.length ? settingsRow.tada_purpose_options : DEFAULT_PURPOSE_OPTIONS)
    setStartPoints(settingsRow?.tada_start_points?.length ? settingsRow.tada_start_points : DEFAULT_START_POINTS)
    setLoading(false)
    setLoadedFor(key)
    return cls || []
  }, [clientId, scopedFrom, loadReq, readPayrollDrafts])

  // A client switch drops everything that belonged to the previous client — rows, lines, payroll
  // chips, open dialogs and messages — before the new client's read starts, so nothing of theirs
  // can be acted on while it arrives.
  useEffect(() => {
    setClaims([]); setItems([]); setEmployees([]); setVendors([])
    setDraftByClaim(null); setPayrollError(null); setLoadError(null); setActionError(null)
    setSelected(null); setPayTarget(null); setRejectTarget(null); setShowAdd(false); setShowSettings(false)
    setMonthFilter('all')
  }, [clientId])
  useEffect(() => { load() }, [load])

  function handleSettingsSaved(nextRates, nextOptions, nextStartPoints) {
    setVehicleRates(nextRates)
    setPurposeOptions(nextOptions)
    setStartPoints(nextStartPoints)
    setShowSettings(false)
  }

  function setItemDistance(idx, v) {
    setAddForm(p => ({
      ...p,
      items: p.items.map((it, i) => i === idx ? { ...it, distanceKm: v, amount: recomputeTadaAmount(it, v, it.vehicle, vehicleRates) } : it),
    }))
  }
  function setItemVehicle(idx, v) {
    setAddForm(p => ({
      ...p,
      items: p.items.map((it, i) => i === idx ? { ...it, vehicle: v, amount: recomputeTadaAmount(it, it.distanceKm, v, vehicleRates) } : it),
    }))
  }

  // Memoized: the Add Claim modal is a form of controlled inputs on this same component, so every
  // keystroke while filing a claim re-ran all of it — including a BS conversion per claim in
  // monthClaims and four more scans for the KPI strip.
  const empMap = useMemo(() => Object.fromEntries(employees.map(e => [e.id, e])), [employees])
  const itemsByClaimId = useMemo(() => {
    const m = {}
    items.forEach(i => { (m[i.claim_id] = m[i.claim_id] || []).push(i) })
    return m
  }, [items])

  // Each claim's trip-start BS month, once. The month list is built from the claims themselves
  // rather than monthly_periods — an HR login cannot read monthly_periods, so its dropdown was empty.
  const startMonthById = useMemo(() => {
    const m = {}
    claims.forEach(c => {
      if (!c.start_date) return
      const bs = adToBs(new Date(c.start_date + 'T00:00:00'))
      m[c.id] = { key: `${bs.year}-${bs.month}`, sort: bs.year * 100 + bs.month, label: `${BS_MONTHS[bs.month - 1]} ${bs.year}` }
    })
    return m
  }, [claims])
  const monthOptions = useMemo(() => {
    const seen = new Map()
    Object.values(startMonthById).forEach(v => { if (!seen.has(v.key)) seen.set(v.key, v) })
    return [...seen.values()].sort((a, b) => b.sort - a.sort)
  }, [startMonthById])

  const monthApplies = HISTORY_TABS.has(filterStatus)
  const monthClaims = useMemo(() => monthFilter === 'all'
    ? claims
    : claims.filter(c => startMonthById[c.id]?.key === monthFilter), [claims, monthFilter, startMonthById])

  const filtered = useMemo(() => {
    const base = monthApplies ? monthClaims : claims
    return filterStatus === 'all' ? base : base.filter(c => c.status === filterStatus)
  }, [claims, monthClaims, filterStatus, monthApplies])

  // Open money is counted across every month — it is owed whatever month the trip began in. Paid
  // follows the month filter, since it is history.
  const { pendingCount, pendingTotal, approvedCount, approvedTotal, paidTotal } = useMemo(() => {
    let pendingCount = 0, pendingTotal = 0, approvedCount = 0, approvedTotal = 0, paidTotal = 0
    for (const c of claims) {
      const amt = parseFloat(c.total_amount) || 0
      if (c.status === 'pending')       { pendingCount++; pendingTotal += amt }
      else if (c.status === 'approved') { approvedCount++; approvedTotal += amt }
    }
    for (const c of monthClaims) if (c.status === 'paid') paidTotal += parseFloat(c.total_amount) || 0
    return { pendingCount, pendingTotal, approvedCount, approvedTotal, paidTotal }
  }, [claims, monthClaims])

  // "Your own claim": the signed-in login's linked employee, or an employee record carrying this
  // login's email — the same two tests hr_is_own_employee() makes. The operator is exempt there
  // too. The database decides regardless; this only avoids offering a button it will refuse.
  const myEmail = (session?.user?.email || '').trim().toLowerCase()
  const isOwnClaim = useCallback(c => {
    if (isAdmin) return false
    if (profile?.hr_employee_id && profile.hr_employee_id === c.employee_id) return true
    const e = empMap[c.employee_id]
    return !!(myEmail && e?.email && e.email.trim().toLowerCase() === myEmail)
  }, [isAdmin, profile, empMap, myEmail])

  function setAdd(f, v) { setAddForm(p => ({ ...p, [f]: v })) }
  function setItem(idx, f, v) {
    setAddForm(p => ({ ...p, items: p.items.map((it, i) => i === idx ? { ...it, [f]: v } : it) }))
  }
  function addItemRow() { setAddForm(p => ({ ...p, items: [...p.items, EMPTY_TADA_ITEM()] })) }
  function removeItemRow(idx) { setAddForm(p => ({ ...p, items: p.items.filter((_, i) => i !== idx) })) }
  // Only positive lines count, exactly as create_tada_claim counts them, so the Total on the form
  // is the total that is saved (S751).
  const addTotal = tadaItemsTotal(addForm.items)
  const endDateMsg = addForm.start_date && addForm.end_date && addForm.end_date < addForm.start_date
    ? 'The trip ends before it starts.' : ''
  const lookAlike = useMemo(() => showAdd
    ? findLookAlikeClaim(claims, { employeeId: addForm.employee_id, startDate: addForm.start_date, endDate: addForm.end_date, total: addTotal })
    : null, [showAdd, claims, addForm.employee_id, addForm.start_date, addForm.end_date, addTotal])

  async function handleAdd() {
    if (!clientId) return
    if (!addForm.employee_id) { setError('Select an employee.'); return }
    const datesErr = tadaDatesError(addForm.start_date, addForm.end_date)
    if (datesErr) { setError(datesErr); return }
    if (addForm.items.some(it => it.amount !== '' && !acceptTadaAmount(it.amount))) {
      setError('An expense amount is negative or not a number. Fix it before submitting.'); return
    }
    if (addForm.items.some(it => !CATEGORIES.includes(it.category))) { setError('Pick a category for every expense line.'); return }
    const validItems = addForm.items.filter(it => tadaLineAmount(it) > 0)
    if (validItems.length === 0) { setError('Add at least one expense line with an amount.'); return }
    setError(''); setSaving(true)

    // One transaction (S751): the claim and its lines used to be two inserts, and a failed second
    // left a claim showing a total with no lines behind it.
    const { error: err } = await supabase.rpc('create_tada_claim', {
      p_employee_id:  addForm.employee_id,
      p_trip_purpose: addForm.trip_purpose || null,
      p_destination:  addForm.destination || null,
      p_start_point:  addForm.start_point || null,
      p_start_date:   addForm.start_date,
      p_end_date:     addForm.end_date,
      p_notes:        addForm.notes || null,
      p_items: validItems.map(it => ({ category: it.category, description: it.description || null, amount: tadaLineAmount(it) })),
    })
    setSaving(false)
    if (err) { setError(asActionError(err, 'operator')); return }
    setShowAdd(false); setAddForm(emptyAddForm()); setPurposeMode('preset'); setStartPointMode('preset'); load()
  }

  // Each decision is a write to a money ledger; before S682 all four ran bare and the queue
  // simply reloaded, so a refused approve looked like a claim nobody had touched.
  const decisionFailed = (what, err) => {
    const info = asActionError(err, 'operator')
    setActionError({ ...info, text: what + ' ' + info.text })
  }

  // Every decision is CONDITIONAL on the status the screen showed (S751). By id alone, a screen
  // loaded before payroll paid a claim could approve it again (payable twice) or re-mark it Paid in
  // cash. A conditional write that matches nothing returns no error and no rows, so each asks for
  // `id` back; zero rows means the claim moved, and the message says where it is now.
  async function reportMoved(claimId, what) {
    const fresh = await load()
    const now = fresh?.find(x => x.id === claimId)
    const where = !fresh
      ? 'The list could not be reloaded to show it.'
      : now
        ? `It is now ${TADA_REQUEST_STATUS[now.status]?.label || now.status}${now.status === 'paid' && now.paid_method ? ` (${now.paid_method})` : ''}.`
        // Not "deleted": a claim can also be absent because the page switched client meanwhile.
        : 'It is no longer on this list (deleted, or the page switched client) — reloaded.'
    setActionError(`${what} This claim changed on another screen — here is where it is now: ${where}`)
  }

  async function handleApprove(c) {
    setActionError(null); setBusyId(c.id)
    // approved_by / approved_at are stamped by the database (hr_tada_claims_guard), never sent.
    const { data, error: err } = await scopedUpdate('hr_tada_claims', { status: 'approved' })
      .eq('id', c.id).eq('status', 'pending').select('id')
    setBusyId(null)
    if (err) { decisionFailed('The claim was not approved.', err); load(); return }
    if (!data?.length) { await reportMoved(c.id, 'The claim was not approved.'); return }
    load()
  }

  // Every pending claim on screen that this login may decide, approved one after another through the
  // same conditional write as the row button (S768). A claim decided elsewhere, or refused, is named.
  function requestBulkApprove() {
    const pending = filtered.filter(c => c.status === 'pending' && !isOwnClaim(c))
    if (pending.length < 2) return
    const total = pending.reduce((s, c) => s + (parseFloat(c.total_amount) || 0), 0)
    askConfirm({
      title: `Approve ${pending.length} TADA claims?`,
      confirmLabel: `Approve ${pending.length}`, busyLabel: 'Approving…',
      body: (
        <p style={{ margin: 0 }}>
          NPR {fmt(total)} in all. Each approved claim is paid by the first payroll after its trip ends —
          or by hand with Mark Paid, never both.
        </p>
      ),
      run: async () => {
        setActionError(null)
        const { done, failed } = await decideEach(pending, async c => {
          const { data, error } = await scopedUpdate('hr_tada_claims', { status: 'approved' }).eq('id', c.id).eq('status', 'pending').select('id')
          if (error) return asActionError(error, 'operator').text
          return data?.length ? true : 'it was decided on another screen first'
        })
        await load()
        if (failed.length) setActionError(`Approved ${done.length} of ${pending.length}. Not approved — ${failed.map(f => `${empMap[f.item.employee_id]?.full_name || 'a claim'} (NPR ${fmt(f.item.total_amount)}): ${f.reason}`).join(' · ')}`)
      },
    })
  }

  async function handleReject() {
    if (!rejectTarget) return
    const c = rejectTarget
    setActionError(null); setBusyId(c.id)
    const { data, error: err } = await scopedUpdate('hr_tada_claims', { status: 'rejected' })
      .eq('id', c.id).eq('status', 'pending').select('id')
    setBusyId(null)
    setRejectTarget(null)
    if (err) { decisionFailed('The claim was not rejected.', err); load(); return }
    if (!data?.length) { await reportMoved(c.id, 'The claim was not rejected.'); return }
    if (selected === c.id) setSelected(null)
    load()
  }

  // A claim already inside a payroll DRAFT would be paid twice if it were paid by hand and that
  // draft were then finalized as generated — so say which draft, and what has to happen next.
  function startMarkPaid(c) {
    const open = () => { setPayMethod('Cash'); setPayTarget(c) }
    const draft = draftByClaim?.[c.id]
    if (!draft) { open(); return }
    const where = draft.label ? `the ${draft.label} payroll draft` : 'a payroll draft'
    askConfirm({
      title: 'Pay this claim by hand?',
      confirmLabel: 'Pay by hand instead',
      body: (
        <p style={{ margin: 0 }}>
          This claim is already in {where}. Paying it by hand takes it out of that payroll —
          regenerate the payroll before finalizing, or the draft still carries NPR {fmt(c.total_amount)} for it.
        </p>
      ),
      run: async () => open(),
    })
  }

  async function handleMarkPaid() {
    if (!payTarget) return
    const c = payTarget
    setActionError(null); setBusyId(c.id)
    // paid_at is stamped by the database (now()) — the browser's clock is not the record.
    const { data, error: err } = await scopedUpdate('hr_tada_claims', { status: 'paid', paid_method: payMethod })
      .eq('id', c.id).eq('status', 'approved').select('id')
    setBusyId(null)
    setPayTarget(null)
    if (err) { decisionFailed('The claim was not marked Paid — it is still owed.', err); load(); return }
    if (!data?.length) { await reportMoved(c.id, 'The claim was not marked Paid.'); return }
    load()
  }

  function handleDelete(c) {
    const emp = empMap[c.employee_id] || {}
    askConfirm({
      title: 'Delete this TADA claim?',
      confirmLabel: 'Delete Claim', danger: true, busyLabel: 'Deleting…',
      body: (
        <p style={{ margin: 0 }}>
          {emp.full_name ? `${emp.full_name}'s` : 'The'} pending claim for NPR {fmt(c.total_amount)}{c.destination ? ` (${c.destination})` : ''} and
          all its expense lines are removed. This cannot be undone.
        </p>
      ),
      run: async () => {
        setActionError(null)
        // Only a pending claim can be deleted (the database refuses any other), and its lines go
        // with it by cascade — the separate lines delete that ran first could strip a claim of its
        // lines and then fail on the claim itself.
        const { data, error: err } = await scopedDelete('hr_tada_claims').eq('id', c.id).eq('status', 'pending').select('id')
        if (err) { decisionFailed('The claim was not deleted.', err); load(); return }
        if (!data?.length) { await reportMoved(c.id, 'The claim was not deleted.'); return }
        if (selected === c.id) setSelected(null)
        load()
      },
    })
  }

  // The decision buttons live on the table row and nowhere else. They were briefly rendered a
  // second time inside the expanded detail too, on the reasoning that someone who opened the
  // detail to read the expense lines shouldn't have to look back up for them — but that reasoning
  // predates the detail moving inline. Now that the panel opens directly beneath its own row, the
  // two sets sit about 60px apart and are visible at once, so the copy was pure duplication, and
  // rendering it one step larger made the pair read as an inconsistency rather than a repeat.
  // Every handler stops propagation: the <tr> toggles the detail, so without it acting on a claim
  // would also collapse the panel underneath.
  function claimActions(c) {
    const act = fn => e => { e.stopPropagation(); fn() }
    const busy = busyId === c.id
    const note = { fontSize: 11, color: 'var(--theme-text3)', padding: '0 8px' }
    if (c.status === 'pending') return (
      <>
        {isOwnClaim(c) ? (
          <Tip text="This is your own claim, so someone else has to decide it — another supervisor, a manager or the Owner.">
            <span style={note}>Your own claim</span>
          </Tip>
        ) : (
          <>
            <DecisionButtons who={`${empMap[c.employee_id]?.full_name || 'this claim'}, NPR ${fmt(c.total_amount)}`} disabled={busy} stopPropagation
              onApprove={() => handleApprove(c)} onReject={() => setRejectTarget(c)} />
          </>
        )}
        <button className="btn btn-danger btn-sm" disabled={busy} onClick={act(() => handleDelete(c))}>Delete</button>
      </>
    )
    if (c.status === 'approved') return canPay ? (
      <Tip text="Paid in cash or bank transfer, outside payroll. Use it only if payroll is not paying this claim — never both.">
        <button className="btn btn-ghost btn-sm" disabled={busy}
          onClick={act(() => startMarkPaid(c))}>
          💵 Mark Paid
        </button>
      </Tip>
    ) : (
      <Tip text="Marking a claim paid by hand needs an HR manager. Otherwise payroll pays it automatically.">
        <span style={note}>Awaiting payment</span>
      </Tip>
    )
    return <span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>—</span>
  }

  // Where an approved claim stands against payroll. Nothing at all when the drafts could not be
  // read — the banner above says why — because "will be paid by the next payroll" over an unread
  // draft is exactly the confident wrong answer that leads to paying a claim twice.
  function payrollStanding(c) {
    if (c.status !== 'approved' || !draftByClaim) return null
    const draft = draftByClaim[c.id]
    if (draft) return (
      <div style={quietNote}>
        <Tip text="That payroll draft already includes this claim on the employee's payslip. It is paid when that payroll is finalized.">
          <span>In the {draft.label ? `${draft.label} ` : ''}payroll draft</span>
        </Tip>
      </div>
    )
    const tripOver = c.end_date && c.end_date <= formatAd(new Date())
    return (
      <div style={quietNote}>
        <Tip text={`Approved claims are paid by the first payroll generated after approval once the trip is over${tripOver ? '' : ` — this trip ends ${fmtD(c.end_date)}`}. The amount is added to the employee's payslip.`}>
          <span>Will be paid by the next payroll</span>
        </Tip>
      </div>
    )
  }

  function renderClaimDetail(c) {
    const emp = empMap[c.employee_id] || {}
    const lines = itemsByClaimId[c.id] || []
    return (
      <div style={{ padding: '16px 18px' }}>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)' }}>
            {emp.full_name} — {c.start_point ? `${c.start_point} → ${c.destination || 'Trip'}` : (c.destination || 'Trip')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 3 }}>
            {fmtD(c.start_date)} → {fmtD(c.end_date)}
            {c.trip_purpose && ` · ${c.trip_purpose}`}
          </div>
          {c.notes && <div style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 4 }}>{c.notes}</div>}
        </div>

        {c.status === 'paid' && (
          <div style={{ fontSize: 12, color: 'var(--theme-green-text)', marginBottom: 12 }}>
            Paid via {c.paid_method} on {fmtTs(c.paid_at)}
          </div>
        )}

        <div className="table-wrap">
          <table className="data-table" style={{ fontSize: 12 }}>
            <thead>
              <tr><th>Category</th><th>Description</th><th style={{ textAlign: 'right' }}>Amount</th></tr>
            </thead>
            <tbody>
              {lines.map(it => (
                <tr key={it.id}>
                  <td>{it.category}</td>
                  <td style={{ color: 'var(--theme-text3)' }}>{it.description || '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-text1)' }}>{fmt(it.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={2}>Total</td>
                <td style={{ textAlign: 'right' }}>{fmt(c.total_amount)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    )
  }


  if (!hasHrAccess('supervisor')) return <Navigate to="/dashboard" replace />
  // No rows and no actions until the rows on screen belong to the client being viewed.
  if (!loadError && loadedFor !== clientId) return <div style={{ padding: 32, color: 'var(--theme-text3)' }}>Loading…</div>

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">TADA Claims</h1>
          <p className="page-subtitle">
            Travel &amp; daily allowance — money staff spent on work trips, e.g. a bus fare to collect supplies, repaid to them
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {canManageSettings && (
            <button className="btn btn-ghost" onClick={() => setShowSettings(true)} title="Vehicle rates & purpose options">
              ⚙ Settings
            </button>
          )}
          {!loadError && (
            <button className="btn btn-primary" onClick={() => { setAddForm(emptyAddForm()); setPurposeMode('preset'); setStartPointMode('preset'); setError(''); setShowAdd(true) }}>
              + New Claim
            </button>
          )}
        </div>
      </div>

      <ActionError error={actionError} />

      {/* A failed read renders nothing below the error (S594): no NPR 0 totals, no "No claims
          found." over a queue that could not be read. */}
      {loadError ? (
        <div>
          <ActionError error={loadError} />
          <button className="btn btn-ghost" onClick={() => load()} disabled={loading}>{loading ? 'Loading…' : 'Try again'}</button>
        </div>
      ) : (
        <>
          {payrollError && (
            <div role="alert" className="card" style={{ ...amberBanner, fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
              <strong style={{ color: 'var(--theme-amber-text)' }}>Couldn’t check payroll.</strong>{' '}
              The payroll drafts could not be read, so approved claims show no payroll status and this page
              cannot tell whether a claim is already in a draft. Reload before marking a claim paid by hand.
              {payrollError.detail && <p className="action-error-detail" style={{ margin: '4px 0 0' }}>{payrollError.detail}</p>}
            </div>
          )}

          {/* Summary cards */}
          <div className="stat-grid">
            {[
              { label: 'Pending Review', value: `NPR ${fmt(pendingTotal)}`, tip: `${pendingCount} claim(s) waiting for a decision, from every month.` },
              { label: 'Approved, Unpaid', value: `NPR ${fmt(approvedTotal)}`, tip: `${approvedCount} approved claim(s) still owed to staff, from every month — paid by the next payroll or by hand.` },
              { label: 'Paid', value: `NPR ${fmt(paidTotal)}`, tip: monthFilter === 'all' ? 'Every claim paid so far, by payroll or by hand.' : 'Claims paid for trips that began in the month selected below.' },
            ].map(c => (
              <div key={c.label} className="card" style={{ padding: '14px 16px' }}>
                <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4 }}><Tip text={c.tip}>{c.label}</Tip></div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>{c.value}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <FilterChips label="Filter claims by status" active={filterStatus} onChange={setFilterStatus} style={{ marginBottom: 0 }}
              options={[
                { key: 'pending', label: `Pending (${pendingCount})` },
                { key: 'approved', label: `Approved (${approvedCount})` },
                { key: 'paid', label: 'Paid' },
                { key: 'rejected', label: 'Rejected' },
                { key: 'all', label: 'All' },
              ]} />
            {monthApplies ? (
              <Tip text="Filters claims by the BS month their trip started. Pick All Months to see full history.">
                <select className="form-select" aria-label="Filter claims by month" value={monthFilter} onChange={e => setMonthFilter(e.target.value)}>
                  <option value="all">All Months</option>
                  {monthOptions.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
              </Tip>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Every open claim, whatever month the trip began</span>
            )}
          </div>

          <BulkApproveBar count={filtered.filter(c => c.status === 'pending' && !isOwnClaim(c)).length} noun="claims"
            detail={`NPR ${fmt(filtered.filter(c => c.status === 'pending' && !isOwnClaim(c)).reduce((s, c) => s + (parseFloat(c.total_amount) || 0), 0))}`}
            onApprove={requestBulkApprove} />
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Employee</th><th>Trip</th><th>Dates (BS)</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th><Tip text="Pending waits for a decision. Approved is owed and not yet paid — the line under it says whether payroll will pay it. Paid is settled, by payroll or by hand.">Status</Tip></th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--theme-text3)', padding: 32 }}>No claims found.</td></tr>
                )}
                {filtered.map(c => {
                  const emp = empMap[c.employee_id] || {}
                  const isSel = selected === c.id
                  return (
                    <Fragment key={c.id}>
                      <tr onClick={() => setSelected(isSel ? null : c.id)}
                        style={{ cursor: 'pointer', background: isSel ? 'color-mix(in srgb, var(--theme-accent) 7%, transparent)' : undefined }}>
                        <td>
                          {/* The row click stays for the mouse; the disclosure button is the keyboard
                              and screen-reader path into the expense lines (S682). */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <RowDisclosure expanded={isSel} onToggle={() => setSelected(isSel ? null : c.id)}
                              label={`${isSel ? 'Hide' : 'Show'} expense lines for ${emp.full_name || 'this claim'}`} />
                            <div>
                              <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{emp.full_name || '—'}</div>
                              {emp.employee_code && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{emp.employee_code}</div>}
                            </div>
                          </div>
                        </td>
                        <td style={{ color: 'var(--theme-text2)', fontSize: 13 }}>
                          {c.start_point ? `${c.start_point} → ${c.destination || '—'}` : (c.destination || '—')}
                          {c.trip_purpose && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{c.trip_purpose}</div>}
                        </td>
                        <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>
                          <span style={{ whiteSpace: 'nowrap' }}>{fmtD(c.start_date)}</span> → <span style={{ whiteSpace: 'nowrap' }}>{fmtD(c.end_date)}</span>
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-text1)' }}>{fmt(c.total_amount)}</td>
                        <td>
                          <span className={STATUS_BADGE[c.status]} style={{ textTransform: 'capitalize' }}>{c.status}</span>
                          {c.status === 'paid' && c.paid_method && <div style={quietNote}>{c.paid_method === 'Payroll' ? 'by payroll' : c.paid_method}</div>}
                          {payrollStanding(c)}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{claimActions(c)}</td>
                      </tr>
                      {isSel && (
                        <tr className="detail-row">
                          <td colSpan={6} style={{ padding: 0 }}>{renderClaimDetail(c)}</td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>

          <p style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 12, lineHeight: 1.6 }}>
            Approved claims are paid automatically by the first payroll after approval once the trip is over —
            the amount is added to that month’s payslip. Mark Paid is for a claim paid in cash or by bank transfer
            instead. Pay a claim by hand or let payroll pay it, never both.
          </p>
        </>
      )}

      {/* New Claim modal */}
      {showAdd && (
        <Modal onClose={() => { setShowAdd(false); setError('') }} title="New TADA Claim" maxWidth={560}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            <div>
              <label style={lbl} htmlFor="tada-employee">Employee</label>
              <SearchableSelect
                id="tada-employee"
                options={employees.filter(e => e.status === 'active' || e.status === 'probation').map(e => ({ value: e.id, label: `${e.full_name}${e.employee_code ? ` (${e.employee_code})` : ''}` }))}
                value={addForm.employee_id} onChange={v => setAdd('employee_id', v)} placeholder="Select employee…"
              />
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={lbl} htmlFor="tada-start-point">Start Point</label>
                <select
                  id="tada-start-point"
                  className="form-select" style={{ width: '100%' }}
                  value={startPointMode === 'custom' ? OTHER_PURPOSE : addForm.start_point}
                  onChange={e => {
                    if (e.target.value === OTHER_PURPOSE) { setStartPointMode('custom'); setAdd('start_point', '') }
                    else { setStartPointMode('preset'); setAdd('start_point', e.target.value) }
                  }}
                >
                  <option value="">Select start point…</option>
                  {startPoints.map(p => <option key={p} value={p}>{p}</option>)}
                  <option value={OTHER_PURPOSE}>Other (type below)</option>
                </select>
                {startPointMode === 'custom' && (
                  <input
                    aria-label="Custom start point"
                    style={{ ...inp, marginTop: 6 }} placeholder="Where did the trip start?"
                    value={addForm.start_point} onChange={e => setAdd('start_point', e.target.value)}
                  />
                )}
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl} htmlFor="tada-purpose">Purpose</label>
                <select
                  id="tada-purpose"
                  className="form-select" style={{ width: '100%' }}
                  value={purposeMode === 'custom' ? OTHER_PURPOSE : addForm.trip_purpose}
                  onChange={e => {
                    if (e.target.value === OTHER_PURPOSE) { setPurposeMode('custom'); setAdd('trip_purpose', '') }
                    else { setPurposeMode('preset'); setAdd('trip_purpose', e.target.value) }
                  }}
                >
                  <option value="">Select purpose…</option>
                  {purposeOptions.map(p => <option key={p} value={p}>{p}</option>)}
                  <option value={OTHER_PURPOSE}>Other (type below)</option>
                </select>
                {purposeMode === 'custom' && (
                  <input
                    aria-label="Custom trip purpose"
                    style={{ ...inp, marginTop: 6 }} placeholder="Describe the purpose"
                    value={addForm.trip_purpose} onChange={e => setAdd('trip_purpose', e.target.value)}
                  />
                )}
              </div>
            </div>

            <div>
              <label style={lbl} htmlFor="tada-destination">Destination</label>
              <input id="tada-destination" style={inp} placeholder="e.g. Pokhara" value={addForm.destination} onChange={e => setAdd('destination', e.target.value)} />
              {addForm.trip_purpose === PURCHASE_PURPOSE && (
                <div style={{ marginTop: 6 }}>
                  <SearchableSelect
                    id="tada-destination-vendor"
                    options={vendors.map(v => ({ value: v.id, label: v.name }))}
                    value="" onChange={vId => { const v = vendors.find(x => x.id === vId); if (v) setAdd('destination', v.name) }}
                    placeholder="🏬 Or pick a registered vendor…"
                  />
                </div>
              )}
            </div>

            <div>
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={lbl} htmlFor="tada-start-date">Start Date (BS)</label>
                  <BsCalendarPicker id="tada-start-date" value={addForm.start_date} onChange={v => setAdd('start_date', v)} placeholder="Select date" clearable />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={lbl} htmlFor="tada-end-date">End Date (BS)</label>
                  <BsCalendarPicker id="tada-end-date" value={addForm.end_date} onChange={v => setAdd('end_date', v)} placeholder="Select date" clearable invalid={endDateMsg} />
                </div>
              </div>
              <FieldError id="tada-end-date" message={endDateMsg} />
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                {/* A group heading over the repeating expense rows, not a control label — a bare
                    <label> here would name nothing, so it's a span. Each row's own controls carry
                    their own aria-label instead. */}
                <span style={{ ...lbl, marginBottom: 0 }}>Expenses</span>
                <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px' }} onClick={addItemRow}>+ Add line</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {addForm.items.map((it, idx) => (
                  <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <select aria-label={`Expense ${idx + 1} category`} className="form-select" style={{ width: 140, flexShrink: 0 }} value={it.category} onChange={e => setItem(idx, 'category', e.target.value)}>
                        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <input aria-label={`Expense ${idx + 1} description`} style={inp} placeholder="Description (optional)" value={it.description} onChange={e => setItem(idx, 'description', e.target.value)} />
                      {/* A negative is simply not taken (S751) — it used to shrink the Total shown
                          here while the save dropped the line, so the two disagreed. */}
                      <input aria-label={`Expense ${idx + 1} amount (NPR)`} style={{ ...inp, width: 110, flexShrink: 0 }} type="number" min="0" placeholder="Amount" value={it.amount}
                        onChange={e => { if (acceptTadaAmount(e.target.value)) setItem(idx, 'amount', e.target.value) }} />
                      {addForm.items.length > 1 && (
                        <button aria-label={`Remove expense line ${idx + 1}`} style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 16, flexShrink: 0 }} onClick={() => removeItemRow(idx)}>✕</button>
                      )}
                    </div>
                    {it.category === 'Transport' && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingLeft: 2 }}>
                        <span style={{ fontSize: 12, flexShrink: 0 }}>🧮</span>
                        <select
                          aria-label={`Expense ${idx + 1} vehicle type`}
                          className="form-select" style={{ width: 110, flexShrink: 0, fontSize: 12 }}
                          value={it.vehicle} onChange={e => setItemVehicle(idx, e.target.value)}
                        >
                          {VEHICLE_TYPES.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
                        </select>
                        <input
                          aria-label={`Expense ${idx + 1} distance in km`}
                          style={{ ...inp, width: 100, flexShrink: 0 }} type="number" min="0" step="0.1"
                          placeholder="Distance (km)" value={it.distanceKm} onChange={e => setItemDistance(idx, e.target.value)}
                        />
                        {vehicleRates[it.vehicle] == null ? (
                          <span style={{ fontSize: 11, color: 'var(--theme-amber-text)' }}>No rate set — ask an owner/admin, or enter Amount manually</span>
                        ) : (
                          <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>× NPR {vehicleRates[it.vehicle]}/km → Amount</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ textAlign: 'right', marginTop: 8, fontSize: 13, fontWeight: 700, color: 'var(--theme-accent-ink)' }}>
                Total: NPR {fmt(addTotal)}
              </div>
            </div>

            <div>
              <label style={lbl} htmlFor="tada-notes">Notes</label>
              <textarea id="tada-notes" style={{ ...inp, height: 50, resize: 'vertical' }} placeholder="Optional" value={addForm.notes} onChange={e => setAdd('notes', e.target.value)} />
            </div>

            {lookAlike && (
              <div role="status" className="card" style={{ ...amberBanner, marginBottom: 0, fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
                <strong style={{ color: 'var(--theme-amber-text)' }}>
                  This looks like a duplicate of a claim from {fmtTs(lookAlike.created_at)}
                </strong>{' '}
                — same employee, same dates, same total, and it is {TADA_REQUEST_STATUS[lookAlike.status]?.label || lookAlike.status}.
                Check it before submitting; if it really is a second trip, submit anyway.
              </div>
            )}

            <ActionError error={error} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => { setShowAdd(false); setError('') }}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAdd} disabled={saving}>{saving ? 'Submitting…' : 'Submit Claim'}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Mark Paid modal */}
      {payTarget && (
        <Modal onClose={() => setPayTarget(null)} title="Mark Paid" maxWidth={380}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>
              {empMap[payTarget.employee_id]?.full_name} · NPR {fmt(payTarget.total_amount)} — paid in cash or bank transfer, outside payroll.
            </p>
            {!draftByClaim && (
              <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--theme-amber-text)' }}>
                Payroll drafts could not be checked. If this claim is already in one, regenerate that payroll before finalizing it.
              </p>
            )}
            <div>
              <label style={lbl} htmlFor="tada-pay-method">Payment Method</label>
              <select id="tada-pay-method" className="form-select" value={payMethod} onChange={e => setPayMethod(e.target.value)}>
                {PAID_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setPayTarget(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleMarkPaid} disabled={busyId === payTarget.id}>Confirm</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Reject confirmation */}
      {rejectTarget && (
        <Modal onClose={() => setRejectTarget(null)} title="Reject this claim?" maxWidth={360}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
              {empMap[rejectTarget.employee_id]?.full_name} · NPR {fmt(rejectTarget.total_amount)} — it will not be paid, by payroll or by hand.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setRejectTarget(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleReject} disabled={busyId === rejectTarget.id}>Reject</button>
            </div>
          </div>
        </Modal>
      )}

      {showSettings && canManageSettings && (
        <TadaSettingsModal
          clientId={clientId}
          vehicleRates={vehicleRates}
          purposeOptions={purposeOptions}
          startPoints={startPoints}
          onSaved={handleSettingsSaved}
          onClose={() => setShowSettings(false)}
        />
      )}
      {confirmEl}
    </div>
  )
}
