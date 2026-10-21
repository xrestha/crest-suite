import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// S854 (owner decisions): ONE Send on the order screen, with "Save, do not send yet" in the menu beside
// it; no KOT or BOT buttons; the kitchen note opens on a tap; Enter in the menu search adds the first
// dish shown; leaving with unsaved changes offers Send and go back, Leave without saving and Stay.
// Driven through the real floor and order screen, every read answered by one table-aware stub.

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
const MOMO = { id: 'r1', name: 'Momo', category: 'Food', recipe_code: 'F1', selling_price: 200, vat_rate: 0.13, me_class: null, is_veg: true }
const MANGO = { id: 'r2', name: 'Mango Lassi', category: 'Beverage', recipe_code: 'B1', selling_price: 150, vat_rate: 0.13, me_class: null, is_veg: true }

beforeEach(() => {
  mockCalls.length = 0
  mockRespond = (table, calls) => {
    const did = m => calls.some(([name]) => name === m)
    if (table === 'pos_tables') return { data: [TABLE], error: null }
    if (table === 'recipes' && String(calls[0][1][0]).includes('selling_price')) return { data: [MANGO, MOMO], error: null }
    if (table === 'clients') return { data: { name: 'Test Outlet' }, error: null }
    if (table === 'settings') return { data: {}, error: null }
    if (calls.some(([, args]) => args?.[1]?.head)) return { data: null, count: 0, error: null }
    if (did('maybeSingle') || did('single')) return { data: null, error: null }
    return { data: [], error: null }
  }
})

async function openNewOrder() {
  render(<MemoryRouter initialEntries={['/pos/orders']}><PosOrders /></MemoryRouter>)
  fireEvent.click(await screen.findByText('T1', {}, { timeout: 4000 }))
  // A free table asks for the guests first.
  const covers = await screen.findByRole('dialog', {}, { timeout: 4000 })
  fireEvent.click(within(covers).getByRole('button', { name: '2' }))
  fireEvent.click(within(covers).getByRole('button', { name: /open order/i }))
  return screen.findByRole('textbox', { name: 'Search the menu by dish name or code' }, { timeout: 4000 })
}

test('one Send, no KOT or BOT buttons, and Enter in the search adds the first dish shown', async () => {
  const search = await openNewOrder()
  expect(screen.queryByRole('button', { name: /^KOT/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /^BOT/ })).not.toBeInTheDocument()
  // "o" matches both dishes; the grid lists Mango Lassi first, so Enter adds it and clears the search.
  fireEvent.change(search, { target: { value: 'o' } })
  await screen.findByRole('button', { name: /Mango Lassi/ })
  fireEvent.keyDown(search, { key: 'Enter' })
  await waitFor(() => expect(search).toHaveValue(''))
  expect(screen.getByRole('button', { name: 'Add a kitchen note for Mango Lassi' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Send Order' })).toHaveAttribute('aria-keyshortcuts', 'Alt+S')
  // An empty search adds nothing.
  fireEvent.keyDown(search, { key: 'Enter' })
  expect(screen.getAllByRole('button', { name: /^Add a kitchen note for/ })).toHaveLength(1)
})

test('the kitchen note opens only on a tap, and holding is in the menu beside Send', async () => {
  const search = await openNewOrder()
  fireEvent.change(search, { target: { value: 'momo' } })
  await screen.findByRole('button', { name: /Momo/ })
  fireEvent.keyDown(search, { key: 'Enter' })
  expect(screen.queryByRole('textbox', { name: 'Note for Momo' })).not.toBeInTheDocument()
  fireEvent.click(await screen.findByRole('button', { name: 'Add a kitchen note for Momo' }))
  const note = screen.getByRole('textbox', { name: 'Note for Momo' })
  expect(note).toHaveFocus()
  // Left empty, it folds back to the link.
  fireEvent.blur(note)
  expect(await screen.findByRole('button', { name: 'Add a kitchen note for Momo' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'More ways to save this order' }))
  expect(screen.getByRole('menuitem', { name: 'Save, do not send yet' })).toBeInTheDocument()
})

test('leaving with unsaved changes offers Send and go back, Leave without saving and Stay', async () => {
  const search = await openNewOrder()
  fireEvent.change(search, { target: { value: 'momo' } })
  await screen.findByRole('button', { name: /Momo/ })
  fireEvent.keyDown(search, { key: 'Enter' })
  await screen.findByRole('button', { name: 'Add a kitchen note for Momo' })
  fireEvent.click(screen.getByRole('button', { name: '← T1' }))
  const ask = await screen.findByRole('dialog', { name: /unsaved change/ })
  expect(within(ask).getByRole('button', { name: 'Send and go back' })).toBeInTheDocument()
  expect(within(ask).getByRole('button', { name: 'Leave without saving' })).toBeInTheDocument()
  fireEvent.click(within(ask).getByRole('button', { name: 'Stay' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: /unsaved change/ })).not.toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: '← T1' }))
  fireEvent.click(within(await screen.findByRole('dialog', { name: /unsaved change/ })).getByRole('button', { name: 'Leave without saving' }))
  expect(await screen.findByText('T1', {}, { timeout: 4000 })).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: 'Search the menu by dish name or code' })).not.toBeInTheDocument()
})
