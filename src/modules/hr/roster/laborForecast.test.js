// The Labor Forecast tab's arithmetic. Three claims from S692, each of which the old code broke:
// a scheduled hour is priced at what it costs the employer, a Day Off row is not a person on the
// floor, and the period Cost % is measured over the days that have a forecast.
import {
  loadedHourlyRateOf, computePlannedLaborCost, isOnDutyShift, hasUnknownHours,
  computeScheduledCount, computeUnpricedCount, summarizeLaborForecastRows, rKey,
  computeDayRevenue, computeActualLabor, computeActualStaff,
} from './laborForecast'
import { hourlyRateOf } from '../payroll/payrollCompute'
import { SSF_CAP, SSF_EMPLOYER_PCT, STANDARD_HOURS_PER_DAY } from '../payrollConstants'

const MONTH_DAYS = 30

describe('loadedHourlyRateOf', () => {
  test('with no allowances and no SSF it equals hourlyRateOf for every basis', () => {
    for (const basis of ['monthly', 'daily', 'hourly']) {
      const emp = { pay_basis: basis, basic_salary: 24000 }
      expect(loadedHourlyRateOf(emp, MONTH_DAYS).rate).toBeCloseTo(hourlyRateOf(basis, 24000, MONTH_DAYS), 10)
    }
  })

  test('monthly: earning components are spread over the month like basic; deductions are ignored', () => {
    const emp = { pay_basis: 'monthly', basic_salary: 20000 }
    const comps = [
      { type: 'earning', calc_type: 'fixed', value: 3000 },
      { type: 'earning', calc_type: 'percent_of_basic', value: 10 }, // 2000
      { type: 'deduction', calc_type: 'fixed', value: 500 },        // not a cost of the hour
    ]
    const r = loadedHourlyRateOf(emp, MONTH_DAYS, comps)
    expect(r.grossPerHour).toBeCloseTo(25000 / (MONTH_DAYS * STANDARD_HOURS_PER_DAY), 10)
    expect(r.ssfPerHour).toBe(0)
    expect(r.rate).toBe(r.grossPerHour)
  })

  test('daily and hourly staff have no allowances even when components exist', () => {
    const comps = [{ type: 'earning', calc_type: 'fixed', value: 3000 }]
    expect(loadedHourlyRateOf({ pay_basis: 'daily', basic_salary: 800 }, MONTH_DAYS, comps).rate).toBeCloseTo(100, 10)
    expect(loadedHourlyRateOf({ pay_basis: 'hourly', basic_salary: 150 }, MONTH_DAYS, comps).rate).toBeCloseTo(150, 10)
  })

  test('SSF employer share needs BOTH the flag and a registration number', () => {
    const base = { pay_basis: 'monthly', basic_salary: 20000 }
    expect(loadedHourlyRateOf({ ...base, ssf_enrolled: true }, MONTH_DAYS).ssfPerHour).toBe(0)
    expect(loadedHourlyRateOf({ ...base, ssf_enrolled: true, ssf_no: '   ' }, MONTH_DAYS).ssfPerHour).toBe(0)
    expect(loadedHourlyRateOf({ ...base, ssf_enrolled: false, ssf_no: 'SSF-1' }, MONTH_DAYS).ssfPerHour).toBe(0)
    const enrolled = loadedHourlyRateOf({ ...base, ssf_enrolled: true, ssf_no: 'SSF-1' }, MONTH_DAYS)
    expect(enrolled.ssfPerHour).toBeCloseTo(20000 * SSF_EMPLOYER_PCT / (MONTH_DAYS * STANDARD_HOURS_PER_DAY), 10)
    // The headline claim: an enrolled employee costs 1.2x basic per hour before any allowance.
    expect(enrolled.rate / enrolled.basicRate).toBeCloseTo(1 + SSF_EMPLOYER_PCT, 10)
  })

  test('SSF base is capped at SSF_CAP on the monthly-equivalent gross', () => {
    const emp = { pay_basis: 'monthly', basic_salary: SSF_CAP * 3, ssf_enrolled: true, ssf_no: 'X' }
    expect(loadedHourlyRateOf(emp, MONTH_DAYS).ssfPerHour)
      .toBeCloseTo(SSF_CAP * SSF_EMPLOYER_PCT / (MONTH_DAYS * STANDARD_HOURS_PER_DAY), 10)
  })

  test('a zero-day month prices at 0 rather than Infinity', () => {
    const r = loadedHourlyRateOf({ pay_basis: 'monthly', basic_salary: 20000, ssf_enrolled: true, ssf_no: 'X' }, 0)
    expect(r.rate).toBe(0)
  })
})

