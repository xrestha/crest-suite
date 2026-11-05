-- S885: the new "Dish Cost History" report (/dish-cost-history, Pro): every dish's cost per BS month,
-- worked out from each month's purchase prices on today's recipe. Derived entirely from tables that
-- already exist (purchase_entries, items, recipes, recipe_ingredients), so there is no new table and
-- nothing to add to the Danger Zone or the export/restore order.
--
-- feature_flags is a wide table (one boolean column per feature key), so a new key needs its own
-- column here BEFORE FeatureAccessModal.js can toggle it: that modal upserts the whole flags object in
-- one request, so a key with no matching column rejects EVERY feature-flag save for EVERY client (S547).
--
-- Reverse: ALTER TABLE public.feature_flags DROP COLUMN IF EXISTS dish_cost_history;

ALTER TABLE public.feature_flags
  ADD COLUMN IF NOT EXISTS dish_cost_history boolean DEFAULT false;

NOTIFY pgrst, 'reload schema';
