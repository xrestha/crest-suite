import { useEffect, useState, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { readPageCache, writePageCache } from '../../../shared/sessionDataCache'
import { supabase } from '../../../supabaseClient'
import { errorText } from '../../../shared/errorText'
import Tip from '../../../components/Tip'
import Fab from '../../../components/Fab'
import Modal from '../../../components/Modal'
import EmployeeForm from './EmployeeForm'
import EmployeeJoiningForm from './EmployeeJoiningForm'
import { EMPLOYEE_STATUS_COLORS as STATUS_COLORS } from '../payrollConstants'

function pinValid(pin) { return /^\d{4,6}$/.test(pin) }

const EMP_TYPES = {
  permanent:  'Permanent',
  probation:  'Probation',
  contract:   'Contract',
  part_time:  'Part-time',
}

const RETIRE_SOON_DAYS = 180

// Retirement status from a retirement_date (AD string): retired (past) / soon (≤180d) / null.
function retireInfo(dateStr) {
  if (!dateStr) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0)
  const days = Math.round((d - today) / 86400000)
  // `color` is only ever used as the badge's TEXT (the tint + border are the fill), so it takes
  // the *-text contrast variants per the S549 rule.
  if (days < 0)               return { retired: true, label: 'Retired',       color: 'var(--theme-red-text)', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.2)' }
  if (days <= RETIRE_SOON_DAYS) return { soon: true,  label: 'Retiring soon', color: 'var(--theme-accent-ink)', bg: 'rgba(201,168,76,0.1)', border: 'rgba(201,168,76,0.2)', days }
  return { future: true, days }
}

function fmtDate(dateStr) {
  return dateStr ? new Date(dateStr).toLocaleDateString('en-NP', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
}

// Three separate failures on this page each need the same page-level red card, so it lives here
// once rather than being pasted per call site.
function AlertCard({ children, onDismiss }) {
  return (
    <div
      role="alert"
      className="card"
      style={{
        marginBottom: 12, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
        borderColor: 'color-mix(in srgb, var(--theme-red) 25%, transparent)',
        background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)',
      }}
    >
      <span style={{ fontSize: 12, color: 'var(--theme-red-text)' }}>{children}</span>
      {onDismiss && (
        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 10px' }} onClick={onDismiss} aria-label="Dismiss">×</button>
      )}
    </div>
  )
}

