import { render, screen, fireEvent } from '@testing-library/react'
import PosCustomers from './PosCustomers'

// S842: the customer search says how much of the book it shows. S843: the Credit tab is CreditTab
// (CreditTab.test.jsx holds its behaviour); here only that the page mounts it for the outlet on screen.
//
// The page's reads and writes are faked per table. jest.mock factories may only reach variables named
// mock*; they are read at call time. Plain functions, not jest.fn: CRA resets mock implementations.
const mockState = {}
const mockCalls = { update: [], insert: [], rpc: [] }
function mockAnswerFor(kind, table) {
  if (kind === 'update') return mockState.updateAnswer
  if (kind === 'insert') return { data: null, error: null }
  if (table === 'pos_customers') return { data: mockState.customers, error: null }
  if (table === 'pos_orders') return { data: [mockState.billSettled ? { ...mockState.bill, ...SETTLED } : mockState.bill], error: null }
  if (table === 'pos_shifts') return { data: { id: 'shift-1' }, error: null }
  if (table === 'settings') return { data: { is_vat_registered: true, invoice_prefix: 'CAC', pos_delivery_partners: [] }, error: null }
  return { data: [], error: null }
}
function mockBuilder(kind, table, payload) {
  const answer = () => {
    if (kind === 'update') mockCalls.update.push(payload)
    if (kind === 'insert') mockCalls.insert.push(payload)
    const a = mockAnswerFor(kind, table)
    if (kind === 'update' && !a.error) mockState.billSettled = true
    return Promise.resolve(a)
  }
  const b = {}
  for (const op of ['select', 'eq', 'is', 'in', 'not', 'order', 'limit', 'gte', 'lte', 'abortSignal']) b[op] = () => b
  b.range = answer
  b.maybeSingle = answer
  b.then = (ok, bad) => answer().then(ok, bad)
  return b
}
const mockDb = {
  clientId: 'c1',
  scopedFrom: table => mockBuilder('select', table),
  scopedUpdate: (table, patch) => mockBuilder('update', table, patch),
  scopedInsert: (table, row) => mockBuilder('insert', table, row),
}
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockDb }))
jest.mock('../../../supabaseClient', () => ({
  supabase: { from: table => mockBuilder('select', table), rpc: (name, args) => { mockCalls.rpc.push({ name, args }); return mockBuilder('select', 'rpc') }, auth: {} },
}))
const mockAuth = { clientId: 'c1', profile: { id: 'me' }, hasPosAccess: () => true, hasFeature: () => false }
jest.mock('../../../context/AuthContext', () => ({ useAuth: () => mockAuth }))
// jsdom has no secure random source for the Cash In's minted id.
jest.mock('../../../utils/uuid', () => ({ randomUUID: () => 'cash-1' }))

const BILL = {
  id: 'b1', order_no: 7, invoice_no: 12, invoice_fy: '82/83', invoice_prefix: 'CAC', close_type: 'paid',
  paid_amount: 3000, discount_amount: 0, buyer_name: 'Hari', buyer_phone: '9800000001', delivery_partner: null,
  commission_amount: null, closed_at: '2026-10-10T04:57:00+00:00', credit_settled_at: null, credit_settled_by: null,
  credit_settled_method: null, credit_note_id: null, vat_registered: true,
}
const SETTLED = { credit_settled_at: '2026-10-15T05:00:00+00:00', credit_settled_by: 'me', credit_settled_method: 'Cash' }

beforeEach(() => {
  mockState.bill = BILL
  mockState.billSettled = false
  mockState.customers = [
    { id: 'c-1', name: 'Hari', phone: '9800000001', created_at: '2026-10-01T04:00:00+00:00' },
    { id: 'c-2', name: 'Sita', phone: '9800000002', created_at: '2026-10-02T04:00:00+00:00' },
  ]
  mockState.updateAnswer = { data: [{ id: 'b1' }], error: null }
  mockCalls.update = []
  mockCalls.insert = []
  mockCalls.rpc = []
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

describe('Credit (S843)', () => {
  test('the Credit tab is CreditTab: it reads who owes for the outlet on screen, and an empty answer says nobody owes', async () => {
    render(<PosCustomers />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Credit/ }))
    expect(await screen.findByText('Nobody owes anything on Credit now.')).toBeInTheDocument()
    expect(mockCalls.rpc).toContainEqual({ name: 'pos_credit_open_bills', args: { p_client_id: 'c1' } })
    // The old whole-bill Settle is gone.
    expect(screen.queryByRole('button', { name: 'Settle' })).not.toBeInTheDocument()
  })
})

describe('Customer search (S842)', () => {
  test('a narrowed list says how much of the book it shows', async () => {
    render(<PosCustomers />)
    expect(await screen.findByText('Sita')).toBeInTheDocument()
    expect(screen.queryByText(/^Showing /)).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search customers' }), { target: { value: 'sita' } })
    expect(await screen.findByText('Showing 1 of 2.')).toBeInTheDocument()
    expect(screen.queryByText('Hari')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search customers' }), { target: { value: 'nobody' } })
    expect(await screen.findByText('No customers match your search.')).toBeInTheDocument()
  })
})
