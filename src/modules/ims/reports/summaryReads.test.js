// A source-reading test, the nepalMoney.test.js / salesReads.test.js pattern: both defects it
// pins are SILENT, so nothing else in the suite would catch either of them coming back.
//
// The four pages are the nav's "Summary & comparison" group — Monthly Summary, Annual Summary,
// Period Comparison and Budget vs Actual. Between them they answer "what did this month cost" at
// four altitudes, so the one thing they must never do is answer it differently.
//
// 1. PAGING. Every table below is one row per item per PERIOD, and two of these pages read 12 and
//    24 periods at once. Two hundred items is 2,400 opening rows against PostgREST's silent
//    1000-row cap. A truncated opening_stock/closing_stock read is indistinguishable from an
//    uncounted month: COGS collapses to net purchases, FC% is nonsense, and `firstError()` sees
//    nothing, because truncation returns no error rather than a short one. Without `.order()` the
//    months that lose their stock differ between loads, so the same page shows two different
//    years on two visits.
//
// 2. BILL DISCOUNTS. `purchase_entries.discount_amount` is a BILL-level figure repeated on every
//    line of the bill. Until S720 only MonthlySummary and ConsolidatedPnl deduped and allocated
//    it; the other three charged the undiscounted price into COGS and into "net purchases", so
//    the same month's cost differed between two pages a client reads side by side. S601 fixed
//    this in three places and the fix did not travel to the fourth, fifth and sixth.
import fs from 'fs'
import path from 'path'

const FILES = [
  ['MonthlySummary.js',   path.join(__dirname, 'MonthlySummary.js')],
  ['AnnualSummary.js',    path.join(__dirname, 'AnnualSummary.js')],
  ['PeriodComparison.js', path.join(__dirname, 'PeriodComparison.js')],
  ['BudgetVsActual.js',   path.join(__dirname, 'BudgetVsActual.js')],
  ['ConsolidatedPnl.jsx', path.join(__dirname, '../../../pages/dashboard/ConsolidatedPnl.jsx')],
]

// 4. ONE ARITHMETIC (S774). Monthly Summary and Consolidated P&L each carried their own copy of the
//    revenue and COGS rules, and the copies had already drifted (the P&L paged none of its
//    per-item reads). Both now call periodCost.js, so for those two the arithmetic assertions below
//    look for the shared call and periodCost.js itself carries the inline form. The READS stay in
//    each page, which is why paging and the selected columns are still checked per page.
const SHARED_COST = new Set(['MonthlySummary.js', 'ConsolidatedPnl.jsx'])
const PERIOD_COST = path.join(__dirname, 'periodCost.js')
// Budget vs Actual delegates its purchase arithmetic to budgetActuals.js (S792, FIGURES-9), which is
// tested against Monthly Summary's own figures in budgetActuals.test.js; its READS stay here.
const BUDGET_ACTUALS = path.join(__dirname, 'budgetActuals.js')
const DELEGATES = { 'BudgetVsActual.js': /budgetActuals\(/ }

// One row per item per period (staff_meals is per item per DAY), so every one of them scales with
// the window these pages read. `items` is in the list because it is the read that yields the ids
// everything else is joined against — the S706/S708 lesson that paging the consumer and not the
// producer has not finished the job.
const PER_ITEM_TABLES = [
  'items', 'opening_stock', 'closing_stock', 'staff_meals',
  'wastages', 'purchase_entries', 'vendor_returns',
]

/** Source with comments removed and whitespace flattened, so a wrapped builder chain reads as one
 *  line and a comment naming a table cannot satisfy the assertion. */
function flatten(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\s+/g, ' ')
}

/** Every index in `flat` at which a read of `table` begins. */
function readSites(flat, table) {
  const out = []
  for (const form of [`from( '${table}' )`, `from('${table}')`, `scopedFrom( '${table}'`, `scopedFrom('${table}'`]) {
    let i = flat.indexOf(form)
    while (i !== -1) { out.push(i); i = flat.indexOf(form, i + 1) }
  }
  return out
}

