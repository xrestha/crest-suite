import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { ArrowUp, ArrowDown } from 'lucide-react'
import { useSettings } from '../context/SettingsContext'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import { useScopedDb } from '../shared/hooks/useScopedDb'
import { useTheme, PRESETS, SYSTEM_KEY } from '../context/ThemeContext'
import Tip from '../components/Tip'
import { MODULE_INK, DEFAULT_PLAN_PRICES, annualOf } from '../data/pricingPlans'
import { assignMissingProductCodes, SUB_RECIPE_CATEGORY } from '../shared/productCode'
import { useConfirm } from '../shared/hooks/useConfirm'
import { Navigate, Link } from 'react-router-dom'
import SupportContactLine from '../components/SupportContactLine'
import ActionError, { asActionError } from '../components/ActionError'
import FieldError, { fieldAria } from '../components/FieldError'
import { fcThresholds, varianceFlagPct } from '../shared/imsFormulas'
import { fetchAllRows } from '../shared/fetchAllRows'
import { DEFAULT_SUPPORT_CONTACT, EMERGENCY_CHANNELS, SUPPORT_HOURS, resolveSupportContact, supportPhone } from '../shared/supportContact'
import { NEPAL_CITIES, cityByKey } from '../shared/nepalCities'
import { validateRainPct, RAIN_PCT_MIN, RAIN_PCT_MAX, RAIN_MM, WEATHER_HORIZON_DAYS } from '../modules/dashboard/weatherEffect'

// Lazy so the three module guides' prose (several thousand lines of admin-only strings) lives in
// its own on-demand chunk instead of the Settings chunk every client login downloads — the Guides
// tab is admin-only, so a client can never render it.
const GuidesTab = lazy(() => import('./settings/GuidesTab'))

// A tab's DOM id, for the roving focus and the tabpanel's aria-labelledby.
const tabSlug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-')

const ALL_TABS = ['Branding', 'Property', 'Thresholds', 'Item Codes', 'Vendor Codes', 'Sub-Recipe Codes', 'Product Codes', 'Recipe Categories', 'Weather', 'Support', 'Plan Pricing', 'Data', 'Theme', 'Guides']

// The columns the page-level Save Changes button owns — and the ONLY columns it may write (S730).
// `settings` is one row per client that nine other pages write their own columns onto
// (`pos_note_presets`, `pos_discount_reasons`, `pos_reservation_settings`, `tada_*`,
// `ims_custom_roles`, `hr_custom_roles`, `pos_custom_roles`, `combo_discount_pct`, …). save() used
// to send the whole `form`, which was the whole row as it stood when this page LOADED — so an
// owner who left Settings open while a manager added a discount reason on the till, then pressed
// Save on Thresholds, put the row back the way it was. Nothing on either screen said so: the
// manager's save had reported success, and so did the owner's. Every other tab on this page has
// its own writer for the same reason (Support → the platform row, Plan Pricing → the platform
// row, Recipe Categories → one column); this list is what makes the page-level button one too.
// The per-client consultant, edited on the Support tab's LOWER card. Its own list because that
// card has its own Save (S684) and must commit these three columns and nothing else — and because
// leaving them out of PAGE_FIELDS entirely is what broke it: `save()` walks PAGE_FIELDS, so from
// S730 until this was found the patch was always empty, the write was skipped by
// `if (Object.keys(patch).length)`, and the button still reported "✓ Saved". The fields are read
// on Help → Support, PremiumGate's upsell card and SubscriptionLock's lock screen
// (resolveSupportContact's `client` half), so the consultant override simply stopped existing.
export const CONSULTANT_FIELDS = ['contact_phone', 'contact_email', 'contact_website']
// The weather-adjusted sales forecast (S784): the outlet's city, its coordinates (written together
// by the city picker; the weather-forecast Edge Function reads them from the row, never from the
// request) and the Owner's rainy-day percentage.
export const WEATHER_FIELDS = ['weather_city', 'weather_lat', 'weather_lon', 'rain_sales_pct']

// Which columns each TAB owns. The page-level Save writes the union over the tabs the viewer
// actually has, which is what keeps the threshold validation self-limiting: an admin has no
// Thresholds tab, so a stored 0 or an inverted warn/critical pair on the client's row is not theirs
// to fix and cannot refuse their branding save. Reading the scope off the visible tabs also means a
// new tab cannot quietly inherit another tab's columns.
export const TAB_FIELDS = {
  Branding: ['app_name', 'app_tagline', 'logo_url'],
  Property: ['property_address', 'property_phone', 'property_email', 'vat_number', 'invoice_prefix', 'is_vat_registered'],
  Thresholds: ['fc_warning_pct', 'fc_critical_pct', 'expiry_warning_days', 'variance_flag_pct',
               'block_negative_stock', 'warn_below_cost_pricing'],
  'Item Codes': ['item_code_prefix'],
  'Vendor Codes': ['vendor_code_prefix'],
  'Sub-Recipe Codes': ['sub_recipe_code_prefix'],
  Support: CONSULTANT_FIELDS,
  Weather: WEATHER_FIELDS,
  // Nothing for the page button to write: one action, a per-device theme, reference prose, and two
  // cards that commit the PLATFORM row through their own savers.
  'Product Codes': [], 'Recipe Categories': [], 'Plan Pricing': [], Data: [], Theme: [], Guides: [],
}
export const PAGE_FIELDS = [
  'app_name', 'app_tagline', 'logo_url',
  'property_address', 'property_phone', 'property_email', 'vat_number', 'invoice_prefix', 'is_vat_registered',
  'fc_warning_pct', 'fc_critical_pct', 'expiry_warning_days', 'variance_flag_pct',
  'block_negative_stock', 'warn_below_cost_pricing',
  'item_code_prefix', 'vendor_code_prefix', 'sub_recipe_code_prefix',
  ...CONSULTANT_FIELDS,
  ...WEATHER_FIELDS,
]
// Every tab's columns must have a home in PAGE_FIELDS, or the seed below stops preserving an unsaved
// edit on that tab across a reseed and the field silently reverts under the typist.
if (process.env.NODE_ENV !== 'production') {
  for (const [t, fields] of Object.entries(TAB_FIELDS)) {
    for (const f of fields) if (!PAGE_FIELDS.includes(f)) throw new Error(`Settings: ${t} owns ${f}, which is not in PAGE_FIELDS`)
  }
}
// Tabs whose fields ride on that button. Recipe Categories, Theme and Product Codes have nothing
// for it to save — Categories has its own Save, Theme is per-device, Product Codes is one action —
// so a Save Changes button there wrote a row for no reason and, on Categories, wrote the STALE
// category list from the loaded row over whatever had just been typed into the list beside it.
const PAGE_SAVE_TABS = new Set(['Branding', 'Property', 'Thresholds', 'Item Codes', 'Vendor Codes', 'Sub-Recipe Codes', 'Weather'])
// Tabs whose fields are the viewed row itself, so a failed read of that row leaves nothing real to
// show (S747). SettingsContext used to drop the error and hand over DEFAULT_SETTINGS — "Crest Suite"
// as a client's brand, a blank VAT number — as editable values. Product Codes reads recipes, and
// the Support tab gates only its consultant card, so neither is on the list.
const ROW_TABS = new Set([...PAGE_SAVE_TABS, 'Recipe Categories'])
// numeric columns: '' in the box is NULL in the row (readers fall back to the default), never ''
// — Postgres refuses '' for numeric and integer, and the error it raised named the type.
const NUMERIC_FIELDS = { fc_warning_pct: 'float', fc_critical_pct: 'float', expiry_warning_days: 'int', variance_flag_pct: 'float' }
// The Weather tab's numbers, kept OUT of NUMERIC_FIELDS: that map is what puts validateThresholds()
// in scope, and a weather save must neither run it nor be sent to the Thresholds tab by it.
const WEATHER_NUMERIC = { weather_lat: 'float', weather_lon: 'float', rain_sales_pct: 'int' }

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function toNumberOrNull(v, kind) {
  if (v === '' || v == null) return null
  const n = kind === 'int' ? parseInt(v, 10) : parseFloat(v)
  return Number.isFinite(n) ? n : NaN
}

// The threshold rules, in one place, against the DEFAULTS the readers actually use. Every reader
// is `parseFloat(x) || default` (imsFormulas.js), so a stored 0 is silently the default — the box
// would say 0 and every report would band at 35 — which is why 0 is refused rather than saved.
export function validateThresholds(form) {
  const errs = {}
  const val = {}
  for (const [k, kind] of Object.entries(NUMERIC_FIELDS)) {
    const n = toNumberOrNull(form[k], kind)
    val[k] = n
    if (n === null) continue
    if (Number.isNaN(n) || n <= 0) errs[k] = 'Enter a number above 0 — or leave it blank to use the default shown.'
    else if (kind === 'int' && !Number.isInteger(n)) errs[k] = 'Whole days only.'
  }
  const defaults = fcThresholds({})
  const warn = val.fc_warning_pct ?? defaults.warn
  const crit = val.fc_critical_pct ?? defaults.critical
  if (!errs.fc_warning_pct && !errs.fc_critical_pct && crit <= warn) {
    errs.fc_critical_pct = `Critical must be above the warning level (${warn}%), or no figure can ever land in the amber band.`
  }
  return errs
}

const pad3 = n => String(n).padStart(3, '0')

