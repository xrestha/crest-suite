-- S710 (2 of 2) — a store issue slip stops re-pricing itself, and a quantity stops going backwards.
--
-- THE RATE. `requisition_lines` stores quantities and nothing else, so every NPR figure the page
-- shows — the line value, the slip total, the list column, the Excel export, the printed slip --
-- is `qty x items.per_uom_rate` read live at render time. `per_uom_rate` is generated from
-- `items.rate`, and PurchaseBillPage.jsx rewrites `items.rate` on every bill that includes the
-- item. So a requisition issued in Shrawan and signed by whoever received it reprints in Bhadra
-- with a different total, and nothing on the slip says why. It is the same class of fault the
-- Monthly Owner Report was built to avoid: a document that was true when it was made must not be
-- recomputed from figures that have since moved.
--
-- `rate` is therefore captured at the moment the line is written, exactly as `purchase_entries`
-- captures its own. It is NULLABLE on purpose: rows written before today have no snapshot and
-- inventing one from today's `items.rate` would be fabricating a history, not recovering it. The
-- page falls back to `items.per_uom_rate` when it is NULL, which is what those rows already did.
--
-- THE QUANTITIES. `min="0"` on a number input is a hint, not a constraint — nothing checks it on
-- paste, and the over-issue guard compares `issuing <= available`, which a negative passes
-- trivially. A negative `qty_issued` flows into Stock Count's Requisitioned column and subtracts
-- from a cross-check figure a month is closed against.
--
-- Both CHECKs are added NOT VALID: they enforce on every INSERT and UPDATE from here on, without
-- a scan that would fail the whole migration on a legacy row nobody has looked at yet. Run
-- `ALTER TABLE ... VALIDATE CONSTRAINT ...` once the book is known to be clean.

BEGIN;

ALTER TABLE public.requisition_lines
  ADD COLUMN IF NOT EXISTS rate numeric;

COMMENT ON COLUMN public.requisition_lines.rate IS
  'Per-base-unit cost captured when the line was written, so a slip does not re-price itself when '
  'items.rate moves. NULL on rows written before S710; readers fall back to items.per_uom_rate.';

ALTER TABLE public.requisition_lines
  DROP CONSTRAINT IF EXISTS requisition_lines_qty_requested_nonneg;
ALTER TABLE public.requisition_lines
  ADD CONSTRAINT requisition_lines_qty_requested_nonneg CHECK (qty_requested >= 0) NOT VALID;

ALTER TABLE public.requisition_lines
  DROP CONSTRAINT IF EXISTS requisition_lines_qty_issued_nonneg;
ALTER TABLE public.requisition_lines
  ADD CONSTRAINT requisition_lines_qty_issued_nonneg CHECK (qty_issued IS NULL OR qty_issued >= 0) NOT VALID;

ALTER TABLE public.requisition_lines
  DROP CONSTRAINT IF EXISTS requisition_lines_rate_nonneg;
ALTER TABLE public.requisition_lines
  ADD CONSTRAINT requisition_lines_rate_nonneg CHECK (rate IS NULL OR rate >= 0) NOT VALID;

COMMIT;
