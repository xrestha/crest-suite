import {
  SETTLE_DAY, rowFigure, ratioPair, rowCostRatio, groupRatioOf, costBandWithheld,
  rowLabourPct, labourWithheld, labourBandWithheld, revenueChange, rankMarks,
  closedWithoutCount, rowCostWithheld, groupCostVerdict, coverageHeadline,
} from './groupVerdicts'
import { mtdClock } from '../../modules/dashboard/mtdClock'

// Kartik 2083 (a 30-day month in the BS table) — the clock is built from a fixed "today".
const PERIOD = { bs_year: 2083, bs_month: 7 }
const today = day => ({ year: 2083, month: 7, day })
const running = day => mtdClock(PERIOD, today(day))
const past = mtdClock(PERIOD, { year: 2083, month: 8, day: 5 })

const open = (extra = {}) => ({
  client_id: 'a', client_name: 'Bloom Cafe', is_included: true, has_period: true, period_status: 'open',
  revenue: 120000, net_purchases: 60000, revenue_counted: 100000, net_purchases_counted: 40000, covers: 300,
  ...extra,
})

describe('rowFigure (DOCS-9)', () => {
  test('a no-period row is a dash in money columns but keeps its covers', () => {
    const r = open({ has_period: false, revenue: 0, net_purchases: 0, covers: 12 })
    expect(rowFigure(r, 'revenue')).toBeNull()
    expect(rowFigure(r, 'net_purchases')).toBeNull()
    expect(rowFigure(r, 'covers')).toBe(12)
  })
  test('an excluded outlet is a dash everywhere', () => {
    expect(rowFigure(open({ is_included: false }), 'covers')).toBeNull()
  })
  test('an included row with a period shows its figure', () => {
    expect(rowFigure(open(), 'revenue')).toBe(120000)
  })
})

describe('ratios on the counted pair (GROUP-4)', () => {
  test('the running month divides the finished days; a past month the whole month', () => {
    expect(ratioPair(open(), running(12))).toEqual({ revenue: 100000, netPurchases: 40000 })
    expect(ratioPair(open(), past)).toEqual({ revenue: 120000, netPurchases: 60000 })
    expect(rowCostRatio(open(), running(12)).pct).toBeCloseTo(40)
    expect(rowCostRatio(open(), past).pct).toBeCloseTo(50)
  })
  test('day 1 has no finished day: every Spend % is a dash', () => {
    const c = running(1)
    expect(c.firstDay).toBe(true)
    expect(rowCostRatio(open({ revenue_counted: 5000, net_purchases_counted: 1000 }), c).pct).toBeNull()
    expect(groupRatioOf([open()], c).pct).toBeNull()
  })
  test('a closed month is Food Cost % over its whole month, and is never withheld', () => {
    const r = open({ period_status: 'closed', cogs: 36000 })
    const ratio = rowCostRatio(r, running(3))
    expect(ratio.basis).toBe('cogs')
    expect(ratio.pct).toBeCloseTo(30)
    expect(costBandWithheld(ratio, running(3))).toBe(false)
  })
  test('a no-period row has no ratio', () => {
    expect(rowCostRatio(open({ has_period: false }), past)).toBeNull()
  })
  test('the group Spend % so far divides the group counted totals', () => {
    const rows = [open(), open({ client_id: 'b', revenue_counted: 50000, net_purchases_counted: 20000 })]
    expect(groupRatioOf(rows, running(12)).pct).toBeCloseTo(40)        // 60k ÷ 150k
    expect(groupRatioOf(rows, past).pct).toBeCloseTo(50)               // 120k ÷ 240k
  })
})

describe('the settle guard', () => {
  test('a Spend % so far is withheld on day 9 and banded from day 10', () => {
    expect(SETTLE_DAY).toBe(10)
    const ratio = rowCostRatio(open(), running(9))
    expect(costBandWithheld(ratio, running(9))).toBe(true)
    expect(costBandWithheld(rowCostRatio(open(), running(10)), running(10))).toBe(false)
  })
  test('a past month is never withheld', () => {
    expect(costBandWithheld(rowCostRatio(open(), past), past)).toBe(false)
  })
})

describe('labour on the clock (GAPS-5)', () => {
  const prorated = { hasFigure: true, amount: 25000, source: 'payroll', other: null, verdictWithheld: false }
  const withLump = { ...prorated, amount: 85000, other: { total: 60000 } }

  test('a prorated run is banded mid-month, on the counted revenue', () => {
    const c = running(12)
    expect(rowLabourPct(open({ labour: prorated }), c)).toBeCloseTo(25)
    expect(labourBandWithheld(prorated, c)).toBe(false)
  })
  test('a lump paid in the running month is withheld mid-month, not on a past month', () => {
    expect(labourWithheld(withLump, running(12))).toBe(true)
    expect(labourBandWithheld(withLump, running(12))).toBe(true)
    expect(labourWithheld(withLump, past)).toBe(false)
  })
  test('OD’s own withheld verdict (pay not set) stays withheld', () => {
    expect(labourBandWithheld({ ...prorated, verdictWithheld: true, reason: 'nopay' }, past)).toBe(true)
  })
  test('day 1 and a row without a figure are dashes', () => {
    expect(rowLabourPct(open({ labour: prorated }), running(1))).toBeNull()
    expect(rowLabourPct(open({ labour: { hasFigure: false, amount: null } }), past)).toBeNull()
  })
})

