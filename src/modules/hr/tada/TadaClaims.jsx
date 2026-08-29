import { Fragment, useState, useEffect, useCallback, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import Modal from '../../../components/Modal'
import SearchableSelect from '../../../components/SearchableSelect'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import TadaSettingsModal from './TadaSettingsModal'
import { adToBs, formatAd, BS_MONTHS } from '../../../utils/bsCalendar'
import { CATEGORIES, VEHICLE_TYPES, DEFAULT_PURPOSE_OPTIONS, DEFAULT_START_POINTS, OTHER_PURPOSE, PURCHASE_PURPOSE, EMPTY_TADA_ITEM, recomputeTadaAmount } from './tadaShared'

const fmt  = n => Math.round(n || 0).toLocaleString('en-NP')
const fmtD = iso => {
  if (!iso) return '—'
  const bs = adToBs(new Date(iso + 'T00:00:00'))
  return `${bs.year}-${String(bs.month).padStart(2, '0')}-${String(bs.day).padStart(2, '0')}`
}
const inp = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  borderRadius: 6, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)',
  outline: 'none', width: '100%', fontFamily: 'inherit',
}
const lbl = { fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4, display: 'block' }

// Status ladder, not categorical tags: pending = awaiting a decision (neutral), approved =
// in progress, money owed but not yet disbursed (amber, the real caution colour), rejected,
// paid. `badge-yellow` is the accent-tinted CATEGORICAL tag (see Advances' Advance/Loan type
// column) and deliberately isn't used for any of these.
const STATUS_BADGE = { pending: 'badge-gray', approved: 'badge-amber', rejected: 'badge-red', paid: 'badge-green' }
function emptyAddForm() {
  const today = formatAd(new Date())
  return {
    employee_id: '', trip_purpose: '', destination: '', start_point: '', start_date: today, end_date: today, notes: '',
    items: [EMPTY_TADA_ITEM()],
  }
}
const PAID_METHODS = ['Cash', 'Bank Transfer', 'Cheque']

