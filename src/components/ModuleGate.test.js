/**
 * S862 ADD-7: a route whose module is off renders ModuleMissingCard in place, as the S683 rule had
 * promised all along. It was a silent bounce to /dashboard, so an Owner opening a bookmarked
 * Customization page after it was switched off (or, since S862, lapsed) was told nothing.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ModuleGate, { moduleGateOutcome } from './ModuleGate'

let mockAuth = {}
jest.mock('../context/AuthContext', () => ({ useAuth: () => mockAuth }))
jest.mock('./SupportContactLine', () => function MockSupportLine() { return null })

const DAY = 86400000
const isoDaysFromNow = n => new Date(Date.now() + n * DAY).toISOString()
const owner = (over = {}) => ({
  isAdmin: false, isOwner: true, imsEnabled: true, hrEnabled: false, posEnabled: true, customizationEnabled: true,
  canReachPosPath: () => true, profile: { clients: { pos_enabled: true, customization_enabled: true } },
  ...over,
})

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/customization/report" element={<ModuleGate module="customization"><p>Report page</p></ModuleGate>} />
        <Route path="/menu-pricing" element={<ModuleGate anyOf={['ims', 'pos']}><p>Menu pricing page</p></ModuleGate>} />
        <Route path="/hr/payroll" element={<ModuleGate module="hr"><p>Payroll page</p></ModuleGate>} />
        <Route path="/pos/kds" element={<p>Kitchen display</p>} />
        <Route path="/dashboard" element={<p>Dashboard</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('moduleGateOutcome', () => {
  it('lets the operator through whatever is switched on', () => {
    expect(moduleGateOutcome({ isAdmin: true }, ['customization'], '/customization/report')).toEqual({ kind: 'pass' })
  })

  it('names only the missing modules, and passes once any of them is on', () => {
    const auth = owner({ imsEnabled: false, posEnabled: false })
    expect(moduleGateOutcome(auth, ['ims', 'pos'], '/menu-pricing')).toEqual({ kind: 'missing', missing: ['ims', 'pos'] })
    expect(moduleGateOutcome(owner({ imsEnabled: false }), ['ims', 'pos'], '/menu-pricing')).toEqual({ kind: 'pass' })
    expect(moduleGateOutcome(owner({ customizationEnabled: false }), ['customization'], '/customization/groups'))
      .toEqual({ kind: 'missing', missing: ['customization'] })
  })

  it('sends a station team to its kitchen display before asking about the module', () => {
    const kitchen = owner({ isOwner: false, customizationEnabled: false, canReachPosPath: p => p === '/pos/kds' })
    expect(moduleGateOutcome(kitchen, ['customization'], '/customization/report')).toEqual({ kind: 'station' })
    expect(moduleGateOutcome(kitchen, ['pos'], '/pos/kds')).toEqual({ kind: 'pass' })
    // An HR route is no business of the station-team fence.
    expect(moduleGateOutcome(kitchen, ['hr'], '/hr/payroll')).toEqual({ kind: 'missing', missing: ['hr'] })
  })
})

describe('ModuleGate', () => {
  // S862 review: a failed outlet-row read reads every switch as off, which is not "not bought".
  it('says it could not check, rather than selling the module, when the outlet row did not load', () => {
    mockAuth = owner({ clientKnown: false, posEnabled: false, customizationEnabled: false, profile: { clients: null } })
    expect(moduleGateOutcome(mockAuth, ['customization'], '/customization/report')).toEqual({ kind: 'unknown' })
    renderAt('/customization/report')
    expect(screen.getByText('Could not check which modules are on for this outlet')).toBeInTheDocument()
    expect(screen.queryByText(/not on this subscription yet/)).toBeNull()
    expect(screen.queryByText('Report page')).toBeNull()
  })

  it('shows the card in place of a switched-off module, never the dashboard', () => {
    mockAuth = owner({ customizationEnabled: false, profile: { clients: { pos_enabled: true, customization_enabled: false } } })
    renderAt('/customization/report')
    expect(screen.getByText('This page needs Crest Customization')).toBeInTheDocument()
    expect(screen.getByText(/not on this subscription yet/)).toBeInTheDocument()
    expect(screen.getByText(/Ask us to switch it on/)).toBeInTheDocument()
    expect(screen.queryByText('Report page')).toBeNull()
    expect(screen.queryByText('Dashboard')).toBeNull()
  })

  it('says a lapsed Customization passed its paid-up date, rather than that it was never bought', () => {
    mockAuth = owner({
      customizationEnabled: false,
      profile: { clients: { pos_enabled: true, customization_enabled: true, customization_ends_at: isoDaysFromNow(-10) } },
    })
    renderAt('/customization/report')
    expect(screen.getByText(/has passed its paid-up date, so it is switched off for now/)).toBeInTheDocument()
    expect(screen.getByText(/Ask us to renew it/)).toBeInTheDocument()
    expect(screen.queryByText(/not on this subscription yet/)).toBeNull()
  })

  it('tells a staff login who can act, instead of offering to sell', () => {
    mockAuth = owner({ isOwner: false, hrEnabled: false })
    renderAt('/hr/payroll')
    expect(screen.getByText('This page needs Crest HR')).toBeInTheDocument()
    expect(screen.getByText(/ask the account owner/)).toBeInTheDocument()
    expect(screen.queryByText(/Ask us to switch it on/)).toBeNull()
  })

  it('says a route either module opens needs one or the other', () => {
    mockAuth = owner({ imsEnabled: false, posEnabled: false, hrEnabled: true })
    renderAt('/menu-pricing')
    expect(screen.getByText('This page needs Crest IMS or Crest POS')).toBeInTheDocument()
    expect(screen.getByText(/Crest IMS and Crest POS are not on this subscription yet/)).toBeInTheDocument()
  })

  it('still sends a kitchen login to its display, and renders the page when the module is on', () => {
    mockAuth = owner({ isOwner: false, canReachPosPath: p => p === '/pos/kds' })
    renderAt('/customization/report')
    expect(screen.getByText('Kitchen display')).toBeInTheDocument()

    mockAuth = owner()
    renderAt('/customization/report')
    expect(screen.getByText('Report page')).toBeInTheDocument()
  })
})
