import { createContext, useContext, useEffect, useState, useMemo } from 'react'
import { supabase } from '../supabaseClient'

const AuthContext = createContext({})

// Included on all plans (Starter and above)
const STARTER_KEYS = new Set([
  'monthly_summary', 'annual_summary', 'reorder_report', 'vat_report', 'non_vat_report', 'wastage_report', 'settings',
  'sales_entry', 'payment_summary', 'stock_report', 'menu_pricing', 'staff_meals', 'stock_movement_log',
])
// Requires Growth plan or above
const GROWTH_KEYS = new Set([
  'recipe_costing', 'variance_report',
  'budget_vs_actual', 'best_sellers', 'purchase_orders',
  'dead_stock', 'recipe_margin', 'outstanding_payables',
  'requisitions',
  'nutrition_facts', 'menu_repricing', 'combo_builder',
])
// Requires Pro plan
const PRO_KEYS = new Set([
  'menu_engineering', 'fifo_report', 'vendor_report',
  'price_tracker', 'overheads', 'theoretical_variance',
  'period_comparison', 'shrinkage_report', 'demand_forecast',
  'guest_ordering',
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
        .select('id, full_name, role, client_id, pos_role, pos_team, hr_employee_id, hr_self_service, ims_role, ims_job_title, hr_role, hr_job_title')
        .eq('id', userId)
        .single()

      if (!mounted) return
      if (error) { console.error('Profile fetch error:', error); return }

      if (data?.client_id) {
        const { data: client } = await supabase
          .from('clients')
          .select('id, name, location, is_premium, plan, trial_ends_at, subscription_ends_at, ims_ends_at, hr_ends_at, pos_ends_at, ims_enabled, hr_enabled, hr_plan, pos_enabled, pos_plan, suite_plan, is_trial, trial_start_date, trial_expires_at, trial_purge_at, subscribe_requested')
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
  const imsEnabled = isAdmin || (profile?.clients?.ims_enabled ?? true)
  const hrEnabled  = isAdmin || (profile?.clients?.hr_enabled ?? false)
  // Admin gets 'manager'; owner (client with no pos_role/ims_role/hr_role) gets 'manager' on the
  // corresponding module when it's enabled; staff use their explicit pos_role/ims_role/hr_role. An
  // HR self-service account also has role 'client' with none of the four set — without excluding
  // all four staff-account markers here, any one of them would incorrectly count as Owner and
  // inherit manager-level access to a module it has no business in.
  const isOwner = !isAdmin && profile?.role === 'client' && !profile?.pos_role && !profile?.hr_self_service && !profile?.ims_role && !profile?.hr_role
  const posRole = isAdmin || isOwner ? 'manager' : (profile?.pos_role || null)
  const imsRole = isAdmin || isOwner ? 'manager' : (profile?.ims_role || null)
  const hrRole  = isAdmin || isOwner ? 'manager' : (profile?.hr_role || null)
  // Orthogonal to posRole (rank) — 'foh' | 'kitchen' | 'bar', which physical station this POS
  // login works. Admin/owner always resolve to 'foh' (the unrestricted default), same shape as
  // the rank fields above, so neither is ever narrowed by a kitchen/bar nav carve-out.
  const posTeam = isAdmin || isOwner ? 'foh' : (profile?.pos_team || 'foh')

  const POS_RANK = { staff: 1, supervisor: 2, manager: 3 }
  function hasPosAccess(minLevel) {
    if (isAdmin) return true
    if (!posEnabled) return false
    return (POS_RANK[posRole] || 0) >= (POS_RANK[minLevel] || 0)
  }

  const IMS_RANK = { staff: 1, supervisor: 2, manager: 3 }
  function hasImsAccess(minLevel) {
    if (isAdmin) return true
    if (!imsEnabled) return false
    return (IMS_RANK[imsRole] || 0) >= (IMS_RANK[minLevel] || 0)
  }

  // Mirrors POS_RANK/IMS_RANK exactly (S430) — an HR staff account (hr_role, real email+password
  // login, distinct from an hr_self_service employee PIN portal) is gated the same shape as IMS.
  const HR_RANK = { staff: 1, supervisor: 2, manager: 3 }
  function hasHrAccess(minLevel) {
    if (isAdmin) return true
    if (!hrEnabled) return false
    return (HR_RANK[hrRole] || 0) >= (HR_RANK[minLevel] || 0)
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
  async function fetchViewModules(id) {
    const { data } = await supabase.from('clients').select('ims_enabled, hr_enabled, pos_enabled').eq('id', id).single()
    setViewModules(data ? { ims: data.ims_enabled !== false, hr: !!data.hr_enabled, pos: !!data.pos_enabled } : null)
  }
  useEffect(() => {
    if (!isAdmin || !adminViewClientId) { setViewModules(null); return }
    let cancelled = false
    supabase.from('clients').select('ims_enabled, hr_enabled, pos_enabled').eq('id', adminViewClientId).single()
      .then(({ data }) => { if (!cancelled) setViewModules(data ? { ims: data.ims_enabled !== false, hr: !!data.hr_enabled, pos: !!data.pos_enabled } : null) })
    return () => { cancelled = true }
  }, [isAdmin, adminViewClientId])

  // Re-fetch on demand — the module toggles in AdminClients write straight to the DB (instant
  // save) without changing adminViewClientId, so the effect above never re-runs on its own.
  // Called by the drawer after toggling a module for the client currently being viewed as.
  function refreshViewModules() {
    if (isAdmin && adminViewClientId) fetchViewModules(adminViewClientId)
  }

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
      imsEnabled,
      hrEnabled,
      posEnabled,
      posRole,
      posTeam,
      imsRole,
      hrRole,
      isOwner,
      hasPosAccess,
      hasImsAccess,
      hasHrAccess,
      clientModules, // displayed client's actual subscription (nav + dashboard sections)
      hrPlan: isAdmin ? 'pro' : (profile?.clients?.hr_plan || null),
      posPlan: isAdmin ? 'pro' : (profile?.clients?.pos_plan || null),
      // Suite bundle tier (IMS+HR+POS together) — an independent gating axis from the per-module
      // plan/hrPlan/posPlan above. NULL means not subscribed to Suite at all; no default tier.
      suitePlan: isAdmin ? 'pro' : (profile?.clients?.suite_plan || null),
      adminViewClientId, adminViewClientName, switchAdminClient, refreshViewModules,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
