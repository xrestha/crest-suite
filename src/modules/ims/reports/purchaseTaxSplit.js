// The arithmetic behind VAT Report, Non-VAT Report and Payment Summary — the three pages that
// answer "what did we buy, and what do we owe for it" in tax terms.
//
// WHY THIS FILE EXISTS (S722)
//
// `purchase_entries.vat_inclusive` is PER LINE (PurchaseBillForm puts a checkbox on every row, and
// carries a "toggle all" control that exists precisely because a bill is routinely mixed).
// `discount_amount` is PER BILL, repeated on every line. Put those two facts together and one
// bill's discount has to be SPLIT between the VAT report and the Non-VAT report — the two halves
// of one IRD filing.
//
// It was not. VAT Report prorated the discount across the bill and took the VAT share; Non-VAT
// Report ran a query filtered `.eq('vat_inclusive', false)`, so it never saw the VAT lines at all
// and charged the WHOLE bill discount against the non-VAT half. On a 10,000 bill (6,000 VAT +
// 4,000 non-VAT) carrying a 1,000 discount, the two pages between them claimed 1,600 of discount,
// and "non-VAT purchases this period" read 4,000 on one page and 3,000 on the other. Both figures
// are filed.
//
// The fix is not two careful copies. It is one function that splits a period ONCE and hands each
// page its half, so the halves cannot fail to sum back to the bill. `allocateBillDiscounts()` —
// the helper Monthly Summary, Annual Summary, Period Comparison, Budget vs Actual, Consolidated
// P&L and Supplier Contribution already share — is the per-line allocator underneath; this file
// adds only the VAT/non-VAT split and the returns netting on top of it.
//
// A NOTE ON RETURNS. A `vendor_returns` row stores the linked purchase line's LIST rate, which is
// pre-discount, while the base it gets subtracted from is post-discount. Returning a whole
// discounted bill therefore drove the taxable base NEGATIVE by the discount — a negative input VAT
// claim on a statutory report. Every return here is scaled by its own line's net factor, so a full
// return nets to exactly zero.
import { allocateBillDiscounts } from './supplierAttribution'
import { calcBillTotals, billKeyOf } from '../purchases/purchasesHelpers'

export const VAT_RATE = 0.13

/** entry id -> lineNet / lineGross: the fraction of list price that survived the bill's discount. */
export function netFactors(allocated) {
  const f = new Map()
  for (const p of allocated) f.set(p.id, p.lineGross > 0 ? p.lineNet / p.lineGross : 1)
  return f
}

/**
 * The value of a returned line, net of the discount its original purchase carried.
 *
 * Returns are always recorded against a purchase in the SAME period (ReturnsTab only offers that
 * period's purchases, and saving without one is refused), so the lookup effectively always hits.
 * It falls back to the list rate rather than dropping the row: a return nobody can price is still
 * a return, and silently omitting one is the failure mode this whole file exists to stop.
 */
export function returnBase(r, factors) {
  const gross = (parseFloat(r.qty) || 0) * (parseFloat(r.rate) || 0)
  const f = factors.get(r.purchase_entry_id)
  return gross * (f === undefined ? 1 : f)
}

/** Whether the return's original purchase line carried VAT. `vendor_returns` has no column of its
 *  own for this — it is only ever knowable through the join to `purchase_entries`. */
export function isVatReturn(r) { return r.purchase_entries?.vat_inclusive === true }
export function isNonVatReturn(r) { return r.purchase_entries?.vat_inclusive === false }

/**
 * Split one period's purchases into the two halves of the filing.
 *
 * `entries` must be EVERY purchase line of the period, VAT and non-VAT alike — a bill cannot be
 * apportioned from one half of itself. `returns` must be every return of the period, with
 * `purchase_entries(vat_inclusive)` selected.
 */
