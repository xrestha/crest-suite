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
import { allocateBillDiscounts, netFactors, returnBase } from './supplierAttribution'
import { calcBillTotals, billKeyOf, billInvoiceAmount, invoiceMismatch } from '../purchases/purchasesHelpers'

export const VAT_RATE = 0.13

// `netFactors` and `returnBase` moved to supplierAttribution.js in S727, beside the
// `allocateBillDiscounts` they are derived from — that file needed them and could not import them
// from here without a cycle. Re-exported so every existing caller of this module is unchanged.
export { netFactors, returnBase }

/**
 * The purchase-line ids this period's returns point at that are NOT among this period's purchases —
 * i.e. returns against a bill from an earlier month (S756, owner decision D10). The page reads those
 * bills whole (every line of each, so the discount apportions correctly) and hands them to
 * `splitPurchaseVat` as `priorBillLines`. Unlinked returns have no line to fetch and are not listed.
 */
export function returnLinesOutsidePeriod(entries, returns) {
  const here = new Set((entries || []).map(e => e.id))
  return [...new Set((returns || [])
    .map(r => r.purchase_entry_id)
    .filter(id => id != null && !here.has(id)))]
}

/**
 * Discount factors for bills from OTHER months. Same arithmetic as the period's own, with one
 * difference: the legacy fallback bill key (vendor + invoice + day, for a line with no
 * purchase_group_id) is scoped by `period_id`, because lines from several months are passed together
 * and day 5 exists in all of them — two months' legacy bills must not merge into one discount.
 */
export function priorBillFactors(lines) {
  if (!lines || lines.length === 0) return new Map()
  const scoped = lines.map(l => (l.purchase_group_id
    ? l
    : { ...l, purchase_group_id: `legacy|${l.period_id || ''}|${l.vendor_id || ''}|${l.invoice_ref || ''}|${l.bs_day}` }))
  return netFactors(allocateBillDiscounts(scoped))
}

function mergeFactors(own, prior) {
  if (!prior || prior.size === 0) return own
  const out = new Map(prior)
  for (const [k, v] of own) out.set(k, v)
  return out
}

/** Whether the return's original purchase line carried VAT. `vendor_returns` has no column of its
 *  own for this — it is only ever knowable through the join to `purchase_entries`.
 *
 *  S756: the three predicates are a COMPLETE partition of every return, and that is the point of
 *  them. They used to be `=== true` and `=== false`, which left two kinds of return in neither half,
 *  silently:
 *
 *  - an UNLINKED return. `vendor_returns.purchase_entry_id` is ON DELETE SET NULL, and both a bill
 *    delete (single or Delete All) and a bill re-save (`save_purchase_bill` deletes the superseded
 *    lines) unlink every return against that bill. Its embed is then null, so nothing can say whether
 *    VAT was charged on it — and it vanished from both statutory reports, overstating the input VAT
 *    claimed on the VAT one.
 *  - a return linked to a legacy line whose `vat_inclusive` is NULL. `splitPurchaseVat` has always put
 *    such a LINE in the non-VAT half (`!e.vat_inclusive`), so its return goes there too now.
 *
 *  An unlinked return is not guessed into a half: it is counted and named by every page that reads
 *  these (the S725 rule — an exclusion a report cannot value must be counted, never dropped). */
export function isUnlinkedReturn(r) { return !r.purchase_entries }
export function isVatReturn(r) { return r.purchase_entries?.vat_inclusive === true }
export function isNonVatReturn(r) { return !isUnlinkedReturn(r) && r.purchase_entries.vat_inclusive !== true }

/**
 * Split one period's purchases into the two halves of the filing.
 *
 * `entries` must be EVERY purchase line of the period, VAT and non-VAT alike — a bill cannot be
 * apportioned from one half of itself. `returns` must be every return of the period, with
 * `purchase_entries(vat_inclusive)` selected.
 */
