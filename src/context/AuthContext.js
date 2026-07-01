import { createContext, useContext, useEffect, useState, useMemo } from 'react'
import { supabase } from '../supabaseClient'

const AuthContext = createContext({})

// Included on all plans (Starter and above)
const STARTER_KEYS = new Set([
  'monthly_summary', 'annual_summary', 'reorder_report', 'vat_report', 'non_vat_report', 'wastage_report', 'settings',
  'sales_entry', 'payment_summary', 'stock_report', 'menu_pricing',
])
// Requires Growth plan or above
const GROWTH_KEYS = new Set([
  'recipe_costing', 'variance_report',
  'budget_vs_actual', 'best_sellers', 'purchase_orders',
  'dead_stock', 'recipe_margin', 'outstanding_payables',
  'requisitions', 'staff_meals',
  'nutrition_facts', 'menu_repricing',
])
// Requires Pro plan
const PRO_KEYS = new Set([
  'menu_engineering', 'fifo_report', 'vendor_report',
  'price_tracker', 'overheads', 'theoretical_variance',
  'period_comparison', 'shrinkage_report',
])

export function AuthProvider({ children }) {
  const [session, setSession]                   = useState(null)
  const [profile, setProfile]                   = useState(null)
  const [featureFlags, setFeatureFlags]         = useState({})
  const [loading, setLoading]                   = useState(true)
  const [ready, setReady]                       = useState(false)
  const [adminViewClientId, setAdminViewClientId]     = useState(() => localStorage.getItem('crest_admin_client_id') || null)
  const [adminViewClientName, setAdminViewClientName] = useState(() => localStorage.getItem('crest_admin_client_name') || '')

  useEffect(() => {
    let mounted = true

    async function initialize() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!mounted) return
      setSession(session)
      if (session) {
        await fetchProfile(session.user.id, mounted)
      } else {
        setLoading(false)
        setReady(true)
      }
    }

    initialize()

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!mounted) return
      setSession(session)
      if (session) {
        await fetchProfile(session.user.id, mounted)
      } else {
        setProfile(null)
        setFeatureFlags({})
        setLoading(false)
        setReady(true)
      }
    })

    return () => { mounted = false; subscription.unsubscribe() }
  }, [])

  async function fetchProfile(userId, mounted = true) {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, role, client_id, pos_role')
        .eq('id', userId)
        .single()

      if (!mounted) return
      if (error) { console.error('Profile fetch error:', error); return }

      if (data?.client_id) {
        const { data: client } = await supabase
          .from('clients')
          .select('id, name, location, is_premium, plan, trial_ends_at, subscription_ends_at, ims_ends_at, hr_ends_at, pos_ends_at, ims_enabled, hr_enabled, hr_plan, pos_enabled, pos_plan, is_trial, trial_start_date, trial_expires_at, trial_purge_at, subscribe_requested')
          .eq('id', data.client_id)
          .single()
        if (mounted) data.clients = client

        const { data: flags } = await supabase
          .from('feature_flags')
          .select('*')
          .eq('client_id', data.client_id)
          .maybeSingle()
        if (mounted) setFeatureFlags(flags || {})
      }

      if (mounted) {
        setProfile(data)
        // Only seed the admin view from profile on first login (no saved selection)
        if (data.role === 'admin' && !localStorage.getItem('crest_admin_client_id')) {
          setAdminViewClientId(data.client_id || null)
          setAdminViewClientName(data.clients?.name || '')
        }
        // Fire-and-forget presence ping — .then() required to trigger Supabase lazy execution
        supabase.from('profiles').update({ last_seen_at: new Date().toISOString() }).eq('id', userId).then(() => {})
      }
    } catch (err) {
      console.error('Profile error:', err)
    } finally {
      if (mounted) {
        setLoading(false)
        setReady(true)
      }
    }
  }

  async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    return { data, error }
  }

  async function signOut() {
    setProfile(null)
    setFeatureFlags({})
    setAdminViewClientId(null)
    setAdminViewClientName('')
    localStorage.removeItem('crest_admin_client_id')
    localStorage.removeItem('crest_admin_client_name')
    setReady(false)
    await supabase.auth.signOut()
  }

  const isAdmin  = profile?.role === 'admin'
  const clientId = isAdmin ? adminViewClientId : (profile?.client_id || null)

  const posEnabled = isAdmin || (profile?.clients?.pos_enabled ?? false)
  // Admin gets 'manager'; owner (client with no pos_role) gets 'manager' when POS enabled;
  // PIN-based staff use their explicit pos_role
  const isOwner = !isAdmin && profile?.role === 'client' && !profile?.pos_role
  const posRole = isAdmin || isOwner ? 'manager' : (profile?.pos_role || null)

  const POS_RANK = { staff: 1, supervisor: 2, manager: 3 }
  function hasPosAccess(minLevel) {
    if (isAdmin) return true
    if (!posEnabled) return false
    return (POS_RANK[posRole] || 0) >= (POS_RANK[minLevel] || 0)
  }

  function switchAdminClient(id, name) {
    setAdminViewClientId(id)
    setAdminViewClientName(name)
    if (id) {
      localStorage.setItem('crest_admin_client_id', id)
      localStorage.setItem('crest_admin_client_name', name)
    } else {
      localStorage.removeItem('crest_admin_client_id')
      localStorage.removeItem('crest_admin_client_name')
    }
  }

  // When admin "views as" a client, fetch that client's actual module subscription so the
  // sidebar + dashboard show ONLY their modules (admin's isAdmin bypass otherwise shows all).
  const [viewModules, setViewModules] = useState(null)
  useEffect(() => {
    if (!isAdmin || !adminViewClientId) { setViewModules(null); return }
    let cancelled = false
    supabase.from('clients').select('ims_enabled, hr_enabled, pos_enabled').eq('id', adminViewClientId).single()
      .then(({ data }) => { if (!cancelled) setViewModules(data ? { ims: data.ims_enabled !== false, hr: !!data.hr_enabled, pos: !!data.pos_enabled } : null) })
    return () => { cancelled = true }
  }, [isAdmin, adminViewClientId])

  // The DISPLAYED client's real module subscription (for nav visibility + dashboard sections).
  // Separate from imsEnabled/hrEnabled, which keep the admin route-access bypass.
  const cIms = profile?.clients?.ims_enabled, cHr = profile?.clients?.hr_enabled, cPos = profile?.clients?.pos_enabled
  const clientModules = useMemo(() => {
    if (isAdmin && adminViewClientId) return viewModules || { ims: true, hr: false, pos: false }
    if (isAdmin) return { ims: true, hr: true, pos: false } // admin's own view: full nav for management
    return { ims: cIms ?? true, hr: cHr ?? false, pos: cPos ?? false }
  }, [isAdmin, adminViewClientId, viewModules, cIms, cHr, cPos])

  // Derive plan: admin always gets 'pro'; take highest across all active module plans
  const PLAN_RANK = { starter: 0, growth: 1, pro: 2 }
  const plan = isAdmin
    ? 'pro'
    : (() => {
        const c = profile?.clients
        const candidates = [
          c?.plan,
          c?.ims_enabled  ? c?.ims_plan  : null,
          c?.hr_enabled   ? c?.hr_plan   : null,
          c?.pos_enabled  ? c?.pos_plan  : null,
          c?.is_premium   ? 'pro'        : null,
        ].filter(Boolean)
        if (!candidates.length) return 'starter'
        return candidates.reduce((best, p) =>
          (PLAN_RANK[p] ?? 0) > (PLAN_RANK[best] ?? 0) ? p : best
        )
      })()

  // isPremium = true for Growth and Pro (any paid plan) — keeps existing checks working
  const isPremium = isAdmin || plan === 'growth' || plan === 'pro'

  const trialEndsAt = profile?.clients?.trial_ends_at || null
  const isTrialing  = plan === 'starter' && !!trialEndsAt && new Date(trialEndsAt) > new Date()

  // Self-service 7-day free trial fields
  const _now              = new Date()
  const isTrial           = !isAdmin && !!(profile?.clients?.is_trial)
  const _trialExpiresAt   = profile?.clients?.trial_expires_at ? new Date(profile.clients.trial_expires_at) : null
  const _trialPurgeAt     = profile?.clients?.trial_purge_at   ? new Date(profile.clients.trial_purge_at)   : null
  const trialExpired      = isTrial && !!_trialExpiresAt && _trialExpiresAt < _now
  const trialDaysLeft     = isTrial && !!_trialExpiresAt && !trialExpired
                              ? Math.ceil((_trialExpiresAt - _now) / 86400000)
                              : 0
  const trialPurgeInDays  = isTrial && trialExpired && !!_trialPurgeAt
                              ? Math.ceil((_trialPurgeAt - _now) / 86400000)
                              : null
  const subscribeRequested = !!(profile?.clients?.subscribe_requested)

  async function requestSubscription() {
    await supabase.rpc('request_subscription')
    if (session?.user?.id) fetchProfile(session.user.id)
  }

  function hasFeature(featureKey) {
    if (isAdmin) return true
    const flagVal = featureFlags[featureKey]
    if (flagVal === true) return true  // explicit admin grant for features above plan tier
    // null / undefined / false → fall back to plan
    if (STARTER_KEYS.has(featureKey)) return true
    if (GROWTH_KEYS.has(featureKey) && (plan === 'growth' || plan === 'pro')) return true
    if (PRO_KEYS.has(featureKey)    && plan === 'pro') return true
    return false
  }

  return (
    <AuthContext.Provider value={{
      session, profile, loading, ready,
      signIn, signOut,
      clientId, isAdmin, isPremium,
      plan, isTrialing, trialEndsAt,
      isTrial, trialExpired, trialDaysLeft, trialPurgeInDays, subscribeRequested, requestSubscription,
      featureFlags, hasFeature,
      imsEnabled: isAdmin || (profile?.clients?.ims_enabled ?? true),
      hrEnabled: isAdmin || (profile?.clients?.hr_enabled ?? false),
      posEnabled,
      posRole,
      isOwner,
      hasPosAccess,
      clientModules, // displayed client's actual subscription (nav + dashboard sections)
      hrPlan: isAdmin ? 'pro' : (profile?.clients?.hr_plan || null),
      posPlan: isAdmin ? 'pro' : (profile?.clients?.pos_plan || null),
      adminViewClientId, adminViewClientName, switchAdminClient,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
