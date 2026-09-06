import { readSeenStamp, writeSeenStamp } from './reservationSeen'

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
