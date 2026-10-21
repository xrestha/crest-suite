import {
  cachedPeriodList, readPeriodList, invalidatePeriodList, clearPeriodLists,
  subscribePeriodList, openOrLatest, initPeriodLoad, PERIOD_LIST_COLUMNS,
} from './periodList'
import { clearPageCache, setPageCacheUser } from './sessionDataCache'
import { scopedFrom } from './scopedDb'

jest.mock('./scopedDb', () => ({ scopedFrom: jest.fn() }))

// A controllable read: each call to scopedFrom returns a builder whose result the test resolves.
function deferredReads() {
  const pending = []
  scopedFrom.mockImplementation((table, clientId, columns) => {
    let resolve
    const promise = new Promise(r => { resolve = r })
    const builder = { order: () => builder, then: (ok, bad) => promise.then(ok, bad) }
    pending.push({ table, clientId, columns, resolve })
    return builder
  })
  return pending
}

const flush = () => new Promise(r => setTimeout(r, 0))

const BHADRA = { id: 'p-bhadra', bs_year: 2083, bs_month: 5, status: 'open' }
const SHRAWAN = { id: 'p-shrawan', bs_year: 2083, bs_month: 4, status: 'closed' }
const ASHWIN = { id: 'p-ashwin', bs_year: 2083, bs_month: 6, status: 'open' }

// The page side of initPeriodLoad, as MonthlySummary wires it.
function fakeReq() {
  let current = null
  return {
    begin(k) { current = k; return k },
    isCurrent(k) { return current === null || current === k },
  }
}

beforeEach(() => {
  clearPeriodLists()
  scopedFrom.mockReset()
})

describe('readPeriodList', () => {
  test('reads the named columns of monthly_periods for the client and caches a good list', async () => {
    const reads = deferredReads()
    const p = readPeriodList('c1')
    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatchObject({ table: 'monthly_periods', clientId: 'c1', columns: PERIOD_LIST_COLUMNS })
    expect(cachedPeriodList('c1')).toBeNull()
    reads[0].resolve({ data: [BHADRA, SHRAWAN], error: null })
    expect(await p).toEqual({ data: [BHADRA, SHRAWAN], error: null })
    expect(cachedPeriodList('c1')).toEqual([BHADRA, SHRAWAN])
  })

  test('a read already in flight is shared, not sent twice', async () => {
    const reads = deferredReads()
    const a = readPeriodList('c1')
    const b = readPeriodList('c1')
    expect(reads).toHaveLength(1)
    reads[0].resolve({ data: [BHADRA], error: null })
    expect((await a).data).toEqual([BHADRA])
    expect((await b).data).toEqual([BHADRA])
    readPeriodList('c1')
    expect(reads).toHaveLength(2)   // a settled read is not reused: every visit re-checks
  })

  test('a failed read is handed back and never replaces the last good list', async () => {
    const reads = deferredReads()
    const first = readPeriodList('c1')
    reads[0].resolve({ data: [BHADRA], error: null })
    await first
    const second = readPeriodList('c1')
    reads[1].resolve({ data: null, error: { message: 'offline' } })
    expect(await second).toEqual({ data: null, error: { message: 'offline' } })
    expect(cachedPeriodList('c1')).toEqual([BHADRA])
  })

  test('callers get their own rows, so decorating one list cannot change the next', async () => {
    const reads = deferredReads()
    const p = readPeriodList('c1')
    reads[0].resolve({ data: [BHADRA], error: null })
    const { data } = await p
    data[0].label = 'Bhadra 2083'
    expect(cachedPeriodList('c1')[0].label).toBeUndefined()
    cachedPeriodList('c1')[0].status = 'closed'
    expect(cachedPeriodList('c1')[0].status).toBe('open')
  })

  test('a read that started before an invalidation is not stored', async () => {
    const reads = deferredReads()
    const before = readPeriodList('c1')
    invalidatePeriodList('c1')
    reads[0].resolve({ data: [BHADRA], error: null })
    await before
    expect(cachedPeriodList('c1')).toBeNull()
  })

  test('lists are kept per client', async () => {
    const reads = deferredReads()
    const a = readPeriodList('c1')
    const b = readPeriodList('c2')
    reads[0].resolve({ data: [BHADRA], error: null })
    reads[1].resolve({ data: [ASHWIN], error: null })
    await Promise.all([a, b])
    expect(cachedPeriodList('c1')).toEqual([BHADRA])
    expect(cachedPeriodList('c2')).toEqual([ASHWIN])
  })

  test('clearing the page cache, or a different user, forgets every list', async () => {
    const reads = deferredReads()
    const p = readPeriodList('c1')
    reads[0].resolve({ data: [BHADRA], error: null })
    await p
    clearPageCache()
    expect(cachedPeriodList('c1')).toBeNull()
    const q = readPeriodList('c1')
    reads[1].resolve({ data: [BHADRA], error: null })
    await q
    setPageCacheUser('user-a')
    setPageCacheUser('user-b')
    expect(cachedPeriodList('c1')).toBeNull()
  })

  test('listeners hear each new list, and null after an invalidation', async () => {
    const reads = deferredReads()
    const heard = []
    const off = subscribePeriodList('c1', list => heard.push(list))
    const p = readPeriodList('c1')
    reads[0].resolve({ data: [BHADRA], error: null })
    await p
    invalidatePeriodList('c1')
    off()
    invalidatePeriodList('c1')
    expect(heard).toEqual([[BHADRA], null])
  })
})

