import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'

const ROLE_OPTIONS = [
  { value: '',           label: '— No POS Access —' },
  { value: 'staff',      label: 'Staff',             desc: 'Take orders, view floor, close bills' },
  { value: 'supervisor', label: 'Supervisor',         desc: 'Staff + table setup, void, open/close shift' },
  { value: 'manager',    label: 'Manager',            desc: 'Supervisor + reports, staff role assignment' },
]

const ROLE_BADGE = { staff: 'badge-green', supervisor: 'badge-amber', manager: 'badge-gold' }
const EMPTY_ADD  = { full_name: '', pin: '', pos_role: 'staff' }

function pinValid(pin) { return /^\d{4,6}$/.test(pin) }

export default function PosStaff() {
  const { clientId, isAdmin, hasPosAccess } = useAuth()
  const [staff,      setStaff]      = useState([])
  const [loading,    setLoading]    = useState(true)
  const [saving,     setSaving]     = useState({})
  const [msg,        setMsg]        = useState('')

  // Add staff modal
  const [addModal,   setAddModal]   = useState(false)
  const [addForm,    setAddForm]    = useState(EMPTY_ADD)
  const [adding,     setAdding]     = useState(false)
  const [addMsg,     setAddMsg]     = useState('')

  // Reset PIN modal
  const [pinTarget,  setPinTarget]  = useState(null) // { id, name }
  const [newPin,     setNewPin]     = useState('')
  const [resetting,  setResetting]  = useState(false)
  const [pinMsg,     setPinMsg]     = useState('')

  const canEdit = isAdmin || hasPosAccess('manager')

  useEffect(() => { if (clientId) load() }, [clientId]) // eslint-disable-line

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, pos_role, last_seen_at')
      .eq('client_id', clientId)
      .eq('role', 'client')
      .order('full_name')
    setStaff(data || [])
    setLoading(false)
  }

  // ── Add staff ──────────────────────────────────────────────────────────────
  function openAdd() { setAddForm(EMPTY_ADD); setAddMsg(''); setAddModal(true) }

  async function addStaff() {
    if (!addForm.full_name.trim()) { setAddMsg('Name is required.'); return }
    if (!pinValid(addForm.pin))    { setAddMsg('PIN must be 4–6 digits.'); return }
    setAdding(true); setAddMsg('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: {
        action:    'create_pos_staff',
        client_id: clientId,
        full_name: addForm.full_name.trim(),
        pin:       addForm.pin,
        pos_role:  addForm.pos_role,
      },
    })
    if (error || data?.error) {
      let detail = data?.error || error?.message || 'Failed to create staff'
      try { const b = await error?.context?.json(); detail = b?.error || detail } catch (_) {}
      setAddMsg('Error: ' + detail)
      setAdding(false); return
    }
    setAddModal(false); setAdding(false); load()
  }

  // ── Reset PIN ──────────────────────────────────────────────────────────────
  function openReset(p) { setPinTarget(p); setNewPin(''); setPinMsg(''); }

  async function resetPin() {
    if (!pinValid(newPin)) { setPinMsg('PIN must be 4–6 digits.'); return }
    setResetting(true); setPinMsg('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: { action: 'reset_pos_pin', userId: pinTarget.id, pin: newPin },
    })
    if (error || data?.error) {
      let detail = data?.error || error?.message || 'Failed to reset PIN'
      try { const b = await error?.context?.json(); detail = b?.error || detail } catch (_) {}
      setPinMsg('Error: ' + detail)
      setResetting(false); return
    }
    setPinTarget(null); setResetting(false)
  }

  // ── Role update ────────────────────────────────────────────────────────────
  async function updateRole(profileId, newRole) {
    setSaving(s => ({ ...s, [profileId]: true })); setMsg('')
    const { error } = await supabase
      .from('profiles')
      .update({ pos_role: newRole || null })
      .eq('id', profileId)
    if (error) {
      setMsg('Error: ' + error.message)
    } else {
      setStaff(prev => prev.map(p => p.id === profileId ? { ...p, pos_role: newRole || null } : p))
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
            Assign POS roles to your team. Staff log in with their name and PIN.
          </p>
        </div>
        {canEdit && (
          <button className="btn btn-primary" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} onClick={openAdd}>
            + Add Staff
          </button>
        )}
      </div>

      {/* Role legend */}
      <div className="card" style={{ padding: '14px 18px', marginBottom: 24, display: 'flex', flexWrap: 'wrap', gap: 20 }}>
        {ROLE_OPTIONS.slice(1).map(r => (
          <div key={r.value} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={ROLE_BADGE[r.value]} style={{ fontSize: 11 }}>{r.label}</span>
            <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{r.desc}</span>
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
                <th>
                  <Tip text="The access level this user has within Crest POS. No role = cannot see any POS screens.">POS Role</Tip>
                </th>
                <th>
                  <Tip text="Last time this user was active in the app">Last Seen</Tip>
                </th>
                {canEdit && <th style={{ width: 120 }}>PIN</th>}
              </tr>
            </thead>
            <tbody>
              {staff.map(p => (
                <tr key={p.id}>
                  <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                    {p.full_name || '—'}
                  </td>
                  <td>
                    {canEdit ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <select
                          className="form-select"
                          style={{ minWidth: 180 }}
                          value={p.pos_role || ''}
                          disabled={saving[p.id]}
                          onChange={e => updateRole(p.id, e.target.value)}
                        >
                          {ROLE_OPTIONS.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                        {saving[p.id] && <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Saving…</span>}
                      </div>
                    ) : (
                      p.pos_role
                        ? <span className={ROLE_BADGE[p.pos_role] || 'badge-gray'} style={{ fontSize: 11 }}>
                            {p.pos_role.charAt(0).toUpperCase() + p.pos_role.slice(1)}
                          </span>
                        : <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>No access</span>
                    )}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                    {p.last_seen_at
                      ? new Date(p.last_seen_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                      : '—'}
                  </td>
                  {canEdit && (
                    <td>
                      <button
                        className="btn btn-ghost"
                        style={{ fontSize: 12, padding: '4px 10px' }}
                        onClick={() => openReset(p)}
                      >
                        Reset PIN
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!canEdit && (
        <p style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 16 }}>
          Role changes require Manager access. Contact your manager or Crest admin.
        </p>
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
              <label style={labelStyle}>POS Role</label>
              <select
                className="form-select"
                style={{ width: '100%' }}
                value={addForm.pos_role}
                onChange={e => setAddForm(f => ({ ...f, pos_role: e.target.value }))}
              >
                {ROLE_OPTIONS.slice(1).map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
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
