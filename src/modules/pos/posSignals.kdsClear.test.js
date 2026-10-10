// S809 3d (FLOOR-KITCHEN-2): which Kitchen Display tickets have nothing left on them to make, and so
// show Clear instead of Start / Ready / Served. guard_pos_kot_log makes the same test against the order.
import { ticketAllPulled } from './posSignals'

const pull = qty => ({ qty, removed_at: '2026-10-10T13:00:00Z', reason: 'Wrong item fired' })

describe('ticketAllPulled', () => {
  test('a one-dish ticket whose dish was taken off in full', () => {
    expect(ticketAllPulled([{ name: 'Chicken Momo', qty: 2 }], { 0: [pull(2)] })).toBe(true)
  })

  test('two pulls that together cover the dish', () => {
    expect(ticketAllPulled([{ name: 'Chicken Momo', qty: 2 }], { 0: [pull(1), pull(1)] })).toBe(true)
  })

  test('a dish only partly taken off is still food to make', () => {
    expect(ticketAllPulled([{ name: 'Chicken Momo', qty: 2 }], { 0: [pull(1)] })).toBe(false)
  })

  test('every dish must be covered, not just one', () => {
    const items = [{ name: 'Chicken Momo', qty: 2 }, { name: 'Veg Momo', qty: 1 }]
    expect(ticketAllPulled(items, { 0: [pull(2)] })).toBe(false)
    expect(ticketAllPulled(items, { 0: [pull(2)], 1: [pull(1)] })).toBe(true)
  })

  test('no pulls at all', () => {
    expect(ticketAllPulled([{ name: 'Chicken Momo', qty: 2 }], null)).toBe(false)
    expect(ticketAllPulled([{ name: 'Chicken Momo', qty: 2 }], {})).toBe(false)
  })

  test('a CHANGE card (S809 3a) is never "all taken off": it has no dish, and Seen clears it', () => {
    expect(ticketAllPulled([{ name: 'Chicken Momo', qty: 0, change: true, notes: 'No peanuts' }], null)).toBe(false)
    expect(ticketAllPulled([{ name: 'Chicken Momo', qty: 0, change: true }], { 0: [pull(1)] })).toBe(false)
  })

  test('a ticket with nothing on it, or a malformed one, is not clearable', () => {
    expect(ticketAllPulled([], {})).toBe(false)
    expect(ticketAllPulled(null, {})).toBe(false)
    expect(ticketAllPulled({ not: 'an array' }, {})).toBe(false)
    expect(ticketAllPulled([{ name: 'Odd line' }], { 0: [pull(1)] })).toBe(false)
  })

  test('a CHANGE line beside the food is ignored (it is never mixed in, but must not count if it is)', () => {
    const items = [{ name: 'Chicken Momo', qty: 1 }, { name: 'Chicken Momo', qty: 0, change: true }]
    expect(ticketAllPulled(items, { 0: [pull(1)] })).toBe(true)
  })
})
