// Pure money arithmetic behind Outstanding Payables — no React, no Supabase — so the three ways a
// supplier bill gets paid can be tested rather than eyeballed (S756 stage 3):
//
//   1. one payment against one bill               allocatePayment            (S505; whole-bill settle S792)
//   2. ONE lump sum against a supplier's bills     planSupplierLumpSum        (D9)
//   3. part of a supplier's credit onto a bill     planBillPayment + credit   (D11)
//
// Every figure here is derived from rows a reader can point at: purchase_entries lines, their
// vendor_returns, and payable_payments. A supplier credit is not a stored balance — it is a bill
// whose payments exceed what is now owed on it (goods returned after it was paid, S723), and using
// it writes a PAIR of payable_payments rows sharing one `credit_link_id`: a negative row on the
// line holding the credit and an equal positive row on the line being paid. The pair nets to zero,
// so no screen that sums payments by line needs to know credits exist, and both bills still add up
// from their own rows. Migration 20260918120000 refuses a pair that does not balance.
import { bsToAd } from '../../../utils/bsCalendar'
import { calcBillTotals, billKeyOf, aging } from '../purchases/purchasesHelpers'

export const EPS = 0.001
// Written to payable_payments.payment_mode. The migration's CHECK spells the same string: a row
// carries this mode exactly when it carries a credit_link_id, so change both or neither.
export const SUPPLIER_CREDIT_MODE = 'Supplier credit'

const toPaisa = n => Math.round((Number(n) || 0) * 100)
const fromPaisa = p => p / 100

/** A payable_payments row that is one half of a supplier-credit pair. */
export function isCreditRow(p) {
  return !!p?.credit_link_id || p?.payment_mode === SUPPLIER_CREDIT_MODE
}

// ── What a bill is owed once goods have gone back (S792, owner decision D33) ─────────────────────

const lineGrossOf = l => (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0)

/**
 * The grand total a supplier is owed on one bill after returns: the one answer Outstanding
 * Payables, the balance letter (vendorBalanceHelpers.js) and Vendor Report's Payable column share.
 *
 * `lines` are the bill's purchase lines (`id`, `qty`, `rate`, `vat_inclusive`), every line of it.
 * `returnedByEntry` is `{ [lineId]: qty × rate of what went back }` — `vendor_returns.rate` is the
 * line's LIST rate. `discount` is the bill's one discount (max over its lines, never a sum).
 *
 * A return is credited at the DISCOUNTED price (D33). This was `calcBillTotals(returns-netted
 * lines, WHOLE discount)`: the return came off at list price and the bill kept every rupee of its
 * discount. On a 6,000 + 4,000 bill with a 1,000 discount and the 4,000 line sent back, the
 * supplier's credit note says 3,600 and 5,400 is still owed; the page said 5,000. Returned whole,
 * the bill read 0 − 1,000 and the balance letter closed on "Advance / Credit Balance NPR 1,000" —
 * the supplier asked to sign that they owe us the discount. VAT Report, Payment Summary and
 * Supplier Contribution already credited returns this way (`returnBase`, S722/S756 D10).
 *
 * The arithmetic is the discount scaled by the share of the bill's gross that stayed: every line
 * then keeps its own `1 − discount / gross` factor, so a return comes off at `list × factor`, plus
 * 13% where its line carried VAT — exactly `returnBase` × VAT, i.e. `billPayables()` in
 * purchaseTaxSplit.js. It is linear in the returns, so two returns against one bill are simply
 * additive, and returns alone can take a bill to 0 but never below it (each line is floored at
 * nothing left, and what is left keeps the discount's own share of it). Unrounded.
 */
export function billOwedAfterReturns(lines, returnedByEntry, discount) {
  const list = lines || []
  const gross = list.reduce((s, l) => s + lineGrossOf(l), 0)
  const kept = list.map(l => ({
    qty: 1,
    rate: Math.max(0, lineGrossOf(l) - ((returnedByEntry || {})[l.id] || 0)),
    vat_inclusive: l.vat_inclusive,
  }))
  const keptGross = kept.reduce((s, l) => s + l.rate, 0)
  const d = Math.max(0, parseFloat(discount) || 0)
  // A bill with no gross at all (every line free) keeps the old answer rather than inventing one.
  const keptDiscount = gross > 0 ? d * (keptGross / gross) : d
  return calcBillTotals(kept, keptDiscount).grandTotal
}

