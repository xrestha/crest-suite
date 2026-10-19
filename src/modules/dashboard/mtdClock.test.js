import { nepalBsToday, mtdClock, inCountedDays, prorate, countedDaysText } from './mtdClock'
import { adToBs, daysInBsMonth } from '../../utils/bsCalendar'

describe('nepalBsToday — Nepal\'s date, not the device\'s (OWNER-DASHBOARD-17)', () => {
  test('01:00 in Sydney is still the previous evening in Kathmandu', () => {
    // 2026-12-20 14:00 UTC: Sydney (UTC+11) reads 21 Dec 01:00, Kathmandu (+05:45) reads 20 Dec 19:45.
    const now = new Date('2026-12-20T14:00:00Z')
    const nepal = adToBs(new Date(2026, 11, 20))
    const sydney = adToBs(new Date(2026, 11, 21))
    expect(nepalBsToday(now)).toEqual(nepal)
    expect(nepalBsToday(now)).not.toEqual(sydney)
  })
})

describe('mtdClock — finished days only, one clock for every ratio', () => {
  const kartik = { bs_year: 2083, bs_month: 7 }
  const days = daysInBsMonth(2083, 7)

  test('day 1: no finished day yet', () => {
    const c = mtdClock(kartik, { year: 2083, month: 7, day: 1 })
    expect(c).toMatchObject({ running: true, today: 1, countedDays: 0, fraction: 0, firstDay: true, monthDays: days })
    expect(countedDaysText(c)).toBe('')
  })

  test('day 12 counts days 1–11', () => {
    const c = mtdClock({ bs_year: 2083, bs_month: 8 }, { year: 2083, month: 8, day: 12 })
    const md = daysInBsMonth(2083, 8)
    expect(c).toMatchObject({ running: true, today: 12, countedDays: 11, firstDay: false, monthDays: md })
    expect(c.fraction).toBeCloseTo(11 / md, 12)
    expect(countedDaysText(c)).toBe(`Days 1–11 of ${md}`)
  })

  test('day 2 says "Day 1"', () => {
    expect(countedDaysText(mtdClock(kartik, { year: 2083, month: 7, day: 2 }))).toBe(`Day 1 of ${days}`)
  })

  test('a month that has ended (or another month) counts every day, fraction 1', () => {
    const c = mtdClock(kartik, { year: 2083, month: 8, day: 3 })
    expect(c).toMatchObject({ running: false, today: null, countedDays: days, fraction: 1, firstDay: false })
    expect(countedDaysText(c)).toBe('')
  })

  test('no period: nothing is running', () => {
    expect(mtdClock(null)).toMatchObject({ running: false, countedDays: 0, fraction: 1 })
  })
})

describe('inCountedDays and prorate', () => {
  const clock = mtdClock({ bs_year: 2083, bs_month: 8 }, { year: 2083, month: 8, day: 12 })
  test('a Bulk or undated row always counts', () => {
    expect(inCountedDays(0, clock)).toBe(true)
    expect(inCountedDays(null, clock)).toBe(true)
  })
  test('yesterday counts, today does not', () => {
    expect(inCountedDays(11, clock)).toBe(true)
    expect(inCountedDays(12, clock)).toBe(false)
  })
  test('the whole month of rent is counted for the finished days', () => {
    expect(prorate(30000, mtdClock({ bs_year: 2083, bs_month: 7 }, { year: 2083, month: 7, day: 1 }))).toBe(0)
    expect(prorate(30000, clock)).toBeCloseTo(30000 * 11 / clock.monthDays, 9)
    expect(prorate(30000, mtdClock({ bs_year: 2083, bs_month: 7 }, { year: 2083, month: 9, day: 1 }))).toBe(30000)
    expect(prorate(null, clock)).toBeNull()
  })
})
