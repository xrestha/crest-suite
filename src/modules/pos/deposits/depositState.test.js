/**
 * Booking deposits (S854), the pure half: the balance arithmetic, what a booking row says about its
 * deposit and which actions it offers, what a Cancel or No-show does with the money, and the amount box.
 * Owner decisions held here: a deposit is ALWAYS refunded the way it came (never kept), a cancellation
 * or no-show refunds all of it, and only a supervisor or manager takes or refunds one.
 */
import {
  DEPOSIT_METHODS, depositBalance, depositsByReservation, depositOfReservation, pickOrderDeposit, depositBadge,
  depositActions, refundOnEndPlan, refundConsequence, parseDepositAmount, depositReceiptLabel, depositMoney,
} from './depositState'

const dep = over => ({
  id: 'd1', reservation_id: 'r1', receipt_no: 7, invoice_fy: '2083/84', amount: 5000, method: 'Cash',
  used_amount: 0, refunded_amount: 0, order_id: null, taken_at: '2026-10-20T06:00:00Z', ...over,
})
const booking = status => ({ id: 'r1', status, customer_name: 'Sharma' })

describe('depositBalance', () => {
  it('is the amount less what the bill used and what was refunded, to the paisa', () => {
    expect(depositBalance(dep())).toBe(5000)
    expect(depositBalance(dep({ used_amount: 3200.5 }))).toBe(1799.5)
    expect(depositBalance(dep({ amount: 0.3, used_amount: 0.1, refunded_amount: 0.2 }))).toBe(0)
    expect(depositBalance(dep({ used_amount: '1200.25', refunded_amount: '0.75' }))).toBe(3799)
  })

  it('never goes below zero, and no deposit has nothing left', () => {
    expect(depositBalance(dep({ used_amount: 4000, refunded_amount: 2000 }))).toBe(0)
    expect(depositBalance(null)).toBe(0)
  })
})

describe('grouping and picking', () => {
  it('groups by booking, newest first, and a row speaks for its live deposit', () => {
    const old = dep({ id: 'old', refunded_amount: 5000, taken_at: '2026-10-01T00:00:00Z' })
    const live = dep({ id: 'live', taken_at: '2026-10-10T00:00:00Z' })
    const other = dep({ id: 'x', reservation_id: 'r2' })
    const by = depositsByReservation([old, live, other])
    expect(by.r1.map(d => d.id)).toEqual(['live', 'old'])
    expect(depositOfReservation(by.r1).id).toBe('live')
    expect(depositOfReservation([old]).id).toBe('old')
    expect(depositOfReservation(undefined)).toBe(null)
  })

  it('the payment window gets the deposit on the bill, else the one free deposit, never a guess', () => {
    const onBill = dep({ id: 'a', order_id: 'o1' })
    expect(pickOrderDeposit([onBill], 'o1')).toMatchObject({ id: 'a', balance: 5000, onThisBill: true, label: 'DP-7' })
    expect(pickOrderDeposit([dep({ id: 'b' })], 'o1')).toMatchObject({ id: 'b', onThisBill: false })
    // Two free deposits is the server refusal (booking_deposit_ambiguous): none is offered.
    expect(pickOrderDeposit([dep({ id: 'b' }), dep({ id: 'c' })], 'o1')).toBe(null)
    // On another open bill, used on a bill already, or nothing left: not usable here.
    expect(pickOrderDeposit([dep({ order_id: 'o2' })], 'o1')).toBe(null)
    expect(pickOrderDeposit([dep({ order_id: 'o9', used_amount: 1000 })], 'o1')).toBe(null)
    expect(pickOrderDeposit([dep({ refunded_amount: 5000 })], 'o1')).toBe(null)
    // The same row read twice (on the bill and by its booking) counts once.
    expect(pickOrderDeposit([onBill, onBill], 'o1')).toMatchObject({ id: 'a' })
  })
})

describe('depositBadge', () => {
  it('a booking still to come shows the deposit held, as a plain fact', () => {
    expect(depositBadge(booking('confirmed'), dep())).toMatchObject({ kind: 'held', badge: 'badge-gray', text: 'Deposit NPR 5,000' })
  })

  it('a deposit on the open bill says so', () => {
    expect(depositBadge(booking('seated'), dep({ order_id: 'o1' }), { onOpenBill: true }))
      .toMatchObject({ kind: 'on_bill', text: 'Deposit NPR 5,000 on the bill' })
  })

  it('money left on a booking that is over is a refund due, in amber, for every ending', () => {
    for (const s of ['cancelled', 'no_show', 'completed']) {
      expect(depositBadge(booking(s), dep())).toMatchObject({ kind: 'refund_due', badge: 'badge-amber', text: '△ Refund due NPR 5,000' })
    }
    // A bill that used part leaves the rest owed back, whatever the booking says.
    expect(depositBadge(booking('seated'), dep({ used_amount: 3000, order_id: 'o1' })))
      .toMatchObject({ kind: 'refund_due', text: '△ Refund due NPR 2,000' })
  })

  it('nothing left reads as used or refunded, never as owed', () => {
    expect(depositBadge(booking('completed'), dep({ used_amount: 5000, order_id: 'o1' }))).toMatchObject({ kind: 'used', text: 'Deposit used NPR 5,000' })
    expect(depositBadge(booking('cancelled'), dep({ refunded_amount: 5000, refund_method: 'Cash' }))).toMatchObject({ kind: 'refunded', text: 'Deposit refunded NPR 5,000' })
    expect(depositBadge(booking('booked'), null)).toBe(null)
  })
})