// ── Valuing lines and grouping bills ─────────────────────────────────────────────────────────────
//
// Moved out of the page unchanged so the supplier-credit lookup (which reads one vendor's whole
// credit history, not the tab's bills) values a bill with the SAME arithmetic the table beside it
// uses. Two copies of "what is owed on this bill" would be two answers to it.

/**
 * Stamp each purchase_entries line with netLine / paidTotal / value / remaining.
 * `rows` must be COMPLETE bills (every line) — a bill's discount is not linear in its lines (S723).
 * `returnedByEntry` is list value per line (qty × vendor_returns.rate); the D33 discount is applied
 * here, in billOwedAfterReturns, not by the caller. Mutates and returns the enriched lines.
 */
export function valueBillLines(rows, paymentsByEntry, returnedByEntry, today = new Date()) {
  const enriched = (rows || []).map(e => {
    const pr = e.monthly_periods
    const adDate = bsToAd(pr.bs_year, pr.bs_month, e.bs_day || 1)
    const daysOld = Math.max(0, Math.floor((today - adDate) / (1000 * 60 * 60 * 24)))
    // Net of returns, still EXCLUDING bill-level discount and VAT — those are bill-level, not
    // line-level, so they're applied in the grouping pass below. Only the spread uses this: the
    // bill's total comes from billOwedAfterReturns.
    const netLine = Math.max(0, parseFloat(e.qty) * parseFloat(e.rate) - (returnedByEntry[e.id] || 0))
    const paidTotal = (paymentsByEntry[e.id] || []).reduce((s, p) => s + parseFloat(p.amount), 0)
    return { ...e, period: pr, netLine, paidTotal, daysOld, aging: aging(daysOld), billKey: billKeyOf(e, pr) }
  })

  // What this page shows must be what the vendor actually invoiced. `value` used to be a bare
  // qty × rate: no VAT, no bill discount, no returns — so a VAT-inclusive credit bill read ~13%
  // LOW and "Settle Bill" marked it fully paid at 88.5% of the real amount, while discounts and
  // returns pushed it the other way. calcBillTotals() is the same function PurchaseBillForm's
  // live total and the printed voucher use, so routing through it is what makes the three agree.
  //
  // The grand total is then spread back across the bill's lines in proportion to their net
  // value, because payments allocate per purchase_entry_id — keeping `value` per-line means the
  // existing payment/settle logic needs no changes at all.
  const byBill = {}
  enriched.forEach(e => { (byBill[e.billKey] = byBill[e.billKey] || []).push(e) })
  // Oldest line first, which is the order allocatePayment documents and relies on. It used to
  // fall out of the seed query's own `.order('created_at')`; the sibling read is ordered by id
  // (the paging tiebreaker), so the bill's line order is now stated here instead of inherited.
  Object.values(byBill).forEach(lines => lines.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '') || String(a.id).localeCompare(String(b.id))))
  Object.values(byBill).forEach(lines => {
    // discount_amount is stored on every row of a bill but represents ONE bill-level discount.
    // Every line here already shares one billKey, so the bill's discount is the one value they
    // repeat — max, as VendorReport and allocateBillDiscounts take it (S747). This deduped by
    // `purchase_group_id || l.id`, so a pre-grouping bill (no purchase_group_id, grouped by the
    // vendor|invoice|day fallback) keyed each LINE separately and summed the discount once per
    // line: a five-line bill's discount came off five times and the payable read too low.
    const billDiscount = Math.max(0, ...lines.map(l => parseFloat(l.discount_amount || 0) || 0))
    // S792 (D33): a return comes off at the price the supplier actually charged. This was
    // calcBillTotals over the returns-netted lines with the WHOLE discount kept, so a return was
    // credited at list price — see billOwedAfterReturns for what that did to a fully returned bill.
    const grandTotal = billOwedAfterReturns(lines, returnedByEntry, billDiscount)
    // Rounded to currency precision immediately — a per-line rate can carry 3+ decimals (e.g.
    // NPR/gram costing), so the bill's true net total can land sub-paisa (e.g. NPR 1400.00175)
    // even though every displayed figure shows only 2dp. Left unrounded, "Pay in full" (which
    // pre-fills the editable amount via `.toFixed(2)`) silently truncates that fraction, and
    // Math.min(amount, bill.remaining) then caps the actual payment a hair below the unrounded
    // bill.remaining — the shortfall lands entirely on whichever line allocatePayment() processes
    // last, since its written amount still rounds to a clean figure but the RAW allocation used
    // for the settle check falls just short of e.value, so that line quietly never gets marked
    // paid_at despite showing "fully paid" in the Payment History. Found live (S510): a 5-line
    // bill with two 3-decimal rates left its last line (a clean NPR 120) stuck unsettled after a
    // "Pay in full" that should have closed it. Same fix vendorBalanceHelpers.js's
    // billGrandTotal() already applies for the identical root cause.
    const netSum = lines.reduce((s, l) => s + l.netLine, 0)
    lines.forEach(l => {
      l.value = netSum > 0 ? Math.round(l.netLine * (grandTotal / netSum) * 100) / 100 : 0
      // No Math.max(0, …) any more (S723). A return recorded against an already-settled bill
      // makes it over-paid — the vendor now owes US — and ReturnsTab has no guard against that,
      // nor should it: that is exactly what a credit note is. Clamping it to zero made the
      // money disappear from the only screen that tracks what is owed either way. A negative
      // remaining is surfaced as a Credit below; it can never be paid, since allocatePayment
      // skips any line at or under EPS and the bulk selector filters on `remaining > EPS`.
      l.remaining = Math.round((l.value - l.paidTotal) * 100) / 100
    })
  })
  return enriched
}

