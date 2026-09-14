import {
  NOT_RECORDED, SPLIT_NO_BREAKDOWN, AMOUNT_KEYS,
  billAmounts, creditNoteAmounts, buildSalesEntries, paymentSharesOf, allocateAmounts,
  buildPaymentRows, sortByMethodOrder, buildGroupedRows, partyNameKey, mergeNameOnlyParties, zeroAmounts, addAmounts,
} from './salesReportMath'
import { computeOrderAmounts } from '../../../utils/posBillingMath'

const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0)

// A VAT-registered bill with a discount and a non-taxable line — the case where every figure moves.
const BILL_A = { id: 'A', payment_method: 'Split', discount_amount: 100, closed_at: '2026-09-10T08:00:00Z' }
const ITEMS_A = [
  { order_id: 'A', recipe_id: 'r1', name: 'Momo', category: 'Food', qty: 2, unit_price: 400, vat_rate: 0.13 },
  { order_id: 'A', recipe_id: 'r2', name: 'Water', category: 'Beverage', qty: 1, unit_price: 200, vat_rate: 0 },
]
const PAYMENTS_A = [
  { order_id: 'A', payment_method: 'Cash', amount: 600 },
  { order_id: 'A', payment_method: 'Card', amount: 294 },
  { order_id: 'A', payment_method: 'Loyalty', amount: 100 },
]
const BILL_B = { id: 'B', payment_method: 'Cash', discount_amount: 0, closed_at: '2026-09-10T09:00:00Z' }
const ITEMS_B = [{ order_id: 'B', recipe_id: 'r1', name: 'Momo', category: 'Food', qty: 1, unit_price: 400, vat_rate: 0.13 }]
const BILL_C = { id: 'C', payment_method: null, discount_amount: 0, closed_at: '2026-09-10T10:00:00Z' }
const ITEMS_C = [{ order_id: 'C', recipe_id: 'r3', name: 'Tea', category: 'Beverage', qty: 3, unit_price: 50, vat_rate: 0.13 }]
const itemsByOrder = { A: ITEMS_A, B: ITEMS_B, C: ITEMS_C }
const orderById = { A: BILL_A, B: BILL_B, C: BILL_C }

// A credit note against bill A, stored exactly the way IssueCreditNoteModal stores one.
function noteFor(order, items, id = 'n1', createdAt = '2026-09-12T06:00:00Z') {
  const a = computeOrderAmounts(order, items, true)
  return {
    id, order_id: order.id, credit_note_no: 7, created_at: createdAt,
    gross_amount: a.grossAmt, discount_amount: a.discount, taxable_amount: a.taxableBase,
    non_taxable_amount: a.nonTaxableBase, vat_amount: a.vatAmt, net_amount: a.net,
  }
}

describe('split allocation', () => {
  test('shares follow each leg, including the Loyalty leg, and sum to 1', () => {
    const shares = paymentSharesOf(BILL_A, PAYMENTS_A)
    expect(shares.map(s => s.method)).toEqual(['Cash', 'Card', 'Loyalty'])
    expect(sum(shares, 'share')).toBeCloseTo(1, 12)
  })

  test('the parts add back to the whole bill on every figure', () => {
    const whole = billAmounts(BILL_A, ITEMS_A, true)
    const parts = allocateAmounts(whole, paymentSharesOf(BILL_A, PAYMENTS_A))
    for (const k of [...AMOUNT_KEYS, 'qty']) expect(sum(parts, k)).toBeCloseTo(whole[k], 9)
  })

  test('when the legs sum to the bill, a method\'s net IS its leg — the Z-report\'s figure', () => {
    const whole = billAmounts(BILL_A, ITEMS_A, true)
    // 1000 gross − 100 discount + VAT on the discounted taxable base (800 × 0.9 × 13% = 93.6) → 994
    expect(whole.net).toBe(994)
    const parts = allocateAmounts(whole, paymentSharesOf(BILL_A, PAYMENTS_A))
    expect(parts.map(p => Math.round(p.net * 1e6) / 1e6)).toEqual([600, 294, 100])
  })

  test('a Split bill with no legs is kept whole, not dropped', () => {
    expect(paymentSharesOf(BILL_A, [])).toEqual([{ method: SPLIT_NO_BREAKDOWN, share: 1 }])
    expect(paymentSharesOf(BILL_A, [{ payment_method: 'Cash', amount: 0 }])).toEqual([{ method: SPLIT_NO_BREAKDOWN, share: 1 }])
  })

  test('a blank payment method is named, not assumed to be Cash', () => {
    expect(paymentSharesOf(BILL_C, [])).toEqual([{ method: NOT_RECORDED, share: 1 }])
  })

  test('two legs on one method are one share', () => {
    const shares = paymentSharesOf(BILL_A, [
      { payment_method: 'Cash', amount: 300 }, { payment_method: 'Cash', amount: 300 }, { payment_method: 'Card', amount: 400 },
    ])
    expect(shares).toEqual([{ method: 'Cash', share: 0.6 }, { method: 'Card', share: 0.4 }])
  })
})

