import { useEffect, useId, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { supabase } from '../../supabaseClient'
import { scopedFrom, scopedUpdate, scopedDelete } from '../../shared/scopedDb'
import { useAuth } from '../../context/AuthContext'
import { useSettings } from '../../context/SettingsContext'
import { formatAd } from '../../utils/bsCalendar'
import BsCalendarPicker from '../../components/BsCalendarPicker'
import { getDateStatus } from '../../utils/subscription'
import { validateEmvQr } from '../../utils/emvQr'
import Tip from '../../components/Tip'
import Modal from '../../components/Modal'
import { MIN_PASSWORD_LENGTH } from '../../utils/weakPasswords'
import { adminOp } from './adminOp'
import { MODULE_COLORS, IMS_TIERS, HR_PRICING, POS_PRICING, SUITE_BUNDLES } from '../../data/pricingPlans'
import { runBackup } from '../../modules/admin/dataExport/runBackup'
import { restoreClientData } from '../../modules/admin/dataExport/restoreClientData'
import {
  pickBackupDirectory, ensureBackupDirectory, isFileSystemAccessSupported,
} from '../../modules/admin/dataExport/backupDirectory'

const EMPTY_USER = { email: '', password: '', full_name: '' }

// Auto-fit instead of a declared column count (DESIGN.md's Auto-Fit-First Rule). This drawer is a
// centred modal that is 880px on a desktop and ~340px on a phone; the hardcoded `1fr 1fr` this
// replaces left every field about 149px wide at the narrow end, with no breakpoint to rescue it.
const FIELD_GRID = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
  gap: 12,
}

const SETTINGS_DEFAULTS = {
  app_name: '', app_tagline: '', property_address: '', property_phone: '',
  property_email: '', vat_number: '', fc_warning_pct: 35, fc_critical_pct: 45,
  expiry_warning_days: 7, variance_flag_pct: 10, item_code_prefix: 'ITM',
  contact_phone: '', contact_email: '', contact_website: '',
  is_vat_registered: true, invoice_prefix: '', payment_qr_data: ''
}
// pos_webhook_secret deliberately is NOT in the object above and is held in its own state below.
// It moved out of `settings` into the admin-only client_secrets table (migration 20260810140000)
// because settings_select let every account of the client read it — including a POS PIN waiter,
// who could then forge a signed payment confirmation for their own open bill. Keeping it out of
// clientSettings means all three saveClientSettings() call sites stay correct for free, rather
// than each needing to remember to strip a field the settings table no longer has.

// 32 random bytes, hex-encoded — pasted into the merchant's webhook-signing-secret field once
// a real FonePay/eSewa integration exists (see supabase/functions/pos-payment-webhook).
function generateWebhookSecret() {
  const bytes = new Uint8Array(32)
  window.crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Derives a short invoice-number prefix from the property/business name, e.g. "Casa Acai Cafe" -> "CAC"
function deriveInvoicePrefix(name) {
  if (!name) return ''
  return name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 5)
}

