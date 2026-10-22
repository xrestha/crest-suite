import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { useSupportContact } from '../shared/hooks/useSupportContact'
import { npr } from '../shared/nepalMoney'
import ModuleMissingCard from './ModuleMissingCard'

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
// labour figures come from HR); the other five (Monthly Owner Report, Profit & Loss, Group Console,
// Demand Forecast, Fixed Assets) need ['ims']. A caller that passes no
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
// in AuthContext); featureLabel is what the card names, in the words the nav uses (S857: three were
// older names the menu no longer shows); requireModules is the module floor.
export const SUITE_PAGES = Object.freeze({
  ownerDashboard:  Object.freeze({ featureKey: 'owner_dashboard',      featureLabel: 'Owner Dashboard',      requireModules: Object.freeze(['ims', 'hr']) }),
  ownerReport:     Object.freeze({ featureKey: 'monthly_owner_report', featureLabel: 'Monthly Owner Report', requireModules: Object.freeze(['ims']) }),
  consolidatedPnl: Object.freeze({ featureKey: 'consolidated_pnl',     featureLabel: 'Profit & Loss',        requireModules: Object.freeze(['ims']) }),
  groupConsole:    Object.freeze({ featureKey: 'multi_outlet',         featureLabel: 'Group Console',        requireModules: Object.freeze(['ims']) }),
  demandForecast:  Object.freeze({ featureKey: 'demand_forecast',      featureLabel: 'Demand Forecast',      requireModules: Object.freeze(['ims']) }),
  fixedAssets:     Object.freeze({ featureKey: 'fixed_asset_register', featureLabel: 'Fixed Assets',         requireModules: Object.freeze(['ims']) }),
})

// What the offer says on each page (S857, the Suite Pro critique: one padlock card on all six pages,
// with no price and nothing about what the page would tell this owner, was honest and gave no reason
// to buy). `title` is the problem, then the relief, under ~16 words in two short sentences: the /login
// copy rule, because most buyers read English as a second or third language. `gets` is what the page
// does, in three lines. `example` is drawn like the page with MADE-UP figures and says so in its own
// header; it reads nothing, so an Owner without Suite still sends no Suite read (S849 ACCESS-9).
export const SUITE_OFFERS = Object.freeze({
  owner_dashboard: {
    title: 'Most owners learn their margin after the month ends. See it while it runs.',
    gets: ['Your margin so far, said in one sentence', 'Labour and stock costs against healthy targets', 'Stock below par and overdue supplier bills, in one list'],
    example: {
      head: 'Bhadra so far',
      line: 'You keep NPR 12 of every NPR 100 you sell.',
      rows: [['Revenue so far', npr(482000)], ['Labor Cost %', '27.4% ✓'], ['Prime Cost %', '63.1% △'], ['Net Margin %', '11.8% △']],
    },
  },
  monthly_owner_report: {
    title: 'Month-end figures change when someone edits them. This report freezes them, ready to print.',
    gets: ['Every figure of a closed month, kept as it was', 'Crest IMS, HR and POS on one printable report', 'Each figure beside last month and your target'],
    example: {
      head: 'Shrawan · closed',
      line: 'Revenue held steady and labour came down. Look at: Prime Cost %.',
      rows: [['Revenue', npr(964500)], ['Food Cost %', '33.2% ✓'], ['Labor Cost %', '28.9% ✓'], ['Net Margin %', '14.6% △']],
    },
  },
  consolidated_pnl: {
    title: 'Your accountant needs a real statement. Get one for any month or year.',
    gets: ['Revenue down to net profit, line by line', 'One month, or a whole fiscal year added up', 'Each outlet side by side when you run more than one'],
    example: {
      head: 'Shrawan · statement',
      rows: [['Revenue', npr(964500)], ['Cost of goods sold', `(${npr(320200)})`], ['Gross profit', npr(644300)], ['Net profit', npr(140800)]],
    },
  },
  multi_outlet: {
    title: 'Checking each branch takes a login each. See every outlet on one screen.',
    gets: ['Revenue, food cost and labour for every outlet', 'Group totals for the month', 'Staff access to more than one branch, set in one place'],
    example: {
      head: 'Bhadra · every outlet',
      rows: [['Thamel', `${npr(610000)} · 31.2% ✓`], ['Lakeside', `${npr(420000)} · 36.4% △`], ['Group', `${npr(1030000)} · 33.3% ✓`]],
    },
  },
  demand_forecast: {
    title: 'Guessing what to buy wastes stock. Plan next week from your own sales.',
    gets: ['Plates and sales expected for the next 7 or 30 days', 'A buying list grouped by supplier', 'Festival days counted in'],
    example: {
      head: 'Next 7 days',
      rows: [['Chicken momo', '86 plates'], ['Veg thukpa', '41 plates'], ['Buy: chicken mince', '9 kg'], ['Buy: flour', '2 sacks']],
    },
  },
  fixed_asset_register: {
    title: 'Working out depreciation by hand goes wrong. Crest does it, IRD tax pools included.',
    gets: ['A register of everything the business owns', 'Depreciation posted month by month', 'The tax pools the IRD asks for'],
    example: {
      head: 'Kitchen equipment',
      rows: [['Bought for', npr(840000)], ['Depreciation so far', `(${npr(126000)})`], ['Book value now', npr(714000)]],
    },
  },
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

  // Only the OWNER is offered the sale: a supervisor reaches Demand Forecast and Fixed Assets by nav
  // (they are Suite-billed but IMS-shaped), and a pitch for someone who cannot buy is a pitch with no
  // door behind it (S683). Everyone else gets the one sentence that says who can act.
  if (!auth.isOwner) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <p style={{ fontSize: 15, color: 'var(--theme-text1)', fontWeight: 600, margin: '0 0 8px' }}>
          {p.featureLabel} is part of Crest Suite Pro
        </p>
        <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 16px', lineHeight: 1.6 }}>
          It is switched on for the whole outlet, not per login. Ask the account owner.
        </p>
        <Link to="/dashboard" className="btn btn-ghost" style={{ textDecoration: 'none' }}>Go to Dashboard</Link>
      </div>
    )
  }
  return <SuiteOffer page={p} onPlans={() => navigate('/pricing')} />
}

