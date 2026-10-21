// A source-reading test, the salesReads.test.js pattern. Two widgets that need the month list but
// not a month of their own (S855, PERF-2, src/shared/periodList.js): the Inventory Dashboard's
// price movers (the month before the active one) and Item Master's VAT price review (the latest
// few months). Each reads the shared list, starts its bill reads off the list in memory, and reads
// again only when the fresh list names other months.
import fs from 'fs'
import path from 'path'

const WIDGETS = [
  path.join(__dirname, 'ImsPriceMovers.jsx'),
  path.join(__dirname, '..', 'items', 'VatCostPriceBanner.jsx'),
]

describe.each(WIDGETS)('%s reads the shared month list (S855)', file => {
  const src = fs.readFileSync(file, 'utf8')

  test('reads no month list of its own', () => {
    expect(src).not.toMatch(/['"]monthly_periods['"]/)
  })

  test('guesses from the list in memory and confirms with a fresh read', () => {
    expect(src).toMatch(/usePeriodList\(\)/)
    expect(src).toMatch(/const \{ cached, fresh \} = periodList\(\)/)
  })
})
