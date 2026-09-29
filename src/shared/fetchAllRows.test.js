import { fetchAllRows, fetchAllRowsChunked, rowCapError, ROW_CAP_CODE } from './fetchAllRows'

// Fake builder: records the .range() calls it receives and serves slices of `all`.
function makeSource(all, { error = null } = {}) {
  const ranges = []
  const makeQuery = () => ({
    range: (from, to) => {
      ranges.push([from, to])
      if (error) return Promise.resolve({ data: null, error })
      return Promise.resolve({ data: all.slice(from, to + 1), error: null })
    },
  })
  return { makeQuery, ranges }
}

const rows = n => Array.from({ length: n }, (_, i) => ({ id: i }))

test('a single short page needs exactly one request', async () => {
  const { makeQuery, ranges } = makeSource(rows(384))
  const { data } = await fetchAllRows(makeQuery, { pageSize: 1000 })
  expect(data).toHaveLength(384)
  expect(ranges).toEqual([[0, 999]])
})

test('pages past the 1000-row cap instead of truncating', async () => {
  const { makeQuery, ranges } = makeSource(rows(1753))
  const { data } = await fetchAllRows(makeQuery, { pageSize: 1000 })
  expect(data).toHaveLength(1753)
  expect(ranges).toEqual([[0, 999], [1000, 1999]])
})

test('an exactly-full final page costs one extra empty request — the only way to know it ended', async () => {
  const { makeQuery, ranges } = makeSource(rows(2000))
  const { data } = await fetchAllRows(makeQuery, { pageSize: 1000 })
  expect(data).toHaveLength(2000)
  expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
})

test('rows come back in order across the page boundary, with none dropped or repeated', async () => {
  const { makeQuery } = makeSource(rows(1500))
  const { data } = await fetchAllRows(makeQuery, { pageSize: 1000 })
  expect(data.map(r => r.id)).toEqual(rows(1500).map(r => r.id))
  expect(new Set(data.map(r => r.id)).size).toBe(1500)
})

test('an empty result set is one request and an empty array', async () => {
  const { makeQuery, ranges } = makeSource([])
  const { data } = await fetchAllRows(makeQuery, { pageSize: 1000 })
  expect(data).toEqual([])
  expect(ranges).toHaveLength(1)
})

test('an error surfaces as { data: null, error } rather than a silent partial result', async () => {
  const { makeQuery } = makeSource(rows(50), { error: { message: 'boom' } })
  const { data, error } = await fetchAllRows(makeQuery)
  expect(data).toBeNull()
  expect(error.message).toBe('boom')
})

// S792, TAX-13. The ceiling used to return the first maxRows rows with `error: null` — a silent
// short read, the one failure this helper exists to prevent. Reaching it is now an error.
test('maxRows stops a runaway, and a read that runs past it FAILS rather than returning part', async () => {
  const { makeQuery, ranges } = makeSource(rows(10000))
  const { data, error } = await fetchAllRows(makeQuery, { pageSize: 1000, maxRows: 3000 })
  expect(data).toBeNull()
  expect(error.code).toBe(ROW_CAP_CODE)
  expect(error.message).toMatch(/too long to read in full/)
  expect(error.message).toMatch(/3,000 rows/)
  // Three full pages, then one single-row probe past the ceiling — never a fourth full page.
  expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999], [3000, 3000]])
})

test('exactly maxRows rows is a complete answer, confirmed by one empty probe', async () => {
  const { makeQuery, ranges } = makeSource(rows(3000))
  const { data, error } = await fetchAllRows(makeQuery, { pageSize: 1000, maxRows: 3000 })
  expect(error).toBeNull()
  expect(data).toHaveLength(3000)
  expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999], [3000, 3000]])
})

test('a ceiling that is not a whole number of pages is never overshot', async () => {
  const { makeQuery, ranges } = makeSource(rows(2600))
  const { data, error } = await fetchAllRows(makeQuery, { pageSize: 1000, maxRows: 2500 })
  expect(data).toBeNull()
  expect(error.code).toBe(ROW_CAP_CODE)
  expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2499], [2500, 2500]])
  // …and a result that fits under it ends on its short page, with no probe.
  const small = makeSource(rows(2400))
  const ok = await fetchAllRows(small.makeQuery, { pageSize: 1000, maxRows: 2500 })
  expect(ok.data).toHaveLength(2400)
  expect(small.ranges).toEqual([[0, 999], [1000, 1999], [2000, 2499]])
})

test('a failed probe is a failed read', async () => {
  let calls = 0
  const makeQuery = () => ({
    range: (from, to) => {
      calls++
      if (from >= 2000) return Promise.resolve({ data: null, error: { message: 'probe died' } })
      return Promise.resolve({ data: rows(2000).slice(from, to + 1), error: null })
    },
  })
  const { data, error } = await fetchAllRows(makeQuery, { pageSize: 1000, maxRows: 2000 })
  expect(data).toBeNull()
  expect(error.message).toBe('probe died')
  expect(calls).toBe(3)
})

test('the chunked form fails the whole read when any chunk runs past the ceiling', async () => {
  const table = rows(30).map(r => ({ ...r, parent: r.id % 3 }))
  const makeQuery = ids => ({
    range: (from, to) => Promise.resolve({
      data: table.filter(r => ids.includes(r.parent)).slice(from, to + 1), error: null,
    }),
  })
  // Each parent owns 10 rows; a ceiling of 5 per read is breached by every chunk.
  const capped = await fetchAllRowsChunked([0, 1, 2], makeQuery, { chunkSize: 1, pageSize: 5, maxRows: 5 })
  expect(capped.data).toBeNull()
  expect(capped.error.code).toBe(ROW_CAP_CODE)
  const whole = await fetchAllRowsChunked([0, 1, 2], makeQuery, { chunkSize: 1, pageSize: 5, maxRows: 10 })
  expect(whole.error).toBeNull()
  expect(whole.data).toHaveLength(30)
})

test('rowCapError is a supabase-shaped error with a stable code', () => {
  const e = rowCapError(100000)
  expect(e.code).toBe(ROW_CAP_CODE)
  expect(e.message).toMatch(/1,00,000 rows/)
  expect(e.details).toMatch(/maxRows=100000/)
})
