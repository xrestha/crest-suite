// S843: a credit payment is ONE call (record_credit_receipt) carrying a request id minted per press. A
// lost answer is sent again with the SAME id, and a retry refused after a lost answer asks once more,
// because the first send may be what made the bills stale; the server answers that with the first
// receipt (replayed). Cancelling is idempotent.
import {
  RECEIPT_METHODS, SETTLE_READ_MS, recordCreditReceipt, cancelCreditReceipt, paymentSummary, recordOutcome,
  cancelConsequence, cancelOutcome, settledWhen,
} from './settleCredit'
import { nepalTime } from '../../../shared/nepalTime'

const ok = data => ({ data, error: null, status: 200 })
const DROPPED = { data: null, error: { message: 'TypeError: Failed to fetch' }, status: 0 }
const GATEWAY = { data: null, error: { message: 'Bad gateway' }, status: 502 }
const STALE = { data: null, status: 400, error: { code: 'P0001', hint: 'credit_receipt_stale', message: 'credit_receipt_stale: bill 12 is no longer an unpaid Credit bill' } }
const OVER = { data: null, status: 400, error: { code: 'P0001', hint: 'credit_receipt_over', message: 'credit_receipt_over: bill 12 still owes NPR 100' } }
const RECEIPT = { receipt_id: 'r1', receipt_no: 7, invoice_fy: '82/83', received_at: '2026-10-15T05:00:00+00:00', bills: [{ order_id: 'o1', owed: 0, settled: true }, { order_id: 'o2', owed: 50, settled: false }], replayed: false }

// The page's supabase.rpc, answering from a queue; a 'hang' never answers. Records every call.
function fakeRpc(answers) {
  const queue = [...answers]
  const calls = []
  const rpc = (name, args, signal) => {
    calls.push({ name, args, signal })
    if (!queue.length) throw new Error(`unexpected ${name} call`)
    const a = queue.shift()
    return a === 'hang' ? new Promise(() => {}) : Promise.resolve(a)
  }
  return { rpc, calls }
}
const PRESS = { requestId: 'req-1', partyKey: 'phone:9841234567', method: 'Cash', amount: 1050.5, lines: [{ order_id: 'o1', amount: 1000, commission: 0 }, { order_id: 'o2', amount: 50.5, commission: 0 }] }

describe('recordCreditReceipt', () => {
  test('answered: one call with the request id, the lines and the trimmed reference', async () => {
    const { rpc, calls } = fakeRpc([ok(RECEIPT)])
    const res = await recordCreditReceipt({ rpc, ...PRESS, reference: '  CHQ 123 ', note: '' })
    expect(res).toMatchObject({ status: 'recorded', receipt: RECEIPT, lost: false })
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('record_credit_receipt')
    expect(calls[0].args).toEqual({
      p_request_id: 'req-1', p_party_key: 'phone:9841234567', p_method: 'Cash', p_amount: 1050.5,
      p_lines: PRESS.lines, p_reference: 'CHQ 123', p_note: null,
    })
  })

  test("the server's refusal is final: not recorded, never sent again", async () => {
    const { rpc, calls } = fakeRpc([OVER])
    const res = await recordCreditReceipt({ rpc, ...PRESS })
    expect(res).toMatchObject({ status: 'refused', error: OVER.error })
    expect(calls).toHaveLength(1)
  })

  test('a lost answer is sent again with the SAME request id; the replay is the first receipt', async () => {
    const { rpc, calls } = fakeRpc([DROPPED, ok({ ...RECEIPT, replayed: true })])
    const res = await recordCreditReceipt({ rpc, ...PRESS })
    expect(res).toMatchObject({ status: 'replayed', lost: true })
    expect(calls.map(c => c.args.p_request_id)).toEqual(['req-1', 'req-1'])
  })

  test('a timeout counts as no answer, and the request is cancelled before it is sent again', async () => {
    const { rpc, calls } = fakeRpc(['hang', ok(RECEIPT)])
    const res = await recordCreditReceipt({ rpc, ...PRESS, ms: 5 })
    expect(res.status).toBe('recorded')
    expect(calls[0].signal.aborted).toBe(true)
    expect(calls).toHaveLength(2)
  })

  test('refused after a lost answer: asked once more, because the first may be what made the bills stale', async () => {
    const { rpc, calls } = fakeRpc([GATEWAY, STALE, ok({ ...RECEIPT, replayed: true })])
    const res = await recordCreditReceipt({ rpc, ...PRESS })
    expect(res.status).toBe('replayed')
    expect(calls).toHaveLength(3)
    expect(new Set(calls.map(c => c.args.p_request_id))).toEqual(new Set(['req-1']))
  })

  test('refused again on that last ask: a real refusal, so nothing was recorded', async () => {
    const { rpc } = fakeRpc([DROPPED, OVER, OVER])
    expect(await recordCreditReceipt({ rpc, ...PRESS })).toMatchObject({ status: 'refused', lost: true })
  })

  test('no answer twice: not known', async () => {
    const { rpc, calls } = fakeRpc([DROPPED, DROPPED])
    expect(await recordCreditReceipt({ rpc, ...PRESS })).toMatchObject({ status: 'unknown', lost: true })
    expect(calls).toHaveLength(2)
  })

  test('Check again (priorLost): a refusal on the first send still asks for the replay', async () => {
    const { rpc, calls } = fakeRpc([STALE, ok({ ...RECEIPT, replayed: true })])
    expect((await recordCreditReceipt({ rpc, ...PRESS, priorLost: true })).status).toBe('replayed')
    expect(calls).toHaveLength(2)
  })

  test('an answer with no receipt is not taken as recorded', async () => {
    const { rpc } = fakeRpc([ok(null)])
    expect((await recordCreditReceipt({ rpc, ...PRESS })).status).toBe('unknown')
  })
})

