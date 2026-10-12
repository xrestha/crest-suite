// S809 CHECKOUT-13: a PAN bill's own figures add up to its Net Amount (Round Off prints on every
// bill), and a Credit bill says what is owed instead of printing a Tender as if the guest had paid.
import { buildBillHtml, billOptionRow } from './posOrderPrintHtml'

const SETTINGS = { is_vat_registered: false, invoice_prefix: '', vat_number: '123456789', property_address: '', property_phone: '' }

const bill = ({ order = {}, items, vatReg = false }) => buildBillHtml({
  order: { invoice_no: 27, invoice_fy: '83/84', vat_registered: vatReg, covers: 2, closed_at: '2026-10-10T08:00:00Z', ...order },
  items,
  copyLabel: 'ORIGINAL',
  outletName: 'Bloom Cafe',
  billingSettings: { ...SETTINGS, is_vat_registered: vatReg },
  hscMap: {},
  tableName: 'Table 2',
  cashierName: 'Sita',
})
// One printed row's figure, by its label: "Round Off:" → "-0.48".
const rowValue = (html, label) => html.match(new RegExp(`<span>${label}:</span><span>([^<]*)</span>`))?.[1]
const count = (html, text) => html.split(text).length - 1

// Live bill 27 (BLOOM CAFE): one line at 1,172.4779, no VAT, paid 1,172.
const BILL_27 = [{ recipe_id: 'r1', name: 'Set Lunch', qty: 1, unit_price: 1172.4779, vat_rate: 0 }]
const EVEN = [{ recipe_id: 'r2', name: 'Veg Momo', qty: 2, unit_price: 250, vat_rate: 0 }]

describe('buildBillHtml — Round Off', () => {
  test('a PAN bill of 1,172.48 prints the 0.48 it rounded away', () => {
    const html = bill({ order: { payment_method: 'FonePay' }, items: BILL_27 })
    expect(html).toContain('<div class="c b lg" style="margin-top:4px">BILL</div>')
    expect(rowValue(html, 'Gross Amount')).toBe('1,172.48')
    expect(rowValue(html, 'Round Off')).toBe('-0.48')
    expect(html).toMatch(/Net Amount:<\/span><span>1,172\.00</)
    // A PAN bill still carries no VAT rows.
    expect(html).not.toContain('VAT 13%')
  })

  test('a PAN bill with nothing to round prints Round Off 0.00', () => {
    const html = bill({ order: { payment_method: 'Cash', tendered_amount: 500 }, items: EVEN })
    expect(rowValue(html, 'Round Off')).toBe('0.00')
    expect(html).toMatch(/Net Amount:<\/span><span>500\.00</)
  })

  test('a VAT bill prints Round Off once, beside its VAT rows', () => {
    const html = bill({ vatReg: true, order: { payment_method: 'Cash' }, items: [{ recipe_id: 'r3', name: 'Tea', qty: 1, unit_price: 100, vat_rate: 0.13 }] })
    expect(html).toContain('TAX INVOICE')
    expect(count(html, 'Round Off:')).toBe(1)
    expect(rowValue(html, 'VAT 13%')).toBe('13.00')
    expect(rowValue(html, 'Round Off')).toBe('0.00')
    expect(html).toMatch(/Net Amount:<\/span><span>113\.00</)
  })
})

describe('buildBillHtml — what was handed over', () => {
  test('a Credit bill says what is owed, with no Tender or Change', () => {
    const html = bill({ order: { payment_method: 'Credit' }, items: BILL_27 })
    expect(html).not.toContain('Tender:')
    expect(html).not.toContain('Change:')
    expect(rowValue(html, 'Amount on credit')).toBe('1,172.00')
    // The signature line a Credit bill always carried is still there.
    expect(html).toContain('Customer Signature')
  })

  test('a Cash bill prints its Tender and Change as before', () => {
    const html = bill({ order: { payment_method: 'Cash', tendered_amount: 1500 }, items: BILL_27 })
    expect(rowValue(html, 'Tender')).toBe('1,500.00')
    expect(rowValue(html, 'Change')).toBe('328.00')
    expect(html).not.toContain('Amount on credit')
    expect(html).not.toContain('Customer Signature')
  })

  test('a Split bill lists its payments, not a Tender', () => {
    const html = buildBillHtml({
      order: { invoice_no: 28, payment_method: 'Split', vat_registered: false },
      items: EVEN, payments: [{ method: 'Cash', amount: 300 }, { method: 'eSewa', amount: 200 }],
      outletName: '', billingSettings: SETTINGS, hscMap: {}, tableName: 'Takeaway', cashierName: '',
    })
    expect(rowValue(html, 'Cash')).toBe('300.00')
    expect(rowValue(html, 'eSewa')).toBe('200.00')
    expect(html).not.toContain('Tender:')
  })
})

describe('billOptionRow', () => {
  test('lists a line\'s choices, a paid one with what it added', () => {
    const row = billOptionRow({ options: [{ option_name: 'Extra cheese', price_delta: 40 }, { option_name: 'No onion', price_delta: 0 }] })
    expect(row).toContain('Extra cheese +40, No onion')
  })

  test('is empty for a line with no choices', () => {
    expect(billOptionRow({ options: [] })).toBe('')
  })
})
