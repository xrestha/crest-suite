import { SSF_CAP, SSF_GRATUITY_PCT, GRATUITY_VESTING_MONTHS } from '../payrollConstants'

// Gratuity, in one place. Pure — no React, no Supabase — so both the Gratuity Tracker (which asks
// "what do we owe, as of today?") and Final Settlement (which asks "what do we owe this person, as
// of their last working day?") compute it identically.
//
// It lived twice before S600: a private copy in GratuityTracker.jsx and an inline copy in
// FinalSettlement.jsx. They agreed arithmetically and diverged in four behaviours — the vesting
// gate, the reference date, hardcoded constants, and the SSF enrolment test — which is exactly how
// two screens end up quoting different gratuity figures for the same employee.

/** Whole months from an AD date string to a reference date. Day-of-month is ignored, matching
 *  what both original copies did — 1 Shrawan and 31 Shrawan give the same month count. */
export function monthsBetween(fromAdStr, asOf = new Date()) {
  if (!fromAdStr) return 0
  const from = new Date(fromAdStr + 'T00:00:00')
  if (isNaN(from)) return 0
  return Math.max(0, (asOf.getFullYear() - from.getFullYear()) * 12 + (asOf.getMonth() - from.getMonth()))
}

/** Months of service. `asOf` is explicit because the two callers genuinely differ. */
export function serviceMonths(joinDateStr, asOf = new Date()) {
  return monthsBetween(joinDateStr, asOf)
}

/**
 * Gratuity per the Labour Act — one month's basic per year of service (8.33%) — less whatever the
 * SSF has already funded, because an SSF-enrolled employee's employer contribution includes a
 * 3.33% slice earmarked for gratuity and paying both would pay twice.
 *
 * `ssfMonths` is **the number of months SSF contributions were actually made**, and it is the whole
 * point of this signature. Both original copies multiplied the SSF offset across the employee's
 * ENTIRE service, gated only on the `ssf_enrolled` flag — but SSF only began accepting
 * contributions in 2075/76 and most clients enrolled years later. A ten-year employee enrolled two
 * years ago had eight phantom years netted off their gratuity: at the capped basic that is roughly
 * NPR 320,000 withheld from someone who was owed it.
 *
 * There is no enrolment date anywhere in the schema, so the caller derives it from evidence — the
 * first payslip that actually carries an SSF deduction — and passes the month count here. When the
 * caller cannot determine it, it passes `null`: the offset is then **not applied**, and
 * `coverageKnown` is false so the UI can say why. That direction is deliberate — an unknown
 * enrolment date must never silently reduce what a leaver is paid.
 */
export function calcGratuity(emp, { asOf = new Date(), ssfMonths = null } = {}) {
  const basic  = parseFloat(emp?.basic_salary) || 0
  const months = serviceMonths(emp?.join_date, asOf)
  const vested = months >= GRATUITY_VESTING_MONTHS

  const monthlyAccrual = basic / 12
  const totalAccrued   = monthlyAccrual * months

  // Both the enrolment flag AND a registration number, matching computePayslip's gate exactly
  // (payrollCompute.js). A flagged employee with a blank SSF number had nothing contributed on
  // their behalf all year — netting off a contribution that was never made underpays them.
  const enrolled = !!(emp?.ssf_enrolled && String(emp?.ssf_no || '').trim())

  const ssfMonthly    = enrolled ? Math.min(basic, SSF_CAP) * SSF_GRATUITY_PCT : 0
  const coverageKnown = !enrolled || ssfMonths != null
  // Capped at service months: SSF cannot have funded gratuity for months the person didn't work.
  const coveredMonths = enrolled && ssfMonths != null
    ? Math.max(0, Math.min(ssfMonths, months))
    : 0
  const ssfCovered = ssfMonthly * coveredMonths

  const netLiability = Math.max(0, totalAccrued - ssfCovered)

  return {
    basic, months, vested,
    monthlyAccrual, totalAccrued,
    enrolled, ssfMonthly, coveredMonths, ssfCovered, coverageKnown,
    netLiability,
    // What is actually payable on separation. The two callers deliberately differ here and used to
    // do so silently: the Tracker reports the accruing liability for everyone (an 11-month
    // employee still represents a future cost), while a settlement pays nothing before vesting.
    // Returning both, named, is what stops that being a hidden disagreement.
    payable: vested ? netLiability : 0,
  }
}
