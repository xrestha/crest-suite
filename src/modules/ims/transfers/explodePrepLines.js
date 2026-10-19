// Prep (momo filling, sauces) on a stock transfer goes as the raw ingredients it was made from
// (S849, PNL-8). Every COGS and variance figure costs prep at the raw-item level, so a transfer
// carries RAW items only: send_stock_transfer refuses a prep item outright ('prep').
//
// Pure. The quantities come from the ONE recipe walk (`explodeRecipeTree(…, { book })` in
// src/utils/recipeCost.js, recipes-and-subrecipes.md): the caller walks the prep's recipe once and
// passes the walk's output here. The walk gives the raw items for ONE batch of the sub-recipe (its
// ingredient rows are per batch, nested prep already recursed and yield_pct applied), so Q units of
// prep = Q ÷ yield_qty batches, and each raw line scales by that.
//
// Known limitation (said in Help): the receiver's Stock Count prep line (the mirror item) is not moved
// by a transfer; its raw ingredients are.

const num = v => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

/** "5 kg" / "2.5 pcs": a quantity for a label, at most 3 decimals, never exponent form. */
export function qtyLabel(qty, uom) {
  const n = num(qty)
  const s = n.toFixed(3).replace(/\.?0+$/, '')
  return uom ? `${s} ${uom}` : s
}

/** The label each raw line carries: "from 5 kg Momo filling". */
export function prepLabel(qty, prepItem) {
  return `from ${qtyLabel(qty, prepItem?.uom)} ${prepItem?.name || 'prep'}`.trim()
}

const PREP_PROBLEM_TEXT = {
  no_recipe: 'This prep item has no recipe linked to it, so it can\'t be sent as its ingredients. Open its sub-recipe in Recipes and save it once.',
  no_yield: 'This prep\'s recipe has no batch yield, so the ingredient quantities can\'t be worked out. Set the yield in Recipes first.',
  empty: 'This prep\'s recipe has no ingredients, so there is nothing to send.',
  qty: 'Enter a quantity above 0.',
}

/** Plain words for a prep explosion problem; null for none. */
export function prepProblemText(code) {
  if (!code) return null
  return PREP_PROBLEM_TEXT[code] || 'This prep item can\'t be sent as its ingredients.'
}

/**
 * One prep item at a quantity → its raw-ingredient lines.
 *
 * @param prepItem  { id, name, uom } — the mirror item the sender picked
 * @param qty       how much of the prep, in the prep item's own unit
 * @param recipe    the sub-recipe linked to it ({ id, yield_qty }), or null
 * @param walk      explodeRecipeTree output for [recipe.id] (recipe id → { items: [{ item_id, qty }] })
 * @returns { lines: [{ item_id, qty, prep_label }], problem: null | 'no_recipe' | 'no_yield' | 'empty' | 'qty' }
 */
export function explodePrep({ prepItem, qty, recipe, walk }) {
  const q = num(qty)
  if (!(q > 0)) return { lines: [], problem: 'qty' }
  if (!recipe) return { lines: [], problem: 'no_recipe' }
  const yieldQty = num(recipe.yield_qty)
  if (!(yieldQty > 0)) return { lines: [], problem: 'no_yield' }
  const perBatch = walk?.[recipe.id]?.items || []
  const batches = q / yieldQty
  const label = prepLabel(q, prepItem)
  const lines = perBatch
    .map(r => ({ item_id: r.item_id, qty: num(r.qty) * batches, prep_label: label }))
    .filter(l => l.item_id != null && l.qty > 0)
  if (lines.length === 0) return { lines: [], problem: 'empty' }
  return { lines, problem: null }
}

/**
 * Lines naming one item merge into one: quantities add, distinct prep labels join with "; " (the same
 * join send_stock_transfer applies, so the preview and the stored line read alike). A line with no
 * label (sent as itself) keeps its quantity and adds no label. Order: first appearance.
 */
export function mergeTransferLines(lines) {
  const byItem = new Map()
  for (const l of lines || []) {
    if (!l || l.item_id == null) continue
    const e = byItem.get(l.item_id)
    if (!e) {
      byItem.set(l.item_id, { item_id: l.item_id, qty: num(l.qty), labels: l.prep_label ? [l.prep_label] : [] })
    } else {
      e.qty += num(l.qty)
      if (l.prep_label && !e.labels.includes(l.prep_label)) e.labels.push(l.prep_label)
    }
  }
  return [...byItem.values()].map(e => ({
    item_id: e.item_id,
    qty: e.qty,
    prep_label: e.labels.length ? e.labels.join('; ') : null,
  }))
}

/**
 * The send form's picks → the raw lines the server is sent.
 *
 * @param picks          [{ item_id, qty }] in the order added (raw items and prep items)
 * @param itemsById      Map/object id → { id, name, uom, is_sub_recipe }
 * @param recipeByPrep   Map/object prep item id → its linked sub-recipe { id, yield_qty }
 * @param walk           explodeRecipeTree output covering every linked sub-recipe picked
 * @returns { lines, problems: [{ item_id, problem }] }
 */
export function explodePrepLines({ picks, itemsById, recipeByPrep, walk }) {
  const get = (m, k) => (m instanceof Map ? m.get(k) : m?.[k])
  const raw = []
  const problems = []
  for (const p of picks || []) {
    if (!p || p.item_id == null) continue
    const item = get(itemsById, p.item_id)
    if (item?.is_sub_recipe) {
      const r = explodePrep({ prepItem: item, qty: p.qty, recipe: get(recipeByPrep, p.item_id), walk })
      if (r.problem) problems.push({ item_id: p.item_id, problem: r.problem })
      raw.push(...r.lines)
    } else {
      raw.push({ item_id: p.item_id, qty: num(p.qty), prep_label: null })
    }
  }
  return { lines: mergeTransferLines(raw), problems }
}
