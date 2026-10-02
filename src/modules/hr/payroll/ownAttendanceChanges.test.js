import { describeOwnChange, groupOwnChanges } from './ownAttendanceChanges'

const row = over => ({
  employee_id: 'e1', employee_name: 'Ram Thapa', marked_by_name: 'Ram Thapa', bs_day: 5, action: 'UPDATE',
  old_status: 'absent', new_status: 'present', old_hours: null, new_hours: null,
  old_ot_hours: null, new_ot_hours: null, ...over,
})

describe('describeOwnChange', () => {
  test('a status change reads from → to', () => {
    expect(describeOwnChange(row())).toBe('day 5: Absent → Present')
  })
  test('a new mark reads from blank', () => {
    expect(describeOwnChange(row({ action: 'INSERT', old_status: null, new_status: 'paid_leave' })))
      .toBe('day 5: blank → Paid Leave')
  })
  test('a removed mark reads to blank, because payroll pays a blank day', () => {
    expect(describeOwnChange(row({ action: 'DELETE', old_status: 'absent', new_status: null })))
      .toBe('day 5: Absent → blank')
  })
  test('hours and overtime changes are named; the audit log sends numbers as strings', () => {
    expect(describeOwnChange(row({ old_status: 'present', new_status: 'present', old_hours: '4', new_hours: '8', old_ot_hours: null, new_ot_hours: '2.5' })))
      .toBe('day 5: hours 4 → 8, overtime — → 2.5')
  })
  test('an unchanged status with equal hours is a times-only change', () => {
    expect(describeOwnChange(row({ old_status: 'present', new_status: 'present', old_hours: '8', new_hours: 8 })))
      .toBe('day 5: Present, times changed')
  })
  test('an unknown status key is shown as stored rather than dropped', () => {
    expect(describeOwnChange(row({ new_status: 'mystery' }))).toBe('day 5: Absent → mystery')
  })
})

describe('groupOwnChanges', () => {
  test('groups by employee in arrival order and lists who marked', () => {
    const g = groupOwnChanges([
      row({ bs_day: 3 }),
      row({ bs_day: 4, marked_by_name: 'Ram (old login)' }),
      row({ employee_id: 'e2', employee_name: 'Sita', marked_by_name: 'Sita', bs_day: 1 }),
      row({ bs_day: 9, marked_by_name: 'Ram Thapa' }),
    ])
    expect(g.map(x => x.name)).toEqual(['Ram Thapa', 'Sita'])
    expect(g[0].markedBy).toEqual(['Ram Thapa', 'Ram (old login)'])
    expect(g[0].lines).toEqual(['day 3: Absent → Present', 'day 4: Absent → Present', 'day 9: Absent → Present'])
  })
  test('no rows, or a missing list, is no groups', () => {
    expect(groupOwnChanges([])).toEqual([])
    expect(groupOwnChanges(null)).toEqual([])
  })
})