// ── Fixture: one day, four people ──────────────────────────────────────────────────────────────
const col = { bsYear: 2083, bsMonth: 5, bsDay: 10 }
const shifts = {
  morning: { id: 'morning', name: 'Morning', start_time: '07:00', end_time: '15:00', hours: 8 },
  split:   { id: 'split',   name: 'Split',   start_time: null,    end_time: null,    hours: null },
  dayOff:  { id: 'dayOff',  name: 'Day Off', start_time: null,    end_time: null,    hours: 0 },
  leave:   { id: 'leave',   name: 'Annual Leave', start_time: '09:00', end_time: '17:00', hours: 8 },
  rest:    { id: 'rest',    name: 'Rest',    start_time: null,    end_time: null,    hours: 0 },
}
const emps = [
  { id: 'a', pay_basis: 'monthly', basic_salary: 24000 },
  { id: 'b', pay_basis: 'daily',   basic_salary: 800 },
  { id: 'c', pay_basis: 'monthly', basic_salary: 30000 },
  { id: 'd', pay_basis: 'hourly',  basic_salary: 150 },
]
const rosterWith = assignments => Object.fromEntries(
  Object.entries(assignments).map(([empId, shiftId]) => [rKey(col.bsYear, col.bsMonth, col.bsDay, empId), { shift_type_id: shiftId }]))

describe('isOnDutyShift / hasUnknownHours', () => {
  test('working shifts are on duty, off-type names and zero-hour shifts are not', () => {
    expect(isOnDutyShift(shifts.morning)).toBe(true)
    expect(isOnDutyShift(shifts.split)).toBe(true)   // unknown hours is still a working shift
    expect(isOnDutyShift(shifts.dayOff)).toBe(false)
    expect(isOnDutyShift(shifts.leave)).toBe(false)  // name says leave even though hours are set
    expect(isOnDutyShift(shifts.rest)).toBe(false)   // zero hours under a non-keyword name
    expect(isOnDutyShift(null)).toBe(false)
  })

  test('only a working shift with no length is "unknown hours"', () => {
    expect(hasUnknownHours(shifts.split)).toBe(true)
    expect(hasUnknownHours(shifts.morning)).toBe(false)
    expect(hasUnknownHours(shifts.dayOff)).toBe(false)
    expect(hasUnknownHours(null)).toBe(false)
  })
})

describe('computeScheduledCount', () => {
  test('a roster full of Day Off rows is nobody on the floor', () => {
    const roster = rosterWith({ a: 'dayOff', b: 'dayOff', c: 'dayOff', d: 'dayOff' })
    expect(computeScheduledCount(col, emps, roster, shifts)).toBe(0)
  })

  test('counts working shifts including one with unknown hours, not off or leave', () => {
    const roster = rosterWith({ a: 'morning', b: 'split', c: 'leave', d: 'dayOff' })
    expect(computeScheduledCount(col, emps, roster, shifts)).toBe(2)
    expect(computeUnpricedCount(col, emps, roster, shifts)).toBe(1)
  })

  test('ignores roster rows for employees not in the list', () => {
    const roster = rosterWith({ a: 'morning', zzz: 'morning' })
    expect(computeScheduledCount(col, emps, roster, shifts)).toBe(1)
  })
})

describe('computePlannedLaborCost', () => {
  test('prices each scheduled hour at the loaded rate and skips zero-hour rows', () => {
    const roster = rosterWith({ a: 'morning', b: 'morning', c: 'dayOff', d: 'split' })
    const comps = { a: [{ type: 'earning', calc_type: 'fixed', value: 6000 }] }
    const expected =
      8 * (30000 / (MONTH_DAYS * STANDARD_HOURS_PER_DAY)) + // a: basic 24000 + 6000 allowance
      8 * (800 / STANDARD_HOURS_PER_DAY)                    // b: daily wage
      // c: Day Off, 0h. d: Split has no hours, so nothing — surfaced via computeUnpricedCount.
    expect(computePlannedLaborCost(col, emps, roster, shifts, MONTH_DAYS, comps)).toBeCloseTo(expected, 8)
  })

  test('without components it matches the old basic-only figure', () => {
    const roster = rosterWith({ a: 'morning', b: 'morning', d: 'morning' })
    const old = emps.filter(e => roster[rKey(col.bsYear, col.bsMonth, col.bsDay, e.id)])
      .reduce((s, e) => s + 8 * hourlyRateOf(e.pay_basis, e.basic_salary, MONTH_DAYS), 0)
    expect(computePlannedLaborCost(col, emps, roster, shifts, MONTH_DAYS)).toBeCloseTo(old, 8)
  })
})