describe('revenue against last month', () => {
  test('the running month is neutral and says so', () => {
    const ch = revenueChange(open({ revenue: 20000, prevRevenue: 120000 }), running(6), 'Ashwin')
    expect(ch).toEqual({ text: '▼ 83% so far vs all of Ashwin', good: null })
  })
  test('a past month keeps its verdict', () => {
    const ch = revenueChange(open({ revenue: 90000, prevRevenue: 120000 }), past, 'Ashwin')
    expect(ch).toEqual({ text: '▼ 25% vs Ashwin', good: false })
  })
  test('a failed comparison read says it could not check; no month to compare is nothing', () => {
    expect(revenueChange(open({ prevRevenue: undefined }), past, 'Ashwin').text).toBe("vs Ashwin: couldn't check")
    expect(revenueChange(open({ prevRevenue: null }), past, 'Ashwin')).toBeNull()
  })
})

describe('rankMarks', () => {
  test('three or more figures get a lowest and a highest; a null is never ranked', () => {
    expect(rankMarks([{ id: 'a', pct: 30 }, { id: 'b', pct: 25 }, { id: 'c', pct: 40 }, { id: 'd', pct: null }])).toEqual({ low: 'b', high: 'c' })
    expect(rankMarks([{ id: 'a', pct: 30 }, { id: 'b', pct: 25 }])).toEqual({})
    expect(rankMarks([{ id: 'a', pct: 30 }, { id: 'b', pct: 30 }, { id: 'c', pct: 30 }])).toEqual({})
  })
})

// S887: a month whose bills were all credited back sums to a float residue like 5e-13, not 0.
describe('an outlet with less than one paisa of revenue has no ratios (S887)', () => {
  const labour = { hasFigure: true, amount: 25000, source: 'payroll', other: null, verdictWithheld: false }
  test('a residue revenue gives no Labour % and no cost ratio', () => {
    const r = open({ revenue: 5.2e-13, revenue_counted: 5.2e-13, labour })
    expect(rowLabourPct(r, past)).toBeNull()
    expect(rowLabourPct(r, running(12))).toBeNull()
    expect(rowCostRatio(r, past).pct).toBeNull()
  })
  test('one paisa still computes', () => {
    const r = open({ revenue: 0.01, net_purchases: 0.005, labour: { ...labour, amount: 0.005 } })
    expect(rowLabourPct(r, past)).toBeCloseTo(50, 9)
    expect(rowCostRatio(r, past).pct).toBeCloseTo(50, 9)
  })
})

// S889, the Suite critique P2#3: the Group Console judged what Profit & Loss and the Owner Report refuse to.
describe('a month closed with no stock count is not judged (S889)', () => {
  const closed = (extra = {}) => open({ period_status: 'closed', cogs: 70000, has_closing: true, ...extra })
  test('only a closed month whose P&L read says no count', () => {
    expect(closedWithoutCount(closed({ has_closing: false }))).toBe(true)
    expect(closedWithoutCount(closed())).toBe(false)
    expect(closedWithoutCount(closed({ has_closing: null }))).toBe(false)          // not read: not "no count"
    expect(closedWithoutCount(open({ has_closing: false }))).toBe(false)           // still open: Spend %
  })
  test('the row Food Cost % is withheld, a counted one is judged', () => {
    const r = closed({ has_closing: false })
    expect(rowCostWithheld(r, rowCostRatio(r, past), past)).toBe(true)
    expect(rowCostWithheld(closed(), rowCostRatio(closed(), past), past)).toBe(false)
  })
  test('the settle guard still applies to an open row', () => {
    expect(rowCostWithheld(open(), rowCostRatio(open(), running(9)), running(9))).toBe(true)
  })
  test('a group total over an uncounted outlet names it', () => {
    const rows = [closed({ has_closing: false }), closed({ client_id: 'b', client_name: 'Casa' })]
    const v = groupCostVerdict(rows, groupRatioOf(rows, past), past)
    expect(v).toEqual({ withheld: true, reason: 'noCount', names: ['Bloom Cafe'] })
  })
  test('a group total over closed and open outlets is a figure, not a verdict', () => {
    const rows = [closed(), open({ client_id: 'b' })]
    const ratio = groupRatioOf(rows, past)
    expect(ratio.basis).not.toBe('cogs')
    expect(groupCostVerdict(rows, ratio, past)).toMatchObject({ withheld: true, reason: 'mixed' })
  })
  test('a no-period or excluded outlet does not make the bases mixed', () => {
    const rows = [closed(), closed({ client_id: 'b' }), open({ client_id: 'c', has_period: false }), open({ client_id: 'd', is_included: false })]
    expect(groupCostVerdict(rows, groupRatioOf(rows, past), past)).toEqual({ withheld: false, reason: null, names: [] })
  })
  test('one basis, every outlet counted, after the settle day: judged', () => {
    const rows = [open(), open({ client_id: 'b' })]
    expect(groupCostVerdict(rows, groupRatioOf(rows, running(12)), running(12)).withheld).toBe(false)
    expect(groupCostVerdict(rows, groupRatioOf(rows, running(9)), running(9))).toMatchObject({ withheld: true, reason: 'settle' })
  })
})

describe('the coverage headline counts only outlets with figures (S889)', () => {
  test('a no-period outlet and an excluded one are not shown', () => {
    const rows = [open(), open({ client_id: 'b', has_period: false }), open({ client_id: 'c', is_included: false })]
    expect(coverageHeadline(rows, 'Kartik 2083')).toBe('1 of 3 outlets has figures for Kartik 2083')
    expect(coverageHeadline([open(), open({ client_id: 'b' })], 'Kartik 2083')).toBe('2 of 2 outlets have figures for Kartik 2083')
  })
})
