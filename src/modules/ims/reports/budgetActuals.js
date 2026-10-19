// Budget vs Actual's spend per category, built so its total IS Monthly Summary's Net Purchases
// (S792, FIGURES-9).
//
// The page's Totals row has always said it reconciles with Monthly Summary, and it could not:
// Monthly Summary valued active, non-sub-recipe items only, while this page claimed spend on every
// ACTIVE item — sub-recipe mirrors included — and added everything else (hidden items' purchases)
// in an "unbudgetable" row counted in the total. So a hidden item's spend was in this total and
// not in that one, under a sentence saying they agree.
//
// Both pages now read the same population — every non-sub-recipe item, hidden ones included (D29:
// hiding never changes history) — so a hidden item's spend stays in the category it was bought
// under, which is what that category's budget was set against. What neither page values is a
// line whose item is not in that set (a prep item's mirror row, which no purchase picker offers):
// it is reported as `excluded`, kept OUT of the total so the total still ties, and named on screen
// rather than dropped without a word.
//
// Purchases are net of their share of the bill discount (`allocateBillDiscounts`, the helper
// Monthly Summary's `periodStockMaps` uses) and returns are at their own recorded rate — Monthly
// Summary's two conventions exactly — including its COST basis (S792, D32): `lineCost`, and each
// return at its line's basis (`returnCostValue`), so a PAN-bill outlet's supplier VAT is spend.
//
// S849 (PNL-8): stock transfers between outlets are spend the way Monthly Summary counts them in
// Net Purchases: stock RECEIVED from another outlet (direction 'in', and stock returned here after a
// cancel or refusal) is this outlet's food spend, added to its item's category at the line's value;
// stock SENT away (direction 'out') is not this outlet's spend and comes off, like a supplier return.
// Value is the line's stored `value` (qty × the sender's rate frozen at sending): no bill discount
// and no VAT factor, the basis periodCost.js uses, so the total still ties.
import { allocateBillDiscounts, returnCostValue } from './supplierAttribution'

const transferValue = t => (t.value != null && t.value !== ''
  ? (parseFloat(t.value) || 0)
  : (parseFloat(t.qty) || 0) * (parseFloat(t.rate) || 0))

/**
 * @param {object}   args
 * @param {object[]} args.items       every non-sub-recipe item `{ id, category_id }`, hidden included
 * @param {object[]} args.categories  `{ id }` rows — the budgetable categories
 * @param {object[]} args.purchases   the period's purchase lines, with the bill-key columns
 * @param {object[]} args.returns     the period's vendor returns `{ item_id, qty, rate, purchase_entries }`
 * @param {object[]} [args.transfers] the period's stock-transfer lines `{ item_id, direction, qty, rate, value }` (S849)
 * @returns {{ byCategory: Object<string, number>, uncategorised: number, excluded: number, total: number }}
 *   `total` = every category + `uncategorised`; `excluded` is never in it.
 */
export function budgetActuals({ items, categories, purchases, returns, transfers }) {
  const net = {}
  allocateBillDiscounts(purchases || []).forEach(p => { net[p.item_id] = (net[p.item_id] || 0) + p.lineCost })
  ;(returns || []).forEach(r => {
    net[r.item_id] = (net[r.item_id] || 0) - returnCostValue(r)
  })
  ;(transfers || []).forEach(t => {
    if (!t || t.item_id == null) return
    const sign = t.direction === 'in' ? 1 : t.direction === 'out' ? -1 : 0
    if (sign) net[t.item_id] = (net[t.item_id] || 0) + sign * transferValue(t)
  })

  const known = new Set((categories || []).map(c => c.id))
  const byCategory = {}
  ;(categories || []).forEach(c => { byCategory[c.id] = 0 })
  let uncategorised = 0
  const valued = new Set()
  for (const i of items || []) {
    if (!i) continue
    valued.add(i.id)
    const v = net[i.id] || 0
    // An item whose category_id names no category on the list is claimed by none of the rows, so
    // it lands with the uncategorised spend rather than falling out of every total.
    if (i.category_id != null && known.has(i.category_id)) byCategory[i.category_id] += v
    else uncategorised += v
  }
  const excluded = Object.entries(net).reduce((s, [id, v]) => (valued.has(id) ? s : s + v), 0)
  const total = Object.values(byCategory).reduce((s, v) => s + v, 0) + uncategorised
  return { byCategory, uncategorised, excluded, total }
}
