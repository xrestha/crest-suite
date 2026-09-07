// The labour standard's arithmetic (S693). Every test here pins a claim that, if it broke, would
// produce a plausible-looking required-hours figure rather than an error — which is the whole
// danger with a learned number.
import {
  median, madOf, isTrainingSample, trimOutlierDays, measureRosterBias, buildLaborStandard,
  standardFor, requiredHoursFor, requiredStaffFor, describeBasis,
  tallyWindowAttendance, tallyWindowRoster,
  MIN_SAMPLE_DAYS, MIN_SAMPLES_PER_WEEKDAY, UNASSIGNED_DEPT,
} from './laborStandard'

// A day that qualifies for training, with sane defaults.
const day = (over = {}) => ({
  key: '2083:5:1', weekday: 0, hours: 24, hoursBasis: 'attendance', headCount: 3,
  revenue: 24000, covers: 60, hoursByDept: { Kitchen: 16, Bar: 8 },
  recorded: true, periodExists: true, bulkMonth: false,
  attendanceHours: 24, rosteredHours: 27,
  ...over,
})

// n qualifying days, cycling weekdays so every bucket clears MIN_SAMPLES_PER_WEEKDAY at n >= 28.
const windowOf = (n, over = () => ({})) =>
  Array.from({ length: n }, (_, i) => day({ key: `2083:5:${i + 1}`, weekday: i % 7, ...over(i) }))

describe('median / madOf', () => {
  test('median handles both parities and ignores non-finite values', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([1, NaN, Infinity, 3])).toBe(2)
    expect(median([])).toBeNull()
  })

  test('MAD is null below the trim floor and when every point is identical', () => {
    expect(madOf([1, 2, 3, 4])).toBeNull()          // 4 points, under MIN_SAMPLES_FOR_TRIM
    expect(madOf([5, 5, 5, 5, 5, 5])).toBeNull()    // zero spread would reject everything but 5
    expect(madOf([1, 2, 3, 4, 5])).toBeCloseTo(1 * 1.4826, 10)
  })
})

describe('isTrainingSample', () => {
  test('accepts an ordinary recorded day', () => {
    expect(isTrainingSample(day())).toBe(true)
  })

  test('rejects a day that is plan rather than evidence, or has nothing to learn from', () => {
    expect(isTrainingSample(day({ recorded: false }))).toBe(false)
    expect(isTrainingSample(day({ periodExists: false }))).toBe(false)  // sales had nowhere to go
    expect(isTrainingSample(day({ bulkMonth: true }))).toBe(false)      // revenue understated
    expect(isTrainingSample(day({ hours: 0 }))).toBe(false)
    expect(isTrainingSample(day({ headCount: 0 }))).toBe(false)
    expect(isTrainingSample(day({ revenue: 0 }))).toBe(false)
    expect(isTrainingSample(null)).toBe(false)
  })
})

describe('trimOutlierDays', () => {
  test('drops a festival day and keeps the ordinary ones', () => {
    const normal = Array.from({ length: 12 }, (_, i) => day({ key: `d${i}`, hours: 24, revenue: 24000 + i * 100 }))
    const festival = day({ key: 'festival', hours: 24, revenue: 240000 }) // 10x the usual per-hour
    const { kept, dropped } = trimOutlierDays([...normal, festival])
    expect(dropped.map(d => d.key)).toEqual(['festival'])
    expect(kept).toHaveLength(12)
  })

  test('a half-entered attendance day is caught by the same rule', () => {
    const normal = Array.from({ length: 12 }, (_, i) => day({ key: `d${i}`, hours: 24, revenue: 24000 + i * 100 }))
    const partial = day({ key: 'partial', hours: 2, revenue: 24000 }) // 3 of 12 staff marked
    expect(trimOutlierDays([...normal, partial]).dropped.map(d => d.key)).toEqual(['partial'])
  })

  test('trims nothing below the sample floor — a trim you cannot justify is a guess', () => {
    const few = [day({ hours: 24, revenue: 24000 }), day({ hours: 24, revenue: 240000 })]
    const { kept, dropped, mad } = trimOutlierDays(few)
    expect(mad).toBeNull()
    expect(dropped).toHaveLength(0)
    expect(kept).toHaveLength(2)
  })
})

