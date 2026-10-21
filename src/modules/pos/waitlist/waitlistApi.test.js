/**
 * The walk-in waitlist (S854): the waited / overdue maths the panel paints amber from, the live
 * list and its order, the WhatsApp copy, the Add form rules, and the writes the floor relies on
 * (a guarded status move that reports a 0-row answer, and the seat link that survives a retry).
 */
import {
  waitedMinutes, isOverdue, minutesOver, liveEntries, readyMessage, validateWaitlistDraft,
  addWaitlistEntry, markWaitlistSeated, loadLiveWaitlist, notifyWaitlistEntry, LIVE_STATUSES,
  WAITLIST_READY_TEMPLATE,
} from './waitlistApi'

const NOW = Date.parse('2026-10-21T13:00:00Z')
const ago = min => new Date(NOW - min * 60000).toISOString()

describe('waitedMinutes', () => {
  it('counts whole minutes since the party was added', () => {
    expect(waitedMinutes({ created_at: ago(23) }, NOW)).toBe(23)
    expect(waitedMinutes({ created_at: new Date(NOW - 23.9 * 60000).toISOString() }, NOW)).toBe(23)
    expect(waitedMinutes({ created_at: ago(0) }, NOW)).toBe(0)
  })

  it('takes a Date for now, and never goes below 0 when the tablet clock is behind', () => {
    expect(waitedMinutes({ created_at: ago(5) }, new Date(NOW))).toBe(5)
    expect(waitedMinutes({ created_at: ago(-3) }, NOW)).toBe(0)
  })

  it('reads a missing or broken time as 0, never as NaN', () => {
    expect(waitedMinutes({}, NOW)).toBe(0)
    expect(waitedMinutes({ created_at: 'not a time' }, NOW)).toBe(0)
    expect(waitedMinutes(null, NOW)).toBe(0)
  })
})

describe('isOverdue and minutesOver', () => {
  it('is over only once the wait passes the quote, not at it', () => {
    expect(isOverdue({ created_at: ago(29), quoted_minutes: 30 }, NOW)).toBe(false)
    expect(isOverdue({ created_at: ago(30), quoted_minutes: 30 }, NOW)).toBe(false)
    expect(isOverdue({ created_at: ago(31), quoted_minutes: 30 }, NOW)).toBe(true)
    expect(minutesOver({ created_at: ago(31), quoted_minutes: 30 }, NOW)).toBe(1)
    expect(minutesOver({ created_at: ago(12), quoted_minutes: 30 }, NOW)).toBe(0)
  })

  it('never calls a party with no usable quote overdue', () => {
    expect(isOverdue({ created_at: ago(90), quoted_minutes: 0 }, NOW)).toBe(false)
    expect(isOverdue({ created_at: ago(90) }, NOW)).toBe(false)
    expect(minutesOver({ created_at: ago(90), quoted_minutes: null }, NOW)).toBe(0)
  })
})

describe('liveEntries', () => {
  it('keeps waiting and told parties only, oldest first', () => {
    const rows = [
      { id: 'c', status: 'waiting', created_at: ago(5) },
      { id: 'a', status: 'notified', created_at: ago(40) },
      { id: 's', status: 'seated', created_at: ago(60) },
      { id: 'l', status: 'left', created_at: ago(50) },
      { id: 'x', status: 'cancelled', created_at: ago(45) },
      { id: 'b', status: 'waiting', created_at: ago(20) },
    ]
    expect(liveEntries(rows).map(r => r.id)).toEqual(['a', 'b', 'c'])
    expect(LIVE_STATUSES).toEqual(['waiting', 'notified'])
  })

  it('breaks a tie on the time by id, and does not reorder the array it was given', () => {
    const rows = [
      { id: 'z', status: 'waiting', created_at: ago(10) },
      { id: 'y', status: 'waiting', created_at: ago(10) },
    ]
    expect(liveEntries(rows).map(r => r.id)).toEqual(['y', 'z'])
    expect(rows.map(r => r.id)).toEqual(['z', 'y'])
  })

  it('answers an empty list for nothing at all', () => {
    expect(liveEntries(null)).toEqual([])
    expect(liveEntries([null, undefined])).toEqual([])
  })
})

