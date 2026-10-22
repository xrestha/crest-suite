import {
  tileState, revenueOf, netSpendOf, operatingFigures, cashCreditSplit, overdueFromLines, trendWithBasis,
  loadOverdueCreditBills, returnsAgainstEarlierBills,
} from './ownerDashboardData'
import { billPayables, priorBillFactors } from '../ims/reports/purchaseTaxSplit'
import { applyPriorBillFactors } from '../ims/reports/supplierAttribution'
import { mtdClock } from './mtdClock'
import { bsToAd } from '../../utils/bsCalendar'

jest.mock('../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }))
jest.mock('../../shared/scopedDb', () => ({ scopedFrom: jest.fn() }))

// Kartik 2083 has 30 days.
const KARTIK = { id: 'p7', bs_year: 2083, bs_month: 7 }
const dayClock = day => mtdClock(KARTIK, { year: 2083, month: 7, day })
const ended = mtdClock(KARTIK, { year: 2083, month: 8, day: 2 })

describe('tileState', () => {
  const s = (o) => Object.fromEntries(Object.entries(o).map(([k, status]) => [k, { status }]))
  test('one failed dependency is a dash that names it', () => {
    expect(tileState(s({ ims: 'ok', labour: 'failed' }), ['ims', 'labour'])).toEqual({ state: 'failed', failed: 'labour' })
  })
  test('loading is a skeleton; all ok is a figure; no open month is none', () => {
    expect(tileState(s({ ims: 'loading', labour: 'ok' }), ['ims', 'labour']).state).toBe('loading')
    expect(tileState(s({ ims: 'ok', labour: 'ok' }), ['ims', 'labour']).state).toBe('ok')
    expect(tileState(s({ ims: 'none' }), ['ims']).state).toBe('none')
    expect(tileState({}, ['ims']).state).toBe('loading')
  })
  test('a failure wins over loading', () => {
    expect(tileState(s({ ims: 'loading', commission: 'failed' }), ['ims', 'commission']).failed).toBe('commission')
  })
})

describe('operatingFigures — True Net Margin on one clock (OWNER-DASHBOARD-1)', () => {
  // The area file's café: NPR 30,000 of sales, 10,500 of stock bought and 9,000 of labour a day;
  // rent and other fixed costs NPR 1,62,000 for the month.
  const cafe = clock => {
    const n = clock.countedDays
    return operatingFigures({ revenue: 30000 * n, spend: 10500 * n, labour: 9000 * n, overhead: 140000, taxFees: 22000, clock })
  }
  test('reads 17.0% on day 12 and every later day, and once the month has ended', () => {
    for (const c of [dayClock(12), dayClock(20), dayClock(30), ended]) {
      expect(cafe(c).marginPct).toBeCloseTo(17.0, 9)
    }
    // Fixed costs for days 1–11: 1,62,000 × 11 ÷ 30.
    expect(cafe(dayClock(12)).fixedCounted).toBeCloseTo(59400, 6)
    // The Inventory Dashboard's Fixed Costs %: (59,400 + 99,000) ÷ 3,30,000.
    expect(cafe(dayClock(12)).fixedCostsPct).toBeCloseTo(48.0, 9)
  })
  test('day 1: every ratio waits', () => {
    expect(operatingFigures({ revenue: 5000, spend: 100, labour: 0, overhead: 1, taxFees: 0, clock: dayClock(1) }))
      .toMatchObject({ spendPct: null, labourPct: null, marginPct: null, firstDay: true })
  })
  test('no revenue or no labour: no margin', () => {
    expect(operatingFigures({ revenue: null, spend: 1, labour: 1, clock: ended }).marginPct).toBeNull()
    expect(operatingFigures({ revenue: 0, spend: 1, labour: 1, clock: ended }).marginPct).toBeNull()
    const r = operatingFigures({ revenue: 1000, spend: 100, labour: null, clock: ended })
    expect(r).toMatchObject({ marginPct: null, labourPct: null, primePct: null })
    expect(r.spendPct).toBeCloseTo(10, 9)
  })
  test('no fixed costs entered is flagged, the figure still computed', () => {
    const r = operatingFigures({ revenue: 1000, spend: 300, labour: 200, overhead: 0, taxFees: 0, clock: ended })
    expect(r.fixedMissing).toBe(true)
    expect(r.marginPct).toBeCloseTo(50, 9)
  })
  test('PNL-1 parity: delivery commission comes off; a failed read leaves no margin', () => {
    const base = { revenue: 100000, spend: 30000, labour: 25000, overhead: 30000, taxFees: 0, clock: ended }
    expect(operatingFigures({ ...base, commission: 5000 }).marginPct).toBeCloseTo(10, 9)
    expect(operatingFigures({ ...base, commission: null }).marginPct).toBeNull()
    expect(operatingFigures({ ...base }).marginPct).toBeCloseTo(15, 9)
  })
})

describe('the counted days (OWNER-DASHBOARD-8)', () => {
  test('day 3 at 10 am: Labour % is 30.0%, not 42.9%', () => {
    const sales = [
      { recipe_id: 'r', qty_sold: 1, unit_price: 30000, bs_day: 1 },
      { recipe_id: 'r', qty_sold: 1, unit_price: 30000, bs_day: 2 },
      { recipe_id: 'r', qty_sold: 1, unit_price: 3000, bs_day: 3 },
    ]
    const clock = dayClock(3)
    const rev = revenueOf(sales, {}, clock)
    expect(rev).toEqual({ all: 63000, counted: 60000 })
    // Labour accrued to yesterday (two days of NPR 9,000).
    expect(operatingFigures({ revenue: rev.counted, spend: 0, labour: 18000, clock }).labourPct).toBeCloseTo(30.0, 9)
  })
  test('revenue: comps left out, Bulk rows counted, the recipe price as fallback', () => {
    const sales = [
      { recipe_id: 'a', qty_sold: 2, unit_price: null, discount: 50, bs_day: 0 },
      { recipe_id: 'a', qty_sold: 5, unit_price: 100, source: 'pos_comp', bs_day: 1 },
    ]
    expect(revenueOf(sales, { a: 400 }, dayClock(2))).toEqual({ all: 750, counted: 750 })
  })
})

describe('netSpendOf — stock transfers (DASH-TRANSFERS)', () => {
  const purchases = [{ id: 'l1', item_id: 'i', qty: 10, rate: 2000, bs_day: 2, discount_amount: 0, purchase_group_id: 'b1', vat_inclusive: false }]
  test('a 10,000 transfer in and 4,000 out: spend +6,000', () => {
    const transfers = [{ direction: 'in', value: 10000, bs_day: 5 }, { direction: 'out', value: 4000, bs_day: 6 }]
    const without = netSpendOf({ purchases, returns: [], transfers: [], clock: ended })
    const withT = netSpendOf({ purchases, returns: [], transfers, clock: ended })
    expect(withT.all - without.all).toBeCloseTo(6000, 9)
    expect(withT.transfers).toMatchObject({ inAll: 10000, outAll: 4000 })
  })
  test('an out-row dated today is not counted (finished days)', () => {
    const transfers = [{ direction: 'in', value: 10000, bs_day: 5 }, { direction: 'out', value: 4000, bs_day: 12 }]
    const r = netSpendOf({ purchases, returns: [], transfers, clock: dayClock(12) })
    expect(r.counted).toBeCloseTo(20000 + 10000, 9)
    expect(r.all).toBeCloseTo(20000 + 10000 - 4000, 9)
  })
  test('returns come off at their cost basis, on their own day', () => {
    const returns = [{ item_id: 'i', qty: 1, rate: 2000, bs_day: 4, purchase_entries: { vat_inclusive: false, vat_is_cost: false } }]
    expect(netSpendOf({ purchases, returns, clock: dayClock(4) }).counted).toBeCloseTo(20000, 9)
    expect(netSpendOf({ purchases, returns, clock: dayClock(5) }).counted).toBeCloseTo(18000, 9)
  })
})

describe('cashCreditSplit — the Payment Report\'s figures (OWNER-DASHBOARD-13)', () => {
  test('a credit-only month with a 6,000 return: Cash 0, not −6,000', () => {
    const purchases = [{ id: 'l1', qty: 10, rate: 5000, bs_day: 3, payment_method: 'Credit', discount_amount: 0, purchase_group_id: 'b1', vat_inclusive: false }]
    const returns = [{ purchase_entry_id: 'l1', qty: 1.2, rate: 5000, payment_method: 'Credit', purchase_entries: { vat_inclusive: false } }]
    const r = cashCreditSplit(purchases, returns, KARTIK)
    expect(r.cash).toBe(0)
    expect(r.credit).toBeCloseTo(44000, 6)
  })
  test('VAT included, bill discount off; FonePay counts with Cash', () => {
    const purchases = [
      { id: 'a', qty: 1, rate: 10000, bs_day: 1, payment_method: 'FonePay', discount_amount: 1000, purchase_group_id: 'b', vat_inclusive: true },
    ]
    const r = cashCreditSplit(purchases, [], KARTIK)
    expect(r.cash).toBeCloseTo(9000 * 1.13, 6)
    expect(r.credit).toBe(0)
  })

  // S853 (D2). Kartik's return of 2 units against Ashwin's Credit bill: 15,000 with 1,500 off, so
  // each line kept 90% of its list price, and the returned line carried VAT.
  describe('a return against a bill from an earlier month', () => {
    const ASHWIN_BILL = [
      { id: 'old1', period_id: 'p6', qty: 10, rate: 1000, bs_day: 20, payment_method: 'Credit', discount_amount: 1500, purchase_group_id: 'b-old', vat_inclusive: true },
      { id: 'old2', period_id: 'p6', qty: 1, rate: 5000, bs_day: 20, payment_method: 'Credit', discount_amount: 1500, purchase_group_id: 'b-old', vat_inclusive: false },
    ]
    const purchases = [{ id: 'l1', period_id: 'p7', qty: 10, rate: 1000, bs_day: 3, payment_method: 'Credit', discount_amount: 0, purchase_group_id: 'b1', vat_inclusive: false }]
    const returns = [
      { purchase_entry_id: 'old1', qty: 2, rate: 1000, bs_day: 5, payment_method: 'Credit', purchase_entries: { vat_inclusive: true, vat_is_cost: false, period_id: 'p6' } },
      { purchase_entry_id: 'l1', qty: 1, rate: 1000, bs_day: 6, payment_method: 'Credit', purchase_entries: { vat_inclusive: false, vat_is_cost: false, period_id: 'p7' } },
    ]

    test('comes off at the discounted price of its own bill, VAT on that: Credit 6,966, not 6,740', () => {
      // Before: 10,000 − 2,000 × 1.13 − 1,000 (the list price).
      expect(cashCreditSplit(purchases, returns, KARTIK).credit).toBeCloseTo(6740, 6)
      const r = cashCreditSplit(purchases, returns, KARTIK, { priorBillLines: ASHWIN_BILL })
      // Now: 10,000 − 2,000 × 0.9 × 1.13 − 1,000.
      expect(r.credit).toBeCloseTo(10000 - 2034 - 1000, 6)
      expect(r.cash).toBe(0)
    })

    test('matches what the Payment Report arithmetic gives for the same month', () => {
      // PaymentReport.js: billPayables, then applyPriorBillFactors over the earlier bills' lines.
      const { bills, returns: listed } = billPayables(purchases, returns, KARTIK)
      const priced = applyPriorBillFactors(listed, purchases, priorBillFactors(ASHWIN_BILL))
      const credit = bills.filter(b => b.method === 'Credit').reduce((s, b) => s + b.total, 0)
        - priced.filter(x => x.method === 'Credit').reduce((s, x) => s + x.value, 0)
      expect(cashCreditSplit(purchases, returns, KARTIK, { priorBillLines: ASHWIN_BILL }).credit).toBeCloseTo(credit, 9)
    })

    test('returnsAgainstEarlierBills: the earlier lines, read off the embed, as returnLinesOutsidePeriod gives them', () => {
      const unlinked = { purchase_entry_id: null, qty: 1, rate: 10, purchase_entries: null }
      const twice = { ...returns[0], qty: 1 }
      expect(returnsAgainstEarlierBills([...returns, unlinked, twice], 'p7')).toEqual(['old1'])
      expect(returnsAgainstEarlierBills([returns[1]], 'p7')).toEqual([])
      expect(returnsAgainstEarlierBills(null, 'p7')).toEqual([])
    })
  })
})

describe('Overdue Payables — bills, valued as Outstanding Payables (OWNER-DASHBOARD-7)', () => {
  const ASHADH = { client_id: 'c', bs_year: 2083, bs_month: 3 }
  const today = new Date(bsToAd(2083, 3, 1).getTime() + 100 * 86400000)
  const lines = ['l1', 'l2', 'l3', 'l4'].map((id, i) => ({
    id, created_at: `2026-06-1${i}T00:00:00Z`, bs_day: 1, qty: 1, rate: 10000, vat_inclusive: true,
    discount_amount: 0, purchase_group_id: 'bill-1', vendor_id: 'v', invoice_ref: 'INV-9', paid_at: null, monthly_periods: ASHADH,
  }))
  test('the 4-line VAT bill: NPR 45,200 · 1 bill', () => {
    expect(overdueFromLines(lines, {}, {}, today)).toEqual({ overdueTotal: 45200, overdueCount: 1 })
  })
  test('after a 30,000 payment: 15,200 · 1 bill', () => {
    const pmts = { l1: [{ amount: 11300 }], l2: [{ amount: 11300 }], l3: [{ amount: 7400 }] }
    const r = overdueFromLines(lines, pmts, {}, today)
    expect(r.overdueCount).toBe(1)
    expect(r.overdueTotal).toBeCloseTo(15200, 2)
  })
  test('a fully returned bill is not overdue; a young bill is not overdue', () => {
    const returned = Object.fromEntries(lines.map(l => [l.id, 10000]))
    expect(overdueFromLines(lines, {}, returned, today)).toEqual({ overdueTotal: 0, overdueCount: 0 })
    expect(overdueFromLines(lines, {}, {}, new Date(bsToAd(2083, 3, 20).getTime()))).toEqual({ overdueTotal: 0, overdueCount: 0 })
  })
  // A builder that records each `.in()` and answers `.range()` with `rowsOf(table, column, ids)`.
  const recorder = rowsOf => {
    const seen = []
    const builder = (table, columns) => {
      let filter = null
      const b = {
        select: () => b, eq: () => b, is: () => b, order: () => b,
        in: (c, v) => { filter = [c, v]; seen.push([table, c, v.length, columns || null]); return b },
        range: () => Promise.resolve({ data: rowsOf(table, filter), error: null }),
      }
      return b
    }
    return { seen, supabase: { from: t => builder(t) }, scopedFrom: (t, c) => builder(t, c) }
  }

  // S859: the payments and returns are found by the bills' group, beside the bill lines, not after them.
  test('the loader completes part-paid bills by group, and reads their payments and returns by group beside them', async () => {
    const { seen, supabase, scopedFrom } = recorder(t => (t === 'purchase_entries' ? lines : []))
    const r = await loadOverdueCreditBills({ supabase, scopedFrom, clientId: 'c', today })
    expect(r).toEqual({ overdueTotal: 45200, overdueCount: 1, error: null })
    expect(seen.map(x => x.slice(0, 3))).toEqual(expect.arrayContaining([
      ['purchase_entries', 'purchase_group_id', 1],
      ['payable_payments', 'purchase_entries.purchase_group_id', 1], ['vendor_returns', 'purchase_entries.purchase_group_id', 1],
    ]))
    // Every line here has a group, so nothing is read by line id.
    expect(seen.filter(x => x[1] === 'purchase_entry_id')).toEqual([])
    expect(seen.find(x => x[0] === 'payable_payments')[3]).toMatch(/purchase_entries!inner\(purchase_group_id\)$/)
  })

  test('a legacy line with no group is read by its id; each payment lands on its own line, as the by-line read gave it', async () => {
    const legacy = { ...lines[0], id: 'old', purchase_group_id: null, invoice_ref: 'INV-1' }
    const pay = { id: 'pm1', purchase_entry_id: 'l1', amount: 11300, paid_at: '2026-07-01', payment_mode: 'Bank', credit_link_id: null }
    const payOld = { id: 'pm2', purchase_entry_id: 'old', amount: 300, paid_at: '2026-07-01', payment_mode: 'Cash', credit_link_id: null }
    const rows = (t, f) => {
      if (t === 'purchase_entries') return f ? lines : [...lines, legacy]
      if (t === 'payable_payments') return f[0] === 'purchase_entry_id' ? [payOld] : [{ ...pay, purchase_entries: { purchase_group_id: 'bill-1' } }]
      if (t === 'vendor_returns') return f[0] === 'purchase_entry_id' ? [] : [{ purchase_entry_id: 'l4', qty: 1, rate: 10000, purchase_entries: { purchase_group_id: 'bill-1' } }]
      return []
    }
    const { seen, supabase, scopedFrom } = recorder(rows)
    const r = await loadOverdueCreditBills({ supabase, scopedFrom, clientId: 'c', today })
    expect(seen.map(x => x.slice(0, 3))).toEqual(expect.arrayContaining([
      ['payable_payments', 'purchase_entry_id', 1], ['vendor_returns', 'purchase_entry_id', 1],
    ]))
    // The figure the by-line-id maps give for the same rows.
    const want = overdueFromLines([...lines, legacy], { l1: [pay], old: [payOld] }, { l4: 10000 }, today)
    expect(r).toEqual({ ...want, error: null })
    expect(r.overdueCount).toBe(2)
  })
  test('a failed read is a failure, never NPR 0', async () => {
    const b = { select: () => b, eq: () => b, is: () => b, order: () => b, range: () => Promise.resolve({ data: null, error: { message: 'down' } }) }
    const r = await loadOverdueCreditBills({ supabase: { from: () => b }, scopedFrom: () => b, clientId: 'c', today })
    expect(r).toMatchObject({ overdueTotal: null, overdueCount: null, error: { message: 'down' } })
  })
})

describe('trendWithBasis (OWNER-DASHBOARD-11)', () => {
  test('a schema-11 Bhadra then a schema-13 Ashwin: marks at Ashwin for Net Margin and Labour', () => {
    const { points, marks } = trendWithBasis([
      { bs_year: 2083, bs_month: 5, combined: { foodCostBasis: 'cogs', foodCostPct: 31.24, laborCostPct: 27, primeCostPct: 58.24, netMarginPct: 12 } },
      { bs_year: 2083, bs_month: 6, combined: { foodCostBasis: 'cogs', netMarginTaxFees: true, labourBasis: 'earned', foodCostPct: 30, netMarginPct: 10 } },
    ])
    expect(points).toHaveLength(2)
    expect(points[0].fc).toBe(31.2)
    expect(marks).toEqual([{ label: points[1].label, kinds: ['netMargin', 'labour'] }])
  })
  test('the v18 step (wastage, staff meals, commission) is a Net Margin mark too', () => {
    const v17 = { foodCostBasis: 'cogs', netMarginTaxFees: true, labourBasis: 'earned' }
    const { marks } = trendWithBasis([
      { bs_year: 2083, bs_month: 5, combined: v17 },
      { bs_year: 2083, bs_month: 6, combined: { ...v17, netMarginPnlCosts: true } },
      { bs_year: 2083, bs_month: 7, combined: { ...v17, netMarginPnlCosts: true } },
    ])
    expect(marks.map(m => m.kinds)).toEqual([['netMargin']])
  })
  test('a purchases-basis month then a COGS month marks Food Cost', () => {
    const { marks } = trendWithBasis([{ bs_year: 2082, bs_month: 1, combined: {} }, { bs_year: 2082, bs_month: 2, combined: { foodCostBasis: 'cogs' } }])
    expect(marks[0].kinds).toEqual(['food'])
  })
})
