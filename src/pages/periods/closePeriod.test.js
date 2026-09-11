// closePeriod.js imports supabaseClient (createClient at module load) and scopedDb; both are
// mocked so the suite runs in a plain checkout, the same way persistSalesDay.test.js does it.
jest.mock('../../supabaseClient', () => ({ supabase: { from: jest.fn() } }))
jest.mock('../../shared/scopedDb', () => ({
  scopedFrom: jest.fn(), scopedInsert: jest.fn(), scopedUpdate: jest.fn(),
}))
jest.mock('../../modules/ownerReport/generateMonthlyReport', () => ({
  generateMonthlyReport: jest.fn(), saveGeneratedReport: jest.fn(),
}))
// The leave back-fill (S741) is a second write hung off period CREATION, with its own suite. It is
// mocked here so these tests stay about the close itself — and so a failure inside it is visible as
// the `leave_backfill` stage rather than as a mystery in the happy path.
jest.mock('../../modules/hr/leave/backfillApprovedLeave', () => ({
  backfillApprovedLeave: jest.fn(),
}))

import { supabase } from '../../supabaseClient'
import { scopedFrom, scopedInsert, scopedUpdate } from '../../shared/scopedDb'
import { generateMonthlyReport, saveGeneratedReport } from '../../modules/ownerReport/generateMonthlyReport'
import { backfillApprovedLeave } from '../../modules/hr/leave/backfillApprovedLeave'
import {
  performPeriodClose, closeFailureText, payrollNote, nextBsMonth,
  nextExistingPeriod, previousExistingPeriod, carryForwardOpeningStock, createPeriodWithCarryForward,
} from './closePeriod'

const PERIOD = { id: 'p-bhadra', bs_year: 2083, bs_month: 5 }
const NO_LEAVE = { filled: 0, skipped: 0, employees: 0, error: null }

// A chainable, thenable stand-in for a PostgrestBuilder that resolves to `result`.
function builder(result) {
  const b = {
    // `order`/`range` are here for carryForwardOpeningStock's fetchAllRows paging — it calls
    // makeQuery().range(from, to) per page, and a short page ends the loop.
    eq: () => b, not: () => b, select: () => b, maybeSingle: () => b, order: () => b, range: () => b,
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  }
  return b
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(console, 'error').mockImplementation(() => {})
  // Happy path by default: close ok, insert ok, no closing rows to carry, report generates.
  scopedUpdate.mockReturnValue(builder({ error: null }))
  scopedInsert.mockResolvedValue({ data: { id: 'p-ashwin' }, error: null })
  backfillApprovedLeave.mockResolvedValue(NO_LEAVE)
  scopedFrom.mockReturnValue(builder({ data: null, error: null }))
  supabase.from.mockReturnValue({
    select: () => builder({ data: [], error: null }),
    upsert: () => builder({ error: null }),
  })
  generateMonthlyReport.mockResolvedValue({ snapshot: {}, modulesIncluded: { ims: true } })
  saveGeneratedReport.mockResolvedValue(undefined)
})
afterEach(() => { console.error.mockRestore() })

describe('nextBsMonth', () => {
  test('rolls Chaitra into the next BS year', () => {
    expect(nextBsMonth({ bs_year: 2083, bs_month: 12 })).toEqual({ bs_year: 2084, bs_month: 1 })
    expect(nextBsMonth(PERIOD)).toEqual({ bs_year: 2083, bs_month: 6 })
  })
})

