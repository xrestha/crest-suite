import { persistSalesDay, isMissingFunctionError, findSupersededRows } from './persistSalesDay'

// Minimal stand-in for a PostgrestBuilder: chainable, records what was called on it, and is
// thenable (the real builder is a thenable too, not a Promise — see withTimeout.js).
function makeMockSupabase({ rpcResult = { error: null }, rpcResults, tableResult = { error: null }, selectResult, refreshResult = { error: null } } = {}) {
  const calls = []
  // rpcResults lets a test script a sequence (e.g. expired token, then success after refresh).
  const rpcQueue = rpcResults ? [...rpcResults] : null

  const builder = (rec) => {
    calls.push(rec)
    const result = () => {
      if (rec.kind === 'rpc') return rpcQueue ? (rpcQueue.shift() ?? { error: null }) : rpcResult
      if (rec.kind === 'select') return selectResult ?? { data: [], error: null }
      return tableResult
    }
    const b = {
      eq: (c, v) => { rec.filters.push(['eq', c, v]); return b },
      gt: (c, v) => { rec.filters.push(['gt', c, v]); return b },
      in: (c, v) => { rec.filters.push(['in', c, v]); return b },
      abortSignal: (s) => { rec.signal = s; return b },
      then: (res, rej) => Promise.resolve(result()).then(res, rej),
    }
    return b
  }

  return {
    calls,
    auth: { refreshSession: async () => { calls.push({ kind: 'refreshSession', filters: [] }); return refreshResult } },
    rpc: (fn, params) => builder({ kind: 'rpc', fn, params, filters: [] }),
    from: () => ({
      delete: () => builder({ kind: 'delete', filters: [] }),
      insert: (rows) => builder({ kind: 'insert', rows, filters: [] }),
      select: (cols) => builder({ kind: 'select', cols, filters: [] }),
    }),
  }
}

const ROWS = [{ recipe_id: 'r1', qty_sold: 3, unit_price: 30.97, vat_rate: 13, discount: 5 }]
const MISSING_FN = { error: { code: 'PGRST202', message: 'Could not find the function public.save_sales_day' } }

describe('isMissingFunctionError', () => {
  test('detects the not-yet-migrated cases', () => {
    expect(isMissingFunctionError({ code: 'PGRST202', message: '' })).toBe(true)
    expect(isMissingFunctionError({ code: '42883', message: '' })).toBe(true)
    expect(isMissingFunctionError({ message: 'Could not find the function public.save_sales_day' })).toBe(true)
  })

  test('does NOT swallow a real error as a missing function', () => {
    // Critical: anything else must surface, never silently retry down the legacy path.
    expect(isMissingFunctionError({ code: '23503', message: 'foreign key violation' })).toBe(false)
    expect(isMissingFunctionError({ code: '42501', message: 'permission denied for table sales_entries' })).toBe(false)
    expect(isMissingFunctionError(null)).toBe(false)
  })
})

describe('persistSalesDay — atomic RPC path', () => {
  test('sends one RPC with the right params and makes no table calls', async () => {
    const sb = makeMockSupabase()
    const signal = new AbortController().signal
    const res = await persistSalesDay(sb, { periodId: 'p1', bsDay: 11, rows: ROWS, signal })

    expect(res).toEqual({ atomic: true })
    expect(sb.calls).toHaveLength(1)
    expect(sb.calls[0].kind).toBe('rpc')
    expect(sb.calls[0].fn).toBe('save_sales_day')
    expect(sb.calls[0].params).toEqual({ p_period_id: 'p1', p_bs_day: 11, p_rows: ROWS })
    expect(sb.calls[0].signal).toBe(signal)
  })

  test('an empty day still goes through the RPC, so the delete is transactional too', async () => {
    const sb = makeMockSupabase()
    await persistSalesDay(sb, { periodId: 'p1', bsDay: 11, rows: [] })
    expect(sb.calls).toHaveLength(1)
    expect(sb.calls[0].params.p_rows).toEqual([])
  })

  test('rethrows a real RPC error instead of falling back', async () => {
    const sb = makeMockSupabase({ rpcResult: { error: { code: '23503', message: 'fk violation' } } })
    await expect(persistSalesDay(sb, { periodId: 'p1', bsDay: 11, rows: ROWS })).rejects.toThrow('fk violation')
    expect(sb.calls).toHaveLength(1) // no legacy fallback attempted
  })
})

