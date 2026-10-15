// S843: a receipt prints from what the server STORED, first time and every reprint alike: its lines,
// each bill's total, every other receipt on those bills, and the party's history for the balances.
// Any read failing prints nothing; the print count is the server's, and a reprint says COPY.
import { readReceiptForPrint, countReceiptPrint, printCreditReceipt } from './creditReceiptPrint'

// A one-shot answer that can also be paged (fetchAllRows calls .range on a fresh builder).
const answer = res => ({
  range: (from, to) => Promise.resolve(res.error ? res : { data: (res.data || []).slice(from, to + 1), error: null }),
  then: (ok, bad) => Promise.resolve(res).then(ok, bad),
})

const R2 = {
  id: 'r2', receipt_no: 8, invoice_fy: '82/83', party_key: 'phone:9841234567', party_name: 'Hari', method: 'Cash',
  amount: 1000, commission_total: 0, received_at: '2026-10-05T05:00:00+00:00', received_by: 'u1', print_count: 0,
}
const BILLS = [
  { id: 'o1', invoice_no: 12, invoice_fy: '82/83', invoice_prefix: 'CAC', closed_at: '2026-09-01T05:00:00+00:00', paid_amount: 1500, vat_registered: true },
]
const EVENTS = [
  { event_at: '2026-09-01T05:00:00+00:00', kind: 'bill', debit: 1500, credit: 0 },
  { event_at: '2026-09-20T05:00:00+00:00', kind: 'receipt', debit: 0, credit: 400 },
  { event_at: '2026-10-05T05:00:00+00:00', kind: 'receipt', debit: 0, credit: 1000 },
  { event_at: '2026-10-10T05:00:00+00:00', kind: 'receipt', debit: 0, credit: 50 },
]
const ALL_LINES = [
  { id: 'l1', receipt_id: 'r1', order_id: 'o1', amount: 400, commission: 0 },
  { id: 'l2', receipt_id: 'r2', order_id: 'o1', amount: 1000, commission: 0 },
  { id: 'l3', receipt_id: 'r3', order_id: 'o1', amount: 50, commission: 0 },
]
const PARTY_RECEIPTS = [
  { id: 'r1', received_at: '2026-09-20T05:00:00+00:00', cancelled_at: null },
  { id: 'r2', received_at: R2.received_at, cancelled_at: null },
  { id: 'r3', received_at: '2026-10-10T05:00:00+00:00', cancelled_at: null },
]

function fakeDb(over = {}) {
  const calls = []
  const db = {
    receipt: id => { calls.push(['receipt', id]); return answer(over.receipt || { data: R2, error: null }) },
    receiptLines: id => { calls.push(['receiptLines', id]); return answer({ data: [ALL_LINES[1]], error: null }) },
    partyEvents: key => { calls.push(['partyEvents', key]); return answer(over.events || { data: EVENTS, error: null }) },
    partyReceipts: key => { calls.push(['partyReceipts', key]); return answer({ data: PARTY_RECEIPTS, error: null }) },
    billsByIds: ids => { calls.push(['billsByIds', ids]); return answer(over.bills || { data: BILLS, error: null }) },
    linesByOrders: ids => { calls.push(['linesByOrders', ids]); return answer({ data: ALL_LINES, error: null }) },
    bumpPrintCount: (id, count) => { calls.push(['bump', id, count]); return answer(over.bump || { data: { print_count: count }, error: null }) },
  }
  return { db, calls }
}
const label = b => `TI${b.invoice_no}`

describe('readReceiptForPrint', () => {
  test('each bill as at the receipt: still owed after it, and the balances either side', async () => {
    const { db, calls } = fakeDb()
    const { data, error } = await readReceiptForPrint({ db, receiptId: 'r2', partyKey: 'phone:9841234567', label })
    expect(error).toBe(null)
    expect(data.bills).toEqual([{ orderId: 'o1', label: 'TI12', closedAt: BILLS[0].closed_at, amount: 1000, commission: 0, owedAfter: 100 }])
    expect(data.previousBalance).toBe(1100)
    expect(data.newBalance).toBe(100)
    expect(calls.find(c => c[0] === 'partyEvents')[1]).toBe('phone:9841234567')
  })

  test('a failed read is an error, never a receipt with a missing figure', async () => {
    const failed = { data: null, error: { code: '42501', message: 'denied' } }
    expect((await readReceiptForPrint({ db: fakeDb({ events: failed }).db, receiptId: 'r2', partyKey: 'k', label })).error).toEqual(failed.error)
    expect((await readReceiptForPrint({ db: fakeDb({ bills: { data: [], error: null } }).db, receiptId: 'r2', partyKey: 'k', label })).error.message)
      .toMatch(/could not be read/)
    expect((await readReceiptForPrint({ db: fakeDb({ receipt: { data: null, error: null } }).db, receiptId: 'r2', partyKey: 'k', label })).error.message)
      .toMatch(/not found/)
  })
})

