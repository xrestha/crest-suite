import { useState, useEffect, useMemo, useRef } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import SearchableSelect from '../../../components/SearchableSelect'
import Modal from '../../../components/Modal'
import ActionError, { asActionError } from '../../../components/ActionError'
import { STAFF_LEVEL_BADGE as LEVEL_BADGE, STAFF_LEVEL_BADGE_NONE } from '../../../shared/staffLevelBadge'
import { errorLine } from '../../../shared/errorText'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { MIN_PASSWORD_LENGTH, weakPasswordReason } from '../../../utils/weakPasswords'

// Mirrors src/modules/pos/staff/PosStaff.jsx structurally — same role model, same custom-role
// mapping, same Edge Function call pattern — adapted for real email+password login instead of a
// shared-device PIN (S417 IMS staff roles). See CLAUDE.md's POS role system note for the pattern
// this was built from. HrStaff.jsx was mirrored FROM this file and then swept (S628) while this
// one was not; S729 brought the two back level.
const PERMISSION_LEVELS = [
  { value: 'staff',      label: 'Staff',      desc: 'Purchases, Stock Count, Sales Entry, Requisitions, Gate Passes' },
  { value: 'supervisor', label: 'Supervisor',  desc: 'Staff + Periods, Item Master, Vendors, Purchase Orders, Recipe Costing, all Stock/Summary reports' },
  { value: 'manager',    label: 'Manager',     desc: 'Supervisor + Menu Pricing, Menu Engineering, Overheads, Finance and Menu & Vendor reports, Settings, staff role assignment' },
]
const DEFAULT_ROLES = [
  { label: 'Staff',      level: 'staff' },
  { label: 'Supervisor', level: 'supervisor' },
  { label: 'Manager',    level: 'manager' },
]
const EMPTY_ADD   = { full_name: '', email: '', password: '', job_title: '', employee_id: '', existing_user_id: '', pin: '' }
const EMPTY_ROLE  = { label: '', level: 'staff' }

function emailValid(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) }
// The product's one password policy (S534): the floor from weakPasswords.js, then the offline
// blocklist. This page mints real /login credentials, so it takes the same check Signup and
// Reset Password do — until S729 it accepted "password" and "12345678" on a hardcoded length.
function passwordProblem(pw, context) {
  if (pw.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  return weakPasswordReason(pw, context)
}
const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '')
const names = list => list.map(p => p.full_name || p.email).join(', ')

// Every admin-user-ops failure arrives the same three ways; one reader for all of them.
async function invokeDetail(data, error, fallback) {
  let detail = data?.error || error?.message || fallback
  try { const b = await error?.context?.json(); detail = b?.error || detail } catch (_) {}
  return detail
}