describe('chronological neighbours', () => {
  // S738: "the next period" is the next one that EXISTS, never bs_month + 1. A client that was
  // ended in Bhadra and re-created in Kartik has no Ashwin; the repair button pointed at Ashwin.
  const LIST = [
    { id: 'kartik', bs_year: 2083, bs_month: 7 },
    { id: 'bhadra', bs_year: 2083, bs_month: 5 },
    { id: 'chaitra-82', bs_year: 2082, bs_month: 12 },
    { id: 'ashadh-82', bs_year: 2082, bs_month: 3 },
  ]
  test('nextExistingPeriod skips the gap and crosses the year boundary', () => {
    expect(nextExistingPeriod(LIST, LIST[1]).id).toBe('kartik')
    expect(nextExistingPeriod(LIST, LIST[2]).id).toBe('bhadra')
    expect(nextExistingPeriod(LIST, LIST[0])).toBeNull()
  })
  test('previousExistingPeriod is the latest earlier one, whatever order the list is in', () => {
    const shuffled = [LIST[3], LIST[0], LIST[2], LIST[1]]
    expect(previousExistingPeriod(shuffled, LIST[0]).id).toBe('bhadra')
    expect(previousExistingPeriod(shuffled, { bs_year: 2083, bs_month: 1 }).id).toBe('chaitra-82')
    expect(previousExistingPeriod(shuffled, LIST[3])).toBeNull()
  })
  test('a period is never its own neighbour', () => {
    expect(nextExistingPeriod(LIST, { bs_year: 2083, bs_month: 5 })?.id).toBe('kartik')
    expect(previousExistingPeriod(LIST, { bs_year: 2083, bs_month: 5 })?.id).toBe('chaitra-82')
  })
})

describe('carryForwardOpeningStock', () => {
  test('reports how many rows it wrote, and 0 when the source month was never counted', async () => {
    const upsert = jest.fn(() => builder({ error: null }))
    supabase.from.mockReturnValue({
      select: () => builder({ data: [{ item_id: 'i1', physical_qty: 0 }, { item_id: 'i2', physical_qty: null }, { item_id: 'i3', physical_qty: 7 }], error: null }),
      upsert,
    })
    // A count of 0 IS a count (a row) — it carries; null is "not counted" and does not.
    expect(await carryForwardOpeningStock('p-old', 'p-new')).toEqual({ error: null, carried: 2 })
    expect(upsert.mock.calls[0][0]).toHaveLength(2)
    supabase.from.mockReturnValue({ select: () => builder({ data: [{ item_id: 'i2', physical_qty: null }], error: null }), upsert })
    expect(await carryForwardOpeningStock('p-old', 'p-new')).toEqual({ error: null, carried: 0 })
    expect(upsert).toHaveBeenCalledTimes(1)
  })
})

