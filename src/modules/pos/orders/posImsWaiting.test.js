// S809 3j: the till floor's Post to Inventory and the waiting counts every screen words. The sorting
// of months decides which ones a POS manager is offered and who is named for the rest, so it is
// pinned here; postWaitingFromTill is exercised with its two posting functions mocked.
import { summarizeWaiting, waitingForPeriod, countPhrase, loadImsWaiting, postWaitingFromTill } from './posImsWaiting'
import { backfillPosOrdersToIms } from './backfillPosToIms'
import { backfillCreditNotesToIms } from '../creditnotes/creditNotePosting'
import { posStockLines } from './posRecipeBook'

// babel-jest hoists jest.mock above the imports; placed after them only to satisfy import/first.
// CRA's preset sets resetMocks: true, so each test gives these their behaviour itself.
jest.mock('./backfillPosToIms', () => ({ backfillPosOrdersToIms: jest.fn() }))
jest.mock('../creditnotes/creditNotePosting', () => ({ backfillCreditNotesToIms: jest.fn() }))
jest.mock('./posRecipeBook', () => ({ posStockLines: jest.fn() }))

const row = (bs_year, bs_month, period_status, bills, notes, period_id = period_status ? `p-${bs_year}-${bs_month}` : null) =>
  ({ bs_year, bs_month, period_id, period_status, bills, notes })

describe('summarizeWaiting', () => {
  test('sorts months into the open one, closed ones and ones not started in Inventory', () => {
    const s = summarizeWaiting([
      row(2083, 5, 'closed', 2, 0),
      row(2083, 6, 'open', 3, 1),
      row(2083, 7, null, 1, 0),
      row(2083, 4, 'closed', 0, 0),   // nothing waiting: left out
    ])
    expect(s.bills).toBe(6)
    expect(s.notes).toBe(1)
    expect(s.open).toMatchObject({ label: 'Ashwin 2083', bills: 3, notes: 1, periodId: 'p-2083-6' })
    expect(s.closed.map(m => m.label)).toEqual(['Bhadra 2083'])
    expect(s.unstarted).toEqual([expect.objectContaining({ label: 'Kartik 2083', bills: 1, periodId: null })])
  })

  test('nothing waiting is no open month and no totals', () => {
    expect(summarizeWaiting([])).toEqual({ bills: 0, notes: 0, open: null, closed: [], unstarted: [] })
    expect(summarizeWaiting(null).open).toBeNull()
  })

  test('a date outside the calendar is not dropped: it waits, named as such', () => {
    const s = summarizeWaiting([{ bs_year: null, bs_month: null, period_id: null, period_status: null, bills: 1, notes: 0 }])
    expect(s.bills).toBe(1)
    expect(s.unstarted[0].label).toMatch(/outside the Nepali calendar/)
  })
})

describe('waitingForPeriod and countPhrase', () => {
  test('one period out of the rows, 0 and 0 when it has none', () => {
    const rows = [row(2083, 6, 'open', 3, 1), row(2083, 5, 'closed', 2, 0)]
    expect(waitingForPeriod(rows, 'p-2083-5')).toEqual({ bills: 2, notes: 0 })
    expect(waitingForPeriod(rows, 'nope')).toEqual({ bills: 0, notes: 0 })
    expect(waitingForPeriod(null, 'p-2083-5')).toEqual({ bills: 0, notes: 0 })
  })

  test('words a count the way the floor and Periods do', () => {
    expect(countPhrase(3, 1)).toBe('3 bills and 1 credit note')
    expect(countPhrase(1, 0)).toBe('1 bill')
    expect(countPhrase(0, 2)).toBe('2 credit notes')
    expect(countPhrase(0, 0)).toBe('')
  })
})

describe('loadImsWaiting', () => {
  test('a refused read is an error, never an empty list (S734)', async () => {
    const supabase = { rpc: () => Promise.resolve({ data: null, error: { message: 'boom', hint: 'rank_required' } }) }
    const r = await loadImsWaiting(supabase, 'c1')
    expect(r.rows).toBeNull()
    expect(r.error).toMatchObject({ hint: 'rank_required' })
  })

  test('asks the server for this outlet, and hands the rows back', async () => {
    const calls = []
    const supabase = { rpc: (fn, args) => { calls.push([fn, args]); return Promise.resolve({ data: [row(2083, 6, 'open', 1, 0)], error: null }) } }
    const r = await loadImsWaiting(supabase, 'c1')
    expect(calls).toEqual([['pos_ims_waiting_counts', { p_client_id: 'c1' }]])
    expect(r).toEqual({ rows: [row(2083, 6, 'open', 1, 0)], error: null })
  })

  test('a thrown read is an error too', async () => {
    const supabase = { rpc: () => Promise.reject(new Error('Failed to fetch')) }
    const r = await loadImsWaiting(supabase, 'c1')
    expect(r.rows).toBeNull()
    expect(r.error.message).toBe('Failed to fetch')
  })
})

