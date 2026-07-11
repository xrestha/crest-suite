import { buildAttendanceFromRoster } from './attendanceFromRoster'

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

  test('a roster row pointing to a zero-hour shift NOT named like an off day is marked holiday', () => {
    const rows = buildAttendanceFromRoster({
      rosterRows: [{ employee_id: 'e1', shift_type_id: 'custom', bs_day: 5 }],
      shiftTypesById,
      employeeIds: ['e1'],
      existingDayKeys: new Set(),
      days: [5],
      periodId: 'p1',
    })
    expect(rows).toEqual([
      { employee_id: 'e1', period_id: 'p1', bs_day: 5, status: 'holiday', hours_worked: 0, ot_hours: 0, note: null },
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
})
