import { explodeRecipeIngredients } from './recipeCost'
import { fetchAllRowsChunked } from '../shared/fetchAllRows'
import { throwFirstError } from '../shared/queryError'

// Crest Customization (S758 stage 7): what a customized plate uses beyond its recipe.
//
// A chosen option carries signed stock lines per plate — "+30 g cheese", "−20 g onion", "−5 pcs
// momo" for a Half — frozen onto the order line when it was saved (pos_order_item_options
// .ingredient_deltas) and copied onto the sale (sales_entries.ingredient_deltas). They are stored AS
// WRITTEN: an item line, or a sub-recipe line in that sub-recipe's own output units. This file is the
// one place they become raw items, and it does it the way a recipe line is done — an item line is
// trimmed by the item's yield %, a sub-recipe line is exploded through explodeRecipeIngredients, the
// one sub-recipe walk (recipes-and-subrecipes.md: "there must never be a third").
//
// Nothing is clamped. "No onion" on a dish whose recipe has no onion takes onion off the plate
// anyway; a negative total is a data-entry problem the Option Groups page should show, not something
// a stock figure should quietly hide.

/** Every stock line on a line's options, flattened — what sales_entries.ingredient_deltas stores. Null when none. */
export function lineIngredientDeltas(options) {
  const out = []
  for (const o of options || []) {
    for (const d of Array.isArray(o?.ingredient_deltas) ? o.ingredient_deltas : []) {
      const qty = Number(d?.qty) || 0
      if (!qty) continue
      if (d.item_id) out.push({ item_id: d.item_id, qty })
      else if (d.sub_recipe_id) out.push({ sub_recipe_id: d.sub_recipe_id, qty })
    }
  }
  return out.length ? out : null
}

/**
 * Reads what turning a set of stored deltas into raw items needs: each item's yield %, and each
 * sub-recipe exploded per ONE output unit. Throws on a failed read, like explodeRecipeTree — a
 * missing explosion is a zero usage, which reads as over-consumption rather than as an error.
 * @param {object} supabase
 * @param {Array<Array|null>} deltaLists  any number of ingredient_deltas arrays
 */
export async function loadDeltaExplosion(supabase, deltaLists) {
  const itemIds = new Set()
  const subIds = new Set()
  for (const list of deltaLists || []) {
    for (const d of list || []) {
      if (d.item_id) itemIds.add(d.item_id)
      else if (d.sub_recipe_id) subIds.add(d.sub_recipe_id)
    }
  }
  const explosion = { itemYield: {}, subPerUnit: {} }
  if (itemIds.size === 0 && subIds.size === 0) return explosion

  const [itemsRes, subsRes] = await Promise.all([
    fetchAllRowsChunked([...itemIds], ids => supabase.from('items').select('id, yield_pct').in('id', ids).order('id')),
    fetchAllRowsChunked([...subIds], ids => supabase.from('recipes').select('id, yield_qty').in('id', ids).order('id')),
  ])
  throwFirstError([itemsRes, subsRes])
  for (const r of itemsRes.data || []) explosion.itemYield[r.id] = parseFloat(r.yield_pct) || 100

  if (subIds.size > 0) {
    // explodeRecipeIngredients returns a sub-recipe's items for ONE BATCH (its own ingredient
    // quantities); a batch makes yield_qty output units, so per unit is batch ÷ yield_qty — the same
    // scaling explode() applies when a recipe line names a sub-recipe.
    const perBatch = await explodeRecipeIngredients(supabase, [...subIds])
    const yieldOf = Object.fromEntries((subsRes.data || []).map(r => [r.id, parseFloat(r.yield_qty) || 1]))
    for (const id of subIds) {
      const y = yieldOf[id] || 1
      explosion.subPerUnit[id] = (perBatch[id] || []).map(({ item_id, qty }) => ({ item_id, qty: qty / y }))
    }
  }
  return explosion
}

/** Raw items for one plate's stored deltas: [{ item_id, qty }] signed, aggregated. Pure. */
export function deltaItems(deltas, explosion) {
  const agg = {}
  for (const d of deltas || []) {
    const qty = Number(d.qty) || 0
    if (!qty) continue
    if (d.item_id) {
      const yf = (explosion?.itemYield?.[d.item_id] ?? 100) / 100
      agg[d.item_id] = (agg[d.item_id] || 0) + qty / (yf || 1)
    } else if (d.sub_recipe_id) {
      for (const it of explosion?.subPerUnit?.[d.sub_recipe_id] || []) {
        agg[it.item_id] = (agg[it.item_id] || 0) + it.qty * qty
      }
    }
  }
  return Object.entries(agg).map(([item_id, qty]) => ({ item_id, qty }))
}

/**
 * The raw items one sales row consumed: its recipe's breakdown × qty, plus its options' deltas × qty.
 * The ONE usage function for a sales_entries row — every IMS reader that rebuilds usage from sales
 * goes through it, so a customized sale cannot be counted as its plain recipe on one page and in
 * full on another.
 * @returns {Array<{ item_id, qty }>}
 */
export function usageOfSalesRow(row, breakdown, explosion) {
  const n = Number(row?.qty_sold) || 0
  if (!n) return []
  const agg = {}
  for (const { item_id, qty } of breakdown?.[row.recipe_id] || []) agg[item_id] = (agg[item_id] || 0) + qty * n
  if (row.ingredient_deltas) {
    for (const { item_id, qty } of deltaItems(row.ingredient_deltas, explosion)) agg[item_id] = (agg[item_id] || 0) + qty * n
  }
  return Object.entries(agg).map(([item_id, qty]) => ({ item_id, qty }))
}
