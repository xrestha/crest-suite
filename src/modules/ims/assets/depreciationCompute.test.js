import {
  annualStraightLineAmount, proRatedAmount, clampToSalvageFloor,
  computeAssetDepreciationLine, computeDepreciationPreview,
  computeDisposalGainLoss, computePortfolioValuation,
  addDaysIso, effectiveDepreciation, bookPositionsByAsset, bookValue, computeDisposalDepreciation,
  regularOverrideError, adjustmentOverrideError, depreciationInWindow,
  assetHeldOn, computeValuationAsOf, depreciationInputChanges,
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
      asset, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    })
    expect(line.opening_nbv).toBe(120000)
    expect(line.annual_depreciation).toBe(20000)
    expect(line.depreciation_amount).toBeCloseTo(20000, 0)
    expect(line.closing_nbv).toBeCloseTo(100000, 0)
  })

  test('subsequent run: opens at the book value it is given', () => {
    const line = computeAssetDepreciationLine({
      asset, openingNbv: 100000, periodStart: '2027-01-01', periodEnd: '2027-12-31',
    })
    expect(line.opening_nbv).toBe(100000)
    expect(line.closing_nbv).toBeCloseTo(80000, 0)
  })

  test('stops at salvage value instead of going below', () => {
    const line = computeAssetDepreciationLine({
      asset, openingNbv: 21000, periodStart: '2030-01-01', periodEnd: '2030-12-31',
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
      assets, positions: {}, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    })
    expect(preview).toHaveLength(1)
    expect(preview[0].asset_id).toBe('a1')
  })

  test('opens each asset at cost less everything posted against it (S792)', () => {
    const assets = [{ id: 'a1', status: 'active', total_cost: 1000, salvage_value: 0, useful_life_years: 10, acquisition_date: '2020-01-01' }]
    const preview = computeDepreciationPreview({
      assets, positions: { a1: { charged: 300 } }, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    })
    expect(preview[0].opening_nbv).toBe(700)
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

// S792 (COSTS-2): book value follows every posting, in whatever order and for whatever period.
describe('bookPositionsByAsset / bookValue', () => {
  const asset = { id: 'a', total_cost: 100000 }
  // 10,000 a year; FY1 = 16 Jul 2024 - 15 Jul 2025, FY2 = 16 Jul 2025 - 15 Jul 2026
  const fy1 = { asset_id: 'a', period_start: '2024-07-16', period_end: '2025-07-15' }
  const fy2 = { asset_id: 'a', period_start: '2025-07-16', period_end: '2026-07-15' }
  const nbvOf = rows => bookValue(asset, bookPositionsByAsset(rows).a)

  test('nothing posted: full cost', () => {
    expect(bookPositionsByAsset([]).a).toBeUndefined()
    expect(nbvOf([])).toBe(100000)
  })

  test('reversing a run that is NOT the last by period end reaches the book value', () => {
    const rows = [
      { ...fy1, id: 'r1', created_at: '2025-07-20T00:00:00Z', depreciation_amount: 10000, override_amount: null, closing_nbv: 90000 },
      { ...fy2, id: 'r2', created_at: '2026-07-20T00:00:00Z', depreciation_amount: 10000, override_amount: null, closing_nbv: 80000 },
      // the reversal of FY1, posted last, opening from the then-current 80,000
      { ...fy1, id: 'r3', created_at: '2026-08-01T00:00:00Z', depreciation_amount: 0, override_amount: -10000, closing_nbv: 90000 },
    ]
    // The latest row by period end is FY2's (80,000); the write-back used to be lost behind it.
    expect(nbvOf(rows)).toBe(90000)
    expect(nbvOf([...rows].reverse())).toBe(90000)
    // FY1 is reversed in full, so only FY2's days still stand charged.
    expect(bookPositionsByAsset(rows).a.chargedThrough).toBe('2026-07-15')
  })

  test('a back-dated run posted after a later one counts', () => {
    const rows = [
      { ...fy2, id: 'r2', created_at: '2026-07-20T00:00:00Z', depreciation_amount: 10000, closing_nbv: 90000 },
      { ...fy1, id: 'r1', created_at: '2026-08-01T00:00:00Z', depreciation_amount: 10000, closing_nbv: 80000 },
    ]
    expect(nbvOf(rows)).toBe(80000)
  })

  test('a chain broken before S792 still gives cost less what was charged, not a stored closing figure', () => {
    // FY3 was opened from FY2's row (90,000) although FY1 had been back-dated in after it.
    const rows = [
      { ...fy2, id: 'r2', created_at: '2026-07-20T00:00:00Z', depreciation_amount: 10000, closing_nbv: 90000 },
      { ...fy1, id: 'r1', created_at: '2026-08-01T00:00:00Z', depreciation_amount: 10000, closing_nbv: 80000 },
      { asset_id: 'a', period_start: '2026-07-16', period_end: '2027-07-15', id: 'r4', created_at: '2027-07-20T00:00:00Z', depreciation_amount: 10000, closing_nbv: 80000 },
    ]
    expect(nbvOf(rows)).toBe(70000)
  })

  test('a partly reversed period still counts as charged; a zero charge with no reversal does too', () => {
    const partly = [
      { ...fy2, id: 'r2', depreciation_amount: 10000 },
      { ...fy2, id: 'r3', depreciation_amount: 0, override_amount: -4000 },
    ]
    expect(bookPositionsByAsset(partly).a).toEqual({ charged: 6000, rows: 2, chargedThrough: '2026-07-15' })
    const idle = [{ ...fy2, id: 'r2', depreciation_amount: 5000, override_amount: 0 }]
    expect(bookPositionsByAsset(idle).a.chargedThrough).toBe('2026-07-15')
  })

  test('as of a date: only periods ending by then, a later-posted reversal of an earlier period included', () => {
    const rows = [
      { ...fy1, id: 'r1', depreciation_amount: 10000 },
      { ...fy2, id: 'r2', depreciation_amount: 10000 },
      { ...fy1, id: 'r3', depreciation_amount: 0, override_amount: -10000 },
    ]
    expect(bookValue(asset, bookPositionsByAsset(rows, '2025-07-15').a)).toBe(100000)
    expect(bookValue(asset, bookPositionsByAsset(rows, '2026-07-15').a)).toBe(90000)
    expect(bookPositionsByAsset(rows, '2024-07-15').a).toBeUndefined()
  })
})

describe('computeDisposalDepreciation (D24)', () => {
  const asset = { id: 'a1', total_cost: 36500 * 5 + 1000, salvage_value: 1000, useful_life_years: 5, acquisition_date: '2020-01-01' }
  // annual = 36500, i.e. exactly 100 a day
  const at = (chargedThrough, nbv) => ({ charged: asset.total_cost - nbv, chargedThrough })

  test('charges straight-line from the day after the last posted run to the disposal date', () => {
    const r = computeDisposalDepreciation({
      asset, position: at('2026-01-31', 50000), disposalDate: '2026-02-10',
    })
    expect(r.periodStart).toBe('2026-02-01')
    expect(r.extraDepreciation).toBeCloseTo(1000, 2) // 10 days × 100
    expect(r.nbvAtDisposal).toBeCloseTo(49000, 2)
    expect(r.line.opening_nbv).toBe(50000)
    expect(r.postedPastDisposal).toBe(false)
  })

  test('never posted: runs from the acquisition date, opening at cost', () => {
    const fresh = { ...asset, acquisition_date: '2026-03-01' }
    const r = computeDisposalDepreciation({ asset: fresh, position: null, disposalDate: '2026-03-05' })
    expect(r.periodStart).toBe('2026-03-01')
    expect(r.extraDepreciation).toBeCloseTo(500, 2)
  })

  test('stops at the salvage floor', () => {
    const r = computeDisposalDepreciation({
      asset, position: at('2026-01-31', 1300), disposalDate: '2026-02-28',
    })
    expect(r.nbvAtDisposal).toBe(1000)
    expect(r.extraDepreciation).toBe(300)
  })

  test('nothing to charge when a posted run already covers the disposal date — and says so', () => {
    const r = computeDisposalDepreciation({
      asset, position: at('2026-07-15', 40000), disposalDate: '2026-03-01',
    })
    expect(r.line).toBeNull()
    expect(r.nbvAtDisposal).toBe(40000)
    expect(r.postedPastDisposal).toBe(true)
    expect(r.chargedThrough).toBe('2026-07-15')
  })

  test('disposal on the last posted day itself charges nothing and is not "past"', () => {
    const r = computeDisposalDepreciation({
      asset, position: at('2026-07-15', 40000), disposalDate: '2026-07-15',
    })
    expect(r.line).toBeNull()
    expect(r.postedPastDisposal).toBe(false)
  })

  // COSTS-2 (a): the D24 advice, end to end from posted rows. Bought 17 Jul 2025, one annual run to
  // 16 Jul 2026 (36,500), disposed 15 Jan 2026: 183 days held, 18,300 owed.
  describe('reverse the run that reaches past the disposal date, then dispose', () => {
    const fridge = { ...asset, acquisition_date: '2025-07-17' }
    const period = { asset_id: 'a1', period_start: '2025-07-17', period_end: '2026-07-16' }
    const runA = { ...period, id: 'rA', created_at: '2026-07-20T00:00:00Z', depreciation_amount: 36500, override_amount: null, closing_nbv: 147000 }
    const reversal = { ...period, id: 'rAdj', created_at: '2026-08-01T00:00:00Z', depreciation_amount: 0, override_amount: -36500, closing_nbv: 183500 }
    const dispose = rows => computeDisposalDepreciation({ asset: fridge, position: bookPositionsByAsset(rows).a1, disposalDate: '2026-01-15' })

    test('before the reversal: nothing more to charge, and the page must warn', () => {
      const r = dispose([runA])
      expect(r.line).toBeNull()
      expect(r.postedPastDisposal).toBe(true)
      expect(r.nbvAtDisposal).toBe(147000)
    })

    test('after the reversal: the held days are charged and the gain or loss is struck against them', () => {
      const r = dispose([runA, reversal])
      expect(r.postedPastDisposal).toBe(false)
      expect(r.periodStart).toBe('2025-07-17')
      expect(r.extraDepreciation).toBeCloseTo(18300, 2)
      expect(r.line.opening_nbv).toBe(183500)
      expect(r.nbvAtDisposal).toBeCloseTo(165200, 2)
      expect(computeDisposalGainLoss({ closingNbvAtDisposal: r.nbvAtDisposal, disposalProceeds: 170000 })).toBeCloseTo(4800, 2)
    })

    test('after the reversal and the right figures posted as a normal run: nothing charged twice', () => {
      const runB = { asset_id: 'a1', period_start: '2025-07-17', period_end: '2026-01-15', id: 'rB', created_at: '2026-08-02T00:00:00Z', depreciation_amount: 18300, override_amount: null, closing_nbv: 165200 }
      const r = dispose([runA, reversal, runB])
      expect(r.line).toBeNull()
      expect(r.postedPastDisposal).toBe(false)
      expect(r.nbvAtDisposal).toBe(165200)
    })
  })
})

// S792 (COSTS-4): the valuation as of a past date keeps an asset disposed after it.
describe('assetHeldOn / computeValuationAsOf', () => {
  const cat = name => ({ assets_categories: { name } })
  const assets = [
    { id: 'A', status: 'active', acquisition_date: '2024-01-01', total_cost: 100000, personal_use_percent: 0, ...cat('Kitchen') },
    { id: 'B', status: 'disposed', disposal_date: '2026-01-10', acquisition_date: '2024-01-01', total_cost: 50000, personal_use_percent: 0, ...cat('Kitchen') },
    { id: 'C', status: 'written_off', disposal_date: '2025-03-01', acquisition_date: '2024-01-01', total_cost: 20000, personal_use_percent: 0, ...cat('Furniture') },
    { id: 'D', status: 'active', acquisition_date: '2025-12-01', total_cost: 30000, personal_use_percent: 0, ...cat('Furniture') },
    { id: 'E', status: 'active', acquisition_date: '2024-01-01', total_cost: 40000, personal_use_percent: 20, ...cat('Furniture') },
  ]
  const rows = [
    { asset_id: 'A', period_start: '2024-07-16', period_end: '2025-07-15', depreciation_amount: 10000 },
    { asset_id: 'B', period_start: '2024-07-16', period_end: '2025-07-15', depreciation_amount: 5000 },
    { asset_id: 'B', period_start: '2025-07-16', period_end: '2026-01-10', depreciation_amount: 2000 },
    { asset_id: 'A', period_start: '2025-07-16', period_end: '2026-07-15', depreciation_amount: 10000 },
  ]

  test('held: acquired by the date and not yet gone', () => {
    expect(assetHeldOn(assets[1], '2025-07-15')).toBe(true)   // disposed later
    expect(assetHeldOn(assets[1], '2026-01-10')).toBe(false)  // gone by the end of its disposal day
    expect(assetHeldOn(assets[2], '2025-07-15')).toBe(false)  // written off before
    expect(assetHeldOn(assets[3], '2025-07-15')).toBe(false)  // not yet bought
    expect(assetHeldOn({ status: 'disposed', disposal_date: null, acquisition_date: '2024-01-01' }, '2025-07-15')).toBe(false)
  })

  test('FY-end valuation keeps the asset sold after it, at its book value on that date', () => {
    const v = computeValuationAsOf({ assets, postedRows: rows, asOf: '2025-07-15' })
    expect(v.totalCost).toBe(150000)
    expect(v.nbv).toBe(135000)
    expect(v.accumulatedDepreciation).toBe(15000)
    expect(v.byCategory).toEqual([{ categoryName: 'Kitchen', totalCost: 150000, nbv: 135000, accumulatedDepreciation: 15000 }])
  })

  test('a year later the sold asset is gone and the newer purchase is in', () => {
    const v = computeValuationAsOf({ assets, postedRows: rows, asOf: '2026-07-15' })
    expect(v.totalCost).toBe(130000)
    expect(v.nbv).toBe(110000)
  })
})

// S792 (COSTS-8): which depreciation inputs an asset edit moves.
describe('depreciationInputChanges', () => {
  const asset = { total_cost: 100000, quantity: 1, unit_cost: 100000, salvage_value: 0, useful_life_years: 5, acquisition_date: '2024-01-01' }
  const same = { quantity: 1, unit_cost: 100000, salvage_value: 0, useful_life_years: 5, acquisition_date: '2024-01-01' }

  test('an edit that leaves every depreciation input alone is not a change', () => {
    expect(depreciationInputChanges(asset, { ...same, name: 'Renamed' })).toBeNull()
  })

  test('a cost edit names both costs and both annual charges', () => {
    expect(depreciationInputChanges(asset, { ...same, unit_cost: 120000 })).toEqual({
      cost: { from: 100000, to: 120000 }, annual: { from: 20000, to: 24000 },
    })
  })

  test('a date, life or salvage edit is named on its own', () => {
    const c = depreciationInputChanges(asset, { ...same, acquisition_date: '2024-02-01', useful_life_years: 4, salvage_value: 20000 })
    expect(c.acquired).toEqual({ from: '2024-01-01', to: '2024-02-01' })
    expect(c.life).toEqual({ from: 5, to: 4 })
    expect(c.salvage).toEqual({ from: 0, to: 20000 })
    expect(c.cost).toBeUndefined()
    expect(c.annual).toEqual({ from: 20000, to: 20000 })
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
