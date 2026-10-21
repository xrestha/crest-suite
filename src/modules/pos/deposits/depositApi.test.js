/**
 * Booking deposits (S854), the server half, against a mocked supabase: the balance maths it re-exports,
 * every error handed back as the Supabase error OBJECT (so its code reaches the fine print), a lost
 * answer sent again with the SAME request id, and the deposit refusals worded by their code.
 */
const mockRpc = jest.fn()
const mockAnswers = {}
function mockBuilder(table, cols) {
  const b = { calls: [] }
  for (const op of ['eq', 'in', 'order', 'range', 'limit', 'or']) b[op] = (...args) => { b.calls.push([op, args]); return b }
  b.then = (ok, bad) => {
    const a = mockAnswers[`${table}:${cols}`]
    const ans = typeof a === 'function' ? a(b.calls) : (a || { data: [], error: null })
    return Promise.resolve(ans).then(ok, bad)
  }
  return b
}
jest.mock('../../../supabaseClient', () => ({ supabase: { rpc: (...a) => mockRpc(...a) } }))
jest.mock('../../../shared/scopedDb', () => ({ scopedFrom: (table, _clientId, cols) => mockBuilder(table, cols) }))

// eslint-disable-next-line import/first
import {
  depositBalance, loadReservationDeposits, loadOrderDeposit, recordDeposit, refundDeposit, applyDeposit,
  depositErrorInfo, recordOutcome, refundOutcome,
} from './depositApi'
// eslint-disable-next-line import/first
import { DEPOSIT_COLS } from './depositState'

const refusal = (hint, message, code = 'P0001') => ({ data: null, error: { code, hint, message }, status: 400 })
const dropped = () => ({ data: null, error: { message: 'TypeError: Failed to fetch' }, status: 0 })
const row = over => ({ id: 'd1', reservation_id: 'r1', receipt_no: 3, invoice_fy: '2083/84', amount: 4000, method: 'Cash', used_amount: 0, refunded_amount: 0, order_id: null, ...over })

beforeEach(() => {
  mockRpc.mockReset()
  for (const k of Object.keys(mockAnswers)) delete mockAnswers[k]
})

describe('depositBalance (re-exported)', () => {
  it('is what is left after the bill and any refund', () => {
    expect(depositBalance(row({ used_amount: 2500.25 }))).toBe(1499.75)
    expect(depositBalance(row({ used_amount: 2500, refunded_amount: 1500 }))).toBe(0)
  })
})

