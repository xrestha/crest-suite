import { calcAmount, tallyAttendance, hourlyRateOf, computePayslip } from './payrollCompute'

describe('calcAmount', () => {
  test('percent_of_basic computes a share of basic salary', () => {
    expect(calcAmount({ calc_type: 'percent_of_basic', value: 10 }, 50000)).toBe(5000)
  })

  test('flat value is rounded independent of basic', () => {
    expect(calcAmount({ calc_type: 'flat', value: 1234.6 }, 999999)).toBe(1235)
  })
})

describe('tallyAttendance', () => {
  test('tallies each status and sums hours/OT independently', () => {
    const rows = [
      { status: 'present', hours_worked: 8, ot_hours: 0 },
      { status: 'present', hours_worked: 8, ot_hours: 1 },
      { status: 'present', hours_worked: 8, ot_hours: 0 },
      { status: 'half_day', hours_worked: 4 },
      { status: 'absent' },
      { status: 'paid_leave' },
      { status: 'paid_leave' },
      { status: 'unpaid_leave' },
      { status: 'weekly_off' },
      { status: 'weekly_off' },
      { status: 'weekly_off' },
      { status: 'weekly_off' },
      { status: 'holiday' },
    ]
    expect(tallyAttendance(rows)).toEqual({
      present: 3, half_day: 1, absent: 1, paid_leave: 2, unpaid_leave: 1,
      half_paid_leave: 0, half_unpaid_leave: 0,
      weekly_off: 4, holiday: 1, sumHours: 28, sumOt: 1,
    })
  })
})

describe('hourlyRateOf', () => {
  test('hourly basis: basic salary IS the hourly rate', () => {
    expect(hourlyRateOf('hourly', 101, 31)).toBe(101)
  })

  test('daily basis: divides the daily rate across an 8-hour day', () => {
    expect(hourlyRateOf('daily', 800, 31)).toBe(100)
  })

  test('monthly basis: divides basic across the month\'s working hours', () => {
    expect(hourlyRateOf('monthly', 31000, 31)).toBe(125) // 31000 / (31*8)
  })

  test('monthly basis with zero month length does not divide by zero', () => {
    expect(hourlyRateOf('monthly', 31000, 0)).toBe(0)
  })
})

describe('computePayslip — monthly basis', () => {
  const period = { bs_year: 2082, bs_month: 1 } // 31-day BS month

  test('full attendance, no components: net pay equals basic', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 50000, ssf_enrolled: false }
    const slip = computePayslip(employee, [], [], period)
    expect(slip.gross).toBe(50000)
    expect(slip.absence_deduction).toBe(0)
    expect(slip.ssf_employee).toBe(0)
    expect(slip.net_pay).toBe(50000)
  })

  test('unpaid absence forfeits the allowance portion of pay too, not just basic', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 30000, ssf_enrolled: false }
    const components = [{ type: 'earning', calc_type: 'flat', value: 3000 }]
    const attendanceRows = [{ status: 'absent' }]
    const slip = computePayslip(employee, components, attendanceRows, period)
    expect(slip.gross).toBe(33000) // basic + allowance
    expect(slip.absence_deduction).toBe(1065) // round(33000 / 31 days * 1 day)
    expect(slip.net_pay).toBe(31935) // 33000 - 1065
  })

  test('SSF is capped at SSF_CAP even when basic salary exceeds it', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 150000, ssf_enrolled: true }
    const slip = computePayslip(employee, [], [], period)
    expect(slip.ssf_employee).toBe(11000)  // 11% of the 100,000 cap, not of 150,000
    expect(slip.ssf_employer).toBe(20000)  // 20% of the 100,000 cap
    expect(slip.net_pay).toBe(139000)      // 150000 - 11000
  })

  test('approved overtime entries add on top of attendance OT, weekday vs. holiday multiplier', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 24800, ssf_enrolled: false } // hr = 100
    const approvedOtEntries = [
      { ot_hours: 3, ot_type: 'normal' },   // 1.5x
      { ot_hours: 2, ot_type: 'holiday' },  // 2x
    ]
    const slip = computePayslip(employee, [], [], period, 0, approvedOtEntries)
    expect(slip.ot_hours).toBe(5)
    expect(slip.ot_amount).toBe(850)  // 3*100*1.5 + 2*100*2.0
    expect(slip.net_pay).toBe(25650)  // 24800 + 850
  })

  test('TDS and advance deduction both come off net pay', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 40000, ssf_enrolled: false }
    const slip = computePayslip(employee, [], [], period, 2500, [], 1000)
    expect(slip.net_pay).toBe(36500) // 40000 - 2500 - 1000
  })

  test('half-day of a PAID leave type costs nothing, unlike the generic half_day status', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 31000, ssf_enrolled: false } // 1000/day
    const slip = computePayslip(employee, [], [{ status: 'half_paid_leave' }], period)
    expect(slip.present_days).toBe(0.5)
    expect(slip.absence_deduction).toBe(0)
    expect(slip.net_pay).toBe(31000)
  })

  test('half-day of an UNPAID leave type deducts exactly half a day', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 31000, ssf_enrolled: false } // 1000/day
    const slip = computePayslip(employee, [], [{ status: 'half_unpaid_leave' }], period)
    expect(slip.absence_deduction).toBe(500) // 0.5 day's share of gross
    expect(slip.net_pay).toBe(30500)
  })
})

describe('computePayslip — daily basis', () => {
  const period = { bs_year: 2082, bs_month: 1 }

  test('paid leave is paid, and OT is priced off the daily rate', () => {
    const employee = { pay_basis: 'daily', basic_salary: 1000, ssf_enrolled: false }
    const attendanceRows = [
      ...Array(20).fill({ status: 'present' }),
      { status: 'present', ot_hours: 4 },
      { status: 'paid_leave' },
      { status: 'paid_leave' },
    ]
    const slip = computePayslip(employee, [], attendanceRows, period)
    expect(slip.worked_days).toBe(23) // 21 present + 2 paid leave
    expect(slip.gross).toBe(23000)    // 1000 * 23
    expect(slip.ot_amount).toBe(750)  // 4 * (1000/8) * 1.5
    expect(slip.net_pay).toBe(23750)
  })
})

describe('computePayslip — hourly basis', () => {
  const period = { bs_year: 2082, bs_month: 1 }

  test('paid leave credits a standard 8-hour day', () => {
    const employee = { pay_basis: 'hourly', basic_salary: 150, ssf_enrolled: false }
    const attendanceRows = [
      { status: 'present', hours_worked: 160, ot_hours: 5 },
      { status: 'paid_leave' },
    ]
    const slip = computePayslip(employee, [], attendanceRows, period)
    expect(slip.gross).toBe(25200)   // 150 * (160 + 8)
    expect(slip.ot_amount).toBe(1125) // 5 * 150 * 1.5
    expect(slip.net_pay).toBe(26325)
  })
})
