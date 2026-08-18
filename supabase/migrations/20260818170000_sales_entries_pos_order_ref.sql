-- S573 — sales_entries has no link back to the POS order that created it, and that turned a
-- one-line cleanup into a five-query forensic exercise.
--
-- stock_movements already carries ref_id (the pos_orders id). sales_entries does not, so:
--
--   * "has this bill's revenue already posted?" is unanswerable directly. The POS backfill had to
--     infer it from stock_movements instead — and that inference is WRONG, proven on real data:
--     writeSalesEntries writes sales_entries first and then stock_movements inside a try/catch
--     that swallows failures, so revenue can land while depletion does not. Three July bills had
--     revenue posted and only one had a movement; a guard keyed on movements re-posted the other
--     two, duplicating their revenue.
--   * a double-post cannot be undone cleanly. sales_entries holds one row per bill per recipe, so
--     three bills selling the same dish on the same day at the same price are indistinguishable
--     from one bill posted three times. Reversing it needed created_at archaeology.
--
-- pos_order_id closes both holes: the backfill can ask exactly which bills already have revenue,
-- and a bad post can be deleted by order rather than by guesswork.
--
-- Nullable on purpose. Only POS-sourced rows ever carry it; manual Sales Entry rows (the large
-- majority) have no order and must stay NULL. ON DELETE SET NULL rather than CASCADE: deleting a
-- POS order must never silently delete the revenue that was recognised from it — that would be a
-- far worse failure than an orphaned reference.
ALTER TABLE public.sales_entries
  ADD COLUMN IF NOT EXISTS pos_order_id uuid REFERENCES public.pos_orders(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.sales_entries.pos_order_id IS
  'The POS bill this revenue row came from, for source pos/pos_comp/pos_credit. NULL for manually entered sales. Mirrors stock_movements.ref_id so "has this bill already posted revenue?" is an exact question rather than an inference.';

-- Partial: the only queries that use this column filter to POS-sourced rows, and on a client with
-- years of manual Sales Entry rows those are a small minority of the table.
CREATE INDEX IF NOT EXISTS idx_sales_entries_pos_order
  ON public.sales_entries (pos_order_id)
  WHERE pos_order_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
