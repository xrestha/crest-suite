import { loadSetupSignals } from './setupSignals'
import { supabase } from '../../supabaseClient'

// A chainable stand-in for a supabase-js builder: records every call and resolves, when awaited,
// to whatever `answer(table, calls)` returns — which is how the real builder sends (inside then()).
const log = []
function builder(table, answer) {
  const calls = []
  log.push({ table, calls })
  const b = new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return (ok, fail) => Promise.resolve(answer(table, calls)).then(ok, fail)
      return (...args) => { calls.push([prop, ...args]); return b }
    },
  })
  return b
}

let answer
jest.mock('../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn(), auth: {} } }))

beforeEach(() => {
  log.length = 0
  answer = (table) => (table === 'monthly_periods' ? { data: [], error: null }
    : table === 'clients' ? { data: { pos_enabled: false }, error: null }
    : { count: 1, error: null })
  supabase.from.mockImplementation(table => builder(table, (...a) => answer(...a)))
})

const scopedFrom = (table, ...args) => {
  const b = builder(table, (...a) => answer(...a))
  // what scopedFrom itself chains before handing the builder back
  log[log.length - 1].calls.push(['select', ...args], ['eq', 'client_id', 'c1'])
  return b
}
const menuRead = () => log.find(l => l.table === 'recipes').calls
const run = extra => loadSetupSignals({ needed: new Set(['menuPriced']), clientId: 'c1', scopedFrom, today: { year: 2083, month: 6 }, ...extra })

// S792 (COSTS-17): the setup guide's menu step.
describe('menuPriced', () => {
  test('is_active is read NULL-safe, never .eq(true) on the nullable column', async () => {
    await run({ posOn: true })
    const calls = menuRead()
    expect(calls).toContainEqual(['not', 'is_active', 'is', false])
    expect(calls.some(([m, col]) => m === 'eq' && col === 'is_active')).toBe(false)
  })

  test('a client with a till counts only dishes still on it', async () => {
    const { signals } = await run({ posOn: true })
    expect(menuRead()).toContainEqual(['not', 'pos_enabled', 'is', false])
    expect(signals.menuPriced).toBe(true)
  })

  test('a client without a till ignores the On POS flag, which means nothing there', async () => {
    await run({ posOn: false })
    expect(menuRead().some(([, col]) => col === 'pos_enabled')).toBe(false)
  })

  test('left out, whether the client has POS is read from the client row', async () => {
    await run({})
    expect(log.some(l => l.table === 'clients')).toBe(true)
    expect(menuRead().some(([, col]) => col === 'pos_enabled')).toBe(false)
  })

  test('a failed client read is "couldn\'t check", never a tick or a to-do', async () => {
    const base = answer
    answer = (table, calls) => (table === 'clients' ? { data: null, error: { message: 'boom' } } : base(table, calls))
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const { signals } = await run({})
    spy.mockRestore()
    expect(signals.menuPriced).toBeNull()
    expect(log.some(l => l.table === 'recipes')).toBe(false)
  })
})

// S798 4b, LABOUR-FIGURES-9: one salary no longer ticks "Set each person's pay".
describe('paySet', () => {
  const runPay = () => loadSetupSignals({ needed: new Set(['paySet']), clientId: 'c1', scopedFrom, today: { year: 2083, month: 6 } })
  const payAnswer = (staff, unset) => (table, calls) => (table !== 'hr_employees' ? { count: 0, error: null }
    : calls.some(([m]) => m === 'or') ? unset : staff)

  test('reads staff on payroll only, and counts a blank or zero salary as unset', async () => {
    answer = payAnswer({ count: 12, error: null }, { count: 0, error: null })
    await runPay()
    const reads = log.filter(l => l.table === 'hr_employees').map(l => l.calls)
    expect(reads).toHaveLength(2)
    for (const calls of reads) expect(calls).toContainEqual(['in', 'status', ['active', 'probation']])
    expect(reads.some(calls => calls.some(c => c[0] === 'or' && c[1] === 'basic_salary.is.null,basic_salary.lte.0'))).toBe(true)
  })

  test('eleven of twelve still at zero: not done, and it says how many', async () => {
    answer = payAnswer({ count: 12, error: null }, { count: 11, error: null })
    const { signals } = await runPay()
    expect(signals.paySet).toBe(false)
    expect(signals.payUnset).toBe(11)
  })

  test('everyone paid: done', async () => {
    answer = payAnswer({ count: 12, error: null }, { count: 0, error: null })
    const { signals } = await runPay()
    expect(signals.paySet).toBe(true)
    expect(signals.payUnset).toBe(0)
  })

  test('nobody on payroll yet is not done', async () => {
    answer = payAnswer({ count: 0, error: null }, { count: 0, error: null })
    const { signals } = await runPay()
    expect(signals.paySet).toBe(false)
  })

  test('a failed count is "couldn\'t check", never a tick', async () => {
    answer = payAnswer({ count: 12, error: null }, { count: null, error: { message: 'boom' } })
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const { signals } = await runPay()
    spy.mockRestore()
    expect(signals.paySet).toBeNull()
    expect(signals.payUnset).toBeNull()
  })
})
