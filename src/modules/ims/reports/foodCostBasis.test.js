// The D30 rule (S792): a closed month's Food Cost % is what was USED ÷ sales; a running month shows
// what was SPENT, under its own name. Every expected figure is worked by hand.
import {
  FOOD_COST_LABEL, SPEND_SO_FAR_LABEL, fcBasisOf, periodCostRatio,
  cogsOfGroupPnlRow, withGroupCogs, groupCostRatio,
} from './foodCostBasis'

describe('fcBasisOf / periodCostRatio', () => {
  it('uses COGS for a closed month and spend for anything else', () => {
    expect(fcBasisOf('closed')).toBe('cogs')
    expect(fcBasisOf('open')).toBe('spend')
    expect(fcBasisOf(undefined)).toBe('spend')
  })

  it("gives FIGURES-3's month the two different figures under two different names", () => {
    // Opening 1 L, purchases 5 L, closing 2.5 L, revenue 10 L: used 3.5 L, spent 5 L.
    const month = { revenue: 1000000, cogs: 350000, netPurchases: 500000 }
    const closed = periodCostRatio({ ...month, status: 'closed' })
    expect(closed).toEqual({ basis: 'cogs', pct: 35, label: FOOD_COST_LABEL })
    const open = periodCostRatio({ ...month, status: 'open' })
    expect(open).toEqual({ basis: 'spend', pct: 50, label: SPEND_SO_FAR_LABEL })
  })

  it('never falls back to spend for a closed month with no COGS figure', () => {
    expect(periodCostRatio({ status: 'closed', revenue: 1000, cogs: null, netPurchases: 400 }).pct).toBeNull()
  })

  it('is null, never 0, with no revenue', () => {
    expect(periodCostRatio({ status: 'closed', revenue: 0, cogs: 100 }).pct).toBeNull()
    expect(periodCostRatio({ status: 'open', revenue: null, netPurchases: 100 }).pct).toBeNull()
  })

  it('reads the numeric strings an RPC returns', () => {
    expect(periodCostRatio({ status: 'closed', revenue: '2000', cogs: '600' }).pct).toBeCloseTo(30)
  })
})

describe('the Group Console on get_group_pnl components', () => {
  const pnl = {
    client_id: 'a', period_status: 'closed',
    opening_val: '100', purchases_val: '500', returns_val: '20',
    wastage_val: '10', staff_meals_val: '5', closing_val: '65',
  }

  it("derives COGS the way Consolidated P&L's buildStatement does", () => {
    // 100 + 500 − 20 − 10 − 5 − 65 = 500
    expect(cogsOfGroupPnlRow(pnl)).toBeCloseTo(500)
    expect(cogsOfGroupPnlRow(null)).toBeNull()
  })

  it('adds status and COGS to each summary row, COGS only for a closed month', () => {
    const summary = [
      { client_id: 'a', is_included: true, has_period: true, revenue: '2000', net_purchases: '480' },
      { client_id: 'b', is_included: true, has_period: true, revenue: '1000', net_purchases: '400' },
      { client_id: 'c', is_included: false, has_period: true, revenue: null, net_purchases: null },
    ]
    const rows = withGroupCogs(summary, [pnl, { ...pnl, client_id: 'b', period_status: 'open' }])
    expect(rows[0]).toMatchObject({ period_status: 'closed', cogs: 500 })
    expect(rows[1]).toMatchObject({ period_status: 'open', cogs: null })
    expect(rows[2]).toMatchObject({ period_status: null, cogs: null })
  })

  it('is a group Food Cost % only when every included outlet has closed the month', () => {
    const closedA = { is_included: true, has_period: true, period_status: 'closed', revenue: '2000', cogs: 500, net_purchases: '480' }
    const closedB = { ...closedA, revenue: '1000', cogs: 300, net_purchases: '400' }
    expect(groupCostRatio([closedA, closedB])).toEqual({ basis: 'cogs', pct: (800 / 3000) * 100, label: FOOD_COST_LABEL })
  })

  it('falls back to the whole group on spend when any outlet is still in the month', () => {
    const closedA = { is_included: true, has_period: true, period_status: 'closed', revenue: '2000', cogs: 500, net_purchases: '480' }
    const openB = { is_included: true, has_period: true, period_status: 'open', revenue: '1000', cogs: null, net_purchases: '400' }
    expect(groupCostRatio([closedA, openB])).toEqual({ basis: 'spend', pct: (880 / 3000) * 100, label: SPEND_SO_FAR_LABEL })
  })

  it('ignores excluded outlets and outlets with no period for the month', () => {
    const closedA = { is_included: true, has_period: true, period_status: 'closed', revenue: '2000', cogs: 500 }
    const unpaid = { is_included: false, has_period: true, period_status: 'open', revenue: null }
    const noPeriod = { is_included: true, has_period: false, period_status: null, revenue: '0' }
    expect(groupCostRatio([closedA, unpaid, noPeriod]).basis).toBe('cogs')
    expect(groupCostRatio([]).pct).toBeNull()
  })
})
