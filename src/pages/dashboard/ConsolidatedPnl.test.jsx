/**
 * Consolidated P&L renders a statement from one batch on the single path and a matrix from
 * get_group_pnl on the group path (S849). The arithmetic is pnlStatement.test.js's; this pins the
 * page's wiring: delivery commission as its own line, the depreciation memo, the labour rule's
 * markers, a no-period column, stock on the way, and a failed read as an error card.
 */
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

let mockAuth = {}
// Each table's answer: a value, or a function returning one (a promise holds a read open).
let mockTables = {}
let mockRpc = {}
let mockGroupLabour = { byClient: new Map(), error: null }
// Every table read, in the order they were sent.
const mockSeen = []

function mockBuilder(table) {
  const b = {}
  for (const m of ['select', 'eq', 'in', 'not', 'gte', 'lt', 'lte', 'order', 'limit']) b[m] = () => b
  const answer = () => {
    mockSeen.push(table)
    const v = mockTables[table]
    return Promise.resolve(typeof v === 'function' ? v() : (v || { data: [], error: null }))
  }
  b.range = answer
  b.then = (res, rej) => answer().then(res, rej)
  return b
}

jest.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth }))
jest.mock('../../supabaseClient', () => ({
  supabase: {
    from: t => mockBuilder(t),
    rpc: (name, args) => Promise.resolve(typeof mockRpc[name] === 'function' ? mockRpc[name](args) : (mockRpc[name] || { data: [], error: null })),
  },
}))
jest.mock('../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => mockDb,
}))
const mockDb = { clientId: 'c1', scopedFrom: t => mockBuilder(t) }
jest.mock('../../shared/hooks/useBizInfo', () => ({ useBizInfo: () => ({ name: 'BLOOM CAFE', ready: true }) }))
jest.mock('../../components/SuiteGate', () => ({
  __esModule: true,
  default: ({ children }) => children,
  SUITE_PAGES: { consolidatedPnl: { featureKey: 'consolidated_pnl' } },
  useSuiteAccess: () => ({ allowed: true }),
}))
jest.mock('../../modules/dashboard/loadOutletLabour', () => ({
  loadOutletLabour: () => Promise.resolve({ labour: null, parts: { hrOn: true, fenced: false, payroll: 30000, payrollReadFailed: false, estimate: null, estimateReadFailed: false, otherPay: null }, error: null }),
  loadGroupLabourInputs: () => Promise.resolve(mockGroupLabour),
}))
jest.mock('../../modules/ims/reports/depreciationMemo', () => ({
  loadDepreciationMemo: () => Promise.resolve({ amount: 40000, count: 1, prorated: false }),
}))

// eslint-disable-next-line import/first
import ConsolidatedPnl from './ConsolidatedPnl'
// eslint-disable-next-line import/first
import { clearPeriodLists, readPeriodList } from '../../shared/periodList'

const P = { id: 'p6', bs_year: 2083, bs_month: 5, status: 'closed' }

beforeEach(() => {
  // The month list is shared and kept between pages (S855, periodList.js): each test starts with none
  // in memory, so the page waits for its own read (through the mocked supabase client).
  clearPeriodLists()
  mockSeen.length = 0
  mockAuth = {
    clientId: 'c1', profile: { client_id: 'c1' }, loading: false, clientModules: { ims: true, hr: true, pos: true },
    clientModulesKnown: true, outlets: [], isAdmin: false, isOwner: true, groupId: null, viewGroupId: null, imsRole: 'manager',
  }
  mockTables = {
    monthly_periods: { data: [P], error: null },
    items: { data: [{ id: 'rice', name: 'Rice', per_uom_rate: '100', is_active: true }], error: null },
    opening_stock: { data: [{ period_id: 'p6', item_id: 'rice', qty: '10' }], error: null },
    closing_stock: { data: [{ period_id: 'p6', item_id: 'rice', physical_qty: '4' }], error: null },
    sales_entries: { data: [{ period_id: 'p6', recipe_id: 'r1', qty_sold: '10', unit_price: '500', discount: '0', source: 'pos' }], error: null },
    recipes: { data: [{ id: 'r1', selling_price: '500' }], error: null },
    pos_orders: { data: [{ id: 'o1', credit_settled_at: null, credit_note_id: null, commission_amount: '250', pos_credit_receipt_lines: [] }], error: null },
  }
  mockRpc = { pos_ims_waiting_counts: { data: [], error: null } }
  mockGroupLabour = { byClient: new Map(), error: null }
})