describe('cancelCreditReceipt', () => {
  const R = { p_receipt_id: 'r1', p_reason: 'Entered twice' }
  test('cancelled, with the reason trimmed', async () => {
    const { rpc, calls } = fakeRpc([ok({ receipt_id: 'r1', already_cancelled: false })])
    expect((await cancelCreditReceipt({ rpc, receiptId: 'r1', reason: '  Entered twice ' })).status).toBe('cancelled')
    expect(calls[0]).toMatchObject({ name: 'cancel_credit_receipt', args: R })
  })
  test('already cancelled before this press', async () => {
    const { rpc } = fakeRpc([ok({ receipt_id: 'r1', already_cancelled: true })])
    expect((await cancelCreditReceipt({ rpc, receiptId: 'r1', reason: 'Entered twice' })).status).toBe('already')
  })
  test('a lost answer, then "already cancelled": it was this press', async () => {
    const { rpc, calls } = fakeRpc([DROPPED, ok({ receipt_id: 'r1', already_cancelled: true })])
    expect((await cancelCreditReceipt({ rpc, receiptId: 'r1', reason: 'Entered twice' })).status).toBe('cancelled')
    expect(calls).toHaveLength(2)
  })
  test('refused, and no answer twice', async () => {
    const refusal = { data: null, status: 400, error: { hint: 'credit_receipt_cancel_no_shift', message: 'credit_receipt_cancel_no_shift: no shift is open' } }
    expect((await cancelCreditReceipt({ rpc: fakeRpc([refusal]).rpc, receiptId: 'r1', reason: 'xyz' })).status).toBe('refused')
    expect((await cancelCreditReceipt({ rpc: fakeRpc([DROPPED, DROPPED]).rpc, receiptId: 'r1', reason: 'xyz' })).status).toBe('unknown')
  })
})

