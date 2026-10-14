// S809 CHECKOUT-13: a PAN bill's own figures add up to its Net Amount (Round Off prints on every
// bill), and a Credit bill says what is owed instead of printing a Tender as if the guest had paid.
import { buildBillHtml, billOptionRow, buildVoidSlipHtml, buildMoveSlipHtml, buildShareSlipsHtml, buildCompSlipHtml } from './posOrderPrintHtml'
import { equalShares } from './shareSplit'
import { escapeHtml } from '../../../utils/escapeHtml'
import { npr2 } from '../../../shared/nepalMoney'

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

// A Complimentary Slip values each line at its PLATE cost × qty: the recipe plus that line's choices
// (posRecipeBook.posLineCosts). It used to read costMap[recipe_id], so "Momo + extra cheese" printed
// at plain momo's cost and a build-your-own bowl at its typed Cost Price.
describe('buildCompSlipHtml — each line at its own plate cost', () => {
  const PLAIN = { recipe_id: 'momo', name: 'Chicken Momo', qty: 2 }
  const CHEESE = { recipe_id: 'momo', name: 'Chicken Momo', qty: 1, option_summary: 'Extra cheese', id: 'line-cheese' }
  const BOWL = { recipe_id: 'bowl', name: 'Acai Bowl', qty: 1, option_summary: 'Large · Granola · Banana', id: 'line-bowl' }
  // Per plate: momo 62.42; the cheese line 62.42 + 75 of cheese; the bowl 0 fixed + 118.50 of toppings.
  const PLATE = { momo: 62.42, 'line-cheese': 137.42, 'line-bowl': 118.5 }
  const plateCostOf = i => PLATE[i.id] ?? PLATE[i.recipe_id]
  const slip = items => buildCompSlipHtml({
    order: { invoice_no: 4, order_no: 51, closed_at: '2026-10-10T08:00:00Z', close_reason: 'Regular guest' },
    items, plateCostOf, copyLabel: 'ORIGINAL', outletName: 'Bloom Cafe', tableName: 'Table 2', authorizedBy: 'Sita',
  })
  // Each line's Cost cell: the row's last two cells are its qty and its cost.
  const cells = html => [...html.matchAll(/<td>\d+<\/td><td>([^<]*)<\/td><\/tr>/g)].map(m => m[1])

  test('two lines of one dish print two figures: the one with a choice carries its stock', () => {
    const html = slip([PLAIN, CHEESE])
    expect(cells(html)).toEqual(['124.84', '137.42'])
    expect(rowValue(html, 'Total Qty')).toBe('3')
    expect(html).toContain('<div class="row tot"><span>Total Food Cost:</span><span>NPR 262.26</span></div>')
    expect(html).toContain('<div style="font-size:10px">Extra cheese</div>')
  })

  test('a build-your-own bowl prints what its build cost, not a typed Cost Price', () => {
    const html = slip([BOWL])
    expect(cells(html)).toEqual(['118.50'])
    expect(html).toContain('<span>Total Food Cost:</span><span>NPR 118.50</span>')
  })

  test('a line with no known cost prints 0.00, as before, never NaN', () => {
    const html = buildCompSlipHtml({ order: { invoice_no: 5 }, items: [{ recipe_id: 'gone', name: 'Old dish', qty: 1 }], plateCostOf: () => undefined, tableName: 'T1' })
    expect(cells(html)).toEqual(['0.00'])
    expect(html).toContain('<span>Total Food Cost:</span><span>NPR 0.00</span>')
    expect(html).not.toContain('NaN')
  })

  test('the slip keeps its number, heading and layout', () => {
    const html = slip([PLAIN])
    expect(html).toContain('COMPLIMENTARY SLIP')
    expect(html).toContain('<span>No:</span><span class="b">NC-04</span>')
    expect(html).toContain('<thead><tr><th>Item</th><th>Qty</th><th>Cost</th></tr></thead>')
  })
})

