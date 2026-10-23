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
  netPurchaseFigures, CURRENT_SCHEMA_VERSION,
  computeCombinedMetrics, buildDeltas, foodCostBasisOf, trendSnapshotOf, netMarginTaxFeesOf, labourBasisOf,
  netMarginPnlCostsOf, resolveReportLabour, employmentInMonth, attendanceRate, leaveDaysInMonth,
} from './computeMonthlyReport'
// eslint-disable-next-line import/first
import { hoursCoverage } from './computeLaborAnalyticsSection'
// eslint-disable-next-line import/first
import { computeInventoryTurnover } from './computeInventoryTurnover'
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
    expect(netPurchaseFigures(null, undefined)).toEqual({ purchaseTotal: 0, cashNet: 0, creditNet: 0, transferIn: 0, transferOut: 0 })
  })

  // S849 (PNL-8, schema 18): a stock transfer moves Net Purchases like a purchase / a return, and the
  // Cash / Credit split stays supplier-only.
  test('transfers in add and transfers out come off Net Purchases, not the Cash / Credit split', () => {
    const purchases = [line({ qty: 10, rate: 100 })]
    const transfers = [
      { item_id: 'i1', direction: 'in', qty: 2, rate: 100, value: 200 },
      { item_id: 'i2', direction: 'out', qty: 1, rate: 50, value: 50 },
    ]
    const f = netPurchaseFigures(purchases, [], transfers)
    expect(f.purchaseTotal).toBeCloseTo(1000 + 200 - 50, 6)
    expect(f).toMatchObject({ cashNet: 1000, creditNet: 0, transferIn: 200, transferOut: 50 })
  })
})

