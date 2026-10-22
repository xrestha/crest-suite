import { buildExecutiveSummary } from './reportNarrative'

const snap = (combined, extra = {}) => ({
  combined: { revenueTotal: 900000, foodCostBasis: 'cogs', ...combined },
  ims: { countGap: { material: false }, overheadTotal: 0, taxFeesTotal: 0 },
  ...extra,
})
const sentencesOf = t => t.split(/(?<=\.)\s+(?=[A-Z])/)

describe('the Executive Summary is at most three short sentences (S857)', () => {
  test('what the month made, what drove it, and what to look at', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: 38, laborCostPct: 26, primeCostPct: 64, netMarginPct: 12 }), 'Bhadra 2083')
    expect(sentencesOf(t)).toEqual([
      'In Bhadra 2083, revenue was NPR 9,00,000 and Net Margin was 12.0%.',
      'Food Cost was 38.0% of revenue, above your 35% target.',
      'Look at: Food Cost % and Prime Cost %.',
    ])
  })

  test('every figure within its band: Nothing needs attention', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: 30, laborCostPct: 25, primeCostPct: 55, netMarginPct: 22 }), 'Bhadra 2083')
    expect(t).toMatch(/Food Cost was 30\.0% of revenue, within your 35% target\. Nothing needs attention\.$/)
  })

  test('Look at names two things at most, the filled mark first', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: 50, laborCostPct: 34, primeCostPct: 84, netMarginPct: -2 }), 'Bhadra 2083')
    expect(t).toMatch(/Look at: Food Cost % and Prime Cost %\.$/)
  })

  test('labour driving the month is named, with how labour was found', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: 30, laborCostPct: 39, labour: { source: 'estimate', amount: 1 } }), 'Bhadra 2083')
    expect(t).toMatch(/Labor Cost was 39\.0% of revenue, well above the 37% line \(labour estimated: payroll was not finalized\)\./)
    expect(t).toMatch(/Look at: Labor Cost %\.$/)
  })
})

describe('the Executive Summary judges Food Cost on the client’s own thresholds (S849, OWNER-REPORT-5)', () => {
  test('30 / 40 at 33%: above your 30% target', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: 33 }), 'Bhadra 2083', { fcT: { warn: 30, critical: 40 } })
    expect(t).toMatch(/Food Cost was 33\.0% of revenue, above your 30% target\./)
    expect(t).toMatch(/Look at: Food Cost %\./)
    expect(t).not.toMatch(/healthy/)
  })

  test('38 / 48 at 37%: within your 38% target', () => {
    expect(buildExecutiveSummary(snap({ foodCostPct: 37 }), 'Bhadra 2083', { fcT: { warn: 38, critical: 48 } }))
      .toMatch(/within your 38% target\. Nothing needs attention\./)
  })

  test('above the critical line: well above it', () => {
    expect(buildExecutiveSummary(snap({ foodCostPct: 50 }), 'Bhadra 2083', { fcT: { warn: 35, critical: 45 } }))
      .toMatch(/well above your 45% line/)
  })

  test('−2.1%: not judged, Prime is not judged either, and the reader is sent to the count and the bills', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: -2.1, primeCostPct: 25, laborCostPct: 27.1 }), 'Bhadra 2083')
    expect(t).toMatch(/Food Cost was -2\.1% of revenue, not judged: a food cost at or below zero means a closing count or a purchase bill is missing\./)
    expect(t).toMatch(/Look at: the closing count and purchase bills\./)
    expect(t).not.toMatch(/Prime Cost|benchmark|Nothing needs attention/)
  })

  test('under 28% says nothing healthy about it', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: 18 }), 'Bhadra 2083')
    expect(t).toMatch(/Food Cost was 18\.0% of revenue\./)
    expect(t).toMatch(/Nothing is above its target\./)
    expect(t).not.toMatch(/within|healthy|Nothing needs attention/)
  })

  test('frozen thresholds win over today’s', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: 33, fcThresholds: { warn: 30, critical: 40 } }), 'Bhadra 2083', { fcT: { warn: 38, critical: 48 } })
    expect(t).toMatch(/above your 30% target/)
  })

  test('Prime at or under 60 is not something to look at', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: 30, primeCostPct: 58, laborCostPct: 28 }), 'Bhadra 2083')
    expect(t).not.toMatch(/Prime Cost/)
    expect(t).toMatch(/Nothing needs attention\./)
  })

  test('Prime between 60 and 65 is, with food and labour each inside their band', () => {
    expect(buildExecutiveSummary(snap({ foodCostPct: 33, primeCostPct: 63, laborCostPct: 30 }), 'Bhadra 2083'))
      .toMatch(/Look at: Prime Cost %\./)
  })

  test('a material count gap: no food verdict, and the count is what to look at', () => {
    const s = snap({ foodCostPct: 48, primeCostPct: 70, laborCostPct: 22, netMarginPct: 3 })
    s.ims.countGap = { material: true }
    const t = buildExecutiveSummary(s, 'Bhadra 2083')
    expect(t).toMatch(/Food Cost was 48\.0% of revenue, not judged, because the closing count is incomplete\./)
    expect(t).toMatch(/Look at: the closing count \(incomplete\)\./)
    expect(t).not.toMatch(/Prime Cost|Net Margin %|Nothing needs attention/)
  })

  test('a report on the older basis says Food Cost (on purchases)', () => {
    const t = buildExecutiveSummary(snap({ foodCostBasis: undefined, foodCostPct: 40 }), 'Bhadra 2083')
    expect(t).toMatch(/Food Cost \(on purchases\) was 40\.0% of revenue, above your 35% target\./)
    expect(t).toMatch(/Look at: Food Cost % \(on purchases\)\./)
  })
})

