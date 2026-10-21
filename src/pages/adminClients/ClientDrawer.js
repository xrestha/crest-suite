import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { supabase } from '../../supabaseClient'
import { scopedFrom, scopedUpdate, scopedDelete } from '../../shared/scopedDb'
import { useAuth } from '../../context/AuthContext'
import { useSettings } from '../../context/SettingsContext'
import { formatAd, BS_MONTHS, bsDayOrdinal } from '../../utils/bsCalendar'
import BsCalendarPicker from '../../components/BsCalendarPicker'
import { getDateStatus, extendedFrom, suiteState } from '../../utils/subscription'
import { groupChangeCopy } from './groupChangeCopy'
import { validateEmvQr } from '../../utils/emvQr'
import Tip from '../../components/Tip'
import Modal from '../../components/Modal'
import ConfirmModal from '../../components/ConfirmModal'
import ActionError, { asActionError } from '../../components/ActionError'
import { MIN_PASSWORD_LENGTH } from '../../utils/weakPasswords'
import { adminOp } from '../../shared/adminOp'
import { useConfirm, CONFIRM_TIMEOUT_MS, CONFIRM_TIMEOUT_TEXT } from '../../shared/hooks/useConfirm'
// Colours only — the PRICES this panel quotes come from useSettings().pricing (S701), so the
// figure under each module button is the one Settings > Plan Pricing actually charges. It used
// to import the constants, which meant the screen where an operator picks a client's modules
// quoted the shipped price while the MRR line beside it used the admin's edited one.
import { MODULE_COLORS, MODULE_INK, moduleTint, suitePagesText } from '../../data/pricingPlans'
import ClientLegalTab from './ClientLegalTab'
import { runBackup } from '../../modules/admin/dataExport/runBackup'
import { restoreClientData } from '../../modules/admin/dataExport/restoreClientData'
import {
  pickBackupDirectory, ensureBackupDirectory, isFileSystemAccessSupported,
} from '../../modules/admin/dataExport/backupDirectory'
import { errorLine, errorInfo } from '../../shared/errorText'
import { loginOpFailure, loginWriteFailure, withDetail } from './loginOpError'
import { clearStopped, archiveLockFailed, loginsStopped, deleteStageFailed, dangerUnexpected, restoreStopped, KEEP_BACKUP } from './dangerZoneText'
import { nepalBsLong } from '../../shared/nepalTime'
import { settleWithin } from '../../utils/withTimeout'
import { andList } from '../../shared/offeredPicks'
import { findTillCoveredManualDays, recountManualSalesDays, SAVE_TIMEOUT_MS } from '../../modules/ims/sales/persistSalesDay'

const EMPTY_USER = { email: '', password: '', full_name: '' }

// The hand-entered days Clear POS's re-count could not confirm (S835), in the words Sales Entry
// shows: "Shrawan 2082: the Bulk total, 3rd and 5th". A long month is a count rather than a list.
function recountLeftText(left, periodById) {
  return left
    .map(j => ({ ...j, p: periodById.get(j.periodId) }))
    .sort((a, b) => ((a.p?.bs_year || 0) - (b.p?.bs_year || 0)) || ((a.p?.bs_month || 0) - (b.p?.bs_month || 0)))
    .map(({ p, days }) => {
      const month = p ? `${BS_MONTHS[p.bs_month - 1] || `month ${p.bs_month}`} ${p.bs_year}` : 'a month that could not be named'
      const list = days.length > 12
        ? `${days.length} days${days.includes(0) ? ', the Bulk total among them' : ''}`
        : andList(days.map(d => (d === 0 ? 'the Bulk total' : bsDayOrdinal(d))))
      return `${month}: ${list}`
    })
    .join('; ')
}

// Which table still holds the client's rows when the final `clients` delete is refused (S835). A
// foreign-key refusal names it twice: `… is still referenced from table "x"` in its details and
// `… on table "x"` at the end of its message. Read defensively: any other shape, or a name that is
// the clients table itself, gives null and the message names no table.
function blockingTableOf(err) {
  const texts = [err?.details, err?.message].filter(t => typeof t === 'string')
  for (const t of texts) {
    const m = t.match(/referenced from table "([A-Za-z0-9_]+)"/)
    if (m && m[1] !== 'clients') return m[1]
  }
  for (const t of texts) {
    const re = /on table "([A-Za-z0-9_]+)"/g
    let m, last = null
    while ((m = re.exec(t))) if (m[1] !== 'clients') last = m[1]
    if (last) return last
  }
  return null
}

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
  property_email: '', vat_number: '', item_code_prefix: 'ITM',
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

// The two settings a save asks about (S739/S747): the prefix is resolved at PRINT time, so a change
// reaches bills already issued; since S809 2c each bill keeps its own VAT status, so that one reaches
// new bills, open tills and menu prices. Same sentences as Settings.js's retroWarnings(); `loaded` is
// the row as this drawer read it.
function retroBillWarnings(loaded, patch) {
  const out = []
  if ('invoice_prefix' in patch && (patch.invoice_prefix || '') !== (loaded?.invoice_prefix || '')) {
    const was = loaded?.invoice_prefix || ''
    const now = patch.invoice_prefix || ''
    out.push(was
      ? `Every bill this client has already issued reprints with the new code — ${was} becomes ${now || '(no code)'} on past invoices as well as new ones, because the number is assembled when a bill is printed, not when it is billed.`
      : `If this client has already issued bills without a code, every one of them reprints with ${now} added to its number from now on, because the number is assembled when a bill is printed, not when it is billed.`)
  }
  if ('is_vat_registered' in patch && (patch.is_vat_registered ?? true) !== (loaded?.is_vat_registered ?? true)) {
    // S809 2c: same sentence as Settings.js's retroWarnings() — each bill keeps the type it was issued as.
    out.push((patch.is_vat_registered ?? true)
      ? 'Bills already issued stay PAN bills: they reprint the same and their figures in the reports do not change. Bills charged from now on are Tax Invoices. A till that is open while you save stops its next Charge once, loads this setting, and asks the cashier to charge the new total.'
      : 'Tax Invoices already issued keep their VAT: they reprint as Tax Invoices with the same total, and the reports keep their VAT. Bills charged from now on are plain PAN bills. A till that is open while you save stops its next Charge once, loads this setting, and asks the cashier to charge the new total.')
    // S792 (D31): same sentence as Settings.js's retroWarnings().
    out.push((patch.is_vat_registered ?? true)
      ? 'Menu prices entered while this outlet gave PAN bills carry no VAT, so the till adds no VAT to those dishes until each price is entered again on Menu Pricing.'
      : 'Dishes priced with VAT will be charged at their price before VAT (13% less than the menu shows) until each price is entered again. Menu Pricing lists them.')
  }
  return out
}

