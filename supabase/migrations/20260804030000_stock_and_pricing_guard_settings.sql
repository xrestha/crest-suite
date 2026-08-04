-- Client-level business-rule toggles (Settings > Thresholds).
-- block_negative_stock: off by default, preserves current Stock Count behavior (red-highlighted
-- negative usage, but save still allowed) until a client opts in to a hard block.
-- warn_below_cost_pricing: on by default — it's a non-blocking inline warning in Recipes, not a
-- restriction, so defaulting it on is safe for every existing client.
ALTER TABLE public.settings ADD COLUMN block_negative_stock boolean DEFAULT false;
ALTER TABLE public.settings ADD COLUMN warn_below_cost_pricing boolean DEFAULT true;
