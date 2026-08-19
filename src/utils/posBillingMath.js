// Shared Gross/Discount/Taxable/Non-Taxable/VAT/Net math for a POS order — extracted from
// PosOrders.jsx's buildBillHtml so the Credit Note print layout and the One Lakh Above Report
// compute amounts identically to the original bill instead of re-deriving the formula.

export function computeOrderAmounts(order, items, vatReg) {
  const subEx    = items.reduce((s, i) => s + i.qty * i.unit_price, 0)
  const vatAmtRaw = vatReg ? items.reduce((s, i) => s + i.qty * i.unit_price * (i.vat_rate ?? 0), 0) : 0
  const discount = order.discount_amount || 0
  // Discount reduces the pre-VAT taxable base; VAT is recalculated on the discounted amount
  // (same rule as purchase_entries.discount_amount) — a proportional/blended-rate simplification
  // since this is an order-level (not per-line) discount.
  const discRatio = subEx > 0 ? discount / subEx : 0
  const vatAmt   = vatAmtRaw * (1 - discRatio)
  const grossAmt = subEx
  const rawNet   = grossAmt - discount + vatAmt
  const net      = Math.round(rawNet) // rounded to the nearest rupee so Net Amount matches the amount-in-words line
  const roundOff = net - rawNet
  const taxableBaseRaw    = vatReg ? items.filter(i => (i.vat_rate ?? 0) > 0).reduce((s, i) => s + i.qty * i.unit_price, 0) : 0
  const nonTaxableBaseRaw = vatReg ? items.filter(i => !(i.vat_rate > 0)).reduce((s, i) => s + i.qty * i.unit_price, 0) : subEx
  const taxableBase    = taxableBaseRaw * (1 - discRatio)
  const nonTaxableBase = nonTaxableBaseRaw * (1 - discRatio)
  const totalQty = items.reduce((s, i) => s + i.qty, 0)

  return { grossAmt, discount, taxableBase, nonTaxableBase, vatAmt, net, roundOff, totalQty }
}

// Same discRatio proportional-discount-allocation rule as computeOrderAmounts, applied per
// arbitrary grouping key instead of collapsed to one order-level total — so any grouping's
// subtotals always reconcile exactly to what computeOrderAmounts reports for the same order.
//
// This is the one place that rule lives. Category-wise and item-wise were byte-for-byte copies of
// it differing only in the key, and the Product Type tab (S580) would have made a third — money
// math on the bill belongs in a single place for the same reason COGS does (see imsFormulas.js).
//
//   keyOf(item)  → the bucket this line falls into
//   seedOf(item) → optional extra fields stamped on a bucket the first time it is created
export function computeGroupAmounts(order, items, vatReg, keyOf, seedOf) {
  const subEx = items.reduce((s, i) => s + i.qty * i.unit_price, 0)
  const discRatio = subEx > 0 ? (order.discount_amount || 0) / subEx : 0
  const byKey = {}
  for (const i of items) {
    const key = keyOf(i)
    const line = i.qty * i.unit_price
    const vatLine = vatReg ? line * (i.vat_rate ?? 0) : 0
    const b = byKey[key] = byKey[key] || {
      ...(seedOf ? seedOf(i) : null),
      gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0, qty: 0,
    }
    b.gross += line
    b.discount += line * discRatio
    b.vat += vatLine * (1 - discRatio)
    if (vatReg && (i.vat_rate ?? 0) > 0) b.taxable += line * (1 - discRatio)
    else b.nonTaxable += line * (1 - discRatio)
    b.qty += i.qty
  }
  return byKey
}

export function computeCategoryAmounts(order, items, vatReg) {
  return computeGroupAmounts(order, items, vatReg, i => i.category || 'Uncategorized')
}

// Keyed by recipe_id — a plain item-wise sales ledger. `name` is seeded onto the bucket since the
// key is an id the caller can't render.
export function computeItemAmounts(order, items, vatReg) {
  return computeGroupAmounts(order, items, vatReg, i => i.recipe_id || i.name, i => ({ name: i.name }))
}
