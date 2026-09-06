import { activityEvent, agoLabel, isNewSince, groupByDay } from './reservationActivity'

const T0 = '2026-09-06T10:00:00.000Z'
const min = n => new Date(Date.parse(T0) + n * 60000).toISOString()

describe('activityEvent', () => {
  it('labels a fresh booking Booked and an amended one Edited, both timed by updated_at', () => {
    expect(activityEvent({ status: 'booked', created_at: T0, updated_at: min(0.5) })).toEqual({ label: 'Booked', at: min(0.5) })
    expect(activityEvent({ status: 'booked', created_at: T0, updated_at: min(5) })).toEqual({ label: 'Edited', at: min(5) })
  })
  it('names the online request decisions differently from the phone-book ones', () => {
    expect(activityEvent({ status: 'confirmed', source: 'website', updated_at: T0 }).label).toBe('Accepted')
    expect(activityEvent({ status: 'confirmed', source: 'phone', updated_at: T0 }).label).toBe('Confirmed')
    expect(activityEvent({ status: 'cancelled', source: 'website', updated_at: T0 }).label).toBe('Declined')
    // An accepted online booking cancelled later was a booking, not a request
    expect(activityEvent({ status: 'cancelled', source: 'website', confirmed_at: T0, updated_at: T0 }).label).toBe('Cancelled')
    expect(activityEvent({ status: 'cancelled', source: 'phone', updated_at: T0 }).label).toBe('Cancelled')
  })
  it('falls back to the status label and never throws on a bare row', () => {
    expect(activityEvent({ status: 'no_show', updated_at: T0 })).toEqual({ label: 'No-show', at: T0 })
    expect(activityEvent({ status: 'arrived' })).toEqual({ label: 'Arrived', at: null })
  })
})

describe('agoLabel', () => {
  const now = Date.parse(T0)
  it('reads like a person says it', () => {
    expect(agoLabel(min(-0.5), now)).toBe('just now')
    expect(agoLabel(min(-12), now)).toBe('12 min ago')
    expect(agoLabel(min(-3 * 60), now)).toBe('3 h ago')
    expect(agoLabel(min(-30 * 60), now)).toBe('yesterday')
    expect(agoLabel(min(-5 * 24 * 60), now)).toBe('5 days ago')
  })
  it('is empty for nothing usable, and never negative for a clock ahead of the server', () => {
    expect(agoLabel(null, now)).toBe('')
    expect(agoLabel('nonsense', now)).toBe('')
    expect(agoLabel(min(2), now)).toBe('just now')
  })
})

describe('isNewSince', () => {
  it('is only true for a change after the stamp, and never without a stamp', () => {
    expect(isNewSince({ updated_at: min(1) }, T0)).toBe(true)
    expect(isNewSince({ updated_at: T0 }, T0)).toBe(false)
    expect(isNewSince({ updated_at: min(1) }, null)).toBe(false)
    expect(isNewSince({}, T0)).toBe(false)
    expect(isNewSince({ updated_at: min(1) }, 'bad')).toBe(false)
  })
})

describe('groupByDay', () => {
  it('keeps first-appearance order and drops rows with no day', () => {
    const rows = [{ id: 1, d: 'a' }, { id: 2, d: 'a' }, { id: 3, d: 'b' }, { id: 4, d: null }, { id: 5, d: 'a' }]
    expect(groupByDay(rows, r => r.d)).toEqual([
      { iso: 'a', rows: [rows[0], rows[1], rows[4]] },
      { iso: 'b', rows: [rows[2]] },
    ])
    expect(groupByDay(null, r => r.d)).toEqual([])
  })
})
