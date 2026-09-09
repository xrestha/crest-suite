// Shared recipe-costing helpers (pure, no React/Supabase deps).
import { throwFirstError } from '../shared/queryError'
import { fetchAllRowsChunked } from '../shared/fetchAllRows'

// Suggested menu price to hit a target food-cost %, VAT-inclusive and rounded up to the
// nearest NPR 5. `cost` is the per-portion food cost (ex-VAT), `targetFcPct` is a fraction
// (0.30 = 30%). Used by the Recipe Costing page and the Menu Repricing report.
export function getSuggestedPrice(cost, vatRate = 0.13, targetFcPct = 0.30) {
  const basePrice = cost / targetFcPct
  return Math.ceil((basePrice * (1 + vatRate)) / 5) * 5
}

// Explodes a batch of recipes into their raw-ingredient quantities per one unit/portion,
// recursing through sub-recipes to arbitrary depth via an iterative frontier-fetch loop (capped
// at 5 rounds). Returns { [recipeId]: [{ item_id, qty }] } — qty is base-UOM, yield_pct-trimmed
// and sub-recipe yield_qty-scaled, duplicate item_ids aggregated per recipe. Caller multiplies by
// their own qty (this returns per-one-unit quantities). Requires a live Supabase client.
//
// Thin wrapper over explodeRecipeTree below, which does the actual work and additionally reports
// the sub-recipe nodes it passes through. This function's return shape is depended on by ~8 files
// (Variance, ReorderReport, StockReport, ShrinkageReport, ClientDashboard, OwnerDashboard,
// computeMonthlyReport, computeInventoryVariance/ShrinkageTrend) — every one of them drives a
// stock or cost figure, so it must keep returning exactly the flat item array it always has.
export async function explodeRecipeIngredients(supabase, recipeIds) {
  const tree = await explodeRecipeTree(supabase, recipeIds)
  const out = {}
  for (const recipeId of Object.keys(tree)) out[recipeId] = tree[recipeId].items
  return out
}

