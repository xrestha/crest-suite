// backfillPosToIms writes REVENUE, so the batching this file gained needs a test rather than a
// reading. The function takes supabase/scopedFrom/scopedInsert/scopedUpdate as parameters, so the
// whole thing is exercisable by injection with no real client — which is also why the module-level
// mock below is only needed for the recipeCost import's transitive supabaseClient.
import { backfillPosOrdersToIms, countUnpostedForPeriod } from './backfillPosToIms'
import { bsToAd, formatAd, daysInBsMonth } from '../../../utils/bsCalendar'

// babel-jest hoists jest.mock above the imports, so the mocks still apply first; placed after them
// only to satisfy import/first.
jest.mock('../../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }))
jest.mock('../../../utils/recipeCost', () => ({
  // One ingredient per recipe, 2 base units each — enough to assert the depletion rows exist and
  // are bucketed by sale/comp; the explosion itself is covered by recipeCost.test.js.
  // A plain function, NOT jest.fn(impl): this project runs on CRA's jest preset, which sets
  // resetMocks: true — that strips the implementation off a jest.fn before every test, so the
  // mock would silently resolve to undefined and every write assertion below would fail on a
  // TypeError inside the code under test rather than on its own assertion.
  explodeRecipeIngredients: async (_client, ids) => Object.fromEntries(ids.map(id => [id, [{ item_id: `i-${id}`, qty: 2 }]])),
}))

// 2026-08-20 is in Bhadra 2083. The fixture said 2082 until S792: the day number never mattered to
// these tests, and since SALES-6 a bill is only posted into the period whose month it closed in.
const PERIOD = { id: 'p1', bs_year: 2083, bs_month: 5 }
// A Nepal clock time on a BS day of PERIOD's year, as a stamp with an explicit +05:45 offset.
const npt = (month, day, hhmm) => `${formatAd(bsToAd(2083, month, day))}T${hhmm}:00+05:45`

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

describe('backfillPosOrdersToIms — batching', () => {
  test('100 bills cost a bounded number of writes, not three per bill', async () => {
    const h = harness({ orders: Array.from({ length: 100 }, (_, i) => order(`o${i}`)) })
    const res = await backfillPosOrdersToIms({ ...h, period: PERIOD })

    expect(res).toEqual({ posted: 100, skipped: 0 })
    // 100 orders at WRITE_BATCH=40 → 3 batches. One sales insert + one movements insert + one
    // stamp per batch. The old shape was 300. The exact numbers are asserted rather than a
    // "fewer than" bound, so a regression to per-order writes fails loudly.
    expect(h.count('insert', 'sales_entries')).toBe(3)
    expect(h.count('insert', 'stock_movements')).toBe(3)
    expect(h.count('update', 'pos_orders')).toBe(3)
  })

  test('every bill posts its own lines exactly once', async () => {
    const h = harness({ orders: [order('a', { lines: 2 }), order('b', { lines: 3 })] })
    await backfillPosOrdersToIms({ ...h, period: PERIOD })
    const rows = h.calls.filter(c => c.kind === 'insert' && c.table === 'sales_entries').flatMap(c => c.rows)
    expect(rows.filter(r => r.pos_order_id === 'a')).toHaveLength(2)
    expect(rows.filter(r => r.pos_order_id === 'b')).toHaveLength(3)
    expect(rows.every(r => r.period_id === 'p1' && r.source === 'pos')).toBe(true)
  })

  test('a rejected batch falls back per bill, so one bad bill does not block its neighbours', async () => {
    const h = harness({ orders: [order('good1'), order('bad'), order('good2')], failSalesFor: ['bad'] })
    const res = await backfillPosOrdersToIms({ ...h, period: PERIOD })

    expect(res.posted).toBe(2)
    expect(res.skipped).toBe(1)
    // Only the two that succeeded are stamped as posted.
    const stamped = h.calls.filter(c => c.kind === 'update' && c.table === 'pos_orders')
    expect(stamped.flatMap(c => c.ids || [])).toEqual(expect.arrayContaining(['good1', 'good2']))
    expect(stamped.flatMap(c => c.ids || [])).not.toContain('bad')
  })
})

describe('backfillPosOrdersToIms — the double-post guard', () => {
  test('a bill that already has revenue is stamped, never re-posted', async () => {
    const h = harness({ orders: [order('a'), order('b')], alreadyPostedIds: ['a'] })
    const res = await backfillPosOrdersToIms({ ...h, period: PERIOD })

    expect(res).toEqual({ posted: 1, skipped: 1 })
    const rows = h.calls.filter(c => c.kind === 'insert' && c.table === 'sales_entries').flatMap(c => c.rows)
    expect(rows.map(r => r.pos_order_id)).toEqual(['b'])
  })

  test('the whole set is pre-stamped in one update, not one per bill', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `o${i}`)
    const h = harness({ orders: ids.map(id => order(id)), alreadyPostedIds: ids })
    const res = await backfillPosOrdersToIms({ ...h, period: PERIOD })

    expect(res).toEqual({ posted: 0, skipped: 50 })
    expect(h.count('update', 'pos_orders')).toBe(1)
    expect(h.count('insert', 'sales_entries')).toBe(0)
  })

  test('a FAILED already-posted check aborts rather than posting everything twice', async () => {
    // The shape that makes this the most dangerous read in the function: if it comes back empty,
    // every candidate looks unposted. It must never be treated as "none of them has revenue".
    const h = harness({ orders: [order('a')] })
    h.supabase.from = () => ({
      select: () => ({
        in: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
      }),
      insert: () => Promise.resolve({ error: null }),
    })
    const res = await backfillPosOrdersToIms({ ...h, period: PERIOD })

    expect(res.posted).toBe(0)
    expect(res.error).toMatch(/already posted/i)
    expect(h.count('insert', 'sales_entries')).toBe(0)
  })
})

