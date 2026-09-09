import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { useSettings } from '../context/SettingsContext'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import { useScopedDb } from '../shared/hooks/useScopedDb'
import { useTheme, PRESETS } from '../context/ThemeContext'
import Tip from '../components/Tip'
import { MODULE_INK, DEFAULT_PLAN_PRICES, annualOf } from '../data/pricingPlans'
import { assignMissingProductCodes } from '../shared/productCode'
import { useConfirm } from '../shared/hooks/useConfirm'
import { Navigate } from 'react-router-dom'
import SupportContactLine from '../components/SupportContactLine'
import { DEFAULT_SUPPORT_CONTACT, EMERGENCY_CHANNELS, SUPPORT_HOURS, resolveSupportContact, supportPhone } from '../shared/supportContact'

// Lazy so the three module guides' prose (several thousand lines of admin-only strings) lives in
// its own on-demand chunk instead of the Settings chunk every client login downloads — the Guides
// tab is admin-only, so a client can never render it.
const GuidesTab = lazy(() => import('./settings/GuidesTab'))

// A tab's DOM id, for the roving focus and the tabpanel's aria-labelledby.
const tabSlug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-')

const ALL_TABS = ['Branding', 'Property', 'Thresholds', 'Item Codes', 'Vendor Codes', 'Sub-Recipe Codes', 'Product Codes', 'Recipe Categories', 'Support', 'Plan Pricing', 'Data', 'Theme', 'Guides']

// Derives a short invoice-number prefix from the property/business name, e.g. "Casa Acai Cafe" -> "CAC"
function deriveInvoicePrefix(name) {
  if (!name) return ''
  return name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 5)
}

