// Final Settlement's arithmetic, in one pure place (S752). No React, no Supabase.
//
// Until S752 the page carried its own copy of a leaver's final month: gross ÷ the month's days ×
// days worked, and nothing else — no overtime, no SSF, no CIT, no tax on the month's salary — while
// the tax relief below it still claimed a full month of SSF and CIT. Since S751 a settled leaver is
// left out of that month's payroll, so everything the copy dropped was paid and filed by nobody.
//
// Decided with Aashish (2026-09-14): the final month is paid INSIDE the settlement, computed by the
// payroll engine itself (computePayslip), and the SSF / TDS filing sheets read it from the row.
import { bsToAd, formatAd } from '../../../utils/bsCalendar'
import { computePayslip, isSsfContributor } from '../payroll/payrollCompute'
import { computeBonusTds, computeFinalMonthTds, fiscalYearOf } from '../payroll/tds'
import { calcGratuity, completedMonths, dayAfter, SSF_GRATUITY_SHARE_OF_EMPLOYER } from '../gratuity/gratuityCompute'
import { ssfFundedFor } from '../gratuity/ssfEnrolment'
import { SSF_CAP, SSF_GRATUITY_PCT, GRATUITY_VESTING_MONTHS } from '../payrollConstants'

// Leave encashment is a day-rate of basic ÷ 26 (unchanged). Notice pay is ÷ 30 per calendar day of
// notice (S752, decided): notice is counted in calendar days, so a working-day rate made 30 days'
// notice cost 1.15 months of basic.
export const LEAVE_DAY_DIVISOR = 26
export const NOTICE_DAY_DIVISOR = 30

const paisa = n => Math.round(((parseFloat(n) || 0) + Number.EPSILON) * 100) / 100

/** Which way notice pay runs for a separation reason (S752, decided with Aashish).
 *  → 'deduct'   the employee resigned without serving notice: they owe it
 *    'add'      the employer terminated without notice: the employer owes it
 *    null       mutual separation or retirement: no notice pay either way */
export function noticeDirection(reason) {
  if (reason === 'resignation') return 'deduct'
  if (reason === 'termination') return 'add'
  return null
}

const adOf = (y, m, d) => formatAd(bsToAd(y, m, d))

/**
 * Leave a leaver has EARNED this BS calendar year and not taken or already been paid for (S752,
 * decided): the yearly quota × completed months worked this year ÷ 12, less days taken and days
 * encashed. Someone leaving in their 4th month of an 18-day year earns 6. Uncapped types have no
 * balance. Returns { quota, monthsWorked, earned, used, encashed, remaining, capped }.
 */
export function earnedLeaveBalance({ quota, used = 0, encashed = 0, joinDate, lastDate }) {
  const q = parseFloat(quota) || 0
  if (!(q > 0)) return { quota: 0, monthsWorked: 0, earned: 0, used, encashed, remaining: 0, capped: false }
  const yearStart = adOf(lastDate.year, 1, 1)
  const from = joinDate && String(joinDate).slice(0, 10) > yearStart ? String(joinDate).slice(0, 10) : yearStart
  const until = dayAfter(adOf(lastDate.year, lastDate.month, lastDate.day))
  const monthsWorked = Math.min(12, completedMonths(from, until))
  const earned = q * monthsWorked / 12
  const remaining = Math.max(0, Math.round((earned - used - encashed) * 10) / 10)
  return { quota: q, monthsWorked, earned, used, encashed, remaining, capped: true }
}

/**
 * Everything a settlement pays and deducts.
 *
 * inputs:
 *   emp            the employee row (monthly pay basis): basic_salary, join_date, ssf_enrolled, ssf_no,
 *                  marital_status, life/health insurance premiums, pay_basis
 *   lastDate       { year, month, day } — the last working day, BS
 *   reason, noticeDays, noticeServed, leaveDays, festivalPaid
 *   components     this employee's salary components
 *   attendance     this employee's attendance rows for the final month
 *   otEntries      this employee's APPROVED overtime entries for the final month
 *   ytd            fetchYtdMap's entry for this employee (payslips and bonuses earlier this FY)
 *   tada           { total, ids } — every approved, unpaid travel claim (the settlement pays them)
 *   advances       outstanding advances [{ outstanding }]
 *   ssfRows        fetchSsfContributions' rows for this employee; `null` when that read failed
 */
