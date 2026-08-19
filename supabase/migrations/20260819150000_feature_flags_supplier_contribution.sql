-- New "Supplier Contribution" report (/supplier-contribution, Pro): attributes the ingredient
-- cost behind a period's sales to the vendors that actually supplied those ingredients, split in
-- proportion to what was bought from each. Derived entirely from tables that already exist
-- (sales_entries, purchase_entries, vendor_returns, items, recipe_ingredients) — no new table,
-- and therefore nothing to add to the Danger Zone or the export/restore order.
--
-- feature_flags is a wide table (one boolean column per feature key), so a new key needs its own
-- column here BEFORE FeatureAccessModal.js can toggle it: that modal upserts the whole flags
-- object in one request, so a key with no matching column rejects EVERY feature-flag save for
-- EVERY client, with an error naming a feature the admin was not touching (S547).

ALTER TABLE public.feature_flags
  ADD COLUMN IF NOT EXISTS supplier_contribution boolean DEFAULT false;

NOTIFY pgrst, 'reload schema';
