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