export default function ClientDrawer({ client, onClose, onClientUpdated }) {
  const { adminViewClientId, refreshViewModules } = useAuth()
  const { loadClientSettings, saveClientSettings, pricing } = useSettings()
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
  const [usersLoadErr, setUsersLoadErr] = useState(null)

  // Staff PINs tab state. revealedPins is intentionally NOT seeded from any query — a PIN only
  // ever enters this component as the response to an explicit, audited reveal.
  const [pinAccounts, setPinAccounts]   = useState([])
  const [loadingPins, setLoadingPins]   = useState(false)
  const [revealedPins, setRevealedPins] = useState({})
  const [revealingId, setRevealingId]   = useState(null)
  const [pinErr, setPinErr]             = useState('')
  const [pinsLoadFailed, setPinsLoadFailed] = useState(false) // the list is not shown, never "no accounts" (S852)
  const revealTimersRef                 = useRef({})
  useEffect(() => () => {
    Object.values(revealTimersRef.current).forEach(clearTimeout)
  }, [])

  // Settings tab state
  const [clientSettings, setClientSettings]   = useState(SETTINGS_DEFAULTS)
  const [loadingSettings, setLoadingSettings] = useState(false)
  const [savingSettings, setSavingSettings]   = useState(false)
  const [settingsMsg, setSettingsMsg]         = useState('')
  const [settingsLoadErr, setSettingsLoadErr] = useState(null) // a failed read is not a form
  // Settings and QR are two views of one `clientSettings` object, so fetching on every switch
  // between them re-ran two network calls to rebuild state the drawer already held.
  const settingsLoadedRef = useRef(false)
  // The settings row as last read or saved — what a retroactive change is measured against.
  const loadedSettingsRef = useRef(null)
  const { ask: askConfirm, confirmEl } = useConfirm()
  // A login write the dialog holds busy is bounded (S803): after CONFIRM_TIMEOUT_MS the dialog lets
  // go and says so. The write is not recalled, and its own late message still lands.
  const loginWriteBound = { timeoutMs: CONFIRM_TIMEOUT_MS, onTimeout: () => setUserError(CONFIRM_TIMEOUT_TEXT) }
  // A question asked in the MIDDLE of a running action, which waits for the answer: preflightBackup's
  // "did both files download?", between the backup and the delete. useConfirm runs a callback on
  // confirm and has no Cancel callback, so it cannot hand an answer back to code already running;
  // this resolves a promise with the button pressed. Cancel, Escape and the backdrop all answer no.
  const [midQuestion, setMidQuestion] = useState(null)
  const askMidway = q => new Promise(resolve => setMidQuestion({ ...q, resolve }))
  function answerMidway(yes) {
    const q = midQuestion
    setMidQuestion(null)
    if (q) q.resolve(yes)
  }
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
    // qrcode is a dynamic import — as a top-level import it rode along as a parallel chunk on
    // EVERY visit to /admin/clients (8.9 kB gz, 20.7% of the route's JS, confirmed in the built
    // main.js), despite only ever being needed when a valid payment QR is actually previewed.
    // Same rule as S522's xlsx-in-the-click-handler (S574).
    const t = setTimeout(() => {
      import('qrcode')
        .then(({ default: QRCode }) => QRCode.toDataURL(qrPayload.trim(), { margin: 1, width: 180 }))
        .then(setQrPreview).catch(() => setQrPreview(''))
    }, 250)
    return () => clearTimeout(t)
  }, [qrPayload, qrCheck.ok])

  // Modules state
  const [imsEnabled, setImsEnabled] = useState(client.ims_enabled !== false)
  const [hrEnabled,  setHrEnabled]  = useState(!!client.hr_enabled)
  const [posEnabled, setPosEnabled] = useState(!!client.pos_enabled)
  // Crest Customization (S758): a yes/no add-on that sits ON POS. The database refuses it without
  // pos_enabled and switches it off when POS goes off; the toggle below mirrors both.
  const [customizationEnabled, setCustomizationEnabled] = useState(!!client.pos_enabled && !!client.customization_enabled)
  // No hrPlan/posPlan state: HR and POS are yes/no modules with no tiers, so there is nothing
  // to pick. Both used to default to 'starter' here and get written on every save.
  // Crest Suite Pro — a separate axis from the IMS plan. NULL = not subscribed at all.
  const [suitePlan, setSuitePlan]   = useState(client.suite_plan || null)
  const [groupId, setGroupId]       = useState(client.group_id || null)
  const [groups, setGroups]         = useState([])
  const [newGroupName, setNewGroupName] = useState('')
  const [savingGroup, setSavingGroup]   = useState(false)
  // S849 (GROUP-1): this client's group's outlets, for the HQ select. Members only, so an outlet
  // outside the group can never be picked as the group's HQ.
  const [groupMembers, setGroupMembers] = useState([])
  const [savingHq, setSavingHq]         = useState(false)
  // S849: Crest's own demo or practice outlet — never counted as income (clientMrr, billing-export).
  const [isInternal, setIsInternal]     = useState(!!client.is_internal)

  // Billing tab state — per-module end dates; fall back to legacy subscription_ends_at for IMS
  const _legacyEnd = client.subscription_ends_at ? formatAd(new Date(client.subscription_ends_at)) : ''
  const [imsEndsAt, setImsEndsAt] = useState(client.ims_ends_at ? formatAd(new Date(client.ims_ends_at)) : _legacyEnd)
  const [hrEndsAt,  setHrEndsAt]  = useState(client.hr_ends_at  ? formatAd(new Date(client.hr_ends_at))  : '')
  const [posEndsAt, setPosEndsAt] = useState(client.pos_ends_at ? formatAd(new Date(client.pos_ends_at)) : '')
  const [customizationEndsAt, setCustomizationEndsAt] = useState(client.customization_ends_at ? formatAd(new Date(client.customization_ends_at)) : '')
  const [suiteEndsAt, setSuiteEndsAt] = useState(client.suite_ends_at ? formatAd(new Date(client.suite_ends_at)) : '')
  const [billingCycle, setBillingCycle] = useState(client.billing_cycle || 'monthly')
  const [savingSub, setSavingSub] = useState(false)
  const [subMsg, setSubMsg]       = useState('')

  // Logo upload state (Settings tab)
  const logoInputRef = useRef(null)
  const restoreInputRef = useRef(null)
  const [logoUploading, setLogoUploading] = useState(false)
  const [logoMsg, setLogoMsg] = useState('')

  // Danger Zone state — tracks which specific action is in flight so only that
  // button shows "Working…"; all buttons still disable together to block concurrent runs.
  const [deletingAction, setDeletingAction] = useState(null)
  // Typed-name confirmation for the three whole-client actions (Archive, Clear Client Data,
  // Delete Client). Every destructive path here used to be a single window.confirm OK — the same
  // one keypress for "Clear IMS Transactions" as for deleting the entire client, with no defence
  // against having the wrong drawer open (the drawer opens from a click anywhere on a client
  // card). Whole-client blast radius requires typing the client's name (phase 7, S574). Every other
  // question this drawer asks — the module clears, Clear All Conversions, moving, deleting or
  // blocking a login, and "did both backup files download?" — goes through the app's own confirm
  // dialog (useConfirm / askMidway below), never window.confirm: the browser's box names no client,
  // carries the OS chrome rather than the theme, and offers the same OK for every one of them.
  const [confirmAction, setConfirmAction] = useState(null)  // 'archive' | 'clientData' | 'deleteClient'
  const [confirmName, setConfirmName] = useState('')
  // Admin password reset for a client login — most importantly the OWNER's. The Edge Function's
  // requireStaffTarget deliberately exempts admin callers for exactly this support case (owner
  // locked out, email on file wrong or inbox gone), but nothing in the product ever called it
  // with an Owner target: reset_ims_password's only other callers are the client-facing staff
  // pages, whose lists an Owner can never appear in. The only admin "fix" was delete-and-recreate
  // the login, losing profiles.id and every *_by attribution pointing at it (phase 7 P1, S574).
  const [resetUser, setResetUser] = useState(null)
  const [resetPw, setResetPw] = useState('')
  const [resettingPw, setResettingPw] = useState(false)
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
  // The backup's roster, held only while a relink after a restore has failed (S798).
  const [relinkRoster, setRelinkRoster] = useState(null)
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
    if ((activeTab === 'settings' || activeTab === 'qr') && !settingsLoadedRef.current) {
      fetchClientSettings()
    }
    if (activeTab === 'pins') loadPinAccounts()
    // request:false — this runs on tab switch, not on a click, and requestPermission() outside a
    // user gesture is rejected. Reading the state is enough to decide what to render.
    if (activeTab === 'data' || activeTab === 'danger') {
      ensureBackupDirectory({ request: false }).then(({ state }) => setBackupState(state))
    }
    // Outlet groups live on the Billing tab; loaded on first visit rather than with the drawer,
    // since most clients are single-outlet and never open it.
    if (activeTab === 'billing') reloadGroups()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  // The groups, re-read after any group change: the database clears a group's HQ when the HQ
  // outlet leaves it (GROUP-1), so the HQ select must show what is stored, not what was.
  function reloadGroups() {
    return supabase.from('client_groups').select('id, name, hq_client_id').order('name')
      .then(({ data, error }) => {
        if (error) { console.error('[ClientDrawer] outlet groups read failed:', error); return }
        setGroups(data || [])
      })
  }

  // The outlets of this client's group (S849 GROUP-1 / GROUP-11): the HQ select's options and the
  // names the leave confirm gives. The operator reads every client.
  useEffect(() => {
    if (activeTab !== 'billing' || !groupId) { setGroupMembers([]); return }
    let cancelled = false
    supabase.from('clients').select('id, name').eq('group_id', groupId).order('name')
      .then(({ data, error }) => {
        if (error) console.error('[ClientDrawer] group outlets read failed:', error)
        if (!cancelled) setGroupMembers(error ? [] : (data || []))
      })
    return () => { cancelled = true }
  }, [activeTab, groupId])

  // ── Staff PINs ──
  // Reads profiles and staff_pin_vault directly rather than through an RPC: both are readable
  // here because admin passes profiles_select's `is_admin()` branch and staff_pin_vault is an
  // admin-only table. The PIN itself never comes from either query — only whether one is stored.
  async function loadPinAccounts() {
    setLoadingPins(true); setPinErr(''); setPinsLoadFailed(false); setRevealedPins({})
    const [{ data: profs, error: profErr }, { data: vaultRows, error: vaultErr }] = await Promise.all([
      supabase.from('profiles')
        .select('id, full_name, pos_email, hr_self_service')
        .eq('client_id', client.id)
        .or('pos_email.not.is.null,hr_self_service.eq.true'),
      supabase.from('staff_pin_vault').select('user_id, updated_at').eq('client_id', client.id),
    ])
    // A failed profiles read rendered "This client has no POS or Self-Service PIN accounts"; a
    // failed vault read rendered every account as "Not stored", which the copy beside it tells
    // the operator to fix by RESETTING the PIN (S736).
    if (profErr || vaultErr) {
      setPinErr(withDetail('Could not read the PIN accounts of this client, so the list is not shown: an account left out, or shown as not stored, could not be trusted. Press Retry.', profErr || vaultErr))
      setPinsLoadFailed(true)
      setPinAccounts([]); setLoadingPins(false); return
    }
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
      setPinErr(loginOpFailure('The PIN was not shown.', e))
    }
    setRevealingId(null)
  }

  // The drawer used to run a "reconciliation" effect here that force-enabled all three modules
  // and overwrote plan/hr_plan/pos_plan to match suite_plan whenever the two disagreed — correct
  // while Suite was a bundle that CONTAINED the modules, and actively destructive now that it is
  // an add-on sold on top of them. Under the add-on model a Suite client legitimately runs any
  // module combination at any tier, so there is nothing to reconcile; leaving the effect in place
  // would silently rewrite a real subscription the moment an admin opened the drawer.

  // ── Users ──
  async function loadUsers() {
    setLoadingUsers(true); setUsersLoadErr(null)
    const { data: profs, error: profErr } = await supabase
      .from('profiles')
      // pos_email: a till login's Delete goes through delete_pos_staff (S809 3i, deleteUser below).
      .select('id, full_name, role, client_id, pos_email')
      .eq('client_id', client.id)
    // "No users yet for this client" on a failed read is a claim the operator acts on — by
    // creating a second Owner login (S736). Render the failure instead.
    if (profErr) { setUsersLoadErr(asActionError(profErr, 'operator')); setLoadingUsers(false); return }
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
      setUserError(loginOpFailure('The login was not created.', err))
      setSavingUser(false)
      return
    }

    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({ id: authData.user.id, client_id: client.id, full_name, role: 'client' }, { onConflict: 'id' })
    if (profileError) {
      // The login exists now, so this is not a retry of the create: pressing Create User again with
      // the same email finds it and offers to move it here, which writes the missing link (S852).
      setUserError(withDetail(`${email} was created, but linking it to ${client.name} could not be confirmed, so it may not sign in here yet. If it is not in the list below, press Create User again with the same email and accept the move.`, profileError))
      setSavingUser(false)
      loadUsers()
      return
    }

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
      if (findErr) { setUserError(withDetail('Could not look up which login holds that email, so nothing was changed. Press Create User again.', findErr)); setSavingUser(false); return }
      if (!existingId) {
        setUserError('That email already exists but could not be located to reassign.')
        setSavingUser(false); return
      }
      // A check that could not run has not passed (S682): on a failed read this used to skip the
      // "is this a platform admin" refusal and reassign an operator's own account to a client.
      const { data: prof, error: profErr } = await supabase.from('profiles').select('role').eq('id', existingId).maybeSingle()
      if (profErr) {
        setUserError(withDetail('Could not check whether that email is a platform-admin account, so nothing was changed. Try again.', profErr))
        setSavingUser(false); return
      }
      if (prof?.role === 'admin') {
        setUserError('That email is a platform-admin account — use a different email for a client login.')
        setSavingUser(false); return
      }
      // The dialog has no Cancel callback, so the Create button is released before asking: saying
      // no leaves the form as typed and nothing written, as it always did.
      setSavingUser(false)
      askConfirm({
        title: `Move ${email} to ${client.name}?`,
        body: <p style={{ margin: 0 }}>{`${email} already has a client login. Moved to "${client.name}", it loses access to its previous client and arrives as an Owner login — any staff role, POS/Self-Service access or employee link it had there is removed. (Its existing password is kept.)`}</p>,
        confirmLabel: 'Move login', busyLabel: 'Moving…',
        ...loginWriteBound,
        run: () => moveLoginHere(existingId, email, full_name),
      })
    } catch (err) {
      setUserError(withDetail('Could not finish checking that email, so the login was not moved to this client. Press Create User again.', err))
      setSavingUser(false)
    }
  }

  async function moveLoginHere(existingId, email, full_name) {
    setSavingUser(true)
    try {
      // upsert (not update): some older auth users have no profiles row, so a
      // plain update would silently match 0 rows. .select() confirms it persisted.
      //
      // Everything that still points at the OLD client is cleared in the same write (S736).
      // active_client_id is the sharp one: my_client_id() and AuthContext both resolve it BEFORE
      // client_id, and no trigger clears it on a client_id change (only on group changes and
      // revokes) — so a grouped Owner who had switched outlets and was then moved here kept
      // reading and writing the old outlet under the new client's login. hr_employee_id points at
      // an hr_employees row of the old client. The staff markers make this login STAFF at the new
      // client, not its Owner (Owner is the absence of markers), so a login created here to run a
      // property would arrive with a rank nobody chose.
      const row = {
        id: existingId, client_id: client.id, role: 'client',
        active_client_id: null, hr_employee_id: null,
        pos_role: null, pos_email: null, pos_job_title: null,
        ims_role: null, ims_job_title: null,
        hr_role: null, hr_job_title: null, hr_self_service: false,
      }
      if (full_name) row.full_name = full_name
      const { data: saved, error: upErr } = await supabase.from('profiles').upsert(row, { onConflict: 'id' }).select('id')
      if (upErr) { setUserError(loginWriteFailure(`${email} was not moved, and still belongs to its previous client.`, upErr)); setSavingUser(false); return }
      if (!saved || saved.length === 0) {
        setUserError({ text: `${email} was not moved: the database did not let this account change that login, so it still belongs to its previous client.`, detail: 'profiles upsert returned no row (RLS): run the admin-profiles policy fix, then retry' })
        setSavingUser(false); return
      }
      setUserError('')
      setUserSuccess(`✓ ${email} reassigned to this client.`)
      setUserForm(EMPTY_USER)
      setSavingUser(false)
      loadUsers()
    } catch (err) {
      setUserError(withDetail('The move could not be confirmed. Check the list below before trying again.', err))
      setSavingUser(false)
      loadUsers()
    }
  }

  function deleteUser(user) {
    const who = user.full_name || user.email || 'this login'
    const ident = user.full_name ? `"${user.full_name}" (${user.email})` : `(${user.email})`
    askConfirm({
      title: `Delete ${who}'s login?`,
      body: <p style={{ margin: 0 }}>{`This permanently removes the login ${ident} from ${client.name} and frees the email to be reused.`}</p>,
      confirmLabel: 'Delete login', cancelLabel: 'Keep', danger: true, busyLabel: 'Deleting…',
      ...loginWriteBound,
      run: () => runDeleteUser(user),
    })
  }

  async function runDeleteUser(user) {
    setUserError('')
    try {
      // A till (PIN) login goes through delete_pos_staff (S809 ACCESS-5): it refuses a login that has
      // recorded anything at the till, whose delete would take the name off those bills, shifts and
      // tickets, and the operator is offered Block instead, as POS Staff offers it.
      if (user.pos_email) await adminOp('delete_pos_staff', { client_id: client.id, userId: user.id })
      else await adminOp('deleteUser', { userId: user.id })
    } catch (err) {
      if (err.code === 'pos_login_has_records') {
        offerBlockInstead(user, err.message)
        return
      }
      const alreadyGone = /not found/i.test(err.message)
      if (!alreadyGone) {
        // Auth user still exists but deletion failed — don't remove the profile
        // or the email stays locked with no way to clean it up.
        setUserError(loginOpFailure('The login was not deleted, and its email stays in use.', err))
        return
      }
      // Auth user was already deleted — fall through and clean up the orphaned profile
    }
    // One write never proves another landed (S852): the success line waits for this delete's own answer.
    const { error: profDelErr } = await supabase.from('profiles').delete().eq('id', user.id)
    if (profDelErr) {
      setUserError(withDetail('The login was removed, but clearing its profile row could not be confirmed, so it may still show in the list below. Press Delete on it again to clear it.', profDelErr))
      loadUsers()
      return
    }
    setUserSuccess('✓ User deleted and email freed.')
    loadUsers()
  }

  // Asked from inside the delete's own run, which useConfirm allows: its cleanup clears only the ask
  // that just ran, so this follow-up stays on screen. Its Cancel has no callback, so what saying no
  // means is stated first, behind the dialog, and simply stays when it closes.
  function offerBlockInstead(user, refusal) {
    const name = user.full_name || 'this login'
    setUserError(`${user.full_name || 'The login'} was not deleted, and their PIN still works.`)
    askConfirm({
      title: `Block ${name} now?`,
      body: <>
        <p style={{ margin: '0 0 8px' }}>{refusal}</p>
        <p style={{ margin: 0 }}>{`Blocking stops ${name} signing in to ${client.name}, and keeps their name on everything they recorded.`}</p>
      </>,
      confirmLabel: 'Block login', busyLabel: 'Blocking…',
      ...loginWriteBound,
      run: async () => {
        try {
          await adminOp('block_pos_staff', { client_id: client.id, userId: user.id })
          setUserError('')
          setUserSuccess(`✓ ${user.full_name || 'The login'} is blocked: it can no longer sign in, and its name stays on everything it recorded.`)
        } catch (blockErr) {
          // admin-user-ops' refusal is usually a sentence naming the person and what happened, so it
          // follows the consequence; a bare code or no answer goes to the fine print (S852).
          setUserError(loginOpFailure(`${user.full_name || 'The login'} is not blocked, and their PIN still works.`, blockErr))
        }
      },
    })
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
    if (error) { setSavingClient(false); setClientMsg('error:The client details were not saved — the drawer still shows what you typed, the record does not. ' + errorLine(error)); return }

    // Keep settings.app_name in sync with client name
    if (editForm.name.trim() !== client.name) {
      // The S613 second-settings-row trap: a failed existing-row read must not fall into INSERT.
      // The client rename itself has already committed, so this reports rather than refusing.
      const { data: existing, error: exErr } = await supabase.from('settings').select('id').eq('client_id', client.id).maybeSingle()
      const nameErr = exErr || (existing?.id
        ? (await supabase.from('settings').update({ app_name: editForm.name.trim() }).eq('id', existing.id)).error
        : (await supabase.from('settings').insert({ client_id: client.id, app_name: editForm.name.trim() })).error)
      if (nameErr) {
        setSavingClient(false)
        setClientMsg('error:The client was renamed, but its white-label app name still shows the old name — open Settings → Branding and save it there. ' + errorLine(nameErr))
        return
      }
    }

    setSavingClient(false)
    setClientMsg('ok:Client updated.')
    onClientUpdated()
  }

  // ── Settings ──
  // A failed read here must not become a form. Settings and QR both render whatever is in
  // `clientSettings`, and their Save buttons used to write ALL of it back — so a dropped read
  // rendered as SETTINGS_DEFAULTS meant one press of "Save Thresholds" (a tab removed in S744)
  // overwrote the client's real name, VAT number, invoice prefix and payment QR with blanks, and the same press upserted the
  // webhook secret (read separately, also dropped) as null (S736). A missing settings row is a
  // real state (a client never seeded) and still renders the defaults; a failed read renders an
  // error with a retry, and every Save on those tabs refuses until a read has succeeded.
  async function fetchClientSettings() {
    setLoadingSettings(true); setSettingsLoadErr(null)
    try {
      // Separate read: the webhook secret lives in client_secrets, which is admin-only at the RLS
      // level, so it can't ride along on the settings row any more.
      const { data: secretRow, error: secretErr } = await supabase
        .from('client_secrets').select('pos_webhook_secret').eq('client_id', client.id).maybeSingle()
      if (secretErr) throw secretErr
      const data = await loadClientSettings(client.id)
      setWebhookSecret(secretRow?.pos_webhook_secret || '')
      // No invented invoice code (S747, decided with Aashish): a blank prefix used to be filled from
      // the property name here and then saved by the next Save, renumbering every bill the client
      // had already issued without one. It stays blank until someone types a code.
      loadedSettingsRef.current = data || {}
      if (data) setClientSettings(prev => ({ ...prev, ...data }))
      settingsLoadedRef.current = true
    } catch (e) {
      setSettingsLoadErr(asActionError(e, 'operator'))
    }
    setLoadingSettings(false)
  }

  // `what` names what the admin actually pressed — the three tabs share one save handler, so a
  // "Save Thresholds" or "Save QR" click used to report back "Settings saved."
  // WHICH columns each button owns. `clientSettings` is the client's settings row as it stood when
  // this drawer opened (loadClientSettings does `select('*')`), and every one of these buttons used
  // to send the whole thing back — so saving Branding here put POS discount reasons, note presets,
  // reservation settings, ticket routing, TADA rates, the three custom-role schemes, the combo
  // discount and the Stock Count settings back to what they were when the drawer opened. That is
  // S730's defect exactly, in the other admin editor for the same columns: `settings` is one row
  // per client that nine other pages write their own columns onto, and both saves report success.
  const DRAWER_SETTINGS_FIELDS = {
    Settings: ['app_name', 'app_tagline', 'logo_url', 'vat_number', 'is_vat_registered', 'invoice_prefix',
               'property_address', 'property_phone', 'property_email',
               'contact_phone', 'contact_email', 'contact_website'],
    'Payment QR': ['payment_qr_data'],
    // The webhook secret lives in client_secrets, written below: this button owns no settings column.
    'Webhook secret': [],
  }

  async function handleSaveSettings(what = 'Settings') {
    if (!settingsLoadedRef.current) {
      setSettingsMsg('error:Nothing was saved — this client\'s settings could not be read, so saving now would overwrite them with blanks. Retry the load first.')
      return
    }
    const fields = DRAWER_SETTINGS_FIELDS[what] || []
    const patch = {}
    for (const k of fields) if (k in clientSettings) patch[k] = clientSettings[k]
    // This drawer had no warning at all for the two fields that rewrite issued bills (S747) — the
    // Settings page asked, the other editor for the same columns did not.
    const warnings = retroBillWarnings(loadedSettingsRef.current, patch)
    if (warnings.length) {
      // Named by the FIELDS that moved, not the warning count: a bill-type change alone carries
      // two sentences since S792 (the reprint and the menu-price consequence).
      const codeMoved = 'invoice_prefix' in patch && (patch.invoice_prefix || '') !== (loadedSettingsRef.current?.invoice_prefix || '')
      const typeMoved = 'is_vat_registered' in patch && (patch.is_vat_registered ?? true) !== (loadedSettingsRef.current?.is_vat_registered ?? true)
      askConfirm({
        title: codeMoved && typeMoved ? 'Change the bill type and the invoice code?' : (codeMoved ? 'Change the invoice code?' : 'Change the bill type?'),
        confirmLabel: 'Save anyway', danger: true, busyLabel: 'Saving…',
        body: <>{warnings.map((w, i) => <p key={i} style={{ margin: '0 0 8px' }}>{w}</p>)}</>,
        run: () => commitClientSettings(what, patch),
      })
      return
    }
    await commitClientSettings(what, patch)
  }

  async function commitClientSettings(what, patch) {
    setSavingSettings(true); setSettingsMsg('')
    try {
      if (Object.keys(patch).length) {
        await saveClientSettings(client.id, patch)
        loadedSettingsRef.current = { ...(loadedSettingsRef.current || {}), ...patch }
      }
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

  // ── Module toggles (instant save). These used to no-op while a Suite Bundle was active,
  // because the bundle required all three modules together. Crest Suite Pro is an add-on now, so
  // a Suite client can run any module combination and every toggle stays live. ──
  // One implementation. The three used to `await` the update and read nothing back, so a write
  // that did not land left the switch flipped on screen while the row — and the client list
  // behind the drawer, after onClientUpdated re-read it — still showed the old state (S736). The
  // switch is set optimistically and put BACK on failure, so what is on screen is what is saved.
  async function toggleModule(column, label, current, setter) {
    const next = !current
    setter(next)
    setSubMsg('')
    const { error } = await supabase.from('clients').update({ [column]: next }).eq('id', client.id)
    if (error) {
      setter(current)
      setSubMsg(`error:${label} is still ${current ? 'on' : 'off'} — the change did not save. ${errorLine(error)}`)
      return
    }
    onClientUpdated()
    if (client.id === adminViewClientId) refreshViewModules()
  }
  // S849 (ACCESS-3): Crest Suite Pro is an IMS add-on, so switching IMS off while Suite is on asks
  // first and takes Suite off in the same write — otherwise every Suite page closes while Suite
  // looks switched on here and on the client list.
  const handleToggleIms = () => {
    if (!imsEnabled || suitePlan !== 'pro') return toggleModule('ims_enabled', 'Crest IMS', imsEnabled, setImsEnabled)
    askConfirm({
      title: `Switch Crest IMS off for ${client.name}?`,
      body: <p style={{ margin: 0 }}>{`Crest Suite Pro needs IMS, so all six Suite pages stop and Suite stops billing. Suite is switched off in the same step.`}</p>,
      confirmLabel: 'Switch IMS and Suite off', busyLabel: 'Switching off…', danger: true,
      run: async () => {
        setSubMsg('')
        const { data, error } = await supabase.from('clients')
          .update({ ims_enabled: false, suite_plan: null }).eq('id', client.id)
          .select('ims_enabled, suite_plan')
        if (error || !data?.length) {
          setSubMsg(`error:Crest IMS and Crest Suite Pro are still on — the change did not save. ${error ? errorLine(error) : 'No row was updated; reload the drawer.'}`)
          return
        }
        setImsEnabled(data[0].ims_enabled !== false)
        setSuitePlan(data[0].suite_plan || null)
        onClientUpdated()
        if (client.id === adminViewClientId) refreshViewModules()
      },
    })
  }

  // S849 (demo outlets, owner answer (a)): Crest's own demo or practice outlet. Saves instantly with
  // the module switches' revert-on-failure shape; switching it ON asks first, because it changes
  // what HSS bills. Access is untouched: nothing that locks, gates or filters reads it.
  const handleToggleInternal = () => {
    if (isInternal) return toggleModule('is_internal', 'The demo outlet switch', isInternal, setIsInternal)
    askConfirm({
      title: `Mark ${client.name} as a demo outlet?`,
      body: <p style={{ margin: 0 }}>{`${client.name} will stop counting as income in Crest and be sent to HSS as not billable. Its modules, dates and access do not change.`}</p>,
      confirmLabel: 'Mark as demo outlet', busyLabel: 'Saving…',
      run: () => toggleModule('is_internal', 'The demo outlet switch', isInternal, setIsInternal),
    })
  }
  const handleToggleHr  = () => toggleModule('hr_enabled',  'Crest HR',  hrEnabled,  setHrEnabled)
  // POS off takes Customization with it — the database trigger does the same, so the switch on
  // screen follows what the row will hold rather than waiting for the next re-read.
  const handleTogglePos = async () => {
    const wasOn = posEnabled
    await toggleModule('pos_enabled', 'Crest POS', posEnabled, setPosEnabled)
    if (wasOn && customizationEnabled) setCustomizationEnabled(false)
  }
  const handleToggleCustomization = () => toggleModule('customization_enabled', 'Crest Customization', customizationEnabled, setCustomizationEnabled)

  // Crest Suite Pro is an add-on, so turning it on implies exactly one thing: IMS must be
  // enabled (SuiteGate's requireModules floor). It says nothing about HR, POS, or which IMS tier
  // the client is on — those stay whatever the admin set. Takes effect on the next Save
  // Subscription, same as the plan/date fields below.
  function handleSuiteToggle(on) {
    setSuitePlan(on ? 'pro' : null)
    if (on) setImsEnabled(true)
  }

  // ── Outlet group (instant save — structural, not billing) ──
  // The clients.group_id trigger nulls profiles.active_client_id for anyone pointed at this
  // outlet, so a regrouping can never leave a user resolved to an outlet they can no longer
  // reach. That is what keeps my_client_id() a join-free COALESCE.
  // The OTHER outlets of a group, by name, for the confirm (GROUP-11). A failed read returns null,
  // and the change is not offered on a sentence that could be missing names.
  async function otherOutletNames(gid) {
    if (!gid) return []
    const { data, error } = await supabase.from('clients').select('id, name').eq('group_id', gid).order('name')
    if (error) { console.error('[ClientDrawer] group outlets read failed:', error); return null }
    return (data || []).filter(c => c.id !== client.id).map(c => c.name)
  }

  // S849 (GROUP-11): joining another group is one dropdown change that hands its Owners the reach of
  // an Owner into this client, so it asks first and names both sides. Cancel leaves the select on the
  // saved value (it is controlled by groupId, which only a landed write changes).
  async function handleGroupChange(nextGroupId) {
    if ((nextGroupId || null) === (groupId || null)) return
    const fromGroup = groups.find(g => g.id === groupId) || null
    const toGroup = groups.find(g => g.id === nextGroupId) || null
    const [fromOthers, toOthers] = await Promise.all([otherOutletNames(groupId), otherOutletNames(nextGroupId)])
    if (fromOthers === null || toOthers === null) {
      setSubMsg('error:The outlet group was not changed — the outlets in the group could not be read, so the change could not be confirmed. Reload the drawer and try again.')
      return
    }
    const copy = groupChangeCopy({ clientName: client.name, clientId: client.id, fromGroup, toGroup, fromOthers, toOthers })
    askConfirm({
      title: copy.title,
      body: <>{copy.body.map((line, i) => <p key={i} style={{ margin: i ? '8px 0 0' : 0 }}>{line}</p>)}</>,
      confirmLabel: copy.confirmLabel, busyLabel: 'Saving…', danger: !!toGroup,
      run: async () => {
        setSavingGroup(true)
        const { data, error } = await supabase.from('clients').update({ group_id: nextGroupId }).eq('id', client.id).select('id')
        setSavingGroup(false)
        if (error || !data?.length) {
          setSubMsg('error:The outlet group was not changed — this client is still in its previous group. ' + (error ? errorLine(error) : 'No row was updated; reload the drawer.'))
          return
        }
        setGroupId(nextGroupId)
        setSubMsg('ok:' + (nextGroupId ? 'Outlet added to group.' : 'Outlet removed from its group.'))
        reloadGroups()
        onClientUpdated()
        if (client.id === adminViewClientId) refreshViewModules()
      },
    })
  }

  // Create & Assign (S849 GROUP-1 / GROUP-11): asks first like any group change, then in three steps
  // — insert the group with no HQ, join this client, set this client as HQ — so it stays valid if
  // the database checks that a group's HQ is one of its outlets.
  async function handleCreateGroup() {
    const name = newGroupName.trim()
    if (!name) return
    const fromGroup = groups.find(g => g.id === groupId) || null
    const fromOthers = await otherOutletNames(groupId)
    if (fromOthers === null) {
      setSubMsg('error:The group was not created — the outlets in this client\'s current group could not be read, so the change could not be confirmed. Reload the drawer and try again.')
      return
    }
    const copy = groupChangeCopy({ clientName: client.name, clientId: client.id, fromGroup, toGroup: { id: null, name }, fromOthers, toOthers: [] })
    askConfirm({
      title: `Create the outlet group "${name}" with ${client.name} in it?`,
      body: <>
        {copy.body.map((line, i) => <p key={i} style={{ margin: i ? '8px 0 0' : 0 }}>{line}</p>)}
        <p style={{ margin: '8px 0 0' }}>{`${client.name} becomes the group's HQ, the outlet Push to branches copies from. Other outlets join from their own Billing tab.`}</p>
      </>,
      confirmLabel: 'Create and join', busyLabel: 'Creating…',
      run: async () => {
        setSavingGroup(true)
        try {
          const { data, error } = await supabase.from('client_groups').insert({ name }).select().single()
          if (error) { setSubMsg('error:The group was not created, so this client has not been grouped. ' + errorLine(error)); return }
          const { data: joined, error: linkErr } = await supabase.from('clients').update({ group_id: data.id }).eq('id', client.id).select('id')
          if (linkErr || !joined?.length) {
            setGroups(g => [...g, data].sort((a, b) => a.name.localeCompare(b.name)))
            setSubMsg(`error:Group "${name}" was created, but ${client.name} was not put in it — it is still in its previous group. ` + (linkErr ? errorLine(linkErr) : 'No row was updated; reload the drawer.'))
            return
          }
          setGroupId(data.id)
          setNewGroupName('')
          const { data: hqRow, error: hqErr } = await supabase.from('client_groups').update({ hq_client_id: client.id }).eq('id', data.id).select('id')
          await reloadGroups()
          onClientUpdated()
          if (client.id === adminViewClientId) refreshViewModules()
          if (hqErr || !hqRow?.length) {
            setSubMsg('error:Group created and joined, but HQ was not set — pick it under HQ outlet. ' + (hqErr ? errorLine(hqErr) : ''))
            return
          }
          setSubMsg(`ok:Created group "${name}" with this outlet as HQ.`)
        } finally {
          setSavingGroup(false)
        }
      },
    })
  }

  // S849 (GROUP-1): the group's HQ — the outlet whose items, recipes and prices Push to branches
  // copies — chosen from the group's own outlets. Saves instantly, put back on failure.
  async function handleHqChange(nextHqId) {
    const current = groups.find(g => g.id === groupId)
    if (!current) return
    const prevHq = current.hq_client_id || null
    const next = nextHqId || null
    if (next === prevHq) return
    setGroups(gs => gs.map(g => (g.id === groupId ? { ...g, hq_client_id: next } : g)))
    setSavingHq(true)
    setSubMsg('')
    const { data, error } = await supabase.from('client_groups').update({ hq_client_id: next }).eq('id', groupId).select('id, hq_client_id')
    setSavingHq(false)
    if (error || !data?.length) {
      setGroups(gs => gs.map(g => (g.id === groupId ? { ...g, hq_client_id: prevHq } : g)))
      setSubMsg(`error:The group's HQ outlet was not changed. ${error ? errorLine(error) : 'No row was updated; reload the drawer.'}`)
      return
    }
    setSubMsg('ok:' + (next ? 'HQ outlet set.' : 'The group has no HQ now, so Push to branches is off.'))
  }

  // ── Billing ──
  // From the later of today and the CURRENT end date — see extendedFrom. Computing from today
  // shortened any subscription extended before it ran out (S736).
  function extendModule(current, setter, days) {
    setter(formatAd(extendedFrom(current, days)))
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
      customization_enabled: posEnabled && customizationEnabled,
      ims_ends_at:   imsEndsAt || null,
      hr_ends_at:    hrEndsAt  || null,
      pos_ends_at:   posEndsAt || null,
      customization_ends_at: customizationEndsAt || null,
      suite_ends_at: suiteEndsAt || null,
      plan:          currentPlan,
      // hr_plan/pos_plan are deliberately not written. HR and POS are yes/no modules with no
      // tiers, so writing a "plan" for either created a value the product never sold — and until
      // this session that value silently raised the IMS tier, handing out IMS Pro for free.
      // The columns stay in the DB (vestigial) rather than being dropped; nothing reads them.
      suite_plan:    suitePlan,
      billing_cycle: billingCycle,
    }).eq('id', client.id)
    if (error) { setSubMsg('error:The plan and billing changes were not saved — this client is still on its previous plan, and its MRR is unchanged. ' + errorLine(error)) }
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
      if (err.name === 'AbortError') {
        setBackupMsg('error:Folder selection was cancelled, or blocked by this browser. Exports will download instead.')
        return
      }
      // Any other failure can come after the pick (saving the folder in this browser, or asking for
      // its permission), so read back where backups now go rather than guess (S852).
      let state = 'none'
      try { ({ state } = await ensureBackupDirectory({ request: false })) } catch (_) { /* state stays none */ }
      setBackupState(state)
      setBackupMsg(withDetail(state === 'granted'
        ? 'The new folder was not set, so backups keep going to the folder chosen before.'
        : isFileSystemAccessSupported()
          ? 'No backup folder is set up in this browser, so backups will download to this computer instead. Choose the folder again to try once more.'
          : 'This browser cannot write to a folder (Chrome and Edge can), so backups will download to this computer instead.', err))
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
      setBackupMsg(`ok:${manifest.totalRows.toLocaleString('en-IN')} rows written to ${location}${method === 'download' ? ' (downloaded — file it manually)' : ''}`)
      onClientUpdated()
      return { ok: true, method }
    } catch (err) {
      // runBackup stamps the date only after the files are written, so any throw means no stamp; a
      // part that could not be read is one of those throws since S852, named in the message.
      setBackupMsg('error:The backup did not finish, so no backup date was recorded for this client. ' + err.message)
      return { ok: false }
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
    const result = await handleExportNow(reason)
    if (!result.ok) {
      setDeleteMsg('error:Backup failed, so nothing was deleted. Fix the backup, or tick "I have backed up elsewhere" to proceed anyway.')
      return false
    }
    // The download path fires two programmatic downloads and cannot verify either landed — the
    // browser's multiple-download permission can suppress the second with no detectable signal.
    // Before deleting anything on the strength of that backup, make the operator look: the .json
    // (downloaded first) is the only artifact that can restore (S574).
    if (result.method === 'download') {
      const confirmed = await askMidway({
        title: 'Are both backup files safely downloaded?',
        body: <>
          <p style={{ margin: '0 0 8px' }}>The backup was DOWNLOADED (no backup folder is set up in this browser).</p>
          <p style={{ margin: '0 0 8px' }}>Check your Downloads folder now: BOTH files must be there — the .json (which can restore) and the .xlsx (the readable copy). Some browsers block the second download.</p>
          <p style={{ margin: 0 }}>{`Nothing has been deleted from ${client.name} yet. It starts when you continue.`}</p>
        </>,
        confirmLabel: 'Both are there, continue', danger: true,
      })
      if (!confirmed) {
        setDeleteMsg('error:Stopped — nothing was deleted. Set up a backup folder, or retry once both files download.')
        return false
      }
    }
    return true
  }

  // Puts back each kept login's employee link and a settled leaver's block (relink_staff_accounts).
  // Returns the sentence for the restore message. On a failure the roster is held so the operator
  // can run it again: the restore itself cannot be repeated over a client it has just filled.
  async function relinkStaffLogins(roster) {
    try {
      const link = await adminOp('relink_staff_accounts', { client_id: client.id, roster })
      setRelinkRoster(null)
      const n = link.relinked?.length || 0
      const b = link.reblocked?.length || 0
      let text = ''
      if (n) text += ` ${n} staff login${n !== 1 ? 's' : ''} re-linked to ${n !== 1 ? 'their' : 'its'} employee record${n !== 1 ? 's' : ''}.`
      if (b) text += ` Login blocks put back for ${b} settled leaver${b !== 1 ? 's' : ''}: ${link.reblocked.join(', ')}.`
      if (link.skipped?.length) text += ` Not re-linked: ${link.skipped.map(s => `${s.full_name} (${s.reason})`).join('; ')}.`
      return { text, failed: false }
    } catch (err) {
      setRelinkRoster(roster)
      // "could not be confirmed", not "were not" (S852): with no answer some may have re-linked.
      // Pressing the button again is safe, because it only fills a link that is still empty.
      return {
        text: ` But staff logins could not be confirmed as re-linked to their employee records: until they are, Crest Staff refuses those logins and a leaver settled later keeps theirs. Press "Re-link staff logins" below; it only fills links that are still empty, so pressing it again is safe.`,
        failed: true,
        detail: errorInfo(err, 'operator').detail,
      }
    }
  }

  async function retryRelink() {
    if (!relinkRoster) return
    setRestoreBusy(true)
    const { text, failed, detail } = await relinkStaffLogins(relinkRoster)
    setRestoreMsg(failed ? { text: text.trim(), detail } : `ok:${text.trim() || 'Staff logins checked — nothing needed re-linking.'}`)
    setRestoreBusy(false)
  }

  async function handleRestoreFile(file) {
    if (!file) return
    setRestoreBusy(true)
    setRestoreMsg('')
    setRelinkRoster(null)
    // How far it got, for the catch (S852): a failure before the first insert restored nothing; one
    // after it may have left part of the backup in, and the restore cannot be run over that again.
    let stage = 'file'
    let started = false
    const details = []
    try {
      const parsed = JSON.parse(await file.text())
      stage = 'restore'
      const result = await restoreClientData(client.id, parsed, {
        onProgress: (label, done, total) => { started = true; setRestoreMsg(`info:Restoring ${label} (${done}/${total})…`) },
      })
      stage = 'logins'
      let note = ''
      let loginsFailed = false

      // Only rebuild logins when the target has none. After an Archive the accounts were never
      // deleted, so re-provisioning would create a second set of PIN logins for the same people;
      // after a full Delete there are none, which is exactly when this is wanted.
      // A guard that drops its read error passes vacuously (S654): on a failed count this used to
      // fall into the rebuild branch, where every existing login came back from the Edge Function
      // as "must be recreated by hand" — an instruction to delete and recreate accounts that
      // already work. The data is restored either way; only the login step is skipped.
      // Every kind of staff login counts (S798): counting till PINs alone read an HR-only or
      // IMS-only client as having none, and the rebuild then named every live Self-Service and
      // count login as one to recreate by hand.
      const { count: existingLogins, error: loginCountErr } = await supabase
        .from('profiles').select('id', { count: 'exact', head: true })
        .eq('client_id', client.id)
        .or('pos_email.not.is.null,hr_self_service.eq.true,ims_email.not.is.null,ims_role.not.is.null,hr_role.not.is.null')
      if (loginCountErr) {
        // Not "run the restore again" (S852): a restore refuses a client that now holds data.
        loginsFailed = true
        note = ' Staff logins were not rebuilt, because the existing logins could not be counted. Open the Users and Staff PINs tabs: if this client has no logins, they need recreating by hand.'
        details.push(errorInfo(loginCountErr, 'operator').detail)
      } else if ((existingLogins || 0) > 0) {
        note = ' Existing staff logins were kept.'
      } else {
        setRestoreMsg('info:Rebuilding staff logins…')
        // Its own catch (S852): a throw here used to drop the whole summary of what the data restore
        // had already put back. It creates logins one by one, so a failure may leave some created.
        let accounts = null
        try {
          accounts = await adminOp('restore_staff_accounts', {
            client_id: client.id,
            roster: parsed.data?.profiles || [],
            vault:  parsed.data?.staff_pin_vault || [],
          })
        } catch (accErr) {
          loginsFailed = true
          note = ' Staff logins could not be confirmed as rebuilt, so some may exist and some may not. Open the Users and Staff PINs tabs to see which came back, and recreate the missing ones by hand.'
          details.push(errorInfo(accErr, 'operator').detail)
        }
        if (accounts) {
          const restoredCount = accounts.restored?.length || 0
          note = restoredCount ? ` ${restoredCount} PIN login${restoredCount !== 1 ? 's' : ''} restored with their original PINs.` : ''
          // A settled leaver's till or count PIN comes back blocked, as their settlement left it (S798),
          // and a till login POS Staff blocked comes back blocked too (S809 3i).
          const blockedBack = (accounts.restored || []).filter(r => /blocked \(settled leaver\)/.test(r.kind))
          if (blockedBack.length) note += ` Restored blocked, as their Final Settlement left them: ${blockedBack.map(r => r.full_name).join(', ')}.`
          const posBlockedBack = (accounts.restored || []).filter(r => /blocked \(POS Staff\)/.test(r.kind))
          if (posBlockedBack.length) note += ` Restored blocked, as POS Staff had blocked them: ${posBlockedBack.map(r => r.full_name).join(', ')}.`
          if (accounts.manual?.length) {
            note += ` ${accounts.manual.length} account${accounts.manual.length !== 1 ? 's' : ''} must be recreated by hand: ` +
              accounts.manual.map(m => `${m.full_name} (${m.kind})`).join(', ') + '.'
          }
        }
      }

      // Deleting the employees and settlements cleared every kept login's link to them, so Crest
      // Staff, leaver blocks, the own-record rules and push notifications all need them put back
      // (S798, DATABASE-1). In every branch — it only fills a link that is empty — and after a full
      // Delete it finds nothing to do.
      const relink = await relinkStaffLogins(parsed.data?.profiles || [])
      note += relink.text
      if (relink.detail) details.push(relink.detail)

      // `renamed` is not a failure and must not read as one: those rows DID restore, under a
      // changed name, because the backup held two items sharing one (S707). Said plainly, with the
      // names, because each is a real pre-existing split someone now has to merge or retire.
      const renamedNote = result.renamed?.length
        ? ` ${result.renamed.length} duplicate item name${result.renamed.length !== 1 ? 's were' : ' was'} restored with a "-DUP" suffix — merge or retire them in Item Master: ${result.renamed.join(', ')}.`
        : ''
      // A restore that left rows behind is not a success, however much else landed (S809 DATABASE-3):
      // it leads with what is missing, in the error colour. `skipped` holds only losses now; the kept
      // feature flags and the tables left out by design are `notes`, which do not change the colour.
      const lost = result.skipped || []
      const lostNote = lost.length
        ? `The restore is NOT complete: ${lost.length} part${lost.length !== 1 ? 's' : ''} did not come back — ${lost.join('; ')}. `
        : ''
      const notesLine = result.notes?.length ? ` ${result.notes.join(' ')}` : ''
      const summary = `${lostNote}Restored ${result.inserted.toLocaleString('en-IN')} rows across ${result.tables} tables.${note}${renamedNote}${notesLine}`
      setRestoreMsg(relink.failed || lost.length || loginsFailed
        ? { text: summary, detail: details.filter(Boolean).join(' · ') }
        : `ok:${summary}`)
      onClientUpdated()
    } catch (err) {
      setRestoreMsg(restoreStopped({ clientName: client.name, stage, started, err }))
    }
    setRestoreBusy(false)
  }

  // ── Danger Zone ──
  // A clear's dialog closes the moment it is confirmed, and the Danger Zone's own "Working…" takes
  // over, as it did behind window.confirm: the backup in front of every clear can run for minutes and
  // may stop to ask whether both files downloaded, which a dialog held busy could neither show nor
  // bound.
  function startDangerAction(work) {
    void work().catch(err => { setDeletingAction(null); setDeleteMsg(dangerUnexpected(client.name, err)) })
  }

  async function handleClearConversions() {
    const { data: withConv, error: convErr } = await scopedFrom('items', client.id, 'id, purchase_qty, rate').not('purchase_unit', 'is', null)
    // A failed read is not "no conversions" (S654): it used to report exactly that.
    if (convErr) { setDeleteMsg('error:Nothing was changed — the items with a conversion could not be read. Try again. ' + errorLine(convErr)); return }
    const count = withConv?.length || 0
    if (count === 0) { setDeleteMsg('ok:No items have a conversion set.'); return }
    askConfirm({
      title: `Clear unit conversions on ${count} item${count !== 1 ? 's' : ''} for ${client.name}?`,
      body: <>
        <p style={{ margin: '0 0 8px' }}>{`Purchase Unit, Base Unit, Conversion Factor and Purchase Qty will be reset to 1 for each affected item. Each item's pack price is rescaled to its price per 1 unit, so per-unit rates — and every stock valuation built on them — are unchanged.`}</p>
        <p style={{ margin: 0 }}><strong>This cannot be undone.</strong></p>
      </>,
      confirmLabel: 'Clear conversions', cancelLabel: 'Keep', danger: true,
      run: () => startDangerAction(() => clearConversionsNow(withConv, count)),
    })
  }

  async function clearConversionsNow(withConv, count) {
    setDeletingAction('conversions'); setDeleteMsg('')
    if (!await preflightBackup('predelete')) { setDeletingAction(null); return }

    // items.per_uom_rate is a GENERATED column = rate / purchase_qty. Resetting purchase_qty to 1
    // while leaving rate untouched multiplies per_uom_rate by the old pack size — a 1 KG bag stored
    // as (purchase_qty 1000, rate 500, per_uom 0.50) would jump to per_uom 500, silently mispricing
    // Stock Count, Variance, COGS, Reorder and the Owner Report at once (phase 7 P0, S574). So rate
    // must be rescaled per item to its old per-unit price in the same write, which forces a per-row
    // update rather than one bulk UPDATE. Chunked to keep a large item master from firing hundreds
    // of parallel requests.
    let failed = 0
    const CHUNK = 10
    for (let i = 0; i < withConv.length; i += CHUNK) {
      const results = await Promise.all(withConv.slice(i, i + CHUNK).map(item => {
        const qty = Number(item.purchase_qty)
        const newRate = (item.rate != null && qty > 0) ? Number(item.rate) / qty : item.rate
        return scopedUpdate('items', client.id, {
          purchase_unit: null, base_unit: null, conversion_factor: 1, purchase_qty: 1, rate: newRate,
        }).eq('id', item.id)
      }))
      failed += results.filter(r => r.error).length
    }
    setDeletingAction(null)
    setDeleteMsg(failed
      ? `error:${failed} of ${count} items could not be updated — their conversions are unchanged. Retry to finish.`
      : `ok:Conversions cleared on ${count} item${count !== 1 ? 's' : ''}. Per-unit rates preserved.`)
  }

  function handleClearModule(module) {
    const labels = {
      // Clear IMS also wipes Fixed Assets, setup included (S834): the register and its categories
      // go with their depreciation, tax-pool and repair rows — admin-user-ops clearModuleData.
      ims: 'IMS transactions (purchases, vendor returns, stock counts, wastage, staff meals, hand-entered sales and their stock movements, budgets, payables, POs, requisitions, gate passes, overheads, demand forecast runs, stock transfers with other outlets)\n\nALSO DELETED: the whole Fixed Assets register and its asset categories, with their depreciation runs, tax pool runs, openings and their corrections, and repair expenses\n\nOTHER OUTLETS: stock transfers with other outlets stay on those outlets\' books.\n\nKEPT: items, vendors, categories, recipes, par levels, periods, and everything the till posted to Inventory (its sales and stock movements stay with its bills)',
      hr:  'HR transactions (attendance, payroll runs, payslips, leave requests, overtime, advances + repayments, festival allowances, roster)\n\nKEPT: employees, salary components, leave types, holiday calendar, shift types',
      pos: 'POS transactions (orders, order items, shifts, customers, and what the till posted to Inventory: its sales entries and stock movements)\n\nKEPT: tables, floor plan, staff accounts + PINs, and hand-entered sales with their stock movements. Occupied tables are freed.\n\nAFTERWARDS: the hand-entered sales days the till also covered get their stock re-counted, because it was skipped while the till covered them. Other days are left as they were saved.',
    }
    const name = module.toUpperCase()
    // One paragraph per block; a block that opens with a capitalised heading ("KEPT:") shows it bold.
    const [deletes, ...rest] = labels[module].split('\n\n')
    askConfirm({
      title: `Clear ${name} transactions for ${client.name}?`,
      body: <>
        <p style={{ margin: '0 0 8px' }}><strong>This deletes:</strong> {deletes}</p>
        {rest.map(block => {
          const [, head, text] = block.match(/^([A-Z ]+:)\s*([\s\S]*)$/) || [null, null, block]
          return <p key={block} style={{ margin: '0 0 8px' }}>{head ? <><strong>{head}</strong> {text}</> : text}</p>
        })}
        <p style={{ margin: 0 }}><strong>This cannot be undone.</strong></p>
      </>,
      confirmLabel: `Clear ${name} data`, cancelLabel: 'Keep', danger: true,
      run: () => startDangerAction(() => clearModuleNow(module)),
    })
  }

  async function clearModuleNow(module) {
    setDeletingAction(module)
    setDeleteMsg('')
    try {
      if (!await preflightBackup('predelete')) { setDeletingAction(null); return }
      // Clear POS reads which hand-entered days the till covered first, right before the clear,
      // because the till rows that decide it are what the clear deletes (S835). A failed read stops
      // the clear: those days could not be re-counted afterwards.
      let covered = null
      if (module === 'pos') {
        covered = await readTillCoveredDays()
        if (covered.refusal) { setDeleteMsg(covered.refusal); setDeletingAction(null); return }
      }
      await adminOp('clearModuleData', { clientId: client.id, module })
      if (module === 'pos') setDeleteMsg(await recountAfterClearPos(covered))
      else setDeleteMsg(module === 'ims'
        ? 'ok:IMS transactions and the Fixed Assets register cleared. Other setup data was kept.'
        : `ok:${module.toUpperCase()} transactions cleared. Setup data was kept.`)
    } catch (err) {
      const name = module.toUpperCase()
      setDeleteMsg(clearStopped({
        what: `the ${name} transactions of ${client.name}`,
        button: `Clear ${name} Transactions`,
        kept: `Setup data is kept.${module === 'pos' ? ' The stock re-count of hand-entered sales days did not run.' : ''}`,
        err,
      }))
    }
    setDeletingAction(null)
  }

  // Clear POS takes the till's sales rows and stock movements away, and with them the reason Sales
  // Entry skipped stock for the hand-entered days the till had covered (S835, owner decision). Those
  // days would read as consuming nothing until someone re-saved them, so they, and only they, are
  // re-counted straight after the clear, through Sales Entry's own re-post path; a day the till
  // never covered keeps the figures it was saved with. Which days is read here, BEFORE the clear,
  // with the write path's own rule (findTillCoveredManualDays). Months by `scopedFrom` with this
  // client's id, as every other read on this drawer: the operator is acting on another client.
  // → { jobs, periodById }, or { refusal } (the message) when a read failed.
  async function readTillCoveredDays() {
    const refuse = err => ({
      refusal: `error:POS transactions were NOT cleared and nothing was deleted: Crest could not read which hand-entered sales days the till covers. Their stock has to be re-counted once the till's rows are gone, so the clear does not start without that list. Try again. ${errorLine(err)}`,
    })
    try {
      const { data: periods, error } = await settleWithin(scopedFrom('monthly_periods', client.id, 'id, bs_year, bs_month'), SAVE_TIMEOUT_MS, 'Reading the months')
      if (error) return refuse(error)
      const periodById = new Map((periods || []).map(p => [p.id, p]))
      const { data: jobs, error: coverErr } = await findTillCoveredManualDays(supabase, { periodIds: [...periodById.keys()] })
      if (coverErr) return refuse(coverErr)
      return { jobs, periodById }
    } catch (err) {
      return refuse(err)
    }
  }

  // After the clear: re-count the covered days, and say how many were or which were not confirmed.
  // It never throws: the clear has already happened, and a failure here must not read as the clear
  // failing.
  async function recountAfterClearPos({ jobs, periodById }) {
    const cleared = 'POS transactions cleared. Setup data was kept.'
    const redo = 'In Sales Entry, save each of those again without changing anything: saving rebuilds its stock.'
    try {
      const res = await recountManualSalesDays(supabase, { clientId: client.id, jobs })
      const count = list => list.reduce((n, j) => n + j.days.length, 0)
      const done = count(res.recounted)
      const doneText = done
        ? `Stock was re-counted for ${done} hand-entered sales day${done !== 1 ? 's' : ''} the till had covered, now that the till no longer covers them.`
        : 'No hand-entered sales day was covered by the till, so none needed its stock re-counted.'
      if (!res.left.length) return `ok:${cleared} ${doneText}`
      const left = count(res.left)
      return `error:${cleared} ${done ? doneText + ' ' : ''}The stock of ${left} hand-entered day${left !== 1 ? 's' : ''} could not be confirmed as re-counted — ${recountLeftText(res.left, periodById)}. ${redo}`
    } catch (err) {
      return `error:${cleared} The stock of these hand-entered days may not have been re-counted — ${recountLeftText(jobs, periodById)}. ${redo} ${errorLine(err)}`
    }
  }

  // Confirmation happens in the typed-name modal (confirmAction) before this is called.
  async function handleDeleteClientData() {
    setDeletingAction('clientData')
    setDeleteMsg('')
    try {
      if (!await preflightBackup('predelete')) { setDeletingAction(null); return }
      await adminOp('deleteClientData', { clientId: client.id })
      setDeleteMsg('ok:All client data has been permanently erased.')
    } catch (err) {
      setDeleteMsg(clearStopped({
        what: `the data of ${client.name}`,
        button: 'Clear Client Data',
        kept: 'Logins, settings and the client record are kept.',
        err,
      }))
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
  // Confirmation happens in the typed-name modal (confirmAction) before this is called.
  async function handleArchiveClient() {
    setDeletingAction('archive')
    setDeleteMsg('')
    try {
      if (!await preflightBackup('archive')) { setDeletingAction(null); return }
      // keep_staff_vault: Archive keeps every login, and the PIN vault rows belong to those
      // logins — deleting them made "fully reversible" false: the Staff PINs tab showed "Not
      // stored" forever, and the restore's vault-rebuild branch is gated shut whenever logins
      // exist, which after an Archive they always do (phase 7 P1, S574).
      // Two steps, two messages (S852): a clear that stops leaves the account unlocked, and a lock
      // that does not confirm leaves an emptied outlet its logins may still sign in to.
      try {
        await adminOp('deleteClientData', { clientId: client.id, keep_staff_vault: true })
      } catch (err) {
        setDeleteMsg(clearStopped({
          what: `the data of ${client.name}`,
          prefix: 'Archive did not finish. ',
          button: 'Archive Client',
          kept: 'The account is not locked yet, and its logins and settings are kept.',
          err,
        }))
        setDeletingAction(null)
        return
      }
      const { error } = await supabase.from('clients').update({ is_active: false }).eq('id', client.id)
      if (error) {
        setDeleteMsg(archiveLockFailed(client.name, error))
        setDeletingAction(null)
        onClientUpdated()
        return
      }
      setDeleteMsg('ok:Client archived — data cleared, logins kept, account locked. Restore the backup to reverse this.')
      onClientUpdated()
    } catch (err) {
      setDeleteMsg(dangerUnexpected(client.name, err))
    }
    setDeletingAction(null)
  }

  // Confirmation happens in the typed-name modal (confirmAction) before this is called.
  async function handleDeleteClient() {
    setDeletingAction('deleteClient')
    setDeleteMsg('')
    try {
      // Must run before the auth users go — the backup's account roster is read from `profiles`,
      // and this sequence deletes those first.
      if (!await preflightBackup('predelete')) { setDeletingAction(null); return }

      // Delete all user auth accounts for this client — collecting failures instead of aborting
      // on the first. Deleted auth users are gone for good, so a mid-loop throw used to leave a
      // half-deleted client (some logins gone, all data intact, raw upstream error, no statement
      // of what did or didn't happen). Now every user is attempted, and on any failure we stop
      // BEFORE touching data, so the client is still whole and the retry is safe (phase 7 P0, S574).
      const { data: profiles, error: profilesErr } = await supabase.from('profiles').select('id, full_name').eq('client_id', client.id)
      // A failed read is not a client with no logins (S852). The loop below then removed nobody, the
      // data was cleared anyway, and the final clients delete was refused by the profiles foreign key
      // under a message saying every login had gone. Stop here, before the first delete.
      if (profilesErr) {
        setDeleteMsg(withDetail(`Could not read the logins of ${client.name}, so nothing was deleted: every login and all of its data are as they were. Press Delete Client again.`, profilesErr))
        setDeletingAction(null)
        return
      }
      const userFailures = []
      for (const p of (profiles || [])) {
        try {
          await adminOp('deleteUser', { userId: p.id })
        } catch (err) {
          userFailures.push({ name: p.full_name || p.id, err })
        }
      }
      if (userFailures.length) {
        const done = (profiles?.length || 0) - userFailures.length
        setDeleteMsg(loginsStopped(client.name, done, profiles.length, userFailures))
        setDeletingAction(null)
        return
      }

      // Delete operational data, settings, feature flags, then the client record — each step
      // named, so a failure states exactly how far the sequence got instead of surfacing a bare
      // upstream string against an unknown amount of damage.
      let stage = 'operational data'
      try {
        await adminOp('deleteClientData', { clientId: client.id })
        stage = 'settings'
        const { error: setErr } = await supabase.from('settings').delete().eq('client_id', client.id)
        if (setErr) throw setErr
        stage = 'feature flags'
        const { error: ffErr } = await scopedDelete('feature_flags', client.id)
        if (ffErr) throw ffErr
        stage = 'the client record'
        const { error: cliErr } = await supabase.from('clients').delete().eq('id', client.id)
        if (cliErr) throw cliErr
      } catch (err) {
        // The last step refused (S835): its data was cleared, but rows still pointing at the client
        // were left behind — written after the clear, or in a table the clear does not reach — so
        // the record stays. The message names the table when the refusal does, and keeps the
        // technical text as the fine print under it (S852: it was in brackets in the sentence).
        // Only a refusal says so: a dropped connection proves nothing about rows, so it keeps the
        // general message (deleteStageFailed), which leads with what each stage left behind.
        const table = stage === 'the client record' ? blockingTableOf(err) : null
        if (stage === 'the client record' && (err?.code === '23503' || table)) {
          const { detail } = errorInfo(err, 'operator')
          setDeleteMsg({
            text: `All logins were removed and the data of ${client.name} was cleared, but some of its rows were left behind${table ? ` in ${table}` : ''}, so the client record itself was not deleted and still exists. Press Delete Client again: it clears what was left and then deletes the record. If it stops on the same table again, Delete does not clear that table and it needs fixing before this client can be deleted. ${KEEP_BACKUP}`,
            detail,
          })
        } else {
          setDeleteMsg(deleteStageFailed(client.name, stage, err))
        }
        setDeletingAction(null)
        onClientUpdated()
        return
      }
      onClientUpdated()
      onClose()
    } catch (err) {
      setDeleteMsg(dangerUnexpected(client.name, err))
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
    // Versioned, because `upsert: true` writes to the same path and getPublicUrl() returns the same
    // URL for it, so a replacement went on serving the previous image out of cache for an hour.
    await writeLogoUrl(`${publicUrl}?v=${Date.now()}`, 'Logo saved.')
    setLogoUploading(false)
  }

  async function handleLogoRemove() {
    await writeLogoUrl(null, 'Logo removed.')
  }

  // One column, and the result is read. Both handlers used to `await saveClientSettings(...)` with
  // no catch, and it THROWS on a failed write: an RLS refusal or a dropped connection left
  // "Uploading..." on the button for good, reported nothing, and on the upload path never reached
  // setLogoUploading(false). They also sent the whole row (see DRAWER_SETTINGS_FIELDS above).
  async function writeLogoUrl(url, okMsg) {
    const previous = clientSettings.logo_url
    setClientSettings(prev => ({ ...prev, logo_url: url }))
    setLogoMsg('')
    try {
      await saveClientSettings(client.id, { logo_url: url })
      setLogoMsg('ok:' + okMsg)
    } catch (e) {
      // Put the preview back: it showed the new state while the row still held the old one.
      setClientSettings(prev => ({ ...prev, logo_url: previous }))
      setLogoMsg('error:' + (url === null
        ? 'The logo is still in place, the change did not save. '
        : 'The file uploaded, but the row still points at the old logo. ') + errorLine(e))
    }
  }

  const tabs = [
    { key: 'users',      label: 'Users' },
    { key: 'pins',       label: 'Staff PINs' },
    { key: 'billing',    label: 'Billing' },
    { key: 'settings',   label: 'Settings' },
    { key: 'qr',         label: 'QR' },
    { key: 'data',       label: 'Backup' },
    { key: 'legal',      label: 'Legal' },
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

  // What the three settings tabs render instead of a form when the read failed — see
  // fetchClientSettings. One element, three tabs.
  const settingsErrorEl = settingsLoadErr && (
    <div>
      <ActionError error={{ ...settingsLoadErr, text: `This client's settings could not be read, so the form is not shown — saving it would have written blanks over their real values. ${settingsLoadErr.text}` }} />
      <button className="btn btn-ghost" style={{ fontSize: 12, marginTop: 12 }} onClick={fetchClientSettings}>Retry</button>
    </div>
  )

  // The client name + plan badge, handed to Modal as its title so the shared header row
  // (title left, × right) stays the one implementation.
  const modalTitle = (
    <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--theme-text1)' }}>
        {client.name}
      </span>
      <span style={{ fontSize: 12, color: 'var(--theme-text3)', fontWeight: 400 }}>
        {client.location || 'No location'}
      </span>
      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--radius-full)',
        color: client.plan === 'pro' ? 'var(--theme-accent-ink)' : client.plan === 'growth' ? 'var(--theme-green-text)' : 'var(--theme-text2)',
        background: client.plan === 'pro' ? 'color-mix(in srgb, var(--theme-accent) 12%, transparent)' : client.plan === 'growth' ? 'color-mix(in srgb, var(--theme-green) 10%, transparent)' : 'color-mix(in srgb, var(--theme-text2) 10%, transparent)',
        border: `1px solid ${client.plan === 'pro' ? 'color-mix(in srgb, var(--theme-accent) 25%, transparent)' : client.plan === 'growth' ? 'color-mix(in srgb, var(--theme-green) 20%, transparent)' : 'color-mix(in srgb, var(--theme-text2) 25%, transparent)'}`,
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
                    style={{ fontSize: 12, margin: '0 0 8px', color: clientMsg.startsWith('ok:') ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
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
                <ActionError error={userError} className="action-error--top" />
                {userSuccess && <p role="status" style={{ color: 'var(--theme-green-text)', fontSize: 12, margin: '0 0 8px' }}>{userSuccess}</p>}
                <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={createUser} disabled={savingUser}>
                  {savingUser ? 'Creating…' : '+ Create User'}
                </button>
              </div>

              {/* Existing users */}
              <div style={{ borderTop: '1px solid var(--theme-border)', paddingTop: 20 }}>
                <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>
                  Existing Users {loadingUsers ? '— Loading…' : `(${users.length})`}
                </p>
                {usersLoadErr && (
                  <div>
                    <ActionError error={usersLoadErr} />
                    <button className="btn btn-ghost" style={{ fontSize: 12, marginTop: 10 }} onClick={loadUsers}>Retry</button>
                  </div>
                )}
                {!loadingUsers && !usersLoadErr && users.length === 0 && (
                  <p style={{ fontSize: 13, color: 'var(--theme-text3)' }}>No users yet for this client.</p>
                )}
                {!loadingUsers && !usersLoadErr && users.map(u => (
                  <div key={u.id} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '10px 0', borderBottom: '1px solid var(--theme-border)'
                  }}>
                    <div>
                      <span style={{ fontSize: 13, color: 'var(--theme-text1)', fontWeight: 600 }}>{u.full_name || '—'}</span>
                      <span style={{ fontSize: 12, color: 'var(--theme-text2)', marginLeft: 8 }}>{u.email}</span>
                      <span style={{ fontSize: 11, color: 'var(--theme-accent-ink)', marginLeft: 8, background: 'var(--theme-focus-ring)', padding: '2px 8px', borderRadius: 'var(--radius-sm)' }}>
                        {u.role}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn btn-ghost"
                        style={{ fontSize: 11, padding: '6px 12px' }}
                        onClick={() => { setResetPw(''); setUserError(''); setResetUser(u) }}
                        aria-label={`Reset password for ${u.full_name || u.email}`}
                      >Reset password</button>
                      <button
                        className="btn btn-danger btn-sm"
                        style={{ fontSize: 11, padding: '6px 12px' }}
                        onClick={() => deleteUser(u)}
                        aria-label={`Delete ${u.full_name || u.email}`}
                      >Delete</button>
                    </div>
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

              <ActionError error={pinErr} className="action-error--top" />

              {loadingPins ? (
                <p style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Loading…</p>
              ) : pinsLoadFailed ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={loadPinAccounts}>Retry</button>
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
                          <td><span className="badge badge-yellow">{a.kind}</span></td>
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
                {/* Save-scope line: this tab holds four different save semantics at once (module
                    toggles and outlet group save instantly; plan, dates, billing cycle and Suite
                    wait for Save Subscription) and nothing on screen said which was which —
                    only two source comments did (phase 7 IA finding, S574). */}
                <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '0 0 16px' }}>
                  Module and outlet-group changes save immediately. Plan, dates, billing cycle and Suite save with the “Save Subscription” button at the bottom.
                </p>
                {/* ── Modules ── */}
                <div style={{ marginBottom: 24 }}>
                  <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>
                    Modules
                  </p>
                  {/* S849 (ACCESS-4): what the gate will do with the values on screen, through
                      suiteState() — the one predicate the Suite pages, the MRR and the export read. */}
                  {suitePlan === 'pro' && (() => {
                    const ss = suiteState({ suite_plan: suitePlan, ims_enabled: imsEnabled, suite_ends_at: suiteEndsAt || null, ims_ends_at: imsEndsAt || null, subscription_ends_at: client.subscription_ends_at })
                    return (
                      <p style={{ fontSize: 11, color: ss.live ? 'var(--theme-text3)' : 'var(--theme-amber-text)', margin: '0 0 12px' }}>
                        {!ss.imsOn
                          ? 'Crest Suite Pro is switched on, but Crest IMS is off, so every Suite page is closed and Suite is not billed.'
                          : ss.lapsed
                            ? 'Crest Suite Pro is switched on, but its end date passed more than 7 days ago, so its pages are closed and it is not billed.'
                            : `Crest Suite Pro is active${ss.inGrace ? ' (in its 7-day grace)' : ''}. It sits on top of these modules rather than including them, so each stays individually toggleable — only Crest IMS is required.`}
                      </p>
                    )
                  })()}
                  {[
                    // S849: Crest's own demo or practice outlet. First, because it decides whether
                    // everything below is income at all.
                    { key: 'internal', label: 'Demo outlet, not a customer', sub: 'Never counted as income; sent to HSS as not billable',
                      tip: "Crest's own demo or practice outlet. Works like any outlet; never counted as income and sent to HSS as not billable.",
                      enabled: isInternal, toggle: handleToggleInternal },
                    { key: 'ims', label: 'Crest IMS', sub: 'Inventory Management', enabled: imsEnabled, toggle: handleToggleIms,
                      // S831 5f-3 (owner Q31 a): for a till outlet, Inventory starts the day it is switched
                      // on, and every switch-on starts it again (clients.ims_since, stamped by the database).
                      note: !posEnabled ? null
                        : !imsEnabled ? 'Switching it on starts Inventory that day: till bills from before then stay in the POS reports and are never sent to Inventory.'
                        : client.ims_since ? `Inventory since ${nepalBsLong(client.ims_since) || 'the day it was switched on'}: till bills from before then are never sent to Inventory. Switching it off and on again starts it again.`
                        : null },
                    { key: 'hr',  label: 'Crest HR',  sub: 'Human Resources',      enabled: hrEnabled,  toggle: handleToggleHr  },
                    { key: 'pos', label: 'Crest POS', sub: 'Point of Sale',        enabled: posEnabled, toggle: handleTogglePos  },
                    // An add-on on POS: the switch is inert until POS is on, and says why.
                    { key: 'customization', label: 'Crest Customization', sub: posEnabled ? 'Meal customization — sizes, add-ons, spice' : 'Needs Crest POS on first',
                      enabled: customizationEnabled, toggle: handleToggleCustomization, disabled: !posEnabled },
                  ].map(mod => (
                    <div key={mod.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--theme-border-lt)' }}>
                      <div>
                        <p style={{ margin: '0 0 1px', fontSize: 13, fontWeight: 700, color: mod.enabled ? 'var(--theme-text1)' : 'var(--theme-text3)' }}>
                          {mod.tip ? <Tip text={mod.tip} width={280}>{mod.label}</Tip> : mod.label}
                        </p>
                        <p style={{ margin: 0, fontSize: 11, color: 'var(--theme-text2)' }}>{mod.sub}</p>
                        {mod.note && <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--theme-text2)', maxWidth: 520 }}>{mod.note}</p>}
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
                        disabled={mod.disabled || false}
                        onClick={mod.toggle}
                        style={{
                          position: 'relative', width: 38, height: 22, padding: 0,
                          borderRadius: 'var(--radius-full)', flexShrink: 0,
                          cursor: 'pointer',
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

                {/* Crest Suite Pro — one SKU, on or off. It used to be a three-tier bundle that
                    CONTAINED IMS+HR+POS; it is now an add-on priced on top of whichever modules
                    the client bought, so it neither implies HR/POS nor dictates the IMS tier.
                    Only IMS is implied — SuiteGate's requireModules floor. */}
                <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 8px' }}>
                  <Tip text={`The owner layer — ${suitePagesText()}. Priced per outlet on top of this client's modules, not instead of them. Requires Crest IMS; Owner Dashboard also needs Crest HR. Switching Crest IMS off takes Suite off with it.`} width={300}>
                    Crest Suite Pro
                  </Tip>
                </p>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  {[{ on: false, label: 'Not Subscribed' }, { on: true, label: 'Crest Suite Pro' }].map(opt => {
                    const active = (suitePlan === 'pro') === opt.on
                    return (
                      <button key={String(opt.on)} type="button" aria-pressed={active} onClick={() => handleSuiteToggle(opt.on)} style={{
                        padding: '8px 14px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 700, lineHeight: 1.4,
                        border: active ? '1px solid var(--theme-accent)' : '1px solid var(--theme-border)',
                        background: active ? 'var(--theme-focus-ring)' : 'none',
                        color: active ? 'var(--theme-accent-ink)' : 'var(--theme-text3)',
                      }}>
                        <div>{opt.label}</div>
                        {opt.on && (
                          <div style={{ fontSize: 10, fontWeight: 400, marginTop: 2, opacity: 0.85 }}>
                            +NPR {(billingCycle === 'annual' ? pricing.suite.annual : pricing.suite.monthly).toLocaleString('en-IN')}/mo
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>
                {/* Was color:'#fff' — every light preset has card:#ffffff, so this line was white
                    on white and literally invisible on five of the ten themes. */}
                <p style={{ fontSize: 11, color: 'var(--theme-text2)', margin: '0 0 24px' }}>
                  Added on top of the module pricing below — it does not replace it.
                </p>

                {/* Outlet group — structural, so it saves instantly like the module toggles
                    rather than waiting for Save Subscription. Suite Pro is priced per outlet, so
                    grouping does not change what this client pays; it only lets one owner login
                    switch between outlets and roll them up in the Group Console. */}
                <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 8px' }}>
                  <Tip text="Links this outlet to others under the same owner. An Owner login can then switch between them from the sidebar, and the Group Console rolls up every outlet that has Crest Suite Pro. Each outlet still pays for its own modules and its own Suite Pro." width={300}>
                    Outlet Group
                  </Tip>
                </p>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <select aria-label="Outlet group"
                    className="form-select"
                    style={{ maxWidth: 240 }}
                    value={groupId || ''}
                    onChange={e => handleGroupChange(e.target.value || null)}
                    disabled={savingGroup}
                  >
                    <option value="">No group (single outlet)</option>
                    {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                  <label htmlFor="new-group-name" className="sr-only">New group name</label>
                  {/* Was a bare <input> with no class and no .form-field ancestor, so it picked up
                      none of the theme and rendered as a native white box beside the themed
                      <select> next to it — the mismatch is only visible on the dark presets, which
                      is why it survived review. */}
                  <input
                    id="new-group-name"
                    className="form-input"
                    value={newGroupName}
                    onChange={e => setNewGroupName(e.target.value)}
                    placeholder="or create a new group…"
                    style={{ maxWidth: 200 }}
                  />
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 11 }}
                    disabled={savingGroup || !newGroupName.trim()}
                    onClick={handleCreateGroup}
                  >
                    Create & Assign
                  </button>
                </div>
                {/* S849 (GROUP-1): the group's HQ, from its own outlets only. Saves instantly. */}
                {groupId && (() => {
                  const g = groups.find(x => x.id === groupId)
                  const hq = g?.hq_client_id || ''
                  const hqListed = !hq || groupMembers.some(m => m.id === hq)
                  return (
                    <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <label htmlFor="group-hq-outlet" style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                        <Tip text="The outlet whose items, recipes and prices Push to branches copies. Only an outlet in this group can be HQ.">HQ outlet</Tip>
                      </label>
                      <select id="group-hq-outlet"
                        className="form-select"
                        style={{ maxWidth: 240 }}
                        value={hqListed ? hq : ''}
                        onChange={e => handleHqChange(e.target.value || null)}
                        disabled={savingHq || savingGroup || !g}
                      >
                        <option value="">No HQ (master push off)</option>
                        {groupMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </div>
                  )
                })()}
                <p style={{ fontSize: 11, color: 'var(--theme-text2)', margin: '0 0 24px' }}>
                  {groupId
                    ? 'Changing or clearing the group asks first, names whose Owners gain or lose this outlet, and signs every affected user back into their own outlet.'
                    : 'Leave as “No group” for a single-outlet client — nothing about their app changes.'}
                </p>

                {/* Crest Suite Pro expiry — its own renewal schedule, independent of any single
                    module's end date (borrowing IMS's date as a proxy elsewhere is a fallback
                    for pre-migration clients only, not a substitute for tracking this directly). */}
                {suitePlan && (() => {
                  // S849 (ACCESS-4 / SU12): a Suite with no date says so instead of showing no badge.
                  const s = suiteEndsAt ? getDateStatus(suiteEndsAt)
                    : { label: 'No end date', color: 'var(--theme-text2)', bg: 'color-mix(in srgb, var(--theme-text2) 12%, var(--theme-card))', border: 'color-mix(in srgb, var(--theme-text2) 30%, transparent)' }
                  return (
                    <div style={{ marginBottom: 24, paddingBottom: 24, borderBottom: '1px solid var(--theme-border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                        <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: 'var(--theme-accent-ink)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Crest Suite Pro</p>
                        {s.label && (
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 'var(--radius-sm)', color: s.color, background: s.bg, border: `1px solid ${s.border}` }}>
                            {s.label}
                          </span>
                        )}
                      </div>
                      <p style={{ fontSize: 11, color: 'var(--theme-text2)', margin: '0 0 6px' }}>
                        <Tip text={`Date this client's Crest Suite Pro ends, independent of the module dates above. Left blank, Suite stays open while it is switched on and bills from the IMS date if there is one; with no IMS date either it is not billed, and the client list marks it 'no end date'. Seven days after the date passes, ${suitePagesText()} close. It never keeps the outlet itself open: the account lock follows the IMS, HR and POS dates.`} width={320}>Suite subscription end date</Tip>
                      </p>
                      <div style={{ marginBottom: 8 }}>
                        <BsCalendarPicker value={suiteEndsAt} onChange={setSuiteEndsAt} clearable />
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {[{ label: '+7 Days', days: 7 }, { label: '+1 Month', days: 30 }, { label: '+3 Months', days: 90 }, { label: '+1 Year', days: 365 }].map(({ label, days }) => (
                          <button key={label} className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => extendModule(suiteEndsAt, setSuiteEndsAt, days)}>{label}</button>
                        ))}
                        {suiteEndsAt && (
                          <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 25%, transparent)', marginLeft: 'auto' }} onClick={() => setSuiteEndsAt('')}>Clear</button>
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
                        color: on ? 'var(--theme-accent-ink)' : 'var(--theme-text3)',
                        transition: 'background var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard)',
                      }}>{opt.label}</button>
                    )
                  })}
                </div>

                {/* Per-module subscription sections */}
                {[
                  // Only IMS has a tier picker; HR/POS render a flat price box (see flatPricing
                  // below), so plan/setPlan were only ever read on the IMS row.
                  { key: 'ims', label: 'Crest IMS', enabled: imsEnabled, plan: currentPlan, setPlan: setCurrentPlan, endsAt: imsEndsAt, setEndsAt: setImsEndsAt },
                  { key: 'hr',  label: 'Crest HR',  enabled: hrEnabled,  plan: null, setPlan: null, endsAt: hrEndsAt,  setEndsAt: setHrEndsAt  },
                  { key: 'pos', label: 'Crest POS', enabled: posEnabled, plan: null, setPlan: null, endsAt: posEndsAt, setEndsAt: setPosEndsAt },
                  { key: 'customization', label: 'Crest Customization', enabled: posEnabled && customizationEnabled, plan: null, setPlan: null, endsAt: customizationEndsAt, setEndsAt: setCustomizationEndsAt },
                ].map(mod => {
                  if (!mod.enabled) return null
                  const s = getDateStatus(mod.endsAt)
                  const flatPricing = mod.key === 'hr' ? pricing.hr : mod.key === 'pos' ? pricing.pos : mod.key === 'customization' ? pricing.customization : null
                  const accentInk  = MODULE_INK[mod.key]
                  // These sections used to be disabled whenever a Suite Bundle was selected,
                  // because the bundle replaced per-module pricing and dates entirely in
                  // clientMRR. Crest Suite Pro is additive now — the module prices and end dates
                  // below are still exactly what the client pays — so they stay editable.
                  return (
                    <div key={mod.key} style={{ marginBottom: 24, paddingBottom: 24, borderBottom: '1px solid var(--theme-border)' }}>
                      {/* Header */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                        <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: accentInk, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{mod.label}</p>
                        {s.label && (
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 'var(--radius-sm)', color: s.color, background: s.bg, border: `1px solid ${s.border}` }}>
                            {s.label}
                          </span>
                        )}
                      </div>
                      {flatPricing ? (
                        /* HR/POS — flat single price, no tier picker. Both are yes/no modules;
                           the hr_plan/pos_plan columns are vestigial and no longer read or
                           written anywhere (they used to gate the POS suggestion engine and to
                           silently raise the IMS tier). */
                        <div style={{ padding: '10px 12px', borderRadius: 'var(--radius-md)', border: `1px solid ${moduleTint(mod.key, 25)}`, background: moduleTint(mod.key, 7), marginBottom: 12 }}>
                          <div style={{ fontSize: 15, fontWeight: 700, color: accentInk }}>
                            NPR {(billingCycle === 'annual' ? flatPricing.annual : flatPricing.monthly).toLocaleString('en-IN')}/mo
                          </div>
                          {billingCycle === 'annual' && (
                            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 2 }}>
                              NPR {flatPricing.annual.toLocaleString('en-IN')}/mo × 12 = NPR {(flatPricing.annual * 12).toLocaleString('en-IN')}/yr
                            </div>
                          )}
                        </div>
                      ) : (
                        <>
                          {/* Plan cards — IMS only, real tiers */}
                          <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                            {pricing.imsTiers.map(p => {
                              const price = billingCycle === 'annual' ? p.annual : p.monthly
                              const active = mod.plan === p.key
                              return (
                                <button key={p.key} type="button" aria-pressed={active} onClick={() => mod.setPlan(p.key)} style={{
                                  flex: '1 1 120px', padding: '8px 6px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 700, lineHeight: 1.4,
                                  border: active ? `1px solid ${MODULE_COLORS.ims}` : '1px solid var(--theme-border)',
                                  background: active ? moduleTint('ims', 10) : 'none',
                                  color: active ? MODULE_INK.ims : 'var(--theme-text3)',
                                }}>
                                  <div>{p.label}</div>
                                  <div style={{ fontSize: 10, fontWeight: 400, marginTop: 2, opacity: 0.85 }}>NPR {price.toLocaleString('en-IN')}/mo</div>
                                </button>
                              )
                            })}
                          </div>
                          <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '0 0 12px' }}>
                            {(() => {
                              const tier = pricing.imsTiers.find(p => p.key === mod.plan) || pricing.imsTiers[0]
                              return billingCycle === 'annual'
                                ? `Annual · NPR ${tier.annual.toLocaleString('en-IN')}/mo × 12 = NPR ${(tier.annual * 12).toLocaleString('en-IN')}/yr`
                                : `Monthly · NPR ${tier.monthly.toLocaleString('en-IN')}/mo`
                            })()}
                          </p>
                        </>
                      )}
                      {/* Date picker */}
                      <p style={{ fontSize: 11, color: 'var(--theme-text2)', margin: '0 0 6px' }}>
                        <Tip text="Date when this module's subscription expires. Client sees a warning in the last 7 days and is blocked after expiry." width={300}>Subscription end date</Tip>
                      </p>
                      <div style={{ marginBottom: 8 }}>
                        <BsCalendarPicker value={mod.endsAt} onChange={mod.setEndsAt} clearable />
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {[{ label: '+7 Days', days: 7 }, { label: '+1 Month', days: 30 }, { label: '+3 Months', days: 90 }, { label: '+1 Year', days: 365 }].map(({ label, days }) => (
                          <button key={label} className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => extendModule(mod.endsAt, mod.setEndsAt, days)}>{label}</button>
                        ))}
                        {mod.endsAt && (
                          <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 25%, transparent)', marginLeft: 'auto' }} onClick={() => mod.setEndsAt('')}>Clear</button>
                        )}
                      </div>
                    </div>
                  )
                })}

                {subMsg && (
                  <p role={subMsg.startsWith('ok:') ? 'status' : 'alert'}
                    style={{ fontSize: 12, margin: '0 0 12px', color: subMsg.startsWith('ok:') ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
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
              {settingsLoadErr ? settingsErrorEl : loadingSettings ? (
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
                        : <span aria-hidden="true" style={{ fontSize: 24, color: 'var(--theme-accent-ink)' }}>⬢</span>
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
                      {logoMsg && <p role={logoMsg.startsWith('ok') ? 'status' : 'alert'} style={{ fontSize: 11, margin: '6px 0 0', color: logoMsg.startsWith('error') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>{logoMsg.replace(/^(ok|error):/, '')}</p>}
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
                      <label htmlFor={fid('s-vatreg')} className="form-check">
                        <input id={fid('s-vatreg')} type="checkbox" checked={clientSettings.is_vat_registered ?? true}
                          onChange={e => setClientSettings({ ...clientSettings, is_vat_registered: e.target.checked })} />
                        <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{(clientSettings.is_vat_registered ?? true) ? 'Yes — issues Tax Invoices' : 'No — PAN Bill only'}</span>
                      </label>
                    </div>
                    <div className="form-field">
                      <label htmlFor={fid('s-prefix')}><Tip text="Short client code used in POS invoice numbers, e.g. TI2238-CAC-82/83. Left blank, bills print without one. Setting or changing it re-numbers every bill already issued, because the number is assembled when a bill is printed — a save asks first.">Invoice Prefix</Tip></label>
                      <input id={fid('s-prefix')} value={clientSettings.invoice_prefix || ''} onChange={e => setClientSettings({ ...clientSettings, invoice_prefix: e.target.value.toUpperCase() })} placeholder="Your Business Code" />
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
                    This Client's Consultant
                  </p>
                  <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 14px' }}>
                    Optional. When set, it replaces the Crest support line for this client on the upgrade
                    prompts, the lock screen and Help &rarr; Support. The same three fields appear on
                    Settings &rarr; Support: this is the same data, not a second copy.
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
                      style={{ fontSize: 12, margin: '0 0 12px', color: settingsMsg.startsWith('ok:') ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
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

          {/* ── QR TAB ── */}
          {activeTab === 'qr' && (
            <div>
              {settingsLoadErr ? settingsErrorEl : loadingSettings ? (
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
                          <p id={fid('qr-status')} role="status" style={{ fontSize: 12, color: 'var(--theme-green-text)', margin: '0 0 4px', fontWeight: 600 }}>✓ Valid payment QR — merchant: {qrCheck.merchantName}</p>
                          {qrCheck.network && (
                            <p style={{ fontSize: 11, color: qrCheck.network === 'NepalPay/NCHL' ? 'var(--theme-amber-text)' : 'var(--theme-text2)', margin: '0 0 4px', fontWeight: 600 }}>
                              {qrCheck.network === 'NepalPay/NCHL'
                                ? '⚠ Looks like a NepalPay/NCHL QR — eSewa\'s app refuses these ("scan Fonepay Business QR"), though bank apps accept them. For wider coverage, paste the merchant\'s FonePay Business QR here instead.'
                                : `Looks like a ${qrCheck.network} QR.`}
                            </p>
                          )}
                          <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: 0, maxWidth: 420, lineHeight: 1.6 }}>
                            Scan this preview with a banking app to test it before saving. Once saved, every POS bill shows a dynamic
                            version of this QR with that bill's exact amount pre-filled.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <p id={fid('qr-status')} role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)', margin: '8px 0 0' }}>✗ {qrCheck.error}</p>
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
                      className="form-input"
                      value={webhookSecret}
                      onChange={e => setWebhookSecret(e.target.value)}
                      placeholder="blank = auto-confirmation disabled for this client"
                      style={{ flex: 1, fontSize: 12, fontFamily: 'monospace' }}
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
                      style={{ fontSize: 12, margin: '16px 0 12px', color: settingsMsg.startsWith('ok:') ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
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
                    <div style={{ fontSize: 11, color: backupState === 'granted' ? 'var(--theme-green-text)' : 'var(--theme-text3)', marginTop: 3 }}>
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
              {/* An object is a failure with fine print (S852); a string keeps ok:/error:. */}
              {typeof backupMsg === 'object' && <ActionError error={backupMsg} />}
              {typeof backupMsg === 'string' && backupMsg && (
                <p role={backupMsg.startsWith('ok:') ? 'status' : 'alert'}
                  style={{ fontSize: 12, margin: '8px 0 0', color: backupMsg.startsWith('ok:') ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
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
                {/* A native file input renders the browser's own "Choose File / No file chosen"
                    chrome, which no token reaches and which appears in the OS language rather than
                    the app's. Same hidden-but-focusable input behind a real button that the Logo
                    upload above already uses — `visually-hidden` rather than display:none so the
                    control keeps a keyboard path, and the button carries the accessible name. */}
                <input
                  ref={restoreInputRef}
                  id={fid('restore-file')}
                  type="file" accept=".json"
                  aria-label="Backup file to restore"
                  className="visually-hidden"
                  tabIndex={-1}
                  disabled={restoreBusy}
                  onChange={e => { handleRestoreFile(e.target.files?.[0]); e.target.value = '' }}
                />
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ fontSize: 12 }}
                  disabled={restoreBusy}
                  onClick={() => restoreInputRef.current?.click()}
                >
                  {restoreBusy ? 'Restoring…' : '↑ Choose backup file…'}
                </button>
                {typeof restoreMsg === 'object' && <ActionError error={restoreMsg} />}
                {typeof restoreMsg === 'string' && restoreMsg && (
                  <p role={restoreMsg.startsWith('error:') ? 'alert' : 'status'}
                    style={{ fontSize: 12, margin: '10px 0 0', color: restoreMsg.startsWith('ok:') ? 'var(--theme-green-text)' : restoreMsg.startsWith('info:') ? 'var(--theme-text2)' : 'var(--theme-red-text)' }}>
                    {restoreMsg.replace(/^(ok|error|info):/, '')}
                  </p>
                )}
                {relinkRoster && (
                  <button type="button" className="btn btn-ghost" style={{ fontSize: 12, marginTop: 8 }}
                    disabled={restoreBusy} onClick={retryRelink}>
                    {restoreBusy ? 'Re-linking…' : 'Re-link staff logins'}
                  </button>
                )}
              </div>
            </div>
          )}

          {activeTab === 'legal' && (
            <ClientLegalTab
              client={client}
              clientSettings={clientSettings}
              onClientChanged={onClientUpdated}
            />
          )}

          {activeTab === 'danger' && (
            <div>
              {/* Pre-flight backup status — every action below takes a backup first. */}
              <div style={{
                padding: '12px 14px', marginBottom: 16,
                background: skipBackup ? 'color-mix(in srgb, var(--theme-red) 6%, transparent)' : 'color-mix(in srgb, var(--theme-green) 6%, transparent)',
                border: `1px solid ${skipBackup ? 'color-mix(in srgb, var(--theme-red) 25%, transparent)' : 'color-mix(in srgb, var(--theme-green) 25%, transparent)'}`,
                borderRadius: 'var(--radius-lg)',
              }}>
                <div style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
                  {skipBackup
                    ? <>⚠ <strong style={{ color: 'var(--theme-red-text)' }}>Backups are off.</strong> The actions below will run with no safety copy.</>
                    : <>🛡 A full backup is written <strong style={{ color: 'var(--theme-text1)' }}>before</strong> any action below runs. If it fails, nothing is deleted.</>}
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, fontSize: 12, color: 'var(--theme-text2)', cursor: 'pointer', minHeight: 24 }}>
                  {/* 16px box + 24px label height: this is the control that disables the backup
                      safety net, and it measured 13×13px — the smallest target on the page (S574). */}
                  <input aria-label="Skip the backup" type="checkbox" checked={skipBackup} onChange={e => setSkipBackup(e.target.checked)}
                    style={{ width: 16, height: 16, accentColor: 'var(--theme-red)', flexShrink: 0 }} />
                  I have backed up elsewhere — proceed without a backup
                </label>
              </div>

              {/* Archive — presented above Delete because it is the right answer far more often. */}
              <div style={{
                padding: '14px 16px', marginBottom: 24,
                background: 'color-mix(in srgb, var(--theme-accent) 5%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 25%, transparent)', borderRadius: 'var(--radius-lg)'
              }}>
                <p style={{ fontSize: 13, color: 'var(--theme-accent-ink)', fontWeight: 700, margin: '0 0 6px' }}>Archive Client</p>
                <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 12px', lineHeight: 1.65 }}>
                  The recommended way to close out a client who has left. Takes a backup, clears their operational
                  data, and locks the account — but <strong style={{ color: 'var(--theme-text1)' }}>keeps their user
                  accounts, logins, settings and client record</strong>, so restoring the backup fully reverses it:
                  the restore also re-links each staff login to its employee record and puts back a settled leaver&apos;s block.
                </p>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 12, color: 'var(--theme-accent-ink)', borderColor: 'var(--theme-focus-ring)' }}
                  onClick={() => { setConfirmName(''); setConfirmAction('archive') }}
                  disabled={deleting}
                >
                  {deletingAction === 'archive' ? 'Archiving…' : 'Archive Client'}
                </button>
              </div>

              <div style={{
                padding: '14px 16px', marginBottom: 24,
                background: 'color-mix(in srgb, var(--theme-red) 4%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 15%, transparent)', borderRadius: 'var(--radius-lg)'
              }}>
                <p style={{ fontSize: 13, color: 'var(--theme-red-text)', fontWeight: 700, margin: '0 0 6px' }}>⚠ Danger Zone</p>
                <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: 0, lineHeight: 1.65 }}>
                  Destructive actions for{' '}
                  <strong style={{ color: 'var(--theme-text1)' }}>{client.name}</strong>.{' '}
                  Per-module buttons clear only that module's transactions and keep its setup (items, employees, tables…),
                  except that Clear IMS also deletes the Fixed Assets register and its asset categories.
                  "Clear Client Data" wipes all operational data across IMS, HR and POS; the client record, user accounts,
                  feature flags, and settings are kept intact. Stock transfers with other outlets stay on those outlets' books.
                  <br /><strong style={{ color: 'var(--theme-red-text)' }}>None of these can be undone.</strong>
                </p>
              </div>

              {/* An object is a failure with fine print (S852, dangerZoneText.js); a string keeps the
                  ok:/error: one-line convention the other Danger messages use. */}
              {typeof deleteMsg === 'object' && <ActionError error={deleteMsg} className="action-error--top" />}
              {typeof deleteMsg === 'string' && deleteMsg && (
                <p role={deleteMsg.startsWith('ok:') ? 'status' : 'alert'}
                  style={{ fontSize: 12, margin: '0 0 16px', color: deleteMsg.startsWith('ok:') ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                  {deleteMsg.replace(/^(ok|error):/, '')}
                </p>
              )}

              <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>
                Clear one module — transactions only, setup kept (IMS also clears Fixed Assets)
              </p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
                <Tip text="Deletes IMS activity: purchases, vendor returns, stock counts, wastage, staff meals, hand-entered sales and their stock movements, budgets, payables, POs, requisitions, gate passes, overheads, demand forecast runs, stock transfers with other outlets (the other outlets keep their side). Also deletes the whole Fixed Assets register and its asset categories, with their depreciation runs, tax pool runs, openings and their corrections, and repair expenses. Keeps items, vendors, categories, recipes, par levels, and periods (periods are shared with HR payroll), and what the till posted to Inventory. Cannot be undone.">
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
                <Tip text="Deletes POS activity: orders, order items, shifts, customers, credit notes, payment confirmations, guest order requests, and what the till posted to Inventory (its sales entries and stock movements). Keeps tables, floor plan, staff accounts/PINs, and hand-entered sales with their stock movements; occupied tables are freed, and the hand-entered sales days the till also covered then get their stock re-counted (other days are left as saved). Invoice numbering restarts. Cannot be undone.">
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
                <Tip text="Removes purchase unit conversions from all items (e.g. carton → pcs). Items and stock data are kept, and each item's pack price is rescaled so per-unit rates and stock valuations don't move. A backup is taken first, like the other actions here.">
                  <button
                    onClick={handleClearConversions}
                    disabled={deleting}
                    className="btn btn-danger" style={{ fontSize: 13 }}
                  >
                    {deletingAction === 'conversions' ? 'Working…' : 'Clear All Conversions'}
                  </button>
                </Tip>
                {/* The two whole-client buttons carry the escalated variant and open the
                    typed-name confirm — five of the six buttons here used to be pixel-identical,
                    so nothing distinguished "clear one module" from "wipe the entire client"
                    (phase 7 measured finding, S574). */}
                <Tip text="Permanently deletes ALL operational data across IMS, HR, and POS — master data and transactions. The client account, users, feature flags, and settings are kept. Cannot be undone.">
                  <button
                    onClick={() => { setConfirmName(''); setConfirmAction('clientData') }}
                    disabled={deleting}
                    className="btn btn-danger btn-danger--strong" style={{ fontSize: 13 }}
                  >
                    {deletingAction === 'clientData' ? 'Working…' : 'Clear Client Data'}
                  </button>
                </Tip>
                <Tip text="Permanently deletes everything: all operational data, user accounts, feature flags, settings, and the client record itself. The email is freed for re-registration. Cannot be undone.">
                  <button
                    onClick={() => { setConfirmName(''); setConfirmAction('deleteClient') }}
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

      {/* Admin password reset — reaches any client login including the Owner (the Edge Function
          exempts admin callers from the staff-marker check for exactly this support case). */}
      {resetUser && (
        <Modal onClose={() => setResetUser(null)} title={`Reset password — ${resetUser.full_name || resetUser.email}`} maxWidth={440}>
          <p style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6, margin: '0 0 12px' }}>
            Sets a new password for <strong style={{ color: 'var(--theme-text1)' }}>{resetUser.email}</strong> immediately.
            Read it out to the client and have them change it after signing in.
          </p>
          <label htmlFor="admin-reset-pw" style={{ display: 'block', fontSize: 12, color: 'var(--theme-text2)', marginBottom: 6 }}>New password</label>
          {/* Visible text on purpose — the admin reads this out to the client, it is not their own
              secret. autoComplete="new-password" so Chrome never offers a saved login here. */}
          <input
            id="admin-reset-pw"
            type="text"
            autoComplete="new-password"
            className="form-input"
            value={resetPw}
            onChange={e => setResetPw(e.target.value)}
            placeholder={`Min. ${MIN_PASSWORD_LENGTH} characters`}
            style={{ width: '100%', marginBottom: 16 }}
          />
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={() => setResetUser(null)}>Cancel</button>
            <button
              className="btn btn-primary"
              disabled={resetPw.length < MIN_PASSWORD_LENGTH || resettingPw}
              onClick={async () => {
                setResettingPw(true)
                try {
                  await adminOp('reset_ims_password', { userId: resetUser.id, password: resetPw })
                  setUserSuccess(`Password reset for ${resetUser.email}.`)
                  setResetUser(null)
                } catch (err) {
                  setUserError(loginOpFailure(`The password for ${resetUser.email} was not changed, and the old one still works.`, err))
                  setResetUser(null)
                }
                setResettingPw(false)
              }}
            >
              {resettingPw ? 'Resetting…' : 'Reset Password'}
            </button>
          </div>
        </Modal>
      )}

      {/* Typed-name confirmation for the whole-client actions. Nested Modal is safe: Modal.js
          keeps a stack so only the topmost responds to Escape/Tab (S574). */}
      {confirmAction && (() => {
        const cfg = {
          archive: {
            title: 'Archive this client?',
            verb: 'Archive Client',
            body: <>A backup is taken first, then all operational data is cleared and the account is locked.
              Their user accounts, logins, settings and the client record are <strong>kept</strong>, so
              restoring the backup reverses this. Use this rather than Delete for a client who is leaving.
              Every POS tablet is signed out for good and the shared till key is switched off; a restore does not
              bring them back, so each tablet is activated again from Till Devices.</>,
            run: handleArchiveClient,
          },
          clientData: {
            title: 'Clear ALL operational data?',
            verb: 'Clear Client Data',
            body: <>Removes everything across all modules — IMS (items, vendors, recipes, purchases, stock,
              sales, payables, periods), HR (employees, attendance, payroll, leave, roster) and POS (tables,
              orders, shifts, customers). The client record, user accounts, feature flags and settings are
              kept. Every POS tablet key is revoked and the shared till key is switched off, so each tablet has to be
              activated again from Till Devices. Stock transfers with other outlets stay on those outlets&apos; books.{' '}
              <strong>This cannot be undone.</strong></>,
            run: handleDeleteClientData,
          },
          deleteClient: {
            title: 'Permanently DELETE this client?',
            verb: 'Delete Client',
            body: <>Removes <strong>everything</strong>: all operational data, every user account and login,
              feature flags, settings, and the client record itself. The email is freed for re-registration.
              Stock transfers with other outlets stay on those outlets&apos; books.
              <strong> This cannot be undone.</strong></>,
            run: handleDeleteClient,
          },
        }[confirmAction]
        const nameMatches = confirmName.trim() === client.name.trim()
        return (
          <Modal onClose={() => setConfirmAction(null)} title={cfg.title} maxWidth={480}>
            <div style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.65, marginBottom: 16 }}>
              {cfg.body}
            </div>
            <label htmlFor="danger-confirm-name" style={{ display: 'block', fontSize: 12, color: 'var(--theme-text2)', marginBottom: 6 }}>
              Type <strong style={{ color: 'var(--theme-text1)' }}>{client.name}</strong> to confirm
            </label>
            <input
              id="danger-confirm-name"
              type="text"
              className="form-input"
              value={confirmName}
              onChange={e => setConfirmName(e.target.value)}
              autoComplete="off"
              style={{ width: '100%', marginBottom: 16 }}
            />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setConfirmAction(null)}>Cancel</button>
              <button
                className="btn btn-danger btn-danger--strong"
                disabled={!nameMatches || deleting}
                onClick={() => { setConfirmAction(null); cfg.run() }}
              >
                {cfg.verb}
              </button>
            </div>
          </Modal>
        )
      })()}
      {confirmEl}
      {midQuestion && (
        <ConfirmModal
          title={midQuestion.title}
          confirmLabel={midQuestion.confirmLabel}
          cancelLabel={midQuestion.cancelLabel}
          danger={!!midQuestion.danger}
          onConfirm={() => answerMidway(true)}
          onCancel={() => answerMidway(false)}
        >
          {midQuestion.body}
        </ConfirmModal>
      )}
    </Modal>
  )
}
