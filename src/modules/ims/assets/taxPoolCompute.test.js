import { bsToAd } from '../../../utils/bsCalendar'
import {
  acquisitionProrationTier, computePoolMovement, computeRepairCapCheck, computeIntangibleAmortization,
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
