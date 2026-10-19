import { buildExecutiveSummary } from './reportNarrative'

const snap = (combined, extra = {}) => ({
  combined: { revenueTotal: 900000, foodCostBasis: 'cogs', ...combined },
  ims: { countGap: { material: false }, overheadTotal: 0, taxFeesTotal: 0 },
  ...extra,
})

describe('the Executive Summary judges Food Cost on the client’s own thresholds (S849, OWNER-REPORT-5)', () => {
  test('30 / 40 at 33%: above your 30% target', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: 33 }), 'Bhadra 2083', { fcT: { warn: 30, critical: 40 } })
    expect(t).toMatch(/a Food Cost of 33\.0% — above your 30% target/)
    expect(t).not.toMatch(/healthy/)
  })

  test('38 / 48 at 37%: within your 38% target', () => {
    expect(buildExecutiveSummary(snap({ foodCostPct: 37 }), 'Bhadra 2083', { fcT: { warn: 38, critical: 48 } }))
      .toMatch(/within your 38% target/)
  })

  test('above the critical line: well above it', () => {
    expect(buildExecutiveSummary(snap({ foodCostPct: 50 }), 'Bhadra 2083', { fcT: { warn: 35, critical: 45 } }))
      .toMatch(/well above your 45% line/)
  })

  test('−2.1%: not judged, and the prime clause carries no benchmark word', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: -2.1, primeCostPct: 25, laborCostPct: 27.1 }), 'Bhadra 2083')
    expect(t).toMatch(/not judged: a food cost at or below zero means a closing count or a purchase bill is missing/)
    expect(t).not.toMatch(/benchmark/)
  })

  test('under 28% says nothing healthy about it', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: 18 }), 'Bhadra 2083')
    expect(t).toMatch(/a Food Cost of 18\.0%\./)
    expect(t).not.toMatch(/within|healthy/)
  })

  test('frozen thresholds win over today’s', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: 33, fcThresholds: { warn: 30, critical: 40 } }), 'Bhadra 2083', { fcT: { warn: 38, critical: 48 } })
    expect(t).toMatch(/above your 30% target/)
  })

  test('Prime at or under 60 reads below the benchmark', () => {
    expect(buildExecutiveSummary(snap({ foodCostPct: 30, primeCostPct: 58, laborCostPct: 28 }), 'Bhadra 2083'))
      .toMatch(/a Prime Cost of 58\.0%, below the 60–65% benchmark/)
  })
})

describe('the summary says how labour was found (S849, OWNER-REPORT-10 / -9)', () => {
  test('an estimated labour adds the clause', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: 30, primeCostPct: 58, laborCostPct: 28, netMarginPct: 12, labour: { source: 'estimate', amount: 1 } }), 'Bhadra 2083')
    expect(t).toMatch(/\(labour estimated: payroll was not finalized\)/)
  })

  test('a report made before v18 reads the HR section’s basis', () => {
    const t = buildExecutiveSummary({ ...snap({ foodCostPct: 30, primeCostPct: 58, laborCostPct: 28 }), hr: { payrollSource: 'estimated' } }, 'Bhadra 2083')
    expect(t).toMatch(/labour estimated/)
  })

  test('labour from the Labor tab is named; no labour entered is named on the margin', () => {
    expect(buildExecutiveSummary(snap({ foodCostPct: 30, primeCostPct: 46, laborCostPct: 16, labour: { source: 'overheads', amount: 1 } }), 'Bhadra 2083'))
      .toMatch(/labour from the Overheads Labor tab/)
    expect(buildExecutiveSummary(snap({ foodCostPct: 30, netMarginPct: 60, labour: { source: 'none', amount: 0 } }), 'Bhadra 2083'))
      .toMatch(/Net Margin was 60\.0% \(no labour entered on Overheads\)/)
  })

  test('labour with no pay set withholds the prime verdict', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: 30, primeCostPct: 50, laborCostPct: 20, labour: { source: 'estimate', amount: 1, reason: 'nopay' } }), 'Bhadra 2083')
    expect(t).not.toMatch(/benchmark/)
  })
})

describe('a negative margin names the costs it took off (S849, GAPS-1)', () => {
  test('wasted stock, staff meals and delivery commission are among the recorded costs', () => {
    const s = {
      combined: { revenueTotal: 100000, foodCostBasis: 'cogs', foodCostPct: 40, netMarginPct: -4.2, netMarginPnlCosts: true },
      ims: { countGap: { material: false }, overheadTotal: 20000, taxFeesTotal: 1000, cogsWastageTotal: 2000, staffMealsValueTotal: 3000 },
      deliveryCommission: { amount: 4000, unsettledBills: 0 },
    }
    expect(buildExecutiveSummary(s, 'Bhadra 2083'))
      .toMatch(/Net Margin was -4\.2%, after NPR 30,000 of recorded overheads, fees, wasted stock, staff meals and delivery commission\./)
  })

  test('a report made before v18 names only overheads and fees', () => {
    const s = {
      combined: { revenueTotal: 100000, foodCostBasis: 'cogs', foodCostPct: 40, netMarginPct: -4.2 },
      ims: { countGap: { material: false }, overheadTotal: 20000, taxFeesTotal: 1000, cogsWastageTotal: 2000 },
    }
    expect(buildExecutiveSummary(s, 'Bhadra 2083')).toMatch(/after NPR 21,000 of recorded overheads and fees\./)
  })
})
