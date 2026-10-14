import { closePassedRequests, expiredRequestPatch, EXPIRE_WRITE_MS } from './requestExpiry'
import { EXPIRED_REQUEST_REASON, stampFor } from './reservationStatus'

// S834 (S809.4 4j): the page's sweep closes passed requests the way submit_reservation_request does,
// in one write held to requests still unanswered. The update builder is faked and records its calls.
function fakeUpdate(answer) {
  const calls = []
  const builder = {
    eq: (...a) => { calls.push(['eq', ...a]); return builder },
    lt: (...a) => { calls.push(['lt', ...a]); return builder },
    gte: (...a) => { calls.push(['gte', ...a]); return builder },
    select: (...a) => { calls.push(['select', ...a]); return answer() },
  }
  const scopedUpdate = jest.fn((table, patch) => { calls.push(['update', table, patch]); return builder })
  return { scopedUpdate, calls }
}

const now = Date.parse('2026-10-14T13:00:00.000Z')
const nowIso = '2026-10-14T13:00:00.000Z'

describe('expiredRequestPatch', () => {
  test('is the decline the server writes: cancelled, stamped, "Not answered in time", nothing else', () => {
    expect(expiredRequestPatch(nowIso)).toEqual({ status: 'cancelled', cancelled_at: nowIso, cancel_reason: 'Not answered in time' })
    expect(EXPIRED_REQUEST_REASON).toBe('Not answered in time')
    // The stamp columns are stampFor's for requested → cancelled, so the two can never drift.
    expect(expiredRequestPatch(nowIso)).toMatchObject(stampFor('cancelled', nowIso, 'requested'))
  })
})

describe('closePassedRequests', () => {
  test('one update, held to unanswered requests whose time is before now, reading back the ids', async () => {
    const { scopedUpdate, calls } = fakeUpdate(() => Promise.resolve({ data: [{ id: 'r1' }, { id: 'r2' }], error: null }))
    await expect(closePassedRequests(scopedUpdate, now)).resolves.toEqual({ ids: ['r1', 'r2'], error: null })
    expect(scopedUpdate).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([
      ['update', 'pos_reservations', { status: 'cancelled', cancelled_at: nowIso, cancel_reason: 'Not answered in time' }],
      ['eq', 'status', 'requested'],
      ['lt', 'reserved_for', nowIso],
      ['select', 'id'],
    ])
  })

  test('nothing to close is an ordinary answer', async () => {
    const { scopedUpdate } = fakeUpdate(() => Promise.resolve({ data: [], error: null }))
    await expect(closePassedRequests(scopedUpdate, now)).resolves.toEqual({ ids: [], error: null })
  })

  test('a refused write comes back as its error, with no ids', async () => {
    const refusal = { code: '42501', message: 'new row violates row-level security policy' }
    const { scopedUpdate } = fakeUpdate(() => Promise.resolve({ data: null, error: refusal }))
    await expect(closePassedRequests(scopedUpdate, now)).resolves.toEqual({ ids: [], error: refusal })
  })

  test('a write that never answers is a failed one after its limit, never a hang', async () => {
    jest.useFakeTimers()
    try {
      const { scopedUpdate } = fakeUpdate(() => new Promise(() => {}))
      const out = closePassedRequests(scopedUpdate, now)
      jest.advanceTimersByTime(EXPIRE_WRITE_MS)
      const { ids, error } = await out
      expect(ids).toEqual([])
      expect(error.name).toBe('TimeoutError')
    } finally {
      jest.useRealTimers()
    }
  })
})
