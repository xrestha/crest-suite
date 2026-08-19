// Menu-item Product Codes — <first 3 letters of the category>-<sequence>, e.g. Beverage → BEV-001.
//
// Shared because two places issue them and must agree: Recipe Costing auto-fills one as a new
// recipe is written, and Settings → Product Codes fills in the ones that predate the feature.
// Kept pure and tested for the obvious reason — a generator that hands out a code twice writes a
// duplicate straight into a per-client unique index (recipes_client_recipe_code_key) and the save
// fails in front of the user.
//
// Sub-recipes are deliberately NOT part of this: they carry their own auto-generated SRC-nnn
// series (settings.sub_recipe_code_prefix), issued at insert time in Recipes.js. One recipe, one
// code, one series that owns it.

export const SUB_RECIPE_CATEGORY = 'Sub-Recipe'

/**
 * The 3-letter prefix for a category. Strips anything that isn't a letter or digit first, so
 * "Veg & Fruits" → VEG and "Non-Veg" → NON rather than dragging punctuation into a code.
 * Categories shorter than three characters keep what they have ("Ice" → ICE, "Aa" → AA).
 *
 * Two categories that share their first three letters (Dessert / Desserts) share one numbering
 * sequence. That is harmless — the codes stay unique because the sequence is per PREFIX, not per
 * category — but it is why the counter below must key off the prefix and never off the category.
 */
export function productCodePrefix(category) {
  const cleaned = String(category || '').replace(/[^a-zA-Z0-9]/g, '')
  if (!cleaned) return 'GEN'
  return cleaned.slice(0, 3).toUpperCase()
}

/**
 * The next free code for a prefix, given every code already in use for this client.
 * Reads the highest number actually present rather than counting rows, so a deletion leaves a gap
 * instead of handing the next recipe a code that is still on an old one.
 */
export function nextProductCode(prefix, existingCodes) {
  const re = new RegExp(`^${prefix}-(\\d+)$`)
  let max = 0
  for (const c of existingCodes || []) {
    const m = String(c || '').trim().toUpperCase().match(re)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`
}

/**
 * Codes for every menu recipe that has none, allocated in one pass.
 *
 * Recipes that already carry a code are left completely alone — this fills gaps, it does not
 * renumber. That is the one way it differs from the Item / Vendor / Sub-Recipe "Regenerate All"
 * actions next to it in Settings, and the difference is deliberate: a Product Code is often the
 * code a migrating client already prints on their own menu, so reassigning it destroys the very
 * recognisability the field exists for.
 *
 * Returns [{ id, recipe_code }] for the rows that need writing, in a stable order (category, then
 * name) so a re-run over the same data produces the same codes.
 */
export function assignMissingProductCodes(recipes) {
  const all = recipes || []
  const taken = all.map(r => r.recipe_code).filter(Boolean)

  // Per-prefix counter seeded from what is already in use, so new codes continue the series
  // rather than colliding with it.
  const counters = new Map()
  const nextFor = prefix => {
    if (!counters.has(prefix)) {
      const seed = nextProductCode(prefix, taken)
      counters.set(prefix, parseInt(seed.slice(prefix.length + 1), 10))
    } else {
      counters.set(prefix, counters.get(prefix) + 1)
    }
    return `${prefix}-${String(counters.get(prefix)).padStart(3, '0')}`
  }

  return all
    .filter(r => r.category !== SUB_RECIPE_CATEGORY && !String(r.recipe_code || '').trim())
    .sort((a, b) =>
      String(a.category || '').localeCompare(String(b.category || '')) ||
      String(a.name || '').localeCompare(String(b.name || '')))
    .map(r => ({ id: r.id, recipe_code: nextFor(productCodePrefix(r.category)) }))
}
