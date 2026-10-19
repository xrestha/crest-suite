// Demand Forecast arithmetic (S694). Each test pins a claim that, if it broke, would produce a
// plausible-looking number rather than an error — the danger with any forecast.
import {
  historyFromDailyTotals, mergeManualHistory, dateOfIso, hasForecastEvidence,
  periodsInLookback, weightedMean, forecastByWeekday,
  platesOf, splitDishList, totalQtyByRecipe, aggregateIngredientDemand, ingredientBuyList,
  scaleForecastDays, usualSupplierByItem, holidaysByKeyOf, holidayKey,
  averageChoicesPerPlate, addDemand,
  SAMPLES_PER_WEEKDAY, OCCASIONAL_THRESHOLD,
} from './demandForecastMath'
import { bsToAd, adToBs } from './bsCalendar'

// Tuesday 8 September 2026, 08:11 local — the recompute in the screenshot that started this.
const NOW = new Date(2026, 8, 8, 8, 11)
const daysAgo = (n, h = 13) => new Date(2026, 8, 8 - n, h)
const wed = n => daysAgo(6 + 7 * n) // n weeks back from Wednesday 2 Sep (n = 0)
const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate())

// A monthly_periods row for whichever BS month an AD date falls in, and the sales_entries row
// for that date — so a fixture can be written in AD and read the way the page reads BS.
const periodOf = date => { const bs = adToBs(date); return { id: `p${bs.year}-${bs.month}`, bs_year: bs.year, bs_month: bs.month } }
const entryOn = (date, recipe_id, qty_sold, extra = {}) => ({ period_id: periodOf(date).id, recipe_id, bs_day: adToBs(date).day, qty_sold, source: 'manual', ...extra })
const periodsFor = dates => Object.fromEntries(dates.map(periodOf).map(p => [p.id, p]))

// S849 FORECAST-1/-2/-5: the till's history arrives as daily totals from the server.
describe('historyFromDailyTotals', () => {
  it('keeps each Nepal date as that calendar day wherever the device is (FORECAST-5)', () => {
    const [row] = historyFromDailyTotals([{ date: '2026-10-16', bills: 3, covers: 7, revenue: 4520.5, qty: { r1: 2, r2: '1.5' } }])
    expect(row.weekday).toBe(5) // Friday 16 October 2026
    expect(row.date.getFullYear()).toBe(2026)
    expect(row.date.getMonth()).toBe(9)
    expect(row.date.getDate()).toBe(16)
    expect(adToBs(row.date)).toEqual(adToBs(new Date(2026, 9, 16)))
    expect(row).toMatchObject({ bills: 3, covers: 7, revenue: 4520.5, basis: 'pos', qtyByRecipe: { r1: 2, r2: 1.5 } })
  })

  it('sorts by date, drops an undated object, and treats a missing qty as no dishes', () => {
    const rows = historyFromDailyTotals([
      { date: '2026-10-12', bills: 1, covers: 1, revenue: 100 },
      { date: null, bills: 9 },
      { date: '2026-10-10', bills: 2, covers: 2, revenue: 200, qty: { r1: 0, r2: 3 } },
    ])
    expect(rows.map(r => r.date.getDate())).toEqual([10, 12])
    expect(rows[0].qtyByRecipe).toEqual({ r2: 3 }) // a zero is not a dish sold
    expect(rows[1].qtyByRecipe).toEqual({})
  })

  it('dateOfIso builds a local-midnight Date, never UTC midnight', () => {
    const d = dateOfIso('2026-10-16')
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 9, 16, 0])
    expect(dateOfIso('')).toBeNull()
  })
})