describe.each(FILES)('%s pages its per-item-per-period reads', (name, file) => {
  const flat = flatten(file)

  it.each(PER_ITEM_TABLES)('wraps every %s read in fetchAllRows', table => {
    for (const at of readSites(flat, table)) {
      // 90 flattened characters is comfortably longer than `fetchAllRows(() => supabase.` and
      // shorter than the distance to the previous array element, so a bare read cannot borrow
      // its neighbour's wrapper.
      const before = flat.slice(Math.max(0, at - 90), at)
      expect(`${name} ${table} @${at}: ${before.slice(-70)}`)
        .toMatch(/fetchAllRows(Chunked)?\(/)
    }
  })

  it('gives every paged read a unique sort tiebreaker', () => {
    // fetchAllRows pages with .range(), so a query whose sort is not unique repeats a row on one
    // page and skips it on the next. `.order('id')` is the tiebreaker every call site uses.
    const sites = PER_ITEM_TABLES.flatMap(t => readSites(flat, t))
    expect(sites.length).toBeGreaterThan(0)
    for (const at of sites) {
      // The chain runs from the table name to the close of the fetchAllRows call; 320 flattened
      // characters covers the longest of them (purchase_entries' column list).
      expect(flat.slice(at, at + 320)).toMatch(/\.order\(\s*'id'/)
    }
  })
})

describe.each(FILES)('%s nets the bill-level discount out of purchases', (name, file) => {
  const flat = flatten(file)
  const shared = SHARED_COST.has(name)

  it('routes purchases through allocateBillDiscounts', () => {
    expect(flat).toMatch(shared ? /periodStockMaps\(/ : DELEGATES[name] || /allocateBillDiscounts\(/)
  })

  it('selects the columns allocateBillDiscounts needs', () => {
    // `discount_amount` is the figure; `purchase_group_id` is what dedupes it (it is repeated on
    // every line), and the vendor/invoice/day trio is the fallback key for bills written before
    // grouping existed — the `a || b` identity rule in vendor-payables.md.
    const at = readSites(flat, 'purchase_entries')[0]
    expect(at).toBeGreaterThan(-1)
    const chain = flat.slice(at, at + 320)
    for (const col of ['discount_amount', 'purchase_group_id', 'vendor_id', 'invoice_ref', 'bs_day']) {
      expect(`${chain}`).toContain(col)
    }
  })

  it('builds its purchase figures from lineGross / lineNet, not a raw qty × rate', () => {
    // The shape this replaces: summing the purchase row's own qty × rate ignores the bill's
    // discount entirely. Only allocateBillDiscounts' two derived values may feed a purchase
    // figure on these pages.
    expect(flat).toMatch(shared ? /valuePeriodItems\(/ : DELEGATES[name] || /line(Gross|Net)/)
  })
})

// 5. HIDING NEVER CHANGES HISTORY (S792, FIGURES-1 / owner decision D29). Every one of these pages
//    read `items` with `.eq('is_active', true)` and valued purchases and returns only for the ids in
//    that list, so hiding an item — Item Master's own advice on a unit change — took its purchases
//    out of every past month's Net Purchases, COGS and FC%, closed months included, while the frozen
//    Owner Report kept them. The item read that produces the valued ids must not filter on
//    `is_active`; it must still drop sub-recipe mirrors (prep is counted at the raw-item level).
//    Silent by construction: nothing errors, a past month just reads lower than it did.
describe.each(FILES)('%s values hidden items in past months', (name, file) => {
  const flat = flatten(file)
  const itemReads = readSites(flat, 'items').map(at => flat.slice(at, at + 200))

  it('reads items at least once', () => {
    expect(itemReads.length).toBeGreaterThan(0)
  })

  it('filters no item read on is_active, and keeps every one on is_sub_recipe = false', () => {
    for (const read of itemReads) {
      // The chain runs to its `.order('id')`; the 200-character window can reach the next read.
      const chain = read.slice(0, read.indexOf(".order('id'"))
      expect(`${name}: ${chain}`).not.toMatch(/\.eq\(\s*'is_active'/)
      expect(`${name}: ${chain}`).toMatch(/\.eq\(\s*'is_sub_recipe',\s*false\s*\)/)
    }
  })
})

describe('budgetActuals.js holds the arithmetic Budget vs Actual delegates to', () => {
  const flat = flatten(BUDGET_ACTUALS)

  it('nets bill discounts through allocateBillDiscounts, from lineCost (the D32 cost basis)', () => {
    expect(flat).toMatch(/allocateBillDiscounts\(/)
    expect(flat).toMatch(/\.lineCost\b/)
    expect(flat).toMatch(/returnCostValue\(/)
  })
})

// 3. NULL-SOURCE ROWS (S756). `sales_entries.source` is nullable, and a server-side
//    `.neq('source', 'pos_comp')` drops every legacy NULL row (`NULL <> x` is NULL), so revenue —
//    the denominator of every FC% on these pages — read short. Comps are filtered in JS instead,
//    which only works if `source` is actually selected.
const REVENUE_FILES = FILES.filter(([name]) => name !== 'BudgetVsActual.js')

describe.each(REVENUE_FILES)('%s keeps NULL-source sales rows', (name, file) => {
  const flat = flatten(file)

  it('has no server-side .neq on source', () => {
    expect(flat).not.toMatch(/\.neq\(\s*'source'/)
  })

  it('selects source on its sales_entries read and filters comps in JS', () => {
    const at = readSites(flat, 'sales_entries')[0]
    expect(`${name} ${at}`).not.toMatch(/ -1$/)
    expect(flat.slice(at, at + 200)).toMatch(/select\('[^']*\bsource\b/)
    expect(flat).toMatch(SHARED_COST.has(name) ? /periodRevenue\(/ : /source !== 'pos_comp'/)
  })
})

describe('periodCost.js holds the arithmetic its two callers delegate to', () => {
  const flat = flatten(PERIOD_COST)

  it('nets bill discounts through allocateBillDiscounts, on the cost basis (lineGrossCost / lineCost, S792 D32)', () => {
    expect(flat).toMatch(/allocateBillDiscounts\(/)
    expect(flat).toMatch(/\.lineGrossCost\b/)
    expect(flat).toMatch(/\.lineCost\b/)
    expect(flat).toMatch(/returnCostValue\(/)
  })

  it('filters comps in JS', () => {
    expect(flat).toMatch(/source !== 'pos_comp'/)
  })
})

// 6. SUPPLIER VAT AS FOOD COST (S792, owner decision D32). On a PAN-bill outlet the 13% on a VAT line
//    of a `vat_is_cost` bill is food cost, and allocateBillDiscounts' `lineCost` carries it — but only
//    if the read SELECTS `vat_inclusive` and `vat_is_cost`; a row without them is silently ex-VAT, as
//    is a return read without its line's embed. Silent by construction, so pinned here per page.
describe.each(FILES)('%s reads what the D32 cost basis needs', (name, file) => {
  const flat = flatten(file)

  it('selects vat_inclusive and vat_is_cost on every purchase_entries read', () => {
    const sites = readSites(flat, 'purchase_entries')
    expect(sites.length).toBeGreaterThan(0)
    for (const at of sites) {
      const chain = flat.slice(at, at + 320)
      expect(`${name} @${at}: ${chain}`).toMatch(/\bvat_inclusive\b/)
      expect(`${name} @${at}: ${chain}`).toMatch(/\bvat_is_cost\b/)
    }
  })

  it("embeds each return's line basis", () => {
    const sites = readSites(flat, 'vendor_returns')
    expect(sites.length).toBeGreaterThan(0)
    for (const at of sites) {
      expect(flat.slice(at, at + 200)).toContain('purchase_entries(vat_inclusive, vat_is_cost)')
    }
  })

  it('values purchases on the cost basis, never lineNet', () => {
    if (SHARED_COST.has(name) || DELEGATES[name]) return   // periodCost.js / budgetActuals.js carry it
    expect(flat).toMatch(/\.lineCost\b/)
    expect(flat).not.toMatch(/\.lineNet\b/)
  })
})