// The estimate's own cases (employer SSF only for a contributor, on basic; a leaver on the month's
// last day; joiners) moved with the estimate to labourEstimate.test.js (S849, GAPS-4): the report now
// runs the ONE HR estimate every Suite page uses.

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

  // S849 (GAPS-4, OWNER-REPORT-16): the HR inputs come through the shared, paged reads and the ONE
  // estimate; the report keeps no estimate of its own (employer SSF is gated inside estimateLabour).
  test('the HR section runs the shared estimate over the shared paged reads', () => {
    expect(flat).toContain('loadLabourEstimateInputs(from, period)')
    expect(flat).toContain('estimateLabour({ ...inputs, period, throughDay: monthDays })')
    expect(flat).not.toMatch(/estimatePayrollAccrual\(/)
    expect(flat).not.toMatch(/scopedFrom\('hr_employees'/)
    expect(flat).not.toMatch(/if \(\s*emp\.ssf_enrolled\s*\)/)
  })

  test('the Food Cost thresholds and the stock transfers are read for the frozen report (S849)', () => {
    expect(flat).toContain("supabase.from('settings').select('fc_warning_pct, fc_critical_pct').eq('client_id', clientId).maybeSingle()")
    expect(flat).toContain('readPeriodTransfers((t, c) => scopedFrom(t, clientId, c), period.id)')
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
      countGapMaterial: false,
      sectionErrors: null,
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

describe('the HR and overhead reads (S798 2e)', () => {
  const flat = fs.readFileSync(path.join(__dirname, 'computeMonthlyReport.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\s+/g, ' ')

  // S849 (GAPS-4 / OWNER-REPORT-9): every bucket, so the Labor tab can be labour without HR and be
  // named "not counted" beside payroll with HR. Split by splitOverheadBuckets.
  test('overheads: every bucket, with the bucket selected (LABOUR-FIGURES-4, GAPS-4)', () => {
    expect(flat).toContain("from('overheads').select('amount, bucket').eq('period_id', period.id),")
    expect(flat).not.toContain('.or(NON_LABOUR_OVERHEADS)')
    expect(flat).toContain('splitOverheadBuckets(overheadsData)')
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
    // payrollLabourTotal is gross − absence deduction + overtime + employer SSF (labourSource.js).
    expect(flat).toMatch(/const payrollBase = payrollLabourTotal\(payslips \|\| \[\]\)/)
    expect(flat).toMatch(/total: payrollBase \+ other\.total/)
    expect(flat).toMatch(/total: est\.amount \+ other\.total/)
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(13)
  })
})

// ── Schema 18 (S849) ─────────────────────────────────────────────────────────────────────────────

describe('Net Margin takes off what Consolidated P&L takes off (S849, GAPS-1 / PNL-1)', () => {
  // GAPS-1's worked month.
  const ims = {
    revenueTotal: 900000, cogsTotal: 314000, cogsWastageTotal: 14000, staffMealsValueTotal: 22000,
    overheadTotal: 120000, taxFeesTotal: 18000, foodCostPct: 314000 / 9000, foodCostBasis: 'cogs',
  }
  const labour = { source: 'payroll', amount: 234000, laborTabNotCounted: 0, reason: '', noPayCount: 0 }

  test('raw stock wasted and staff meals come off: 19.8%', () => {
    const c = computeCombinedMetrics({ ims, labour })
    expect(c.netMarginPct).toBeCloseTo(19.78, 2)
    expect(c.netMarginPnlCosts).toBe(true)
    expect(netMarginPnlCostsOf({ combined: c })).toBe(true)
    // Prime Cost stays Food Cost % + Labour % (D30): wastage and staff meals are not in it.
    expect(c.primeCostPct).toBeCloseTo(314000 / 9000 + 26, 6)
  })

  test('delivery commission comes off too', () => {
    const c = computeCombinedMetrics({ ims, labour, deliveryCommission: { amount: 9000, unsettledBills: 2 } })
    expect(c.netMarginPct).toBeCloseTo(((178000 - 9000) / 900000) * 100, 6)
  })

  test('a failed commission read is no Net Margin, never one without it', () => {
    const c = computeCombinedMetrics({ ims, labour, deliveryCommission: null, commissionFailed: true })
    expect(c.netMarginPct).toBeNull()
    expect(c.foodCostPct).toBeCloseTo(34.89, 2)
  })

  test('Trend gives no Net Margin change across the v17 → v18 line; the rest still compare', () => {
    const base = { revenueTotal: 110, foodCostPct: 35, laborCostPct: 25, primeCostPct: 60, foodCostBasis: 'cogs', netMarginTaxFees: true, labourBasis: 'earned' }
    const v18 = { combined: { ...base, netMarginPct: 18, netMarginPnlCosts: true } }
    const v17 = { combined: { ...base, laborCostPct: 26, netMarginPct: 22 } }
    const d = buildDeltas(v18, v17)
    expect(d).toMatchObject({ netMarginCostsChanged: true, netMarginBasisChanged: false, netMarginPct: null })
    expect(d.laborCostPct).toBeCloseTo(-1, 9)
    // Two v18 snapshots compare, through the trimmed copy Trend stores.
    const prior = trendSnapshotOf({ combined: { ...v18.combined, netMarginPct: 15 } })
    expect(prior.combined.netMarginPnlCosts).toBe(true)
    const same = buildDeltas(v18, prior)
    expect(same.netMarginCostsChanged).toBe(false)
    expect(same.netMarginPct).toBeCloseTo(3, 9)
  })
})

describe('a failed IMS section keeps the rule markers (S849, OWNER-REPORT-2)', () => {
  test('no figures, but the basis a reader needs is still there', () => {
    const c = computeCombinedMetrics({ ims: null, labour: null })
    expect(c).toMatchObject({
      revenueTotal: null, foodCostPct: null, netMarginPct: null,
      foodCostBasis: 'cogs', netMarginTaxFees: true, labourBasis: 'earned', netMarginPnlCosts: true,
    })
  })

  test('a Trend copy names the prior’s failed sections', () => {
    const t = trendSnapshotOf({ combined: {}, sectionErrors: { ims: 'Failed to fetch', trend: 'x' } })
    expect(t.sectionErrors).toEqual(['ims', 'trend'])
  })
})

describe('labour by the one rule (S849, GAPS-4 / OWNER-REPORT-9, SU11 a, SU18)', () => {
  const ims = { revenueTotal: 1000000, cogsTotal: 300000, overheadTotal: 100000, taxFeesTotal: 0, foodCostPct: 30, foodCostBasis: 'cogs' }
  const other = { festival: 0, incentive: 0, settlement: 0, total: 0 }

  test('with Crest HR, payroll is labour and a Labor tab beside it is named, never added', () => {
    const labour = resolveReportLabour({ hrIncluded: true, hrLabour: { payroll: 288000, estimate: null, otherPay: other }, ims: { ...ims, laborTabTotal: 250000 } })
    expect(labour).toEqual({ source: 'payroll', amount: 288000, laborTabNotCounted: 250000, reason: '', noPayCount: 0 })
    const c = computeCombinedMetrics({ ims, labour })
    expect(c.laborCostPct).toBeCloseTo(28.8, 9)
    expect(c.netMarginPct).toBeCloseTo((1000000 - 300000 - 288000 - 100000) / 10000, 9)
  })

  test('with Crest HR and no run, the estimate; no pay set withholds the verdict and says how many', () => {
    const estimate = { amount: 200000, noPay: [{ id: 'a' }, { id: 'b' }], onPayroll: 6 }
    const labour = resolveReportLabour({ hrIncluded: true, hrLabour: { payroll: null, estimate, otherPay: other }, ims })
    expect(labour).toMatchObject({ source: 'estimate', amount: 200000, reason: 'nopay', noPayCount: 2 })
  })

  test('without Crest HR, a Labor tab of 1,60,000 is labour, from Overheads', () => {
    const labour = resolveReportLabour({ hrIncluded: false, hrLabour: null, ims: { ...ims, laborTabTotal: 160000 } })
    expect(labour).toMatchObject({ source: 'overheads', amount: 160000, laborTabNotCounted: 0 })
    const c = computeCombinedMetrics({ ims, labour })
    expect(c.laborCostPct).toBeCloseTo(16, 9)
    expect(c.netMarginPct).toBeCloseTo(44, 9)
  })

  test('without Crest HR and an empty Labor tab: no Labor Cost %, Net Margin still shown', () => {
    const labour = resolveReportLabour({ hrIncluded: false, hrLabour: null, ims: { ...ims, laborTabTotal: 0 } })
    expect(labour).toMatchObject({ source: 'none', amount: 0 })
    const c = computeCombinedMetrics({ ims, labour })
    expect(c.laborCostPct).toBeNull()
    expect(c.primeCostPct).toBeNull()
    expect(c.netMarginPct).toBeCloseTo(60, 9)
  })

  test('the HR section failed: no labour and no Net Margin — never the Labor tab instead', () => {
    const labour = resolveReportLabour({ hrIncluded: true, hrLabour: null, ims: { ...ims, laborTabTotal: 160000 } })
    expect(labour).toMatchObject({ source: 'failed', amount: null })
    const c = computeCombinedMetrics({ ims, labour })
    expect(c.laborCostPct).toBeNull()
    expect(c.netMarginPct).toBeNull()
  })

  test('no IMS section: no labour figure at all', () => {
    expect(resolveReportLabour({ hrIncluded: true, hrLabour: { payroll: 1 }, ims: null })).toBeNull()
  })
})

describe('Staff Employed is decided by dates, not today’s status (S849, OWNER-REPORT-7)', () => {
  // CASA's live shape: two staff still working, two leavers whose End Dates are 30 Shrawan and the
  // last day of Bhadra 2082, both now marked resigned.
  const day = (m, d) => formatAd(bsToAd(2082, m, d))
  const staff = [
    { id: 'a', status: 'active', join_date: '2020-01-01', end_date: null },
    { id: 'b', status: 'probation', join_date: '2020-01-01', end_date: null },
    { id: 'c', status: 'resigned', join_date: '2020-01-01', end_date: day(4, 30) },
    { id: 'd', status: 'resigned', join_date: '2020-01-01', end_date: day(5, daysInBsMonth(2082, 5)) },
  ]
  const tally = m => {
    const start = bsToAd(2082, m, 1), end = bsToAd(2082, m, daysInBsMonth(2082, m))
    const rows = staff.map(e => employmentInMonth(e, start, end))
    return { employed: rows.filter(r => r.employed).length, left: rows.filter(r => r.left).length }
  }

  test('Ashadh counts all four; Shrawan counts four, one of whom left', () => {
    expect(tally(3)).toEqual({ employed: 4, left: 0 })
    expect(tally(4)).toEqual({ employed: 4, left: 1 })
    expect(tally(6)).toEqual({ employed: 2, left: 0 })
  })

  test('a resigned employee with no End Date is unknown, not counted', () => {
    const start = bsToAd(2082, 4, 1), end = bsToAd(2082, 4, daysInBsMonth(2082, 4))
    expect(employmentInMonth({ status: 'resigned', join_date: '2020-01-01', end_date: null }, start, end))
      .toEqual({ employed: false, joined: false, left: false, unknown: true })
  })

  test('a joiner in the month is employed and joined; one joining after it is not employed', () => {
    const start = bsToAd(2082, 4, 1), end = bsToAd(2082, 4, daysInBsMonth(2082, 4))
    expect(employmentInMonth({ status: 'active', join_date: day(4, 10) }, start, end)).toMatchObject({ employed: true, joined: true })
    expect(employmentInMonth({ status: 'active', join_date: day(5, 1) }, start, end)).toMatchObject({ employed: false })
  })
})

describe('Attendance Rate is over the days staff were due to work (S849, OWNER-REPORT-13)', () => {
  test('12 staff × 31 days, 4 weekly offs and a holiday each, full attendance: 100%', () => {
    const rows = []
    for (let e = 0; e < 12; e++) {
      for (let d = 1; d <= 31; d++) rows.push({ status: d <= 4 ? 'weekly_off' : d === 5 ? 'holiday' : 'present' })
    }
    const a = attendanceRate(rows)
    expect(a.workingDays).toBe(12 * 26)
    expect(a.rate).toBeCloseTo(100, 9)
    expect(a.basis).toBe('working_days')
  })

  test('paid leave counts as present, unpaid leave as absent; no rows is no figure', () => {
    const a = attendanceRate([{ status: 'present' }, { status: 'paid_leave' }, { status: 'unpaid_leave' }, { status: 'half_day' }])
    expect(a.rate).toBeCloseTo((2.5 / 4) * 100, 9)
    expect(attendanceRate([])).toBeNull()
    expect(attendanceRate([{ status: 'weekly_off' }]).rate).toBeNull()
  })
})

describe('a leave crossing a month edge counts only its days inside the month (S849, OWNER-REPORT-14)', () => {
  test('10 days from 28 Shrawan to 5 Bhadra 2082: the two months add up to 10', () => {
    const lr = { start_date: formatAd(bsToAd(2082, 4, 28)), end_date: formatAd(bsToAd(2082, 5, 5)), days: 10 }
    const month = m => leaveDaysInMonth(lr, bsToAd(2082, m, 1), bsToAd(2082, m, daysInBsMonth(2082, m)))
    expect(month(4) + month(5)).toBe(10)
    expect(month(4)).toBeGreaterThan(0)
    expect(month(6)).toBe(0)
  })

  test('a request wholly inside the month keeps its stored days', () => {
    const lr = { start_date: formatAd(bsToAd(2082, 4, 3)), end_date: formatAd(bsToAd(2082, 4, 9)), days: 5 }
    expect(leaveDaysInMonth(lr, bsToAd(2082, 4, 1), bsToAd(2082, 4, daysInBsMonth(2082, 4)))).toBe(5)
  })
})

describe('Trend withholds the verdict when either month’s count was incomplete (S849, OWNER-REPORT-12)', () => {
  const cur = { combined: { revenueTotal: 110, foodCostPct: 33, foodCostBasis: 'cogs' }, ims: { countGap: { material: false } } }
  test('a material gap on either side', () => {
    const priorGap = { combined: { revenueTotal: 100, foodCostPct: 30, foodCostBasis: 'cogs' }, ims: { countGap: { material: true } } }
    expect(buildDeltas(cur, priorGap).verdictWithheld).toBe(true)
    expect(buildDeltas({ ...cur, ims: { countGap: { material: true } } }, { combined: { foodCostBasis: 'cogs' } }).verdictWithheld).toBe(true)
    // The trimmed copy carries it.
    expect(buildDeltas(cur, trendSnapshotOf(priorGap)).verdictWithheld).toBe(true)
    // The delta itself is still there.
    expect(buildDeltas(cur, priorGap).foodCostPct).toBeCloseTo(3, 9)
  })
  test('no gap: judged as before', () => {
    expect(buildDeltas(cur, { combined: { foodCostBasis: 'cogs' }, ims: { countGap: { material: false } } }).verdictWithheld).toBe(false)
  })
})

describe('Inventory Turnover is COGS over the stock of the same items (S849, OWNER-REPORT-15)', () => {
  test('used ÷ average of the passed opening and closing', () => {
    const t = computeInventoryTurnover({ usedValue: 300000, openingValue: 80000, closingValue: 120000, monthDays: 30 })
    expect(t).toEqual({ cogsUsedValue: 300000, avgInventoryValue: 100000, turnoverRatio: 3, daysOnHand: 10, basis: 'cogs' })
    expect(computeInventoryTurnover({ usedValue: 5, openingValue: 0, closingValue: 0, monthDays: 30 }).turnoverRatio).toBeNull()
  })
})

test('the schema version moved for S855', () => {
  expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(19)
})

// S862 REPORTS-STOCK-1: Comped Bills' food cost includes the choices (computeMonthlyReport.pos.test.js).
test('the schema version moved for S862', () => {
  expect(CURRENT_SCHEMA_VERSION).toBe(20)
})
