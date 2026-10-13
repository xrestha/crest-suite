// S831 5f-3 (owner decision Q31 a): Inventory starts on the Nepal day it was last switched on, and a
// till bill closed before that is never sent to Inventory, nor a credit note on it.
import { billCountsForIms } from './inventorySince'

// The start of 27 Ashwin 2083 in Nepal, as the database stamps it and PostgREST returns it.
const SINCE = '2026-10-12T18:15:00+00:00'

describe('billCountsForIms', () => {
  test('with no stamp every bill counts (Inventory from the start)', () => {
    expect(billCountsForIms('2020-01-01T00:00:00Z', null)).toBe(true)
    expect(billCountsForIms('2020-01-01T00:00:00Z', undefined)).toBe(true)
  })

  test('a bill closed before the start does not count', () => {
    expect(billCountsForIms('2026-10-12T23:59:59+05:45', SINCE)).toBe(false)
  })

  test('a bill closed at or after the start counts, whatever zone the times are written in', () => {
    expect(billCountsForIms('2026-10-13T00:00:00+05:45', SINCE)).toBe(true)
    expect(billCountsForIms('2026-10-12T18:15:00.000Z', SINCE)).toBe(true)
    expect(billCountsForIms('2026-10-13T12:00:00+05:45', SINCE)).toBe(true)
  })

  test('a bill with no close time counts, as pos_post_bill_into treats it', () => {
    expect(billCountsForIms(null, SINCE)).toBe(true)
  })
})
