// The HR pages' code, fetched quietly once someone is working in HR (S808).
//
// Every route in App.js is React.lazy, so the FIRST visit to each HR page downloads its code before
// any of its data reads can start — one extra round trip, and on a slow link (~600 ms each on Fast
// 3G) the one a manager pays on every page they open for the first time after a deploy. Once the
// first HR page is up, this fetches the others in the background, one file at a time, so the next
// page opens straight onto its data reads. The service worker caches each file (cache-first), so the
// cost is paid once per deploy, not per visit.
//
// The paths are App.js's own: webpack serves one chunk per module, so `import()` here and
// `React.lazy` there load the same file, and the lazy page then resolves from the module cache.
// prefetchHrPages.test.js fails if App.js gains an HR page this list does not have.
//
// Crest Staff (/hr/self-service) is left out on purpose: it is a separate app for employees, who
// should not download the manager pages.
const HR_PAGES = [
  () => import('../modules/hr/dashboard/HrDashboard'),
  () => import('../modules/hr/attendance/AttendanceSheet'),
  () => import('../modules/hr/leave/LeaveManagement'),
  () => import('../modules/hr/payroll/PayrollRun'),
  () => import('../modules/hr/employees/EmployeeList'),
  () => import('../modules/hr/roster/Roster'),
  () => import('../modules/hr/overtime/Overtime'),
  () => import('../modules/hr/tada/TadaClaims'),
  () => import('../modules/hr/advances/Advances'),
  () => import('../modules/hr/reports/HrReports'),
  () => import('../modules/hr/staff/HrStaff'),
  () => import('../modules/hr/pay/PaySetup'),
  () => import('../modules/hr/festival/FestivalAllowance'),
  () => import('../modules/hr/incentives/IncentiveRun'),
  () => import('../modules/hr/settlement/FinalSettlement'),
  () => import('../modules/hr/gratuity/GratuityTracker'),
  () => import('../modules/hr/holidays/HolidayCalendar'),
]

// Long enough for the page that triggered it to finish its own reads on a slow link first: the
// prefetch is a convenience and must never compete with the screen someone is looking at.
const START_DELAY_MS = 5000

let started = false

// Data saver on, or a 2G-class link: the download would cost more than the round trip it saves.
// `navigator.connection` is Chromium-only, so its absence means "don't know", which proceeds.
export function prefetchAllowed(connection) {
  if (!connection) return true
  if (connection.saveData) return false
  return !/2g$/.test(connection.effectiveType || '')
}

export function prefetchHrPages() {
  if (started || typeof window === 'undefined') return
  started = true
  if (!prefetchAllowed(navigator.connection)) return
  const idle = cb => (window.requestIdleCallback ? window.requestIdleCallback(cb, { timeout: 5000 }) : setTimeout(cb, 500))
  const queue = [...HR_PAGES]
  const next = () => {
    const load = queue.shift()
    if (!load) return
    // A failed fetch (offline, or a deploy that replaced the files mid-session) ends the prefetch:
    // each page still loads its own code when it is opened, exactly as without this.
    load().then(() => idle(next), () => {})
  }
  setTimeout(() => idle(next), START_DELAY_MS)
}