// S849 FORECAST-6: hand-entered daily sales always count, per (day, dish), by the stock rule.
describe('mergeManualHistory', () => {
  const till = (date, qtyByRecipe, extra = {}) => ({ date: midnight(date), weekday: date.getDay(), covers: 10, revenue: 1000, qtyByRecipe, basis: 'pos', ...extra })
  const window = { from: midnight(daysAgo(84)), today: midnight(NOW) }

  it('a dish the till did not sell that day joins the till day; a dish it did sell keeps the till figure', () => {
    const tillDay = till(wed(0), { r1: 4 })
    const { history, manualDays } = mergeManualHistory([tillDay], [
      entryOn(wed(0), 'x', 3),   // the till did not sell X that Wednesday → counted
      entryOn(wed(0), 'r1', 99), // the till sold r1 that day → the till's 4 stands
    ], periodsFor([wed(0)]), window)
    expect(history).toHaveLength(1)
    expect(history[0].qtyByRecipe).toEqual({ r1: 4, x: 3 })
    expect(history[0].basis).toBe('pos')
    expect(history[0].covers).toBe(10) // covers and revenue stay the till's
    expect(manualDays).toBe(0)
    expect(tillDay.qtyByRecipe).toEqual({ r1: 4 }) // the input is not changed
  })

  it('a day with no till bill becomes a manual-basis day; a Bulk row is skipped and counted; rows outside the window drop', () => {
    const { history, manualDays, undatedRows } = mergeManualHistory([], [
      entryOn(wed(1), 'r1', '2.5'),
      entryOn(wed(1), 'r1', 1),
      { ...entryOn(wed(1), 'r1', 300), bs_day: 0 },   // a month's Bulk total: no day
      entryOn(daysAgo(0, 9), 'r1', 50),               // today: never a sample
      entryOn(daysAgo(120), 'r1', 50),                // before the window
      { ...entryOn(wed(2), 'r1', 5), period_id: 'zz' }, // period outside the window's list
    ], periodsFor([wed(1), daysAgo(0), daysAgo(120)]), window)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ basis: 'manual', covers: 0, revenue: 0, qtyByRecipe: { r1: 3.5 } })
    expect(manualDays).toBe(1)
    expect(undatedRows).toBe(1)
  })

  it('four recent hand-entered Wednesdays after the till was switched off outrank older till ones', () => {
    const tillWeds = [4, 5, 6, 7, 8, 9, 10, 11].map(n => till(wed(n), { r1: 2 }))
    const manual = [0, 1, 2, 3].map(n => entryOn(wed(n), 'r1', 10))
    const { history, manualDays } = mergeManualHistory(tillWeds, manual, periodsFor([0, 1, 2, 3].map(wed)), window)
    expect(manualDays).toBe(4)
    const nextWed = forecastByWeekday(history, 7, {}, NOW).find(f => f.weekday === 3)
    expect(nextWed.sampleCount).toBe(8)
    expect(nextWed.posSampleCount).toBe(4)
    // weights 8,7,6,5 on the four hand-entered 10s, 4,3,2,1 on the four till 2s
    expect(nextWed.forecastQtyByRecipe.r1).toBeCloseTo((26 * 10 + 10 * 2) / 36)
    expect(nextWed.forecastCovers).toBe(10) // covers from the till days only
  })
})

describe('periodsInLookback', () => {
  it('keeps the period the window starts in and everything after, drops older ones', () => {
    const start = bsToAd(2083, 3, 20)
    const kept = periodsInLookback([
      { id: 'old', bs_year: 2083, bs_month: 2 },
      { id: 'edge', bs_year: 2083, bs_month: 3 },
      { id: 'new', bs_year: 2083, bs_month: 5 },
      { id: 'prevyear', bs_year: 2082, bs_month: 12 },
    ], start)
    expect(kept.map(p => p.id)).toEqual(['edge', 'new'])
  })

  it('with an end, also drops periods that start after the window', () => {
    const kept = periodsInLookback([
      { id: 'edge', bs_year: 2083, bs_month: 3 },
      { id: 'in', bs_year: 2083, bs_month: 5 },
      { id: 'after', bs_year: 2083, bs_month: 7 },
    ], bsToAd(2083, 3, 20), bsToAd(2083, 6, 2))
    expect(kept.map(p => p.id)).toEqual(['edge', 'in'])
  })
})

