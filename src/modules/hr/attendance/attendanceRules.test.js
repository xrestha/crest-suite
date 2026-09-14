import { NON_WORKING_STATUSES, withStatus, fillBlankCells, attendanceRowFor } from './attendanceRules'

const valid = s => !s || /^\d{1,2}:\d{2}$/.test(s)

describe('withStatus', () => {
  const worked = { employee_id: 'e1', bs_day: 3, status: 'present', start_time: '8:00', end_time: '20:00', break_minutes: 45, hours_worked: 11.25, ot_hours: 3 }

  it('clears times, hours and overtime when a day stops being a working day', () => {
    for (const s of NON_WORKING_STATUSES) {
      const rec = withStatus(worked, s)
      expect(rec.status).toBe(s)
      expect(rec.ot_hours).toBe('')
      expect(rec.hours_worked).toBe('')
      expect(rec.start_time).toBe('')
    }
  })

  it('keeps them on a half day — half of it was worked', () => {
    for (const s of ['half_day', 'half_paid_leave', 'half_unpaid_leave', 'present']) {
      expect(withStatus(worked, s).ot_hours).toBe(3)
    }
  })

  it('keeps the note', () => {
    expect(withStatus({ ...worked, note: 'sick' }, 'absent').note).toBe('sick')
  })
})

describe('fillBlankCells', () => {
  it('marks only the cells nobody marked, and says how many it left alone', () => {
    const records = { 'e1:4': { employee_id: 'e1', bs_day: 4, status: 'paid_leave' } }
    const cells = [
      { key: 'e1:4', employeeId: 'e1', day: 4 },
      { key: 'e2:4', employeeId: 'e2', day: 4 },
    ]
    const { next, filled, kept } = fillBlankCells(records, cells, 'present')
    expect(next['e1:4'].status).toBe('paid_leave')
    expect(next['e2:4']).toEqual({ employee_id: 'e2', bs_day: 4, status: 'present' })
    expect([filled, kept]).toEqual([1, 1])
    expect(records['e2:4']).toBeUndefined() // the input is not mutated
  })
})

describe('attendanceRowFor', () => {
  const ctx = { employeeId: 'e1', periodId: 'p1', day: 13, isValidTime: valid }

  it('saves an Off day with no hours even when the loaded row carried some (the live S749 row)', () => {
    const row = attendanceRowFor({ status: 'weekly_off', hours_worked: '9.00', ot_hours: '0.00', start_time: '9:00', end_time: '18:00' }, ctx)
    expect(row).toMatchObject({ status: 'weekly_off', hours_worked: 0, ot_hours: 0, start_time: null, end_time: null, break_minutes: null })
  })

  it('saves a working day as typed', () => {
    const row = attendanceRowFor({ status: 'present', hours_worked: '8', ot_hours: '1.5', start_time: '8:00', end_time: '17:30', break_minutes: '30' }, ctx)
    expect(row).toMatchObject({ status: 'present', hours_worked: 8, ot_hours: 1.5, start_time: '8:00', end_time: '17:30', break_minutes: 30 })
  })

  it('drops an invalid time rather than sending it to a time column', () => {
    expect(attendanceRowFor({ status: 'present', start_time: '080' }, ctx).start_time).toBeNull()
  })

  it('treats a cell with no status as Present', () => {
    expect(attendanceRowFor({ note: 'x' }, ctx).status).toBe('present')
  })
})