export default function ClientDrawer({ client, onClose, onClientUpdated }) {
  const { adminViewClientId, refreshViewModules } = useAuth()
  const { loadClientSettings, saveClientSettings } = useSettings()
  const [activeTab, setActiveTab] = useState('users')

  // Every input in this drawer needs an id its <label> can point at — 22 fields shipped with a
  // label that was a sibling of its input and connected to it by nothing, so a screen reader
  // announced each one as an unnamed edit box and clicking a label focused nothing.
  const uid = useId()
  const fid = name => `${uid}-${name}`

  // Users tab state
  const [users, setUsers]               = useState([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [userForm, setUserForm]         = useState(EMPTY_USER)
  const [savingUser, setSavingUser]     = useState(false)
  const [userError, setUserError]       = useState('')
  const [userSuccess, setUserSuccess]   = useState('')

  // Staff PINs tab state. revealedPins is intentionally NOT seeded from any query — a PIN only
  // ever enters this component as the response to an explicit, audited reveal.
  const [pinAccounts, setPinAccounts]   = useState([])
  const [loadingPins, setLoadingPins]   = useState(false)
  const [revealedPins, setRevealedPins] = useState({})
  const [revealingId, setRevealingId]   = useState(null)
  const [pinErr, setPinErr]             = useState('')
  const revealTimersRef                 = useRef({})
  useEffect(() => () => {
    Object.values(revealTimersRef.current).forEach(clearTimeout)
  }, [])

  // Settings tab state
  const [clientSettings, setClientSettings]   = useState(SETTINGS_DEFAULTS)
  const [loadingSettings, setLoadingSettings] = useState(false)
  const [savingSettings, setSavingSettings]   = useState(false)
  const [settingsMsg, setSettingsMsg]         = useState('')
  // Settings, Thresholds and QR are three views of one `clientSettings` object, so fetching on
  // every switch between them re-ran two network calls to rebuild state the drawer already held.
  const settingsLoadedRef = useRef(false)
  const [webhookSecret, setWebhookSecret]     = useState('') // client_secrets, not settings — see SETTINGS_DEFAULTS

  // QR tab state. Both the parse and the encode are keyed off the payload only — they used to run
  // on every render and every keystroke respectively, re-encoding a ~200-character payload once
  // per typed character while the admin pasted it in.
  const [qrPreview, setQrPreview] = useState('')
  const qrPayload = clientSettings.payment_qr_data || ''
  const qrCheck = useMemo(() => validateEmvQr(qrPayload), [qrPayload])
  useEffect(() => {
    if (!qrCheck.ok) { setQrPreview(''); return }
    // Debounced: a paste settles in one encode, and typing does not queue one per character.
    const t = setTimeout(() => {
      QRCode.toDataURL(qrPayload.trim(), { margin: 1, width: 180 })
        .then(setQrPreview).catch(() => setQrPreview(''))
    }, 250)
    return () => clearTimeout(t)
  }, [qrPayload, qrCheck.ok])

  // Modules state
  const [imsEnabled, setImsEnabled] = useState(client.ims_enabled !== false)
  const [hrEnabled,  setHrEnabled]  = useState(!!client.hr_enabled)
  const [hrPlan,  setHrPlan]        = useState(client.hr_plan  || 'starter')
  const [posEnabled, setPosEnabled] = useState(!!client.pos_enabled)
  const [posPlan, setPosPlan]       = useState(client.pos_plan || 'starter')
  // Suite bundle tier — a separate gating axis from the per-module plans above (gates
  // Owner Dashboard). Unlike hrPlan/posPlan, null means "not subscribed to Suite at all",
  // not a free default tier.
  const [suitePlan, setSuitePlan]   = useState(client.suite_plan || null)

  // Billing tab state — per-module end dates; fall back to legacy subscription_ends_at for IMS
  const _legacyEnd = client.subscription_ends_at ? formatAd(new Date(client.subscription_ends_at)) : ''
  const [imsEndsAt, setImsEndsAt] = useState(client.ims_ends_at ? formatAd(new Date(client.ims_ends_at)) : _legacyEnd)
  const [hrEndsAt,  setHrEndsAt]  = useState(client.hr_ends_at  ? formatAd(new Date(client.hr_ends_at))  : '')
  const [posEndsAt, setPosEndsAt] = useState(client.pos_ends_at ? formatAd(new Date(client.pos_ends_at)) : '')
  const [suiteEndsAt, setSuiteEndsAt] = useState(client.suite_ends_at ? formatAd(new Date(client.suite_ends_at)) : '')
  const [billingCycle, setBillingCycle] = useState(client.billing_cycle || 'monthly')
  const [savingSub, setSavingSub] = useState(false)
  const [subMsg, setSubMsg]       = useState('')

  // Logo upload state (Settings tab)
  const logoInputRef = useRef(null)
  const [logoUploading, setLogoUploading] = useState(false)
  const [logoMsg, setLogoMsg] = useState('')

  // Danger Zone state — tracks which specific action is in flight so only that
  // button shows "Working…"; all buttons still disable together to block concurrent runs.
  const [deletingAction, setDeletingAction] = useState(null)
  const deleting = !!deletingAction
  const [deleteMsg, setDeleteMsg] = useState('')

  // Export / Import state
  const [backupState, setBackupState] = useState('none')   // 'none' | 'granted' | 'prompt' | 'denied'
  const [backupBusy, setBackupBusy]   = useState(false)
  const [backupMsg, setBackupMsg]     = useState('')
  const [backupProgress, setBackupProgress] = useState('')
  const [lastBackupAt, setLastBackupAt] = useState(client?.last_backup_at || null)
  // Escape hatch for the pre-flight backup. Without it, an admin on Firefox/Safari — or on a
  // machine where no folder has been chosen — could never run a Danger Zone action at all.
  const [skipBackup, setSkipBackup]   = useState(false)
  const [restoreMsg, setRestoreMsg]   = useState('')
  const [restoreBusy, setRestoreBusy] = useState(false)

  // Edit client state
  const [editForm, setEditForm]   = useState({
    name: client.name,
    location: client.location || '',
    contact_person: client.contact_person || '',
    contact_phone: client.contact_phone || ''
  })
  const [savingClient, setSavingClient] = useState(false)
  const [clientMsg, setClientMsg]       = useState('')
  const [currentPlan, setCurrentPlan]   = useState(client.plan || 'starter')

  useEffect(() => {
    loadUsers()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id])

  useEffect(() => {
    if ((activeTab === 'settings' || activeTab === 'thresholds' || activeTab === 'qr') && !settingsLoadedRef.current) {
      fetchClientSettings()
    }
    if (activeTab === 'pins') loadPinAccounts()
    // request:false — this runs on tab switch, not on a click, and requestPermission() outside a
    // user gesture is rejected. Reading the state is enough to decide what to render.
    if (activeTab === 'data' || activeTab === 'danger') {
      ensureBackupDirectory({ request: false }).then(({ state }) => setBackupState(state))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  // ── Staff PINs ──
  // Reads profiles and staff_pin_vault directly rather than through an RPC: both are readable
  // here because admin passes profiles_select's `is_admin()` branch and staff_pin_vault is an
  // admin-only table. The PIN itself never comes from either query — only whether one is stored.
  async function loadPinAccounts() {
    setLoadingPins(true); setPinErr(''); setRevealedPins({})
    const [{ data: profs }, { data: vaultRows }] = await Promise.all([
      supabase.from('profiles')
        .select('id, full_name, pos_email, hr_self_service')
        .eq('client_id', client.id)
        .or('pos_email.not.is.null,hr_self_service.eq.true'),
      supabase.from('staff_pin_vault').select('user_id, updated_at').eq('client_id', client.id),
    ])
    const storedAt = new Map((vaultRows || []).map(v => [v.user_id, v.updated_at]))
    setPinAccounts((profs || []).map(p => ({
      id:        p.id,
      full_name: p.full_name,
      kind:      p.pos_email ? 'POS' : 'Self-Service',
      storedAt:  storedAt.get(p.id) || null,
    })).sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '')))
    setLoadingPins(false)
  }

  async function revealPin(userId) {
    setRevealingId(userId); setPinErr('')
    try {
      const res = await adminOp('view_staff_pin', { userId })
      setRevealedPins(prev => ({ ...prev, [userId]: res.pin }))
      // Auto-mask. A PIN left on screen behind a drawer is a shoulder-surfing problem, and this
      // drawer stays open across other admin work. Tracked so closing the drawer mid-window
      // cancels the timer instead of leaving it to fire into an unmounted component.
      revealTimersRef.current[userId] = setTimeout(() => setRevealedPins(prev => {
        const next = { ...prev }; delete next[userId]; return next
      }), 30000)
    } catch (e) {
      setPinErr(e.message || 'Could not reveal PIN')
    }
    setRevealingId(null)
  }

  // One-time reconciliation: a suite_plan that predates handleSuitePlanPick (or was edited
  // directly in the DB) can be inconsistent with the modules/plans it should imply — self-corrects
  // the moment this client's drawer opens, instead of only enforcing consistency on the next
  // manual re-pick. Writes straight to the DB (not staged for Save Subscription) since this is
  // fixing bad existing data, not a pending edit the admin should get to review first.
  useEffect(() => {
    if (!client.suite_plan) return
    const inconsistent =
      client.ims_enabled === false || !client.hr_enabled || !client.pos_enabled ||
      client.plan !== client.suite_plan || client.hr_plan !== client.suite_plan || client.pos_plan !== client.suite_plan
    if (!inconsistent) return
    setImsEnabled(true)
    setHrEnabled(true)
    setPosEnabled(true)
    setCurrentPlan(client.suite_plan)
    setHrPlan(client.suite_plan)
    setPosPlan(client.suite_plan)
    supabase.from('clients').update({
      ims_enabled: true, hr_enabled: true, pos_enabled: true,
      plan: client.suite_plan, hr_plan: client.suite_plan, pos_plan: client.suite_plan,
    }).eq('id', client.id).then(({ error }) => {
      if (error) { setSubMsg('error:' + error.message); return }
      setSubMsg('ok:Suite Bundle was out of sync with modules/plans — auto-corrected.')
      onClientUpdated()
      if (client.id === adminViewClientId) refreshViewModules()
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id])

  // ── Users ──
  async function loadUsers() {
    setLoadingUsers(true)
    const { data: profs } = await supabase
      .from('profiles')
      .select('id, full_name, role, client_id')
      .eq('client_id', client.id)
    // One batched call for all this client's emails — replaces N per-user edge
    // calls (which raced/rate-limited and showed blank emails).
    const { data: emailRows } = await supabase.rpc('client_user_emails', { p_client_id: client.id })
    const emailMap = Object.fromEntries((emailRows || []).map(r => [r.id, r.email]))
    setUsers((profs || []).map(u => ({ ...u, email: emailMap[u.id] || '' })))
    setLoadingUsers(false)
  }

  async function createUser() {
    if (!userForm.email.trim() || !userForm.password.trim()) {
      setUserError('Email and password are required.'); return
    }
    // MIN_PASSWORD_LENGTH, not a local literal. This form hardcoded 6 while the shared constant
    // (and Login/ResetPassword, which both render it into their own hints) said 8 — so a
    // 7-character password passed here, on the form that creates a tenant's Owner login.
    if (userForm.password.length < MIN_PASSWORD_LENGTH) {
      setUserError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`); return
    }
    setSavingUser(true); setUserError(''); setUserSuccess('')

    const email = userForm.email.trim()
    const password = userForm.password.trim()
    const full_name = userForm.full_name.trim()

    let authData
    try {
      const result = await adminOp('createUser', { email, password, full_name })
      authData = result?.data
    } catch (err) {
      const already = /already.*registered|already.*exists|duplicate/i.test(err.message || '')
      if (already) { await reassignExistingUser(email, full_name); return }
      setUserError('Could not create user: ' + err.message)
      setSavingUser(false)
      return
    }

    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({ id: authData.user.id, client_id: client.id, full_name, role: 'client' }, { onConflict: 'id' })
    if (profileError) { setUserError('User created but profile link failed: ' + profileError.message); setSavingUser(false); return }

    setUserSuccess(`✓ ${email} created and linked.`)
    setUserForm(EMPTY_USER)
    setSavingUser(false)
    loadUsers()
  }

  // Email already exists → reassign that login to THIS client (one client at a time).
  // Uses the admin-guarded SQL function find_user_id_by_email. Refuses admin accounts.
  // The login keeps its existing password (we don't reset it on a move).
  async function reassignExistingUser(email, full_name) {
    try {
      const { data: existingId, error: findErr } = await supabase.rpc('find_user_id_by_email', { p_email: email })
      if (findErr) { setUserError('Could not look up the email: ' + findErr.message); setSavingUser(false); return }
      if (!existingId) {
        setUserError('That email already exists but could not be located to reassign.')
        setSavingUser(false); return
      }
      const { data: prof } = await supabase.from('profiles').select('role').eq('id', existingId).maybeSingle()
      if (prof?.role === 'admin') {
        setUserError('That email is a platform-admin account — use a different email for a client login.')
        setSavingUser(false); return
      }
      if (!window.confirm(`${email} already has a client login. Move it to "${client.name}"? It loses access to its previous client. (Its existing password is kept.)`)) {
        setSavingUser(false); return
      }
      // upsert (not update): some older auth users have no profiles row, so a
      // plain update would silently match 0 rows. .select() confirms it persisted.
      const row = { id: existingId, client_id: client.id, role: 'client' }
      if (full_name) row.full_name = full_name
      const { data: saved, error: upErr } = await supabase.from('profiles').upsert(row, { onConflict: 'id' }).select('id')
      if (upErr) { setUserError('Could not reassign: ' + upErr.message); setSavingUser(false); return }
      if (!saved || saved.length === 0) {
        setUserError('Reassign did not take effect — the profiles table is blocking it (RLS). Run the admin-profiles policy fix, then retry.')
        setSavingUser(false); return
      }
      setUserSuccess(`✓ ${email} reassigned to this client.`)
      setUserForm(EMPTY_USER)
      setSavingUser(false)
      loadUsers()
    } catch (err) {
      setUserError('Could not reassign user: ' + err.message)
      setSavingUser(false)
    }
  }

  async function deleteUser(user) {
    if (!window.confirm(`Delete "${user.full_name}" (${user.email})? This permanently removes the login and frees the email to be reused.`)) return
    setUserError('')
    try {
      await adminOp('deleteUser', { userId: user.id })
    } catch (err) {
      const alreadyGone = /not found/i.test(err.message)
      if (!alreadyGone) {
        // Auth user still exists but deletion failed — don't remove the profile
        // or the email stays locked with no way to clean it up.
        setUserError('Could not delete the login (email stays in use): ' + err.message)
        return
      }
      // Auth user was already deleted — fall through and clean up the orphaned profile
    }
    await supabase.from('profiles').delete().eq('id', user.id)
    setUserSuccess('✓ User deleted and email freed.')
    loadUsers()
  }

  // ── Client edit ──
  async function saveClientEdit() {
    if (!editForm.name.trim()) { setClientMsg('error:Name is required.'); return }
    setSavingClient(true); setClientMsg('')
    const { error } = await supabase.from('clients').update({
      name: editForm.name.trim(),
      location: editForm.location.trim(),
      contact_person: editForm.contact_person.trim(),
      contact_phone: editForm.contact_phone.trim()
    }).eq('id', client.id)
    if (error) { setSavingClient(false); setClientMsg('error:' + error.message); return }

    // Keep settings.app_name in sync with client name
    if (editForm.name.trim() !== client.name) {
      const { data: existing } = await supabase.from('settings').select('id').eq('client_id', client.id).maybeSingle()
      if (existing?.id) {
        await supabase.from('settings').update({ app_name: editForm.name.trim() }).eq('id', existing.id)
      } else {
        await supabase.from('settings').insert({ client_id: client.id, app_name: editForm.name.trim() })
      }
    }

    setSavingClient(false)
    setClientMsg('ok:Client updated.')
    onClientUpdated()
  }

  // ── Settings ──
  async function fetchClientSettings() {
    setLoadingSettings(true)
    // Separate read: the webhook secret lives in client_secrets, which is admin-only at the RLS
    // level, so it can't ride along on the settings row any more.
    const { data: secretRow } = await supabase
      .from('client_secrets').select('pos_webhook_secret').eq('client_id', client.id).maybeSingle()
    setWebhookSecret(secretRow?.pos_webhook_secret || '')
    const data = await loadClientSettings(client.id)
    if (data) {
      setClientSettings(prev => {
        const merged = { ...prev, ...data }
        if (!merged.invoice_prefix && merged.app_name) merged.invoice_prefix = deriveInvoicePrefix(merged.app_name)
        return merged
      })
    }
    settingsLoadedRef.current = true
    setLoadingSettings(false)
  }

  // `what` names what the admin actually pressed — the three tabs share one save handler, so a
  // "Save Thresholds" or "Save QR" click used to report back "Settings saved."
  async function handleSaveSettings(what = 'Settings') {
    setSavingSettings(true); setSettingsMsg('')
    try {
      await saveClientSettings(client.id, clientSettings)
      // Webhook secret writes to its own admin-only table. Upserted alongside because this one
      // handler backs both the Settings tab's Save and the QR tab's "Save Webhook Secret" button.
      const { error: secretErr } = await supabase
        .from('client_secrets')
        .upsert({ client_id: client.id, pos_webhook_secret: webhookSecret.trim() || null, updated_at: new Date().toISOString() },
                { onConflict: 'client_id' })
      if (secretErr) throw new Error(secretErr.message)
      setSettingsMsg(`ok:${what} saved.`)
    } catch (e) {
      setSettingsMsg('error:' + e.message)
    }
    setSavingSettings(false)
  }

  // ── Module toggles (instant save) — a no-op while a Suite Bundle is active, since the bundle
  // requires all three modules together; toggle one off first only after dropping back to
  // "Not Subscribed" on the Suite Bundle picker below. ──
  async function handleToggleIms() {
    if (suitePlan) return
    const next = !imsEnabled
    setImsEnabled(next)
    await supabase.from('clients').update({ ims_enabled: next }).eq('id', client.id)
    onClientUpdated()
    if (client.id === adminViewClientId) refreshViewModules()
  }

  async function handleToggleHr() {
    if (suitePlan) return
    const next = !hrEnabled
    setHrEnabled(next)
    await supabase.from('clients').update({ hr_enabled: next }).eq('id', client.id)
    onClientUpdated()
    if (client.id === adminViewClientId) refreshViewModules()
  }

  async function handleTogglePos() {
    if (suitePlan) return
    const next = !posEnabled
    setPosEnabled(next)
    await supabase.from('clients').update({ pos_enabled: next }).eq('id', client.id)
    onClientUpdated()
    if (client.id === adminViewClientId) refreshViewModules()
  }

  // Picking a bundle means all three modules are included — keep this tab's other fields
  // consistent with that instead of allowing a contradictory state (e.g. Suite Pro selected while
  // IMS sits toggled off). Takes effect on the next Save Subscription, same as the plan/date
  // fields below; picking "Not Subscribed" (key=null) only clears the bundle and leaves whatever
  // modules/plans were already set untouched, since modules can still be sold individually.
  function handleSuitePlanPick(key) {
    setSuitePlan(key)
    if (key) {
      setImsEnabled(true)
      setHrEnabled(true)
      setPosEnabled(true)
      setCurrentPlan(key)
      setHrPlan(key)
      setPosPlan(key)
    }
  }

  // ── Billing ──
  function extendModule(setter, days) {
    const d = new Date()
    d.setDate(d.getDate() + days)
    setter(formatAd(d))
  }

  async function handleSaveSub() {
    setSavingSub(true); setSubMsg('')
    const { error } = await supabase.from('clients').update({
      // Included here (not just the instant-save toggles above) so picking a Suite Bundle — which
      // updates these locally via handleSuitePlanPick but doesn't write to the DB itself — actually
      // persists on Save, instead of silently reverting the next time this drawer is opened.
      ims_enabled:   imsEnabled,
      hr_enabled:    hrEnabled,
      pos_enabled:   posEnabled,
      ims_ends_at:   imsEndsAt || null,
      hr_ends_at:    hrEndsAt  || null,
      pos_ends_at:   posEndsAt || null,
      suite_ends_at: suiteEndsAt || null,
      plan:          currentPlan,
      hr_plan:       hrPlan,
      pos_plan:      posPlan,
      suite_plan:    suitePlan,
      billing_cycle: billingCycle,
    }).eq('id', client.id)
    if (error) { setSubMsg('error:' + error.message) }
    else {
      setSubMsg('ok:Subscription saved.')
      onClientUpdated()
      if (client.id === adminViewClientId) refreshViewModules()
    }
    setSavingSub(false)
  }

  // ── Export / Import ──
  async function handleChooseFolder() {
    setBackupMsg('')
    try {
      await pickBackupDirectory()
      const { state } = await ensureBackupDirectory({ request: true })
      setBackupState(state)
      setBackupMsg(state === 'granted' ? 'ok:Backup folder set.' : 'error:Folder chosen but write permission was not granted.')
    } catch (err) {
      // AbortError covers BOTH "user closed the picker" and "the environment refused the call"
      // — Chrome throws it verbatim when something intercepts the file-chooser dialog (an
      // automation harness, certain embedded webviews). Treating it purely as a cancel meant a
      // blocked picker produced a button that did nothing and said nothing, which is how this
      // was found. There is no way to tell the two apart, so say something that covers both
      // rather than staying silent on a failure.
      setBackupMsg(err.name === 'AbortError'
        ? 'error:Folder selection was cancelled, or blocked by this browser. Exports will download instead.'
        : 'error:' + err.message)
    }
  }

  async function handleExportNow(reason = 'manual') {
    setBackupBusy(true)
    setBackupMsg('')
    setBackupProgress('')
    try {
      const { location, manifest, method } = await runBackup(client.id, client.name, reason, {
        onProgress: (label, done, total) => setBackupProgress(`${label} (${done}/${total})`),
      })
      setLastBackupAt(new Date().toISOString())
      setBackupMsg(`ok:${manifest.totalRows.toLocaleString()} rows written to ${location}${method === 'download' ? ' (downloaded — file it manually)' : ''}`)
      onClientUpdated()
      return true
    } catch (err) {
      setBackupMsg('error:' + err.message)
      return false
    } finally {
      setBackupBusy(false)
      setBackupProgress('')
    }
  }

  // Gate in front of every destructive action. Returns false to abort.
  //
  // Blocking by default and never blocking absolutely: if the backup cannot run, the admin is
  // told exactly why and can tick "I have backed up elsewhere" to proceed. A gate with no
  // override would make Danger Zone unreachable on any browser without the File System Access
  // API, which is a worse outcome than the risk it guards against.
  async function preflightBackup(reason) {
    if (skipBackup) return true
    setDeleteMsg('')
    const ok = await handleExportNow(reason)
    if (!ok) {
      setDeleteMsg('error:Backup failed, so nothing was deleted. Fix the backup, or tick "I have backed up elsewhere" to proceed anyway.')
    }
    return ok
  }

  async function handleRestoreFile(file) {
    if (!file) return
    setRestoreBusy(true)
    setRestoreMsg('')
    try {
      const parsed = JSON.parse(await file.text())
      const result = await restoreClientData(client.id, parsed, {
        onProgress: (label, done, total) => setRestoreMsg(`info:Restoring ${label} (${done}/${total})…`),
      })
      let note = ''

      // Only rebuild logins when the target has none. After an Archive the accounts were never
      // deleted, so re-provisioning would create a second set of PIN logins for the same people;
      // after a full Delete there are none, which is exactly when this is wanted.
      const { count: existingLogins } = await supabase
        .from('profiles').select('id', { count: 'exact', head: true })
        .eq('client_id', client.id).not('pos_email', 'is', null)
      if ((existingLogins || 0) > 0) {
        note = ' Existing staff logins were left untouched.'
      } else {
        setRestoreMsg('info:Rebuilding staff logins…')
        const accounts = await adminOp('restore_staff_accounts', {
          client_id: client.id,
          roster: parsed.data?.profiles || [],
          vault:  parsed.data?.staff_pin_vault || [],
        })
        const restoredCount = accounts.restored?.length || 0
        note = restoredCount ? ` ${restoredCount} PIN login${restoredCount !== 1 ? 's' : ''} restored with their original PINs.` : ''
        if (accounts.manual?.length) {
          note += ` ${accounts.manual.length} account${accounts.manual.length !== 1 ? 's' : ''} must be recreated by hand: ` +
            accounts.manual.map(m => `${m.full_name} (${m.kind})`).join(', ') + '.'
        }
      }

      setRestoreMsg(`ok:Restored ${result.inserted.toLocaleString()} rows across ${result.tables} tables.${note}` +
        (result.skipped.length ? ` Skipped: ${result.skipped.join(', ')}.` : ''))
      onClientUpdated()
    } catch (err) {
      setRestoreMsg('error:' + err.message)
    }
    setRestoreBusy(false)
  }

  // ── Danger Zone ──
  async function handleClearConversions() {
    const { data: withConv } = await scopedFrom('items', client.id, 'id').not('purchase_unit', 'is', null)
    const count = withConv?.length || 0
    if (count === 0) { setDeleteMsg('ok:No items have a conversion set.'); return }
    if (!window.confirm(
      `Clear unit conversions on ${count} item${count !== 1 ? 's' : ''} for "${client.name}"?\n\n` +
      `Purchase Unit, Base Unit, Conversion Factor and Purchase Qty will be reset to 1 for each affected item.\n\n` +
      `This cannot be undone.`
    )) return
    setDeletingAction('conversions'); setDeleteMsg('')
    const { error } = await scopedUpdate('items', client.id, { purchase_unit: null, base_unit: null, conversion_factor: 1, purchase_qty: 1 })
      .not('purchase_unit', 'is', null)
    setDeletingAction(null)
    setDeleteMsg(error ? 'error:' + error.message : `ok:Conversions cleared on ${count} item${count !== 1 ? 's' : ''}.`)
  }

  async function handleClearModule(module) {
    const labels = {
      ims: 'IMS transactions (purchases, stock counts, wastage, staff meals, sales, budgets, payables, POs, requisitions, overheads, stock movements)\n\nKEPT: items, vendors, categories, recipes, par levels, and periods',
      hr:  'HR transactions (attendance, payroll runs, payslips, leave requests, overtime, advances + repayments, festival allowances, roster)\n\nKEPT: employees, salary components, leave types, holiday calendar, shift types',
      pos: 'POS transactions (orders, order items, shifts, customers, POS-sourced sales entries, stock movements)\n\nKEPT: tables, floor plan, staff accounts + PINs. Occupied tables are freed.',
    }
    if (!window.confirm(
      `Clear ${module.toUpperCase()} transactions for "${client.name}"?\n\n` +
      `This deletes: ${labels[module]}\n\n` +
      `This cannot be undone.`
    )) return
    setDeletingAction(module)
    setDeleteMsg('')
    try {
      if (!await preflightBackup('predelete')) { setDeletingAction(null); return }
      await adminOp('clearModuleData', { clientId: client.id, module })
      setDeleteMsg(`ok:${module.toUpperCase()} transactions cleared. Setup data was kept.`)
    } catch (err) {
      setDeleteMsg('error:' + err.message)
    }
    setDeletingAction(null)
  }

  async function handleDeleteClientData() {
    if (!window.confirm(
      `Clear ALL operational data for "${client.name}"?\n\n` +
      `This removes everything across all modules:\n` +
      `IMS — categories, items, vendors, recipes, purchases, stock, sales, overheads, payables, and all periods\n` +
      `HR — employees, salary setup, attendance, payroll, leave, advances, roster, holidays\n` +
      `POS — tables, orders, shifts, customers, stock movements\n\n` +
      `The client record, user accounts, feature flags, and settings are kept intact.\n\n` +
      `This cannot be undone.`
    )) return
    setDeletingAction('clientData')
    setDeleteMsg('')
    try {
      if (!await preflightBackup('predelete')) { setDeletingAction(null); return }
      await adminOp('deleteClientData', { clientId: client.id })
      setDeleteMsg('ok:All client data has been permanently erased.')
    } catch (err) {
      setDeleteMsg('error:' + err.message)
    }
    setDeletingAction(null)
  }

  // Archive — the recommended path for a client who leaves.
  //
  // Composed entirely from things that already exist: a backup, the existing deleteClientData
  // (which keeps the client row, settings, feature flags, profiles and every auth login), and
  // is_active=false. That last step only became meaningful in S544, where is_active stopped
  // being a badge colour and started locking the app via SubscriptionLock.
  //
  // The result is fully reversible: a restore brings the data back and the logins never left.
  async function handleArchiveClient() {
    if (!window.confirm(
      `Archive "${client.name}"?\n\n` +
      `A backup is taken first, then all operational data is cleared and the client is deactivated.\n\n` +
      `Their user accounts, logins, settings and the client record are KEPT — so this can be fully ` +
      `reversed by restoring the backup. Use this rather than Delete for a client who is leaving.`
    )) return
    setDeletingAction('archive')
    setDeleteMsg('')
    try {
      if (!await preflightBackup('archive')) { setDeletingAction(null); return }
      await adminOp('deleteClientData', { clientId: client.id })
      const { error } = await supabase.from('clients').update({ is_active: false }).eq('id', client.id)
      if (error) throw new Error(error.message)
      setDeleteMsg('ok:Client archived — data cleared, logins kept, account locked. Restore the backup to reverse this.')
      onClientUpdated()
    } catch (err) {
      setDeleteMsg('error:' + err.message)
    }
    setDeletingAction(null)
  }

  async function handleDeleteClient() {
    if (!window.confirm(
      `Permanently DELETE the client "${client.name}"?\n\n` +
      `This removes EVERYTHING: all operational data, user accounts, feature flags, settings, and the client record itself.\n\n` +
      `This cannot be undone.`
    )) return
    setDeletingAction('deleteClient')
    setDeleteMsg('')
    try {
      // Must run before the auth users go — the backup's account roster is read from `profiles`,
      // and this sequence deletes those first.
      if (!await preflightBackup('predelete')) { setDeletingAction(null); return }
      // Delete all user auth accounts for this client
      const { data: profiles } = await supabase.from('profiles').select('id').eq('client_id', client.id)
      for (const p of (profiles || [])) {
        await adminOp('deleteUser', { userId: p.id })
      }
      // Delete operational data, settings, feature flags, then the client record
      await adminOp('deleteClientData', { clientId: client.id })
      await supabase.from('settings').delete().eq('client_id', client.id)
      await scopedDelete('feature_flags', client.id)
      await supabase.from('clients').delete().eq('id', client.id)
      onClientUpdated()
      onClose()
    } catch (err) {
      setDeleteMsg('error:' + err.message)
      setDeletingAction(null)
    }
  }

  async function handleLogoUpload(file) {
    if (file.size > 2 * 1024 * 1024) { setLogoMsg('error:File must be under 2MB.'); return }
    setLogoUploading(true); setLogoMsg('')
    const ext = file.name.split('.').pop().toLowerCase()
    const path = `${client.id}/logo.${ext}`
    const { error: uploadErr } = await supabase.storage.from('Logos').upload(path, file, { upsert: true, contentType: file.type })
    if (uploadErr) { setLogoMsg('error:' + uploadErr.message); setLogoUploading(false); return }
    const { data: { publicUrl } } = supabase.storage.from('Logos').getPublicUrl(path)
    const updated = { ...clientSettings, logo_url: publicUrl }
    setClientSettings(updated)
    await saveClientSettings(client.id, updated)
    setLogoMsg('ok:Logo saved.')
    setLogoUploading(false)
  }

  async function handleLogoRemove() {
    const updated = { ...clientSettings, logo_url: null }
    setClientSettings(updated)
    await saveClientSettings(client.id, updated)
    setLogoMsg('ok:Logo removed.')
  }

  const tabs = [
    { key: 'users',      label: 'Users' },
    { key: 'pins',       label: 'Staff PINs' },
    { key: 'billing',    label: 'Billing' },
    { key: 'settings',   label: 'Settings' },
    { key: 'thresholds', label: 'Thresholds' },
    { key: 'qr',         label: 'QR' },
    { key: 'data',       label: 'Backup' },
    { key: 'danger',     label: '⚠ Danger' },
  ]

  function selectTab(key) {
    setActiveTab(key)
    // Both messages are shared across tabs, so without this a "Settings saved." or a Danger Zone
    // result follows the admin onto an unrelated tab and reads as a response to whatever is there.
    setDeleteMsg('')
    setSettingsMsg('')
  }

  // Arrow keys move within the tab row, Home/End jump to its ends — the standard tablist keyboard
  // contract that goes with the roving tabIndex below.
  function onTabKeyDown(e) {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
    let nextIndex = null
    if (e.key in keys) {
      const i = tabs.findIndex(t => t.key === activeTab)
      nextIndex = (i + keys[e.key] + tabs.length) % tabs.length
    } else if (e.key === 'Home') nextIndex = 0
    else if (e.key === 'End') nextIndex = tabs.length - 1
    if (nextIndex === null) return
    e.preventDefault()
    const next = tabs[nextIndex]
    selectTab(next.key)
    document.getElementById(fid(`tab-${next.key}`))?.focus()
  }

  // The client name + plan badge, handed to Modal as its title so the shared header row
  // (title left, × right) stays the one implementation.
  const modalTitle = (
    <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>
        {client.name}
      </span>
      <span style={{ fontSize: 12, color: 'var(--theme-text3)', fontWeight: 400 }}>
        {client.location || 'No location'}
      </span>
      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--radius-full)',
        color: client.plan === 'pro' ? 'var(--theme-accent)' : client.plan === 'growth' ? 'var(--theme-green)' : 'var(--theme-text2)',
        background: client.plan === 'pro' ? 'rgba(201,168,76,0.12)' : client.plan === 'growth' ? 'rgba(52,211,153,0.10)' : 'rgba(138,146,163,0.10)',
        border: `1px solid ${client.plan === 'pro' ? 'rgba(201,168,76,0.25)' : client.plan === 'growth' ? 'rgba(52,211,153,0.20)' : 'rgba(138,146,163,0.25)'}`,
      }}>
        {client.plan === 'pro' ? 'Pro' : client.plan === 'growth' ? 'Growth' : 'Starter'}
      </span>
    </span>
  )

  // Was a fixed 520px right-hand drawer. Now a centered modal, which fixes the problem that
  // prompted the change: seven tabs could not fit 520px, so the tab row silently pushed
  // "⚠ Danger" — the destructive one — off the end where nobody could see it. Reusing the
  // shared Modal also brings Escape-to-close, a Tab focus trap, focus restoration and dialog
  // ARIA, none of which the hand-rolled drawer had.
  return (
    <Modal onClose={onClose} title={modalTitle} maxWidth={880}>
      {/* Tabs. The negative margins pull the row out to the card's edges so the underline and
          the divider run the full width, rather than stopping short at the 24px padding. */}
      <div
        role="tablist"
        aria-label="Client management sections"
        onKeyDown={onTabKeyDown}
        style={{
          display: 'flex', flexWrap: 'wrap', gap: 2,
          margin: '-6px -24px 0', padding: '0 18px',
          borderBottom: '1px solid var(--theme-border)',
        }}
      >
        {tabs.map(t => {
          const active = activeTab === t.key
          const danger = t.key === 'danger'
          return (
            <button
              key={t.key}
              id={fid(`tab-${t.key}`)}
              role="tab"
              type="button"
              aria-selected={active}
              aria-controls={fid('tabpanel')}
              // Roving tabindex: the row is one stop in the page's tab order and the arrow keys
              // move within it, which is what a tablist is expected to do. Without it, reaching
              // the Danger tab by keyboard meant eight Tab presses through the other seven.
              tabIndex={active ? 0 : -1}
              className={
                'panel-tab' +
                (active ? ' panel-tab--active' : '') +
                (danger ? ' panel-tab--danger' : '')
              }
              onClick={() => selectTab(t.key)}
            >{t.label}</button>
          )
        })}
      </div>

      {/* Body scrolls inside the panel rather than the whole page, so the header and tabs stay
          put on the long tabs (Billing, Settings). */}
      <div
        id={fid('tabpanel')}
        role="tabpanel"
        aria-labelledby={fid(`tab-${activeTab}`)}
        tabIndex={-1}
        style={{
          margin: '0 -24px -24px', padding: '20px 24px',
          maxHeight: 'min(64vh, 680px)', overflowY: 'auto',
        }}
      >

          {/* ── USERS TAB ── */}
          {activeTab === 'users' && (
            <div>
              {/* Edit client details */}
              <div style={{ marginBottom: 24 }}>
                <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>
                  Client Details
                </p>
                <div style={{ ...FIELD_GRID, marginBottom: 12 }}>
                  <div className="form-field">
                    <label htmlFor={fid('client-name')}>Property Name *</label>
                    <input id={fid('client-name')} value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} />
                  </div>
                  <div className="form-field">
                    <label htmlFor={fid('client-location')}><Tip text="City or area where this property operates. Shown on reports and helps identify multi-location clients.">Location</Tip></label>
                    <input id={fid('client-location')} value={editForm.location} onChange={e => setEditForm({ ...editForm, location: e.target.value })} />
                  </div>
                  <div className="form-field">
                    <label htmlFor={fid('client-contact')}><Tip text="Primary contact — owner or manager name used for billing and support correspondence.">Contact Person</Tip></label>
                    <input id={fid('client-contact')} value={editForm.contact_person} onChange={e => setEditForm({ ...editForm, contact_person: e.target.value })} />
                  </div>
                  <div className="form-field">
                    <label htmlFor={fid('client-phone')}>Phone</label>
                    <input id={fid('client-phone')} value={editForm.contact_phone} onChange={e => setEditForm({ ...editForm, contact_phone: e.target.value })} />
                  </div>
                </div>
                {clientMsg && (
                  <p role={clientMsg.startsWith('ok:') ? 'status' : 'alert'}
                    style={{ fontSize: 12, margin: '0 0 8px', color: clientMsg.startsWith('ok:') ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                    {clientMsg.replace(/^(ok|error):/, '')}
                  </p>
                )}
                <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={saveClientEdit} disabled={savingClient}>
                  {savingClient ? 'Saving…' : 'Update Details'}
                </button>
              </div>

              <div style={{ borderTop: '1px solid var(--theme-border)', paddingTop: 20, marginBottom: 20 }}>
                <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>
                  Add New User
                </p>
                <div style={{ ...FIELD_GRID, marginBottom: 12 }}>
                  <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                    <label htmlFor={fid('new-name')}>Full Name</label>
                    <input
                      id={fid('new-name')}
                      value={userForm.full_name}
                      onChange={e => setUserForm({ ...userForm, full_name: e.target.value })}
                      placeholder="e.g. Ram Sharma"
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor={fid('new-email')}>Email *</label>
                    <input
                      id={fid('new-email')}
                      type="email"
                      autoComplete="off"
                      aria-describedby={fid('new-email-hint')}
                      value={userForm.email}
                      onChange={e => setUserForm({ ...userForm, email: e.target.value })}
                      placeholder="user@restaurant.com"
                    />
                    <span id={fid('new-email-hint')} style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 4, display: 'block' }}>
                      A login lives on one client at a time. If this email already has a client login, creating it here <strong>moves</strong> it to this client. To keep separate logins on the same inbox, add <code style={{ color: 'var(--theme-text3)' }}>+name</code> before the @ (e.g. you+casa@gmail.com).
                    </span>
                  </div>
                  <div className="form-field">
                    <label htmlFor={fid('new-password')}>Password *</label>
                    {/* Shown in the clear on purpose — the admin is reading this out to the client,
                        not typing their own secret. autoComplete="new-password" regardless, so
                        Chrome never offers a saved login for the field beside it. */}
                    <input
                      id={fid('new-password')}
                      type="text"
                      autoComplete="new-password"
                      value={userForm.password}
                      onChange={e => setUserForm({ ...userForm, password: e.target.value })}
                      placeholder={`Min. ${MIN_PASSWORD_LENGTH} characters`}
                    />
                  </div>
                </div>
                {userError   && <p role="alert" style={{ color: 'var(--theme-red)', fontSize: 12, margin: '0 0 8px' }}>{userError}</p>}
                {userSuccess && <p role="status" style={{ color: 'var(--theme-green)', fontSize: 12, margin: '0 0 8px' }}>{userSuccess}</p>}
                <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={createUser} disabled={savingUser}>
                  {savingUser ? 'Creating…' : '+ Create User'}
                </button>
              </div>

              {/* Existing users */}
              <div style={{ borderTop: '1px solid var(--theme-border)', paddingTop: 20 }}>
                <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>
                  Existing Users {loadingUsers ? '— Loading…' : `(${users.length})`}
                </p>
                {!loadingUsers && users.length === 0 && (
                  <p style={{ fontSize: 13, color: 'var(--theme-text3)' }}>No users yet for this client.</p>
                )}
                {!loadingUsers && users.map(u => (
                  <div key={u.id} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '10px 0', borderBottom: '1px solid var(--theme-border)'
                  }}>
                    <div>
                      <span style={{ fontSize: 13, color: 'var(--theme-text1)', fontWeight: 600 }}>{u.full_name || '—'}</span>
                      <span style={{ fontSize: 12, color: 'var(--theme-text2)', marginLeft: 8 }}>{u.email}</span>
                      <span style={{ fontSize: 11, color: 'var(--theme-accent)', marginLeft: 8, background: 'rgba(201,168,76,0.1)', padding: '2px 8px', borderRadius: 'var(--radius-sm)' }}>
                        {u.role}
                      </span>
                    </div>
                    <button
                      className="btn btn-danger btn-sm"
                      style={{ fontSize: 11, padding: '6px 12px' }}
                      onClick={() => deleteUser(u)}
                      aria-label={`Delete ${u.full_name || u.email}`}
                    >Delete</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── STAFF PINS TAB ── */}
          {activeTab === 'pins' && (
            <div>
              <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>
                Staff PINs
              </p>
              <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 16px', lineHeight: 1.5 }}>
                POS and Self-Service PINs for this client. Revealing a PIN is recorded in the Audit Log
                with your name. For a staff member who has simply forgotten theirs, the client&apos;s own
                manager can already set a new one from POS Staff → Reset PIN — this is here for recovery,
                not day-to-day support.
              </p>

              {pinErr && (
                <p role="alert" style={{ fontSize: 12, color: 'var(--theme-red)', margin: '0 0 12px' }}>{pinErr}</p>
              )}

              {loadingPins ? (
                <p style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Loading…</p>
              ) : pinAccounts.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                  This client has no POS or Self-Service PIN accounts.
                </p>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Type</th>
                        <th>PIN</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {pinAccounts.map(a => (
                        <tr key={a.id}>
                          <td>{a.full_name || '—'}</td>
                          <td><span className="badge-yellow">{a.kind}</span></td>
                          <td style={{ fontFamily: 'monospace', fontSize: 14, letterSpacing: '0.12em' }}>
                            {revealedPins[a.id] ? revealedPins[a.id] : '••••'}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {a.storedAt ? (
                              <button
                                className="btn btn-ghost"
                                style={{ fontSize: 11 }}
                                onClick={() => revealPin(a.id)}
                                disabled={revealingId === a.id || !!revealedPins[a.id]}
                              >
                                {revealingId === a.id ? 'Revealing…' : revealedPins[a.id] ? 'Hides in 30s' : 'Reveal'}
                              </button>
                            ) : (
                              <Tip text="This account predates the PIN vault, or has not been reset or signed in since. Its PIN was never observed, so there is nothing stored to reveal — reset it to make it recoverable.">
                                <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>Not stored</span>
                              </Tip>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── BILLING TAB ── */}
          {activeTab === 'billing' && (() => {
            return (
              <div>
                {/* ── Modules ── */}
                <div style={{ marginBottom: 24 }}>
                  <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>
                    Modules
                  </p>
                  {suitePlan && (
                    <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '0 0 12px' }}>
                      Locked while a Suite Bundle is active — all three modules are included. Set Suite Bundle to "Not Subscribed" below to toggle these individually again.
                    </p>
                  )}
                  {[
                    { key: 'ims', label: 'Crest IMS', sub: 'Inventory Management', enabled: imsEnabled, toggle: handleToggleIms },
                    { key: 'hr',  label: 'Crest HR',  sub: 'Human Resources',      enabled: hrEnabled,  toggle: handleToggleHr  },
                    { key: 'pos', label: 'Crest POS', sub: 'Point of Sale',        enabled: posEnabled, toggle: handleTogglePos  },
                  ].map(mod => (
                    <div key={mod.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--theme-border-lt)', opacity: suitePlan ? 0.6 : 1 }}>
                      <div>
                        <p style={{ margin: '0 0 1px', fontSize: 13, fontWeight: 700, color: mod.enabled ? 'var(--theme-text1)' : 'var(--theme-text3)' }}>{mod.label}</p>
                        <p style={{ margin: 0, fontSize: 11, color: 'var(--theme-text2)' }}>{mod.sub}</p>
                      </div>
                      {/* A real button with switch semantics. This was a bare <div onClick>: not
                          focusable, no role, no state exposed — three unreachable-by-keyboard
                          switches that turn paid modules on and off with an immediate DB write.
                          The off-state track was also a hardcoded #374151, a dark slab on the five
                          light presets. */}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={mod.enabled}
                        aria-label={`${mod.label} enabled`}
                        onClick={mod.toggle}
                        disabled={!!suitePlan}
                        style={{
                          position: 'relative', width: 38, height: 22, padding: 0,
                          borderRadius: 'var(--radius-full)', flexShrink: 0,
                          cursor: suitePlan ? 'not-allowed' : 'pointer',
                          background: mod.enabled ? 'var(--theme-accent)' : 'var(--theme-input-bg)',
                          border: `1px solid ${mod.enabled ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                          transition: 'background var(--motion-fast) var(--ease-standard)',
                        }}
                      >
                        <span style={{
                          position: 'absolute', top: 2, left: mod.enabled ? 18 : 2,
                          width: 16, height: 16, borderRadius: 'var(--radius-full)',
                          background: mod.enabled ? 'var(--theme-accent-text)' : 'var(--theme-text3)',
                          transition: 'left var(--motion-fast) var(--ease-standard)',
                        }} />
                      </button>
                    </div>
                  ))}
                </div>

                {/* Suite Bundle — a bundle-tier subscription (IMS+HR+POS together) that unlocks
                    cross-module features like Owner Dashboard. Null = not subscribed. Picking a
                    tier also enables all three modules and syncs their plan to match (see
                    handleSuitePlanPick) — it's billed and priced as one bundle, not summed from
                    three independently-set module plans. */}
                <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 8px' }}>
                  <Tip text="A bundle-tier subscription (IMS+HR+POS together) that unlocks cross-module features like Owner Dashboard. Picking a tier enables all three modules below and syncs their plan to match — it's billed as one bundle, not three separate module plans." width={300}>
                    Suite Bundle
                  </Tip>
                </p>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  {[{ key: null, label: 'Not Subscribed' }, ...SUITE_BUNDLES].map(opt => {
                    const active = suitePlan === opt.key
                    return (
                      <button key={opt.key ?? 'none'} type="button" aria-pressed={active} onClick={() => handleSuitePlanPick(opt.key)} style={{
                        padding: '8px 14px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 700, lineHeight: 1.4,
                        border: active ? '1px solid var(--theme-accent)' : '1px solid var(--theme-border)',
                        background: active ? 'rgba(201,168,76,0.1)' : 'none',
                        color: active ? 'var(--theme-accent)' : 'var(--theme-text3)',
                      }}>
                        <div>{opt.label}</div>
                        {opt.monthly != null && (
                          <div style={{ fontSize: 10, fontWeight: 400, marginTop: 2, opacity: 0.85 }}>
                            NPR {(billingCycle === 'annual' ? opt.annual : opt.monthly).toLocaleString('en-NP')}/mo
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>
                {/* Was color:'#fff' — every light preset has card:#ffffff, so this line was white
                    on white and literally invisible on five of the ten themes. */}
                <p style={{ fontSize: 11, color: 'var(--theme-text2)', margin: '0 0 24px' }}>
                  Selecting a bundle disables individual module pricing below.
                </p>

                {/* Suite Bundle expiry — its own renewal schedule, independent of any single
                    module's end date (borrowing IMS's date as a proxy elsewhere is a fallback
                    for pre-migration clients only, not a substitute for tracking this directly). */}
                {suitePlan && (() => {
                  const s = getDateStatus(suiteEndsAt)
                  return (
                    <div style={{ marginBottom: 24, paddingBottom: 24, borderBottom: '1px solid var(--theme-border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                        <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: 'var(--theme-accent)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Suite Bundle</p>
                        {s.label && (
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 'var(--radius-sm)', color: s.color, background: s.bg, border: `1px solid ${s.border}` }}>
                            {s.label}
                          </span>
                        )}
                      </div>
                      <p style={{ fontSize: 11, color: 'var(--theme-text2)', margin: '0 0 6px' }}>
                        <Tip text="Date when this client's Suite Bundle subscription expires — independent of each module's own expiry above. Gates Owner Dashboard access alongside the tier picked above." width={300}>Suite subscription end date</Tip>
                      </p>
                      <div style={{ marginBottom: 8 }}>
                        <BsCalendarPicker value={suiteEndsAt} onChange={setSuiteEndsAt} clearable />
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {[{ label: '+7 Days', days: 7 }, { label: '+1 Month', days: 30 }, { label: '+3 Months', days: 90 }, { label: '+1 Year', days: 365 }].map(({ label, days }) => (
                          <button key={label} className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => extendModule(setSuiteEndsAt, days)}>{label}</button>
                        ))}
                        {suiteEndsAt && (
                          <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.25)', marginLeft: 'auto' }} onClick={() => setSuiteEndsAt('')}>Clear</button>
                        )}
                      </div>
                    </div>
                  )
                })()}

                {/* Billing cycle toggle */}
                <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 8px' }}>
                  <Tip text="Whether this client pays monthly or annually. Annual plans discount the monthly rate by 25%.">Billing Cycle</Tip>
                </p>
                {/* Segmented control. Two fixes here: the selected "Annual" tab hardcoded #000 on
                    var(--theme-accent) — 3.85:1 on Latte's violet accent, below AA, and the exact
                    bug --theme-accent-text exists to prevent — and it carried an invented
                    box-shadow, which DESIGN.md reserves for floating and live-status elements
                    rather than as a "this one is selected" cue. The border does that job. */}
                <div role="group" aria-label="Billing cycle"
                  style={{ display: 'flex', gap: 4, marginBottom: 24, background: 'var(--theme-bg)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--theme-border)', padding: 4, width: 'fit-content' }}>
                  {[{ key: 'monthly', label: 'Monthly' }, { key: 'annual', label: 'Annual · Save 25%' }].map(opt => {
                    const on = billingCycle === opt.key
                    return (
                      <button key={opt.key} type="button" aria-pressed={on} onClick={() => setBillingCycle(opt.key)} style={{
                        padding: '6px 16px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                        border: `1px solid ${on ? 'var(--theme-accent)' : 'transparent'}`,
                        background: on ? 'var(--theme-focus-ring)' : 'transparent',
                        color: on ? 'var(--theme-accent)' : 'var(--theme-text3)',
                        transition: 'background var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard)',
                      }}>{opt.label}</button>
                    )
                  })}
                </div>

                {/* Per-module subscription sections */}
                {[
                  { key: 'ims', label: 'Crest IMS', enabled: imsEnabled, plan: currentPlan, setPlan: setCurrentPlan, endsAt: imsEndsAt, setEndsAt: setImsEndsAt },
                  { key: 'hr',  label: 'Crest HR',  enabled: hrEnabled,  plan: hrPlan,      setPlan: setHrPlan,      endsAt: hrEndsAt,  setEndsAt: setHrEndsAt  },
                  { key: 'pos', label: 'Crest POS', enabled: posEnabled, plan: posPlan,     setPlan: setPosPlan,     endsAt: posEndsAt, setEndsAt: setPosEndsAt },
                ].map(mod => {
                  if (!mod.enabled) return null
                  const s = getDateStatus(mod.endsAt)
                  const flatPricing = mod.key === 'hr' ? HR_PRICING : mod.key === 'pos' ? POS_PRICING : null
                  const accentBase = MODULE_COLORS[mod.key]
                  // Suite Bundle replaces per-module pricing/dates entirely in clientMRR (it's a
                  // single discounted subscription, not an add-on) — disable these sections while
                  // it's selected so admins aren't led to believe editing them changes billing.
                  const lockedBySuite = !!suitePlan
                  return (
                    <div key={mod.key} style={{ marginBottom: 24, paddingBottom: 24, borderBottom: '1px solid var(--theme-border)', opacity: lockedBySuite ? 0.45 : 1, pointerEvents: lockedBySuite ? 'none' : 'auto' }}>
                      {/* Header */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                        <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: accentBase, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{mod.label}</p>
                        {lockedBySuite ? (
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 'var(--radius-sm)', color: 'var(--theme-text3)', background: 'var(--theme-bg)', border: '1px solid var(--theme-border)' }}>
                            Controlled by Suite Bundle
                          </span>
                        ) : s.label && (
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 'var(--radius-sm)', color: s.color, background: s.bg, border: `1px solid ${s.border}` }}>
                            {s.label}
                          </span>
                        )}
                      </div>
                      {flatPricing ? (
                        /* HR/POS — flat single price, no tier picker (hr_plan/pos_plan aren't wired to any feature gating) */
                        <div style={{ padding: '10px 12px', borderRadius: 'var(--radius-md)', border: `1px solid ${accentBase}40`, background: `${accentBase}12`, marginBottom: 12 }}>
                          <div style={{ fontSize: 15, fontWeight: 700, color: accentBase }}>
                            NPR {(billingCycle === 'annual' ? flatPricing.annual : flatPricing.monthly).toLocaleString('en-NP')}/mo
                          </div>
                          {billingCycle === 'annual' && (
                            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 2 }}>
                              NPR {flatPricing.annual.toLocaleString('en-NP')}/mo × 12 = NPR {(flatPricing.annual * 12).toLocaleString('en-NP')}/yr
                            </div>
                          )}
                        </div>
                      ) : (
                        <>
                          {/* Plan cards — IMS only, real tiers */}
                          <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                            {IMS_TIERS.map(p => {
                              const price = billingCycle === 'annual' ? p.annual : p.monthly
                              const active = mod.plan === p.key
                              const accentColor = MODULE_COLORS.ims
                              return (
                                <button key={p.key} type="button" aria-pressed={active} disabled={lockedBySuite} onClick={() => mod.setPlan(p.key)} style={{
                                  flex: '1 1 120px', padding: '8px 6px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 700, lineHeight: 1.4,
                                  border: active ? `1px solid ${accentColor}` : '1px solid var(--theme-border)',
                                  background: active ? `${accentColor}1a` : 'none',
                                  color: active ? accentColor : 'var(--theme-text3)',
                                }}>
                                  <div>{p.label}</div>
                                  <div style={{ fontSize: 10, fontWeight: 400, marginTop: 2, opacity: 0.85 }}>NPR {price.toLocaleString('en-NP')}/mo</div>
                                </button>
                              )
                            })}
                          </div>
                          <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '0 0 12px' }}>
                            {(() => {
                              const tier = IMS_TIERS.find(p => p.key === mod.plan) || IMS_TIERS[0]
                              return billingCycle === 'annual'
                                ? `Annual · NPR ${tier.annual.toLocaleString('en-NP')}/mo × 12 = NPR ${(tier.annual * 12).toLocaleString('en-NP')}/yr`
                                : `Monthly · NPR ${tier.monthly.toLocaleString('en-NP')}/mo`
                            })()}
                          </p>
                        </>
                      )}
                      {/* Date picker */}
                      <p style={{ fontSize: 11, color: 'var(--theme-text2)', margin: '0 0 6px' }}>
                        <Tip text="Date when this module's subscription expires. Client sees a warning in the last 7 days and is blocked after expiry." width={300}>Subscription end date</Tip>
                      </p>
                      <div style={{ marginBottom: 8 }}>
                        <BsCalendarPicker value={mod.endsAt} onChange={mod.setEndsAt} clearable disabled={lockedBySuite} />
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {[{ label: '+7 Days', days: 7 }, { label: '+1 Month', days: 30 }, { label: '+3 Months', days: 90 }, { label: '+1 Year', days: 365 }].map(({ label, days }) => (
                          <button key={label} className="btn btn-ghost" style={{ fontSize: 11 }} disabled={lockedBySuite} onClick={() => extendModule(mod.setEndsAt, days)}>{label}</button>
                        ))}
                        {mod.endsAt && (
                          <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.25)', marginLeft: 'auto' }} disabled={lockedBySuite} onClick={() => mod.setEndsAt('')}>Clear</button>
                        )}
                      </div>
                    </div>
                  )
                })}

                {subMsg && (
                  <p role={subMsg.startsWith('ok:') ? 'status' : 'alert'}
                    style={{ fontSize: 12, margin: '0 0 12px', color: subMsg.startsWith('ok:') ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                    {subMsg.replace(/^(ok|error):/, '')}
                  </p>
                )}
                <button className="btn btn-primary" style={{ fontSize: 13 }} onClick={handleSaveSub} disabled={savingSub}>
                  {savingSub ? 'Saving…' : 'Save Subscription'}
                </button>
              </div>
            )
          })()}

          {/* ── SETTINGS TAB ── */}
          {activeTab === 'settings' && (
            <div>
              {loadingSettings ? (
                <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
              ) : (
                <>
                  <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 16px' }}>
                    Branding
                  </p>

                  {/* Logo */}
                  <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
                    <div style={{ width: 64, height: 64, borderRadius: 'var(--radius-lg)', border: '1px solid var(--theme-border)', background: 'var(--theme-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {clientSettings.logo_url
                        ? <img src={clientSettings.logo_url} alt={`${client.name} logo`} style={{ width: 56, height: 56, objectFit: 'contain', borderRadius: 'var(--radius-md)' }} />
                        : <span aria-hidden="true" style={{ fontSize: 26, color: 'var(--theme-accent)' }}>⬢</span>
                      }
                    </div>
                    <div style={{ flex: 1 }}>
                      <p id={fid('logo-hint')} style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 8px' }}>Logo — square PNG/JPG/SVG, max 2MB</p>
                      <div style={{ display: 'flex', gap: 8 }}>
                        {/* The file input was display:none behind a <span> carrying
                            pointerEvents:'none' — display:none takes an element out of the tab
                            order, so there was no keyboard path to this control at all. It is now
                            a real button that forwards the click to a hidden-but-focusable input. */}
                        <input
                          ref={logoInputRef}
                          id={fid('logo-file')}
                          type="file"
                          accept="image/png,image/jpeg,image/svg+xml,image/webp"
                          className="visually-hidden"
                          tabIndex={-1}
                          disabled={logoUploading}
                          onChange={e => { if (e.target.files[0]) handleLogoUpload(e.target.files[0]); e.target.value = '' }}
                        />
                        <button
                          type="button"
                          className="btn btn-ghost"
                          style={{ fontSize: 11 }}
                          disabled={logoUploading}
                          aria-describedby={fid('logo-hint')}
                          onClick={() => logoInputRef.current?.click()}
                        >
                          {logoUploading ? 'Uploading…' : '↑ Upload Logo'}
                        </button>
                        {clientSettings.logo_url && (
                          <button type="button" className="btn btn-danger" style={{ fontSize: 11 }} onClick={handleLogoRemove}>
                            Remove
                          </button>
                        )}
                      </div>
                      {logoMsg && <p role={logoMsg.startsWith('ok') ? 'status' : 'alert'} style={{ fontSize: 11, margin: '6px 0 0', color: logoMsg.startsWith('error') ? 'var(--theme-red)' : 'var(--theme-green)' }}>{logoMsg.replace(/^(ok|error):/, '')}</p>}
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginBottom: 20 }}>
                    <div className="form-field">
                      <label htmlFor={fid('s-app-name')}>Property Name</label>
                      <input id={fid('s-app-name')} value={clientSettings.app_name || ''} onChange={e => setClientSettings({ ...clientSettings, app_name: e.target.value })} placeholder="e.g. Casa Acai Cafe" />
                    </div>
                    <div className="form-field">
                      <label htmlFor={fid('s-tagline')}>Tagline</label>
                      <input id={fid('s-tagline')} value={clientSettings.app_tagline || ''} onChange={e => setClientSettings({ ...clientSettings, app_tagline: e.target.value })} placeholder="e.g. Fresh bowls, made daily." />
                    </div>
                    <div className="form-field">
                      <label htmlFor={fid('s-vat')}><Tip text="Client's VAT registration number, printed on invoices and used for IRD compliance reporting.">VAT Number</Tip></label>
                      <input id={fid('s-vat')} value={clientSettings.vat_number || ''} onChange={e => setClientSettings({ ...clientSettings, vat_number: e.target.value })} />
                    </div>
                    <div className="form-field">
                      <label htmlFor={fid('s-vatreg')}><Tip text="On = POS bills print as a Tax Invoice with VAT breakdown (invoice numbers prefixed TI-). Off = plain Bill, no VAT line, PAN number only (prefixed PB-). Matches whether this client is actually VAT-registered with IRD.">VAT Registered</Tip></label>
                      <label htmlFor={fid('s-vatreg')} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', height: 34 }}>
                        <input id={fid('s-vatreg')} type="checkbox" checked={clientSettings.is_vat_registered ?? true}
                          onChange={e => setClientSettings({ ...clientSettings, is_vat_registered: e.target.checked })}
                          style={{ width: 16, height: 16, padding: 0, margin: 0, flexShrink: 0, background: 'none', border: 'none', accentColor: 'var(--theme-accent)', cursor: 'pointer' }} />
                        <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{(clientSettings.is_vat_registered ?? true) ? 'Yes — issues Tax Invoices' : 'No — PAN Bill only'}</span>
                      </label>
                    </div>
                    <div className="form-field">
                      <label htmlFor={fid('s-prefix')}><Tip text="Short client code used in POS invoice numbers, e.g. TI2238-CAC-82/83. Auto-suggested from the property name; edit if you want something different.">Invoice Prefix</Tip></label>
                      <input id={fid('s-prefix')} value={clientSettings.invoice_prefix || ''} onChange={e => setClientSettings({ ...clientSettings, invoice_prefix: e.target.value.toUpperCase() })} placeholder="e.g. CAC" />
                    </div>
                  </div>

                  <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 16px', borderTop: '1px solid var(--theme-border)', paddingTop: 16 }}>
                    Property Details
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginBottom: 20 }}>
                    <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                      <label htmlFor={fid('s-address')}>Address</label>
                      <input id={fid('s-address')} value={clientSettings.property_address || ''} onChange={e => setClientSettings({ ...clientSettings, property_address: e.target.value })} />
                    </div>
                    <div className="form-field">
                      <label htmlFor={fid('s-phone')}>Phone</label>
                      <input id={fid('s-phone')} value={clientSettings.property_phone || ''} onChange={e => setClientSettings({ ...clientSettings, property_phone: e.target.value })} />
                    </div>
                    <div className="form-field">
                      <label htmlFor={fid('s-email')}>Email</label>
                      <input id={fid('s-email')} value={clientSettings.property_email || ''} onChange={e => setClientSettings({ ...clientSettings, property_email: e.target.value })} />
                    </div>
                  </div>

                  <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 16px', borderTop: '1px solid var(--theme-border)', paddingTop: 16 }}>
                    Upgrade Contact
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginBottom: 24 }}>
                    <div className="form-field">
                      <label htmlFor={fid('s-cphone')}>Contact Phone</label>
                      <input id={fid('s-cphone')} value={clientSettings.contact_phone || ''} onChange={e => setClientSettings({ ...clientSettings, contact_phone: e.target.value })} />
                    </div>
                    <div className="form-field">
                      <label htmlFor={fid('s-cemail')}>Contact Email</label>
                      <input id={fid('s-cemail')} value={clientSettings.contact_email || ''} onChange={e => setClientSettings({ ...clientSettings, contact_email: e.target.value })} />
                    </div>
                    <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                      <label htmlFor={fid('s-web')}>Website</label>
                      <input id={fid('s-web')} value={clientSettings.contact_website || ''} onChange={e => setClientSettings({ ...clientSettings, contact_website: e.target.value })} />
                    </div>
                  </div>

                  {settingsMsg && (
                    <p role={settingsMsg.startsWith('ok:') ? 'status' : 'alert'}
                      style={{ fontSize: 12, margin: '0 0 12px', color: settingsMsg.startsWith('ok:') ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                      {settingsMsg.replace(/^(ok|error):/, '')}
                    </p>
                  )}
                  <button className="btn btn-primary" style={{ fontSize: 13 }} onClick={() => handleSaveSettings('Settings')} disabled={savingSettings}>
                    {savingSettings ? 'Saving…' : 'Save Settings'}
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── THRESHOLDS TAB ── */}
          {activeTab === 'thresholds' && (
            <div>
              {loadingSettings ? (
                <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
              ) : (
                <>
                  <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px' }}>
                    Food Cost Thresholds
                  </p>
                  <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 16px', lineHeight: 1.5 }}>
                    Controls the warning/critical colouring on the Dashboard Food Cost % KPI card and reports.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginBottom: 24 }}>
                    <div className="form-field">
                      <label htmlFor={fid('t-fcwarn')}><Tip text="When a recipe's food cost percentage exceeds this, the FC badge turns yellow in Recipe Costing and reports." width={280}>FC Warning % (yellow)</Tip></label>
                      <input id={fid('t-fcwarn')} type="number" value={clientSettings.fc_warning_pct || 35} onChange={e => setClientSettings({ ...clientSettings, fc_warning_pct: parseFloat(e.target.value) })} />
                    </div>
                    <div className="form-field">
                      <label htmlFor={fid('t-fccrit')}><Tip text="When a recipe's food cost exceeds this, the badge turns red — the item is unprofitable at its current selling price." width={280}>FC Critical % (red)</Tip></label>
                      <input id={fid('t-fccrit')} type="number" value={clientSettings.fc_critical_pct || 45} onChange={e => setClientSettings({ ...clientSettings, fc_critical_pct: parseFloat(e.target.value) })} />
                    </div>
                  </div>

                  <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px', borderTop: '1px solid var(--theme-border)', paddingTop: 16 }}>
                    Alerts
                  </p>
                  <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 16px', lineHeight: 1.5 }}>
                    Controls when items are flagged in the Expiry and Variance reports.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginBottom: 24 }}>
                    <div className="form-field">
                      <label htmlFor={fid('t-expiry')}><Tip text="Items expiring within this many days are flagged amber in the Expiry Tracker.">Expiry Warning (days)</Tip></label>
                      <input id={fid('t-expiry')} type="number" value={clientSettings.expiry_warning_days || 7} onChange={e => setClientSettings({ ...clientSettings, expiry_warning_days: parseInt(e.target.value) })} />
                    </div>
                    <div className="form-field">
                      <label htmlFor={fid('t-variance')}><Tip text="Variance Report highlights items where actual vs. theoretical consumption differs by more than this percentage." width={280}>Variance Flag %</Tip></label>
                      <input id={fid('t-variance')} type="number" value={clientSettings.variance_flag_pct || 10} onChange={e => setClientSettings({ ...clientSettings, variance_flag_pct: parseFloat(e.target.value) })} />
                    </div>
                  </div>

                  {settingsMsg && (
                    <p role={settingsMsg.startsWith('ok:') ? 'status' : 'alert'}
                      style={{ fontSize: 12, margin: '0 0 12px', color: settingsMsg.startsWith('ok:') ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                      {settingsMsg.replace(/^(ok|error):/, '')}
                    </p>
                  )}
                  <button className="btn btn-primary" style={{ fontSize: 13 }} onClick={() => handleSaveSettings('Thresholds')} disabled={savingSettings}>
                    {savingSettings ? 'Saving…' : 'Save Thresholds'}
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── QR TAB ── */}
          {activeTab === 'qr' && (
            <div>
              {loadingSettings ? (
                <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
              ) : (
                <>
                  <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px' }}>
                    Payment QR
                  </p>
                  <label htmlFor={fid('qr-payload')} style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text3)', display: 'block', marginBottom: 6 }}>
                    <Tip text="Paste the raw text from this business's payment QR (FonePay / NepalPay / eSewa merchant QR). Scan the counter standee with any QR-reader app — it yields a long text string starting with 000201 — and paste it here. POS bills will then show a per-bill dynamic QR with the exact amount pre-filled, so customers can't mistype it." width={320}>
                      Payment QR (merchant payload)
                    </Tip>
                  </label>
                  <textarea
                    id={fid('qr-payload')}
                    aria-describedby={qrPayload.trim() ? fid('qr-status') : undefined}
                    value={clientSettings.payment_qr_data || ''}
                    onChange={e => setClientSettings({ ...clientSettings, payment_qr_data: e.target.value })}
                    placeholder="e.g. 00020101021129370016...6304ABCD — scan the standee QR with a QR-reader app and paste the text here"
                    rows={3}
                    style={{ width: '100%', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-md)', padding: '8px 12px', fontSize: 12, fontFamily: 'monospace', color: 'var(--theme-text1)', outline: 'none', resize: 'vertical' }}
                  />
                  {(clientSettings.payment_qr_data || '').trim() && (
                    qrCheck.ok ? (
                      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginTop: 10 }}>
                        {qrPreview && <img src={qrPreview} alt={`Payment QR code for ${qrCheck.merchantName || client.name} — scan to verify`} style={{ width: 120, height: 120, /* literal white, not a token: a QR needs a light quiet zone to scan */ borderRadius: 'var(--radius-md)', background: '#fff', padding: 4 }} />}
                        <div>
                          <p id={fid('qr-status')} role="status" style={{ fontSize: 12, color: 'var(--theme-green)', margin: '0 0 4px', fontWeight: 600 }}>✓ Valid payment QR — merchant: {qrCheck.merchantName}</p>
                          <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: 0, maxWidth: 420, lineHeight: 1.6 }}>
                            Scan this preview with a banking app to test it before saving. Once saved, every POS bill shows a dynamic
                            version of this QR with that bill's exact amount pre-filled.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <p id={fid('qr-status')} role="alert" style={{ fontSize: 12, color: 'var(--theme-red)', margin: '8px 0 0' }}>✗ {qrCheck.error}</p>
                    )
                  )}

                  <button className="btn btn-primary" style={{ fontSize: 13, marginTop: 16 }} onClick={() => handleSaveSettings('Payment QR')} disabled={savingSettings}>
                    {savingSettings ? 'Saving…' : 'Save QR'}
                  </button>

                  <hr style={{ border: 'none', borderTop: '1px solid var(--theme-border-lt)', margin: '20px 0' }} />

                  <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px' }}>
                    Payment Webhook <span style={{ textTransform: 'none', letterSpacing: 0 }}>(advanced)</span>
                  </p>
                  <label htmlFor={fid('qr-webhook')} style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text3)', display: 'block', marginBottom: 6 }}>
                    <Tip text="Verifies incoming calls to the pos-payment-webhook Edge Function so a QR payment can auto-confirm without staff tapping Pay. Only matters once a real FonePay/eSewa merchant webhook is onboarded and configured to sign its calls with this secret — until then it just sits here unused. Leave blank if this client has no such integration yet." width={340}>
                      Webhook Secret
                    </Tip>
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      id={fid('qr-webhook')}
                      type="text"
                      autoComplete="off"
                      value={webhookSecret}
                      onChange={e => setWebhookSecret(e.target.value)}
                      placeholder="blank = auto-confirmation disabled for this client"
                      style={{ flex: 1, background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-md)', padding: '8px 12px', fontSize: 12, fontFamily: 'monospace', color: 'var(--theme-text1)', outline: 'none' }}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                      onClick={() => setWebhookSecret(generateWebhookSecret())}
                    >
                      Generate
                    </button>
                  </div>

                  {settingsMsg && (
                    <p role={settingsMsg.startsWith('ok:') ? 'status' : 'alert'}
                      style={{ fontSize: 12, margin: '16px 0 12px', color: settingsMsg.startsWith('ok:') ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                      {settingsMsg.replace(/^(ok|error):/, '')}
                    </p>
                  )}
                  <button className="btn btn-primary" style={{ fontSize: 13, marginTop: settingsMsg ? 0 : 16 }} onClick={() => handleSaveSettings('Webhook secret')} disabled={savingSettings}>
                    {savingSettings ? 'Saving…' : 'Save Webhook Secret'}
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── DANGER ZONE TAB ── */}
          {activeTab === 'data' && (
            <div>
              <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 20px', lineHeight: 1.65 }}>
                Writes a complete copy of <strong style={{ color: 'var(--theme-text1)' }}>{client.name}</strong>'s data
                to a folder you choose — an <strong>.xlsx</strong> workbook to read, and a <strong>.json</strong> file
                that can be restored. Works for any client, on a live subscription or not.
              </p>

              {/* Backup folder */}
              <div style={{ padding: '12px 14px', marginBottom: 16, background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-lg)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text1)' }}>
                      <Tip text="Chosen once and remembered. Install Crest as a desktop app (Chrome/Edge → Install) and the write permission persists silently; in an ordinary tab you may be asked each session.">
                        Backup folder
                      </Tip>
                    </div>
                    <div style={{ fontSize: 11, color: backupState === 'granted' ? 'var(--theme-green)' : 'var(--theme-text3)', marginTop: 3 }}>
                      {!isFileSystemAccessSupported()
                        ? 'This browser cannot write to a folder — exports will download instead.'
                        : backupState === 'granted' ? '✓ Ready'
                        : backupState === 'none'    ? 'Not chosen yet — exports will download instead.'
                        : 'Chosen, but permission needs re-granting.'}
                    </div>
                  </div>
                  {isFileSystemAccessSupported() && (
                    <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={handleChooseFolder}>
                      {backupState === 'none' ? 'Choose folder…' : 'Change folder…'}
                    </button>
                  )}
                </div>
              </div>

              {/* Export */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
                <button className="btn btn-primary" style={{ fontSize: 13 }} onClick={() => handleExportNow('manual')} disabled={backupBusy}>
                  {backupBusy ? 'Exporting…' : 'Export Now'}
                </button>
                <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>
                  {backupProgress || (lastBackupAt ? `Last backup: ${formatAd(new Date(lastBackupAt))}` : 'Never backed up')}
                </span>
              </div>
              {backupMsg && (
                <p role={backupMsg.startsWith('ok:') ? 'status' : 'alert'}
                  style={{ fontSize: 12, margin: '8px 0 0', color: backupMsg.startsWith('ok:') ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                  {backupMsg.replace(/^(ok|error):/, '')}
                </p>
              )}
              {/* Progress is announced politely rather than only shown, since an export of a busy
                  client runs long enough that "did I actually press it" is a real question. */}
              <span role="status" aria-live="polite" className="visually-hidden">{backupProgress}</span>

              {/* Restore */}
              <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--theme-border)' }}>
                <label htmlFor={fid('restore-file')} style={{ display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--theme-text1)', marginBottom: 6 }}>
                  <Tip text="Only into an empty client. These are inserts, not merges — restoring over a client that still has data would duplicate every row.">
                    Restore from a .json backup
                  </Tip>
                </label>
                {/* This paragraph used to say staff logins are in no backup and cannot be exported.
                    That has not been true since the PIN vault shipped: staff_pin_vault is exported
                    as ciphertext, and a restore into a client with no logins rebuilds the PIN
                    accounts with their original PINs — which the success message below then reports.
                    An admin planning an Archive around the old sentence would have planned around a
                    constraint that no longer exists. */}
                <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '0 0 10px', lineHeight: 1.6 }}>
                  Restores business data, and — only when the client has no logins left — rebuilds POS and
                  Self-Service PIN accounts with their <strong style={{ color: 'var(--theme-text2)' }}>original PINs</strong>.
                  Password logins (IMS, HR and Owner) come back as a named list to recreate by hand, since their
                  login is a real email the backup deliberately does not carry. Attribution ("who did it") is
                  cleared on restore, though the names stay readable in the backup files themselves.
                </p>
                <input
                  id={fid('restore-file')}
                  type="file" accept=".json"
                  disabled={restoreBusy}
                  onChange={e => { handleRestoreFile(e.target.files?.[0]); e.target.value = '' }}
                  style={{ fontSize: 12, color: 'var(--theme-text2)' }}
                />
                {restoreMsg && (
                  <p role={restoreMsg.startsWith('error:') ? 'alert' : 'status'}
                    style={{ fontSize: 12, margin: '10px 0 0', color: restoreMsg.startsWith('ok:') ? 'var(--theme-green)' : restoreMsg.startsWith('info:') ? 'var(--theme-text2)' : 'var(--theme-red)' }}>
                    {restoreMsg.replace(/^(ok|error|info):/, '')}
                  </p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'danger' && (
            <div>
              {/* Pre-flight backup status — every action below takes a backup first. */}
              <div style={{
                padding: '12px 14px', marginBottom: 16,
                background: skipBackup ? 'rgba(248,113,113,0.06)' : 'rgba(52,211,153,0.06)',
                border: `1px solid ${skipBackup ? 'rgba(248,113,113,0.25)' : 'rgba(52,211,153,0.25)'}`,
                borderRadius: 'var(--radius-lg)',
              }}>
                <div style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
                  {skipBackup
                    ? <>⚠ <strong style={{ color: 'var(--theme-red)' }}>Backups are off.</strong> The actions below will run with no safety copy.</>
                    : <>🛡 A full backup is written <strong style={{ color: 'var(--theme-text1)' }}>before</strong> any action below runs. If it fails, nothing is deleted.</>}
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 9, fontSize: 11, color: 'var(--theme-text3)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={skipBackup} onChange={e => setSkipBackup(e.target.checked)} />
                  I have backed up elsewhere — proceed without a backup
                </label>
              </div>

              {/* Archive — presented above Delete because it is the right answer far more often. */}
              <div style={{
                padding: '14px 16px', marginBottom: 24,
                background: 'rgba(201,168,76,0.05)', border: '1px solid rgba(201,168,76,0.25)', borderRadius: 'var(--radius-lg)'
              }}>
                <p style={{ fontSize: 13, color: 'var(--theme-accent)', fontWeight: 700, margin: '0 0 6px' }}>Archive Client</p>
                <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 12px', lineHeight: 1.65 }}>
                  The recommended way to close out a client who has left. Takes a backup, clears their operational
                  data, and locks the account — but <strong style={{ color: 'var(--theme-text1)' }}>keeps their user
                  accounts, logins, settings and client record</strong>, so restoring the backup fully reverses it.
                </p>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 12, color: 'var(--theme-accent)', borderColor: 'rgba(201,168,76,0.35)' }}
                  onClick={handleArchiveClient}
                  disabled={deleting}
                >
                  {deletingAction === 'archive' ? 'Archiving…' : 'Archive Client'}
                </button>
              </div>

              <div style={{
                padding: '14px 16px', marginBottom: 24,
                background: 'rgba(248,113,113,0.04)', border: '1px solid rgba(248,113,113,0.15)', borderRadius: 'var(--radius-lg)'
              }}>
                <p style={{ fontSize: 13, color: 'var(--theme-red)', fontWeight: 700, margin: '0 0 6px' }}>⚠ Danger Zone</p>
                <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: 0, lineHeight: 1.65 }}>
                  Destructive actions for{' '}
                  <strong style={{ color: 'var(--theme-text1)' }}>{client.name}</strong>.{' '}
                  Per-module buttons clear only that module's transactions and keep its setup (items, employees, tables…).
                  "Clear Client Data" wipes all operational data across IMS, HR and POS; the client record, user accounts,
                  feature flags, and settings are kept intact.
                  <br /><strong style={{ color: 'var(--theme-red)' }}>None of these can be undone.</strong>
                </p>
              </div>

              {deleteMsg && (
                <p role={deleteMsg.startsWith('ok:') ? 'status' : 'alert'}
                  style={{ fontSize: 12, margin: '0 0 16px', color: deleteMsg.startsWith('ok:') ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                  {deleteMsg.replace(/^(ok|error):/, '')}
                </p>
              )}

              <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>
                Clear one module — transactions only, setup kept
              </p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
                <Tip text="Deletes IMS activity: purchases, stock counts, wastage, staff meals, sales, budgets, payables, POs, requisitions, overheads, stock movements, demand forecast runs. Keeps items, vendors, categories, recipes, par levels, and periods (periods are shared with HR payroll). Cannot be undone.">
                  <button onClick={() => handleClearModule('ims')} disabled={deleting}
                    className="btn btn-danger" style={{ fontSize: 13 }}>
                    {deletingAction === 'ims' ? 'Working…' : 'Clear IMS Transactions'}
                  </button>
                </Tip>
                <Tip text="Deletes HR activity: attendance, payroll runs, payslips, leave requests, overtime, advances + repayments, festival allowances, roster, TADA claims, incentive runs + configs, roster publish state, shift swap requests. Keeps employees, salary components, leave types, holiday calendar, and shift types. Cannot be undone.">
                  <button onClick={() => handleClearModule('hr')} disabled={deleting}
                    className="btn btn-danger" style={{ fontSize: 13 }}>
                    {deletingAction === 'hr' ? 'Working…' : 'Clear HR Transactions'}
                  </button>
                </Tip>
                <Tip text="Deletes POS activity: orders, order items, shifts, customers, credit notes, payment confirmations, guest order requests, POS-sourced sales entries, and the stock-movements ledger. Keeps tables, floor plan, and staff accounts/PINs; occupied tables are freed. Invoice numbering restarts. Cannot be undone.">
                  <button onClick={() => handleClearModule('pos')} disabled={deleting}
                    className="btn btn-danger" style={{ fontSize: 13 }}>
                    {deletingAction === 'pos' ? 'Working…' : 'Clear POS Transactions'}
                  </button>
                </Tip>
              </div>

              <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>
                Full client reset
              </p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <Tip text="Removes purchase unit conversions from all items (e.g. carton → pcs). Items and stock data are kept. Use this to reset unit setup without losing any transactions.">
                  <button
                    onClick={handleClearConversions}
                    disabled={deleting}
                    className="btn btn-danger" style={{ fontSize: 13 }}
                  >
                    {deletingAction === 'conversions' ? 'Working…' : 'Clear All Conversions'}
                  </button>
                </Tip>
                <Tip text="Permanently deletes ALL operational data across IMS, HR, and POS — master data and transactions. The client account, users, feature flags, and settings are kept. Cannot be undone.">
                  <button
                    onClick={handleDeleteClientData}
                    disabled={deleting}
                    className="btn btn-danger" style={{ fontSize: 13 }}
                  >
                    {deletingAction === 'clientData' ? 'Working…' : 'Clear Client Data'}
                  </button>
                </Tip>
                <Tip text="Permanently deletes everything: all operational data, user accounts, feature flags, settings, and the client record itself. The email is freed for re-registration. Cannot be undone.">
                  <button
                    onClick={handleDeleteClient}
                    disabled={deleting}
                    className="btn btn-danger btn-danger--strong" style={{ fontSize: 13 }}
                  >
                    {deletingAction === 'deleteClient' ? 'Working…' : 'Delete Client'}
                  </button>
                </Tip>
              </div>
            </div>
          )}

      </div>
    </Modal>
  )
}
