// S809 3f: the offline queue as the till reads it — whose entry it is, what it already printed, and what
// the waiter is told (ORDER-FLOW-6, -8, -15).
import {
  queuedHasLines, queuedOrderId, ownQueuedEntry, printedWhileQueued, printedText, conflictPrintedNote, recoveredPrintedNote,
  queuedSendText, LINK_DOWN_MS, UPLOAD_RETRY_MS,
} from './offlineUpload'

const send = (station, items, extra = {}) => ({ id: `${station}-${items.length}`, order_id: 'o1', station, items, ...extra })
const TUBORG = { recipe_id: 'r-tuborg', name: 'Tuborg', qty: 2 }
const MOMO = { recipe_id: 'r-momo', name: 'Buff Momo', qty: 3 }

describe('which entries the till uploads (ORDER-FLOW-15)', () => {
  test('an entry belongs to the outlet it was taken for; one queued before entries carried it, to this one', () => {
    expect(ownQueuedEntry({ order_id: 'o1', client_id: 'bloom' }, 'bloom')).toBe(true)
    expect(ownQueuedEntry({ order_id: 'o1', client_id: 'pkr' }, 'bloom')).toBe(false)
    expect(ownQueuedEntry({ order_id: 'o1' }, 'bloom')).toBe(true)
    expect(ownQueuedEntry(null, 'bloom')).toBe(false)
  })

  test('an entry of tickets only holds no lines (its order is on the server)', () => {
    expect(queuedHasLines({ order_id: 'o1', items: [] })).toBe(true)
    expect(queuedHasLines({ order_id: 'kot:o1', tickets_for: 'o1', items: [], kot_sends: [send('KOT', [MOMO])] })).toBe(false)
    expect(queuedHasLines({ order_id: 'o1', kot_sends: [send('KOT', [MOMO])] })).toBe(false) // left by a till before 3f
    expect(queuedHasLines(undefined)).toBe(false)
  })

  test('a ticket-only entry belongs to its order, not to its own key', () => {
    expect(queuedOrderId({ order_id: 'kot:o1', tickets_for: 'o1' })).toBe('o1')
    expect(queuedOrderId({ order_id: 'o1' })).toBe('o1')
  })
})

describe('what an entry printed (ORDER-FLOW-8)', () => {
  const entry = {
    reason: 'closed',
    kot_sends: [
      send('BOT', [TUBORG]),
      send('KOT', [MOMO, { recipe_id: 'r-momo', name: 'Buff Momo', qty: 0, change: true, notes: 'no chilli' }]),
      send('BOT', [{ ...TUBORG, qty: 1 }], { id: 'BOT-again' }),
    ],
  }

  test('added up per dish and station; a changed instruction is no dish', () => {
    expect(printedWhileQueued(entry)).toEqual([
      { key: 'r-tuborg', name: 'Tuborg', qty: 3, station: 'BOT' },
      { key: 'r-momo', name: 'Buff Momo', qty: 3, station: 'KOT' },
    ])
    expect(printedText(printedWhileQueued(entry))).toBe('3 × Tuborg (bar), 3 × Buff Momo (kitchen)')
  })

  test('the conflict banner says what printed, and where it stands', () => {
    expect(conflictPrintedNote(entry)).toBe(' Already printed from this till: 3 × Tuborg (bar), 3 × Buff Momo (kitchen) — they are not on the bill that was closed.')
    expect(conflictPrintedNote({ ...entry, reason: 'table_taken' })).toMatch(/— they are on no bill yet\.$/)
    expect(conflictPrintedNote({ ...entry, reason: 'stale' })).toMatch(/Buff Momo \(kitchen\)\.$/)
    expect(conflictPrintedNote({ reason: 'closed', kot_sends: [] })).toBe('')
  })

  test('after Start new order, only the lines put back that had printed are named', () => {
    const note = recoveredPrintedNote(entry, [{ recipe_id: 'r-tuborg', name: 'Tuborg', qty: 2 }])
    expect(note).toBe(' Already printed from this till while offline: 3 × Tuborg (bar). Sending prints them again, so take off any that were already made.')
    expect(recoveredPrintedNote(entry, [{ recipe_id: 'r-tea', name: 'Masala Tea', qty: 1 }])).toBe('')
  })
})

describe("the till's line for a send kept on the till (Q16)", () => {
  test('printed, not printed, and a save that sends nothing', () => {
    expect(queuedSendText({ printed: true })).toMatch(/^ok:Ticket printed\. The internet is down/)
    expect(queuedSendText({ printed: false })).toMatch(/^error:.*did NOT print/)
    expect(queuedSendText({ fires: false })).toMatch(/^ok:Saved on this till/)
  })

  test('the internet stays marked down longer than one retry, so a failed retry renews it', () => {
    expect(LINK_DOWN_MS).toBeGreaterThan(UPLOAD_RETRY_MS)
  })
})
