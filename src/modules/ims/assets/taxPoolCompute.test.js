import { bsToAd, formatAd } from '../../../utils/bsCalendar'
import {
  acquisitionProrationTier, computePoolMovement, computeRepairCapCheck, computeIntangibleAmortization,
  parseAdDateLocal, intangibleAmortizationForYear, computeIntangiblePool, priorPoolRun, fiscalYearOfAdDate,
  fiscalYearStartOfAdDate, openingLockedBy,
} from './taxPoolCompute'

const FY_START = 2082 // fiscal year 2082/83: Shrawan 2082 -> Ashadh 2083

describe('acquisitionProrationTier', () => {
  test('Shrawan (month 4, FY start) -> full', () => {
    expect(acquisitionProrationTier({ acquisitionDate: bsToAd(2082, 4, 1), fiscalYearStartBs: FY_START })).toBe('full')
  })

  test('last day of Poush (month 9) -> still full', () => {
    expect(acquisitionProrationTier({ acquisitionDate: bsToAd(2082, 9, 30), fiscalYearStartBs: FY_START })).toBe('full')
  })

  test('Magh (month 10) -> two_third', () => {
    expect(acquisitionProrationTier({ acquisitionDate: bsToAd(2082, 10, 1), fiscalYearStartBs: FY_START })).toBe('two_third')
  })

  test('Chaitra (month 12) -> still two_third', () => {
    expect(acquisitionProrationTier({ acquisitionDate: bsToAd(2082, 12, 15), fiscalYearStartBs: FY_START })).toBe('two_third')
  })

  test('Baisakh of the FOLLOWING BS year (month 1) -> one_third', () => {
    expect(acquisitionProrationTier({ acquisitionDate: bsToAd(2083, 1, 1), fiscalYearStartBs: FY_START })).toBe('one_third')
  })

  test('Ashadh of the following year (month 3, FY end) -> still one_third', () => {
    expect(acquisitionProrationTier({ acquisitionDate: bsToAd(2083, 3, 30), fiscalYearStartBs: FY_START })).toBe('one_third')
  })

  test('outside the fiscal year entirely -> null', () => {
    expect(acquisitionProrationTier({ acquisitionDate: bsToAd(2081, 5, 1), fiscalYearStartBs: FY_START })).toBeNull()
  })

  // TaxPoolTab passes the stored `assets_register.acquisition_date` STRING, not a Date. These are
  // the two tier boundaries where a one-day slip changes the answer (S756).
  test('a stored YYYY-MM-DD string lands in the same tier as the BS day it was picked on', () => {
    expect(acquisitionProrationTier({ acquisitionDate: formatAd(bsToAd(2082, 9, 30)), fiscalYearStartBs: FY_START })).toBe('full')
    expect(acquisitionProrationTier({ acquisitionDate: formatAd(bsToAd(2082, 10, 1)), fiscalYearStartBs: FY_START })).toBe('two_third')
    expect(acquisitionProrationTier({ acquisitionDate: formatAd(bsToAd(2083, 1, 1)), fiscalYearStartBs: FY_START })).toBe('one_third')
  })
})

describe('parseAdDateLocal', () => {
  // Jest cannot switch the process timezone mid-run, so the regression is pinned on the property
  // that matters rather than on a west-of-UTC clock: the parsed Date must be LOCAL midnight of the
  // stated day. `new Date('2026-01-15')` fails this in every zone except UTC itself (05:45 here,
  // 19:00 on the 14th in New York), and adToBs() reads exactly these local getters.
  test('a date string becomes local midnight of that calendar day', () => {
    const d = parseAdDateLocal('2026-01-15')
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 0, 15, 0, 0])
  })

  test('a timestamp string keeps its calendar day', () => {
    const d = parseAdDateLocal('2026-01-15T23:59:00Z')
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 0, 15])
  })

  test('a Date passes through untouched', () => {
    const src = new Date(2026, 0, 15)
    expect(parseAdDateLocal(src)).toBe(src)
  })
})