// The Owner's offer (S857). This gate REPLACES the whole page body, so its controls are real
// <button>s and links, never a clickable card (S683: a bare onClick div left a keyboard user no route
// on). Calling Crest is the main action, because in this market a sale is a conversation; the price
// comes from Plan Pricing through useSettings().pricing, never from the constants (S701), so it moves
// when the admin moves it. No padlock: the page says what it would show instead.
function SuiteOffer({ page, onPlans }) {
  const { pricing } = useSettings()
  const contact = useSupportContact()
  const offer = SUITE_OFFERS[page.featureKey]
  const suite = pricing?.suite
  const titleId = `suite-offer-${page.featureKey || 'page'}`
  return (
    <section className="card" aria-labelledby={titleId}>
      <div className="suite-offer">
        <div>
          <h2 id={titleId} className="suite-offer__title">{offer?.title || `${page.featureLabel} is part of Crest Suite Pro.`}</h2>
          <p className="suite-offer__lead">
            {page.featureLabel} is part of Crest Suite Pro, the owner pages added on top of your modules.
          </p>
          {offer && (
            <ul className="suite-offer__gets" aria-label={`What ${page.featureLabel} gives you`}>
              {offer.gets.map(g => <li key={g}>{g}</li>)}
            </ul>
          )}
          {suite && typeof suite.monthly === 'number' && (
            <p className="suite-offer__price">
              <b>{npr(suite.monthly)}</b> a month per outlet
              {typeof suite.annual === 'number' && <> · {npr(suite.annual)} a month when paid yearly</>}
            </p>
          )}
          <div className="suite-offer__actions no-print">
            {contact.telHref
              ? <a className="btn btn-primary" href={contact.telHref}>Call Crest {contact.phone}</a>
              : contact.email && <a className="btn btn-primary" href={`mailto:${contact.email}`}>Email Crest</a>}
            {contact.whatsappHref && <a className="btn btn-ghost" href={contact.whatsappHref} target="_blank" rel="noopener noreferrer">WhatsApp</a>}
            {contact.telHref && contact.email && <a className="btn btn-ghost" href={`mailto:${contact.email}`}>Email us</a>}
            <button type="button" className="btn btn-ghost" onClick={onPlans}>See all plans</button>
          </div>
        </div>
        {offer?.example && (
          <figure className="suite-offer__example" style={{ margin: 0 }} aria-label={`Example of ${page.featureLabel} with made-up figures`}>
            <div className="suite-offer__example-head">{offer.example.head}<span>Example</span></div>
            <table>
              <tbody>
                {offer.example.rows.map(([label, value]) => <tr key={label}><td>{label}</td><td>{value}</td></tr>)}
              </tbody>
            </table>
            <figcaption className="suite-offer__example-note">
              {offer.example.line ? <>{offer.example.line} </> : null}
              Made-up figures. Yours appear here once Suite Pro is on.
            </figcaption>
          </figure>
        )}
      </div>
    </section>
  )
}
