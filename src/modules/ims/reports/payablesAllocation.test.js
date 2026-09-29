// S756 stage 3 — the lump-sum split (D9) and the supplier-credit arithmetic (D11). Both write money
// rows a supplier will later reconcile against, so the properties pinned here are the ones a
// reader checks: every row set sums to exactly what was typed, a credit pair is equal and opposite,
// nothing is taken from a bill beyond what it holds, and the oldest bill is paid first.
import {
  valueBillLines, groupIntoBills, allocatePayment, planSupplierLumpSum, supplierCreditSlots,
  billPaymentProblems, planBillPayment, compareBillsOldestFirst, expandCreditPartners,
  linesToReopen, isCreditRow, SUPPLIER_CREDIT_MODE, billOwedAfterReturns, linesToCloseByReturns,
  returnChangeReopensBill, returnEditReopensBill, paymentsMovedSince, paymentsMovedText,
} from './payablesAllocation'
import { billPayables } from './purchaseTaxSplit'

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

// S792, owner decision D33 (PURCHASES-3). A return against a discounted bill comes off at the price
// the supplier actually charged. These were verified to fail against the pre-D33 arithmetic
// (calcBillTotals over the returns-netted lines with the WHOLE discount kept) before being kept.
describe('D33 — a return is credited at the discounted price', () => {
  // A Credit bill: line A 6,000 + line B 4,000, one bill discount of 1,000 (so 10% off each line).
  const discounted = () => [
    row('dA', 'gD', P(2083, 5), { rate: 6000, ref: 'D', discount: 1000 }),
    row('dB', 'gD', P(2083, 5), { rate: 4000, ref: 'D', discount: 1000 }),
  ]

  test('all of line B goes back: the supplier credits 3,600 and is owed 5,400 (was 5,000)', () => {
    const [b] = billsOf(discounted(), [], [{ purchase_entry_id: 'dB', qty: 1, rate: 4000 }])
    expect(b.total).toBeCloseTo(5400, 2)
    expect(b.remaining).toBeCloseTo(5400, 2)
  })

  test('the whole bill goes back: nothing is owed, and the supplier does not owe us the discount', () => {
    const [b] = billsOf(discounted(), [], [
      { purchase_entry_id: 'dA', qty: 1, rate: 6000 }, { purchase_entry_id: 'dB', qty: 1, rate: 4000 },
    ])
    expect(b.total).toBeCloseTo(0, 2)
    expect(b.remaining).toBeCloseTo(0, 2)
    expect(b.isCredit).toBe(false)
  })

  test('a heavy return on an unpaid bill leaves a small bill, never a credit badge', () => {
    // 9,500 of a 10,000 one-line bill back: 500 at list, 450 at the price charged.
    const [b] = billsOf([row('h1', 'gH', P(2083, 5), { rate: 10000, ref: 'H', discount: 1000 })], [],
      [{ purchase_entry_id: 'h1', qty: 1, rate: 9500 }])
    expect(b.remaining).toBeCloseTo(450, 2)
    expect(b.isCredit).toBe(false)
  })

  test('paid 9,000, then half the goods back: the credit offered is the credit note, 4,500 (was 5,000)', () => {
    const [b] = billsOf(discounted(),
      [{ purchase_entry_id: 'dA', amount: 5400 }, { purchase_entry_id: 'dB', amount: 3600 }],
      [{ purchase_entry_id: 'dA', qty: 1, rate: 3000 }, { purchase_entry_id: 'dB', qty: 1, rate: 2000 }])
    expect(b.remaining).toBeCloseTo(-4500, 2)
    expect(supplierCreditSlots([b]).available).toBeCloseTo(4500, 2)
  })

  test('a mixed VAT bill owes exactly what Payment Summary says: bill total less each return at its discounted price plus its VAT', () => {
    const period = P(2083, 5)
    const rows = [
      row('mv', 'gM', period, { qty: 10, rate: 600, vat: true, ref: 'M', discount: 700 }),
      row('mn', 'gM', period, { qty: 8, rate: 500, vat: false, ref: 'M', discount: 700 }),
    ]
    const returns = [
      { purchase_entry_id: 'mv', qty: 3, rate: 600, purchase_entries: { vat_inclusive: true } },
      { purchase_entry_id: 'mn', qty: 2, rate: 500, purchase_entries: { vat_inclusive: false } },
    ]
    const pay = billPayables(rows, returns, period)
    const expected = pay.bills[0].total - pay.returns.reduce((s, r) => s + r.value, 0)
    expect(billOwedAfterReturns(rows, { mv: 1800, mn: 1000 }, 700)).toBeCloseTo(expected, 6)
    // The page's bill total is its lines' 2dp values added up, so it may sit a paisa off.
    const [b] = billsOf(rows, [], returns)
    expect(Math.abs(b.total - expected)).toBeLessThanOrEqual(0.011)
  })

  test('linear in the returns: two returns off one line are worth what one return of both is', () => {
    const lines = [{ id: 'x', qty: 10, rate: 100, vat_inclusive: true }, { id: 'y', qty: 1, rate: 1000, vat_inclusive: false }]
    const full = billOwedAfterReturns(lines, {}, 200)
    const once = billOwedAfterReturns(lines, { x: 300 }, 200)
    const twice = billOwedAfterReturns(lines, { x: 100 }, 200) - billOwedAfterReturns(lines, { x: 300 }, 200)
    // 300 of VAT goods back at 90% (200 off a 2,000 bill) plus 13%.
    expect(full - once).toBeCloseTo(300 * 0.9 * 1.13, 6)
    expect((full - billOwedAfterReturns(lines, { x: 100 }, 200)) + twice).toBeCloseTo(full - once, 6)
  })

  test('with no returns it is calcBillTotals unchanged', () => {
    const lines = [{ id: 'x', qty: 10, rate: 100, vat_inclusive: true }, { id: 'y', qty: 1, rate: 1000, vat_inclusive: false }]
    // 2,000 − 200 + 13% of the 1,000 VAT half net of its 100 share of the discount.
    expect(billOwedAfterReturns(lines, {}, 200)).toBeCloseTo(1800 + 900 * 0.13, 6)
  })
})