describe('persistSalesDay — expired token recovery (S458)', () => {
  const EXPIRED = { error: { code: 'PGRST301', message: 'JWT expired' } }

  test('renews and retries silently when the token died while the user was typing', async () => {
    // The whole point: an hour of data entry must not be lost to a token that aged out.
    const sb = makeMockSupabase({ rpcResults: [EXPIRED, { error: null }] })
    const res = await persistSalesDay(sb, { periodId: 'p1', bsDay: 11, rows: ROWS })

    expect(res).toEqual({ atomic: true })
    expect(sb.calls.map(c => c.kind)).toEqual(['rpc', 'refreshSession', 'rpc'])
  })

  test('retries at most once — no infinite renew loop', async () => {
    const sb = makeMockSupabase({ rpcResults: [EXPIRED, EXPIRED] })
    await expect(persistSalesDay(sb, { periodId: 'p1', bsDay: 11, rows: ROWS })).rejects.toThrow('JWT expired')
    expect(sb.calls.filter(c => c.kind === 'rpc')).toHaveLength(2)
    expect(sb.calls.filter(c => c.kind === 'refreshSession')).toHaveLength(1)
  })

  test('an unrenewable session gets a plain message that does not blame the user', async () => {
    const sb = makeMockSupabase({ rpcResults: [EXPIRED], refreshResult: { error: { message: 'refresh_token_not_found' } } })
    await expect(persistSalesDay(sb, { periodId: 'p1', bsDay: 11, rows: ROWS }))
      .rejects.toThrow(/expired and could not be renewed.*still on screen/s)
  })

  test('a non-auth error is never retried', async () => {
    const sb = makeMockSupabase({ rpcResults: [{ error: { code: '23503', message: 'fk violation' } }] })
    await expect(persistSalesDay(sb, { periodId: 'p1', bsDay: 11, rows: ROWS })).rejects.toThrow('fk violation')
    expect(sb.calls.filter(c => c.kind === 'refreshSession')).toHaveLength(0)
  })
})

describe('persistSalesDay — legacy fallback (migration not yet applied)', () => {
  test('Daily: delete day → insert → delete superseded bulk rows, in that order', async () => {
    const sb = makeMockSupabase({ rpcResult: MISSING_FN })
    const res = await persistSalesDay(sb, { periodId: 'p1', bsDay: 11, rows: ROWS })

    expect(res).toEqual({ atomic: false })
    expect(sb.calls.map(c => c.kind)).toEqual(['rpc', 'delete', 'insert', 'delete'])

    expect(sb.calls[1].filters).toEqual([['eq', 'period_id', 'p1'], ['eq', 'bs_day', 11]])
    expect(sb.calls[2].rows[0]).toMatchObject({ recipe_id: 'r1', period_id: 'p1', bs_day: 11, discount: 5 })
    // cross-mode: a Daily save supersedes the Bulk (bs_day = 0) row
    expect(sb.calls[3].filters).toEqual([
      ['eq', 'period_id', 'p1'], ['eq', 'bs_day', 0], ['in', 'recipe_id', ['r1']],
    ])
  })

  test('Bulk: cross-mode cleanup targets the dated rows instead', async () => {
    const sb = makeMockSupabase({ rpcResult: MISSING_FN })
    await persistSalesDay(sb, { periodId: 'p1', bsDay: 0, rows: ROWS })

    expect(sb.calls[1].filters).toEqual([['eq', 'period_id', 'p1'], ['eq', 'bs_day', 0]])
    expect(sb.calls[3].filters).toEqual([
      ['eq', 'period_id', 'p1'], ['gt', 'bs_day', 0], ['in', 'recipe_id', ['r1']],
    ])
  })

  test('empty rows: deletes the day and skips insert + cross-mode cleanup', async () => {
    const sb = makeMockSupabase({ rpcResult: MISSING_FN })
    await persistSalesDay(sb, { periodId: 'p1', bsDay: 11, rows: [] })
    expect(sb.calls.map(c => c.kind)).toEqual(['rpc', 'delete'])
  })

  test('surfaces a legacy delete error', async () => {
    const sb = makeMockSupabase({ rpcResult: MISSING_FN, tableResult: { error: { message: 'delete blocked' } } })
    await expect(persistSalesDay(sb, { periodId: 'p1', bsDay: 11, rows: ROWS })).rejects.toThrow('delete blocked')
  })
})

