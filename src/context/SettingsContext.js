import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from './AuthContext'

const SettingsContext = createContext({})

const DEFAULT_SETTINGS = {
  app_name: 'Crest Inventory',
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
  contact_website: ''
}

const DEFAULT_FLAGS = {
  sales_entry: false,
  monthly_summary: false,
  payment_summary: false,
  vendor_report: false,
  variance_report: false,
  fifo_report: false,
  reorder_report: false,
  price_tracker: false,
  recipe_costing: false,
  menu_engineering: false,
  nutrition_facts: false,
}

export function SettingsProvider({ children }) {
  const { clientId, isPremium, isAdmin } = useAuth()
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
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
    // Strip DB metadata that must not appear in INSERT/UPDATE payloads
    const { id: _id, client_id: _cid, created_at: _ca, updated_at: _ua, ...payload } = updates

    let query = supabase.from('settings').select('id')
    query = cid ? query.eq('client_id', cid) : query.is('client_id', null)
    const { data: existing } = await query.maybeSingle()

    if (existing?.id) {
      const { error } = await supabase.from('settings')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
      if (error) throw new Error(error.message)
    } else {
      const { error } = await supabase.from('settings')
        .insert({ ...payload, client_id: cid })
      if (error) throw new Error(error.message)
    }
    await loadSettings(cid)
  }

  async function saveClientSettings(cid, updates) {
    const { data: existing } = await supabase
      .from('settings')
      .select('id')
      .eq('client_id', cid)
      .maybeSingle()

    if (existing?.id) {
      await supabase.from('settings').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', existing.id)
    } else {
      await supabase.from('settings').insert({ ...updates, client_id: cid })
    }
  }

  async function saveFeatureFlags(cid, flags) {
    const { data: existing } = await supabase
      .from('feature_flags')
      .select('id')
      .eq('client_id', cid)
      .maybeSingle()

    if (existing?.id) {
      const { error } = await supabase.from('feature_flags').update({ ...flags, updated_at: new Date().toISOString() }).eq('id', existing.id)
      if (error) throw new Error(error.message)
    } else {
      const { error } = await supabase.from('feature_flags').insert({ client_id: cid, ...flags })
      if (error) throw new Error(error.message)
    }
    if (cid === clientId) await loadFeatureFlags(cid)
  }

  async function loadClientSettings(cid) {
    const { data } = await supabase
      .from('settings')
      .select('*')
      .eq('client_id', cid)
      .maybeSingle()
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

  return (
    <SettingsContext.Provider value={{
      settings, featureFlags, loading,
      saveSettings, saveClientSettings, saveFeatureFlags,
      loadSettings, loadClientSettings, loadClientFeatureFlags,
      isFeatureEnabled
    }}>
      {children}
    </SettingsContext.Provider>
  )
}

export const useSettings = () => useContext(SettingsContext)
