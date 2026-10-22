import { fetchAllRowsParallel, fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { settleWithin, withTimeout } from '../../../utils/withTimeout'
import { nepalCivilDate } from '../../../shared/nepalTime'
import { explodeRecipeIngredients } from '../../../utils/recipeCost'
import { loadDeltaExplosion, deltaItems, bookCoversDeltas } from '../../../utils/orderLineIngredients'
import { aggregateIngredientDemand, addDemand, usualSupplierByItem, averageChoicesPerPlate, periodsInLookback, LOOKBACK_DAYS } from '../../../utils/demandForecastMath'
import { buildStockRows } from './stockReportCalc'

// Demand Forecast's buying-list reads (S859), out of the page so a test can count them. Every
// dependency comes in as an argument (supabase, scopedFrom, the transfer reader, the shared month
// list), so this file never imports the Supabase client and a CRA test can load it.
//
// Why it is shaped this way (measured on Fast 3G, 563 ms a round trip): the list was a chain of 13
// serial levels, 14-24 s. The recipe walk fetched one sub-recipe level per round trip, the items it
// named came after it, the month list was read a second and a third time, the month's stock waited
// for the items because it was filtered by their ids, a second level-by-level walk followed for the
// month's sales, and the suppliers came last. Now:
//   - the recipe book is read once beside the forecast, and both walks run over it in memory;
//   - every read that does not take an earlier read's result for its OWN filter starts at once:
//     every item and every par at the start, the month's stock and six months of supplier lines as
//     soon as the shared month list lands. The id filters moved into memory;
//   - each month-spanning read asks for its pages together (fetchAllRowsParallel).
// Figures are unchanged. Each item's figures are built from that item's own rows, read in id order
// both before and after, so the extra rows of other items only fill maps nobody asks about.

// Each read below gets its own bound: a hung request becomes that read's error, so the list ends on
// its own notice instead of "Working out ingredients..." for good (the S857 rule, applied to all).
const READ_MS = 30000
const bounded = (promise, label) => settleWithin(promise, READ_MS, label)

const ITEM_COLUMNS = 'id, name, uom, per_uom_rate, is_active, purchase_unit, conversion_factor, categories(name)'
const SALES_COLUMNS = 'recipe_id, qty_sold, bs_day, source, ingredient_deltas'

// Who each item is usually bought from: the vendor on its latest purchase line over the last
// SUPPLIER_LOOKBACK months (S800). The page names the window in its own copy.
export const SUPPLIER_LOOKBACK = 6

// The open month, else the latest (the S722 rule; periodList.js' openOrLatest, which this file
// cannot import: periodList.js reads through the Supabase client).
const openOrLatest = periods => (periods || []).find(p => p.status === 'open') || (periods || [])[0] || null

// fetchAllRowsChunked's split (150 ids a URL), with each chunk's pages asked for together. Rows come
// back in the same order as fetchAllRowsChunked's (chunk order, then id), and the error of the
// lowest-numbered failing chunk wins, so the answer is the one it gave.
async function chunkedParallel(ids, makeQuery, chunkSize = 150) {
  const unique = [...new Set((ids || []).filter(id => id != null))]
  if (unique.length === 0) return { data: [], error: null }
  const chunks = []
  for (let i = 0; i < unique.length; i += chunkSize) chunks.push(unique.slice(i, i + chunkSize))
  const results = await Promise.all(chunks.map(chunk => fetchAllRowsParallel(opts => makeQuery(chunk, opts))))
  const failed = results.find(r => r.error)
  if (failed) return { data: null, error: failed.error }
  return { data: results.flatMap(r => r.data || []), error: null }
}

/**
 * Starts every buying-list read that does not wait on the forecast, beside the forecast read itself.
 *
 *   periodsP      the shared month list (`usePeriodList().fresh`, bounded): `{ data, error }`, newest first
 *   bookP         the recipe book (`loadRecipeBook`), settled into `{ data, error }`
 *   readTransfers transferFlows' `readPeriodTransfers` (injected: that file imports the client)
 *
 * Never rejects: every promise here settles into `{ data, error }` or `{ error }`, so a forecast with
 * nothing to buy for can leave them unread without an unhandled rejection.
 */
export function startBuyingListReads({ supabase, scopedFrom, periodsP, bookP, readTransfers }) {
  // Every item and every par, not only the forecast's: their ids are known only after the walk, and
  // a filter on them is what made these reads wait for it. The rows are narrowed in memory.
  const items = bounded(fetchAllRowsParallel(opts => scopedFrom('items', ITEM_COLUMNS, opts).order('id')), 'Loading the items')
  // Safety stock (S800): one row per item per client.
  const pars = bounded(fetchAllRows(() => scopedFrom('par_levels', 'id, item_id, par_qty').order('id')), 'Reading what is in store')

  // In store (S756, D21): the month's whole stock, for the open month or else the latest. Sales were
  // always whole-month (usage of an item can come from any dish sold); the per-item tables are now
  // too, which is what lets them start before the walk has named the items.
  const stockMonth = periodsP.then(({ data: periods, error }) => {
    if (error) return { error }
    const period = openOrLatest(periods)
    if (!period) return { periods: periods || [], period: null }
    const month = (table, cols, scoped = false) => bounded(fetchAllRowsParallel(opts =>
      (scoped ? scopedFrom(table, cols, opts) : supabase.from(table).select(cols, opts))
        .eq('period_id', period.id).order('id')), 'Reading what is in store')
    return Promise.all([
      month('opening_stock', 'item_id, qty'),
      month('closing_stock', 'item_id, physical_qty'),
      month('purchase_entries', 'item_id, qty'),
      month('vendor_returns', 'item_id, qty', true),
      month('wastages', 'item_id, qty'),
      month('staff_meals', 'item_id, qty'),
      // bs_day + source feed the POS-supersedes-manual rule inside buildStockRows; ingredient_deltas
      // because a customized plate also consumes its options' stock lines (S758).
      month('sales_entries', SALES_COLUMNS),
      // Stock transfers between outlets (S849, PNL-8) move the shelf like a purchase and a return, the
      // same as on Stock Report. A failed read is a failed shelf read, never "no transfers".
      bounded(readTransfers(scopedFrom, period.id, { select: 'id, item_id, qty, direction' }), 'Reading what is in store'),
    ]).then(results => ({ periods, period, results }))
  }).catch(error => ({ error }))

  // Usual suppliers (S800): purchase_entries is period-scoped, so it is read through the client's own
  // month ids, every item's lines (narrowed in memory, like the stock above).
  const suppliers = periodsP.then(({ data: periods, error }) => {
    if (error) return { error }
    const ordinal = p => p.bs_year * 100 + p.bs_month
    const recent = [...(periods || [])].sort((a, b) => ordinal(b) - ordinal(a)).slice(0, SUPPLIER_LOOKBACK)
    if (recent.length === 0) return { recent }
    return Promise.all([
      bounded(fetchAllRowsParallel(opts => supabase.from('purchase_entries')
        .select('id, item_id, vendor_id, period_id, bs_day, created_at', opts)
        .in('period_id', recent.map(p => p.id)).not('vendor_id', 'is', null).order('id')), 'Reading the usual suppliers'),
      bounded(fetchAllRows(() => scopedFrom('vendors', 'id, name, is_active').order('id')), 'Reading the usual suppliers'),
    ]).then(([lines, vendors]) => ({ recent, rankById: Object.fromEntries(recent.map(p => [p.id, ordinal(p)])), lines, vendors }))
  }).catch(error => ({ error }))

  return { periods: periodsP, book: bookP, items, pars, stockMonth, suppliers }
}

// The run's own 12-week window (S849): the Nepal date the shown run was made on, and 84 days back.
// The forecast's history ended the day before the run, so the guests' choices and the Bulk-row
// count below are read over the same days the forecast learned from, not over today's window.
function runWindow(runAt) {
  const to = runAt ? nepalCivilDate(runAt) : null
  if (!to) return null
  const from = new Date(to)
  from.setDate(to.getDate() - LOOKBACK_DAYS)
  return { from, to }
}

// The guests' usual choices on each forecast dish, per plate, as raw items (S849, FORECAST-3,
// owner decision SU13 a). Learned from the till's posted sales over the run's own window
// (averageChoicesPerPlate), then run through the ONE conversion stock uses (loadDeltaExplosion +
// deltaItems), so the result has the recipe explosion's shape: { recipeId: [{ item_id, qty }] },
// signed. A positive `.in` on `source` is deliberate: a NULL-source row is hand-entered and carries
// no choices. Throws on any failed read; the caller shows its own notice and keeps the recipe half.
// The explosion takes the recipe book only when the book holds every item and sub-recipe the
// choices name (bookCoversDeltas, S859): a choice may name an item no recipe uses, whose yield only
// a read can give.
export async function loadUsualChoices(supabase, periodsP, recipeIds, runAt, bookP) {
  const win = runWindow(runAt)
  if (!win || recipeIds.length === 0) return {}
  const { data: periods, error: pErr } = await periodsP
  if (pErr) throw pErr
  const windowPeriods = periodsInLookback(periods, win.from, win.to)
  if (windowPeriods.length === 0) return {}
  const periodIds = windowPeriods.map(p => p.id)
  // Twelve weeks of till rows, so several pages: asked for together.
  const { data: rows, error } = await chunkedParallel(recipeIds, (ids, opts) => supabase.from('sales_entries')
    .select('period_id, recipe_id, bs_day, qty_sold, source, ingredient_deltas', opts)
    .in('period_id', periodIds).in('recipe_id', ids).in('source', ['pos', 'pos_comp']).order('id'))
  if (error) throw error
  const avg = averageChoicesPerPlate(rows, { periodsById: Object.fromEntries(windowPeriods.map(p => [p.id, p])), ...win })
  const lists = Object.values(avg)
  if (lists.length === 0) return {}
  const { data: book } = await bookP
  const explosion = await loadDeltaExplosion(supabase, lists, bookCoversDeltas(book, lists) ? { book } : {})
  return Object.fromEntries(Object.entries(avg).map(([recipeId, lines]) => [recipeId, deltaItems(lines, explosion)]))
}

// How many Bulk monthly Sales Entries (bs_day 0) fall in the run's window (S849, FORECAST-10c). A
// weekday with no samples on an outlet that enters sales as monthly totals is not "no sales" — the
// sales are there, with no day on them. The run's own count is not stored, so this one head count
// stands in for it, and only when some shown day has no samples.
export async function countUndatedRows(supabase, periodsP, runAt) {
  const win = runWindow(runAt)
  if (!win) return null
  const { data: periods, error: pErr } = await periodsP
  if (pErr) throw pErr
  const ids = periodsInLookback(periods, win.from, win.to).map(p => p.id)
  if (ids.length === 0) return 0
  const { count, error } = await supabase.from('sales_entries').select('id', { count: 'exact', head: true })
    .in('period_id', ids).eq('bs_day', 0).or('source.is.null,source.eq.manual')
  if (error) throw error
  return count || 0
}

// What stands behind "In store": the one on-hand calculation (buildStockRows, S696), for the open
// period or else the latest — never a local copy of opening + purchases − usage (S756, D21).
// Throws on any failed read; the caller turns that into its own notice rather than an empty shelf.
// Returns `{ onHandById: null, period: null }` when the client has no period at all.
async function onHandFor(supabase, reads, items, book) {
  const month = await reads.stockMonth
  if (month.error) throw month.error
  const { periods, period } = month
  if (!period) return { onHandById: null, period: null, parById: null, periods }
  if (items.length === 0) return { onHandById: {}, period, parById: {}, periods }
  const [openingRes, closingRes, purchasesRes, returnsRes, wastagesRes, staffRes, salesRes, transfersRes] = month.results
  // The order the batch has always been checked in, so the same failure names the notice.
  const results = [openingRes, closingRes, purchasesRes, returnsRes, wastagesRes, staffRes, salesRes, await reads.pars, transfersRes]
  const failed = firstError(results)
  if (failed) throw failed
  const [{ data: opening }, { data: closing }, { data: purchases }, { data: returns }, { data: wastages }, { data: staffMeals }, { data: sales }, { data: pars }, { data: transfers }] = results
  const soldIds = [...new Set((sales || []).map(s => s.recipe_id).filter(Boolean))]
  const deltaLists = (sales || []).map(s => s.ingredient_deltas)
  // Both walks throw on a failed read, which the caller already turns into its own notice (S758).
  // The recipe walk runs over the book; the options' stock lines take it only where it covers them.
  const [breakdown, explosion] = await Promise.all([
    soldIds.length > 0 ? explodeRecipeIngredients(supabase, soldIds, { book }) : {},
    loadDeltaExplosion(supabase, deltaLists, bookCoversDeltas(book, deltaLists) ? { book } : {}),
  ])
  // Every other item's rows fill the maps inside and are never asked for: the rows map over `items`.
  const rows = buildStockRows({ items, opening, closing, purchases, returns, wastages, staffMeals, sales, breakdown, explosion, transfers })
  const ids = new Set(items.map(i => i.id))
  return {
    onHandById: Object.fromEntries(rows.map(r => [r.item.id, r.onHand])),
    period,
    periods,
    countedIds: new Set(rows.filter(r => r.stockSource === 'closing').map(r => r.item.id)),
    parById: Object.fromEntries((pars || []).filter(p => ids.has(p.item_id)).map(p => [p.item_id, Number(p.par_qty) || 0])),
  }
}

// Who each item is usually bought from (S800). Throws on a failed read; the caller shows the list
// ungrouped and says why.
async function suppliersFor(suppliersP, items) {
  const s = await suppliersP
  if (s.error) throw s.error
  if (s.recent.length === 0 || items.length === 0) return { byItem: {}, names: {} }
  const failed = firstError([s.lines, s.vendors])
  if (failed) throw failed
  const ids = new Set(items.map(i => i.id))
  return {
    byItem: Object.fromEntries(Object.entries(usualSupplierByItem(s.lines.data, s.rankById)).filter(([id]) => ids.has(id))),
    names: Object.fromEntries((s.vendors.data || []).map(v => [v.id, v.name])),
    active: new Set((s.vendors.data || []).filter(v => v.is_active !== false).map(v => v.id)),
  }
}

/**
 * The buying list's pieces for the forecast dishes (`totals` by recipe, `recipeIds` those above 0),
 * from reads `startBuyingListReads` started. Resolves the page's `ingredients` fields.
 *
 * THROWS when the list itself cannot be built: a failed recipe book (S695: an empty walk would read
 * as "nothing to buy", the silent zero) or a failed item read. The other three halves fail into
 * their own slots and leave the list standing: `choiceError`, `stockError` (In store unknown, never
 * an empty shelf) and `supplierError` (one ungrouped table).
 */
export async function loadBuyingList({ supabase, reads, totals, recipeIds, runAt, customization }) {
  // The same walk the Reorder Report uses for theoretical usage: leaf items only, sub-recipes
  // resolved through their yield, item yield_pct applied, over the book in memory. Beside it, the
  // guests' usual choices (Customization outlets only: elsewhere no sale carries any), which fail
  // on their own.
  const [exploded, choiceRes] = await Promise.all([
    reads.book.then(({ data: book, error }) => {
      if (error) throw error
      return explodeRecipeIngredients(supabase, recipeIds, { book })
    }),
    customization
      ? withTimeout(loadUsualChoices(supabase, reads.periods, recipeIds, runAt, reads.book), 30000, 'Reading the usual guest choices')
        .then(choicePerPlate => ({ choicePerPlate }), choiceError => ({ choiceError }))
      : Promise.resolve({ choicePerPlate: {} }),
  ])
  const { data: book } = await reads.book
  const choicePerPlate = choiceRes.choicePerPlate || {}
  const choiceError = choiceRes.choiceError || null
  // Items reached only through a choice are loaded like any other: names, rates, in store, suppliers.
  const itemIds = Object.keys(addDemand(aggregateIngredientDemand(totals, exploded), aggregateIngredientDemand(totals, choicePerPlate)))
  let items = []
  if (itemIds.length > 0) {
    const { data, error } = await reads.items
    if (error) throw error
    const wanted = new Set(itemIds)
    items = (data || []).filter(i => wanted.has(i.id))
  }

  // In store (S756, D21). Its own try: a failed stock read must not take forecast use with it,
  // and must not read as an empty shelf either — ingredientBuyList carries it as unknown.
  let stock = { onHandById: null, period: null, periods: [], countedIds: new Set(), parById: null }
  let stockError = null
  try {
    stock = await onHandFor(supabase, reads, items, book)
  } catch (err) {
    stockError = err
  }
  // Usual suppliers (S800), likewise on their own: without them the list is one ungrouped table.
  let suppliers = null
  let supplierError = null
  try {
    suppliers = await suppliersFor(reads.suppliers, items)
  } catch (err) {
    supplierError = err
  }
  return { exploded, choicePerPlate, choiceError, items, stock, stockError, suppliers, supplierError }
}