describe('backfillPosOrdersToIms — what each bill contributes', () => {
  test('a comped line posts as pos_comp at full price and still depletes stock', async () => {
    const h = harness({ orders: [order('a', { comped: true })] })
    await backfillPosOrdersToIms({ ...h, period: PERIOD })
    const sales = h.calls.find(c => c.kind === 'insert' && c.table === 'sales_entries').rows
    expect(sales[0]).toMatchObject({ source: 'pos_comp', unit_price: 100 })
    const moves = h.calls.find(c => c.kind === 'insert' && c.table === 'stock_movements').rows
    expect(moves).toEqual([expect.objectContaining({ source: 'pos_comp', qty: -4, ref_id: 'a' })])
  })

  test('a bill-level discount reduces payable unit price proportionally', async () => {
    // 1 line x qty 2 x 100 = 200 gross, 50 discount -> ratio 0.75.
    const h = harness({ orders: [order('a', { discount: 50 })] })
    await backfillPosOrdersToIms({ ...h, period: PERIOD })
    const sales = h.calls.find(c => c.kind === 'insert' && c.table === 'sales_entries').rows
    expect(sales[0].unit_price).toBeCloseTo(75, 6)
  })

  test('a bill with no recipe lines is stamped and skipped, never posted', async () => {
    const h = harness({ orders: [{ ...order('a'), pos_order_items: [] }] })
    const res = await backfillPosOrdersToIms({ ...h, period: PERIOD })
    expect(res).toEqual({ posted: 0, skipped: 1 })
    expect(h.count('insert', 'sales_entries')).toBe(0)
    expect(h.count('update', 'pos_orders')).toBe(1)
  })
})