export function computeSettlement({
  emp, lastDate, reason = 'resignation', noticeDays = 0, noticeServed = true, leaveDays = 0,
  festivalPaid = true, components = [], attendance = [], otEntries = [], ytd = null,
  tada = { total: 0, ids: [] }, advances = [], ssfRows = [],
}) {
  const basic = parseFloat(emp?.basic_salary) || 0
  const period = { bs_year: lastDate.year, bs_month: lastDate.month }
  const lastAd = adOf(lastDate.year, lastDate.month, lastDate.day)
  const serviceUntil = dayAfter(lastAd)
  const { fyStart } = fiscalYearOf(lastDate.year, lastDate.month)
  const isSsf = isSsfContributor(emp)
  const isMarried = emp?.marital_status === 'married'

  // ── The final month, by the payroll engine ──
  // end_date is the last working day, so days after it are unpaid; attendance and overtime marked
  // after that day are left out rather than counted twice.
  const slip = computePayslip(
    { ...emp, end_date: lastAd },
    components,
    (attendance || []).filter(a => a.bs_day <= lastDate.day),
    period, 0,
    (otEntries || []).filter(o => o.bs_day == null || o.bs_day <= lastDate.day),
    0,
  )
  const monthIncome = slip.gross - slip.absence_deduction + slip.ot_amount
  const y = ytd || {}
  const finalTax = computeFinalMonthTds({
    fyStart,
    monthlyIncome: monthIncome,
    monthlySsf: slip.ssf_employee,
    monthlyRetirement: slip.retirement_contribution,
    ytdGross: parseFloat(y.gross) || 0,
    ytdSsf: parseFloat(y.ssf) || 0,
    ytdRetirement: parseFloat(y.retirement) || 0,
    ytdWithheld: parseFloat(y.withheld) || 0,
    ytdBonusWithheld: parseFloat(y.bonusWithheld) || 0,
    isSsf, isMarried,
    annualLifeInsurance: parseFloat(emp?.life_insurance_premium) || 0,
    annualHealthInsurance: parseFloat(emp?.health_insurance_premium) || 0,
  })
  const monthTds = Math.min(finalTax.tds, Math.max(0, slip.net_pay))

  // ── Gratuity ──
  // SSF funding: every contribution before the final month in this spell, plus the final month's own.
  let ssfFunded = null
  if (ssfRows !== null) {
    const prior = ssfFundedFor(ssfRows, { joinDate: emp?.join_date, beforeBs: period })
    const own = slip.ssf_employer > 0 ? slip.ssf_employer * SSF_GRATUITY_SHARE_OF_EMPLOYER : 0
    ssfFunded = { amount: prior.amount + own, months: prior.months + (own > 0 ? 1 : 0) }
  }
  const g = calcGratuity(emp, { asOf: serviceUntil, ssfFunded })

  // ── Leave encashment ──
  const leaveEncashment = paisa((basic / LEAVE_DAY_DIVISOR) * (parseFloat(leaveDays) || 0))

  // ── Festival share (not yet paid this fiscal year) ──
  // Completed months worked in this fiscal year, the S751 festival rule, not the month number.
  const fyStartAd = adOf(fyStart, 4, 1)
  const join = emp?.join_date ? String(emp.join_date).slice(0, 10) : null
  const festivalMonths = festivalPaid ? 0 : Math.min(12, completedMonths(join && join > fyStartAd ? join : fyStartAd, serviceUntil))
  const festivalPro = paisa(basic * festivalMonths / 12)

  // ── Notice ──
  const direction = noticeServed ? null : noticeDirection(reason)
  const noticeAmount = paisa((basic / NOTICE_DAY_DIVISOR) * (parseFloat(noticeDays) || 0))
  const noticeDeduction = direction === 'deduct' ? noticeAmount : 0
  const noticePay = direction === 'add' ? noticeAmount : 0

  // ── Tax on the lump sum, on top of the year's actual taxable income ──
  const gratuity = paisa(g.payable)
  const lumpSum = gratuity + leaveEncashment + festivalPro + noticePay
  const lumpTds = computeBonusTds({ annualTaxable: finalTax.annualTaxable, bonusAmount: lumpSum, isSsf, isMarried, fyStart })

  // ── Summary ──
  const tadaAmount = paisa(tada?.total || 0)
  const advanceDeduction = paisa((advances || []).reduce((a, x) => a + (parseFloat(x.outstanding) || 0), 0))
  const grossPayout = paisa(monthIncome + tadaAmount + lumpSum)
  const beforeAdvances = paisa(slip.ssf_employee + slip.other_deductions + monthTds + lumpTds + noticeDeduction)
  const totalDeductions = paisa(beforeAdvances + advanceDeduction)
  const netPayout = paisa(grossPayout - totalDeductions)
  // What the payout can actually cover of the advances. A shortfall stays owed.
  const advanceRecovered = paisa(Math.max(0, Math.min(advanceDeduction, grossPayout - beforeAdvances)))

  return {
    period, lastAd, fyStart, isSsf,
    basic, slip, monthIncome, monthTds, finalTax,
    gratuity: g, gratuityPayable: gratuity, ssfCoverageKnown: g.coverageKnown,
    leaveEncashment, festivalMonths, festivalPro,
    noticeDirection: direction, noticeDeduction, noticePay,
    lumpSum, lumpTds, tadaAmount, tadaIds: tada?.ids || [],
    advanceDeduction, advanceRecovered, advanceShortfall: paisa(advanceDeduction - advanceRecovered),
    grossPayout, totalDeductions, netPayout,
  }
}

