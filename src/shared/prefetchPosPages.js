// The POS pages' code, fetched quietly before the screen that needs it (S847).
//
// Every route in App.js is React.lazy, so the FIRST visit to a POS page downloads its code before any
// of its data reads can start — and every release empties the service worker's cache, so a till that
// takes a release (useReleaseReload) downloads the till's code again, the largest page in the product,
// before it can show the floor. On a slow link that is seconds, paid by the next waiter to sign in.
// Two triggers, both skipped on data saver and on a 2G-class link (prefetchAllowed):
//
//   - prefetchTillPages(): the PIN screen of an activated tablet fetches the till and the Kitchen
//     Display while staff pick their name and type the PIN, so sign-in lands on code already here.
//   - prefetchPosPages(paths): once a POS page is up, the other POS pages THIS login's sidebar offers
//     (Layout's isItemVisible), one file at a time, the till first. The same shape as prefetchHrPages.
//
// The service worker caches each file (cache-first), so this is paid once per release, not per visit.
// The imports are App.js's own: webpack serves one chunk per module, so `import()` here and
// `React.lazy` there load the same file. prefetchPosPages.test.js fails if App.js gains an in-app POS
// page this list does not have. The public pages (the guest menu, booking, the PIN screen itself, the
// print station) are left out: a diner scanning a table QR never downloads the till.
import { prefetchAllowed } from './prefetchHrPages'

const till = () => import('../modules/pos/orders/PosOrders')
const kitchen = () => import('../modules/pos/kds/KitchenDisplay')

// Route → page, in the order they are fetched: the screens worked during service first.
export const POS_PAGES = [
  ['/pos/orders', till],
  ['/pos/billing', till],
  ['/pos/kds', kitchen],
  ['/pos/dashboard', () => import('../modules/pos/dashboard/PosDashboard')],
  ['/pos/shifts', () => import('../modules/pos/shifts/PosShifts')],
  ['/pos/reservations', () => import('../modules/pos/reservations/PosReservations')],
  ['/pos/customers', () => import('../modules/pos/customers/PosCustomers')],
  ['/pos/parking', () => import('../modules/pos/parking/PosParkingSlips')],
  ['/pos/sales-report', () => import('../modules/pos/reports/SalesReport')],
  ['/pos/exceptions', () => import('../modules/pos/reports/PosExceptionReport')],
  ['/pos/credit-notes', () => import('../modules/pos/creditnotes/CreditNotes')],
  ['/pos/kot-log', () => import('../modules/pos/reports/KotLog')],
  ['/pos/covers-report', () => import('../modules/pos/reports/CoversReport')],
  ['/pos/tables', () => import('../modules/pos/tables/PosTableManagement')],
  ['/pos', () => import('../modules/pos/Pos')],
  ['/pos/staff', () => import('../modules/pos/staff/PosStaff')],
]

/** The pages to fetch for these reachable routes: in POS_PAGES' order, each file once. */
export function posPagesToFetch(paths) {
  const reachable = new Set(paths || [])
  const out = []
  for (const [path, load] of POS_PAGES) {
    if (reachable.has(path) && !out.includes(load)) out.push(load)
  }
  return out
}

// The PIN screen's own two reads (its staff list and the guest alerts) go first: a typed PIN takes a
// few seconds, so a short wait still lands the till before most sign-ins. Elsewhere the page's reads
// go first, as prefetchHrPages waits.
const TILL_DELAY_MS = 1500
const START_DELAY_MS = 5000

function fetchInTurn(loaders, delayMs) {
  if (loaders.length === 0 || typeof window === 'undefined' || !prefetchAllowed(navigator.connection)) return
  const idle = cb => (window.requestIdleCallback ? window.requestIdleCallback(cb, { timeout: 5000 }) : setTimeout(cb, 500))
  const queue = [...loaders]
  const next = () => {
    const load = queue.shift()
    if (!load) return
    // A failed fetch (offline, or a release that replaced the files mid-session) ends the prefetch:
    // each page still loads its own code when it is opened, exactly as without this.
    load().then(() => idle(next), () => {})
  }
  setTimeout(() => idle(next), delayMs)
}

let tillStarted = false
let pagesStarted = false

export function prefetchTillPages() {
  if (tillStarted) return
  tillStarted = true
  fetchInTurn([till, kitchen], TILL_DELAY_MS)
}

export function prefetchPosPages(paths) {
  if (pagesStarted) return
  pagesStarted = true
  fetchInTurn(posPagesToFetch(paths), START_DELAY_MS)
}
