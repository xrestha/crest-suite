import { NON_WORKING_STATUSES, withStatus, fillBlankCells, attendanceRowFor, cellSignature, unsavedKeys, carryUnsavedEdits, splitCellKey } from './attendanceRules'

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

// The sheet's own canonicaliser, reduced: a colon time → "H:MM", seconds dropped, anything else as typed.
const timeKey = raw => {
  const t = (raw || '').trim()
  const m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  if (m) return `${parseInt(m[1], 10)}:${m[2]}`
  if (/^\d{4}$/.test(t)) return `${parseInt(t.slice(0, 2), 10)}:${t.slice(2)}`
  return t
}

describe('cellSignature', () => {
  it('calls a typed cell and the row Postgres returned for it the same cell', () => {
    const typed  = { status: 'present', start_time: '0800', end_time: '17:30', break_minutes: '30', hours_worked: '9.0', ot_hours: '', note: '' }
    const stored = { status: 'present', start_time: '08:00:00', end_time: '17:30:00', break_minutes: 30, hours_worked: 9, ot_hours: 0, note: null }
    expect(cellSignature(typed, timeKey)).toBe(cellSignature(stored, timeKey))
  })

  it('ignores hours on a non-working day, the way the save does', () => {
    expect(cellSignature({ status: 'weekly_off', hours_worked: 9 }, timeKey)).toBe(cellSignature({ status: 'weekly_off' }, timeKey))
  })

  it('keeps a half-typed time, so it still reads as an edit', () => {
    expect(cellSignature({ status: 'present', start_time: '08' }, timeKey)).not.toBe(cellSignature({ status: 'present' }, timeKey))
  })

  it('is empty for no cell at all', () => {
    expect(cellSignature(undefined, timeKey)).toBe('')
  })
})

describe('unsavedKeys', () => {
  it('finds edits on every day, not only the one on screen', () => {
    const saved = { 'e1:1': { status: 'present' }, 'e1:2': { status: 'absent' } }
    const records = {
      'e1:1': { status: 'present' },        // unchanged
      'e1:2': { status: 'present' },        // changed
      'e2:9': { status: 'weekly_off' },     // new
    }
    expect(unsavedKeys(records, saved, timeKey).sort()).toEqual(['e1:2', 'e2:9'])
  })

  it('does not count a cleared cell — its row was deleted when it was cleared', () => {
    expect(unsavedKeys({}, { 'e1:1': { status: 'present' } }, timeKey)).toEqual([])
  })
})

describe('splitCellKey', () => {
  it('splits a uuid key', () => {
    expect(splitCellKey('3f2a9c1e-0000-4000-8000-000000000001:12')).toEqual({ employeeId: '3f2a9c1e-0000-4000-8000-000000000001', day: 12 })
  })
})

describe('carryUnsavedEdits', () => {
  const prevSaved = { 'e1:1': { status: 'present' }, 'e1:2': { status: 'present' } }

  it('keeps an unsaved edit on another day through a reload (the S768 defect)', () => {
    const current = { ...prevSaved, 'e1:3': { status: 'absent' } }        // Day 3 marked, not saved
    const fresh   = { ...prevSaved, 'e1:4': { status: 'present' } }       // Day 4 was what got saved
    const next = carryUnsavedEdits(fresh, current, prevSaved, timeKey)
    expect(next['e1:3']).toEqual({ status: 'absent' })
    expect(next['e1:4']).toEqual({ status: 'present' })
  })

  it("lets a saved edit give way to the server's copy of itself", () => {
    const current = { ...prevSaved, 'e1:2': { status: 'present', start_time: '0900' } }
    const stored  = { status: 'present', start_time: '09:00:00', id: 'row-2' }
    const next = carryUnsavedEdits({ ...prevSaved, 'e1:2': stored }, current, prevSaved, timeKey)
    expect(next['e1:2']).toBe(stored)
  })

  it('keeps a value typed while the save was in flight', () => {
    const current = { ...prevSaved, 'e1:2': { status: 'present', note: 'late — typed during save' } }
    const fresh   = { ...prevSaved, 'e1:2': { status: 'present', note: 'late' } }
    expect(carryUnsavedEdits(fresh, current, { ...prevSaved }, timeKey)['e1:2'].note).toBe('late — typed during save')
  })

  it('does not bring back what the write deleted on purpose', () => {
    const current = { ...prevSaved, 'e1:5': { status: 'absent' } }
    const next = carryUnsavedEdits({}, current, prevSaved, timeKey, key => key.endsWith(':5') || key.startsWith('e1:'))
    expect(next).toEqual({})
  })

  it('leaves an untouched cell to the fresh read', () => {
    const next = carryUnsavedEdits({}, prevSaved, prevSaved, timeKey)
    expect(next).toEqual({}) // another tab deleted them; nothing here was an edit
  })
})
