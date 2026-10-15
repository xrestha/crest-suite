import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// S847 (/impeccable optimize: POS slow on a poor connection). On a slow link the round trips are the
// cost, so these count the reads, as subRecipeUsage.test.js does: guest orders and today's bookings go
// with the floor's read rather than after it, the menu is read behind the floor before any table is
// tapped, and opening a table does not read a menu read within the minute again.

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
const DISH = { id: 'r1', name: 'Momo', category: 'Food', recipe_code: 'F1', selling_price: 200, vat_rate: 0.13, me_class: null, is_veg: true }

const menuReads = () => mockCalls.filter(c => c.table === 'recipes' && String(c.calls[0][1][0]).includes('selling_price'))
const reads = table => mockCalls.filter(c => c.table === table)
let releaseTables = () => {}

beforeEach(() => {
  mockCalls.length = 0
  const tablesAnswer = new Promise(resolve => { releaseTables = () => resolve({ data: [TABLE], error: null }) })
  mockRespond = (table, calls) => {
    const did = m => calls.some(([name]) => name === m)
    if (table === 'pos_tables') return tablesAnswer
    if (table === 'recipes' && String(calls[0][1][0]).includes('selling_price')) return { data: [DISH], error: null }
    if (table === 'clients') return { data: { name: 'Test Outlet' }, error: null }
    if (table === 'settings') return { data: {}, error: null }
    if (calls.some(([, args]) => args?.[1]?.head)) return { data: null, count: 0, error: null }
    if (did('maybeSingle') || did('single')) return { data: null, error: null }
    return { data: [], error: null }
  }
})

test("guest orders and today's bookings are asked with the floor, not after it", async () => {
  render(<MemoryRouter initialEntries={['/pos/orders']}><PosOrders /></MemoryRouter>)
  // The floor's tables have not answered yet, and both reads are already out.
  await waitFor(() => expect(reads('pos_guest_order_requests').length).toBeGreaterThan(0))
  await waitFor(() => expect(reads('pos_reservations').length).toBeGreaterThan(0))
  expect(screen.queryByText('T1')).not.toBeInTheDocument()
  // Nor is the menu: it waits for the floor, which the waiter is looking at.
  expect(menuReads()).toHaveLength(0)
  releaseTables()
  await screen.findByText('T1', {}, { timeout: 4000 })
})

test('the menu is read behind the floor, once, and a table opened within the minute does not read it again', async () => {
  render(<MemoryRouter initialEntries={['/pos/orders']}><PosOrders /></MemoryRouter>)
  releaseTables()
  const tile = await screen.findByText('T1', {}, { timeout: 4000 })
  await waitFor(() => expect(menuReads()).toHaveLength(1))
  const openReadsBefore = reads('pos_orders').filter(c => c.calls.some(([name]) => name === 'maybeSingle')).length
  fireEvent.click(tile)
  // The tap's own read: whether this table already has an open order.
  await waitFor(() => expect(reads('pos_orders').filter(c => c.calls.some(([name]) => name === 'maybeSingle')).length).toBeGreaterThan(openReadsBefore))
  await new Promise(r => setTimeout(r, 50))
  expect(menuReads()).toHaveLength(1)
})