describe('readyMessage', () => {
  it('names the guest and the outlet', () => {
    expect(readyMessage({ customer_name: ' Gurung ' }, 'Bloom Cafe'))
      .toBe('Hello Gurung, your table at Bloom Cafe is ready. Please come to the host stand.')
    expect(WAITLIST_READY_TEMPLATE).toContain('{outlet}')
  })

  it('reads naturally when the outlet name is not known', () => {
    expect(readyMessage({ customer_name: 'Gurung' }, ''))
      .toBe('Hello Gurung, your table is ready. Please come to the host stand.')
  })
})

describe('validateWaitlistDraft', () => {
  const ok = { name: 'Gurung', phone: '', partySize: 4, quotedMinutes: 20 }

  it('passes a name, a size and a quote, with the phone left empty', () => {
    expect(validateWaitlistDraft(ok)).toEqual({})
  })

  it('needs a name, and the name is not just spaces', () => {
    expect(validateWaitlistDraft({ ...ok, name: '   ' }).name).toMatch(/name/)
    expect(validateWaitlistDraft({ ...ok, name: 'x'.repeat(81) }).name).toMatch(/80/)
  })

  it('takes a phone only with at least 7 digits', () => {
    expect(validateWaitlistDraft({ ...ok, phone: '98412' }).phone).toBeTruthy()
    expect(validateWaitlistDraft({ ...ok, phone: '+977 984-1234567' })).toEqual({})
  })

  it('holds the party size to 1 to 99 whole people, and the quote to a real wait', () => {
    expect(validateWaitlistDraft({ ...ok, partySize: 0 }).party).toBeTruthy()
    expect(validateWaitlistDraft({ ...ok, partySize: 100 }).party).toBeTruthy()
    expect(validateWaitlistDraft({ ...ok, partySize: 2.5 }).party).toBeTruthy()
    expect(validateWaitlistDraft({ ...ok, partySize: NaN }).party).toBeTruthy()
    expect(validateWaitlistDraft({ ...ok, quotedMinutes: 0 }).quote).toBeTruthy()
  })
})

// A supabase-js builder stand-in: chainable, records every call, answers what it is given.
function builder(answer, log) {
  const b = {}
  for (const op of ['select', 'eq', 'in', 'gte', 'order', 'limit']) {
    b[op] = (...args) => { log.push([op, ...args]); return b }
  }
  b.then = (resolve, reject) => Promise.resolve(answer).then(resolve, reject)
  return b
}

