// Parse + validate an uploaded Recipe Import sheet against the client's items and sub-recipes.
// Pure (no React, no Supabase), moved out of RecipeImportButton.jsx in S792 so the ingredient
// resolution can be tested — recipeImportParse.test.js.

import { convertQty } from '../../../utils/nutrition'

/**
 * Item code → every item carrying it. Two items can share a code (S792, MASTER-5): Item Master
 * minted the next code from a list it did not refresh after an add, so two items added in one visit
 * both got ITM-010, and `item_code` has no unique index. A Map keyed straight on the code kept the
 * LAST of the two, so a recipe line typed "ITM-010" silently linked whichever item happened to be
 * read second — a wrong recipe cost and wrong theoretical usage, with the preview printing what was
 * typed rather than what it resolved to.
 */
function itemsByCode(items) {
  const lc = s => String(s ?? '').trim().toLowerCase()
  const byCode = new Map()
  for (const i of items || []) {
    const code = lc(i.item_code)
    if (!code) continue
    const list = byCode.get(code)
    if (list) list.push(i)
    else byCode.set(code, [i])
  }
  return byCode
}

/**
 * Resolve one typed ingredient: a code first, then an item name, then a sub-recipe name.
 * `{ item }` or `{ sub }` when it resolves to exactly one thing; `{ ambiguous: [items] }` when the
 * text is a code more than one item carries — refused rather than guessed, because either guess
 * costs the recipe with the wrong ingredient; `{}` when nothing matches.
 */
export function resolveIngredient(text, { byCode, byName, subByName }) {
  const key = String(text ?? '').trim().toLowerCase()
  if (!key) return {}
  const coded = byCode.get(key)
  if (coded && coded.length > 1) return { ambiguous: coded }
  if (coded && coded.length === 1) return { item: coded[0] }
  const named = byName.get(key)
  if (named) return { item: named }
  const sub = subByName.get(key)
  if (sub) return { sub }
  return {}
}

export function parseImportRows(rows, items, subRecipes, recipes) {
  const norm = s => String(s ?? '').trim()
  const lc = s => norm(s).toLowerCase()
  const lookup = {
    byCode: itemsByCode(items),
    byName: new Map((items || []).map(i => [lc(i.name), i])),
    subByName: new Map((subRecipes || []).map(s => [lc(s.name), s])),
  }
  const existingRecipeNames = new Set((recipes || []).filter(r => r.category !== 'Sub-Recipe').map(r => lc(r.name)))

  const out = []
  let current = null
  for (const row of rows) {
    const name = norm(row[0])
    const ingName = norm(row[4])
    if (name) {
      current = {
        name,
        category: norm(row[1]) || 'Food',
        selling_price: row[2] === '' || row[2] == null ? null : parseFloat(row[2]),
        yield_qty: row[3] === '' || row[3] == null ? 1 : (parseFloat(row[3]) || 1),
        lines: [],
        duplicate: existingRecipeNames.has(lc(name)),
        isSub: lc(norm(row[1])) === 'sub-recipe',
      }
      out.push(current)
    }
    if (!ingName) continue
    if (!current) continue
    const qty = parseFloat(row[5])
    const unit = norm(row[6])
    const hit = resolveIngredient(ingName, lookup)
    const match = hit.item || null
    const sub = hit.sub || null
    const type = match ? 'item' : sub ? 'sub_recipe' : null
    let warning = ''
    let finalQty = qty
    if (match && unit) {
      const itemUom = (match.uom || '').toUpperCase()
      if (unit.toUpperCase() !== itemUom) {
        const conv = convertQty(qty, unit, itemUom)
        if (conv === qty && unit.toUpperCase() !== itemUom) warning = `unit "${unit}" ≠ item unit "${itemUom}" — qty used as-is`
        else finalQty = conv
      }
    }
    const reason = hit.ambiguous
      ? `code "${ingName}" is on ${hit.ambiguous.length} items (${hit.ambiguous.map(i => i.name).join(', ')}) — type the item's name instead, or give one of them a new code in Item Master`
      : !type ? 'no matching item or sub-recipe'
      : !(qty > 0) ? 'qty missing/invalid'
      : ''
    current.lines.push({
      ingName, qty: finalQty, rawQty: qty, unit,
      matched: !!type, type,
      item_id: type === 'item' ? match.id : null,
      sub_recipe_id: type === 'sub_recipe' ? sub.id : null,
      // What the typed text RESOLVED to, so the preview can show it (S792, MASTER-5): "ITM-010 →
      // Chicken Breast". Typing a name resolves to that name, so only a code lookup adds anything.
      resolvedName: type === 'item' ? match.name : type === 'sub_recipe' ? sub.name : null,
      byCode: type === 'item' && lc(match.name) !== lc(ingName),
      ambiguous: !!hit.ambiguous,
      reason,
      warning,
    })
  }
  // A line is importable only if matched AND qty > 0
  out.forEach(r => {
    r.matchedLines = r.lines.filter(l => l.matched && l.qty > 0)
    r.badLines = r.lines.filter(l => !(l.matched && l.qty > 0))
    // THE SAME GUARD save() APPLIES, WHICH THIS PATH NEVER HAD (S714).
    //
    // `recipe_ingredients` has UNIQUE (recipe_id, item_id), so two lines naming one item make the
    // insert below fail outright with 21000 — after the recipe row has already been written,
    // leaving an ingredient-less recipe that costs 0 and wears a green food-cost tick. Two lines
    // naming one SUB-RECIPE fail at nothing at all: item_id is NULL there, so it never matches
    // that conflict target, both rows insert, and the recipe silently costs the prep item twice.
    // The silent half is the worse half, and neither was detectable in the preview.
    //
    // Refused rather than summed, exactly as save() refuses it: 200g and 50g of one item is as
    // likely a typo in one of the two rows, and quietly writing 250g would be this importer
    // deciding which. The whole recipe is held back so nothing lands half-right.
    const seen = new Set()
    r.duplicateIngredient = null
    for (const l of r.matchedLines) {
      const key = l.type === 'item' ? `i:${l.item_id}` : `s:${l.sub_recipe_id}`
      if (seen.has(key)) { r.duplicateIngredient = l.ingName; break }
      seen.add(key)
    }
    // A code two items share holds the whole recipe back too (S792, MASTER-5), not just the line:
    // the sheet DID name an ingredient, so importing the dish without it would under-cost it with
    // nothing on the recipe to say a line was dropped.
    r.ambiguousIngredient = r.lines.find(l => l.ambiguous)?.ingName || null
    r.willImport = !r.duplicate && !r.isSub && !r.duplicateIngredient && !r.ambiguousIngredient && r.matchedLines.length > 0
  })
  return out
}
