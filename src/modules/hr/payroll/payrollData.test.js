import { groupByEmployee, sliceFor, buildAdvanceMap, firstRecoveryMonth, advanceDueIn, dueAdvances, payrollCashCost, ytdFromPayslips } from './payrollData'
import { bsToAd, daysInBsMonth, formatAd } from '../../../utils/bsCalendar'

// `buildRows` in PayrollRun.jsx and `rows` in PayrollCalculation.jsx replaced a per-employee
// `rows.filter(r => r.employee_id === emp.id)` with one pass through groupByEmployee. Both feed
// computePayslip on a path that WRITES payslips, so the slices have to be exactly what the filter
// produced — same members, same order — not merely the same set.
describe('groupByEmployee', () => {
  const rows = [
    { id: 1, employee_id: 'b', bs_day: 3 },
    { id: 2, employee_id: 'a', bs_day: 1 },
    { id: 3, employee_id: 'b', bs_day: 1 },
    { id: 4, employee_id: 'a', bs_day: 2 },
    { id: 5, employee_id: 'c', bs_day: 9 },
  ]

  it('produces the same slice a .filter() would, in the same order', () => {
    const index = groupByEmployee(rows)
    for (const id of ['a', 'b', 'c']) {
      expect(sliceFor(index, id)).toEqual(rows.filter(r => r.employee_id === id))
    }
  })

  it('returns an empty slice for an employee with no rows', () => {
    // A mid-month joiner with no attendance yet is ordinary, not an edge case — computePayslip
    // must receive [], never undefined.
    expect(sliceFor(groupByEmployee(rows), 'nobody')).toEqual([])
  })

  it('tolerates a null/undefined result set', () => {
    expect(sliceFor(groupByEmployee(null), 'a')).toEqual([])
    expect(sliceFor(groupByEmployee(undefined), 'a')).toEqual([])
  })

  it('keeps rows whose key is null in their own bucket rather than dropping them', () => {
    // A dropped row would silently remove someone's attendance from a payslip.
    const withNull = [...rows, { id: 6, employee_id: null }]
    const index = groupByEmployee(withNull)
    expect(sliceFor(index, null)).toEqual([{ id: 6, employee_id: null }])
    expect([...index.values()].flat()).toHaveLength(withNull.length)
  })

  it('accepts a different key column', () => {
    expect(sliceFor(groupByEmployee(rows, 'bs_day'), 1)).toEqual(rows.filter(r => r.bs_day === 1))
  })
})

// ── When recovery of an advance starts ──────────────────────────────────────────────────────────
// Found 2026-09-11 (docs/CROSS-REPO.md): an advance issued in Bhadra was deducted from a
// still-open Shrawan run, because buildAdvanceMap() filtered on `status` alone and never compared
// the issued date with the payroll month. The owner's rule, shared with hss-suite: first cut on
// the payroll of the BS month AFTER the month of issue; the day inside the month never matters.
// Dates are built from the BS calendar itself so the test hard-codes no conversions.
const ad = (y, m, d) => formatAd(bsToAd(y, m, d))
const P  = (bs_year, bs_month) => ({ bs_year, bs_month })
const adv = (over = {}) => ({
  id: 'a1', employee_id: 'e1', status: 'active',
  amount: '5000', installment_amount: '1000', issued_date: ad(2083, 5, 1), ...over,
})

describe('firstRecoveryMonth', () => {
  it('is the BS month after the issued date', () => {
    expect(firstRecoveryMonth(ad(2083, 5, 1))).toEqual(P(2083, 6))
  })
  it('does not care which day of the month the advance was issued', () => {
    expect(firstRecoveryMonth(ad(2083, 5, 28))).toEqual(P(2083, 6))
    expect(firstRecoveryMonth(ad(2083, 5, daysInBsMonth(2083, 5)))).toEqual(P(2083, 6))
  })
  it('rolls Chaitra over into Baisakh of the next BS year', () => {
    expect(firstRecoveryMonth(ad(2082, 12, 15))).toEqual(P(2083, 1))
    expect(firstRecoveryMonth(ad(2082, 12, 1))).toEqual(P(2083, 1))
  })
  it('accepts a full timestamp and a bare date alike', () => {
    expect(firstRecoveryMonth(ad(2083, 5, 1) + 'T10:00:00+05:45')).toEqual(P(2083, 6))
  })
  it('is null when there is no date or the calendar cannot convert it', () => {
    expect(firstRecoveryMonth(null)).toBeNull()
    expect(firstRecoveryMonth('')).toBeNull()
    expect(firstRecoveryMonth('1900-01-01')).toBeNull()
    expect(firstRecoveryMonth('not a date')).toBeNull()
  })
})

