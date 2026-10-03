// Where a settlement's money stands (S798 3b, SETTLEMENT-1, owner decision H4 (a)).
//
// paid_amount is what went out: the paid mark stamps it with net_payout, and Reopen and Finalize leave
// it alone. So a settlement paid, reopened, corrected and finalized again at a different net still
// carries its first payment, and the difference is what this names: still to pay, or overpaid, until
// record_settlement_difference records the top-up (or the money handed back) in paid_adjustments and
// brings paid_amount up to the net. The payroll twin is paymentState() in salaryPayments.js.
//
//   draft   — not finalized (a reopened draft may still carry a paid record: `paid` says how much)
//   unpaid  — finalized, never recorded as paid
//   paid    — what was paid equals the net
//   short   — finalized again at a higher net: `due` is still to pay
//   over    — finalized again at a lower net: `due` is negative, the overpayment

const r2 = n => Math.round((parseFloat(n) || 0) * 100) / 100

export function settlementPaymentState(row) {
  const net = r2(row?.net_payout)
  const recorded = !!row?.paid_at
  // A paid mark always stores paid_amount (S798 GAP-OPERATOR-3); a NULL one is only ever a row paid
  // before that, which the mark stamped with the net.
  const paid = recorded ? r2(row.paid_amount ?? row.net_payout) : 0
  const due = r2(net - paid)
  let state
  if (row?.status !== 'finalized') state = 'draft'
  else if (!recorded) state = 'unpaid'
  else if (due >= 0.01) state = 'short'
  else if (due <= -0.01) state = 'over'
  else state = 'paid'
  return { state, net, paid, due, recorded }
}

// The payments recorded after the first one, oldest first, each { amount, method, at }. amount is
// signed: negative is money handed back.
export function settlementAdjustments(row) {
  const list = Array.isArray(row?.paid_adjustments) ? row.paid_adjustments : []
  return list
    .filter(a => a && Number.isFinite(parseFloat(a.amount)))
    .map(a => ({ amount: r2(a.amount), method: a.method || '', at: a.at || null }))
}

// A settlement whose money is not all accounted for: never paid, or paid short. The Gratuity Tracker's
// banner lists these; an overpayment is shown on the settlement, but nothing is owed TO the leaver.
export function settlementStillOwed(row) {
  const s = settlementPaymentState(row)
  return s.state === 'unpaid' || s.state === 'short'
}