export default function Settings() {
  const { settings, saveSettings, loadSettings, recipeCategories, platformSupport, savePlatformSupport,
          planPrices, savePlatformPlanPrices } = useSettings()
  const { ask: askConfirm, confirmEl } = useConfirm()
  const { clientId, isAdmin, hasFeature, hasImsAccess } = useAuth()
  const { scopedFrom, scopedUpdate } = useScopedDb()
  const { themeKey, colors, switchPreset, updateColor } = useTheme()
  const ADMIN_TABS = new Set(['Branding', 'Property', 'Support', 'Plan Pricing', 'Theme', 'Data', 'Guides'])
  const CLIENT_HIDDEN = new Set(['Support', 'Branding', 'Property', 'Data', 'Plan Pricing', 'Guides'])
  const TABS = ALL_TABS.filter(t => {
    if (isAdmin) return ADMIN_TABS.has(t)
    if (CLIENT_HIDDEN.has(t)) return false
    if (t === 'Sub-Recipe Codes' && !hasFeature('recipe_costing')) return false
    if (t === 'Recipe Categories' && !hasFeature('recipe_costing')) return false
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
  const [generatingPrd, setGeneratingPrd] = useState(false)
  const [generateMsgPrd, setGenerateMsgPrd] = useState('')
  const [logoUploading, setLogoUploading] = useState(false)
  const [logoMsg, setLogoMsg] = useState('')
  const [cats, setCats] = useState([])
  const [newCat, setNewCat] = useState('')
  const [catSaving, setCatSaving] = useState(false)
  const [catMsg, setCatMsg] = useState('')
  // Settings → Support, upper section (S683): the platform row's contact, edited here and saved
  // through savePlatformSupport() — NOT through save(), which targets whichever client's row is
  // being viewed. Seeded from the loaded value; the defaults fill any slot the row never had.
  const [platformForm, setPlatformForm] = useState({ ...DEFAULT_SUPPORT_CONTACT })
  const [platformSaving, setPlatformSaving] = useState(false)
  const [platformMsg, setPlatformMsg] = useState('')
  // Reseed only when the STORED value changes, compared by value (S684). `loadSettings()` runs
  // after every page-level save and on every client switch, and each run produces a fresh
  // `platformSupport` object — so a reference-keyed effect reseeded this form from the row on
  // both, wiping whatever the admin had typed here while the header button said "✓ Saved". The
  // seed is keyed on the serialised row instead: the same stored value arriving again is a no-op.
  const platformSeedRef = useRef(null)
  useEffect(() => {
    const next = { ...DEFAULT_SUPPORT_CONTACT, ...(platformSupport || {}) }
    const key = JSON.stringify(next)
    if (key === platformSeedRef.current) return
    platformSeedRef.current = key
    setPlatformForm(next)
  }, [platformSupport])
  function updatePlatform(key, val) { setPlatformForm(f => ({ ...f, [key]: val })) }

  // Settings > Plan Pricing (S701) — the same shape as the platform support card above, for the
  // same reason: a price is one fact for the whole platform, so it lives on the client_id-NULL
  // row and not on whichever client is being viewed. Editing it through `form`/`save()` wrote it
  // onto the VIEWED client's settings row, where nothing reads it — the save reported success and
  // the price everyone sees never moved.
  const [priceForm, setPriceForm] = useState(DEFAULT_PLAN_PRICES)
  const [priceSaving, setPriceSaving] = useState(false)
  const [priceMsg, setPriceMsg] = useState('')
  const priceSeedRef = useRef(null)
  useEffect(() => {
    // Built field by field rather than spread over the stored row, because the live row still
    // carries the JSONB column's original DEFAULT — flat `starter`/`growth`/`pro` keys from before
    // IMS tiers moved under `ims`. Nothing has read those in a long time; spreading the row would
    // carry them into every future save and keep three dead prices sitting next to four live ones.
    const stored = planPrices || {}
    const next = {
      ims:   { ...DEFAULT_PLAN_PRICES.ims, ...(stored.ims || {}) },
      hr:    stored.hr ?? DEFAULT_PLAN_PRICES.hr,
      pos:   stored.pos ?? DEFAULT_PLAN_PRICES.pos,
      suite: stored.suite ?? DEFAULT_PLAN_PRICES.suite,
    }
    const key = JSON.stringify(next)
    if (key === priceSeedRef.current) return
    priceSeedRef.current = key
    setPriceForm(next)
  }, [planPrices])

  useEffect(() => {
    loadSettings(isAdmin && !clientId ? null : clientId)
  }, [clientId, isAdmin]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const next = { ...settings }
    if (!next.invoice_prefix && next.app_name) next.invoice_prefix = deriveInvoicePrefix(next.app_name)
    setForm(next)
  }, [settings])
  useEffect(() => { setCats([...recipeCategories]) }, [recipeCategories]) // eslint-disable-line

  function update(key, val) { setForm(f => ({ ...f, [key]: val })) }

  function addCat() {
    const name = newCat.trim()
    if (!name) return
    if (cats.some(c => c.toLowerCase() === name.toLowerCase())) return
    if (name.toLowerCase() === 'sub-recipe') return
    setCats(prev => [...prev, name])
    setNewCat('')
  }

  async function saveCategories() {
    const cleaned = cats.map(c => c.trim()).filter(Boolean)
    if (cleaned.length === 0) { setCatMsg('error:Add at least one category.'); return }
    setCatSaving(true); setCatMsg('')
    try {
      await saveSettings({ ...settings, recipe_categories: cleaned })
      setCatMsg('ok:Categories saved.')
      setTimeout(() => setCatMsg(''), 2500)
    } catch (e) {
      setCatMsg('error:' + e.message)
    }
    setCatSaving(false)
  }

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

  async function savePlatform() {
    if (platformSaving) return  // the button stays enabled while busy (DESIGN.md), so this is the guard
    setPlatformSaving(true); setPlatformMsg('')
    try {
      const trimmed = Object.fromEntries(Object.entries(platformForm).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]))
      await savePlatformSupport(trimmed)
      setPlatformMsg('ok:Support contact saved — every client sees it on their next load.')
      setTimeout(() => setPlatformMsg(''), 4000)
    } catch (e) {
      setPlatformMsg('error:' + e.message)
    }
    setPlatformSaving(false)
  }

  async function savePrices() {
    if (priceSaving) return  // the button stays enabled while busy (DESIGN.md), so this is the guard
    setPriceSaving(true); setPriceMsg('')
    try {
      await savePlatformPlanPrices(priceForm)
      setPriceMsg('ok:Prices saved — the public pricing page, Help > Plan & Pricing and every MRR figure now quote them.')
      setTimeout(() => setPriceMsg(''), 5000)
    } catch (e) {
      setPriceMsg('error:' + e.message)
    }
    setPriceSaving(false)
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
    askConfirm({
      title: 'Renumber every item?',
      confirmLabel: 'Renumber All', danger: true, busyLabel: 'Renumbering…',
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            Every item in Item Master is given a new sequential code — <strong>{prefix}-001</strong>, <strong>{prefix}-002</strong> and
            so on — closing the gaps left by deletions. Sub-recipes keep their own recipe codes. Codes already
            printed on past bills, stock sheets and reports will no longer match what this list shows.
          </p>
          <p style={{ margin: 0 }}>This cannot be undone.</p>
        </>
      ),
      run: () => runRegenerateAllCodes(prefix),
    })
  }

  async function runRegenerateAllCodes(prefix) {

    setRegenerating(true)
    setRegenerateMsg('')
    try {
      // Save prefix first if changed
      if (form.item_code_prefix !== settings.item_code_prefix) {
        await saveSettings({ ...form, item_code_prefix: prefix })
      }

      // Item Master only. A sub-recipe's mirror row in `items` carries its RECIPE code as its
      // item_code (Recipes.js writes the two together), so renumbering it both destroyed that link
      // and spent an ITM number on a row Item Master does not list — and Item Master derives the
      // next code from the rows it lists, so the number handed to the next new item was one an
      // invisible mirror already held. There is no UNIQUE(client_id, item_code) to catch it, and the
      // recipe importer resolves a code to whichever row it saw last.
      const { data: items, error: fetchErr } = await scopedFrom('items', 'id, name')
        .eq('is_sub_recipe', false)
        .order('name')

      if (fetchErr) throw fetchErr

      // Each write's error has to be READ: supabase-js resolves with { error } rather than throwing,
      // so the try/catch around this loop never saw a refusal and every failed renumber still
      // finished with a green "✓ Renumbered N items". The run is a row at a time and not atomic, so
      // a failure has to say how far it got — the codes before it have already changed.
      const total = (items || []).length
      for (let i = 0; i < total; i++) {
        const code = `${prefix}-${String(i + 1).padStart(3, '0')}`
        const { error: updErr } = await scopedUpdate('items', { item_code: code }).eq('id', items[i].id)
        if (updErr) {
          setRegenerateMsg(`Error: stopped after ${i} of ${total} items — the first ${i} now carry their new codes and the rest keep their old ones. Run it again once this is resolved. ${updErr.message || ''}`.trim())
          setRegenerating(false)
          return
        }
      }

      setRegenerateMsg(`✓ Renumbered ${total} items as ${prefix}-001 through ${prefix}-${String(total).padStart(3, '0')}`)
    } catch (e) {
      setRegenerateMsg(`Error: ${e.message}`)
    }
    setRegenerating(false)
  }

  async function regenerateAllVendorCodes() {
    const prefix = (form.vendor_code_prefix || 'VND').trim().toUpperCase() || 'VND'
    askConfirm({
      title: 'Renumber every vendor?',
      confirmLabel: 'Renumber All', danger: true, busyLabel: 'Renumbering…',
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            Every vendor is given a new sequential code — <strong>{prefix}-001</strong>, <strong>{prefix}-002</strong> and
            so on — closing the gaps left by deletions. Codes already printed on past bills, stock sheets and
            reports will no longer match what this list shows.
          </p>
          <p style={{ margin: 0 }}>This cannot be undone.</p>
        </>
      ),
      run: () => runRegenerateAllVendorCodes(prefix),
    })
  }

  async function runRegenerateAllVendorCodes(prefix) {

    setRegeneratingVnd(true)
    setRegenerateMsgVnd('')
    try {
      if (form.vendor_code_prefix !== settings.vendor_code_prefix) {
        await saveSettings({ ...form, vendor_code_prefix: prefix })
      }

      const { data: vendors, error: fetchErr } = await scopedFrom('vendors', 'id, name')
        .order('name')

      if (fetchErr) throw fetchErr

      for (let i = 0; i < (vendors || []).length; i++) {
        const code = `${prefix}-${String(i + 1).padStart(3, '0')}`
        await scopedUpdate('vendors', { vendor_code: code }).eq('id', vendors[i].id)
      }

      setRegenerateMsgVnd(`✓ Renumbered ${vendors?.length || 0} vendors as ${prefix}-001 through ${prefix}-${String(vendors?.length || 0).padStart(3, '0')}`)
    } catch (e) {
      setRegenerateMsgVnd(`Error: ${e.message}`)
    }
    setRegeneratingVnd(false)
  }

  async function regenerateAllSubRecipeCodes() {
    const prefix = (form.sub_recipe_code_prefix || 'SRC').trim().toUpperCase() || 'SRC'
    askConfirm({
      title: 'Renumber every sub-recipe?',
      confirmLabel: 'Renumber All', danger: true, busyLabel: 'Renumbering…',
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            Every sub-recipe is given a new sequential code — <strong>{prefix}-001</strong>, <strong>{prefix}-002</strong> and
            so on — closing the gaps left by deletions. Codes already printed on past bills, stock sheets and
            reports will no longer match what this list shows.
          </p>
          <p style={{ margin: 0 }}>This cannot be undone.</p>
        </>
      ),
      run: () => runRegenerateAllSubRecipeCodes(prefix),
    })
  }

  async function runRegenerateAllSubRecipeCodes(prefix) {

    setRegeneratingSrc(true)
    setRegenerateMsgSrc('')
    try {
      if (form.sub_recipe_code_prefix !== settings.sub_recipe_code_prefix) {
        await saveSettings({ ...form, sub_recipe_code_prefix: prefix })
      }

      const { data: subRecipes, error: fetchErr } = await scopedFrom('recipes', 'id, name')
        .eq('category', 'Sub-Recipe')
        .order('name')

      if (fetchErr) throw fetchErr

      for (let i = 0; i < (subRecipes || []).length; i++) {
        const code = `${prefix}-${String(i + 1).padStart(3, '0')}`
        await scopedUpdate('recipes', { recipe_code: code }).eq('id', subRecipes[i].id)
      }

      setRegenerateMsgSrc(`✓ Renumbered ${subRecipes?.length || 0} sub-recipes as ${prefix}-001 through ${prefix}-${String(subRecipes?.length || 0).padStart(3, '0')}`)
    } catch (e) {
      setRegenerateMsgSrc(`Error: ${e.message}`)
    }
    setRegeneratingSrc(false)
  }

  // Fills in Product Codes for menu recipes that have none — the ones that predate auto-issuing.
  //
  // Unlike the three "Regenerate All" actions above, this ONLY fills blanks and never renumbers a
  // code that already exists. That difference is deliberate: a Product Code is frequently the code
  // a client already prints on their own menu or carried across from an old POS, so reassigning it
  // would destroy the recognisability the field exists for. New recipes get their code
  // automatically as they are written, in Recipe Costing.
  async function generateMissingProductCodes() {
    setGeneratingPrd(true)
    setGenerateMsgPrd('')
    try {
      const { data: recipes, error: fetchErr } = await scopedFrom('recipes', 'id, name, category, recipe_code')
      if (fetchErr) throw fetchErr

      const pending = assignMissingProductCodes(recipes || [])
      if (pending.length === 0) {
        setGenerateMsgPrd('✓ Every menu recipe already has a Product Code — nothing to do.')
        setGeneratingPrd(false)
        return
      }
      if (!window.confirm(
        `Assign a Product Code to ${pending.length} recipe${pending.length === 1 ? '' : 's'} that ` +
        `currently have none?\n\nCodes come from each recipe's category (Beverage → BEV-001, ` +
        `BEV-002, …). Recipes that already have a code are left untouched.`
      )) { setGeneratingPrd(false); return }

      let done = 0
      for (const row of pending) {
        const { error } = await scopedUpdate('recipes', { recipe_code: row.recipe_code }).eq('id', row.id)
        if (error) throw error
        done++
      }
      setGenerateMsgPrd(`✓ Assigned ${done} Product Code${done === 1 ? '' : 's'}. Existing codes were left as they were.`)
    } catch (e) {
      setGenerateMsgPrd(`Error: ${e.message}`)
    }
    setGeneratingPrd(false)
  }

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">
            {isAdmin
              ? 'Branding, property, the support contact, plan pricing, data and theme for the client you are viewing'
              : 'Operational thresholds, code formats, recipe categories and your theme'}
          </p>
        </div>
        {/* Support and Plan Pricing are the tabs whose cards each commit their own row, so the
            page-level button does not render there: measured, the nearest Save to the consultant
            fields was the OTHER card's, 243px away, while the button that saved them sat 1,345px
            up (S684). Plan Pricing joined them in S701 — this button writes the VIEWED client's
            settings row, which is the one place platform prices must never go. */}
        {activeTab !== 'Support' && activeTab !== 'Plan Pricing' && (
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Changes'}
          </button>
        )}
      </div>

      {/* Read-only branding for client users */}
      {!isAdmin && (
        <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 18, alignItems: 'center' }}>
          {settings.logo_url
            ? <img src={settings.logo_url} alt="logo" style={{ width: 56, height: 56, objectFit: 'contain', borderRadius: 0, flexShrink: 0 }} />
            : <span style={{ fontSize: 36, color: 'var(--theme-accent-ink)', flexShrink: 0 }}>⬢</span>
          }
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>{settings.app_name || '—'}</div>
            {settings.app_tagline && <div style={{ fontSize: 11, color: 'var(--theme-text3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 3 }}>{settings.app_tagline}</div>}
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 6 }}>Contact your consultant to update branding or logo.</div>
          </div>
        </div>
      )}

      {/* Tabs — .panel-tab-bar wraps and .panel-tab carries hover, the focus ring and the
          coarse-pointer floor; roving tabIndex + arrow keys make the row ONE stop (DESIGN.md's Tabs
          rule, the shape Help.js already has). Measured at 390px, the previous inline nowrap row ran
          639px inside a 358px strip, and Data, Theme and Guides sat outside the viewport with no
          way to reach them (S684). */}
      <div role="tablist" aria-label="Settings sections" className="panel-tab-bar" style={{ marginBottom: 24 }}>
        {TABS.map((tab, i) => {
          const focusTab = t => { setActiveTab(t); document.getElementById(`settings-tab-${tabSlug(t)}`)?.focus() }
          return (
            <button
              key={tab}
              role="tab"
              id={`settings-tab-${tabSlug(tab)}`}
              aria-selected={activeTab === tab}
              aria-controls="settings-tabpanel"
              tabIndex={activeTab === tab ? 0 : -1}
              onClick={() => setActiveTab(tab)}
              onKeyDown={e => {
                const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
                if (dir) { e.preventDefault(); focusTab(TABS[(i + dir + TABS.length) % TABS.length]) }
                else if (e.key === 'Home') { e.preventDefault(); focusTab(TABS[0]) }
                else if (e.key === 'End') { e.preventDefault(); focusTab(TABS[TABS.length - 1]) }
              }}
              className={`panel-tab${activeTab === tab ? ' panel-tab--active' : ''}`}
            >{tab}</button>
          )
        })}
      </div>

      <div id="settings-tabpanel" role="tabpanel" aria-labelledby={`settings-tab-${tabSlug(activeTab)}`}>
      {error && <p style={{ color: 'var(--theme-red-text)', fontSize: 13, marginBottom: 16 }}>{error}</p>}

      {/* BRANDING */}
      {activeTab === 'Branding' && (
        <div className="card">
          <h3 style={{ margin: '0 0 20px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {isAdmin ? 'App Branding' : 'Property Branding'}
          </h3>
          <div className="form-grid form-grid-2">
            <div className="form-field">
              <label htmlFor="set-app-name">{isAdmin ? 'App Name' : 'Property Name'}</label>
              <input
                id="set-app-name"
                value={form.app_name || ''}
                onChange={e => update('app_name', e.target.value)}
                placeholder={isAdmin ? 'Crest Suite' : 'e.g. Casa Acai Cafe'}
              />
            </div>
            <div className="form-field">
              <label htmlFor="set-app-tagline">Tagline</label>
              <input
                id="set-app-tagline"
                value={form.app_tagline || ''}
                onChange={e => update('app_tagline', e.target.value)}
                placeholder={isAdmin ? 'Hospitality cost control, built for Nepal.' : 'e.g. Fresh bowls, made daily.'}
              />
            </div>
          </div>

          {/* Logo upload */}
          <div style={{ marginTop: 20 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text3)', display: 'block', marginBottom: 10 }}>Logo</span>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <div style={{ width: 64, height: 64, borderRadius: 0, border: '1px solid var(--theme-border)', background: 'var(--theme-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {form.logo_url
                  ? <img src={form.logo_url} alt="logo" style={{ width: 56, height: 56, objectFit: 'contain', borderRadius: 0 }} />
                  : <span style={{ fontSize: 26, color: 'var(--theme-accent-ink)' }}>⬢</span>
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
                    <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 25%, transparent)' }} onClick={handleLogoRemove}>
                      Remove
                    </button>
                  )}
                </div>
                {logoMsg && <p style={{ fontSize: 11, margin: '6px 0 0', color: logoMsg.startsWith('error') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>{logoMsg.replace(/^(ok|error):/, '')}</p>}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 24, padding: '16px 20px', background: 'var(--theme-bg)', borderRadius: 0, border: '1px solid var(--theme-border)' }}>
            <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 12px' }}>Preview</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {form.logo_url
                ? <img src={form.logo_url} alt="logo" style={{ width: 32, height: 32, objectFit: 'contain', borderRadius: 0 }} />
                : <span style={{ fontSize: 20, color: 'var(--theme-accent-ink)' }}>⬢</span>
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
              { key: 'property_address', label: 'Address', placeholder: 'e.g. Jhamsikhel, Lalitpur', tip: null },
              { key: 'property_phone', label: 'Phone', placeholder: '01-XXXXXXX', tip: null },
              { key: 'property_email', label: 'Email', placeholder: 'info@property.com', tip: null },
              { key: 'vat_number', label: 'VAT Registration Number', placeholder: 'e.g. 123456789', tip: 'Your business VAT registration number as issued by IRD Nepal. Printed on report headers and used for VAT invoice compliance.' },
              { key: 'invoice_prefix', label: 'Invoice Prefix', placeholder: 'e.g. CAC', tip: 'Short client code used in POS invoice numbers, e.g. TI2238-CAC-82/83. Auto-suggested from the property name; edit if you want something different.', upper: true },
            ].map(f => (
              <div key={f.key} className="form-field">
                <label htmlFor={`set-${f.key}`}>{f.tip ? <Tip text={f.tip} width={280}>{f.label}</Tip> : f.label}</label>
                <input id={`set-${f.key}`} value={form[f.key] || ''} onChange={e => update(f.key, f.upper ? e.target.value.toUpperCase() : e.target.value)} placeholder={f.placeholder} />
              </div>
            ))}
            <div className="form-field">
              <label htmlFor="set-is-vat-registered"><Tip text="On = POS bills print as a Tax Invoice with a VAT breakdown (invoice numbers prefixed TI-). Off = plain Bill, no VAT line, PAN number only (prefixed PB-). Matches whether this client is actually VAT-registered with IRD." width={280}>VAT Registered</Tip></label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', height: 34 }}>
                <input id="set-is-vat-registered" type="checkbox" checked={form.is_vat_registered ?? true}
                  onChange={e => update('is_vat_registered', e.target.checked)}
                  style={{ width: 16, height: 16, padding: 0, margin: 0, flexShrink: 0, background: 'none', border: 'none', accentColor: 'var(--theme-accent)', cursor: 'pointer' }} />
                <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{(form.is_vat_registered ?? true) ? 'Yes — issues Tax Invoices' : 'No — PAN Bill only'}</span>
              </label>
            </div>
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
              { key: 'fc_warning_pct', label: 'Food Cost % — Warning threshold', placeholder: '35', suffix: '%', hint: 'Dashboard turns amber above this', tip: 'FC% above this value turns the dashboard FC% card amber. Nepal F&B benchmark: warn at 35–38%.' },
              { key: 'fc_critical_pct', label: 'Food Cost % — Critical threshold', placeholder: '45', suffix: '%', hint: 'Dashboard turns red above this', tip: 'FC% above this value turns the dashboard FC% card red. Set this higher than the warning threshold.' },
              { key: 'expiry_warning_days', label: 'Expiry Warning — Days ahead', placeholder: '7', suffix: 'days', hint: 'FIFO report flags items expiring within this window', tip: 'Items expiring within this many days are highlighted in the FIFO / Expiry report. E.g. 7 = flag anything expiring within a week.' },
              { key: 'variance_flag_pct', label: 'Variance Flag threshold', placeholder: '10', suffix: '%', hint: 'Variance report flags items above this %', tip: 'Items with a usage variance above this % are highlighted in the Variance Report. E.g. 10 = flag when actual usage is >10% above theoretical.' },
            ].map(f => (
              <div key={f.key} className="form-field">
                <label htmlFor={`set-${f.key}`}><Tip text={f.tip} width={280}>{f.label}</Tip></label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input id={`set-${f.key}`} type="number" value={form[f.key] || ''} onChange={e => update(f.key, e.target.value)} placeholder={f.placeholder} style={{ width: 100 }} />
                  <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{f.suffix}</span>
                </div>
                <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>{f.hint}</span>
              </div>
            ))}
            {[
              { key: 'block_negative_stock', label: 'Block negative stock on save', def: false,
                tip: 'When on, Stock Count refuses to save if any item\'s computed usage goes negative (more used than was ever bought or on hand) — the item(s) must be fixed first. Admin can still override with a confirmation. Off by default.',
                onText: 'Yes — blocks Save All until fixed', offText: 'No — save anyway, just highlighted red (current behavior)' },
              { key: 'warn_below_cost_pricing', label: 'Warn when menu price is below cost', def: true,
                tip: 'When on, Recipes shows a warning if a menu item\'s selling price is set below its computed ingredient cost. Doesn\'t block saving — just a heads-up in case it wasn\'t intentional.',
                onText: 'Yes — shows a warning', offText: 'No — no warning' },
            ].map(f => (
              <div key={f.key} className="form-field">
                <label htmlFor={`set-${f.key}`}><Tip text={f.tip} width={280}>{f.label}</Tip></label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', height: 34 }}>
                  <input id={`set-${f.key}`} type="checkbox" checked={form[f.key] ?? f.def}
                    onChange={e => update(f.key, e.target.checked)}
                    style={{ width: 16, height: 16, padding: 0, margin: 0, flexShrink: 0, background: 'none', border: 'none', accentColor: 'var(--theme-accent)', cursor: 'pointer' }} />
                  <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{(form[f.key] ?? f.def) ? f.onText : f.offText}</span>
                </label>
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
              <label htmlFor="set-item-code-prefix"><Tip text="Short prefix added before the sequential number on every item code. E.g. 'ITM' → ITM-001. Changing this and regenerating will renumber all items." width={280}>Code Prefix</Tip></label>
              <input
                id="set-item-code-prefix"
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

          <div style={{ marginTop: 24, padding: '16px 20px', background: 'var(--theme-bg)', borderRadius: 0, border: '1px solid var(--theme-border)' }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--theme-text1)' }}>Regenerate All Codes</h4>
            <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 12px' }}>
              If items have been deleted, codes may have gaps. Use this to renumber every item sequentially
              from {(form.item_code_prefix || 'ITM').toUpperCase()}-001, alphabetically by name. Save the prefix above first if you've changed it.
            </p>
            <button className="btn btn-ghost" onClick={regenerateAllCodes} disabled={regenerating}>
              {regenerating ? 'Renumbering…' : '↻ Regenerate All Item Codes'}
            </button>
            {regenerateMsg && (
              <p style={{ fontSize: 12, color: regenerateMsg.startsWith('Error') ? 'var(--theme-red-text)' : 'var(--theme-green-text)', margin: '12px 0 0' }}>
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
              <label htmlFor="set-vendor-code-prefix"><Tip text="Short prefix added before the sequential number on every vendor code. E.g. 'VND' → VND-001." width={260}>Code Prefix</Tip></label>
              <input
                id="set-vendor-code-prefix"
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

          <div style={{ marginTop: 24, padding: '16px 20px', background: 'var(--theme-bg)', borderRadius: 0, border: '1px solid var(--theme-border)' }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--theme-text1)' }}>Regenerate All Codes</h4>
            <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 12px' }}>
              If vendors have been deleted, codes may have gaps. Use this to renumber every vendor sequentially
              from {(form.vendor_code_prefix || 'VND').toUpperCase()}-001, alphabetically by name. Save the prefix above first if you've changed it.
            </p>
            <button className="btn btn-ghost" onClick={regenerateAllVendorCodes} disabled={regeneratingVnd}>
              {regeneratingVnd ? 'Renumbering…' : '↻ Regenerate All Vendor Codes'}
            </button>
            {regenerateMsgVnd && (
              <p style={{ fontSize: 12, color: regenerateMsgVnd.startsWith('Error') ? 'var(--theme-red-text)' : 'var(--theme-green-text)', margin: '12px 0 0' }}>
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
              <label htmlFor="set-sub-recipe-code-prefix"><Tip text="Short prefix for sub-recipe codes. E.g. 'SRC' → SRC-001. Sub-recipes appear as reusable ingredients inside other recipes." width={270}>Code Prefix</Tip></label>
              <input
                id="set-sub-recipe-code-prefix"
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

          <div style={{ marginTop: 24, padding: '16px 20px', background: 'var(--theme-bg)', borderRadius: 0, border: '1px solid var(--theme-border)' }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--theme-text1)' }}>Regenerate All Codes</h4>
            <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 12px' }}>
              Renumbers every sub-recipe sequentially from {(form.sub_recipe_code_prefix || 'SRC').toUpperCase()}-001, alphabetically by name. Use this to assign codes to existing sub-recipes or close gaps after deletions.
            </p>
            <button className="btn btn-ghost" onClick={regenerateAllSubRecipeCodes} disabled={regeneratingSrc}>
              {regeneratingSrc ? 'Renumbering…' : '↻ Regenerate All Sub-Recipe Codes'}
            </button>
            {regenerateMsgSrc && (
              <p style={{ fontSize: 12, color: regenerateMsgSrc.startsWith('Error') ? 'var(--theme-red-text)' : 'var(--theme-green-text)', margin: '12px 0 0' }}>
                {regenerateMsgSrc}
              </p>
            )}
          </div>
        </div>
      )}

      {activeTab === 'Product Codes' && (
        <div className="card">
          <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Product Codes</h3>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px' }}>
            Short codes for menu items, taken from the first three letters of the recipe's category —
            Beverage becomes <strong>BEV-001</strong>, <strong>BEV-002</strong> and so on. New recipes
            are given the next code automatically as you write them in Recipe Costing; staff can search
            the code on the POS order screen, and it prints on the Item Wise sales report.
          </p>

          <div style={{ padding: '16px 20px', background: 'var(--theme-bg)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--theme-border)' }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--theme-text1)' }}>Generate Missing Product Codes</h4>
            <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 12px', lineHeight: 1.6 }}>
              Gives a code to every menu item that does not have one yet — use this once for recipes
              created before codes existed. <strong>Codes already in place are never changed</strong>,
              so anything you carried across from your old menu stays exactly as it is. Sub-recipes are
              skipped; they have their own {(form.sub_recipe_code_prefix || 'SRC').toUpperCase()} series
              on the tab before this one.
            </p>
            <button className="btn btn-ghost" onClick={generateMissingProductCodes} disabled={generatingPrd}>
              {generatingPrd ? 'Assigning…' : '＋ Generate Missing Product Codes'}
            </button>
            {generateMsgPrd && (
              <p style={{ fontSize: 12, color: generateMsgPrd.startsWith('Error') ? 'var(--theme-red-text)' : 'var(--theme-green-text)', margin: '12px 0 0' }}>
                {generateMsgPrd}
              </p>
            )}
          </div>
        </div>
      )}

      {/* RECIPE CATEGORIES */}
      {activeTab === 'Recipe Categories' && (
        <div className="card">
          <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Recipe Categories</h3>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px' }}>
            These appear in the recipe form dropdown and as filter tabs. <strong>Sub-Recipe / Prep Item</strong> is system-managed and cannot be removed.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 20 }}>
            {cats.map((cat, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', background: 'var(--theme-bg)' }}>
                <span style={{ flex: 1, fontSize: 13, color: 'var(--theme-text1)' }}>{cat}</span>
                {/* A named control, not a bare glyph dimmed to 0.7 on red text (S682): title is
                    the last-resort naming mechanism and announces nothing on touch. */}
                <button
                  type="button"
                  className="btn btn-danger btn-icon"
                  onClick={() => setCats(prev => prev.filter((_, idx) => idx !== i))}
                  aria-label={`Remove the "${cat}" category`}
                  title={`Remove the "${cat}" category`}
                >×</button>
              </div>
            ))}
            {cats.length === 0 && (
              <p style={{ fontSize: 13, color: 'var(--theme-text3)', fontStyle: 'italic' }}>No categories — add at least one below.</p>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input aria-label="New category name"
              value={newCat}
              onChange={e => setNewCat(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addCat()}
              placeholder="e.g. Cocktails, Combo Meals, Specials"
              style={{ flex: 1 }}
            />
            <button className="btn btn-ghost" onClick={addCat} disabled={!newCat.trim()}>+ Add</button>
          </div>

          <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '0 0 20px' }}>
            Removing a category won't change recipes already tagged with it — they'll still appear under "All Recipes".
          </p>

          <button className="btn btn-primary" onClick={saveCategories} disabled={catSaving || cats.length === 0}>
            {catSaving ? 'Saving…' : 'Save Categories'}
          </button>
          {catMsg && (
            <p style={{ fontSize: 12, marginTop: 10, color: catMsg.startsWith('error') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
              {catMsg.replace(/^(ok|error):/, '')}
            </p>
          )}
        </div>
      )}

      {/* CONTACT */}
      {/* SUPPORT (S683) — two sections: Crest's own line for every client, then the consultant
          override for the client being viewed. The upper section saves to the platform row on its
          own button; the lower rides on the page's Save like every other per-client field. */}
      {activeTab === 'Support' && (() => {
        const hint = { fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }
        const preview = resolveSupportContact({ platform: platformForm, client: null })
        const emergencyOptions = EMERGENCY_CHANNELS.filter(c => preview[c.key])
        const phoneOn = platformForm.phone_enabled !== false
        // The preview renders the FORM, not the row — so it says so while the two differ.
        const platformDirty = JSON.stringify(platformForm) !== platformSeedRef.current
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div className="card">
              <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Crest Support — shown to every client</h3>
              <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 24px' }}>
                The line a client reaches when the app itself cannot help: the crash page, the login footer, the
                offline banners in Stock Count and POS, Help → Support, and the "not on your plan" cards. Blank slots
                simply do not render. Nothing here is per-client — for that, use the section below.
              </p>
              <div className="form-grid form-grid-2">
                <div className="form-field">
                  <label htmlFor="sup-mobile"><Tip text="The number on the Call button. It also serves WhatsApp and Viber unless you give those their own numbers below.">Mobile</Tip></label>
                  <input id="sup-mobile" className="form-input" inputMode="tel" autoComplete="off" value={platformForm.mobile} onChange={e => updatePlatform('mobile', e.target.value)} placeholder="Leave blank for the built-in line" disabled={!phoneOn} />
                  <span style={hint}>{!phoneOn ? 'Not published while the phone line is off' : platformForm.mobile.trim() ? 'Call · WhatsApp · Viber' : `Blank — clients see the built-in number ${supportPhone()}. Type here to replace it.`}</span>
                </div>
                <div className="form-field">
                  <label htmlFor="sup-landline"><Tip text="An office line. Rendered as 'Call office' beside the mobile — it never gets a WhatsApp or Viber link, since a landline cannot take either. Kathmandu lines read 01-XXXXXXX locally, +977 1 XXXXXXX internationally.">Landline</Tip></label>
                  <input id="sup-landline" className="form-input" inputMode="tel" autoComplete="off" value={platformForm.landline} onChange={e => updatePlatform('landline', e.target.value)} placeholder="e.g. +977 1 XXXXXXX (none yet)" disabled={!phoneOn} />
                  <span style={hint}>{phoneOn ? 'Call only — no chat links' : 'Not published while the phone line is off'}</span>
                </div>
                <div className="form-field">
                  <label htmlFor="sup-whatsapp"><Tip text="Only if the WhatsApp number differs from the mobile. Blank uses the mobile.">WhatsApp number</Tip></label>
                  <input id="sup-whatsapp" className="form-input" inputMode="tel" autoComplete="off" value={platformForm.whatsapp} onChange={e => updatePlatform('whatsapp', e.target.value)} placeholder="Blank = same as mobile" />
                  <span style={hint}>Opens wa.me — Meta's click-to-chat link</span>
                </div>
                <div className="form-field">
                  <label htmlFor="sup-viber"><Tip text="Viber is the household default in Nepal for free calls, with 10M+ users beside WhatsApp — a support line that offers one should offer both. Blank uses the mobile.">Viber number</Tip></label>
                  <input id="sup-viber" className="form-input" inputMode="tel" autoComplete="off" value={platformForm.viber} onChange={e => updatePlatform('viber', e.target.value)} placeholder="Blank = same as mobile" />
                  <span style={hint}>Opens a Viber chat on phones with Viber installed</span>
                </div>
                <div className="form-field">
                  <label htmlFor="sup-email">Email</label>
                  <input id="sup-email" className="form-input" type="email" autoComplete="off" value={platformForm.email} onChange={e => updatePlatform('email', e.target.value)} placeholder={`Blank = ${preview.email}`} />
                  <span style={hint}>Blank = the address printed on the Terms page</span>
                </div>
                <div className="form-field">
                  <label htmlFor="sup-website">Website</label>
                  <input id="sup-website" className="form-input" autoComplete="off" value={platformForm.website} onChange={e => updatePlatform('website', e.target.value)} placeholder="e.g. crestsuite.com (none yet)" />
                  <span style={hint}>Shown on Help → Support only</span>
                </div>
                <div className="form-field">
                  <label htmlFor="sup-anydesk"><Tip text="Crest's own AnyDesk ID or alias. Shown on Help → Support as: install AnyDesk, send us your 9-digit address, and accept only a request from THIS alias — AnyDesk shows the requester's alias in the accept dialog, so this is how a client tells Crest from an impostor. Never rendered as a link into Crest's machine.">AnyDesk (Crest's address)</Tip></label>
                  <input id="sup-anydesk" className="form-input" autoComplete="off" value={platformForm.anydesk} onChange={e => updatePlatform('anydesk', e.target.value)} placeholder="e.g. crest@ad or 123 456 789" />
                  <span style={hint}>Remote help — Help → Support only</span>
                </div>
                <div className="form-field">
                  <label htmlFor="sup-hours"><Tip text="General hours, in your own words. Printed under the contact details on Help → Support.">Support hours</Tip></label>
                  <input id="sup-hours" className="form-input" autoComplete="off" value={platformForm.hours} onChange={e => updatePlatform('hours', e.target.value)} placeholder={SUPPORT_HOURS} />
                  <span style={hint}>Blank = {SUPPORT_HOURS}</span>
                </div>
                <div className="form-field">
                  <span className="field-label" id="sup-emergency-label"><Tip text="Switch on only if someone genuinely answers outside the hours above. While on, Help → Support prints: 'If your outlet can't take orders or bill guests, <channel> <number> is answered any time.' Off, that sentence does not exist.">Outlet-down emergencies</Tip></span>
                  <label className="form-check">
                    <input type="checkbox" aria-describedby="sup-emergency-label" checked={!!platformForm.emergency_enabled} onChange={e => updatePlatform('emergency_enabled', e.target.checked)} />
                    <span>Answered any time, outside the hours above</span>
                  </label>
                  <select id="sup-emergency-channel" className="form-select" aria-label="Which line is answered for outlet-down emergencies" value={platformForm.emergency_channel} disabled={!platformForm.emergency_enabled} onChange={e => updatePlatform('emergency_channel', e.target.value)}>
                    {EMERGENCY_CHANNELS.map(c => (
                      <option key={c.key} value={c.key} disabled={!preview[c.key]}>{c.label}{preview[c.key] ? '' : ' — no number'}</option>
                    ))}
                  </select>
                  <span style={hint}>{platformForm.emergency_enabled ? (emergencyOptions.length ? 'Live for every client once saved — they are told this line is answered any time' : 'Add a number above first') : 'No promise is made while this is off'}</span>
                </div>
                <div className="form-field">
                  <span className="field-label" id="sup-phone-label"><Tip text="Off = no Call button anywhere: the crash page, the lock screen, the login footer, the offline banners and Help → Support show email — and WhatsApp or Viber only if you gave those their own numbers. The built-in number is not used either. Switch this off the day the mobile above should stop being published.">Phone line</Tip></span>
                  <label className="form-check">
                    <input type="checkbox" aria-describedby="sup-phone-label" checked={phoneOn} onChange={e => updatePlatform('phone_enabled', e.target.checked)} />
                    <span>Publish a number clients can call</span>
                  </label>
                  <span style={hint}>{phoneOn ? 'A Call button on every support surface' : 'No Call button anywhere. Email always shows.'}</span>
                </div>
              </div>

              <div style={{ marginTop: 20, padding: '14px 18px', background: 'var(--theme-card)', borderRadius: 'var(--radius-md)', border: '1px dashed var(--theme-border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>What a client sees on Help → Support</div>
                  {/* Amber = open, waiting on a person (the One Signal Meaning Rule): unsaved edits are exactly that. */}
                  {platformDirty
                    ? <span className="badge-amber">Unsaved — clients still see the saved version</span>
                    : <span className="badge-gray">As saved</span>}
                </div>
                <SupportContactLine variant="block" contact={preview} />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20, flexWrap: 'wrap' }}>
                <button className="btn btn-primary" onClick={savePlatform} aria-busy={platformSaving || undefined}>
                  {platformSaving ? 'Saving…' : 'Save Support Contact'}
                </button>
                {platformMsg && (
                  <span role={platformMsg.startsWith('ok') ? 'status' : 'alert'} style={{ fontSize: 13, color: platformMsg.startsWith('ok') ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                    {platformMsg.replace(/^(ok|error):/, '')}
                  </span>
                )}
              </div>
            </div>

            <div className="card">
              <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                This client's consultant
              </h3>
              <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 24px' }}>
                Optional, per client. When set, it replaces the Crest line above for this client only — on the upgrade
                prompts, the lock screen and Help → Support — so the client reaches the person who looks after them.
                Blank means they see Crest Support.
              </p>
              {clientId ? (
                <div className="form-grid form-grid-2">
                  <div className="form-field">
                    <label htmlFor="set-contact-phone"><Tip text="Replaces the mobile, WhatsApp and Viber above for this client. The Crest landline is not shown beside a consultant.">Consultant phone</Tip></label>
                    <input id="set-contact-phone" inputMode="tel" autoComplete="off" value={form.contact_phone || ''} onChange={e => update('contact_phone', e.target.value)} placeholder="e.g. 98XXXXXXXX" />
                    <span style={hint}>Call · WhatsApp · Viber for this client</span>
                  </div>
                  <div className="form-field">
                    <label htmlFor="set-contact-email">Consultant email</label>
                    <input id="set-contact-email" type="email" autoComplete="off" value={form.contact_email || ''} onChange={e => update('contact_email', e.target.value)} placeholder={`Blank = ${preview.email}`} />
                    <span style={hint}>Shown as a mailto link</span>
                  </div>
                  <div className="form-field">
                    <label htmlFor="set-contact-website">Website</label>
                    <input id="set-contact-website" autoComplete="off" value={form.contact_website || ''} onChange={e => update('contact_website', e.target.value)} placeholder="e.g. consultant.com.np" />
                    <span style={hint}>Shown on Help → Support only</span>
                  </div>
                </div>
              ) : (
                <p style={{ fontSize: 13, color: 'var(--theme-text3)', margin: 0 }}>
                  Choose a client from the sidebar's client switcher to set their consultant. The Crest line above
                  applies to everyone until then.
                </p>
              )}
              {clientId && (
                // This card's own Save — the same save() the header button runs on every other tab,
                // placed beside the fields it commits so the two cards never share a button (S684).
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary" onClick={() => { if (!saving) save() }} aria-busy={saving || undefined}>
                    {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Consultant'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* PLAN PRICING — the platform's price list, so it saves to the client_id-NULL settings row
          through savePrices(), never through the page-level save() (S701). */}
      {activeTab === 'Plan Pricing' && (() => {
        // priceForm, not `form`: `form` is whichever client's settings row this session read, and
        // writing prices there put them somewhere nothing reads — the save said "✓ Saved" and the
        // price the world sees never moved.
        const imsPrices = priceForm.ims || DEFAULT_PLAN_PRICES.ims
        const setPrices = next => { setPriceForm(next); setPriceMsg('') }
        function updateIms(tier, value) {
          setPrices({
            ...priceForm,
            ims: { ...imsPrices, [tier]: value === '' ? 0 : Math.max(0, parseInt(value) || 0) },
          })
        }
        function updateFlat(key, value) {
          setPrices({ ...priceForm, [key]: value === '' ? 0 : Math.max(0, parseInt(value) || 0) })
        }
        // Monthly and annual are on screen together (S702). They used to be two tabs, which made
        // the annual column a place you had to go and look — for a figure that is not a second
        // price but a printout of this one: annualOf() (×0.75, in pricingPlans.js) is the single
        // definition shared with every screen that quotes an annual rate. Only Monthly is editable
        // here, so the two can never drift apart.
        //
        // A plain function, not a component: a component declared inside render is a NEW type on
        // every keystroke, so React would unmount the input and the field would lose focus after
        // one digit.
        const priceField = ({ id, label, ariaLabel, value, fallback, onChange }) => {
          // The annual RATE and what a year of it actually comes to. The rate alone is the
          // number on the pricing page; the ARR is the number an operator is deciding with, and
          // it was previously only derivable by multiplying in your head.
          const annual = annualOf(value ?? fallback)
          return (
            <div className="form-field" key={id}>
              <label htmlFor={id}>{label}</label>
              <input
                id={id}
                className="form-input"
                type="number" min="0" step="100"
                // Three cards each label their field "Monthly price", so the visible label alone
                // gives three controls one accessible name. The aria-label names the module and
                // still CONTAINS the visible text, which is what WCAG 2.5.3 asks for.
                aria-label={ariaLabel}
                value={value ?? ''}
                onChange={e => onChange(e.target.value)}
                placeholder={String(fallback)}
              />
              <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>
                Annual · NPR {annual.toLocaleString('en-IN')} / Month
                <span style={{ display: 'block', marginTop: 2 }}>
                  ARR · NPR {(annual * 12).toLocaleString('en-IN')} / Year
                </span>
              </span>
            </div>
          )
        }
        const flatCards = [
          { key: 'hr',    color: MODULE_INK.hr,  title: 'Crest HR' },
          { key: 'pos',   color: MODULE_INK.pos, title: 'Crest POS' },
          // Suite is priced here too since S701. It is sold per outlet on top of the modules, so
          // its figure adds to a client's MRR rather than replacing any of the above.
          { key: 'suite', color: MODULE_INK.ims, title: 'Crest Suite Pro' },
        ]
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0, fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  <Tip
                    width={340}
                    text="One price list for the whole platform — saved against Crest itself, not against the client you are currently viewing. What you save here is what the public pricing page, the Help page's Plan & Pricing tab, the module picker in Admin → Clients and every MRR/ARR figure all quote. Annual is calculated at 25% off the monthly price, so only Monthly is editable. It applies the next time each page loads; nobody already subscribed is re-billed or notified."
                  >
                    Plan Prices (NPR)
                  </Tip>
                </h3>
                {/* The Save sits with the fields it commits and NOT in the page header, because the
                    header button writes the viewed client's settings row — the one place these must
                    never go (S684's rule, S701's reason). Everything it saves is on screen with it. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  {priceMsg && (
                    <span role={priceMsg.startsWith('ok') ? 'status' : 'alert'} style={{ fontSize: 13, color: priceMsg.startsWith('ok') ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                      {priceMsg.replace(/^(ok|error):/, '')}
                    </span>
                  )}
                  <button className="btn btn-primary" onClick={savePrices} aria-busy={priceSaving || undefined}>
                    {priceSaving ? 'Saving…' : 'Save Plan Prices'}
                  </button>
                </div>
              </div>
            </div>

            <div className="card">
              <h4 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 700, color: MODULE_INK.ims }}>Crest IMS — tiered</h4>
              <div className="form-grid form-grid-3">
                {['starter', 'growth', 'pro'].map(tier => priceField({
                  id: `set-ims-price-${tier}`,
                  label: <span style={{ textTransform: 'capitalize' }}>{tier} · monthly</span>,
                  value: imsPrices[tier],
                  fallback: DEFAULT_PLAN_PRICES.ims[tier],
                  onChange: v => updateIms(tier, v),
                }))}
              </div>
            </div>

            {/* HR, POS and Suite are one flat price each, so they read as one row of three rather
                than three full-width cards a screen tall (S702). */}
            <div className="form-grid form-grid-3">
              {flatCards.map(card => (
                <div className="card" key={card.key}>
                  <h4 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 700, color: card.color }}>{card.title}</h4>
                  {priceField({
                    id: `set-${card.key}-price`,
                    label: card.key === 'suite' ? 'Monthly, per outlet' : 'Monthly price',
                    ariaLabel: `${card.title} — ${card.key === 'suite' ? 'monthly, per outlet' : 'monthly price'}`,
                    value: priceForm[card.key],
                    fallback: DEFAULT_PLAN_PRICES[card.key],
                    onChange: v => updateFlat(card.key, v),
                  })}
                </div>
              ))}
            </div>
          </div>
        )
      })()}

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
                    padding: '14px 20px', borderRadius: 0, cursor: 'pointer',
                    border: themeKey === key ? `2px solid ${colors.accent}` : '2px solid var(--theme-border)',
                    background: themeKey === key ? 'color-mix(in srgb, var(--theme-accent) 8%, transparent)' : 'var(--theme-card)',
                    minWidth: 180
                  }}
                >
                  {/* Mini color swatch */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
                    <div style={{ display: 'flex', gap: 3 }}>
                      <div style={{ width: 14, height: 14, borderRadius: 0, background: preset.bg, border: '1px solid rgba(255,255,255,0.1)' }} />
                      <div style={{ width: 14, height: 14, borderRadius: 0, background: preset.card, border: '1px solid rgba(255,255,255,0.1)' }} />
                    </div>
                    <div style={{ display: 'flex', gap: 3 }}>
                      <div style={{ width: 14, height: 14, borderRadius: 0, background: preset.accent }} />
                      <div style={{ width: 14, height: 14, borderRadius: 0, background: preset.sidebar, border: '1px solid rgba(255,255,255,0.1)' }} />
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 20px', borderRadius: 0, border: '2px solid var(--theme-accent)', background: 'color-mix(in srgb, var(--theme-accent) 6%, transparent)', minWidth: 180 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div style={{ display: 'flex', gap: 3 }}>
                      <div style={{ width: 14, height: 14, borderRadius: 0, background: colors.bg, border: '1px solid rgba(255,255,255,0.1)' }} />
                      <div style={{ width: 14, height: 14, borderRadius: 0, background: colors.card, border: '1px solid rgba(255,255,255,0.1)' }} />
                    </div>
                    <div style={{ display: 'flex', gap: 3 }}>
                      <div style={{ width: 14, height: 14, borderRadius: 0, background: colors.accent }} />
                      <div style={{ width: 14, height: 14, borderRadius: 0, background: colors.sidebar, border: '1px solid rgba(255,255,255,0.1)' }} />
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-accent-ink)' }}>Custom ✓</div>
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
                    width: 36, height: 36, borderRadius: 0,
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
                <code style={{ fontSize: 11, color: 'var(--theme-text3)', fontFamily: 'monospace', background: 'var(--theme-bg)', padding: '2px 8px', borderRadius: 0 }}>
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
              <div style={{ padding: '10px 20px', borderRadius: 0, background: colors.accent, color: colors.accentText, fontSize: 13, fontWeight: 700 }}>
                Primary Button
              </div>
              <div style={{ padding: '10px 20px', borderRadius: 0, background: 'transparent', color: colors.text2, border: `1px solid ${colors.border}`, fontSize: 13 }}>
                Ghost Button
              </div>
              <div style={{ padding: '6px 14px', borderRadius: 0, background: `${colors.green}18`, color: colors.greenText, fontSize: 11, fontWeight: 700 }}>
                Active Badge
              </div>
              <div style={{ padding: '6px 14px', borderRadius: 0, background: `${colors.red}18`, color: colors.redText, fontSize: 11, fontWeight: 700 }}>
                Error Badge
              </div>
            </div>
            <div style={{ marginTop: 16, borderRadius: 0, overflow: 'hidden', border: `1px solid ${colors.border}` }}>
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
            <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--theme-red) 20%, transparent)' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-red-text)' }}>Danger Zone</h3>
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

      {activeTab === 'Guides' && (
        <Suspense fallback={<p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading guides…</p>}>
          <GuidesTab />
        </Suspense>
      )}
      </div>
      {confirmEl}
    </div>
  )
}
