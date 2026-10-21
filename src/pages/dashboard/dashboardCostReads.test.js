// A source-reading test (the summaryReads.test.js pattern) for the two live dashboards. Every
// defect it pins is SILENT — a plausible number a little too high — so nothing else in the suite
// would notice one coming back.
//
// 1. BILL DISCOUNTS. `purchase_entries.discount_amount` is a bill-level figure repeated on every
//    line. Consolidated P&L and Monthly Summary take purchases net of it; both dashboards summed
//    a raw qty × rate, so Food Cost %, Prime Cost %, Net Margin % and Net Purchases disagreed with
//    those pages for the same month. The arithmetic itself is pinned in
//    ownerReport/computeMonthlyReport.test.js (netPurchaseFigures) and supplierAttribution.test.js.
// 2. EMPLOYER SSF. Payroll contributes only for staff who are enrolled AND have an SSF number
//    (isSsfContributor). The Owner Dashboard's labour estimate used the flag alone.
// 3. TIER LABELS. Overheads is a Growth feature; two upsells said Pro.
// 4. ONE READ PER TABLE (S849, OWNER-DASHBOARD-9). The Owner Dashboard's figures and its reorder tile
//    read five tables twice; its purchase read is now one union of columns, and the recipe walk reads
//    the recipe book from memory (`{ book }`). Its figure arithmetic lives in ownerDashboardData.js and,
//    since S853, its reads in ownerDashboardLoad.js (whose order ownerDashboardLoad.test.js pins).
import fs from 'fs'
import path from 'path'
import { FEATURE_TIER } from '../../shared/featureCatalog'

