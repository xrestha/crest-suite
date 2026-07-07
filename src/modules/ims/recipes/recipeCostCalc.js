// Pure cost/format/filter helpers for the Recipes page — no React, no Supabase. Shared by
// Recipes.js, RecipeDetailView.jsx, and RecipeCostCardPrint.jsx so the on-screen list, the
// detail view, and the printed cost card can never disagree about how a recipe's cost rolls up.

export const UNITS = ['GM', 'ML', 'KG', 'LTR', 'PCS', 'PKT', 'BTL', 'BOX', 'ROLL', 'BUNCH', 'JAR', 'CTN', 'BAG', 'TIN', 'SACHET']

export const EMPTY_RECIPE = { name: '', category: 'Food', selling_price: '', vat_rate: '0.13', yield_qty: '1', yield_uom: 'portion', target_fc_pct: '30', description: '', image_url: '', is_veg: '' }

// Format one nutrient value for display, e.g. "130 kcal", "2.7 g".
export function fmtNutrient(def, value) {
  const v = Number(value) || 0
  return `${v.toFixed(def.dp)} ${def.unit}`
}

// vat_rate may be 0 (No VAT); don't use `|| 0.13` — parseFloat(0) is falsy and would coerce 0% back to 13%.
export const vatOf = rec => (rec?.vat_rate === null || rec?.vat_rate === undefined) ? 0.13 : parseFloat(rec.vat_rate)

// Cost of one output unit of a sub-recipe (recursively resolves nested sub-recipes).
export function calcSubRecipeCostPerUnit(subRecipe, allRecipes) {
  if (!subRecipe) return 0
  const ings = subRecipe.recipe_ingredients || []
  let total = 0
  ings.forEach(ri => {
    if (ri.item_id && ri.items) {
      const yieldFactor = (parseFloat(ri.items.yield_pct) || 100) / 100
      total += (parseFloat(ri.qty_per_portion) / yieldFactor) * parseFloat(ri.items.per_uom_rate || 0)
    } else if (ri.sub_recipe_id) {
      const nested = allRecipes.find(r => r.id === ri.sub_recipe_id)
      if (nested) {
        const nestedCostPerUnit = calcSubRecipeCostPerUnit(nested, allRecipes)
        total += parseFloat(ri.qty_per_portion) * nestedCostPerUnit
      }
    }
  })
  const yieldQty = parseFloat(subRecipe.yield_qty) || 1
  return total / yieldQty
}

// Total ingredient cost of a saved recipe (one portion).
export function calcRecipeCost(recipe, allRecipes) {
  return (recipe.recipe_ingredients || []).reduce((sum, ri) => {
    if (ri.item_id && ri.items) {
      const yieldFactor = (parseFloat(ri.items.yield_pct) || 100) / 100
      return sum + (parseFloat(ri.qty_per_portion) / yieldFactor) * parseFloat(ri.items.per_uom_rate || 0)
    } else if (ri.sub_recipe_id && ri.sub_recipe) {
      const costPerUnit = calcSubRecipeCostPerUnit(ri.sub_recipe, allRecipes)
      return sum + parseFloat(ri.qty_per_portion) * costPerUnit
    }
    return sum
  }, 0)
}

// Live cost in edit mode — from the in-progress ingredient rows (which reference items/sub-recipes
// by id rather than carrying the joined `items`/`sub_recipe` objects a saved recipe has).
export function calcLiveCost(ingList, itemsList, allRecipes) {
  return ingList.reduce((sum, ing) => {
    if (ing.type === 'item') {
      const item = itemsList.find(i => i.id === ing.item_id)
      if (!item || !ing.qty_per_portion) return sum
      const yieldFactor = (parseFloat(item.yield_pct) || 100) / 100
      return sum + (parseFloat(ing.qty_per_portion) / yieldFactor) * parseFloat(item.per_uom_rate || 0)
    } else {
      const sr = allRecipes.find(r => r.id === ing.sub_recipe_id)
      if (!sr || !ing.qty_per_portion) return sum
      const costPerUnit = calcSubRecipeCostPerUnit(sr, allRecipes)
      return sum + parseFloat(ing.qty_per_portion) * costPerUnit
    }
  }, 0)
}

// True if a recipe contains an ingredient (item or nested sub-recipe) whose name matches `q`.
export function recipeHasIngredient(recipe, q, allRecipes, seen = new Set()) {
  if (!recipe || seen.has(recipe.id)) return false
  seen.add(recipe.id)
  return (recipe.recipe_ingredients || []).some(ri => {
    if (ri.item_id && ri.items) return ri.items.name.toLowerCase().includes(q)
    if (ri.sub_recipe_id) {
      const sr = ri.sub_recipe || allRecipes.find(r => r.id === ri.sub_recipe_id)
      if (sr?.name?.toLowerCase().includes(q)) return true
      return recipeHasIngredient(sr, q, allRecipes, new Set(seen))
    }
    return false
  })
}
