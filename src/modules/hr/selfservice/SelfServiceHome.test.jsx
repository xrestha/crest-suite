/**
 * Crest Staff's first load (S859). The employee's own reads used to wait for AuthContext's profile,
 * which follows its own read with the client, flags and outlets: two round trips in series before
 * the roster or a payslip was even asked for. They now go out once there is a session. These pin
 * what must not change with that: the profile landing sends nothing twice, a login that is not a
 * Staff app one is never shown anything and is still sent away, an answer for another login is
 * dropped, and the refetch on coming back to the app still runs.
 */

import { render, screen, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import SelfServiceHome from './SelfServiceHome'
import { useAuth } from '../../../context/AuthContext'
import { isPushSubscribed } from '../../../utils/webPush'
import { BS_MONTHS } from '../../../utils/bsCalendar'

// Every RPC is answered by hand, so a test decides what lands and when.
const mockRpc = []
jest.mock('../../../supabaseClient', () => ({
  supabase: {
    rpc: (name, args) => new Promise(resolve => { mockRpc.push({ name, args, answer: resolve, answered: false }) }),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
  },
}))
jest.mock('../../../context/AuthContext', () => ({ useAuth: jest.fn() }))
jest.mock('../../../context/ThemeContext', () => ({ useTheme: () => ({ colors: { bg: '#111111' } }) }))
jest.mock('../../../utils/webPush', () => ({
  subscribeToPush: jest.fn(),
  unsubscribeFromPush: jest.fn(),
  isPushSubscribed: jest.fn(),
}))

const HOME_READS = ['get_my_roster', 'get_my_roster_published_days', 'get_my_swap_requests', 'get_my_hr_payslips', 'get_my_salary_payments']
const sessionFor = id => ({ user: { id } })
const employee = id => ({ id, role: 'client', full_name: 'Ananda Bhusal', client_id: 'c1', hr_self_service: true, hr_employee_id: `e-${id}`, clients: { name: 'Bloom Cafe' } })
const payslip = month => ({ id: `ps-${month}`, bs_year: 2083, bs_month: month, net_pay: 25000, full_name: 'Ananda Bhusal' })
const payslipLabel = month => `${BS_MONTHS[month - 1]} 2083`

function app() {
  return (
    <MemoryRouter initialEntries={['/hr/self-service']}>
      <Routes>
        <Route path="/hr/self-service" element={<SelfServiceHome />} />
        <Route path="/login" element={<p>sign-in page</p>} />
      </Routes>
    </MemoryRouter>
  )
}
function signedIn(auth) { useAuth.mockReturnValue(auth) }
const flush = () => act(() => Promise.resolve())

// Answers every call not yet answered (from index `from`), a payslip read with `slips`.
async function answerAll({ from = 0, slips = [], error = null } = {}) {
  await act(async () => {
    mockRpc.slice(from).filter(c => !c.answered).forEach(c => {
      c.answered = true
      if (error) c.answer({ data: null, error })
      else c.answer({ data: c.name === 'get_my_hr_payslips' ? slips : [], error: null })
    })
  })
}

beforeAll(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }) })
afterAll(() => { delete document.visibilityState })
// CRA's resetMocks clears implementations between tests, so this is re-declared per test.
beforeEach(() => { mockRpc.length = 0; isPushSubscribed.mockResolvedValue(false) })
afterEach(async () => { await answerAll() })

describe('opening Crest Staff', () => {
  it('asks for the week and the payslips as soon as there is a session, beside the profile read', async () => {
    signedIn({ session: sessionFor('u1'), profile: null, loading: true })
    render(app())
    await flush()
    expect(mockRpc.map(c => c.name)).toEqual(expect.arrayContaining(HOME_READS))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('does not ask again when the profile lands, and shows what the early reads brought', async () => {
    signedIn({ session: sessionFor('u1'), profile: null, loading: true })
    const view = render(app())
    await flush()
    await answerAll({ slips: [payslip(6)] })
    const sent = mockRpc.length

    signedIn({ session: sessionFor('u1'), profile: employee('u1'), loading: false })
    view.rerender(app())
    await flush()
    expect(mockRpc.length).toBe(sent)
    expect(screen.getByText(payslipLabel(6))).toBeInTheDocument()
  })

  it('never shows what was read for a login that has since changed', async () => {
    signedIn({ session: sessionFor('u1'), profile: null, loading: true })
    const view = render(app())
    await flush()
    const firstBatch = mockRpc.length

    // Another employee signs in on the same phone while the first one's reads are still out.
    signedIn({ session: sessionFor('u2'), profile: null, loading: true })
    view.rerender(app())
    await flush()
    expect(mockRpc.length).toBeGreaterThan(firstBatch)

    await act(async () => {
      mockRpc.slice(0, firstBatch).forEach(c => {
        c.answered = true
        c.answer({ data: c.name === 'get_my_hr_payslips' ? [payslip(5)] : [], error: null })
      })
    })
    signedIn({ session: sessionFor('u2'), profile: employee('u2'), loading: false })
    view.rerender(app())
    await flush()
    expect(screen.queryByText(payslipLabel(5))).not.toBeInTheDocument()

    await answerAll({ from: firstBatch, slips: [payslip(6)] })
    expect(screen.getByText(payslipLabel(6))).toBeInTheDocument()
    expect(screen.queryByText(payslipLabel(5))).not.toBeInTheDocument()
  })
})

describe('a login that is not a Staff app one', () => {
  it('opening the route cold: asks nothing more once the profile says so, and is still sent away', async () => {
    signedIn({ session: sessionFor('o1'), profile: null, loading: true })
    const view = render(app())
    await flush()
    const sent = mockRpc.length

    signedIn({ session: sessionFor('o1'), profile: { id: 'o1', role: 'client', client_id: 'c1', hr_self_service: false }, loading: false })
    view.rerender(app())
    await flush()
    await answerAll({ error: { message: 'self_service_blocked: your access to the Staff app has been turned off', code: '42501' } })
    expect(screen.getByText('sign-in page')).toBeInTheDocument()
    expect(mockRpc.length).toBe(sent)
  })

  it('already signed in: asks nothing at all, as before', async () => {
    signedIn({ session: sessionFor('o1'), profile: { id: 'o1', role: 'client', client_id: 'c1', hr_self_service: false }, loading: false })
    render(app())
    await flush()
    expect(mockRpc).toHaveLength(0)
    expect(screen.getByText('sign-in page')).toBeInTheDocument()
  })
})

describe('coming back to the app', () => {
  it('reads again when it is shown, as an installed app resumed from the home screen must', async () => {
    signedIn({ session: sessionFor('u1'), profile: employee('u1'), loading: false })
    render(app())
    await flush()
    await answerAll()
    const sent = mockRpc.length

    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(mockRpc.length).toBeGreaterThan(sent)
    expect(mockRpc.slice(sent).map(c => c.name)).toEqual(expect.arrayContaining(HOME_READS))
  })
})
