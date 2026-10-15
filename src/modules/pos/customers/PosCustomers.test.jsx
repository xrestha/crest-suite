import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import PosCustomers from './PosCustomers'

// S842: settling a Credit bill asks first and says what will happen; what the press did is said beside
// that bill (a status when it settled, ActionError with the server's answer when it did not); and the
// customer search says how much of the book it shows.
//
// The page's reads and writes are faked per table. jest.mock factories may only reach variables named
// mock*; they are read at call time. Plain functions, not jest.fn: CRA resets mock implementations.
const mockState = {}
const mockCalls = { update: [], insert: [] }
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
  for (const op of ['select', 'eq', 'is', 'in', 'order', 'limit', 'abortSignal']) b[op] = () => b
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
  supabase: { from: table => mockBuilder('select', table), rpc: () => mockBuilder('select', 'rpc'), auth: {} },
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
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

async function openSettle() {
  render(<PosCustomers />)
  fireEvent.click(await screen.findByRole('tab', { name: /Outstanding Credit/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'Settle' }))
}
// A browser focuses a clicked button and jsdom does not; the dialog hands focus back to its opener.
function press(name) {
  const button = screen.getByRole('button', { name })
  button.focus()
  fireEvent.click(button)
}

describe('Settle on Outstanding Credit (S842)', () => {
  test('a method press asks first, says what will happen, and Cancel writes nothing', async () => {
    await openSettle()
    expect(screen.getByRole('button', { name: 'Cancel settling' })).toBeInTheDocument()
    press('Cash')

    const dialog = await screen.findByRole('dialog', { name: "Settle Hari's bill by Cash?" })
    expect(dialog).toHaveTextContent('Bill TI12-CAC-82/83 from Hari, NPR 3,000, is marked as paid by Cash.')
    expect(dialog).toHaveTextContent("NPR 3,000 goes on the open shift's drawer record as a Cash In")
    expect(dialog).toHaveTextContent('A settlement cannot be undone')
    expect(mockCalls.update).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mockCalls.update).toEqual([])
    expect(mockCalls.insert).toEqual([])
  })

  test('another method says nothing goes into the drawer', async () => {
    await openSettle()
    press('eSewa')
    const dialog = await screen.findByRole('dialog', { name: "Settle Hari's bill by eSewa?" })
    expect(dialog).toHaveTextContent('Nothing goes into the cash drawer count')
    expect(screen.getByRole('button', { name: 'Settle as eSewa' })).toBeInTheDocument()
  })

  test('confirmed: settled once, the cash goes on the shift, and the line where the row was says so and takes focus', async () => {
    await openSettle()
    press('Cash')
    fireEvent.click(await screen.findByRole('button', { name: 'Settle as Cash' }))

    const line = await screen.findByText(/NPR 3,000 collected from Hari via Cash\. Added to the open shift's cash count\. It is under Collected now\./)
    expect(line).toHaveAttribute('role', 'status')
    expect(mockCalls.update).toHaveLength(1)
    expect(mockCalls.update[0]).toMatchObject({ credit_settled_by: 'me', credit_settled_method: 'Cash' })
    expect(mockCalls.insert).toHaveLength(1)
    expect(mockCalls.insert[0]).toMatchObject({ amount: 3000, kind: 'credit_settlement', shift_id: 'shift-1' })
    // The bill left Outstanding, so the line stands where its row was.
    expect(screen.getByText('No outstanding credit — all Credit bills have been collected. 🎉')).toBeInTheDocument()
    await waitFor(() => expect(line.parentElement).toHaveFocus()) // eslint-disable-line testing-library/no-node-access
  })

  test('a refusal is an alert beside the bill, with the server answer as fine print', async () => {
    mockState.updateAnswer = { data: null, status: 403, error: { code: '42501', hint: 'rank_required', message: 'pos_orders: settling a credit bill needs POS Supervisor access or above' } }
    await openSettle()
    press('Cash')
    fireEvent.click(await screen.findByRole('button', { name: 'Settle as Cash' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/^The bill was not marked as settled\./)
    expect(alert).toHaveTextContent('42501 · pos_orders: settling a credit bill needs POS Supervisor access or above')
    // Under the bill's own row, in the Outstanding table.
    expect(alert.closest('tr').previousElementSibling).toHaveTextContent('TI12-CAC-82/83') // eslint-disable-line testing-library/no-node-access
    expect(mockCalls.insert).toEqual([])
    // The panel stays open, so focus went back to the method pressed.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cash' })).toHaveFocus())
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
