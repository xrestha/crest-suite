jest.mock('../../../utils/bsCalendar', () => ({
  // Days 6 and 13 are "Saturdays" (JS getDay()===6); every other day is a weekday.
  bsToAd: (year, month, day) => ({ getDay: () => ([6, 13].includes(day) ? 6 : 3) }),
}))

import { isSaturday, buildAttendanceFromRoster } from './attendanceFromRoster'

describe('isSaturday', () => {
  test('flags mocked Saturday days', () => {
    expect(isSaturday(2082, 4, 6)).toBe(true)
    expect(isSaturday(2082, 4, 7)).toBe(false)
  })
})

describe('buildAttendanceFromRoster', () => {
  const shiftTypesById = {
    morning: { hours: 8 },
    split:   { hours: null, start_time: '10:00', end_time: '14:00' }, // calcHours -> 4
    leave:   { hours: null, start_time: null, end_time: null }, // e.g. a custom "LEAVE" placeholder shift
  }

  test('a rostered day with no existing attendance becomes present with the shift hours', () => {
    const rows = buildAttendanceFromRoster({
      rosterRows: [{ employee_id: 'e1', shift_type_id: 'morning', bs_day: 5 }],
      shiftTypesById,
      employeeIds: ['e1'],
      existingDayKeys: new Set(),
      bsYear: 2082, bsMonth: 4, days: [5],
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
      bsYear: 2082, bsMonth: 4, days: [5],
      periodId: 'p1',
    })
    expect(rows[0].hours_worked).toBe(4)
  })

  test('a roster row pointing to a zero-hour placeholder shift (e.g. custom "LEAVE"/"Day Off") is marked holiday, not present', () => {
    const rows = buildAttendanceFromRoster({
      rosterRows: [{ employee_id: 'e1', shift_type_id: 'leave', bs_day: 5 }],
      shiftTypesById,
      employeeIds: ['e1'],
      existingDayKeys: new Set(),
      bsYear: 2082, bsMonth: 4, days: [5],
      periodId: 'p1',
    })
    expect(rows).toEqual([
      { employee_id: 'e1', period_id: 'p1', bs_day: 5, status: 'holiday', hours_worked: 0, ot_hours: 0, note: null },
    ])
  })

  test('a zero-hour placeholder shift on a Saturday still gets the weekly_off default', () => {
    const rows = buildAttendanceFromRoster({
      rosterRows: [{ employee_id: 'e1', shift_type_id: 'leave', bs_day: 6 }],
      shiftTypesById,
      employeeIds: ['e1'],
      existingDayKeys: new Set(),
      bsYear: 2082, bsMonth: 4, days: [6],
      periodId: 'p1',
    })
    expect(rows).toEqual([
      { employee_id: 'e1', period_id: 'p1', bs_day: 6, status: 'weekly_off', hours_worked: 0, ot_hours: 0, note: null },
    ])
  })

  test('a non-rostered Saturday with no existing attendance becomes weekly_off', () => {
    const rows = buildAttendanceFromRoster({
      rosterRows: [],
      shiftTypesById,
      employeeIds: ['e1'],
      existingDayKeys: new Set(),
      bsYear: 2082, bsMonth: 4, days: [6],
      periodId: 'p1',
    })
    expect(rows).toEqual([
      { employee_id: 'e1', period_id: 'p1', bs_day: 6, status: 'weekly_off', hours_worked: 0, ot_hours: 0, note: null },
    ])
  })

  test('a non-rostered, non-Saturday day is left for manual entry', () => {
    const rows = buildAttendanceFromRoster({
      rosterRows: [],
      shiftTypesById,
      employeeIds: ['e1'],
      existingDayKeys: new Set(),
      bsYear: 2082, bsMonth: 4, days: [7],
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
      bsYear: 2082, bsMonth: 4, days: [5],
      periodId: 'p1',
    })
    expect(rows).toEqual([])
  })

  test('handles multiple employees and days together', () => {
    const rows = buildAttendanceFromRoster({
      rosterRows: [
        { employee_id: 'e1', shift_type_id: 'morning', bs_day: 5 },
        { employee_id: 'e2', shift_type_id: 'morning', bs_day: 6 },
      ],
      shiftTypesById,
      employeeIds: ['e1', 'e2'],
      existingDayKeys: new Set(),
      bsYear: 2082, bsMonth: 4, days: [5, 6],
      periodId: 'p1',
    })
    // e1: rostered on 5 -> present; not rostered on 6 but it's Saturday -> weekly_off
    // e2: not rostered on 5, not Saturday -> skipped; rostered on 6 -> present (Saturday roster wins over weekly_off default)
    expect(rows).toEqual(expect.arrayContaining([
      { employee_id: 'e1', period_id: 'p1', bs_day: 5, status: 'present', hours_worked: 8, ot_hours: 0, note: null },
      { employee_id: 'e1', period_id: 'p1', bs_day: 6, status: 'weekly_off', hours_worked: 0, ot_hours: 0, note: null },
      { employee_id: 'e2', period_id: 'p1', bs_day: 6, status: 'present', hours_worked: 8, ot_hours: 0, note: null },
    ]))
    expect(rows).toHaveLength(3)
  })
})
