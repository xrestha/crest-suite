// S751 — the payroll engine decisions taken with Aashish on 2026-09-14, pinned. Each block names the
// decision it holds; a change that breaks one is changing a rule the owner chose, not a detail.
import { computePayslip, employedInPeriod } from './payrollCompute'
import { buildPayrollRows, allocateAdvanceRepayments, payslipDrift, periodAdBounds } from './payrollData'
import {
  completedServiceMonths, employedMonthsInFy, otherBonusesForFy, payslipYtdForFy, projectedMonthlyGross,
  computeRunBonusTds, bonusFiscalYear,
} from './bonusTax'
import { projectBonusTaxableBase, computeBonusTds, computeMonthlyTdsBreakdown } from './tds'
import { bsToAd, daysInBsMonth, formatAd } from '../../../utils/bsCalendar'

const ad = (y, m, d) => formatAd(bsToAd(y, m, d))
const P = { bs_year: 2083, bs_month: 5 }                     // Bhadra 2083
const lastDay = daysInBsMonth(2083, 5)
const emp = (over = {}) => ({
  id: 'e1', full_name: 'Ram', pay_basis: 'monthly', basic_salary: 30000, join_date: '2020-01-01', end_date: null,
  ssf_enrolled: false, ssf_no: null, marital_status: 'single', ...over,
})

describe('employedInPeriod — no payslip for a month not worked at all (decision 14)', () => {
  const { start, end } = periodAdBounds(P)
  test('a hire who starts next month is not employed this month', () => {
    expect(employedInPeriod(emp({ join_date: ad(2083, 6, 1) }), start, end)).toBe(false)
  })
  test('a leaver whose last day was last month is not employed this month', () => {
    expect(employedInPeriod(emp({ end_date: ad(2083, 4, 20) }), start, end)).toBe(false)
  })
  test('joining on the last day, or leaving on the first, still counts as employed', () => {
    expect(employedInPeriod(emp({ join_date: ad(2083, 5, lastDay) }), start, end)).toBe(true)
    expect(employedInPeriod(emp({ end_date: ad(2083, 5, 1) }), start, end)).toBe(true)
  })
})

describe('computePayslip — take-home never below zero on a fixed deduction (decision 14)', () => {
  test('a CIT larger than a part-month earning is cut to what was earned, and relief follows the money', () => {
    const joiner = emp({ join_date: ad(2083, 5, lastDay) })            // one day worked
    const cit = [{ type: 'deduction', calc_type: 'flat', value: 1500, retirement_fund: true }]
    const slip = computePayslip(joiner, cit, [], P)
    expect(slip.net_pay).toBe(0)
    expect(slip.other_deductions).toBeLessThan(1500)
    expect(slip.retirement_contribution).toBe(slip.other_deductions)
    expect(slip.breakdown.otherDeductionsCut).toBe(1500 - slip.other_deductions)
  })
  test('a full month is untouched', () => {
    const slip = computePayslip(emp(), [{ type: 'deduction', calc_type: 'flat', value: 1500, retirement_fund: true }], [], P)
    expect(slip.other_deductions).toBe(1500)
    expect(slip.net_pay).toBe(28500)
    expect(slip.breakdown.otherDeductionsCut).toBe(0)
  })
})

