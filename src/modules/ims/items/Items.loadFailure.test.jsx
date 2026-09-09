/**
 * Item Master when a read fails — the S706 finding, pinned where it was actually wrong.
 *
 * The page used to do `const { data } = await …` and `setItems(data || [])`, so a refused or dropped
 * read became an empty Item Master and the page then made claims from it: "No items yet. Add your
 * first ingredient to get started", "0 ingredients across 0 categories", a dash in Used In (which
 * means "no records anywhere"), and — the one with teeth — a next item code counted from an empty
 * list, handing out ITM-001 over codes that already exist.
 *
 * These are the assertions a future refactor must not undo, and they are all about what the page
 * SAYS: the difference between "there is nothing" and "I could not find out" is the whole bug.
 *
 * See Settings.planPricing.test.jsx for the component-test pattern and why it only recently became
 * possible here.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Items from './Items'

// A stand-in PostgREST builder (named `mock*` so jest.mock's factories may reach it): every filter/order method returns itself, and awaiting it (or the
// `.range()` fetchAllRows adds) resolves to whatever this table was told to answer.
function mockQuery(result) {
  const q = {}
  for (const m of ['select', 'eq', 'in', 'not', 'order', 'range', 'limit']) q[m] = () => q
  q.then = (res, rej) => Promise.resolve(result).then(res, rej)
  return q
}

// What each read answers, per test. `items` is keyed by the columns asked for, because Items.js
// reads that table twice for two different jobs: the list, and the id set the usage check needs.
let mockAnswers

jest.mock('../../../supabaseClient', () => ({
  // Every table in the usage check goes through here.
  supabase: { from: table => mockQuery(mockAnswers.usage[table] ?? mockAnswers.usage.default) },
}))

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ clientId: 'client-1', isAdmin: false, hasImsAccess: () => true }),
}))

jest.mock('../../../context/SettingsContext', () => ({
  useSettings: () => ({ settings: { item_code_prefix: 'ITM' } }),
}))

jest.mock('../../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({
    scopedFrom: (table, columns) => mockQuery(
      table === 'items'
        ? (columns === 'id' ? mockAnswers.itemIds : mockAnswers.items)
        : mockAnswers.categories),
    scopedInsert: async () => ({ error: null }),
    scopedUpsert: async () => ({ error: null }),
    scopedUpdate: () => mockQuery({ error: null }),
  }),
}))

const ONE_ITEM = [{
  id: 'i1', name: 'CHICKEN BREAST', item_code: 'ITM-014', uom: 'GM', rate: 0.777,
  per_uom_rate: 0.777, yield_pct: 100, is_active: true, category_id: null, categories: null,
  purchase_unit: null, base_unit: null, conversion_factor: 1,
}]

const REFUSED = { data: null, error: { code: '42501', message: 'permission denied for table items' } }

beforeEach(() => {
  sessionStorage.clear() // a cached list would seed listLoaded and hide the very state under test
  mockAnswers = {
    items: { data: ONE_ITEM, error: null },
    itemIds: { data: [{ id: 'i1' }], error: null },
    categories: { data: [], error: null },
    usage: { default: { data: [], error: null } },
  }
})

const renderPage = () => render(<MemoryRouter><Items /></MemoryRouter>)

test('a failed items read says so, instead of presenting an empty Item Master', async () => {
  mockAnswers.items = REFUSED
  renderPage()

  await waitFor(() => expect(screen.getByText(/Item Master could not be loaded/i)).toBeInTheDocument())
  expect(screen.getByText(/could not be loaded, so nothing can be shown here/i)).toBeInTheDocument()
  // The two claims the old code made from the same emptiness.
  expect(screen.queryByText(/No items yet/i)).not.toBeInTheDocument()
  expect(screen.queryByText(/0 ingredients/i)).not.toBeInTheDocument()
  expect(screen.getByText(/Ingredient list unavailable/i)).toBeInTheDocument()
})

test('Add is refused while the list is unknown, because the next code is derived from it', async () => {
  mockAnswers.items = REFUSED
  renderPage()
  await waitFor(() => expect(screen.getByText(/Item Master could not be loaded/i)).toBeInTheDocument())

  fireEvent.click(screen.getByRole('button', { name: /Add Item/i }))

  expect(screen.getByText(/cannot work out the next item code/i)).toBeInTheDocument()
  expect(screen.queryByText(/^Item Name/i)).not.toBeInTheDocument() // the dialog never opened
})

test('an empty Item Master that really is empty still reads as empty', async () => {
  mockAnswers.items = { data: [], error: null }
  mockAnswers.itemIds = { data: [], error: null }
  renderPage()

  await waitFor(() => expect(screen.getByText(/No items yet/i)).toBeInTheDocument())
  expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument()
})

test('a failed usage check shows "?" rather than the dash that claims no records', async () => {
  mockAnswers.usage = { default: { data: [], error: null }, purchase_entries: REFUSED }
  renderPage()

  await waitFor(() => expect(screen.getByText('CHICKEN BREAST')).toBeInTheDocument())
  await waitFor(() => expect(screen.getByText('?')).toBeInTheDocument())
  // And the filters that read that map cannot be offered — "○ Unused" would answer with every item.
  expect(screen.getByRole('button', { name: /Unused/i })).toBeDisabled()
})

test('a usage check that ran leaves the Unused filter usable and the cell a dash', async () => {
  renderPage()

  await waitFor(() => expect(screen.getByText('CHICKEN BREAST')).toBeInTheDocument())
  await waitFor(() => expect(screen.getByRole('button', { name: /Unused/i })).toBeEnabled())
  expect(screen.queryByText('?')).not.toBeInTheDocument()
})