export default function TadaClaims() {
  const { clientId, profile, isAdmin, isOwner, hasHrAccess } = useAuth()
  const canManageSettings = isAdmin || isOwner || hasHrAccess('manager')
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()

  const [employees, setEmployees] = useState([])
  const [vendors,   setVendors]   = useState([])
  const [claims,    setClaims]    = useState([])
  const [items,     setItems]     = useState([])
  const [loading,   setLoading]   = useState(true)

  const [filterStatus, setFilterStatus] = useState('pending') // pending | approved | rejected | paid | all
  // hr_tada_claims has no bs_year/bs_month of its own — it's a standalone ledger of plain AD
  // start_date/end_date, deliberately not plumbed through monthly_periods. Month filter buckets
  // by start_date's BS month client-side instead. 'all' shows full history same as before.
  const [periods,        setPeriods]        = useState([])
  const [monthFilter,    setMonthFilter]    = useState('all') // 'all' | `${bsYear}-${bsMonth}`
  const [selected,     setSelected]     = useState(null)
  const [showAdd,      setShowAdd]      = useState(false)
  const [addForm,      setAddForm]      = useState(emptyAddForm)
  const [purposeMode,    setPurposeMode]    = useState('preset') // 'preset' | 'custom' — UI-only, doesn't affect what's submitted
  const [startPointMode, setStartPointMode] = useState('preset') // 'preset' | 'custom'
  const [saving,       setSaving]       = useState(false)
  const [error,        setError]        = useState('')
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

  const load = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    const [{ data: emps }, { data: vends }, { data: cls }, { data: settingsRow }, { data: pers }] = await Promise.all([
      scopedFrom('hr_employees', 'id, full_name, employee_code, status').order('full_name'),
      scopedFrom('vendors', 'id, name').eq('is_active', true).order('name'),
      scopedFrom('hr_tada_claims').order('created_at', { ascending: false }),
      // settings has a nullable client_id (no free-default tier for it, unlike most tables) —
      // stays on raw supabase.from() rather than scopedDb, same as every other settings read.
      supabase.from('settings').select('tada_vehicle_rates, tada_purpose_options, tada_start_points').eq('client_id', clientId).maybeSingle(),
      scopedFrom('monthly_periods', 'id, bs_year, bs_month, status').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
    ])
    setEmployees(emps || [])
    setVendors(vends || [])
    setClaims(cls || [])
    setPeriods(pers || [])
    setMonthFilter(prev => {
      if (prev !== 'all') return prev
      const open = (pers || []).find(p => p.status === 'open') || (pers || [])[0]
      return open ? `${open.bs_year}-${open.bs_month}` : 'all'
    })
    setVehicleRates({ '2w': null, '4w': null, ev: null, ...(settingsRow?.tada_vehicle_rates || {}) })
    setPurposeOptions(settingsRow?.tada_purpose_options?.length ? settingsRow.tada_purpose_options : DEFAULT_PURPOSE_OPTIONS)
    setStartPoints(settingsRow?.tada_start_points?.length ? settingsRow.tada_start_points : DEFAULT_START_POINTS)
    const claimIds = (cls || []).map(c => c.id)
    if (claimIds.length > 0) {
      // hr_tada_claim_items has no client_id column of its own — scoped via claim_id against
      // this client's already-scoped claim ids, same parent-scoped pattern as recipe_ingredients.
      const { data: its } = await supabase.from('hr_tada_claim_items').select('*').in('claim_id', claimIds)
      setItems(its || [])
    } else {
      setItems([])
    }
    setLoading(false)
  }, [clientId, scopedFrom])

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

  // Buckets each claim by its start_date's BS month — hr_tada_claims carries no bs_year/bs_month
  // column of its own to filter on directly.
  const monthClaims = useMemo(() => monthFilter === 'all' ? claims : claims.filter(c => {
    if (!c.start_date) return false
    const bs = adToBs(new Date(c.start_date + 'T00:00:00'))
    return `${bs.year}-${bs.month}` === monthFilter
  }), [claims, monthFilter])

  const filtered = useMemo(
    () => filterStatus === 'all' ? monthClaims : monthClaims.filter(c => c.status === filterStatus),
    [monthClaims, filterStatus])

  // One pass for all four figures. `pending` was scanned twice on its own — once for the count and
  // once for the total.
  const { pendingCount, pendingTotal, approvedTotal, paidThisYear } = useMemo(() => {
    let pendingCount = 0, pendingTotal = 0, approvedTotal = 0, paidThisYear = 0
    for (const c of monthClaims) {
      const amt = parseFloat(c.total_amount) || 0
      if (c.status === 'pending')       { pendingCount++; pendingTotal += amt }
      else if (c.status === 'approved') approvedTotal += amt
      else if (c.status === 'paid')     paidThisYear += amt
    }
    return { pendingCount, pendingTotal, approvedTotal, paidThisYear }
  }, [monthClaims])

  function setAdd(f, v) { setAddForm(p => ({ ...p, [f]: v })) }
  function setItem(idx, f, v) {
    setAddForm(p => ({ ...p, items: p.items.map((it, i) => i === idx ? { ...it, [f]: v } : it) }))
  }
  function addItemRow() { setAddForm(p => ({ ...p, items: [...p.items, EMPTY_TADA_ITEM()] })) }
  function removeItemRow(idx) { setAddForm(p => ({ ...p, items: p.items.filter((_, i) => i !== idx) })) }
  const addTotal = addForm.items.reduce((s, it) => s + (parseFloat(it.amount) || 0), 0)

  async function handleAdd() {
    if (!clientId) return
    if (!addForm.employee_id) { setError('Select an employee.'); return }
    if (!addForm.start_date || !addForm.end_date) { setError('Set the trip dates.'); return }
    const validItems = addForm.items.filter(it => parseFloat(it.amount) > 0)
    if (validItems.length === 0) { setError('Add at least one expense line with an amount.'); return }
    setError(''); setSaving(true)

    const { data: claim, error: err } = await scopedInsert('hr_tada_claims', {
      employee_id:   addForm.employee_id,
      trip_purpose:  addForm.trip_purpose || null,
      destination:   addForm.destination || null,
      start_point:   addForm.start_point || null,
      start_date:    addForm.start_date,
      end_date:      addForm.end_date,
      total_amount:  addTotal,
      status:        'pending',
      submitted_by:  profile?.id || null,
      notes:         addForm.notes || null,
    }, { single: true })
    if (err) { setError(err.message); setSaving(false); return }

    const { error: itemErr } = await supabase.from('hr_tada_claim_items').insert(validItems.map(it => ({
      claim_id: claim.id, category: it.category, description: it.description || null, amount: parseFloat(it.amount),
    })))
    setSaving(false)
    if (itemErr) { setError(itemErr.message); return }
    setShowAdd(false); setAddForm(emptyAddForm()); setPurposeMode('preset'); setStartPointMode('preset'); load()
  }

  async function handleApprove(claimId) {
    await scopedUpdate('hr_tada_claims', {
      status: 'approved', approved_by: profile?.id || null, approved_at: new Date().toISOString(),
    }).eq('id', claimId)
    load()
  }

  async function handleReject() {
    if (!rejectTarget) return
    await scopedUpdate('hr_tada_claims', { status: 'rejected' }).eq('id', rejectTarget.id)
    setRejectTarget(null)
    if (selected === rejectTarget.id) setSelected(null)
    load()
  }

  async function handleMarkPaid() {
    if (!payTarget) return
    await scopedUpdate('hr_tada_claims', {
      status: 'paid', paid_at: new Date().toISOString(), paid_method: payMethod,
    }).eq('id', payTarget.id)
    setPayTarget(null)
    load()
  }

  async function handleDelete(claimId) {
    if (!window.confirm('Delete this TADA claim? This cannot be undone.')) return
    await supabase.from('hr_tada_claim_items').delete().eq('claim_id', claimId)
    await scopedDelete('hr_tada_claims').eq('id', claimId)
    if (selected === claimId) setSelected(null)
    load()
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
    if (c.status === 'pending') return (
      <>
        <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-green-text)' }} onClick={act(() => handleApprove(c.id))}>✓ Approve</button>
        <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red-text)' }} onClick={act(() => setRejectTarget(c))}>✕ Reject</button>
        <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red-text)' }} onClick={act(() => handleDelete(c.id))}>Delete</button>
      </>
    )
    if (c.status === 'approved') return (
      <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-green-text)' }}
        onClick={act(() => { setPayMethod('Cash'); setPayTarget(c) })}>
        💵 Mark Paid
      </button>
    )
    return <span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>—</span>
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
            Paid via {c.paid_method} on {fmtD(c.paid_at?.slice(0, 10))}
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

  const tabBtn = (val, cur, set, label) => (
    <button className={`tab-btn${cur === val ? ' tab-btn--active' : ''}`} onClick={() => set(val)}>{label}</button>
  )

  if (loading) return <div style={{ padding: 32, color: 'var(--theme-text3)' }}>Loading…</div>
  if (!hasHrAccess('supervisor')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">TADA Claims</h1>
          <p className="page-subtitle">Travel &amp; Daily Allowance expense reimbursement</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {canManageSettings && (
            <button className="btn btn-ghost" onClick={() => setShowSettings(true)} title="Vehicle rates & purpose options">
              ⚙ Settings
            </button>
          )}
          <button className="btn btn-primary" onClick={() => { setAddForm(emptyAddForm()); setPurposeMode('preset'); setStartPointMode('preset'); setError(''); setShowAdd(true) }}>
            + New Claim
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        {[
          { label: 'Pending Review', value: `NPR ${fmt(pendingTotal)}`, tip: `${pendingCount} claim(s) awaiting approval, for the month selected below.` },
          { label: 'Approved, Unpaid', value: `NPR ${fmt(approvedTotal)}`, tip: 'Approved claims not yet marked paid, for the month selected below.' },
          { label: 'Paid', value: `NPR ${fmt(paidThisYear)}`, tip: 'Total of claims marked paid, for the month selected below.' },
        ].map(c => (
          <div key={c.label} className="card" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4 }}><Tip text={c.tip}>{c.label}</Tip></div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>{c.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="tab-bar" style={{ marginBottom: 0 }}>
          {tabBtn('pending',  filterStatus, setFilterStatus, 'Pending')}
          {tabBtn('approved', filterStatus, setFilterStatus, 'Approved')}
          {tabBtn('paid',     filterStatus, setFilterStatus, 'Paid')}
          {tabBtn('rejected', filterStatus, setFilterStatus, 'Rejected')}
          {tabBtn('all',      filterStatus, setFilterStatus, 'All')}
        </div>
        <Tip text="Filters claims by the BS month of their trip start date. Pick All Months to see full history.">
          <select className="form-select" aria-label="Filter claims by month" value={monthFilter} onChange={e => setMonthFilter(e.target.value)}>
            <option value="all">All Months</option>
            {periods.map(p => (
              <option key={p.id} value={`${p.bs_year}-${p.bs_month}`}>
                {BS_MONTHS[p.bs_month - 1]} {p.bs_year}{p.status === 'open' ? ' (open)' : ''}
              </option>
            ))}
          </select>
        </Tip>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Employee</th><th>Trip</th><th>Dates (BS)</th>
              <th style={{ textAlign: 'right' }}>Total</th><th>Status</th>
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
                      <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{emp.full_name || '—'}</div>
                      {emp.employee_code && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{emp.employee_code}</div>}
                    </td>
                    <td style={{ color: 'var(--theme-text2)', fontSize: 13 }}>
                      {c.start_point ? `${c.start_point} → ${c.destination || '—'}` : (c.destination || '—')}
                      {c.trip_purpose && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{c.trip_purpose}</div>}
                    </td>
                    <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{fmtD(c.start_date)} → {fmtD(c.end_date)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-text1)' }}>{fmt(c.total_amount)}</td>
                    <td><span className={STATUS_BADGE[c.status]} style={{ textTransform: 'capitalize' }}>{c.status}</span></td>
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

            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={lbl} htmlFor="tada-start-date">Start Date (BS)</label>
                <BsCalendarPicker id="tada-start-date" value={addForm.start_date} onChange={v => setAdd('start_date', v)} placeholder="Select date" clearable />
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl} htmlFor="tada-end-date">End Date (BS)</label>
                <BsCalendarPicker id="tada-end-date" value={addForm.end_date} onChange={v => setAdd('end_date', v)} placeholder="Select date" clearable />
              </div>
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
                      <input aria-label={`Expense ${idx + 1} amount (NPR)`} style={{ ...inp, width: 110, flexShrink: 0 }} type="number" min="0" placeholder="Amount" value={it.amount} onChange={e => setItem(idx, 'amount', e.target.value)} />
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

            {error && <div role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)' }}>{error}</div>}
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
              {empMap[payTarget.employee_id]?.full_name} · NPR {fmt(payTarget.total_amount)}
            </p>
            <div>
              <label style={lbl} htmlFor="tada-pay-method">Payment Method</label>
              <select id="tada-pay-method" className="form-select" value={payMethod} onChange={e => setPayMethod(e.target.value)}>
                {PAID_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setPayTarget(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleMarkPaid}>Confirm</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Reject confirmation */}
      {rejectTarget && (
        <Modal onClose={() => setRejectTarget(null)} title="Reject this claim?" maxWidth={360}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
              {empMap[rejectTarget.employee_id]?.full_name} · NPR {fmt(rejectTarget.total_amount)}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setRejectTarget(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleReject}>Reject</button>
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
    </div>
  )
}
