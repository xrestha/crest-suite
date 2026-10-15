// S847 (/impeccable optimize: POS slow on a poor connection). The refund label lookup (which credit
// note a Cash Out refunded) used to be a round trip of its own between the shift's two waves of reads.
// It needs nothing of the second wave, so it runs beside it: the Split legs are asked for while the
// note lookup is still out, and the label still lands on the refund.
const mockCalls = []
let mockRespond = () => ({ data: [], error: null })
function mockBuilder(table, cols) {
  const calls = [['select', [cols]]]
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (ok, bad) => {
          mockCalls.push({ table, calls })
          return Promise.resolve(mockRespond(table, calls)).then(ok, bad)
        }
      }
      return (...args) => { calls.push([prop, args]); return proxy }
    },
  })
  return proxy
}
jest.mock('../../../shared/scopedDb', () => ({ scopedFrom: (table, _clientId, cols) => mockBuilder(table, cols) }))
jest.mock('../../../supabaseClient', () => ({ supabase: { rpc: () => Promise.resolve({ data: [], error: null }) } }))

// eslint-disable-next-line import/first
import { loadShiftReport } from './PosShifts'

test('the refund label is looked up beside the second wave, not before it', async () => {
  let releaseNotes = () => {}
  const notes = new Promise(resolve => { releaseNotes = () => resolve({ data: [{ id: 'n1', credit_note_no: 7, invoice_fy: '2083/84' }], error: null }) })
  mockRespond = table => {
    if (table === 'pos_orders') return { data: [{ id: 'o1', close_type: 'paid', payment_method: 'Split', paid_amount: 500, discount_amount: 0, closed_at: '2026-10-15T06:00:00Z' }], error: null }
    if (table === 'pos_cash_movements') return { data: [{ id: 'm1', kind: 'refund', direction: 'out', amount: 100, pos_credit_note_id: 'n1', created_at: '2026-10-15T07:00:00Z' }], error: null }
    if (table === 'pos_credit_notes') return notes
    if (table === 'pos_order_payments') return { data: [{ order_id: 'o1', payment_method: 'Card', amount: 500 }], error: null }
    return { data: [], error: null }
  }
  const report = loadShiftReport('c1', 's1')
  await new Promise(r => setTimeout(r, 0))
  // The note lookup has not answered, and the Split legs are already asked for.
  expect(mockCalls.map(c => c.table)).toEqual(expect.arrayContaining(['pos_credit_notes', 'pos_order_payments']))
  releaseNotes()
  const r = await report
  expect(r.movements[0].credit_note_label).toBe('Credit Note 7 (2083/84)')
})
