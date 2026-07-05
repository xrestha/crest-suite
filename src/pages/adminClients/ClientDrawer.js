import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { supabase } from '../../supabaseClient'
import { scopedFrom, scopedUpdate, scopedDelete } from '../../shared/scopedDb'
import { useSettings } from '../../context/SettingsContext'
import { formatAd } from '../../utils/bsCalendar'
import BsCalendarPicker from '../../components/BsCalendarPicker'
import { getDateStatus } from '../../utils/subscription'
import { validateEmvQr } from '../../utils/emvQr'
import Tip from '../../components/Tip'
import { adminOp } from './adminOp'

const EMPTY_USER = { email: '', password: '', full_name: '' }

const SETTINGS_DEFAULTS = {
  app_name: '', app_tagline: '', property_address: '', property_phone: '',
  property_email: '', vat_number: '', fc_warning_pct: 35, fc_critical_pct: 45,
  expiry_warning_days: 7, variance_flag_pct: 10, item_code_prefix: 'ITM',
  contact_phone: '', contact_email: '', contact_website: '',
  is_vat_registered: true, invoice_prefix: '', payment_qr_data: ''
}

// Derives a short invoice-number prefix from the property/business name, e.g. "Casa Acai Cafe" -> "CAC"
function deriveInvoicePrefix(name) {
  if (!name) return ''
  return name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 5)
}

