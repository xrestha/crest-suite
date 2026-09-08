// Demand Forecast arithmetic (S694). Each test pins a claim that, if it broke, would produce a
// plausible-looking number rather than an error — the danger with any forecast.
import {
  buildDailyHistory, buildManualDailyHistory, periodsInLookback, weightedMean, forecastByWeekday,
  platesOf, splitDishList, totalQtyByRecipe, aggregateIngredientDemand,
  SAMPLES_PER_WEEKDAY, OCCASIONAL_THRESHOLD,
} from './demandForecastMath'
import { computeOrderAmounts } from './posBillingMath'
import { bsToAd } from './bsCalendar'

// Tuesday 8 September 2026, 08:11 local — the recompute in the screenshot that started this.
const NOW = new Date(2026, 8, 8, 8, 11)
const daysAgo = (n, h = 13) => new Date(2026, 8, 8 - n, h)
const wed = n => daysAgo(6 + 7 * n) // n weeks back from Wednesday 2 Sep (n = 0)

describe('buildDailyHistory', () => {
  const order = (id, closed, extra = {}) => ({ id, covers: 2, closed_at: closed.toISOString(), credit_note_id: null, discount_amount: 0, ...extra })
  const line = (recipe_id, qty, unit_price, extra = {}) => ({ recipe_id, qty, unit_price, vat_rate: 0.13, comped: false, ...extra })

  it('revenue is gross less discount, before VAT — the figure every other Revenue means', () => {
    const rows = buildDailyHistory(
      [order('o1', daysAgo(1), { discount_amount: 50 })],
      { o1: [line('r1', 2, 500)] },
      computeOrderAmounts,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].revenue).toBe(950) // 1000 − 50, not 1073.5 (= ×1.13) and not rounded
    expect(rows[0].basis).toBe('pos')
  })

  it('a comped line is left out of revenue but counted as demand, and a credit-noted bill is dropped', () => {
    const rows = buildDailyHistory(
      [order('o1', daysAgo(1)), order('o2', daysAgo(1), { credit_note_id: 'cn' })],
      { o1: [line('r1', 1, 400), line('r2', 3, 100, { comped: true })], o2: [line('r1', 9, 400)] },
      computeOrderAmounts,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].revenue).toBe(400)
    expect(rows[0].qtyByRecipe).toEqual({ r1: 1, r2: 3 })
    expect(rows[0].covers).toBe(2)
  })

  it('a bill with no covers counts as one, and bills on one day fold into one row', () => {
    const rows = buildDailyHistory(
      [order('a', daysAgo(2, 12), { covers: null }), order('b', daysAgo(2, 20), { covers: 4 })],
      { a: [line('r1', 1, 100)], b: [line('r1', 1, 100)] },
      computeOrderAmounts,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].covers).toBe(5)
    expect(rows[0].qtyByRecipe.r1).toBe(2)
  })
})

describe('buildManualDailyHistory', () => {
  const periods = { p: { id: 'p', bs_year: 2083, bs_month: 5 } }

  it('skips the bulk sentinel, unknown periods and days POS already covered', () => {
    const covered = new Set([bsToAd(2083, 5, 10).toDateString()])
    const rows = buildManualDailyHistory([
      { period_id: 'p', recipe_id: 'r1', bs_day: 0, qty_sold: 300 },   // bulk month — never a day
      { period_id: 'zz', recipe_id: 'r1', bs_day: 3, qty_sold: 5 },    // period unknown
      { period_id: 'p', recipe_id: 'r1', bs_day: 10, qty_sold: 7 },    // POS has this day
      { period_id: 'p', recipe_id: 'r1', bs_day: 11, qty_sold: '2.5' },
      { period_id: 'p', recipe_id: 'r1', bs_day: 11, qty_sold: 1 },
    ], periods, covered)
    expect(rows).toHaveLength(1)
    expect(rows[0].qtyByRecipe).toEqual({ r1: 3.5 })
    expect(rows[0].basis).toBe('manual')
    expect(rows[0].covers).toBe(0)
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
})

describe('weightedMean', () => {
  it('weights the most recent sample heaviest and returns null, not zero, for no samples', () => {
    expect(weightedMean([])).toBeNull()
    expect(weightedMean([10])).toBe(10)
    expect(weightedMean([10, 4])).toBe(8)          // (2·10 + 1·4) / 3
    expect(weightedMean([0, 0, 12])).toBe(2)       // (3·0 + 2·0 + 1·12) / 6
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

  it('starts tomorrow and produces exactly the horizon, with a weekday of no history left empty rather than zero', () => {
    const out = forecastByWeekday([sample(wed(0), 4)], 30, {}, NOW)
    expect(out).toHaveLength(30)
    expect(out[0].date.getDate()).toBe(9)
    const sun = out.find(f => f.weekday === 0)
    expect(sun.sampleCount).toBe(0)
    expect(sun.forecastQtyByRecipe).toEqual({})
    expect(sun.forecastRevenue).toBeNull()
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
