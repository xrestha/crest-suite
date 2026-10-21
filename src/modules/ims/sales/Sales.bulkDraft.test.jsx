// Bulk Entry keeps unsaved typing in localStorage (salesEntryDraft.js) and brings it back when the
// period loads again, with a notice, never silently. A draft typed over figures that were saved
// since is not applied: the page asks.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Sales from './Sales'
import { salesDraftSignature, readSalesDraft } from './salesEntryDraft'

// The period's saved Bulk rows (bs_day 0), read by loadSales and by loadAllDaySums.
let mockBulkRows = []

function mockBuilder(table) {
  const b = {
    select: () => b, order: () => b, or: () => b, range: () => b, in: () => b, limit: () => b,
    eq: () => b, abortSignal: () => b,
    then: (res, rej) => {
      let data = []
      if (table === 'monthly_periods') data = [{ id: 'p1', bs_year: 2083, bs_month: 6, status: 'open' }]
      if (table === 'recipes') data = [{ id: 'r1', name: 'Momo', category: 'Food', selling_price: 200, is_active: true }]
      if (table === 'sales_entries') data = mockBulkRows
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
  mockBulkRows = []
  mockSaves = 0
  mockStockDelayMs = 0
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