/** Group valued lines into bills with totals, payments and status flags. */
export function groupIntoBills(lines, paymentsByEntry) {
  const billMap = {}
  ;(lines || []).forEach(e => {
    const key = e.billKey
    if (!billMap[key]) billMap[key] = { key, vendorName: e.vendors?.name || 'Unknown', vendorId: e.vendors?.id || e.vendor_id || null, invoice_ref: e.invoice_ref, period: e.period, bs_day: e.bs_day, entries: [] }
    billMap[key].entries.push(e)
  })
  return Object.values(billMap).map(b => {
    const total     = b.entries.reduce((s, e) => s + e.value, 0)
    const paid      = b.entries.reduce((s, e) => s + e.paidTotal, 0)
    const remaining = b.entries.reduce((s, e) => s + e.remaining, 0)
    const daysOld   = Math.max(0, ...b.entries.map(e => e.daysOld))
    const payments  = b.entries.flatMap(e => (paymentsByEntry[e.id] || [])).sort((x, y) => (x.paid_at > y.paid_at ? 1 : -1))
    const settledOn = b.entries.map(e => e.paid_at).filter(Boolean).sort().slice(-1)[0] || null
    const creditIn  = payments.filter(p => isCreditRow(p) && parseFloat(p.amount) > 0).reduce((s, p) => s + parseFloat(p.amount), 0)
    const creditOut = -payments.filter(p => isCreditRow(p) && parseFloat(p.amount) < 0).reduce((s, p) => s + parseFloat(p.amount), 0)
    return {
      ...b, total, paid, remaining, daysOld, aging: aging(daysOld), payments, settledOn,
      // Supplier credit this bill received from another bill, and credit taken out of it.
      creditIn, creditOut,
      isPartial: paid > EPS && remaining > EPS,
      isCredit: remaining < -EPS,
    }
  })
}