describe('measureRosterBias', () => {
  test('measures the ratio of totals over days carrying both, and applies past the floor', () => {
    const days = Array.from({ length: 12 }, () => ({ attendanceHours: 24, rosteredHours: 30 }))
    const b = measureRosterBias(days)
    expect(b.ratio).toBeCloseTo(0.8, 10)
    expect(b.applies).toBe(true)
    expect(b.overlapDays).toBe(12)
  })

  test('does not apply below the overlap floor, and never assumes a direction', () => {
    const few = Array.from({ length: 9 }, () => ({ attendanceHours: 24, rosteredHours: 30 }))
    expect(measureRosterBias(few).applies).toBe(false)
    // Overtime can push attendance PAST the roster — the ratio must be free to exceed 1.
    const over = Array.from({ length: 12 }, () => ({ attendanceHours: 33, rosteredHours: 30 }))
    expect(measureRosterBias(over).ratio).toBeCloseTo(1.1, 10)
  })

  test('days missing either side contribute nothing', () => {
    const b = measureRosterBias([
      { attendanceHours: 24, rosteredHours: 30 },
      { attendanceHours: 0, rosteredHours: 30 },   // attendance not entered
      { attendanceHours: 24, rosteredHours: 0 },   // nobody rostered
    ])
    expect(b.overlapDays).toBe(1)
  })
})

