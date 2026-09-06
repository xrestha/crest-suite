// depleteManualSales reads the POS-supersedes guard through the `supabase` it is HANDED, but
// deletes and inserts through scopedDb, which imports the module-level client — so both are
// mocked: the handed-in one is scripted per test, the module one records what was written.
jest.mock('../../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }))

import { supabase as moduleClient } from '../../../supabaseClient'
import { depleteManualSales } from './persistSalesDay'

function builder(result) {
  const b = {
    eq: () => b, in: () => b, select: () => b,
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  }
  return b
}

const ROWS = [{ recipe_id: 'r1', qty_sold: 2 }]
const ARGS = { clientId: 'c1', periodId: 'p1', bsDay: 5, rows: ROWS }

let deletes, inserts
beforeEach(() => {
  deletes = 0; inserts = 0
  moduleClient.from.mockImplementation(() => ({
    delete: () => { deletes++; return builder({ error: null }) },
    insert: () => { inserts++; return builder({ data: [], error: null }) },
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
    expect(deletes).toBe(0)
    expect(inserts).toBe(0)
    expect(console.error).toHaveBeenCalledTimes(1)
    expect(console.error.mock.calls[0][0]).toMatch(/could not run/)
  })

  test('POS already sold the recipe that day: the day is cleared and nothing is re-deposited', async () => {
    const handed = { from: () => builder({ data: [{ recipe_id: 'r1', bs_day: 5 }], error: null }) }
    await depleteManualSales(handed, ARGS)
    expect(deletes).toBe(1)
    expect(inserts).toBe(0)
  })

  test('a refused delete stops the reinsert — rows still there must not be depleted twice', async () => {
    moduleClient.from.mockImplementation(() => ({
      delete: () => { deletes++; return builder({ error: { code: '42501', message: 'permission denied' } }) },
      insert: () => { inserts++; return builder({ error: null }) },
    }))
    const handed = { from: () => builder({ data: [], error: null }) }
    await depleteManualSales(handed, ARGS)
    expect(deletes).toBe(1)
    expect(inserts).toBe(0)
  })

  test('no candidate rows: the day is still cleared (a re-save with fewer rows), and no guard read is made', async () => {
    const from = jest.fn(() => builder({ data: [], error: null }))
    await depleteManualSales({ from }, { ...ARGS, rows: [{ recipe_id: 'r1', qty_sold: 0 }] })
    expect(from).not.toHaveBeenCalled()
    expect(deletes).toBe(1)
    expect(inserts).toBe(0)
  })
})
