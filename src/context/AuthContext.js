import { createContext, useContext, useEffect, useState, useMemo } from 'react'
import { supabase } from '../supabaseClient'
import { startSessionKeepAlive } from '../utils/sessionKeepAlive'
import { getAccessState } from '../utils/subscription'
import { docsRequiringReacceptance, reacceptDocTypes } from '../legal'

const AuthContext = createContext({})

// The three IMS tiers sell three different jobs, and every key below is placed by that rule
// rather than by when it happened to be built:
//   Starter — Record & Comply: keep the books, satisfy the IRD.
//   Growth  — Control: know your costs and where they leak.
//   Pro     — Strategy: decide what to change next period.
//
// Two placement rules fall out of it, both of which had already been broken:
//   1. A statutory obligation never gates above Starter. vat_report/non_vat_report were always
//      here; vendor_balance_confirmation (IRD Annexure 13) sat at Pro and has joined them.
//   2. A feature must be able to produce a number on its own tier's data. reorder_report and
//      stock_movement_log both derive their core figure from recipe explosion
//      (ReorderReport.js's explodeRecipeIngredients, StockMovements.js's subRecipeUsage), and
//      recipe_costing is Growth — so both were sold to Starter clients who structurally could
//      not get an answer out of them. Moved to Growth; outstanding_payables and
//      vendor_balance_confirmation moved down in exchange, so Starter's count is unchanged.
// Included on all plans (Starter and above)
const STARTER_KEYS = new Set([
  'monthly_summary', 'annual_summary', 'vat_report', 'non_vat_report', 'wastage_report', 'settings',
  'sales_entry', 'payment_summary', 'menu_pricing', 'staff_meals',
  'outstanding_payables', 'vendor_balance_confirmation',
])
// Requires Growth plan or above
const GROWTH_KEYS = new Set([
  'recipe_costing', 'variance_report',
  'budget_vs_actual', 'best_sellers', 'purchase_orders',
  'dead_stock', 'recipe_margin',
  'requisitions',
  'nutrition_facts', 'menu_repricing', 'combo_builder',
  'reorder_report', 'stock_movement_log',
  // stock_report is the third instance of the same defect (S551): its On-hand figure subtracts a
  // recipe-explosion usage term, so on Starter — where recipes don't exist — stock only ever
  // grows, and the Low/Out status column can never fire. Moved to Growth with a grandfather
  // sweep (supabase/migrations/20260813120000).
  'stock_report',
  // overheads is the data-entry page behind Fixed Costs %/Est. Net Margin on ClientDashboard and
  // Recipes' True Cost allocation. A data-entry page must not sit above the tier of any figure
  // that consumes it, or the consumer renders blank with no explanation.
  'overheads',
])
// Requires Pro plan
const PRO_KEYS = new Set([
  'menu_engineering', 'fifo_report', 'vendor_report',
  'price_tracker', 'theoretical_variance',
  'period_comparison', 'shrinkage_report',
  // Strategy altitude (working capital sitting on the shelf), and it could not sit lower anyway:
  // knowing what is still on hand means netting consumption off the batches, and that consumption
  // comes from recipe explosion — same constraint that put reorder_report/stock_movement_log here.
  'stock_ageing',
  // Strategy altitude (supplier concentration risk), and it could not sit lower anyway: its
  // figure comes from recipe explosion, and recipe_costing is Growth — the same defect S551
  // corrected on reorder_report/stock_movement_log.
  'supplier_contribution',
])
// Crest Suite Pro (clients.suite_plan) — NOT an IMS tier. These must never be added to the three
// sets above: SuiteGate passes on `tierOk || overridden` where overridden is hasFeature(key), so a
// tier-set entry would make hasFeature() true for every IMS Pro client and give the SKU away.
// Their feature_flags columns exist only as the per-client exception that `||` implies.
// demand_forecast is here because it is genuinely cross-module — Roster.jsx reads
// demand_forecast_daily to overlay forecast covers on the HR roster.
export const SUITE_KEYS = new Set([
  'owner_dashboard', 'monthly_owner_report', 'multi_outlet',
  'demand_forecast', 'fixed_asset_register', 'consolidated_pnl',
])
// POS module features. POS is deliberately flat (no tiers), so these unlock with the module
// itself rather than with any plan rank. guest_ordering used to live in PRO_KEYS, which gated a
// POS feature on the IMS plan — a POS client on IMS Starter could not buy it at any price, even
// though FeatureAccessModal already declared it planSource: 'pos'.
const POS_MODULE_KEYS = new Set(['guest_ordering', 'loyalty'])

