import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import SearchableSelect from '../../../components/SearchableSelect'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import TadaSettingsModal from './TadaSettingsModal'
import { adToBs, formatAd } from '../../../utils/bsCalendar'

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

const CATEGORIES = ['Transport', 'Lodging', 'Daily Allowance', 'Other']
const VEHICLE_TYPES = [
  { key: '2w', label: '2-Wheeler' },
  { key: '4w', label: '4-Wheeler' },
  { key: 'ev', label: 'EV' },
]
const STATUS_BADGE = { pending: 'badge-amber', approved: 'badge-yellow', rejected: 'badge-red', paid: 'badge-green' }
// vehicle/distanceKm are UI-only — they drive the auto-computed Amount but are never sent to
// hr_tada_claim_items (which only has category/description/amount; see handleAdd's insert).
const EMPTY_ITEM = () => ({ category: 'Transport', description: '', amount: '', vehicle: '2w', distanceKm: '' })
const DEFAULT_PURPOSE_OPTIONS = ['Vendor site visit', 'Purchase', 'Bank errand', 'Client meeting', 'Delivery', 'Site inspection', 'Training / Conference']
const OTHER_PURPOSE = '__other__'
function emptyAddForm() {
  const today = formatAd(new Date())
  return {
    employee_id: '', trip_purpose: '', destination: '', start_date: today, end_date: today, notes: '',
    items: [EMPTY_ITEM()],
  }
}
const PAID_METHODS = ['Cash', 'Bank Transfer', 'Cheque']