describe('computeDayRevenue', () => {
  test('qty × unit_price minus discount, recipe price as fallback, comps excluded', () => {
    const rows = [
      { recipe_id: 'r1', qty_sold: 3, unit_price: 250, discount: 50, source: 'pos' },
      { recipe_id: 'r2', qty_sold: 2, unit_price: null, discount: 0, source: 'manual' }, // falls back to 400
      { recipe_id: 'r1', qty_sold: 1, unit_price: 250, discount: 0, source: 'pos_comp' }, // not revenue
    ]
    expect(computeDayRevenue(rows, { r2: 400 })).toBe(750 - 50 + 800)
    expect(computeDayRevenue([], {})).toBe(0)
    expect(computeDayRevenue(null)).toBe(0)
  })
})

describe('computeActualLabor / computeActualStaff', () => {
  const twoEmps = [
    { id: 'a', pay_basis: 'monthly', basic_salary: 24000 },
    { id: 'b', pay_basis: 'daily',   basic_salary: 800 },
  ]
  const hourlyA = hourlyRateOf('monthly', 24000, MONTH_DAYS)

  test('regular hours at the loaded rate, OT hours (inside hours_worked) at basic × 1.5', () => {
    const rows = [
      { employee_id: 'a', status: 'present', hours_worked: 10, ot_hours: 2 },
      { employee_id: 'b', status: 'half_day', hours_worked: 4, ot_hours: 0 },
    ]
    const r = computeActualLabor(rows, twoEmps, MONTH_DAYS)
    expect(r.recorded).toBe(true)
    expect(r.hours).toBe(14)
    expect(r.otHours).toBe(2)
    expect(r.cost).toBeCloseTo(8 * hourlyA + 2 * hourlyA * 1.5 + 4 * 100, 8)
  })

  test('OT is clamped to hours worked so a typo cannot go negative', () => {
    const r = computeActualLabor([{ employee_id: 'a', status: 'present', hours_worked: 2, ot_hours: 5 }], twoEmps, MONTH_DAYS)
    expect(r.cost).toBeCloseTo(2 * hourlyA * 1.5, 8)
  })

  test('rows for employees outside the list are ignored, and no rows means "not recorded" rather than 0h', () => {
    const r = computeActualLabor([{ employee_id: 'zzz', status: 'present', hours_worked: 8, ot_hours: 0 }], twoEmps, MONTH_DAYS)
    expect(r.recorded).toBe(false)
    expect(r.hours).toBe(0)
    expect(computeActualLabor([], twoEmps, MONTH_DAYS).recorded).toBe(false)
  })

  test('absent, leave, off and holiday rows are not heads on the floor', () => {
    const rows = [
      { employee_id: 'a', status: 'present' }, { employee_id: 'b', status: 'half_paid_leave' },
      { employee_id: 'a', status: 'absent' },  { employee_id: 'b', status: 'weekly_off' },
      { employee_id: 'a', status: 'holiday' }, { employee_id: 'b', status: 'paid_leave' },
      { employee_id: 'zzz', status: 'present' },
    ]
    expect(computeActualStaff(rows, twoEmps)).toBe(2)
  })
})