describe('the summary says how labour was found (S849, OWNER-REPORT-10 / -9)', () => {
  test('an estimated labour adds the clause to the margin', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: 30, primeCostPct: 58, laborCostPct: 28, netMarginPct: 12, labour: { source: 'estimate', amount: 1 } }), 'Bhadra 2083')
    expect(t).toMatch(/Net Margin was 12\.0% \(labour estimated: payroll was not finalized\)\./)
    // Said once.
    expect(t.match(/labour estimated/g)).toHaveLength(1)
  })

  test('a report made before v18 reads the HR section’s basis', () => {
    const t = buildExecutiveSummary({ ...snap({ foodCostPct: 30, primeCostPct: 58, laborCostPct: 28, netMarginPct: 21 }), hr: { payrollSource: 'estimated' } }, 'Bhadra 2083')
    expect(t).toMatch(/labour estimated/)
  })

  test('labour from the Labor tab is named; no labour entered is named on the margin', () => {
    expect(buildExecutiveSummary(snap({ foodCostPct: 30, primeCostPct: 46, laborCostPct: 16, netMarginPct: 22, labour: { source: 'overheads', amount: 1 } }), 'Bhadra 2083'))
      .toMatch(/labour from the Overheads Labor tab/)
    const t = buildExecutiveSummary(snap({ foodCostPct: 30, netMarginPct: 60, labour: { source: 'none', amount: 0 } }), 'Bhadra 2083')
    expect(t).toMatch(/Net Margin was 60\.0% \(no labour entered on Overheads\)/)
    expect(t).toMatch(/Nothing that could be judged needs attention\./)
  })

  test('labour with no pay set withholds the Prime verdict and points at Pay Setup', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: 30, primeCostPct: 66, laborCostPct: 36, labour: { source: 'estimate', amount: 1, reason: 'nopay', noPayCount: 2 } }), 'Bhadra 2083')
    expect(t).not.toMatch(/Prime Cost|benchmark/)
    expect(t).toMatch(/Look at: Pay Setup \(pay not set for 2 staff\)\./)
  })

  test('without Overheads on the plan, Net Margin has no verdict', () => {
    const t = buildExecutiveSummary(snap({ foodCostPct: 30, laborCostPct: 25, primeCostPct: 55, netMarginPct: 5 }), 'Bhadra 2083', { canOverheads: false })
    expect(t).not.toMatch(/Look at/)
    expect(t).toMatch(/Nothing that could be judged needs attention\./)
  })
})

describe('a negative margin names the costs it took off (S849, GAPS-1)', () => {
  test('wasted stock, staff meals and delivery commission are among the recorded costs', () => {
    const s = {
      combined: { revenueTotal: 100000, foodCostBasis: 'cogs', foodCostPct: 40, netMarginPct: -4.2, netMarginPnlCosts: true },
      ims: { countGap: { material: false }, overheadTotal: 20000, taxFeesTotal: 1000, cogsWastageTotal: 2000, staffMealsValueTotal: 3000 },
      deliveryCommission: { amount: 4000, unsettledBills: 0 },
    }
    const t = buildExecutiveSummary(s, 'Bhadra 2083')
    expect(t).toMatch(/Net Margin was -4\.2%, after NPR 30,000 of recorded overheads, fees, wasted stock, staff meals and delivery commission\./)
    expect(t).toMatch(/Look at: Net Margin % and Food Cost %\.$/)
  })

  test('a report made before v18 names only overheads and fees', () => {
    const s = {
      combined: { revenueTotal: 100000, foodCostBasis: 'cogs', foodCostPct: 40, netMarginPct: -4.2 },
      ims: { countGap: { material: false }, overheadTotal: 20000, taxFeesTotal: 1000, cogsWastageTotal: 2000 },
    }
    expect(buildExecutiveSummary(s, 'Bhadra 2083')).toMatch(/after NPR 21,000 of recorded overheads and fees\./)
  })
})
