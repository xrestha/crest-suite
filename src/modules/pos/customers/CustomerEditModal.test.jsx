import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import CustomerEditModal from './CustomerEditModal'
import { todayNepalAdIso } from '../reports/reportRange'
import { cardExpiryIso } from './membershipForm'

// S843: the customer edit dialog. No date is saved without the customer's agreement; an agreement
// already recorded names who recorded it and can be withdrawn, which removes both dates in the same
// save; a supervisor never sends the card columns; a refused or row-less save says nothing was saved.
//
// jest.mock factories may only reach variables named mock*; plain functions, not jest.fn (CRA resets
// mock implementations).
const mockState = { answer: null, patches: [] }
function mockUpdate(table, patch) {
  mockState.patches.push({ table, patch })
  const b = {}
  for (const op of ['eq', 'select', 'abortSignal']) b[op] = () => b
  b.then = (ok, bad) => Promise.resolve(mockState.answer).then(ok, bad)
  return b
}
jest.mock('../../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({ clientId: 'c1', scopedUpdate: mockUpdate }),
}))
jest.mock('../../../supabaseClient', () => ({
  supabase: { rpc: () => Promise.resolve({ data: [{ id: 'u1', full_name: 'Ram' }], error: null }) },
}))

const PLAIN = {
  id: 'cust-1', name: 'Asha', phone: '9800000001', membership_type_id: null, card_no: null, card_issued_on: null,
  card_expires_on: null, credit_limit: null, birth_month: null, birth_day: null, birth_year: null, birth_calendar: null,
  anniv_month: null, anniv_day: null, anniv_year: null, anniv_calendar: null, consent_at: null, consent_by: null,
}
const AGREED = { ...PLAIN, consent_at: '2026-10-01T04:00:00+00:00', consent_by: 'u1', birth_month: 6, birth_day: 29, birth_year: null, birth_calendar: 'BS' }
const TYPES = [
  { id: 't1', name: 'Gold', discount_pct: 10, valid_months: 12, is_active: true },
  { id: 't2', name: 'Old', discount_pct: 5, valid_months: null, is_active: false },
]

function open(customer, props = {}) {
  const saved = []
  const closed = []
  render(<CustomerEditModal customer={customer} types={TYPES} canManage={false} onClose={() => closed.push(1)}
    onSaved={row => saved.push(row)} {...props} />)
  return { saved, closed }
}

beforeEach(() => {
  mockState.answer = { data: [{ id: 'cust-1' }], error: null }
  mockState.patches = []
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

test('a date is not saved until the customer agreed; then the agreement goes with it', async () => {
  const { saved } = open(PLAIN)
  // A supervisor sees the card read-only.
  expect(screen.getByText('A POS manager or the Owner gives cards and sets credit limits.')).toBeInTheDocument()
  expect(screen.queryByLabelText(/Card type/)).not.toBeInTheDocument()

  fireEvent.change(screen.getByLabelText('Birthday month'), { target: { value: '6' } })
  fireEvent.change(screen.getByLabelText('Birthday day'), { target: { value: '29' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('Tick that the customer agreed before saving a birthday or an anniversary.')).toBeInTheDocument()
  expect(mockState.patches).toEqual([])

  fireEvent.click(screen.getByLabelText('Customer agreed that we keep their birthday and anniversary to send wishes and offers'))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(mockState.patches).toHaveLength(1)
  const { table, patch } = mockState.patches[0]
  expect(table).toBe('pos_customers')
  expect(patch).toMatchObject({ birth_month: 6, birth_day: 29, birth_calendar: 'BS' })
  expect(typeof patch.consent_at).toBe('string')
  expect('birth_year' in patch).toBe(false) // an empty year that was empty is not sent
  expect(Object.keys(patch).some(k => /card|membership|credit/.test(k))).toBe(false)
})

test('a recorded agreement names who recorded it, and withdrawing it removes both dates', async () => {
  const { saved } = open(AGREED)
  expect(await screen.findByText(/Agreed on 15 Ashwin 2083, recorded by Ram\./)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw agreement — this removes both dates' }))
  expect(screen.getByText('Saving takes back their agreement and removes both dates.')).toBeInTheDocument()
  expect(screen.queryByLabelText('Birthday month')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(mockState.patches[0].patch).toEqual({
    birth_month: null, birth_day: null, birth_calendar: null, consent_at: null,
  })
})

test('a manager gives a card: given today, expiring by the type, the number in capitals', async () => {
  const { saved } = open(PLAIN, { canManage: true })
  // A switched-off type is not offered to a customer who does not hold it.
  expect(screen.queryByRole('option', { name: /Old/ })).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText(/Card type/), { target: { value: 't1' } })
  fireEvent.change(screen.getByLabelText(/Card number/), { target: { value: ' gold-7 ' } })
  fireEvent.change(screen.getByLabelText(/Credit limit/), { target: { value: '5000' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(saved).toHaveLength(1))
  const today = todayNepalAdIso()
  expect(mockState.patches[0].patch).toEqual({
    membership_type_id: 't1', card_no: 'GOLD-7', card_issued_on: today, card_expires_on: cardExpiryIso(today, 12), credit_limit: 5000,
  })
})

test('a card number another customer holds is named, and nothing closes', async () => {
  mockState.answer = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "pos_customers_client_card_no_key"' } }
  const { saved } = open(PLAIN, { canManage: true })
  fireEvent.change(screen.getByLabelText(/Card type/), { target: { value: 't1' } })
  fireEvent.change(screen.getByLabelText(/Card number/), { target: { value: 'gold-7' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText(/^Another customer already holds card GOLD-7, so nothing was saved\./)).toBeInTheDocument()
  expect(saved).toEqual([])
})

test('a save that changes no row says nothing was saved', async () => {
  mockState.answer = { data: [], error: null }
  const { saved } = open(PLAIN, { canManage: true })
  fireEvent.change(screen.getByLabelText(/Credit limit/), { target: { value: '100' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText(/^Nothing was saved: this login could not change this customer/)).toBeInTheDocument()
  expect(saved).toEqual([])
})

test('taking a card away asks first and names what the customer loses', async () => {
  const member = { ...PLAIN, membership_type_id: 't1', card_no: 'GOLD-7', card_issued_on: '2026-10-15', card_expires_on: null }
  const { saved } = open(member, { canManage: true })
  fireEvent.change(screen.getByLabelText(/Card type/), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  const dialog = await screen.findByRole('dialog', { name: "Take Asha's Gold card away?" })
  expect(dialog).toHaveTextContent('From their next bill the till gives Asha no 10% card discount')
  expect(mockState.patches).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Take the card away' }))
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(mockState.patches[0].patch).toEqual({ membership_type_id: null, card_no: null, card_issued_on: null })
})
