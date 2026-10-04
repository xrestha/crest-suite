import fs from 'fs'
import path from 'path'
import {
  isPayrollFenced, payrollLabourTotal, resolveLabour, labourSourceLabel, labourNotJudgedText,
  finalizedPayrollCost, resolveOwnerLabour, ownerLabourNote,
  NON_LABOUR_OVERHEADS, splitNonLabourOverheads, groupOutletLabour, groupLabourRatio,
  PAYSLIP_LABOUR_COLUMNS, settlementLabourCost, otherLabourTotals, otherLabourFromGroupRow, otherLabourParts,
  otherLabourLine, NO_OTHER_LABOUR, estimatedEmployerSsf,
} from './labourSource'
import { payrollCashCost } from '../hr/payroll/payrollData'
import { computePayslip } from '../hr/payroll/payrollCompute'
import { SSF_CAP, SSF_EMPLOYER_PCT } from '../hr/payrollConstants'

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
    expect(src).toMatch(/fetchAllRowsChunked\(runIds,[\s\S]{0,120}PAYSLIP_LABOUR_COLUMNS\)\.in\('run_id', chunk\)\.order\('id'\)/)
    expect(src).toMatch(/resolveOwnerLabour\(\{/)
  })
  // S798 2e (LABOUR-FIGURES-4): every bucket but labor — Tax & Fees and NULL-bucket rows came in.
  test('keeps the XOR: the overheads read leaves only the labor bucket out', () => {
    expect(src).toMatch(/from\('overheads'\)\.select\('amount, bucket'\)\.eq\('period_id', period\.id\)\.or\(NON_LABOUR_OVERHEADS\)/)
    expect(src).not.toMatch(/'bucket', 'labor'/)
    expect(src).toMatch(/splitNonLabourOverheads\(overheadsData\)/)
    expect(src).toMatch(/- laborCostTotal - overheadTotal - taxFeesTotal\)/)
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
  test('S756 owner decision: overtime is included', () => {
    expect(payrollLabourTotal([{ gross: '92000', ot_amount: '7323', ssf_employer: '0' }])).toBe(99323)
  })
  // S798 3c (H19 (A)): only what was earned. The finding's own month: two waiters on 18,000 + 2,000
  // join on 16 Bhadra (31 days); each slip stores gross 20,000 and absence 9,677 for the 15 days.
  test('H19: the absence deduction comes off — a mid-month joiner counts what they earned', () => {
    const joiner = { gross: '20000', absence_deduction: '9677', ot_amount: '0', ssf_employer: '0' }
    expect(payrollLabourTotal([joiner, joiner])).toBe(20646)
  })
  test('it is the payroll sheet\'s Cost to business, payslip for payslip', () => {
    const slips = [
      { gross: '30000', absence_deduction: '1935.48', ot_amount: '1500', ssf_employer: '6000', tada_amount: '800' },
      { gross: 12000, absence_deduction: null, ot_amount: null, ssf_employer: null },
      { gross: '20000', absence_deduction: '9677', ot_amount: '250.5', ssf_employer: '0' },
    ]
    expect(payrollLabourTotal(slips)).toBeCloseTo(payrollCashCost(slips).total, 2)
  })
  test('every payslip read selects the absence deduction', () => {
    expect(PAYSLIP_LABOUR_COLUMNS.split(', ').sort()).toEqual(['absence_deduction', 'gross', 'ot_amount', 'ssf_employer'])
  })
  test('null means no run; [] is a real zero', () => {
    expect(payrollLabourTotal(null)).toBeNull()
    expect(payrollLabourTotal([])).toBe(0)
  })
})

