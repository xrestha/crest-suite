import { computeOrderAmounts, computeGroupAmounts } from '../../../utils/posBillingMath'

// The Sales Report's row arithmetic, lifted out of SalesReport.jsx (S754) so the two owner
// decisions it carries can be asserted rather than eyeballed:
//
//  1. A SPLIT bill is spread across the payment methods it was actually paid with, in proportion to
//     each leg's amount (pos_order_payments). Before this the whole bill sat under 'Split' — a
//     method nobody pays with — so Payment Summary's Cash could never tie to the shift Z-report,
//     which has always counted each leg under its own method.
//  2. A CREDIT NOTE is a MINUS row on the day it was ISSUED. The original bill stays at full value on
//     its own day. Before this, a credit-noted bill simply vanished from every tab — including from
//     the day it was really sold on, which no longer matched the Z-report or the bill book — and the
//     reversal appeared nowhere at all.
//
// Every figure here is built from computeOrderAmounts / computeGroupAmounts (posBillingMath.js),
// never a second copy of the discount-and-VAT rule.

export const NOT_RECORDED = 'Not recorded'
export const SPLIT_NO_BREAKDOWN = 'Split (breakdown missing)'

export const AMOUNT_KEYS = ['gross', 'discount', 'taxable', 'nonTaxable', 'vat', 'net']

const num = v => Number(v) || 0

export function zeroAmounts() {
  return { gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0, qty: 0 }
}

/** A bill's figures in the report's vocabulary. `items` must already exclude comped lines. */
export function billAmounts(order, items, vatReg) {
  const a = computeOrderAmounts(order, items || [], vatReg)
  return {
    gross: a.grossAmt, discount: a.discount, taxable: a.taxableBase, nonTaxable: a.nonTaxableBase,
    vat: a.vatAmt, net: a.net, qty: a.totalQty,
  }
}

/**
 * A credit note's figures as a MINUS row. Amounts are the note's own STORED figures — the numbers
 * printed on the document, computed at issue from the bill's charged lines (IssueCreditNoteModal).
 * The note stores no lines, so the returned quantity is the credited bill's charged lines, which is
 * what a whole-bill credit note returns (partial credits are not supported, decision 2026-08-18).
 */
export function creditNoteAmounts(note, originalItems) {
  return {
    gross: -num(note.gross_amount),
    discount: -num(note.discount_amount),
    taxable: -num(note.taxable_amount),
    nonTaxable: -num(note.non_taxable_amount),
    vat: -num(note.vat_amount),
    net: -num(note.net_amount),
    qty: -(originalItems || []).reduce((s, i) => s + num(i.qty), 0),
  }
}

export function addAmounts(target, amounts, factor = 1) {
  for (const k of [...AMOUNT_KEYS, 'qty']) {
    if (amounts[k] != null) target[k] = (target[k] || 0) + amounts[k] * factor
  }
  return target
}

/**
 * One list of everything that moves revenue in the range: every paid bill CLOSED in it, and every
 * credit note ISSUED in it. `at` is the moment the row belongs to — the bill's close, the note's
 * issue — so a tab that buckets by day or hour buckets both the same way.
 *
 * `orderById` must hold the credited bills too, including ones closed before the range.
 */
export function buildSalesEntries({ orders, creditNotes, orderById, itemsByOrder, vatReg }) {
  const entries = []
  for (const o of orders || []) {
    entries.push({ kind: 'bill', key: o.id, at: o.closed_at, order: o, note: null,
      amounts: billAmounts(o, itemsByOrder[o.id], vatReg) })
  }
  for (const n of creditNotes || []) {
    const order = orderById[n.order_id] || null
    entries.push({ kind: 'return', key: `cn:${n.id}`, at: n.created_at, order, note: n,
      amounts: creditNoteAmounts(n, order ? itemsByOrder[order.id] : []) })
  }
  return entries
}

/** The payment method a bill was recorded under. A blank one is named, never assumed to be Cash. */
export function billMethodOf(order) {
  return (order && order.payment_method) || NOT_RECORDED
}

/**
 * [{ method, share }] with shares summing to 1.
 *
 * A Split bill is shared across its legs by amount. A Loyalty redemption always arrives as a Split
 * bill (applying one switches the till into split mode, and redeem_loyalty_points writes the
 * 'Loyalty' leg itself), so it gets its own row here from its leg. A Split bill with no legs — the
 * split breakdown write can fail after the bill has closed (PosOrders.jsx warns about it) — is kept
 * whole under SPLIT_NO_BREAKDOWN rather than dropped, so the tab's total still ties to every other
 * tab's.
 */
export function paymentSharesOf(order, legs) {
  const method = billMethodOf(order)
  if (method !== 'Split') return [{ method, share: 1 }]
  const byMethod = new Map()
  for (const l of legs || []) {
    const amount = num(l.amount)
    if (amount <= 0) continue
    const m = l.payment_method || NOT_RECORDED
    byMethod.set(m, (byMethod.get(m) || 0) + amount)
  }
  const total = [...byMethod.values()].reduce((s, a) => s + a, 0)
  if (total <= 0) return [{ method: SPLIT_NO_BREAKDOWN, share: 1 }]
  return [...byMethod.entries()].map(([m, a]) => ({ method: m, share: a / total }))
}

/**
 * Spreads one row's figures across shares. The last share takes the remainder rather than its own
 * product, so the parts always add back to the whole — a proportional split that loses a paisa per
 * bill is a Payment Summary that never ties to Daily.
 */