describe('weightedMean', () => {
  it('weights the most recent sample heaviest and returns null, not zero, for no samples', () => {
    expect(weightedMean([])).toBeNull()
    expect(weightedMean([10])).toBe(10)
    expect(weightedMean([10, 4])).toBe(8)          // (2·10 + 1·4) / 3
    expect(weightedMean([0, 0, 12])).toBe(2)       // (3·0 + 2·0 + 1·12) / 6
  })
})

// S748's rule, shared with the dashboard's Daily Purchases vs Sales chart since S850.
describe('holidaysByKeyOf', () => {
  it('one entry per date: the row with a multiplier wins, then public over optional', () => {
    const map = holidaysByKeyOf([
      { bs_year: 2083, bs_month: 7, bs_day: 25, name: 'Falgunanda Jayanti', holiday_type: 'optional', demand_multiplier: null },
      { bs_year: 2083, bs_month: 7, bs_day: 25, name: 'Bhai Tika', holiday_type: 'public', demand_multiplier: null },
      { bs_year: 2083, bs_month: 5, bs_day: 7, name: 'Gaura Parva', holiday_type: 'optional', demand_multiplier: 1.4 },
      { bs_year: 2083, bs_month: 5, bs_day: 7, name: 'Krishna Janmashtami', holiday_type: 'public', demand_multiplier: null },
    ])
    expect(Object.keys(map)).toHaveLength(2)
    expect(map[holidayKey(2083, 7, 25)].name).toBe('Bhai Tika')
    expect(map[holidayKey(2083, 5, 7)]).toEqual({ name: 'Gaura Parva', holiday_type: 'optional', demand_multiplier: 1.4 })
    expect(holidaysByKeyOf(null)).toEqual({})
  })
})

