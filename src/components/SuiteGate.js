import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import ModuleMissingCard from './ModuleMissingCard'
import SupportContactLine from './SupportContactLine'

// Gates on the Crest Suite Pro axis (clients.suite_plan) + a required module set — independent of
// PremiumGate's per-module plan/hasFeature() machinery. Unlike ModuleGate/PremiumGate, this never
// navigates away on failure: the nav entry must always stay visible, and an ineligible viewer
// lands on an inline explanation/upsell in place instead of being bounced.
//
// Suite has ONE tier. It used to carry starter/growth/pro ranks, but both call sites were
// minTier="growth" — so Suite Starter unlocked nothing at all, and Suite Pro added nothing over
// Suite Growth on its own axis. suite_plan is now NULL | 'pro' and this is a flat check.
//
// Each page's required modules are in SUITE_PAGES below: Owner Dashboard needs ['ims', 'hr'] (its
// labour figures come from HR); the other five (Monthly Owner/Manager Report, Consolidated P&L,
// Group Console, Demand Forecast, Fixed Assets) need ['ims']. A caller that passes no
// requireModules still gets ['ims', 'hr'], the gate's original default.
//
// The module-missing branch is ModuleMissingCard (S683) — shared with ModuleGate, so both name
// the module and both offer a way to act. This gate's own card used to say "Contact your
// consultant" with no phone, email or link: the one gate not on useSupportContact().
//
// ── S849 (ACCESS-9/-12): one answer for the gate AND the page's loads ───────────────────────────
// A JSX child is evaluated before its wrapper runs, so a page that renders <SuiteGate> around its
// body while its own effects read data had already sent every read by the time the card showed: an
// Owner without Suite minted a Monthly Report, ran the Owner Dashboard's whole load, and so on.
// `suiteAccess()` is now the ONE test. The gate renders from it, and a page's effects ask the same
// question through `useSuiteAccess(SUITE_PAGES.x)` before they read anything:
//
//   const suite = useSuiteAccess(SUITE_PAGES.ownerReport)
//   const canLoad = suite.allowed && (isAdmin || isOwner)
//   useEffect(() => { if (!canLoad) return; …load… }, [canLoad, …])
//   …after every hook: the role <Navigate>…
//   return <SuiteGate page={SUITE_PAGES.ownerReport}>…</SuiteGate>
//
// Pass the SAME SUITE_PAGES entry to both, so the gate and the loads cannot disagree. A heavy page
// may instead render its body as a render prop, `<SuiteGate page={…}>{() => <Body />}</SuiteGate>`:
// the function runs only once the gate passes, so the body's hooks never mount behind the card.
// Anything the page draws outside the gate (title, period name) must not come from a gated load.

// The six Suite pages. featureKey is the per-client override column in feature_flags (SUITE_KEYS
// in AuthContext); featureLabel is what the card names; requireModules is the module floor.
export const SUITE_PAGES = Object.freeze({
  ownerDashboard:  Object.freeze({ featureKey: 'owner_dashboard',      featureLabel: 'Owner Dashboard',              requireModules: Object.freeze(['ims', 'hr']) }),
  ownerReport:     Object.freeze({ featureKey: 'monthly_owner_report', featureLabel: 'Monthly Owner/Manager Report', requireModules: Object.freeze(['ims']) }),
  consolidatedPnl: Object.freeze({ featureKey: 'consolidated_pnl',     featureLabel: 'Consolidated P&L',             requireModules: Object.freeze(['ims']) }),
  groupConsole:    Object.freeze({ featureKey: 'multi_outlet',         featureLabel: 'Multi-Outlet Group Console',   requireModules: Object.freeze(['ims']) }),
  demandForecast:  Object.freeze({ featureKey: 'demand_forecast',      featureLabel: 'Demand Forecast',              requireModules: Object.freeze(['ims']) }),
  fixedAssets:     Object.freeze({ featureKey: 'fixed_asset_register', featureLabel: 'Fixed Assets',                 requireModules: Object.freeze(['ims']) }),
})

// Keyed by route, for the nav (Layout's PRO chip asks whether each visible Suite row would open).
export const SUITE_PAGE_BY_PATH = Object.freeze({
  '/owner-dashboard': SUITE_PAGES.ownerDashboard,
  '/owner-report':    SUITE_PAGES.ownerReport,
  '/pnl':             SUITE_PAGES.consolidatedPnl,
  '/group-dashboard': SUITE_PAGES.groupConsole,
  '/demand-forecast': SUITE_PAGES.demandForecast,
  '/fixed-assets':    SUITE_PAGES.fixedAssets,
})

const DEFAULT_MODULES = ['ims', 'hr']

// A page given as a featureKey string (FORECAST's `useSuiteAccess('demand_forecast', ['ims'])`) or
// as a SUITE_PAGES entry, normalised to one shape.
function pageOf(page, requireModules) {
  if (typeof page === 'string') {
    return { featureKey: page, featureLabel: 'This feature', requireModules: requireModules || DEFAULT_MODULES }
  }
  return {
    featureKey: page?.featureKey || null,
    featureLabel: page?.featureLabel || 'This feature',
    requireModules: page?.requireModules || requireModules || DEFAULT_MODULES,
  }
}

