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

// Mirrors src/modules/ims/staff/ImsStaff.jsx structurally — same role model, same custom-role
// mapping, same Edge Function call pattern — adapted for HR staff (S430). Distinct from HR
// Self-Service (an individual employee's own payslip/leave PIN portal, managed from the
// "Enable Self-Service" button on Employees): this page creates real email+password logins for
// people who administer HR itself (run payroll, approve leave, edit pay setup).
//
// S752 brought it level with ImsStaff's S729 sweep and then past it:
//   - there is no "No Access" choice: clearing a login's rank made it look like the Owner (Owner is
//     the absence of staff markers), so removing access means deleting the login;
//   - the page no longer re-ranks anyone on load. A login whose level no longer matches its role is
//     SHOWN, and moved only when someone presses Apply and confirms who moves;
//   - only the Owner (or a Crest admin) can give a login Manager rank. admin-user-ops refuses it
//     for an HR manager, and this page does not offer what the server will refuse.
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
const EMPTY_ADD   = { full_name: '', email: '', password: '', job_title: '', employee_id: '', existing_user_id: '' }
const EMPTY_ROLE  = { label: '', level: 'staff' }

function emailValid(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) }
// The product's one password policy (S534): the floor from weakPasswords.js, then the offline
// blocklist. This page mints real /login credentials for people who can see every salary.
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

