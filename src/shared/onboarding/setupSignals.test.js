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
