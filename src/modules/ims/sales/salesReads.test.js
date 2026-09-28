// A source-reading test, the nepalMoney.test.js / legalHash.test.js pattern: the defect it pins
// has no runtime symptom, so nothing else would catch it coming back.
//
// `sales_entries.source` is nullable — DEFAULT 'manual', no NOT NULL — so a row written before the
// column had a default reads as NULL. In SQL `NULL <> 'pos_comp'` is NULL rather than true, which
// means a SERVER-side `.neq('source', 'pos_comp')` silently drops every one of those legacy rows.
// On a dashboard that under-reports. On THIS page it deletes: a row missing from the grid is
// missing from the save payload, findSupersededRows only inspects the opposite entry mode, and
// save_sales_day's delete covers `source IS NULL OR source = 'manual'` — so the next Save Day
// removes a row nobody was ever shown. Filter comps in JS, over a `source` column that is selected.
//
// Covers the files that have had this decision MADE, not every file that reads the table. ~12
// others still carry the server-side form; every one is display-only and cannot delete a row, and
// each needs its own answer to what its figure is supposed to mean before it is changed.
//
// Menu Engineering joined in S715. Its figure is not display-only in the harmless sense: the qty
// map sets the period's MEDIAN, which is the popularity cutoff, so dropping the legacy rows did
// not shorten one column — it could move any dish on the menu into a different quadrant, and
// then write that quadrant back to recipes.me_class for the POS suggestion engine to act on.
//
// Overheads joined next, for the same kind of reason. Revenue there is not one column among many:
// it is the DENOMINATOR of every percentage on the page, while the numerator (food cost) comes
// from purchases and stayed whole. So a short revenue pushed Food Cost % and every "% of revenue"
// up, pushed break-even up, and pushed Net Profit down — and Net Profit's sign is what picks
// between a green "✓ Profitable this period" and a red "✗ Operating at a loss this period".
import fs from 'fs'
import path from 'path'

// The four stock reads joined in S717. Their figure is CONSUMPTION, which is subtracted from what
// was bought — so a short read does not shorten a column, it leaves stock on the shelf that is not
// there (Stock Report / Reorder Report: on-hand and "below par", i.e. what gets bought) or takes
// batches off one that is (FIFO / Stock Ageing: what is about to go off). FifoReport was the last
// page summing these rows raw rather than through selectDepletingSales; the other three already
// went through it and are listed so they cannot quietly stop.
const FILES = [
  ['Sales.js', path.join(__dirname, 'Sales.js')],
  ['MenuEngineering.js', path.join(__dirname, '..', 'recipes', 'MenuEngineering.js')],
  ['Overheads.js', path.join(__dirname, '..', 'reports', 'Overheads.js')],
  ['FifoReport.js', path.join(__dirname, '..', 'reports', 'FifoReport.js')],
  ['StockAgeing.js', path.join(__dirname, '..', 'reports', 'StockAgeing.js')],
  ['StockReport.js', path.join(__dirname, '..', 'stockcount', 'StockReport.js')],
  ['ReorderReport.js', path.join(__dirname, '..', 'stockcount', 'ReorderReport.js')],
  // The three menu-analysis reports joined in S724, when they were re-analysed. Their figure is a
  // RANK or the multiplier on one: Best Sellers orders the menu and captions the bottom of that
  // order as candidates for removal, Recipe Margin's Total Contribution is its headline, its
  // default sort AND its Top Contributor card, and Menu Repricing multiplies qty by a price gap to
  // produce Monthly Opportunity. A short qty map on any of them does not shorten one column — it
  // re-orders the report, or moves the one number the page is read for.
  ['BestSellers.js', path.join(__dirname, '..', 'reports', 'BestSellers.js')],
  ['RecipeMargin.js', path.join(__dirname, '..', 'recipes', 'RecipeMargin.js')],
  ['MenuRepricing.js', path.join(__dirname, '..', 'recipes', 'MenuRepricing.js')],
  // The variance family joined in S719, when the same sweep reached them. All three already
  // complied; they are listed so they cannot quietly stop.
  ['Variance.js', path.join(__dirname, '..', 'variance', 'Variance.js')],
  ['TheoreticalVariance.js', path.join(__dirname, '..', 'variance', 'TheoreticalVariance.js')],
  ['ShrinkageReport.js', path.join(__dirname, '..', 'variance', 'ShrinkageReport.js')],
  // Joined in S747 with its grouped path, get_group_pnl, which had the SQL form of the same filter.
  // Revenue is the top line of the statement and the denominator of every margin beneath it.
  ['ConsolidatedPnl.jsx', path.join(__dirname, '..', '..', '..', 'pages', 'dashboard', 'ConsolidatedPnl.jsx')],
  // The frozen Monthly Owner Report joined in S792 (FIGURES-8). Its revenue is the denominator of
  // Food Cost %, Labour %, Prime % and Net Margin %, and its Menu Engineering qty map sets the
  // popularity median — both FROZEN, so a dropped legacy row stays dropped. The two rebuilt
  // inventory sections are listed so their sales reads cannot lose `source` again.
  ['computeMonthlyReport.js', path.join(__dirname, '..', '..', 'ownerReport', 'computeMonthlyReport.js')],
  ['computeMenuEngineeringSection.js', path.join(__dirname, '..', '..', 'ownerReport', 'computeMenuEngineeringSection.js')],
  ['computeInventoryVariance.js', path.join(__dirname, '..', '..', 'ownerReport', 'computeInventoryVariance.js')],
  ['computeInventoryShrinkageTrend.js', path.join(__dirname, '..', '..', 'ownerReport', 'computeInventoryShrinkageTrend.js')],
]