function flatten(file) {
  return fs.readFileSync(path.join(__dirname, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\s+/g, ' ')
}

function readSites(flat, table) {
  const out = []
  let i = flat.indexOf(`from('${table}')`)
  while (i !== -1) { out.push(i); i = flat.indexOf(`from('${table}')`, i + 1) }
  return out
}

const BILL_KEY = ['discount_amount', 'purchase_group_id', 'vendor_id', 'invoice_ref', 'bs_day']

const flattenAt = rel => fs.readFileSync(path.join(__dirname, ...rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ').replace(/\s+/g, ' ')

describe.each(['ClientDashboard.jsx'])('%s values purchases net of bill discounts', file => {
  const flat = flatten(file)

  test('routes purchases through allocateBillDiscounts and reads lineCost (the S792 D32 cost basis)', () => {
    expect(flat).toMatch(/allocateBillDiscounts\(/)
    expect(flat).toMatch(/\.lineCost\b/)
    expect(flat).not.toMatch(/\.lineNet\b/)
    expect(flat).toMatch(/returnCostValue\(/)
  })

  test('every purchase_entries read that selects a rate also selects the bill-discount columns', () => {
    const sites = readSites(flat, 'purchase_entries')
    expect(sites.length).toBeGreaterThan(0)
    let costReads = 0
    for (const at of sites) {
      const chain = flat.slice(at, at + 400)
      const select = (chain.match(/\.select\('([^']*)'/) || [])[1] || ''
      if (!/\brate\b/.test(select)) continue // a qty-only stock read values nothing
      // Overdue Payables settles against payable_payments, a different (VAT-inclusive) basis —
      // deliberately out of scope here, and named in the report that introduced this test.
      if (/\.is\('paid_at'/.test(chain)) continue
      costReads++
      for (const col of BILL_KEY) expect(`${file} @${at}: ${select}`).toContain(col)
      // S792 (D32): without these two the line is silently valued ex-VAT on a PAN-bill outlet.
      for (const col of ['vat_inclusive', 'vat_is_cost']) expect(`${file} @${at}: ${select}`).toContain(col)
    }
    expect(costReads).toBeGreaterThan(0)
  })
  test("every vendor_returns read that values a return embeds its line's VAT basis (S792, D32)", () => {
    const sites = readSites(flat, 'vendor_returns')
    let valued = 0
    for (const at of sites) {
      const select = (flat.slice(at, at + 300).match(/\.select\('([^']*)'/) || [])[1] || ''
      if (!/\brate\b/.test(select)) continue
      valued++
      expect(`${file} @${at}: ${select}`).toContain('purchase_entries(vat_inclusive, vat_is_cost)')
    }
    expect(valued).toBeGreaterThan(0)
  })
})

describe('OwnerDashboard values purchases net of bill discounts, from one read (S849)', () => {
  const page = flatten('OwnerDashboard.jsx')
  const data = flattenAt(['..', '..', 'modules', 'dashboard', 'ownerDashboardData.js'])
  // S853: the month's reads moved out of the page so their order can be tested.
  const load = flattenAt(['..', '..', 'modules', 'dashboard', 'ownerDashboardLoad.js'])
  const constOf = name => (load.match(new RegExp(`const ${name} = '([^']*)'`)) || [])[1] || ''

  test('the figures go through allocateBillDiscounts and lineCost (ownerDashboardData.js)', () => {
    expect(data).toMatch(/allocateBillDiscounts\(/)
    expect(data).toMatch(/\.lineCost\b/)
    expect(data).not.toMatch(/\.lineNet\b/)
    expect(data).toMatch(/returnCostValue\(/)
    expect(page).toMatch(/netSpendOf\(/)
  })

  test('ONE purchase_entries read for the month, with the bill keys, the VAT basis and the cash/credit columns', () => {
    expect(readSites(page, 'purchase_entries')).toHaveLength(0)
    expect(readSites(load, 'purchase_entries')).toHaveLength(1)
    const cols = constOf('PURCHASE_COLS')
    for (const col of [...BILL_KEY, 'vat_inclusive', 'vat_is_cost', 'id', 'payment_method', 'item_id', 'qty', 'rate']) expect(cols).toContain(col)
    expect(load).toMatch(/from\('purchase_entries'\)\.select\(PURCHASE_COLS\)/)
    expect(page).toMatch(/startMonthBatch\(\{/)
  })

  test("the returns read embeds its line's VAT basis and carries what billPayables needs", () => {
    const cols = constOf('RETURN_COLS')
    // `period_id` (S853, D2): which returns are against an earlier month's bill.
    expect(cols).toContain('purchase_entries(vat_inclusive, vat_is_cost, period_id)')
    for (const col of ['purchase_entry_id', 'payment_method', 'bs_day']) expect(cols).toContain(col)
    expect(load).toMatch(/scopedFrom\('vendor_returns', RETURN_COLS\)/)
  })

  test('Cash / Credit takes a return against an earlier bill at that bill discount (S853, D2)', () => {
    expect(load).toMatch(/readPrior\(ids\)/)
    expect(page).toMatch(/cashCreditSplit\(purchases\.data, returns\.data, period, \{ priorBillLines: priorBills\.data \}\)/)
  })

  test('the month of sales is paged with every page after the first at once, on a unique tiebreaker', () => {
    expect(load).toMatch(/fetchAllRowsParallel\(opts => supabase\.from\('sales_entries'\)\.select\(SALES_COLS, opts\)\.eq\('period_id', pid\)\.order\('id'\)\)/)
  })

  test('the recipe walk reads the recipe book in memory', () => {
    expect(load).toMatch(/loadRecipeBook\(scopedFrom\)/)
    expect(page).toMatch(/explodeRecipeIngredients\(supabase, recipeIds, book \? \{ book \} : undefined\)/)
  })
})

describe('the HR wage estimate adds employer SSF only for real contributors (labourEstimate.js)', () => {
  const flat = flattenAt(['..', '..', 'modules', 'dashboard', 'labourEstimate.js'])

  test('the hr_employees columns include ssf_no', () => {
    expect((flat.match(/ESTIMATE_EMPLOYEE_COLUMNS = '([^']*)'/) || [])[1]).toContain('ssf_no')
  })

  test('the estimate gates on isSsfContributor, never the enrolment flag alone', () => {
    expect(flat).toMatch(/isSsfContributor\(emp\)/)
    expect(flat).not.toMatch(/if \(\s*emp\.ssf_enrolled\s*\)/)
  })
})

describe('Overheads upsells name the plan it is sold on', () => {
  test('Overheads is a Growth feature in the catalog', () => {
    expect(FEATURE_TIER.overheads).toBe('growth')
  })

  test.each(['ClientDashboard.jsx', 'OwnerDashboard.jsx'])('%s does not hardcode a tier for it', file => {
    const flat = flatten(file)
    expect(flat).not.toMatch(/Requires Overheads \(Pro\)/)
    expect(flat).not.toMatch(/label="Fixed Costs & Net Margin" tier="Pro"/)
    expect(flat).toMatch(/FEATURE_TIER\.overheads/)
  })
})
