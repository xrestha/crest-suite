import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'

const PERMISSION_LEVELS = [
  { value: 'staff',      label: 'Staff',      desc: 'Take orders, view floor, close bills' },
  { value: 'supervisor', label: 'Supervisor',  desc: 'Staff + table setup, void, open/close shift' },
  { value: 'manager',    label: 'Manager',     desc: 'Supervisor + reports, staff role assignment' },
]
const DEFAULT_ROLES = [
  { label: 'Staff',      level: 'staff' },
  { label: 'Supervisor', level: 'supervisor' },
  { label: 'Manager',    level: 'manager' },
]
const LEVEL_BADGE = { staff: 'badge-green', supervisor: 'badge-amber', manager: 'badge-gold' }
const EMPTY_ADD   = { full_name: '', pin: '', job_title: '' }
const EMPTY_ROLE  = { label: '', level: 'staff' }

function pinValid(pin) { return /^\d{4,6}$/.test(pin) }

export default function PosStaff() {
  const { clientId, isAdmin, hasPosAccess } = useAuth()
  const [staff,       setStaff]       = useState([])
  const [loading,     setLoading]     = useState(true)
  const [saving,      setSaving]      = useState({})
  const [msg,         setMsg]         = useState('')

  // Custom roles
  const [customRoles, setCustomRoles] = useState([])
  const [rolesModal,  setRolesModal]  = useState(false)
  const [newRole,     setNewRole]     = useState(EMPTY_ROLE)
  const [rolesSaving, setRolesSaving] = useState(false)

  // Add staff modal
  const [addModal,    setAddModal]    = useState(false)
  const [addForm,     setAddForm]     = useState(EMPTY_ADD)
  const [adding,      setAdding]      = useState(false)
  const [addMsg,      setAddMsg]      = useState('')

  // Reset PIN modal
  const [pinTarget,   setPinTarget]   = useState(null)
  const [newPin,      setNewPin]      = useState('')
  const [resetting,   setResetting]   = useState(false)
  const [pinMsg,      setPinMsg]      = useState('')

  const canEdit        = isAdmin || hasPosAccess('manager')
  const effectiveRoles = customRoles.length > 0 ? customRoles : DEFAULT_ROLES

  useEffect(() => { if (clientId) { load(); loadRoles() } }, [clientId]) // eslint-disable-line

  async function load() {
    setLoading(true)
    const { data } = await supabase.rpc('get_pos_staff_list', { p_client_id: clientId })
    setStaff(data || [])
    setLoading(false)
  }

  async function loadRoles() {
    const { data } = await supabase
      .from('settings')
      .select('pos_custom_roles')
      .eq('client_id', clientId)
      .single()
    if (data?.pos_custom_roles?.length) setCustomRoles(data.pos_custom_roles)
  }

  async function saveRoles(roles) {
    setRolesSaving(true)
    const { data: existing } = await supabase
      .from('settings').select('id').eq('client_id', clientId).single()
    let err
    if (existing) {
      const { error } = await supabase.from('settings').update({ pos_custom_roles: roles }).eq('id', existing.id)
      err = error
    } else {
      const { error } = await supabase.from('settings').insert({ client_id: clientId, pos_custom_roles: roles })
      err = error
    }
    if (err) { setMsg('Error saving roles: ' + err.message); setRolesSaving(false); return }
    setCustomRoles(roles)
    setRolesSaving(false)
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
    setAddMsg(''); setAddModal(true)
  }

  async function addStaff() {
    if (!addForm.full_name.trim()) { setAddMsg('Name is required.'); return }
    if (!pinValid(addForm.pin))    { setAddMsg('PIN must be 4–6 digits.'); return }
    const role = effectiveRoles.find(r => r.label === addForm.job_title)
    if (!role) { setAddMsg('Select a role.'); return }
    setAdding(true); setAddMsg('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: {
        action:        'create_pos_staff',
        client_id:     clientId,
        full_name:     addForm.full_name.trim(),
        pin:           addForm.pin,
        pos_role:      role.level,
        pos_job_title: addForm.job_title,
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
      body: { action: 'delete_pos_staff', userId: p.id },
    })
    if (error || data?.error) {
      let detail = data?.error || error?.message || 'Failed to delete'
      try { const b = await error?.context?.json(); detail = b?.error || detail } catch (_) {}
      setMsg('Error: ' + detail); return
    }
    load()
  }

  // ── Reset PIN ──────────────────────────────────────────────────────────────
  function openReset(p) { setPinTarget(p); setNewPin(''); setPinMsg('') }

  async function resetPin() {
    if (!pinValid(newPin)) { setPinMsg('PIN must be 4–6 digits.'); return }
    setResetting(true); setPinMsg('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: { action: 'reset_pos_pin', userId: pinTarget.id, pin: newPin },
    })
    if (error || data?.error) {
      let detail = data?.error || error?.message || 'Failed to reset PIN'
      try { const b = await error?.context?.json(); detail = b?.error || detail } catch (_) {}
      setPinMsg('Error: ' + detail); setResetting(false); return
    }
    setPinTarget(null); setResetting(false)
  }

  // ── Role update ────────────────────────────────────────────────────────────
  async function updateRole(profileId, jobTitle) {
    const role = jobTitle ? effectiveRoles.find(r => r.label === jobTitle) : null
    setSaving(s => ({ ...s, [profileId]: true })); setMsg('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: {
        action:        'update_pos_role',
        userId:        profileId,
        pos_role:      role?.level || null,
        pos_job_title: jobTitle || null,
      },
    })
    if (error || data?.error) {
      let detail = data?.error || error?.message || 'Failed to update role'
      try { const b = await error?.context?.json(); detail = b?.error || detail } catch (_) {}
      setMsg('Error: ' + detail)
    } else {
      setStaff(prev => prev.map(p => p.id === profileId
        ? { ...p, pos_role: role?.level || null, pos_job_title: jobTitle || null }
        : p
      ))
    }
    setSaving(s => ({ ...s, [profileId]: false }))
  }

  if (!hasPosAccess('manager')) return <Navigate to="/pos/tables" replace />

  const inputStyle = {
    width: '100%', boxSizing: 'border-box', padding: '8px 10px',
    background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
    borderRadius: 6, color: 'var(--theme-text1)', fontSize: 13, outline: 'none',
  }
  const labelStyle = { fontSize: 12, color: 'var(--theme-text2)', marginBottom: 4, display: 'block' }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 900 }}>

      {/* Header */}
      <div style={{ marginBottom: 24, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h2 style={{ margin: 0, color: 'var(--theme-text1)', fontSize: 20 }}>POS Staff</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--theme-text3)' }}>
            Assign roles to your team. Staff log in with their name and PIN.
          </p>
        </div>
        {canEdit && (
          <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
            <button className="btn btn-ghost" style={{ whiteSpace: 'nowrap' }} onClick={() => setRolesModal(true)}>
              Manage Roles
            </button>
            <button className="btn btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={openAdd}>
              + Add Staff
            </button>
          </div>
        )}
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

      {msg && <p style={{ fontSize: 13, color: 'var(--theme-red)', marginBottom: 16 }}>{msg}</p>}

      {loading ? (
        <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
      ) : staff.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text3)' }}>
          No staff yet. Click <strong>+ Add Staff</strong> to create your first POS account.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th><Tip text="Custom role name defined for this team (e.g. Cashier, Bartender).">Role</Tip></th>
                <th><Tip text="Permission level this role maps to — controls which screens they can access.">Access Level</Tip></th>
                <th><Tip text="Last time this user was active in the app">Last Seen</Tip></th>
                {canEdit && <th style={{ width: 200 }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {staff.map(p => {
                const displayTitle = p.pos_job_title || effectiveRoles.find(r => r.level === p.pos_role)?.label || ''
                return (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{p.full_name || '—'}</td>
                    <td>
                      {canEdit ? (
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
                      ) : (
                        displayTitle
                          ? <span style={{ fontSize: 13, color: 'var(--theme-text1)' }}>{displayTitle}</span>
                          : <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>No access</span>
                      )}
                    </td>
                    <td>
                      {p.pos_role
                        ? <span className={LEVEL_BADGE[p.pos_role] || 'badge-gray'} style={{ fontSize: 11 }}>
                            {p.pos_role.charAt(0).toUpperCase() + p.pos_role.slice(1)}
                          </span>
                        : <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>—</span>
                      }
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                      {p.last_seen_at
                        ? new Date(p.last_seen_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                        : '—'}
                    </td>
                    {canEdit && (
                      <td>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => openReset(p)}>
                            Reset PIN
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
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!canEdit && (
        <p style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 16 }}>
          Role changes require Manager access. Contact your manager or Crest admin.
        </p>
      )}

      {/* ── Manage Roles modal ───────────────────────────────────────────────── */}
      {rolesModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={e => { if (e.target === e.currentTarget) setRolesModal(false) }}>
          <div className="card" style={{ width: 480, padding: 28, maxHeight: '80vh', overflowY: 'auto' }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 16, color: 'var(--theme-text1)' }}>Manage POS Roles</h3>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--theme-text3)' }}>
              Define custom role names for your team. Each maps to a permission level.
            </p>

            {customRoles.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--theme-text3)', fontStyle: 'italic', marginBottom: 16 }}>
                Using default roles (Staff / Supervisor / Manager)
              </p>
            ) : (
              <div style={{ marginBottom: 16 }}>
                {customRoles.map((r, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--theme-border-lt)' }}>
                    <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)' }}>{r.label}</span>
                    <span className={LEVEL_BADGE[r.level]} style={{ fontSize: 11 }}>
                      {r.level.charAt(0).toUpperCase() + r.level.slice(1)}
                    </span>
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
                  placeholder="e.g. Cashier, Bartender…"
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
            <h3 style={{ margin: '0 0 20px', fontSize: 16, color: 'var(--theme-text1)' }}>Add Staff Member</h3>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Full Name</label>
              <input
                style={inputStyle}
                placeholder="e.g. Ram Bahadur"
                value={addForm.full_name}
                onChange={e => setAddForm(f => ({ ...f, full_name: e.target.value }))}
                autoFocus
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>
                <Tip text="Staff enter this PIN on the POS login screen. 4–6 digits only.">PIN</Tip>
              </label>
              <input
                style={inputStyle}
                type="password"
                inputMode="numeric"
                maxLength={6}
                placeholder="4–6 digit PIN"
                value={addForm.pin}
                onChange={e => setAddForm(f => ({ ...f, pin: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>
                <Tip text="The role shown on the POS login screen. Permission level is shown in brackets.">Role</Tip>
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

            {addMsg && <p style={{ fontSize: 12, color: 'var(--theme-red)', marginBottom: 12 }}>{addMsg}</p>}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setAddModal(false)} disabled={adding}>Cancel</button>
              <button className="btn btn-primary" onClick={addStaff} disabled={adding}>
                {adding ? 'Creating…' : 'Add Staff'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reset PIN modal ──────────────────────────────────────────────────── */}
      {pinTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={e => { if (e.target === e.currentTarget && !resetting) setPinTarget(null) }}>
          <div className="card" style={{ width: 340, padding: 28 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 16, color: 'var(--theme-text1)' }}>Reset PIN</h3>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--theme-text3)' }}>
              New PIN for <strong style={{ color: 'var(--theme-text1)' }}>{pinTarget.full_name}</strong>
            </p>
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>New PIN (4–6 digits)</label>
              <input
                style={inputStyle}
                type="password"
                inputMode="numeric"
                maxLength={6}
                placeholder="4–6 digit PIN"
                value={newPin}
                autoFocus
                onChange={e => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </div>
            {pinMsg && <p style={{ fontSize: 12, color: 'var(--theme-red)', marginBottom: 12 }}>{pinMsg}</p>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setPinTarget(null)} disabled={resetting}>Cancel</button>
              <button className="btn btn-primary" onClick={resetPin} disabled={resetting}>
                {resetting ? 'Saving…' : 'Save PIN'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
