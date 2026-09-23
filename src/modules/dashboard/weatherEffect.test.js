import {
  RAIN_MM, WEATHER_HORIZON_DAYS, adDateOf, adDateBack, weatherIndex, isRainyDay, rainPctValue,
  validateRainPct, rainFactorForMonth, rainAhead, measuredRainEffect,
} from './weatherEffect'
import { bsToAd, daysInBsMonth, formatAd } from '../../utils/bsCalendar'

const OPEN = { bsYear: 2083, bsMonth: 6 }
const monthEndDay = daysInBsMonth(OPEN.bsYear, OPEN.bsMonth)
const ad = d => adDateOf(OPEN.bsYear, OPEN.bsMonth, d)
const todayAd = ad(10)
// Today, with a forecast fetched today.
const NOW = { todayAd, forecastAd: todayAd }
// 'YYYY-MM-DD' `n` days after `iso`, by UTC day arithmetic.
const plus = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)

describe('dates', () => {
  test('adDateOf is the local calendar date, never shifted a day by UTC', () => {
    expect(ad(1)).toBe(formatAd(bsToAd(2083, 6, 1)))
  })

  test('adDateBack counts back from day 1', () => {
    const first = bsToAd(2083, 6, 1)
    const expected = formatAd(new Date(first.getFullYear(), first.getMonth(), first.getDate() - 3))
    expect(adDateBack(2083, 6, 3)).toBe(expected)
  })
})

describe('what counts as rainy', () => {
  test(`${RAIN_MM} mm is rainy and just under it is not`, () => {
    expect(isRainyDay({ precip_mm: RAIN_MM, complete: true })).toBe(true)
    expect(isRainyDay({ precip_mm: RAIN_MM - 0.1, complete: true })).toBe(false)
  })

  test('a part-day row never counts, however wet', () => {
    expect(isRainyDay({ precip_mm: 40, complete: false })).toBe(false)
    expect(isRainyDay(undefined)).toBe(false)
  })

  test('weatherIndex keys the function rows by date', () => {
    const idx = weatherIndex([{ date: '2026-09-23', precip_mm: '12.5', complete: true }])
    expect(idx['2026-09-23']).toEqual({ precip_mm: 12.5, complete: true })
  })
})

describe('the Owner percentage', () => {
  test('blank means no adjustment and is allowed', () => {
    expect(rainPctValue('')).toBeNull()
    expect(rainPctValue(null)).toBeNull()
    expect(validateRainPct('')).toBeNull()
    expect(validateRainPct(null)).toBeNull()
  })

  test('0 and values outside 30–150 are refused, never read as unset', () => {
    expect(validateRainPct(0)).not.toBeNull()
    expect(validateRainPct(29)).not.toBeNull()
    expect(validateRainPct(151)).not.toBeNull()
    expect(validateRainPct(85.5)).not.toBeNull()
    expect(validateRainPct(30)).toBeNull()
    expect(validateRainPct(85)).toBeNull()
    expect(rainPctValue(0)).toBeNull()
  })

  test('plain digits only: the save parses with parseInt, which reads "0.85e2" as 0', () => {
    expect(validateRainPct('0.85e2')).not.toBeNull()
    expect(validateRainPct('85.0')).not.toBeNull()
    expect(validateRainPct('1e2')).not.toBeNull()
    expect(validateRainPct('+85')).not.toBeNull()
    expect(validateRainPct(' 85 ')).toBeNull()
    expect(validateRainPct('085')).toBeNull()
  })
})

