/**
 * Take deposit (S854): the amount must be more than zero (typed sums through evalMath), a way of paying
 * must be picked, and Record is one call carrying the amount, the method and one request id for the
 * dialog. A press with no answer stays open on Check again, which sends that same id.
 */
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'

const mockRecord = jest.fn()
jest.mock('./depositApi', () => {
  const actual = jest.requireActual('./depositApi')
  return { ...actual, recordDeposit: (...a) => mockRecord(...a) }
})
jest.mock('../../../supabaseClient', () => ({ supabase: { rpc: jest.fn() } }))
let mockIds = 0
jest.mock('../../../utils/uuid', () => ({ randomUUID: () => `req-${++mockIds}` }))
function mockBuilder() {
  const b = {}
  for (const op of ['eq', 'limit', 'order', 'in']) b[op] = () => b
  b.then = (ok, bad) => Promise.resolve({ data: [{ id: 's1' }], error: null }).then(ok, bad)
  return b
}
// One object, as the real hook memoises it: a new scopedFrom per render would re-run the shift read forever.
const mockDb = { scopedFrom: () => mockBuilder() }
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockDb }))

// eslint-disable-next-line import/first
import DepositModal from './DepositModal'

const reservation = { id: 'r1', customer_name: 'Sharma', party_size: 25, reserved_for: '2026-10-25T13:30:00Z', status: 'confirmed' }

beforeEach(() => {
  mockRecord.mockReset()
  jest.spyOn(window, 'open').mockReturnValue(null)
})
afterEach(() => jest.restoreAllMocks())

// Rendered inside act, so the open-shift read the dialog makes on opening has landed before a test reads it.
async function open(onAnswered = jest.fn()) {
  await act(async () => { render(<DepositModal reservation={reservation} onClose={jest.fn()} onAnswered={onAnswered} />) })
  return onAnswered
}

test('a zero or missing amount is refused on the press, and nothing is sent', async () => {
  await open()
  fireEvent.change(screen.getByLabelText(/Deposit amount/), { target: { value: '0' } })
  fireEvent.change(screen.getByLabelText(/Paid by/), { target: { value: 'Cash' } })
  fireEvent.click(screen.getByRole('button', { name: /Record deposit/ }))
  expect(await screen.findByText('A deposit is more than zero.')).toBeInTheDocument()
  expect(mockRecord).not.toHaveBeenCalled()
})

test('a way of paying must be picked', async () => {
  await open()
  fireEvent.change(screen.getByLabelText(/Deposit amount/), { target: { value: '5000' } })
  fireEvent.click(screen.getByRole('button', { name: /Record deposit/ }))
  expect(await screen.findByText('Choose how the guest paid.')).toBeInTheDocument()
  expect(mockRecord).not.toHaveBeenCalled()
})

test('Record sends the amount (a typed sum worked out) and the method, and hands the deposit back', async () => {
  const deposit = { id: 'd1', receipt_no: 4, invoice_fy: '2083/84', amount: 10000, method: 'eSewa' }
  mockRecord.mockResolvedValueOnce({ status: 'recorded', deposit, lost: false })
  const onAnswered = await open()
  fireEvent.change(screen.getByLabelText(/Deposit amount/), { target: { value: '2500*4' } })
  fireEvent.change(screen.getByLabelText(/Paid by/), { target: { value: 'eSewa' } })
  fireEvent.click(screen.getByRole('button', { name: 'Record NPR 10,000' }))
  await waitFor(() => expect(onAnswered).toHaveBeenCalled())
  expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
    reservationId: 'r1', amount: 10000, method: 'eSewa', requestId: expect.any(String), priorLost: false,
  }))
  expect(onAnswered.mock.calls[0][0].result.deposit).toBe(deposit)
})

test('no answer keeps the dialog on Check again, which resends the same request id', async () => {
  mockRecord.mockResolvedValueOnce({ status: 'unknown', error: { message: 'TypeError: Failed to fetch' }, lost: true })
  const onAnswered = await open()
  fireEvent.change(screen.getByLabelText(/Deposit amount/), { target: { value: '3000' } })
  fireEvent.change(screen.getByLabelText(/Paid by/), { target: { value: 'Cash' } })
  fireEvent.click(screen.getByRole('button', { name: 'Record NPR 3,000' }))
  expect(await screen.findByRole('button', { name: 'Check again' })).toBeInTheDocument()
  expect(screen.getByText(/it is not known whether the deposit/)).toBeInTheDocument()
  mockRecord.mockResolvedValueOnce({ status: 'replayed', deposit: { id: 'd1' }, lost: true })
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
  await waitFor(() => expect(onAnswered).toHaveBeenCalled())
  const [first, second] = mockRecord.mock.calls.map(c => c[0])
  expect(second.requestId).toBe(first.requestId)
  expect(second.priorLost).toBe(true)
})

test('the receipt carries no VAT, and says so before the press', async () => {
  await open()
  fireEvent.change(screen.getByLabelText(/Deposit amount/), { target: { value: '5000' } })
  fireEvent.change(screen.getByLabelText(/Paid by/), { target: { value: 'Card' } })
  expect(screen.getByText(/with no VAT on it/)).toBeInTheDocument()
  expect(screen.getByText(/VAT is charged on the final bill/)).toBeInTheDocument()
})
