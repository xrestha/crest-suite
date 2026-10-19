import { estimateLabour, payrollRoster, estimatedEmployerSsf } from './labourEstimate'
import { fetchPayrollEmployees } from '../hr/payroll/payrollData'
import { computePayslip } from '../hr/payroll/payrollCompute'
import { bsToAd, formatAd, daysInBsMonth } from '../../utils/bsCalendar'
import { SSF_CAP, SSF_EMPLOYER_PCT } from '../hr/payrollConstants'

const ad = (y, m, d) => formatAd(bsToAd(y, m, d))
// Kartik 2083 has 30 days, which keeps the arithmetic readable.
const KARTIK = { id: 'p-kartik', bs_year: 2083, bs_month: 7 }
const MANGSIR = { id: 'p-mangsir', bs_year: 2083, bs_month: 8 }
const POUSH = { id: 'p-poush', bs_year: 2083, bs_month: 9 }
const LONG_AGO = '2020-01-01'

const emp = (id, over = {}) => ({
  id, full_name: id, status: 'active', basic_salary: 30000, pay_basis: 'monthly',
  ssf_enrolled: false, ssf_no: null, join_date: LONG_AGO, end_date: null, ...over,
})
const rows = (employeeId, days, over = {}) => days.map(d => ({ employee_id: employeeId, bs_day: d, status: 'present', hours_worked: 8, ot_hours: 0, ...over }))
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

test('Kartik 2083 is the 30-day month these cases assume', () => {
  expect(daysInBsMonth(2083, 7)).toBe(30)
})

describe('sheet overtime (OWNER-DASHBOARD-4)', () => {
  test('12 monthly staff × 26 days × 1 h at NPR 90/h is NPR 42,120', () => {
    // 21,600 ÷ (30 days × 8 h) = NPR 90 an hour.
    const employees = range(1, 12).map(i => emp(`m${i}`, { basic_salary: 21600 }))
    const attendance = employees.flatMap(e => rows(e.id, range(1, 26), { ot_hours: 1 }))
    const r = estimateLabour({ employees, components: [], otEntries: [], attendance, settlements: [], period: KARTIK, throughDay: 30 })
    expect(r.sheetOt.hours).toBe(312)
    expect(r.sheetOt.amount).toBeCloseTo(42120, 6)
    expect(r.gross).toBeCloseTo(12 * 21600, 6)
    expect(r.amount).toBeCloseTo(12 * 21600 + 42120, 6)
    expect(r.staffCounted).toBe(12)
  })

  test('an approved entry replaces the sheet\'s overtime on its own day', () => {
    const e = emp('a', { basic_salary: 21600 })
    const attendance = [...rows('a', [4], { ot_hours: 1 }), ...rows('a', [5], { ot_hours: 2 })]
    const otEntries = [{ employee_id: 'a', bs_day: 5, ot_hours: 3, ot_type: 'weekday' }]
    const r = estimateLabour({ employees: [e], components: [], otEntries, attendance, settlements: [], period: KARTIK, throughDay: 30 })
    expect(r.sheetOt).toEqual({ hours: 1, amount: 135 })
    expect(r.approvedOt.hours).toBe(3)
    expect(r.approvedOt.amount).toBeCloseTo(3 * 90 * 1.5, 9)
  })

  test('a holiday entry is paid at 2×', () => {
    const r = estimateLabour({
      employees: [emp('a', { basic_salary: 21600 })], components: [], attendance: [], settlements: [],
      otEntries: [{ employee_id: 'a', bs_day: 3, ot_hours: 2, ot_type: 'holiday' }], period: KARTIK, throughDay: 30,
    })
    expect(r.approvedOt.amount).toBeCloseTo(2 * 90 * 2, 9)
  })
})

