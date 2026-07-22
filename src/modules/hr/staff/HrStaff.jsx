import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import SearchableSelect from '../../../components/SearchableSelect'

// Mirrors src/modules/ims/staff/ImsStaff.jsx structurally — same role model, same custom-role
// mapping, same Edge Function call pattern — adapted for HR staff (S430). Distinct from HR
// Self-Service (an individual employee's own payslip/leave PIN portal, managed from the
// "Enable Self-Service" button on Employees): this page creates real email+password logins for
// people who administer HR itself (run payroll, approve leave, edit pay setup).
const PERMISSION_LEVELS = [
  { value: 'staff',      label: 'Staff',      desc: 'Holiday Calendar only' },
  { value: 'supervisor', label: 'Supervisor',  desc: 'Staff + Attendance, Leave, Overtime, Roster, TADA Claims, HR Dashboard' },
  { value: 'manager',    label: 'Manager',     desc: 'Supervisor + Employees, Pay Setup, Payroll, Reports, Advances, Gratuity, Settlement, staff role assignment' },
]
const DEFAULT_ROLES = [
  { label: 'Staff',      level: 'staff' },
  { label: 'Supervisor', level: 'supervisor' },
  { label: 'Manager',    level: 'manager' },
]
const LEVEL_BADGE = { staff: 'badge-green', supervisor: 'badge-amber', manager: 'badge-gold' }
const EMPTY_ADD   = { full_name: '', email: '', password: '', job_title: '', employee_id: '', existing_user_id: '' }
const EMPTY_ROLE  = { label: '', level: 'staff' }

function emailValid(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) }
function passwordValid(pw) { return pw.length >= 8 }

