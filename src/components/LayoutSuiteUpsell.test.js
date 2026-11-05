import { render, screen, within, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Layout from './Layout'
import { planHasFeature } from '../context/AuthContext'

// POS_TODO B3 (S763): the menu of an Owner WITHOUT Crest Suite Pro had never been seen. Every login
// on hand either has Suite or is the Crest operator, and the operator always counts as entitled
// (`suiteEntitled = isAdmin || suitePlan === 'pro'`). The documented split (access-control.md,
// navigation.md): without Suite, a PRO-badged "Crest Suite" group sits inside every module panel
// and there is no Suite tab in the top row; with Suite, a "Suite" tab opens its own panel and the
// group is gone from the module panels.
//
// Layout draws BOTH navigations on every screen size: the phone drawer (`.sidebar-wrap`, opened by
// the menu button) and the desktop top bar (`<header>`). CSS alone hides one of them, and the
// component has no width check in JS, so both are asserted here: the bar through the banner
// landmark, the drawer as the nav the "Open navigation menu" button controls.

// Network-facing pieces of the shell, none of which decide what the menu shows. A call that still
// reaches supabase answers with an empty list rather than throwing.
jest.mock('../supabaseClient', () => {
  const chain = () => new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'then'
      ? (ok, bad) => Promise.resolve({ data: [], error: null }).then(ok, bad)
      : () => chain()),
  })
  return { supabase: chain() }
})
let mockAuth = null
jest.mock('../context/AuthContext', () => ({
  ...jest.requireActual('../context/AuthContext'),
  useAuth: () => mockAuth,
}))
jest.mock('../context/SettingsContext', () => ({
  useSettings: () => ({ settings: { app_name: 'Crest' }, pricing: {} }),
}))
jest.mock('../shared/hooks/useNavBadgeCounts', () => ({
  useNavBadgeCounts: () => ({ hrPending: 0, posPending: 0, posRequests: 0, posNew: 0 }),
}))
jest.mock('../shared/hooks/useGuestOrderAlerts', () => ({
  ...jest.requireActual('../shared/hooks/useGuestOrderAlerts'),
  useGuestOrderAlerts: () => ({ requests: [], muted: false, urgent: false, mute: () => {}, waitedMs: 0 }),
}))
jest.mock('../shared/periodList', () => ({
  ...jest.requireActual('../shared/periodList'),
  readPeriodList: () => Promise.resolve({ data: [], error: null }),
  subscribePeriodList: () => () => {},
}))
// Opening an HR or POS page starts fetching that module's other pages; not this test's business.
jest.mock('../shared/prefetchHrPages', () => ({ prefetchHrPages: () => {}, prefetchAllowed: () => false }))
jest.mock('../shared/prefetchPosPages', () => ({ prefetchPosPages: () => {}, prefetchCustomizationPages: () => {} }))
// The command palette and the calculator load on demand; the setup strip reads the setup guide.
jest.mock('./LoadOnOpen', () => ({ __esModule: true, default: () => null, onDemand: () => ({}), whenIdle: () => () => {} }))
jest.mock('./SetupStepStrip', () => () => null)

// The Suite rows an Owner of a single outlet can reach (Group Console needs a group of outlets).
// Demand Forecast and Fixed Assets are IMS-shaped (minImsRole), so an outlet without IMS has only
// the three owner pages.
const ALL_ROWS = ['Owner Dashboard', 'Owner Report', 'Profit & Loss', 'Demand Forecast', 'Fixed Assets']
const OWNER_ROWS = ['Owner Dashboard', 'Owner Report', 'Profit & Loss']

