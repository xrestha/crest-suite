import { bsToAd, formatAd } from '../../../utils/bsCalendar'
import { monthsBetween } from './gratuityCompute'

// When did SSF contributions actually start for each employee?
//
// Nothing in the schema records it — `hr_employees.ssf_enrolled` is a bare boolean with no date —
// and that gap is expensive: the gratuity offset used to be multiplied across an employee's entire
// service, so a ten-year employee enrolled two years ago had eight phantom years netted off what
// they were owed. SSF only began accepting contributions in 2075/76 and most clients enrolled
// later still, so "enrolled since they joined" is close to never true.
//
// The evidence we do have is payroll: the first finalized payslip that actually carries an SSF
// deduction is the month contributions began. That is a fact rather than an assumption, and it is
// already stored.
//
// An employee with no such payslip returns `null` — not zero. `calcGratuity` treats null as
// "unknown coverage" and applies no offset at all, which is the only safe direction when the
// alternative is quietly reducing a leaver's gratuity.

/**
 * → { [employee_id]: { bsYear, bsMonth } | undefined }
 * Employees absent from the map have no SSF-bearing finalized payslip on record.
 */
export async function fetchSsfStartMap(scopedFrom) {
  const { data, error } = await scopedFrom(
    'hr_payslips',
    'employee_id, ssf_employee, hr_payroll_runs!inner(status, monthly_periods!inner(bs_year, bs_month))',
  )
    .gt('ssf_employee', 0)
    .eq('hr_payroll_runs.status', 'finalized')

  if (error) throw error

  const map = {}
  for (const row of data || []) {
    const mp = row.hr_payroll_runs?.monthly_periods
    if (!mp) continue
    const cur = map[row.employee_id]
    // Earliest (bs_year, bs_month) wins.
    if (!cur || mp.bs_year < cur.bsYear || (mp.bs_year === cur.bsYear && mp.bs_month < cur.bsMonth)) {
      map[row.employee_id] = { bsYear: mp.bs_year, bsMonth: mp.bs_month }
    }
  }
  return map
}

/**
 * Months of SSF contribution up to `asOf`, from a map entry — or `null` when there is no evidence,
 * which `calcGratuity` reads as "apply no offset and say the coverage is unknown".
 */
export function ssfMonthsFrom(startEntry, asOf = new Date()) {
  if (!startEntry) return null
  // Day 1 of the month it started: the month is the unit gratuity accrues in, and the exact day
  // never affects a whole-month count.
  const ad = bsToAd(startEntry.bsYear, startEntry.bsMonth, 1)
  if (!ad || isNaN(ad)) return null
  return monthsBetween(formatAd(ad), asOf)
}