describe('advanceDueIn', () => {
  it('the reported case: issued in Bhadra is NOT due in Shrawan or Bhadra, and is due from Ashwin', () => {
    const a = adv()
    expect(advanceDueIn(a, P(2083, 4))).toBe(false)
    expect(advanceDueIn(a, P(2083, 5))).toBe(false)
    expect(advanceDueIn(a, P(2083, 6))).toBe(true)
    expect(advanceDueIn(a, P(2083, 7))).toBe(true)
    expect(advanceDueIn(a, P(2084, 1))).toBe(true)
  })
  it('issued in Chaitra is not due in Chaitra, and is due in Baisakh of the next year', () => {
    const a = adv({ issued_date: ad(2082, 12, 20) })
    expect(advanceDueIn(a, P(2082, 12))).toBe(false)
    expect(advanceDueIn(a, P(2083, 1))).toBe(true)
  })
  it('an unconvertible or missing issued date, or a missing period, is never due', () => {
    expect(advanceDueIn(adv({ issued_date: '1900-01-01' }), P(2083, 6))).toBe(false)
    expect(advanceDueIn(adv({ issued_date: null }), P(2083, 6))).toBe(false)
    expect(advanceDueIn(adv(), null)).toBe(false)
  })
})

describe('dueAdvances', () => {
  it('keeps only open advances already past their first recovery month', () => {
    const old     = adv({ id: 'old', issued_date: ad(2083, 2, 10) })
    const fresh   = adv({ id: 'fresh', issued_date: ad(2083, 5, 1) })
    const settled = adv({ id: 'settled', issued_date: ad(2083, 1, 1), status: 'settled' })
    expect(dueAdvances([old, fresh, settled], P(2083, 5)).map(a => a.id)).toEqual(['old'])
    expect(dueAdvances([old, fresh, settled], P(2083, 6)).map(a => a.id)).toEqual(['old', 'fresh'])
  })
  it('tolerates a missing list', () => {
    expect(dueAdvances(undefined, P(2083, 6))).toEqual([])
  })
})

describe('buildAdvanceMap', () => {
  it('deducts nothing in the month of issue or before it, and the installment from the month after', () => {
    expect(buildAdvanceMap([adv()], [], P(2083, 4))).toEqual({})
    expect(buildAdvanceMap([adv()], [], P(2083, 5))).toEqual({})
    expect(buildAdvanceMap([adv()], [], P(2083, 6))).toEqual({ e1: 1000 })
  })
  it('treats the last day of Bhadra exactly like the first', () => {
    const last = ad(2083, 5, daysInBsMonth(2083, 5))
    expect(buildAdvanceMap([adv({ issued_date: last })], [], P(2083, 5))).toEqual({})
    expect(buildAdvanceMap([adv({ issued_date: last })], [], P(2083, 6))).toEqual({ e1: 1000 })
  })
  it('still nets out repayments, caps at the outstanding balance and skips settled advances', () => {
    const reps = [{ advance_id: 'a1', amount: '4500' }]
    expect(buildAdvanceMap([adv()], reps, P(2083, 6))).toEqual({ e1: 500 })
    expect(buildAdvanceMap([adv({ status: 'settled' })], [], P(2083, 6))).toEqual({})
  })
  it('an advance with no installment is recovered in full, once it is due', () => {
    expect(buildAdvanceMap([adv({ installment_amount: null })], [], P(2083, 6))).toEqual({ e1: 5000 })
  })
  it('recovers only the due advance when an employee holds a due one and a fresh one', () => {
    const due   = adv({ id: 'a1', issued_date: ad(2083, 3, 1), installment_amount: '250' })
    const fresh = adv({ id: 'a2', issued_date: ad(2083, 5, 1) })
    expect(buildAdvanceMap([due, fresh], [], P(2083, 5))).toEqual({ e1: 250 })
    expect(buildAdvanceMap([due, fresh], [], P(2083, 6))).toEqual({ e1: 1250 })
  })
  it('refuses to run without a period, rather than answering "nobody owes anything"', () => {
    expect(() => buildAdvanceMap([adv()], [])).toThrow(/period/)
    expect(() => buildAdvanceMap([adv()], [], {})).toThrow(/period/)
    expect(() => buildAdvanceMap([adv()], [], null)).toThrow(/period/)
  })
})