describe('rainFactorForMonth', () => {
  const wet = { precip_mm: 12, complete: true }

  test('scales a rainy day within reach, and nothing else', () => {
    const r = rainFactorForMonth({ rainPct: 85, weatherByAd: { [ad(12)]: wet }, ...NOW, ...OPEN, monthEndDay })
    expect(r.factorOf(12)).toBeCloseTo(0.85)
    expect(r.factorOf(11)).toBe(1)
    expect(r.byDay[12]).toEqual({ mm: 12, factor: 0.85, ahead: 2 })
  })

  test(`a day more than ${WEATHER_HORIZON_DAYS} days ahead is never adjusted`, () => {
    const edge = 10 + WEATHER_HORIZON_DAYS
    const r = rainFactorForMonth({
      rainPct: 85, weatherByAd: { [ad(edge)]: wet, [ad(edge + 1)]: wet }, ...NOW, ...OPEN, monthEndDay,
    })
    expect(r.factorOf(edge)).toBeCloseTo(0.85)
    expect(r.factorOf(edge + 1)).toBe(1)
  })

  test('a day already gone uses its recorded weather', () => {
    const r = rainFactorForMonth({ rainPct: 80, weatherByAd: { [ad(4)]: wet }, ...NOW, ...OPEN, monthEndDay })
    expect(r.byDay[4].ahead).toBe(-6)
    expect(r.factorOf(4)).toBeCloseTo(0.8)
  })

  test(`a stale forecast steers only the days within ${WEATHER_HORIZON_DAYS} of when it was made`, () => {
    // Fetched on day 6, looked at on day 10: day 13 is 7 days after the fetch, day 14 is 8.
    const r = rainFactorForMonth({
      rainPct: 85, weatherByAd: { [ad(13)]: wet, [ad(14)]: wet, [ad(4)]: wet },
      todayAd, forecastAd: ad(6), ...OPEN, monthEndDay,
    })
    expect(r.factorOf(13)).toBeCloseTo(0.85)
    expect(r.factorOf(14)).toBe(1)
    expect(r.factorOf(4)).toBeCloseTo(0.85)
  })

  test('no fetch date: nothing from today on is steered, a day already gone still is', () => {
    const r = rainFactorForMonth({
      rainPct: 85, weatherByAd: { [ad(10)]: wet, [ad(12)]: wet, [ad(4)]: wet },
      todayAd, forecastAd: null, ...OPEN, monthEndDay,
    })
    expect(r.factorOf(10)).toBe(1)
    expect(r.factorOf(12)).toBe(1)
    expect(r.factorOf(4)).toBeCloseTo(0.85)
  })

  test('nothing to apply is null: no percentage, or no rainy day', () => {
    expect(rainFactorForMonth({ rainPct: null, weatherByAd: { [ad(12)]: wet }, ...NOW, ...OPEN, monthEndDay })).toBeNull()
    expect(rainFactorForMonth({ rainPct: 85, weatherByAd: { [ad(12)]: { precip_mm: 1, complete: true } }, ...NOW, ...OPEN, monthEndDay })).toBeNull()
    expect(rainFactorForMonth({ rainPct: 85, weatherByAd: { [ad(12)]: { precip_mm: 30, complete: false } }, ...NOW, ...OPEN, monthEndDay })).toBeNull()
  })
})

describe('rainAhead', () => {
  const dry = { precip_mm: 0, complete: true }
  const wet = { precip_mm: 12, complete: true }
  const week = (overrides = {}) => Object.fromEntries(
    Array.from({ length: WEATHER_HORIZON_DAYS + 1 }, (_, i) => [plus(todayAd, i), overrides[i] || dry]),
  )

  test('a dry week covered to the horizon', () => {
    expect(rainAhead({ weatherByAd: week(), ...NOW })).toEqual({ rainy: [], through: WEATHER_HORIZON_DAYS })
  })

  test('finds rain whichever month it falls in, not only this month\'s days', () => {
    const from = '2026-09-28'
    const byAd = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [plus(from, i), i === 5 ? wet : dry]))
    expect(rainAhead({ weatherByAd: byAd, todayAd: from, forecastAd: from }).rainy).toEqual(['2026-10-03'])
  })

  test('a rainy day in reach is found', () => {
    expect(rainAhead({ weatherByAd: week({ 2: wet }), ...NOW }).rainy).toEqual([plus(todayAd, 2)])
  })

  test('stops at the first day with no forecast, so "no rain" is never said about it', () => {
    const w = week()
    delete w[plus(todayAd, 3)]
    expect(rainAhead({ weatherByAd: w, ...NOW })).toEqual({ rainy: [], through: 2 })
  })

  test('stops at the stale forecast\'s own reach', () => {
    expect(rainAhead({ weatherByAd: week({ 6: wet }), todayAd, forecastAd: plus(todayAd, -3) }))
      .toEqual({ rainy: [], through: WEATHER_HORIZON_DAYS - 3 })
  })
})

describe('measuredRainEffect', () => {
  // Every weekday usually sells 1000; Saturday is shut.
  const byWeekday = [1000, 1000, 1000, 1000, 1000, 1000, 0]
  const days = (n, from, sales, mm, complete = true) =>
    Array.from({ length: n }, (_, i) => {
      const date = `2026-08-${String(from + i).padStart(2, '0')}`
      return { log: { ad: date, dow: i % 6, sales }, weather: [date, { precip_mm: mm, complete }] }
    })

  function run(sets) {
    const all = sets.flat()
    return measuredRainEffect({
      dayLog: all.map(x => x.log),
      byWeekday,
      weatherByAd: Object.fromEntries(all.map(x => x.weather)),
    })
  }

  test('measures rainy days against dry ones once there are 5 of each', () => {
    const r = run([days(5, 1, 800, 12), days(5, 10, 1000, 0)])
    expect(r).toEqual({ rainyDays: 5, dryDays: 5, pct: 80 })
  })

  test('says nothing below 5 rainy days, but still counts them', () => {
    const r = run([days(4, 1, 800, 12), days(10, 10, 1000, 0)])
    expect(r.pct).toBeNull()
    expect(r.rainyDays).toBe(4)
  })

  test('ignores part-day weather and a weekday the outlet is shut', () => {
    const shut = { log: { ad: '2026-08-30', dow: 6, sales: 500 }, weather: ['2026-08-30', { precip_mm: 20, complete: true }] }
    const r = run([days(5, 1, 800, 12), days(5, 10, 1000, 0), days(3, 20, 100, 30, false), [shut]])
    expect(r).toEqual({ rainyDays: 5, dryDays: 5, pct: 80 })
  })
})