// What AuthContext gives a tenant Owner (the absence of every staff marker): `manager` on each
// module the outlet has, the IMS plan, and `suitePlan` 'pro' only while Suite is live.
function ownerOf({ ims = true, hr = true, pos = true, suitePlan = null, plan = 'pro' } = {}) {
  return {
    session: null,
    profile: {
      id: 'owner-1', role: 'client', client_id: 'outlet-1', full_name: 'Test Owner',
      clients: { id: 'outlet-1', name: 'Test Outlet', plan, ims_enabled: ims, hr_enabled: hr, pos_enabled: pos, suite_plan: suitePlan },
    },
    isAdmin: false, isOwner: true, clientId: 'outlet-1', clientKnown: true, adminViewClientId: null,
    plan, suitePlan,
    suite: suitePlan === 'pro' ? { live: true, daysLeft: null, inGrace: false, endsAt: null } : null,
    clientModules: { ims, hr, pos, customization: false, imsSince: null },
    imsEnabled: ims, hrEnabled: hr, posEnabled: pos, customizationEnabled: false,
    imsRole: 'manager', hrRole: 'manager', posRole: 'manager',
    hasImsAccess: () => ims, hasHrAccess: () => hr, hasPosAccess: () => pos,
    canReachPosPath: () => true,
    hasFeature: key => planHasFeature(key, { plan, flags: {}, posEnabled: pos }),
    imsCountOnly: false, isStationTeam: false, groupId: null,
    outlets: [], switchableOutlets: [], canSwitchOutlet: false, switchOutlet: jest.fn(),
    outletMoved: null, dismissOutletMoved: jest.fn(), checkOutlet: jest.fn(), outletHeld: null, returnToOutlet: jest.fn(),
    switchAdminClient: jest.fn(), signOut: jest.fn(),
    isTrial: false, trialPending: false, trialExpired: false, trialDaysLeft: 0,
    subscribeRequested: false, requestSubscription: jest.fn(), accessReason: 'ok', graceDaysLeft: 0,
  }
}

function renderShell() {
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="*" element={<p>Page body</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
  )
}

const topBar = () => screen.getByRole('banner')
const startsWith = label => name => name.startsWith(label)

// Pressing a module tab in the desktop bar, as a person does: it opens that module (S800).
function openTab(label) {
  const tabs = within(topBar()).getByRole('navigation', { name: 'Modules' })
  fireEvent.click(within(tabs).getByRole('button', { name: label }))
}

function barPanel(title) {
  return within(topBar()).getByRole('navigation', { name: `${title} pages` })
}

// The phone path: press the menu button, then read the nav that button controls.
function openDrawer(title) {
  const menuButton = screen.getByRole('button', { name: 'Open navigation menu' })
  fireEvent.click(menuButton)
  expect(menuButton).toHaveAttribute('aria-expanded', 'true')
  const drawerId = menuButton.getAttribute('aria-controls')
  const drawer = screen.getAllByRole('navigation', { name: `${title} pages` }).find(n => n.id === drawerId)
  expect(drawer).toBeDefined()
  return drawer
}

// The bar folds the group into a menu: a "Crest Suite" button carrying PRO, closed until pressed.
function expectBarUpsell(nav, rows) {
  const trigger = within(nav).getByRole('button', { name: /^Crest Suite\s*PRO$/ })
  expect(within(trigger).getByText('PRO')).toBeInTheDocument()
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(trigger)
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  rows.forEach(name => expect(within(nav).getByRole('link', { name })).toBeInTheDocument())
  expect(within(nav).queryByRole('link', { name: 'Group Console' })).not.toBeInTheDocument()
}

// The drawer shows it as a labelled group, open by default, with PRO in place of the item count.
function expectDrawerUpsell(nav, rows) {
  const header = within(nav).getByRole('button', { name: /^Crest Suite\s*PRO$/ })
  expect(within(header).getByText('PRO')).toBeInTheDocument()
  expect(header).toHaveAttribute('aria-expanded', 'true')
  rows.forEach(name => expect(within(nav).getByRole('link', { name })).toBeInTheDocument())
  expect(within(nav).queryByRole('link', { name: 'Group Console' })).not.toBeInTheDocument()
}

function expectNoSuiteGroup(nav) {
  expect(within(nav).queryByRole('button', { name: /Crest Suite/ })).not.toBeInTheDocument()
  ALL_ROWS.forEach(label => expect(within(nav).queryByRole('link', { name: startsWith(label) })).not.toBeInTheDocument())
}

