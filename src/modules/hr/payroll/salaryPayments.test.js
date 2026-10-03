import { paymentState, runPaymentSummary, bankTransferPlan, methodLabel, PAYMENT_METHODS } from './salaryPayments'

const pay = (amount, over = {}) => ({ employee_id: 'e1', amount, paid_on: '2026-09-20', created_at: '2026-09-20T05:00:00Z', voided_at: null, ...over })

describe('paymentState — where one payslip stands', () => {
  it('reads unpaid, paid and nothing-to-pay', () => {
    expect(paymentState(29963, []).state).toBe('unpaid')
    expect(paymentState(29963, [pay(29963)])).toMatchObject({ state: 'paid', paid: 29963, due: 0 })
    expect(paymentState(0, []).state).toBe('none')
  })

  it('never counts an undone payment, but keeps it for the record', () => {
    const st = paymentState(29963, [pay(29963, { voided_at: '2026-09-21T00:00:00Z', void_reason: 'wrong person' })])
    expect(st).toMatchObject({ state: 'unpaid', paid: 0, due: 29963 })
    expect(st.voided).toHaveLength(1)
  })

  // Reopen stays allowed after payment (decision 2026-09-23), so a recorded payment can disagree
  // with a payslip that was regenerated since. Both directions must be named, never hidden.
  it('names the difference when the payslip moved after it was paid', () => {
    expect(paymentState(30200, [pay(29963)])).toMatchObject({ state: 'short', due: 237 })
    expect(paymentState(29700, [pay(29963)])).toMatchObject({ state: 'over', due: -263 })
  })

  it('treats float residue as settled, not as a paisa owed', () => {
    expect(paymentState(0.3, [pay(0.1), pay(0.2)]).state).toBe('paid')
    expect(paymentState('1500.10', [pay('1500.1')]).state).toBe('paid')
  })

  it('takes the latest active payment as `last`', () => {
    const st = paymentState(30000, [pay(20000, { paid_on: '2026-09-18' }), pay(10000, { paid_on: '2026-09-25', method: 'cash' })])
    expect(st.last.method).toBe('cash')
  })
})

describe('runPaymentSummary — the whole month', () => {
  const slips = [
    { employee_id: 'a', net_pay: 29963 },
    { employee_id: 'b', net_pay: 26697 },
    { employee_id: 'c', net_pay: 0 },       // nothing to pay: not counted as owed or unpaid
  ]

  it('lists who is still to be paid and what that costs', () => {
    const sum = runPaymentSummary(slips, [{ ...pay(29963), employee_id: 'a' }])
    expect(sum).toMatchObject({ owed: 2, paid: 1, over: 0, toPay: ['b'], dueTotal: 26697, paidTotal: 29963 })
  })

  it('counts an overpaid payslip as paid, and flags it', () => {
    const sum = runPaymentSummary([{ employee_id: 'a', net_pay: 100 }], [{ ...pay(150), employee_id: 'a' }])
    expect(sum).toMatchObject({ owed: 1, paid: 1, over: 1, toPay: [] })
  })

  it('puts a part-paid payslip back on the to-pay list for the difference only', () => {
    const sum = runPaymentSummary([{ employee_id: 'a', net_pay: 30200 }], [{ ...pay(29963), employee_id: 'a' }])
    expect(sum).toMatchObject({ toPay: ['a'], dueTotal: 237 })
  })

  // S788: the month was reopened and Regenerate left a paid person out. Their payment must still be
  // counted — an overpayment against nothing — never silently dropped from the month it was made in.
  it('keeps a payment whose payslip no longer exists, as an overpayment', () => {
    const sum = runPaymentSummary([{ employee_id: 'a', net_pay: 100 }], [
      { ...pay(100), employee_id: 'a' },
      { ...pay(500), employee_id: 'gone' },
    ])
    expect(sum).toMatchObject({ owed: 1, paid: 1, over: 1, paidTotal: 600, toPay: [], noPayslip: ['gone'] })
    expect(sum.byEmployee.get('gone')).toMatchObject({ state: 'over', due: -500 })
  })

  // The S788 review's catch: a REAL payslip that nets 0 but was paid still counts as owed and paid,
  // as it did before S788, so owed never reads 0 over an overpayment.
  it('keeps a paid payslip that nets 0 in owed and paid, flagged over', () => {
    const sum = runPaymentSummary([{ employee_id: 'a', net_pay: 0 }], [{ ...pay(30000), employee_id: 'a' }])
    expect(sum).toMatchObject({ owed: 1, paid: 1, over: 1, noPayslip: [] })
  })

  it('does not list someone without a payslip once every payment of theirs is undone', () => {
    const sum = runPaymentSummary([], [{ ...pay(500, { voided_at: '2026-09-24T00:00:00Z', void_reason: 'wrong run' }), employee_id: 'gone' }])
    expect(sum).toMatchObject({ owed: 0, over: 0, paidTotal: 0, noPayslip: [] })
  })
})