describe('computePoolMovement', () => {
  test('opening balance only, no additions/disposals: straight rate × opening', () => {
    const result = computePoolMovement({
      pool: 'B', openingWdv: 100000, additionsFull: 0, additionsTwoThird: 0, additionsOneThird: 0,
      disposalProceeds: 0,
    })
    expect(result.depreciation_amount).toBe(25000) // Pool B = 25%
    expect(result.closing_wdv).toBe(75000)
  })

  test('an addition acquired mid-year only gets a fractional rate applied, but its FULL value joins the pool', () => {
    const result = computePoolMovement({
      pool: 'C', openingWdv: 0, additionsFull: 0, additionsTwoThird: 100000, additionsOneThird: 0,
      disposalProceeds: 0,
    })
    // Pool C = 20% rate, addition only gets 2/3 weight this year: 100000 * 2/3 * 0.20 = 13333.33
    expect(result.depreciation_amount).toBeCloseTo(13333.33, 1)
    // but the pool's running balance carries the FULL addition value, not the prorated share
    expect(result.closing_wdv).toBeCloseTo(100000 - 13333.33, 1)
  })

  test('disposal proceeds reduce the pool directly (no per-asset gain/loss)', () => {
    const result = computePoolMovement({
      pool: 'D', openingWdv: 50000, additionsFull: 0, additionsTwoThird: 0, additionsOneThird: 0,
      disposalProceeds: 20000,
    })
    // base = 50000 - 20000 = 30000; rate 15% -> 4500
    expect(result.depreciation_amount).toBe(4500)
    expect(result.closing_wdv).toBe(25500)
  })

  test('prior year capitalized repair excess joins the base at full weight', () => {
    const withExcess = computePoolMovement({
      pool: 'A', openingWdv: 100000, additionsFull: 0, additionsTwoThird: 0, additionsOneThird: 0,
      disposalProceeds: 0, priorYearCapitalizedRepairExcess: 10000,
    })
    const without = computePoolMovement({
      pool: 'A', openingWdv: 100000, additionsFull: 0, additionsTwoThird: 0, additionsOneThird: 0,
      disposalProceeds: 0,
    })
    expect(withExcess.depreciation_amount).toBeCloseTo(without.depreciation_amount + 10000 * 0.05, 2)
  })

  test('never depreciates the pool below zero', () => {
    const result = computePoolMovement({
      pool: 'B', openingWdv: 100, additionsFull: 0, additionsTwoThird: 0, additionsOneThird: 0,
      disposalProceeds: 90,
    })
    expect(result.closing_wdv).toBeGreaterThanOrEqual(0)
  })

  test('throws for Pool E (no flat rate — use computeIntangibleAmortization instead)', () => {
    expect(() => computePoolMovement({
      pool: 'E', openingWdv: 1000, additionsFull: 0, additionsTwoThird: 0, additionsOneThird: 0, disposalProceeds: 0,
    })).toThrow()
  })
})

describe('computeRepairCapCheck', () => {
  test('under the cap: fully deductible, nothing capitalized', () => {
    const result = computeRepairCapCheck({ repairExpenseTotal: 3000, closingWdv: 100000 })
    expect(result.deductible).toBe(3000)
    expect(result.capitalizedExcess).toBe(0)
  })

  test('over the 5% cap: excess is capitalized, not deducted', () => {
    const result = computeRepairCapCheck({ repairExpenseTotal: 8000, closingWdv: 100000 })
    expect(result.deductible).toBe(5000) // 5% of 100000
    expect(result.capitalizedExcess).toBe(3000)
  })

  test('exactly at the cap: fully deductible', () => {
    const result = computeRepairCapCheck({ repairExpenseTotal: 5000, closingWdv: 100000 })
    expect(result.deductible).toBe(5000)
    expect(result.capitalizedExcess).toBe(0)
  })
})

describe('computeIntangibleAmortization', () => {
  test('acquired in the first half of the FY (Shrawan-Poush): full annual amount', () => {
    const result = computeIntangibleAmortization({
      cost: 60000, usefulLifeYears: 5, acquisitionDate: bsToAd(2082, 5, 1), fiscalYearStartBs: FY_START,
    })
    expect(result.annual_amortization).toBe(12000)
    expect(result.first_year_amount).toBe(12000)
  })

  test('acquired in the second half of the FY (Magh onwards): half the annual amount', () => {
    const result = computeIntangibleAmortization({
      cost: 60000, usefulLifeYears: 5, acquisitionDate: bsToAd(2082, 11, 1), fiscalYearStartBs: FY_START,
    })
    expect(result.annual_amortization).toBe(12000)
    expect(result.first_year_amount).toBe(6000)
  })

  test('0 useful life years -> 0, not Infinity/NaN', () => {
    const result = computeIntangibleAmortization({
      cost: 60000, usefulLifeYears: 0, acquisitionDate: bsToAd(2082, 5, 1), fiscalYearStartBs: FY_START,
    })
    expect(result.annual_amortization).toBe(0)
    expect(result.first_year_amount).toBe(0)
  })
})

