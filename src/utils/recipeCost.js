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
export async function explodeRecipeIngredients(supabase, recipeIds) {
  if (!recipeIds || recipeIds.length === 0) return {}

  const { data: topIng } = await supabase
    .from('recipe_ingredients')
    .select('recipe_id, qty_per_portion, item_id, sub_recipe_id, items(yield_pct)')
    .in('recipe_id', recipeIds)

  const allIng = [...(topIng || [])]
  const recipeMeta = {} // sub_recipe id -> { id, yield_qty }
  let frontier = [...new Set(allIng.map(r => r.sub_recipe_id).filter(Boolean))]
  for (let round = 0; round < 5 && frontier.length > 0; round++) {
    const [{ data: sr }, { data: si }] = await Promise.all([
      supabase.from('recipes').select('id, yield_qty').in('id', frontier),
      supabase.from('recipe_ingredients').select('recipe_id, qty_per_portion, item_id, sub_recipe_id, items(yield_pct)').in('recipe_id', frontier),
    ])
    ;(sr || []).forEach(r => { recipeMeta[r.id] = r })
    allIng.push(...(si || []))
    frontier = [...new Set((si || []).map(r => r.sub_recipe_id).filter(Boolean))].filter(id => !recipeMeta[id])
  }

  function explode(recipeId, scale, depth) {
    if (depth > 10) return [] // guard against runaway/cyclic sub-recipe refs
    const result = []
    for (const r of allIng.filter(x => x.recipe_id === recipeId)) {
      const qty = parseFloat(r.qty_per_portion || 0) * scale
      if (r.item_id) {
        const yf = (parseFloat(r.items?.yield_pct) || 100) / 100
        result.push({ item_id: r.item_id, qty: qty / yf })
      } else if (r.sub_recipe_id) {
        const sr = recipeMeta[r.sub_recipe_id]
        if (sr) result.push(...explode(r.sub_recipe_id, qty / (parseFloat(sr.yield_qty) || 1), depth + 1))
      }
    }
    return result
  }

  const out = {}
  for (const recipeId of recipeIds) {
    const agg = {}
    explode(recipeId, 1, 0).forEach(({ item_id, qty }) => { agg[item_id] = (agg[item_id] || 0) + qty })
    out[recipeId] = Object.entries(agg).map(([item_id, qty]) => ({ item_id, qty }))
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
