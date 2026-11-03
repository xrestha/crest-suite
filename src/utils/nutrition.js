// Per-portion nutrition for recipes — mirrors the cost engine in src/pages/Recipes.js.
//
// Cost divides ingredient qty by yield_pct because you must BUY more than you serve.
// Nutrition does NOT: the diner eats exactly qty_per_portion (the edible amount), so
// nutrition = qty_per_portion × (nutrient per basis unit), summed, with sub-recipes
// recursed exactly like calcSubRecipeCostPerUnit (÷ yield_qty).
//
// Item nutrition is stored on items.nutrition (jsonb), expressed per `basis_qty` of the
// item's OWN uom (e.g. per 100 GM, or per 1 PCS) so the math is unit-agnostic.
//
// The guest menu runs the same walk in SQL (_nutrition_rollup); change one, change the other.

import { normaliseAllergens, allergensToText, sortAllergens } from '../shared/constants/allergens'

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
// S870: an item counted in pieces (PCS, PKT, BTL…) whose figures are per grams or ml needs the
// weight of one piece (`grams_per_unit` in items.nutrition: grams, or ml for a volume basis).
// Without it there is no honest conversion, and it used to count one piece as one gram; now the
// item counts as missing nutrition data instead. _nutrition_item_contribution in SQL does the same.
export function pieceToBasisDim(uom, basisUnit) {
  const a = unitInfo(uom), b = unitInfo(basisUnit || uom)
  return a.dim === 'count' && b.dim !== 'count' ? b.dim : null
}
export function needsPieceWeight(item) {
  const n = item?.nutrition
  return hasNutrition(n) && pieceToBasisDim(item?.uom, n.basis_unit) !== null && !(parseFloat(n.grams_per_unit) > 0)
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

// An ingredient's allergens as one list: the 14 keys it carries, then any unmatched words.
function itemAllergens(n) {
  const { keys, other } = normaliseAllergens(n?.allergens)
  return [...keys, ...other]
}

// S870: an ingredient counts as checked for allergens once someone saved its form, even with nothing
// ticked. The flag lives in items.nutrition; the database clears it while an unmatched word remains.
export function allergensChecked(n) {
  return n?.allergens_checked === true
}

// S870: an item marked "not food" (a cup, a lid, a mop) has no nutrition and no allergens. It is
// checked, and it is left out of a recipe's nutrition data count, so a takeaway cup on a dish no
// longer reads as missing data.
export function isNotFood(n) {
  return n?.not_food === true
}

// Nutrition contribution of `qty` (in the item's uom) of a single item.
// → { has, checked, values:{...nutrient keys}, allergens:[] }
export function itemNutrition(item, qty) {
  const n = item?.nutrition
  const q = parseFloat(qty)
  const checked = allergensChecked(n)
  if (!hasNutrition(n) || !Number.isFinite(q) || q <= 0) {
    return { has: hasNutrition(n) && !needsPieceWeight(item), checked, values: ZERO(), allergens: itemAllergens(n) }
  }
  const basis = parseFloat(n.basis_qty) > 0 ? parseFloat(n.basis_qty) : 100
  const basisUnit = n.basis_unit || item?.uom
  const pieceDim = pieceToBasisDim(item?.uom, basisUnit)
  let qtyInBasis
  if (pieceDim) {
    const perPiece = parseFloat(n.grams_per_unit)
    if (!(perPiece > 0)) return { has: false, checked, values: ZERO(), allergens: itemAllergens(n) }
    qtyInBasis = convertQty(q * perPiece, pieceDim === 'mass' ? 'GM' : 'ML', basisUnit)
  } else {
    qtyInBasis = convertQty(q, item?.uom, basisUnit) // KG→GM, LTR→ML, etc.
  }
  const factor = qtyInBasis / basis
  const values = NUTRIENTS.reduce((o, def) => {
    o[def.key] = (parseFloat(n[def.key]) || 0) * factor
    return o
  }, {})
  return { has: true, checked, values, allergens: itemAllergens(n) }
}

// The allergen check for one walk (S870): every ingredient item reached, and whether the walk hit
// a cycle or a sub-recipe it could not find. The guest menu calls a dish complete only when it
// reached at least one item, every item is checked, and nothing was broken (_nutrition_rollup).
function newCheck() {
  return { items: new Map(), broken: false }
}
// `id` comes from the ingredient row (recipe_ingredients.item_id): the recipes page joins items
// without their id.
function noteItem(check, id, item) {
  if (check && id && !check.items.has(id)) {
    check.items.set(id, { id, name: item?.name, checked: allergensChecked(item?.nutrition), needsWeight: needsPieceWeight(item) })
  }
}
function summariseCheck(check) {
  const all = Array.from(check.items.values())
  const unchecked = all.filter(i => !i.checked).map(({ id, name }) => ({ id, name }))
  return { total: all.length, unchecked, broken: check.broken, complete: all.length > 0 && unchecked.length === 0 && !check.broken }
}
// The ingredients reached whose calories need the weight of one piece (S870).
function weightsMissing(check) {
  return Array.from(check.items.values()).filter(i => i.needsWeight).map(({ id, name }) => ({ id, name }))
}

function addInto(target, values) {
  NUTRIENTS.forEach(def => { target[def.key] += values[def.key] || 0 })
}

// Per-yield-unit nutrition of a sub-recipe (recursive). Mirrors calcSubRecipeCostPerUnit.
// `check` (optional) collects the allergen check across the whole walk.
// → { values:{...per yield unit}, allergens:Set, covered:boolean }
export function calcSubRecipeNutritionPerUnit(sub, allRecipes, seen = new Set(), check = null) {
  const empty = { values: ZERO(), allergens: new Set(), covered: false }
  if (!sub || seen.has(sub.id)) {
    if (check) check.broken = true
    return empty
  }
  seen.add(sub.id)

  const total = ZERO()
  const allergens = new Set()
  let covered = false
  ;(sub.recipe_ingredients || []).forEach(ri => {
    if (ri.item_id && ri.items) {
      const r = itemNutrition(ri.items, ri.qty_per_portion)
      if (r.has) covered = true
      noteItem(check, ri.item_id, ri.items)
      addInto(total, r.values)
      r.allergens.forEach(a => allergens.add(a))
    } else if (ri.sub_recipe_id) {
      const nested = allRecipes.find(r => r.id === ri.sub_recipe_id)
      if (nested) {
        const sr = calcSubRecipeNutritionPerUnit(nested, allRecipes, new Set(seen), check)
        if (sr.covered) covered = true
        const q = parseFloat(ri.qty_per_portion) || 0
        NUTRIENTS.forEach(def => { total[def.key] += (sr.values[def.key] || 0) * q })
        sr.allergens.forEach(a => allergens.add(a))
      } else if (check) {
        check.broken = true
      }
    }
  })

  const yieldQty = parseFloat(sub.yield_qty) || 1
  const values = NUTRIENTS.reduce((o, def) => { o[def.key] = total[def.key] / yieldQty; return o }, {})
  return { values, allergens, covered }
}

// Full per-portion nutrition of a recipe.
// → { perPortion:{...nutrient keys}, allergens:[], coverage:{ have, total },
//     allergenCheck:{ total, unchecked:[{id,name}], broken, complete } }
export function calcRecipeNutrition(recipe, allRecipes) {
  const perPortion = ZERO()
  const allergens = new Set()
  const check = newCheck()
  let have = 0
  let total = 0

  ;(recipe?.recipe_ingredients || []).forEach(ri => {
    if (ri.item_id && ri.items) {
      if (!isNotFood(ri.items.nutrition)) total += 1
      const r = itemNutrition(ri.items, ri.qty_per_portion)
      if (r.has) have += 1
      noteItem(check, ri.item_id, ri.items)
      addInto(perPortion, r.values)
      r.allergens.forEach(a => allergens.add(a))
    } else if (ri.sub_recipe_id) {
      const sub = ri.sub_recipe || allRecipes.find(r => r.id === ri.sub_recipe_id)
      if (sub) {
        total += 1
        const sr = calcSubRecipeNutritionPerUnit(sub, allRecipes, new Set([recipe?.id].filter(Boolean)), check)
        if (sr.covered) have += 1
        const q = parseFloat(ri.qty_per_portion) || 0
        NUTRIENTS.forEach(def => { perPortion[def.key] += (sr.values[def.key] || 0) * q })
        sr.allergens.forEach(a => allergens.add(a))
      } else {
        check.broken = true
      }
    }
  })

  return { perPortion, allergens: sortAllergens(Array.from(allergens)), coverage: { have, total }, allergenCheck: summariseCheck(check), needsWeight: weightsMissing(check) }
}

// Live per-portion nutrition from the edit-form ingredient rows (mirrors calcLiveCost).
export function calcLiveNutrition(ingList, itemsList, allRecipes) {
  const perPortion = ZERO()
  const allergens = new Set()
  const check = newCheck()
  let have = 0
  let total = 0

  ingList.forEach(ing => {
    if (ing.type === 'item') {
      if (!ing.item_id || !ing.qty_per_portion) return
      const item = itemsList.find(i => i.id === ing.item_id)
      if (!item) return
      if (!isNotFood(item.nutrition)) total += 1
      const r = itemNutrition(item, ing.qty_per_portion)
      if (r.has) have += 1
      noteItem(check, item.id, item)
      addInto(perPortion, r.values)
      r.allergens.forEach(a => allergens.add(a))
    } else {
      if (!ing.sub_recipe_id || !ing.qty_per_portion) return
      const sub = allRecipes.find(r => r.id === ing.sub_recipe_id)
      if (!sub) { check.broken = true; return }
      total += 1
      const sr = calcSubRecipeNutritionPerUnit(sub, allRecipes, new Set(), check)
      if (sr.covered) have += 1
      const q = parseFloat(ing.qty_per_portion) || 0
      NUTRIENTS.forEach(def => { perPortion[def.key] += (sr.values[def.key] || 0) * q })
      sr.allergens.forEach(a => allergens.add(a))
    }
  })

  return { perPortion, allergens: sortAllergens(Array.from(allergens)), coverage: { have, total }, allergenCheck: summariseCheck(check), needsWeight: weightsMissing(check) }
}

// Build a nutrition object from form fields for saving. S870: always an object, because saving the
// form is what marks an ingredient checked for allergens, even with no figures and nothing ticked.
// `form.allergens` may be free text or an array of words; an unmatched word leaves it not checked.
export function buildNutritionPayload(form, fallbackUnit) {
  if (!form) return null
  if (form.not_food) return notFoodPayload()
  const out = {
    basis_qty: parseFloat(form.basis_qty) > 0 ? parseFloat(form.basis_qty) : 100,
    basis_unit: (form.basis_unit || fallbackUnit || '').toUpperCase(),
  }
  NUTRIENTS.forEach(def => {
    const v = parseFloat(form[def.key])
    if (Number.isFinite(v)) out[def.key] = v
  })
  const perPiece = parseFloat(form.grams_per_unit)
  if (perPiece > 0) out.grams_per_unit = perPiece
  const parsed = normaliseAllergens(form.allergens)
  const text = allergensToText(parsed)
  if (text) out.allergens = text
  if (form.source) out.source = form.source
  out.allergens_checked = parsed.other.length === 0
  return out
}

// A bulk fill (library auto-fill, USDA lookup) laid over what an ingredient already holds (S870).
// Nobody reviewed the ingredient, so it keeps whatever checked state it had and is otherwise not
// checked, and any allergens it already carried survive beside the library's.
export function mergeNutritionFill(existing, fill) {
  const parsed = normaliseAllergens([existing?.allergens, fill?.allergens].filter(Boolean))
  const out = { ...fill }
  // A piece weight someone entered outlives a fill, which never carries one.
  if (!(parseFloat(out.grams_per_unit) > 0) && parseFloat(existing?.grams_per_unit) > 0) out.grams_per_unit = existing.grams_per_unit
  const text = allergensToText(parsed)
  if (text) out.allergens = text
  else delete out.allergens
  out.allergens_checked = allergensChecked(existing) && parsed.other.length === 0
  return out
}

// The Check allergens list (S870): a person confirmed these allergens for the ingredient. Its
// figures and everything else it holds stay as they are.
export function confirmAllergensPayload(existing, words) {
  const out = { ...(existing && typeof existing === 'object' ? existing : {}) }
  delete out.not_food
  const parsed = normaliseAllergens(words)
  const text = allergensToText(parsed)
  if (text) out.allergens = text
  else delete out.allergens
  out.allergens_checked = parsed.other.length === 0
  return out
}

// Not food: nothing else to say about it.
export function notFoodPayload() {
  return { not_food: true, allergens_checked: true }
}
