// Shared data-fetch helpers used by both the Payroll Run generator and the read-only Calculation
// page — kept in one place so both compute from identical YTD/advance/TADA inputs. Duplicating
// this logic across two files would risk them silently drifting apart, defeating the whole point
// of the Calculation page (it exists to always match what Payroll actually computes).
import { bsToAd, daysInBsMonth, formatAd } from '../../../utils/bsCalendar'
import { fiscalYearOf } from './tds'

// Year-to-date taxable per employee: sum of (gross − SSF) and tds from PRIOR finalized payslips
// in the same fiscal year (months before the current one).
export async function fetchYtdMap(scopedFrom, period) {
  const cur = fiscalYearOf(period.bs_year, period.bs_month)
  const { data } = await scopedFrom('hr_payslips', 'employee_id, gross, ot_amount, ssf_employee, tds, hr_payroll_runs!inner(status, monthly_periods!inner(bs_year, bs_month))')
    .eq('hr_payroll_runs.status', 'finalized')
  const map = {}
  ;(data || []).forEach(r => {
    if (r.hr_payroll_runs?.status !== 'finalized') return
    const mp = r.hr_payroll_runs?.monthly_periods
    if (!mp) return
    const fy = fiscalYearOf(mp.bs_year, mp.bs_month)
    if (fy.fyStart !== cur.fyStart || fy.monthInFy >= cur.monthInFy) return
    const e = map[r.employee_id] || { gross: 0, ssf: 0, withheld: 0, count: 0 }
    // OT pay is taxable income too — must stay in sync with monthlyGross below (S365 + OT fix).
    e.gross += (r.gross || 0) + (r.ot_amount || 0)
    e.ssf   += r.ssf_employee || 0
    e.withheld += r.tds || 0
    e.count += 1 // prior finalized months this FY — feeds tds.js's ytdMonths (mid-year-joiner fix)
    map[r.employee_id] = e
  })
  return map
}

// Approved TADA claims (from the TADA Claims ledger) whose trip dates fall inside this BS period,
// per employee. Feeds the TADA column's auto-fill — Finalize marks these claims Paid so the same
// trip is never reimbursed both through TADA Claims and through payroll.
export async function fetchApprovedTadaMap(scopedFrom, period) {
  const periodStart = formatAd(bsToAd(period.bs_year, period.bs_month, 1))
  const periodEnd   = formatAd(bsToAd(period.bs_year, period.bs_month, daysInBsMonth(period.bs_year, period.bs_month)))
  const { data } = await scopedFrom('hr_tada_claims', 'id, employee_id, total_amount, start_date, end_date')
    .eq('status', 'approved')
  const map = {}
  ;(data || []).forEach(c => {
    if (c.start_date > periodEnd || c.end_date < periodStart) return
    const e = map[c.employee_id] || { total: 0, ids: [] }
    e.total += parseFloat(c.total_amount) || 0
    e.ids.push(c.id)
    map[c.employee_id] = e
  })
  return map
}

// Per-employee scheduled advance deduction for this period.
// For each active advance: deduct min(installment, outstanding).
// If no installment set, deduct full outstanding (treated as one-time advance).
export function buildAdvanceMap(advances, repayments) {
  const repaidMap = {}
  repayments.forEach(r => {
    repaidMap[r.advance_id] = (repaidMap[r.advance_id] || 0) + (parseFloat(r.amount) || 0)
  })
  const advMap = {}
  advances.filter(a => a.status === 'active').forEach(adv => {
    const repaid = repaidMap[adv.id] || 0
    const outstanding = Math.max(0, parseFloat(adv.amount) - repaid)
    if (outstanding <= 0) return
    const installment = parseFloat(adv.installment_amount) || outstanding
    const deduction = Math.min(installment, outstanding)
    advMap[adv.employee_id] = (advMap[adv.employee_id] || 0) + deduction
  })
  return advMap
}
