// A supplier's payment terms as a number of days (S885), and the one rule for "overdue".
//
// vendors.pay_within_days is a whole number 0–365; NULL means the supplier has none set and keeps
// the 60 days every supplier had before S885 (owner decision). 0 is cash on delivery: an unpaid
// bill is overdue from the next day. The free-text vendors.payment_terms stays as a note.
//
// parsePayTerms is the browser twin of the one-time backfills in migrations
// 20261104170000_vendor_pay_within_days_s885.sql and 20261105100000 (weekly 7, monthly 30); the Excel
// import and the supplier form use it to suggest a number from a typed note. Change one, change the
// other. It reads only plain shapes ("30", "30 days", "Net 30", "within 15 days", "COD",
// "Weekly credit") and returns null for anything else, so "50% advance" is never read as 50 days and
// a bare "credit", which says nothing about how long, stays on the default.

export const DEFAULT_PAY_WITHIN_DAYS = 60
export const MAX_PAY_WITHIN_DAYS = 365

export function payWithinDays(vendor) {
  const d = vendor?.pay_within_days
  return Number.isInteger(d) && d >= 0 ? d : DEFAULT_PAY_WITHIN_DAYS
}

export function hasOwnPayTerms(vendor) {
  const d = vendor?.pay_within_days
  return Number.isInteger(d) && d >= 0
}

// A bill is overdue once its age in days passes its supplier's days. Age is counted from the bill
// date, the same as the age columns.
export function isOverdue(daysOld, vendor) {
  return Number(daysOld) > payWithinDays(vendor)
}

export function payTermsLabel(vendor) {
  const d = payWithinDays(vendor)
  const label = d === 0 ? 'Due on delivery' : `Pay within ${d} day${d === 1 ? '' : 's'}`
  return hasOwnPayTerms(vendor) ? label : `${label} (default)`
}

const COD = /^(cod|c\.o\.d\.?|c\.o\.d|cash|cash on delivery|on delivery|payment on delivery)$/
const WEEKLY = /^weekly( credit)?$/
const MONTHLY = /^monthly( credit)?$/
const SHAPES = [
  /^(?:net\s*)?(\d{1,3})(?:\s*(?:days?|d))?(?:\s+credit)?$/,
  /^(?:within|in)\s+(\d{1,3})\s+days?$/,
  /^credit\s+(?:of\s+)?(\d{1,3})\s*days?$/,
]

export function parsePayTerms(text) {
  if (text == null) return null
  const t = String(text).toLowerCase().replace(/\s+/g, ' ').trim()
  if (!t) return null
  if (COD.test(t)) return 0
  if (WEEKLY.test(t)) return 7
  if (MONTHLY.test(t)) return 30
  for (const re of SHAPES) {
    const m = t.match(re)
    if (m) {
      const n = Number(m[1])
      return n >= 0 && n <= MAX_PAY_WITHIN_DAYS ? n : null
    }
  }
  return null
}
