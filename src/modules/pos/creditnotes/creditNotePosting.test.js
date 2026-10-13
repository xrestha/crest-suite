import { creditNoteInInventory, postWaitingCreditNotes, countUnpostedCreditNotesForPeriod } from './creditNotePosting'
import { bsToAd, formatAd } from '../../../utils/bsCalendar'

// Since S832 (5f-4) the server posts a credit note as it is issued and posts waiting notes; the page
// reads the mark back, words why a note waits, and asks the server. The reversal itself is the SQL
// pos_post_credit_note_into (the bill's own pos_bill_sales_rows, negated), proved by its migration's
// probe and parity check against every note on record.

jest.mock('../../../shared/fetchAllRows', () => ({
  fetchAllRows: async make => make(),
  fetchAllRowsChunked: async (ids, make) => make(ids),
}))

// A tiny query-builder stand-in: every chained call returns itself, and awaiting it resolves the
// canned result for that table/operation.
function builder(result) {
  const b = new Proxy({}, {
    get: (_t, prop) => prop === 'then'
      ? (ok, bad) => Promise.resolve(result).then(ok, bad)
      : () => b,
  })
  return b
}

describe('creditNoteInInventory — the server posted it, or why it waits', () => {
  const today = { year: 2083, month: 6, day: 27 }
  const order = { id: 'o1', closed_at: '2026-10-13T09:00:00+05:45' }

  function harness({ mark = null, markError = null, period = { id: 'p6', status: 'open' }, periodError = null, billSale = [] } = {}) {
    const asked = []
    const scopedFrom = jest.fn(table => {
      asked.push(table)
      if (table === 'pos_credit_notes') return builder({ data: markError ? null : { ims_posted_at: mark }, error: markError })
      return builder({ data: periodError ? null : period, error: periodError })
    })
    const salesReads = []
    const supabase = { from: table => { salesReads.push(table); return builder({ data: billSale, error: null }) } }
    return { scopedFrom, supabase, asked, salesReads }
  }

  it('reads the mark the issue wrote, and says nothing more when it is there', async () => {
    const h = harness({ mark: '2026-10-13T04:00:00Z' })
    const res = await creditNoteInInventory({ ...h, note: { id: 'cn1' }, order, today })
    expect(res).toEqual({ posted: true })
    expect(h.asked).toEqual(['pos_credit_notes'])
    expect(h.salesReads).toEqual([])
  })

  // S831 5f-3 (Q31 a): a note on a bill closed before the outlet's Inventory began is never sent.
  it("reads nothing for a bill closed before the outlet's Inventory began", async () => {
    const h = harness()
    const res = await creditNoteInInventory({
      ...h, note: { id: 'cn1' }, order: { ...order, closed_at: '2026-10-12T20:00:00+05:45' }, today,
      imsSince: '2026-10-12T18:15:00+00:00',
    })
    expect(res).toEqual({ posted: false, reason: 'before_inventory' })
    expect(h.scopedFrom).not.toHaveBeenCalled()
  })

  it("waits, and says so, when today's month has not been started in Inventory", async () => {
    const h = harness({ period: null })
    await expect(creditNoteInInventory({ ...h, note: { id: 'cn1' }, order, today })).resolves.toEqual({ posted: false, reason: 'no_period' })
    expect(h.asked).toEqual(['pos_credit_notes', 'monthly_periods'])
  })

  it("waits when today's month is closed in Inventory", async () => {
    const h = harness({ period: { id: 'p6', status: 'closed' } })
    await expect(creditNoteInInventory({ ...h, note: { id: 'cn1' }, order, today })).resolves.toEqual({ posted: false, reason: 'closed' })
  })

  it("a not-served note waits for its bill when the bill's own sale is not in Inventory", async () => {
    const h = harness({ billSale: [] })
    await expect(creditNoteInInventory({ ...h, note: { id: 'cn9', restock: true }, order, today }))
      .resolves.toEqual({ posted: false, reason: 'bill_waiting' })
    expect(h.salesReads).toEqual(['sales_entries'])
  })

  it('an unmarked note in an open month, its bill in, is a post that failed', async () => {
    const h = harness({ billSale: [{ id: 's1' }] })
    await expect(creditNoteInInventory({ ...h, note: { id: 'cn9', restock: true }, order, today }))
      .resolves.toEqual({ posted: false, reason: 'write' })
    const plain = harness()
    await expect(creditNoteInInventory({ ...plain, note: { id: 'cn1', restock: false }, order, today }))
      .resolves.toEqual({ posted: false, reason: 'write' })
    // a served note never asks about its bill
    expect(plain.salesReads).toEqual([])
  })

  it('a failed read of the mark is unknown, never "posted" or "waiting"', async () => {
    const err = { message: 'Failed to fetch' }
    const h = harness({ markError: err })
    await expect(creditNoteInInventory({ ...h, note: { id: 'cn1' }, order, today })).resolves.toEqual({ posted: false, reason: 'read', error: err })
    expect(h.asked).toEqual(['pos_credit_notes'])
  })
})

