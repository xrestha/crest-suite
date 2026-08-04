import {
  annualStraightLineAmount, proRatedAmount, clampToSalvageFloor,
  computeAssetDepreciationLine, computeDepreciationPreview,
  computeDisposalGainLoss, computePortfolioValuation,
} from './depreciationCompute'

describe('annualStraightLineAmount', () => {
  test('(cost - salvage) / life', () => {
    expect(annualStraightLineAmount({ totalCost: 120000, salvageValue: 20000, usefulLifeYears: 5 })).toBe(20000)
  })

  test('never negative even if salvage exceeds cost', () => {
    expect(annualStraightLineAmount({ totalCost: 1000, salvageValue: 5000, usefulLifeYears: 5 })).toBe(0)
  })

  test('0 if useful life is 0 or missing', () => {
    expect(annualStraightLineAmount({ totalCost: 1000, salvageValue: 0, usefulLifeYears: 0 })).toBe(0)
  })
})

describe('proRatedAmount', () => {
  test('acquired before period start: full period charge', () => {
    const amt = proRatedAmount({
      annualAmount: 36500, periodStart: '2026-01-01', periodEnd: '2026-12-31', acquisitionDate: '2025-01-01',
    })
    // 365-day period, annualAmount already annual -> full amount
    expect(amt).toBeCloseTo(36500, 0)
  })

  test('acquired exactly on period start: still full period charge', () => {
    const amt = proRatedAmount({
      annualAmount: 36500, periodStart: '2026-01-01', periodEnd: '2026-12-31', acquisitionDate: '2026-01-01',
    })
    expect(amt).toBeCloseTo(36500, 0)
  })

  test('acquired mid-period: prorated by days held', () => {
    // Acquired exactly halfway through a 365-day period (day 183 of 365, 183 days held incl. acq day)
    const amt = proRatedAmount({
      annualAmount: 36500, periodStart: '2026-01-01', periodEnd: '2026-12-31', acquisitionDate: '2026-07-02',
    })
    // July 2 is day 183 of 365 (Jan1=day1) -> held days = 365-183+1 = 183
    expect(amt).toBeCloseTo(36500 * (183 / 365), 1)
  })

  test('acquired after period end: 0', () => {
    const amt = proRatedAmount({
      annualAmount: 36500, periodStart: '2026-01-01', periodEnd: '2026-12-31', acquisitionDate: '2027-01-01',
    })
    expect(amt).toBe(0)
  })
})

describe('clampToSalvageFloor', () => {
  test('lets a normal charge through unchanged', () => {
    expect(clampToSalvageFloor({ openingNbv: 10000, proposedCharge: 2000, salvageValue: 1000 })).toBe(2000)
  })

  test('clamps a charge that would dip below salvage value', () => {
    expect(clampToSalvageFloor({ openingNbv: 2500, proposedCharge: 2000, salvageValue: 1000 })).toBe(1500)
  })

  test('returns 0, not negative, once already at salvage value', () => {
    expect(clampToSalvageFloor({ openingNbv: 1000, proposedCharge: 500, salvageValue: 1000 })).toBe(0)
  })
})

describe('computeAssetDepreciationLine', () => {
  const asset = {
    id: 'a1', total_cost: 120000, salvage_value: 20000, useful_life_years: 5,
    acquisition_date: '2020-01-01',
  }

  test('first run: opening NBV falls back to total_cost', () => {
    const line = computeAssetDepreciationLine({
      asset, priorSchedule: null, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    })
    expect(line.opening_nbv).toBe(120000)
    expect(line.annual_depreciation).toBe(20000)
    expect(line.depreciation_amount).toBeCloseTo(20000, 0)
    expect(line.closing_nbv).toBeCloseTo(100000, 0)
  })

  test('subsequent run: opening NBV carries from prior posted schedule row', () => {
    const line = computeAssetDepreciationLine({
      asset, priorSchedule: { closing_nbv: 100000 }, periodStart: '2027-01-01', periodEnd: '2027-12-31',
    })
    expect(line.opening_nbv).toBe(100000)
    expect(line.closing_nbv).toBeCloseTo(80000, 0)
  })

  test('stops at salvage value instead of going below', () => {
    const line = computeAssetDepreciationLine({
      asset, priorSchedule: { closing_nbv: 21000 }, periodStart: '2030-01-01', periodEnd: '2030-12-31',
    })
    expect(line.depreciation_amount).toBeCloseTo(1000, 0) // only enough to reach salvage
    expect(line.closing_nbv).toBeCloseTo(20000, 0)
  })
})

describe('computeDepreciationPreview', () => {
  test('excludes disposed/written_off assets', () => {
    const assets = [
      { id: 'a1', status: 'active', total_cost: 1000, salvage_value: 0, useful_life_years: 10, acquisition_date: '2020-01-01' },
      { id: 'a2', status: 'disposed', total_cost: 1000, salvage_value: 0, useful_life_years: 10, acquisition_date: '2020-01-01' },
    ]
    const preview = computeDepreciationPreview({
      assets, priorScheduleByAssetId: {}, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    })
    expect(preview).toHaveLength(1)
    expect(preview[0].asset_id).toBe('a1')
  })
})

describe('computeDisposalGainLoss', () => {
  test('positive when proceeds exceed NBV (gain)', () => {
    expect(computeDisposalGainLoss({ closingNbvAtDisposal: 5000, disposalProceeds: 7000 })).toBe(2000)
  })

  test('negative when proceeds are below NBV (loss)', () => {
    expect(computeDisposalGainLoss({ closingNbvAtDisposal: 7000, disposalProceeds: 5000 })).toBe(-2000)
  })
})

describe('computePortfolioValuation', () => {
  test('sums cost/NBV across rows and breaks down by category', () => {
    const rows = [
      { categoryName: 'Kitchen Equipment', totalCost: 100000, nbv: 60000 },
      { categoryName: 'Kitchen Equipment', totalCost: 50000, nbv: 40000 },
      { categoryName: 'Furniture', totalCost: 20000, nbv: 15000 },
    ]
    const result = computePortfolioValuation(rows)
    expect(result.totalCost).toBe(170000)
    expect(result.nbv).toBe(115000)
    expect(result.accumulatedDepreciation).toBe(55000)
    expect(result.byCategory).toEqual(expect.arrayContaining([
      expect.objectContaining({ categoryName: 'Kitchen Equipment', totalCost: 150000, nbv: 100000, accumulatedDepreciation: 50000 }),
      expect.objectContaining({ categoryName: 'Furniture', totalCost: 20000, nbv: 15000, accumulatedDepreciation: 5000 }),
    ]))
  })

  test('uncategorized falls back to a placeholder bucket', () => {
    const result = computePortfolioValuation([{ categoryName: null, totalCost: 100, nbv: 80 }])
    expect(result.byCategory[0].categoryName).toBe('Uncategorized')
  })
})
