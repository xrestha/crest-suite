// Tax on a one-off payment — a Festival Allowance or an Incentive run — and the year-to-date
// figures it is taxed on top of. Shared by FestivalAllowance.jsx and IncentiveRun.jsx (S751), which
// each built their own YTD map and both got the same four things wrong:
//
//   1. The PAY MONTH. Both assumed Ashwin of the selected BS year, so a bonus paid Baisakh–Ashadh
//      was taxed on the next fiscal year's slabs against the wrong year's payslips.
//   2. The PROJECTION. The months left were projected at `basic` — allowances and overtime left out
//      — so anyone with allowances was projected into a lower band than they earn in.
//   3. OTHER BONUSES. Each run was taxed as the year's only bonus.
//   4. OVERTIME in the year-to-date gross (monthly payroll's own fetchYtdMap includes it).
//
// Pure helpers plus one fetch. Nothing here writes.
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { adToBsSafe, bsToAd, daysInBsMonth, formatAd } from '../../../utils/bsCalendar'
import { computeBonusTds, fiscalYearOf, projectBonusTaxableBase } from './tds'
import { calcAmount, earnedPay, employedInPeriod, isSsfContributor, retirementContributionOf } from './payrollCompute'
import { SSF_CAP, SSF_EMPLOYEE_PCT, STANDARD_HOURS_PER_DAY } from '../payrollConstants'

// A bonus row written before S751 has no pay month; those runs were always treated as Ashwin, and
// that is what the migration back-filled, so the fallback only matters for an unmigrated read.
export const DEFAULT_BONUS_MONTH = 6

export function bonusFiscalYear(row) {
  return fiscalYearOf(row.bs_year, row.bs_month || DEFAULT_BONUS_MONTH)
}

// Every FINALIZED festival allowance and incentive the client has paid. `runKey` is the run's exact
// trimmed name — case included, because the database's unique key is, so "Dashain" and "dashain" are
// two runs and each must count the other as a separate bonus. Paged: both tables are
// one row per employee per run for as long as the client has used them.
export async function fetchFinalizedBonuses(scopedFrom) {
  const [fest, inc] = await Promise.all([
    fetchAllRows(() => scopedFrom('hr_festival_allowances', 'id, employee_id, bs_year, bs_month, festival_name, amount, tds')
      .eq('status', 'finalized').order('id')),
    fetchAllRows(() => scopedFrom('hr_incentives', 'id, employee_id, bs_year, bs_month, run_label, amount, tds')
      .eq('status', 'finalized').order('id')),
  ])
  if (fest.error) return { data: null, error: fest.error }
  if (inc.error)  return { data: null, error: inc.error }
  return {
    data: [
      ...(fest.data || []).map(r => ({ ...r, source: 'festival', runKey: `festival:${r.bs_year}:${String(r.festival_name || '').trim()}` })),
      ...(inc.data  || []).map(r => ({ ...r, source: 'incentive', runKey: `incentive:${r.bs_year}:${String(r.run_label || '').trim()}` })),
    ],
    error: null,
  }
}

// Per employee, the finalized payslips of ONE fiscal year: { gross (earned: less unpaid days, plus OT),
// ssf, retirement, months }. The rows must carry `absence_deduction` — earnedPay throws without it.
export function payslipYtdForFy(payslipRows, fyStart) {
  const ytd = {}
  ;(payslipRows || []).forEach(r => {
    const mp = r.hr_payroll_runs?.monthly_periods
    if (!mp) return
    if (fiscalYearOf(mp.bs_year, mp.bs_month).fyStart !== fyStart) return
    const e = ytd[r.employee_id] || { gross: 0, ssf: 0, retirement: 0, months: 0 }
    e.gross      += earnedPay(r)
    e.ssf        += parseFloat(r.ssf_employee) || 0
    e.retirement += parseFloat(r.retirement_contribution) || 0
    e.months     += 1
    ytd[r.employee_id] = e
  })
  return ytd
}

// Per employee, the other finalized bonuses paid EARLIER in this fiscal year than the run being
// taxed, leaving out the run itself (its own rows are what is being recomputed).
//
// "Earlier" is by pay month, then by run key for two runs paid in the same month (S751 review). The
// first version counted every other finalized bonus in the year whatever its month, which made the
// tax depend on the order runs happened to be finalized in: two drafts finalized one after the other
// each counted neither, and a run reopened after a later one was finalized counted that later one
// too, so both were taxed as the top slice of the year. Ordering by pay month makes each bonus sit on
// top of exactly the ones paid before it, so the year's bonus tax adds up the same in any order.
// `pay` is the run's { bs_year, bs_month }; without it every other bonus in the year counts.
export function otherBonusesForFy(bonusRows, fyStart, excludeRunKey, pay) {
  const mine = pay ? fiscalYearOf(pay.bs_year, pay.bs_month || DEFAULT_BONUS_MONTH).monthInFy : null
  const out = {}
  ;(bonusRows || []).forEach(r => {
    if (r.runKey === excludeRunKey) return
    const fy = bonusFiscalYear(r)
    if (fy.fyStart !== fyStart) return
    if (mine != null && (fy.monthInFy > mine || (fy.monthInFy === mine && String(r.runKey) > String(excludeRunKey)))) return
    out[r.employee_id] = (out[r.employee_id] || 0) + (parseFloat(r.amount) || 0)
  })
  return out
}

