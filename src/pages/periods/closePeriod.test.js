// closePeriod.js imports supabaseClient (createClient at module load) and scopedDb; both are
// mocked so the suite runs in a plain checkout, the same way persistSalesDay.test.js does it.
jest.mock('../../supabaseClient', () => ({ supabase: { from: jest.fn() } }))
jest.mock('../../shared/scopedDb', () => ({
  scopedFrom: jest.fn(), scopedInsert: jest.fn(), scopedUpdate: jest.fn(),
}))
jest.mock('../../modules/ownerReport/generateMonthlyReport', () => ({
  generateMonthlyReport: jest.fn(), saveGeneratedReport: jest.fn(),
}))

import { supabase } from '../../supabaseClient'
import { scopedFrom, scopedInsert, scopedUpdate } from '../../shared/scopedDb'
import { generateMonthlyReport, saveGeneratedReport } from '../../modules/ownerReport/generateMonthlyReport'
import { performPeriodClose, closeFailureText, payrollNote, nextBsMonth } from './closePeriod'

const PERIOD = { id: 'p-bhadra', bs_year: 2083, bs_month: 5 }

// A chainable, thenable stand-in for a PostgrestBuilder that resolves to `result`.
function builder(result) {
  const b = {
    eq: () => b, not: () => b, select: () => b, maybeSingle: () => b,
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

describe('performPeriodClose', () => {
  test('the happy path closes, opens the next month, carries forward and mints the report', async () => {
    supabase.from.mockReturnValue({
      select: () => builder({ data: [{ item_id: 'i1', physical_qty: 4 }, { item_id: 'i2', physical_qty: null }], error: null }),
      upsert: jest.fn(() => builder({ error: null })),
    })
    const r = await performPeriodClose({ clientId: 'c1', period: PERIOD, actorId: 'u1' })
    expect(r).toEqual({ closed: true, nextPeriodId: 'p-ashwin', reportSaved: true, failures: [] })
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

  test('a failed report never blocks the close, and is not reported as saved', async () => {
    generateMonthlyReport.mockRejectedValue(new Error('boom'))
    const r = await performPeriodClose({ clientId: 'c1', period: PERIOD })
    expect(r.closed).toBe(true)
    expect(r.reportSaved).toBe(false)
    expect(r.failures.map(f => f.stage)).toEqual(['report'])
  })

  test('openNext:false (admin End Period) opens nothing and carries nothing', async () => {
    const r = await performPeriodClose({ clientId: 'c1', period: PERIOD, openNext: false })
    expect(r).toEqual({ closed: true, nextPeriodId: null, reportSaved: true, failures: [] })
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
    expect(closeFailureText({ stage: 'open_next', period: PERIOD, isAdmin: true })).toMatch(/Create Period.*Resync Opening Stock/)
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