describe('daily and hourly staff (SU16)', () => {
  const daily = range(1, 6).map(i => emp(`d${i}`, { pay_basis: 'daily', basic_salary: 700 }))

  test('6 daily staff with 4 weekly offs marked: NPR 1,09,200, not 1,26,000', () => {
    const attendance = daily.flatMap(e => rows(e.id, [6, 13, 20, 27], { status: 'weekly_off', hours_worked: 0 }))
    const r = estimateLabour({ employees: daily, components: [], otEntries: [], attendance, settlements: [], period: KARTIK, throughDay: 30 })
    expect(r.gross).toBeCloseTo(109200, 6)
    expect(r.calendarStaff).toBe(6)
  })

  test('the same staff with no marks: every day paid, and the note is owed', () => {
    const r = estimateLabour({ employees: daily, components: [], otEntries: [], attendance: [], settlements: [], period: KARTIK, throughDay: 30 })
    expect(r.gross).toBeCloseTo(126000, 6)
    expect(r.calendarStaff).toBe(6)
  })

  test('a fully marked month pays the sheet and owes no calendar note', () => {
    const attendance = daily.flatMap(e => [
      ...rows(e.id, [6, 13, 20, 27], { status: 'weekly_off', hours_worked: 0 }),
      ...rows(e.id, range(1, 30).filter(d => ![6, 13, 20, 27].includes(d))),
    ])
    const r = estimateLabour({ employees: daily, components: [], otEntries: [], attendance, settlements: [], period: KARTIK, throughDay: 30 })
    expect(r.gross).toBeCloseTo(109200, 6)
    expect(r.calendarStaff).toBe(0)
  })

  test('hourly staff are paid hours less their overtime, 8 h on an unmarked day', () => {
    const h = emp('h', { pay_basis: 'hourly', basic_salary: 100 })
    const attendance = rows('h', range(1, 20), { hours_worked: 10, ot_hours: 2 })
    const r = estimateLabour({ employees: [h], components: [], otEntries: [], attendance, settlements: [], period: KARTIK, throughDay: 30 })
    // 20 × (10 − 2) = 160 h worked + 10 unmarked days × 8 h = 240 h × NPR 100.
    expect(r.gross).toBeCloseTo(24000, 6)
    expect(r.sheetOt).toEqual({ hours: 40, amount: 6000 })
    expect(r.calendarStaff).toBe(1)
  })
})

describe('monthly staff dock the sheet\'s unpaid days', () => {
  test('two absences and a half day off a 30-day month', () => {
    const attendance = [...rows('a', [3, 4], { status: 'absent' }), ...rows('a', [9], { status: 'half_day' })]
    const r = estimateLabour({ employees: [emp('a')], components: [], otEntries: [], attendance, settlements: [], period: KARTIK, throughDay: 30 })
    expect(r.gross).toBeCloseTo(30000 / 30 * 27.5, 6)
  })
  test('allowances are pay, docked with the basic', () => {
    const components = [{ employee_id: 'a', type: 'earning', calc_type: 'fixed', value: 3000 }, { employee_id: 'a', type: 'deduction', calc_type: 'fixed', value: 999 }]
    const r = estimateLabour({ employees: [emp('a')], components, otEntries: [], attendance: rows('a', [1], { status: 'absent' }), settlements: [], period: KARTIK, throughDay: 30 })
    expect(r.gross).toBeCloseTo(33000 / 30 * 29, 6)
  })
  test('a joiner on day 16 accrues from day 16', () => {
    const r = estimateLabour({ employees: [emp('j', { join_date: ad(2083, 7, 16) })], components: [], otEntries: [], attendance: [], settlements: [], period: KARTIK, throughDay: 30 })
    expect(r.gross).toBeCloseTo(15000, 6)
  })
  test('employer SSF on basic, through the shared helper', () => {
    const e = emp('s', { ssf_enrolled: true, ssf_no: '123' })
    const r = estimateLabour({ employees: [e], components: [{ employee_id: 's', type: 'earning', calc_type: 'fixed', value: 5000 }], otEntries: [], attendance: [], settlements: [], period: KARTIK, throughDay: 30 })
    expect(r.ssfEmployer).toBeCloseTo(Math.min(30000, SSF_CAP) * SSF_EMPLOYER_PCT, 6)
    expect(r.ssfEmployer).toBeCloseTo(estimatedEmployerSsf({ basis: 'monthly', basic: 30000, daysWorked: 30, monthDays: 30 }), 9)
  })
})

