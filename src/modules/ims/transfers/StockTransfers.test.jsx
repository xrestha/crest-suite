/**
 * Stock Transfers renders its three tabs from one load, guards itself after its hooks, and words a
 * refused Cancel through the error table inside the reason dialog (S849, PNL-8). The writes are RPCs
 * the server checks; these tests only pin the page's own wiring.
 */
import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

let mockAuth = {}
let mockTables = {}
let mockIncoming = { data: [], error: null }
let mockOutgoing = { data: [], error: null }
let mockIncomingNext = null // a one-off answer for the next Incoming read (a promise the test settles)
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
    readIncomingTransfers: () => {
      if (mockIncomingNext) { const next = mockIncomingNext; mockIncomingNext = null; return next }
      return Promise.resolve(mockIncoming)
    },
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
  mockIncomingNext = null
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
  // S852: every Receive names its transfer, the visible word first (WCAG 2.5.3). The phone list
  // beside the table carries the same button; CSS shows one or the other.
  const receives = screen.getAllByRole('button', { name: 'Receive transfer from BLOOM CAFE - PKR, sent 2 Kartik 2083, NPR 12,400' })
  expect(receives).toHaveLength(2)
  expect(receives[0]).toHaveTextContent(/^Receive$/)
  expect(screen.getByText('BLOOM CAFE - PKR')).toBeTruthy()
  expect(screen.getByText('From BLOOM CAFE - PKR')).toBeTruthy() // the phone card's title
})

test('Receive refreshes the lists in place, and focus goes to what happened once the row has gone', async () => {
  let release
  mockReceive.mockImplementation(() => {
    // The re-read after the write waits until released, so the page can be seen during it.
    mockIncomingNext = new Promise(res => { release = () => res({ data: [], error: null }) })
    return Promise.resolve({ data: { received_bs_year: 2083, received_bs_month: 7, received_bs_day: 3 }, error: null })
  })
  renderPage()
  fireEvent.click(await screen.findByRole('tab', { name: 'Incoming (1)' }))
  const receive = screen.getAllByRole('button', { name: /^Receive transfer from BLOOM CAFE - PKR/ })[0]
  receive.focus()
  fireEvent.click(receive)
  const dialog = await screen.findByRole('dialog', { name: 'Receive the stock from BLOOM CAFE - PKR?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Receive' }))
  await waitFor(() => expect(mockReceive).toHaveBeenCalledWith('t1'))
  expect(await screen.findByText(/^Received — NPR 12,400 from BLOOM CAFE - PKR/)).toBeTruthy()
  // Still reading: the table stands where it was, with no Loading in its place.
  expect(screen.queryByText('Loading…')).toBeNull()
  expect(screen.getAllByRole('table').length).toBeGreaterThan(0)
  release()
  expect(await screen.findByText('Nothing is on the way to this outlet.')).toBeTruthy()
  await waitFor(() => expect(document.activeElement).toHaveTextContent(/^Received — /)) // eslint-disable-line testing-library/no-node-access
})

test('removing a line moves focus to the next line, and to the Item picker once none is left', async () => {
  mockTables.items = { data: [{ id: 'i1', name: 'Rice', uom: 'kg', is_sub_recipe: false }, { id: 'i2', name: 'Dal', uom: 'kg', is_sub_recipe: false }], error: null }
  Element.prototype.scrollIntoView = () => {} // the picker list scrolls its highlight into view; jsdom has no layout
  renderPage()
  const picker = await screen.findByLabelText('Item')
  async function addLine(name, qty) {
    fireEvent.click(picker)
    fireEvent.click(await screen.findByRole('option', { name: `${name} (kg)` }))
    fireEvent.change(screen.getByLabelText(/^Quantity( \(kg\))?$/), { target: { value: qty } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  }
  await addLine('Rice', '2')
  await addLine('Dal', '3')
  expect(screen.getByText('2 lines to send')).toBeTruthy()
  const removeRice = screen.getByRole('button', { name: 'Remove Rice' })
  removeRice.focus()
  fireEvent.click(removeRice)
  const removeDal = screen.getByRole('button', { name: 'Remove Dal' })
  expect(removeDal).toHaveFocus()
  fireEvent.click(removeDal)
  expect(picker).toHaveFocus()
})

test('a refused cancel stays in the dialog, worded, with the reason kept', async () => {
  mockEnd.mockResolvedValue({ data: null, error: { code: '22023', message: 'stock_transfer_item_hidden: Rice is hidden at BLOOM CAFE', hint: 'stock_transfer_item_hidden' } })
  renderPage()
  fireEvent.click(await screen.findByRole('tab', { name: /Outgoing/ }))
  fireEvent.click(screen.getAllByRole('button', { name: /More for the transfer to BLOOM CAFE - PKR/ })[0])
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