// Both tab rows: the drawer has one and the desktop bar has one.
function moduleTabRows() {
  const rows = screen.getAllByRole('navigation', { name: 'Modules' })
  expect(rows).toHaveLength(2)
  return rows
}

beforeEach(() => {
  localStorage.clear()
  mockAuth = null
})

describe('an Owner without Crest Suite Pro, on an outlet with IMS, HR and POS', () => {
  beforeEach(() => { mockAuth = ownerOf({ suitePlan: null }) })

  it('has no Suite tab in either tab row', () => {
    renderShell()
    moduleTabRows().forEach(row => {
      ;['Home', 'IMS', 'HR', 'POS'].forEach(name => expect(within(row).getByRole('button', { name })).toBeInTheDocument())
      expect(within(row).queryByRole('button', { name: /Suite/ })).not.toBeInTheDocument()
    })
  })

  it.each([
    ['IMS', 'Crest IMS'],
    ['HR', 'Crest HR'],
    ['POS', 'Crest POS'],
  ])('sees the PRO Crest Suite group inside the %s panel, in the desktop bar and in the phone drawer', (tab, title) => {
    renderShell()
    openTab(tab)
    expectBarUpsell(barPanel(title), ALL_ROWS)
    expectDrawerUpsell(openDrawer(title), ALL_ROWS)
  })
})

describe('the same Owner with Crest Suite Pro', () => {
  beforeEach(() => { mockAuth = ownerOf({ suitePlan: 'pro' }) })

  it('has a Suite tab in both tab rows, and the module panels carry no Crest Suite group', () => {
    renderShell()
    moduleTabRows().forEach(row => expect(within(row).getByRole('button', { name: 'Suite' })).toBeInTheDocument())
    ;[['IMS', 'Crest IMS'], ['HR', 'Crest HR'], ['POS', 'Crest POS']].forEach(([tab, title]) => {
      openTab(tab)
      expectNoSuiteGroup(barPanel(title))
      expectNoSuiteGroup(openDrawer(title))
    })
  })

  it('opens the Suite tab onto its pages as plain links, with no Crest Suite menu inside it', () => {
    renderShell()
    openTab('Suite')
    expect(within(within(topBar()).getByRole('navigation', { name: 'Modules' })).getByRole('button', { name: 'Suite' }))
      .toHaveAttribute('aria-current', 'true')
    const bar = barPanel('Crest Suite')
    ALL_ROWS.forEach(name => expect(within(bar).getByRole('link', { name })).toBeInTheDocument())
    expect(within(bar).queryByRole('button', { name: /Crest Suite/ })).not.toBeInTheDocument()
    const drawer = openDrawer('Crest Suite')
    ALL_ROWS.forEach(label => expect(within(drawer).getByRole('link', { name: startsWith(label) })).toBeInTheDocument())
    expect(within(drawer).queryByRole('button', { name: /Crest Suite/ })).not.toBeInTheDocument()
  })
})

describe('an Owner without Crest Suite Pro, on an outlet with one module', () => {
  it.each([
    ['IMS', { ims: true, hr: false, pos: false }, 'Crest IMS', ALL_ROWS],
    ['HR', { ims: false, hr: true, pos: false }, 'Crest HR', OWNER_ROWS],
    ['POS', { ims: false, hr: false, pos: true }, 'Crest POS', OWNER_ROWS],
  ])('still sees the PRO Crest Suite group in the %s panel, and has no tab row at all', (_tab, modules, title, rows) => {
    mockAuth = ownerOf({ ...modules, suitePlan: null, plan: 'starter' })
    renderShell()
    // One module is one tab, and one tab is no tab row (Layout hides a lone tab).
    expect(screen.queryByRole('navigation', { name: 'Modules' })).not.toBeInTheDocument()
    expectBarUpsell(barPanel(title), rows)
    expectDrawerUpsell(openDrawer(title), rows)
  })
})
