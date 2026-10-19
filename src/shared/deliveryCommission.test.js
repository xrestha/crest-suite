import {
  DELIVERY_COMMISSION_SELECT,
  bsMonthWindow,
  deliveryCommissionFromBills,
  loadDeliveryCommission,
} from './deliveryCommission'
import { bsDayBoundaryIso } from '../utils/bsCalendar'

const line = (commission, cancelled = false) => ({
  commission,
  pos_credit_receipts: { cancelled_at: cancelled ? '2026-09-01T10:00:00Z' : null },
})
const bill = over => ({
  id: 'b', closed_at: '2026-09-01T10:00:00+05:45',
  credit_settled_at: '2026-09-05T10:00:00Z', credit_note_id: null,
  commission_amount: null, pos_credit_receipt_lines: [],
  ...over,
})

describe('deliveryCommissionFromBills', () => {
  it('lets receipt lines win over commission_amount', () => {
    const r = deliveryCommissionFromBills([bill({ commission_amount: 999, pos_credit_receipt_lines: [line(120), line(30)] })])
    expect(r.amount).toBe(150)
  })

  it('does not count a cancelled receipt\'s line', () => {
    const r = deliveryCommissionFromBills([bill({ pos_credit_receipt_lines: [line(120), line(80, true)] })])
    expect(r.amount).toBe(120)
  })

  it('counts 0 for a bill whose receipt lines are all cancelled (not its commission_amount)', () => {
    const r = deliveryCommissionFromBills([bill({ commission_amount: 200, pos_credit_receipt_lines: [line(200, true)] })])
    expect(r.amount).toBe(0)
  })

  it('reads commission_amount for a legacy bill with no receipt line', () => {
    const r = deliveryCommissionFromBills([bill({ commission_amount: '75.50' }), bill({ commission_amount: null })])
    expect(r.amount).toBe(75.5)
  })

  it('counts a part-paid bill\'s kept commission and calls it unsettled', () => {
    const r = deliveryCommissionFromBills([bill({ credit_settled_at: null, pos_credit_receipt_lines: [line(40)] })])
    expect(r).toEqual({ amount: 40, unsettledBills: 1 })
  })

  it('does not call a credited, unsettled bill "unsettled"', () => {
    const r = deliveryCommissionFromBills([bill({ credit_settled_at: null, credit_note_id: 'cn-1' })])
    expect(r.unsettledBills).toBe(0)
  })

  it('sums in paisa (no float drift)', () => {
    const bills = Array.from({ length: 10 }, () => bill({ commission_amount: 0.1 }))
    expect(deliveryCommissionFromBills(bills).amount).toBe(1)
    expect(deliveryCommissionFromBills([bill({ pos_credit_receipt_lines: [line(0.1), line(0.2)] })]).amount).toBe(0.3)
  })

  it('tolerates an array-shaped receipt embed', () => {
    const r = deliveryCommissionFromBills([bill({ pos_credit_receipt_lines: [{ commission: 50, pos_credit_receipts: [{ cancelled_at: 'x' }] }] })])
    expect(r.amount).toBe(0)
  })

  it('is zero for no bills', () => {
    expect(deliveryCommissionFromBills([])).toEqual({ amount: 0, unsettledBills: 0 })
    expect(deliveryCommissionFromBills(null)).toEqual({ amount: 0, unsettledBills: 0 })
  })
})

describe('bsMonthWindow', () => {
  it('is [day 1, next month day 1) at Nepal midnight', () => {
    const w = bsMonthWindow(2083, 5)
    expect(w.startIso).toBe(bsDayBoundaryIso(2083, 5, 1, false))
    expect(w.endIso).toBe(bsDayBoundaryIso(2083, 6, 1, false))
    expect(w.startIso).toMatch(/T00:00:00\.000\+05:45$/)
  })

  it('rolls Chaitra 2083 into Baisakh 2084', () => {
    const w = bsMonthWindow(2083, 12)
    expect(w.endIso).toBe(bsDayBoundaryIso(2084, 1, 1, false))
  })

  it('returns nulls for a bad month', () => {
    expect(bsMonthWindow(2083, 13)).toEqual({ startIso: null, endIso: null })
  })
})

// A chainable fake of a PostgREST builder: records each call, resolves on .range().
function fakeDb(result) {
  const calls = []
  const make = () => {
    const b = {}
    for (const m of ['not', 'eq', 'gte', 'lt', 'order', 'in']) {
      b[m] = (...args) => { calls.push([m, ...args]); return b }
    }
    b.range = (...args) => { calls.push(['range', ...args]); return Promise.resolve(result) }
    return b
  }
  return {
    calls,
    scopedFrom: jest.fn((table, cols) => { calls.push(['from', table, cols]); return make() }),
  }
}

describe('loadDeliveryCommission', () => {
  const win = bsMonthWindow(2083, 5)

  it('reads delivery bills billed + paid in the window, paged on id', async () => {
    const db = fakeDb({ data: [bill({ commission_amount: 10, credit_settled_at: null })], error: null })
    const r = await loadDeliveryCommission(db, win)
    expect(r).toEqual({ amount: 10, unsettledBills: 1, error: null })
    expect(db.calls).toEqual(expect.arrayContaining([
      ['from', 'pos_orders', DELIVERY_COMMISSION_SELECT],
      ['not', 'delivery_partner', 'is', null],
      ['eq', 'status', 'billed'],
      ['eq', 'close_type', 'paid'],
      ['gte', 'closed_at', win.startIso],
      ['lt', 'closed_at', win.endIso],
      ['order', 'id'],
    ]))
  })

  it('refuses the figure on a failed read (never "no commission")', async () => {
    const err = { message: 'boom' }
    const r = await loadDeliveryCommission(fakeDb({ data: null, error: err }), win)
    expect(r).toEqual({ amount: null, unsettledBills: null, error: err })
  })

  it('never throws, even when the builder does', async () => {
    const db = { scopedFrom: () => { throw new Error('not scoped') } }
    const r = await loadDeliveryCommission(db, win)
    expect(r.amount).toBeNull()
    expect(r.error.message).toBe('not scoped')
  })

  it('gives an IMS-only client 0 without a read', async () => {
    const db = fakeDb({ data: [], error: null })
    expect(await loadDeliveryCommission(db, { ...win, posEnabled: false })).toEqual({ amount: 0, unsettledBills: 0, error: null })
    expect(db.scopedFrom).not.toHaveBeenCalled()
  })

  it('is an error, not zero, with no window', async () => {
    const r = await loadDeliveryCommission(fakeDb({ data: [], error: null }), {})
    expect(r.amount).toBeNull()
    expect(r.error).toBeTruthy()
  })

  it('is zero (not an error) for an outlet with no delivery bills', async () => {
    expect(await loadDeliveryCommission(fakeDb({ data: [], error: null }), win)).toEqual({ amount: 0, unsettledBills: 0, error: null })
  })
})
