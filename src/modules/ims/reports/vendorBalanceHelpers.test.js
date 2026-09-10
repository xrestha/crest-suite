// The Vendor Balance Confirmation ledger had no tests until S723, and it is the most intricate
// arithmetic in the reports folder — an opening balance carried across a fiscal-year boundary, a
// chronological Dr/Cr walk, and returns whose value has to be recomputed against a shrinking
// post-discount VAT base. The only check on it was a dev-only `console.assert` inside
// buildFySchedule, which grades the walk against a restatement of the walk: it cannot catch a
// figure that is consistently wrong, and every defect S723 found was consistently wrong.
//
// The letter is signed by a supplier and filed as NSA 17 audit evidence, so the properties that
// matter are reconciliation properties: the sentence in the letter must equal the closing balance,
// and the schedule below it must add up to the same movement.
import { computeVendorBalance, computeOpeningBalance, getFiscalYearAdRange } from './vendorBalanceHelpers'

// FY 2083/84 → Shrawan 2083 to Ashadh 2084.
const FY = 2083
const { start: FY_START, end: FY_END } = getFiscalYearAdRange(FY)

const P = (y, m) => ({ bs_year: y, bs_month: m })
const PRE_FY = P(2083, 2)   // Jestha 2083 — before Shrawan 1
const IN_FY = P(2083, 5)    // Bhadra 2083
const IN_FY_LATER = P(2083, 7) // Kartik 2083

// One purchase line. `qty`/`rate` are the raw line figures; `discount_amount` is the BILL's single
// discount, repeated on every line exactly as purchase_entries stores it.
function line(id, group, period, opts = {}) {
  return {
    id,
    purchase_group_id: group,
    monthly_periods: period,
    bs_day: opts.day ?? 10,
    qty: opts.qty ?? 1,
    rate: opts.rate ?? 1000,
    vat_inclusive: opts.vat ?? false,
    discount_amount: opts.discount ?? 0,
    invoice_ref: opts.ref ?? group,
    vendor_id: 'v1',
    payment_method: opts.method ?? 'Credit',
  }
}

// paid_at is a plain AD `date` column, which is what the helper parses.
const adOf = (period, day) => {
  // Mirrors bsToAd via the helper's own view: build the payment inside the FY window by taking a
  // date the schedule will accept. Using the FY start plus an offset keeps the test independent of
  // the BS table's exact epoch.
  const d = new Date(FY_START)
  d.setDate(d.getDate() + day)
  return d.toISOString().slice(0, 10)
}

function payment(entryId, dayOffset, amount, opts = {}) {
  return {
    purchase_entry_id: entryId,
    paid_at: adOf(null, dayOffset),
    amount,
    note: opts.note ?? null,
    payment_mode: opts.mode ?? 'Cash',
  }
}

function ret(entryId, period, qty, rate, day = 20) {
  return { purchase_entry_id: entryId, monthly_periods: period, bs_day: day, qty, rate }
}

const sum = (rows, pred) => rows.filter(pred).reduce((s, e) => s + e.amount, 0)