// The Storage object path inside the Logos bucket, from a stored public URL (`…/Logos/<path>?v=…`).
function logoObjectPath(url) {
  const stored = String(url || '')
  const marker = '/Logos/'
  const i = stored.indexOf(marker)
  return i === -1 ? null : decodeURIComponent(stored.slice(i + marker.length).split('?')[0])
}

// A plan-price table in ONE key order with absent left absent — the shape the Plan Pricing form is
// seeded in and compared in. Built field by field rather than spread over the stored row, because
// the live row still carries the JSONB column's original DEFAULT (flat `starter`/`growth`/`pro` keys
// from before IMS tiers moved under `ims`); spreading it would carry three dead prices into every save.
function canonicalPrices(table) {
  const stored = table || {}
  const storedIms = stored.ims || {}
  return {
    ims: Object.fromEntries(['starter', 'growth', 'pro']
      .filter(t => typeof storedIms[t] === 'number')
      .map(t => [t, storedIms[t]])),
    ...(typeof stored.hr === 'number' ? { hr: stored.hr } : {}),
    ...(typeof stored.pos === 'number' ? { pos: stored.pos } : {}),
    ...(typeof stored.customization === 'number' ? { customization: stored.customization } : {}),
    ...(typeof stored.suite === 'number' ? { suite: stored.suite } : {}),
  }
}