// S792 (COSTS-6): Pool E stops at the end of each asset's useful life.
describe('intangibleAmortizationForYear', () => {
  const stored = (y, m, d) => formatAd(bsToAd(y, m, d))
  const yearsOf = (acquisitionDate, cost, life, fromFy, n) =>
    Array.from({ length: n }, (_, i) => intangibleAmortizationForYear({ cost, usefulLifeYears: life, acquisitionDate, fiscalYearStartBs: fromFy + i }).amount)

  test('software 30,000 over 3 years bought in Shrawan 2079: three full years, then nothing', () => {
    expect(yearsOf(stored(2079, 4, 10), 30000, 3, 2079, 5)).toEqual([10000, 10000, 10000, 0, 0])
  })

  test('bought in Magh: a half first year leaves a half final year, and the total is the cost', () => {
    const years = yearsOf(stored(2079, 10, 5), 30000, 3, 2079, 5)
    expect(years).toEqual([5000, 10000, 10000, 5000, 0])
    expect(years.reduce((s, v) => s + v, 0)).toBe(30000)
  })

  test('a cost that does not divide evenly leaves no stray paisa after its last year', () => {
    const years = yearsOf(stored(2079, 4, 10), 10000, 3, 2079, 4)
    expect(years[3]).toBe(0)
    expect(years.reduce((s, v) => s + v, 0)).toBeCloseTo(10000, 2)
  })

  test('nothing in a year before the one it was bought in', () => {
    const r = intangibleAmortizationForYear({ cost: 30000, usefulLifeYears: 3, acquisitionDate: stored(2083, 4, 1), fiscalYearStartBs: FY_START })
    expect(r).toEqual({ amount: 0, acquiredThisYear: false })
  })

  test('flags the year it was bought', () => {
    expect(intangibleAmortizationForYear({ cost: 30000, usefulLifeYears: 3, acquisitionDate: stored(2082, 6, 1), fiscalYearStartBs: FY_START }).acquiredThisYear).toBe(true)
  })
})

describe('computeIntangiblePool', () => {
  const stored = (y, m, d) => formatAd(bsToAd(y, m, d))
  const software = { tax_pool: 'E', status: 'active', total_cost: 30000, useful_life_years: 3, acquisition_date: stored(2080, 4, 10) }

  test('never deducts more than the pool holds', () => {
    // FY 82/83 is the software's third year (10,000 scheduled), but the pool opened at 0.
    const e = computeIntangiblePool({ assets: [software], openingWdv: 0, fiscalYearStartBs: FY_START })
    expect(e.scheduled).toBe(10000)
    expect(e.depreciation_amount).toBe(0)
    expect(e.closing_wdv).toBe(0)
  })

  test('a live pool is charged the year\'s amortization; a spent asset adds nothing; this year\'s purchase is an addition', () => {
    const spent = { ...software, acquisition_date: stored(2078, 4, 10) } // its three years ended with FY 80/81
    const bought = { tax_pool: 'E', status: 'active', total_cost: 12000, useful_life_years: 4, acquisition_date: stored(2082, 10, 1) }
    const other = { tax_pool: 'D', status: 'active', total_cost: 99999, useful_life_years: 1, acquisition_date: stored(2082, 5, 1) }
    const e = computeIntangiblePool({ assets: [software, spent, bought, other], openingWdv: 10000, fiscalYearStartBs: FY_START })
    expect(e.additions).toBe(12000)
    expect(e.scheduled).toBe(10000 + 1500) // software's last year + half of 3,000 for a Magh purchase
    expect(e.depreciation_base).toBe(22000)
    expect(e.depreciation_amount).toBe(11500)
    expect(e.closing_wdv).toBe(10500)
  })

  // S792 stage 3: which assets were in the pool is judged against the year, not today's status.
  describe('a disposed asset', () => {
    // 30,000 over 3 years from Shrawan 2081: 10,000 in 81/82, 82/83 and 83/84.
    const sold = when => ({ tax_pool: 'E', status: 'disposed', total_cost: 30000, useful_life_years: 3,
      acquisition_date: stored(2081, 4, 10), disposal_date: when, disposal_proceeds: 12000 })

    test('sold in a later year still counts in every year it was held', () => {
      const bought = computeIntangiblePool({ assets: [sold(stored(2083, 5, 1))], openingWdv: 0, fiscalYearStartBs: FY_START - 1 })
      expect(bought.additions).toBe(30000)
      expect(bought.depreciation_amount).toBe(10000)
      const held = computeIntangiblePool({ assets: [sold(stored(2083, 5, 1))], openingWdv: 20000, fiscalYearStartBs: FY_START })
      expect(held).toMatchObject({ additions: 0, disposed_value: 0, disposal_proceeds: 0, depreciation_amount: 10000, closing_wdv: 10000 })
    })

    test('sold this year: no amortization, and it leaves the pool at the value not yet claimed', () => {
      const e = computeIntangiblePool({ assets: [sold(stored(2082, 9, 1))], openingWdv: 20000, fiscalYearStartBs: FY_START })
      expect(e.scheduled).toBe(0)
      expect(e.disposed_value).toBe(20000) // 30,000 less the 10,000 claimed in 81/82
      expect(e.disposal_proceeds).toBe(12000)
      expect(e.depreciation_base).toBe(0)
      expect(e.closing_wdv).toBe(0)
    })

    test('sold in an earlier year: not in this year\'s pool at all', () => {
      const e = computeIntangiblePool({ assets: [sold(stored(2082, 2, 1))], openingWdv: 0, fiscalYearStartBs: FY_START })
      expect(e).toMatchObject({ additions: 0, disposed_value: 0, disposal_proceeds: 0, scheduled: 0 })
    })

    test('bought and sold in the same year: the purchase and its exit net to nothing', () => {
      const flip = { ...sold(stored(2082, 11, 1)), acquisition_date: stored(2082, 5, 1) }
      const e = computeIntangiblePool({ assets: [flip], openingWdv: 5000, fiscalYearStartBs: FY_START })
      expect(e.additions).toBe(30000)
      expect(e.disposed_value).toBe(30000)
      expect(e.depreciation_base).toBe(5000)
    })

    test('a disposed asset with no disposal date cannot be placed in a year and stays out', () => {
      const e = computeIntangiblePool({ assets: [sold(null)], openingWdv: 0, fiscalYearStartBs: FY_START })
      expect(e).toMatchObject({ additions: 0, disposed_value: 0, scheduled: 0 })
    })
  })
})