const renderPage = () => render(<MemoryRouter><ConsolidatedPnl /></MemoryRouter>)

test('single outlet: delivery commission is its own line, the memo shows, unsettled bills are named', async () => {
  renderPage()
  expect(await screen.findByText('Delivery commission')).toBeTruthy()
  expect(screen.getByText('(NPR 250)')).toBeTruthy()
  expect(screen.getByText('NPR 40,000')).toBeTruthy()
  expect(screen.getByText(/1 delivery bill from Bhadra 2083 is not settled yet/)).toBeTruthy()
  expect(screen.getByText(/from finalized payroll/)).toBeTruthy()
})

test('single outlet: a failed read is an error card, not a statement of zeros', async () => {
  mockTables.purchase_entries = { data: null, error: { message: 'boom', code: '500' } }
  renderPage()
  expect(await screen.findByText('Could not load this report')).toBeTruthy()
  expect(screen.queryByText('Delivery commission')).toBeNull()
})

test('group: a no-period column, its marker, and stock on the way', async () => {
  mockAuth.groupId = 'g1'
  mockAuth.outlets = [{ id: 'c1', name: 'BLOOM CAFE' }, { id: 'c2', name: 'BLOOM CAFE - PKR' }]
  const row = over => ({
    client_id: 'c1', client_name: 'BLOOM CAFE', is_included: true, has_period: true, period_status: 'closed',
    revenue: '5000', opening_val: '1000', purchases_val: '2000', returns_val: '0', wastage_val: '0', staff_meals_val: '0',
    closing_val: '500', has_closing: true, labour_payroll: '1000', labour_bucket: '0', overheads_val: '0', tax_fees_val: '0',
    labour_festival: '0', labour_incentive: '0', labour_settlement: '0', transfer_in_val: '0', transfer_out_val: '1000',
    stock_items: 5, uncounted_count: 0, uncounted_val: '0', delivery_commission: '0', delivery_unsettled: 0,
    depreciation_memo: '0', till_waiting_bills: 0, till_waiting_notes: 0, on_the_way_val: '1000', ...over,
  })
  mockRpc.get_group_pnl = args => {
    expect(args).toMatchObject({ p_bs_year: 2083, p_bs_month: 5, p_group_id: null })
    return { data: [row(), row({ client_id: 'c2', client_name: 'BLOOM CAFE - PKR', has_period: false })], error: null }
  }
  mockGroupLabour = { byClient: new Map([['c1', { hrEnabled: true, inputs: null }], ['c2', { hrEnabled: false, inputs: null }]]), error: null }
  renderPage()
  expect(await screen.findByText('Consolidated')).toBeTruthy()
  expect(screen.getByText('no period')).toBeTruthy()
  expect(screen.getByText(/No Bhadra 2083 in Inventory for: BLOOM CAFE - PKR/)).toBeTruthy()
  expect(screen.getByText(/NPR 1,000 of stock was on the way between your outlets at the end of Bhadra 2083/)).toBeTruthy()
})

test('the operator reads the viewed group by its id', async () => {
  mockAuth = { ...mockAuth, isAdmin: true, isOwner: false, groupId: 'g9', viewGroupId: 'g9', outlets: [{ id: 'c1', name: 'BLOOM CAFE' }] }
  const seen = []
  mockRpc.get_group_pnl = args => { seen.push(args.p_group_id); return { data: [], error: null } }
  renderPage()
  expect(await screen.findByText(/No outlet in your group has Crest Suite Pro/)).toBeTruthy()
  expect(seen).toEqual(['g9'])
})

// S857/S858: the address names the statement (`?period=<id>`, `?fy=<start>`), so the Owner
// Dashboard's Net Margin tile, a reload or a shared link opens the month it meant, instead of the
// latest closed month the page defaults to.
const P7 = { id: 'p7', bs_year: 2083, bs_month: 6, status: 'open' }
const renderAt = search => render(
  <MemoryRouter initialEntries={[`/pnl${search}`]}><ConsolidatedPnl /></MemoryRouter>,
)

test('opens on the month the Owner Dashboard sent, provisional while it is open', async () => {
  mockTables.monthly_periods = { data: [P7, P], error: null }
  renderAt('?period=p7')
  expect(await screen.findByText(/Provisional/)).toBeTruthy()
  expect(screen.getByLabelText('Period').value).toBe('period:p7')
})

