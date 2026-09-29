// runForecast WRITES the stored forecast, so the S792.4 race — two Recomputes at once emptying the
// horizon, each clearing the other's run — is tested against a fake table rather than argued. The
// forecast arithmetic is demandForecastMath.js's (tested there) and is stubbed to a fixed shape.
import { runForecast } from './demandForecastData'

jest.mock('../supabaseClient', () => ({ supabase: { from: () => { throw new Error('no raw supabase read expected') } } }))
// Plain functions throughout: CRA's jest preset sets resetMocks, which strips a jest.fn's
// implementation before every test.
jest.mock('./uuid', () => {
  let n = 0
  return { randomUUID: () => `run-${++n}` }
})
jest.mock('./demandForecastMath', () => ({
  LOOKBACK_DAYS: 84,
  buildDailyHistory: () => [],
  buildManualDailyHistory: () => [],
  periodsInLookback: () => [],
  // One covers row and one dish row per day: 14 rows for a 7-day run.
  forecastByWeekday: (_history, horizonDays) => Array.from({ length: horizonDays }, (_, i) => ({
    bs: { year: 2083, month: 6, day: i + 1 },
    forecastCovers: 10, forecastRevenue: 1000, forecastQtyByRecipe: { r1: 2 },
    sampleCount: 8, posSampleCount: 8, holiday: null,
  })),
}))
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

// The fake demand_forecast_daily. Each INSERT gets ONE server timestamp, later than the last —
// generated_at is the column's DEFAULT now(), one value per statement.
const mockDb = { rows: [], log: [], clock: 0, gate: null, onInsert: null, readbackError: false }

function mockArm(arm) {
  const [col, op, ...rest] = arm.split('.')
  const value = rest.join('.')
  if (op === 'is' && value === 'null') return r => r[col] == null
  // SQL: NULL <> x is NULL, so the row is not matched.
  if (op === 'neq') return r => r[col] != null && r[col] !== value
  throw new Error(`unexpected or() arm ${arm}`)
}

function mockQuery(kind, table) {
  const filters = []
  let limit = null
  const b = {
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
  // pos_orders, monthly_periods, hr_holiday_calendar, recipes: nothing to read.
  if (table !== 'demand_forecast_daily') return { data: [], error: null }
  const matches = r => filters.every(f => f(r))
  if (kind === 'delete') {
    await (mockDb.gate || Promise.resolve())
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
  Object.assign(mockDb, { rows: [], log: [], clock: 0, gate: null, onInsert: null, readbackError: false })
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