describe('openOrLatest', () => {
  test('the open month, else the latest, else nothing', () => {
    expect(openOrLatest([SHRAWAN, BHADRA])).toBe(BHADRA)
    expect(openOrLatest([SHRAWAN])).toBe(SHRAWAN)
    expect(openOrLatest([])).toBeNull()
    expect(openOrLatest(null)).toBeNull()
  })
})

describe('initPeriodLoad', () => {
  function setup({ cached, freshResult }) {
    let resolveFresh
    const fresh = new Promise(r => { resolveFresh = r })
    const calls = { periods: [], selected: [], loads: [] }
    const req = fakeReq()
    const initKey = req.begin('init:c1')
    const run = initPeriodLoad({
      req, initKey,
      periodList: () => ({ cached, fresh }),
      setPeriods: l => calls.periods.push(l),
      select: p => calls.selected.push(p),
      load: id => { calls.loads.push(id); return Promise.resolve() },
    })
    return { run, calls, req, resolveFresh: () => resolveFresh(freshResult) }
  }

  test('with a list in memory, the data load starts before the fresh list lands', async () => {
    const { run, calls, req, resolveFresh } = setup({
      cached: [BHADRA, SHRAWAN], freshResult: { data: [BHADRA, SHRAWAN], error: null },
    })
    expect(calls.loads).toEqual(['p-bhadra'])   // already started, no round trip waited on
    resolveFresh()
    expect(await run).toEqual({ chosen: BHADRA })
    expect(calls.loads).toEqual(['p-bhadra'])   // same month: not loaded twice
    expect(req.isCurrent('p-bhadra')).toBe(true)
  })

  test('the fresh row replaces the guessed one, so a status changed elsewhere shows', async () => {
    const closedNow = { ...BHADRA, status: 'closed' }
    const { run, calls, resolveFresh } = setup({
      cached: [BHADRA], freshResult: { data: [closedNow], error: null },
    })
    resolveFresh()
    await run
    expect(calls.selected).toEqual([BHADRA, closedNow])
    expect(calls.loads).toEqual(['p-bhadra'])
  })

  test('a month closed and the next opened elsewhere is re-picked and loaded', async () => {
    const { run, calls, req, resolveFresh } = setup({
      cached: [BHADRA, SHRAWAN],
      freshResult: { data: [ASHWIN, { ...BHADRA, status: 'closed' }, SHRAWAN], error: null },
    })
    resolveFresh()
    expect(await run).toEqual({ chosen: ASHWIN })
    expect(calls.loads).toEqual(['p-bhadra', 'p-ashwin'])
    expect(req.isCurrent('p-bhadra')).toBe(false)   // the guessed load can no longer paint
    expect(req.isCurrent('p-ashwin')).toBe(true)
  })

  test('with nothing in memory, it waits for the list and then loads', async () => {
    const { run, calls, resolveFresh } = setup({
      cached: null, freshResult: { data: [BHADRA], error: null },
    })
    expect(calls.loads).toEqual([])
    resolveFresh()
    expect(await run).toEqual({ chosen: BHADRA })
    expect(calls.loads).toEqual(['p-bhadra'])
  })

  test('a failed list read is an error, and a guessed load is cancelled first', async () => {
    const { run, calls, req, resolveFresh } = setup({
      cached: [BHADRA], freshResult: { data: null, error: { message: 'offline' } },
    })
    resolveFresh()
    expect(await run).toEqual({ error: { message: 'offline' } })
    expect(calls.loads).toEqual(['p-bhadra'])
    expect(req.isCurrent('p-bhadra')).toBe(false)
  })

  test('no months at all selects nothing and cancels a guessed load', async () => {
    const { run, calls, req, resolveFresh } = setup({
      cached: [BHADRA], freshResult: { data: [], error: null },
    })
    resolveFresh()
    expect(await run).toEqual({ chosen: null })
    expect(calls.selected).toEqual([BHADRA, null])
    expect(req.isCurrent('p-bhadra')).toBe(false)
  })

  test('a period picked while the list is in flight wins the page', async () => {
    const { run, calls, req, resolveFresh } = setup({
      cached: [BHADRA, SHRAWAN], freshResult: { data: [BHADRA, SHRAWAN], error: null },
    })
    req.begin('p-shrawan')   // the reader chose Shrawan from the guessed list
    resolveFresh()
    expect(await run).toEqual({ superseded: true })
    expect(calls.selected).toEqual([BHADRA])
    await flush()
  })
})