// S798 3e (REPORTS-1, H1 (a)): the Bank Transfer sheet lists only what each person is still owed, so
// uploading it after a Reopen or a cash payment can never pay anyone twice.
describe('bankTransferPlan — the bank sheet after payments', () => {
  const slips = [
    { id: 's1', employee_id: 'a', net_pay: 29963 },   // paid in full by bank
    { id: 's2', employee_id: 'b', net_pay: 26697 },   // nothing recorded yet
    { id: 's3', employee_id: 'c', net_pay: 31350 },   // reopened: overtime added after payment
    { id: 's4', employee_id: 'd', net_pay: 15000 },   // reopened: figure went down after payment
    { id: 's5', employee_id: 'e', net_pay: 0 },       // nothing to pay at all
  ]
  const payments = [
    { ...pay(29963), employee_id: 'a' },
    { ...pay(30000), employee_id: 'c' },
    { ...pay(15500), employee_id: 'd' },
    { ...pay(8000), employee_id: 'gone' },            // paid, then regenerated out of the month
  ]

  it('puts on the sheet only the people still owed, at what they are still owed', () => {
    const plan = bankTransferPlan(slips, payments)
    expect(plan.toPay.map(l => [l.s.employee_id, l.st.due])).toEqual([['b', 26697], ['c', 1350]])
    expect(plan.dueTotal).toBe(28047)
  })

  it('names who was left off, and why', () => {
    const plan = bankTransferPlan(slips, payments)
    expect(plan.paid.map(l => l.s.employee_id)).toEqual(['a'])
    expect(plan.over.map(l => [l.s.employee_id, l.st.due])).toEqual([['d', -500]])
    expect(plan.noPayslip).toEqual([expect.objectContaining({ employee_id: 'gone' })])
    expect(plan.noPayslip[0].st.paid).toBe(8000)
  })

  it('keeps every payslip on the screen table, with its net and paid', () => {
    const plan = bankTransferPlan(slips, payments)
    expect(plan.lines).toHaveLength(5)
    expect(plan.netTotal).toBe(103010)
    expect(plan.paidTotal).toBe(83463)   // the orphan's 8,000 included
    expect(plan.linesPaid).toBe(75463)   // the table's Paid column: payslips only
  })

  it('never counts an undone payment, so an undone mark goes back on the sheet', () => {
    const plan = bankTransferPlan([slips[0]], [{ ...pay(29963, { voided_at: '2026-09-21T00:00:00Z', void_reason: 'wrong person' }), employee_id: 'a' }])
    expect(plan.toPay.map(l => [l.s.employee_id, l.st.due])).toEqual([['a', 29963]])
  })

  it('is the old full-pay sheet when nothing has been paid (a draft never finalized)', () => {
    const plan = bankTransferPlan(slips, [])
    expect(plan.toPay.map(l => l.st.due)).toEqual([29963, 26697, 31350, 15000])
    expect(plan.paid).toEqual([]); expect(plan.over).toEqual([]); expect(plan.noPayslip).toEqual([])
  })
})

describe('payment methods', () => {
  it('match the database CHECK exactly', () => {
    expect(PAYMENT_METHODS.map(m => m.key)).toEqual(['bank', 'cash', 'wallet', 'cheque'])
    expect(methodLabel('wallet')).toBe('eSewa / Khalti')
  })
})