export default function HrStaff() {
  const { clientId, hasHrAccess } = useAuth()
  const { scopedFrom } = useScopedDb()
  const [staff,         setStaff]         = useState([])
  const [employees,     setEmployees]     = useState([]) // hr_employees, unlinked ones only
  const [eligibleUsers, setEligibleUsers] = useState([]) // existing client accounts with no pos_role/hr_self_service/ims_role/hr_role yet
  const [loading,     setLoading]     = useState(true)
  const [saving,      setSaving]      = useState({})
  const [msg,         setMsg]         = useState('')

  // Custom roles
  const [customRoles, setCustomRoles] = useState([])
  const [rolesModal,  setRolesModal]  = useState(false)
  const [newRole,     setNewRole]     = useState(EMPTY_ROLE)
  const [rolesSaving, setRolesSaving] = useState(false)
  const [rolesError,  setRolesError]  = useState('')

  // Add staff modal
  const [addModal,    setAddModal]    = useState(false)
  const [addForm,     setAddForm]     = useState(EMPTY_ADD)
  const [addMode,     setAddMode]     = useState('hr') // 'hr' | 'existing' | 'manual'
  const [adding,      setAdding]      = useState(false)
  const [addMsg,      setAddMsg]      = useState('')

  // Reset password modal
  const [pwTarget,    setPwTarget]    = useState(null)
  const [newPassword, setNewPassword] = useState('')
  const [resetting,   setResetting]   = useState(false)
  const [pwMsg,       setPwMsg]       = useState('')

  const effectiveRoles = customRoles.length > 0 ? customRoles : DEFAULT_ROLES
  const linkedEmployeeIds = new Set(staff.map(p => p.hr_employee_id).filter(Boolean))
  const unlinkedEmployees = employees.filter(e => !linkedEmployeeIds.has(e.id))

  useEffect(() => { if (clientId) init() }, [clientId]) // eslint-disable-line

  // Escape-to-close — none of this file's 3 hand-rolled overlays use the shared Modal.js
  // component, so each needs its own listener; only one is ever open at a time in practice.
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key !== 'Escape') return
      if (rolesModal) setRolesModal(false)
      else if (addModal && !adding) setAddModal(false)
      else if (pwTarget && !resetting) setPwTarget(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [rolesModal, addModal, adding, pwTarget, resetting])

  async function init() {
    setLoading(true)
    const [{ data: staffData }, { data: settingsData }, { data: empData }, { data: eligibleData }] = await Promise.all([
      supabase.rpc('get_hr_role_staff_list', { p_client_id: clientId }),
      supabase.from('settings').select('hr_custom_roles').eq('client_id', clientId).single(),
      scopedFrom('hr_employees', 'id, full_name, employee_code, status').in('status', ['active', 'probation']).order('full_name'),
      supabase.rpc('get_hr_role_eligible_users', { p_client_id: clientId }),
    ])
    const roles = settingsData?.hr_custom_roles?.length ? settingsData.hr_custom_roles : DEFAULT_ROLES
    if (settingsData?.hr_custom_roles?.length) setCustomRoles(settingsData.hr_custom_roles)
    const staffList = staffData || []
    setStaff(staffList)
    setEmployees(empData || [])
    setEligibleUsers(eligibleData || [])
    setLoading(false)

    // Silently fix any hr_role values that don't match the job title's configured level
    const mismatched = staffList.filter(p => {
      if (!p.hr_job_title) return false
      const expected = roles.find(r => r.label === p.hr_job_title)?.level
      return expected && expected !== p.hr_role
    })
    for (const p of mismatched) {
      const level = roles.find(r => r.label === p.hr_job_title)?.level
      const { error } = await supabase.functions.invoke('admin-user-ops', {
        body: { action: 'update_hr_role', userId: p.id, hr_role: level, hr_job_title: p.hr_job_title },
      })
      if (!error) setStaff(prev => prev.map(s => s.id === p.id ? { ...s, hr_role: level } : s))
    }
  }

  async function load() {
    const [{ data }, { data: eligibleData }] = await Promise.all([
      supabase.rpc('get_hr_role_staff_list', { p_client_id: clientId }),
      supabase.rpc('get_hr_role_eligible_users', { p_client_id: clientId }),
    ])
    setStaff(data || [])
    setEligibleUsers(eligibleData || [])
  }

  async function saveRoles(roles) {
    if (!clientId) return false   // never write a client_id:null (global-defaults) settings row during the admin no-client window
    setRolesSaving(true); setRolesError('')
    const { data: existing } = await supabase
      .from('settings').select('id').eq('client_id', clientId).single()
    let err
    if (existing) {
      const { error } = await supabase.from('settings').update({ hr_custom_roles: roles }).eq('id', existing.id)
      err = error
    } else {
      const { error } = await supabase.from('settings').insert({ client_id: clientId, hr_custom_roles: roles })
      err = error
    }
    if (err) { setRolesError('Error saving roles: ' + err.message); setRolesSaving(false); return false }
    setCustomRoles(roles)
    setRolesSaving(false)
    return true
  }

  async function updateCustomRoleLevel(i, level) {
    const changedLabel = customRoles[i].label
    const updated = customRoles.map((r, idx) => idx === i ? { ...r, level } : r)
    const ok = await saveRoles(updated)
    if (!ok) return
    // Sync existing staff whose job title matches the changed role
    const affected = staff.filter(p => p.hr_job_title === changedLabel && p.hr_role !== level)
    for (const p of affected) {
      const { error } = await supabase.functions.invoke('admin-user-ops', {
        body: { action: 'update_hr_role', userId: p.id, hr_role: level, hr_job_title: changedLabel },
      })
      if (!error) setStaff(prev => prev.map(s => s.id === p.id ? { ...s, hr_role: level } : s))
    }
  }

  function addCustomRole() {
    const label = newRole.label.trim()
    if (!label) return
    if (customRoles.some(r => r.label.toLowerCase() === label.toLowerCase())) return
    saveRoles([...customRoles, { label, level: newRole.level }])
    setNewRole(EMPTY_ROLE)
  }

  function deleteCustomRole(i) { saveRoles(customRoles.filter((_, idx) => idx !== i)) }
  function resetToDefaults()   { saveRoles([]) }

  // ── Add staff ──────────────────────────────────────────────────────────────
  function openAdd() {
    setAddForm({ ...EMPTY_ADD, job_title: effectiveRoles[0]?.label || '' })
    setAddMode(
      unlinkedEmployees.length > 0 ? 'hr'
      : eligibleUsers.length > 0 ? 'existing'
      : 'manual'
    )
    setAddMsg(''); setAddModal(true)
  }

  async function addStaff() {
    const role = effectiveRoles.find(r => r.label === addForm.job_title)
    if (!role) { setAddMsg('Select a role.'); return }

    // 'existing' assigns an hr_role to an account that already exists for this client (e.g.
    // created via Admin → Clients → Manage → Users) — no new login is created, so it skips the
    // email/password validation entirely and calls update_hr_role, not create_hr_staff.
    if (addMode === 'existing') {
      if (!addForm.existing_user_id) { setAddMsg('Select a user.'); return }
      setAdding(true); setAddMsg('')
      const { data, error } = await supabase.functions.invoke('admin-user-ops', {
        body: {
          action:       'update_hr_role',
          userId:       addForm.existing_user_id,
          hr_role:      role.level,
          hr_job_title: addForm.job_title,
        },
      })
      if (error || data?.error) {
        let detail = data?.error || error?.message || 'Failed to assign role'
        try { const b = await error?.context?.json(); detail = b?.error || detail } catch (_) {}
        setAddMsg('Error: ' + detail); setAdding(false); return
      }
      setAddModal(false); setAdding(false); load()
      return
    }

    if (addMode === 'hr') {
      if (!addForm.employee_id) { setAddMsg('Select an employee.'); return }
    } else if (!addForm.full_name.trim()) { setAddMsg('Name is required.'); return }
    if (!emailValid(addForm.email))       { setAddMsg('Enter a valid email.'); return }
    if (!passwordValid(addForm.password)) { setAddMsg('Password must be at least 8 characters.'); return }
    setAdding(true); setAddMsg('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: {
        action:       'create_hr_staff',
        client_id:    clientId,
        ...(addMode === 'hr' ? { employee_id: addForm.employee_id } : { full_name: addForm.full_name.trim() }),
        email:        addForm.email.trim(),
        password:     addForm.password,
        hr_role:      role.level,
        hr_job_title: addForm.job_title,
      },
    })
    if (error || data?.error) {
      let detail = data?.error || error?.message || 'Failed to create staff'
      try { const b = await error?.context?.json(); detail = b?.error || detail } catch (_) {}
      setAddMsg('Error: ' + detail); setAdding(false); return
    }
    setAddModal(false); setAdding(false); load()
  }

  // ── Delete staff ───────────────────────────────────────────────────────────
  async function deleteStaff(p) {
    if (!window.confirm(`Delete ${p.full_name}? This cannot be undone.`)) return
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: { action: 'delete_hr_staff', userId: p.id },
    })
    if (error || data?.error) {
      let detail = data?.error || error?.message || 'Failed to delete'
      try { const b = await error?.context?.json(); detail = b?.error || detail } catch (_) {}
      setMsg('Error: ' + detail); return
    }
    load()
  }

  // ── Reset password ────────────────────────────────────────────────────────
  function openReset(p) { setPwTarget(p); setNewPassword(''); setPwMsg('') }

  async function resetPassword() {
    if (!passwordValid(newPassword)) { setPwMsg('Password must be at least 8 characters.'); return }
    setResetting(true); setPwMsg('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: { action: 'reset_hr_password', userId: pwTarget.id, password: newPassword },
    })
    if (error || data?.error) {
      let detail = data?.error || error?.message || 'Failed to reset password'
      try { const b = await error?.context?.json(); detail = b?.error || detail } catch (_) {}
      setPwMsg('Error: ' + detail); setResetting(false); return
    }
    setPwTarget(null); setResetting(false)
  }

  // ── Role update ────────────────────────────────────────────────────────────
  async function updateRole(profileId, jobTitle) {
    const role = jobTitle ? effectiveRoles.find(r => r.label === jobTitle) : null
    setSaving(s => ({ ...s, [profileId]: true })); setMsg('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: {
        action:       'update_hr_role',
        userId:       profileId,
        hr_role:      role?.level || null,
        hr_job_title: jobTitle || null,
      },
    })
    if (error || data?.error) {
      let detail = data?.error || error?.message || 'Failed to update role'
      try { const b = await error?.context?.json(); detail = b?.error || detail } catch (_) {}
      setMsg('Error: ' + detail)
    } else {
      setStaff(prev => prev.map(p => p.id === profileId
        ? { ...p, hr_role: role?.level || null, hr_job_title: jobTitle || null }
        : p
      ))
    }
    setSaving(s => ({ ...s, [profileId]: false }))
  }

  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />

  const inputStyle = {
    width: '100%', boxSizing: 'border-box', padding: '8px 10px',
    background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
    borderRadius: 6, color: 'var(--theme-text1)', fontSize: 13, outline: 'none',
  }
  const labelStyle = { fontSize: 12, color: 'var(--theme-text2)', marginBottom: 4, display: 'block' }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 940 }}>

      {/* Header */}
      <div style={{ marginBottom: 24, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h2 style={{ margin: 0, color: 'var(--theme-text1)', fontSize: 20 }}>HR Staff</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--theme-text3)' }}>
            Assign roles to your HR administrators. Staff log in with their email and password, same as you do.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
          <button className="btn btn-ghost" style={{ whiteSpace: 'nowrap' }} onClick={() => setRolesModal(true)}>
            Manage Roles
          </button>
          <button className="btn btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={openAdd}>
            + Add Staff
          </button>
        </div>
      </div>

      {/* Permission level legend */}
      <div className="card" style={{ padding: '14px 18px', marginBottom: 24, display: 'flex', flexWrap: 'wrap', gap: 20 }}>
        {PERMISSION_LEVELS.map(l => (
          <div key={l.value} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={LEVEL_BADGE[l.value]} style={{ fontSize: 11 }}>{l.label}</span>
            <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{l.desc}</span>
          </div>
        ))}
      </div>

      {msg && <p role="alert" style={{ fontSize: 13, color: 'var(--theme-red)', marginBottom: 16 }}>{msg}</p>}

      {loading ? (
        <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
      ) : staff.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text3)' }}>
          No staff yet. Click <strong>+ Add Staff</strong> to create your first HR account.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th><Tip text="Custom role name defined for this team (e.g. Payroll Officer, HR Coordinator).">Role</Tip></th>
                <th><Tip text="Permission level this role maps to — controls which pages they can access.">Access Level</Tip></th>
                <th><Tip text="Last time this user was active in the app">Last Seen</Tip></th>
                <th style={{ width: 200 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {staff.map(p => {
                const displayTitle = p.hr_job_title || effectiveRoles.find(r => r.level === p.hr_role)?.label || ''
                return (
                  <tr key={p.id}>
                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{p.full_name || '—'}</div>
                      {p.hr_employee_id && (
                        <Tip text="This HR staff login is linked to an HR employee record — name stays in sync with HR.">
                          <span style={{ fontSize: 10, color: 'var(--theme-text3)' }}>🔗 HR{p.employee_code ? ` · ${p.employee_code}` : ''}</span>
                        </Tip>
                      )}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{p.email || '—'}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <select
                          className="form-select"
                          style={{ minWidth: 160 }}
                          value={displayTitle || ''}
                          disabled={saving[p.id]}
                          onChange={e => updateRole(p.id, e.target.value)}
                        >
                          <option value="">— No Access —</option>
                          {effectiveRoles.map(r => (
                            <option key={r.label} value={r.label}>{r.label}</option>
                          ))}
                        </select>
                        {saving[p.id] && <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Saving…</span>}
                      </div>
                    </td>
                    <td>
                      {p.hr_role
                        ? <span className={LEVEL_BADGE[p.hr_role] || 'badge-gray'} style={{ fontSize: 11 }}>
                            {p.hr_role.charAt(0).toUpperCase() + p.hr_role.slice(1)}
                          </span>
                        : <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>—</span>
                      }
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                      {p.last_seen_at
                        ? new Date(p.last_seen_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                        : '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => openReset(p)}>
                          Reset Password
                        </button>
                        <button
                          className="btn btn-ghost"
                          style={{ fontSize: 12, padding: '4px 10px', color: 'var(--theme-red)', borderColor: 'var(--theme-red)' }}
                          onClick={() => deleteStaff(p)}
                        >
                          Delete
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

      {/* ── Manage Roles modal ───────────────────────────────────────────────── */}
      {rolesModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={e => { if (e.target === e.currentTarget) setRolesModal(false) }}>
          <div className="card" style={{ width: 480, padding: 28, maxHeight: '80vh', overflowY: 'auto' }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 16, color: 'var(--theme-text1)' }}>Manage HR Roles</h3>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--theme-text3)' }}>
              Define custom role names for your team. Each maps to a permission level.
            </p>

            {rolesError && <p role="alert" style={{ color: 'var(--theme-red)', fontSize: 12, margin: '-8px 0 12px' }}>{rolesError}</p>}

            {customRoles.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--theme-text3)', fontStyle: 'italic', marginBottom: 16 }}>
                Using default roles (Staff / Supervisor / Manager)
              </p>
            ) : (
              <div style={{ marginBottom: 16 }}>
                {customRoles.map((r, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--theme-border-lt)' }}>
                    <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)' }}>{r.label}</span>
                    <select
                      className="form-select"
                      style={{ width: 120, fontSize: 12 }}
                      value={r.level}
                      onChange={e => updateCustomRoleLevel(i, e.target.value)}
                      disabled={rolesSaving}
                    >
                      {PERMISSION_LEVELS.map(l => (
                        <option key={l.value} value={l.value}>{l.label}</option>
                      ))}
                    </select>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 12, padding: '3px 8px', color: 'var(--theme-red)', borderColor: 'var(--theme-red)' }}
                      onClick={() => deleteCustomRole(i)}
                      disabled={rolesSaving}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add new role */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 20 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Role Name</label>
                <input
                  style={inputStyle}
                  placeholder="e.g. Payroll Officer, HR Coordinator…"
                  value={newRole.label}
                  onChange={e => setNewRole(r => ({ ...r, label: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && addCustomRole()}
                />
              </div>
              <div style={{ width: 140 }}>
                <label style={labelStyle}>Permission Level</label>
                <select
                  className="form-select"
                  style={{ width: '100%' }}
                  value={newRole.level}
                  onChange={e => setNewRole(r => ({ ...r, level: e.target.value }))}
                >
                  {PERMISSION_LEVELS.map(l => (
                    <option key={l.value} value={l.value}>{l.label}</option>
                  ))}
                </select>
              </div>
              <button
                className="btn btn-primary"
                style={{ padding: '8px 14px', whiteSpace: 'nowrap' }}
                onClick={addCustomRole}
                disabled={!newRole.label.trim() || rolesSaving}
              >
                + Add
              </button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              {customRoles.length > 0 && (
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 12, color: 'var(--theme-text3)' }}
                  onClick={resetToDefaults}
                  disabled={rolesSaving}
                >
                  Reset to defaults
                </button>
              )}
              <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => setRolesModal(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Staff modal ──────────────────────────────────────────────────── */}
      {addModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={e => { if (e.target === e.currentTarget && !adding) setAddModal(false) }}>
          <div className="card" style={{ width: 380, padding: 28 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 16, color: 'var(--theme-text1)' }}>Add Staff Member</h3>

            {(unlinkedEmployees.length > 0 || eligibleUsers.length > 0) && (
              <div className="tab-bar" style={{ marginBottom: 16 }}>
                {unlinkedEmployees.length > 0 && (
                  <button className={`tab-btn${addMode === 'hr' ? ' tab-btn--active' : ''}`} onClick={() => setAddMode('hr')}>HR Employee</button>
                )}
                {eligibleUsers.length > 0 && (
                  <button className={`tab-btn${addMode === 'existing' ? ' tab-btn--active' : ''}`} onClick={() => setAddMode('existing')}>Existing User</button>
                )}
                <button className={`tab-btn${addMode === 'manual' ? ' tab-btn--active' : ''}`} onClick={() => setAddMode('manual')}>HR-only Staff</button>
              </div>
            )}

            {addMode === 'hr' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>
                  <Tip text="Links this HR staff login to an existing HR employee record — their name stays in sync with HR.">HR Employee</Tip>
                </label>
                {unlinkedEmployees.length === 0 ? (
                  <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: 0 }}>
                    Every active HR employee already has an HR staff account — add one in Employees first, or switch to another tab.
                  </p>
                ) : (
                  <SearchableSelect
                    options={unlinkedEmployees.map(e => ({ value: e.id, label: `${e.full_name}${e.employee_code ? ` (${e.employee_code})` : ''}` }))}
                    value={addForm.employee_id} onChange={v => setAddForm(f => ({ ...f, employee_id: v }))}
                    placeholder="Select employee…"
                  />
                )}
              </div>
            )}

            {addMode === 'existing' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>
                  <Tip text="Assigns an HR role to a login that already exists for this client (e.g. one created from Admin → Clients → Manage → Users) instead of creating a new one. Only accounts with no POS/HR/IMS role already set are shown.">Existing User</Tip>
                </label>
                {eligibleUsers.length === 0 ? (
                  <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: 0 }}>
                    No eligible existing accounts — every account for this client already has a POS, HR, or IMS role.
                  </p>
                ) : (
                  <SearchableSelect
                    options={eligibleUsers.map(u => ({ value: u.id, label: `${u.full_name || '—'} (${u.email})` }))}
                    value={addForm.existing_user_id} onChange={v => setAddForm(f => ({ ...f, existing_user_id: v }))}
                    placeholder="Select user…"
                  />
                )}
              </div>
            )}

            {addMode === 'manual' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Full Name</label>
                <input
                  style={inputStyle}
                  placeholder="e.g. Sita Sharma"
                  value={addForm.full_name}
                  onChange={e => setAddForm(f => ({ ...f, full_name: e.target.value }))}
                  autoFocus
                />
              </div>
            )}

            {addMode !== 'existing' && (
              <>
                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle}>
                    <Tip text="Staff log in with this email and password — same login mechanism as your own account.">Email</Tip>
                  </label>
                  <input
                    style={inputStyle}
                    type="email"
                    autoComplete="new-password"
                    placeholder="staff@example.com"
                    value={addForm.email}
                    onChange={e => setAddForm(f => ({ ...f, email: e.target.value }))}
                  />
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle}>Initial Password (8+ characters)</label>
                  <input
                    style={inputStyle}
                    type="password"
                    autoComplete="new-password"
                    placeholder="Set an initial password"
                    value={addForm.password}
                    onChange={e => setAddForm(f => ({ ...f, password: e.target.value }))}
                  />
                </div>
              </>
            )}

            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>
                <Tip text="The role shown for this staff member. Permission level is shown in brackets.">Role</Tip>
              </label>
              <select
                className="form-select"
                style={{ width: '100%' }}
                value={addForm.job_title}
                onChange={e => setAddForm(f => ({ ...f, job_title: e.target.value }))}
              >
                {effectiveRoles.map(r => (
                  <option key={r.label} value={r.label}>
                    {r.label} ({r.level.charAt(0).toUpperCase() + r.level.slice(1)})
                  </option>
                ))}
              </select>
            </div>

            {addMsg && <p role="alert" style={{ fontSize: 12, color: 'var(--theme-red)', marginBottom: 12 }}>{addMsg}</p>}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setAddModal(false)} disabled={adding}>Cancel</button>
              <button className="btn btn-primary" onClick={addStaff} disabled={adding}>
                {adding ? 'Creating…' : 'Add Staff'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reset Password modal ─────────────────────────────────────────────── */}
      {pwTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={e => { if (e.target === e.currentTarget && !resetting) setPwTarget(null) }}>
          <div className="card" style={{ width: 340, padding: 28 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 16, color: 'var(--theme-text1)' }}>Reset Password</h3>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--theme-text3)' }}>
              New password for <strong style={{ color: 'var(--theme-text1)' }}>{pwTarget.full_name}</strong>
            </p>
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>New Password (8+ characters)</label>
              <input
                style={inputStyle}
                type="password"
                autoComplete="new-password"
                placeholder="Set a new password"
                value={newPassword}
                autoFocus
                onChange={e => setNewPassword(e.target.value)}
              />
            </div>
            {pwMsg && <p role="alert" style={{ fontSize: 12, color: 'var(--theme-red)', marginBottom: 12 }}>{pwMsg}</p>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setPwTarget(null)} disabled={resetting}>Cancel</button>
              <button className="btn btn-primary" onClick={resetPassword} disabled={resetting}>
                {resetting ? 'Saving…' : 'Save Password'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