// S792 (PURCHASES-8). A Credit bill with nothing left to pay must be able to leave Outstanding.
describe('a bill with nothing left to pay closes', () => {
  test('paying the remaining settles every unstamped line, including one that could not reach its own value', () => {
    // Line p1 was paid 1,000 and stamped, then 600 of it went back; p2 (1,000) is unpaid. The bill
    // owes 400 and all of it lands on p2, which never reaches its own 1,000 — so nothing used to be
    // stamped and the bill sat on Outstanding at "0 remaining" for ever.
    const rows = [
      row('p1', 'gP', P(2083, 5), { rate: 1000, ref: 'P', paid_at: '2026-09-01' }),
      row('p2', 'gP', P(2083, 5), { rate: 1000, ref: 'P' }),
    ]
    const [b] = billsOf(rows, [{ purchase_entry_id: 'p1', amount: 1000 }], [{ purchase_entry_id: 'p1', qty: 1, rate: 600 }])
    expect(b.remaining).toBeCloseTo(400, 2)
    const { rows: out, settleIds } = allocatePayment(b.entries, 400, 'd', null, 'Cash')
    expect(out.map(r => [r.purchase_entry_id, r.amount])).toEqual([['p2', 400]])
    expect(settleIds).toEqual(['p2'])
    // The per-bill form and the lump sum reach the same answer.
    expect(planBillPayment(b, { cash: 400, date: 'd' }).settleIds).toEqual(['p2'])
    expect(planSupplierLumpSum([b], 400, { date: 'd' }).settleIds).toEqual(['p2'])
  })

  test('a part payment still settles nothing', () => {
    const rows = [
      row('q1', 'gQ', P(2083, 5), { rate: 1000, ref: 'Q' }),
      row('q2', 'gQ', P(2083, 5), { rate: 1000, ref: 'Q' }),
    ]
    const [b] = billsOf(rows)
    expect(allocatePayment(b.entries, 1500, 'd', null, 'Cash').settleIds).toEqual(['q1'])
    expect(allocatePayment(b.entries, 999, 'd', null, 'Cash').settleIds).toEqual([])
  })

  test('a Credit bill whose goods all went back, never paid, is offered for closing — every line', () => {
    const [b] = billsOf([
      row('f1', 'gF', P(2083, 5), { rate: 500, ref: 'F', discount: 50 }),
      row('f2', 'gF', P(2083, 5), { rate: 500, ref: 'F', discount: 50 }),
    ], [], [{ purchase_entry_id: 'f1', qty: 1, rate: 500 }, { purchase_entry_id: 'f2', qty: 1, rate: 500 }])
    expect(b.remaining).toBeCloseTo(0, 2)
    expect(linesToCloseByReturns(b)).toEqual(['f1', 'f2'])
  })

  test('a bill left in credit by a return closes too, and its stamped line is left as it is', () => {
    const [b] = billsOf([
      row('c1', 'gC', P(2083, 5), { rate: 1000, ref: 'C', paid_at: '2026-09-01' }),
      row('c2', 'gC', P(2083, 5), { rate: 500, ref: 'C' }),
    ], [{ purchase_entry_id: 'c1', amount: 1000 }], [{ purchase_entry_id: 'c1', qty: 1, rate: 1000 }])
    expect(b.isCredit).toBe(true)
    expect(linesToCloseByReturns(b)).toEqual(['c2'])
  })

  test('a bill that still owes anything is never offered for closing', () => {
    const [b] = billsOf([row('o1', 'gO', P(2083, 5), { rate: 500, ref: 'O' })], [], [{ purchase_entry_id: 'o1', qty: 1, rate: 499 }])
    expect(b.remaining).toBeCloseTo(1, 2)
    expect(linesToCloseByReturns(b)).toEqual([])
    expect(linesToCloseByReturns(null)).toEqual([])
  })
})

