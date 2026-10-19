// runForecast WRITES the stored forecast, so its write rules are tested against a fake table rather
// than argued: the S792.4 race (two Recomputes at once emptying the horizon), and since S849 the
// server read (FORECAST-1), the refusal to replace a forecast with an empty one, the leftover after
// a refused clear (FORECAST-8) and the run log the server stamps (GAPS-13). The arithmetic is
// demandForecastMath.js's own, run for real over a small till history from the fake server read.
import { runForecast } from './demandForecastData'

jest.mock('../supabaseClient', () => ({
  supabase: {
    rpc: (fn, args) => mockRpc(fn, args),
    from: table => mockQuery('select', table),
  },
}))
// Plain functions throughout: CRA's jest preset sets resetMocks, which strips a jest.fn's
// implementation before every test.
jest.mock('./uuid', () => {
  let n = 0
  return { randomUUID: () => `run-${++n}` }
})
jest.mock('../shared/fetchAllRows', () => ({
  fetchAllRows: async make => make(),
  fetchAllRowsChunked: async (ids, make) => make(ids),
  runChunkedByIds: async (ids, make) => make(ids),
}))
jest.mock('../shared/scopedDb', () => ({
  scopedFrom: (table) => mockQuery('select', table),
  scopedInsert: async (table, clientId, rows) => mockInsert(table, clientId, rows),
  scopedDelete: (table) => mockQuery('delete', table),
}))

// Friday 16 October 2026 is the server's Nepal today; the history is the seven days before it, one
// bill-day each with two plates of r1 — so a 7-day run is one covers row and one dish row per day.
const TODAY = '2026-10-16'
const WEEK = ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']
const historyOf = dates => ({
  today: TODAY, from: '2026-07-24',
  days: dates.map(date => ({ date, bills: 3, covers: 10, revenue: 1000, qty: { r1: 2 } })),
  holidays: [],
})

// The fake demand_forecast_daily. Each INSERT gets ONE server timestamp, later than the last —
// generated_at is the column's DEFAULT now(), one value per statement.
const mockDb = { rows: [], log: [], clock: 0, gate: null, onInsert: null, readbackError: false, deleteError: false, history: null, rpcError: null, rpcCalls: [] }

async function mockRpc(fn, args) {
  mockDb.rpcCalls.push({ fn, args })
  if (fn !== 'demand_forecast_history') throw new Error(`unexpected rpc ${fn}`)
  if (mockDb.rpcError) return { data: null, error: mockDb.rpcError }
  return { data: mockDb.history, error: null }
}

function mockArm(arm) {
  const [col, op, ...rest] = arm.split('.')
  const value = rest.join('.')
  if (op === 'is' && value === 'null') return r => r[col] == null
  if (op === 'eq') return r => r[col] === value
  // SQL: NULL <> x is NULL, so the row is not matched.
  if (op === 'neq') return r => r[col] != null && r[col] !== value
  throw new Error(`unexpected or() arm ${arm}`)
}

function mockQuery(kind, table) {
  const filters = []
  let limit = null
  const b = {
    select: () => b,
    eq: (c, v) => { filters.push(r => r[c] === v); return b },
    // SQL: NULL < x is NULL, so the row is not matched.
    lt: (c, v) => { filters.push(r => r[c] != null && r[c] < v); return b },
    or: expr => { const arms = expr.split(',').map(mockArm); filters.push(r => arms.some(a => a(r))); return b },
    is: () => b, gte: () => b, in: () => b, order: () => b, range: () => b,
    limit: n => { limit = n; return b },
    then: (ok, bad) => mockRun(kind, table, filters, limit).then(ok, bad),
  }
  return b
}

async function mockRun(kind, table, filters, limit) {
  // monthly_periods, sales_entries, recipes: nothing to read.
  if (table !== 'demand_forecast_daily') return { data: [], error: null }
  const matches = r => filters.every(f => f(r))
  if (kind === 'delete') {
    await (mockDb.gate || Promise.resolve())
    if (mockDb.deleteError) return { data: null, error: { message: 'delete refused' } }
    mockDb.rows = mockDb.rows.filter(r => !matches(r))
    return { data: null, error: null }
  }
  if (mockDb.readbackError) return { data: null, error: { message: 'read-back failed' } }
  const hit = mockDb.rows.filter(matches)
  return { data: limit != null ? hit.slice(0, limit) : hit, error: null }
}

