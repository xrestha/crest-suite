import { fetchAllRows } from './fetchAllRows'

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

test('maxRows caps a runaway rather than looping forever', async () => {
  const { makeQuery, ranges } = makeSource(rows(10000))
  const { data } = await fetchAllRows(makeQuery, { pageSize: 1000, maxRows: 3000 })
  expect(data).toHaveLength(3000)
  expect(ranges).toHaveLength(3)
})
