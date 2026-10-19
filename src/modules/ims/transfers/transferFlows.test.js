const mockRpc = jest.fn()
const mockFrom = jest.fn()
jest.mock('../../../supabaseClient', () => ({
  supabase: { rpc: (...a) => mockRpc(...a), from: (...a) => mockFrom(...a) },
}))

// eslint-disable-next-line import/first
import {
  TRANSFER_HEADER_SELECT,
  TRANSFER_LINE_SELECT,
  bsDateLabel,
  lineValue,
  planHasProblems,
  problemText,
  qtyParam,
  readIncomingTransfers,
  readPeriodTransfers,
  sendStockTransfer,
  transferNetQtyByItem,
  transferQtyByItem,
  transferTotals,
  transferValueByItem,
} from './transferFlows'

const L = (direction, item_id, qty, rate, extra = {}) => ({
  direction, item_id, qty, rate, value: qty * rate,
  leg: direction === 'out' ? 'sent' : 'received', ...extra,
})

describe('transfer maps', () => {
  it('builds qty and value maps by direction', () => {
    const lines = [L('in', 'a', 2, 100), L('in', 'a', 1, 100), L('out', 'b', 5, 10)]
    expect(transferQtyByItem(lines)).toEqual({ in: { a: 3 }, out: { b: 5 } })
    expect(transferValueByItem(lines)).toEqual({ in: { a: 300 }, out: { b: 50 } })
    expect(transferTotals(lines)).toEqual({ inVal: 300, outVal: 50 })
    expect(transferNetQtyByItem(lines)).toEqual({ a: 3, b: -5 })
  })

  it('nets a cancelled transfer to zero at the sender (sent out, returned in, same rate)', () => {
    const sender = [L('out', 'rice', 10, 95.5), L('in', 'rice', 10, 95.5, { leg: 'returned' })]
    expect(transferNetQtyByItem(sender)).toEqual({ rice: 0 })
    const t = transferTotals(sender)
    expect(t.inVal - t.outVal).toBe(0)
  })

  it('counts received lines only where they are (the receiver), and they cancel the sender in a sum', () => {
    const sender = [L('out', 's-rice', 4, 120)]
    const receiver = [L('in', 'r-rice', 4, 120)]
    expect(transferQtyByItem(receiver)).toEqual({ in: { 'r-rice': 4 }, out: {} })
    const s = transferTotals(sender); const r = transferTotals(receiver)
    expect((s.inVal - s.outVal) + (r.inVal - r.outVal)).toBe(0)
  })

  it('falls back to qty × rate when value is missing, and ignores junk rows', () => {
    expect(lineValue({ qty: '2', rate: '3.5' })).toBe(7)
    expect(lineValue({ qty: 2, rate: 3, value: '6.5' })).toBe(6.5)
    expect(transferTotals([null, { direction: 'sideways', value: 10 }, L('in', null, 1, 1)])).toEqual({ inVal: 1, outVal: 0 })
    expect(transferQtyByItem([L('in', null, 1, 1)])).toEqual({ in: {}, out: {} })
    expect(transferTotals(undefined)).toEqual({ inVal: 0, outVal: 0 })
  })
})

