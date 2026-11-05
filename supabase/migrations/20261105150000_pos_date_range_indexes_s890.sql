-- S890 (2026-11-05): three POS screens read a date range with no index on (outlet, that date).
-- DEBT.md section 4, paid off by owner decision (asked in plain words): add all three now rather
-- than waiting for a busy outlet to notice a slow page.
--
-- Without these, Postgres finds every row the outlet ever had through the client_id index and
-- then checks the date on each, so the read grows with the outlet's whole history however short
-- the chosen range. Sizes at writing (live read): pos_kot_log 7.5k rows, pos_order_items 12k,
-- pos_orders 4.3k, so each build takes milliseconds and the brief write lock is not felt.
--
-- Each index matches the query that needs it (the .eq filters become the partial WHERE, the
-- range column follows client_id):
--
-- 1. KOT Log, KOT Register tab (src/modules/pos/reports/KotLog.jsx):
--      pos_kot_log  client_id = $1  AND sent_at BETWEEN …  ORDER BY sent_at DESC, id
--    idx_pos_kot_log_live covers only live tickets; nearly every stored ticket is served, so
--    the register's all-status read could not use it.
-- 2. Sales Exceptions, item comps (src/modules/pos/reports/PosExceptionReport.jsx):
--      pos_order_items  client_id = $1  AND comped = true  AND comped_at BETWEEN …
--    Partial on comped: comped lines are a tiny share of all lines, so the index stays small
--    and an ordinary (uncomped) line insert does not write it at all.
-- 3. Customers, Credit tab, bills paid whole (src/modules/pos/customers/CreditTab.jsx):
--      pos_orders  client_id = $1  AND payment_method = 'Credit'  AND status = 'billed'
--                  AND credit_settled_at BETWEEN …
--    Partial on the two equality filters, so a cash bill does not write it.
--
-- Reversal: DROP INDEX IF EXISTS public.idx_pos_kot_log_sent;
--           DROP INDEX IF EXISTS public.idx_pos_order_items_comped;
--           DROP INDEX IF EXISTS public.idx_pos_orders_credit_settled;
-- No data, policy, grant or API change, so no schema reload is needed.

CREATE INDEX IF NOT EXISTS idx_pos_kot_log_sent
  ON public.pos_kot_log (client_id, sent_at);

CREATE INDEX IF NOT EXISTS idx_pos_order_items_comped
  ON public.pos_order_items (client_id, comped_at)
  WHERE comped;

CREATE INDEX IF NOT EXISTS idx_pos_orders_credit_settled
  ON public.pos_orders (client_id, credit_settled_at)
  WHERE payment_method = 'Credit' AND status = 'billed';