export function allocateAmounts(amounts, shares) {
  const running = zeroAmounts()
  return shares.map((s, idx) => {
    const last = idx === shares.length - 1
    const part = { method: s.method, share: s.share }
    for (const k of [...AMOUNT_KEYS, 'qty']) {
      const whole = amounts[k] || 0
      part[k] = last ? whole - running[k] : whole * s.share
      running[k] += part[k]
    }
    return part
  })
}

/**
 * Payment Summary rows. A split bill counts once under EACH method it used (so a column of bill
 * counts can add up to more than the bills — the total row uses distinct bills). A credit note is
 * attributed to the ORIGINAL bill's payment method(s), in the same proportions, and its net is also
 * kept apart as `returnNet` so "what the bills collected" (Net − returnNet) can be read off and
 * matched to the Z-report.
 */
export function buildPaymentRows(entries, paymentsByOrder) {
  const grouped = {}
  const ensure = m => (grouped[m] = grouped[m] || { method: m, bills: 0, returns: 0, ...zeroAmounts(), returnNet: 0 })
  for (const e of entries) {
    const shares = e.order ? paymentSharesOf(e.order, paymentsByOrder[e.order.id]) : [{ method: NOT_RECORDED, share: 1 }]
    for (const part of allocateAmounts(e.amounts, shares)) {
      const row = ensure(part.method)
      if (e.kind === 'bill') row.bills += 1
      else { row.returns += 1; row.returnNet += part.net }
      addAmounts(row, part)
    }
  }
  return Object.values(grouped)
}

export function sortByMethodOrder(rows, order) {
  const rank = m => {
    const i = order.indexOf(m)
    if (i !== -1) return i
    // Anything not on the display list still gets a row — after the known methods, with the two
    // "we could not tell" rows last so they read as exceptions rather than as a tender.
    return m === SPLIT_NO_BREAKDOWN || m === NOT_RECORDED ? 1000 : 500
  }
  return [...rows].sort((a, b) => rank(a.method) - rank(b.method) || String(a.method).localeCompare(String(b.method)))
}

/**
 * Category / Product Type / Item Wise. A bill contributes its lines as sales; a credit note issued in
 * the range contributes the credited bill's charged lines as RETURNS — `qtyReturn` up, every amount
 * down — spread with the same discount ratio the bill used (computeGroupAmounts), which is also how
 * creditNotePosting.js reverses the bill in Inventory: comped lines skipped (the caller's items
 * already exclude them), the bill discount spread by one ratio.
 */
export function buildGroupedRows({ orders, creditNotes, orderById, itemsByOrder, vatReg, keyOf, labelOf }) {
  const grouped = {}
  const ensure = (key, name) => (grouped[key] = grouped[key] || { key, name, qtySales: 0, qtyReturn: 0, gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0 })
  const add = (order, items, sign) => {
    const byKey = computeGroupAmounts(order, items || [], vatReg, keyOf, i => ({ name: labelOf(i) }))
    for (const [key, v] of Object.entries(byKey)) {
      const b = ensure(key, v.name)
      if (sign > 0) b.qtySales += v.qty
      else b.qtyReturn += v.qty
      b.gross += sign * v.gross; b.discount += sign * v.discount
      b.taxable += sign * v.taxable; b.nonTaxable += sign * v.nonTaxable; b.vat += sign * v.vat
    }
  }
  for (const o of orders || []) add(o, itemsByOrder[o.id], 1)
  for (const n of creditNotes || []) {
    const o = orderById[n.order_id]
    if (o) add(o, itemsByOrder[o.id], -1)
  }
  return Object.values(grouped).sort((a, b) => (b.gross - b.discount + b.vat) - (a.gross - a.discount + a.vat))
}

/** A party name as the 1L+ merge compares it: trimmed, internal whitespace collapsed, case-folded. */
export function partyNameKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

const PARTY_AMOUNT_KEYS = ['bills', 'returns', 'gross', 'taxable', 'nonTaxable', 'vat', 'net']

/**
 * Annexure 13: fold a name-only party (no PAN) into the party with a PAN recorded under the same
 * name. The same customer is routinely billed once with a PAN and once without, and kept apart the
 * two rows can each sit under one lakh while the customer is over it.
 *
 * If the name belongs to MORE than one PAN, the name-only bills cannot be given to either without
 * guessing, so they stay on their own row flagged `multiplePans`. The walk-in aggregate is never a
 * party and is never merged or flagged.
 *
 * Input rows: { key, name, pan, walkIn, bills, returns, gross, taxable, nonTaxable, vat, net }.
 */
export function mergeNameOnlyParties(parties) {
  const panRowsByName = new Map()
  for (const p of parties) {
    if (p.walkIn || !p.pan) continue
    const k = partyNameKey(p.name)
    if (!k) continue
    const list = panRowsByName.get(k) || []
    list.push(p)
    panRowsByName.set(k, list)
  }
  const out = parties.map(p => ({ ...p, mergedNameOnlyBills: 0, multiplePans: false }))
  const byKey = new Map(out.map(p => [p.key, p]))
  const merged = new Set()
  for (const p of out) {
    if (p.walkIn || p.pan) continue
    const matches = panRowsByName.get(partyNameKey(p.name)) || []
    const pans = new Set(matches.map(m => m.pan))
    if (pans.size === 1) {
      const target = byKey.get(matches[0].key)
      for (const k of PARTY_AMOUNT_KEYS) target[k] = (target[k] || 0) + (p[k] || 0)
      target.mergedNameOnlyBills += p.bills || 0
      merged.add(p.key)
    } else if (pans.size > 1) {
      p.multiplePans = true
    }
  }
  return out.filter(p => !merged.has(p.key))
}
