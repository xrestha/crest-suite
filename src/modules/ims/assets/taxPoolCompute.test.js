import { bsToAd, formatAd } from '../../../utils/bsCalendar'
import {
  acquisitionProrationTier, computePoolMovement, computeRepairCapCheck, computeIntangibleAmortization,
  parseAdDateLocal, intangibleAmortizationForYear, computeIntangiblePool, priorPoolRun, fiscalYearOfAdDate,
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
    expect(priorPoolRun({ runs, fiscalYearStartBs: FY_START })).toEqual({ priorLabel: '81/82', priorRun: null, earlierLabel: '80/81' })
  })

  test('nothing posted at all: a first year, not a gap', () => {
    expect(priorPoolRun({ runs: [], fiscalYearStartBs: FY_START })).toEqual({ priorLabel: '81/82', priorRun: null, earlierLabel: null })
  })
})

describe('fiscalYearOfAdDate', () => {
  test('Ashadh closes one fiscal year and Shrawan opens the next', () => {
    expect(fiscalYearOfAdDate(formatAd(bsToAd(2082, 3, 30)))).toBe('81/82')
    expect(fiscalYearOfAdDate(formatAd(bsToAd(2082, 4, 1)))).toBe('82/83')
  })
})