export function splitPurchaseVat(entries, returns) {
  const allocated = allocateBillDiscounts(entries || [])
  const factors = netFactors(allocated)

  const vatLines = allocated.filter(e => e.vat_inclusive)
  const nonVatLines = allocated.filter(e => !e.vat_inclusive)

  const sum = (rows, k) => rows.reduce((s, r) => s + r[k], 0)
  const vatGross = sum(vatLines, 'lineGross')
  const vatBase = sum(vatLines, 'lineNet')          // taxable base, discount already removed
  const nonVatGross = sum(nonVatLines, 'lineGross')
  const nonVatBase = sum(nonVatLines, 'lineNet')

  const withBase = r => ({ ...r, base: returnBase(r, factors) })
  const vatReturns = (returns || []).filter(isVatReturn).map(withBase)
  const nonVatReturns = (returns || []).filter(isNonVatReturn).map(withBase)
  const vatReturnBase = sum(vatReturns, 'base')
  const nonVatReturnBase = sum(nonVatReturns, 'base')

  const netVatBase = vatBase - vatReturnBase
  const nonVatNet = nonVatBase - nonVatReturnBase

  return {
    allocated, factors,
    vatLines, nonVatLines, vatReturns, nonVatReturns,
    // VAT half — every figure ex-VAT unless the name says otherwise
    vatGross,
    vatDiscount: vatGross - vatBase,
    vatBase,
    vatAmt: vatBase * VAT_RATE,
    vatTotal: vatBase * (1 + VAT_RATE),
    vatReturnBase,
    vatReturnAmt: vatReturnBase * VAT_RATE,
    vatReturnTotal: vatReturnBase * (1 + VAT_RATE),
    netVatBase,
    netVatAmt: netVatBase * VAT_RATE,
    netVatTotal: netVatBase * (1 + VAT_RATE),
    // Non-VAT half — carries no VAT, so base and total are the same number
    nonVatGross,
    nonVatDiscount: nonVatGross - nonVatBase,
    nonVatBase,
    nonVatReturnBase,
    nonVatNet,
    // Both halves together
    totalNetExVat: nonVatNet + netVatBase,
    totalNet: nonVatNet + netVatBase * (1 + VAT_RATE),
  }
}

/**
 * Vendor-wise rollup over lines `allocateBillDiscounts()` has already been through.
 *
 * Shared by VAT Report's CA Summary (VAT lines only) and the Annexure-13 one-lakh disclosure
 * (every line, since that disclosure is about total purchase value, not the taxable slice). The
 * caller decides which lines by what it passes; there is no `discountScope` option any more,
 * because per-line allocation makes "prorate across the bill" and "prorate across its VAT lines"
 * the same arithmetic — `discount x line / billGross` either way. The only thing that ever
 * differed between the two was which lines got summed, which is the caller's business.
 */
export function buildVendorSummary(allocatedEntries, returnRows, factors) {
  const map = {}
  const ensure = (id, name, pan) =>
    (map[id] = map[id] || { name, pan, count: 0, gross: 0, discount: 0, returned: 0 })
  ;(allocatedEntries || []).forEach(e => {
    const v = ensure(e.vendor_id || '__unknown__', e.vendors?.name || 'Unknown Vendor', e.vendors?.pan_vat_no || '')
    v.count += 1
    v.gross += e.lineGross
    v.discount += e.lineGross - e.lineNet
  })
  ;(returnRows || []).forEach(r => {
    const v = ensure(r.vendor_id || '__unknown__', r.vendors?.name || 'Unknown Vendor', r.vendors?.pan_vat_no || '')
    v.returned += r.base !== undefined ? r.base : returnBase(r, factors || new Map())
  })
  return Object.values(map).sort(
    (a, b) => (b.gross - b.discount - b.returned) - (a.gross - a.discount - a.returned)
  )
}

/**
 * What each payment method actually cost, at BILL level.
 *
 * Payment Summary used to sum `qty x rate` per line: ex-VAT, and before the bill discount. That
 * figure is neither the cost basis (which is net of discount) nor the money owed (which includes
 * VAT), so it tied to nothing — not the Purchases register, not Outstanding Payables, not the P&L.
 * This uses `calcBillTotals()`, the same function behind the bill form's live total, the printed
 * purchase voucher, Vendor Report's discount table and Outstanding Payables, so the Credit column
 * and the Outstanding Payables page finally quote one number.
 *
 * `payment_method` is a BILL-level choice written onto every line of the bill, so a bill belongs
 * to exactly one method; NULL reads as Cash, the convention PURCHASE_PAYMENT_METHODS documents.
 */
export function billPayables(entries, returns, period) {
  const p = period || { bs_year: 0, bs_month: 0 }
  const bills = new Map()
  for (const e of entries || []) {
    const key = billKeyOf(e, p)
    let b = bills.get(key)
    if (!b) bills.set(key, b = { key, lines: [], discount: 0, method: e.payment_method || 'Cash', bs_day: e.bs_day })
    b.lines.push(e)
    // max, not sum: the value is repeated on every line of the bill
    b.discount = Math.max(b.discount, parseFloat(e.discount_amount) || 0)
  }
  for (const b of bills.values()) b.total = calcBillTotals(b.lines, b.discount).grandTotal

  const factors = netFactors(allocateBillDiscounts(entries || []))
  // The money that comes back is the money that was paid: the discounted line value, plus its VAT
  // if the original line carried any.
  const priced = (returns || []).map(r => ({
    ...r,
    value: returnBase(r, factors) * (isVatReturn(r) ? 1 + VAT_RATE : 1),
    method: r.payment_method || 'Cash',
  }))

  return { bills: [...bills.values()], returns: priced }
}
