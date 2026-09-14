import { windowsOverlap, findTableConflicts } from './reservationConflicts'

const at = hm => `2026-09-14T${hm}:00+05:45`
const booking = (id, hm, minutes, tables, status = 'booked', extra = {}) => ({
  id, customer_name: `Guest ${id}`, party_size: 4, reserved_for: at(hm), duration_minutes: minutes, status,
  pos_reservation_tables: tables.map((table_id, i) => ({ id: `${id}-${i}`, table_id })),
  ...extra,
})

describe('windowsOverlap', () => {
  test('intersecting windows overlap', () => {
    expect(windowsOverlap({ start: 0, end: 10 }, { start: 5, end: 15 })).toBe(true)
    expect(windowsOverlap({ start: 5, end: 15 }, { start: 0, end: 10 })).toBe(true)
  })
  test('one window inside another overlaps', () => {
    expect(windowsOverlap({ start: 0, end: 100 }, { start: 40, end: 50 })).toBe(true)
  })
  test('touching ends do not overlap — the next party sits as the last turn ends', () => {
    expect(windowsOverlap({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(false)
    expect(windowsOverlap({ start: 10, end: 20 }, { start: 0, end: 10 })).toBe(false)
  })
  test('disjoint windows do not overlap', () => {
    expect(windowsOverlap({ start: 0, end: 10 }, { start: 11, end: 20 })).toBe(false)
  })
  test('missing or non-finite windows never overlap', () => {
    expect(windowsOverlap(null, { start: 0, end: 10 })).toBe(false)
    expect(windowsOverlap({ start: NaN, end: 10 }, { start: 0, end: 10 })).toBe(false)
  })
})

describe('findTableConflicts', () => {
  test('flags a live booking on the same table whose window intersects', () => {
    const existing = booking('a', '18:30', 90, ['t4'])
    const out = findTableConflicts({ reserved_for: at('19:00'), duration_minutes: 60 }, ['t4'], [existing])
    expect(out).toEqual([{ tableId: 't4', booking: existing }])
  })

  test('a different table is not a conflict', () => {
    const existing = booking('a', '18:30', 90, ['t4'])
    expect(findTableConflicts({ reserved_for: at('19:00'), duration_minutes: 60 }, ['t7'], [existing])).toEqual([])
  })

  test('back-to-back bookings on one table are allowed', () => {
    const existing = booking('a', '18:00', 90, ['t4']) // 18:00–19:30
    expect(findTableConflicts({ reserved_for: at('19:30'), duration_minutes: 60 }, ['t4'], [existing])).toEqual([])
  })

  test('a booking ending before the candidate starts is not a conflict', () => {
    const existing = booking('a', '12:00', 60, ['t4'])
    expect(findTableConflicts({ reserved_for: at('19:00'), duration_minutes: 60 }, ['t4'], [existing])).toEqual([])
  })

  test.each(['cancelled', 'no_show', 'completed'])('a %s booking holds nothing', status => {
    const existing = booking('a', '19:00', 90, ['t4'], status)
    expect(findTableConflicts({ reserved_for: at('19:00'), duration_minutes: 60 }, ['t4'], [existing])).toEqual([])
  })

  test.each(['requested', 'booked', 'confirmed', 'arrived', 'seated'])('a %s booking still holds its table', status => {
    const existing = booking('a', '19:00', 90, ['t4'], status)
    expect(findTableConflicts({ reserved_for: at('19:00'), duration_minutes: 60 }, ['t4'], [existing])).toHaveLength(1)
  })

  test('an edit never clashes with its own stored row', () => {
    const self = booking('a', '19:00', 90, ['t4'])
    expect(findTableConflicts({ id: 'a', reserved_for: at('19:15'), duration_minutes: 90 }, ['t4'], [self])).toEqual([])
  })

  test('a long booking that started earlier still clashes', () => {
    const existing = booking('a', '12:00', 600, ['t4']) // 12:00–22:00
    expect(findTableConflicts({ reserved_for: at('20:00'), duration_minutes: 60 }, ['t4'], [existing])).toHaveLength(1)
  })

  test('every clashing table is reported, earliest booking first', () => {
    const late = booking('b', '19:30', 60, ['t4'])
    const early = booking('a', '18:45', 60, ['t7', 't4'])
    const out = findTableConflicts({ reserved_for: at('19:00'), duration_minutes: 90 }, ['t4', 't7'], [late, early])
    expect(out.map(c => `${c.booking.id}:${c.tableId}`)).toEqual(['a:t7', 'a:t4', 'b:t4'])
  })

  test('no tables asked for means nothing to check', () => {
    const existing = booking('a', '19:00', 90, ['t4'])
    expect(findTableConflicts({ reserved_for: at('19:00'), duration_minutes: 60 }, [], [existing])).toEqual([])
  })

  test('a missing duration falls back to windowOf\'s 90 minutes', () => {
    const existing = booking('a', '18:00', null, ['t4']) // 18:00–19:30 by fallback
    expect(findTableConflicts({ reserved_for: at('19:15'), duration_minutes: 30 }, ['t4'], [existing])).toHaveLength(1)
  })
})