// Returns the SAME array reference when the outlet list hasn't actually changed.
//
// This is load-bearing, not a micro-optimisation. `outlets` goes into the context value, so a
// fresh [] on every fetchProfile() call is a new identity for every consumer — which cascaded
// into "Maximum update depth exceeded" the moment a real client (not admin) logged in. React
// bails out of a re-render only when Object.is(prev, next) holds, and [] === [] is false, so
// "set it to empty again" is a state *change* unless you hand back the previous array.
//
// The ungrouped case is the common one — every single-outlet client hits it on every load — so
// it must be the cheap path. Grouped clients compare by id since the rows are re-fetched fresh.
function nextOutletsOrSame(prev, client, siblings) {
  const next = client?.group_id
    ? (siblings || []).filter(o => o.group_id === client.group_id)
    : []
  if (prev.length !== next.length) return next
  return prev.every((o, i) => o.id === next[i].id) ? prev : next
}

// Same stable-identity contract as nextOutletsOrSame, for the same reason — this array also
// reaches the context value, so handing back a fresh [] on every fetchProfile() is a state
// CHANGE and re-renders every consumer. Ids arrive PK-ordered, so a plain positional compare is
// enough; nothing here needs to sort.
function nextIdsOrSame(prev, ids) {
  const next = ids || []
  if (prev.length !== next.length) return next
  return prev.every((id, i) => id === next[i]) ? prev : next
}

