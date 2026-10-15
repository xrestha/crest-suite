import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import CreditTab from './CreditTab'

// S843: Customers → Credit. Who owes (grouped by party, over-limit marked), Receive payment (oldest
// bills first, never more than is owed, one call carrying a request id, a lost answer checked with the
// SAME id), and Collected (receipts plus old whole-bill settlements, Cancel naming the amount and the
// drawer). Every read is faked by table or function name; jest.mock factories may only reach mock*.
const mockState = {}
const mockCalls = { rpc: [], update: [] }
const NOW = Date.now()
const ago = d => new Date(NOW - d * 86400000).toISOString()

function mockAnswer({ table, name, args, filters, payload, kind }) {
  if (name) {
    mockCalls.rpc.push({ name, args })
    if (name === 'pos_credit_open_bills') {
      if (mockState.openBillsError) return { data: null, error: mockState.openBillsError }
      const rows = mockState.bills.filter(b => !args.p_party_key || b.party_key === args.p_party_key)
      return { data: rows, error: null }
    }
    if (name === 'record_credit_receipt') return mockState.recordAnswers.shift() || { data: null, error: { message: 'no more answers' }, status: 500 }
    if (name === 'cancel_credit_receipt') return { data: { receipt_id: args.p_receipt_id, already_cancelled: false }, error: null, status: 200 }
    if (name === 'get_client_profile_names') return { data: [{ id: 'me', full_name: 'Ram' }], error: null }
    if (name === 'pos_credit_party_events') return { data: [], error: null }
    return { data: [], error: null }
  }
  if (kind === 'update') { mockCalls.update.push({ table, payload }); return { data: { print_count: 1 }, error: null } }
  if (table === 'settings') return { data: { property_address: 'Lazimpat', property_phone: '01-4000000', vat_number: '600000000', is_vat_registered: true }, error: null }
  if (table === 'clients') return { data: { name: 'Cafe Crest' }, error: null }
  if (table === 'pos_shifts') return { data: mockState.shiftOpen ? [{ id: 's1' }] : [], error: null }
  if (table === 'pos_customers') return { data: [{ id: 'c1', phone_canonical: '9841234567', credit_limit: 1000 }], error: null }
  if (table === 'pos_credit_receipts') return { data: mockState.receipts, error: null }
  if (table === 'pos_credit_receipt_lines') {
    if (filters.some(f => f[0] === 'in' && f[1] === 'receipt_id')) return { data: [{ id: 'l1', receipt_id: 'r7', order_id: 'o9' }], error: null }
    return { data: mockState.linesForLegacy, error: null }
  }
  if (table === 'pos_orders') {
    if (filters.some(f => f[0] === 'gte' && f[1] === 'credit_settled_at')) return { data: mockState.legacy, error: null }
    return { data: [], error: null }
  }
  return { data: [], error: null }
}
function mockBuilder(meta) {
  const filters = []
  const resolve = () => Promise.resolve(mockAnswer({ ...meta, filters }))
  const b = {}
  for (const op of ['select', 'eq', 'is', 'in', 'not', 'order', 'limit', 'gte', 'lte', 'abortSignal']) {
    b[op] = (...a) => { filters.push([op, ...a]); return b }
  }
  b.range = (from, to) => resolve().then(r => (r.error ? r : { ...r, data: Array.isArray(r.data) ? r.data.slice(from, to + 1) : r.data }))
  b.maybeSingle = resolve
  b.then = (ok, bad) => resolve().then(ok, bad)
  return b
}
const mockDb = {
  clientId: 'c1',
  scopedFrom: table => mockBuilder({ table }),
  scopedUpdate: (table, payload) => mockBuilder({ table, payload, kind: 'update' }),
  scopedInsert: table => mockBuilder({ table, kind: 'insert' }),
}
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockDb }))
jest.mock('../../../supabaseClient', () => ({
  supabase: { from: table => mockBuilder({ table }), rpc: (name, args) => mockBuilder({ name, args }), auth: {} },
}))
const mockAuth = { clientId: 'c1', profile: { id: 'me', full_name: 'Ram' }, hasPosAccess: () => true }
jest.mock('../../../context/AuthContext', () => ({ useAuth: () => mockAuth }))
let mockUuid = 0
jest.mock('../../../utils/uuid', () => ({ randomUUID: () => `req-${++mockUuid}` }))