describe('problemText / planHasProblems', () => {
  it('words every per-line problem the dry run can return', () => {
    for (const code of ['not_this_outlet', 'hidden', 'prep', 'qty', 'no_rate', 'no_match', 'ambiguous', 'unit', 'same_item_twice']) {
      expect(problemText(code)).toMatch(/\w/)
      expect(problemText(code)).not.toBe(problemText('something_new'))
    }
    expect(problemText(null)).toBeNull()
    expect(problemText('something_new')).toMatch(/can't be sent/)
  })

  it('treats an empty or missing plan as not sendable', () => {
    expect(planHasProblems(null)).toBe(true)
    expect(planHasProblems({ lines: [] })).toBe(true)
    expect(planHasProblems({ lines: [{ problem: null }, { problem: 'unit' }] })).toBe(true)
    expect(planHasProblems({ lines: [{ problem: null }] })).toBe(false)
  })
})

describe('bsDateLabel', () => {
  it('names the month', () => {
    expect(bsDateLabel(2083, 5, 12)).toMatch(/^12 \S+ 2083$/)
    expect(bsDateLabel(2083, 5)).toMatch(/^\S+ 2083$/)
    expect(bsDateLabel(null, 5, 1)).toBe('—')
  })
})

function builder(result, calls) {
  const b = {}
  for (const m of ['select', 'eq', 'in', 'order']) b[m] = (...a) => { calls.push([m, ...a]); return b }
  b.range = (...a) => { calls.push(['range', ...a]); return Promise.resolve(result) }
  return b
}

describe('readPeriodTransfers', () => {
  it('reads one period with .eq, ordered on id', async () => {
    const calls = []
    const scopedFrom = jest.fn((t, c) => { calls.push(['from', t, c]); return builder({ data: [{ id: 1 }], error: null }, calls) })
    const r = await readPeriodTransfers(scopedFrom, 'p1')
    expect(r).toEqual({ data: [{ id: 1 }], error: null })
    expect(calls).toEqual(expect.arrayContaining([
      ['from', 'ims_stock_transfer_lines', TRANSFER_LINE_SELECT], ['eq', 'period_id', 'p1'], ['order', 'id'],
    ]))
  })

  it('reads a window with .in', async () => {
    const calls = []
    const scopedFrom = () => builder({ data: [], error: null }, calls)
    await readPeriodTransfers(scopedFrom, ['p1', 'p2'])
    expect(calls).toEqual(expect.arrayContaining([['in', 'period_id', ['p1', 'p2']], ['order', 'id']]))
  })

  it('returns [] without a read for no periods, and an error (never throws) on a failure', async () => {
    const scopedFrom = jest.fn()
    expect(await readPeriodTransfers(scopedFrom, [])).toEqual({ data: [], error: null })
    expect(scopedFrom).not.toHaveBeenCalled()
    const err = { message: 'x' }
    expect(await readPeriodTransfers(() => builder({ data: null, error: err }, []), 'p1')).toEqual({ data: null, error: err })
    const thrown = await readPeriodTransfers(() => { throw new Error('not in CLIENT_SCOPED_TABLES') }, 'p1')
    expect(thrown.data).toBeNull()
    expect(thrown.error.message).toMatch(/CLIENT_SCOPED_TABLES/)
  })
})

describe('readIncomingTransfers', () => {
  beforeEach(() => mockFrom.mockReset())

  it('fails closed without a clientId', async () => {
    const r = await readIncomingTransfers(null)
    expect(r.data).toBeNull()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('reads by to_client_id, oldest first, on id', async () => {
    const calls = []
    mockFrom.mockImplementation(t => { calls.push(['from', t]); return builder({ data: [], error: null }, calls) })
    await readIncomingTransfers('c-2', { statuses: ['on_the_way'] })
    expect(calls).toEqual(expect.arrayContaining([
      ['from', 'ims_stock_transfers'], ['select', TRANSFER_HEADER_SELECT], ['eq', 'to_client_id', 'c-2'],
      ['in', 'status', ['on_the_way']], ['order', 'sent_at'], ['order', 'id'],
    ]))
  })
})

describe('qtyParam', () => {
  it('writes a plain decimal of at most 6 places', () => {
    expect(qtyParam(0.1 + 0.2)).toBe('0.3')
    expect(qtyParam(5)).toBe('5')
    expect(qtyParam(1.23456789)).toBe('1.234568')
    expect(qtyParam(1e-7)).toBe('0')
    expect(qtyParam(1200)).toBe('1200')
    expect(qtyParam('abc')).toBe('')
  })
})

describe('sendStockTransfer', () => {
  it('passes the exact RPC arguments, quantities as strings', () => {
    mockRpc.mockReturnValue('p')
    sendStockTransfer({ transferId: 't', fromClientId: 'a', toClientId: 'b', lines: [{ item_id: 'i', qty: 2.5, prep_label: 'from 5 kg Momo filling' }, { item_id: 'j', qty: 1 }], note: 'hi', dryRun: true })
    expect(mockRpc).toHaveBeenCalledWith('send_stock_transfer', {
      p_transfer_id: 't', p_from_client_id: 'a', p_to_client_id: 'b',
      p_lines: [{ item_id: 'i', qty: '2.5', prep_label: 'from 5 kg Momo filling' }, { item_id: 'j', qty: '1' }],
      p_note: 'hi', p_dry_run: true,
    })
  })
})
