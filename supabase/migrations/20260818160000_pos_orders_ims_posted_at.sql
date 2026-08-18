-- S573 — a closed POS bill could silently never reach Inventory, and nothing anywhere said so.
--
-- writeSalesEntries() returns early, with no message and no flag, when there is no open
-- monthly_periods row or when today's BS month isn't the open one:
--
--   const open = (periods || []).find(p => p.status === 'open')
--   if (!open) return
--   if (today.year !== open.bs_year || today.month !== open.bs_month) return
--
-- The bill still closes, prints and consumes an invoice number. So POS Sales Report shows the
-- revenue while IMS MonthlySummary, Variance and stock_movements never see it — the two sides of
-- the product disagree by an unbounded amount, and neither page says anything is missing. Stock
-- depletion is lost the same way: the food left the kitchen and the ingredients were never
-- deducted.
--
-- Product decision (2026-08-18): the bill must still close — blocking a sale mid-service is not
-- acceptable — but it is stamped so the gap is visible and can be backfilled once a period exists.
--
-- NULL means "not posted to Inventory". Deliberately nullable with no default and no backfill of
-- existing rows: a bill closed before this migration genuinely has an unknown posting state, and
-- guessing either way would be worse than admitting it. The partial index covers exactly the
-- query the floor banner runs (today's unposted paid bills), so it stays cheap as the table grows.
ALTER TABLE public.pos_orders
  ADD COLUMN IF NOT EXISTS ims_posted_at timestamptz;

COMMENT ON COLUMN public.pos_orders.ims_posted_at IS
  'When this bill''s revenue and stock depletion were posted into IMS (sales_entries + stock_movements). NULL = not posted, which happens when no matching BS period was open at close; such bills are surfaced on the POS floor and can be backfilled from Periods. NULL on rows closed before S573 means "unknown", not "unposted".';

CREATE INDEX IF NOT EXISTS idx_pos_orders_unposted
  ON public.pos_orders (client_id, closed_at)
  WHERE ims_posted_at IS NULL AND status = 'billed';

NOTIFY pgrst, 'reload schema';