export default function EmployeeList() {
  const { clientId, profile, hasHrAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedUpdate } = useScopedDb()

  // Seeded from the short-lived session cache so a revisit paints the last-known roster instantly
  // instead of a skeleton (S460 pattern). This page passes both of the tests that decide whether a
  // page may adopt it: nothing here batch-saves using on-screen state as a baseline (the bulk
  // Activate/Deactivate writes an ABSOLUTE `access_blocked` to explicitly selected ids, and every
  // other save writes only the one employee being edited), and the cached section is the page's
  // core content, so it genuinely shortens the skeleton rather than caching a reference list
  // behind a read the user still waits for.
  const [cachedEmployees] = useState(() => readPageCache('employees', 'employees', effectiveClientId))
  const [employees, setEmployees] = useState(cachedEmployees ?? [])
  const [loading, setLoading]     = useState(!cachedEmployees)
  const [search, setSearch]       = useState('')
  const [statusFilter, setStatus] = useState('all')
  const [supFilter, setSupFilter] = useState('all')
  const [retiringOnly, setRetiringOnly] = useState(false)
  const [drawerOpen, setDrawer]   = useState(false)
  const [editing, setEditing]     = useState(null)
  const [printForm, setPrintForm] = useState(false)

  // employee_id -> profile_id, for employees with self-service already enabled
  const [selfServiceMap, setSelfServiceMap] = useState({})
  const [ssTarget, setSsTarget] = useState(null) // employee row being enabled
  const [ssPin, setSsPin] = useState('')
  const [ssBusy, setSsBusy] = useState(false)
  const [ssMsg, setSsMsg] = useState('')
  // Removing Self-Service happens from a table row, not from the Enable modal, so it needs its
  // own page-level error surface — ssMsg only renders inside that modal.
  const [ssRemoving, setSsRemoving] = useState(null) // employee id currently being revoked
  const [ssRemoveErr, setSsRemoveErr] = useState('')
  // Both reads below used to drop their error and coalesce to an empty result, which on this page
  // is not a harmless blank: an empty roster reads as "no staff", and an empty self-service map
  // reads as "nobody has a login" — see the row action, which would then offer Enable to someone
  // who already has one. A failed read is not an empty result (S594).
  const [loadErr, setLoadErr] = useState('')
  const [ssStatusErr, setSsStatusErr] = useState('')
  const [linkCopied, setLinkCopied] = useState(false)

  // Row selection for the bulk Activate/Deactivate action, keyed by employee id. This toggles
  // hr_employees.access_blocked ONLY — a login-access flag fully independent of `status`, which
  // stays the single-purpose field Payroll Run/Calculation and Final Settlement filter on. See
  // CLAUDE.md's S561/S562 notes: status-gating login collided head-on with payroll eligibility.
  const [selected, setSelected] = useState(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)

  useEffect(() => {
    if (effectiveClientId) { fetchEmployees(); fetchSelfServiceStatus() }
    else setLoading(false)
  }, [effectiveClientId]) // eslint-disable-line

  async function fetchEmployees() {
    if (employees.length === 0) setLoading(true) // a cached list keeps showing while this refreshes
    const { data, error } = await scopedFrom('hr_employees').order('full_name')
    if (error) {
      // Leave whatever is already on screen. A cached list is stale but true; [] is a lie that
      // reads as "this client has no employees" — and it would also be written to the cache,
      // so the lie would survive the next visit.
      setLoadErr(errorText(error, 'operator'))
      setLoading(false)
      return
    }
    setLoadErr('')
    setEmployees(data || [])
    writePageCache('employees', 'employees', effectiveClientId, data || [])
    setLoading(false)
  }

  // profiles doesn't follow the standard client-scoped RLS pattern (self-or-admin only), so this
  // goes through a dedicated RPC rather than a raw/scoped query — see get_hr_self_service_status.
  async function fetchSelfServiceStatus() {
    const { data, error } = await supabase.rpc('get_hr_self_service_status', { p_client_id: effectiveClientId })
    if (error) {
      // Keep the last known map rather than blanking it, and let the row render "unknown" instead
      // of confidently offering Enable — creating a second login for an employee who already has
      // one is the failure this silence used to walk an operator into.
      setSsStatusErr(errorText(error, 'operator'))
      return
    }
    setSsStatusErr('')
    setSelfServiceMap(Object.fromEntries((data || []).map(r => [r.employee_id, r.profile_id])))
  }

  function openEnableSelfService(emp) { setSsTarget(emp); setSsPin(''); setSsMsg('') }

  async function enableSelfService() {
    if (!pinValid(ssPin)) { setSsMsg('PIN must be 4–6 digits.'); return }
    setSsBusy(true); setSsMsg('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: { action: 'create_hr_self_service_login', client_id: effectiveClientId, employee_id: ssTarget.id, pin: ssPin },
    })
    if (error || data?.error) {
      let detail = data?.error || error?.message || 'Failed to enable self-service'
      try { const b = await error?.context?.json(); detail = b?.error || detail } catch (_) {}
      setSsMsg('Error: ' + detail); setSsBusy(false); return
    }
    setSsTarget(null); setSsBusy(false)
    fetchSelfServiceStatus()
  }

  // The inverse of Enable, which was a one-way door until S571 — revoking a departed employee's
  // portal access previously meant deleting the auth user by hand in SQL. Distinct from the
  // Deactivate bulk action above: that sets hr_employees.access_blocked and suspends login while
  // keeping the account; this removes the login entirely. The employee record and their payroll
  // history are untouched either way.
  async function removeSelfService(emp) {
    const userId = selfServiceMap[emp.id]
    if (!userId) return
    if (!window.confirm(
      `Remove Self-Service access for ${emp.full_name}?\n\n` +
      'Their PIN stops working immediately and they can no longer view payslips, submit leave or see their roster.\n\n' +
      "The employee record, payslips and leave history are NOT deleted. You can re-enable access later with a new PIN.\n\n" +
      'To suspend access temporarily instead, use Deactivate on the selection bar.'
    )) return
    setSsRemoving(emp.id); setSsRemoveErr('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: { action: 'delete_hr_self_service_login', userId },
    })
    if (error || data?.error) {
      let detail = data?.error || error?.message || 'Failed to remove self-service access'
      try { const b = await error?.context?.json(); detail = b?.error || detail } catch (_) {}
      setSsRemoveErr(detail); setSsRemoving(null); return
    }
    setSsRemoving(null); setSsRemoveErr('')
    fetchSelfServiceStatus()
  }

  function toggleSelect(id) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleSelectAll(rows) {
    setSelected(prev => {
      const allSelected = rows.length > 0 && rows.every(e => prev.has(e.id))
      if (allSelected) return new Set()
      return new Set(rows.map(e => e.id))
    })
  }

  // Bulk-toggles access_blocked only — never touches status, so this can never remove anyone from
  // a Payroll Run/Calculation/Final Settlement picker (all three filter on status alone).
  async function bulkSetAccess(blocked) {
    if (selected.size === 0) return
    setBulkBusy(true)
    await scopedUpdate('hr_employees', { access_blocked: blocked }).in('id', Array.from(selected))
    setSelected(new Set())
    await fetchEmployees()
    setBulkBusy(false)
  }

  function openAdd() { setEditing(null); setDrawer(true) }
  function openEdit(emp) { setEditing(emp); setDrawer(true) }
  function closeDrawer() { setDrawer(false); setEditing(null) }

  // One shared login link per client — the admin sends this to every self-service employee.
  function copySelfServiceLink() {
    const url = `${window.location.origin}/hr/self-service/login/${effectiveClientId}`
    navigator.clipboard.writeText(url)
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 2000)
  }

  // Everything below is memoized because the search box is a controlled input: without it, one
  // keystroke re-ran all of it over the full employee list — including four full scans for the
  // stat cards, none of which depend on `search` at all.
  const nameById = useMemo(
    () => Object.fromEntries(employees.map(e => [e.id, e.full_name])), [employees])

  // The employees actually used as somebody's supervisor, for the filter dropdown. This was
  // `employees.filter(e => employees.some(...))` — a nested scan, so O(n^2) per keystroke (40,000
  // comparisons at 200 staff). One pass to collect the referenced ids, then one filter.
  const supervisorList = useMemo(() => {
    const referenced = new Set(employees.map(e => e.supervisor_id).filter(Boolean))
    return employees
      .filter(e => referenced.has(e.id))
      .sort((a, b) => a.full_name.localeCompare(b.full_name))
  }, [employees])

  const filtered = useMemo(() => {
    // Hoisted out of the predicate: this ran four times per employee per keystroke.
    const q = search.trim().toLowerCase()
    return employees.filter(e => {
      const matchSearch = !q ||
        e.full_name.toLowerCase().includes(q) ||
        (e.employee_code || '').toLowerCase().includes(q) ||
        (e.department || '').toLowerCase().includes(q) ||
        (e.designation || '').toLowerCase().includes(q)
      const matchStatus = statusFilter === 'all' || e.status === statusFilter
      const matchSup = supFilter === 'all'
        || (supFilter === 'none' ? !e.supervisor_id : e.supervisor_id === supFilter)
      const matchRetire = !retiringOnly || !!retireInfo(e.retirement_date)?.soon
      return matchSearch && matchStatus && matchSup && matchRetire
    })
  }, [employees, search, statusFilter, supFilter, retiringOnly])

  // The four stat-card figures, in ONE pass rather than four scans of the same array. They are
  // headline counts over the whole roster, so they never move while someone types in the search
  // box — the memo is what stops them being recomputed anyway.
  const { total, active, probation, payrollAmt, retiringSoon } = useMemo(() => {
    let active = 0, probation = 0, payrollAmt = 0, retiringSoon = 0
    for (const e of employees) {
      const onPayroll = e.status === 'active' || e.status === 'probation'
      if (e.status === 'active') active++
      if (e.status === 'probation') probation++
      if (onPayroll) {
        payrollAmt += parseFloat(e.basic_salary || 0)
        // Active/probation employees retiring within the next 180 days.
        if (retireInfo(e.retirement_date)?.soon) retiringSoon++
      }
    }
    return { total: employees.length, active, probation, payrollAmt, retiringSoon }
  }, [employees])

  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Employees</h1>
          <p className="page-subtitle">Employee master — personal info, employment details, salary and banking</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Tip text="Copies a link employees can open on their own phone to log in with their PIN and view their payslip, submit leave, and see their roster. Same link works for every self-service employee at this company.">
            <button className="btn btn-ghost" onClick={copySelfServiceLink} style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              {linkCopied ? '✓ Link Copied' : '🔗 Copy Self-Service Link'}
            </button>
          </Tip>
          <button className="btn btn-ghost" onClick={() => setPrintForm(true)} style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            🖨 Print Joining Form
          </button>
        </div>
      </div>

      {loadErr && (
        <AlertCard onDismiss={() => setLoadErr('')}>
          Couldn't load the employee list, so what's shown below may be out of date or incomplete: {loadErr}
        </AlertCard>
      )}

      {ssStatusErr && (
        <AlertCard onDismiss={() => setSsStatusErr('')}>
          Couldn't check who has Self-Service, so that column is showing "?" rather than guessing: {ssStatusErr}
        </AlertCard>
      )}

      {ssRemoveErr && (
        <AlertCard onDismiss={() => setSsRemoveErr('')}>
          Couldn't remove Self-Service access: {ssRemoveErr}
        </AlertCard>
      )}

      {/* Stat cards */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Total Employees</div>
          <div className="stat-value">{total}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Active</div>
          <div className="stat-value" style={{ color: 'var(--theme-green-text)' }}>{active}</div>
          {probation > 0 && <div className="stat-sub" style={{ color: 'var(--theme-accent-ink)' }}>{probation} on probation</div>}
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Sum of basic salary for all active and probation employees. Full payroll (with allowances, SSF, TDS) is computed during payroll run." width={260}>
              Basic Payroll / Month
            </Tip>
          </div>
          <div className="stat-value" style={{ fontSize: 16 }}>
            NPR {Math.round(payrollAmt).toLocaleString('en-NP')}
          </div>
          <div className="stat-sub">basic salary only</div>
        </div>
        <div className="stat-card" style={retiringSoon > 0 ? { cursor: 'pointer' } : undefined} onClick={() => retiringSoon > 0 && setRetiringOnly(v => !v)}>
          <div className="stat-label">
            <Tip text="Active or probation employees whose retirement date falls within the next 180 days. Click to filter." width={260}>
              Retiring Soon
            </Tip>
          </div>
          <div className="stat-value" style={{ color: retiringSoon > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-green-text)' }}>{retiringSoon}</div>
          <div className="stat-sub">within 180 days</div>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          aria-label="Search employees by name, code, department or designation"
          className="form-input form-input--auto"
          style={{ width: 260, maxWidth: '100%' }}
          placeholder="Search name, code, department…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="tab-bar" style={{ marginBottom: 0 }}>
          {['all','active','probation','resigned','terminated','inactive'].map(s => (
            <button
              key={s}
              className={`tab-btn${statusFilter === s ? ' tab-btn--active' : ''}`}
              onClick={() => setStatus(s)}
            >
              {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        {supervisorList.length > 0 && (
          <select
            className="form-select"
            value={supFilter}
            onChange={e => setSupFilter(e.target.value)}
            aria-label="Filter by reporting supervisor"
            title="Filter by reporting supervisor"
          >
            <option value="all">All supervisors</option>
            <option value="none">No supervisor</option>
            {supervisorList.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}
          </select>
        )}
        <button
          className={`tab-btn${retiringOnly ? ' tab-btn--active' : ''}`}
          onClick={() => setRetiringOnly(v => !v)}
          title="Show only employees retiring within 180 days"
        >
          Retiring soon
        </button>
      </div>

      {selected.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
          padding: '8px 12px', borderRadius: 8, background: 'var(--theme-card)', border: '1px solid var(--theme-border)',
        }}>
          <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{selected.size} selected</span>
          <Tip text="Blocks Self-Service PIN login for the selected employees only. Does not change their Status, so they stay fully visible to Payroll Run, Payroll Calculation and Final Settlement.">
            <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--theme-red-text)', borderColor: 'rgba(248,113,113,0.25)' }} disabled={bulkBusy} onClick={() => bulkSetAccess(true)}>
              {bulkBusy ? 'Working…' : 'Deactivate (block login)'}
            </button>
          </Tip>
          <Tip text="Restores Self-Service PIN login for the selected employees.">
            <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--theme-green-text)' }} disabled={bulkBusy} onClick={() => bulkSetAccess(false)}>
              {bulkBusy ? 'Working…' : 'Activate (allow login)'}
            </button>
          </Tip>
          <button className="btn btn-ghost" style={{ fontSize: 12, marginLeft: 'auto' }} onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="loading-state">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">👤</div>
          <p className="empty-state-text">
            {employees.length === 0
              ? 'No employees yet. Add your first employee to get started.'
              : 'No employees match the current filter.'}
          </p>
        </div>
      ) : (
        <div className="table-wrap table-wrap--fab-clear">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    checked={filtered.length > 0 && filtered.every(e => selected.has(e.id))}
                    onChange={() => toggleSelectAll(filtered)}
                    aria-label="Select all employees"
                  />
                </th>
                <th><Tip text="Auto-generated employee code used as a short reference on payroll, attendance, and reports.">Code</Tip></th>
                <th>Name</th>
                <th>Designation</th>
                <th>Department</th>
                <th><Tip text="Reporting manager for this employee — used in leave approval workflows.">Supervisor</Tip></th>
                <th><Tip text="Employment type: Permanent, Probation, Contract, or Part-time. Affects payroll and leave accrual rules." width={280}>Type</Tip></th>
                <th>
                  <Tip text="Date joined." width={160}>Join Date</Tip>
                </th>
                <th>
                  <Tip text="Expected retirement date (DOB + 60, SSF pension age). Flags employees retiring within 180 days." width={280}>Retirement</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Basic salary per month in NPR. Does not include allowances." width={220}>Basic (NPR)</Tip>
                </th>
                <th style={{ textAlign: 'center' }}>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(e => {
                const s = STATUS_COLORS[e.status] || STATUS_COLORS.inactive
                return (
                  <tr key={e.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(e.id)}
                        onChange={() => toggleSelect(e.id)}
                        aria-label={`Select ${e.full_name}`}
                      />
                    </td>
                    <td style={{ color: 'var(--theme-accent-ink)', fontWeight: 700, fontSize: 12 }}>
                      {e.employee_code || '—'}
                    </td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{e.full_name}</td>
                    <td style={{ color: 'var(--theme-text2)' }}>{e.designation || '—'}</td>
                    <td>{e.department
                      ? <span className="badge badge-yellow">{e.department}</span>
                      : <span style={{ color: 'var(--theme-text2)' }}>—</span>}
                    </td>
                    <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>
                      {e.supervisor_id ? (nameById[e.supervisor_id] || '—') : '—'}
                    </td>
                    <td style={{ color: 'var(--theme-text3)', fontSize: 12 }}>
                      {EMP_TYPES[e.employment_type] || e.employment_type}
                    </td>
                    <td style={{ color: 'var(--theme-text3)', fontSize: 12 }}>
                      {fmtDate(e.join_date)}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {(() => {
                        const r = retireInfo(e.retirement_date)
                        if (!e.retirement_date) return <span style={{ color: 'var(--theme-text3)' }}>—</span>
                        return (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ color: 'var(--theme-text3)' }}>{fmtDate(e.retirement_date)}</span>
                            {r && (r.soon || r.retired) && (
                              <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, color: r.color, background: r.bg, border: `1px solid ${r.border}` }}>
                                {r.label}
                              </span>
                            )}
                          </span>
                        )
                      })()}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {parseFloat(e.basic_salary || 0).toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                        color: s.color, background: s.bg, border: `1px solid ${s.border}`,
                      }}>
                        {e.status.charAt(0).toUpperCase() + e.status.slice(1)}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        {selfServiceMap[e.id] ? (
                          e.access_blocked ? (
                            <Tip text="Self-Service is enabled on this account, but login is blocked. Select this employee and use Activate above to restore it.">
                              <span className="badge badge-gray" style={{ fontSize: 10 }}>Self-Service (blocked)</span>
                            </Tip>
                          ) : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <Tip text="This employee can log in via the Self-Service link to view their own payslip, submit leave, and see their roster.">
                                <span className="badge badge-green" style={{ fontSize: 10 }}>✓ Self-Service</span>
                              </Tip>
                              <Tip text="Remove this employee's Self-Service login entirely — their PIN stops working and the account is deleted. Their employee record, payslips and leave history are kept. To suspend access temporarily instead, tick the row and use Deactivate.">
                                <button
                                  className="btn btn-ghost"
                                  style={{ fontSize: 11, padding: '3px 8px', color: 'var(--theme-red-text)' }}
                                  onClick={() => removeSelfService(e)}
                                  disabled={ssRemoving === e.id}
                                >{ssRemoving === e.id ? 'Removing…' : 'Remove'}</button>
                              </Tip>
                            </span>
                          )
                        ) : ssStatusErr ? (
                          <Tip text="Self-Service status couldn't be loaded, so this is unknown — not 'no login'. Reload before enabling: if this employee already has Self-Service, enabling it again will fail.">
                            <span className="badge badge-gray" style={{ fontSize: 10 }}>Self-Service ?</span>
                          </Tip>
                        ) : (
                          <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px' }} onClick={() => openEnableSelfService(e)}>
                            Enable Self-Service
                          </button>
                        )}
                        <button
                          className="btn btn-ghost"
                          style={{ fontSize: 11, padding: '3px 10px' }}
                          onClick={() => openEdit(e)}
                        >
                          Edit
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {drawerOpen && (
        <EmployeeForm
          clientId={effectiveClientId}
          employee={editing}
          onSave={() => { closeDrawer(); fetchEmployees() }}
          onClose={closeDrawer}
        />
      )}

      <Fab onClick={openAdd} label="+ Add Employee" show={!drawerOpen} />

      {printForm && <EmployeeJoiningForm onClose={() => setPrintForm(false)} />}

      {ssTarget && (
        <Modal onClose={() => { if (!ssBusy) setSsTarget(null) }} title="Enable Self-Service" maxWidth={380}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>
              {ssTarget.full_name} will be able to log in with this PIN via the "Copy Self-Service Link" button
              above to view their own payslip, submit leave requests, and see their roster. Set an initial PIN —
              they can be given a new one later by repeating this action.
            </p>
            <div>
              <label htmlFor="emp-ss-pin" style={{ fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4, display: 'block' }}>PIN (4–6 digits)</label>
              <input
                id="emp-ss-pin"
                style={{ background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%' }}
                type="password" autoComplete="new-password" inputMode="numeric" maxLength={6} value={ssPin} onChange={e => setSsPin(e.target.value.replace(/\D/g, ''))}
              />
            </div>
            {ssMsg && <div role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)' }}>{ssMsg}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setSsTarget(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={enableSelfService} disabled={ssBusy}>{ssBusy ? 'Enabling…' : 'Enable'}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
