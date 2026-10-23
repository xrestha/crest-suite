// Which items a variance page judges, and the one verdict it gives each (S792, FIGURES-4 / D36).
//
// Variance and Theoretical vs Actual are adjacent nav items that measure the same thing, and until
// S792 they measured it over different item sets. Theoretical vs Actual built its rows from
// `itemList.filter(item => theoretical > 0.001)`, so an ingredient whose dishes sold nothing this
// month — but whose stock fell anyway — never reached it, while Variance judged it Over and put its
// whole usage into Total Variance Value. Same month: "Flagged 7, NPR 18,400 potential loss" on one
// page, "Items Over Tolerance 5, NPR 11,200" on the next. Owner decision D36: BOTH judge it, because
// stock vanishing with nothing sold is exactly what these pages exist to catch. Shrinkage follows
// the same rule per period.
//
// Variance.js is the reference; its population and its verdict moved here unchanged so the other
// pages can share them rather than copy them. Pure — no Supabase client, no React; the one reader
// here (`loadChoiceLinkedItemIds`) is handed its query builder and client by the caller.
//
// Every row function takes Variance.js's row shape:
//   measured         the month has a closing count AND this item has one (S719; a 0 is a count,
//                    a NULL physical_qty is not — closingCountMap below)
//   noRecipe         the item is in no recipe at any depth and no choice stock line (D17; S862
//                    REPORTS-STOCK-3: the client's choice lines, sold this month or not)
//   theoreticalUsed  sales × recipe (+ option deltas), through the depletion rule
//   actualUsed       computeUsed(): opening + net purchases − wastage − staff meals − closing
//   variancePct      (actual − theoretical) ÷ theoretical × 100, or null when theoretical ≤ 0
//   value            (actual − theoretical) × per-unit rate
//   hasCount, openQty, purchQty (net of returns AND of stock transfers, S849: received or returned
//                    transfer lines add like a purchase, sent lines come off like a return, so
//                    `hasVarianceActivity` and `isUncountedGap` see stock that only arrived by
//                    transfer, and a sender stops expecting stock that is on the way elsewhere)
import { varianceBand } from '../../../shared/imsFormulas'
import { deltaItems, loadDeltaExplosion, bookCoversDeltas } from '../../../utils/orderLineIngredients'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { throwFirstError } from '../../../shared/queryError'

/**
 * Is this closing_stock row a COUNT? A `physical_qty` of 0 is ("we looked, there was none" — S695);
 * a NULL is not (S792). The variance pages read a NULL as 0 through `parseFloat(q) || 0`, so an item
 * nobody counted read as counted-empty: its whole shelf "used", a fabricated Over and a fabricated
 * loss — the S719 defect by another door. The period close counts and carries forward
 * `physical_qty IS NOT NULL` (closePeriod.js), and the Owner Report's variance section does too.
 */
export function isClosingCount(row) {
  return row?.physical_qty != null
}

/**
 * Item id → counted quantity for ONE period's closing_stock rows, counts only. `item.id in map` is
 * then the per-item "measured" test. One row per item (UNIQUE(period_id, item_id)).
 */
export function closingCountMap(rows) {
  const out = {}
  ;(rows || []).forEach(r => { if (isClosingCount(r)) out[r.item_id] = parseFloat(r.physical_qty) || 0 })
  return out
}

/** The Flag column's words, shared by the pages' exports. */
export const VARIANCE_FLAG_TEXT = { over: 'over', under: 'under', ok: 'ok', unmeasured: 'not measurable', no_recipe: 'no recipe or choice linked' }

/**
 * Every item that a recipe (at any depth) or a choice stock line consumes. D17's "no recipe linked"
 * test is this set, NOT "theoretical usage was 0 this month" — a recipe ingredient whose dishes did
 * not sell is still judged. `breakdown` is `{ recipeId: [{ item_id, qty }] }` over the client's
 * WHOLE recipe book (explodeRecipeIngredients' shape); `depletingRows` are sales rows that have
 * already been through the depletion rule, whose `ingredient_deltas` name items reached only
 * through an option (extra cheese on a dish whose recipe has none — S758), including a choice since
 * deleted. `choiceItemIds` (S862 REPORTS-STOCK-3, `loadChoiceLinkedItemIds`) is every item the
 * client's choice lines reach today: an item only a choice uses (Oat Milk) is judged like a recipe
 * ingredient in a month nobody picked it, rather than greyed as "no recipe linked".
 */
export function linkedItemIdsOf(breakdown, depletingRows, explosion, choiceItemIds = null) {
  const ids = new Set()
  Object.values(breakdown || {}).forEach(ings => (ings || []).forEach(({ item_id }) => ids.add(item_id)))
  ;(depletingRows || []).forEach(s => {
    if (!s.ingredient_deltas) return
    deltaItems(s.ingredient_deltas, explosion).forEach(({ item_id }) => ids.add(item_id))
  })
  for (const id of choiceItemIds || []) ids.add(id)
  return ids
}

