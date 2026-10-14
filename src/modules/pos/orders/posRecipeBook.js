import { buildRecipeBook, computeRecipeCosts } from '../../../utils/recipeCost'
import { lineIngredientDeltas, loadDeltaExplosion } from '../../../utils/orderLineIngredients'
import { plateExtrasCost } from '../../ims/recipes/extrasCost'
import { fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { isMissingColumn } from '../../customization/customizationData'

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
// the costs come out exactly as they do for the Owner (recipeCost.test.js holds the book path and the
// fetch path to deep-equal output). A closing bill's stock lines are the database's since S830 (5f-1).

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
 * Choices' stock lines, priced, through one read (S828 5d, for the Customization report's Margin
 * tab): `explosion` turns stored lines into raw items (loadDeltaExplosion's shape, for deltaItems),
 * `rateOf(itemId)` is each raw item's per_uom_rate, 0 for one the book does not hold. A POS manager on
 * a PIN read `items` directly and got every yield 100% and every rate 0.
 */
export async function posDeltaCosting(supabase, clientId, deltaLists) {
  const { itemIds, subRecipeIds } = deltaIdsOf(deltaLists)
  if (itemIds.length === 0 && subRecipeIds.length === 0) {
    return { explosion: { itemYield: {}, subPerUnit: {} }, rateOf: () => 0 }
  }
  const book = await loadPosRecipeBook(supabase, clientId, { recipeIds: subRecipeIds, itemIds })
  const explosion = await loadDeltaExplosion(supabase, deltaLists, { book })
  return { explosion, rateOf: id => Number(book.items.get(id)?.per_uom_rate) || 0 }
}

// A comped dish's food cost, WITH its choices. Every comp figure on the POS side (the Complimentary
// Slip, the payment window, the Z-report, Sales Exceptions, Comped Bills, the bill viewer) was the
// recipe's cost × qty, keyed by recipe — so "Momo + extra cheese" cost what plain momo costs, and a
// build-your-own bowl with no ingredient rows cost its typed Cost Price, usually NPR 0, while the
// server's post took the cheese and the bowl's toppings off Inventory (pos_line_choice_lines). One
// figure per plate now: the recipe's cost plus that line's choices' stock lines, priced from the same
// book read, the same walk and the same rates. No arithmetic is added here: the recipe part is
// computeRecipeCosts, the choices are deltaItems through plateExtrasCost (the margin reports' one
// conversion), and recipeCost.js knows nothing of options (recipes-and-subrecipes.md).

/** The embed a stored-line read adds so its comp is costed with its choices: the stock lines frozen on the line. */
export const LINE_CHOICE_STOCK = 'pos_order_item_options(ingredient_deltas)'

/**
 * A line's choices' stock lines per plate, as the server froze them (already scaled by the size).
 * Null when it has none — and for choices picked on this screen and never read back, which carry no
 * stock lines: the server writes those when it saves the line (pos-billing.md, "Stock at close reads
 * the SERVER snapshot").
 */
export function lineChoiceDeltas(line) {
  return lineIngredientDeltas(line?.pos_order_item_options || line?.options)
}

// A build-your-own dish's plate is its guest's choices, so its typed Cost Price is not its cost.
// Recipe Costing sets it aside the same way and costs the FIXED part, the dish's own ingredient rows
// (Recipes.js byoFixedCost). The walk is fed a book in which the dish has no typed cost, so the
// arithmetic is unchanged; nothing else in the book moves.
function withoutTypedCost(book, ids) {
  const recipes = new Map(book.recipes)
  for (const id of ids) {
    const r = recipes.get(id)
    if (r) recipes.set(id, { ...r, cost_price: null })
  }
  return { ...book, recipes }
}

/**
 * Food cost per PLATE of comped lines: the dish's recipe cost plus that line's choices, from ONE read
 * of the till's book (pos_recipe_book: the dishes, the choices' sub-recipes and their loose items).
 * Throws on a failed or refused read, as posFoodCosts does: a comp valued without its costs is a
 * wrong figure, never a partial one.
 *
 * @param {object} supabase
 * @param {string} clientId
 * @param {Array<{ recipe_id, pos_order_item_options?, options? }>} lines  the lines AS STORED (a read
 *   carrying LINE_CHOICE_STOCK, or OPEN_ORDER_SELECT's snapshot): the choices' stock lines come from there
 * @param {object} [opts]
 * @param {boolean} [opts.inventory=true]  the outlet has Crest IMS (outletHasIms). Without it the figure
 *   is exactly what it always was: the recipe's cost, its typed Cost Price when nothing is costed, and
 *   the choices 0 (a POS-only outlet has no item rates and its bills take no stock).
 * @param {Iterable<string>|Promise<Iterable<string>>} [opts.buildYourOwn=[]]  dishes costed by their
 *   build (Customization on; buildYourOwnAmong). With Inventory such a dish is its fixed part plus its
 *   choices, never its typed Cost Price. A promise is read beside the book, not after it.
 * @returns {Promise<{ costOf: (line: object) => number }>}  NPR per plate; × qty for the line
 */
export async function posLineCosts(supabase, clientId, lines, { inventory = true, buildYourOwn = [] } = {}) {
  const list = (lines || []).filter(Boolean)
  const recipeIds = uniq(list.map(l => l.recipe_id))
  const deltaLists = inventory ? list.map(lineChoiceDeltas).filter(Boolean) : []
  const { itemIds, subRecipeIds } = deltaIdsOf(deltaLists)
  // Awaited either way, so a mark read the caller started never rejects unheard.
  const [book, byoIds] = await Promise.all([
    recipeIds.length || deltaLists.length
      ? loadPosRecipeBook(supabase, clientId, { recipeIds: [...recipeIds, ...subRecipeIds], itemIds })
      : null,
    buildYourOwn,
  ])
  if (!book) return { costOf: () => 0 }
  const byo = new Set(inventory ? byoIds || [] : [])
  const [recipeCost, explosion] = await Promise.all([
    computeRecipeCosts(supabase, recipeIds, { book: byo.size ? withoutTypedCost(book, byo) : book }),
    loadDeltaExplosion(supabase, deltaLists, { book }),
  ])
  // The rates the walk priced the recipe part at, so a plate's two halves are priced alike.
  const rateByItem = {}
  book.items.forEach((it, id) => { rateByItem[id] = parseFloat(it?.per_uom_rate) || 0 })
  return {
    costOf: line => (recipeCost[line?.recipe_id] || 0)
      + (inventory ? plateExtrasCost(lineChoiceDeltas(line), explosion, rateByItem) : 0),
  }
}

/**
 * Which of these dishes are build-your-own (S760 `recipes.is_build_your_own`), for a page that has no
 * option catalog loaded. Read as loadOptionCatalog reads the mark: a database without the column marks
 * none. Any other failed read throws, since an unread mark would value the dish at its typed Cost Price.
 * @param {Function} scopedFrom  (table, columns) → a client-scoped builder
 * @param {string[]} recipeIds
 * @returns {Promise<string[]>}
 */
export async function buildYourOwnAmong(scopedFrom, recipeIds) {
  const ids = uniq(recipeIds)
  if (ids.length === 0) return []
  const res = await fetchAllRowsChunked(ids, chunk => scopedFrom('recipes', 'id').eq('is_build_your_own', true).in('id', chunk).order('id'))
  if (res.error) {
    if (isMissingColumn(res.error)) return []
    throw Object.assign(new Error(res.error.message || 'Could not read which dishes are build-your-own.'), { code: res.error.code, hint: res.error.hint, details: res.error.details })
  }
  return (res.data || []).map(r => r.id)
}
