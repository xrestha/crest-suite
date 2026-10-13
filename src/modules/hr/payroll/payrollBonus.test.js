// S824 — a festival allowance or incentive paid WITH the month's salary (migration 20261013120000).
// The owner's decisions (2026-10-13): each run chooses with salary or separately; incentives too; a
// leaver is paid separately; the payslip's salary figures and tax stay salary-only.
import fs from 'fs'
import path from 'path'
import {
  buildPayrollRows, bonusNet, bonusWithoutPayslip, payrollBonusMap, payslipDrift, payslipNetGap, NO_BONUS,
} from './payrollData'
import { leavingIds, payrollStateLine, rowsToSwitch, runPaidWithSalary } from './bonusPayroll'
import { bsToAd, daysInBsMonth, formatAd } from '../../../utils/bsCalendar'

const ad = (y, m, d) => formatAd(bsToAd(y, m, d))
const P = { bs_year: 2083, bs_month: 6 }                     // Ashwin 2083
const lastDay = daysInBsMonth(2083, 6)
const emp = (over = {}) => ({
  id: 'e1', full_name: 'Ram', pay_basis: 'monthly', basic_salary: 30000, join_date: '2020-01-01', end_date: null,
  ssf_enrolled: false, ssf_no: null, marital_status: 'single', ...over,
})
const base = { period: P, components: [], otEntries: [], repayments: [], ytdMap: {}, tadaMap: {}, advances: [], attendance: [] }

describe('payrollBonusMap — the month\'s rows paid with salary, per employee', () => {
  test('sums several runs of a kind to the paisa and keeps every id and name', () => {
    const map = payrollBonusMap(
      [{ id: 'f1', employee_id: 'e1', festival_name: 'Dashain', amount: '30000', tds: '300.10' },
       { id: 'f2', employee_id: 'e1', festival_name: 'Tihar', amount: '1000.05', tds: '0' }],
      [{ id: 'i1', employee_id: 'e2', run_label: 'Q1 bonus', amount: '5000', tds: '50' }],
    )
    expect(map.e1.festival).toEqual({ amount: 31000.05, tds: 300.1, ids: ['f1', 'f2'], names: ['Dashain', 'Tihar'] })
    expect(map.e1.incentive).toEqual({ amount: 0, tds: 0, ids: [], names: [] })
    expect(map.e2.incentive).toMatchObject({ amount: 5000, tds: 50, ids: ['i1'] })
  })
  test('nothing read is an empty map, never a crash', () => {
    expect(payrollBonusMap(null, undefined)).toEqual({})
  })
})

describe('buildPayrollRows — the bonus rides on top, after the tax and the advance cut', () => {
  const bonusMap = { e1: { festival: { amount: 30000, tds: 300, ids: ['f1'], names: ['Dashain'] }, incentive: { amount: 5000, tds: 50, ids: ['i1'], names: ['Q1'] } } }

  test('salary gross and TDS are untouched; net adds amount less its own tax', () => {
    const [plain] = buildPayrollRows({ ...base, employees: [emp()] })
    const [withBonus] = buildPayrollRows({ ...base, employees: [emp()], bonusMap })
    expect(withBonus.payslip.gross).toBe(plain.payslip.gross)
    expect(withBonus.payslip.tds).toBe(plain.payslip.tds)
    expect(withBonus.payslip.net_pay).toBe(plain.payslip.net_pay + 30000 - 300 + 5000 - 50)
    expect(withBonus.payslip).toMatchObject({
      festival_amount: 30000, festival_tds: 300, festival_ids: ['f1'],
      incentive_amount: 5000, incentive_tds: 50, incentive_ids: ['i1'],
    })
    expect(payslipNetGap(withBonus.payslip)).toBeCloseTo(0, 6)
  })

  test('an advance is never recovered out of the bonus', () => {
    const absentMostOfMonth = Array.from({ length: lastDay - 3 }, (_, i) => ({ employee_id: 'e1', bs_day: i + 1, status: 'absent' }))
    const advance = { id: 'a1', employee_id: 'e1', status: 'active', amount: '200000', installment_amount: '50000', issued_date: ad(2083, 3, 10) }
    const [plain] = buildPayrollRows({ ...base, employees: [emp()], attendance: absentMostOfMonth, advances: [advance] })
    const [{ payslip }] = buildPayrollRows({ ...base, employees: [emp()], attendance: absentMostOfMonth, advances: [advance], bonusMap })
    expect(payslip.advance_deduction).toBe(plain.payslip.advance_deduction)
    expect(payslip.net_pay).toBe(30000 - 300 + 5000 - 50)            // the salary went to zero; the bonus did not
  })

  test('no bonus writes zeros and empty id lists, not missing columns', () => {
    const [{ payslip }] = buildPayrollRows({ ...base, employees: [emp()] })
    expect(payslip).toMatchObject({ festival_amount: 0, festival_tds: 0, festival_ids: [], incentive_amount: 0, incentive_tds: 0, incentive_ids: [] })
    expect(NO_BONUS.festival.ids).toEqual([])
  })
})

