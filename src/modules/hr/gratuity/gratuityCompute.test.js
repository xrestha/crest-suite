import { calcGratuity, serviceMonths, completedMonths, dayAfter, SSF_GRATUITY_SHARE_OF_EMPLOYER } from './gratuityCompute'
import { ssfFundedFor } from './ssfEnrolment'
import { SSF_GRATUITY_PCT, SSF_EMPLOYER_PCT } from '../payrollConstants'
import { bsToAd, formatAd } from '../../../utils/bsCalendar'

const bs = (y, m, d) => formatAd(bsToAd(y, m, d))
const AS_OF = new Date(2026, 7, 22)   // 22 Aug 2026

describe('completedMonths — the day matters (S752)', () => {
  it('counts a month only once the same BS day of the next month is reached', () => {
    expect(completedMonths(bs(2082, 5, 10), bs(2083, 5, 10))).toBe(12)
    expect(completedMonths(bs(2082, 5, 10), bs(2083, 5, 9))).toBe(11)
  })

  it('11 months and 29 days is 11, not 12 — the vesting boundary', () => {
    const join = bs(2082, 4, 15)
    const none = { amount: 0, months: 0 }
    // Last working day 13 Shrawan 2083: service runs to the start of the 14th, one day short.
    expect(serviceMonths(join, dayAfter(bs(2083, 4, 13)))).toBe(11)
    expect(calcGratuity({ basic_salary: 40000, join_date: join }, { asOf: dayAfter(bs(2083, 4, 13)), ssfFunded: none }).payable).toBe(0)
    // Working the 14th as well completes the year.
    expect(serviceMonths(join, dayAfter(bs(2083, 4, 14)))).toBe(12)
    expect(calcGratuity({ basic_salary: 40000, join_date: join }, { asOf: dayAfter(bs(2083, 4, 14)), ssfFunded: none }).payable).toBeGreaterThan(0)
  })

  it('clamps a join on a long month\'s last day to a shorter month', () => {
    // Joined on day 32 of a 32-day month; the next month's anniversary is that month's last day.
    const n = completedMonths(bs(2083, 3, 32), bs(2083, 4, 31))
    expect(n).toBe(1)
  })

  it('is 0 for a future, missing or unparseable join date', () => {
    expect(serviceMonths('2027-01-01', AS_OF)).toBe(0)
    expect(serviceMonths('', AS_OF)).toBe(0)
    expect(serviceMonths('not-a-date', AS_OF)).toBe(0)
    expect(completedMonths(null, AS_OF)).toBe(0)
  })

  it('dayAfter crosses a month end in local time', () => {
    expect(dayAfter('2026-08-31')).toBe('2026-09-01')
  })
})

describe('calcGratuity — vesting', () => {
  const emp = { basic_salary: 50000, join_date: '2026-01-01' }

  it('accrues before vesting but pays nothing', () => {
    const g = calcGratuity(emp, { asOf: AS_OF, ssfFunded: { amount: 0, months: 0 } })
    expect(g.vested).toBe(false)
    expect(g.totalAccrued).toBeGreaterThan(0)
    expect(g.payable).toBe(0)
  })

  it('pays once vested', () => {
    const g = calcGratuity({ ...emp, join_date: '2024-01-01' }, { asOf: AS_OF, ssfFunded: { amount: 0, months: 0 } })
    expect(g.vested).toBe(true)
    expect(g.payable).toBe(g.netLiability)
  })
})

describe('calcGratuity — the SSF offset is what was really contributed (S752)', () => {
  const emp = { basic_salary: 50000, join_date: '2020-08-01', ssf_enrolled: true, ssf_no: '9001' }

  it('takes the gratuity share of the stored employer contributions, not today\'s basic × months', () => {
    // 48 months at 20,000 basic then 12 at 50,000: employer 20% of each.
    const rows = [
      ...Array.from({ length: 48 }, (_, i) => ({ bs_year: 2078 + Math.floor(i / 12), bs_month: (i % 12) + 1, employer: 20000 * SSF_EMPLOYER_PCT })),
      ...Array.from({ length: 12 }, (_, i) => ({ bs_year: 2082, bs_month: i + 1, employer: 50000 * SSF_EMPLOYER_PCT })),
    ]
    const funded = ssfFundedFor(rows)
    expect(funded.months).toBe(60)
    expect(funded.amount).toBeCloseTo((48 * 20000 + 12 * 50000) * SSF_GRATUITY_PCT, 6)
    const g = calcGratuity(emp, { asOf: AS_OF, ssfFunded: funded })
    const oldWay = 50000 * SSF_GRATUITY_PCT * 60
    expect(oldWay - g.ssfCovered).toBeGreaterThan(47000)
  })

  it('the gratuity share of the employer 20% is 3.33 of it', () => {
    expect(SSF_GRATUITY_SHARE_OF_EMPLOYER * SSF_EMPLOYER_PCT).toBeCloseTo(SSF_GRATUITY_PCT, 10)
  })

  it('an unpaid month contributes what it actually paid', () => {
    const funded = ssfFundedFor([{ bs_year: 2082, bs_month: 5, employer: 5000 }, { bs_year: 2082, bs_month: 6, employer: 2500 }])
    expect(funded.amount).toBeCloseTo(7500 * SSF_GRATUITY_SHARE_OF_EMPLOYER, 6)
  })

  it('leaves out an earlier spell of service and the settlement\'s own final month', () => {
    const rows = [
      { bs_year: 2079, bs_month: 1, employer: 4000 },   // before the rehire
      { bs_year: 2083, bs_month: 1, employer: 4000 },
      { bs_year: 2083, bs_month: 2, employer: 4000 },   // the final month, added by the settlement
    ]
    const funded = ssfFundedFor(rows, { joinDate: bs(2082, 12, 1), beforeBs: { bs_year: 2083, bs_month: 2 } })
    expect(funded.months).toBe(1)
  })

  it('applies NO offset when the contributions could not be read, and says so', () => {
    const g = calcGratuity(emp, { asOf: AS_OF, ssfFunded: null })
    expect(g.coverageKnown).toBe(false)
    expect(g.ssfCovered).toBe(0)
    expect(g.netLiability).toBe(g.totalAccrued)
  })

  it('never offsets more than was accrued', () => {
    const g = calcGratuity({ ...emp, join_date: '2026-06-01' }, { asOf: AS_OF, ssfFunded: { amount: 10_000_000, months: 999 } })
    expect(g.netLiability).toBe(0)
    expect(g.ssfCovered).toBe(g.totalAccrued)
  })

  it('offsets real contributions even if the flag has since been turned off', () => {
    const g = calcGratuity({ ...emp, ssf_enrolled: false }, { asOf: AS_OF, ssfFunded: { amount: 12000, months: 12 } })
    expect(g.enrolled).toBe(false)
    expect(g.ssfCovered).toBe(12000)
  })
})

describe('calcGratuity — degenerate input', () => {
  it('does not throw on a missing employee or missing salary', () => {
    expect(calcGratuity(null).payable).toBe(0)
    expect(calcGratuity({}).totalAccrued).toBe(0)
    expect(calcGratuity({ basic_salary: 'abc', join_date: '2020-01-01' }, { asOf: AS_OF }).basic).toBe(0)
  })
})
