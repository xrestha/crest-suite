import { explodeRecipeTree, computeRecipeCosts, loadRecipeBook } from '../../../utils/recipeCost'
import { loadDeltaExplosion, deltaItems } from '../../../utils/orderLineIngredients'
import { selectDepletingSales } from '../sales/salesDepletion'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { throwFirstError } from '../../../shared/queryError'

// Sub-recipe consumption for one period, derived from sales_entries.
//
// It has to be derived rather than read: stock_movements stores only fully-exploded raw items
// (recipe_ingredients keeps a sub-recipe as sub_recipe_id with item_id NULL, so a sub-recipe can
// never be a leaf and never reaches the ledger), and the table has no column for the path a
// depletion took. So the same walk is repeated at read time, over the same sales rows the write
// path used — hence selectDepletingSales, shared with depleteManualSales rather than re-stated —
// and over the same choice stock lines a customized sale carries (`ingredient_deltas`, S758).
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
//
// The one exception is a third read, and only when it is needed: an item that a CHOICE takes but no
// recipe uses is not on the book (it holds only the items some recipe names), so its rate and
// yield are read on their own — see `withChoiceItems`.
export async function loadSubRecipeUsage(supabase, scopedFrom, periodId, { book } = {}) {
  if (!periodId) return EMPTY_USAGE

  const [salesRes, loadedBook] = await Promise.all([
    // Paged: a period's sales_entries can exceed PostgREST's 1000-row cap, and a truncated read
    // here would understate every batch figure with no error to notice (see fetchAllRows.js).
    // `ingredient_deltas` is a customized sale's choice stock lines per plate (S758); NULL on an
    // ordinary sale.
    fetchAllRows(() => supabase
      .from('sales_entries')
      .select('recipe_id, qty_sold, bs_day, source, ingredient_deltas')
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
  const subMaster = [...loadedBook.recipes.values()].filter(r => r.category === 'Sub-Recipe')
  const noneUsed = () => ({
    ...EMPTY_USAGE,
    totalSubRecipes: subMaster.length,
    unusedSubRecipes: subMaster.map(r => r.name).sort((a, b) => a.localeCompare(b)),
  })

  // Usage of a sales row is recipe × qty_sold + its choices' lines × qty_sold (S758) — the same
  // figure the ledger beside this tab wrote, signs included: a Credit Note's put-back row
  // (pos_credit_restock, negative qty_sold) takes its plates, choices and all, back off, and a
  // "Half" choice's negative line takes its share off the plate.
  const depleting = depletingRows(salesRows)
  if (depleting.length === 0) return noneUsed()

  // The book, plus any item only a choice takes (read here, the one extra round trip). A copy:
  // the page shares one book across every period it shows.
  const recipeBook = await withChoiceItems(scopedFrom, loadedBook, depleting)

  // Choice lines that name a sub-recipe ride the SAME walk as the dishes — one walk, from the book,
  // no request — so a sub-recipe reached through a choice is exploded exactly as one reached
  // through a recipe line. A line naming a sub-recipe the book does not hold is skipped and said
  // loudly, as the walk does for a recipe line (walkRecipeTree's `missing`).
  const deltaSubIds = new Set()
  depleting.forEach(r => deltasOf(r).forEach(d => { if (!d?.item_id && d?.sub_recipe_id) deltaSubIds.add(d.sub_recipe_id) }))
  const missingSubs = [...deltaSubIds].filter(id => !recipeBook.recipes.has(id))
  if (missingSubs.length > 0) {
    console.error(
      `subRecipeUsage: ${missingSubs.length} sub-recipe(s) named by a choice but not in the recipe book — ` +
      `their usage is missing from this tab. Ids: ${missingSubs.join(', ')}`
    )
  }
  const soldRecipeIds = [...new Set(depleting.map(r => r.recipe_id))]
  const walkIds = [...new Set([...soldRecipeIds, ...[...deltaSubIds].filter(id => recipeBook.recipes.has(id))])]
  const [tree, explosion] = await Promise.all([
    explodeRecipeTree(supabase, walkIds, { book: recipeBook }),
    // The raw items of every choice line, through the one conversion (orderLineIngredients.js):
    // item yield %, and a sub-recipe line exploded per output unit. From the book, so no request.
    loadDeltaExplosion(supabase, depleting.map(deltasOf), { book: recipeBook }),
  ])

  // Roll every row's per-plate sub-recipe usage up by its qty sold, split by source so the page's
  // source filter can narrow it without a second query. Each source keeps its own qty, batches and
  // topBatches rather than taking a share of the row's: topBatches is not proportional to qty
  // across sources (one source can reach a sub-recipe directly, another only nested), and a
  // put-back source is negative, so a row can net to nothing while its sources do not.
  const agg = {}
  const itemAgg = {}
  const add = (id, src, qty, batches, topBatches) => {
    const e = agg[id] || (agg[id] = { qty: 0, batches: 0, topBatches: 0, bySource: {} })
    const s = e.bySource[src] || (e.bySource[src] = { qty: 0, batches: 0, topBatches: 0 })
    e.qty += qty; s.qty += qty
    e.batches += batches; s.batches += batches
    // The non-double-counting half of the figure — see `topValue` below.
    e.topBatches += topBatches; s.topBatches += topBatches
  }
  const addItem = (itemId, qty) => { itemAgg[itemId] = (itemAgg[itemId] || 0) + qty }
  depleting.forEach(row => {
    const n = Number(row.qty_sold) || 0
    const src = ledgerSource(row.source)
    const node = tree[row.recipe_id]
    if (node) {
      node.subRecipes.forEach(x => add(x.sub_recipe_id, src, x.qty * n, x.batches * n, (x.topBatches || 0) * n))
      node.items.forEach(({ item_id, qty }) => addItem(item_id, qty * n))
    }
    // A choice line naming a sub-recipe is in that sub-recipe's own output units, already scaled
    // by the plate's size (S760), so it is scaled here exactly as walkRecipeTree scales a recipe
    // line: batches = units ÷ yield_qty (or 1). The plate reaches it DIRECTLY, so all of it is
    // topBatches, as at depth 0; what it nests is reached through it, so none of theirs is.
    deltasOf(row).forEach(d => {
      const q = Number(d?.qty) || 0
      if (!q || d.item_id || !d.sub_recipe_id) return
      const meta = recipeBook.recipes.get(d.sub_recipe_id)
      if (!meta) return
      const b = (q / (parseFloat(meta.yield_qty) || 1)) * n
      add(d.sub_recipe_id, src, q * n, b, b)
      ;(tree[d.sub_recipe_id]?.subRecipes || []).forEach(x => add(x.sub_recipe_id, src, x.qty * b, x.batches * b, 0))
    })
    deltaItems(deltasOf(row), explosion).forEach(({ item_id, qty }) => addItem(item_id, qty * n))
  })

  // One item map for both jobs: valuing the derived raw-item total (reconciliation) and naming each
  // sub-recipe's ingredients (search). Every item the walk can reach is on a book row, and every
  // item a choice takes is on the book or on the read `withChoiceItems` made.
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

// The period's rows that consume stock: the shared POS-supersedes-manual rule (selectDepletingSales,
// which keeps a Credit Note's put-back rows, negative), then the S835 rule buildUsageMap applies
// (stockReportCalc.js): a dish whose net sold in the period is 0 or less consumes nothing — neither
// its recipe nor its choices, which follow their dish. Without the second half, a month netted to
// zero by a credit note would still take its choices off the shelf.
function depletingRows(salesRows) {
  const rows = selectDepletingSales(salesRows || []).filter(r => r.recipe_id && Number(r.qty_sold))
  const net = {}
  rows.forEach(r => { net[r.recipe_id] = (net[r.recipe_id] || 0) + Number(r.qty_sold) })
  return rows.filter(r => net[r.recipe_id] > 0)
}

// A row's choice stock lines, or none. jsonb, so never trusted to be an array.
function deltasOf(row) {
  return Array.isArray(row?.ingredient_deltas) ? row.ingredient_deltas : []
}

// The book holds only items some recipe names (buildRecipeBook reads them off ingredient rows), so
// an item that only a CHOICE takes — extra cheese on a dish whose recipe has none — would value at
// rate 0 and yield 100%, and `derivedItemValue` (the reconciliation figure) would come out LOW. One
// chunked read for exactly those ids, and none at all when there are none. Returns a NEW book
// object: the caller's is shared across every period the page shows and must not be mutated.
async function withChoiceItems(scopedFrom, book, rows) {
  const missing = new Set()
  rows.forEach(r => deltasOf(r).forEach(d => { if (d?.item_id && !book.items.has(d.item_id)) missing.add(d.item_id) }))
  if (missing.size === 0) return book
  const res = await fetchAllRowsChunked([...missing], ids => scopedFrom('items', 'id, name, per_uom_rate, yield_pct')
    .in('id', ids)
    .order('id'))
  // Throws like the reads above: a failed read here would value those items at zero, silently.
  throwFirstError([res])
  const items = new Map(book.items)
  ;(res.data || []).forEach(({ id, ...item }) => items.set(id, item))
  return { ...book, items }
}

// id → { name, rate } for valuing and naming items, off the book's ingredient rows. This replaced a
// chunked `items` read (S714) that ran AFTER the walks, one more serial round trip. The rule it
// carried still holds, and the book is what keeps it: a missing rate is a zero, so
// `derivedItemValue` — the figure this tab reconciles the ledger against — comes out LOW, and a
// missing name drops the ingredient out of the find-an-ingredient search. Every item the walk can
// reach sits on a book row with its `items` embed, so nothing is missing that the old read had;
// an item only a choice takes is added by `withChoiceItems` before this runs.
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

// Narrows a usage row to one ledger source, from that source's own figures — no requery needed.
// They are carried per source rather than taken as a share of the row's qty: topBatches does not
// split by qty (one source can reach a sub-recipe directly and another only nested), and a put-back
// source is negative, so a row can net to zero while its sources do not. Both values are batches
// × the one whole-batch cost, as on the full row.
export function usageForSource(row, source) {
  if (source === 'all') return row
  const s = row.bySource[source] || { qty: 0, batches: 0, topBatches: 0 }
  const batchCost = row.batchCost || 0
  return {
    ...row,
    qty: s.qty,
    batches: s.batches,
    topBatches: s.topBatches,
    value: s.batches * batchCost,
    topValue: s.topBatches * batchCost,
  }
}
