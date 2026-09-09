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
 * `qtyCol` is a BADGE filter only — "does this item have live usage" — and deliberately does not
 * reach the delete guard, which counts any row at all. `staff_meals.qty` DEFAULTS TO 0, so a
 * zero-quantity staff meal never badged and cascaded away on delete.
 *
 * `itemRefTables.test.js` reads the migrations and fails if this list stops matching the schema —
 * adding a table with an `item_id` FK has to reach here, and nothing else would say so.
 */
export const ITEM_REF_TABLES = [
  { table: 'vendor_returns',       label: 'VR',  name: 'Vendor Returns',    qtyCol: 'qty',          cascades: true  },
  { table: 'recipe_ingredients',   label: 'R',   name: 'Recipes',           qtyCol: null,           cascades: false },
  { table: 'requisition_lines',    label: 'RQ',  name: 'Requisitions',      qtyCol: null,           cascades: true  },
  { table: 'staff_meals',          label: 'SM',  name: 'Staff Meals',       qtyCol: 'qty',          cascades: true  },
  { table: 'wastages',             label: 'W',   name: 'Wastage',           qtyCol: 'qty',          cascades: false },
  { table: 'opening_stock',        label: 'OS',  name: 'Opening Stock',     qtyCol: 'qty',          cascades: false },
  { table: 'closing_stock',        label: 'CS',  name: 'Closing Stock',     qtyCol: 'physical_qty', cascades: false },
  { table: 'par_levels',           label: 'PAR', name: 'Par Levels',        qtyCol: null,           cascades: false },
  { table: 'purchase_order_items', label: 'PO',  name: 'Purchase Orders',   qtyCol: 'qty_ordered',  cascades: false },
  // qty is signed here — a depletion is negative — so a `> 0` filter would hide exactly the POS
  // movements this row exists to report. Any movement row is usage.
  { table: 'stock_movements',      label: 'MV',  name: 'Stock Movements',   qtyCol: null,           cascades: false },
  { table: 'purchase_entries',     label: 'P',   name: 'Purchases',         qtyCol: 'qty',          cascades: false },
]

/** Badge code → the name a reader sees ("SM" → "Staff Meals"). */
export const USAGE_LABELS = Object.fromEntries(ITEM_REF_TABLES.map(t => [t.label, t.name]))

/**
 * What force-delete actually clears, as prose, derived from the list rather than typed out again.
 * The dialog said "purchases, stock counts, wastage, staff meals, requisitions, vendor returns and
 * recipe lines" while the loop beneath it had drifted to a different set.
 */
export const REF_TABLE_PROSE = ITEM_REF_TABLES.map(t => t.name.toLowerCase()).join(', ')