// Same recursion as above, but also reports the sub-recipe nodes it passes through on the way
// down — which explodeRecipeIngredients throws away, since a sub-recipe is only ever a scaling
// step between a dish and its raw items (recipe_ingredients stores sub_recipe_id with item_id
// NULL, so a sub-recipe can never be a leaf). That discarded middle layer is exactly what
// "how many batches of this sauce did we use" needs, so it's collected here instead of being
// re-derived by a second, drift-prone copy of the same walk.
//
// Returns { [recipeId]: { items: [{ item_id, qty }], subRecipes: [{ sub_recipe_id, qty, batches }] } }
// per one unit/portion of the parent, both arrays aggregated by id:
//   qty     — output units of the sub-recipe consumed (the unit its yield_uom names)
//   batches — qty ÷ that sub-recipe's own yield_qty, i.e. fraction of a batch
// Nested sub-recipes are reported at their own output-unit scale, not the top parent's, so a
// base sauce used inside another sauce shows its real consumption rather than being folded away.
export async function explodeRecipeTree(supabase, recipeIds) {
  if (!recipeIds || recipeIds.length === 0) return {}

  // A failed read THROWS rather than walking an empty tree (S695). Every consumer of this walk
  // subtracts its output from stock, so a read that returned `{ data: null, error }` and was
  // then treated as "no ingredients" produced a usage of zero for every dish sold — Stock
  // Report's on-hand climbed to opening + purchases, Variance read as fully under-consumed, and
  // nothing on any page said a read had failed (the S612 silent-zero rule, one layer down from
  // where the pages check it). Callers catch this and route it to their own load-error surface;
  // the ones that run inside a try/catch harness already did.
  // PAGED AND CHUNKED, both for the same read (S711). Two separate caps sit on this one query and
  // each of them is silent in its own way:
  //
  //   Rows — `recipe_ingredients` is one row per ingredient per recipe, and the biggest callers
  //   seed with the client's ENTIRE recipe book (Variance.js passes `scopedFrom('recipes','id')`
  //   unfiltered). A book of ~120 recipes averaging 8 ingredients is already past PostgREST's
  //   1000-row cap, and the rows past the cut simply are not there: every dish below them
  //   explodes to nothing, theoretical usage comes out LOW, and low theoretical reads as
  //   over-consumption — false variance flags, overstated shrinkage, understated reorder need,
  //   and an understated COGS on both dashboards and the Monthly Owner Report. No error, no
  //   short-array tell; the figure just looks like a slightly better week.
  //
  //   URL — a `.in()` list is spelled out in the request URL at ~37 characters per uuid, so a few
  //   hundred recipe ids is a 414 rather than a truncation.
  //
  // `.order('id')` is the unique tiebreaker fetchAllRows requires: without a total order, paging
  // can repeat a row on one page and skip it on the next, which would turn a truncation into a
  // subtler wrong-quantity bug. The order is otherwise irrelevant — everything below aggregates.
  const topRes = await fetchAllRowsChunked(recipeIds, ids => supabase
    .from('recipe_ingredients')
    .select('recipe_id, qty_per_portion, item_id, sub_recipe_id, items(yield_pct)')
    .in('recipe_id', ids)
    .order('id'))
  throwFirstError([topRes])
  const { data: topIng } = topRes

  const allIng = [...(topIng || [])]
  const recipeMeta = {} // sub_recipe id -> { id, yield_qty }
  // Tracks whose recipe_ingredients rows are already in `allIng` — starts with the caller's own
  // seed list, since `topIng` above already covers every id in it. Without this, a recipe that's
  // BOTH a caller-supplied seed id AND referenced as someone else's sub_recipe_id (e.g. a caller
  // that passes every recipe including sub-recipes, like ClientDashboard.jsx's reorder/variance
  // calc) gets its ingredient rows fetched a second time via the frontier loop below and pushed
  // into `allIng` twice — silently doubling its contribution for every parent recipe that
  // references it. Found live (S477): Acai Powder's usage on the Dashboard was showing exactly
  // 2x its real value because "Acai Base" (a sub-recipe) was both a seed id and referenced by two
  // other seed recipes, while ReorderReport.js — which only ever seeds with sold top-level
  // dishes, never a sub-recipe id directly — never hit this path and computed correctly.
  const fetchedIngredientsFor = new Set(recipeIds)
  let frontier = [...new Set(allIng.map(r => r.sub_recipe_id).filter(Boolean))]
  // Round 0 fetches level 2, so MAX_DEPTH_ROUNDS rounds resolves that many levels below the top
  // dish. Raised from 5 to 12 when nested "micro" sub-recipes became a supported shape: running
  // out of rounds does not error, it just stops descending, so the ingredients below the cut
  // vanish from COGS and Variance as a believable smaller number. Each round is 2 queries against
  // a frontier that shrinks fast, so the extra headroom costs nothing on a shallow tree.
  const MAX_DEPTH_ROUNDS = 12
  // Set by explode() below if the recursion ever hits that cap. A flag rather than a log at the
  // call site: explode() runs once per seed recipe and would otherwise repeat the same warning
  // hundreds of times for one deep tree.
  let depthExceeded = false
  let round = 0
  for (; round < MAX_DEPTH_ROUNDS && frontier.length > 0; round++) {
    // yield_qty (`sr`) is still fetched for the whole frontier every round — recipeMeta must
    // have an entry for every sub-recipe `explode()` might recurse into, including ones already
    // covered by `topIng`. Only the ingredient rows (`si`, the actual duplication risk) are
    // narrowed to ids not already fetched.
    const toFetchIngredients = frontier.filter(id => !fetchedIngredientsFor.has(id))
    // Same paging/chunking as the top-level read above, for the same two reasons — a wide prep
    // book (every sauce, batter and marinade referenced by anything sold) reaches this loop as
    // one frontier. fetchAllRowsChunked returns `{ data: [] }` for an empty id list on its own,
    // so the `toFetchIngredients.length > 0` ternary this replaced is no longer needed.
    const roundResults = await Promise.all([
      fetchAllRowsChunked(frontier, ids => supabase
        .from('recipes').select('id, yield_qty').in('id', ids).order('id')),
      fetchAllRowsChunked(toFetchIngredients, ids => supabase
        .from('recipe_ingredients')
        .select('recipe_id, qty_per_portion, item_id, sub_recipe_id, items(yield_pct)')
        .in('recipe_id', ids)
        .order('id')),
    ])
    throwFirstError(roundResults)
    const [{ data: sr }, { data: si }] = roundResults
    ;(sr || []).forEach(r => { recipeMeta[r.id] = r })
    toFetchIngredients.forEach(id => fetchedIngredientsFor.add(id))
    allIng.push(...(si || []))
    frontier = [...new Set((si || []).map(r => r.sub_recipe_id).filter(Boolean))].filter(id => !recipeMeta[id])
  }
  // Loud rather than silent. If the frontier is still non-empty the tree is deeper than the cap
  // (or cyclic despite Recipes.js's save-time check), and every figure derived from this walk is
  // understated by whatever sits below the cut.
  if (frontier.length > 0) {
    console.error(
      `explodeRecipeTree: sub-recipe nesting deeper than ${MAX_DEPTH_ROUNDS} levels, or a cycle — ` +
      `${frontier.length} sub-recipe(s) not resolved. COGS/Variance from this walk are UNDERSTATED. ` +
      `Unresolved ids: ${frontier.join(', ')}`
    )
  }

  // `subs` is an out-param the caller passes in — pushing into it rather than returning a second
  // array keeps the leaf-item return value (and so the recursive spread below) byte-identical to
  // what this function did before sub-recipe reporting existed.
  function explode(recipeId, scale, depth, subs) {
    // TIED TO MAX_DEPTH_ROUNDS, not a second number (S714). This was a hardcoded 10 while the
    // fetch loop above was raised 5 -> 12 by the S602 fix, which left the two caps disagreeing in
    // the worst possible direction: the loop resolved levels the recursion then refused to walk,
    // so the frontier came back EMPTY, the loud console.error below never fired, and the deepest
    // levels were dropped in exactly the silence that fix existed to end. Running out of depth is
    // now reported wherever it happens.
    if (depth > MAX_DEPTH_ROUNDS) {
      depthExceeded = true
      return []
    }
    const result = []
    for (const r of allIng.filter(x => x.recipe_id === recipeId)) {
      const qty = parseFloat(r.qty_per_portion || 0) * scale
      if (r.item_id) {
        const yf = (parseFloat(r.items?.yield_pct) || 100) / 100
        result.push({ item_id: r.item_id, qty: qty / yf })
      } else if (r.sub_recipe_id) {
        const sr = recipeMeta[r.sub_recipe_id]
        if (sr) {
          // `qty` is already this sub-recipe's own output units (scaled by every yield_qty above
          // it), and the recursion scale below is the same figure expressed in batches — so both
          // reported numbers are the ones the walk already had to compute, not a re-derivation.
          const batches = qty / (parseFloat(sr.yield_qty) || 1)
          subs.push({ sub_recipe_id: r.sub_recipe_id, qty, batches })
          result.push(...explode(r.sub_recipe_id, batches, depth + 1, subs))
        }
      }
    }
    return result
  }

  const out = {}
  for (const recipeId of recipeIds) {
    const agg = {}
    const subs = []
    explode(recipeId, 1, 0, subs).forEach(({ item_id, qty }) => { agg[item_id] = (agg[item_id] || 0) + qty })
    const subAgg = {}
    subs.forEach(({ sub_recipe_id, qty, batches }) => {
      const e = subAgg[sub_recipe_id] || (subAgg[sub_recipe_id] = { qty: 0, batches: 0 })
      e.qty += qty
      e.batches += batches
    })
    out[recipeId] = {
      items: Object.entries(agg).map(([item_id, qty]) => ({ item_id, qty })),
      subRecipes: Object.entries(subAgg).map(([sub_recipe_id, e]) => ({ sub_recipe_id, ...e })),
    }
  }
  // Same failure as an unresolved frontier, one layer down and previously unreported: rows were
  // fetched but never walked, so everything below the cut is missing from these figures and
  // missing usage reads as over-consumption, not as an error.
  if (depthExceeded) {
    console.error(
      `explodeRecipeTree: sub-recipe nesting deeper than ${MAX_DEPTH_ROUNDS} levels — the ingredients ` +
      `below that were fetched but not walked. COGS/Variance from this walk are UNDERSTATED.`
    )
  }
  return out
}

