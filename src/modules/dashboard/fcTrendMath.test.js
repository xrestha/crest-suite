import { fcTrendView, lowestPossibleFc, aboveGoodLine, MIN_COMPARED_MONTHS } from './fcTrendMath'

// A closed month as loadFcTrend builds it: fc = COGS ÷ revenue, to one decimal.
const month = (label, cogs, revenue, extra = {}) => ({
  label, cogs, revenue, fc: Math.round((cogs / revenue) * 1000) / 10, basis: 'cogs', open: false, unjudged: false, ...extra,
})
const grey = (label, cogs, revenue, uncountedValue) => month(label, cogs, revenue, { unjudged: true, uncountedValue })
const openMonth = (label, purchases, revenue) => ({
  label, purchases, revenue, fc: Math.round((purchases / revenue) * 1000) / 10, basis: 'spend', open: true,
})

// The chart that started this (S826): two grey months, one counted month, the open month.
const reported = [
  grey('Asha 2083', 602000, 1000000, 190000),
  grey('Shra 2083', 490000, 1000000, 40000),
  month('Bhad 2083', 468000, 1000000),
  openMonth('Ashw 2083', 426000, 1000000),
]

describe('fcTrendView — what may be compared', () => {
  test('the Average is made from fully counted months only, and says how many were left out', () => {
    const v = fcTrendView(reported, { warnPct: 35 })
    expect(v.average.pct).toBeCloseTo(46.8, 5)
    expect(v.average.months).toBe(1)
    expect(v.average.leftOut).toBe(2)
  })

  test('the Average is blended — Σ COGS ÷ Σ sales — not the mean of the monthly percentages', () => {
    const v = fcTrendView([month('A', 30000, 100000), month('B', 400000, 1000000)], { warnPct: 35 })
    // Mean of 30% and 40% would be 35%; the busy month weighs ten times the quiet one.
    expect(v.average.pct).toBeCloseTo((430000 / 1100000) * 100, 5)
  })

  test('one counted month is neither Best nor Highest', () => {
    const v = fcTrendView(reported, { warnPct: 35 })
    expect(MIN_COMPARED_MONTHS).toBe(2)
    expect(v.best).toBeNull()
    expect(v.highest).toBeNull()
  })

  test('two counted months name a Best and a Highest, and a grey month is never either', () => {
    const v = fcTrendView([
      grey('A', 700000, 1000000, 300000), month('B', 380000, 1000000), month('C', 420000, 1000000), openMonth('D', 200000, 1000000),
    ], { warnPct: 35 })
    expect(v.best.label).toBe('B')
    expect(v.highest.label).toBe('C')
  })

  test('no counted month: no Average, no money figure, no superlatives', () => {
    const v = fcTrendView([grey('A', 600000, 1000000, 100000), grey('B', 500000, 1000000, 50000)], { warnPct: 35 })
    expect(v.average).toBeNull()
    expect(v.above).toBeNull()
    expect(v.best).toBeNull()
    expect(v.countedCount).toBe(0)
    expect(v.closedCount).toBe(2)
  })

  test('the open month never counts toward the Average, the money or the sales sample', () => {
    const v = fcTrendView([month('A', 400000, 1000000), openMonth('B', 900000, 100000)], { warnPct: 35 })
    expect(v.average.pct).toBeCloseTo(40, 5)
    expect(v.pointValue).toBe(10000)
  })
})

describe('the money', () => {
  test('a counted month is priced against the Good line: 46.8% on NPR 10 lakh is NPR 1.18 lakh over 35%', () => {
    expect(aboveGoodLine(month('Bhad', 468000, 1000000), 35)).toBeCloseTo(118000, 5)
  })

  test('under the line is negative', () => {
    expect(aboveGoodLine(month('A', 300000, 1000000), 35)).toBeCloseTo(-50000, 5)
  })

  test('the total equals (Average − Good line) × the counted months\' sales', () => {
    const v = fcTrendView([month('A', 380000, 1000000), month('B', 900000, 2000000)], { warnPct: 35 })
    expect(v.above.npr).toBeCloseTo((v.average.pct - 35) / 100 * 3000000, 5)
    expect(v.above.months).toBe(2)
  })

  test('grey months take no part in the total and show no rupee figure of their own', () => {
    const v = fcTrendView(reported, { warnPct: 35 })
    expect(v.above.npr).toBeCloseTo(118000, 5)
    expect(v.rows[0].aboveGood).toBeNull()
    expect(v.rows[2].aboveGood).toBeCloseTo(118000, 5)
  })

  test('one point is 1% of an average closed month\'s sales, grey months included (a count does not move sales)', () => {
    const v = fcTrendView([grey('A', 600000, 800000, 1), month('B', 400000, 1200000)], { warnPct: 35 })
    expect(v.pointValue).toBe(10000)
  })

  test('the open month has no rupee figure: it is a different measure', () => {
    expect(aboveGoodLine(openMonth('X', 400000, 1000000), 35)).toBeNull()
  })
})

