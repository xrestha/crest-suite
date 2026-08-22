import { calcAmount, tallyAttendance, hourlyRateOf, computePayslip } from './payrollCompute'
import { bsToAd, formatAd } from '../../../utils/bsCalendar'

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
      weekly_off: 4, holiday: 1, sumHours: 28, sumOt: 1, sumOtSuperseded: 0,
    })
  })

  test('OT on a day an approved entry covers is withheld from sumOt, not silently dropped', () => {
    const rows = [
      { status: 'present', bs_day: 1, hours_worked: 8, ot_hours: 2 },
      { status: 'present', bs_day: 2, hours_worked: 8, ot_hours: 3 },
    ]
    const t = tallyAttendance(rows, new Set([2]))
    expect(t.sumOt).toBe(2)            // day 1 only — day 2 is superseded by an approved entry
    expect(t.sumOtSuperseded).toBe(3)  // reported, so a page can explain the difference
    expect(t.sumHours).toBe(16)        // ordinary hours are unaffected by OT supersession
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
    const employee = { pay_basis: 'monthly', basic_salary: 150000, ssf_enrolled: true, ssf_no: '1234567890' }
    const slip = computePayslip(employee, [], [], period)
    expect(slip.ssf_employee).toBe(11000)  // 11% of the 100,000 cap, not of 150,000
    expect(slip.ssf_employer).toBe(20000)  // 20% of the 100,000 cap
    expect(slip.net_pay).toBe(139000)      // 150000 - 11000
  })

  // The enrolment flag alone used to deduct 11%, while HrReports' SSF challan tab filters on
  // ssf_no — so a flagged employee with a blank number had money withheld that no filing sheet
  // ever claimed. Both sides now require the number (decision 2026-08-18).
  test('SSF is NOT deducted when enrolled but the registration number is missing', () => {
    const noNumber = { pay_basis: 'monthly', basic_salary: 50000, ssf_enrolled: true }
    expect(computePayslip(noNumber, [], [], period).ssf_employee).toBe(0)

    const blankNumber = { pay_basis: 'monthly', basic_salary: 50000, ssf_enrolled: true, ssf_no: '   ' }
    expect(computePayslip(blankNumber, [], [], period).ssf_employee).toBe(0)

    const withNumber = { pay_basis: 'monthly', basic_salary: 50000, ssf_enrolled: true, ssf_no: '1234567890' }
    expect(computePayslip(withNumber, [], [], period).ssf_employee).toBe(5500)
  })

  // `absent_days` stays literal absences (Payroll Run's Excel column depends on it); the payslip
  // prints `unpaid_days`, which must account for every day the deduction actually docks.
  test('unpaid_days counts unpaid leave and half days, not just absences', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 31000, ssf_enrolled: false }
    const attendanceRows = [
      { status: 'absent' }, { status: 'unpaid_leave' }, { status: 'unpaid_leave' },
      { status: 'half_day', hours_worked: 4 },
    ]
    const slip = computePayslip(employee, [], attendanceRows, period)
    expect(slip.absent_days).toBe(1)     // one literal absence
    expect(slip.unpaid_days).toBe(3.5)   // 1 absent + 2 unpaid leave + 0.5 half day
  })

  test('approved overtime entries price weekday vs. holiday at their own multipliers', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 24800, ssf_enrolled: false } // hr = 100
    const approvedOtEntries = [
      { bs_day: 5, ot_hours: 3, ot_type: 'normal' },   // 1.5x
      { bs_day: 6, ot_hours: 2, ot_type: 'holiday' },  // 2x
    ]
    const slip = computePayslip(employee, [], [], period, 0, approvedOtEntries)
    expect(slip.ot_hours).toBe(5)
    expect(slip.ot_amount).toBe(850)  // 3*100*1.5 + 2*100*2.0
    expect(slip.net_pay).toBe(25650)  // 24800 + 850
  })

  // Decision 2026-08-18: the two OT sources are alternatives, not addends. An approved entry is
  // the authorised figure for its day (and the only route to the holiday 2x rate), so attendance
  // OT for that same day is withheld — the pair can no longer pay the same hours twice.
  test('an approved OT entry supersedes attendance-sheet OT on the same day only', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 24800, ssf_enrolled: false } // hr = 100
    const attendanceRows = [
      { status: 'present', bs_day: 5, hours_worked: 8, ot_hours: 3 }, // superseded below
      { status: 'present', bs_day: 9, hours_worked: 8, ot_hours: 2 }, // no approved entry — still paid
    ]
    const approvedOtEntries = [{ bs_day: 5, ot_hours: 4, ot_type: 'holiday' }]
    const slip = computePayslip(employee, [], attendanceRows, period, 0, approvedOtEntries)

    expect(slip.ot_hours).toBe(6)                          // 2 attendance (day 9) + 4 approved (day 5)
    expect(slip.ot_amount).toBe(1100)                      // 2*100*1.5 + 4*100*2.0
    expect(slip.breakdown.otSupersededHrs).toBe(3)         // day 5's attendance OT, displaced
    expect(slip.breakdown.otApprovedHrs).toBe(4)
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

  test('employee with no join_date is unaffected (existing behavior)', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 30000, ssf_enrolled: false }
    const slip = computePayslip(employee, [], [], period)
    expect(slip.breakdown.preJoinDays).toBe(0)
    expect(slip.absence_deduction).toBe(0)
  })

  test('employee who joined before this period is paid in full', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 30000, ssf_enrolled: false, join_date: formatAd(bsToAd(2081, 12, 1)) }
    const slip = computePayslip(employee, [], [], period)
    expect(slip.breakdown.preJoinDays).toBe(0)
    expect(slip.absence_deduction).toBe(0)
    expect(slip.net_pay).toBe(30000)
  })

  test('employee whose join date falls entirely after this period gets zero net pay, not a full month', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 30000, ssf_enrolled: false, join_date: formatAd(bsToAd(2082, 2, 1)) } // next BS month
    const slip = computePayslip(employee, [], [], period)
    expect(slip.gross).toBe(30000)              // contractual gross is still shown
    expect(slip.breakdown.preJoinDays).toBe(31) // every day of this 31-day period predates joining
    expect(slip.absence_deduction).toBe(30000)  // fully forfeited
    expect(slip.net_pay).toBe(0)
  })

  test('mid-period joiner is paid only from their join date onward', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 31000, ssf_enrolled: false, join_date: formatAd(bsToAd(2082, 1, 16)) } // 1000/day
    const slip = computePayslip(employee, [], [], period)
    expect(slip.breakdown.preJoinDays).toBe(15) // days 1-15 predate joining
    expect(slip.absence_deduction).toBe(15000)
    expect(slip.net_pay).toBe(16000)
  })

  test('pre-join days combine additively with attendance-marked absence after joining', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 31000, ssf_enrolled: false, join_date: formatAd(bsToAd(2082, 1, 11)) } // 1000/day, 10 pre-join days
    const slip = computePayslip(employee, [], [{ status: 'absent' }], period)
    expect(slip.breakdown.unpaidDays).toBe(11) // 10 pre-join + 1 attendance-marked absent
    expect(slip.absence_deduction).toBe(11000)
    expect(slip.net_pay).toBe(20000)
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