describe('buildPayrollRows — the advance cut never takes more than the month paid (decision 2)', () => {
  const base = { period: P, components: [], otEntries: [], repayments: [], ytdMap: {}, tadaMap: {} }
  const absentMostOfMonth = Array.from({ length: lastDay - 3 }, (_, i) => ({ employee_id: 'e1', bs_day: i + 1, status: 'absent' }))
  const advance = { id: 'a1', employee_id: 'e1', status: 'active', amount: '20000', installment_amount: '5000', issued_date: ad(2083, 3, 10) }

  test('cuts what was earned, leaves take-home at zero, and the rest stays owed', () => {
    const [{ payslip, detail }] = buildPayrollRows({ ...base, employees: [emp()], attendance: absentMostOfMonth, advances: [advance] })
    expect(detail.advanceDue).toBe(5000)
    expect(payslip.advance_deduction).toBeLessThan(5000)
    expect(payslip.advance_deduction).toBeGreaterThan(0)
    expect(payslip.net_pay).toBe(0)
  })
  test('a full month takes the whole instalment', () => {
    const [{ payslip }] = buildPayrollRows({ ...base, employees: [emp()], attendance: [], advances: [advance] })
    expect(payslip.advance_deduction).toBe(5000)
    expect(payslip.net_pay).toBe(30000 - payslip.tds - 5000)
    expect(payslip.tds).toBe(300)                                    // 1% band, no SSF
  })
  test('TADA is added on top and never eaten by the advance cut', () => {
    const [{ payslip }] = buildPayrollRows({
      ...base, employees: [emp()], attendance: absentMostOfMonth, advances: [advance],
      tadaMap: { e1: { total: 800, ids: ['c1'] } },
    })
    expect(payslip.net_pay).toBe(800)
    expect(payslip.tada_claim_ids).toEqual(['c1'])
  })
  test('payslip has exactly the stored columns — no breakdown leaks into an INSERT', () => {
    const [{ payslip }] = buildPayrollRows({ ...base, runId: 'r1', employees: [emp()], attendance: [], advances: [] })
    expect(payslip).not.toHaveProperty('breakdown')
    expect(payslip).toMatchObject({ run_id: 'r1', employee_id: 'e1', tds_overridden: false })
  })
})

describe('allocateAdvanceRepayments — Finalize books exactly what the payslip cut', () => {
  const advances = [
    { id: 'old', employee_id: 'e1', status: 'active', amount: '3000', installment_amount: null, issued_date: ad(2083, 2, 1) },
    { id: 'new', employee_id: 'e1', status: 'active', amount: '10000', installment_amount: '4000', issued_date: ad(2083, 3, 1) },
  ]
  test('a capped cut is spread oldest-first and settles only what it fully repays', () => {
    const { repayRows, settleIds } = allocateAdvanceRepayments({
      payslips: [{ employee_id: 'e1', advance_deduction: 5000 }], advances, repayments: [],
      period: P, runId: 'r1', repaidDate: '2026-09-14', note: 'Bhadra 2083 payroll',
    })
    expect(repayRows.map(r => [r.advance_id, r.amount])).toEqual([['old', 3000], ['new', 2000]])
    expect(repayRows.reduce((s, r) => s + r.amount, 0)).toBe(5000)
    expect(settleIds).toEqual(['old'])
  })
  test("a re-finalize ignores the run's own earlier rows", () => {
    const { repayRows } = allocateAdvanceRepayments({
      payslips: [{ employee_id: 'e1', advance_deduction: 3000 }], advances,
      repayments: [{ advance_id: 'old', amount: '3000', payroll_run_id: 'r1' }],
      period: P, runId: 'r1', repaidDate: '2026-09-14', note: 'x',
    })
    expect(repayRows[0]).toMatchObject({ advance_id: 'old', amount: 3000 })
  })
})

describe('payslipDrift — only a typed TDS is an override', () => {
  const stored = { gross: 30000, ot_amount: 0, absence_deduction: 0, ssf_employee: 0, other_deductions: 0, advance_deduction: 0, retirement_contribution: 0, tds: 300, tada_amount: 0, tada_claim_ids: [] }
  test('a TDS that moved on its own is out of date, not "adjusted"', () => {
    expect(payslipDrift({ ...stored, tds_overridden: false }, { ...stored, tds: 450 })).toBe('moved')
  })
  test('a TDS a person typed is an override', () => {
    expect(payslipDrift({ ...stored, tds_overridden: true }, { ...stored, tds: 450 })).toBe('overridden')
  })
  test('a TADA amount difference is always movement — the box is no longer editable (decision 6)', () => {
    expect(payslipDrift(stored, { ...stored, tada_amount: 500 })).toBe('moved')
  })
})

