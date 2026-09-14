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

describe.each(['ClientDashboard.jsx', 'OwnerDashboard.jsx'])('%s values purchases net of bill discounts', file => {
  const flat = flatten(file)

  test('routes purchases through allocateBillDiscounts and reads lineNet', () => {
    expect(flat).toMatch(/allocateBillDiscounts\(/)
    expect(flat).toMatch(/\.lineNet\b/)
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
    }
    expect(costReads).toBeGreaterThan(0)
  })
})

describe('OwnerDashboard adds employer SSF only for real contributors', () => {
  const flat = flatten('OwnerDashboard.jsx')

  test('the hr_employees read selects ssf_no', () => {
    const at = flat.indexOf("scopedFrom('hr_employees'")
    expect(at).toBeGreaterThan(-1)
    expect(flat.slice(at, at + 160)).toContain('ssf_no')
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