describe('credit notes as minus rows', () => {
  test('a bill plus its own credit note nets to zero on every figure', () => {
    const bill = billAmounts(BILL_A, ITEMS_A, true)
    const minus = creditNoteAmounts(noteFor(BILL_A, ITEMS_A), ITEMS_A)
    const net = addAmounts(addAmounts(zeroAmounts(), bill), minus)
    for (const k of [...AMOUNT_KEYS, 'qty']) expect(net[k]).toBeCloseTo(0, 9)
  })

  test('entries hold every bill at full value and the note on its own issue moment', () => {
    const note = noteFor(BILL_A, ITEMS_A)
    const entries = buildSalesEntries({ orders: [BILL_A, BILL_B], creditNotes: [note], orderById, itemsByOrder, vatReg: true })
    expect(entries.map(e => e.kind)).toEqual(['bill', 'bill', 'return'])
    expect(entries[2].at).toBe(note.created_at)
    expect(entries[2].amounts.net).toBe(-note.net_amount)
    const total = entries.reduce((s, e) => s + e.amounts.net, 0)
    expect(total).toBe(billAmounts(BILL_B, ITEMS_B, true).net) // A and its note cancel
  })

  test('a note against a bill closed before the range still lands (orderById holds it)', () => {
    const note = noteFor(BILL_A, ITEMS_A)
    const entries = buildSalesEntries({ orders: [BILL_B], creditNotes: [note], orderById, itemsByOrder, vatReg: true })
    expect(entries).toHaveLength(2)
    expect(entries[1].order).toBe(BILL_A)
    expect(entries[1].amounts.qty).toBe(-3)
  })
})

describe('Payment Summary', () => {
  const note = noteFor(BILL_A, ITEMS_A)
  const entries = buildSalesEntries({ orders: [BILL_A, BILL_B, BILL_C], creditNotes: [note], orderById, itemsByOrder, vatReg: true })
  const payments = { A: PAYMENTS_A }
  const rows = buildPaymentRows(entries, payments)
  const by = Object.fromEntries(rows.map(r => [r.method, r]))

  test('every method in the payments gets a row, Loyalty and the unrecorded one included', () => {
    expect(new Set(rows.map(r => r.method))).toEqual(new Set(['Cash', 'Card', 'Loyalty', NOT_RECORDED]))
  })

  test('the tab reconciles to the sum of every entry, bills and minus rows', () => {
    for (const k of AMOUNT_KEYS) {
      expect(sum(rows, k)).toBeCloseTo(entries.reduce((s, e) => s + e.amounts[k], 0), 9)
    }
  })

  test('the split bill counts once under each method; the return goes to the original methods', () => {
    expect(by.Cash.bills).toBe(2) // A's Cash leg and bill B
    expect(by.Card.bills).toBe(1)
    expect(by.Cash.returns).toBe(1)
    expect(by.Card.returns).toBe(1)
    expect(by[NOT_RECORDED].returns).toBe(0)
  })

  test('Cash net minus its returns is exactly what the Z-report counts: legs + whole Cash bills', () => {
    const billA = billAmounts(BILL_A, ITEMS_A, true)
    const legsTotal = PAYMENTS_A.reduce((s, p) => s + p.amount, 0)
    expect(legsTotal).toBe(billA.net) // the till takes legs summing to the bill
    const zReportCash = 600 + billAmounts(BILL_B, ITEMS_B, true).net
    expect(by.Cash.net - by.Cash.returnNet).toBeCloseTo(zReportCash, 9)
    expect(by.Cash.returnNet).toBeCloseTo(-600, 9)
  })

  test('display order: known methods first, unknown next, the two exception rows last', () => {
    const sorted = sortByMethodOrder([{ method: NOT_RECORDED }, { method: 'Zeta' }, { method: 'Card' }, { method: 'Cash' }], ['Cash', 'Card'])
    expect(sorted.map(r => r.method)).toEqual(['Cash', 'Card', 'Zeta', NOT_RECORDED])
  })
})