describe('payslipDrift — a bonus finalized, reopened or switched since Generate is movement', () => {
  const [{ payslip: live }] = buildPayrollRows({ ...base, employees: [emp()], bonusMap: { e1: { festival: { amount: 30000, tds: 300, ids: ['f1'], names: [] }, incentive: { amount: 0, tds: 0, ids: [], names: [] } } } })
  test('a draft made before the festival was finalized is moved', () => {
    const [{ payslip: before }] = buildPayrollRows({ ...base, employees: [emp()] })
    expect(payslipDrift(before, live)).toBe('moved')
  })
  test('the same amount from a different run is moved too', () => {
    expect(payslipDrift({ ...live, festival_ids: ['f9'] }, live)).toBe('moved')
  })
  test('a bonus a paisa off is moved (finalize_payroll_run compares to the paisa)', () => {
    const off = { ...live, festival_amount: 29999.99, net_pay: live.net_pay - 0.01 }
    expect(payslipDrift(off, live)).toBe('moved')
  })
  test('the matching draft is fresh', () => {
    expect(payslipDrift({ ...live }, live)).toBeNull()
  })
})

describe('bonusNet and bonusWithoutPayslip', () => {
  test('bonusNet is amounts less their own taxes, blanks as zero', () => {
    expect(bonusNet({ festival_amount: '1000', festival_tds: '10', incentive_amount: null, incentive_tds: undefined })).toBe(990)
    expect(bonusNet(null)).toBe(0)
  })
  test('names who has bonus money but is not on the payroll', () => {
    expect(bonusWithoutPayslip({ e1: {}, e2: {} }, new Set(['e1']))).toEqual(['e2'])
  })
})

describe('bonusPayroll — who is paid separately, and how a run is paid', () => {
  const empById = new Map([['e1', emp()], ['e2', emp({ id: 'e2', join_date: ad(2083, 7, 1) })]])
  const monthEnd = ad(2083, 6, lastDay)
  test('a draft or finalized settlement ending in or before the month is leaving; a later one is not', () => {
    const ids = leavingIds([
      { employee_id: 'e1', last_working_date: ad(2083, 6, 10), status: 'draft' },
      { employee_id: 'e3', last_working_date: ad(2083, 7, 2), status: 'finalized' },
    ], empById, monthEnd)
    expect([...ids]).toEqual(['e1'])
  })
  test('an earlier employment\'s settlement does not make a rehire leave', () => {
    const ids = leavingIds([{ employee_id: 'e2', last_working_date: ad(2083, 5, 1), status: 'finalized' }], empById, monthEnd)
    expect(ids.size).toBe(0)
  })
  test('a run is paid with salary when any row is; an empty run follows the New dialog', () => {
    expect(runPaidWithSalary([{ paid_through_payroll: false }, { paid_through_payroll: true }], false)).toBe(true)
    expect(runPaidWithSalary([{ paid_through_payroll: false }], true)).toBe(false)
    expect(runPaidWithSalary([], true)).toBe(true)
  })
  test('switching rewrites draft rows only, and a leaver stays separately', () => {
    const rows = [
      { id: 'r1', employee_id: 'e1', status: 'draft', paid_through_payroll: false },
      { id: 'r2', employee_id: 'e2', status: 'draft', paid_through_payroll: false },
      { id: 'r3', employee_id: 'e3', status: 'finalized', paid_through_payroll: false },
    ]
    expect(rowsToSwitch(rows, true, new Set(['e1'])).map(r => r.id)).toEqual(['r2'])
    expect(rowsToSwitch(rows.map(r => ({ ...r, paid_through_payroll: true })), false, new Set()).map(r => r.id)).toEqual(['r1', 'r2'])
  })
  test('the payroll line names what to do for each state', () => {
    expect(payrollStateLine('finalized', 'Ashwin 2083')).toMatch(/already finalized/)
    expect(payrollStateLine('draft', 'Ashwin 2083')).toMatch(/Regenerate/)
    expect(payrollStateLine(undefined, 'Ashwin 2083')).toMatch(/not been generated/)
  })
})

// The net identity lives in three places (payslipNetGap, hr_payslips_guard_net, finalize_payroll_run);
// they change together. This reads the migration that wrote the two SQL copies.
describe('the net identity is the same terms in JS and in SQL', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../../../supabase/migrations/20261013120000_hr_bonus_through_payroll_s824.sql'), 'utf8')
  const BONUS_TERMS = ['festival_amount', 'festival_tds', 'incentive_amount', 'incentive_tds']
  const body = name => {
    const m = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$`))
    return m ? m[1].replace(/--[^\n]*/g, '') : ''
  }
  test.each(['hr_payslips_guard_net', 'finalize_payroll_run'])('%s adds amount and subtracts tax for both kinds', fn => {
    const b = body(fn)
    expect(b).not.toBe('')
    for (const t of ['festival_amount', 'incentive_amount']) expect(b).toMatch(new RegExp(`\\+ COALESCE\\((NEW|p)\\.${t}, 0\\)`))
    for (const t of ['festival_tds', 'incentive_tds']) expect(b).toMatch(new RegExp(`- COALESCE\\((NEW|p)\\.${t}, 0\\)`))
  })
  test('payslipNetGap counts the same four fields', () => {
    const slip = { net_pay: 0 }
    for (const t of BONUS_TERMS) {
      const sign = t.endsWith('_tds') ? -1 : 1
      expect(payslipNetGap({ ...slip, [t]: 100 })).toBe(-sign * 100)
    }
  })
})