describe('the waitlist writes', () => {
  it('reads only this service day of live parties, oldest first, with an id tiebreaker', async () => {
    const log = []
    const db = { scopedFrom: table => { log.push(['from', table]); return builder({ data: [], error: null }, log) } }
    const res = await loadLiveWaitlist(db, { nowMs: NOW })
    expect(res.error).toBeNull()
    expect(log).toEqual(expect.arrayContaining([
      ['from', 'pos_waitlist'],
      ['in', 'status', ['waiting', 'notified']],
      ['order', 'created_at'],
      ['order', 'id'],
    ]))
    const since = log.find(c => c[0] === 'gte')
    expect(since[1]).toBe('created_at')
    expect(Date.parse(since[2])).toBeLessThanOrEqual(NOW)
  })

  it('adds a trimmed party under the form id, and reads a retry that met its own id as already added', async () => {
    const sent = []
    const db = { scopedInsert: async (table, row) => { sent.push([table, row]); return { data: [{ id: row.id, status: 'waiting' }], error: null } } }
    const res = await addWaitlistEntry(db, { name: ' Gurung ', phone: ' ', partySize: 4, quotedMinutes: 20 }, { id: 'w-1' })
    expect(res).toEqual({ error: null, row: { id: 'w-1', status: 'waiting' } })
    expect(sent[0]).toEqual(['pos_waitlist', { id: 'w-1', customer_name: 'Gurung', phone: null, party_size: 4, quoted_minutes: 20, notes: null }])

    const dup = { scopedInsert: async () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "pos_waitlist_pkey"' } }) }
    expect(await addWaitlistEntry(dup, { name: 'Gurung', partySize: 4, quotedMinutes: 20 }, { id: 'w-1' }))
      .toEqual({ error: null, row: null, duplicate: true })
  })

  it('reports a refused add as the error it is', async () => {
    const err = { code: '42501', message: 'pos_waitlist_rank' }
    const db = { scopedInsert: async () => ({ data: null, error: err }) }
    expect(await addWaitlistEntry(db, { name: 'Gurung', partySize: 4, quotedMinutes: 20 })).toEqual({ error: err, row: null })
  })

  it('moves a party only from the statuses it may leave, and says when nothing moved', async () => {
    const log = []
    const db = { scopedUpdate: (table, patch) => { log.push(['update', table, patch]); return builder({ data: [], error: null }, log) } }
    const res = await notifyWaitlistEntry(db, 'w-1')
    expect(res).toEqual({ error: null, count: 0, row: null })
    expect(log).toEqual(expect.arrayContaining([
      ['update', 'pos_waitlist', { status: 'notified' }],
      ['eq', 'id', 'w-1'],
      ['in', 'status', ['waiting']],
    ]))
    // No time is sent: the server stamps notified_at.
    expect(Object.keys(log[0][2])).toEqual(['status'])
  })

  describe('markWaitlistSeated', () => {
    it('seats a live party on its bill', async () => {
      const log = []
      const db = { scopedUpdate: (table, patch) => { log.push(['update', table, patch]); return builder({ data: [{ id: 'w-1', status: 'seated', order_id: 'o-1' }], error: null }, log) } }
      const res = await markWaitlistSeated(db, 'w-1', 'o-1')
      expect(res).toEqual({ error: null, count: 1, row: { id: 'w-1', status: 'seated', order_id: 'o-1' }, alreadySeated: false })
      expect(log).toEqual(expect.arrayContaining([
        ['update', 'pos_waitlist', { status: 'seated', order_id: 'o-1' }],
        ['in', 'status', ['waiting', 'notified']],
      ]))
    })

    it('reads a retry after a lost answer as seated, when the party is already on this bill', async () => {
      const db = {
        scopedUpdate: () => builder({ data: [], error: null }, []),
        scopedFrom: () => builder({ data: [{ id: 'w-1', status: 'seated', order_id: 'o-1' }], error: null }, []),
      }
      const res = await markWaitlistSeated(db, 'w-1', 'o-1')
      expect(res.count).toBe(1)
      expect(res.alreadySeated).toBe(true)
    })

    it('answers 0 rows with the row as it stands when another device moved the party first', async () => {
      const db = {
        scopedUpdate: () => builder({ data: [], error: null }, []),
        scopedFrom: () => builder({ data: [{ id: 'w-1', status: 'left', order_id: null }], error: null }, []),
      }
      const res = await markWaitlistSeated(db, 'w-1', 'o-1')
      expect(res).toEqual({ error: null, count: 0, row: { id: 'w-1', status: 'left', order_id: null }, alreadySeated: false })
    })

    it('passes a refusal through untouched', async () => {
      const err = { code: '23503', message: 'waitlist_order_other_client' }
      const db = { scopedUpdate: () => builder({ data: null, error: err }, []) }
      const res = await markWaitlistSeated(db, 'w-1', 'o-9')
      expect(res.error).toBe(err)
      expect(res.count).toBe(0)
    })
  })
})