export default function ImsStaff() {
  const { clientId, hasImsAccess, hrEnabled, session, profile, adminViewClientName } = useAuth()
  const { scopedFrom } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()
  const [staff,         setStaff]         = useState([])
  const [employees,     setEmployees]     = useState([]) // hr_employees, only fetched when hrEnabled
  const [eligibleUsers, setEligibleUsers] = useState([]) // existing client accounts with no pos_role/hr_self_service/ims_role yet
  const [loading,     setLoading]     = useState(true)
  const [loadError,   setLoadError]   = useState(null)   // the staff list or the role scheme could not be read
  const [partialWarn, setPartialWarn] = useState('')     // an Add-modal option list could not be read
  const [saving,      setSaving]      = useState({})
  const [msg,         setMsg]         = useState('')     // string or { text, detail } — ActionError takes both
  const [notice,      setNotice]      = useState('')     // a completed action, so a closed dialog is not the only evidence
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
  const [addMode,     setAddMode]     = useState('hr') // 'hr' | 'existing' | 'manual' | 'pin'
  const [adding,      setAdding]      = useState(false)
  const [addMsg,      setAddMsg]      = useState('')

  // Reset password modal
  const [pwTarget,    setPwTarget]    = useState(null)
  const [newPassword, setNewPassword] = useState('')
  const [resetting,   setResetting]   = useState(false)
  const [pwMsg,       setPwMsg]       = useState('')

  const selfId = session?.user?.id || null
  const businessName = profile?.clients?.name || adminViewClientName || ''

  const effectiveRoles = customRoles.length > 0 ? customRoles : DEFAULT_ROLES
  const linkedEmployeeIds = useMemo(
    () => new Set(staff.map(p => p.hr_employee_id).filter(Boolean)), [staff])
  const unlinkedEmployees = useMemo(
    () => employees.filter(e => !linkedEmployeeIds.has(e.id)), [employees, linkedEmployeeIds])
  // One filter pass per keystroke, not two that can disagree about what "no matches" means.
  const visibleStaff = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return staff
    return staff.filter(p =>
      (p.full_name || '').toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q))
  }, [staff, search])

  // Which client the rows on screen belong to. A ref rather than state: it is read synchronously
  // after every await to reject a response for the client we just left (S721) — an admin
  // switching client re-runs init() on this still-mounted component, and without the claim the
  // slower load paints the previous client's staff, names and login emails under the new one's
  // header, then runs the role auto-fix against that stale list.
  const loadedClientRef = useRef(clientId)

  useEffect(() => {
    if (!clientId) return
    loadedClientRef.current = clientId
    setStaff([]); setEmployees([]); setEligibleUsers([]); setCustomRoles([])
    setLoadError(null); setPartialWarn(''); setMsg(''); setNotice('')
    init(clientId)
  }, [clientId]) // eslint-disable-line

  // The three dialogs below are on the shared Modal since S682 (Escape, focus trap, focus return,
  // role="dialog"); the document-level Escape listener that stood in for it is gone with them.

  async function init(forClient) {
    setLoading(true)
    const [staffRes, settingsRes, empRes, eligibleRes] = await Promise.all([
      supabase.rpc('get_ims_staff_list', { p_client_id: forClient }),
      // maybeSingle: a client with no settings row yet is not a failed read. .single() reported
      // both as one error this function then dropped — the S613 trap saveRoles() below already
      // avoids — and a dropped error here fed the role auto-fix a DEFAULT scheme.
      supabase.from('settings').select('ims_custom_roles').eq('client_id', forClient).maybeSingle(),
      hrEnabled
        ? scopedFrom('hr_employees', 'id, full_name, employee_code, status').in('status', ['active', 'probation']).order('full_name')
        : Promise.resolve({ data: [], error: null }),
      supabase.rpc('get_ims_eligible_users', { p_client_id: forClient }),
    ])
    if (loadedClientRef.current !== forClient) return

    // A failed read is not an empty team. Rendering it as "No staff yet — add your first account"
    // invites the manager to re-create logins that exist (S594), and the role scheme is what
    // every dropdown on the page is built from, so a failed settings read is the same stop.
    const readErr = staffRes.error || settingsRes.error
    if (readErr) {
      const e = asActionError(readErr)
      setLoadError({ text: 'The staff list could not be loaded, so nothing below is shown. ' + e.text, detail: e.detail })
      setLoading(false)
      return
    }
    const saved = settingsRes.data?.ims_custom_roles
    const roles = saved?.length ? saved : DEFAULT_ROLES
    if (saved?.length) setCustomRoles(saved)
    const staffList = staffRes.data || []
    setStaff(staffList)
    setEmployees(empRes.error ? [] : (empRes.data || []))
    setEligibleUsers(eligibleRes.error ? [] : (eligibleRes.data || []))
    const missing = [empRes.error && 'the HR employee list', eligibleRes.error && 'the existing-login list'].filter(Boolean)
    setPartialWarn(missing.length
      ? `Some + Add Staff options could not be loaded (${missing.join(' and ')}) — those modes are hidden until the page is reloaded.`
      : '')
    setLoading(false)

    // Bring any ims_role that no longer matches its role's configured level back into line — in
    // parallel (each is an independent single-row UPDATE by id; sequencing bought no atomicity and
    // made a page that had already painted wait on N Edge Function round trips), and reporting
    // every row that failed rather than dropping each error in turn. A refused row is now also a
    // real outcome: a peer manager's row is refused for an IMS manager caller (S729), and that
    // manager should see whose level is still out of line rather than a badge that quietly stays.
    const mismatched = staffList.filter(p => {
      if (!p.ims_job_title) return false
      const expected = roles.find(r => r.label === p.ims_job_title)?.level
      return expected && expected !== p.ims_role
    })
    if (mismatched.length === 0) return
    const outcomes = await Promise.all(mismatched.map(async p => {
      const level = roles.find(r => r.label === p.ims_job_title)?.level
      const { data, error } = await supabase.functions.invoke('admin-user-ops', {
        body: { action: 'update_ims_role', userId: p.id, ims_role: level, ims_job_title: p.ims_job_title },
      })
      return { p, level, failed: !!(error || data?.error) }
    }))
    if (loadedClientRef.current !== forClient) return
    const applied = outcomes.filter(o => !o.failed)
    if (applied.length > 0) {
      const levelById = Object.fromEntries(applied.map(o => [o.p.id, o.level]))
      setStaff(prev => prev.map(s => s.id in levelById ? { ...s, ims_role: levelById[s.id] } : s))
    }
    const failed = outcomes.filter(o => o.failed)
    if (failed.length > 0) {
      setMsg(`${failed.length} login(s) still carry an access level that does not match their role and could not be corrected: ` +
        names(failed.map(o => o.p)) + '. Their access is unchanged — set the role again, or ask the account owner.')
    }
  }

  async function load() {
    const forClient = clientId
    const [staffRes, eligibleRes] = await Promise.all([
      supabase.rpc('get_ims_staff_list', { p_client_id: forClient }),
      supabase.rpc('get_ims_eligible_users', { p_client_id: forClient }),
    ])
    if (loadedClientRef.current !== forClient) return
    // A failed re-read after a successful delete must not empty the table — an empty table after
    // pressing Delete reads as "you just deleted everyone". Keep the last good list and say so.
    if (staffRes.error) {
      setMsg('The change was saved, but the staff list could not be refreshed — reload the page to see it. ' + errorLine(staffRes.error))
    } else {
      setStaff(staffRes.data || [])
    }
    if (!eligibleRes.error) setEligibleUsers(eligibleRes.data || [])
  }

  async function saveRoles(roles) {
    if (!clientId) return false   // never write a client_id:null (global-defaults) settings row during the admin no-client window
    setRolesSaving(true); setRolesError('')
    // maybeSingle + an error check: with .single() a missing row and a failed read both arrived as
    // an error that was dropped, so any failed read fell into the INSERT branch and wrote a second
    // settings row for the client (the S613 trap), splitting every settings read after it.
    const { data: existing, error: exErr } = await supabase
      .from('settings').select('id').eq('client_id', clientId).maybeSingle()
    if (exErr) { setRolesError('Could not check the existing settings row, so nothing was saved. ' + errorLine(exErr)); setRolesSaving(false); return false }
    let err
    if (existing) {
      const { error } = await supabase.from('settings').update({ ims_custom_roles: roles }).eq('id', existing.id)
      err = error
    } else {
      const { error } = await supabase.from('settings').insert({ client_id: clientId, ims_custom_roles: roles })
      err = error
    }
    if (err) { setRolesError('The roles were not saved. ' + errorLine(err)); setRolesSaving(false); return false }
    setCustomRoles(roles)
    setRolesSaving(false)
    return true
  }

  async function updateCustomRoleLevel(i, level) {
    const changedLabel = customRoles[i].label
    const updated = customRoles.map((r, idx) => idx === i ? { ...r, level } : r)
    const ok = await saveRoles(updated)
    if (!ok) return
    // Sync existing staff whose job title matches the changed role — in parallel, and reporting
    // EVERY row that failed rather than silently dropping each error in turn. Sequencing these
    // never made them atomic: a failure mid-loop already left some staff moved and some not, with
    // nothing on screen to say which, so the manager saw the new level and believed it applied.
    const affected = staff.filter(p => p.ims_job_title === changedLabel && p.ims_role !== level)
    const outcomes = await Promise.all(affected.map(async p => {
      const { data, error } = await supabase.functions.invoke('admin-user-ops', {
        body: { action: 'update_ims_role', userId: p.id, ims_role: level, ims_job_title: changedLabel },
      })
      return { p, failed: !!(error || data?.error), detail: data?.error || error?.message }
    }))
    const moved = new Set(outcomes.filter(o => !o.failed).map(o => o.p.id))
    if (moved.size > 0) {
      setStaff(prev => prev.map(s => moved.has(s.id) ? { ...s, ims_role: level } : s))
    }
    const failed = outcomes.filter(o => o.failed)
    if (failed.length > 0) {
      setRolesError(`Saved the role, but ${failed.length} login(s) could not be moved to the new level and keep their previous access: ` +
        names(failed.map(o => o.p)) + '. ' + (failed[0].detail || 'Change their level individually, or try again.'))
    }
  }

  function staffHolding(label) { return staff.filter(p => p.ims_job_title === label) }

  async function addCustomRole() {
    const label = newRole.label.trim()
    if (!label) return
    // The first custom role starts FROM the defaults rather than replacing them. The scheme is
    // "custom roles if any, else the defaults", so a scheme of one new role dropped Staff /
    // Supervisor / Manager from every dropdown while every existing login still carried one of
    // those titles — each row's select then had no option matching its value and rendered BLANK
    // beside an Access Level badge that still said Supervisor.
    const base = customRoles.length > 0 ? customRoles : DEFAULT_ROLES
    if (base.some(r => r.label.toLowerCase() === label.toLowerCase())) {
      setRolesError(`There is already a role called “${label}”.`); return
    }
    const ok = await saveRoles([...base, { label, level: newRole.level }])
    if (ok) setNewRole(EMPTY_ROLE)   // keep what was typed if the save failed
  }

  function deleteCustomRole(i) {
    const label = customRoles[i].label
    const holders = staffHolding(label)
    if (holders.length > 0) {
      setRolesError(`${holders.length} login(s) still hold the “${label}” role — ${names(holders)}. Move them to another role first; removing it now would leave them on a role that no longer exists.`)
      return
    }
    saveRoles(customRoles.filter((_, idx) => idx !== i))
  }

  function resetToDefaults() {
    const orphans = staff.filter(p => p.ims_job_title && !DEFAULT_ROLES.some(d => d.label === p.ims_job_title))
    if (orphans.length > 0) {
      setRolesError(`${orphans.length} login(s) hold a custom role — ${names(orphans)}. Move them to Staff, Supervisor or Manager first, then reset.`)
      return
    }
    saveRoles([])
  }

  // ── Add staff ──────────────────────────────────────────────────────────────
  function openAdd() {
    setAddForm({ ...EMPTY_ADD, job_title: effectiveRoles[0]?.label || '' })
    setAddMode(
      hrEnabled && unlinkedEmployees.length > 0 ? 'hr'
      : eligibleUsers.length > 0 ? 'existing'
      : 'manual'
    )
    setAddMsg(''); setAddModal(true)
  }

  async function addStaff() {
    // A count PIN account has no role to pick — its rank is fixed at 'staff' by the server, and
    // the role select is not rendered in that mode. Every other mode still requires one.
    const role = effectiveRoles.find(r => r.label === addForm.job_title)
    if (!role && addMode !== 'pin') { setAddMsg('Pick a role — it decides which IMS pages this person can open.'); return }

    // 'existing' assigns an ims_role to an account that already exists for this client (e.g.
    // created via Admin → Clients → Manage → Users) — no new login is created, so it skips the
    // email/password validation entirely and calls update_ims_role, not create_ims_staff.
    if (addMode === 'existing') {
      if (!addForm.existing_user_id) { setAddMsg('Pick which existing login to give IMS access to.'); return }
      setAdding(true); setAddMsg('')
      const { data, error } = await supabase.functions.invoke('admin-user-ops', {
        body: {
          action:        'update_ims_role',
          userId:        addForm.existing_user_id,
          ims_role:      role.level,
          ims_job_title: addForm.job_title,
        },
      })
      if (error || data?.error) {
        setAddMsg(await invokeDetail(data, error, 'The role was not assigned — this account still has the access it had before.'))
        setAdding(false); return
      }
      const who = eligibleUsers.find(u => u.id === addForm.existing_user_id)
      setNotice(`${who?.full_name || who?.email || 'The login'} now has IMS access as ${addForm.job_title}.`)
      setAddModal(false); setAdding(false); load()
      return
    }

    // A count PIN account (S737): name + PIN, no email, no password. Its rank is fixed at 'staff'
    // server-side — the account is count-only in the app, so a supervisor or manager PIN would be
    // a rank that cannot reach anything it unlocks.
    if (addMode === 'pin') {
      if (!addForm.full_name.trim()) { setAddMsg('Enter the staff member’s full name.'); return }
      if (!/^\d{4,6}$/.test(addForm.pin)) { setAddMsg('The PIN must be 4 to 6 digits.'); return }
      setAdding(true); setAddMsg('')
      const { data, error } = await supabase.functions.invoke('admin-user-ops', {
        body: {
          action:        'create_ims_pin_staff',
          client_id:     clientId,
          full_name:     addForm.full_name.trim(),
          pin:           addForm.pin,
          ims_job_title: addForm.job_title || 'Stock Counter',
        },
      })
      if (error || data?.error) {
        setAddMsg(await invokeDetail(data, error, 'The counting login was not created. Check your internet and try again.'))
        setAdding(false); return
      }
      setNotice(`${addForm.full_name.trim()} can now count stock with that PIN. Set the device up from Stock Count → Settings — they tap their name and type the PIN, nothing else.`)
      setAddModal(false); setAdding(false); load()
      return
    }

    if (addMode === 'hr') {
      if (!addForm.employee_id) { setAddMsg('Pick which employee this login is for.'); return }
    } else if (!addForm.full_name.trim()) { setAddMsg('Enter the staff member’s full name.'); return }
    if (!emailValid(addForm.email))       { setAddMsg('Enter a valid email address — this is what they will sign in with.'); return }
    const pwProblem = passwordProblem(addForm.password, { email: addForm.email, businessName })
    if (pwProblem) { setAddMsg(pwProblem); return }
    setAdding(true); setAddMsg('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: {
        action:        'create_ims_staff',
        client_id:     clientId,
        ...(addMode === 'hr' ? { employee_id: addForm.employee_id } : { full_name: addForm.full_name.trim() }),
        email:         addForm.email.trim(),
        password:      addForm.password,
        ims_role:      role.level,
        ims_job_title: addForm.job_title,
      },
    })
    if (error || data?.error) {
      setAddMsg(await invokeDetail(data, error, 'The account was not created. Check your internet and try again — if the email is already in use, add them through “Existing user” instead.'))
      setAdding(false); return
    }
    setNotice(`Login created — they sign in at /login with ${addForm.email.trim()} and the password you set. Share it with them directly.`)
    setAddModal(false); setAdding(false); load()
  }

  // ── Delete staff ───────────────────────────────────────────────────────────
  // Deleting a login is irreversible, so the ask is the product's own dialog (S682).
  function deleteStaff(p) {
    askConfirm({
      title: `Delete ${p.full_name}'s IMS login?`,
      confirmLabel: 'Delete Login', danger: true, busyLabel: 'Deleting…',
      body: (
        <p style={{ margin: 0 }}>
          {p.full_name} can no longer sign in to Crest IMS. The login and its role are removed; nothing they entered —
          purchases, counts, sales — is touched. To give them access again later you will create a new login. This
          cannot be undone.
        </p>
      ),
      run: async () => {
        setMsg(''); setNotice('')
        const { data, error } = await supabase.functions.invoke('admin-user-ops', {
          body: { action: 'delete_ims_staff', userId: p.id },
        })
        if (error || data?.error) {
          setMsg(`${p.full_name}'s login was not deleted — it still works. ${await invokeDetail(data, error, '')}`); return
        }
        setNotice(`${p.full_name}'s IMS login was deleted.`)
        load()
      },
    })
  }

  // ── Reset password ────────────────────────────────────────────────────────
  function openReset(p) { setPwTarget(p); setNewPassword(''); setPwMsg('') }

  async function resetPassword() {
    // One dialog, two credentials. A count PIN account has no password and no email of its own,
    // so it takes the digit rule and the PIN action; everything else keeps the password policy.
    const isPin = !!pwTarget.has_pin
    if (isPin) {
      if (!/^\d{4,6}$/.test(newPassword)) { setPwMsg('The PIN must be 4 to 6 digits.'); return }
    } else {
      const pwProblem = passwordProblem(newPassword, { email: pwTarget.email, businessName })
      if (pwProblem) { setPwMsg(pwProblem); return }
    }
    setResetting(true); setPwMsg('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: isPin
        ? { action: 'reset_ims_pin', userId: pwTarget.id, pin: newPassword }
        : { action: 'reset_ims_password', userId: pwTarget.id, password: newPassword },
    })
    if (error || data?.error) {
      setPwMsg(await invokeDetail(data, error, isPin
        ? 'The PIN was not changed — the old one still works.'
        : 'The password was not changed — the old one still works.'))
      setResetting(false); return
    }
    setNotice(isPin
      ? `PIN for ${pwTarget.full_name} changed — the old one no longer works. Tell them the new one directly.`
      : `Password for ${pwTarget.full_name} changed — the old one no longer works. Share the new one with them directly.`)
    setPwTarget(null); setResetting(false)
  }

  // ── Role update ────────────────────────────────────────────────────────────
  async function updateRole(profileId, jobTitle) {
    const role = jobTitle ? effectiveRoles.find(r => r.label === jobTitle) : null
    // A title the scheme no longer defines must not reach the server as "no role": that write
    // would REVOKE the login's access, not re-label it.
    if (jobTitle && !role) { setMsg(`“${jobTitle}” is not a role in this team's scheme any more — pick one from the list.`); return }
    setSaving(s => ({ ...s, [profileId]: true })); setMsg(''); setNotice('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: {
        action:        'update_ims_role',
        userId:        profileId,
        ims_role:      role?.level || null,
        ims_job_title: jobTitle || null,
      },
    })
    if (error || data?.error) {
      setMsg(await invokeDetail(data, error, 'The role was not changed — this account still has the access it had before.'))
    } else {
      setStaff(prev => prev.map(p => p.id === profileId
        ? { ...p, ims_role: role?.level || null, ims_job_title: jobTitle || null }
        : p
      ))
    }
    setSaving(s => ({ ...s, [profileId]: false }))
  }

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  const labelStyle = { fontSize: 12, color: 'var(--theme-text2)', marginBottom: 4, display: 'block' }

  return (
    <div>

      {/* Header */}
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">IMS Staff</h1>
          <p className="page-subtitle">
            Assign roles to your team. Staff log in with their email and password, same as you do.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
          <input aria-label="Search staff"
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search staff…" className="form-input form-input--auto" style={{ maxWidth: 180 }}
          />
          <button className="btn btn-ghost" style={{ whiteSpace: 'nowrap' }} onClick={() => setRolesModal(true)} disabled={loading || !!loadError}>
            Manage Roles
          </button>
          <button className="btn btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={openAdd} disabled={loading || !!loadError}>
            + Add Staff
          </button>
        </div>
      </div>

      {/* Permission level legend */}
      <div className="card" style={{ padding: '14px 18px', marginBottom: 24, display: 'flex', flexWrap: 'wrap', gap: 20 }}>
        {PERMISSION_LEVELS.map(l => (
          <div key={l.value} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`badge ${LEVEL_BADGE[l.value]}`}>{l.label}</span>
            <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{l.desc}</span>
          </div>
        ))}
      </div>

      {msg && <ActionError error={msg} className="action-error--top" />}
      {notice && <p role="status" style={{ fontSize: 13, color: 'var(--theme-green-text)', marginBottom: 16 }}>{notice}</p>}
      {partialWarn && <p role="status" style={{ fontSize: 12, color: 'var(--theme-amber-text)', marginBottom: 16 }}>{partialWarn}</p>}
      {confirmEl}

      {loading ? (
        <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
      ) : loadError ? (
        <ActionError error={loadError} />
      ) : staff.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text3)' }}>
          No staff yet. Click <strong>+ Add Staff</strong> to create your first IMS account.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th><Tip text="Custom role name defined for this team (e.g. Store Keeper, Purchasing Clerk).">Role</Tip></th>
                <th><Tip text="Permission level this role maps to — controls which pages they can access.">Access Level</Tip></th>
                <th><Tip text="Last time this user was active in the app">Last Seen</Tip></th>
                <th style={{ width: 200 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleStaff.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--theme-text2)', padding: 24 }}>No staff match "{search}".</td></tr>
              )}
              {visibleStaff.map(p => {
                // The row's title, exactly as stored. A title the scheme no longer defines (a role
                // removed, or defaults reset, before S729 refused both while logins held it) is
                // rendered as its own option so the select shows the truth — never a blank box
                // beside a badge that still says Supervisor, and never the first role that happens
                // to share the level, which would name a role this login was never given.
                const currentTitle = p.ims_job_title || (p.ims_role ? `${cap(p.ims_role)} (no role name)` : '')
                const orphan = !!currentTitle && !effectiveRoles.some(r => r.label === currentTitle)
                const isSelf = p.id === selfId
                return (
                  <tr key={p.id}>
                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{p.full_name || '—'}{isSelf && <span style={{ fontWeight: 400, color: 'var(--theme-text3)' }}> (you)</span>}</div>
                      {p.hr_employee_id && (
                        <Tip text="This IMS login is linked to an HR employee record — name stays in sync with HR.">
                          <span style={{ fontSize: 10, color: 'var(--theme-text3)' }}>🔗 HR{p.employee_code ? ` · ${p.employee_code}` : ''}</span>
                        </Tip>
                      )}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{p.email || '—'}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <select aria-label={`IMS role for ${p.full_name || p.email}`}
                          className="form-select"
                          style={{ minWidth: 160 }}
                          value={currentTitle}
                          disabled={saving[p.id] || isSelf}
                          title={isSelf ? 'Your own role can only be changed by the account owner or an administrator' : undefined}
                          onChange={e => updateRole(p.id, e.target.value)}
                        >
                          <option value="">— No Access —</option>
                          {orphan && <option value={currentTitle}>{currentTitle} — not in the role list</option>}
                          {effectiveRoles.map(r => (
                            <option key={r.label} value={r.label}>{r.label}</option>
                          ))}
                        </select>
                        {saving[p.id] && <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Saving…</span>}
                        {orphan && !saving[p.id] && (
                          <Tip text="This login's role was removed from the team's role list, so its access level is no longer tied to anything. Pick a current role to put it back under one.">
                            <span className="badge badge-amber">△ orphan</span>
                          </Tip>
                        )}
                      </div>
                    </td>
                    <td>
                      {p.ims_role
                        ? <span className={`badge ${LEVEL_BADGE[p.ims_role] || STAFF_LEVEL_BADGE_NONE}`}>{cap(p.ims_role)}</span>
                        : <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>—</span>
                      }
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                      {p.last_seen_at
                        ? new Date(p.last_seen_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                        : '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        {/* A count PIN account has no password to reset and no email to sign in
                            with, so the two are mutually exclusive (S737). get_ims_staff_list
                            returns has_pin for exactly this. */}
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => openReset(p)}>
                          {p.has_pin ? 'Reset PIN' : 'Reset Password'}
                        </button>
                        {isSelf ? (
                          <Tip text="You cannot delete or re-rank your own login from here — the account owner or an administrator can.">
                            <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>your login</span>
                          </Tip>
                        ) : (
                          <button
                            className="btn btn-ghost"
                            style={{ fontSize: 12, padding: '4px 10px', color: 'var(--theme-red-text)', borderColor: 'var(--theme-red)' }}
                            onClick={() => deleteStaff(p)}
                          >
                            Delete
                          </button>
                        )}
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
        <Modal onClose={() => setRolesModal(false)} title="Manage IMS Roles" maxWidth={480} panelStyle={{ maxHeight: '80vh', overflowY: 'auto' }}>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--theme-text3)' }}>
              Define custom role names for your team. Each maps to a permission level. Your first custom role is added
              alongside Staff / Supervisor / Manager, so nobody's current role disappears.
            </p>

            {rolesError && <ActionError error={rolesError} className="action-error--top" />}

            {customRoles.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--theme-text3)', fontStyle: 'italic', marginBottom: 16 }}>
                Using default roles (Staff / Supervisor / Manager)
              </p>
            ) : (
              <div style={{ marginBottom: 16 }}>
                {customRoles.map((r, i) => {
                  const held = staffHolding(r.label).length
                  return (
                    <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--theme-border-lt)' }}>
                      <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)' }}>
                        {r.label}
                        {held > 0 && <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text3)', marginLeft: 6 }}>{held} login{held === 1 ? '' : 's'}</span>}
                      </span>
                      <select aria-label={`Permission level for ${r.label}`}
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
                        style={{ fontSize: 12, padding: '3px 8px', color: 'var(--theme-red-text)', borderColor: 'var(--theme-red)' }}
                        onClick={() => deleteCustomRole(i)}
                        disabled={rolesSaving}
                        title={held > 0 ? `${held} login(s) hold this role — move them first` : undefined}
                      >
                        Remove
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Add new role */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 20 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle} htmlFor="imssta-f1">Role Name</label>
                <input id="imssta-f1"
                  className="form-input"
                  placeholder="e.g. Store Keeper, Purchasing Clerk…"
                  value={newRole.label}
                  onChange={e => setNewRole(r => ({ ...r, label: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && addCustomRole()}
                />
              </div>
              <div style={{ width: 140 }}>
                <label style={labelStyle} htmlFor="imssta-f2">Permission Level</label>
                <select id="imssta-f2"
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
        </Modal>
      )}

      {/* ── Add Staff modal ──────────────────────────────────────────────────── */}
      {addModal && (
        <Modal onClose={() => { if (!adding) setAddModal(false) }} title="Add Staff Member" maxWidth={380}>

            {/* Always rendered: Count PIN is offered whatever else this client has (S737), so there
                are always at least two ways in. It used to appear only for a client with HR or a
                spare login. */}
            <div className="tab-bar" role="group" aria-label="How to add this staff member" style={{ marginBottom: 16 }}>
              {hrEnabled && (
                <button aria-pressed={addMode === 'hr'} className={`tab-btn${addMode === 'hr' ? ' tab-btn--active' : ''}`} onClick={() => setAddMode('hr')}>HR Employee</button>
              )}
              {eligibleUsers.length > 0 && (
                <button aria-pressed={addMode === 'existing'} className={`tab-btn${addMode === 'existing' ? ' tab-btn--active' : ''}`} onClick={() => setAddMode('existing')}>Existing User</button>
              )}
              <button aria-pressed={addMode === 'manual'} className={`tab-btn${addMode === 'manual' ? ' tab-btn--active' : ''}`} onClick={() => setAddMode('manual')}>IMS-only Staff</button>
              <button aria-pressed={addMode === 'pin'} className={`tab-btn${addMode === 'pin' ? ' tab-btn--active' : ''}`} onClick={() => setAddMode('pin')}>Count PIN</button>
            </div>

            {addMode === 'hr' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle} htmlFor="ims-staff-hr-employee">
                  <Tip text="Links this IMS login to an existing HR employee record — their name stays in sync with HR, and payroll/attendance can be matched to the same person.">HR Employee</Tip>
                </label>
                {unlinkedEmployees.length === 0 ? (
                  <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: 0 }}>
                    Every active HR employee already has IMS access — add one in HR → Employees first, or switch to another tab.
                  </p>
                ) : (
                  <SearchableSelect
                    id="ims-staff-hr-employee"
                    options={unlinkedEmployees.map(e => ({ value: e.id, label: `${e.full_name}${e.employee_code ? ` (${e.employee_code})` : ''}` }))}
                    value={addForm.employee_id} onChange={v => setAddForm(f => ({ ...f, employee_id: v }))}
                    placeholder="Select employee…"
                  />
                )}
              </div>
            )}

            {addMode === 'existing' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle} htmlFor="ims-staff-existing-user">
                  <Tip text="Assigns an IMS role to a login that already exists for this client (e.g. one created from Admin → Clients → Manage → Users) instead of creating a new one. Only accounts with no POS/HR/IMS role already set are shown, and only the account owner or an administrator sees this tab. A client's only Owner login cannot be converted — that would leave nobody with Owner access.">Existing User</Tip>
                </label>
                {eligibleUsers.length === 0 ? (
                  <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: 0 }}>
                    No eligible existing accounts — every account for this client already has a POS, HR, or IMS role.
                  </p>
                ) : (
                  <SearchableSelect
                    id="ims-staff-existing-user"
                    options={eligibleUsers.map(u => ({ value: u.id, label: `${u.full_name || '—'} (${u.email})` }))}
                    value={addForm.existing_user_id} onChange={v => setAddForm(f => ({ ...f, existing_user_id: v }))}
                    placeholder="Select user…"
                  />
                )}
              </div>
            )}

            {addMode === 'manual' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle} htmlFor="imssta-f3">Full Name</label>
                <input id="imssta-f3"
                  className="form-input"
                  placeholder="e.g. Ram Bahadur"
                  value={addForm.full_name}
                  onChange={e => setAddForm(f => ({ ...f, full_name: e.target.value }))}
                  autoFocus
                />
              </div>
            )}

            {addMode === 'pin' && (
              <>
                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle} htmlFor="imssta-pin-name">Full Name</label>
                  <input id="imssta-pin-name"
                    className="form-input"
                    placeholder="e.g. Ram Bahadur"
                    value={addForm.full_name}
                    onChange={e => setAddForm(f => ({ ...f, full_name: e.target.value }))}
                    autoFocus
                  />
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle} htmlFor="imssta-pin">
                    <Tip text="They tap their name on the counting tablet and type this PIN — no email, no password. Five wrong tries locks the account for 15 minutes. You can reset it here at any time." width={280}>
                      PIN (4–6 digits)
                    </Tip>
                  </label>
                  <input id="imssta-pin"
                    className="form-input"
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    autoComplete="new-password"
                    placeholder="••••"
                    value={addForm.pin}
                    onChange={e => setAddForm(f => ({ ...f, pin: e.target.value.replace(/\D/g, '') }))}
                  />
                </div>
                <p style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: -4, marginBottom: 14 }}>
                  This login opens Stock Count and nothing else. Set the tablet up from Stock Count → Settings.
                </p>
              </>
            )}

            {addMode !== 'existing' && addMode !== 'pin' && (
              <>
                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle} htmlFor="imssta-f4">
                    <Tip text="Staff log in with this email and password — same login mechanism as your own account.">Email</Tip>
                  </label>
                  <input id="imssta-f4"
                    className="form-input"
                    type="email"
                    autoComplete="new-password"
                    placeholder="staff@example.com"
                    value={addForm.email}
                    onChange={e => setAddForm(f => ({ ...f, email: e.target.value }))}
                  />
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle} htmlFor="imssta-f5">Initial Password ({MIN_PASSWORD_LENGTH}+ characters)</label>
                  <input id="imssta-f5"
                    className="form-input"
                    type="password"
                    autoComplete="new-password"
                    placeholder={`Min. ${MIN_PASSWORD_LENGTH} characters`}
                    value={addForm.password}
                    onChange={e => setAddForm(f => ({ ...f, password: e.target.value }))}
                  />
                </div>
              </>
            )}

            {/* Not in Count PIN mode: that account's rank is fixed at 'staff' by the server, so a
                role picker here would be a control whose only answer is already decided. */}
            <div style={{ marginBottom: 20, display: addMode === 'pin' ? 'none' : undefined }}>
              <label style={labelStyle} htmlFor="imssta-f6">
                <Tip text="The role shown for this staff member. Permission level is shown in brackets.">Role</Tip>
              </label>
              <select id="imssta-f6"
                className="form-select"
                style={{ width: '100%' }}
                value={addForm.job_title}
                onChange={e => setAddForm(f => ({ ...f, job_title: e.target.value }))}
              >
                {effectiveRoles.map(r => (
                  <option key={r.label} value={r.label}>
                    {r.label} ({cap(r.level)})
                  </option>
                ))}
              </select>
            </div>

            {addMsg && <ActionError error={addMsg} />}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: addMsg ? 12 : 0 }}>
              <button className="btn btn-ghost" onClick={() => setAddModal(false)} disabled={adding}>Cancel</button>
              <button className="btn btn-primary" onClick={addStaff} disabled={adding}>
                {adding ? 'Creating…' : 'Add Staff'}
              </button>
            </div>
        </Modal>
      )}

      {/* ── Reset Password modal ─────────────────────────────────────────────── */}
      {pwTarget && (
        <Modal onClose={() => { if (!resetting) setPwTarget(null) }} title={pwTarget.has_pin ? 'Reset PIN' : 'Reset Password'} maxWidth={340}>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--theme-text3)' }}>
              New {pwTarget.has_pin ? 'PIN' : 'password'} for <strong style={{ color: 'var(--theme-text1)' }}>{pwTarget.full_name}</strong>
            </p>
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle} htmlFor="imssta-f7">
                {pwTarget.has_pin ? 'New PIN (4–6 digits)' : `New Password (${MIN_PASSWORD_LENGTH}+ characters)`}
              </label>
              <input id="imssta-f7"
                className="form-input"
                type="password"
                inputMode={pwTarget.has_pin ? 'numeric' : undefined}
                maxLength={pwTarget.has_pin ? 6 : undefined}
                autoComplete="new-password"
                placeholder={pwTarget.has_pin ? '••••' : `Min. ${MIN_PASSWORD_LENGTH} characters`}
                value={newPassword}
                autoFocus
                onChange={e => setNewPassword(pwTarget.has_pin ? e.target.value.replace(/\D/g, '') : e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !resetting && resetPassword()}
              />
            </div>
            {pwMsg && <ActionError error={pwMsg} />}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: pwMsg ? 12 : 0 }}>
              <button className="btn btn-ghost" onClick={() => setPwTarget(null)} disabled={resetting}>Cancel</button>
              <button className="btn btn-primary" onClick={resetPassword} disabled={resetting}>
                {resetting ? 'Saving…' : pwTarget.has_pin ? 'Save PIN' : 'Save Password'}
              </button>
            </div>
        </Modal>
      )}
    </div>
  )
}