describe('summarizeLaborForecastRows', () => {
  const future = [
    { isPast: false, scheduledHrs: 40, plannedCost: 10000, forecastRevenue: 50000, recommended: 5, scheduledCount: 5, unpricedCount: 0 },
    { isPast: false, scheduledHrs: 32, plannedCost: 8000,  forecastRevenue: 20000, recommended: 4, scheduledCount: 3, unpricedCount: 1 },
    { isPast: false, scheduledHrs: 16, plannedCost: 4000,  forecastRevenue: null,  recommended: null, scheduledCount: 2, unpricedCount: 0 },
  ]

  test('totals every day but measures Cost % only over days with a forecast', () => {
    const t = summarizeLaborForecastRows(future)
    expect(t.hours).toBe(88)
    expect(t.cost).toBe(22000)
    expect(t.revenue).toBe(70000)
    expect(t.forecastDays).toBe(2)
    expect(t.noDataDays).toBe(1)
    expect(t.totalDays).toBe(3)
    expect(t.costPct).toBeCloseTo((18000 / 70000) * 100, 10) // not 22000 / 70000
    expect(t.shortDays).toBe(1)
    expect(t.unpricedShifts).toBe(1)
  })

  test('a past day contributes its actuals, not its plan', () => {
    const past = {
      isPast: true, scheduledHrs: 27, plannedCost: 2613, forecastRevenue: null, recommended: null, scheduledCount: 3, unpricedCount: 0,
      actual: { recorded: true, basis: 'attendance', hours: 25.5, cost: 2500, revenue: 12000, covers: 45, staff: 2, recommended: 3 },
    }
    const t = summarizeLaborForecastRows([past, future[0]])
    expect(t.hours).toBe(65.5)
    expect(t.cost).toBe(12500)
    expect(t.revenue).toBe(62000)
    expect(t.actualDays).toBe(1)
    expect(t.forecastDays).toBe(1)
    expect(t.costPct).toBeCloseTo((12500 / 62000) * 100, 10)
    expect(t.shortDays).toBe(1) // 2 on the floor against 3 needed for 45 covers
  })

  test('a past day with no attendance is counted as rostered — the roster stands in, and is named', () => {
    // The caller (Roster.jsx) has already substituted the rostered hours/cost/heads into `actual`
    // and marked the basis; the summary counts them like any other day and reports the count.
    const past = { isPast: true, scheduledHrs: 27, plannedCost: 2613, actual: { recorded: false, basis: 'roster', hours: 27, cost: 2613, revenue: 9319, covers: 45, staff: 3, recommended: 3 } }
    const t = summarizeLaborForecastRows([past])
    expect(t.hours).toBe(27)
    expect(t.cost).toBe(2613)
    expect(t.revenue).toBe(9319)
    expect(t.actualDays).toBe(1)
    expect(t.asRosteredDays).toBe(1)
    expect(t.costPct).toBeCloseTo((2613 / 9319) * 100, 10)
    expect(t.staffedDays).toBe(1)
    expect(t.shortDays).toBe(0)
  })

  test('a past day the loader could not resolve at all is a no-data day', () => {
    const t = summarizeLaborForecastRows([{ isPast: true, scheduledHrs: 27, plannedCost: 2613, actual: null }])
    expect(t.hours).toBe(0)
    expect(t.cost).toBe(0)
    expect(t.noDataDays).toBe(1)
    expect(t.asRosteredDays).toBe(0)
    expect(t.costPct).toBeNull()
  })

  test('staffedDays counts only days where a staffing verdict was possible', () => {
    const t = summarizeLaborForecastRows([
      future[0],                                              // rec 5, heads 5 → measured
      future[2],                                              // rec null → not measured
      { isPast: true, actual: { recorded: true, basis: 'attendance', hours: 8, cost: 800, revenue: 5000, covers: null, staff: 2, recommended: null } }, // no POS → no rec
    ])
    expect(t.staffedDays).toBe(1)
    expect(t.shortDays).toBe(0)
  })

  test('a past day with nothing known is a no-data day', () => {
    const t = summarizeLaborForecastRows([{ isPast: true, scheduledHrs: 27, plannedCost: 2613, actual: null }])
    expect(t.noDataDays).toBe(1)
    expect(t.actualDays).toBe(0)
    expect(t.cost).toBe(0)
  })

  test('no forecast at all gives a null Cost %, never a division by zero', () => {
    const t = summarizeLaborForecastRows([future[2]])
    expect(t.costPct).toBeNull()
    expect(t.forecastDays).toBe(0)
  })

  test('required hours total only the days that have one, and say how many those were', () => {
    const t = summarizeLaborForecastRows([
      { isPast: false, scheduledHrs: 27, plannedCost: 2613, forecastRevenue: 31000, required: { hours: 31 } },
      { isPast: false, scheduledHrs: 27, plannedCost: 2613, forecastRevenue: null, required: null },
      { isPast: true, actual: { recorded: true, basis: 'attendance', hours: 25, cost: 2400, revenue: 20000, staff: 3, recommended: 3, required: { hours: 20 } } },
    ])
    expect(t.requiredHours).toBeCloseTo(51, 1)
    expect(t.requiredDays).toBe(2)   // the no-forecast day contributes nothing
    expect(t.totalDays).toBe(3)
  })

  test('empty input', () => {
    const t = summarizeLaborForecastRows([])
    expect(t.totalDays).toBe(0)
    expect(t.costPct).toBeNull()
    expect(t.requiredHours).toBe(0)
    expect(t.requiredDays).toBe(0)
  })
})
