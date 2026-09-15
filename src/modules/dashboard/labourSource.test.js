import fs from 'fs'
import path from 'path'
import {
  isPayrollFenced, payrollLabourTotal, resolveLabour, labourSourceLabel,
  finalizedPayrollCost, resolveOwnerLabour, ownerLabourNote,
} from './labourSource'

const readSource = (...parts) => fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

// S756: Overheads carried the rule inline; one definition is the whole point of the helper.
describe('Overheads adopts the shared labour rule', () => {
  const src = readSource('modules', 'ims', 'reports', 'Overheads.js')
  test('imports and calls resolveLabour, isPayrollFenced and payrollLabourTotal', () => {
    expect(src).toMatch(/import \{[^}]*resolveLabour[^}]*\} from '\.\.\/\.\.\/dashboard\/labourSource'/)
    expect(src).toMatch(/resolveLabour\(\{/)
    expect(src).toMatch(/isPayrollFenced\(\{/)
    expect(src).toMatch(/payrollLabourTotal\(/)
  })
  test('no longer carries the inline precedence, fence or payslip sum', () => {
    expect(src).not.toMatch(/labourPayroll != null \? labourPayroll : totals\.labor/)
    expect(src).not.toMatch(/payrollFenced \? 'unreadable'/)
    expect(src).not.toMatch(/hrOn && !isAdmin && !isOwner && !!profile\?\.ims_role/)
    expect(src).not.toMatch(/parseFloat\(ps\.gross\)/)
  })
  test('pages the payslip read with a unique tiebreaker', () => {
    expect(src).toMatch(/fetchAllRowsChunked\(runIds,[\s\S]{0,120}[Ff]rom\('hr_payslips'[^)]*\)\.in\('run_id', chunk\)\.order\('id'\)/)
  })
})

describe('OwnerDashboard uses finalized payroll when it exists', () => {
  const src = readSource('pages', 'dashboard', 'OwnerDashboard.jsx')
  test('reads the finalized run and pages its payslips, OT included', () => {
    expect(src).toMatch(/scopedFrom\('hr_payroll_runs', 'id'\)\.eq\('period_id', period\.id\)\.eq\('status', 'finalized'\)/)
    expect(src).toMatch(/fetchAllRowsChunked\(runIds,[\s\S]{0,120}'gross, ot_amount, ssf_employer'\)\.in\('run_id', chunk\)\.order\('id'\)/)
    expect(src).toMatch(/resolveOwnerLabour\(\{/)
  })
  test('keeps the XOR: overheads read is the overhead bucket only', () => {
    expect(src).toMatch(/from\('overheads'\)\.select\('amount'\)\.eq\('period_id', period\.id\)\.eq\('bucket', 'overhead'\)/)
    expect(src).not.toMatch(/'bucket', 'labor'/)
  })
  test('the labour tile goes through settledFigure, not a bare band colour', () => {
    expect(src).not.toMatch(/lcBand\(laborPct\)\.color/)
    expect(src).toMatch(/settledFigure\(laborPct, lcBand/)
  })
})

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
  test('S756 owner decision: overtime is included, absence is not subtracted', () => {
    expect(payrollLabourTotal([{ gross: '92000', ot_amount: '7323', ssf_employer: '0', absence_deduction: '500' }])).toBe(99323)
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

describe('finalizedPayrollCost — the Monthly Owner Report\'s finalized-run figure', () => {
  test('gross + overtime + employer SSF; payslip gross excludes OT', () => {
    expect(finalizedPayrollCost([{ gross: '30000', ot_amount: '1500', ssf_employer: '2000' }, { gross: 10000, ot_amount: null, ssf_employer: null }])).toBe(43500)
  })
  test('null means no run; [] is a real zero', () => {
    expect(finalizedPayrollCost(null)).toBeNull()
    expect(finalizedPayrollCost([])).toBe(0)
  })
})

describe('resolveOwnerLabour — payroll XOR estimate, never a fallback over a failed read', () => {
  test('a finalized run supersedes the estimate', () => {
    expect(resolveOwnerLabour({ payroll: 400000, estimate: 380000 }))
      .toEqual({ source: 'payroll', amount: 400000, verdictWithheld: false })
  })
  test('no run: the estimate', () => {
    expect(resolveOwnerLabour({ payroll: null, estimate: 380000 }))
      .toEqual({ source: 'estimate', amount: 380000, verdictWithheld: false })
  })
  test('a failed payroll read does NOT fall back to the estimate', () => {
    expect(resolveOwnerLabour({ payroll: null, payrollReadFailed: true, estimate: 380000 }))
      .toEqual({ source: 'failed', amount: null, verdictWithheld: true })
  })
  test('a run that was read stands even when the estimate inputs failed', () => {
    expect(resolveOwnerLabour({ payroll: 400000, estimate: null, estimateReadFailed: true }).source).toBe('payroll')
  })
  test('no run and a failed estimate read is failed, not a zero-labour month', () => {
    const r = resolveOwnerLabour({ payroll: null, estimate: 0, estimateReadFailed: true })
    expect(r.source).toBe('failed')
    expect(r.amount).toBeNull()
  })
  test('each source has a note, matching the Owner Report\'s wording', () => {
    expect(ownerLabourNote('payroll')).toBe('from finalized payroll')
    expect(ownerLabourNote('estimate')).toBe('estimate — payroll not finalized')
    expect(ownerLabourNote('failed')).toBeTruthy()
    expect(ownerLabourNote(undefined)).toBe('')
  })
})

test('every source has a label', () => {
  for (const source of ['payroll', 'overheads', 'none', 'unreadable', 'failed']) {
    expect(labourSourceLabel({ source }, true)).toMatch(/^Labour: /)
  }
})