// S839 (docs/pos-combos.md): a combo prints as ONE row at the place of its first dish — its name, its
// quantity, amount = Σ its dishes' qty × unit_price, rate = amount ÷ qty, no HSC — with its dishes
// listed under it unpriced, each with its own choices. Totals still come from posBillingMath.
describe('combos on the bill and the Complimentary Slip', () => {
  const LINE = '7f0c2c1e-0000-4000-8000-000000000001'
  const dish = (name, group, sort, extra = {}) => ({
    recipe_id: `r-${name}`, name, qty: 1, unit_price: 100, vat_rate: 0,
    combo_line_id: LINE, combo_id: 'c1', combo_name: 'Momo Combo', combo_price: 350,
    combo_group_id: group, combo_sort: sort, selection_key: `@${LINE}/${group}`, ...extra,
  })
  const TEA = { recipe_id: 'r-tea', name: 'Tea', qty: 2, unit_price: 40, vat_rate: 0 }
  const LASSI = { recipe_id: 'r-lassi', name: 'Lassi', qty: 1, unit_price: 120, vat_rate: 0, options: [{ option_name: 'Large', price_delta: 30 }] }
  // The momo's line is its share of the combo plus its own extra cheese (+40, charged on top): 290.
  const MOMO = dish('Chicken Momo', 'g-momo', 0, { unit_price: 290, options: [{ option_name: 'Extra cheese', price_delta: 40 }] })
  const COKE = dish('Coke', 'g-drink', 1, { unit_price: 100 })
  // The item rows exactly as buildBillHtml printed them before S839.
  const legacyRows = (items, hscMap = {}) => items.map((i, idx) => `<tr><td>${idx + 1}</td><td>${escapeHtml(hscMap[i.recipe_id] || '')}</td><td>${escapeHtml(i.name)}</td><td>${i.qty}</td><td>${npr2(i.unit_price)}</td><td>${npr2(i.qty * i.unit_price)}</td></tr>${billOptionRow(i)}`).join('')
  const tbody = html => html.match(/<tbody>([\s\S]*?)<\/tbody>/)[1].trim()

  test('a bill without a combo prints its lines byte for byte as before', () => {
    const items = [TEA, LASSI, { ...BILL_27[0] }]
    const html = bill({ items })
    expect(tbody(html)).toBe(legacyRows(items))
    expect(html).toContain(`<tbody>\n      ${legacyRows(items)}\n    </tbody>`)
  })

  test('a combo is one row at its first dish\'s place, with its dishes under it unpriced', () => {
    const html = bill({ items: [TEA, COKE, LASSI, MOMO] })
    const rows = [...tbody(html).matchAll(/<tr>(.*?)<\/tr>/g)].map(m => m[1])
    expect(rows).toEqual([
      '<td>1</td><td></td><td>Tea</td><td>2</td><td>40.00</td><td>80.00</td>',
      // Σ 290 + 100 = 390 for one combo, at the place of its first dish (the Coke came first).
      '<td>2</td><td></td><td>Momo Combo</td><td>1</td><td>390.00</td><td>390.00</td>',
      // Its dishes in the order of their picks, by name only, the momo's own choice under it.
      '<td></td><td></td><td colspan="4" style="padding-top:0;padding-left:10px">Chicken Momo</td>',
      '<td></td><td></td><td colspan="4" style="font-size:10px;padding-top:0;padding-left:18px">Extra cheese +40</td>',
      '<td></td><td></td><td colspan="4" style="padding-top:0;padding-left:10px">Coke</td>',
      '<td>3</td><td></td><td>Lassi</td><td>1</td><td>120.00</td><td>120.00</td>',
      '<td></td><td></td><td colspan="4" style="font-size:10px;padding-top:0">Large +30</td>',
    ])
    // The totals are posBillingMath's, as on any bill.
    expect(rowValue(html, 'Gross Amount')).toBe('590.00')
    expect(rowValue(html, 'Net Amount')).toBe('590.00')
  })

  test('two of one combo print qty 2 at the combo\'s rate; the HSC column stays blank for it', () => {
    const html = buildBillHtml({
      order: { invoice_no: 28, invoice_fy: '83/84', vat_registered: false, closed_at: '2026-10-10T08:00:00Z' },
      items: [{ ...MOMO, qty: 2 }, { ...COKE, qty: 2 }],
      copyLabel: 'ORIGINAL', outletName: 'Bloom Cafe', billingSettings: SETTINGS,
      hscMap: { 'r-Chicken Momo': '2106', 'r-Coke': '2202' }, tableName: 'Table 2', cashierName: 'Sita',
    })
    expect(html).toContain('<tr><td>1</td><td></td><td>Momo Combo</td><td>2</td><td>390.00</td><td>780.00</td></tr>')
    expect(html).not.toContain('2106')
  })

  test('a combo name a person typed is escaped', () => {
    const html = bill({ items: [MOMO, COKE].map(d => ({ ...d, combo_name: '<b>Deal</b>' })) })
    expect(html).toContain('<td>&lt;b&gt;Deal&lt;/b&gt;</td>')
    expect(html).not.toContain('<b>Deal</b>')
  })

  test('the Complimentary Slip prints the combo as one row costed with all its dishes', () => {
    const PLATE = { 'r-Chicken Momo': 95.5, 'r-Coke': 30, 'r-tea': 12 }
    const html = buildCompSlipHtml({
      order: { invoice_no: 6, order_no: 52, closed_at: '2026-10-10T08:00:00Z' },
      items: [TEA, { ...MOMO, option_summary: 'Extra cheese' }, COKE], plateCostOf: i => PLATE[i.recipe_id],
      copyLabel: 'ORIGINAL', outletName: 'Bloom Cafe', tableName: 'Table 2', authorizedBy: 'Sita',
    })
    expect(html).toContain('<tr><td>Tea</td><td>2</td><td>24.00</td></tr>')
    expect(html).toContain('<tr><td>Momo Combo'
      + '<div style="font-size:10px;padding-left:10px">Chicken Momo</div><div style="font-size:10px;padding-left:18px">Extra cheese</div>'
      + '<div style="font-size:10px;padding-left:10px">Coke</div></td><td>1</td><td>125.50</td></tr>')
    expect(html).toContain('<span>Total Food Cost:</span><span>NPR 149.50</span>')
  })
})