const HARI = { party_key: 'phone:9841234567', buyer_name: 'Hari', buyer_phone: '9841234567', delivery_partner: null, invoice_fy: '82/83', invoice_prefix: 'CAC', received: 0, commission: 0 }
const BILLS = [
  { ...HARI, order_id: 'o1', invoice_no: 12, closed_at: ago(40), paid_amount: 1000, owed: 1000 },
  { ...HARI, order_id: 'o2', invoice_no: 15, closed_at: ago(5), paid_amount: 500.5, owed: 500.5 },
  { party_key: 'partner:foodmandu', buyer_name: 'Foodmandu', buyer_phone: '', delivery_partner: 'Foodmandu', invoice_fy: '82/83', invoice_prefix: 'CAC', received: 0, commission: 0, order_id: 'p1', invoice_no: 20, closed_at: ago(100), paid_amount: 2000, owed: 2000 },
]
const RECEIPT = { receipt_id: 'r9', receipt_no: 9, invoice_fy: '82/83', received_at: new Date(NOW).toISOString(), bills: [{ order_id: 'o1', owed: 0, settled: true }, { order_id: 'o2', owed: 300.5, settled: false }], replayed: false }

beforeEach(() => {
  mockState.bills = BILLS
  mockState.openBillsError = null
  mockState.shiftOpen = true
  mockState.recordAnswers = []
  mockState.receipts = []
  mockState.legacy = []
  mockState.linesForLegacy = []
  mockCalls.rpc = []
  mockCalls.update = []
  mockUuid = 0
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(window, 'open').mockReturnValue(null)
})
afterEach(() => jest.restoreAllMocks())

const renderTab = () => render(<CreditTab vatReg prefix="CAC" deliveryPartners={[]} settingsRead />)

describe('Who owes', () => {
  test('one row per party, most owed first, the over-limit customer marked, figures from the server', async () => {
    renderTab()
    const table = (await screen.findAllByRole('table'))[0]
    const rows = within(table).getAllByRole('row').slice(1, -1)
    expect(rows[0]).toHaveTextContent('Foodmandu')
    expect(rows[0]).toHaveTextContent('Delivery partner')
    expect(rows[1]).toHaveTextContent('Hari')
    expect(rows[1]).toHaveTextContent('Over limit')
    expect(rows[1]).toHaveTextContent('1,500.50')
    expect(screen.getByText('NPR 3,500.50')).toBeInTheDocument()
    expect(mockCalls.rpc).toContainEqual({ name: 'pos_credit_open_bills', args: { p_client_id: 'c1' } })
  })

  test('a failed read is the error card, never "nobody owes"', async () => {
    mockState.openBillsError = { code: '42501', message: 'permission denied' }
    renderTab()
    expect(await screen.findByText('Could not load this report')).toBeInTheDocument()
    expect(screen.queryByText('Nobody owes anything on Credit now.')).not.toBeInTheDocument()
    expect(screen.queryByText('Owed now')).not.toBeInTheDocument()
  })
})

async function openReceive() {
  renderTab()
  // The table's button; the phone list beside it carries the same one (CSS shows one or the other).
  const button = (await screen.findAllByRole('button', { name: 'Receive payment from Hari' }))[0]
  button.focus()
  fireEvent.click(button)
  return screen.findByRole('dialog', { name: /Receive payment — Hari/ })
}

