// A stock-count PIN login reaches Stock Count and Help and nothing else (S737), and the shell must
// not OFFER it anything else either. S856's live check on a real storeroom phone found the drawer
// listing "Inventory Dashboard": the Dashboard row and the top-bar pill were the two nav renders
// that skipped isItemVisible, so a count login saw a link ProtectedRoute only bounced back.
import fs from 'fs'
import path from 'path'
import { imsCountPathReachable, IMS_COUNT_HOME, IMS_COUNT_LOGIN, IMS_COUNT_DEVICE_KEY, isCountDevice } from './imsCountAccess'

describe('imsCountPathReachable', () => {
  test('a count login reaches Stock Count and Help only', () => {
    expect(imsCountPathReachable(true, '/stock')).toBe(true)
    expect(imsCountPathReachable(true, '/help')).toBe(true)
    for (const p of ['/dashboard', '/ims/dashboard', '/purchases', '/sales', '/periods']) {
      expect(imsCountPathReachable(true, p)).toBe(false)
    }
  })

  test('every other login reaches everything', () => {
    expect(imsCountPathReachable(false, '/dashboard')).toBe(true)
    expect(imsCountPathReachable(false, '/purchases')).toBe(true)
  })

  test('home is Stock Count and the door is the PIN screen', () => {
    expect(IMS_COUNT_HOME).toBe('/stock')
    expect(IMS_COUNT_LOGIN).toBe('/ims/count')
  })
})

describe('isCountDevice (S856)', () => {
  afterEach(() => localStorage.clear())

  test('true only once the device was set up from the QR', () => {
    expect(isCountDevice()).toBe(false)
    localStorage.setItem(IMS_COUNT_DEVICE_KEY, 'c-1')
    expect(isCountDevice()).toBe(true)
  })

  test('the PIN screen writes the same key the guard reads', () => {
    const login = fs.readFileSync(path.join(__dirname, '..', 'modules', 'ims', 'count', 'ImsCountLogin.jsx'), 'utf8')
    expect(login).toMatch(/const LS_CLIENT = IMS_COUNT_DEVICE_KEY/)
  })
})

describe('Layout offers the Dashboard link only through isItemVisible (S856)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'components', 'Layout.js'), 'utf8')

  test('the drawer row', () => {
    expect(src).toMatch(/function renderDashboardRow\(\) \{\s*return isItemVisible\(dashNavItem\) \?/)
  })

  test('the top-bar pill', () => {
    expect(src).toMatch(/isItemVisible\(dashNavItem\) && renderBarPill\(dashNavItem/)
    expect(src).not.toMatch(/\(!homeIsOverview \|\| panel === 'admin'\) && renderBarPill\(dashNavItem/)
  })
})

// S856 (owner decision): a counting tablet shows no plan name and no days left, in the top bar or the
// drawer. The counter cannot act on either.
describe('Layout hides the plan and the days left from a count login (S856)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'components', 'Layout.js'), 'utf8')

  test('top bar: the days-left chip and the plan name', () => {
    expect(src).toMatch(/\{!imsCountOnly && subStatusBadge\(/)
    expect(src).toMatch(/\{!isAdmin && !imsCountOnly && clientName && \(/)
  })

  test('drawer: the plan beside Property, and the days-left chip', () => {
    expect(src).toMatch(/Property\s*\{!imsCountOnly && <>/)
    expect(src).toMatch(/\{!outletDropdownOpen && !imsCountOnly && \(\(\) => \{/)
  })
})