export function splitPurchaseVat(entries, returns, { priorBillLines } = {}) {
  const allocated = allocateBillDiscounts(entries || [])
  // A return may sit in a LATER month than its bill (S756, D10), so its purchase line is not among
  // this period's `entries` and has no discount factor here — returnBase would fall back to the
  // list rate and reverse more VAT than was ever claimed. The caller passes that bill's lines (every
  // line of it, from its own month) and they are valued the same way. This period's own factors win.
  const factors = mergeFactors(netFactors(allocated), priorBillFactors(priorBillLines))

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
  // Valued at the LIST rate (returnBase's fallback — its purchase line is gone, so there is no
  // discount factor to apply) and deducted from neither half. See isUnlinkedReturn.
  const unlinkedReturns = (returns || []).filter(isUnlinkedReturn).map(withBase)
  const vatReturnBase = sum(vatReturns, 'base')
  const nonVatReturnBase = sum(nonVatReturns, 'base')

  const netVatBase = vatBase - vatReturnBase
  const nonVatNet = nonVatBase - nonVatReturnBase

  return {
    allocated, factors,
    vatLines, nonVatLines, vatReturns, nonVatReturns,
    unlinkedReturns,
    unlinkedReturnBase: sum(unlinkedReturns, 'base'),
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
  // `vendorId` is carried out (S756) so annexure13Rows can keep a PAN-less card on its own row.
  const ensure = (id, name, pan) =>
    (map[id] = map[id] || { vendorId: id, name, pan, bills: new Set(), count: 0, gross: 0, discount: 0, returned: 0, vatAmt: 0 })
  ;(allocatedEntries || []).forEach(e => {
    const v = ensure(e.vendor_id || '__unknown__', e.vendors?.name || 'Unknown Vendor', e.vendors?.pan_vat_no || '')
    // `count` is BILLS, not lines. It was lines, under a column header reading "Bills" on both
    // this rollup's readers — the VAT Report workbook and the Annexure 13 disclosure — so a
    // seven-line bill counted seven times against a figure an accountant ties to the purchase
    // register (S723). `billId` comes from allocateBillDiscounts, which has already grouped by
    // exactly the key VendorReport.js groups by, so the two cannot disagree about what a bill is.
    v.bills.add(e.billId != null ? e.billId : e.id)
    v.gross += e.lineGross
    v.discount += e.lineGross - e.lineNet
    // VAT on the post-discount value of the VAT-inclusive lines only — the same base
    // splitPurchaseVat() levies it on, so a vendor's VAT here sums to the period's own VAT figure.
    if (e.vat_inclusive) v.vatAmt += e.lineNet * VAT_RATE
  })
  ;(returnRows || []).forEach(r => {
    const v = ensure(r.vendor_id || '__unknown__', r.vendors?.name || 'Unknown Vendor', r.vendors?.pan_vat_no || '')
    const base = r.base !== undefined ? r.base : returnBase(r, factors || new Map())
    v.returned += base
    if (isVatReturn(r)) v.vatAmt -= base * VAT_RATE
  })
  return Object.values(map)
    .map(({ bills, ...v }) => {
      const net = v.gross - v.discount - v.returned
      // What the vendor actually invoiced across the year: the net taxable value plus the VAT
      // that rode on it. This is the figure that matches the vendor's own ledger and the money
      // that left the bank; `net` is the ex-VAT cost basis. Both are disclosed, because which one
      // the one-lakh threshold is measured on is a filing decision, not an arithmetic one.
      return { ...v, count: bills.size, net, invoiced: net + v.vatAmt }
    })
    .sort((a, b) => b.net - a.net)
}

/**
 * What a page needs to NAME the unlinked returns it could not place (S756, see isUnlinkedReturn):
 * how many, their list-rate value, and up to `max` readable examples. The sentence around it is the
 * page's own, because what happens to these rows differs — the two tax reports deduct them from
 * neither half, the one-lakh disclosure still deducts them from their supplier.
 */
export function summariseUnlinkedReturns(returns, { max = 10, dayLabel } = {}) {
  const unlinked = (returns || []).filter(isUnlinkedReturn)
  const valueOf = r => (r.base !== undefined ? r.base : returnBase(r, new Map()))
  // A bare day number only reads correctly inside one period; a multi-period caller passes its own.
  const dayOf = dayLabel || (r => (r.bs_day ? `day ${r.bs_day}` : null))
  return {
    count: unlinked.length,
    value: unlinked.reduce((s, r) => s + valueOf(r), 0),
    examples: unlinked.slice(0, max).map(r =>
      [dayOf(r), r.items?.name, r.vendors?.name].filter(Boolean).join(' · ')),
    more: Math.max(0, unlinked.length - max),
  }
}

export const ONE_LAKH = 100000

/** A PAN as typed, reduced to what identifies it: no surrounding or inner whitespace. */
export function normalisePan(pan) {
  return String(pan ?? '').replace(/\s+/g, '')
}

/**
 * The Annexure-13 one-lakh disclosure rows, one per SUPPLIER rather than one per vendor card.
 *
 * WHY (S756, owner decision D12). The disclosure is about a supplier — a PAN — and the vendor master
 * is a list of cards someone typed. "Himalayan Traders" and "Himalayan Traders Pvt Ltd" carrying the
 * same PAN are one supplier; totalled card by card, 60,000 on each is two rows under the threshold
 * and a supplier who sold 1,20,000 is never disclosed. So cards sharing a normalised PAN are summed
 * into one row naming every card, and BOTH threshold tests (ex-VAT net, invoiced total — the S723
 * decision) run on that sum.
 *
 * A card with no PAN cannot be matched to anything, so it stays on its own row and is marked
 * `panMissing` for the page to warn about. Guessing by name would merge two genuinely different
 * suppliers who happen to share one, which is worse than a warning.
 *
 * `vendorRows` is buildVendorSummary()'s output over EVERY line of the fiscal year.
 */
export function annexure13Rows(vendorRows, threshold = ONE_LAKH) {
  const SUMMED = ['count', 'gross', 'discount', 'returned', 'vatAmt', 'net', 'invoiced']
  const groups = new Map()
  for (const v of vendorRows || []) {
    const pan = normalisePan(v.pan)
    const key = pan ? `pan:${pan}` : `card:${v.vendorId}`
    let g = groups.get(key)
    if (!g) {
      groups.set(key, g = { key, pan, names: [], vendorIds: [] })
      for (const k of SUMMED) g[k] = 0
    }
    if (!g.names.includes(v.name)) g.names.push(v.name)
    g.vendorIds.push(v.vendorId)
    // `count` is bills, and a bill belongs to exactly one card, so bills sum across cards.
    for (const k of SUMMED) g[k] += v[k] || 0
  }
  return [...groups.values()]
    .map(g => ({
      ...g,
      name: g.names.join(' / '),
      cards: g.vendorIds.length,
      taxBase: g.gross - g.discount,
      panMissing: !g.pan,
      over: g.net > threshold || g.invoiced > threshold,
    }))
    .sort((a, b) => b.invoiced - a.invoiced)
}

/**
 * One row per purchase INVOICE, for the VAT Report workbook's bill-wise sheet (S756, owner decision
 * D28) — the shape an accountant keys into the IRD purchase book, beside the item-level sheet.
 *
 * Built from allocateBillDiscounts() output over EVERY line of the period, so each bill's discount
 * is already split between its VAT and non-VAT lines exactly as splitPurchaseVat splits it. Taxable
 * therefore sums to `vatBase`, Exempt to `nonVatBase` and VAT to `vatAmt` — the same figures the
 * page and the other sheets show — and a bill's Total is what calcBillTotals says it was invoiced at.
 * Returns are deliberately not here: they are credit notes, not invoices.
 */
export function billWiseVat(allocatedEntries) {
  const bills = new Map()
  for (const e of allocatedEntries || []) {
    const key = e.billId != null ? e.billId : e.id
    let b = bills.get(key)
    if (!b) {
      bills.set(key, b = {
        key, bs_day: e.bs_day, vendor: e.vendors?.name || '', pan: e.vendors?.pan_vat_no || '',
        invoice: e.invoice_ref || '', taxable: 0, exempt: 0, lines: [],
      })
    }
    // Same test splitPurchaseVat uses, so a legacy NULL line lands in the same half on both sheets.
    if (e.vat_inclusive) b.taxable += e.lineNet
    else b.exempt += e.lineNet
    b.lines.push(e)
  }
  return [...bills.values()]
    .map(({ lines, ...b }) => {
      const vat = b.taxable * VAT_RATE
      const total = b.taxable * (1 + VAT_RATE) + b.exempt
      // The supplier's printed figures, when someone typed them (S756, owner decision D13), checked
      // against this row's own VAT and Total — which are calcBillTotals' figures for the bill.
      const invoiceVat = billInvoiceAmount(lines, 'invoice_vat_amount')
      const invoiceTotal = billInvoiceAmount(lines, 'invoice_total_amount')
      const invoiceCheck = invoiceMismatch({ invoiceVat, invoiceTotal }, { vatTotal: vat, grandTotal: total })
      return { ...b, vat, total, invoiceVat, invoiceTotal, invoiceCheck }
    })
    .sort((a, b) => (a.bs_day || 0) - (b.bs_day || 0))
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
