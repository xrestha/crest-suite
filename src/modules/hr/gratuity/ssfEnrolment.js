import { bsToAd, daysInBsMonth, formatAd } from '../../../utils/bsCalendar'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { SSF_GRATUITY_SHARE_OF_EMPLOYER } from './gratuityCompute'

// What the SSF has already funded toward each employee's gratuity.
//
// Nothing in the schema records when SSF contributions began or how much went in, but payroll does:
// every finalized payslip stores the employer's 20% (`ssf_employer`), and a finalized Final
// Settlement stores its final month's (`month_ssf_employer`). The gratuity share of each is
// SSF_GRATUITY_PCT out of SSF_EMPLOYER_PCT.
//
// S752, decided with Aashish: the offset is the sum of those real contributions. Before it this file
// found only the FIRST SSF-bearing payslip and the gratuity page multiplied today's basic across
// every month since, which a raise, an unpaid month or a month with no payroll all made wrong.

/**
 * → { data: { [employee_id]: [{ bs_year, bs_month, employer }] }, error }
 * Every finalized SSF contribution the client has on record, per employee. Paged: one row per
 * contributing employee per month, for as long as the client has run payroll (S628).
 */
export async function fetchSsfContributions(scopedFrom) {
  const [slips, settlements] = await Promise.all([
    fetchAllRows(() =>
      scopedFrom(
        'hr_payslips',
        'id, employee_id, ssf_employer, hr_payroll_runs!inner(status, monthly_periods!inner(bs_year, bs_month))',
      )
        .gt('ssf_employer', 0)
        .eq('hr_payroll_runs.status', 'finalized')
        .order('id')),
    fetchAllRows(() =>
      scopedFrom('hr_final_settlements', 'id, employee_id, month_ssf_employer, settle_bs_year, settle_bs_month')
        .eq('status', 'finalized')
        .gt('month_ssf_employer', 0)
        .order('id')),
  ])
  if (slips.error) return { data: null, error: slips.error }
  if (settlements.error) return { data: null, error: settlements.error }
  const map = {}
  const add = (empId, bs_year, bs_month, employer) => {
    ;(map[empId] = map[empId] || []).push({ bs_year, bs_month, employer: parseFloat(employer) || 0 })
  }
  for (const r of slips.data || []) {
    const mp = r.hr_payroll_runs?.monthly_periods
    if (mp) add(r.employee_id, mp.bs_year, mp.bs_month, r.ssf_employer)
  }
  for (const s of settlements.data || []) {
    if (s.settle_bs_year && s.settle_bs_month) add(s.employee_id, s.settle_bs_year, s.settle_bs_month, s.month_ssf_employer)
  }
  return { data: map, error: null }
}

/**
 * The gratuity SSF has funded for ONE employee during their current spell of service:
 * `{ amount, months }`. Only months ending on or after `joinDate` count — a rehire's earlier spell was
 * settled with its own gratuity. `beforeBs` ({ bs_year, bs_month }) leaves out that month and later,
 * for a settlement that adds its own final month itself. A failed read (`rows === undefined` from a
 * null map) is the caller's to refuse; an employee with no contributions is `{ 0, 0 }`.
 */
export function ssfFundedFor(rows, { joinDate = null, beforeBs = null } = {}) {
  let amount = 0, months = 0
  const join = joinDate ? String(joinDate).slice(0, 10) : null
  const cutoff = beforeBs ? beforeBs.bs_year * 12 + beforeBs.bs_month : null
  for (const r of rows || []) {
    if (cutoff != null && r.bs_year * 12 + r.bs_month >= cutoff) continue
    if (join) {
      let monthEnd
      try { monthEnd = formatAd(bsToAd(r.bs_year, r.bs_month, daysInBsMonth(r.bs_year, r.bs_month))) } catch { monthEnd = null }
      if (monthEnd && monthEnd < join) continue
    }
    if (r.employer > 0) {
      amount += r.employer * SSF_GRATUITY_SHARE_OF_EMPLOYER
      months += 1
    }
  }
  return { amount, months }
}
