// S791 — an advance is recovered to the paisa (hss-suite MD decision D3, 2026-09-26, ported). The
// payroll screens used to round the deduction to the rupee while Finalize's repayment rows kept
// paisa, and the allocation settled anything within Rs. 0.01 — so a Rs. 2,499.50 balance was cut as
// 2,500, and a one-paisa remainder was marked repaid and never recovered.
import { buildAdvanceMap, recoverableAdvance, allocateAdvanceRepayments, payslipDrift, writtenOffAdvancesForRun } from './payrollData'
import { toPaisa, roundPaisa } from './payrollCompute'
import { bsToAd, formatAd } from '../../../utils/bsCalendar'

const ad = (y, m, d) => formatAd(bsToAd(y, m, d))
const P = { bs_year: 2083, bs_month: 5 }   // Bhadra 2083
const adv = (over = {}) => ({
  id: 'a1', employee_id: 'e1', status: 'active', amount: '5000', installment_amount: '1000',
  issued_date: ad(2083, 4, 1), ...over,
})

describe('toPaisa / roundPaisa', () => {
  test('work in whole paisa, whatever the float', () => {
    expect(toPaisa('2499.50')).toBe(249950)
    expect(toPaisa(0.1 + 0.2)).toBe(30)
    expect(roundPaisa(1000.1 - 500.05)).toBe(500.05)
    expect(toPaisa(null)).toBe(0)
  })
})

describe('buildAdvanceMap — in paisa', () => {
  test('asks for the balance with its paisa', () => {
    const map = buildAdvanceMap([adv()], [{ advance_id: 'a1', amount: '4499.50' }], P)
    expect(map).toEqual({ e1: 500.5 })
  })
  test('a whole-rupee advance asks for exactly its instalment, as before', () => {
    expect(buildAdvanceMap([adv()], [], P)).toEqual({ e1: 1000 })
  })
})

describe('recoverableAdvance — the cut is capped at what is left, floored to the paisa', () => {
  test.each([
    [200000, 45000.609, 45000.6],   // never rounds UP past the pay it comes out of
    [2499.5, 45000, 2499.5],
    [0.25, 45000, 0.25],
    [50000, 30000 - 0.1 - 0.2, 29999.7],
    [1000, -50, 0],
  ])('recoverableAdvance(%p, %p) = %p', (requested, net, want) => {
    expect(recoverableAdvance(requested, net)).toBe(want)
  })
})

// Run the advance through consecutive payrolls: the deduction buildAdvanceMap asks for, capped at
// the month's take-home, allocated back onto the advance by Finalize. The status step stands in for
// the database trigger, which since S791 settles only at exact coverage.
function runMonths(advance, takeHomes) {
  let a = { ...advance }
  const repayments = []
  const cuts = []
  takeHomes.forEach((net, i) => {
    const period = { bs_year: 2083, bs_month: 5 + i }
    const due = buildAdvanceMap([a], repayments, period).e1 || 0
    const cut = recoverableAdvance(due, net)
    const { repayRows } = allocateAdvanceRepayments({
      payslips: [{ employee_id: 'e1', advance_deduction: cut }], advances: [a], repayments,
      period, runId: `r${i}`, repaidDate: '2026-09-28', note: 'test',
    })
    repayRows.forEach(r => repayments.push(r))
    cuts.push(repayRows.map(r => r.amount))
    const repaid = repayments.reduce((s, r) => s + toPaisa(r.amount), 0)
    if (repaid >= toPaisa(a.amount)) a = { ...a, status: 'settled' }
  })
  return { cuts, status: a.status, repaid: repayments.reduce((s, r) => s + toPaisa(r.amount), 0) }
}

