/**
 * Consolidated P&L renders a statement from one batch on the single path and a matrix from
 * get_group_pnl on the group path (S849). The arithmetic is pnlStatement.test.js's; this pins the
 * page's wiring: delivery commission as its own line, the depreciation memo, the labour rule's
 * markers, a no-period column, stock on the way, and a failed read as an error card.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

let mockAuth = {}
let mockTables = {}
let mockRpc = {}
let mockGroupLabour = { byClient: new Map(), error: null }

function mockBuilder(table) {
  const b = {}
  for (const m of ['select', 'eq', 'in', 'not', 'gte', 'lt', 'lte', 'order', 'limit']) b[m] = () => b
  const answer = () => Promise.resolve(mockTables[table] || { data: [], error: null })
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

const P = { id: 'p6', bs_year: 2083, bs_month: 5, status: 'closed' }

beforeEach(() => {
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

// S857: the Owner Dashboard's Net Margin tile opens /pnl on the month it showed, with
// `state.periodId`, instead of the latest closed month the page defaults to.
const P7 = { id: 'p7', bs_year: 2083, bs_month: 6, status: 'open' }
const renderAt = state => render(
  <MemoryRouter initialEntries={[{ pathname: '/pnl', state }]}><ConsolidatedPnl /></MemoryRouter>,
)

test('opens on the month the Owner Dashboard sent, provisional while it is open', async () => {
  mockTables.monthly_periods = { data: [P7, P], error: null }
  renderAt({ periodId: 'p7' })
  expect(await screen.findByText(/Provisional/)).toBeTruthy()
  expect(screen.getByLabelText('Period').value).toBe('period:p7')
})

test('a month that is not in this outlet list is ignored: the latest closed month opens', async () => {
  mockTables.monthly_periods = { data: [P7, P], error: null }
  renderAt({ periodId: 'someone-else' })
  expect(await screen.findByText('Delivery commission')).toBeTruthy()
  expect(screen.getByLabelText('Period').value).toBe('period:p6')
  expect(screen.queryByText(/Provisional/)).toBeNull()
})