describe('the running month: accrued to the finished days', () => {
  test('day 12: days 1–11 counted; today\'s sheet row and overtime are not', () => {
    const attendance = rows('a', [12], { status: 'present', ot_hours: 3 })
    const otEntries = [{ employee_id: 'a', bs_day: 12, ot_hours: 2, ot_type: 'weekday' }, { employee_id: 'a', bs_day: 3, ot_hours: 1, ot_type: 'weekday' }]
    const r = estimateLabour({ employees: [emp('a', { basic_salary: 24000 })], components: [], otEntries, attendance, settlements: [], period: KARTIK, throughDay: 11 })
    expect(r.gross).toBeCloseTo(24000 * 11 / 30, 6)
    expect(r.sheetOt.hours).toBe(0)
    expect(r.approvedOt.hours).toBe(1)
    expect(r.throughDay).toBe(11)
  })
  test('day 1: nothing accrued, but missing pay is still listed', () => {
    const r = estimateLabour({ employees: [emp('a'), emp('b', { basic_salary: null })], components: [], otEntries: [], attendance: [], settlements: [], period: KARTIK, throughDay: 0 })
    expect(r.amount).toBe(0)
    expect(r.noPay).toEqual([{ id: 'b', name: 'b' }])
    expect(r.onPayroll).toBe(2)
  })
})

describe('no pay set (OWNER-DASHBOARD-5, SU17)', () => {
  test('lists the 4 of 10 with no pay, counts the 6', () => {
    const employees = range(1, 10).map(i => emp(`e${i}`, { basic_salary: i <= 4 ? (i % 2 ? null : 0) : 20000 }))
    const r = estimateLabour({ employees, components: [], otEntries: [], attendance: [], settlements: [], period: KARTIK, throughDay: 30 })
    expect(r.noPay.map(n => n.id)).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(r.staffCounted).toBe(6)
    expect(r.gross).toBeCloseTo(6 * 20000, 6)
  })
  test('nobody on payroll', () => {
    const r = estimateLabour({ employees: [emp('x', { status: 'inactive' })], components: [], otEntries: [], attendance: [], settlements: [], period: KARTIK })
    expect(r.onPayroll).toBe(0)
    expect(r.amount).toBe(0)
  })
})

