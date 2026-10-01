// The month's deposit — the SSF and income tax the business pays the government for one BS month
// (S798 PAYROLL-2 / REPORTS-2). One definition for every screen that states it.
//
// A month's deposit is more than its payroll run. A leaver settled in the month is not on the run (by
// design), but their Final Settlement deducted the final month's SSF and withheld tax on that month and
// on their exit pay. A festival allowance or incentive paid in the month withheld tax too. HR Reports'
// SSF Challan and TDS Report have always added these (S751, S752); the approval sheet the Owner signs,
// the payroll strip and the HR Dashboard's SSF card summed the payslips alone, so they read less than
// the challan they linked to — and "nothing to deposit — nobody on SSF" when the leaver was the month's
// only contributor.
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { roundPaisa } from './payrollCompute'

const num = v => parseFloat(v) || 0

// The month's finalized settlements and bonuses — what a run's payslips leave out. Returns
// { data: { settlements, bonuses }, error }. A failed read is an error, never "none this month": the
// caller says the figure could not be read rather than printing the payroll-only one.
export async function fetchMonthDepositExtras(scopedFrom, period) {
  const y = period.bs_year, m = period.bs_month
  const [st, fest, inc] = await Promise.all([
    // settle_bs_year/month is the month the settlement pays (HR Reports reads it the same way).
    fetchAllRows(() => scopedFrom('hr_final_settlements', 'id, employee_id, employee_name, month_ssf_employee, month_ssf_employer, month_tds, lump_tds')
      .eq('status', 'finalized').eq('settle_bs_year', y).eq('settle_bs_month', m).order('id')),
    // A bonus row carries its PAY month (S751); bs_month is NOT NULL on both tables.
    fetchAllRows(() => scopedFrom('hr_festival_allowances', 'id, employee_id, festival_name, amount, tds')
      .eq('status', 'finalized').eq('bs_year', y).eq('bs_month', m).order('id')),
    fetchAllRows(() => scopedFrom('hr_incentives', 'id, employee_id, run_label, amount, tds')
      .eq('status', 'finalized').eq('bs_year', y).eq('bs_month', m).order('id')),
  ])
  const error = st.error || fest.error || inc.error
  if (error) return { data: null, error }
  return {
    data: {
      settlements: st.data || [],
      bonuses: [
        ...(fest.data || []).map(r => ({ ...r, run: String(r.festival_name || '').trim() || 'Festival allowance' })),
        ...(inc.data || []).map(r => ({ ...r, run: String(r.run_label || '').trim() || 'Incentive' })),
      ],
    },
    error: null,
  }
}

/**
 * The month's deposit from its parts. `payslips` are the run's (any status — a draft's sheet shows
 * the draft's figures); `settlements` and `bonuses` come from fetchMonthDepositExtras.
 *
 * @returns {{
 *   ssf: { employee, employer, payroll, settlements, total, settledNames: string[] },
 *   tds: { payroll, settlements, bonuses, total, settledNames: string[], bonusRuns: { run, tds }[] },
 * }}
 */
export function monthDeposit({ payslips = [], settlements = [], bonuses = [] }) {
  const ssf = { employee: 0, employer: 0, payroll: 0, settlements: 0, total: 0, settledNames: [] }
  const tds = { payroll: 0, settlements: 0, bonuses: 0, total: 0, settledNames: [], bonusRuns: [] }
  ;(payslips || []).forEach(s => {
    ssf.employee += num(s.ssf_employee); ssf.employer += num(s.ssf_employer)
    ssf.payroll += num(s.ssf_employee) + num(s.ssf_employer)
    tds.payroll += num(s.tds)
  })
  ;(settlements || []).forEach(st => {
    const name = st.employee_name || 'a leaver'
    const s = num(st.month_ssf_employee) + num(st.month_ssf_employer)
    ssf.employee += num(st.month_ssf_employee); ssf.employer += num(st.month_ssf_employer)
    ssf.settlements += s
    if (s > 0) ssf.settledNames.push(name)
    const t = num(st.month_tds) + num(st.lump_tds)
    tds.settlements += t
    if (t > 0) tds.settledNames.push(name)
  })
  const byRun = new Map()
  ;(bonuses || []).forEach(b => {
    const t = num(b.tds)
    tds.bonuses += t
    if (t > 0) byRun.set(b.run, (byRun.get(b.run) || 0) + t)
  })
  tds.bonusRuns = [...byRun.entries()].map(([run, t]) => ({ run, tds: roundPaisa(t) }))
  for (const k of ['employee', 'employer', 'payroll', 'settlements']) ssf[k] = roundPaisa(ssf[k])
  for (const k of ['payroll', 'settlements', 'bonuses']) tds[k] = roundPaisa(tds[k])
  ssf.total = roundPaisa(ssf.payroll + ssf.settlements)
  tds.total = roundPaisa(tds.payroll + tds.settlements + tds.bonuses)
  return { ssf, tds }
}
