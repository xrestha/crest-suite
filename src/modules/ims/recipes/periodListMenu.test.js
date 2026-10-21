// A source-reading test, the salesReads.test.js pattern: what it pins has no symptom but a slower
// first paint. Each menu report takes its month from the shared list (S855, PERF-2,
// src/shared/periodList.js) instead of reading monthly_periods itself and only then starting its
// data reads, and none starts its first load from a second effect after the month is picked.
import fs from 'fs'
import path from 'path'

const PAGES = ['MenuEngineering.js', 'MenuRepricing.js', 'RecipeMargin.js']
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
    expect(src).not.toMatch(/\[periodId, clientId\]\)/)
  })
})

test('Menu Engineering writes the till classification only for the fresh month (S855)', () => {
  // The write moved out of the loader: init() passes the live month from the fresh list, because its
  // own render closure predates the list it just read and would compare against nothing.
  const src = read('MenuEngineering.js')
  expect(src).toMatch(/writeMeClass\(built\[out\.chosen\.id\], out\.chosen\.id, out\.chosen\.id\)/)
  expect(src).toMatch(/async function writeMeClass\(rows, forPeriodId, liveId = livePeriodId\)/)
})