describe('forecastByWeekday', () => {
  const sample = (date, qty, extra = {}) => ({ date, weekday: date.getDay(), covers: 10, revenue: 1000, qtyByRecipe: { r1: qty }, basis: 'pos', ...extra })

  it('the day of the run is never a sample — a morning recompute must not count a partial day', () => {
    const history = [sample(daysAgo(0, 7), 1), sample(daysAgo(7), 20), sample(daysAgo(14), 20)] // today is Tuesday
    const out = forecastByWeekday(history, 7, {}, NOW)
    const nextTue = out.find(f => f.weekday === 2)
    expect(nextTue.sampleCount).toBe(2)
    expect(nextTue.forecastQtyByRecipe.r1).toBe(20)
  })

  it('a recent week outweighs an older one, and a dish absent from a sample counts as zero that day', () => {
    const history = [sample(wed(0), 9), { ...sample(wed(1), 0), qtyByRecipe: {} }]
    const out = forecastByWeekday(history, 7, {}, NOW)
    const nextWed = out.find(f => f.weekday === 3)
    expect(nextWed.forecastQtyByRecipe.r1).toBe(6) // (2·9 + 1·0) / 3, not 9
    expect(nextWed.sampleCount).toBe(2)
  })

  it('caps at SAMPLES_PER_WEEKDAY most recent samples', () => {
    const history = Array.from({ length: 12 }, (_, i) => sample(wed(i), i === 11 ? 1000 : 1))
    const out = forecastByWeekday(history, 7, {}, NOW)
    const nextWed = out.find(f => f.weekday === 3)
    expect(nextWed.sampleCount).toBe(SAMPLES_PER_WEEKDAY)
    expect(nextWed.forecastQtyByRecipe.r1).toBe(1) // the 1000 twelve weeks back never gets in
  })

  it('covers and revenue average over POS samples only; a manual-only weekday leaves them null', () => {
    const history = [
      sample(wed(0), 4, { basis: 'manual', covers: 0, revenue: 0 }),
      sample(wed(1), 2),
    ]
    const out = forecastByWeekday(history, 7, {}, NOW)
    const nextWed = out.find(f => f.weekday === 3)
    expect(nextWed.posSampleCount).toBe(1)
    expect(nextWed.forecastCovers).toBe(10)     // not (0 + 10)/2
    expect(nextWed.forecastRevenue).toBe(1000)
    expect(nextWed.forecastQtyByRecipe.r1).toBeCloseTo((2 * 4 + 1 * 2) / 3)

    const manualOnly = forecastByWeekday([sample(wed(0), 4, { basis: 'manual', covers: 0, revenue: 0 })], 7, {}, NOW)
    const w = manualOnly.find(f => f.weekday === 3)
    expect(w.forecastCovers).toBeNull()
    expect(w.forecastRevenue).toBeNull()
    expect(w.posSampleCount).toBe(0)
  })

  it('a holiday multiplier scales dishes, covers and revenue; a holiday without one only flags', () => {
    const history = [sample(wed(0), 4)]
    const nextWedBs = forecastByWeekday(history, 7, {}, NOW).find(f => f.weekday === 3).bs
    const key = `${nextWedBs.year}:${nextWedBs.month}:${nextWedBs.day}`
    const scaled = forecastByWeekday(history, 7, { [key]: { name: 'Teej', demand_multiplier: '1.5' } }, NOW).find(f => f.weekday === 3)
    expect(scaled.forecastQtyByRecipe.r1).toBe(6)
    expect(scaled.forecastCovers).toBe(15)
    expect(scaled.forecastRevenue).toBe(1500)
    const flagged = forecastByWeekday(history, 7, { [key]: { name: 'Teej', demand_multiplier: null } }, NOW).find(f => f.weekday === 3)
    expect(flagged.forecastQtyByRecipe.r1).toBe(4)
    expect(flagged.holiday.name).toBe('Teej')
  })

  it('a past holiday is not a sample — the next ordinary same weekday takes its place (S756, D21)', () => {
    const history = [sample(wed(0), 90), sample(wed(1), 4), sample(wed(2), 4)]
    const tika = adToBs(wed(0))
    const holidays = { [`${tika.year}:${tika.month}:${tika.day}`]: { name: 'Dashain Tika', demand_multiplier: null } }
    const withHoliday = forecastByWeekday(history, 7, holidays, NOW).find(f => f.weekday === 3)
    expect(withHoliday.sampleCount).toBe(2)
    expect(withHoliday.forecastQtyByRecipe.r1).toBe(4) // not pulled toward the festival's 90
    const without = forecastByWeekday(history, 7, {}, NOW).find(f => f.weekday === 3)
    expect(without.sampleCount).toBe(3)
  })

  it('starts tomorrow and produces exactly the horizon, with a weekday of no history left empty rather than zero', () => {
    const out = forecastByWeekday([sample(wed(0), 4)], 30, {}, NOW)
    expect(out).toHaveLength(30)
    expect(out[0].date.getDate()).toBe(9)
    const sun = out.find(f => f.weekday === 0)
    expect(sun.sampleCount).toBe(0)
    expect(sun.forecastQtyByRecipe).toEqual({})
    expect(sun.forecastRevenue).toBeNull()
  })

  it('with the server\'s Nepal date as now, starts the next day and never uses that date as a sample (FORECAST-5)', () => {
    const history = historyFromDailyTotals([
      { date: '2026-10-16', bills: 1, covers: 1, revenue: 1, qty: { r1: 99 } }, // "today" by the server
      { date: '2026-10-09', bills: 1, covers: 1, revenue: 1, qty: { r1: 4 } },
    ])
    const out = forecastByWeekday(history, 7, {}, dateOfIso('2026-10-16'))
    expect(out[0].date.getDate()).toBe(17)
    const fri = out.find(f => f.weekday === 5)
    expect(fri.sampleCount).toBe(1)
    expect(fri.forecastQtyByRecipe.r1).toBe(4)
  })

  // S849 FORECAST-4: how rainy the samples were, so the list does not count rain twice.
  it('a rain sampler gives the recency-weighted share of rain in the average, and the count of rainy samples', () => {
    const history = Array.from({ length: 8 }, (_, i) => sample(wed(i), 10))
    const rainy = new Set([0, 1, 2, 3, 4, 5].map(i => midnight(wed(i)).getTime())) // the most recent six
    const sampleFactorOf = s => (rainy.has(midnight(s.date).getTime()) ? 0.5 : 1)
    const nextWed = forecastByWeekday(history, 7, {}, NOW, { sampleFactorOf }).find(f => f.weekday === 3)
    expect(nextWed.sampleRainFactor).toBeCloseTo(19.5 / 36, 10) // ((8+7+6+5+4+3)·0.5 + (2+1)·1) / 36
    expect(nextWed.rainySampleCount).toBe(6)
    expect(nextWed.forecastQtyByRecipe.r1).toBe(10) // the observed average is unchanged
    // On a rainy day ahead the list buys 0.5 ÷ 0.5417 of the observed average: 0.923 of it.
    expect(0.5 / nextWed.sampleRainFactor).toBeCloseTo(0.923, 3)

    const plain = forecastByWeekday(history, 7, {}, NOW).find(f => f.weekday === 3)
    expect(plain.sampleRainFactor).toBeNull()
    expect(plain.rainySampleCount).toBeNull()
    expect(plain.forecastQtyByRecipe.r1).toBe(10)
  })

  it('exactly half a dry day on a rainy day ahead, when every dry day sold the same', () => {
    // Dry Wednesdays sold 20, rainy ones 10 (the Owner's 50%): the average holds the rain.
    const rainyIdx = new Set([0, 1, 2, 3, 4, 5])
    const history = Array.from({ length: 8 }, (_, i) => sample(wed(i), rainyIdx.has(i) ? 10 : 20))
    const rainyAt = new Set([...rainyIdx].map(i => midnight(wed(i)).getTime()))
    const nextWed = forecastByWeekday(history, 7, {}, NOW, { sampleFactorOf: s => (rainyAt.has(midnight(s.date).getTime()) ? 0.5 : 1) }).find(f => f.weekday === 3)
    const listQty = nextWed.forecastQtyByRecipe.r1 * (0.5 / nextWed.sampleRainFactor)
    expect(listQty).toBeCloseTo(10, 10) // 50% of the dry 20
  })
})