// S792 stage 2 — deleting a return from a bill Paid History holds as settled. The return is what
// settled it, so without it the bill owes again and must move back to Outstanding; the stamp is
// cleared only when the bill's own recorded figures show it settled, never on a legacy stamp.
describe('deleting a return from a settled bill reopens it', () => {
  const ret = (id, lineId, qty, rate) => ({ id, purchase_entry_id: lineId, qty, rate })

  test('paid down to what the return left: deleting the return puts the returned value back on it', () => {
    const lines = [row('s1', 'gS', P(2083, 5), { rate: 1000, ref: 'S', paid_at: '2026-09-05' })]
    const d = returnChangeReopensBill({
      lines, returns: [ret('r1', 's1', 1, 400)], payments: [{ purchase_entry_id: 's1', amount: 600 }], returnId: 'r1',
    })
    expect(d).toMatchObject({ reopen: true, stampedIds: ['s1'], owedNow: 600, owedAfter: 1000, paid: 600, owedAgain: 400 })
  })

  test('a bill closed by hand once every item went back (no payment rows) reopens at the discounted price', () => {
    const lines = [
      row('h1', 'gH', P(2083, 5), { rate: 500, ref: 'H', discount: 50, paid_at: '2026-09-20' }),
      row('h2', 'gH', P(2083, 5), { rate: 500, ref: 'H', discount: 50, paid_at: '2026-09-20' }),
    ]
    const d = returnChangeReopensBill({ lines, returns: [ret('r1', 'h1', 1, 500), ret('r2', 'h2', 1, 500)], payments: [], returnId: 'r1' })
    // 500 kept of a 1,000 bill keeps half of its 50 discount (D33).
    expect(d).toMatchObject({ reopen: true, stampedIds: ['h1', 'h2'], owedNow: 0, owedAfter: 475, paid: 0, owedAgain: 475 })
  })

  test('a legacy stamp — paid before payable_payments existed, figures still owing — is never flipped', () => {
    const lines = [row('l1', null, P(2080, 2), { rate: 1000, ref: 'L', paid_at: '2023-06-01' })]
    const d = returnChangeReopensBill({ lines, returns: [ret('r1', 'l1', 1, 200)], payments: [], returnId: 'r1' })
    expect(d.owedNow).toBe(800)
    expect(d.reopen).toBe(false)
    expect(d.owedAgain).toBe(0)
  })

  test('a bill still in credit after losing one of its returns stays settled', () => {
    const lines = [row('k1', 'gK', P(2083, 5), { rate: 1000, ref: 'K', paid_at: '2026-09-05' })]
    const d = returnChangeReopensBill({
      lines, returns: [ret('r1', 'k1', 1, 300), ret('r2', 'k1', 1, 200)], payments: [{ purchase_entry_id: 'k1', amount: 1000 }], returnId: 'r2',
    })
    expect(d).toMatchObject({ reopen: false, owedNow: 500, owedAfter: 700, paid: 1000, owedAgain: 0 })
  })

  test('a bill already on Outstanding (nothing stamped) needs nothing cleared', () => {
    const lines = [row('u1', 'gU', P(2083, 5), { rate: 1000, ref: 'U' })]
    const d = returnChangeReopensBill({ lines, returns: [ret('r1', 'u1', 1, 400)], payments: [{ purchase_entry_id: 'u1', amount: 600 }], returnId: 'r1' })
    expect(d.stampedIds).toEqual([])
    expect(d.reopen).toBe(false)
  })

  test('decides on the figure Outstanding Payables shows — a mixed VAT bill with a discount', () => {
    const rows = [
      row('m1', 'gM', P(2083, 5), { rate: 6000, ref: 'M', vat: true, discount: 1000, paid_at: '2026-09-05' }),
      row('m2', 'gM', P(2083, 5), { rate: 4000, ref: 'M', vat: false, discount: 1000, paid_at: '2026-09-05' }),
    ]
    const returns = [ret('r1', 'm2', 1, 4000)]
    const [withReturn] = billsOf(rows, [], returns)
    const [withoutReturn] = billsOf(rows)
    const payments = [{ purchase_entry_id: 'm1', amount: withReturn.total }]
    const d = returnChangeReopensBill({ lines: rows, returns, payments, returnId: 'r1' })
    expect(d.owedNow).toBeCloseTo(withReturn.total, 2)
    expect(d.owedAfter).toBeCloseTo(withoutReturn.total, 2)
    expect(d.reopen).toBe(true)
    expect(d.owedAgain).toBeCloseTo(withoutReturn.total - withReturn.total, 2)
  })

  test('supplier credit taken out of the bill counts against what it was paid', () => {
    // Paid 1,000, 400 went back, and that 400 credit was used on another bill (a −400 half here).
    const lines = [row('c1', 'gC2', P(2083, 5), { rate: 1000, ref: 'C2', paid_at: '2026-09-05' })]
    const payments = [
      { purchase_entry_id: 'c1', amount: 1000 },
      { purchase_entry_id: 'c1', amount: -400, payment_mode: SUPPLIER_CREDIT_MODE, credit_link_id: 'x' },
    ]
    const d = returnChangeReopensBill({ lines, returns: [ret('r1', 'c1', 1, 400)], payments, returnId: 'r1' })
    expect(d).toMatchObject({ reopen: true, owedNow: 600, paid: 600, owedAfter: 1000, owedAgain: 400 })
  })

  test('an edit that shrinks the return asks the same question (newQty)', () => {
    const lines = [row('e1', 'gE', P(2083, 5), { qty: 10, rate: 100, ref: 'E', paid_at: '2026-09-05' })]
    const base = { lines, returns: [ret('r1', 'e1', 4, 100)], payments: [{ purchase_entry_id: 'e1', amount: 600 }], returnId: 'r1' }
    expect(returnChangeReopensBill({ ...base, newQty: 3 })).toMatchObject({ reopen: true, owedAfter: 700, owedAgain: 100 })
    expect(returnChangeReopensBill({ ...base, newQty: 4 }).reopen).toBe(false)
  })

  test('returns and payments on another bill\'s lines are ignored', () => {
    const lines = [row('i1', 'gI', P(2083, 5), { rate: 1000, ref: 'I', paid_at: '2026-09-05' })]
    const d = returnChangeReopensBill({
      lines,
      returns: [ret('r1', 'i1', 1, 400), ret('r9', 'other', 1, 999)],
      payments: [{ purchase_entry_id: 'i1', amount: 600 }, { purchase_entry_id: 'other', amount: 5000 }],
      returnId: 'r1',
    })
    expect(d).toMatchObject({ reopen: true, owedNow: 600, paid: 600, owedAgain: 400 })
  })
})