describe('an advance with paisa closes exactly (D3)', () => {
  test('Rs. 1,500.50 at 1,000 a month closes in exactly two months, nothing left', () => {
    const { cuts, status, repaid } = runMonths(adv({ amount: '1500.50' }), [30000, 30000, 30000])
    expect(cuts).toEqual([[1000], [500.5], []])
    expect(status).toBe('settled')
    expect(repaid).toBe(150050)
  })
  test('a whole-rupee advance is recovered exactly as before', () => {
    const { cuts, status } = runMonths(adv({ amount: '3000' }), [30000, 30000, 30000])
    expect(cuts).toEqual([[1000], [1000], [1000]])
    expect(status).toBe('settled')
  })
  test('no instalment: the whole balance, paisa included, in one cut', () => {
    const { cuts, status } = runMonths(adv({ amount: '2499.25', installment_amount: null }), [30000])
    expect(cuts).toEqual([[2499.25]])
    expect(status).toBe('settled')
  })
  test('a 25-paisa remainder is asked for and closes — never rounded to 0 and stuck', () => {
    const map = buildAdvanceMap([adv({ amount: '2499.25', installment_amount: null })], [{ advance_id: 'a1', amount: '2499.00' }], P)
    expect(map).toEqual({ e1: 0.25 })
  })
  test('a short month takes what is left of the pay; the rest is taken next month', () => {
    const { cuts, status } = runMonths(adv({ amount: '1500.50' }), [900.75, 30000])
    expect(cuts).toEqual([[900.75], [599.75]])
    expect(status).toBe('settled')
  })
})

describe('allocateAdvanceRepayments — settles only at exact coverage', () => {
  test('a cut one paisa short of the balance does not settle the advance', () => {
    const { repayRows, settleIds } = allocateAdvanceRepayments({
      payslips: [{ employee_id: 'e1', advance_deduction: 1000.09 }],
      advances: [adv({ amount: '1000.10', installment_amount: null })], repayments: [],
      period: P, runId: 'r1', repaidDate: '2026-09-28', note: 'x',
    })
    expect(repayRows.map(r => r.amount)).toEqual([1000.09])
    expect(settleIds).toEqual([])
  })
  test('the exact balance settles it', () => {
    const { settleIds } = allocateAdvanceRepayments({
      payslips: [{ employee_id: 'e1', advance_deduction: 1000.1 }],
      advances: [adv({ amount: '1000.10', installment_amount: null })], repayments: [],
      period: P, runId: 'r1', repaidDate: '2026-09-28', note: 'x',
    })
    expect(settleIds).toEqual(['a1'])
  })
})

// Item 7 of the same pass: Reopen deleted the run's repayment rows, which on a written-off advance
// grew the write-off by what the run had recovered. Reopen now refuses and names the advance.
describe('writtenOffAdvancesForRun', () => {
  const repayments = [
    { advance_id: 'a1', amount: '1000.50', payroll_run_id: 'r1' },
    { advance_id: 'a2', amount: '500', payroll_run_id: 'r2' },
    { advance_id: 'a3', amount: '700', payroll_run_id: 'r1' },
  ]
  test('names only written-off advances THIS run recovered from, with what it took', () => {
    const advances = [
      adv({ id: 'a1', status: 'written_off' }),
      adv({ id: 'a2', status: 'written_off' }),   // another run's recovery
      adv({ id: 'a3', status: 'settled' }),       // not written off
    ]
    expect(writtenOffAdvancesForRun(advances, repayments, 'r1')).toEqual([{ advance: advances[0], recoveredHere: 1000.5 }])
  })
  test('nothing written off: Reopen may proceed', () => {
    expect(writtenOffAdvancesForRun([adv({ id: 'a1' })], repayments, 'r1')).toEqual([])
  })
})

describe('payslipDrift — the advance is compared to the paisa', () => {
  const base = { gross: 30000, ot_amount: 0, absence_deduction: 0, ssf_employee: 0, other_deductions: 0, retirement_contribution: 0, tds: 0, tada_amount: 0, tada_claim_ids: [] }
  test('a whole-rupee draft reads as moved when the paisa due has changed', () => {
    expect(payslipDrift({ ...base, advance_deduction: 2500 }, { ...base, advance_deduction: 2499.5 })).toBe('moved')
  })
  test('identical paisa is not drift', () => {
    expect(payslipDrift({ ...base, advance_deduction: '2499.50' }, { ...base, advance_deduction: 2499.5 })).toBe(null)
  })
})