describe('postWaitingFromTill', () => {
  const OPEN = { id: 'p6', bs_year: 2083, bs_month: 6, status: 'open' }
  // scopedFrom('monthly_periods', …).eq('status', 'open').maybeSingle()
  const scopedFromWith = result => {
    const asked = []
    const fn = (table, cols) => {
      const b = {
        eq: (c, v) => { asked.push([table, cols, c, v]); return b },
        maybeSingle: () => Promise.resolve(result),
      }
      return b
    }
    fn.asked = asked
    return fn
  }
  const deps = scopedFrom => ({ supabase: { tag: 'sb' }, scopedFrom, scopedInsert: jest.fn(), scopedUpdate: jest.fn(), clientId: 'c1' })

  test('posts the open month only: its bills, then its notes, reading the book through pos_recipe_book', async () => {
    backfillPosOrdersToIms.mockResolvedValue({ posted: 3, skipped: 1 })
    backfillCreditNotesToIms.mockResolvedValue({ posted: 1, skipped: 0 })
    posStockLines.mockResolvedValue({ breakdown: {}, explosion: {} })
    const scopedFrom = scopedFromWith({ data: OPEN, error: null })
    const r = await postWaitingFromTill(deps(scopedFrom))

    expect(scopedFrom.asked).toEqual([['monthly_periods', 'id, bs_year, bs_month, status', 'status', 'open']])
    expect(r).toEqual({ period: OPEN, bills: { posted: 3, skipped: 1 }, notes: { posted: 1, skipped: 0 } })
    const billArgs = backfillPosOrdersToIms.mock.calls[0][0]
    expect(billArgs.period).toBe(OPEN)
    expect(backfillCreditNotesToIms.mock.calls[0][0].period).toBe(OPEN)
    // Bills first, then notes (a note never goes in ahead of its bill).
    expect(backfillPosOrdersToIms.mock.invocationCallOrder[0]).toBeLessThan(backfillCreditNotesToIms.mock.invocationCallOrder[0])
    // The stock lines come from the book, for this outlet.
    await billArgs.loadStockLines(['r1'], [[{ item_id: 'i1', qty: 1 }]])
    expect(posStockLines).toHaveBeenCalledWith({ tag: 'sb' }, 'c1', ['r1'], [[{ item_id: 'i1', qty: 1 }]])
  })

  test('no open month: nothing is posted, and it says so', async () => {
    const r = await postWaitingFromTill(deps(scopedFromWith({ data: null, error: null })))
    expect(r).toEqual({ reason: 'no_open' })
    expect(backfillPosOrdersToIms).not.toHaveBeenCalled()
    expect(backfillCreditNotesToIms).not.toHaveBeenCalled()
  })

  test('a failed month read stops before any post', async () => {
    const r = await postWaitingFromTill(deps(scopedFromWith({ data: null, error: { message: 'boom' } })))
    expect(r).toEqual({ step: 'period', error: { message: 'boom' } })
    expect(backfillPosOrdersToIms).not.toHaveBeenCalled()
  })

  test('a failed bill post stops before the notes', async () => {
    backfillPosOrdersToIms.mockResolvedValue({ posted: 0, skipped: 0, error: 'Could not check which bills already posted: boom' })
    const r = await postWaitingFromTill(deps(scopedFromWith({ data: OPEN, error: null })))
    expect(r).toMatchObject({ period: OPEN, step: 'bills', error: expect.stringMatching(/already posted/) })
    expect(backfillCreditNotesToIms).not.toHaveBeenCalled()
  })

  test('a failed note post keeps what the bills did', async () => {
    backfillPosOrdersToIms.mockResolvedValue({ posted: 2, skipped: 0 })
    backfillCreditNotesToIms.mockResolvedValue({ posted: 0, skipped: 0, error: 'boom' })
    const r = await postWaitingFromTill(deps(scopedFromWith({ data: OPEN, error: null })))
    expect(r).toEqual({ period: OPEN, bills: { posted: 2, skipped: 0 }, step: 'notes', error: 'boom' })
  })
})
