import { SSF_CAP, SSF_GRATUITY_PCT, SSF_EMPLOYER_PCT, GRATUITY_VESTING_MONTHS } from '../payrollConstants'
import { adToBsSafe, bsToAd, daysInBsMonth, formatAd } from '../../../utils/bsCalendar'
import { isSsfContributor } from '../payroll/payrollCompute'

// Gratuity, in one place. Pure — no React, no Supabase — so both the Gratuity Tracker (which asks
// "what do we owe, as of today?") and Final Settlement (which asks "what do we owe this person, as
// of their last working day?") compute it identically.
//
// It lived twice before S600: a private copy in GratuityTracker.jsx and an inline copy in
// FinalSettlement.jsx. They agreed arithmetically and diverged in four behaviours — the vesting
// gate, the reference date, hardcoded constants, and the SSF enrolment test — which is exactly how
// two screens end up quoting different gratuity figures for the same employee.

const toAdStr = d => {
  if (!d) return null
  if (d instanceof Date) return isNaN(d) ? null : formatAd(d)
  const s = String(d).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

const parseLocal = s => {
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return isNaN(dt) ? null : dt
}

/** The AD date one day after `adStr` ('YYYY-MM-DD'). A last working day is worked in full, so
 *  service is measured to the start of the following day. */
export function dayAfter(adStr) {
  const dt = parseLocal(String(adStr).slice(0, 10))
  if (!dt) return null
  dt.setDate(dt.getDate() + 1)
  return formatAd(dt)
}

/**
 * COMPLETED months from `fromAd` up to `untilAd` (both 'YYYY-MM-DD' or Date). A month is complete
 * once the same BS day of the next month has been reached, clamped to that month's length —
 * the rule Festival Allowance uses (bonusTax.js completedServiceMonths), without its 12-month cap.
 *
 * S752, decided with Aashish: the day matters. Until then this counted calendar-month CHANGES, so
 * someone who joined on 31 August and left on 1 August the next year had 12 months, was vested, and
 * was paid a month's basic the rule itself says they had not earned.
 */
export function completedMonths(fromAd, untilAd) {
  const from = toAdStr(fromAd)
  const until = toAdStr(untilAd)
  if (!from || !until || from > until) return 0
  const fromDate = parseLocal(from)
  if (!fromDate) return 0
  const bs = adToBsSafe(fromDate)
  let months = 0
  if (bs) {
    let y = bs.year, m = bs.month
    for (;;) {
      m += 1; if (m > 12) { m = 1; y += 1 }
      let anniversary
      try { anniversary = formatAd(bsToAd(y, m, Math.min(bs.day, daysInBsMonth(y, m)))) } catch { break }
      if (!anniversary || anniversary > until) break
      months += 1
    }
    return months
  }
  // Outside the verified BS table: the same rule on the AD calendar.
  const u = parseLocal(until)
  months = (u.getFullYear() - fromDate.getFullYear()) * 12 + (u.getMonth() - fromDate.getMonth())
  const lastOfMonth = new Date(u.getFullYear(), u.getMonth() + 1, 0).getDate()
  if (u.getDate() < Math.min(fromDate.getDate(), lastOfMonth)) months -= 1
  return Math.max(0, months)
}

/** Months of service to a reference date. `asOf` is explicit because the two callers differ: the
 *  Tracker measures to today, a settlement to the day after the last working day. */
export function serviceMonths(joinDateStr, asOf = new Date()) {
  return completedMonths(joinDateStr, asOf)
}

/** The gratuity share of an employer SSF contribution: SSF_GRATUITY_PCT out of SSF_EMPLOYER_PCT. */
export const SSF_GRATUITY_SHARE_OF_EMPLOYER = SSF_GRATUITY_PCT / SSF_EMPLOYER_PCT

/**
 * Gratuity per the Labour Act — one month's basic per year of service (8.33%) — less whatever the
 * SSF has already funded, because an SSF contributor's employer contribution includes a 3.33% slice
 * earmarked for gratuity and paying both would pay twice.
 *
 * `ssfFunded` is `{ amount, months }` — the gratuity share of the employer SSF ACTUALLY contributed
 * during this spell of service, summed from stored payslips (and a settlement's own final month) —
 * or `null` when the caller could not read it.
 *
 * S752, decided with Aashish: the offset is what was really paid. It used to be today's basic ×
 * 3.33% × months since the first SSF payslip, so a raise made every earlier month look better
 * funded than it was (4 years at 20,000 then one at 50,000 netted off ~NPR 48,000 too much), and
 * unpaid-leave months and months with no payroll counted as covered.
 *
 * A null `ssfFunded` means the read failed: `coverageKnown` is false, no offset is applied, and a
 * caller that pays money must refuse rather than pay the full accrual (S613 — a check that could
 * not run has not passed).
 */
export function calcGratuity(emp, { asOf = new Date(), ssfFunded = null } = {}) {
  const basic  = parseFloat(emp?.basic_salary) || 0
  const months = serviceMonths(emp?.join_date, asOf)
  const vested = months >= GRATUITY_VESTING_MONTHS

  const monthlyAccrual = basic / 12
  const totalAccrued   = Math.max(0, monthlyAccrual * months)

  // What payroll deducts on today (the flag AND a number). Reported for the screen; the offset itself
  // follows the stored contributions, which are true whatever the flag says now.
  const enrolled = isSsfContributor(emp)
  const coverageKnown = ssfFunded != null
  const funded = coverageKnown ? Math.max(0, parseFloat(ssfFunded.amount) || 0) : 0
  const ssfCovered = Math.min(funded, totalAccrued)
  const coveredMonths = coverageKnown ? Math.max(0, parseInt(ssfFunded.months, 10) || 0) : 0
  // The standing monthly slice at today's capped basic — what the Tracker's "per month" column shows.
  const ssfMonthly = enrolled ? Math.min(basic, SSF_CAP) * SSF_GRATUITY_PCT : 0

  const netLiability = Math.max(0, totalAccrued - ssfCovered)

  return {
    basic, months, vested,
    monthlyAccrual, totalAccrued,
    enrolled, ssfMonthly, coveredMonths, ssfCovered, coverageKnown,
    netLiability,
    // What is actually payable on separation. The two callers deliberately differ here: the Tracker
    // reports the accruing liability for everyone (an 11-month employee still represents a future
    // cost), while a settlement pays nothing before vesting.
    payable: vested ? netLiability : 0,
  }
}
