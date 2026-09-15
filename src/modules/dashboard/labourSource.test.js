import fs from 'fs'
import path from 'path'
import { isPayrollFenced, payrollLabourTotal, resolveLabour, labourSourceLabel } from './labourSource'

// D22 is silent when it regresses — a margin a little too healthy — so pin the Dashboard's wiring.
describe('ClientDashboard counts labour through resolveLabour', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'pages', 'dashboard', 'ClientDashboard.jsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  test('reads the finalized run and resolves labour with the shared rule', () => {
    expect(src).toMatch(/[Ff]rom\('hr_payroll_runs'[^)]*\)\s*\.eq\('period_id'[^)]*\)\s*\.eq\('status', 'finalized'\)/)
    expect(src).toMatch(/resolveLabour\(/)
    expect(src).toMatch(/isPayrollFenced\(/)
  })
  test('net margin and fixed costs no longer divide the raw typed overhead total', () => {
    expect(src).not.toMatch(/revenueTotal - stats\.purchaseTotal - \(stats\.overheadTotal/)
    expect(src).not.toMatch(/stats\.overheadTotal \/ stats\.revenueTotal/)
  })
})

describe('isPayrollFenced', () => {
  test('an IMS login on an HR client is fenced, whatever its rank', () => {
    expect(isPayrollFenced({ hrOn: true, isAdmin: false, isOwner: false, imsRole: 'manager' })).toBe(true)
    expect(isPayrollFenced({ hrOn: true, isAdmin: false, isOwner: false, imsRole: 'staff' })).toBe(true)
  })
  test('admin and the Owner are never fenced', () => {
    expect(isPayrollFenced({ hrOn: true, isAdmin: true, isOwner: false, imsRole: 'manager' })).toBe(false)
    expect(isPayrollFenced({ hrOn: true, isAdmin: false, isOwner: true, imsRole: null })).toBe(false)
  })
  test('no HR, nothing to fence', () => {
    expect(isPayrollFenced({ hrOn: false, isAdmin: false, isOwner: false, imsRole: 'manager' })).toBe(false)
  })
})

describe('payrollLabourTotal', () => {
  test('gross + employer SSF, tolerant of strings and nulls', () => {
    expect(payrollLabourTotal([{ gross: '30000', ssf_employer: '2000' }, { gross: 10000, ssf_employer: null }])).toBe(42000)
  })
  test('null means no run; [] is a real zero', () => {
    expect(payrollLabourTotal(null)).toBeNull()
    expect(payrollLabourTotal([])).toBe(0)
  })
})

describe('resolveLabour — payroll XOR the Labor bucket, never the sum', () => {
  test('D22: finalized payroll with an empty Labor tab counts the payroll', () => {
    const r = resolveLabour({ labourBucket: 0, payroll: 400000, hrOn: true, fenced: false })
    expect(r).toEqual({ source: 'payroll', amount: 400000, ignoredBucket: 0, verdictWithheld: false })
  })
  test('payroll supersedes a typed bucket, which is named, not added', () => {
    const r = resolveLabour({ labourBucket: 150000, payroll: 400000, hrOn: true, fenced: false })
    expect(r.amount).toBe(400000)
    expect(r.ignoredBucket).toBe(150000)
  })
  test('no finalized run falls back to the typed bucket', () => {
    expect(resolveLabour({ labourBucket: 150000, payroll: null, hrOn: true, fenced: false }))
      .toEqual({ source: 'overheads', amount: 150000, ignoredBucket: 0, verdictWithheld: false })
  })
  test('nothing anywhere is "none", not a judged zero-labour month', () => {
    expect(resolveLabour({ labourBucket: 0, payroll: null, hrOn: true, fenced: false }).source).toBe('none')
  })
  test('a fenced login withholds the verdict rather than trusting the bucket', () => {
    const r = resolveLabour({ labourBucket: 150000, payroll: null, hrOn: true, fenced: true })
    expect(r.source).toBe('unreadable')
    expect(r.verdictWithheld).toBe(true)
    expect(r.amount).toBe(150000)
  })
  test('a failed payroll read withholds the verdict too', () => {
    const r = resolveLabour({ labourBucket: 0, payroll: null, hrOn: true, fenced: false, readFailed: true })
    expect(r.source).toBe('failed')
    expect(r.verdictWithheld).toBe(true)
  })

  // Overheads.js computes this inline today; the helper must give the same answer on every branch
  // so the page can adopt it without moving a figure.
  test.each([
    [0, 400000, false], [150000, 400000, false], [150000, null, false], [0, null, false], [150000, null, true], [0, null, true],
  ])('agrees with Overheads.js inline rule (bucket %p, payroll %p, fenced %p)', (bucket, payroll, fenced) => {
    const labourEffective = payroll != null ? payroll : bucket
    const source = payroll != null ? 'payroll' : fenced ? 'unreadable' : bucket > 0 ? 'overheads' : 'none'
    const ignored = payroll != null && bucket > 0 ? bucket : 0
    const r = resolveLabour({ labourBucket: bucket, payroll, hrOn: true, fenced })
    expect([r.source, r.amount, r.ignoredBucket, r.verdictWithheld]).toEqual([source, labourEffective, ignored, source === 'unreadable'])
  })
})

test('every source has a label', () => {
  for (const source of ['payroll', 'overheads', 'none', 'unreadable', 'failed']) {
    expect(labourSourceLabel({ source }, true)).toMatch(/^Labour: /)
  }
})