describe.each(FILES)('%s reads sales_entries in a way NULL-source rows survive', (_name, file) => {
  const SRC = fs.readFileSync(file, 'utf8')

  test('no server-side .neq on the source column', () => {
    // Comment lines are skipped: the rule is documented at the top of Sales.js, quoting the form
    // it forbids, and a check that cannot tell code from prose fails on its own explanation.
    const offenders = SRC.split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .filter(([, line]) => /\.neq\(\s*['"]source['"]/.test(line))
    expect(offenders).toEqual([])
  })

  test('every sales_entries read selects source, or selects everything', () => {
    // `select('*')` carries source implicitly; an explicit column list must name it, or the JS
    // filter has nothing to test and every row reads as manual.
    const reads = SRC.match(/from\('sales_entries'\)\s*\.select\((.*?)\)/gs) || []
    expect(reads.length).toBeGreaterThan(0)
    reads.forEach(read => {
      expect(read.includes("'*'") || /\bsource\b/.test(read)).toBe(true)
    })
  })
})

// Selecting `source` is only half of it: a page can carry the column and still sum the rows raw,
// which is exactly what FifoReport did until S717 — a day sold in both POS and manual entry
// consumed its ingredients twice, and a credit note ('pos_credit', negative qty_sold) put stock
// back that never physically returned. These four turn sales into DEPLETION, so they must go
// through the one shared rule — directly, or via buildStockRows, which applies it internally.
const DEPLETION_FILES = [
  ['FifoReport.js', path.join(__dirname, '..', 'reports', 'FifoReport.js')],
  ['StockAgeing.js', path.join(__dirname, '..', 'reports', 'StockAgeing.js')],
  ['StockReport.js', path.join(__dirname, '..', 'stockcount', 'StockReport.js')],
  ['ReorderReport.js', path.join(__dirname, '..', 'stockcount', 'ReorderReport.js')],
  ['Variance.js', path.join(__dirname, '..', 'variance', 'Variance.js')],
  ['TheoreticalVariance.js', path.join(__dirname, '..', 'variance', 'TheoreticalVariance.js')],
  ['ShrinkageReport.js', path.join(__dirname, '..', 'variance', 'ShrinkageReport.js')],
  // S792 (SALES-3): the frozen Owner Report's variance and shrinkage-trend sections summed sales
  // raw — a credit note and its choice lines SUBTRACTED usage, a till + manual day counted twice —
  // and were on no list, which is why S717's "the last page summing raw" missed them. The IMS
  // section's reorder figure goes through buildStockRows and is pinned here too.
  ['computeInventoryVariance.js', path.join(__dirname, '..', '..', 'ownerReport', 'computeInventoryVariance.js')],
  ['computeInventoryShrinkageTrend.js', path.join(__dirname, '..', '..', 'ownerReport', 'computeInventoryShrinkageTrend.js')],
  ['computeMonthlyReport.js', path.join(__dirname, '..', '..', 'ownerReport', 'computeMonthlyReport.js')],
]

describe.each(DEPLETION_FILES)('%s runs sales through the shared depletion rule', (_name, file) => {
  const SRC = fs.readFileSync(file, 'utf8')

  // Comments are stripped first: a comment naming the function is not a call to it.
  test('imports selectDepletingSales, or buildStockRows / buildUsageMap which apply it', () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const IMPORTS_RULE = /import[^;]*\b(selectDepletingSales|selectDepletingSalesAcrossPeriods|buildStockRows|buildUsageMap)\b/
    expect(IMPORTS_RULE.test(code)).toBe(true)
  })
})

// S792 (SALES-1, D29). save_sales_day replaces a day's (or the Bulk period's) MANUAL rows wholesale
// with the payload, and the payload is built from the dishes this page loads. The menu read used to
// be `.eq('is_active', true)`, so re-saving any day deleted a hidden dish's recorded sales for it —
// and a Bulk save its whole month — with nothing on screen. The read must include hidden dishes, and
// both payload builders must carry any stored row whose dish is not on the page.
// And SALES-2: the supersede warning reads `pendingSave.target.mode` (S756 moved it there).
describe('Sales Entry keeps hidden dishes in the save (S792)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'Sales.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('reads every dish, hidden ones included', () => {
    const read = src.match(/scopedFrom\('recipes'\)[^\n]*/)
    expect(read).not.toBeNull()
    expect(read[0]).not.toMatch(/is_active/)
  })

  it('carries stored rows for dishes not on the page through both payloads', () => {
    expect(src).toMatch(/carriedRows\(dailySales, dailyPrices, dailyDiscounts\)/)
    expect(src).toMatch(/carriedRows\(sales, salesPrices\)/)
  })

  it('the supersede warning is told which mode is saving', () => {
    expect(src).toMatch(/mode=\{pendingSave\.target\.mode\}/)
    expect(src).not.toMatch(/mode=\{pendingSave\.mode\}/)
  })
})
