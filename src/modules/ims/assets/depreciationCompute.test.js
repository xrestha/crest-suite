import {
  annualStraightLineAmount, proRatedAmount, clampToSalvageFloor,
  computeAssetDepreciationLine, computeDepreciationPreview,
  computeDisposalGainLoss, computePortfolioValuation,
  addDaysIso, effectiveDepreciation, latestPostedByAsset, computeDisposalDepreciation,
  regularOverrideError, adjustmentOverrideError, depreciationInWindow,
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

describe('addDaysIso', () => {
  test('crosses a month and a year boundary in UTC', () => {
    expect(addDaysIso('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('effectiveDepreciation', () => {
  test('an override wins, including a negative (adjustment) one', () => {
    expect(effectiveDepreciation({ depreciation_amount: 500, override_amount: null })).toBe(500)
    expect(effectiveDepreciation({ depreciation_amount: 500, override_amount: 200 })).toBe(200)
    expect(effectiveDepreciation({ depreciation_amount: 0, override_amount: -500 })).toBe(-500)
  })
})

describe('latestPostedByAsset', () => {
  test('an adjustment run sharing its period_end wins by created_at, whatever order the rows arrive in', () => {
    const run = { id: 'r1', asset_id: 'a', period_end: '2026-07-15', created_at: '2026-07-20T00:00:00Z', closing_nbv: 80000 }
    const reversal = { id: 'r2', asset_id: 'a', period_end: '2026-07-15', created_at: '2026-08-01T00:00:00Z', closing_nbv: 100000 }
    expect(latestPostedByAsset([reversal, run]).a.closing_nbv).toBe(100000)
    expect(latestPostedByAsset([run, reversal]).a.closing_nbv).toBe(100000)
  })
})

describe('computeDisposalDepreciation (D24)', () => {
  const asset = { id: 'a1', total_cost: 36500 * 5 + 1000, salvage_value: 1000, useful_life_years: 5, acquisition_date: '2020-01-01' }
  // annual = 36500, i.e. exactly 100 a day

  test('charges straight-line from the day after the last posted run to the disposal date', () => {
    const r = computeDisposalDepreciation({
      asset, lastPosted: { period_end: '2026-01-31', closing_nbv: 50000 }, disposalDate: '2026-02-10',
    })
    expect(r.periodStart).toBe('2026-02-01')
    expect(r.extraDepreciation).toBeCloseTo(1000, 2) // 10 days × 100
    expect(r.nbvAtDisposal).toBeCloseTo(49000, 2)
    expect(r.line.opening_nbv).toBe(50000)
    expect(r.postedPastDisposal).toBe(false)
  })

  test('never posted: runs from the acquisition date, opening at cost', () => {
    const fresh = { ...asset, acquisition_date: '2026-03-01' }
    const r = computeDisposalDepreciation({ asset: fresh, lastPosted: null, disposalDate: '2026-03-05' })
    expect(r.periodStart).toBe('2026-03-01')
    expect(r.extraDepreciation).toBeCloseTo(500, 2)
  })

  test('stops at the salvage floor', () => {
    const r = computeDisposalDepreciation({
      asset, lastPosted: { period_end: '2026-01-31', closing_nbv: 1300 }, disposalDate: '2026-02-28',
    })
    expect(r.nbvAtDisposal).toBe(1000)
    expect(r.extraDepreciation).toBe(300)
  })

  test('nothing to charge when a posted run already covers the disposal date — and says so', () => {
    const r = computeDisposalDepreciation({
      asset, lastPosted: { period_end: '2026-07-15', closing_nbv: 40000 }, disposalDate: '2026-03-01',
    })
    expect(r.line).toBeNull()
    expect(r.nbvAtDisposal).toBe(40000)
    expect(r.postedPastDisposal).toBe(true)
  })

  test('disposal on the last posted day itself charges nothing and is not "past"', () => {
    const r = computeDisposalDepreciation({
      asset, lastPosted: { period_end: '2026-07-15', closing_nbv: 40000 }, disposalDate: '2026-07-15',
    })
    expect(r.line).toBeNull()
    expect(r.postedPastDisposal).toBe(false)
  })
})

describe('override bounds', () => {
  test('regular: 0 to opening NBV minus salvage, blank allowed', () => {
    expect(regularOverrideError({ override: '', openingNbv: 5000, salvageValue: 1000 })).toBe('')
    expect(regularOverrideError({ override: 4000, openingNbv: 5000, salvageValue: 1000 })).toBe('')
    expect(regularOverrideError({ override: 0, openingNbv: 5000, salvageValue: 1000 })).toBe('')
    expect(regularOverrideError({ override: 4001, openingNbv: 5000, salvageValue: 1000 })).toMatch(/salvage/)
    expect(regularOverrideError({ override: -1, openingNbv: 5000, salvageValue: 1000 })).toMatch(/adjustment run/)
  })

  test('adjustment: between minus what the reversed line charged and 0', () => {
    expect(adjustmentOverrideError({ override: -500, charged: 500 })).toBe('')
    expect(adjustmentOverrideError({ override: -200, charged: 500 })).toBe('')
    expect(adjustmentOverrideError({ override: 0, charged: 500 })).toBe('')
    expect(adjustmentOverrideError({ override: -501, charged: 500 })).toMatch(/cannot undo more/)
    expect(adjustmentOverrideError({ override: 10, charged: 500 })).toMatch(/cannot undo more/)
    expect(adjustmentOverrideError({ override: '', charged: 500 })).not.toBe('')
  })
})

describe('depreciationInWindow (D23 memo)', () => {
  test('a run inside the window counts whole', () => {
    const r = depreciationInWindow([{ period_start: '2026-08-01', period_end: '2026-08-10', depreciation_amount: 700 }], '2026-07-17', '2026-08-16')
    expect(r).toEqual({ amount: 700, count: 1, prorated: false })
  })

  test('an annual run is pro-rated by the days that fall in the month', () => {
    const r = depreciationInWindow([{ period_start: '2026-01-01', period_end: '2026-12-31', depreciation_amount: 36500 }], '2026-02-01', '2026-02-28')
    expect(r.amount).toBeCloseTo(2800, 2)
    expect(r.prorated).toBe(true)
  })

  test('an adjustment nets off the run it reverses, and a run outside the window is ignored', () => {
    const rows = [
      { period_start: '2026-08-01', period_end: '2026-08-31', depreciation_amount: 900 },
      { period_start: '2026-08-01', period_end: '2026-08-31', depreciation_amount: 0, override_amount: -900 },
      { period_start: '2026-10-01', period_end: '2026-10-31', depreciation_amount: 900 },
    ]
    expect(depreciationInWindow(rows, '2026-08-01', '2026-08-31')).toEqual({ amount: 0, count: 2, prorated: false })
  })
})