describe('bonus tax (festival allowance + incentives)', () => {
  test('the pay month decides the fiscal year: a Jestha bonus belongs to the year that began the previous Shrawan', () => {
    expect(bonusFiscalYear({ bs_year: 2084, bs_month: 2 }).fyStart).toBe(2083)
    expect(bonusFiscalYear({ bs_year: 2083, bs_month: 6 }).fyStart).toBe(2083)
    expect(bonusFiscalYear({ bs_year: 2083 }).fyStart).toBe(2083)          // unmigrated read: Ashwin
  })

  test('future months are projected at basic PLUS allowances, not basic alone', () => {
    const e = emp({ basic_salary: 50000 })
    const comps = [{ type: 'earning', calc_type: 'flat', value: 35000 }, { type: 'deduction', calc_type: 'flat', value: 999 }]
    expect(projectedMonthlyGross(e, comps, null)).toBe(85000)
  })

  test('the worked example from the re-analysis: allowances put a 50,000 bonus in the 10% band, not the 1% band', () => {
    const e = emp({ basic_salary: 50000, marital_status: 'single' })
    const comps = [{ type: 'earning', calc_type: 'flat', value: 35000 }]
    const tds = computeRunBonusTds({ employee: e, components: comps, amount: 50000, ytd: null, otherBonuses: 0, fyStart: 2083 })
    // 85,000 × 12 = 10.2 lakh already past the 10 lakh first band → the whole bonus at 10%.
    expect(tds).toBe(5000)
    // The old projection (basic × 12 = 6 lakh) would have withheld 1%.
    const old = computeBonusTds({ annualTaxable: projectBonusTaxableBase({ basic: 50000, ytd: null }), bonusAmount: 50000, fyStart: 2083 })
    expect(old).toBe(500)
  })

  test('other bonuses already paid this year raise the base the next one is taxed on', () => {
    const e = emp({ basic_salary: 75000 })
    const alone  = computeRunBonusTds({ employee: e, components: [], amount: 50000, ytd: null, otherBonuses: 0, fyStart: 2083 })
    const second = computeRunBonusTds({ employee: e, components: [], amount: 50000, ytd: null, otherBonuses: 150000, fyStart: 2083 })
    expect(second).toBeGreaterThan(alone)
  })

  test('otherBonusesForFy leaves out the run being taxed and other years', () => {
    const rows = [
      { employee_id: 'e1', amount: '1000', bs_year: 2083, bs_month: 6, runKey: 'festival:2083:dashain' },
      { employee_id: 'e1', amount: '400', bs_year: 2083, bs_month: 7, runKey: 'incentive:2083:tihar bonus' },
      { employee_id: 'e1', amount: '900', bs_year: 2084, bs_month: 6, runKey: 'festival:2084:dashain' },
      { employee_id: 'e1', amount: '250', bs_year: 2084, bs_month: 1, runKey: 'incentive:2084:new year' },   // FY 2083
    ]
    expect(otherBonusesForFy(rows, 2083, 'festival:2083:dashain')).toEqual({ e1: 650 })
  })

  test('a bonus counts only the bonuses paid BEFORE it, so the year adds up in any finalize order (S751 review)', () => {
    const rows = [
      { employee_id: 'e1', amount: '1000', bs_year: 2083, bs_month: 6, runKey: 'festival:2083:Dashain' },
      { employee_id: 'e1', amount: '400', bs_year: 2083, bs_month: 7, runKey: 'festival:2083:Tihar' },
    ]
    // Dashain (Ashwin) counts nothing; Tihar (Kartik) counts Dashain — whichever was finalized first.
    expect(otherBonusesForFy(rows, 2083, 'festival:2083:Dashain', { bs_year: 2083, bs_month: 6 })).toEqual({})
    expect(otherBonusesForFy(rows, 2083, 'festival:2083:Tihar', { bs_year: 2083, bs_month: 7 })).toEqual({ e1: 1000 })
    // Two runs in the same month: exactly one of them counts the other.
    const same = [{ employee_id: 'e1', amount: '5', bs_year: 2083, bs_month: 6, runKey: 'incentive:2083:A' }]
    const a = otherBonusesForFy([...same, { employee_id: 'e1', amount: '7', bs_year: 2083, bs_month: 6, runKey: 'incentive:2083:B' }], 2083, 'incentive:2083:A', { bs_year: 2083, bs_month: 6 })
    const b = otherBonusesForFy(same, 2083, 'incentive:2083:B', { bs_year: 2083, bs_month: 6 })
    expect(a).toEqual({})
    expect(b).toEqual({ e1: 5 })
  })

  const ytdSlip = (y, m, gross, ot, absence = 0) => ({ employee_id: 'e1', gross, ot_amount: ot, absence_deduction: absence, ssf_employee: 0, retirement_contribution: 0, hr_payroll_runs: { monthly_periods: { bs_year: y, bs_month: m } } })

  test('payslipYtdForFy counts overtime and only that fiscal year', () => {
    expect(payslipYtdForFy([ytdSlip(2083, 4, 30000, 2000), ytdSlip(2083, 3, 30000, 0)], 2083).e1).toEqual({ gross: 32000, ssf: 0, retirement: 0, months: 1 })
  })

  test('payslipYtdForFy counts pay EARNED — unpaid days come off, as they do for the current month', () => {
    // A Shrawan with NPR 3,000 of unpaid days earned 29,000, not 32,000; counting 32,000 projected a
    // higher year and taxed the festival allowance on income that was never paid (hss-suite, 2026-09-17).
    expect(payslipYtdForFy([ytdSlip(2083, 4, 30000, 2000, 3000)], 2083).e1.gross).toBe(29000)
  })

  test('payslipYtdForFy refuses a row whose query left out absence_deduction', () => {
    const { absence_deduction, ...noAbsence } = ytdSlip(2083, 4, 30000, 0)
    expect(() => payslipYtdForFy([noAbsence], 2083)).toThrow(/absence_deduction/)
  })

  test("a joiner's months before the join are not projected", () => {
    // Joined 1 Magh: Magh, Falgun, Chaitra, Baisakh, Jestha, Ashadh — six of the FY's twelve.
    expect(employedMonthsInFy(emp({ join_date: ad(2083, 10, 1) }), 2083)).toBe(6)
    expect(employedMonthsInFy(emp({ end_date: ad(2083, 5, 10) }), 2083)).toBe(2)   // Shrawan, Bhadra
  })
})