describe('lowestPossibleFc — the range of a grey month', () => {
  test('none of the uncounted stock used: (COGS − uncounted value) ÷ sales', () => {
    expect(lowestPossibleFc(grey('Asha', 602000, 1000000, 190000))).toBe(41.2)
  })

  test('never below zero, never above the figure itself', () => {
    expect(lowestPossibleFc(grey('A', 100000, 1000000, 500000))).toBe(0)
  })

  test('a counted month, the open month, or a grey month with nothing valued has no range', () => {
    expect(lowestPossibleFc(month('A', 400000, 1000000))).toBeNull()
    expect(lowestPossibleFc(openMonth('B', 400000, 1000000))).toBeNull()
    expect(lowestPossibleFc(grey('C', 400000, 1000000, 0))).toBeNull()
    // A point cached before S826 carries no uncountedValue.
    expect(lowestPossibleFc(grey('D', 400000, 1000000, undefined))).toBeNull()
  })

  test('the row carries it as ErrorBar\'s [lower, upper] error', () => {
    const v = fcTrendView(reported, { warnPct: 35 })
    expect(v.rows[0].lowFc).toBe(41.2)
    expect(v.rows[0].range).toEqual([19, 0])
    expect(v.rows[2].range).toBeNull()
  })
})

describe('which stretches of the line are solid, faded and dashed', () => {
  const v = fcTrendView(reported, { warnPct: 35 })
  const col = key => v.rows.map(r => r[key])

  test('solid only on counted months', () => {
    expect(col('solid')).toEqual([null, null, 46.8, null])
  })

  test('faded on grey months and their closed neighbours, so every segment touching grey is faint', () => {
    expect(col('faded')).toEqual([60.2, 49, 46.8, null])
  })

  test('the dashed bridge joins the last closed month to the open month, and nothing else', () => {
    expect(col('bridge')).toEqual([null, null, 46.8, 42.6])
  })

  test('a counted–counted segment beside grey is in both series, and solid wins it', () => {
    const w = fcTrendView([grey('A', 600000, 1000000, 1), month('B', 400000, 1000000), month('C', 420000, 1000000)], { warnPct: 35 })
    expect(w.rows.map(r => r.faded)).toEqual([60, 40, null])
    expect(w.rows.map(r => r.solid)).toEqual([null, 40, 42])
  })

  test('no open month, no bridge', () => {
    const w = fcTrendView([month('A', 400000, 1000000), month('B', 420000, 1000000)], { warnPct: 35 })
    expect(w.rows.every(r => r.bridge == null)).toBe(true)
  })
})

describe('change since the month before', () => {
  test('sales always; stock used and points only when both months were fully counted', () => {
    const v = fcTrendView([
      month('A', 400000, 1000000), month('B', 420000, 1200000), grey('C', 600000, 1100000, 1), openMonth('D', 1, 1),
    ], { warnPct: 35 })
    expect(v.rows[0].change).toBeNull()
    expect(v.rows[1].change.prevLabel).toBe('A')
    expect(v.rows[1].change.salesPct).toBeCloseTo(20, 5)
    expect(v.rows[1].change.usedPct).toBeCloseTo(5, 5)
    expect(v.rows[1].change.fcPts).toBe(-5)
    expect(v.rows[2].change.salesPct).toBeCloseTo((1100000 - 1200000) / 1200000 * 100, 5)
    expect(v.rows[2].change.usedPct).toBeNull()
    expect(v.rows[2].change.fcPts).toBeNull()
    // The open month is a part-month on another basis: nothing to compare.
    expect(v.rows[3].change).toBeNull()
  })
})