describe('resolveLabour — payroll XOR the Labor bucket, never the sum', () => {
  test('D22: finalized payroll with an empty Labor tab counts the payroll', () => {
    const r = resolveLabour({ labourBucket: 0, payroll: 400000, hrOn: true, fenced: false })
    expect(r).toEqual({ source: 'payroll', amount: 400000, ignoredBucket: 0, verdictWithheld: false, other: null, otherNotCounted: null })
  })
  test('payroll supersedes a typed bucket, which is named, not added', () => {
    const r = resolveLabour({ labourBucket: 150000, payroll: 400000, hrOn: true, fenced: false })
    expect(r.amount).toBe(400000)
    expect(r.ignoredBucket).toBe(150000)
  })
  test('no finalized run falls back to the typed bucket', () => {
    expect(resolveLabour({ labourBucket: 150000, payroll: null, hrOn: true, fenced: false }))
      .toEqual({ source: 'overheads', amount: 150000, ignoredBucket: 0, verdictWithheld: false, other: null, otherNotCounted: null })
  })
  test('nothing anywhere is "none", not a judged zero-labour month', () => {
    const r = resolveLabour({ labourBucket: 0, payroll: null, hrOn: true, fenced: false })
    expect(r.source).toBe('none')
    // S796: an HR client with no finalized run has no labour in the margin yet, so no ✓ on it.
    expect(r.verdictWithheld).toBe(true)
  })
  test('an IMS-only client with an empty Labor tab is still judged', () => {
    const r = resolveLabour({ labourBucket: 0, payroll: null, hrOn: false, fenced: false })
    expect(r.source).toBe('none')
    expect(r.verdictWithheld).toBe(false)
  })
  test('labourNotJudgedText names the reason, and is empty when judged', () => {
    expect(labourNotJudgedText({ source: 'none', verdictWithheld: true })).toBe('Not judged until payroll is finalized')
    expect(labourNotJudgedText({ source: 'unreadable', verdictWithheld: true })).toBe('Not judged on this login')
    expect(labourNotJudgedText({ source: 'failed', verdictWithheld: true })).toMatch(/could not be loaded/)
    expect(labourNotJudgedText({ source: 'payroll', verdictWithheld: false })).toBe('')
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
    // hrOn is true here, so 'none' withholds as well as 'unreadable' (S796).
    expect([r.source, r.amount, r.ignoredBucket, r.verdictWithheld]).toEqual([source, labourEffective, ignored, source === 'unreadable' || source === 'none'])
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
      .toEqual({ source: 'payroll', amount: 400000, verdictWithheld: false, other: null })
  })
  test('no run: the estimate', () => {
    expect(resolveOwnerLabour({ payroll: null, estimate: 380000 }))
      .toEqual({ source: 'estimate', amount: 380000, verdictWithheld: false, other: null })
  })
  test('a failed payroll read does NOT fall back to the estimate', () => {
    expect(resolveOwnerLabour({ payroll: null, payrollReadFailed: true, estimate: 380000 }))
      .toEqual({ source: 'failed', amount: null, verdictWithheld: true, other: null })
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

// S798 stage 2e (LABOUR-FIGURES-4): the pages that subtract labour separately read every bucket but
// `labor`. The S384 filter `.eq('bucket','overhead')` also dropped Tax & Fees and NULL-bucket rows.
describe('overheads apart from labour', () => {
  test('the filter keeps NULL, overhead and tax_fees, and nothing else', () => {
    expect(NON_LABOUR_OVERHEADS).toBe('bucket.is.null,bucket.in.(overhead,tax_fees)')
  })

  test('splits like Consolidated P&L: a bucketless row is overhead, a labor row is neither', () => {
    expect(splitNonLabourOverheads([
      { bucket: 'overhead', amount: '60000' }, { bucket: null, amount: 5000 },
      { bucket: 'tax_fees', amount: '45000' }, { bucket: 'labor', amount: 999999 }, { bucket: 'overhead', amount: null },
    ])).toEqual({ overhead: 65000, taxFees: 45000 })
    expect(splitNonLabourOverheads(null)).toEqual({ overhead: 0, taxFees: 0 })
  })
})

// S798 stage 2e (LABOUR-FIGURES-2): the group screens took labour from get_group_summary, which
// returns NPR 0 for "no finalized run", so the running month read "0.0% ✓ Healthy" everywhere.
describe('groupOutletLabour and groupLabourRatio', () => {
  test('payroll wins and names the ignored Labor tab; the Labor tab stands in without payroll', () => {
    expect(groupOutletLabour({ labour_payroll: '300000', labour_bucket: '20000' }, true))
      .toMatchObject({ source: 'payroll', amount: 300000, hasFigure: true, ignoredBucket: 20000, note: '' })
    expect(groupOutletLabour({ labour_payroll: null, labour_bucket: '120000' }, false))
      .toMatchObject({ source: 'overheads', amount: 120000, hasFigure: true, note: 'Labor tab' })
  })

  test('no labour at all is no figure: "not finalized" on an HR outlet, "none entered" without HR', () => {
    expect(groupOutletLabour({ labour_payroll: null, labour_bucket: '0' }, true))
      .toMatchObject({ source: 'none', amount: null, hasFigure: false, verdictWithheld: true, note: 'not finalized' })
    expect(groupOutletLabour({ labour_payroll: null, labour_bucket: 0 }, false))
      .toMatchObject({ source: 'none', amount: null, hasFigure: false, note: 'none entered' })
  })

  test('a finalized run of zero is a real zero', () => {
    expect(groupOutletLabour({ labour_payroll: 0, labour_bucket: 0 }, true)).toMatchObject({ source: 'payroll', amount: 0, hasFigure: true })
  })

  test('the group ratio waits for every outlet, and names the ones missing', () => {
    const thamel = { name: 'Thamel', revenue: 1000000, labour: groupOutletLabour({ labour_payroll: 300000, labour_bucket: 0 }, true) }
    const patan = { name: 'Patan', revenue: 1000000, labour: groupOutletLabour({ labour_payroll: null, labour_bucket: 0 }, true) }
    // The finding's own month: Thamel finalized 3 L on 10 L, Patan did not. It read 15.0% ✓.
    expect(groupLabourRatio([thamel, patan])).toEqual({ pct: null, labour: null, missing: ['Patan'] })
    const patanDone = { ...patan, labour: groupOutletLabour({ labour_payroll: 280000, labour_bucket: 0 }, true) }
    const r = groupLabourRatio([thamel, patanDone])
    expect(r.missing).toEqual([])
    expect(r.labour).toBe(580000)
    expect(r.pct).toBeCloseTo(29, 9)
    expect(groupLabourRatio([])).toMatchObject({ pct: null, missing: [] })
  })
})

describe('the group screens read labour through the shared rule (S798 2e)', () => {
  const group = readSource('pages', 'dashboard', 'GroupDashboard.jsx')
  const pnl = readSource('pages', 'dashboard', 'ConsolidatedPnl.jsx')
  test('Group Dashboard: no labour from get_group_summary.payroll, no bare payroll ratio', () => {
    expect(group).toMatch(/groupOutletLabour\(/)
    expect(group).toMatch(/groupLabourRatio\(/)
    expect(group).not.toMatch(/sum\('payroll'\)/)
    expect(group).not.toMatch(/Number\(r\.payroll\)/)
  })
  test('Consolidated P&L: the group columns carry the rule and Net Profit can lose its colour', () => {
    expect(pnl).toMatch(/groupOutletLabour\(r, hrById\.get\(r\.client_id\)\)/)
    expect(pnl).toMatch(/lineColor\(l, consolidated\[l\.key\], labourWithheld\)/)
  })
})

// S798 stage 3c (LABOUR-FIGURES-1, owner decision H18 (A)): festival allowance, incentives and a
// leaver's final settlement are labour in the month paid, named, and ride with payroll.
describe('other labour paid (H18)', () => {
  const settlement = {
    partial_salary: '12903.23', month_ssf_employer: '2580.65', leave_encashment: '4000',
    festival_pro: '5000', notice_pay: '0', gratuity: '8330', notice_deduction: '1500',
  }

  test('a settlement is its final month, SSF and lump sum, less the notice deduction', () => {
    expect(settlementLabourCost(settlement)).toBeCloseTo(31313.88, 2)
    expect(settlementLabourCost(null)).toBe(0)
  })

  test('the finding\'s Dashain: 12 staff on NPR 17,300 is NPR 2,07,600 of allowance', () => {
    const festival = Array.from({ length: 12 }, () => ({ festival_name: 'Dashain', amount: '17300' }))
    const o = otherLabourTotals({ festival })
    expect(o).toMatchObject({ festival: 207600, festivalName: 'Dashain', incentive: 0, settlement: 0, total: 207600 })
    expect(otherLabourParts(o)).toBe('Dashain allowance NPR 2,07,600')
    expect(otherLabourLine({ other: o })).toBe('includes Dashain allowance NPR 2,07,600')
  })

  test('two festival names in one month are a "festival allowance"; every part is named', () => {
    const o = otherLabourTotals({
      festival: [{ festival_name: 'Dashain', amount: 10000 }, { festival_name: 'Tihar Bonus', amount: 5000 }],
      incentives: [{ amount: '12000' }],
      settlements: [settlement],
    })
    expect(o.festivalName).toBeNull()
    expect(o.total).toBeCloseTo(15000 + 12000 + 31313.88, 2)
    expect(otherLabourParts(o)).toBe('festival allowance NPR 15,000 · incentives NPR 12,000 · final pay of leavers NPR 31,314')
    // A name that already says what it is stays as typed.
    expect(otherLabourParts(otherLabourTotals({ festival: [{ festival_name: 'Tihar Bonus', amount: 5000 }] }))).toBe('Tihar Bonus NPR 5,000')
  })

  test('nothing paid is nothing said', () => {
    expect(NO_OTHER_LABOUR.total).toBe(0)
    expect(otherLabourParts(NO_OTHER_LABOUR)).toBe('')
    expect(otherLabourLine({})).toBe('')
    expect(otherLabourLine({ other: null, otherNotCounted: null })).toBe('')
  })

  test('it joins finalized payroll, and is counted', () => {
    const otherPay = otherLabourTotals({ festival: [{ festival_name: 'Dashain', amount: 207600 }] })
    const r = resolveLabour({ labourBucket: 0, payroll: 290000, hrOn: true, fenced: false, otherPay })
    // The finding: NPR 2,90,000 (24%) read when the month cost NPR 4,97,600 (41%).
    expect(r).toMatchObject({ source: 'payroll', amount: 497600, verdictWithheld: false, otherNotCounted: null })
    expect(r.other.total).toBe(207600)
    expect(otherLabourLine(r)).toBe('includes Dashain allowance NPR 2,07,600')
  })

  test('beside the Labor tab it is named, never added (the owner may have typed it there)', () => {
    const otherPay = otherLabourTotals({ festival: [{ festival_name: 'Dashain', amount: 207600 }] })
    const r = resolveLabour({ labourBucket: 300000, payroll: null, hrOn: true, fenced: false, otherPay })
    expect(r).toMatchObject({ source: 'overheads', amount: 300000, other: null })
    expect(otherLabourLine(r)).toBe('Not included: Dashain allowance NPR 2,07,600 paid through HR')
    // No labour at all yet: still named, still not counted, still not judged.
    const none = resolveLabour({ labourBucket: 0, payroll: null, hrOn: true, fenced: false, otherPay })
    expect(none).toMatchObject({ source: 'none', amount: 0, verdictWithheld: true, other: null })
    expect(none.otherNotCounted.total).toBe(207600)
  })

  test('a fenced or failed read says nothing about it', () => {
    const otherPay = otherLabourTotals({ incentives: [{ amount: 5000 }] })
    expect(resolveLabour({ labourBucket: 0, payroll: null, hrOn: true, fenced: true, otherPay }))
      .toMatchObject({ source: 'unreadable', other: null, otherNotCounted: null })
    expect(resolveLabour({ labourBucket: 0, payroll: 1, hrOn: true, fenced: false, readFailed: true, otherPay }))
      .toMatchObject({ source: 'failed', other: null, otherNotCounted: null })
  })

  test('the Owner Dashboard adds it to the run or to the estimate alike', () => {
    const otherPay = otherLabourTotals({ settlements: [settlement] })
    expect(resolveOwnerLabour({ payroll: 100000, estimate: 1, otherPay }).amount).toBeCloseTo(131313.88, 2)
    expect(resolveOwnerLabour({ payroll: null, estimate: 90000, otherPay }).amount).toBeCloseTo(121313.88, 2)
    expect(resolveOwnerLabour({ payroll: null, payrollReadFailed: true, estimate: 90000, otherPay }).amount).toBeNull()
  })

  test('a group outlet adds get_group_pnl\'s three columns to its payroll, and says so', () => {
    const row = { labour_payroll: '300000', labour_bucket: '0', labour_festival: '50000', labour_incentive: null, labour_settlement: '10000' }
    expect(otherLabourFromGroupRow(row)).toMatchObject({ festival: 50000, incentive: 0, settlement: 10000, total: 60000 })
    const l = groupOutletLabour(row, true)
    expect(l).toMatchObject({ source: 'payroll', amount: 360000, hasFigure: true, note: 'incl. bonus / final pay' })
    expect(l.otherText).toBe('includes festival allowance NPR 50,000 · final pay of leavers NPR 10,000')
    // A Labor-tab outlet keeps its own note, and the bonus is not added.
    const tab = groupOutletLabour({ ...row, labour_payroll: null, labour_bucket: '200000' }, true)
    expect(tab).toMatchObject({ source: 'overheads', amount: 200000, note: 'Labor tab' })
    expect(tab.otherText).toMatch(/^Not included: /)
    // A row from before the migration has no such columns and reads as nothing paid.
    expect(groupOutletLabour({ labour_payroll: '300000', labour_bucket: 0 }, true)).toMatchObject({ amount: 300000, other: null, note: '' })
  })
})

// The readers all ask the same three questions the same way (S798 3c).
describe('every labour reader reads payslips with the absence deduction and the other labour', () => {
  const files = {
    Overheads: ['modules', 'ims', 'reports', 'Overheads.js'],
    ClientDashboard: ['pages', 'dashboard', 'ClientDashboard.jsx'],
    OwnerDashboard: ['pages', 'dashboard', 'OwnerDashboard.jsx'],
    ConsolidatedPnl: ['pages', 'dashboard', 'ConsolidatedPnl.jsx'],
    HrLabourPanel: ['modules', 'hr', 'dashboard', 'HrLabourPanel.jsx'],
    computeMonthlyReport: ['modules', 'ownerReport', 'computeMonthlyReport.js'],
  }
  test.each(Object.keys(files))('%s', name => {
    const src = readSource(...files[name])
    expect(src).not.toMatch(/'gross, ot_amount, ssf_employer'/)
    expect(src).toMatch(/PAYSLIP_LABOUR_COLUMNS|absence_deduction/)
    expect(src).toMatch(/loadMonthOtherLabour\(|loadOtherLabourPay\(/)
  })
})

// S798 4b, LABOUR-FIGURES-8: the estimate's employer SSF is on basic, as payroll charges it.
describe('estimatedEmployerSsf', () => {
  const period = { bs_year: 2083, bs_month: 5 }
  const monthDays = 31 // Bhadra 2083; the engine reads the real length, so the cross-check below holds either way

  test('allowances never raise it: ten staff with NPR 3,000 each charge 20% of basic only', () => {
    const one = estimatedEmployerSsf({ basis: 'monthly', basic: 20000, monthlyEquivGross: 23000, daysWorked: monthDays, monthDays })
    expect(one).toBeCloseTo(20000 * SSF_EMPLOYER_PCT, 9)
    expect(10 * estimatedEmployerSsf({ basis: 'monthly', basic: 20000, monthlyEquivGross: 23000, daysWorked: monthDays, monthDays })
      - 10 * 23000 * SSF_EMPLOYER_PCT).toBeCloseTo(-6000, 9)
  })

  test('monthly: prorates basic first, then caps — the engine’s order', () => {
    const half = estimatedEmployerSsf({ basis: 'monthly', basic: 150000, monthlyEquivGross: 150000, daysWorked: 15, monthDays: 30 })
    expect(half).toBeCloseTo(Math.min(150000 * 0.5, SSF_CAP) * SSF_EMPLOYER_PCT, 9)
    const full = estimatedEmployerSsf({ basis: 'monthly', basic: 150000, monthlyEquivGross: 150000, daysWorked: 30, monthDays: 30 })
    expect(full).toBeCloseTo(SSF_CAP * SSF_EMPLOYER_PCT, 9)
  })

  test('matches computePayslip’s employer SSF for a full month with allowances', () => {
    const emp = { id: 'e1', pay_basis: 'monthly', basic_salary: 40000, ssf_enrolled: true, ssf_no: '1234567890', join_date: null, end_date: null }
    const slip = computePayslip(emp, [{ type: 'earning', calc_type: 'fixed', value: 3000 }], [], period)
    const days = slip.breakdown.monthDays
    expect(estimatedEmployerSsf({ basis: 'monthly', basic: 40000, monthlyEquivGross: 43000, daysWorked: days, monthDays: days }))
      .toBeCloseTo(slip.ssf_employer, 2)
  })

  test('daily and hourly keep month-equivalent pay, capped, then prorated', () => {
    expect(estimatedEmployerSsf({ basis: 'daily', basic: 1000, monthlyEquivGross: 30000, daysWorked: 10, monthDays: 30 }))
      .toBeCloseTo(30000 * (10 / 30) * SSF_EMPLOYER_PCT, 9)
  })

  test('no days, no month: nothing', () => {
    expect(estimatedEmployerSsf({ basis: 'monthly', basic: 40000, monthlyEquivGross: 40000, daysWorked: 0, monthDays: 30 })).toBe(0)
    expect(estimatedEmployerSsf({ basis: 'monthly', basic: 40000, monthlyEquivGross: 40000, daysWorked: 5, monthDays: 0 })).toBe(0)
  })
})