describe('the letter reconciles to itself', () => {
  // The letter prints "Opening + Purchases − Payments − Returns = Balance" as a sentence, and the
  // schedule below prints a Net movement total. Both must equal the walked closing balance, or a
  // vendor asked to verify the letter finds two figures that disagree.
  function assertReconciles(result) {
    const { openingBalance, closingBalance, totals, schedule } = result
    const stated = openingBalance + totals.totalPurchasesFy - totals.totalPaymentsFy - totals.totalReturnsFy
    expect(stated).toBeCloseTo(closingBalance, 2)

    const movement = schedule.reduce(
      (s, e) => s + (e.type === 'opening' ? 0 : e.type === 'bill' ? e.amount : -e.amount), 0)
    expect(movement).toBeCloseTo(closingBalance - openingBalance, 2)
  }

  test('a credit bill part-paid inside the year', () => {
    const creditEntries = [line('a1', 'g1', IN_FY, { qty: 2, rate: 1000 })]
    const result = computeVendorBalance({
      creditEntries, cashEntries: [], payments: [payment('a1', 40, 800)], returns: [],
      fyStart: FY_START, fyEnd: FY_END,
    })
    expect(result.openingBalance).toBe(0)
    expect(result.closingBalance).toBeCloseTo(1200, 2)
    assertReconciles(result)
  })

  // The case the schedule could not previously state: a Cash bill is a purchase AND its own
  // settlement. Before S723 "Payments (FY)" counted the settlement while the schedule showed only
  // the purchase, so the headline box and the table below it could not be tied together.
  test('a cash bill contributes a purchase AND a settlement, and nets to zero', () => {
    const cashEntries = [line('c1', 'g2', IN_FY, { qty: 1, rate: 5000, method: 'Cash' })]
    const result = computeVendorBalance({
      creditEntries: [], cashEntries, payments: [], returns: [],
      fyStart: FY_START, fyEnd: FY_END,
    })
    expect(result.closingBalance).toBeCloseTo(0, 2)
    expect(result.totals.totalPurchasesFy).toBeCloseTo(5000, 2)
    expect(result.totals.totalPaymentsFy).toBeCloseTo(5000, 2)
    expect(sum(result.schedule, e => e.type === 'settlement')).toBeCloseTo(5000, 2)
    assertReconciles(result)
  })

  // A return against a cash bill reduces what actually left the register, so the settlement is
  // recorded net — and the return prints as its own line. Purchase − settlement − return = 0.
  test('a cash bill with a return still nets to zero across three lines', () => {
    const cashEntries = [line('c1', 'g2', IN_FY, { qty: 10, rate: 500, method: 'Cash' })]
    const returns = [ret('c1', IN_FY, 2, 500)]
    const result = computeVendorBalance({
      creditEntries: [], cashEntries, payments: [], returns,
      fyStart: FY_START, fyEnd: FY_END,
    })
    expect(result.closingBalance).toBeCloseTo(0, 2)
    expect(sum(result.schedule, e => e.type === 'settlement')).toBeCloseTo(4000, 2)
    expect(sum(result.schedule, e => e.type === 'return')).toBeCloseTo(1000, 2)
    assertReconciles(result)
  })

  // VAT recalculates on the shrinking post-discount base, so a return is never a flat qty × rate.
  // The reconciliation still has to hold with all three moving at once.
  test('a VAT-inclusive credit bill with a discount, a payment and a return', () => {
    const creditEntries = [
      line('a1', 'g3', IN_FY, { qty: 10, rate: 400, vat: true, discount: 500 }),
      line('a2', 'g3', IN_FY, { qty: 5, rate: 200, vat: false, discount: 500 }),
    ]
    const result = computeVendorBalance({
      creditEntries, cashEntries: [],
      payments: [payment('a1', 60, 2000)],
      returns: [ret('a1', IN_FY_LATER, 1, 400, 5)],
      fyStart: FY_START, fyEnd: FY_END,
    })
    assertReconciles(result)
    // The Purchases box states the bill AS BILLED — 4,000 taxable + 1,000 non-taxable, less the
    // 500 bill discount, plus 13% VAT on the taxable portion net of its share of that discount
    // (3,600 x 0.13 = 468). Never a figure already net of the return, which is what made the
    // printed sentence double-count it before S502.
    expect(result.totals.totalPurchasesFy).toBeCloseTo(4968, 2)
  })
})

describe('opening balance', () => {
  test('carries a pre-FY credit bill forward net of pre-FY payments', () => {
    const creditEntries = [line('a1', 'g1', PRE_FY, { qty: 1, rate: 3000 })]
    const payments = [{ purchase_entry_id: 'a1', paid_at: '2026-01-01', amount: 1000, note: null, payment_mode: 'Cash' }]
    const opening = computeOpeningBalance(creditEntries, payments, [], FY_START)
    expect(opening).toBeCloseTo(2000, 2)
  })

  // S723. Returning goods against an already-settled bill leaves the VENDOR owing us money. The
  // old per-bill Math.max(0, …) silently dropped that, so the same credit note appeared in the
  // letter if it fell after Shrawan 1 and vanished if it fell before it.
  test('carries a pre-FY vendor credit forward as a negative, rather than clamping it to zero', () => {
    const creditEntries = [line('a1', 'g1', PRE_FY, { qty: 10, rate: 100 })]
    const payments = [{ purchase_entry_id: 'a1', paid_at: '2026-01-01', amount: 1000, note: null, payment_mode: 'Cash' }]
    const returns = [{ purchase_entry_id: 'a1', monthly_periods: PRE_FY, bs_day: 25, qty: 3, rate: 100 }]
    const opening = computeOpeningBalance(creditEntries, payments, returns, FY_START)
    expect(opening).toBeCloseTo(-300, 2)
  })

  test('a payment dated inside the FY does not reduce the opening balance', () => {
    const creditEntries = [line('a1', 'g1', PRE_FY, { qty: 1, rate: 3000 })]
    const inFyPayment = [payment('a1', 30, 1000)]
    expect(computeOpeningBalance(creditEntries, inFyPayment, [], FY_START)).toBeCloseTo(3000, 2)
    // …and it lands in the schedule instead, so nothing is lost between the two halves.
    const result = computeVendorBalance({
      creditEntries, cashEntries: [], payments: inFyPayment, returns: [],
      fyStart: FY_START, fyEnd: FY_END,
    })
    expect(result.closingBalance).toBeCloseTo(2000, 2)
    expect(sum(result.schedule, e => e.type === 'payment')).toBeCloseTo(1000, 2)
  })
})
