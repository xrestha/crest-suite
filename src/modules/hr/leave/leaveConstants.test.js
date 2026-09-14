import { leaveDayCount, publicHolidayKeys } from './leaveConstants'
import { bsToAd, formatAd } from '../../../utils/bsCalendar'

const ad = (y, m, d) => formatAd(bsToAd(y, m, d))

describe('publicHolidayKeys', () => {
  it('keeps public holidays the client has not removed, and nothing else', () => {
    const keys = publicHolidayKeys([
      { bs_year: 2083, bs_month: 6, bs_day: 10, holiday_type: 'public' },
      { bs_year: 2083, bs_month: 6, bs_day: 11, holiday_type: 'optional' },
      { bs_year: 2083, bs_month: 6, bs_day: 12, holiday_type: 'public', removed_at: '2026-09-01T00:00:00Z' },
    ])
    expect([...keys]).toEqual(['2083:6:10'])
  })
})

describe('leaveDayCount', () => {
  const holidays = new Set(['2083:6:10', '2083:6:11'])

  it('does not charge the public holidays inside the range', () => {
    const r = leaveDayCount(ad(2083, 6, 8), ad(2083, 6, 12), 'full', holidays)
    expect(r).toMatchObject({ days: 3, calendarDays: 5 })
    expect(r.holidayDays.map(d => d.bsDay)).toEqual([10, 11])
  })

  it('charges every day when there are no holidays, as before', () => {
    expect(leaveDayCount(ad(2083, 6, 8), ad(2083, 6, 12), 'full', new Set()).days).toBe(5)
    expect(leaveDayCount(ad(2083, 6, 8), ad(2083, 6, 12), 'full', null).days).toBe(5)
  })

  it('a half day is 0.5 — and 0 on a holiday, which the database refuses', () => {
    expect(leaveDayCount(ad(2083, 6, 9), ad(2083, 6, 9), 'first_half', holidays).days).toBe(0.5)
    expect(leaveDayCount(ad(2083, 6, 10), ad(2083, 6, 10), 'first_half', holidays).days).toBe(0)
  })

  it('a range made only of holidays charges nothing', () => {
    expect(leaveDayCount(ad(2083, 6, 10), ad(2083, 6, 11), 'full', holidays).days).toBe(0)
  })
})
