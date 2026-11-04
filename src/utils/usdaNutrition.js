const BASE = 'https://api.nal.usda.gov/fdc/v1'

// USDA FoodData Central nutrient IDs → our schema keys (all values are per 100 g)
const NUTRIENT_MAP = {
  1008: 'energy_kcal',
  1003: 'protein_g',
  1005: 'carbs_g',
  1004: 'fat_g',
  2000: 'sugar_g',  // SR Legacy / Foundation
  1063: 'sugar_g',  // older SR Legacy alternate ID
  1093: 'sodium_mg',
}
// Foundation foods (the raw-ingredient entries: "Kiwifruit (kiwi), green, peeled, raw") carry no
// 1008 and give energy as Atwater kcal instead, specific factors first (S883). Without these the
// best match for a raw ingredient read as having no energy and was dropped.
const ENERGY_FALLBACK_IDS = [2048, 2047]

function searchUrl(query, pageSize) {
  const apiKey = process.env.REACT_APP_USDA_API_KEY || 'DEMO_KEY'
  return `${BASE}/foods/search` +
    `?query=${encodeURIComponent(query)}` +
    `&api_key=${apiKey}` +
    `&dataType=Foundation,SR%20Legacy` +
    `&pageSize=${pageSize}`
}

// One FDC food → our six figures, or null when it has no energy figure at all.
function nutrientsOf(food) {
  const out = { energy_kcal: null, protein_g: null, carbs_g: null, fat_g: null, sugar_g: null, sodium_mg: null }
  const byId = {}
  ;(food.foodNutrients || []).forEach(fn => {
    if (fn.value != null) byId[fn.nutrientId] = fn.value
    const key = NUTRIENT_MAP[fn.nutrientId]
    if (key && out[key] == null && fn.value != null) out[key] = fn.value
  })
  if (out.energy_kcal == null) {
    const id = ENERGY_FALLBACK_IDS.find(i => byId[i] != null)
    if (id != null) out.energy_kcal = byId[id]
  }
  return out.energy_kcal == null ? null : out
}

// Search USDA FoodData Central and return a nutrition payload, or null if not found.
// Falls back to DEMO_KEY (30 req/hr) if REACT_APP_USDA_API_KEY is not set.
export async function fetchUsdaNutrition(itemName) {
  try {
    const res = await fetch(searchUrl(itemName, 3))
    if (!res.ok) return null
    const json = await res.json()
    const food = json.foods?.[0]
    if (!food) return null

    const out = nutrientsOf(food)
    if (!out) return null

    return { basis_qty: 100, basis_unit: 'GM', ...out, allergens: '', source: 'USDA FDC' }
  } catch {
    return null
  }
}

// Several matches for the nutrition editor to pick from (S883): the first hit is often not the
// ingredient ("kiwi" ranks a juice drink above the raw fruit). Answers `{ foods, error }` and never
// throws. `error` is 'rate_limit' (429: DEMO_KEY allows about 30 searches an hour per network),
// 'refused' (any other non-2xx) or 'unreachable' (no answer, or not JSON).
export async function searchUsdaFoods(query, { limit = 6 } = {}) {
  let res
  try { res = await fetch(searchUrl(query, limit)) } catch { return { foods: [], error: 'unreachable' } }
  if (res.status === 429) return { foods: [], error: 'rate_limit' }
  if (!res.ok) return { foods: [], error: 'refused' }
  let json
  try { json = await res.json() } catch { return { foods: [], error: 'unreachable' } }
  const r0 = v => v == null ? null : Math.round(v)
  const r1 = v => v == null ? null : Math.round(v * 10) / 10
  const foods = (json.foods || []).map(food => {
    const n = nutrientsOf(food)
    if (!n) return null
    return {
      name: food.description || `FDC ${food.fdcId}`,
      code: food.fdcId != null ? String(food.fdcId) : null,
      unit: 'GM', source: 'USDA FDC', allergens: '',
      energy_kcal: r0(n.energy_kcal), protein_g: r1(n.protein_g), carbs_g: r1(n.carbs_g),
      fat_g: r1(n.fat_g), sugar_g: r1(n.sugar_g), sodium_mg: r0(n.sodium_mg),
    }
  }).filter(Boolean)
  return { foods, error: null }
}
