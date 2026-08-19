-- Stock Ageing (/stock-ageing): how long the stock still on hand has been sitting, bucketed
-- 0-30 / 31-60 / 61-90 / 90+ days across a BS fiscal year, valued at what was actually paid for
-- each surviving batch. The last 🔴 report on the competitor-parity list (POS_TODO.md).
--
-- Tiered PRO alongside its closest sibling fifo_report, which shares the same batch-allocation
-- machinery. It could not sit lower in any case: knowing what is still on hand requires netting
-- consumption off the batches, and that consumption comes from recipe explosion — recipe_costing
-- is Growth, so a Starter client could never get a number out of this page (the S551 rule that
-- retiered reorder_report and stock_movement_log for exactly this reason).
--
-- Upward-available move only — no client loses access to anything that exists today, so no
-- grandfather sweep is needed.
--
-- The column must exist before FeatureAccessModal can save: the modal upserts the whole flags
-- object in one request, so a key with no matching column rejects EVERY feature-flag save for
-- EVERY client (S547). src/pages/adminClients/featureFlagsSchema.test.js now fails the build if
-- this pair ever drifts again.

ALTER TABLE public.feature_flags
  ADD COLUMN IF NOT EXISTS stock_ageing boolean DEFAULT false;

NOTIFY pgrst, 'reload schema';