describe('depositActions', () => {
  it('a supervisor takes a deposit on a live booking with none, and not on one already holding money', () => {
    for (const s of ['requested', 'booked', 'confirmed', 'arrived']) {
      expect(depositActions({ reservation: booking(s), deposit: null, canMoney: true }).canTake).toBe(true)
    }
    expect(depositActions({ reservation: booking('booked'), deposit: dep(), canMoney: true }).canTake).toBe(false)
    expect(depositActions({ reservation: booking('booked'), deposit: dep({ refunded_amount: 5000 }), canMoney: true }).canTake).toBe(true)
    expect(depositActions({ reservation: booking('seated'), deposit: null, canMoney: true }).canTake).toBe(false)
    expect(depositActions({ reservation: booking('cancelled'), deposit: null, canMoney: true }).canTake).toBe(false)
  })

  it('a staff login sees the refund due but is offered neither take nor refund', () => {
    const a = depositActions({ reservation: booking('cancelled'), deposit: dep(), canMoney: false })
    expect(a).toMatchObject({ canTake: false, canRefund: false, refundDue: true, balance: 5000 })
  })

  it('refund is offered on any row with a balance and no open bill', () => {
    expect(depositActions({ reservation: booking('booked'), deposit: dep(), canMoney: true }).canRefund).toBe(true)
    expect(depositActions({ reservation: booking('seated'), deposit: dep({ order_id: 'o1' }), canMoney: true, onOpenBill: true }).canRefund).toBe(false)
    expect(depositActions({ reservation: booking('cancelled'), deposit: dep({ refunded_amount: 5000 }), canMoney: true }).canRefund).toBe(false)
  })
})

describe('refundOnEndPlan (always refunded, never kept)', () => {
  it('a supervisor cancelling refunds it in the same flow, saying where the cash goes', () => {
    const p = refundOnEndPlan({ deposit: dep(), canMoney: true })
    expect(p).toMatchObject({ refund: true, amount: 5000 })
    expect(p.text).toMatch(/comes out of the open shift drawer/)
    expect(p.text).toMatch(/never kept/)
    expect(refundOnEndPlan({ deposit: dep({ method: 'eSewa' }), canMoney: true }).text).toMatch(/refunded by eSewa/)
  })

  it('a staff login cancels and leaves it for a supervisor, a deposit on the bill waits for the bill', () => {
    expect(refundOnEndPlan({ deposit: dep(), canMoney: false })).toMatchObject({ refund: false })
    expect(refundOnEndPlan({ deposit: dep(), canMoney: false }).text).toMatch(/Refund due/)
    expect(refundOnEndPlan({ deposit: dep({ order_id: 'o1' }), canMoney: true, onOpenBill: true })).toMatchObject({ refund: false })
  })

  it('says nothing with no deposit or nothing left', () => {
    expect(refundOnEndPlan({ deposit: null, canMoney: true })).toBe(null)
    expect(refundOnEndPlan({ deposit: dep({ used_amount: 5000, order_id: 'o1' }), canMoney: true })).toBe(null)
  })
})

describe('refundConsequence', () => {
  it('names the whole balance, and the drawer only for cash', () => {
    const cash = refundConsequence(dep({ used_amount: 1500, order_id: 'o1' }), 'Sharma')
    expect(cash[0]).toMatch(/NPR 3,500 of deposit DP-7 goes back to Sharma/)
    expect(cash[1]).toMatch(/OPEN shift/)
    expect(refundConsequence(dep({ method: 'Card' }), 'Sharma')[1]).toMatch(/nothing leaves the cash drawer/)
  })
})

describe('parseDepositAmount (through evalMath)', () => {
  it('reads a plain amount, commas and a sum, to the paisa', () => {
    expect(parseDepositAmount('5000')).toEqual({ amount: 5000, error: null })
    expect(parseDepositAmount('10,000')).toEqual({ amount: 10000, error: null })
    expect(parseDepositAmount('2500*4')).toEqual({ amount: 10000, error: null })
    expect(parseDepositAmount('1000/3')).toEqual({ amount: 333.33, error: null })
  })

  it('refuses nothing, zero, a negative and garbage', () => {
    expect(parseDepositAmount('').error).toMatch(/Type the amount/)
    expect(parseDepositAmount('0').error).toMatch(/more than zero/)
    expect(parseDepositAmount('-50').error).toMatch(/more than zero/)
    expect(parseDepositAmount('5oo').error).toMatch(/as a number/)
    expect(parseDepositAmount('5/0').error).toMatch(/as a number/)
  })
})

describe('labels', () => {
  it('numbers and money as they print', () => {
    expect(depositReceiptLabel({ receipt_no: 12 })).toBe('DP-12')
    expect(depositMoney(2499.5)).toBe('NPR 2,499.50')
    expect(depositMoney(100000)).toBe('NPR 1,00,000')
    expect(DEPOSIT_METHODS).toEqual(['Cash', 'Card', 'eSewa', 'Khalti', 'FonePay'])
  })
})