// Food cost per portion for a set of recipes, recursing through sub-recipes to arbitrary depth
// (built on explodeRecipeIngredients above, so it shares the same correct recursion — no longer
// limited to one level of sub-recipe nesting). Mirrors the cost calculation in
// src/pages/MenuPricing.js, scoped to an arbitrary recipe id list — used e.g. to value a
// complimentary/comp item at cost rather than menu price. Requires a live Supabase client.
//
// Falls back to `recipes.cost_price` (manually entered via Menu Pricing's POS-only Add Item
// modal) for recipes with no ingredient breakdown — POS-only clients have no Item Master to
// link an ingredient to, so this is the only cost basis they can ever supply.
export async function computeRecipeCosts(supabase, recipeIds) {
  if (!recipeIds || recipeIds.length === 0) return {}

  // cost_price needs nothing from the explode walk — start it first so it runs concurrently with
  // the walk's own round trips instead of adding a serial one after them.
  //
  // Both reads are chunked/paged (S711): `recipeIds` here is whatever the caller sold or listed,
  // and `itemIds` is every distinct raw ingredient underneath all of it — a full menu resolves to
  // more of both than a `.in()` URL holds.
  const manualCostsPromise = fetchAllRowsChunked(recipeIds, ids => supabase
    .from('recipes').select('id, cost_price').in('id', ids).order('id'))
  const breakdown = await explodeRecipeIngredients(supabase, recipeIds)
  const itemIds = [...new Set(Object.values(breakdown).flatMap(rows => rows.map(r => r.item_id)))]

  const costResults = await Promise.all([
    fetchAllRowsChunked(itemIds, ids => supabase
      .from('items').select('id, per_uom_rate').in('id', ids).order('id')),
    manualCostsPromise,
  ])
  // These two dropped their errors while the walk above them threw on its own (S695), which left
  // exactly one silent path back in: a failed `items` read gives every rate 0, so `ingredientCost`
  // is 0, so every recipe falls through to `manualMap` — also 0 — and the caller gets a complete
  // cost map of zeros. That is a 100% margin on Recipe Margin and Best Sellers, a comp valued at
  // nothing on the POS exception report, and a frozen zero in the Monthly Owner Report snapshot.
  // Throwing matches explodeRecipeTree, so the callers that already catch it need no change.
  throwFirstError(costResults)
  const [{ data: rates }, { data: manualCosts }] = costResults
  const rateMap = {}
  ;(rates || []).forEach(i => { rateMap[i.id] = parseFloat(i.per_uom_rate) || 0 })
  const manualMap = {}
  ;(manualCosts || []).forEach(r => { manualMap[r.id] = parseFloat(r.cost_price) || 0 })

  const costMap = {}
  for (const recipeId of recipeIds) {
    const ingredientCost = (breakdown[recipeId] || []).reduce((sum, { item_id, qty }) => sum + qty * (rateMap[item_id] || 0), 0)
    costMap[recipeId] = ingredientCost > 0 ? ingredientCost : (manualMap[recipeId] || 0)
  }
  return costMap
}
