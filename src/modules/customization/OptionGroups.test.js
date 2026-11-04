import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import OptionGroups from './OptionGroups'

jest.mock('../../supabaseClient', () => ({ supabase: {} }))

let mockAuth = null
jest.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth }))
// One object per test, so the page sees a stable settings row until a test swaps it (S867).
const SETTLED = { loading: false, settingsLoadError: null, settingsClientId: 'c1', settings: { is_vat_registered: true } }
let mockSettings = SETTLED
jest.mock('../../context/SettingsContext', () => ({ useSettings: () => mockSettings }))

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
    scopedDelete: table => {
      const q = {
        eq: (_col, id) => { q.id = id; return q },
        select: () => {
          mockWrites.push({ table, deleted: q.id })
          return Promise.resolve({ data: [{ id: q.id }], error: null })
        },
      }
      return q
    },
    // The insert hands back the row it wrote, as scopedInsert's .select() does.
    scopedInsert: (table, row) => Promise.resolve({ data: [{ id: 'g-new', ...row }], error: null }),
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
  mockSettings = SETTLED
  mockRecipes = [momo]
  mockHold = null
  mockWrites.length = 0
  mockCatalog.mockReset()
})

it('S863/S869: the pressed arrow stays busy until the writes answer, then the new order is on screen before the re-read lands', async () => {
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

  // A second press mid-write is dropped, not written again: the arrows never go live on the old order.
  fireEvent.click(down)
  expect(mockWrites).toHaveLength(2)

  // S869 (owner decision): once both writes answer, the order they wrote is on screen and the arrows
  // unlock on it, while the re-read is still out.
  const reread = deferred()
  mockCatalog.mockReturnValueOnce(reread.promise)
  await act(async () => { write.resolve() })
  await waitFor(() => expect(mockCatalog).toHaveBeenCalledTimes(2))
  // Second is last now, so its down arrow is disabled and focus moves to its up arrow.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Move Second down' })).toBeDisabled())
  expect(screen.getByRole('button', { name: 'Move Second up' })).toHaveFocus()
  expect(screen.getByRole('button', { name: 'Move First down' })).not.toBeDisabled()
  expect(screen.getByRole('button', { name: 'Move Third down' })).not.toBeDisabled()

  // The re-read agrees, and changes nothing on screen.
  await act(async () => { reread.resolve(catalogOf([opt('o1', 'First', 0), opt('o3', 'Third', 1), opt('o2', 'Second', 2)])) })
  expect(screen.getByRole('button', { name: 'Move Second down' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Move Second up' })).toHaveFocus()
})

it('S869: a re-read that fails after a move keeps the moved order on screen instead of the load error', async () => {
  mockCatalog.mockResolvedValueOnce(catalogOf([opt('o1', 'First', 0), opt('o2', 'Second', 1)]))
  render(<OptionGroups />)
  const down = await screen.findByRole('button', { name: 'Move First down' })
  const quiet = jest.spyOn(console, 'error').mockImplementation(() => {})
  mockCatalog.mockResolvedValueOnce({ error: { message: 'connection reset', code: '08006' }, groups: [], options: [], attachments: [], ingredients: [], buildYourOwn: [] })
  await act(async () => { fireEvent.click(down) })
  await waitFor(() => expect(mockCatalog).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(quiet).toHaveBeenCalledWith(expect.stringMatching(/re-check after a change failed/), expect.anything()))
  expect(screen.getByRole('button', { name: 'Move First down' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Move Second down' })).not.toBeDisabled()
  quiet.mockRestore()
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

// ── S867 ──

const groupOf = (id, name, kind, extra = {}) => ({
  id, name, kind, min_select: kind === 'addon' ? 0 : 1, max_select: kind === 'addon' ? null : 1,
  included_count: 0, is_active: true, sort: 0, size_scaling: 'none', ...extra,
})

it('S867: each card wears its next step as its one primary button, and a Size group goes on its dishes first', async () => {
  mockCatalog.mockResolvedValueOnce({
    error: null,
    groups: [groupOf('gs', 'Size', 'size'), groupOf('g1', 'Extras', 'addon'), groupOf('gp', 'Spice', 'choice')],
    // Extras has a choice and a dish; Size and Spice have neither.
    options: [opt('o1', 'Extra cheese', 0)],
    attachments: [{ id: 'a1', recipe_id: 'd1', group_id: 'g1', sort: 0 }],
    ingredients: [],
    buildYourOwn: [],
  })
  render(<OptionGroups />)
  await screen.findByRole('heading', { name: 'Size' })

  // Size, on no dish and with no sizes: its dishes come first.
  const size = within(screen.getByRole('region', { name: 'Size' }))
  expect(size.getByRole('button', { name: 'Put it on dishes' })).toHaveClass('btn-primary')
  expect(size.getByRole('button', { name: '+ Choice' })).toHaveClass('btn-ghost')
  expect(size.getByText('Not on any dish')).toHaveClass('badge-amber')

  // Any other kind with nothing in it: its choices come first.
  const spice = within(screen.getByRole('region', { name: 'Spice' }))
  expect(spice.getByText('Preference')).toBeInTheDocument()
  expect(spice.getByRole('button', { name: '+ Choice' })).toHaveClass('btn-primary')
  expect(spice.getByRole('button', { name: 'Put it on dishes' })).toHaveClass('btn-ghost')

  // A group with both has no step left, so no accent and no amber badge.
  const extras = within(screen.getByRole('region', { name: 'Extras' }))
  expect(extras.getByRole('button', { name: '+ Choice' })).toHaveClass('btn-ghost')
  expect(extras.getByRole('button', { name: 'Put it on dishes' })).toHaveClass('btn-ghost')
  expect(extras.queryByText('Not on any dish')).not.toBeInTheDocument()
  expect(extras.getByText('On 1 dish')).toBeInTheDocument()

  // The header add button is the shared Fab, and the card list keeps the phone clearance.
  expect(screen.getByRole('button', { name: '+ New Group' })).toHaveClass('fab')
  expect(screen.getByRole('region', { name: 'Extras' }).parentElement).toHaveClass('fab-clear') // eslint-disable-line testing-library/no-node-access
})

it('S867: a ticket name that only repeats the choice is not shown under it', async () => {
  mockCatalog.mockResolvedValueOnce(catalogOf([
    opt('o1', 'Regular', 0, { kitchen_name: ' regular ' }),
    opt('o2', 'Large', 1, { kitchen_name: 'LG' }),
  ]))
  render(<OptionGroups />)
  await screen.findByRole('button', { name: 'Move Large up' })
  expect(screen.queryByText(/^Ticket:\s*regular$/i)).not.toBeInTheDocument()
  expect(screen.getByText('Ticket: LG')).toBeInTheDocument()
})

it('S867: "first N free" is explained on the rule, not in a paragraph on the card', async () => {
  mockCatalog.mockResolvedValueOnce({ ...catalogOf([opt('o1', 'Granola', 0)]), groups: [{ ...extras, max_select: 3, included_count: 2 }] })
  render(<OptionGroups />)
  const rule = await screen.findByText('Optional · up to 3 · first 2 free')
  fireEvent.focus(rule.closest('.tip-trigger')) // eslint-disable-line testing-library/no-node-access
  expect(screen.getByRole('tooltip')).toHaveTextContent(/^The first 2 choices a guest makes are free: the earliest in this list among what they picked, not the cheapest\./)
  expect(screen.queryByText(/The first 2 picks/)).not.toBeInTheDocument()
})

it('S867: with no client picked, the page says so instead of loading for good, and shows neither banner', async () => {
  mockAuth = { ...mockAuth, isAdmin: true, isOwner: false, clientId: null, clientModules: { ims: false, customization: false } }
  mockSettings = { loading: false, settingsLoadError: null, settingsClientId: null, settings: {} }
  render(<OptionGroups />)
  expect(screen.getByRole('heading', { name: 'Choice Groups' })).toBeInTheDocument()
  expect(screen.getByText('No client selected. Pick a client in the top-left switcher to see its choice groups.')).toBeInTheDocument()
  expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  expect(screen.queryByText(/Crest Customization is off/)).not.toBeInTheDocument()
  expect(screen.queryByText(/cannot be changed right now/)).not.toBeInTheDocument()
  expect(mockCatalog).not.toHaveBeenCalled()
})

it('S867: "Choice prices cannot be changed" waits for this client’s settings, and shows when that read failed', async () => {
  mockCatalog.mockResolvedValue(catalogOf([opt('o1', 'First', 0)]))
  // A client switch: the row on hand is still the previous client's, so the mode is not known yet.
  mockSettings = { ...SETTLED, settingsClientId: 'c0' }
  const { rerender } = render(<OptionGroups />)
  await screen.findByRole('button', { name: 'Edit First' })
  expect(screen.queryByText(/cannot be changed right now/)).not.toBeInTheDocument()

  // This client's read came back as a failure: now it is a fact worth a banner.
  mockSettings = { ...SETTLED, settingsLoadError: { message: 'boom' } }
  rerender(<OptionGroups />)
  expect(screen.getByText('Choice prices cannot be changed right now.')).toBeInTheDocument()
  expect(screen.getByText(/A choice whose price is left as it is still saves\./)).toBeInTheDocument()
})

// S877: a choice stock line on a recipe moved out of Sub-Recipe (before the recategorise guard) opens
// showing that recipe, labelled, instead of a blank box; it is not offered for a new line.
it('S877: a stock line on a recipe no longer a sub-recipe opens showing it, and only on that line', async () => {
  mockAuth = { ...mockAuth, clientModules: { ims: true, customization: true } }
  const dough = { id: 'dough', name: 'Pizza Dough', category: 'Bakery', selling_price: 0, vat_rate: 0.13, pos_enabled: false, yield_uom: 'kg', is_active: true }
  mockRecipes = [momo, dough]
  mockCatalog.mockResolvedValue({
    ...catalogOf([opt('o1', 'Thin base', 0)]),
    ingredients: [{ id: 'l1', option_id: 'o1', item_id: null, sub_recipe_id: 'dough', qty_per_portion: 0.2 }],
  })
  render(<OptionGroups />)
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Thin base' }))
  expect(await screen.findByText('Pizza Dough (kg) — no longer a sub-recipe')).toBeInTheDocument()
  expect(screen.getByText(/Pizza Dough is no longer a sub-recipe, so it is not offered for a new line, but this line still adds 0\.2 kg of it on every plate sold\./)).toBeInTheDocument()
})

it('S867: a new Size group is told to go on its dishes first, and the one + New Group is the empty state’s', async () => {
  mockCatalog.mockResolvedValue({ ...catalogOf([]), groups: [], attachments: [] })
  render(<OptionGroups />)
  await screen.findByText('No choice groups yet.')
  expect(screen.getByText('Put a Size group on its dishes before you add its sizes, so each size takes its full menu price.')).toBeInTheDocument()
  const adds = screen.getAllByRole('button', { name: '+ New Group' })
  expect(adds).toHaveLength(1)
  expect(adds[0]).toHaveClass('btn-primary')
  expect(adds[0]).not.toHaveClass('fab')

  fireEvent.click(adds[0])
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Portion' } })
  fireEvent.click(screen.getByRole('radio', { name: /^Size/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
  expect(await screen.findByText('“Portion” was created. Put it on its dishes first, so each size takes its full menu price.')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Put it on dishes →' }))
  expect(await screen.findByRole('dialog', { name: 'Offer “Portion” on…' })).toBeInTheDocument()
})

it('S867: a new group of any other kind is told to add its choices', async () => {
  mockCatalog.mockResolvedValue({ ...catalogOf([]), groups: [], attachments: [] })
  render(<OptionGroups />)
  fireEvent.click(await screen.findByRole('button', { name: '+ New Group' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Extras' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
  expect(await screen.findByText('“Extras” was created. Now add its choices with + Choice.')).toBeInTheDocument()
})

it('S867: deleting a choice says it was deleted', async () => {
  mockCatalog.mockResolvedValue(catalogOf([opt('o1', 'Regular', 0)]))
  render(<OptionGroups />)
  fireEvent.click(await screen.findByRole('button', { name: 'More for Regular' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete choice' }))
  expect(await screen.findByText('“Regular” was deleted.')).toBeInTheDocument()
  expect(mockWrites).toContainEqual({ table: 'pos_options', deleted: 'o1' })
})