describe('Receive payment', () => {
  test('the oldest bill fills first, and more than is owed is refused', async () => {
    const dialog = await openReceive()
    const amount = await within(dialog).findByLabelText(/Amount received/)
    fireEvent.change(amount, { target: { value: '1200' } })
    expect(within(dialog).getByLabelText('Paying now on bill TI12-CAC-82/83')).toHaveValue('1000')
    expect(within(dialog).getByLabelText('Paying now on bill TI15-CAC-82/83')).toHaveValue('200')
    fireEvent.change(amount, { target: { value: '1500.51' } })
    expect(within(dialog).getByText(/NPR 1,500.51 is more than the NPR 1,500.50 still owed\. A customer can never pay more than they owe/)).toBeInTheDocument()
    expect(mockCalls.rpc.some(c => c.name === 'record_credit_receipt')).toBe(false)
  })

  test('recorded: one call with the request id and the lines, then the receipt line', async () => {
    mockState.recordAnswers = [{ data: RECEIPT, error: null, status: 200 }]
    const dialog = await openReceive()
    fireEvent.change(await within(dialog).findByLabelText(/Amount received/), { target: { value: '1200' } })
    fireEvent.change(within(dialog).getByLabelText(/Paid by/), { target: { value: 'Cash' } })
    expect(within(dialog).getByText(/NPR 1,200.00 from Hari by Cash: clears TI12-CAC-82\/83 in full/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record NPR 1,200.00' }))
    expect(await screen.findByText(/Receipt RC-9 \(82\/83\): NPR 1,200.00 from Hari by Cash\. 1 bill paid in full/)).toBeInTheDocument()
    const call = mockCalls.rpc.find(c => c.name === 'record_credit_receipt')
    expect(call.args).toEqual({
      p_request_id: 'req-1', p_party_key: 'phone:9841234567', p_method: 'Cash', p_amount: 1200,
      p_lines: [{ order_id: 'o1', amount: 1000, commission: 0 }, { order_id: 'o2', amount: 200, commission: 0 }],
      p_reference: null, p_note: null,
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // The print window was blocked here, so the line says how to print it.
    expect(await screen.findByText(/The receipt did not print/)).toBeInTheDocument()
  })

  test('Cash with no shift open says so up front', async () => {
    mockState.shiftOpen = false
    const dialog = await openReceive()
    fireEvent.change(await within(dialog).findByLabelText(/Paid by/), { target: { value: 'Cash' } })
    expect(await within(dialog).findByText('No shift is open.')).toBeInTheDocument()
  })

  test('no answer twice: not known, and Check again sends the SAME request id', async () => {
    const lost = { data: null, error: { message: 'TypeError: Failed to fetch' }, status: 0 }
    mockState.recordAnswers = [lost, lost, { data: { ...RECEIPT, replayed: true }, error: null, status: 200 }]
    const dialog = await openReceive()
    fireEvent.change(await within(dialog).findByLabelText(/Amount received/), { target: { value: '1200' } })
    fireEvent.change(within(dialog).getByLabelText(/Paid by/), { target: { value: 'eSewa' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record NPR 1,200.00' }))
    expect(await screen.findByText(/Not known yet: NPR 1,200.00 from Hari by eSewa/)).toBeInTheDocument()
    // Another payment from the same customer waits for this one.
    fireEvent.click(screen.getAllByRole('button', { name: 'Receive payment from Hari' })[0])
    expect(await screen.findByText(/Press Check again first, so it is never recorded twice/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText(/Receipt RC-9 \(82\/83\)/)).toBeInTheDocument()
    const ids = mockCalls.rpc.filter(c => c.name === 'record_credit_receipt').map(c => c.args.p_request_id)
    expect(ids).toEqual(['req-1', 'req-1', 'req-1'])
    expect(screen.queryByText(/Not known yet/)).not.toBeInTheDocument()
  })
})

describe('Collected', () => {
  test('receipts and old whole-bill settlements, a bill paid by receipts not listed twice; Cancel names the amount and the drawer', async () => {
    mockState.receipts = [{
      id: 'r7', receipt_no: 7, invoice_fy: '82/83', party_key: 'phone:9841234567', party_name: 'Hari', party_phone: '9841234567',
      method: 'Cash', reference: null, amount: 750, commission_total: 0, note: null, received_by: 'me',
      received_at: new Date(NOW).toISOString(), print_count: 1, cancelled_at: null, cancelled_by: null, cancel_reason: null,
    }]
    mockState.legacy = [
      { id: 'b1', invoice_no: 3, invoice_fy: '82/83', invoice_prefix: 'CAC', paid_amount: 400, commission_amount: null, buyer_name: 'Sita', delivery_partner: null, credit_settled_at: new Date(NOW).toISOString(), credit_settled_by: 'me', credit_settled_method: 'Card', vat_registered: true },
      { id: 'b2', invoice_no: 4, invoice_fy: '82/83', invoice_prefix: 'CAC', paid_amount: 999, commission_amount: null, buyer_name: 'Gita', delivery_partner: null, credit_settled_at: new Date(NOW).toISOString(), credit_settled_by: 'me', credit_settled_method: 'Mixed', vat_registered: true },
    ]
    mockState.linesForLegacy = [{ id: 'lx', order_id: 'b2' }]
    renderTab()
    fireEvent.click(await screen.findByRole('tab', { name: 'Collected' }))
    const table = (await screen.findAllByRole('table'))[0]
    expect(within(table).getByText('RC-7')).toBeInTheDocument()
    expect(within(table).getByText('TI3-CAC-82/83')).toBeInTheDocument()
    expect(within(table).queryByText('TI4-CAC-82/83')).not.toBeInTheDocument()
    expect(screen.getByText('NPR 1,150.00')).toBeInTheDocument() // 750 + 400 received

    const cancel = within(table).getByRole('button', { name: 'Cancel receipt RC-7' })
    cancel.focus()
    fireEvent.click(cancel)
    const dialog = await screen.findByRole('dialog', { name: 'Cancel receipt RC-7?' })
    expect(dialog).toHaveTextContent('Receipt RC-7 (82/83) for NPR 750.00 from Hari is marked Cancelled')
    expect(dialog).toHaveTextContent('NPR 750.00 leaves the cash drawer')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Say why first' }))
    expect(await within(dialog).findByText(/Say why the payment is being cancelled/)).toBeInTheDocument()
    expect(mockCalls.rpc.some(c => c.name === 'cancel_credit_receipt')).toBe(false)
    fireEvent.change(within(dialog).getByLabelText(/Why is it being cancelled/), { target: { value: 'Entered twice' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel this receipt' }))
    expect(await screen.findByText(/Receipt RC-7 is cancelled\. NPR 750.00 went on the open shift as cash taken out/)).toBeInTheDocument()
    expect(mockCalls.rpc.find(c => c.name === 'cancel_credit_receipt').args).toEqual({ p_receipt_id: 'r7', p_reason: 'Entered twice' })
  })
})
