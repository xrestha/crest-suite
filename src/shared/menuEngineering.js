/**
 * The Menu Engineering classification, in ONE place.
 *
 * WHY THIS FILE EXISTS (S715)
 *
 * `MenuEngineering.js` and `computeMenuEngineeringSection.js` each carried their own copy of
 * `FC_CUTOFF`, `median()` and `classify()`, with a comment on both saying they were mirrored
 * "verbatim" and must never diverge. That is the shape this codebase keeps learning about the
 * hard way — a rule that lives in two files is a rule one of them will eventually stop
 * following, and the frozen Monthly Owner Report is the worst possible place to discover it,
 * because a snapshot is immutable: a quadrant frozen wrong stays wrong with nothing in the
 * artifact to say so. Same move as `imsFormulas.js`, `operatingBands.js` and `staffLevelBadge.js`.
 *
 * WHAT CHANGED WITH THE MOVE (both decided with Aashish, 2026-09-09):
 *
 * 1. **A dish with no price or no costed ingredients is NOT rated.** `fcPct` used to be
 *    `sellingPrice > 0 ? cost / price * 100 : 0`, and a cost of 0 divided by a real price is
 *    also a real `0` — so both "we have not priced this" and "we have not costed this" arrived
 *    at `classify()` as **0% food cost**, sailed under the 35% cutoff, and came back **Star** or
 *    **Plowhorse**: the single most flattering verdict the page can give, printed as
 *    "Keep on menu. Feature prominently." next to a green `0.0% ✓`. This is the S713 rule in
 *    `ims-figures.md` — a ratio with a zero numerator is not a ratio — except here it drives a
 *    VERDICT rather than only a colour, and `Recipes.js`'s own **+ New Recipe** produces exactly
 *    this state (a recipe with no ingredients yet), so the page manufactured its own Stars.
 *    The absence is carried as `null` from `menuFcPct()` all the way to the cell; `classify()`
 *    returns `null` rather than guessing, and the caller shows it as unrated with the reason.
 *
 * 2. **A dish that sold nothing is never "high popularity".** `highPop` was `qtySold >= median`,
 *    and the median is taken over EVERY active recipe including the ones that did not sell — so
 *    on any menu where under half the items sold in the period, the median is **0**, `0 >= 0` is
 *    true, and every unsold dish is high-popularity. Plowhorse and Dog become mathematically
 *    unreachable for that period and a dish with no sales at all renders as a Star. The in-app
 *    guide has always promised the opposite ("a recipe with zero sales is automatically Dog or
 *    Plowhorse"), which is now true. `qtySold > 0` only changes zero-sale dishes; every dish
 *    that actually sold keeps the quadrant it has today.
 *
 * The median deliberately still spans every rated-or-not, sold-or-not recipe, exactly as before —
 * narrowing it would re-classify large parts of a menu at once and pull new snapshots away from
 * the historical ones for a reason nobody asked for.
 */

/** Food cost % at or below which a dish counts as "high profit". */
export const FC_CUTOFF = 35

/** The four quadrants, in the order every surface lists them. */
export const QUADRANT_KEYS = ['Star', 'Plowhorse', 'Puzzle', 'Dog']

/** A fresh `{ Star: 0, … }` counter, plus the fifth bucket for what could not be rated. */
export function emptyQuadrantCounts() {
  return { Star: 0, Plowhorse: 0, Puzzle: 0, Dog: 0, Unrated: 0 }
}

export function median(arr) {
  if (!arr || arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * A dish's food cost %, or `null` when the page does not know it.
 *
 * Both inputs must be genuinely present: a price of 0 makes the ratio undefined, and a cost of 0
 * makes it a *number* that means "not costed" rather than "free to make". Returning `null` for
 * either is what stops the 0 becoming a verdict downstream — the first `? :` that defaults a
 * missing input to 0 destroys the distinction and no care at the call site gets it back.
 */
export function menuFcPct(ingredientCost, sellingPrice) {
  if (!(sellingPrice > 0) || !(ingredientCost > 0)) return null
  return (ingredientCost / sellingPrice) * 100
}

/** Why a dish could not be rated, as a sentence, or `null` when it can be. */
export function unratedReason(ingredientCost, sellingPrice) {
  const noPrice = !(sellingPrice > 0)
  const noCost = !(ingredientCost > 0)
  if (noPrice && noCost) return 'No selling price and no costed ingredients'
  if (noPrice) return 'No selling price set'
  if (noCost) return 'No costed ingredients — add a recipe or a manual cost'
  return null
}

/**
 * The quadrant, or `null` when the dish cannot be rated.
 *
 * `fcPct` is whatever `menuFcPct()` returned — pass the `null` straight through rather than
 * substituting a number for it.
 */
export function classify(fcPct, qtySold, medianQty) {
  if (fcPct == null || !isFinite(fcPct)) return null
  const highProfit = fcPct <= FC_CUTOFF
  // `qtySold > 0` is load-bearing, not belt-and-braces: without it a median of 0 makes every
  // unsold dish "popular". See the header note.
  const highPop = qtySold > 0 && qtySold >= medianQty
  if (highProfit && highPop) return 'Star'
  if (highProfit && !highPop) return 'Plowhorse'
  if (!highProfit && highPop) return 'Puzzle'
  return 'Dog'
}
