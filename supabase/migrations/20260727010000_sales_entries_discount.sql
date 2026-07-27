-- Sales Entry (Daily Entry tab) imports a vendor "Sales Report Item Wise" Excel export that
-- carries a per-item Discount column alongside Sale/Return/Net qty — previously dropped on
-- import, so Day/Period Revenue (qty x recipe.selling_price) overstated actual revenue whenever
-- a line had a discount applied. Stored separately from unit_price (which keeps snapshotting the
-- recipe's plain selling price, per the existing convention) so it stays editable/auditable
-- rather than silently baked into a price snapshot.
ALTER TABLE sales_entries ADD COLUMN IF NOT EXISTS discount numeric NOT NULL DEFAULT 0;
