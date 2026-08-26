import { explodeRecipeTree, computeRecipeCosts } from '../../../utils/recipeCost'
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
  return 'manual' // manual, or a legacy NULL (see salesDepletion.js)
}

export const EMPTY_USAGE = {
  rows: [], derivedItemValue: 0, salesRowsUsed: 0,
  totalSubRecipes: 0, unusedSubRecipes: [], miscategorised: [],
}

// `scopedFrom` is the caller's useScopedDb binding — recipes/items are client-scoped, while
// sales_entries is period-scoped and stays on raw supabase.from() like everywhere else.
export async function loadSubRecipeUsage(supabase, scopedFrom, periodId) {
  if (!periodId) return EMPTY_USAGE

  // `allSubs` is the master list — every recipe categorised as a sub-recipe, unfiltered, exactly
  // as Recipes.js counts its own "N sub-recipes" header (Recipes.js:177). Fetched up front so the
  // unused-this-period diff is available on every return path below, including the ones that bail
  // out early: "nothing sold, so all of them are unused" is a legitimate answer, not a blank.
  const baseResults = await Promise.all([
    // Paged: a period's sales_entries can exceed PostgREST's 1000-row cap, and a truncated read
    // here would understate every batch figure with no error to notice (see fetchAllRows.js).
    fetchAllRows(() => supabase
      .from('sales_entries')
      .select('recipe_id, qty_sold, bs_day, source')
      .eq('period_id', periodId)
      .order('id')),
    scopedFrom('recipes', 'id, name').eq('category', 'Sub-Recipe'),
  ])
  // A failed read must not degrade to EMPTY_USAGE — "nothing consumed" is a real answer this
  // helper legitimately returns, so it must never also be the error shape (S612 silent-zero rule).
  throwFirstError(baseResults)
  const [{ data: salesRows }, { data: allSubs }] = baseResults

  const subMaster = allSubs || []
  const noneUsed = () => ({
    ...EMPTY_USAGE,
    totalSubRecipes: subMaster.length,
    unusedSubRecipes: subMaster.map(r => r.name).sort((a, b) => a.localeCompare(b)),
  })

  const depleting = selectDepletingSales(salesRows || []).filter(r => r.recipe_id && Number(r.qty_sold) > 0)
  if (depleting.length === 0) return noneUsed()

  const soldRecipeIds = [...new Set(depleting.map(r => r.recipe_id))]
  const tree = await explodeRecipeTree(supabase, soldRecipeIds)

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
    node.subRecipes.forEach(({ sub_recipe_id, qty, batches }) => {
      const e = agg[sub_recipe_id] || (agg[sub_recipe_id] = { qty: 0, batches: 0, bySource: {} })
      e.qty += qty * qtySold
      e.batches += batches * qtySold
      e.bySource[src] = (e.bySource[src] || 0) + qty * qtySold
    })
    node.items.forEach(({ item_id, qty }) => {
      itemAgg[item_id] = (itemAgg[item_id] || 0) + qty * qtySold
    })
  })

  const subIds = Object.keys(agg)
  if (subIds.length === 0) {
    // No sub-recipes, but the raw-item total still matters — it's the reconciliation figure.
    const itemMap = await fetchItemMap(supabase, Object.keys(itemAgg))
    const derived = Object.keys(itemAgg).reduce((s, id) => s + itemAgg[id] * (itemMap[id]?.rate || 0), 0)
    return { ...noneUsed(), derivedItemValue: derived, salesRowsUsed: depleting.length }
  }

  // subTree is each sub-recipe exploded on its own — whole-batch quantities of the raw items it
  // is made from. Needed for the "find ingredient" search on the page: a sub-recipe's own
  // ingredients are not otherwise knowable from `tree` above, which is keyed by the DISHES sold.
  const [recipeMetaRes, batchCosts, subTree] = await Promise.all([
    scopedFrom('recipes', 'id, name, yield_qty, yield_uom, category').in('id', subIds),
    // Whole-BATCH cost — computeRecipeCosts does not divide by yield_qty (unlike
    // calcSubRecipeCostPerUnit in recipeCostCalc.js, which returns per-output-unit), so
    // multiplying by `batches` below is correct and needs no further division.
    computeRecipeCosts(supabase, subIds),
    explodeRecipeTree(supabase, subIds),
  ])
  // Only the first element is a Supabase result; the other two are util outputs (S612).
  throwFirstError([recipeMetaRes])
  const { data: recipeMeta } = recipeMetaRes

  // One items fetch covering both jobs: valuing the derived raw-item total (reconciliation) and
  // naming each sub-recipe's ingredients (search). Two separate queries would fetch overlapping
  // id sets twice for no benefit.
  const subItemIds = Object.values(subTree).flatMap(n => n.items.map(i => i.item_id))
  const itemMap = await fetchItemMap(supabase, [...new Set([...Object.keys(itemAgg), ...subItemIds])])
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
      value: agg[id].batches * batchCost,
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

// id → { name, rate } for valuing and naming items in one round trip.
async function fetchItemMap(supabase, itemIds) {
  if (itemIds.length === 0) return {}
  const res = await supabase.from('items').select('id, name, per_uom_rate').in('id', itemIds)
  // A failed read here silently zeroed every valuation built from this map (S612 silent-zero rule).
  throwFirstError([res])
  return Object.fromEntries((res.data || []).map(i => [i.id, { name: i.name, rate: parseFloat(i.per_uom_rate) || 0 }]))
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
  return { ...row, qty, batches: row.batches * share, value: row.value * share }
}