describe('countReceiptPrint', () => {
  test('the first print is the original; the next is a COPY; the server count decides', async () => {
    expect(await countReceiptPrint({ db: fakeDb().db, receipt: R2 })).toEqual({ count: 1, label: '', countError: null })
    const again = await countReceiptPrint({ db: fakeDb().db, receipt: { ...R2, print_count: 1 } })
    expect(again.label).toBe('COPY OF ORIGINAL - (1)')
    // Another till printed meanwhile: the server kept the higher count, so this one is the third.
    const raced = await countReceiptPrint({ db: fakeDb({ bump: { data: { print_count: 3 }, error: null } }).db, receipt: { ...R2, print_count: 1 } })
    expect(raced).toEqual({ count: 3, label: 'COPY OF ORIGINAL - (2)', countError: null })
  })
  test('a refused or unmatched count still prints, labelled from what the page knows', async () => {
    const refused = await countReceiptPrint({ db: fakeDb({ bump: { data: null, error: { message: 'rank' } } }).db, receipt: { ...R2, print_count: 2 } })
    expect(refused).toMatchObject({ count: 3, label: 'COPY OF ORIGINAL - (2)' })
    expect(refused.countError).toEqual({ message: 'rank' })
    const none = await countReceiptPrint({ db: fakeDb({ bump: { data: null, error: null } }).db, receipt: R2 })
    expect(none.countError.message).toMatch(/matched no row/)
  })
})

describe('printCreditReceipt', () => {
  const fakeWindow = () => {
    const w = { closed: false, written: '', document: { open: jest.fn(), write: h => { w.written += h }, close: jest.fn() }, focus: jest.fn(), print: jest.fn(), close: jest.fn(() => { w.closed = true }) }
    return w
  }
  test('reads, counts and writes the receipt into the window opened on the press', async () => {
    jest.useFakeTimers()
    const w = fakeWindow()
    const { db, calls } = fakeDb()
    const res = await printCreditReceipt({ w, db, receiptId: 'r2', partyKey: 'phone:9841234567', label, outlet: { name: 'Cafe Crest' }, receivedByName: id => (id === 'u1' ? 'Ram' : null) })
    expect(res).toEqual({ printed: true, error: null, countError: null })
    expect(w.written).toContain('MONEY RECEIPT')
    expect(w.written).toContain('<span>Received by:</span><span>Ram</span>')
    expect(w.written).not.toContain('COPY')
    expect(calls).toContainEqual(['bump', 'r2', 1])
    jest.runAllTimers()
    expect(w.print).toHaveBeenCalled()
    jest.useRealTimers()
  })
  test('nothing prints without the outlet, the name of who took it, or a window', async () => {
    const w1 = fakeWindow()
    expect((await printCreditReceipt({ w: w1, db: fakeDb().db, receiptId: 'r2', partyKey: 'k', label, outlet: null, receivedByName: () => 'Ram' })).printed).toBe(false)
    expect(w1.close).toHaveBeenCalled()
    const w2 = fakeWindow()
    const { db, calls } = fakeDb()
    const res = await printCreditReceipt({ w: w2, db, receiptId: 'r2', partyKey: 'k', label, outlet: { name: 'X' }, receivedByName: () => null })
    expect(res.error.message).toMatch(/name of who took this payment/)
    expect(calls.some(c => c[0] === 'bump')).toBe(false)
    expect((await printCreditReceipt({ w: null, db, receiptId: 'r2', partyKey: 'k', label, outlet: { name: 'X' }, receivedByName: () => 'Ram' })).error.blocked).toBe(true)
  })
})
