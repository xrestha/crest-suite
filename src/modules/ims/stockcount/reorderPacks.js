// A reorder quantity in the unit it is BOUGHT in, as well as the unit it is counted in (S756, D18).
//
// WHY: every quantity on the Reorder Report is in the item's BASE unit — stock is stored in its
// smallest unit (S597), so a shortfall of rice reads "12,500 GM". That is the right figure to count
// against and the wrong one to hand to someone going to the market, who buys sacks. Decided with
// Aashish: show both, with the pack count ROUNDED UP to whole packs — nobody can buy half a sack,
// and buying one pack short of par is the outcome the report exists to prevent.
//
// The pack size comes from the Item Master's conversion columns, through the same `getCf()` the
// Purchase Bill uses to decide whether its Qty box counts packs: `conversion_factor` is base units
// per `purchase_unit`, and only counts when it is > 1 AND a purchase unit is named. Anything else
// has no pack size, and then the base-unit figure is the whole answer — a "1 × of 1 GM" would be
// noise pretending to be information.
//
// Pure (no Supabase), so reorderPacks.test.js can pin the rounding.

import { getCf } from '../purchases/purchasesHelpers'
import { NPR_LOCALE } from '../../../shared/nepalMoney'

// Shortfalls come out of float subtraction (par − on hand), so 25000.000000004 must not buy a
// second sack. Well under any real quantity in a base unit.
const EPS = 1e-6

// A QUANTITY, not money — decimals kept, Nepali grouping (the S721 rule: nepalMoney's integer
// formatters round a 0.4 kg shortfall to "0").
export function fmtQty(q) {
  const n = Number(q)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString(NPR_LOCALE, { maximumFractionDigits: 2 })
}

/**
 * How many whole purchase packs cover `qty` base units of `item`, or null when the item has no
 * pack size (or there is nothing to buy).
 *
 * Returns `{ packs, unit, packSize, packedQty }` — `packedQty` is what those packs actually hold,
 * which is at least `qty` and is what will really arrive.
 */
export function packsFor(qty, item) {
  const q = Number(qty)
  if (!(q > EPS)) return null
  const cf = getCf(item)
  if (!(cf > 1)) return null
  const packs = Math.ceil(q / cf - EPS)
  return { packs, unit: String(item.purchase_unit).trim(), packSize: cf, packedQty: packs * cf }
}

/** "1 SACK of 25,000 GM" / "2 SACK of 25,000 GM each", or '' when there is no pack size. */
export function packText(qty, item) {
  const p = packsFor(qty, item)
  if (!p) return ''
  return `${p.packs} ${p.unit} of ${fmtQty(p.packSize)} ${item?.uom || ''}`.trim() + (p.packs === 1 ? '' : ' each')
}

/**
 * The whole reorder quantity as one line — "12,500 GM (1 SACK of 25,000 GM)" — for the WhatsApp
 * text and anywhere else that has one line to put it in. Base units only when there is no pack.
 */
export function reorderQtyText(qty, item) {
  const base = `${fmtQty(qty)} ${item?.uom || ''}`.trim()
  const pack = packText(qty, item)
  return pack ? `${base} (${pack})` : base
}
