import { useState, useEffect } from 'react'
import { useSettings } from '../context/SettingsContext'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import { useTheme, PRESETS } from '../context/ThemeContext'

const ALL_TABS = ['Branding', 'Property', 'Thresholds', 'Item Codes', 'Vendor Codes', 'Sub-Recipe Codes', 'Contact', 'Data', 'Theme']

export default function Settings() {
  const { settings, saveSettings, loadSettings } = useSettings()
  const { clientId, isAdmin, hasFeature } = useAuth()
  const { themeKey, colors, switchPreset, updateColor } = useTheme()
  const ADMIN_TABS = new Set(['Branding', 'Contact', 'Theme', 'Data'])
  const CLIENT_HIDDEN = new Set(['Contact', 'Branding', 'Property', 'Data'])
  const TABS = ALL_TABS.filter(t => {
    if (isAdmin) return ADMIN_TABS.has(t)
    if (CLIENT_HIDDEN.has(t)) return false
    if (t === 'Sub-Recipe Codes' && !hasFeature('recipe_costing')) return false
    return true
  })
  const [activeTab, setActiveTab] = useState(isAdmin ? 'Branding' : 'Thresholds')
  const [form, setForm] = useState({ ...settings })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [regenerating, setRegenerating] = useState(false)
  const [regenerateMsg, setRegenerateMsg] = useState('')
  const [regeneratingVnd, setRegeneratingVnd] = useState(false)
  const [regenerateMsgVnd, setRegenerateMsgVnd] = useState('')
  const [regeneratingSrc, setRegeneratingSrc] = useState(false)
  const [regenerateMsgSrc, setRegenerateMsgSrc] = useState('')
  const [logoUploading, setLogoUploading] = useState(false)
  const [logoMsg, setLogoMsg] = useState('')

  useEffect(() => {
    loadSettings(isAdmin && !clientId ? null : clientId)
  }, [clientId, isAdmin]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setForm({ ...settings }) }, [settings])

  function update(key, val) { setForm(f => ({ ...f, [key]: val })) }

  async function save() {
    setSaving(true)
    setError('')
    try {
      await saveSettings(form)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e) {
      setError(e.message)
    }
    setSaving(false)
  }

  async function handleLogoUpload(file) {
    if (file.size > 2 * 1024 * 1024) { setLogoMsg('error:File must be under 2MB.'); return }
    setLogoUploading(true); setLogoMsg('')
    const ext  = file.name.split('.').pop().toLowerCase()
    const path = `${clientId || 'admin'}/logo.${ext}`
    const { error: uploadErr } = await supabase.storage.from('Logos').upload(path, file, { upsert: true, contentType: file.type })
    if (uploadErr) { setLogoMsg('error:' + uploadErr.message); setLogoUploading(false); return }
    const { data: { publicUrl } } = supabase.storage.from('Logos').getPublicUrl(path)
    const updated = { ...form, logo_url: publicUrl }
    setForm(updated)
    await saveSettings(updated)
    setLogoMsg('ok:Logo saved.')
    setTimeout(() => setLogoMsg(''), 3000)
    setLogoUploading(false)
  }

  async function handleLogoRemove() {
    const updated = { ...form, logo_url: null }
    setForm(updated)
    await saveSettings(updated)
  }

  async function regenerateAllCodes() {
    const prefix = (form.item_code_prefix || 'ITM').trim().toUpperCase() || 'ITM'
    if (!window.confirm(
      `This will renumber ALL items sequentially as ${prefix}-001, ${prefix}-002, etc. ` +
      `Use this to close gaps left by deleted items. Continue?`
    )) return

    setRegenerating(true)
    setRegenerateMsg('')
    try {
      // Save prefix first if changed
      if (form.item_code_prefix !== settings.item_code_prefix) {
        await saveSettings({ ...form, item_code_prefix: prefix })
      }

      const { data: items, error: fetchErr } = await supabase
        .from('items')
        .select('id, name')
        .eq('client_id', clientId)
        .order('name')

      if (fetchErr) throw fetchErr

      for (let i = 0; i < (items || []).length; i++) {
        const code = `${prefix}-${String(i + 1).padStart(3, '0')}`
        await supabase.from('items').update({ item_code: code }).eq('id', items[i].id)
      }

      setRegenerateMsg(`✓ Renumbered ${items?.length || 0} items as ${prefix}-001 through ${prefix}-${String(items?.length || 0).padStart(3, '0')}`)
    } catch (e) {
      setRegenerateMsg(`Error: ${e.message}`)
    }
    setRegenerating(false)
  }

  async function regenerateAllVendorCodes() {
    const prefix = (form.vendor_code_prefix || 'VND').trim().toUpperCase() || 'VND'
    if (!window.confirm(
      `This will renumber ALL vendors sequentially as ${prefix}-001, ${prefix}-002, etc. ` +
      `Use this to close gaps left by deleted vendors. Continue?`
    )) return

    setRegeneratingVnd(true)
    setRegenerateMsgVnd('')
    try {
      if (form.vendor_code_prefix !== settings.vendor_code_prefix) {
        await saveSettings({ ...form, vendor_code_prefix: prefix })
      }

      const { data: vendors, error: fetchErr } = await supabase
        .from('vendors')
        .select('id, name')
        .eq('client_id', clientId)
        .order('name')

      if (fetchErr) throw fetchErr

      for (let i = 0; i < (vendors || []).length; i++) {
        const code = `${prefix}-${String(i + 1).padStart(3, '0')}`
        await supabase.from('vendors').update({ vendor_code: code }).eq('id', vendors[i].id)
      }

      setRegenerateMsgVnd(`✓ Renumbered ${vendors?.length || 0} vendors as ${prefix}-001 through ${prefix}-${String(vendors?.length || 0).padStart(3, '0')}`)
    } catch (e) {
      setRegenerateMsgVnd(`Error: ${e.message}`)
    }
    setRegeneratingVnd(false)
  }

  async function regenerateAllSubRecipeCodes() {
    const prefix = (form.sub_recipe_code_prefix || 'SRC').trim().toUpperCase() || 'SRC'
    if (!window.confirm(
      `This will renumber ALL sub-recipes sequentially as ${prefix}-001, ${prefix}-002, etc. ` +
      `Alphabetically by name. Continue?`
    )) return

    setRegeneratingSrc(true)
    setRegenerateMsgSrc('')
    try {
      if (form.sub_recipe_code_prefix !== settings.sub_recipe_code_prefix) {
        await saveSettings({ ...form, sub_recipe_code_prefix: prefix })
      }

      const { data: subRecipes, error: fetchErr } = await supabase
        .from('recipes')
        .select('id, name')
        .eq('client_id', clientId)
        .eq('category', 'Sub-Recipe')
        .order('name')

      if (fetchErr) throw fetchErr

      for (let i = 0; i < (subRecipes || []).length; i++) {
        const code = `${prefix}-${String(i + 1).padStart(3, '0')}`
        await supabase.from('recipes').update({ recipe_code: code }).eq('id', subRecipes[i].id)
      }

      setRegenerateMsgSrc(`✓ Renumbered ${subRecipes?.length || 0} sub-recipes as ${prefix}-001 through ${prefix}-${String(subRecipes?.length || 0).padStart(3, '0')}`)
    } catch (e) {
      setRegenerateMsgSrc(`Error: ${e.message}`)
    }
    setRegeneratingSrc(false)
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Configure branding, property details and operational thresholds</p>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Changes'}
        </button>
      </div>

      {/* Read-only branding for client users */}
      {!isAdmin && (
        <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 18, alignItems: 'center' }}>
          {settings.logo_url
            ? <img src={settings.logo_url} alt="logo" style={{ width: 56, height: 56, objectFit: 'contain', borderRadius: 8, flexShrink: 0 }} />
            : <span style={{ fontSize: 36, color: 'var(--theme-accent)', flexShrink: 0 }}>⬢</span>
          }
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>{settings.app_name || '—'}</div>
            {settings.app_tagline && <div style={{ fontSize: 11, color: 'var(--theme-text3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 3 }}>{settings.app_tagline}</div>}
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 6 }}>Contact your consultant to update branding or logo.</div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid var(--theme-border)' }}>
        {TABS.map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '10px 20px', fontSize: 13, fontWeight: 500,
            color: activeTab === tab ? 'var(--theme-accent)' : 'var(--theme-text2)',
            borderBottom: activeTab === tab ? '2px solid var(--theme-accent)' : '2px solid transparent',
            marginBottom: -1
          }}>{tab}</button>
        ))}
      </div>

      {error && <p style={{ color: 'var(--theme-red)', fontSize: 13, marginBottom: 16 }}>{error}</p>}

      {/* BRANDING */}
      {activeTab === 'Branding' && (
        <div className="card">
          <h3 style={{ margin: '0 0 20px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {isAdmin ? 'App Branding' : 'Property Branding'}
          </h3>
          <div className="form-grid form-grid-2">
            <div className="form-field">
              <label>{isAdmin ? 'App Name' : 'Property Name'}</label>
              <input
                value={form.app_name || ''}
                onChange={e => update('app_name', e.target.value)}
                placeholder={isAdmin ? 'Crest Inventory' : 'e.g. Casa Acai Cafe'}
              />
            </div>
            <div className="form-field">
              <label>Tagline</label>
              <input
                value={form.app_tagline || ''}
                onChange={e => update('app_tagline', e.target.value)}
                placeholder={isAdmin ? 'Hospitality cost control, built for Nepal.' : 'e.g. Fresh bowls, made daily.'}
              />
            </div>
          </div>

          {/* Logo upload */}
          <div style={{ marginTop: 20 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text3)', display: 'block', marginBottom: 10 }}>Logo</label>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <div style={{ width: 64, height: 64, borderRadius: 8, border: '1px solid var(--theme-border)', background: 'var(--theme-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {form.logo_url
                  ? <img src={form.logo_url} alt="logo" style={{ width: 56, height: 56, objectFit: 'contain', borderRadius: 6 }} />
                  : <span style={{ fontSize: 26, color: 'var(--theme-accent)' }}>⬢</span>
                }
              </div>
              <div>
                <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 8px' }}>Square PNG / JPG / SVG · max 2 MB</p>
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
                  {form.logo_url && (
                    <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.25)' }} onClick={handleLogoRemove}>
                      Remove
                    </button>
                  )}
                </div>
                {logoMsg && <p style={{ fontSize: 11, margin: '6px 0 0', color: logoMsg.startsWith('error') ? 'var(--theme-red)' : 'var(--theme-green)' }}>{logoMsg.replace(/^(ok|error):/, '')}</p>}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 24, padding: '16px 20px', background: 'var(--theme-bg)', borderRadius: 8, border: '1px solid var(--theme-border)' }}>
            <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 12px' }}>Preview</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {form.logo_url
                ? <img src={form.logo_url} alt="logo" style={{ width: 32, height: 32, objectFit: 'contain', borderRadius: 4 }} />
                : <span style={{ fontSize: 20, color: 'var(--theme-accent)' }}>⬢</span>
              }
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>{form.app_name || 'App Name'}</div>
                <div style={{ fontSize: 11, color: 'var(--theme-text3)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>{form.app_tagline || 'Tagline'}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PROPERTY */}
      {activeTab === 'Property' && (
        <div className="card">
          <h3 style={{ margin: '0 0 20px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Property Details</h3>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px' }}>These appear on printed reports and the Monthly Summary header.</p>
          <div className="form-grid form-grid-2">
            {[
              { key: 'property_address', label: 'Address', placeholder: 'e.g. Jhamsikhel, Lalitpur' },
              { key: 'property_phone', label: 'Phone', placeholder: '01-XXXXXXX' },
              { key: 'property_email', label: 'Email', placeholder: 'info@property.com' },
              { key: 'vat_number', label: 'VAT Registration Number', placeholder: 'e.g. 123456789' },
            ].map(f => (
              <div key={f.key} className="form-field">
                <label>{f.label}</label>
                <input value={form[f.key] || ''} onChange={e => update(f.key, e.target.value)} placeholder={f.placeholder} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* THRESHOLDS */}
      {activeTab === 'Thresholds' && (
        <div className="card">
          <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Operational Thresholds</h3>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 24px' }}>These control when the system flags warnings across reports and the dashboard.</p>
          <div className="form-grid form-grid-2">
            {[
              { key: 'fc_warning_pct', label: 'Food Cost % — Warning threshold', placeholder: '35', suffix: '%', hint: 'Dashboard turns amber above this' },
              { key: 'fc_critical_pct', label: 'Food Cost % — Critical threshold', placeholder: '45', suffix: '%', hint: 'Dashboard turns red above this' },
              { key: 'expiry_warning_days', label: 'Expiry Warning — Days ahead', placeholder: '7', suffix: 'days', hint: 'FIFO report flags items expiring within this window' },
              { key: 'variance_flag_pct', label: 'Variance Flag threshold', placeholder: '10', suffix: '%', hint: 'Variance report flags items above this %' },
            ].map(f => (
              <div key={f.key} className="form-field">
                <label>{f.label}</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="number" value={form[f.key] || ''} onChange={e => update(f.key, e.target.value)} placeholder={f.placeholder} style={{ width: 100 }} />
                  <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{f.suffix}</span>
                </div>
                <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>{f.hint}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ITEM CODES */}
      {activeTab === 'Item Codes' && (
        <div className="card">
          <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Item Codes</h3>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 24px' }}>
            Auto-generated codes for stock sheets, purchase orders, and audit trails. New items are assigned the next number in sequence automatically.
          </p>
          <div className="form-grid form-grid-2">
            <div className="form-field">
              <label>Code Prefix</label>
              <input
                value={form.item_code_prefix || ''}
                onChange={e => update('item_code_prefix', e.target.value.toUpperCase())}
                placeholder="ITM"
                style={{ maxWidth: 160 }}
              />
              <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>
                e.g. "{(form.item_code_prefix || 'ITM').toUpperCase()}" → {(form.item_code_prefix || 'ITM').toUpperCase()}-001, {(form.item_code_prefix || 'ITM').toUpperCase()}-002, …
              </span>
            </div>
          </div>

          <div style={{ marginTop: 24, padding: '16px 20px', background: 'var(--theme-bg)', borderRadius: 8, border: '1px solid var(--theme-border)' }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--theme-text1)' }}>Regenerate All Codes</h4>
            <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 12px' }}>
              If items have been deleted, codes may have gaps. Use this to renumber every item sequentially
              from {(form.item_code_prefix || 'ITM').toUpperCase()}-001, alphabetically by name. Save the prefix above first if you've changed it.
            </p>
            <button className="btn btn-ghost" onClick={regenerateAllCodes} disabled={regenerating}>
              {regenerating ? 'Renumbering…' : '↻ Regenerate All Item Codes'}
            </button>
            {regenerateMsg && (
              <p style={{ fontSize: 12, color: regenerateMsg.startsWith('Error') ? 'var(--theme-red)' : 'var(--theme-green)', margin: '12px 0 0' }}>
                {regenerateMsg}
              </p>
            )}
          </div>
        </div>
      )}

      {/* VENDOR CODES */}
      {activeTab === 'Vendor Codes' && (
        <div className="card">
          <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Vendor Codes</h3>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 24px' }}>
            Auto-generated codes for suppliers — appear on the Vendors list and purchase entries. New vendors are assigned the next number in sequence automatically.
          </p>
          <div className="form-grid form-grid-2">
            <div className="form-field">
              <label>Code Prefix</label>
              <input
                value={form.vendor_code_prefix || ''}
                onChange={e => update('vendor_code_prefix', e.target.value.toUpperCase())}
                placeholder="VND"
                style={{ maxWidth: 160 }}
              />
              <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>
                e.g. "{(form.vendor_code_prefix || 'VND').toUpperCase()}" → {(form.vendor_code_prefix || 'VND').toUpperCase()}-001, {(form.vendor_code_prefix || 'VND').toUpperCase()}-002, …
              </span>
            </div>
          </div>

          <div style={{ marginTop: 24, padding: '16px 20px', background: 'var(--theme-bg)', borderRadius: 8, border: '1px solid var(--theme-border)' }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--theme-text1)' }}>Regenerate All Codes</h4>
            <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 12px' }}>
              If vendors have been deleted, codes may have gaps. Use this to renumber every vendor sequentially
              from {(form.vendor_code_prefix || 'VND').toUpperCase()}-001, alphabetically by name. Save the prefix above first if you've changed it.
            </p>
            <button className="btn btn-ghost" onClick={regenerateAllVendorCodes} disabled={regeneratingVnd}>
              {regeneratingVnd ? 'Renumbering…' : '↻ Regenerate All Vendor Codes'}
            </button>
            {regenerateMsgVnd && (
              <p style={{ fontSize: 12, color: regenerateMsgVnd.startsWith('Error') ? 'var(--theme-red)' : 'var(--theme-green)', margin: '12px 0 0' }}>
                {regenerateMsgVnd}
              </p>
            )}
          </div>
        </div>
      )}

      {/* SUB-RECIPE CODES */}
      {activeTab === 'Sub-Recipe Codes' && (
        <div className="card">
          <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Sub-Recipe Codes</h3>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 24px' }}>
            Auto-generated codes for sub-recipes — appear in recipe ingredient rows and the Sub-Recipes tab. New sub-recipes are assigned the next number automatically.
          </p>
          <div className="form-grid form-grid-2">
            <div className="form-field">
              <label>Code Prefix</label>
              <input
                value={form.sub_recipe_code_prefix || ''}
                onChange={e => update('sub_recipe_code_prefix', e.target.value.toUpperCase())}
                placeholder="SRC"
                style={{ maxWidth: 160 }}
              />
              <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>
                e.g. "{(form.sub_recipe_code_prefix || 'SRC').toUpperCase()}" → {(form.sub_recipe_code_prefix || 'SRC').toUpperCase()}-001, {(form.sub_recipe_code_prefix || 'SRC').toUpperCase()}-002, …
              </span>
            </div>
          </div>

          <div style={{ marginTop: 24, padding: '16px 20px', background: 'var(--theme-bg)', borderRadius: 8, border: '1px solid var(--theme-border)' }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--theme-text1)' }}>Regenerate All Codes</h4>
            <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 12px' }}>
              Renumbers every sub-recipe sequentially from {(form.sub_recipe_code_prefix || 'SRC').toUpperCase()}-001, alphabetically by name. Use this to assign codes to existing sub-recipes or close gaps after deletions.
            </p>
            <button className="btn btn-ghost" onClick={regenerateAllSubRecipeCodes} disabled={regeneratingSrc}>
              {regeneratingSrc ? 'Renumbering…' : '↻ Regenerate All Sub-Recipe Codes'}
            </button>
            {regenerateMsgSrc && (
              <p style={{ fontSize: 12, color: regenerateMsgSrc.startsWith('Error') ? 'var(--theme-red)' : 'var(--theme-green)', margin: '12px 0 0' }}>
                {regenerateMsgSrc}
              </p>
            )}
          </div>
        </div>
      )}

      {/* CONTACT */}
      {activeTab === 'Contact' && (
        <div className="card">
          <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Upgrade Contact Details</h3>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 24px' }}>
            These details appear on the Premium upgrade prompt shown to Basic plan clients.
          </p>
          <div className="form-grid form-grid-2">
            <div className="form-field">
              <label>Phone</label>
              <input value={form.contact_phone || ''} onChange={e => update('contact_phone', e.target.value)} placeholder="e.g. 9809727572" />
              <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>Shown as a clickable call link</span>
            </div>
            <div className="form-field">
              <label>Email</label>
              <input type="email" value={form.contact_email || ''} onChange={e => update('contact_email', e.target.value)} placeholder="e.g. info@cresthospitality.com" />
              <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>Shown as a clickable mailto link</span>
            </div>
            <div className="form-field">
              <label>Website</label>
              <input value={form.contact_website || ''} onChange={e => update('contact_website', e.target.value)} placeholder="e.g. cresthospitality.com" />
              <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>Shown as a clickable external link</span>
            </div>
          </div>
          <div style={{ marginTop: 20, padding: '14px 18px', background: 'var(--theme-bg)', borderRadius: 8, border: '1px solid var(--theme-border)', fontSize: 12, color: 'var(--theme-text2)' }}>
            💡 Leave all fields blank to show a generic "Contact your Crest consultant" message instead.
          </div>
        </div>
      )}

      {/* THEME */}
      {activeTab === 'Theme' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Presets */}
          <div className="card">
            <h3 style={{ margin: '0 0 6px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Preset Themes</h3>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px' }}>Pick a preset — it sets all colors at once. You can fine-tune individual colors below.</p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {Object.entries(PRESETS).map(([key, preset]) => (
                <button
                  key={key}
                  onClick={() => switchPreset(key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '14px 20px', borderRadius: 10, cursor: 'pointer',
                    border: themeKey === key ? `2px solid ${colors.accent}` : '2px solid var(--theme-border)',
                    background: themeKey === key ? 'rgba(201,168,76,0.08)' : 'var(--theme-card)',
                    minWidth: 180
                  }}
                >
                  {/* Mini color swatch */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
                    <div style={{ display: 'flex', gap: 3 }}>
                      <div style={{ width: 14, height: 14, borderRadius: 3, background: preset.bg, border: '1px solid rgba(255,255,255,0.1)' }} />
                      <div style={{ width: 14, height: 14, borderRadius: 3, background: preset.card, border: '1px solid rgba(255,255,255,0.1)' }} />
                    </div>
                    <div style={{ display: 'flex', gap: 3 }}>
                      <div style={{ width: 14, height: 14, borderRadius: 3, background: preset.accent }} />
                      <div style={{ width: 14, height: 14, borderRadius: 3, background: preset.sidebar, border: '1px solid rgba(255,255,255,0.1)' }} />
                    </div>
                  </div>
                  <div style={{ textAlign: 'left' }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: themeKey === key ? colors.accent : 'var(--theme-text1)' }}>{preset.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>
                      {preset.description || ''}
                    </div>
                  </div>
                  {themeKey === key && (
                    <span style={{ marginLeft: 'auto', fontSize: 14, color: colors.accent }}>✓</span>
                  )}
                </button>
              ))}
              {themeKey === 'custom' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 20px', borderRadius: 10, border: '2px solid var(--theme-accent)', background: 'rgba(201,168,76,0.06)', minWidth: 180 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div style={{ display: 'flex', gap: 3 }}>
                      <div style={{ width: 14, height: 14, borderRadius: 3, background: colors.bg, border: '1px solid rgba(255,255,255,0.1)' }} />
                      <div style={{ width: 14, height: 14, borderRadius: 3, background: colors.card, border: '1px solid rgba(255,255,255,0.1)' }} />
                    </div>
                    <div style={{ display: 'flex', gap: 3 }}>
                      <div style={{ width: 14, height: 14, borderRadius: 3, background: colors.accent }} />
                      <div style={{ width: 14, height: 14, borderRadius: 3, background: colors.sidebar, border: '1px solid rgba(255,255,255,0.1)' }} />
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-accent)' }}>Custom ✓</div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>Your custom palette</div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Color pickers */}
          <div className="card">
            <h3 style={{ margin: '0 0 6px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Customize Colors</h3>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 24px' }}>Click any swatch to pick a color. Changes apply instantly. Start from a preset, then adjust individual colors here.</p>

            {[
              { key: 'bg',          label: 'Page Background',     desc: 'Main app background' },
              { key: 'card',        label: 'Card / Panel',         desc: 'Backgrounds for cards and drawers' },
              { key: 'border',      label: 'Border',               desc: 'Card borders, dividers, table lines' },
              { key: 'sidebar',     label: 'Sidebar',              desc: 'Navigation sidebar background' },
              { key: 'text1',       label: 'Primary Text',         desc: 'Headings and main body text' },
              { key: 'text2',       label: 'Secondary Text',       desc: 'Labels, subtitles, table headers' },
              { key: 'accent',      label: 'Accent / Buttons',     desc: 'Primary buttons, active nav, focus rings' },
              { key: 'accentText',  label: 'Button Text',          desc: 'Text color on primary buttons' },
              { key: 'green',       label: 'Success / Green',      desc: 'Positive values, open badges, growth' },
              { key: 'red',         label: 'Danger / Red',         desc: 'Errors, warnings, delete actions' },
            ].map(({ key, label, desc }) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 0', borderBottom: '1px solid var(--theme-border)' }}>
                <label
                  style={{ position: 'relative', flexShrink: 0, cursor: 'pointer' }}
                  title={`Pick ${label}`}
                >
                  <input
                    type="color"
                    value={colors[key] || '#000000'}
                    onChange={e => updateColor(key, e.target.value)}
                    style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
                  />
                  <div style={{
                    width: 36, height: 36, borderRadius: 8,
                    background: colors[key],
                    border: '2px solid rgba(255,255,255,0.15)',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                    transition: 'transform 0.1s',
                  }} />
                </label>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>{label}</div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 1 }}>{desc}</div>
                </div>
                <code style={{ fontSize: 11, color: 'var(--theme-text3)', fontFamily: 'monospace', background: 'var(--theme-bg)', padding: '2px 8px', borderRadius: 4 }}>
                  {colors[key]}
                </code>
              </div>
            ))}

            <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => switchPreset('dark')}>
                ↺ Reset to Dark
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => switchPreset('light')}>
                ↺ Reset to Light
              </button>
            </div>
          </div>

          {/* Live preview */}
          <div className="card">
            <h3 style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Live Preview</h3>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ padding: '10px 20px', borderRadius: 6, background: colors.accent, color: colors.accentText, fontSize: 13, fontWeight: 700 }}>
                Primary Button
              </div>
              <div style={{ padding: '10px 20px', borderRadius: 6, background: 'transparent', color: colors.text2, border: `1px solid ${colors.border}`, fontSize: 13 }}>
                Ghost Button
              </div>
              <div style={{ padding: '6px 14px', borderRadius: 5, background: `${colors.green}18`, color: colors.green, fontSize: 11, fontWeight: 700 }}>
                Active Badge
              </div>
              <div style={{ padding: '6px 14px', borderRadius: 5, background: `${colors.red}18`, color: colors.red, fontSize: 11, fontWeight: 700 }}>
                Error Badge
              </div>
            </div>
            <div style={{ marginTop: 16, borderRadius: 8, overflow: 'hidden', border: `1px solid ${colors.border}` }}>
              <div style={{ background: colors.card, padding: '10px 16px', borderBottom: `1px solid ${colors.border}`, display: 'flex', gap: 20 }}>
                {['Column A', 'Column B', 'Column C'].map(h => (
                  <span key={h} style={{ fontSize: 11, fontWeight: 600, color: colors.text2, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{h}</span>
                ))}
              </div>
              {[['Item One', 'NPR 1,200', '92%'], ['Item Two', 'NPR 840', '78%']].map((row, i) => (
                <div key={i} style={{ background: colors.card, padding: '10px 16px', borderBottom: i === 0 ? `1px solid ${colors.border}` : 'none', display: 'flex', gap: 20 }}>
                  {row.map((cell, j) => (
                    <span key={j} style={{ fontSize: 13, color: colors.text1 }}>{cell}</span>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: 0 }}>
            Theme is saved in your browser (localStorage). It applies only to your device — other users on this account see their own theme.
          </p>
        </div>
      )}

      {/* DATA */}
      {activeTab === 'Data' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text1)' }}>Archive Periods</h3>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 16px' }}>
              Archiving hides closed periods from dropdowns to keep screens clean. Data is never deleted — toggle "Show archived" on any report to access it. Always export before archiving.
            </p>
            <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: 0 }}>Archive controls are available on the Periods page for each closed period.</p>
          </div>

          <div className="card">
            <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text1)' }}>Data Export</h3>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 16px' }}>
              Export buttons are available on every report page — Monthly Summary, Variance Report, FIFO Report, and Payment Summary all have Export to Excel.
            </p>
            <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: 0 }}>For a full data dump of all periods, contact your Crest consultant.</p>
          </div>

          {isAdmin && (
            <div className="card" style={{ borderColor: 'rgba(248,113,113,0.2)' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-red)' }}>Danger Zone</h3>
              <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 16px' }}>
                Destructive actions. These cannot be undone.
              </p>
              <button className="btn btn-danger" style={{ fontSize: 13 }}
                onClick={() => alert('Use Admin → Clients → Manage → ⚠ Danger tab to reset client data.')}>
                Reset All Data for This Property
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
