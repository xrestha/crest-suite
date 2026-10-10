// S809 3m, schema v15: the Owner Report's Crest POS section.
//   IMS-HANDOFF-4 — credit notes follow the Sales Report's rule: the bill stays in the month it was
//                   sold, the note is a minus in the month it was issued (salesReportMath.js).
//   Owner decision 2026-10-10 — covers are guests seated at tables (coversMath.seatedCovers).
import fs from 'fs'
import path from 'path'

jest.mock('../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }))
jest.mock('../../shared/scopedDb', () => ({ scopedFrom: jest.fn() }))

// eslint-disable-next-line import/first
import { posSalesFigures, CURRENT_SCHEMA_VERSION } from './computeMonthlyReport'

// A PAN-bill outlet (no VAT) unless a bill says otherwise, so every net is plain arithmetic.
const T1 = { id: 'T1', table_id: 'table-1', covers: 4, payment_method: 'Cash', discount_amount: 0, vat_registered: false }
const T2 = { id: 'T2', table_id: 'table-2', covers: 2, payment_method: 'Split', discount_amount: 0, vat_registered: false }
const TA = { id: 'TA', table_id: null, covers: 1, payment_method: 'Card', discount_amount: 0, vat_registered: false }
// Closed LAST month, credited this month.
const OLD = { id: 'OLD', table_id: 'table-3', covers: 3, payment_method: 'Cash', discount_amount: 0, vat_registered: false }

const line = (orderId, category, qty, unitPrice, vatRate = 0) => ({ order_id: orderId, recipe_id: `r-${category}`, name: category, category, qty, unit_price: unitPrice, vat_rate: vatRate })
const itemsByOrder = {
  T1: [line('T1', 'Food', 2, 500)],        // 1,000
  T2: [line('T2', 'Food', 1, 600)],        //   600, credited this month
  TA: [line('TA', 'Beverage', 1, 300)],    //   300, takeaway
  OLD: [line('OLD', 'Food', 1, 800)],      //   800, last month's bill
}
const note = (id, orderId, net) => ({ id, order_id: orderId, gross_amount: net, discount_amount: 0, taxable_amount: 0, non_taxable_amount: net, vat_amount: 0, net_amount: net })
const N1 = note('N1', 'T2', 600)
const N2 = note('N2', 'OLD', 800)
const paymentsByOrder = { T2: [{ order_id: 'T2', payment_method: 'Cash', amount: 200 }, { order_id: 'T2', payment_method: 'Card', amount: 400 }] }

const month = () => posSalesFigures({
  orders: [T1, T2, TA], creditNotes: [N1, N2],
  orderById: { T1, T2, TA, OLD }, itemsByOrder, paymentsByOrder, vatReg: false,
})

describe('credit notes: the bill stays in its month, the note comes off the month it was issued', () => {
  test('a credited bill is still one of the month\'s bills', () => {
    expect(month().billCount).toBe(3)
  })
  test('Net Sales is every bill less every note issued in the month, last month\'s bill included', () => {
    const f = month()
    expect(f.totalNetSales).toBe(1000 + 600 + 300 - 600 - 800)
    expect(f.totalGross).toBe(500)
    expect(f.creditNotes).toEqual({ count: 2, net: -1400 })
  })
  test('quantities sold are net of the lines the notes returned', () => {
    expect(month().totalQty).toBe(2 + 1 + 1 - 1 - 1)
    const food = month().categoryBreakdown.find(c => c.category === 'Food')
    expect(food).toEqual({ category: 'Food', qty: 1, net: 200 })
  })
  test('a note comes off the method its bill was paid with; a Split bill is spread over its legs', () => {
    const mix = month().paymentMix
    expect(mix.map(p => p.method)).toEqual(['Card', 'Cash'])
    expect(mix.find(p => p.method === 'Card').net).toBeCloseTo(300, 6)
    expect(mix.find(p => p.method === 'Cash').net).toBeCloseTo(200, 6)
    expect(mix.find(p => p.method === 'Card').pctOfNet).toBeCloseTo(60, 6)
  })
  test('a month with no notes is the plain sum of its bills', () => {
    const f = posSalesFigures({ orders: [T1, TA], creditNotes: [], orderById: { T1, TA }, itemsByOrder, paymentsByOrder, vatReg: false })
    expect(f.totalNetSales).toBe(1300)
    expect(f.creditNotes).toEqual({ count: 0, net: 0 })
  })
})

describe('covers are guests seated at tables (owner decision 2026-10-10)', () => {
  test('takeaway brings no guests, and a credited dine-in bill keeps its guests', () => {
    const c = month().covers
    expect(c.basis).toBe('seated')
    expect(c.totalCovers).toBe(4 + 2)
    expect(c.dineInBills).toBe(2)
    expect(c.takeawayBills).toBe(1)
  })
  test('Avg Check / Cover is dine-in sales after dine-in credit notes, over seated guests', () => {
    // 1,000 + 600 − 600 (T2's note) − 800 (last month's dine-in bill's note) = 200, over 6 guests.
    expect(month().covers.avgCheckPerCover).toBeCloseTo(200 / 6, 6)
  })
  test('Avg Bill Value is Net Sales over the month\'s bills', () => {
    expect(month().covers.avgBillValue).toBeCloseTo(500 / 3, 6)
  })
  test('no seated guests: no average per cover, never a division by zero', () => {
    const f = posSalesFigures({ orders: [TA], creditNotes: [], orderById: { TA }, itemsByOrder, paymentsByOrder, vatReg: false })
    expect(f.covers.totalCovers).toBe(0)
    expect(f.covers.avgCheckPerCover).toBeNull()
  })
})

describe("the Sales Report's other two rules come with it", () => {
  test('a bill is valued as it was issued: a Tax Invoice keeps its VAT after the outlet deregisters', () => {
    const V = { id: 'V', table_id: 'table-9', covers: 2, payment_method: 'Cash', discount_amount: 0, vat_registered: true }
    const f = posSalesFigures({ orders: [V], creditNotes: [], orderById: { V }, itemsByOrder: { V: [line('V', 'Food', 1, 1000, 0.13)] }, vatReg: false })
    expect(f.totalNetSales).toBe(1130)
    expect(f.totalVat).toBeCloseTo(130, 6)
  })
  test('a bill with no payment method is "Not recorded", never Cash', () => {
    const B = { ...T1, id: 'B', payment_method: null }
    const f = posSalesFigures({ orders: [B], creditNotes: [], orderById: { B }, itemsByOrder: { B: itemsByOrder.T1 }, vatReg: false })
    expect(f.paymentMix.map(p => p.method)).toEqual(['Not recorded'])
  })
})

describe('the reads behind it', () => {
  const flat = fs.readFileSync(path.join(__dirname, 'computeMonthlyReport.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\s+/g, ' ')
  const pos = flat.slice(flat.indexOf('async function computePosSection'), flat.indexOf('export function computeCombinedMetrics'))

  test('the month is Nepal days, not the generating device\'s clock zone', () => {
    expect(pos).toMatch(/bsDayBoundaryIso\(period\.bs_year, period\.bs_month, 1, false\)/)
    expect(pos).not.toMatch(/toISOString/)
  })
  test('credited bills are no longer dropped, and the notes issued in the month are read, paged', () => {
    expect(pos).not.toMatch(/credit_note_id/)
    expect(pos).toMatch(/fetchAllRows\(\(\) => scopedFrom\('pos_credit_notes', clientId, POS_NOTE_COLUMNS\) \.gte\('created_at', fromTs\)\.lte\('created_at', toTs\)\.order\('id'\)\)/)
  })
  test('the bill read carries what seated covers and as-issued VAT need', () => {
    expect(flat).toMatch(/const POS_ORDER_COLUMNS = '[^']*\btable_id\b[^']*'/)
    expect(flat).toMatch(/const POS_ORDER_COLUMNS = '[^']*\bvat_registered\b[^']*'/)
  })
  test('the schema version moved with the meaning', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(15)
  })
})
