// S809 CHECKOUT-13: a PAN bill's own figures add up to its Net Amount (Round Off prints on every
// bill), and a Credit bill says what is owed instead of printing a Tender as if the guest had paid.
import { buildBillHtml, billOptionRow, buildVoidSlipHtml, buildMoveSlipHtml, buildShareSlipsHtml } from './posOrderPrintHtml'
import { equalShares } from './shareSplit'

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

// S817 4i FLOOR-KITCHEN-4: the void prints a stop for each station still making the order's food.
describe('buildVoidSlipHtml', () => {
  const slip = buildVoidSlipHtml({
    station: 'KOT',
    ticketNo: 57,
    outletName: 'Bloom Cafe',
    tableName: 'Table 9',
    voidedBy: 'Ram <Supervisor>',
    voidedAt: '2026-10-12T14:20:00Z',
    items: [
      { name: 'Mixed Grill', qty: 1, options: [{ kitchen: 'No onion', is_removal: true }, { kitchen: 'Extra sauce' }] },
      { name: 'Veg Momo', qty: 0, change: true },
    ],
  })

  test('says VOID and STOP for the right station, table and order', () => {
    expect(slip).toContain('*** VOID — KITCHEN ***')
    expect(slip).toContain('STOP — DO NOT MAKE')
    expect(slip).toContain('Table 9')
    expect(slip).toContain('#57')
    expect(buildVoidSlipHtml({ station: 'BOT', items: [] })).toContain('*** VOID — BAR ***')
  })

  test('strikes each dish with its quantity and choices, and a change line as CHANGE', () => {
    expect(slip).toContain('<s>Mixed Grill</s></span><span class="b md">×1</span>')
    expect(slip).toContain('NO onion')
    expect(slip).toContain('+ Extra sauce')
    expect(slip).toContain('<s>Veg Momo</s></span><span class="b md">CHANGE</span>')
  })

  test('escapes what a person typed', () => {
    expect(slip).toContain('Voided by: Ram &lt;Supervisor&gt;')
    expect(slip).not.toContain('<Supervisor>')
  })

  test('dates the slip from the void, in Nepal', () => {
    expect(slip).toContain('08:05 PM')
  })
})

// S836: a bill or some of its dishes moved to another table while a station still has its food.
describe('buildMoveSlipHtml', () => {
  const slip = buildMoveSlipHtml({
    station: 'KOT',
    outletName: 'Bloom <Cafe>',
    fromTable: 'T3',
    toTable: 'T5',
    orderNo: 57,
    movedBy: 'Ram <Supervisor>',
    movedAt: '2026-10-12T14:20:00Z',
    items: [
      { name: 'Mixed Grill', qty: 2, options: [{ kitchen: 'No onion', is_removal: true }, { kitchen: 'Extra sauce' }] },
      { name: 'Dal & Bhat', qty: 1, notes: 'less <spicy>' },
    ],
  })

  test('says MOVED, not a new order, for the right station', () => {
    expect(slip).toContain('<div class="t c b md">KITCHEN</div>')
    expect(slip).toContain('*** MOVED ***')
    expect(slip).toContain('NOT A NEW ORDER')
    expect(slip).not.toContain('ORDER TICKET')
    expect(buildMoveSlipHtml({ station: 'BOT', fromTable: 'T3', toTable: 'T5', items: [] }))
      .toContain('<div class="t c b md">BAR</div>')
  })

  test('prints the arrow line from the old table to the new one, and the bill number', () => {
    expect(slip).toContain('<div class="t c b xl">T3 → T5</div>')
    expect(slip).toContain('#57')
    expect(slip).toContain('serve it at T5')
    // A takeaway moved onto a table has no old table.
    expect(buildMoveSlipHtml({ station: 'KOT', toTable: 'T5', items: [] })).toContain('Takeaway → T5')
  })

  test('lists the dishes still with the station, with their quantity and choices as the KOT showed them', () => {
    expect(slip).toContain('<span class="b">Mixed Grill</span><span class="b md">×2</span>')
    expect(slip).toContain('NO onion')
    expect(slip).toContain('+ Extra sauce')
    expect(slip).toContain('<span class="b md">×1</span>')
  })

  test('escapes what a person typed', () => {
    const typed = buildMoveSlipHtml({ station: 'KOT', fromTable: 'Patio "A"', toTable: '<b>Roof</b>', orderNo: '<9>', items: [], movedBy: 'x' })
    expect(typed).toContain('Patio &quot;A&quot; → &lt;b&gt;Roof&lt;/b&gt;')
    expect(typed).toContain('#&lt;9&gt;')
    expect(typed).not.toContain('<b>Roof</b>')
    expect(slip).toContain('Bloom &lt;Cafe&gt;')
    expect(slip).toContain('Moved by: Ram &lt;Supervisor&gt;')
    expect(slip).toContain('Dal &amp; Bhat')
    expect(slip).toContain('↳ less &lt;spicy&gt;')
    expect(slip).not.toContain('<Supervisor>')
  })

  test('dates the slip from the move, in Nepal', () => {
    expect(slip).toContain('08:05 PM')
  })
})

