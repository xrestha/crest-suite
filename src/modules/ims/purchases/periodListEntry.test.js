// A source-reading test, the salesReads.test.js pattern: what it pins has no symptom but a slower
// first paint, or a lock read off the wrong row. Each entry page takes its month from the shared
// list (S855, PERF-2, src/shared/periodList.js) instead of reading monthly_periods itself and only
// then starting its reads. On an entry page the guessed month only starts the reads: initPeriodLoad's
// `select` does nothing and init() applies the fresh list itself, so the dropdown, the closed-month
// lock and every save act on the fresh row (Sales.bulkDraft.test.jsx shows it on a rendered page).
import fs from 'fs'
import path from 'path'

const PAGES = ['Purchases.js', 'PurchaseOrders.js']
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

  test('the guessed month never reaches the page state', () => {
    expect(src).toMatch(/select: \(\) => \{\}/)
  })
})
