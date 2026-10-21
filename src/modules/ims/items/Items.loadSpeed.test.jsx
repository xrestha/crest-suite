import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// S855 (PERF-3): Item Master painted nothing until the usage scan had answered, and the scan is two
// serial levels (the item book, then `item_reference_counts`). The list now paints on its own read
// and Used In fills in after. These pin both halves: the rows show while the counts never answer,
// and every action that reads the counts stays safe in that window (Del refuses, no failure banner,
// the Unused filter stays shut, a new code is not minted from the filtered list).

// Every supabase call resolves through one table-aware stub: a chainable builder that records its
// calls and answers when awaited (the PosOrders.loadSpeed.test.jsx pattern).
const mockCalls = []
let mockRespond = () => ({ data: null, error: null })
function mockBuilder(table, first) {
  const calls = [['select', [first]]]
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
  useAuth: () => ({ clientId: 'c1', isAdmin: false, hasImsAccess: () => true }),
}))
// No `settingsClientId`, so the outlet's VAT basis reads as unknown and the VAT price review stays out.
jest.mock('../../../context/SettingsContext', () => ({
  useSettings: () => ({ settings: { item_code_prefix: 'ITM' } }),
}))

// eslint-disable-next-line import/first
import Items from './Items'

const MILK = {
  id: 'i1', name: 'MILK', item_code: 'ITM-001', category_id: 'cat1', categories: { name: 'Dairy' },
  uom: 'ML', rate: 0.1, per_uom_rate: 0.1, yield_pct: 100, purchase_unit: null, conversion_factor: 1,
  is_active: true, is_sub_recipe: false,
}

const firstArg = calls => calls[0][1][0]
const isBookRead = (table, calls) => table === 'items' && firstArg(calls) === 'id, name, is_sub_recipe, item_code'
const isCodeRead = (table, calls) => table === 'items' && firstArg(calls) === 'id, item_code'
const isInsert = (table, calls) => table === 'items' && typeof firstArg(calls) === 'object' && firstArg(calls) !== null
const never = () => new Promise(() => {})

let answerCounts = never
let answerBook = () => ({ data: [{ id: 'i1', name: 'MILK', is_sub_recipe: false, item_code: 'ITM-001' }], error: null })

beforeEach(() => {
  mockCalls.length = 0
  answerCounts = never
  answerBook = () => ({ data: [{ id: 'i1', name: 'MILK', is_sub_recipe: false, item_code: 'ITM-001' }], error: null })
  mockRespond = (table, calls) => {
    if (table === 'rpc:item_reference_counts') return answerCounts()
    if (isBookRead(table, calls)) return answerBook()
    // The whole book, a sub-recipe mirror's code included: the list below never shows it.
    if (isCodeRead(table, calls)) return { data: [{ id: 'i1', item_code: 'ITM-001' }, { id: 'm1', item_code: 'ITM-007' }], error: null }
    if (isInsert(table, calls)) return { data: { id: 'i9' }, error: null }
    if (table === 'items') return { data: [MILK], error: null }
    if (table === 'categories') return { data: [{ id: 'cat1', name: 'Dairy', sort_order: 0 }], error: null }
    return { data: [], error: null }
  }
})

const renderItems = () => render(<MemoryRouter><Items /></MemoryRouter>)

test('the list paints while the usage counts have not answered, and Del refuses without a failure banner', async () => {
  renderItems()
  await screen.findByText('MILK')
  // The counts were asked for, and have not answered.
  expect(mockCalls.some(c => c.table === 'rpc:item_reference_counts')).toBe(true)
  expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  // Used In says it is coming: not a dash ("no records"), not "not checked" (a failure).
  expect(screen.getByText('checking…')).toBeInTheDocument()
  expect(screen.queryByText('not checked')).not.toBeInTheDocument()
  expect(screen.getByText('Checking where items are used…')).toBeInTheDocument()
  expect(screen.queryByText(/could not check where these items are used/)).not.toBeInTheDocument()
  // The Unused filter stays shut rather than listing every item.
  expect(screen.getByRole('button', { name: /Unused/ })).toBeDisabled()

  const del = screen.getByRole('button', { name: 'Delete MILK' })
  expect(del).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(del)
  expect(await screen.findByText('Still checking where "MILK" is used. Try again in a moment.')).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('once the counts land, Used In fills in, Del opens and the waiting message comes down', async () => {
  let release
  answerCounts = () => new Promise(resolve => { release = () => resolve({ data: [], error: null }) })
  renderItems()
  await screen.findByText('MILK')
  fireEvent.click(screen.getByRole('button', { name: 'Delete MILK' }))
  await screen.findByText(/Still checking where "MILK" is used/)

  await waitFor(() => expect(release).toBeDefined())
  release()
  await waitFor(() => expect(screen.queryByText(/Still checking where "MILK" is used/)).not.toBeInTheDocument())
  expect(screen.queryByText('checking…')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Delete MILK' })).not.toHaveAttribute('aria-disabled')
  expect(screen.getByRole('button', { name: /Unused/ })).not.toBeDisabled()
})

test('a failed count shows the failure banner and keeps Del refusing', async () => {
  answerCounts = () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
  renderItems()
  await screen.findByText(/could not check where these items are used/)
  expect(screen.getByText('not checked')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Delete MILK' }))
  expect(await screen.findByText(/Crest could not check where "MILK" is used/)).toBeInTheDocument()
})

test('an Add before the item book lands reads the codes fresh, never minting from the filtered list', async () => {
  answerBook = never
  renderItems()
  await screen.findByText('MILK')
  fireEvent.click(screen.getByRole('button', { name: '+ Add Item' }))
  fireEvent.change(screen.getByLabelText(/Item Name/), { target: { value: 'butter' } })
  fireEvent.change(screen.getByLabelText(/Price per GM/), { target: { value: '1.2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add Item' }))
  await waitFor(() => expect(mockCalls.some(c => isInsert(c.table, c.calls))).toBe(true))
  const insert = mockCalls.find(c => isInsert(c.table, c.calls))
  // The list holds only ITM-001; the fresh read also sees the mirror's ITM-007.
  expect(firstArg(insert.calls)).toMatchObject({ name: 'BUTTER', item_code: 'ITM-008' })
  expect(mockCalls.some(c => isCodeRead(c.table, c.calls))).toBe(true)
})
