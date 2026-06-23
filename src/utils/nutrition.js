// Per-portion nutrition for recipes — mirrors the cost engine in src/pages/Recipes.js.
//
// Cost divides ingredient qty by yield_pct because you must BUY more than you serve.
// Nutrition does NOT: the diner eats exactly qty_per_portion (the edible amount), so
// nutrition = qty_per_portion × (nutrient per basis unit), summed, with sub-recipes
// recursed exactly like calcSubRecipeCostPerUnit (÷ yield_qty).
//
// Item nutrition is stored on items.nutrition (jsonb), expressed per `basis_qty` of the
// item's OWN uom (e.g. per 100 GM, or per 1 PCS) so the math is unit-agnostic.

// Ordered nutrient field definitions (the "Standard 6").
export const NUTRIENTS = [
  { key: 'energy_kcal', label: 'Energy',  unit: 'kcal', dp: 0 },
  { key: 'protein_g',   label: 'Protein', unit: 'g',    dp: 1 },
  { key: 'carbs_g',     label: 'Carbs',   unit: 'g',    dp: 1 },
  { key: 'fat_g',       label: 'Fat',     unit: 'g',    dp: 1 },
  { key: 'sugar_g',     label: 'Sugar',   unit: 'g',    dp: 1 },
  { key: 'sodium_mg',   label: 'Sodium',  unit: 'mg',   dp: 0 },
]

// Blank nutrition object for forms.
export const EMPTY_NUTRITION = {
  basis_qty: 100, basis_unit: '',
  energy_kcal: '', protein_g: '', carbs_g: '', fat_g: '', sugar_g: '', sodium_mg: '',
  allergens: '', source: '',
}

const ZERO = () => NUTRIENTS.reduce((o, n) => { o[n.key] = 0; return o }, {})

// Unit conversion so the recipe qty (in the item's uom) and the nutrition basis unit can
// differ — e.g. a recipe uses 0.009 KG of coffee but nutrition is entered per 100 GM.
const MASS = { KG: 1000, GM: 1 }      // → grams
const VOLUME = { LTR: 1000, ML: 1 }   // → millilitres
function unitInfo(u) {
  const uu = String(u || '').toUpperCase()
  if (MASS[uu] != null) return { dim: 'mass', f: MASS[uu] }
  if (VOLUME[uu] != null) return { dim: 'vol', f: VOLUME[uu] }
  return { dim: 'count', f: 1 }
}
// Convert `qty` from `fromUnit` to `toUnit` when they share a dimension (mass/volume).
// Otherwise (counts, mismatched, or unknown units) return qty unchanged — same-unit assumption.
export function convertQty(qty, fromUnit, toUnit) {
  const a = unitInfo(fromUnit), b = unitInfo(toUnit)
  if (a.dim === b.dim && a.dim !== 'count') return qty * a.f / b.f
  return qty
}
// Sensible default nutrition basis unit for an item's uom: grams for mass, ml for volume,
// else the item's own unit (counts like PCS).
export function defaultBasisUnit(uom) {
  const info = unitInfo(uom)
  if (info.dim === 'mass') return 'GM'
  if (info.dim === 'vol') return 'ML'
  return String(uom || 'GM').toUpperCase()
}

// True when a nutrition object carries at least one usable nutrient value.
export function hasNutrition(n) {
  if (!n || typeof n !== 'object') return false
  return NUTRIENTS.some(def => {
    const v = parseFloat(n[def.key])
    return Number.isFinite(v) && v > 0
  })
}

// Split a free-text allergens field ("nuts, dairy") into a clean array.
export function parseAllergens(raw) {
  if (!raw) return []
  return String(raw)
    .split(/[,;/]/)
    .map(s => s.trim())
    .filter(Boolean)
}

// Nutrition contribution of `qty` (in the item's uom) of a single item.
// → { has, values:{...nutrient keys}, allergens:[] }
export function itemNutrition(item, qty) {
  const n = item?.nutrition
  const q = parseFloat(qty)
  if (!hasNutrition(n) || !Number.isFinite(q) || q <= 0) {
    return { has: hasNutrition(n), values: ZERO(), allergens: parseAllergens(n?.allergens) }
  }
  const basis = parseFloat(n.basis_qty) > 0 ? parseFloat(n.basis_qty) : 100
  const basisUnit = n.basis_unit || item?.uom
  const qtyInBasis = convertQty(q, item?.uom, basisUnit) // KG→GM, LTR→ML, etc.
  const factor = qtyInBasis / basis
  const values = NUTRIENTS.reduce((o, def) => {
    o[def.key] = (parseFloat(n[def.key]) || 0) * factor
    return o
  }, {})
  return { has: true, values, allergens: parseAllergens(n.allergens) }
}

function addInto(target, values) {
  NUTRIENTS.forEach(def => { target[def.key] += values[def.key] || 0 })
}