describe('grouped rows (Category / Item / Product Type)', () => {
  const args = { orderById, itemsByOrder, vatReg: true, keyOf: i => i.category, labelOf: i => i.category }

  test('with no notes, buckets sum back to the bills', () => {
    const rows = buildGroupedRows({ ...args, orders: [BILL_A, BILL_B], creditNotes: [] })
    const bills = [billAmounts(BILL_A, ITEMS_A, true), billAmounts(BILL_B, ITEMS_B, true)]
    expect(sum(rows, 'gross')).toBeCloseTo(sum(bills, 'gross'), 9)
    expect(sum(rows, 'vat')).toBeCloseTo(sum(bills, 'vat'), 9)
    expect(sum(rows, 'qtyReturn')).toBe(0)
  })

  test('a note returns the credited lines: qtyReturn up, amounts down, by the bill\'s own discount ratio', () => {
    const note = noteFor(BILL_A, ITEMS_A)
    const rows = buildGroupedRows({ ...args, orders: [BILL_A, BILL_B], creditNotes: [note] })
    const by = Object.fromEntries(rows.map(r => [r.key, r]))
    expect(by.Food.qtySales).toBe(3)
    expect(by.Food.qtyReturn).toBe(2)
    expect(by.Beverage.qtyReturn).toBe(1)
    // Only bill B survives in value.
    const b = billAmounts(BILL_B, ITEMS_B, true)
    expect(by.Food.gross).toBeCloseTo(b.gross, 9)
    expect(by.Food.discount).toBeCloseTo(0, 9)
    expect(by.Beverage.gross).toBeCloseTo(0, 9)
    // And the minus side ties to the stored note (gross/discount/vat), unrounded.
    const minusOnly = buildGroupedRows({ ...args, orders: [], creditNotes: [note] })
    expect(sum(minusOnly, 'gross')).toBeCloseTo(-note.gross_amount, 9)
    expect(sum(minusOnly, 'discount')).toBeCloseTo(-note.discount_amount, 9)
    expect(sum(minusOnly, 'vat')).toBeCloseTo(-note.vat_amount, 9)
  })
})

describe('1L+ name merge', () => {
  const row = (key, name, pan, net, extra = {}) => ({ key, name, pan, walkIn: false, bills: 1, returns: 0, gross: net, taxable: net, nonTaxable: 0, vat: 0, net, ...extra })

  test('names compare trimmed, collapsed and case-folded', () => {
    expect(partyNameKey('  Ram   Bahadur  THAPA ')).toBe('ram bahadur thapa')
  })

  test('a name-only party folds into the one PAN party of the same name', () => {
    const out = mergeNameOnlyParties([
      row('pan:1', 'Himalayan Traders', '301', 60000),
      row('name:himalayan traders', ' himalayan   TRADERS', '', 50000, { bills: 2 }),
      row('w', 'CASH SALES / WALK-IN', '', 900000, { walkIn: true }),
    ])
    expect(out).toHaveLength(2)
    const h = out.find(p => p.pan === '301')
    expect(h.net).toBe(110000)
    expect(h.bills).toBe(3)
    expect(h.mergedNameOnlyBills).toBe(2)
    expect(out.find(p => p.walkIn).multiplePans).toBe(false)
  })

  test('a name held by two PANs is not merged, and the name-only row is flagged', () => {
    const out = mergeNameOnlyParties([
      row('pan:1', 'Sharma Store', '111', 70000),
      row('pan:2', 'SHARMA STORE', '222', 20000),
      row('name:sharma store', 'Sharma Store', '', 40000),
    ])
    expect(out).toHaveLength(3)
    expect(out.find(p => !p.pan).multiplePans).toBe(true)
    expect(out.filter(p => p.pan).every(p => !p.multiplePans && p.mergedNameOnlyBills === 0)).toBe(true)
    expect(sum(out, 'net')).toBe(130000) // nothing lost or double counted
  })

  test('a name-only party with no PAN twin is left alone; a merge never changes the grand total', () => {
    const input = [row('pan:1', 'A', '1', 10), row('name:b', 'B', '', 20), row('name:a', 'a', '', 5)]
    const out = mergeNameOnlyParties(input)
    expect(out.map(p => p.key)).toEqual(['pan:1', 'name:b'])
    expect(sum(out, 'net')).toBe(sum(input, 'net'))
    expect(out.find(p => p.key === 'name:b').multiplePans).toBe(false)
  })
})
