// S809 3f: the offline queue as the till reads it — whose entry it is, what it already printed, and what
// the waiter is told (ORDER-FLOW-6, -8, -15).
import {
  queuedHasLines, queuedOrderId, ownQueuedEntry, printedWhileQueued, printedText, conflictPrintedNote, recoveredPrintedNote,
  queuedSendText, LINK_DOWN_MS, UPLOAD_RETRY_MS, LINK_PROBE_MS, UPLOAD_TROUBLE_TRIES, uploadTroubleText,
  judgeQueuedReadBack, SENT_ELSEWHERE_TEXT,
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

describe('S833: a link back sooner, and an upload kept for a reason that says it', () => {
  test('the internet is asked again well inside the time it stays marked down', () => {
    expect(LINK_PROBE_MS).toBeLessThan(LINK_DOWN_MS)
    expect(LINK_PROBE_MS).toBeLessThan(UPLOAD_RETRY_MS)
  })

  test('a passing hiccup is not shown, a repeated reason is', () => {
    expect(UPLOAD_TROUBLE_TRIES).toBeGreaterThan(1)
  })

  test('the floor line names the table and the reason', () => {
    const text = uploadTroubleText({ where: 'Table 4', text: 'This login cannot see that order.' })
    expect(text).toMatch(/^Table 4 is kept on this till and has still not uploaded — This login cannot see that order\. /)
    expect(text).toMatch(/tell a manager\.$/)
    expect(uploadTroubleText({ text: 'x.' })).toMatch(/^An order is kept/)
  })
})

describe('S840: what an entry printed is keyed by the exact line', () => {
  test('a customization and a combo\'s dish are lines of their own, named as the waiter knows them', () => {
    const entry = {
      kot_sends: [send('KOT', [
        { recipe_id: 'r-momo', name: 'Buff Momo', qty: 2 },
        { recipe_id: 'r-momo', name: 'Buff Momo', qty: 1, selection_key: 'opt-cheese', options: [{ kitchen: 'extra cheese' }] },
        { recipe_id: 'r-momo', name: 'Buff Momo', qty: 1, selection_key: '@cl-1/g-1', combo_name: 'Momo Set' },
      ])],
    }
    expect(printedWhileQueued(entry)).toEqual([
      { key: 'r-momo', name: 'Buff Momo', qty: 2, station: 'KOT' },
      { key: 'r-momo#opt-cheese', name: 'Buff Momo, extra cheese', qty: 1, station: 'KOT' },
      { key: 'r-momo#@cl-1/g-1', name: 'Buff Momo in Momo Set', qty: 1, station: 'KOT' },
    ])
  })

  test('after Start new order, a plain print is not named against the combo\'s line', () => {
    const entry = { kot_sends: [send('KOT', [{ recipe_id: 'r-momo', name: 'Buff Momo', qty: 2 }])] }
    expect(recoveredPrintedNote(entry, [{ recipe_id: 'r-momo', name: 'Buff Momo', qty: 1, combo_line_id: 'cl-1', combo_group_id: 'g-1' }])).toBe('')
    expect(recoveredPrintedNote(entry, [{ recipe_id: 'r-momo', name: 'Buff Momo', qty: 1 }])).toMatch(/2 × Buff Momo \(kitchen\)/)
  })

  test('a ticket line from before keys keys to its dish, as it always did', () => {
    expect(printedWhileQueued({ kot_sends: [send('BOT', [TUBORG])] })[0].key).toBe('r-tuborg')
    expect(printedWhileQueued({ kot_sends: [send('KOT', [{ name: 'Open item', qty: 1 }])] })[0].key).toBe('name:Open item')
  })
})

describe('judgeQueuedReadBack — an upload refused as stale reads the order back (S840)', () => {
  // A queued line as the queue keeps it (a save payload row) and as the order stores it.
  const row = (recipe_id, qty, sent = true) => ({ recipe_id, name: recipe_id, category: 'Food', qty, unit_price: 100, vat_rate: 0, sent_to_kot: sent, sent_qty: sent ? qty : 0, notes: null })
  const order = (version, lines, saves) => ({
    id: 'o1', status: 'open', items_version: version,
    pos_order_items: lines.map(l => ({ ...l, selection_key: '' })),
    ...(saves ? { recent_saves: saves } : {}),
  })
  const printed = [send('KOT', [{ recipe_id: 'r-momo', name: 'Buff Momo', qty: 2 }])]
  const MOMO2 = row('r-momo', 2)
  const TEA1 = row('r-tea', 1)
  const queued = over => ({ order_id: 'o1', items_version: 4, items: [MOMO2], first_items: [MOMO2], save_id: 's1', first_save_id: 's1', kot_sends: printed, ...over })

  test('THE residual: another tablet stored exactly these dishes and none of this till\'s saves is listed — staff are asked to check', () => {
    const v = judgeQueuedReadBack(queued(), order(5, [MOMO2], [{ id: 'other', v: 5 }]))
    expect(v.verdict).toBe('sent_elsewhere')
    // The content test alone took it for this till's own save: no notice, and the kitchen had it twice.
    expect(judgeQueuedReadBack(queued(), order(5, [MOMO2])).verdict).toBe('landed')
  })

  test('its own save listed: landed, at the version that save left', () => {
    const v = judgeQueuedReadBack(queued(), order(6, [MOMO2, TEA1], [{ id: 'other', v: 6 }, { id: 'S1', v: 5 }]))
    expect(v).toEqual({ verdict: 'landed', version: 5, saveId: 's1' })
  })

  test('its first save listed and still the newest: the rest goes again on top — or it is that save', () => {
    const more = queued({ items: [MOMO2, TEA1], save_id: 's2' })
    expect(judgeQueuedReadBack(more, order(5, [MOMO2], [{ id: 's1', v: 5 }]))).toEqual({ verdict: 'replay', version: 5, saveId: null })
    const same = queued({ save_id: 's2' })
    expect(judgeQueuedReadBack(same, order(5, [MOMO2], [{ id: 's1', v: 5 }]))).toEqual({ verdict: 'landed', version: 5, saveId: 's1' })
  })

  test('its first save listed, another saved on top: landed only if every line is on the order and nothing is taken off', () => {
    const more = queued({ items: [MOMO2, TEA1], save_id: 's2' })
    const onTop = [{ id: 'other', v: 6 }, { id: 's1', v: 5 }]
    expect(judgeQueuedReadBack(more, order(6, [MOMO2, TEA1, row('r-coke', 1)], onTop))).toEqual({ verdict: 'landed', version: 6, saveId: null })
    expect(judgeQueuedReadBack(more, order(6, [MOMO2, row('r-coke', 1)], onTop)).verdict).toBe('stale')
    expect(judgeQueuedReadBack({ ...more, removal_reason: 'Wrong dish' }, order(6, [MOMO2, TEA1, row('r-coke', 1)], onTop)).verdict).toBe('stale')
  })

  test('neither listed and the order differs: another device\'s change', () => {
    expect(judgeQueuedReadBack(queued(), order(5, [TEA1], [{ id: 'other', v: 5 }])).verdict).toBe('stale')
  })

  test('neither listed, the order holds these lines, and this till printed nothing: nothing to check, it stands', () => {
    expect(judgeQueuedReadBack(queued({ kot_sends: [] }), order(5, [MOMO2], [{ id: 'other', v: 5 }])).verdict).toBe('landed')
  })

  test('an entry queued before ids, or a first save with no id, is judged by its lines', () => {
    const legacy = queued({ save_id: undefined, first_save_id: undefined })
    const saves = [{ id: 'other', v: 5 }]
    expect(judgeQueuedReadBack(legacy, order(5, [MOMO2], saves)).verdict).toBe('landed')
    const mixed = queued({ items: [MOMO2, TEA1], save_id: 's2', first_save_id: undefined })
    expect(judgeQueuedReadBack(mixed, order(5, [MOMO2], saves))).toEqual({ verdict: 'replay', version: 5, saveId: null })
    expect(judgeQueuedReadBack(mixed, order(6, [MOMO2, TEA1, row('r-coke', 1)], saves)).verdict).toBe('landed')
    expect(judgeQueuedReadBack(mixed, order(6, [TEA1], saves)).verdict).toBe('stale')
  })

  test('a server without the list keeps the content test', () => {
    const more = queued({ items: [MOMO2, TEA1], save_id: 's2' })
    expect(judgeQueuedReadBack(more, order(5, [MOMO2]))).toEqual({ verdict: 'replay', version: 5, saveId: null })
  })

  test('the notice says what staff must check', () => {
    expect(SENT_ELSEWHERE_TEXT).toMatch(/^another tablet sent these dishes while this one was offline, and this till had already printed them — check with the kitchen that they are not made twice\.$/)
    expect(conflictPrintedNote({ reason: 'sent_elsewhere', kot_sends: printed })).toBe(' Already printed from this till: 2 × Buff Momo (kitchen).')
  })
})
