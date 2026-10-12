// The two dashboard sales loaders (S814 4d, REPORTS-9 / IMS-HANDOFF-7), against an in-memory table
// set that filters the way PostgREST does for the calls these loaders make.
import { loadFromSalesEntries, loadFromPos } from './useSalesPivotData'
import { bsToAd, formatAd } from '../../utils/bsCalendar'

jest.mock('../../context/AuthContext', () => ({ useAuth: jest.fn() }))
jest.mock('../../shared/hooks/useScopedDb', () => ({ useScopedDb: jest.fn() }))

const mockTables = {}
jest.mock('../../supabaseClient', () => ({
  supabase: { from: table => ({ select: () => mockBuilder(table) }) },
}))

// A PostgREST-ish builder: filters collect, `.range()` and `.maybeSingle()` resolve. Timestamps are
// compared as instants, so a `+05:45` boundary and a `Z` row compare the way Postgres compares them.
function mockBuilder(table) {
  const filters = []
  const val = v => (typeof v === 'string' && /T\d\d:/.test(v) ? Date.parse(v) : v)
  const rows = () => (mockTables[table] || []).filter(r => filters.every(f => f(r)))
  const b = {
    eq: (c, v) => { filters.push(r => r[c] === v); return b },
    gte: (c, v) => { filters.push(r => val(r[c]) >= val(v)); return b },
    lte: (c, v) => { filters.push(r => val(r[c]) <= val(v)); return b },
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return b },
    order: () => b,
    range: (from, to) => Promise.resolve({ data: rows().slice(from, to + 1), error: null }),
    maybeSingle: () => Promise.resolve({ data: rows()[0] || null, error: null }),
  }
  return b
}
const scopedFrom = table => mockBuilder(table)

// Ashwin 2083 (month 6), BLOOM CAFE's month.
const PERIOD = { id: 'p-ashwin', bs_year: 2083, bs_month: 6 }
const nepalAt = (bsDay, hhmm, month = 6) => `${formatAd(bsToAd(2083, month, bsDay))}T${hhmm}:00+05:45`

beforeEach(() => { for (const k of Object.keys(mockTables)) delete mockTables[k] })

describe('loadFromSalesEntries', () => {
  beforeEach(() => {
    mockTables.recipes = [{ id: 'momo', category: 'Food', selling_price: 1000 }, { id: 'tea', category: 'Beverage', selling_price: 50 }]
    mockTables.sales_entries = [
      // A till bill of NPR 2,000 on day 11, credited on day 12.
      { period_id: 'p-ashwin', recipe_id: 'momo', bs_day: 11, qty_sold: 2, unit_price: 1000, discount: 0, source: 'pos' },
      { period_id: 'p-ashwin', recipe_id: 'momo', bs_day: 12, qty_sold: -2, unit_price: 1000, discount: 0, source: 'pos_credit' },
      // BLOOM CAFE's live reversals on Ashwin 18: till returns, never hand-entered sales.
      { period_id: 'p-ashwin', recipe_id: 'tea', bs_day: 18, qty_sold: -9, unit_price: 50, discount: 0, source: 'pos_credit' },
      { period_id: 'p-ashwin', recipe_id: 'tea', bs_day: 18, qty_sold: -16, unit_price: 10, discount: 0, source: 'pos_credit' },
      // A comp: never revenue on either card.
      { period_id: 'p-ashwin', recipe_id: 'momo', bs_day: 11, qty_sold: 1, unit_price: 1000, discount: 0, source: 'pos_comp' },
    ]
  })

  test('the manual pivot shows only hand-entered rows: a till bill and its credit note are not in it', async () => {
    expect(await loadFromSalesEntries(PERIOD, scopedFrom)).toEqual([])
  })

  test('BLOOM CAFE\'s −450 / −160 pos_credit rows on Ashwin 18 do not come off hand-entered sales', async () => {
    mockTables.sales_entries.push({ period_id: 'p-ashwin', recipe_id: 'tea', bs_day: 18, qty_sold: 20, unit_price: 50, discount: 0, source: null })
    expect(await loadFromSalesEntries(PERIOD, scopedFrom)).toEqual([{ category: 'Beverage', day: 18, amount: 1000 }])
  })

  test('a legacy row with no source and a "manual" row are both hand-entered', async () => {
    mockTables.sales_entries = [
      { period_id: 'p-ashwin', recipe_id: 'momo', bs_day: 3, qty_sold: 1, unit_price: null, discount: 100, source: null },
      { period_id: 'p-ashwin', recipe_id: 'tea', bs_day: 0, qty_sold: 4, unit_price: 50, discount: 0, source: 'manual' },
    ]
    const rows = await loadFromSalesEntries(PERIOD, scopedFrom)
    expect(rows).toEqual(expect.arrayContaining([
      { category: 'Food', day: 3, amount: 900 }, // today's menu price for a row with none, less its discount
      { category: 'Beverage', day: 0, amount: 200 },
    ]))
  })

  test('Sales Mix (the revenue mode) nets the till bill and its note to 0: the note comes off once', async () => {
    const rows = await loadFromSalesEntries(PERIOD, scopedFrom, { sources: 'revenue' })
    const byCat = {}
    for (const r of rows) byCat[r.category] = (byCat[r.category] || 0) + r.amount
    expect(byCat.Food).toBe(0) // +2,000 on day 11, −2,000 on day 12, the comp left out
    expect(byCat.Beverage).toBe(-610) // the two Ashwin 18 reversals, each once
  })
})

