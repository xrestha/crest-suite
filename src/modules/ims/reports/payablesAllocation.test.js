// S756 stage 3 — the lump-sum split (D9) and the supplier-credit arithmetic (D11). Both write money
// rows a supplier will later reconcile against, so the properties pinned here are the ones a
// reader checks: every row set sums to exactly what was typed, a credit pair is equal and opposite,
// nothing is taken from a bill beyond what it holds, and the oldest bill is paid first.
import {
  valueBillLines, groupIntoBills, allocatePayment, planSupplierLumpSum, supplierCreditSlots,
  billPaymentProblems, planBillPayment, compareBillsOldestFirst, expandCreditPartners,
  linesToReopen, isCreditRow, SUPPLIER_CREDIT_MODE,
} from './payablesAllocation'

const P = (y, m) => ({ bs_year: y, bs_month: m, client_id: 'c1' })

let seq = 0
function row(id, group, period, { qty = 1, rate = 1000, day = 10, ref = group, vat = false, discount = 0, created, paid_at = null } = {}) {
  seq += 1
  return {
    id, purchase_group_id: group, monthly_periods: period, bs_day: day, qty, rate, vat_inclusive: vat,
    discount_amount: discount, invoice_ref: ref, paid_at, created_at: created || `2026-09-01T00:00:${String(seq).padStart(2, '0')}Z`,
    vendor_id: 'v1', vendors: { id: 'v1', name: 'Himalayan Traders' },
  }
}

// Build grouped bills the way the page does, from rows + payments + returns.
function billsOf(rows, payments = [], returns = []) {
  const pmt = {}
  payments.forEach(p => { (pmt[p.purchase_entry_id] = pmt[p.purchase_entry_id] || []).push(p) })
  const ret = {}
  returns.forEach(r => { ret[r.purchase_entry_id] = (ret[r.purchase_entry_id] || 0) + r.qty * r.rate })
  return groupIntoBills(valueBillLines(rows, pmt, ret, new Date('2026-10-01')), pmt)
}

const sumAmounts = rows => Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100
const byRef = (bills, ref) => bills.find(b => b.invoice_ref === ref)

describe('allocatePayment (moved, unchanged)', () => {
  test('rows always sum to exactly the rounded amount across many sub-paisa lines', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`l${i}`, 'g', P(2083, 5), { qty: 1, rate: 33.333 }))
    const [bill] = billsOf(rows)
    const { rows: out, settleIds } = allocatePayment(bill.entries, Number(bill.remaining.toFixed(2)), '2026-10-01', null, 'Cash')
    expect(sumAmounts(out)).toBeCloseTo(Number(bill.remaining.toFixed(2)), 2)
    expect(settleIds).toHaveLength(10)
  })
})

describe('D9 — one lump sum, oldest bill first', () => {
  const rows = [
    row('new1', 'gNew', P(2083, 6), { rate: 3000, ref: 'NEW' }),
    row('old1', 'gOld', P(2083, 4), { rate: 1000, ref: 'OLD', day: 20 }),
    row('mid1', 'gMid', P(2083, 4), { rate: 2000, ref: 'MID', day: 25 }),
    row('mid2', 'gMid', P(2083, 4), { rate: 500, ref: 'MID', day: 25 }),
  ]

  test('orders bills by bill date, not by the order they arrive in', () => {
    const order = billsOf(rows).sort(compareBillsOldestFirst).map(b => b.invoice_ref)
    expect(order).toEqual(['OLD', 'MID', 'NEW'])
  })

  test('same bill date: the bill entered first is paid first', () => {
    const same = [
      row('x', 'gX', P(2083, 4), { ref: 'X', day: 5, created: '2026-08-02T10:00:00Z' }),
      row('y', 'gY', P(2083, 4), { ref: 'Y', day: 5, created: '2026-08-01T10:00:00Z' }),
    ]
    expect(billsOf(same).sort(compareBillsOldestFirst).map(b => b.invoice_ref)).toEqual(['Y', 'X'])
  })

  test('settles the oldest bills fully and part-pays the next, and says which', () => {
    const plan = planSupplierLumpSum(billsOf(rows), 2200, { date: '2026-10-01', note: 'Cheque 12', paymentMode: 'Cheque' })
    expect(plan.error).toBeNull()
    expect(plan.total).toBe(6500)
    expect(plan.split.map(s => [s.bill.invoice_ref, s.pay, s.settles, s.after])).toEqual([
      ['OLD', 1000, true, 0],
      ['MID', 1200, false, 1300],
      ['NEW', 0, false, 3000],
    ])
    expect(sumAmounts(plan.rows)).toBe(2200)
    // OLD's only line settles; MID's first line (2,000) is part-paid, so nothing of MID settles.
    expect(plan.settleIds).toEqual(['old1'])
    expect(plan.rows.every(r => r.payment_mode === 'Cheque' && r.note === 'Cheque 12' && r.paid_at === '2026-10-01')).toBe(true)
  })

  test('the whole amount owed settles every bill', () => {
    const plan = planSupplierLumpSum(billsOf(rows), 6500, { date: 'd' })
    expect(plan.split.every(s => s.settles)).toBe(true)
    expect(plan.settleIds.sort()).toEqual(['mid1', 'mid2', 'new1', 'old1'])
  })

  test('refuses an amount above the total owed instead of inventing a credit', () => {
    const plan = planSupplierLumpSum(billsOf(rows), 6600, { date: 'd' })
    expect(plan.error).toBe('over')
    expect(plan.rows).toHaveLength(0)
  })

  test('half a paisa of float noise is not refused', () => {
    expect(planSupplierLumpSum(billsOf(rows), 6500.004, { date: 'd' }).error).toBeNull()
  })

  test('skips a bill holding a credit and a bill already paid', () => {
    const extra = [
      ...rows,
      row('cr1', 'gCr', P(2083, 3), { rate: 1000, ref: 'CR' }),
      row('pd1', 'gPd', P(2083, 3), { rate: 800, ref: 'PD' }),
    ]
    const bills = billsOf(extra, [
      { purchase_entry_id: 'cr1', amount: 1000 }, { purchase_entry_id: 'pd1', amount: 800 },
    ], [{ purchase_entry_id: 'cr1', qty: 1, rate: 400 }])
    const plan = planSupplierLumpSum(bills, 1000, { date: 'd' })
    expect(plan.split.map(s => s.bill.invoice_ref)).toEqual(['OLD', 'MID', 'NEW'])
    expect(plan.total).toBe(6500)
  })

  test('a blank or zero amount plans nothing', () => {
    expect(planSupplierLumpSum(billsOf(rows), 0).error).toBe('amount')
    expect(planSupplierLumpSum(billsOf(rows), 'abc').error).toBe('amount')
  })
})