describe('hasForecastEvidence (FORECAST-1)', () => {
  it('false when every day has no sample, true when any day has one', () => {
    expect(hasForecastEvidence([{ sampleCount: 0 }, { sampleCount: 0 }])).toBe(false)
    expect(hasForecastEvidence([])).toBe(false)
    expect(hasForecastEvidence(forecastByWeekday([], 7, {}, NOW))).toBe(false)
    expect(hasForecastEvidence([{ sampleCount: 0 }, { sampleCount: 2 }])).toBe(true)
  })
})

describe('presentation', () => {
  it('platesOf rounds up to whole plates and does not turn 3.0 into 4', () => {
    expect(platesOf(0.8)).toBe(1)
    expect(platesOf(2.8)).toBe(3)
    expect(platesOf(3)).toBe(3)
    expect(platesOf(2.9999999999)).toBe(3)
  })

  it('splitDishList puts the occasional tail aside, sorted highest first, and drops zeros', () => {
    const { plates, occasional } = splitDishList([['a', 0.4], ['b', 2.8], ['c', OCCASIONAL_THRESHOLD], ['d', 0], ['e', 0.1]])
    expect(plates.map(p => [p.recipeId, p.plates])).toEqual([['b', 3], ['c', 1]])
    expect(occasional.map(o => o.recipeId)).toEqual(['a', 'e'])
  })

  it('totalQtyByRecipe sums the horizon and aggregateIngredientDemand multiplies through', () => {
    const totals = totalQtyByRecipe([
      { forecastQtyByRecipe: { toast: 0.8, bowl: 2 } },
      { forecastQtyByRecipe: { toast: 1.2 } },
    ])
    expect(totals).toEqual({ toast: 2, bowl: 2 })
    const byItem = aggregateIngredientDemand(totals, {
      toast: [{ item_id: 'avocado', qty: 0.5 }, { item_id: 'bread', qty: 2 }],
      bowl: [{ item_id: 'avocado', qty: 0.25 }],
      unknown: [{ item_id: 'x', qty: 99 }],
    })
    expect(byItem).toEqual({ avocado: 1.5, bread: 4 })
  })
})