describe('recordDeposit', () => {
  it('sends the press with its request id and answers the deposit the server recorded', async () => {
    mockRpc.mockResolvedValueOnce({ data: { ...row(), replayed: false }, error: null, status: 200 })
    const r = await recordDeposit({ reservationId: 'r1', amount: 4000, method: 'Cash', requestId: 'q1', note: '  ' })
    expect(mockRpc).toHaveBeenCalledWith('record_booking_deposit', {
      p_reservation_id: 'r1', p_amount: 4000, p_method: 'Cash', p_request_id: 'q1', p_note: null,
    })
    expect(r).toMatchObject({ status: 'recorded', deposit: { id: 'd1' }, lost: false })
  })

  it('hands a refusal back as the error object, untouched, sent once', async () => {
    const res = refusal('booking_deposit_exists', 'booking_deposit_exists: this booking already holds a deposit')
    mockRpc.mockResolvedValueOnce(res)
    const r = await recordDeposit({ reservationId: 'r1', amount: 10, method: 'eSewa', requestId: 'q1' })
    expect(r.status).toBe('refused')
    expect(r.error).toBe(res.error)
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('a lost answer is sent again with the same id, and the replay is the first deposit', async () => {
    mockRpc.mockResolvedValueOnce(dropped()).mockResolvedValueOnce({ data: { ...row(), replayed: true }, error: null, status: 200 })
    const r = await recordDeposit({ reservationId: 'r1', amount: 4000, method: 'Cash', requestId: 'q1' })
    expect(mockRpc).toHaveBeenCalledTimes(2)
    expect(mockRpc.mock.calls[1][1].p_request_id).toBe('q1')
    expect(r).toMatchObject({ status: 'replayed', lost: true })
  })

  it('no answer twice is unknown, never refused', async () => {
    mockRpc.mockResolvedValue(dropped())
    const r = await recordDeposit({ reservationId: 'r1', amount: 4000, method: 'Cash', requestId: 'q1' })
    expect(r.status).toBe('unknown')
    expect(r.error.message).toMatch(/Failed to fetch/)
  })
})

describe('refundDeposit', () => {
  it('answers the refund, and passes a refusal object through', async () => {
    mockRpc.mockResolvedValueOnce({ data: { ...row({ refunded_amount: 4000 }), refunded_now: 4000, replayed: false }, error: null, status: 200 })
    expect(await refundDeposit({ depositId: 'd1', requestId: 'f1' })).toMatchObject({ status: 'refunded', deposit: { refunded_now: 4000 } })
    expect(mockRpc).toHaveBeenLastCalledWith('refund_booking_deposit', { p_deposit_id: 'd1', p_request_id: 'f1' })
    const res = refusal('booking_deposit_on_open_bill', 'booking_deposit_on_open_bill: on an open bill')
    mockRpc.mockResolvedValueOnce(res)
    const r = await refundDeposit({ depositId: 'd1', requestId: 'f2' })
    expect(r).toMatchObject({ status: 'refused' })
    expect(r.error).toBe(res.error)
  })
})

describe('applyDeposit', () => {
  it('returns the amount now on the bill as a number', async () => {
    mockRpc.mockResolvedValueOnce({ data: '1500.00', error: null, status: 200 })
    expect(await applyDeposit('o1', 1500)).toEqual({ data: 1500, error: null, noAnswer: false })
    expect(mockRpc).toHaveBeenLastCalledWith('apply_booking_deposit', { p_order_id: 'o1', p_amount: 1500 })
    mockRpc.mockResolvedValueOnce({ data: 0, error: null, status: 200 })
    expect((await applyDeposit('o1', 0)).data).toBe(0)
  })

  it('passes the over-balance refusal through as itself, and marks a lost answer', async () => {
    const res = refusal('booking_deposit_over_balance', 'booking_deposit_over_balance: the deposit has NPR 1000.00 left')
    mockRpc.mockResolvedValueOnce(res)
    const r = await applyDeposit('o1', 2000)
    expect(r).toEqual({ data: null, error: res.error, noAnswer: false })
    mockRpc.mockResolvedValueOnce(dropped())
    expect((await applyDeposit('o1', 2000)).noAnswer).toBe(true)
  })
})

describe('reads', () => {
  it('loadReservationDeposits groups by booking, and a failed read is null, never empty', async () => {
    const db = { scopedFrom: (t, c) => mockBuilder(t, c) }
    mockAnswers[`pos_booking_deposits:${DEPOSIT_COLS}`] = { data: [row(), row({ id: 'd2', reservation_id: 'r2' })], error: null }
    const ok = await loadReservationDeposits(db, ['r1', 'r2', 'r1', null])
    expect(ok.error).toBe(null)
    expect(Object.keys(ok.byReservation).sort()).toEqual(['r1', 'r2'])
    const err = { code: '42P01', message: 'relation "pos_booking_deposits" does not exist' }
    mockAnswers[`pos_booking_deposits:${DEPOSIT_COLS}`] = { data: null, error: err }
    const bad = await loadReservationDeposits(db, ['r1'])
    expect(bad).toEqual({ data: null, byReservation: null, error: err })
    expect(await loadReservationDeposits(db, [])).toEqual({ data: [], byReservation: {}, error: null })
  })

  it('loadOrderDeposit finds the deposit of the booking seated on the bill', async () => {
    mockAnswers[`pos_booking_deposits:${DEPOSIT_COLS}`] = calls => (calls.some(([op]) => op === 'in')
      ? { data: [row()], error: null }
      : { data: [], error: null })
    mockAnswers['pos_reservations:id'] = { data: [{ id: 'r1' }], error: null }
    const r = await loadOrderDeposit('o1', 'c1')
    expect(r.error).toBe(null)
    expect(r.data).toMatchObject({ id: 'd1', balance: 4000, onThisBill: false, label: 'DP-3' })
  })

  it('loadOrderDeposit hands a failed read back, and no bill is no deposit', async () => {
    const err = { message: 'TypeError: Failed to fetch' }
    mockAnswers['pos_reservations:id'] = { data: null, error: err }
    expect(await loadOrderDeposit('o1', 'c1')).toEqual({ data: null, error: err })
    expect(await loadOrderDeposit(null, 'c1')).toEqual({ data: null, error: null })
  })
})

describe('depositErrorInfo', () => {
  it('words each deposit refusal by its code and keeps the detail', () => {
    const e = { code: 'P0001', hint: 'booking_deposit_over_balance', message: 'booking_deposit_over_balance: the deposit has NPR 1000.00 left' }
    const info = depositErrorInfo(e)
    expect(info.text).toMatch(/more than the deposit has left/)
    expect(info.detail).toMatch(/P0001/)
    expect(depositErrorInfo({ hint: 'rank_required', message: 'booking_deposit_rank: needs a supervisor' }).text).toMatch(/supervisor/)
    expect(depositErrorInfo({ hint: 'pos_deposit_split_only', message: 'pos_orders: x' }).text).toMatch(/Split/)
  })

  it('leaves anything else to errorText', () => {
    const info = depositErrorInfo({ message: 'TypeError: Failed to fetch' })
    expect(info.text).not.toMatch(/deposit/i)
    expect(info.detail).toMatch(/Failed to fetch/)
  })
})

describe('outcomes', () => {
  it('a recorded deposit names its receipt and where the cash went; a refusal says nothing was taken', () => {
    const ok = recordOutcome({ status: 'recorded', deposit: { ...row(), customer_name: 'Sharma' } })
    expect(ok).toMatchObject({ kind: 'ok' })
    expect(ok.text).toMatch(/Deposit DP-3 \(2083\/84\): NPR 4,000 from Sharma by Cash\. The cash is on the open shift drawer count\./)
    const no = recordOutcome({ status: 'refused', error: { hint: 'booking_deposit_no_shift', message: 'booking_deposit_no_shift: x' } })
    expect(no.kind).toBe('error')
    expect(no.text).toMatch(/No deposit was taken/)
    expect(recordOutcome({ status: 'unknown', error: {} }).text).toMatch(/Check again/)
  })

  it('a refund names the amount and the way back; unknown never claims either way', () => {
    const ok = refundOutcome({ status: 'refunded', deposit: { ...row({ method: 'eSewa' }), refunded_now: 2500 } }, row(), { customerName: 'Sharma' })
    expect(ok.text).toMatch(/refunded: NPR 2,500\. Pay it back to Sharma by eSewa\./)
    expect(refundOutcome({ status: 'unknown', error: {} }, row(), { checkAgain: false }).text).toMatch(/reload the page/)
  })
})