// S792, SALES-6. Independent of the runner's zone: the old `adToBs(new Date(closed_at)).day` passes
// these in Kathmandu and fails them under TZ=UTC (the first) or TZ=Asia/Tokyo (the second).
describe('backfillPosOrdersToIms — a bill is dated by Nepal\'s calendar, not the viewer\'s', () => {
  test('a bill closed ten minutes after midnight on day 1 is posted to day 1', async () => {
    const h = harness({ orders: [order('a', { closedAt: npt(5, 1, '00:10') })] })
    await backfillPosOrdersToIms({ ...h, period: PERIOD })
    const sales = h.calls.find(c => c.kind === 'insert' && c.table === 'sales_entries').rows
    const moves = h.calls.find(c => c.kind === 'insert' && c.table === 'stock_movements').rows
    expect(sales.map(r => r.bs_day)).toEqual([1])
    expect(moves.map(r => r.bs_day)).toEqual([1])
  })

  test('a bill closed ten minutes before midnight on the last day stays on the last day', async () => {
    const last = daysInBsMonth(2083, 5)
    const h = harness({ orders: [order('a', { closedAt: npt(5, last, '23:50') })] })
    await backfillPosOrdersToIms({ ...h, period: PERIOD })
    const sales = h.calls.find(c => c.kind === 'insert' && c.table === 'sales_entries').rows
    expect(sales.map(r => r.bs_day)).toEqual([last])
  })

  test('a bill from another month is left unposted and unstamped, for the next run to chase', async () => {
    const h = harness({ orders: [order('stray', { closedAt: npt(6, 1, '00:10') }), order('ok')] })
    const res = await backfillPosOrdersToIms({ ...h, period: PERIOD })
    expect(res).toEqual({ posted: 1, skipped: 1 })
    const sales = h.calls.filter(c => c.kind === 'insert' && c.table === 'sales_entries').flatMap(c => c.rows)
    expect(sales.map(r => r.pos_order_id)).toEqual(['ok'])
    const stamped = h.calls.filter(c => c.kind === 'update' && c.table === 'pos_orders').flatMap(c => c.ids || [])
    expect(stamped).not.toContain('stray')
  })
})

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
})

// S809 3j: the till floor's Post to Inventory runs this as a POS manager, often on a Staff PIN, which
// cannot read `items`; it hands in loadStockLines (posStockLines, through pos_recipe_book) so the
// trim loss is the book's, and the direct table walk is not used at all.
describe('backfillPosOrdersToIms — a recipe book handed in (S809 3j)', () => {
  test('the stock lines come from loadStockLines, asked once for every recipe', async () => {
    const asked = []
    const loadStockLines = async (recipeIds, deltaLists) => {
      asked.push({ recipeIds, deltaLists })
      // 3 base units per plate, where the mocked table walk above gives 2.
      return { breakdown: Object.fromEntries(recipeIds.map(id => [id, [{ item_id: `book-${id}`, qty: 3 }]])), explosion: { itemYield: {}, subPerUnit: {} } }
    }
    const h = harness({ orders: [order('a', { lines: 2 }), order('b')] })
    const res = await backfillPosOrdersToIms({ ...h, period: PERIOD, loadStockLines })

    expect(res).toEqual({ posted: 2, skipped: 0 })
    expect(asked).toHaveLength(1)
    expect([...asked[0].recipeIds].sort()).toEqual(['r0', 'r1'])
    const moves = h.calls.filter(c => c.kind === 'insert' && c.table === 'stock_movements').flatMap(c => c.rows)
    // Bill a: r0 and r1, 2 plates each at 3 units; bill b: r0, 2 plates. All from the book.
    expect(moves.every(m => m.item_id.startsWith('book-'))).toBe(true)
    expect(moves.filter(m => m.ref_id === 'a').map(m => m.qty)).toEqual([-6, -6])
    expect(moves.filter(m => m.ref_id === 'b').map(m => m.qty)).toEqual([-6])
  })

  test('a failed book read stops the run before anything is written', async () => {
    const loadStockLines = async () => { throw Object.assign(new Error('refused'), { hint: 'rank_required' }) }
    const h = harness({ orders: [order('a')] })
    await expect(backfillPosOrdersToIms({ ...h, period: PERIOD, loadStockLines })).rejects.toThrow('refused')
    expect(h.count('insert', 'sales_entries')).toBe(0)
    expect(h.count('update', 'pos_orders')).toBe(0)
  })
})
