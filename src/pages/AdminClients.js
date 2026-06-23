import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { useSettings } from '../context/SettingsContext'
import { getBsToday } from '../utils/bsCalendar'
import { BsFullDatePicker } from '../components/BsDatePicker'
import { getSubStatus } from '../utils/subscription'

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
  nutrition_facts: null,
}

const FEATURE_GROUPS = [
  { tier: 'core',    label: 'Core — All Plans', color: '#6b7280', features: [
    { key: null, label: 'Dashboard' },
    { key: null, label: 'Periods' },
    { key: null, label: 'Item Master' },
    { key: null, label: 'Vendors' },
    { key: null, label: 'Purchases' },
    { key: null, label: 'Stock Count' },
  ]},
  { tier: 'starter', label: 'Starter Plan',     color: '#9ca3af', features: [
    { key: 'sales_entry',     label: 'Sales Entry' },
    { key: 'payment_summary', label: 'Payment Summary' },
    { key: 'monthly_summary', label: 'Monthly Summary' },
    { key: 'annual_summary',  label: 'Annual Summary' },
    { key: 'reorder_report',  label: 'Reorder Report' },
    { key: 'vat_report',      label: 'VAT Report' },
    { key: 'non_vat_report',  label: 'Non-VAT Report' },
    { key: 'wastage_report',  label: 'Wastage Report' },
    { key: 'settings',        label: 'Settings' },
  ]},
  { tier: 'growth',  label: 'Growth Plan',      color: '#34d399', features: [
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
  ]},
  { tier: 'pro',     label: 'Pro Plan',         color: '#c9a84c', features: [
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
  if (!s.label) return <span style={{ color: '#9ca3af', fontSize: 12 }}>—</span>
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

  // Modules tab state
  const [hrEnabled]                  = useState(client.hr_enabled || false)
  const [hrPlan, setHrPlan]         = useState(client.hr_plan || 'starter')
  const [savingIms, setSavingIms]   = useState(false)
  const [imsMsg, setImsMsg]         = useState('')
  const [savingHr, setSavingHr]     = useState(false)
  const [hrMsg, setHrMsg]           = useState('')

  // Billing tab state
  const [trialEndsAt, setTrialEndsAt] = useState(client.trial_ends_at || '')
  const [settingTrial, setSettingTrial] = useState(false)
  const [subEndsAt, setSubEndsAt] = useState(client.subscription_ends_at || '')
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
      // Don't delete the profile if the auth login survived — that would orphan it
      // and keep the email locked. Surface the failure instead.
      setUserError('Could not delete the login (email stays in use): ' + err.message)
      return
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

  // ── Modules ──
  async function handleSaveIms() {
    setSavingIms(true); setImsMsg('')
    const { error } = await supabase.from('clients').update({ plan: currentPlan }).eq('id', client.id)
    if (error) { setImsMsg('error:' + error.message) }
    else { setImsMsg('ok:Saved.'); onClientUpdated() }
    setSavingIms(false)
  }

  async function handleSaveHr() {
    setSavingHr(true); setHrMsg('')
    const { error } = await supabase.from('clients').update({
      hr_plan: hrPlan,
    }).eq('id', client.id)
    if (error) { setHrMsg('error:' + error.message) }
    else { setHrMsg('ok:Saved.'); onClientUpdated() }
    setSavingHr(false)
  }

  // ── Billing ──
  async function handleSetTrial() {
    setSettingTrial(true)
    const d = new Date()
    d.setDate(d.getDate() + 30)
    const iso = d.toISOString()
    const { error } = await supabase.from('clients').update({ trial_ends_at: iso }).eq('id', client.id)
    if (!error) { setTrialEndsAt(iso); onClientUpdated() }
    setSettingTrial(false)
  }

  function extendSub(days) {
    const d = new Date()
    d.setDate(d.getDate() + days)
    setSubEndsAt(d.toISOString())
  }

  async function handleSaveSub() {
    setSavingSub(true); setSubMsg('')
    const { error } = await supabase.from('clients').update({
      subscription_ends_at: subEndsAt || null,
      plan: currentPlan,
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
    { key: 'modules',    label: 'Modules' },
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
        background: '#181c27', borderLeft: '1px solid #2a2f3d',
        zIndex: 201, display: 'flex', flexDirection: 'column',
        boxShadow: '-8px 0 32px rgba(0,0,0,0.12)'
      }}>
        {/* Drawer header */}
        <div style={{
          padding: '20px 24px 0',
          borderBottom: '1px solid #2a2f3d'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 16, color: '#e8e0d0', fontFamily: 'Georgia, serif' }}>{client.name}</h2>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
                {client.location || 'No location'} ·{' '}
                <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 4,
                  color: client.plan === 'pro' ? '#c9a84c' : client.plan === 'growth' ? '#34d399' : '#6b7280',
                  background: client.plan === 'pro' ? 'rgba(201,168,76,0.12)' : client.plan === 'growth' ? 'rgba(52,211,153,0.10)' : 'rgba(120,113,108,0.10)',
                  border: `1px solid ${client.plan === 'pro' ? 'rgba(201,168,76,0.25)' : client.plan === 'growth' ? 'rgba(52,211,153,0.20)' : 'rgba(107,114,128,0.25)'}`,
                }}>
                  {client.plan === 'pro' ? 'Pro' : client.plan === 'growth' ? 'Growth' : 'Starter'}
                </span>
              </p>
            </div>
            <button
              onClick={onClose}
              style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 20, cursor: 'pointer', padding: 4, lineHeight: 1 }}
            >✕</button>
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', gap: 0, marginTop: 16 }}>
            {tabs.map(t => (
              <button key={t.key} onClick={() => { setActiveTab(t.key); setDeleteMsg('') }} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '8px 16px', fontSize: 13,
                color: activeTab === t.key
                  ? (t.key === 'danger' ? '#f87171' : '#c9a84c')
                  : (t.key === 'danger' ? '#9b5555' : '#6b7280'),
                borderBottom: activeTab === t.key
                  ? `2px solid ${t.key === 'danger' ? '#f87171' : '#c9a84c'}`
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
                <p style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>
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
                  <p style={{ fontSize: 12, margin: '0 0 8px', color: clientMsg.startsWith('ok:') ? '#34d399' : '#f87171' }}>
                    {clientMsg.replace(/^(ok|error):/, '')}
                  </p>
                )}
                <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={saveClientEdit} disabled={savingClient}>
                  {savingClient ? 'Saving…' : 'Update Details'}
                </button>
              </div>

              <div style={{ borderTop: '1px solid #2a2f3d', paddingTop: 20, marginBottom: 20 }}>
                <p style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>
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
                    <span style={{ fontSize: 11, color: '#6b7280', marginTop: 4, display: 'block' }}>
                      A login lives on one client at a time. If this email already has a client login, creating it here <strong>moves</strong> it to this client. To keep separate logins on the same inbox, add <code style={{ color: '#9ca3af' }}>+name</code> before the @ (e.g. you+casa@gmail.com).
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
                {userError   && <p style={{ color: '#f87171', fontSize: 12, margin: '0 0 8px' }}>{userError}</p>}
                {userSuccess && <p style={{ color: '#34d399', fontSize: 12, margin: '0 0 8px' }}>{userSuccess}</p>}
                <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={createUser} disabled={savingUser}>
                  {savingUser ? 'Creating…' : '+ Create User'}
                </button>
              </div>

              {/* Existing users */}
              <div style={{ borderTop: '1px solid #2a2f3d', paddingTop: 20 }}>
                <p style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>
                  Existing Users {loadingUsers ? '— Loading…' : `(${users.length})`}
                </p>
                {!loadingUsers && users.length === 0 && (
                  <p style={{ fontSize: 13, color: '#9ca3af' }}>No users yet for this client.</p>
                )}
                {!loadingUsers && users.map(u => (
                  <div key={u.id} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '10px 0', borderBottom: '1px solid #2a2f3d'
                  }}>
                    <div>
                      <span style={{ fontSize: 13, color: '#e8e0d0', fontWeight: 600 }}>{u.full_name || '—'}</span>
                      <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>{u.email}</span>
                      <span style={{ fontSize: 11, color: '#c9a84c', marginLeft: 8, background: 'rgba(201,168,76,0.1)', padding: '1px 6px', borderRadius: 3 }}>
                        {u.role}
                      </span>
                    </div>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 11, padding: '3px 10px', color: '#f87171', borderColor: 'rgba(248,113,113,0.25)' }}
                      onClick={() => deleteUser(u)}
                    >Delete</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── MODULES TAB ── */}
          {activeTab === 'modules' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 16px', lineHeight: 1.6 }}>
                Enable / disable modules from the client card. Set the plan tier for each enabled module here.
              </p>

              {/* IMS plan */}
              <div style={{ padding: '16px 0', borderBottom: '1px solid #2a2f3d' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                  <div style={{ minWidth: 120 }}>
                    <p style={{ margin: '0 0 2px', fontSize: 13, fontWeight: 700, color: '#e8e0d0' }}>Crest IMS</p>
                    <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>Inventory Management System</p>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                    {['starter','growth','pro'].map(p => (
                      <button key={p} onClick={() => setCurrentPlan(p)} style={{
                        padding: '4px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 700,
                        border: currentPlan === p
                          ? `1px solid ${p === 'pro' ? '#c9a84c' : p === 'growth' ? '#34d399' : '#6b7280'}`
                          : '1px solid #2a2f3d',
                        background: currentPlan === p
                          ? (p === 'pro' ? 'rgba(201,168,76,0.12)' : p === 'growth' ? 'rgba(52,211,153,0.10)' : 'rgba(120,113,108,0.10)')
                          : 'none',
                        color: currentPlan === p
                          ? (p === 'pro' ? '#c9a84c' : p === 'growth' ? '#34d399' : '#9ca3af')
                          : '#4b5563',
                      }}>
                        {p.charAt(0).toUpperCase() + p.slice(1)}
                      </button>
                    ))}
                    <button className="btn btn-primary" style={{ fontSize: 11, padding: '4px 12px' }} onClick={handleSaveIms} disabled={savingIms}>
                      {savingIms ? '…' : imsMsg.startsWith('ok:') ? '✓' : 'Save'}
                    </button>
                  </div>
                </div>
                {imsMsg && <p style={{ margin: '6px 0 0', fontSize: 11, color: imsMsg.startsWith('ok:') ? '#34d399' : '#f87171' }}>{imsMsg.replace(/^(ok|error):/, '')}</p>}
              </div>

              {/* HR plan */}
              <div style={{ padding: '16px 0', borderBottom: '1px solid #2a2f3d' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                  <div style={{ minWidth: 120 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                      <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: hrEnabled ? '#e8e0d0' : '#4b5563' }}>Crest HR</p>
                      {!hrEnabled && <span style={{ fontSize: 10, color: '#374151' }}>not enabled</span>}
                    </div>
                    <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>Human Resources</p>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, opacity: hrEnabled ? 1 : 0.35 }}>
                    {['starter','growth','pro'].map(p => (
                      <button key={p} onClick={() => hrEnabled && setHrPlan(p)} style={{
                        padding: '4px 12px', borderRadius: 4, cursor: hrEnabled ? 'pointer' : 'not-allowed', fontSize: 11, fontWeight: 700,
                        border: hrPlan === p
                          ? `1px solid ${p === 'pro' ? '#c9a84c' : p === 'growth' ? '#34d399' : '#6b7280'}`
                          : '1px solid #2a2f3d',
                        background: hrPlan === p
                          ? (p === 'pro' ? 'rgba(201,168,76,0.12)' : p === 'growth' ? 'rgba(52,211,153,0.10)' : 'rgba(120,113,108,0.10)')
                          : 'none',
                        color: hrPlan === p
                          ? (p === 'pro' ? '#c9a84c' : p === 'growth' ? '#34d399' : '#9ca3af')
                          : '#4b5563',
                      }}>
                        {p.charAt(0).toUpperCase() + p.slice(1)}
                      </button>
                    ))}
                    <button className="btn btn-primary" style={{ fontSize: 11, padding: '4px 12px' }} onClick={handleSaveHr} disabled={savingHr || !hrEnabled}>
                      {savingHr ? '…' : hrMsg.startsWith('ok:') ? '✓' : 'Save'}
                    </button>
                  </div>
                </div>
                {hrMsg && <p style={{ margin: '6px 0 0', fontSize: 11, color: hrMsg.startsWith('ok:') ? '#34d399' : '#f87171' }}>{hrMsg.replace(/^(ok|error):/, '')}</p>}
              </div>

              {/* POS plan */}
              <div style={{ padding: '16px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                      <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#4b5563' }}>Crest POS</p>
                      <span style={{ fontSize: 10, color: '#374151', fontStyle: 'italic' }}>coming soon</span>
                    </div>
                    <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>Point of Sale</p>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0, opacity: 0.25 }}>
                    {['starter','growth','pro'].map(p => (
                      <button key={p} disabled style={{
                        padding: '4px 12px', borderRadius: 4, cursor: 'not-allowed', fontSize: 11, fontWeight: 700,
                        border: '1px solid #2a2f3d', background: 'none', color: '#4b5563',
                      }}>
                        {p.charAt(0).toUpperCase() + p.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

            </div>
          )}

          {/* ── BILLING TAB ── */}
          {activeTab === 'billing' && (() => {
            const trialDays = trialEndsAt
              ? Math.ceil((new Date(trialEndsAt) - Date.now()) / 86400000)
              : null
            const subStatus = getSubStatus(client)
            return (
              <div>
                {/* Trial info */}
                <div style={{ marginBottom: 24, padding: '14px 16px', background: '#0f1117', borderRadius: 8, border: '1px solid #2a2f3d' }}>
                  <p style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 8px' }}>Free Trial (1 month)</p>
                  {trialEndsAt ? (
                    <p style={{ fontSize: 13, color: '#e8e0d0', margin: 0 }}>
                      Ends {new Date(trialEndsAt).toLocaleDateString('en-NP', { day: 'numeric', month: 'short', year: 'numeric' })}
                      {' · '}
                      <span style={{ fontWeight: 700, color: trialDays > 0 ? '#c9a84c' : '#f87171' }}>
                        {trialDays > 0 ? `${trialDays} days left` : `expired ${Math.abs(trialDays)} days ago`}
                      </span>
                    </p>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <p style={{ fontSize: 13, color: '#9ca3af', margin: 0 }}>No trial set.</p>
                      {!subEndsAt && (
                        <button
                          className="btn btn-ghost"
                          style={{ fontSize: 12 }}
                          onClick={handleSetTrial}
                          disabled={settingTrial}
                        >
                          {settingTrial ? 'Setting…' : 'Start 30-day trial'}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Current subscription status */}
                <div style={{ marginBottom: 20, padding: '14px 16px', background: '#0f1117', borderRadius: 8, border: `1px solid ${subStatus.border || '#2a2f3d'}` }}>
                  <p style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 8px' }}>Paid Subscription</p>
                  {subEndsAt ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                      <p style={{ fontSize: 13, color: '#e8e0d0', margin: 0 }}>
                        Expires {new Date(subEndsAt).toLocaleDateString('en-NP', { day: 'numeric', month: 'short', year: 'numeric' })}
                        {' · '}
                        <span style={{ fontWeight: 700, color: subStatus.color }}>{subStatus.label}</span>
                      </p>
                      <button
                        className="btn btn-ghost"
                        style={{ fontSize: 11, color: '#f87171', borderColor: 'rgba(248,113,113,0.25)', whiteSpace: 'nowrap', flexShrink: 0 }}
                        onClick={async () => {
                          if (!window.confirm('Cancel subscription for ' + client.name + '?\n\nThey will fall back to their trial period (if active), otherwise be deactivated on next page load.')) return
                          const { error } = await supabase.from('clients').update({ subscription_ends_at: null }).eq('id', client.id)
                          if (!error) { setSubEndsAt(''); setSubMsg('Subscription cancelled.'); onClientUpdated() }
                        }}
                      >
                        Cancel subscription
                      </button>
                    </div>
                  ) : (
                    <p style={{ fontSize: 13, color: '#9ca3af', margin: 0 }}>No paid subscription set.</p>
                  )}
                </div>

                {/* Activate / extend subscription */}
                <p style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px' }}>
                  {subEndsAt ? 'Extend Subscription' : 'Activate Subscription'}
                </p>

                {/* Plan selector */}
                <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 8px' }}>Plan</p>
                <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                  {[
                    { key: 'starter', label: 'Starter', monthly: 'NPR 8,000', annual: 'NPR 5,000' },
                    { key: 'growth',  label: 'Growth',  monthly: 'NPR 18,000', annual: 'NPR 10,000' },
                    { key: 'pro',     label: 'Pro',     monthly: 'NPR 25,000', annual: 'NPR 15,000' },
                  ].map(p => (
                    <button key={p.key} onClick={() => setCurrentPlan(p.key)} style={{
                      flex: 1, padding: '8px 4px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                      border: currentPlan === p.key
                        ? `1px solid ${p.key === 'pro' ? '#c9a84c' : p.key === 'growth' ? '#34d399' : '#6b7280'}`
                        : '1px solid #2a2f3d',
                      background: currentPlan === p.key
                        ? p.key === 'pro' ? 'rgba(201,168,76,0.12)' : p.key === 'growth' ? 'rgba(52,211,153,0.10)' : 'rgba(120,113,108,0.10)'
                        : 'none',
                      color: currentPlan === p.key
                        ? p.key === 'pro' ? '#c9a84c' : p.key === 'growth' ? '#34d399' : '#6b7280'
                        : '#9ca3af',
                      lineHeight: 1.4,
                    }}>
                      <div>{p.label}</div>
                      <div style={{ fontSize: 10, fontWeight: 400, marginTop: 2, opacity: 0.8 }}>{p.monthly}/mo</div>
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '0 0 16px' }}>
                  Annual rate: {currentPlan === 'pro' ? 'NPR 15,000' : currentPlan === 'growth' ? 'NPR 10,000' : 'NPR 5,000'}/mo · Quick-extend buttons apply annual pricing
                </p>

                {/* Date picker */}
                <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 8px' }}>Subscription end date</p>
                <div style={{ marginBottom: 12 }}>
                  <BsFullDatePicker value={subEndsAt} onChange={setSubEndsAt} />
                </div>
                <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 8px' }}>Quick extend from today:</p>
                <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
                  {[{ label: '+1 Month', days: 30 }, { label: '+3 Months', days: 90 }, { label: '+1 Year', days: 365 }].map(({ label, days }) => (
                    <button key={label} className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => extendSub(days)}>{label}</button>
                  ))}
                </div>

                {subMsg && (
                  <p style={{ fontSize: 12, margin: '0 0 12px', color: subMsg.startsWith('ok:') ? '#34d399' : '#f87171' }}>
                    {subMsg.replace(/^(ok|error):/, '')}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button className="btn btn-primary" style={{ fontSize: 13 }} onClick={handleSaveSub} disabled={savingSub}>
                    {savingSub ? 'Saving…' : 'Save Subscription'}
                  </button>
                  {subEndsAt && (
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 12, color: '#f87171', borderColor: 'rgba(248,113,113,0.25)' }}
                      onClick={() => { setSubEndsAt(''); setSubMsg('') }}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            )
          })()}

          {/* ── SETTINGS TAB ── */}
          {activeTab === 'settings' && (
            <div>
              {loadingSettings ? (
                <p style={{ color: '#6b7280', fontSize: 13 }}>Loading…</p>
              ) : (
                <>
                  <p style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 16px' }}>
                    Branding
                  </p>

                  {/* Logo */}
                  <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
                    <div style={{ width: 64, height: 64, borderRadius: 8, border: '1px solid #2a2f3d', background: '#0f1117', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {clientSettings.logo_url
                        ? <img src={clientSettings.logo_url} alt="logo" style={{ width: 56, height: 56, objectFit: 'contain', borderRadius: 6 }} />
                        : <span style={{ fontSize: 26, color: '#c9a84c' }}>⬡</span>
                      }
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>Logo — square PNG/JPG/SVG, max 2MB</p>
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
                          <button className="btn btn-ghost" style={{ fontSize: 11, color: '#f87171', borderColor: 'rgba(248,113,113,0.25)' }} onClick={handleLogoRemove}>
                            Remove
                          </button>
                        )}
                      </div>
                      {logoMsg && <p style={{ fontSize: 11, margin: '6px 0 0', color: logoMsg.startsWith('error') ? '#f87171' : '#34d399' }}>{logoMsg.replace(/^(ok|error):/, '')}</p>}
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

                  <p style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 16px', borderTop: '1px solid #2a2f3d', paddingTop: 16 }}>
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

                  <p style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 16px', borderTop: '1px solid #2a2f3d', paddingTop: 16 }}>
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
                    <p style={{ fontSize: 12, margin: '0 0 12px', color: settingsMsg.startsWith('ok:') ? '#34d399' : '#f87171' }}>
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
                <p style={{ color: '#6b7280', fontSize: 13 }}>Loading…</p>
              ) : (
                <>
                  <p style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px' }}>
                    Food Cost Thresholds
                  </p>
                  <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 16px', lineHeight: 1.5 }}>
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

                  <p style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px', borderTop: '1px solid #2a2f3d', paddingTop: 16 }}>
                    Alerts
                  </p>
                  <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 16px', lineHeight: 1.5 }}>
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
                    <p style={{ fontSize: 12, margin: '0 0 12px', color: settingsMsg.startsWith('ok:') ? '#34d399' : '#f87171' }}>
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
                <p style={{ fontSize: 13, color: '#f87171', fontWeight: 700, margin: '0 0 6px' }}>⚠ Danger Zone</p>
                <p style={{ fontSize: 12, color: '#6b7280', margin: 0, lineHeight: 1.65 }}>
                  This permanently deletes all operational data for{' '}
                  <strong style={{ color: '#e8e0d0' }}>{client.name}</strong>:{' '}
                  categories, items, vendors, recipes, purchases, stock, sales, overheads, and all periods.
                  The client record, user accounts, feature flags, and settings are kept intact.
                  <br /><strong style={{ color: '#f87171' }}>This cannot be undone.</strong>
                </p>
              </div>

              {deleteMsg && (
                <p style={{ fontSize: 12, margin: '0 0 16px', color: deleteMsg.startsWith('ok:') ? '#34d399' : '#f87171' }}>
                  {deleteMsg.replace(/^(ok|error):/, '')}
                </p>
              )}

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button
                  onClick={handleClearConversions}
                  disabled={deleting}
                  style={{
                    background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.15)',
                    color: '#f87171', borderRadius: 6, padding: '9px 18px',
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
                    color: '#f87171', borderRadius: 6, padding: '9px 18px',
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
                    color: '#f87171', borderRadius: 6, padding: '9px 18px',
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

  const clientPlan = client.plan || 'starter'
  const planColor  = clientPlan === 'pro' ? '#c9a84c' : clientPlan === 'growth' ? '#34d399' : '#9ca3af'
  const planLabel  = clientPlan.charAt(0).toUpperCase() + clientPlan.slice(1)

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
      <div style={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 12, width: 'min(1120px, 96vw)', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.4)' }}>

        {/* Header */}
        <div style={{ padding: '18px 24px 14px', borderBottom: '1px solid #2a2f3d', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15, color: '#e8e0d0', fontFamily: 'Georgia, serif' }}>Feature Access</h3>
            <p style={{ margin: '3px 0 0', fontSize: 12, color: '#6b7280' }}>
              {client.name} ·{' '}
              <span style={{ fontWeight: 700, color: planColor }}>{planLabel} Plan</span>
              <span style={{ marginLeft: 10, fontSize: 11, color: '#4b5563' }}>Checkboxes override plan — check to grant, uncheck to revoke</span>
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 18, cursor: 'pointer', lineHeight: 1, padding: '2px 6px' }}>✕</button>
        </div>

        {/* Body — 4-column layout, one plan tier per column, no scroll */}
        <div style={{ padding: '16px 24px 8px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0 14px', alignItems: 'start' }}>
          {loading ? <p style={{ color: '#6b7280', fontSize: 13, gridColumn: '1/-1' }}>Loading…</p> : FEATURE_GROUPS.map(group => {
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
                    <span style={{ fontSize: 10, color: '#4b5563', background: '#1f2937', border: '1px solid #374151', borderRadius: 3, padding: '1px 6px' }}>
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
                          background: '#0f1117', borderRadius: 6, padding: '6px 8px',
                          border: `1px solid ${locked ? group.color + '22' : isAdminGranted ? '#c9a84c50' : '#2a2f3d'}`,
                          cursor: locked ? 'default' : 'pointer',
                          transition: 'border-color 0.15s',
                        }}
                      >
                        {/* Checkbox */}
                        <div style={{
                          width: 16, height: 16, borderRadius: 3, flexShrink: 0,
                          background: isOn ? (locked ? group.color : '#c9a84c') : 'transparent',
                          border: `2px solid ${isOn ? (locked ? group.color : '#c9a84c') : '#4b5563'}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          transition: 'all 0.15s',
                          opacity: isCore ? 0.45 : 1,
                        }}>
                          {isOn && <span style={{ color: '#000', fontSize: 10, fontWeight: 900, lineHeight: 1 }}>✓</span>}
                        </div>

                        {/* Label + badge */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontSize: 12, color: isOn ? '#e8e0d0' : '#6b7280' }}>{feat.label}</span>
                          {locked && !isCore && (
                            <span style={{
                              marginLeft: 6, fontSize: 9, fontWeight: 700, color: group.color,
                              background: group.color + '18', border: `1px solid ${group.color}35`,
                              borderRadius: 3, padding: '1px 4px', verticalAlign: 'middle',
                            }}>Plan</span>
                          )}
                          {isAdminGranted && (
                            <span style={{
                              marginLeft: 6, fontSize: 9, fontWeight: 700, color: '#c9a84c',
                              background: '#c9a84c18', border: '1px solid #c9a84c35',
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

        {/* Footer */}
        <div style={{ padding: '12px 24px', borderTop: '1px solid #2a2f3d', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, color: msg.startsWith('ok:') ? '#34d399' : msg.startsWith('error:') ? '#f87171' : 'transparent' }}>
            {msg.replace(/^(ok|error):/, '') || '·'}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 14px' }} onClick={onClose}>Close</button>
            <button className="btn btn-primary" style={{ fontSize: 12, padding: '5px 14px' }} onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
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
    const expired = (data || []).filter(c =>
      c.is_active && (
        (c.subscription_ends_at && c.subscription_ends_at < now) ||
        (!c.subscription_ends_at && c.trial_ends_at && c.trial_ends_at < now)
      )
    )
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

  async function toggleActive(client, e) {
    e.stopPropagation()
    await supabase.from('clients').update({ is_active: !client.is_active }).eq('id', client.id)
    loadClients()
    if (activeDrawer?.id === client.id) setActiveDrawer(prev => ({ ...prev, is_active: !prev.is_active }))
  }

  async function toggleImsEnabled(client, e) {
    e.stopPropagation()
    if (client.ims_enabled !== false) {
      const ok = window.confirm(
        `Disable Crest IMS for "${client.name}"?\n\n` +
        `The client will immediately lose access to all IMS pages — dashboard, items, purchases, stock, recipes, and reports.\n\n` +
        `No data is deleted. Re-enabling restores full access instantly.`
      )
      if (!ok) return
    }
    await supabase.from('clients').update({ ims_enabled: client.ims_enabled !== false ? false : true }).eq('id', client.id)
    loadClients()
  }

  async function toggleHrEnabled(client, e) {
    e.stopPropagation()
    const newVal = !client.hr_enabled
    await supabase.from('clients').update({
      hr_enabled: newVal,
      hr_plan: newVal ? (client.hr_plan || 'starter') : null,
    }).eq('id', client.id)
    loadClients()
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
          <h3 style={{ margin: '0 0 20px', fontSize: 15, color: '#e8e0d0' }}>New Client</h3>
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
          {formError && <p style={{ color: '#f87171', fontSize: 13, margin: '12px 0 0' }}>{formError}</p>}
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => { setShowNewForm(false); setNewForm(EMPTY_CLIENT_FORM) }}>Cancel</button>
            <button className="btn btn-primary" onClick={createClient} disabled={saving}>{saving ? 'Creating…' : 'Create Client'}</button>
          </div>
        </div>
      )}

      {/* Client cards */}
      {loading ? (
        <div className="card"><p style={{ color: '#6b7280', fontSize: 13 }}>Loading…</p></div>
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
            const planColor = p => p === 'pro' ? '#c9a84c' : p === 'growth' ? '#34d399' : '#9ca3af'
            const planLabel = p => p === 'pro' ? 'Pro' : p === 'growth' ? 'Growth' : 'Starter'

            return (
              <div
                key={c.id}
                onClick={() => setActiveDrawer(c)}
                style={{
                  background: '#141820', border: '1px solid #2a2f3d', borderRadius: 10,
                  overflow: 'hidden', cursor: 'pointer',
                  transition: 'border-color 0.15s',
                }}
                onMouseEnter={e => e.currentTarget.style.borderColor = '#3a3f4d'}
                onMouseLeave={e => e.currentTarget.style.borderColor = '#2a2f3d'}
              >
                {/* Header row */}
                <div style={{ padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: '#e8e0d0', fontFamily: 'Georgia, serif' }}>{c.name}</span>
                      <span className={`badge ${c.is_active ? 'badge-green' : 'badge-gray'}`}>
                        {c.is_active ? 'Active' : 'Inactive'}
                      </span>
                      {rel && (
                        <span style={{ fontSize: 11, color: isRecent ? '#34d399' : '#6b7280', fontWeight: isRecent ? 600 : 400 }}>
                          {rel}
                          {lastUser && (
                            <span style={{ color: '#6b7280', fontWeight: 400 }}> · {lastUser}</span>
                          )}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>
                      {[c.location, c.contact_person, c.contact_phone].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                  <SubBadge client={c} />
                </div>

                {/* Module strip */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', borderTop: '1px solid #2a2f3d' }}>
                  {/* IMS */}
                  <div style={{ padding: '10px 18px', borderRight: '1px solid #2a2f3d' }} onClick={e => e.stopPropagation()}>
                    <div style={{ fontSize: 10, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>IMS</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button
                        onClick={e => toggleImsEnabled(c, e)}
                        style={{
                          width: 32, height: 18, borderRadius: 9, border: 'none', cursor: 'pointer',
                          position: 'relative', flexShrink: 0, padding: 0,
                          background: c.ims_enabled !== false ? '#34d399' : '#374151', transition: 'background 0.2s',
                        }}
                      >
                        <span style={{
                          position: 'absolute', top: 2, left: c.ims_enabled !== false ? 15 : 2,
                          width: 14, height: 14, borderRadius: '50%', background: '#fff', transition: 'left 0.2s',
                        }} />
                      </button>
                      {c.ims_enabled !== false ? (
                        <span style={{ fontSize: 12, fontWeight: 700, color: planColor(c.plan) }}>
                          {planLabel(c.plan || 'starter')}
                        </span>
                      ) : (
                        <span style={{ fontSize: 12, color: '#374151' }}>Not enabled</span>
                      )}
                    </div>
                  </div>

                  {/* HR */}
                  <div style={{ padding: '10px 18px', borderRight: '1px solid #2a2f3d' }} onClick={e => e.stopPropagation()}>
                    <div style={{ fontSize: 10, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>HR</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button
                        onClick={e => toggleHrEnabled(c, e)}
                        style={{
                          width: 32, height: 18, borderRadius: 9, border: 'none', cursor: 'pointer',
                          position: 'relative', flexShrink: 0, padding: 0,
                          background: c.hr_enabled ? '#34d399' : '#374151', transition: 'background 0.2s',
                        }}
                      >
                        <span style={{
                          position: 'absolute', top: 2, left: c.hr_enabled ? 15 : 2,
                          width: 14, height: 14, borderRadius: '50%', background: '#fff', transition: 'left 0.2s',
                        }} />
                      </button>
                      {c.hr_enabled ? (
                        <span style={{ fontSize: 12, fontWeight: 700, color: planColor(c.hr_plan) }}>
                          {planLabel(c.hr_plan || 'starter')}
                        </span>
                      ) : (
                        <span style={{ fontSize: 12, color: '#374151' }}>Not enabled</span>
                      )}
                    </div>
                  </div>

                  {/* POS */}
                  <div style={{ padding: '10px 18px' }}>
                    <div style={{ fontSize: 10, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>POS</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button
                        disabled
                        style={{
                          width: 32, height: 18, borderRadius: 9, border: 'none', cursor: 'not-allowed',
                          position: 'relative', flexShrink: 0, padding: 0,
                          background: '#1f2937', opacity: 0.45,
                        }}
                      >
                        <span style={{ position: 'absolute', top: 2, left: 2, width: 14, height: 14, borderRadius: '50%', background: '#4b5563' }} />
                      </button>
                      <span style={{ fontSize: 12, color: '#374151', fontStyle: 'italic' }}>Coming soon</span>
                    </div>
                  </div>
                </div>

                {/* Action footer */}
                <div
                  style={{ padding: '10px 18px', borderTop: '1px solid #2a2f3d', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#0f1117' }}
                  onClick={e => e.stopPropagation()}
                >
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 11, padding: '4px 10px', color: '#818cf8', borderColor: 'rgba(129,140,248,0.3)' }}
                    onClick={e => { e.stopPropagation(); setFeatureModalClient(c) }}
                  >
                    Features ⊞
                  </button>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 11, padding: '4px 10px' }}
                      onClick={e => toggleActive(c, e)}
                    >
                      {c.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 11, padding: '4px 10px', color: '#c9a84c', borderColor: 'rgba(201,168,76,0.3)' }}
                      onClick={e => { e.stopPropagation(); setActiveDrawer(c) }}
                    >
                      Manage →
                    </button>
                  </div>
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