// S792 stage 2 review (P1): editing a return asks the delete's question of the return as it will be
// written. Same line → the newQty question; re-linked off the bill → a delete there; moved to another
// line of the same bill → still on it, at that line's figures; and the bill it moves TO never reopens.
describe('editing a return asks the same question of the return as it will be written', () => {
  const ret = (id, lineId, qty, rate) => ({ id, purchase_entry_id: lineId, qty, rate })
  const paid = amount => [{ purchase_entry_id: 'e1', amount }]

  test('next null is the delete, figure for figure', () => {
    const lines = [row('e1', 'gE', P(2083, 5), { rate: 1000, ref: 'E', paid_at: '2026-09-05' })]
    const args = { lines, returns: [ret('r1', 'e1', 1, 400)], payments: paid(600), returnId: 'r1' }
    expect(returnEditReopensBill({ ...args, next: null })).toEqual(returnChangeReopensBill(args))
  })

  test('same line, new qty: the newQty question, figure for figure', () => {
    const lines = [row('e1', 'gE', P(2083, 5), { qty: 10, rate: 100, ref: 'E', paid_at: '2026-09-05' })]
    const args = { lines, returns: [ret('r1', 'e1', 4, 100)], payments: paid(600), returnId: 'r1' }
    const cut = returnEditReopensBill({ ...args, next: { purchase_entry_id: 'e1', qty: 1, rate: 100 } })
    expect(cut).toEqual(returnChangeReopensBill({ ...args, newQty: 1 }))
    expect(cut).toMatchObject({ reopen: true, owedAfter: 900, owedAgain: 300 })
    // Raising the qty only lowers what is owed.
    expect(returnEditReopensBill({ ...args, next: { purchase_entry_id: 'e1', qty: 6, rate: 100 } }).reopen).toBe(false)
  })

  test('re-linked to a line on another bill: a delete on the bill it leaves', () => {
    const lines = [row('e1', 'gE', P(2083, 5), { rate: 1000, ref: 'E', paid_at: '2026-09-05' })]
    const args = { lines, returns: [ret('r1', 'e1', 1, 400)], payments: paid(600), returnId: 'r1' }
    const moved = returnEditReopensBill({ ...args, next: { purchase_entry_id: 'elsewhere', qty: 1, rate: 400 } })
    expect(moved).toEqual(returnChangeReopensBill(args))
    expect(moved).toMatchObject({ reopen: true, owedAgain: 400 })
  })

  test('moved to another line of the SAME bill: still on it, valued at that line', () => {
    const lines = [
      row('a1', 'gA', P(2083, 5), { rate: 400, ref: 'A', paid_at: '2026-09-05' }),
      row('a2', 'gA', P(2083, 5), { rate: 400, ref: 'A', paid_at: '2026-09-05' }),
      row('a3', 'gA', P(2083, 5), { rate: 300, ref: 'A', paid_at: '2026-09-05' }),
    ]
    const args = { lines, returns: [ret('r1', 'a1', 1, 400)], payments: [{ purchase_entry_id: 'a2', amount: 700 }], returnId: 'r1' }
    // A like-for-like line: the bill still owes 700, paid 700 — nothing to clear. As a delete it would
    // have cleared the stamps of a bill the write leaves settled.
    expect(returnEditReopensBill({ ...args, next: { purchase_entry_id: 'a2', qty: 1, rate: 400 } }))
      .toMatchObject({ reopen: false, owedNow: 700, owedAfter: 700 })
    expect(returnChangeReopensBill(args).reopen).toBe(true)
    // A cheaper line takes 100 less off the bill, so 100 is owed again.
    expect(returnEditReopensBill({ ...args, next: { purchase_entry_id: 'a3', qty: 1, rate: 300 } }))
      .toMatchObject({ reopen: true, owedAfter: 800, owedAgain: 100 })
  })

  test('the bill a return moves TO only gains it, and never reopens', () => {
    const rows = [
      row('m1', 'gM', P(2083, 5), { qty: 7, rate: 857.13, ref: 'M', vat: true, discount: 333.33, paid_at: '2026-09-05' }),
      row('m2', 'gM', P(2083, 5), { qty: 3, rate: 1234.57, ref: 'M', vat: false, discount: 333.33, paid_at: '2026-09-05' }),
      row('m3', 'gM', P(2083, 5), { qty: 11, rate: 99.99, ref: 'M', vat: true, discount: 333.33, paid_at: '2026-09-05' }),
    ]
    const returns = [ret('rx', 'm3', 2, 99.99)]
    const settled = returnChangeReopensBill({ lines: rows, returns, payments: [], returnId: null })
    const payments = [{ purchase_entry_id: 'm1', amount: settled.owedNow }]   // paid to the paisa
    ;[['m1', 1, 857.13], ['m2', 0.5, 1234.57], ['m3', 3, 99.99], ['m2', 3, 1234.57]].forEach(([lineId, qty, rate]) => {
      const d = returnEditReopensBill({ lines: rows, returns, payments, returnId: 'incoming', next: { purchase_entry_id: lineId, qty, rate } })
      expect(d.reopen).toBe(false)
      expect(d.owedAfter).toBeLessThan(d.owedNow)
    })
  })
})

