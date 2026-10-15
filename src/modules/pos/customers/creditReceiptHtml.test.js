// S843: the money receipt (80mm, the bill's family), the statement and the who-owes-by-age list, as
// pure HTML. A receipt is NOT a tax invoice: no VAT, no PAN, and it says so.
import {
  amountInWords, bsDay, buildReceiptHtml, buildStatementHtml, buildAgeingHtml, eventParticulars,
} from './creditReceiptHtml'
import { nepalTime } from '../../../shared/nepalTime'

const RECEIPT = {
  id: 'r1', receipt_no: 7, invoice_fy: '82/83', party_key: 'phone:9841234567', party_name: 'Hari <b>Bahadur</b>',
  party_phone: '9841234567', method: 'Cheque', reference: 'CHQ 0042', amount: 5200.5, commission_total: 0,
  note: null, received_at: '2026-10-10T04:57:00+00:00', cancelled_at: null, cancel_reason: null,
}
const BILLS = [
  { label: 'TI12-CAC-82/83', closedAt: '2026-09-01T05:00:00+00:00', amount: 3000, commission: 0, owedAfter: 0 },
  { label: 'TI15-CAC-82/83', closedAt: '2026-09-20T05:00:00+00:00', amount: 2200.5, commission: 0, owedAfter: 799.5 },
]
const OUTLET = { name: 'Cafe Crest', address: 'Lazimpat, Kathmandu', phone: '01-4000000' }
const html = (over = {}) => buildReceiptHtml({
  receipt: RECEIPT, bills: BILLS, previousBalance: 9000, newBalance: 3799.5, receivedBy: 'Ram', outlet: OUTLET, ...over,
})

describe('buildReceiptHtml', () => {
  test('the heading in both languages, the number, the fiscal year, the BS date and time', () => {
    const h = html()
    expect(h).toContain('MONEY RECEIPT')
    expect(h).toContain('रकम प्राप्ति रसिद')
    expect(h).toContain('<span class="b">RC-7</span>')
    expect(h).toContain('<span>82/83</span>')
    expect(h).toContain(`<span>${bsDay(RECEIPT.received_at)}</span>`)
    expect(h).toContain(`<span>${nepalTime(RECEIPT.received_at)}</span>`)
    expect(h).toContain('Cafe Crest')
    expect(h).toContain('Lazimpat, Kathmandu')
    expect(h).toContain('01-4000000')
  })

  test('who paid, how much (in words too), how, the bills cleared and the balances', () => {
    const h = html()
    expect(h).toContain('NPR 5,200.50')
    expect(h).toContain('Five Thousand Two Hundred Rupees and Fifty Paisa only')
    expect(h).toContain('Cheque · CHQ 0042')
    expect(h).toContain('TI12-CAC-82/83')
    expect(h).toContain('<td class="n">2,200.50</td>')
    expect(h).toContain('<td class="n">799.50</td>')
    expect(h).toContain('<span>Previous balance:</span><span>9,000.00</span>')
    expect(h).toContain('<span>New balance:</span><span>3,799.50</span>')
    expect(h).toContain('<span>Received by:</span><span>Ram</span>')
    expect(h).toContain('This is a receipt for money received, not a tax invoice.')
  })

  test('no VAT or PAN block, and typed text is escaped', () => {
    const h = html()
    expect(h).not.toMatch(/VAT No|PAN No|TAX INVOICE|VAT 13%/)
    expect(h).toContain('Hari &lt;b&gt;Bahadur&lt;/b&gt;')
    expect(h).not.toContain('<b>Bahadur</b>')
  })

  test('a reprint says COPY; a cancelled one says so with its reason', () => {
    expect(html({ copyLabel: 'COPY OF ORIGINAL - (1)' })).toContain('COPY OF ORIGINAL - (1)')
    expect(html()).not.toContain('COPY')
    const c = html({ receipt: { ...RECEIPT, cancelled_at: '2026-10-11T04:00:00+00:00', cancel_reason: 'Entered twice' } })
    expect(c).toContain('CANCELLED')
    expect(c).toContain('Entered twice')
  })

  test("a delivery partner's commission kept is printed, and counts in what the payment cleared", () => {
    const h = html({
      receipt: { ...RECEIPT, party_key: 'partner:foodmandu', party_name: 'Foodmandu', amount: 900, commission_total: 100, method: 'Bank Transfer', reference: null },
      bills: [{ label: 'TI20-CAC-82/83', closedAt: RECEIPT.received_at, amount: 900, commission: 100, owedAfter: 0 }],
      previousBalance: 1000, newBalance: 0,
    })
    expect(h).toContain('<span>Commission kept:</span><span>100.00</span>')
    expect(h).toContain('+100.00 comm.')
    expect(h).toContain('<span>This payment:</span><span>-1,000.00</span>')
  })
})

