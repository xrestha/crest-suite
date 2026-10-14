import { readSeenStamp, writeSeenStamp, requestTimePassed, waitingRequests, passedRequests } from './reservationSeen'

describe('reservationSeen', () => {
  beforeEach(() => localStorage.clear())
  it('is null until written, per client, and round-trips an instant', () => {
    expect(readSeenStamp('c1')).toBeNull()
    writeSeenStamp('c1', new Date('2026-09-06T10:00:00Z'))
    expect(readSeenStamp('c1')).toBe('2026-09-06T10:00:00.000Z')
    expect(readSeenStamp('c2')).toBeNull()
  })
  it('ignores a missing client and a corrupted value', () => {
    expect(readSeenStamp(null)).toBeNull()
    writeSeenStamp(null)
    localStorage.setItem('crest:resv-seen:c1', 'garbage')
    expect(readSeenStamp('c1')).toBeNull()
  })
})

// S834 (S809.4 4j): the Reservations band counts in the browser and the sidebar chip counts on the
// server, so the JS test and the query filter must draw the same line. A tiny in-memory stand-in for
// the PostgREST filters used here (eq, gte, lt on a timestamptz) applies the filter to sample rows.
function memoryQuery(rows) {
  const tests = []
  const ms = v => new Date(v).getTime()
  const q = {
    calls: [],
    eq(col, v) { q.calls.push(['eq', col, v]); tests.push(r => r[col] === v); return q },
    gte(col, v) { q.calls.push(['gte', col, v]); tests.push(r => ms(r[col]) >= ms(v)); return q },
    lt(col, v) { q.calls.push(['lt', col, v]); tests.push(r => ms(r[col]) < ms(v)); return q },
    rows: () => rows.filter(r => tests.every(t => t(r))).map(r => r.id),
  }
  return q
}

describe('which booking requests are waiting', () => {
  const now = Date.parse('2026-10-14T13:00:00.000Z')
  const rows = [
    { id: 'gone', status: 'requested', reserved_for: '2026-10-14T12:59:59.000Z' },
    { id: 'now', status: 'requested', reserved_for: '2026-10-14T13:00:00.000Z' },
    { id: 'later', status: 'requested', reserved_for: '2026-10-14T13:30:00+00:00' },
    { id: 'yesterday', status: 'requested', reserved_for: '2026-10-13T14:00:00.000Z' },
    { id: 'accepted', status: 'confirmed', reserved_for: '2026-10-14T12:00:00.000Z' },
    { id: 'declined', status: 'cancelled', reserved_for: '2026-10-14T15:00:00.000Z' },
  ]

  it('marks a request passed only once its time is before now, as the band always has', () => {
    expect(requestTimePassed(rows[0], now)).toBe(true)
    expect(requestTimePassed(rows[1], now)).toBe(false) // at the minute itself it is still waiting
    expect(requestTimePassed(rows[2], now)).toBe(false)
    expect(requestTimePassed({ reserved_for: 'garbage' }, now)).toBe(false) // reserved_for is NOT NULL
  })

  it('the count filter keeps exactly the requests the band does not mark, and nothing else', () => {
    const fromBand = rows.filter(r => r.status === 'requested' && !requestTimePassed(r, now)).map(r => r.id)
    expect(waitingRequests(memoryQuery(rows), now).rows()).toEqual(fromBand)
    expect(fromBand).toEqual(['now', 'later'])
  })

  it('the passed filter keeps exactly the requests the band marks, never an answered booking', () => {
    const marked = rows.filter(r => r.status === 'requested' && requestTimePassed(r, now)).map(r => r.id)
    expect(passedRequests(memoryQuery(rows), now).rows()).toEqual(marked)
    expect(marked).toEqual(['gone', 'yesterday'])
  })

  it('the two filters split the waiting requests between them, at one cut-off instant', () => {
    const waiting = waitingRequests(memoryQuery(rows), now)
    const passed = passedRequests(memoryQuery(rows), now)
    expect([...waiting.rows(), ...passed.rows()].sort()).toEqual(['gone', 'later', 'now', 'yesterday'])
    expect(waiting.calls).toEqual([['eq', 'status', 'requested'], ['gte', 'reserved_for', '2026-10-14T13:00:00.000Z']])
    expect(passed.calls).toEqual([['eq', 'status', 'requested'], ['lt', 'reserved_for', '2026-10-14T13:00:00.000Z']])
  })
})
