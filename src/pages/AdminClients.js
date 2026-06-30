import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { useSettings } from '../context/SettingsContext'
import { getBsToday, formatAd } from '../utils/bsCalendar'
import BsCalendarPicker from '../components/BsCalendarPicker'
import { getSubStatus, getDateStatus } from '../utils/subscription'

// All auth-admin operations go through an Edge Function — service role key stays server-side
async function adminOp(action, params = {}) {
  const { data, error } = await supabase.functions.invoke('admin-user-ops', {
    body: { action, ...params },
  })
  if (error) {
    // functions.invoke gives a generic "non-2xx status code" message; the real
    // reason is in the response body (error.context) — surface it.
    let detail = error.message || 'Edge function error'
    try {
      const body = await error.context.json()
      detail = body?.error?.message || body?.error || body?.message || detail
    } catch (_) {}
    throw new Error(detail)
  }
  if (data?.error) throw new Error(data.error.message || data.error || 'Admin op failed')
  return data
}

const EMPTY_USER = { email: '', password: '', full_name: '' }

// null = no override (plan decides), true = explicit grant, false = explicit revoke
const DEFAULT_FLAGS = {
  sales_entry: null, monthly_summary: null, payment_summary: null,
  vendor_report: null, variance_report: null, fifo_report: null,
  reorder_report: null, price_tracker: null, recipe_costing: null,
  menu_engineering: null, overheads: null, budget_vs_actual: null,
  best_sellers: null, vat_report: null, non_vat_report: null,
  purchase_orders: null, requisitions: null, wastage_report: null,
  dead_stock: null, recipe_margin: null, period_comparison: null,
  theoretical_variance: null, annual_summary: null,
  outstanding_payables: null, shrinkage_report: null,
  staff_meals: null, settings: null,
  nutrition_facts: null, stock_report: null,
  menu_repricing: null,
}

const FEATURE_GROUPS = [
  { tier: 'core',    label: 'Core — All Plans', color: 'var(--theme-text2)', features: [
    { key: null, label: 'Dashboard' },
    { key: null, label: 'Periods' },
    { key: null, label: 'Item Master' },
    { key: null, label: 'Vendors' },
    { key: null, label: 'Purchases' },
    { key: null, label: 'Stock Count' },
  ]},
  { tier: 'starter', label: 'Starter Plan',     color: 'var(--theme-text3)', features: [
    { key: 'sales_entry',     label: 'Sales Entry' },
    { key: 'payment_summary', label: 'Payment Summary' },
    { key: 'monthly_summary', label: 'Monthly Summary' },
    { key: 'annual_summary',  label: 'Annual Summary' },
    { key: 'reorder_report',  label: 'Reorder Report' },
    { key: 'vat_report',      label: 'VAT Report' },
    { key: 'non_vat_report',  label: 'Non-VAT Report' },
    { key: 'wastage_report',  label: 'Wastage Report' },
    { key: 'stock_report',    label: 'Stock Report' },
    { key: 'settings',        label: 'Settings' },
  ]},
  { tier: 'growth',  label: 'Growth Plan',      color: 'var(--theme-green)', features: [
    { key: 'recipe_costing',       label: 'Recipe Costing' },
    { key: 'purchase_orders',      label: 'Purchase Orders' },
    { key: 'requisitions',         label: 'Requisitions' },
    { key: 'variance_report',      label: 'Variance Report' },
    { key: 'budget_vs_actual',     label: 'Budget vs Actual' },
    { key: 'best_sellers',         label: 'Best & Worst Sellers' },
    { key: 'dead_stock',           label: 'Dead Stock' },
    { key: 'recipe_margin',        label: 'Recipe Margin' },
    { key: 'outstanding_payables', label: 'Outstanding Payables' },
    { key: 'staff_meals',          label: 'Staff Meals' },
    { key: 'nutrition_facts',      label: 'Nutrition Facts' },
    { key: 'menu_repricing',       label: 'Menu Repricing' },
  ]},
  { tier: 'pro',     label: 'Pro Plan',         color: 'var(--theme-accent)', features: [
    { key: 'menu_engineering',     label: 'Menu Engineering' },
    { key: 'overheads',            label: 'Overheads' },
    { key: 'vendor_report',        label: 'Vendor Report' },
    { key: 'fifo_report',          label: 'FIFO / Expiry' },
    { key: 'price_tracker',        label: 'Price Tracker' },
    { key: 'theoretical_variance', label: 'Theoretical Variance' },
    { key: 'period_comparison',    label: 'Period Comparison' },
    { key: 'shrinkage_report',     label: 'Shrinkage Report' },
  ]},
]

// Returns true if the plan naturally includes this tier's features
function isPlanIncluded(tier, clientPlan) {
  if (tier === 'core') return true
  if (tier === 'starter') return true
  if (tier === 'growth') return clientPlan === 'growth' || clientPlan === 'pro'
  if (tier === 'pro') return clientPlan === 'pro'
  return false
}

const SETTINGS_DEFAULTS = {
  app_name: '', app_tagline: '', property_address: '', property_phone: '',
  property_email: '', vat_number: '', fc_warning_pct: 35, fc_critical_pct: 45,
  expiry_warning_days: 7, variance_flag_pct: 10, item_code_prefix: 'ITM',
  contact_phone: '', contact_email: '', contact_website: ''
}

// ── Subscription badge ────────────────────────────────────────────────────────
function SubBadge({ client }) {
  const s = getSubStatus(client)
  if (!s.label) return <span style={{ color: 'var(--theme-text3)', fontSize: 12 }}>—</span>
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
      color: s.color, background: s.bg, border: `1px solid ${s.border}`,
      whiteSpace: 'nowrap', display: 'inline-block'
    }}>
      {s.label}
    </span>
  )
}

