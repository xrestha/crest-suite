-- Reprinting the item-level Complimentary Slip from Recent Bills (closing the gap noted when
-- item-level comp shipped in 20260706140000_pos_item_level_comp.sql). The slip needs its own
-- print counter, separate from pos_orders.print_count — that field already tracks the main Tax
-- Invoice/Bill's copy count (ORIGINAL-COPY/SECOND-COPY/...), and on a 'paid' order with some
-- items comped, both documents now coexist on the same order row. Sharing one counter would
-- mislabel whichever document didn't actually get reprinted.

ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS comp_print_count integer DEFAULT 0 NOT NULL;

NOTIFY pgrst, 'reload schema';