/** The columns a settlement stores — its frozen figures (S600) plus the final month (S752). */
export function settlementColumns(c, { emp, reason, noticeDays, noticeServed, leaveDays, leaveTypeId, festivalPaid, leaveDaysEarned }) {
  return {
    calc_version: 2,
    employee_id: emp.id,
    separation_reason: reason,
    last_working_date: c.lastAd,
    settle_bs_year: c.period.bs_year,
    settle_bs_month: c.period.bs_month,
    notice_days: parseFloat(noticeDays) || 0,
    notice_served: !!noticeServed,
    notice_divisor: NOTICE_DAY_DIVISOR,
    leave_days_encashed: parseFloat(leaveDays) || 0,
    leave_days_earned: leaveDaysEarned ?? null,
    leave_type_id: leaveTypeId || null,
    festival_paid: !!festivalPaid,
    festival_months: c.festivalMonths,
    employee_name: emp.full_name,
    employee_code: emp.employee_code || null,
    department: emp.department || null,
    pay_basis: emp.pay_basis || 'monthly',
    basic_salary: c.basic,
    join_date: emp.join_date || null,
    ssf_enrolled: !!emp.ssf_enrolled,
    ssf_no: emp.ssf_no || null,
    ssf_cap: SSF_CAP,
    ssf_gratuity_pct: SSF_GRATUITY_PCT,
    vesting_months: GRATUITY_VESTING_MONTHS,
    day_divisor: LEAVE_DAY_DIVISOR,
    service_months: c.gratuity.months,
    month_gross: paisa(c.slip.gross),
    month_allowances: paisa(c.slip.allowances),
    month_unpaid_days: c.slip.unpaid_days || 0,
    month_absence_deduction: paisa(c.slip.absence_deduction),
    month_ot_hours: c.slip.ot_hours || 0,
    month_ot_amount: paisa(c.slip.ot_amount),
    month_ssf_employee: paisa(c.slip.ssf_employee),
    month_ssf_employer: paisa(c.slip.ssf_employer),
    month_other_deductions: paisa(c.slip.other_deductions),
    month_retirement_contribution: paisa(c.slip.retirement_contribution),
    month_tds: paisa(c.monthTds),
    partial_salary: paisa(c.monthIncome),
    tada_amount: c.tadaAmount,
    tada_claim_ids: c.tadaIds,
    leave_encashment: c.leaveEncashment,
    gratuity_accrued: paisa(c.gratuity.totalAccrued),
    gratuity_ssf_covered: paisa(c.gratuity.ssfCovered),
    gratuity_ssf_months: c.gratuity.coveredMonths,
    gratuity: c.gratuityPayable,
    festival_pro: c.festivalPro,
    notice_deduction: c.noticeDeduction,
    notice_pay: c.noticePay,
    advance_deduction: c.advanceDeduction,
    lump_tds: c.lumpTds,
    gross_payout: c.grossPayout,
    net_payout: c.netPayout,
  }
}