/** Oldest bill first: bill date, then the earliest line's entry time, then key (stable). */
export function compareBillsOldestFirst(a, b) {
  const pa = a.period || {}, pb = b.period || {}
  return ((pa.bs_year || 0) - (pb.bs_year || 0))
    || ((pa.bs_month || 0) - (pb.bs_month || 0))
    || ((a.bs_day || 0) - (b.bs_day || 0))
    || firstCreated(a).localeCompare(firstCreated(b))
    || String(a.key).localeCompare(String(b.key))
}
function firstCreated(bill) {
  return (bill.entries || []).map(e => e.created_at || '').filter(Boolean).sort()[0] || ''
}

// ── Splitting an amount across lines ─────────────────────────────────────────────────────────────

// Splits `amount` across lines' remaining balances, oldest line first, with running-cumulative
// rounding so the parts always sum to exactly the rounded amount (S505: per-line rounding lost a
// paisa across a 10-line bill and left an uncollectable NPR 0.01). Returns the raw and rounded part
// per line; lines at or under EPS take nothing.
function splitAcrossLines(lines, amount) {
  let left = amount
  let rawSoFar = 0
  let roundedSoFar = 0
  const parts = []
  for (const e of lines) {
    if (left <= EPS) break
    if (e.remaining <= EPS) continue
    const raw = Math.min(e.remaining, left)
    rawSoFar += raw
    const cumulative = Math.round(rawSoFar * 100) / 100
    const rounded = Math.round((cumulative - roundedSoFar) * 100) / 100
    roundedSoFar = cumulative
    left -= raw
    if (rounded <= 0) continue
    parts.push({ line: e, raw, amount: rounded })
  }
  return parts
}

/**
 * The lines a payment settles (their `paid_at` gets stamped), given `rawById` — what this payment
 * puts on each line, unrounded.
 *
 * A line that received money settles when it has now been paid its own value, as since S505. And,
 * since S792 (PURCHASES-8), when the BILL owes nothing after this payment, every one of its lines
 * that is still unstamped settles too — including lines that received nothing. Only lines that
 * received money used to be stamped, so a bill whose first line was paid and then returned (that
 * line now over-paid) and whose second line was then paid the bill's remaining never closed: the
 * second line got the bill's balance, which is less than its own value, and nothing was stamped.
 * The bill sat on Outstanding for ever at "0 remaining". Half a paisa of tolerance, as the lump sum
 * uses: `remaining` is a sum of 2dp figures and carries float noise, never a real balance.
 */
function settledLineIds(entries, rawById) {
  const lines = entries || []
  const after = lines.reduce((s, e) => s + e.remaining - (rawById.get(e.id) || 0), 0)
  const wholeBill = after < 0.005
  return lines
    .filter(e => (rawById.has(e.id) && e.paidTotal + rawById.get(e.id) >= e.value - EPS) || (wholeBill && !e.paid_at))
    .map(e => e.id)
}

/**
 * One payment spread across a bill's unpaid lines, oldest first. Returns the payable_payments rows
 * to insert and the ids of lines this payment settles. `entries` must be every line of the bill.
 */
export function allocatePayment(entries, amount, date, note, paymentMode) {
  const parts = splitAcrossLines(entries, amount)
  return {
    rows: parts.map(p => ({ purchase_entry_id: p.line.id, amount: p.amount, paid_at: date, note, payment_mode: paymentMode || null })),
    settleIds: settledLineIds(entries, new Map(parts.map(p => [p.line.id, p.raw]))),
  }
}

/**
 * The lines to stamp when a bill with nothing left to pay is closed by hand (S792, PURCHASES-8):
 * every line not stamped yet, or [] when the bill still owes something.
 *
 * A Credit bill whose goods all went back owes 0, receives no payment, and so never had a line
 * stamped — it stayed on Outstanding with a red "90+ days" chip and no control that could close it.
 * The same holds for a bill left in credit by a return (the vendor owes US): nothing can be paid on
 * it, and its credit stays usable from Paid History (supplierCreditSlots reads every bill).
 */
export function linesToCloseByReturns(bill) {
  if (!bill || !(bill.remaining <= EPS)) return []
  return (bill.entries || []).filter(e => !e.paid_at).map(e => e.id)
}

// ── D9: one lump sum for a supplier ──────────────────────────────────────────────────────────────

