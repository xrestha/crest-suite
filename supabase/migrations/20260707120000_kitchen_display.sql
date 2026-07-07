-- Kitchen Display System (KDS) — an on-screen ticket board that runs ALONGSIDE the existing
-- printed KOT/BOT tickets (PosOrders.jsx's Send KOT/BOT flow is unchanged), not a replacement.
--
-- Each pos_kot_log row already represents exactly one physical ticket: one send event. An
-- addition to an already-fired order gets its own row (see logKotSend's delta-aware qty math in
-- PosOrders.jsx) — the same way a second small paper ticket prints for just the new items rather
-- than reprinting the whole order. So the KDS board maps 1:1 onto existing pos_kot_log rows
-- instead of needing a new ticket-aggregation table: no changes needed to logKotSend itself,
-- since these new columns default appropriately and existing INSERTs just pick up the defaults.
ALTER TABLE public.pos_kot_log
  ADD COLUMN status text DEFAULT 'new' NOT NULL,
  ADD COLUMN started_at timestamp with time zone,
  ADD COLUMN ready_at timestamp with time zone,
  ADD COLUMN status_updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD CONSTRAINT pos_kot_log_status_check CHECK (status = ANY (ARRAY['new'::text, 'in_progress'::text, 'ready'::text]));

-- No RLS/policy change needed — pos_kot_log's existing `client_own` policy has no FOR clause
-- (applies to SELECT/INSERT/UPDATE/DELETE alike), so a KDS status UPDATE is already covered by
-- the same same-client-or-admin check every other read/write on this table already goes through.

NOTIFY pgrst, 'reload schema';