describe('amountInWords', () => {
  test('rupees, and paisa when there are any', () => {
    expect(amountInWords(342500)).toBe('Three Lakh Forty-Two Thousand Five Hundred Rupees only')
    expect(amountInWords(0.5)).toBe('Zero Rupees and Fifty Paisa only')
    expect(amountInWords(1.05)).toBe('One Rupee and Five Paisa only')
  })
})

describe('the statement and the ageing papers', () => {
  const particulars = e => eventParticulars(e, { vatReg: true, prefix: 'CAC' })
  test('eventParticulars names every kind of row', () => {
    expect(particulars({ kind: 'bill', doc_no: 12, doc_fy: '82/83', doc_prefix: 'CAC', detail: 'T4' })).toBe('Credit bill TI12-CAC-82/83 · T4')
    expect(eventParticulars({ kind: 'bill', order_id: 'o1', doc_no: 12, doc_fy: '82/83', doc_prefix: null }, { vatReg: true, prefix: 'NEW', vatById: { o1: false } })).toBe('Credit bill PB12-NEW-82/83')
    expect(particulars({ kind: 'settled', doc_no: 12, doc_fy: '82/83', doc_prefix: 'CAC', method: 'Cash' })).toBe('Bill TI12-CAC-82/83 paid in full by Cash')
    expect(particulars({ kind: 'receipt', doc_no: 7, doc_fy: '82/83', method: 'eSewa', detail: 'TX1' })).toBe('Receipt RC-7 (82/83), eSewa · TX1')
    expect(particulars({ kind: 'receipt_cancelled', doc_no: 7, doc_fy: '82/83', detail: 'Entered twice' })).toBe('Receipt RC-7 (82/83) cancelled: Entered twice')
    expect(particulars({ kind: 'credit_note', doc_no: 3, doc_fy: '82/83', doc_prefix: 'CAC', detail: 'Returned' })).toBe('Credit note CN3-CAC-82/83 · Returned')
  })

  test('the statement prints brought forward, the rows with their balance, the closing line and the ageing', () => {
    const statement = {
      opening: 600, closing: 1100.5, totalDebit: 500.5, totalCredit: 0,
      rows: [{ event_at: '2026-10-01T05:00:00+00:00', kind: 'bill', doc_no: 12, doc_fy: '82/83', doc_prefix: 'CAC', debit: 500.5, credit: 0, balance: 1100.5 }],
    }
    const ageing = { buckets: { d30: 500.5, d60: 600, d90: 0, over90: 0 }, total: 1100.5 }
    const h = buildStatementHtml({ outlet: OUTLET, party: { name: 'Hari', phone: '98', kind: 'customer' }, fromLabel: '1 Shrawan 2083', toLabel: '29 Ashwin 2083', statement, ageing, particulars })
    expect(h).toContain('Statement of account')
    expect(h).toContain('Balance brought forward')
    expect(h).toContain('<td class="n">600.00</td>')
    expect(h).toContain('Credit bill TI12-CAC-82/83')
    expect(h).toContain('Balance at 29 Ashwin 2083')
    expect(h).toContain('0–30 days')
    expect(h).toContain('<b>1,100.50</b>')
  })

  test('the ageing list prints each party and the totals', () => {
    const ageing = {
      rows: [{ key: 'partner:pathao', kind: 'partner', name: 'Pathao', phone: '', buckets: { d30: 0, d60: 0, d90: 0, over90: 250 }, total: 250 }],
      totals: { d30: 0, d60: 0, d90: 0, over90: 250 }, total: 250,
    }
    const h = buildAgeingHtml({ outlet: OUTLET, ageing })
    expect(h).toContain('Who owes, by age')
    expect(h).toContain('Pathao (delivery partner)')
    expect(h).toContain('<td class="n"><b>250.00</b></td>')
  })
})