async function mockInsert(table, clientId, rows) {
  if (table === 'demand_forecast_run_log') { mockDb.log.push(rows); return { data: [rows], error: null } }
  const at = new Date(Date.UTC(2026, 8, 28, 10, 0, 0, ++mockDb.clock)).toISOString()
  rows.forEach((r, i) => mockDb.rows.push({ ...r, id: `${r.run_id || 'x'}-${i}`, client_id: clientId, generated_at: at }))
  if (mockDb.onInsert) mockDb.onInsert()
  return { data: rows, error: null }
}

beforeEach(() => {
  Object.assign(mockDb, {
    rows: [], log: [], clock: 0, gate: null, onInsert: null, readbackError: false, deleteError: false,
    history: historyOf(WEEK), rpcError: null, rpcCalls: [],
  })
})

describe('runForecast — clearing the previous run (S792.4)', () => {
  test('two Recomputes at once leave the newer run in place, not an empty horizon', async () => {
    // Both runs insert before either clears: A inserts, B inserts, then both clears run. Under
    // "clear every run but mine" each deleted the other's and the horizon came back empty.
    let release
    mockDb.gate = new Promise(r => { release = r })
    let inserted = 0
    mockDb.onInsert = () => { if (++inserted === 2) release() }

    await Promise.all([runForecast('c1', 7), runForecast('c1', 7)])

    const runs = [...new Set(mockDb.rows.map(r => r.run_id))]
    expect(runs).toHaveLength(1)
    expect(mockDb.rows).toHaveLength(14)
    // The survivor is the later insert — the one the page's newestRunOnly would show anyway.
    const newest = mockDb.rows.reduce((a, r) => (r.generated_at > a ? r.generated_at : a), '')
    expect(mockDb.rows.every(r => r.generated_at === newest)).toBe(true)
  })

  test('a Recompute clears the older run and pre-run_id rows of its own horizon, and nothing else', async () => {
    mockDb.rows = [
      { id: 'old', horizon_days: 7, run_id: 'run-old', generated_at: '2026-09-01T00:00:00.000Z' },
      { id: 'legacy', horizon_days: 7, run_id: null, generated_at: '2026-08-01T00:00:00.000Z' },
      { id: 'thirty', horizon_days: 30, run_id: 'run-30', generated_at: '2026-09-01T00:00:00.000Z' },
    ]
    await runForecast('c1', 7)
    const ids = mockDb.rows.map(r => r.id)
    expect(ids).not.toContain('old')
    expect(ids).not.toContain('legacy')
    expect(ids).toContain('thirty')
    expect(mockDb.rows.filter(r => r.horizon_days === 7)).toHaveLength(14)
  })

  test('a run stamped after this one is never cleared by it', async () => {
    // Another device's Recompute that landed after this one's insert: newer by the server's clock.
    mockDb.rows = [{ id: 'newer', horizon_days: 7, run_id: 'run-elsewhere', generated_at: '2099-01-01T00:00:00.000Z' }]
    await runForecast('c1', 7)
    expect(mockDb.rows.map(r => r.id)).toContain('newer')
  })

  test('a failed read-back keeps the new run and leaves the old one for the next Recompute', async () => {
    mockDb.rows = [{ id: 'old', horizon_days: 7, run_id: 'run-old', generated_at: '2026-09-01T00:00:00.000Z' }]
    mockDb.readbackError = true
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await runForecast('c1', 7)
    spy.mockRestore()
    expect(res.rowsWritten).toBe(14)
    expect(mockDb.rows.map(r => r.id)).toContain('old')
    expect(mockDb.rows.filter(r => r.run_id !== 'run-old')).toHaveLength(14)
    expect(mockDb.log[mockDb.log.length - 1]).toMatchObject({ rows_written: 14, error: null })
  })
})

