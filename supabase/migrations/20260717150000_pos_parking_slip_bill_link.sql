-- Parking Slip: optionally link a slip to the bill already issued to that customer (e.g. to
-- verify a "free parking with a minimum purchase" policy, or just a staff cross-reference) — the
-- slip itself stays standalone/order-optional as originally designed
-- (20260717120000_parking_slips_gate_passes.sql: "so a walk-in who hasn't ordered yet can still
-- get one"), so both new columns are nullable, never required.
--
-- Same order_id+snapshot shape as that migration's ims_gate_passes.vendor_id/vendor_name: order_id
-- is a real FK so the parking log can drill through to the actual bill via the existing
-- viewPosBill.js utility (same one Sales Exceptions/Bill Register already use), bill_invoice_no
-- snapshots the bill's invoice_no at issue time so the slip list/print never need a join —
-- pos_orders rows are never hard-deleted once billed, so this can't drift; it's purely a display
-- convenience, same reasoning as every other snapshot column in this codebase.
ALTER TABLE public.pos_parking_slips
  ADD COLUMN order_id uuid REFERENCES public.pos_orders(id) ON DELETE SET NULL,
  ADD COLUMN bill_invoice_no integer;
