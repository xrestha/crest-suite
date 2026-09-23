import { paymentState, runPaymentSummary, methodLabel, PAYMENT_METHODS } from './salaryPayments'

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
})

describe('payment methods', () => {
  it('match the database CHECK exactly', () => {
    expect(PAYMENT_METHODS.map(m => m.key)).toEqual(['bank', 'cash', 'wallet', 'cheque'])
    expect(methodLabel('wallet')).toBe('eSewa / Khalti')
  })
})
