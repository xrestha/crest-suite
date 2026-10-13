// S824: a Festival Allowance or Incentive run can be paid WITH its pay month's salary. Each row says
// how (`paid_through_payroll`); a run's rows carry the same answer, except that someone a Final
// Settlement takes off that month's payroll is always paid separately. The database decides the same
// things under hr_pay_lock (hr_bonus_payroll_block in migration 20261013120000); this is what lets
// both pages say so first, by name, before anything is written.
import { fetchAllRows } from '../../../shared/fetchAllRows'

// Every payroll run of a BS year by month, and every Final Settlement (draft or finalized): whether
// a with-salary row may be finalized or reopened in its pay month, and who is leaving by then.
// Returns { data: { payrollByMonth: { [bs_month]: 'draft' | 'finalized' }, settlements }, error }.
// A failed read is an error, never "no payroll yet": that would let a run be finalized onto a
// finalized payroll, which the database then refuses half-way through the status writes.
export async function fetchBonusPayrollFacts(scopedFrom, bsYear) {
  const [runs, setts] = await Promise.all([
    // One run per month (unique per period), so a year is at most 12 rows.
    scopedFrom('hr_payroll_runs', 'status, monthly_periods!inner(bs_year, bs_month)').eq('monthly_periods.bs_year', bsYear),
    // One row per leaver, ever; paged anyway, with the unique tiebreaker fetchAllRows needs.
    fetchAllRows(() => scopedFrom('hr_final_settlements', 'id, employee_id, last_working_date, status').order('id')),
  ])
  const error = runs.error || setts.error
  if (error) return { data: null, error }
  const payrollByMonth = {}
  for (const r of runs.data || []) {
    const m = r.monthly_periods?.bs_month
    if (m) payrollByMonth[m] = r.status
  }
  return { data: { payrollByMonth, settlements: setts.data || [] }, error: null }
}

// Who a Final Settlement (draft or finalized) takes off the pay month's payroll: a last working day
// on or before the month's last day, in the current employment (a join date after it is a rehire,
// who is paid). The same test as hr_bonus_payroll_block's 'leaving'. `monthEndAd` is 'YYYY-MM-DD'.
export function leavingIds(settlements, empById, monthEndAd) {
  const out = new Set()
  for (const s of settlements || []) {
    if (s.status !== 'draft' && s.status !== 'finalized') continue
    const last = String(s.last_working_date || '').slice(0, 10)
    if (!last || last > monthEndAd) continue
    const join = empById.get(s.employee_id)?.join_date
    if (join && String(join).slice(0, 10) > last) continue
    out.add(s.employee_id)
  }
  return out
}

// How a run is paid, read off its rows: with salary when any row is (a leaver's row in a with-salary
// run is paid separately, so "every row" would be the wrong test). A run with no rows yet follows the
// choice made in the New dialog.
export function runPaidWithSalary(rows, choiceForNewRun) {
  return rows.length ? rows.some(r => r.paid_through_payroll) : !!choiceForNewRun
}

// The draft rows a switch to `withSalary` would rewrite: every draft row, except that someone leaving
// by the pay month always stays separately.
export function rowsToSwitch(rows, withSalary, leaving) {
  return rows.filter(r => r.status === 'draft'
    && !!r.paid_through_payroll !== (withSalary && !leaving.has(r.employee_id)))
}

// Words for a pay month's payroll, for confirms and banners. `monthLabel` is "Ashwin 2083".
export function payrollStateLine(state, monthLabel) {
  if (state === 'finalized') return `The ${monthLabel} payroll is already finalized.`
  if (state === 'draft') return `The ${monthLabel} payroll is a draft: Regenerate it afterwards so the payslips carry this.`
  return `The ${monthLabel} payroll has not been generated yet: it will carry this when it is.`
}

// Status writes and switch writes go out in id chunks: the ids are spelled out in the URL.
export const ID_CHUNK = 150