describe('createPeriodWithCarryForward', () => {
  // S738: a period minted by hand used to open with no opening stock and say nothing, while the
  // close's own carry-forward ran for every month opened by Close & Start Next.
  const LIST = [{ id: 'bhadra', bs_year: 2083, bs_month: 5 }, { id: 'shrawan', bs_year: 2083, bs_month: 4 }]

  test('carries the previous EXISTING period forward into the new one, across a gap', async () => {
    scopedInsert.mockResolvedValue({ data: { id: 'kartik' }, error: null })
    const upsert = jest.fn(() => builder({ error: null }))
    supabase.from.mockReturnValue({ select: () => builder({ data: [{ item_id: 'i1', physical_qty: 3 }], error: null }), upsert })
    const r = await createPeriodWithCarryForward({ clientId: 'c1', periods: LIST, bs_year: 2083, bs_month: 7 })
    expect(r).toEqual({ created: { id: 'kartik' }, error: null, carriedFrom: LIST[0], carried: 1, carryError: null, leaveFill: NO_LEAVE })
    expect(upsert.mock.calls[0][0]).toEqual([{ period_id: 'kartik', item_id: 'i1', qty: 3 }])
  })

  test('the earliest period on record has nothing to carry from, and says so rather than failing', async () => {
    scopedInsert.mockResolvedValue({ data: { id: 'first' }, error: null })
    const r = await createPeriodWithCarryForward({ clientId: 'c1', periods: [], bs_year: 2083, bs_month: 1 })
    expect(r).toEqual({ created: { id: 'first' }, error: null, carriedFrom: null, carried: 0, carryError: null, leaveFill: NO_LEAVE })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  test('a failed insert carries nothing and surfaces the error', async () => {
    scopedInsert.mockResolvedValue({ data: null, error: { code: '23505', message: 'one_open_per_client' } })
    const r = await createPeriodWithCarryForward({ clientId: 'c1', periods: LIST, bs_year: 2083, bs_month: 7 })
    expect(r.created).toBeNull()
    expect(r.error.code).toBe('23505')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  test('a failed carry-forward is reported against the period that now exists', async () => {
    scopedInsert.mockResolvedValue({ data: { id: 'kartik' }, error: null })
    supabase.from.mockReturnValue({ select: () => builder({ data: null, error: { message: 'Failed to fetch' } }), upsert: jest.fn() })
    const r = await createPeriodWithCarryForward({ clientId: 'c1', periods: LIST, bs_year: 2083, bs_month: 7 })
    expect(r.created).toEqual({ id: 'kartik' })
    expect(r.carriedFrom).toEqual(LIST[0])
    expect(r.carryError).toEqual({ message: 'Failed to fetch' })
  })
})

describe('performPeriodClose', () => {
  test('the happy path closes, opens the next month, carries forward and mints the report', async () => {
    supabase.from.mockReturnValue({
      select: () => builder({ data: [{ item_id: 'i1', physical_qty: 4 }, { item_id: 'i2', physical_qty: null }], error: null }),
      upsert: jest.fn(() => builder({ error: null })),
    })
    const r = await performPeriodClose({ clientId: 'c1', period: PERIOD, actorId: 'u1' })
    expect(r).toEqual({ closed: true, nextPeriodId: 'p-ashwin', reportSaved: true, failures: [], leaveFill: NO_LEAVE })
    expect(scopedInsert).toHaveBeenCalledWith('monthly_periods', 'c1', { bs_year: 2083, bs_month: 6, status: 'open' }, { single: true })
    // The report is generated for the CLOSED period — status must not still read 'open'.
    expect(generateMonthlyReport).toHaveBeenCalledWith({ clientId: 'c1', period: { ...PERIOD, status: 'closed' } })
    expect(saveGeneratedReport).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'u1', source: 'period_close' }))
  })

  test('a failed close stops everything — nothing else is about a month that is not closed', async () => {
    scopedUpdate.mockReturnValue(builder({ error: { code: '42501', message: 'permission denied' } }))
    const r = await performPeriodClose({ clientId: 'c1', period: PERIOD })
    expect(r.closed).toBe(false)
    expect(r.failures).toEqual([{ stage: 'close', error: expect.objectContaining({ code: '42501' }) }])
    expect(scopedInsert).not.toHaveBeenCalled()
    expect(generateMonthlyReport).not.toHaveBeenCalled()
  })

  test('a duplicate next period (retried click) is benign: carries forward into the existing row', async () => {
    scopedInsert.mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate key' } })
    scopedFrom.mockReturnValue(builder({ data: { id: 'p-existing' }, error: null }))
    const r = await performPeriodClose({ clientId: 'c1', period: PERIOD })
    expect(r.nextPeriodId).toBe('p-existing')
    expect(r.failures).toEqual([])
  })

  test('a genuinely failed next-period insert is recorded, and the report still runs', async () => {
    scopedInsert.mockResolvedValue({ data: null, error: { code: '23503', message: 'fk' } })
    const r = await performPeriodClose({ clientId: 'c1', period: PERIOD })
    expect(r.closed).toBe(true)
    expect(r.nextPeriodId).toBeNull()
    expect(r.failures.map(f => f.stage)).toEqual(['open_next'])
    expect(generateMonthlyReport).toHaveBeenCalled()
  })

  test('a failed carry-forward is a recorded failure, not a silent empty opening stock', async () => {
    // S682: a failed closing_stock read used to look like "nothing was counted".
    supabase.from.mockReturnValue({
      select: () => builder({ data: null, error: { message: 'Failed to fetch' } }),
      upsert: () => builder({ error: null }),
    })
    const r = await performPeriodClose({ clientId: 'c1', period: PERIOD })
    expect(r.failures.map(f => f.stage)).toEqual(['carry_forward'])
    expect(r.reportSaved).toBe(true)
  })

  test('the closing count is PAGED — a client past 1000 items carries all of them forward', async () => {
    // The read is one row per item, so it sat exactly on PostgREST's 1000-row cap: rows 1001+
    // were dropped with no error, and closingCountPreflight() counts with `head: true`, which is
    // NOT capped — so the dialog said "All 1,203 active items have a closing count" while 203 of
    // them entered the new month at zero. Page 1 is full, so a second read must follow it.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ item_id: `i${i}`, physical_qty: 1 }))
    const page2 = Array.from({ length: 203 }, (_, i) => ({ item_id: `j${i}`, physical_qty: 2 }))
    const pages = [page1, page2]
    // `range` has to live on the builder the WHOLE chain returns — fetchAllRows calls it after
    // .select().eq().order(), so overriding it only on the object select() hands back would be
    // silently bypassed and the test would pass against the unfixed code.
    const pager = { eq: () => pager, select: () => pager, order: () => pager, not: () => pager,
      range: () => builder({ data: pages.shift() ?? [], error: null }) }
    const upsert = jest.fn(() => builder({ error: null }))
    supabase.from.mockReturnValue({ select: () => pager, upsert })
    const r = await performPeriodClose({ clientId: 'c1', period: PERIOD })
    expect(r.failures).toEqual([])
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(upsert.mock.calls[0][0]).toHaveLength(1203)
  })

  test('a failed report never blocks the close, and is not reported as saved', async () => {
    generateMonthlyReport.mockRejectedValue(new Error('boom'))
    const r = await performPeriodClose({ clientId: 'c1', period: PERIOD })
    expect(r.closed).toBe(true)
    expect(r.reportSaved).toBe(false)
    expect(r.failures.map(f => f.stage)).toEqual(['report'])
  })

  test('openNext:false (admin End Period) opens nothing and carries nothing', async () => {
    const r = await performPeriodClose({ clientId: 'c1', period: PERIOD, openNext: false })
    expect(r).toEqual({ closed: true, nextPeriodId: null, reportSaved: true, failures: [], leaveFill: null })
    expect(scopedInsert).not.toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('closeFailureText', () => {
  test('a failed close never claims the write did not land', () => {
    // errorText.js rule: a dead fetch does not prove a failed write did not commit.
    const t = closeFailureText({ stage: 'close', period: PERIOD })
    expect(t).toMatch(/may not have closed/)
    expect(t).not.toMatch(/nothing (has )?changed/i)
  })

  test('open_next names the consequence and the recovery for each audience', () => {
    // S738: "+ Create Period" carries forward itself now, so the advice must not send the admin
    // on to Resync — a second step that the month gap this text is written for used to break.
    const admin = closeFailureText({ stage: 'open_next', period: PERIOD, isAdmin: true })
    expect(admin).toMatch(/Create Period.*carries Bhadra 2083's closing count/)
    expect(admin).not.toMatch(/Resync/)
    expect(closeFailureText({ stage: 'open_next', period: PERIOD, isAdmin: false })).toMatch(/contact your Crest consultant/i)
  })

  test('carry_forward names the month that now has no opening figures', () => {
    expect(closeFailureText({ stage: 'carry_forward', period: PERIOD })).toMatch(/Ashwin 2083's Stock Count currently opens with no opening figures/)
  })

  test('report says the lazy fallback will cover it', () => {
    expect(closeFailureText({ stage: 'report', period: PERIOD })).toMatch(/first time the report is opened/)
  })
})

describe('payrollNote', () => {
  // The note is advisory in every branch: HR is deliberately NOT locked by the period close
  // (payroll is finalized after the stock month closes), so no branch may be red.
  test('a failed check admits it, and says what an unfinalized payroll would mean', () => {
    const n = payrollNote(null, 'Bhadra 2083')
    expect(n.danger).toBe(false)
    expect(n.warn).toBe(false)
    expect(n.text).toMatch(/couldn't check/i)
    expect(n.text).toMatch(/estimated labour cost/)
  })

  test('finalized is the quiet all-clear', () => {
    const n = payrollNote({ status: 'finalized' }, 'Bhadra 2083')
    expect(n).toEqual({ danger: false, warn: false, text: expect.stringMatching(/finalized — .*exact payroll figure/) })
  })

  test('draft and none are amber, say HR stays open, and name the estimate', () => {
    for (const status of ['draft', 'none']) {
      const n = payrollNote({ status }, 'Bhadra 2083')
      expect(n.danger).toBe(false)
      expect(n.warn).toBe(true)
      expect(n.text).toMatch(/HR pages stay open/)
      expect(n.text).toMatch(/ESTIMATED labour cost/)
    }
  })
})
