import { HOME_POS_READS, HOME_KITCHEN_READS, anyReadFailed, keepLastGood, readUnavailable } from './homePosStats'

// S809 3n (REPORTS-8): a failed read is not an empty period.
const GOOD = {
  revenueTotal: 45200, coversTotal: 61, dineInBills: 24, billCount: 30, avgCheck: 1506.67,
  tablesOccupied: 3, tablesTotal: 10, bookingsTonight: 2, coversToCome: 6, requestsPending: 1,
}
// What a load computes from `data || []` when its reads failed: zeros nobody computed.
const ZEROS = {
  revenueTotal: 0, coversTotal: 0, dineInBills: 0, billCount: 0, avgCheck: 0,
  tablesOccupied: 0, tablesTotal: 0, bookingsTonight: 0, coversToCome: 0, requestsPending: 0,
}

describe('anyReadFailed', () => {
  test('true only when some read failed', () => {
    expect(anyReadFailed({ sales: false, tables: false, bookings: false })).toBe(false)
    expect(anyReadFailed({ sales: false, tables: true })).toBe(true)
    expect(anyReadFailed({})).toBe(false)
    expect(anyReadFailed(null)).toBe(false)
  })
})

describe('keepLastGood — Home\'s POS card', () => {
  test('nothing failed: this load\'s figures as they are', () => {
    const fresh = { ...GOOD, revenueTotal: 46000 }
    expect(keepLastGood(GOOD, fresh, { sales: false, tables: false, bookings: false }, HOME_POS_READS)).toBe(fresh)
  })

  test('the sales read failed: Revenue, Covers, Bills and Avg Check keep the last good figures; the rest are this load\'s', () => {
    const fresh = { ...ZEROS, tablesOccupied: 4, tablesTotal: 10, bookingsTonight: 3, coversToCome: 8, requestsPending: 0 }
    const s = keepLastGood(GOOD, fresh, { sales: true }, HOME_POS_READS)
    expect(s).toEqual({ ...GOOD, tablesOccupied: 4, bookingsTonight: 3, coversToCome: 8, requestsPending: 0 })
    expect(s.unavailable).toBeUndefined()
    expect(readUnavailable(s, 'sales')).toBe(false)
  })

  test('a first load that fails has no last good figures: its tiles are unavailable, never zero', () => {
    const s = keepLastGood(null, { ...ZEROS, tablesOccupied: 2, tablesTotal: 8 }, { sales: true, bookings: true }, HOME_POS_READS)
    for (const f of [...HOME_POS_READS.sales, ...HOME_POS_READS.bookings]) expect(s[f]).toBeNull()
    expect(s.tablesOccupied).toBe(2)
    expect(s.unavailable).toEqual(['sales', 'bookings'])
    expect(readUnavailable(s, 'sales')).toBe(true)
    expect(readUnavailable(s, 'tables')).toBe(false)
  })

  test('a read still unavailable from the load before stays unavailable while it keeps failing', () => {
    const before = keepLastGood(null, ZEROS, { tables: true }, HOME_POS_READS)
    const s = keepLastGood(before, { ...GOOD, tablesOccupied: 0, tablesTotal: 0 }, { tables: true }, HOME_POS_READS)
    expect(s.tablesOccupied).toBeNull()
    expect(s.unavailable).toEqual(['tables'])
    expect(s.revenueTotal).toBe(GOOD.revenueTotal)
  })

  test('a read that comes back clears its "unavailable"', () => {
    const before = keepLastGood(null, ZEROS, { sales: true, tables: true }, HOME_POS_READS)
    const s = keepLastGood(before, { ...GOOD, tablesOccupied: 0 }, { tables: true }, HOME_POS_READS)
    expect(s.revenueTotal).toBe(GOOD.revenueTotal)
    expect(s.unavailable).toEqual(['tables'])
  })

  test('a cached card from before a field existed gives null for that field, not undefined', () => {
    const old = { ...GOOD }
    delete old.dineInBills
    const s = keepLastGood(old, ZEROS, { sales: true }, HOME_POS_READS)
    expect(s.dineInBills).toBeNull()
    expect(s.revenueTotal).toBe(GOOD.revenueTotal)
    expect(s.unavailable).toBeUndefined()
  })

  test('a kitchen card is never the last good figures of the front-of-house card', () => {
    const kitchen = { kitchen: true, station: 'KOT', openNow: 4, lateCount: 1, readyWaiting: 0, avgPrepMin: 9, completedToday: 22 }
    const s = keepLastGood(kitchen, ZEROS, { sales: true }, HOME_POS_READS)
    expect(s.revenueTotal).toBeNull()
    expect(s.unavailable).toEqual(['sales'])
  })
})

describe('keepLastGood — the kitchen or bar team\'s card', () => {
  const KOT = { kitchen: true, station: 'KOT', openNow: 4, lateCount: 1, readyWaiting: 2, avgPrepMin: 9, completedToday: 22 }
  const FAILED = { kitchen: true, station: 'KOT', openNow: 0, lateCount: 0, readyWaiting: 0, avgPrepMin: null, completedToday: 0 }

  test('a failed read keeps the last good tickets; it never says "0 open, 0 late"', () => {
    expect(keepLastGood(KOT, FAILED, { tickets: true }, HOME_KITCHEN_READS)).toEqual(KOT)
  })

  test('with nothing to keep, the tiles are unavailable', () => {
    const s = keepLastGood(null, FAILED, { tickets: true }, HOME_KITCHEN_READS)
    expect(s.openNow).toBeNull()
    expect(s.lateCount).toBeNull()
    expect(s.unavailable).toEqual(['tickets'])
  })

  test('the bar\'s card is never the last good figures of the kitchen\'s', () => {
    const s = keepLastGood({ ...KOT, station: 'BOT' }, FAILED, { tickets: true }, HOME_KITCHEN_READS)
    expect(s.openNow).toBeNull()
    expect(s.unavailable).toEqual(['tickets'])
  })

  test('the front-of-house card is never the last good figures of a kitchen card', () => {
    const s = keepLastGood(GOOD, FAILED, { tickets: true }, HOME_KITCHEN_READS)
    expect(s.openNow).toBeNull()
    expect(s.unavailable).toEqual(['tickets'])
  })
})
