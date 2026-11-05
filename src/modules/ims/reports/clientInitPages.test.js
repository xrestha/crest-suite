// A source-reading test, the periodListReads.test.js pattern (S890). These five pages started their
// first load from `useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId])`.
// ProtectedRoute shows a page while a profile RE-fetch runs, so a page opened in that moment skipped
// init, and nothing ran it once loading ended because clientId had not changed: the page sat on its
// skeleton until a reload. useClientInit (its own test proves the re-run and that a later re-fetch
// does not load again) is the one first load now.
import fs from 'fs'
import path from 'path'

const PAGES = [
  ['Annual Summary', 'AnnualSummary.js'],
  ['Outstanding Payables', 'OutstandingPayables.js'],
  ['Requisitions', '../sales/Requisitions.js'],
  ['Theoretical Variance', '../variance/TheoreticalVariance.js'],
  ['Shrinkage', '../variance/ShrinkageReport.js'],
]

describe.each(PAGES)('%s starts its first load through useClientInit', (_name, file) => {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8')

  test('once per outlet, after the sign-in has loaded', () => {
    expect(src).toMatch(/useClientInit\(effectiveClientId, authLoading, /)
  })

  test('never gated on authLoading inside an effect that does not list it', () => {
    expect(src).not.toMatch(/if \(!authLoading && effectiveClientId\)/)
  })
})
