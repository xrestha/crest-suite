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

const FILES = [
  ['Sales.js', path.join(__dirname, 'Sales.js')],
  ['MenuEngineering.js', path.join(__dirname, '..', 'recipes', 'MenuEngineering.js')],
  ['Overheads.js', path.join(__dirname, '..', 'reports', 'Overheads.js')],
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
