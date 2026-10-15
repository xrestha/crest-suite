import fs from 'fs'
import path from 'path'
import { POS_PAGES, posPagesToFetch } from './prefetchPosPages'

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
const list = fs.readFileSync(path.join(__dirname, 'prefetchPosPages.js'), 'utf8')

// Pages a signed-out visitor or a diner reaches, which never download the till's code.
const PUBLIC = ['modules/pos/booking/GuestBooking', 'modules/pos/guestmenu/GuestMenu', 'modules/pos/login/PosLogin', 'modules/pos/printing/PrintStation']

// The list must name every in-app POS page App.js lazy-loads, or a new page silently misses the
// prefetch; and nothing else, or it downloads code no route uses.
test('prefetches exactly the in-app POS pages App.js lazy-loads', () => {
  const appPages = [...app.matchAll(/lazy\(\(\) => import\('\.\/(modules\/pos\/[^']+)'\)\)/g)]
    .map(m => m[1]).filter(p => !PUBLIC.includes(p)).sort()
  const listed = [...new Set([...list.matchAll(/import\('\.\.\/(modules\/pos\/[^']+)'\)/g)].map(m => m[1]))].sort()
  expect(appPages.length).toBeGreaterThan(10)
  expect(listed).toEqual(appPages)
})

// A route the map names that App.js does not serve would never match a sidebar item.
test('every route in the list is a route App.js serves', () => {
  for (const [route] of POS_PAGES) expect(app).toContain(`path="${route}"`)
})

test('fetches what the login can reach, the till first, each file once', () => {
  const byRoute = Object.fromEntries(POS_PAGES)
  expect(posPagesToFetch(['/pos/staff', '/pos/billing', '/pos/orders'])).toEqual([byRoute['/pos/orders'], byRoute['/pos/staff']])
  // A kitchen station's sidebar offers the Kitchen Display alone.
  expect(posPagesToFetch(['/pos/kds'])).toEqual([byRoute['/pos/kds']])
  expect(posPagesToFetch([])).toEqual([])
  expect(posPagesToFetch(['/menu-pricing'])).toEqual([])
})