describe('completedServiceMonths — festival share counts completed BS months (decision 9)', () => {
  const ref = ad(2083, 6, 15)
  test('joined the day before the festival → 0 months', () => {
    expect(completedServiceMonths(emp({ join_date: ad(2083, 6, 14) }), ref)).toBe(0)
  })
  test('joined on the same BS day a month earlier → 1 month', () => {
    expect(completedServiceMonths(emp({ join_date: ad(2083, 5, 15) }), ref)).toBe(1)
  })
  test('a day short of a month is not a month', () => {
    expect(completedServiceMonths(emp({ join_date: ad(2083, 5, 16) }), ref)).toBe(0)
  })
  test('capped at 12, and a leaver stops counting at their end date', () => {
    expect(completedServiceMonths(emp({ join_date: '2015-01-01' }), ref)).toBe(12)
    expect(completedServiceMonths(emp({ join_date: ad(2083, 1, 15), end_date: ad(2083, 4, 20) }), ref)).toBe(3)
  })
  test('not joined yet by the festival → 0', () => {
    expect(completedServiceMonths(emp({ join_date: ad(2083, 7, 1) }), ref)).toBe(0)
  })
})

describe('monthly TDS after a bonus — bonus tax is settled at source (S751 review)', () => {
  test('the month after a bonus still withholds its share of salary tax', () => {
    const args = { period: { bs_year: 2083, bs_month: 7 }, monthlyGross: 150000, monthlySsf: 0, ytdMonths: 3, isSsf: false }
    const noBonus = computeMonthlyTdsBreakdown({ ...args, ytdGross: 450000, ytdWithheld: 3 * 12000 })
    // Same salary history plus a 1,00,000 Ashwin bonus withheld at 20%.
    const withBonus = computeMonthlyTdsBreakdown({ ...args, ytdGross: 550000, ytdWithheld: 3 * 12000 + 20000, ytdBonusWithheld: 20000 })
    expect(withBonus.tds).toBeGreaterThan(0)
    expect(withBonus.tds).toBeGreaterThanOrEqual(noBonus.tds)
  })
})
