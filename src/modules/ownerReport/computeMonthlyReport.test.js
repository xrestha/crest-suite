// The two figures schema v6 changed the meaning of (see CURRENT_SCHEMA_VERSION's comment):
// purchases net of supplier bill discounts, and employer SSF only for real SSF contributors.
// Both defects were SILENT — a plausible, slightly-high number — so the arithmetic is pinned here
// and the reads that feed it are pinned by reading the source, since a select that omits a column
// makes the helper quietly fall back to the old behaviour rather than fail.
import fs from 'fs'
import path from 'path'

jest.mock('../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }))
jest.mock('../../shared/scopedDb', () => ({ scopedFrom: jest.fn() }))

// eslint-disable-next-line import/first
import {
  netPurchaseFigures, estimatePayrollAccrual, CURRENT_SCHEMA_VERSION,
  computeCombinedMetrics, buildDeltas, foodCostBasisOf, trendSnapshotOf, netMarginTaxFeesOf, labourBasisOf,
} from './computeMonthlyReport'
// eslint-disable-next-line import/first
import { hoursCoverage } from './computeLaborAnalyticsSection'
// eslint-disable-next-line import/first
import { SSF_CAP, SSF_EMPLOYER_PCT } from '../hr/payrollConstants'
// eslint-disable-next-line import/first
import { bsToAd, daysInBsMonth, formatAd } from '../../utils/bsCalendar'

const line = (over) => ({
  item_id: 'i1', qty: 1, rate: 0, payment_method: 'Cash', discount_amount: 0,
  purchase_group_id: 'bill-1', vendor_id: 'v1', invoice_ref: 'INV-1', bs_day: 3, ...over,
})

describe('netPurchaseFigures', () => {
  test('a bill discount lowers net purchases by exactly the discount, once per bill', () => {
    // Two lines of one bill, each carrying the bill's 1,000 discount (it is repeated per line).
    const purchases = [
      line({ qty: 2, rate: 3000, discount_amount: 1000 }),
      line({ item_id: 'i2', qty: 4, rate: 1000, discount_amount: 1000 }),
    ]
    const undiscounted = netPurchaseFigures(purchases.map(p => ({ ...p, discount_amount: 0 })), [])
    const discounted = netPurchaseFigures(purchases, [])
    expect(undiscounted.purchaseTotal).toBeCloseTo(10000, 6)
    expect(discounted.purchaseTotal).toBeCloseTo(9000, 6) // not 8,000: max, never sum, per bill
  })

  test('food cost % falls with the discount', () => {
    const revenue = 30000
    const purchases = [line({ qty: 10, rate: 1000, discount_amount: 1500 })]
    const fcBefore = (netPurchaseFigures(purchases.map(p => ({ ...p, discount_amount: 0 })), []).purchaseTotal / revenue) * 100
    const fcAfter = (netPurchaseFigures(purchases, []).purchaseTotal / revenue) * 100
    expect(fcBefore).toBeCloseTo(33.333, 2)
    expect(fcAfter).toBeCloseTo(28.333, 2)
  })

  test('legacy bills with no purchase_group_id are keyed by vendor + invoice + day', () => {
    const purchases = [
      line({ purchase_group_id: null, qty: 1, rate: 600, discount_amount: 100 }),
      line({ purchase_group_id: null, item_id: 'i2', qty: 1, rate: 400, discount_amount: 100 }),
      // a different bill from the same vendor on another day keeps its own discount
      line({ purchase_group_id: null, bs_day: 9, qty: 1, rate: 500, discount_amount: 50 }),
    ]
    expect(netPurchaseFigures(purchases, []).purchaseTotal).toBeCloseTo(1500 - 100 - 50, 6)
  })

  test('returns come off at list value, and Cash + Credit still adds up to the total', () => {
    const purchases = [
      line({ qty: 1, rate: 8000, discount_amount: 1000, payment_method: 'Credit' }),
      line({ item_id: 'i2', qty: 1, rate: 2000, discount_amount: 1000, payment_method: 'Credit' }),
      line({ purchase_group_id: 'bill-2', qty: 5, rate: 200, discount_amount: 0 }),
    ]
    const returns = [{ item_id: 'i1', qty: 1, rate: 300 }]
    const f = netPurchaseFigures(purchases, returns)
    expect(f.purchaseTotal).toBeCloseTo(9000 + 1000 - 300, 6)
    expect(f.creditNet).toBeCloseTo(9000, 6)
    expect(f.cashNet).toBeCloseTo(1000 - 300, 6)
    expect(f.cashNet + f.creditNet).toBeCloseTo(f.purchaseTotal, 6)
  })

  test('empty and missing inputs are zero, not NaN', () => {
    expect(netPurchaseFigures(null, undefined)).toEqual({ purchaseTotal: 0, cashNet: 0, creditNet: 0 })
  })
})

describe('estimatePayrollAccrual — employer SSF follows payroll’s own gate', () => {
  // A 30-or-so-day BS month; the exact length does not matter because every employee below
  // works the whole of it, so gross is the monthly figure and SSF is on the full capped base.
  const period = { bs_year: 2083, bs_month: 5 }
  const base = { status: 'active', basic_salary: 40000, pay_basis: 'monthly', join_date: null, end_date: null }

  test('enrolled AND numbered: employer SSF is added', () => {
    const { gross, ssfEmployer } = estimatePayrollAccrual({
      employees: [{ ...base, id: 'e1', ssf_enrolled: true, ssf_no: '1234567890' }], components: [], period,
    })
    expect(gross).toBeCloseTo(40000, 6)
    expect(ssfEmployer).toBeCloseTo(Math.min(40000, SSF_CAP) * SSF_EMPLOYER_PCT, 6)
  })

  test('enrolled WITHOUT a number: no employer SSF (payroll contributes nothing for them)', () => {
    for (const ssf_no of [null, undefined, '', '   ']) {
      const { gross, ssfEmployer } = estimatePayrollAccrual({
        employees: [{ ...base, id: 'e2', ssf_enrolled: true, ssf_no }], components: [], period,
      })
      expect(gross).toBeCloseTo(40000, 6)
      expect(ssfEmployer).toBe(0)
    }
  })

  test('a number without the enrolment flag adds nothing either', () => {
    const { ssfEmployer } = estimatePayrollAccrual({
      employees: [{ ...base, id: 'e3', ssf_enrolled: false, ssf_no: '1234567890' }], components: [], period,
    })
    expect(ssfEmployer).toBe(0)
  })
})

describe('computeMonthlyReport reads what the two helpers need', () => {
  const flat = fs.readFileSync(path.join(__dirname, 'computeMonthlyReport.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\s+/g, ' ')

  test('the purchase_entries read selects the discount and every bill-key column', () => {
    const at = flat.indexOf("from('purchase_entries')")
    expect(at).toBeGreaterThan(-1)
    const chain = flat.slice(at, at + 260)
    for (const col of ['discount_amount', 'purchase_group_id', 'vendor_id', 'invoice_ref', 'bs_day']) {
      expect(chain).toContain(col)
    }
  })

  test('every per-item and per-period IMS read in the snapshot is paged with a unique tiebreaker (S756)', () => {
    // The six reads that sat bare beside paged ones, plus payable_payments. Truncation returns no
    // error, so throwFirstError cannot catch it and the frozen report keeps the short figure.
    const reads = [
      "from('vendor_returns')", "scopedFrom('items'", "scopedFrom('par_levels'", "from('opening_stock')",
      "from('closing_stock')", "from('staff_meals')", "scopedFrom('payable_payments'",
    ]
    for (const read of reads) {
      const at = flat.indexOf(read)
      expect(at).toBeGreaterThan(-1)
      expect(flat.slice(Math.max(0, at - 40), at)).toMatch(/fetchAllRows\(\(\) => (supabase\.)?$/)
      expect(flat.slice(at, at + 200)).toMatch(/\.order\('id'\)\)/)
    }
  })

  test('the hr_employees read selects ssf_no, and nothing gates employer SSF on the flag alone', () => {
    const at = flat.indexOf("scopedFrom('hr_employees'")
    expect(at).toBeGreaterThan(-1)
    expect(flat.slice(at, at + 160)).toContain('ssf_no')
    expect(flat).not.toMatch(/if \(\s*emp\.ssf_enrolled\s*\)/)
    expect(flat).toMatch(/isSsfContributor\(emp\)/)
  })

  test('the schema version moved for the change of meaning', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(10)
  })

  // S792 (FIGURES-5, v10): Wastage Value is the one figure every Wastage tile shows — every item,
  // prep and hidden ones included — read through the row's own item join. COGS keeps taking off
  // raw-item wastage only, through valuePeriodItems, never this figure.
  test('Wastage Value is periodWastageValue over the joined read, and COGS does not take it', () => {
    const at = flat.indexOf("from('wastages')")
    expect(at).toBeGreaterThan(-1)
    expect(flat.slice(at, at + 120)).toMatch(/\.select\(WASTAGE_VALUE_SELECT\)/)
    expect(flat).toMatch(/wastageValueTotal = periodWastageValue\(wastagesData\)/)
    expect(flat).not.toMatch(/computeUsed\([^)]*wastageValueTotal/)
    expect(flat).not.toMatch(/itemRateMap\[w\.item_id\]/)
  })

  test('the trend stores a trimmed prior snapshot and computes its deltas from the full one', () => {
    expect(flat).toMatch(/snapshot: trendSnapshotOf\(prior\.snapshot\), deltas: buildDeltas\(currentPartial, prior\.snapshot\)/)
  })

  // S792 (FIGURES-8): revenue is the denominator of every ratio on the report, and `source` is
  // nullable, so a server-side .neq froze a short revenue for any month holding legacy rows.
  test('revenue reads source and filters comps in JS, through periodRevenue', () => {
    const at = flat.indexOf("from('sales_entries')")
    expect(at).toBeGreaterThan(-1)
    expect(flat.slice(at, at + 200)).toMatch(/\.select\('[^']*\bsource\b[^']*'\)/)
    expect(flat).not.toMatch(/\.neq\(\s*'source'/)
    expect(flat).toMatch(/periodRevenue\(salesData, recipes\)/)
  })

  // S792 (D30): Food Cost % is COGS ÷ revenue, through Monthly Summary's own arithmetic, over every
  // non-sub-recipe item — active or hidden (D29) — so the items read carries no is_active filter.
  test('Food Cost % is COGS ÷ revenue, valued by periodCost.js over every non-sub-recipe item', () => {
    expect(flat).toMatch(/valuePeriodItems\(cogsItems, stockMaps\)/)
    expect(flat).toMatch(/foodCostPct = revenueTotal > 0 \? \(cogsTotal \/ revenueTotal\) \* 100 : null/)
    expect(flat).toMatch(/cogsItems = \(allItems \|\| \[\]\)\.filter\(i => !i\.is_sub_recipe\)/)
    const at = flat.indexOf("scopedFrom('items'")
    expect(flat.slice(at, at + 160)).not.toMatch(/is_active', true/)
  })
})

describe('combined metrics on the COGS basis (S792, D30)', () => {
  // FIGURES-3's own month: opening 1 L, purchases 5 L, closing 2.5 L, revenue 10 L. On purchases
  // it froze 50% ▲; used, it is 35% — what Monthly Summary says for the same month.
  const ims = {
    revenueTotal: 1000000, purchaseTotal: 500000, cogsTotal: 350000, overheadTotal: 100000,
    foodCostPct: 35, foodCostBasis: 'cogs',
  }
  const hr = { payroll: { total: 250000 } }

  test('Food, Prime and Net Margin all use the food that was used', () => {
    const c = computeCombinedMetrics({ ims, hr })
    expect(c.foodCostPct).toBeCloseTo(35, 9)
    expect(c.laborCostPct).toBeCloseTo(25, 9)
    expect(c.primeCostPct).toBeCloseTo(60, 9)
    // (10 L − 3.5 L − 2.5 L − 1 L) / 10 L — not the 15% net purchases would give.
    expect(c.netMarginPct).toBeCloseTo(30, 9)
    expect(c.foodCostBasis).toBe('cogs')
  })

  test('an older snapshot with no basis field reads as the purchases basis', () => {
    expect(foodCostBasisOf({ combined: { foodCostPct: 50 } })).toBe('purchases')
    expect(foodCostBasisOf({ combined: { foodCostBasis: 'cogs' } })).toBe('cogs')
  })
})

describe('Trend across the v8 → v9 line (S792)', () => {
  const v9 = { combined: { revenueTotal: 110, foodCostPct: 35, laborCostPct: 25, primeCostPct: 60, netMarginPct: 30, foodCostBasis: 'cogs' } }
  const v8 = { combined: { revenueTotal: 100, foodCostPct: 50, laborCostPct: 26, primeCostPct: 76, netMarginPct: 14 } }

  test('no Food Cost / Prime / Net Margin delta against a purchases-basis snapshot', () => {
    const d = buildDeltas(v9, v8)
    expect(d).toMatchObject({ foodCostBasisChanged: true, foodCostPct: null, primeCostPct: null, netMarginPct: null })
    // Revenue and labour mean the same on both sides and still compare.
    expect(d.laborCostPct).toBeCloseTo(-1, 9)
    expect(d.revenueTotal.absoluteChange).toBeCloseTo(10, 9)
  })

  test('two snapshots on the same basis compare as before', () => {
    const d = buildDeltas(v9, { combined: { ...v9.combined, foodCostPct: 33 } })
    expect(d.foodCostBasisChanged).toBe(false)
    expect(d.foodCostPct).toBeCloseTo(2, 9)
    expect(buildDeltas(v8, { combined: { ...v8.combined, foodCostPct: 48 } }).foodCostPct).toBeCloseTo(2, 9)
  })
})

describe('trendSnapshotOf: a Trend entry no longer embeds the whole prior snapshot (S792)', () => {
  // A v9 prior as stored: its own trend holds ITS priors whole, which held theirs, and so on.
  const deep = { combined: { revenueTotal: 1, foodCostPct: 30 }, ims: { big: 'x'.repeat(5000) } }
  const prior = {
    schemaVersion: 9,
    combined: { revenueTotal: 110, foodCostPct: 35, laborCostPct: 25, primeCostPct: 60, netMarginPct: 30, foodCostBasis: 'cogs' },
    ims: { revenueTotal: 110, cogsTotal: 38, wastageValueTotal: 4 },
    hr: { payroll: { total: 27, ot: { hours: 3, amount: 900 } } },
    pos: { totalNetSales: 125, totalCovers: 40, byCategory: [{ name: 'Food', net: 100 }] },
    menuEngineering: { items: Array.from({ length: 50 }, (_, i) => ({ id: i })) },
    trend: { vsLastPeriod: { available: true, snapshot: deep }, vsSameMonthLastYear: { available: true, snapshot: deep } },
  }

  test('keeps exactly what the Trend rows read, and drops the nested trend', () => {
    const t = trendSnapshotOf(prior)
    expect(t).toEqual({
      schemaVersion: 9,
      combined: { revenueTotal: 110, foodCostPct: 35, laborCostPct: 25, primeCostPct: 60, netMarginPct: 30, foodCostBasis: 'cogs' },
      pos: { totalNetSales: 125 },
    })
    expect(t.trend).toBeUndefined()
    expect(JSON.stringify(t).length).toBeLessThan(300)
    expect(JSON.stringify(prior).length).toBeGreaterThan(10000)
  })

  test('a pre-v9 prior keeps its missing basis, so it still reads as "on purchases"', () => {
    const t = trendSnapshotOf({ combined: { revenueTotal: 100, foodCostPct: 50 } })
    expect(t.combined).not.toHaveProperty('foodCostBasis')
    expect(foodCostBasisOf(t)).toBe('purchases')
    expect(t.pos).toBeNull()
  })

  test('deltas against the trimmed prior equal those against the full one, for every field shown', () => {
    const current = { combined: { ...prior.combined, revenueTotal: 121, foodCostPct: 33 }, pos: { totalNetSales: 150 } }
    const full = buildDeltas(current, prior)
    const trimmed = buildDeltas(current, trendSnapshotOf(prior))
    for (const k of ['foodCostBasisChanged', 'foodCostPct', 'laborCostPct', 'primeCostPct', 'netMarginPct']) expect(trimmed[k]).toEqual(full[k])
    expect(trimmed.revenueTotal).toEqual(full.revenueTotal)
    expect(trimmed.posNetSales).toEqual(full.posNetSales)
  })

  test('an unavailable prior stays null', () => {
    expect(trendSnapshotOf(null)).toBeNull()
  })
})

// S798 stage 2e, LABOUR-FIGURES-5. `new Date('YYYY-MM-DD')` is UTC midnight: 05:45 that day in
// Nepal, later than bsToAd's LOCAL midnight for the same day. So `endAd <= periodEndAd` failed for
// a leaver whose last day was the month's last day, and they dropped out of the frozen estimate.
// The bug shows only east of UTC; run this file with TZ=Asia/Kathmandu to see it (Jest cannot
// change the zone mid-run, and on a UTC machine the old parse happened to be right).
describe('estimatePayrollAccrual reads stored dates as local dates (S798 2e)', () => {
  const period = { bs_year: 2083, bs_month: 5 }
  const monthDays = daysInBsMonth(2083, 5)
  const firstDay = formatAd(bsToAd(2083, 5, 1))
  const lastDay = formatAd(bsToAd(2083, 5, monthDays))
  const base = { basic_salary: 30000, pay_basis: 'monthly', ssf_enrolled: false, ssf_no: null }

  test('a leaver whose last day is the month’s last day is paid the whole month', () => {
    const { gross } = estimatePayrollAccrual({
      employees: [{ ...base, id: 'ram', status: 'resigned', join_date: '2020-01-01', end_date: lastDay }], components: [], period,
    })
    expect(gross).toBeCloseTo(30000, 6)
  })

  test('a joiner on the first day accrues every day of it, and one on the last day accrues one day', () => {
    const whole = estimatePayrollAccrual({ employees: [{ ...base, id: 'a', status: 'active', join_date: firstDay }], components: [], period })
    expect(whole.gross).toBeCloseTo(30000, 6)
    const oneDay = estimatePayrollAccrual({ employees: [{ ...base, id: 'b', status: 'active', join_date: lastDay }], components: [], period })
    expect(oneDay.gross).toBeCloseTo(30000 / monthDays, 6)
  })
})

describe('the HR and overhead reads (S798 2e)', () => {
  const flat = fs.readFileSync(path.join(__dirname, 'computeMonthlyReport.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\s+/g, ' ')

  test('overheads: every bucket but labor, with the bucket selected (LABOUR-FIGURES-4)', () => {
    expect(flat).toContain("from('overheads').select('amount, bucket').eq('period_id', period.id).or(NON_LABOUR_OVERHEADS)")
    expect(flat).not.toContain("'bucket', 'overhead'")
  })

  test('leave: approved, overlapping the month, paged (LABOUR-FIGURES-6)', () => {
    const at = flat.indexOf("scopedFrom('hr_leave_requests'")
    expect(at).toBeGreaterThan(-1)
    expect(flat.slice(Math.max(0, at - 40), at)).toMatch(/fetchAllRows\(\(\) => $/)
    expect(flat.slice(at, at + 320)).toMatch(/\.eq\('status', 'approved'\)\.lte\('start_date', formatAd\(periodEndAd\)\)\.gte\('end_date', formatAd\(periodStartAd\)\) \.order\('id'\)\)/)
  })

  test('no stored date is parsed with new Date (LABOUR-FIGURES-5)', () => {
    expect(flat).not.toMatch(/new Date\((emp|lr)\./)
  })

  test('the schema version moved with the figures', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(12)
  })
})

describe('Net Margin subtracts Tax & Fees from schema v12 (S798 2e, LABOUR-FIGURES-4)', () => {
  const ims = { revenueTotal: 1000000, cogsTotal: 350000, overheadTotal: 100000, foodCostPct: 35, foodCostBasis: 'cogs' }
  const hr = { payroll: { total: 250000 } }

  test('NPR 45,000 of card fees, bank charges and the accountant come off the margin', () => {
    const c = computeCombinedMetrics({ ims: { ...ims, taxFeesTotal: 45000 }, hr })
    // (10 L − 3.5 L − 2.5 L − 1 L − 0.45 L) / 10 L
    expect(c.netMarginPct).toBeCloseTo(25.5, 9)
    expect(c.netMarginTaxFees).toBe(true)
    expect(netMarginTaxFeesOf({ combined: c })).toBe(true)
  })

  test('Trend gives no Net Margin change across the v11 → v12 line; the rest still compare', () => {
    const v12 = { combined: { revenueTotal: 110, foodCostPct: 35, laborCostPct: 25, primeCostPct: 60, netMarginPct: 25.5, foodCostBasis: 'cogs', netMarginTaxFees: true } }
    const v11 = { combined: { revenueTotal: 100, foodCostPct: 34, laborCostPct: 26, primeCostPct: 60, netMarginPct: 30, foodCostBasis: 'cogs' } }
    const d = buildDeltas(v12, v11)
    expect(d).toMatchObject({ foodCostBasisChanged: false, netMarginBasisChanged: true, netMarginPct: null })
    expect(d.foodCostPct).toBeCloseTo(1, 9)
    expect(d.primeCostPct).toBeCloseTo(0, 9)
    // Two v12 snapshots compare as usual, through the trimmed copy Trend stores.
    const prior = trendSnapshotOf({ combined: { ...v12.combined, netMarginPct: 20 } })
    expect(prior.combined.netMarginTaxFees).toBe(true)
    const same = buildDeltas(v12, prior)
    expect(same.netMarginBasisChanged).toBe(false)
    expect(same.netMarginPct).toBeCloseTo(5.5, 9)
  })
})

describe('Labor Analytics withholds the hour figures when most worked days have no times (S798 2e, H31)', () => {
  const present = (h) => ({ status: 'present', hours_worked: h })

  test('twelve staff marked Present with no times all month: withheld, and the count is kept', () => {
    const rows = [
      ...Array.from({ length: 330 }, () => present(0)),
      ...Array.from({ length: 30 }, () => present(8)),
      ...Array.from({ length: 40 }, () => ({ status: 'weekly_off', hours_worked: 0 })),
    ]
    expect(hoursCoverage(rows)).toEqual({ workingDays: 360, workingDaysWithoutHours: 330, hoursWithheld: true })
  })

  test('exactly half without times is not withheld; days off and leave are not worked days', () => {
    const rows = [present(0), present(8), { status: 'absent', hours_worked: 0 }, { status: 'paid_leave' }, { status: 'holiday' }]
    expect(hoursCoverage(rows)).toEqual({ workingDays: 2, workingDaysWithoutHours: 1, hoursWithheld: false })
  })

  test('a half day is a worked day', () => {
    expect(hoursCoverage([{ status: 'half_day', hours_worked: null }, { status: 'half_paid_leave', hours_worked: 4 }]))
      .toEqual({ workingDays: 2, workingDaysWithoutHours: 1, hoursWithheld: false })
  })

  test('the attendance read selects the status it counts by', () => {
    const src = fs.readFileSync(path.join(__dirname, 'computeLaborAnalyticsSection.js'), 'utf8')
    expect(src).toContain("scopedFrom('hr_attendance', clientId, 'status, hours_worked')")
  })
})

describe('labour is pay earned plus other labour paid from schema v13 (S798 3c)', () => {
  test('the combined figures carry the basis, and an older snapshot reads as gross', () => {
    const c = computeCombinedMetrics({ ims: { revenueTotal: 100, cogsTotal: 30, overheadTotal: 10, foodCostPct: 30, foodCostBasis: 'cogs' }, hr: { payroll: { total: 25 } } })
    expect(c.labourBasis).toBe('earned')
    expect(labourBasisOf({ combined: c })).toBe('earned')
    expect(labourBasisOf({ combined: { laborCostPct: 26 } })).toBe('gross')
  })

  test('Trend gives no Labor / Prime / Net Margin change across the v12 → v13 line', () => {
    const v13 = { combined: { revenueTotal: 110, foodCostPct: 35, laborCostPct: 41, primeCostPct: 76, netMarginPct: 9, foodCostBasis: 'cogs', netMarginTaxFees: true, labourBasis: 'earned' } }
    const v12 = { combined: { revenueTotal: 100, foodCostPct: 34, laborCostPct: 24, primeCostPct: 58, netMarginPct: 26, foodCostBasis: 'cogs', netMarginTaxFees: true } }
    const d = buildDeltas(v13, v12)
    expect(d).toMatchObject({ labourBasisChanged: true, laborCostPct: null, primeCostPct: null, netMarginPct: null })
    expect(d.foodCostPct).toBeCloseTo(1, 9)
    expect(d.revenueTotal.absoluteChange).toBeCloseTo(10, 9)
    // The trimmed copy Trend stores keeps the basis, so two v13 snapshots compare as usual.
    const prior = trendSnapshotOf({ combined: { ...v13.combined, laborCostPct: 30, primeCostPct: 65, netMarginPct: 15 } })
    expect(prior.combined.labourBasis).toBe('earned')
    const same = buildDeltas(v13, prior)
    expect(same.labourBasisChanged).toBe(false)
    expect(same.laborCostPct).toBeCloseTo(11, 9)
  })

  const flat = fs.readFileSync(path.join(__dirname, 'computeMonthlyReport.js'), 'utf8').replace(/\s+/g, ' ')
  test('the finalized run takes off the absence deduction and both paths add other labour', () => {
    expect(flat).toMatch(/total: gross - absenceDeduction \+ otAmount \+ ssfEmployer \+ other\.total/)
    expect(flat).toMatch(/total: accruedGross \+ otTotal \+ accruedSsfEmployer \+ other\.total/)
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(13)
  })
})
