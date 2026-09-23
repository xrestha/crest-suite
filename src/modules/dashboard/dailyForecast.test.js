import {
  dailySalesMap, dailyPurchaseMap, historyWindowDays, baseFromHistory, baseFromMonth,
  projectMonth, makeSnapshot, isCurrentSnapshot, staleSnapshotFilter, targetValue, HISTORY_DAYS,
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

  test('purchases follow their own buying days, a no-bill day counting as zero', () => {
    const { purch } = baseFromHistory(historyWindowDays(OPEN.y, OPEN.m, bhadraHistory()))
    // Bought 7,000 every Sunday and nothing else: Sunday is the restock day, the rest are zero,
    // and the week still totals 7,000, the same as the flat 1,000-a-day line it replaced.
    expect(purch.byWeekday).toEqual([7000, 0, 0, 0, 0, 0, 0])
    expect(purch.byWeekday.reduce((s, v) => s + v, 0)).toBe(7000)
  })

  test("purchases peak on a different day from sales, as CASA's do", () => {
    const { sales, purch } = baseFromHistory(historyWindowDays(OPEN.y, OPEN.m, bhadraHistory()))
    expect(sales.byWeekday.indexOf(Math.max(...sales.byWeekday))).toBe(6)
    expect(purch.byWeekday.indexOf(Math.max(...purch.byWeekday))).toBe(0)
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

  test('purchases per weekday, once 7 days have elapsed, day 7 counting as zero', () => {
    expect(baseFromMonth({ kind: 'purch', valueMap: CASA_PURCH, elapsed: 6, weekdayOf })).toBeNull()
    const base = baseFromMonth({ kind: 'purch', valueMap: CASA_PURCH, elapsed: 7, weekdayOf })
    expect(base.byWeekday[weekdayOf(2)]).toBe(7113)
    expect(base.byWeekday[weekdayOf(7)]).toBe(0)
    expect(base.byWeekday.reduce((s, v) => s + v, 0)).toBe(21377)
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

// S784: the rain adjustment rides in as a per-day factor.
describe('projectMonth with a day factor', () => {
  const base = { byWeekday: Array(7).fill(1000) }
  const onTarget = { 1: 1000, 2: 1000, 3: 1000 }

  test('a factor of 1 everywhere changes nothing, with or without a base', () => {
    const one = () => 1
    expect(projectMonth({ base, valueMap: onTarget, expectDays: [1, 2, 3], fromDay: 4, monthEndDay, weekdayOf, dayFactor: one }))
      .toEqual(projectMonth({ base, valueMap: onTarget, expectDays: [1, 2, 3], fromDay: 4, monthEndDay, weekdayOf }))
    expect(projectMonth({ base: null, valueMap: CASA_SALES, expectDays: [1, 2, 3, 4, 5, 6], fromDay: 7, monthEndDay, weekdayOf, dayFactor: one }))
      .toEqual(projectMonth({ base: null, valueMap: CASA_SALES, expectDays: [1, 2, 3, 4, 5, 6], fromDay: 7, monthEndDay, weekdayOf }))
  })

  test('a rainy forecast day is scaled and its neighbours are not', () => {
    const r = projectMonth({ base, valueMap: onTarget, expectDays: [1, 2, 3], fromDay: 4, monthEndDay, weekdayOf, dayFactor: d => (d === 5 ? 0.8 : 1) })
    expect(r.projDays[5]).toBe(800)
    expect(r.projDays[4]).toBe(1000)
    expect(r.projDays[6]).toBe(1000)
    expect(r.projectedTotal).toBe(1000 * monthEndDay - 200)
  })

  test('a rainy day already past does not drag the pace down', () => {
    // Day 2 rained and sold 800 against an 80% expectation: the month is on target.
    const valueMap = { 1: 1000, 2: 800, 3: 1000 }
    const rained = projectMonth({ base, valueMap, expectDays: [1, 2, 3], fromDay: 4, monthEndDay, weekdayOf, dayFactor: d => (d === 2 ? 0.8 : 1) })
    expect(rained.paceFactor).toBe(1)
    // Without the weather the same 800 reads as a slow month.
    const blind = projectMonth({ base, valueMap, expectDays: [1, 2, 3], fromDay: 4, monthEndDay, weekdayOf })
    expect(blind.paceFactor).toBeLessThan(1)
  })

  test('without a base, the running average is taken per normal day', () => {
    // 3 days, the middle one rainy at 50%: 1000 + 500 + 1000 is 1000 per normal day.
    const r = projectMonth({ base: null, valueMap: { 1: 1000, 2: 500, 3: 1000 }, expectDays: [1, 2, 3], fromDay: 4, monthEndDay, weekdayOf, dayFactor: d => (d === 2 || d === 4 ? 0.5 : 1) })
    expect(r.projDays[4]).toBe(500)
    expect(r.projDays[5]).toBe(1000)
  })
})

describe('snapshots', () => {
  test('a snapshot sums the whole month and reads back per weekday', () => {
    const byWeekday = [1, 2, 3, 4, 5, 6, 7]
    const snap = makeSnapshot('sales', { source: 'history', byWeekday, sampleDays: 28 }, { monthEndDay, weekdayOf, capturedDay: 1 })
    let expected = 0
    for (let d = 1; d <= monthEndDay; d++) expected += byWeekday[weekdayOf(d)]
    expect(snap.projectedMonthEnd).toBe(expected)
    expect(isCurrentSnapshot('sales', snap)).toBe(true)
    expect(targetValue('sales', snap, 6)).toBe(7)
  })

  test('a pre-S780 slope fit is treated as absent', () => {
    const old = { slope: -1200, intercept: 15000, cap: 22000, capturedDay: 5, projectedMonthEnd: 92144 }
    expect(isCurrentSnapshot('sales', old)).toBe(false)
    expect(targetValue('sales', old, 3)).toBeNull()
    expect(isCurrentSnapshot('sales', null)).toBe(false)
  })

  test("S780's flat purchase snapshot is replaced; the sales one of the same model is kept", () => {
    const s780 = { model: 2, source: 'history', byWeekday: Array(7).fill(5022), capturedDay: 6, projectedMonthEnd: 155682 }
    expect(isCurrentSnapshot('purch', s780)).toBe(false)
    expect(isCurrentSnapshot('sales', s780)).toBe(true)
    const fresh = makeSnapshot('purch', { source: 'history', byWeekday: [12798, 2822, 4065, 4088, 4944, 4095, 2346], sampleDays: 28 }, { monthEndDay, weekdayOf, capturedDay: 7 })
    expect(isCurrentSnapshot('purch', fresh)).toBe(true)
  })

  test('the write guard reaches an empty column and an older model, never by a bare neq', () => {
    expect(staleSnapshotFilter('purch', 'purch_projection_snapshot'))
      .toBe('purch_projection_snapshot->>model.is.null,purch_projection_snapshot->>model.neq.3')
  })
})