// Fiscal-year months, as { bs_year, bs_month }, Shrawan first.
export function fyMonths(fyStart) {
  return Array.from({ length: 12 }, (_, i) => {
    const m = ((3 + i) % 12) + 1          // 4..12, 1..3
    return { bs_year: m >= 4 ? fyStart : fyStart + 1, bs_month: m }
  })
}

// How many months of the fiscal year this employee is employed in at all — a joiner's months
// before the join and a leaver's months after the exit are not paid, so they are not projected.
export function employedMonthsInFy(employee, fyStart) {
  return fyMonths(fyStart).filter(p => {
    const start = formatAd(bsToAd(p.bs_year, p.bs_month, 1))
    const end   = formatAd(bsToAd(p.bs_year, p.bs_month, daysInBsMonth(p.bs_year, p.bs_month)))
    return employedInPeriod(employee, start, end)
  }).length
}

// What one future month is expected to pay. Monthly staff: basic plus their earning components.
// Wage staff have no contractual month, so their own average over the year's finalized payslips is
// the honest estimate; with none, a 30-day month at the rate (8 hours a day for hourly staff).
export function projectedMonthlyGross(employee, components, ytd) {
  const basis = employee.pay_basis || 'monthly'
  const basic = parseFloat(employee.basic_salary) || 0
  if (basis === 'monthly') {
    return basic + (components || []).filter(c => c.type === 'earning').reduce((s, c) => s + calcAmount(c, basic), 0)
  }
  if (ytd?.months > 0) return ytd.gross / ytd.months
  return basis === 'daily' ? basic * 30 : basic * STANDARD_HOURS_PER_DAY * 30
}

// TDS on one employee's bonus. `components` are ALL of this employee's salary components.
export function computeRunBonusTds({ employee, components, amount, ytd, otherBonuses = 0, fyStart }) {
  if (!amount || amount <= 0) return 0
  const basic = parseFloat(employee.basic_salary) || 0
  const isSsf = isSsfContributor(employee)
  const monthly = (employee.pay_basis || 'monthly') === 'monthly'
  const remainingMonths = Math.max(0, employedMonthsInFy(employee, fyStart) - (ytd?.months || 0))
  const taxable = projectBonusTaxableBase({
    basic, ytd,
    monthlyGross: projectedMonthlyGross(employee, components, ytd),
    remainingMonths,
    otherBonuses,
    monthlySsf: isSsf && monthly ? Math.min(basic, SSF_CAP) * SSF_EMPLOYEE_PCT : 0,
    monthlyRetirement: monthly ? retirementContributionOf(components, basic) : 0,
    annualLifeInsurance:   parseFloat(employee.life_insurance_premium)   || 0,
    annualHealthInsurance: parseFloat(employee.health_insurance_premium) || 0,
  })
  return computeBonusTds({
    annualTaxable: taxable, bonusAmount: amount,
    isSsf, isMarried: employee.marital_status === 'married', fyStart,
  })
}

// Months of service counted toward a festival allowance: COMPLETED BS months from the join date to
// the festival date, 0–12 (S751, decided with Aashish: keep the share for months worked). It used
// to subtract AD calendar months regardless of the day, always measured to 15 Ashwin whatever the
// festival, and ignored a leaver's end date — so someone who joined the day before got 1/12 and
// someone who joined on the 31st of the month before got a month they had not worked.
export function completedServiceMonths(employee, refAd) {
  const ref = String(refAd).slice(0, 10)
  const join = employee?.join_date ? String(employee.join_date).slice(0, 10) : null
  const endRaw = employee?.end_date ? String(employee.end_date).slice(0, 10) : null
  const until = endRaw && endRaw < ref ? endRaw : ref
  if (!join) return 12
  if (join > until) return 0
  // Walk month-anniversaries in BS: a month is complete once the same BS day of the next month has
  // been reached (clamped to that month's length).
  const [jy, jm, jd] = join.split('-').map(Number)
  const joinDate = new Date(jy, jm - 1, jd)
  const bsJoin = adToBsSafe(joinDate)
  if (!bsJoin) return 12
  let months = 0
  let y = bsJoin.year, m = bsJoin.month
  while (months < 12) {
    m += 1; if (m > 12) { m = 1; y += 1 }
    const day = Math.min(bsJoin.day, daysInBsMonth(y, m))
    let anniversary
    try { anniversary = formatAd(bsToAd(y, m, day)) } catch { break }
    if (anniversary > until) break
    months += 1
  }
  return months
}

