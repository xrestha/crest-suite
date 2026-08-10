import { explodeRecipeTree, computeRecipeCosts } from '../../../utils/recipeCost'
import { selectDepletingSales } from '../sales/salesDepletion'
import { fetchAllRows } from '../../../shared/fetchAllRows'

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

export const EMPTY_USAGE = { rows: [], derivedItemValue: 0, salesRowsUsed: 0 }

// `scopedFrom` is the caller's useScopedDb binding — recipes/items are client-scoped, while
// sales_entries is period-scoped and stays on raw supabase.from() like everywhere else.
export async function loadSubRecipeUsage(supabase, scopedFrom, periodId) {
  if (!periodId) return EMPTY_USAGE

  // Paged: a period's sales_entries can exceed PostgREST's 1000-row cap, and a truncated read
  // here would understate every batch figure with no error to notice (see fetchAllRows.js).
  const { data: salesRows } = await fetchAllRows(() => supabase
    .from('sales_entries')
    .select('recipe_id, qty_sold, bs_day, source')
    .eq('period_id', periodId)
    .order('id'))

  const depleting = selectDepletingSales(salesRows || []).filter(r => r.recipe_id && Number(r.qty_sold) > 0)
  if (depleting.length === 0) return EMPTY_USAGE

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
    return { ...EMPTY_USAGE, derivedItemValue: await valueItems(supabase, itemAgg), salesRowsUsed: depleting.length }
  }

  const [{ data: recipeMeta }, batchCosts, derivedItemValue] = await Promise.all([
    scopedFrom('recipes', 'id, name, yield_qty, yield_uom').in('id', subIds),
    // Whole-BATCH cost — computeRecipeCosts does not divide by yield_qty (unlike
    // calcSubRecipeCostPerUnit in recipeCostCalc.js, which returns per-output-unit), so
    // multiplying by `batches` below is correct and needs no further division.
    computeRecipeCosts(supabase, subIds),
    valueItems(supabase, itemAgg),
  ])

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
    }
  }).sort((a, b) => b.value - a.value || b.qty - a.qty)

  return { rows, derivedItemValue, salesRowsUsed: depleting.length }
}

// Total cost value of the raw items this derivation implies — the comparison figure behind the
// reconciliation note, so a gap against the ledger's own Value Depleted is stated rather than
// left for someone to notice.
async function valueItems(supabase, itemAgg) {
  const itemIds = Object.keys(itemAgg)
  if (itemIds.length === 0) return 0
  const { data: items } = await supabase.from('items').select('id, per_uom_rate').in('id', itemIds)
  const rateMap = Object.fromEntries((items || []).map(i => [i.id, parseFloat(i.per_uom_rate) || 0]))
  return itemIds.reduce((s, id) => s + itemAgg[id] * (rateMap[id] || 0), 0)
}

// Narrows a usage row to one ledger source. qty/batches/value are all linear in qty, so the
// filtered figures are the full ones scaled by that source's share — no requery needed.
export function usageForSource(row, source) {
  if (source === 'all') return row
  const qty = row.bySource[source] || 0
  const share = row.qty > 0 ? qty / row.qty : 0
  return { ...row, qty, batches: row.batches * share, value: row.value * share }
}