export default function TadaClaims() {
  const { clientId, profile, isAdmin, isOwner } = useAuth()
  const canManageSettings = isAdmin || isOwner
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()

  const [employees, setEmployees] = useState([])
  const [claims,    setClaims]    = useState([])
  const [items,     setItems]     = useState([])
  const [loading,   setLoading]   = useState(true)

  const [filterStatus, setFilterStatus] = useState('pending') // pending | approved | rejected | paid | all
  const [selected,     setSelected]     = useState(null)
  const [showAdd,      setShowAdd]      = useState(false)
  const [addForm,      setAddForm]      = useState(emptyAddForm)
  const [purposeMode,  setPurposeMode]  = useState('preset') // 'preset' | 'custom' — UI-only, doesn't affect what's submitted
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
  const [showSettings,   setShowSettings]   = useState(false)

  const load = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    const [{ data: emps }, { data: cls }, { data: settingsRow }] = await Promise.all([
      scopedFrom('hr_employees', 'id, full_name, employee_code, status').order('full_name'),
      scopedFrom('hr_tada_claims').order('created_at', { ascending: false }),
      // settings has a nullable client_id (no free-default tier for it, unlike most tables) —
      // stays on raw supabase.from() rather than scopedDb, same as every other settings read.
      supabase.from('settings').select('tada_vehicle_rates, tada_purpose_options').eq('client_id', clientId).maybeSingle(),
    ])
    setEmployees(emps || [])
    setClaims(cls || [])
    setVehicleRates({ '2w': null, '4w': null, ev: null, ...(settingsRow?.tada_vehicle_rates || {}) })
    setPurposeOptions(settingsRow?.tada_purpose_options?.length ? settingsRow.tada_purpose_options : DEFAULT_PURPOSE_OPTIONS)
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

  function handleSettingsSaved(nextRates, nextOptions) {
    setVehicleRates(nextRates)
    setPurposeOptions(nextOptions)
    setShowSettings(false)
  }

  // Live-recompute Amount whenever Distance or Vehicle changes on a Transport line — only
  // overwrites Amount when both a distance and a configured rate exist, so it never clobbers a
  // manually-typed Amount just because the rate isn't set up yet for that vehicle.
  function recomputeAmount(it, distanceKm, vehicle) {
    const dist = parseFloat(distanceKm) || 0
    const rate = vehicleRates[vehicle]
    return (dist > 0 && rate != null) ? String(Math.round(dist * rate)) : it.amount
  }
  function setItemDistance(idx, v) {
    setAddForm(p => ({
      ...p,
      items: p.items.map((it, i) => i === idx ? { ...it, distanceKm: v, amount: recomputeAmount(it, v, it.vehicle) } : it),
    }))
  }
  function setItemVehicle(idx, v) {
    setAddForm(p => ({
      ...p,
      items: p.items.map((it, i) => i === idx ? { ...it, vehicle: v, amount: recomputeAmount(it, it.distanceKm, v) } : it),
    }))
  }

  const empMap = Object.fromEntries(employees.map(e => [e.id, e]))
  const itemsByClaimId = {}
  items.forEach(i => { (itemsByClaimId[i.claim_id] = itemsByClaimId[i.claim_id] || []).push(i) })

  const filtered = filterStatus === 'all' ? claims : claims.filter(c => c.status === filterStatus)

  const pendingCount  = claims.filter(c => c.status === 'pending').length
  const pendingTotal  = claims.filter(c => c.status === 'pending').reduce((s, c) => s + parseFloat(c.total_amount), 0)
  const approvedTotal = claims.filter(c => c.status === 'approved').reduce((s, c) => s + parseFloat(c.total_amount), 0)
  const paidThisYear  = claims.filter(c => c.status === 'paid').reduce((s, c) => s + parseFloat(c.total_amount), 0)

  function setAdd(f, v) { setAddForm(p => ({ ...p, [f]: v })) }
  function setItem(idx, f, v) {
    setAddForm(p => ({ ...p, items: p.items.map((it, i) => i === idx ? { ...it, [f]: v } : it) }))
  }
  function addItemRow() { setAddForm(p => ({ ...p, items: [...p.items, EMPTY_ITEM()] })) }
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
    setShowAdd(false); setAddForm(emptyAddForm()); setPurposeMode('preset'); load()
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
    await supabase.from('hr_tada_claim_items').delete().eq('claim_id', claimId)
    await scopedDelete('hr_tada_claims').eq('id', claimId)
    if (selected === claimId) setSelected(null)
    load()
  }

  const selectedClaim = selected ? claims.find(c => c.id === selected) : null
  const selectedItems = selected ? (itemsByClaimId[selected] || []) : []

  const tabBtn = (val, cur, set, label) => (
    <button className={`tab-btn${cur === val ? ' tab-btn--active' : ''}`} onClick={() => set(val)}>{label}</button>
  )

  if (loading) return <div style={{ padding: 32, color: 'var(--theme-text3)' }}>Loading…</div>

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--theme-text1)' }}>TADA Claims</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--theme-text3)' }}>Travel &amp; Daily Allowance expense reimbursement</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {canManageSettings && (
            <button className="btn btn-ghost" onClick={() => setShowSettings(true)} title="Vehicle rates & purpose options">
              ⚙ Settings
            </button>
          )}
          <button className="btn btn-primary" onClick={() => { setAddForm(emptyAddForm()); setPurposeMode('preset'); setError(''); setShowAdd(true) }}>
            + New Claim
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        {[
          { label: 'Pending Review', value: `NPR ${fmt(pendingTotal)}`, tip: `${pendingCount} claim(s) awaiting approval.` },
          { label: 'Approved, Unpaid', value: `NPR ${fmt(approvedTotal)}`, tip: 'Approved claims not yet marked paid.' },
          { label: 'Paid', value: `NPR ${fmt(paidThisYear)}`, tip: 'Total of all claims marked paid.' },
        ].map(c => (
          <div key={c.label} className="card" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4 }}><Tip text={c.tip}>{c.label}</Tip></div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>{c.value}</div>
          </div>
        ))}
      </div>

      <div className="tab-bar" style={{ marginBottom: 16 }}>
        {tabBtn('pending',  filterStatus, setFilterStatus, 'Pending')}
        {tabBtn('approved', filterStatus, setFilterStatus, 'Approved')}
        {tabBtn('paid',     filterStatus, setFilterStatus, 'Paid')}
        {tabBtn('rejected', filterStatus, setFilterStatus, 'Rejected')}
        {tabBtn('all',      filterStatus, setFilterStatus, 'All')}
      </div>

      <div className="table-wrap" style={{ marginBottom: selected ? 12 : 0 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Employee</th><th>Trip</th><th>Dates (BS)</th>
              <th style={{ textAlign: 'right' }}>Total</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--theme-text3)', padding: 32 }}>No claims found.</td></tr>
            )}
            {filtered.map(c => {
              const emp = empMap[c.employee_id] || {}
              const isSel = selected === c.id
              return (
                <tr key={c.id} onClick={() => setSelected(isSel ? null : c.id)}
                  style={{ cursor: 'pointer', background: isSel ? 'rgba(201,168,76,0.07)' : undefined }}>
                  <td>
                    <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{emp.full_name || '—'}</div>
                    {emp.employee_code && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{emp.employee_code}</div>}
                  </td>
                  <td style={{ color: 'var(--theme-text2)', fontSize: 13 }}>
                    {c.destination || '—'}
                    {c.trip_purpose && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{c.trip_purpose}</div>}
                  </td>
                  <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{fmtD(c.start_date)} → {fmtD(c.end_date)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-text1)' }}>{fmt(c.total_amount)}</td>
                  <td><span className={STATUS_BADGE[c.status]} style={{ textTransform: 'capitalize' }}>{c.status}</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Detail panel */}
      {selectedClaim && (
        <div className="card" style={{ padding: 20, marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)' }}>
                {empMap[selectedClaim.employee_id]?.full_name} — {selectedClaim.destination || 'Trip'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 3 }}>
                {fmtD(selectedClaim.start_date)} → {fmtD(selectedClaim.end_date)}
                {selectedClaim.trip_purpose && ` · ${selectedClaim.trip_purpose}`}
              </div>
              {selectedClaim.notes && <div style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 4 }}>{selectedClaim.notes}</div>}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {selectedClaim.status === 'pending' && (
                <>
                  <button className="btn btn-ghost" style={{ fontSize: 12, color: '#34d399' }} onClick={() => handleApprove(selectedClaim.id)}>✓ Approve</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12, color: '#f87171' }} onClick={() => setRejectTarget(selectedClaim)}>✕ Reject</button>
                </>
              )}
              {selectedClaim.status === 'approved' && (
                <button className="btn btn-ghost" style={{ fontSize: 12, color: '#34d399' }}
                  onClick={() => { setPayMethod('Cash'); setPayTarget(selectedClaim) }}>
                  💵 Mark Paid
                </button>
              )}
              {selectedClaim.status === 'pending' && (
                <button className="btn btn-ghost" style={{ fontSize: 12, color: '#f87171' }} onClick={() => handleDelete(selectedClaim.id)}>Delete</button>
              )}
            </div>
          </div>

          {selectedClaim.status === 'paid' && (
            <div style={{ fontSize: 12, color: '#34d399', marginBottom: 12 }}>
              Paid via {selectedClaim.paid_method} on {fmtD(selectedClaim.paid_at?.slice(0, 10))}
            </div>
          )}

          <table className="data-table" style={{ fontSize: 12 }}>
            <thead>
              <tr><th>Category</th><th>Description</th><th style={{ textAlign: 'right' }}>Amount</th></tr>
            </thead>
            <tbody>
              {selectedItems.map(it => (
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
                <td style={{ textAlign: 'right' }}>{fmt(selectedClaim.total_amount)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* New Claim modal */}
      {showAdd && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div className="card" style={{ width: 560, maxHeight: '85vh', overflowY: 'auto', padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <h3 style={{ margin: 0, fontSize: 16, color: 'var(--theme-text1)' }}>New TADA Claim</h3>

            <div>
              <label style={lbl}>Employee</label>
              <SearchableSelect
                options={employees.filter(e => e.status === 'active' || e.status === 'probation').map(e => ({ value: e.id, label: `${e.full_name}${e.employee_code ? ` (${e.employee_code})` : ''}` }))}
                value={addForm.employee_id} onChange={v => setAdd('employee_id', v)} placeholder="Select employee…"
              />
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Destination</label>
                <input style={inp} placeholder="e.g. Pokhara" value={addForm.destination} onChange={e => setAdd('destination', e.target.value)} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Purpose</label>
                <select
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
                    style={{ ...inp, marginTop: 6 }} placeholder="Describe the purpose"
                    value={addForm.trip_purpose} onChange={e => setAdd('trip_purpose', e.target.value)}
                  />
                )}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Start Date (BS)</label>
                <BsCalendarPicker value={addForm.start_date} onChange={v => setAdd('start_date', v)} placeholder="Select date" clearable />
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>End Date (BS)</label>
                <BsCalendarPicker value={addForm.end_date} onChange={v => setAdd('end_date', v)} placeholder="Select date" clearable />
              </div>
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label style={{ ...lbl, marginBottom: 0 }}>Expenses</label>
                <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px' }} onClick={addItemRow}>+ Add line</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {addForm.items.map((it, idx) => (
                  <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <select className="form-select" style={{ width: 140, flexShrink: 0 }} value={it.category} onChange={e => setItem(idx, 'category', e.target.value)}>
                        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <input style={inp} placeholder="Description (optional)" value={it.description} onChange={e => setItem(idx, 'description', e.target.value)} />
                      <input style={{ ...inp, width: 110, flexShrink: 0 }} type="number" min="0" placeholder="Amount" value={it.amount} onChange={e => setItem(idx, 'amount', e.target.value)} />
                      {addForm.items.length > 1 && (
                        <button style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 16, flexShrink: 0 }} onClick={() => removeItemRow(idx)}>✕</button>
                      )}
                    </div>
                    {it.category === 'Transport' && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingLeft: 2 }}>
                        <span style={{ fontSize: 12, flexShrink: 0 }}>🧮</span>
                        <select
                          className="form-select" style={{ width: 110, flexShrink: 0, fontSize: 12 }}
                          value={it.vehicle} onChange={e => setItemVehicle(idx, e.target.value)}
                        >
                          {VEHICLE_TYPES.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
                        </select>
                        <input
                          style={{ ...inp, width: 100, flexShrink: 0 }} type="number" min="0" step="0.1"
                          placeholder="Distance (km)" value={it.distanceKm} onChange={e => setItemDistance(idx, e.target.value)}
                        />
                        {vehicleRates[it.vehicle] == null ? (
                          <span style={{ fontSize: 11, color: 'var(--theme-amber)' }}>No rate set — ask an owner/admin, or enter Amount manually</span>
                        ) : (
                          <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>× NPR {vehicleRates[it.vehicle]}/km → Amount</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ textAlign: 'right', marginTop: 8, fontSize: 13, fontWeight: 700, color: 'var(--theme-accent)' }}>
                Total: NPR {fmt(addTotal)}
              </div>
            </div>

            <div>
              <label style={lbl}>Notes</label>
              <textarea style={{ ...inp, height: 50, resize: 'vertical' }} placeholder="Optional" value={addForm.notes} onChange={e => setAdd('notes', e.target.value)} />
            </div>

            {error && <div style={{ fontSize: 12, color: '#f87171' }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => { setShowAdd(false); setError('') }}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAdd} disabled={saving}>{saving ? 'Submitting…' : 'Submit Claim'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Mark Paid modal */}
      {payTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="card" style={{ width: 380, padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <h3 style={{ margin: 0, fontSize: 16, color: 'var(--theme-text1)' }}>Mark Paid</h3>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>
              {empMap[payTarget.employee_id]?.full_name} · NPR {fmt(payTarget.total_amount)}
            </p>
            <div>
              <label style={lbl}>Payment Method</label>
              <select className="form-select" value={payMethod} onChange={e => setPayMethod(e.target.value)}>
                {PAID_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setPayTarget(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleMarkPaid}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      {/* Reject confirmation */}
      {rejectTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="card" style={{ width: 360, padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <h3 style={{ margin: 0, fontSize: 16, color: 'var(--theme-text1)' }}>Reject this claim?</h3>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
              {empMap[rejectTarget.employee_id]?.full_name} · NPR {fmt(rejectTarget.total_amount)}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setRejectTarget(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleReject}>Reject</button>
            </div>
          </div>
        </div>
      )}

      {showSettings && canManageSettings && (
        <TadaSettingsModal
          clientId={clientId}
          vehicleRates={vehicleRates}
          purposeOptions={purposeOptions}
          onSaved={handleSettingsSaved}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}