/**
 * Apply ONE amount to a supplier's unpaid bills, oldest bill first, each bill's share spread
 * across its lines exactly as a per-bill payment would be.
 *
 * Refuses (returns `error`) an amount above what the supplier is owed in total, rather than
 * inventing a credit nobody can point at: an overpayment is a real event and belongs on the next
 * bill, not in a balance this page made up.
 *
 * `bills` are grouped bills (groupIntoBills) for ONE supplier; credit bills and settled bills are
 * skipped. Returns { rows, settleIds, split, total, amount, error }.
 */
export function planSupplierLumpSum(bills, amount, { date, note, paymentMode } = {}) {
  const unpaid = (bills || []).filter(b => b.remaining > EPS).sort(compareBillsOldestFirst)
  const total = Math.round(unpaid.reduce((s, b) => s + b.remaining, 0) * 100) / 100
  const want = Number(amount)
  if (!Number.isFinite(want) || want <= 0) return { rows: [], settleIds: [], split: [], total, amount: 0, error: 'amount' }
  // Half a paisa of tolerance absorbs float noise in a summed balance, never a rupee.
  if (want > total + 0.005) return { rows: [], settleIds: [], split: [], total, amount: want, error: 'over' }

  const pay = Math.min(want, total)
  const rows = []
  const settleIds = []
  const split = []
  let left = pay
  let rawSoFar = 0
  let roundedSoFar = 0
  for (const b of unpaid) {
    if (left <= EPS) {
      split.push({ bill: b, pay: 0, after: b.remaining, settles: false })
      continue
    }
    const raw = Math.min(b.remaining, left)
    rawSoFar += raw
    const cumulative = Math.round(rawSoFar * 100) / 100
    const share = Math.round((cumulative - roundedSoFar) * 100) / 100
    roundedSoFar = cumulative
    left -= raw
    const alloc = allocatePayment(b.entries, share, date, note, paymentMode)
    rows.push(...alloc.rows)
    settleIds.push(...alloc.settleIds)
    const after = Math.round((b.remaining - share) * 100) / 100
    split.push({ bill: b, pay: share, after: after < 0.005 ? 0 : after, settles: after < 0.005 })
  }
  return { rows, settleIds, split, total, amount: Math.round(pay * 100) / 100, error: null }
}

// ── D11: settling with supplier credit ───────────────────────────────────────────────────────────

/**
 * Where a supplier's credit sits, as slots a credit can be taken from.
 *
 * A bill's credit is −remaining. It is taken from the lines that are themselves over-paid, most
 * over-paid first, and never more than the BILL's credit: a bill can hold one over-paid line and
 * one still-owed line, and taking the over-paid line's whole excess would turn the bill back into
 * one that is owed money.
 *
 * Returns { available, bills: [{ bill, credit }], slots: [{ line, bill, capPaisa }] }.
 */
export function supplierCreditSlots(bills) {
  const creditBills = (bills || []).filter(b => b.remaining < -EPS).sort(compareBillsOldestFirst)
  const slots = []
  const out = []
  let availablePaisa = 0
  for (const b of creditBills) {
    let billLeft = toPaisa(-b.remaining)
    const billCredit = billLeft
    const lines = b.entries.filter(l => l.remaining < -EPS).sort((x, y) => x.remaining - y.remaining)
    for (const l of lines) {
      if (billLeft <= 0) break
      const cap = Math.min(toPaisa(-l.remaining), billLeft)
      if (cap <= 0) continue
      slots.push({ line: l, bill: b, capPaisa: cap })
      billLeft -= cap
    }
    const usable = billCredit - billLeft
    if (usable > 0) { out.push({ bill: b, credit: fromPaisa(usable) }); availablePaisa += usable }
  }
  return { available: fromPaisa(availablePaisa), bills: out, slots }
}

/**
 * Why a per-bill payment cannot be saved as entered, per box ('' when it can).
 * `cash` and `credit` are what was typed (strings or numbers; blank = 0).
 */
