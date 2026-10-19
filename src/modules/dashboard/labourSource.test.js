import fs from 'fs'
import path from 'path'
import {
  isPayrollFenced, payrollLabourTotal, labourSourceLabel, labourNotJudgedText,
  NON_LABOUR_OVERHEADS, splitNonLabourOverheads, splitOverheadBuckets, groupOutletLabour, groupLabourRatio,
  PAYSLIP_LABOUR_COLUMNS, settlementLabourCost, otherLabourTotals, otherLabourFromGroupRow, otherLabourParts,
  otherLabourLine, NO_OTHER_LABOUR, estimatedEmployerSsf,
  LABOUR_SOURCES, resolveOutletLabour, outletLabourNotes, labourFigure,
} from './labourSource'
import { estimateLabour } from './labourEstimate'
import { bsToAd, formatAd } from '../../utils/bsCalendar'
import { payrollCashCost } from '../hr/payroll/payrollData'
import { computePayslip } from '../hr/payroll/payrollCompute'
import { SSF_CAP, SSF_EMPLOYER_PCT } from '../hr/payrollConstants'

const readSource = (...parts) => fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

// S756: Overheads carried the rule inline; one definition is the whole point of the helper.
// S849 (OVERHEADS-SU11): it reads through loadOutletLabour and resolves the one rule at render.
describe('Overheads adopts the shared labour rule', () => {
  const src = readSource('modules', 'ims', 'reports', 'Overheads.js')
  test('reads through loadOutletLabour and resolves with resolveOutletLabour and isPayrollFenced', () => {
    expect(src).toMatch(/import \{[^}]*resolveOutletLabour[^}]*\} from '\.\.\/\.\.\/dashboard\/labourSource'/)
    expect(src).toMatch(/loadOutletLabour\(/)
    expect(src).toMatch(/resolveOutletLabour\(/)
    expect(src).toMatch(/isPayrollFenced\(\{/)
  })
  test('no longer carries the inline precedence, fence, payslip sum or its own payroll reads', () => {
    expect(src).not.toMatch(/labourPayroll != null \? labourPayroll : totals\.labor/)
    expect(src).not.toMatch(/payrollFenced \? 'unreadable'/)
    expect(src).not.toMatch(/hrOn && !isAdmin && !isOwner && !!profile\?\.ims_role/)
    expect(src).not.toMatch(/parseFloat\(ps\.gross\)/)
    expect(src).not.toMatch(/'hr_payroll_runs'/)
    expect(src).not.toMatch(/resolveLabour\(/)
  })
  test('the shared loader pages the payslip read with a unique tiebreaker', () => {
    const loader = readSource('modules', 'dashboard', 'loadOutletLabour.js')
    expect(loader).toMatch(/fetchAllRowsChunked\(runIds, chunk =>\s*from\('hr_payslips', PAYSLIP_LABOUR_COLUMNS\)\.in\('run_id', chunk\)\.order\('id'\)\)/)
  })
})

describe('OwnerDashboard reads labour through the one rule (S849)', () => {
  const src = readSource('pages', 'dashboard', 'OwnerDashboard.jsx')
  test('loadOutletLabour, never the old inline estimate', () => {
    expect(src).toMatch(/loadOutletLabour\(/)
    expect(src).not.toMatch(/resolveOwnerLabour|estimateLaborCost|finalizedPayrollCost/)
  })
  // S849 (GAPS-4): every bucket is read, so the Labor tab can be named "not counted".
  test('one overheads read of every bucket, split three ways', () => {
    expect(src).toMatch(/splitOverheadBuckets\(/)
    expect(src).not.toMatch(/'bucket', 'labor'/)
  })
  test('the labour tile goes through the shared figure, not a bare band colour', () => {
    expect(src).not.toMatch(/lcBand\(laborPct\)\.color/)
  })
})

// D22 is silent when it regresses — a margin a little too healthy — so pin the Dashboard's wiring.
describe('ClientDashboard counts labour through the one rule', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'pages', 'dashboard', 'ClientDashboard.jsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  test('reads labour with loadOutletLabour and resolves with resolveOutletLabour', () => {
    expect(src).toMatch(/loadOutletLabour\(/)
    expect(src).toMatch(/resolveOutletLabour\(/)
    expect(src).toMatch(/isPayrollFenced\(/)
    expect(src).not.toMatch(/resolveLabour\(/)
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
  // S824: a festival allowance or incentive paid with the salary is counted once, from the bonus
  // tables (loadOtherLabourPay), so the payslip's own bonus columns are not labour here.
  test('S824: the bonus columns on a payslip are not counted again', () => {
    expect(payrollLabourTotal([{ gross: '30000', ssf_employer: '0', festival_amount: '30000', incentive_amount: '5000' }])).toBe(30000)
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

describe('labourNotJudgedText', () => {
  test('names the reason, and is empty when judged', () => {
    expect(labourNotJudgedText({ source: 'none', verdictWithheld: true })).toBe('Not judged until payroll is finalized')
    expect(labourNotJudgedText({ source: 'unreadable', verdictWithheld: true })).toBe('Not judged on this login')
    expect(labourNotJudgedText({ source: 'failed', verdictWithheld: true })).toMatch(/could not be loaded/)
    expect(labourNotJudgedText({ source: 'payroll', verdictWithheld: false })).toBe('')
    // S849 (SU17)
    expect(labourNotJudgedText({ source: 'estimate', verdictWithheld: true, reason: 'nopay' })).toBe('Not judged — pay not set for some staff')
    expect(labourNotJudgedText({ source: 'estimate', verdictWithheld: true, reason: 'nostaff' })).toBe('Not judged — no staff on payroll')
  })
})

test('every source has a label', () => {
  for (const source of LABOUR_SOURCES) {
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

  test('S849: splitOverheadBuckets keeps the Labor tab as its own bucket', () => {
    expect(splitOverheadBuckets([
      { bucket: 'overhead', amount: '60000' }, { bucket: null, amount: 5000 },
      { bucket: 'tax_fees', amount: '45000' }, { bucket: 'labor', amount: 250000 }, { bucket: 'other', amount: 7 },
    ])).toEqual({ overhead: 65000, taxFees: 45000, labor: 250000 })
    expect(splitOverheadBuckets(undefined)).toEqual({ overhead: 0, taxFees: 0, labor: 0 })
  })
})

// S798 stage 2e (LABOUR-FIGURES-2): the group screens took labour from get_group_summary, which
// returns NPR 0 for "no finalized run", so the running month read "0.0% ✓ Healthy" everywhere.
// S849 (GAPS-4): an HR outlet without payroll takes the HR wage estimate from get_group_labour_inputs.
describe('groupOutletLabour and groupLabourRatio', () => {
  const KARTIK = { bs_year: 2083, bs_month: 7 }
  const inputs = {
    employees: [{ id: 'e1', status: 'active', basic_salary: 30000, pay_basis: 'monthly', join_date: '2020-01-01', end_date: null, ssf_enrolled: false, ssf_no: null }],
    components: [], otEntries: [], attendance: [], settlements: [],
  }

  test('payroll wins and names the ignored Labor tab; the Labor tab is labour only without HR', () => {
    expect(groupOutletLabour({ labour_payroll: '300000', labour_bucket: '20000' }, true))
      .toMatchObject({ source: 'payroll', amount: 300000, hasFigure: true, ignoredBucket: 20000, note: 'payroll' })
    expect(groupOutletLabour({ labour_payroll: null, labour_bucket: '120000' }, false))
      .toMatchObject({ source: 'overheads', amount: 120000, hasFigure: true, note: 'Labor tab' })
  })

  test('an HR outlet without payroll takes the estimate, and names the Labor tab', () => {
    const l = groupOutletLabour({ labour_payroll: null, labour_bucket: '250000' }, true, { inputs, period: KARTIK })
    expect(l).toMatchObject({ source: 'estimate', hasFigure: true, ignoredBucket: 250000, note: 'estimate' })
    expect(l.amount).toBeCloseTo(30000, 6)
  })

  test('the running month passes the clock: accrued to the finished days, the run scaled', () => {
    const l = groupOutletLabour({ labour_payroll: null, labour_bucket: 0 }, true, { inputs, period: KARTIK, throughDay: 11, scale: 11 / 30 })
    expect(l.amount).toBeCloseTo(11000, 6)
    const run = groupOutletLabour({ labour_payroll: 300000, labour_bucket: 0 }, true, { scale: 11 / 30 })
    expect(run.amount).toBeCloseTo(110000, 6)
  })

  test('no inputs for an HR outlet without payroll is "not loaded" — never the Labor tab', () => {
    expect(groupOutletLabour({ labour_payroll: null, labour_bucket: '120000' }, true))
      .toMatchObject({ source: 'failed', amount: null, hasFigure: false, verdictWithheld: true, note: 'not loaded' })
  })

  test('no labour entered without HR is no figure: "none entered"', () => {
    expect(groupOutletLabour({ labour_payroll: null, labour_bucket: 0 }, false))
      .toMatchObject({ source: 'none', amount: null, hasFigure: false, note: 'none entered' })
  })

  test('a finalized run of zero is a real zero', () => {
    expect(groupOutletLabour({ labour_payroll: 0, labour_bucket: 0 }, true)).toMatchObject({ source: 'payroll', amount: 0, hasFigure: true })
  })

  test('the group ratio waits for every outlet, and names the ones missing', () => {
    const thamel = { name: 'Thamel', revenue: 1000000, labour: groupOutletLabour({ labour_payroll: 300000, labour_bucket: 0 }, true) }
    const patan = { name: 'Patan', revenue: 1000000, labour: groupOutletLabour({ labour_payroll: null, labour_bucket: 0 }, true) }
    // The finding's own month: Thamel finalized 3 L on 10 L, Patan's labour was not read. It read 15.0% ✓.
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
  test('Consolidated P&L: the group columns carry the rule', () => {
    expect(pnl).toMatch(/groupOutletLabour\(/)
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
    const r = resolveOutletLabour({ hrOn: true, labourBucket: 0, payroll: 290000, otherPay })
    // The finding: NPR 2,90,000 (24%) read when the month cost NPR 4,97,600 (41%).
    expect(r).toMatchObject({ source: 'payroll', amount: 497600, verdictWithheld: false, otherNotCounted: null })
    expect(r.other.total).toBe(207600)
    expect(otherLabourLine(r)).toBe('includes Dashain allowance NPR 2,07,600')
  })

  test('beside the Labor tab of an outlet without HR it is named, never added', () => {
    const otherPay = otherLabourTotals({ festival: [{ festival_name: 'Dashain', amount: 207600 }] })
    const r = resolveOutletLabour({ hrOn: false, labourBucket: 300000, otherPay })
    expect(r).toMatchObject({ source: 'overheads', amount: 300000, other: null })
    expect(otherLabourLine(r)).toBe('Not included: Dashain allowance NPR 2,07,600 paid through HR')
  })

  test('a fenced or failed read says nothing about it', () => {
    const otherPay = otherLabourTotals({ incentives: [{ amount: 5000 }] })
    expect(resolveOutletLabour({ hrOn: true, fenced: true, otherPay }))
      .toMatchObject({ source: 'unreadable', other: null, otherNotCounted: null })
    expect(resolveOutletLabour({ hrOn: true, payroll: 1, payrollReadFailed: true, otherPay }))
      .toMatchObject({ source: 'failed', other: null, otherNotCounted: null })
  })

  test('the one rule adds it to the run or to the estimate alike, never to a failed read', () => {
    const otherPay = otherLabourTotals({ settlements: [settlement] })
    expect(resolveOutletLabour({ hrOn: true, payroll: 100000, estimate: { amount: 1 }, otherPay }).amount).toBeCloseTo(131313.88, 2)
    expect(resolveOutletLabour({ hrOn: true, payroll: null, estimate: { amount: 90000 }, otherPay }).amount).toBeCloseTo(121313.88, 2)
    expect(resolveOutletLabour({ hrOn: true, payroll: null, payrollReadFailed: true, estimate: { amount: 90000 }, otherPay }).amount).toBeNull()
  })

  test('a group outlet adds get_group_pnl\'s three columns to its payroll, and says so', () => {
    const row = { labour_payroll: '300000', labour_bucket: '0', labour_festival: '50000', labour_incentive: null, labour_settlement: '10000' }
    expect(otherLabourFromGroupRow(row)).toMatchObject({ festival: 50000, incentive: 0, settlement: 10000, total: 60000 })
    const l = groupOutletLabour(row, true)
    expect(l).toMatchObject({ source: 'payroll', amount: 360000, hasFigure: true, note: 'payroll' })
    expect(l.otherText).toBe('includes festival allowance NPR 50,000 · final pay of leavers NPR 10,000')
    // An outlet without HR keeps the Labor tab, and the bonus is named, not added.
    const tab = groupOutletLabour({ ...row, labour_payroll: null, labour_bucket: '200000' }, false)
    expect(tab).toMatchObject({ source: 'overheads', amount: 200000, note: 'Labor tab' })
    expect(tab.otherText).toMatch(/^Not included: /)
    // A row from before the migration has no such columns and reads as nothing paid.
    expect(groupOutletLabour({ labour_payroll: '300000', labour_bucket: 0 }, true)).toMatchObject({ amount: 300000, other: null })
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
    // S849: a page reading through loadOutletLabour inherits both (the loader is pinned above).
    expect(src).toMatch(/PAYSLIP_LABOUR_COLUMNS|absence_deduction|loadOutletLabour\(/)
    expect(src).toMatch(/loadMonthOtherLabour\(|loadOtherLabourPay\(|loadOutletLabour\(/)
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

// ── S849 (GAPS-4, owner decision SU11 (a)): the one rule on every page ──────────────────────────────
describe('resolveOutletLabour — the one labour rule', () => {
  const est = (amount, over = {}) => ({ amount, noPay: [], onPayroll: 5, unended: [], calendarStaff: 0, sheetOt: { hours: 0, amount: 0 }, ...over })

  test('no HR: the Labor tab, or none (0, still judged)', () => {
    expect(resolveOutletLabour({ hrOn: false, labourBucket: 160000 })).toMatchObject({ source: 'overheads', amount: 160000, verdictWithheld: false, ignoredBucket: 0 })
    expect(resolveOutletLabour({ hrOn: false, labourBucket: 0 })).toMatchObject({ source: 'none', amount: 0, verdictWithheld: false, reason: '' })
  })

  test('HR + a finalized run: payroll, the Labor tab named', () => {
    expect(resolveOutletLabour({ hrOn: true, payroll: 400000, labourBucket: 150000 }))
      .toMatchObject({ source: 'payroll', amount: 400000, ignoredBucket: 150000, verdictWithheld: false })
  })

  test('HR + no run: the estimate, the Labor tab named — never the Labor tab', () => {
    // The GAPS-4 example: estimate 2,88,000, Labor tab 2,50,000 → 2,88,000 on every page.
    const r = resolveOutletLabour({ hrOn: true, payroll: null, estimate: est(288000), labourBucket: 250000 })
    expect(r).toMatchObject({ source: 'estimate', amount: 288000, ignoredBucket: 250000, verdictWithheld: false, reason: '' })
    expect(outletLabourNotes(r).long[0]).toBe('Labour tab NPR 2,50,000 not counted — Crest HR is the labour figure')
  })

  test('SU17: pay not set → figure kept, verdict withheld; nobody on payroll the same', () => {
    const r = resolveOutletLabour({ hrOn: true, estimate: est(120000, { noPay: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] }), labourBucket: 90000 })
    expect(r).toMatchObject({ source: 'estimate', amount: 120000, verdictWithheld: true, reason: 'nopay', ignoredBucket: 90000 })
    expect(outletLabourNotes(r).long).toEqual([
      'Labour tab NPR 90,000 not counted — Crest HR is the labour figure',
      'Pay not set for 4 staff — not counted, so labour is not judged · Pay Setup →',
    ])
    const n = resolveOutletLabour({ hrOn: true, estimate: est(0, { onPayroll: 0 }) })
    expect(n).toMatchObject({ verdictWithheld: true, reason: 'nostaff', amount: 0 })
    expect(outletLabourNotes(n).long).toContain('No staff on payroll in Crest HR — labour is not judged')
  })

  test('HR + fenced: unreadable, no figure, the Labor tab NOT substituted', () => {
    expect(resolveOutletLabour({ hrOn: true, fenced: true, labourBucket: 150000, payroll: 1 }))
      .toMatchObject({ source: 'unreadable', amount: null, verdictWithheld: true, reason: 'unreadable' })
  })

  test('any failed read: failed, no figure', () => {
    expect(resolveOutletLabour({ hrOn: true, payrollReadFailed: true, estimate: est(1) })).toMatchObject({ source: 'failed', amount: null })
    expect(resolveOutletLabour({ hrOn: true, payroll: null, estimateReadFailed: true })).toMatchObject({ source: 'failed', amount: null })
    expect(resolveOutletLabour({ hrOn: true, payroll: null, estimate: null })).toMatchObject({ source: 'failed', amount: null })
    // A run that was read stands even when the estimate inputs failed.
    expect(resolveOutletLabour({ hrOn: true, payroll: 400000, estimateReadFailed: true }).source).toBe('payroll')
  })

  test('scale applies to the run and the Labor tab, never to the estimate or other labour', () => {
    const otherPay = otherLabourTotals({ festival: [{ festival_name: 'Dashain', amount: 30000 }] })
    expect(resolveOutletLabour({ hrOn: true, payroll: 300000, otherPay, scale: 0.5 })).toMatchObject({ amount: 180000, scaled: true })
    expect(resolveOutletLabour({ hrOn: true, estimate: est(100000), otherPay, scale: 0.5 })).toMatchObject({ amount: 130000, scaled: false })
    expect(resolveOutletLabour({ hrOn: false, labourBucket: 90000, scale: 1 / 3 }).amount).toBeCloseTo(30000, 9)
  })

  test('each page gets the same figure from the same inputs (the estimate object from labourEstimate)', () => {
    const ad = d => formatAd(bsToAd(2083, 7, d))
    const estimate = estimateLabour({
      employees: [{ id: 'a', full_name: 'A', status: 'active', basic_salary: 30000, pay_basis: 'monthly', join_date: ad(1), end_date: null }],
      components: [], otEntries: [], attendance: [], settlements: [], period: { bs_year: 2083, bs_month: 7 }, throughDay: 30,
    })
    expect(resolveOutletLabour({ hrOn: true, estimate }).amount).toBeCloseTo(30000, 6)
  })
})

describe('outletLabourNotes — every sentence a page owes', () => {
  test('short notes per source', () => {
    expect(outletLabourNotes(resolveOutletLabour({ hrOn: true, payroll: 1 })).short).toBe('labour from finalized payroll')
    expect(outletLabourNotes(resolveOutletLabour({ hrOn: true, estimate: { amount: 1, onPayroll: 1, noPay: [] } })).short).toBe('labour estimate — payroll not finalized')
    expect(outletLabourNotes(resolveOutletLabour({ hrOn: false, labourBucket: 5 })).short).toBe('labour from Overheads')
    expect(outletLabourNotes(resolveOutletLabour({ hrOn: true, fenced: true })).short).toBe('labour not readable on this login')
    expect(outletLabourNotes(resolveOutletLabour({ hrOn: true, payrollReadFailed: true })).short).toBe('labour could not be loaded')
    expect(outletLabourNotes(null)).toEqual({ short: '', long: [] })
  })
  test('the estimate\'s own notes, in order', () => {
    const otherPay = otherLabourTotals({ festival: [{ festival_name: 'Dashain', amount: 207600 }] })
    const r = resolveOutletLabour({
      hrOn: true, otherPay,
      estimate: { amount: 100, onPayroll: 3, noPay: [], unended: [{ id: 'x' }, { id: 'y' }], calendarStaff: 2, sheetOt: { hours: 3, amount: 42120 } },
    })
    expect(outletLabourNotes(r).long).toEqual([
      'includes Dashain allowance NPR 2,07,600',
      '2 leavers with no End Date are not counted · Employees →',
      'Daily and hourly staff: attendance where entered, every day otherwise',
      'Overtime from the attendance sheet included (NPR 42,120)',
    ])
  })
})

describe('labourFigure', () => {
  test('a figure exists for payroll, estimate (even withheld) and the Labor tab; never for none or a failure', () => {
    expect(labourFigure(resolveOutletLabour({ hrOn: true, payroll: 0 }))).toEqual({ hasFigure: true, note: 'payroll' })
    expect(labourFigure(resolveOutletLabour({ hrOn: true, estimate: { amount: 5, noPay: [{ id: 1 }] } }))).toEqual({ hasFigure: true, note: 'estimate' })
    expect(labourFigure(resolveOutletLabour({ hrOn: false, labourBucket: 0 }))).toEqual({ hasFigure: false, note: 'none entered' })
    expect(labourFigure(resolveOutletLabour({ hrOn: true, fenced: true }))).toEqual({ hasFigure: false, note: 'not readable' })
    expect(labourFigure(null)).toEqual({ hasFigure: false, note: 'not loaded' })
  })
})
