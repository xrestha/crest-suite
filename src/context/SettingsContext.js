import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from './AuthContext'
import { DEFAULT_PLAN_PRICES, resolvePricing } from '../data/pricingPlans'
import { errorLine } from '../shared/errorText'
import { platformSupportFromRow } from '../shared/supportContact'

const SettingsContext = createContext({})

const DEFAULT_SETTINGS = {
  app_name: 'Crest Suite',
  app_tagline: 'Hospitality cost control, built for Nepal.',
  fc_warning_pct: 35,
  fc_critical_pct: 45,
  expiry_warning_days: 7,
  variance_flag_pct: 10,
  item_code_prefix: 'ITM',
  vendor_code_prefix: 'VND',
  sub_recipe_code_prefix: 'SRC',
  contact_phone: '',
  contact_email: '',
  contact_website: '',
  // Monthly price (NPR) per module, matching the real advertised pricing model in
  // src/data/pricingPlans.js — IMS is tiered (starter/growth/pro), HR and POS are each a single
  // flat price with no tiers. Admin-editable via Settings > Plan Pricing; this object is just the
  // fallback for a client_id-null settings row that predates that tab or never had it touched.
  // See AdminDashboardOverview.jsx's clientMRR for how this feeds the Admin Dashboard's MRR/ARR.
  plan_prices: DEFAULT_PLAN_PRICES,
  block_negative_stock: false,
  warn_below_cost_pricing: true,
  // Stock Count → Settings (S737). All three default OFF so an existing client counts exactly as
  // it did before a manager opts in — and so a bundle deployed ahead of the migration reads false
  // rather than undefined. ims_count_scope_enforced and require_count_attribution are mirrored
  // server-side (a RESTRICTIVE policy and a BEFORE UPDATE trigger); ims_count_blind is a display
  // rule only, and the UI says so where it is switched on.
  ims_count_scope_enforced: false,
  ims_count_blind: false,
  require_count_attribution: false,
}

export const DEFAULT_RECIPE_CATS = ['Food', 'Beverage', 'Dessert', 'Snack', 'Other']

const DEFAULT_FLAGS = {
  sales_entry: false,
  monthly_summary: false,
  payment_summary: false,
  vendor_report: false,
  supplier_contribution: false,
  consolidated_pnl: false,
  vendor_balance_confirmation: false,
  variance_report: false,
  fifo_report: false,
  reorder_report: false,
  price_tracker: false,
  recipe_costing: false,
  menu_engineering: false,
  nutrition_facts: false,
  menu_pricing: false,
  menu_repricing: false,
  stock_report: false,
  stock_ageing: false,
  demand_forecast: false,
  guest_ordering: false,
  loyalty: false,
  combo_builder: false,
  owner_dashboard: false,
  monthly_owner_report: false,
  stock_movement_log: false,
  fixed_asset_register: false,
  multi_outlet: false,
  stock_count_assignment: false,
}

