// What a closed bill posts to Inventory (billSalesRows / billMovementRows, the app's statement of the
// server's post, S830 5f-1), the confirm dialog's count (countUnpostedForPeriod), and the page's loop
// over the server's post of waiting bills (postWaitingBills, S830 5f-2). The functions take their
// clients as parameters, so all of it runs by injection with no real client.
import { countUnpostedForPeriod, billSalesRows, billMovementRows, postWaitingBills } from './backfillPosToIms'
import { bsDayBoundaryIso } from '../../../utils/bsCalendar'

// babel-jest hoists jest.mock above the imports; placed after them only to satisfy import/first.
jest.mock('../../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }))

// 2026-08-20 is in Bhadra 2083.
const PERIOD = { id: 'p1', bs_year: 2083, bs_month: 5 }

// A bill closed inside Bhadra 2083, with `lines` recipe lines.
function order(id, { lines = 1, comped = false, closeType = 'paid', discount = 0, closedAt = '2026-08-20T10:00:00+05:45' } = {}) {
  return {
    id,
    close_type: closeType,
    closed_at: closedAt,
    discount_amount: discount,
    pos_order_items: Array.from({ length: lines }, (_, i) => ({
      recipe_id: `r${i}`, qty: 2, unit_price: 100, vat_rate: 0.13, comped,
    })),
  }
}

// Chainable, thenable stand-in for a PostgrestBuilder, recording every call so a test can count
// ROUND TRIPS — which is the whole point of the change under test.
function harness({ orders = [], alreadyPostedIds = [], failSalesFor = [] } = {}) {
  const calls = []
  const thenable = (rec, result) => {
    const b = {
      eq: () => b, is: () => b, gte: () => b, lte: () => b, in: (c, v) => { rec.ids = v; return b },
      order: () => b,
      range: (from, to) => { rec.range = [from, to]; return b },
      select: () => b,
      then: (res, rej) => Promise.resolve(typeof result === 'function' ? result(rec) : result).then(res, rej),
    }
    return b
  }

  const scopedFrom = (table, cols) => {
    const rec = { kind: 'select', table, cols }
    calls.push(rec)
    return thenable(rec, r => {
      // fetchAllRows pages with .range(); serve page 0 and then an empty page.
      const page = r.range ? r.range[0] : 0
      return { data: page === 0 ? orders : [], error: null }
    })
  }

  const supabase = {
    from: table => ({
      select: cols => {
        const rec = { kind: 'select', table, cols }
        calls.push(rec)
        return thenable(rec, r => {
          const page = r.range ? r.range[0] : 0
          const rows = page === 0 ? alreadyPostedIds.map(id => ({ pos_order_id: id, id: `se-${id}` })) : []
          return { data: rows, error: null }
        })
      },
      insert: rows => {
        const ids = [...new Set(rows.map(r => r.pos_order_id))]
        const rec = { kind: 'insert', table, rows, orderIds: ids }
        calls.push(rec)
        const bad = ids.filter(id => failSalesFor.includes(id))
        return Promise.resolve(bad.length > 0 ? { error: { message: `rejected ${bad.join(',')}` } } : { error: null })
      },
    }),
  }

  const scopedInsert = async (table, rows) => { calls.push({ kind: 'insert', table, rows }); return { error: null } }
  const scopedUpdate = (table, patch) => {
    const rec = { kind: 'update', table, patch }
    calls.push(rec)
    return thenable(rec, { error: null })
  }

  return { calls, supabase, scopedFrom, scopedInsert, scopedUpdate,
    count: (kind, table) => calls.filter(c => c.kind === kind && c.table === table).length }
}

describe('countUnpostedForPeriod', () => {
  test('subtracts the bills that already have revenue', async () => {
    const h = harness({ orders: [order('a'), order('b'), order('c')], alreadyPostedIds: ['b'] })
    await expect(countUnpostedForPeriod({ supabase: h.supabase, scopedFrom: h.scopedFrom, period: PERIOD })).resolves.toBe(2)
  })

  test('throws on a failed read instead of reporting "no unposted bills"', async () => {
    const h = harness({ orders: [] })
    h.scopedFrom = () => ({
      eq: function () { return this }, is: function () { return this },
      gte: function () { return this }, lte: function () { return this },
      order: function () { return this },
      range: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
    })
    await expect(countUnpostedForPeriod({ supabase: h.supabase, scopedFrom: h.scopedFrom, period: PERIOD }))
      .rejects.toThrow('boom')
  })

  // S831 5f-3 (Q31 a): a bill closed before the outlet's Inventory began is never sent, so the count's
  // window starts at the later of the month's first day and the stamp, as post_waiting_pos_bills' does.
  test.each([
    ['a stamp inside the month starts the window there', '2026-08-25T18:15:00+00:00', '2026-08-25T18:15:00.000Z'],
    ['a stamp before the month leaves the month start', '2026-01-01T00:00:00+00:00', 'month'],
    ['no stamp leaves the month start', null, 'month'],
  ])('%s', async (_name, imsSince, expected) => {
    const gte = []
    const b = {
      eq: () => b, is: () => b, lte: () => b, order: () => b,
      gte: (col, v) => { gte.push([col, v]); return b },
      range: () => Promise.resolve({ data: [], error: null }),
    }
    await expect(countUnpostedForPeriod({ supabase: {}, scopedFrom: () => b, period: PERIOD, imsSince })).resolves.toBe(0)
    const from = expected === 'month' ? bsDayBoundaryIso(PERIOD.bs_year, PERIOD.bs_month, 1, false) : expected
    expect(gte[0]).toEqual(['closed_at', from])
  })
})

// S809 3j: the till floor's Post to Inventory runs this as a POS manager, often on a Staff PIN, which
// cannot read `items`; it hands in loadStockLines (posStockLines, through pos_recipe_book) so the
// trim loss is the book's, and the direct table walk is not used at all.

describe('billSalesRows / billMovementRows — what one stored bill posts', () => {
  const line = (recipe_id, qty, unit_price, extra = {}) => ({ recipe_id, qty, unit_price, vat_rate: 0.13, comped: false, selection_key: '', ...extra })

  test('the bill discount is spread over the non-comped lines; a comped line posts as pos_comp at full price', () => {
    // Payable: 2 × 100 + 1 × 200 = 400; discount 100 → 25% off each payable line. The comped dessert
    // is not in that base and keeps its price.
    const bill = { id: 'b1', close_type: 'paid', discount_amount: 100, pos_order_items: [
      line('r-momo', 2, 100), line('r-tea', 1, 200), line('r-cake', 1, 300, { comped: true }),
    ] }
    const rows = billSalesRows(bill, { id: 'p6' }, 5)
    expect(rows).toEqual([
      expect.objectContaining({ recipe_id: 'r-momo', source: 'pos', qty_sold: 2, unit_price: 75, bs_day: 5, period_id: 'p6', pos_order_id: 'b1' }),
      expect.objectContaining({ recipe_id: 'r-tea', source: 'pos', qty_sold: 1, unit_price: 150 }),
      expect.objectContaining({ recipe_id: 'r-cake', source: 'pos_comp', qty_sold: 1, unit_price: 300 }),
    ])
  })

  test('a Complimentary (writeoff) bill posts every line as pos_comp at full price, whatever its discount', () => {
    const bill = { id: 'b2', close_type: 'writeoff', discount_amount: 50, pos_order_items: [line('r-momo', 2, 100), line('r-tea', 1, 200)] }
    const rows = billSalesRows(bill, { id: 'p6' }, 7)
    expect(rows.map(r => [r.source, r.unit_price])).toEqual([['pos_comp', 100], ['pos_comp', 200]])
  })

  test('no stored VAT rate posts 0; a line with no recipe posts nothing; choices ride along', () => {
    const bill = { id: 'b3', close_type: 'paid', discount_amount: 0, pos_order_items: [
      line('r-momo', 1, 100, { vat_rate: null }),
      { ...line(null, 1, 50) },
      line('r-bowl', 1, 300, { selection_key: 'o1', pos_order_item_options: [{ ingredient_deltas: [{ item_id: 'i-cheese', qty: 30 }] }] }),
    ] }
    const rows = billSalesRows(bill, { id: 'p6' }, 1)
    expect(rows).toHaveLength(2)
    expect(rows[0].vat_rate).toBe(0)
    expect(rows[0]).not.toHaveProperty('ingredient_deltas')
    expect(rows[1].ingredient_deltas).toEqual([{ item_id: 'i-cheese', qty: 30 }])
  })

  test('movements: recipe lines and choices per plate, split sale/comp, zero sums dropped, linked to the bill', () => {
    const bill = { id: 'b4', close_type: 'paid', discount_amount: 0, pos_order_items: [
      line('r-momo', 2, 100),
      line('r-cake', 1, 300, { comped: true }),
      // "No onion" on a dish whose recipe has 5 onion per plate: it nets to zero and is dropped.
      line('r-soup', 1, 150, { selection_key: 'o9', pos_order_item_options: [{ ingredient_deltas: [{ item_id: 'i-onion', qty: -5 }] }] }),
    ] }
    const breakdown = { 'r-momo': [{ item_id: 'i-flour', qty: 3 }], 'r-cake': [{ item_id: 'i-flour', qty: 1 }], 'r-soup': [{ item_id: 'i-onion', qty: 5 }] }
    const moves = billMovementRows(bill, { id: 'p6' }, 5, { breakdown, explosion: { itemYield: {}, subPerUnit: {} } })
    expect(moves).toEqual([
      { item_id: 'i-flour', period_id: 'p6', bs_day: 5, qty: -6, source: 'pos_sale', ref_id: 'b4' },
      { item_id: 'i-flour', period_id: 'p6', bs_day: 5, qty: -1, source: 'pos_comp', ref_id: 'b4' },
    ])
  })
})

describe('postWaitingBills — the server posts a month\'s waiting bills (S830 5f-2)', () => {
  // One answer per call, in order; records each call's arguments.
  const rpcStub = answers => {
    const calls = []
    return {
      calls,
      rpc: (name, args) => {
        calls.push([name, args])
        return Promise.resolve(answers[Math.min(calls.length - 1, answers.length - 1)])
      },
    }
  }
  const answer = (o = {}) => ({ data: { posted: 0, already: 0, nothing_to_post: 0, not_posted: 0, failed: 0, remaining: 0, error: null, ...o }, error: null })

  test('asks for the month a batch at a time until none wait, adding up what each call did', async () => {
    const sb = rpcStub([answer({ posted: 100, remaining: 30 }), answer({ posted: 28, already: 1, nothing_to_post: 1, remaining: 0 })])
    const r = await postWaitingBills(sb, 'p6')
    expect(sb.calls).toEqual([
      ['post_waiting_pos_bills', { p_period_id: 'p6', p_limit: 100 }],
      ['post_waiting_pos_bills', { p_period_id: 'p6', p_limit: 100 }],
    ])
    expect(r).toEqual({ posted: 128, skipped: 2, waiting: 0 })
  })

  test('stops when a call moves nothing, and names the bills still waiting with the last failure', async () => {
    const sb = rpcStub([
      answer({ posted: 5, failed: 2, remaining: 2, error: 'insert or update on table "stock_movements" violates foreign key' }),
      answer({ failed: 2, remaining: 2, error: 'insert or update on table "stock_movements" violates foreign key' }),
    ])
    const r = await postWaitingBills(sb, 'p6')
    expect(sb.calls).toHaveLength(2)
    expect(r).toEqual({ posted: 5, skipped: 0, waiting: 2, failedText: 'insert or update on table "stock_movements" violates foreign key' })
  })

  test('a refused call returns its error with what earlier calls posted', async () => {
    const refusal = { code: '42501', hint: 'rank_required', message: 'post_waiting_pos_bills: till bills are posted to Inventory by the Owner…' }
    const sb = rpcStub([answer({ posted: 100, remaining: 4 }), { data: null, error: refusal }])
    const r = await postWaitingBills(sb, 'p6')
    expect(r).toEqual({ posted: 100, skipped: 0, waiting: 4, error: refusal })
  })

  test('never calls more than maxCalls times, however many still wait', async () => {
    const sb = rpcStub([answer({ posted: 1, remaining: 999 })])
    const r = await postWaitingBills(sb, 'p6', { maxCalls: 3 })
    expect(sb.calls).toHaveLength(3)
    expect(r).toMatchObject({ posted: 3, waiting: 999 })
  })
})

// S839 (docs/pos-combos.md): Inventory revenue never takes a bill discount off a combo's dishes.
describe('billSalesRows and combos', () => {
  const { billSalesRows } = require('./backfillPosToIms')
  test('a combo dish posts at its own price; the discount spreads over the other lines', () => {
    const order = {
      id: 'o1', close_type: 'paid', discount_amount: 20,
      pos_order_items: [
        { recipe_id: 'tea', qty: 2, unit_price: 100, vat_rate: 0.13, selection_key: '' },
        { recipe_id: 'momo', qty: 1, unit_price: 206.49, vat_rate: 0.13, combo_line_id: 'c1', selection_key: '@c1/g1', pos_order_item_options: [] },
      ],
    }
    const rows = billSalesRows(order, { id: 'p' }, 3)
    expect(rows.find(r => r.recipe_id === 'tea').unit_price).toBeCloseTo(90, 10)
    expect(rows.find(r => r.recipe_id === 'momo').unit_price).toBe(206.49)
  })
})