describe('who is counted is payroll\'s own list (OWNER-DASHBOARD-3)', () => {
  const ram = emp('ram', { status: 'resigned', end_date: ad(2083, 8, 5) })
  const sita = emp('sita', { status: 'resigned', end_date: ad(2083, 9, 15) })
  const hari = emp('hari', { status: 'inactive' })
  const settlements = [{ employee_id: 'sita', last_working_date: ad(2083, 9, 15) }]

  test('Ram resigned 5 Mangsir: the whole of Kartik is counted', () => {
    const r = estimateLabour({ employees: [ram], components: [], otEntries: [], attendance: [], settlements: [], period: KARTIK })
    expect(r.gross).toBeCloseTo(30000, 6)
    const m = estimateLabour({ employees: [ram], components: [], otEntries: [], attendance: [], settlements: [], period: MANGSIR })
    expect(m.gross).toBeCloseTo(30000 / daysInBsMonth(2083, 8) * 5, 6)
  })

  test('Sita settled 15 Poush: her final month is the settlement, counted once', () => {
    const p = estimateLabour({ employees: [sita], components: [], otEntries: [], attendance: [], settlements, period: POUSH })
    expect(p.gross).toBe(0)
    expect(p.settledOut).toBe(1)
    // Mangsir is before the settlement: paid by payroll as usual.
    const m = estimateLabour({ employees: [sita], components: [], otEntries: [], attendance: [], settlements, period: MANGSIR })
    expect(m.gross).toBeCloseTo(30000, 6)
    expect(m.settledOut).toBe(0)
  })

  test('a leaver with no End Date is named, not counted', () => {
    const r = estimateLabour({ employees: [hari, emp('a')], components: [], otEntries: [], attendance: [], settlements: [], period: KARTIK })
    expect(r.unended).toEqual([{ id: 'hari', name: 'hari' }])
    expect(r.staffCounted).toBe(1)
  })

  test('a settlement from an earlier employment does not leave a rehire out', () => {
    const rehired = emp('r', { join_date: ad(2083, 5, 1) })
    const old = [{ employee_id: 'r', last_working_date: ad(2082, 12, 20) }]
    expect(payrollRoster({ employees: [rehired], settlements: old, period: KARTIK }).onPayroll.map(e => e.id)).toEqual(['r'])
  })

  // The roster must be payroll's, case for case: the same id sets from fetchPayrollEmployees on one fixture.
  test('payrollRoster and fetchPayrollEmployees agree', async () => {
    const employees = [
      emp('active'), emp('probation', { status: 'probation' }), ram, sita, hari,
      emp('future', { join_date: ad(2083, 10, 1) }), emp('gone', { status: 'terminated', end_date: ad(2083, 2, 1) }),
      emp('rehired', { join_date: ad(2083, 5, 1) }),
    ]
    const allSettlements = [...settlements, { employee_id: 'rehired', last_working_date: ad(2082, 12, 20) }]
    const makeBuilder = (table) => {
      let data = table === 'hr_employees' ? employees : table === 'hr_final_settlements' ? allSettlements : []
      const b = {
        or: () => b, order: () => b, eq: () => b,
        lte: (col, v) => { data = data.filter(r => String(r[col]) <= v); return b },
        then: (res, rej) => Promise.resolve({ data, error: null }).then(res, rej),
      }
      return b
    }
    for (const period of [KARTIK, MANGSIR, POUSH]) {
      const { data, error } = await fetchPayrollEmployees((t) => makeBuilder(t), period)
      expect(error).toBeNull()
      const mine = payrollRoster({ employees, settlements: allSettlements, period })
      const ids = list => list.map(e => e.id).sort()
      expect(ids(mine.onPayroll)).toEqual(ids(data.employees))
      expect(ids(mine.settled)).toEqual(ids(data.settled))
      expect(ids(mine.unended)).toEqual(ids(data.unended))
    }
  })
})

describe('a closed, fully marked month is payroll\'s Cost to business', () => {
  test.each([
    ['monthly', emp('m', { ssf_enrolled: true, ssf_no: '9', basic_salary: 36000 }),
      [...rows('m', [2], { status: 'absent' }), ...rows('m', [7], { status: 'half_unpaid_leave', ot_hours: 1.5 })]],
    ['daily', emp('d', { pay_basis: 'daily', basic_salary: 900, ssf_enrolled: true, ssf_no: '9' }),
      range(1, 30).map(d => ({ employee_id: 'd', bs_day: d, status: d % 7 === 0 ? 'weekly_off' : d === 10 ? 'paid_leave' : 'present', hours_worked: 8, ot_hours: d === 3 ? 2 : 0 }))],
    ['hourly', emp('h', { pay_basis: 'hourly', basic_salary: 150 }),
      range(1, 30).map(d => ({ employee_id: 'h', bs_day: d, status: d % 7 === 0 ? 'weekly_off' : 'present', hours_worked: d % 7 === 0 ? 0 : 9, ot_hours: d % 7 === 0 ? 0 : 1 }))],
  ])('%s', (_basis, e, attendance) => {
    const components = e.pay_basis === 'monthly' ? [{ employee_id: e.id, type: 'earning', calc_type: 'fixed', value: 4000 }] : []
    const otEntries = [{ employee_id: e.id, bs_day: 7, ot_hours: 2, ot_type: 'weekday' }]
    const slip = computePayslip(e, components, attendance, KARTIK, 0, otEntries, 0)
    const cost = slip.gross - slip.absence_deduction + slip.ot_amount + slip.ssf_employer
    const r = estimateLabour({ employees: [e], components, otEntries, attendance, settlements: [], period: KARTIK })
    // computePayslip rounds each money figure to the rupee; the estimate does not.
    expect(Math.abs(r.amount - cost)).toBeLessThan(2)
  })
})
