import { unpaidCreditBills, unpaidCreditTotals, paidByEntryOf, returnedByEntryOf } from './unpaidCreditBills'

const line = over => ({
  id: 'l1', qty: 1, rate: 0, vat_inclusive: false, discount_amount: 0, payment_method: 'Credit',
  purchase_group_id: 'bill-1', vendor_id: 'v1', invoice_ref: 'INV-1', bs_day: 3, ...over,
})

describe('unpaid credit is what is still owed on each bill (S849, OWNER-REPORT-8)', () => {
  test('40,000 less a 2,000 discount, paid 38,000: nothing owed', () => {
    const lines = [line({ id: 'a', qty: 1, rate: 25000, discount_amount: 2000 }), line({ id: 'b', qty: 1, rate: 15000, discount_amount: 2000 })]
    const bills = unpaidCreditBills({ lines, paidByEntry: paidByEntryOf([{ purchase_entry_id: 'a', amount: 23750 }, { purchase_entry_id: 'b', amount: 14250 }]) })
    expect(bills).toHaveLength(1)
    expect(bills[0]).toMatchObject({ key: 'bill-1', owed: 38000, paid: 38000, remaining: 0 })
    expect(unpaidCreditTotals(bills)).toEqual({ unpaidTotal: 0, unpaidCount: 0 })
  })

  test('a VAT bill of 40,000 (45,200 with VAT) paid 22,600: 22,600 owed', () => {
    const lines = [line({ id: 'v', qty: 4, rate: 10000, vat_inclusive: true, purchase_group_id: 'bill-2' })]
    const bills = unpaidCreditBills({ lines, paidByEntry: { v: 22600 } })
    expect(bills[0]).toMatchObject({ owed: 45200, paid: 22600, remaining: 22600 })
    expect(unpaidCreditTotals(bills)).toEqual({ unpaidTotal: 22600, unpaidCount: 1 })
  })

  test('5,000 returned and the bill settled net of it: nothing owed', () => {
    const lines = [line({ id: 'r1', qty: 1, rate: 15000, purchase_group_id: 'bill-3' }), line({ id: 'r2', qty: 1, rate: 5000, purchase_group_id: 'bill-3' })]
    const returnedByEntry = returnedByEntryOf([{ purchase_entry_id: 'r2', qty: 1, rate: 5000 }])
    const bills = unpaidCreditBills({ lines, returnedByEntry, paidByEntry: { r1: 15000 } })
    expect(bills[0]).toMatchObject({ owed: 15000, paid: 15000, remaining: 0 })
    expect(unpaidCreditTotals(bills).unpaidCount).toBe(0)
  })

  test('counts BILLS, not lines, and leaves cash bills and over-paid bills out', () => {
    const lines = [
      line({ id: 'x1', rate: 1000, purchase_group_id: 'B1' }), line({ id: 'x2', rate: 2000, purchase_group_id: 'B1' }),
      line({ id: 'y1', rate: 500, purchase_group_id: 'B2' }),
      line({ id: 'c1', rate: 9999, payment_method: 'Cash', purchase_group_id: 'B3' }),
      // Paid in full, then goods sent back: the supplier owes us — not "unpaid".
      line({ id: 'z1', rate: 1000, purchase_group_id: 'B4' }),
    ]
    const bills = unpaidCreditBills({
      lines,
      returnedByEntry: { z1: 400 },
      paidByEntry: { y1: 100, z1: 1000 },
    })
    expect(bills.map(b => b.key).sort()).toEqual(['B1', 'B2', 'B4'])
    expect(bills.find(b => b.key === 'B4').remaining).toBe(-400)
    expect(unpaidCreditTotals(bills)).toEqual({ unpaidTotal: 3000 + 400, unpaidCount: 2 })
  })

  test('a bill with no purchase_group_id is keyed by vendor, invoice and day', () => {
    const lines = [line({ id: 'p', rate: 300, purchase_group_id: null }), line({ id: 'q', rate: 200, purchase_group_id: null })]
    expect(unpaidCreditBills({ lines })).toHaveLength(1)
  })

  test('empty input is empty, not NaN', () => {
    expect(unpaidCreditBills({ lines: null })).toEqual([])
    expect(unpaidCreditTotals([])).toEqual({ unpaidTotal: 0, unpaidCount: 0 })
    expect(paidByEntryOf(null)).toEqual({})
    expect(returnedByEntryOf(undefined)).toEqual({})
  })
})