// The one answer SuiteGate gives, as a pure function of the useAuth() value (testable).
//   admin                       → ok (the operator reaches every Suite page)
//   the client row is not known → 'unknown' (a failed read is not "no Suite": ACCESS-11)
//   a required module is off    → 'modules'
//   Suite live, or an override  → ok
//   otherwise                   → 'plan'
// `entitled` (ACCESS-7) is a page's own extra entitlement that ORs with the outlet's Suite: the Group
// Console and the group P&L pass "any outlet of the group has a live Suite", so an Owner switched to a
// branch without Suite still opens the group. It never bypasses the module floor. It is an OR rather
// than a replacement for the outlet's own Suite: the outlet is one of its group's outlets, so the two
// agree whenever the list is loaded, and an ungrouped or not-yet-loaded list ([] → false) must not
// lock a paying outlet out of its own P&L.
export function suiteAccess(auth, page, options = {}) {
  const p = pageOf(page)
  const a = auth || {}
  const none = { allowed: false, missingModules: [], overridden: false }
  if (a.isAdmin) return { allowed: true, reason: 'ok', missingModules: [], overridden: false }
  if (a.clientKnown === false) return { ...none, reason: 'unknown' }
  const moduleState = { ims: a.imsEnabled, hr: a.hrEnabled, pos: a.posEnabled, customization: a.customizationEnabled }
  const missingModules = p.requireModules.filter(m => !moduleState[m])
  if (missingModules.length) return { ...none, reason: 'modules', missingModules }
  // `entitled` may ride on the page object itself (GROUP passes one memoised object to both
  // useSuiteAccess and <SuiteGate page>) or come as an option; either ORs with the outlet's Suite.
  if (a.suitePlan === 'pro' || options.entitled === true || page?.entitled === true) {
    return { allowed: true, reason: 'ok', missingModules: [], overridden: false }
  }
  const overridden = !!p.featureKey && typeof a.hasFeature === 'function' && a.hasFeature(p.featureKey) === true
  if (overridden) return { allowed: true, reason: 'ok', missingModules: [], overridden: true }
  return { ...none, reason: 'plan' }
}

// useSuiteAccess(SUITE_PAGES.x, options?) or useSuiteAccess('featureKey', requireModules?, options?).
// A string first argument is a featureKey; requireModules then defaults to ['ims', 'hr'], the gate's
// own default. Both forms give the same answer for the same page.
export function useSuiteAccess(page, requireModulesOrOptions, maybeOptions) {
  const auth = useAuth()
  if (typeof page === 'string') {
    const requireModules = Array.isArray(requireModulesOrOptions) ? requireModulesOrOptions : undefined
    const options = Array.isArray(requireModulesOrOptions) ? maybeOptions : requireModulesOrOptions
    return suiteAccess(auth, pageOf(page, requireModules), options || {})
  }
  return suiteAccess(auth, page, (Array.isArray(requireModulesOrOptions) ? maybeOptions : requireModulesOrOptions) || {})
}

// `page` = a SUITE_PAGES entry. The legacy featureKey / featureLabel / requireModules props are still
// accepted for a caller not yet moved. `entitled` = the page's extra entitlement (see suiteAccess).
// `children` may be a function, called only when the gate passes.
export default function SuiteGate({ page, children, featureKey, featureLabel, requireModules, entitled }) {
  const auth = useAuth()
  const navigate = useNavigate()
  const p = page
    ? pageOf(page)
    : pageOf({ featureKey, featureLabel, requireModules })
  const access = suiteAccess(auth, p, { entitled })

  if (access.allowed) return typeof children === 'function' ? children() : children

  if (access.reason === 'unknown') {
    // The outlet's own row did not load, so nothing here says whether Suite is on. Never the sales
    // pitch: the reader may well be a paying Owner (ACCESS-11).
    return (
      <div className="card" role="status" style={{ textAlign: 'center', padding: '48px 24px' }}>
        <p style={{ fontSize: 15, color: 'var(--theme-text1)', fontWeight: 700, margin: '0 0 8px' }}>
          Could not check whether Crest Suite Pro is on for this outlet
        </p>
        <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px', lineHeight: 1.6 }}>
          This outlet&apos;s details did not load, so {p.featureLabel} cannot open yet. Nothing has changed. Reload the page to try again.
        </p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload the page</button>
      </div>
    )
  }

  if (access.reason === 'modules') return <ModuleMissingCard what={p.featureLabel} modules={access.missingModules} />

  const { isOwner } = auth
  // A real <button>, not a clickable card. This gate REPLACES the whole page body, so on
  // /owner-dashboard, /owner-report and /group-dashboard it is the only interactive thing in
  // <main> — as a bare onClick div it had no role, no tab stop and no key handler, which left a
  // keyboard user with no route to pricing at all from those three routes. Same shape as
  // PremiumGate's upsell, which never had the bug.
  //
  // Only the OWNER is offered plans: a supervisor reaches Demand Forecast and Fixed Assets by
  // nav (they are Suite-billed but IMS-shaped), and "View plans" for someone who cannot buy is a
  // pitch with no door behind it (S683). The Owner also gets Crest's phone and email, as
  // ModuleMissingCard gives them (DOCS-8).
  return (
    <div
      className="card"
      style={{ textAlign: 'center', padding: '48px 24px', borderStyle: 'dashed', borderColor: 'var(--theme-focus-ring)' }}
    >
      <div style={{ fontSize: 32, marginBottom: 12 }} aria-hidden="true">🔒</div>
      <p style={{ fontSize: 15, color: 'var(--theme-accent-ink)', fontWeight: 700, margin: '0 0 8px' }}>Unlock with Crest Suite Pro</p>
      <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px', lineHeight: 1.6 }}>
        {p.featureLabel} is part of Crest Suite Pro — the owner layer added on top of your modules.
        {!isOwner && ' It is switched on for the whole outlet, not per login — ask the account owner.'}
      </p>
      {isOwner
        ? (
          <>
            <button className="btn btn-primary" onClick={() => navigate('/pricing')}>View plans →</button>
            <div style={{ marginTop: 16 }}><SupportContactLine variant="buttons" /></div>
          </>
        )
        : <Link to="/dashboard" className="btn btn-ghost" style={{ textDecoration: 'none' }}>Go to Dashboard</Link>}
    </div>
  )
}
