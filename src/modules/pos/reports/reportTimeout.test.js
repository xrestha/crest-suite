/**
 * A POS report's reads end (S842). A hung read used to leave "Loading…" on screen for good; bounded,
 * it answers `{ data: null, error }` with a TimeoutError, which firstError() reports like a refusal.
 */
import { settleAll, rangeReadMs, REPORT_READ_MS, YEAR_READ_MS } from './reportTimeout'
import { firstError } from '../../../shared/queryError'

afterEach(() => jest.useRealTimers())

test('the limit is 60 s per 92 days picked, never more than a year\'s', () => {
  expect(rangeReadMs('2026-10-15', '2026-10-15')).toBe(REPORT_READ_MS)
  expect(rangeReadMs('2026-07-16', '2026-10-15')).toBe(REPORT_READ_MS) // 92 days
  expect(rangeReadMs('2026-07-15', '2026-10-15')).toBe(2 * REPORT_READ_MS) // 93 days
  expect(rangeReadMs('2025-10-16', '2026-10-15')).toBe(4 * REPORT_READ_MS) // a year
  expect(rangeReadMs('2023-01-01', '2026-10-15')).toBe(YEAR_READ_MS)
  // A range the pickers could not have produced still gets a limit, never NaN or 0.
  expect(rangeReadMs('2026-10-15', '2026-10-01')).toBe(REPORT_READ_MS)
  expect(rangeReadMs('', 'nope')).toBe(REPORT_READ_MS)
})

test('a read that never answers becomes that read\'s error, and the rest of the batch keeps its answers', async () => {
  jest.useFakeTimers()
  const hung = new Promise(() => {})
  const answered = Promise.resolve({ data: [1], error: null })
  const pending = settleAll([answered, hung], 1000, 'Loading the test report')
  jest.advanceTimersByTime(1000)
  const results = await pending
  expect(results[0]).toEqual({ data: [1], error: null })
  expect(results[1].data).toBeNull()
  expect(results[1].error.name).toBe('TimeoutError')
  expect(firstError(results)).toMatch(/Loading the test report timed out after 1s/)
})

test('a refused read and a read that threw both come back as errors, never as a rejection', async () => {
  const refused = Promise.resolve({ data: null, error: { message: 'permission denied' } })
  const threw = Promise.reject(new Error('boom'))
  const results = await settleAll([refused, threw])
  expect(results[0].error.message).toBe('permission denied')
  expect(results[1]).toEqual({ data: null, error: expect.objectContaining({ message: 'boom' }) })
})

test('an answer inside the limit is passed through untouched', async () => {
  const builderLike = { then: (ok) => ok({ data: 'rows', error: null }) } // a supabase builder is a thenable
  const [r] = await settleAll([builderLike], 1000)
  expect(r).toEqual({ data: 'rows', error: null })
})
