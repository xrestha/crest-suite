// backfillApprovedLeave.js reaches scopedDb directly; both it and supabaseClient are mocked so the
// suite runs in a plain checkout, the same way closePeriod.test.js does it.
jest.mock('../../../supabaseClient', () => ({ supabase: { from: jest.fn() } }))
jest.mock('../../../shared/scopedDb', () => ({
  scopedFrom: jest.fn(), scopedUpsert: jest.fn(),
}))

import { scopedFrom, scopedUpsert } from '../../../shared/scopedDb'
import { backfillApprovedLeave, backfillLeaveText, findApprovedLeaveGaps } from './backfillApprovedLeave'

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
    eq: () => b, in: () => b, lte: () => b, gte: () => b, order: () => b,
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
  scopedUpsert.mockResolvedValue({ data: null, error: null })
})

describe('backfillApprovedLeave', () => {
  test('writes one attendance row per day of an approved leave that falls in the period', async () => {
    mockTables({
      hr_leave_requests: { data: [REQ], error: null },
      hr_leave_types: { data: [{ id: 't-unpaid', paid: false }], error: null },
      hr_attendance: { data: [], error: null },
    })
    const r = await backfillApprovedLeave({ clientId: 'c1', period: ASHWIN })
    expect(r).toEqual({ filled: 2, skipped: 0, employees: 1, error: null })
    const [, , rows] = scopedUpsert.mock.calls[0]
    expect(rows).toEqual([
      { employee_id: 'e1', period_id: 'p-ashwin', bs_day: 7, status: 'unpaid_leave' },
      { employee_id: 'e1', period_id: 'p-ashwin', bs_day: 8, status: 'unpaid_leave' },
    ])
  })

  test('a paid type writes paid_leave, and a half-day writes the half status', async () => {
    mockTables({
      hr_leave_requests: {
        data: [{ ...REQ, leave_type_id: 't-sick', end_date: '2026-09-23', day_type: 'first_half' }],
        error: null,
      },
      hr_leave_types: { data: [{ id: 't-sick', paid: true }], error: null },
      hr_attendance: { data: [], error: null },
    })
    const r = await backfillApprovedLeave({ clientId: 'c1', period: ASHWIN })
    expect(r.filled).toBe(1)
    expect(scopedUpsert.mock.calls[0][2][0].status).toBe('half_paid_leave')
  })

  test('a day that already carries an attendance mark is left alone, not overwritten', async () => {
    mockTables({
      hr_leave_requests: { data: [REQ], error: null },
      hr_leave_types: { data: [{ id: 't-unpaid', paid: false }], error: null },
      // Someone marked 7 Ashwin present by hand. A months-old approval must not silently undo it.
      hr_attendance: { data: [{ employee_id: 'e1', bs_day: 7 }], error: null },
    })
    const r = await backfillApprovedLeave({ clientId: 'c1', period: ASHWIN })
    expect(r).toEqual({ filled: 1, skipped: 1, employees: 1, error: null })
    expect(scopedUpsert.mock.calls[0][2]).toEqual([
      { employee_id: 'e1', period_id: 'p-ashwin', bs_day: 8, status: 'unpaid_leave' },
    ])
  })

  test('only the days inside THIS period are written — a leave spanning a month boundary splits', async () => {
    mockTables({
      // 30 Ashwin → 3 Kartik.
      hr_leave_requests: {
        data: [{ ...REQ, start_date: '2026-10-16', end_date: '2026-10-20' }],
        error: null,
      },
      hr_leave_types: { data: [{ id: 't-unpaid', paid: false }], error: null },
      hr_attendance: { data: [], error: null },
    })
    const r = await backfillApprovedLeave({ clientId: 'c1', period: ASHWIN })
    const days = scopedUpsert.mock.calls[0][2].map(x => x.bs_day)
    expect(days).toEqual([30, 31])
    expect(r.filled).toBe(2)
  })

  test('two approved requests covering one day send that day ONCE', async () => {
    // Postgres refuses an upsert that affects a row twice, which would lose the whole month.
    mockTables({
      hr_leave_requests: { data: [REQ, { ...REQ, id: 'r2' }], error: null },
      hr_leave_types: { data: [{ id: 't-unpaid', paid: false }], error: null },
      hr_attendance: { data: [], error: null },
    })
    await backfillApprovedLeave({ clientId: 'c1', period: ASHWIN })
    const keys = scopedUpsert.mock.calls[0][2].map(x => `${x.employee_id}:${x.bs_day}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('a failed read reports the error and writes nothing — it must not read as "no leave"', async () => {
    mockTables({
      hr_leave_requests: { data: null, error: { code: '42501', message: 'permission denied' } },
      hr_leave_types: { data: [], error: null },
      hr_attendance: { data: [], error: null },
    })
    const r = await backfillApprovedLeave({ clientId: 'c1', period: ASHWIN })
    expect(r.error).toMatchObject({ code: '42501' })
    expect(r.filled).toBe(0)
    expect(scopedUpsert).not.toHaveBeenCalled()
  })

  test('a failed write is reported as filled: 0, never as a partial success', async () => {
    mockTables({
      hr_leave_requests: { data: [REQ], error: null },
      hr_leave_types: { data: [{ id: 't-unpaid', paid: false }], error: null },
      hr_attendance: { data: [], error: null },
    })
    scopedUpsert.mockResolvedValue({ data: null, error: { code: '23503', message: 'fk' } })
    const r = await backfillApprovedLeave({ clientId: 'c1', period: ASHWIN })
    expect(r).toEqual({ filled: 0, skipped: 0, employees: 0, error: { code: '23503', message: 'fk' } })
  })

  test('a period with no id or no BS month writes nothing rather than guessing', async () => {
    expect(await backfillApprovedLeave({ clientId: 'c1', period: null }))
      .toEqual({ filled: 0, skipped: 0, employees: 0, error: null })
    expect(scopedFrom).not.toHaveBeenCalled()
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
