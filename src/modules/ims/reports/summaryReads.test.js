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
]

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

describe.each(FILES)('%s nets the bill-level discount out of purchases', (_name, file) => {
  const flat = flatten(file)

  it('routes purchases through allocateBillDiscounts', () => {
    expect(flat).toMatch(/allocateBillDiscounts\(/)
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
    expect(flat).toMatch(/line(Gross|Net)/)
  })
})
