// Supplier Contribution — the arithmetic behind "which suppliers does my revenue depend on".
//
// Crest has no supplier on the item master: `items` carries no vendor column at all, and the only
// place a vendor is ever recorded is a purchase line. So a supplier-wise view of sales cannot be
// read off the data — it has to be DERIVED, in three steps:
//
//   1. what sold        → sales_entries, filtered through salesDepletion.js's rule
//   2. what that ate    → explodeRecipeIngredients(), valued at items.per_uom_rate
//   3. who supplied it  → this file: each item's consumed value split across the vendors that
//                         actually supplied that item during the period, in proportion to what
//                         was bought from each
//
// Two things are deliberate and load-bearing:
//
// • **Net purchase value here must mean exactly what VendorReport.js means by it**
//   (gross − bill discount − returns), because both pages show a vendor's purchases for the same
//   period and sit in the same nav group. The only extension is allocating the bill-level
//   discount across that bill's lines proportionally, since attribution is per item where Vendor
//   Report only ever needed per vendor — the vendor totals still sum to Vendor Report's figure.
//
// • **An item nothing can be attributed to is named, never dropped.** A rollup that silently
//   fails to claim a row produces a believable wrong total rather than an error (S567). An item
//   consumed this period but last bought in an earlier one is a perfectly ordinary case, and the
//   page says so instead of quietly shrinking the total.

export const NO_VENDOR = '__none__'      // a purchase line with no vendor recorded
export const UNATTRIBUTED = '__unattributed__' // consumed, but nothing bought from anyone this period

// `purchase_entries.discount_amount` is a BILL-level figure repeated on every line of the bill,
// which is why VendorReport.js dedupes it by purchase_group_id before summing. Same dedupe here,
// then the bill's discount is spread across its own lines in proportion to line value so it can
// be carried down to the item.
export function allocateBillDiscounts(purchases) {
  const bills = new Map()
  for (const p of purchases || []) {
    const gid = p.purchase_group_id || `${p.vendor_id}|${p.invoice_ref || ''}|${p.bs_day}`
    let bill = bills.get(gid)
    if (!bill) bills.set(gid, bill = { discount: 0, gross: 0, lines: [] })
    // max, not sum: every line of the bill carries the same value (VendorReport.js's rule)
    bill.discount = Math.max(bill.discount, parseFloat(p.discount_amount) || 0)
    const line = (parseFloat(p.qty) || 0) * (parseFloat(p.rate) || 0)
    bill.gross += line
    bill.lines.push({ row: p, line })
  }
  const out = []
  for (const bill of bills.values()) {
    for (const { row, line } of bill.lines) {
      const share = bill.gross > 0 ? line / bill.gross : 0
      out.push({ ...row, lineGross: line, lineNet: line - bill.discount * share })
    }
  }
  return out
}

// → { [item_id]: { total, byVendor: { [vendor_id]: net } } }
// Values are the true net and may be negative (a return larger than the period's purchases);
// that is preserved here so the displayed column ties to Vendor Report, and clamped only where a
// proportional SHARE is taken, since a negative share is meaningless.
export function vendorNetByItem(purchases, returns) {
  const byItem = {}
  const ensure = itemId => byItem[itemId] = byItem[itemId] || { total: 0, byVendor: {} }
  for (const p of allocateBillDiscounts(purchases)) {
    if (!p.item_id) continue
    const b = ensure(p.item_id)
    const vid = p.vendor_id || NO_VENDOR
    b.byVendor[vid] = (b.byVendor[vid] || 0) + p.lineNet
    b.total += p.lineNet
  }
  for (const r of returns || []) {
    if (!r.item_id) continue
    const b = ensure(r.item_id)
    const vid = r.vendor_id || NO_VENDOR
    const amt = (parseFloat(r.qty) || 0) * (parseFloat(r.rate) || 0)
    b.byVendor[vid] = (b.byVendor[vid] || 0) - amt
    b.total -= amt
  }
  return byItem
}

// Positive parts only — an item whose vendors all net to zero or less has no meaningful split.
export function vendorShares(byVendor) {
  const positive = Object.entries(byVendor || {}).filter(([, v]) => v > 0)
  const total = positive.reduce((s, [, v]) => s + v, 0)
  if (total <= 0) return null
  return Object.fromEntries(positive.map(([vid, v]) => [vid, v / total]))
}

// consumedByItem: { [item_id]: { value, qty, byRecipe: { [recipe_id]: value } } }
// netByItem:      output of vendorNetByItem()
//
// → { total, byVendor: { [vid]: { value, items: {}, recipes: {} } }, unattributed: {...} }
//   `unattributed` is a bucket keyed by UNATTRIBUTED inside byVendor as well, so callers that
//   just want "every row to render" can iterate one map and still tell the two apart by key.
export function attributeConsumption(consumedByItem, netByItem) {
  const byVendor = {}
  const ensure = vid => byVendor[vid] = byVendor[vid] || { value: 0, items: {}, recipes: {} }
  let total = 0

  for (const [itemId, consumed] of Object.entries(consumedByItem || {})) {
    const value = consumed.value || 0
    if (value <= 0) continue
    total += value
    const shares = vendorShares(netByItem[itemId]?.byVendor)
    const split = shares || { [UNATTRIBUTED]: 1 }
    for (const [vid, share] of Object.entries(split)) {
      const b = ensure(vid)
      const part = value * share
      b.value += part
      b.items[itemId] = (b.items[itemId] || 0) + part
      for (const [recipeId, recipeValue] of Object.entries(consumed.byRecipe || {})) {
        b.recipes[recipeId] = (b.recipes[recipeId] || 0) + recipeValue * share
      }
    }
  }
  return { total, byVendor, unattributed: byVendor[UNATTRIBUTED] || { value: 0, items: {}, recipes: {} } }
}

// Net purchase value per vendor for the period — the same figure Vendor Report calls Net Spend,
// derived from the same rows the attribution split used so the two columns can never disagree
// with each other about what a bill was worth.
export function vendorNetTotals(netByItem) {
  const totals = {}
  for (const { byVendor } of Object.values(netByItem || {})) {
    for (const [vid, v] of Object.entries(byVendor)) totals[vid] = (totals[vid] || 0) + v
  }
  return totals
}