describe('fiscalYearStartOfAdDate', () => {
  test('Ashadh belongs to the year that started the Shrawan before; no date is null', () => {
    expect(fiscalYearStartOfAdDate(formatAd(bsToAd(2083, 3, 30)))).toBe(2082)
    expect(fiscalYearStartOfAdDate(formatAd(bsToAd(2083, 4, 1)))).toBe(2083)
    expect(fiscalYearStartOfAdDate(null)).toBeNull()
  })
})

// S792 (COSTS-5): the prior year's run, and whether a missing one is a skipped year.
describe('priorPoolRun', () => {
  test('the prior year posted: its latest run, no gap', () => {
    const runs = [
      { id: 'a', fiscal_year: '81/82', created_at: '2025-08-01T00:00:00Z' },
      { id: 'b', fiscal_year: '81/82', created_at: '2025-09-01T00:00:00Z' },
      { id: 'c', fiscal_year: '80/81', created_at: '2024-08-01T00:00:00Z' },
    ]
    const r = priorPoolRun({ runs, fiscalYearStartBs: FY_START })
    expect(r.priorLabel).toBe('81/82')
    expect(r.priorRun.id).toBe('b')
    expect(r.earlierLabel).toBeNull()
  })

  test('the prior year skipped but an earlier one posted: names both', () => {
    const runs = [
      { id: 'c', fiscal_year: '79/80', created_at: '2023-08-01T00:00:00Z' },
      { id: 'd', fiscal_year: '80/81', created_at: '2024-08-01T00:00:00Z' },
      { id: 'e', fiscal_year: '83/84', created_at: '2027-08-01T00:00:00Z' }, // a later year is not "earlier"
    ]
    expect(priorPoolRun({ runs, fiscalYearStartBs: FY_START })).toEqual({ priorLabel: '81/82', priorRun: null, earlierLabel: '80/81', typedOpenings: {} })
  })

  test('nothing posted at all: a first year, not a gap', () => {
    expect(priorPoolRun({ runs: [], fiscalYearStartBs: FY_START })).toEqual({ priorLabel: '81/82', priorRun: null, earlierLabel: null, typedOpenings: {} })
  })
})

describe('fiscalYearOfAdDate', () => {
  test('Ashadh closes one fiscal year and Shrawan opens the next', () => {
    expect(fiscalYearOfAdDate(formatAd(bsToAd(2082, 3, 30)))).toBe('81/82')
    expect(fiscalYearOfAdDate(formatAd(bsToAd(2082, 4, 1)))).toBe('82/83')
  })
})

