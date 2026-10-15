import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Owner decision (2026-10-15 audit): a floor refusal is a till notice, never window.alert, which froze
// the page (the guest-order chime and every poll) until OK. Driven through the real floor view: a tap on
// a table whose open-order check fails must refuse with the notice, the same words, and nothing else.

// Every supabase call resolves through one table-aware stub: a chainable builder that records its
// calls and answers when awaited.
const mockCalls = []
let mockRespond = () => ({ data: null, error: null })
function mockBuilder(table, cols) {
  const calls = [['select', [cols]]]
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (ok, bad) => {
          mockCalls.push({ table, calls })
          return Promise.resolve(mockRespond(table, calls)).then(ok, bad)
        }
      }
      return (...args) => { calls.push([prop, args]); return proxy }
    },
  })
  return proxy
}

jest.mock('../../../supabaseClient', () => ({
  supabase: {
    from: table => mockBuilder(table),
    rpc: (name, params) => mockBuilder(`rpc:${name}`, params),
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    channel: () => ({ on() { return this }, subscribe() { return this } }),
    removeChannel: () => {},
  },
}))
jest.mock('../../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({
    scopedFrom: (table, cols) => mockBuilder(table, cols),
    scopedInsert: (table, rows) => mockBuilder(table, rows),
    scopedUpsert: (table, rows) => mockBuilder(table, rows),
    scopedUpdate: (table, values) => mockBuilder(table, values),
    scopedDelete: table => mockBuilder(table),
  }),
}))
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    clientId: 'c1', profile: { id: 'p1', full_name: 'Sita', pos_role: null }, hasPosAccess: () => true,
    isAdmin: false, isOwner: true, imsEnabled: false, clientModules: { pos: true }, hasFeature: () => true,
    customizationEnabled: false, outlets: [],
  }),
}))
jest.mock('../../../context/ThemeContext', () => ({
  useTheme: () => ({ colors: { amber: '#f59e0b', red: '#f87171', green: '#4ade80', accent: '#ff563c' } }),
}))
jest.mock('../../../shared/releaseWatch', () => ({ useReleaseReload: () => {} }))
jest.mock('../posChime', () => ({ playChime: () => {}, playGuestAlert: () => {}, soundBlocked: () => false }))
// The device's offline store (IndexedDB) is empty: nothing queued, nothing cached. Plain functions,
// not jest.fn: CRA's resetMocks would wipe a jest.fn's implementation before the test runs.
jest.mock('../../../utils/offlineQueue', () => {
  const actual = jest.requireActual('../../../utils/offlineQueue')
  const out = {}
  for (const [name, value] of Object.entries(actual)) {
    out[name] = typeof value === 'function' ? async () => null : value
  }
  out.getPosOrderQueue = async () => []
  return out
})

// eslint-disable-next-line import/first
import PosOrders from './PosOrders'

const TABLE = { id: 't1', name: 'T1', section: '', status: 'available', capacity: 4, sort_order: 1 }
const DENIED = { message: 'permission denied for table pos_orders', code: '42501' }

beforeEach(() => {
  mockCalls.length = 0
  mockRespond = (table, calls) => {
    const did = m => calls.some(([name]) => name === m)
    if (table === 'pos_tables') return { data: [TABLE], error: null }
    if (table === 'clients') return { data: { name: 'Test Outlet' }, error: null }
    if (table === 'settings') return { data: {}, error: null }
    if (table === 'pos_orders' && did('maybeSingle')) return { data: null, error: DENIED }
    if (calls.some(([, args]) => args?.[1]?.head)) return { data: null, count: 0, error: null }
    if (did('maybeSingle') || did('single')) return { data: null, error: null }
    return { data: [], error: null }
  }
})

test('a table whose open-order check fails shows the till notice, never window.alert', async () => {
  const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {})
  render(<MemoryRouter initialEntries={['/pos/orders']}><PosOrders /></MemoryRouter>)
  const tile = await screen.findByText('T1', {}, { timeout: 4000 })
  fireEvent.click(tile)
  const notice = await waitFor(() => {
    const el = screen.getAllByRole('alert').find(a => a.textContent.includes('already has an open order'))
    if (!el) throw new Error('no till notice yet')
    return el
  })
  // The same words as the old pop-up, its blank line now a second line.
  expect(within(notice).getByText(/^Couldn't check whether T1 already has an open order\. /)).toHaveClass('action-error-text')
  expect(within(notice).getByText("Don't start a new order on this table until it loads — you may be re-ringing one that is already with the kitchen. Try again in a moment.")).toHaveClass('action-error-text')
  expect(notice.parentElement).toBe(document.body) // eslint-disable-line testing-library/no-node-access
  expect(alertSpy).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByText(/already has an open order/)).not.toBeInTheDocument()
  alertSpy.mockRestore()
})
