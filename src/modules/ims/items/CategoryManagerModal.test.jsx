import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import CategoryManagerModal from './CategoryManagerModal'

// One table-aware stub for every supabase call (the Items.loadSpeed.test.jsx pattern): a chainable
// builder that records its calls and answers when awaited.
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
    auth: {},
  },
}))
jest.mock('../../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({
    clientId: 'c1',
    scopedFrom: (table, cols) => mockBuilder(table, cols),
    scopedInsert: (table, rows) => mockBuilder(table, rows),
    scopedUpdate: (table, values) => mockBuilder(table, values),
  }),
}))

const categories = [
  { id: 'c1', name: 'Dairy', sort_order: 0 },
  { id: 'c2', name: 'Groceries', sort_order: 1 },
  { id: 'c3', name: 'Beverage', sort_order: 2, master_id: 'hq-3' },
]
const items = [
  { id: 'i1', category_id: 'c1', is_active: true },
  { id: 'i2', category_id: 'c1', is_active: false },
  { id: 'i3', category_id: 'c2', is_active: true },
]
const has = (calls, method, args) => calls.some(([m, a]) => m === method && JSON.stringify(a) === JSON.stringify(args))

let askConfirm
let onChanged
beforeEach(() => {
  mockCalls.length = 0
  askConfirm = jest.fn()
  onChanged = jest.fn(async () => {})
  mockRespond = (table, calls) => {
    if (table === 'items') return { count: has(calls, 'eq', ['is_active', false]) ? 1 : 2, error: null }
    if (table === 'budgets') return { count: 3, error: null }
    if (table === 'rpc:merge_item_category') return { data: { items_moved: 2, budgets_merged: 1, budgets_moved: 2, assignments_moved: 0 }, error: null }
    if (table === 'categories') return { data: [{ id: 'x' }], error: null }
    return { data: [], error: null }
  }
})

const renderModal = (props = {}) => render(
  <CategoryManagerModal categories={categories} items={items} inGroup canRemove
    askConfirm={askConfirm} onChanged={onChanged} onClose={() => {}} {...props} />)

test('lists every category with its item count, hidden items included', () => {
  renderModal()
  const row = screen.getAllByRole('row').find(r => within(r).queryByText('Dairy'))
  expect(within(row).getByText('2')).toBeInTheDocument()
  expect(within(row).getByText('1 hidden')).toBeInTheDocument()
})

test('remove counts live, asks for a target, confirms with the counts, then calls the merge', async () => {
  renderModal()
  fireEvent.click(screen.getByRole('button', { name: 'Remove Dairy' }))
  expect(await screen.findByText(/"Dairy" holds 2 items \(1 of them hidden\) and 3 monthly budgets\./)).toBeInTheDocument()

  // No target yet: the press says what is missing and asks nothing.
  fireEvent.click(screen.getByRole('button', { name: 'Move and remove…' }))
  expect(screen.getByText('Pick the category its items and budgets move to first.')).toBeInTheDocument()
  expect(askConfirm).not.toHaveBeenCalled()

  const select = screen.getByLabelText('Move them to')
  expect(within(select).queryByText('Dairy')).not.toBeInTheDocument()
  fireEvent.change(select, { target: { value: 'c2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Move and remove…' }))
  expect(askConfirm).toHaveBeenCalledTimes(1)
  const ask = askConfirm.mock.calls[0][0]
  expect(ask).toMatchObject({ title: 'Remove "Dairy"?', danger: true, confirmLabel: 'Move and remove' })
  render(ask.body)
  expect(screen.getByText(/^2 items \(1 of them hidden\) and 3 monthly budgets .* move from "Dairy" to "Groceries"/)).toBeInTheDocument()

  await act(async () => { await ask.run() })
  const rpc = mockCalls.find(c => c.table === 'rpc:merge_item_category')
  expect(rpc.calls[0][1][0]).toEqual({ p_from: 'c1', p_to: 'c2' })
  expect(onChanged).toHaveBeenCalled()
  expect(await screen.findByText('Removed "Dairy": 2 items moved, 1 monthly budget added to the ones already there, 2 monthly budgets moved to "Groceries".')).toBeInTheDocument()
})

test('a supervisor may rename but a Remove press says who can, and reads nothing', () => {
  renderModal({ canRemove: false })
  const remove = screen.getByRole('button', { name: 'Remove Dairy' })
  expect(remove).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(remove)
  expect(screen.getByText(/needs the account owner or an inventory manager/)).toBeInTheDocument()
  expect(mockCalls).toHaveLength(0)
  expect(screen.getByRole('button', { name: 'Rename Dairy' })).not.toHaveAttribute('aria-disabled')
})

test('a head-office copy at a branch is shown with Rename and Remove off, and says why', () => {
  renderModal()
  expect(screen.getByText('From head office')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Rename Beverage' }))
  expect(screen.getByText(/came from head office/)).toBeInTheDocument()
  expect(screen.queryByLabelText('New name for Beverage')).not.toBeInTheDocument()
})

test('a rename onto another name in other capitals is refused before anything is sent', async () => {
  renderModal()
  fireEvent.click(screen.getByRole('button', { name: 'Rename Dairy' }))
  fireEvent.change(screen.getByLabelText('New name for Dairy'), { target: { value: 'groceries' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(screen.getByText(/differs only in capitals or spaces/)).toBeInTheDocument()
  expect(mockCalls).toHaveLength(0)

  fireEvent.change(screen.getByLabelText('New name for Dairy'), { target: { value: 'Dairy & Eggs' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(mockCalls.some(c => c.table === 'categories')).toBe(true))
  const upd = mockCalls.find(c => c.table === 'categories')
  expect(upd.calls[0][1][0]).toEqual({ name: 'Dairy & Eggs' })
  expect(has(upd.calls, 'eq', ['id', 'c1'])).toBe(true)
  expect(await screen.findByText(/Renamed "Dairy" to "Dairy & Eggs"/)).toBeInTheDocument()
})

test('a new category name taken by Sub-Recipes in any spelling is refused', () => {
  renderModal()
  fireEvent.change(screen.getByLabelText('New category name'), { target: { value: 'SUB-RECIPES' } })
  fireEvent.click(screen.getByRole('button', { name: '+ Add category' }))
  expect(screen.getByText(/Recipe Costing files sub-recipes/)).toBeInTheDocument()
  expect(mockCalls).toHaveLength(0)
})
