// S809 3f: what is left of a queued POS order after an upload (settledEntry, the pure half of
// settlePosOrderUpload), and the ticket-only entry. The IndexedDB halves need a browser; these are the
// decisions they apply.
import { settledEntry, queuedSendKey, posTicketsKey, mergedTicketsEntry } from './offlineQueue'

const MOMO = { recipe_id: 'r-momo', name: 'Veg Momo', category: 'Food', qty: 2, unit_price: 200, vat_rate: 0, sent_to_kot: true, sent_qty: 2, notes: null }
const TEA  = { recipe_id: 'r-tea', name: 'Masala Tea', category: 'Beverage', qty: 1, unit_price: 120, vat_rate: 0, sent_to_kot: true, sent_qty: 1, notes: null }
const ticket = (id, station = 'KOT') => ({ id, order_id: 'o1', station, items: [{ recipe_id: 'r-momo', name: 'Veg Momo', qty: 2 }] })
const ids = list => (list || []).map(s => s.id)

const entry = (over = {}) => ({
  order_id: 'o1', client_id: 'c1', created_offline: true, table_id: 't9', table_name: 'Table 9', covers: 2, covers_set: true,
  opened_by: 'u1', items: [MOMO], first_items: [MOMO], kot_sends: [ticket('k1'), ticket('b1', 'BOT')], rev: 3, ...over,
})

describe('settledEntry', () => {
  test('an upload that logged everything and found the entry unchanged leaves nothing', () => {
    expect(settledEntry(entry(), { rev: 3, items: [MOMO], lines: true, version: 5, doneKeys: ['k1', 'b1'] }))
      .toEqual({ entry: null, tickets: [] })
  })

  test('a ticket whose insert got no answer moves to the ticket-only entry; the order entry goes', () => {
    const out = settledEntry(entry(), { rev: 3, items: [MOMO], lines: true, version: 5, doneKeys: ['k1'] })
    expect(out.entry).toBeNull()
    expect(ids(out.tickets)).toEqual(['b1'])
  })

  test('a newer edit queued while the upload ran is kept, and now builds on what landed', () => {
    const newer = entry({ items: [MOMO, TEA], rev: 5, items_version: undefined })
    const out = settledEntry(newer, { rev: 3, items: [MOMO], lines: true, version: 7, doneKeys: ['k1', 'b1'] })
    expect(out.tickets).toEqual([])
    expect(out.entry.items).toEqual([MOMO, TEA])
    expect(out.entry.created_offline).toBe(false) // the order exists now
    expect(out.entry.items_version).toBe(7)
    expect(out.entry.first_items).toEqual([MOMO])
    expect(out.entry.kot_sends).toEqual([])
  })

  test('only a ticket added while the upload ran: the lines already landed, so the ticket moves', () => {
    const more = entry({ rev: 4, kot_sends: [ticket('k1'), ticket('b1', 'BOT'), ticket('k2')] })
    const out = settledEntry(more, { rev: 3, items: [MOMO], lines: true, version: 5, doneKeys: ['k1', 'b1'] })
    expect(out.entry).toBeNull()
    expect(ids(out.tickets)).toEqual(['k2'])
  })

  test('a ticket-only entry is gone once its tickets are logged, or keeps what did not land', () => {
    const tickets = mergedTicketsEntry(null, 'o1', { client_id: 'c1', kot_sends: [ticket('k1'), ticket('k2')] })
    expect(settledEntry(tickets, { rev: tickets.rev, lines: false, doneKeys: ['k1', 'k2'] }).entry).toBeNull()
    expect(ids(settledEntry(tickets, { rev: tickets.rev, lines: false, doneKeys: ['k1'] }).entry.kot_sends)).toEqual(['k2'])
  })

  test('an entry with no lines left by a till before S809 3f is uploaded as tickets and then goes', () => {
    const legacy = { order_id: 'o1', kot_sends: [ticket('k1')], updated_at: 1 }
    expect(settledEntry(legacy, { lines: false, doneKeys: ['k1'] }).entry).toBeNull()
  })

  test('a ticket already marked logged (a conflict) is never kept for another try', () => {
    // The marks live on the entry, never on a ticket: an older till inserts its tickets as they are.
    const e = entry({ logged_ids: ['k1'] })
    expect(settledEntry(e, { rev: 3, items: [MOMO], lines: true, version: 5, doneKeys: ['b1'] })).toEqual({ entry: null, tickets: [] })
  })

  test('an entry that is gone stays gone', () => {
    expect(settledEntry(undefined, { rev: 1, lines: true })).toEqual({ entry: null, tickets: [] })
  })
})

describe('the ticket-only entry', () => {
  test('is keyed apart from its order, so an older till never saves the order from it with no lines', () => {
    const t = mergedTicketsEntry(null, 'o1', { client_id: 'c1', table_name: 'Table 9', kot_sends: [ticket('k1')] })
    expect(posTicketsKey('o1')).not.toBe('o1')
    expect(t.order_id).toBe(posTicketsKey('o1'))
    expect(t.tickets_for).toBe('o1')
    expect(t.items).toEqual([])
    expect(t.client_id).toBe('c1')
  })

  test('adds tickets to what it already holds, and counts its writes', () => {
    const first = mergedTicketsEntry(null, 'o1', { kot_sends: [ticket('k1')] })
    const second = mergedTicketsEntry(first, 'o1', { kot_sends: [ticket('k2')] })
    expect(ids(second.kot_sends)).toEqual(['k1', 'k2'])
    expect(second.rev).toBe(first.rev + 1)
  })
})

describe('queuedSendKey', () => {
  test('a ticket is named by its id; one queued before ids existed by its contents', () => {
    expect(queuedSendKey(ticket('k1'))).toBe('k1')
    const legacy = { order_id: 'o1', station: 'KOT', items: [{ name: 'Veg Momo', qty: 1 }] }
    expect(queuedSendKey(legacy)).toBe(JSON.stringify(legacy))
    expect(queuedSendKey({ ...legacy })).toBe(queuedSendKey(legacy))
  })
})