// Per-yield-unit nutrition of a sub-recipe (recursive). Mirrors calcSubRecipeCostPerUnit.
// → { values:{...per yield unit}, allergens:Set, covered:boolean }
export function calcSubRecipeNutritionPerUnit(sub, allRecipes, seen = new Set()) {
  const empty = { values: ZERO(), allergens: new Set(), covered: false }
  if (!sub || seen.has(sub.id)) return empty
  seen.add(sub.id)

  const total = ZERO()
  const allergens = new Set()
  let covered = false
  ;(sub.recipe_ingredients || []).forEach(ri => {
    if (ri.item_id && ri.items) {
      const r = itemNutrition(ri.items, ri.qty_per_portion)
      if (r.has) covered = true
      addInto(total, r.values)
      r.allergens.forEach(a => allergens.add(a))
    } else if (ri.sub_recipe_id) {
      const nested = allRecipes.find(r => r.id === ri.sub_recipe_id)
      if (nested) {
        const sr = calcSubRecipeNutritionPerUnit(nested, allRecipes, new Set(seen))
        if (sr.covered) covered = true
        const q = parseFloat(ri.qty_per_portion) || 0
        NUTRIENTS.forEach(def => { total[def.key] += (sr.values[def.key] || 0) * q })
        sr.allergens.forEach(a => allergens.add(a))
      }
    }
  })

  const yieldQty = parseFloat(sub.yield_qty) || 1
  const values = NUTRIENTS.reduce((o, def) => { o[def.key] = total[def.key] / yieldQty; return o }, {})
  return { values, allergens, covered }
}

// Full per-portion nutrition of a recipe.
// → { perPortion:{...nutrient keys}, allergens:[], coverage:{ have, total } }
export function calcRecipeNutrition(recipe, allRecipes) {
  const perPortion = ZERO()
  const allergens = new Set()
  let have = 0
  let total = 0

  ;(recipe?.recipe_ingredients || []).forEach(ri => {
    if (ri.item_id && ri.items) {
      total += 1
      const r = itemNutrition(ri.items, ri.qty_per_portion)
      if (r.has) have += 1
      addInto(perPortion, r.values)
      r.allergens.forEach(a => allergens.add(a))
    } else if (ri.sub_recipe_id) {
      const sub = ri.sub_recipe || allRecipes.find(r => r.id === ri.sub_recipe_id)
      if (sub) {
        total += 1
        const sr = calcSubRecipeNutritionPerUnit(sub, allRecipes)
        if (sr.covered) have += 1
        const q = parseFloat(ri.qty_per_portion) || 0
        NUTRIENTS.forEach(def => { perPortion[def.key] += (sr.values[def.key] || 0) * q })
        sr.allergens.forEach(a => allergens.add(a))
      }
    }
  })

  return { perPortion, allergens: Array.from(allergens), coverage: { have, total } }
}

// Live per-portion nutrition from the edit-form ingredient rows (mirrors calcLiveCost).
export function calcLiveNutrition(ingList, itemsList, allRecipes) {
  const perPortion = ZERO()
  const allergens = new Set()
  let have = 0
  let total = 0

  ingList.forEach(ing => {
    if (ing.type === 'item') {
      if (!ing.item_id || !ing.qty_per_portion) return
      const item = itemsList.find(i => i.id === ing.item_id)
      if (!item) return
      total += 1
      const r = itemNutrition(item, ing.qty_per_portion)
      if (r.has) have += 1
      addInto(perPortion, r.values)
      r.allergens.forEach(a => allergens.add(a))
    } else {
      if (!ing.sub_recipe_id || !ing.qty_per_portion) return
      const sub = allRecipes.find(r => r.id === ing.sub_recipe_id)
      if (!sub) return
      total += 1
      const sr = calcSubRecipeNutritionPerUnit(sub, allRecipes)
      if (sr.covered) have += 1
      const q = parseFloat(ing.qty_per_portion) || 0
      NUTRIENTS.forEach(def => { perPortion[def.key] += (sr.values[def.key] || 0) * q })
      sr.allergens.forEach(a => allergens.add(a))
    }
  })

  return { perPortion, allergens: Array.from(allergens), coverage: { have, total } }
}

// Build a nutrition object from form fields for saving; returns null when fully blank.
export function buildNutritionPayload(form, fallbackUnit) {
  if (!form) return null
  const anyValue = NUTRIENTS.some(def => form[def.key] !== '' && form[def.key] != null)
  const hasAllergens = !!(form.allergens && form.allergens.trim())
  if (!anyValue && !hasAllergens) return null
  const out = {
    basis_qty: parseFloat(form.basis_qty) > 0 ? parseFloat(form.basis_qty) : 100,
    basis_unit: (form.basis_unit || fallbackUnit || '').toUpperCase(),
  }
  NUTRIENTS.forEach(def => {
    const v = parseFloat(form[def.key])
    if (Number.isFinite(v)) out[def.key] = v
  })
  if (hasAllergens) out.allergens = form.allergens.trim()
  if (form.source) out.source = form.source
  return out
}
