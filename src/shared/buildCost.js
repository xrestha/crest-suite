// Crest Customization (S760): what a build-your-own dish costs to make.
//
// A build-your-own dish has few fixed ingredients (the bowl, the spoon) and gets most of its cost
// from what the guest picks, so the fixed-ingredient figure Recipe Costing shows for any other dish
// reads as a near-zero food cost. This works out two builds per size instead:
//
//   cheapest  the lowest-PRICED valid selection: in every required group, the cheapest picks the
//             rule demands; nothing optional. The floor a guest can order.
//   typical   what guests actually build — the caller passes it (the most-picked non-size
//             selection over recent sales, or the dish's defaults, labelled as such) — priced at
//             each size.
//
// Pure. Prices go through optionPricing (the twin of the server's pricer, so a Large bowl is priced
// here as the bill prices it). Stock lines are scaled by the same rule the server freezes at order
// time (scaledQty) and exploded by orderLineIngredients.deltaItems — yield trim and sub-recipes
// included — so a plate is costed from the same raw items the stock posting depletes. There is no
// third copy of either.

import { sizeFactor, scaledQty, optionsPriceDelta } from './optionPricing'
import { deltaItems } from '../utils/orderLineIngredients'

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round2 = n => Math.round(n * 100) / 100

/**
 * The raw-item cost of the chosen options on one plate, at the plate's size.
 * @param {object[]} chosen          option rows
 * @param {object}   ctx             { groupsById, ingredientsByOption, explosion, rateByItem }
 * @returns {number}
 */
export function optionsPlateCost(chosen, { groupsById, ingredientsByOption, explosion, rateByItem }) {
  const factor = sizeFactor(chosen, groupsById)
  const deltas = []
  for (const o of chosen || []) {
    const g = groupsById?.[o.group_id]
    for (const i of ingredientsByOption?.[o.id] || []) {
      const qty = scaledQty(i.qty_per_portion, g, factor)
      deltas.push(i.item_id ? { item_id: i.item_id, qty } : { sub_recipe_id: i.sub_recipe_id, qty })
    }
  }
  return deltaItems(deltas, explosion).reduce((s, { item_id, qty }) => s + qty * num(rateByItem?.[item_id]), 0)
}

/**
 * The cheapest valid selection (by the price the guest pays) for one size.
 * @param {Array<{group, rule, options}>} dishGroups   groupsForDish() output
 * @param {object|null} sizeOption                      the size to build at; null when the dish has none
 * @returns {string[]} option ids
 */
export function cheapestSelection(dishGroups, sizeOption, groupsById) {
  const ids = sizeOption ? [sizeOption.id] : []
  const factorChosen = sizeOption ? [sizeOption] : []
  for (const { group, rule, options } of dishGroups || []) {
    if (group.kind === 'size') continue
    if (!(rule.min > 0)) continue
    // Price each option at this size, alone — the free-picks rule never makes a dearer pick cheaper.
    const priced = options
      .filter(o => !o.is_removal)
      .map(o => ({ o, p: optionsPriceDelta([...factorChosen, { ...o, group_id: group.id }], { ...groupsById, [group.id]: { ...group, included_count: 0 } })
        - optionsPriceDelta(factorChosen, groupsById) }))
      .sort((a, b) => a.p - b.p || (a.o.sort ?? 0) - (b.o.sort ?? 0))
    ids.push(...priced.slice(0, rule.min).map(x => x.o.id))
  }
  return ids
}

/**
 * The typical build at one size: the given non-size picks, with the size swapped in.
 */
export function withSize(nonSizeIds, sizeOption) {
  return sizeOption ? [sizeOption.id, ...nonSizeIds] : [...nonSizeIds]
}

/**
 * One build's figures.
 * @returns {{ price: number, cost: number, fcPct: number|null }}
 */
export function priceBuild(ids, { basePrice, fixedCost, optionsById, groupsById, ingredientsByOption, explosion, rateByItem }) {
  const chosen = (ids || []).map(id => optionsById?.[id]).filter(Boolean)
  const price = round2(num(basePrice) + optionsPriceDelta(chosen, groupsById))
  const cost = round2(num(fixedCost) + optionsPlateCost(chosen, { groupsById, ingredientsByOption, explosion, rateByItem }))
  return { price, cost, fcPct: price > 0 ? (cost / price) * 100 : null }
}

/**
 * The range a build-your-own dish shows: one row per size (a single row when the dish has no
 * size), each with its cheapest and its typical build, plus the overall low and high.
 *
 * @param {object} args
 * @param {Array<{group, rule, options}>} args.dishGroups
 * @param {number} args.basePrice        ex-VAT selling price
 * @param {number} args.fixedCost        the dish's own ingredient cost per plate
 * @param {string[]} args.typicalIds     non-size option ids of the typical build
 * @param {object} args.ctx              { optionsById, groupsById, ingredientsByOption, explosion, rateByItem }
 */
export function buildCostRange({ dishGroups, basePrice, fixedCost, typicalIds = [], ctx }) {
  const sizeGroup = (dishGroups || []).find(d => d.group.kind === 'size')
  const sizes = sizeGroup ? sizeGroup.options : [null]
  const shared = { basePrice, fixedCost, ...ctx }
  const sizeIds = new Set(sizeGroup ? sizeGroup.options.map(o => o.id) : [])
  const nonSize = (typicalIds || []).filter(id => !sizeIds.has(id))

  const rows = sizes.map(size => ({
    size: size ? size.name : null,
    portion: size ? (size.portion_factor == null ? 1 : num(size.portion_factor)) : 1,
    cheapest: priceBuild(cheapestSelection(dishGroups, size, ctx.groupsById), shared),
    typical: priceBuild(withSize(nonSize, size), shared),
  }))

  const costs = rows.flatMap(r => [r.cheapest.cost, r.typical.cost])
  const fcs = rows.flatMap(r => [r.cheapest.fcPct, r.typical.fcPct]).filter(v => v != null)
  return {
    rows,
    lowCost: costs.length ? Math.min(...costs) : num(fixedCost),
    highCost: costs.length ? Math.max(...costs) : num(fixedCost),
    lowFc: fcs.length ? Math.min(...fcs) : null,
    highFc: fcs.length ? Math.max(...fcs) : null,
  }
}

/**
 * The most-picked non-size selection for each dish from recent order lines.
 * @param {Array<{recipe_id, selection_key, qty}>} lines
 * @param {Set<string>} sizeOptionIds
 * @param {number} minPlates  below this many plates the history is not trusted
 * @returns {Record<string, { ids: string[], plates: number }>}
 */
export function typicalSelections(lines, sizeOptionIds, minPlates = 10) {
  const byDish = {}
  for (const l of lines || []) {
    if (!l.recipe_id) continue
    const ids = String(l.selection_key || '').split('+').filter(Boolean).filter(id => !sizeOptionIds.has(id))
    const key = [...ids].sort().join('+')
    const d = (byDish[l.recipe_id] = byDish[l.recipe_id] || { total: 0, counts: {} })
    const q = num(l.qty) || 1
    d.total += q
    d.counts[key] = (d.counts[key] || 0) + q
  }
  const out = {}
  for (const [rid, d] of Object.entries(byDish)) {
    if (d.total < minPlates) continue
    const [key, plates] = Object.entries(d.counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
    out[rid] = { ids: key ? key.split('+') : [], plates, total: d.total }
  }
  return out
}
