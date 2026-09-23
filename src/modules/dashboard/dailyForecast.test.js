import {
  dailySalesMap, dailyPurchaseMap, historyWindowDays, baseFromHistory, baseFromMonth,
  projectMonth, makeSnapshot, isCurrentSnapshot, targetValue, HISTORY_DAYS,
} from './dailyForecast'
import { bsToAd, daysInBsMonth } from '../../utils/bsCalendar'

// Ashwin 2083 is the month the S780 screenshots came from; Bhadra 2083 is its history.
const OPEN = { y: 2083, m: 6 }
const PREV = { y: 2083, m: 5 }
const weekdayOf = d => bsToAd(OPEN.y, OPEN.m, d).getDay()
const monthEndDay = daysInBsMonth(OPEN.y, OPEN.m)

// CASA ACAI CAFE, Ashwin 2083, days 1–6, as read off the screenshots.
const CASA_SALES = { 1: 13800, 2: 9000, 3: 17800, 4: 9900, 5: 7500, 6: 16800 }
const CASA_PURCH = { 1: 800, 2: 7113, 3: 2259, 4: 2405, 5: 5900, 6: 2900 }

// A Bhadra where Saturday sells 20k and every other day 10k, and the kitchen buys 7k every
// Sunday and nothing else.
function bhadraHistory() {
  const salesMap = {}, purchMap = {}
  for (let d = 1; d <= daysInBsMonth(PREV.y, PREV.m); d++) {
    const dow = bsToAd(PREV.y, PREV.m, d).getDay()
    salesMap[d] = dow === 6 ? 20000 : 10000
    if (dow === 0) purchMap[d] = 7000
  }
  return [{ bs_year: PREV.y, bs_month: PREV.m, salesMap, purchMap }]
}

describe('daily maps', () => {
  test('revenue skips comps and bulk rows, prefers the row price, takes off the discount', () => {
    const map = dailySalesMap([
      { bs_day: 1, recipe_id: 'a', qty_sold: 2, unit_price: 100, discount: 20, source: 'manual' },
      { bs_day: 1, recipe_id: 'a', qty_sold: 1, unit_price: null, source: null },
      { bs_day: 1, recipe_id: 'a', qty_sold: 5, unit_price: 100, source: 'pos_comp' },
      { bs_day: 0, recipe_id: 'a', qty_sold: 9, unit_price: 100, source: 'manual' },
    ], { a: 150 })
    expect(map).toEqual({ 1: 330 })
  })

  test('net purchases take returns off at list value', () => {
    const map = dailyPurchaseMap([{ bs_day: 2, lineNet: 1000 }], [{ bs_day: 2, qty: 2, rate: 50 }, { bs_day: 3, qty: 1, rate: 40 }])
    expect(map).toEqual({ 2: 900, 3: -40 })
  })
})

describe('history window', () => {
  test('keeps exactly the 28 days before day 1, oldest first', () => {
    const days = historyWindowDays(OPEN.y, OPEN.m, bhadraHistory())
    expect(days).toHaveLength(HISTORY_DAYS)
    expect(days[0].back).toBe(28)
    expect(days[days.length - 1].back).toBe(1)
  })

  test('a skipped month gives no history rather than the wrong weeks', () => {
    expect(historyWindowDays(OPEN.y, OPEN.m, [])).toEqual([])
  })

  test('coverage starts at the first day with an entry', () => {
    const n = daysInBsMonth(PREV.y, PREV.m)
    const salesMap = {}
    for (let d = n - 9; d <= n; d++) salesMap[d] = 5000
    const days = historyWindowDays(OPEN.y, OPEN.m, [{ bs_year: PREV.y, bs_month: PREV.m, salesMap, purchMap: {} }])
    expect(days).toHaveLength(10)
  })
})

describe('base from history', () => {
  test('a Saturday-heavy month gives a Saturday-high target', () => {
    const { sales } = baseFromHistory(historyWindowDays(OPEN.y, OPEN.m, bhadraHistory()))
    expect(sales.source).toBe('history')
    expect(sales.byWeekday[6]).toBe(20000)
    expect(sales.byWeekday[1]).toBe(10000)
  })

  test('purchases are averaged per calendar day, not per purchase day', () => {
    const { purch } = baseFromHistory(historyWindowDays(OPEN.y, OPEN.m, bhadraHistory()))
    // 4 Sundays × 7,000 over 28 days = 1,000 a day, never 7,000.
    expect(purch.byWeekday).toEqual(Array(7).fill(1000))
  })

  test('under 14 days of history is not enough to judge', () => {
    const salesMap = { 20: 5000, 21: 5000, 22: 5000 }
    const { sales, purch } = baseFromHistory(historyWindowDays(OPEN.y, OPEN.m, [{ bs_year: PREV.y, bs_month: PREV.m, salesMap, purchMap: {} }]))
    expect(sales).toBeNull()
    expect(purch).toBeNull()
  })
})