export default function Settings() {
  const { settings, saveSettings, recipeCategories, platformSupport, savePlatformSupport,
          planPrices, savePlatformPlanPrices, settingsLoadError, platformLoadError, platformLoaded } = useSettings()
  const { ask: askConfirm, confirmEl } = useConfirm()
  const { clientId, isAdmin, isOwner, adminViewClientName, hasFeature, hasImsAccess } = useAuth()
  const { scopedFrom, scopedUpdate } = useScopedDb()
  const { themeKey, colors, switchPreset, updateColor } = useTheme()
  const ADMIN_TABS = new Set(['Branding', 'Property', 'Weather', 'Support', 'Plan Pricing', 'Theme', 'Data', 'Guides'])
  const CLIENT_HIDDEN = new Set(['Support', 'Branding', 'Property', 'Data', 'Plan Pricing', 'Guides'])
  const TABS = ALL_TABS.filter(t => {
    if (isAdmin) return ADMIN_TABS.has(t)
    if (CLIENT_HIDDEN.has(t)) return false
    if (t === 'Sub-Recipe Codes' && !hasFeature('recipe_costing')) return false
    if (t === 'Recipe Categories' && !hasFeature('recipe_costing')) return false
    // The Owner's call, like the rest of how the business reads its own trade: an IMS manager
    // reaches this page for thresholds and codes, not for this.
    if (t === 'Weather' && !(isOwner && hasFeature('weather_forecast'))) return false
    return true
  })
  // WHOSE row this page is editing, which is not the same question as "is the viewer an admin".
  // `settings` is one row per client plus one platform row (client_id NULL), and an admin reaches
  // either depending on whether a client is selected in the top bar. Branding and Property labelled
  // themselves off `isAdmin` instead, so an admin viewing a client edited that client's white-label
  // brand — their sidebar, top bar and recipe cost cards (Layout.js: "this is the CUSTOMER's
  // brand") — under the label "App Name" with "Crest Suite" in the placeholder.
  const editingClient = !!clientId
  const rowLabel = editingClient ? (adminViewClientName || 'this client') : 'Crest itself'
  const [activeTab, setActiveTab] = useState(isAdmin ? 'Branding' : 'Thresholds')
  const [form, setForm] = useState({ ...settings })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  // Which button the saving/saved/error state above belongs to (S747): 'page' (the header's Save
  // Changes) or 'consultant' (the Support tab's lower card). They shared one state, so a failed
  // consultant save reported at the top of the tab, a screen above the button that was pressed,
  // and a consultant save's "✓ Saved" carried onto the header button of the next tab opened.
  const [saveScope, setSaveScope] = useState('page')
  const logoInputRef = useRef(null)
  const [fieldErr, setFieldErr] = useState({})
  // How many recipes hold each category, keyed by category name — so removing one says what it
  // orphans. null until read; a failed read leaves the counts unknown and the page says so.
  const [catUsage, setCatUsage] = useState(null)
  const [catUsageErr, setCatUsageErr] = useState(null)
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
  // Seeded from what is STORED, with absent left absent — a blank box is "use the shipped figure",
  // which is the state a row that has never been edited is actually in. Seeding the defaults INTO
  // the boxes instead made every field look like a saved decision and, with `'' → 0` on the way
  // back out, left no way to return a price to its default: clearing a box published NPR 0, and 0
  // is a real price that survives every reader on purpose (withMonthly, clientMrr).
  const [priceForm, setPriceForm] = useState({ ims: {} })
  const [priceSaving, setPriceSaving] = useState(false)
  const [priceMsg, setPriceMsg] = useState('')
  const priceSeedRef = useRef(null)
  useEffect(() => {
    // canonicalPrices() explains the field-by-field build.
    const next = canonicalPrices(planPrices)
    const key = JSON.stringify(next)
    if (key === priceSeedRef.current) return
    priceSeedRef.current = key
    setPriceForm(next)
  }, [planPrices])

  // Which client the page's state belongs to (S721's shape). An admin switching client in the top
  // bar does not remount this page, so without this the previous client's regenerate results and
  // category message stayed on screen under the new client's header.
  const loadedClientRef = useRef(clientId)
  useEffect(() => {
    if (loadedClientRef.current !== clientId) {
      loadedClientRef.current = clientId
      setRegenerateMsg(''); setRegenerateMsgVnd(''); setRegenerateMsgSrc(''); setGenerateMsgPrd('')
      setCatMsg(''); setError(''); setFieldErr({}); setCatUsage(null); setCatUsageErr(null)
    }
    // No loadSettings() here (S747): SettingsProvider already loads on the same [clientId,
    // isAdmin] change, so every client switch read the row twice with nothing deciding which
    // response won. The provider now owns the load and discards a superseded one.
  }, [clientId, isAdmin])

  // Seeds `form` from the stored row — and KEEPS what has been typed since the previous seed.
  // `settings` is re-read after every save on this page, including Save Categories and the three
  // Regenerate buttons, and a plain reseed on each of those wiped every unsaved edit on every
  // other tab: type a warning level, save the categories, and the warning level was gone with
  // nothing to say so. A field is preserved when it differs from the row it was LAST seeded
  // from; a different client's row replaces everything (an edit is never carried across tenants).
  const seedRef = useRef(null)
  useEffect(() => {
    const prev = seedRef.current
    seedRef.current = settings
    setForm(f => {
      // No invented invoice code (S747). This used to fill a blank `invoice_prefix` from the
      // property name ("Casa Acai Cafe" → CAC), which made `form` differ from the row, so the next
      // Save on ANY tab committed it — silently, because the renumbering warning only fired when
      // there had been a previous code. A client billing without a code prints TI2238-82/83, so
      // every past bill then reprinted as TI2238-CAC-82/83. Decided with Aashish: suggest, never
      // save — the box stays blank with a placeholder until someone types a code.
      const next = { ...settings }
      if (prev && (prev.client_id ?? null) === (settings.client_id ?? null)) {
        for (const k of PAGE_FIELDS) {
          if (k in f && !sameValue(f[k], prev[k])) next[k] = f[k]
        }
      }
      return next
    })
  }, [settings])
  useEffect(() => { setCats([...recipeCategories]) }, [recipeCategories]) // eslint-disable-line

  // Category usage, for the Recipe Categories tab. One row per recipe, so paged — a client's
  // menu is master data, but a truncated read here would report a category as unused and let it
  // be removed without a word (the S528 rule: truncation returns no error).
  useEffect(() => {
    if (!clientId || isAdmin || !hasFeature('recipe_costing')) return
    let cancelled = false
    fetchAllRows(() => scopedFrom('recipes', 'id, category').order('id')).then(({ data, error: err }) => {
      if (cancelled) return
      if (err) { setCatUsageErr(asActionError(err)); return }
      const counts = {}
      for (const r of data || []) {
        if (r.category === SUB_RECIPE_CATEGORY) continue
        const key = r.category || ''
        counts[key] = (counts[key] || 0) + 1
      }
      setCatUsage(counts)
    })
    return () => { cancelled = true }
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  function update(key, val) {
    setForm(f => ({ ...f, [key]: val }))
    if (fieldErr[key]) setFieldErr(e => ({ ...e, [key]: '' }))
  }

  // The city picker writes the three location columns together, so the name and the coordinates the
  // weather is read for can never disagree. Blank clears all three: no city, no weather.
  function pickCity(key) {
    const c = cityByKey(key)
    setForm(f => ({ ...f, weather_city: c ? c.key : null, weather_lat: c ? c.lat : null, weather_lon: c ? c.lon : null }))
  }

  // A category the recipes still use that is not in the list — removed here, or never added.
  const orphanCats = catUsage
    ? Object.keys(catUsage).filter(c => c && !cats.some(x => x.toLowerCase() === c.toLowerCase()))
    : []

  function addCat(nameArg) {
    const name = (nameArg ?? newCat).trim()
    if (!name) return
    // Silently doing nothing on a duplicate is the shape S729 took out of ImsStaff — say why.
    if (cats.some(c => c.toLowerCase() === name.toLowerCase())) { setCatMsg(`error:"${name}" is already in the list.`); return }
    if (name.toLowerCase() === SUB_RECIPE_CATEGORY.toLowerCase()) { setCatMsg('error:Sub-Recipe is managed by the app and is always available in the recipe form — it cannot be added here.'); return }
    setCats(prev => [...prev, name])
    setNewCat('')
    setCatMsg('')
  }

  // S767: the list's order is also the order of sections on the guest QR menu, so it can be moved.
  function moveCat(i, delta) {
    setCats(prev => {
      const j = i + delta
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
    setCatMsg('')
  }

  function removeCat(i) {
    const cat = cats[i]
    const n = catUsage?.[cat] || 0
    const doRemove = () => setCats(prev => prev.filter((_, idx) => idx !== i))
    if (n === 0) { doRemove(); return }
    askConfirm({
      title: `Remove "${cat}"?`,
      confirmLabel: 'Remove', danger: true,
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            <strong>{n} recipe{n === 1 ? '' : 's'}</strong> {n === 1 ? 'is' : 'are'} filed under "{cat}". They keep that
            label and stay on their own tab in Recipe Costing, but the category leaves the dropdown, so no new
            dish can be filed under it and an existing one can only move out of it.
          </p>
          <p style={{ margin: 0 }}>Nothing is written until you press Save Categories.</p>
        </>
      ),
      run: async () => doRemove(),
    })
  }

  async function saveCategories() {
    if (catSaving) return
    const cleaned = cats.map(c => c.trim()).filter(Boolean)
    if (cleaned.length === 0) { setCatMsg('error:Add at least one category.'); return }
    setCatSaving(true); setCatMsg('')
    try {
      // One column, never `{ ...settings, … }`: the context's copy of the row is fresher than the
      // page's form, but it is still a snapshot, and the same last-writer-wins applies.
      await saveSettings({ recipe_categories: cleaned })
      setCatMsg('ok:Categories saved.')
      setTimeout(() => setCatMsg(''), 2500)
    } catch (e) {
      setCatMsg('error:' + e.message)
    }
    setCatSaving(false)
  }

  // The fields this page owns that differ from the stored row, typed for the column.
  function pagePatch(fields = PAGE_FIELDS) {
    const patch = {}
    for (const k of fields) {
      if (!(k in form)) continue
      let v = form[k]
      if (k in NUMERIC_FIELDS) v = toNumberOrNull(v, NUMERIC_FIELDS[k])
      else if (k in WEATHER_NUMERIC) v = toNumberOrNull(v, WEATHER_NUMERIC[k])
      else if (typeof v === 'string' && k !== 'logo_url') v = v.trim()
      // A never-set VAT flag is read as registered by every reader (`?? true` in PosOrders,
      // viewPosBill, CreditNotes, computeMonthlyReport), and the box shows it ticked. Ticking it
      // off and on again is therefore no change — it used to be `true` vs NULL, a patch, and a
      // false "past PAN bills will reprint as Tax Invoices" warning (S747).
      if (k === 'is_vat_registered' && (v ?? true) === (settings[k] ?? true)) continue
      if (!sameValue(v, settings[k])) patch[k] = v
    }
    return patch
  }

  // The two Property fields that rewrite documents ALREADY ISSUED, and are therefore worth a
  // confirmation rather than a tooltip. `pos_orders` stores only `invoice_no` and `invoice_fy`; the
  // printed document number is assembled at PRINT time from the settings row that is current when
  // the bill is reprinted (posOrderPrintHtml.js), so neither of these edits is forward-only:
  //   * `invoice_prefix` — every past bill's number changes with it, TI2238-CAC-82/83 → …-CASA-….
  //   * `is_vat_registered` — the TI/PB prefix AND the VAT breakdown are both resolved the same
  //     way, so switching it off reprints a tax invoice as a PAN bill, number included.
  // Changing either is legitimate (a client registers for VAT, or the code was typed wrong on day
  // one); doing it without being told it reaches history is not.
  function retroWarnings(patch) {
    const out = []
    // A FIRST code is as retroactive as a changed one (S747): a bill issued with no code prints
    // TI2238-82/83 and reprints as TI2238-CAC-82/83 once one is set. The warning used to require
    // an old code, which is why the invented one above could go through without it.
    if ('invoice_prefix' in patch) {
      const was = settings.invoice_prefix || ''
      const now = patch.invoice_prefix || ''
      out.push(was
        ? `Every bill this client has already issued reprints with the new code — ${was} becomes ${now || '(no code)'} on past invoices as well as new ones, because the number is assembled when a bill is printed, not when it is billed.`
        : `If this client has already issued bills without a code, every one of them reprints with ${now} added to its number from now on, because the number is assembled when a bill is printed, not when it is billed.`)
    }
    if ('is_vat_registered' in patch) {
      out.push(patch.is_vat_registered
        ? 'Past bills printed as plain PAN bills will reprint as Tax Invoices (PB→TI) with a VAT breakdown added, since the bill type is decided when a bill is printed.'
        : 'Past Tax Invoices will reprint as plain PAN bills (TI→PB) with the VAT breakdown removed, since the bill type is decided when a bill is printed.')
    }
    return out
  }

  // `fields` scopes the write to the card that asked for it: the header button owns PAGE_FIELDS,
  // the Support tab's consultant card owns CONSULTANT_FIELDS (S684 — two cards, two Saves, never
  // one button committing the other's fields).
  async function save({ fields = PAGE_FIELDS, scope = 'page' } = {}) {
    if (saving) return  // the button stays enabled while busy (DESIGN.md), so this is the guard
    setSaveScope(scope)
    setSaved(false)
    setError('')
    // Only when a threshold is actually in scope. It used to run on every save, against the values
    // in the STORED row — so an admin, who has no Thresholds tab at all, was refused a Branding or
    // consultant save over a client's pre-S730 row holding a 0 or a critical level below its
    // warning level (both saved happily until S730 began refusing them), and was then sent to
    // `setActiveTab('Thresholds')`: a tab absent from ADMIN_TABS, so no tab rendered as selected
    // and the panel appeared with nothing above it.
    const inScope = fields.some(k => k in NUMERIC_FIELDS)
    if (inScope) {
      const errs = validateThresholds(form)
      setFieldErr(errs)
      if (Object.keys(errs).length) {
        if (TABS.includes('Thresholds')) setActiveTab('Thresholds')
        setError('Nothing was saved — a threshold needs correcting first (marked below).')
        return
      }
    }
    if (fields.includes('rain_sales_pct')) {
      const msg = validateRainPct(form.rain_sales_pct)
      setFieldErr(e => ({ ...e, rain_sales_pct: msg || '' }))
      if (msg) {
        setError('Nothing was saved — the rainy-day figure needs correcting first (marked below).')
        return
      }
    }
    const patch = pagePatch(fields)
    const warnings = retroWarnings(patch)
    if (warnings.length) {
      askConfirm({
        title: warnings.length > 1 ? 'Change the bill type and the invoice code?' : ('is_vat_registered' in patch ? 'Change the bill type?' : 'Change the invoice code?'),
        confirmLabel: 'Save anyway', danger: true, busyLabel: 'Saving…',
        body: (
          <>
            {warnings.map((w, i) => <p key={i} style={{ margin: i ? '0 0 8px' : '0 0 8px' }}>{w}</p>)}
            <p style={{ margin: 0 }}>Nothing else on this tab is affected.</p>
          </>
        ),
        run: () => commitPatch(patch),
      })
      return
    }
    await commitPatch(patch)
  }

  async function commitPatch(patch) {
    setSaving(true)
    try {
      if (Object.keys(patch).length) await saveSettings(patch)
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

  // Which prices are about to be published as free. 0 is a legitimate configuration and every
  // reader keeps it deliberately, so it cannot be validated away — but it is also one keystroke
  // from a cleared box, so it is named before it is committed.
  function zeroPrices(pf) {
    const out = []
    for (const t of ['starter', 'growth', 'pro']) if (pf.ims?.[t] === 0) out.push(`IMS ${t}`)
    if (pf.hr === 0) out.push('HR')
    if (pf.pos === 0) out.push('POS')
    if (pf.customization === 0) out.push('Customization')
    if (pf.suite === 0) out.push('Crest Suite Pro')
    return out
  }

  async function savePrices() {
    if (priceSaving) return  // the button stays enabled while busy (DESIGN.md), so this is the guard
    const zeros = zeroPrices(priceForm)
    if (zeros.length) {
      askConfirm({
        title: zeros.length === 1 ? `Publish ${zeros[0]} at NPR 0?` : `Publish ${zeros.length} plans at NPR 0?`,
        confirmLabel: 'Publish', danger: true, busyLabel: 'Saving…',
        body: (
          <>
            <p style={{ margin: '0 0 8px' }}><strong>{zeros.join(', ')}</strong> {zeros.length === 1 ? 'is' : 'are'} set to 0, which is a real price: the public pricing page prints NPR 0, and every MRR and ARR figure counts it as nothing.</p>
            <p style={{ margin: 0 }}>To restore the shipped figure instead, clear the box and leave it blank.</p>
          </>
        ),
        run: () => commitPrices(),
      })
      return
    }
    await commitPrices()
  }

  async function commitPrices() {
    setPriceSaving(true); setPriceMsg('')
    try {
      await savePlatformPlanPrices(canonicalPrices(priceForm))
      setPriceMsg('ok:Prices saved — the public pricing page, Help > Plan & Pricing and every MRR figure now quote them.')
      setTimeout(() => setPriceMsg(''), 5000)
    } catch (e) {
      setPriceMsg('error:' + e.message)
    }
    setPriceSaving(false)
  }

  // The stored URL carries a version, because the object path does not. `upsert: true` writes the
  // replacement to the SAME path, and getPublicUrl() returns the same URL for it — so with Storage's
  // default one-hour cacheControl a client who had already loaded the old logo went on seeing it,
  // and the admin's second upload looked like it had done nothing. The `?v=` makes the URL change
  // when the file does, which also makes a long cache life correct rather than risky.
  const LOGO_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/webp': 'webp' }

  async function handleLogoUpload(file) {
    if (file.size > 2 * 1024 * 1024) { setLogoMsg('error:File must be under 2MB.'); return }
    // Keyed off the mime type, not file.name — a file with no dot in its name made `.pop()` return
    // the whole name and wrote `<client>/logo.mylogo`.
    const ext = LOGO_EXT[file.type] || (file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : 'png')
    setLogoUploading(true); setLogoMsg('')
    const path = `${clientId || 'admin'}/logo.${ext}`
    const { error: uploadErr } = await supabase.storage.from('Logos')
      .upload(path, file, { upsert: true, contentType: file.type, cacheControl: '31536000' })
    if (uploadErr) { setLogoMsg('error:' + uploadErr.message); setLogoUploading(false); return }
    const { data: { publicUrl } } = supabase.storage.from('Logos').getPublicUrl(path)
    const versioned = `${publicUrl}?v=${Date.now()}`
    const previous = form.logo_url
    setForm(f => ({ ...f, logo_url: versioned }))
    try {
      await saveSettings({ logo_url: versioned })
      setLogoMsg('ok:Logo saved.')
      setTimeout(() => setLogoMsg(''), 3000)
      // A replacement of a different TYPE lands at a different path (logo.png → logo.svg), so the
      // upsert overwrote nothing and the old file stayed publicly readable at its own URL (S747).
      // Best effort and quiet, exactly as Remove below: the row already points at the new file.
      const oldPath = logoObjectPath(previous)
      if (oldPath && oldPath !== path) {
        const { error: rmErr } = await supabase.storage.from('Logos').remove([oldPath])
        if (rmErr) console.error('Previous logo file not deleted from Storage:', rmErr.message)
      }
    } catch (e) {
      setForm(f => ({ ...f, logo_url: previous }))
      setLogoMsg('error:The file uploaded, but the row still points at the old logo. ' + e.message)
    }
    setLogoUploading(false)
  }

  function handleLogoRemove() {
    // Destructive enough to ask: the preview, the client's sidebar and their printed cost cards all
    // lose the mark, and the file itself goes with it.
    askConfirm({
      title: 'Remove the logo?',
      confirmLabel: 'Remove', danger: true, busyLabel: 'Removing…',
      body: <p style={{ margin: 0 }}>{editingClient ? <>This client falls back</> : <>Crest falls back</>} to the default ⬢ mark everywhere the logo appears. A new one can be uploaded at any time.</p>,
      run: async () => {
        const previous = form.logo_url
        setForm(f => ({ ...f, logo_url: null }))
        setLogoMsg('')
        try {
          await saveSettings({ logo_url: null })
        } catch (e) {
          // Put the preview back: it showed no logo while the row still held one.
          setForm(f => ({ ...f, logo_url: previous }))
          setLogoMsg('error:The logo is still in place — the change did not save. ' + e.message)
          return
        }
        // Best effort, and deliberately quiet: the column is cleared, so the logo is gone from
        // every screen whatever Storage says, and there is no action the admin could take on a
        // failure here. Without it the file stayed publicly readable at its own URL after Remove.
        const objectPath = logoObjectPath(previous)
        if (objectPath) {
          const { error: rmErr } = await supabase.storage.from('Logos').remove([objectPath])
          if (rmErr) console.error('Logo file not deleted from Storage:', rmErr.message)
        }
      },
    })
  }

  // One write per row, stopping at the first failure and saying how far it got. Every row's
  // result used to be dropped (`await scopedUpdate(...)` with nothing read back), so a refused
  // write — and on sub-recipes a unique-index collision, see below — reported "✓ Renumbered".
  async function writeCodes(rows, write) {
    let done = 0
    for (const row of rows) {
      const { error: err } = await write(row)
      if (err) {
        const a = asActionError(err)
        throw new Error(`Stopped at "${row.name}" after ${done} of ${rows.length}: ${a.text}${a.detail ? ` (${a.detail})` : ''}`)
      }
      done++
    }
    return done
  }

  async function regenerateAllCodes() {
    const prefix = (form.item_code_prefix || 'ITM').trim().toUpperCase() || 'ITM'
    askConfirm({
      title: 'Renumber every item?',
      confirmLabel: 'Renumber All', danger: true, busyLabel: 'Renumbering…',
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            Every item is given a new sequential code — <strong>{prefix}-001</strong>, <strong>{prefix}-002</strong> and
            so on — closing the gaps left by deletions. Codes already printed on past bills, stock sheets and
            reports will no longer match what this list shows.
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
      // The prefix alone — never `{ ...form, … }`, which committed every other tab's unsaved
      // edits as a side effect of pressing Renumber, and wrote the whole stale row (PAGE_FIELDS).
      if (prefix !== (settings.item_code_prefix || '')) await saveSettings({ item_code_prefix: prefix })

      // Real items only. A sub-recipe's mirror row in `items` carries the sub-recipe's OWN code
      // (SRC-nnn, written by Recipes.js) and is hidden from Item Master — so renumbering it here
      // stamped an ITM code over the SRC one that the ingredient rows print, and left the hidden
      // gaps this button exists to close.
      const { data: items, error: fetchErr } = await scopedFrom('items', 'id, name')
        .eq('is_sub_recipe', false)
        .order('name').order('id')
      if (fetchErr) throw new Error(asActionError(fetchErr).text)

      const rows = (items || []).map((it, i) => ({ ...it, code: `${prefix}-${pad3(i + 1)}` }))
      const done = await writeCodes(rows, r => scopedUpdate('items', { item_code: r.code }).eq('id', r.id))
      setRegenerateMsg(`✓ Renumbered ${done} item${done === 1 ? '' : 's'} as ${prefix}-001 through ${prefix}-${pad3(done)}. Sub-recipes keep their own codes.`)
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
      if (prefix !== (settings.vendor_code_prefix || '')) await saveSettings({ vendor_code_prefix: prefix })

      // Archived vendors are included on purpose: `vendor_code` has no unique index, so leaving an
      // archived vendor on VND-003 while an active one is renumbered onto VND-003 would give two
      // suppliers one code the moment the archived one is restored.
      const { data: vendors, error: fetchErr } = await scopedFrom('vendors', 'id, name')
        .order('name').order('id')
      if (fetchErr) throw new Error(asActionError(fetchErr).text)

      const rows = (vendors || []).map((v, i) => ({ ...v, code: `${prefix}-${pad3(i + 1)}` }))
      const done = await writeCodes(rows, r => scopedUpdate('vendors', { vendor_code: r.code }).eq('id', r.id))
      setRegenerateMsgVnd(`✓ Renumbered ${done} vendor${done === 1 ? '' : 's'} as ${prefix}-001 through ${prefix}-${pad3(done)} (archived vendors included, so no two suppliers share a code).`)
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
      if (prefix !== (settings.sub_recipe_code_prefix || '')) await saveSettings({ sub_recipe_code_prefix: prefix })

      const { data: subRecipes, error: fetchErr } = await scopedFrom('recipes', 'id, name, recipe_code, linked_item_id')
        .eq('category', SUB_RECIPE_CATEGORY)
        .order('name').order('id')
      if (fetchErr) throw new Error(asActionError(fetchErr).text)

      const targets = (subRecipes || []).map((r, i) => ({ ...r, code: `${prefix}-${pad3(i + 1)}` }))
      const changing = targets.filter(r => (r.recipe_code || '') !== r.code)

      // TWO passes, because `recipes.recipe_code` is unique per client (recipes_client_recipe_code_key)
      // and a one-pass renumber collides with itself: giving the first row SRC-001 while a row
      // further down still holds SRC-001 is refused by the index. With the per-row error dropped,
      // that refusal was silent and the page reported "✓ Renumbered" over a half-renumbered list.
      // Pass 1 clears every code that is about to move (the index is partial, NULLs are free);
      // pass 2 writes the new ones. A failure in pass 2 leaves the remaining rows with no code,
      // which the message says, and running this again completes it.
      await writeCodes(changing, r => scopedUpdate('recipes', { recipe_code: null }).eq('id', r.id))
      const done = await writeCodes(changing, async r => {
        const { error: err } = await scopedUpdate('recipes', { recipe_code: r.code }).eq('id', r.id)
        if (err) return { error: err }
        // The mirror row in `items` prints this code in every ingredient row that uses the
        // sub-recipe (Recipes.js writes it at insert and nothing else ever updates it), so it
        // moves with the recipe or the two disagree until someone re-saves the sub-recipe.
        if (r.linked_item_id) return scopedUpdate('items', { item_code: r.code }).eq('id', r.linked_item_id)
        return { error: null }
      })
      const total = targets.length
      setRegenerateMsgSrc(total === 0
        ? 'No sub-recipes to renumber.'
        : `✓ ${total} sub-recipe${total === 1 ? '' : 's'} now run ${prefix}-001 through ${prefix}-${pad3(total)} (${done} changed, ${total - done} already correct). Their stock-count items carry the same codes.`)
    } catch (e) {
      setRegenerateMsgSrc(`Error: ${e.message} Any sub-recipe left without a code gets one when this is run again.`)
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
      if (fetchErr) throw new Error(asActionError(fetchErr).text)

      const pending = assignMissingProductCodes(recipes || [])
      if (pending.length === 0) {
        setGenerateMsgPrd('✓ Every menu recipe already has a Product Code — nothing to do.')
        setGeneratingPrd(false)
        return
      }
      const n = pending.length
      // The page's one confirm dialog, not window.confirm: this is a bulk write, and the three
      // Renumber buttons beside it already go through it.
      askConfirm({
        title: `Give ${n} recipe${n === 1 ? '' : 's'} a Product Code?`,
        confirmLabel: 'Assign Codes', busyLabel: 'Assigning…',
        body: (
          <>
            <p style={{ margin: '0 0 8px' }}>
              {n} menu recipe{n === 1 ? ' has' : 's have'} no code. Each gets the next number in its category's
              series — Beverage → <strong>BEV-001</strong>, <strong>BEV-002</strong> and so on.
            </p>
            <p style={{ margin: 0 }}>Recipes that already have a code are not touched.</p>
          </>
        ),
        run: async () => {
          try {
            const done = await writeCodes(pending.map(r => ({ ...r, name: r.recipe_code })),
              r => scopedUpdate('recipes', { recipe_code: r.recipe_code }).eq('id', r.id))
            setGenerateMsgPrd(`✓ Assigned ${done} Product Code${done === 1 ? '' : 's'}. Existing codes were left as they were.`)
          } catch (e) {
            setGenerateMsgPrd(`Error: ${e.message} The codes already assigned stay; run this again for the rest.`)
          }
        },
      })
    } catch (e) {
      setGenerateMsgPrd(`Error: ${e.message}`)
    }
    setGeneratingPrd(false)
  }

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  // The tab whose panel renders — none, for a row tab whose row could not be read (see ROW_TABS).
  const shownTab = settingsLoadError && ROW_TABS.has(activeTab) ? null : activeTab
  // The platform row (Plan Pricing, the Support tab's upper card) is not editable until it has been
  // read successfully — `=== false` so a caller that does not report it (the test mocks) is ready.
  const platformReady = !platformLoadError && platformLoaded !== false
  // A plain function, not a component, for the same reason priceField is one (see below).
  const platformNotReady = what => platformLoadError
    ? (
      <div>
        <ActionError error={asActionError(platformLoadError)} />
        <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '8px 0 0' }}>
          Crest's saved {what} could not be read, so it cannot be edited right now — the boxes would show the
          built-in defaults, and saving would publish those to every client in place of what is saved. Reload the
          page to try again.
        </p>
      </div>
    )
    : <p style={{ fontSize: 13, color: 'var(--theme-text3)', margin: 0 }}>Loading the saved {what}…</p>

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">
            {/* Three of these are NOT per-client, and saying they were is how a price ended up
                written onto a client's row (S701). Plan Pricing is the platform's one price list,
                Theme is this browser, Guides is reference prose — the subtitle now says which. */}
            {isAdmin
              ? <>Branding, property and the consultant for <strong>{rowLabel}</strong> · plan pricing for the whole platform · theme for this browser</>
              : `Operational thresholds, code formats, recipe categories${TABS.includes('Weather') ? ', weather' : ''} and your theme`}
          </p>
        </div>
        {/* Only on the tabs whose fields it saves (PAGE_SAVE_TABS). Support and Plan Pricing commit
            their own rows: measured, the nearest Save to the consultant fields was the OTHER
            card's, 243px away, while the button that saved them sat 1,345px up (S684); Plan
            Pricing writes the platform row, which this button must never (S701). S730 took it off
            Recipe Categories, Product Codes and Theme too — see PAGE_SAVE_TABS. And not on
            Property with no client selected: nothing on that tab is read off the platform row, so
            the button could only ever report success over a write that moved nothing. */}
        {PAGE_SAVE_TABS.has(activeTab) && !((activeTab === 'Property' || activeTab === 'Weather') && !editingClient) && !settingsLoadError && (
          // THIS tab's columns only (S747, decided with Aashish). It wrote the union over every
          // visible tab, so Save on Branding also committed a consultant number half-typed on the
          // Support tab — which has its own Save precisely so that could not happen — and the
          // renumbering dialog's "Nothing else on this tab is affected" was true of the tab and
          // not of the write. An unsaved edit on another tab now waits for that tab's Save.
          <button className="btn btn-primary" onClick={() => save({ fields: TAB_FIELDS[activeTab] || [] })} aria-busy={saving && saveScope === 'page' ? 'true' : undefined}>
            {saving && saveScope === 'page' ? 'Saving…' : saved && saveScope === 'page' ? '✓ Saved' : 'Save Changes'}
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
      {saveScope === 'page' && <ActionError error={error} className="action-error--top" />}
      {settingsLoadError && ROW_TABS.has(activeTab) && (
        <div className="card">
          <ActionError error={asActionError(settingsLoadError)} />
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '8px 0 0' }}>
            {isAdmin ? <><strong>{rowLabel}</strong>'s</> : 'Your'} settings could not be read, so nothing on this tab can be
            edited — what would show here is the app's defaults, not the saved values, and saving over them would
            replace the real ones. Reload the page to try again.
          </p>
        </div>
      )}

      {/* BRANDING */}
      {shownTab === 'Branding' && (
        <div className="card">
          <h3 style={{ margin: '0 0 20px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {editingClient ? 'Property Branding' : 'App Branding'}
          </h3>
          {isAdmin && (
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px' }}>
              {editingClient
                ? <>Editing <strong>{rowLabel}</strong>'s own branding — their sidebar, top bar and printed recipe cost cards. Not Crest's.</>
                : <>No client is selected, so this is <strong>Crest's own</strong> branding: the name and mark on the login, signup, password-reset and pricing pages. Pick a client in the top bar to edit theirs.</>}
            </p>
          )}
          <div className="form-grid form-grid-2">
            <div className="form-field">
              <label htmlFor="set-app-name">
                <Tip width={280} text={editingClient
                  ? "The client's own brand name. It replaces Crest's in their sidebar and top bar and heads their printed recipe cost cards. It is NOT what prints on report letterheads — those use the client's name from Admin → Clients."
                  : "Crest's own product name, on the platform row. It is what a signed-out visitor sees on the login, signup, password-reset and pricing pages. The legal pages deliberately do not use it — they always name the company that signs the agreement."}>
                  {editingClient ? 'Property Name' : 'App Name'}
                </Tip>
              </label>
              <input
                id="set-app-name"
                value={form.app_name || ''}
                onChange={e => update('app_name', e.target.value)}
                placeholder={editingClient ? 'e.g. Casa Acai Cafe' : 'Crest Suite'}
              />
            </div>
            <div className="form-field">
              <label htmlFor="set-app-tagline">Tagline</label>
              <input
                id="set-app-tagline"
                value={form.app_tagline || ''}
                onChange={e => update('app_tagline', e.target.value)}
                placeholder={editingClient ? 'e.g. Fresh bowls, made daily.' : 'Hospitality cost control, built for Nepal.'}
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
                <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 8px' }}>Square PNG / JPG / SVG / WebP · max 2 MB</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  {/* A real button in front of a visually-hidden input (S747) — ClientDrawer's shape. The
                      input was display:none inside a label wrapping a pointer-events:none span, so
                      nothing here could be reached by keyboard at all. `value = ''` lets the same
                      file be picked again after a failed upload. */}
                  <input
                    ref={logoInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml,image/webp"
                    className="visually-hidden"
                    tabIndex={-1}
                    aria-hidden="true"
                    disabled={logoUploading}
                    onChange={e => { if (e.target.files[0]) handleLogoUpload(e.target.files[0]); e.target.value = '' }}
                  />
                  <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} disabled={logoUploading}
                    onClick={() => logoInputRef.current?.click()}>
                    {logoUploading ? 'Uploading…' : '↑ Upload Logo'}
                  </button>
                  {form.logo_url && (
                    <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 25%, transparent)' }} onClick={handleLogoRemove}>
                      Remove
                    </button>
                  )}
                </div>
                {/* role, like the Support and Plan Pricing messages beside it — a failed logo save
                    was announced to nobody. */}
                {logoMsg && <p role={logoMsg.startsWith('ok') ? 'status' : 'alert'} style={{ fontSize: 11, margin: '6px 0 0', color: logoMsg.startsWith('error') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>{logoMsg.replace(/^(ok|error):/, '')}</p>}
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

      {/* PROPERTY — every column here is read through `.eq('client_id', cid)` (useBizInfo,
          CreditNotes, posOrderPrintHtml, computeMonthlyReport…), so with NO client selected this
          tab writes the platform row, where not one of them is ever read again. That was S701's
          shape a fourth time: a save that reports success and moves nothing. The Support tab's
          lower card already handled the same case by saying so instead of offering the fields. */}
      {shownTab === 'Property' && (
        <div className="card">
          <h3 style={{ margin: '0 0 20px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Property Details</h3>
          {!editingClient ? (
            <p style={{ fontSize: 13, color: 'var(--theme-text3)', margin: 0 }}>
              These are per-client — every page that reads them asks for one client's row. Choose a client
              from the top bar's client switcher to edit theirs; there is nothing to set on Crest's own row.
            </p>
          ) : (
            <>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px' }}>
            {isAdmin ? <><strong>{rowLabel}</strong>'s details, as printed on their</> : <>These appear on your</>} POS bills and credit
            notes, gate passes, parking slips, payslips and rosters, and on every report letterhead.
          </p>
          <div className="form-grid form-grid-2">
            {[
              { key: 'property_address', label: 'Address', placeholder: 'e.g. Jhamsikhel, Lalitpur', tip: 'Printed on every POS bill, credit note, gate pass, parking slip and report letterhead. A bill reprinted later carries whatever is here at the time it is reprinted, not the address it was billed under.' },
              { key: 'property_phone', label: 'Phone', placeholder: '01-XXXXXXX', tip: 'The number printed on bills, credit notes and parking slips for a guest to call. Not the support line — that is Settings → Support.' },
              { key: 'property_email', label: 'Email', placeholder: 'info@property.com', tip: 'Printed on report letterheads and payroll documents. Not the support line, and not the login email of any account.' },
              { key: 'vat_number', label: 'VAT Registration Number', placeholder: 'e.g. 123456789', tip: 'Your business VAT registration number as issued by IRD Nepal. Printed on report headers and used for VAT invoice compliance.' },
              { key: 'invoice_prefix', label: 'Invoice Prefix', placeholder: 'Your Business Code', tip: 'Short client code in POS invoice numbers, e.g. TI2238-CAC-82/83. Left blank, bills print without one (TI2238-82/83). Setting or changing it RE-NUMBERS every bill already issued: the number is assembled when a bill is printed, so a reprint of an old invoice carries the new code. Nothing is filled in for you, and a save asks before committing a change.', upper: true },
            ].map(f => (
              <div key={f.key} className="form-field">
                <label htmlFor={`set-${f.key}`}>{f.tip ? <Tip text={f.tip} width={280}>{f.label}</Tip> : f.label}</label>
                <input id={`set-${f.key}`} value={form[f.key] || ''} onChange={e => update(f.key, f.upper ? e.target.value.toUpperCase() : e.target.value)} placeholder={f.placeholder} />
              </div>
            ))}
            <div className="form-field">
              <label htmlFor="set-is-vat-registered"><Tip text="On = POS bills print as a Tax Invoice with a VAT breakdown (numbers prefixed TI-). Off = plain Bill, no VAT line, PAN number only (prefixed PB-). The bill type is decided when a bill is PRINTED, so switching this also changes how every past bill reprints — a save asks before committing it. Match whether this client is actually VAT-registered with IRD." width={280}>VAT Registered</Tip></label>
              <label className="form-check">
                <input id="set-is-vat-registered" type="checkbox" checked={form.is_vat_registered ?? true}
                  onChange={e => update('is_vat_registered', e.target.checked)} />
                <span>{(form.is_vat_registered ?? true) ? 'Yes — issues Tax Invoices' : 'No — PAN Bill only'}</span>
              </label>
            </div>
          </div>
            </>
          )}
        </div>
      )}

      {/* WEATHER (S784) — per-client, like Property: with no client selected there is no row whose
          weather anything reads, so the tab says so instead of offering the fields. */}
      {shownTab === 'Weather' && (
        <div className="card">
          <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Weather</h3>
          {!editingClient ? (
            <p style={{ fontSize: 13, color: 'var(--theme-text3)', margin: 0 }}>
              The weather is set per outlet. Choose a client from the top bar's client switcher to set theirs.
            </p>
          ) : (
            <>
              <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 24px' }}>
                The Dashboard's <strong>Daily Purchases vs Sales</strong> chart can lower (or raise) its sales forecast on the
                days rain is expected, for the next {WEATHER_HORIZON_DAYS} days. Purchases and the dotted targets never change
                with the weather.
              </p>
              <div className="form-grid form-grid-2">
                <div className="form-field">
                  <label htmlFor="set-weather-city"><Tip text="The weather forecast is read for this city, not your street, which is as close as a forecast gets anyway. Pick the nearest one. Leave it on 'Not set' and the forecast ignores the weather." width={280}>City</Tip></label>
                  <select id="set-weather-city" className="form-select" value={form.weather_city || ''} onChange={e => pickCity(e.target.value)}>
                    <option value="">Not set: no weather</option>
                    {NEPAL_CITIES.map(c => <option key={c.key} value={c.key}>{c.name}</option>)}
                  </select>
                  <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>Weather data from MET Norway.</span>
                </div>
                <div className="form-field">
                  <label htmlFor="set-rain_sales_pct"><Tip text={`What a rainy day does to your trade, as a share of a normal day. 85 means a rainy day sells about 85% of what that weekday usually sells, so a Friday that usually takes NPR 40,000 is forecast at NPR 34,000 when rain is expected. Above 100 if rain brings you more trade (a delivery kitchen, a cosy café). A day counts as rainy at ${RAIN_MM} mm or more between 5:45 am and 11:45 pm. Blank = the weather does not change the forecast. The Dashboard also shows what your own sales say once it has recorded enough rainy days.`} width={300}>On a rainy day, sales are about</Tip></label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input id="set-rain_sales_pct" type="number" min={RAIN_PCT_MIN} max={RAIN_PCT_MAX} step="1"
                      value={form.rain_sales_pct ?? ''} onChange={e => update('rain_sales_pct', e.target.value)}
                      placeholder="e.g. 85" style={{ width: 100 }} {...fieldAria('set-rain_sales_pct', fieldErr.rain_sales_pct)} />
                    <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>% of a normal day</span>
                  </div>
                  <FieldError id="set-rain_sales_pct" message={fieldErr.rain_sales_pct} />
                  <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>From {RAIN_PCT_MIN} to {RAIN_PCT_MAX}. Leave blank for no adjustment.</span>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* THRESHOLDS */}
      {shownTab === 'Thresholds' && (
        <div className="card">
          <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Operational Thresholds</h3>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 24px' }}>These decide when a figure is coloured amber or red across every report and dashboard. Leave a box blank to use the default shown in it.</p>
          <div className="form-grid form-grid-2">
            {[
              { key: 'fc_warning_pct', label: 'Food Cost % — Warning level', placeholder: String(fcThresholds({}).warn), suffix: '%', hint: 'Every food-cost figure turns amber △ above this', tip: 'A food cost % above this turns amber — on the Dashboard card, Monthly Summary, Recipe Costing, Menu Pricing, Menu Repricing, Recipe Margin, Annual Summary and Period Comparison alike. Nepal F&B benchmark: warn at 35–38%.' },
              { key: 'fc_critical_pct', label: 'Food Cost % — Critical level', placeholder: String(fcThresholds({}).critical), suffix: '%', hint: 'Turns red ▲ above this — must be above the warning level', tip: 'A food cost % above this turns red, everywhere the warning level applies. It has to sit above the warning level, or nothing can ever be amber.' },
              { key: 'expiry_warning_days', label: 'Expiry Warning — Days ahead', placeholder: '7', suffix: 'days', hint: 'FIFO / Expiry report flags batches expiring inside this window', tip: 'Batches expiring within this many days are highlighted in the FIFO / Expiry report. E.g. 7 = flag anything expiring within a week.' },
              { key: 'variance_flag_pct', label: 'Variance Flag level', placeholder: String(varianceFlagPct({})), suffix: '%', hint: 'Both variance reports flag an item past this %', tip: 'An item whose actual usage differs from theoretical by more than this % is flagged, coloured and marked ▲/▼ on the Variance Report and Theoretical Variance. E.g. 10 = flag when actual usage is more than 10% above or below what sales × recipes say.' },
            ].map(f => (
              <div key={f.key} className="form-field">
                <label htmlFor={`set-${f.key}`}><Tip text={f.tip} width={280}>{f.label}</Tip></label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {/* `?? ''`, not `|| ''`: a stored 0 is refused on save, but until then the box must show it */}
                  <input id={`set-${f.key}`} type="number" min="0" step={f.key === 'expiry_warning_days' ? '1' : 'any'}
                    value={form[f.key] ?? ''} onChange={e => update(f.key, e.target.value)}
                    placeholder={f.placeholder} style={{ width: 100 }} {...fieldAria(`set-${f.key}`, fieldErr[f.key])} />
                  <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{f.suffix}</span>
                </div>
                <FieldError id={`set-${f.key}`} message={fieldErr[f.key]} />
                <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>{f.hint}</span>
              </div>
            ))}
            {[
              { key: 'block_negative_stock', label: 'Block negative stock on save', def: false,
                tip: 'When on, Stock Count refuses Save All while any item\'s usage comes out negative (more used than was ever bought or on hand) — those items must be fixed first. Crest admin can still override with a confirmation. Off by default.',
                onText: 'Yes — blocks Save All until fixed', offText: 'No — saves anyway, the item is only highlighted red' },
              { key: 'warn_below_cost_pricing', label: 'Warn when menu price is below cost', def: true,
                tip: 'When on, Recipe Costing shows a warning if a menu item\'s selling price is set below its computed ingredient cost. Doesn\'t block saving — just a heads-up in case it wasn\'t intentional.',
                onText: 'Yes — shows a warning', offText: 'No — no warning' },
            ].map(f => (
              <div key={f.key} className="form-field">
                <span className="field-label" id={`set-${f.key}-label`}><Tip text={f.tip} width={280}>{f.label}</Tip></span>
                {/* .form-check, not an inline 16px box — the inline workaround S684 said not to re-add */}
                <label className="form-check">
                  <input id={`set-${f.key}`} type="checkbox" aria-describedby={`set-${f.key}-label`} checked={form[f.key] ?? f.def}
                    onChange={e => update(f.key, e.target.checked)} />
                  <span>{(form[f.key] ?? f.def) ? f.onText : f.offText}</span>
                </label>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ITEM CODES */}
      {shownTab === 'Item Codes' && (
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
              If items have been deleted, codes may have gaps. This renumbers every item sequentially
              from {(form.item_code_prefix || 'ITM').toUpperCase()}-001, alphabetically by name, and saves the prefix above
              with it. Sub-recipes are left alone — they carry their own {(form.sub_recipe_code_prefix || 'SRC').toUpperCase()} series.
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
      {shownTab === 'Vendor Codes' && (
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
              If vendors have been deleted, codes may have gaps. This renumbers every vendor sequentially
              from {(form.vendor_code_prefix || 'VND').toUpperCase()}-001, alphabetically by name, and saves the prefix above with it.
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
      {shownTab === 'Sub-Recipe Codes' && (
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
              Renumbers every sub-recipe sequentially from {(form.sub_recipe_code_prefix || 'SRC').toUpperCase()}-001, alphabetically by name, and saves the prefix above with it. Use this to assign codes to existing sub-recipes or close gaps after deletions. Each sub-recipe's stock-count item takes the same code.
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
              {TABS.includes('Sub-Recipe Codes') ? ' on the tab before this one' : ', set with Recipe Costing on the Growth plan'}.
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
      {shownTab === 'Recipe Categories' && (
        <div className="card">
          <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Recipe Categories</h3>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px' }}>
            These appear in the recipe form dropdown and as filter tabs in Recipe Costing. <strong>Sub-Recipe / Prep Item</strong> is managed by the app and is always there.
            A category's first three letters also make its Product Codes (Beverage → BEV-001).
            The order here is the order of sections on your guest QR menu.
          </p>

          <ActionError error={catUsageErr && { text: 'Could not check which categories your recipes use, so a category in use can be removed here without warning.', detail: catUsageErr.detail }} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 20 }}>
            {cats.map((cat, i) => {
              const n = catUsage?.[cat]
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', background: 'var(--theme-bg)' }}>
                  <span style={{ flex: 1, fontSize: 13, color: 'var(--theme-text1)' }}>{cat}</span>
                  {catUsage && (
                    <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>
                      {n ? `${n} recipe${n === 1 ? '' : 's'}` : 'unused'}
                    </span>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    onClick={() => moveCat(i, -1)}
                    disabled={i === 0}
                    aria-label={`Move "${cat}" up`}
                    title={`Move "${cat}" up`}
                  ><ArrowUp aria-hidden="true" /></button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    onClick={() => moveCat(i, 1)}
                    disabled={i === cats.length - 1}
                    aria-label={`Move "${cat}" down`}
                    title={`Move "${cat}" down`}
                  ><ArrowDown aria-hidden="true" /></button>
                  {/* A named control, not a bare glyph dimmed to 0.7 on red text (S682): title is
                      the last-resort naming mechanism and announces nothing on touch. */}
                  <button
                    type="button"
                    className="btn btn-danger btn-icon"
                    onClick={() => removeCat(i)}
                    aria-label={`Remove the "${cat}" category`}
                    title={`Remove the "${cat}" category`}
                  >×</button>
                </div>
              )
            })}
            {cats.length === 0 && (
              <p style={{ fontSize: 13, color: 'var(--theme-text3)', fontStyle: 'italic' }}>No categories — add at least one below.</p>
            )}
          </div>

          {orphanCats.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 6px' }}>
                Still on recipes but not in this list — they keep their own tab in Recipe Costing, and nothing new can be filed under them:
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {orphanCats.map(c => (
                  <button key={c} type="button" className="btn btn-ghost btn-sm" onClick={() => addCat(c)}>
                    + Add back "{c}" ({catUsage[c]} recipe{catUsage[c] === 1 ? '' : 's'})
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            {/* .form-input: outside a .form-field a bare <input> has nothing to reach for and
                renders as the browser's native white box (S593). */}
            <input aria-label="New category name" className="form-input"
              value={newCat}
              onChange={e => { setNewCat(e.target.value); if (catMsg.startsWith('error')) setCatMsg('') }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCat() } }}
              placeholder="e.g. Cocktails, Combo Meals, Specials"
              style={{ flex: 1 }}
            />
            <button className="btn btn-ghost" onClick={() => addCat()} disabled={!newCat.trim()}>+ Add</button>
          </div>

          <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '0 0 20px' }}>
            Nothing changes until you press Save Categories. Removing a category never retags a recipe.
          </p>

          <button className="btn btn-primary" onClick={saveCategories} aria-busy={catSaving ? 'true' : undefined} disabled={cats.length === 0}>
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
                offline banners in Stock Count and POS, Help → Support, and the "not on your plan" cards. A blank
                slot does not render — except Mobile and Email, which fall back to the built-in line and the
                address on the Terms page (each field below says which). Nothing here is per-client — for
                that, use the section below.
              </p>
              {/* Not editable until the stored contact is really on screen (S747): this card saves the
                  WHOLE block, so fields seeded from a failed read — blank, badged "As saved" — would
                  have published blanks over every slot that was never touched. */}
              {!platformReady ? platformNotReady('support contact') : (<>
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
                  {/* `preview.emergency`, not `emergencyOptions.length`: the promise is published only
                      if the SELECTED channel has a number. With the phone line off, a WhatsApp number
                      filled in and the channel still on Mobile, resolveSupportContact() returns
                      `emergency: null` while some channel does have a number — so the hint claimed a
                      line was live that the preview directly below it was already not showing. */}
                  <span style={hint}>{!platformForm.emergency_enabled
                    ? 'No promise is made while this is off'
                    : preview.emergency
                      ? `Live for every client once saved — they are told ${preview.emergency.label} ${preview.emergency.value} is answered any time`
                      : emergencyOptions.length
                        ? `${EMERGENCY_CHANNELS.find(c => c.key === platformForm.emergency_channel)?.label || 'That line'} has no number, so nothing is published — pick a line that has one`
                        : 'Add a number above first'}</span>
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
              </>)}
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
              {clientId && settingsLoadError ? (
                <p style={{ fontSize: 13, color: 'var(--theme-text3)', margin: 0 }}>
                  This client's settings could not be read, so their consultant cannot be edited — the boxes would
                  show blanks, not what is saved. Reload the page to try again.
                </p>
              ) : clientId ? (
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
                    <label htmlFor="set-contact-website">Consultant website</label>
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
              {clientId && !settingsLoadError && (
                // This card's own Save, scoped to its own three columns — placed beside the fields
                // it commits so the two cards never share a button (S684). It went through the
                // shared save() unscoped until the columns were found to be missing from
                // PAGE_FIELDS altogether, which made the whole card a no-op that reported success.
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary" onClick={() => save({ fields: CONSULTANT_FIELDS, scope: 'consultant' })} aria-busy={saving && saveScope === 'consultant' ? 'true' : undefined}>
                    {saving && saveScope === 'consultant' ? 'Saving…' : saved && saveScope === 'consultant' ? '✓ Saved' : 'Save Consultant'}
                  </button>
                  {/* Its failure is reported HERE, beside the button that was pressed (S747). */}
                  {saveScope === 'consultant' && <ActionError error={error} />}
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* PLAN PRICING — the platform's price list, so it saves to the client_id-NULL settings row
          through savePrices(), never through the page-level save() (S701). */}
      {activeTab === 'Plan Pricing' && (() => {
        // Same reason as the Support card (S747): Save Plan Prices writes the WHOLE table, so a form
        // seeded from a failed read — every box blank, badged "As saved" — turned one edited price
        // into every other price reverting to the shipped figure for every client.
        if (!platformReady) return <div className="card">{platformNotReady('plan prices')}</div>
        // priceForm, not `form`: `form` is whichever client's settings row this session read, and
        // writing prices there put them somewhere nothing reads — the save said "✓ Saved" and the
        // price the world sees never moved.
        const imsPrices = priceForm.ims || {}
        const setPrices = next => { setPriceForm(next); setPriceMsg('') }
        // A cleared box REMOVES the key rather than writing 0 — blank means "use the shipped
        // figure", which resolvePricing() and clientMrr.js both fall back to per field. `'' → 0`
        // published a free plan off one keystroke and made the default unreachable.
        const toPrice = value => value === '' ? undefined : Math.max(0, parseInt(value, 10) || 0)
        function updateIms(tier, value) {
          const ims = { ...imsPrices }
          const n = toPrice(value)
          if (n === undefined) delete ims[tier]; else ims[tier] = n
          setPrices({ ...priceForm, ims })
        }
        function updateFlat(key, value) {
          const next = { ...priceForm }
          const n = toPrice(value)
          if (n === undefined) delete next[key]; else next[key] = n
          setPrices(next)
        }
        // Through the same canonical shape as the seed (S747). This built its own object in the
        // order the keys happened to be in, and clearing then retyping a tier moves that tier to the
        // end of `ims` — so identical prices serialised differently and the badge said "Unsaved"
        // over a form that matched the saved table, including straight after saving it.
        const priceDirty = JSON.stringify(canonicalPrices(priceForm)) !== priceSeedRef.current
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
                {/* Which of the three states this box is in, said plainly: a stored figure, the
                    shipped one standing in, or a deliberate zero. */}
                {value == null
                  ? <span style={{ display: 'block', marginTop: 3 }}>Blank — the shipped NPR {fallback.toLocaleString('en-IN')} is quoted</span>
                  : value === 0
                    ? <span style={{ display: 'block', marginTop: 3, color: 'var(--theme-amber-text)' }}>0 publishes this as free — clear the box to use NPR {fallback.toLocaleString('en-IN')} instead</span>
                    : null}
              </span>
            </div>
          )
        }
        const flatCards = [
          { key: 'hr',    color: MODULE_INK.hr,  title: 'Crest HR' },
          { key: 'pos',   color: MODULE_INK.pos, title: 'Crest POS' },
          // Customization (S758) is a flat add-on on POS, priced per outlet like HR and POS.
          { key: 'customization', color: MODULE_INK.customization, title: 'Crest Customization' },
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
                  {/* Amber = open, waiting on a person (the One Signal Meaning Rule) — the shape the
                      Support tab already has, for a table that is read by people who are not here. */}
                  {!priceMsg && (priceDirty
                    ? <span className="badge-amber">Unsaved — everyone still sees the saved prices</span>
                    : <span className="badge-gray">As saved</span>)}
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
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px' }}>Pick a preset — it sets all colors at once — or let the app follow your device's light/dark setting. You can fine-tune individual colors below.</p>
            {/* The Follow-device option is the provider's SYSTEM_KEY (the default on the Crest Staff
                app). Until S730 nothing in this app could select it, and a device that already had
                it saved rendered this row with NO card marked — the key matched no preset and was
                not 'custom' either. Tokens, not rgba(255,255,255,…) hairlines: those are invisible
                on the light preset (design-system.md). */}
            <div role="group" aria-label="Preset themes" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[
                ...Object.entries(PRESETS).map(([key, preset]) => ({ key, preset, name: preset.name, description: preset.description || '' })),
                { key: SYSTEM_KEY, preset: null, name: 'Follow device', description: 'Light or dark, whichever your phone or computer is set to' },
              ].map(({ key, preset, name, description }) => {
                const active = themeKey === key
                const sw = preset || colors
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => switchPreset(key)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '14px 20px', borderRadius: 0, cursor: 'pointer', fontFamily: 'inherit',
                      border: active ? '2px solid var(--theme-accent)' : '2px solid var(--theme-border)',
                      background: active ? 'color-mix(in srgb, var(--theme-accent) 8%, transparent)' : 'var(--theme-card)',
                      minWidth: 180
                    }}
                  >
                    {/* Mini color swatch */}
                    <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
                      <div style={{ display: 'flex', gap: 3 }}>
                        <div style={{ width: 14, height: 14, borderRadius: 0, background: sw.bg, border: '1px solid var(--theme-border)' }} />
                        <div style={{ width: 14, height: 14, borderRadius: 0, background: sw.card, border: '1px solid var(--theme-border)' }} />
                      </div>
                      <div style={{ display: 'flex', gap: 3 }}>
                        <div style={{ width: 14, height: 14, borderRadius: 0, background: sw.accent }} />
                        <div style={{ width: 14, height: 14, borderRadius: 0, background: sw.sidebar, border: '1px solid var(--theme-border)' }} />
                      </div>
                    </div>
                    <div style={{ textAlign: 'left' }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: active ? 'var(--theme-accent-ink)' : 'var(--theme-text1)' }}>{name}</div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>{description}</div>
                    </div>
                    {active && (
                      <span style={{ marginLeft: 'auto', fontSize: 14, color: 'var(--theme-accent-ink)' }}>✓</span>
                    )}
                  </button>
                )
              })}
              {themeKey === 'custom' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 20px', borderRadius: 0, border: '2px solid var(--theme-accent)', background: 'color-mix(in srgb, var(--theme-accent) 6%, transparent)', minWidth: 180 }}>
                  <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div style={{ display: 'flex', gap: 3 }}>
                      <div style={{ width: 14, height: 14, borderRadius: 0, background: colors.bg, border: '1px solid var(--theme-border)' }} />
                      <div style={{ width: 14, height: 14, borderRadius: 0, background: colors.card, border: '1px solid var(--theme-border)' }} />
                    </div>
                    <div style={{ display: 'flex', gap: 3 }}>
                      <div style={{ width: 14, height: 14, borderRadius: 0, background: colors.accent }} />
                      <div style={{ width: 14, height: 14, borderRadius: 0, background: colors.sidebar, border: '1px solid var(--theme-border)' }} />
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-accent-ink)' }}>Custom ✓</div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>Your own palette</div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Color pickers */}
          <div className="card">
            <h3 style={{ margin: '0 0 6px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Customize Colors</h3>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 10px' }}>Click any swatch to pick a color. Changes apply instantly. Start from a preset, then adjust individual colors here.</p>
            {/* Said out loud because it was not, and the gap was visible: the accent used as TEXT is
                a separate token from the accent used as a FILL, and it has no swatch here. */}
            <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 24px' }}>
              Changing the accent also re-derives the three tokens that hang off it — the accent used as text
              and for focus outlines (darkened until it is readable on your card colour), the hover shade and
              the focus tint. The presets' own palettes are hand-checked for contrast and for red-green colour
              blindness; a custom one is not, so use ↺ Reset below if anything becomes hard to read.
            </p>

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
                  className="theme-swatch"
                  style={{ position: 'relative', flexShrink: 0, cursor: 'pointer' }}
                  title={`Pick ${label}`}
                >
                  {/* The label's only content is a swatch, so the hidden input needs its own name —
                      title on the label reaches nobody using a screen reader. */}
                  <input
                    type="color"
                    aria-label={`${label} colour`}
                    value={colors[key] || '#000000'}
                    onChange={e => updateColor(key, e.target.value)}
                    style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
                  />
                  {/* .theme-swatch-chip carries the focus ring (S747): the real input is 0×0, so
                      keyboard focus on it was invisible — :focus-visible has no inline form. */}
                  <div className="theme-swatch-chip" style={{
                    width: 36, height: 36, borderRadius: 0,
                    background: colors[key],
                    border: '2px solid var(--theme-border)',
                    boxShadow: 'var(--theme-card-shadow)',
                    transition: 'transform var(--motion-fast) var(--ease-standard)',
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
                ↺ Reset to {PRESETS.dark?.name || 'Dark'}
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => switchPreset('light')}>
                ↺ Reset to {PRESETS.light?.name || 'Light'}
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
              <div style={{ padding: '6px 14px', borderRadius: 0, background: `color-mix(in srgb, ${colors.green} 9%, transparent)`, color: colors.greenText, fontSize: 11, fontWeight: 700 }}>
                Active Badge
              </div>
              <div style={{ padding: '6px 14px', borderRadius: 0, background: `color-mix(in srgb, ${colors.red} 9%, transparent)`, color: colors.redText, fontSize: 11, fontWeight: 700 }}>
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
            The theme is remembered on this device only, in this browser — nothing here is saved to your account, and everyone else who logs in picks their own.
          </p>
        </div>
      )}

      {/* DATA — admin-only (CLIENT_HIDDEN), which is what made the original copy wrong rather than
          merely thin: it addressed the client ("contact your Crest consultant" for a data dump),
          wrapped its one card in an `{isAdmin && …}` that can never be false, and offered a
          btn-danger whose entire action was an alert() naming another screen. Every tool it talks
          about is real and one click away, so it links to them. */}
      {activeTab === 'Data' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text1)' }}>Backup &amp; Restore</h3>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 12px' }}>
              A full export of {editingClient ? <strong>{rowLabel}</strong> : 'a client'} — every period, every
              table — lives in <strong>Admin → Clients → Manage → Backup</strong>. It writes a .xlsx to read and
              a .json to restore from; take both, and never the workbook alone, because only the .json can be
              restored. A restore refuses a client that still has data in it.
            </p>
            <Link className="btn btn-ghost" style={{ fontSize: 12 }} to="/admin/clients">Open Admin → Clients</Link>
          </div>

          <div className="card">
            {/* S747: this card described a feature that does not exist — an archive action, period
                dropdowns that hide archived months, and a "Show archived" toggle on every report. The
                only thing there is the Periods page's own list folding old closed months away. */}
            <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text1)' }}>Old periods</h3>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 12px' }}>
              There is no archive action for periods. The Periods page folds closed periods older than 12 months
              out of its own list to keep it short — "Show Archived" there brings them back. Nothing is deleted
              or hidden anywhere else: every report's period picker still lists every month.
            </p>
            <Link className="btn btn-ghost" style={{ fontSize: 12 }} to="/periods">Open Periods</Link>
          </div>

          <div className="card">
            <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text1)' }}>Per-report export</h3>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>
              Every report page has its own Export to Excel — Monthly Summary, Variance, FIFO, Payment Summary
              and the rest. Those are single-period extracts for reading; the Backup above is the one that can
              be restored.
            </p>
          </div>

          <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--theme-red) 20%, transparent)' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-red-text)' }}>Resetting or deleting a client</h3>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>
              Destructive actions are deliberately not on this page — they belong on the screen that names
              which client they are about, where the confirmation can spell out the row counts it is about to
              destroy. They are in <strong>Admin → Clients → Manage → ⚠ Danger</strong>.
            </p>
            {/* S747: this said an archived client "keeps its history". Archive DELETES the client's
                data (handleArchiveClient → deleteClientData); the history survives only in the backup
                it takes first. An operator planning around the old sentence would have lost it. */}
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '8px 0 0' }}>
              Prefer <strong>Archive</strong> to Delete, but know what it does: it takes a backup, then <strong>deletes
              all of the client's data</strong>, keeps every login and staff PIN, and locks the account so it stops
              being billed. Nothing is left to browse in the app — the history lives only in that backup file, and
              restoring it brings everything back. <strong>Delete</strong> also removes the logins and the client
              itself, so its restore cannot bring back password logins.
            </p>
          </div>
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
