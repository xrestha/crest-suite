import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// S852: after an outage the floor's notices could all stand at once and push the tables below the fold
// on a tablet. Two or more fold behind one summary line that names each of them, with a Show all that
// reveals them unchanged; one shows as it always did. Driven through the real floor view: bills waiting
// for Inventory (the Owner sees that banner) plus an offline order kept for another outlet.

// Every supabase call resolves through one table-aware stub: a chainable builder that records its
// calls and answers when awaited.
const mockCalls = []
let mockRespond = () => ({ data: null, error: null })
function mockBuilder(table, cols, opts) {
  const calls = [['select', [cols, opts]]]
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
    scopedFrom: (table, cols, opts) => mockBuilder(table, cols, opts),
    scopedInsert: (table, rows) => mockBuilder(table, rows),
    scopedUpsert: (table, rows) => mockBuilder(table, rows),
    scopedUpdate: (table, values) => mockBuilder(table, values),
    scopedDelete: table => mockBuilder(table),
  }),
}))
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    clientId: 'c1', profile: { id: 'p1', full_name: 'Sita', pos_role: null }, hasPosAccess: () => true,
    isAdmin: false, isOwner: true, imsEnabled: true, clientModules: { pos: true, ims: true }, hasFeature: () => true,
    customizationEnabled: false, outlets: [],
  }),
}))
jest.mock('../../../context/ThemeContext', () => ({
  useTheme: () => ({ colors: { amber: '#f59e0b', red: '#f87171', green: '#4ade80', accent: '#ff563c' } }),
}))
jest.mock('../../../shared/releaseWatch', () => ({ useReleaseReload: () => {} }))
jest.mock('../posChime', () => ({ playChime: () => {}, playGuestAlert: () => {}, soundBlocked: () => false }))
// The device's offline store holds one order taken for ANOTHER outlet, which this floor leaves alone.
// Plain functions, not jest.fn: CRA's resetMocks would wipe a jest.fn's implementation.
jest.mock('../../../utils/offlineQueue', () => {
  const actual = jest.requireActual('../../../utils/offlineQueue')
  const out = {}
  for (const [name, value] of Object.entries(actual)) {
    out[name] = typeof value === 'function' ? async () => null : value
  }
  out.getPosOrderQueue = async () => [{ order_id: 'q9', client_id: 'c2', table_id: null, items: [{ recipe_id: 'r1', name: 'Tea', qty: 1, unit_price: 50, vat_rate: 0.13 }] }]
  return out
})

// eslint-disable-next-line import/first
import PosOrders from './PosOrders'

const TABLE = { id: 't1', name: 'T1', section: '', status: 'available', capacity: 4, sort_order: 1 }

beforeEach(() => {
  mockCalls.length = 0
  mockRespond = (table, calls) => {
    const did = m => calls.some(([name]) => name === m)
    const head = calls.some(([, args]) => args?.[1]?.head)
    if (table === 'pos_tables') return { data: [TABLE], error: null }
    if (table === 'clients') return { data: { name: 'Test Outlet' }, error: null }
    if (table === 'settings') return { data: {}, error: null }
    // Three bills closed on this outlet are still waiting for Inventory; no credit note is.
    if (head) return { data: null, count: table === 'pos_orders' ? 3 : 0, error: null }
    if (did('maybeSingle') || did('single')) return { data: null, error: null }
    return { data: [], error: null }
  }
})

test('two floor notices fold behind one summary line until Show all is pressed', async () => {
  render(<MemoryRouter initialEntries={['/pos/orders']}><PosOrders /></MemoryRouter>)
  await screen.findByText('T1', {}, { timeout: 4000 })
  // The line names both, and says how many.
  const summary = await screen.findByText(/2 notices:/, {}, { timeout: 4000 })
  expect(summary.parentElement).toHaveTextContent('2 notices: 3 bills not in Inventory yet, 1 offline order for another outlet') // eslint-disable-line testing-library/no-node-access
  const toggle = screen.getByRole('button', { name: 'Show all' })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(toggle).toHaveAttribute('aria-controls', 'pos-floor-notices')
  // The notices themselves are on the page but folded away.
  const foreign = screen.getByText(/was taken for another outlet/)
  expect(foreign).not.toBeVisible()

  fireEvent.click(toggle)
  expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText(/was taken for another outlet/)).toBeVisible()
  // Each notice comes back as it was, its own action with it.
  await waitFor(() => expect(screen.getByRole('button', { name: /Post to Inventory/ })).toBeVisible())

  fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
  expect(screen.getByText(/was taken for another outlet/)).not.toBeVisible()
})

test('one floor notice shows as it always did, with no summary line', async () => {
  const respond = mockRespond
  // Nothing waits for Inventory: only the other outlet's offline order stands.
  mockRespond = (table, calls) => (calls.some(([, args]) => args?.[1]?.head) ? { data: null, count: 0, error: null } : respond(table, calls))
  render(<MemoryRouter initialEntries={['/pos/orders']}><PosOrders /></MemoryRouter>)
  await screen.findByText('T1', {}, { timeout: 4000 })
  expect(await screen.findByText(/was taken for another outlet/, {}, { timeout: 4000 })).toBeVisible()
  expect(screen.queryByText(/notices:/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument()
})
