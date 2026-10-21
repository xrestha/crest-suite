// A source-reading test, the salesReads.test.js pattern: what it pins has no symptom but a slower
// first paint. Each stock report takes its month from the shared list (S855, PERF-2,
// src/shared/periodList.js) instead of reading monthly_periods itself and only then starting its
// data reads, and none starts its first load from a second effect after the month is picked.
import fs from 'fs'
import path from 'path'

const PAGES = ['StockReport.js', 'ReorderReport.js', 'DeadStock.js', 'StockMovements.js']
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8')

describe.each(PAGES)('%s takes its month from the shared list (S855)', file => {
  const src = read(file)

  test('reads no month list of its own', () => {
    expect(src).not.toMatch(/['"]monthly_periods['"]/)
  })

  test('starts its first load beside the shared list read', () => {
    expect(src).toMatch(/usePeriodList\(\)/)
    expect(src).toMatch(/initPeriodLoad\(\{/)
  })

  test('no effect waits for the picked month to start a load', () => {
    expect(src).not.toMatch(/\},\s*\[selectedPeriod\]\)/)
  })
})

// PERF-5: the two stock reports that walk the recipe tree read the client's recipe book once,
// beside the period list, and walk it in memory, as Variance and Stock Movements do (S793). The
// level-by-level walk cost one round trip per sub-recipe nesting level after the month's reads, on
// every month picked. recipeCost.test.js pins that both feeds give the same walk.
describe.each(['StockReport.js', 'ReorderReport.js'])('%s walks the recipe book in memory (PERF-5)', file => {
  const src = read(file)

  test('starts the book in init, before the shared list load', () => {
    expect(src).toMatch(/const recipeBook = useRecipeBook\(\)/)
    const init = src.slice(src.indexOf('async function init('), src.indexOf('initPeriodLoad({'))
    expect(init).toMatch(/recipeBook\(\)/)
  })

  test('a failed book fails the report like any other read in the batch', () => {
    expect(src).toMatch(/recipeBook\(\)\.then\(book => \(\{ data: book, error: null \}\), error => \(\{ data: null, error \}\)\)/)
  })

  test('feeds the book to the walk, never the fetch-per-level form', () => {
    expect(src).toMatch(/explodeRecipeIngredients\(supabase, \w+, \{ book \}\)/)
    expect(src).not.toMatch(/explodeRecipeIngredients\(supabase, \w+\)/)
  })
})
