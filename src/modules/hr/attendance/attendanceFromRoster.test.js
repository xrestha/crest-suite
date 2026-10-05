import { buildAttendanceFromRoster, datedMarkerStatus, planAttendanceFromRoster, rosterDayShape, zeroHourStatus } from './attendanceFromRoster'

describe('buildAttendanceFromRoster', () => {
  const shiftTypesById = {
    morning: { name: 'Morning', hours: 8 },
    split:   { name: 'Split', hours: null, start_time: '10:00', end_time: '14:00' }, // calcHours -> 4
    offDay:  { name: 'OFF DAY', hours: null, start_time: null, end_time: null }, // zero-hour, named like an off day
    custom:  { name: 'Training', hours: 0 }, // zero-hour, but not named like an off day
  }

  test('a rostered day with no existing attendance becomes present with the shift hours', () => {
    const rows = buildAttendanceFromRoster({
      rosterRows: [{ employee_id: 'e1', shift_type_id: 'morning', bs_day: 5 }],
      shiftTypesById,
      employeeIds: ['e1'],
      existingDayKeys: new Set(),
      days: [5],
      periodId: 'p1',
    })
    expect(rows).toEqual([
      { employee_id: 'e1', period_id: 'p1', bs_day: 5, status: 'present', hours_worked: 8, ot_hours: 0, note: null },
    ])
  })

  test('derives hours from start/end time when the shift type has no fixed hours', () => {
    const rows = buildAttendanceFromRoster({
      rosterRows: [{ employee_id: 'e1', shift_type_id: 'split', bs_day: 5 }],
      shiftTypesById,
      employeeIds: ['e1'],
      existingDayKeys: new Set(),
      days: [5],
      periodId: 'p1',
    })
    expect(rows[0].hours_worked).toBe(4)
  })

  test('a roster row pointing to a zero-hour shift named like an off day (e.g. "OFF DAY") is marked Off (weekly_off)', () => {
    const rows = buildAttendanceFromRoster({
      rosterRows: [{ employee_id: 'e1', shift_type_id: 'offDay', bs_day: 5 }],
      shiftTypesById,
      employeeIds: ['e1'],
      existingDayKeys: new Set(),
      days: [5],
      periodId: 'p1',
    })
    expect(rows).toEqual([
      { employee_id: 'e1', period_id: 'p1', bs_day: 5, status: 'weekly_off', hours_worked: 0, ot_hours: 0, note: null },
    ])
  })

  test('a roster row pointing to a zero-hour shift named like nothing is marked Off — only a "holiday" name pays as a holiday (S749)', () => {
    const rows = buildAttendanceFromRoster({
      rosterRows: [{ employee_id: 'e1', shift_type_id: 'custom', bs_day: 5 }],
      shiftTypesById,
      employeeIds: ['e1'],
      existingDayKeys: new Set(),
      days: [5],
      periodId: 'p1',
    })
    expect(rows).toEqual([
      { employee_id: 'e1', period_id: 'p1', bs_day: 5, status: 'weekly_off', hours_worked: 0, ot_hours: 0, note: null },
    ])
  })

  test('a non-rostered day with no existing attendance is left for manual entry — nothing is auto-guessed', () => {
    const rows = buildAttendanceFromRoster({
      rosterRows: [],
      shiftTypesById,
      employeeIds: ['e1'],
      existingDayKeys: new Set(),
      days: [6, 7],
      periodId: 'p1',
    })
    expect(rows).toEqual([])
  })

  test('a day that already has an attendance row is never regenerated, even if rostered', () => {
    const rows = buildAttendanceFromRoster({
      rosterRows: [{ employee_id: 'e1', shift_type_id: 'morning', bs_day: 5 }],
      shiftTypesById,
      employeeIds: ['e1'],
      existingDayKeys: new Set(['e1:5']),
      days: [5],
      periodId: 'p1',
    })
    expect(rows).toEqual([])
  })

  test('handles multiple employees and days together', () => {
    const rows = buildAttendanceFromRoster({
      rosterRows: [
        { employee_id: 'e1', shift_type_id: 'morning', bs_day: 5 },
        { employee_id: 'e1', shift_type_id: 'offDay',  bs_day: 6 },
        { employee_id: 'e2', shift_type_id: 'morning', bs_day: 6 },
      ],
      shiftTypesById,
      employeeIds: ['e1', 'e2'],
      existingDayKeys: new Set(),
      days: [5, 6],
      periodId: 'p1',
    })
    // e1: rostered "Morning" on 5 -> present; rostered "OFF DAY" on 6 -> weekly_off
    // e2: not rostered on 5 -> skipped (nothing to infer); rostered "Morning" on 6 -> present
    expect(rows).toEqual(expect.arrayContaining([
      { employee_id: 'e1', period_id: 'p1', bs_day: 5, status: 'present',    hours_worked: 8, ot_hours: 0, note: null },
      { employee_id: 'e1', period_id: 'p1', bs_day: 6, status: 'weekly_off', hours_worked: 0, ot_hours: 0, note: null },
      { employee_id: 'e2', period_id: 'p1', bs_day: 6, status: 'present',    hours_worked: 8, ot_hours: 0, note: null },
    ]))
    expect(rows).toHaveLength(3)
  })

  // S742 — a 12-hour shift with 9 Normal hours carries 3 hours of overtime as rostered.
  test('a shift with Normal hours set writes its length beyond them as OT', () => {
    const rows = buildAttendanceFromRoster({
      rosterRows: [
        { employee_id: 'e1', shift_type_id: 'fullDay', bs_day: 5 },
        { employee_id: 'e1', shift_type_id: 'morning9', bs_day: 6 },
      ],
      shiftTypesById: {
        fullDay:  { name: 'Full Day', hours: null, start_time: '08:00', end_time: '20:00', regular_hours: 9 },
        morning9: { name: 'Morning',  hours: null, start_time: '08:00', end_time: '17:00', regular_hours: 9 },
      },
      employeeIds: ['e1'],
      existingDayKeys: new Set(),
      days: [5, 6],
      periodId: 'p1',
    })
    expect(rows).toEqual([
      { employee_id: 'e1', period_id: 'p1', bs_day: 5, status: 'present', hours_worked: 12, ot_hours: 3, note: null },
      { employee_id: 'e1', period_id: 'p1', bs_day: 6, status: 'present', hours_worked: 9,  ot_hours: 0, note: null },
    ])
  })

  // S798 (ATTENDANCE-2, H10 (a)): the shipped "Split" has no hours and no times. It is a day worked,
  // measured as an ordinary 8-hour day, not a zero-hour marker turned into Off.
  test('a working shift with no hours set (the shipped Split) is Present for 8 hours, counted apart', () => {
    const plan = planAttendanceFromRoster({
      rosterRows: [
        { employee_id: 'e1', shift_type_id: 'shippedSplit', bs_day: 5 },
        { employee_id: 'e1', shift_type_id: 'morning', bs_day: 6 },
      ],
      shiftTypesById: { ...shiftTypesById, shippedSplit: { name: 'Split', hours: null, start_time: null, end_time: null } },
      employeeIds: ['e1'],
      existingDayKeys: new Set(),
      days: [5, 6],
      periodId: 'p1',
    })
    expect(plan.rows[0]).toEqual({ employee_id: 'e1', period_id: 'p1', bs_day: 5, status: 'present', hours_worked: 8, ot_hours: 0, note: null })
    expect(plan.unknownHours).toBe(1)
  })

  test('an explicit zero-hour shift is still a marker, not an unknown-hours day', () => {
    const plan = planAttendanceFromRoster({
      rosterRows: [{ employee_id: 'e1', shift_type_id: 'custom', bs_day: 5 }],
      shiftTypesById, employeeIds: ['e1'], existingDayKeys: new Set(), days: [5], periodId: 'p1',
    })
    expect(plan.rows[0].status).toBe('weekly_off')
    expect(plan.unknownHours).toBe(0)
  })

  // S798 (ATTENDANCE-5, H7 (a)): days before joining, after leaving and after today stay blank.
  test('leaves a blocked rostered day blank and counts it by reason', () => {
    const blocks = { 1: 'before_joining', 2: 'after_leaving', 3: 'future' }
    const plan = planAttendanceFromRoster({
      rosterRows: [1, 2, 3, 4].map(d => ({ employee_id: 'e1', shift_type_id: 'morning', bs_day: d })),
      shiftTypesById, employeeIds: ['e1'], existingDayKeys: new Set(), days: [1, 2, 3, 4, 5], periodId: 'p1',
      blockOf: (empId, day) => blocks[day] || null,
    })
    expect(plan.rows.map(r => r.bs_day)).toEqual([4])
    // Day 5 has no roster row, so it is not counted as skipped: Generate would not have filled it.
    expect(plan.skipped).toEqual({ before_joining: 1, after_leaving: 1, future: 1 })
  })

  test('a blank Normal hours keeps the whole shift as normal time (no OT), as before', () => {
    const rows = buildAttendanceFromRoster({
      rosterRows: [{ employee_id: 'e1', shift_type_id: 'long', bs_day: 5 }],
      shiftTypesById: { long: { name: 'Long', hours: 12, regular_hours: null } },
      employeeIds: ['e1'],
      existingDayKeys: new Set(),
      days: [5],
      periodId: 'p1',
    })
    expect(rows[0].ot_hours).toBe(0)
  })
})