// ── end_date proration (S600) ────────────────────────────────────────────────
// The mirror of the join-date block above. Without it a leaver drew a full contractual month and
// Final Settlement added its own partial-month figure on top — the same month paid ~1.5 times.
describe('computePayslip — monthly basis, end_date', () => {
  const period = { bs_year: 2082, bs_month: 1 }   // 31 days

  test('employee with no end_date is unaffected', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 30000, ssf_enrolled: false }
    const slip = computePayslip(employee, [], [], period)
    expect(slip.breakdown.postExitDays).toBe(0)
    expect(slip.net_pay).toBe(30000)
  })

  test('employee who left after this period is paid in full', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 30000, ssf_enrolled: false, end_date: formatAd(bsToAd(2082, 3, 1)) }
    const slip = computePayslip(employee, [], [], period)
    expect(slip.breakdown.postExitDays).toBe(0)
    expect(slip.net_pay).toBe(30000)
  })

  test('mid-period leaver is paid only up to their last working day', () => {
    // 31000 over a 31-day month = 1000/day. Last day worked = the 16th, so days 17-31 are unpaid.
    const employee = { pay_basis: 'monthly', basic_salary: 31000, ssf_enrolled: false, end_date: formatAd(bsToAd(2082, 1, 16)) }
    const slip = computePayslip(employee, [], [], period)
    expect(slip.breakdown.postExitDays).toBe(15)
    expect(slip.absence_deduction).toBe(15000)
    expect(slip.net_pay).toBe(16000)
  })

  test('the last working day itself is paid', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 31000, ssf_enrolled: false, end_date: formatAd(bsToAd(2082, 1, 31)) }
    const slip = computePayslip(employee, [], [], period)
    expect(slip.breakdown.postExitDays).toBe(0)
    expect(slip.net_pay).toBe(31000)
  })

  test('employee who left before this period draws nothing, not a full month', () => {
    const employee = { pay_basis: 'monthly', basic_salary: 30000, ssf_enrolled: false, end_date: formatAd(bsToAd(2081, 12, 1)) }
    const slip = computePayslip(employee, [], [], period)
    expect(slip.breakdown.postExitDays).toBe(31)
    expect(slip.absence_deduction).toBe(30000)
    expect(slip.net_pay).toBe(0)
  })

  test('a join and an exit in the same month pay only the days between them', () => {
    // Joined the 11th, left the 20th: 10 days worked out of 31 at 1000/day.
    const employee = {
      pay_basis: 'monthly', basic_salary: 31000, ssf_enrolled: false,
      join_date: formatAd(bsToAd(2082, 1, 11)),
      end_date:  formatAd(bsToAd(2082, 1, 20)),
    }
    const slip = computePayslip(employee, [], [], period)
    expect(slip.breakdown.preJoinDays).toBe(10)
    expect(slip.breakdown.postExitDays).toBe(11)
    expect(slip.breakdown.notEmployedDays).toBe(21)
    expect(slip.net_pay).toBe(10000)
  })

  test('an end_date before the join_date cannot deduct more days than the month has', () => {
    const employee = {
      pay_basis: 'monthly', basic_salary: 31000, ssf_enrolled: false,
      join_date: formatAd(bsToAd(2082, 1, 20)),
      end_date:  formatAd(bsToAd(2082, 1, 5)),
    }
    const slip = computePayslip(employee, [], [], period)
    expect(slip.breakdown.notEmployedDays).toBe(31)
    expect(slip.absence_deduction).toBe(31000)
    expect(slip.net_pay).toBe(0)
  })

  test('SSF shrinks with the shortened month, since it derives from the paid fraction', () => {
    const employee = {
      pay_basis: 'monthly', basic_salary: 31000, ssf_enrolled: true, ssf_no: '123',
      end_date: formatAd(bsToAd(2082, 1, 16)),
    }
    const slip = computePayslip(employee, [], [], period)
    expect(slip.ssf_employee).toBeLessThan(31000 * 0.11)
    expect(slip.ssf_employee).toBeGreaterThan(0)
  })
})
