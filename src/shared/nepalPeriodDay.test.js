import { nepalDayInPeriod } from './nepalPeriodDay'
import { bsToAd, formatAd, daysInBsMonth } from '../utils/bsCalendar'

// Independent of the runner's timezone, which is the point (S792, SALES-6): every stamp below is
// written with an explicit +05:45 offset and the expected day is Nepal's. The old
// `adToBs(new Date(ts)).day` passes these on a Kathmandu laptop and fails them on a UTC or Tokyo
// box — run `TZ=UTC` / `TZ=Asia/Tokyo` to see it.

const BHADRA = { bs_year: 2083, bs_month: 5 }
const ASHWIN = { bs_year: 2083, bs_month: 6 }
// The AD calendar date (YYYY-MM-DD) of a BS day, built without touching an instant.
const adOf = (y, m, d) => formatAd(bsToAd(y, m, d))
const npt = (y, m, d, hhmm) => `${adOf(y, m, d)}T${hhmm}:00+05:45`

describe('nepalDayInPeriod', () => {
  test('a bill closed ten minutes after midnight is dated the new day, not the one before', () => {
    expect(nepalDayInPeriod(npt(2083, 6, 1, '00:10'), ASHWIN)).toBe(1)
  })

  test('a bill closed ten minutes before midnight stays on its own day', () => {
    const last = daysInBsMonth(2083, 5)
    expect(nepalDayInPeriod(npt(2083, 5, last, '23:50'), BHADRA)).toBe(last)
  })

  test('the same instant written in UTC gives the same Nepal day', () => {
    // 00:10 NPT on 1 Ashwin is 18:25 UTC on the AD day before.
    const iso = new Date(npt(2083, 6, 1, '00:10')).toISOString()
    expect(iso.endsWith('18:25:00.000Z')).toBe(true)
    expect(nepalDayInPeriod(iso, ASHWIN)).toBe(1)
  })

  test("an instant from another month is refused rather than given that month's day number", () => {
    const last = daysInBsMonth(2083, 5)
    expect(nepalDayInPeriod(npt(2083, 5, last, '23:50'), ASHWIN)).toBeNull()
    expect(nepalDayInPeriod(npt(2083, 6, 1, '00:10'), BHADRA)).toBeNull()
  })

  test('period fields may arrive as strings', () => {
    expect(nepalDayInPeriod(npt(2083, 6, 3, '12:00'), { bs_year: '2083', bs_month: '6' })).toBe(3)
  })

  test('absent, malformed and period-less input is null, never a guess', () => {
    expect(nepalDayInPeriod(null, ASHWIN)).toBeNull()
    expect(nepalDayInPeriod('not a date', ASHWIN)).toBeNull()
    expect(nepalDayInPeriod(npt(2083, 6, 1, '12:00'), null)).toBeNull()
  })
})
