// Bulk Entry keeps unsaved typing in localStorage (salesEntryDraft.js) and brings it back when the
// period loads again, with a notice, never silently. A draft typed over figures that were saved
// since is not applied: the page asks.
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Sales from './Sales'
import { salesDraftSignature, readSalesDraft } from './salesEntryDraft'
import { readPeriodList, clearPeriodLists } from '../../../shared/periodList'
import { BS_MONTHS } from '../../../utils/bsCalendar'

// The period's saved Bulk rows (bs_day 0), read by loadSales and by loadAllDaySums.
let mockBulkRows = []
// The month list the server returns (the shared list reads it, S855), and an optional gate that
// holds that read until the test releases it.
const P1 = { id: 'p1', bs_year: 2083, bs_month: 6, status: 'open' }
let mockPeriods = [P1]
let mockPeriodsGate = null
let mockSalesReads = 0

function mockBuilder(table) {
  const b = {
    select: () => b, order: () => b, or: () => b, range: () => b, in: () => b, limit: () => b,
    eq: () => b, abortSignal: () => b,
    then: (res, rej) => {
      let data = []
      if (table === 'monthly_periods') {
        const rows = mockPeriods
        if (mockPeriodsGate) return mockPeriodsGate.then(() => ({ data: rows, error: null })).then(res, rej)
        data = rows
      }
      if (table === 'recipes') data = [{ id: 'r1', name: 'Momo', category: 'Food', selling_price: 200, is_active: true }]
      if (table === 'sales_entries') { mockSalesReads++; data = mockBulkRows }
      return Promise.resolve({ data, error: null }).then(res, rej)
    },
  }
  return b
}

jest.mock('../../../supabaseClient', () => ({
  supabase: { from: t => mockBuilder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
}))
jest.mock('../../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({ scopedFrom: t => mockBuilder(t) }),
}))
jest.mock('../../../shared/fetchAllRows', () => ({
  ...jest.requireActual('../../../shared/fetchAllRows'),
  fetchAllRows: make => make(),
}))
// The save lands, and the server then holds what was typed. Plain functions rather than jest.fn
// bodies, because CRA resets mock implementations before every test.
let mockSaves = 0
let mockStockDelayMs = 0
jest.mock('./persistSalesDay', () => ({
  persistSalesDay: async (_sb, { rows }) => {
    mockSaves++
    mockBulkRows = rows.map((r, i) => ({ id: `s${i}`, recipe_id: r.recipe_id, qty_sold: r.qty_sold, source: 'manual', bs_day: 0, unit_price: 200 }))
  },
  findSupersededRows: async () => ({ total: 0, byRecipe: [] }),
  depleteManualSales: () => new Promise(r => setTimeout(r, mockStockDelayMs)),
  repostSupersededMovements: async () => {},
  SAVE_TIMEOUT_MS: 20000,
  stockUpdateBusy: () => false,
  stockUpdateWaitingText: () => '',
}))
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    clientId: 'c1', profile: { id: 'u1', client_id: 'c1' }, loading: false, isAdmin: false,
    canEditClosedPeriods: false, clientModules: { ims: true }, hasImsAccess: () => true,
  }),
}))

const KEY = 'crest_sales_entry_drafts'
const ID = 'bulk:p1:u1'
const keep = (form, saved, savedAt = Date.now()) =>
  localStorage.setItem(KEY, JSON.stringify({ [ID]: { form, savedAt, baseSignature: salesDraftSignature(saved) } }))
const renderPage = () => render(<MemoryRouter><Sales /></MemoryRouter>)
const qtyBox = () => screen.getByLabelText('Quantity sold: Momo')

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  clearPeriodLists()   // the shared month list is module state, kept between tests otherwise
  mockBulkRows = []
  mockPeriods = [P1]
  mockPeriodsGate = null
  mockSalesReads = 0
  mockSaves = 0
  mockStockDelayMs = 0
})