describe('postWaitingCreditNotes — the server posts the month, a batch per call', () => {
  it('asks the server for the month and adds up what it did', async () => {
    const rpc = jest.fn(async () => ({ data: { posted: 2, already: 1, nothing_to_post: 1, bill_waiting: 0, remaining: 0 }, error: null }))
    const res = await postWaitingCreditNotes({ rpc }, 'p6')
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('post_waiting_credit_notes', { p_period_id: 'p6', p_limit: 200 })
    expect(res).toEqual({ posted: 2, skipped: 2, billWaiting: 0, waiting: 0 })
  })

  it('calls again while notes remain, and stops when a call moves nothing', async () => {
    const answers = [
      { posted: 200, already: 0, nothing_to_post: 0, bill_waiting: 1, remaining: 3 },
      { posted: 1, already: 0, nothing_to_post: 0, bill_waiting: 1, remaining: 2, error: 'duplicate key', failed: 1 },
      { posted: 0, already: 0, nothing_to_post: 0, bill_waiting: 1, remaining: 2, error: 'duplicate key', failed: 1 },
    ]
    const rpc = jest.fn(async () => ({ data: answers.shift(), error: null }))
    const res = await postWaitingCreditNotes({ rpc }, 'p6')
    expect(rpc).toHaveBeenCalledTimes(3)
    expect(res).toEqual({ posted: 201, skipped: 0, billWaiting: 1, waiting: 2, failedText: 'duplicate key' })
  })

  it("returns the server's refusal with what had already gone in", async () => {
    const refusal = { code: '42501', hint: 'rank_required', message: 'post_waiting_credit_notes: refused' }
    const rpc = jest.fn(async () => ({ data: null, error: refusal }))
    const res = await postWaitingCreditNotes({ rpc }, 'p6')
    expect(res).toEqual({ posted: 0, skipped: 0, billWaiting: 0, waiting: null, error: refusal })
  })
})

describe('countUnpostedCreditNotesForPeriod — for Periods\' confirm', () => {
  const period = { id: 'p1', bs_year: 2083, bs_month: 5 }
  const npt = (m, d, hhmm) => `${formatAd(bsToAd(2083, m, d))}T${hhmm}:00+05:45`

  // S831 5f-3 (Q31 a): a note on a bill closed before the outlet's Inventory began never waits.
  it("leaves out a note on a bill from before the outlet's Inventory began", async () => {
    const supabase = { from: () => builder({ data: [], error: null }) }
    const scopedFrom = () => builder({ data: [
      { id: 'cn-old', order_id: 'o-old', created_at: npt(5, 3, '10:00'), pos_orders: { closed_at: npt(5, 1, '12:00') } },
      { id: 'cn-new', order_id: 'o-new', created_at: npt(5, 3, '11:00'), pos_orders: { closed_at: npt(5, 3, '09:00') } },
    ], error: null })
    await expect(countUnpostedCreditNotesForPeriod({ supabase, scopedFrom, period, imsSince: npt(5, 2, '00:00') })).resolves.toBe(1)
    await expect(countUnpostedCreditNotesForPeriod({ supabase, scopedFrom, period })).resolves.toBe(2)
  })

  it('does not count a note whose reversal is already in Inventory', async () => {
    const supabase = { from: () => builder({ data: [{ pos_credit_note_id: 'cn1', id: 's1' }], error: null }) }
    const scopedFrom = () => builder({ data: [
      { id: 'cn1', order_id: 'o1', created_at: npt(5, 3, '10:00') },
      { id: 'cn2', order_id: 'o2', created_at: npt(5, 3, '11:00') },
    ], error: null })
    await expect(countUnpostedCreditNotesForPeriod({ supabase, scopedFrom, period })).resolves.toBe(1)
  })

  it('throws rather than counting none when it cannot check what already posted', async () => {
    const supabase = { from: () => builder({ data: null, error: { message: 'boom' } }) }
    const scopedFrom = () => builder({ data: [{ id: 'cn1', order_id: 'o1', created_at: npt(5, 3, '10:00') }], error: null })
    await expect(countUnpostedCreditNotesForPeriod({ supabase, scopedFrom, period })).rejects.toThrow('boom')
  })
})