describe('runForecast — S849', () => {
  test('reads the till through demand_forecast_history for 84 days, never pos_orders (FORECAST-1)', async () => {
    const res = await runForecast('c1', 7)
    expect(mockDb.rpcCalls).toEqual([{ fn: 'demand_forecast_history', args: { p_client_id: 'c1', p_lookback_days: 84 } }])
    expect(res).toMatchObject({ refused: null, leftover: false, tillDays: 7, manualDays: 0, rowsWritten: 14 })
    // The horizon starts at the server's tomorrow (FORECAST-5): 17 October 2026 is 31 Ashwin 2083.
    const covers = mockDb.rows.filter(r => r.recipe_id == null)
    expect(covers).toHaveLength(7)
    expect(covers.every(r => r.forecast_covers === 10 && r.forecast_revenue === 1000)).toBe(true)
  })

  test('a history with no sales at all writes nothing, clears nothing, and logs a refusal (FORECAST-1)', async () => {
    mockDb.history = historyOf([])
    mockDb.rows = [{ id: 'owners', horizon_days: 7, run_id: 'run-owner', generated_at: '2026-09-01T00:00:00.000Z' }]
    const res = await runForecast('c1', 7)
    expect(res).toMatchObject({ refused: 'no_history', rowsWritten: 0, tillDays: 0 })
    expect(mockDb.rows.map(r => r.id)).toEqual(['owners']) // the Owner's forecast stands
    expect(mockDb.log).toHaveLength(1)
    expect(mockDb.log[0]).toMatchObject({ rows_written: 0, error: null, horizon_days: 7, run_id: null })
  })

  test('a refused clear after the insert landed is a success with leftover, never "no forecast" (FORECAST-8)', async () => {
    mockDb.rows = [{ id: 'old', horizon_days: 7, run_id: 'run-old', generated_at: '2026-09-01T00:00:00.000Z' }]
    mockDb.deleteError = true
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await runForecast('c1', 7)
    spy.mockRestore()
    expect(res.leftover).toBe(true)
    expect(res.rowsWritten).toBe(14)
    const newRun = mockDb.rows.filter(r => r.run_id !== 'run-old')
    expect(newRun).toHaveLength(14)
    expect(mockDb.log).toHaveLength(1)
    expect(mockDb.log[0]).toMatchObject({ rows_written: 14, error: null, run_id: newRun[0].run_id })
  })

  test('the run log sends no run_at — the server stamps who and when — and names the horizon and run (GAPS-13)', async () => {
    await runForecast('c1', 30)
    const [entry] = mockDb.log
    expect(entry).not.toHaveProperty('run_at')
    expect(entry).not.toHaveProperty('run_by')
    expect(entry).toMatchObject({ method: 'weekday_weighted_average', horizon_days: 30, error: null })
    expect(entry.run_id).toBe(mockDb.rows[0].run_id)
  })

  test('a failed server read is logged as a failure with its message and rethrown, and writes nothing', async () => {
    mockDb.rpcError = { code: '42501', message: 'demand_forecast_forbidden: this login cannot rebuild this outlet\'s demand forecast' }
    await expect(runForecast('c1', 7)).rejects.toMatchObject({ code: '42501' })
    expect(mockDb.rows).toHaveLength(0)
    expect(mockDb.log).toHaveLength(1)
    expect(mockDb.log[0]).toMatchObject({ rows_written: 0, run_id: null })
    expect(mockDb.log[0].error).toMatch(/demand_forecast_forbidden/)
    expect(mockDb.log[0]).not.toHaveProperty('run_at')
  })

  test('a rain sampler stores the history rain factor on the covers-level rows only (FORECAST-4)', async () => {
    const rainy = new Set(['2026-10-14']) // Wednesday
    await runForecast('c1', 7, { sampleFactorOf: s => (rainy.has(`${s.date.getFullYear()}-${String(s.date.getMonth() + 1).padStart(2, '0')}-${String(s.date.getDate()).padStart(2, '0')}`) ? 0.5 : 1) })
    const covers = mockDb.rows.filter(r => r.recipe_id == null)
    const wed = covers.filter(r => r.sample_rain_factor === 0.5)
    expect(wed).toHaveLength(1)
    expect(wed[0].rainy_sample_count).toBe(1)
    expect(covers.filter(r => r.sample_rain_factor === 1 && r.rainy_sample_count === 0)).toHaveLength(6)
    expect(mockDb.rows.filter(r => r.recipe_id != null).every(r => !('sample_rain_factor' in r))).toBe(true)
  })

  test('without a sampler the history rain factor is stored as unknown, not as dry', async () => {
    await runForecast('c1', 7)
    const covers = mockDb.rows.filter(r => r.recipe_id == null)
    expect(covers.every(r => r.sample_rain_factor === null && r.rainy_sample_count === null)).toBe(true)
  })
})
