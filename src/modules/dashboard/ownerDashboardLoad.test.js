// The Owner Dashboard's read ORDER (S853, OWNER-DASHBOARD-9): what starts in the same tick as the month
// read, and that the month's sales pages after the first go out together. Round trips are the cost on a
// slow link, and nothing else in the suite would notice one coming back.
import fs from 'fs'
import path from 'path'
import { startFirstWave, startMonthBatch, RETURN_COLS, SALES_COLS } from './ownerDashboardLoad'
import { loadOutletLabour } from './loadOutletLabour'
import { loadOverdueCreditBills } from './ownerDashboardData'
import { bsToAd } from '../../utils/bsCalendar'

jest.mock('../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }))

// A builder that records each read and answers `.range()` (the pagers) and a bare await alike.
// `answer(call, from, to)` returns the response (or a promise of it) for one request.
function recorder(answer) {
  const calls = []
  const from = (table, columns) => {
    const call = { table, columns, selectOptions: [], filters: [], ranges: [] }
    calls.push(call)
    const b = {
      select: (cols, opts) => { call.columns = cols; call.selectOptions.push(opts); return b },
      eq: (c, v) => { call.filters.push(['eq', c, v]); return b },
      in: (c, v) => { call.filters.push(['in', c, v]); return b },
      is: (c, v) => { call.filters.push(['is', c, v]); return b },
      lte: (c, v) => { call.filters.push(['lte', c, v]); return b },
      order: () => b,
      limit: () => b,
      range: (f, t) => { call.ranges.push([f, t]); return Promise.resolve(answer(call, f, t)) },
      then: (res, rej) => Promise.resolve(answer(call, null, null)).then(res, rej),
    }
    return b
  }
  return { calls, from }
}

const empty = () => ({ data: [], error: null })
const identity = p => p
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('startFirstWave', () => {
  test('the month read, the recipe book and the HR staff reads start in the same tick', async () => {
    const { calls, from } = recorder(empty)
    const first = startFirstWave({ scopedFrom: from, read: identity })
    // Nothing has been awaited yet: every one of these was asked for synchronously.
    expect(calls.map(c => c.table).sort()).toEqual(['hr_employees', 'hr_salary_components', 'monthly_periods', 'recipes'])
    expect(await first.months).toEqual({ data: [], error: null })
    expect(await first.masters).toEqual({ employees: [], components: [], error: null })
    await first.book
  })

  test('a failed recipe book is not an unhandled rejection; the reorder section reports it', async () => {
    const { from } = recorder(call => (call.table === 'recipes' ? { data: null, error: { message: 'book down' } } : empty()))
    const first = startFirstWave({ scopedFrom: from, read: identity })
    await flush()
    await expect(first.book).rejects.toBeTruthy()
  })
})

describe('startMonthBatch', () => {
  const PID = 'p7'

  test('the sales pages after page 1 are requested together, page 1 asking for the count', async () => {
    const held = []
    const sales = Array.from({ length: 2500 }, (_, i) => ({ recipe_id: 'r', qty_sold: 1, unit_price: 100, bs_day: 1 + (i % 20), n: i }))
    const supa = recorder((call, f, t) => {
      if (call.table !== 'sales_entries') return empty()
      const page = { data: sales.slice(f, t + 1), error: null, count: call.selectOptions[0]?.count === 'exact' ? sales.length : null }
      if (f === 0) return page
      return new Promise(resolve => held.push(() => resolve(page)))
    })
    const scoped = recorder(empty)
    const batch = startMonthBatch({ supabase: supa, scopedFrom: scoped.from, read: identity, periodId: PID, wantIms: true, wantReorder: true })
    await flush()
    const salesCalls = supa.calls.filter(c => c.table === 'sales_entries')
    expect(salesCalls[0].columns).toBe(SALES_COLS)
    expect(salesCalls[0].selectOptions[0]).toEqual({ count: 'exact' })
    expect(salesCalls[0].filters).toContainEqual(['eq', 'period_id', PID])
    // Both later pages are in flight before either has answered.
    expect(salesCalls.flatMap(c => c.ranges)).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
    expect(held).toHaveLength(2)
    held.forEach(release => release())
    const res = await batch.sales
    expect(res.error).toBeNull()
    expect(res.data.map(r => r.n)).toEqual(sales.map(r => r.n))
  })

  test('the earlier-month bills are read as soon as the returns land, without waiting for the purchases', async () => {
    let releasePurchases
    const supa = recorder(call => (call.table === 'purchase_entries'
      ? new Promise(resolve => { releasePurchases = () => resolve(empty()) })
      : empty()))
    const returns = [
      { purchase_entry_id: 'old1', qty: 2, rate: 1000, purchase_entries: { vat_inclusive: true, vat_is_cost: false, period_id: 'p6' } },
      { purchase_entry_id: 'here1', qty: 1, rate: 500, purchase_entries: { vat_inclusive: false, vat_is_cost: false, period_id: PID } },
      { purchase_entry_id: null, qty: 1, rate: 10, purchase_entries: null },
    ]
    const scoped = recorder(call => (call.table === 'vendor_returns' ? { data: returns, error: null } : empty()))
    const asked = []
    const lines = [{ id: 'old1', period_id: 'p6' }]
    const readPrior = ids => { asked.push(ids); return Promise.resolve({ data: lines, error: null }) }
    const batch = startMonthBatch({ supabase: supa, scopedFrom: scoped.from, read: identity, periodId: PID, wantIms: true, wantReorder: false, readPrior })
    let purchasesLanded = false
    batch.purchases.then(() => { purchasesLanded = true })
    await flush()
    // Only the line from an earlier month, asked for while the purchases are still out.
    expect(asked).toEqual([['old1']])
    expect(purchasesLanded).toBe(false)
    expect(await batch.priorBills).toEqual({ data: lines, error: null })
    releasePurchases()
    await batch.purchases
    expect(purchasesLanded).toBe(true)
    // The returns read carries the embed the earlier-bill test needs.
    expect(scoped.calls.find(c => c.table === 'vendor_returns').columns).toBe(RETURN_COLS)
    expect(RETURN_COLS).toMatch(/purchase_entries\(vat_inclusive, vat_is_cost, period_id\)/)
  })

  test('no return against an earlier bill: no read; a failed one is an error the IMS section fails on', async () => {
    const asked = []
    const readPrior = ids => { asked.push(ids); return Promise.resolve({ data: null, error: { message: 'bills down' } }) }
    const sameMonth = recorder(call => (call.table === 'vendor_returns'
      ? { data: [{ purchase_entry_id: 'here1', qty: 1, rate: 5, purchase_entries: { period_id: PID } }], error: null }
      : empty()))
    const none = startMonthBatch({ supabase: recorder(empty), scopedFrom: sameMonth.from, read: identity, periodId: PID, wantIms: true, wantReorder: false, readPrior })
    expect(await none.priorBills).toEqual({ data: [], error: null })
    expect(asked).toEqual([])

    const earlier = recorder(call => (call.table === 'vendor_returns'
      ? { data: [{ purchase_entry_id: 'old1', qty: 1, rate: 5, purchase_entries: { period_id: 'p6' } }], error: null }
      : empty()))
    const failed = startMonthBatch({ supabase: recorder(empty), scopedFrom: earlier.from, read: identity, periodId: PID, wantIms: true, wantReorder: false, readPrior })
    expect((await failed.priorBills).error).toEqual({ message: 'bills down' })
  })

  test('a section that is not wanted makes none of its reads', async () => {
    const supa = recorder(empty)
    const scoped = recorder(empty)
    const asked = []
    const reorderOnly = startMonthBatch({
      supabase: supa, scopedFrom: scoped.from, read: identity, periodId: PID, wantIms: false, wantReorder: true,
      readPrior: ids => { asked.push(ids); return Promise.resolve(empty()) },
    })
    await Promise.all(Object.values(reorderOnly))
    const tables = [...supa.calls, ...scoped.calls].map(c => c.table)
    expect(tables).not.toContain('overheads')
    expect(tables).toEqual(expect.arrayContaining(['opening_stock', 'closing_stock', 'items', 'par_levels', 'staff_meals']))
    expect(asked).toEqual([])

    const supa2 = recorder(empty)
    const scoped2 = recorder(empty)
    const imsOnly = startMonthBatch({ supabase: supa2, scopedFrom: scoped2.from, read: identity, periodId: PID, wantIms: true, wantReorder: false })
    await Promise.all(Object.values(imsOnly))
    const tables2 = [...supa2.calls, ...scoped2.calls].map(c => c.table)
    expect(tables2).toContain('overheads')
    for (const t of ['opening_stock', 'closing_stock', 'items', 'par_levels', 'staff_meals']) expect(tables2).not.toContain(t)
  })
})

// S859: the two tiles that still paid a third round trip. Labour read the finalized run and only then its
// payslips; Overdue Payables read the unpaid lines, then their bills' other lines, then the payments and
// returns. Each is now one round trip after what it needs: the month for labour, the unpaid lines for
// payables. A test holds every answer and checks what was already asked for.
describe('labour and Overdue Payables, one round trip after their inputs (S859)', () => {
  const KARTIK = { id: 'p7', bs_year: 2083, bs_month: 7 }

  // `answerOf(call)` is the response; while `holding`, every request but those `passes(call)` lets
  // through waits in `held` until released.
  function holdingRecorder(answerOf, passes = () => false) {
    const state = { holding: true, held: [] }
    const rec = recorder(call => {
      if (!state.holding || passes(call)) return answerOf(call)
      return new Promise(resolve => state.held.push(() => resolve(answerOf(call))))
    })
    const release = () => { state.holding = false; state.held.splice(0).forEach(r => r()) }
    return { ...rec, state, release }
  }

  test('labour: every read is asked for at once, the payslips inside the finalized run read', async () => {
    const run = { id: 'run1', hr_payslips: [{ gross: '30000', absence_deduction: '0', ot_amount: '500', ssf_employer: '0' }] }
    const rec = holdingRecorder(call => (call.table === 'hr_payroll_runs' ? { data: [run], error: null } : empty()))
    // The staff reads come from startFirstWave, beside the month read.
    const masters = Promise.resolve({ employees: [], components: [], error: null })
    const done = loadOutletLabour(rec.from, { period: KARTIK, hrOn: true, masters })
    await flush()
    const asked = rec.calls.map(c => c.table)
    expect(asked).toEqual(expect.arrayContaining(['hr_payroll_runs', 'hr_overtime_entries', 'hr_attendance', 'hr_final_settlements', 'hr_festival_allowances', 'hr_incentives']))
    expect(asked).not.toContain('hr_payslips')
    expect(rec.state.held).toHaveLength(asked.length)
    rec.release()
    const { labour } = await done
    // Nothing was asked for after an answer came back.
    expect(rec.calls.map(c => c.table)).toEqual(asked)
    expect(labour).toMatchObject({ source: 'payroll', amount: 30500 })
  })

  test('Overdue Payables: once the unpaid lines land, the bill lines, payments and returns go out together', async () => {
    const line = {
      id: 'l1', created_at: '2026-06-10T00:00:00Z', bs_day: 1, qty: 1, rate: 10000, vat_inclusive: false, discount_amount: 0,
      purchase_group_id: 'bill-1', vendor_id: 'v', invoice_ref: 'INV-9', paid_at: null, monthly_periods: { client_id: 'c', bs_year: 2083, bs_month: 3 },
    }
    const isSeed = call => call.table === 'purchase_entries' && !call.filters.some(f => f[0] === 'in')
    const rec = holdingRecorder(call => (call.table === 'purchase_entries' ? { data: [line], error: null } : empty()), isSeed)
    const today = new Date(bsToAd(2083, 3, 1).getTime() + 100 * 86400000)
    const done = loadOverdueCreditBills({ supabase: rec, scopedFrom: rec.from, clientId: 'c', today })
    await flush()
    // The unpaid lines answered; the three reads that complete the bills are all in flight together.
    expect(rec.calls.map(c => c.table).sort()).toEqual(['payable_payments', 'purchase_entries', 'purchase_entries', 'vendor_returns'])
    expect(rec.state.held).toHaveLength(3)
    rec.release()
    expect(await done).toEqual({ overdueTotal: 10000, overdueCount: 1, error: null })
    expect(rec.calls).toHaveLength(4)
  })

  test('the option stock lines take the recipe book from memory when it covers them (no read of their own)', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'pages', 'dashboard', 'OwnerDashboard.jsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ').replace(/\s+/g, ' ')
    expect(page).toMatch(/loadDeltaExplosion\(supabase, deltaLists, bookCoversDeltas\(book, deltaLists\) \? \{ book \} : \{\}\)/)
  })
})