export function SettingsProvider({ children }) {
  const { clientId, isPremium, isAdmin } = useAuth()
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  // The platform row's admin-edited support contact (S683) — `settings.support_contact` on the
  // client_id-NULL row. null until read, and null if the read fails or the column is absent
  // (migration not yet applied): resolveSupportContact() then falls back to its constants, so a
  // missing column costs the edit screen and nothing else.
  const [platformSupport, setPlatformSupport] = useState(null)
  // The platform row's plan_prices (S701), kept separate from `settings.plan_prices` for the same
  // reason platformSupport is: `settings` is whichever row the CURRENT session reads, and a client
  // session reads its own — where plan_prices is null. Every price a customer is shown has to come
  // from the one row the admin actually edits, so it is read once here and resolved for everyone.
  // null until read, and left alone on a failed read: resolvePricing() then prints the shipped
  // figures rather than blanking four cards on the public pricing page.
  const [platformPlanPrices, setPlatformPlanPrices] = useState(null)
  const [featureFlags, setFeatureFlags] = useState(DEFAULT_FLAGS)
  const [loading, setLoading] = useState(true)

  useEffect(() => { loadSettings(isAdmin && !clientId ? null : clientId) }, [clientId, isAdmin]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (clientId) loadFeatureFlags(clientId) }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadSettings(cid) {
    try {
      let query = supabase.from('settings').select('*')
      query = cid ? query.eq('client_id', cid) : query.is('client_id', null)
      const { data } = await query.maybeSingle()
      setSettings(data ? { ...DEFAULT_SETTINGS, ...data } : DEFAULT_SETTINGS)
      // Signed-out and admin-with-no-client already read the platform row above; a client
      // session read its own row, so the platform contact needs one more small read. Fail-soft:
      // on any error keep whatever was last known rather than blanking six surfaces (the KDS-poll
      // rule — a failed read is not an empty value).
      if (cid) {
        const { data: prow, error: perr } = await supabase.from('settings')
          .select('support_contact, contact_phone, contact_email, contact_website, plan_prices').is('client_id', null).maybeSingle()
        if (!perr) {
          setPlatformSupport(platformSupportFromRow(prow))
          setPlatformPlanPrices(prow?.plan_prices || null)
        }
      } else {
        setPlatformSupport(platformSupportFromRow(data))
        setPlatformPlanPrices(data?.plan_prices || null)
      }
    } catch (e) {
      setSettings(DEFAULT_SETTINGS)
    } finally {
      setLoading(false)
    }
  }

  async function loadFeatureFlags(cid) {
    if (!cid) return
    try {
      const { data } = await supabase
        .from('feature_flags')
        .select('*')
        .eq('client_id', cid)
        .maybeSingle()
      if (data) setFeatureFlags(prev => ({ ...prev, ...data }))
      else setFeatureFlags(DEFAULT_FLAGS)
    } catch (e) {
      setFeatureFlags(DEFAULT_FLAGS)
    }
  }

  // Returns true if a feature is accessible for the current user
  function isFeatureEnabled(featureKey) {
    if (isAdmin) return true
    if (isPremium) return true
    return featureFlags[featureKey] === true
  }

  async function saveSettings(updates) {
    const cid = isAdmin && !clientId ? null : clientId
    // Strip DB metadata that must not appear in INSERT/UPDATE payloads — and plan_prices, which
    // has a dedicated writer (savePlatformPlanPrices). A column with its own writer must not also
    // ride along in the general one: `updates` comes from a form seeded when the page loaded, so
    // saving ANY other tab after a price change would put the stale table back (S701).
    const { id: _id, client_id: _cid, created_at: _ca, updated_at: _ua, plan_prices: _pp, ...payload } = updates

    let query = supabase.from('settings').select('id')
    query = cid ? query.eq('client_id', cid) : query.is('client_id', null)
    const { data: existing, error: exErr } = await query.maybeSingle()
    // A guard that drops its read error passes vacuously (S682): a failed read used to fall into
    // the INSERT branch and write a SECOND settings row for the client, which then splits every
    // settings read after it — the S613 trap, in the context every settings screen goes through.
    if (exErr) throw new Error(errorLine(exErr))

    if (existing?.id) {
      const { error } = await supabase.from('settings')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
      if (error) throw new Error(errorLine(error))
    } else {
      const { error } = await supabase.from('settings')
        .insert({ ...payload, client_id: cid })
      if (error) throw new Error(errorLine(error))
    }
    await loadSettings(cid)
  }

  // Writes the platform support contact to the client_id-NULL row regardless of which client the
  // admin is currently viewing (S683) — saveSettings() would otherwise target the viewed client's
  // row, and this is one fact for every client. Same existing-row guard as the other two savers.
  async function savePlatformSupport(contact) {
    const { data: existing, error: exErr } = await supabase.from('settings').select('id').is('client_id', null).maybeSingle()
    if (exErr) throw new Error(errorLine(exErr))
    if (existing?.id) {
      const { error } = await supabase.from('settings').update({ support_contact: contact, updated_at: new Date().toISOString() }).eq('id', existing.id)
      if (error) throw new Error(errorLine(error))
    } else {
      const { error } = await supabase.from('settings').insert({ client_id: null, support_contact: contact })
      if (error) throw new Error(errorLine(error))
    }
    setPlatformSupport(contact)
  }

  // Plan prices are ONE fact for the whole platform, so they save to the client_id-NULL row
  // whichever client the admin happens to be viewing — exactly like savePlatformSupport above,
  // and for a sharper reason: saveSettings() would have written them onto the viewed client's own
  // settings row, where nothing reads them. The price would appear to save, the toast would say so,
  // and the public pricing page would go on showing the old figure (S701).
  async function savePlatformPlanPrices(prices) {
    const { data: existing, error: exErr } = await supabase.from('settings').select('id').is('client_id', null).maybeSingle()
    if (exErr) throw new Error(errorLine(exErr))
    if (existing?.id) {
      const { error } = await supabase.from('settings').update({ plan_prices: prices, updated_at: new Date().toISOString() }).eq('id', existing.id)
      if (error) throw new Error(errorLine(error))
    } else {
      const { error } = await supabase.from('settings').insert({ client_id: null, plan_prices: prices })
      if (error) throw new Error(errorLine(error))
    }
    setPlatformPlanPrices(prices)
  }

  // Same guard as saveSettings, and both writes now report: this is the admin's "save this
  // client's settings" path, and it used to return successfully whatever the database did (S682).
  async function saveClientSettings(cid, updates) {
    const { data: existing, error: exErr } = await supabase
      .from('settings')
      .select('id')
      .eq('client_id', cid)
      .maybeSingle()
    if (exErr) throw new Error(errorLine(exErr))

    if (existing?.id) {
      const { error } = await supabase.from('settings').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', existing.id)
      if (error) throw new Error(errorLine(error))
    } else {
      const { error } = await supabase.from('settings').insert({ ...updates, client_id: cid })
      if (error) throw new Error(errorLine(error))
    }
  }

  async function saveFeatureFlags(cid, flags) {
    const { data: existing, error: exErr } = await supabase
      .from('feature_flags')
      .select('id')
      .eq('client_id', cid)
      .maybeSingle()
    if (exErr) throw new Error(errorLine(exErr))

    if (existing?.id) {
      const { error } = await supabase.from('feature_flags').update({ ...flags, updated_at: new Date().toISOString() }).eq('id', existing.id)
      if (error) throw new Error(errorLine(error))
    } else {
      const { error } = await supabase.from('feature_flags').insert({ client_id: cid, ...flags })
      if (error) throw new Error(errorLine(error))
    }
    if (cid === clientId) await loadFeatureFlags(cid)
  }

  // Throws on a failed read, the same contract as saveClientSettings. It used to return `data`
  // alone, so a dropped read and a client with no settings row yet were the same `null` — and
  // ClientDrawer, its only caller, rendered that null as SETTINGS_DEFAULTS and let Save write the
  // blanks back over the client's real branding, VAT number, invoice prefix and payment QR (S736).
  async function loadClientSettings(cid) {
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .eq('client_id', cid)
      .maybeSingle()
    if (error) throw new Error(errorLine(error))
    return data
  }

  async function loadClientFeatureFlags(cid) {
    const { data } = await supabase
      .from('feature_flags')
      .select('*')
      .eq('client_id', cid)
      .maybeSingle()
    return data || { ...DEFAULT_FLAGS, client_id: cid }
  }

  const recipeCategories = (settings.recipe_categories?.length > 0)
    ? settings.recipe_categories
    : DEFAULT_RECIPE_CATS

  // `planPrices` is the raw override table (what clientMrr.js takes); `pricing` is it resolved
  // against the shipped constants and ready to print. Everything that shows money to a person
  // reads one of these two — never pricingPlans.js's constants directly.
  const planPrices = platformPlanPrices || DEFAULT_PLAN_PRICES
  const pricing = useMemo(() => resolvePricing(platformPlanPrices), [platformPlanPrices])

  return (
    <SettingsContext.Provider value={{
      settings, featureFlags, loading, platformSupport, planPrices, pricing,
      saveSettings, saveClientSettings, saveFeatureFlags, savePlatformSupport, savePlatformPlanPrices,
      loadSettings, loadClientSettings, loadClientFeatureFlags,
      isFeatureEnabled, recipeCategories
    }}>
      {children}
    </SettingsContext.Provider>
  )
}

export const useSettings = () => useContext(SettingsContext)