export default function HrStaff() {
  const { clientId, hasHrAccess, isAdmin, isOwner, session, profile, adminViewClientName } = useAuth()
  const { scopedFrom } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()
  const [staff,         setStaff]         = useState([])
  const [employees,     setEmployees]     = useState([]) // hr_employees, unlinked ones only
  const [eligibleUsers, setEligibleUsers] = useState([]) // existing client accounts with no pos_role/hr_self_service/ims_role/hr_role yet
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
  const [addMode,     setAddMode]     = useState('hr') // 'hr' | 'existing' | 'manual'
  const [adding,      setAdding]      = useState(false)
  const [addMsg,      setAddMsg]      = useState('')

  // Reset password modal
  const [pwTarget,    setPwTarget]    = useState(null)
  const [newPassword, setNewPassword] = useState('')
  const [resetting,   setResetting]   = useState(false)
  const [pwMsg,       setPwMsg]       = useState('')

  const selfId = session?.user?.id || null
  const businessName = profile?.clients?.name || adminViewClientName || ''
  // The Owner and a Crest admin may grant Manager rank, act on a manager's login, and turn an
  // existing plain login into HR staff. An HR manager may do none of the three (admin-user-ops).
  const privileged = isAdmin || isOwner

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

  // Logins whose stored level no longer matches the level their role carries. Shown, never fixed
  // on load: until S752 this page re-ranked every such login the moment anyone opened it, so a
  // role-list edit made in one place silently promoted people the next time a manager looked.
  const mismatched = useMemo(() => staff.filter(p => {
    if (!p.hr_job_title) return false
    const expected = effectiveRoles.find(r => r.label === p.hr_job_title)?.level
    return expected && expected !== p.hr_role
  }), [staff, effectiveRoles])

  // Which client the rows on screen belong to — read after every await so an admin switching
  // client never has the previous client's staff painted under the new one's header (S721).
  const loadedClientRef = useRef(clientId)

  useEffect(() => {
    if (!clientId) return
    loadedClientRef.current = clientId
    setStaff([]); setEmployees([]); setEligibleUsers([]); setCustomRoles([])
    setLoadError(null); setPartialWarn(''); setMsg(''); setNotice('')
    init(clientId)
  }, [clientId]) // eslint-disable-line

  async function init(forClient) {
    setLoading(true)
    const [staffRes, settingsRes, empRes, eligibleRes] = await Promise.all([
      supabase.rpc('get_hr_role_staff_list', { p_client_id: forClient }),
      // maybeSingle: a client with no settings row yet is not a failed read.
      supabase.from('settings').select('hr_custom_roles').eq('client_id', forClient).maybeSingle(),
      scopedFrom('hr_employees', 'id, full_name, employee_code, status').in('status', ['active', 'probation']).order('full_name'),
      privileged
        ? supabase.rpc('get_hr_role_eligible_users', { p_client_id: forClient })
        : Promise.resolve({ data: [], error: null }),
    ])
    if (loadedClientRef.current !== forClient) return

    // A failed read is not an empty team: "No staff yet — add your first account" invites the
    // manager to re-create logins that exist, and the role scheme builds every dropdown here.
    const readErr = staffRes.error || settingsRes.error
    if (readErr) {
      const e = asActionError(readErr)
      setLoadError({ text: 'The staff list could not be loaded, so nothing below is shown. ' + e.text, detail: e.detail })
      setLoading(false)
      return
    }
    const saved = settingsRes.data?.hr_custom_roles
    if (saved?.length) setCustomRoles(saved)
    setStaff(staffRes.data || [])
    setEmployees(empRes.error ? [] : (empRes.data || []))
    setEligibleUsers(eligibleRes.error ? [] : (eligibleRes.data || []))
    const missing = [empRes.error && 'the HR employee list', eligibleRes.error && 'the existing-login list'].filter(Boolean)
    setPartialWarn(missing.length
      ? `Some + Add Staff options could not be loaded (${missing.join(' and ')}) — those modes are hidden until the page is reloaded.`
      : '')
    setLoading(false)
  }

  async function load() {
    const forClient = clientId
    const [staffRes, eligibleRes] = await Promise.all([
      supabase.rpc('get_hr_role_staff_list', { p_client_id: forClient }),
      privileged
        ? supabase.rpc('get_hr_role_eligible_users', { p_client_id: forClient })
        : Promise.resolve({ data: [], error: null }),
    ])
    if (loadedClientRef.current !== forClient) return
    // A failed re-read after a successful delete must not empty the table — that reads as "you
    // just deleted everyone". Keep the last good list and say so.
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
      const { error } = await supabase.from('settings').update({ hr_custom_roles: roles }).eq('id', existing.id)
      err = error
    } else {
      const { error } = await supabase.from('settings').insert({ client_id: clientId, hr_custom_roles: roles })
      err = error
    }
    if (err) { setRolesError('The roles were not saved. ' + errorLine(err)); setRolesSaving(false); return false }
    setCustomRoles(roles)
    setRolesSaving(false)
    return true
  }

  // Move each login to the level its role carries. Reports EVERY row that failed — a refused row is
  // a real outcome (a peer manager's login is refused for an HR manager caller).
  async function moveLogins(list, levelOf) {
    const outcomes = await Promise.all(list.map(async p => {
      const level = levelOf(p)
      const { data, error } = await supabase.functions.invoke('admin-user-ops', {
        body: { action: 'update_hr_role', userId: p.id, hr_role: level, hr_job_title: p.hr_job_title },
      })
      return { p, level, failed: !!(error || data?.error), detail: data?.error || error?.message }
    }))
    const levelById = Object.fromEntries(outcomes.filter(o => !o.failed).map(o => [o.p.id, o.level]))
    if (Object.keys(levelById).length > 0) {
      setStaff(prev => prev.map(s => s.id in levelById ? { ...s, hr_role: levelById[s.id] } : s))
    }
    return outcomes.filter(o => o.failed)
  }

  function describeMoves(list, levelOf) {
    return (
      <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
        {list.map(p => (
          <li key={p.id}>{p.full_name || p.email}: {cap(p.hr_role) || 'no level'} → {cap(levelOf(p))}</li>
        ))}
      </ul>
    )
  }

  function applyMismatches() {
    const levelOf = p => effectiveRoles.find(r => r.label === p.hr_job_title)?.level
    const list = mismatched
    askConfirm({
      title: `Change the access level of ${list.length} login${list.length === 1 ? '' : 's'}?`,
      confirmLabel: 'Change Access', busyLabel: 'Changing…',
      body: (
        <div>
          <p style={{ margin: 0 }}>
            Each login below moves to the level its role now carries. A move up opens pages they could not open before
            — Manager opens payroll and every salary.
          </p>
          {describeMoves(list, levelOf)}
        </div>
      ),
      run: async () => {
        setMsg(''); setNotice('')
        const failed = await moveLogins(list, levelOf)
        if (failed.length > 0) {
          setMsg(`${failed.length} login(s) could not be moved and keep their previous access: ${names(failed.map(o => o.p))}. ` +
            (failed[0].detail || 'Try again, or ask the account owner.'))
        } else {
          setNotice(`${list.length} login${list.length === 1 ? '' : 's'} moved to the level their role carries.`)
        }
      },
    })
  }

  function updateCustomRoleLevel(i, level) {
    const changedLabel = customRoles[i].label
    const updated = customRoles.map((r, idx) => idx === i ? { ...r, level } : r)
    const affected = staff.filter(p => p.hr_job_title === changedLabel && p.hr_role !== level)
    const commit = async () => {
      const ok = await saveRoles(updated)
      if (!ok || affected.length === 0) return
      const failed = await moveLogins(affected, () => level)
      if (failed.length > 0) {
        setRolesError(`Saved the role, but ${failed.length} login(s) could not be moved to the new level and keep their previous access: ` +
          names(failed.map(o => o.p)) + '. ' + (failed[0].detail || 'Change their level individually, or try again.'))
      }
    }
    if (affected.length === 0) { commit(); return }
    // Changing a role's level re-ranks everyone holding it, so the ask names who moves.
    askConfirm({
      title: `Change “${changedLabel}” to ${cap(level)}?`,
      confirmLabel: 'Change Level', busyLabel: 'Saving…', zIndex: 2200,
      body: (
        <div>
          <p style={{ margin: 0 }}>
            {affected.length} login{affected.length === 1 ? '' : 's'} hold this role and will move with it.
          </p>
          {describeMoves(affected, () => level)}
        </div>
      ),
      run: commit,
    })
  }

  function staffHolding(label) { return staff.filter(p => p.hr_job_title === label) }

  async function addCustomRole() {
    const label = newRole.label.trim()
    if (!label) return
    // The first custom role starts FROM the defaults rather than replacing them — otherwise every
    // login still holding Staff / Supervisor / Manager renders a blank role select.
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
    const orphans = staff.filter(p => p.hr_job_title && !DEFAULT_ROLES.some(d => d.label === p.hr_job_title))
    if (orphans.length > 0) {
      setRolesError(`${orphans.length} login(s) hold a custom role — ${names(orphans)}. Move them to Staff, Supervisor or Manager first, then reset.`)
      return
    }
    saveRoles([])
  }

  // ── Add staff ──────────────────────────────────────────────────────────────
  // The first role this caller may actually grant, so the form never opens on a refusal.
  const grantableRoles = privileged ? effectiveRoles : effectiveRoles.filter(r => r.level !== 'manager')

  function openAdd() {
    setAddForm({ ...EMPTY_ADD, job_title: grantableRoles[0]?.label || '' })
    setAddMode(
      unlinkedEmployees.length > 0 ? 'hr'
      : privileged && eligibleUsers.length > 0 ? 'existing'
      : 'manual'
    )
    setAddMsg(''); setAddModal(true)
  }

  async function addStaff() {
    const role = effectiveRoles.find(r => r.label === addForm.job_title)
    if (!role) { setAddMsg('Pick a role — it decides which HR pages this person can open.'); return }
    if (role.level === 'manager' && !privileged) { setAddMsg('Only the account owner can give a login Manager access.'); return }

    // 'existing' assigns an hr_role to an account that already exists for this client (e.g.
    // created via Admin → Clients → Manage → Users) — no new login is created. Owner/admin only:
    // a plain login IS an Owner login, so this demotes it.
    if (addMode === 'existing') {
      if (!addForm.existing_user_id) { setAddMsg('Pick which existing login to give HR access to.'); return }
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
        setAddMsg(await invokeDetail(data, error, 'The role was not assigned — this account still has the access it had before.'))
        setAdding(false); return
      }
      const who = eligibleUsers.find(u => u.id === addForm.existing_user_id)
      setNotice(`${who?.full_name || who?.email || 'The login'} now has HR access as ${addForm.job_title}.`)
      setAddModal(false); setAdding(false); load()
      return
    }

    if (addMode === 'hr') {
      if (!addForm.employee_id) { setAddMsg('Pick which employee this login is for.'); return }
    } else if (!addForm.full_name.trim()) { setAddMsg('Enter the staff member’s full name.'); return }
    if (!emailValid(addForm.email)) { setAddMsg('Enter a valid email address — this is what they will sign in with.'); return }
    const pwProblem = passwordProblem(addForm.password, { email: addForm.email, businessName })
    if (pwProblem) { setAddMsg(pwProblem); return }
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
      setAddMsg(await invokeDetail(data, error, 'The account was not created. Check your internet and try again — if the email is already in use, the account owner can add them through “Existing User” instead.'))
      setAdding(false); return
    }
    setNotice(`Login created — they sign in at /login with ${addForm.email.trim()} and the password you set. Share it with them directly.`)
    setAddModal(false); setAdding(false); load()
  }

  // ── Delete staff ───────────────────────────────────────────────────────────
  // Deleting a login is irreversible, so the ask is the product's own dialog with the consequence
  // named (S682; was window.confirm). It is also the only way to remove someone's HR access.
  function deleteStaff(p) {
    askConfirm({
      title: `Delete ${p.full_name}'s HR login?`,
      confirmLabel: 'Delete Login', danger: true, busyLabel: 'Deleting…',
      body: (
        <p style={{ margin: 0 }}>
          {p.full_name} can no longer sign in to Crest HR. The login and its role are removed; the employee record, payslips
          and attendance are untouched. To give them access again later you will create a new login. This cannot be undone.
        </p>
      ),
      run: async () => {
        setMsg(''); setNotice('')
        const { data, error } = await supabase.functions.invoke('admin-user-ops', {
          body: { action: 'delete_hr_staff', userId: p.id },
        })
        if (error || data?.error) {
          setMsg(`${p.full_name}'s login was not deleted — it still works. ${await invokeDetail(data, error, '')}`); return
        }
        setNotice(`${p.full_name}'s HR login was deleted.`)
        load()
      },
    })
  }

  // ── Reset password ────────────────────────────────────────────────────────
  function openReset(p) { setPwTarget(p); setNewPassword(''); setPwMsg('') }

  async function resetPassword() {
    const pwProblem = passwordProblem(newPassword, { email: pwTarget.email, businessName })
    if (pwProblem) { setPwMsg(pwProblem); return }
    setResetting(true); setPwMsg('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: { action: 'reset_hr_password', userId: pwTarget.id, password: newPassword },
    })
    if (error || data?.error) {
      setPwMsg(await invokeDetail(data, error, 'The password was not changed — the old one still works.'))
      setResetting(false); return
    }
    setNotice(`Password for ${pwTarget.full_name} changed — the old one no longer works. Share the new one with them directly.`)
    setPwTarget(null); setResetting(false)
  }

  // ── Role update ────────────────────────────────────────────────────────────
  async function updateRole(p, jobTitle) {
    const role = effectiveRoles.find(r => r.label === jobTitle)
    // Never send "no role": that would leave a login with no marker, which reads as the Owner.
    if (!role) { setMsg(`“${jobTitle}” is not a role in this team's scheme any more — pick one from the list.`); return }
    if (role.level === 'manager' && p.hr_role !== 'manager' && !privileged) {
      setMsg('Only the account owner can give a login Manager access.'); return
    }
    setSaving(s => ({ ...s, [p.id]: true })); setMsg(''); setNotice('')
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: {
        action:       'update_hr_role',
        userId:       p.id,
        hr_role:      role.level,
        hr_job_title: jobTitle,
      },
    })
    if (error || data?.error) {
      setMsg(await invokeDetail(data, error, 'The role was not changed — this account still has the access it had before.'))
    } else {
      setStaff(prev => prev.map(s => s.id === p.id ? { ...s, hr_role: role.level, hr_job_title: jobTitle } : s))
    }
    setSaving(s => ({ ...s, [p.id]: false }))
  }

  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />

  const labelStyle = { fontSize: 12, color: 'var(--theme-text2)', marginBottom: 4, display: 'block' }
  const managerOptionNote = privileged ? '' : ' — owner only'

  return (
    <div>

      {/* Header */}
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">HR Staff</h1>
          <p className="page-subtitle">
            Assign roles to your HR administrators. Staff log in with their email and password, same as you do.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexShrink: 0, flexWrap: 'wrap' }}>
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            aria-label="Search staff by name or email"
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
            <span className={`badge ${LEVEL_BADGE[l.value]}`}>{l.label}</span>
            <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{l.desc}</span>
          </div>
        ))}
      </div>

      {msg && <ActionError error={msg} className="action-error--top" />}
      {notice && <p role="status" style={{ fontSize: 13, color: 'var(--theme-green-text)', marginBottom: 16 }}>{notice}</p>}
      {partialWarn && <p role="status" style={{ fontSize: 12, color: 'var(--theme-amber-text)', marginBottom: 16 }}>{partialWarn}</p>}

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
              {mismatched.map(p => `${p.full_name || p.email} (${cap(p.hr_role)}, role “${p.hr_job_title}” is ${cap(effectiveRoles.find(r => r.label === p.hr_job_title)?.level)})`).join('; ')}.
              Their access has not changed — nothing moves until you apply it.
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={applyMismatches}>Apply role levels…</button>
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
      ) : loadError ? (
        <ActionError error={loadError} />
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
                <th><Tip text="Custom role name defined for this team (e.g. Payroll Officer, HR Coordinator). To take someone's HR access away, delete their login.">Role</Tip></th>
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
                // The row's title exactly as stored. A title the scheme no longer defines is its own
                // option, so the select shows the truth rather than a blank box or a role this
                // login was never given.
                const currentTitle = p.hr_job_title || (p.hr_role ? `${cap(p.hr_role)} (no role name)` : '')
                const orphan = !!currentTitle && !effectiveRoles.some(r => r.label === currentTitle)
                const isSelf = p.id === selfId
                // An HR manager never acts on their own login or a peer manager's (admin-user-ops'
                // requireManageableTarget); the Owner and admin may.
                const locked = !privileged && (isSelf || p.hr_role === 'manager')
                const lockReason = isSelf
                  ? 'Your own login can only be changed by the account owner or an administrator'
                  : 'A manager’s login can only be changed by the account owner or an administrator'
                return (
                  <tr key={p.id}>
                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{p.full_name || '—'}{isSelf && <span style={{ fontWeight: 400, color: 'var(--theme-text3)' }}> (you)</span>}</div>
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
                          aria-label={`Role for ${p.full_name || p.email || 'this staff member'}`}
                          value={currentTitle}
                          disabled={saving[p.id] || locked}
                          title={locked ? lockReason : undefined}
                          onChange={e => updateRole(p, e.target.value)}
                        >
                          {!currentTitle && <option value="" disabled>— pick a role —</option>}
                          {orphan && <option value={currentTitle} disabled>{currentTitle} — not in the role list</option>}
                          {effectiveRoles.map(r => {
                            const blocked = r.level === 'manager' && p.hr_role !== 'manager' && !privileged
                            return (
                              <option key={r.label} value={r.label} disabled={blocked}>
                                {r.label}{blocked ? managerOptionNote : ''}
                              </option>
                            )
                          })}
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
                      {p.hr_role
                        ? <span className={`badge ${LEVEL_BADGE[p.hr_role] || STAFF_LEVEL_BADGE_NONE}`}>{cap(p.hr_role)}</span>
                        : <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>—</span>
                      }
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                      {p.last_seen_at
                        ? new Date(p.last_seen_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                        : '—'}
                    </td>
                    <td>
                      {locked ? (
                        <Tip text={`${lockReason}.`}>
                          <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{isSelf ? 'your login' : 'owner only'}</span>
                        </Tip>
                      ) : (
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => openReset(p)}>
                            Reset Password
                          </button>
                          {!isSelf && (
                            <button
                              className="btn btn-ghost"
                              style={{ fontSize: 12, padding: '4px 10px', color: 'var(--theme-red-text)', borderColor: 'var(--theme-red)' }}
                              onClick={() => deleteStaff(p)}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      )}
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
        <Modal onClose={() => setRolesModal(false)} title="Manage HR Roles" maxWidth={480} panelStyle={{ maxHeight: '80vh', overflowY: 'auto' }}>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--theme-text3)' }}>
              Define custom role names for your team. Each maps to a permission level. Your first custom role is added
              alongside Staff / Supervisor / Manager, so nobody's current role disappears. Changing a role's level moves
              everyone who holds it — you will be asked first.
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
                  // A non-owner cannot move a held role to or from Manager: every holder's move
                  // would be refused by the server, leaving the list and the logins disagreeing.
                  const levelLocked = !privileged && held > 0 && r.level === 'manager'
                  return (
                    <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--theme-border-lt)' }}>
                      <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)' }}>
                        {r.label}
                        {held > 0 && <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text3)', marginLeft: 6 }}>{held} login{held === 1 ? '' : 's'}</span>}
                      </span>
                      <select
                        aria-label={`Permission level for ${r.label}`}
                        className="form-select"
                        style={{ width: 140, fontSize: 12 }}
                        value={r.level}
                        onChange={e => updateCustomRoleLevel(i, e.target.value)}
                        disabled={rolesSaving || levelLocked}
                        title={levelLocked ? 'Only the account owner can change the level of a Manager role people hold' : undefined}
                      >
                        {PERMISSION_LEVELS.map(l => {
                          const blocked = l.value === 'manager' && r.level !== 'manager' && held > 0 && !privileged
                          return <option key={l.value} value={l.value} disabled={blocked}>{l.label}{blocked ? managerOptionNote : ''}</option>
                        })}
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
                <label style={labelStyle} htmlFor="hrstaff-role-name">Role Name</label>
                <input
                  id="hrstaff-role-name"
                  className="form-input"
                  placeholder="e.g. Payroll Officer, HR Coordinator…"
                  value={newRole.label}
                  onChange={e => setNewRole(r => ({ ...r, label: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && addCustomRole()}
                />
              </div>
              <div style={{ width: 140 }}>
                <label style={labelStyle} htmlFor="hrstaff-role-level">Permission Level</label>
                <select
                  id="hrstaff-role-level"
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
          <div>

            {(unlinkedEmployees.length > 0 || (privileged && eligibleUsers.length > 0)) && (
              <div className="tab-bar" style={{ marginBottom: 16 }}>
                {unlinkedEmployees.length > 0 && (
                  <button className={`tab-btn${addMode === 'hr' ? ' tab-btn--active' : ''}`} onClick={() => setAddMode('hr')}>HR Employee</button>
                )}
                {privileged && eligibleUsers.length > 0 && (
                  <button className={`tab-btn${addMode === 'existing' ? ' tab-btn--active' : ''}`} onClick={() => setAddMode('existing')}>Existing User</button>
                )}
                <button className={`tab-btn${addMode === 'manual' ? ' tab-btn--active' : ''}`} onClick={() => setAddMode('manual')}>HR-only Staff</button>
              </div>
            )}

            {addMode === 'hr' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle} htmlFor="hrstaff-add-employee">
                  <Tip text="Links this HR staff login to an existing HR employee record — their name stays in sync with HR.">HR Employee</Tip>
                </label>
                {unlinkedEmployees.length === 0 ? (
                  <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: 0 }}>
                    Every active HR employee already has an HR staff account — add one in Employees first, or switch to another tab.
                  </p>
                ) : (
                  <SearchableSelect
                    id="hrstaff-add-employee"
                    options={unlinkedEmployees.map(e => ({ value: e.id, label: `${e.full_name}${e.employee_code ? ` (${e.employee_code})` : ''}` }))}
                    value={addForm.employee_id} onChange={v => setAddForm(f => ({ ...f, employee_id: v }))}
                    placeholder="Select employee…"
                  />
                )}
              </div>
            )}

            {addMode === 'existing' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle} htmlFor="hrstaff-add-existing-user">
                  <Tip text="Assigns an HR role to a login that already exists for this client (e.g. one created from Admin → Clients → Manage → Users) instead of creating a new one. Only accounts with no POS/HR/IMS role already set are shown. Never pick your own login — a role makes it a staff login and it stops being the owner's.">Existing User</Tip>
                </label>
                {eligibleUsers.length === 0 ? (
                  <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: 0 }}>
                    No eligible existing accounts — every account for this client already has a POS, HR, or IMS role.
                  </p>
                ) : (
                  <SearchableSelect
                    id="hrstaff-add-existing-user"
                    options={eligibleUsers.filter(u => u.id !== selfId).map(u => ({ value: u.id, label: `${u.full_name || '—'} (${u.email})` }))}
                    value={addForm.existing_user_id} onChange={v => setAddForm(f => ({ ...f, existing_user_id: v }))}
                    placeholder="Select user…"
                  />
                )}
              </div>
            )}

            {addMode === 'manual' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle} htmlFor="hrstaff-add-full-name">Full Name</label>
                <input
                  id="hrstaff-add-full-name"
                  className="form-input"
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
                  <label style={labelStyle} htmlFor="hrstaff-add-email">
                    <Tip text="Staff log in with this email and password — same login mechanism as your own account.">Email</Tip>
                  </label>
                  <input
                    id="hrstaff-add-email"
                    className="form-input"
                    type="email"
                    autoComplete="new-password"
                    placeholder="staff@example.com"
                    value={addForm.email}
                    onChange={e => setAddForm(f => ({ ...f, email: e.target.value }))}
                  />
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle} htmlFor="hrstaff-add-password">Initial Password ({MIN_PASSWORD_LENGTH}+ characters)</label>
                  <input
                    id="hrstaff-add-password"
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

            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle} htmlFor="hrstaff-add-role">
                <Tip text={privileged
                  ? 'The role shown for this staff member. Permission level is shown in brackets.'
                  : 'The role shown for this staff member. Permission level is shown in brackets. Only the account owner can give a login Manager access.'}>Role</Tip>
              </label>
              <select
                id="hrstaff-add-role"
                className="form-select"
                style={{ width: '100%' }}
                value={addForm.job_title}
                onChange={e => setAddForm(f => ({ ...f, job_title: e.target.value }))}
              >
                {effectiveRoles.map(r => {
                  const blocked = r.level === 'manager' && !privileged
                  return (
                    <option key={r.label} value={r.label} disabled={blocked}>
                      {r.label} ({cap(r.level)}){blocked ? managerOptionNote : ''}
                    </option>
                  )
                })}
              </select>
            </div>

            {addMsg && <ActionError error={addMsg} />}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setAddModal(false)} disabled={adding}>Cancel</button>
              <button className="btn btn-primary" onClick={addStaff} disabled={adding}>
                {adding ? 'Creating…' : 'Add Staff'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Reset Password modal ─────────────────────────────────────────────── */}
      {pwTarget && (
        <Modal onClose={() => { if (!resetting) setPwTarget(null) }} title="Reset Password" maxWidth={340}>
          <div>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--theme-text3)' }}>
              New password for <strong style={{ color: 'var(--theme-text1)' }}>{pwTarget.full_name}</strong>
            </p>
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle} htmlFor="hrstaff-new-password">New Password ({MIN_PASSWORD_LENGTH}+ characters)</label>
              <input
                id="hrstaff-new-password"
                className="form-input"
                type="password"
                autoComplete="new-password"
                placeholder={`Min. ${MIN_PASSWORD_LENGTH} characters`}
                value={newPassword}
                autoFocus
                onChange={e => setNewPassword(e.target.value)}
              />
            </div>
            {pwMsg && <ActionError error={pwMsg} />}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setPwTarget(null)} disabled={resetting}>Cancel</button>
              <button className="btn btn-primary" onClick={resetPassword} disabled={resetting}>
                {resetting ? 'Saving…' : 'Save Password'}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {confirmEl}
    </div>
  )
}