describe('ingredientBuyList (S756, D21)', () => {
  it('to buy is forecast use less what is in store, never below zero', () => {
    const rows = ingredientBuyList({ rice: 5000, oil: 200, salt: 10 }, { rice: 1200, oil: 900 })
    expect(rows).toEqual([
      { id: 'rice', use: 5000, par: 0, inStore: 1200, toBuy: 3800 },
      { id: 'oil', use: 200, par: 0, inStore: 900, toBuy: 0 },
      { id: 'salt', use: 10, par: 0, inStore: 0, toBuy: 10 },
    ])
  })

  it('an unreadable shelf is unknown, not empty — nothing is told to buy everything', () => {
    expect(ingredientBuyList({ rice: 5000 }, null)).toEqual([{ id: 'rice', use: 5000, par: 0, inStore: null, toBuy: null }])
  })

  it('negative theoretical stock counts as none in store, and float residue is not a purchase', () => {
    expect(ingredientBuyList({ a: 3 }, { a: -2 })[0].toBuy).toBe(3)
    expect(ingredientBuyList({ a: 0.1 + 0.2 }, { a: 0.3 })[0].toBuy).toBe(0)
  })

  it('S800: safety stock — buys enough to cover the forecast AND keep the par on the shelf', () => {
    const [r] = ingredientBuyList({ rice: 5000 }, { rice: 1200 }, { rice: 2000 })
    expect(r).toEqual({ id: 'rice', use: 5000, par: 2000, inStore: 1200, toBuy: 5800 })
    // plenty on the shelf, par included: nothing to buy
    expect(ingredientBuyList({ oil: 200 }, { oil: 900 }, { oil: 500 })[0].toBuy).toBe(0)
    // a par with an unreadable shelf is still unknown, never "buy the par"
    expect(ingredientBuyList({ oil: 200 }, null, { oil: 500 })[0].toBuy).toBeNull()
  })

  it('S849: a net-negative use (a "no onion" average) is no use, so the purchase is par − in store, floor 0', () => {
    expect(ingredientBuyList({ onion: -40 }, { onion: 100 }, { onion: 300 })[0]).toEqual({ id: 'onion', use: 0, par: 300, inStore: 100, toBuy: 200 })
    expect(ingredientBuyList({ onion: -40 }, { onion: 500 }, { onion: 300 })[0].toBuy).toBe(0)
    expect(ingredientBuyList({ onion: -40 }, null)[0]).toEqual({ id: 'onion', use: 0, par: 0, inStore: null, toBuy: null })
  })
})