export function AuthProvider({ children }) {
  const [session, setSession]                   = useState(null)
  const [profile, setProfile]                   = useState(null)
  const [featureFlags, setFeatureFlags]         = useState({})
  // Acceptance rows for the documents that currently demand re-acceptance. [] = none outstanding,
  // null = the read FAILED and we must not conclude anything from it. Those two have to stay
  // distinguishable: treating a failed read as "nothing accepted" would gate every owner in the
  // product behind a modal the moment the table became unreachable.
  const [legalAccepted, setLegalAccepted]       = useState([])
  const [loading, setLoading]                   = useState(true)
  const [ready, setReady]                       = useState(false)
  const [adminViewClientId, setAdminViewClientId]     = useState(() => localStorage.getItem('crest_admin_client_id') || null)
  const [adminViewClientName, setAdminViewClientName] = useState(() => localStorage.getItem('crest_admin_client_name') || '')
  // Multi-outlet: every client in this user's group, or [] when they aren't in one. Unlike the
  // admin switcher above this is NOT held in localStorage — the selection lives server-side in
  // profiles.active_client_id, because it decides which tenant's rows every RLS policy resolves
  // to. A browser-held value could not be trusted for that.
  const [outlets, setOutlets] = useState([])
  // The sibling outlets THIS account has been explicitly allowlisted into (S617). Empty for an
  // Owner, who reaches the whole group by virtue of being the Owner, and empty for everyone in a
  // single-outlet client. Read from profile_outlet_access, whose SELECT policy allows your own
  // rows — so this is what the account itself is permitted to know, not a copy of the matrix.
  const [allowedOutletIds, setAllowedOutletIds] = useState([])

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

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!mounted) return
      setSession(session)
      if (!session) {
        setProfile(null)
        setFeatureFlags({})
        setLoading(false)
        setReady(true)
        return
      }
      // INITIAL_SESSION replays the exact session `initialize()` above already fetched a profile
      // for. This isn't a rare double-fire: auth-js's onAuthStateChange unconditionally emits it
      // on every subscription (GoTrueClient.ts's _emitInitialSession, scheduled the moment you
      // subscribe), so this callback and `initialize()` were BOTH running the full
      // profile -> clients+feature_flags waterfall on every single page load. Confirmed live via
      // the network tab: profiles fetched twice, clients twice, feature_flags three times, on one
      // dashboard load. TOKEN_REFRESHED still needs the session updated (done above — a plain
      // state set, not a fetch) but never the profile re-fetched: nothing about who the user is
      // changes when only the token rotates, and startSessionKeepAlive (S458) fires a refresh on
      // every tab focus/visibility/online event, not just once an hour — so this path was firing
      // on ordinary alt-tabbing. Together these were the real cause of the "pages load slowly,
      // sometimes get stuck" reports: not any one query being slow, but the same waterfall running
      // two-plus times, competing for the same connection, on every load.
      if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return
      // Deliberately NOT awaited (found live, 2026-07-28, via HR Self-Service PIN login hanging
      // forever on every single attempt, deterministically, regardless of device/network).
      // supabase.auth.setSession() — the only place in this app that calls it, since every other
      // login uses signInWithPassword() — routes through GoTrueClient's internal _acquireLock and
      // holds `lockAcquired = true` for its entire duration. _setSession() then does
      // `await this._notifyAllSubscribers('SIGNED_IN', ...)`, which awaits every onAuthStateChange
      // subscriber via Promise.all — including this one. If this callback awaits fetchProfile(),
      // and fetchProfile()'s `profiles` query needs a fresh access token (it does, on every call),
      // supabase-js's own internal getAccessToken() call ALSO goes through _acquireLock — sees
      // lockAcquired already true, and queues behind the *outer* setSession() call via
      // `await last`. The outer call can't finish until this callback returns; this callback can't
      // return until the nested call finishes. Permanent deadlock — 100% reproducible, not a
      // network stall (confirmed: the actual /auth/v1/user request completed in 195ms; the
      // `profiles` request never even got issued). signInWithPassword() never hits _acquireLock at
      // all, so every other login in the app was never at risk. Firing fetchProfile() without
      // awaiting it here breaks the cycle: this callback returns immediately, _notifyAllSubscribers
      // resolves, the outer lock releases, and fetchProfile's own nested call then proceeds
      // normally. React state updates inside fetchProfile still land whenever it actually finishes.
      fetchProfile(session.user.id, mounted)
    })

    // Top the access token up whenever the tab wakes (S458). auth-js's own refresh ticker only
    // runs while the tab is awake, so screens where a human types for an hour before pressing
    // Save — Sales Entry, Stock Count, Purchases — otherwise reach Save with a dead 1-hour token.
    const stopKeepAlive = startSessionKeepAlive(supabase)

    return () => { mounted = false; subscription.unsubscribe(); stopKeepAlive() }
  }, [])

  async function fetchProfile(userId, mounted = true) {
    // Marks "a profile fetch is in flight" so ProtectedRoute can wait instead of concluding the
    // user is signed out. On a fresh sign-in `session` is set the instant SIGNED_IN fires while
    // `profile` stays null — fetchProfile is deliberately not awaited there (see the deadlock
    // note above) — and ProtectedRoute's `if (!profile) -> /login` raced Login's
    // `if (ready && session) -> /dashboard`, bouncing between the two routes until the profile
    // landed. That ping-pong is what threw "Maximum update depth exceeded" on every login.
    if (mounted) setLoading(true)
    try {
      const { data, error } = await supabase
        .from('profiles')
        // active_client_id is load-bearing and was MISSING from this list until S617, while two
        // places below read it (effectiveClientId, and clientId in the context value). Undefined
        // in both, so switchOutlet wrote the column server-side and the frontend never learned:
        // my_client_id() resolved to the selected outlet while every scopedDb query still filtered
        // .eq('client_id', <home>), so every client-scoped table returned zero rows with
        // error: null — the whole app empty, and by the S594 rule indistinguishable from an empty
        // tenant. Never noticed because no client has a group_id yet.
        .select('id, full_name, role, client_id, active_client_id, pos_role, pos_team, pos_discount_limit, pos_allow_void, hr_employee_id, hr_self_service, ims_role, ims_job_title, hr_role, hr_job_title')
        .eq('id', userId)
        .single()

      if (!mounted) return
      if (error) { console.error('Profile fetch error:', error); return }

      if (data?.client_id) {
        // The client row to load is the SELECTED outlet (profiles.active_client_id), not
        // necessarily the home one — my_client_id() resolves the same way server-side, so
        // loading the home client here would leave the UI describing a different outlet than
        // every query returns.
        const effectiveClientId = data.active_client_id || data.client_id
        // clients + feature_flags depend only on client_id, not on each other — run them
        // concurrently instead of waterfalling two more round trips after the profile fetch.
        // The outlet list joins them rather than adding a third sequential round trip (S460).
        const [{ data: client }, { data: flags }, { data: siblings }] = await Promise.all([
          supabase
            .from('clients')
            .select('id, name, location, group_id, is_active, plan, trial_ends_at, subscription_ends_at, ims_ends_at, hr_ends_at, pos_ends_at, suite_ends_at, ims_enabled, hr_enabled, pos_enabled, suite_plan, is_trial, trial_start_date, trial_expires_at, trial_purge_at, subscribe_requested')
            .eq('id', effectiveClientId)
            .single(),
          supabase
            .from('feature_flags')
            .select('*')
            .eq('client_id', effectiveClientId)
            .maybeSingle(),
          // clients_select allows same-group rows, so this returns the outlet list for a grouped
          // client and exactly one row (their own) for everyone else — no group, no switcher.
          supabase
            .from('clients')
            .select('id, name, location, group_id, is_active, suite_plan, ims_ends_at, hr_ends_at, pos_ends_at, suite_ends_at, subscription_ends_at, trial_ends_at, is_trial, trial_expires_at')
            .order('name'),
        ])
        if (mounted) {
          data.clients = client
          setFeatureFlags(flags || {})
          setOutlets(prev => nextOutletsOrSame(prev, client, siblings))
        }

        // Legal re-acceptance. Deliberately shaped like the profile_outlet_access read below: it is
        // skipped entirely unless some document actually demands re-acceptance, so while
        // requiresReacceptance is false everywhere (which it is for v1.0) this costs the hot path
        // exactly nothing and never touches a table a given deployment may not have migrated yet.
        //
        // Owner only — staff are not the contracting party and are never gated, so fetching this
        // for them would be a query whose answer is unused.
        //
        // It fails OPEN. On any error `rows` is null, the gate stays down, and the app keeps
        // working; a missing table, an RLS refusal or a dropped connection must never lock every
        // owner out of the product. Same stance as getAccessState.
        // Doc-type strings, not documents: this scope only counts them and filters a column by
        // them. The memo that decides the gate reads the documents themselves, because it needs
        // each one's `version` to compare against the accepted row.
        const reacceptTypes = reacceptDocTypes()
        const profileIsOwner = data.role === 'client'
          && !data.pos_role && !data.ims_role && !data.hr_role && !data.hr_self_service
        if (mounted && reacceptTypes.length && profileIsOwner) {
          const { data: rows, error: legalErr } = await supabase
            .from('legal_acceptances')
            .select('doc_type, doc_version')
            .eq('client_id', effectiveClientId)
            // reacceptDocTypes(), never docsRequiringReacceptance() — this compares against the
            // doc_type COLUMN, and the latter returns document objects. Passing those here
            // filtered on the literal text "[object Object]", matched nothing, and returned
            // `{ data: [], error: null }`: a successful read reporting that the client had
            // accepted nothing, which held every Owner at the gate permanently and could not be
            // cleared by accepting. Silent in both directions — no error to catch, and the
            // fail-OPEN branch (`legalAccepted === null`) never reached (S674).
            .in('doc_type', reacceptTypes)
          if (mounted) setLegalAccepted(legalErr ? null : (rows || []))
        } else if (mounted) {
          setLegalAccepted([])
        }

        // The outlet allowlist is fetched SECOND and only for a grouped client — deliberately not
        // folded into the batch above, for two reasons. It is dead weight for the ungrouped
        // majority, who can never switch anywhere. And this is the app's hottest path: every page
        // load runs it, so per the standing rule about migration hot paths, it must not reference
        // a table that may not exist yet on a given deployment. Gating on group_id means an
        // ungrouped deployment never issues the query at all, and a grouped one only reaches it
        // after the multi-outlet migrations have been applied. supabase-js resolves rather than
        // throws on a missing table, so even then the failure mode is an empty allowlist — no
        // switcher — which is the safe direction.
        if (mounted && client?.group_id) {
          const { data: access } = await supabase
            .from('profile_outlet_access')
            .select('client_id')
            .eq('profile_id', userId)
          if (mounted) {
            setAllowedOutletIds(prev => nextIdsOrSame(prev, (access || []).map(a => a.client_id)))
          }
        } else if (mounted) {
          setAllowedOutletIds(prev => nextIdsOrSame(prev, []))
        }
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
  // active_client_id mirrors what my_client_id() resolves to server-side. Every scoped query,
  // and every RLS policy, already follows it — useScopedDb binds clientId straight from here, so
  // this one value re-scopes all ~200 call sites and 65 CLIENT_SCOPED_TABLES with no per-page
  // change. NULL for everyone not in a group, which is what keeps ungrouped clients identical.
  const clientId = isAdmin ? adminViewClientId : (profile?.active_client_id || profile?.client_id || null)

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

  // ── Multi-outlet ──
  // An Owner reaches every outlet in the group. Anyone else reaches their home outlet plus
  // whatever they have been explicitly allowlisted into (S617, profile_outlet_access). The case
  // that motivated the allowlist is a manager who genuinely covers two branches: before it, the
  // only way to grant the second was to make them an Owner, which hands over the entire group
  // AND — because the Owner test is the ABSENCE of staff markers — strips every rank they hold.
  //
  // The default is still nothing. An account with no allowlist row gets no switcher at all, so a
  // POS till, an IMS storekeeper or an HR clerk stays pinned to one physical outlet exactly as
  // before. This is a UI convenience over set_active_outlet()'s server-side check, never a
  // substitute for it — that RPC enforces the same rule and is the thing that actually holds.
  const homeClientId = profile?.client_id || null
  const switchableOutlets = useMemo(() => {
    if (isOwner) return outlets
    if (!allowedOutletIds.length) return []
    return outlets.filter(o => o.id === homeClientId || allowedOutletIds.includes(o.id))
  }, [isOwner, outlets, allowedOutletIds, homeClientId])
  const canSwitchOutlet = switchableOutlets.length > 1

  // Writes through set_active_outlet(), never a direct PATCH: active_client_id decides which
  // tenant every RLS policy resolves to, so it is a privileged column and is deliberately NOT on
  // guard_profiles_privileged_columns()'s allow-list. The RPC validates group membership and
  // fails closed. Reloading the profile afterwards re-runs the whole waterfall against the new
  // outlet, which is what repoints clientId and every page's data.
  //
  // The offline-queue check lives HERE rather than in the caller. It used to sit in Layout.js's
  // handler, which made it a property of one particular switcher UI — any second entry point
  // (the Group Console's outlet links) would have had to reimplement it, and a missed copy
  // silently flushes a queued write against the wrong tenant. Guarding the privileged action
  // itself makes that unbypassable.
  async function switchOutlet(targetClientId) {
    try {
      const { getQueue, getPosOrderQueue } = await import('../utils/offlineQueue')
      // Both queues matter: stock ops write against the current tenant just as POS orders do.
      const [stockOps, posOrders] = await Promise.all([getQueue(), getPosOrderQueue()])
      const pending = (stockOps?.length || 0) + (posOrders?.length || 0)
      if (pending > 0) {
        return { error: { message: `${pending} offline change${pending === 1 ? '' : 's'} still syncing — reconnect and let them finish before switching outlet.` } }
      }
    } catch {
      // No offline store on this device: nothing queued, nothing to protect.
    }
    const { error } = await supabase.rpc('set_active_outlet', { p_client_id: targetClientId || null })
    if (error) return { error }
    // sessionStorage caches are namespaced per clientId, but clearing is cheaper than reasoning
    // about which page cached what against the outlet we are leaving.
    try { sessionStorage.clear() } catch { /* private mode */ }
    if (session?.user?.id) await fetchProfile(session.user.id)
    return {}
  }

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

  // `plan` is the IMS plan and nothing else. It used to be the MAXIMUM across clients.plan,
  // ims_plan, hr_plan, pos_plan and is_premium — which was a revenue leak, found live while
  // smoke-testing the S548 retier: a client sitting at clients.plan = 'starter' with hr_plan and
  // pos_plan both 'pro' resolved to Pro and received every IMS Pro feature, having bought none.
  // HR and POS are sold FLAT — neither has tiers and nothing in the product charges for those
  // columns — so any client with either module enabled at 'pro' was getting IMS Pro free.
  //
  // The max made sense while Suite was a bundle: handleSuitePlanPick deliberately wrote all three
  // plan columns together (that code is deleted). It also once fixed a cosmetic complaint that
  // POS-only clients showed "Starter" in the sidebar — but a POS-only client has ims_enabled
  // false, so ModuleGate blocks every IMS route regardless and the label was the only thing the
  // max was buying. Not worth handing out the Pro tier for.
  //
  // ims_plan is dropped outright: there is no such column on `clients` (confirmed against the
  // live DB — the query errors with 42703). It was always undefined and silently discarded by
  // filter(Boolean), so this changes nothing except removing a phantom.
  //
  // is_premium was the last surviving raiser, retired in S574 (phase 7 of the critique campaign).
  // It had one honest thing going for it — unlike hr_plan/pos_plan it meant what it said — but it
  // appeared on NO admin screen, in no MRR figure, and in no control: a Starter client with the
  // flag received every IMS Pro feature while the client list, the drawer, Feature Access and the
  // invoice all said Starter. That is the S552 rule ("a billed axis must be visible on the screens
  // that bill it") violated in the worse direction — it changed what the client RECEIVES, not just
  // what is displayed. Migration 20260818180000 folds it into clients.plan ('pro' wherever the
  // flag was set) so no entitlement changes; the column is now vestigial like hr_plan/pos_plan —
  // never read, never written. The migration must be applied before this code deploys, or a
  // starter+is_premium client loses Pro access for the gap.
  const plan = isAdmin ? 'pro' : (profile?.clients?.plan || 'starter')

  // isPremium = true for Growth and Pro (any paid plan) — keeps existing checks working
  const isPremium = isAdmin || plan === 'growth' || plan === 'pro'

  // trialEndsAt/isTrialing (read from the legacy trial_ends_at column) were exported here and
  // consumed by exactly nothing — removed in S574 when the trial columns were canonicalised on
  // the register_trial set (is_trial + trial_expires_at); migration 20260818190000 folds the
  // legacy column's values in.

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

  // Subscription access — a lapsed client used to keep full access forever, since clients.is_active
  // and every *_ends_at column were read only by the admin UI and enforced literally nowhere.
  // Admin is exempt (they must be able to reach a locked client to fix or convert it); every
  // account type belonging to the client — Owner, IMS/HR/POS staff, POS PIN tills — is not.
  const clientRecord  = profile?.clients
  const accessState   = useMemo(() => getAccessState(clientRecord), [clientRecord])

  // A document that demands re-acceptance and has no matching row for this client's CURRENT
  // version. `null` means the read failed, which is treated as "not required" — see the fetch.
  const legalReacceptRequired = useMemo(() => {
    if (isAdmin || !isOwner || legalAccepted === null) return false
    return docsRequiringReacceptance().some(doc =>
      !legalAccepted.some(r => r.doc_type === doc.docType && r.doc_version === doc.version)
    )
  }, [isAdmin, isOwner, legalAccepted])
  const accessLocked  = !isAdmin && accessState.locked
  const accessReason  = accessState.reason
  const graceDaysLeft = accessState.graceLeft

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
    // POS is flat — its features unlock with the module, not with any plan rank.
    if (POS_MODULE_KEYS.has(featureKey) && posEnabled) return true
    // SUITE_KEYS deliberately fall through to false here. SuiteGate owns that decision via
    // clients.suite_plan; the flag check at the top of this function is their only override.
    return false
  }

  return (
    <AuthContext.Provider value={{
      session, profile, loading, ready,
      signIn, signOut,
      clientId, isAdmin, isPremium,
      plan,
      isTrial, trialExpired, trialDaysLeft, trialPurgeInDays, subscribeRequested, requestSubscription,
      accessLocked, accessReason, graceDaysLeft,
      legalReacceptRequired, refreshProfile: () => session?.user?.id && fetchProfile(session.user.id),
      featureFlags, hasFeature,
      // Multi-outlet. `outlets` is [] for everyone not in a group, so every consumer of these
      // degrades to today's single-outlet behavior without a special case.
      outlets, switchableOutlets, allowedOutletIds, canSwitchOutlet, switchOutlet,
      groupId: profile?.clients?.group_id || null,
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
      // hrPlan/posPlan are deliberately NOT exposed. Crest HR and Crest POS are yes/no modules
      // with no tiers, so a "plan" for either is a concept the product does not sell. The
      // clients.hr_plan/pos_plan columns still exist but are vestigial; anything that needs to
      // know whether a client has HR or POS reads hrEnabled/posEnabled.
      // Crest Suite Pro — an independent axis from `plan` above. NULL = not subscribed.
      suitePlan: isAdmin ? 'pro' : (profile?.clients?.suite_plan || null),
      adminViewClientId, adminViewClientName, switchAdminClient, refreshViewModules,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
