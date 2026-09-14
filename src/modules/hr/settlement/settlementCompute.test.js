import { computeSettlement, earnedLeaveBalance, noticeDirection, settlementColumns, NOTICE_DAY_DIVISOR } from './settlementCompute'
import { computePayslip } from '../payroll/payrollCompute'
import { computeMonthlyTds, computeFinalMonthTds } from '../payroll/tds'
import { bsToAd, formatAd, daysInBsMonth } from '../../../utils/bsCalendar'
import { SSF_EMPLOYER_PCT, SSF_GRATUITY_PCT } from '../payrollConstants'

const bs = (y, m, d) => formatAd(bsToAd(y, m, d))
const EMP = {
  id: 'e1', full_name: 'Test Leaver', basic_salary: 40000, pay_basis: 'monthly',
  join_date: bs(2080, 4, 1), ssf_enrolled: true, ssf_no: 'SSF-1', marital_status: 'single',
}
const LAST = { year: 2083, month: 5, day: 15 }   // 15 Bhadra 2083
const CIT = { employee_id: 'e1', type: 'deduction', calc_type: 'fixed', value: 2000, retirement_fund: true }
const ALLOW = { employee_id: 'e1', type: 'earning', calc_type: 'fixed', value: 10000 }

describe('the final month is the payroll engine\'s month (S752)', () => {
  const otEntries = [{ employee_id: 'e1', bs_day: 3, ot_hours: 10, ot_type: 'weekday', status: 'approved' }]
  const c = computeSettlement({ emp: EMP, lastDate: LAST, components: [ALLOW, CIT], otEntries, ssfRows: [] })

  it('matches computePayslip with the last working day as the end date', () => {
    const slip = computePayslip({ ...EMP, end_date: bs(2083, 5, 15) }, [ALLOW, CIT], [], { bs_year: 2083, bs_month: 5 }, 0, otEntries, 0)
    expect(c.slip.gross).toBe(slip.gross)
    expect(c.slip.absence_deduction).toBe(slip.absence_deduction)
    expect(c.slip.ssf_employee).toBe(slip.ssf_employee)
    expect(c.slip.other_deductions).toBe(slip.other_deductions)
  })

  it('pays the overtime, and deducts SSF and CIT, which the old copy never did', () => {
    expect(c.slip.ot_amount).toBeGreaterThan(0)
    expect(c.slip.ssf_employee).toBeGreaterThan(0)
    expect(c.slip.ssf_employer).toBeGreaterThan(0)
    expect(c.slip.other_deductions).toBe(2000)
    expect(c.totalDeductions).toBeGreaterThanOrEqual(c.slip.ssf_employee + 2000)
  })

  it('pays only the days to the last working day', () => {
    const days = daysInBsMonth(2083, 5)
    expect(c.slip.unpaid_days).toBe(days - 15)
  })

  it('ignores attendance marked after the last working day rather than docking it twice', () => {
    const late = [{ employee_id: 'e1', bs_day: 20, status: 'absent', hours_worked: 0, ot_hours: 0 }]
    const withLate = computeSettlement({ emp: EMP, lastDate: LAST, components: [ALLOW], attendance: late, ssfRows: [] })
    const without = computeSettlement({ emp: EMP, lastDate: LAST, components: [ALLOW], ssfRows: [] })
    expect(withLate.slip.absence_deduction).toBe(without.slip.absence_deduction)
  })
})

describe('the final month\'s tax is trued up to the year actually earned', () => {
  it('withholds more than the projection, which spreads the year over months never paid', () => {
    const args = { fyStart: 2083, monthlyIncome: 150000, monthlySsf: 0, ytdGross: 150000, ytdWithheld: 1500, isSsf: false }
    const trued = computeFinalMonthTds(args).tds
    const projected = computeMonthlyTds({ period: { bs_year: 2083, bs_month: 5 }, monthlyGross: 150000, monthlySsf: 0, ytdGross: 150000, ytdWithheld: 1500, ytdMonths: 1, isSsf: false })
    expect(trued).not.toBe(projected)
    // Two months at 1.5 lakh is 3 lakh for the year: 1% = 3,000, less 1,500 already withheld.
    expect(trued).toBe(1500)
  })

  it('never refunds through a negative withholding', () => {
    expect(computeFinalMonthTds({ fyStart: 2083, monthlyIncome: 1000, ytdGross: 1000, ytdWithheld: 50000 }).tds).toBe(0)
  })
})

