import { explodeRecipeTree, computeRecipeCosts, loadRecipeBook } from '../../../utils/recipeCost'
import { selectDepletingSales } from '../sales/salesDepletion'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { throwFirstError } from '../../../shared/queryError'

// Sub-recipe consumption for one period, derived from sales_entries.
//
// It has to be derived rather than read: stock_movements stores only fully-exploded raw items
// (recipe_ingredients keeps a sub-recipe as sub_recipe_id with item_id NULL, so a sub-recipe can
// never be a leaf and never reaches the ledger), and the table has no column for the path a
// depletion took. So the same walk is repeated at read time, over the same sales rows the write
// path used — hence selectDepletingSales, shared with depleteManualSales rather than re-stated.
//
// Deliberately NOT written into stock_movements: a sub-recipe's mirror item (items.is_sub_recipe)
// carries its own per_uom_rate, so extra ledger rows would double-count Stock Movements' own
// "Value Depleted" KPI against the raw-item rows already there.

// sales_entries sources → the ledger's own source vocabulary, so the page's existing filter
// dropdown works over both tabs without a second set of labels.
function ledgerSource(source) {
  if (source === 'pos') return 'pos_sale'
  if (source === 'pos_comp') return 'pos_comp'
  // S809 2e: a credit note's "not served" reversal, negative — its own bucket, never Manual Entry's.
  if (source === 'pos_credit_restock') return 'pos_credit_restock'
  return 'manual' // manual, or a legacy NULL (see salesDepletion.js)
}

export const EMPTY_USAGE = {
  rows: [], derivedItemValue: 0, salesRowsUsed: 0,
  totalSubRecipes: 0, unusedSubRecipes: [], miscategorised: [],
}