describe('buildLaborStandard', () => {
  test('sales per labour hour is a ratio of totals, not a mean of per-day ratios', () => {
    // One big day at 500/h and 27 small days at 1000/h. Mean-of-ratios ≈ 982; ratio-of-totals is
    // pulled toward the big day, which is the point — that is where a staffing error costs most.
    const days = windowOf(28, i => (i === 0
      ? { hours: 100, revenue: 50000 }
      : { hours: 10, revenue: 10000 }))
    const std = buildLaborStandard(days)
    const totalHours = 100 + 27 * 10
    const totalRevenue = 50000 + 27 * 10000
    expect(std.ok).toBe(true)
    expect(std.overall.salesPerLaborHour).toBeCloseTo(totalRevenue / totalHours, 8)
    const meanOfRatios = (500 + 27 * 1000) / 28
    expect(std.overall.salesPerLaborHour).not.toBeCloseTo(meanOfRatios, 0)
  })

  test('roster-basis days are scaled by the measured bias before they train anything', () => {
    // 14 attendance days at 24h against a 30h roster → bias 0.8. 14 roster-only days at 30h then
    // train as 24h, so every day contributes the same and the standard equals the attendance one.
    const att = Array.from({ length: 14 }, (_, i) => day({
      key: `a${i}`, weekday: i % 7, hours: 24, hoursBasis: 'attendance', revenue: 24000,
      attendanceHours: 24, rosteredHours: 30,
    }))
    const ros = Array.from({ length: 14 }, (_, i) => day({
      key: `r${i}`, weekday: i % 7, hours: 30, hoursBasis: 'roster', revenue: 24000,
      attendanceHours: 0, rosteredHours: 30,
    }))
    const std = buildLaborStandard([...att, ...ros])
    expect(std.rosterBias.applies).toBe(true)
    expect(std.rosterBias.ratio).toBeCloseTo(0.8, 10)
    expect(std.overall.salesPerLaborHour).toBeCloseTo(1000, 8) // 24000 / 24, every day
    expect(std.attendanceDays).toBe(14)
    expect(std.rosterDays).toBe(14)
  })

  test('with too few overlap days the roster hours train unadjusted', () => {
    const att = Array.from({ length: 4 }, (_, i) => day({
      key: `a${i}`, weekday: i % 7, hours: 24, revenue: 24000, attendanceHours: 24, rosteredHours: 30,
    }))
    const ros = Array.from({ length: 24 }, (_, i) => day({
      key: `r${i}`, weekday: i % 7, hours: 30, hoursBasis: 'roster', revenue: 24000,
      attendanceHours: 0, rosteredHours: 30,
    }))
    const std = buildLaborStandard([...att, ...ros])
    expect(std.rosterBias.applies).toBe(false)
    const totalHours = 4 * 24 + 24 * 30
    expect(std.overall.salesPerLaborHour).toBeCloseTo((28 * 24000) / totalHours, 8)
  })

  test('a bulk-sales month is excluded from training and reported', () => {
    const good = windowOf(24)
    const bulk = Array.from({ length: 6 }, (_, i) => day({ key: `b${i}`, weekday: i % 7, bulkMonth: true, revenue: 500 }))
    const std = buildLaborStandard([...good, ...bulk])
    expect(std.bulkMonthDays).toBe(6)
    expect(std.sampleDays).toBe(24)
    expect(std.overall.salesPerLaborHour).toBeCloseTo(1000, 8) // untouched by the understated month
  })

  test('a weekday under the sample floor is null, and falls back to all-days when resolved', () => {
    // 28 days cycling weekdays gives 4 of each; drop three Wednesdays (weekday 3) to 1 sample.
    const days = windowOf(28).filter(d => d.weekday !== 3 || d.key === '2083:5:4')
    const std = buildLaborStandard(days)
    expect(std.byWeekday[3]).toBeNull()
    expect(std.byWeekday[0]).not.toBeNull()
    expect(std.byWeekday[0].days).toBeGreaterThanOrEqual(MIN_SAMPLES_PER_WEEKDAY)
    const basis = standardFor(std, 3)
    expect(basis.scope).toBe('all_days')
    expect(describeBasis(basis)).toBe(`from all ${std.sampleDays} days`)
    expect(describeBasis(standardFor(std, 0)).startsWith('from 4 Sundays')).toBe(true)
  })

  test('below the total-day floor there is no standard at all — never a thin figure', () => {
    const std = buildLaborStandard(windowOf(MIN_SAMPLE_DAYS - 1))
    expect(std.ok).toBe(false)
    expect(std.reason).toBe('too_few_days')
    expect(std.overall).toBeNull()
    expect(standardFor(std, 0)).toBeNull()
    expect(requiredHoursFor(50000, std, 0)).toBeNull()

    const empty = buildLaborStandard([])
    expect(empty.ok).toBe(false)
    expect(empty.reason).toBe('no_samples')
  })

  test('department figures sum back to the outlet total, and the share drives the split', () => {
    const std = buildLaborStandard(windowOf(28)) // 16h Kitchen + 8h Bar of 24h each day
    const total = Object.values(std.byDepartment).reduce((s, d) => s + d.hours, 0)
    expect(total).toBeCloseTo(std.overall.hours, 1)
    expect(std.byDepartment.Kitchen.shareOfHours).toBeCloseTo(2 / 3, 8)
    expect(std.byDepartment.Bar.shareOfHours).toBeCloseTo(1 / 3, 8)
    expect(std.hasUnassignedDeptHours).toBe(false)
  })

  test('unassigned hours are counted in the outlet total but flagged', () => {
    const std = buildLaborStandard(windowOf(28, () => ({ hoursByDept: { Kitchen: 16, [UNASSIGNED_DEPT]: 8 } })))
    expect(std.hasUnassignedDeptHours).toBe(true)
    expect(std.byDepartment[UNASSIGNED_DEPT].hours).toBeGreaterThan(0)
  })

  test('typical shift hours is a ratio of totals, and null with no head-days', () => {
    const std = buildLaborStandard(windowOf(28)) // 24h over 3 heads
    expect(std.typicalShiftHours).toBeCloseTo(8, 8)
    expect(std.learnedCoversPerStaffShift).toBeCloseTo((60 / 24) * 8, 8) // 20 covers per shift
  })

  test('covers-per-hour is null for an outlet that never had covers', () => {
    const std = buildLaborStandard(windowOf(28, () => ({ covers: null })))
    expect(std.overall.coversPerLaborHour).toBeNull()
    expect(std.learnedCoversPerStaffShift).toBeNull()
  })
})

