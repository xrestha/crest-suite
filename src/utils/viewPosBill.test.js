// viewPosBill costs a past Complimentary Slip by what the bill holds, never by today's
// Customization switch (S877, owner decision): a comped dish marked build-your-own is costed by its
// build whatever the switch says now, and only the Inventory switch decides whether choices are costed.

const mockTables = {}
const mockSelects = []
function mockBuilder(table, columns) {
  mockSelects.push({ table, columns })
  const result = mockTables[table] || { data: null, error: null }
  const b = {
    select: cols => { mockSelects.push({ table, columns: cols }); return b },
    eq: () => b, in: () => b, order: () => b, single: () => b, maybeSingle: () => b,
    then: (ok, err) => Promise.resolve(result).then(ok, err),
  }
  return b
}

jest.mock('../supabaseClient', () => ({ supabase: { from: t => mockBuilder(t) } }))
jest.mock('../shared/scopedDb', () => ({ scopedFrom: (t, _c, cols) => mockBuilder(t, cols) }))
jest.mock('../modules/pos/orders/posOrderPrintHtml', () => ({
  buildBillHtml: jest.fn(() => '<p>bill</p>'),
  buildCompSlipHtml: jest.fn(() => '<p>slip</p>'),
  withChoices: l => l,
}))
jest.mock('../modules/pos/orders/posRecipeBook', () => ({
  posLineCosts: jest.fn(async () => ({ costOf: () => 120 })),
  buildYourOwnAmong: jest.fn(async () => ['bowl']),
  LINE_CHOICE_BILL: 'pos_order_item_options(option_name, price_delta, sort, ingredient_deltas)',
}))
jest.mock('../modules/pos/orders/billReprintData', () => ({
  readHscMap: async () => ({ map: {}, error: null }),
  staffNameFor: async () => ({ name: 'Sita', error: null }),
  REPRINT_READ_MS: 20000,
}))

const { viewPosBill } = require('./viewPosBill')
const { posLineCosts, buildYourOwnAmong } = require('../modules/pos/orders/posRecipeBook')
const { buildCompSlipHtml, buildBillHtml } = require('../modules/pos/orders/posOrderPrintHtml')

const LINES = [
  { id: 'l1', recipe_id: 'bowl', qty: 1, pos_order_item_options: [{ option_name: 'Granola', ingredient_deltas: [] }] },
  { id: 'l2', recipe_id: 'momo', qty: 2, pos_order_item_options: [] },
]

function fakeWindow() {
  return { document: { open: jest.fn(), write: jest.fn(), close: jest.fn() } }
}

beforeEach(() => {
  jest.clearAllMocks()
  // CRA resets mock implementations before each test, so they are set here.
  posLineCosts.mockImplementation(async () => ({ costOf: () => 120 }))
  buildYourOwnAmong.mockImplementation(async () => ['bowl'])
  buildCompSlipHtml.mockImplementation(() => '<p>slip</p>')
  buildBillHtml.mockImplementation(() => '<p>bill</p>')
  mockSelects.length = 0
  mockTables.pos_orders = { data: { id: 'o1', close_type: 'writeoff', closed_by: 'u1', table_name: 'T1' }, error: null }
  mockTables.settings = { data: { is_vat_registered: true }, error: null }
  mockTables.pos_order_items = { data: LINES, error: null }
})

describe('viewPosBill: a past slip is costed by the bill, not by the Customization switch of today (S877)', () => {
  test('with Customization off today, a build-your-own comp is still costed by its build', async () => {
    mockTables.clients = { data: { name: 'Cafe', ims_enabled: true, pos_enabled: true, customization_enabled: false }, error: null }
    const w = fakeWindow()
    window.open = jest.fn(() => w)
    await viewPosBill('c1', { id: 'o1' })
    expect(buildYourOwnAmong).toHaveBeenCalledTimes(1)
    expect(buildYourOwnAmong.mock.calls[0][1]).toEqual(['bowl', 'momo'])
    expect(posLineCosts).toHaveBeenCalledTimes(1)
    const opts = posLineCosts.mock.calls[0][3]
    expect(opts.inventory).toBe(true)
    await expect(opts.buildYourOwn).resolves.toEqual(['bowl'])
    expect(buildCompSlipHtml).toHaveBeenCalledTimes(1)
    expect(w.document.write).toHaveBeenLastCalledWith('<p>slip</p>')
  })

  test('the outlet read no longer asks for the Customization switch', async () => {
    mockTables.clients = { data: { name: 'Cafe', ims_enabled: true }, error: null }
    window.open = jest.fn(() => fakeWindow())
    await viewPosBill('c1', { id: 'o1' })
    const clientSelect = mockSelects.find(s => s.table === 'clients' && s.columns)
    expect(clientSelect.columns).not.toMatch(/customization_enabled/)
    expect(buildYourOwnAmong).toHaveBeenCalledTimes(1)
  })

  test('without Inventory no dish is costed by its build, and the marks are not read', async () => {
    mockTables.clients = { data: { name: 'Cafe', ims_enabled: false }, error: null }
    window.open = jest.fn(() => fakeWindow())
    await viewPosBill('c1', { id: 'o1' })
    expect(buildYourOwnAmong).not.toHaveBeenCalled()
    const opts = posLineCosts.mock.calls[0][3]
    expect(opts.inventory).toBe(false)
    expect(opts.buildYourOwn).toEqual([])
  })

  test('a refused mark read is a failed slip, never one costed at the typed Cost Price', async () => {
    mockTables.clients = { data: { name: 'Cafe', ims_enabled: true }, error: null }
    buildYourOwnAmong.mockImplementationOnce(async () => { throw Object.assign(new Error('denied'), { code: '42501' }) })
    posLineCosts.mockImplementationOnce(async (_s, _c, _l, { buildYourOwn }) => { await buildYourOwn; return { costOf: () => 0 } })
    const w = fakeWindow()
    window.open = jest.fn(() => w)
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    await viewPosBill('c1', { id: 'o1' })
    spy.mockRestore()
    expect(buildCompSlipHtml).not.toHaveBeenCalled()
    expect(w.document.write.mock.calls.at(-1)[0]).toMatch(/load this bill/)
  })
})