// ── Drawer ───────────────────────────────────────────────────────────────────
function ClientDrawer({ client, onClose, onClientUpdated }) {
  const { loadClientSettings, saveClientSettings } = useSettings()
  const [activeTab, setActiveTab] = useState('users')

  // Users tab state
  const [users, setUsers]               = useState([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [userForm, setUserForm]         = useState(EMPTY_USER)
  const [savingUser, setSavingUser]     = useState(false)
  const [userError, setUserError]       = useState('')
  const [userSuccess, setUserSuccess]   = useState('')

  // Settings tab state
  const [clientSettings, setClientSettings]   = useState(SETTINGS_DEFAULTS)
  const [loadingSettings, setLoadingSettings] = useState(false)
  const [savingSettings, setSavingSettings]   = useState(false)
  const [settingsMsg, setSettingsMsg]         = useState('')

  // Modules state
  const [imsEnabled, setImsEnabled] = useState(client.ims_enabled !== false)
  const [hrEnabled,  setHrEnabled]  = useState(!!client.hr_enabled)
  const [hrPlan, setHrPlan]         = useState(client.hr_plan || 'starter')

  // Billing tab state — per-module end dates; fall back to legacy subscription_ends_at for IMS
  const _legacyEnd = client.subscription_ends_at ? formatAd(new Date(client.subscription_ends_at)) : ''
  const [imsEndsAt, setImsEndsAt] = useState(client.ims_ends_at ? formatAd(new Date(client.ims_ends_at)) : _legacyEnd)
  const [hrEndsAt,  setHrEndsAt]  = useState(client.hr_ends_at  ? formatAd(new Date(client.hr_ends_at))  : '')
  const [posEndsAt] = useState(client.pos_ends_at ? formatAd(new Date(client.pos_ends_at)) : '')
  const [billingCycle, setBillingCycle] = useState(client.billing_cycle || 'monthly')
  const [savingSub, setSavingSub] = useState(false)
  const [subMsg, setSubMsg]       = useState('')

  // Logo upload state (Settings tab)
  const [logoUploading, setLogoUploading] = useState(false)
  const [logoMsg, setLogoMsg] = useState('')

  // Danger Zone state
  const [deleting, setDeleting] = useState(false)
  const [deleteMsg, setDeleteMsg] = useState('')

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
    if (activeTab === 'settings' || activeTab === 'thresholds') fetchClientSettings()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

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
    if (userForm.password.length < 6) {
      setUserError('Password must be at least 6 characters.'); return
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
    const data = await loadClientSettings(client.id)
    if (data) setClientSettings(prev => ({ ...prev, ...data }))
    setLoadingSettings(false)
  }

  async function handleSaveSettings() {
    setSavingSettings(true); setSettingsMsg('')
    try {
      await saveClientSettings(client.id, clientSettings)
      setSettingsMsg('ok:Settings saved.')
    } catch (e) {
      setSettingsMsg('error:' + e.message)
    }
    setSavingSettings(false)
  }

  // ── Module toggles (instant save) ──
  async function handleToggleIms() {
    const next = !imsEnabled
    setImsEnabled(next)
    await supabase.from('clients').update({ ims_enabled: next }).eq('id', client.id)
    onClientUpdated()
  }

  async function handleToggleHr() {
    const next = !hrEnabled
    setHrEnabled(next)
    await supabase.from('clients').update({ hr_enabled: next }).eq('id', client.id)
    onClientUpdated()
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
      ims_ends_at:   imsEndsAt || null,
      hr_ends_at:    hrEndsAt  || null,
      pos_ends_at:   posEndsAt || null,
      plan:          currentPlan,
      hr_plan:       hrPlan,
      billing_cycle: billingCycle,
    }).eq('id', client.id)
    if (error) { setSubMsg('error:' + error.message) }
    else { setSubMsg('ok:Subscription saved.'); onClientUpdated() }
    setSavingSub(false)
  }

  // ── Danger Zone ──
  async function handleClearConversions() {
    const { data: withConv } = await supabase
      .from('items').select('id').eq('client_id', client.id).not('purchase_unit', 'is', null)
    const count = withConv?.length || 0
    if (count === 0) { setDeleteMsg('ok:No items have a conversion set.'); return }
    if (!window.confirm(
      `Clear unit conversions on ${count} item${count !== 1 ? 's' : ''} for "${client.name}"?\n\n` +
      `Purchase Unit, Base Unit, Conversion Factor and Purchase Qty will be reset to 1 for each affected item.\n\n` +
      `This cannot be undone.`
    )) return
    setDeleting(true); setDeleteMsg('')
    const { error } = await supabase
      .from('items')
      .update({ purchase_unit: null, base_unit: null, conversion_factor: 1, purchase_qty: 1 })
      .eq('client_id', client.id)
      .not('purchase_unit', 'is', null)
    setDeleting(false)
    setDeleteMsg(error ? 'error:' + error.message : `ok:Conversions cleared on ${count} item${count !== 1 ? 's' : ''}.`)
  }

  async function handleDeleteClientData() {
    if (!window.confirm(
      `Clear ALL operational data for "${client.name}"?\n\n` +
      `This removes: categories, items, vendors, recipes, purchases, stock, sales, overheads, and all periods.\n\n` +
      `The client record, user accounts, feature flags, and settings are kept intact.\n\n` +
      `This cannot be undone.`
    )) return
    setDeleting(true)
    setDeleteMsg('')
    try {
      await adminOp('deleteClientData', { clientId: client.id })
      setDeleteMsg('ok:All client data has been permanently erased.')
    } catch (err) {
      setDeleteMsg('error:' + err.message)
    }
    setDeleting(false)
  }

  async function handleDeleteClient() {
    if (!window.confirm(
      `Permanently DELETE the client "${client.name}"?\n\n` +
      `This removes EVERYTHING: all operational data, user accounts, feature flags, settings, and the client record itself.\n\n` +
      `This cannot be undone.`
    )) return
    setDeleting(true)
    setDeleteMsg('')
    try {
      // Delete all user auth accounts for this client
      const { data: profiles } = await supabase.from('profiles').select('id').eq('client_id', client.id)
      for (const p of (profiles || [])) {
        await adminOp('deleteUser', { userId: p.id })
      }
      // Delete operational data, settings, feature flags, then the client record
      await adminOp('deleteClientData', { clientId: client.id })
      await supabase.from('settings').delete().eq('client_id', client.id)
      await supabase.from('feature_flags').delete().eq('client_id', client.id)
      await supabase.from('clients').delete().eq('id', client.id)
      onClientUpdated()
      onClose()
    } catch (err) {
      setDeleteMsg('error:' + err.message)
      setDeleting(false)
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
    { key: 'billing',    label: 'Billing' },
    { key: 'settings',   label: 'Settings' },
    { key: 'thresholds', label: 'Thresholds' },
    { key: 'danger',     label: '⚠ Danger' },
  ]

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 200
        }}
      />

      {/* Drawer */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 520,
        background: 'var(--theme-card)', borderLeft: '1px solid var(--theme-border)',
        zIndex: 201, display: 'flex', flexDirection: 'column',
        boxShadow: '-8px 0 32px rgba(0,0,0,0.12)'
      }}>
        {/* Drawer header */}
        <div style={{
          padding: '20px 24px 0',
          borderBottom: '1px solid var(--theme-border)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 16, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>{client.name}</h2>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
                {client.location || 'No location'} ·{' '}
                <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 4,
                  color: client.plan === 'pro' ? 'var(--theme-accent)' : client.plan === 'growth' ? 'var(--theme-green)' : 'var(--theme-text2)',
                  background: client.plan === 'pro' ? 'rgba(201,168,76,0.12)' : client.plan === 'growth' ? 'rgba(52,211,153,0.10)' : 'rgba(120,113,108,0.10)',
                  border: `1px solid ${client.plan === 'pro' ? 'rgba(201,168,76,0.25)' : client.plan === 'growth' ? 'rgba(52,211,153,0.20)' : 'rgba(107,114,128,0.25)'}`,
                }}>
                  {client.plan === 'pro' ? 'Pro' : client.plan === 'growth' ? 'Growth' : 'Starter'}
                </span>
              </p>
            </div>
            <button
              onClick={onClose}
              style={{ background: 'none', border: 'none', color: 'var(--theme-text2)', fontSize: 20, cursor: 'pointer', padding: 4, lineHeight: 1 }}
            >✕</button>
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', gap: 0, marginTop: 16 }}>
            {tabs.map(t => (
              <button key={t.key} onClick={() => { setActiveTab(t.key); setDeleteMsg('') }} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '8px 16px', fontSize: 13,
                color: activeTab === t.key
                  ? (t.key === 'danger' ? 'var(--theme-red)' : 'var(--theme-accent)')
                  : (t.key === 'danger' ? '#9b5555' : 'var(--theme-text2)'),
                borderBottom: activeTab === t.key
                  ? `2px solid ${t.key === 'danger' ? 'var(--theme-red)' : 'var(--theme-accent)'}`
                  : '2px solid transparent',
                fontWeight: activeTab === t.key ? 600 : 400,
                transition: 'color 0.15s'
              }}>{t.label}</button>
            ))}
          </div>
        </div>

        {/* Drawer body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

          {/* ── USERS TAB ── */}
          {activeTab === 'users' && (
            <div>
              {/* Edit client details */}
              <div style={{ marginBottom: 24 }}>
                <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>
                  Client Details
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                  <div className="form-field">
                    <label>Property Name *</label>
                    <input value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} />
                  </div>
                  <div className="form-field">
                    <label>Location</label>
                    <input value={editForm.location} onChange={e => setEditForm({ ...editForm, location: e.target.value })} />
                  </div>
                  <div className="form-field">
                    <label>Contact Person</label>
                    <input value={editForm.contact_person} onChange={e => setEditForm({ ...editForm, contact_person: e.target.value })} />
                  </div>
                  <div className="form-field">
                    <label>Phone</label>
                    <input value={editForm.contact_phone} onChange={e => setEditForm({ ...editForm, contact_phone: e.target.value })} />
                  </div>
                </div>
                {clientMsg && (
                  <p style={{ fontSize: 12, margin: '0 0 8px', color: clientMsg.startsWith('ok:') ? 'var(--theme-green)' : 'var(--theme-red)' }}>
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
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                  <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                    <label>Full Name</label>
                    <input
                      value={userForm.full_name}
                      onChange={e => setUserForm({ ...userForm, full_name: e.target.value })}
                      placeholder="e.g. Ram Sharma"
                    />
                  </div>
                  <div className="form-field">
                    <label>Email *</label>
                    <input
                      type="email"
                      value={userForm.email}
                      onChange={e => setUserForm({ ...userForm, email: e.target.value })}
                      placeholder="user@restaurant.com"
                    />
                    <span style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 4, display: 'block' }}>
                      A login lives on one client at a time. If this email already has a client login, creating it here <strong>moves</strong> it to this client. To keep separate logins on the same inbox, add <code style={{ color: 'var(--theme-text3)' }}>+name</code> before the @ (e.g. you+casa@gmail.com).
                    </span>
                  </div>
                  <div className="form-field">
                    <label>Password *</label>
                    <input
                      type="text"
                      value={userForm.password}
                      onChange={e => setUserForm({ ...userForm, password: e.target.value })}
                      placeholder="min 6 characters"
                    />
                  </div>
                </div>
                {userError   && <p style={{ color: 'var(--theme-red)', fontSize: 12, margin: '0 0 8px' }}>{userError}</p>}
                {userSuccess && <p style={{ color: 'var(--theme-green)', fontSize: 12, margin: '0 0 8px' }}>{userSuccess}</p>}
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
                      <span style={{ fontSize: 11, color: 'var(--theme-accent)', marginLeft: 8, background: 'rgba(201,168,76,0.1)', padding: '1px 6px', borderRadius: 3 }}>
                        {u.role}
                      </span>
                    </div>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 11, padding: '3px 10px', color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.25)' }}
                      onClick={() => deleteUser(u)}
                    >Delete</button>
                  </div>
                ))}
              </div>
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
                  {[
                    { key: 'ims', label: 'Crest IMS', sub: 'Inventory Management', enabled: imsEnabled, toggle: handleToggleIms },
                    { key: 'hr',  label: 'Crest HR',  sub: 'Human Resources',      enabled: hrEnabled,  toggle: handleToggleHr  },
                  ].map(mod => (
                    <div key={mod.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--theme-border-lt)' }}>
                      <div>
                        <p style={{ margin: '0 0 1px', fontSize: 13, fontWeight: 700, color: mod.enabled ? 'var(--theme-text1)' : 'var(--theme-text3)' }}>{mod.label}</p>
                        <p style={{ margin: 0, fontSize: 11, color: 'var(--theme-text2)' }}>{mod.sub}</p>
                      </div>
                      <div onClick={mod.toggle} style={{ position: 'relative', width: 38, height: 22, borderRadius: 11, cursor: 'pointer', flexShrink: 0, background: mod.enabled ? 'var(--theme-accent)' : '#374151', transition: 'background 0.2s' }}>
                        <div style={{ position: 'absolute', top: 3, left: mod.enabled ? 19 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.35)' }} />
                      </div>
                    </div>
                  ))}
                  {/* POS — coming soon */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0' }}>
                    <div>
                      <p style={{ margin: '0 0 1px', fontSize: 13, fontWeight: 700, color: 'var(--theme-text3)' }}>Crest POS</p>
                      <p style={{ margin: 0, fontSize: 11, color: 'var(--theme-text2)' }}>Point of Sale · coming soon</p>
                    </div>
                    <div style={{ opacity: 0.3 }}>
                      <div style={{ position: 'relative', width: 38, height: 22, borderRadius: 11, background: '#374151', cursor: 'not-allowed' }}>
                        <div style={{ position: 'absolute', top: 3, left: 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.35)' }} />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Billing cycle toggle */}
                <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 8px' }}>Billing Cycle</p>
                <div style={{ display: 'flex', gap: 0, marginBottom: 24, background: 'var(--theme-bg)', borderRadius: 8, border: '1px solid var(--theme-border)', padding: 4, width: 'fit-content' }}>
                  {[{ key: 'monthly', label: 'Monthly' }, { key: 'annual', label: 'Annual · Save 25%' }].map(opt => (
                    <button key={opt.key} onClick={() => setBillingCycle(opt.key)} style={{
                      padding: '5px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, border: 'none',
                      background: billingCycle === opt.key ? (opt.key === 'annual' ? 'var(--theme-accent)' : 'var(--theme-card)') : 'transparent',
                      color: billingCycle === opt.key ? (opt.key === 'annual' ? '#000' : 'var(--theme-text1)') : 'var(--theme-text3)',
                      boxShadow: billingCycle === opt.key ? '0 1px 4px rgba(0,0,0,0.18)' : 'none',
                      transition: 'all 0.15s',
                    }}>{opt.label}</button>
                  ))}
                </div>

                {/* Per-module subscription sections */}
                {[
                  { key: 'ims', label: 'Crest IMS', enabled: imsEnabled, plan: currentPlan, setPlan: setCurrentPlan, endsAt: imsEndsAt, setEndsAt: setImsEndsAt },
                  { key: 'hr',  label: 'Crest HR',  enabled: hrEnabled,  plan: hrPlan,      setPlan: setHrPlan,      endsAt: hrEndsAt,  setEndsAt: setHrEndsAt  },
                ].map(mod => {
                  if (!mod.enabled) return null
                  const s = getDateStatus(mod.endsAt)
                  const PLANS = [
                    { key: 'starter', label: 'Starter', monthly: 5000,  annual: 3750 },
                    { key: 'growth',  label: 'Growth',  monthly: 8000,  annual: 6000 },
                    { key: 'pro',     label: 'Pro',     monthly: 12000, annual: 9000 },
                  ]
                  return (
                    <div key={mod.key} style={{ marginBottom: 24, paddingBottom: 24, borderBottom: '1px solid var(--theme-border)' }}>
                      {/* Header */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                        <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: 'var(--theme-text1)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{mod.label}</p>
                        {s.label && (
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 3, color: s.color, background: s.bg, border: `1px solid ${s.border}` }}>
                            {s.label}
                          </span>
                        )}
                      </div>
                      {/* Plan cards */}
                      <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                        {PLANS.map(p => {
                          const price = billingCycle === 'annual' ? p.annual : p.monthly
                          const active = mod.plan === p.key
                          const accentColor = p.key === 'pro' ? 'var(--theme-accent)' : p.key === 'growth' ? 'var(--theme-green)' : 'var(--theme-text2)'
                          return (
                            <button key={p.key} onClick={() => mod.setPlan(p.key)} style={{
                              flex: 1, padding: '8px 4px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700, lineHeight: 1.4,
                              border: active ? `1px solid ${accentColor}` : '1px solid var(--theme-border)',
                              background: active ? (p.key === 'pro' ? 'rgba(201,168,76,0.12)' : p.key === 'growth' ? 'rgba(52,211,153,0.10)' : 'rgba(120,113,108,0.10)') : 'none',
                              color: active ? accentColor : 'var(--theme-text3)',
                            }}>
                              <div>{p.label}</div>
                              <div style={{ fontSize: 10, fontWeight: 400, marginTop: 2, opacity: 0.85 }}>NPR {price.toLocaleString('en-NP')}/mo</div>
                            </button>
                          )
                        })}
                      </div>
                      <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '0 0 12px' }}>
                        {billingCycle === 'annual'
                          ? `Annual · NPR ${{ starter: 3750, growth: 6000, pro: 9000 }[mod.plan].toLocaleString('en-NP')}/mo × 12 = NPR ${{ starter: 45000, growth: 72000, pro: 108000 }[mod.plan].toLocaleString('en-NP')}/yr`
                          : `Monthly · NPR ${{ starter: 5000, growth: 8000, pro: 12000 }[mod.plan].toLocaleString('en-NP')}/mo`
                        }
                      </p>
                      {/* Date picker */}
                      <p style={{ fontSize: 11, color: 'var(--theme-text2)', margin: '0 0 6px' }}>Subscription end date</p>
                      <div style={{ marginBottom: 8 }}>
                        <BsCalendarPicker value={mod.endsAt} onChange={mod.setEndsAt} clearable />
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {[{ label: '+7 Days', days: 7 }, { label: '+1 Month', days: 30 }, { label: '+3 Months', days: 90 }, { label: '+1 Year', days: 365 }].map(({ label, days }) => (
                          <button key={label} className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => extendModule(mod.setEndsAt, days)}>{label}</button>
                        ))}
                        {mod.endsAt && (
                          <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.25)', marginLeft: 'auto' }} onClick={() => mod.setEndsAt('')}>Clear</button>
                        )}
                      </div>
                    </div>
                  )
                })}

                {subMsg && (
                  <p style={{ fontSize: 12, margin: '0 0 12px', color: subMsg.startsWith('ok:') ? 'var(--theme-green)' : 'var(--theme-red)' }}>
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
                    <div style={{ width: 64, height: 64, borderRadius: 8, border: '1px solid var(--theme-border)', background: 'var(--theme-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {clientSettings.logo_url
                        ? <img src={clientSettings.logo_url} alt="logo" style={{ width: 56, height: 56, objectFit: 'contain', borderRadius: 6 }} />
                        : <span style={{ fontSize: 26, color: 'var(--theme-accent)' }}>⬢</span>
                      }
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 8px' }}>Logo — square PNG/JPG/SVG, max 2MB</p>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <label style={{ cursor: logoUploading ? 'not-allowed' : 'pointer' }}>
                          <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" style={{ display: 'none' }}
                            disabled={logoUploading}
                            onChange={e => { if (e.target.files[0]) handleLogoUpload(e.target.files[0]) }}
                          />
                          <span className="btn btn-ghost" style={{ fontSize: 11, opacity: logoUploading ? 0.6 : 1, pointerEvents: 'none' }}>
                            {logoUploading ? 'Uploading…' : '↑ Upload Logo'}
                          </span>
                        </label>
                        {clientSettings.logo_url && (
                          <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.25)' }} onClick={handleLogoRemove}>
                            Remove
                          </button>
                        )}
                      </div>
                      {logoMsg && <p style={{ fontSize: 11, margin: '6px 0 0', color: logoMsg.startsWith('error') ? 'var(--theme-red)' : 'var(--theme-green)' }}>{logoMsg.replace(/^(ok|error):/, '')}</p>}
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
                    <div className="form-field">
                      <label>Property Name</label>
                      <input value={clientSettings.app_name || ''} onChange={e => setClientSettings({ ...clientSettings, app_name: e.target.value })} placeholder="e.g. Casa Acai Cafe" />
                    </div>
                    <div className="form-field">
                      <label>Tagline</label>
                      <input value={clientSettings.app_tagline || ''} onChange={e => setClientSettings({ ...clientSettings, app_tagline: e.target.value })} placeholder="e.g. Fresh bowls, made daily." />
                    </div>
                    <div className="form-field">
                      <label>VAT Number</label>
                      <input value={clientSettings.vat_number || ''} onChange={e => setClientSettings({ ...clientSettings, vat_number: e.target.value })} />
                    </div>
                  </div>

                  <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 16px', borderTop: '1px solid var(--theme-border)', paddingTop: 16 }}>
                    Property Details
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
                    <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                      <label>Address</label>
                      <input value={clientSettings.property_address || ''} onChange={e => setClientSettings({ ...clientSettings, property_address: e.target.value })} />
                    </div>
                    <div className="form-field">
                      <label>Phone</label>
                      <input value={clientSettings.property_phone || ''} onChange={e => setClientSettings({ ...clientSettings, property_phone: e.target.value })} />
                    </div>
                    <div className="form-field">
                      <label>Email</label>
                      <input value={clientSettings.property_email || ''} onChange={e => setClientSettings({ ...clientSettings, property_email: e.target.value })} />
                    </div>
                  </div>

                  <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 16px', borderTop: '1px solid var(--theme-border)', paddingTop: 16 }}>
                    Upgrade Contact
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
                    <div className="form-field">
                      <label>Contact Phone</label>
                      <input value={clientSettings.contact_phone || ''} onChange={e => setClientSettings({ ...clientSettings, contact_phone: e.target.value })} />
                    </div>
                    <div className="form-field">
                      <label>Contact Email</label>
                      <input value={clientSettings.contact_email || ''} onChange={e => setClientSettings({ ...clientSettings, contact_email: e.target.value })} />
                    </div>
                    <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                      <label>Website</label>
                      <input value={clientSettings.contact_website || ''} onChange={e => setClientSettings({ ...clientSettings, contact_website: e.target.value })} />
                    </div>
                  </div>

                  {settingsMsg && (
                    <p style={{ fontSize: 12, margin: '0 0 12px', color: settingsMsg.startsWith('ok:') ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                      {settingsMsg.replace(/^(ok|error):/, '')}
                    </p>
                  )}
                  <button className="btn btn-primary" style={{ fontSize: 13 }} onClick={handleSaveSettings} disabled={savingSettings}>
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
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
                    <div className="form-field">
                      <label>FC Warning % (yellow)</label>
                      <input type="number" value={clientSettings.fc_warning_pct || 35} onChange={e => setClientSettings({ ...clientSettings, fc_warning_pct: parseFloat(e.target.value) })} />
                    </div>
                    <div className="form-field">
                      <label>FC Critical % (red)</label>
                      <input type="number" value={clientSettings.fc_critical_pct || 45} onChange={e => setClientSettings({ ...clientSettings, fc_critical_pct: parseFloat(e.target.value) })} />
                    </div>
                  </div>

                  <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px', borderTop: '1px solid var(--theme-border)', paddingTop: 16 }}>
                    Alerts
                  </p>
                  <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 16px', lineHeight: 1.5 }}>
                    Controls when items are flagged in the Expiry and Variance reports.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
                    <div className="form-field">
                      <label>Expiry Warning (days)</label>
                      <input type="number" value={clientSettings.expiry_warning_days || 7} onChange={e => setClientSettings({ ...clientSettings, expiry_warning_days: parseInt(e.target.value) })} />
                    </div>
                    <div className="form-field">
                      <label>Variance Flag %</label>
                      <input type="number" value={clientSettings.variance_flag_pct || 10} onChange={e => setClientSettings({ ...clientSettings, variance_flag_pct: parseFloat(e.target.value) })} />
                    </div>
                  </div>

                  {settingsMsg && (
                    <p style={{ fontSize: 12, margin: '0 0 12px', color: settingsMsg.startsWith('ok:') ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                      {settingsMsg.replace(/^(ok|error):/, '')}
                    </p>
                  )}
                  <button className="btn btn-primary" style={{ fontSize: 13 }} onClick={handleSaveSettings} disabled={savingSettings}>
                    {savingSettings ? 'Saving…' : 'Save Thresholds'}
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── DANGER ZONE TAB ── */}
          {activeTab === 'danger' && (
            <div>
              <div style={{
                padding: '14px 16px', marginBottom: 24,
                background: 'rgba(248,113,113,0.04)', border: '1px solid rgba(248,113,113,0.15)', borderRadius: 8
              }}>
                <p style={{ fontSize: 13, color: 'var(--theme-red)', fontWeight: 700, margin: '0 0 6px' }}>⚠ Danger Zone</p>
                <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: 0, lineHeight: 1.65 }}>
                  This permanently deletes all operational data for{' '}
                  <strong style={{ color: 'var(--theme-text1)' }}>{client.name}</strong>:{' '}
                  categories, items, vendors, recipes, purchases, stock, sales, overheads, and all periods.
                  The client record, user accounts, feature flags, and settings are kept intact.
                  <br /><strong style={{ color: 'var(--theme-red)' }}>This cannot be undone.</strong>
                </p>
              </div>

              {deleteMsg && (
                <p style={{ fontSize: 12, margin: '0 0 16px', color: deleteMsg.startsWith('ok:') ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                  {deleteMsg.replace(/^(ok|error):/, '')}
                </p>
              )}

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button
                  onClick={handleClearConversions}
                  disabled={deleting}
                  style={{
                    background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.15)',
                    color: 'var(--theme-red)', borderRadius: 6, padding: '9px 18px',
                    cursor: deleting ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600,
                    opacity: deleting ? 0.6 : 1
                  }}
                >
                  {deleting ? 'Working…' : 'Clear All Conversions'}
                </button>
                <button
                  onClick={handleDeleteClientData}
                  disabled={deleting}
                  style={{
                    background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.20)',
                    color: 'var(--theme-red)', borderRadius: 6, padding: '9px 18px',
                    cursor: deleting ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600,
                    opacity: deleting ? 0.6 : 1
                  }}
                >
                  {deleting ? 'Working…' : 'Clear Client Data'}
                </button>
                <button
                  onClick={handleDeleteClient}
                  disabled={deleting}
                  style={{
                    background: 'rgba(248,113,113,0.18)', border: '1px solid rgba(248,113,113,0.40)',
                    color: 'var(--theme-red)', borderRadius: 6, padding: '9px 18px',
                    cursor: deleting ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700,
                    opacity: deleting ? 0.6 : 1
                  }}
                >
                  {deleting ? 'Working…' : 'Delete Client'}
                </button>
              </div>
            </div>
          )}

        </div>
      </div>
    </>
  )
}

// ── Feature Access Modal ──────────────────────────────────────────────────────
function FeatureAccessModal({ client, onClose }) {
  const { loadClientFeatureFlags, saveFeatureFlags } = useSettings()
  const [flags, setFlags] = useState(DEFAULT_FLAGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  // clientPlan drives the IMS feature grid (which tiers are auto-included) — always the IMS plan.
  const clientPlan = client.plan || 'starter'
  const planLabel  = clientPlan.charAt(0).toUpperCase() + clientPlan.slice(1)
  // These feature flags are all Crest IMS features. They only mean anything when IMS is
  // enabled for the client — ModuleGate blocks all IMS routes otherwise. Don't show the
  // IMS plan grid for an HR-only client.
  const imsEnabled = client.ims_enabled !== false
  const hrEnabled  = !!client.hr_enabled
  // Header reflects the module that's actually active for this client, with the plan the
  // admin selected for it in the Modules tab — for an HR-only client that's hr_plan, not
  // the (irrelevant) IMS plan.
  const activeModule = imsEnabled ? 'IMS' : (hrEnabled ? 'HR' : 'IMS')
  const activePlan   = (imsEnabled ? client.plan : (hrEnabled ? client.hr_plan : client.plan)) || 'starter'
  const activeColor  = activePlan === 'pro' ? 'var(--theme-accent)' : activePlan === 'growth' ? 'var(--theme-green)' : 'var(--theme-text3)'
  const activeLabel  = activePlan.charAt(0).toUpperCase() + activePlan.slice(1)

  useEffect(() => {
    loadClientFeatureFlags(client.id).then(data => {
      setFlags({ ...DEFAULT_FLAGS, ...data })
      setLoading(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id])

  async function handleSave() {
    setSaving(true); setMsg('')
    try {
      await saveFeatureFlags(client.id, flags)
      setMsg('ok:Saved.')
    } catch (e) {
      setMsg('error:' + e.message)
    }
    setSaving(false)
  }

  function toggleFeat(key, currentIsOn) {
    // Plan features are not toggleable — only non-plan grants use true/null
    setFlags(f => ({ ...f, [key]: currentIsOn ? null : true }))
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 12, width: 'min(1120px, 96vw)', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.4)' }}>

        {/* Header */}
        <div style={{ padding: '18px 24px 14px', borderBottom: '1px solid var(--theme-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>Feature Access · Crest {activeModule}</h3>
            <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
              {client.name} ·{' '}
              <span style={{ fontWeight: 700, color: activeColor }}>{activeModule} {activeLabel} Plan</span>
              {imsEnabled && <span style={{ marginLeft: 10, fontSize: 11, color: 'var(--theme-text3)' }}>Checkboxes override plan — check to grant, uncheck to revoke</span>}
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--theme-text2)', fontSize: 18, cursor: 'pointer', lineHeight: 1, padding: '2px 6px' }}>✕</button>
        </div>

        {/* IMS disabled — these IMS feature grants would be inert (ModuleGate blocks all IMS routes) */}
        {!imsEnabled ? (
          <div style={{ padding: '32px 24px', textAlign: 'center' }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text1)', fontWeight: 600 }}>Granular feature access applies to Crest IMS only</p>
            <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.5 }}>
              {hrEnabled && <>This client is on <strong>Crest HR</strong> (<span style={{ color: activeColor, fontWeight: 700 }}>{activeLabel}</span>) — HR access is set by its plan tier in the Modules tab, not per-feature.<br/></>}
              To manage IMS features here, enable the <strong>Crest IMS</strong> module from the client card.
            </p>
          </div>
        ) : (
        /* Body — 4-column layout, one plan tier per column, no scroll */
        <div style={{ padding: '16px 24px 8px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0 14px', alignItems: 'start' }}>
          {loading ? <p style={{ color: 'var(--theme-text2)', fontSize: 13, gridColumn: '1/-1' }}>Loading…</p> : FEATURE_GROUPS.map(group => {
            const planIncluded = isPlanIncluded(group.tier, clientPlan)
            return (
              <div key={group.tier} style={{ marginBottom: 16 }}>
                {/* Group header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: group.color, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{group.label}</span>
                  {planIncluded && group.tier !== 'core' && (
                    <span style={{ fontSize: 10, color: group.color, background: group.color + '15', border: `1px solid ${group.color}30`, borderRadius: 3, padding: '1px 6px' }}>
                      Included in {planLabel}
                    </span>
                  )}
                  {!planIncluded && (
                    <span style={{ fontSize: 10, color: 'var(--theme-text3)', background: 'var(--theme-card)', border: '1px solid var(--theme-text3)', borderRadius: 3, padding: '1px 6px' }}>
                      Not in plan — check to override
                    </span>
                  )}
                </div>

                {/* Feature list — single column, one per plan group column */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {group.features.map(feat => {
                    const isCore = feat.key === null
                    const locked = isCore || planIncluded  // plan features are always on, non-clickable
                    const isAdminGranted = !locked && flags[feat.key] === true
                    const isOn = locked || isAdminGranted

                    return (
                      <div
                        key={feat.key || feat.label}
                        onClick={() => !locked && feat.key && toggleFeat(feat.key, isAdminGranted)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          background: 'var(--theme-bg)', borderRadius: 6, padding: '6px 8px',
                          border: `1px solid ${locked ? group.color + '22' : isAdminGranted ? 'var(--theme-accent)50' : 'var(--theme-border)'}`,
                          cursor: locked ? 'default' : 'pointer',
                          transition: 'border-color 0.15s',
                        }}
                      >
                        {/* Checkbox */}
                        <div style={{
                          width: 16, height: 16, borderRadius: 3, flexShrink: 0,
                          background: isOn ? (locked ? group.color : 'var(--theme-accent)') : 'transparent',
                          border: `2px solid ${isOn ? (locked ? group.color : 'var(--theme-accent)') : 'var(--theme-text3)'}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          transition: 'all 0.15s',
                          opacity: isCore ? 0.45 : 1,
                        }}>
                          {isOn && <span style={{ color: '#000', fontSize: 10, fontWeight: 900, lineHeight: 1 }}>✓</span>}
                        </div>

                        {/* Label + badge */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontSize: 12, color: isOn ? 'var(--theme-text1)' : 'var(--theme-text2)' }}>{feat.label}</span>
                          {locked && !isCore && (
                            <span style={{
                              marginLeft: 6, fontSize: 9, fontWeight: 700, color: group.color,
                              background: group.color + '18', border: `1px solid ${group.color}35`,
                              borderRadius: 3, padding: '1px 4px', verticalAlign: 'middle',
                            }}>Plan</span>
                          )}
                          {isAdminGranted && (
                            <span style={{
                              marginLeft: 6, fontSize: 9, fontWeight: 700, color: 'var(--theme-accent)',
                              background: 'var(--theme-accent)18', border: '1px solid var(--theme-accent)35',
                              borderRadius: 3, padding: '1px 4px', verticalAlign: 'middle',
                            }}>Override</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
        )}

        {/* Footer */}
        <div style={{ padding: '12px 24px', borderTop: '1px solid var(--theme-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, color: msg.startsWith('ok:') ? 'var(--theme-green)' : msg.startsWith('error:') ? 'var(--theme-red)' : 'transparent' }}>
            {msg.replace(/^(ok|error):/, '') || '·'}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 14px' }} onClick={onClose}>Close</button>
            {imsEnabled && (
              <button className="btn btn-primary" style={{ fontSize: 12, padding: '5px 14px' }} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
const EMPTY_CLIENT_FORM = { name: '', location: '', contact_person: '', contact_phone: '' }

function relativeTime(iso) {
  if (!iso) return null
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 2)   return 'Just now'
  if (mins < 60)  return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)   return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'Yesterday'
  return `${days}d ago`
}

export default function AdminClients() {
  const [clients, setClients]         = useState([])
  const [loading, setLoading]         = useState(true)
  const [showNewForm, setShowNewForm] = useState(false)
  const [newForm, setNewForm]         = useState(EMPTY_CLIENT_FORM)
  const [saving, setSaving]           = useState(false)
  const [formError, setFormError]     = useState('')
  const [activeDrawer, setActiveDrawer] = useState(null)
  const [featureModalClient, setFeatureModalClient] = useState(null)
  const [lastSeenMap, setLastSeenMap] = useState({})
  const [lastUserMap, setLastUserMap] = useState({})

  useEffect(() => { loadClients(); loadLastSeen() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadLastSeen() {
    const { data } = await supabase.from('profiles').select('client_id, last_seen_at, full_name').not('client_id', 'is', null).not('last_seen_at', 'is', null)
    const timeMap = {}
    const userMap = {}
    for (const row of (data || [])) {
      if (!timeMap[row.client_id] || row.last_seen_at > timeMap[row.client_id]) {
        timeMap[row.client_id] = row.last_seen_at
        userMap[row.client_id] = row.full_name
      }
    }
    setLastSeenMap(timeMap)
    setLastUserMap(userMap)
  }

  async function loadClients() {
    setLoading(true)
    const { data } = await supabase.from('clients').select('*').order('name')
    const now = new Date().toISOString()
    const expired = (data || []).filter(c => {
      if (!c.is_active) return false
      // Check module-specific dates; fall back to legacy subscription_ends_at
      const moduleDates = [c.ims_ends_at, c.hr_ends_at, c.pos_ends_at].filter(Boolean)
      if (moduleDates.length > 0) {
        // Active if ANY module still has time remaining
        return moduleDates.every(d => d < now)
      }
      if (c.subscription_ends_at) return c.subscription_ends_at < now
      return !!(c.trial_ends_at && c.trial_ends_at < now)
    })
    if (expired.length > 0) {
      await Promise.all(expired.map(c =>
        supabase.from('clients').update({ is_active: false }).eq('id', c.id)
      ))
      const { data: refreshed } = await supabase.from('clients').select('*').order('name')
      setClients(refreshed || [])
    } else {
      setClients(data || [])
    }
    setLoading(false)
  }

  async function createClient() {
    if (!newForm.name.trim()) { setFormError('Client name is required.'); return }
    setSaving(true); setFormError('')
    const trialEnd = new Date()
    trialEnd.setDate(trialEnd.getDate() + 30)
    const { data: clientData, error } = await supabase.from('clients').insert({
      name: newForm.name.trim(),
      location: newForm.location.trim(),
      contact_person: newForm.contact_person.trim(),
      contact_phone: newForm.contact_phone.trim(),
      trial_ends_at: trialEnd.toISOString()
    }).select('id').single()
    if (error) { setFormError(error.message); setSaving(false); return }

    if (clientData?.id) {
      const { year: bsYear, month: bsMonth } = getBsToday()
      await Promise.all([
        // Auto-create opening period for the current BS month
        supabase.from('monthly_periods').insert({
          client_id: clientData.id,
          bs_year: bsYear,
          bs_month: bsMonth,
          status: 'open'
        }),
        // Seed settings row so client sees their own name in Settings > Branding
        supabase.from('settings').insert({
          client_id: clientData.id,
          app_name: newForm.name.trim(),
        })
      ])
    }

    setSaving(false)
    setShowNewForm(false)
    setNewForm(EMPTY_CLIENT_FORM)
    loadClients()
  }

  async function extendTrial(client) {
    const current = client.trial_expires_at ? new Date(client.trial_expires_at) : new Date()
    const base    = current > new Date() ? current : new Date()
    const newExp  = new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000)
    const newPurge= new Date(newExp.getTime() + 15 * 24 * 60 * 60 * 1000)
    await supabase.from('clients').update({
      trial_expires_at: newExp.toISOString(),
      trial_purge_at:   newPurge.toISOString(),
    }).eq('id', client.id)
    loadClients()
  }

  async function convertTrialToPaid(client) {
    // Clear trial flags; admin sets plan/sub dates in the drawer
    await supabase.from('clients').update({
      is_trial:            false,
      subscribe_requested: false,
      subscribe_requested_at: null,
    }).eq('id', client.id)
    loadClients()
    setActiveDrawer({ ...client, is_trial: false, subscribe_requested: false })
  }

  async function dismissSubscribeRequest(client) {
    await supabase.from('clients').update({ subscribe_requested: false, subscribe_requested_at: null }).eq('id', client.id)
    loadClients()
  }

  async function toggleActive(client, e) {
    e.stopPropagation()
    await supabase.from('clients').update({ is_active: !client.is_active }).eq('id', client.id)
    loadClients()
    if (activeDrawer?.id === client.id) setActiveDrawer(prev => ({ ...prev, is_active: !prev.is_active }))
  }


  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Clients</h1>
          <p className="page-subtitle">{clients.length} propert{clients.length !== 1 ? 'ies' : 'y'} on the platform</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setShowNewForm(true); setFormError('') }}>+ New Client</button>
      </div>

      {/* New client form */}
      {showNewForm && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ margin: '0 0 20px', fontSize: 15, color: 'var(--theme-text1)' }}>New Client</h3>
          <div className="form-grid form-grid-2">
            <div className="form-field">
              <label>Property / Restaurant Name *</label>
              <input value={newForm.name} onChange={e => setNewForm({ ...newForm, name: e.target.value })} placeholder="e.g. Casa Acai Cafe" autoFocus />
            </div>
            <div className="form-field">
              <label>Location</label>
              <input value={newForm.location} onChange={e => setNewForm({ ...newForm, location: e.target.value })} placeholder="e.g. Jhamsikhel, Kathmandu" />
            </div>
            <div className="form-field">
              <label>Contact Person</label>
              <input value={newForm.contact_person} onChange={e => setNewForm({ ...newForm, contact_person: e.target.value })} placeholder="Owner / Manager name" />
            </div>
            <div className="form-field">
              <label>Phone</label>
              <input value={newForm.contact_phone} onChange={e => setNewForm({ ...newForm, contact_phone: e.target.value })} placeholder="98XXXXXXXX" />
            </div>
          </div>
          {formError && <p style={{ color: 'var(--theme-red)', fontSize: 13, margin: '12px 0 0' }}>{formError}</p>}
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => { setShowNewForm(false); setNewForm(EMPTY_CLIENT_FORM) }}>Cancel</button>
            <button className="btn btn-primary" onClick={createClient} disabled={saving}>{saving ? 'Creating…' : 'Create Client'}</button>
          </div>
        </div>
      )}

      {/* ── Trial Accounts ── */}
      {(() => {
        const trialClients = clients.filter(c => c.is_trial)
        if (trialClients.length === 0) return null
        const now = new Date()
        return (
          <div style={{ marginBottom: 28, border: '2px solid #f87171', borderRadius: 12, overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ background: 'linear-gradient(135deg, #450a0a 0%, #7f1d1d 100%)', padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 18 }}>🧪</span>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#fecaca', letterSpacing: 0.3 }}>
                  Trial Accounts
                  <span style={{ marginLeft: 8, background: '#f87171', color: '#fff', borderRadius: 12, padding: '2px 8px', fontSize: 12, fontWeight: 800 }}>{trialClients.length}</span>
                </div>
                <div style={{ fontSize: 11, color: '#fca5a5', marginTop: 2 }}>
                  {trialClients.filter(c => c.subscribe_requested).length > 0
                    ? `${trialClients.filter(c => c.subscribe_requested).length} requesting to subscribe`
                    : 'Free trial users — 7 days · Starter plan'}
                </div>
              </div>
            </div>
            {/* Rows */}
            <div style={{ background: 'rgba(239,68,68,0.04)' }}>
              {trialClients.map(c => {
                const expAt   = c.trial_expires_at ? new Date(c.trial_expires_at) : null
                const purgeAt = c.trial_purge_at   ? new Date(c.trial_purge_at)   : null
                const expired = expAt && expAt < now
                const daysLeft= expAt && !expired ? Math.ceil((expAt - now) / 86400000) : null
                const purgeDays = purgeAt && expired ? Math.ceil((purgeAt - now) / 86400000) : null
                const wantsToSub = c.subscribe_requested
                return (
                  <div key={c.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px',
                    borderBottom: '1px solid rgba(239,68,68,0.12)',
                    background: wantsToSub ? 'rgba(239,68,68,0.06)' : 'transparent',
                  }}>
                    {/* Subscribe badge */}
                    {wantsToSub && (
                      <div style={{ position: 'relative', flexShrink: 0 }}>
                        <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: '#f87171', boxShadow: '0 0 0 0 rgba(248,113,113,0.5)', animation: 'pulse-dot 1.5s infinite' }} />
                      </div>
                    )}
                    {/* Info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                        {wantsToSub && (
                          <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: '#fff', background: '#ef4444', borderRadius: 8, padding: '2px 7px' }}>
                            Wants to Subscribe
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 2 }}>
                        {c.trial_start_date && (
                          <span style={{ color: 'var(--theme-text3)', marginRight: 8 }}>
                            Signed up {relativeTime(c.trial_start_date)}
                            {c.contact_person && c.contact_person !== c.name ? ` · ${c.contact_person}` : ''}
                          </span>
                        )}
                        {expired
                          ? <span style={{ color: '#f87171', fontWeight: 600 }}>
                              · Trial expired{purgeDays != null && purgeDays > 0 ? ` · data purge in ${purgeDays}d` : ' · purge imminent'}
                            </span>
                          : daysLeft != null
                            ? <span style={{ color: daysLeft <= 2 ? '#f59e0b' : 'var(--theme-text2)' }}>
                                · {daysLeft === 0 ? 'Expires today' : `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`}
                              </span>
                            : ''}
                        {c.contact_phone && (
                          <span style={{ marginLeft: 8, color: 'var(--theme-text3)' }}>
                            · 📱 <a href={`https://wa.me/977${c.contact_phone.replace(/^0/, '')}`} target="_blank" rel="noreferrer" style={{ color: 'var(--theme-green)', textDecoration: 'none' }}>{c.contact_phone}</a>
                          </span>
                        )}
                      </div>
                    </div>
                    {/* Actions */}
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      {wantsToSub && (
                        <button
                          className="btn btn-ghost"
                          style={{ fontSize: 11, padding: '4px 8px', color: 'var(--theme-text2)' }}
                          onClick={() => dismissSubscribeRequest(c)}
                          title="Mark as handled">
                          ✓ Dismiss
                        </button>
                      )}
                      <button
                        className="btn btn-ghost"
                        style={{ fontSize: 11, padding: '4px 8px' }}
                        onClick={() => extendTrial(c)}
                        title="Add 7 more days to the trial">
                        +7 Days
                      </button>
                      <button
                        className="btn btn-primary"
                        style={{ fontSize: 11, padding: '4px 10px' }}
                        onClick={() => convertTrialToPaid(c)}>
                        Convert to Paid
                      </button>
                      <button
                        className="btn btn-ghost"
                        style={{ fontSize: 11, padding: '4px 8px', color: 'var(--theme-red)' }}
                        onClick={() => setActiveDrawer(c)}>
                        Manage
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* Client cards */}
      {loading ? (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p></div>
      ) : clients.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">⊛</div>
            <p className="empty-state-text">No clients yet. Create your first property to get started.</p>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {clients.map(c => {
            const rel      = relativeTime(lastSeenMap[c.id])
            const isRecent = lastSeenMap[c.id] && Date.now() - new Date(lastSeenMap[c.id]).getTime() < 86400000
            const lastUser = lastUserMap[c.id]
            const planColor = p => p === 'pro' ? 'var(--theme-accent)' : p === 'growth' ? 'var(--theme-green)' : 'var(--theme-text3)'
            const planLabel = p => p === 'pro' ? 'Pro' : p === 'growth' ? 'Growth' : 'Starter'

            return (
              <div
                key={c.id}
                onClick={() => setActiveDrawer(c)}
                style={{
                  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 8,
                  overflow: 'hidden', cursor: 'pointer', transition: 'border-color 0.15s',
                }}
                onMouseEnter={e => e.currentTarget.style.borderColor = '#3a3f4d'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--theme-border)'}
              >
                {/* Main row */}
                <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  {/* Name + status */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>{c.name}</span>
                      <span className={`badge ${c.is_active ? 'badge-green' : 'badge-gray'}`}>{c.is_active ? 'Active' : 'Inactive'}</span>
                      {rel && (
                        <span style={{ fontSize: 11, color: isRecent ? 'var(--theme-green)' : 'var(--theme-text3)', fontWeight: isRecent ? 600 : 400 }}>
                          {rel}{lastUser && <span style={{ color: 'var(--theme-text3)', fontWeight: 400 }}> · {lastUser}</span>}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 2 }}>
                      {[c.location, c.contact_person, c.contact_phone].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>

                  {/* Module pills */}
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                    {[
                      { key: 'IMS', enabled: c.ims_enabled !== false, plan: c.plan },
                      { key: 'HR',  enabled: !!c.hr_enabled,          plan: c.hr_plan },
                    ].map(m => (
                      <span key={m.key} style={{
                        fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
                        border: `1px solid ${m.enabled ? (planColor(m.plan) === 'var(--theme-accent)' ? 'rgba(201,168,76,0.4)' : planColor(m.plan) === 'var(--theme-green)' ? 'rgba(52,211,153,0.35)' : 'rgba(107,114,128,0.35)') : 'var(--theme-border)'}`,
                        color: m.enabled ? planColor(m.plan) : 'var(--theme-text3)',
                        background: 'transparent',
                      }}>
                        {m.key}{m.enabled ? ` · ${planLabel(m.plan || 'starter')}` : ' · off'}
                      </span>
                    ))}
                  </div>

                  {/* Sub badge + Manage */}
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                    {c.billing_cycle === 'annual' && (c.ims_ends_at || c.subscription_ends_at) && (
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4, color: '#000', background: 'var(--theme-accent)' }}>Annual</span>
                    )}
                    <SubBadge client={c} />
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 11, padding: '4px 10px', color: 'var(--theme-accent)', borderColor: 'rgba(201,168,76,0.3)' }}
                      onClick={e => { e.stopPropagation(); setActiveDrawer(c) }}
                    >
                      Manage →
                    </button>
                  </div>
                </div>

                {/* Secondary action bar */}
                <div
                  style={{ padding: '6px 16px', borderTop: '1px solid var(--theme-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.15)' }}
                  onClick={e => e.stopPropagation()}
                >
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 10, padding: '2px 8px', color: '#818cf8', borderColor: 'rgba(129,140,248,0.25)' }}
                    onClick={e => { e.stopPropagation(); setFeatureModalClient(c) }}
                  >
                    Features ⊞
                  </button>
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 10, padding: '2px 8px' }}
                    onClick={e => toggleActive(c, e)}
                  >
                    {c.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Slide-over drawer */}
      {activeDrawer && (
        <ClientDrawer
          client={activeDrawer}
          onClose={() => setActiveDrawer(null)}
          onClientUpdated={() => { loadClients() }}
        />
      )}

      {/* Feature Access modal */}
      {featureModalClient && (
        <FeatureAccessModal
          client={featureModalClient}
          onClose={() => setFeatureModalClient(null)}
        />
      )}
    </div>
  )
}