test('a guessed month starts the reads but is never shown or editable; the fresh list decides (S855)', async () => {
  // The list in memory says Ashwin is open. Since it was read, Ashwin closed and Kartik opened.
  await readPeriodList('c1')
  const P2 = { id: 'p2', bs_year: 2083, bs_month: 7, status: 'open' }
  mockPeriods = [P2, { ...P1, status: 'closed' }]
  let release
  mockPeriodsGate = new Promise(r => { release = r })
  keep({ r1: '7' }, {})   // typed into Ashwin while it was open

  renderPage()
  // The guessed month's sales reads go out at once, beside the held list read...
  await waitFor(() => expect(mockSalesReads).toBeGreaterThan(0))
  await act(() => new Promise(r => setTimeout(r, 0)))
  // ...and land on nothing a person can see or type into: no grid, no month, no dropdown entries.
  expect(screen.queryByLabelText('Quantity sold: Momo')).not.toBeInTheDocument()
  expect(screen.queryByText(new RegExp(BS_MONTHS[5]))).not.toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: 'Period' }).options).toHaveLength(0)

  await act(async () => { release() })
  const box = await screen.findByLabelText('Quantity sold: Momo')
  expect(screen.getByRole('combobox', { name: 'Period' })).toHaveValue('p2')
  expect(box).not.toBeDisabled()
  expect(box).toHaveValue(null)   // Ashwin's figures are not put into Kartik
  expect(screen.queryByText(/Brought back figures you typed earlier/)).not.toBeInTheDocument()
  expect(readSalesDraft(ID)?.form).toEqual({ r1: '7' })   // and Ashwin's kept draft is untouched
})

test('figures kept from an earlier visit come back with a notice, and Discard forgets them', async () => {
  keep({ r1: '7' }, {})
  renderPage()
  expect(await screen.findByText(/Brought back figures you typed earlier/)).toBeInTheDocument()
  expect(qtyBox()).toHaveValue(7)

  fireEvent.click(screen.getByRole('button', { name: 'Discard these figures' }))
  expect(qtyBox()).toHaveValue(null)
  expect(screen.queryByText(/Brought back figures you typed earlier/)).not.toBeInTheDocument()
  expect(readSalesDraft(ID)).toBeNull()
})

test('a draft typed over figures saved since is not applied; the page asks first', async () => {
  keep({ r1: '7' }, {})   // typed over an empty month
  mockBulkRows = [{ id: 'e1', recipe_id: 'r1', qty_sold: 5, source: 'manual', bs_day: 0, unit_price: 200 }]
  renderPage()
  expect(await screen.findByText(/This month was saved again after you typed these figures/)).toBeInTheDocument()
  expect(qtyBox()).toHaveValue(5)   // the saved figure, not the older typing

  fireEvent.click(screen.getByRole('button', { name: 'Use my unsaved figures' }))
  expect(qtyBox()).toHaveValue(7)
  expect(screen.getByText(/Brought back figures you typed earlier/)).toBeInTheDocument()
  // Kept again, now measured against the figures on screen, so the next visit is not "saved since".
  await waitFor(() => expect(readSalesDraft(ID)?.baseSignature).toBe(salesDraftSignature({ r1: 5 })))
})

test('typing is kept after the debounce, and only what differs from the saved figures', async () => {
  renderPage()
  const box = await screen.findByLabelText('Quantity sold: Momo')
  expect(screen.queryByText(/Brought back figures/)).not.toBeInTheDocument()
  fireEvent.change(box, { target: { value: '12' } })
  await waitFor(() => expect(readSalesDraft(ID)?.form).toEqual({ r1: '12' }))
  fireEvent.change(box, { target: { value: '' } })
  await waitFor(() => expect(readSalesDraft(ID)).toBeNull())
})

test('a save that lands forgets the draft, and a tab switch before the reload does not write it back', async () => {
  // The stock update after the save takes a moment, which is the window the hold covers: the boxes
  // still hold the typing, measured against the figures from before the save.
  mockStockDelayMs = 300
  renderPage()
  const box = await screen.findByLabelText('Quantity sold: Momo')
  fireEvent.change(box, { target: { value: '12' } })
  await waitFor(() => expect(readSalesDraft(ID)).not.toBeNull())

  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(mockSaves).toBe(1))
  await waitFor(() => expect(readSalesDraft(ID)).toBeNull())   // cleared as the save landed

  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  try {
    document.dispatchEvent(new Event('visibilitychange'))
  } finally {
    delete document.visibilityState   // back to the prototype getter
  }
  expect(readSalesDraft(ID)).toBeNull()

  await screen.findByRole('button', { name: '✓ Saved' })
  await waitFor(() => expect(qtyBox()).toHaveValue(12))   // reloaded from the saved rows
  await new Promise(r => setTimeout(r, 500))               // past the debounce
  expect(readSalesDraft(ID)).toBeNull()
  expect(screen.queryByText(/Brought back figures|saved again/)).not.toBeInTheDocument()
})