export function billPaymentProblems({ cash, credit, remaining, available = 0, fmt = n => `NPR ${n.toFixed(2)}` }) {
  const c = blankToZero(cash)
  const k = blankToZero(credit)
  const out = { cash: '', credit: '' }
  if (Number.isNaN(c) || c < 0) out.cash = 'Enter the amount paid as a number, or leave it blank.'
  if (Number.isNaN(k) || k < 0) out.credit = 'Enter the credit to use as a number, or leave it blank.'
  if (out.cash || out.credit) return out
  if (k > available + 0.005) {
    out.credit = `This supplier has ${fmt(available)} of credit to use. Enter that or less.`
  } else if (k > remaining + 0.005) {
    out.credit = `This bill has ${fmt(remaining)} left to pay, so no more than that of the credit can go on it.`
  } else if (c + k > remaining + 0.005) {
    out.cash = `This bill has ${fmt(remaining)} left to pay and ${fmt(k)} of it is coming from supplier credit, so pay ${fmt(Math.max(0, remaining - k))} or less — if you paid the supplier more, record the rest against their next bill.`
  }
  return out
}
function blankToZero(v) {
  if (v === '' || v == null) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

/**
 * The rows for paying one bill with any mix of supplier credit and money.
 *
 * Credit is applied first, then the money, each spread oldest line first. The credit is then
 * PAIRED paisa for paisa with the slots it is taken from, one `credit_link_id` per (source line,
 * target line) pair, so every pair is two rows that are equal and opposite — which is exactly what
 * the migration checks. Callers must have validated with billPaymentProblems first; this function
 * caps at what is owed and available rather than throwing.
 *
 * Returns { rows, settleIds, creditPairs }.
 */
export function planBillPayment(bill, { cash = 0, credit = 0, date, note, paymentMode, creditSlots = [], newId }) {
  const makeId = newId || randomUuid
  const lines = bill.entries.map(e => ({ ...e }))
  const byId = new Map(lines.map(l => [l.id, l]))
  const rawById = new Map()

  const creditCap = Math.min(Number(credit) || 0, Math.max(0, bill.remaining), fromPaisa(creditSlots.reduce((s, x) => s + x.capPaisa, 0)))
  const creditParts = creditCap > EPS ? splitAcrossLines(lines, creditCap) : []
  creditParts.forEach(p => {
    rawById.set(p.line.id, (rawById.get(p.line.id) || 0) + p.raw)
    const l = byId.get(p.line.id)
    l.paidTotal += p.raw
    l.remaining -= p.raw
  })

  const rows = []
  const creditPairs = []
  // Two-pointer walk in whole paisa: both sides sum to the same rounded credit, so it closes exactly.
  let si = 0
  let slotLeft = creditSlots[0]?.capPaisa || 0
  for (const part of creditParts) {
    let need = toPaisa(part.amount)
    while (need > 0 && si < creditSlots.length) {
      if (slotLeft <= 0) { si += 1; slotLeft = creditSlots[si]?.capPaisa || 0; continue }
      const take = Math.min(need, slotLeft)
      const slot = creditSlots[si]
      const linkId = makeId()
      const amt = fromPaisa(take)
      rows.push({
        purchase_entry_id: part.line.id, amount: amt, paid_at: date,
        note: `Supplier credit from bill #${slot.bill.invoice_ref || '—'}`,
        payment_mode: SUPPLIER_CREDIT_MODE, credit_link_id: linkId,
      })
      rows.push({
        purchase_entry_id: slot.line.id, amount: -amt, paid_at: date,
        note: `Supplier credit used on bill #${bill.invoice_ref || '—'}`,
        payment_mode: SUPPLIER_CREDIT_MODE, credit_link_id: linkId,
      })
      creditPairs.push({ linkId, fromLineId: slot.line.id, fromBill: slot.bill, toLineId: part.line.id, amount: amt })
      need -= take
      slotLeft -= take
    }
  }

  const cashAmount = Math.min(Number(cash) || 0, Math.max(0, lines.reduce((s, l) => s + l.remaining, 0)))
  const cashParts = cashAmount > EPS ? splitAcrossLines(lines, cashAmount) : []
  cashParts.forEach(p => {
    rawById.set(p.line.id, (rawById.get(p.line.id) || 0) + p.raw)
    rows.push({ purchase_entry_id: p.line.id, amount: p.amount, paid_at: date, note, payment_mode: paymentMode || null })
  })

  const settleIds = settledLineIds(bill.entries, rawById)
  return { rows, settleIds, creditPairs }
}

function randomUuid() {
  const c = typeof window !== 'undefined' ? window.crypto : undefined
  if (c?.randomUUID) return c.randomUUID()
  const b = new Uint8Array(16)
  if (c?.getRandomValues) c.getRandomValues(b)
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * What deleting payments does to their credit partners: the ids to delete are the selected rows
 * plus every row sharing a credit_link_id with one of them, so a pair is never split.
 * Returns { ids, linkIds } — `linkIds` for a query that reaches partners on bills not on screen.
 */
export function expandCreditPartners(selected) {
  const linkIds = [...new Set((selected || []).map(p => p.credit_link_id).filter(Boolean))]
  return { ids: (selected || []).map(p => p.id), linkIds }
}

/**
 * The lines a set of REMOVED payments reopens: a line whose removed rows sum positive has lost
 * money it was paid; a line whose removed rows sum negative got its supplier credit back and stays
 * settled.
 */
export function linesToReopen(removedRows) {
  const net = new Map()
  ;(removedRows || []).forEach(r => net.set(r.purchase_entry_id, (net.get(r.purchase_entry_id) || 0) + parseFloat(r.amount)))
  return [...net.entries()].filter(([, v]) => v > EPS).map(([id]) => id)
}

// ── Deleting a return from a settled bill (S792 stage 2) ─────────────────────────────────────────

/**
 * What a bill totals on Outstanding Payables: billOwedAfterReturns spread back across the lines and
 * rounded per line, exactly as valueBillLines does, so a decision taken here is taken on the figure
 * that page will show — not on one a paisa away from it.
 */
function billTotalAsListed(lines, returnedByEntry, discount) {
  const grand = billOwedAfterReturns(lines, returnedByEntry, discount)
  const nets = lines.map(l => Math.max(0, lineGrossOf(l) - (returnedByEntry[l.id] || 0)))
  const netSum = nets.reduce((s, n) => s + n, 0)
  return nets.reduce((s, n) => s + (netSum > 0 ? Math.round(n * (grand / netSum) * 100) / 100 : 0), 0)
}

/**
 * Whether deleting one vendor return puts a SETTLED bill back in debt — and so whether its
 * `paid_at` stamps must be cleared, which is what moves a bill from Paid History back to
 * Outstanding Payables (the tabs are keyed on `paid_at`, S723).
 *
 * A return lowers what a bill owes, so a bill can be settled BY a return: paid down to what the
 * return left, or closed with "Close this bill" once its goods all went back (PURCHASES-8). Delete
 * that return and the bill owes again — while its stamps still file it under Paid History, where
 * nothing can be paid on it and nothing adds it to what the supplier is owed.
 *
 * Reopens only when all three hold:
 *   - the bill is stamped (any line carries `paid_at`);
 *   - by its RECORDED figures it is settled now: payments ≥ what it owes after its returns. A bill
 *     stamped with no payment rows that still shows money owed was paid before payable_payments
 *     existed; its stamp is the only record of that payment, and flipping it would put a paid bill
 *     back on Outstanding;
 *   - without this return it would owe more than EPS. A bill left in credit by several returns can
 *     lose one and still be settled.
 *
 * `lines` every line of the bill (`id`, `qty`, `rate`, `vat_inclusive`, `discount_amount`,
 * `paid_at`). `returns` every vendor_returns row against those lines, from ANY month (`id`,
 * `purchase_entry_id`, `qty`, `rate` — the line's list rate; the discount is applied here, D33).
 * `payments` every payable_payments row on those lines (`purchase_entry_id`, `amount`; a supplier
 * credit half is signed and counts as it does on the page). `returnId` is the return being deleted;
 * `newQty` (default 0) is what it would become — 0 is a delete, so an edit can ask the same question.
 *
 * Returns { reopen, stampedIds, owedNow, owedAfter, paid, owedAgain } — money to the paisa, and
 * `owedAgain` 0 unless `reopen`.
 */
export function returnChangeReopensBill({ lines, returns, payments, returnId, newQty = 0 }) {
  const list = lines || []
  const ids = new Set(list.map(l => l.id))
  const stampedIds = list.filter(l => l.paid_at).map(l => l.id)
  // One bill-level discount, repeated on every line — max, never a sum (S601/S747).
  const discount = Math.max(0, ...list.map(l => parseFloat(l.discount_amount) || 0))
  const returnedBy = rows => {
    const m = {}
    rows.forEach(r => {
      if (!ids.has(r.purchase_entry_id)) return
      m[r.purchase_entry_id] = (m[r.purchase_entry_id] || 0) + (parseFloat(r.qty) || 0) * (parseFloat(r.rate) || 0)
    })
    return m
  }
  const all = returns || []
  const changed = all.map(r => (r.id === returnId ? { ...r, qty: Math.max(0, parseFloat(newQty) || 0) } : r))
  const round = n => Math.round(n * 100) / 100
  const owedNow = round(billTotalAsListed(list, returnedBy(all), discount))
  const owedAfter = round(billTotalAsListed(list, returnedBy(changed), discount))
  const paid = round((payments || []).reduce((s, p) => s + (ids.has(p.purchase_entry_id) ? parseFloat(p.amount) || 0 : 0), 0))
  const settledNow = paid >= owedNow - EPS
  const gap = round(owedAfter - paid)
  const reopen = stampedIds.length > 0 && settledNow && gap > EPS
  return { reopen, stampedIds, owedNow, owedAfter, paid, owedAgain: reopen ? gap : 0 }
}

/**
 * returnChangeReopensBill for an EDIT of a return (S792 stage 2 review, P1): the same question, the
 * same three rules and the same result, asked of the return AS IT WILL BE WRITTEN. `newQty` covers
 * an edit that keeps its line; an edit can also re-link the return to another line, and the form
 * writes the new line's rate with it. `next` is `{ purchase_entry_id, qty, rate }`, or null for a
 * delete.
 *
 * `lines`, `returns` and `payments` are the bill the return sits on NOW. A return re-linked to a
 * line outside `lines` leaves this bill, which here is its delete. A move to another line of the
 * SAME bill is not a delete: the return stays on the bill, at that line's rate and VAT — treating
 * it as one would clear the stamps of a bill the write leaves settled.
 *
 * The bill a return moves TO only gains a return, and a return can only lower what a bill owes
 * (billOwedAfterReturns is non-increasing in every line's returns), so that bill never needs this
 * question asked — beyond the per-line paisa rounding Outstanding Payables itself shows, which a
 * real return outweighs. Asked anyway (`returnId` absent from `returns`), it says so: pinned in
 * payablesAllocation.test.js.
 */
export function returnEditReopensBill({ lines, returns, payments, returnId, next = null }) {
  const onBill = new Set((lines || []).map(l => l.id))
  const others = (returns || []).filter(r => r.id !== returnId)
  const edited = next && onBill.has(next.purchase_entry_id)
    ? [...others, { id: returnId, purchase_entry_id: next.purchase_entry_id, qty: next.qty, rate: next.rate }]
    : others
  // Valued through the helper above, so both questions read a bill one way.
  const now = returnChangeReopensBill({ lines, returns, payments, returnId: null })
  const owedAfter = returnChangeReopensBill({ lines, returns: edited, payments, returnId: null }).owedNow
  const settledNow = now.paid >= now.owedNow - EPS
  const gap = Math.round((owedAfter - now.paid) * 100) / 100
  const reopen = now.stampedIds.length > 0 && settledNow && gap > EPS
  return { reopen, stampedIds: now.stampedIds, owedNow: now.owedNow, owedAfter, paid: now.paid, owedAgain: reopen ? gap : 0 }
}
