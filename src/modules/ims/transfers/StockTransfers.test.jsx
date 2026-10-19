/**
 * Stock Transfers renders its three tabs from one load, guards itself after its hooks, and words a
 * refused Cancel through the error table inside the reason dialog (S849, PNL-8). The writes are RPCs
 * the server checks; these tests only pin the page's own wiring.
 */
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

let mockAuth = {}
let mockTables = {}
let mockIncoming = { data: [], error: null }
let mockOutgoing = { data: [], error: null }
const mockEnd = jest.fn()
const mockReceive = jest.fn()

jest.mock('../../../context/AuthContext', () => ({ useAuth: () => mockAuth }))
jest.mock('../../../supabaseClient', () => ({ supabase: { from: () => ({}) } }))
jest.mock('../../../shared/hooks/useRecipeBook', () => ({ useRecipeBook: () => () => Promise.resolve({ recipes: new Map(), ingredientsByRecipe: new Map(), items: new Map() }) }))
jest.mock('../../../shared/hooks/useBizInfo', () => ({ useBizInfo: () => ({ name: 'BLOOM CAFE', ready: true }) }))
jest.mock('../../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => mockDb,
}))
jest.mock('./transferFlows', () => {
  const actual = jest.requireActual('./transferFlows')
  return {
    ...actual,
    readIncomingTransfers: () => Promise.resolve(mockIncoming),
    readOutgoingTransfers: () => Promise.resolve(mockOutgoing),
    receiveStockTransfer: (...a) => mockReceive(...a),
    endStockTransfer: (...a) => mockEnd(...a),
  }
})

// A chainable builder that resolves the table's fixture on .range().
function builder(table) {
  const b = {}
  for (const m of ['eq', 'not', 'order', 'in', 'select']) b[m] = () => b
  b.range = () => Promise.resolve(mockTables[table] || { data: [], error: null })
  return b
}
const mockDb = { clientId: 'c-1', scopedFrom: table => builder(table) }

// eslint-disable-next-line import/first
import StockTransfers from './StockTransfers'

const header = over => ({
  id: 't1', client_id: 'c-2', to_client_id: 'c-1', from_name: 'BLOOM CAFE - PKR', to_name: 'BLOOM CAFE',
  status: 'on_the_way', total_value: 12400, note: 'With Ram',
  lines: [{ item_id: 'x', name: 'Rice', to_name: 'Rice', uom: 'kg', qty: 4, rate: 3100, value: 12400 }],
  sent_at: '2026-10-19T04:00:00Z', sent_bs_year: 2083, sent_bs_month: 7, sent_bs_day: 2, sent_by_name: 'Sita',
  ...over,
})

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/stock-transfers']}>
      <Routes>
        <Route path="/stock-transfers" element={<StockTransfers />} />
        <Route path="/dashboard" element={<p>DASHBOARD</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mockAuth = {
    clientId: 'c-1', groupId: 'g-1', isAdmin: false, isOwner: false, profile: { clients: { name: 'BLOOM CAFE' } },
    outlets: [{ id: 'c-1', name: 'BLOOM CAFE', group_id: 'g-1' }, { id: 'c-2', name: 'BLOOM CAFE - PKR', group_id: 'g-1' }],
    hasImsAccess: lvl => lvl !== 'manager' || mockAuth.manager === true,
    manager: true,
  }
  mockTables = {
    items: { data: [{ id: 'i1', name: 'Rice', uom: 'kg', is_sub_recipe: false }], error: null },
    monthly_periods: { data: [{ id: 'p7', bs_year: 2083, bs_month: 7, status: 'open' }], error: null },
  }
  mockIncoming = { data: [header()], error: null }
  mockOutgoing = { data: [header({ id: 't2', client_id: 'c-1', to_client_id: 'c-2', from_name: 'BLOOM CAFE', to_name: 'BLOOM CAFE - PKR' })], error: null }
  mockEnd.mockReset()
  mockReceive.mockReset()
})

test('redirects below Inventory supervisor', () => {
  mockAuth.hasImsAccess = () => false
  renderPage()
  expect(screen.getByText('DASHBOARD')).toBeTruthy()
})

test('redirects an outlet that is in no group', () => {
  mockAuth.groupId = null
  renderPage()
  expect(screen.getByText('DASHBOARD')).toBeTruthy()
})

test('lists incoming stock on the way with Receive, counted on its tab', async () => {
  renderPage()
  const incomingTab = await screen.findByRole('tab', { name: 'Incoming (1)' })
  fireEvent.click(incomingTab)
  expect(screen.getByText('On the way to BLOOM CAFE')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Receive' })).toBeTruthy()
  expect(screen.getByText('BLOOM CAFE - PKR')).toBeTruthy()
})

test('a refused cancel stays in the dialog, worded, with the reason kept', async () => {
  mockEnd.mockResolvedValue({ data: null, error: { code: '22023', message: 'stock_transfer_item_hidden: Rice is hidden at BLOOM CAFE', hint: 'stock_transfer_item_hidden' } })
  renderPage()
  fireEvent.click(await screen.findByRole('tab', { name: /Outgoing/ }))
  fireEvent.click(screen.getByRole('button', { name: /More for the transfer to BLOOM CAFE - PKR/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Cancel transfer…' }))
  const reason = screen.getByLabelText('Reason *')
  fireEvent.change(reason, { target: { value: 'Van did not go' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel transfer' }))
  await waitFor(() => expect(mockEnd).toHaveBeenCalledWith('t2', 'cancel', 'Van did not go'))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.getByLabelText('Reason *').value).toBe('Van did not go')
})

test('a supervisor is not offered Cancel on outgoing stock', async () => {
  mockAuth.manager = false
  renderPage()
  fireEvent.click(await screen.findByRole('tab', { name: /Outgoing/ }))
  expect(screen.queryByRole('button', { name: /More for the transfer/ })).toBeNull()
})
