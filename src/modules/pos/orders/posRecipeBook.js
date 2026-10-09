import { buildRecipeBook, computeRecipeCosts, explodeRecipeIngredients } from '../../../utils/recipeCost'
import { loadDeltaExplosion } from '../../../utils/orderLineIngredients'

// The till's view of the recipe book (S809 IMS-HANDOFF-3).
//
// A till is usually signed in on a Staff PIN, and `items` carries RESTRICTIVE no_pos_pin_staff, so
// every read of it from a PIN login comes back empty with no error. The recipe walk's items embed
// then gave every ingredient a 100% yield (a bill took 4.00 kg of chicken off the ledger where an
// 85% yield needs 4.71 kg) and every rate 0 (a comp valued at the dish's typed Cost Price, usually
// NPR 0, on the Pay and Complimentary tabs, the Complimentary Slip and the Z-report), while the
// Owner closing the same bill got the right figures.
//
// `pos_recipe_book` (SECURITY DEFINER, migration 20261009220000) answers a POS Supervisor or above,
// or the Owner, of the outlet asked about, with the part of the book the given recipes reach: each
// recipe's yield_qty and cost_price, its ingredient rows, its sub-recipes to any depth, and each
// ingredient's yield_pct and per_uom_rate; plus the loose items named (a choice's stock lines). It
// is fed to the ONE walk, recipeCost.js' `{ book }` path (S793), so this file adds no arithmetic:
// the stock lines and the costs come out exactly as they do for the Owner (recipeCost.test.js holds
// the book path and the fetch path to deep-equal output).

/** The rows the read returns → the lookups the walk consumes (recipeCost.buildRecipeBook), loose items added. Pure. */
export function bookFromPosRead(data) {
  const book = buildRecipeBook(data?.recipes || [])
  for (const it of data?.items || []) {
    if (it?.id && !book.items.has(it.id)) book.items.set(it.id, it)
  }
  return book
}

/** Every item id and sub-recipe id a set of stored choice lines names (sales_entries.ingredient_deltas shape). Pure. */
export function deltaIdsOf(deltaLists) {
  const itemIds = new Set()
  const subRecipeIds = new Set()
  for (const list of deltaLists || []) {
    for (const d of list || []) {
      if (d?.item_id) itemIds.add(d.item_id)
      else if (d?.sub_recipe_id) subRecipeIds.add(d.sub_recipe_id)
    }
  }
  return { itemIds: [...itemIds], subRecipeIds: [...subRecipeIds] }
}

const uniq = ids => [...new Set((ids || []).filter(Boolean))]

/**
 * One read of the book for these recipes and loose items. Throws on a failed or refused read, as the
 * walk does (S695): an empty book would cost every comp at NPR 0 and take nothing off the ledger.
 */
export async function loadPosRecipeBook(supabase, clientId, { recipeIds = [], itemIds = [] } = {}) {
  const { data, error } = await supabase.rpc('pos_recipe_book', {
    p_client_id: clientId, p_recipe_ids: uniq(recipeIds), p_item_ids: uniq(itemIds),
  })
  // Kept as an Error carrying the hint, so errorText can still word a refusal (rank_required).
  if (error) throw Object.assign(new Error(error.message || 'Could not read the recipe book.'), { code: error.code, hint: error.hint, details: error.details })
  return bookFromPosRead(data)
}

/** Food cost per portion { recipeId: npr }, as computeRecipeCosts gives the Owner. */
export async function posFoodCosts(supabase, clientId, recipeIds) {
  const ids = uniq(recipeIds)
  if (ids.length === 0) return {}
  const book = await loadPosRecipeBook(supabase, clientId, { recipeIds: ids })
  return computeRecipeCosts(supabase, ids, { book })
}

/**
 * What a closing bill takes off the ledger, through one read: `breakdown` is the recipes' raw items
 * per plate (explodeRecipeIngredients' shape), `explosion` turns the choices' stored lines into raw
 * items (loadDeltaExplosion's shape, for deltaItems). Both trimmed by each item's yield %.
 */
export async function posStockLines(supabase, clientId, recipeIds, deltaLists) {
  const ids = uniq(recipeIds)
  const { itemIds, subRecipeIds } = deltaIdsOf(deltaLists)
  if (ids.length === 0 && itemIds.length === 0 && subRecipeIds.length === 0) {
    return { breakdown: {}, explosion: { itemYield: {}, subPerUnit: {} } }
  }
  const book = await loadPosRecipeBook(supabase, clientId, { recipeIds: [...ids, ...subRecipeIds], itemIds })
  const [breakdown, explosion] = await Promise.all([
    explodeRecipeIngredients(supabase, ids, { book }),
    loadDeltaExplosion(supabase, deltaLists, { book }),
  ])
  return { breakdown, explosion }
}
