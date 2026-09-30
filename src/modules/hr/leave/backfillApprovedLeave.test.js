import { supabase } from '../../../supabaseClient'
import { scopedFrom } from '../../../shared/scopedDb'
import { backfillApprovedLeave, backfillLeaveText, findApprovedLeaveGaps } from './backfillApprovedLeave'

// backfillApprovedLeave.js reaches supabase and scopedDb directly; both are mocked so the suite runs
// in a plain checkout, the same way closePeriod.test.js does it. babel-jest hoists jest.mock above
// the imports, so they sit below them here only to satisfy import/first.
jest.mock('../../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }))
jest.mock('../../../shared/scopedDb', () => ({ scopedFrom: jest.fn() }))

// Ashwin is BS month 6 (Baisakh, Jestha, Ashadh, Shrawan, Bhadra, Ashwin), and Ashwin 2083 spans
// 2026-09-17 → 2026-10-17 with 31 days. Read off bsCalendar's own table rather than assumed — the
// first draft of this file guessed month 7 and every date assertion in it silently fell outside
// the period, which is exactly the class of bug the day filter exists to prevent.
const ASHWIN = { id: 'p-ashwin', bs_year: 2083, bs_month: 6 }
// 7 and 8 Ashwin 2083, the reported case.
const REQ = {
  id: 'r1', employee_id: 'e1', leave_type_id: 't-unpaid',
  start_date: '2026-09-23', end_date: '2026-09-24', day_type: 'full',
}

// A chainable, thenable PostgrestBuilder stand-in. `range` is here for fetchAllRows' paging.
function builder(result) {
  const b = {
    eq: () => b, in: () => b, is: () => b, lte: () => b, gte: () => b, order: () => b,
    range: () => b,
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  }
  return b
}

// scopedFrom is called with the table name first, so a per-table result map keeps each test's
// intent readable instead of relying on call order.
function mockTables(map) {
  scopedFrom.mockImplementation(table => builder(map[table] ?? { data: [], error: null }))
}

beforeEach(() => {
  jest.clearAllMocks()
})

// S798: the rules (blanks only, one row per day, holidays, settled leavers, the finalized-month
// refusal) moved into hr_backfill_approved_leave and were exercised against the live database in the
// migration's rolled-back dry run. What is left here is the wrapper's contract with its callers.
describe('backfillApprovedLeave', () => {
  test('asks the database for the period and passes its counts through', async () => {
    supabase.rpc.mockResolvedValue({ data: { filled: 2, skipped: 1, settled: 2, employees: 1 }, error: null })
    const r = await backfillApprovedLeave({ clientId: 'c1', period: ASHWIN })
    expect(supabase.rpc).toHaveBeenCalledWith('hr_backfill_approved_leave', { p_period_id: 'p-ashwin' })
    expect(r).toEqual({ filled: 2, skipped: 1, settled: 2, employees: 1, error: null })
    expect(backfillLeaveText(r, 'Ashwin 2083')).toMatch(/2 days of leave belonging to staff whose Final Settlement already paid Ashwin 2083 were left out/)
  })

  test('a refusal or a failed call is an error, never "filled 0" — that would read as synced', async () => {
    const refused = { code: 'P0001', message: 'hr_month_finalized: payroll for this month is finalized' }
    supabase.rpc.mockResolvedValue({ data: null, error: refused })
    expect(await backfillApprovedLeave({ clientId: 'c1', period: ASHWIN }))
      .toEqual({ filled: 0, skipped: 0, settled: 0, employees: 0, error: refused })
  })

  test('a thrown or hung call is reported, not thrown — period creation must not fail on it', async () => {
    supabase.rpc.mockRejectedValue(new Error('Failed to fetch'))
    const r = await backfillApprovedLeave({ clientId: 'c1', period: ASHWIN })
    expect(r.filled).toBe(0)
    expect(r.error?.message).toBe('Failed to fetch')
  })

  test('an answer missing a count reads that count as 0', async () => {
    supabase.rpc.mockResolvedValue({ data: { filled: 3 }, error: null })
    expect(await backfillApprovedLeave({ clientId: 'c1', period: ASHWIN }))
      .toEqual({ filled: 3, skipped: 0, settled: 0, employees: 0, error: null })
  })

  test('a period with no id or no BS month asks nothing rather than guessing', async () => {
    expect((await backfillApprovedLeave({ clientId: 'c1', period: { bs_year: 2083, bs_month: 6 } })).filled).toBe(0)
    expect((await backfillApprovedLeave({ clientId: 'c1', period: { id: 'p', bs_year: 2083 } })).filled).toBe(0)
    expect((await backfillApprovedLeave({ clientId: null, period: ASHWIN })).filled).toBe(0)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})

describe('backfillLeaveText', () => {
  test('says nothing when nothing was filled — the overwhelmingly common case', () => {
    expect(backfillLeaveText({ filled: 0, skipped: 0, employees: 0, error: null }, 'Ashwin 2083')).toBe('')
  })

  test('names the month, the days and the people, and mentions days left alone', () => {
    const t = backfillLeaveText({ filled: 3, skipped: 1, employees: 2, error: null }, 'Ashwin 2083')
    expect(t).toContain('3 days')
    expect(t).toContain('Ashwin 2083')
    expect(t).toContain('2 employees')
    expect(t).toContain('1 day already had an attendance mark')
  })

  test('an error names the payroll consequence, not the read', () => {
    const t = backfillLeaveText({ filled: 0, skipped: 0, employees: 0, error: { message: 'x' } }, 'Ashwin 2083')
    expect(t).toContain('not be deducted in payroll')
  })
})

describe('findApprovedLeaveGaps', () => {
  const PERIODS = [{ id: 'p-bhadra', bs_year: 2083, bs_month: 5 }]

  test('leave for a month with no period is WAITING, not missing — nobody has to act', async () => {
    const r = await findApprovedLeaveGaps({
      clientId: 'c1',
      requests: [{ ...REQ, status: 'approved' }],
      periods: PERIODS,
    })
    expect(r.waiting).toEqual([{ bsYear: 2083, bsMonth: 6, days: 2 }])
    expect(r.unmarked).toEqual([])
    // No period to read attendance for, so no read at all.
    expect(scopedFrom).not.toHaveBeenCalled()
  })

  test('leave for a month that EXISTS and has no attendance row is unmarked and actionable', async () => {
    mockTables({ hr_attendance: { data: [], error: null } })
    const r = await findApprovedLeaveGaps({
      clientId: 'c1',
      requests: [{ ...REQ, status: 'approved' }],
      periods: [...PERIODS, ASHWIN],
    })
    expect(r.waiting).toEqual([])
    expect(r.unmarked).toEqual([{ period: ASHWIN, days: 2 }])
  })

  test('days already marked are not counted as a gap', async () => {
    mockTables({
      hr_attendance: {
        data: [
          { period_id: 'p-ashwin', employee_id: 'e1', bs_day: 7 },
          { period_id: 'p-ashwin', employee_id: 'e1', bs_day: 8 },
        ],
        error: null,
      },
    })
    const r = await findApprovedLeaveGaps({
      clientId: 'c1',
      requests: [{ ...REQ, status: 'approved' }],
      periods: [...PERIODS, ASHWIN],
    })
    expect(r.unmarked).toEqual([])
  })

  test('a pending or cancelled request is not a gap — only an approval promises an attendance row', async () => {
    mockTables({ hr_attendance: { data: [], error: null } })
    const r = await findApprovedLeaveGaps({
      clientId: 'c1',
      requests: [{ ...REQ, status: 'pending' }, { ...REQ, id: 'r2', status: 'cancelled' }],
      periods: [...PERIODS, ASHWIN],
    })
    expect(r).toEqual({ waiting: [], unmarked: [], error: null })
  })

  test('months before the client\'s earliest period are ignored as imported history', async () => {
    const r = await findApprovedLeaveGaps({
      clientId: 'c1',
      // Baisakh 2083 (month 1), well before the Bhadra floor.
      requests: [{ ...REQ, status: 'approved', start_date: '2026-04-20', end_date: '2026-04-21' }],
      periods: PERIODS,
    })
    expect(r).toEqual({ waiting: [], unmarked: [], error: null })
  })

  test('a failed attendance read reports the error rather than "nothing is missing"', async () => {
    mockTables({ hr_attendance: { data: null, error: { code: '42501' } } })
    const r = await findApprovedLeaveGaps({
      clientId: 'c1',
      requests: [{ ...REQ, status: 'approved' }],
      periods: [...PERIODS, ASHWIN],
    })
    expect(r.error).toMatchObject({ code: '42501' })
    expect(r.unmarked).toEqual([])
  })
})
