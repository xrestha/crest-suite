import { printedBackAsSent, recoveredSentNote } from './offlineUpload'
import { mergeRecoveredLines } from './posOrdersConstants'

// Owner decision Q2 (S809 3f, 2026-10-10): dishes this till printed while offline, put back onto the
// SAME open order after a conflict, come back as already sent, so the next send does not print them
// again. Only the units that printed; the rest stays unsent.

const tuborg = { recipe_id: 'r-tuborg', name: 'Tuborg', category: 'Beverage', unit_price: 500, vat_rate: 0.13 }
const momo = { recipe_id: 'r-momo', name: 'Buff Momo', category: 'Food', unit_price: 300, vat_rate: 0.13 }

const conflict = {
  order_id: 'o-6',
  reason: 'stale',
  kot_sends: [
    { station: 'BOT', items: [{ recipe_id: 'r-tuborg', name: 'Tuborg', qty: 2 }] },
    { station: 'KOT', items: [{ recipe_id: 'r-momo', name: 'Buff Momo', qty: 1 }, { recipe_id: 'r-momo', name: 'Buff Momo', qty: 0, change: true }] },
  ],
}

describe('printedBackAsSent', () => {
  test('marks only the printed units of each dish as sent', () => {
    const back = printedBackAsSent(conflict, [{ ...tuborg, qty: 2 }, { ...momo, qty: 3 }])
    expect(back[0]).toMatchObject({ recipe_id: 'r-tuborg', qty: 2, sent_qty: 2, sent_to_kot: true })
    expect(back[1]).toMatchObject({ recipe_id: 'r-momo', qty: 3, sent_qty: 1, sent_to_kot: false })
  })

  test('a change-only line is no dish, and a dish that never printed stays unsent', () => {
    const tea = { recipe_id: 'r-tea', name: 'Masala Tea', qty: 1 }
    const back = printedBackAsSent(conflict, [tea])
    expect(back[0]).toMatchObject({ sent_qty: 0, sent_to_kot: false })
  })

  test('never marks more than was printed across two lines of one dish', () => {
    const back = printedBackAsSent(conflict, [
      { ...tuborg, qty: 1, selection_key: 'a' },
      { ...tuborg, qty: 3, selection_key: 'b' },
    ])
    expect(back.map(l => l.sent_qty)).toEqual([1, 1])
  })

  test('nothing printed: every line unsent', () => {
    const back = printedBackAsSent({ kot_sends: [] }, [{ ...tuborg, qty: 2 }])
    expect(back[0]).toMatchObject({ sent_qty: 0, sent_to_kot: false })
  })
})

describe('recoveredSentNote', () => {
  test('names what came back as sent', () => {
    const note = recoveredSentNote([{ ...tuborg, qty: 2, sent_qty: 2 }, { ...momo, qty: 3, sent_qty: 0 }])
    expect(note).toMatch(/^ Already printed/)
    expect(note).toContain('2 × Tuborg')
    expect(note).not.toContain('Momo')
  })
  test('empty when nothing came back as sent', () => {
    expect(recoveredSentNote([{ ...momo, qty: 1, sent_qty: 0 }])).toBe('')
  })
})

describe('mergeRecoveredLines', () => {
  test('a dish not on the order keeps its printed count as sent', () => {
    const merged = mergeRecoveredLines([], [{ ...tuborg, qty: 2, sent_qty: 2, sent_to_kot: true }])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ qty: 2, sent_qty: 2, sent_to_kot: true })
  })

  test('a dish already on the order adds its printed units to the sent count', () => {
    const base = [{ ...momo, qty: 1, sent_to_kot: true, sent_qty: 1 }]
    const merged = mergeRecoveredLines(base, [{ ...momo, qty: 2, sent_qty: 1, sent_to_kot: false }])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ qty: 3, sent_qty: 2, sent_to_kot: false })
  })

  test('fully printed on top of a fully sent line reads as sent', () => {
    const base = [{ ...tuborg, qty: 1, sent_to_kot: true, sent_qty: 1 }]
    const merged = mergeRecoveredLines(base, [{ ...tuborg, qty: 2, sent_qty: 2, sent_to_kot: true }])
    expect(merged[0]).toMatchObject({ qty: 3, sent_qty: 3, sent_to_kot: true })
  })

  test('an unsent incoming line merges exactly as mergeUnsentLines does', () => {
    const base = [{ ...momo, qty: 1, sent_to_kot: true, sent_qty: 1 }]
    const merged = mergeRecoveredLines(base, [{ ...momo, qty: 2, sent_qty: 0 }])
    expect(merged[0]).toMatchObject({ qty: 3, sent_qty: 1, sent_to_kot: false })
  })
})
