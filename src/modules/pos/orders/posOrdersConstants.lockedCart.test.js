// S809 3g: what a till lock's kept cart puts back (ORDER-FLOW-10), and the note a merge keeps (S809.4).
import { keptLinesToRestore, mergeUnsentLines, lineKeyOf } from './posOrdersConstants'

// Ram's Table 5: 2 Thakali Sets and 3 Masala Teas sent and saved, then one more tea tapped in before
// the till locked. What the lock keeps (PosOrders' beforeLockRef): only the lines with unsaved units.
const THAKALI = { recipe_id: 'r-thakali', name: 'Thakali Set', category: 'Food', qty: 2, unit_price: 550, vat_rate: 0.13, sent_to_kot: true, sent_qty: 2, notes: '' }
const TEA = { recipe_id: 'r-tea', name: 'Masala Tea', category: 'Beverage', qty: 4, unit_price: 120, vat_rate: 0.13, sent_to_kot: false, sent_qty: 3, notes: '' }
const keptTea = { ...TEA, unsaved_qty: 1 }

const qtyOf = (lines, recipeId) => (lines.find(l => l.recipe_id === recipeId) || {}).qty || 0

describe('keptLinesToRestore — a restore never brings back a saved dish', () => {
  test('the bill closed during the lock: only the unsaved tea comes back, not the meal already paid for', () => {
    const back = keptLinesToRestore([keptTea], [])
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ recipe_id: 'r-tea', qty: 1, sent_to_kot: false, sent_qty: 0 })
    expect(back[0]).not.toHaveProperty('unsaved_qty')
  })

  test('the order is still open as it was: the one unsaved tea comes back', () => {
    const server = [{ ...THAKALI }, { ...TEA, qty: 3, sent_to_kot: true }]
    expect(qtyOf(keptLinesToRestore([keptTea], server), 'r-tea')).toBe(1)
  })

  test('a dish another till took off during the lock is not put back', () => {
    // A kept line with nothing unsaved (a full cart from the screen) is capped at zero.
    const kept = [{ ...THAKALI, unsaved_qty: 0 }, keptTea]
    const server = [{ ...THAKALI, qty: 1 }, { ...TEA, qty: 2, sent_to_kot: true }]
    const back = keptLinesToRestore(kept, server)
    expect(qtyOf(back, 'r-thakali')).toBe(0)
    expect(qtyOf(back, 'r-tea')).toBe(1)
  })

  test('the save it rode on landed though the till never heard: nothing comes back', () => {
    expect(keptLinesToRestore([keptTea], [{ ...TEA, qty: 4 }])).toEqual([])
  })

  test('a cart kept by an older build (no unsaved count) is capped at each line\'s unsent units', () => {
    const back = keptLinesToRestore([THAKALI, TEA], [])
    expect(qtyOf(back, 'r-thakali')).toBe(0)
    expect(qtyOf(back, 'r-tea')).toBe(1)
  })

  test('a never-saved order comes back whole, customizations kept apart', () => {
    const momo = { recipe_id: 'r-momo', name: 'Veg Momo', qty: 2, sent_to_kot: false, sent_qty: 0, notes: 'Less spicy', unsaved_qty: 2 }
    const cheese = { ...momo, qty: 1, selection_key: 'o-cheese', option_ids: ['o-cheese'], unsaved_qty: 1 }
    const back = keptLinesToRestore([momo, cheese], [])
    expect(back.map(lineKeyOf).sort()).toEqual(['r-momo', 'r-momo#o-cheese'])
    expect(back.find(l => !l.selection_key)).toMatchObject({ qty: 2, notes: 'Less spicy' })
    expect(back.find(l => l.selection_key)).toMatchObject({ qty: 1, selection_key: 'o-cheese' })
  })

  test('nothing kept, nothing back', () => {
    expect(keptLinesToRestore(undefined, [])).toEqual([])
    expect(keptLinesToRestore([], [THAKALI])).toEqual([])
  })
})

describe('mergeUnsentLines joins notes instead of dropping the incoming one (S809.4)', () => {
  const saved = { recipe_id: 'r-curry', name: 'Chicken Curry', qty: 1, sent_to_kot: true, sent_qty: 1, notes: 'Less spicy' }

  test('an allergy note typed on this device survives a line that already had a note', () => {
    const merged = mergeUnsentLines([saved], [{ ...saved, qty: 1, sent_to_kot: false, sent_qty: 0, notes: 'No peanuts — allergy' }])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ qty: 2, sent_qty: 1, sent_to_kot: false, notes: 'Less spicy, No peanuts — allergy' })
  })

  test('a note both copies share is not repeated', () => {
    const merged = mergeUnsentLines([saved], [{ ...saved, qty: 1, notes: 'Less spicy, No peanuts' }])
    expect(merged[0].notes).toBe('Less spicy, No peanuts')
  })

  test('no note on either side stays null', () => {
    const plain = { ...saved, notes: '' }
    expect(mergeUnsentLines([plain], [{ ...plain, qty: 1, notes: '' }])[0].notes).toBeNull()
    expect(mergeUnsentLines([{ ...saved, notes: null }], [{ ...saved, qty: 1, notes: 'Extra rice' }])[0].notes).toBe('Extra rice')
  })
})
