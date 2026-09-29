import { fetchAllRows } from '../../../shared/fetchAllRows'

/**
 * Every table with a foreign key to `items.id`, in an order that is SAFE TO DELETE IN — children
 * first, so `vendor_returns` (which references `purchase_entries` as well as `items`) precedes it.
 *
 * ONE list, in its own file, because it answers two questions that must never diverge: which
 * references the "Used In" badge and the delete guard look for, and which ones force-delete has to
 * clear. They HAD diverged. The badge checked eight tables and force-delete cleared the same
 * eight, while `par_levels`, `purchase_order_items` and `stock_movements` reference items too —
 * all three with plain FKs, so Postgres refused the final delete AFTER the other eight tables had
 * been emptied, and the failure message told the operator to try again, which could never work.
 *
 * `cascades` is the other half of that lesson, and the reason the delete guard may never fall
 * open. A foreign key is a guard on some of these tables and not others (the `confdeltype` rule in
 * CLAUDE.md, learned on `vendors`): `requisition_lines`, `staff_meals` and `vendor_returns` are
 * ON DELETE CASCADE, so a delete the badge failed to warn about is not refused — it succeeds, and
 * silently takes those records with it. Five of eleven would have been refused; three would have
 * destroyed history in the name of "nothing references this item".
 *
 * The badge and the guard count the SAME rows — any row at all, whatever its quantity. They used to
 * differ: a `qtyCol` per table made the badge skip zero-quantity rows while the guard counted them,
 * so an item could show "—" in Used In and still be refused a delete (S766, found live on a Closing
 * Stock count of 0 — which S695 made a real row on purpose). The column's own tooltip says an item
 * with any of these can't be deleted, so a badge that knows fewer rows than the guard is a badge
 * that contradicts the button beside it. `staff_meals.qty` defaulting to 0 was the earlier instance.
 *
 * `itemRefTables.test.js` reads the migrations and fails if this list stops matching the schema —
 * adding a table with an `item_id` FK has to reach here, and nothing else would say so.
 */
export const ITEM_REF_TABLES = [
  { table: 'vendor_returns',       label: 'VR',  name: 'Vendor Returns',    cascades: true  },
  { table: 'recipe_ingredients',   label: 'R',   name: 'Recipes',           cascades: false },
  // Crest Customization (S758): an option's stock line ("Extra cheese adds 30 GM"). Plain FK: a
  // delete is refused, never cascaded.
  { table: 'pos_option_ingredients', label: 'OPT', name: 'Customization Options', cascades: false },
  { table: 'requisition_lines',    label: 'RQ',  name: 'Requisitions',      cascades: true  },
  { table: 'staff_meals',          label: 'SM',  name: 'Staff Meals',       cascades: true  },
  { table: 'wastages',             label: 'W',   name: 'Wastage',           cascades: false },
  { table: 'opening_stock',        label: 'OS',  name: 'Opening Stock',     cascades: false },
  { table: 'closing_stock',        label: 'CS',  name: 'Closing Stock',     cascades: false },
  { table: 'par_levels',           label: 'PAR', name: 'Par Levels',        cascades: false },
  { table: 'purchase_order_items', label: 'PO',  name: 'Purchase Orders',   cascades: false },
  { table: 'stock_movements',      label: 'MV',  name: 'Stock Movements',   cascades: false },
  { table: 'purchase_entries',     label: 'P',   name: 'Purchases',         cascades: false },
]

/** Badge code → the name a reader sees ("SM" → "Staff Meals"). */
export const USAGE_LABELS = Object.fromEntries(ITEM_REF_TABLES.map(t => [t.label, t.name]))

/**
 * What force-delete actually clears, as prose, derived from the list rather than typed out again.
 * The dialog said "purchases, stock counts, wastage, staff meals, requisitions, vendor returns and
 * recipe lines" while the loop beneath it had drifted to a different set.
 */
export const REF_TABLE_PROSE = ITEM_REF_TABLES.map(t => t.name.toLowerCase()).join(', ')

const LABEL_OF_TABLE = Object.fromEntries(ITEM_REF_TABLES.map(t => [t.table, t.label]))

/**
 * `item_reference_counts` rows → `{ [itemId]: { P: 40, CS: 3 } }`, keyed by badge code.
 *
 * A table the function reports and this list does not know keeps its own name as the code rather
 * than being dropped: the map feeds the delete guard, and a reference the page cannot name still
 * blocks a delete. `itemRefTables.test.js` holds the SQL list and this one together, so that
 * fallback should never be what a reader sees.
 */
export function refCountsFromRows(rows) {
  const counts = {}
  ;(rows || []).forEach(r => {
    const n = Number(r.ref_count) || 0
    if (!r.ref_item_id || n <= 0) return
    const code = LABEL_OF_TABLE[r.ref_table] || r.ref_table
    if (!counts[r.ref_item_id]) counts[r.ref_item_id] = {}
    counts[r.ref_item_id][code] = (counts[r.ref_item_id][code] || 0) + n
  })
  return counts
}