describe('payrollCashCost (S753)', () => {
  it('is pay earned plus employer SSF — not net pay, and travel claims are reported apart', () => {
    const slips = [
      { gross: 30000, absence_deduction: 1000, ot_amount: 500, ssf_employer: 6000, ssf_employee: 3300, tds: 250, net_pay: 26000, tada_amount: 1200 },
      { gross: 20000, absence_deduction: 0, ot_amount: 0, ssf_employer: 0, tada_amount: 0 },
    ]
    expect(payrollCashCost(slips)).toEqual({ total: 55500, earned: 49500, employerSsf: 6000, tada: 1200 })
  })

  it('treats blanks as zero and rounds to paisa', () => {
    expect(payrollCashCost([{ gross: '100.005', ssf_employer: null }, {}])).toEqual({ total: 100.01, earned: 100.01, employerSsf: 0, tada: 0 })
    expect(payrollCashCost(null).total).toBe(0)
  })
})

// Year-to-date taxable income for monthly TDS and Final Settlement. hss-suite found (2026-09-17) that
// earlier months were summed as gross + OT while the current month is taxed on gross − unpaid days
// + OT, so anyone with an absence or a part month had every earlier month overstated and was
// over-withheld for the rest of the year. Same line was in crest.
describe('ytdFromPayslips', () => {
  const slip = (bs_month, over = {}) => ({
    employee_id: 'e1', gross: 30000, ot_amount: 0, absence_deduction: 0, ssf_employee: 0,
    retirement_contribution: 0, tds: 100,
    hr_payroll_runs: { status: 'finalized', monthly_periods: { bs_year: 2083, bs_month } },
    ...over,
  })
  const ASHWIN = { bs_year: 2083, bs_month: 6 }

  it('counts an earlier month at pay earned: gross − unpaid days + overtime', () => {
    const ytd = ytdFromPayslips([slip(4, { absence_deduction: 4000, ot_amount: 1500 }), slip(5)], [], ASHWIN)
    expect(ytd.e1.gross).toBe(30000 - 4000 + 1500 + 30000)
    expect(ytd.e1.count).toBe(2)
    expect(ytd.e1.withheld).toBe(200)
  })

  it('leaves out the current month, later months, drafts and other fiscal years', () => {
    const ytd = ytdFromPayslips([
      slip(6), slip(7),                                                             // this month, later
      slip(5, { hr_payroll_runs: { status: 'draft', monthly_periods: { bs_year: 2083, bs_month: 5 } } }),
      slip(3),                                                                      // Ashadh 2083: FY 2082/83
    ], [], ASHWIN)
    expect(ytd.e1).toBeUndefined()
  })

  it('adds earlier finalized bonuses to gross and withheld but not to the month count', () => {
    const ytd = ytdFromPayslips([slip(4)], [{ employee_id: 'e1', amount: '10000', tds: '500', bs_year: 2083, bs_month: 5 }], ASHWIN)
    expect(ytd.e1).toMatchObject({ gross: 40000, withheld: 600, count: 1, bonus: 10000, bonusWithheld: 500 })
  })

  it('refuses a row whose query left out absence_deduction, rather than quietly subtracting nothing', () => {
    const { absence_deduction, ...noAbsence } = slip(4)
    expect(() => ytdFromPayslips([noAbsence], [], ASHWIN)).toThrow(/absence_deduction/)
  })
})
