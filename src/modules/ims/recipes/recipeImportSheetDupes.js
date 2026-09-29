// A dish named more than once in ONE Recipe Import sheet (S792, RECIPES-9). Pure, beside
// recipeImportParse.js, whose duplicate check is against the dishes already saved — so two
// "Chicken Momo" blocks in one sheet both passed it and both imported, as two dishes.
//
// Two copies that say exactly the same thing (category, price, yield and ingredient lines) are one
// dish typed twice — a sheet pasted together from two sources — and it is imported once. Copies
// that differ are held back, every one of them: which price or which ingredient list is right is
// the owner's call, not the importer's (the S714 rule for a duplicate ingredient line). The preview
// and the result both say which names were merged and which were skipped.

const lc = s => String(s ?? '').trim().toLowerCase()

/** What a parsed recipe says, in a form two copies of the same dish share. */
function recipeSignature(r) {
  const lines = (r.lines || [])
    .map(l => [lc(l.ingName), Number.isFinite(l.rawQty) ? l.rawQty : String(l.rawQty ?? ''), lc(l.unit)].join('|'))
    .sort()
  return JSON.stringify([lc(r.category), r.selling_price ?? null, r.yield_qty ?? null, !!r.isSub, lines])
}

/**
 * Marks repeated dish names within one parsed sheet (parseImportRows output), in place, and returns
 * the names by outcome.
 *   r.sheetDuplicate  null | 'merged' (a later identical copy — not imported, the first one is) |
 *                     'conflict' (copies that differ — none of them imported)
 *   r.sheetCopies     how many times the name appears in the sheet
 * A name already saved in Recipe Costing is left as "already exists"; that refusal comes first.
 * @param {object[]} parsed
 * @returns {{ merged: string[], skipped: string[] }}  dish names, as first typed in the sheet
 */
export function markSheetDuplicates(parsed) {
  const byName = new Map()
  for (const r of parsed || []) {
    r.sheetDuplicate = null
    r.sheetCopies = 1
    if (r.duplicate) continue
    const key = lc(r.name)
    if (!byName.has(key)) byName.set(key, [])
    byName.get(key).push(r)
  }
  const merged = [], skipped = []
  for (const copies of byName.values()) {
    if (copies.length < 2) continue
    copies.forEach(r => { r.sheetCopies = copies.length })
    const same = copies.every(r => recipeSignature(r) === recipeSignature(copies[0]))
    if (same) {
      copies.slice(1).forEach(r => { r.sheetDuplicate = 'merged'; r.willImport = false })
      merged.push(copies[0].name)
    } else {
      copies.forEach(r => { r.sheetDuplicate = 'conflict'; r.willImport = false })
      skipped.push(copies[0].name)
    }
  }
  return { merged, skipped }
}

/** The sentence the import's result carries for them — empty when the sheet named every dish once. */
export function sheetDuplicateNote({ merged = [], skipped = [] } = {}) {
  const q = names => names.map(n => `"${n}"`).join(', ')
  const parts = []
  if (merged.length) {
    parts.push(`${q(merged)} ${merged.length === 1 ? 'was' : 'were'} listed more than once with the same details and imported once.`)
  }
  if (skipped.length) {
    parts.push(`${q(skipped)} ${skipped.length === 1 ? 'was' : 'were'} listed more than once with different details and not imported — keep one block per dish in the sheet and import it again.`)
  }
  return parts.join(' ')
}
