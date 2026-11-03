import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import OptionGroups from './OptionGroups'

jest.mock('../../supabaseClient', () => ({ supabase: {} }))

let mockAuth = null
jest.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth }))
jest.mock('../../context/SettingsContext', () => {
  const SETTINGS = { loading: false, settingsLoadError: null, settingsClientId: 'c1', settings: { is_vat_registered: true } }
  return { useSettings: () => SETTINGS }
})

// Writes record what they were asked to do and wait on `mockHold`, so a test can look at the page
// while a move is in flight.
const mockWrites = []
let mockHold = null
jest.mock('../../shared/hooks/useScopedDb', () => {
  const chain = table => {
    const q = { _table: table, order: () => q, eq: () => q, or: () => q }
    return q
  }
  // One object for every render: the page's loader depends on these functions' identity.
  const db = {
    scopedFrom: table => chain(table),
    scopedUpdate: (table, row) => {
      const q = {
        eq: (_col, id) => { q.id = id; return q },
        select: () => {
          mockWrites.push({ table, row, id: q.id })
          return (mockHold || Promise.resolve()).then(() => ({ data: [{ id: q.id }], error: null }))
        },
      }
      return q
    },
    scopedDelete: () => chain('x'),
    scopedInsert: () => Promise.resolve({ data: null, error: null }),
    scopedUpsert: () => Promise.resolve({ data: null, error: null }),
  }
  return { useScopedDb: () => db }
})

let mockRecipes = []
jest.mock('../../shared/fetchAllRows', () => ({
  ...jest.requireActual('../../shared/fetchAllRows'),
  fetchAllRows: makeQuery => {
    const q = makeQuery()
    return Promise.resolve({ data: q._table === 'recipes' ? mockRecipes : [], error: null })
  },
}))

const mockCatalog = jest.fn()
jest.mock('./customizationData', () => ({
  ...jest.requireActual('./customizationData'),
  loadOptionCatalog: (...args) => mockCatalog(...args),
}))

const deferred = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

const extras = { id: 'g1', name: 'Extras', kind: 'addon', min_select: 0, max_select: null, included_count: 0, is_active: true, sort: 0 }
const opt = (id, name, sort, extra = {}) => ({
  id, group_id: 'g1', name, sort, price_delta: 0, is_removal: false, is_default: false, is_active: true, allergens: [], ...extra,
})
const catalogOf = options => ({
  error: null,
  groups: [extras],
  options,
  attachments: [{ id: 'a1', recipe_id: 'd1', group_id: 'g1', sort: 0 }],
  ingredients: [],
  buildYourOwn: [],
})
const momo = { id: 'd1', name: 'Veg Momo', category: 'Momo', selling_price: 200, vat_rate: 0.13, pos_enabled: true, is_active: true }

beforeEach(() => {
  mockAuth = { isAdmin: false, isOwner: true, profile: {}, clientId: 'c1', clientModules: { ims: false, customization: true } }
  mockRecipes = [momo]
  mockHold = null
  mockWrites.length = 0
  mockCatalog.mockReset()
})

