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
import { dayAfter } from '../gratuity/gratuityCompute'
import { SSF_CAP, SSF_EMPLOYEE_PCT, STANDARD_HOURS_PER_DAY } from '../payrollConstants'

const num = v => parseFloat(v) || 0

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

// ── Finalized Final Settlements, as year-to-date income (S798 ENGINE-5) ─────────────────────────
// A settlement pays the leaver's last month and their exit lump sums, and withholds tax on both. A
// leaver rehired later in the same fiscal year (payable since S791) is taxed for the rest of that year
// on a year-to-date that must include it, or every later month projects too little and under-withholds
// — while the TDS Certificate, which does read settlements, shows the year taxed below its slab.
// `settle_bs_year`/`settle_bs_month` is the month it pays; a settlement from before S752 has none and
// is left out, as HR Reports leaves it out.
export const SETTLEMENT_YTD_COLS = 'id, employee_id, settle_bs_year, settle_bs_month, last_working_date, finalized_at, '
  + 'partial_salary, month_ssf_employee, month_retirement_contribution, month_tds, lump_tds, '
  + 'gratuity, leave_encashment, festival_pro, notice_pay'

export async function fetchFinalizedSettlements(scopedFrom) {
  // Paged: one row per leaver for as long as the client has used Final Settlement.
  return fetchAllRows(() => scopedFrom('hr_final_settlements', SETTLEMENT_YTD_COLS).eq('status', 'finalized').order('id'))
}

// The exit payments, taxed as a lump sum on top of the year (settlementCompute.js lumpSum).
export const settlementLump = s => num(s.gratuity) + num(s.leave_encashment) + num(s.festival_pro) + num(s.notice_pay)

// The fiscal year and month a settlement pays, or null for a settlement from before S752.
export function settlementFiscalYear(s) {
  return s?.settle_bs_year && s?.settle_bs_month ? fiscalYearOf(s.settle_bs_year, s.settle_bs_month) : null
}

// Per employee, the finalized payslips of ONE fiscal year: { gross (earned: less unpaid days, plus OT),
// ssf, retirement, months, lump, paid }. The rows must carry `absence_deduction` — earnedPay throws
// without it. `paid` is the set of fiscal-year months already paid (monthInFy), which
// computeRunBonusTds takes off the months still to come.
//
// S798 ENGINE-5: a finalized settlement paid in an EARLIER month than the bonus (`pay`) is folded in:
// its last month's pay, SSF and CIT as a paid month, its exit lump sums as `lump` — one-off income
// already taxed, which computeRunBonusTds adds to the other bonuses rather than to the monthly average.
// Earlier only, so in a shared month the bonus is taxed first and the settlement on top of it
// (payrollData.js ytdFromPayslips includeSameMonthBonuses), never each on top of the other.
export function payslipYtdForFy(payslipRows, fyStart, settlements = [], pay = null) {
  const ytd = {}
  const entry = id => (ytd[id] = ytd[id] || { gross: 0, ssf: 0, retirement: 0, months: 0, lump: 0, paid: new Set() })
  const paidMonth = (e, m) => { if (!e.paid.has(m)) { e.paid.add(m); e.months += 1 } }
  ;(payslipRows || []).forEach(r => {
    const mp = r.hr_payroll_runs?.monthly_periods
    if (!mp) return
    const fy = fiscalYearOf(mp.bs_year, mp.bs_month)
    if (fy.fyStart !== fyStart) return
    const e = entry(r.employee_id)
    e.gross      += earnedPay(r)
    e.ssf        += parseFloat(r.ssf_employee) || 0
    e.retirement += parseFloat(r.retirement_contribution) || 0
    paidMonth(e, fy.monthInFy)
  })
  const payMonth = pay ? fiscalYearOf(pay.bs_year, pay.bs_month || DEFAULT_BONUS_MONTH).monthInFy : null
  ;(settlements || []).forEach(s => {
    const fy = settlementFiscalYear(s)
    if (!fy || fy.fyStart !== fyStart) return
    if (payMonth != null && fy.monthInFy >= payMonth) return
    const e = entry(s.employee_id)
    e.gross      += num(s.partial_salary)
    e.ssf        += num(s.month_ssf_employee)
    e.retirement += num(s.month_retirement_contribution)
    e.lump       += settlementLump(s)
    paidMonth(e, fy.monthInFy)
  })
  return ytd
}

// Per employee, the finalized settlement of their CURRENT employment, if any: a settled leaver who
// has not been rehired since (a rehire's join date is after the earlier spell's last day). Incentive
// Run marks them "Settled on …" (S798 H33), as Festival Allowance marks its settled leavers.
export function currentSpellSettlements(settlements, employees) {
  const joinOf = new Map((employees || []).map(e => [e.id, e.join_date ? String(e.join_date).slice(0, 10) : null]))
  const out = new Map()
  ;(settlements || []).forEach(s => {
    if (!joinOf.has(s.employee_id)) return
    const join = joinOf.get(s.employee_id)
    const last = String(s.last_working_date || '').slice(0, 10)
    if (join && last && last < join) return
    const prev = out.get(s.employee_id)
    if (!prev || String(prev.last_working_date) < String(s.last_working_date)) out.set(s.employee_id, s)
  })
  return out
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

// The fiscal-year months still to be paid: months of the CURRENT employment not already paid. It was
// employed months less every paid month, and a rehire's payslips from the earlier spell are paid months
// outside the current employment, so the rest of their year was projected months too short (S798
// ENGINE-5). For anyone continuously employed the two are the same. `paid` is payslipYtdForFy's set;
// without one (an older caller) the count is used as before.
export function monthsStillToPay(employee, fyStart, ytd) {
  if (!(ytd?.paid instanceof Set)) return Math.max(0, employedMonthsInFy(employee, fyStart) - (ytd?.months || 0))
  return fyMonths(fyStart).filter((p, i) => {
    if (ytd.paid.has(i + 1)) return false
    const start = formatAd(bsToAd(p.bs_year, p.bs_month, 1))
    const end   = formatAd(bsToAd(p.bs_year, p.bs_month, daysInBsMonth(p.bs_year, p.bs_month)))
    return employedInPeriod(employee, start, end)
  }).length
}

// TDS on one employee's bonus. `components` are ALL of this employee's salary components.
export function computeRunBonusTds({ employee, components, amount, ytd, otherBonuses = 0, fyStart }) {
  if (!amount || amount <= 0) return 0
  const basic = parseFloat(employee.basic_salary) || 0
  const isSsf = isSsfContributor(employee)
  const monthly = (employee.pay_basis || 'monthly') === 'monthly'
  const remainingMonths = monthsStillToPay(employee, fyStart, ytd)
  const taxable = projectBonusTaxableBase({
    basic, ytd,
    monthlyGross: projectedMonthlyGross(employee, components, ytd),
    remainingMonths,
    // An earlier settlement's exit lump sums are one-off income already taxed, like another bonus.
    otherBonuses: otherBonuses + (ytd?.lump || 0),
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
  // The last working day is worked in full, so service runs to the start of the day after it (S798
  // ENGINE-4) — as Final Settlement measures it (settlementCompute.js serviceUntil). Using the day
  // itself stopped one day short of an anniversary that fell the day after, and paid a month too few.
  const endRaw = employee?.end_date ? String(employee.end_date).slice(0, 10) : null
  const endExcl = endRaw ? dayAfter(endRaw) : null
  const until = endExcl && endExcl < ref ? endExcl : ref
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