// S798 (ROSTER-1): the edit to a shift type that changes pay on days not yet generated, and only that.
describe('rosterDayShape', () => {
  const full = { name: 'Full Day', hours: 12, start_time: '10:00', end_time: '22:00', regular_hours: 9 }
  test.each([
    ['shorter hours', { hours: 11 }, true],
    ['Normal hrs filled in for the first time', { regular_hours: 12 - 4 }, true],
    ['new times with the stored Hours kept', { end_time: '21:00' }, false],
    ['a rename of a working shift', { name: 'Long Day' }, false],
    ['a colour', { color: '#000' }, false],
  ])('%s', (_, patch, changes) => {
    expect(rosterDayShape(full) !== rosterDayShape({ ...full, ...patch })).toBe(changes)
  })

  test('renaming a zero-hour marker changes it when the name means another status', () => {
    const leave = { name: 'LEAVE', hours: 0 }
    expect(rosterDayShape(leave)).not.toBe(rosterDayShape({ ...leave, name: 'Paid Leave' }))
    expect(rosterDayShape({ name: 'Day Off', hours: 0 })).toBe(rosterDayShape({ name: 'OFF DAY', hours: 0 }))
  })

  test('giving the shipped Split hours, or making it 0, changes it', () => {
    const split = { name: 'Split', hours: null, start_time: null, end_time: null }
    expect(rosterDayShape(split)).not.toBe(rosterDayShape({ ...split, hours: 9 }))
    expect(rosterDayShape(split)).not.toBe(rosterDayShape({ ...split, hours: 0 }))
  })
})

