import { deltaItems, loadDeltaExplosion } from '../../../utils/orderLineIngredients'
import { fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { throwFirstError } from '../../../shared/queryError'

// S792 RECIPES-3: the stock cost of the extras a guest adds, for the margin reports.
//
// A customized sale's `unit_price` already includes its choices' upcharges (the pricer adds them at
// order time and `writeSalesEntries` carries them onto the sale), so Recipe Margin and Best Sellers
// counted "Momo + Extra cheese (+NPR 50)" as NPR 50 more revenue — and costed the plate as plain
// momo, because their COGS was the recipe's cost × qty. The cheese's NPR 36 of stock was nowhere, so
// Total Contribution, margin % and the weighted FC% all read high, and a heavily customized dish
// climbed to Top Contributor. Decided (IMS_TODO.md S792.1, settled by precedent): the stock cost of
// extras counts in margin.
//
// What a plate's choices used is `sales_entries.ingredient_deltas` — signed stock lines per plate,
// already scaled by the chosen size (ims-figures.md, S758/S760). They become raw items through
// `orderLineIngredients.deltaItems`, the one conversion the stock posting uses (yield trim, sub-recipes
// through the one walk), and are valued at `items.per_uom_rate` — the same today's-rate basis
// `computeRecipeCosts` values the recipe part at, so a plate's two halves are priced alike.
//
// Nothing is clamped, as everywhere else: "No onion" takes the onion's cost OFF the plate, and a Half
// portion's "−5 pcs momo" makes it cheaper than the recipe. A credit note's row carries its plate's
// deltas with a negative qty (S758), so it reverses the extras' cost along with their upcharge — the
// same way its negative qty already reverses the recipe's part on these pages.

const EMPTY_EXPLOSION = Object.freeze({ itemYield: {}, subPerUnit: {} })

const hasDeltas = d => Array.isArray(d) && d.length > 0

/**
 * The raw-item cost of ONE plate's stored choices, signed. 0 when the plate has none.
 * An item with no known rate costs 0 here, exactly as it does inside `computeRecipeCosts`.
 * @param {Array|null} deltas         a sales row's `ingredient_deltas`
 * @param {object}     explosion      from `loadDeltaExplosion`
 * @param {Record<string, number>} rateByItem  item id → per-base-unit rate
 */
export function plateExtrasCost(deltas, explosion, rateByItem) {
  if (!hasDeltas(deltas)) return 0
  return deltaItems(deltas, explosion || EMPTY_EXPLOSION)
    .reduce((s, { item_id, qty }) => s + qty * (Number(rateByItem?.[item_id]) || 0), 0)
}

/**
 * Per recipe: Σ over the rows given of (the plate's extras cost × qty_sold).
 *
 * The caller passes exactly the rows it counts as revenue — comps already dropped, credit notes
 * kept — so a dish's extras cost covers the same plates as its revenue and its recipe cost.
 * @param {Array<{recipe_id, qty_sold, ingredient_deltas}>} rows
 * @param {{ explosion, rateByItem }} costing  from `loadExtrasCosting`
 * @returns {Record<string, number>}  recipe id → NPR; a recipe with no customized sales is absent
 */
export function extrasCostByRecipe(rows, costing) {
  const out = {}
  for (const r of rows || []) {
    if (!r || !hasDeltas(r.ingredient_deltas)) continue
    const n = Number(r.qty_sold) || 0
    if (!n) continue
    out[r.recipe_id] = (out[r.recipe_id] || 0) + plateExtrasCost(r.ingredient_deltas, costing?.explosion, costing?.rateByItem) * n
  }
  return out
}

/**
 * Every raw item the given delta lists reach once exploded — the ids whose rates are needed.
 * @param {Array<Array>} deltaLists
 * @param {object} explosion
 * @returns {string[]}
 */
export function extrasItemIds(deltaLists, explosion) {
  const ids = new Set()
  for (const list of deltaLists || []) {
    if (!hasDeltas(list)) continue
    for (const { item_id } of deltaItems(list, explosion || EMPTY_EXPLOSION)) ids.add(item_id)
  }
  return [...ids]
}

/**
 * Reads what valuing these rows' extras needs: the explosion of their stock lines and the rate of
 * every raw item those reach. THROWS on a failed read, like `computeRecipeCosts` and
 * `loadDeltaExplosion` — a missing rate would be a zero cost, i.e. the flattering margin this file
 * exists to remove — so a caller runs it inside the same try/catch as the recipe walk.
 *
 * Returns an empty costing without a single read when no row carries choices, which is every sale
 * of a client without Crest Customization.
 * @param {object}   supabase
 * @param {Function} scopedFrom  from useScopedDb()
 * @param {Array<{ingredient_deltas}>} rows
 * @returns {Promise<{ explosion, rateByItem }>}
 */
export async function loadExtrasCosting(supabase, scopedFrom, rows) {
  const lists = (rows || []).map(r => r?.ingredient_deltas).filter(hasDeltas)
  if (lists.length === 0) return { explosion: EMPTY_EXPLOSION, rateByItem: {} }
  const explosion = await loadDeltaExplosion(supabase, lists)
  const itemIds = extrasItemIds(lists, explosion)
  if (itemIds.length === 0) return { explosion, rateByItem: {} }
  const res = await fetchAllRowsChunked(itemIds, ids => scopedFrom('items', 'id, per_uom_rate').in('id', ids).order('id'))
  throwFirstError([res])
  const rateByItem = {}
  for (const i of res.data || []) rateByItem[i.id] = parseFloat(i.per_uom_rate) || 0
  return { explosion, rateByItem }
}