// S792, PURCHASES-10: nothing on the server stops a bill being paid twice, so the page re-reads a
// bill's payments just before it writes and stops if they moved.
describe('a payment written from an out-of-date page stops', () => {
  const rows = [
    row('p1', 'gP', P(2083, 5), { qty: 2, rate: 1000, ref: 'P1' }),
    row('p2', 'gP', P(2083, 5), { qty: 1, rate: 500, ref: 'P1' }),
  ]
  const loaded = [{ id: 'x1', purchase_entry_id: 'p1', amount: 1000, note: 'cheque 11' }]
  const bill = () => billsOf(rows, loaded)[0]
  const fmt = n => `NPR ${n.toFixed(2)}`

  test('nothing moved: safe to write', () => {
    const b = bill()
    expect(b.remaining).toBe(1500)
    expect(paymentsMovedSince([b], loaded, { [b.key]: 1500 })).toEqual([])
  })

  test('a note or mode edited elsewhere is not a reason to stop', () => {
    const b = bill()
    const fresh = [{ ...loaded[0], note: 'cheque 11, cleared', payment_mode: 'Cheque', amount: '1000.00' }]
    expect(paymentsMovedSince([b], fresh, { [b.key]: 1500 })).toEqual([])
  })

  test('someone else paid meanwhile: stops, with the figures and the overpayment', () => {
    const b = bill()
    const fresh = [...loaded, { id: 'x2', purchase_entry_id: 'p2', amount: 1200 }]
    const [stop] = paymentsMovedSince([b], fresh, { [b.key]: 1500 })
    expect(stop).toMatchObject({ moved: true, paidThen: 1000, paidNow: 2200, owedNow: 300, paying: 1500, over: 1200 })
    const text = paymentsMovedText([stop], fmt)
    expect(text).toMatch(/^Nothing was recorded\. The payments on this bill changed after this page was opened/)
    expect(text).toMatch(/Bill #P1 \(Himalayan Traders\) now has NPR 2200\.00 recorded against it where this page showed NPR 1000\.00, so it has NPR 300\.00 left to pay; paying NPR 1500\.00 would be NPR 1200\.00 more than it owes\./)
    expect(text).toMatch(/Reload the page/)
  })

  test('a payment removed elsewhere stops too — the split was planned on the old lines', () => {
    const b = bill()
    const [stop] = paymentsMovedSince([b], [], { [b.key]: 1500 })
    expect(stop).toMatchObject({ moved: true, paidThen: 1000, paidNow: 0, owedNow: 2500, over: 0 })
  })

  test('the same total from different rows still counts as moved', () => {
    const b = bill()
    const fresh = [{ id: 'x9', purchase_entry_id: 'p1', amount: 1000 }]
    const [stop] = paymentsMovedSince([b], fresh, { [b.key]: 100 })
    expect(stop.moved).toBe(true)
    expect(paymentsMovedText([stop], fmt)).toMatch(/has had its payments changed since this page was opened \(NPR 1000\.00 in all\), and has NPR 1500\.00 left to pay\./)
  })

  test('a bill a fresh payment has put in credit says the supplier owes it back', () => {
    const b = bill()
    const fresh = [...loaded, { id: 'x2', purchase_entry_id: 'p2', amount: 1800 }]
    const [stop] = paymentsMovedSince([b], fresh, { [b.key]: 1500 })
    expect(stop).toMatchObject({ owedNow: -300, over: 1500 })
    expect(paymentsMovedText([stop], fmt)).toMatch(/nothing left to pay — the supplier owes NPR 300\.00 back on it; paying NPR 1500\.00 would be NPR 1500\.00 more than it owes/)
  })

  test('credit halves are signed: a bill that gave credit away may be paid what it owes again', () => {
    // Paid 1,000 in full, then 300 of a credit on it was used on another bill (the negative half),
    // and the return that created the credit has since been deleted — it owes 300 again.
    const giver = [row('g1', 'gG', P(2083, 5), { rate: 1000, ref: 'G' })]
    const pays = [
      { id: 'm1', purchase_entry_id: 'g1', amount: 1000 },
      { id: 'c1', purchase_entry_id: 'g1', amount: -300, credit_link_id: 'L1', payment_mode: SUPPLIER_CREDIT_MODE },
    ]
    const [b] = billsOf(giver, pays)
    expect(b.remaining).toBe(300)
    expect(paymentsMovedSince([b], pays, { [b.key]: 300 })).toEqual([])
  })

  test('a credit source bill is checked with nothing paying onto it', () => {
    const srcRows = [row('s1', 'gS', P(2083, 3), { rate: 1000, ref: 'S', paid_at: '2026-07-01' })]
    const srcPays = [{ id: 'k1', purchase_entry_id: 's1', amount: 1000 }]
    const [src] = billsOf(srcRows, srcPays, [{ purchase_entry_id: 's1', qty: 1, rate: 400 }])
    expect(paymentsMovedSince([src], srcPays, {})).toEqual([])
    // The same credit used from another screen meanwhile: the source's rows moved, so it stops.
    const usedElsewhere = [...srcPays, { id: 'k2', purchase_entry_id: 's1', amount: -400, credit_link_id: 'L9' }]
    expect(paymentsMovedSince([src], usedElsewhere, {})).toEqual([expect.objectContaining({ moved: true, paidNow: 600, over: 0 })])
  })

  test('only rows on the bill\'s own lines count', () => {
    const b = bill()
    const fresh = [...loaded, { id: 'z1', purchase_entry_id: 'other-bill-line', amount: 999 }]
    expect(paymentsMovedSince([b], fresh, { [b.key]: 1500 })).toEqual([])
  })

  test('an overpayment on an unmoved bill still stops, without claiming anything changed', () => {
    const b = bill()
    const [stop] = paymentsMovedSince([b], loaded, { [b.key]: 1600 })
    expect(stop).toMatchObject({ moved: false, over: 100 })
    expect(paymentsMovedText([stop], fmt)).toBe('Nothing was recorded. Bill #P1 (Himalayan Traders) has NPR 1500.00 left to pay; paying NPR 1600.00 would be NPR 100.00 more than it owes.')
  })

  test('half a paisa of float noise is not an overpayment', () => {
    const b = bill()
    expect(paymentsMovedSince([b], loaded, { [b.key]: 1500.004 })).toEqual([])
  })
})
