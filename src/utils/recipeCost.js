// Shared recipe-costing helpers (pure, no React/Supabase deps).

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

  const { data: topIng } = await supabase
    .from('recipe_ingredients')
    .select('recipe_id, qty_per_portion, item_id, sub_recipe_id, items(yield_pct)')
    .in('recipe_id', recipeIds)

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
  let round = 0
  for (; round < MAX_DEPTH_ROUNDS && frontier.length > 0; round++) {
    // yield_qty (`sr`) is still fetched for the whole frontier every round — recipeMeta must
    // have an entry for every sub-recipe `explode()` might recurse into, including ones already
    // covered by `topIng`. Only the ingredient rows (`si`, the actual duplication risk) are
    // narrowed to ids not already fetched.
    const toFetchIngredients = frontier.filter(id => !fetchedIngredientsFor.has(id))
    const [{ data: sr }, { data: si }] = await Promise.all([
      supabase.from('recipes').select('id, yield_qty').in('id', frontier),
      toFetchIngredients.length > 0
        ? supabase.from('recipe_ingredients').select('recipe_id, qty_per_portion, item_id, sub_recipe_id, items(yield_pct)').in('recipe_id', toFetchIngredients)
        : Promise.resolve({ data: [] }),
    ])
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
    if (depth > 10) return [] // guard against runaway/cyclic sub-recipe refs
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

  const breakdown = await explodeRecipeIngredients(supabase, recipeIds)
  const itemIds = [...new Set(Object.values(breakdown).flatMap(rows => rows.map(r => r.item_id)))]

  const [{ data: rates }, { data: manualCosts }] = await Promise.all([
    itemIds.length > 0 ? supabase.from('items').select('id, per_uom_rate').in('id', itemIds) : Promise.resolve({ data: [] }),
    supabase.from('recipes').select('id, cost_price').in('id', recipeIds),
  ])
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
