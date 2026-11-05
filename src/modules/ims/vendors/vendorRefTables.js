// Every table that points at a vendor. A vendor with any of these attached must not be hard-deleted,
// and the two reasons are different: purchase_entries and purchase_orders hold a plain FK, so
// Postgres refuses and the vendor survives — but vendor_returns and ims_gate_passes are ON DELETE
// SET NULL, so the delete SUCCEEDS and those rows quietly lose their supplier. vendor_returns keeps
// no name of its own, so that loss is unrecoverable and nothing on screen would say it happened.
// payable_payments hangs off purchase_entries rather than the vendor, so it is covered by that row.
// `label` is what the row's usage chip shows (words since S796, not the old P / VR codes). It is
// spelled as Item Master's Used In column names the same tables (`name` in items/itemRefTables.js),
// deliberately — one vocabulary across the two pages that use the chip. `onDelete` is what the
// foreign key does when its vendor row goes, read from the migrations by the test.
//
// The list exists twice: here, and in the SQL `vendor_reference_counts()` that the
// `vendors_guard_referenced_delete` trigger asks (migration 20260909140000). Its own file since S890
// so `vendorRefTables.test.js` can hold the two, and the migrations' foreign keys, together.
export const VENDOR_REF_TABLES = [
  { table: 'purchase_entries', label: 'Purchases', one: 'purchase entry', many: 'purchase entries', onDelete: 'refuse' },
  { table: 'purchase_orders', label: 'Purchase Orders', one: 'purchase order', many: 'purchase orders', onDelete: 'refuse' },
  { table: 'vendor_returns', label: 'Vendor Returns', one: 'vendor return', many: 'vendor returns', onDelete: 'set null' },
  { table: 'ims_gate_passes', label: 'Gate Passes', one: 'gate pass', many: 'gate passes', onDelete: 'set null' },
]