describe('base from the open month (a new client)', () => {
  test('needs a week of sales', () => {
    const dayNums = [1, 2, 3, 4, 5, 6]
    expect(baseFromMonth({ kind: 'sales', valueMap: CASA_SALES, dayNums, weekdayOf })).toBeNull()
    const seven = { ...CASA_SALES, 7: 12000 }
    const base = baseFromMonth({ kind: 'sales', valueMap: seven, dayNums: [...dayNums, 7], weekdayOf })
    expect(base.source).toBe('month')
    expect(base.byWeekday.every(v => v > 0)).toBe(true)
  })

  test('purchases per calendar day, once 7 days have elapsed', () => {
    expect(baseFromMonth({ kind: 'purch', valueMap: CASA_PURCH, elapsed: 6, weekdayOf })).toBeNull()
    const base = baseFromMonth({ kind: 'purch', valueMap: CASA_PURCH, elapsed: 7, weekdayOf })
    expect(base.byWeekday[0]).toBe(Math.round(21377 / 7))
  })
})

describe('projectMonth', () => {
  test('the CASA days never produce a line that runs to zero', () => {
    const sales = projectMonth({ base: null, valueMap: CASA_SALES, expectDays: [1, 2, 3, 4, 5, 6], fromDay: 7, monthEndDay, weekdayOf })
    const values = Object.values(sales.projDays)
    expect(values).toHaveLength(monthEndDay - 6)
    expect(Math.min(...values)).toBeGreaterThan(10000)
    // The old slope fit said 92,144 on day 5; 74,800 had sold by day 6.
    expect(sales.projectedTotal).toBeGreaterThan(300000)
  })

  test('the purchases forecast is the running average, never pinned to a ceiling', () => {
    const purch = projectMonth({ base: null, valueMap: CASA_PURCH, expectDays: [1, 2, 3, 4, 5, 6], fromDay: 7, monthEndDay, weekdayOf })
    const perDay = Math.round(21377 / 6)
    expect(Object.values(purch.projDays).every(v => v === perDay)).toBe(true)
    expect(perDay).toBeLessThan(Math.round(7113 * 1.25))
  })

  test('without a base it waits for 3 days', () => {
    expect(projectMonth({ base: null, valueMap: { 1: 100, 2: 100 }, expectDays: [1, 2], fromDay: 3, monthEndDay, weekdayOf })).toBeNull()
  })

  test('with a base, a month on target keeps the base', () => {
    const base = { byWeekday: Array(7).fill(1000) }
    const valueMap = { 1: 1000, 2: 1000, 3: 1000 }
    const r = projectMonth({ base, valueMap, expectDays: [1, 2, 3], fromDay: 4, monthEndDay, weekdayOf })
    expect(r.paceFactor).toBe(1)
    expect(r.projectedTotal).toBe(1000 * monthEndDay)
  })

  test('a month running at 2× leans toward 2× by day 7', () => {
    const base = { byWeekday: Array(7).fill(1000) }
    const valueMap = {}
    for (let d = 1; d <= 7; d++) valueMap[d] = 2000
    const r = projectMonth({ base, valueMap, expectDays: [1, 2, 3, 4, 5, 6, 7], fromDay: 8, monthEndDay, weekdayOf })
    expect(r.paceFactor).toBeCloseTo(1.7, 5)
  })

  test('the weekly shape carries into the forecast', () => {
    const byWeekday = [10000, 10000, 10000, 10000, 10000, 10000, 20000]
    const r = projectMonth({ base: { byWeekday }, valueMap: { 1: 10000 }, expectDays: [1], fromDay: 2, monthEndDay, weekdayOf })
    const sat = Object.keys(r.projDays).map(Number).find(d => weekdayOf(d) === 6)
    const mon = Object.keys(r.projDays).map(Number).find(d => weekdayOf(d) === 1)
    expect(r.projDays[sat]).toBeGreaterThan(r.projDays[mon])
  })
})

describe('snapshots', () => {
  test('a snapshot sums the whole month and reads back per weekday', () => {
    const byWeekday = [1, 2, 3, 4, 5, 6, 7]
    const snap = makeSnapshot({ source: 'history', byWeekday, sampleDays: 28 }, { monthEndDay, weekdayOf, capturedDay: 1 })
    let expected = 0
    for (let d = 1; d <= monthEndDay; d++) expected += byWeekday[weekdayOf(d)]
    expect(snap.projectedMonthEnd).toBe(expected)
    expect(isCurrentSnapshot(snap)).toBe(true)
    expect(targetValue(snap, 6)).toBe(7)
  })

  test('a pre-S780 slope fit is treated as absent', () => {
    const old = { slope: -1200, intercept: 15000, cap: 22000, capturedDay: 5, projectedMonthEnd: 92144 }
    expect(isCurrentSnapshot(old)).toBe(false)
    expect(targetValue(old, 3)).toBeNull()
    expect(isCurrentSnapshot(null)).toBe(false)
  })
})