describe('notice pay (S752, decided)', () => {
  it('runs by reason', () => {
    expect(noticeDirection('resignation')).toBe('deduct')
    expect(noticeDirection('termination')).toBe('add')
    expect(noticeDirection('mutual')).toBe(null)
    expect(noticeDirection('retirement')).toBe(null)
  })

  it('is basic ÷ 30 per calendar day — 30 days is one month, not 1.15', () => {
    const r = computeSettlement({ emp: EMP, lastDate: LAST, reason: 'resignation', noticeDays: 30, noticeServed: false, ssfRows: [] })
    expect(NOTICE_DAY_DIVISOR).toBe(30)
    expect(r.noticeDeduction).toBe(40000)
    const t = computeSettlement({ emp: EMP, lastDate: LAST, reason: 'termination', noticeDays: 30, noticeServed: false, ssfRows: [] })
    expect(t.noticeDeduction).toBe(0)
    expect(t.noticePay).toBe(40000)
    expect(t.grossPayout - r.grossPayout).toBeCloseTo(40000 + (t.monthIncome - r.monthIncome), 2)
  })

  it('served notice moves nothing', () => {
    const s = computeSettlement({ emp: EMP, lastDate: LAST, reason: 'termination', noticeDays: 30, noticeServed: true, ssfRows: [] })
    expect(s.noticePay + s.noticeDeduction).toBe(0)
  })
})

describe('festival share, leave and TADA', () => {
  it('festival counts completed months worked this fiscal year, from the join date when later', () => {
    const joined = { ...EMP, join_date: bs(2083, 4, 10) }   // 10 Shrawan
    const c = computeSettlement({ emp: joined, lastDate: { year: 2083, month: 9, day: 5 }, festivalPaid: false, ssfRows: [] })
    // 10 Shrawan → 5 Poush: Bhadra 10, Ashwin 10, Kartik 10, Mangsir 10 → 4 completed.
    expect(c.festivalMonths).toBe(4)
    expect(c.festivalPro).toBeCloseTo(40000 * 4 / 12, 2)
  })

  it('leave: quota × completed months this BS year ÷ 12, less days taken', () => {
    const b = earnedLeaveBalance({ quota: 18, used: 1, joinDate: EMP.join_date, lastDate: { year: 2083, month: 4, day: 32 } })
    // Baisakh–Shrawan 2083 is 4 completed months by the day after 32 Shrawan.
    expect(b.monthsWorked).toBe(4)
    expect(b.remaining).toBe(5)
  })

  it('an uncapped leave type has no balance to encash', () => {
    expect(earnedLeaveBalance({ quota: 0, lastDate: LAST }).capped).toBe(false)
  })

  it('pays approved travel claims on top', () => {
    const a = computeSettlement({ emp: EMP, lastDate: LAST, tada: { total: 1234.5, ids: ['t1'] }, ssfRows: [] })
    const b = computeSettlement({ emp: EMP, lastDate: LAST, ssfRows: [] })
    expect(a.grossPayout - b.grossPayout).toBeCloseTo(1234.5, 2)
    expect(a.tadaIds).toEqual(['t1'])
  })
})

describe('advances and gratuity', () => {
  it('recovers advances only up to what the payout covers', () => {
    const c = computeSettlement({ emp: { ...EMP, join_date: bs(2083, 5, 1) }, lastDate: LAST, advances: [{ outstanding: 500000 }], ssfRows: [] })
    expect(c.advanceRecovered).toBeLessThan(500000)
    expect(c.advanceShortfall).toBeCloseTo(500000 - c.advanceRecovered, 2)
    expect(c.netPayout).toBeLessThan(0)
  })

  it('counts the final month\'s own employer SSF toward what SSF funded', () => {
    const prior = [{ bs_year: 2083, bs_month: 4, employer: 40000 * SSF_EMPLOYER_PCT }]
    const c = computeSettlement({ emp: EMP, lastDate: LAST, ssfRows: prior })
    expect(c.gratuity.coveredMonths).toBe(2)
    expect(c.gratuity.ssfCovered).toBeCloseTo((40000 + c.slip.ssf_employer / SSF_EMPLOYER_PCT) * SSF_GRATUITY_PCT, 4)
  })

  it('reports unknown SSF coverage when that read failed', () => {
    expect(computeSettlement({ emp: EMP, lastDate: LAST, ssfRows: null }).ssfCoverageKnown).toBe(false)
  })

  it('stores the month the engine computed, and the calc version', () => {
    const c = computeSettlement({ emp: EMP, lastDate: LAST, components: [CIT], ssfRows: [] })
    const cols = settlementColumns(c, { emp: EMP, reason: 'resignation', noticeDays: 0, noticeServed: true, leaveDays: 0, festivalPaid: true })
    expect(cols.calc_version).toBe(2)
    expect(cols.settle_bs_year).toBe(2083)
    expect(cols.settle_bs_month).toBe(5)
    expect(cols.month_ssf_employee).toBe(c.slip.ssf_employee)
    expect(cols.month_retirement_contribution).toBe(2000)
    expect(cols.last_working_date).toBe(bs(2083, 5, 15))
  })
})
