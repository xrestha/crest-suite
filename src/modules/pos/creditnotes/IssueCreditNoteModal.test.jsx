/**
 * S843: a Credit bill can be paid in parts, so the Credit Note dialog says what has been paid on it
 * before "Was money returned?" is answered. Words only: the cash refund stays the server's figure.
 */
import { render, screen, fireEvent } from '@testing-library/react'

// The dialog's reads, by table, and the Issue insert (a promise each test sets).
const mockTables = {
  pos_order_items: { data: [{ recipe_id: null, name: 'Momo', qty: 2, unit_price: 200, vat_rate: 0.13, comped: false }], error: null },
  pos_orders: { data: { vat_registered: true, payment_method: 'Cash', paid_amount: 452, credit_settled_at: null }, error: null },
  settings: { data: { is_vat_registered: true, invoice_prefix: 'CA', vat_number: '', property_address: '', property_phone: '' }, error: null },
  clients: { data: { name: 'Casa Acai' }, error: null },
}
function mockBuilder(table) {
  const b = {}
  for (const op of ['select', 'eq', 'in', 'not', 'gte', 'order', 'maybeSingle', 'single']) b[op] = () => b
  b.then = (ok, fail) => Promise.resolve(mockTables[table]).then(ok, fail)
  return b
}
let mockInsert = () => new Promise(() => {})
const mockScopedDb = { scopedFrom: t => mockBuilder(t), scopedInsert: () => mockInsert() }
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockScopedDb }))
jest.mock('../../../supabaseClient', () => ({
  supabase: { from: t => mockBuilder(t), rpc: () => Promise.resolve({ data: 452, error: null }) /* cash taken, so Cash is on */ },
}))
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ clientId: 'c1', profile: { id: 'u1', full_name: 'Sita' }, hasPosAccess: () => true, isAdmin: false, imsEnabled: false, clientModules: {} }),
}))

// eslint-disable-next-line import/first
import IssueCreditNoteModal, { CreditBillPaidLine } from './IssueCreditNoteModal'

const ORDER = { id: 'o1', invoice_no: 45, invoice_fy: '2082/83', order_no: 9, closed_at: '2026-10-14T06:00:00Z', discount_amount: 0, buyer_name: 'Ram' }
async function openDialog() {
  render(<IssueCreditNoteModal order={ORDER} onClose={() => {}} onIssued={() => {}} />)
  await screen.findByText(/Net amount to credit/)
}
const fields = () => [
  screen.getByLabelText(/^Reason/), screen.getByLabelText('Buyer Name'), screen.getByLabelText('Buyer PAN'),
  screen.getByLabelText('Address'), screen.getByLabelText('Phone'),
  ...screen.getAllByRole('radio'), ...screen.getAllByRole('button', { name: /Wrong customer|Tax correction|Duplicate bill/ }),
]

beforeEach(() => { mockInsert = () => new Promise(() => {}) })

test('the fields are the shared .form-field controls in a .field-grid, with no hand-rolled style', async () => {
  await openDialog()
  const name = screen.getByLabelText('Buyer Name')
  expect(name.getAttribute('style')).toBeNull()
  expect(name.closest('.form-field')).not.toBeNull() // eslint-disable-line testing-library/no-node-access
  expect(name.closest('.field-grid')).not.toBeNull() // eslint-disable-line testing-library/no-node-access
  expect(screen.getByLabelText(/^Reason/).closest('.form-field')).not.toBeNull() // eslint-disable-line testing-library/no-node-access
})

test('every field is locked while the note is being issued', async () => {
  await openDialog()
  for (const f of fields()) expect(f).not.toBeDisabled()
  fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Wrong customer' } })
  fireEvent.click(screen.getByRole('radio', { name: 'None' }))
  fireEvent.click(screen.getByRole('button', { name: 'Issue & Print' }))
  expect(await screen.findByRole('button', { name: 'Issuing…' })).toBeDisabled()
  for (const f of fields()) expect(f).toBeDisabled()
})

test('no reason marks the Reason box itself, not a coloured line', async () => {
  await openDialog()
  fireEvent.click(screen.getByRole('button', { name: 'Enter a reason first' }))
  const box = screen.getByLabelText(/^Reason/)
  expect(box).toHaveAttribute('aria-invalid', 'true')
  expect(screen.getByText('Enter a reason for this Credit Note.')).toBeInTheDocument()
})

test('a refused Issue is an ActionError: the sentence, with the code and message as fine print', async () => {
  mockInsert = () => Promise.resolve({ data: null, error: { code: '23514', message: 'new row violates check constraint' } })
  await openDialog()
  fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Duplicate bill' } })
  fireEvent.click(screen.getByRole('radio', { name: 'None' }))
  fireEvent.click(screen.getByRole('button', { name: 'Issue & Print' }))
  const alert = await screen.findByText(/The credit note was not issued — nothing has changed\./)
  expect(alert).toHaveClass('action-error-text')
  expect(screen.getByText('23514 · new row violates check constraint')).toHaveClass('action-error-detail')
  for (const f of fields()) expect(f).not.toBeDisabled()
})

test('a part-paid Credit bill names what was paid, the cash part, and the rest still owed', () => {
  render(<CreditBillPaidLine creditPaid={{ totals: { received: 700, commission: 0, cash: 400 } }} bill={{ paid_amount: 1130, credit_settled_at: null }} cashOut={400} />)
  const p = screen.getByText(/This Credit bill has been paid/)
  expect(p).toHaveTextContent('paid NPR 700 so far, NPR 400 of it in cash; the NPR 430 still owed is simply cleared by the note.')
  expect(p).toHaveTextContent('NPR 400 from the drawer if you choose Cash, and what was paid by card, QR or bank goes back that way, as Other.')
})

test('a Credit bill nobody has paid anything on says no money goes back', () => {
  render(<CreditBillPaidLine creditPaid={{ totals: null }} bill={{ paid_amount: 1130, credit_settled_at: null }} cashOut={0} />)
  expect(screen.getByText(/Nothing has been paid on this Credit bill yet/)).toHaveTextContent('choose None')
})

test('a bill settled whole before part payments says nothing more', () => {
  const { container } = render(<CreditBillPaidLine creditPaid={{ totals: null }} bill={{ paid_amount: 1130, credit_settled_at: '2026-10-01T05:00:00Z' }} cashOut={1130} />)
  expect(container).toBeEmptyDOMElement()
})

test('a failed read says so, and never reads as nothing paid', () => {
  render(<CreditBillPaidLine creditPaid={{ error: { message: 'Failed to fetch' } }} bill={{ paid_amount: 1130 }} cashOut={0} />)
  expect(screen.getByText(/Could not read what has been paid/)).toBeInTheDocument()
  expect(screen.queryByText(/Nothing has been paid/)).toBeNull()
})