test('a month that is not in this outlet list is ignored: the latest closed month opens', async () => {
  mockTables.monthly_periods = { data: [P7, P], error: null }
  renderAt('?period=someone-else')
  expect(await screen.findByText('Delivery commission')).toBeTruthy()
  expect(screen.getByLabelText('Period').value).toBe('period:p6')
  expect(screen.queryByText(/Provisional/)).toBeNull()
})

test('a fiscal year named in the address opens that year', async () => {
  mockTables.monthly_periods = { data: [P7, P], error: null }
  renderAt('?fy=2083')
  await screen.findByLabelText('Period')
  expect(await screen.findByDisplayValue(/Fiscal year 2083\/84/)).toBeTruthy()
})

test('the previous-month button steps to the month before, and stops at the first month', async () => {
  mockTables.monthly_periods = { data: [P7, P], error: null }
  renderAt('?period=p7')
  await screen.findByText(/Provisional/)
  fireEvent.click(screen.getByRole('button', { name: /^Previous month: / }))
  expect(screen.getByLabelText('Period').value).toBe('period:p6')
  const none = screen.getByRole('button', { name: 'No earlier month' })
  expect(none.getAttribute('aria-disabled')).toBe('true')
})

// S876 (PERF-10): the months come from the shared list. With one in memory the statement starts at
// once, beside a fresh read of the list, and is kept only when the fresh list agrees.
describe('the month list in memory', () => {
  // An earlier page left Bhadra (closed) in memory; this visit's fresh read is held open until answered.
  async function revisit() {
    await readPeriodList('c1')
    let answer
    mockTables.monthly_periods = () => new Promise(res => { answer = res })
    mockSeen.length = 0
    renderPage()
    await waitFor(() => expect(typeof answer).toBe('function'))
    return res => answer(res)
  }
  const statementReads = () => mockSeen.filter(t => t === 'opening_stock').length
  const guessFinished = () => new Promise(res => setTimeout(res, 20))

  test('a revisit starts the statement before the month list answers, and keeps it when the list agrees', async () => {
    const answer = await revisit()
    await waitFor(() => expect(statementReads()).toBe(1))
    await guessFinished()
    // The guess never paints alone: the page stays loading until the list has answered too.
    expect(screen.queryByText('Delivery commission')).toBeNull()
    answer({ data: [P], error: null })
    expect(await screen.findByText('Delivery commission')).toBeTruthy()
    expect(statementReads()).toBe(1)
    expect(screen.getByLabelText('Period').value).toBe('period:p6')
  })

  test('a month reopened elsewhere is built again, even though the selection did not change', async () => {
    const answer = await revisit()
    await waitFor(() => expect(statementReads()).toBe(1))
    await guessFinished()
    answer({ data: [{ ...P, status: 'open' }], error: null })
    expect(await screen.findByText(/Provisional/)).toBeTruthy()
    expect(statementReads()).toBe(2)
    expect(screen.getByLabelText('Period').value).toBe('period:p6')
  })

  test('a newer month closed elsewhere opens instead of the guessed one', async () => {
    const answer = await revisit()
    await waitFor(() => expect(statementReads()).toBe(1))
    answer({ data: [{ ...P7, status: 'closed' }, P], error: null })
    await waitFor(() => expect(screen.getByLabelText('Period').value).toBe('period:p7'))
    expect(await screen.findByText('Delivery commission')).toBeTruthy()
    expect(statementReads()).toBe(2)
  })

  test('a failed fresh list is the error card, never the guessed statement', async () => {
    const answer = await revisit()
    await waitFor(() => expect(statementReads()).toBe(1))
    await guessFinished()
    answer({ data: null, error: { message: 'boom', code: '500' } })
    expect(await screen.findByText('Could not load this report')).toBeTruthy()
    expect(screen.queryByText('Delivery commission')).toBeNull()
  })
})

test('a failed month list offers Try again, which reads the months and the statement again', async () => {
  mockTables.monthly_periods = { data: null, error: { message: 'boom', code: '500' } }
  renderPage()
  expect(await screen.findByText('Could not load this report')).toBeTruthy()
  mockTables.monthly_periods = { data: [P], error: null }
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('Delivery commission')).toBeTruthy()
})

test('a failed statement read offers Try again, which reads the same month again', async () => {
  mockTables.purchase_entries = { data: null, error: { message: 'boom', code: '500' } }
  renderPage()
  expect(await screen.findByText('Could not load this report')).toBeTruthy()
  delete mockTables.purchase_entries
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('Delivery commission')).toBeTruthy()
  expect(screen.getByLabelText('Period').value).toBe('period:p6')
})
