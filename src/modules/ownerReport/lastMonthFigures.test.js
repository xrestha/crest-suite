// The Financial Summary's Last month column (S857): last month as this report froze it, and a dash
// with its reason wherever the Trend section would not compare the two months either.
jest.mock('../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }))
jest.mock('../../shared/scopedDb', () => ({ scopedFrom: jest.fn() }))

// eslint-disable-next-line import/first
import { lastMonthFigures } from './lastMonthFigures'
// eslint-disable-next-line import/first
import { priorFailedSections } from './sectionNames'
// eslint-disable-next-line import/first
import { trendSnapshotOf } from './computeMonthlyReport'

const V19 = { foodCostBasis: 'cogs', netMarginTaxFees: true, labourBasis: 'earned', netMarginPnlCosts: true }
const figures = { revenueTotal: 800000, foodCostPct: 31.5, laborCostPct: 27, primeCostPct: 58.5, netMarginPct: 14.2 }

const report = (priorCombined, entry = {}) => ({
  combined: { ...V19, revenueTotal: 900000, foodCostPct: 33 },
  trend: {
    vsLastPeriod: {
      available: true, reason: null, period: { bs_year: 2083, bs_month: 4 },
      snapshot: trendSnapshotOf({ combined: priorCombined }),
      ...entry,
    },
  },
})

describe('lastMonthFigures', () => {
  test('a prior on the same basis: every figure as frozen, with its month', () => {
    const lm = lastMonthFigures(report({ ...V19, ...figures }))
    expect(lm.available).toBe(true)
    expect(lm.label).toBe('Shrawan 2083')
    expect(lm.rows.revenue).toEqual({ value: 800000, why: null, changed: false })
    expect(lm.rows.foodCost.value).toBe(31.5)
    expect(lm.rows.labour.value).toBe(27)
    expect(lm.rows.prime.value).toBe(58.5)
    expect(lm.rows.netMargin.value).toBe(14.2)
  })

  test('food cost on purchases last month: Food, Prime and Net Margin are dashes, revenue and labour stay', () => {
    const { foodCostBasis, ...older } = V19
    const lm = lastMonthFigures(report({ ...older, ...figures }))
    expect(lm.rows.revenue.value).toBe(800000)
    expect(lm.rows.labour.value).toBe(27)
    for (const k of ['foodCost', 'prime', 'netMargin']) {
      expect(lm.rows[k].value).toBeNull()
      expect(lm.rows[k].changed).toBe(true)
      expect(lm.rows[k].why).toMatch(/^Not compared: Crest changed how this figure is worked out between Shrawan 2083 and this month/)
    }
  })

  test('labour counted another way: Labour, Prime and Net Margin are dashes', () => {
    const { labourBasis, ...older } = V19
    const lm = lastMonthFigures(report({ ...older, ...figures }))
    expect(lm.rows.foodCost.value).toBe(31.5)
    expect(['labour', 'prime', 'netMargin'].map(k => lm.rows[k].changed)).toEqual([true, true, true])
  })

  test('Net Margin alone across the Tax & Fees and P&L-costs lines', () => {
    const { netMarginTaxFees, ...noFees } = V19
    expect(lastMonthFigures(report({ ...noFees, ...figures })).rows.netMargin.changed).toBe(true)
    expect(lastMonthFigures(report({ ...noFees, ...figures })).rows.prime.changed).toBe(false)
    const { netMarginPnlCosts, ...noPnl } = V19
    const lm = lastMonthFigures(report({ ...noPnl, ...figures }))
    expect(lm.rows.netMargin.changed).toBe(true)
    expect(lm.rows.foodCost.value).toBe(31.5)
  })

  test('a prior without its Crest IMS section: the food-bearing figures are not compared', () => {
    const r = report({ ...V19, ...figures })
    r.trend.vsLastPeriod.snapshot.sectionErrors = ['ims']
    const lm = lastMonthFigures(r)
    expect(lm.rows.foodCost.why).toBe('Not compared: the Shrawan 2083 report is missing its Crest IMS section.')
    expect(lm.rows.revenue.value).toBe(800000)
    expect(lm.rows.labour.value).toBe(27)
  })

  test('a figure last month did not have is a dash that says so', () => {
    const lm = lastMonthFigures(report({ ...V19, revenueTotal: 800000 }))
    expect(lm.rows.labour).toEqual({ value: null, why: 'The Shrawan 2083 report has no figure for this.', changed: false })
  })

  test('no report for last month: the whole column says why', () => {
    const lm = lastMonthFigures(report(null, { available: false, reason: 'no_report', snapshot: null }))
    expect(lm.available).toBe(false)
    expect(lm.rows).toEqual({})
    expect(lm.why).toMatch(/Shrawan 2083/)
  })

  test('a report with no Trend section at all', () => {
    expect(lastMonthFigures({ combined: V19 }).why).toBe('This report was made without a comparison with last month.')
    expect(lastMonthFigures({ combined: V19, sectionErrors: { trend: 'boom' } }).why)
      .toBe('The comparison with last month could not be worked out when this report was made.')
  })

  test('the failed sections of a prior, in either stored shape', () => {
    expect(priorFailedSections({ sectionErrors: ['ims'] })).toEqual(['ims'])
    expect(priorFailedSections({ sectionErrors: { ims: 'x', pos: 'y' } })).toEqual(['ims', 'pos'])
    expect(priorFailedSections({ sectionErrors: null })).toEqual([])
    expect(priorFailedSections(null)).toEqual([])
  })
})
