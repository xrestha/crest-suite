// The Owner Report's supplier table (S855, owner decision, schema 19): Cash + Credit + FonePay add up
// to each supplier's Net Spend, on Vendor Report's basis (after the allocated bill discount, returns
// at their discounted price, before VAT), through the helper Vendor Report itself reads.
jest.mock('../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }))
jest.mock('../../shared/scopedDb', () => ({ scopedFrom: jest.fn() }))

// eslint-disable-next-line import/first
import { vendorSpendRows } from './computeVendorPurchasingSection'
// eslint-disable-next-line import/first
import { vendorNetBasis, netByMethod } from '../ims/reports/vendorNetBasis'
// eslint-disable-next-line import/first
import { allocateBillDiscounts } from '../ims/reports/supplierAttribution'

const line = over => ({
  id: 'l', vendor_id: 'v1', qty: 1, rate: 0, payment_method: 'Cash', discount_amount: 0,
  purchase_group_id: null, invoice_ref: '', bs_day: 3, vat_inclusive: false, vat_is_cost: false, ...over,
})
const ret = over => ({
  id: 'r', vendor_id: 'v1', qty: 1, rate: 0, purchase_entry_id: null, payment_method: 'Cash',
  purchase_entries: { vat_inclusive: false, vat_is_cost: false }, ...over,
})
const addsUp = r => r.cash + r.credit + r.fonepay

// One supplier: a 10,000 credit bill with a 1,000 discount (two lines), a 5,000 cash bill, and one
// unit of the credit bill sent back (list 1,000, so 900 after the bill discount).
const worked = {
  purchases: [
    line({ id: 'p1', qty: 6, rate: 1000, payment_method: 'Credit', discount_amount: 1000, purchase_group_id: 'b1' }),
    line({ id: 'p2', qty: 4, rate: 1000, payment_method: 'Credit', discount_amount: 1000, purchase_group_id: 'b1' }),
    line({ id: 'p3', qty: 5, rate: 1000, payment_method: 'Cash', purchase_group_id: 'b2' }),
  ],
  returns: [ret({ id: 'r1', qty: 1, rate: 1000, purchase_entry_id: 'p1', payment_method: 'Credit' })],
  priorBillLines: [],
  vendorNameMap: { v1: 'Himalayan Dairy' },
}

describe('vendorSpendRows: the split adds up to Net Spend', () => {
  test('the worked example: Credit is after the discount, so the three add up to Net Spend', () => {
    const out = vendorSpendRows(worked)
    expect(out.vendors).toHaveLength(1)
    const v = out.vendors[0]
    expect(v.name).toBe('Himalayan Dairy')
    expect(v.gross).toBeCloseTo(15000, 6)
    expect(v.discount).toBeCloseTo(1000, 6)
    expect(v.returned).toBeCloseTo(900, 6)
    expect(v.net).toBeCloseTo(13100, 6)
    expect(v.cash).toBeCloseTo(5000, 6)
    // v18 froze 10,000 − 900 = 9,100 here: the list price less the return, so Cash + Credit read
    // 14,100 against a Net Spend of 13,100.
    expect(v.credit).toBeCloseTo(8100, 6)
    expect(v.fonepay).toBeCloseTo(0, 6)
    expect(addsUp(v)).toBeCloseTo(v.net, 6)
    expect(v.billCount).toBe(2)
    expect(out.grandNet).toBeCloseTo(13100, 6)
    expect(out.grandCash + out.grandCredit + out.grandFonepay).toBeCloseTo(out.grandNet, 6)
    expect(out.splitBasis).toBe('net')
    expect(out.unassigned).toBeNull()
  })

  test('the split is the one Vendor Report reads, line for line', () => {
    const basis = vendorNetBasis(worked.purchases, [])
    const allocated = allocateBillDiscounts(worked.purchases)
    for (const a of allocated) expect(basis.lineNetOf(a)).toBeCloseTo(a.lineCost, 9)
    const v = vendorSpendRows(worked).vendors[0]
    const split = netByMethod(worked.purchases, worked.returns, basis)
    expect(v.cash).toBe(split.cash)
    expect(v.credit).toBe(split.credit)
    expect(v.fonepay).toBe(split.fonepay)
  })

  test('a blank method is Cash; a supplier with only a return gets a row; a bill with no supplier is in the totals', () => {
    const out = vendorSpendRows({
      purchases: [
        line({ id: 'a', qty: 2, rate: 500, payment_method: null, discount_amount: 100, purchase_group_id: 'g1' }),
        line({ id: 'b', vendor_id: null, qty: 1, rate: 300, payment_method: 'FonePay', purchase_group_id: 'g2' }),
      ],
      // Against a bill from an earlier month (10 × 100 with a 100 discount, so 90 a unit).
      returns: [ret({ id: 'r', vendor_id: 'v2', qty: 1, rate: 100, purchase_entry_id: 'old', payment_method: 'FonePay' })],
      priorBillLines: [line({ id: 'old', vendor_id: 'v2', qty: 10, rate: 100, discount_amount: 100, purchase_group_id: 'og', period_id: 'p0' })],
      vendorNameMap: { v1: 'A', v2: 'B' },
    })
    const a = out.vendors.find(v => v.vendorId === 'v1')
    const b = out.vendors.find(v => v.vendorId === 'v2')
    expect(a.cash).toBeCloseTo(900, 6)
    expect(addsUp(a)).toBeCloseTo(a.net, 6)
    expect(b.net).toBeCloseTo(-90, 6)
    expect(b.fonepay).toBeCloseTo(-90, 6)
    expect(b.billCount).toBe(0)
    expect(out.unassigned.net).toBeCloseTo(300, 6)
    expect(out.unassigned.fonepay).toBeCloseTo(300, 6)
    expect(out.unassignedTotal).toBeCloseTo(300, 6)
    expect(out.grandNet).toBeCloseTo(900 + 300 - 90, 6)
    expect(out.grandCash + out.grandCredit + out.grandFonepay).toBeCloseTo(out.grandNet, 6)
  })

  test('a VAT line of a vat_is_cost bill is on the cost basis, split included', () => {
    const out = vendorSpendRows({
      purchases: [line({ id: 'v', qty: 1, rate: 1000, payment_method: 'Credit', discount_amount: 100, purchase_group_id: 'g', vat_inclusive: true, vat_is_cost: true })],
      returns: [],
      priorBillLines: [],
    })
    const v = out.vendors[0]
    expect(v.gross).toBeCloseTo(1130, 6)
    expect(v.discount).toBeCloseTo(113, 6)
    expect(v.net).toBeCloseTo(1017, 6)
    expect(v.credit).toBeCloseTo(1017, 6)
  })

  test('a bill whose lines are all free takes no discount, so Net Spend is not negative', () => {
    const out = vendorSpendRows({
      purchases: [line({ id: 'f', qty: 2, rate: 0, discount_amount: 100, purchase_group_id: 'free' })],
      returns: [],
      priorBillLines: [],
    })
    expect(out.vendors[0].discount).toBe(0)
    expect(out.vendors[0].net).toBe(0)
    expect(out.grandNet).toBe(0)
  })
})
