import { nepalTime, nepalCivilDate, nepalBs } from './nepalTime'
import { adToBs } from '../utils/bsCalendar'

// These assertions are deliberately independent of the machine's timezone — that is the entire
// point of the module. They pass on a laptop in Kathmandu and on a CI box in UTC alike, and would
// fail on the runtime-local `toLocaleTimeString` idiom this replaces.

describe('nepalTime', () => {
  it('renders a UTC instant as the clock time it showed in Nepal', () => {
    // 14:00Z + 05:45 = 19:45 Kathmandu
    expect(nepalTime('2026-08-20T14:00:00Z')).toBe('07:45 PM')
  })

  it('keeps the leading zero the 18 call sites it replaces already produced', () => {
    // hour: '2-digit' under hour12 gives "07:45 PM", not "7:45 PM". Matching this exactly is what
    // makes the sweep invisible to a user in Nepal.
    expect(nepalTime('2026-08-20T14:00:00Z')).toMatch(/^\d{2}:\d{2} [AP]M$/)
  })

  it('crosses midnight into the NEXT Nepal day, where a runtime-local render would not', () => {
    // 18:30Z is still the 20th in UTC but already 00:15 on the 21st in Kathmandu.
    expect(nepalTime('2026-08-20T18:30:00Z')).toBe('12:15 AM')
  })

  it('holds the last minute before the boundary on the same day', () => {
    expect(nepalTime('2026-08-20T18:14:59Z')).toBe('11:59 PM')
  })

  it('accepts a Date as well as a string', () => {
    expect(nepalTime(new Date('2026-08-20T14:00:00Z'))).toBe('07:45 PM')
  })

  it('returns empty string for the absent and the malformed, never "Invalid Date"', () => {
    // closed_at is null on an open order; credit_settled_at is null on most bills. Both reach
    // this from table cells that still have to render.
    expect(nepalTime(null)).toBe('')
    expect(nepalTime(undefined)).toBe('')
    expect(nepalTime('')).toBe('')
    expect(nepalTime('not a date')).toBe('')
  })
})

describe('nepalCivilDate', () => {
  it('returns the Y/M/D as read in Kathmandu, at local midnight', () => {
    const d = nepalCivilDate('2026-08-20T18:30:00Z')
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(7)   // August, 0-indexed
    expect(d.getDate()).toBe(21)   // the NEXT day — 00:15 Kathmandu
    expect(d.getHours()).toBe(0)
  })

  it('does not shift a mid-afternoon Nepal instant', () => {
    const d = nepalCivilDate('2026-08-20T14:00:00Z')
    expect(d.getDate()).toBe(20)
  })

  it('returns null rather than an Invalid Date', () => {
    expect(nepalCivilDate(null)).toBeNull()
    expect(nepalCivilDate('not a date')).toBeNull()
  })
})

describe('nepalBs', () => {
  it('names the same BS day the pinned time belongs to', () => {
    // The whole reason this exists: pin the time and not the date and the row reads
    // "<previous BS day> · 12:15 AM" for a viewer outside Nepal.
    expect(nepalBs('2026-08-20T18:30:00Z')).toEqual(adToBs(new Date(2026, 7, 21)))
    expect(nepalBs('2026-08-20T14:00:00Z')).toEqual(adToBs(new Date(2026, 7, 20)))
  })

  it('is range-guarded, so an out-of-table date yields null and not a confident wrong one', () => {
    expect(nepalBs('1900-01-01T00:00:00Z')).toBeNull()
  })

  it('returns null for the absent and the malformed', () => {
    expect(nepalBs(null)).toBeNull()
    expect(nepalBs('not a date')).toBeNull()
  })
})