export default function ClientDrawer({ client, onClose, onClientUpdated }) {
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

  // QR tab state
  const [qrPreview, setQrPreview] = useState('')
  const qrCheck = validateEmvQr(clientSettings.payment_qr_data || '')
  useEffect(() => {
    if (!qrCheck.ok) { setQrPreview(''); return }
    QRCode.toDataURL(clientSettings.payment_qr_data.trim(), { margin: 1, width: 180 })
      .then(setQrPreview).catch(() => setQrPreview(''))
  }, [clientSettings.payment_qr_data]) // eslint-disable-line

  // Modules state
  const [imsEnabled, setImsEnabled] = useState(client.ims_enabled !== false)
  const [hrEnabled,  setHrEnabled]  = useState(!!client.hr_enabled)
  const [hrPlan,  setHrPlan]        = useState(client.hr_plan  || 'starter')
  const [posEnabled, setPosEnabled] = useState(!!client.pos_enabled)
  const [posPlan, setPosPlan]       = useState(client.pos_plan || 'starter')

  // Billing tab state — per-module end dates; fall back to legacy subscription_ends_at for IMS
  const _legacyEnd = client.subscription_ends_at ? formatAd(new Date(client.subscription_ends_at)) : ''
  const [imsEndsAt, setImsEndsAt] = useState(client.ims_ends_at ? formatAd(new Date(client.ims_ends_at)) : _legacyEnd)
  const [hrEndsAt,  setHrEndsAt]  = useState(client.hr_ends_at  ? formatAd(new Date(client.hr_ends_at))  : '')
  const [posEndsAt, setPosEndsAt] = useState(client.pos_ends_at ? formatAd(new Date(client.pos_ends_at)) : '')
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
    if (activeTab === 'settings' || activeTab === 'thresholds' || activeTab === 'qr') fetchClientSettings()
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
    if (data) {
      setClientSettings(prev => {
        const merged = { ...prev, ...data }
        if (!merged.invoice_prefix && merged.app_name) merged.invoice_prefix = deriveInvoicePrefix(merged.app_name)
        return merged
      })
    }
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

  async function handleTogglePos() {
    const next = !posEnabled
    setPosEnabled(next)
    await supabase.from('clients').update({ pos_enabled: next }).eq('id', client.id)
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
      pos_plan:      posPlan,
      billing_cycle: billingCycle,
    }).eq('id', client.id)
    if (error) { setSubMsg('error:' + error.message) }
    else { setSubMsg('ok:Subscription saved.'); onClientUpdated() }
    setSavingSub(false)
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
    setDeleting(true); setDeleteMsg('')
    const { error } = await scopedUpdate('items', client.id, { purchase_unit: null, base_unit: null, conversion_factor: 1, purchase_qty: 1 })
      .not('purchase_unit', 'is', null)
    setDeleting(false)
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
    setDeleting(true)
    setDeleteMsg('')
    try {
      await adminOp('clearModuleData', { clientId: client.id, module })
      setDeleteMsg(`ok:${module.toUpperCase()} transactions cleared. Setup data was kept.`)
    } catch (err) {
      setDeleteMsg('error:' + err.message)
    }
    setDeleting(false)
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
      await scopedDelete('feature_flags', client.id)
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
    { key: 'qr',         label: 'QR' },
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
                    <label><Tip text="City or area where this property operates. Shown on reports and helps identify multi-location clients.">Location</Tip></label>
                    <input value={editForm.location} onChange={e => setEditForm({ ...editForm, location: e.target.value })} />
                  </div>
                  <div className="form-field">
                    <label><Tip text="Primary contact — owner or manager name used for billing and support correspondence.">Contact Person</Tip></label>
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
                    { key: 'pos', label: 'Crest POS', sub: 'Point of Sale',        enabled: posEnabled, toggle: handleTogglePos  },
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
                </div>

                {/* Billing cycle toggle */}
                <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 8px' }}>
                  <Tip text="Whether this client pays monthly or annually. Annual plans discount the monthly rate by 25%.">Billing Cycle</Tip>
                </p>
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
                  { key: 'pos', label: 'Crest POS', enabled: posEnabled, plan: posPlan,     setPlan: setPosPlan,     endsAt: posEndsAt, setEndsAt: setPosEndsAt },
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
                      <p style={{ fontSize: 11, color: 'var(--theme-text2)', margin: '0 0 6px' }}>
                        <Tip text="Date when this module's subscription expires. Client sees a warning in the last 7 days and is blocked after expiry." width={300}>Subscription end date</Tip>
                      </p>
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
                      <label><Tip text="Client's VAT registration number, printed on invoices and used for IRD compliance reporting.">VAT Number</Tip></label>
                      <input value={clientSettings.vat_number || ''} onChange={e => setClientSettings({ ...clientSettings, vat_number: e.target.value })} />
                    </div>
                    <div className="form-field">
                      <label><Tip text="On = POS bills print as a Tax Invoice with VAT breakdown (invoice numbers prefixed TI-). Off = plain Bill, no VAT line, PAN number only (prefixed PB-). Matches whether this client is actually VAT-registered with IRD.">VAT Registered</Tip></label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', height: 34 }}>
                        <input type="checkbox" checked={clientSettings.is_vat_registered ?? true}
                          onChange={e => setClientSettings({ ...clientSettings, is_vat_registered: e.target.checked })}
                          style={{ width: 16, height: 16, padding: 0, margin: 0, flexShrink: 0, background: 'none', border: 'none', accentColor: 'var(--theme-accent)', cursor: 'pointer' }} />
                        <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{(clientSettings.is_vat_registered ?? true) ? 'Yes — issues Tax Invoices' : 'No — PAN Bill only'}</span>
                      </label>
                    </div>
                    <div className="form-field">
                      <label><Tip text="Short client code used in POS invoice numbers, e.g. TI2238-CAC-82/83. Auto-suggested from the property name; edit if you want something different.">Invoice Prefix</Tip></label>
                      <input value={clientSettings.invoice_prefix || ''} onChange={e => setClientSettings({ ...clientSettings, invoice_prefix: e.target.value.toUpperCase() })} placeholder="e.g. CAC" />
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
                      <label><Tip text="When a recipe's food cost percentage exceeds this, the FC badge turns yellow in Recipe Costing and reports." width={280}>FC Warning % (yellow)</Tip></label>
                      <input type="number" value={clientSettings.fc_warning_pct || 35} onChange={e => setClientSettings({ ...clientSettings, fc_warning_pct: parseFloat(e.target.value) })} />
                    </div>
                    <div className="form-field">
                      <label><Tip text="When a recipe's food cost exceeds this, the badge turns red — the item is unprofitable at its current selling price." width={280}>FC Critical % (red)</Tip></label>
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
                      <label><Tip text="Items expiring within this many days are flagged amber in the Expiry Tracker.">Expiry Warning (days)</Tip></label>
                      <input type="number" value={clientSettings.expiry_warning_days || 7} onChange={e => setClientSettings({ ...clientSettings, expiry_warning_days: parseInt(e.target.value) })} />
                    </div>
                    <div className="form-field">
                      <label><Tip text="Variance Report highlights items where actual vs. theoretical consumption differs by more than this percentage." width={280}>Variance Flag %</Tip></label>
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
                  <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text3)', display: 'block', marginBottom: 6 }}>
                    <Tip text="Paste the raw text from this business's payment QR (FonePay / NepalPay / eSewa merchant QR). Scan the counter standee with any QR-reader app — it yields a long text string starting with 000201 — and paste it here. POS bills will then show a per-bill dynamic QR with the exact amount pre-filled, so customers can't mistype it." width={320}>
                      Payment QR (merchant payload)
                    </Tip>
                  </label>
                  <textarea
                    value={clientSettings.payment_qr_data || ''}
                    onChange={e => setClientSettings({ ...clientSettings, payment_qr_data: e.target.value })}
                    placeholder="e.g. 00020101021129370016...6304ABCD — scan the standee QR with a QR-reader app and paste the text here"
                    rows={3}
                    style={{ width: '100%', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 12px', fontSize: 12, fontFamily: 'monospace', color: 'var(--theme-text1)', outline: 'none', resize: 'vertical' }}
                  />
                  {(clientSettings.payment_qr_data || '').trim() && (
                    qrCheck.ok ? (
                      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginTop: 10 }}>
                        {qrPreview && <img src={qrPreview} alt="Payment QR preview" style={{ width: 120, height: 120, borderRadius: 6, background: '#fff', padding: 4 }} />}
                        <div>
                          <p style={{ fontSize: 12, color: 'var(--theme-green)', margin: '0 0 4px', fontWeight: 600 }}>✓ Valid payment QR — merchant: {qrCheck.merchantName}</p>
                          <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: 0, maxWidth: 420, lineHeight: 1.6 }}>
                            Scan this preview with a banking app to test it before saving. Once saved, every POS bill shows a dynamic
                            version of this QR with that bill's exact amount pre-filled.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <p style={{ fontSize: 12, color: 'var(--theme-red)', margin: '8px 0 0' }}>✗ {qrCheck.error}</p>
                    )
                  )}

                  {settingsMsg && (
                    <p style={{ fontSize: 12, margin: '16px 0 12px', color: settingsMsg.startsWith('ok:') ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                      {settingsMsg.replace(/^(ok|error):/, '')}
                    </p>
                  )}
                  <button className="btn btn-primary" style={{ fontSize: 13, marginTop: settingsMsg ? 0 : 16 }} onClick={handleSaveSettings} disabled={savingSettings}>
                    {savingSettings ? 'Saving…' : 'Save QR'}
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
                  Destructive actions for{' '}
                  <strong style={{ color: 'var(--theme-text1)' }}>{client.name}</strong>.{' '}
                  Per-module buttons clear only that module's transactions and keep its setup (items, employees, tables…).
                  "Clear Client Data" wipes all operational data across IMS, HR and POS; the client record, user accounts,
                  feature flags, and settings are kept intact.
                  <br /><strong style={{ color: 'var(--theme-red)' }}>None of these can be undone.</strong>
                </p>
              </div>

              {deleteMsg && (
                <p style={{ fontSize: 12, margin: '0 0 16px', color: deleteMsg.startsWith('ok:') ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                  {deleteMsg.replace(/^(ok|error):/, '')}
                </p>
              )}

              <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>
                Clear one module — transactions only, setup kept
              </p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
                <Tip text="Deletes IMS activity: purchases, stock counts, wastage, staff meals, sales, budgets, payables, POs, requisitions, overheads, stock movements. Keeps items, vendors, categories, recipes, par levels, and periods (periods are shared with HR payroll). Cannot be undone.">
                  <button onClick={() => handleClearModule('ims')} disabled={deleting}
                    style={{
                      background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.15)',
                      color: 'var(--theme-red)', borderRadius: 6, padding: '9px 18px',
                      cursor: deleting ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600,
                      opacity: deleting ? 0.6 : 1
                    }}>
                    {deleting ? 'Working…' : 'Clear IMS Transactions'}
                  </button>
                </Tip>
                <Tip text="Deletes HR activity: attendance, payroll runs, payslips, leave requests, overtime, advances + repayments, festival allowances, roster. Keeps employees, salary components, leave types, holiday calendar, and shift types. Cannot be undone.">
                  <button onClick={() => handleClearModule('hr')} disabled={deleting}
                    style={{
                      background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.15)',
                      color: 'var(--theme-red)', borderRadius: 6, padding: '9px 18px',
                      cursor: deleting ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600,
                      opacity: deleting ? 0.6 : 1
                    }}>
                    {deleting ? 'Working…' : 'Clear HR Transactions'}
                  </button>
                </Tip>
                <Tip text="Deletes POS activity: orders, order items, shifts, customers, POS-sourced sales entries, and the stock-movements ledger. Keeps tables, floor plan, and staff accounts/PINs; occupied tables are freed. Invoice numbering restarts. Cannot be undone.">
                  <button onClick={() => handleClearModule('pos')} disabled={deleting}
                    style={{
                      background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.15)',
                      color: 'var(--theme-red)', borderRadius: 6, padding: '9px 18px',
                      cursor: deleting ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600,
                      opacity: deleting ? 0.6 : 1
                    }}>
                    {deleting ? 'Working…' : 'Clear POS Transactions'}
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
                    style={{
                      background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.15)',
                      color: 'var(--theme-red)', borderRadius: 6, padding: '9px 18px',
                      cursor: deleting ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600,
                      opacity: deleting ? 0.6 : 1
                    }}
                  >
                    {deleting ? 'Working…' : 'Clear All Conversions'}
                  </button>
                </Tip>
                <Tip text="Permanently deletes ALL operational data across IMS, HR, and POS — master data and transactions. The client account, users, feature flags, and settings are kept. Cannot be undone.">
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
                </Tip>
                <Tip text="Permanently deletes everything: all operational data, user accounts, feature flags, settings, and the client record itself. The email is freed for re-registration. Cannot be undone.">
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
                </Tip>
              </div>
            </div>
          )}

        </div>
      </div>
    </>
  )
}
