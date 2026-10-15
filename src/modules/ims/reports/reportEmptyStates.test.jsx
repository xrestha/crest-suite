/**
 * Payment Summary and Budget vs Actual say when a month that loaded has nothing in it.
 *
 * Both pages had no empty state at all: a month with no bills drew six NPR 0 cards and a Total row
 * of zeros on Payment Summary, and Budget vs Actual drew a table of dashes (or no rows and a Totals
 * line when the client had no categories). The other half matters as much: the empty state may only
 * speak about a month that LOADED. A failed read is not an empty month.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// The answer per table, set per test.
let mockAnswers = {}

// One chainable, awaitable builder that answers its table's rows on `then`.
function mockBuilder(table) {
  const b = {}
  for (const op of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'order', 'limit', 'not', 'or', 'is', 'range', 'single', 'maybeSingle']) {
    b[op] = () => b
  }
  b.then = (ok, fail) => Promise.resolve(mockAnswers[table] || { data: [], error: null }).then(ok, fail)
  return b
}
// Stable across renders: scopedFrom is a dependency of the pages' loaders.
const mockScopedDb = { scopedFrom: table => mockBuilder(table) }
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockScopedDb }))
jest.mock('../../../shared/fetchAllRows', () => ({
  fetchAllRows: makeQuery => makeQuery(),
  fetchAllRowsChunked: (ids, makeQuery) => (ids.length ? makeQuery(ids) : Promise.resolve({ data: [], error: null })),
}))
jest.mock('../../../supabaseClient', () => ({ supabase: { from: table => mockBuilder(table), rpc: () => mockBuilder('rpc') } }))
const mockAuth = { clientId: 'c1', profile: { client_id: 'c1' }, loading: false, hasImsAccess: () => true }
jest.mock('../../../context/AuthContext', () => ({ useAuth: () => mockAuth }))
jest.mock('../../../shared/hooks/useBizInfo', () => ({ useBizInfo: () => ({ name: 'Test Outlet', error: null }) }))

// eslint-disable-next-line import/first
import PaymentReport from './PaymentReport'
// eslint-disable-next-line import/first
import BudgetVsActual from './BudgetVsActual'

const BHADRA = { id: 'p1', bs_year: 2083, bs_month: 5, status: 'open' }
const FAILED = { data: null, error: { message: 'TypeError: Failed to fetch' } }

const oneBill = {
  id: 'e1', purchase_group_id: 'g1', item_id: 'i1', qty: 2, rate: 100, discount_amount: 0,
  vat_inclusive: false, vat_is_cost: false, payment_method: 'Cash', bs_day: 3, vendor_id: 'v1',
  invoice_ref: 'A1', items: { name: 'Rice', categories: { name: 'Dry Goods' } }, vendors: { name: 'Supplier' },
}

function renderPage(Page) {
  return render(<MemoryRouter><Page /></MemoryRouter>)
}

beforeEach(() => { mockAnswers = { monthly_periods: { data: [BHADRA], error: null } } })

describe('Payment Summary', () => {
  test('a loaded month with no bills and no returns says so, and draws no NPR 0 cards', async () => {
    renderPage(PaymentReport)
    expect(await screen.findByText(/No purchase bills or supplier returns recorded for Bhadra 2083/)).toBeTruthy()
    expect(screen.queryByText('Gross Purchases')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Method Summary' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Purchases' }).getAttribute('href')).toBe('/purchases?period=p1')
  })

  test('a failed read is a failed read, never an empty month', async () => {
    mockAnswers.purchase_entries = FAILED
    renderPage(PaymentReport)
    expect(await screen.findByText('Could not load this report')).toBeTruthy()
    expect(screen.queryByText(/No purchase bills or supplier returns recorded/)).toBeNull()
    expect(screen.queryByText('Gross Purchases')).toBeNull()
  })

  test('a month with a bill shows the report, not the empty state', async () => {
    mockAnswers.purchase_entries = { data: [oneBill], error: null }
    renderPage(PaymentReport)
    expect(await screen.findByRole('tab', { name: 'Method Summary' })).toBeTruthy()
    expect(screen.queryByText(/No purchase bills or supplier returns recorded/)).toBeNull()
  })
})

describe('Budget vs Actual', () => {
  test('no categories: the empty state says why there is nothing to budget, and no table renders', async () => {
    renderPage(BudgetVsActual)
    expect(await screen.findByText(/No item categories yet, so there is nothing to set a budget against/)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  test('categories but no budget: a prompt above the table, and the Budget boxes stay usable', async () => {
    mockAnswers.categories = { data: [{ id: 'cat1', name: 'Dairy', sort_order: 0 }], error: null }
    renderPage(BudgetVsActual)
    expect(await screen.findByText(/No budget set and no purchases recorded for Bhadra 2083 yet/)).toBeTruthy()
    expect(screen.getByRole('spinbutton', { name: 'Budget for Dairy' })).toBeTruthy()
  })

  test('a saved budget: no prompt', async () => {
    mockAnswers.categories = { data: [{ id: 'cat1', name: 'Dairy', sort_order: 0 }], error: null }
    mockAnswers.budgets = { data: [{ category_id: 'cat1', amount: 5000 }], error: null }
    renderPage(BudgetVsActual)
    expect(await screen.findByRole('spinbutton', { name: 'Budget for Dairy' })).toBeTruthy()
    expect(screen.queryByText(/No budget set/)).toBeNull()
  })

  test('a failed read shows the error card and neither empty sentence', async () => {
    mockAnswers.categories = { data: [{ id: 'cat1', name: 'Dairy', sort_order: 0 }], error: null }
    mockAnswers.budgets = FAILED
    renderPage(BudgetVsActual)
    expect(await screen.findByText('Could not load this report')).toBeTruthy()
    expect(screen.queryByText(/No budget set/)).toBeNull()
    expect(screen.queryByText(/No item categories yet/)).toBeNull()
  })
})