describe('D11 — supplier credit', () => {
  // Bill A: 1,000 paid in full, then 400 of goods returned → 400 credit.
  // Bill B: 2 lines (600 + 900 = 1,500) unpaid.
  const rowsA = [row('a1', 'gA', P(2083, 3), { rate: 1000, ref: 'A', paid_at: '2026-07-01' })]
  const rowsB = [
    row('b1', 'gB', P(2083, 5), { rate: 600, ref: 'B' }),
    row('b2', 'gB', P(2083, 5), { rate: 900, ref: 'B' }),
  ]
  const payments = [{ purchase_entry_id: 'a1', amount: 1000 }]
  const returns = [{ purchase_entry_id: 'a1', qty: 1, rate: 400 }]
  const all = () => billsOf([...rowsA, ...rowsB], payments, returns)
  let n = 0
  const newId = () => `L${++n}`

  test('a bill whose payments exceed what is owed is a credit, and only that bill offers one', () => {
    const slots = supplierCreditSlots(all())
    expect(slots.available).toBe(400)
    expect(slots.bills.map(b => [b.bill.invoice_ref, b.credit])).toEqual([['A', 400]])
    expect(slots.slots).toHaveLength(1)
  })

  test('never takes more than the BILL holds when one line is over-paid and another still owed', () => {
    // Line x paid 700 on a value of 400 (−300), line y 200 unpaid: the bill's credit is 100, not 300.
    const bills = billsOf([
      row('x', 'gM', P(2083, 2), { rate: 400, ref: 'M' }),
      row('y', 'gM', P(2083, 2), { rate: 200, ref: 'M' }),
    ], [{ purchase_entry_id: 'x', amount: 700 }])
    const slots = supplierCreditSlots(bills)
    expect(slots.available).toBe(100)
    expect(slots.slots.map(s => [s.line.id, s.capPaisa])).toEqual([['x', 10000]])
  })

  test('using credit writes equal and opposite pairs that net to zero, one link per pair', () => {
    n = 0
    const bills = all()
    const target = byRef(bills, 'B')
    const { slots } = supplierCreditSlots(bills)
    const plan = planBillPayment(target, { credit: 400, cash: 0, date: '2026-10-01', creditSlots: slots, newId })
    const credit = plan.rows.filter(isCreditRow)
    expect(credit).toHaveLength(2)
    expect(sumAmounts(credit)).toBe(0)
    const [pos, neg] = [credit.find(r => r.amount > 0), credit.find(r => r.amount < 0)]
    expect(pos).toMatchObject({ purchase_entry_id: 'b1', amount: 400, payment_mode: SUPPLIER_CREDIT_MODE, credit_link_id: 'L1', note: 'Supplier credit from bill #A' })
    expect(neg).toMatchObject({ purchase_entry_id: 'a1', amount: -400, credit_link_id: 'L1', note: 'Supplier credit used on bill #B' })
    // 400 against a 600 line settles nothing.
    expect(plan.settleIds).toEqual([])
  })

  test('credit then money: the bill settles and both amounts land where they should', () => {
    n = 0
    const bills = all()
    const target = byRef(bills, 'B')
    const { slots } = supplierCreditSlots(bills)
    const plan = planBillPayment(target, { credit: 400, cash: 1100, date: 'd', note: 'Cash top-up', paymentMode: 'Cash', creditSlots: slots, newId })
    const money = plan.rows.filter(r => !isCreditRow(r))
    expect(sumAmounts(money)).toBe(1100)
    // Credit fills 400 of b1, money fills the other 200 of b1 and all 900 of b2.
    expect(money.map(r => [r.purchase_entry_id, r.amount])).toEqual([['b1', 200], ['b2', 900]])
    expect(plan.settleIds.sort()).toEqual(['b1', 'b2'])
    // Bill A's credit is used up and it is owed nothing either way after the pair.
    const after = billsOf([...rowsA, ...rowsB], [...payments, ...plan.rows], returns)
    expect(byRef(after, 'A').remaining).toBeCloseTo(0, 2)
    expect(byRef(after, 'B').remaining).toBeCloseTo(0, 2)
    expect(byRef(after, 'A').creditOut).toBeCloseTo(400, 2)
    expect(byRef(after, 'B').creditIn).toBeCloseTo(400, 2)
  })

  test('a credit spread over two source bills and two target lines closes exactly, paisa for paisa', () => {
    n = 0
    const rows = [
      row('s1', 'gS1', P(2083, 1), { rate: 300.10, ref: 'S1' }),
      row('s2', 'gS2', P(2083, 2), { rate: 500.25, ref: 'S2' }),
      row('t1', 'gT', P(2083, 6), { rate: 150.05, ref: 'T' }),
      row('t2', 'gT', P(2083, 6), { rate: 999.99, ref: 'T' }),
    ]
    const bills = billsOf(rows,
      [{ purchase_entry_id: 's1', amount: 300.10 }, { purchase_entry_id: 's2', amount: 500.25 }],
      [{ purchase_entry_id: 's1', qty: 1, rate: 100.07 }, { purchase_entry_id: 's2', qty: 1, rate: 200.13 }])
    const { available, slots } = supplierCreditSlots(bills)
    expect(available).toBeCloseTo(300.20, 2)
    const plan = planBillPayment(byRef(bills, 'T'), { credit: available, date: 'd', creditSlots: slots, newId })
    const byLink = {}
    plan.rows.forEach(r => { (byLink[r.credit_link_id] = byLink[r.credit_link_id] || []).push(r) })
    Object.values(byLink).forEach(pair => {
      expect(pair).toHaveLength(2)
      expect(sumAmounts(pair)).toBe(0)
    })
    expect(sumAmounts(plan.rows.filter(r => r.amount > 0))).toBeCloseTo(300.20, 2)
    // Never more off a source line than the credit it held.
    const takenFrom = id => -sumAmounts(plan.rows.filter(r => r.purchase_entry_id === id))
    expect(takenFrom('s1')).toBeCloseTo(100.07, 2)
    expect(takenFrom('s2')).toBeCloseTo(200.13, 2)
  })

  test('refusals: more than the supplier has, more than the bill owes, money + credit over the bill', () => {
    const fmt = v => v.toFixed(2)
    expect(billPaymentProblems({ cash: '', credit: 500, remaining: 1500, available: 400, fmt }).credit).toMatch(/400\.00 of credit/)
    expect(billPaymentProblems({ cash: '', credit: 300, remaining: 200, available: 400, fmt }).credit).toMatch(/200\.00 left to pay/)
    expect(billPaymentProblems({ cash: 1200, credit: 400, remaining: 1500, available: 400, fmt }).cash).toMatch(/pay 1100\.00 or less/)
    expect(billPaymentProblems({ cash: 1100, credit: 400, remaining: 1500, available: 400, fmt })).toEqual({ cash: '', credit: '' })
    expect(billPaymentProblems({ cash: -1, credit: '', remaining: 10, available: 0, fmt }).cash).not.toBe('')
    // Money alone keeps the pre-S756-stage-3 rule: no more than the bill owes.
    expect(billPaymentProblems({ cash: 1501, credit: '', remaining: 1500, available: 0, fmt }).cash).not.toBe('')
  })

  test('money alone matches allocatePayment exactly', () => {
    const [bill] = billsOf(rowsB)
    const plan = planBillPayment(bill, { cash: 700, date: 'd', note: null, paymentMode: 'Cash' })
    const legacy = allocatePayment(bill.entries, 700, 'd', null, 'Cash')
    expect(plan.rows).toEqual(legacy.rows)
    expect(plan.settleIds).toEqual(legacy.settleIds)
  })
})

describe('deleting a credit entry takes its partner with it', () => {
  test('partners are reached by link id, including ones on bills not on screen', () => {
    const { ids, linkIds } = expandCreditPartners([
      { id: 'p1', credit_link_id: null }, { id: 'p2', credit_link_id: 'L9' }, { id: 'p3', credit_link_id: 'L9' },
    ])
    expect(ids).toEqual(['p1', 'p2', 'p3'])
    expect(linkIds).toEqual(['L9'])
  })

  test('the line the credit was used on reopens; the line it came from does not', () => {
    const removed = [
      { purchase_entry_id: 'target', amount: 400 },
      { purchase_entry_id: 'source', amount: -400 },
      { purchase_entry_id: 'plain', amount: 250 },
    ]
    expect(linesToReopen(removed).sort()).toEqual(['plain', 'target'])
  })
})
