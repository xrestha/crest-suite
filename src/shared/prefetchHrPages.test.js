import fs from 'fs'
import path from 'path'
import { prefetchAllowed } from './prefetchHrPages'

// The prefetch list must name every HR page App.js lazy-loads, or a new page silently misses the
// prefetch; and nothing outside App.js's list, or it downloads code no route uses.
test('prefetches exactly the HR manager pages App.js lazy-loads', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
  const list = fs.readFileSync(path.join(__dirname, 'prefetchHrPages.js'), 'utf8')
  const appPages = [...app.matchAll(/lazy\(\(\) => import\('\.\/(modules\/hr\/[^']+)'\)\)/g)]
    .map(m => m[1])
    .filter(p => !p.startsWith('modules/hr/selfservice/'))
    .sort()
  const prefetched = [...list.matchAll(/import\('\.\.\/(modules\/hr\/[^']+)'\)/g)].map(m => m[1]).sort()
  expect(appPages.length).toBeGreaterThan(10)
  expect(prefetched).toEqual(appPages)
})

test('skips the prefetch on data saver and 2G-class links only', () => {
  expect(prefetchAllowed(undefined)).toBe(true)
  expect(prefetchAllowed({ effectiveType: '4g' })).toBe(true)
  expect(prefetchAllowed({ effectiveType: '3g' })).toBe(true)
  expect(prefetchAllowed({ effectiveType: '2g' })).toBe(false)
  expect(prefetchAllowed({ effectiveType: 'slow-2g' })).toBe(false)
  expect(prefetchAllowed({ effectiveType: '4g', saveData: true })).toBe(false)
})
