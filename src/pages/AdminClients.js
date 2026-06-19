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
  if (error) throw new Error(error.message || 'Edge function error')
  if (data?.error) throw new Error(data.error.message || data.error || 'Admin op failed')
  return data
}

const EMPTY_USER = { email: '', password: '', full_name: '' }

const DEFAULT_FLAGS = {
  sales_entry: false, monthly_summary: false, payment_summary: false,
  vendor_report: false, variance_report: false, fifo_report: false,
  reorder_report: false, price_tracker: false, recipe_costing: false,
  menu_engineering: false, overheads: false, budget_vs_actual: false,
  best_sellers: false,
  vat_report: false,
  non_vat_report: false,
  purchase_orders: false,
  requisitions: false,
  wastage_report: false,
  dead_stock: false,
  recipe_margin: false,
  period_comparison: false,
  theoretical_variance: false,
}

const FLAG_LABELS = {
  // Main workflow features
  sales_entry:      { label: 'Sales Entry',      section: 'Main' },
  recipe_costing:   { label: 'Recipe Costing',   section: 'Main' },
  menu_engineering: { label: 'Menu Engineering', section: 'Main' },
  overheads:        { label: 'Overheads',        section: 'Main' },
  purchase_orders:  { label: 'Purchase Orders',  section: 'Main' },
  requisitions:     { label: 'Requisitions',     section: 'Main' },
  // Starter reports — all plans
  monthly_summary:  { label: 'Monthly Summary',  section: 'Starter' },
  reorder_report:   { label: 'Reorder Report',   section: 'Starter' },
  vat_report:       { label: 'VAT Report',       section: 'Starter' },
  non_vat_report:   { label: 'Non-VAT Report',   section: 'Starter' },
  wastage_report:   { label: 'Wastage Report',   section: 'Starter' },
  // Growth reports
  payment_summary:  { label: 'Payment Summary',      section: 'Reports' },
  variance_report:  { label: 'Variance Report',      section: 'Reports' },
  budget_vs_actual: { label: 'Budget vs Actual',     section: 'Reports' },
  best_sellers:     { label: 'Best & Worst Sellers', section: 'Reports' },
  dead_stock:       { label: 'Dead Stock',           section: 'Reports' },
  recipe_margin:    { label: 'Recipe Margin',        section: 'Reports' },
  // Pro reports
  vendor_report:        { label: 'Vendor Report',        section: 'Pro' },
  fifo_report:          { label: 'FIFO / Expiry',        section: 'Pro' },
  price_tracker:        { label: 'Price Tracker',        section: 'Pro' },
  theoretical_variance: { label: 'Theoretical Variance', section: 'Pro' },
  period_comparison:    { label: 'Period Comparison',    section: 'Pro' },
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
  const { loadClientSettings, saveClientSettings, loadClientFeatureFlags, saveFeatureFlags } = useSettings()
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

  // Feature Access tab state
  const [flags, setFlags]             = useState(DEFAULT_FLAGS)
  const [loadingFlags, setLoadingFlags] = useState(false)
  const [savingFlags, setSavingFlags] = useState(false)
  const [flagsMsg, setFlagsMsg]       = useState('')

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

  async function handleChangePlan(newPlan) {
    const { error } = await supabase.from('clients').update({ plan: newPlan }).eq('id', client.id)
    if (error) { alert('Update failed: ' + error.message); return }
    setCurrentPlan(newPlan)
    onClientUpdated()
  }

  useEffect(() => {
    loadUsers()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id])

  useEffect(() => {
    if (activeTab === 'settings' || activeTab === 'thresholds') fetchClientSettings()
    if (activeTab === 'features') fetchFlags()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  // ── Users ──
  async function loadUsers() {
    setLoadingUsers(true)
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, role, client_id')
      .eq('client_id', client.id)
    const enriched = await Promise.all((data || []).map(async u => {
      try {
        const result = await adminOp('getUser', { userId: u.id })
        return { ...u, email: result?.data?.user?.email || '' }
      } catch {
        return { ...u, email: '' }
      }
    }))
    setUsers(enriched)
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

    let authData
    try {
      const result = await adminOp('createUser', {
        email: userForm.email.trim(),
        password: userForm.password.trim(),
        full_name: userForm.full_name.trim(),
      })
      authData = result?.data
    } catch (err) {
      setUserError('Could not create user: ' + err.message)
      setSavingUser(false)
      return
    }

    const { error: profileError } = await supabase
      .from('profiles')
      .update({ client_id: client.id, full_name: userForm.full_name.trim(), role: 'client' })
      .eq('id', authData.user.id)
    if (profileError) { setUserError('User created but profile link failed: ' + profileError.message); setSavingUser(false); return }

    setUserSuccess(`✓ ${userForm.email.trim()} created and linked.`)
    setUserForm(EMPTY_USER)
    setSavingUser(false)
    loadUsers()
  }

  async function deleteUser(user) {
    if (!window.confirm(`Delete "${user.full_name}" (${user.email})? This cannot be undone.`)) return
    try {
      await adminOp('deleteUser', { userId: user.id })
    } catch (err) {
      alert('Auth deletion failed: ' + err.message + '\nProfile entry will still be removed.')
    }
    await supabase.from('profiles').delete().eq('id', user.id)
    setUserSuccess('✓ User deleted.')
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

  // ── Feature flags ──
  async function fetchFlags() {
    setLoadingFlags(true)
    const data = await loadClientFeatureFlags(client.id)
    setFlags({ ...DEFAULT_FLAGS, ...data })
    setLoadingFlags(false)
  }

  async function handleSaveFlags() {
    setSavingFlags(true); setFlagsMsg('')
    try {
      await saveFeatureFlags(client.id, flags)
      setFlagsMsg('ok:Feature access saved.')
    } catch (e) {
      setFlagsMsg('error:' + e.message)
    }
    setSavingFlags(false)
  }

  function toggleAllFlags(val) {
    const updated = {}
    Object.keys(DEFAULT_FLAGS).forEach(k => { updated[k] = val })
    setFlags(updated)
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

  const mainFlags    = Object.entries(FLAG_LABELS).filter(([, v]) => v.section === 'Main')
  const starterFlags = Object.entries(FLAG_LABELS).filter(([, v]) => v.section === 'Starter')
  const reportFlags  = Object.entries(FLAG_LABELS).filter(([, v]) => v.section === 'Reports')
  const proFlags     = Object.entries(FLAG_LABELS).filter(([, v]) => v.section === 'Pro')

  const tabs = [
    { key: 'users',       label: 'Users' },
    { key: 'billing',     label: 'Billing' },
    { key: 'settings',    label: 'Settings' },
    { key: 'thresholds',  label: 'Thresholds' },
    { key: 'features',    label: 'Feature Access' },
    { key: 'danger',      label: '⚠ Danger' },
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

          {/* ── FEATURE ACCESS TAB ── */}
          {activeTab === 'features' && (
            <div>
              {loadingFlags ? (
                <p style={{ color: '#6b7280', fontSize: 13 }}>Loading…</p>
              ) : (
                <>
                  {/* Plan selector */}
                  <div style={{ marginBottom: 20, padding: '12px 16px', background: '#0f1117', borderRadius: 8, border: '1px solid #2a2f3d' }}>
                    <p style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px' }}>Client Plan</p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {['starter', 'growth', 'pro'].map(p => (
                        <button key={p} onClick={() => handleChangePlan(p)} style={{
                          flex: 1, padding: '7px 0', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                          border: currentPlan === p
                            ? `1px solid ${p === 'pro' ? '#c9a84c' : p === 'growth' ? '#34d399' : '#6b7280'}`
                            : '1px solid #2a2f3d',
                          background: currentPlan === p
                            ? p === 'pro' ? 'rgba(201,168,76,0.12)' : p === 'growth' ? 'rgba(52,211,153,0.10)' : 'rgba(120,113,108,0.10)'
                            : 'none',
                          color: currentPlan === p
                            ? p === 'pro' ? '#c9a84c' : p === 'growth' ? '#34d399' : '#6b7280'
                            : '#9ca3af',
                        }}>
                          {p.charAt(0).toUpperCase() + p.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {(currentPlan === 'growth' || currentPlan === 'pro') && (
                    <div style={{
                      background: 'rgba(201,168,76,0.08)', border: '1px solid rgba(201,168,76,0.2)',
                      borderRadius: 8, padding: '10px 14px', marginBottom: 20
                    }}>
                      <p style={{ fontSize: 12, color: '#c9a84c', margin: 0 }}>
                        {currentPlan === 'pro'
                          ? 'Pro client — all features unlocked. Feature flags only apply to Starter clients.'
                          : 'Growth client — Growth features unlocked. Flag individual Pro features below if needed.'}
                      </p>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
                    <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => toggleAllFlags(true)}>Enable All</button>
                    <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => toggleAllFlags(false)}>Disable All</button>
                  </div>

                  {/* Main workflow features */}
                  <p style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>
                    Main Features
                  </p>
                  {mainFlags.map(([key, meta]) => (
                    <FeatureToggle key={key} featureKey={key} label={meta.label} flags={flags} setFlags={setFlags} disabled={client.is_premium} />
                  ))}

                  {/* Starter reports — included on all plans */}
                  <p style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '20px 0 4px', borderTop: '1px solid #2a2f3d', paddingTop: 16 }}>
                    Starter Reports
                  </p>
                  <p style={{ fontSize: 11, color: '#4b5563', margin: '0 0 12px' }}>Included on all plans — toggle to grant/revoke individually</p>
                  {starterFlags.map(([key, meta]) => (
                    <FeatureToggle key={key} featureKey={key} label={meta.label} flags={flags} setFlags={setFlags} disabled={client.is_premium} />
                  ))}

                  {/* Growth reports */}
                  <p style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '20px 0 4px', borderTop: '1px solid #2a2f3d', paddingTop: 16 }}>
                    Growth Reports
                  </p>
                  <p style={{ fontSize: 11, color: '#4b5563', margin: '0 0 12px' }}>Auto-unlocked on Growth + Pro plans</p>
                  {reportFlags.map(([key, meta]) => (
                    <FeatureToggle key={key} featureKey={key} label={meta.label} flags={flags} setFlags={setFlags} disabled={client.is_premium} />
                  ))}

                  {/* Pro reports */}
                  <p style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '20px 0 4px', borderTop: '1px solid #2a2f3d', paddingTop: 16 }}>
                    Pro Reports
                  </p>
                  <p style={{ fontSize: 11, color: '#4b5563', margin: '0 0 12px' }}>Auto-unlocked on Pro plan only</p>
                  {proFlags.map(([key, meta]) => (
                    <FeatureToggle key={key} featureKey={key} label={meta.label} flags={flags} setFlags={setFlags} disabled={client.is_premium} />
                  ))}

                  {flagsMsg && (
                    <p style={{ fontSize: 12, margin: '16px 0 8px', color: flagsMsg.startsWith('ok:') ? '#34d399' : '#f87171' }}>
                      {flagsMsg.replace(/^(ok|error):/, '')}
                    </p>
                  )}
                  <div style={{ marginTop: 20 }}>
                    <button className="btn btn-primary" style={{ fontSize: 13 }} onClick={handleSaveFlags} disabled={savingFlags || client.is_premium}>
                      {savingFlags ? 'Saving…' : 'Save Feature Access'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function FeatureToggle({ featureKey, label, flags, setFlags, disabled }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '10px 0', borderBottom: '1px solid #2a2f3d'
    }}>
      <span style={{ fontSize: 13, color: disabled ? '#9ca3af' : '#e8e0d0' }}>{label}</span>
      <button
        onClick={() => !disabled && setFlags(prev => ({ ...prev, [featureKey]: !prev[featureKey] }))}
        style={{
          width: 42, height: 22, borderRadius: 11, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
          background: flags[featureKey] ? '#c9a84c' : '#2a2f3d',
          position: 'relative', transition: 'background 0.2s', flexShrink: 0
        }}
      >
        <span style={{
          position: 'absolute', top: 3, left: flags[featureKey] ? 22 : 3,
          width: 16, height: 16, borderRadius: '50%', background: '#fff',
          transition: 'left 0.2s', display: 'block'
        }} />
      </button>
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
  const [activeDrawer, setActiveDrawer] = useState(null) // client object
  const [lastSeenMap, setLastSeenMap] = useState({}) // { clientId: isoString }

  useEffect(() => { loadClients(); loadLastSeen() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadLastSeen() {
    const { data } = await supabase.from('profiles').select('client_id, last_seen_at').not('client_id', 'is', null).not('last_seen_at', 'is', null)
    const map = {}
    for (const row of (data || [])) {
      if (!map[row.client_id] || row.last_seen_at > map[row.client_id]) map[row.client_id] = row.last_seen_at
    }
    setLastSeenMap(map)
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

  async function changePlan(client, newPlan, e) {
    e.stopPropagation()
    const { error } = await supabase.from('clients').update({ plan: newPlan }).eq('id', client.id)
    if (error) { alert('Update failed: ' + error.message); return }
    await loadClients()
    if (activeDrawer?.id === client.id) setActiveDrawer(prev => ({ ...prev, plan: newPlan }))
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

      {/* Clients table */}
      <div className="card">
        {loading ? (
          <p style={{ color: '#6b7280', fontSize: 13 }}>Loading…</p>
        ) : clients.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">⊛</div>
            <p className="empty-state-text">No clients yet. Create your first property to get started.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Property Name</th>
                  <th>Location</th>
                  <th>Contact</th>
                  <th>Status</th>
                  <th>Last Seen</th>
                  <th>Plan</th>
                  <th>Expires</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {clients.map(c => (
                  <tr
                    key={c.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setActiveDrawer(c)}
                  >
                    <td style={{ fontWeight: 600, color: '#e8e0d0' }}>{c.name}</td>
                    <td>{c.location || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                    <td>
                      <div style={{ fontSize: 13 }}>{c.contact_person || <span style={{ color: '#9ca3af' }}>—</span>}</div>
                      {c.contact_phone && <div style={{ fontSize: 11, color: '#6b7280' }}>{c.contact_phone}</div>}
                    </td>
                    <td>
                      <span className={`badge ${c.is_active ? 'badge-green' : 'badge-gray'}`}>
                        {c.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      {(() => {
                        const rel = relativeTime(lastSeenMap[c.id])
                        const isRecent = lastSeenMap[c.id] && Date.now() - new Date(lastSeenMap[c.id]).getTime() < 86400000
                        return rel
                          ? <span style={{ fontSize: 12, color: isRecent ? '#34d399' : '#6b7280', fontWeight: isRecent ? 600 : 400 }}>{rel}</span>
                          : <span style={{ color: '#374151', fontSize: 12 }}>Never</span>
                      })()}
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      <select
                        value={c.plan || 'starter'}
                        onChange={e => changePlan(c, e.target.value, e)}
                        style={{
                          background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 5,
                          color: c.plan === 'pro' ? '#c9a84c' : c.plan === 'growth' ? '#34d399' : '#6b7280',
                          fontSize: 12, fontWeight: 700, padding: '4px 8px', cursor: 'pointer',
                        }}>
                        <option value="starter">Starter</option>
                        <option value="growth">Growth</option>
                        <option value="pro">Pro</option>
                      </select>
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      <SubBadge client={c} />
                    </td>
                    <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                          onClick={e => toggleActive(c, e)}>
                          {c.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                        <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px', color: '#c9a84c', borderColor: 'rgba(201,168,76,0.3)' }}
                          onClick={e => { e.stopPropagation(); setActiveDrawer(c) }}>
                          Manage →
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Slide-over drawer */}
      {activeDrawer && (
        <ClientDrawer
          client={activeDrawer}
          onClose={() => setActiveDrawer(null)}
          onClientUpdated={() => { loadClients() }}
        />
      )}
    </div>
  )
}