// `scopedFrom` is the caller's useScopedDb binding — recipes/items are client-scoped, while
// sales_entries is period-scoped and stays on raw supabase.from() like everywhere else.
//
// Every recipe fact comes from ONE pre-loaded recipe book (S793, `loadRecipeBook`), so the whole
// derivation is two parallel requests — the period's sales and the book — however deep the prep
// nests. It used to be three walks in a row, each one round trip per nesting level, plus a names
// read after them: ~9 serial round trips, 12.5s of Stock Movements on a Fast-3G profile.
// `opts.book` lets a page share a book (or its promise) it already loaded; without one this loads
// its own. The book is period-independent, so a page keeps one across period changes.
export async function loadSubRecipeUsage(supabase, scopedFrom, periodId, { book } = {}) {
  if (!periodId) return EMPTY_USAGE

  const [salesRes, recipeBook] = await Promise.all([
    // Paged: a period's sales_entries can exceed PostgREST's 1000-row cap, and a truncated read
    // here would understate every batch figure with no error to notice (see fetchAllRows.js).
    fetchAllRows(() => supabase
      .from('sales_entries')
      .select('recipe_id, qty_sold, bs_day, source')
      .eq('period_id', periodId)
      .order('id')),
    // Throws on a failed read, like the walk it feeds.
    book || loadRecipeBook(scopedFrom),
  ])
  // A failed read must not degrade to EMPTY_USAGE — "nothing consumed" is a real answer this
  // helper legitimately returns, so it must never also be the error shape (S612 silent-zero rule).
  throwFirstError([salesRes])
  const { data: salesRows } = salesRes

  // `subMaster` is the master list — every recipe categorised as a sub-recipe, unfiltered, exactly
  // as Recipes.js counts its own "N sub-recipes" header. Built up front so the unused-this-period
  // diff is available on every return path below, including the ones that bail out early:
  // "nothing sold, so all of them are unused" is a legitimate answer, not a blank.
  const subMaster = [...recipeBook.recipes.values()].filter(r => r.category === 'Sub-Recipe')
  const noneUsed = () => ({
    ...EMPTY_USAGE,
    totalSubRecipes: subMaster.length,
    unusedSubRecipes: subMaster.map(r => r.name).sort((a, b) => a.localeCompare(b)),
  })

  // Recipes only (S758, release 1): a customized sale's option stock lines
  // (sales_entries.ingredient_deltas) that name a sub-recipe are NOT walked here, and the tab says so.
  // Their raw items still reach the Raw Items tab through stock_movements.
  const depleting = selectDepletingSales(salesRows || []).filter(r => r.recipe_id && Number(r.qty_sold) > 0)
  if (depleting.length === 0) return noneUsed()

  const soldRecipeIds = [...new Set(depleting.map(r => r.recipe_id))]
  const tree = await explodeRecipeTree(supabase, soldRecipeIds, { book: recipeBook })

  // Roll every sold dish's per-portion sub-recipe usage up by qty sold, split by source so the
  // page's source filter can narrow it without a second query (qty, batches and value are all
  // linear in qty, so a filtered view is just a rescale of these totals).
  const agg = {}
  const itemAgg = {}
  depleting.forEach(row => {
    const qtySold = Number(row.qty_sold) || 0
    const node = tree[row.recipe_id]
    if (!node) return
    const src = ledgerSource(row.source)
    node.subRecipes.forEach(({ sub_recipe_id, qty, batches, topBatches }) => {
      const e = agg[sub_recipe_id] || (agg[sub_recipe_id] = { qty: 0, batches: 0, topBatches: 0, bySource: {} })
      e.qty += qty * qtySold
      e.batches += batches * qtySold
      // The non-double-counting half of the figure — see `topValue` below.
      e.topBatches += (topBatches || 0) * qtySold
      e.bySource[src] = (e.bySource[src] || 0) + qty * qtySold
    })
    node.items.forEach(({ item_id, qty }) => {
      itemAgg[item_id] = (itemAgg[item_id] || 0) + qty * qtySold
    })
  })

  // One item map for both jobs: valuing the derived raw-item total (reconciliation) and naming each
  // sub-recipe's ingredients (search). Every item the walk can reach is on a book row.
  const itemMap = itemMapOf(recipeBook)

  const subIds = Object.keys(agg)
  if (subIds.length === 0) {
    // No sub-recipes, but the raw-item total still matters — it's the reconciliation figure.
    const derived = Object.keys(itemAgg).reduce((s, id) => s + itemAgg[id] * (itemMap[id]?.rate || 0), 0)
    return { ...noneUsed(), derivedItemValue: derived, salesRowsUsed: depleting.length }
  }

  // subTree is each sub-recipe exploded on its own — whole-batch quantities of the raw items it
  // is made from. Needed for the "find ingredient" search on the page: a sub-recipe's own
  // ingredients are not otherwise knowable from `tree` above, which is keyed by the DISHES sold.
  const [batchCosts, subTree] = await Promise.all([
    // Whole-BATCH cost — computeRecipeCosts does not divide by yield_qty (unlike
    // calcSubRecipeCostPerUnit in recipeCostCalc.js, which returns per-output-unit), so
    // multiplying by `batches` below is correct and needs no further division.
    computeRecipeCosts(supabase, subIds, { book: recipeBook }),
    explodeRecipeTree(supabase, subIds, { book: recipeBook }),
  ])
  const recipeMeta = subIds.map(id => recipeBook.recipes.get(id)).filter(Boolean)

  const derivedItemValue = Object.keys(itemAgg)
    .reduce((s, id) => s + itemAgg[id] * (itemMap[id]?.rate || 0), 0)

  const metaMap = Object.fromEntries((recipeMeta || []).map(r => [r.id, r]))
  const rows = subIds.map(id => {
    const meta = metaMap[id] || {}
    const batchCost = batchCosts[id] || 0
    return {
      id,
      name: meta.name || 'Unknown sub-recipe',
      yieldQty: parseFloat(meta.yield_qty) || 0,
      yieldUom: meta.yield_uom || 'unit',
      qty: agg[id].qty,
      batches: agg[id].batches,
      // `value` is what it cost to make every batch of THIS sub-recipe that the period consumed,
      // and it is correct per row — but the rows are NOT ADDITIVE, because batchCost is fully
      // exploded (the tooltip on the Cost / Batch column says so: "nested sub-recipes included").
      // Summing it double-counted a nested prep item: on the repo's own nested fixture, House
      // Sauce 0.25 × 80 plus Herb Base 0.05 × 400 totalled NPR 40 against a true raw-ingredient
      // value of NPR 20 — exactly 2× — while the KPI card's tooltip called the figure "a slice of
      // the raw-item value on the Raw Items tab" (S721).
      value: agg[id].batches * batchCost,
      // `topValue` is the part of that cost the dish reaches DIRECTLY, so summing it across rows
      // counts each raw ingredient once. This is the figure every TOTAL on the page uses.
      topValue: agg[id].topBatches * batchCost,
      topBatches: agg[id].topBatches,
      batchCost,
      bySource: agg[id].bySource,
      // Fully exploded, so a nested sub-recipe's own raw ingredients are searchable from the
      // parent too — matching Recipes.js's ingredient search, which also sees through nesting.
      ingredients: (subTree[id]?.items || [])
        .map(i => itemMap[i.item_id]?.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    }
  }).sort((a, b) => b.value - a.value || b.qty - a.qty)

  // The diff behind Recipe Costing showing (say) 57 sub-recipes while this tab shows 48: that page
  // counts the master list, this one counts what a period's sales actually consumed. The
  // difference is prep items nothing sold touched — a useful figure in its own right, not a
  // discrepancy, so it is named here rather than left to a manual cross-check of two pages.
  const usedIds = new Set(subIds)
  const unusedSubRecipes = subMaster
    .filter(r => !usedIds.has(r.id))
    .map(r => r.name)
    .sort((a, b) => a.localeCompare(b))

  // The one case where the two counts genuinely cannot reconcile: a recipe used as an ingredient
  // via sub_recipe_id whose own category was never set to 'Sub-Recipe'. It is counted here (it is
  // reached by the walk) but not by Recipe Costing's category-based count, so "used + unused"
  // would exceed the master total. That is a data-entry problem on the recipe, worth naming.
  const miscategorised = (recipeMeta || [])
    .filter(r => r.category !== 'Sub-Recipe')
    .map(r => r.name)
    .sort((a, b) => a.localeCompare(b))

  return {
    rows,
    derivedItemValue,
    salesRowsUsed: depleting.length,
    totalSubRecipes: subMaster.length,
    unusedSubRecipes,
    miscategorised,
  }
}

// id → { name, rate } for valuing and naming items, off the book's ingredient rows. This replaced a
// chunked `items` read (S714) that ran AFTER the walks, one more serial round trip. The rule it
// carried still holds, and the book is what keeps it: a missing rate is a zero, so
// `derivedItemValue` — the figure this tab reconciles the ledger against — comes out LOW, and a
// missing name drops the ingredient out of the find-an-ingredient search. Every item the walk can
// reach sits on a book row with its `items` embed, so nothing is missing that the old read had.
function itemMapOf(book) {
  const map = {}
  book.items.forEach((item, id) => { map[id] = { name: item.name, rate: parseFloat(item.per_uom_rate) || 0 } })
  return map
}

// True if any of this sub-recipe's raw ingredients matches the (already lowercased) query —
// the Sub-Recipes tab's equivalent of Recipes.js's recipeHasIngredient().
export function subRecipeHasIngredient(row, q) {
  if (!q) return true
  return (row.ingredients || []).some(n => n.toLowerCase().includes(q))
}

// Narrows a usage row to one ledger source. qty/batches/value are all linear in qty, so the
// filtered figures are the full ones scaled by that source's share — no requery needed.
export function usageForSource(row, source) {
  if (source === 'all') return row
  const qty = row.bySource[source] || 0
  const share = row.qty > 0 ? qty / row.qty : 0
  // topValue rescales by the same share: qty, batches and both values are all linear in qty.
  return {
    ...row, qty,
    batches: row.batches * share,
    topBatches: (row.topBatches || 0) * share,
    value: row.value * share,
    topValue: (row.topValue || 0) * share,
  }
}
