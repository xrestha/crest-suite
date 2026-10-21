// A source-reading test, the salesReads.test.js pattern: what it pins has no symptom but a slower
// first paint. Each variance report takes its months from the shared list (S855, PERF-2,
// src/shared/periodList.js) instead of reading monthly_periods itself and only then starting its
// data reads, and none starts its first load from a second effect after the list lands.
import fs from 'fs'
import path from 'path'

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8')

// Shrinkage loads a WINDOW of closed months, so it applies the guess-then-confirm rule itself.
const ONE_MONTH = ['Variance.js', 'TheoreticalVariance.js', 'WastageReport.js']
const ALL = [...ONE_MONTH, 'ShrinkageReport.js']

describe.each(ALL)('%s takes its months from the shared list (S855)', file => {
  const src = read(file)

  test('reads no month list of its own', () => {
    expect(src).not.toMatch(/['"]monthly_periods['"]/)
  })

  test('reads the shared list', () => {
    expect(src).toMatch(/usePeriodList\(\)/)
  })
})

describe.each(ONE_MONTH)('%s', file => {
  const src = read(file)

  test('starts its first load beside the list read', () => {
    expect(src).toMatch(/initPeriodLoad\(\{/)
  })

  test('no effect waits for the picked month to start a load', () => {
    expect(src).not.toMatch(/\},\s*\[selectedPeriod\]\)/)
  })
})

describe('ShrinkageReport.js', () => {
  const src = read('ShrinkageReport.js')

  test('no effect rebuilds the report when the month list lands', () => {
    // The window effect follows the count alone; init() starts the first load from the list.
    expect(src).not.toMatch(/\[periodCount,\s*periods\]/)
  })

  test('a guessed window is keyed on its months, so a fresh list that moves it wins the page', () => {
    expect(src).toMatch(/list\.slice\(0, count\)\.map\(p => p\.id\)/)
  })
})