// S836: the equal split keeps one tax invoice and prints a share slip per guest.
describe('buildShareSlipsHtml', () => {
  const slips = buildShareSlipsHtml({
    outletName: 'Bloom <Cafe>',
    tableName: 'Table & 2',
    orderNo: 57,
    total: 3542,
    shares: equalShares(3542, 3),
    printedAt: '2026-10-12T14:20:00Z',
  })
  const count = (html, text) => html.split(text).length - 1

  test('prints one slip per share, each on its own page', () => {
    expect(count(slips, '<div class="slip">')).toBe(3)
    expect(slips).toContain('.slip + .slip { break-before:page; page-break-before:always; }')
  })

  test('each slip names its share and prints the amount in large type', () => {
    expect(slips).toContain('SHARE 1 OF 3')
    expect(slips).toContain('SHARE 3 OF 3')
    expect(count(slips, '<div class="c b amt">NPR 1,181</div>')).toBe(2)
    expect(count(slips, '<div class="c b amt">NPR 1,180</div>')).toBe(1)
    expect(count(slips, '<span>Bill total:</span><span>NPR 3,542</span>')).toBe(3)
    expect(count(slips, '<span>Bill:</span><span class="b">#57</span>')).toBe(3)
  })

  test('says on every slip that it is not the tax invoice', () => {
    expect(count(slips, 'Not a tax invoice — the tax invoice prints when the bill is paid.')).toBe(3)
  })

  test('prints paisa when the shares have them, and groups in lakh', () => {
    const paisa = buildShareSlipsHtml({ tableName: 'T1', orderNo: 8, total: 3542.5, shares: equalShares(3542.5, 3) })
    expect(paisa).toContain('<div class="c b amt">NPR 1,180.84</div>')
    expect(count(paisa, '<div class="c b amt">NPR 1,180.83</div>')).toBe(2)
    expect(paisa).toContain('NPR 3,542.50')
    const lakh = buildShareSlipsHtml({ tableName: 'T1', orderNo: 9, total: 250000, shares: equalShares(250000, 2) })
    expect(lakh).toContain('<div class="c b amt">NPR 1,25,000</div>')
    expect(lakh).toContain('NPR 2,50,000')
  })

  test('escapes what a person typed', () => {
    expect(slips).toContain('Bloom &lt;Cafe&gt;')
    expect(slips).toContain('Table &amp; 2')
    expect(slips).not.toContain('<Cafe>')
  })

  test('prints no slip for no shares', () => {
    expect(count(buildShareSlipsHtml({ tableName: 'T1', total: 100, shares: [] }), '<div class="slip">')).toBe(0)
  })

  test('dates the slips from when the split was printed, in Nepal', () => {
    expect(count(slips, '08:05 PM')).toBe(3)
  })
})
