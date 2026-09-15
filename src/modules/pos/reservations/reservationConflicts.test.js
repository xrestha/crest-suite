import fs from 'fs'
import path from 'path'
import { windowsOverlap, findTableConflicts, describeHoldRefusal } from './reservationConflicts'
import { LIVE_STATUSES } from './reservationStatus'

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

// S755. The same rule is enforced twice — here, and by guard_pos_reservation_table_hold in the
// database — and the two must mean the same "live". The server cannot import this file, so the
// test reads the migration: the S707 itemRefTables technique.
describe('the database half of the table-hold rule', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations', '20260917100000_pos_open_gaps_s755.sql'), 'utf8')

  test('pos_reservation_is_live() lists exactly LIVE_STATUSES', () => {
    const body = sql.match(/FUNCTION public\.pos_reservation_is_live[\s\S]*?ARRAY\[([^\]]*)\]/)
    expect(body).not.toBeNull()
    const statuses = body[1].split(',').map(s => s.trim().replace(/'/g, ''))
    expect([...statuses].sort()).toEqual([...LIVE_STATUSES].sort())
  })

  test('the window is half-open, exactly as windowsOverlap reads it', () => {
    // strict < on both sides: touching ends do not clash
    expect(sql).toMatch(/me\.reserved_for < o\.reserved_for\s+\+ make_interval\(mins => o\.duration_minutes\)/)
    expect(sql).toMatch(/o\.reserved_for\s+< me\.reserved_for \+ make_interval\(mins => me\.duration_minutes\)/)
  })
})

describe('describeHoldRefusal', () => {
  const details = JSON.stringify({
    table_id: 't1', table_name: 'Table 4', reservation_id: 'r9', customer_name: 'Sharma',
    party_size: 4, reserved_for: '2026-09-18T13:45:00+00:00', duration_minutes: 90,
  })

  test('words the refusal from the structured detail, in Nepal time', () => {
    const out = describeHoldRefusal({ code: '23P01', hint: 'table_hold_overlap', message: 'table_hold_overlap: Table 4 is already held…', details })
    expect(out.text).toMatch(/^Table 4 is already held for Sharma ×4 at 0?7:30 PM on 2 Ashwin/)
    expect(out.text).toMatch(/another device/)
    expect(out.detail).toMatch(/^23P01 · table_hold_overlap/)
  })

  test('matches on the message code when the hint was lost, and still says something without a detail', () => {
    const out = describeHoldRefusal({ message: 'table_hold_overlap: Table 4 is already held…' })
    expect(out.text).toMatch(/another device/)
  })

  test('is null for any other failure', () => {
    expect(describeHoldRefusal(null)).toBeNull()
    expect(describeHoldRefusal({ code: '42501', message: 'permission denied' })).toBeNull()
    expect(describeHoldRefusal({ message: 'no_table_hold_overlap_here' })).toBeNull()
  })
})