describe('findSupersededRows — what a save will silently delete (S457)', () => {
  test('Bulk save: finds the dated rows it would wipe, across the WHOLE period', async () => {
    // This is the case that ate live data on 2026-07-27: one bulk figure for an item silently
    // deleted that item's entries on days the user wasn't even looking at.
    const sb = makeMockSupabase({
      selectResult: { data: [
        { recipe_id: 'r1', bs_day: 4, qty_sold: 2 },
        { recipe_id: 'r1', bs_day: 7, qty_sold: 3 },
        { recipe_id: 'other', bs_day: 5, qty_sold: 9 }, // not in the payload — must be ignored
      ], error: null },
    })

    const res = await findSupersededRows(sb, { periodId: 'p1', bsDay: 0, recipeIds: ['r1'] })

    expect(res.total).toBe(2)
    expect(res.byRecipe).toEqual([{ recipeId: 'r1', count: 2, days: [4, 7], qty: 5 }])
    expect(sb.calls[0].filters).toEqual([['eq', 'period_id', 'p1'], ['gt', 'bs_day', 0]])
  })

  test('Daily save: looks at the Bulk row instead', async () => {
    const sb = makeMockSupabase({ selectResult: { data: [{ recipe_id: 'r1', bs_day: 0, qty_sold: 6 }], error: null } })
    const res = await findSupersededRows(sb, { periodId: 'p1', bsDay: 11, recipeIds: ['r1'] })

    expect(res.total).toBe(1)
    expect(res.byRecipe[0].days).toEqual([]) // bs_day 0 isn't a "day" to list
    expect(sb.calls[0].filters).toEqual([['eq', 'period_id', 'p1'], ['eq', 'bs_day', 0]])
  })

  test('nothing to supersede → total 0, so no confirmation is shown', async () => {
    const sb = makeMockSupabase({ selectResult: { data: [], error: null } })
    const res = await findSupersededRows(sb, { periodId: 'p1', bsDay: 0, recipeIds: ['r1'] })
    expect(res).toEqual({ total: 0, byRecipe: [] })
  })

  test('empty payload short-circuits without querying at all', async () => {
    const sb = makeMockSupabase()
    const res = await findSupersededRows(sb, { periodId: 'p1', bsDay: 0, recipeIds: [] })
    expect(res).toEqual({ total: 0, byRecipe: [] })
    expect(sb.calls).toHaveLength(0)
  })

  test('sorts the biggest losses first, so the worst case is what the user reads', async () => {
    const sb = makeMockSupabase({
      selectResult: { data: [
        { recipe_id: 'small', bs_day: 1, qty_sold: 1 },
        { recipe_id: 'big', bs_day: 1, qty_sold: 1 },
        { recipe_id: 'big', bs_day: 2, qty_sold: 1 },
        { recipe_id: 'big', bs_day: 3, qty_sold: 1 },
      ], error: null },
    })
    const res = await findSupersededRows(sb, { periodId: 'p1', bsDay: 0, recipeIds: ['small', 'big'] })
    expect(res.byRecipe.map(e => e.recipeId)).toEqual(['big', 'small'])
    expect(res.total).toBe(4)
  })

  test('a failed precheck throws rather than silently reporting "nothing to delete"', async () => {
    // Failing open here would be the worst outcome: it would skip the warning entirely.
    const sb = makeMockSupabase({ selectResult: { data: null, error: { message: 'permission denied' } } })
    await expect(findSupersededRows(sb, { periodId: 'p1', bsDay: 0, recipeIds: ['r1'] }))
      .rejects.toThrow('permission denied')
  })
})