describe('the words', () => {
  test('the methods a receipt can record', () => {
    expect(RECEIPT_METHODS).toEqual(['Cash', 'Card', 'eSewa', 'Khalti', 'FonePay', 'Cheque', 'Bank Transfer'])
    expect(SETTLE_READ_MS).toBe(8000)
  })

  test('settledWhen: the Nepal day and clock time', () => {
    const ts = '2026-10-10T04:57:00.000+00:00'
    expect(settledWhen(ts)).toBe(`24 Ashwin 2083 at ${nepalTime(ts)}`)
  })

  const rows = [
    { ticked: true, amount: 100000, commission: 0, owedAfter: 0, bill: { n: 'TI12' } },
    { ticked: true, amount: 5050, commission: 0, owedAfter: 4950, bill: { n: 'TI15' } },
    { ticked: false, amount: 0, commission: 0, owedAfter: 900, bill: { n: 'TI16' } },
  ]
  test('paymentSummary: the amount, which bills it clears, where the cash goes, and that it is a receipt', () => {
    const lines = paymentSummary({ partyName: 'Hari', method: 'Cash', total: 105050, rows, label: b => b.n, shiftOpen: true })
    expect(lines[0]).toBe('NPR 1,050.50 from Hari by Cash: clears TI12 in full and puts NPR 50.50 against TI15 (NPR 49.50 still owed on it).')
    expect(lines[1]).toMatch(/drawer count expects it/)
    expect(lines[2]).toMatch(/numbered money receipt is recorded and printed/)
    expect(paymentSummary({ partyName: 'Hari', method: 'Cash', total: 105050, rows, label: b => b.n, shiftOpen: false })[1]).toMatch(/No shift is open, so a Cash payment will be refused/)
    expect(paymentSummary({ partyName: 'Hari', method: 'eSewa', total: 105050, rows, label: b => b.n })[1]).toMatch(/Nothing goes into the cash drawer/)
  })
  test('paymentSummary for a partner names the commission it keeps', () => {
    const lines = paymentSummary({ partyName: 'Foodmandu', partner: true, method: 'Bank Transfer', total: 90000, commissionTotal: 10000, rows: [rows[0]], label: b => b.n })
    expect(lines[1]).toBe('Foodmandu keeps NPR 100.00 as commission on these bills, so together they clear NPR 1,000.00.')
  })

  test('recordOutcome: recorded, a lost answer settled, not known, and refused', () => {
    const press = { partyName: 'Hari', method: 'Cash', amount: 1050.5 }
    const okLine = recordOutcome({ status: 'recorded', receipt: RECEIPT }, press)
    expect(okLine.kind).toBe('ok')
    expect(okLine.text).toBe("Receipt RC-7 (82/83): NPR 1,050.50 from Hari by Cash. 1 bill paid in full. The cash is on the open shift's drawer count.")
    expect(recordOutcome({ status: 'replayed', receipt: RECEIPT, lost: true }, press).text).toMatch(/recorded once\.$/)
    const unknown = recordOutcome({ status: 'unknown', error: DROPPED.error }, press)
    expect(unknown.kind).toBe('warn')
    expect(unknown.text).toMatch(/not known whether NPR 1,050.50 from Hari was recorded\. Do not hand any money back/)
    expect(unknown.text).toMatch(/Keep the cash aside/)
    const refused = recordOutcome({ status: 'refused', error: OVER.error }, press)
    expect(refused.kind).toBe('error')
    expect(refused.text).toMatch(/^The payment was not recorded, and no receipt was made\. /)
    expect(refused.error).toBe(OVER.error)
  })

  test('cancelConsequence names the amount and, for Cash, that it leaves the open drawer', () => {
    const r = { receipt_no: 7, invoice_fy: '82/83', amount: 1050.5, party_name: 'Hari', method: 'Cash' }
    const lines = cancelConsequence(r)
    expect(lines[0]).toBe('Receipt RC-7 (82/83) for NPR 1,050.50 from Hari is marked Cancelled, with your reason. It is never deleted.')
    expect(lines[2]).toMatch(/^NPR 1,050.50 leaves the cash drawer: it goes on the OPEN shift as cash taken out/)
    expect(cancelConsequence({ ...r, method: 'eSewa' })[2]).toMatch(/nothing leaves the cash drawer/)
    expect(cancelOutcome({ status: 'cancelled' }, r).text).toBe('Receipt RC-7 is cancelled. NPR 1,050.50 went on the open shift as cash taken out. Its bills are owed again.')
    expect(cancelOutcome({ status: 'already' }, r).kind).toBe('warn')
    expect(cancelOutcome({ status: 'unknown' }, r).text).toMatch(/can only be cancelled once/)
    expect(cancelOutcome({ status: 'refused', error: { message: 'x' } }, r).text).toMatch(/^Receipt RC-7 was not cancelled\. It stands as it was\./)
  })
})
