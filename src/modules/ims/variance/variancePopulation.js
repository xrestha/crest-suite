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
// pages can share them rather than copy them. Pure — no Supabase, no React.
//
// Every row function takes Variance.js's row shape:
//   measured         the month has a closing count AND this item has one (S719; a 0 is a count,
//                    a NULL physical_qty is not — closingCountMap below)
//   noRecipe         the item is in no recipe at any depth and no option line (D17)
//   theoreticalUsed  sales × recipe (+ option deltas), through the depletion rule
//   actualUsed       computeUsed(): opening + net purchases − wastage − staff meals − closing
//   variancePct      (actual − theoretical) ÷ theoretical × 100, or null when theoretical ≤ 0
//   value            (actual − theoretical) × per-unit rate
//   hasCount, openQty, purchQty (net of returns)
import { varianceBand } from '../../../shared/imsFormulas'
import { deltaItems } from '../../../utils/orderLineIngredients'

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
export const VARIANCE_FLAG_TEXT = { over: 'over', under: 'under', ok: 'ok', unmeasured: 'not measurable', no_recipe: 'no recipe linked' }

/**
 * Every item that a recipe (at any depth) or a sold option line consumes. D17's "no recipe linked"
 * test is this set, NOT "theoretical usage was 0 this month" — a recipe ingredient whose dishes did
 * not sell is still judged. `breakdown` is `{ recipeId: [{ item_id, qty }] }` over the client's
 * WHOLE recipe book (explodeRecipeIngredients' shape); `depletingRows` are sales rows that have
 * already been through the depletion rule, whose `ingredient_deltas` name items reached only
 * through an option (extra cheese on a dish whose recipe has none — S758).
 */
export function linkedItemIdsOf(breakdown, depletingRows, explosion) {
  const ids = new Set()
  Object.values(breakdown || {}).forEach(ings => (ings || []).forEach(({ item_id }) => ids.add(item_id)))
  ;(depletingRows || []).forEach(s => {
    if (!s.ingredient_deltas) return
    deltaItems(s.ingredient_deltas, explosion).forEach(({ item_id }) => ids.add(item_id))
  })
  return ids
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
