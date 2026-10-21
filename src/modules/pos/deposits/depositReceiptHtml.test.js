/**
 * The deposit receipt (S854): numbered, no VAT on it, and it says what it is for in the owner words.
 * A reprint after the bill or a refund shows what the deposit paid and what went back. Every typed
 * value is escaped.
 */
import { buildDepositReceiptHtml, printDepositReceipt, DEPOSIT_RECEIPT_PURPOSE } from './depositReceiptHtml'

const deposit = {
  id: 'd1', receipt_no: 12, invoice_fy: '2083/84', amount: 5000, method: 'Cash', used_amount: 0,
  refunded_amount: 0, taken_at: '2026-10-20T06:00:00Z', notes: null,
}
const booking = { customer_name: 'Sharma <b>', phone: '9800000001', party_size: 25, reserved_for: '2026-10-25T13:30:00Z' }
const outlet = { name: 'Bloom Cafe', address: 'Thamel' }

test('the first print: number, amount, method, booking, taker, the purpose line, and no VAT', () => {
  const html = buildDepositReceiptHtml({ deposit, booking, takenBy: 'Ram', outlet })
  expect(html).toContain('DEPOSIT RECEIPT')
  expect(html).toContain('DP-12')
  expect(html).toContain('NPR 5,000.00')
  expect(html).toContain('Five Thousand Rupees only')
  expect(html).toContain('<span>Cash</span>')
  expect(html).toContain('25 guests')
  expect(html).toContain('Ram')
  expect(html).toContain(DEPOSIT_RECEIPT_PURPOSE)
  expect(DEPOSIT_RECEIPT_PURPOSE).toBe('Advance against booking. VAT is charged on the final bill.')
  expect(html).not.toMatch(/PAN|VAT No|13%/)
  expect(html).toContain('Sharma &lt;b&gt;')
  expect(html).not.toContain('REFUNDED')
})

test('a reprint after the bill and a refund shows both, marked COPY', () => {
  const html = buildDepositReceiptHtml({
    deposit: { ...deposit, used_amount: 3200, refunded_amount: 1800, refund_method: 'Cash', refunded_at: '2026-10-25T16:00:00Z' },
    booking, takenBy: 'Ram', refundedBy: 'Sita', outlet, copyLabel: 'COPY',
  })
  expect(html).toContain('COPY')
  expect(html).toContain('Used on the bill:')
  expect(html).toContain('3,200.00')
  expect(html).toContain('REFUNDED NPR 1,800.00')
  expect(html).toContain('Sita')
})

test('nothing prints without a window or a letterhead', () => {
  expect(printDepositReceipt(null, { deposit, booking, outlet }).error.blocked).toBe(true)
  const w = { closed: false, close: jest.fn() }
  const r = printDepositReceipt(w, { deposit, booking, outlet: null })
  expect(r.printed).toBe(false)
  expect(w.close).toHaveBeenCalled()
})
