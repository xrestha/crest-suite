// depleteManualSales reads the POS-supersedes guard through the `supabase` it is HANDED, but
// deletes and inserts through scopedDb, which imports the module-level client — so both are
// mocked: the handed-in one is scripted per test, the module one records what was written.
jest.mock('../../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }))
// The ingredient explosion is its own tested module; here it only has to hand back a breakdown.
// A plain function, not jest.fn(): CRA's resetMocks wipes a jest.fn implementation before each test.
jest.mock('../../../utils/recipeCost', () => ({
  explodeRecipeIngredients: async () => ({
    r1: [{ item_id: 'flour', qty: 0.2 }],
    r2: [{ item_id: 'flour', qty: 0.1 }, { item_id: 'oil', qty: 0.05 }],
  }),
}))

import { supabase as moduleClient } from '../../../supabaseClient'
import { depleteManualSales, repostSupersededMovements } from './persistSalesDay'

// Chainable, thenable stand-in for a PostgrestBuilder that records every filter applied to it.
function builder(result, rec = { filters: [] }) {
  const b = {
    rec,
    eq: (c, v) => { rec.filters.push(['eq', c, v]); return b },
    in: (c, v) => { rec.filters.push(['in', c, v]); return b },
    or: (e) => { rec.filters.push(['or', e]); return b },
    select: () => b,
    order: (c) => { rec.order = c; return b },
    range: () => b,
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  }
  return b
}

const ROWS = [{ recipe_id: 'r1', qty_sold: 2 }]
const ARGS = { clientId: 'c1', periodId: 'p1', bsDay: 5, rows: ROWS }

let deletes, inserts
beforeEach(() => {
  deletes = []; inserts = []
  moduleClient.from.mockImplementation(() => ({
    delete: () => { const rec = { filters: [] }; deletes.push(rec); return builder({ error: null }, rec) },
    insert: (rows) => { inserts.push(rows); return builder({ data: [], error: null }) },
  }))
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { console.error.mockRestore() })

// The guard this file exists for (S683): on a failed POS read the index used to come back empty,
// every manual row was treated as not superseded, and a recipe POS had already depleted was
// depleted again. A check that could not run has not passed — and because the delete now waits
// for the read, the previous save's movements survive rather than the day going empty.
describe('depleteManualSales — the POS-supersedes guard', () => {
  test('a failed guard read writes NOTHING: no delete, no insert', async () => {
    const handed = { from: () => builder({ data: null, error: { message: 'TypeError: Failed to fetch' } }) }
    await depleteManualSales(handed, ARGS)
    expect(deletes).toHaveLength(0)
    expect(inserts).toHaveLength(0)
    expect(console.error).toHaveBeenCalledTimes(1)
    expect(console.error.mock.calls[0][0]).toMatch(/could not run/)
  })

  test('POS already sold the recipe that day: the day is cleared and nothing is re-deposited', async () => {
    const handed = { from: () => builder({ data: [{ recipe_id: 'r1', bs_day: 5 }], error: null }) }
    await depleteManualSales(handed, ARGS)
    expect(deletes).toHaveLength(1)
    expect(inserts).toHaveLength(0)
  })

  test('a refused delete stops the reinsert — rows still there must not be depleted twice', async () => {
    moduleClient.from.mockImplementation(() => ({
      delete: () => { deletes.push({}); return builder({ error: { code: '42501', message: 'permission denied' } }) },
      insert: (rows) => { inserts.push(rows); return builder({ error: null }) },
    }))
    const handed = { from: () => builder({ data: [], error: null }) }
    await depleteManualSales(handed, ARGS)
    expect(deletes).toHaveLength(1)
    expect(inserts).toHaveLength(0)
  })

  test('no candidate rows: the day is still cleared (a re-save with fewer rows), and no guard read is made', async () => {
    const from = jest.fn(() => builder({ data: [], error: null }))
    await depleteManualSales({ from }, { ...ARGS, rows: [{ recipe_id: 'r1', qty_sold: 0 }] })
    expect(from).not.toHaveBeenCalled()
    expect(deletes).toHaveLength(1)
    expect(inserts).toHaveLength(0)
  })

  test('the delete is scoped to this day and to manual movements only', async () => {
    const handed = { from: () => builder({ data: [], error: null }) }
    await depleteManualSales(handed, ARGS)
    expect(deletes[0].filters).toEqual(expect.arrayContaining([
      ['eq', 'period_id', 'p1'], ['eq', 'bs_day', 5], ['eq', 'source', 'manual'],
    ]))
    expect(inserts[0]).toEqual([{ item_id: 'flour', period_id: 'p1', bs_day: 5, qty: -0.4, source: 'manual', client_id: 'c1' }])
  })

  // S756: the guard read is chunked + paged, so it must carry a unique tiebreaker.
  test('the guard read is ordered by id, so paging cannot repeat or skip a POS row', async () => {
    const recs = []
    const handed = { from: () => { const rec = { filters: [] }; recs.push(rec); return builder({ data: [], error: null }, rec) } }
    await depleteManualSales(handed, ARGS)
    expect(recs[0].order).toBe('id')
  })
})

// S756: a cross-mode supersede deletes the OTHER mode's sales rows, and those days' manual
// movements used to survive — the item was depleted by the new row and again by the rows it
// replaced. The superseded days are rebuilt from what they still hold.
describe('repostSupersededMovements', () => {
  // The handed client serves two reads off sales_entries: the remaining manual rows for the
  // superseded days (selects qty_sold) and the POS guard (does not).
  function handedWith({ manual, pos = { data: [], error: null } }) {
    const recs = []
    return {
      recs,
      from: () => ({
        select: (cols) => {
          const rec = { cols, filters: [] }
          recs.push(rec)
          return builder(cols.includes('qty_sold') ? manual : pos, rec)
        },
      }),
    }
  }

  test('Bulk superseded days 4 and 7: one delete over both, re-posting only what day 4 still holds', async () => {
    const handed = handedWith({ manual: { data: [{ recipe_id: 'r2', bs_day: 4, qty_sold: 10, source: 'manual' }], error: null } })
    await repostSupersededMovements(handed, { clientId: 'c1', periodId: 'p1', days: [7, 4, 4] })

    const manualRead = handed.recs.find(r => r.cols.includes('qty_sold'))
    expect(manualRead.filters).toEqual(expect.arrayContaining([
      ['eq', 'period_id', 'p1'], ['or', 'source.is.null,source.eq.manual'], ['in', 'bs_day', [7, 4]],
    ]))
    expect(manualRead.order).toBe('id')

    expect(deletes).toHaveLength(1)
    expect(deletes[0].filters).toEqual(expect.arrayContaining([['in', 'bs_day', [7, 4]], ['eq', 'source', 'manual']]))
    // Day 7 had nothing left, so it is cleared and gets no movement back.
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toEqual([
      { item_id: 'flour', period_id: 'p1', bs_day: 4, qty: -1, source: 'manual', client_id: 'c1' },
      { item_id: 'oil', period_id: 'p1', bs_day: 4, qty: -0.5, source: 'manual', client_id: 'c1' },
    ])
  })

  test('Daily superseded the Bulk row: day 0 is rebuilt, with the POS guard read across the whole period', async () => {
    const handed = handedWith({
      manual: { data: [{ recipe_id: 'r1', bs_day: 0, qty_sold: 5, source: null }], error: null },
      pos: { data: [], error: null },
    })
    await repostSupersededMovements(handed, { clientId: 'c1', periodId: 'p1', days: [0] })
    const guard = handed.recs.find(r => !r.cols.includes('qty_sold'))
    expect(guard.filters.some(f => f[1] === 'bs_day')).toBe(false)
    expect(deletes[0].filters).toEqual(expect.arrayContaining([['eq', 'bs_day', 0], ['eq', 'source', 'manual']]))
    expect(inserts[0]).toEqual([{ item_id: 'flour', period_id: 'p1', bs_day: 0, qty: -1, source: 'manual', client_id: 'c1' }])
  })

  test('a failed read of the superseded days writes nothing', async () => {
    const handed = handedWith({ manual: { data: null, error: { message: 'TypeError: Failed to fetch' } } })
    await repostSupersededMovements(handed, { clientId: 'c1', periodId: 'p1', days: [3] })
    expect(deletes).toHaveLength(0)
    expect(inserts).toHaveLength(0)
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  test('no superseded days: no reads, no writes', async () => {
    const handed = handedWith({ manual: { data: [], error: null } })
    await repostSupersededMovements(handed, { clientId: 'c1', periodId: 'p1', days: [] })
    expect(handed.recs).toHaveLength(0)
    expect(deletes).toHaveLength(0)
  })
})