describe('zeroHourStatus', () => {
  test.each([
    ['PAID LEAVE',        'paid_leave'],
    ['Paid Sick Leave',   'paid_leave'],
    ['LEAVE',             'unpaid_leave'],
    ['UNPAID LEAVE',      'unpaid_leave'],   // contains "paid leave" — unpaid must win
    ['Leave without pay', 'unpaid_leave'],
    ['Public Holiday',    'holiday'],
    ['OFF DAY',           'weekly_off'],
    ['Day Off',           'weekly_off'],
    ['',                  'weekly_off'],
    ['Training',          'weekly_off'],
  ])('%s → %s', (name, status) => {
    expect(zeroHourStatus(name)).toBe(status)
  })
})

describe('datedMarkerStatus', () => {
  it('names a zero-hour leave or holiday marker by the status Generate would write', () => {
    expect(datedMarkerStatus({ name: 'LEAVE', hours: 0 })).toBe('unpaid_leave')
    expect(datedMarkerStatus({ name: 'Paid Sick Leave', hours: 0 })).toBe('paid_leave')
    expect(datedMarkerStatus({ name: 'Public Holiday', hours: 0 })).toBe('holiday')
  })

  it('is null for a Day Off, which is a weekly pattern and copies', () => {
    expect(datedMarkerStatus({ name: 'Day Off', hours: 0 })).toBeNull()
    expect(datedMarkerStatus({ name: 'Training', hours: 0 })).toBeNull()
    expect(datedMarkerStatus(null)).toBeNull()
  })

  it('is null for a worked day, whatever its name', () => {
    expect(datedMarkerStatus({ name: 'Holiday Duty', hours: 8, start_time: '10:00' })).toBeNull()
    expect(datedMarkerStatus({ name: 'Leave cover', hours: 6 })).toBeNull()
    // The default "Split": a working shift with unknown hours is an 8-hour day, never a marker.
    expect(datedMarkerStatus({ name: 'Split', hours: null })).toBeNull()
  })

  it('agrees with rosterDayShape on which cells are leave or holiday markers', () => {
    for (const shift of [{ name: 'LEAVE', hours: 0 }, { name: 'Holiday', hours: 0 }, { name: 'Day Off', hours: 0 }, { name: 'Split', hours: null }, { name: 'Morning', hours: 8 }]) {
      const shape = rosterDayShape(shift)
      const marker = shape.startsWith('marker|') && !shape.startsWith('marker|weekly_off')
      expect(datedMarkerStatus(shift) !== null).toBe(marker)
    }
  })
})