describe('loadFromPos', () => {
  const line = (orderId, over) => ({ order_id: orderId, category: 'Food', qty: 1, unit_price: 1000, vat_rate: 0.13, comped: false, ...over })
  // A test machine on Nepal time cannot show a viewer abroad (Jest pins the zone), so the day rule is
  // also read from the source: the day is Nepal's (nepalBs), never `adToBs(new Date(...))`, which
  // reads the viewer's clock and put a 23:59 bill on the next day for an operator in Tokyo.
  test('the day comes from Nepal\'s calendar, not the viewer\'s clock', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'useSalesPivotData.js'), 'utf8')
    expect(src).toMatch(/const bs = nepalBs\(ts\)/)
    expect(src).not.toMatch(/adToBs\(new Date/)
  })
  beforeEach(() => {
    mockTables.settings = [{ client_id: 'c1', is_vat_registered: true }]
    mockTables.pos_credit_notes = []
    mockTables.pos_order_items = []
    mockTables.pos_orders = []
  })

  test('a bill closed at 23:59 Nepal time lands on that Nepal day, whatever the viewer\'s clock', async () => {
    mockTables.pos_orders = [{ id: 'late', close_type: 'paid', closed_at: nepalAt(11, '23:59'), discount_amount: 0, vat_registered: true }]
    mockTables.pos_order_items = [line('late')]
    const rows = await loadFromPos(PERIOD, scopedFrom, 'c1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ category: 'Food', day: 11 })
    expect(rows[0].billed).toBeCloseTo(1130, 9)
    expect(rows[0].exVat).toBeCloseTo(1000, 9)
    expect(rows[0].amount).toBe(rows[0].billed) // the pivot shows billed
  })

  test('a credited bill stays on its day in full; the note is a minus on the day it was issued', async () => {
    mockTables.pos_orders = [{ id: 'b1', close_type: 'paid', closed_at: nepalAt(11, '13:00'), discount_amount: 0, vat_registered: true, credit_note_id: 'n1' }]
    mockTables.pos_order_items = [line('b1', { qty: 2 })]
    mockTables.pos_credit_notes = [{ id: 'n1', order_id: 'b1', created_at: nepalAt(12, '10:00') }]
    const rows = await loadFromPos(PERIOD, scopedFrom, 'c1')
    const by = Object.fromEntries(rows.map(r => [r.day, r.billed]))
    expect(by[11]).toBeCloseTo(2260, 9)
    expect(by[12]).toBeCloseTo(-2260, 9)
  })

  test('a note issued this period against an earlier period\'s bill is a minus on the note\'s day', async () => {
    mockTables.pos_orders = [{ id: 'old', close_type: 'paid', closed_at: nepalAt(28, '19:00', 5), discount_amount: 0, vat_registered: true, credit_note_id: 'n2' }]
    mockTables.pos_order_items = [line('old', { category: 'Beverage', unit_price: 500, vat_rate: 0 })]
    mockTables.pos_credit_notes = [{ id: 'n2', order_id: 'old', created_at: nepalAt(2, '09:30') }]
    const rows = await loadFromPos(PERIOD, scopedFrom, 'c1')
    expect(rows).toEqual([{ category: 'Beverage', day: 2, billed: -500, exVat: -500, amount: -500 }])
  })

  test('a comped line is not revenue; a quiet month is no rows', async () => {
    mockTables.pos_orders = [{ id: 'c', close_type: 'paid', closed_at: nepalAt(5, '12:00'), discount_amount: 0, vat_registered: true }]
    mockTables.pos_order_items = [line('c', { comped: true })]
    expect(await loadFromPos(PERIOD, scopedFrom, 'c1')).toEqual([])
    mockTables.pos_orders = []
    expect(await loadFromPos(PERIOD, scopedFrom, 'c1')).toEqual([])
  })

  test('a failed read throws, so the card says so rather than showing an empty month', async () => {
    const failing = table => {
      const b = mockBuilder(table)
      if (table === 'pos_credit_notes') b.range = () => Promise.resolve({ data: null, error: { message: 'permission denied', code: '42501' } })
      return b
    }
    await expect(loadFromPos(PERIOD, failing, 'c1')).rejects.toThrow()
  })
})