/**
 * Per-item counts → the badge codes each item has, in ITEM_REF_TABLES order (the order the Used In
 * chip has always listed them in), any unknown code after — `{ [itemId]: ['CS', 'P'] }`.
 */
export function refCodesFromCounts(counts) {
  const order = ITEM_REF_TABLES.map(t => t.label)
  const out = {}
  Object.entries(counts || {}).forEach(([id, byCode]) => {
    const known = order.filter(code => (byCode[code] || 0) > 0)
    const unknown = Object.keys(byCode).filter(code => !order.includes(code) && byCode[code] > 0)
    if (known.length + unknown.length > 0) out[id] = [...known, ...unknown]
  })
  return out
}

/**
 * How many rows reference each item, per table, in ONE server call: `item_reference_counts(p_ids)`
 * (20260919120000), the same function the BEFORE DELETE trigger asks. Resolves
 * `{ data: { [itemId]: { [code]: n } }, error }` and never throws; `data` is null on a failure.
 *
 * S792 (MASTER-8): Item Master used to download every referencing row of the client's whole
 * history on each visit (every purchase line, every stock movement) to count them in the browser,
 * paging 1000 rows at a time, and `fetchAllRows` then stopped at 100,000 rows without an error. The
 * function counts server-side and returns at most one row per item per table. Its item list rides
 * in the POST body, not the URL, so it needs no chunking; it is still paged, because a set-returning
 * RPC is capped at 1000 rows like any read, and 254 items × 12 tables can reach that. The order is
 * (item, table), which the function's GROUP BY makes unique.
 *
 * It is SECURITY DEFINER and counts rows the caller's own policies may hide, which is the right
 * answer for a guard that must not promise an item is unreferenced. `client` is passed in rather
 * than imported so this file stays importable by its schema test with no Supabase client.
 *
 * S792: shared by Item Master's usage scan and Price Tracker's price confirm, so both name the same
 * past records a price change re-values.
 */
export async function readItemRefCounts(client, ids) {
  const unique = [...new Set((ids || []).filter(Boolean))]
  if (unique.length === 0) return { data: {}, error: null }
  const { data, error } = await fetchAllRows(() =>
    client.rpc('item_reference_counts', { p_ids: unique }).order('ref_item_id').order('ref_table'))
    .catch(err => ({ data: null, error: err }))
  if (error) return { data: null, error }
  return { data: refCountsFromRows(data), error: null }
}

// S756 (D5): which past records a new PRICE re-values. Stock counts, wastage, staff meals and stock
// movements store a quantity and nothing else, so every report values them at `items.per_uom_rate`
// as it is NOW — closed months included — and a recipe is costed live the same way. Purchase bills,
// returns and PO lines carry their own rate and are untouched, so they are not named (requisition
// lines have captured theirs since S710; older ones still fall back to the live rate).
//
// Moved here from Items.js in S792 so Price Tracker, the third writer of `items.rate`, gives the
// same warning Item Master does.
const REVALUED_BY_PRICE = [
  { codes: ['OS', 'CS'], one: 'stock count', many: 'stock counts' },
  { codes: ['W'], one: 'wastage entry', many: 'wastage entries' },
  { codes: ['SM'], one: 'staff meal', many: 'staff meals' },
  { codes: ['MV'], one: 'stock movement', many: 'stock movements' },
  { codes: ['R'], one: 'recipe line', many: 'recipe lines' },
]

/**
 * `{ text: "3 stock counts, 12 wastage entries and 1 recipe line", total: 16 }`, or null when
 * nothing is re-valued. `counts` is one item's `{ [code]: n }`.
 */
export function priceImpactPhrase(counts) {
  const found = REVALUED_BY_PRICE
    .map(g => ({ g, n: g.codes.reduce((s, c) => s + ((counts || {})[c] || 0), 0) }))
    .filter(x => x.n > 0)
  if (found.length === 0) return null
  const parts = found.map(({ g, n }) => `${n} ${n === 1 ? g.one : g.many}`)
  const text = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return { text, total: found.reduce((s, x) => s + x.n, 0) }
}

/**
 * The D5 sentence a price-change confirm gives about past records, or null when there is nothing
 * to say: the counts were read in full and none of them is re-valued by a price.
 *
 * `complete: false` means the counts could not be read (or not all of them), and then an empty
 * phrase is not "nothing changes": the sentence says what reads the price, without a number.
 */
export function priceImpactSentence(counts, { complete = true } = {}) {
  const impact = priceImpactPhrase(counts)
  if (impact) {
    return `This item's ${impact.text} ${impact.total === 1 ? 'is' : 'are'} valued at this price wherever a report reads them — including months already closed — so those past figures change the moment you save.`
  }
  if (!complete) {
    return "Crest could not count this item's past records, so it cannot say how many figures change — but stock counts, wastage, staff meals and recipe costs all read this price live, including months already closed."
  }
  return null
}

/** What a price change leaves alone, said after the sentence above in both confirms. */
export const PRICE_CHANGE_KEEPS =
  "Purchase bills keep the price typed on them, and a closed month's Monthly Owner Report was frozen when the month closed."
