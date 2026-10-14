// S835 (S809.4, 3f): a queued upload refused as stale whose lost first send landed, and which another
// tablet then saved on top of, is read as landed when every dish of it is on the order. Never when the
// entry took anything off, which the larger stored count could hide.
import { storedLinesContainPayload } from './posOrdersConstants'

const line = (recipe_id, qty, extra = {}) => ({ recipe_id, qty, sent_to_kot: false, sent_qty: 0, notes: '', ...extra })

describe('storedLinesContainPayload', () => {
  test('every dish there at its quantity or more, beside another tablet\'s additions: contained', () => {
    const stored = [line('momo', 2, { sent_to_kot: true, sent_qty: 2 }), line('tea', 1), line('chowmein', 3)]
    const payload = [line('momo', 2, { sent_to_kot: true, sent_qty: 2 }), line('tea', 1)]
    expect(storedLinesContainPayload(stored, payload)).toBe(true)
  })

  test('a dish missing, short, sent less or with another note: not contained', () => {
    const payload = [line('momo', 2, { sent_qty: 2 }), line('tea', 1, { notes: 'no sugar' })]
    expect(storedLinesContainPayload([line('momo', 2, { sent_qty: 2 })], payload)).toBe(false)
    expect(storedLinesContainPayload([line('momo', 1, { sent_qty: 1 }), line('tea', 1, { notes: 'no sugar' })], payload)).toBe(false)
    expect(storedLinesContainPayload([line('momo', 2, { sent_qty: 1 }), line('tea', 1, { notes: 'no sugar' })], payload)).toBe(false)
    expect(storedLinesContainPayload([line('momo', 2, { sent_qty: 2 }), line('tea', 1)], payload)).toBe(false)
  })

  test('a customized dish is its own line', () => {
    const plain = [line('momo', 2)]
    const custom = [line('momo', 2, { selection_key: 'opt-cheese' })]
    expect(storedLinesContainPayload(plain, custom)).toBe(false)
    expect(storedLinesContainPayload(custom, custom)).toBe(true)
  })

  test('an entry that took food off since its first queued save is never contained', () => {
    const stored = [line('momo', 2), line('tea', 1)]
    // First queued save rang 2 momo; the waiter then took one off on this till.
    expect(storedLinesContainPayload(stored, [line('momo', 1)], [line('momo', 2)])).toBe(false)
    // ... or took the tea off altogether.
    expect(storedLinesContainPayload(stored, [line('momo', 2)], [line('momo', 2), line('tea', 1)])).toBe(false)
    // Only added since: contained.
    expect(storedLinesContainPayload(stored, [line('momo', 2), line('tea', 1)], [line('momo', 2)])).toBe(true)
  })

  test('an empty entry is never read as landed', () => {
    expect(storedLinesContainPayload([line('momo', 1)], [])).toBe(false)
  })
})
