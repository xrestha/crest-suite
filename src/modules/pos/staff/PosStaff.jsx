import { useState, useEffect, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import { POS_LEVEL_BADGE as LEVEL_BADGE, STAFF_LEVEL_BADGE_NONE } from '../posSignals'
import SearchableSelect from '../../../components/SearchableSelect'
import Modal from '../../../components/Modal'
import { errorLine } from '../../../shared/errorText'
import ActionError, { asActionError } from '../../../components/ActionError'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { nepalBsLong, nepalDateLong } from '../../../shared/nepalTime'

const PERMISSION_LEVELS = [
  { value: 'staff',      label: 'Staff',      desc: 'Take orders, view floor' },
  // "void" is deliberately NOT listed here: voiding is gated on the per-staff Allow Void checkbox
  // in this same table (PosOrders.jsx checks profile.pos_allow_void), not on rank. Listing it as a
  // Supervisor power meant a manager promoted someone to Supervisor to let them void, got a
  // Supervisor who still couldn't, and had no error explaining why.
  { value: 'supervisor', label: 'Supervisor',  desc: 'Staff + close bills, table setup, complimentary, open/close shift' },
  { value: 'manager',    label: 'Manager',     desc: 'Supervisor + reports, staff role assignment' },
]
const DEFAULT_ROLES = [
  { label: 'Staff',      level: 'staff' },
  { label: 'Supervisor', level: 'supervisor' },
  { label: 'Manager',    level: 'manager' },
]
// Rank is a ladder of access, not a scale of goodness — see POS_LEVEL_BADGE in ../posSignals.js.
// It used to be green/amber/brass, which put a Supervisor in the same colour as an unfired dish.
// Orthogonal to the role/rank system above (S431) — which physical station this login works.
// A 'kitchen'/'bar' team account keeps whatever pos_role rank it has (still governs voids/comps/
// reports the same as always) but sees only the ticket display in its sidebar, locked to that
// station's queue — see Layout.js's KITCHEN_TEAM_ALLOWED_PATHS and KitchenDisplay.jsx.
const TEAM_OPTIONS = [
  { value: 'foh',     label: 'Front of House' },
  { value: 'kitchen', label: 'Kitchen' },
  { value: 'bar',     label: 'Bar' },
]
const EMPTY_ADD   = { full_name: '', pin: '', job_title: '', employee_id: '', team: 'foh' }
const EMPTY_ROLE  = { label: '', level: 'staff' }

function pinValid(pin) { return /^\d{4,6}$/.test(pin) }

// admin-user-ops answers a refusal in the body as `{ error: '<a sentence we wrote>' }`, sometimes
// with a 2xx and sometimes as a non-2xx whose body supabase-js leaves on `error.context`. That
// sentence is copy, not a Postgres shape, so it is shown as written — running it through errorText
// would flatten it to "that didn't work" (S714). Only a failure with no body — a dropped
// connection, a function that never answered — goes through the table (S754).
async function edgeRefusal(error, data) {
  if (data?.error) return data.error
  try { const b = await error?.context?.json(); if (b?.error) return b.error } catch (_) { /* no JSON body */ }
  return error ? errorLine(error) : ''
}

export default function PosStaff() {
  const { clientId, hasPosAccess, hrEnabled, isAdmin, isOwner, profile } = useAuth()
  // What this viewer may hand out (S754 — mirrors admin-user-ops' refusePosPowerEscalation and
  // requireManageableTarget, so the screen offers only what the server will accept). Admin and the
  // Owner are unbounded. A POS manager: never Manager rank, never their own login or a peer
  // manager's, a discount limit no higher than their own (NULL = unlimited), Void only if they have it.
  const canGrantAnything = isAdmin || isOwner
  const viewerCap = canGrantAnything || profile?.pos_discount_limit === null || profile?.pos_discount_limit === undefined
    ? null : Number(profile.pos_discount_limit)
  const viewerCanVoid = canGrantAnything || profile?.pos_allow_void === true
  const permissionLevels = canGrantAnything ? PERMISSION_LEVELS : PERMISSION_LEVELS.filter(l => l.value !== 'manager')
  // A row this viewer may not change at all. Mirrors requireManageableTarget: own row and any
  // other manager's row are the Owner's or the operator's.
  const rowLockReason = p => {
    if (canGrantAnything) return ''
    if (p.id === profile?.id) return 'Your own login is changed by the account owner.'
    if (p.pos_role === 'manager') return 'A manager’s login is changed by the account owner.'
    return ''
  }
  const { scopedFrom } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()
  const [staff,       setStaff]       = useState([])
  const [employees,   setEmployees]   = useState([]) // hr_employees, only fetched when hrEnabled
  const [loading,     setLoading]     = useState(true)
  const [loadError,   setLoadError]   = useState(null)   // the staff list or the role scheme could not be read (S754)
  const [empWarn,     setEmpWarn]     = useState('')     // the HR employee list for + Add Staff could not be read
  const [saving,      setSaving]      = useState({})
  const [msg,         setMsg]         = useState('')
  const [search,      setSearch]      = useState('')

  // Custom roles
  const [customRoles, setCustomRoles] = useState([])
  const [rolesModal,  setRolesModal]  = useState(false)
  const [newRole,     setNewRole]     = useState(EMPTY_ROLE)
  const [rolesSaving, setRolesSaving] = useState(false)
  const [rolesError,  setRolesError]  = useState('')

  // Add staff modal
  const [addModal,    setAddModal]    = useState(false)
  const [addForm,     setAddForm]     = useState(EMPTY_ADD)
  const [addMode,     setAddMode]     = useState('hr') // 'hr' | 'manual' — only relevant when hrEnabled
  const [adding,      setAdding]      = useState(false)
  const [addMsg,      setAddMsg]      = useState('')

  // Reset PIN modal
  const [pinTarget,   setPinTarget]   = useState(null)
  const [newPin,      setNewPin]      = useState('')
  const [resetting,   setResetting]   = useState(false)
  const [pinMsg,      setPinMsg]      = useState('')
  // Bumped to throw away an uncontrolled discount input's typed value after a refusal (S754).
  const [inputEpoch,  setInputEpoch]  = useState(0)

  const effectiveRoles = customRoles.length > 0 ? customRoles : DEFAULT_ROLES
  const linkedEmployeeIds = new Set(staff.map(p => p.hr_employee_id).filter(Boolean))
  const unlinkedEmployees = employees.filter(e => !linkedEmployeeIds.has(e.id))
  // One filter, not two. The table wrote the same chain twice — once for its empty check and
  // once for its rows — and re-lowercased the search term inside each pass, per row, per
  // keystroke.
  const staffQuery = search.trim().toLowerCase()
  const visibleStaff = staffQuery
    ? staff.filter(p => (p.full_name || '').toLowerCase().includes(staffQuery))
    : staff

  useEffect(() => { if (clientId) init() }, [clientId]) // eslint-disable-line

  // Escape-to-close — none of this file's 3 hand-rolled overlays use the shared Modal.js
  // component, so each needs its own listener; only one is ever open at a time in practice.
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key !== 'Escape') return
      if (rolesModal) setRolesModal(false)
      else if (addModal && !adding) setAddModal(false)
      else if (pinTarget && !resetting) setPinTarget(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [rolesModal, addModal, adding, pinTarget, resetting])

  async function init() {
    setLoading(true)
    setLoadError(null)
    const [staffRes, settingsRes, empRes] = await Promise.all([
      supabase.rpc('get_pos_staff_list', { p_client_id: clientId }),
      // maybeSingle: a client with no settings row yet is not a failed read. `.single()` turned
      // that case into an error, and the error was dropped along with every real one.
      supabase.from('settings').select('pos_custom_roles').eq('client_id', clientId).maybeSingle(),
      hrEnabled
        ? scopedFrom('hr_employees', 'id, full_name, employee_code, status').in('status', ['active', 'probation']).order('full_name')
        : Promise.resolve({ data: [], error: null }),
    ])
    // S754, the HrStaff shape. Every read error here was dropped: a failed staff read rendered
    // "No staff yet — create your first POS account" over logins that exist, and a failed settings
    // read left effectiveRoles on DEFAULT_ROLES — so adding a role saved [defaults + new] over the
    // stored custom scheme, and the mismatch banner offered to re-rank every custom-titled login
    // against a scheme it had never read. Nothing below renders, and no scheme edit is reachable,
    // until both have loaded.
    const readErr = staffRes.error || settingsRes.error
    if (readErr) {
      const e = asActionError(readErr)
      const what = staffRes.error ? 'The staff list' : "This team's role list"
      setLoadError({ text: `${what} could not be loaded, so nothing below is shown and roles cannot be changed. ` + e.text, detail: e.detail })
      setLoading(false)
      return
    }
    const saved = settingsRes.data?.pos_custom_roles
    setCustomRoles(saved?.length ? saved : [])
    setStaff(staffRes.data || [])
    setEmployees(empRes.error ? [] : (empRes.data || []))
    setEmpWarn(empRes.error
      ? 'The HR employee list could not be loaded, so + Add Staff can only create POS-only staff until the page is reloaded.'
      : '')
    setLoading(false)
    // No re-ranking here (S752). This page used to move every login whose level no longer matched
    // its role the moment anyone opened it; a mismatch is now shown and moves only on Apply.
  }

  // Logins whose stored level no longer matches the level their role carries.
  const mismatched = useMemo(() => staff.filter(p => {
    if (!p.pos_job_title) return false
    const expected = effectiveRoles.find(r => r.label === p.pos_job_title)?.level
    return expected && expected !== p.pos_role
  }), [staff, effectiveRoles])

  function applyMismatches() {
    const list = mismatched
    const levelOf = p => effectiveRoles.find(r => r.label === p.pos_job_title)?.level
    askConfirm({
      title: `Change the access level of ${list.length} login${list.length === 1 ? '' : 's'}?`,
      confirmLabel: 'Change Access', busyLabel: 'Changing…',
      body: (
        <div>
          <p style={{ margin: 0 }}>Each login below moves to the level its role now carries.</p>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {list.map(p => <li key={p.id}>{p.full_name}: {p.pos_role || 'no level'} → {levelOf(p)}</li>)}
          </ul>
        </div>
      ),
      run: async () => {
        setMsg('')
        const outcomes = await Promise.all(list.map(async p => {
          const level = levelOf(p)
          const { data, error } = await supabase.functions.invoke('admin-user-ops', {
            body: { action: 'update_pos_role', userId: p.id, pos_role: level, pos_job_title: p.pos_job_title },
          })
          if (!error && !data?.error) setStaff(prev => prev.map(s => s.id === p.id ? { ...s, pos_role: level } : s))
          return { p, failed: !!(error || data?.error) }
        }))
        const failed = outcomes.filter(o => o.failed)
        if (failed.length > 0) {
          setMsg(`${failed.length} login(s) could not be moved and keep their previous access: ` +
            failed.map(o => o.p.full_name).join(', ') + '.')
        }
      },
    })
  }

  async function load() {
    const { data, error } = await supabase.rpc('get_pos_staff_list', { p_client_id: clientId })
    // A failed read is not "no POS staff" (S682): keep the last-good list and say so.
    if (error) { setMsg('Could not load the staff list — what is shown is from the last successful load. ' + errorLine(error)); return }
    setStaff(data || [])
  }

  async function saveRoles(roles) {
    if (!clientId) return false   // never write a client_id:null (global-defaults) settings row during the admin no-client window
    // A scheme that was never read cannot be written back: `roles` would be built from the
    // defaults and overwrite the stored list (S754).
    if (loading || loadError) { setRolesError("The role list hasn't loaded, so roles can't be changed yet. Reload the page and try again."); return false }
    setRolesSaving(true); setRolesError('')
    // maybeSingle + an error check: with .single() a missing row and a failed read both arrived as
    // an error that was dropped, so any failed read fell into the INSERT branch and wrote a second
    // settings row for the client (the S613 trap), splitting every settings read after it.
    const { data: existing, error: exErr } = await supabase
      .from('settings').select('id').eq('client_id', clientId).maybeSingle()
    if (exErr) { setRolesError('Could not check the existing settings row, so nothing was saved. ' + errorLine(exErr)); setRolesSaving(false); return false }
    let err
    if (existing) {
      const { error } = await supabase.from('settings').update({ pos_custom_roles: roles }).eq('id', existing.id)
      err = error
    } else {
      const { error } = await supabase.from('settings').insert({ client_id: clientId, pos_custom_roles: roles })
      err = error
    }
    if (err) { setRolesError('The role list was not saved. ' + errorLine(err)); setRolesSaving(false); return false }
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
    const affected = staff.filter(p => p.pos_job_title === changedLabel && p.pos_role !== level)
    // One Edge Function call per affected account, none of them dependent on any other, so the
    // manager waits on the slowest rather than on the sum.
    const outcomes = await Promise.all(affected.map(async p => {
      const { data, error } = await supabase.functions.invoke('admin-user-ops', {
        body: { action: 'update_pos_role', userId: p.id, pos_role: level, pos_job_title: changedLabel },
      })
      // S754: admin-user-ops can answer 2xx with `{ error }` in the body; only `error` was checked,
      // so a refused move still showed the new level on the row.
      const failed = !!(error || data?.error)
      if (!failed) setStaff(prev => prev.map(s => s.id === p.id ? { ...s, pos_role: level } : s))
      return { p, failed }
    }))
    const failed = outcomes.filter(o => o.failed)
    if (failed.length > 0) {
      // The role itself saved; say which logins did not follow it. They show in the mismatch
      // banner, where Apply role levels can retry them.
      setRolesError(`“${changedLabel}” now carries ${level}, but ${failed.length} login(s) could not be moved and keep their previous access: ` +
        failed.map(o => o.p.full_name).join(', ') + '.')
    }
  }

  // The first custom role starts FROM the defaults, and a role a login holds cannot be removed —
  // either would leave a row's role select blank beside a badge that still names a level (S729/S752).
  async function addCustomRole() {
    const label = newRole.label.trim()
    if (!label) return
    const base = customRoles.length > 0 ? customRoles : DEFAULT_ROLES
    if (base.some(r => r.label.toLowerCase() === label.toLowerCase())) {
      setRolesError(`There is already a role called “${label}”.`); return
    }
    const ok = await saveRoles([...base, { label, level: newRole.level }])
    if (ok) setNewRole(EMPTY_ROLE)   // keep what was typed if the save failed
  }

  function deleteCustomRole(i) {
    const label = customRoles[i].label
    const holders = staff.filter(p => p.pos_job_title === label)
    if (holders.length > 0) {
      setRolesError(`${holders.length} login(s) still hold the “${label}” role — ${holders.map(p => p.full_name).join(', ')}. Move them to another role first.`)
      return
    }
    saveRoles(customRoles.filter((_, idx) => idx !== i))
  }

  function resetToDefaults() {
    const orphans = staff.filter(p => p.pos_job_title && !DEFAULT_ROLES.some(d => d.label === p.pos_job_title))
    if (orphans.length > 0) {
      setRolesError(`${orphans.length} login(s) hold a custom role — ${orphans.map(p => p.full_name).join(', ')}. Move them to Staff, Supervisor or Manager first, then reset.`)
      return
    }
    saveRoles([])
  }

  // ── Add staff ──────────────────────────────────────────────────────────────
  function openAdd() {
    setAddForm({ ...EMPTY_ADD, job_title: effectiveRoles[0]?.label || '' })
    setAddMode(hrEnabled && unlinkedEmployees.length > 0 ? 'hr' : 'manual')
    setAddMsg(''); setAddModal(true)
  }

  async function addStaff() {
    if (addMode === 'hr') {
      if (!addForm.employee_id) { setAddMsg('Select an employee.'); return }
    } else if (!addForm.full_name.trim()) { setAddMsg('Name is required.'); return }
    if (!pinValid(addForm.pin))    { setAddMsg('PIN must be 4–6 digits.'); return }
    const role = effectiveRoles.find(r => r.label === addForm.job_title)
    if (!role) { setAddMsg('Select a role.'); return }
    if (role.level === 'manager' && !canGrantAnything) { setAddMsg('Only the account owner can give a login Manager access. Pick a Staff or Supervisor role.'); return }
    setAdding(true); setAddMsg('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: {
        action:        'create_pos_staff',
        client_id:     clientId,
        ...(addMode === 'hr' ? { employee_id: addForm.employee_id } : { full_name: addForm.full_name.trim() }),
        pin:           addForm.pin,
        pos_role:      role.level,
        pos_job_title: addForm.job_title,
        pos_team:      addForm.team,
        // A new login starts with NO discount (owner decision, S776) — the column's blank is
        // "unlimited", the least safe starting point for a login nobody has thought about yet. A
        // manager sets a cap in the Discount % column when this person should be able to discount.
        pos_discount_limit: 0,
      },
    })
    if (error || data?.error) {
      setAddMsg((await edgeRefusal(error, data)) || 'The login was not created.'); setAdding(false); return
    }
    setAddModal(false); setAdding(false); load()
  }

  // ── Delete staff ───────────────────────────────────────────────────────────
  // Deleting a PIN login is irreversible, so the ask is the product's own dialog (S682).
  function deleteStaff(p) {
    askConfirm({
      title: `Delete ${p.full_name}'s POS login?`,
      confirmLabel: 'Delete Login', danger: true, busyLabel: 'Deleting…',
      body: (
        <p style={{ margin: 0 }}>
          {p.full_name}'s PIN stops working at the till immediately. Bills they closed keep their name on the audit trail and
          the Sales Exception Report. To give them access again later you will create a new login with a new PIN. This
          cannot be undone.
        </p>
      ),
      run: async () => {
        setMsg('')
        const { data, error } = await supabase.functions.invoke('admin-user-ops', {
          body: { action: 'delete_pos_staff', userId: p.id },
        })
        if (error || data?.error) {
          const why = await edgeRefusal(error, data)
          // Only a refusal the function WROTE proves the login survived; a dropped call does not.
          const answered = !!data?.error || error?.name === 'FunctionsHttpError'
          setMsg(answered
            ? `${p.full_name}'s login was not deleted — their PIN still works. ` + why
            : `It is not known whether ${p.full_name}'s login was deleted — the call did not come back. Reload the page to see. ` + why)
          if (!answered) load()
          return
        }
        load()
      },
    })
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
      setPinMsg((await edgeRefusal(error, data)) || 'The PIN was not changed.'); setResetting(false); return
    }
    setPinTarget(null); setResetting(false)
  }

  // ── Role update ────────────────────────────────────────────────────────────
  async function updateRole(profileId, jobTitle) {
    const role = effectiveRoles.find(r => r.label === jobTitle)
    // Never send "no role": a login with no marker reads as the Owner (S752). Removing someone's
    // POS access means deleting the login.
    if (!role) { setMsg(`“${jobTitle}” is not a role in this team's scheme any more — pick one from the list.`); return }
    if (role.level === 'manager' && !canGrantAnything) { setMsg('Only the account owner can give a login Manager access.'); return }
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
      setMsg(`${staff.find(s => s.id === profileId)?.full_name || 'That login'} keeps its previous role. ` + (await edgeRefusal(error, data)))
    } else {
      setStaff(prev => prev.map(p => p.id === profileId
        ? { ...p, pos_role: role?.level || null, pos_job_title: jobTitle || null }
        : p
      ))
    }
    setSaving(s => ({ ...s, [profileId]: false }))
  }

  // ── Team update ────────────────────────────────────────────────────────────
  async function updateTeam(profileId, team) {
    setSaving(s => ({ ...s, [profileId]: true })); setMsg('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: { action: 'update_pos_role', userId: profileId, pos_team: team },
    })
    if (error || data?.error) {
      setMsg('The team was not changed. ' + (await edgeRefusal(error, data)))
    } else {
      setStaff(prev => prev.map(p => p.id === profileId ? { ...p, pos_team: team } : p))
    }
    setSaving(s => ({ ...s, [profileId]: false }))
  }

  // ── Discount limit update ────────────────────────────────────────────────────
  // null = unlimited (current behavior). Committed on blur, not per keystroke.
  async function updateDiscountLimit(profileId, rawValue) {
    const trimmed = (rawValue ?? '').toString().trim()
    const limit = trimmed === '' ? null : Math.min(100, Math.max(0, parseFloat(trimmed)))
    if (trimmed !== '' && Number.isNaN(limit)) return
    // S754: a capped manager cannot give more than their own cap, and "no limit" is more than any
    // cap. Said here, before the call, rather than as the server's refusal after it.
    if (viewerCap !== null && (limit === null || limit > viewerCap)) {
      setMsg(`You can give a discount limit of up to ${viewerCap}% — your own limit. ${limit === null ? '"No limit" is more than that. ' : ''}Ask the account owner for more.`)
      setInputEpoch(n => n + 1)   // re-key the input back to the stored value
      return
    }
    setSaving(s => ({ ...s, [profileId]: true })); setMsg('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: { action: 'update_pos_role', userId: profileId, pos_discount_limit: limit },
    })
    if (error || data?.error) {
      setMsg('The discount limit was not changed. ' + (await edgeRefusal(error, data)))
      setInputEpoch(n => n + 1)
    } else {
      setStaff(prev => prev.map(p => p.id === profileId ? { ...p, pos_discount_limit: limit } : p))
    }
    setSaving(s => ({ ...s, [profileId]: false }))
  }

  // ── Allow Void update ────────────────────────────────────────────────────────
  async function updateAllowVoid(profileId, allow) {
    setSaving(s => ({ ...s, [profileId]: true })); setMsg('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: { action: 'update_pos_role', userId: profileId, pos_allow_void: allow },
    })
    if (error || data?.error) {
      setMsg('Void permission was not changed. ' + (await edgeRefusal(error, data)))
    } else {
      setStaff(prev => prev.map(p => p.id === profileId ? { ...p, pos_allow_void: allow } : p))
    }
    setSaving(s => ({ ...s, [profileId]: false }))
  }

  if (!hasPosAccess('manager')) return <Navigate to="/pos/tables" replace />

  const inputStyle = {
    width: '100%', boxSizing: 'border-box', padding: '8px 10px',
    background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
    borderRadius: 'var(--radius-sm)', color: 'var(--theme-text1)', fontSize: 13, outline: 'none',
  }
  const labelStyle = { fontSize: 12, color: 'var(--theme-text2)', marginBottom: 4, display: 'block' }

  return (
    <div>

      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">POS Staff</h1>
          <p className="page-subtitle">
            Assign roles to your team. Staff log in with their name and PIN.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexShrink: 0, flexWrap: 'wrap' }}>
          <input aria-label="Search staff"
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search staff…" className="form-input form-input--auto" style={{ maxWidth: 180 }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" style={{ whiteSpace: 'nowrap' }} onClick={() => setRolesModal(true)} disabled={loading || !!loadError}>
              Manage Roles
            </button>
            <button className="btn btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={openAdd} disabled={loading || !!loadError}>
              + Add Staff
            </button>
          </div>
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

      {msg && <p role="alert" style={{ fontSize: 13, color: 'var(--theme-red-text)', marginBottom: 16 }}>{msg}</p>}
      {!loading && !loadError && empWarn && <p role="status" style={{ fontSize: 12, color: 'var(--theme-amber-text)', marginBottom: 16 }}>{empWarn}</p>}
      {!loading && !loadError && mismatched.length > 0 && (
        <div role="alert" className="card" style={{
          padding: '12px 16px', marginBottom: 16,
          border: '1px solid color-mix(in srgb, var(--theme-amber) 35%, transparent)',
          background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-amber-text)' }}>
              △ {mismatched.length} login{mismatched.length === 1 ? '' : 's'} carry an access level their role no longer has
            </div>
            <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 2 }}>
              {mismatched.map(p => p.full_name).join(', ')}. Their access has not changed — nothing moves until you apply it.
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={applyMismatches}>Apply role levels…</button>
        </div>
      )}
      {confirmEl}

      {loading ? (
        <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
      ) : loadError ? (
        <div>
          <ActionError error={loadError} />
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={init}>Try again</button>
        </div>
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
                <th><Tip text="Which station this login works. Kitchen/Bar accounts see only the ticket display, locked to their own queue — everything front-of-house (Orders, Tables, Customers, Shifts) is hidden regardless of Access Level.">Team</Tip></th>
                <th><Tip text="Maximum discount % this login can apply at billing. A new login starts at 0 (no discount). Clear the box for no limit.">Discount %</Tip></th>
                <th><Tip text="Lets this login void a bill themselves, without needing the Owner/Admin.">Void</Tip></th>
                <th><Tip text="Last time this user was active in the app">Last Seen</Tip></th>
                {/* Sticky right — the same treatment Stock Count's COGS and Purchases' Total
                    columns get. This table is 8 columns wide and overflowed its wrap by 30px at
                    1280 and 270px at 768, so Delete rendered clipped and Reset PIN scrolled off
                    entirely on a tablet. An opaque background is required or the scrolled-away
                    columns show through underneath. */}
                <th style={{ width: 200, position: 'sticky', right: 0, background: 'var(--theme-card)', zIndex: 2 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleStaff.length === 0 && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--theme-text2)', padding: 24 }}>No staff match "{search}".</td></tr>
              )}
              {visibleStaff.map(p => {
                // S754, the HrStaff shape: the row's title exactly as stored. A title the scheme no
                // longer defines is its own option, so the select shows the truth — it used to
                // render blank, or a login with no title showed the first role sharing its level,
                // a role it was never given.
                const displayTitle = p.pos_job_title || (p.pos_role ? `${p.pos_role.charAt(0).toUpperCase() + p.pos_role.slice(1)} (no role name)` : '')
                const orphan = !!displayTitle && !effectiveRoles.some(r => r.label === displayTitle)
                // S754: a row the viewer may not change renders read-only, with the reason on hover,
                // rather than as live controls the server then refuses one at a time.
                const lockReason = rowLockReason(p)
                const rowDisabled = !!saving[p.id] || !!lockReason
                const blocked = p.settlement_blocked === true
                return (
                  <tr key={p.id}>
                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{p.full_name || '—'}</div>
                      {blocked && (
                        <Tip text="This person's Final Settlement blocked their logins, so this PIN no longer signs in and they are off the till's staff picker. The login is kept so every bill and shift they recorded keeps their name.">
                          <span className="badge badge-gray" style={{ fontSize: 10, marginRight: 6 }}>Blocked at settlement</span>
                        </Tip>
                      )}
                      {lockReason && !blocked && (
                        <Tip text={lockReason}>
                          <span style={{ fontSize: 10, color: 'var(--theme-text3)', marginRight: 6 }}>Owner changes this login</span>
                        </Tip>
                      )}
                      {p.hr_employee_id && (
                        <Tip text="This POS login is linked to an HR employee record — name stays in sync with HR.">
                          <span style={{ fontSize: 10, color: 'var(--theme-text3)' }}>🔗 HR{p.employee_code ? ` · ${p.employee_code}` : ''}</span>
                        </Tip>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <select aria-label="POS role"
                          className="form-select"
                          style={{ minWidth: 160 }}
                          value={displayTitle || ''}
                          disabled={rowDisabled}
                          title={lockReason || undefined}
                          onChange={e => updateRole(p.id, e.target.value)}
                        >
                          {!displayTitle && <option value="" disabled>— pick a role —</option>}
                          {orphan && <option value={displayTitle} disabled>{displayTitle} — not in the role list</option>}
                          {/* A Manager-level role is the Owner's to give (S754); kept as an option so a
                              row already holding one still displays it, but not pickable. */}
                          {effectiveRoles.map(r => (
                            <option key={r.label} value={r.label} disabled={r.level === 'manager' && !canGrantAnything}>
                              {r.label}{r.level === 'manager' && !canGrantAnything ? ' (Owner only)' : ''}
                            </option>
                          ))}
                        </select>
                        {saving[p.id] && <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Saving…</span>}
                        {orphan && !saving[p.id] && (
                          <Tip text="This login's role is not in the team's role list, so its access level is no longer tied to anything. Pick a current role to put it back under one.">
                            <span className="badge badge-amber">△ orphan</span>
                          </Tip>
                        )}
                      </div>
                    </td>
                    <td>
                      {p.pos_role
                        ? <span className={LEVEL_BADGE[p.pos_role] || STAFF_LEVEL_BADGE_NONE} style={{ fontSize: 11 }}>
                            {p.pos_role.charAt(0).toUpperCase() + p.pos_role.slice(1)}
                          </span>
                        : <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>—</span>
                      }
                    </td>
                    <td>
                      <select aria-label="POS team"
                        className="form-select"
                        style={{ minWidth: 140 }}
                        value={p.pos_team || 'foh'}
                        disabled={rowDisabled}
                        title={lockReason || undefined}
                        onChange={e => updateTeam(p.id, e.target.value)}
                      >
                        {TEAM_OPTIONS.map(t => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input aria-label="Discount limit percent"
                          type="number"
                          min={0}
                          max={viewerCap ?? 100}
                          step={1}
                          className="form-input"
                          style={{ width: 70 }}
                          placeholder={viewerCap !== null ? `≤ ${viewerCap}` : 'No limit'}
                          disabled={rowDisabled}
                          title={lockReason || (viewerCap !== null ? `You can give up to ${viewerCap}% — your own limit.` : undefined)}
                          defaultValue={p.pos_discount_limit ?? ''}
                          key={`${p.id}-${p.pos_discount_limit ?? 'none'}-${inputEpoch}`}
                          onBlur={e => {
                            if (e.target.value === (p.pos_discount_limit ?? '').toString()) return
                            updateDiscountLimit(p.id, e.target.value)
                          }}
                        />
                        <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>%</span>
                      </div>
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Allow ${p.full_name || 'this account'} to void bills`}
                        checked={!!p.pos_allow_void}
                        // Void is only the viewer's to give if they hold it; taking it away is always
                        // allowed on a row they manage (S754).
                        disabled={rowDisabled || (!p.pos_allow_void && !viewerCanVoid)}
                        title={lockReason || (!p.pos_allow_void && !viewerCanVoid ? 'Your own login cannot void bills, so you cannot give Void permission. Ask the account owner.' : undefined)}
                        onChange={e => updateAllowVoid(p.id, e.target.checked)}
                      />
                    </td>
                    {/* BS first, the calendar the owner reads (S776); AD in the title. Both pinned to Nepal. */}
                    <td style={{ fontSize: 12, color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}
                      title={p.last_seen_at ? nepalDateLong(p.last_seen_at) : undefined}>
                      {p.last_seen_at
                        ? (nepalBsLong(p.last_seen_at) || nepalDateLong(p.last_seen_at))
                        : '—'}
                    </td>
                    <td style={{ position: 'sticky', right: 0, background: 'var(--theme-card)' }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        {/* A settlement-blocked login cannot sign in whatever its PIN, so a new PIN
                            would only look like access restored (S754). */}
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => openReset(p)}
                          disabled={blocked || !!lockReason}
                          title={blocked ? 'Blocked at Final Settlement — a new PIN would not let them sign in.' : lockReason || undefined}>
                          Reset PIN
                        </button>
                        <button
                          className="btn btn-ghost"
                          style={{ fontSize: 12, padding: '4px 10px', color: 'var(--theme-red-text)', borderColor: 'var(--theme-red)' }}
                          onClick={() => deleteStaff(p)}
                          disabled={!!lockReason}
                          title={lockReason || undefined}
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
        <Modal title="Manage POS Roles" onClose={() => setRolesModal(false)} maxWidth={480}>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--theme-text3)' }}>
              Define custom role names for your team. Each maps to a permission level.
            </p>

            {rolesError && <p role="alert" style={{ color: 'var(--theme-red-text)', fontSize: 12, margin: '-8px 0 12px' }}>{rolesError}</p>}

            {customRoles.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--theme-text3)', fontStyle: 'italic', marginBottom: 16 }}>
                Using default roles (Staff / Supervisor / Manager)
              </p>
            ) : (
              <div style={{ marginBottom: 16 }}>
                {customRoles.map((r, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--theme-border-lt)' }}>
                    <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)' }}>{r.label}</span>
                    <select aria-label={`Permission level for ${r.label}`}
                      className="form-select"
                      style={{ width: 120, fontSize: 12 }}
                      value={r.level}
                      onChange={e => updateCustomRoleLevel(i, e.target.value)}
                      disabled={rolesSaving}
                    >
                      {PERMISSION_LEVELS.map(l => (
                        <option key={l.value} value={l.value} disabled={l.value === 'manager' && !canGrantAnything}>{l.label}</option>
                      ))}
                    </select>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 12, padding: '3px 8px', color: 'var(--theme-red-text)', borderColor: 'var(--theme-red)' }}
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
                <label style={labelStyle} htmlFor="pos-staff-role-name">Role Name</label>
                <input id="pos-staff-role-name"
                  style={inputStyle}
                  placeholder="e.g. Cashier, Bartender…"
                  value={newRole.label}
                  onChange={e => setNewRole(r => ({ ...r, label: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && addCustomRole()}
                />
              </div>
              <div style={{ width: 140 }}>
                <label style={labelStyle} htmlFor="pos-staff-permission-level">Permission Level</label>
                <select id="pos-staff-permission-level"
                  className="form-select"
                  style={{ width: '100%' }}
                  value={newRole.level}
                  onChange={e => setNewRole(r => ({ ...r, level: e.target.value }))}
                >
                  {permissionLevels.map(l => (
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
        </Modal>
      )}

      {/* ── Add Staff modal ──────────────────────────────────────────────────── */}
      {addModal && (
        <Modal title="Add Staff Member" onClose={() => { if (!adding) setAddModal(false) }} maxWidth={380}>

            {hrEnabled && (
              <div className="tab-bar" style={{ marginBottom: 16 }}>
                <button className={`tab-btn${addMode === 'hr' ? ' tab-btn--active' : ''}`} onClick={() => setAddMode('hr')}>HR Employee</button>
                <button className={`tab-btn${addMode === 'manual' ? ' tab-btn--active' : ''}`} onClick={() => setAddMode('manual')}>POS-only Staff</button>
              </div>
            )}

            {addMode === 'hr' ? (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle} htmlFor="pos-staff-hr-employee">
                  <Tip text="Links this POS login to an existing HR employee record — their name stays in sync with HR, and payroll/attendance can be matched to the same person.">HR Employee</Tip>
                </label>
                {empWarn ? (
                  <p role="alert" style={{ fontSize: 12, color: 'var(--theme-amber-text)', margin: 0 }}>{empWarn}</p>
                ) : unlinkedEmployees.length === 0 ? (
                  <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: 0 }}>
                    Every active HR employee already has POS access — add one in HR → Employees first, or switch to POS-only Staff.
                  </p>
                ) : (
                  <SearchableSelect
                    id="pos-staff-hr-employee"
                    options={unlinkedEmployees.map(e => ({ value: e.id, label: `${e.full_name}${e.employee_code ? ` (${e.employee_code})` : ''}` }))}
                    value={addForm.employee_id} onChange={v => setAddForm(f => ({ ...f, employee_id: v }))}
                    placeholder="Select employee…"
                  />
                )}
              </div>
            ) : (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle} htmlFor="pos-staff-full-name">Full Name</label>
                <input id="pos-staff-full-name"
                  style={inputStyle}
                  placeholder="e.g. Ram Bahadur"
                  value={addForm.full_name}
                  onChange={e => setAddForm(f => ({ ...f, full_name: e.target.value }))}
                  autoFocus
                />
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle} htmlFor="pos-staff-pin">
                <Tip text="Staff enter this PIN on the POS login screen. 4–6 digits only.">PIN</Tip>
              </label>
              <input id="pos-staff-pin"
                style={inputStyle}
                type="password"
                autoComplete="new-password"
                inputMode="numeric"
                maxLength={6}
                placeholder="4–6 digit PIN"
                value={addForm.pin}
                onChange={e => setAddForm(f => ({ ...f, pin: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle} htmlFor="pos-staff-role">
                <Tip text="The role shown on the POS login screen. Permission level is shown in brackets.">Role</Tip>
              </label>
              <select id="pos-staff-role"
                className="form-select"
                style={{ width: '100%' }}
                value={addForm.job_title}
                onChange={e => setAddForm(f => ({ ...f, job_title: e.target.value }))}
              >
                {effectiveRoles.map(r => (
                  <option key={r.label} value={r.label} disabled={r.level === 'manager' && !canGrantAnything}>
                    {r.label} ({r.level.charAt(0).toUpperCase() + r.level.slice(1)}){r.level === 'manager' && !canGrantAnything ? ' — Owner only' : ''}
                  </option>
                ))}
              </select>
              <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '6px 0 0' }}>
                A new login starts with a 0% discount limit and without Void permission — set both in the
                list once it is created.{!canGrantAnything && viewerCap !== null ? ` You can give up to ${viewerCap}%, your own limit.` : ''}
              </p>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle} htmlFor="pos-staff-team">
                <Tip text="Which station this login works. Kitchen/Bar accounts see only the ticket display, locked to their own queue.">Team</Tip>
              </label>
              <select id="pos-staff-team"
                className="form-select"
                style={{ width: '100%' }}
                value={addForm.team}
                onChange={e => setAddForm(f => ({ ...f, team: e.target.value }))}
              >
                {TEAM_OPTIONS.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            {addMsg && <p role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)', marginBottom: 12 }}>{addMsg}</p>}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setAddModal(false)} disabled={adding}>Cancel</button>
              <button className="btn btn-primary" onClick={addStaff} disabled={adding}>
                {adding ? 'Creating…' : 'Add Staff'}
              </button>
            </div>
        </Modal>
      )}

      {/* ── Reset PIN modal ──────────────────────────────────────────────────── */}
      {pinTarget && (
        <Modal title="Reset PIN" onClose={() => { if (!resetting) setPinTarget(null) }} maxWidth={340}>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--theme-text3)' }}>
              New PIN for <strong style={{ color: 'var(--theme-text1)' }}>{pinTarget.full_name}</strong>
            </p>
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle} htmlFor="pos-staff-new-pin-4-6-digits">New PIN (4–6 digits)</label>
              <input id="pos-staff-new-pin-4-6-digits"
                style={inputStyle}
                type="password"
                autoComplete="new-password"
                inputMode="numeric"
                maxLength={6}
                placeholder="4–6 digit PIN"
                value={newPin}
                autoFocus
                onChange={e => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </div>
            {pinMsg && <p role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)', marginBottom: 12 }}>{pinMsg}</p>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setPinTarget(null)} disabled={resetting}>Cancel</button>
              <button className="btn btn-primary" onClick={resetPin} disabled={resetting}>
                {resetting ? 'Saving…' : 'Save PIN'}
              </button>
            </div>
        </Modal>
      )}
    </div>
  )
}