/** `pos_option_ingredients` rows → the stored-delta shape deltaItems reads. Pure. */
export function choiceLinesAsDeltas(rows) {
  const out = []
  for (const r of rows || []) {
    const qty = Number(r?.qty_per_portion) || 0
    if (!qty) continue
    if (r.item_id) out.push({ item_id: r.item_id, qty })
    else if (r.sub_recipe_id) out.push({ sub_recipe_id: r.sub_recipe_id, qty })
  }
  return out
}

/** The raw items these choice lines reach: an item line itself, a sub-recipe line through `explosion`. Pure. */
export function choiceLinkedItemIds(rows, explosion) {
  return new Set(deltaItems(choiceLinesAsDeltas(rows), explosion).map(({ item_id }) => item_id))
}

/**
 * Every item the client's choice stock lines reach today (S862 REPORTS-STOCK-3), for
 * `linkedItemIdsOf`. One scoped, paged read of `pos_option_ingredients`; a sub-recipe line goes
 * through the one conversion (loadDeltaExplosion), from `book` when it holds that sub-recipe. Read
 * it beside the recipe walk: it THROWS on a failed read like the walk, because a missed line would
 * grey a choice's item as "no recipe linked" and leave its loss out of every total.
 * @param {object} supabase
 * @param {Function} from  (table, columns) → a client-scoped builder
 * @param {object} [opts]  `book`: a recipe book (recipeCost.loadRecipeBook) the caller already holds
 * @returns {Promise<Set<string>>}
 */
export async function loadChoiceLinkedItemIds(supabase, from, { book } = {}) {
  const res = await fetchAllRows(() => from('pos_option_ingredients', 'item_id, sub_recipe_id, qty_per_portion').order('id'))
  throwFirstError([res])
  const rows = res.data || []
  // Only the sub-recipe lines need reading; an item line names its item. No sub-recipe line, no read.
  const subLines = choiceLinesAsDeltas(rows).filter(d => d.sub_recipe_id)
  const explosion = await loadDeltaExplosion(supabase, [subLines], { book: bookCoversDeltas(book, [subLines]) ? book : undefined })
  return choiceLinkedItemIds(rows, explosion)
}

/**
 * The percentage a row is banded on. Recipe-linked but nothing sold: the variance % is undefined
 * (÷ 0), yet any use is past every tolerance — a signed surrogate lets the band still apply the NPR
 * materiality floor, so a NPR 30 trace reads ≈ rather than Over. Display keeps printing "—".
 */
export function bandPctOf(row) {
  return row.theoreticalUsed > 0 ? row.variancePct
    : row.actualUsed === 0 ? 0
    : Math.sign(row.actualUsed) * Number.MAX_SAFE_INTEGER
}

/**
 * The ONE verdict a row carries (S756): varianceBand's object plus
 * `flag`: 'over' | 'under' | 'ok' | 'unmeasured' | 'no_recipe'. The Flag column, the flagged count,
 * the Over/Under filter and the row's colours all read it, so they cannot disagree.
 */
export function varianceRowBand(row, settings) {
  if (!row.measured) return { ...varianceBand(null, null, settings, { measured: false }), flag: 'unmeasured' }
  // Owner decision D17 (S756): an item that appears in NO recipe (gas, foil, napkins) has a
  // theoretical usage of 0 by construction, so every month it was used it read as a red Over — the
  // loudest verdict on the page, permanently, for stock nothing was ever expected to explain. It
  // gets its own grey state, stays listed with what was used, and is kept out of the flagged count
  // and the loss total.
  if (row.noRecipe) return { ...varianceBand(null, null, settings, { measured: false }), flag: 'no_recipe' }
  const b = varianceBand(bandPctOf(row), row.value, settings, { measured: true })
  return { ...b, flag: b.key === 'over' || b.key === 'under' ? b.key : 'ok' }
}

/** A row worth drawing: something moved, was expected to, or sat on the shelf. */
export function hasVarianceActivity(row) {
  return row.actualUsed !== 0 || row.theoreticalUsed > 0 || row.openQty > 0 || row.purchQty > 0
}

/**
 * An item that had stock or was expected to be used, with no closing count. It cannot be judged,
 * and it is named rather than silently skipped. An item with no stock presence at all was never
 * going to be counted and is not a gap.
 */
export function isUncountedGap(row) {
  return !row.hasCount && (row.openQty > 0 || row.purchQty > 0 || row.theoreticalUsed > 0)
}

/**
 * The rows every headline figure is computed over: measured (S719) and linked to a recipe (D17).
 * Including an uncounted item's fabricated variance is how a page reports a "potential loss" that
 * is really the shelf nobody counted; including a no-recipe item sums its whole usage in as "loss".
 */
export function judgedRows(rows) {
  return (rows || []).filter(r => r.measured && !r.noRecipe)
}