// D40 (S792 stage 4): opening values typed in from last year's tax return.
describe('priorPoolRun — typed openings (D40)', () => {
  const openings = [
    { pool: 'A', fiscal_year: '82/83', opening_wdv: 50000, repair_carry_forward: 1200 },
    { pool: 'B', fiscal_year: '81/82', opening_wdv: 9999, repair_carry_forward: 0 },  // another year
    { pool: 'E', fiscal_year: '82/83', opening_wdv: 7777, repair_carry_forward: 0 },  // Pool E takes none
  ]

  test('used for its own year when the year before has no run', () => {
    const r = priorPoolRun({ runs: [], fiscalYearStartBs: FY_START, openings })
    expect(r.priorRun).toBeNull()
    expect(r.typedOpenings).toEqual({ A: { openingWdv: 50000, repairCarryForward: 1200 } })
  })

  test('a real run for the year before always wins', () => {
    const runs = [{ id: 'p', fiscal_year: '81/82', created_at: '2025-08-01T00:00:00Z' }]
    const r = priorPoolRun({ runs, fiscalYearStartBs: FY_START, openings })
    expect(r.priorRun.id).toBe('p')
    expect(r.typedOpenings).toEqual({})
  })

  test('not used for a later year: the years in between carry it', () => {
    expect(priorPoolRun({ runs: [], fiscalYearStartBs: FY_START + 1, openings }).typedOpenings).toEqual({})
  })
})

describe('openingLockedBy (D40, Q4)', () => {
  const opening = { pool: 'A', fiscal_year: '82/83' }
  test('unlocked while no posted run reaches its year', () => {
    expect(openingLockedBy({ opening, runs: [{ fiscal_year: '81/82' }] })).toBeNull()
  })
  test('locked by a run for its own year, or the earliest later one', () => {
    expect(openingLockedBy({ opening, runs: [{ fiscal_year: '84/85' }, { fiscal_year: '82/83' }] })).toBe('82/83')
    expect(openingLockedBy({ opening, runs: [{ fiscal_year: '84/85' }, { fiscal_year: '83/84' }] })).toBe('83/84')
  })
  test('no readable year: nothing to lock', () => {
    expect(openingLockedBy({ opening: { fiscal_year: '' }, runs: [{ fiscal_year: '82/83' }] })).toBeNull()
  })
})

describe('computeIntangiblePool — depreciation already taken and the derived opening (D40, Q5)', () => {
  const stored = (y, m, d) => formatAd(bsToAd(y, m, d))
  // 30,000 over 3 years, bought Shrawan 2080: 10,000 a year on its own schedule.
  const software = { tax_pool: 'E', status: 'active', total_cost: 30000, useful_life_years: 3, acquisition_date: stored(2080, 4, 10) }

  test('no run for the year before: the pool opens at what its assets have not yet claimed', () => {
    // By the start of FY 82/83 the schedule has claimed 20,000 of it.
    const e = computeIntangiblePool({ assets: [software], openingWdv: null, fiscalYearStartBs: FY_START })
    expect(e.derived_opening).toBe(10000)
    expect(e.opening_wdv).toBe(10000)
    expect(e.depreciation_amount).toBe(10000)
    expect(e.closing_wdv).toBe(0)
  })

  test('a posted opening is used as given, the derived one only reported', () => {
    const e = computeIntangiblePool({ assets: [software], openingWdv: 4000, fiscalYearStartBs: FY_START })
    expect(e.opening_wdv).toBe(4000)
    expect(e.derived_opening).toBe(10000)
    expect(e.depreciation_amount).toBe(4000)
  })

  test('"already taken" counts as amortised through the end of its fiscal year, then the annual amount runs on', () => {
    // Only 6,000 taken by the end of FY 81/82 (Ashadh 2082): 24,000 left, 10,000 a year from FY 82/83.
    const taken = { ...software, opening_accumulated_depreciation: 6000, opening_as_of: stored(2082, 3, 31) }
    const y1 = computeIntangiblePool({ assets: [taken], openingWdv: null, fiscalYearStartBs: FY_START })
    expect(y1.opening_wdv).toBe(24000)
    expect(y1.scheduled).toBe(10000)
    const y3 = computeIntangiblePool({ assets: [taken], openingWdv: 4000, fiscalYearStartBs: FY_START + 2 })
    expect(y3.scheduled).toBe(4000) // 6,000 + 10,000 + 10,000 claimed; the last 4,000 ends it
    const y4 = computeIntangiblePool({ assets: [taken], openingWdv: 0, fiscalYearStartBs: FY_START + 3 })
    expect(y4.scheduled).toBe(0)
  })

  test('"already taken" never claims more than cost', () => {
    const over = { ...software, opening_accumulated_depreciation: 45000, opening_as_of: stored(2082, 3, 31) }
    const e = computeIntangiblePool({ assets: [over], openingWdv: null, fiscalYearStartBs: FY_START })
    expect(e.opening_wdv).toBe(0)
    expect(e.scheduled).toBe(0)
  })
})