it('S863: the pressed arrow stays enabled and busy until the reload lands, then focus follows the row', async () => {
  mockCatalog.mockResolvedValueOnce(catalogOf([opt('o1', 'First', 0), opt('o2', 'Second', 1), opt('o3', 'Third', 2)]))
  render(<OptionGroups />)
  const down = await screen.findByRole('button', { name: 'Move Second down' })
  expect(down).toHaveAttribute('title', 'Move Second down')

  const write = deferred()
  mockHold = write.promise
  down.focus()
  fireEvent.click(down)
  expect(mockWrites).toHaveLength(2)
  expect(down).not.toBeDisabled()
  expect(down).toHaveAttribute('aria-busy', 'true')
  expect(screen.getByRole('button', { name: 'Move First down' })).toBeDisabled()

  // A second press mid-write is dropped, not written again.
  fireEvent.click(down)
  expect(mockWrites).toHaveLength(2)

  const reload = deferred()
  mockCatalog.mockReturnValueOnce(reload.promise)
  await act(async () => { write.resolve() })
  await waitFor(() => expect(mockCatalog).toHaveBeenCalledTimes(2))

  // The write has landed but the list has not reloaded: the arrows must stay locked on the old order.
  expect(down).toHaveAttribute('aria-busy', 'true')
  expect(screen.getByRole('button', { name: 'Move First down' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Move First down' }))
  expect(mockWrites).toHaveLength(2)

  await act(async () => { reload.resolve(catalogOf([opt('o1', 'First', 0), opt('o3', 'Third', 1), opt('o2', 'Second', 2)])) })
  // Second is last now, so its down arrow is disabled and focus moves to its up arrow.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Move Second down' })).toBeDisabled())
  expect(screen.getByRole('button', { name: 'Move Second up' })).toHaveFocus()
  expect(screen.getByRole('button', { name: 'Move First down' })).not.toBeDisabled()
})

it('S863: the tabs name their counts as a phrase and point at a panel that exists', async () => {
  mockCatalog.mockResolvedValueOnce(catalogOf([opt('o1', 'First', 0)]))
  render(<OptionGroups />)
  // jsdom spaces the hidden comma as a block ("Groups , 1"); either way the count is its own phrase.
  const groups = await screen.findByRole('tab', { name: /^Groups ?, 1$/ })
  const dishes = screen.getByRole('tab', { name: /^Dishes ?, 1 of 1 offer choices$/ })
  const panel = screen.getByRole('tabpanel')
  expect(groups).toHaveAttribute('aria-controls', panel.id)
  expect(dishes).toHaveAttribute('aria-controls', panel.id)
  expect(panel).toHaveAccessibleName(/^Groups ?, 1$/)
})

it('S863: with no dish yet, Put it on dishes stays pressable and says what is missing', async () => {
  mockRecipes = []
  mockCatalog.mockResolvedValueOnce(catalogOf([opt('o1', 'First', 0)]))
  render(<OptionGroups />)
  const put = await screen.findByRole('button', { name: 'Put it on dishes' })
  expect(put).not.toBeDisabled()
  expect(put).toHaveAttribute('aria-disabled', 'true')
  expect(put).toHaveAccessibleDescription('Extras')
  fireEvent.click(put)
  expect(screen.getByRole('alert')).toHaveTextContent('Make a dish first in Recipe Costing (or Menu Pricing on a POS-only plan), then put “Extras” on it.')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('S863: only a priced choice with no ingredients is flagged amber', async () => {
  mockAuth = { ...mockAuth, clientModules: { ims: true, customization: true } }
  mockCatalog.mockResolvedValueOnce(catalogOf([opt('o1', 'Extra cheese', 0, { price_delta: 40 }), opt('o2', 'Hot', 1)]))
  render(<OptionGroups />)
  await screen.findByRole('button', { name: 'Move Hot up' })
  // The warning mark rides on the priced choice only; the free one reads plainly.
  expect(within(screen.getByRole('row', { name: /^↑ ↓ Extra cheese/ })).getAllByText('△ No ingredients').length).toBeGreaterThan(0)
  const hot = within(screen.getByRole('row', { name: /^↑ ↓ Hot/ }))
  expect(hot.queryByText('△ No ingredients')).not.toBeInTheDocument()
  expect(hot.getByText('No ingredients')).toBeInTheDocument()
})

it('S863: the Dishes tab button for a dish with no choices is named for its visible words', async () => {
  mockCatalog.mockResolvedValueOnce({ ...catalogOf([opt('o1', 'First', 0)]), attachments: [] })
  render(<OptionGroups />)
  fireEvent.click(await screen.findByRole('tab', { name: /^Dishes/ }))
  expect(screen.getByRole('button', { name: 'Add choices for Veg Momo' })).toHaveTextContent('Add choices')
})
