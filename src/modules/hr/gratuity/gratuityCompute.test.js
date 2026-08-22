import { calcGratuity, serviceMonths, monthsBetween } from './gratuityCompute'
import { SSF_CAP, SSF_GRATUITY_PCT } from '../payrollConstants'

const AS_OF = new Date(2026, 7, 22)   // 22 Aug 2026, the date this was written

describe('serviceMonths', () => {
  it('counts whole months, ignoring day-of-month', () => {
    expect(serviceMonths('2025-08-01', AS_OF)).toBe(12)
    expect(serviceMonths('2025-08-31', AS_OF)).toBe(12)
  })

  it('never goes negative for a future join date, and is 0 for a missing or unparseable one', () => {
    expect(serviceMonths('2027-01-01', AS_OF)).toBe(0)
    expect(serviceMonths('', AS_OF)).toBe(0)
    expect(serviceMonths('not-a-date', AS_OF)).toBe(0)
    expect(monthsBetween(null, AS_OF)).toBe(0)
  })
})

describe('calcGratuity — vesting', () => {
  const emp = { basic_salary: 50000, join_date: '2026-01-01' }   // ~7 months

  it('accrues before vesting but pays nothing', () => {
    const g = calcGratuity(emp, { asOf: AS_OF })
    expect(g.vested).toBe(false)
    expect(g.totalAccrued).toBeGreaterThan(0)   // the Tracker still reports a future cost
    expect(g.payable).toBe(0)                   // a settlement pays nothing before 12 months
  })

  it('pays once vested', () => {
    const g = calcGratuity({ ...emp, join_date: '2024-01-01' }, { asOf: AS_OF })
    expect(g.vested).toBe(true)
    expect(g.payable).toBe(g.netLiability)
  })
})

describe('calcGratuity — the SSF gate', () => {
  const base = { basic_salary: 50000, join_date: '2020-08-01' }  // 72 months

  it('applies no offset when the employee is not enrolled', () => {
    const g = calcGratuity({ ...base, ssf_enrolled: false }, { asOf: AS_OF, ssfMonths: 72 })
    expect(g.enrolled).toBe(false)
    expect(g.ssfCovered).toBe(0)
    expect(g.netLiability).toBe(g.totalAccrued)
  })

  it('applies no offset when enrolled but the SSF number is blank — payroll contributed nothing', () => {
    // The gate payroll uses: ssf_enrolled AND ssf_no. Netting off a contribution that was never
    // made underpays the leaver.
    for (const ssf_no of [undefined, null, '', '   ']) {
      const g = calcGratuity({ ...base, ssf_enrolled: true, ssf_no }, { asOf: AS_OF, ssfMonths: 72 })
      expect(g.enrolled).toBe(false)
      expect(g.ssfCovered).toBe(0)
    }
  })

  it('applies the offset when genuinely enrolled', () => {
    const g = calcGratuity({ ...base, ssf_enrolled: true, ssf_no: '12345' }, { asOf: AS_OF, ssfMonths: 72 })
    expect(g.enrolled).toBe(true)
    expect(g.ssfCovered).toBeCloseTo(50000 * SSF_GRATUITY_PCT * 72, 6)
  })
})

describe('calcGratuity — the SSF offset is capped at real enrolment', () => {
  // 10 years of service, SSF joined 2 years ago. This is the NPR ~320k bug.
  const emp = { basic_salary: 120000, join_date: '2016-08-01', ssf_enrolled: true, ssf_no: '9001' }

  it('offsets only the months SSF actually contributed', () => {
    const g = calcGratuity(emp, { asOf: AS_OF, ssfMonths: 24 })
    expect(g.months).toBe(120)
    expect(g.coveredMonths).toBe(24)
    expect(g.ssfCovered).toBeCloseTo(SSF_CAP * SSF_GRATUITY_PCT * 24, 6)
  })

  it('is worth six figures against the old whole-service assumption', () => {
    const correct = calcGratuity(emp, { asOf: AS_OF, ssfMonths: 24 })
    const oldWay  = calcGratuity(emp, { asOf: AS_OF, ssfMonths: 120 })
    expect(correct.netLiability - oldWay.netLiability).toBeGreaterThan(300000)
  })

  it('applies NO offset when the enrolment history is unknown, and says so', () => {
    // Failing toward paying the leaver is the only safe direction for an unknown.
    const g = calcGratuity(emp, { asOf: AS_OF, ssfMonths: null })
    expect(g.coverageKnown).toBe(false)
    expect(g.ssfCovered).toBe(0)
    expect(g.netLiability).toBe(g.totalAccrued)
  })

  it('reports coverage as known when the employee simply is not enrolled', () => {
    const g = calcGratuity({ ...emp, ssf_enrolled: false }, { asOf: AS_OF, ssfMonths: null })
    expect(g.coverageKnown).toBe(true)
  })

  it('never lets SSF cover more months than the employee actually worked', () => {
    const g = calcGratuity(emp, { asOf: AS_OF, ssfMonths: 500 })
    expect(g.coveredMonths).toBe(g.months)
    expect(g.netLiability).toBeGreaterThanOrEqual(0)
  })

  it('caps the offset at the SSF ceiling, not the full basic', () => {
    const g = calcGratuity(emp, { asOf: AS_OF, ssfMonths: 12 })
    expect(g.ssfMonthly).toBeCloseTo(SSF_CAP * SSF_GRATUITY_PCT, 6)   // basic 120k > cap 100k
  })
})

describe('calcGratuity — the reference date is the caller\'s choice', () => {
  it('measures to the last working day, not to today', () => {
    const emp = { basic_salary: 30000, join_date: '2024-08-01' }
    const atExit = calcGratuity(emp, { asOf: new Date(2025, 7, 15) })
    const today  = calcGratuity(emp, { asOf: AS_OF })
    expect(atExit.months).toBe(12)
    expect(today.months).toBe(24)
    expect(atExit.totalAccrued).toBeLessThan(today.totalAccrued)
  })
})

describe('calcGratuity — degenerate input', () => {
  it('does not throw on a missing employee or missing salary', () => {
    expect(calcGratuity(null).payable).toBe(0)
    expect(calcGratuity({}).totalAccrued).toBe(0)
    expect(calcGratuity({ basic_salary: 'abc', join_date: '2020-01-01' }, { asOf: AS_OF }).basic).toBe(0)
  })
})
