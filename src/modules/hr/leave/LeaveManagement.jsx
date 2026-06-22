import { useState, useEffect } from 'react'
import { supabase } from '../../../supabaseClient'
import { useAuth } from '../../../context/AuthContext'
import Tip from '../../../components/Tip'
import { BsFullDatePicker } from '../../../components/BsDatePicker'
import * as XLSX from 'xlsx'
import { adToBs, BS_MONTHS } from '../../../utils/bsCalendar'
import { DEFAULT_LEAVE_TYPES, LEAVE_STATUSES, workingDaysInRange } from './leaveConstants'

const fmt = n => Math.round((n || 0) * 10) / 10
const inp = {
  background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 6,
  padding: '7px 10px', fontSize: 13, color: '#e8e0d0', outline: 'none', fontFamily: 'inherit',
}

// "12 Baisakh 2082" from an ISO/AD date string.
function bsLabel(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d)) return '—'
  const bs = adToBs(d)
  return `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`
}

export default function LeaveManagement() {
  const { clientId, isAdmin } = useAuth()
  const today = adToBs(new Date())
  const [bsYear,    setBsYear]    = useState(today.year)
  const [tab,       setTab]       = useState('requests')
  const [types,     setTypes]     = useState([])
  const [employees, setEmployees] = useState([])
  const [periods,   setPeriods]   = useState([])
  const [requests,  setRequests]  = useState([])
  const [loading,   setLoading]   = useState(true)
  const [busy,      setBusy]      = useState(false)
  const [msg,       setMsg]       = useState('')

  // New-request form
  const [fEmp,    setFEmp]    = useState('')
  const [fType,   setFType]   = useState('')
  const [fStart,  setFStart]  = useState('')
  const [fEnd,    setFEnd]    = useState('')
  const [fReason, setFReason] = useState('')

  const empMap  = Object.fromEntries(employees.map(e => [e.id, e]))
  const typeMap = Object.fromEntries(types.map(t => [t.id, t]))
  const activeTypes = types.filter(t => t.active)
  const years = Array.from({ length: 6 }, (_, i) => today.year - 3 + i)

  useEffect(() => { if (clientId) load() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true); setMsg('')
    // Seed default leave types on first visit.
    let { data: lt } = await supabase.from('hr_leave_types').select('*')
      .eq('client_id', clientId).order('sort_order')
    if (!lt || lt.length === 0) {
      await supabase.from('hr_leave_types').insert(
        DEFAULT_LEAVE_TYPES.map(t => ({ ...t, client_id: clientId }))
      )
      const r = await supabase.from('hr_leave_types').select('*').eq('client_id', clientId).order('sort_order')
      lt = r.data || []
    }
    const [{ data: emps }, { data: pr }, { data: reqs }] = await Promise.all([
      supabase.from('hr_employees').select('id, full_name, employee_code, department, status')
        .eq('client_id', clientId).in('status', ['active', 'probation']).order('full_name'),
      supabase.from('monthly_periods').select('id, bs_year, bs_month, status').eq('client_id', clientId),
      supabase.from('hr_leave_requests').select('*').eq('client_id', clientId).order('start_date', { ascending: false }),
    ])
    setTypes(lt); setEmployees(emps || []); setPeriods(pr || []); setRequests(reqs || [])
    setLoading(false)
  }

  // ── New request ───────────────────────────────────────────────────────────
  const previewDays = workingDaysInRange(fStart, fEnd)
  async function submitRequest() {
    if (!fEmp || !fType || !fStart || !fEnd) { setMsg('error:Fill employee, type and dates'); return }
    if (previewDays.length === 0) { setMsg('error:No working days in that range (end before start, or all Saturdays)'); return }
    setBusy(true); setMsg('')
    const { error } = await supabase.from('hr_leave_requests').insert({
      client_id: clientId, employee_id: fEmp, leave_type_id: fType,
      start_date: fStart.slice(0, 10), end_date: fEnd.slice(0, 10),
      days: previewDays.length, reason: fReason || null, status: 'pending',
    })
    if (error) { setMsg('error:' + error.message); setBusy(false); return }
    setFEmp(''); setFType(''); setFStart(''); setFEnd(''); setFReason('')
    await load(); setMsg('ok:Request submitted'); setBusy(false)
  }

  // ── Attendance sync ───────────────────────────────────────────────────────
  // Write (or revert) the hr_attendance rows for a request's working days.
  async function syncAttendance(req, status) {
    const periodMap = {}
    periods.forEach(p => { periodMap[`${p.bs_year}:${p.bs_month}`] = p })
    const days = workingDaysInRange(req.start_date, req.end_date)
    const rows = []
    const missing = []
    days.forEach(d => {
      const p = periodMap[`${d.bsYear}:${d.bsMonth}`]
      if (!p) { missing.push(`${d.bsDay} ${BS_MONTHS[d.bsMonth - 1]} ${d.bsYear}`); return }
      rows.push({
        client_id: clientId, employee_id: req.employee_id, period_id: p.id,
        bs_day: d.bsDay, status,
      })
    })
    if (rows.length) {
      await supabase.from('hr_attendance').upsert(rows, { onConflict: 'employee_id,period_id,bs_day' })
    }
    return missing
  }

  async function approveRequest(req) {
    const type = typeMap[req.leave_type_id]
    if (!type) { setMsg('error:Leave type missing'); return }
    setBusy(true); setMsg('')
    const missing = await syncAttendance(req, type.paid ? 'paid_leave' : 'unpaid_leave')
    await supabase.from('hr_leave_requests').update({ status: 'approved', decided_at: new Date().toISOString() }).eq('id', req.id)
    await load()
    setMsg(missing.length
      ? `error:Approved, but no period exists for: ${missing.join(', ')}. Create the period(s), then re-approve to mark those days.`
      : 'ok:Approved — attendance marked')
    setBusy(false)
  }

  async function decideRequest(req, newStatus) {
    const verb = newStatus === 'rejected' ? 'Reject' : 'Cancel'
    if (!window.confirm(`${verb} this leave request?`)) return
    setBusy(true); setMsg('')
    // Only an already-approved request has attendance rows to undo.
    if (req.status === 'approved') await syncAttendance(req, 'present')
    await supabase.from('hr_leave_requests').update({ status: newStatus, decided_at: new Date().toISOString() }).eq('id', req.id)
    await load(); setMsg(`ok:${verb}ed`); setBusy(false)
  }

  // ── Balances ──────────────────────────────────────────────────────────────
  // Used days = Σ days of approved requests for emp+type whose start_date falls in bsYear.
  function usedFor(empId, typeId) {
    return requests
      .filter(r => r.employee_id === empId && r.leave_type_id === typeId && r.status === 'approved'
        && adToBs(new Date(r.start_date)).year === bsYear)
      .reduce((a, r) => a + (parseFloat(r.days) || 0), 0)
  }

  function exportBalances() {
    const rows = employees.map(e => {
      const row = { Employee: e.full_name, Code: e.employee_code || '' }
      activeTypes.forEach(t => {
        const used = usedFor(e.id, t.id)
        row[t.name] = t.annual_quota > 0 ? `${fmt(used)} / ${fmt(t.annual_quota)}` : fmt(used)
      })
      return row
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Leave Balances')
    XLSX.writeFile(wb, `leave_balances_BS${bsYear}.xlsx`)
  }

  // ── Leave types editing ───────────────────────────────────────────────────
  async function updateType(id, patch) {
    setTypes(ts => ts.map(t => t.id === id ? { ...t, ...patch } : t))
    await supabase.from('hr_leave_types').update(patch).eq('id', id)
  }
  async function addType() {
    setBusy(true)
    const { error } = await supabase.from('hr_leave_types').insert({
      client_id: clientId, name: 'New Leave Type', code: `custom_${Date.now().toString(36)}`,
      paid: true, annual_quota: 0, carry_forward: false, sort_order: (types.length + 1) * 10,
    })
    if (error) setMsg('error:' + error.message)
    await load(); setBusy(false)
  }

  const filteredRequests = requests.filter(r => adToBs(new Date(r.start_date)).year === bsYear)

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Leave</h1>
          <p className="page-subtitle">Leave entitlements, requests, and balances — BS {bsYear}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {msg && <span style={{ fontSize: 12, color: msg.startsWith('ok') ? '#34d399' : '#f87171', maxWidth: 360 }}>{msg.split(':').slice(1).join(':')}</span>}
          <select className="form-select" value={bsYear} onChange={e => setBsYear(parseInt(e.target.value, 10))}>
            {years.map(y => <option key={y} value={y}>BS {y}</option>)}
          </select>
        </div>
      </div>

      <div className="tab-bar" style={{ marginBottom: 18 }}>
        {[{ id: 'requests', label: 'Requests' }, { id: 'balances', label: 'Balances' }, ...(isAdmin ? [{ id: 'types', label: 'Leave Types' }] : [])].map(t => (
          <button key={t.id} className={`tab-btn${tab === t.id ? ' tab-btn--active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {loading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
      ) : employees.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>No active employees. Add employees in HR → Employees first.</div>
      ) : tab === 'requests' ? (
        /* ── REQUESTS ── */
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>New Request</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, alignItems: 'start' }}>
              <div>
                <label style={lbl}>Employee</label>
                <select style={{ ...inp, width: '100%' }} value={fEmp} onChange={e => setFEmp(e.target.value)}>
                  <option value="">— Select —</option>
                  {employees.map(e => <option key={e.id} value={e.id}>{e.full_name}</option>)}
                </select>
              </div>
              <div>
                <label style={lbl}>Leave Type</label>
                <select style={{ ...inp, width: '100%' }} value={fType} onChange={e => setFType(e.target.value)}>
                  <option value="">— Select —</option>
                  {activeTypes.map(t => <option key={t.id} value={t.id}>{t.name}{t.paid ? '' : ' (unpaid)'}</option>)}
                </select>
              </div>
              <div>
                <label style={lbl}>Start Date</label>
                <BsFullDatePicker value={fStart} onChange={setFStart} />
              </div>
              <div>
                <label style={lbl}>End Date</label>
                <BsFullDatePicker value={fEnd} onChange={setFEnd} />
              </div>
              <div>
                <label style={lbl}>Reason</label>
                <input style={{ ...inp, width: '100%' }} value={fReason} onChange={e => setFReason(e.target.value)} placeholder="Optional" />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, flexWrap: 'wrap', gap: 8 }}>
              <span style={{ fontSize: 12, color: '#9ca3af' }}>
                <Tip text="Saturdays (weekly off) are not counted against leave. The balance is reduced by working days only." width={260}>
                  {fStart && fEnd ? `${previewDays.length} working day${previewDays.length === 1 ? '' : 's'}` : 'Pick a date range'}
                </Tip>
              </span>
              <button className="btn btn-primary" onClick={submitRequest} disabled={busy} style={{ fontSize: 13 }}>{busy ? 'Saving…' : 'Submit Request'}</button>
            </div>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Type</th>
                    <th>Dates (BS)</th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Working days in the range — Saturdays excluded." width={220}>Days</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Remaining balance for this leave type after approved leave this BS year." width={250}>Balance</Tip>
                    </th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRequests.length === 0 ? (
                    <tr><td colSpan={7} style={{ textAlign: 'center', color: '#6b7280', padding: 28 }}>No requests for BS {bsYear} yet.</td></tr>
                  ) : filteredRequests.map(req => {
                    const e = empMap[req.employee_id] || {}
                    const t = typeMap[req.leave_type_id]
                    const sc = LEAVE_STATUSES[req.status] || {}
                    const quota = t?.annual_quota || 0
                    const remaining = quota > 0 ? quota - usedFor(req.employee_id, req.leave_type_id) : null
                    return (
                      <tr key={req.id}>
                        <td>
                          <div style={{ fontWeight: 600, color: '#e8e0d0', fontSize: 13 }}>{e.full_name || '—'}</div>
                          {e.employee_code && <div style={{ fontSize: 10, color: '#6b7280' }}>{e.employee_code}</div>}
                        </td>
                        <td>
                          <span style={{ fontSize: 11, fontWeight: 700, color: t?.color || '#9ca3af', background: `${t?.color || '#9ca3af'}1a`, border: `1px solid ${t?.color || '#9ca3af'}33`, borderRadius: 8, padding: '2px 8px' }}>
                            {t?.name || 'Unknown'}{t && !t.paid ? ' · unpaid' : ''}
                          </span>
                        </td>
                        <td style={{ fontSize: 12, color: '#9ca3af', whiteSpace: 'nowrap' }}>
                          {bsLabel(req.start_date)} → {bsLabel(req.end_date)}
                        </td>
                        <td style={{ textAlign: 'right', color: '#e8e0d0', fontWeight: 600 }}>{fmt(req.days)}</td>
                        <td style={{ textAlign: 'right', color: remaining == null ? '#4b5563' : remaining < 0 ? '#f87171' : '#9ca3af' }}>
                          {remaining == null ? '—' : `${fmt(remaining)} / ${fmt(quota)}`}
                        </td>
                        <td><span style={{ fontSize: 11, fontWeight: 700, color: sc.color }}>{sc.label}</span></td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {isAdmin && req.status === 'pending' && (
                            <>
                              <button className="btn btn-ghost" style={{ fontSize: 11, color: '#34d399' }} onClick={() => approveRequest(req)} disabled={busy}>Approve</button>
                              <button className="btn btn-ghost" style={{ fontSize: 11, color: '#f87171' }} onClick={() => decideRequest(req, 'rejected')} disabled={busy}>Reject</button>
                            </>
                          )}
                          {(req.status === 'pending' || req.status === 'approved') && (
                            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => decideRequest(req, 'cancelled')} disabled={busy}>Cancel</button>
                          )}
                          {(req.status === 'rejected' || req.status === 'cancelled') && <span style={{ fontSize: 11, color: '#4b5563' }}>—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: '#4b5563', lineHeight: 1.6 }}>
            Approving a request marks those days in Attendance (paid or unpaid leave) for the matching month — so Payroll deducts unpaid leave automatically. Rejecting or cancelling an approved request reverts those attendance days to Present. Saturdays are never counted.
          </div>
        </div>
      ) : tab === 'balances' ? (
        /* ── BALANCES ── */
        <div>
          <div className="card no-print" style={{ marginBottom: 14, display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={exportBalances}>⬇ Export Excel</button>
          </div>
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ position: 'sticky', left: 0, background: '#141820', zIndex: 1 }}>Employee</th>
                    {activeTypes.map(t => (
                      <th key={t.id} style={{ textAlign: 'right', color: t.color }}>
                        <Tip text={`${t.name}: ${t.annual_quota > 0 ? t.annual_quota + ' days/year' : 'uncapped'}${t.paid ? '' : ', unpaid'}. Shows used / quota.`} width={240}>{t.name}</Tip>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {employees.map(e => (
                    <tr key={e.id}>
                      <td style={{ position: 'sticky', left: 0, background: '#141820', zIndex: 1, fontWeight: 600, color: '#e8e0d0', whiteSpace: 'nowrap' }}>{e.full_name}</td>
                      {activeTypes.map(t => {
                        const used = usedFor(e.id, t.id)
                        const remaining = t.annual_quota - used
                        const over = t.annual_quota > 0 && remaining < 0
                        return (
                          <td key={t.id} style={{ textAlign: 'right', color: over ? '#f87171' : used > 0 ? '#e8e0d0' : '#4b5563' }}>
                            {t.annual_quota > 0
                              ? <span><b>{fmt(used)}</b> <span style={{ color: '#6b7280' }}>/ {fmt(t.annual_quota)}</span></span>
                              : (used > 0 ? <b>{fmt(used)}</b> : '—')}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: '#4b5563', lineHeight: 1.6 }}>
            Each cell shows approved leave days used against the annual quota for BS {bsYear}. Uncapped types (e.g. Unpaid) show only the days taken. Quotas are flat annual figures — accrual and carry-forward roll-over are not yet automatic.
          </div>
        </div>
      ) : (
        /* ── LEAVE TYPES (admin) ── */
        <div>
          <div className="card no-print" style={{ marginBottom: 14, display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={addType} disabled={busy}>+ Add Type</button>
          </div>
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th style={{ textAlign: 'center' }}>
                      <Tip text="Paid leave marks Attendance as Paid Leave; unpaid marks Unpaid Leave (which Payroll deducts)." width={260}>Paid</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Days allowed per year. 0 = uncapped (e.g. unpaid leave)." width={220}>Annual Quota</Tip>
                    </th>
                    <th style={{ textAlign: 'center' }}>
                      <Tip text="Whether unused days carry into next year. Stored for reference — roll-over is not yet automatic." width={260}>Carry Fwd</Tip>
                    </th>
                    <th style={{ textAlign: 'center' }}>
                      <Tip text="Inactive types are hidden from new requests but kept for history." width={240}>Active</Tip>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {types.map(t => (
                    <tr key={t.id}>
                      <td>
                        <input defaultValue={t.name} onBlur={e => updateType(t.id, { name: e.target.value })}
                          style={{ ...inp, width: '100%', color: t.color, fontWeight: 600 }} />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={t.paid} onChange={e => updateType(t.id, { paid: e.target.checked })} />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <input type="number" min="0" step="0.5" defaultValue={t.annual_quota}
                          onBlur={e => updateType(t.id, { annual_quota: parseFloat(e.target.value) || 0 })}
                          style={{ ...inp, width: 90, textAlign: 'right' }} />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={t.carry_forward} onChange={e => updateType(t.id, { carry_forward: e.target.checked })} />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={t.active} onChange={e => updateType(t.id, { active: e.target.checked })} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: '#4b5563', lineHeight: 1.6 }}>
            Defaults follow Nepal's Labour Act 2074. Maternity (98) and Paternity (15) are per-event statutory entitlements rather than annually recurring. Edits save automatically.
          </div>
        </div>
      )}
    </div>
  )
}

const lbl = { display: 'block', fontSize: 11, color: '#6b7280', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }
