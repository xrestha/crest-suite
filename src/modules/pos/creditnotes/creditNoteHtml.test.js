// S809 4c: the printed Credit Note mirrors its bill (CREDIT-NOTES-8) — a customized line keeps its
// choices and a Round Off line makes the printed figures add up to Net Credited. Since S828 5d a
// print's copy label is the count the server returns from that print's own write (the S809.4 item).
import { buildCreditNoteHtml, creditNoteRoundOff, nextCreditNoteCopy, printCreditNote } from './creditNoteHtml'

// Plain functions, not jest.fn implementations: CRA's Jest config resets mocks before every test.
const mockCalls = []
const mockAnswer = { current: { data: { print_count: 1 }, error: null } }
jest.mock('../../../shared/scopedDb', () => ({
  scopedUpdate: (...args) => {
    mockCalls.push(['update', ...args])
    return {
      eq: (...eq) => {
        mockCalls.push(['eq', ...eq])
        return { select: (...sel) => { mockCalls.push(['select', ...sel]); return { maybeSingle: async () => mockAnswer.current } } }
      },
    }
  },
}))

const SETTINGS = { is_vat_registered: true, invoice_prefix: 'BC', vat_number: '123456789', property_address: '', property_phone: '' }
const note = over => ({
  credit_note_no: 12, invoice_fy: '83/84', created_at: '2026-10-12T06:00:00Z',
  original_invoice_label: 'TI45-BC-83/84', original_invoice_date_bs: '4 Shrawan 2083', reason: 'Wrong customer',
  gross_amount: 0, discount_amount: 0, taxable_amount: 0, non_taxable_amount: 0, vat_amount: 0, net_amount: 0,
  print_count: 0,
  ...over,
})
const html = (n, items, billVat) => buildCreditNoteHtml(n, items, SETTINGS, 'Bhatti', {}, '', billVat)
// One printed row's figure, by its label: "Round Off:" → "-0.01".
const rowValue = (h, label) => h.match(new RegExp(`<span>${label}:</span><span>([^<]*)</span>`))?.[1]

describe('buildCreditNoteHtml — the choices row', () => {
  test('a customized line prints its choices under it, in their order, as the bill does', () => {
    const items = [
      { recipe_id: 'r1', name: 'Chicken Momo', qty: 1, unit_price: 400 },
      { recipe_id: 'r1', name: 'Chicken Momo', qty: 1, unit_price: 550, pos_order_item_options: [
        { option_name: 'Extra cheese', price_delta: 50, sort: 2 },
        { option_name: 'Large', price_delta: 100, sort: 1 },
      ] },
    ]
    const h = html(note({ gross_amount: 950, non_taxable_amount: 950, net_amount: 950 }), items, true)
    expect(h).toContain('<td colspan="4" style="font-size:10px;padding-top:0">Large +100, Extra cheese +50</td>')
    // Only the customized line gets a row: one choices row for two dish lines.
    expect(h.split('colspan="4"').length - 1).toBe(1)
  })

  test('a cart-shaped line (the issuing modal) prints its `options` too', () => {
    const items = [{ recipe_id: 'r1', name: 'Thali', qty: 1, unit_price: 300, options: [{ option_name: 'No onion', price_delta: 0, sort: 0 }] }]
    const h = html(note({ gross_amount: 300, non_taxable_amount: 300, net_amount: 300 }), items, true)
    expect(h).toContain('>No onion</td>')
  })
})

describe('buildCreditNoteHtml — Round Off', () => {
  test('the review\'s VAT note: Taxable 1,327.44 + VAT 172.57 = 1,500.01 prints Round Off -0.01 above Net 1,500.00', () => {
    // Three dishes at 442.48: VAT 172.5672 is stored unrounded and prints 172.57.
    const n = note({ gross_amount: 1327.44, taxable_amount: 1327.44, vat_amount: 172.5672, net_amount: 1500 })
    const h = html(n, [{ recipe_id: 'r1', name: 'Set', qty: 3, unit_price: 442.48 }], true)
    expect(rowValue(h, 'Taxable')).toBe('1327.44')
    expect(rowValue(h, 'VAT 13%')).toBe('172.57')
    expect(rowValue(h, 'Round Off')).toBe('-0.01')
    expect(h).toMatch(/Net Credited:<\/span><span>1500\.00</)
    expect(creditNoteRoundOff(n, true)).toBe(-0.01)
  })

  test('a PAN note rounds from gross − discount and prints no VAT rows', () => {
    const n = note({ gross_amount: 1172.48, non_taxable_amount: 1172.48, net_amount: 1172 })
    const h = html(n, [{ recipe_id: 'r1', name: 'Set Lunch', qty: 1, unit_price: 1172.48 }], false)
    expect(h).not.toContain('VAT 13%')
    expect(h).toContain('PAN No: 123456789')
    expect(rowValue(h, 'Round Off')).toBe('-0.48')
    expect(h).toMatch(/Net Credited:<\/span><span>1172\.00</)
  })

  test('a PAN note with a discount rounds up with a plus', () => {
    const n = note({ gross_amount: 1000, discount_amount: 100.6, non_taxable_amount: 899.4, net_amount: 899 })
    expect(creditNoteRoundOff(n, false)).toBe(-0.4)
    const up = note({ gross_amount: 1000, discount_amount: 100.4, non_taxable_amount: 899.6, net_amount: 900 })
    expect(rowValue(html(up, [], false), 'Round Off')).toBe('+0.40')
  })

  test('nothing rounded prints Round Off 0.00, never -0.00', () => {
    const n = note({ gross_amount: 100, taxable_amount: 100, vat_amount: 13, net_amount: 113 })
    const h = html(n, [{ recipe_id: 'r1', name: 'Tea', qty: 1, unit_price: 100 }], true)
    expect(rowValue(h, 'Round Off')).toBe('0.00')
    expect(h.split('Round Off:').length - 1).toBe(1)
  })
})

describe('nextCreditNoteCopy — the copy a print is about to make', () => {
  test('the first print carries no label, the next ones count copies', () => {
    expect(nextCreditNoteCopy(0)).toEqual({ count: 1, label: '' })
    expect(nextCreditNoteCopy(null, undefined)).toEqual({ count: 1, label: '' })
    expect(nextCreditNoteCopy(1)).toEqual({ count: 2, label: 'COPY OF ORIGINAL - (1)' })
  })

  test('the count read just before printing wins over a stale page-open list', () => {
    // Another manager reprinted twice since this page opened: the list says 1, the database 3.
    expect(nextCreditNoteCopy(1, 3)).toEqual({ count: 4, label: 'COPY OF ORIGINAL - (3)' })
    // Counts only go up, so a lower stored read never takes the label backwards.
    expect(nextCreditNoteCopy(3, 1).count).toBe(4)
  })
})

describe('printCreditNote — the copy the server counted (S828 5d)', () => {
  let written
  let win
  beforeEach(() => {
    jest.useFakeTimers()
    written = ''
    mockCalls.length = 0
    win = { closed: false, document: { open() { written = '' }, write: h => { written += h }, close() {} }, focus() {}, print() {}, close() {} }
    window.open = () => win
  })
  afterEach(() => { jest.useRealTimers() })
  const n = over => note({ id: 'cn1', gross_amount: 100, non_taxable_amount: 100, net_amount: 100, ...over })

  test('sends -1 and labels from the count the server returns, not the page\'s own', async () => {
    // The page opened when the note had 1 print; two more were made elsewhere since.
    mockAnswer.current = { data: { print_count: 4 }, error: null }
    const r = await printCreditNote('c1', n({ print_count: 1 }), [], SETTINGS, 'Bhatti', {}, true)
    expect(r).toEqual({ printed: true, newCount: 4, countError: null })
    expect(written).toContain('COPY OF ORIGINAL - (3)')
    expect(mockCalls).toEqual([
      ['update', 'pos_credit_notes', 'c1', { print_count: -1 }], ['eq', 'id', 'cn1'], ['select', 'print_count'],
    ])
  })

  test('the first print, counted 1, is the original and carries no copy label', async () => {
    mockAnswer.current = { data: { print_count: 1 }, error: null }
    const r = await printCreditNote('c1', n({ print_count: 0 }), [], SETTINGS, 'Bhatti', {}, true)
    expect(r).toEqual({ printed: true, newCount: 1, countError: null })
    expect(written).not.toContain('COPY OF ORIGINAL')
  })

  test('a refused count still prints, labelled from the page\'s count, and says the count was not saved', async () => {
    mockAnswer.current = { data: null, error: { code: '42501', message: 'refused' } }
    const r = await printCreditNote('c1', n({ print_count: 2 }), [], SETTINGS, 'Bhatti', {}, true)
    expect(r.printed).toBe(true)
    expect(r.newCount).toBe(3)
    expect(r.countError).toMatchObject({ code: '42501' })
    expect(written).toContain('COPY OF ORIGINAL - (2)')
  })

  test('zero rows, or a count that did not go up (a server before 5d), is not a count', async () => {
    mockAnswer.current = { data: null, error: null }
    expect((await printCreditNote('c1', n({ print_count: 2 }), [], SETTINGS, 'Bhatti', {}, true)).countError).toBeTruthy()
    mockAnswer.current = { data: { print_count: 2 }, error: null }
    const r = await printCreditNote('c1', n({ print_count: 2 }), [], SETTINGS, 'Bhatti', {}, true)
    expect(r.countError).toBeTruthy()
    expect(r.newCount).toBe(3)
  })

  test('a blocked pop-up writes nothing and reports the count as the page knew it', async () => {
    window.open = () => null
    const r = await printCreditNote('c1', n({ print_count: 1 }), [], SETTINGS, 'Bhatti', {}, true)
    expect(r).toEqual({ printed: false, newCount: 1, countError: null })
    expect(mockCalls).toEqual([])
  })

  test('a window closed before the count answered prints nothing', async () => {
    mockAnswer.current = { data: { print_count: 2 }, error: null }
    win.closed = true
    const r = await printCreditNote('c1', n({ print_count: 1 }), [], SETTINGS, 'Bhatti', {}, true)
    expect(r.printed).toBe(false)
    expect(written).not.toContain('CREDIT NOTE')
  })
})