// S849 FORECAST-3 (owner decision SU13 a): the guests' usual choices join the buying list.
describe('averageChoicesPerPlate', () => {
  const day = n => midnight(daysAgo(n))
  const periods = periodsFor([day(3), day(40), day(100), day(0)])
  const row = (n, qty_sold, ingredient_deltas, extra = {}) => ({ ...entryOn(day(n), 'bowl', qty_sold, { source: 'pos' }), ingredient_deltas, ...extra })
  const window = { periodsById: periods, from: day(84), to: day(0) }

  it('averages over every till plate of the dish: 60 bowls, 40 with +30 g banana, is 20 g a plate', () => {
    const out = averageChoicesPerPlate([
      row(3, 40, [{ item_id: 'banana', qty: 30 }]),
      row(40, 20, null), // 20 plain bowls: no choice, still plates
    ], window)
    expect(out.bowl).toEqual([{ item_id: 'banana', qty: 20 }])
  })

  it('ignores hand-entered, credit, unsold and undated rows, and rows outside the window', () => {
    const out = averageChoicesPerPlate([
      row(3, 10, [{ item_id: 'banana', qty: 30 }]),
      row(3, 10, [{ item_id: 'banana', qty: 999 }], { source: 'manual' }),
      row(3, 10, [{ item_id: 'banana', qty: 999 }], { source: null }),
      row(3, -10, [{ item_id: 'banana', qty: 999 }], { source: 'pos_credit' }),
      row(3, 0, [{ item_id: 'banana', qty: 999 }]),
      row(3, 10, [{ item_id: 'banana', qty: 999 }], { bs_day: 0 }),
      row(100, 10, [{ item_id: 'banana', qty: 999 }]), // before the window
      row(0, 10, [{ item_id: 'banana', qty: 999 }]),   // the run's own day: after the window
    ], window)
    expect(out.bowl).toEqual([{ item_id: 'banana', qty: 30 }])
  })

  it('a comped till plate (pos_comp) counts; a sub-recipe line stays a sub-recipe line; a negative line keeps its sign', () => {
    const out = averageChoicesPerPlate([
      row(3, 3, [{ sub_recipe_id: 'granola', qty: 2 }, { item_id: 'onion', qty: -10 }]),
      row(40, 1, [{ sub_recipe_id: 'granola', qty: 2 }], { source: 'pos_comp' }),
    ], window)
    expect(out.bowl).toEqual(expect.arrayContaining([
      { sub_recipe_id: 'granola', qty: 2 },
      { item_id: 'onion', qty: -7.5 },
    ]))
    expect(out.bowl).toHaveLength(2)
  })

  it('a dish with no choice lines at all is absent', () => {
    expect(averageChoicesPerPlate([row(3, 5, null), row(3, 5, [])], window)).toEqual({})
  })
})

describe('addDemand', () => {
  it('sums two per-item maps, signs kept', () => {
    expect(addDemand({ rice: 100, onion: 20 }, { onion: -5, banana: 30 })).toEqual({ rice: 100, onion: 15, banana: 30 })
    expect(addDemand(null, { a: 1 })).toEqual({ a: 1 })
  })
})

describe('scaleForecastDays (S800, rain)', () => {
  const days = [
    { bs: { year: 2083, month: 6, day: 17 }, forecastQtyByRecipe: { momo: 40, tea: 10 } },
    { bs: { year: 2083, month: 6, day: 18 }, forecastQtyByRecipe: { momo: 50 } },
  ]
  it('scales only the rainy days and marks them', () => {
    const out = scaleForecastDays(days, d => (d.bs.day === 18 ? 0.7 : 1))
    expect(out[0]).toBe(days[0])
    expect(out[1].forecastQtyByRecipe.momo).toBeCloseTo(35)
    expect(out[1].rainFactor).toBe(0.7)
    expect(days[1].forecastQtyByRecipe.momo).toBe(50) // the input is not changed
  })
})

describe('usualSupplierByItem (S800)', () => {
  it('takes the vendor on the most recent line — later period, then later day, then later write', () => {
    const rank = { p1: 1, p2: 2 }
    const map = usualSupplierByItem([
      { item_id: 'rice', vendor_id: 'old', period_id: 'p1', bs_day: 30, created_at: '2026-09-01T00:00:00Z' },
      { item_id: 'rice', vendor_id: 'new', period_id: 'p2', bs_day: 2, created_at: '2026-09-20T00:00:00Z' },
      { item_id: 'oil', vendor_id: 'a', period_id: 'p2', bs_day: 5, created_at: '2026-09-21T08:00:00Z' },
      { item_id: 'oil', vendor_id: 'b', period_id: 'p2', bs_day: 5, created_at: '2026-09-21T09:00:00Z' },
      { item_id: 'salt', vendor_id: null, period_id: 'p2', bs_day: 9, created_at: '2026-09-25T00:00:00Z' },
    ], rank)
    expect(map).toEqual({ rice: 'new', oil: 'b' })
  })
})