describe('requiredHoursFor / requiredStaffFor', () => {
  const std = buildLaborStandard(windowOf(28)) // 1000 NPR per labour hour, 8h typical shift

  test('required hours is forecast revenue over the resolved standard', () => {
    const r = requiredHoursFor(31000, std, 0)
    expect(r.hours).toBeCloseTo(31, 1)
    expect(r.basis.scope).toBe('weekday')
    expect(requiredStaffFor(r.hours, std.typicalShiftHours)).toBe(4) // ceil(31 / 8)
  })

  test('a department scales by its share of the window hours', () => {
    const r = requiredHoursFor(30000, std, 0, 'Kitchen')
    expect(r.hours).toBeCloseTo(20, 1) // 30h outlet x 2/3
    expect(r.basis.department).toBe('Kitchen')
    expect(describeBasis(r.basis).startsWith('Kitchen, from')).toBe(true)
  })

  test('a department with no hours in the window gets no figure, never the outlet scaled by a guess', () => {
    expect(requiredHoursFor(30000, std, 0, 'Housekeeping')).toBeNull()
  })

  test('no forecast revenue means no answer — an average is never substituted', () => {
    expect(requiredHoursFor(null, std, 0)).toBeNull()
    expect(requiredHoursFor(0, std, 0)).toBeNull()
  })

  test('unknown typical shift hours dashes the staff count but keeps the hours', () => {
    expect(requiredStaffFor(31, null)).toBeNull()
    expect(requiredStaffFor(31, 0)).toBeNull()
    expect(requiredStaffFor(null, 8)).toBeNull()
  })
})

describe('tallyWindowAttendance / tallyWindowRoster', () => {
  test('window attendance counts EVERY employee, including one who has since left', () => {
    const rows = [
      { employee_id: 'active', status: 'present', hours_worked: 9 },
      { employee_id: 'departed', status: 'present', hours_worked: 9 }, // not in departmentByEmp
      { employee_id: 'active', status: 'weekly_off', hours_worked: 0 },
    ]
    const t = tallyWindowAttendance(rows, { active: 'Kitchen' })
    expect(t.hours).toBe(18)          // the departed employee's hours are NOT dropped
    expect(t.headCount).toBe(2)       // the off row is not a head on the floor
    expect(t.hoursByDept).toEqual({ Kitchen: 9, [UNASSIGNED_DEPT]: 9 })
    expect(t.recorded).toBe(true)
  })

  test('no attendance rows is "not recorded", never zero hours', () => {
    expect(tallyWindowAttendance([]).recorded).toBe(false)
    expect(tallyWindowAttendance(null).hours).toBe(0)
  })

  test('roster tally skips zero-hour shifts and buckets by department', () => {
    const hoursOf = r => ({ m: 9, off: 0 }[r.shift_type_id] ?? 0)
    const rows = [
      { employee_id: 'a', shift_type_id: 'm' },
      { employee_id: 'b', shift_type_id: 'm' },
      { employee_id: 'c', shift_type_id: 'off' },
    ]
    const t = tallyWindowRoster(rows, hoursOf, { a: 'Kitchen', b: 'Bar' })
    expect(t.hours).toBe(18)
    expect(t.headCount).toBe(2)
    expect(t.hoursByDept).toEqual({ Kitchen: 9, Bar: 9 })
  })

  test('a roster of nothing but off days is not a recorded day', () => {
    const t = tallyWindowRoster([{ employee_id: 'a', shift_type_id: 'off' }], () => 0)
    expect(t.recorded).toBe(false)
    expect(t.hours).toBe(0)
  })
})
